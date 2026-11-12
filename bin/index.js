#!/usr/bin/env node
'use strict';

/**
 * mn-ws CLI 入口。
 *
 * 子命令（命令名与 mn-rt 的 client 保持同一套形状）：
 *   mn-ws server                启动中继服务（公网半，HTTP + WS 同端口）
 *   mn-ws client                启动本机转发（连 server + 注册可桥接应用）
 *   mn-ws client web            本地 Web 面板（只监听 127.0.0.1）
 *   mn-ws client apps           列出可桥接的应用（白名单 + 端口存活）
 *   mn-ws client status         查看桥接连接状态
 *   mn-ws client catalog        拉取远端元信息目录（登录后看哪些能路由）
 *   mn-ws auth login            统一登录（go-ah auth-hub）：免掉人工复制令牌
 *   mn-ws auth list|switch      多人共用一台机器：查看 / 切换本机已存账号
 *   mn-ws auth status|logout    查看 / 清除本机登录凭据
 *   mn-ws doctor                环境自检（端口 / 鉴权 / 应用可达性）
 *
 * 全局参数：
 *   --url <ws://...>      server 半地址（client 用）
 *   --server-http <url>   统一登录用的 HTTP 基址（默认从 --url 推导）
 *   --host <h>            监听地址（server 默认 0.0.0.0；本地面板固定 127.0.0.1）
 *   --port <n>            server 监听端口（默认 7777）
 *   --web-port <n>        本地面板端口（默认 7777）
 *   --token <TOKEN>       注册门禁（与 server 侧 MN_WS_TOKEN 一致）
 *   --apps <a,b,c>        只桥接这些应用（**白名单**，不给就一个都不桥）
 *   --device-name <名>    桥的显示名
 *   --no-open             auth login 只打印授权地址、不弹浏览器
 *   --insecure            server 允许无鉴权启动（**仅限本机自测**）
 *   --auth-enabled <bool> 显式开/关统一登录（默认跟随「配没配 MN_WS_JWT_SECRET」）
 *   --log-level <level>   debug | info | warn | error
 *   --help / --version
 */

const path = require('node:path');

const { Logger } = require('../lib/logger');
const { scanApps, isPortFree, KNOWN_APPS } = require('../lib/apps');
const {
  DEFAULT_SERVE_URL, configDir, parseArgs, loadConfig, placeholderUrlReason,
  readConfigFile, ensureClientId, withAccounts, listAccounts, labelOf, entryKeyOf,
  saveAuthAccount, switchActiveAccount, clearAuthCredentials, saveConnectionConfig,
} = require('../lib/config');
const { authLogin, getJson } = require('../lib/auth');
const { createServer } = require('../server/server');
const { WsBridgeClient } = require('../client/ws-client');
const { startWebPanel } = require('../client/web');

