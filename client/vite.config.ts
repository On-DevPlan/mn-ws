// Vite 配置：前端源码在 src/web/frontend/，构建产物输出到 dist/web/public/。
// server 只服务该目录（静态 + /api），对构建工具零感知——发布产物与开发模式共用同一入口。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端源码根下的文件会被暴露成 URL：src/web/frontend/api/client.ts → /api/client.ts。
// 而 /api 又是后端接口前缀，于是**前端自己的模块请求会被代理吞掉**——
// 浏览器拿到一坨 JSON、import 失败，dev 模式下面板直接起不来。
//
// 这是 Vite root 与服务端前缀的天然冲突：靠「目录别叫 api」这种约定防不住，
// 新增一个同名目录就会重现。所以按「是不是前端资源」来决定走不走代理。
const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

// 返回真值表示「这个请求该由 Vite 自己服务」，返回 undefined 表示「交给代理」。
// 导出是为了单测能直接钉住它——这条规则一旦被改坏，dev 模式会整页白屏。
export function shouldServeLocally(url: string | undefined): string | undefined {
  const path = String(url || '').split('?')[0]!;
  return FRONTEND_ASSET.test(path) ? path : undefined;
}

// 后端端口：默认 7777，但 dev 脚本会在端口被占时改用别的端口——
// 代理目标必须跟着后端**实际监听**的端口走。
// 写死 7777 的话，dev 前端会去连占用那个端口的别的服务：页面能开、数据全错。
const BACKEND_PORT = Number(process.env.MN_WS_PORT) || 7777;

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: {
    // 与 tsc 的 dist 布局对齐：dist/runtime/server.js → dist/web/public
    outDir: '../../../dist/web/public',
    emptyOutDir: true,
  },
  server: {
    port: 7930,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        bypass: (req) => shouldServeLocally(req.url),
      },
    },
  },
});
