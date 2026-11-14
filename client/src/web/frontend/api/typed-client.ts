// 类型安全客户端的运行时实现。
//
// 路由模式来自 /api/bootstrap 下发的命令表，**不需要**在浏览器里 import registry；
// 类型契约见 ./contracts.ts（Rust 化后前端自持，注册表在 rust/mn-ws-client）。
import type { CommandEntry, TypedClient } from './contracts.js';
import { api } from './client.js';

export function makeTypedClient(getCommands: () => CommandEntry[] | undefined): TypedClient {
  const invoke = (id: string) => async (params: Record<string, unknown> = {}) => {
    const entry = getCommands()?.find((c) => c.id === id);
    if (!entry?.http) throw new Error('未知 action 或面板尚未完成启动: ' + id);

    const { method, path: pattern } = entry.http;
    let path = pattern;
    const rest: Record<string, unknown> = { ...params };

    // 替换 :param；缺失即抛错（类型层已保证必填，这是运行时兜底）
    for (const token of pattern.match(/:[\w-]+/g) || []) {
      const k = token.slice(1);
      if (rest[k] === undefined) throw new Error(`缺少路由参数 ${k}（action ${id}）`);
      path = path.replace(token, encodeURIComponent(String(rest[k])));
      delete rest[k];
    }

    if (method === 'GET' || method === 'HEAD') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) q.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
      const qs = q.toString();
      return api(path + (qs ? '?' + qs : ''));
    }
    return api(path, { method, body: rest });
  };

  return new Proxy({} as TypedClient, {
    get(_target, prop: string) {
      return invoke(prop);
    },
  });
}
