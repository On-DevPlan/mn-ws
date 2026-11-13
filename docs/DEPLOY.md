# mn-ws-server 部署手册

GitHub Actions 自动部署（`.github/workflows/deploy.yml`）：
装依赖 → `pnpm -r build`（两个包）→ `docker build` → `docker save` → gzip →
scp → 服务器 `docker load` → 重启容器 → `/health` 健康检查 →
断言统一登录开关与部署意图一致 + 两端 client_id 正确。

**镜像不走 GHCR**：服务器 pull ghcr.io 实测很慢（跨境 + GHCR 同步怪现象），
一次部署的等待时间比传输本身还长。改成镜像直接传 —— 代价是每次部署都传一遍
（gzip 后 ~40MB），换来的是**部署时间可控**。

> ⚠️ 镜像里的 `dist/` 是**宿主机构建好的产物**（CI 先跑 `pnpm -r build`）。
> server 半是 monorepo 的一个 workspace，单独在镜像里装依赖会拖进整个
> workspace（client 的 react 等），所以构建与依赖安装分开。

---

## 服务器档案

| 项 | 值 |
|---|---|
| 主机 | 1.94.101.189（华为云 `hcss-ecs-b2e2`，Ubuntu 24.04 / kernel 6.8，root@22） |
| 资源 | 2C / 1.7Gi 内存（**长期紧张**）/ Docker 29.1.3 |
| 端口 | **7777**（mn-ws 默认；与同机 mn-rt 的 8790 不冲突） |
| 同机已有 | `remotetype_server`（mn-rt，8790）、`dataweb-web-1` / `dataweb-api-1`（80）、`guardian_radar_api`（41901）、`napcat`（已 Exited） |
| 本机 SSH | `ssh root@1.94.101.189` |

> 7777 在部署前已确认空闲（`ss -ltnp` 只有 8790 在听）。

---

## Secrets 配置（一次性）

仓库属主 **On-DevPlan**，本机 gh 默认认证账号有 `admin:org` 权限，直接写入即可：

```bash
# SSH 部署凭据
gh secret set HOST -b "1.94.101.189"
gh secret set USERNAME -b "root"
gh secret set PORT -b "22"
gh secret set SSH_KEY < <私钥文件>

# ── 鉴权（server 无鉴权拒绝启动，这两项至少给一个）──
# 静态门禁：client 半注册时用 --token 带上
gh secret set MN_WS_TOKEN -b "<随机串>"
# 统一登录（推荐）：签设备令牌，按用户隔离
gh secret set MN_WS_JWT_SECRET -b "$(openssl rand -hex 32)"
gh secret set MN_WS_AUTH_ENABLED -b "1"        # 认 1/true/yes/on
gh secret set MN_WS_ISSUER -b "http://47.110.80.47:8082"
# 两端在认证中心各有各的 client_id（审计与吊销按端分开）
gh secret set MN_WS_IDP_CLIENT_ID -b "mn-ws-server"     # server 半的身份
gh secret set MN_WS_LOGIN_CLIENT_ID -b "mn-ws-client"   # client 半的身份
```

> **这两个 client_id 必须先在认证中心登记过**，否则 `auth login` 会在
> authorize 端点被拒（`invalid client_id`）。
> 登记走 go-ah 的管理 API（`POST /api/admin/clients`，管理员会话），
> 形状与 `mn-rt` 一致：公共客户端 + PKCE + 回环通配回调。
> ⚠️ **只登记 DB 的话，重建库时不会自动带上** —— 与 go-ah 种子里的
> `template-web-client` / `oidc-cli` / `fr-app` / `mn-rt` 不同，
> 那几个是写死在 `auth-hub/internal/db/db.go` 的种子里的。
> 要长期可靠就把这两个也加进种子。



