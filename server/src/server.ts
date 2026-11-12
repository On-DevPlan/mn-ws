import http from 'node:http';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import {
  FRAME, encodeFrame, decodeFrame, nextRequestId,
  normalizeHeaders, stripResponseHeaders, flattenHeaders,
  MAX_BODY_BYTES, DEFAULT_REQUEST_TIMEOUT_MS,
  type Frame,
} from './protocol.js';
import { resolveApp, describeApp, type AppDescriptor } from './apps.js';
import { Logger } from './logger.js';
import { Store } from './store.js';
import { AuthHub } from './auth.js';

/**
 * mn-ws server —— 公网侧的 HTTP ⇄ WebSocket 桥。
 *
 * 一个端口同时提供：
 *   · HTTP 面：/health /stats /clients /auth/* 以及 /<app>/* 桥接入口
 *   · WS  面：/ws —— 与本机 client half 的长连接
 *
 * ## 三层鉴权（缺一不可）
 *
 *   L1 通道层：谁能接入这个桥
 *      · 设备令牌（go-ah 统一登录签发，带 userId）→ 只能访问**自己名下**的桥
 *      · 静态门禁 token（MN_WS_TOKEN）→ 等价于全量访问（共享密钥，慎用）
 *   L2 路由层：请求的 app 必须在该桥的注册表里，且属主匹配
 *   L3 应用层：原始 Authorization / Cookie 原样透传给 nx，nx 自己那套鉴权照常生效
 *
 * ## 路由表按 app 索引
 *
 * bridges: Map<app, {ws, bridgeId, userId, ...}>。一个 app 同时只有一个桥
 * （后来者顶替前者）—— 同一台机器跑两份 nx 是异常状态，顶替比随机命中更可预期。
 */

/** server 半的构造参数。 */
export interface ServerOptions {
  host?: string;
  port?: number;
  wsPath?: string;
  token?: string;
  issuer?: string;
  idpClientId?: string;
  loginClientId?: string;
  redirectUri?: string;
  jwtSecret?: string;
  authEnabled?: boolean;
  insecure?: boolean;
  requestTimeoutMs?: number;
  dataDir?: string | null;
  logLevel?: string;
}

/** 一条已注册的桥。 */
interface Bridge {
  ws: WebSocket;
  bridgeId: string;
  userId: string;
  isGate: boolean;
  apps: AppDescriptor[];
  meta: AppDescriptor | undefined;
  connectedAt: string;
  ip: string | undefined;
}

/** 一条等待中的请求。 */
interface Pending {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  bridgeId: string;
  app: string;
  startedAt: number;
  status?: number;
  resHeaders?: Record<string, unknown>;
  chunks?: Buffer[];
}

/** 一条 WS 连接。 */
interface PeerMeta {
  peerId: string;
  bridgeId: string | null;
  userId: string | null;
  registered: boolean;
  connectedAt: string;
  ip: string | undefined;
}

/** 调用方身份。 */
type Caller =
  | { ok: true; userId: string; isGate: boolean }
  | { ok: false; status: number; error: string };

