import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * server 半的配置解析。
 *
 * 优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**（与 mn-rt 同一套）。
 *
 * 配置文件位置：~/.mn-ws/server.json（环境变量 MN_WS_HOME 可覆盖）。
 *
 * ⚠️ 账号表（多账号登录态）在 **client 半**——只有它需要「谁登录了这台机器」。
 * server 半只认凭据，不认人；人的身份由 client 半带来的设备令牌断言。
 */

/** server 半的最终配置。 */
export interface ServerConfig {
  host: string;
  port: number;
  wsPath: string;
  token: string;
  issuer: string;
  /** server 半自己的 OIDC 身份 */
  idpClientId: string;
  /** client 半的身份：真正发起授权码流程的是它 */
  loginClientId: string;
  redirectUri: string;
  jwtSecret: string;
  authEnabled: boolean | undefined;
  insecure: boolean;
  requestTimeoutMs: number;
  logLevel: string;
  dataDir: string | null;
}

/** 命令行解析结果。 */
export interface ParsedArgs {
  flags: Record<string, unknown>;
  positional: string[];
}

export function configDir(): string {
  return process.env.MN_WS_HOME || path.join(os.homedir(), '.mn-ws');
}

export function serverConfigFile(): string {
  return path.join(configDir(), 'server.json');
}

export function readConfigFile(): Record<string, unknown> {
  try {
    const f = serverConfigFile();
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 真值判定：1 / true / yes / on（大小写不敏感）。 */
export function isEnvTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * 布尔开关的严格解析。
 *
 * 空 → undefined（**没表态**，让上层按「跟随其他配置」处理）；
 * 1/true/yes/on → true；0/false/no/off → false；其他值 → **直接抛错**。
 *
 * 为什么要严格：部署脚本里 `MN_WS_AUTH_ENABLED=1` 被当成「关闭」时，
 * 服务照常启动、/health 照样绿，而整套按用户隔离的属主判据**静默不存在** ——
 * CI 全绿、人以为开着。这类「配了等于没配」必须在解析层就炸掉。
 */
export function parseBoolFlag(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`布尔开关取值无法识别：${JSON.stringify(v)}（认 1/true/yes/on 与 0/false/no/off）`);
}

/** 命令行解析：--key value / --key=value / --flag / 位置参数。 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key: string;
      let value: unknown;
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
      flags[camel(key)] = value;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function camel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function pick(...vals: unknown[]): unknown {
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
 * 这里是**安全项**：token / jwtSecret 若是 "undefined"，
 * `config.token && gate === config.token` 就等于「任何人都能用
 * `X-Mn-Ws-Token: undefined` 通过门禁」。所以缺省必须是空串。
 */
export function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 合并出最终配置。
 *
 * 环境变量前缀 MN_WS_（REMOTETYPE_ 那种大写下划线风格）。
 */
export function loadServerConfig(flags: Record<string, unknown> = {}): ServerConfig {
  const file = readConfigFile();
  const env = process.env;

  return {
    host: str(pick(flags.host, env.MN_WS_HOST, file.host, '0.0.0.0')),
    port: Number(pick(flags.port, env.MN_WS_PORT, file.port, 7777)),
    wsPath: str(pick(flags.wsPath, env.MN_WS_WS_PATH, file.wsPath, '/ws')),
    token: str(pick(flags.token, env.MN_WS_TOKEN, file.token, '')),
    issuer: str(pick(flags.issuer, env.MN_WS_ISSUER, file.issuer, 'http://47.110.80.47:8082')),
    // server 半自己的 OIDC 身份（只用于「我是谁」，不发起授权码流程）
    idpClientId: str(pick(flags.idpClientId, env.MN_WS_IDP_CLIENT_ID, file.idpClientId, 'mn-ws-server')),
    // client 半的身份：真正发起授权码流程的是它（本机 CLI 在回环上收码 + PKCE）
    loginClientId: str(pick(flags.loginClientId, env.MN_WS_LOGIN_CLIENT_ID, file.loginClientId, 'mn-ws-client')),
    redirectUri: str(pick(flags.redirectUri, env.MN_WS_REDIRECT_URI, file.redirectUri, '')),
    jwtSecret: str(pick(flags.jwtSecret, env.MN_WS_JWT_SECRET, file.jwtSecret, '')),
    authEnabled: parseBoolFlag(pick(flags.authEnabled, env.MN_WS_AUTH_ENABLED, file.authEnabled, '')),
    insecure: flags.insecure === true || env.MN_WS_INSECURE === '1',
    requestTimeoutMs: Number(pick(flags.requestTimeout, env.MN_WS_REQUEST_TIMEOUT, file.requestTimeoutMs, 30_000)),
    logLevel: String(pick(flags.logLevel, env.MN_WS_LOG_LEVEL, file.logLevel, 'info')),
    dataDir: path.join(configDir(), 'data'),
  };
}
