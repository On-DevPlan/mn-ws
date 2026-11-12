/**
 * 通道协议：mn-ws server 半 ⇄ client 半 之间的 WebSocket 帧格式。
 *
 * 帧是 JSON 文本。**请求类帧带 id 用于配对** —— 一条 WS 连接上同时跑多个
 * HTTP 请求，响应按 id 归位（见 §多路复用）。
 *
 * 这套协议刻意做成**零语义**的：帧里装的就是「一次 HTTP 请求」与
 * 「一次 HTTP 响应」，server 半原样转发、client 半原样还原。
 * 任何业务语义（nx 的 action、鉴权规则）都不进协议层。
 *
 * ⚠️ 这个模块被 **client 半以 workspace 依赖引入**（`mn-ws-server` 的公共面）。
 * 改这里的形状 = 同时改两端，所以改动必须先想清楚两边的兼容。
 */

export const PROTOCOL_VERSION = 1;

/** 帧类型 */
export const FRAME = {
  // server → client
  WELCOME: 'welcome',
  REGISTERED: 'registered',
  REQUEST: 'request',
  ABORT: 'abort',
  PING: 'ping',
  SHUTDOWN: 'shutdown',
  ERROR: 'error',
  // client → server
  REGISTER: 'register',
  RESPONSE: 'response',
  CHUNK: 'chunk',
  PONG: 'pong',
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

/**
 * 不能跨代理转发的头（hop-by-hop）。
 *
 * 这些头描述的是**某一次连接**的属性，转发到下一跳会出错或无意义：
 *   · Connection: keep-alive  —— 新连接会自己协商
 *   · Transfer-Encoding: chunked —— body 已经被完整读成 buffer，重新算长度
 *   · Upgrade / Proxy-*        —— 代理自己的协商，不该替下游决定
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 请求头里必须**剥离**的头：
 *   · hop-by-hop —— 描述的是某一次连接，不该跨代理
 *   · Origin     —— nx-kv 的跨站防护只放行本机来源，透传浏览器 Origin 会 403
 *   · X-Mn-Ws-Token —— **mn-ws 自己的 L1 凭据**，属于桥接层内部事务，
 *     泄给目标服务等于把门禁令牌交出去
 */
export const STRIP_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP_HEADERS,
  'origin',
  'x-mn-ws-token',
]);

/**
 * 响应头里不能转发的头。
 *
 * `content-length` 会在 client half 重新按实际 body 长度计算；
 * `content-encoding` 由 client half 的 http 客户端处理，body 到手时已解码。
 */
export const STRIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
]);

/** 请求体上限（字节）。与 nx-kv 的 24MB 对齐；base64 后约 32MB。 */
export const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** 单个 HTTP 请求在 server 半的最长等待时间（毫秒）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 协议层的头：键统一小写，值统一成数组（保住 set-cookie 这类多值头）。 */
export type ProtocolHeaders = Record<string, string[]>;

/** 规范化前的头（Node 的 IncomingHttpHeaders 形状：值可能是 string | string[] | undefined）。 */
export type RawHeaders = Record<string, string | string[] | number | undefined>;

/** 帧的通用形状。具体帧再各自收窄。 */
export interface Frame {
  type: string;
  id?: string;
  [k: string]: unknown;
}

/** 帧编码：把一个对象序列化成 WS 文本帧。 */
export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj);
}

/**
 * 帧解码。返回 null 表示「这不是一帧合法的协议消息」——
 * 调用方应当忽略并计数，而不是把解析异常抛给连接层。
 */
export function decodeFrame(raw: unknown): Frame | null {
  if (raw === null || raw === undefined) return null;
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
  else return null;

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const type = (obj as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return obj as Frame;
}

/**
 * 生成一个跨连接唯一的请求 id。
 *
 * server 半的 pending 表是**全局**的（不按连接分表），所以 id 必须全局唯一：
 * 只带连接内计数的话，两条连接上的 "1" 会撞车，响应会被配到错误的请求上。
 */
let _seq = 0;
export function nextRequestId(prefix = 'r'): string {
  _seq = (_seq + 1) % 0xffffff;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${_seq.toString(36)}-${rand}`;
}

/** 头对象规范化：键统一小写，值统一成数组。 */
export function normalizeHeaders(headers: RawHeaders | undefined | null): ProtocolHeaders {
  const out: ProtocolHeaders = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase();
    if (v === undefined || v === null) continue;
    out[key] = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
  }
  return out;
}

/** 取头的第一个值（大小写不敏感）。 */
export function headerValue(
  headers: ProtocolHeaders | Record<string, unknown> | undefined | null,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = String(name).toLowerCase();
  const v = (headers as Record<string, unknown>)[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return String(v);
}

/** 剔除不该转发的请求头。 */
export function stripRequestHeaders(
  headers: Record<string, string[] | string> | undefined | null,
): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (STRIP_REQUEST_HEADERS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 剔除不该转发的响应头。 */
export function stripResponseHeaders(
  headers: Record<string, string[] | string> | undefined | null,
): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (STRIP_RESPONSE_HEADERS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 把协议层的头（值统一是数组）压平成 Node http 能吃的形状。
 *
 * ## 为什么需要这一步
 *
 * 协议层把头的值统一存成数组，是为了**保住 set-cookie 这类多值头**
 * （一个响应里可以有几十条 Set-Cookie，用 string 就只剩最后一条）。
 * 但 Node 的 `http.request({headers})` 与 `res.writeHead(status, headers)`
 * 要求**除 set-cookie 外全是字符串** —— 直接把数组塞进去会抛
 * `options.headers.host property must be of type string. Received an instance of Array`。
 *
 * @param headers  规范化后的头
 * @param arrayAllowed 允许保留数组的键（响应侧用 set-cookie）
 */
export function flattenHeaders(
  headers: Record<string, string[] | string> | undefined | null,
  arrayAllowed: readonly string[] = [],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (arrayAllowed.includes(k)) {
        if (v.length) out[k] = v.map((x) => String(x));
        continue;
      }
      if (!v.length) continue;
      out[k] = String(v[0]);
      continue;
    }
    out[k] = String(v);
  }
  return out;
}
