# mn-ws server 半的运行镜像。
#
# 构建上下文是**仓库根**（不是 Dockerfile 所在目录）：
#   docker build -f Dockerfile -t mn-ws-server .
#
# 镜像里跑的是 **Rust 二进制** —— 运行时**零 Node 依赖**：
# 镜像里没有 node、没有 npm、没有 node_modules，只有那一个二进制。
#
# 为什么要多阶段：Rust 编译要完整的工具链（几百 MB），
# 但运行期只要一个二进制 —— 多阶段把工具链留在构建层，不带进最终镜像。
#
# ⚠️ client 半不在这张镜像里：client 半跑在用户自己的机器上
#    （本机 nx 服务那边），不是公网机上。
#
# 部署方式（tarball 派）：runner build → docker save → gzip → scp → 服务器 docker load。
# 服务器档案 / secrets / 运维命令见 docs/DEPLOY.md。

# ─────────────────────── 构建阶段 ───────────────────────
FROM rust:1.92-slim-bookworm AS builder

WORKDIR /build

# 先只拷依赖清单，让依赖层能被缓存住（改代码不会重新拉依赖）。
# ⚠️ workspace 的根在 rust/ 下 —— Cargo.toml 里 members 是相对根算的，
#    所以这里要保持 rust/ 的目录结构。
COPY rust/Cargo.toml rust/Cargo.lock ./rust/
COPY rust/mn-ws-core/Cargo.toml ./rust/mn-ws-core/
COPY rust/mn-ws-client/Cargo.toml ./rust/mn-ws-client/
COPY rust/mn-ws-server/Cargo.toml ./rust/mn-ws-server/

# 用假的源文件占位，让 cargo 先把依赖编出来（这一层只关心依赖）。
#
# ⚠️ 占位必须覆盖每个 crate 声明的**全部目标**：
#   mn-ws-core   → lib
#   mn-ws-client → lib + bin（集成测试要访问 lib）
#   mn-ws-server → lib + bin
# 少一个就会报「couldn't read xxx/src/lib.rs」（之前就踩过）。
#
# ⚠️⚠️ 编完占位后必须**清掉 target/**：否则下一步编真源码时，cargo 会认为
#    「依赖没变、指纹没变」而**直接复用占位产物** ——
#    那样打进镜像的就是 `fn main() {}`，容器起来什么都不干就 exit 0。
#    （症状：容器反复 Restarting(0)、健康检查永远不过、日志全空。）
RUN mkdir -p rust/mn-ws-core/src rust/mn-ws-client/src rust/mn-ws-server/src \
 && echo "" > rust/mn-ws-core/src/lib.rs \
 && echo "" > rust/mn-ws-client/src/lib.rs \
 && echo "fn main() {}" > rust/mn-ws-client/src/main.rs \
 && echo "" > rust/mn-ws-server/src/lib.rs \
 && echo "fn main() {}" > rust/mn-ws-server/src/main.rs \
 && cd rust \
 && cargo build --release --bin mn-ws-server \
 && rm -rf mn-ws-core/src mn-ws-client/src mn-ws-server/src target

# 真源码进来重编。
COPY rust/ ./rust/
RUN cd rust \
 && cargo build --release --bin mn-ws-server \
 && cp target/release/mn-ws-server /tmp/mn-ws-server \
 && ./target/release/mn-ws-server --version

# ─────────────────────── 运行阶段 ───────────────────────
FROM debian:bookworm-slim

# ca-certificates：server 半要连认证中心（OIDC 换码 / userinfo）——
# 走 https 时没有根证书会验签失败。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /tmp/mn-ws-server /app/mn-ws-server

# MN_WS_HOME 决定配置目录，数据目录是 $MN_WS_HOME/data（审计 JSONL + 日志都落这儿）。
# 设成 /app 而不是 /app/data，是为了让挂载点正好是 /app/data。
ENV MN_WS_HOME=/app \
    MN_WS_HOST=0.0.0.0 \
    MN_WS_PORT=7777 \
    MN_WS_LOG_LEVEL=info

# 审计与日志
VOLUME ["/app/data"]

EXPOSE 7777

# server 半**没有鉴权就拒绝启动**（这是代码里的硬闸，不是这里开的口子）：
# MN_WS_TOKEN / MN_WS_JWT_SECRET 必须由部署方注入，缺失时容器会直接退出并说明原因。
CMD ["/app/mn-ws-server"]
