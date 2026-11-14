// 交叉兼容验证：TS client 半 ↔ Rust server 半。
//
// 为什么必须做这个：两端都转 Rust 之后，**同语言互通**证明不了兼容性 ——
// 真正的风险是「Rust 版与仍在跑的 TS 版对不上」。
//
// 生产上 server 半与 client 半是**独立发布**的：server 在公网机上，
// client 在用户机器上。升级必然是错开的 —— 新版 client 要能连旧版 server，
// 旧版 client 也要能连新版 server。这个测试钉住的就是这件事。
//
// 跑法（需要 mn-ws 的 node_modules 已装）：
//   node --import tsx client/tests/cross-compat.mjs
//
// 它会：
//   1. 起一个**真的 Rust server 半**（target/release/mn-ws-server.exe）
//   2. 用**真的 TS client 半**（client/src/core/bridge.ts）连上去
//   3. 发一个请求，打到本机假服务，比对结果
//
// 反向（Rust client → TS server）在 client/tests/cross-compat-reverse.mjs。

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// TS client 半的协议与桥接实现（直接引源码，不走构建产物 —— 免得构建顺序成环）
//
// ⚠️ Windows 上绝对路径要用 file:// URL —— `import('D:\...')` 会被 ESM 拒
//    （ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const toUrl = (p) => pathToFileURL(p).href;

const { BridgeClient } = await import(
  toUrl(path.join(repoRoot, 'client', 'src', 'core', 'bridge.ts'))
);
const { FRAME } = await import(
  toUrl(path.join(repoRoot, 'server', 'src', 'protocol.ts'))
);

const RUST_SERVER = path.join(repoRoot, 'rust', 'target', 'release', 'mn-ws-server.exe');
const RUST_SERVER_UNIX = path.join(repoRoot, 'rust', 'target', 'release', 'mn-ws-server');

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

/** 起 Rust server 半。 */
function startRustServer(port) {
  const exe = process.platform === 'win32' ? RUST_SERVER : RUST_SERVER_UNIX;
  const child = spawn(
    exe,
    [
      '--host', '127.0.0.1',
      '--port', String(port),
      '--token', 'gate-token',
      '--log-level', 'error',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return {
    child,
    get output() { return out; },
    kill() { try { child.kill(); } catch { /* ignore */ } },
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
async function waitForServer(port, timeoutMs = 15000) {
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

/** 用 TS client 半连 Rust server，发一个请求。 */
async function tsClientRoundtrip(wsUrl, token, app, base, frame) {
  const sent = [];
  const bridge = new BridgeClient({
    apps: { [app]: { base, title: '假目标服务' } },
    send: (f) => sent.push(f),
  });

  // 手工驱动 TS client 的数据面（handleRequest 是公开方法）。
  await bridge.handleRequest(frame);
  // 等响应帧
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const resp = sent.find((f) => f && (f.type === FRAME.RESPONSE || f.type === FRAME.ERROR));
    if (resp) return resp;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

async function main() {
  console.log('交叉兼容：TS client 半 ↔ Rust server 半');

  const target = await startFakeTarget();
  const port = await freePort();
  const srv = startRustServer(port);

  try {
    const up = await waitForServer(port);
    check('Rust server 半起来了', up, srv.output);
    if (!up) return;

    // ── ① 请求穿过 WS 到达本机应用，响应原样回来 ──
    const frame = {
      type: FRAME.REQUEST,
      id: 'r-1',
      app: 'nx-test',
      method: 'GET',
      path: '/api/echo',
      query: {},
      headers: {},
      body: '',
    };
    const resp = await tsClientRoundtrip(
      `ws://127.0.0.1:${port}/ws`,
      'gate-token',
      'nx-test',
      `http://127.0.0.1:${target.port}`,
      frame,
    );
    check('TS client 半拿到了响应帧', !!resp, JSON.stringify(resp));
    if (resp) {
      check('响应状态码是 200', resp.status === 200, String(resp.status));
      // 协议层的头值**统一是数组**（保住 set-cookie 这类多值头）——
      // 断言要按这个形状写，不能按字符串写。
      check(
        '响应头原样带回',
        Array.isArray(resp.headers['x-fake-nx']) &&
          resp.headers['x-fake-nx'][0] === 'yes',
        JSON.stringify(resp.headers),
      );
      const body = JSON.parse(Buffer.from(resp.body, 'base64').toString('utf8'));
      check('响应体原样带回', body.ok === true && body.url === '/api/echo', JSON.stringify(body));
    }

    // ── ② 目标服务确实收到了请求 ──
    check('目标服务收到了 1 个请求', target.seen.length === 1, String(target.seen.length));
    if (target.seen.length) {
      check(
        '路径逐字一致',
        target.seen[0].url === '/api/echo',
        target.seen[0].url,
      );
    }

    // ── ③ body 与 content-length 按实际字节重算 ──
    const payload = '你好 mn-ws —— UTF-8 正文';
    const resp2 = await tsClientRoundtrip(
      `ws://127.0.0.1:${port}/ws`,
      'gate-token',
      'nx-test',
      `http://127.0.0.1:${target.port}`,
      {
        type: FRAME.REQUEST,
        id: 'r-2',
        app: 'nx-test',
        method: 'POST',
        path: '/api/echo',
        query: {},
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(payload, 'utf8').toString('base64'),
      },
    );
    check('POST 也拿到了响应帧', !!resp2);
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

    // ── ④ 目录：Rust server 的目录能被读懂 ──
    const cat = await fetch(`http://127.0.0.1:${port}/api/catalog`, {
      headers: { 'X-Mn-Ws-Token': 'gate-token' },
    });
    const catJson = await cat.json();
    check('目录端点返回 ok', catJson.ok === true, JSON.stringify(catJson));
    check(
      '目录形状与 TS 版一致（apps/pcs/pcCount/count）',
      Array.isArray(catJson.apps) &&
        Array.isArray(catJson.pcs) &&
        typeof catJson.pcCount === 'number' &&
        typeof catJson.count === 'number',
      JSON.stringify(Object.keys(catJson)),
    );

    // ── ⑤ 鉴权：无凭据 401 ──
    const noAuth = await fetch(`http://127.0.0.1:${port}/nx-test/api/echo`);
    check('无 L1 凭据 → 401', noAuth.status === 401, String(noAuth.status));
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
