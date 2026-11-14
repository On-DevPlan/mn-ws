# mn-ws client 半改写为 Rust —— 评估（2026-11-14）

> 问题：把 client 半从 TypeScript/Node 换成 Rust，**前后端完全隔离**，
> 且 **Rust 构建产物随 npm 一起分发**，可行性如何。
>
> 结论先行：**技术上可行且方向正确；但「Rust 产物随 npm 一起分发」这一条
> 与 npm 的分发模型有真实冲突，且 mn-rt 已经用血试过这条路。**

---

## 1. 现状清点（实测，非估计）

### 1.1 client 半的代码构成

| 目录 | 文件 | 行数 | Rust 化难度 |
|---|---|---|---|
| `core/` | 13 | 1916 | **高** —— 含 WS 连接器、HTTP 还原、鉴权、配置 |
| `runtime/` | 6 | 1000 | **高** —— CLI 框架 + 面板 HTTP 服务 + action 注册表 |
| `modules/bridge/` | 3 | 872 | 中 —— service 层（换码/目录/白名单） |
| `core/skills/` | 6 | 748 | **中** —— skill 安装到 `~/.claude/skills` |
| `modules/home/` | 4 | 664 | 中 |
| `web/frontend/` | 11 | 1003 | **零** —— React 面板，与 Rust 无关 |
| `runtime/types/` | 4 | 405 | 低 |
| `modules/auth/` | 2 | 289 | 中 |
| `modules/skill/` | 1 | 133 | 低 |
| `core/errors/` | 1 | 76 | 低 |
| **合计（不含面板）** | | **~6100** | |

**结论一**：真正需要 Rust 化的是 **~6100 行**（Node 特有），不是全部 7100 行。
面板那 1000 行 React 无论 client 是 Node 还是 Rust 都不变。

### 1.2 协议层是最有利的因素

`server/src/protocol.ts` 只有 **178 行**，契约极简：

```
PROTOCOL_VERSION = 1
FRAME = { register, registered, request, response, error, abort, ping, pong, shutdown }
encodeFrame / decodeFrame / normalizeHeaders / stripRequestHeaders / ...
```

JSON over WebSocket，**无二进制协议、无自定义序列化**。
Rust 侧用 `serde` + `tokio-tungstenite` 重写这一层是**半天到一天**的活。

### 1.3 依赖面极小

client 的运行时依赖只有三个：`ws`、`react`、`react-dom`。
Rust 化后对应 `tokio-tungstenite` + `reqwest`（或 `hyper`）+ `serde` —— 更少。

---

## 2. 「前后端完全隔离」到底要断什么

这是本次评估里**最需要先定义清楚**的一词。三种可能的读法，工作量差 3 倍：

| 读法 | 含义 | 工作量 |
|---|---|---|
| **A. 桥（数据面）与面板（控制面）隔离** | Rust 只管 WS 帧与 HTTP 转发；面板是独立 HTTP 服务，通过 API 操作桥 | **小** —— 面板已经是独立 SPA（`web/frontend/`），只要 Rust 侧实现同样的 `/api/*` 即可 |
| **B. client 半与 server 半用不同语言** | 两半分别 Node / Rust，跨语言共用协议 | **中** —— 协议层要双份实现（TS 一份、Rust 一份），且要防漂移 |
| **C. 面板完全脱离进程** | 面板变成独立 npm 包或远端页面 | **大** —— 面板要能连到别处的桥 |

**建议按 A 做**：它才是「前后端隔离」的工程含义（数据面与控制面分开），
而且与 B 不冲突 —— A 的隔离边界正好落在协议层，Rust 化后天然成立。

---

## 3. 分发：这是**真正的硬约束**

### 3.1 npm 的模型不允许「一个包按平台取不同二进制」

npm 包是**单一 tarball**，装到所有平台。要按平台分发二进制，只有三条路：

| 方案 | 做法 | 代价 | mn-rt 的实测 |
|---|---|---|---|
| **① 全塞主包** | 4 个平台的二进制全进 tarball | 主包体积 ×4~5（mn-rt 现在 7.7MB → 约 25MB+） | 没用 |
| **② 平台分包** | 主包 + N 个 `@scope/pkg-<platform>`，靠 optionalDependencies | 要发 N 个包、版本同步、npm 必装/不装各平台都有坑 | **试过，已废弃**（见下） |
| **③ 运行时下载** | 首次运行时从 GitHub Releases 拉，缓存到 `~/` | 首次要联网、离线不可用 | **现在实际在用** |

