//! 面板登录流程的端到端测试。
//!
//! 验的是**完整闭环**：面板点「登录」→ 弹浏览器（这里不起浏览器，只拿 URL）→
//! 浏览器把 code 送回面板的 `/callback` → 换 access_token → 换设备令牌 →
//! 落进账号簿 → 面板的登录态变成「已登录」。
//!
//! 为什么要有这个：面板登录是**跨请求**的状态机（起流程一次、收回调一次），
//! 中间还夹着与认证中心、与 server 半的两次 HTTP 交换。
////! 这几段任何一段对不上，症状都是「点了登录没反应」或「登录态一直不生效」——
//! 单测看不出来。
//!
//! 假认证中心是**打桩**而不是直连线上：线上那条真链路需要一个能登录的账号，
//! 而 CI 里不该存生产口令。这里覆盖的是**本流程这一段实现的正确性**
//! （PKCE 参数、state 比对、用 client 半的身份换码、不带 secret、换到设备令牌）；
//! 与真实认证中心的互操作由公网远端验收覆盖。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;

use mn_ws_client::auth::{self, IdpConfig, Pkce};
use mn_ws_client::session::SessionManager;
use serde_json::{json, Value};

/// 假认证中心 + 假 server 半（同一个进程，路由不同）。
struct FakeIdp {
    issuer: String,
    /// 收到的 token 请求表单
    token_form: Arc<Mutex<Option<HashMap<String, String>>>>,
    /// 收到的 userinfo 请求的 Authorization 头
    userinfo_auth: Arc<Mutex<String>>,
    /// 收到的 /auth/verify 请求的 Authorization 头
    verify_auth: Arc<Mutex<String>>,
    /// 换码时校验的 code_verifier（Some 则必须匹配）
    expect_verifier: Arc<Mutex<Option<String>>>,
}

/// 起一个假认证中心（同时兼当 server 半）。
async fn start_fake_idp(expect_verifier: Option<&str>) -> (String, Arc<FakeIdp>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let issuer = format!("http://127.0.0.1:{port}");
    let state = Arc::new(FakeIdp {
        issuer: issuer.clone(),
        token_form: Arc::new(Mutex::new(None)),
        userinfo_auth: Arc::new(Mutex::new(String::new())),
        verify_auth: Arc::new(Mutex::new(String::new())),
        expect_verifier: Arc::new(Mutex::new(expect_verifier.map(|s| s.to_string()))),
    });

    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let st = st.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 32 * 1024];
                let mut filled = 0usize;
                // ⚠️ 必须读到**请求头结束**（\r\n\r\n）为止，不能只 read 一次 ——
                //    一次 read 可能只拿到请求头的一部分（TCP 分段），
                //    也可能把 body 一起带来。判断依据是头是否完整。
                let header_end = loop {
                    if let Some(pos) = find_sub(&buf[..filled], b"\r\n\r\n") {
                        break pos + 4;
                    }
                    if filled == buf.len() {
                        break filled;
                    }
                    let mut more = [0u8; 4096];
                    match sock.read(&mut more).await {
                        Ok(k) if k > 0 => {
                            buf[filled..filled + k].copy_from_slice(&more[..k]);
                            filled += k;
                        }
                        _ => break filled,
                    }
                };
                if filled == 0 {
                    return;
                }
                let n = filled;
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let mut lines = req.split("\r\n");
                let request_line = lines.next().unwrap_or("").to_string();
                let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (path, query) = path.split_once('?').unwrap_or((path.as_str(), ""));

                let mut headers: HashMap<String, String> = HashMap::new();
                for line in lines {
                    if line.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = line.split_once(':') {
                        headers.insert(k.trim().to_lowercase(), v.trim().to_string());
                    }
                }
                // 请求头之后是 body（可能还没到 —— 那就再读一次）
                let mut body = String::from_utf8_lossy(&buf[header_end.min(n)..n]).to_string();
                let want_len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                while body.len() < want_len {
                    let mut more = vec![0u8; 4096];
                    match sock.read(&mut more).await {
                        Ok(k) if k > 0 => {
                            body.push_str(&String::from_utf8_lossy(&more[..k]));
                        }
                        _ => break,
                    }
                }

                match path {
                    "/auth/oidc/config" => {
                        write_json(
                            &mut sock,
                            200,
                            json!({
                                "ok": true,
                                "enabled": true,
                                "issuer": st.issuer,
                                "clientId": "mn-ws-server",
                                "loginClientId": "mn-ws-client",
                                "scopes": ["openid", "profile", "email"],
                                "authorizationEndpoint": format!("{}/oauth2/auth", st.issuer),
                                "tokenEndpoint": format!("{}/oauth2/token", st.issuer),
                                "userinfoEndpoint": format!("{}/oauth2/userinfo", st.issuer),
                                "idpAvailable": true,
                            }),
                        )
                        .await;
                    }
                    "/oauth2/token" => {
                        // 表单解析
                        let mut form = HashMap::new();
                        for pair in body.split('&') {
                            if let Some((k, v)) = pair.split_once('=') {
                                form.insert(url_decode(k), url_decode(v));
                            }
                        }
                        *st.token_form.lock().unwrap() = Some(form.clone());
                        let want = st.expect_verifier.lock().unwrap().clone();
                        if let Some(w) = want {
                            if form.get("code_verifier").map(|s| s.as_str()) != Some(w.as_str()) {
                                write_json(
                                    &mut sock,
                                    400,
                                    json!({ "error": "invalid_grant" }),
                                )
                                .await;
                                return;
                            }
                        }
                        write_json(
                            &mut sock,
                            200,
                            json!({
                                "access_token": "IDP-AT-1",
                                "refresh_token": "IDP-RT-SECRET",
                                "token_type": "Bearer",
                            }),
                        )
                        .await;
                    }
                    "/oauth2/userinfo" => {
                        *st.userinfo_auth.lock().unwrap() =
                            headers.get("authorization").cloned().unwrap_or_default();
                        write_json(
                            &mut sock,
                            200,
                            json!({
                                "sub": "sub-777",
                                "email": "p@x.io",
                                "name": "跑批",
                                "preferred_username": "pao",
                            }),
                        )
                        .await;
                    }
                    "/auth/verify" => {
                        *st.verify_auth.lock().unwrap() =
                            headers.get("authorization").cloned().unwrap_or_default();
                        write_json(
                            &mut sock,
                            200,
                            json!({
                                "ok": true,
                                "userId": "sub-777",
                                "email": "p@x.io",
                                "username": "pao",
                                "nickname": "跑批",
                                "token": "DEVICE-TOKEN-1",
                                "tokenExpiresAt": 4_102_444_800_000_i64,
                                "clientId": "dev-1",
                                "deviceName": "我的机器",
                            }),
                        )
                        .await;
                    }
                    _ => {
                        let _ = query;
                        write_json(&mut sock, 404, json!({ "error": "not_found" })).await;
                    }
                }
                let _ = sock.shutdown().await;
            });
        }
    });

    (issuer, state)
}

