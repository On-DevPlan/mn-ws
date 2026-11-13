# mn-ws 设计文档 —— HTTP ⇄ WebSocket 双向桥

> 状态：**待审核**（草案 v1，2026-11-12）
> 参考实现：mn-rt（RemoteType 中继）
> 目标读者：本项目的维护者

---

## 0. 一句话

**在公网侧起一个 mn-ws server，在本机侧起一个 mn-ws client。
server 把收到的 HTTP 请求封成 WebSocket 帧发给 client；client 把帧还原成 HTTP 请求打给本机的 nx 服务端口；
响应原路返回（HTTP → WS → HTTP）。**

对客户端而言，它就是把 `http://127.0.0.1:7877/api/...` 换成了 `http://mn-ws-host/my-api/api/...`，
**状态码、响应体、鉴权头、错误格式全部一致**。

**不修改任何现有 nx 服务。**

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 现有 HTTP 服务**零改动**即可被 HTTP 客户端经 WS 通道访问 | 被桥的服务不需要提 PR |
| G2 | 鉴权与身份验证**由桥接层实现**，同时**保留目标服务原生鉴权** | 请求头原样透传，目标服务的 auth 模块照常判 |
| G3 | 客户端体感与直连 **完全一致** | 同一请求直连 vs 走桥，响应体/状态码逐字节相同 |
| G4 | 一个 server 可同时服务**多个应用**，用**应用标识**区分 | `my-api` / `other-api` … 并存互不串 |
| G5 | 客户端断连不留下悬挂请求 | HTTP 关闭 → WS `abort` 帧 → 本机请求被销毁 |

### 1.2 非目标

- **不做** HTTP→WS 的**流式**双向代理（第一版只做请求-响应；协议里预留 chunk 帧位）
- **不做** 跨主机的服务聚合（client half 只桥本机 127.0.0.1 上的端口）
- **不做** 替换 mn-rt。两者是**兄弟**：mn-rt 桥的是「远端 PC 的输入」，mn-ws 桥的是「本机服务」
- **不做** 为 mn-ws 单独发明一套鉴权体系 —— 复用 go-ah 设备令牌
- **不做** 认识任何具体服务。**「服务长什么样」是使用者的知识，不是桥的知识** ——
  发行包里不内置任何服务的名字、端口表与用法；桥只认「名字 + 基址」这一层抽象

---

## 2. 拓扑

```
        ┌──────────────────────────┐
        │  客户端（curl / fr / Worker）│
        └────────────┬─────────────┘
                     │ HTTP（带鉴权头 + 应用标识）
                     ▼
        ┌────────────────────────────────────────┐
        │  mn-ws server（公网机，与 mn-rt 同机）    │
        │  :7777                                  │
        │   · HTTP 面：/health /stats /<app>/*    │
        │   · WS 面：/ws（与 HTTP 同端口共存）     │
        │   · 路由表：app → 本机 client half 连接  │
        └────────────┬───────────────────────────┘
                     │ WebSocket（公网机 → 本机，出向连接，穿 NAT）
                     ▼
        ┌────────────────────────────────────────┐
        │  mn-ws client（本机，跑在 nx 那台机器）  │
        │   · 常驻，主动连 server 并注册应用表      │
        │   · 收到 WS 帧 → 还原 HTTP 请求           │
        │   · 打给 127.0.0.1:<port>               │
        └────────────┬───────────────────────────┘
                     │ HTTP（loopback）
        ┌────────────▼───────────┐   ┌──────────────┐
        │ my-api  127.0.0.1:9999 │   │ other :7800 │  …
        └────────────────────────┘   └──────────────┘
```

**为什么必须是两半、而不是一个反向代理？**
公网机访问不到本机的 nx 端口（NAT / 内网 / 安全组）。
需要一个从本机**出向**的长连接，把请求「拉」过去 —— 这正是 mn-rt 里 PC 客户端的角色。

---

## 3. 与 mn-rt 的同构关系

mn-ws **不是** mn-rt 的变种，是**同构复制**。这是本设计最大的省力点：

| 概念 | mn-rt（RemoteType） | mn-ws（本设计） |
|---|---|---|
| 中继 server | `server/src/server.js`，:8790 | `server/src/server.js`，:7777 |
| 终端 client | `client/`（PC 端，跑在用户电脑上） | `client/`（跑在 nx 那台机器上） |
| 传输 | WebSocket `/ws` | WebSocket `/ws`（同端口与 HTTP 共存） |
| 注册帧 | `{"type":"register","role":"pc","clientId":"pc-001"}` | `{"type":"register","role":"bridge","apps":[…]}` |
| 路由表 | `pcs`（clientId→ws）、`phones`（phoneId→ws） | `bridges`（app→ws） |
| 消息路由 | `routeMessage(clientId,text,source,callerUserId)` | `routeRequest(app,httpReq)` |
| 跨属主拦截 | 发送者与目标设备必须同 userId | 请求的 app 必须属于该 bridge 的注册表 |
| 审计落盘 | `store.append(...)` | 同 |
| 计数 | `stats{connections,messagesIn,forwarded,…}` | 同 |
| 保活 | ws 库 ping/pong 30s | 同 |
| 认证 | go-ah 设备令牌（HS256 自签）或 `RT_TOKEN` 静态门禁 | 同 |
| CLI 形态 | 子命令制（`serve` 必须显式） | 同 |
| 配置目录 | `~/.nx-rt/config.json`，环境变量前缀 `REMOTETYPE_` | `~/.nx-ws/config.json`，前缀 `MN_WS_` |

**可以直接复制粘贴的部分**：`server/src/logger.js`、`server/src/store.js`（审计）、`server/src/auth.js`（令牌签发/校验）、
`client/lib/ws-client.js`（重连逻辑）、`client/lib/config.js`（配置合并）。**需要重写的**：`server.js` 的路由层、
`client` 的帧编解码与 HTTP 还原。

