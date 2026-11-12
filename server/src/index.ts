/**
 * mn-ws-server 的公共面。
 *
 * ⚠️ client 半以 workspace 依赖引入这个包（`mn-ws-server`）：
 * 两端说的是同一套帧协议，协议定义**只写一份**，改一处就是改两处。
 * 所以这里导出的东西要当**跨端契约**看 —— 改形状之前先想清楚两边的兼容。
 *
 * 协议与应用目录分开导出（`./protocol` / `./apps`），是为了让 client 半
 * 只取它需要的那部分，不必把 server 的运行时一起打进浏览器包。
 */

export * from './protocol.js';
export * from './apps.js';
export { Logger, LEVELS, type LogLevel } from './logger.js';
export { Store, type AuditRecord } from './store.js';
export {
  AuthHub,
  DEVICE_TOKEN_TTL_SEC,
  b64url,
  b64urlJson,
  fromB64url,
  type DeviceTokenPayload,
  type DeviceRecord,
  type PublicAuthConfig,
} from './auth.js';
export { createServer, type ServerOptions } from './server.js';
export {
  loadServerConfig,
  parseArgs,
  parseBoolFlag,
  isEnvTruthy,
  configDir,
  serverConfigFile,
  type ServerConfig,
} from './config.js';
