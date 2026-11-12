'use strict';

/**
 * 统一登录：`mn-ws auth login`。
 *
 * 流程与 mn-rt 的 `auth login` **完全同款**（全程零复制粘贴）：
 *   ① GET  <server>/auth/oidc/config     问服务端"认证中心在哪、用哪个 client"
 *   ② 本机 127.0.0.1:<随机端口> 起一次性监听，生成 PKCE，打开系统浏览器
 *   ③ 用户在认证中心登录 → 302 回本机监听 → 拿到 code
 *   ④ 用 code + verifier 直接在**认证中心**换 access_token（公共客户端，无 secret）
 *   ⑤ 带 Bearer 调 <server>/auth/verify → 换回 mn-ws 自己的设备令牌
 *   ⑥ 落盘到 ~/.mn-ws/config.json，之后 client / server 静默携带
 *
 * ── 为什么第 ④ 步由 CLI 自己换、而不是把 code 交给服务端换 ──────────────
 * 交给服务端换需要服务端自己发起 authorize 并持有 PKCE verifier —— 那就多一份
 * RP 会话（cookie/存储）要实现。CLI 自己换 token 则只需登记回环通配
 * （127.0.0.1 端口任意、路径固定 /callback）—— RFC 8252 给原生客户端的标准做法。
 *
 * ── 为什么不存 refresh_token ────────────────────────────────────────────
 * 第 ④ 步换到的 refresh_token 直接丢弃。CLI 真正需要长期持有的是第 ⑤ 步
 * 服务端签发的**设备令牌**——它可被服务端吊销，而 refresh_token 一旦落到
 * 每台机器的磁盘上，就是把「谁拿到谁可用 7 天」的凭据复制到 N 台机器。
 */

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { URL } = require('url');

/** CLI 侧回环回调地址。端口 0 让内核分配，再回填进 authorize 请求。 */
const LOOPBACK_PATH = '/callback';
/** 等用户完成登录的时间上限（5 分钟）。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 生成 PKCE 与一次性参数。
 *
 * 注意 state 只有**一个**值：authorizeParams 里的那个就是真正发出去的，
 * 也是回调回来后要比对的。曾经同时返回两个独立随机值，导致每次登录都必然
 * 报 state 不一致 —— 这里只留一份。
 */
function createAuthRequest(redirectUri) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return {
    verifier,
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

/**
 * 起一次性回环监听，等浏览器把 code 送回来。
 * 只绑 127.0.0.1：绑 0.0.0.0 会让同网段任何人都能来抢这个 code。
 */
function openLoopback() {
  let server;
  let resolveFn;
  let rejectFn;
  const got = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname !== LOOPBACK_PATH) { res.writeHead(404).end(); return; }
          const err = u.searchParams.get('error');
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              .end('<h3>授权未通过</h3><p>可以关闭这个页面了。</p>');
            rejectFn(new Error(`授权被拒绝：${err}`));
            return;
          }
          const code = u.searchParams.get('code');
          const state = u.searchParams.get('state');
          if (!code) { rejectFn(new Error('回调里没有 code')); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<h3>✅ 已收到授权</h3><p>可以关闭浏览器，回到终端了。</p>');
          resolveFn({ code, state });
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve(`http://127.0.0.1:${port}${LOOPBACK_PATH}`);
        });
      });
    },
    wait: (ms = LOGIN_TIMEOUT_MS) => Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('登录超时（5 分钟未完成）')), ms)
        .unref?.()),
    ]),
    close() { try { server && server.close(); } catch { /* ignore */ } },
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
function openBrowserArgs(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

function openBrowser(url) {
  const [cmd, args] = openBrowserArgs(process.platform, url);
  execFile(cmd, args, { detached: true, stdio: 'ignore' }, (e) => {
    if (e) {
      process.stderr.write(
        `自动打开浏览器失败（${e.message.split('\n')[0]}），请手动打开上面打印的授权地址\n`);
    }
  });
}

/** 向任意 URL 发 JSON / 表单请求并解析 JSON。 */
function postJson(urlStr, { body, headers = {}, form } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error(`非法地址: ${urlStr}`)); return; }
    const payload = form ? new URLSearchParams(form).toString() : JSON.stringify(body || {});
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 15_000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 就当原文 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** GET 一个 URL 并解析 JSON。 */
function getJson(urlStr, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error(`非法地址: ${urlStr}`)); return; }
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers,
      timeout: 15_000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 就当原文 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 取「发起授权码流程时该用的 client_id」。
 *
 * 两端拆开之后：**server 半有它自己的身份**（mn-ws-server），而真正发起授权码
 * 流程的是 **client 半**（mn-ws-client，本机 CLI 在回环上收码、自己做 PKCE 换 token）。
 * server 半通过 /auth/oidc/config 把后者一并发布出来，所以新装的 client 半
 * 不需要额外配置 —— 与 mn-rt「server 告诉 client 用哪个 client_id」的做法一致，
 * 只是这里明确分成了两个身份。
 *
 * 回落 cfg.clientId：老的 server 只发布一个 client_id，那时的登录用的就是它。
 */
function loginClientIdOf(cfg) {
  return String((cfg && cfg.loginClientId) || (cfg && cfg.clientId) || '').trim();
}

