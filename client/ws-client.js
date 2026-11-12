'use strict';

/**
 * 桥接客户端的**连接器**：连 server 半、注册、重连、重注册。
 *
 * 与 mn-rt 的 client/lib/ws-client.js 同款骨架：指数退避重连 + 状态回调。
 * 差别在**注册内容**：mn-rt 注册的是"我是一台 PC"，
 * mn-ws 注册的是"我是一台桥，能桥这些 app"。
 */

const WebSocket = require('ws');

const { FRAME, encodeFrame, decodeFrame } = require('../lib/protocol');
const { describeApp } = require('../lib/apps');
const { BridgeClient } = require('./bridge-client');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

class WsBridgeClient {
  /**
   * @param {object} opts
   * @param {string} opts.url        server 半的 ws:// 地址
   * @param {string} [opts.token]    注册令牌（设备令牌或静态门禁）
   * @param {string} [opts.bridgeId]
   * @param {object} opts.apps       { app -> base }
   * @param {object} [opts.logger]
   * @param {(s: object) => void} [opts.onStatus]
   */
  constructor({ url, token = '', bridgeId = '', apps = {}, logger = null, onStatus = null }) {
    this.url = url;
    this.token = token;
    this.bridgeId = bridgeId;
    this.apps = apps;
    this.logger = logger;
    this.onStatus = onStatus || (() => {});

    this.ws = null;
    this.stopped = false;
    this.attempts = 0;
    this.timer = null;
    this.state = 'idle';

    this.bridge = new BridgeClient({
      apps,
      logger,
      send: (frame) => this._send(frame),
    });
  }

  _send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(encodeFrame(frame));
      return true;
    } catch (e) {
      if (this.logger) this.logger.warn('发送帧失败', { error: e.message });
      return false;
    }
  }

  _setState(state, extra) {
    this.state = state;
    this.onStatus({ state, ...(extra || {}) });
  }

  /** 连上并注册。 */
  start() {
    this.stopped = false;
    this._connect();
  }

  /** 断开并停止重连。 */
  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.bridge.abortAll();
    if (this.ws) {
      try { this.ws.close(1000, 'client stopped'); } catch { /* ignore */ }
      this.ws = null;
    }
    this._setState('stopped');
  }

  _connect() {
    if (this.stopped) return;
    this._setState('connecting');

    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15_000 });
    } catch (e) {
      this._scheduleReconnect(`连接失败：${e.message}`);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this._setState('connected');
      // 注册：带上 app 表 + 每个 app 的元信息（标题、端口），
      // server 半据此汇总成**元信息目录**，远端客户端登录后先拉目录、
      // 看清楚「哪些能路由」再选。
      const apps = Object.entries(this.apps).map(([app, base]) => describeApp(app, base));
      this._send({
        type: FRAME.REGISTER,
        role: 'bridge',
        bridgeId: this.bridgeId,
        apps,
        token: this.token,
      });
      if (this.logger) {
        this.logger.info('已连上 server，注册桥接应用', { apps: apps.map((a) => a.app) });
      }
    });

    ws.on('message', (raw) => {
      const msg = decodeFrame(raw);
      if (!msg) {
        if (this.logger) this.logger.warn('收到非法帧');
        return;
      }
      this._onFrame(msg);
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      this.bridge.abortAll();
      if (this.stopped) { this._setState('stopped'); return; }
      this._scheduleReconnect(`连接断开（${code}${reason ? ` ${reason}` : ''}）`);
    });

    ws.on('error', (e) => {
      if (this.logger) this.logger.warn('socket 错误', { error: e && e.message });
      // close 事件会随后到达，重连逻辑挂在 close 上，这里不重复处理
    });
  }

  _onFrame(msg) {
    switch (msg.type) {
      case FRAME.WELCOME:
        if (this.logger) this.logger.info('收到 welcome', { peerId: msg.peerId });
        break;
      case FRAME.REGISTERED:
        this._setState('registered', { apps: msg.apps || [], replaced: msg.replaced || [] });
        if (this.logger) {
          this.logger.info('注册成功', { apps: msg.apps, replaced: msg.replaced });
        }
        break;
      case FRAME.REQUEST:
        this.bridge.handleRequest(msg).catch((e) => {
          this.bridge._respondError(String(msg.id || ''), 'handle_failed', e.message);
        });
        break;
      case FRAME.ABORT:
        this.bridge.abort(String(msg.id || ''));
        break;
      case FRAME.PING:
        this._send({ type: FRAME.PONG });
        break;
      case FRAME.SHUTDOWN:
        if (this.logger) this.logger.warn('服务端要求下线', { reason: msg.reason });
        this._setState('shutdown');
        break;
      case FRAME.ERROR:
        if (this.logger) this.logger.warn('服务端报错', { error: msg.error, detail: msg.detail });
        this._setState('error', { error: msg.error });
        break;
      default:
        break;
    }
  }

  /** 指数退避重连：1s → 2s → 4s … 封顶 30s。 */
  _scheduleReconnect(reason) {
    if (this.stopped) return;
    if (this.timer) return;
    const delay = Math.min(RECONNECT_BASE_MS * (2 ** this.attempts), RECONNECT_MAX_MS);
    this.attempts += 1;
    this._setState('reconnecting', { reason, retryInMs: delay });
    if (this.logger) {
      this.logger.warn('准备重连', { reason, delayMs: delay, attempt: this.attempts });
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this._connect();
    }, delay);
  }
}

module.exports = { WsBridgeClient };
