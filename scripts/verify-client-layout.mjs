// client 包的**布局**验证：装出来的包能不能让 Rust 二进制伺服 React 产物。
//
// ## 为什么单独验
//
// `mn-ws` 包依赖 `mn-ws-server`（同版本）—— 首版发布时 server 半还没上 npm，
// 装 client 会 ETARGET。所以 client 的**安装**要等发布后。
//
// 但**布局**不用等 —— 它跟 npm 无关：Rust 的 `web_dir()` 按
// 「可执行文件同级 web/public」找产物。这个脚本直接造出那个布局来验证：
//
//   <root>/bin/mn-ws[.exe]      ← 二进制
//   <root>/web/public/index.html ← React 产物
//
// 跑法：node scripts/verify-client-layout.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'mn-ws.exe' : 'mn-ws';

console.log('client 包布局验证：二进制 + web/public 并排');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ws-layout-'));
const binDir = path.join(tmp, 'bin');
const webDir = path.join(tmp, 'web', 'public');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });

// 造出发布布局
const srcBin = path.join(repoRoot, 'rust', 'target', 'release', BIN_NAME);
if (!fs.existsSync(srcBin)) {
  console.log(`  ✗ Rust 产物不存在：${srcBin}`);
  console.log('    先构建：cd rust && cargo build --release');
  process.exit(1);
}
fs.copyFileSync(srcBin, path.join(binDir, BIN_NAME));

const srcWeb = path.join(repoRoot, 'client', 'dist', 'web', 'public');
if (!fs.existsSync(path.join(srcWeb, 'index.html'))) {
  console.log(`  ✗ React 产物不存在：${srcWeb}`);
  console.log('    先构建：pnpm --filter mn-ws build');
  process.exit(1);
}
fs.cpSync(srcWeb, webDir, { recursive: true });

// 起面板（后台，不设 MN_WS_WEB_DIR —— 要测的正是「按发布布局找产物」这条路径）
const port = 7921 + Math.floor(Math.random() * 200);
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });
const proc = spawn(path.join(binDir, BIN_NAME), ['serve', '--port', String(port), '--no-open'], {
  env: { ...process.env, MN_WS_HOME: home },
  stdio: 'ignore',
});

const cleanup = () => {
  try { proc.kill(); } catch { /* ignore */ }
};
process.on('exit', cleanup);

try {
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  check('面板起来了（按发布布局找到 React 产物）', up, `端口 ${port}`);

  if (up) {
    const index = await fetch(`${base}/`);
    const html = await index.text();
    check(
      '首页 200 且是 HTML',
      index.status === 200 && html.includes('<div id="root"'),
      `status=${index.status} ${html.slice(0, 100)}`,
    );

    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    check('index.html 引用了构建产物', assets.length > 0, html.slice(0, 200));
    for (const a of assets) {
      const r = await fetch(base + a);
      check(`产物 ${a} 可取（${r.status}）`, r.status === 200);
    }
  }
} finally {
  cleanup();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exit(failures === 0 ? 0 : 1);
