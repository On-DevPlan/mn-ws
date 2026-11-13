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

  constructor(
    private url: string,
    private token: string,
    private apps: { app: string; base: string; title?: string }[],
    /** 这台 PC 的标识（多台 PC 同时接入时各用各的） */
    private bridgeId = 'test-bridge',
    /** 电脑名（注册时自报，目录里按它分组） */
    private pcName = '',
  ) {
    this.registered = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('注册超时')), 5000);
      ws.on('open', () => {
        ws.send(encodeFrame({
          type: FRAME.REGISTER,
          role: 'bridge',
          bridgeId: this.bridgeId,
          ...(this.pcName ? { name: this.pcName } : {}),
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

function httpPost(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const raw = JSON.stringify(payload);
    const req = http.request({
      method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), ...headers },
      timeout: 8000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

/**
 * 起一个最小假认证中心：发现文档 + token 端点 + userinfo。
 *
 * 为什么打桩而不是直连线上认证中心：线上那条真链路需要一个能登录的账号，
 * 而 CI 里不该存生产口令。这里覆盖的是**本服务这一段实现的正确性**
 * （表单字段名、用 client 半的身份、不带 secret、用完即弃、拿 sub 当属主）；
 * 与真实认证中心的互操作由公网远端验收覆盖。
 */
async function startFakeIdp({ expectVerifier }: { expectVerifier?: string } = {}): Promise<{
  hits: { token: number; userinfo: number; lastTokenForm: Record<string, string> | null; lastAuth: string };
  issuer: string;
  close: () => Promise<void>;
}> {
  const hits: { token: number; userinfo: number; lastTokenForm: Record<string, string> | null; lastAuth: string } =
    { token: 0, userinfo: 0, lastTokenForm: null, lastAuth: '' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const send = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/.well-known/openid-configuration') {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return send(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/auth`,
        token_endpoint: `${base}/oauth2/token`,
        userinfo_endpoint: `${base}/oauth2/userinfo`,
      });
    }
    if (u.pathname === '/oauth2/token') {
      hits.token += 1;
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        hits.lastTokenForm = form;
        if (expectVerifier && form.code_verifier !== expectVerifier) {
          return send(400, { error: 'invalid_grant' });
        }
        send(200, { access_token: 'IDP-AT-1', refresh_token: 'IDP-RT-SECRET', token_type: 'Bearer' });
      });
      return undefined;
    }
    if (u.pathname === '/oauth2/userinfo') {
      hits.userinfo += 1;
      hits.lastAuth = req.headers.authorization || '';
      if (hits.lastAuth !== 'Bearer IDP-AT-1') return send(401, { error: 'invalid_token' });
      return send(200, { sub: 'sub-777', email: 'p@x.io', name: '跑批', preferred_username: 'pao' });
    }
    return send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    hits,
    issuer: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    // ⚠️ 必须显式掐掉 keep-alive 连接：Node 19+ 的全局 agent 默认 keepAlive，
    // 而 server.close() 会**等这些空闲连接自己结束**才回调 —— 套件会挂死。
    // 这正是 K30 那个坑在测试里的翻版。
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

test('业务令牌端点：授权码换到本服务令牌，认证中心的凭据一个字节都不外流', async () => {
  const verifier = 'a-test-verifier-value-0123456789abcdef';
  const idp = await startFakeIdp({ expectVerifier: verifier });
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token',
    issuer: idp.issuer, idpClientId: 'mn-ws-server', loginClientId: 'mn-ws-client',
    redirectUri: 'http://127.0.0.1:39471/callback',
    jwtSecret: 'cb-test-secret', authEnabled: true,
    dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();

  try {
    const res = await httpPost(`http://127.0.0.1:${port}/auth/oidc/callback`, {
      code: 'CODE-1',
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:39471/callback',
    });
    assert.equal(res.status, 200, res.body);
    const j = JSON.parse(res.body);
    assert.equal(j.ok, true);
    // 属主必须是认证中心自己断言的 sub
    assert.equal(j.userId, 'sub-777');
    assert.ok(j.token, '应回本服务的令牌');
    assert.ok(j.tokenExpiresAt, '应回本服务令牌的到期时间');

    // 换码用的身份必须是 **client 半的**：授权码按 client_id 绑定，
    // 换的时候用别的 id 会被认证中心判 invalid_grant
    assert.equal(idp.hits.lastTokenForm?.client_id, 'mn-ws-client');
    assert.equal(idp.hits.lastTokenForm?.code_verifier, verifier);
    assert.ok(!('client_secret' in (idp.hits.lastTokenForm || {})), '公共客户端不得发 client_secret');

    // 关键隐私断言：认证中心的 refresh_token / access_token 绝不外流
    assert.ok(!res.body.includes('IDP-RT-SECRET'), 'refresh_token 不得出现在响应里');
    assert.ok(!res.body.includes('IDP-AT-1'), 'access_token 不得回带给客户端');
    // 设备注册表里也不能落认证中心的凭据
    const persisted = JSON.stringify(server.auth.devices);
    assert.ok(!persisted.includes('IDP-RT-SECRET') && !persisted.includes('IDP-AT-1'),
      '设备注册表不得存认证中心的凭据');

    // verifier 不匹配必须失败，且不得因此签出任何令牌
    const bad = await httpPost(`http://127.0.0.1:${port}/auth/oidc/callback`, {
      code: 'CODE-2', codeVerifier: 'WRONG', redirectUri: 'http://127.0.0.1:39471/callback',
    });
    assert.equal(bad.status, 401, `verifier 不匹配必须 401，实到 ${bad.status}`);
    assert.ok(!JSON.parse(bad.body).token, '失败路径不得发令牌');
  } finally {
    await server.close();
    await idp.close();
  }
});

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

test('动态注册的应用：标题原样进目录，且能被 X-Mn-Ws-App 命中', async () => {
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
    'x-mn-ws-app': 'my-api',
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

/** 轮询等待某个条件成立（WS 的 close 是异步到达服务端的，不能假设立刻生效）。 */
async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('等待超时');
}

test('心跳：正常连接扛过多轮心跳，不被误杀', async () => {
  // 这条测试防的是「服务端把 isAlive 复位那两行弄丢」这种错：
  // 症状是桥每 30 秒被踢一次、重连、再被踢 —— 线上表现为「刚连上就断」，
  // 而所有别的测试都会绿（连接死之前它们早就跑完了）。
  //
  // 所以这里把心跳调快（60ms），让连接连过 5 轮心跳再断言它还活着。
  const nx = await startFakeNx();
  const server = createServer({
    host: '127.0.0.1', port: 0, token: 'gate-token',
    heartbeatIntervalMs: 60,
    dataDir: null, logLevel: 'error',
  });
  const port = await server.listen();
  const bridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'my-api', base: `http://127.0.0.1:${nx.port}` },
  ]);
  await bridge.registered;

  try {
    // 连过 5 轮心跳
    await new Promise((r) => setTimeout(r, 320));
    const res = await httpGet(`http://127.0.0.1:${port}/my-api/api/ping`, { 'x-mn-ws-token': 'gate-token' });
    assert.equal(res.status, 200, `过了多轮心跳后连接应该还活着：${res.body}`);
  } finally {
    bridge.close();
    await server.close();
    await nx.close();
  }
});

test('多台 PC 同时接入：目录按 PC 分组，每台的应用都在自己组里', async () => {
  const nx = await startFakeNx();
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();

  // 两台 PC，各有各的应用；其中「nx-kv」两台都有（同名撞车）
  const pcA = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-kv', base: `http://127.0.0.1:${nx.port}` },
  ], 'pc-a', '办公室台式机');
  await pcA.registered;
  const pcB = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-kv', base: `http://127.0.0.1:${nx.port}` },
    { app: 'other-api', base: `http://127.0.0.1:${nx.port}` },
  ], 'pc-b', '家里笔记本');
  await pcB.registered;

  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/catalog`, { 'x-mn-ws-token': 'gate-token' });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);

    // 两台 PC 都在目录里，各自成一组
    assert.equal(j.pcCount, 2, `应有两台 PC：${JSON.stringify(j.pcs)}`);
    const names = j.pcs.map((g: { name: string }) => g.name).sort();
    assert.deepEqual(names, ['家里笔记本', '办公室台式机'].sort());

    // 组里的应用各归各位：同名 app 在两台 PC 下都在
    const byName = new Map<string, { app: string; active: boolean }[]>(
      j.pcs.map((g: { name: string; apps: { app: string; active: boolean }[] }) => [g.name, g.apps]),
    );
    const a = byName.get('办公室台式机')!;
    const b = byName.get('家里笔记本')!;
    assert.deepEqual(a.map((x: { app: string }) => x.app), ['nx-kv']);
    assert.deepEqual(b.map((x: { app: string }) => x.app).sort(), ['nx-kv', 'other-api']);

    // 撞名的那个：路由归后来者（PC-B），但**两台都标得清楚**
    assert.equal(a[0].active, false, '办公室台式机的 nx-kv 当前路由不到（被顶替了）');
    assert.equal(b.find((x: { app: string }) => x.app === 'nx-kv').active, true, '后来者接管路由');

    // 扁平列表仍在（老客户端靠它），且带上了电脑名
    assert.equal(j.count, 3);
    assert.ok(j.apps.every((a: { pcName: string }) => a.pcName));
  } finally {
    pcA.close();
    pcB.close();
    await server.close();
    await nx.close();
  }
});

test('X-Mn-Ws-Pc 头：指定打哪台 PC 的同名应用', async () => {
  const nx = await startFakeNx();
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();

  // 两台 PC 都提供 nx-kv，但基址不同 —— 打到哪台看请求头
  const pcA = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-kv', base: `http://127.0.0.1:${nx.port}` },
  ], 'pc-a', 'A 机');
  await pcA.registered;
  const pcB = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
    { app: 'nx-kv', base: `http://127.0.0.1:${nx.port}` },
  ], 'pc-b', 'B 机');
  await pcB.registered;

  try {
    // 不带头：按路由表（后来者接管 → B 机）
    const dflt = await httpGet(`http://127.0.0.1:${port}/nx-kv/api/ping`, { 'x-mn-ws-token': 'gate-token' });
    assert.equal(dflt.status, 200, dflt.body);

    // 指定 A 机：路由到 A 机的桥
    const onA = await httpGet(`http://127.0.0.1:${port}/nx-kv/api/ping`, {
      'x-mn-ws-token': 'gate-token', 'x-mn-ws-pc': 'pc-a',
    });
    assert.equal(onA.status, 200, onA.body);

    // 指定一台没有这个应用的 PC → 明确报错，不默默打到另一台
    const bad = await httpGet(`http://127.0.0.1:${port}/nx-kv/api/ping`, {
      'x-mn-ws-token': 'gate-token', 'x-mn-ws-pc': 'no-such-pc',
    });
    assert.equal(bad.status, 404);
    assert.equal(JSON.parse(bad.body).error, 'unknown_pc_app');
  } finally {
    pcA.close();
    pcB.close();
    await server.close();
    await nx.close();
  }
});

