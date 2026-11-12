'use strict';

/**
 * 配置解析与账号存储。
 *
 * 优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**（与 mn-rt 同一套）。
 *
 * 配置文件位置：~/.mn-ws/config.json（环境变量 MN_WS_HOME 可覆盖）。
 *
 * 账号模型与 mn-rt 对齐：一个账号 = 一条完整登录态（含它自己的 clientId），
 * 多个账号并存，用 `auth switch` 切当前生效的那个；`auth logout` 默认只清
 * 当前账号（--all 清空全部）。这样多人共用一台机器时各登各的。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger } = require('./logger');
const { KNOWN_APPS } = require('./apps');

/**
 * 内置默认地址。
 *
 * 指向真实部署，与 mn-rt 同机不同端口（mn-rt 占 8790，mn-ws 用 7777）。
 *
 * 为什么是 7777：7777 在 nx 系列里是「对外那台机器的入口端口」的语义位，
 * 而 mn-rt 的 8790 已经被 remoteserver 占着；给 mn-ws 一个独立且好记的号，
 * 免得两套中继的端口在文档、docker、Actions secrets 里混成一锅。
 */
const DEFAULT_SERVE_URL = 'ws://1.94.101.189:7777/ws';
const DEFAULT_SERVER_HTTP = 'http://1.94.101.189:7777';
const DEFAULT_SERVER_PORT = 7777;

/**
 * 本地面板默认端口。
 *
 * 也用 7777 —— 面板只在 client 半那台机器上跑，而 client 半连的是**远端**
 * server（1.94.101.189:7777），本机不会同时有 7777 的 server 在监听，
 * 所以默认不冲突。真在同一台机上既起 server 又开面板时，
 * 端口预检会明确报错让人换 --web-port，不静默顺延。
 */
const DEFAULT_WEB_PORT = 7777;

/** 脚手架时代的占位域名 —— 遇到就当场说清，不拿一句 DNS 错糊用户。 */
const PLACEHOLDER_HOSTS = ['mn-ws.example.com'];

function configDir() {
  return process.env.MN_WS_HOME || path.join(os.homedir(), '.mn-ws');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function readConfigFile() {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 原子写整份配置文件：同目录 tmp（0600）→ fsync → rename。
 *
 * 必须整份替换而不是就地改：写入方不止一个（serve 会在注册成功后回写配置，
 * 用户随时可能在另一个终端跑 auth login），半截文件被下一次读当成空配置，
 * 等于把凭据静默清空。
 */
function writeConfigFile(nextRaw) {
  const f = configFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, f);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  }
  return { file: f };
}

