import path from 'node:path';

import { createServer } from './server.js';
import { loadServerConfig, parseArgs, configDir } from './config.js';
import { isPortFree } from './apps.js';

/**
 * mn-ws-server 的 CLI。
 *
 * server 半只有一个职责：把公网 HTTP 请求桥给本机的 nx 服务。
 * 所以这里**不套** client 半那套 action 框架 —— 那套是为「CLI 与 Web 面板
 * 同源」设计的，而 server 半没有面板。一台只有一个动作的服务，
 * 用框架反而是负担。
 *
 * 命令：
 *   mn-ws-server              启动中继服务（公网半，HTTP 与 WS 同端口共存）
 *   mn-ws-server doctor       环境自检（端口占用 / 鉴权配置）
 */

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function say(msg = ''): void {
  process.stdout.write(`${msg}\n`);
}

function printHelp(version: string): void {
  say(`
${C.bold}mn-ws-server${C.reset} v${version} — mn-ws 的 server 半：公网侧的 HTTP ⇄ WebSocket 桥

${C.bold}用法${C.reset}
  npx mn-ws-server [options]

${C.bold}选项${C.reset}
  --host <h>             监听地址（默认 0.0.0.0；无鉴权时只允许 127.0.0.1）
  --port <n>             监听端口（默认 7777）
  --ws-path <p>          WebSocket 路径（默认 /ws）
  --token <TOKEN>        静态注册门禁（与 client 半配同一个）
  --jwt-secret <s>       统一登录的 JWT 签名密钥（配了就启用设备令牌）
  --auth-enabled <bool>  显式开/关统一登录（1/true/yes/on 与 0/false/no/off）
  --issuer <url>         认证中心地址（默认 http://47.110.80.47:8082）
  --idp-client-id <id>   server 半在认证中心的身份（默认 mn-ws-server）
  --login-client-id <id> client 半在认证中心的身份（默认 mn-ws-client）
  --insecure             允许无鉴权启动（**仅限本机自测**）
  --log-level <level>    debug | info | warn | error（默认 info）
  --help                 显示帮助
  --version              显示版本
`);
}

/**
 * 启动 server 半。
 *
 * 三道安全闸（顺序不能换）：
 *   1. 无鉴权 → 拒绝启动（这个服务能把本机十几个服务桥到公网）
 *   2. 无鉴权 → 不许绑 0.0.0.0
 *   3. 端口被占 → 明确报错退出，**不静默顺延**
 */
