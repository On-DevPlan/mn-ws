// hook handler 执行器：两种类型，同一套 payload / decision 协议。
//
//   module： import 配置目录内的 ESM 模块，调用导出函数，函数返回 decision
//   command：spawn 子进程（语言无关），payload JSON 走 stdin；
//            stdout 的 JSON 为 decision；exit 2 = 阻断（stderr 作为反馈，
//            对齐 Claude Code hooks 的 blocking 约定）；其余非 0 = 执行错误
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { external, specError } from '../errors/index.js';

export interface HookHandlerSpec {
  type?: 'module' | 'command';
  // module：相对配置文件的模块路径，可带 #exportName（缺省 default）
  use?: string;
  // command：shell 命令字符串，cwd = 配置文件目录
  command?: string;
  timeoutMs?: number;
}

// 统一事件载荷（JSON 可序列化）。事件特有字段直接平铺。
export type HookPayload = {
  event: string;
  target: string; // match 的匹配对象（如 skill 名）
  match: string; // 命中的正则源
  cwd: string;
  [k: string]: unknown;
};

// handler 决策。block 非空 = 阻断事件；vars 合并为动态字符串；data 收集。
export interface HookDecision {
  block?: string;
  vars?: Record<string, string>;
  data?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

// module handler：解析并校验路径（必须在配置目录内），import 后调用。
export async function runModuleHandler(
  spec: HookHandlerSpec,
  configDir: string,
  payload: HookPayload,
): Promise<HookDecision | void> {
  if (!spec.use) throw specError('module handler 缺少 "use" 字段');
  const parts = spec.use.split('#');
  const rel = parts[0] || '';
  const exportName = parts[1];
  const abs = isAbsolute(rel) ? rel : resolve(configDir, rel);

  // 防越界：解析结果必须仍在配置目录内
  const inside =
    abs === configDir || abs.startsWith(configDir.endsWith(sep) ? configDir : configDir + sep);
  if (!inside) {
    throw specError(`hook 模块路径越出配置目录: ${spec.use}`);
  }
  if (!existsSync(abs)) throw specError(`hook 模块不存在: ${spec.use}`);

  const mod = await import(pathToFileURL(abs).href);
  const fn = exportName ? mod[exportName] : mod.default;
  if (typeof fn !== 'function') {
    throw specError(`hook 模块 ${spec.use} 的 ${exportName || 'default'} 不是函数`);
  }
  return (await fn(payload)) as HookDecision | void;
}

// command handler：子进程 + stdin JSON + stdout JSON / exit 2 阻断。
export function runCommandHandler(
  spec: HookHandlerSpec,
  configDir: string,
  payload: HookPayload,
): Promise<HookDecision | void> {
  if (!spec.command || !spec.command.trim()) {
    throw specError('command handler 缺少 "command" 字段');
  }
  const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command!, {
      cwd: configDir,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectPromise(external(`hook 命令超时（${timeoutMs}ms）: ${spec.command}`));
    }, timeoutMs);

    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const t = stdout.trim();
        if (!t) return resolvePromise();
        try {
          return resolvePromise(JSON.parse(t) as HookDecision);
        } catch {
          return rejectPromise(
            external(`hook 命令 stdout 不是合法 JSON: ${spec.command}（${t.slice(0, 80)}）`),
          );
        }
      }
      if (code === 2) {
        return resolvePromise({ block: stderr.trim() || `hook 阻断: ${spec.command}` });
      }
      rejectPromise(
        external(`hook 命令退出码 ${code}: ${spec.command}${stderr ? '\n' + stderr.trim() : ''}`),
      );
    });

    child.stdin.write(JSON.stringify(payload)) ;
    child.stdin.end();
  });
}

export async function runHandler(
  spec: HookHandlerSpec,
  configDir: string,
  payload: HookPayload,
): Promise<HookDecision | void> {
  const type = spec.type || (spec.command ? 'command' : 'module');
  if (type === 'command') return runCommandHandler(spec, configDir, payload);
  if (type === 'module') return runModuleHandler(spec, configDir, payload);
  throw specError(`未知 hook handler 类型: ${String(type)}`);
}
