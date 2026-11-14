//! 登录态：与统一登录平台（go-ah / auth-hub）打交道。
//!
//! ## 这一层到底做什么
//!
//! **不**在 App/客户端保存认证中心的 access_token / refresh_token ——
//! 那两张票指向整个平台的身份，落到磁盘上等于交出账号。
//!
//! 它做的是：
//!   1. 用**登录态**（idp_session Cookie）为 mn-ws-client 铸一枚授权码
//!      （authorize + consent 都在服务端侧做，不弹浏览器）
//!   2. 把 code + PKCE verifier 交给 **mn-ws server 半**的 `/auth/oidc/callback`
//!   3. 拿回 **mn-ws 自己签的**令牌（设备令牌）
//!
//! 换码在 server 半做（那边用 client 半的身份去认证中心换），
//! 所以认证中心的票**一次都不出服务端**。
//!
//! ## 设备令牌
//!
//! server 半签发的 HS256 JWT：90 天有效期、带 jti（可单独吊销）。
//! 本机只保存它，不保存认证中心的任何东西。

use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Digest;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// 设备令牌有效期（秒）。与 server 半的 `DEVICE_TOKEN_TTL_SEC` 一致。
pub const DEVICE_TOKEN_TTL_SEC: i64 = 90 * 24 * 3600;

/// PKCE 的一对值。
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
    pub nonce: String,
}

impl Pkce {
    /// 生成一组 PKCE 值。
    ///
    /// challenge = BASE64URL(SHA256(verifier))，即 RFC 7636 的 S256。
    pub fn generate() -> Pkce {
        let mut v = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut v);
        let verifier = URL_SAFE_NO_PAD.encode(v);

        let mut s = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut s);
        let state = URL_SAFE_NO_PAD.encode(s);
        let mut n = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut n);
        let nonce = URL_SAFE_NO_PAD.encode(n);

        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Pkce {
            verifier,
            challenge,
            state,
            nonce,
        }
    }
}

/// base64url（无 padding）的 SHA-256。
pub fn sha256_b64(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(data))
}

/// 签一个 HS256 JWT（服务端同款算法：HS256 + base64url 无 padding）。
///
/// 手写而不是引 JWT 库：只需要 HS256 这一种算法，
/// 而引库会带进一整条供应链（这与 mn-rt server 的 auth.js 同一个理由）。
pub fn sign_hs256(payload: &Value, secret: &[u8]) -> String {
    let header = json!({"alg": "HS256", "typ": "JWT"});
    let h = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap_or_default());
    let p = URL_SAFE_NO_PAD.encode(serde_json::to_vec(payload).unwrap_or_default());
    let signing_input = format!("{h}.{p}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC 接受任意长度的密钥");
    mac.update(signing_input.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{sig}")
}

/// 验一个 HS256 JWT 的签名。返回 payload（签名不对返回 None）。
///
/// **常量时间比较**：比的是「能不能冒充某个用户的一台桥」。
pub fn verify_hs256(token: &str, secret: &[u8]) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(signing_input.as_bytes());
    let want = mac.finalize().into_bytes();
    let got = URL_SAFE_NO_PAD.decode(parts[2]).ok()?;
    if got.len() != want.len() {
        return None;
    }
    // 常量时间比较（逐字节 XOR 累积，避免早退泄露信息）
    let mut diff = 0u8;
    for (a, b) in got.iter().zip(want.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return None;
    }
    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice(&payload_bytes).ok()
}

/// 认证中心的公开配置（从 server 半的 /auth/oidc/config 取）。
#[derive(Debug, Clone, Default)]
pub struct IdpConfig {
    pub enabled: bool,
    pub issuer: String,
    pub client_id: String,
    pub login_client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub idp_available: bool,
}