> **Windows 上用 PowerShell 设多行 secret（私钥）必须避开管道**：
> `$content | gh secret set SSH_KEY` 会把私钥里的 `\n` 改写成 `\r\n`，
> 私钥解析失败 → 流水线报 `ssh: handshake failed: unable to authenticate`。
> 用 `Start-Process` 把文件直接接成 stdin，原始字节进：
> ```powershell
> Start-Process -FilePath (Get-Command gh).Source `
>   -ArgumentList @('secret','set','SSH_KEY','--repo','On-DevPlan/mn-ws') `
>   -RedirectStandardInput 'key_lf.txt' -NoNewWindow -Wait
> ```
> 另外 OpenSSH 私钥要求 LF 换行、文件权限收紧（Windows OpenSSH 会拒绝
> 权限过松的私钥）。


> **`MN_WS_AUTH_ENABLED` 开了却不配 `MN_WS_JWT_SECRET` → 容器拒绝启动**（不是降级运行）。
> 签不出设备令牌 = 统一登录等于没开。

> **`MN_WS_JWT_SECRET` 一旦有设备登录过就别随手换**：设备令牌是它签的 HS256，
> 换了等于所有已登记客户端下次连接直接 401，必须全体重新 `auth login`。

> **部署后 CI 自己验一遍**（`Pull image and restart` 步骤末尾）：拉
> `GET /auth/oidc/config`，断言 `enabled` 与本次传入的意图一致，开启时还要
> `idpAvailable=true`。这步不是装饰 —— 「配了 1 却被当成关闭」会让服务照常起、
> `/health` 照样绿，而整套按用户隔离的属主判据**静默不存在**。
> 开关有没有真生效只能问运行中的进程。`idpAvailable` 尤其必须在服务端侧验：
> 浏览器打得开认证中心不代表容器出得去。

---

## 运行时约定

| 项 | 值 |
|---|---|
| 容器 / 镜像 | `mn_ws_server` / `mn-ws-server:latest`（**服务器本地镜像**，不入任何公共仓库） |
| 端口 | 宿主 7777 → 容器 7777 |
| 数据卷 | `mn_ws_data:/app/data`（审计 `requests.jsonl` + `mn-ws-server.log`） |
| 内存上限 | `--memory 256m`（宿主机紧张，防灌包拖垮整机） |
| 健康检查 | `GET /health` |
| 统一登录开关 | `GET /auth/oidc/config`（`enabled` / `idpAvailable`，响应永不含 secret） |
| 镜像 tag | 每次部署打 `:latest` 和 `:${github.sha}` 两个 tag 一起 save/load（后者用于回滚） |

> 审计落盘在 `mn_ws_data` 卷里，**删这个卷 = 审计历史清零**。
> 设备登记（属主绑定）也在同一卷内，删卷后所有客户端需要重新 `auth login`。

---

## 触发与回滚

