// help 文本与命令条目的派生。从 cli.ts 拆出以控制单文件行数。
//
// 全部由命令表生成——help 因此不可能与实际注册的命令脱节。
import { readFileSync } from 'node:fs';
import { APP_NAME, STORE_ENV, storePathFromEnv } from '../core/paths.js';
import { cliPathsOf, usageOf } from './spec.js';
import type { ActionShape } from './types/action.js';

const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export interface CommandEntry {
  id: string;
  module: string;
  command: string;
  usage: string;
  http: { method: string; path: string } | null;
  summary?: string;
}

// 命令表的一行。`routes` 与 `help` 共用它，因此两张表必然同源同长——
// 面板底部的「CLI 等价」提示用的也是这个形状（经 bootstrap 下发）。
export function commandEntry(c: {
  id: string;
  module?: string;
  cli?: ActionShape['cli'];
  http?: readonly [string, string] | null;
  summary?: string;
}): CommandEntry {
  const [first] = cliPathsOf(c as { cli: ActionShape['cli'] });
  return {
    id: c.id,
    module: c.module || 'platform',
    command: APP_NAME + ' ' + (first || []).join(' '),
    http: c.http ? { method: c.http[0], path: c.http[1] } : null,
    usage: usageOf(c as ActionShape),
    summary: c.summary,
  };
}

// 解析帮助主题。既接受模块 id（template），也接受命令组（template）——
// 用户脑子里想的是「相关的东西」，不会去记内部模块名。
// 这条路径不能报错退出：`nx-nx help <随便什么>` 失败会让最需要帮助的人卡住。
export function helpEntries(topic: unknown, all: CommandEntry[]): CommandEntry[] {
  if (!topic) return all;

  const t = String(topic);
  const byModule = all.filter((e) => e.module === t);
  if (byModule.length) return byModule;

  const byRoot = all.filter((e) => e.command.split(' ')[1] === t);
  if (byRoot.length) return byRoot;

  // 命令本身的 id 也认（如 `nx-nx help template.create`）
  const byId = all.filter((e) => e.id === t);
  if (byId.length) return byId;

  // 命令组名由已注册的命令表现推，不写死——模块增删时提示自动跟上。
  const roots = all.map((e) => e.command.slice(APP_NAME.length + 1).split(/\s+/)[0]!);
  const groups = [...new Set(roots.filter((r) => roots.filter((x) => x === r).length > 1))]
    .slice(0, 4)
    .join(' / ');
  const topics = [...new Set(all.map((e) => e.module))].join(', ');
  throw new Error(`未知帮助主题: ${t}（可用模块: ${topics}；或命令组如 ${groups}）`);
}

export function renderHelp(entries: CommandEntry[], topic?: unknown): string {
  const lines: string[] = [];
  if (!topic) {
    lines.push(`${APP_NAME} v${VERSION}`);
    lines.push('CLI 与 Web 面板共享同一 action 声明。');
    lines.push(`存储: ${storePathFromEnv()}    （环境变量 ${STORE_ENV} 或 --store 覆盖）`);
    lines.push('');
  }

  const groups = new Map<string, CommandEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.module) || [];
    list.push(e);
    groups.set(e.module, list);
  }

  for (const [mod, list] of groups) {
    lines.push(mod + ':');
    const width = Math.max(...list.map((e) => e.usage.length));
    for (const e of list) lines.push('  ' + e.usage.padEnd(width + 2) + e.summary);
    lines.push('');
  }

  lines.push('通用:');
  lines.push('  --json    机器可读输出（agent 模式）');
  lines.push('  --store   本次运行覆盖存储路径');
  return lines.join('\n');
}

// `nx-nx <命令> --help`：只打印这一条，而不是整个模块——
// 之前这里传的是 cmd.cli[0]，对别名 action（cli 是数组的数组）会拼出 "bundled,list"。
export function printCommandHelp(cmd: {
  id: string;
  module?: string;
  cli?: ActionShape['cli'];
  http?: readonly [string, string] | null;
  summary?: string;
}): void {
  const lines: string[] = [usageOf(cmd as ActionShape)];
  if (cmd.summary) lines.push('    ' + cmd.summary);
  lines.push('');

  const aliases = cliPathsOf(cmd as { cli: ActionShape['cli'] })
    .slice(1)
    .map((p) => APP_NAME + ' ' + p.join(' '));
  if (aliases.length) lines.push('别名: ' + aliases.join('  ·  '));
  if (cmd.http) lines.push('对应路由: ' + cmd.http[0] + ' ' + cmd.http[1]);
  lines.push('所属模块: ' + (cmd.module || 'platform'));
  console.log(lines.join('\n'));
}
