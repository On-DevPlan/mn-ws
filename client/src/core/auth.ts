import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { URL } from 'node:url';

/**
 * client 半的统一登录：PKCE 授权码流程。
 *
 * ## 两种发起方式，同一套协议
 *
 *   · **CLI**（`mn-ws auth login`）：在**随机端口**起一次性回环监听，
 *     浏览器把授权码送回来，CLI 自己换 token。
 *   · **Web 面板**（面板里点「登录」）：在**面板自己的端口**上收码
 *     （路径固定 /callback），面板后端换 token。
 *
 * 两者用的是同一个 client_id（`mn-ws-client`），回调白名单是
 * `http://127.0.0.1:<任意端口>/callback` —— 端口通配、路径固定，主机与路径都严格受限。
 *
 * ⚠️ 上面那句「任意端口」在别处写成字面量会出事：端口通配的形态是
 * 「星号紧跟斜杠」，出现在**块注释里**会把注释提前闭合 ——
 * 文件后半截被当成代码，报一堆莫名其妙的语法错。mn-rt 真实踩过一次。
 *
 * ## 为什么 CLI 自己换 token（而不是交给 server 换）
 *
 * 交给 server 换需要 server 自己发起 authorize 并持有 PKCE verifier ——
 * 那就多一份 RP 会话（cookie/存储）要实现。CLI 自己换 token 只需登记
 * 回环通配（127.0.0.1 端口任意、路径固定 /callback）—— RFC 8252 给原生
 * 客户端的标准做法。
 */

/** CLI 侧回环回调路径。端口 0 让内核分配，再回填进 authorize 请求。 */
export const LOOPBACK_PATH = '/callback';

/** 等用户完成登录的时间上限（5 分钟）。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function b64url(buf: Buffer | string): string {
  return Buffer.from(buf as never).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 取「发起授权码流程时该用的 client_id」。
 *
 * 两端拆开之后：**server 半有它自己的身份**（mn-ws-server），而真正发起授权码
 * 流程的是 **client 半**（mn-ws-client）。server 半通过 /auth/oidc/config 把
 * 后者一并发布出来，所以新装的 client 半不需要额外配置 —— 与 mn-rt
 * 「server 告诉 client 用哪个 client_id」的做法一致，只是这里明确分成了两个身份。
 *
 * 回落 cfg.clientId：老的 server 只发布一个 client_id，那时的登录用的就是它。
 */
export function loginClientIdOf(cfg: { loginClientId?: string; clientId?: string } | null | undefined): string {
  return String((cfg && cfg.loginClientId) || (cfg && cfg.clientId) || '').trim();
}

/** 一次授权请求的 PKCE 参数与一次性参数。 */
export interface AuthRequest {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
  authorizeParams: Record<string, string>;
}

/**
 * 生成 PKCE 与一次性参数。
 *
 * 注意 state 只有**一个**值：authorizeParams 里的那个就是真正发出去的，
 * 也是回调回来后要比对的。曾经同时返回两个独立随机值，导致每次登录都必然
 * 报 state 不一致 —— 这里只留一份。
 */
export function createAuthRequest(redirectUri: string): AuthRequest {
  const verifier = b64url(crypto.randomBytes(32));
  // PKCE 的 challenge = BASE64URL(SHA256(verifier))，S256
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return {
    verifier,
    challenge,
    state,
    nonce: b64url(crypto.randomBytes(16)),
    authorizeParams: {
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    },
  };
}

/** 认证中心下发的公开参数（来自 server 半的 /auth/oidc/config）。 */
export interface IdpConfig {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  loginClientId?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopes?: string[];
  [k: string]: unknown;
}

/** 组 authorize URL。 */
export function buildAuthorizeUrl(cfg: IdpConfig, req: AuthRequest, { promptLogin = false } = {}): string {
  const authorizeUrl = new URL(cfg.authorizationEndpoint || `${cfg.issuer}/oauth2/auth`);
  authorizeUrl.searchParams.set('client_id', loginClientIdOf(cfg));
  authorizeUrl.searchParams.set('scope', (cfg.scopes || ['openid', 'profile', 'email']).join(' '));
  authorizeUrl.searchParams.set('state', req.state);
  authorizeUrl.searchParams.set('nonce', req.nonce);
  for (const [k, v] of Object.entries(req.authorizeParams)) authorizeUrl.searchParams.set(k, v);
  if (promptLogin) authorizeUrl.searchParams.set('prompt', 'login');
  return authorizeUrl.toString();
}

/** 回环监听器。 */
export interface Loopback {
  /** 起监听；port=0 让内核分配（CLI），port=N 用固定端口（面板）。 */
  start(): Promise<string>;
  wait(ms?: number): Promise<{ code: string; state: string }>;
  close(): void;
}

/**
 * 起一次性回环监听，等浏览器把 code 送回来。
 *
 * 只绑 127.0.0.1：绑 0.0.0.0 会让同网段任何人都能来抢这个 code。
 */
