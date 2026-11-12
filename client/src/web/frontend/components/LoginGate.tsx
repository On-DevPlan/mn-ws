// 登录门禁：**未登录时整个面板不可用**。
//
// 为什么门禁在服务端、这里只负责「渲染」：
//   面板握着桥的凭据（能连 server、能改白名单）。门禁若只做在前端（藏个按钮），
//   任何本机进程照样能直接调 API —— 那等于没门。所以真正的判据在服务端
//   （runtime/api.ts 的 apiGate），这里只是把它呈现出来。
//
// 登录流程：点「登录」→ 服务端起一次 PKCE 流程并弹浏览器 → 浏览器把授权码
// 送回**面板自己的** /callback → 服务端换到设备令牌 → 本页轮询到已登录。
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client.js';

interface AuthStatus {
  loggedIn: boolean;
  userId?: string;
  email?: string;
  nickname?: string;
  expired: boolean;
  via: string;
}

/** 轮询间隔（毫秒）—— 授权在浏览器里完成，回来可能比一次请求晚。 */
const POLL_MS = 1200;

export default function LoginGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const s = await api<AuthStatus>('/api/auth/status');
      setStatus(s);
      return s;
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 未登录且流程已发起 → 轮询等回调
  useEffect(() => {
    if (status?.loggedIn || !busy) return undefined;
    const t = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [status?.loggedIn, busy, refresh]);

  async function startLogin() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login/start', { method: 'POST' });
      // 服务端已弹浏览器；这里开始轮询，等回调把登录态建起来
    } catch (e) {
      setError(String((e as { message?: string })?.message || e));
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="empty">
        <p>正在检查登录状态…</p>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  if (!status.loggedIn) {
    return (
      <div className="empty">
        <p>
          <strong>面板需要登录后才能用。</strong>
        </p>
        <p className="muted">
          面板握着这台桥的凭据（能连 server、能改白名单），所以门禁在服务端，
          不是藏个按钮而已。
        </p>
        <p>
          <button className="btn" disabled={busy} onClick={() => void startLogin()}>
            {busy ? '等待浏览器授权…' : '用统一登录进入'}
          </button>
        </p>
        <p className="muted">
          也可以先在命令行登录（<code>mn-ws auth login</code>）—— 面板会直接复用那份登录态。
        </p>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  return <>{children}</>;
}
