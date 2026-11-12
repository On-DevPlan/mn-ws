import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * mn-ws server 侧的认证：统一登录的公开参数 + 设备令牌的签发与校验。
 *
 * 与 mn-rt 的 server/src/auth.js 同构，但**没有 sessionKey**：
 * mn-ws 桥接的是 HTTP 请求，不是加密信封流，桥接层不需要「会话密钥」概念。
 *
 * 两类凭据：
 *   · 认证中心 access_token —— 短命，登录当场换设备令牌用完即弃，不落盘。
 *   · mn-ws 设备令牌（HS256 JWT）—— 长命，落盘，由本服务签发与吊销。
 */

/** 设备令牌有效期（秒）。默认 90 天 —— 桥接是公网暴露面，令牌不宜过长。 */
export const DEVICE_TOKEN_TTL_SEC = 90 * 24 * 3600;

export function b64url(buf: Buffer | string): string {
  return Buffer.from(buf as never).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

export function fromB64url(s: string): Buffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** 设备令牌的 payload。 */
export interface DeviceTokenPayload {
  sub: string;
  cid: string;
  dn: string;
  iat: number;
  exp: number;
  jti: string;
}

/** 一台已登记的桥（client half）：clientId → 属主。 */
export interface DeviceRecord {
  userId: string;
  clientId: string;
  deviceName: string;
  registeredAt: string;
  lastSeenAt: string;
}

/** AuthHub 的构造参数。 */
export interface AuthHubOptions {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  /** client 半的身份：真正发起授权码流程的是它 */
  loginClientId?: string;
  redirectUri?: string;
  scopes?: string[];
  jwtSecret?: string;
  httpTimeoutMs?: number;
  dataDir?: string | null;
}

/** 公开参数（绝不含 secret）。 */
export interface PublicAuthConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  loginClientId: string;
  redirectUri: string;
  scopes: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  idpAvailable: boolean;
  idpError?: string;
}

/** 认证中心的发现文档（只用到其中几个端点，其余字段原样带过）。 */
export interface IdpEndpoints {
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  issuer?: string;
  [k: string]: string | undefined;
}

export class AuthHub {
  enabled: boolean;
  issuer: string;
  clientId: string;
  loginClientId: string;
  redirectUri: string;
  scopes: string[];
  jwtSecret: string;
  httpTimeoutMs: number;
  dataDir: string | null;

  /** 发现文档缓存。只有成功才固化——失败若被记住，容器编排下
   *  "本服务先于认证中心启动" 会让统一登录永久不可用直到重启。 */
  private _endpoints: IdpEndpoints | null = null;
  private _discoverError = '';

  /** clientId -> {userId, deviceName, registeredAt, lastSeenAt} */
  devices = new Map<string, DeviceRecord>();
  /** jti -> 过期时间戳（吊销名单） */
  revoked = new Map<string, number>();

  constructor(opts: AuthHubOptions = {}) {
    this.enabled = opts.enabled === true;
    this.issuer = opts.issuer || '';
    this.clientId = opts.clientId || '';
    this.loginClientId = opts.loginClientId || '';
    this.redirectUri = opts.redirectUri || '';
    this.scopes = opts.scopes || ['openid', 'profile', 'email'];
    this.jwtSecret = opts.jwtSecret || '';
    this.httpTimeoutMs = opts.httpTimeoutMs || 10_000;
    this.dataDir = opts.dataDir || null;
    this._loadDevices();
  }

  // ==================== 配置与发现 ====================

  /** 下发给客户端的公开参数。**绝不含任何 secret**。 */
  publicConfig(): PublicAuthConfig {
    const e = this._endpoints;
    const cfg: PublicAuthConfig = {
      enabled: this.enabled,
      issuer: this.issuer,
      clientId: this.clientId,
      loginClientId: this.loginClientId || this.clientId,
      redirectUri: this.redirectUri,
      scopes: this.scopes,
      authorizationEndpoint: e?.authorization_endpoint || `${this.issuer}/oauth2/auth`,
      tokenEndpoint: e?.token_endpoint || `${this.issuer}/oauth2/token`,
      idpAvailable: !!e,
    };
    if (!e) cfg.idpError = this._discoverError || '未拉取到发现文档';
    return cfg;
  }

  async discover(): Promise<IdpEndpoints> {
    if (this._endpoints) return this._endpoints;
    if (!this.enabled) throw Object.assign(new Error('统一登录未启用'), { code: 'disabled' });
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const doc = (await this._fetchJson(url, { method: 'GET' })) as IdpEndpoints | null;
    if (!doc || !doc.token_endpoint) {
      throw Object.assign(new Error('发现文档不完整'), { code: 'bad_discovery' });
    }
    this._endpoints = doc;
    return this._endpoints;
  }