### 3.2 mn-rt 已经把这三条路都试过了 —— 结论是 ③

证据（2026-11-14 实测 npm）：

```
nx-rt 主包                       0.9.4   7,739,209 字节
@ondevplann/input-agent-win32-x64  0.7.10   355,216 字节
@ondevplann/input-agent-linux-x64  0.7.10   576,712 字节
```

**平台分包停在 0.7.10，主包已到 0.9.4** —— 相差 6 个 minor 版本，
说明分包路线**事实上已经停用**，现在走的是 `platform.js` 第 3 条：
运行时从 GitHub Releases 下载 + 缓存到 `~/.nx-rt/`。

而 `nx-rt` 主包的 `optionalDependencies` 现在是**空的** —— 分包入口都没留。

### 3.3 「Rust 产物随 npm 一起分发」的真实代价

若坚持 ①（随主包分发）：

- mn-ws client 主包现在 **828,763 字节**；Rust 化后
  `core/`（WS+HTTP 还原）与 `runtime/`（CLI+面板服务）约 3000 行 TS
  折合 Rust 二进制，每个平台约 **2–4 MB**（tokio+reqwest 静态链接）
- 4 平台（win32-x64 / darwin-x64 / darwin-arm64 / linux-x64）≈ **8–16 MB**
- 主包会从 **0.8 MB 涨到 9–17 MB**

`npx mn-ws` 的下载量涨 10–20 倍。对「用户只是跑一个桥」的场景，
这是**体感最差**的那条路 —— 而 npm 的分发恰恰是为了让 npx 起步快。

**建议**：采用 mn-rt 已验证的 ③（运行时下载 + 缓存），
或者 ① 但**只发当前平台**（发包时按 `process.platform` 裁剪，
代价是同一版本号发多次 —— npm 会拒，E403 "cannot publish over"）。

> 若要 ① 又要单一版本号，唯一干净的做法是
> **把 Rust 产物放到独立 npm 包，用 optionalDependencies 挂平台分包**
> —— 而 mn-rt 已经证明这条路在实践中会被放弃。

---

## 4. Rust 化真正能得到什么（收益评估）

| 收益 | 真实性 |
|---|---|
| **单文件启动，不依赖 Node** | ✅ 真实。`npx` 只需下载二进制，无 node_modules、无 npm 运行时 |
| **内存与 GC 抖动下降** | ✅ 真实但对本场景收益有限 —— 桥是 I/O 密集、低频，Node 的 GC 压力很小 |
| **启动更快** | ✅ 真实（几十 ms vs 数百 ms） |
| **「前后端隔离」更彻底** | ✅ 真实 —— 桥变成纯数据面进程，不带 React/Vite 产物 |
| **跨平台一致性** | ✅ 真实 —— 不再受 Node 版本/platform 差异影响 |
| **WS 帧处理性能** | ⚠️ **基本不相关** —— 桥是**低 QPS 的转发器**，瓶颈在网络往返不在序列化 |
| **代码量减少** | ❌ **不成立** —— Rust 的 `?`/错误处理/生命周期会**比 TS 更长**，实测通常是 1.3–1.8 倍 |

### 一个必须说清的反直觉点

**Rust 化不会让桥变快。** 桥每次请求的实际耗时是：

```
远端 → server 半 → WS → client 半 → 本机 HTTP → 应用 → 返回
```

其中网络往返占 99%+。用 Rust 重写省下的是「每帧几百微秒的序列化」，
在总耗时的 10 毫秒里占 0.005%。**换 Rust 的真实理由不是性能，是分发形态
（单二进制、不依赖 Node）与架构隔离，不是「更快」。**

---

## 5. 工作量估算

