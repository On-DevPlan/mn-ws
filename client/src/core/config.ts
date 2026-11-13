import { parseCustomApps, type CustomApp } from './apps-registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * client 半的配置与账号表。
 *
 * 优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**（与 mn-rt 同一套）。
 *
 * 配置文件位置：~/.mn-ws/config.json（环境变量 MN_WS_HOME 可覆盖）。
 *
 * 账号模型与 mn-rt 对齐：一个账号 = 一条完整登录态（含它自己的 clientId），
 * 多个账号并存，用 `auth switch` 切当前生效的那个；`auth logout` 默认只清
 * 当前账号（--all 清空全部）。这样多人共用一台机器时各登各的。
 *
 * ⚠️ 这里存的是**本机**的凭据（设备令牌），server 半不碰这个文件。
 */


/** client 半的最终配置。 */
export interface ClientConfig {
  /** server 半的 ws:// 地址 */
  url: string;
  /** 统一登录用的 HTTP 基址（缺省从 url 推导） */
  serverHttp: string;
  /** 注册门禁：设备令牌或静态门禁 */
  token: string;
  /** 本机标识（决定路由与属主绑定） */
  clientId: string;
  deviceName: string;
  account: string;
  /** 白名单：应用名 */
  apps: string[];
  /**
   * 已登记应用的显式基址（名字 -> {base, title?}）。
   *
   * 这是「登记表」的一部分：白名单里只有名字的应用，要在这里（或在
   * customApps 里）才有基址 —— 没有基址就不知道该把请求转到哪个端口，
   * 那个应用会被跳过并明确报出来。
   */
  appOverrides: Record<string, { base: string; title?: string }>;
  /** 运行时动态注册的应用（面板里加的） */
  customApps: CustomApp[];
  /** 本地面板端口 */
  webPort: number;
  /** 本地面板绑定地址（固定回环） */
  webHost: string;
  noOpen: boolean;
  logLevel: string;
  requestTimeoutMs: number;
}

/** 一个已存账号。 */
export interface AccountEntry {
  userId?: string;
  email?: string;
  username?: string;
  nickname?: string;
  deviceToken?: string;
  expiresAt?: number;
  deviceName?: string;
  clientId?: string;
  url?: string;
  serverHttp?: string;
  loginAt?: number;
  [k: string]: unknown;
}

export function configDir(): string {
  return process.env.MN_WS_HOME || path.join(os.homedir(), '.mn-ws');
}

export function configFile(): string {
  return path.join(configDir(), 'config.json');
}

