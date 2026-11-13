import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

import {
  FRAME, encodeFrame, decodeFrame, normalizeHeaders, stripRequestHeaders, flattenHeaders,
  MAX_BODY_BYTES, type Frame,
} from 'mn-ws-server/protocol';
import { describeApp, type AppDescriptor } from 'mn-ws-server/apps';

/**
 * 桥接客户端的**请求还原器**：把 server 半发来的帧还原成一次真正的 HTTP 请求，
 * 打给本机的 HTTP 服务，再把响应封回帧。
 *
 * ## 为什么要「还原」而不是「转发」
 *
 * server 半拿到的是一段 HTTP 报文的**内容**（method / path / query / headers /
 * body），不是一条活的 socket。所以这一侧必须**造一个请求**出来 ——
 * 于是「哪些头能带过去」就全靠这里的规则决定，而规则错了症状都很隐蔽：
 *
 *   · 带上 Origin → 目标服务的跨站防护 403（直连好好的，走桥就 403）
 *   · 带上 Connection / Transfer-Encoding → 新连接自己会重算，带过去就是错的
 *   · 带上 content-length → body 经 base64 往返后长度可能变了，对不上就挂死
 *
 * 所以：**hop-by-hop 头 + Origin 全部剥掉，content-length 自己算。**
 */

/** 极简日志接口（与 mn-ws-server 的 Logger 兼容，但这里不依赖它）。 */
export interface BridgeLogger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** 一条请求帧。 */
export interface RequestFrame extends Frame {
  id?: string;
  app?: string;
  method?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string[] | string>;
  body?: string;
}

export class BridgeClient {
  apps: Record<string, BridgeApp>;
  logger: BridgeLogger | null;
  send: (frame: unknown) => void;
  /** requestId -> 本地在跑的请求 */
  inflight = new Map<string, http.ClientRequest>();

  constructor({
    apps = {},
    logger = null,
    send,
  }: {
    apps?: Record<string, BridgeApp>;
    logger?: BridgeLogger | null;
    send: (frame: unknown) => void;
  }) {
    this.apps = apps;
    this.logger = logger;
    this.send = send;
  }

  /** 处理一个 request 帧。 */
  async handleRequest(frame: RequestFrame): Promise<void> {
    const id = String(frame.id || '');
    const app = String(frame.app || '');
    const base = this.apps[app]?.base;
    if (!base) {
      this._respondError(id, 'unknown_app', `未注册应用 ${app}`);
      return;
    }

    let url: URL;
    try {
      url = new URL(String(base));
    } catch {
      this._respondError(id, 'bad_base', `应用 ${app} 的 base 不是合法 URL：${base}`);
      return;
    }

    const path = String(frame.path || '/');
    const query = frame.query && typeof frame.query === 'object'
      ? new URLSearchParams(frame.query).toString()
      : '';
    const targetPath = path + (query ? `?${query}` : '');

    let body: Buffer;
    try {
      body = Buffer.from(String(frame.body || ''), 'base64');
    } catch {
      this._respondError(id, 'bad_body', 'body 不是合法 base64');
      return;
    }
    if (body.length > MAX_BODY_BYTES) {
      this._respondError(id, 'body_too_large', `body ${body.length} 超过上限 ${MAX_BODY_BYTES}`);
      return;
    }

    // 剥掉不能转发的头（Origin 在其中）
    const headers = flattenHeaders(stripRequestHeaders(normalizeHeaders(frame.headers || {})));
    // content-length 按实际 body 重算：body 走过一趟 base64，长度以本地为准
    delete headers['content-length'];
    if (body.length > 0) headers['content-length'] = String(body.length);

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: frame.method || 'GET',
      path: targetPath,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy(new Error('响应体超过上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        this.inflight.delete(id);
        const buf = Buffer.concat(chunks);
        this.send({
          type: FRAME.RESPONSE,
          id,
          status: res.statusCode || 0,
          headers: normalizeHeaders(res.headers),
          body: buf.toString('base64'),
          ts: Date.now(),
        });
        this.logger?.debug('bridged', { app, path: targetPath, status: res.statusCode, bytes: buf.length });
      });
    });

    this.inflight.set(id, req);

    req.on('timeout', () => { req.destroy(new Error('本机请求超时')); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      this.inflight.delete(id);
      this._respondError(id, e.code || 'request_failed', e.message);
    });

    if (body.length > 0) req.write(body);
    req.end();
  }

  /** 中断一个在跑的请求（server 侧 HTTP 客户端断开了）。 */
  abort(id: string): boolean {
    const req = this.inflight.get(String(id));
    if (!req) return false;
    this.inflight.delete(String(id));
    try { req.destroy(); } catch { /* ignore */ }
    return true;
  }

  /** 断开时把所有在跑的请求收掉。 */
  abortAll(): void {
    for (const [, req] of this.inflight) {
      try { req.destroy(); } catch { /* ignore */ }
    }
    this.inflight.clear();
  }

  private _respondError(id: string, code: string, message: string): void {
    this.send({
      type: FRAME.ERROR,
      id,
      code,
      error: String(message || code),
    });
  }
}

