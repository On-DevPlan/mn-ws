// Web 服务器：node:http 零依赖。
//
// 职责三件：
//   1. 发静态面板文件
//   2. 把 /api/* 交给路由层（见 api.ts）
//   3. **登录门禁**：未登录时业务 API 一律 401；以及 OIDC 回调路由 /callback
//
// 为什么门禁在服务端而不是前端：面板握着桥的凭据（能连 server、能改白名单），
// 「打开就能用」等于「任何能访问这个端口的东西都能用」。
// 门禁一旦只做在前端（藏个按钮），任何本机进程照样能直接调 API。
import http from 'node:http';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { handleApi, sendJson, setApiGate, defaultApiGate } from './api.js';
import { DEFAULT_PORT } from '../core/paths.js';
import { asAbsolutePath, type AbsolutePath } from '../core/brand.js';
import type { MnWsController } from '../core/controller.js';

// vite 的 outDir：
//   构建后 dist/runtime/server.js → dist/web/public
//   源码态 src/runtime/server.ts → src/web/public（dev 下由 vite 直接服务，仅兜底）
const PUBLIC_DIR: AbsolutePath = asAbsolutePath(
  resolve(fileURLToPath(new URL('../web/public/', import.meta.url))),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = resolve(PUBLIC_DIR, rel);

  // 越界校验：解析成绝对路径后必须仍落在 PUBLIC_DIR 内。
  // 比对解析结果，而不是剥离 '..' 字面量——后者挡不住编码变形。
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** 运行时控制器（登录态 + 桥）。传了就启用登录门禁与 /callback 路由。 */
  controller?: MnWsController | null;
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', controller = null }: StartServerOptions = {}): Promise<
  HttpServer<typeof IncomingMessage, typeof ServerResponse>
> {
  // 装登录门禁（没有 controller 就不设 —— 开发态可能只想看静态页）
  setApiGate(controller ? defaultApiGate(() => controller.session.snapshot().loggedIn) : null);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // ── OIDC 回调：浏览器把授权码送回面板的 /callback ──
      //
      // 放在 /api 之前：它不是 API，是认证中心指定的固定回调地址。
      // 路径固定 /callback、端口通配 —— 与 go-ah 里 mn-ws-client 的白名单一致。
      if (url.pathname === '/callback' && controller) {
        await handleCallback(url, res, controller);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: String((err as { message?: string })?.message || err),
        code: 'INTERNAL',
      });
    }
  });
  return new Promise((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve_(server));
  });
}

/**
 * 处理 OIDC 回调：收回调 → 换 access_token → 换设备令牌 → 存账号簿。
 *
 * 失败时**如实说失败**：页面显示错误 + 原因，而不是一个「登录成功」的假象。
 */
async function handleCallback(url: URL, res: ServerResponse, controller: MnWsController): Promise<void> {
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const err = url.searchParams.get('error');

  if (err) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h3>授权未通过</h3><p>${escapeHtml(err)}</p><p>可以关闭这个页面了。</p>`);
    return;
  }

  try {
    const session = await controller.session.completeLogin(code, state);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<h3>✅ 已登录</h3><p>${escapeHtml(session.nickname || session.email || session.userId || '已登录')}</p>`
      + '<p>可以关闭这个页面，回到面板了。</p>',
    );
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<h3>登录失败</h3><p>${escapeHtml((e as Error).message)}</p>`
      + '<p>可以关闭这个页面，回到面板重试。</p>',
    );
  }
}

/** 最小 HTML 转义：回调页会回显错误文本，不能让它变成可执行脚本。 */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