export function openLoopback({ port = 0 }: { port?: number } = {}): Loopback {
  let server: http.Server | undefined;
  let resolveFn: ((v: { code: string; state: string }) => void) | undefined;
  let rejectFn: ((e: Error) => void) | undefined;
  const got = new Promise<{ code: string; state: string }>((res, rej) => { resolveFn = res; rejectFn = rej; });

  return {
    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const u = new URL(req.url || '/', 'http://127.0.0.1');
          if (u.pathname !== LOOPBACK_PATH) { res.writeHead(404).end(); return; }
          const err = u.searchParams.get('error');
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end('<h3>授权未通过</h3><p>可以关闭这个页面了。</p>');
            rejectFn?.(new Error(`授权被拒绝：${err}`));
            return;
          }
          const code = u.searchParams.get('code');
          const state = u.searchParams.get('state');
          if (!code) { rejectFn?.(new Error('回调里没有 code')); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<h3>✅ 已收到授权</h3><p>可以关闭浏览器，回到终端了。</p>');
          resolveFn?.({ code, state: state || '' });
        });
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server?.address();
          const actual = typeof addr === 'object' && addr ? addr.port : port;
          resolve(`http://127.0.0.1:${actual}${LOOPBACK_PATH}`);
        });
      });
    },
    wait(ms: number = LOGIN_TIMEOUT_MS): Promise<{ code: string; state: string }> {
      return Promise.race([
        got,
        new Promise<never>((_, rej) => {
          const t = setTimeout(() => rej(new Error('登录超时（5 分钟未完成）')), ms);
          t.unref?.();
        }),
      ]);
    },
    close(): void {
      try { server?.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * 各平台打开浏览器的命令与参数。
 *
 * ── Windows 为什么绝不借道 `cmd /c start` ────────────────────────────────
 * 授权 URL 里全是 `&`。Node execFile 对不含空格的参数不加引号，命令行到达
 * cmd.exe 后 `&` 被**当成命令分隔符**：浏览器只收到第一个 `&` 之前的部分，
 * redirect_uri / code_challenge 全被切掉，报「redirect_uri 未在白名单内」。
 * rundll32 的 FileProtocolHandler 不经任何 shell 解析，命令行原样到达。
 */
export function openBrowserArgs(platform: string, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function openBrowser(url: string): void {
  const [cmd, args] = openBrowserArgs(process.platform, url);
  // spawn + detached + unref：开浏览器**不能**拖住 CLI（execFile 会等它退出）。
  // detached 让它脱离父进程，unref 让它不占着事件循环。
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', (e: Error) => {
    process.stderr.write(`自动打开浏览器失败（${e.message.split('\n')[0]}），请手动打开上面打印的授权地址\n`);
  });
  child.unref();
}

/** 一个 HTTP JSON 响应。 */
export interface JsonResponse {
  status: number;
  json: Record<string, unknown> | null;
  raw: string;
}

export async function getJson(url: string): Promise<JsonResponse> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: res.status, json, raw };
}

/** POST 一个 form（application/x-www-form-urlencoded）。 */
export async function postJson(url: string, { form }: { form: Record<string, string> }): Promise<JsonResponse> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  return { status: res.status, json, raw };
}

/** 登录的最终产物。 */
export interface LoginResult {
  userId?: string;
  email?: string;
  username?: string;
  nickname?: string;
  token?: string;
  tokenExpiresAt?: number;
  clientId?: string;
  deviceName?: string;
  /** --no-open 模式：只打印地址，没走完授权 */
  pending?: boolean;
  authorizeUrl?: string;
}

/** authLogin 的参数。 */
export interface AuthLoginOptions {
  serverHttp: string;
  clientId: string;
  deviceName?: string;
  /** 只打印地址不弹浏览器（SSH / 无桌面环境） */
  noOpen?: boolean;
  /** authorize 带 prompt=login（换人登录用） */
  promptLogin?: boolean;
  /** 面板场景：回环监听用面板自己的端口 */
  loopbackPort?: number;
  onUrl?: (url: string) => void;
}

/**
 * 起一次授权码流程。
 *
 * 拆成「起流程」与「收回调」两半，是因为**收回调的位置不一样**：
 *   · CLI：在**随机端口**另起一个一次性回环监听
 *   · 面板：回调落在**面板自己的 HTTP 服务器**上（/callback）
 * 协议部分（PKCE、state、换 token）两边完全一样，所以只写一份。
 *
 * @param cfg      认证中心参数（server 半的 /auth/oidc/config）
 * @param redirectUri 回调地址（必须在白名单内）
 */
export function beginOauth(
  cfg: IdpConfig,
  redirectUri: string,
  { promptLogin = false } = {},
): { authorizeUrl: string; req: AuthRequest } {
  const req = createAuthRequest(redirectUri);
  const authorizeUrl = buildAuthorizeUrl(cfg, req, { promptLogin });
  return { authorizeUrl, req };
}

