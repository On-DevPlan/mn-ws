# mn-ws —— HTTP ⇄ WebSocket 双向桥

把本机跑的 **HTTP 服务**经一条 WebSocket 长连接，桥给**只能发普通 HTTP 的远端客户端**。

**mn-ws 是通用桥，不认识任何具体服务。**「桥什么、桥到哪」由使用者登记；
桥只负责按**应用标识**把请求路由到对应的本地端口。

```
        ┌──────────────────────────┐
        │  客户端（curl / fr / Worker）│
        └────────────┬─────────────┘
                     │ HTTP（带鉴权头 + 应用标识）
                     ▼
        ┌────────────────────────────────────────┐
        │  mn-ws-server（公网机）  :7777           │
        │   HTTP 面：/health /stats /clients      │
        │            /<app>/*  ← 桥接入口          │
        │   WS  面：/ws（与 HTTP 同端口共存）      │
        └────────────┬───────────────────────────┘
                     │ WebSocket（出向连接，穿 NAT）
                     ▼
        ┌────────────────────────────────────────┐
        │  mn-ws client（用户自己的机器）          │
        │   收到帧 → 还原 HTTP → 打 127.0.0.1:端口 │
        │   同进程里还有 Web 面板（:7777，回环）    │
        └────────────┬───────────────────────────┘
                     ▼ HTTP (loopback)
              本机的任意 HTTP 服务
```

---

## 两个工程，一个仓库

`mn` = **mono**。本仓库是 monorepo，两半各是一个 npm 包：

| 包 | 目录 | 命令 | 跑在哪 |
|---|---|---|---|
| `mn-ws` | `client/` | `npx mn-ws` | **用户自己的机器**（被桥的服务那边） |
| `mn-ws-server` | `server/` | `npx mn-ws-server` | **公网机**（中继） |

两端说的是**同一套帧协议**，协议定义只写一份 —— 在 `rust/mn-ws-core/` 这个
crate 里，两半都依赖它。改协议 = 改一处，所以协议改动必须先想清楚兼容性。

**运行时零 Node 依赖**：两个包分发的都是**原生二进制**（Rust 编译），
装完直接用，机器上**不必有 Node**。React 面板是**构建期**产物，
由 client 半的原生二进制当静态资源服务器伺服。

> 迁移细节见 [`docs/RUST-PORT.md`](docs/RUST-PORT.md)。

---

## 快速上手

```bash
# ── 公网机：起中继服务（必须有鉴权，否则拒绝启动）──
npx mn-ws-server --host 0.0.0.0 --port 7777 --token <门禁TOKEN>

# ── 本机：一条命令既起桥又起面板 ──
#    --apps 后面是「应用名=本地基址」；名字只是路由标识，基址才是落点
npx mn-ws --apps my-api=http://127.0.0.1:7877

# ── 远端客户端：直接当普通 HTTP 服务用 ──
curl -H 'X-Mn-Ws-Token: <门禁TOKEN>' \
     'http://<服务器>:7777/my-api/api/ping'
```

**本地开发**：

```bash
pnpm install
pnpm -r build                            # 两个包的 TS 产物（前端 + 类型）
cd rust && cargo build --release         # 两个原生二进制
pnpm --filter mn-ws-server test
pnpm --filter mn-ws test:unit
pnpm --filter mn-ws dev                  # vite + 后端 tsx 直跑源码
```

**Rust 侧**（协议层 / 两半的实现）：

```bash
cd rust
cargo test --release                    # 75 例（含端到端）
cargo build --release                   # 两个二进制（各约 6MB）
```

---

## 命令

### `mn-ws`（client 半，本机）

| 命令 | 说明 |
|---|---|
| `mn-ws` | **起桥 + 起面板**（默认端口 7777，`--port N` 改端口） |
| `mn-ws status` | 桥接状态：连没连、注册了哪些 app、当前凭据是谁 |
| `mn-ws apps` | 列出可桥接的应用（白名单 + 本地端口存活探测） |
| `mn-ws apps set --apps a,b=http://127.0.0.1:7800` | 设置白名单（不给就一个都不桥） |
| `mn-ws apps add <名字> --port N [--title T]` | **动态登记**一个本机服务 |
| `mn-ws apps remove <名字>` | 移除一个动态登记的应用 |
| `mn-ws apps known` | 列出**已登记**的应用（名字 / 基址 / 标题） |
| `mn-ws catalog` | 拉远端 server 半的元信息目录 |
| `mn-ws bridge start` / `bridge stop` | 启停桥 |
| `mn-ws auth login` | 统一登录（弹浏览器）：换回设备令牌，之后免手填 |
| `mn-ws auth list` / `switch` / `status` / `logout` | 本机多账号账号簿 |
| `mn-ws doctor` | 环境自检：端口 / 鉴权 / 应用可达性 / server 连通性 |
| `mn-ws help` | 完整命令表（每个面板按钮都有对应命令） |

