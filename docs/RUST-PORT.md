# mn-ws 全量 Rust 化 —— 实施记录（2026-11-14）

> 目标：把 **client 半与 server 半**都从 TypeScript/Node 换成 Rust，
> **运行时零 Node 依赖**；Rust 构建产物**随 npm 一起分发**；
> 使用方式（CLI 子命令、flag、配置格式）**保持不变**。
>
> 结论：**已落地。**本文记录做成了什么、怎么验证的、以及留下的取舍。
>
> 纯 TS 的最后实现保存在 tag **`ts-final`**（Rust 化提交 12f2412 的父提交），
> 需要回看参考实现时 `git checkout ts-final`。

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

## 3. 分发：原生二进制随 npm 走（平台子包模式）

### 3.1 模型（0.7.2 起，esbuild / rollup 同款）

一个包名一个版本在 npm 上只能有一份 tarball，而原生二进制按平台不同 ——
所以二进制住进**平台子包**，主包只带启动器与平台无关的产物：

```
mn-ws                 主包：bin/mn-ws.js（启动器）+ web/public（React 产物）
  optionalDependencies → 平台子包（npm 按 os/cpu/libc 只装匹配的那个）：
  mn-ws-win32-x64      bin/mn-ws.exe        x86_64-pc-windows-msvc
  mn-ws-darwin-x64     bin/mn-ws            x86_64-apple-darwin
  mn-ws-darwin-arm64   bin/mn-ws            aarch64-apple-darwin
  mn-ws-linux-x64      bin/mn-ws            x86_64-unknown-linux-gnu（glibc）
```

用户敲 `mn-ws` → npm shim → 启动器按当前平台 `require.resolve` 子包里的
二进制 → spawn（stdio 直通、退出码透传）。面板产物平台无关，只此一份；
启动器在用户没设 `MN_WS_WEB_DIR` 时把它指到主包的 `web/public`
（Rust `web_dir()` 的第一优先级）。

**为什么启动器走 Node 不损失什么**：装 npm 包必然经过 npm（即必然有 Node）。
「零 Node 依赖」的确切含义是**二进制本身**运行时不依赖 Node
（build-rust 的冒烟里显式移除 PATH 上的 node 验证）。

子包是 pnpm workspace 成员（`client/platform/<key>/package.json` 入库，
`bin/` 不入库），主包用 `workspace:*` 引用 —— 本地装包不碰 registry，
`pnpm pack` 时自动重写成具体版本。发布顺序：平台矩阵先发 4 个子包，
全部成功后主包收尾（release.yml 三个 job）。

### 3.2 为什么改掉「单包带二进制」的旧模型

0.6.x～0.7.1 的做法是「打包时按平台改写 bin 字段，每平台各自 pack」。
它有两个致命问题，0.7.1 实测踩中后者：

1. **一个版本只能发一份 tarball**。release.yml 在 ubuntu 上构建并发布 ——
   Windows 用户装到的是 Linux ELF + 指向无扩展名文件的 bin，装完即坏。
   build-rust.yml 里「每平台各自 pack」的产物从未真正发布过，设计只做了一半。
2. npm 不做扩展名补全：bin 指向 `./bin/mn-ws` 而文件是 `mn-ws.exe` 时，
   npm 找不到目标、不生成 shim，还会把该路径从包里移走（实测）。

平台子包模式把「平台差异」交给 npm 的 os/cpu 机制处理，单 tarball 的
平台歧义从结构上消失。

### 3.3 多平台编译

CI（`.github/workflows/build-rust.yml`）在四个平台编译 + 单测 +
无 Node 冒烟 + 子包生成 + 主包 tarball 组装校验（不发布）；
`release.yml` 在四个平台各自编译并发布子包（win32-x64 / darwin-x64 /
darwin-arm64 / linux-x64），全绿后发主包。

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

平台子包 → 主包 tarball → 隔离目录安装 → 敲 `mn-ws` 跑通（启动器 → 二进制）；
再**把 node 从 PATH 移除**直接跑二进制本体 —— 「二进制运行时零 Node 依赖」
的固化证明（启动器本来就要 Node，二进制不）。

---

## 5. 现在的边界

### 5.1 面板登录流程已实现，但与 TS 版有一处**刻意的**不同

Rust 版的面板登录（`POST /api/auth/login/start` → 浏览器 → `/callback`）已实现，
用假认证中心做了端到端验证（`rust/mn-ws-client/tests/panel_login.rs`）。

**不同点**：client 半自己换码后，**不调 userinfo** —— 直接拿 access_token
去 server 半换设备令牌。TS 版也是这样（userinfo 是 server 半换码时的步骤）。
少一次往返，也少一处「认证中心的凭据要传多远」。

### 5.2 skill 模块已从项目里移除

原来有个「随包 skill 的安装」功能（`core/skills/*`，748 行，管 `~/.claude/skills`
的安装），**已整体删除** —— TS 侧 6 个源文件 + assets 目录 + 3 个 smoke 测试，
Rust 侧不实现。

