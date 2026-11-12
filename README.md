# mn-ws —— HTTP ⇄ WebSocket 双向桥

把本机跑的 **nx 系列服务**（nx-kv / nx-rh / nx-sk …）经一条 WebSocket 长连接，
桥给**只能发普通 HTTP 的远端客户端**。

**不修改任何现有 nx 服务。**

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
        │  mn-ws client（本机，跑在 nx 那台机器） │
        │   收到帧 → 还原 HTTP → 打 127.0.0.1:端口 │
        │   同进程里还有 Web 面板（:7777，回环）    │
        └────────────┬───────────────────────────┘
                     ▼ HTTP (loopback)
              nx-kv / nx-rh / …
```

---

## 两个工程，一个仓库

`mn` = **mono**。本仓库是 monorepo，两半各是一个 npm 包：

| 包 | 目录 | 命令 | 跑在哪 |
|---|---|---|---|
| `mn-ws` | `client/` | `npx mn-ws` | **用户自己的机器**（本机 nx 服务那边） |
| `mn-ws-server` | `server/` | `npx mn-ws-server` | **公网机**（中继） |

两端说的是**同一套帧协议**，协议定义只写一份 —— 放在 `mn-ws-server` 包里，
client 半以 workspace 依赖引入（`import { FRAME } from 'mn-ws-server/protocol'`）。
改协议 = 改两端，所以协议改动必须先想清楚兼容性。

---

## 快速上手

```bash
# ── 公网机：起中继服务（必须有鉴权，否则拒绝启动）──
npx mn-ws-server --host 0.0.0.0 --port 7777 --token <门禁TOKEN>

# ── 本机：一条命令既起桥又起面板 ──
npx mn-ws --apps nx-kv,nx-rh

# ── 远端客户端：直接当普通 HTTP 服务用 ──
curl -H 'X-Mn-Ws-Token: <门禁TOKEN>' \
     'http://<服务器>:7777/nx-kv/api/ping'
```

**本地开发**：

```bash
pnpm install
pnpm -r build          # 两个包都要构建（client 依赖 server 的类型）
pnpm --filter mn-ws-server test
pnpm --filter mn-ws dev  # vite + 后端 tsx 直跑源码
```

---

## 命令

### `mn-ws`（client 半，本机）

| 命令 | 说明 |
|---|---|
| `mn-ws` | **起桥 + 起面板**（默认端口 7777，`--port N` 改端口） |
| `mn-ws status` | 桥接状态：连没连、注册了哪些 app、当前凭据是谁 |
| `mn-ws apps` | 列出可桥接的应用（白名单 + 本地端口存活探测） |
| `mn-ws apps set --apps nx-kv,nx-rh` | 设置白名单（不给就一个都不桥） |
| `mn-ws apps add <名字> --port N` | **动态注册**一个不在已知表里的本机服务 |
| `mn-ws apps remove <名字>` | 移除一个动态注册的应用 |
| `mn-ws apps known` | 列出已知的 nx 服务与默认端口 |
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

远端客户端拿到凭据后的标准动作是**先拉目录**（知道能路由到什么），再按应用标识发起请求：

```bash
# ① 拉元信息目录（哪些能路由、分别在哪个端口、由哪台桥承载）
curl -H 'X-Mn-Ws-Token: <门禁TOKEN>' http://<服务器>:7777/api/catalog
```

```json
{
  "ok": true,
  "count": 2,
  "apps": [
    {"app":"nx-kv","title":"KV 清单中枢","port":7877,"base":"http://127.0.0.1:7877",
     "bridgeId":"host-a","connectedAt":"2026-11-12T11:00:00.000Z"},
    {"app":"nx-rh","title":"仓库与 Skill 中枢","port":7800,"base":"http://127.0.0.1:7800",
     "bridgeId":"host-b","connectedAt":"2026-11-12T11:00:01.000Z"}
  ]
}
```

② 按目录里选中的应用发起请求 —— **路径前缀**与**请求头**两种写法等价：

```bash
# 路径前缀
curl -H 'X-Mn-Ws-Token: $TOKEN' 'http://<服务器>:7777/nx-kv/api/ping'

# 请求头（路径原样，适合已有客户端不想改 URL）
curl -H 'X-Mn-Ws-Token: $TOKEN' -H 'X-Nx-App: nx-kv' \
     'http://<服务器>:7777/api/ping'
```

两者冲突 → `400 app_conflict`（**不猜**：猜错等于把请求打到别的服务上）。

### 多路复用

每条 client 半的 WS 连接是一个独立的「桥」。server 半维护 `app → ws` 的路由表，
**请求按应用标识落到对应的那条 WS 上**：

```
                     ┌── WS#1（host-a：nx-kv）──▶ 127.0.0.1:7877
客户端 ──HTTP──▶ server ─┤
                     └── WS#2（host-b：nx-rh）──▶ 127.0.0.1:7800
