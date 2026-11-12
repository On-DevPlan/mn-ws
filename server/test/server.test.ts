// server 半的端到端测试：真起 HTTP+WS 服务，用真的 WS 客户端打穿。
//
// 验的是**跨进程契约**：帧格式、路由、鉴权、属主、多路复用。
// 协议层的纯函数在 protocol.test.ts；这里验的是「两端对上」。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';

import { createServer } from '../src/server.js';
import { FRAME, encodeFrame, decodeFrame, nextRequestId, normalizeHeaders, stripRequestHeaders, stripResponseHeaders, flattenHeaders } from '../src/protocol.js';

/** 起一个假 nx 服务（client 半要打的那个目标）。 */
async function startFakeNx(): Promise<{ port: number; close: () => Promise<void>; seen: { method: string; url: string; headers: Record<string, string[]> }[] }> {
  const seen: { method: string; url: string; headers: Record<string, string[]> }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method || '', url: req.url || '', headers: normalizeHeaders(req.headers) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-fake-nx': 'yes' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise((r) => server.close(() => r())),
    seen,
  };
}

/** 一个最小桥客户端：注册 + 收发帧。 */
class FakeBridge {
  ws: WebSocket | null = null;
  pending = new Map<string, (frame: Record<string, unknown>) => void>();
  registered: Promise<Record<string, unknown>>;

  constructor(private url: string, private token: string, private apps: { app: string; base: string; title?: string }[]) {
    this.registered = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('注册超时')), 5000);
      ws.on('open', () => {
        ws.send(encodeFrame({
          type: FRAME.REGISTER,
          role: 'bridge',
          bridgeId: 'test-bridge',
          apps: this.apps.map((a) => ({
            app: a.app,
            base: a.base,
            ...(a.title ? { title: a.title } : {}),
          })),
          token,
        }));
      });
      ws.on('message', (raw: unknown) => {
        const msg = decodeFrame(raw);
        if (!msg) return;
        if (msg.type === FRAME.REGISTERED) {
          clearTimeout(timer);
          resolve(msg as Record<string, unknown>);
          return;
        }
        if (msg.type === FRAME.REQUEST) {
          // 假 nx：直接把请求打过去再回帧
          const id = String(msg.id || '');
          void this.handleRequest(msg as Record<string, unknown>);
          void id;
        }
      });
      ws.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  }

  private async handleRequest(frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id || '');
    const base = this.apps.find((a) => a.app === frame.app)?.base;
    if (!base) return;
    const u = new URL(base);
    // 与真实 client 半（client/src/core/bridge.ts）同款：剥掉不能转发的头、
    // 拼回 query、content-length 自己算。这一步不能省 ——
    // 假桥若不剥，L1 门禁头就会「看起来」泄给了目标服务。
    const headers = flattenHeaders(stripRequestHeaders(normalizeHeaders((frame.headers || {}) as Record<string, string | string[]>)));
    delete headers['content-length'];
    const body = Buffer.from(String(frame.body || ''), 'base64');
    if (body.length) headers['content-length'] = String(body.length);
    const query = frame.query && typeof frame.query === 'object'
      ? new URLSearchParams(frame.query as Record<string, string>).toString()
      : '';
    const path = String(frame.path || '/') + (query ? `?${query}` : '');
    const req = http.request({
      hostname: u.hostname, port: u.port, method: String(frame.method || 'GET'),
      path, headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        this.ws?.send(encodeFrame({
          type: FRAME.RESPONSE,
          id,
          status: res.statusCode || 0,
          headers: normalizeHeaders(res.headers),
          body: buf.toString('base64'),
        }));
      });
    });
    req.end();
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

test('端到端：请求穿过 WS 到达本机应用，响应原样回来', async () => {
  const nx = await startFakeNx();
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-test', base: `http://127.0.0.1:${nx.port}` },
  ]);
  await bridge.registered;

  const res = await httpGet(`http://127.0.0.1:${port}/nx-test/api/echo?a=1`, { 'x-mn-ws-token': 'gate-token' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-fake-nx'], 'yes');
  assert.equal(JSON.parse(res.body).url, '/api/echo?a=1');

  bridge.close();
  await server.close();
  await nx.close();
});

test('端到端：L1 门禁头不进本机应用（那是桥的内部事务）', async () => {
  const nx = await startFakeNx();
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-test', base: `http://127.0.0.1:${nx.port}` },
  ]);
  await bridge.registered;

  await httpGet(`http://127.0.0.1:${port}/nx-test/api/echo`, { 'x-mn-ws-token': 'gate-token' });
  const seen = nx.seen[nx.seen.length - 1]!;
  assert.equal('x-mn-ws-token' in seen.headers, false);
  assert.equal('origin' in seen.headers, false);

  bridge.close();
  await server.close();
  await nx.close();
});

