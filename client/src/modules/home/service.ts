// home 域业务逻辑：演示业务动作（greet）+ 本机设置读写与**严格校验**。
//
// 本模块同时承担两件事：
//   ① 一个演示业务动作（greet）——演示「面板操作 → 状态落盘」闭环；
//   ② 本机设置的读写与**严格校验**（主题、头部导航：分组 / 隐藏 / 平铺顺序）。
//
// 为什么「首页」和「设置」合成一个模块：这两块都是「关于这个应用本身」的内容，
// 拆成两个模块，初始就凭空多出一个只有 meta 信息的空壳页。合成一个模块，
// 每一个出厂模块都有真实内容。
import { loadStore, mutateStore } from '../../core/store.js';
import type { NavGroup, Settings } from '../../core/store.js';
import { VIEWS_META, viewMetaOf } from '../../core/views.js';
import { badInput, notFound } from '../../core/errors/index.js';

// ---- ① 演示业务动作 ----

export interface GreetingResult {
  greeting: string;
  name: string;
  count: number;
  at: string;
}

// 打个招呼，并把问候次数累计进本机存储——演示「面板操作 → 状态落盘」闭环。
//
// 走 mutateStore 读-改-写事务：计数 +1 与落盘是一个原子动作，
// 两个并发请求不会丢计数，函数抛错则半个事务不会写进磁盘。
export async function greet(name: string, loud = false): Promise<GreetingResult> {
  const t = await mutateStore((s) => {
    const count = Number(s.greetCount || 0) + 1;
    s.greetCount = count;
    return count;
  });
  const count = Number(t);

  let greeting = `你好，${name}！这是第 ${count} 次问候。`;
  if (loud) greeting = greeting.toUpperCase();
  return { greeting, name, count, at: new Date().toISOString() };
}

// ---- ② 本机设置 ----

export interface SettingsView {
  settings: Settings;
  /** 全部页面（含 order 与出厂默认 hidden）——面板的头部导航与本页都用它 */
  views: { id: string; title: string; order: number; hidden?: boolean }[];
  schema: { key: string; hint: string }[];
}

/** 已知设置项 → 校验器 + 说明（面板据此提示）。 */
const SCHEMA: Record<string, { hint: string; coerce: (v: unknown) => unknown }> = {
  navGroups: { hint: '头部导航分组：[{title, views:[页面id…]}]，数组顺序 = 显示顺序', coerce: coerceNavGroups },
  navHidden: { hint: '隐藏的页面 id（入口不显示，直达仍可用）', coerce: coerceNavHidden },
  navOrder: { hint: '平铺区的显示顺序（页面 id 数组；没列进去的按页面自身顺序跟在后面）', coerce: coerceNavOrder },
  theme: { hint: '色彩主题：light（浅色）/ dark（深色）/ auto（跟随系统）', coerce: coerceTheme },
};

/** 主题白名单：只认 light / dark / auto，别的一律拒绝。 */
function coerceTheme(value: unknown): string {
  const t = String(value ?? '').trim().toLowerCase();
  if (!['light', 'dark', 'auto'].includes(t)) {
    throw badInput('主题只能是 light / dark / auto，收到: ' + String(value));
  }
  return t;
}

/**
 * 「页面 id 清单」校验（隐藏清单 / 平铺顺序共用）：每一项都必须是真实存在的页面；
 * 去重保序，并归一成真实 id。label 只影响报错措辞。
 * 三种写法都吃：数组（面板）、`a,b`（CLI 省事写法）、`["a","b"]`（CLI 的 JSON 写法）。
 */
