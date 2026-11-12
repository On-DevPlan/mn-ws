import { scanApps, KNOWN_APPS } from 'mn-ws-server/apps';

import type { MnWsController } from '../../core/controller.js';
import { readConfigFile, writeConfigFile } from '../../core/config.js';
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
  configured: { app: string; title: string; port: number | null; base: string | null; alive: boolean }[];
  /** 本机已知但不在白名单里的（供面板勾选） */
  candidates: { app: string; title: string; port: number; alive: boolean }[];
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

/** 可桥接应用清单：白名单 + 端口存活探测 + 候选项。 */
export async function bridgeApps(c: MnWsController): Promise<BridgeAppsView> {
  const { apps: whitelist } = c.resolveApps();
  const names = Object.keys(whitelist);
  const overrides = c.cfg.appOverrides;

  const configured = await scanApps({ host: '127.0.0.1', apps: names, overrides });

  // 候选项：已知表里没进白名单的（面板据此勾选）
  const rest = Object.keys(KNOWN_APPS).filter((a) => !names.includes(a));
  const scanned = await scanApps({ host: '127.0.0.1', apps: rest, overrides });
  const candidates = scanned
    .filter((x) => x.port !== null)
    .map((x) => ({ app: x.app, title: x.title, port: x.port as number, alive: x.alive }));

  return { configured, candidates };
}

/** 设置白名单。落盘并让运行中的桥按新白名单重注册。 */
export async function setWhitelist(
  c: MnWsController,
  input: { apps: string[]; ports: number[]; appMap: Record<string, { base: string }> },
): Promise<{ ok: boolean; apps: string[]; applied: boolean }> {
  if (!input.apps.length && !input.ports.length && !Object.keys(input.appMap).length) {
    // 不给任何东西 = 清空白名单（= 一个都不桥）。这是有意的：
    // 「清空白名单」必须是一个能表达的动作，不能靠「什么都不传」来暗示。
    const raw = readConfigFile();
    delete raw.apps;
    delete raw.ports;
    delete raw.appMap;
    writeConfigFile(raw);
    c.cfg.apps = [];
    c.cfg.ports = [];
    c.cfg.appOverrides = {};
    return { ok: true, apps: [], applied: true };
  }

  const raw = readConfigFile();
  raw.apps = input.apps;
  raw.ports = input.ports;
  raw.appMap = input.appMap;
  writeConfigFile(raw);

  c.cfg.apps = input.apps;
  c.cfg.ports = input.ports;
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
    lines.push('  （白名单为空 —— 一个都不桥。用 mn-ws apps set --apps nx-kv,nx-rh 设置）');
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
