// 面板**产物**的终验：断言「命令表在高级区」「桥接页没有逐块 CLI 等价」
// 「常用区与 reopen 动作在产物里」。
//
// 为什么测**产物**而不是源码：
// 面板的视图是懒加载的（view-*.js），源码里改了不等于进了产物；
// 而发到用户手上的就是产物。这里读 dist/web/public —— 跑 build 之后才有。
//
// 跳过的条件：没构建过（dist/web/public 不存在）就跳过，不是失败。
// 这与仓库里其它依赖外部条件的测试同一口径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..', '..', 'dist', 'web', 'public', 'assets');

const built = fs.existsSync(ASSETS);
const skip = built ? false : '面板产物不存在（先跑 pnpm build）';

function readAssets() {
  const files = fs.readdirSync(ASSETS);
  let js = '';
  let css = '';
  let bridge = '';
  for (const f of files) {
    const body = fs.readFileSync(path.join(ASSETS, f), 'utf8');
    if (f.endsWith('.js')) {
      js += body;
      // 桥接视图的 chunk：含它独有的标题
      if (/开放一个端口|远端目录/.test(body)) bridge += body;
    }
    if (f.endsWith('.css')) css += body;
  }
  return { js, css, bridge };
}

describe('面板产物', () => {
  it('命令表在折叠的「高级」区里', () => {
    if (skip) return;
    const { js, css } = readAssets();
    assert.match(js, /高级/, '高级入口应在');
    assert.match(js, /details/, '折叠语义（details）应在');
    assert.match(js, /summary/, '折叠摘要（summary）应在');
    assert.match(css, /\.cli-hint-summary/, '折叠摘要样式应在');
    assert.match(css, /\.cli-hint-body/, '折叠内容样式应在');
    // vite 会把 ::before 压成 :before —— 两种写法都认
    assert.match(css, /cli-hint-summary::?before/, '折叠箭头样式应在');
  });

  it('桥接视图不再有逐块的「CLI 等价」', () => {
    if (skip) return;
    const { bridge } = readAssets();
    assert.ok(bridge.length > 0, '应当找到桥接视图的 chunk');
    assert.doesNotMatch(bridge, /CLI 等价/, '桥接视图里不该再有逐块标注');
    assert.match(bridge, /开放一个端口/, '「开放一个端口」区块应在');
    assert.match(bridge, /常用/, '常用区应在');
  });

  it('常用应用与一键重开进了产物', () => {
    if (skip) return;
    const { js } = readAssets();
    assert.match(js, /favorites/, 'favorites 字段应在');
    assert.match(js, /reopen/, 'reopen 动作应在');
  });
});
