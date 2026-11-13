// 「常用应用」记忆：最近暴露过的应用 + 它的端口。
//
// 为什么要有它：用户反复做的是同一件事 —— 「把这个端口再暴露一次」。
// 原来每次都要重新敲名字和端口（而名字得是合法路由标识，端口得对），
// 第二次暴露比第一次还费劲。这里把用过的条目记下来，面板上点一下就能重开。
//
// 与 customApps 的分工：
//   customApps  = **当前**登记着的应用（进白名单、被桥）
//   favorites   = **用过**的应用（含已经移除的），供一键重开
// 所以移除一个应用不会把它从常用里抹掉 —— 否则「移除」就等于「忘记」，
// 想再用时又得从头敲一遍。
//
// 独立成文件而不是塞进 config.ts：config.ts 已经贴着仓库的 max-lines 上限，
// 再往里加会让「加一个功能」变成「改一次上限」——那是个会被人顺手调大的数字。
import { readConfigFile, writeConfigFile } from './config.js';

/** 上限 20 条：再多就是日志而不是设置了。 */
const FAVORITES_LIMIT = 20;

/** 一个用过的应用。 */
export interface FavoriteApp {
  name: string;
  base: string;
  title?: string;
  /** 最近一次使用的时间戳（ms）；用于排序，越近越靠前 */
  usedAt: number;
}

/** 读常用应用（按最近使用排序）。 */
export function readFavorites(): FavoriteApp[] {
  const raw = readConfigFile();
  const list = Array.isArray(raw.favorites) ? raw.favorites : [];
  const clean: FavoriteApp[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const rec = x as Record<string, unknown>;
    const name = String(rec.name || '').trim();
    const base = String(rec.base || '').trim();
    if (!name || !base) continue;
    clean.push({
      name,
      base,
      title: rec.title ? String(rec.title) : undefined,
      usedAt: Number(rec.usedAt) || 0,
    });
  }
  // 同一个名字只留最近的一条；按 usedAt 倒序
  const byName = new Map<string, FavoriteApp>();
  for (const f of clean) {
    const prev = byName.get(f.name);
    if (!prev || f.usedAt > prev.usedAt) byName.set(f.name, f);
  }
  return [...byName.values()].sort((a, b) => b.usedAt - a.usedAt).slice(0, FAVORITES_LIMIT);
}

/**
 * 记一次「用过这个应用」。
 *
 * 同名覆盖：同一个路由标识换了端口，就该更新而不是多出一条 ——
 * 否则常用列表里会出现两个同名项，用户点哪个全靠猜。
 */
export function rememberFavorite(app: { name: string; base: string; title?: string }): void {
  const name = String(app.name || '').trim();
  const base = String(app.base || '').trim();
  if (!name || !base) return;
  const rest = readFavorites().filter((f) => f.name !== name);
  rest.unshift({ name, base, title: app.title, usedAt: Date.now() });
  const existing = readConfigFile();
  writeConfigFile({ ...existing, favorites: rest.slice(0, FAVORITES_LIMIT) });
}
