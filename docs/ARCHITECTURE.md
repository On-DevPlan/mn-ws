# mn-ws 架构与开发对齐 —— 现役总览

> 状态：**现役**（2026-11-14，随 0.7.x Rust 化 + 平台子包分发落地而写）。
> 历史文档：[design.md](design.md) 是 TS 时代的设计草案（目标/哲学仍有效，实现引用已过时）；
> [RUST-PORT.md](RUST-PORT.md) 记 Rust 化的取舍；[DEPLOY.md](DEPLOY.md) 记公网部署。
> TS 参考实现：tag **`ts-final`**。
>
> 这篇回答四个问题：**这个组里每个仓库负责什么、一次请求怎么流动、
> 令牌怎么传递、新人上手要对齐哪些事实。**

---

## 1. 全链路与仓库职责

```
┌──────────┐   OIDC    ┌────────────┐
│   fr     │──────────▶│   go-ah    │  统一认证中心（扫码登录 / OIDC / 设备令牌签发）
│ (手机端) │           │  (GoFrame) │  · 发令牌，不参与转发；mn-ws 的令牌链路完全围绕它
└────┬─────┘           └────────────┘
     │ HTTPS（目录/桥接请求，凭 X-Mn-Ws-Token）
     ▼
┌──────────────────────┐        WS 注册帧/转发帧        ┌──────────────────────┐
│  mn-ws server（公网） │◀────── 单条 WS 长连接 ────────▶│  mn-ws client（本机） │
│  rust/mn-ws-server   │   register {apps[{app,base,   │  rust/mn-ws-client   │
│  :7777 容器部署      │    port,title,alive}], token} │  + 面板 + CLI        │
└──────────────────────┘                               └──────────┬───────────┘
                                                                  │ 还原成真实 HTTP
                                                                  ▼
                                                       ┌──────────────────────┐
                                                       │ 本机服务（nx-kv 7877 │
                                                       │ / nx-nx 7880 / 任意）│
                                                       └──────────────────────┘
```

| 仓库 | 职责 | 关键路径 |
|---|---|---|
| **go-ah** | 统一认证中心：扫码登录、OIDC、mn-ws-client 的 `client_id` 与回调白名单。**只发令牌，不碰转发** | `internal/controller/qr/`、OIDC 端点 |
| **fr** | 手机端：应用识别表（认识的应用给整页）+ mn-ws 桥接页（按 PC 分组的远端目录、「换令牌」）+ 统一登录面板。凭据存 `mnws_grant` 键 | `lib/api/mnws/`、`lib/lab/demos/mnws/` |
| **mn-ws** | 桥本体（本仓库，Rust workspace 三 crate）：server 半（公网中继）/ client 半（本机桥 + 面板 + CLI）/ core（协议层，两半共用） | `rust/mn-ws-{server,client,core}`、`client/`（npm 壳 + React）、`scripts/` |
| **nx-kv 等** | 被桥服务的样例：零改动入桥（白名单勾上即可）。两台 PC 都跑同名 app 时体现分组/顶替规则 | 各自仓库 |

**协议层在 core 的意义**：帧格式与 app 路由规则只有一份实现，client/server 同时依赖 ——
漂移在**结构上**不可能（TS 时代的双实现只能靠契约测试"发现"漂移，Rust 化后直接杜绝）。

---

## 2. 核心概念（对齐用词）

| 概念 | 含义 | 易错点 |
|---|---|---|
| **PC / bridgeId** | 一台本机 = 一条 client 连接。bridgeId 默认取 clientId，自报 `pcName`（电脑名）展示 | 展示表（pcs）与路由表（bridges）**分离**：展示互不顶替，路由同 app 名顶替 |
| **app** | 一个被桥的本机 HTTP 服务的路由标识（如 `nx-kv`）。**一个 app 名一个桥**：同名路由归后来注册者 | 手机端同名会标「路由在别的 PC 上」；要指定目标机器用 `X-Mn-Ws-Pc: <bridgeId>` 头 |
| **白名单** | 勾上的才桥。**端口在监听 ≠ 可以桥**；**注册了 ≠ 在运行** | 注册帧带 `alive`（client 探活上报），目录如实展示「未启动」，路由不拦 |
| **customApps** | 当前登记着的应用（动态注册的落盘形态），白名单 + 登记表合并出可桥集合（`resolve_apps`） | 移除 app **不**删常用 |
| **常用 favorites** | 用过的应用记忆（一键重开）。上限 20 条，同名覆盖，`usedAt` 排序 | CRUD 完整：面板「管理」/ `mn-ws favorites list|remove|update`；编辑不改 `usedAt` |
| **catalog** | server 汇总的远端目录（按 PC 分组），fr 的桥接页数据源 | `alive`/`active`/`pcNameMissing` 都是**展示层真相**，各管一件事 |
| **设备令牌** | OIDC 登录后签发的长期凭据，存本机账号簿 | 注册帧凭据优先级：**设备令牌 → 静态门禁 token**。只读顶层 `token` 的旧代码是 0.7.3 前的著名坑 |
| **静态门禁 token** | 不登录时的共享门禁（`X-Mn-Ws-Token` / 注册帧 `token`） | 转发时**必须剥离**——它是桥的 L1 凭据，泄给目标服务等于交出门禁 |
| **4403** | 注册被拒的 WS 关闭码，客户端**停止重连**（静态令牌是确定性失败，重试只刷屏） | 凭据变了会先重读盘上凭据再重试一次（`refresh_token_if_changed`） |

