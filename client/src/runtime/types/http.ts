// 路由的类型层工具：
//   - RouteParams：从 '/api/templates/:id' 里提取 :id（模板字面量递归）
//   - ParamsCovered：断言路由参数全部在 args 中声明（否则运行时静默 undefined）
//   - AmbiguousPairs：检测结构性歧义路由（如 /x/:a 与 /x/:b，任何排序都救不了）

export type RouteParams<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer More}`
    ? Name | RouteParams<`/${More}`>
    : Rest
  : never;

export type ArgNames<A> = A extends { args: infer As }
  ? As extends readonly unknown[]
    ? As[number] extends infer X
      ? X extends string
        ? X
        : X extends { name: infer N }
          ? N
          : never
      : never
    : never
  : never;

type PatternOf<A> = A extends { http: infer H }
  ? H extends readonly [string, infer P]
    ? P
    : never
  : never;

// 路由里声明的每个 :param 都必须出现在 args 名中。
// 对应 skill 错误案例："声明 args:['ref'] 却与 http 的 :ref 不同名 → 静默 undefined"。
export type ParamsCovered<A> = [RouteParams<PatternOf<A>>] extends [never]
  ? true
  : RouteParams<PatternOf<A>> extends ArgNames<A>
    ? true
    : false;

// ---- 路由歧义检测（对应 api.js 注释里 status 被 :id 抢走的事故）----

type Segs<P extends string> = P extends `${infer H}/${infer R}` ? [H, ...Segs<R>] : [P];

type SegMatch<A extends string, B extends string> = A extends `:${string}`
  ? true
  : B extends `:${string}`
    ? true
    : A extends B
      ? true
      : false;

type SameLenCompat<X extends readonly string[], Y extends readonly string[]> = X extends readonly [
  infer XH extends string,
  ...infer XR extends string[],
]
  ? Y extends readonly [infer YH extends string, ...infer YR extends string[]]
    ? SegMatch<XH, YH> extends true
      ? SameLenCompat<XR, YR>
      : false
    : false
  : true;

// 段数相同、每段字面量相等或互为参数 → 两条路由匹配同一批 URL。
export type Overlap<P extends string, Q extends string> = Segs<P>['length'] extends Segs<Q>['length']
  ? SameLenCompat<Segs<P>, Segs<Q>>
  : false;

// 对模式元组做双重遍历，产出所有歧义对（无歧义则 never）。
export type AmbiguousPairs<Ps extends readonly string[], I extends unknown[] = []> = I['length'] extends Ps['length']
  ? never
  : Ps[I['length'] & number] extends infer P extends string
    ?
        | {
            [J in keyof Ps]: J extends `${I['length']}`
              ? never
              : Overlap<P, Ps[J] extends string ? Ps[J] : never> extends true
                ? `${P} ≈ ${Ps[J]}`
                : never;
          }[number]
        | AmbiguousPairs<Ps, [...I, 1]>
    : never;
