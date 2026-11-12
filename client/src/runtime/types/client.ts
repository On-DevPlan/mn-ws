// 从模块注册表推出「类型安全的 HTTP 客户端」类型。
//
// 前端不允许 import 运行时 registry（会把 node:http 打进浏览器包），
// 因此这里只产出**类型**；运行时实现见 src/web/frontend/api/typed-client.ts，
// 路由模式由 /api/bootstrap 下发的命令表提供。
//
// 由此得到的保证：
//   - 调用不存在的 action id        → 编译报错（键不存在）
//   - 漏传 / 错传路由 :param        → 编译报错（必填键缺失）
//   - flag 值类型写错（数字传布尔） → 编译报错
//   - 返回数据按 action 的 run 精确推导，面板不再需要手写 response 类型
import type { ArgEntry, FlagSpec } from './action.js';
import type { ActionIds, AllActions } from './module.js';

// 按 id 在 action 元组中找到那一条
export type FindAction<AA extends readonly unknown[], Id> = AA extends readonly [
  infer H,
  ...infer R,
]
  ? H extends { id: Id }
    ? H
    : FindAction<R extends readonly unknown[] ? R : [], Id>
  : never;

// 提取路由模式里的全部 :param
export type PatternParams<P extends string> = P extends `${string}:${infer K}/${infer Rest}`
  ? K | PatternParams<`/${Rest}`>
  : P extends `${string}:${infer K}`
    ? K
    : never;

// 单个 flag 在客户端侧允许传入的值类型
type FlagInputValue<F extends FlagSpec> = F['type'] extends 'boolean'
  ? boolean
  : F['type'] extends 'number'
    ? number
    : F['type'] extends 'array'
      ? string[] | string
      : F['enum'] extends readonly (infer E)[]
        ? E
        : string;

// 无额外必填键时的空形状（刻意：调用方无需提供任何参数）。
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Empty = {};

// action 全部 flags 的输入形状（均可选——没传的由服务端按 default 补）
export type FlagInputOf<A> = A extends { flags: infer F }
  ? { [K in keyof F]?: F[K] extends FlagSpec ? FlagInputValue<F[K]> : unknown }
  : Empty;

// 位置参数 args 的输入形状：
//   - required 的参数为必填键；其余为可选键
//   - rest 参数（收集剩余位置）以数组形式给出
//   - 已在路由 :param 中的同名参数与路由部分相交，键类型一致，不冲突
// ArgEntry 允许裸字符串（等价 { name }），这里只取对象型成员做映射
type ArgObjects<Args> = Extract<
  Args extends readonly unknown[] ? Args[number] : never,
  { name: string }
>;

type RequiredArgInput<Args extends readonly ArgEntry[]> = {
  [E in ArgObjects<Args> as E['required'] extends true ? E['name'] : never]: E['rest'] extends true
    ? string[]
    : string | number;
};
type OptionalArgInput<Args extends readonly ArgEntry[]> = {
  [E in ArgObjects<Args> as E['required'] extends true ? never : E['name']]?: E['rest'] extends true
    ? string[]
    : string | number;
};
export type ArgInputOf<A> = A extends { args: infer Args }
  ? Args extends readonly ArgEntry[]
    ? RequiredArgInput<Args> & OptionalArgInput<Args>
    : Empty
  : Empty;

// 一次调用的参数：路由参数（必填）+ 位置参数 + flags（可选）
export type CallParams<A> = (A extends { http: readonly [string, infer P extends string] }
  ? PatternParams<P> extends never
    ? Empty
    : Record<PatternParams<P>, string | number>
  : Empty) &
  ArgInputOf<A> &
  FlagInputOf<A>;

// 一次调用的返回：run 的 Awaited 返回值
export type CallResult<A> = A extends { run: (...a: any[]) => infer R } ? Awaited<R> : unknown;

// 整个类型安全客户端：键为全部 action id
export type TypedClient<M extends readonly unknown[]> = ActionIds<AllActions<M>> extends infer Ids
  extends readonly string[]
  ? {
      [Id in Ids[number]]: (
        params: CallParams<FindAction<AllActions<M>, Id>>,
      ) => Promise<CallResult<FindAction<AllActions<M>, Id>>>;
    }
  : Empty;