---

## 4. 组件与职责

### 4.1 mn-ws server（公网半）

| 职责 | 说明 |
|---|---|
| HTTP 面 | `/health`、`/stats`、`/clients`（列出已注册 bridge 与 app）、`/push`（测试用）、`/<app>/*`（桥接） |
| 认证面 | `/auth/oidc/config`（公开参数）、`/auth/oidc/callback`（**业务令牌端点**：收 code + verifier，服务端自己换码，认证中心的凭据不出服务端）、`/auth/verify`（拿认证中心 access_token 换设备令牌，给本机 CLI 用） |
| WS 面 | `/ws`，与 HTTP **同端口共存**（`WebSocketServer({ server: httpServer, path })`） |
| 路由表 | `bridges: Map<app, { ws, bridgeId, apps }>` |
| 待答表 | `pending: Map<requestId, { res, timer, bridgeId }>` |
| 审计 | 每请求落 `store.append({app, method, path, status, userId, ts})` |
| 限流 | 按来源 IP + app 限流（公网暴露面必须有） |

### 4.2 mn-ws client（本机半）

| 职责 | 说明 |
|---|---|
| 注册 | 启动时连 server，发 `register` 帧声明 `apps:[{app, base}]` |
| 还原 | 收到 `request` 帧 → 用 `http.request` 打 `base + path` |
| 透传 | method / path / query / **headers** / body **原样**（除 hop-by-hop 与 Origin） |
| 回包 | 收到响应 → 封 `response` 帧发回 |
| 取消 | 收到 `abort` 帧 → `req.destroy()` |
| 保活 | ws 库 ping/pong；断线自动重连 + **重新注册** |

---

## 4.5 元信息目录 → 选择 → 多路复用（v0.1.0 落地）

> 这一节是实现期补上的：客户端「怎么知道能路由什么」这件事，
> 光有协议不够，得有个**目录**。

### 元信息从哪来

client half 启动时在注册帧里带上**它愿意开放的端口与应用**：

```json
{"type":"register","role":"bridge","bridgeId":"host-a",
 "apps":[{"app":"my-api","base":"http://127.0.0.1:9999","port":9999,"title":"我的服务"}],
 "token":"…"}
```

server 半把这些元信息汇总成**目录**（`knownApps` + `bridges` 两张表）。

### 远端客户端的标准动作

```
① GET /api/catalog            带 L1 凭据 → 拿到可路由清单
   → { apps:[{app,title,port,base,bridgeId,connectedAt}] }
② 选一个 app，发请求：
   路径前缀   GET /my-api/api/todo/list
   请求头     GET /api/todo/list   + X-Mn-Ws-App: my-api
```

### 多路复用

`bridges: Map<app, {ws, bridgeId, userId, meta}>` ——
**每个 app 记住自己该落到哪条 WS 上**。多条 client half 连接（多台机器，
或同机跑两个）天然分流：

```
                     ┌── WS#1（host-a：my-api）──▶ 127.0.0.1:9999
客户端 ──HTTP──▶ server ─┤
                     └── WS#2（host-b：other-api）──▶ 127.0.0.1:7800
```

一个 app 被两个 client 声明 → **后来者顶替前者**（同机跑两份 nx 是异常状态，
顶替比随机命中更可预期），被顶的 client 收到 `registered.replaced` 通知。

### 「哪些可以桥接」由白名单说了算

端口探测（`mn-ws client apps`）**只用来显示状态**，绝不因为「扫到端口在监听」
就自动开桥 —— 那等于把整台机器暴露出去。开桥的开关是 `--apps` / `--ports` / `--app-map`。

---

## 5. 应用标识（app）与注册表

### 5.1 应用标识怎么带 —— 两个都支持，路径优先

**主路径：路径前缀**

```
POST /my-api/api/todo/add          → app = my-api, path = /api/todo/add
GET  /other-api/api/repos/list      → app = other-api, path = /api/repos/list
```

**辅路径：请求头**（给不想改 URL 的既有客户端）

```
POST /api/todo/add   X-Mn-Ws-App: my-api   → app = my-api, path = /api/todo/add
```

**优先级**：路径前缀 > 请求头。两者都缺 → `400 app_required`。
两者冲突 → `400 app_conflict`（**不猜**：猜错会把请求打到别的服务上）。

> **为什么主推路径前缀**：
> 1. 客户端零改造 —— `curl` 直接就能打，不需要记得加自定义头；
> 2. 自定义头可能被中间的反代 / CDN / WAF 剥掉，路径不会；
> 3. 一个请求只对应一个 app，天然没有「路径说 A、头说 B」的歧义。
>
> 请求头方案保留，是因为已有一批客户端是按 `http://host:7877/api/...` 写的，
> 只想换主机不想改 URL —— 那就靠 `X-Mn-Ws-App` 或把整段 host 前缀带上。

### 5.2 注册表

client half 启动时声明自己能桥什么 —— **一整张表**（名字 + 基址 + 标题）：

```json
{"type":"register","role":"bridge","bridgeId":"host-a","apps":[
  {"app":"my-api","base":"http://127.0.0.1:9999","title":"我的服务"},
  {"app":"other-api","base":"http://127.0.0.1:7800"}
]}
```

server 半维护 `bridges: Map<app, {ws, bridgeId}>`。

**同一 app 被两个 client 注册** → 默认**后来者顶替前者**，并记 warning
（同一台机器跑了两份是异常状态；顶替比让请求随机打到其中一个更可预期）。
顶替者断开时，app **归还**给仍连着的旧桥（见 K34）。

