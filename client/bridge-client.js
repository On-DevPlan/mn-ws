'use strict';

/**
 * 桥接客户端的**请求还原器**：把 server 半发来的帧还原成一次真正的 HTTP 请求，
 * 打给本机的 nx 服务，再把响应封回帧。
 *
 * ## 为什么要「还原」而不是「转发」
 *
 * server 半拿到的是一段 HTTP 报文的**内容**（method / path / query / headers /
 * body），不是一条活的 socket。所以这一侧必须**造一个请求**出来 ——
 * 于是「哪些头能带过去」就全靠这里的规则决定，而规则错了症状都很隐蔽：
 *
 *   · 带上 Origin → nx-kv 的跨站防护 403（直连好好的，走桥就 403）
 *   · 带上 Connection / Transfer-Encoding → 新连接自己会重算，带过去就是错的
 *   · 带上 content-length → body 经 base64 往返后长度可能变了，对不上就挂死
 *
 * 所以：**hop-by-hop 头 + Origin 全部剥掉，content-length 自己算。**
 */

const http = require('node:http');
const https = require('node:https');

const {
  FRAME, encodeFrame, normalizeHeaders, stripRequestHeaders, flattenHeaders,
  MAX_BODY_BYTES,
} = require('../lib/protocol');

class BridgeClient {
  /**
   * @param {object} opts
   * @param {object} opts.apps      { app -> base }（base 形如 http://127.0.0.1:7877）
   * @param {object} [opts.logger]
   * @param {(frame: object) => void} opts.send  把帧发回 server 半
   */
  constructor({ apps = {}, logger = null, send }) {
    this.apps = apps;
    this.logger = logger;
    this.send = send;
    /** requestId -> {req, res} 本地在跑的请求 */
    this.inflight = new Map();
  }

  /** 处理一个 request 帧。 */
  async handleRequest(frame) {
    const id = String(frame.id || '');
    const app = String(frame.app || '');
    const base = this.apps[app];
    if (!base) {
      this._respondError(id, 'unknown_app', `未注册应用 ${app}`);
      return;
    }

    let url;
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

    let body;
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
    const headers = flattenHeaders(stripRequestHeaders(normalizeHeaders(frame.headers)));
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
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
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
        if (this.logger) {
          this.logger.debug('bridged', { app, path: targetPath, status: res.statusCode, bytes: buf.length });
        }
      });
    });

    this.inflight.set(id, req);

    req.on('timeout', () => { req.destroy(new Error('本机请求超时')); });
    req.on('error', (e) => {
      this.inflight.delete(id);
      this._respondError(id, e.code || 'request_failed', e.message);
    });

    if (body.length > 0) req.write(body);
    req.end();
  }

  /** 中断一个在跑的请求（server 侧 HTTP 客户端断开了）。 */
  abort(id) {
    const req = this.inflight.get(String(id));
    if (!req) return false;
    this.inflight.delete(String(id));
    try { req.destroy(); } catch { /* ignore */ }
    return true;
  }

  /** 断开时把所有在跑的请求收掉。 */
  abortAll() {
    for (const [, req] of this.inflight) {
      try { req.destroy(); } catch { /* ignore */ }
    }
    this.inflight.clear();
  }

  _respondError(id, code, message) {
    this.send({
      type: FRAME.ERROR,
      id,
      code,
      error: String(message || code),
    });
  }
}

module.exports = { BridgeClient };