export function readConfigFile(): Record<string, unknown> {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
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
export function writeConfigFile(nextRaw: Record<string, unknown>): { file: string } {
  const f = configFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  let fd: number | null = null;
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
function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

/** 第一个非空值。 */
export function pick(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * 取字符串值，缺省是**空串**。
 *
 * 为什么不能直接 String(pick(...))：pick 全空时返回 undefined，
 * 而 `String(undefined)` 是字符串 **"undefined"** —— 不是空串！
 * 于是 `if (!cfg.serverHttp)` 这类判空全部失效（"undefined" 是真值），
 * 表现为「配置里写着 undefined」这种没法一眼看出来的坏值。
 * 这个坑真踩过：serverHttp 推不出地址，clientId 永远是 "undefined"，
 * 配置文件也从来不落盘。
 */
export function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** 真值判定：1 / true / yes / on（大小写不敏感）。 */
export function isEnvTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** 布尔开关的严格解析；空 = 没表态（undefined），非法值直接抛错。 */
export function parseBoolFlag(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`布尔开关取值无法识别：${JSON.stringify(v)}（认 1/true/yes/on 与 0/false/no/off）`);
}

/** 从 ws://h:p/ws 推导 http://h:p。 */
export function httpBaseFromWs(wsUrl: string): string {
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
 * --apps "a,b=http://127.0.0.1:9999" → { names: ['a','b'], overrides: {b:{base}} }
 *
 * 两种写法都认：只给名字（基址在别处登记），或直接把基址带上。
 * 直接带基址是常用形态 —— 一条命令把「桥什么」和「桥到哪」一起说清；
 * 而「名字」本身只是个路由标识，它不携带任何关于被桥服务的信息。
 */
export function parseApps(v: unknown): { names: string[]; overrides: Record<string, { base: string }> } {
  const names: string[] = [];
  const overrides: Record<string, { base: string }> = {};
  const items = Array.isArray(v) ? v.map((x) => String(x)) : (v ? String(v).split(',') : []);
  for (const raw of items) {
    const s = String(raw).trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq > 0) {
      const name = s.slice(0, eq).trim();
      const base = s.slice(eq + 1).trim();
      if (name && base) {
        names.push(name);
        overrides[name] = { base };
      }
      continue;
    }
    names.push(s);
  }
  return { names, overrides };
}

/**
 * --app-map "a=http://127.0.0.1:9999" → { a: { base: '...' } }
 *
 * 也可以直接给对象（配置文件里就是对象形态）：`{"a":{"base":"…","title":"…"}}`。
 */
export function parseAppMap(v: unknown): Record<string, { base: string; title?: string }> {
  const out: Record<string, { base: string; title?: string }> = {};
  if (!v) return out;

  if (typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const name = String(k).trim();
      if (!name) continue;
      if (val && typeof val === 'object') {
        const base = String((val as { base?: unknown }).base ?? '').trim();
        const title = String((val as { title?: unknown }).title ?? '').trim();
        if (base) out[name] = title ? { base, title } : { base };
      } else {
        const base = String(val ?? '').trim();
        if (base) out[name] = { base };
      }
    }
    return out;
  }

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


/** 合并出最终配置。 */
export function loadClientConfig(flags: Record<string, unknown> = {}): ClientConfig {
  const file = readConfigFile();
  const env = process.env;

  // --apps 既可以只给名字，也可以带上基址（a=http://127.0.0.1:9999）
  const parsedApps = parseApps(pick(flags.apps, env.MN_WS_APPS, file.apps, ''));
  // 配置文件里这个字段叫 `appMap`（`appOverrides` 是同义的别名，两种都认）
  const parsedMap = parseAppMap(pick(flags.appMap, env.MN_WS_APP_MAP, file.appMap, file.appOverrides, ''));

  const cfg: ClientConfig = {
    url: str(pick(flags.url, env.MN_WS_URL, file.url, 'ws://1.94.101.189:7777/ws')),
    serverHttp: str(pick(flags.serverHttp, env.MN_WS_SERVER_HTTP, file.serverHttp, '')),
    token: str(pick(flags.token, env.MN_WS_TOKEN, file.token, '')),
    clientId: str(pick(flags.clientId, env.MN_WS_CLIENT_ID, file.clientId, '')),
    deviceName: str(pick(flags.deviceName, env.MN_WS_DEVICE_NAME, file.deviceName, os.hostname())),
    account: str(pick(flags.account, env.MN_WS_ACCOUNT, file.account, '')),
    apps: parsedApps.names,
    // --app-map 覆盖 --apps 里内联的基址（更具体的在后）
    appOverrides: { ...parsedApps.overrides, ...parsedMap },
    customApps: parseCustomApps(file.customApps),
    webPort: Number(pick(flags.webPort, env.MN_WS_WEB_PORT, file.webPort, 7777)),
    webHost: str(pick(flags.webHost, env.MN_WS_WEB_HOST, file.webHost, '127.0.0.1')),
    noOpen: flags.noOpen === true || env.MN_WS_NO_OPEN === '1',
    logLevel: str(pick(flags.logLevel, env.MN_WS_LOG_LEVEL, file.logLevel, 'info')),
    requestTimeoutMs: Number(pick(flags.requestTimeout, env.MN_WS_REQUEST_TIMEOUT, file.requestTimeoutMs, 30_000)),
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

// ───────────────────────── 账号表 ─────────────────────────

/** 账号条目的稳定 key：优先 userId，其次邮箱/用户名/昵称。 */
export function entryKeyOf(entry: AccountEntry | undefined): string {
  const e = entry || {};
  return String(e.userId || e.email || e.username || e.nickname || e.clientId || '');
}

export function labelOf(entry: AccountEntry | undefined): string {
  const e = entry || {};
  return String(e.nickname || e.username || e.email || e.userId || e.clientId || '(未知账号)');
}

/** 账号簿视图。 */
export interface AccountView {
  accounts: Record<string, AccountEntry>;
  activeAccountKey: string;
}

/**
 * 视图：老配置的 flat 凭据被合成成首个条目。
 *
 * 这样「第二个人登录」不会把第一个人的登录态挤掉 —— 两个账号并存。
 */
export function withAccounts(raw: Record<string, unknown>, { defaultClientId = '' } = {}): AccountView {
  const base = raw || {};
  const accounts: Record<string, AccountEntry> = {
    ...((base.accounts && typeof base.accounts === 'object' ? base.accounts : {}) as Record<string, AccountEntry>),
  };
  let activeAccountKey = String(base.activeAccount || '');

  const flat: AccountEntry = {
    userId: base.userId as string | undefined,
    email: base.email as string | undefined,
    username: base.username as string | undefined,
    nickname: base.nickname as string | undefined,
    deviceToken: base.deviceToken as string | undefined,
    expiresAt: base.expiresAt as number | undefined,
    deviceName: base.deviceName as string | undefined,
    clientId: base.clientId as string | undefined,
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

export function listAccounts(view: AccountView): { key: string; entry: AccountEntry }[] {
  return Object.entries(view.accounts || {}).map(([key, entry]) => ({ key, entry }));
}

/** 把账号条目的运行期字段并进 flat（不动身份字段）。 */
function buildFlatSyncPatch(entry: AccountEntry): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of ['url', 'deviceToken', 'expiresAt', 'userId', 'email', 'username', 'nickname', 'deviceName', 'clientId', 'serverHttp']) {
    if (entry[k] !== undefined) patch[k] = entry[k];
  }
  return patch;
}

/**
 * 保存一次成功登录的账号，并激活它。
 * @returns {{changed: boolean, key: string, file: string}}
 */
export function saveAuthAccount({ entry, setActive = true }: { entry: AccountEntry; setActive?: boolean }): {
  changed: boolean; key: string; file: string;
} {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId: ensureClientId() });
  const key = entryKeyOf(entry);
  const entryWithId: AccountEntry = { ...entry, clientId: entry.clientId || ensureClientId() };
  const accounts = { ...view.accounts, [key]: entryWithId };
  const next: Record<string, unknown> = { ...existing, accounts };
  if (setActive) {
    next.activeAccount = key;
    Object.assign(next, buildFlatSyncPatch(entryWithId));
  }
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, key, file };
}

/** 设备令牌是否已过期。 */
export function isExpired(entry: { expiresAt?: number } | undefined): boolean {
  if (!entry) return true;
  if (!entry.expiresAt) return false;
  return Date.now() >= entry.expiresAt;
}

/**
 * 切换激活账号：设指针 + 把该账号条目打平成 flat。
 * 跨部署切换时 url/serverHttp 必须一起走，否则会拿 A 服务器的令牌去连 B。
 */
export function switchActiveAccount(target: string, { defaultClientId = '' } = {}): {
  changed: boolean; key: string; entry: AccountEntry; file: string;
} {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId });
  const list = listAccounts(view);
  if (!list.length) throw new Error('本机还没有已存账号：先执行 npx mn-ws auth login');

  let picked: { key: string; entry: AccountEntry } | null = null;
  const t = String(target || '').trim();
  if (t) {
    const byKey = list.find((a) => a.key === t);
    const byIdx = /^\d+$/.test(t) ? list[Number(t) - 1] : undefined;
    const byField = list.find((a) =>
      [a.entry.email, a.entry.username, a.entry.nickname].some((v) => v && String(v) === t));
    picked = byKey || byIdx || byField || null;
    if (!picked) {
      throw new Error(`找不到账号「${t}」。本机已存：${list.map((a) => a.key).join(', ')}`);
    }
  } else {
    // 不带参数且只有一个账号：没有「切换」可言，直接说清楚
    if (list.length === 1) {
      const only = list[0]!;
      const err = new Error(
        `本机只有 1 个账号：${labelOf(only.entry)}（clientId ${only.entry.clientId || '(无)'}）`,
      ) as Error & { onlyOne?: boolean; entry?: AccountEntry };
      err.onlyOne = true;
      err.entry = only.entry;
      throw err;
    }
    return { changed: false, key: '', entry: {}, file };
  }

  const entry: AccountEntry = { ...picked.entry, clientId: picked.entry.clientId || defaultClientId };
  const next: Record<string, unknown> = {
    ...existing,
    accounts: { ...view.accounts, [picked.key]: entry },
    activeAccount: picked.key,
    ...buildFlatSyncPatch(entry),
  };
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, key: picked.key, entry, file };
}