**app 名规范**：`^[a-z][a-z0-9-]{0,31}$` —— 它要当**路由标识**用
（路径前缀 / `X-Mn-Ws-App` 头），必须是合法标识符。
**名字本身不携带任何关于被桥服务的信息**：它是路由用的，不是业务描述。

---

## 6. 通道协议（client half ⇄ server half，走 WS）

帧为 JSON 文本。**所有帧都带 `type`；请求类帧带 `id` 用于配对。**

### 6.1 握手

| 方向 | 帧 |
|---|---|
| server → client | `{"type":"welcome","peerId":"peer-1","server":"mn-ws-server","wsPath":"/ws"}` |
| client → server | `{"type":"register","role":"bridge","bridgeId":"host-a","apps":[…],"token":"…"}` |
| server → client | `{"type":"registered","bridgeId":"host-a","apps":["my-api","other-api"],"replaced":["old-api"]}` |
| server → client | `{"type":"error","error":"register_failed","detail":"…"}` |

未注册完成的连接**不接受任何请求帧**（与 mn-rt 的 `registered` 门禁同款）。

### 6.2 请求 / 响应

**server → client（转发起）**

```json
{
  "type": "request",
  "id": "r-000123",
  "app": "my-api",
  "method": "POST",
  "path": "/api/todo/add",
  "query": {"limit": "20"},
  "headers": {"authorization": "Bearer …", "content-type": "application/json"},
  "body": "eyJ0aXRsZSI6…",   // base64；无 body 时为空串
  "ts": 1731300000000
}
```

**client → server（回响应）**

```json
{
  "type": "response",
  "id": "r-000123",
  "status": 200,
  "headers": {"content-type": "application/json", "set-cookie": ["a=1", "b=2"]},
  "body": "eyJva2I6dHJ1ZX0=",
  "ts": 1731300000123
}
```

**client → server（出错）**

```json
{"type":"error","id":"r-000123","code":"ECONNREFUSED","error":"connect ECONNREFUSED 127.0.0.1:7877"}
```

**server → client（取消）**

```json
{"type":"abort","id":"r-000123","reason":"client_disconnected"}
```

### 6.3 保活与关闭

| 帧 | 方向 | 用途 |
|---|---|---|
| `{"type":"ping"}` / `{"type":"pong"}` | 双向 | 应用层心跳（ws 库另有协议级 ping/pong） |
| `{"type":"chunk","id":"…","data":"…"}` | client → server | **预留**：流式响应分块。第一版不实现，但帧位留着 |
| `{"type":"shutdown","reason":"…"}` | server → client | 服务端主动下线，client 应退避重连 |

### 6.4 请求标识与多路复用

一条 WS 连接上同时跑多个 HTTP 请求 —— **必须**按 `id` 配对：

```
server 半：pending.set(id, {res, timer, …}) → 收到 response/error 时按 id 取回并清表
client 半：pendingLocal.set(id, req) → 收到 abort 时销毁对应 req
```

`id` 由 server 半生成（`r-` + 单调计数 + 随机后缀），**全局唯一**（跨连接也要唯一，
因为 server 半的 pending 表是全局的）。

---

## 7. 对外的 HTTP 面

| 路由 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 存活探针（不依赖任何 bridge） |
| `/stats` | GET | `{ok, stats, apps:[…], pending}` |
| **`/api/catalog`** | GET | **元信息目录**：可路由的应用清单（app / 标题 / 端口 / 本地基址 / 所属桥）。**需 L1 凭据** |
| `/clients` | GET | 已注册 bridge 列表（**鉴权后**才返回，见 §8） |
| `/<app>/*` | ANY | 桥接到对应 nx 服务 |
| `/push` | POST | 测试用：不经 WS，直接打某个 app（复用同一路由函数） |

**`/<app>/*` 的处理链**（与 mn-rt 的 `routeMessage` 同一形状）：

```
解析 app（路径前缀 > 请求头）→ 查 bridges 表
  ├─ 无该 app        → 404 {ok:false, error:"unknown_app"}
  ├─ 该 app 离线      → 502 {ok:false, error:"bridge_offline"}
  └─ 找到 → 建 request 帧 → 发 WS → 等 response
       ├─ 超时（默认 30s）→ 504 {ok:false, error:"bridge_timeout"} + 清 pending
       ├─ client 报错    → 502 {ok:false, error:"bridge_error", detail}
       └─ 拿到响应      → 原样回写（状态码 / 头 / body）
```

**回写响应时**：状态码、响应头、响应体**原样**。不做 `{ok,data}` 包装 —— 包装就破坏了 G3。

---

## 8. 鉴权与身份验证

三层，缺一不可：

### L1 —— 通道层：谁可以接入这个桥

- client half 注册时必须带 `token`（go-ah 设备令牌，或 `MN_WS_TOKEN` 静态门禁）
- **远端 HTTP 客户端**用 `X-Mn-Ws-Token` 头携带同一份凭据
- server 半校验；不过 → 401（注册时不过 → `4403` 风格的拒绝，对齐 mn-rt 的 4401/4403 语义）

> ⚠️ **mn-ws server 是新的公网暴露面**，它能代理到本机的所有 nx 服务。
> **只有静态 token 是不够的** —— 那等于把整个 nx 面挂在网上。
> 生产上必须走 go-ah 设备令牌（带 userId），这样能做「按用户隔离」。

> ### ⚠️ L1 与 L3 必须用不同的头（实现时踩到并修正）
>
> 最初设计里 L1 也用 `Authorization: Bearer`，但被代理的服务自己就是读
> `Authorization: Bearer <token>`（很多服务都是这么读的）。
> 两层共用一个头会**互相打架**：
> - 门禁令牌被 nx 当成会话令牌去校验 → nx 401
> - 反过来 nx 的会话令牌被当门禁 → 桥 401
>
> 所以：**L1 走独立的 `X-Mn-Ws-Token`，`Authorization` 整个留给 nx。**
> 而且 `X-Mn-Ws-Token` 属于桥接层内部事务，**必须从转发给 nx 的头里剥掉** ——
> 泄出去等于把门禁令牌交给目标服务。

