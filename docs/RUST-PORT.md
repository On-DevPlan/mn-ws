# mn-ws 全量 Rust 化 —— 实施记录（2026-11-14）

> 目标：把 **client 半与 server 半**都从 TypeScript/Node 换成 Rust，
> **运行时零 Node 依赖**；Rust 构建产物**随 npm 一起分发**；
> 使用方式（CLI 子命令、flag、配置格式）**保持不变**。
>
> 结论：**已落地。**本文记录做成了什么、怎么验证的、以及留下的取舍。

---

## 1. 为什么要 server 半也转

最初的评估（`docs/RUST-CLIENT-EVAL.md` 的前身）只针对 client 半。
后来加上了 server 半，理由不是「统一技术栈」这种泛泛的好处，而是三条**具体的**：

1. **运行时零 Node 依赖**要成立，server 半也得是原生二进制 ——
   否则公网机上还得留着 Node 与 node_modules。
2. **协议层从「双实现」变成「单实现」**。
   两半都转 Rust 之后，协议可以放进**一个共享 crate**（`mn-ws-core`），
   两半都依赖它 —— 漂移在**结构上**就不可能发生。

   这一点是 TS/Rust 混编时拿不到的：混编时协议有两份实现，
   契约测试只能**发现**漂移，不能**杜绝**它。
3. **Docker 镜像小一个数量级**。原来 `node:22-alpine` + `npm install`（~180MB），
   现在是一个静态二进制（~6MB）+ `debian:bookworm-slim` 运行层。

---

## 2. 架构

```
rust/
  Cargo.toml           workspace
  mn-ws-core/          协议层：帧格式 + app 路由规则（**两半共用**）
  mn-ws-client/        client 半：本机桥 + 面板静态资源服务 + CLI
  mn-ws-server/        server 半：公网 HTTP ⇄ WebSocket 桥
```

`mn-ws-core` 里是 `protocol.rs`（帧格式、头的规范化与剥离）与 `apps.rs`
（app 标识与路由规则）。**改协议必须改一处，两端同时生效。**

### 关键设计

| 决策 | 理由 |
|---|---|
| 协议层用 `serde_json::Value` 而非逐字段结构体 | 协议是**零语义**的，任何业务语义都不进协议层；逐字段结构体会在遇到未知字段时丢数据（那是协议演进要命的） |
| `serde_json` 开 `preserve_order` | 帧的 JSON **键序**会进到字节里；键序变了「逐字节对比」就误报成协议不一致 |
| 协议头用 `IndexMap` 而非 `HashMap` | 同上：头的顺序会进到帧的 JSON 里 |
| 手写 HS256 而非引 JWT 库 | 只需要 HS256 这一种算法，引库会带进一整条供应链（与 mn-rt `server/src/auth.js` 同理由） |
| `content-length` 按实际 body 重算 | body 走过一趟 base64（膨胀 ~33%），透传原长度会让本机服务按错误长度读 body —— 轻则截断、重则挂住 |
| `X-Mn-Ws-Token` 与 `Origin` 从转发头剥掉 | 前者是桥接层 L1 凭据（泄给目标服务等于交出门禁令牌），后者会让目标服务的同源防护 403 |
| 4403 = 停止重连 | 重连用的是同一枚静态令牌，是**确定性**失败；无限重连只会刷屏，而真正要用户做的事（重新 `auth login`）一句提示都不会有 |
| HTTP + WS 同端口 | 与 TS 版 `WebSocketServer({server})` 一致 —— 部署时只暴露一个端口 |

---

## 3. 分发：原生二进制随 npm 走

### 3.1 结论

**npm 的 `bin` 指向原生二进制时，npm 生成的 shim 直接调它，不经过 node。**
已实测（`scripts/verify-dist.mjs`）：

- Windows 的 `.cmd` shim 内容：`"%dp0%\..\<pkg>\bin\<name>.exe" %*` —— **没有 node**
- 把 node 从 `PATH` 里**彻底移除**后，`mn-ws --version` 照样返回 `mn-ws 0.6.1`

### 3.2 踩到的坑：npm 不做扩展名补全

`bin` 指向 `./bin/mn-ws` 而文件是 `./bin/mn-ws.exe` 时：

- npm **找不到目标** → **不生成 shim**
- 更糟：npm 会把那个路径**从包里移走**（实测 `bin/` 目录装完是空的）

