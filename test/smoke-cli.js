'use strict';

/**
 * CLI 冒烟：真的起 `mn-ws server` 与 `mn-ws client` 两个进程，用 HTTP 打穿。
 *
 * 与 unit.js 的区别：unit.js 在进程内跑（测协议），这里测**命令行与进程边界**
 * —— 参数解析、端口预检、鉴权头、退出行为。
 *
 * 跑法：node test/smoke-cli.js
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'index.js');
const SERVER_PORT = 18791;
const GATE = 'smoke-gate-token';

/**
 * 子进程的配置目录 —— **必须与本机真实配置隔离**。
 *
 * 不隔离的后果很具体：本机 `~/.mn-ws/config.json` 里存着用户的门禁 token 时，
 * 「server 无鉴权时拒绝启动」那条用例会从配置里读到 token → server 真的起来了
 * → 子进程永不退出 → 整条 run() 永不 resolve → **整个冒烟套件挂死**。
 *
 * 这不是"本机配置怪"的问题，是测试必须与开发者机器状态解耦。
 */
const SMOKE_HOME = path.join(ROOT, '.tmp-smoke');

function startFakeNx() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-fake-nx': 'yes' });
      res.end(JSON.stringify({ ok: true, url: req.url, method: req.method, body }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * 跑一个 CLI 子进程，等它退出。
 *
 * 两个必须做到的性质：
 *   1. **配置隔离** —— MN_WS_HOME 指向临时目录，读不到本机真实配置（见 SMOKE_HOME 注释）
 *   2. **有兜底超时** —— 子进程不退出就判失败。
 *      没有超时的话，一条「本该退出却没退出」的用例会把整个套件挂死，
 *      而"挂死"在 CI 上表现为**任务超时**，看不出是哪条用例出的问题。
 */
function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, MN_WS_HOME: SMOKE_HOME, ...(opts.env || {}) },
    });
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (code, extraErr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out, err: extraErr ? `${err}${extraErr}` : err });
    };
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => finish(code, ''));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(-1, `\n[超时] 子进程「${args.join(' ')}」超过 ${opts.timeoutMs || 20000}ms 未退出`);
    }, opts.timeoutMs || 20000);
    if (opts.killAfterMs) {
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, opts.killAfterMs);
    }
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers, timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${e && e.message}\n`);
  }
}

(async () => {
  process.stdout.write('mn-ws CLI 冒烟\n');
  const nx = await startFakeNx();
  const base = `http://127.0.0.1:${nx.port}`;

  const serverProc = spawn(process.execPath, [
    BIN, 'server', '--host', '127.0.0.1', '--port', String(SERVER_PORT),
    '--token', GATE, '--log-level', 'warn',
  ], { cwd: ROOT, env: { ...process.env, MN_WS_HOME: path.join(ROOT, '.tmp-smoke') } });
  let serverLog = '';
  serverProc.stdout.on('data', (c) => { serverLog += c.toString(); });
  serverProc.stderr.on('data', (c) => { serverLog += c.toString(); });

  const clientProc = spawn(process.execPath, [
    BIN, 'client', '--url', `ws://127.0.0.1:${SERVER_PORT}/ws`,
    '--token', GATE, '--apps', 'nx-test', '--app-map', `nx-test=${base}`,
    '--log-level', 'warn',
  ], { cwd: ROOT, env: { ...process.env, MN_WS_HOME: path.join(ROOT, '.tmp-smoke') } });
  let clientLog = '';
  clientProc.stdout.on('data', (c) => { clientLog += c.toString(); });
  clientProc.stderr.on('data', (c) => { clientLog += c.toString(); });

  await sleep(1800);

  await check('server 起来了', async () => {
    const r = await httpGet(`http://127.0.0.1:${SERVER_PORT}/health`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).ok, true);
  });

  await check('client 注册成功（/stats 能看到 app）', async () => {
    const r = await httpGet(`http://127.0.0.1:${SERVER_PORT}/stats`);
    const j = JSON.parse(r.body);
    assert.ok(j.apps.includes('nx-test'), `apps=${JSON.stringify(j.apps)}`);
  });

  await check('带 L1 门禁头能穿到 nx', async () => {
    const r = await httpGet(`http://127.0.0.1:${SERVER_PORT}/nx-test/api/echo?a=1`, {
      'x-mn-ws-token': GATE,
    });
    assert.strictEqual(r.status, 200, `body=${r.body}`);
    assert.strictEqual(r.headers['x-fake-nx'], 'yes');
    assert.strictEqual(JSON.parse(r.body).url, '/api/echo?a=1');
  });

  await check('不带 L1 门禁头 → 401', async () => {
    const r = await httpGet(`http://127.0.0.1:${SERVER_PORT}/nx-test/api/echo`);
    assert.strictEqual(r.status, 401);
  });

  await check('错误门禁令牌 → 401', async () => {
    const r = await httpGet(`http://127.0.0.1:${SERVER_PORT}/nx-test/api/echo`, {
      'x-mn-ws-token': 'wrong',
    });
    assert.strictEqual(r.status, 401);
  });

  await check('client apps 列出可桥接应用', async () => {
    const r = await run(['client', 'apps', '--apps', 'nx-test', '--app-map', `nx-test=${base}`]);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('nx-test'), r.out);
    assert.ok(r.out.includes('在监听'), r.out);
  });

  await check('client catalog 拉到远端元信息目录', async () => {
    const r = await run(['client', 'catalog', '--url', `ws://127.0.0.1:${SERVER_PORT}/ws`, '--token', GATE]);
    assert.strictEqual(r.code, 0, r.err || r.out);
    assert.ok(r.out.includes('元信息目录'), r.out);
    assert.ok(r.out.includes('nx-test'), r.out);
    assert.ok(r.out.includes('X-Nx-App'), r.out);
  });

  await check('--ports 按端口反查应用名', async () => {
    // 7877 = nx-kv 的已知端口（本机没跑 svc-kv 也没关系：
    // 这里验的是「端口 → 应用名」的反查，不验端口存活）
    const r = await run(['client', 'apps', '--ports', '7877']);
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.out.includes('nx-kv'), r.out);
    assert.ok(r.out.includes('7877'), r.out);
  });

  await check('server 无鉴权时拒绝启动', async () => {
    const r = await run(['server', '--host', '127.0.0.1', '--port', '18792']);
    assert.strictEqual(r.code, 1);
    assert.ok(r.out.includes('拒绝启动'), r.out);
  });

  await check('server 端口被占时明确报错（不静默顺延）', async () => {
    const r = await run(['server', '--host', '127.0.0.1', '--port', String(SERVER_PORT), '--token', GATE]);
    assert.strictEqual(r.code, 1);
    assert.ok(r.out.includes('已被占用'), r.out);
  });

  await check('doctor 能跑完并给出结论', async () => {
    const r = await run(['doctor', '--port', '18793', '--web-port', '18794']);
    assert.ok(r.code === 0 || r.code === 1);
    assert.ok(r.out.includes('端口'), r.out);
  });

  try { clientProc.kill(); } catch { /* ignore */ }
  try { serverProc.kill(); } catch { /* ignore */ }
  await sleep(300);
  await nx.close();

  process.stdout.write(`\n通过 ${passed}，失败 ${failed}\n`);
  if (failed) {
    process.stdout.write(`\n--- server 日志 ---\n${serverLog}\n--- client 日志 ---\n${clientLog}\n`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  process.stderr.write(`冒烟崩溃：${e && e.stack}\n`);
  process.exit(1);
});
