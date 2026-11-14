// 前端与 Rust client 之间的**类型契约**（前端自持，不再依赖 TS 运行时）。
//
// Rust 化后命令注册表住在 rust/mn-ws-client 里，面板拿不到编译期的
// action 清单 —— 路由模式由 /api/bootstrap 下发的命令表驱动（CommandEntry），
// TypedClient 键放宽为 string：调用不存在的 id 由 typed-client 的运行时兜底抛错。
//
// 形状与 Rust 侧 `routes.rs` 下发的命令表一致（0.7.x 起 TS 注册表已删，
// 参考实现在 tag `ts-final`）。

export interface CommandEntry {
  id: string;
  module: string;
  command: string;
  usage: string;
  http: { method: string; path: string } | null;
  summary?: string;
}

export type TypedClient = Record<
  string,
  (params?: Record<string, unknown>) => Promise<any>
> & {
  // 面板用到的 action id 列成**具名键**：与 Rust 侧注册表对账（拼错 id 编译报错）；
  // 具名键不受 noUncheckedIndexedAccess 影响，调用处不必写 ?.
  'home.greet': ActionFn;
  'bridge.status': ActionFn;
  'bridge.apps': ActionFn;
  'bridge.apps.add': ActionFn;
  'bridge.apps.remove': ActionFn;
  'bridge.apps.reopen': ActionFn;
  'bridge.whitelist.set': ActionFn;
  'bridge.catalog': ActionFn;
  'bridge.start': ActionFn;
  'bridge.stop': ActionFn;
  'auth.list': ActionFn;
  'auth.switch': ActionFn;
  'auth.logout': ActionFn;
  'auth.prune': ActionFn;
  'bridge.favorites.remove': ActionFn;
  'bridge.favorites.update': ActionFn;
};

type ActionFn = (params?: Record<string, unknown>) => Promise<any>;
