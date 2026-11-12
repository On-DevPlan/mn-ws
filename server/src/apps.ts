import net from 'node:net';

/**
 * 可桥接应用（app）表与探测。
 *
 * ## 为什么要有「应用标识」
 *
 * 一台机器上跑着十几个 nx 服务（nx-kv / nx-rh / nx-sk …），每个占一个端口。
 * 桥接要替它们**共用同一条对外的 HTTP 入口**，就必须能区分「这个请求该去
 * 哪个本地端口」——那就是**应用标识（app）**。
 *
 * ## 标识怎么带
 *
 * 两种都支持，**路径前缀优先**：
 *   ① `POST /nx-kv/api/todo/add`      → app=nx-kv, path=/api/todo/add
 *   ② `POST /api/todo/add` + 头 `X-Nx-App: nx-kv` → app=nx-kv, path=/api/todo/add
 *
 * 路径优先的理由：客户端零改造（curl 直接打）、自定义头不会被中间反代剥掉、
 * 且一个请求只可能对应一个 app（没有「路径说 A、头说 B」的歧义）。
 *
 * 两者都缺 → app_required；两者冲突 → app_conflict。
 * **冲突时报错而不是猜**：猜错等于把请求打到别人的服务上。
 *
 * ⚠️ 本模块被 **client 半以 workspace 依赖引入**（`mn-ws-server` 的公共面）。
 */

/** 请求头：应用标识的备用载体。 */
export const APP_HEADER = 'x-nx-app';

/** 已知 app 的元信息。 */
export interface KnownApp {
  title: string;
  port: number;
}

/**
 * 已知 nx 服务（2026-11-12 实测各仓 core/paths.js 的 DEFAULT_PORT）。
 *
 * **这不是白名单** —— 它只是「本机可能有什么」的提示与兜底默认值。
 * 真正能不能桥，由 client half 的配置（--apps / 配置文件）决定：
 * 端口探测只用来显示状态，**绝不因为「扫到端口在监听」就自动开桥**。
 */
export const KNOWN_APPS: Record<string, KnownApp> = {
  'nx-rh': { title: '仓库与 Skill 中枢', port: 7800 },
  'nx-rp': { title: '外部上下文', port: 7820 },
  'nx-sk': { title: '个人资源与密钥', port: 7866 },
  'nx-ft': { title: '前端资源管理', port: 7869 },
  'nx-kv': { title: 'KV 清单中枢', port: 7877 },
  'nx-nx': { title: '项目生成器', port: 7880 },
  'nx-kn': { title: 'Obsidian 知识库', port: 7881 },
  'nx-ditto': { title: 'ditto', port: 7883 },
  'nx-pg': { title: '画布工作台', port: 7888 },
  'nx-pn': { title: 'pn', port: 4561 },
};

/** app 名的合法形态：小写字母开头，只含小写字母/数字/连字符。 */
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 保留路径段：这些第一段**不可能**是应用标识。
 *
 * 没有这张表时，'/api/todo/list' 的第一段 'api' 会被当成 app 名 ——
 * 合法字符、全小写、还长得像个应用 —— 于是请求被路由到不存在的 app。
 * 这张表把服务自身的路径前缀排除掉。
 */
export const RESERVED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'api', 'auth', 'health', 'stats', 'clients', 'push', 'ws',
  'files', 'assets', 'static', 'docs', 'favicon.ico',
]);

/** app 的本地基址覆盖（--app-map 解析结果）。 */
export interface AppOverrides {
  [app: string]: { base: string };
}

/** 扫描结果里的一条。 */
export interface ScannedApp {
  app: string;
  title: string;
  base: string | null;
  port: number | null;
  alive: boolean;
}

/** 解析结果：要么给出 app 与剩余路径，要么给出错误码。 */
export type ResolvedApp =
  | { app: string; path: string }
  | { error: 'invalid_app_name' | 'app_conflict' | 'app_required' };

export function isValidAppName(name: unknown): boolean {
  return typeof name === 'string' && APP_NAME_RE.test(name);
}

/**
 * 解析一个 app 的本地基址。
 *
 * 优先用配置里给的 base；没给就用已知端口兜底。
 * 返回 null 表示这个 app 没有可用的本地端口。
 */
export function baseOf(app: string, overrides?: AppOverrides | null): string | null {
  const over = overrides && overrides[app];
  if (over && over.base) return over.base;
  const known = KNOWN_APPS[app];
  if (!known) return null;
  return `http://127.0.0.1:${known.port}`;
}