export async function runServerCli(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  const version = (await readVersion()) || '0.0.0';

  if (flags.version) { say(version); return; }
  if (flags.help || positional[0] === 'help') { printHelp(version); return; }
  if (positional[0] === 'doctor') { await runDoctor(argv); return; }
  if (positional.length) {
    say(`${C.red}未知命令：${positional.join(' ')}${C.reset}`);
    printHelp(version);
    process.exitCode = 1;
    return;
  }

  const cfg = loadServerConfig(flags);

  // ── 闸 1：没有鉴权就不许起 ──
  const hasGate = !!cfg.token;
  const hasJwt = !!cfg.jwtSecret;
  const wantAuth = cfg.authEnabled === undefined ? hasJwt : cfg.authEnabled;

  if (wantAuth && !hasJwt) {
    say(`${C.red}✗ 拒绝启动：统一登录已开启，但没有 JWT secret${C.reset}`);
    say(`${C.dim}签不出设备令牌 = 统一登录等于没开。给一个随机串，或把 MN_WS_AUTH_ENABLED 关掉。${C.reset}`);
    process.exitCode = 1;
    return;
  }
  if (!wantAuth && hasJwt) {
    say(`${C.yellow}! 统一登录已显式关闭${C.reset}${C.dim}，JWT secret 不会生效${C.reset}`);
  }
  if (!hasGate && !wantAuth && !cfg.insecure) {
    say(`${C.red}✗ 拒绝启动：没有任何鉴权配置${C.reset}`);
    say(`${C.dim}mn-ws server 会把本机的 nx 服务桥到公网，没有鉴权等于把整台机器挂在网上。${C.reset}`);
    say('');
    say(`  ${C.cyan}--token <TOKEN>${C.reset}    与客户端配同一个静态门禁`);
    say(`  ${C.cyan}MN_WS_JWT_SECRET=<随机>${C.reset}  启用统一登录（推荐，可按用户隔离）`);
    say(`  ${C.cyan}--insecure${C.reset}          仅限本机自测，明知风险才用`);
    process.exitCode = 1;
    return;
  }
  if (!hasGate && !wantAuth && cfg.insecure) {
    say(`${C.yellow}! 已用 --insecure：无鉴权启动${C.reset}${C.dim} —— 任何人都能通过它调用本机服务${C.reset}`);
  }

  // ── 闸 2：无鉴权时只许绑回环 ──
  if (cfg.host === '0.0.0.0' && !hasGate && !wantAuth) {
    say(`${C.red}✗ 无鉴权时不允许绑 0.0.0.0${C.reset}：请用 --host 127.0.0.1 自测`);
    process.exitCode = 1;
    return;
  }

  // ── 闸 3：端口被占 → 明确报错，不静默顺延 ──
  const free = await isPortFree(cfg.port, cfg.host === '0.0.0.0' ? '0.0.0.0' : cfg.host);
  if (!free.free) {
    say(`${C.red}✗ 端口 ${cfg.port} 已被占用${C.reset}${C.dim}（${(free.error && free.error.code) || ''}）${C.reset}`);
    say(`${C.dim}换端口：--port <n>。不静默顺延 —— 客户端还按 ${cfg.port} 连，顺延只会让两边对不上账。${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer({
    host: cfg.host,
    port: cfg.port,
    wsPath: cfg.wsPath,
    token: cfg.token,
    issuer: cfg.issuer,
    idpClientId: cfg.idpClientId,
    loginClientId: cfg.loginClientId,
    redirectUri: cfg.redirectUri || `http://127.0.0.1:${cfg.port}/auth/callback`,
    jwtSecret: cfg.jwtSecret,
    authEnabled: wantAuth,
    insecure: cfg.insecure,
    requestTimeoutMs: cfg.requestTimeoutMs,
    dataDir: cfg.dataDir,
    logLevel: cfg.logLevel,
  });

  const actual = await server.listen();
  say(`${C.green}✓ mn-ws server 已启动${C.reset}  http://${cfg.host}:${actual}  ws=${cfg.wsPath}`);
  say(`${C.dim}  鉴权：${wantAuth ? '统一登录（设备令牌）' : ''}${wantAuth && hasGate ? ' + ' : ''}${hasGate ? '静态门禁' : ''}${!wantAuth && !hasGate ? '无（--insecure）' : ''}${C.reset}`);
  say(`${C.dim}  配置目录：${configDir()}${C.reset}`);

  const shutdown = async (sig: string): Promise<void> => {
    say(`\n${C.dim}收到 ${sig}，正在关闭…${C.reset}`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

/** 环境自检。 */
async function runDoctor(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const cfg = loadServerConfig(flags);

  say(`${C.bold}mn-ws-server doctor${C.reset}  ${C.dim}v${(await readVersion()) || '0.0.0'}${C.reset}`);
  say('');
  say(`${C.bold}端口${C.reset}`);
  const free = await isPortFree(cfg.port, cfg.host === '0.0.0.0' ? '0.0.0.0' : cfg.host);
  say(free.free
    ? `  server :${cfg.port}  ${C.green}空闲${C.reset}`
    : `  server :${cfg.port}  ${C.red}已被占用${C.reset}`);
  say('');
  say(`${C.bold}鉴权${C.reset}`);
  if (cfg.jwtSecret) say(`  ${C.green}✓${C.reset} 统一登录密钥已配置`);
  else say(`  ${C.yellow}!${C.reset} 未配置统一登录密钥（MN_WS_JWT_SECRET）`);
  if (cfg.token) say(`  ${C.green}✓${C.reset} 静态门禁 token（共享密钥，等价全量访问）`);
  else say(`  ${C.yellow}!${C.reset} 未配置静态门禁（客户端只能用设备令牌注册）`);
  say('');
  say(`${C.bold}身份${C.reset}`);
  say(`  issuer              ${cfg.issuer}`);
  say(`  server 半 client_id ${cfg.idpClientId}`);
  say(`  client 半 client_id ${cfg.loginClientId}`);
  say('');
  say(`${C.dim}  数据目录：${path.join(configDir(), 'data')}${C.reset}`);
}

async function readVersion(): Promise<string | null> {
  try {
    const fs = await import('node:fs');
    const url = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(url, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version || null;
  } catch {
    return null;
  }
}
