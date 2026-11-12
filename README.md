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
        │  mn-ws server（公网机）  :7777           │
        │   HTTP 面：/health /stats /clients      │
        │            /<app>/*  ← 桥接入口          │
        │   WS  面：/ws（与 HTTP 同端口共存）      │
        └────────────┬───────────────────────────┘
                     │ WebSocket（出向连接，穿 NAT）
                     ▼
        ┌────────────────────────────────────────┐
        │  mn-ws client（本机，跑在 nx 那台机器） │
        │   收到帧 → 还原 HTTP → 打 127.0.0.1:端口 │
        └────────────┬───────────────────────────┘
                     ▼ HTTP (loopback)
              nx-kv / nx-rh / …
```

---

## 快速上手

```bash
# ── 公网机：起中继服务（必须有鉴权，否则拒绝启动）──
npx mn-ws server --host 0.0.0.0 --port 7777 --token <门禁TOKEN>

# ── 本机：起转发，把要桥的应用列成白名单 ──
npx mn-ws client --url ws://<服务器>:7777/ws --token <门禁TOKEN> \
                 --apps nx-kv,nx-rh

# ── 远端客户端：直接当普通 HTTP 服务用 ──
curl -H 'X-Mn-Ws-Token: <门禁TOKEN>' \
     'http://<服务器>:7777/nx-kv/api/todo/list'
```

**本地开发**（还没发布到 npm 时）：

```bash
cd mn-ws && npm install
node bin/index.js server --port 7777 --token dev
node bin/index.js client --url ws://127.0.0.1:7777/ws --token dev --apps nx-kv
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `mn-ws server` | 启动中继服务（公网半）：HTTP 与 WS 同端口共存 |
| `mn-ws client` | 启动本机转发：连上 server 并注册可桥接的应用 |
| `mn-ws client web` | 本地 Web 面板（只监听 127.0.0.1）：可桥接清单 + 状态 + API 试验台 |
| `mn-ws client apps` | 列出可桥接的应用（白名单 + 本地端口存活探测） |
| `mn-ws client catalog` | 拉取远端的元信息目录（登录后看哪些能路由） |
| `mn-ws client status` | 查看桥接连接状态 |
| `mn-ws auth login` | 统一登录（go-ah auth-hub），与 mn-rt 的 `auth login` 同款流程 |
| `mn-ws auth list\|switch` | 查看 / 切换本机已存账号 |
| `mn-ws auth status\|logout` | 查看 / 清除登录凭据 |
| `mn-ws doctor` | 环境自检：端口占用 / 鉴权 / 应用可达性 / server 连通性 |

常用选项：

```
--url <ws://...>        server 半地址
--server-http <url>     统一登录用的 HTTP 基址（默认从 --url 推导）
--host <h>              监听地址（server 默认 0.0.0.0；本地面板固定 127.0.0.1）
--port <n>              server 端口（默认 7777）
--web-port <n>          本地面板端口（默认 7777）
--token <TOKEN>         注册门禁（server 与 client 配同一个）
--apps <a,b,c>          只桥接这些应用（白名单；不给就一个都不桥）
--ports <p,q>           只桥接这些本地端口（从已知表反查应用名）
--app-map <a=url,...>   指定应用的本地基址（如 nx-kv=http://127.0.0.1:7999）
--idp-client-id <id>    server 半在认证中心的身份（默认 mn-ws-server）
--login-client-id <id>  client 半在认证中心的身份（默认 mn-ws-client）
--device-name <名>      桥的显示名
--no-open               auth login 只打印授权地址、不弹浏览器
--insecure              server 允许无鉴权启动（**仅限本机自测**）
--log-level <level>     debug | info | warn | error
```

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

命令行等价物：`npx mn-ws client catalog --url ws://<服务器>:7777/ws --token <TOKEN>`

② 按目录里选中的应用发起请求 —— **路径前缀**与**请求头**两种写法等价：

```bash
# 路径前缀
curl -H 'X-Mn-Ws-Token: $TOKEN' 'http://<服务器>:7777/nx-kv/api/todo/list'

# 请求头（路径原样，适合已有客户端不想改 URL）
curl -H 'X-Mn-Ws-Token: $TOKEN' -H 'X-Nx-App: nx-kv' \
     'http://<服务器>:7777/api/todo/list'
```

两者冲突 → `400 app_conflict`（**不猜**：猜错等于把请求打到别的服务上）。

### 多路复用

每条 client half 的 WS 连接是一个独立的「桥」。server 半维护 `app → ws` 的路由表，
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
- 两者冲突 → `400 app_conflict`（**不猜**：猜错等于把请求打到别的服务上）
- 都缺 → `400 app_required`

### 哪些可以桥接

**白名单说了算**：只有 `--apps` / `--app-map` 里列出的应用才会被桥。
端口探测（`mn-ws client apps`）**只用来显示状态，不会自动开桥** —— 扫到端口在监听就自动开桥，等于把整台机器暴露出去。

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

**两层凭据必须分开** —— `Authorization` 是 nx 的地盘（nx-kv 就是读 `Authorization: Bearer`），
L1 走独立头 `X-Mn-Ws-Token`，否则两边令牌互相打架 → 401。

`X-Mn-Ws-Token` 是桥接层内部事务，**不会**被透传给目标服务。

### 设备令牌 vs 静态门禁

| | 设备令牌（统一登录） | 静态门禁 `--token` |
|---|---|---|
| 隔离 | 按用户 —— 只能访问自己名下的桥 | 共享密钥 —— 等价全量访问 |
| 吊销 | 可单独吊销 | 换密钥才算换 |
| 建议 | **生产用这个** | 仅自测 / 单人使用 |

### 两端各有各的 client_id

统一登录走 go-ah（auth-hub）。mn-ws 在那里登记了**两个**客户端：

| client_id | 是谁 | 回调白名单 | 干什么 |
|---|---|---|---|
| `mn-ws-client` | **client 半**（本机 CLI） | `http://127.0.0.1:*/callback`、`http://localhost:*/callback` | 真正发起授权码流程：CLI 在本机回环随机端口收码，自己做 PKCE 换 token |
| `mn-ws-server` | **server 半**（公网机） | `http://127.0.0.1:7777/auth/callback` | server 半自己的身份（审计与吊销按端分开） |

