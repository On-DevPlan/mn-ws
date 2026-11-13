// 应用登记：mn-ws **不认识任何具体服务**，被桥什么由使用者登记。
//
// 这一组（CustomApp / parseCustomApps / CUSTOM_APP_NAME_RE / saveCustomApps）
// 独立成文件，而不是继续堆在 config.ts 里：
//   config.ts 已经贴着仓库的 max-lines 上限，再往里加会让
//   「加一个功能」变成「改一次上限」——那是个会被人顺手调大的数字。
//
// 名字规则与 server 侧的 APP_NAME_RE 同一条：名字要当**路由标识**用
// （远端用 X-Mn-Ws-App 或路径前缀 /<name>/... 命中它），
// 所以它必须是 URL 路径里安全的小写短串。
//
// ⚠️ 与 config.ts 是**双向引用**（config 要 CustomApp 类型与 parseCustomApps，
//    这里要 readConfigFile/writeConfigFile 与 parseApps）。ESM 能处理函数级的
//    循环（两者都在调用时才取对方），但为了让依赖方向单一、读代码时不必想
//    「这俩谁先初始化」，把真正需要的东西都从 config.ts 拿 —— 只有**类型**
//    CustomApp 是本文件定义的，那不构成运行时依赖。
import { readConfigFile, writeConfigFile, configFile, parseApps } from './config.js';

/**
 * 一个**已登记的应用**：名字 + 本地基址 + 标题。
 *
 * mn-ws 是通用 HTTP 桥，**不认识任何具体服务** —— 「桥的是什么」由使用者
 * 登记（命令行 `--apps` / 面板上的动态注册），桥只管把它按名字路由出去。
 */
export interface CustomApp {
  /** 路由标识：远端用 `X-Mn-Ws-App: <name>` 或路径前缀 `/<name>/...` 命中它 */
  name: string;
  /** 本机基址（如 http://127.0.0.1:9999） */
  base: string;
  /** 显示名（远端目录里给人看；留空就用名字兜底） */
  title?: string;
}

/** 自定义应用名的合法形态（与 server 侧的 APP_NAME_RE 同一条规则）。 */
export const CUSTOM_APP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 解析配置文件里的自定义应用列表。
 *
 * 容错：形状不对就整条丢掉，而不是让一个坏条目把整个面板带崩。
 * 名字不合法的也丢掉 —— 它要当路由标识用，非法名字会在 server 侧被拒，
 * 与其等到那时，不如现在就当它不存在（但保留其余条目）。
 */
export function parseCustomApps(v: unknown): CustomApp[] {
  if (!Array.isArray(v)) return [];
  const out: CustomApp[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { name?: unknown; base?: unknown; title?: unknown };
    const name = String(it.name ?? '').trim();
    const base = String(it.base ?? '').trim();
    if (!name || !base) continue;
    if (!CUSTOM_APP_NAME_RE.test(name)) continue;
    const title = String(it.title ?? '').trim();
    out.push(title ? { name, base, title } : { name, base });
  }
  return out;
}

/**
 * 保存自定义应用列表（面板上的「添加 / 移除」走这里）。
 *
 * 同时把自定义应用的名字并进 `apps` 白名单 —— 白名单是**唯一的准入依据**，
 * 自定义应用必须进白名单才会被桥。分开存是为了让「有哪些自定义应用」
 * 与「哪些被桥了」这两件事在配置里分得清。
 */
export function saveCustomApps(list: CustomApp[]): { changed: boolean; file: string } {
  const file = configFile();
  const existing = readConfigFile();
  const clean = parseCustomApps(list);
  const next: Record<string, unknown> = { ...existing, customApps: clean };

  // 自定义应用的名字并进白名单（去重、保序）
  //
  // ⚠️ 白名单里可能带**内联基址**（"名字=基址"），那必须**原样保留**：
  //    只把名字留下来，基址就没了 —— 下一次启动那些应用会被跳过，
  //    症状是「刚配好能用，重启后桥上就没它们了」。
  const rawApps = Array.isArray(existing.apps) ? existing.apps.map((x) => String(x)) : [];
  const names = parseApps(rawApps).names;
  for (const a of clean) {
    if (names.includes(a.name)) continue;
    names.push(a.name);
    rawApps.push(a.name);
  }
  next.apps = rawApps;

  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, file };
}