/// 从 server 半的公开配置里读认证参数。
pub async fn fetch_idp_config(server_http: &str) -> Result<IdpConfig, String> {
    let base = server_http.trim_end_matches('/');
    if base.is_empty() {
        return Err("缺少服务端地址".into());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/auth/oidc/config"))
        .send()
        .await
        .map_err(|e| format!("连不上 {base}: {e}"))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON: {e}"))?;
    let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let scopes = v
        .get("scopes")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let cfg = IdpConfig {
        enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        issuer: g("issuer"),
        client_id: g("clientId"),
        login_client_id: g("loginClientId"),
        redirect_uri: g("redirectUri"),
        scopes,
        authorization_endpoint: g("authorizationEndpoint"),
        token_endpoint: g("tokenEndpoint"),
        idp_available: v.get("idpAvailable").and_then(|x| x.as_bool()).unwrap_or(false),
    };
    if !cfg.enabled {
        return Err(
            "服务端未开启统一登录（MN_WS_AUTH_ENABLED）。旧用法仍可用：mn-ws --token <门禁token>"
                .into(),
        );
    }
    if cfg.issuer.is_empty() || cfg.client_id.is_empty() {
        return Err(format!("服务端统一登录配置不完整：{v}"));
    }
    Ok(cfg)
}

/// 发起授权码流程时该用的 client_id。
///
/// 两端拆开之后：**server 半有它自己的身份**（mn-ws-server），而真正发起
/// 授权码流程的是 **client 半**（mn-ws-client）。server 半通过 /auth/oidc/config
/// 把后者一并发布出来，所以新装的 client 半不需要额外配置。
///
/// 回落 `client_id`：老的 server 只发布一个 client_id，那时的登录用的就是它。
pub fn login_client_id_of(cfg: &IdpConfig) -> String {
    if !cfg.login_client_id.trim().is_empty() {
        return cfg.login_client_id.trim().to_string();
    }
    cfg.client_id.trim().to_string()
}

/// 组 authorize URL。
///
/// 与 TS 版 `buildAuthorizeUrl` 逐条对齐：参数用 `searchParams.set`
/// （同名覆盖，不追加），`scope` 是空格分隔的多个值。
pub fn build_authorize_url(
    cfg: &IdpConfig,
    pkce: &Pkce,
    redirect_uri: &str,
    prompt_login: bool,
) -> String {
    let endpoint = if cfg.authorization_endpoint.is_empty() {
        format!("{}/oauth2/auth", cfg.issuer)
    } else {
        cfg.authorization_endpoint.clone()
    };
    let scopes = if cfg.scopes.is_empty() {
        "openid profile email".to_string()
    } else {
        cfg.scopes.join(" ")
    };
    let client_id = login_client_id_of(cfg);
    let mut out = format!(
        "{endpoint}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&nonce={}&code_challenge={}&code_challenge_method=S256",
        urlencode(&client_id),
        urlencode(redirect_uri),
        urlencode(&scopes),
        urlencode(&pkce.state),
        urlencode(&pkce.nonce),
        urlencode(&pkce.challenge),
    );
    if prompt_login {
        out.push_str(&format!("&prompt={}", urlencode("login")));
    }
    out
}

/// 收回调：用 code + verifier 换 access_token。
///
/// state 不匹配只有两种可能：回调被串了，或有人在伪造一次登录完成。都必须中止。
pub async fn finish_oauth(
    cfg: &IdpConfig,
    pkce: &Pkce,
    code: &str,
    state: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    if state != pkce.state {
        return Err("state 不一致，已中止登录".into());
    }
    let client_id = login_client_id_of(cfg);
    if client_id.is_empty() {
        return Err("服务端未发布登录用的 client_id（loginClientId / clientId）".into());
    }
    let endpoint = if cfg.token_endpoint.is_empty() {
        format!("{}/oauth2/token", cfg.issuer)
    } else {
        cfg.token_endpoint.clone()
    };
    // 表单编码（公共客户端 + PKCE，**不发 client_secret**）。
    let form = format!(
        "grant_type=authorization_code&code={}&client_id={}&redirect_uri={}&code_verifier={}",
        urlencode(code),
        urlencode(&client_id),
        urlencode(redirect_uri),
        urlencode(&pkce.verifier),
    );
    let client = reqwest::Client::new();
    let resp = client
        .post(&endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|e| format!("换 token 失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let tok: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let access_token = tok
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if status >= 400 || access_token.is_empty() {
        let err = tok.get("error").and_then(|v| v.as_str()).unwrap_or("");
        return Err(if err.is_empty() {
            format!("换 token 失败：{text}")
        } else {
            format!("换 token 失败：{err}")
        });
    }
    Ok(access_token)
}

/// 用 access_token 换 mn-ws 自己的设备令牌。
///
/// 这一步是**跨机**的（client → 公网机），走的明文 HTTP 时中间人能看到
/// 那枚 access_token —— 它 10 分钟有效，但窗口内被截获就等于账号接管。
/// 所以部署侧必须前置 TLS（见 docs/DEPLOY.md 的「已知风险」）。
pub async fn verify_exchange(
    server_http: &str,
    access_token: &str,
    client_id: &str,
    device_name: &str,
) -> Result<Value, String> {
    let base = server_http.trim_end_matches('/');
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/auth/verify"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&json!({ "clientId": client_id, "deviceName": device_name }))
        .send()
        .await
        .map_err(|e| format!("换设备令牌失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status >= 400 || v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("");
        return Err(if err.is_empty() {
            format!("换设备令牌失败：{text}")
        } else {
            format!("换设备令牌失败：{err}")
        });
    }
    Ok(v)
}

/// 客户端发起授权码流程时该用的回调地址：**本机回环 + `/callback`**。
///
/// 为什么不沿用 `/auth/oidc/config` 发布的 `redirectUri`：那是 **server 半自己** 的回调
/// （`http://127.0.0.1:7777/auth/callback`），在认证中心登记在 `mn-ws-server` 名下。
/// 白名单是按 client 分开的 —— `mn-ws-client` 只许 `http://127.0.0.1:<任意端口>/callback`，
/// 所以拿服务端那个地址配 `client_id=mn-ws-client` 会被当场判
/// 「redirect_uri 未在客户端注册白名单内」（400，连登录页都不给）。
/// 就算放行也没用：端口被钉死在 7777，而 CLI 监听的是内核刚分配的随机端口，code 收不到。
fn client_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

/// 登录统一登录平台。
///
/// 流程（与 TS 版 `client/src/core/session.ts` 同款）：
///   1. 拿 server 半的公开配置
///   2. 在**本机回环**起一个一次性 HTTP 监听，收浏览器回调
///   3. 打开浏览器到 authorize URL
///   4. 收到 code → 交给 server 半的 /auth/oidc/callback 换设备令牌
///   5. 令牌落盘到 ~/.mn-ws/config.json 的账号簿
///
/// 为什么**必须**在 server 半换码：认证中心那张 access_token 一旦流经本机，
/// 截获即等于账号接管。
pub async fn login(cfg: &serde_json::Map<String, Value>) -> i32 {
    let server_http = cfg
        .get("serverHttp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    if server_http.is_empty() {
        eprintln!("缺少服务端地址（serverHttp）—— 先用 `mn-ws auth login` 走一遍配置。");
        return 1;
    }

    let idp = match fetch_idp_config(&server_http).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("拉认证参数失败: {e}");
            return 1;
        }
    };
    if !idp.enabled {
        eprintln!("mn-ws 服务端未开启统一登录。");
        return 1;
    }

    let client_id = if idp.login_client_id.is_empty() {
        idp.client_id.clone()
    } else {
        idp.login_client_id.clone()
    };
    if client_id.is_empty() {
        eprintln!("服务端没发布 client_id / loginClientId。");
        return 1;
    }

    let pkce = Pkce::generate();

    // 本机一次性监听：收浏览器回调的 code。
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("起回环监听失败: {e}");
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // 回调必须指向**这个监听器**：端口是内核刚分配的，路径是白名单里那一条 `/callback`。
    let redirect_uri = client_redirect_uri(port);

    let authorize = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&nonce={}&code_challenge={}&code_challenge_method=S256",
        idp.authorization_endpoint,
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(&idp.scopes.join(" ")),
        urlencode(&pkce.state),
        urlencode(&pkce.nonce),
        urlencode(&pkce.challenge),
    );

    println!("在浏览器里完成登录…");
    if let Err(e) = webbrowser::open(&authorize) {
        eprintln!("开不了浏览器（{e}）。请手动打开下面这个地址：\n{authorize}");
    } else {
        println!("  {authorize}");
    }

    // 等回调（最多 5 分钟）。
    let code = match wait_for_code(listener, &pkce.state, Duration::from_secs(300)).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("登录失败: {e}");
            return 1;
        }
    };

    // 交给 server 半换码 —— 认证中心的票不出服务端。
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{server_http}/auth/oidc/callback"))
        .json(&json!({
            "code": code,
            "codeVerifier": pkce.verifier,
            "redirectUri": redirect_uri,
        }))
        .send()
        .await;
    let body = match resp {
        Ok(r) => r.text().await.unwrap_or_default(),
        Err(e) => {
            eprintln!("换码失败: {e}");
            return 1;
        }
    };
    let v: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("换码响应不是 JSON: {e}");
            return 1;
        }
    };
    if !v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        eprintln!(
            "换码被拒: {}",
            v.get("error").and_then(|x| x.as_str()).unwrap_or(&body)
        );
        return 1;
    }

    // 落盘到账号簿。
    let mut raw = crate::config::read_config_file();
    let user_id = v.get("userId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let account_key = if user_id.is_empty() {
        "active".to_string()
    } else {
        user_id.clone()
    };
    let device_token = v.get("token").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let expires_at = v
        .get("expiresAt")
        .and_then(|x| x.as_i64())
        .unwrap_or_else(|| now_ms() / 1000 + DEVICE_TOKEN_TTL_SEC);

    let mut accounts = match raw.get("accounts") {
        Some(Value::Object(m)) => m.clone(),
        _ => serde_json::Map::new(),
    };
    let mut entry = serde_json::Map::new();
    entry.insert("userId".into(), json!(user_id));
    entry.insert(
        "email".into(),
        json!(v.get("email").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert(
        "username".into(),
        json!(v.get("username").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert(
        "nickname".into(),
        json!(v.get("nickname").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert("deviceToken".into(), json!(device_token));
    entry.insert("expiresAt".into(), json!(expires_at * 1000));
    entry.insert(
        "deviceName".into(),
        json!(cfg.get("deviceName").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert(
        "clientId".into(),
        json!(cfg.get("clientId").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert("url".into(), json!(cfg.get("url").and_then(|x| x.as_str()).unwrap_or("")));
    entry.insert(
        "serverHttp".into(),
        json!(cfg.get("serverHttp").and_then(|x| x.as_str()).unwrap_or("")),
    );
    entry.insert("loginAt".into(), json!(now_ms()));
    accounts.insert(account_key.clone(), Value::Object(entry));
    raw.insert("accounts".into(), Value::Object(accounts));
    raw.insert("activeAccount".into(), json!(account_key));

    match crate::config::write_config_file(&raw) {
        Ok(_) => {
            println!("登录成功。设备令牌已保存（90 天有效）。");
            0
        }
        Err(e) => {
            eprintln!("登录成功但写配置失败: {e}");
            1
        }
    }
}

/// 等浏览器回调，把 code 取出来。
async fn wait_for_code(
    listener: tokio::net::TcpListener,
    state: &str,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("等待浏览器回调超时".into());
        }
        let Ok(accepted) = tokio::time::timeout(remaining, listener.accept()).await else {
            return Err("等待浏览器回调超时".into());
        };
        let Ok((mut sock, _)) = accepted else { continue };
        // 读请求行（只取第一行就够 —— query 在请求行里）。
        let mut buf = vec![0u8; 4096];
        let n = match tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let Some(path) = req.split_whitespace().nth(1) else {
            continue;
        };
        let q = path.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut code = String::new();
        let mut got_state = String::new();
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "code" => code = urldecode(v),
                    "state" => got_state = urldecode(v),
                    _ => {}
                }
            }
        }
        // state 必须一致：否则是别人的回调或伪造的一次授权完成。
        if got_state != state {
            let _ = sock
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                .await;
            continue;
        }
        let body = "<html><meta charset=utf-8><body style=\"font-family:sans-serif;padding:40px\"><h2>登录成功</h2><p>可以关掉这个页面了。</p></body>";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        if code.is_empty() {
            return Err("回调里没有 code".into());
        }
        return Ok(code);
    }
}

/// 现在的时间戳（毫秒）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// URL 编码（form 风格）。
pub fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// URL 解码。
pub fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_base64url_of_sha256_verifier() {
        let p = Pkce::generate();
        assert_eq!(p.challenge, sha256_b64(p.verifier.as_bytes()));
        assert!(!p.verifier.contains('='), "base64url 不带 padding");
        assert!(!p.challenge.contains('='));
    }

    #[test]
    fn hs256_sign_verify_roundtrip() {
        let secret = b"test-secret";
        let payload = json!({"sub": "5", "exp": 123});
        let token = sign_hs256(&payload, secret);
        let got = verify_hs256(&token, secret).unwrap();
        assert_eq!(got["sub"], "5");
        // 错密钥验不过
        assert!(verify_hs256(&token, b"other-secret").is_none());
        // 改签名验不过。
        //
        // ⚠️ 不能用 `token.replace("\"5\"", "\"6\"")` —— payload 是 base64url 编码的，
        //    里面根本没有字面量 `"5"`，那次替换是**空操作**，于是「篡改后仍能验过」
        //    是一条**假阳性**（它测的是没篡改的东西）。
        //    要真的篡改，就动**签名段**的最后一个字符。
        let parts: Vec<&str> = token.split('.').collect();
        let sig = parts[2];
        let last = sig.chars().last().unwrap();
        let other = if last == 'A' { 'B' } else { 'A' };
        let tampered_sig: String = sig[..sig.len() - 1].to_string() + &other.to_string();
        let tampered = format!("{}.{}.{}", parts[0], parts[1], tampered_sig);
        assert_ne!(tampered, token, "篡改必须真的改动了内容");
        assert!(verify_hs256(&tampered, secret).is_none());
        // 垃圾输入不崩
        assert!(verify_hs256("garbage", secret).is_none());
        assert!(verify_hs256("a.b", secret).is_none());
    }

    #[test]
    fn url_encode_decode_roundtrip() {
        for s in ["a b", "a+b", "x&y=z", "中文", "a/b?c"] {
            assert_eq!(urldecode(&urlencode(s)), s, "{s}");
        }
    }
}
