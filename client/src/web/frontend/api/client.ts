// API 客户端：全部面板操作走 /api，与 CLI 共享同一份 action 声明。
//
// 响应包约定 { ok: true, data } / { ok: false, error, code }。
// 失败时抛 ApiError 并带上 .code —— 调用方可据此区分「业务冲突」与「参数错误」，
// 而不是像改造前那样只能对错误文案做字符串匹配。
const DEFAULT_TIMEOUT_MS = 30000;

export interface ApiOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

export class ApiError extends Error {
  code?: string;
  details?: unknown;
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    let json: { ok?: boolean; error?: string; code?: string; details?: unknown; data?: T };
    try {
      json = await res.json();
    } catch {
      throw new ApiError(`HTTP ${res.status}`);
    }
    if (!json.ok) {
      const err = new ApiError(json.error || '请求失败');
      err.code = json.code;
      err.details = json.details;
      throw err;
    }
    return json.data as T;
  } catch (e) {
    // AbortError 的原生文案是「The operation was aborted」，对用户没有意义
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('请求超时（本地服务无响应）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
