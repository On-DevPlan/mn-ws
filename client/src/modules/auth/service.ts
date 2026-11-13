import { authLogin } from '../../core/auth.js';
import type { MnWsController } from '../../core/controller.js';
import {
  clearAuthCredentials, labelOf, listAccounts, readConfigFile, saveAuthAccount,
  switchActiveAccount, withAccounts, isExpired,
  type AccountEntry,
} from '../../core/config.js';
/** 登录结果视图。 */
export interface LoginView {
  ok: boolean;
  /** 流程已发起但还没走完（--no-open 只打印地址；面板路径等回调） */
  pending: boolean;
  /** 发起位置：cli / panel */
  via?: 'cli' | 'panel';
  authorizeUrl?: string;
  userId?: string;
  email?: string;
  nickname?: string;
  clientId?: string;
  expiresAt?: number;
  error?: string;
}

/** 账号簿视图。 */
export interface AccountsView {
  accounts: { key: string; label: string; userId?: string; email?: string; expired: boolean; active: boolean }[];
  activeKey: string;
}

/**
 * 登录。
 *
 * 两种发起位置：
 *   · **CLI**（transport=cli）：自己起一个随机端口的回环监听，弹浏览器，收码，换 token。
 *   · **面板**（transport=http）：起流程后**立刻返回**（不阻塞 HTTP 请求），
 *     回调落在面板自己的 /callback —— 面板端口是运行时选的，所以回环必须用
 *     面板自己的端口，不能另起一个（另起的端口浏览器回不去）。
 *
 * `--no-open` 只打印授权地址、**不写登录态**（半途而废的登录不该留下空账号）。
 * 完整走完时：设备令牌落进账号簿并激活，面板的登录态同步更新。
 */
export async function login(
  c: MnWsController,
  opts: { newAccount?: boolean; noOpen?: boolean; transport?: string },
): Promise<LoginView> {
  const cfg = c.cfg;

  // ── 面板路径：起流程就返回，等浏览器回调到面板的 /callback ──
  if (opts.transport === 'http') {
    try {
      const { authorizeUrl } = await c.session.startLogin(c.panelPort);
      return { ok: false, pending: true, authorizeUrl, via: 'panel' };
    } catch (e) {
      return { ok: false, pending: false, error: (e as Error).message };
    }
  }

  try {
    const res = await authLogin({
      serverHttp: cfg.serverHttp,
      clientId: cfg.clientId,
      deviceName: cfg.deviceName,
      noOpen: opts.noOpen === true,
      promptLogin: opts.newAccount === true,
    });

    if (res.pending) {
      // 只打印地址：不碰账号簿，不碰面板登录态
      return { ok: false, pending: true, authorizeUrl: res.authorizeUrl, via: 'cli' };
    }

    const entry: AccountEntry = {
      userId: res.userId,
      email: res.email,
      username: res.username,
      nickname: res.nickname,
      deviceToken: res.token,
      expiresAt: res.tokenExpiresAt,
      deviceName: res.deviceName || cfg.deviceName,
      clientId: res.clientId || cfg.clientId,
      url: cfg.url,
      serverHttp: cfg.serverHttp,
      loginAt: Date.now(),
    };
    saveAuthAccount({ entry, setActive: true });

    // 面板的登录态跟着更新（它读的是同一份账号簿）
    c.session.adoptFromAccountStore();

    return {
      ok: true,
      pending: false,
      userId: res.userId,
      email: res.email,
      nickname: res.nickname,
      clientId: res.clientId,
      expiresAt: res.tokenExpiresAt,
      via: 'cli',
    };
  } catch (e) {
    return { ok: false, pending: false, error: (e as Error).message };
  }
}

/** 账号簿。 */
export function listAccountsView(c: MnWsController): AccountsView {
  const view = withAccounts(readConfigRaw(c));
  return {
    activeKey: view.activeAccountKey,
    accounts: listAccounts(view).map(({ key, entry }) => ({
      key,
      label: labelOf(entry),
      userId: entry.userId,
      email: entry.email,
      expired: isExpired(entry),
      active: key === view.activeAccountKey,
    })),
  };
}

/** 切换当前生效账号。 */
export function switchAccount(c: MnWsController, target: string): {
  ok: boolean; changed: boolean; key?: string; label?: string; error?: string;
} {
  try {
    const r = switchActiveAccount(target, { defaultClientId: c.cfg.clientId });
    if (!r.changed && !r.key) {
      return { ok: false, changed: false, error: '需要指定账号（序号 / 邮箱 / 用户名 / 昵称）' };
    }
    c.cfg.token = r.entry.deviceToken || '';
    c.cfg.clientId = r.entry.clientId || c.cfg.clientId;
    c.cfg.url = r.entry.url || c.cfg.url;
    c.cfg.serverHttp = r.entry.serverHttp || c.cfg.serverHttp;
    c.session.adoptFromAccountStore();
    return { ok: true, changed: r.changed, key: r.key, label: labelOf(r.entry) };
  } catch (e) {
    return { ok: false, changed: false, error: (e as Error).message };
  }
}