```

同机跑两个 client、或多台机器各跑一个，都由这张表分流，互不串台。
多个 client 声明同一个 app 时**后来者顶替前者**（同机跑两份 nx 是异常状态，
顶替比随机命中更可预期），被顶替的 client 会收到 `replaced` 通知。

---

## 应用标识（app）

一个请求该去哪个本地端口，靠**应用标识**区分。两种都支持，**路径前缀优先**：

```
① POST /nx-kv/api/todo/add              → app=nx-kv, path=/api/todo/add
② POST /api/todo/add  (X-Nx-App: nx-kv) → app=nx-kv, path=/api/todo/add
```

- 路径前缀优先：客户端零改造（curl 直接打）、自定义头不会被中间反代剥掉、一个请求只对应一个 app
- 两者冲突 → `400 app_conflict`（**不猜**）
- 都缺 → `400 app_required`

### 哪些可以桥接

**白名单说了算**：只有 `--apps` / `--ports` / `--app-map` 里列出的应用才会被桥。
端口探测（`mn-ws apps`）**只用来显示状态，不会自动开桥** —— 扫到端口在监听就自动开桥，
等于把整台机器暴露出去。

### 运行时动态注册端口

已知表（`KNOWN_APPS`）只覆盖 nx 系列。**你自己起的服务同样能被桥出去** ——
在面板的「动态注册」里给它起个**路由标识**和端口就行：

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
   `X-Nx-App: my-api` 或路径前缀 `/my-api/...` 打过来
5. 之后就是原来的 http/ws 转换逻辑，一行没改

CLI 等价：

```bash
mn-ws apps add my-api --port 9999 --title '我的服务'
mn-ws apps remove my-api
```

已知 nx 服务与默认端口（2026-11-12 实测各仓 `core/paths.js`）：

| app | 端口 | 服务 |
|---|---|---|
| nx-rh | 7800 | 仓库与 Skill 中枢 |
| nx-rp | 7820 | 外部上下文 |
| nx-sk | 7866 | 个人资源与密钥 |
| nx-ft | 7869 | 前端资源管理 |
| nx-kv | 7877 | KV 清单中枢 |
| nx-nx | 7880 | 项目生成器 |
| nx-kn | 7881 | Obsidian 知识库 |
| nx-ditto | 7883 | ditto |
| nx-pg | 7888 | 画布工作台 |

端口变了就用 `--app-map nx-kv=http://127.0.0.1:7999` 覆盖。

---

## 三层鉴权

| 层 | 管什么 | 载体 |
|---|---|---|
| **L1 通道层** | 谁能用这个桥 | `X-Mn-Ws-Token` 头（设备令牌 或 静态门禁） |
| **L2 路由层** | 请求的 app 必须在该桥的注册表里，且属主匹配 | 应用标识 |
| **L3 应用层** | nx 自己的那套鉴权 | `Authorization` / `Cookie` **原样透传** |

**两层凭据必须分开** —— `Authorization` 是 nx 的地盘（nx-kv 就是读
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
| `mn-ws-client` | **client 半**（本机 CLI / 面板） | 回环通配 + `/callback` | 真正发起授权码流程 |
| `mn-ws-server` | **server 半**（公网机） | `http://127.0.0.1:7777/auth/callback` | server 半自己的身份 |

**为什么拆**：client_id 是**审计与吊销的单元**。共用一个之后，「哪个平台在发 token」
「要停哪条接入」都问不出来。

---

## 安全

- **server 无鉴权直接拒绝启动**（`--insecure` 才放行，且会打醒目警告）
- **无鉴权时不允许绑 0.0.0.0**
- **端口占用预检**：被占就明确报错退出，**不静默顺延**（顺延会让客户端连错端口，两边对不上账）
- **本地面板只绑 127.0.0.1**，且**必须登录**
- **每次经桥的请求落审计**（`~/.mn-ws/data/requests.jsonl`）
- **跨站防护不被绕过**：Origin 头在桥接时被剥离 —— 桥接请求本来就来自本机，
  剥掉是恢复真实语义（不剥的话 nx-kv 的 `originAllowed()` 会 403）
- ⚠️ **公网那台 server 的 7777 是裸奔的**（无 TLS）—— 见 [docs/DEPLOY.md](docs/DEPLOY.md) 的「已知风险」

---

## 开发

```bash
pnpm install
pnpm -r build                            # 两个包
pnpm --filter mn-ws-server test          # 31 例（协议 / 端到端 / 鉴权 / 多路复用）
pnpm --filter mn-ws test:unit            # 60 例（配置 / 账号簿 / PKCE / 白名单 / 面板）
pnpm --filter mn-ws test:e2e             # 打已部署的公网 server 半做远端验收
```

设计文档：[docs/design.md](docs/design.md) · 部署手册：[docs/DEPLOY.md](docs/DEPLOY.md)