export function createServer(userConfig: ServerOptions = {}) {
  const config = {
    host: '0.0.0.0',
    port: 7777,
    wsPath: '/ws',
    token: '',
    issuer: 'http://47.110.80.47:8082',
    idpClientId: 'mn-ws-server',
    loginClientId: 'mn-ws-client',
    redirectUri: '',
    jwtSecret: '',
    authEnabled: false,
    insecure: false,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    dataDir: null as string | null,
    logLevel: 'info',
    ...userConfig,
  };

  const logger = new Logger({ level: config.logLevel, dir: config.dataDir, name: 'mn-ws-server' });
  const store = new Store({ dir: config.dataDir, name: 'requests.jsonl' });

  const auth = new AuthHub({
    enabled: config.authEnabled,
    issuer: config.issuer,
    clientId: config.idpClientId,
    loginClientId: config.loginClientId,
    redirectUri: config.redirectUri,
    jwtSecret: config.jwtSecret,
    dataDir: config.dataDir,
  });

  // ────────────────── 状态 ──────────────────

  /** app -> 桥 */
  const bridges = new Map<string, Bridge>();
  /** 曾经注册过的 app 名 —— 用来区分「从没这个应用」与「这个应用的桥掉线了」 */
  const knownApps = new Set<string>();
  /** requestId -> 等待中的请求 */
  const pending = new Map<string, Pending>();
  /** ws -> 连接元信息 */
  const peers = new Map<WebSocket, PeerMeta>();

  const stats = {
    connections: 0,
    requestsIn: 0,
    forwarded: 0,
    offline: 0,
    rejected: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
  };

  let nextPeerId = 1;

  // ────────────────── HTTP 层 ──────────────────

  const httpServer: HttpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const send = (code: number, body: unknown): void => {
      const payload = typeof body === 'string' ? body : (JSON.stringify(body) ?? '');
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      res.end(payload);
    };

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      // ── 公开端点 ──
      if (url.pathname === '/health') {
        send(200, {
          ok: true,
          service: 'mn-ws-server',
          uptime: process.uptime(),
          bridges: bridges.size,
          pending: pending.size,
          authEnabled: config.authEnabled,
        });
        return;
      }

      if (url.pathname === '/stats') {
        send(200, {
          ok: true,
          stats,
          apps: [...bridges.keys()],
          pending: pending.size,
        });
        return;
      }

      // ── 统一登录的公开参数（绝不含 secret）──
      if (url.pathname === '/auth/oidc/config') {
        send(200, { ok: true, ...auth.publicConfig() });
        return;
      }

      // ── 用认证中心的 access_token 换本服务的设备令牌 ──
      // 注意这里读的是 **Authorization**：这一段是「拿认证中心的令牌换设备令牌」，
      // 与 L1 的 X-Mn-Ws-Token 不是一回事。
      if (url.pathname === '/auth/verify' && req.method === 'POST') {
        const raw = await readBody(req);
        const body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
        const bearer = authorizationBearerOf(req);
        try {
          const identity = await auth.verifyBearer(bearer);
          const clientId = String(body.clientId || '').trim();
          if (!clientId) {
            send(400, { ok: false, error: '缺少 clientId', code: 'bad_request' });
            return;
          }
          auth.registerDevice({
            clientId,
            userId: identity.userId,
            deviceName: body.deviceName ? String(body.deviceName) : '',
          });
          const issued = auth.issueDeviceToken({
            userId: identity.userId,
            clientId,
            deviceName: body.deviceName ? String(body.deviceName) : '',
          });
          send(200, {
            ok: true,
            userId: identity.userId,
            email: identity.email,
            username: identity.preferredUsername,
            nickname: identity.name,
            token: issued.token,
            tokenExpiresAt: issued.expiresAt,
            clientId,
            deviceName: body.deviceName || '',
          });
        } catch (e) {
          const err = e as { message?: string; code?: string };
          send(401, { ok: false, error: err.message || 'unauthorized', code: err.code || 'unauthorized' });
        }
        return;
      }

      // ── 元信息目录：登录后拉「哪些可以路由」 ──
      // 远端客户端拿到凭据后的第一步就是拉这份目录 —— 看清有哪些应用、
      // 各自在哪个端口、由哪台桥承载，再决定调哪个、怎么调（路径前缀或
      // X-Nx-App 头）。
      if (url.pathname === '/api/catalog') {
        const caller = identifyCaller(req);
        if (!caller.ok) { sendRes(res, caller.status, { ok: false, error: caller.error }); return; }
        const list = [];
        for (const [app, b] of bridges) {
          // 具名用户只看得到自己名下的桥
          if (!caller.isGate && b.userId !== caller.userId) continue;
          list.push({
            app,
            title: b.meta && b.meta.title ? b.meta.title : app,
            port: b.meta ? b.meta.port : null,
            base: b.meta ? b.meta.base : null,
            bridgeId: b.bridgeId,
            connectedAt: b.connectedAt,
          });
        }
        sendRes(res, 200, { ok: true, count: list.length, apps: list });
        return;
      }

      // ── 已注册桥的清单（要鉴权）──
      if (url.pathname === '/clients') {
        const caller = identifyCaller(req);
        if (!caller.ok) { send(caller.status, { ok: false, error: caller.error }); return; }
        const list = [...bridges.entries()].map(([app, b]) => ({
          app,
          bridgeId: b.bridgeId,
          userId: b.userId,
          connectedAt: b.connectedAt,
        }));
        const visible = caller.isGate ? list : list.filter((b) => b.userId === caller.userId);
        send(200, { ok: true, count: visible.length, bridges: visible });
        return;
      }

      // ── 桥接入口：/<app>/* ──
      const resolved = resolveApp(url.pathname, normalizeHeaders(req.headers));
      if ('error' in resolved) {
        stats.rejected += 1;
        send(400, { ok: false, error: resolved.error });
        return;
      }
      const { app, path } = resolved;

      const caller = identifyCaller(req);
      if (!caller.ok) { send(caller.status, { ok: false, error: caller.error }); return; }

      const bridge = bridges.get(app);
      if (!bridge) {
        stats.offline += 1;
        // 区分两种「没有」：这个应用从来没注册过（404），
        // 还是注册过但桥掉线了（502，桥会自动重连）。
        const known = knownApps.has(app);
        store.append({
          app, method: req.method, path, status: known ? 502 : 404, userId: caller.userId,
        });
        sendRes(res, known ? 502 : 404, {
          ok: false,
          error: known ? 'bridge_offline' : 'unknown_app',
          app,
        });
        return;
      }
      // 属主校验：具名用户只能走自己的桥
      if (!caller.isGate && bridge.userId !== caller.userId) {
        stats.rejected += 1;
        logger.warn('rejected: 跨属主访问', {
          app, userId: caller.userId, owner: bridge.userId,
        });
        store.append({ app, method: req.method, path, status: 403, userId: caller.userId });
        sendRes(res, 403, { ok: false, error: 'forbidden', app });
        return;
      }

      stats.requestsIn += 1;

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        stats.rejected += 1;
        sendRes(res, 413, { ok: false, error: 'body_too_large', limit: MAX_BODY_BYTES });
        return;
      }
      stats.bytesIn += body.length;

      const id = nextRequestId();
      const headers: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(normalizeHeaders(req.headers))) {
        headers[k] = v;
      }

      const frame = {
        type: FRAME.REQUEST,
        id,
        app,
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body: body.toString('base64'),
        ts: Date.now(),
      };

      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        stats.errors += 1;
        store.append({ app, method: req.method, path, status: 504, userId: caller.userId });
        sendRes(res, 504, { ok: false, error: 'bridge_timeout', app });
      }, config.requestTimeoutMs);

      pending.set(id, { res, timer, bridgeId: bridge.bridgeId, app, startedAt: Date.now() });

      // 客户端断开 → 通知 client half 中断对应请求，别让本机白跑
      const onClose = (): void => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        try {
          sendRes(res, 499, { ok: false, error: 'client_disconnected', app });
        } catch { /* 连接已断，写不进去就算了 */ }
        try {
          bridge.ws.send(encodeFrame({ type: FRAME.ABORT, id, reason: 'client_disconnected' }));
        } catch { /* ignore */ }
      };
      req.on('close', onClose);
      res.on('finish', () => {
        const p = pending.get(id);
        if (p) { pending.delete(id); clearTimeout(p.timer); }
      });

      try {
        bridge.ws.send(encodeFrame(frame));
        stats.forwarded += 1;
      } catch (e) {
        const err = e as { message?: string };
        const p = pending.get(id);
        if (p) { pending.delete(id); clearTimeout(p.timer); }
        stats.errors += 1;
        sendRes(res, 502, { ok: false, error: 'bridge_send_failed', detail: err.message });
      }
    } catch (e) {
      const err = e as { message?: string };
      stats.errors += 1;
      logger.error('HTTP 处理异常', { error: err.message });
      try {
        sendRes(res, 500, { ok: false, error: 'internal_error' });
      } catch { /* ignore */ }
    }
  });

  // ────────────────── WebSocket 层 ──────────────────

  const wss = new WebSocketServer({
    server: httpServer,
    path: config.wsPath,
    maxPayload: MAX_BODY_BYTES * 2,
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const peerId = `peer-${nextPeerId++}`;
    peers.set(ws, {
      peerId,
      bridgeId: null,
      userId: null,
      registered: false,
      connectedAt: new Date().toISOString(),
      ip: req.socket.remoteAddress,
    });
    stats.connections += 1;
    logger.info('peer connected', { peerId, ip: req.socket.remoteAddress });

    // 连接后立即下发欢迎帧，便于客户端确认链路
    sendWs(ws, {
      type: FRAME.WELCOME,
      peerId,
      server: 'mn-ws-server',
      wsPath: config.wsPath,
      protocol: 1,
    });

    (ws as unknown as { isAlive: boolean }).isAlive = true;
    ws.on('pong', () => { (ws as unknown as { isAlive: boolean }).isAlive = true; });

    ws.on('message', (raw: unknown) => {
      const msg = decodeFrame(raw);
      if (!msg) {
        stats.rejected += 1;
        logger.warn('收到非法帧', { peerId });
        sendWs(ws, { type: FRAME.ERROR, error: 'invalid_json' });
        return;
      }
      const meta = peers.get(ws);
      if (!meta) return;

      // ── 注册 ──
      if (msg.type === FRAME.REGISTER) {
        handleRegister(ws, meta, msg);
        return;
      }

      // 未注册完成的连接不接受任何请求帧
      if (!meta.registered) {
        stats.rejected += 1;
        sendWs(ws, { type: FRAME.ERROR, error: 'not_registered' });
        return;
      }

      // ── 响应 / 错误 / 分块 ──
      if (msg.type === FRAME.RESPONSE || msg.type === FRAME.ERROR || msg.type === FRAME.CHUNK) {
        const p = pending.get(String(msg.id || ''));
        if (!p) {
          logger.warn('收到无主的响应帧', { peerId, id: msg.id });
          return;
        }
        if (msg.type === FRAME.CHUNK) {
          // 流式响应：第一块建响应，后续块追加
          if (!p.chunks) {
            p.chunks = [];
            p.status = (msg.status as number) || 200;
            p.resHeaders = (msg.headers as Record<string, unknown>) || {};
          }
          p.chunks.push(Buffer.from(String(msg.data || ''), 'base64'));
          return;
        }
        pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.type === FRAME.ERROR) {
          // **错误帧不能走 writeBack**：那里按 msg.status 写响应头，
          // 而 ERROR 帧没有 status（是 undefined → 0），writeHead(0) 抛错后
          // 退化成「200 + 空 body」——客户端看到的是「请求成功了但没内容」。
          // 这里明确回 502，并把错误原文带上。
          stats.errors += 1;
          logger.warn('本机执行失败', {
            app: p.app, code: msg.code, error: msg.error, id: msg.id,
          });
          store.append({
            app: p.app,
            status: 502,
            error: msg.error || msg.code,
            durationMs: Date.now() - p.startedAt,
          });
          sendRes(p.res, 502, {
            ok: false,
            error: msg.error || msg.code || 'bridge_error',
            code: msg.code || 'bridge_error',
            app: p.app,
          });
          return;
        }
        writeBack(p, msg);
      }
    });

    ws.on('close', () => {
      const meta = peers.get(ws);
      peers.delete(ws);
      if (!meta) return;
      logger.info('peer disconnected', { peerId: meta.peerId, bridgeId: meta.bridgeId });
      // 这个桥上的 app 全部摘掉 —— 留着就是僵尸路由
      for (const [app, b] of [...bridges.entries()]) {
        if (b.ws === ws) bridges.delete(app);
      }
      // 该桥上还没回的请求全部失败
      for (const [id, p] of [...pending.entries()]) {
        if (p.bridgeId !== meta.bridgeId) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        stats.errors += 1;
        try {
          sendRes(p.res, 502, { ok: false, error: 'bridge_disconnected' });
        } catch { /* ignore */ }
      }
    });

    ws.on('error', (e: Error) => {
      logger.warn('peer socket 错误', { peerId, error: e && e.message });
    });
  });

  /**
   * 处理 client half 的注册帧。
   *
   * 鉴权与「HTTP 调用方」同一套：设备令牌 → 具名用户；静态门禁 → 全量。
   * 注册时带上 app 表（app → base），服务端据此知道这台桥能桥什么。
   */
  function handleRegister(ws: WebSocket, meta: PeerMeta, msg: Frame): void {
    const bearer = String(msg.token || '');
    let userId = '';
    let isGate = false;

    const payload = auth.verifyDeviceToken(bearer);
    if (payload) {
      userId = String(payload.sub);
    } else if (config.token && bearer === config.token) {
      userId = '@gate';
      isGate = true;
    } else {
      stats.rejected += 1;
      logger.warn('rejected: 注册令牌无效', { peerId: meta.peerId });
      sendWs(ws, { type: FRAME.ERROR, error: 'invalid_token' });
      try { ws.close(4403, 'invalid token'); } catch { /* ignore */ }
      return;
    }

    const apps = Array.isArray(msg.apps) ? (msg.apps as unknown[]) : [];
    const clean: AppDescriptor[] = [];
    for (const a of apps) {
      const item = (a || {}) as { app?: unknown; base?: unknown; title?: unknown };
      if (!item || typeof item.app !== 'string') continue;
      // 归一化元信息（标题 / 端口）—— client 报的是它本地认定的元信息，
      // server 不去猜：client 给了标题就用它的（动态注册的应用没有已知表可查）。
      clean.push(describeApp(
        item.app,
        String(item.base || ''),
        typeof item.title === 'string' ? item.title : undefined,
      ));
    }

    // 同 app 被别的桥占用 → 顶替（旧桥的该 app 摘掉）
    const replaced: string[] = [];
    for (const { app } of clean) {
      const prev = bridges.get(app);
      if (prev && prev.ws !== ws) {
        replaced.push(app);
        bridges.delete(app);
        logger.warn('同 app 被新桥顶替', { app, old: prev.bridgeId, next: meta.peerId });
      }
    }
    for (const { app } of clean) {
      knownApps.add(app);
      const appMeta = clean.find((m) => m.app === app);
      bridges.set(app, {
        ws,
        bridgeId: String(msg.bridgeId || meta.peerId),
        userId,
        isGate,
        apps: clean,
        meta: appMeta,
        connectedAt: new Date().toISOString(),
        ip: meta.ip,
      });
    }

    meta.registered = true;
    meta.bridgeId = String(msg.bridgeId || meta.peerId);
    meta.userId = userId;

    logger.info('bridge registered', {
      peerId: meta.peerId, bridgeId: meta.bridgeId, userId, apps: clean.map((a) => a.app),
    });
    sendWs(ws, {
      type: FRAME.REGISTERED,
      bridgeId: meta.bridgeId,
      apps: clean.map((a) => a.app),
      replaced,
    });
  }

  /** 把 client half 的响应原样写回给 HTTP 客户端。 */
  function writeBack(p: Pending, msg: Frame): void {
    const body = Buffer.from(String(msg.body || ''), 'base64');
    stats.bytesOut += body.length;
    store.append({
      app: p.app,
      status: (msg.status as number) || 0,
      bytes: body.length,
      durationMs: Date.now() - p.startedAt,
    });
    try {
      // 协议层的头值是数组；writeHead 只收字符串（set-cookie 例外，它要数组）
      const headers = flattenHeaders(
        stripResponseHeaders(normalizeHeaders((msg.headers || {}) as Record<string, string | string[]>)),
        ['set-cookie'],
      );
      // content-length 由我们自己算：body 可能被 base64 往返过
      headers['content-length'] = String(body.length);
      p.res.writeHead((msg.status as number) || 200, headers);
      if (p.chunks && p.chunks.length) {
        p.res.write(Buffer.concat(p.chunks));
      }
      p.res.end(body);
    } catch (e) {
      const err = e as { message?: string };
      logger.warn('写回响应失败', { error: err.message });
      try { p.res.end(); } catch { /* ignore */ }
    }
  }

  // ────────────────── 工具 ──────────────────

  /**
   * 给 HTTP 客户端回一个 JSON。
   *
   * 注意：这个函数与下面的 [sendWs] **必须分开命名**。曾经两个都叫 sendJson，
   * 后一个函数声明把前一个整个遮蔽掉 —— 于是所有 `sendRes(res, 502, {...})`
   * 实际落到了 WS 版本（`ws.readyState` 在 ServerResponse 上是 undefined），
   * 静默什么都不发，客户端表现为「请求挂死直到超时」。
   */
  function sendRes(res: ServerResponse, code: number, obj: unknown): void {
    const payload = JSON.stringify(obj);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  /** 给 WebSocket 客户端发一帧。 */
  function sendWs(ws: WebSocket, obj: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(encodeFrame(obj)); return true; } catch { return false; }
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body_too_large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // ────────────────── 鉴权判定 ──────────────────

  /**
   * 判定调用方身份（L1 通道层）。
   *
   * 凭据走**独立头** `X-Mn-Ws-Token`，**不占用 Authorization** ——
   * Authorization 是留给 nx 自己的（L3 应用层，nx-kv 就是读
   * `Authorization: Bearer <token>`）。两层用同一个头会互相打架：
   * 门禁令牌被 nx 当成会话令牌去校验 → 401；反过来也一样。
   */
  function identifyCaller(req: IncomingMessage): Caller {
    const gate = gateTokenOf(req);
    if (!gate) {
      return { ok: false, status: 401, error: 'missing_mn_ws_token' };
    }
    // 设备令牌 → 具名用户，只能访问自己名下的桥
    const payload = auth.verifyDeviceToken(gate);
    if (payload) {
      return { ok: true, userId: String(payload.sub), isGate: false };
    }
    // 静态门禁 → 全量访问（共享密钥，慎用）
    if (config.token && gate === config.token) {
      return { ok: true, userId: '@gate', isGate: true };
    }
    return { ok: false, status: 401, error: 'invalid_token' };
  }

  /** L1 凭据：只在 X-Mn-Ws-Token 里读。 */
  function gateTokenOf(req: IncomingMessage): string {
    const h = req.headers['x-mn-ws-token'];
    if (typeof h === 'string' && h.trim()) return h.trim();
    if (Array.isArray(h) && h.length) return String(h[0]).trim();
    return '';
  }

  /** 认证中心的 access_token（只在 /auth/verify 用）。 */
  function authorizationBearerOf(req: IncomingMessage): string {
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
      return h.slice(7).trim();
    }
    return '';
  }

  // ────────────────── 生命周期 ──────────────────

  /**
   * 预热统一登录的发现文档（后台、幂等、带重试）。
   *
   * 为什么必须预热：`/auth/oidc/config` 报的 `idpAvailable` 含义是
   * 「**成功拉到过**发现文档」，而不是「认证中心在线」。
   * 不预热的话这个字段永远是 false —— 而部署脚本正是拿它断言
   * 「统一登录确实生效」，于是一个完全正常的部署会被判成失败。
   *
   * 为什么带重试：容器可能比认证中心先起来（编排顺序不保证），
   * 第一次失败就放弃 = 统一登录一直不可用，直到人工重启。
   *
   * 失败不固化缓存（AuthHub 只缓存成功的结果），所以重试是有效的。
   */
  function warmUpDiscovery(): void {
    if (!auth.enabled) return;
    const attempt = (n: number): void => {
      auth.discover()
        .then(() => {
          logger.info('统一登录发现文档就绪', { issuer: auth.issuer, attempt: n });
        })
        .catch((e: Error) => {
          logger.warn('发现文档拉取失败，稍后重试', { attempt: n, error: e.message });
          if (n < DISCOVERY_WARMUP_MAX_ATTEMPTS) {
            const t = setTimeout(() => attempt(n + 1), DISCOVERY_WARMUP_RETRY_MS);
            // unref：这个定时器不该拖住进程退出（测试里 close() 后要能立刻退干净）
            if (typeof t.unref === 'function') t.unref();
          }
        });
    };
    attempt(1);
  }

  function listen(): Promise<number> {
    return new Promise((resolve_, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, () => {
        const addr = httpServer.address();
        const actual = typeof addr === 'object' && addr ? addr.port : config.port;
        logger.info('mn-ws-server listening', {
          port: actual,
          host: config.host,
          wsPath: config.wsPath,
          authEnabled: config.authEnabled,
          gateToken: !!config.token,
        });
        warmUpDiscovery();
        resolve_(actual);
      });
    });
  }

  async function close(): Promise<void> {
    logger.info('shutting down');
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      try { sendRes(p.res, 503, { ok: false, error: 'shutting_down' }); } catch { /* ignore */ }
    }
    pending.clear();
    for (const ws of wss.clients) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    await new Promise((r) => wss.close(r));
    // ⚠️ 必须显式掐掉 keep-alive 连接：Node 19+ 的全局 agent 默认 keepAlive，
    // 而 httpServer.close() 会**等这些空闲连接自己结束**才回调 ——
    // 结果是 shutdown 永远不返回（生产上表现为 SIGTERM 后容器不退出，
    // 只能等编排强杀）。pending 请求已经回了 503，这里断连接是安全的。
    await new Promise<void>((r) => {
      httpServer.close(() => r());
      httpServer.closeAllConnections();
    });
    logger.close();
  }

  return {
    config,
    logger,
    store,
    auth,
    bridges,
    knownApps,
    pending,
    peers,
    stats,
    listen,
    close,
    APP_HEADER: 'x-nx-app',
  };
}

/** 发现文档预热的重试参数（次 / 毫秒）。 */
const DISCOVERY_WARMUP_MAX_ATTEMPTS = 10;
const DISCOVERY_WARMUP_RETRY_MS = 15_000;
