// 通用 hook 总线：配置文件桥接、match 过滤、无限事件平面。
//
// 模型参考 Claude Code hooks（settings.json → hooks → 事件组 → matcher → handlers），
// 在 nx-nx 内落地为每个 skill / 项目可自带的 hooks.json：
//
// {
//   "version": 1,
//   "hooks": {
//     "<任意事件名>": [
//       { "match": "<正则，匹配 target>",
//         "hooks": [ { "type": "module", "use": "./x.mjs" },
//                    { "type": "command", "command": "node y.mjs" } ] }
//     ]
//   }
// }
//
// 关键性质：
//   1. 事件平面开放——核心不枚举事件，任意字符串都能注册与触发（无限平面扩展）
//   2. match = 正则白名单，只在 target 命中时执行该规则
//   3. handler 顺序执行；decision.vars 聚合、decision.block 立即阻断
//   4. 配置 schema / 坏 JSON / 坏正则一律显眼报错（作者资产，不静默）
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { specError } from '../errors/index.js';
import {
  runHandler,
  type HookDecision,
  type HookHandlerSpec,
  type HookPayload,
} from './handlers.js';

export const HOOK_CONFIG_FILE = 'hooks.json';

export interface HookRule {
  match: string;
  hooks: HookHandlerSpec[];
}

export interface HookConfig {
  dir: string; // 配置文件所在目录（相对路径与 command cwd 的基准）
  hooks: Record<string, HookRule[]>;
}

// 加载目录下的 hooks.json；不存在 → null（无钩子）；坏 JSON / schema 错 → 抛错。
export async function loadHookConfig(dir: string): Promise<HookConfig | null> {
  const file = join(dir, HOOK_CONFIG_FILE);
  if (!existsSync(file)) return null;

  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    throw specError(`无法读取 ${HOOK_CONFIG_FILE}: ${String((e as Error).message || e)}`);
  }

  let parsed: { version?: number; hooks?: Record<string, HookRule[]> };
  try {
    parsed = JSON.parse(raw) as { version?: number; hooks?: Record<string, HookRule[]> };
  } catch {
    throw specError(`${HOOK_CONFIG_FILE} 不是合法 JSON（目录: ${dir}）`);
  }

  const groups = parsed.hooks;
  if (!groups || typeof groups !== 'object') {
    throw specError(`${HOOK_CONFIG_FILE} schema 错误：缺少 hooks 对象（目录: ${dir}）`);
  }
  for (const [event, rules] of Object.entries(groups)) {
    if (!Array.isArray(rules) || !rules.length) {
      throw specError(`${HOOK_CONFIG_FILE} 事件 "${event}" 必须是非空规则数组`);
    }
    for (const rule of rules) {
      if (typeof rule.match !== 'string' || !rule.match) {
        throw specError(`${HOOK_CONFIG_FILE} 事件 "${event}" 的规则缺少非空 match`);
      }
      try {
        new RegExp(rule.match);
      } catch (e) {
        throw specError(
          `${HOOK_CONFIG_FILE} 事件 "${event}" 的 match 不是合法正则: ${rule.match}（${String((e as Error).message)}）`,
        );
      }
      if (!Array.isArray(rule.hooks) || !rule.hooks.length) {
        throw specError(`${HOOK_CONFIG_FILE} 事件 "${event}" 的规则缺少非空 hooks 数组`);
      }
    }
  }

  return { dir, hooks: groups };
}

export interface HookOutcome {
  ran: number;
  blocked: boolean;
  reason?: string;
  by: string; // 阻断来源 handler 描述
  vars: Record<string, string>;
  data: unknown[];
}

interface RunEventInput {
  event: string;
  target: string;
  configs: Array<HookConfig | null>;
  // 事件特有字段（cwd、skillsDir、vars 等），平铺进 payload
  fields?: Record<string, unknown>;
}

// 触发一个事件：汇总各配置中该事件的规则，match 命中则顺序执行 handlers。
// 事件名任意——总线不认识固定平面，新事件无需改核心。
export async function runHookEvent(input: RunEventInput): Promise<HookOutcome> {
  const outcome: HookOutcome = { ran: 0, blocked: false, vars: {}, data: [], by: '' };

  for (const config of input.configs) {
    if (!config) continue;
    const rules = config.hooks[input.event];
    if (!rules) continue;

    for (const rule of rules) {
      if (!new RegExp(rule.match).test(input.target)) continue;
      const payload: HookPayload = {
        ...input.fields,
        event: input.event,
        target: input.target,
        match: rule.match,
        cwd: (input.fields?.cwd as string) || process.cwd(),
      };

      for (const handler of rule.hooks) {
        const decision: HookDecision | void = await runHandler(handler, config.dir, payload);
        outcome.ran++;
        if (decision?.vars) Object.assign(outcome.vars, decision.vars);
        if (decision?.data !== undefined) outcome.data.push(decision.data);
        if (decision?.block) {
          outcome.blocked = true;
          outcome.reason = decision.block;
          outcome.by = handler.use || handler.command || 'handler';
          return outcome;
        }
      }
    }
  }
  return outcome;
}

// 便捷封装：单配置来源。
export async function emit(
  event: string,
  target: string,
  config: HookConfig | null,
  fields?: Record<string, unknown>,
): Promise<HookOutcome> {
  return runHookEvent({ event, target, configs: [config], fields });
}