---

## 3. 数据转发（一次请求的生命周期）

```
手机 GET http://1.94.101.189:7777/nx-kv/api/todo
  │ ① 门禁：X-Mn-Ws-Token（或已登录态）→ Caller{user_id}
  │ ② 路由：app = nx-kv（X-Mn-Ws-Pc 可指定目标 PC）→ 路由表找到桥连接
  │ ③ 封帧：请求行/头/体 → JSON 帧（headers 归一化小写、值成数组、
  │      剥 hop-by-hop + Origin + X-Mn-Ws-Token；content-length 按实际 body 重算
  │      —— body 走 base64 膨胀 ~33%，透传原长度会让本机服务按错长度读）
  ▼
WS 帧 {type:"request", id, app, method, path, headers, body(base64)}
  │ ④ client 收帧 → 还原成真实 HTTP 打给 127.0.0.1:7877（多路复用：
  │      一条 WS 并发多请求，按帧 id 归位；abort 帧对应客户端断开）
  ▼
本机响应 → 回帧 {type:"response", id, status, headers, body(base64)}
  │ ⑤ server 按帧 id 找回挂起的 HTTP 请求 → 原样回给手机
  ▼
手机收到与直连 127.0.0.1:7877 **逐字节一致**的响应
```

注册与保活（client → server 方向）：

- **注册帧**：连接建立即发 `{token, bridgeId, pcName, apps:[{app,base,port,title,alive}]}`。
  应用表是 connect 时的快照；`alive` 是**当下探活**结果（TCP connect 400ms）。
- **心跳 15s**：PING/PONG。每个周期**顺手重探全部应用端口**，alive 集合变了 →
  踢掉当前连接（`kick`）→ 退避重连 → 新注册帧带新鲜状态。目录因此自愈，不需要手动重启桥。
- **热更**：面板加/删应用、改白名单 → 落盘后立刻 `refresh_apps`（换表 + kick）→
  重连重注册。**这是 0.7.5 的教训**：注册帧是快照，不重连的话手机上永远看不到新应用。
- **顶替与归还**：同 app 名被新桥顶替时，旧桥的记录从路由表摘掉但旧桥仍连着
  （`PeerMeta.app_list` 记账）——新桥先断开时 app 归还给还活着的旧桥，而不是变成"没人能路由"。

---

## 4. 令牌链路（go-ah ↔ fr ↔ mn-ws）

```
fr（统一登录面板，登 go-ah）
  │ 登录态铸码 → mn-ws-client 的回调
  ▼
mn-ws client /callback（本机回环，任意端口 —— client_redirect_uri(port)；
  ⚠️ 不能用 server 名下登记的 /auth/callback：那是 server 的回调端口，
  认证中心白名单按 client 分开，client 用它会 400）
  │ code 换 access_token → 换设备令牌 → 存本机账号簿（多账号，可切换）
  ▼
注册帧 token = credential() = 设备令牌 ?? 静态门禁
  ▼
server 验签 → 绑定 user_id → catalog 只展示该用户（或门禁）可见的 PC
```

**go-ah 的 access_token/refresh_token 一次都不出 mn-ws 服务端** —— fr 到手的是
mn-ws 自己的设备令牌。目标服务收到的是被剥离桥凭据后的原始请求头，
它们的原生鉴权照常工作（G2 目标）。

---

## 5. 分发与版本纪律

| 渠道 | 载体 | 机制 |
|---|---|---|
| **npm（client 半）** | 主包 `mn-ws`（bin = `bin/mn-ws.js` 启动器 + `web/public` React 产物）+ 4 平台子包 `mn-ws-{win32-x64,darwin-x64,darwin-arm64,linux-x64}`（各带原生二进制 + os/cpu/libc） | esbuild 同款 optionalDependencies：npm 只装匹配平台那个。子包是 workspace 成员（`client/platform/<key>/`，package.json 入库 bin 不入库），主包 `workspace:*` 引用，pnpm pack 时重写成具体版本 |
| **Docker（server 半）** | 多阶段构建（rust:1.92-slim 编译 → debian:bookworm-slim 运行），Deploy 流水线 docker save → scp → load | 不走 GHCR（跨境拉取慢） |
| **GitHub Release** | 只有 tag + notes，**不挂二进制**（资产名平铺，多平台同名必撞 422） | release.yml 建 |