### L2 —— 路由层：这个请求能去哪个 app

- 请求里的 app 必须在该 bridge 的注册表里
- 从没注册过这个 app → 404 `unknown_app`
- 注册过但桥掉线了 → 502 `bridge_offline`（桥会自动重连）
- **不做**「app 存在就放行」——注册表是 client 自己声明的，不是全局的

### L3 —— 应用层：nx 自己的那套鉴权

- 原始 `Authorization` / `Cookie` **原样透传**给 nx
- nx 的 `auth` 模块照常判定 → 登录态、角色、属主隔离全部原样生效
- 这是「既保证鉴权，又保证体感一致」的关键：**桥接层不重新发明鉴权，它只是把头带过去**

> **L1 与 L3 的关系**：L1 管「谁能用这个桥」，L3 管「这个请求在 nx 眼里是谁」。
> 两者都要有。**只有 L3 没有 L1** = 公网裸奔；**只有 L1 没有 L3** = 一个 token 通吃所有 nx 数据。

### 8.1 两端在认证中心各有各的 client_id

统一登录走 go-ah（auth-hub）。mn-ws 在那里登记了**两个**客户端：

| client_id | 是谁 | 回调白名单 | 干什么 |
|---|---|---|---|
| `mn-ws-client` | **client 半**（本机 CLI） | `http://127.0.0.1:*/callback`、`http://localhost:*/callback` | 真正发起授权码流程 |
| `mn-ws-server` | **server 半**（公网机） | `http://127.0.0.1:7777/auth/callback` | server 半自己的身份 |

**为什么拆成两个，而不像 mn-rt 那样共用一个**：
client_id 是**审计与吊销的单元**（go-ah 自己的种子注释里写的就是这条理由）。
共用一个之后，「哪个平台在发 token」「要停哪条接入」都问不出来。
mn-ws 的两端分处公网与内网，吊销诉求本来就不一样。

**谁用哪个**：
- server 半通过 `GET /auth/oidc/config` 同时发布 `clientId`（自己）与
  `loginClientId`（client 半的）。新装的 client 半因此**不需要额外配置**。
- client 半登录时用 `loginClientId` 发起 authorize 与换 token；
  服务端没发布这个字段时回落 `clientId`（兼容老的 server）。

**当前状态（不要误读）**：
今天只有 `mn-ws-client` 有**走通的授权码流程**。
`mn-ws-server` 是「先占住身份与审计单元」—— server 半只做 `verifyBearer`
（拿 access_token 调认证中心的 userinfo 换身份），userinfo **不校验 client_id**，
所以 server 半并不需要自己的 client 才能工作；它登记的回调地址现在还收不到码。
这与 mn-rt「服务端自己的浏览器回调还没实现」是同一种状态。

---

## 9. 透明性契约（「体感一致」的机器化定义）

同一请求，直连 nx 与走 mn-ws，以下必须**完全相同**：

| 项 | 要求 |
|---|---|
| 状态码 | 逐个相同（含 4xx / 5xx） |
| 响应体 | 逐字节相同 |
| 响应头 | 除 hop-by-hop 外全部相同（`set-cookie` 保留多值） |
| nx 收到的 method / path / query | 相同（`/<app>` 前缀被剥掉） |
| nx 收到的请求头 | 相同（除 §10 的例外） |
| nx 收到的 body | 逐字节相同 |
| nx 侧的鉴权结果 | 相同（同一套 `auth` 模块、同一套登录态） |

**验收方式**：见 §13 的对照测试。

---

## 10. 坑位清单（实现前必读）

> 这一节是本设计最有价值的部分 —— 每一条都是「不处理就会静默出错」。

