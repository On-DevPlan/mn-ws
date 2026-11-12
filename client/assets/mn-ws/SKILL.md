---
name: mn-ws
description: HTTP 与 WebSocket 双向桥的客户端半：把本机 nx 服务桥给远端 HTTP 客户端。当用户要求操作本项目（启动服务/面板、查看路由与健康状态、安装本 skill、了解可用命令）时使用。触发词：mn-ws、启动面板、skill install、查看路由、健康检查。
---
# mn-ws skill

本项目是「CLI 与 Web 面板同源」的本机工具：一条 action 声明同时派生出
CLI 命令与 HTTP 路由，Web 上能做的，CLI 都能做。

- 项目根（安装时注入，固定值）：`{{PROJECT_ROOT}}`

## 常用命令

在项目根目录执行：

```bash
# 启动 Web 面板（默认端口 7777）
node bin/ws.mjs serve            # 开发期：pnpm dev

# 查看全部命令与 HTTP 路由对照
node bin/ws.mjs routes

# 健康检查
node bin/ws.mjs health

# skill：列出 / 导出 / 安装
node bin/ws.mjs skill list
node bin/ws.mjs skill get mn-ws
node bin/ws.mjs skill install mn-ws
node bin/ws.mjs skill install --all   # 一次装全部 skill（与 name / --group 互斥）
```

加 `--json` 可获取机器可读输出（错误时同样输出 JSON）。

## 端口与浏览器

- `serve` 端口被占时不会报错：上面已经是本项目的面板就**直接打开它**（不重复启动），
  是别的服务（或探测不出来）就顺延到下一个空闲端口再起自己的面板
- 两种情况都会自动打开浏览器；`NX_SERVE_NO_OPEN=1`（所有 nx-xx 项目共用的同一个
  环境变量）可全局关掉自动开浏览器，`--no-open` 只影响这一次调用
- `pnpm dev` 同样先认领后端端口：自己的面板就复用（不再起第二个 serve），别的服务就
  顺延到下一个空闲端口（vite 的代理目标会跟着一起走）；两种情况都会把浏览器指到 dev 地址

## 典型会话

1. 用户要求启动面板 → `serve`，确认端口可访问
2. 用户问「有哪些接口/命令」→ `routes`
3. 用户要把本 skill 装给 agent → `skill install mn-ws`
   （安装钩子会校验当前目录是本项目根，并注入项目根路径）

## 约束

- 操作本项目一律在项目根目录内调用本地 CLI
- 本 skill 只能在 mn-ws 项目根目录安装：非该目录会被安装钩子拒绝
- 命令、参数与 flag 的权威清单看 `routes --json`，不要凭记忆杜撰
