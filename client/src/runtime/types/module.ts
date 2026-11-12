// 模块与注册表的类型系统。
//
// defineModule：约束单个模块形状（id/title/actions）。
// defineModules：模块汇总处的"编译期装载检查"，把 registry.js 运行时循环
// （重复模块 id / action id / CLI 路径 / HTTP 路由 + 路由歧义）前移成编译错误。

import type { Assert, Err } from './action.js';
import type { AmbiguousPairs } from './http.js';

export interface ModuleShape<A extends readonly unknown[]> {
  id: string;
  title: string;
  order?: number;
  actions: A;
}

// 约束用的结构类型（defineModules 的泛型约束）
export interface AnyModule {
  id: string;
  title: string;
  order?: number;
  actions: readonly unknown[];
}

// 用裸泛型 M 承接整个字面量：id/actions 的字面量形状原样保留，
// 同时交叉类型保证必填字段存在。
export function defineModule<const M>(
  m: M & { id: string; title: string; actions: readonly unknown[] },
): M {
  return m;
}

// ---- 元组工具：查重 ----

export type Includes<T extends readonly unknown[], V> = T extends readonly [infer H, ...infer R]
  ? [H] extends [V]
    ? [V] extends [H]
      ? true
      : Includes<R, V>
    : Includes<R, V>
  : false;

export type Dup<T extends readonly unknown[], Seen extends readonly unknown[] = []> = T extends readonly [
  infer H,
  ...infer R,
]
  ? Includes<Seen, H> extends true
    ? H | Dup<R, Seen>
    : Dup<R, [...Seen, H]>
  : never;

// ---- 从 action 推出 CLI / HTTP 键 ----

type JoinPath<T extends readonly string[]> = T extends readonly [infer H extends string]
  ? H
  : T extends readonly [infer H extends string, ...infer R extends readonly string[]]
    ? `${H} ${JoinPath<R>}`
    : '';

// 对应 cliPathsOf：单路径直接 join；多路径（别名）逐个 join
export type CliKey<A> = A extends { cli: infer C }
  ? C extends readonly string[]
    ? C[0] extends string
      ? JoinPath<C>
      : C[number] extends infer P
        ? P extends readonly string[]
          ? JoinPath<P>
          : never
        : never
    : never
  : never;

export type HttpKey<A> = A extends { http: infer H }
  ? H extends readonly [string, string]
    ? `${H[0]} ${H[1]}`
    : never
  : never;

// ---- 展平模块表的全部 action ----

type ActionsOf<M> = M extends { actions: infer A extends readonly unknown[] } ? A : [];

export type AllActions<M extends readonly unknown[]> = M extends readonly [infer H, ...infer R]
  ? [...ActionsOf<H>, ...AllActions<R extends readonly unknown[] ? R : []>]
  : [];

// ---- 元组映射工具（先证明是元组再映射，避免泛型 mapped 退化成对象）----

export type ModuleIds<M> = M extends readonly unknown[]
  ? { [K in keyof M]: M[K] extends { id: infer I } ? I : never }
  : [];

export type ActionIds<AA> = AA extends readonly unknown[]
  ? { [K in keyof AA]: AA[K] extends { id: infer I } ? I : never }
  : [];

export type ActionCliKeys<AA> = AA extends readonly unknown[]
  ? { [K in keyof AA]: CliKey<AA[K]> }
  : [];

export type ActionHttpKeys<AA> = AA extends readonly unknown[]
  ? { [K in keyof AA]: HttpKey<AA[K]> }
  : [];

// 过滤元组中的 never（无 http 的 action 产生 never，会污染歧义检测）
export type FilterNever<T extends readonly unknown[]> = T extends readonly [infer H, ...infer R]
  ? [H] extends [never]
    ? FilterNever<R>
    : [H, ...FilterNever<R>]
  : [];

// 模式键带上**方法**：同一个路径挂 GET 与 PATCH 两条 action 是常规 REST 写法
// （例如 GET /api/settings 读、PATCH /api/settings 写），不该被判成歧义；
// 真正该报的是「同一路径 + 同一方法」的重复声明，以及 /x/:a 与 /x/:b 这种结构性重叠。
export type ActionPatterns<AA> = FilterNever<
  AA extends readonly unknown[]
    ? {
        [K in keyof AA]: AA[K] extends { http: infer H }
          ? H extends readonly [infer M, infer P]
            ? M extends string
              ? P extends string
                ? `${M} ${P}`
                : never
              : never
            : never
          : never;
      }
    : []
>;

// ---- 注册表级校验（每条对应 registry.js 运行时循环的一项）----

export type RegistryChecks<M extends readonly unknown[]> = unknown & Assert<
    [Dup<ModuleIds<M>>] extends [never] ? true : false,
    '模块 id 重复'
  >
  & Assert<
    [Dup<ActionIds<AllActions<M>>>] extends [never] ? true : false,
    'action id 重复'
  >
  & Assert<
    [Dup<ActionCliKeys<AllActions<M>>>] extends [never] ? true : false,
    'CLI 命令路径重复'
  >
  & Assert<
    [Dup<ActionHttpKeys<AllActions<M>>>] extends [never] ? true : false,
    'HTTP 路由重复'
  >
  & Assert<
    [AmbiguousPairs<ActionPatterns<AllActions<M>>>] extends [never] ? true : false,
    '存在结构性歧义的路由（不同模式匹配同一批 URL，任何排序都无法区分）'
  >;

// 汇总入口：运行时按 order 排序；类型层执行全部装载检查。
export function defineModules<const M extends readonly AnyModule[]>(
  modules: M & RegistryChecks<M>,
): M {
  return [...modules].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)) as unknown as M;
}

// 让"校验未通过"在返回类型层也可见（防止有人绕过 defineModules 直接用数组）。
export type CheckedModules<M extends readonly unknown[]> = M & RegistryChecks<M>;

// 工具重导出，便于业务侧只从 types 入口取类型
export type { Err };