  async _fetchJson(
    urlStr: string,
    { method = 'GET', headers = {}, body = null }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    const http = await import('node:http');
    return new Promise((resolve, reject) => {
      let u: URL;
      try { u = new URL(urlStr); } catch { reject(new Error(`非法地址: ${urlStr}`)); return; }
      const payload = body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: this.httpTimeoutMs,
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* 非 JSON 就当原文 */ }
          resolve(json || raw);
        });
      });
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ==================== 身份 ====================

  /**
   * 用**授权码 + PKCE verifier** 换身份。
   *
   * 与 mn-rt 的 server/src/auth.js 同构：换码这件事在**服务端**做，
   * 认证中心那张 access_token / refresh_token 一次都不出服务端 ——
   * 客户端拿到的是本服务自己签的凭据。
   *
   * ⚠️ 换码用的 client_id 必须是 **client 半的身份**（loginClientId），
   * 不是 server 半那个：授权码是在铸码那一步按 client_id 绑定的，
   * 换的时候必须用同一个 id，否则认证中心直接判 invalid_grant。
   *
   * 之所以要「服务端换码」而不是「客户端换码再把 access_token 送回来」：
   * 后者会让一枚指向整个平台身份的高价值凭据流经手机 —— 截获即账号接管。
   */
  async exchange({ code, codeVerifier, redirectUri }: { code: string; codeVerifier: string; redirectUri?: string }): Promise<{
    userId: string; sub: string; email: string; name: string; preferredUsername: string;
  }> {
    if (!this.enabled) throw Object.assign(new Error('统一登录未启用'), { code: 'disabled' });
    if (!code || !codeVerifier) throw Object.assign(new Error('缺少 code / codeVerifier'), { code: 'bad_request' });

    const doc = await this.discover();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.loginClientId || this.clientId,
      redirect_uri: redirectUri || this.redirectUri,
      code_verifier: codeVerifier,
    });

    const tok = (await this._fetchJson(doc.token_endpoint || `${this.issuer}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })) as Record<string, unknown> | null;

    if (!tok || tok.error) {
      const err = tok && tok.error ? String(tok.error) : 'unknown';
      const desc = tok && tok.error_description ? String(tok.error_description) : '';
      throw Object.assign(new Error(`换 token 被拒: ${err} ${desc}`.trim()), { code: err });
    }
    if (!tok.access_token) throw Object.assign(new Error('令牌响应缺少 access_token'), { code: 'no_access_token' });

    // 让认证中心自己断言身份。用完即弃：这枚 access_token 不进任何存储。
    const ui = (await this._fetchJson(doc.userinfo_endpoint || `${this.issuer}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    })) as Record<string, unknown> | null;
    if (!ui || !ui.sub) throw Object.assign(new Error('userinfo 未返回 sub'), { code: 'no_sub' });

    return {
      userId: String(ui.sub),
      sub: String(ui.sub),
      email: ui.email ? String(ui.email) : '',
      name: ui.name ? String(ui.name) : '',
      preferredUsername: ui.preferred_username ? String(ui.preferred_username) : '',
    };
  }

  /**
   * 校验一枚**认证中心**的 access_token，返回身份。
   *
   * 与 mn-rt 的分工一致：exchange 是"我有 code，服务器你帮我换"，
   * verifyBearer 是"我有 token，服务器你帮我确认是谁"。两条路最终都收敛到
   * 同一个结论——认证中心自己断言的 sub，所以属主判定只有一份实现。
   */
  async verifyBearer(accessToken: string): Promise<{
    userId: string; sub: string; email: string; name: string; preferredUsername: string;
  }> {
    if (!accessToken) throw Object.assign(new Error('缺少 access_token'), { code: 'bad_request' });
    const doc = await this.discover();
    const ui = (await this._fetchJson(doc.userinfo_endpoint || `${this.issuer}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })) as Record<string, unknown> | null;
    const obj = (ui || {}) as Record<string, unknown>;
    if (!ui || obj.error) {
      throw Object.assign(new Error(`令牌无效: ${obj.error ? String(obj.error) : '无 sub'}`),
        { code: (obj.error as string) || 'invalid_token' });
    }
    if (!obj.sub) throw Object.assign(new Error('userinfo 未返回 sub'), { code: 'no_sub' });
    return {
      userId: String(obj.sub),
      sub: String(obj.sub),
      email: obj.email ? String(obj.email) : '',
      name: obj.name ? String(obj.name) : '',
      preferredUsername: obj.preferred_username ? String(obj.preferred_username) : '',
    };
  }

  // ==================== 设备令牌 ====================

  /** 签发设备令牌。HS256 JWT，payload 带 userId 与 clientId。 */
  issueDeviceToken({ userId, clientId, deviceName }: { userId: string; clientId: string; deviceName?: string }): {
    token: string; expiresAt: number; jti: string;
  } {
    if (!this.jwtSecret) {
      throw Object.assign(new Error('未配置 MN_WS_JWT_SECRET'), { code: 'no_secret' });
    }
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: DeviceTokenPayload = {
      sub: userId,
      cid: clientId,
      dn: deviceName || '',
      iat: now,
      exp: now + DEVICE_TOKEN_TTL_SEC,
      // jti 让单枚令牌可被单独吊销
      jti: crypto.randomBytes(9).toString('hex'),
    };
    const head = b64urlJson(header);
    const body = b64urlJson(payload);
    const sig = b64url(crypto.createHmac('sha256', this.jwtSecret).update(`${head}.${body}`).digest());
    return {
      token: `${head}.${body}.${sig}`,
      expiresAt: payload.exp * 1000,
      jti: payload.jti,
    };
  }

  /** 校验设备令牌。返回 payload 或 null。 */
  verifyDeviceToken(token: string): DeviceTokenPayload | null {
    if (!this.jwtSecret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    if (head === undefined || body === undefined || sig === undefined) return null;
    const want = b64url(crypto.createHmac('sha256', this.jwtSecret).update(`${head}.${body}`).digest());
    // 常量时间比较：这里比的是"能不能冒充某个用户的一台桥"
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload: DeviceTokenPayload;
    try { payload = JSON.parse(fromB64url(body).toString('utf8')) as DeviceTokenPayload; } catch { return null; }
    if (!payload || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    if (this._isRevoked(payload.jti)) return null;
    return payload;
  }

  /** 吊销某枚令牌。名单落盘 —— 否则重启即"全部恢复"，而吊销往往正是因为设备丢了。 */
  revoke(jti: string): void {
    if (!jti) return;
    this.revoked.set(jti, Date.now() + DEVICE_TOKEN_TTL_SEC * 1000);
    this._saveDevices();
  }

  private _isRevoked(jti: string): boolean {
    if (!this.revoked || !jti) return false;
    const until = this.revoked.get(jti);
    if (!until) return false;
    if (until < Date.now()) { this.revoked.delete(jti); return false; }
    return true;
  }

  // ==================== 设备登记 ====================

  /** 登记一台桥（client half）：clientId → 属主。永久一对一。 */
  registerDevice({ clientId, userId, deviceName }: { clientId: string; userId: string; deviceName?: string }): DeviceRecord {
    if (!clientId) throw Object.assign(new Error('缺少 clientId'), { code: 'bad_request' });
    const existing = this.devices.get(clientId);
    if (existing && existing.userId !== userId) {
      throw Object.assign(new Error('该标识已属于别的账号'), { code: 'device_owned_by_other' });
    }
    const rec: DeviceRecord = {
      userId,
      clientId,
      deviceName: deviceName || (existing && existing.deviceName) || '',
      registeredAt: existing ? existing.registeredAt : new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.devices.set(clientId, rec);
    this._saveDevices();
    return rec;
  }

  getDevice(clientId: string): DeviceRecord | null {
    return this.devices.get(clientId) || null;
  }

  devicesOf(userId: string): DeviceRecord[] {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  // ==================== 落盘 ====================

  private _devicesFile(): string | null {
    return this.dataDir ? path.join(this.dataDir, 'devices.json') : null;
  }

  private _loadDevices(): void {
    const f = this._devicesFile();
    if (!f) return;
    try {
      if (!fs.existsSync(f)) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as {
        devices?: Record<string, DeviceRecord>;
        revoked?: Record<string, number>;
      };
      this.devices = new Map(Object.entries(raw.devices || {}));
      this.revoked = new Map(Object.entries(raw.revoked || {}));
    } catch {
      this.devices = new Map();
      this.revoked = new Map();
    }
  }

  private _saveDevices(): void {
    const f = this._devicesFile();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        devices: Object.fromEntries(this.devices),
        revoked: Object.fromEntries(this.revoked),
      }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch { /* 落盘失败不阻断主流程 */ }
  }
}
