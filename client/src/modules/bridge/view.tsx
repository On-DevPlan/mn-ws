// 桥接视图：**client 半的管理面**。
//
// 这一页回答的是「这台桥现在什么状态、能桥什么」：
//   · 连接状态（连没连、注册了哪些 app、当前凭据是谁）
//   · 白名单（勾哪些应用；**没勾的一个都不桥**）
//   · 启停桥
//   · 远端目录（server 半那边哪些能路由）
//
// 面板上的每个按钮都对应一条 CLI 命令（页面底部亮出来）——
// 命令与按钮同源于一份 action 声明，不会出现「面板有、命令行没有」。
import { useCallback, useEffect, useState } from 'react';
import { CliHints } from '../../web/frontend/components/CliHints.js';
import { useStore } from '../../web/frontend/store.js';
import type { BridgeStatusView, BridgeAppsView, CatalogView } from './service.js';
import type { AccountsView } from '../auth/service.js';

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
        <div className="colhead">
          连接状态
          <span className="right muted">CLI 等价：<code>mn-ws status</code></span>
        </div>
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
        <div className="colhead">
          白名单
          <span className="right muted">
            CLI 等价：<code>mn-ws apps set --apps my-api,other=http://127.0.0.1:7800</code>
          </span>
        </div>
        <div style={{ padding: 12 }} className="stack">
          <div className="muted">
            只有勾上的应用会被桥。端口在监听 ≠ 可以桥 —— 白名单说了算，
            否则扫到端口就自动开桥等于把整台机器暴露出去。
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

      {/* 动态注册：把本机任意一个 HTTP 服务开放出来 */}
      <div className="card">
        <div className="colhead">
          动态注册
          <span className="right muted">
            CLI 等价：<code>mn-ws apps add my-api --port 9999</code>
          </span>
        </div>
        <div style={{ padding: 12 }} className="stack">
          <div className="muted">
            mn-ws 不认识任何具体服务 —— 要桥什么，由你在这儿登记：给它起一个**路由标识**
            （小写字母开头，只含小写字母/数字/连字符）和端口，它就进白名单，
            随注册帧上报给 server 半 —— 别的客户端从目录里看到之后，
            用 <code>X-Mn-Ws-App: &lt;名字&gt;</code> 就能打过来。
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
          <div className="colhead">
            远端目录
            <span className="right muted">CLI 等价：<code>mn-ws catalog</code></span>
          </div>
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
        <div className="colhead">
          账号
          <span className="right muted">
            CLI 等价：<code>mn-ws auth list</code> / <code>mn-ws auth switch &lt;账号&gt;</code>
          </span>
        </div>
        <div style={{ padding: 12 }} className="stack">
          {accounts.length === 0 ? (
            <div className="muted">本机还没有已存账号。登录一次：<code>mn-ws auth login</code></div>
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