| # | 坑 | 后果 | 处理 |
|---|---|---|---|
| **K1** | **`Origin` 头透传** | nx-kv 的 `originAllowed()` 只放行 `127.0.0.1` / `localhost` / `::1`。透传浏览器的 Origin → **403 跨站请求被拒绝** | client half **剥离 `Origin`**（或置为 `http://127.0.0.1`）。**这是第一号坑**，会表现为「直连好好的，走桥就 403」 |
| **K2** | **hop-by-hop 头透传** | `Connection` / `Keep-Alive` / `Transfer-Encoding` / `Upgrade` 等不该跨代理 | client half 剔除这批头；`Content-Length` 按实际 body 重算 |
| **K3** | **多值响应头** | `set-cookie` 有多个时，用 `Record<string,string>` 会丢 | 帧里 headers 用 `Record<string, string[]>` |
| **K4** | **请求体编码** | body 是二进制/含非 UTF-8 时 JSON 会坏 | 帧里 body 用 **base64** |
| **K5** | **body 大小上限** | nx-kv 上限 24MB（base64 膨胀 ~33% → 约 32MB 帧） | server 半与 client 半**各自**设上限；超限直接 413，别等对方收 |
| **K6** | **多路复用** | 一条 WS 上并发多个请求，响应串了 | `id` 配对（§6.4） |
| **K7** | **客户端断开** | HTTP 已断，WS 帧还在本机跑 | server 半 `req.on('close')` → 发 `abort` 帧 → client 半 `req.destroy()` |
| **K8** | **请求超时** | 本机端口没人听 → 挂死 | server 半 pending 超时（默认 30s）→ 504 + 清表 |
| **K9** | **client half 断线** | 本机进程重启 / 网络断 → 路由表里的 app 变僵尸 | client half 自动重连 + **重新注册**；server 半在 WS `close` 时把该 bridge 的 app 全部摘掉 |
| **K10** | **同 app 双注册** | 请求随机打到其中一个 | 后来者顶替前者 + warning + 被顶者收到 `registered` 后自行退出 |
| **K11** | **query 编码** | `?a=1&b=2` 拼接时没编码 | path 只带 pathname，query **单独原样透传**（不要自己重新拼） |
| **K12** | **大响应** | nx 返回 20MB → 帧 27MB → 单帧超限 | 协议支持 chunk 分帧（§6.3）；第一版设上限并在超限时明确报错，不要截断 |
| **K13** | **HEAD / 204 / 304** | 这些响应**没有 body**，但帧里 body 字段不能是 `undefined` | 空 body 用空串；client 半写回时按 status 判断是否写 body |
| **K14** | **HTTPS / TLS** | mn-ws server 若裸奔在公网，鉴权头是明文 | 生产前置 nginx + TLS（mn-rt 的 DEPLOY.md 已记此风险） |
| **K15** | **单点登录态过期** | nx 侧 401 | 原样透传给客户端，客户端自己去续期；桥接层不碰 nx 的登录态 |
| **K16** | **审计落盘** | 出事查不到谁调了谁 | 每次请求落 `store.append({app, method, path, status, userId, ts, clientIp})` |
| **K17** | **协议层的头值是数组，Node 的 http 只收字符串** | `options.headers.host property must be of type string. Received an instance of Array` —— 帧发不出去，请求全挂 | 协议层统一存数组（为了保住 set-cookie 多值），**落地前必须压平**：`flattenHeaders(headers, ['set-cookie'])` |
| **K18** | **同名函数声明互相遮蔽** | server 里 `sendJson(res,code,obj)` 与 `sendJson(ws,obj)` 重名，后者覆盖前者 → 所有错误响应**静默不发送**，客户端表现为「请求挂死到超时」 | 两类发送器必须**分开命名**（`sendRes` / `sendWs`） |
| **K19** | **ERROR 帧不能当 RESPONSE 处理** | 错误帧没有 status → `writeHead(0)` 抛错 → 退化成「200 + 空 body」，客户端以为成功了 | ERROR 帧单独走一条路：明确回 502 并带上错误原文 |
| **K20** | **路径第一段被误认成 app** | `/api/todo/list` 的第一段 `api` 全小写、合法字符 → 被当成 app 名，请求路由到不存在的 app | 维护一张**保留路径段**表（api/auth/health/stats/clients/push/ws/files/assets/static），这些段永远不当 app |
| **K21** | **端口号散落各处** | server 默认端口写在 `server/server.js`、`lib/config.js`、CLI 帮助、README、设计文档里 —— 改一处忘三处，文档与实现对不上 | 端口只认 `lib/config.js` 里的 `DEFAULT_SERVER_PORT` / `DEFAULT_WEB_PORT` 两个常量；`server/server.js` 与 `client/web.js` 的兜底值必须与之一致（改端口 = 改这两行 + 文档），并有单测兜住 |
| **K22** | **同机既跑 server 又开面板** | server 默认绑 `0.0.0.0:7777`，面板默认绑 `127.0.0.1:7777` → 后者 EADDRINUSE | 端口预检**明确报错**并提示 `--web-port` 换端口，不静默顺延（顺延 = 两边对不上账）。面板默认端口与 server 相同是有意为之：面板跑在 client 那台机器上，client 连的是远端 server，本机默认不会有 7777 冲突 |
| **K23** | **`idpAvailable` 的语义是「拉到过」，不是「在线」** | `/auth/oidc/config` 报的 `idpAvailable` = 是否**成功拉取过**发现文档。不做启动预热 → 这个字段永远是 false → 部署脚本据此断言「统一登录生效」→ 把一个完全正常的部署判成失败（认证中心明明可达，容器里 wget 也拉得到，就是没人去拉） | 启动时后台预热发现文档（**失败不固化缓存**，带重试：容器可能比认证中心先起来）；部署脚本对 `idpAvailable` 轮询而不是一上来就判死 |
| **K24** | **测试读到了本机的真实配置** | 冒烟测试的子进程继承 `process.env`，配置目录默认是 `~/.mn-ws` —— 那里存着用户的门禁 token。于是「server 无鉴权时拒绝启动」那条用例**真的把 server 起了**，子进程永不退出 → `run()` 永不 resolve → **整个套件挂死**，CI 上表现为任务超时，看不出是哪条用例的问题 | 测试子进程一律带 `MN_WS_HOME=<临时目录>`（配置隔离）；`run()` 加兜底超时（子进程不退出就判那条用例失败，而不是拖死整个套件） |
| **K25** | **一个 client_id 承担两端** | server 半与 client 半共用 `mn-ws` 一个 client_id → 认证中心里**分不清是哪个平台在发 token**，也无法只吊销一端 | 拆成 `mn-ws-server`（server 半的身份）与 `mn-ws-client`（client 半发起授权码流程）；server 半通过 `/auth/oidc/config` 的 `loginClientId` 字段把后者告诉 client，新装的 client 零配置 |
| **K26** | **认证中心没登记这个 client** | `auth login` 在 authorize 端点被拒：`400 invalid client_id`。表现为「登录点开就报错」，但本地看不出是「没登记」—— 因为它长得像「redirect_uri 不在白名单」 | 登记走 go-ah 的管理 API `POST /api/admin/clients`（公共客户端 + PKCE + 回环通配）；**注意它不是种子**（`template-web-client`/`oidc-cli`/`fr-app`/`mn-rt` 才是），所以重建库时不会自动带上，要重新登记 |
| **K27** | **把 `--no-X` 当成取反开关** | `parseArgs` 里写了「`--no-` 前缀 = 取反」的分支 → `--no-open` 被解析成 `open=false`；而读它的地方是 `cfg.noOpen` → **永远是 undefined**。于是 `auth login --no-open` 照样弹浏览器、干等 5 分钟超时 —— 这个开关等于没有，只在「无桌面环境 / SSH 过去登录」这条路上暴露 | `--no-X` 是**一个名叫 noX 的正向开关**（与 mn-rt 的 parseArgs 一致）；`--no-open` 的语义另有第二处坑见 K28 |
| **K28** | **半途而废的登录把空账号写进配置** | `--no-open` 模式下 `authLogin` 只返回 `{authorizeUrl, pending:true}` —— 没有令牌也没有身份。若调用方不看 `pending` 就继续走保存流程，会存进一条 `deviceToken=undefined` 的账号、**顶替当前账号**，并打印「✓ 登录成功」。之后 client 注册拿空令牌去连被拒，而提示却说「登录成功过」 | 调用方在保存账号**之前**检查 `res.pending` 并如实说「已打印授权地址，未继续登录」；文案也要跟着改对（`--no-open` 不会弹浏览器、也不等回调，文案不能还说「在弹出的浏览器里」「等待授权回调」） |
| **K29** | **`String(pick(...))` 把 undefined 变成字符串 "undefined"** | `pick` 全空时返回 `undefined`，而 `String(undefined)` 是字符串 **"undefined"** —— 不是空串！于是 `if (!cfg.serverHttp)` 这类判空全部失效（"undefined" 是真值）。**在 server 侧这是安全项**：`token` 变成 "undefined" 后，`config.token && gate === config.token` 等于「任何人都能用 `X-Mn-Ws-Token: undefined` 通过门禁」 | 缺省必须是空串：统一走 `str()` 辅助函数（`v == null ? '' : String(v)`），不要直接 `String(pick(...))`。这个坑由 client 侧的单测抓出来 —— 表现是「配置里写着 undefined、clientId 永远生成不出来、配置文件从不落盘」 |
| **K30** | **keep-alive 连接让 `httpServer.close()` 永不返回** | Node 19+ 的全局 agent 默认 keepAlive，而 `httpServer.close()` 会**等这些空闲连接自己结束**才回调 → shutdown 永远不返回。生产上表现为 SIGTERM 后容器不退出，只能等编排强杀；测试里表现为「整套测试挂死」 | close 时显式 `httpServer.closeAllConnections()`（pending 请求已经回了 503，断连接是安全的） |
| **K31** | **块注释里出现 `*/` 提前闭合注释** | 端口通配的形态是「星号紧跟斜杠」，写在**块注释里**会把注释提前闭合 —— 文件后半截被当成代码，报一堆莫名其妙的语法错（TS1434/TS1443…），而报错位置离真正的祸首十万八千里 | 注释里不写字面量，改写成「任意端口」；mn-rt 的代码里同样踩过这个坑并留了警告 |
| **K32** | **「是不是自定义」与「标题是什么」共用一个 Map** | `resolveApps` 里用一个 Map 同时记「这是自定义应用」和「它的标题」。于是**没填标题的自定义应用查不到 → 被当成「不在表里」→ 基址算不出来 → 整个应用被丢掉**。症状是「界面上明明加了，桥过去却 404 unknown_app」 | 拆成两个结构：`Set` 记「是不是自定义」、`Map` 记「标题」。凡是一个 Map 同时承担两种语义，都要停下来想想 |
| **K33** | **server 半不替 client 半猜标题** | 应用标题只有 client 半知道（用户自己起的名）。server 若按自己的表回落，远端目录里显示的就是裸的应用名 | `describeApp(app, base, title?)` 接受客户端自报的标题：给了就用它的，不给就用**应用名**兜底（没有任何表可回落）。注册帧的 `apps[]` 带上 `title` |
| **K34** | **顶替者断开后，app 不会回到还活着的旧桥** | 「一个 app 同时只有一个桥，后来者顶替前者」是对的，但**顶替时旧桥那条路由被删掉后没有回收**：新桥一旦先断开，服务端只把新桥的 app 摘干净，旧桥明明**还连着**却接不到任何请求 —— 这个 app 就成了「注册过但没人能路由」，调用方永远拿到 502。实测踩过：用静态门禁的桥连上来顶掉用户桥，门禁桥一断，用户桥的 app 全部哑掉（`/health` 里 `bridges: 0`，而客户端的 TCP 连接明明是 Established） | 每条连接记下自己**注册过**的 app 表（`meta.appList`）；顶替者断开时把「现在没有主人」的 app 归还给仍连着、且注册过同名 app 的旧桥。后来者仍然优先（app 有主人就不动） |
| **K35** | **把某个服务族的名字与端口写进发行包** | 发行包里内置了一张「本机可能有什么」的应用表（名字 → 默认端口 → 标题）。于是：① 桥背上别人的业务知识 —— 那个族一改版，桥就得跟着改；② 想桥一个不在表里的服务，只能走「动态注册」这条补丁路径；③ 表里的服务**换端口**就得改代码 | 发行包里**不留任何具体服务的知识**。桥只认「名字 + 基址 + 标题」这一层抽象，登记表完全由使用者填（`--apps name=base` / 面板动态登记）。server 半从注册帧里学到它们，自己不查任何表 |
| **K36** | **业务令牌该在客户端换还是在服务端换** | 先做成了「客户端拿授权码去认证中心换 access_token，再拿它来换本服务令牌」—— 换码在客户端。后果是：**认证中心那张 access_token 流经了客户端**。它指向的是整个平台的身份，截获即等于账号接管；而客户端与服务端之间的那一跳还是明文 | 换码放**服务端**：`POST /auth/oidc/callback` 收 code + verifier，服务端拿 **client 半的身份**（`mn-ws-client`）去认证中心换，再签一枚本服务自己的令牌。认证中心那张票一次都不出服务端。业务令牌因此天然归属业务方 —— 与 mn-rt 的 `/auth/oidc/callback` 完全同构 |
| **K37** | **半开的 TCP 连接不会被发现** | 容器被 `docker rm` 掉时，对端不一定发来 FIN/RST（跨境链路 + 运营商 NAT 下 RST 会丢）。于是客户端以为「还连着」，实际上一帧也发不出去：面板显示已连接，所有请求却 502，而且**永远不会自己恢复**（server 那边也一样：死桥的 app 一直挂在路由表里） | 两端都定期 ping 对方（协议级 ping/pong）：客户端收不到 pong 就 `terminate`，让 close 事件触发重连；服务端收不到 pong 就踢掉那条连接，路由表不留僵尸 |
| **K38** | **心跳的「复位」代码不在，心跳就变成「杀连接器」** | isAlive 配方的两半：`isAlive = true`（连接时）+ `pong` 事件里复位。少了后半句，心跳每轮把标记压成 false 之后**没人复位** → 下一轮直接 terminate。症状是桥**每 30 秒被踢一次**、重连、再被踢，看着像「刚连上就断」。而别的测试全绿 —— 连接死之前它们早跑完了 | 这两行**不能少**，且要在旁边写明为什么。回归测试的做法：把心跳间隔做成可配置（`heartbeatIntervalMs`，默认 15s），测试传 60ms 让连接连过 5 轮心跳再断言它还活着 —— 这样既跑得快，又真的能抓住这个错 |
| **K39** | **ESM 包里的 CommonJS 脚本** | client 包的 package.json 写着 `"type": "module"`，于是 `tests/e2e-remote.js`（用 require 写的）被当 ESM 加载 → `require is not defined`。`pnpm test:e2e` 从 monorepo 改造那天起就没能跑过，一直没人发现 | CommonJS 脚本一律用 `.cjs` 后缀，并同步改 package.json 里的脚本路径。**验收脚本跑不起来，等于没有验收** |
| **K40** | **「一个 app 名只有一个桥」是路由的规矩，不是展示的规矩** | 路由表 `bridges: Map<app, Bridge>` 同时兼任了展示表。于是 PC-B 注册了 PC-A 也有的 app 时，PC-A 那条被删掉 —— **PC-A 整台机器就从目录里消失了**。用户看到的目录从「我有几台电脑、各跑什么」退化成「一长串应用，且看不出是谁的」 | 拆成两张表：`pcs: Map<bridgeId, PcEntry>`（展示，**每台 PC 一条、互不顶替**）与 `bridges: Map<app, Bridge>`（路由，撞名时后来者接管）。目录按 PC 分组返回（`pcs[]`），扁平的 `apps[]` 保留 —— 老客户端只认后者，不能把已有客户端打碎 |

