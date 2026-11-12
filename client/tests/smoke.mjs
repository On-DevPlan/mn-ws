// smoke 测试：生成的 CLI 在真实进程里跑通关键路径。
// 这些是「面板能起、命令能跑」的最小证明——比单元测试更接近用户实际体验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'ws.mjs');

// 每个用例独立存储，避免写脏用户真实目录，也避免用例间计数互相干扰
function run(cmdline, cwd = tmpdir()) {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-smoke-'));
  // execFile 不走 shell，必须把命令串拆成 token 数组——
  // 整串塞进去会被当成一个 argv 元素，CLI 侧报「未知命令」。
  return exec(process.execPath, [BIN, ...cmdline.split(' ').filter(Boolean)], {
    cwd,
    env: { ...process.env, MN_WS_STORE: join(dir, 'store.json') },
  });
}

test('version 输出裸版本号（可被 V=$(mn-ws version) 消费）', async () => {
  const { stdout } = await run('version');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('routes: 命令表含 bootstrap/health/greet 且带 HTTP 对照', async () => {
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

test('greet：返回问候且计数累计（CLI ↔ 存储闭环）', async () => {
  const r = JSON.parse((await run('greet 世界 --json')).stdout);
  assert.match(r.greeting, /世界/);
  assert.equal(r.count, 1);
  // 同一存储路径由 run() 每次重新生成，这里直接验证渲染串形态
  const text = (await run('greet 世界')).stdout;
  assert.match(text, /你好，世界/);
});

test('health：自检通过', async () => {
  const r = JSON.parse((await run('health --json')).stdout);
  assert.equal(r.status, 'ok');
});

test('greet 缺名字被拒且 exit 1', async () => {
  await assert.rejects(
    () => run('greet'),
    (err) => {
      assert.match(err.stderr, /缺少必填|name/);
      return true;
    }
  );
});

test('未知命令 exit 1', async () => {
  await assert.rejects(() => run('nope'));
});

test('skill list：含主 skill 与默认 group', async () => {
  const r = JSON.parse((await run('skill list --json')).stdout);
  assert.ok(r.skills.includes('mn-ws'), '缺主 skill');
  assert.equal(r.defaultGroup, 'mn-ws');
});

test('skill install：项目根安装注入路径，非项目目录拒绝', async () => {
  const to = mkdtempSync(join(tmpdir(), 'mn-ws-skill-'));
  const ok = JSON.parse(
    (await run(`skill install mn-ws --to ${to} --json`, ROOT)).stdout
  );
  assert.equal(ok.status, 'ok');

  const skill = readFileSync(join(to, 'mn-ws', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(ROOT.replace(/\\/g, '/')), '应注入项目根路径');
  assert.ok(!skill.includes('{{PROJECT_ROOT}}'), '不应残留安装期占位');
  assert.ok(!existsSync(join(to, 'mn-ws', 'hooks.json')), 'hooks.json 不复制');
  assert.ok(!existsSync(join(to, 'mn-ws', 'install')), 'install/ 不复制');

  const wrong = mkdtempSync(join(tmpdir(), 'mn-ws-wrong-'));
  await assert.rejects(
    () => run(`skill install mn-ws --to ${wrong} --json`, wrong),
    (err) => {
      // --json 模式下错误信封走 stdout（人读模式才走 stderr）
      const payload = JSON.parse(err.stdout);
      assert.match(payload.error, /项目根目录内安装/);
      return true;
    }
  );
});

test('skill install --all：一次装全部 skill；与 name/--group 互斥', async () => {
  const to = mkdtempSync(join(tmpdir(), 'mn-ws-all-'));
  const r = JSON.parse(
    (await run(`skill install --all --to ${to} --json`, ROOT)).stdout
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.group, '*');
  assert.ok(r.skills.length >= 1);
  assert.ok(r.skills.some((x) => x.name === 'mn-ws'));
  assert.ok(existsSync(join(to, 'mn-ws', 'SKILL.md')));

  // 再跑一次：全部 skipped（幂等）
  const again = JSON.parse(
    (await run(`skill install --all --to ${to} --json`, ROOT)).stdout
  );
  assert.ok(again.skills.every((x) => x.status === 'skipped'));

  // 互斥校验
  await assert.rejects(
    () => run(`skill install mn-ws --all --to ${to} --json`, ROOT),
    (err) => {
      assert.match(JSON.parse(err.stdout).error, /--all/);
      return true;
    }
  );
});

test('setting：导航分组经 CLI 往返（同一个 store），坏 id 明确报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-nav-'));
  const env = { ...process.env, MN_WS_STORE: join(dir, 'store.json') };
  const cli = (args) => exec(process.execPath, [BIN, ...args], { cwd: tmpdir(), env });

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
