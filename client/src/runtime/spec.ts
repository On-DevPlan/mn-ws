// action 规格的解析、校验与文本生成。
//
// 一处声明，两端生效：CLI 的 `--flag` 与 HTTP 的 query/body 都走同一套强转与校验。
// 这正是历史上 `parseInt(flags.depth, 10) || 3` 散落在各处的根源——两端各写一遍解析，
// 迟早分叉。现在 depth 只在 action 声明里写一次 `{ type: 'number', default: 3 }`。
import { readFileSync } from 'node:fs';
import { badInput } from '../core/errors/index.js';
import { APP_NAME } from '../core/paths.js';
import type { ActionShape, ArgEntry, FlagSpec, CtxOf } from './types/action.js';

const TYPES = new Set(['string', 'number', 'boolean', 'array', 'json', 'kv']);

// 取 action 的 CLI 路径列表。支持两种写法：
//   单路径   cli: ['repo', 'list']
//   多路径   cli: [['bundled','list'], ['skill','install','--list']]   ← 别名
export function cliPathsOf(action: { cli: ActionShape['cli'] }): string[][] {
  const cli = action.cli;
  if (!cli || !cli.length) return [];
  const first = cli[0];
  return Array.isArray(first) ? (cli as string[][]) : [cli as string[]];
}

// 位置参数规格：字符串表示必填，对象可声明 optional / rest（收集剩余全部）
export interface ResolvedArg {
  name: string;
  required: boolean;
  rest?: boolean;
}

export function argSpecsOf(action: { args?: readonly ArgEntry[] }): ResolvedArg[] {
  return (action.args || []).map((a) =>
    typeof a === 'string'
      ? { name: a, required: true }
      : { ...a, required: a.required !== false },
  );
}

export interface ResolvedFlag extends FlagSpec {
  name: string;
}

export function flagSpecsOf(action: { flags?: Record<string, FlagSpec> }): ResolvedFlag[] {
  return Object.entries(action.flags || {}).map(([name, spec]) => ({ name, ...spec }));
}

// 该 action 里哪些 flag 是布尔型——CLI 解析据此决定要不要吃掉下一个 token 当值。
// 少了这份信息，`skill install --force demo` 会把 force 解析成字符串 'demo'。
export function booleanFlagNames(action: { flags?: Record<string, FlagSpec> }): Set<string> {
  return new Set(
    flagSpecsOf(action)
      .filter((f) => (f.type || 'string') === 'boolean')
      .map((f) => f.name),
  );
}

function coerceOne(name: string, spec: FlagSpec, raw: unknown): unknown {
  const type = spec.type || 'string';
  if (!TYPES.has(type)) throw new Error(`action 声明有误：flag "${name}" 的 type 非法 (${type})`);
  if (raw === undefined || raw === null) return undefined;

  // 需要值的 flag 写在末尾时（`--depth` 后面没跟东西），解析器只能记成 true。
  // 放任下去：Number(true) === 1 会静默变成「深度 1」这种另一个合法值，
  // String(true) 则会让路径变成 'true'。宁可报错，也不要把笔误变成别的语义。
  if (raw === true && type !== 'boolean') {
    throw badInput(`参数 --${name} 需要提供值`);
  }

  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).toLowerCase();
    return !(s === 'false' || s === '0' || s === 'no' || s === '');
  }
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw badInput(`参数 ${name} 必须是数字，收到: ${raw}`);
    return n;
  }
  if (type === 'array') {
    if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
    return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (type === 'json') {
    // HTTP 侧直接就是对象/数组；CLI 侧是字符串：`--groups '[{…}]'` 或 `--groups @groups.json`
    if (typeof raw === 'object') return raw;
    const s = String(raw).trim();
    if (s.startsWith('@')) {
      const p = s.slice(1);
      try {
        return JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        throw badInput(`参数 --${name} 读取文件失败: ${p}（${(e as Error).message}）`);
      }
    }
    try {
      return JSON.parse(s);
    } catch (e) {
      throw badInput(`参数 --${name} 不是合法 JSON: ${(e as Error).message}`);
    }
  }
  if (type === 'kv') {
    // CLI：`--set name=值`（可重复，解析器会把同名 flag 收成数组）
    // HTTP：`{set: {name: '值'}}` 或 `{set: ['name=值']}`
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
    const list = Array.isArray(raw) ? raw : [raw];
    const out: Record<string, string> = {};
    for (const item of list) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq <= 0) throw badInput(`参数 --${name} 需要 key=value 形式，收到 ${JSON.stringify(item)}`);
      out[s.slice(0, eq).trim()] = s.slice(eq + 1);
    }
    return out;
  }
  return String(raw);
}

