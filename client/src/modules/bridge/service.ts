import { scanApps } from 'mn-ws-server/apps';

import type { MnWsController } from '../../core/controller.js';
import { readConfigFile, writeConfigFile, saveCustomApps, CUSTOM_APP_NAME_RE, type CustomApp } from '../../core/config.js';
import { badInput } from '../../core/errors/index.js';

/** 桥接状态视图。 */
export interface BridgeStatusView {
  state: string;
  url: string;
  clientId: string;
  /** 白名单里的应用 */
  apps: string[];
  /** server 半已确认注册的���用（注册成功才有） */
  registered: string[];
  /** 当前凭据的归属（登录了就是用户名，没登录就是「静态门禁」） */
  identity: string;
  loggedIn: boolean;
  via: string;
  reason?: string;
  retryInMs?: number;
}

/** 可桥接应用清单。 */
export interface BridgeAppsView {
  /** 白名单里的应用 + 端口存活 */
  configured: { app: string; title: string; port: number | null; base: string | null; alive: boolean; custom: boolean }[];
  /** 已登记但不在白名单里的（供面板勾选） */
  candidates: { app: string; title: string; port: number | null; alive: boolean }[];
  /** 在白名单里、但没有登记基址的应用（被跳过了，要说清楚） */
  missing: string[];
}

/** 远端目录视图。 */
export interface CatalogView {
  ok: boolean;
  error?: string;
  count?: number;
  apps: { app: string; title: string; port: number | null; base: string | null; bridgeId: string; connectedAt: string }[];
}

/** 桥接状态。 */
export function bridgeStatus(c: MnWsController): BridgeStatusView {
  const st = c.status();
  const sess = c.session.snapshot();
  return {
    state: st.state,
    url: st.url,
    clientId: st.clientId,
    apps: st.apps,
    registered: st.apps || [],
    identity: sess.loggedIn ? (sess.nickname || sess.email || sess.userId || '已登录') : '静态门禁',
    loggedIn: sess.loggedIn,
    via: sess.via,
    reason: st.reason,
    retryInMs: st.retryInMs,
  };
}

/**
 * 可桥接应用清单：白名单 + 端口存活探测 + 候选项。
 *
 * mn-ws 不认识任何具体服务，所以「候选项」来自**已登记但还没进白名单**的条目
 * —— 而不是一个内置应用表。登记在哪、叫什么、跑在哪个端口，全是使用者说的。
 */
export async function bridgeApps(c: MnWsController): Promise<BridgeAppsView> {
  const { apps: whitelist, titles, missing } = c.resolveApps();
  const names = Object.keys(whitelist);
  const overrides = c.cfg.appOverrides;

  const configured = (await scanApps({
    host: '127.0.0.1',
    entries: names.map((app) => ({ app, base: whitelist[app] ?? null, title: titles[app] })),
  })).map((a) => ({
    ...a,
    title: titles[a.app] || a.title,
    custom: !!(c.cfg.customApps || []).find((x) => x.name === a.app),
  }));

  // 候选项：已登记（appOverrides / customApps）但没进白名单的 —— 面板据此勾选
  const registered = new Map<string, { app: string; base: string | null; title?: string }>();
  for (const [name, o] of Object.entries(overrides || {})) {
    if (o && o.base) registered.set(name, { app: name, base: o.base, title: o.title });
  }
  for (const a of c.cfg.customApps || []) {
    registered.set(a.name, { app: a.name, base: a.base, title: a.title });
  }
  const rest = [...registered.values()].filter((e) => !names.includes(e.app));
  const scanned = await scanApps({ host: '127.0.0.1', entries: rest });
  const candidates = scanned.map((x) => ({
    app: x.app,
    title: x.title,
    port: x.port,
    alive: x.alive,
  }));

  return { configured, candidates, missing };
}