/** 当前身份。 */
export function authStatus(c: MnWsController): {
  loggedIn: boolean; userId?: string; email?: string; nickname?: string;
  clientId: string; serverHttp: string; expiresAt?: number; expired: boolean; via: string;
} {
  const sess = c.session.snapshot();
  const view = withAccounts(readConfigRaw(c));
  const active = view.activeAccountKey ? view.accounts[view.activeAccountKey] : undefined;
  return {
    loggedIn: sess.loggedIn,
    userId: sess.userId,
    email: sess.email,
    nickname: sess.nickname,
    clientId: c.cfg.clientId,
    serverHttp: c.cfg.serverHttp,
    expiresAt: active?.expiresAt,
    expired: isExpired(active),
    via: sess.via,
  };
}

/** 清除登录凭据。 */
export function logout(c: MnWsController, all: boolean): { ok: boolean; remaining: number; error?: string } {
  try {
    const r = clearAuthCredentials({ all });
    c.cfg.token = '';
    c.session.reset();
    return { ok: true, remaining: r.remaining };
  } catch (e) {
    return { ok: false, remaining: 0, error: (e as Error).message };
  }
}

// ---- 渲染 ----

export function renderLogin(r: LoginView): string {
  if (r.pending) {
    if (r.via === 'panel') {
      return [
        '已发起登录，浏览器会打开授权页；在那里完成授权后会跳回本面板。',
        r.authorizeUrl ? `  ${r.authorizeUrl}` : '',
      ].filter(Boolean).join('\n');
    }
    return [
      '已打印授权地址，未继续登录（--no-open 只做这一步）',
      `  ${r.authorizeUrl || ''}`,
      '在浏览器里完成授权后，再执行 mn-ws auth login（不带 --no-open）换回设备令牌',
    ].join('\n');
  }
  if (!r.ok) return `登录失败：${r.error || '未知原因'}`;
  const days = r.expiresAt ? Math.round((r.expiresAt - Date.now()) / 86400000) : null;
  return [
    `✓ 登录成功：${r.nickname || r.email || r.userId || ''}`,
    r.email ? `  邮箱    ${r.email}` : '',
    `  本机标识 ${r.clientId || ''}`,
    days !== null ? `  设备令牌有效期约 ${days} 天` : '',
  ].filter(Boolean).join('\n');
}

export function renderList(r: AccountsView): string {
  if (!r.accounts.length) return '本机还没有已存账号：先执行 mn-ws auth login';
  const lines = [`本机已存 ${r.accounts.length} 个账号`];
  for (const a of r.accounts) {
    const mark = a.active ? '（当前）' : '';
    const exp = a.expired ? ' · 已过期' : '';
    lines.push(`  ${a.key.padEnd(24)} ${a.label}${mark}${exp}`);
  }
  lines.push('切换：mn-ws auth switch <序号或账号>');
  return lines.join('\n');
}

export function renderSwitch(r: { ok: boolean; changed: boolean; key?: string; label?: string; error?: string }): string {
  if (!r.ok) return `切换失败：${r.error || ''}`;
  return r.changed ? `已切换到：${r.label || r.key}` : '当前账号没变';
}

export function renderStatus(r: {
  loggedIn: boolean; userId?: string; email?: string; nickname?: string;
  clientId: string; serverHttp: string; expired: boolean; via: string;
}): string {
  const lines = ['当前身份'];
  if (r.loggedIn) {
    lines.push(`  ${r.nickname || r.email || r.userId || '已登录'}（${r.via === 'cli' ? '复用 CLI 登录态' : '面板登录'}）`);
    if (r.email) lines.push(`  邮箱    ${r.email}`);
  } else {
    lines.push('  未登录：用静态门禁 token');
  }
  lines.push(`  本机标识 ${r.clientId}`);
  lines.push(`  server    ${r.serverHttp}`);
  if (r.expired) lines.push('  ! 账号的设备令牌已过期：重新执行 mn-ws auth login');
  return lines.join('\n');
}

export function renderLogout(r: { ok: boolean; remaining: number; error?: string }): string {
  if (!r.ok) return `清除失败：${r.error || ''}`;
  return r.remaining ? `已清除当前账号的登录凭据（还剩 ${r.remaining} 个账号）` : '已清空本机登录凭据';
}

// ---- 小工具 ----

function readConfigRaw(_c: MnWsController): Record<string, unknown> {
  // 直接读配置文件（账号簿的唯一来源），不走 loadClientConfig —— 那个会补默认值
  return readConfigFile();
}
