// 头部导航配置的**纯模型**：分组 + 隐藏 + 平铺顺序。零 React、零 IO，可单测。
//
// 为什么单独一层：这块的逻辑（增删改、排序、可用性、校验）比渲染多得多，
// 混在 JSX 里既说不清也测不了。表现层只管画，动手改数据一律走这里——
// 于是「管理逻辑」只有一份，前端拦一道、后端（modules/home）再拦一道，两边同口径。
//
// 配置形状（与 settings.navGroups / navHidden / navOrder 一一对应）：
//   { groups: [{ title, views: [页面id…] }], hidden: [页面id…], order: [页面id…] }
// 组顺序 = 头部显示顺序；组内顺序 = 展开列表顺序；hidden = 入口不显示（直达仍可用）；
// order = **平铺区的显示顺序**（没列进去的页面按页面自己的 order 跟在后面）。

export interface NavGroup {
  title: string;
  views: string[];
}

export interface NavConfig {
  groups: NavGroup[];
  hidden: string[];
  order: string[];
}

export const emptyConfig = (): NavConfig => ({ groups: [], hidden: [], order: [] });

/** 从后端 settings 取一份**工作副本**（深拷贝，编辑不污染原数据）。 */
export function configFromSettings(settings: {
  navGroups?: NavGroup[];
  navHidden?: string[];
  navOrder?: string[];
} | null | undefined): NavConfig {
  return {
    groups: (settings?.navGroups || []).map((g) => ({ title: String(g.title || ''), views: [...(g.views || [])] })),
    hidden: [...(settings?.navHidden || [])],
    order: [...(settings?.navOrder || [])],
  };
}

/** 保存时发出去的形状。 */
export function configToPayload(cfg: NavConfig) {
  return {
    navGroups: cfg.groups.map((g) => ({ title: g.title.trim(), views: [...g.views] })),
    navHidden: [...cfg.hidden],
    navOrder: [...cfg.order],
  };
}

export const isDirty = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

// —— 分组：增删改 + 排序 ——

export const addGroup = (cfg: NavConfig, title = ''): NavConfig => ({
  ...cfg,
  groups: [...cfg.groups, { title, views: [] }],
});

export const removeGroup = (cfg: NavConfig, gi: number): NavConfig => ({
  ...cfg,
  groups: cfg.groups.filter((_, i) => i !== gi),
});

export const renameGroup = (cfg: NavConfig, gi: number, title: string): NavConfig => ({
  ...cfg,
  groups: cfg.groups.map((g, i) => (i === gi ? { ...g, title } : g)),
});

/** 上移 / 下移一个分组（delta = ±1）；越界原样返回。 */
export function moveGroup(cfg: NavConfig, gi: number, delta: number): NavConfig {
  const to = gi + delta;
  if (to < 0 || to >= cfg.groups.length) return cfg;
  const groups = [...cfg.groups];
  const a = groups[gi];
  const b = groups[to];
  if (!a || !b) return cfg;
  groups[gi] = b;
  groups[to] = a;
  return { ...cfg, groups };
}

// —— 组成员：加入 / 移除 / 排序 ——

export function addView(cfg: NavConfig, gi: number, vid: string): NavConfig {
  const target = cfg.groups[gi];
  if (!target || target.views.includes(vid)) return cfg;
  if (cfg.groups.some((g) => g.views.includes(vid))) return cfg; // 一个页面只能属于一个分组
  return { ...cfg, groups: cfg.groups.map((g, i) => (i === gi ? { ...g, views: [...g.views, vid] } : g)) };
}

export const removeView = (cfg: NavConfig, gi: number, vid: string): NavConfig => ({
  ...cfg,
  groups: cfg.groups.map((g, i) => (i === gi ? { ...g, views: g.views.filter((x) => x !== vid) } : g)),
});

// —— 容器：平铺 / 分组 / 隐藏 ——