---

## 11. 文件结构

照 mn-rt 的形态（`server/` + `client/` 两半，纯 Node，无构建步骤）。
**下面是实际落地的文件树**（v0.1.0）：

```
mn-ws/
├── README.md
├── package.json                 # bin: { "mn-ws": "./bin/index.js" } → npx mn-ws
├── bin/index.js                 # CLI 入口：server / client / client web / auth / doctor
├── lib/                         # 两半共享
│   ├── protocol.js              # 帧编解码 + 头规范化/压平/剥离
│   ├── apps.js                  # app 表 + 端口探测 + app 名解析（路径前缀 > 请求头）
│   ├── config.js                # 配置合并 + 账号表（与 mn-rt 同款）
│   ├── auth.js                  # 客户端侧 PKCE 登录（authLogin）
│   ├── logger.js
│   ├── store.js                 # 审计落盘
│   └── index.js
├── server/
│   ├── server.js                # HTTP + WS 共存；bridges/pending/knownApps 表；三层鉴权
│   └── auth.js                  # 设备令牌签发/校验（HS256）+ 设备登记
├── client/
│   ├── ws-client.js             # 连 server + 指数退避重连 + 重注册
│   ├── bridge-client.js         # 帧 → HTTP 请求还原（本项目核心）
│   └── web.js                   # 本地面板：可桥接清单 + 状态 + API 试验台
├── test/
│   ├── unit.js                  # 协议 + 端到端透传（25 例）
│   └── smoke-cli.js             # 真实起两个进程打穿（9 例）
└── docs/design.md
```

