---
name: dev-ws
description: mn-ws 的开发者 skill（项目级，.claude/skills/dev-ws）——修改 mn-ws 的 TypeScript 源码、加 action/模块/页面、调 CLI 与面板、排障、跑测试与发版时使用。触发词：开发 mn-ws、改 TS 代码、加 action、加模块、加页面、改面板、类型错误、排障、pnpm test、发版。运行面使用（启动面板、执行 CLI）请用主 skill `mn-ws`；本 skill 只管“改这个项目本身”。
---

# dev-ws — mn-ws 开发者指南

**代码是唯一真相**：本 skill 的路径与命令以仓库当前代码为准；改完代码后同步更新对应 ref。

## 路由（先看这里）

主文档只做路由，场景细节一律放 `references/`。新增主题时：先建
`references/<A|B|C><两位序号>-<主题>.md`，再在下面表格加一行。

| 代号 | 干什么时读 | 一句话 |
| --- | --- | --- |
| _（待补）_ | 首个开发主题出现时补第一行 | 命名示例：`A01-本地开发.md` / `B01-代码地图.md` / `C01-验证发布.md` |

## 序列约定

- **A 序列 = 关键操作流程**：拿命令照抄就能干（开发、测试、构建、发布、排障）
- **B 序列 = 关键设计与代码**：为什么这样设计、边界在哪、改哪里会牵动谁
- **C 序列 = 验证与发布**：改完怎么证明没坏、怎么构建与发版

## 项目事实（改代码前先确认）

- 架构：一条 action 同时派生 CLI 命令与 HTTP 路由；Web 上能做的，CLI 都能做
- 命令（项目根执行）：
  - `pnpm dev` —— vite + 后端 tsx 直跑源码，改码即生效
  - `pnpm typecheck` —— 只跑类型检查
  - `pnpm test` —— lint（含行数/字符数限制）+ typecheck + build + smoke + unit
  - `pnpm start` —— 构建并启动面板
- 代码地图：
  - `src/runtime/` —— CLI / HTTP / 路由注册与参数校验；`types/` 是 action 与模块的类型契约
  - `src/core/` —— 存储、路径、端口、skill 等通用能力
  - `src/modules/` —— 业务模块（action + service + view）
  - `src/web/frontend/` —— React 面板
  - `assets/mn-ws/` —— 随包分发的使用 skill（面向“用本项目”，不是“改本项目”）
  - `tests/` —— smoke 与 unit

## 约束

- 新增能力照现有模块的分层放置，不要把业务逻辑塞进 `src/runtime/`
- 新增 action 必须同时声明 `cli` 与 `http`；确属纯 CLI（`serve` / `server` / `skill` 前缀之外）要写 `http: null, web: false`——`local/action-parity` 与启动期注册表都会拦
- 类型契约优先改 `src/runtime/types/`，再改实现；不要让实现反推类型
- 动 CLI/HTTP 契约时同步 `tests/`，并确认 `routes` 输出一致
- 与主 skill `mn-ws` 分工：`mn-ws` 管运行面，`dev-ws` 管开发面