// ───────────────────────── 连接器 ─────────────────────────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * 心跳间隔（毫秒）：多久没收到东西就 ping 一次。
 *
 * 取 15s：比服务端的心跳略长一点，两边不会在同一拍上互相打断。
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** 连接状态。 */
export interface BridgeStatus {
  state: 'idle' | 'connecting' | 'connected' | 'registered' | 'reconnecting' | 'stopped' | 'shutdown' | 'error';
  apps?: string[];
  replaced?: string[];
  reason?: string;
  retryInMs?: number;
  error?: string;
}

/** 一条被桥的应用：基址 + 可选标题。 */
export interface BridgeApp {
  base: string;
  /** 显示名。登记时没给就用路由标识兜底。 */
  title?: string;
}

/** 连接器的构造参数。 */
export interface WsBridgeClientOptions {
  url: string;
  token?: string;
  bridgeId?: string;
  /** 这台 PC 的**电脑名**（注册时自报）。远端目录按它分组。 */
  pcName?: string;
  /** app -> { base, title? } */
  apps?: Record<string, BridgeApp>;
  logger?: BridgeLogger | null;
  onStatus?: (s: BridgeStatus) => void;
}

/**
 * 桥接客户端的**连接器**：连 server 半、注册、重连、重注册。
 *
 * 与 mn-rt 的 client/lib/ws-client.js 同款骨架：指数退避重连 + 状态回调。
 * 差别在**注册内容**：mn-rt 注册的是"我是一台 PC"，
 * mn-ws 注册的是"我是一台桥，能桥这些 app"。
 */
export class WsBridgeClient {
  url: string;
  token: string;
  bridgeId: string;
  /** 这台 PC 的电脑名（注册时自报；远端目录按它分组）。 */
  pcName: string;
  apps: Record<string, BridgeApp>;
  logger: BridgeLogger | null;
  onStatus: (s: BridgeStatus) => void;

  ws: WebSocket | null = null;
  stopped = false;
  attempts = 0;
  timer: NodeJS.Timeout | null = null;
  /** 心跳定时器：定期 ping，验证这条连接还活着。 */
  heartbeatTimer: NodeJS.Timeout | null = null;
  /** 上一轮 ping 是否还在等 pong。 */
  pongPending = false;
  state: BridgeStatus['state'] = 'idle';
  bridge: BridgeClient;

  constructor({
    url,
    token = '',
    bridgeId = '',
    pcName = '',
    apps = {},
    logger = null,
    onStatus,
  }: WsBridgeClientOptions) {
    this.url = url;
    this.token = token;
    this.bridgeId = bridgeId;
    this.pcName = pcName;
    this.apps = apps;
    this.logger = logger;
    this.onStatus = onStatus || (() => {});

    this.bridge = new BridgeClient({
      apps,
      logger,
      send: (frame) => { this._send(frame); },
    });
  }