/**
 * 动态登记一个应用（本机的任意一个 HTTP 服务）。
 *
 * 这条是「运行时开放端口」的落点：用户起了一个临时服务（或某个服务换了端口），
 * 在面板上给它起个名字和端口，它就进了白名单，随注册帧上报给 server 半，
 * 别的客户端从目录里看到之后用 `X-Mn-Ws-App: <名字>` 就能打过来。
 *
 * 名字要当**路由标识**用（小写字母开头 + 小写字母/数字/连字符），
 * 基址要么给端口（默认本机回环），要么给完整 URL。
 */
export function addCustomApp(
  c: MnWsController,
  input: { name: string; port?: number; base?: string; title?: string },
): { ok: boolean; app?: string; base?: string; apps: string[]; error?: string } {
  const name = String(input.name || '').trim();
  if (!CUSTOM_APP_NAME_RE.test(name)) {
    return {
      ok: false,
      apps: Object.keys(c.resolveApps().apps),
      error: `应用名不合法：${name || '(空)'}（要小写字母开头，只含小写字母/数字/连字符，最长 32 位）`,
    };
  }

  let base = String(input.base || '').trim();
  if (!base && input.port) {
    base = `http://127.0.0.1:${input.port}`;
  }
  if (!base) {
    return { ok: false, apps: Object.keys(c.resolveApps().apps), error: '要给端口或完整基址' };
  }
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, apps: Object.keys(c.resolveApps().apps), error: '基址只支持 http / https' };
    }
    base = u.origin;
  } catch {
    return { ok: false, apps: Object.keys(c.resolveApps().apps), error: `基址不是合法 URL：${base}` };
  }

  const title = String(input.title || '').trim();
  const list = (c.cfg.customApps || []).filter((a) => a.name !== name);
  list.push(title ? { name, base, title } : { name, base });

  saveCustomApps(list);
  c.cfg.customApps = list;
  if (!c.cfg.apps.includes(name)) c.cfg.apps = [...c.cfg.apps, name];

  const applied = restartBridge(c);
  return { ok: true, app: name, base, apps: Object.keys(c.resolveApps().apps), ...(applied ? {} : {}) };
}

/** 移除一个自定义应用（连带把它从白名单里摘掉）。 */
export function removeCustomApp(
  c: MnWsController,
  name: string,
): { ok: boolean; removed: string; apps: string[]; error?: string } {
  const key = String(name || '').trim();
  const list = c.cfg.customApps || [];
  if (!list.find((a) => a.name === key)) {
    return { ok: false, removed: '', apps: Object.keys(c.resolveApps().apps), error: `没有这个自定义应用：${key}` };
  }
  const next = list.filter((a) => a.name !== key);
  saveCustomApps(next);
  c.cfg.customApps = next;
  c.cfg.apps = c.cfg.apps.filter((a) => a !== key);

  restartBridge(c);
  return { ok: true, removed: key, apps: Object.keys(c.resolveApps().apps) };
}

/**
 * 让运行中的桥按新白名单重注册。
 *
 * 为什么是「停掉再起」而不是增量更新：server 半的注册帧是**整张 app 表**
 * （`bridges` 按 app 索引，后来者顶替前者）。增删一个应用 = 整张表变了，
 * 重注册最简单，也不用给协议加增量语义。
 */
function restartBridge(c: MnWsController): boolean {
  if (!c.client) return false;
  c.stop();
  c.start();
  return true;
}

/** 设置白名单。落盘并让运行中的桥按新白名单重注册。 */
export async function setWhitelist(
  c: MnWsController,
  input: { apps: string[]; appMap: Record<string, { base: string; title?: string }> },
): Promise<{ ok: boolean; apps: string[]; applied: boolean }> {
  if (!input.apps.length && !Object.keys(input.appMap).length) {
    // 不给任何东西 = 清空白名单（= 一个都不桥）。这是有意的：
    // 「清空白名单」必须是一个能表达的动作，不能靠「什么都不传」来暗示。
    const raw = readConfigFile();
    delete raw.apps;
    delete raw.ports;
    delete raw.appMap;
    delete raw.appOverrides;
    writeConfigFile(raw);
    c.cfg.apps = [];
    c.cfg.appOverrides = {};
    return { ok: true, apps: [], applied: true };
  }

  const raw = readConfigFile();
  raw.apps = input.apps;
  raw.appMap = input.appMap;
  writeConfigFile(raw);

  c.cfg.apps = input.apps;
  c.cfg.appOverrides = input.appMap;

  // 运行中的桥要按新白名单重注册：停掉再起，让 server 半收到新的 app 表
  const wasRunning = !!c.client;
  if (wasRunning) {
    c.stop();
    c.start();
  }

  return { ok: true, apps: Object.keys(c.resolveApps().apps), applied: wasRunning };
}