### `mn-ws-server`（server 半，公网机）

| 命令 | 说明 |
|---|---|
| `mn-ws-server` | 启动中继服务（HTTP 与 WS 同端口共存） |
| `mn-ws-server doctor` | 环境自检 |

---

## Web 面板（必须登录）

client 半的面板跑在**本机回环**（默认 `:7777`，`--port` 运行时可选），
提供：连接状态、**client 管理**（白名单勾选、启停桥、远端目录）、账号切换。

**面板必须登录才能用。** 门禁落在**服务端**，不是前端藏个按钮：

- 业务 API 一律先过登录态，没登录 → `401 not_logged_in`
- 豁免的只有「看一眼登录态」与「发起登录」这两条

两种拿登录态的方式：

1. **复用 CLI 的设备令牌** —— 本机 `mn-ws auth login` 存过的那一份，
   面板启动时直接进入登录态（不必登两遍）
2. **面板里现登** —— 点「登录」→ 弹浏览器 → PKCE 回环回调到**面板自己的**
   `/callback` → 换到设备令牌 → 存进账号簿

> 为什么门禁必须在服务端：面板握着桥的凭据（能连 server、能改白名单）。
> 只做在前端的话，任何本机进程照样能直接调 API。

---

## 远端怎么用：先看目录，再选，再路由

远端客户端拿到凭据后的标准动作是**先拉目录**（知道能路由到什么），再按应用标识发起请求。

目录**按 PC 分组** —— 多台电脑同时开着桥时，你要看的是「我有哪几台电脑，
每台上跑着什么」：

```bash
# ① 拉元信息目录（按 PC 分组）
curl -H 'X-Mn-Ws-Token: <门禁TOKEN>' http://<服务器>:7777/api/catalog
```

```json
{
  "ok": true,
  "pcCount": 2,
  "count": 3,
  "pcs": [
    {
      "bridgeId": "pc-a", "name": "办公室台式机", "userId": "5",
      "apps": [
        {"app":"my-api","title":"我的服务","port":9999,"base":"http://127.0.0.1:9999",
         "bridgeId":"pc-a","active":true}
      ]
    },
    {
      "bridgeId": "pc-b", "name": "家里笔记本", "userId": "5",
      "apps": [
        {"app":"my-api","title":"我的服务","port":9999,"base":"http://127.0.0.1:9999",
         "bridgeId":"pc-b","active":false}
      ]
    }
  ],
  "apps": [ /* 同一份内容的扁平形态，老客户端靠它 */ ]
}
```

② 按目录里选中的应用发起请求 —— **路径前缀**与**请求头**两种写法等价：

```bash
# 路径前缀
curl -H 'X-Mn-Ws-Token: $TOKEN' 'http://<服务器>:7777/my-api/api/ping'

# 请求头（路径原样，适合已有客户端不想改 URL）
curl -H 'X-Mn-Ws-Token: $TOKEN' -H 'X-Mn-Ws-App: my-api' \
     'http://<服务器>:7777/api/ping'
```

两者冲突 → `400 app_conflict`（**不猜**：猜错等于把请求打到别的服务上）。

### 两台机器都有同一个应用时

「一个 app 名对应一个桥」是**路由**的规矩。两台 PC 都跑 `my-api` 时，
路由归**后来注册**的那台（`active: true` 标出来），另一台也在目录里，
但它那份 `active: false` —— 看得见、路由不到。

要精确指定打哪台，加一个头：

```bash
curl -H 'X-Mn-Ws-Token: $TOKEN' \
     -H 'X-Mn-Ws-App: my-api' -H 'X-Mn-Ws-Pc: pc-a' \
     'http://<服务器>:7777/api/ping'
```

