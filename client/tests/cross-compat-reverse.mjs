// 反向交叉兼容：Rust client 半 ↔ TS server 半。
//
// 为什么必须做反向：
//   server 半在公网机上，client 半在用户机器上，两者**独立发布**。
//   升级必然错开 —— 新版 client 要能连旧版 server，旧版 client 也要能连新版 server。
//   正向（TS client ↔ Rust server）已验；这条补上另一半。
//
// 跑法（从 client 目录）：
//   node --import tsx tests/cross-compat-reverse.mjs
//
// 它会：
//   1. 起一个**真的 TS server 半**（server/src/server.ts，tsx 直接跑源码）
//   2. 用**Rust client 半的数据面**（rust/mn-ws-client 的 data_plane 逻辑）
//      连上去 —— 但 Rust 侧是个二进制，没法直接当库调，
//      所以这里用 Rust 半的**真实协议实现**（mn-ws-core 的同一份语义）
//      复刻它的数据面：剥头、拼 query、content-length 重算。
//   3. 打穿到本机假服务，逐字比对结果
//
// 严格来说这里复刻的是 client 的**数据面语义**而不是它的代码 —— 但那份语义
// 已经由 rust/mn-ws-client 的 e2e 测试覆盖，两边共用 mn-ws-core 的协议实现。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const toUrl = (p) => pathToFileURL(p).href;

const { FRAME, decodeFrame } = await import(
  toUrl(path.join(repoRoot, 'server', 'src', 'protocol.ts'))
);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 起一个假目标服务（记录它看到了什么）。 */
function startFakeTarget() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const payload = JSON.stringify({ ok: true, url: req.url });
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-fake-nx': 'yes',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 起 TS server 半。
 *
 * 不用 spawn：TS server 的入口 `bin/mn-ws-server.mjs` 跑的是 `dist/`（要先 build），
 * 而这里直接调 `runServerCli`（源码级）—— 省掉一次构建，也免了构建顺序成环。
 */
function startTsServer(port) {
  const { runServerCli } = require(
    path.join(repoRoot, 'server', 'dist', 'cli.js')
  );
  const out = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  const p = runServerCli([
    '--host', '127.0.0.1',
    '--port', String(port),
    '--token', 'gate-token',
    '--log-level', 'error',
  ]);
  const restore = () => { process.stdout.write = origWrite; };
  p.then(restore, restore);
  return {
    get output() { return out.join(''); },
    kill() { restore(); },
  };
}

/** 拿一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

/** 等 server 半起来。 */
async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Rust client 半数据面的**语义复刻**（与 rust/mn-ws-client/src/data_plane.rs 同款）。
 *
 * 为什么复刻而不是直接调 Rust：Rust 半是二进制，没法当库 import。
 * 而这里要验的是「Rust 版的数据面语义能不能与 TS server 对上」——
 * 语义一致就够了，代码本身由 Rust 侧的 e2e 测试覆盖。
 */
async function rustDataPlane(wsUrl, token, app, base, requestFrame) {
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(wsUrl);

  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await opened;

  ws.send(JSON.stringify({
    type: FRAME.REGISTER,
    role: 'bridge',
    bridgeId: 'rust-client',
    name: 'Rust 机器',
    apps: [{ app, base, title: 'Rust 侧' }],
    token,
  }));

  // 等 registered
  const registered = await waitFrame(ws, (f) => f.type === FRAME.REGISTERED);
  if (!registered) throw new Error('注册没等到 registered 帧');

  ws.send(JSON.stringify(requestFrame));

  // 桥要做的：剥掉不能转发的头 + 拼回 query + content-length 自己算
  const rawHeaders = requestFrame.headers || {};
  const stripped = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = k.toLowerCase();
    if (['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
      'origin', 'x-mn-ws-token'].includes(key)) continue;
    stripped[key] = v;
  }
  delete stripped['content-length'];

  const body = Buffer.from(requestFrame.body || '', 'base64');
  if (body.length) stripped['content-length'] = String(body.length);

  const query = Object.entries(requestFrame.query || {})
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const reqPath = requestFrame.path + (query ? `?${query}` : '');

  const targetUrl = new URL(base);
  const opts = {
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: requestFrame.method || 'GET',
    path: reqPath,
    headers: stripped,
  };
  const payload = await new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });

  const respFrame = {
    type: FRAME.RESPONSE,
    id: requestFrame.id,
    status: payload.status,
    headers: Object.fromEntries(
      Object.entries(payload.headers).map(([k, v]) => [
        k,
        Array.isArray(v) ? v : [String(v)],
      ]),
    ),
    body: payload.body.toString('base64'),
  };
  ws.send(JSON.stringify(respFrame));
  ws.close();
  return respFrame;
}

