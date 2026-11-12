// 类型安全客户端的运行时实现。
//
// 类型由注册表推出（import type，编译后擦除——绝不会把 node 侧代码打进浏览器包）；
// 运行时所需的路由模式来自 /api/bootstrap 下发的命令表，因此**不需要**在浏览器里
// import registry。getCommands 是个延迟取值函数，保证面板启动完成后才解析路由。
import type { MODULES } from '../../../runtime/registry.js';
import type { CommandEntry } from '../../../runtime/help.js';
import type { TypedClient } from '../../../runtime/types/client.js';
import { api } from './client.js';

export function makeTypedClient(getCommands: () => CommandEntry[] | undefined): TypedClient<typeof MODULES> {
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

  return new Proxy({} as TypedClient<typeof MODULES>, {
    get(_target, prop: string) {
      return invoke(prop);
    },
  });
}