| 工作项 | 估计 | 说明 |
|---|---|---|
| Rust 协议层（帧编解码 + 头过滤） | 0.5–1 天 | 178 行 TS → Rust，`serde` + `tokio-tungstenite` |
| Rust WS 连接器（注册/重连/心跳/4403 停止） | 1–2 天 | 逻辑已在 TS 里跑通，翻译即可；**注意带上 v0.6.1 的 4403 停止重连** |
| Rust HTTP 还原（请求构造 + 响应回写 + 24MB 上限 + 超时） | 2–3 天 | 这里最容易出隐蔽 bug（头合并、body 编码、超时竞态） |
| Rust 鉴权（PKCE 铸码 + 设备令牌 + 配置） | 2–3 天 | HMAC-SHA256 手写即可（不要引 JWT 库）；OAuth 流程要跟浏览器交互 |
| Rust CLI（参数、serve、bridge、apps、auth 子命令） | 2–3 天 | 现有 CLI 有 404 行 + help 体系 |
| Rust 面板 HTTP 服务 + `/api/*` | 1–2 天 | 面板是 SPA，Rust 侧只需实现 API 与静态托管 |
| skill 安装（复制到 `~/.claude/skills`） | 0.5–1 天 | 纯文件操作 |
| CI 多平台编译 + 分发 | 1–2 天 | mn-rt 的 `build-input-agent.yml` 可直接抄 |
| 双实现并存期的协议漂移防护 | 1 天 | 建议：Rust 侧跑 **TS 的既有单测向量**做契约测试 |
| **合计** | **约 11–18 人天** | 熟练 Rust + 熟悉本项目 |

**关键风险不是工作量，是「协议双实现」**：过渡期 TS 与 Rust 两份协议代码并存，
改一处忘另一处 → 静默的不兼容（帧能解但字段对不上）。必须用契约测试钉住。

---

## 6. 建议路径

### 阶段 0（先做，1 天）：把「隔离」落到接口上，**不动语言**

先把 client 半拆成两个明确边界：

```
core/bridge-http.ts   ← 数据面：WS 帧 ↔ 本机 HTTP（无 Node 特有 API，纯协议）
core/control-api.ts   ← 控制面：起停桥 / 白名单 / 目录 / 账号（给面板的 /api/*）
```

面板只依赖 `control-api` 的 HTTP 契约，**不碰数据面**。
这一步做完后，「前后端隔离」已经成立，且**与用什么语言无关**。

> 这一步的价值：即使最终不 Rust 化，架构也更干净；
> 若要 Rust 化，隔离边界正好是移植的切割线。

### 阶段 1（并行，3–5 天）：Rust 协议层 + 契约测试

先只做协议层（帧编解码 + 头过滤），用 TS 现有单测向量做黄金用例。
**这一步不动生产路径**，纯新增。

### 阶段 2（5–8 天）：Rust 数据面（WS + HTTP 还原）

先只切「转发」这一条路径：Rust 进程收帧 → 打本机 HTTP → 回帧。
用**同一批请求**对比 Node 版与 Rust 版的响应（状态码/头/body 逐字节）——
这就是 mn-ws 已在 §9 定义的「透明性契约」，正好拿来做验收。

### 阶段 3（3–5 天）：Rust 鉴权 + CLI + 面板服务

此时才动鉴权与控制面。面板**保持 React 不变**（1000 行，一行不改）。

### 阶段 4（2 天）：分发

按 §3 的结论选 ③（运行时下载 + 缓存），
或若确定只支持 Windows（mn-ws client 半的实际部署场景），
直接 ① 单平台进主包 —— 那时主包 0.8MB → 3MB，可接受。

---

## 7. 一句话结论

**可行，方向对，但「Rust 产物随 npm 一起分发」这条要改。**

- **技术上**：协议层只有 178 行且是纯 JSON，Rust 化没有硬骨头。~11–18 人天。
- **架构上**：「前后端隔离」应该先在**接口层**落地（阶段 0），而不是绑在语言上。
- **分发上**：单 tarball 装不下多平台二进制；mn-rt 已经试过分包路线并**放弃了**
  （分包停在 0.7.10，主包已 0.9.1）。建议照它现在的做法：**运行时下载 + 缓存**；
  若 mn-ws client 实际只跑 Windows（当前确实如此），**单平台进主包**也够。
- **收益上**：换 Rust 的理由是**分发形态与架构隔离**，不是性能 ——
  桥是低 QPS 转发器，网络往返占全部耗时的 99%，Rust 省下的序列化开销可忽略。

---

## 附：本次评估的实测依据

- client 半代码量：按目录 `Get-Content | Measure-Object -Line` 统计
- 协议层：`server/src/protocol.ts` 178 行，导出 15 个符号
- mn-rt 分发：`build-input-agent.yml`（4 平台矩阵 + 冒烟测试 + Release）
- npm 实测：`npm view nx-rt / @ondevplann/input-agent-* / mn-ws` 的
  `version` 与 `dist.unpackedSize`
- mn-rt 实际分发路径：`client/lib/platform.js` 的 4 级候选顺序
  （本地 binaries/ → 平台分包 → 缓存目录 → 运行时下载）