- **自动**：push 到 `main` 且改动 `server/**`、`client/**`、`package.json`、
  `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`Dockerfile` 或 workflow 本身
- **手动**：Actions → Deploy → Run workflow（选分支/commit 即可回滚旧 SHA）
- **服务器上手动**：`docker logs -f mn_ws_server`、`docker ps`

---

## npm 发版

发版走**附注 tag**，与 deploy.yml 无关：

```bash
git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
```

`.github/workflows/release.yml` 会：校验 tag 与两个包的版本一致 → 装依赖 → 构建 →
跑测试 → **先发 `mn-ws-server` 再发 `mn-ws`** → 建 GitHub Release。

> **发布顺序不能反**：client 包的依赖里有 `mn-ws-server`，
> 先发 client 会装到一个还不存在的版本。

> **tag 必须与版本一致**，否则流水线当场失败。
> npm 上同一个版本号永远只能发一次，重发报 `E403 cannot publish over` ——
> 版本号跳了只能跳着补。

---

## 已验证（2026-11-12）

| 项 | 结果 |
|---|---|
| 容器 | `mn_ws_server` up，`0.0.0.0:7777->7777/tcp`，镜像 `mn-ws-server:latest` |
| `/health` | `{"ok":true,"service":"mn-ws-server","authEnabled":true}` |
| `/auth/oidc/config` | `clientId=mn-ws-server` + `loginClientId=mn-ws-client` + `enabled=true` + `idpAvailable=true` |
| 公网端到端 | 远端 HTTP 客户端 → 公网 server → WS → 本机被桥服务，**200 pong** |
| 路由两种写法 | 路径前缀 `/my-api/api/ping` 与请求头 `X-Mn-Ws-App: my-api` + `/api/ping` 结果一致 |
| L1 拦截 | 无 `X-Mn-Ws-Token` → 401；未知应用 → 404 `unknown_app` |
| L3 透传 | 业务 action 被 **被桥服务自己的鉴权**拦下（`未登录或登录已过期`），说明桥没改写凭据 |
| 面板门禁 | `/` 200、`/api/auth/status` 200（豁免）、`/api/bridge/status` **401 not_logged_in** |
| 业务令牌端点 | `POST /auth/oidc/callback` 用 code + verifier 换到本服务令牌；认证中心的 access_token / refresh_token **不出服务端** |

> 「被被桥服务自己的鉴权拦下」在这里是**好结果**：它证明请求完整穿过了
> server → WS → client 半 → 目标服务，而拦它的是目标服务那层（L3），不是桥。

---

## 已知风险

- **内存**：宿机 available 常年紧张。容器冷启动可用；若频繁 OOM 重启，
  优先清理 `napcat` 或加 swap，而不是调大 `--memory`。
- **镜像传输**：每次部署都传一遍 gzip 后的镜像包（~59MB）。走的是
  runner → 服务器的跨境 scp，**上传时间与包大小成正比**。
  相比 GHCR pull 的好处是时间可控（不会卡在 registry 同步怪象上）；
  代价是没有镜像缓存层，服务器每次都要重新 load。
  包在服务器上 `docker load` 完立刻 `rm`，不留垃圾。
- **公网裸奔（已接受的风险）**：7777 对公网开放，WS 无 TLS。
  - **2026-11-13 决定：维持现状，不前置 nginx + TLS。** 这是**明确接受**的
    风险，不是待办 —— 记在这里是为了以后回看时知道它是拍过的板。
  - **现在的暴露面**：明文那一跳带的是 **mn-ws 的业务令牌**（L1 凭据，
    `X-Mn-Ws-Token`）。截获它 = 账号接管（它就是访问桥的钥匙）。
    ⚠️ 早期版本里这一跳带的是**认证中心的 access_token**，那个更致命 ——
    它指向整个平台身份。0.4.0 起换码搬到了服务端
    （`POST /auth/oidc/callback`），认证中心的凭据不再出服务端，
    暴露面从「平台级令牌」降到了「桥自身的令牌」。
  - 真要收口时，最省事的两步：① 前置 nginx + TLS；② 把业务令牌 TTL
    从 90 天压到小时级（`DEVICE_TOKEN_TTL_SEC`），让截获的窗口变小。
- **认证中心侧的 client**：统一登录需要在认证中心登记
  `client_id=mn-ws-client` 与 `client_id=mn-ws-server`，
  没登记时 `auth login` 会在 authorize 端点被拒（`invalid client_id`）。
  - ⚠️ **这两个只登记在 DB 里，不是 go-ah 的种子** —— 重建库时不会自动带上。
  - **2026-11-13 决定：不改 go-ah 源码**（不往 `auth-hub/internal/db/db.go`
    的种子里加）。代价就是**重建库后必须重新登记**。
  - 重建后的补登记：走 go-ah 的管理 API `POST /api/admin/clients`，
    两条都是**公共客户端 + PKCE + 回环通配**：
    - `mn-ws-client` —— 回调白名单 `http://127.0.0.1:*/callback`
    - `mn-ws-server` —— 回调白名单 `http://127.0.0.1:7777/auth/callback`