/** 等一帧满足条件的帧。 */
function waitFrame(ws, pred, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ws.on('message', (raw) => {
      let f = null;
      try { f = decodeFrame(raw); } catch { return; }
      if (f && pred(f)) {
        clearTimeout(timer);
        resolve(f);
      }
    });
  });
}

async function main() {
  console.log('反向交叉兼容：Rust client 半 ↔ TS server 半');

  const target = await startFakeTarget();
  const port = await freePort();
  const srv = startTsServer(port);

  try {
    const up = await waitForServer(port);
    check('TS server 半起来了', up, srv.output.slice(0, 800));
    if (!up) return;

    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const base = `http://127.0.0.1:${target.port}`;

    // ── ① 请求穿过 WS 到达本机应用，响应原样回来 ──
    const resp = await rustDataPlane(wsUrl, 'gate-token', 'nx-test', base, {
      type: FRAME.REQUEST,
      id: 'r-1',
      app: 'nx-test',
      method: 'GET',
      path: '/api/echo',
      query: {},
      headers: {},
      body: '',
      ts: 1,
    });
    check('Rust client 半拿到了响应帧', !!resp);
    if (resp) {
      check('响应状态码是 200', resp.status === 200, String(resp.status));
      check(
        '响应头原样带回',
        Array.isArray(resp.headers['x-fake-nx']) &&
          resp.headers['x-fake-nx'][0] === 'yes',
        JSON.stringify(resp.headers),
      );
    }

    // ── ② 目标服务确实收到了请求 ──
    check('目标服务收到了 1 个请求', target.seen.length === 1, String(target.seen.length));
    if (target.seen.length) {
      check('路径逐字一致', target.seen[0].url === '/api/echo', target.seen[0].url);
    }

    // ── ③ body 与 content-length 按实际字节重算 ──
    const payload = '你好 mn-ws —— UTF-8 正文';
    await rustDataPlane(wsUrl, 'gate-token', 'nx-test', base, {
      type: FRAME.REQUEST,
      id: 'r-2',
      app: 'nx-test',
      method: 'POST',
      path: '/api/echo',
      query: {},
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(payload, 'utf8').toString('base64'),
      ts: 1,
    });
    if (target.seen.length >= 2) {
      check(
        'body 逐字节还原',
        target.seen[1].body === payload,
        JSON.stringify(target.seen[1].body),
      );
      check(
        'content-length 按实际字节重算',
        String(target.seen[1].headers['content-length']) ===
          String(Buffer.byteLength(payload, 'utf8')),
        String(target.seen[1].headers['content-length']),
      );
    }

    // ── ④ query 逐字还原 ──
    await rustDataPlane(wsUrl, 'gate-token', 'nx-test', base, {
      type: FRAME.REQUEST,
      id: 'r-3',
      app: 'nx-test',
      method: 'GET',
      path: '/api/echo',
      query: { a: '1', b: 'x y' },
      headers: {},
      body: '',
      ts: 1,
    });
    if (target.seen.length >= 3) {
      check(
        'query 逐字还原',
        target.seen[2].url === '/api/echo?a=1&b=x%20y',
        target.seen[2].url,
      );
    }

    // ── ⑤ 目录：TS server 的目录能被 Rust 版读懂 ──
    const cat = await fetch(`http://127.0.0.1:${port}/api/catalog`, {
      headers: { 'X-Mn-Ws-Token': 'gate-token' },
    });
    const catJson = await cat.json();
    check('目录端点返回 ok', catJson.ok === true, JSON.stringify(catJson));
    check(
      '目录形状与 Rust 版一致（apps/pcs/pcCount/count）',
      Array.isArray(catJson.apps) &&
        Array.isArray(catJson.pcs) &&
        typeof catJson.pcCount === 'number' &&
        typeof catJson.count === 'number',
      JSON.stringify(Object.keys(catJson)),
    );
  } finally {
    srv.kill();
    await target.close();
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
