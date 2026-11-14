// 桥接视图：**client 半的管理面**。
//
// 这一页回答的是「这台桥现在什么状态、能桥什么」：
//   · 连接状态（连没连、注册了哪些 app、当前凭据是谁）
//   · 白名单（勾哪些应用；**没勾的一个都不桥**）
//   · 启停桥
//   · 远端目录（server 半那边哪些能路由）
//
// ── 为什么每个块都不再挂「CLI 等价」行 ──────────────────────────────────
//
// 改造前每个卡片右上角都挂一行「CLI 等价：mn-ws xxx」，加上页脚还有一整段
// 命令清单 —— 同一件事说两遍，还占了整屏最显眼的��置。
// 用户反馈：「具有开发性质的放到一个高级按钮里面即可，用户没必要认识 ws 认识 cli」。
// 现在命令表统一收到页脚的**高级**区（见 CliHints），默认折叠；
// 这一页只留用户真正要按的东西。
import { useCallback, useEffect, useState } from 'react';
import { CliHints } from '../components/CliHints.js';
import { useStore } from '../store.js';
import type { BridgeStatusView, BridgeAppsView, CatalogView, AccountsView } from '../api/view-types.js';

export default function BridgeView() {
  const { client } = useStore();
  const [status, setStatus] = useState<BridgeStatusView | null>(null);
  const [apps, setApps] = useState<BridgeAppsView | null>(null);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [accounts, setAccounts] = useState<AccountsView['accounts']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await client['bridge.status']({});
      const a = await client['bridge.apps']({});
      setStatus(s);
      setApps(a);
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    }
  }, [client]);

  const refreshAccounts = useCallback(async () => {
    try {
      const list = await client['auth.list']({});
      setAccounts(list.accounts);
    } catch {
      setAccounts([]);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void refreshAccounts();
    const t = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(t);
  }, [refresh, refreshAccounts]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await refreshAccounts();
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const configured = apps?.configured ?? [];
  const candidates = apps?.candidates ?? [];
  const favorites = apps?.favorites ?? [];
  const selected = new Set(configured.map((c) => c.app));

  // ── 动态注册表单 ──────────────────────────────────────────────────
  // 「运行时开放端口」：给本机任意一个 HTTP 服务起个名字和端口，它就进白名单，
  // 随注册帧上报给 server 半，别的客户端从目录里看到之后用 X-Mn-Ws-App 就能打过来。
  const [newName, setNewName] = useState('');
  const [newPort, setNewPort] = useState('');
  const [newTitle, setNewTitle] = useState('');

  async function addCustom() {
    const name = newName.trim();
    if (!name) { setError('要先给应用起个名字'); return; }
    const port = Number(newPort.trim());
    setBusy(true);
    setError('');
    try {
      const r = await client['bridge.apps.add']({
        name,
        port: Number.isFinite(port) && port > 0 ? port : undefined,
        title: newTitle.trim() || undefined,
      });
      if (!r.ok) { setError(r.error || '注册失败'); return; }
      setNewName(''); setNewPort(''); setNewTitle('');
      await refresh();
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeCustom(app: string) {
    setBusy(true);
    setError('');
    try {
      const r = await client['bridge.apps.remove']({ name: app });
      if (!r.ok) { setError(r.error || '移除失败'); return; }
      await refresh();
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 一键重新暴露一个用过的应用。
   *
   * 反复暴露同一个端口是最常见的动作，所以它不该要求用户重新敲
   * 「路由标识 + 端口」两个字段 —— 名字还得是合法路由标识，
   * 每次重敲都可能打错一个字符，然后只得到一句「名字不合法」。
   */
  async function reopen(app: string) {
    setBusy(true);
    setError('');
    try {
      const r = await client['bridge.apps.reopen']({ name: app });
      if (!r.ok) { setError(r.error || '重开失败'); return; }
      await refresh();
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(app: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(app); else next.delete(app);
    await run(() => client['bridge.whitelist.set']({ apps: [...next].join(',') }));
  }

  async function loadCatalog() {
    setBusy(true);
    try {
      const c = await client['bridge.catalog']({});
      setCatalog(c);
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const stateLabel: Record<string, string> = {
    idle: '未启动',
    connecting: '连接中',
    connected: '已连接（注册中）',
    registered: '已注册',
    reconnecting: '重连中',
    stopped: '已停止',
    shutdown: '服务端要求下线',
    error: '出错',
  };

  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="card">
        <div className="colhead">连接状态</div>
        <dl className="kv">
          <div className="kv-row">
            <dt>状态</dt>
            <dd>
              <strong>{status ? (stateLabel[status.state] || status.state) : '…'}</strong>
              {status?.retryInMs ? `（${Math.round(status.retryInMs / 1000)}s 后重试）` : ''}
              {status?.reason ? ` · ${status.reason}` : ''}
            </dd>
          </div>
          <div className="kv-row">
            <dt>server</dt>
            <dd>{status?.url || '…'}</dd>
          </div>
          <div className="kv-row">
            <dt>本机标识</dt>
            <dd>{status?.clientId || '…'}</dd>
          </div>
          <div className="kv-row">
            <dt>身份</dt>
            <dd>
              {status?.identity || '…'}
              {status?.loggedIn ? `（${status.via === 'cli' ? '复用 CLI 登录态' : '面板登录'}）` : ''}
            </dd>
          </div>
        </dl>
        <div className="toolbar" style={{ padding: 12 }}>
          <button className="btn" disabled={busy} onClick={() => void run(() => client['bridge.start']({}))}>
            起桥
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void run(() => client['bridge.stop']({}))}>
            停桥
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void loadCatalog()}>
            拉远端目录
          </button>
        </div>
        {error && <div className="bad" style={{ padding: '0 14px 12px' }}>{error}</div>}
      </div>

      <div className="card">
        <div className="colhead">白名单</div>
        <div style={{ padding: 12 }} className="stack">
          <div className="muted">
            只有勾上的会被桥。没勾的一个都不桥 —— 端口在监听 ≠ 可以桥。
          </div>

          {configured.length > 0 && (
            <div className="stack">
              <div className="muted">已桥接：</div>
              {configured.map((a) => (
                <label key={a.app} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked disabled readOnly />
                  <span>
                    {a.app} <span className="muted">{a.port ?? '—'}</span>{' '}
                    {a.title && a.title !== a.app ? <span className="muted">{a.title}</span> : null}{' '}
                    {a.alive ? <span className="tag">在监听</span> : <span className="tag warn">未运行</span>}
                    {a.custom ? <span className="tag">自定义</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}

          {candidates.length > 0 && (
            <div className="stack">
              <div className="muted">已登记、还没桥：</div>
              {candidates.map((a) => (
                <label key={a.app} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(a.app)}
                    disabled={busy}
                    onChange={(e) => { void toggle(a.app, e.target.checked); }}
                  />
                  <span>
                    {a.app} <span className="muted">{a.port ?? '—'}</span> {a.title}
                  </span>
                </label>
              ))}
            </div>
          )}

          {configured.length > 0 && (
            <div className="toolbar">
              {configured.map((a) => (
                a.custom ? (
                  <button
                    key={a.app}
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => { void removeCustom(a.app); }}
                  >
                    移除 {a.app}
                  </button>
                ) : (
                  <button
                    key={a.app}
                    className="btn small ghost"
                    disabled={busy}
                    onClick={() => { void toggle(a.app, false); }}
                  >
                    取消 {a.app}
                  </button>
                )
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 常用：用过就能一键重开，不必重新敲路由标识与端口 */}
      {favorites.length > 0 && (
        <div className="card">
          <div className="colhead">常用</div>
          <div style={{ padding: 12 }} className="stack">
            <div className="muted">点一下就能重新暴露，不用再填名字和端口。</div>
            <div className="toolbar">
              {favorites.map((f) => (
                <button
                  key={f.name}
                  className="btn small ghost"
                  disabled={busy}
                  title={`${f.base}`}
                  onClick={() => { void reopen(f.name); }}
                >
                  {f.title ? f.title : f.name}
                  <span className="muted"> {f.base.replace(/^https?:\/\/[^/]+/, '')}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 动态注册：把本机任意一个 HTTP 服务开放出来 */}
      <div className="card">
        <div className="colhead">开放一个端口</div>
        <div style={{ padding: 12 }} className="stack">
          <div className="muted">
            给本机的 HTTP 服务起个名字和端口，它就进白名单，别的设备就能打过来。
          </div>
          <div className="toolbar">
            <input
              value={newName}
              placeholder="路由标识，如 my-api"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void addCustom(); } }}
            />
            <input
              value={newPort}
              placeholder="端口，如 9999"
              onChange={(e) => setNewPort(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void addCustom(); } }}
            />
            <input
              value={newTitle}
              placeholder="显示名（可选）"
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void addCustom(); } }}
            />
            <button className="btn" disabled={busy} onClick={() => { void addCustom(); }}>
              注册
            </button>
          </div>
          {configured.filter((a) => a.custom).length > 0 && (
            <div className="muted">
              已注册的自定义应用：
              {configured.filter((a) => a.custom).map((a) => ` ${a.app}(${a.port ?? '?'})`).join('')}
            </div>
          )}
        </div>
      </div>

      {catalog && (
        <div className="card">
          <div className="colhead">远端目录</div>
          {catalog.ok ? (
            <>
              {/* 按 PC 分组：多台机器同时接入时，先看「哪台电脑」，再看它上面的应用 */}
              {catalog.pcs && catalog.pcs.length > 0 ? (
                catalog.pcs.map((pc) => (
                  <div key={pc.bridgeId} style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      {pc.name} <span className="muted">{pc.bridgeId}</span>
                    </div>
                    {pc.apps.length === 0 ? (
                      <div className="muted">这台电脑没有登记应用</div>
                    ) : (
                      <dl className="kv">
                        {pc.apps.map((a) => (
                          <div className="kv-row" key={a.app}>
                            <dt>{a.app}</dt>
                            <dd>
                              {a.title} <span className="muted">{a.port ?? '—'}</span>
                              {/* 撞名被顶替时要说清楚：看得见，但路由不到这一台 */}
                              {!a.active && <span className="tag warn">路由在别的 PC 上</span>}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                ))
              ) : (
                <dl className="kv">
                  {catalog.apps.map((a) => (
                    <div className="kv-row" key={`${a.bridgeId}/${a.app}`}>
                      <dt>{a.app}</dt>
                      <dd>
                        {a.title} <span className="muted">{a.port ?? '—'}</span> · {a.pcName || a.bridgeId}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          ) : (
            <div className="bad" style={{ padding: 14 }}>拉目录失败：{catalog.error}</div>
          )}
        </div>
      )}

      <div className="card">
        <div className="colhead">账号</div>
        <div style={{ padding: 12 }} className="stack">
          {accounts.length === 0 ? (
            <div className="muted">本机还没有已存账号。</div>
          ) : (
            <>
              {accounts.map((a) => (
                <div className="toolbar" key={a.key}>
                  <span>
                    {a.label}
                    {a.active ? <span className="tag">当前</span> : null}
                    {a.expired ? <span className="tag warn">已过期</span> : null}
                  </span>
                  {!a.active && (
                    <button
                      className="btn small ghost"
                      disabled={busy}
                      onClick={() => { void run(() => client['auth.switch']({ account: a.key })); }}
                    >
                      切到它
                    </button>
                  )}
                </div>
              ))}
              <div className="toolbar">
                <button
                  className="btn small ghost"
                  disabled={busy}
                  onClick={() => { void run(() => client['auth.logout']({})); }}
                >
                  退出当前账号
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <CliHints module="bridge" />
    </div>
  );
}
