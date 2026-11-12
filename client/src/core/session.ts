import {
  beginOauth, finishOauth, fetchIdpConfig, openBrowser,
  verifyExchange, type AuthRequest, type IdpConfig,
} from './auth.js';
import {
  listAccounts, saveAuthAccount, withAccounts, readConfigFile, isExpired,
  type ClientConfig,
} from './config.js';

/**
 * 面板的登录态。
 *
 * ## 「必须登录才能用」到底指什么
 *
 * 面板跑在 127.0.0.1 上，但它**握着桥的凭据** —— 能连 server、能改白名单。
 * 所以「打开就能用」等于「任何能访问这个端口的东西都能用」。
 *
 * 门禁因此落在**服务端的登录态**上：
 *   · 没有有效登录态 → 所有业务 API 回 401，前端渲染登录页
 *   · 有有效登录态 → 放行
 *
 * 两种拿登录态的方式（按优先级）：
 *   1. **复用 CLI 的设备令牌** —— 本机 `mn-ws auth login` 存下来的那一份。
 *      面板启动时读账号簿，有未过期的设备令牌就直接进入登录态（via=cli）。
 *      这样「命令行登一次，面板直接能用」，不必登两遍。
 *   2. **面板里现登** —— 前端点「登录」→ 弹浏览器 → PKCE 回环回调到
 *      面板自己的 `/callback` → 换到设备令牌 → 存进账号簿（via=panel）。
 *
 * 凭据一律存在**服务端**，浏览器页面自己不发凭据 ——
 * 页面里没有任何可以泄漏的令牌。
 */

/** 面板当前的登录态。 */
export interface PanelSession {
  loggedIn: boolean;
  userId?: string;
  email?: string;
  nickname?: string;
  deviceToken?: string;
  expiresAt?: number;
  /** 登录态的来源：复用 CLI / 面板里现登 / 没有 */
  via: 'cli' | 'panel' | 'none';
}

/** 一次进行中的面板登录。 */
interface PendingLogin {
  cfg: IdpConfig;
  req: AuthRequest;
  serverHttp: string;
  clientId: string;
  deviceName: string;
}

/** 设备令牌是否已过期（实现在 core/config.ts，与账号簿同源）。 */
export { isExpired };

export class SessionManager {
  session: PanelSession = { loggedIn: false, via: 'none' };
  private pending: PendingLogin | null = null;

  constructor(private cfg: ClientConfig) {}

  /**
   * 复用 CLI 已存的设备令牌。
   *
   * 读的是**激活账号**那一条：CLI 切了账号（auth switch），面板跟着切，
   * 不然会出现「命令行是 A、面板是 B」的分裂状态。
   */
  adoptFromAccountStore(): boolean {
    const raw = readConfigFile();
    const view = withAccounts(raw);
    const active = view.activeAccountKey ? view.accounts[view.activeAccountKey] : undefined;
    const entry = active || listAccounts(view)[0]?.entry;
    if (!entry || !entry.deviceToken || isExpired(entry)) return false;
    this.session = {
      loggedIn: true,
      userId: entry.userId,
      email: entry.email,
      nickname: entry.nickname,
      deviceToken: entry.deviceToken,
      expiresAt: entry.expiresAt,
      via: 'cli',
    };
    return true;
  }

  /** 当前登录态（对外只给必要字段）。 */
  snapshot(): { loggedIn: boolean; userId?: string; email?: string; nickname?: string; via: string } {
    return {
      loggedIn: this.session.loggedIn,
      userId: this.session.userId,
      email: this.session.email,
      nickname: this.session.nickname,
      via: this.session.via,
    };
  }

  /** 当前用的凭据（注册到 server 半时用）。 */
  credential(): string {
    return this.session.deviceToken || this.cfg.token;
  }

  /**
   * 面板里点「登录」：起一次授权码流程并弹浏览器。
   *
   * 回调地址是**面板自己的** `http://127.0.0.1:<port>/callback` ——
   * go-ah 里 mn-ws-client 的回调白名单是「127.0.0.1 + 任意端口 + /callback」，
   * 端口通配、路径固定，所以面板端口运行时怎么选都能回调。
   */
  async startLogin(panelPort: number): Promise<{ authorizeUrl: string }> {
    if (this.pending) throw new Error('已有一个登录在进行中');
    const serverHttp = this.cfg.serverHttp;
    const cfg = await fetchIdpConfig(serverHttp);
    const redirectUri = `http://127.0.0.1:${panelPort}/callback`;
    const { authorizeUrl, req } = beginOauth(cfg, redirectUri);
    this.pending = {
      cfg,
      req,
      serverHttp,
      clientId: this.cfg.clientId,
      deviceName: this.cfg.deviceName,
    };
    openBrowser(authorizeUrl);
    return { authorizeUrl };
  }

  /**
   * 面板的 `/callback` 路由调用它：收回调 → 换 access_token → 换设备令牌。
   */
  async completeLogin(code: string, state: string): Promise<PanelSession> {
    const pending = this.pending;
    if (!pending) throw new Error('没有进行中的登录（可能已超时或重复回调）');
    this.pending = null;

    const tok = await finishOauth(pending.cfg, pending.req, { code, state });
    const res = await verifyExchange({
      serverHttp: pending.serverHttp,
      accessToken: tok.accessToken,
      clientId: pending.clientId,
      deviceName: pending.deviceName,
    });

    const entry = {
      userId: res.userId,
      email: res.email,
      username: res.username,
      nickname: res.nickname,
      deviceToken: res.token,
      expiresAt: res.tokenExpiresAt,
      deviceName: res.deviceName || pending.deviceName,
      clientId: res.clientId || pending.clientId,
      url: this.cfg.url,
      serverHttp: this.cfg.serverHttp,
      loginAt: Date.now(),
    };
    saveAuthAccount({ entry, setActive: true });

    this.session = {
      loggedIn: true,
      userId: res.userId,
      email: res.email,
      nickname: res.nickname,
      deviceToken: res.token,
      expiresAt: res.tokenExpiresAt,
      via: 'panel',
    };
    return this.session;
  }

  /** 登录失败/超时后清掉进行中的流程。 */
  cancelLogin(): void {
    this.pending = null;
  }

  /** 清除登录态（logout 用）。 */
  reset(): void {
    this.session = { loggedIn: false, via: 'none' };
    this.pending = null;
  }
}