function coerceIdList(value: unknown, label: string): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        raw = JSON.parse(s);
      } catch (e) {
        throw badInput(`${label}需要 JSON 数组或逗号分隔：${(e as Error).message}`);
      }
    }
  }
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out: string[] = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (!id) continue;
    if (!viewMetaOf(id)) throw badInput(`${label}里的页面不存在: ${id}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// 函数声明（会提升）：SCHEMA 在模块顶层引用它们，const 箭头函数会踩 TDZ
function coerceNavHidden(value: unknown): string[] {
  return coerceIdList(value, '隐藏清单');
}

function coerceNavOrder(value: unknown): string[] {
  return coerceIdList(value, '平铺顺序');
}

/** 分组校验 + 归一：组名非空、页面必须存在、组内去重、跨组重复拒绝、空组拒绝。 */
function coerceNavGroups(value: unknown): NavGroup[] {
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch (e) {
      throw badInput(`navGroups 需要 JSON 数组（${(e as Error).message}）：[{"title":"求职","views":["home"]}, …]`);
    }
  }
  if (!Array.isArray(arr)) {
    throw badInput('navGroups 需要是数组：[{"title":"求职","views":["home"]}, …]');
  }
  const owner = new Map<string, string>();
  return arr.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw badInput(`第 ${i + 1} 个分组不是对象`);
    const g = raw as { title?: unknown; views?: unknown };
    const title = String(g.title ?? '').trim();
    if (!title) throw badInput(`第 ${i + 1} 个分组缺少 title（组名）`);
    const views: string[] = [];
    for (const item of Array.isArray(g.views) ? g.views : []) {
      const id = String(item ?? '').trim();
      if (!id || views.includes(id)) continue; // 组内重复（或空串）直接去重
      if (!viewMetaOf(id)) throw badInput(`分组「${title}」里的页面不存在: ${id}`);
      const ownerTitle = owner.get(id);
      if (ownerTitle) throw badInput(`页面 ${id} 同时在分组「${ownerTitle}」与「${title}」里——一个页面只能属于一个分组`);
      owner.set(id, title);
      views.push(id);
    }
    if (!views.length) throw badInput(`分组「${title}」没有任何页面——要么加一个，要么删掉这个分组`);
    return { title, views };
  });
}

export async function getSettings(): Promise<SettingsView> {
  const store = await loadStore();
  return {
    settings: store.settings,
    views: VIEWS_META.map((v) => ({ ...v })),
    schema: Object.entries(SCHEMA).map(([key, s]) => ({ key, hint: s.hint })),
  };
}

/**
 * PATCH 语义：只改传入的项。
 * 返回 `{ settings }` 的**最新全量**（面板保存后直接拿来刷新头部）。
 */
export async function setSettings(input: {
  key?: string;
  value?: unknown;
  set?: Record<string, unknown>;
  'dry-run'?: boolean;
}): Promise<
  | { status: 'skipped'; dryRun: true; wouldSet: Record<string, unknown> }
  | { status: 'ok'; settings: Settings }
> {
  const patch: Record<string, unknown> = { ...(input.set || {}) };
  if (input.key !== undefined) patch[input.key] = input.value;

  const keys = Object.keys(patch);
  if (!keys.length) throw badInput('至少要给一项：setting set --key <名> --value <值>，或 --set k=v（可重复）');

  const resolved: Record<string, unknown> = {};
  for (const k of keys) {
    const spec = SCHEMA[k];
    if (!spec) throw notFound(`未知设置项: ${k}（可用: ${Object.keys(SCHEMA).join(', ')}）`);
    resolved[k] = spec.coerce(patch[k]);
  }

  if (input['dry-run']) return { status: 'skipped', dryRun: true, wouldSet: resolved };

  const after = (await mutateStore((s) => {
    const settings = s.settings as Settings;
    for (const [k, v] of Object.entries(resolved)) (settings as Record<string, unknown>)[k] = v;
    return { ...settings };
  })) as Settings;

  return { status: 'ok', settings: after };
}

export function renderSettings(d: SettingsView): string {
  const hidden = new Set(d.settings.navHidden || []);
  const lines = [`当前设置（改：mn-ws setting set --set k=v）· 主题: ${d.settings.theme || 'light'}`];
  for (const s of d.schema) lines.push(`  ${s.key.padEnd(12)} ${s.hint}`);

  lines.push('', `页面（${d.views.length}）· 隐藏 ${hidden.size} 个`);
  for (const v of d.views) {
    lines.push(`  ${v.id.padEnd(12)} ${v.title.padEnd(10)} ${hidden.has(v.id) ? '隐藏' : '显示'}`);
  }

  const order = d.settings.navOrder || [];
  const ranked = order.filter((id) => d.views.some((v) => v.id === id));
  if (ranked.length) lines.push(`平铺顺序（前 ${ranked.length} 个已显式排序）: ${ranked.join(' → ')}`);

  const groups = d.settings.navGroups || [];
  if (!groups.length) {
    lines.push('', '分组：无（全部页面平铺在头部）');
  } else {
    lines.push('', `分组（${groups.length}）· 组顺序 = 头部顺序，组内顺序 = 展开列表顺序`);
    for (const g of groups) lines.push(`  ${g.title}: ${g.views.join(' → ')}`);
  }
  lines.push('', '例：mn-ws setting set --set \'navGroups=[{"title":"求职","views":["home"]}]\' --dry-run');
  return lines.join('\n');
}

export function renderSettingSet(d: {
  status: string;
  dryRun?: boolean;
  wouldSet?: unknown;
  settings?: Settings;
}): string {
  if (d.status === 'skipped') return `试运行（未落盘）：将写入 ${JSON.stringify(d.wouldSet)}`;
  const groups = d.settings?.navGroups || [];
  const hidden = d.settings?.navHidden || [];
  const lines = [`已更新设置：${groups.length} 个导航分组，隐藏 ${hidden.length} 个页面`];
  for (const g of groups) lines.push(`  ${g.title}: ${g.views.join(' → ')}`);
  if (hidden.length) lines.push(`  隐藏: ${hidden.join(', ')}`);
  return lines.join('\n');
}
