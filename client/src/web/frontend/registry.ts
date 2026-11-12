// 视图组件表：id → 懒加载组件。**这里只有组件**。
//
// 「有哪些页面、叫什么名字、什么顺序、出厂默认显不显示」全部由后端 core/views.ts 决定，
// 随 GET /api/settings 一起发给面板——所以清单只有一份，前端不重复一份（重复必然分叉）。
// 前端也**不能**值导入 core（lint 拦着：那会把 node: 内置模块打进浏览器包）。
//
// 必须用**字面量** import：变量拼路径会让 Vite 静态分析失效、丢掉代码分割。
// 新增页面 = 写 modules/<域>/view.tsx + core/views.ts 加一行 + 这里加一行；
// tests/unit/registry.test.mjs 三方对账，漏一处直接测试失败。
import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

export const COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  home: lazy(() => import('../../modules/home/view')),
  bridge: lazy(() => import('../../modules/bridge/view')),
};

/** 供一致性测试对账用。 */
export const COMPONENT_IDS: readonly string[] = Object.keys(COMPONENTS);
