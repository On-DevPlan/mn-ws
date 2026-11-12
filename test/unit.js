'use strict';

/**
 * mn-ws 单元 + 端到端测试。
 *
 * 跑法：node test/unit.js
 *
 * 端到端那一条是本项目最重要的一条断言：
 * **同一个请求，直连 nx 与走 mn-ws，响应必须逐字节相同，nx 侧收到的请求也相同。**
 * 「体感一致」不是口号，是这条断言。
 */

const assert = require('node:assert');
const http = require('node:http');

const { resolveApp } = require('../lib/apps');
const {
  FRAME, encodeFrame, decodeFrame, normalizeHeaders, stripRequestHeaders,
  stripResponseHeaders, nextRequestId,
} = require('../lib/protocol');
const { createServer } = require('../server/server');
const { WsBridgeClient } = require('../client/ws-client');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${e && e.message}\n`);
    if (process.env.MN_WS_TEST_VERBOSE) process.stdout.write(`${e && e.stack}\n`);
  }
}

function group(name) {
  process.stdout.write(`\n${name}\n`);
}

// ============================ 应用标识解析 ============================

async function testAppResolution() {
  group('应用标识解析');

  await test('路径前缀优先', () => {
    const r = resolveApp('/nx-kv/api/todo/list', normalizeHeaders({}));
    assert.strictEqual(r.app, 'nx-kv');
    assert.strictEqual(r.path, '/api/todo/list');
  });

  await test('请求头兜底', () => {
    const r = resolveApp('/api/todo/list', normalizeHeaders({ 'x-nx-app': 'nx-rh' }));
    assert.strictEqual(r.app, 'nx-rh');
    assert.strictEqual(r.path, '/api/todo/list');
  });

  await test('两者冲突时报错（不猜）', () => {
    const r = resolveApp('/nx-kv/api/x', normalizeHeaders({ 'x-nx-app': 'nx-rh' }));
    assert.strictEqual(r.error, 'app_conflict');
  });

  await test('都缺时报 app_required', () => {
    const r = resolveApp('/api/x', normalizeHeaders({}));
    assert.strictEqual(r.error, 'app_required');
  });

  await test('非法 app 名被拒', () => {
    const r = resolveApp('/api/x', normalizeHeaders({ 'x-nx-app': '../etc' }));
    assert.strictEqual(r.error, 'invalid_app_name');
  });

  await test('尾部斜杠被规整', () => {
    const r = resolveApp('/nx-kv/api/x/', normalizeHeaders({}));
    assert.strictEqual(r.path, '/api/x');
  });
}

// ============================ 帧与头处理 ============================

async function testProtocol() {
  group('帧与头处理');

  await test('帧编解码往返', () => {
    const frame = { type: FRAME.REQUEST, id: 'r-1', app: 'nx-kv', body: 'AA==' };
    const back = decodeFrame(encodeFrame(frame));
    assert.deepStrictEqual(back, frame);
  });

  await test('非法帧返回 null', () => {
    assert.strictEqual(decodeFrame('not json'), null);
    assert.strictEqual(decodeFrame('{"no":"type"}'), null);
    assert.strictEqual(decodeFrame(Buffer.from('[]')), null);
  });

  await test('request id 跨调用不重复', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) ids.add(nextRequestId());
    assert.strictEqual(ids.size, 500);
  });

  await test('Origin 被剥离（nx 跨站防护）', () => {
    const h = stripRequestHeaders(normalizeHeaders({
      origin: 'https://evil.example.com',
      authorization: 'Bearer x',
    }));
    assert.strictEqual(h.origin, undefined);
    assert.strictEqual(h.authorization[0], 'Bearer x');
  });

  await test('hop-by-hop 头被剥离', () => {
    const h = stripRequestHeaders(normalizeHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-type': 'application/json',
    }));
    assert.strictEqual(h.connection, undefined);
    assert.strictEqual(h['transfer-encoding'], undefined);
    assert.ok(h['content-type']);
  });

  await test('响应头剥离 content-length（自己重算）', () => {
    const h = stripResponseHeaders(normalizeHeaders({ 'content-length': '999', 'set-cookie': ['a=1', 'b=2'] }));
    assert.strictEqual(h['content-length'], undefined);
    assert.deepStrictEqual(h['set-cookie'], ['a=1', 'b=2']);
  });
}

// ============================ 端到端透传 ============================

/**
 * 起一个「假 nx」：把收到的请求全部回显。
 * 它的回显同时充当**响应指纹**与**请求指纹**。
 */
function startFakeNx() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
      });
      const payload = JSON.stringify({
        ok: true,
        echo: {
          method: req.method,
          url: req.url,
          body,
          hasAuth: Boolean(req.headers.authorization),
        },
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-fake-nx': 'yes',
      });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function testEndToEnd() {
  group('端到端透传（直连 vs 走桥必须一致）');

  const nx = await startFakeNx();
  const token = 'test-gate-token';

  /** L1 凭据走独立头；Authorization 留给 nx 自己（L3）。 */
  const gate = (extra = {}) => ({ 'x-mn-ws-token': token, ...extra });

  const server = createServer({
    host: '127.0.0.1',
    port: 0,
    token,
    wsPath: '/ws',
    dataDir: null,
    logLevel: 'error',
  });
  const actualPort = await server.listen();

  const client = new WsBridgeClient({
    url: `ws://127.0.0.1:${actualPort}/ws`,
    token,
    bridgeId: 'test-bridge',
    apps: { 'nx-test': `http://127.0.0.1:${nx.port}` },
  });

  const registered = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('注册超时')), 5000);
    client.onStatus = (s) => {
      if (s.state === 'registered') { clearTimeout(t); resolve(s); }
    };
  });
  client.start();
  await registered;

  await test('走桥的请求到达了 nx，且 path 正确剥掉前缀', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo?x=1&y=2`, gate());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nx.seen.length, 1);
    assert.strictEqual(nx.seen[0].method, 'GET');
    assert.strictEqual(nx.seen[0].url, '/api/echo?x=1&y=2');
  });

  await test('响应体与 nx 直连逐字节相同（同样的请求头）', async () => {
    const viaBridge = await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo?x=1&y=2`, gate({
      authorization: 'Bearer nx-session-token',
    }));
    const direct = await httpGet(`http://127.0.0.1:${nx.port}/api/echo?x=1&y=2`, {
      authorization: 'Bearer nx-session-token',
    });
    assert.strictEqual(viaBridge.status, direct.status);
    assert.strictEqual(viaBridge.body, direct.body);
  });

  await test('响应头原样带回（除 hop-by-hop）', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo`, gate());
    assert.strictEqual(res.headers['x-fake-nx'], 'yes');
    assert.strictEqual(res.headers['content-type'], 'application/json');
  });

  await test('Authorization 原样透传给 nx（应用层鉴权不被桥改写）', async () => {
    await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo`, gate({
      authorization: 'Bearer nx-session-token',
      'x-user-token': 'user-token-abc',
    }));
    const last = nx.seen[nx.seen.length - 1];
    assert.strictEqual(last.headers.authorization, 'Bearer nx-session-token');
    assert.strictEqual(last.headers['x-user-token'], 'user-token-abc');
  });

  await test('L1 门禁头不进 nx（两层凭据不串台）', async () => {
    await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo`, gate());
    const last = nx.seen[nx.seen.length - 1];
    assert.strictEqual(last.headers['x-mn-ws-token'], undefined);
  });

  await test('POST body 逐字节透传', async () => {
    const payload = JSON.stringify({ title: '中文标题', n: 42 });
    const res = await httpPost(`http://127.0.0.1:${actualPort}/nx-test/api/todo/add`, payload, gate());
    assert.strictEqual(res.status, 200);
    const last = nx.seen[nx.seen.length - 1];
    assert.strictEqual(last.body, payload);
  });

  await test('Origin 头不会被透传（否则 nx 侧 403）', async () => {
    await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo`, gate({
      origin: 'https://evil.example.com',
    }));
    const last = nx.seen[nx.seen.length - 1];
    assert.strictEqual(last.headers.origin, undefined);
  });

  await test('无 L1 凭据 → 401', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/nx-test/api/echo`);
    assert.strictEqual(res.status, 401);
  });

  await test('未知应用 → 404 unknown_app', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/nx-unknown/api/x`, gate());
    assert.strictEqual(res.status, 404);
    assert.strictEqual(JSON.parse(res.body).error, 'unknown_app');
  });

  await test('/health 可达', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).ok, true);
  });

  await test('/stats 列出已注册的应用', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/stats`);
    const j = JSON.parse(res.body);
    assert.ok(j.apps.includes('nx-test'));
  });

  client.stop();
  await server.close();
  await nx.close();
}