test('端到端：无 L1 凭据 → 401；未知应用 → 404', async () => {
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();

  const noAuth = await httpGet(`http://127.0.0.1:${port}/nx-test/api/echo`);
  assert.equal(noAuth.status, 401);

  const unknown = await httpGet(`http://127.0.0.1:${port}/no-such-app/api/x`, { 'x-mn-ws-token': 'gate-token' });
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(unknown.body).error, 'unknown_app');

  await server.close();
});

test('动态注册的应用：标题原样进目录，且能被 X-Nx-App 命中', async () => {
  const nx = await startFakeNx();
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();
  // 客户端自报标题（动态注册的应用没有已知表可查，标题是唯一线索）
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'my-api', base: `http://127.0.0.1:${nx.port}`, title: '我的服务' },
  ]);
  await bridge.registered;

  // ① 目录里能看到它，标题是客户端自报的那个
  const cat = await httpGet(`http://127.0.0.1:${port}/api/catalog`, { 'x-mn-ws-token': 'gate-token' });
  const j = JSON.parse(cat.body);
  assert.equal(j.count, 1);
  assert.equal(j.apps[0].app, 'my-api');
  assert.equal(j.apps[0].title, '我的服务');
  assert.equal(j.apps[0].port, nx.port);

  // ② 远端用请求头命中它
  const viaHeader = await httpGet(`http://127.0.0.1:${port}/api/ping`, {
    'x-mn-ws-token': 'gate-token',
    'x-nx-app': 'my-api',
  });
  assert.equal(viaHeader.status, 200, viaHeader.body);
  assert.equal(JSON.parse(viaHeader.body).url, '/api/ping');

  // ③ 路径前缀也命中它
  const viaPath = await httpGet(`http://127.0.0.1:${port}/my-api/api/ping`, { 'x-mn-ws-token': 'gate-token' });
  assert.equal(viaPath.status, 200, viaPath.body);
  assert.equal(JSON.parse(viaPath.body).url, '/api/ping');

  bridge.close();
  await server.close();
  await nx.close();
});

test('元信息目录：只列出本桥注册的应用', async () => {  const nx = await startFakeNx();
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-test', base: `http://127.0.0.1:${nx.port}` },
  ]);
  await bridge.registered;

  const res = await httpGet(`http://127.0.0.1:${port}/api/catalog`, { 'x-mn-ws-token': 'gate-token' });
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.ok, true);
  assert.equal(j.count, 1);
  assert.equal(j.apps[0].app, 'nx-test');

  bridge.close();
  await server.close();
  await nx.close();
});

test('两端身份：server 发布 clientId 与 loginClientId 两个身份', async () => {
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token',
    idpClientId: 'mn-ws-server', loginClientId: 'mn-ws-client',
    dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();
  const res = await httpGet(`http://127.0.0.1:${port}/auth/oidc/config`);
  const j = JSON.parse(res.body);
  assert.equal(j.clientId, 'mn-ws-server');
  assert.equal(j.loginClientId, 'mn-ws-client');
  await server.close();
});

test('设备令牌：签发 → 校验 → 属主绑定', async () => {
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token',
    jwtSecret: 'test-secret', authEnabled: true,
    dataDir: null, logLevel: 'error',
  });
  const issued = server.auth.issueDeviceToken({ userId: 'u1', clientId: 'dev1', deviceName: '我的机器' });
  const payload = server.auth.verifyDeviceToken(issued.token);
  assert.ok(payload);
  assert.equal(payload!.sub, 'u1');
  assert.equal(payload!.cid, 'dev1');

  // 换绑保护：一台 clientId 只能属一个用户
  server.auth.registerDevice({ clientId: 'dev1', userId: 'u1' });
  assert.throws(() => server.auth.registerDevice({ clientId: 'dev1', userId: 'u2' }), /属于别的账号/);

  // 吊销
  server.auth.revoke(issued.jti);
  assert.equal(server.auth.verifyDeviceToken(issued.token), null);

  await server.close();
});

test('属主隔离：别人的桥访问不到', async () => {
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token',
    jwtSecret: 'test-secret', authEnabled: true,
    dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();
  // 用 u1 的设备令牌注册一座桥
  const issued = server.auth.issueDeviceToken({ userId: 'u1', clientId: 'dev1' });
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, issued.token, [
    { app: 'nx-test', base: 'http://127.0.0.1:1' },
  ]);
  await bridge.registered;

  // u2 的令牌访问 u1 的桥 → 403
  const other = server.auth.issueDeviceToken({ userId: 'u2', clientId: 'dev2' });
  const res = await httpGet(`http://127.0.0.1:${port}/nx-test/api/echo`, { 'x-mn-ws-token': other.token });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden');

  bridge.close();
  await server.close();
});
