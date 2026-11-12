// 「有哪些页面」的**单一来源**：纯数据、零 import。
//
// 为什么放 core 而不是前端注册表：这份清单两端都要读——
//   - 前端（web/frontend/registry.ts）按 id 拼出懒加载组件，渲染头部导航
//   - 后端（modules/home）按 id 校验「导航分组 / 隐藏」配置，坏 id 当场报错
// 放 core 且不 import 任何东西，两边都能安全引用（前端不会因此把 node: 打进包里）。
//
// 新增一个页面 = 写 modules/<域>/view.tsx + 这里加一行 + registry.ts 的 COMPONENTS 加一行。
// tests/unit/registry.test.mjs 把「清单 ↔ 组件 ↔ 模块目录」钉在一起对账。

export interface ViewMeta {
  id: string;
  title: string;
  order: number;
  /** 出厂默认是否隐藏（用户可在首页改；配置存在后以配置为准） */
  hidden?: boolean;
}

export const VIEWS_META: readonly ViewMeta[] = [
  { id: 'home', title: '首页', order: 10 },
  { id: 'bridge', title: '桥接', order: 20 },
];

export function viewMetaOf(id: string): ViewMeta | null {
  return VIEWS_META.find((v) => v.id === id) || null;
}

export function viewIdsOf(): string[] {
  return VIEWS_META.map((v) => v.id);
}