/** 拉远端 server 半的元信息目录。 */
export async function remoteCatalog(c: MnWsController): Promise<CatalogView> {
  const base = (c.cfg.serverHttp || '').replace(/\/+$/, '');
  if (!base) throw badInput('缺少服务端地址（--url 或配置文件）');
  const token = c.session.credential() || c.cfg.token;
  if (!token) throw badInput('缺少凭据：mn-ws auth login，或用 --token 传门禁');

  let res: Response;
  try {
    res = await fetch(`${base}/api/catalog`, { headers: { 'X-Mn-Ws-Token': token } });
  } catch (e) {
    return { ok: false, error: `连不上 ${base}：${(e as Error).message}`, apps: [] };
  }
  const raw = await res.text();
  // 用 IIFE 解析：let + try/catch 的写法会被 TS 的控制流分析
  // 误判成「json 仍是初始的 null」，后面 json.ok 就成了 never。
  const json = ((): { ok?: boolean; error?: string; apps?: CatalogView['apps'] } | null => {
    try { return JSON.parse(raw) as { ok?: boolean; error?: string; apps?: CatalogView['apps'] }; }
    catch { return null; }
  })();
  if (!res.ok || !json || json.ok !== true) {
    return { ok: false, error: (json && json.error) || `HTTP ${res.status}`, apps: [] };
  }
  return { ok: true, count: (json.apps || []).length, apps: json.apps || [] };
}

// ---- 渲染 ----

export function renderStatus(r: BridgeStatusView): string {
  const lines = [
    `桥接状态：${r.state}`,
    `  server    ${r.url}`,
    `  本机标识  ${r.clientId}`,
    `  白名单    ${r.apps.join(', ') || '（空 —— 一个都不桥）'}`,
    `  身份      ${r.identity}${r.loggedIn ? `（${r.via === 'cli' ? '复用 CLI 登录态' : '面板登录'}）` : ''}`,
  ];
  if (r.reason) lines.push(`  说明      ${r.reason}`);
  if (r.retryInMs) lines.push(`  重连      ${Math.round(r.retryInMs / 1000)}s 后重试`);
  return lines.join('\n');
}

export function renderApps(r: BridgeAppsView): string {
  const lines = ['可桥接的应用（白名单）'];
  if (!r.configured.length) {
    lines.push('  （白名单为空 —— 一个都不桥。用 mn-ws apps set --apps my-api 设置）');
  } else {
    for (const a of r.configured) {
      lines.push(`  ${a.app.padEnd(10)} ${String(a.port ?? '—').padEnd(7)} ${a.alive ? '✓ 在监听' : '✗ 未运行'}  ${a.base || ''}`);
    }
  }
  const alive = r.candidates.filter((c) => c.alive);
  if (alive.length) {
    lines.push('', '本机在跑但不在白名单里（勾上才会被桥）：');
    for (const c of alive) lines.push(`  ${c.app.padEnd(10)} ${String(c.port).padEnd(7)} ${c.title}`);
  }
  return lines.join('\n');
}

export function renderWhitelist(r: { ok: boolean; apps: string[]; applied: boolean }): string {
  return `白名单已更新：${r.apps.join(', ') || '（空）'}`
    + (r.applied ? '\n运行中的桥已按新白名单重注册' : '');
}