/**
 * 收回调：用 code + verifier 换 access_token。
 *
 * state 不匹配只有两种可能：回调被串了，或有人在伪造一次登录完成。都必须中止。
 */
export async function finishOauth(
  cfg: IdpConfig,
  req: AuthRequest,
  callback: { code: string; state: string },
): Promise<{ accessToken: string; tokenType?: string; expiresIn?: number }> {
  if (callback.state !== req.state) throw new Error('state 不一致，已中止登录');
  const loginClientId = loginClientIdOf(cfg);
  if (!loginClientId) throw new Error('服务端未发布登录用的 client_id（loginClientId / clientId）');

  // CLI 自己换 token（公共客户端 + PKCE，无 secret）
  const tokRes = await postJson(cfg.tokenEndpoint || `${cfg.issuer}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      code: callback.code,
      client_id: loginClientId,
      redirect_uri: req.authorizeParams.redirect_uri || '',
      code_verifier: req.verifier,
    },
  });
  const tok = tokRes.json || {};
  if (!tokRes.status || tokRes.status >= 400 || !tok.access_token) {
    throw new Error(`换 token 失败：${String(tok.error || tokRes.raw || `HTTP ${tokRes.status}`)}`);
  }
  return {
    accessToken: String(tok.access_token),
    tokenType: tok.token_type ? String(tok.token_type) : undefined,
    expiresIn: typeof tok.expires_in === 'number' ? tok.expires_in : undefined,
  };
}

/** 拉取 server 半发布的认证中心参数。 */
export async function fetchIdpConfig(serverHttp: string): Promise<IdpConfig> {
  const base = serverHttp.replace(/\/+$/, '');
  if (!base) throw new Error('缺少服务端地址（--url 或配置文件）');
  const cfgRes = await getJson(`${base}/auth/oidc/config`);
  const cfg = (cfgRes.json || {}) as IdpConfig;
  if (!cfg.enabled) {
    throw new Error('服务端未开启统一登录（MN_WS_AUTH_ENABLED）。'
      + '旧用法仍可用：mn-ws --token <门禁token>');
  }
  if (!cfg.issuer || !cfg.clientId) {
    throw new Error(`服务端统一登录配置不完整：${JSON.stringify(cfg)}`);
  }
  return cfg;
}

/**
 * 完整登录一次（CLI 用）。
 *
 * @param opts.serverHttp  server 半的 HTTP 基址，如 http://1.94.101.189:7777
 * @param opts.clientId    本机稳定 clientId
 */
export async function authLogin(opts: AuthLoginOptions): Promise<LoginResult> {
  const base = opts.serverHttp.replace(/\/+$/, '');
  if (!base) throw new Error('缺少服务端地址（--url 或配置文件）');

  const cfg = await fetchIdpConfig(base);

  const lb = openLoopback({ port: opts.loopbackPort ?? 0 });
  const redirectUri = await lb.start();
  const { authorizeUrl, req } = beginOauth(cfg, redirectUri, { promptLogin: opts.promptLogin === true });

  if (opts.onUrl) opts.onUrl(authorizeUrl);
  if (opts.noOpen) {
    lb.close();
    return { pending: true, authorizeUrl };
  }
  openBrowser(authorizeUrl);

  let callback: { code: string; state: string };
  try {
    callback = await lb.wait();
  } finally {
    lb.close();
  }

  const tok = await finishOauth(cfg, req, callback);

  // ⑤ 换 mn-ws 自己的设备令牌
  const res = await verifyExchange({
    serverHttp: base,
    accessToken: tok.accessToken,
    clientId: opts.clientId,
    deviceName: opts.deviceName,
  });

  return { ...res, clientId: res.clientId || opts.clientId };
}

/**
 * 用 access_token 换 mn-ws 自己的设备令牌。
 *
 * 这一步是**跨机**的（CLI → 公网机），走的明文 HTTP 时中间人能看到
 * 那枚 access_token —— 它 10 分钟有效，但窗口内被截获就等于账号接管。
 * 所以部署侧必须前置 TLS（见 docs/DEPLOY.md 的「已知风险」）。
 */
export async function verifyExchange({
  serverHttp,
  accessToken,
  clientId,
  deviceName,
}: {
  serverHttp: string;
  accessToken: string;
  clientId: string;
  deviceName?: string;
}): Promise<LoginResult> {
  const res = await fetch(`${serverHttp.replace(/\/+$/, '')}/auth/verify`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ clientId, deviceName: deviceName || '' }),
  });
  const raw = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  if (!res.ok || !json || json.ok !== true) {
    throw new Error(`换设备令牌失败：${String((json && json.error) || raw || `HTTP ${res.status}`)}`);
  }
  return json as unknown as LoginResult;
}