/// 写一个 JSON 响应。
///
/// ⚠️ `write_all` 是**异步**的 —— 必须 await。
/// 写成 `let _ = sock.write_all(..)` 只会创建一个 Future 然后丢掉，
/// 响应根本发不出去（症状：客户端一直「连不上」）。
///
/// `Connection: close` 也是必须的：reqwest 默认复用连接，
/// 而这里每个请求都独立处理完就关掉了 —— 不说清楚的话
/// 客户端会等一个永远不会来的第二个响应。
async fn write_json(sock: &mut tokio::net::TcpStream, code: u16, obj: Value) {
    let payload = obj.to_string();
    let resp = format!(
        "HTTP/1.1 {code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
}

/// 在字节串里找子串的位置。
fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len())
        .position(|w| w == needle)
}

/// URL 解码。
fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                    16,
                ) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
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

/// 从 query 里取参数。
fn query_param(url: &str, key: &str) -> String {
    let q = url.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if url_decode(k) == key {
                return url_decode(v);
            }
        }
    }
    String::new()
}

#[tokio::test]
async fn panel_login_completes_and_stores_account() {
    let (issuer, idp) = start_fake_idp(None).await;

    let mut cfg = serde_json::Map::new();
    cfg.insert("serverHttp".into(), json!(issuer));
    cfg.insert("clientId".into(), json!("dev-1"));
    cfg.insert("deviceName".into(), json!("我的机器"));
    cfg.insert("url".into(), json!("ws://127.0.0.1:7777/ws"));

    let session = SessionManager::new();

    // ── ① 起流程：拿到 authorize URL ──
    let authorize_url = session.start_login(&cfg, 7801, false).await.unwrap();
    assert!(
        authorize_url.contains("response_type=code"),
        "authorize URL 要有 response_type=code: {authorize_url}"
    );
    assert!(
        authorize_url.contains("client_id=mn-ws-client"),
        "要用 **client 半**的身份发起授权码流程（server 半有它自己的身份）: {authorize_url}"
    );
    assert!(
        authorize_url.contains("code_challenge_method=S256"),
        "PKCE 必须是 S256: {authorize_url}"
    );
    assert!(
        authorize_url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A7801%2Fcallback"),
        "回调必须落在**面板自己的端口**上: {authorize_url}"
    );

    // state 与 challenge 都在 URL 里
    let state = query_param(&authorize_url, "state");
    let challenge = query_param(&authorize_url, "code_challenge");
    assert!(!state.is_empty());
    assert!(!challenge.is_empty());

    // ── ② 浏览器把 code 送回来 ──
    let sess = session
        .complete_login(&cfg, "CODE-1", &state)
        .await
        .unwrap();
    assert!(sess.logged_in);
    assert_eq!(sess.user_id, "sub-777");
    assert_eq!(sess.nickname, "跑批");
    assert_eq!(sess.device_token, "DEVICE-TOKEN-1");
    assert_eq!(sess.via, "panel");

    // ── ③ 换码的表单：用 client 半的身份、带 verifier、不带 secret ──
    let form = idp.token_form.lock().unwrap().clone().expect("应发出过换码请求");
    assert_eq!(form.get("grant_type").map(|s| s.as_str()), Some("authorization_code"));
    assert_eq!(form.get("code").map(|s| s.as_str()), Some("CODE-1"));
    assert_eq!(
        form.get("client_id").map(|s| s.as_str()),
        Some("mn-ws-client"),
        "换码必须用 client 半的身份"
    );
    assert!(
        !form.contains_key("client_secret"),
        "公共客户端不得发 client_secret"
    );
    assert!(
        form.get("code_verifier").is_some_and(|v| !v.is_empty()),
        "必须带 PKCE verifier"
    );
    assert_eq!(
        form.get("redirect_uri").map(|s| s.as_str()),
        Some("http://127.0.0.1:7801/callback")
    );

    // ── ④ 认证中心的凭据没外流到别处 ──
    //
    // client 半**自己**换码（公共客户端 + PKCE，无 secret），拿到 access_token
    // 后直接拿它换 mn-ws 的设备令牌 —— **不经过 userinfo**。
    //
    // ���是刻意的：userinfo 是 server 半换码时用的（那边要的是「认证中心断言的 sub」），
    // client 半走 server 半的 /auth/verify 时，server 半自己查 userinfo ——
    // 少一次往返，也少一处「认证中心凭据要传多远」。
    assert_eq!(
        idp.userinfo_auth.lock().unwrap().as_str(),
        "",
        "client 半不直接调 userinfo（那是 server 半换码时的步骤）"
    );
    assert_eq!(
        idp.verify_auth.lock().unwrap().as_str(),
        "Bearer IDP-AT-1",
        "换设备令牌时带认证中心的 access_token"
    );
    assert_ne!(
        sess.device_token, "IDP-AT-1",
        "面板拿到的必须是 mn-ws 自己的设备令牌"
    );
}

