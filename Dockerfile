# mn-ws server 半的运行镜像。
#
# 构建上下文是**仓库根**（不是 Dockerfile 所在目录）：
#   docker build -f Dockerfile -t mn-ws-server .
#
# 为什么上下文是仓库根：mn-ws 是**单包**结构 —— bin/、lib/、server/、client/
# 互相 require，拆成两半各出一个镜像会得到一个跑不起来的 server
# （bin/index.js 顶层就 require 了 client/ 那两个模块）。
#
# 部署方式（GHCR 派）：runner build+push → 服务器 pull。服务器档案见 docs/DEPLOY.md。

FROM node:22-alpine

WORKDIR /app

# 依赖先装：只有 package*.json 变化时才重跑这一层，代码改动不会让缓存失效。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 代码
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY server/ ./server/
COPY client/ ./client/
COPY README.md ./

# MN_WS_HOME 决定配置目录，数据目录是 $MN_WS_HOME/data（审计 JSONL + 日志都落这儿）。
# 设成 /app 而不是 /app/data，是为了让挂载点正好是 /app/data，docker run 不用多绕一层。
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
CMD ["node", "bin/index.js", "server"]