export type Container =
  | { kind: 'pool'; index: number | null }
  | { kind: 'hidden'; index: number }
  | { kind: 'group'; gi: number; index: number };

/**
 * 页面现在在哪个容器里，以及在该容器里的**渲染位置**（拖拽落点换算用它）。
 * 三种容器都有位置：平铺区返回它在「平铺列表」poolIds 里的位置（已剔除分组/隐藏项，
 * 与界面实际渲染一致——若用 poolOrder，排在前面的分组项会把平铺行的位置顶高）；
 * 分组与隐藏各自是数组下标。
 */
export function containerOf(cfg: NavConfig, vid: string, allIds: string[] = []): Container {
  const hi = cfg.hidden.indexOf(vid);
  if (hi >= 0) return { kind: 'hidden', index: hi };
  const gi = cfg.groups.findIndex((g) => g.views.includes(vid));
  if (gi >= 0) {
    const g = cfg.groups[gi]!;
    return { kind: 'group', gi, index: g.views.indexOf(vid) };
  }
  return { kind: 'pool', index: poolIds(cfg, allIds).indexOf(vid) };
}

/**
 * 平铺区的显示顺序：`order` 里显式排过的优先（按它的次序），
 * 没排过的新页面按传入的页面顺序（= 页面自己的 order）跟在后面。
 * 于是「从没拖过」= 纯页面顺序（老行为不变），拖过之后以拖的为准。
 */
export function poolOrder(cfg: NavConfig, allIds: string[]): string[] {
  const ranked = cfg.order.filter((id) => allIds.includes(id));
  const rest = allIds.filter((id) => !ranked.includes(id));
  return [...ranked, ...rest];
}

/**
 * 悬停行索引 → 真正的插入位。
 * 落点语义是「插到悬停行**之前**」，但被拖走的自身会让位：
 * 同容器内往下拖时悬停行索引要减 1，否则实时预览会比实际落点差一格。
 * `hoveredIndex === null` 表示拖在容器空白处 = 追加到末尾，原样返回。
 */
export function insertionIndex(
  cfg: NavConfig,
  vid: string,
  target: Target,
  hoveredIndex: number | null,
  allIds: string[] = [],
): number | null {
  if (hoveredIndex === null || hoveredIndex === undefined) return null;
  const from = containerOf(cfg, vid, allIds);
  const sameContainer = target.kind === from.kind
    && (target.kind !== 'group' || (from.kind === 'group' && target.gi === from.gi));
  if (sameContainer && typeof from.index === 'number' && from.index < hoveredIndex) return hoveredIndex - 1;
  return hoveredIndex;
}

export type Target = { kind: 'pool' } | { kind: 'hidden' } | { kind: 'group'; gi: number };

/** 把页面挪进目标容器（index = 在该容器里的插入位，null = 末尾）。 */
export function moveToContainer(
  cfg: NavConfig,
  vid: string,
  target: Target,
  index: number | null = null,
  allIds: string[] = [],
): NavConfig {
  // 先从所有容器里摘掉（分组 + 隐藏 + 平铺顺序），再放进目标——「移动」永远只落一处
  const groups = cfg.groups.map((g) => ({ ...g, views: g.views.filter((x) => x !== vid) }));
  const hidden = cfg.hidden.filter((x) => x !== vid);
  const base: NavConfig = { ...cfg, groups, hidden, order: cfg.order.filter((x) => x !== vid) };

  if (target.kind === 'hidden') return { ...base, hidden: [...hidden, vid] };

  if (target.kind === 'pool') {
    // 平铺区的顺序就是 order：先算出「去掉自己之后」的序列，再插到目标位
    const isPool = (id: string) => !groups.some((g) => g.views.includes(id)) && !hidden.includes(id);
    const seq = poolOrder(base, allIds).filter((id) => id !== vid && isPool(id));
    const at = index === null ? seq.length : Math.max(0, Math.min(index, seq.length));
    return { ...base, order: [...seq.slice(0, at), vid, ...seq.slice(at)] };
  }

  const cur = groups[target.gi];
  if (!cur) return cfg;
  const at = index === null ? cur.views.length : Math.max(0, Math.min(index, cur.views.length));
  const views = [...cur.views.slice(0, at), vid, ...cur.views.slice(at)];
  return { ...base, groups: groups.map((g, i) => (i === target.gi ? { ...cur, views } : g)) };
}