指定了但那台没有这个应用 → `404 unknown_pc_app`（**不默默打到另一台**）。

### 多路复用

每条 client 半的 WS 连接是一个独立的「桥」。server 半维护 `app → ws` 的路由表，
**请求按应用标识落到对应的那条 WS 上**：

```
                     ┌── WS#1（host-a：my-api）──▶ 127.0.0.1:9999
客户端 ──HTTP──▶ server ─┤
                     └── WS#2（host-b：other-api）──▶ 127.0.0.1:7800
```

同机跑两个 client、或多台机器各跑一个，都由这张表分流，互不串台。
多个 client 声明同一个 app 时**后来者顶替前者**（同机跑两份是异常状态，
顶替比随机命中更可预期）；顶替者一旦断开，app 会**归还**给仍连着的旧桥。

---

## 应用标识（app）

一个请求该去哪个本地端口，靠**应用标识**区分。两种都支持，**路径前缀优先**：

```
① POST /my-api/api/todo/add              → app=my-api, path=/api/todo/add
② POST /api/todo/add  (X-Mn-Ws-App: my-api) → app=my-api, path=/api/todo/add
```

- 路径前缀优先：客户端零改造（curl 直接打）、自定义头不会被中间反代剥掉、一个请求只对应一个 app
- 两者冲突 → `400 app_conflict`（**不猜**）
- 都缺 → `400 app_required`

### 哪些可以桥接

**白名单说了算**：只有被**登记**（`--apps` / 配置文件 / 面板动态登记）
**且**在白名单里的应用才会被桥。端口探测（`mn-ws apps`）**只用来显示状态，
不会自动开桥** —— 扫到端口在监听就自动开桥，等于把整台机器暴露出去。

mn-ws **没有内置应用表**：它不认识任何具体服务，名字只是路由标识。
一个应用要能桥，需要两样东西 —— **名字**与**基址**：

```bash
# 名字 + 基址内联，一条命令登记好
mn-ws apps set --apps my-api=http://127.0.0.1:9999

# 或者先登记、后进白名单
mn-ws apps add my-api --port 9999 --title '我的服务'
```

白名单里有、但没登记基址的应用会被**跳过**，并明确报出来 ——
静默跳过会让人以为「桥了但不通」。

### 运行时动态登记端口

**你自己起的服务同样能被桥出去** —— 在面板的「动态登记」里给它起个
**路由标识**和端口就行：

```
路由标识   my-api          ← 小写字母开头，只含小写字母/数字/连字符（它要当路由标识用）
端口       9999            ← 或填完整基址
显示名     我的服务         ← 可选，远端目录里给人看
```

链路是这样走的：

1. 落盘到 `~/.mn-ws/config.json` 的 `customApps`，同时进白名单
2. 桥重注册时把整张 app 表（**连标题一起**）报给 server 半
3. server 半汇总进**元信息目录**
4. 远端客户端拉目录 → 看到「有哪些端口、叫什么」→ 用
   `X-Mn-Ws-App: my-api` 或路径前缀 `/my-api/...` 打过来
5. 之后就是原来的 http/ws 转换逻辑，一行没改

CLI 等价：

```bash
mn-ws apps add my-api --port 9999 --title '我的服务'
mn-ws apps remove my-api
```

---

## 三层鉴权

| 层 | 管什么 | 载体 |
|---|---|---|
| **L1 通道层** | 谁能用这个桥 | `X-Mn-Ws-Token` 头（设备令牌 或 静态门禁） |
| **L2 路由层** | 请求的 app 必须在该桥的注册表里，且属主匹配 | 应用标识 |
| **L3 应用层** | 被代理服务自己的那套鉴权 | `Authorization` / `Cookie` **原样透传** |

**两层凭据必须分开** —— `Authorization` 是被代理服务的地盘（很多服务就自己读
`Authorization: Bearer`），L1 走独立头 `X-Mn-Ws-Token`，否则两边令牌互相打架 → 401。

`X-Mn-Ws-Token` 是桥接层内部事务，**不会**被透传给目标服务。

### 设备令牌 vs 静态门禁