/** 清除登录凭据。 */
export function clearAuthCredentials({ all = false }: { all?: boolean } = {}): {
  changed: boolean; file: string; remaining: number;
} {
  const file = configFile();
  const existing = readConfigFile();
  const view = withAccounts(existing, { defaultClientId: ensureClientId() });
  const next: Record<string, unknown> = { ...existing };

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
  const remaining = next.accounts ? Object.keys(next.accounts as object).length : 0;
  return { changed, file, remaining };
}

/** 本机标识：没有就生成一个并落盘。 */
export function ensureClientId(): string {
  const file = readConfigFile();
  if (file.clientId) return String(file.clientId);
  const id = generateClientId();
  file.clientId = id;
  try { writeConfigFile(file); } catch { /* ignore */ }
  return id;
}

/** 「主机名-6 位随机」生成 clientId。 */
export function generateClientId(exclude?: Set<string>): string {
  const host = (os.hostname() || 'pc').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20);
  const skip = exclude instanceof Set ? exclude : new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    const id = `${host}-${Math.random().toString(36).slice(2, 8)}`;
    if (!skip.has(id)) return id;
  }
  return `${host}-${Math.random().toString(36).slice(2, 8)}`;
}


/** 保存本次连接用的参数（url / token 等）到配置文件。 */
export function saveConnectionConfig(cfg: ClientConfig): { changed: boolean; file: string } {  const file = configFile();
  const existing = readConfigFile();
  const relevant: Record<string, unknown> = {};
  for (const k of ['url', 'serverHttp', 'token', 'deviceName', 'clientId']) {
    const v = (cfg as unknown as Record<string, unknown>)[k];
    if (v) relevant[k] = v;
  }
  const next = { ...existing, ...relevant };
  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  if (changed) writeConfigFile(next);
  return { changed, file };
}