/** rename 在 Windows 上可能被扫描器占住（EPERM/EBUSY），带几次短重试。 */
function renameWithRetry(from, to) {
  let lastErr = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

/**
 * 解析命令行：--key value / --flag / 位置参数。
 *
 * 与 mn-rt 的 parseArgs 同语义：`--no-open` 记为 noOpen=false，
 * `--flag` 记为 true，未给值记为 true。
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let value;
      if (eq >= 0) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (key.startsWith('no-')) {
        flags[camel(key.slice(3))] = false;
      } else {
        flags[camel(key)] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function camel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** 地址里的占位域名 → 一句人话原因。 */
function placeholderUrlReason(url) {
  if (!url) return null;
  const hit = PLACEHOLDER_HOSTS.find((h) => String(url).includes(h));
  return hit ? `地址里还带着脚手架占位域名 ${hit}` : null;
}

/** 从 ws://h:p/ws 推导 http://h:p。 */
function httpBaseFromWs(wsUrl) {
  try {
    const u = new URL(String(wsUrl));
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    const port = u.port ? `:${u.port}` : '';
    return `${proto}//${u.hostname}${port}`;
  } catch {
    return '';
  }
}

/**
 * 合并出最终配置。
 *
 * 环境变量前缀 MN_WS_（REMOTETYPE_ 那种大写下划线风格）。
 */
function loadConfig(flags = {}) {
  const file = readConfigFile();
  const env = process.env;

  const cfg = {
    // ---- 连接 ----
    url: pick(flags.url, env.MN_WS_URL, file.url, DEFAULT_SERVE_URL),
    serverHttp: pick(flags.serverHttp, env.MN_WS_SERVER_HTTP, file.serverHttp, ''),
    token: pick(flags.token, env.MN_WS_TOKEN, file.token, ''),
    clientId: pick(flags.clientId, env.MN_WS_CLIENT_ID, file.clientId, ''),
    deviceName: pick(flags.deviceName, env.MN_WS_DEVICE_NAME, file.deviceName, os.hostname()),
    account: pick(flags.account, env.MN_WS_ACCOUNT, file.account, ''),

    // ---- 服务端 ----
    host: pick(flags.host, env.MN_WS_HOST, file.host, '0.0.0.0'),
    port: Number(pick(flags.port, env.MN_WS_PORT, file.port, DEFAULT_SERVER_PORT)),
    wsPath: pick(flags.wsPath, env.MN_WS_WS_PATH, file.wsPath, '/ws'),
    insecure: flags.insecure === true || env.MN_WS_INSECURE === '1',
    jwtSecret: pick(flags.jwtSecret, env.MN_WS_JWT_SECRET, file.jwtSecret, ''),
    // 显式开关：undefined = 没表态（跟随「配没配 JWT secret」），
    // true/false = 部署方明确说了要开/要关。解析非法值直接报错，不猜。
    authEnabled: parseBoolFlag(pick(flags.authEnabled, env.MN_WS_AUTH_ENABLED, file.authEnabled, '')),
    issuer: pick(flags.issuer, env.MN_WS_ISSUER, file.issuer, 'http://47.110.80.47:8082'),
    idpClientId: pick(flags.idpClientId, env.MN_WS_IDP_CLIENT_ID, file.idpClientId, 'mn-ws'),
    redirectUri: pick(flags.redirectUri, env.MN_WS_REDIRECT_URI, file.redirectUri, ''),

    // ---- 客户端 ----
    apps: parseApps(pick(flags.apps, env.MN_WS_APPS, file.apps, '')),
    ports: parsePorts(pick(flags.ports, env.MN_WS_PORTS, file.ports, '')),
    appOverrides: parseAppMap(pick(flags.appMap, env.MN_WS_APP_MAP, '', '')),
    webPort: Number(pick(flags.webPort, env.MN_WS_WEB_PORT, file.webPort, DEFAULT_WEB_PORT)),
    webHost: pick(flags.webHost, env.MN_WS_WEB_HOST, file.webHost, '127.0.0.1'),

    // ---- 杂项 ----
    noOpen: flags.noOpen === true || env.MN_WS_NO_OPEN === '1',
    logLevel: pick(flags.logLevel, env.MN_WS_LOG_LEVEL, file.logLevel, 'info'),
    requestTimeoutMs: Number(pick(flags.requestTimeout, env.MN_WS_REQUEST_TIMEOUT, file.requestTimeoutMs, 30000)),
  };

  // serverHttp 缺省从 url 推导（ws://h:p/ws → http://h:p）
  if (!cfg.serverHttp) cfg.serverHttp = httpBaseFromWs(cfg.url);

  // clientId 缺省自动生成并持久化
  if (!cfg.clientId) {
    cfg.clientId = ensureClientId();
    file.clientId = cfg.clientId;
    try { writeConfigFile(file); } catch { /* ignore */ }
  }

  return cfg;
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 布尔开关的严格解析。
 *
 * 空 → undefined（**没表态**，让上层按「跟随其他配置」处理）；
 * 1/true/yes/on → true；0/false/no/off → false；
 * 其他值 → **直接抛错**。
 *
 * 为什么要严格：部署脚本里 `MN_WS_AUTH_ENABLED=1` 被当成「关闭」时，
 * 服务照常启动、/health 照样绿，而整套按用户隔离的属主判据**静默不存在** ——
 * CI 全绿、人以为开着。这类「配了等于没配」必须在解析层就炸掉。
 */
function parseBoolFlag(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`布尔开关取值无法识别：${JSON.stringify(v)}（认 1/true/yes/on 与 0/false/no/off）`);
}

/** --apps "nx-kv,nx-rh" → ['nx-kv','nx-rh']；空 → []（= 不限，但实际仍需显式配置才开桥）。 */
function parseApps(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (!v) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * --ports "7877,7800" → [7877, 7800]
 *
 * 「本地 client 端选择可以开放的端口」——按端口选比按应用名选更贴近
 * 用户的心智：他看到的是「nx-kv 跑在 7877」，不是「nx-kv 这个名字」。
 */
function parsePorts(v) {
  if (Array.isArray(v)) return v.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!v) return [];
  return String(v).split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * --app-map "nx-kv=http://127.0.0.1:7877,nx-rh=http://127.0.0.1:7800"
 *   → { 'nx-kv': {base:'http://127.0.0.1:7877'}, 'nx-rh': {...} }
 *
 * 为什么需要它：已知端口表只是**兜底默认值**，真实部署常改端口
 * （换机、端口冲突、容器映射）。让用户能显式覆盖，比让程序去猜端口靠谱。
 */
function parseAppMap(v) {
  const out = {};
  if (!v) return out;
  for (const pair of String(v).split(',')) {
    const s = pair.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const app = s.slice(0, eq).trim();
    const base = s.slice(eq + 1).trim();
    if (app && base) out[app] = { base };
  }
  return out;
}

// ───────────────────────── 账号表 ─────────────────────────

/** 账号条目的稳定 key：优先 userId，其次邮箱/用户名/昵称。 */
function entryKeyOf(entry) {
  const e = entry || {};
  return String(e.userId || e.email || e.username || e.nickname || e.clientId || '');
}

function labelOf(entry) {
  const e = entry || {};
  return e.nickname || e.username || e.email || e.userId || e.clientId || '(未知账号)';
}

/**
 * 视图：老配置的 flat 凭据被合成成首个条目。
 *
 * 这样「第二个人登录」不会把第一个人的登录态挤掉 —— 两个账号并存。
 */
function withAccounts(raw, { defaultClientId = '' } = {}) {
  const base = raw || {};
  const accounts = { ...(base.accounts && typeof base.accounts === 'object' ? base.accounts : {}) };
  let activeAccountKey = base.activeAccount || '';

  const flat = {
    userId: base.userId,
    email: base.email,
    username: base.username,
    nickname: base.nickname,
    deviceToken: base.deviceToken,
    expiresAt: base.expiresAt,
    deviceName: base.deviceName,
    clientId: base.clientId,
  };
  const hasFlat = Object.values(flat).some((v) => v !== undefined && v !== '');

  if (hasFlat) {
    const flatEntry = { ...flat };
    let flatKey = entryKeyOf(flatEntry);
    if (!flatKey) {
      flatKey = 'local';
      flatEntry.clientId = flatEntry.clientId || defaultClientId;
    }
    // flat 里没有的账号才补进去（flat 优先：它是「当前激活账号」的镜像）
    if (!accounts[flatKey]) accounts[flatKey] = flatEntry;
    if (!activeAccountKey) activeAccountKey = flatKey;
  }

  return { accounts, activeAccountKey };
}

function listAccounts(view) {
  return Object.entries(view.accounts || {}).map(([key, entry]) => ({ key, entry }));
}

/** 把账号条目的运行期字段并进 flat（不动身份字段）。 */
function buildFlatSyncPatch(entry) {
  const patch = {};
  for (const k of ['url', 'deviceToken', 'expiresAt', 'userId', 'email', 'username', 'nickname', 'deviceName', 'clientId', 'serverHttp']) {
    if (entry && entry[k] !== undefined) patch[k] = entry[k];
  }
  return patch;
}

/**
 * 保存一次成功登录的账号，并激活它。
 * @returns {{changed: boolean, key: string, file: string}}
 */
function saveAuthAccount({ entry, setActive = true }) {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId: ensureClientId() });
  const key = entryKeyOf(entry);
  const entryWithId = { ...entry, clientId: entry.clientId || ensureClientId() };
  const accounts = { ...view.accounts, [key]: entryWithId };
  const next = { ...existing, accounts };
  if (setActive) {
    next.activeAccount = key;
    Object.assign(next, buildFlatSyncPatch(entryWithId));
  }
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, key, file };
}