**为什么拆**：client_id 是**审计与吊销的单元**。共用一个之后，「哪个平台在发 token」
「要停哪条接入」都问不出来（go-ah 自己的种子注释里写的就是这条理由）。

server 半通过 `GET /auth/oidc/config` 把 `loginClientId` 一并发布出来，
所以新装的 client 半**不需要额外配置**就知道该用哪个 client_id 去登录。

> `mn-ws-server` 目前**还没有走通的授权码流程** —— server 半只做
> `verifyBearer`（拿 access_token 调认证中心的 userinfo 换身份），
> 不发起授权码流程，所以它登记的回调地址现在还收不到码。
> 这与 mn-rt「服务端自己的浏览器回调还没实现」是同一种状态：
> 先占住身份与审计单元，等真要用时再把那条路走通。

---

## 安全

- **server 无鉴权直接拒绝启动**（`--insecure` 才放行，且会打醒目警告）
- **无鉴权时不允许绑 0.0.0.0**
- **端口占用预检**：被占就明确报错退出，**不静默顺延**（顺延会让客户端连错端口，两边对不上账）
- **本地面板只绑 127.0.0.1**
- **每次经桥的请求落审计**（`~/.mn-ws/data/requests.jsonl`）
- **跨站防护不被绕过**：Origin 头在桥接时被剥离 —— 桥接请求本来就来自本机，
  剥掉是恢复真实语义（不剥的话 nx-kv 的 `originAllowed()` 会 403）

---

## 开发

```bash
npm install
node test/unit.js       # 协议 + 端到端透传 + 多路复用 + 元信息目录 + 默认端口 + 两端身份（40 例）
node test/smoke-cli.js  # 真实起两个进程打穿（11 例）
```

远端验收（打**已部署**的公网 server 半，验「部署完到底能不能用」）：

```bash
# Windows PowerShell
$env:MN_WS_E2E_URL = 'http://1.94.101.189:7777'
$env:MN_WS_E2E_TOKEN = '<门禁 token>'
$env:MN_WS_E2E_APP = 'nx-kv'
node test/e2e-remote.js
```

设计文档：[docs/design.md](docs/design.md) · 部署手册：[docs/DEPLOY.md](docs/DEPLOY.md)

---

## 部署（server 半）

```bash
# 本地构建镜像
docker build -f Dockerfile -t mn-ws-server .

# 起服务（没有鉴权会被拒绝启动）
docker run -d --name mn_ws_server -p 7777:7777 \
  -e MN_WS_TOKEN=<门禁> -e MN_WS_JWT_SECRET=<随机> \
  -e MN_WS_AUTH_ENABLED=1 -e MN_WS_ISSUER=http://47.110.80.47:8082 \
  -v mn_ws_data:/app/data mn-ws-server:latest
```

线上部署走 GitHub Actions（`.github/workflows/deploy.yml`）：
push 到 `main` → 构建 → `docker save` + gzip → scp → 服务器 `docker load` → 重启 → 验活。
**镜像不走 GHCR** —— 服务器 pull 实测太慢，改成镜像直传，部署时间可控。

发版走附注 tag（`.github/workflows/release.yml`）：

```bash
git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0
# → 校验 tag 与 package.json 版本一致 → 跑测试 → npm publish → 建 GitHub Release
```