/** 组 authorize URL。 */
function buildAuthorizeUrl(cfg, req, { promptLogin = false } = {}) {
  const authorizeUrl = new URL(cfg.authorizationEndpoint || `${cfg.issuer}/oauth2/auth`);
  authorizeUrl.searchParams.set('client_id', loginClientIdOf(cfg));
  authorizeUrl.searchParams.set('scope', (cfg.scopes || ['openid', 'profile', 'email']).join(' '));
  authorizeUrl.searchParams.set('state', req.state);
  authorizeUrl.searchParams.set('nonce', req.nonce);
  for (const [k, v] of Object.entries(req.authorizeParams)) authorizeUrl.searchParams.set(k, v);
  if (promptLogin) authorizeUrl.searchParams.set('prompt', 'login');
  return authorizeUrl.toString();
}

/**
 * 用 access_token 换 mn-ws 自己的设备令牌。
 * @returns {{userId,email,username,nickname,token,tokenExpiresAt,clientId,deviceName}}
 */
async function verifyExchange({ serverHttp, accessToken, clientId, deviceName }) {
  const base = (serverHttp || '').replace(/\/+$/, '');
  const res = await postJson(`${base}/auth/verify`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: { clientId, deviceName },
  });
  const j = res.json || {};
  if (!res.status || res.status >= 400 || !j.token) {
    const err = new Error(j.error || res.raw || `HTTP ${res.status}`);
    err.code = j.code;
    throw err;
  }
  return {
    userId: j.userId || '',
    email: j.email || '',
    username: j.username || '',
    nickname: j.nickname || '',
    token: j.token,
    tokenExpiresAt: j.tokenExpiresAt || 0,
    clientId: j.clientId || clientId || '',
    deviceName: j.deviceName || deviceName || '',
  };
}

/**
 * 完整登录一次。
 * @param {object} opts
 * @param {string} opts.serverHttp
 * @param {string} opts.clientId
 * @param {string} [opts.deviceName]
 * @param {boolean} [opts.noOpen]      只打印地址不弹浏览器
 * @param {(url:string)=>void} [opts.onUrl]
 * @param {boolean} [opts.promptLogin]  authorize 带 prompt=login（换人登录用）
 */
async function authLogin(opts) {
  const base = (opts.serverHttp || '').replace(/\/+$/, '');
  if (!base) throw new Error('缺少服务端地址（--url 或配置文件）');

  const cfgRes = await getJson(`${base}/auth/oidc/config`);
  const cfg = cfgRes.json || {};
  if (!cfg.enabled) {
    throw new Error('服务端未开启统一登录（MN_WS_AUTH_ENABLED）。'
      + '旧用法仍可用：client --token <门禁token>');
  }
  if (!cfg.issuer || !cfg.clientId) {
    throw new Error(`服务端统一登录配置不完整：${JSON.stringify(cfg)}`);
  }
  // 登录用的是 **client 半** 的身份，不是 server 半的
  const loginClientId = loginClientIdOf(cfg);
  if (!loginClientId) {
    throw new Error('服务端未发布登录用的 client_id（loginClientId / clientId）');
  }

  const lb = openLoopback();
  const redirectUri = await lb.start();
  const req = createAuthRequest(redirectUri);

  const authorizeUrl = new URL(buildAuthorizeUrl(cfg, req, { promptLogin: opts.promptLogin === true }));

  if (opts.onUrl) opts.onUrl(authorizeUrl.toString());
  if (opts.noOpen) {
    lb.close();
    return { authorizeUrl: authorizeUrl.toString(), redirectUri, pending: true };
  }
  openBrowser(authorizeUrl.toString());

  let callback;
  try {
    callback = await lb.wait();
  } finally {
    lb.close();
  }
  // state 不匹配只有两种可能：回调被串了，或有人在伪造一次登录完成。都必须中止。
  if (callback.state !== req.state) throw new Error('state 不一致，已中止登录');

  // ④ CLI 自己换 token（公共客户端 + PKCE，无 secret）
  const tokRes = await postJson(cfg.tokenEndpoint || `${cfg.issuer}/oauth2/token`, {
    form: {
      grant_type: 'authorization_code',
      code: callback.code,
      client_id: loginClientId,
      redirect_uri: redirectUri,
      code_verifier: req.verifier,
    },
  });
  const tok = tokRes.json || {};
  if (!tokRes.status || tokRes.status >= 400 || !tok.access_token) {
    throw new Error(`换 token 失败：${tok.error || tokRes.raw || `HTTP ${tokRes.status}`}`);
  }

  // ⑤ 换 mn-ws 自己的设备令牌
  const res = await verifyExchange({
    serverHttp: base,
    accessToken: tok.access_token,
    clientId: opts.clientId,
    deviceName: opts.deviceName,
  });

  return { ...res, clientId: res.clientId || opts.clientId || '' };
}

module.exports = {
  authLogin,
  buildAuthorizeUrl,
  createAuthRequest,
  loginClientIdOf,
  openLoopback,
  openBrowser,
  getJson,
  postJson,
  b64url,
  LOOPBACK_PATH,
  LOGIN_TIMEOUT_MS,
};