| | 设备令牌（统一登录） | 静态门禁 `--token` |
|---|---|---|
| 隔离 | 按用户 —— 只能访问自己名下的桥 | 共享密钥 —— 等价全量访问 |
| 吊销 | 可单独吊销（按 jti） | 换密钥才算换 |
| 建议 | **生产用这个** | 仅自测 / 单人使用 |

### 两端各有各的 client_id

统一登录走 go-ah（auth-hub）。mn-ws 在那里登记了**两个**客户端：

| client_id | 是谁 | 回调白名单 | 干什么 |
|---|---|---|---|
| `mn-ws-client` | **client 半**（本机 CLI / 面板 / 手机端） | 回环通配 + `/callback` | 真正发起授权码流程 |
| `mn-ws-server` | **server 半**（公网机） | `http://127.0.0.1:7777/auth/callback` | server 半自己的身份 |

**为什么拆**：client_id 是**审计与吊销的单元**。共用一个之后，「哪个平台在发 token」
→「要停哪条接入」都问不出来。

### 业务令牌端点：`POST /auth/oidc/callback`

远端客户端（手机 App 等）拿到**统一登录的登录态**之后，用它铸一枚授权码，
再交给**本服务**换一枚**本服务自己的**令牌：

```http
POST /auth/oidc/callback
{"code":"...","codeVerifier":"...","redirectUri":"http://127.0.0.1:39471/callback"}
→ {"ok":true,"userId":"5","token":"...","tokenExpiresAt":...}
```

**换码在服务端做**，用的是 **client 半的身份**（`mn-ws-client`）。
认证中心签出的 access_token / refresh_token 指向的是**整个平台的身份**，
它们**一次都不出服务端** —— 一旦流经客户端，截获即等于账号接管。

带上 `clientId` 则登记一台设备并签设备令牌（PC 桥接端用）；
不带则签一枚「用户令牌」，它代表身份、不代表某台设备（手机端用）。

---

## 安全

- **server 无鉴权直接拒绝启动**（`--insecure` 才放行，且会打醒目警告）
- **无鉴权时不允许绑 0.0.0.0**
- **端口占用预检**：被占就明确报错退出，**不静默顺延**（顺延会让客户端连错端口，两边对不上账）
- **本地面板只绑 127.0.0.1**，且**必须登录**
- **每次经桥的请求落审计**（`~/.mn-ws/data/requests.jsonl`）
- **跨站防护不被绕过**：Origin 头在桥接时被剥离 —— 桥接请求本来就来自本机，
  剥掉是恢复真实语义（不剥的话目标服务的同源校验会 403）
- **心跳**：两端都定期 ping 对方。TCP 是半开的 —— 对端被 `docker rm` 掉时
  RST 可能丢掉，没有心跳就会出现「客户端以为还连着、其实已经哑了」，
  而且**永远不会自己恢复**
- ⚠️ **公网那台 server 的 7777 是裸奔的**（无 TLS）—— **已明确接受的风险**
  （2026-11-13 决定：不前置 nginx + TLS）。明文那一跳带的是 mn-ws 自己的
  业务令牌，截获即等于账号接管。细节与「真要收口时怎么收」见
  [docs/DEPLOY.md](docs/DEPLOY.md) 的「已知风险」

---

## 开发

```bash
pnpm install
pnpm -r build                            # 两个包的 TS 产物（前端 + 类型）
pnpm --filter mn-ws-server test          # 37 例（协议 / 端到端 / 鉴权 / 多路复用 / 业务令牌 / 心跳）
pnpm --filter mn-ws test:unit            # 79 例（配置 / 账号簿 / PKCE / 白名单 / 面板）
pnpm --filter mn-ws test:cross           # 交叉兼容：TS ↔ Rust 两个方向
pnpm --filter mn-ws test:panel           # Rust 面板实测：伺服 React 产物 + 全部 API 端点
pnpm --filter mn-ws test:e2e             # 打已部署的公网 server 半做远端验收

cd rust && cargo test --release          # 75 例（协议层 / 两半 / 端到端）
```

**分发实测**（打包 → 装到隔离目录 → **移除 PATH 里的 node** → 跑）：

```bash
node scripts/verify-dist.mjs
```

设计文档：[docs/design.md](docs/design.md) · 部署手册：[docs/DEPLOY.md](docs/DEPLOY.md) ·
Rust 化记录：[docs/RUST-PORT.md](docs/RUST-PORT.md)
