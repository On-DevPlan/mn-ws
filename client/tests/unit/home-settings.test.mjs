// 设置能力测试（设置逻辑现在归属 home 模块）：重点在**服务层校验**——
// 它把纯模型接到真实页面清单与 store 上，写坏了头部就少一块或摆错位，
// 所以坏形状 / 不存在的页面 / 缺组名 / 空组 / 坏 id 都必须明确报错，而不是被静默丢掉。
//
// 出厂只有一个真实页面（home），所以多视图排序、跨组重复这类纯逻辑放在
// nav-model.test.mjs（用任意 id 测纯模型）；这里只验证服务层「按真实 id 校验」的接线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withStore() {
  const dir = mkdtempSync(join(tmpdir(), 'mn-ws-settings-'));
  process.env.MN_WS_STORE = join(dir, 'store.json');
}

async function loadModules() {
  const home = await import('../../src/modules/home/service.ts');
  const store = await import('../../src/core/store.ts');
  return { home, store };
}

test('默认设置：navGroups / navHidden 都是空数组（老 store 读一次自动补）', async () => {
  withStore();
  const { home, store } = await loadModules();
  const s = await store.loadStore();
  assert.deepEqual(s.settings.navGroups, []);
  assert.deepEqual(s.settings.navHidden, []);
  const got = await home.getSettings();
  assert.ok(got.views.some((v) => v.id === 'home'), 'getSettings 要带上页面清单（头部据此渲染）');
});

test('navGroups：含 home 的分组原样落盘，不被 order / 字典序重排', async () => {
  withStore();
  const { home, store } = await loadModules();
  await home.setSettings({ set: { navGroups: [{ title: '系统', views: ['home'] }] } });
  assert.deepEqual((await store.loadStore()).settings.navGroups, [{ title: '系统', views: ['home'] }]);
});

test('navGroups：PATCH 只改传入项（改主题不影响已存分组）', async () => {
  withStore();
  const { home, store } = await loadModules();
  await home.setSettings({ set: { navGroups: [{ title: '系统', views: ['home'] }] } });
  await home.setSettings({ set: { theme: 'dark' } });
  const s = await store.loadStore();
  assert.deepEqual(s.settings.navGroups, [{ title: '系统', views: ['home'] }]);
  assert.equal(s.settings.theme, 'dark');
});

test('navGroups 校验：坏形状 / 缺组名 / 页面不存在 / 空组 —— 都拒绝且不落盘', async () => {
  withStore();
  const { home, store } = await loadModules();
  const before = JSON.stringify((await store.loadStore()).settings);

  const cases = [
    [{ title: 'x' }, /数组/],
    [[{ views: ['home'] }], /缺少 title/],
    [[{ title: 'A', views: ['settings'] }], /不存在: settings/],
    [[{ title: 'A', views: ['nope'] }], /不存在: nope/],
    [[{ title: '空组', views: [] }], /没有任何页面/],
  ];
  for (const [navGroups, re] of cases) {
    await assert.rejects(
      home.setSettings({ set: { navGroups } }),
      (e) => e.code === 'INVALID_INPUT' && re.test(e.message),
      `应拒绝: ${JSON.stringify(navGroups)}`,
    );
  }
  assert.equal(JSON.stringify((await store.loadStore()).settings), before, '校验失败不得落盘');
});

test('navHidden：页面不存在要报错；home 可隐藏（数组 / 逗号串 / JSON 串都认）', async () => {
  withStore();
  const { home, store } = await loadModules();
  await assert.rejects(
    home.setSettings({ set: { navHidden: 'settings' } }),
    (e) => e.code === 'INVALID_INPUT' && /不存在/.test(e.message),
  );
  await home.setSettings({ set: { navHidden: 'home' } });
  assert.deepEqual((await store.loadStore()).settings.navHidden, ['home']);
});

test('theme：只认 light / dark / auto，坏值拒绝', async () => {
  withStore();
  const { home, store } = await loadModules();
  await home.setSettings({ set: { theme: 'dark' } });
  assert.equal((await store.loadStore()).settings.theme, 'dark');
  await assert.rejects(
    home.setSettings({ set: { theme: 'blue' } }),
    (e) => e.code === 'INVALID_INPUT' && /light \/ dark \/ auto/.test(e.message),
  );
});

test('未知设置项 / 空 patch 都明确报错', async () => {
  withStore();
  const { home } = await loadModules();
  await assert.rejects(home.setSettings({ set: { 不存在的项: 1 } }), /未知设置项/);
  await assert.rejects(home.setSettings({}), /至少要给一项/);
});

test('--dry-run 只演练不落盘', async () => {
  withStore();
  const { home, store } = await loadModules();
  const r = await home.setSettings({ set: { navGroups: [{ title: '系统', views: ['home'] }] }, 'dry-run': true });
  assert.equal(r.status, 'skipped');
  assert.deepEqual((await store.loadStore()).settings.navGroups, []);
});

test('navOrder：home 可排序；坏 id / 坏 JSON 都拒绝', async () => {
  withStore();
  const { home, store } = await loadModules();

  const a = await home.setSettings({ set: { navOrder: 'home' } });
  assert.deepEqual(a.settings.navOrder, ['home']);

  await assert.rejects(
    home.setSettings({ set: { navOrder: 'settings' } }),
    (e) => e.code === 'INVALID_INPUT' && /不存在/.test(e.message),
  );
  await assert.rejects(
    home.setSettings({ set: { navOrder: '[bad json' } }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.deepEqual((await store.loadStore()).settings.navOrder, ['home'], '校验失败不得落盘');
});

test('getSettings：带上页面清单（头部与本页都按它渲染）', async () => {
  withStore();
  const { home } = await loadModules();
  const d = await home.getSettings();
  assert.ok(d.views.some((v) => v.id === 'home'));
  assert.ok(!d.views.some((v) => v.id === 'settings'), '出厂不再有独立的 settings 页');
  assert.match(home.renderSettings(d), /页面（\d+）/);
});