所以 `bin` 字段必须指向**当前平台真实存在的文件名**。
解法：打包时按平台改写 `package.json` 的 `bin`（`scripts/platform-bin.mjs`），
CI 在每个平台各自 build + 各自 pack —— 每个平台发布的包自洽。

### 3.3 多平台

CI（`.github/workflows/build-rust.yml`）编译四个平台：
`win32-x64` / `darwin-x64` / `darwin-arm64` / `linux-x64`，
每个平台打一个 npm 包。

**发布的包只含当前平台的产物** —— 用户 `npm i -g mn-ws` 装到的是他所在平台的版本。

---

## 4. 怎么验证的

### 4.1 单测（83 条）

```
mn-ws-core     19 条   协议层：帧编解码、头的规范化/剥离、app 路由规则
mn-ws-client   30 条   配置、账号簿、面板 API、存储、常用应用、登录态
mn-ws-server   21 条   配置解析、日志、审计落盘、设备令牌签发/校验
e2e             8 条   真起服务、真打穿
面板登录         5 条   假认证中心跑完整 PKCE 流程
```

### 4.2 端到端（`rust/mn-ws-server/tests/e2e.rs`）

真的起一个假目标服务 + 真的起 server 半 + 真的用桥的协议打过去。
断言刻意写成**逐字对比**（目标服务看到的路径/头/body 与期望一致），
而不是「状态码是 200」这种弱断言 —— 弱断言会让「请求打到了错误的地方」溜过去。

### 4.3 交叉兼容（`client/tests/cross-compat*.mjs`）

**三向**都验过：

| 方向 | 脚本 | 结论 |
|---|---|---|
| TS client → Rust server | `cross-compat.mjs` | 13/13 通过 |
| Rust client → TS server | `cross-compat-reverse.mjs` | 12/12 通过 |
| Rust client → Rust server | `e2e.rs` | 8/8 通过 |

为什么必须做交叉兼容：server 半在公网机上，client 半在用户机器上，
两者**独立发布**，升级必然错开 —— 新版 client 要能连旧版 server，
旧版 client 也要能连新版 server。

### 4.4 面板实测（`client/tests/panel-check.mjs`）

真的起 Rust client 面板，真的伺服 React 构建产物，把 22 个 API 端点打一遍。

### 4.5 分发实测（`scripts/verify-dist.mjs`）

打包 → 装到隔离目录 → **把 node 从 PATH 移除** → 跑。

---

## 5. 现在的边界

### 5.1 面板登录流程已实现，但与 TS 版有一处**刻意的**不同

Rust 版的面板登录（`POST /api/auth/login/start` → 浏览器 → `/callback`）已实现，
用假认证中心做了端到端验证（`rust/mn-ws-client/tests/panel_login.rs`）。

**不同点**：client 半自己换码后，**不调 userinfo** —— 直接拿 access_token
去 server 半换设备令牌。TS 版也是这样（userinfo 是 server 半换码时的步骤）。
少一次往返，也少一处「认证中心的凭据要传多远」。

### 5.2 skill 模块没进 Rust

`core/skills/*`（748 行，管 `~/.claude/skills` 的安装）仍是 TS。
它与桥接无关，是「平台能力」，留在 TS 侧不影响零 Node 依赖的承诺
（面板是构建期产物）。

### 5.3 `port` 的探测是同步的

Rust 版 `/api/bridge/apps` 的 `alive` 目前恒为 `true`；
TS 版会真去 connect 探测端口。这是控制面的小差异，不影响桥接。

---

## 6. 用法没变

```text
# client 半
mn-ws serve [--port N] [--url ws://…] [--token …] [--apps a,b]
mn-ws bridge start|stop
mn-ws status
mn-ws apps list|add|remove|set|known
mn-ws catalog
mn-ws auth login|list|switch|logout

# server 半
mn-ws-server [--host h] [--port n] [--token TOKEN] [--jwt-secret s]
mn-ws-server doctor
```

配置文件 `~/.mn-ws/config.json` 的字段名与 TS 版**逐字一致** ——
用户从旧版升到 Rust 版，登录态、白名单、登记的应用都不会丢。

server 半的 `~/.mn-ws/server.json`、环境变量前缀 `MN_WS_`、三道安全闸
（无鉴权不许起 / 无鉴权不许绑 0.0.0.0 / 端口被占明确报错不顺延）也**逐条对齐**。
