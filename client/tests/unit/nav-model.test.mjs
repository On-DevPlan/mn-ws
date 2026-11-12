// 头部导航配置的纯模型单测：增删改、容器移动、插入位换算、平铺顺序、校验。
// 这一层是「管理逻辑」的唯一实现处（表现层只画），所以它必须自己就被钉死。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const m = await import('../../src/web/frontend/components/navModel.ts');

const ALL = ['home', 'settings', 'reports', 'logs'];

test('configFromSettings / configToPayload：深拷贝往返，不共享引用', () => {
  const settings = { navGroups: [{ title: '系统', views: ['settings'] }], navHidden: ['logs'], navOrder: ['home'] };
  const cfg = m.configFromSettings(settings);
  assert.deepEqual(cfg, { groups: [{ title: '系统', views: ['settings'] }], hidden: ['logs'], order: ['home'] });

  // 改副本不影响原数据（设置页「放弃改动」的前提）
  cfg.groups[0].views.push('home');
  assert.deepEqual(settings.navGroups[0].views, ['settings']);

  assert.deepEqual(m.configToPayload(cfg), {
    navGroups: [{ title: '系统', views: ['settings', 'home'] }],
    navHidden: ['logs'],
    navOrder: ['home'],
  });
});

test('configFromSettings：后端缺字段时给出空配置（老 store 直接可用）', () => {
  assert.deepEqual(m.configFromSettings(undefined), { groups: [], hidden: [], order: [] });
  assert.deepEqual(m.configFromSettings({}), { groups: [], hidden: [], order: [] });
});

test('isDirty：形状等价即视为未改动', () => {
  const a = m.configFromSettings({ navGroups: [{ title: 'A', views: ['home'] }] });
  const b = structuredClone(a);
  assert.equal(m.isDirty(a, b), false);
  b.hidden.push('home');
  assert.equal(m.isDirty(a, b), true);
});

test('分组：新增 / 改名 / 删除 / 上下移动（越界不动）', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addGroup(cfg, 'B');
  assert.deepEqual(cfg.groups.map((g) => g.title), ['A', 'B']);
  cfg = m.renameGroup(cfg, 0, 'A2');
  cfg = m.moveGroup(cfg, 0, 1);
  assert.deepEqual(cfg.groups.map((g) => g.title), ['B', 'A2']);
  assert.deepEqual(m.moveGroup(cfg, 0, -1).groups.map((g) => g.title), ['B', 'A2'], '越界保持原样');
  cfg = m.removeGroup(cfg, 0);
  assert.deepEqual(cfg.groups.map((g) => g.title), ['A2']);
});

test('组成员：加入 / 一个页面只能属于一个分组 / 移除', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addGroup(cfg, 'B');
  cfg = m.addView(cfg, 0, 'home');
  cfg = m.addView(cfg, 0, 'reports');
  assert.deepEqual(cfg.groups[0].views, ['home', 'reports']);
  assert.equal(m.addView(cfg, 1, 'home'), cfg, '跨组加入应原样返回');
  assert.deepEqual(m.availableFor(cfg, 1, ALL), ['settings', 'logs']);
  cfg = m.removeView(cfg, 0, 'home');
  assert.deepEqual(cfg.groups[0].views, ['reports']);
});

test('容器模型：containerOf 判定「平铺 / 分组 / 隐藏」，三者互斥且都带位置', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  cfg = m.addView(cfg, 0, 'reports');
  assert.deepEqual(m.containerOf(cfg, 'reports', ALL), { kind: 'group', gi: 0, index: 0 });
  assert.deepEqual(m.containerOf(cfg, 'home', ALL), { kind: 'pool', index: 0 });

  cfg = m.moveToContainer(cfg, 'reports', { kind: 'hidden' }, null, ALL);
  assert.deepEqual(m.containerOf(cfg, 'reports', ALL), { kind: 'hidden', index: 0 });
  assert.deepEqual(cfg.groups[0].views, [], '进隐藏容器时要先从分组里摘掉');

  cfg = m.toPool(cfg, 'reports');
  assert.deepEqual(m.containerOf(cfg, 'reports', ALL).kind, 'pool');
  assert.deepEqual(cfg.hidden, []);
});