/**
 * 切换激活账号：设指针 + 把该账号条目打平成 flat。
 * 跨部署切换时 url/serverHttp 必须一起走，否则会拿 A 服务器的令牌去连 B。
 */
function switchActiveAccount(target, { defaultClientId = '' } = {}) {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId });
  const list = listAccounts(view);
  if (!list.length) throw new Error('本机还没有已存账号：先执行 npx mn-ws auth login');

  let picked = null;
  const t = String(target || '').trim();
  if (t) {
    const byKey = list.find((a) => a.key === t);
    const byIdx = /^\d+$/.test(t) ? list[Number(t) - 1] : null;
    const byField = list.find((a) =>
      [a.entry.email, a.entry.username, a.entry.nickname].some((v) => v && String(v) === t));
    picked = byKey || byIdx || byField || null;
    if (!picked) {
      throw new Error(`找不到账号「${t}」。本机已存：${list.map((a) => a.key).join(', ')}`);
    }
  } else {
    // 不带参数且只有一个账号：没有「切换」可言，直接说清楚
    if (list.length === 1) {
      const only = list[0];
      const err = new Error(`本机只有 1 个账号：${labelOf(only.entry)}（clientId ${only.entry.clientId || '(无)'}）`);
      err.onlyOne = true;
      err.entry = only.entry;
      throw err;
    }
    return { changed: false, needsChoice: true, list, view };
  }

  const entry = { ...picked.entry, clientId: picked.entry.clientId || defaultClientId };
  const next = {
    ...existing,
    accounts: { ...view.accounts, [picked.key]: entry },
    activeAccount: picked.key,
    ...buildFlatSyncPatch(entry),
  };
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, key: picked.key, entry, file };
}