#[tokio::test]
async fn panel_login_rejects_mismatched_state() {
    let (issuer, _idp) = start_fake_idp(None).await;
    let mut cfg = serde_json::Map::new();
    cfg.insert("serverHttp".into(), json!(issuer));
    cfg.insert("clientId".into(), json!("dev-1"));

    let session = SessionManager::new();
    session.start_login(&cfg, 7801, false).await.unwrap();

    // state 对不上 —— 回调被串了，或有人在伪造一次登录完成。都必须中止。
    let err = session
        .complete_login(&cfg, "CODE-1", "wrong-state")
        .await
        .unwrap_err();
    assert!(
        err.contains("state"),
        "state 不一致必须报出来: {err}"
    );
}

#[tokio::test]
async fn panel_login_without_pending_flow_is_rejected() {
    let mut cfg = serde_json::Map::new();
    cfg.insert("serverHttp".into(), json!("http://127.0.0.1:1"));
    let session = SessionManager::new();
    let err = session
        .complete_login(&cfg, "CODE-1", "state")
        .await
        .unwrap_err();
    assert!(err.contains("没有进行中的登录"), "实际: {err}");
}

#[tokio::test]
async fn panel_login_refuses_a_second_concurrent_flow() {
    let (issuer, _idp) = start_fake_idp(None).await;
    let mut cfg = serde_json::Map::new();
    cfg.insert("serverHttp".into(), json!(issuer));
    cfg.insert("clientId".into(), json!("dev-1"));

    let session = SessionManager::new();
    session.start_login(&cfg, 7801, false).await.unwrap();
    let err = session.start_login(&cfg, 7801, false).await.unwrap_err();
    assert!(err.contains("已有一个登录在进行中"), "实际: {err}");
}

#[tokio::test]
async fn authorize_url_carries_prompt_when_asked() {
    let cfg = IdpConfig {
        enabled: true,
        issuer: "http://idp.local".into(),
        client_id: "mn-ws-server".into(),
        login_client_id: "mn-ws-client".into(),
        redirect_uri: String::new(),
        scopes: vec!["openid".into(), "profile".into(), "email".into()],
        authorization_endpoint: "http://idp.local/oauth2/auth".into(),
        token_endpoint: "http://idp.local/oauth2/token".into(),
        idp_available: true,
    };
    let pkce = Pkce::generate();
    let url = auth::build_authorize_url(&cfg, &pkce, "http://127.0.0.1:7801/callback", true);
    assert!(url.contains("prompt=login"), "换人登录要带 prompt=login: {url}");
    let url2 = auth::build_authorize_url(&cfg, &pkce, "http://127.0.0.1:7801/callback", false);
    assert!(!url2.contains("prompt="), "普通登录不带 prompt: {url2}");
    // scope 是空格分隔的多个值
    assert!(url.contains("scope=openid+profile+email"), "scope 形态要一致: {url}");
}
