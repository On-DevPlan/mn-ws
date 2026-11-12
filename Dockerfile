# mn-ws server 半的运行镜像。
#
# 构建上下文是**仓库根**（不是 Dockerfile 所在目录）：
#   docker build -f Dockerfile -t mn-ws-server .
#
# 镜像里装的是 **server 包**（mn-ws-server）—— client 半不在这张镜像里：
# client 半跑在用户自己的机器上（本机 nx 服务那边），不是公网机上。
#
# ⚠️ 镜像里的 dist/ 是**宿主机构建好的产物**（CI 先跑 pnpm build）。
#    原因：server 包是 monorepo 的一个 workspace，单独在镜像里装依赖会
#    拖进整个 workspace（client 的 react 等全都要装）。构建与依赖安装分开，
#    镜像里只留运行期真正需要的东西。
#
# 部署方式（tarball 派）：runner build → docker save → gzip → scp → 服务器 docker load。
# 服务器档案 / secrets / 运维命令见 docs/DEPLOY.md。

FROM node:22-alpine

WORKDIR /app

# 运行期依赖只有 ws。--no-package-lock 是因为 server 包在 monorepo 里，
# 它的锁文件是根目录那份 pnpm-lock.yaml（这里没有单独的 package-lock.json）。
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock \
  && npm cache clean --force

# 构建产物 + 入口
COPY server/dist ./dist
COPY server/bin ./bin

# MN_WS_HOME 决定配置目录，数据目录是 $MN_WS_HOME/data（审计 JSONL + 日志都落这儿）。
# 设成 /app 而不是 /app/data，是为了让挂载点正好是 /app/data。
ENV NODE_ENV=production \
    MN_WS_HOME=/app \
    MN_WS_HOST=0.0.0.0 \
    MN_WS_PORT=7777 \
    MN_WS_LOG_LEVEL=info

# 审计与日志
VOLUME ["/app/data"]

EXPOSE 7777

# server 半**没有鉴权就拒绝启动**（这是代码里的硬闸，不是这里开的口子）：
# MN_WS_TOKEN / MN_WS_JWT_SECRET 必须由部署方注入，缺失时容器会直接退出并说明原因。
CMD ["node", "bin/mn-ws-server.mjs"]
