// Rust client 面板实测：真的起面板，打全部 API 端点。
//
// ## 为什么要有这个
//
// 面板是 React 前端，它只通过 `/api/*` 与 Rust 进程说话。
// 「前端能跑」这件事没法靠单测证明 —— 得真的把面板产物伺服起来，
// 真的把每个端点打一遍，看返回的形状对不对。
//
// 它验的是：
//   1. React 构建产物能被伺服（首页 200、JS/CSS 200、SPA fallback 200）
//   2. 每个 `/api/*` 端点都存在且返回 `{ok:true,data}` 或 `{ok:false,error,code}`
//   3. 静态资源与 API 不打架（/api/* 不会被当成静态文件）
//
// 跑法（从 client 目录）：
//   node --import tsx tests/panel-check.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const EXE = path.join(
  repoRoot,
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'mn-ws.exe' : 'mn-ws',
);
const WEB_DIR = path.join(repoRoot, 'client', 'dist', 'web', 'public');

/** 起 Rust client 面板（独立配置目录，别动用户的真配置）。 */
function startPanel(port) {
  // os.tmpdir() 跨平台：Windows 的 TEMP 与 Linux 的 TMPDIR 都认
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-panel-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      apps: ['demo-api'],
      appMap: { 'demo-api': { base: 'http://127.0.0.1:9911' } },
      url: 'ws://127.0.0.1:7777/ws',
      clientId: 'panel-check',
      deviceName: '面板自测',
      serverHttp: 'http://127.0.0.1:7777',
    }),
  );
  const child = spawn(
    EXE,
    ['serve', '--port', String(port), '--no-open'],
    {
      env: { ...process.env, MN_WS_HOME: home, MN_WS_WEB_DIR: WEB_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return {
    child,
    home,
    get output() { return out; },
    kill() { try { child.kill(); } catch { /* ignore */ } },
  };
}

async function waitFor(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function main() {
  console.log('Rust client 面板实测：伺服 React 产物 + 全部 API 端点');

  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    console.log(`  ✗ React 产物不存在：${WEB_DIR}`);
    console.log('    先构建：pnpm --filter mn-ws build');
    process.exit(1);
  }

  const port = 7801;
  const panel = startPanel(port);
  const base = `http://127.0.0.1:${port}`;

  try {
    const up = await waitFor(port);
    check('Rust client 面板起来了', up, panel.output.slice(0, 400));
    if (!up) return;

    // ── ① 静态资源：React 产物被伺服 ──
    const index = await fetch(`${base}/`);
    const html = await index.text();
    check('首页 200', index.status === 200, String(index.status));
    check('首页是 HTML', html.includes('<div id="root"') || html.includes('<script'), html.slice(0, 120));

    // 从 index.html 里找出 JS/CSS 的路径，逐个验证
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    check('index.html 引用了构建产物', assets.length > 0, html.slice(0, 300));
    for (const a of assets) {
      const r = await fetch(base + a);
      check(`产物 ${a} 可取`, r.status === 200, String(r.status));
    }

    // SPA fallback：未知路径回 index.html（前端路由要靠它）
    const spa = await fetch(`${base}/some/client/route`);
    check('SPA fallback 200', spa.status === 200, String(spa.status));

    // 越界读必须被拒
    const traversal = await fetch(`${base}/../../package.json`);
    check('路径越界被拒', traversal.status !== 200 || !(await traversal.text()).includes('"name"'), String(traversal.status));

    // ── ② 全部 API 端点 ──
    const endpoints = [
      ['GET', '/api/bootstrap'],
      ['GET', '/api/routes'],
      ['GET', '/api/health'],
      ['GET', '/api/settings'],
      ['GET', '/api/auth/status'],
      ['GET', '/api/auth/accounts'],
      ['GET', '/api/bridge/status'],
      ['GET', '/api/bridge/apps'],
      ['GET', '/api/bridge/known'],
    ];
    for (const [method, p] of endpoints) {
      const r = await fetch(base + p, { method });
      const j = await r.json();
      check(
        `${method} ${p} → 200 且形状正确`,
        r.status === 200 && j.ok === true && 'data' in j,
        `status=${r.status} body=${JSON.stringify(j).slice(0, 160)}`,
      );
    }

    // POST / PATCH 端点
    const greet = await fetch(`${base}/api/greet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '小测' }),
    });
    const greetJson = await greet.json();
    check(
      'POST /api/greet → 200',
      greet.status === 200 && greetJson.ok === true && greetJson.data.count >= 1,
      JSON.stringify(greetJson).slice(0, 160),
    );

    const patch = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: 'dark' }),
    });
    const patchJson = await patch.json();
    check(
      'PATCH /api/settings → 200 且主题生效',
      patch.status === 200 && patchJson.ok === true && patchJson.data.settings.theme === 'dark',
      JSON.stringify(patchJson).slice(0, 160),
    );

    const badTheme = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'theme', value: 'purple' }),
    });
    const badJson = await badTheme.json();
    check(
      '非法主题被拒（400 + code）',
      badTheme.status === 400 && badJson.ok === false && !!badJson.code,
      `status=${badTheme.status} body=${JSON.stringify(badJson).slice(0, 160)}`,
    );

    const addApp = await fetch(`${base}/api/bridge/apps/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-api', port: 9912 }),
    });
    const addJson = await addApp.json();
    check(
      'POST /api/bridge/apps/add → 200',
      addApp.status === 200 && addJson.ok === true && addJson.data.app === 'my-api',
      JSON.stringify(addJson).slice(0, 160),
    );

    const known = await fetch(`${base}/api/bridge/known`);
    const knownJson = await known.json();
    check(
      '新登记的应用出现在 known 里',
      knownJson.ok === true &&
        knownJson.data.apps.some((a) => a.app === 'my-api'),
      JSON.stringify(knownJson).slice(0, 200),
    );

    const removeApp = await fetch(`${base}/api/bridge/apps/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-api' }),
    });
    const removeJson = await removeApp.json();
    check(
      'POST /api/bridge/apps/remove → 200',
      removeApp.status === 200 && removeJson.ok === true,
      JSON.stringify(removeJson).slice(0, 160),
    );

    // 不存在的端点要明确 404
    const missing = await fetch(`${base}/api/nope`);
    const missingJson = await missing.json();
    check(
      '不存在的端点 → 404 + code',
      missing.status === 404 && missingJson.ok === false && !!missingJson.code,
      `status=${missing.status} body=${JSON.stringify(missingJson).slice(0, 160)}`,
    );

    // ── OIDC 回调路由：没有进行中的登录时必须明确报出来 ──
    const cb = await fetch(`${base}/callback?code=X&state=Y`);
    const cbText = await cb.text();
    check(
      '/callback 路由存在（无进行中的登录 → 400 + 说明）',
      cb.status === 400 && cbText.includes('登录失败'),
      `status=${cb.status} body=${cbText.slice(0, 160)}`,
    );
    // 授权被拒时是 200 + 「授权未通过」
    const cbErr = await fetch(`${base}/callback?error=access_denied`);
    const cbErrText = await cbErr.text();
    check(
      '/callback 收到 error → 200 + 授权未通过',
      cbErr.status === 200 && cbErrText.includes('授权未通过'),
      `status=${cbErr.status} body=${cbErrText.slice(0, 160)}`,
    );
  } finally {
    panel.kill();
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
