// 品牌类型（nominal typing）：结构相同但语义不同的字符串/数字，靠唯一符号区分。
// 作用：让"未经安全校验的值"在类型层就无法流入 fs 写操作，而不是靠运行时侥幸。
declare const absolutePathBrand: unique symbol;
export type AbsolutePath = string & { readonly [absolutePathBrand]: true };

declare const safeRelPathBrand: unique symbol;
export type SafeRelPath = string & { readonly [safeRelPathBrand]: true };

import { resolve } from 'node:path';

// 任意字符串 → AbsolutePath。path.resolve 保证规范化；
// 调用方需先完成自己语义层的校验（如防穿越），这里只做"已确认绝对路径"的标记。
export function asAbsolutePath(p: string): AbsolutePath {
  return resolve(p) as AbsolutePath;
}
