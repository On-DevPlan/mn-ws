// 面板各页面的 **API 响应类型**（前端自持）。
//
// Rust 化后这些形状由 rust/mn-ws-client 的面板 API 下发 —— 类型定义搬到
// 前端（原先寄生在 TS 运行时的 service.ts 里，已随运行时删除）。
// 改响应形状时两边一起改：Rust 侧下发 + 这里声明。

/** 桥接状态（/api/bridge/status）。 */
export interface BridgeStatusView {
  state: string;
  url: string;
  clientId: string;
  /** 白名单里的应用 */
  apps: string[];
  /** server 半已确认注册的应用（注册成功才有） */
  registered: string[];
  /** 当前凭据的归属（登录了就是用户名，没登录就是「静态门禁」） */
  identity: string;
  loggedIn: boolean;
  via: string;
  reason?: string;
  /** 重连等待（ms）；未在重连时缺省 */
  retryInMs?: number;
}

/** 用过的应用（面板上的「一键重开」）。 */
export interface FavoriteApp {
  name: string;
  base: string;
  title?: string;
  /** 最近一次使用的时间戳（ms）；用于排序，越近越靠前 */
  usedAt: number;
}

/** 白名单 + 候选 + 远端目录（/api/bridge/apps）。 */
export interface BridgeAppsView {
  /** 白名单里的应用 + 端口存活 */
  configured: { app: string; title: string; port: number | null; base: string | null; alive: boolean; custom: boolean }[];
  /** 已登记但不在白名单里的（供面板勾选） */
  candidates: { app: string; title: string; port: number | null; alive: boolean }[];
  /** 在白名单里、但没有登记基址的应用（被跳过了，要说清楚） */
  missing: string[];
  /**
   * 用过的应用（面板上的「一键重开」）。
   *
   * 与 configured 的差别：configured 是**现在桥着**的，favorites 是**用过**的
   * （可能已经移除）。反复暴露同一个端口是常见动作，第二次不该重新敲一遍。
   */
  favorites: FavoriteApp[];
}

/** 目录里的一个应用。 */
export interface CatalogApp {
  app: string;
  title: string;
  port: number | null;
  base: string | null;
  bridgeId: string;
  /** 这台 PC 的电脑名。 */
  pcName?: string;
  /** 这个 app 名当前**路由不到**这台 PC（被别的 PC 顶替了）。 */
  pcNameMissing?: boolean;
}

/** 目录里的一个 PC 分组。 */
export interface CatalogPc {
  bridgeId: string;
  /** 电脑名（client 自报）。 */
  name: string;
  userId: string;
  connectedAt: string;
  apps: (CatalogApp & { active: boolean })[];
}

/** 远端目录视图（/api/bridge/known）。 */
export interface CatalogView {
  ok: boolean;
  error?: string;
  count?: number;
  apps: CatalogApp[];
  /** 按 PC 分组的目录（多台 PC 同时接入时的主要视图）。 */
  pcs?: CatalogPc[];
}

/** 统一登录账号簿（/api/auth/accounts）。 */
export interface AccountsView {
  accounts: {
    key: string;
    label: string;
    userId?: string;
    email?: string;
    /** 有令牌但过期了。没有令牌的条目不进这个字段（那是 orphan）。 */
    expired: boolean;
    /** 没有令牌也没有账号信息的历史残留：切过去等于退出登录。 */
    orphan?: boolean;
    /** 有令牌且没过期，可以切过去。 */
    usable?: boolean;
    active: boolean;
  }[];
  activeKey: string;
}

/** 问候（/api/greet，演示用）。 */
export interface GreetingResult {
  greeting: string;
  name: string;
  count: number;
  at: string;
}