/**
 * 探测本机某个端口是否在监听。
 *
 * 用 TCP connect 而不是 HTTP 请求：桥接关心的是「这个服务在不在」，
 * 不是「它返回什么」。连不上就是不在，不多问。
 */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * 扫描本机各已知 app 的端口，返回可桥接清单（含存活状态）。
 *
 * 注意返回的是「候选清单」——**能不能桥由配置决定**，这里只提供事实。
 */
export async function scanApps({
  host = '127.0.0.1',
  apps = null,
  overrides = null,
}: { host?: string; apps?: string[] | null; overrides?: AppOverrides | null } = {}): Promise<ScannedApp[]> {
  const names = apps && apps.length ? apps : Object.keys(KNOWN_APPS);
  const out: ScannedApp[] = [];
  for (const app of names) {
    const base = baseOf(app, overrides);
    const known = KNOWN_APPS[app];
    let port: number | null = known ? known.port : null;
    if (!port && base) {
      try { port = Number(new URL(base).port || '') || null; } catch { port = null; }
    }
    const alive = port ? await probePort(host, Number(port)) : false;
    out.push({
      app,
      title: known ? known.title : app,
      base,
      port,
      alive,
    });
  }
  return out;
}

/** 端口预检的结果。 */
export interface PortFreeResult {
  free: boolean;
  error: NodeJS.ErrnoException | null;
}

/**
 * 检查某个端口能不能绑（= 现在没人占）。
 *
 * 为什么要预检：**静默顺延端口是这里最坏的处理**。server 顺延到 7778，
 * 客户端还按 7777 去连 —— 连不上还是连不上，而用户看到的现象是
 * 「服务端说起来了、客户端说连不上」，两边对不上账。宁可**明确报错退出**。
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<PortFreeResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (free: boolean, err: NodeJS.ErrnoException | null): void => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* ignore */ }
      resolve({ free, error: err });
    };
    server.once('error', (e: NodeJS.ErrnoException) => done(false, e));
    server.once('listening', () => done(true, null));
    try {
      server.listen(port, host);
    } catch (e) {
      done(false, e as NodeJS.ErrnoException);
    }
  });
}

/** app 的元信息（注册时上报给 server，汇总成 catalog）。 */
export interface AppDescriptor {
  app: string;
  base: string | null;
  port: number | null;
  title: string;
  known: boolean;
}

/**
 * 描述一个可桥接应用的元信息。
 *
 * client half 注册时把这份元信息一并报给 server half，server 把它汇总成
 * **元信息目录**（catalog）—— 远端客户端登录后先拉目录，看到「哪些能路由、
 * 各自是什么」，再决定调哪个。
 */
export function describeApp(app: string, base: string | null): AppDescriptor {
  const known = KNOWN_APPS[app] || null;
  let port: number | null = null;
  try {
    port = base ? Number(new URL(base).port || '') || null : null;
  } catch {
    port = null;
  }
  return {
    app,
    base,
    port: port || (known ? known.port : null),
    title: known ? known.title : app,
    known: !!known,
  };
}

/**
 * 从请求里解析出应用标识与剩余路径。
 *
 * @param pathname  请求路径（不含 query）
 * @param headers  规范化后的小写头对象
 */
export function resolveApp(
  pathname: string,
  headers?: Record<string, string[] | string> | null,
): ResolvedApp {
  const segs = String(pathname || '/').split('/').filter(Boolean);
  const first = segs[0];

  // ① 路径前缀：第一段就是已知/声明过的 app 名（且不是服务自身的保留段）
  let pathApp: string | null = null;
  if (first !== undefined && isValidAppName(first) && !RESERVED_PATH_SEGMENTS.has(first)) {
    pathApp = first;
  }

  // ② 请求头
  let headerApp: string | null = null;
  const hv = headers && headers[APP_HEADER];
  if (hv && Array.isArray(hv) && hv.length) {
    const v = String(hv[0]).trim();
    if (v) {
      if (!isValidAppName(v)) return { error: 'invalid_app_name' };
      headerApp = v;
    }
  } else if (hv && typeof hv === 'string') {
    const v = hv.trim();
    if (v) {
      if (!isValidAppName(v)) return { error: 'invalid_app_name' };
      headerApp = v;
    }
  }

  if (pathApp && headerApp && pathApp !== headerApp) {
    return { error: 'app_conflict' };
  }
  const app = pathApp || headerApp;
  if (!app) return { error: 'app_required' };

  const rest = pathApp ? segs.slice(1) : segs;
  const path = '/' + rest.join('/');
  return { app, path: path === '/' ? '/' : path.replace(/\/+$/, '') };
}