const pkg = require('../package.json');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function printHelp() {
  say(`
${C.bold}mn-ws${C.reset} v${pkg.version} — HTTP ⇄ WebSocket 双向桥（把本机 nx 服务桥给远端客户端）

${C.bold}用法${C.reset}
  npx mn-ws <command> [options]

${C.bold}命令${C.reset}
  ${C.cyan}(无命令)${C.reset}           显示本帮助
  ${C.cyan}server${C.reset}               启动中继服务（公网半）：HTTP 与 WS 同端口共存
  ${C.cyan}client${C.reset}               启动本机转发：连上 server 并注册可桥接的应用
  ${C.cyan}client web${C.reset}           本地 Web 面板（只监听 127.0.0.1）
  ${C.cyan}client apps${C.reset}          列出可桥接的应用（白名单 + 本地端口存活探测）
  ${C.cyan}client status${C.reset}        查看桥接连接状态
  ${C.cyan}client catalog${C.reset}       拉取远端元信息目录（登录后看哪些能路由）
  ${C.cyan}auth login${C.reset}           统一登录（弹浏览器）：换回设备令牌，之后免手填
  ${C.cyan}auth login --new-account${C.reset}  换人登录：强制认证中心重新登录
  ${C.cyan}auth list${C.reset}            列出本机已存账号
  ${C.cyan}auth switch${C.reset} <账号>    切换当前生效账号
  ${C.cyan}auth status${C.reset}          查看当前身份、令牌剩余有效期
  ${C.cyan}auth logout${C.reset}          清除当前账号的登录凭据（--all 清空全部）
  ${C.cyan}doctor${C.reset}               环境自检：端口 / 鉴权 / 应用可达性

${C.bold}选项${C.reset}
  --url <ws://...>       server 半地址（默认 ${DEFAULT_SERVE_URL}）
  --server-http <url>    统一登录用的 HTTP 基址（默认从 --url 推导）
  --host <h>             监听地址（server 默认 0.0.0.0；本地面板固定 127.0.0.1）
  --port <n>             server 监听端口（默认 7777）
  --web-port <n>         本地面板端口（默认 7777）
  --token <TOKEN>        注册门禁（server 侧 MN_WS_TOKEN 一致）
  --apps <a,b,c>         只桥接这些应用（白名单；不给就一个都不桥）
  --ports <p,q>          只桥接这些本地端口（从已知表反查应用名）
  --app-map <a=url,...>  指定应用的本地基址（如 nx-kv=http://127.0.0.1:7999）
  --device-name <名>     桥的显示名
  --no-open              auth login 只打印授权地址、不弹浏览器
  --insecure             server 允许无鉴权启动（仅限本机自测）
  --auth-enabled <bool>  显式开/关统一登录（1/true/yes/on 与 0/false/no/off）
  --log-level <level>    debug | info | warn | error（默认 info）
  --help                 显示帮助
  --version              显示版本

${C.bold}示例${C.reset}
  npx mn-ws server --port 7777 --token SECRET            # 公网侧起中继
  npx mn-ws auth login --url ws://1.94.101.189:7777/ws   # 统一登录
  npx mn-ws client --apps nx-kv,nx-rh                   # 本机转发这两个应用
  npx mn-ws client web                                   # 本地面板看看哪些能桥
  npx mn-ws doctor                                       # 上线前自检
`);
}

function printVersion() {
  say(`mn-ws v${pkg.version} (${process.platform}-${process.arch}, node ${process.version})`);
}

/**
 * 把白名单解析成 { app -> base }；不给就空表（= 一个都不桥）。
 *
 * 两种指定方式：
 *   · --apps nx-kv,nx-rh          按应用名
 *   · --ports 7877,7800            按端口（从已知表反查应用名 —— 用户看到的是端口）
 *   · --app-map nx-kv=http://…     自定义基址（端口改了、容器映射等）
 */
function resolveApps(cfg) {
  const wanted = new Set(cfg.apps || []);

  // 按端口反查应用名
  for (const port of cfg.ports || []) {
    const hit = Object.entries(KNOWN_APPS).find(([, info]) => info.port === port);
    if (hit) wanted.add(hit[0]);
    else say(`${C.yellow}! 端口 ${port} 不在已知服务表里${C.reset}${C.dim}（用 --app-map 指定应用名）${C.reset}`);
  }

  const apps = {};
  for (const app of wanted) {
    const base = (cfg.appOverrides && cfg.appOverrides[app] && cfg.appOverrides[app].base)
      || (KNOWN_APPS[app] ? `http://127.0.0.1:${KNOWN_APPS[app].port}` : null);
    if (base) apps[app] = base;
    else {
      say(`${C.yellow}! 应用 ${app} 既不在已知表里，也没给 --app-map${C.reset}`);
      say(`${C.dim}  形如：--app-map ${app}=http://127.0.0.1:<端口>${C.reset}`);
    }
  }
  return apps;
}

// ============================ server ============================