/**
 * 清除登录凭据。
 * @param {{all?: boolean}} opts
 */
function clearAuthCredentials({ all = false } = {}) {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId: ensureClientId() });
  const next = { ...existing };

  if (all) {
    delete next.accounts;
    delete next.activeAccount;
  } else if (view.activeAccountKey && view.accounts[view.activeAccountKey]) {
    const accounts = { ...view.accounts };
    delete accounts[view.activeAccountKey];
    if (Object.keys(accounts).length) next.accounts = accounts;
    else delete next.accounts;
    if (next.activeAccount === view.activeAccountKey) delete next.activeAccount;
  }

  for (const k of ['userId', 'email', 'username', 'nickname', 'deviceToken', 'expiresAt', 'clientId']) {
    delete next[k];
  }

  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  const remaining = next.accounts ? Object.keys(next.accounts).length : 0;
  return { changed, file, remaining };
}

/** 本机标识：没有就生成一个并落盘。 */
function ensureClientId() {
  const file = readConfigFile();
  if (file.clientId) return file.clientId;
  const id = generateClientId();
  file.clientId = id;
  try { writeConfigFile(file); } catch { /* ignore */ }
  return id;
}

/** 「主机名-6 位随机」生成 clientId。 */
function generateClientId(exclude) {
  const host = (os.hostname() || 'pc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);
  const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
  for (let i = 0; i < 20; i += 1) {
    const id = `${host}-${Math.random().toString(36).slice(2, 8)}`;
    if (!skip.has(id)) return id;
  }
  return `${host}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 保存本次连接用的参数（url / token 等）到配置文件。 */
function saveConnectionConfig(cfg) {
  const file = configFile();
  const existing = readConfigFile();
  const relevant = {};
  for (const k of ['url', 'serverHttp', 'token', 'deviceName', 'clientId']) {
    if (cfg[k]) relevant[k] = cfg[k];
  }
  const next = { ...existing, ...relevant };
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, file };
}

module.exports = {
  DEFAULT_SERVE_URL,
  DEFAULT_SERVER_HTTP,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  PLACEHOLDER_HOSTS,
  KNOWN_APPS,
  configDir,
  configFile,
  readConfigFile,
  writeConfigFile,
  parseArgs,
  parseBoolFlag,
  parseApps,
  parsePorts,
  parseAppMap,
  placeholderUrlReason,
  httpBaseFromWs,
  loadConfig,
  ensureClientId,
  generateClientId,
  withAccounts,
  listAccounts,
  entryKeyOf,
  labelOf,
  buildFlatSyncPatch,
  saveAuthAccount,
  switchActiveAccount,
  clearAuthCredentials,
  saveConnectionConfig,
  Logger,
};
