// 视图组件表：id → 懒加载组件。**这里只有组件**。
//
// 「有哪些页面、叫什么名字、什么顺序、出厂默认显不显示」由 Rust client 的
// /api/settings 决定，随请求发给面板——清单只有一份，前端不重复一份（重复必然分叉）。
// 前端**不能** import node 侧代码（Rust 化后仓库里也没有 TS 运行时了）。
//
// 必须用**字面量** import：变量拼路径会让 Vite 静态分析失效、丢掉代码分割。
// 新增页面 = 写 views/<页>.tsx + Rust 侧 settings 的页面清单加一行 + 这里加一行。
import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

export const COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  home: lazy(() => import('./views/home')),
  bridge: lazy(() => import('./views/bridge')),
};

/** 供一致性测试对账用。 */
export const COMPONENT_IDS: readonly string[] = Object.keys(COMPONENTS);
