'use strict';

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

const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/** 设备令牌有效期（秒）。默认 90 天 —— 桥接是公网暴露面，令牌不宜过长。 */
const DEVICE_TOKEN_TTL_SEC = 90 * 24 * 3600;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function fromB64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

class AuthHub {
  constructor(opts = {}) {
    this.enabled = opts.enabled === true;
    this.issuer = opts.issuer || '';
    this.clientId = opts.clientId || '';
    // client 半的身份：真正发起授权码流程的是它（mn-ws-client）。
    // 与 clientId 分开登记，是为了让 go-ah 侧能**分端审计、分端吊销** ——
    // client_id 是审计与吊销的单元，共用一个之后「哪个平台在发 token」
    // 「要停哪条接入」都问不出来。
    this.loginClientId = opts.loginClientId || '';
    this.redirectUri = opts.redirectUri || '';
    this.scopes = opts.scopes || ['openid', 'profile', 'email'];
    this.jwtSecret = opts.jwtSecret || '';
    this.httpTimeoutMs = opts.httpTimeoutMs || 10_000;
    this.dataDir = opts.dataDir || null;

    /** 发现文档缓存。只有成功才固化——失败若被记住，容器编排下
     *  "本服务先于认证中心启动" 会让统一登录永久不可用直到重启。 */
    this._endpoints = null;

    /** clientId -> {userId, deviceName, registeredAt, lastSeenAt} */
    this.devices = new Map();
    /** jti -> 过期时间戳（吊销名单） */
    this.revoked = new Map();
    this._loadDevices();
  }

  // ==================== 配置与发现 ====================

  /** 下发给客户端的公开参数。**绝不含任何 secret**。 */
  publicConfig() {
    const e = this._endpoints;
    return {
      enabled: this.enabled,
      issuer: this.issuer,
      clientId: this.clientId,
      // client 半登录时该用的 client_id。空则回落 clientId（老的 server）。
      loginClientId: this.loginClientId || this.clientId,
      redirectUri: this.redirectUri,
      scopes: this.scopes,
      authorizationEndpoint: e ? e.authorization_endpoint : `${this.issuer}/oauth2/auth`,
      tokenEndpoint: e ? e.token_endpoint : `${this.issuer}/oauth2/token`,
      idpAvailable: !!e,
      ...(e ? {} : { idpError: this._discoverError || '未拉取到发现文档' }),
    };
  }

  async discover() {
    if (this._endpoints) return this._endpoints;
    if (!this.enabled) throw Object.assign(new Error('统一登录未启用'), { code: 'disabled' });
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const doc = await this._fetchJson(url, { method: 'GET' });
    if (!doc || !doc.token_endpoint) {
      throw Object.assign(new Error('发现文档不完整'), { code: 'bad_discovery' });
    }
    this._endpoints = doc;
    return doc;
  }

  async _fetchJson(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
      let u;
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
          let json = null;
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
   * 校验一枚**认证中心**的 access_token，返回身份。
   *
   * 与 mn-rt 的分工一致：exchange 是"我有 code，服务器你帮我换"，
   * verifyBearer 是"我有 token，服务器你帮我确认是谁"。两条路最终都收敛到
   * 同一个结论——认证中心自己断言的 sub，所以属主判定只有一份实现。
   */
  async verifyBearer(accessToken) {
    if (!accessToken) throw Object.assign(new Error('缺少 access_token'), { code: 'bad_request' });
    const doc = await this.discover();
    const ui = await this._fetchJson(doc.userinfo_endpoint || `${this.issuer}/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ui || ui.error) {
      throw Object.assign(new Error(`令牌无效: ${ui && ui.error ? ui.error : '无 sub'}`),
        { code: (ui && ui.error) || 'invalid_token' });
    }
    if (!ui.sub) throw Object.assign(new Error('userinfo 未返回 sub'), { code: 'no_sub' });
    return {
      userId: String(ui.sub),
      sub: String(ui.sub),
      email: ui.email || '',
      name: ui.name || '',
      preferredUsername: ui.preferred_username || '',
    };
  }

  // ==================== 设备令牌 ====================

  /** 签发设备令牌。HS256 JWT，payload 带 userId 与 clientId。 */
  issueDeviceToken({ userId, clientId, deviceName }) {
    if (!this.jwtSecret) {
      throw Object.assign(new Error('未配置 MN_WS_JWT_SECRET'), { code: 'no_secret' });
    }
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
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
      expiresAt: (now + DEVICE_TOKEN_TTL_SEC) * 1000,
      jti: payload.jti,
    };
  }

  /** 校验设备令牌。返回 payload 或 null。 */
  verifyDeviceToken(token) {
    if (!this.jwtSecret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    const want = b64url(crypto.createHmac('sha256', this.jwtSecret).update(`${head}.${body}`).digest());
    // 常量时间比较：这里比的是"能不能冒充某个用户的一台桥"
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
    if (!payload || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) return null;
    if (this._isRevoked(payload.jti)) return null;
    return payload;
  }

  /** 吊销某枚令牌。名单落盘 —— 否则重启即"全部恢复"，而吊销往往正是因为设备丢了。 */
  revoke(jti) {
    if (!jti) return;
    this.revoked.set(jti, Date.now() + DEVICE_TOKEN_TTL_SEC * 1000);
    this._saveDevices();
  }

  _isRevoked(jti) {
    if (!this.revoked || !jti) return false;
    const until = this.revoked.get(jti);
    if (!until) return false;
    if (until < Date.now()) { this.revoked.delete(jti); return false; }
    return true;
  }

  // ==================== 设备登记 ====================

  /** 登记一台桥（client half）：clientId → 属主。永久一对一。 */
  registerDevice({ clientId, userId, deviceName }) {
    if (!clientId) throw Object.assign(new Error('缺少 clientId'), { code: 'bad_request' });
    const existing = this.devices.get(clientId);
    if (existing && existing.userId !== userId) {
      throw Object.assign(new Error('该标识已属于别的账号'), { code: 'device_owned_by_other' });
    }
    const rec = {
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

  getDevice(clientId) {
    return this.devices.get(clientId) || null;
  }

  devicesOf(userId) {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  // ==================== 落盘 ====================

  _devicesFile() {
    return this.dataDir ? path.join(this.dataDir, 'devices.json') : null;
  }

  _loadDevices() {
    const f = this._devicesFile();
    if (!f) return;
    try {
      if (!fs.existsSync(f)) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      this.devices = new Map(Object.entries(raw.devices || {}));
      this.revoked = new Map(Object.entries(raw.revoked || {}));
    } catch {
      this.devices = new Map();
      this.revoked = new Map();
    }
  }

  _saveDevices() {
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

module.exports = { AuthHub, DEVICE_TOKEN_TTL_SEC, b64url, fromB64url };