**为什么不用 nx 系列的 server-cli-web 骨架？**
nx 骨架的价值在「CLI 与 HTTP 同源、一条 action 声明两端」。mn-ws 没有 CLI 命令面，
它的 CLI 只有 `server` / `client` / `auth` / `doctor` 几条 —— 直接照 mn-rt 的形态更省事，也更同构。

**但路由表可以借鉴**：nx 的 `registry.js → ACTIONS → compileRoute` 让「哪些路径存在」
成为**可枚举**的。mn-ws 的 client half 可以在注册时把本机 app 的路由清单一并报给 server，
让 server 半能对未知路径**提前 404**，而不是白跑一趟 loopback。这是可选优化，第一版不做。

---

## 12. 落地步骤

| 阶段 | 内容 | 产出 | 验收 |
|---|---|---|---|
| **S0** | 协议定稿 | 本文档 + 帧格式表 | 审核通过 |
| **S1** | 通道层（不碰 HTTP 面） | `bridge.js` 帧编解码 + `client/lib/bridge-client.js` 帧→HTTP 还原 | 单测：帧编解码往返、pending 配对、abort、超时 |
| **S2** | server 半的 HTTP 面 | `/health` `/stats` `/<app>/*` | e2e：起假 nx，curl 打 mn-ws，断言透传正确 |
| **S3** | 鉴权 | L1 令牌 + L2 app 归属 + L3 透传 | 未带令牌 401；未知 app 404；带正确令牌但 nx 侧未登录 → 透传 nx 的 401 |
| **S4** | 本机 client half 落地 | systemd / pm2 常驻 + 自动重连 | 拔网线再插上，app 路由自动恢复 |
| **S5** | 对照测试 | 直连 vs 走桥的差异断言 | 见 §13 |
| **S6** | 部署 | server 侧 GHCR + CI（照 mn-rt 的 deploy.yml）；client 侧本机常驻 | `curl /health` 通过；真实业务请求成功 |