test('顶替者断开后 app 归还给仍连着的旧桥（不再变成没人能路由）', async () => {
  const nx = await startFakeNx();
  const server = createServer({ host: '127.0.0.1', port: 0, token: 'gate-token', dataDir: null, logLevel: 'error' });
  const port = await server.listen();
  // try/finally：断言失败时也要把 server 关掉 —— 否则失败会变成「进程不退出」，
  // 把一条清晰的断言失败变成一条看不懂的超时。
  let oldBridge: FakeBridge | null = null;
  let newBridge: FakeBridge | null = null;
  try {
    // 旧桥先连上，注册 my-api
    oldBridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
      { app: 'my-api', base: `http://127.0.0.1:${nx.port}` },
    ]);
    await oldBridge.registered;

    // 新桥连上来，把同一个 app 顶替掉（顶替是有意的：一个 app 同时只有一个桥）
    newBridge = new FakeBridge(`ws://127.0.0.1:${port}/ws`, 'gate-token', [
      { app: 'my-api', base: `http://127.0.0.1:${nx.port}` },
    ]);
    await newBridge.registered;

    // 顶替者断开。旧桥**还连着** —— app 必须回到旧桥手上，
    // 否则这个 app 就成了「注册过但没人能路由」，调用方永远拿到 502。
    newBridge.close();
    newBridge = null;
    await waitUntil(async () => {
      const cat = await httpGet(`http://127.0.0.1:${port}/api/catalog`, { 'x-mn-ws-token': 'gate-token' });
      return JSON.parse(cat.body).count === 1;
    });

    const cat = await httpGet(`http://127.0.0.1:${port}/api/catalog`, { 'x-mn-ws-token': 'gate-token' });
    assert.equal(JSON.parse(cat.body).count, 1, '顶替者断开后 app 应回到旧桥，目录里应仍有 1 个应用');

    const res = await httpGet(`http://127.0.0.1:${port}/api/ping`, {
      'x-mn-ws-token': 'gate-token',
      'x-mn-ws-app': 'my-api',
    });
    assert.equal(res.status, 200, res.body);
    assert.equal(JSON.parse(res.body).url, '/api/ping');
  } finally {
    newBridge?.close();
    oldBridge?.close();
    await server.close();
    await nx.close();
  }
});