test('insertionIndex：同容器内往下拖要减 1，跨容器与末尾不减（预览与实际落点对齐）', () => {
  let cfg = m.addGroup(m.emptyConfig(), 'A');
  for (const vid of ['home', 'reports', 'logs']) cfg = m.addView(cfg, 0, vid);

  assert.equal(m.insertionIndex(cfg, 'home', { kind: 'group', gi: 0 }, 1, ALL), 0);
  assert.equal(m.insertionIndex(cfg, 'home', { kind: 'group', gi: 0 }, 2, ALL), 1);
  assert.equal(m.insertionIndex(cfg, 'logs', { kind: 'group', gi: 0 }, 0, ALL), 0, '往上拖不减');
  assert.equal(m.insertionIndex(cfg, 'home', { kind: 'hidden' }, 1, ALL), 1, '跨容器不减');
  assert.equal(m.insertionIndex(cfg, 'home', { kind: 'group', gi: 0 }, null, ALL), null);

  const moved = m.moveToContainer(cfg, 'home', { kind: 'group', gi: 0 }, m.insertionIndex(cfg, 'home', { kind: 'group', gi: 0 }, 2, ALL), ALL);
  assert.deepEqual(moved.groups[0].views, ['reports', 'home', 'logs'], '预览到的顺序就是松手后的顺序');
});

test('平铺顺序：拖过之后按 order 排；没排过的按页面自身顺序跟在后面', () => {
  let cfg = m.emptyConfig();
  assert.deepEqual(m.poolOrder(cfg, ALL), ALL);

  cfg = m.moveToContainer(cfg, 'logs', { kind: 'pool' }, 0, ALL);
  assert.deepEqual(m.poolOrder(cfg, ALL), ['logs', 'home', 'settings', 'reports']);

  const withNew = [...ALL, 'brand_new'];
  assert.deepEqual(m.poolOrder(cfg, withNew), ['logs', 'home', 'settings', 'reports', 'brand_new']);
});

test('平铺容器：进分组 / 隐藏后再拖回，按当前顺序重新落位', () => {
  let cfg = m.moveToContainer(m.emptyConfig(), 'logs', { kind: 'pool' }, 0, ALL);
  assert.deepEqual(m.poolIds(cfg, ALL), ['logs', 'home', 'settings', 'reports']);

  cfg = m.moveToContainer(cfg, 'logs', { kind: 'hidden' }, null, ALL);
  assert.deepEqual(m.poolIds(cfg, ALL), ['home', 'settings', 'reports']);
  // toPool 必须带上页面清单：平铺顺序要靠它算「去掉自己之后的序列」
  cfg = m.toPool(cfg, 'logs', ALL);
  assert.deepEqual(m.poolIds(cfg, ALL), ['home', 'settings', 'reports', 'logs']);
});

test('validate：组名空 / 空组 / 页面不存在 / 跨组重复 / 隐藏与平铺顺序里的坏 id —— 都能判红', () => {
  assert.deepEqual(m.validate(m.addView(m.addGroup(m.emptyConfig(), 'A'), 0, 'home'), ALL), []);

  const cases = [
    [{ groups: [{ title: '  ', views: ['home'] }], hidden: [], order: [] }, /组名/],
    [{ groups: [{ title: 'A', views: [] }], hidden: [], order: [] }, /还没有页面/],
    [{ groups: [{ title: 'A', views: ['nope'] }], hidden: [], order: [] }, /已不存在，请移出/],
    [{ groups: [{ title: 'A', views: ['home'] }, { title: 'B', views: ['home'] }], hidden: [], order: [] }, /只能属于一个分组/],
    [{ groups: [], hidden: ['nope'], order: [] }, /已不存在/],
    [{ groups: [], hidden: [], order: ['nope'] }, /平铺顺序里的页面 nope 已不存在/],
  ];
  for (const [cfg, re] of cases) {
    const problems = m.validate(cfg, ALL);
    assert.equal(problems.length >= 1, true, `应报错: ${JSON.stringify(cfg)}`);
    assert.match(problems.map((p) => p.message).join(' | '), re);
  }
});
