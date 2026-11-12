// dev 启动器：一条命令起 vite + 后端 serve，一个 ctrl-c 一起退。
//
// 为什么需要它：`pnpm dev` 若只起 vite，后端得另开终端跑 dev:serve——
// 两边端口、生命周期、日志各自为政，关的时候还容易漏一个。
//
// 关键决策（照 A08-framework-runtime 的规范，别即兴发挥）：
//   1. vite ready 之后再起 serve —— 反过来 vite 的 ready 行会被 serve 早期噪音吞掉
//   2. 直接 spawn node 二进制，不走 `npm run` —— Windows 上调 npm.cmd 时参数会被
//      cmd.exe 重排/截断（`npm.cmd dev:serve` 会被理解成 npm 自己的 --silent 子命令）
//   3. vite 必须 --host 127.0.0.1 —— Node 18+ 默认监听 [::1]，curl 127.0.0.1 会 ECONNREFUSED
//   4. 一个 ctrl-c 关两个：任意信号都转发 SIGTERM 给子进程再自己退
//   5. **后端端口先谈定再起进程** —— vite 的代理目标与 serve 实际监听的端口必须是同一个；
//      放任 serve 自己顺延的话，dev 前端会去连别人的服务——页面能开、数据全错，比报错更难查
//
// 本脚本要 import TS 源码（core/serve-port.ts），所以 `dev` 脚本走 `node --import tsx`。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePanel, findFreePort, autoOpenEnabled } from '../src/core/serve-port.ts';
import { openBrowser } from '../src/core/open.ts';
import { APP_NAME } from '../src/core/paths.ts';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const NODE = process.execPath;

const DESIRED_BACKEND_PORT = Number(process.env.MN_WS_PORT) || 7777;
const VITE_PORT = Number(process.env.MN_WS_VITE_PORT) || 7930;

const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(VITE_BIN)) {
  console.error(`未找到 vite：${VITE_BIN}\n先跑 pnpm install。`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function start(name, args, env) {
  const child = spawn(NODE, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    // Windows 上 node 可直接 spawn，不需要 shell —— 加了 shell 反而会重新引入参数重排
    shell: false,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} 退出（code=${code}${signal ? ', signal=' + signal : ''}），一并关闭另一个。`);
    shutdown(code ?? 1);
  });
  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

// 端口是否已经被占着。
async function portBusy(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

// 等端口就绪：轮询直到不再 ECONNREFUSED。
// 通用实现（等任意端口）而非只等 vite——后端也可能需要等。
async function waitForPort(port, { tries = 60, gapMs = 250 } = {}) {
  const net = await import('node:net');
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 400);
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

// ---- 后端端口：先问「上面跑的是不是我」，再决定复用还是顺延 ----
//
// 端口被占绝大多数情况不是故障，是「我自己已经开着一个」（上次没退干净 / 手滑起了两个）。
//   1. 占着的是本项目自己的面板 → 复用它，不再起第二个 serve
//   2. 占着的是别的服务 → 顺延到下一个空闲端口
// 两种情况都把浏览器指到 dev 地址——端口被占过就别让用户自己找面板在哪。
let BACKEND_PORT = DESIRED_BACKEND_PORT;
let reuseBackend = false;
let backendOccupied = false;

if (await portBusy(DESIRED_BACKEND_PORT)) {
  backendOccupied = true;
  const panel = await probePanel(DESIRED_BACKEND_PORT, '127.0.0.1');
  const occupant = panel && panel.app ? panel.app.name : null;
  if (occupant === APP_NAME) {
    console.log(`[dev] 后端端口 ${DESIRED_BACKEND_PORT} 上已经是本项目的面板，直接复用（不重复启动）。`);
    reuseBackend = true;
  } else {
    // 顺延时跳过 vite 端口：它虽然还没起，但马上就要用。
    let next = await findFreePort(DESIRED_BACKEND_PORT + 1, '127.0.0.1');
    while (next === VITE_PORT) next = await findFreePort(next + 1, '127.0.0.1');
    console.log(`[dev] 后端端口 ${DESIRED_BACKEND_PORT} 被占用（占用者: ${occupant || '未知服务'}），改用 ${next}。`);
    BACKEND_PORT = next;
  }
}

// vite 端口被占就没法复用（vite 跑在 --strictPort 下），早点说清楚比事后猜强。
// 放在最前面：vite 端口空着，后端顺延时才不会被它顶掉。
if (await portBusy(VITE_PORT)) {
  console.error(`[dev] vite 端口 ${VITE_PORT} 被占用，已中止。`);
  console.error(`      换个端口:  MN_WS_VITE_PORT=${VITE_PORT + 100} pnpm dev`);
  process.exit(1);
}

// vite 的代理目标与 serve 监听的端口必须一致 —— 解析出来的端口同时交给两边。
start('vite', [VITE_BIN, '--host', '127.0.0.1', '--strictPort', '--port', String(VITE_PORT)], {
  MN_WS_PORT: String(BACKEND_PORT),
});
const ready = await waitForPort(VITE_PORT);

if (!ready) {
  console.error(`[dev] vite 没起来（--strictPort：端口 ${VITE_PORT} 被占会直接失败），仍然启动后端；请检查上面的报错。`);
} else {
  console.log(
    `\n[dev] vite 就绪 http://127.0.0.1:${VITE_PORT}  →  后端 http://127.0.0.1:${BACKEND_PORT}\n`
  );
}

// 复用时不再起第二个 serve：那个面板已经在跑，起第二个只会多占一个端口。
if (!reuseBackend) {
  // 端口必须用 --port 明确告诉 serve：serve 只认 flag，不读环境变量。
  // 靠环境变量的话，serve 会去用它的默认端口，而 vite 的代理指着我们解析出来的端口——
  // 两边对不上，dev 前端就会连到占用那个端口的别的服务。
  start('serve', ['--import', 'tsx', join(ROOT, 'src', 'runtime', 'cli.ts'), 'serve', '--no-open', '--port', String(BACKEND_PORT)], {
    MN_WS_PORT: String(BACKEND_PORT),
  });
}

// 端口被占过 → 主动把浏览器指到 dev 地址（端口被占时也自动开浏览器）。
// NX_SERVE_NO_OPEN 是所有 nx-xx 项目共享的关闭开关，这里同样认它。
if (backendOccupied && autoOpenEnabled(false)) {
  openBrowser(`http://127.0.0.1:${VITE_PORT}`);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}
process.stdin.on('close', () => shutdown(0));