删掉的理由有两条：

1. **它的 hook 机制与「运行时零 Node 依赖」直接冲突**。
   它的 `module` handler 是 ESM 模块（`import()` 一个 `.mjs`）——
   要跑它就必须有 Node。
2. **它与桥接无关**：那是「平台能力」，不是「桥的能力」。

删的时候要连带处理干净，否则两边会分裂：
- `runtime/registry.ts` 的模块注册表（去掉 skill 模块）
- `CLI_ONLY_PREFIXES` 的 `skill` 豁免前缀（registry.ts 与 eslint.config.js **两处**，
  有单测对账）
- `eslint.config.js` 的模块路径枚举
- `client/package.json` 的 `files`（assets 不再存在）

### 5.3 CLI 与面板共用一份实现

Rust 侧新增 `commands.rs`：每个动作**只有一份实现**，CLI 与面板是两个入口
（`mn-ws greet 世界` 与 `POST /api/greet` 做的是同一件事）。

这是「Web 上每个操作都有等价 CLI 命令」的结构性保证 ——
实现只有一份，不可能两边分叉。

Rust CLI 补齐了 TS 版的全部命令面：
`bootstrap show` / `routes` / `health` / `greet` / `setting get|set` /
`version`，加上原有的 `serve` / `bridge start|stop` / `status` /
`apps list|add|remove|set|known|reopen` / `catalog` / `auth login|list|switch|status|logout`。

每个命令都支持 `--json`（机器可读）与人读模式两种输出，形态与 TS 版逐字对齐。

smoke 测试也改测**原生二进制**（不是 TS 源码）——
npm 包里分发的就是它，测 TS 源码等于测了个不存在的东西。

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
mn-ws bootstrap show / routes / health / greet / setting get|set / version

# server 半
mn-ws-server [--host h] [--port n] [--token TOKEN] [--jwt-secret s]
mn-ws-server doctor
```

配置文件 `~/.mn-ws/config.json` 的字段名与 TS 版**逐字一致** ——
用户从旧版升到 Rust 版，登录态、白名单、登记的应用都不会丢。

server 半的 `~/.mn-ws/server.json`、环境变量前缀 `MN_WS_`、三道安全闸
（无鉴权不许起 / 无鉴权不许绑 0.0.0.0 / 端口被占明确报错不顺延）也**逐条对齐**。

---

## 7. TS 版还留着什么，为什么

**发布物是 Rust 版**（npm 包里是原生二进制，镜像是 Rust 二进制）。

但 TS 源码**没有删** —— 它有两个当下的用途：

1. **交叉兼容测试的参照物**。
   `client/tests/cross-compat-reverse.mjs` 要起一个**真的 TS server 半**，
   验证「旧版 client 能连新版 server」。TS 版在切流期间就是旧版。
2. **对照与回滚**。

切流稳定、且确认没有旧版本 client 在跑之后，TS server 半才可以退役。
那之前它是**活的对照组**，不是死代码。

---

## 8. 分发结构

```
server 半   →  Docker 镜像（公网机上的服务，npm 包对它没有意义）
              server/package.json 标 private:true，不发 npm
              npm 上的 mn-ws-server 停在 0.6.x

client 半   →  npm 包（一条命令装上，这是 npm 唯一的作用）
              bin/mn-ws[.exe]   原生二进制
              web/public/       React 构建产物
              运行时零依赖：不需要 npm 装任何运行时依赖
```

client 不再依赖 `mn-ws-server` —— 之前它依赖 `mn-ws-server@workspace:*`，
意味着 server 半不发布的话 **client 就装不上**（ETARGET）。
现在 mn-ws-server 在 client 的 devDependencies 里（本地 workspace 链接），
只服务交叉兼容测试。

---

## 9. 一次线上事故：镜像里打进的是占位产物

**症状**：镜像构建成功、能 load、容器能 start，但容器反复 `Restarting (0)`、
健康检查永远不过、**日志全空**。

**根因**：Dockerfile 的多阶段构建是「先占位预编译依赖，再编真源码」。
cargo 按**指纹**决定要不要重编 —— 第二步 Cargo.toml/依赖/target 都没变，
cargo 认为产物是新鲜的，**直接复用了占位产物**（`fn main() {}`）。

跑起来什么都不干 → exit 0 → `--restart unless-stopped` 反复拉起。

**修法**：

1. 占位编完**清掉 `target/`** —— 让真源码必然重编。
2. 构建末尾加 `&& ./target/release/mn-ws-server --version` ——
   **构建时就验证二进制真的能跑**，这类问题再也溜不到线上。

**教训**：多阶段构建里，「用假的源文件预热依赖层」是个陷阱 ——
cargo 的增量判断不认「源文件内容变了」。要么清 target，要么在构建末尾自检产物。

已回滚到 TS 版镜像恢复服务。