/**
 * 把页面移出分组 / 取消隐藏（回到头部的平铺区，落在**队尾**）。
 * 必须带上 allIds：平铺顺序要靠它算「去掉自己之后的序列」，
 * 否则 order 只剩自己一个 → 结果是插到队首。
 */
export const toPool = (cfg: NavConfig, vid: string, allIds: string[] = []): NavConfig => (
  moveToContainer(cfg, vid, { kind: 'pool' }, null, allIds)
);

// —— 隐藏 ——

export const toggleHidden = (cfg: NavConfig, vid: string): NavConfig => ({
  ...cfg,
  hidden: cfg.hidden.includes(vid) ? cfg.hidden.filter((x) => x !== vid) : [...cfg.hidden, vid],
});

export const isHidden = (cfg: NavConfig, vid: string): boolean => cfg.hidden.includes(vid);

// —— 派生 ——

export const groupedIds = (cfg: NavConfig): string[] => cfg.groups.flatMap((g) => g.views);

/** 「平铺」容器里的页面（既不在分组里、也没被隐藏），按平铺顺序。 */
export const poolIds = (cfg: NavConfig, allIds: string[]): string[] => {
  const skip = new Set([...groupedIds(cfg), ...cfg.hidden]);
  return poolOrder(cfg, allIds).filter((id) => !skip.has(id));
};

/** 某个分组**还能**加入哪些页面：不在本组、也不在别的组。 */
export function availableFor(cfg: NavConfig, gi: number, allIds: string[]): string[] {
  const target = cfg.groups[gi];
  if (!target) return [];
  const others = new Set(cfg.groups.flatMap((g, i) => (i === gi ? [] : g.views)));
  return allIds.filter((id) => !target.views.includes(id) && !others.has(id));
}

/**
 * 前端先拦一道（后端 modules/home 用同一套口径再拦一次）。
 * 返回 [{ field, message }]，空数组 = 可以保存。
 */
export function validate(cfg: NavConfig, allIds: string[]): { field: string; message: string }[] {
  const known = new Set(allIds);
  const problems: { field: string; message: string }[] = [];
  const owner = new Map<string, string>();

  cfg.groups.forEach((g, i) => {
    const label = g.title.trim() || `第 ${i + 1} 个分组`;
    if (!g.title.trim()) problems.push({ field: `groups.${i}.title`, message: `${label}：每个分组都要有组名` });
    if (!g.views.length) problems.push({ field: `groups.${i}.views`, message: `${label}：还没有页面——加一个，或删掉这个分组` });
    for (const vid of g.views) {
      if (!known.has(vid)) {
        problems.push({ field: `groups.${i}.views.${vid}`, message: `${label}：页面 ${vid} 已不存在，请移出` });
        continue;
      }
      const prev = owner.get(vid);
      if (prev !== undefined) {
        problems.push({ field: `groups.${i}.views.${vid}`, message: `页面 ${vid} 同时出现在「${prev}」与「${label}」里——一个页面只能属于一个分组` });
        continue;
      }
      owner.set(vid, label);
    }
  });

  for (const vid of cfg.hidden) {
    if (!known.has(vid)) problems.push({ field: `hidden.${vid}`, message: `要隐藏的页面 ${vid} 已不存在` });
  }
  for (const vid of cfg.order) {
    if (!known.has(vid)) problems.push({ field: `order.${vid}`, message: `平铺顺序里的页面 ${vid} 已不存在` });
  }
  return problems;
}