---

## 13. 验证策略

### 13.1 单元测试（协议层）

- 帧编解码往返：request/response/error/abort/ping 各一份
- pending 表：并发 10 个请求 → 响应按 id 正确归位
- 超时：client 不回 → 504 且 pending 清空
- abort：HTTP 客户端断开 → 收到 abort 帧 → 本机 req 被销毁（用假 server 断言 socket 被关）

### 13.2 端到端（假 nx）

起一个假 nx（`http.createServer`），断言它**收到的**：

```
method / path / query / headers / body 与原始请求一致
```

再断言 mn-ws 回给客户端的响应与假 nx 的响应**逐字节一致**。

### 13.3 对照测试（G3 的机器化验收）★

```
同一请求：
  A) curl http://127.0.0.1:7877/api/todo/list
  B) curl http://mn-ws-host/my-api/api/todo/list
断言：状态码相同 ∧ 响应体逐字节相同 ∧ 目标服务侧收到的请求头相同（除 §10 例外）
```

**这是「体感一致」唯一的可靠验收方式**，必须写成自动化测试，不能靠人眼看。

### 13.4 真机验收

对**每一个**要接入的服务跑一遍 §13.3 —— 尤其是带同源校验或大 body 上限的那些
与网关类服务（桥接它需要额外小心）。

---

## 14. 待确认的决策点

> **v0.1.0 落地时的取舍**（已在代码里体现，审核时按这个看）：

| # | 问题 | 取舍 | 状态 |
|---|---|---|---|
| Q1 | 独立仓库还是并进 mn-rt | **独立仓库** `D:\code\a_js\proj\mn-ws` | 已定 |
| Q2 | server 部署在哪 | 与 mn-rt 同机 `1.94.101.189`，端口 **7777** | 待部署 |
| Q3 | client 半怎么常驻 | 本机 **systemd**（Windows 侧先手工/计划任务） | 待部署 |
| Q4 | 仓库落点 | `D:\code\a_js\proj\mn-ws`（纯 Node，与 nx 同栈同机） | 已定 |
| Q5 | 应用标识形态 | **路径前缀优先 + `X-Mn-Ws-App` 兜底**；冲突报错不猜 | 已定 |
| Q6 | 客户端是谁 | 先做**通用**（任何 HTTP 客户端可用） | 已定 |
| Q7 | L1 门禁用什么 | 设备令牌（生产）/ 静态门禁（自测）；**L1 走 `X-Mn-Ws-Token`，不占 `Authorization`** | 已定 |
| Q8 | go-ah 侧改动 | 需新增 `mn-ws` 预置客户端（现有 5 个之外） | **待办** |

### 还需你拍板的

| # | 问题 | 我的建议 |
|---|---|---|
| **A** | **go-ah 要不要加 `mn-ws` 预置客户端** | 要。不加就只能用静态门禁（共享密钥、无用户隔离）。加一个 client 是一行配置 + 一次发版 |
| **B** | **是否发布到 npm**（`npm publish`，让 `npx mn-ws` 真正可用） | 要。现在 `npx mn-ws` 只能在本地目录跑（`npm link` 或 `node bin/index.js`） |
| **C** | **是否给 server 加 TLS** | 公网暴露的桥必须 TLS。mn-rt 的 DEPLOY.md 已记此风险（8790 裸奔），mn-ws 别再犯一次 —— 至少前置 nginx |
| **D** | **断流/超时策略** | 现在固定 30s（`MN_WS_REQUEST_TIMEOUT`）。nx 里有慢接口（crawl / watch）时可能要调大，或者让「流式」走 chunk 帧（协议已留位） |

---

## 附录 A：帧格式速查

```
client → server
  register   {type, role:"bridge", bridgeId, apps:[{app,base}], token}
  response   {type, id, status, headers:{k:[v]}, body(base64), ts}
  error      {type, id, code, error}
  chunk      {type, id, data(base64)}          ← 预留，第一版不实现
  pong       {type}

server → client
  welcome    {type, peerId, server, wsPath}
  registered {type, bridgeId, apps:[], replaced:[]}
  request    {type, id, app, method, path, query:{}, headers:{}, body(base64), ts}
  abort      {type, id, reason}
  error      {type, error, detail}
  ping       {type}
  shutdown   {type, reason}
```

## 附录 B：应用登记表怎么填

> **本项目不再内置任何服务表**（见 K35）。下表是**填法示例**，不是内置数据 ——
> 发行包里没有这张表，client half 也没有「已知服务」这层概念。

| 字段 | 含义 | 例 |
|---|---|---|
| `name` | 路由标识（小写字母开头，只含小写字母/数字/连字符） | `my-api` |
| `base` | 本地基址（端口是它的一部分，不是另填的一张表） | `http://127.0.0.1:9999` |
| `title` | 显示名（远端目录里给人看）；不给就用 name | `我的服务` |

填法（两种等价）：

```bash
mn-ws apps set --apps my-api=http://127.0.0.1:9999,other-api=http://127.0.0.1:7800
mn-ws apps add my-api --port 9999 --title '我的服务'
```

> 端口变了就改 base —— 桥不猜端口，也不替使用者决定「哪个服务跑在哪个端口」。