// 按声明校验并强转输入。未声明的键原样透传（HTTP body 可能带界面用的额外字段）。
export function applySpec<const A extends ActionShape>(action: A, raw: Record<string, unknown>): CtxOf<A> {
  const out: Record<string, unknown> = { ...raw };

  for (const spec of flagSpecsOf(action)) {
    const v = coerceOne(spec.name, spec, raw[spec.name]);
    if (v === undefined) {
      if (spec.default !== undefined) out[spec.name] = spec.default;
      else if (spec.required) throw inputError(action, `缺少参数 --${spec.name}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) {
      throw inputError(action, `参数 --${spec.name} 只能是 ${spec.enum.join(' | ')}，收到: ${v}`);
    }
    out[spec.name] = v;
  }

  for (const spec of argSpecsOf(action)) {
    const v = out[spec.name];
    const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (empty && spec.required) throw inputError(action, `缺少参数 <${spec.name}>`);
  }
  return out as CtxOf<A>;
}

// ---- HTTP 路由模式编译：'/api/repos/:id' → 正则 + 键名 ----

export interface CompiledRoute {
  method: string;
  keys: string[];
  regex: RegExp;
}

const ROUTE_CACHE = new WeakMap<ActionShape, CompiledRoute>();

export function compileRoute(action: ActionShape & { http: readonly [string, string] }): CompiledRoute {
  const cached = ROUTE_CACHE.get(action);
  if (cached) return cached;
  const [method, pattern] = action.http;
  const keys: string[] = [];
  const body = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  const compiled: CompiledRoute = { method, keys, regex: new RegExp('^' + body + '$') };
  ROUTE_CACHE.set(action, compiled);
  return compiled;
}

// ---- 用法串生成：从声明反推，help 因此不可能与实际命令脱节 ----

export function usageOf(action: ActionShape): string {
  const [path] = cliPathsOf(action);
  const parts: string[] = [APP_NAME, ...(path || [])];

  for (const a of argSpecsOf(action)) {
    const label = a.rest ? `${a.name}...` : a.name;
    parts.push(a.required ? `<${label}>` : `[${label}]`);
  }

  for (const f of flagSpecsOf(action)) {
    let token: string;
    if (f.type === 'boolean') {
      token = `--${f.name}`;
    } else {
      // 值的占位符优先用 enum 展开（--side <ours|theirs>），其次显式 hint，
      // 最后才退回 flag 名——`--http <http>` 这种读起来没有信息量。
      const hint = f.enum ? f.enum.join('|') : f.hint || f.name;
      token = `--${f.name} <${hint}>`;
    }
    parts.push(f.required ? token : `[${token}]`);
  }

  // 开放式 action：可选项由数据驱动（模板的 option schema），
  // 声明期无法枚举。用一句提示代替逐个列出，读者才知道还有别的开关。
  if (action.openFlags) parts.push('[--<选项> <值> ...]');

  return parts.join(' ');
}

// 「用法:」前缀是**对外契约**：assets 文档教 agent 用错误文本里的「用法:」
// 判定为参数错误并决定「停下来问人」。不能只写「缺少参数 X」，必须带完整用法串。
function inputError(action: ActionShape, detail: string) {
  return badInput(`用法: ${usageOf(action)} —— ${detail}`);
}
