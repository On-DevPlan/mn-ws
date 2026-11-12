// 路径与安全校验：项目里所有「东西放哪」都从这里取，不在别处拼字符串。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { badInput } from './errors/index.js';
import type { SafeRelPath } from './brand.js';

// ---- 项目标识（生成时由模板变量替换）----
export const APP_NAME = 'mn-ws';
export const APP_TITLE = 'mn-ws';
export const APP_DESC = 'HTTP 与 WebSocket 双向桥的客户端半：把本机 nx 服务桥给远端 HTTP 客户端';

// ---- 数据目录（用户主目录下，可用环境变量覆盖）----
export const APP_DIR = join(homedir(), '.mn-ws');
export const STORE_PATH = join(APP_DIR, 'store.json');

// ---- 端口 ----
// serve 的 HTTP 端口（生成时写入探测到的空闲端口）。
// vite dev server 的端口在 vite.config.ts 里单独配。
export const DEFAULT_PORT = 7777;

// 测试必须能指向临时目录，否则会写脏用户的真实数据。
export const STORE_ENV = 'MN_WS_STORE';

export function storePathFromEnv(): string {
  return process.env[STORE_ENV] || STORE_PATH;
}

// ---- 输入校验 ----
//
// 名称与路径分开校验：名称禁前导点（`.foo` 不像个名字），
// 路径允许（`.gitignore` 是完全正常的文件）。
// 早期把两者混用一套规则，结果拒绝了 `.gitignore`。

export function assertSafeName(name: unknown, label = '名称'): string {
  if (!name || typeof name !== 'string') throw badInput(`${label}不能为空`);
  if (/[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw badInput(`非法 ${label}: ${name}`);
  }
  return name;
}

// 校验通过即品牌类型 SafeRelPath：下游拿到它就知道路径已经过安全检查。
export function assertSafeRelPath(
  input: unknown,
  { label = '文件路径', allowSubdir = true }: { label?: string; allowSubdir?: boolean } = {},
): SafeRelPath {
  if (!input || typeof input !== 'string') throw badInput(label + '不能为空');
  if (/^([a-zA-Z]:|[\\/])/.test(input)) throw badInput(label + '必须是相对路径: ' + input);
  const segments = input.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (!segments.length) throw badInput('非法 ' + label + ': ' + input);
  if (segments.includes('..')) throw badInput(label + '不得包含 ..: ' + input);
  if (!allowSubdir && segments.length > 1) {
    throw badInput(label + '不能包含路径分隔符: ' + input);
  }
  return segments.join('/') as SafeRelPath;
}
