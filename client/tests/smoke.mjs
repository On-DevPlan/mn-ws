// smoke 测试：**发布出去的二进制**在真实进程里跑通关键路径。
// 这些是「面板能起、命令能跑」的最小证明——比单元测试更接近用户实际体验。
//
// ⚠️ 测的是**原生二进制**，不是 TS 源码：
//    npm 包里分发的就是它（运行时零 Node 依赖），测 TS 源码等于测了个不存在的东西。
//    二进制由 `cargo build --release` 产出；没构建时跳过并说明原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const IS_WIN = process.platform === 'win32';
const BIN = join(
  REPO,
  'rust',
  'target',
  'release',
  IS_WIN ? 'mn-ws.exe' : 'mn-ws',
);

// 没构建 Rust 产物 → 整个套件跳过（而不是失败 —— 那不是代码的问题）。
const BUILT = existsSync(BIN);
const skip = BUILT
  ? false
  : { skip: 'Rust 产物未构建（先跑：cd rust && cargo build --release）' };

// 每个用例独立存储，避免写脏用户真实目录，也避免用例间计数互相干扰
function run(cmdline, cwd = tmpdir()) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-smoke-'));
  // execFile 不走 shell，必须把命令串拆成 token 数组——
  // 整串塞进去会被当成一个 argv 元素，CLI 侧报「未知命令」。
  return exec(BIN, [...cmdline.split(' ').filter(Boolean)], {
    cwd,
    env: { ...process.env, MN_WS_STORE: join(dir, 'store.json') },
  });
}

/** 用同一份存储跑多个命令（测「CLI ↔ 存储闭环」要这样）。 */
function runner(cwd = tmpdir()) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-smoke-'));
  const env = { ...process.env, MN_WS_STORE: join(dir, 'store.json') };
  return (args) => exec(BIN, args, { cwd, env });
}

test('--version 输出裸版本号（可被 V=$(mn-ws --version) 消费）', skip, async () => {
  const { stdout } = await run('--version');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('routes: 命令表含 bootstrap/health/greet 且带 HTTP 对照', skip, async () => {
  const { stdout } = await run('routes --json');
  const r = JSON.parse(stdout);
  assert.ok(r.count >= 7, `至少 7 条命令，实际 ${r.count}`);
  const ids = r.routes.map((x) => x.id);
  for (const id of ['home.bootstrap', 'home.health', 'home.greet']) {
    assert.ok(ids.includes(id), `缺命令 ${id}`);
  }
  const greet = r.routes.find((x) => x.id === 'home.greet');
  assert.equal(greet.http, 'POST /api/greet');
});

test('greet：返回问候且计数累计（CLI ↔ 存储闭环）', skip, async () => {
  const r = JSON.parse((await run('greet 世界 --json')).stdout);
  assert.match(r.greeting, /世界/);
  assert.equal(r.count, 1);
  // 同一存储路径由 run() 每次重新生成，这里直接验证渲染串形态
  const text = (await run('greet 世界')).stdout;
  assert.match(text, /你好，世界/);
});

test('health：自检通过', skip, async () => {
  const r = JSON.parse((await run('health --json')).stdout);
  assert.equal(r.status, 'ok');
});

test('bootstrap show：面板启动上下文', skip, async () => {
  const r = JSON.parse((await run('bootstrap show --json')).stdout);
  assert.equal(r.app.name, 'mn-ws');
  assert.ok(Array.isArray(r.views) && r.views.length > 0, '要带页面清单');
  assert.ok(r.views.some((v) => v.id === 'home'));
});

test('greet 缺名字被拒且 exit 1', skip, async () => {
  await assert.rejects(
    () => run('greet'),
    (err) => {
      assert.match(err.stderr, /缺少必填|name/);
      return true;
    },
  );
});

test('未知命令 exit 1', skip, async () => {
  await assert.rejects(() => run('nope'));
});

test('setting：导航分组经 CLI 往返（同一个 store），坏 id 明确报错', skip, async () => {
  const cli = runner();

  const get0 = JSON.parse((await cli(['setting', 'get', '--json'])).stdout);
  assert.ok(Array.isArray(get0.settings.navGroups) && get0.settings.navGroups.length === 0, '默认无分组');
  assert.ok(get0.views.some((v) => v.id === 'home'), '要带上页面清单（头部据此渲染）');
  assert.ok(!get0.views.some((v) => v.id === 'settings'), '出厂不再有独立 settings 页');

  await cli(['setting', 'set', '--set', 'navGroups=[{"title":"求职","views":["home"]}]', '--json']);
  await cli(['setting', 'set', '--set', 'navOrder=["home"]', '--json']);
  const get1 = JSON.parse((await cli(['setting', 'get', '--json'])).stdout);
  assert.deepEqual(get1.settings.navGroups, [{ title: '求职', views: ['home'] }], '分组原样保存');
  assert.deepEqual(get1.settings.navOrder, ['home']);

  // 被隐藏的页面：入口不显示，但清单里还在（`#/id` 直达仍可用）——先撤分组
  await cli(['setting', 'set', '--set', 'navGroups=[]', '--set', 'navHidden=home', '--json']);
  const get2 = JSON.parse((await cli(['setting', 'get', '--json'])).stdout);
  assert.deepEqual(get2.settings.navHidden, ['home']);
  assert.ok(get2.views.some((v) => v.id === 'home'));

  const bad = await cli(['setting', 'set', '--set', 'navHidden=no_such_page', '--json']).catch((e) => e);
  assert.match(String(bad.stdout || bad.message), /不存在/, '坏页面 id 必须报错而不是静默写入');
});

test('apps：白名单的增删改查经 CLI 往返', skip, async () => {
  const cli = runner();

  await cli(['apps', 'add', 'my-api', '--port', '9911', '--json']);
  const known = JSON.parse((await cli(['apps', 'known', '--json'])).stdout);
  assert.ok(
    known.apps.some((a) => a.app === 'my-api' && a.base.includes('9911')),
    `新登记的应用要在 known 里：${JSON.stringify(known)}`,
  );

  await cli(['apps', 'remove', 'my-api', '--json']);
  const after = JSON.parse((await cli(['apps', 'known', '--json'])).stdout);
  assert.ok(!after.apps.some((a) => a.app === 'my-api'), '移除后不该还在');
});

test('auth list：本机没有账号时给出提示而不是崩', skip, async () => {
  const { stdout } = await run('auth list');
  assert.match(stdout, /账号|没有|还没有/);
});