  private _send(frame: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(encodeFrame(frame));
      return true;
    } catch (e) {
      this.logger?.warn('发送帧失败', { error: (e as Error).message });
      return false;
    }
  }

  private _setState(state: BridgeStatus['state'], extra: Partial<BridgeStatus> = {}): void {
    this.state = state;
    this.onStatus({ state, ...extra });
  }

  /** 连上并注册。 */
  start(): void {
    this.stopped = false;
    this._connect();
  }

  /** 断开并停止重连。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this._stopHeartbeat();
    this.bridge.abortAll();
    if (this.ws) {
      try { this.ws.close(1000, 'client stopped'); } catch { /* ignore */ }
      this.ws = null;
    }
    this._setState('stopped');
  }

  private _connect(): void {
    if (this.stopped) return;
    this._setState('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    } catch (e) {
      this._scheduleReconnect(`连接失败：${(e as Error).message}`);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this._setState('connected');
      this._startHeartbeat(ws);
      // 注册：带上 app 表 + 每个 app 的元信息（标题、端口），
      // server 半据此汇总成**元信息目录**，远端客户端登录后先拉目录、
      // 看清楚「哪些能路由」再选。标题是动态注册的应用唯一能被认出来的线索，
      // 所以它必须一起报上去。
      const apps: AppDescriptor[] = Object.entries(this.apps)
        .map(([app, a]) => describeApp(app, a.base, a.title));
      this._send({
        type: FRAME.REGISTER,
        role: 'bridge',
        bridgeId: this.bridgeId,
        // 电脑名：多台 PC 同时接入时，远端目录靠它分组。
        // 光有 bridgeId（机器名 + 随机 6 位）看不出「这是哪台电脑」。
        ...(this.pcName ? { name: this.pcName } : {}),
        apps,
        token: this.token,
      });
      this.logger?.info('已连上 server，注册桥接应用', { apps: apps.map((a) => a.app) });
    });

    ws.on('message', (raw: unknown) => {
      const msg = decodeFrame(raw);
      if (!msg) {
        this.logger?.warn('收到非法帧');
        return;
      }
      this._onFrame(msg);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null;
      this._stopHeartbeat();
      this.bridge.abortAll();
      if (this.stopped) { this._setState('stopped'); return; }
      this._scheduleReconnect(`连接断开（${code}${reason.length ? ` ${reason.toString()}` : ''}）`);
    });

    // 收到 pong = 这条连接还活着（服务端的心跳也会回 pong）
    ws.on('pong', () => { this.pongPending = false; });

    ws.on('error', (e: Error) => {
      this.logger?.warn('socket 错误', { error: e && e.message });
      // close 事件会随后到达，重连逻辑挂在 close 上，这里不重复处理
    });
  }

  private _onFrame(msg: Frame): void {
    switch (msg.type) {
      case FRAME.WELCOME:
        this.logger?.info('收到 welcome', { peerId: msg.peerId });
        break;
      case FRAME.REGISTERED:
        this._setState('registered', {
          apps: (msg.apps as string[]) || [],
          replaced: (msg.replaced as string[]) || [],
        });
        this.logger?.info('注册成功', { apps: msg.apps, replaced: msg.replaced });
        break;
      case FRAME.REQUEST:
        this.bridge.handleRequest(msg as RequestFrame).catch((e: Error) => {
          this.bridge['_respondError'](String(msg.id || ''), 'handle_failed', e.message);
        });
        break;
      case FRAME.ABORT:
        this.bridge.abort(String(msg.id || ''));
        break;
      case FRAME.PING:
        this._send({ type: FRAME.PONG });
        break;
      case FRAME.SHUTDOWN:
        this.logger?.warn('服务端要求下线', { reason: msg.reason });
        this._setState('shutdown');
        break;
      case FRAME.ERROR:
        this.logger?.warn('服务端报错', { error: msg.error, detail: msg.detail });
        this._setState('error', { error: String(msg.error || 'unknown') });
        break;
      default:
        break;
    }
  }

  /** 指数退避重连：1s → 2s → 4s … 封顶 30s。 */
  private _scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    if (this.timer) return;
    const delay = Math.min(RECONNECT_BASE_MS * (2 ** this.attempts), RECONNECT_MAX_MS);
    this.attempts += 1;
    this._setState('reconnecting', { reason, retryInMs: delay });
    this.logger?.warn('准备重连', { reason, delayMs: delay, attempt: this.attempts });
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect();
    }, delay);
    this.timer.unref?.();
  }

  /**
   * 起心跳：定期 ping，验证这条连接**真的还活着**。
   *
   * 为什么必须有：TCP 是**半开**的 —— 服务端被 `docker rm` 掉时，对端不一定
   * 发来 FIN/RST（跨境链路 + 运营商 NAT 下 RST 会丢）。没有心跳，客户端会一直
   * 以为「还连着」，实际上一帧也发不出去：
   * 症状是面板显示「已连接」，但所有请求都 502，而且**永远不会自己恢复**。
   *
   * 心跳把这个假设变成可验证的：ping 出去，pong 回来才算活着；
   * pong 不回来就主动 terminate，让 close 事件触发重连。
   */
  private _startHeartbeat(ws: WebSocket): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.pongPending) {
        // 上一轮 ping 没等到 pong → 连接已经死了
        this.logger?.warn('心跳无响应，判定连接已死', { url: this.url });
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      this.pongPending = true;
      try {
        ws.ping();
      } catch (e) {
        this.pongPending = false;
        this.logger?.warn('心跳发送失败', { error: (e as Error).message });
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pongPending = false;
  }
}
