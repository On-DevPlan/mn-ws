// dev 启动器：一条命令起 Rust client 面板 + vite dev（HMR），一个 ctrl-c 一起退。
//
// Rust 化后的开发流：后端是 Rust 二进制（/api + 桥），前端走 vite dev 的
// 模块热替换 —— 浏览器开的是 vite 端口，/api 由 vite 代理到 Rust 进程。
//
// 约定与旧版（TS 时代）一致的关键点：
//   1. 后端端口先谈定再起进程 —— vite 的代理目标与 serve 实际监听的端口
//      必须是同一个；放任顺延的话页面能开、数据全错，比报错更难查
//   2. vite 必须 --host 127.0.0.1 —— Node 18+ 默认监听 [::1]，curl 127.0.0.1 会 ECONNREFUSED
//   3. 一个 ctrl-c 关两个：任意信号都转发 SIGTERM 给子进程再自己退
//
// 用法：pnpm dev
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const isWin = process.platform === 'win32';

const binary = path.join(pkgRoot, 'bin', isWin ? 'mn-ws.exe' : 'mn-ws');
if (!fs.existsSync(binary)) {
  console.error('Rust 产物不存在：' + binary);
  console.error('先构建：pnpm build:rust && pnpm build:dist');
  process.exit(1);
}

/** 找一个空闲端口（后端用；前端端口固定 7930）。 */
function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
    setTimeout(() => reject(new Error('找不到空闲端口')), 10_000).unref();
  });
}

const kids = [];
function shutdown() {
  for (const k of kids) {
    try { k.kill('SIGTERM'); } catch { /* 已退 */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const backendPort = await freePort(7781);
const webDir = path.join(pkgRoot, 'dist', 'web', 'public');

console.log(`[dev] Rust client 面板 :${backendPort}（/api）`);
const backend = spawn(binary, ['serve', '--port', String(backendPort), '--no-open'], {
  env: { ...process.env, ...(fs.existsSync(path.join(webDir, 'index.html')) ? { MN_WS_WEB_DIR: webDir } : {}) },
  stdio: 'inherit',
});
kids.push(backend);
backend.on('exit', (code) => {
  if (code !== 0 && code !== null) shutdown();
});

console.log('[dev] vite dev :7930（面板 + HMR，/api 代理到上面的端口）');
const vite = spawn(
  process.execPath,
  [path.join(pkgRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '7930'],
  { env: { ...process.env, MN_WS_PORT: String(backendPort) }, stdio: 'inherit', cwd: pkgRoot },
);
kids.push(vite);
vite.on('exit', shutdown);