async function cmdServer(cfg) {
  // ── 安全闸：没有鉴权就不许起公网监听 ──
  const hasGate = !!cfg.token;
  const hasJwt = !!cfg.jwtSecret;

  // 统一登录的**有效状态**：显式开关优先，没表态就跟随「配没配 JWT secret」。
  //
  // 为什么要有这个显式开关：部署脚本里把 MN_WS_AUTH_ENABLED 写成 1 而实际
  // 生效成「关」，服务照常起、/health 照样绿，而整套按用户隔离的属主判据
  // 静默不存在 —— CI 全绿、人以为开着。开关必须能表达「意图」，
  // 部署侧才有得断言。
  const wantAuth = cfg.authEnabled === undefined ? hasJwt : cfg.authEnabled;

  if (wantAuth && !hasJwt) {
    say(`${C.red}✗ 拒绝启动：统一登录已开启，但没有 MN_WS_JWT_SECRET${C.reset}`);
    say(`${C.dim}签不出设备令牌 = 统一登录等于没开。给一个随机串，或把 MN_WS_AUTH_ENABLED 关掉。${C.reset}`);
    process.exitCode = 1;
    return;
  }
  if (!wantAuth && hasJwt) {
    say(`${C.yellow}! 统一登录已显式关闭${C.reset}${C.dim}，MN_WS_JWT_SECRET 不会生效${C.reset}`);
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
  if (cfg.host === '0.0.0.0' && !hasGate && !wantAuth) {
    say(`${C.red}✗ 无鉴权时不允许绑 0.0.0.0${C.reset}：请用 --host 127.0.0.1 自测`);
    process.exitCode = 1;
    return;
  }

  // ── 端口预检：被占就明确报错，不静默顺延 ──
  const free = await isPortFree(cfg.port, cfg.host === '0.0.0.0' ? '0.0.0.0' : cfg.host);
  if (!free.free) {
    say(`${C.red}✗ 端口 ${cfg.port} 已被占用${C.reset}${C.dim}（${free.error && free.error.code || ''}）${C.reset}`);
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
    redirectUri: cfg.redirectUri || `http://127.0.0.1:${cfg.port}/auth/callback`,
    jwtSecret: cfg.jwtSecret,
    authEnabled: wantAuth,
    insecure: cfg.insecure,
    requestTimeoutMs: cfg.requestTimeoutMs,
    dataDir: path.join(configDir(), 'data'),
    logLevel: cfg.logLevel,
  });

  const actual = await server.listen();
  say(`${C.green}✓ mn-ws server 已启动${C.reset}  http://${cfg.host}:${actual}  ws=${cfg.wsPath}`);
  say(`${C.dim}  鉴权：${wantAuth ? '统一登录（设备令牌）' : ''}${wantAuth && hasGate ? ' + ' : ''}${hasGate ? '静态门禁' : ''}${!wantAuth && !hasGate ? '无（--insecure）' : ''}${C.reset}`);
  say(`${C.dim}  配置目录：${configDir()}${C.reset}`);

  const shutdown = async (sig) => {
    say(`\n${C.dim}收到 ${sig}，正在关闭…${C.reset}`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================ client ============================

async function cmdClient(cfg, rest) {
  const sub = (rest && rest[0]) || '';

  if (sub === 'web') return cmdClientWeb(cfg);
  if (sub === 'apps') return cmdClientApps(cfg);
  if (sub === 'status') return cmdClientStatus(cfg);
  if (sub === 'catalog') return cmdClientCatalog(cfg);

  // ── 启动转发 ──
  const apps = resolveApps(cfg);
  if (!Object.keys(apps).length) {
    say(`${C.yellow}没有指定可桥接的应用${C.reset}：一个都不桥。`);
    say(`${C.dim}用 --apps 指定白名单，例如：npx mn-ws client --apps nx-kv,nx-rh${C.reset}`);
    say(`${C.dim}先看看本机有哪些在跑：npx mn-ws client apps${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const token = cfg.token || cfg.deviceToken || '';
  if (!token) {
    say(`${C.yellow}没有注册令牌${C.reset}：server 半会拒绝注册。`);
    say(`${C.dim}先 npx mn-ws auth login（推荐），或用 --token 传静态门禁${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const logger = new Logger({
    level: cfg.logLevel,
    dir: path.join(configDir(), 'data'),
    name: 'mn-ws-client',
  });

  const client = new WsBridgeClient({
    url: cfg.url,
    token,
    bridgeId: cfg.clientId,
    apps,
    logger,
    onStatus: (s) => {
      if (s.state === 'registered') {
        say(`${C.green}✓ 桥接已注册${C.reset}  应用：${(s.apps || []).join(', ')}`);
      } else if (s.state === 'reconnecting') {
        say(`${C.yellow}…${C.reset} ${s.reason || '重连中'}（${Math.round((s.retryInMs || 0) / 1000)}s 后重试）`);
      }
    },
  });

  client.start();
  say(`${C.bold}mn-ws client${C.reset} → ${cfg.url}`);
  say(`${C.dim}  可桥接：${Object.keys(apps).join(', ')}${C.reset}`);
  say(`${C.dim}  日志目录：${configDir()}${C.reset}`);
  say(`${C.dim}  Ctrl+C 退出（退出即断开，鼠标的蓝牙主机位还给电脑）${C.reset}`);

  process.on('SIGINT', () => {
    client.stop();
    logger.close();
    process.exit(0);
  });
}

async function cmdClientWeb(cfg) {
  const apps = resolveApps(cfg);
  const free = await isPortFree(cfg.webPort, cfg.webHost);
  if (!free.free) {
    say(`${C.red}✗ 面板端口 ${cfg.webPort} 已被占用${C.reset}${C.dim}（${free.error && free.error.code || ''}）${C.reset}`);
    say(`${C.dim}换端口：--web-port <n>${C.reset}`);
    say(`${C.dim}同机同时跑 server 和面板时最容易撞 —— server 默认也占 7777，面板请显式换端口。${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const logger = new Logger({ level: cfg.logLevel, dir: path.join(configDir(), 'data'), name: 'mn-ws-web' });
  const panel = await startWebPanel({
    port: cfg.webPort,
    host: cfg.webHost,
    apps,
    appOverrides: cfg.appOverrides,
    logger,
  });
  say(`${C.green}✓ 本地面板已启动${C.reset}  http://${cfg.webHost}:${panel.port}/`);
  say(`${C.dim}  白名单：${Object.keys(apps).join(', ') || '（空 —— 用 --apps 指定）'}${C.reset}`);
  say(`${C.dim}  面板只监听 ${cfg.webHost}，不对外暴露${C.reset}`);
  process.on('SIGINT', async () => {
    await panel.close();
    logger.close();
    process.exit(0);
  });
}

async function cmdClientApps(cfg) {
  const configured = resolveApps(cfg);
  const names = Object.keys(configured);
  if (!names.length) {
    say(`${C.yellow}当前没有白名单${C.reset}：用 --apps 指定要桥接的应用。`);
    say(`${C.dim}本机已知的 nx 服务（端口来自各仓 core/paths.js）：${C.reset}`);
    for (const [app, info] of Object.entries(KNOWN_APPS)) {
      say(`  ${C.cyan}${app.padEnd(10)}${C.reset}${info.port}  ${info.title}`);
    }
    return;
  }
  const list = await scanApps({
    host: '127.0.0.1',
    apps: names,
    overrides: cfg.appOverrides,
  });
  say(`${C.bold}可桥接的应用${C.reset}`);
  for (const a of list) {
    const mark = a.alive ? `${C.green}✓ 在监听${C.reset}` : `${C.yellow}✗ 未运行${C.reset}`;
    say(`  ${C.cyan}${a.app.padEnd(10)}${C.reset}${String(a.port).padEnd(7)}${mark}  ${a.base}  ${a.title}`);
  }
  const dead = list.filter((a) => !a.alive);
  if (dead.length) {
    say(`${C.dim}未运行的应用桥过去也会 502（bridge_offline）—— 先把对应服务起起来。${C.reset}`);
  }
}

async function cmdClientCatalog(cfg) {
  const base = (cfg.serverHttp || '').replace(/\/+$/, '');
  const token = cfg.token || cfg.deviceToken || '';
  if (!base) {
    say(`${C.red}缺少服务端地址${C.reset}：--url 或配置文件里给一个`);
    process.exitCode = 1;
    return;
  }
  if (!token) {
    say(`${C.red}缺少凭据${C.reset}：npx mn-ws auth login，或用 --token 传门禁`);
    process.exitCode = 1;
    return;
  }
  let res;
  try {
    res = await getJson(`${base}/api/catalog`, { headers: { 'X-Mn-Ws-Token': token } });
  } catch (e) {
    say(`${C.red}✗ 连不上 ${base}${C.reset}：${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!res.status || res.status >= 400 || !res.json || !res.json.ok) {
    say(`${C.red}✗ 拉目录失败${C.reset}：${(res.json && res.json.error) || `HTTP ${res.status}`}`);
    process.exitCode = 1;
    return;
  }
  const list = res.json.apps || [];
  say(`${C.bold}元信息目录${C.reset}（${base}/api/catalog，共 ${list.length} 个可路由）`);
  if (!list.length) {
    say(`${C.dim}当前没有可路由的应用 —— 检查 client 侧的 --apps / --ports 白名单。${C.reset}`);
    return;
  }
  for (const a of list) {
    say(`  ${C.cyan}${a.app.padEnd(10)}${C.reset}${String(a.port ?? '—').padEnd(7)}${a.title}  ${C.dim}${a.bridgeId}${C.reset}`);
  }
  say('');
  say(`${C.dim}调用方式（二选一）：${C.reset}`);
  say(`${C.dim}  路径前缀：curl -H 'X-Mn-Ws-Token: $TOKEN' '${base}/${list[0].app}/api/...${C.reset}`);
  say(`${C.dim}  请求头：  curl -H 'X-Mn-Ws-Token: $TOKEN' -H 'X-Nx-App: ${list[0].app}' '${base}/api/...${C.reset}`);
}

function cmdClientStatus(cfg) {
  const raw = readConfigFile();
  const view = withAccounts(raw, { defaultClientId: ensureClientId() });
  const list = listAccounts(view);
  say(`${C.bold}mn-ws 状态${C.reset}`);
  say(`  server    ${cfg.url}`);
  say(`  标识      ${cfg.clientId}`);
  say(`  白名单    ${(cfg.apps || []).join(', ') || '（空）'}`);
  if (!cfg.token && !cfg.deviceToken) {
    say(`  ${C.yellow}未登录：无注册令牌，server 半会拒绝注册${C.reset}`);
  } else if (cfg.deviceToken) {
    const days = cfg.tokenExpiresAt
      ? Math.round((cfg.tokenExpiresAt - Date.now()) / 86400000)
      : null;
    say(`  登录态    设备令牌${days !== null ? `（约 ${days} 天后过期）` : ''}`);
  } else {
    say(`  登录态    静态门禁 token`);
  }
  if (list.length) {
    say(`  已存账号  ${list.length} 个（当前：${labelOf((view.accounts[view.activeAccountKey] || {}))}）`);
  }
  say(`${C.dim}  配置目录：${configDir()}${C.reset}`);
}

// ============================ auth ============================

async function cmdAuth(cfg, rest, flags = {}) {
  const action = (rest && rest[0]) || 'status';
  const target = rest && rest[1];

  if (action === 'login') {
    if (!cfg.serverHttp) {
      say(`${C.red}缺少服务端地址${C.reset}：先用 --url ws://<host>:<port>/ws 连一次，或设 MN_WS_SERVER_HTTP`);
      process.exitCode = 1;
      return;
    }
    const badUrl = placeholderUrlReason(cfg.serverHttp) || placeholderUrlReason(cfg.url);
    if (badUrl) {
      say(`${C.red}✗ 服务端地址无效${C.reset}：${badUrl}`);
      say(`${C.dim}带上真实地址重试：npx mn-ws auth login --url ws://<服务器>:7777/ws${C.reset}`);
      process.exitCode = 1;
      return;
    }
    say(`${C.dim}服务端：${cfg.serverHttp}${C.reset}`);

    const rawCfg = readConfigFile();
    const view = withAccounts(rawCfg, { defaultClientId: ensureClientId() });

    let res;
    try {
      res = await authLogin({
        serverHttp: cfg.serverHttp,
        clientId: cfg.clientId,
        deviceName: cfg.deviceName,
        noOpen: cfg.noOpen === true,
        promptLogin: flags.newAccount === true,
        onUrl: (url) => {
          say('');
          say(`${C.yellow}请在弹出的浏览器里完成统一登录${C.reset}（未自动弹出就手动打开下面地址）`);
          if (flags.newAccount === true) {
            say(`${C.dim}已带 prompt=login：认证中心会要求重新登录账号${C.reset}`);
          } else if (listAccounts(view).length >= 1) {
            say(`${C.dim}换个人登录：改用 npx mn-ws auth login --new-account${C.reset}`);
          }
          say(`${C.dim}${url}${C.reset}`);
          say('');
          say(`${C.dim}等待授权回调…（5 分钟超时）${C.reset}`);
        },
      });
    } catch (e) {
      say(`${C.red}✗ 登录失败${C.reset}：${e.message}`);
      process.exitCode = 1;
      return;
    }

    const accountEntry = {
      userId: res.userId,
      email: res.email,
      username: res.username,
      nickname: res.nickname,
      deviceToken: res.token,
      expiresAt: res.tokenExpiresAt,
      url: cfg.url,
      serverHttp: cfg.serverHttp,
      deviceName: res.deviceName || cfg.deviceName,
      clientId: res.clientId || cfg.clientId,
      loginAt: Date.now(),
    };
    const sameAsBefore = Boolean(
      view.activeAccountKey && view.activeAccountKey === entryKeyOf(accountEntry));
    const saved = saveAuthAccount({ entry: accountEntry, setActive: true });
    const storedCount = listAccounts(withAccounts(readConfigFile(), {})).length;

    say(`${C.green}✓ 登录成功${C.reset}：${labelOf(accountEntry)}`);
    if (accountEntry.email) say(`  邮箱    ${accountEntry.email}`);
    say(`  本机标识 ${accountEntry.clientId}    设备名 ${accountEntry.deviceName}`);
    if (res.tokenExpiresAt) {
      const days = Math.round((res.tokenExpiresAt - Date.now()) / 86400000);
      say(`${C.dim}设备令牌有效期约 ${days} 天，过期后重新执行 npx mn-ws auth login${C.reset}`);
    }
    say(`${C.dim}已保存 → ${saved.file}${C.reset}`);
    if (sameAsBefore) {
      say(`${C.yellow}! 认证中心那边仍登录着同一个账号${C.reset}`
        + `${C.dim}（浏览器里有会话，授权是自动过的）。本意是换个人登录的话：先在浏览器里退出该账号${C.reset}`);
    }
    if (storedCount >= 2) {
      say(`${C.dim}本机已存 ${storedCount} 个账号：npx mn-ws auth list 查看，npx mn-ws auth switch <账号> 切换${C.reset}`);
    }
    say(`${C.green}现在直接 npx mn-ws client --apps <应用> 即可启动${C.reset}`);
    return;
  }

  if (action === 'list') {
    const view = withAccounts(readConfigFile(), { defaultClientId: ensureClientId() });
    const list = listAccounts(view);
    if (!list.length) {
      say(`${C.yellow}本机还没有已存账号${C.reset}：先执行 npx mn-ws auth login`);
      return;
    }
    say(`${C.bold}本机已存账号${C.reset}（共 ${list.length} 个）`);
    list.forEach((a, i) => printAccountLine(i + 1, a, a.key === view.activeAccountKey));
    say(`${C.dim}切换：npx mn-ws auth switch <序号|邮箱|用户名|昵称>${C.reset}`);
    return;
  }

  if (action === 'switch') {
    const view = withAccounts(readConfigFile(), { defaultClientId: ensureClientId() });
    const list = listAccounts(view);
    if (!list.length) {
      say(`${C.yellow}本机还没有已存账号${C.reset}：先执行 npx mn-ws auth login`);
      process.exitCode = 1;
      return;
    }
    if (!target) {
      say(`${C.yellow}未指定要切换到的账号${C.reset}。本机已存：`);
      list.forEach((a, i) => printAccountLine(i + 1, a, a.key === view.activeAccountKey));
      say(`${C.dim}用法：npx mn-ws auth switch <序号|邮箱|用户名|昵称>${C.reset}`);
      process.exitCode = 1;
      return;
    }
    let r;
    try {
      r = switchActiveAccount(target, { defaultClientId: ensureClientId() });
    } catch (e) {
      say(`${C.red}✗ ${e.message}${C.reset}`);
      process.exitCode = 1;
      return;
    }
    if (!r.changed) {
      say(`${C.dim}当前已经就是这个账号${C.reset}：${labelOf(r.entry)}`);
      return;
    }
    say(`${C.green}✓ 已切换到${C.reset}：${labelOf(r.entry)}`);
    return;
  }

  if (action === 'status') {
    const raw = readConfigFile();
    const view = withAccounts(raw, { defaultClientId: ensureClientId() });
    const cur = view.accounts[view.activeAccountKey];
    if (!cur) {
      say(`${C.yellow}未登录${C.reset}：执行 npx mn-ws auth login`);
      return;
    }
    say(`${C.bold}当前身份${C.reset}：${labelOf(cur)}`);
    if (cur.email) say(`  邮箱    ${cur.email}`);
    say(`  标识    ${cur.clientId || '(无)'}`);
    if (cur.expiresAt) {
      const days = Math.round((cur.expiresAt - Date.now()) / 86400000);
      say(`  令牌    ${days >= 0 ? `约 ${days} 天后过期` : '已过期'}`);
    }
    say(`  server  ${cur.url || '(无)'}`);
    return;
  }

  if (action === 'logout') {
    const all = flags.all === true;
    const r = clearAuthCredentials({ all });
    say(`${C.green}✓ 已清除${C.reset}${all ? '本机全部账号' : '当前账号的登录凭据'}`);
    if (r.remaining) say(`${C.dim}本机还剩 ${r.remaining} 个账号${C.reset}`);
    return;
  }

  say(`${C.yellow}未知 auth 子命令：${action}${C.reset}`);
  say(`${C.dim}可用：login | list | switch | status | logout${C.reset}`);
  process.exitCode = 1;
}

function printAccountLine(i, a, active) {
  const e = a.entry || {};
  const mark = active ? `${C.green}★${C.reset}` : ' ';
  say(`  ${mark} ${i}. ${labelOf(e)}${e.email && e.email !== labelOf(e) ? `  ${C.dim}${e.email}${C.reset}` : ''}`);
  say(`     ${C.dim}clientId ${e.clientId || '(无)'}${C.reset}`);
}

// ============================ doctor ============================

async function cmdDoctor(cfg) {
  const logger = new Logger({ level: 'error' });
  let problems = 0;

  say(`${C.bold}mn-ws doctor${C.reset}  ${C.dim}v${pkg.version}${C.reset}`);
  say(`${C.dim}node ${process.version} · ${process.platform}-${process.arch}${C.reset}`);
  say('');

  // ① 端口占用预检
  const serverPort = await isPortFree(cfg.port, '0.0.0.0');
  const webPort = await isPortFree(cfg.webPort, '127.0.0.1');
  say(`${C.bold}端口${C.reset}`);
  say(`  server :${cfg.port}  ${serverPort.free ? `${C.green}空闲${C.reset}` : `${C.yellow}已被占用${C.reset}`}`);
  say(`  面板   :${cfg.webPort}  ${webPort.free ? `${C.green}空闲${C.reset}` : `${C.yellow}已被占用${C.reset}`}`);

  // ② 鉴权
  say('');
  say(`${C.bold}鉴权${C.reset}`);
  const hasGate = !!cfg.token;
  const hasJwt = !!cfg.jwtSecret;
  if (hasJwt) say(`  ${C.green}✓${C.reset} 统一登录（设备令牌，按用户隔离）`);
  else say(`  ${C.yellow}!${C.reset} 未配置统一登录密钥（MN_WS_JWT_SECRET）`);
  if (hasGate) say(`  ${C.green}✓${C.reset} 静态门禁 token（共享密钥，等价全量访问）`);
  else say(`  ${C.yellow}!${C.reset} 未配置静态门禁（MN_WS_TOKEN）`);
  if (!hasGate && !hasJwt) {
    problems += 1;
    say(`  ${C.red}✗ 没有任何鉴权${C.reset} —— server 侧会拒绝启动（除非 --insecure）`);
  }
  if (cfg.host === '0.0.0.0' && !hasGate && !hasJwt) {
    problems += 1;
    say(`  ${C.red}✗ 绑 0.0.0.0 且无鉴权${C.reset} —— 绝不能这样上公网`);
  }

  // ③ 白名单与端口存活
  say('');
  say(`${C.bold}可桥接的应用${C.reset}`);
  const configured = resolveApps(cfg);
  const names = Object.keys(configured);
  if (!names.length) {
    say(`  ${C.yellow}!${C.reset} 白名单为空 —— 一个都不桥（用 --apps 指定）`);
  } else {
    const list = await scanApps({ host: '127.0.0.1', apps: names, overrides: cfg.appOverrides });
    for (const a of list) {
      const mark = a.alive ? `${C.green}✓ 在监听${C.reset}` : `${C.yellow}✗ 未运行${C.reset}`;
      say(`  ${C.cyan}${a.app.padEnd(10)}${C.reset}${String(a.port).padEnd(7)}${mark}  ${a.base}`);
    }
  }

  // ④ server 连通性
  say('');
  say(`${C.bold}server 连通性${C.reset}`);
  const httpBase = cfg.serverHttp || cfg.url.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
  try {
    const r = await getJson(`${httpBase.replace(/\/+$/, '')}/health`);
    if (r.status === 200 && r.json && r.json.ok) {
      say(`  ${C.green}✓${C.reset} ${httpBase}/health → ${r.json.service} · 桥接数 ${r.json.bridges}`);
    } else {
      say(`  ${C.yellow}!${C.reset} ${httpBase}/health 返回 HTTP ${r.status}`);
    }
  } catch (e) {
    say(`  ${C.yellow}!${C.reset} 连不上 ${httpBase}/health（${e.message}）`);
  }

  // ⑤ 登录态
  say('');
  say(`${C.bold}本机登录态${C.reset}`);
  const raw = readConfigFile();
  const view = withAccounts(raw, { defaultClientId: ensureClientId() });
  const cur = view.accounts[view.activeAccountKey];
  if (cur && cur.deviceToken) {
    const days = cur.expiresAt ? Math.round((cur.expiresAt - Date.now()) / 86400000) : null;
    say(`  ${C.green}✓${C.reset} ${labelOf(cur)}${days !== null ? ` · 令牌约 ${days} 天后过期` : ''}`);
  } else if (cfg.token) {
    say(`  ${C.green}✓${C.reset} 使用静态门禁 token`);
  } else {
    say(`  ${C.yellow}!${C.reset} 未登录（npx mn-ws auth login）`);
  }

  say('');
  if (problems) {
    say(`${C.red}✗ ${problems} 项需要处理${C.reset}`);
    process.exitCode = 1;
  } else {
    say(`${C.green}✓ 自检通过${C.reset}`);
  }
  logger.close();
}

// ============================ main ============================

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  if (flags.version || command === 'version') return printVersion();
  if (flags.help && !command) return printHelp();
  if (!command) return printHelp();

  const cfg = loadConfig(flags);

  switch (command) {
    case 'server':
      return cmdServer(cfg);
    case 'client':
      return cmdClient(cfg, rest);
    case 'web':
      return cmdClientWeb(cfg);
    case 'auth':
      return cmdAuth(cfg, rest, flags);
    case 'doctor':
      return cmdDoctor(cfg);
    case 'help':
      return printHelp();
    default:
      say(`${C.red}未知命令：${command}${C.reset}\n`);
      printHelp();
      process.exitCode = 1;
      return undefined;
  }
}

main().catch((e) => {
  process.stderr.write(`${C.red}致命错误：${e.message}${C.reset}\n`);
  if (process.env.MN_WS_DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
