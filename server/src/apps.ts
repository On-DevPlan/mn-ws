import net from 'node:net';

/**
 * 可桥接应用（app）的标识、路由与探测。
 *
 * ## mn-ws 是**通用 HTTP 桥**，不是某个服务家族的附属
 *
 * 本模块**不认识任何具体服务**：没有内置应用表，没有默认端口表。
 * 一个「应用」在本项目里只有三样东西：
 *
 *   名字（路由标识）  基址（http://127.0.0.1:9999）  标题（给人看的名字）
 *
 * 这三样**全部由 client 半登记**（命令行 `--apps` / 面板上的动态注册），
 * server 半只从注册帧里学到它们。它不需要知道被桥的是什么 ——
 * 桥的是 KV 清单中枢、仓库中枢，还是一个临时起的调试服务，对它没有区别。
 *
 * 之所以要这样切：**「服务长什么样」是业务侧的事，「怎么把 HTTP 桥出去」
 * 是桥的事。**把某个服务族的名字、端口、用法写进桥的发行包，等于让桥背上
 * 别人的业务知识 —— 那个族一改版，桥就得跟着改；而桥的价值恰恰在于
 * 能桥任何东西。
 *
 * ## 为什么要有「应用标识」
 *
 * 一台机器上跑着多个 HTTP 服务，每个占一个端口。桥接要替它们
 * **共用同一条对外的 HTTP 入口**，就必须能区分「这个请求该去哪个本地
 * 端口」—— 那就是**应用标识（app）**。
 *
 * ## 标识怎么带
 *
 * 两种都支持，**路径前缀优先**：
 *   ① `POST /my-api/api/todo/add`      → app=my-api, path=/api/todo/add
 *   ② `POST /api/todo/add` + 头 `X-Mn-Ws-App: my-api` → app=my-api, path=/api/todo/add
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
export const APP_HEADER = 'x-mn-ws-app';

/**
 * app 名的合法形态：小写字母开头，只含小写字母/数字/连字符。
 *
 * 它要当**路由标识**用（路径前缀 / X-Mn-Ws-App 头），所以必须是合法标识符。
 */
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

/**
 * 一个**已登记**的应用：名字 + 本地基址 + 标题。
 *
 * 「登记」是 client 半的职责（配置文件 / 命令行 / 面板动态注册）。
 */
export interface AppEntry {
  /** 路由标识 */
  app: string;
  /** 本地基址，如 http://127.0.0.1:9999 */
  base: string | null;
  /** 显示名（目录里给人看）；不给就用名字兜底 */
  title?: string;
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
 * 从基址里取出端口。
 *
 * 基址是唯一的事实来源 —— 端口是基址的一部分，不是另填的一张表。
 */
export function portOfBase(base: string | null | undefined): number | null {
  if (!base) return null;
  try {
    const p = Number(new URL(base).port || '');
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
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
 * 扫描一批**已登记**的应用，返回存活状态。
 *
 * 注意返回的是「事实」——**能不能桥由白名单决定**，这里只提供状态。
 * 扫到端口在监听也**绝不自动开桥**：那等于把整台机器暴露出去。
 */
export async function scanApps({
  host = '127.0.0.1',
  entries = [],
}: { host?: string; entries?: AppEntry[] } = {}): Promise<ScannedApp[]> {
  const out: ScannedApp[] = [];
  for (const e of entries) {
    const port = portOfBase(e.base);
    const alive = port ? await probePort(host, port) : false;
    out.push({
      app: e.app,
      title: (e.title || '').trim() || e.app,
      base: e.base,
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
}

/**
 * 描述一个可桥接应用的元信息。
 *
 * client 半注册时把这份元信息一并报给 server 半，server 把它汇总成
 * **元信息目录**（catalog）—— 远端客户端登录后先拉目录，看到「哪些能路由、
 * 各自是什么」，再决定调哪个。
 *
 * @param app   应用名（路由标识，必须匹配 APP_NAME_RE）
 * @param base  本地基址，如 http://127.0.0.1:9999
 * @param title 客户端自报的标题。**给了就用它的** ——
 *   client 半知道「这个名字是我自己起的、叫什么」，server 不该替它猜，
 *   更不该替它猜一个「默认叫什么」。
 */
export function describeApp(app: string, base: string | null, title?: string): AppDescriptor {
  return {
    app,
    base,
    port: portOfBase(base),
    title: (title || '').trim() || app,
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

  // ① 路径前缀：第一段就是声明过的 app 名（且不是服务自身的保留段）
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