// ============================ 端口预检 ============================

async function testPortGuard() {
  group('端口预检');

  await test('被占用的端口被识别出来', async () => {
    const held = http.createServer(() => {});
    await new Promise((r) => held.listen(0, '127.0.0.1', r));
    const port = held.address().port;
    const { isPortFree } = require('../lib/apps');
    const res = await isPortFree(port, '127.0.0.1');
    assert.strictEqual(res.free, false);
    await new Promise((r) => held.close(r));
  });

  await test('空闲端口被识别出来', async () => {
    const { isPortFree } = require('../lib/apps');
    const res = await isPortFree(0, '127.0.0.1');
    assert.strictEqual(res.free, true);
  });
}

// ============================ 默认端口 ============================

/**
 * 默认端口钉死在 7777。
 *
 * 为什么要有这条测试：端口散落在 lib/config.js、server/server.js、
 * client/web.js 三处 —— 「改了一处忘了另一处」会让 server 监听 7777 而
 * 默认 URL / 文档还写着别的号，客户端连的是一个没人监听的端口，
 * 表现是「服务端起来了、客户端说连不上」。要改端口时，这条用例会第一个红。
 */
async function testDefaultPort() {
  group('默认端口');

  await test('server / client / 面板的默认端口都是 7777', () => {
    const cfg = require('../lib/config');
    const { DEFAULT_WEB_PORT } = require('../client/web');
    assert.strictEqual(cfg.DEFAULT_SERVER_PORT, 7777);
    assert.strictEqual(cfg.DEFAULT_WEB_PORT, 7777);
    assert.strictEqual(DEFAULT_WEB_PORT, 7777);
    assert.strictEqual(createServer({}).config.port, 7777);
  });

  await test('默认服务地址指向 7777', () => {
    const { DEFAULT_SERVE_URL, DEFAULT_SERVER_HTTP } = require('../lib/config');
    assert.ok(DEFAULT_SERVE_URL.endsWith(':7777/ws'), DEFAULT_SERVE_URL);
    assert.ok(DEFAULT_SERVER_HTTP.endsWith(':7777'), DEFAULT_SERVER_HTTP);
  });

  await test('命令行 --port / --web-port 能覆盖默认端口', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-cfg-'));
    const prev = process.env.MN_WS_HOME;
    process.env.MN_WS_HOME = tmp;
    try {
      const { loadConfig } = require('../lib/config');
      assert.strictEqual(loadConfig({}).port, 7777);
      assert.strictEqual(loadConfig({}).webPort, 7777);
      assert.strictEqual(loadConfig({ port: '18080' }).port, 18080);
      assert.strictEqual(loadConfig({ webPort: '18081' }).webPort, 18081);
    } finally {
      if (prev === undefined) delete process.env.MN_WS_HOME;
      else process.env.MN_WS_HOME = prev;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

// ============================ 统一登录：发现文档预热 ============================

/**
 * 发现文档预热（回归防护）。
 *
 * 曾经的坑：`/auth/oidc/config` 报的 `idpAvailable` 含义是
 * 「**成功拉到过**发现文档」，不是「认证中心在线」。
 * 没做启动预热时这个字段永远是 false —— 部署脚本正是拿它断言
 * 「统一登录确实生效」，于是一个完全正常的部署会被判成失败
 * （认证中心明明可达，容器里 wget 也拉得到，就是没人去拉）。
 */
async function testDiscoveryWarmUp() {
  group('统一登录发现文档预热');

  // 假 IdP：只提供发现文档
  const idp = http.createServer((req, res) => {
    if (req.url.startsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        issuer: `http://127.0.0.1:${idp.address().port}`,
        authorization_endpoint: 'http://127.0.0.1/oauth2/auth',
        token_endpoint: 'http://127.0.0.1/oauth2/token',
        userinfo_endpoint: 'http://127.0.0.1/oauth2/userinfo',
      }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  const idpPort = await new Promise((resolve) => {
    idp.listen(0, '127.0.0.1', () => resolve(idp.address().port));
  });

  const server = createServer({
    host: '127.0.0.1',
    port: 0,
    token: 'gate',
    authEnabled: true,
    jwtSecret: 'test-jwt-secret',
    issuer: `http://127.0.0.1:${idpPort}`,
    idpClientId: 'mn-ws-server',
    loginClientId: 'mn-ws-client',
    dataDir: null,
    logLevel: 'error',
  });
  const actualPort = await server.listen();

  await test('预热成功后 /auth/oidc/config 报 idpAvailable=true', async () => {
    // 预热是后台异步的 —— 本地假 IdP 通常几十毫秒就绪
    let cfg = null;
    for (let i = 0; i < 50; i += 1) {
      const res = await httpGet(`http://127.0.0.1:${actualPort}/auth/oidc/config`);
      cfg = JSON.parse(res.body);
      if (cfg.idpAvailable) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(cfg, '没拿到 /auth/oidc/config');
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.idpAvailable, true, JSON.stringify(cfg));
    assert.strictEqual(cfg.clientId, 'mn-ws-server');
    assert.strictEqual(cfg.loginClientId, 'mn-ws-client');
  });

  await test('公开配置里绝不含 secret', async () => {
    const res = await httpGet(`http://127.0.0.1:${actualPort}/auth/oidc/config`);
    assert.ok(!/test-jwt-secret/.test(res.body), '响应里漏了 JWT secret');
    assert.ok(!/secret/i.test(res.body.replace(/"idpError":"[^"]*"/g, '')), '响应里出现了 secret 字样');
  });

  await server.close();
  await new Promise((r) => idp.close(r));
}

// ============================ OIDC 两端身份拆分 ============================

/**
 * server 半与 client 半在认证中心各有各的 client_id。
 *
 * 为什么拆：client_id 是**审计与吊销的单元**。共用一个之后，
 * 「哪个平台在发 token」「要停哪条接入」都问不出来
 * （go-ah 自己的种子注释里写的就是这条理由）。
 *
 * 拆开之后：
 *   · server 半 = mn-ws-server（它只是「我是谁」，不发起授权码流程）
 *   · client 半 = mn-ws-client（真正发起授权码流程：本机 CLI 回环收码 + PKCE）
 * 而且 server 半要**把 client 半的身份一并发布出去**，否则新装的 client 半
 * 不知道该用哪个 client_id 去登录。
 */
async function testOidcIdentitySplit() {
  group('OIDC 两端身份拆分');

  await test('默认：server 半 = mn-ws-server，client 半 = mn-ws-client', () => {
    const cfg = require('../lib/config');
    assert.strictEqual(cfg.loadConfig({}).idpClientId, 'mn-ws-server');
    assert.strictEqual(cfg.loadConfig({}).loginClientId, 'mn-ws-client');
    assert.strictEqual(createServer({}).config.idpClientId, 'mn-ws-server');
    assert.strictEqual(createServer({}).config.loginClientId, 'mn-ws-client');
  });

  await test('/auth/oidc/config 同时发布两个身份', async () => {
    const server = createServer({
      host: '127.0.0.1',
      port: 0,
      token: 'gate',
      authEnabled: true,
      jwtSecret: 'test-jwt-secret',
      idpClientId: 'mn-ws-server',
      loginClientId: 'mn-ws-client',
      dataDir: null,
      logLevel: 'error',
    });
    const port = await server.listen();
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/auth/oidc/config`);
      const cfg = JSON.parse(res.body);
      assert.strictEqual(cfg.clientId, 'mn-ws-server');
      assert.strictEqual(cfg.loginClientId, 'mn-ws-client');
    } finally {
      await server.close();
    }
  });

  await test('authorize 用的是 client 半的身份（不是 server 半的）', () => {
    const { buildAuthorizeUrl } = require('../lib/auth');
    const url = new URL(buildAuthorizeUrl({
      issuer: 'http://idp.example',
      clientId: 'mn-ws-server',
      loginClientId: 'mn-ws-client',
      scopes: ['openid'],
    }, { state: 's', nonce: 'n', authorizeParams: { redirect_uri: 'http://127.0.0.1:1/callback' } }));
    assert.strictEqual(url.searchParams.get('client_id'), 'mn-ws-client');
  });

  await test('老 server 只发布一个 client_id 时回落用它', () => {
    const { buildAuthorizeUrl } = require('../lib/auth');
    const url = new URL(buildAuthorizeUrl({
      issuer: 'http://idp.example',
      clientId: 'mn-ws',
      scopes: ['openid'],
    }, { state: 's', nonce: 'n', authorizeParams: { redirect_uri: 'http://127.0.0.1:1/callback' } }));
    assert.strictEqual(url.searchParams.get('client_id'), 'mn-ws');
  });
}

// ============================ 多路复用 + 元信息目录 ============================

/**
 * 两条独立的 WS 连接（相当于两台机器，或同一台机跑两个 client），
 * 各自声明自己能桥的应用；请求按应用标识落到**对应的**那条连接上。
 *
 * 这条用例是整个「元信息 → 选择 → 路由」闭环的机器化验收：
 *   ① 目录端点能列出全部可路由应用（登录后才知道有哪些）
 *   ② 按应用标识，请求打到正确的那台桥
 *   ③ 用请求头指定应用，与路径前缀等价
 */
async function testMultiplex() {
  group('多路复用（多条 WS）+ 元信息目录');

  const nxA = await startFakeNx();
  const nxB = await startFakeNx();
  const token = 'mux-gate';

  const server = createServer({
    host: '127.0.0.1', port: 0, token, wsPath: '/ws', logLevel: 'error',
  });
  const port = await server.listen();

  const mk = (bridgeId, app, nxPort) => new WsBridgeClient({
    url: `ws://127.0.0.1:${port}/ws`,
    token,
    bridgeId,
    apps: { [app]: `http://127.0.0.1:${nxPort}` },
  });

  const clientA = mk('host-a', 'nx-alpha', nxA.port);
  const clientB = mk('host-b', 'nx-beta', nxB.port);

  const waitRegistered = (c) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('注册超时')), 5000);
    c.onStatus = (s) => { if (s.state === 'registered') { clearTimeout(t); resolve(s); } };
  });
  clientA.onStatus = () => {};
  clientB.onStatus = () => {};
  clientA.start();
  clientB.start();
  await waitRegistered(clientA);
  await waitRegistered(clientB);

  await test('元信息目录列出两条桥上的应用', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/catalog`, {
      'x-mn-ws-token': token,
    });
    assert.strictEqual(res.status, 200);
    const j = JSON.parse(res.body);
    assert.strictEqual(j.count, 2);
    const byApp = Object.fromEntries(j.apps.map((a) => [a.app, a]));
    assert.ok(byApp['nx-alpha']);
    assert.ok(byApp['nx-beta']);
    assert.strictEqual(byApp['nx-alpha'].bridgeId, 'host-a');
    assert.strictEqual(byApp['nx-beta'].bridgeId, 'host-b');
    // 元信息带端口与标题 —— 客户端据此知道「能路由到什么」
    assert.strictEqual(byApp['nx-alpha'].port, nxA.port);
    assert.ok(byApp['nx-alpha'].title);
  });

  await test('目录需要凭据', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/api/catalog`);
    assert.strictEqual(res.status, 401);
  });

  await test('路径前缀路由到第一条 WS', async () => {
    const before = nxA.seen.length;
    const res = await httpGet(`http://127.0.0.1:${port}/nx-alpha/api/echo`, {
      'x-mn-ws-token': token,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nxA.seen.length, before + 1);
  });

  await test('路径前缀路由到第二条 WS（不串台）', async () => {
    const before = nxB.seen.length;
    const res = await httpGet(`http://127.0.0.1:${port}/nx-beta/api/echo`, {
      'x-mn-ws-token': token,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nxB.seen.length, before + 1);
  });

  await test('请求头指定应用，与路径前缀等价', async () => {
    const before = nxB.seen.length;
    const res = await httpGet(`http://127.0.0.1:${port}/api/echo`, {
      'x-mn-ws-token': token,
      'x-nx-app': 'nx-beta',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(nxB.seen.length, before + 1);
  });

  await test('请求头与路径冲突 → 400 app_conflict（不猜）', async () => {
    const res = await httpGet(`http://127.0.0.1:${port}/nx-alpha/api/echo`, {
      'x-mn-ws-token': token,
      'x-nx-app': 'nx-beta',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(JSON.parse(res.body).error, 'app_conflict');
  });

  clientA.stop();
  clientB.stop();
  await server.close();
  await nxA.close();
  await nxB.close();
}

// ============================ HTTP 小工具 ============================

function httpGet(url, headers = {}) {
  return httpReq('GET', url, null, headers);
}

function httpPost(url, body, headers = {}) {
  return httpReq('POST', url, body, headers);
}

function httpReq(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === null ? '' : body;
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================ main ============================

(async () => {
  process.stdout.write('mn-ws 测试\n');
  await testAppResolution();
  await testProtocol();
  await testPortGuard();
  await testDefaultPort();
  await testOidcIdentitySplit();
  await testDiscoveryWarmUp();
  await testEndToEnd();
  await testMultiplex();
  process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stderr.write(`测试崩溃：${e && e.stack}\n`);
  process.exit(1);
});
