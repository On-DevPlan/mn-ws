// HTTP 路由表：由 action.http 编译而来，与 CLI 同源。
//
// 这里没有手写路由 —— 每条路由都来自某个模块的 action 声明，
// 所以「面板上有按钮、CLI 里没命令」在结构上不可能发生。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { compileRoute, applySpec } from './spec.js';
import { toErrorPayload, httpStatusOf, CODES } from '../core/errors/index.js';
import type { ErrorCode } from '../core/errors/index.js';
import { ACTIONS, type BoundAction } from './registry.js';
import type { ActionShape } from './types/action.js';
import type { CompiledRoute } from './spec.js';

interface RouteEntry {
  action: BoundAction;
  route: CompiledRoute;
}

// 逐段比较两条模式，决定谁该先匹配：**字面量段优先于参数段**，段数多的优先。
//
// 为什么要排序而不是按声明顺序：`GET /api/repos/status` 与 `GET /api/repos/:id`
// 都能匹配 `/api/repos/status`，谁先声明谁赢。一旦有人调整 actions 顺序，
// 前者就会被后者抢走——这种 bug 只在运行时、且只在特定路径上出现，极难排查。
//
// 正确比较：算"前 N 段里**字面量段**的总个数"，多者优先；同字数时
// 按"从左到右遇到的第一处分歧段"——字面量胜出。
function routeSpecificity(pattern: string): string[] {
  return pattern.split('/').filter(Boolean);
}

function compareRoutes(a: RouteEntry, b: RouteEntry): number {
  const pa = routeSpecificity((a.action.http as [string, string])[1]);
  const pb = routeSpecificity((b.action.http as [string, string])[1]);
  const litA = pa.filter((s) => !s.startsWith(':')).length;
  const litB = pb.filter((s) => !s.startsWith(':')).length;
  if (litA !== litB) return litB - litA; // 字面量段越多越具体
  if (pa.length !== pb.length) return pb.length - pa.length;
  for (let i = 0; i < pa.length; i++) {
    const litA2 = !pa[i]!.startsWith(':');
    const litB2 = !pb[i]!.startsWith(':');
    if (litA2 !== litB2) return litA2 ? -1 : 1;
  }
  return 0;
}

const ROUTES: RouteEntry[] = ACTIONS.filter((a) => a.http)
  .map((action) => ({
    action,
    route: compileRoute(action as unknown as ActionShape & { http: readonly [string, string] }),
  }))
  .sort(compareRoutes);

/**
 * 登录门禁。
 *
 * 返回 null = 放行；返回对象 = 拒绝（status + error）。
 *
 * 为什么门禁在**服务端**：面板握着桥的凭据，能连 server、能改白名单。
 * 门禁只做在前端（藏个按钮）的话，任何本机进程照样能直接调 API。
 *
 * 豁免的路径是「看一眼登录态」与「发起登录」这两条 —— 它们不返回敏感数据，
 * 而且前端必须能先问一句「我登录了吗」才知道该渲染登录页还是主界面。
 */
export interface ApiDenial {
  status: number;
  error: string;
}
export type ApiGate = (pathname: string, method: string) => ApiDenial | null;

let apiGate: ApiGate | null = null;

/** 装上门禁（由 runtime/server 在起服务时调用）。传 null = 不设门禁。 */
export function setApiGate(gate: ApiGate | null): void {
  apiGate = gate;
}

/** 默认门禁：未登录一律 401，只有「问登录态」与「发起登录」放行。 */
export function defaultApiGate(isLoggedIn: () => boolean): ApiGate {
  const EXEMPT = new Set(['/api/auth/status', '/api/auth/login/start', '/api/bootstrap']);
  return (pathname, _method) => {
    if (EXEMPT.has(pathname)) return null;
    if (isLoggedIn()) return null;
    return { status: 401, error: 'not_logged_in' };
  };
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

// 跨站防护。服务虽然只绑 127.0.0.1，但用户浏览器里的任意页面都能向它发起请求——
// 少了这道校验，一个恶意网页就能 POST /api/repos/scan 或 DELETE /api/repos/:id。
// 浏览器发跨域请求必带 Origin，非浏览器客户端（curl / agent / 测试）不带，故放行。
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();

  // ── 登录门禁 ──
  if (apiGate) {
    const denied = apiGate(url.pathname, method);
    if (denied) {
      sendJson(res, denied.status, { ok: false, error: denied.error, code: 'not_logged_in' });
      return;
    }
  }

  for (const { action, route } of ROUTES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(url.pathname);
    if (!m) continue;

    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
      sendJson(res, 403, {
        ok: false,
        error: '跨站请求被拒绝（面板仅接受本机来源）',
        code: CODES.BLOCKED satisfies ErrorCode,
      });
      return;
    }

    try {
      const raw: Record<string, unknown> = {};
      route.keys.forEach((k, i) => {
        raw[k] = decodeURIComponent(m[i + 1]!);
      });
      if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of url.searchParams) raw[k] = v;
      } else {
        Object.assign(raw, await readBody(req).catch(() => ({})));
      }
      const data = await action.run(
        applySpec(action as unknown as ActionShape, raw),
        { transport: 'http' },
      );
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      // 错误码 → HTTP 状态只在这一处映射（core/errors 提供表）
      const p = toErrorPayload(err);
      const payload: Record<string, unknown> = { ok: false, error: p.message, code: p.code };
      if (p.details !== undefined) payload.details = p.details;
      sendJson(res, httpStatusOf(p.code), payload);
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + url.pathname });
}