版本纪律（release.yml 强制）：

1. tag 必须等于 `v<client/package.json 的 version>`，否则当场失败（npm 同版本号永不可重发）
2. 五个包（主包 + 4 子包）**同版本同发**：`node scripts/sync-optional-deps.mjs` 对齐（连 rust/Cargo.toml 的版本一起对齐 —— 二进制 `--version` 自报要与 npm 包一致）
3. 发布顺序：test（全量测试 + 版本对齐防呆）→ 平台矩阵发 4 子包（幂等，已存在则跳过）→ publish-main 发主包 → 建 Release
4. 改版本号的完整动作：改 `client/package.json` → `node scripts/sync-optional-deps.mjs` → `pnpm install` → commit → 打 tag

**注意「零 Node 依赖」的确切含义**：二进制本体运行时不经过 node（build-rust 冒烟里移除 PATH 上的 node 验证）；
用户敲 `mn-ws` 先经过启动器（Node）再 spawn 二进制 —— 装 npm 包必然有 Node，这一跳不损失什么。

---

## 6. 测试与对齐（改完代码跑什么）

| 层 | 命令 | 验什么 |
|---|---|---|
| Rust 单测 + e2e | `cd rust && cargo test --release` | 帧编解码、路由规则、配置、账号簿、面板 API、假目标服务打穿（逐字对比断言） |
| 二进制冒烟 | `pnpm --filter mn-ws test:smoke` | 真进程里跑关键路径（不依赖 node） |
| 面板实测 | `pnpm --filter mn-ws test:panel` | 起 Rust 面板伺服 React 产物，**每个 /api 端点**打一遍验形状 |
| 布局验证 | `pnpm --filter mn-ws test:layout` | 二进制 + web/public 并排时面板能起（Rust `web_dir()` 的发布布局路径） |
| 分发实测 | `node scripts/verify-dist.mjs` | 平台子包 → 主包 → 隔离安装 → 启动器跑通 + 二进制无 node 仍能跑 |
| 远端验收 | `pnpm --filter mn-ws test:e2e` | 打**已部署**的公网 server（真实网络/容器），需要 MN_WS_E2E_* 环境变量 |
| 面板自测（开发期） | `node scripts/dev.mjs` | Rust 面板 + vite HMR 一起起 |

**发版流水线**（release.yml，三段）：`test`（含 tag==version 与子包版本对齐两个防呆）
→ `platform` 矩阵（四平台各自 cargo build + make-platform-pkg + npm publish 子包）
→ `publish-main`（vite 产物 → pack → npm publish 主包 → 建 Release）。
`build-rust.yml` 是**纯校验**（四平台编译/单测/无 Node 冒烟/pack 组装），不发布。

---

## 7. 新人上手 30 分钟路径

1. clone 后 `pnpm install && pnpm -r build && cd rust && cargo build --release`
2. `pnpm build:dist`（把二进制 + React 产物装进本地布局）→ `pnpm start` → 面板 :7777
3. 改 Rust：`cargo test --release` 是底线；改面板：`pnpm dev`（vite HMR + Rust 后端）
4. 改协议：**只改 `rust/mn-ws-core`**，两端自动生效；帧是零语义的
   （`serde_json::Value` + preserve_order + IndexMap，键序进字节，别"顺手"换结构体）
5. 要发版：按 §5 版本纪律三步 + 打 tag，CI 全自动

## 8. 踩坑档案（2026-11-14 发版日实录，细节见 git log）

- 面板自测用 `process.env.TEMP` —— Linux runner 上是 undefined，用 `os.tmpdir()`
- GitHub Release 资产名平铺：四平台二进制同名 → 422；本项目已不往 Release 挂资产
- `macos-13` 标签已弃用排不到 runner：darwin-x64 在 arm runner 上 `--target` 交叉编译
- 交叉编译目标必须 `rustup target add` / dtolnay action 的 targets，缺了报 E0463
- 安装目录没有 package.json 时 npm 会向上找根，把包装进 HOME —— 测试脚本先 `npm init -y`
- 共享 workspace 里两个会话同时发版会撞版本号：跳号即可（npm 同版本永不可重发，tag 被占就 ++）
- publish-main 的 client 构建在删掉 TS 运行时后是**纯 vite**，别再 `-r` 依赖 server 半的 dist
