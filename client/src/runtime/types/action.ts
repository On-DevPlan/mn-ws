// action 类型系统的核心。
//
// 一份 action 声明字面量同时产出：
//   运行时 —— spec.js 的强转/校验/help 派生（原样保留）
//   编译期 —— CtxOf 推出 ctx 形状；run 返回值推出 render 参数与 API 响应类型
//
// 报错手法：Assert<条件, 消息> 在条件不成立时让参数类型长出 __error__ 字段，
// 调用处对象缺该字段即报红，消息直接展示在错误信息里。

import type { ParamsCovered } from './http.js';

export type FlagType = 'string' | 'number' | 'boolean' | 'array' | 'json' | 'kv';

export interface FlagSpec {
  type?: FlagType;
  default?: unknown;
  required?: boolean;
  enum?: readonly unknown[];
  hint?: string;
}

// 位置参数：字符串 = 必填；对象可声明 optional / rest（收集剩余全部）
export type ArgEntry =
  | string
  | {
      name: string;
      required?: boolean;
      rest?: boolean;
    };

export interface TransportMeta {
  transport: 'cli' | 'http';
}

// ---- 编译期报错零件 ----

export type Err<Msg extends string> = { readonly __error__: Msg };

export type Assert<Cond extends boolean, Msg extends string> = Cond extends true
  ? unknown
  : Err<Msg>;

// ---- 从 flag 声明推出值类型 ----

export type FlagValue<F> = F extends { type: 'number' }
  ? number
  : F extends { type: 'boolean' }
    ? boolean
    : F extends { type: 'array' }
      ? string[]
      : F extends { enum: infer E }
        ? E extends readonly unknown[]
          ? E[number]
          : string
        : string;

// 有 default 或 required:true → ctx 中必有；否则类型带 undefined
export type IsPresent<F> = F extends { default: unknown }
  ? true
  : F extends { required: true }
    ? true
    : false;

export type CtxFlags<F> = unknown & {
    [K in keyof F as IsPresent<F[K]> extends true ? K : never]: FlagValue<F[K]>;
  }
  & {
    [K in keyof F as IsPresent<F[K]> extends true ? never : K]?: FlagValue<F[K]>;
  };

export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

export type CtxArgs<As> = UnionToIntersection<
  As extends readonly (infer A)[]
    ? A extends string
      ? { [K in A]: string }
      : A extends { name: infer N extends string }
        ? A extends { required: false }
          ? { [K in N]?: A extends { rest: true } ? string[] : string }
          : { [K in N]: A extends { rest: true } ? string[] : string }
        : never
    : never
>;

// openFlags 的 action 可选项由数据驱动（模板 option schema），留索引签名
export type CtxOf<A> = unknown & (A extends { flags: infer F } ? CtxFlags<F> : unknown)
  & (A extends { args: infer As } ? CtxArgs<As> : unknown)
  & (A extends { openFlags: true } ? { [k: string]: unknown } : unknown);

// ---- action 形状与编译期校验 ----

export interface ActionShape {
  id: string;
  cli: readonly string[] | readonly (readonly string[])[];
  http?: readonly [string, string] | null;
  /** 纯 CLI 的显式出口：http 必须同时为 null；表示「这个操作就是不给面板入口」 */
  web?: boolean;
  summary?: string;
  args?: readonly ArgEntry[];
  flags?: Record<string, FlagSpec>;
  openFlags?: boolean;
}

// flag 的 type 白名单（对应 spec.js 的 const TYPES）
type FlagsLegal<A> = A extends { flags: infer F }
  ? {
      [K in keyof F]: F[K] extends { type: infer T }
        ? T extends FlagType
          ? true
          : false
        : true;
    }[keyof F] extends true
    ? true
    : false
  : true;

// http 必须是 [METHOD, PATTERN] 或显式 null（对应 registry.js 第 48 行）
type HttpLegal<A> = A extends { http: infer H }
  ? H extends readonly [string, string]
    ? true
    : H extends null
      ? true
      : false
  : true;

export type ValidateAction<A> = unknown & Assert<FlagsLegal<A>, 'flag 的 type 只能是 string | number | boolean | array'>
  & Assert<HttpLegal<A>, 'http 必须是 [METHOD, PATTERN] 或显式 null'>
  & Assert<ParamsCovered<A>, '路由 :param 与 args 名不一致（运行时会静默变 undefined）'>;

// run 的返回值类型（render 参数与 API 响应都从它推出）
export type RunResult<A> = A extends { run: (...a: any[]) => infer R } ? Awaited<R> : never;

// 声明的输入形状：run 的 ctx 与 render 的结果都由声明自身推出。
export interface ActionDefinition<A> extends ActionShape {
  run: (ctx: CtxOf<A>, meta: TransportMeta) => unknown;
  render?: (result: RunResult<A>, ctx: CtxOf<A>) => unknown;
}

// 经过校验、类型完整的 action（运行时形态）。
// 关键：直接与字面量 S 交叉——http/flags/cli 的字面量结构对外可见，
// 不是只存在幻影类型参数里；run/render 在第二阶段补上并被精确类型化。
export type TypedAction<S, R> = S & {
  run: (ctx: CtxOf<S>, meta?: TransportMeta) => R;
  render?: (result: Awaited<R>, ctx?: CtxOf<S>) => string | Promise<string>;
};

// 唯一入口，两段式：
//   第一段 defineAction(声明)：const 参数推断并保留字面量，执行声明级校验；
//   第二段 (run, render?)：ctx 被 CtxOf<S> 精确上下文类型化，
//                          render 参数由 run 返回值推出。
//
// 为什么不是单调用：自引用泛型（同对象内从 flags 推 run 的 ctx）在 TS 中会
// 退化成 any/unknown（实测 TS 5.9 仍如此）；两段式把推断顺序显式化，零歧义。
export function defineAction<const S>(spec: S & ActionShape & ValidateAction<S>) {
  return <R>(
    run: (ctx: CtxOf<S>, meta: TransportMeta) => R,
    render?: (result: Awaited<R>, ctx: CtxOf<S>) => string | Promise<string>,
  ): TypedAction<S, Awaited<R>> => ({ ...(spec as object), run, render } as TypedAction<S, Awaited<R>>);
}
