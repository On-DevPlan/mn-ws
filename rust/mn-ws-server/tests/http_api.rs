//! server 半的端到端：HTTP 端点 + 发现文档预热。
//!
//! ## 为什么要验预热
//!
//! `/auth/oidc/config` 报的 `idpAvailable` 含义是「**成功拉到过**发现文档」，
//! 而不是「认证中心在线」。不预热的话这个字段永远是 false ——
//! 而部署脚本正是拿它断言「统一登录确实生效」，于是一个完全正常的部署会被判成失败。
//!
//! （这不是假想：Rust 版第一次上公网就踩了这个 —— 容器健康检查过了、
//! 桥也注册成功了，但 `idpAvailable: false` 让部署脚本判失败。）

use std::sync::Arc;

use mn_ws_server::server::{run, ServerOptions};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 起一个假认证中心（发现文档 + userinfo）。
async fn start_fake_idp() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let issuer = format!("http://127.0.0.1:{port}");
    let issuer_in_task = issuer.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let issuer = issuer_in_task.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                let n = match sock.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .to_string();
                let body = if path.starts_with("/.well-known/openid-configuration") {
                    serde_json::json!({
                        "issuer": issuer,
                        "authorization_endpoint": format!("{issuer}/oauth2/auth"),
                        "token_endpoint": format!("{issuer}/oauth2/token"),
                        "userinfo_endpoint": format!("{issuer}/oauth2/userinfo"),
                    })
                    .to_string()
                } else {
                    serde_json::json!({ "sub": "u1" }).to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });

    issuer
}

/// GET 一个 JSON 端点。
async fn get_json(url: &str) -> (u16, Value) {
    let resp = reqwest::Client::new().get(url).send().await.unwrap();
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let json = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn idp_config_reports_available_after_warmup() {
    let issuer = start_fake_idp().await;

    let addr = run(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        issuer: issuer.clone(),
        jwt_secret: "secret".into(),
        auth_enabled: true,
        log_level: "error".into(),
        ..Default::default()
    })
    .await
    .expect("server 半要能起来");

    let url = format!("http://{addr}/auth/oidc/config");

    // 预热是**后台**的 —— 刚起来时可能还没拉到。轮询等它就绪。
    let mut ready = false;
    let mut last = Value::Null;
    for _ in 0..40 {
        let (_, json) = get_json(&url).await;
        last = json.clone();
        if json["idpAvailable"] == Value::Bool(true) {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    assert!(
        ready,
        "预热后 idpAvailable 必须变 true（部署脚本拿它断言统一登录生效）：{last}"
    );
    assert_eq!(last["ok"], true);
    assert_eq!(last["enabled"], true);
    assert_eq!(last["issuer"], issuer);
    assert_eq!(last["clientId"], "mn-ws-server");
    assert_eq!(last["loginClientId"], "mn-ws-client");
}

#[tokio::test]
async fn idp_config_reports_error_when_issuer_unreachable() {
    // 指向一个没人监听的端口 → 拉不到发现文档
    let addr = run(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        issuer: "http://127.0.0.1:1".into(),
        jwt_secret: "secret".into(),
        auth_enabled: true,
        log_level: "error".into(),
        ..Default::default()
    })
    .await
    .expect("server 半要能起来");

    let (_, json) = get_json(&format!("http://{addr}/auth/oidc/config")).await;
    assert_eq!(json["idpAvailable"], false);
    assert_eq!(json["enabled"], true);
    // idpError 要说清**为什么**拉不到，而不是笼统的「未拉取到发现文档」
    let err = json["idpError"].as_str().unwrap_or("");
    assert!(
        !err.is_empty(),
        "idpError 不能为空：用户要靠它判断是网络问题还是配置问题"
    );
}

#[tokio::test]
async fn health_endpoint_reports_bridge_count() {
    let addr = run(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await
    .expect("server 半要能起来");

    let (status, json) = get_json(&format!("http://{addr}/health")).await;
    assert_eq!(status, 200);
    assert_eq!(json["ok"], true);
    assert_eq!(json["service"], "mn-ws-server");
    assert_eq!(json["bridges"], 0);
    assert_eq!(json["pending"], 0);
}

#[tokio::test]
async fn catalog_requires_credentials() {
    let addr = run(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await
    .expect("server 半要能起来");

    // 无凭据 → 401
    let resp = reqwest::Client::new()
        .get(format!("http://{addr}/api/catalog"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"], "missing_mn_ws_token");

    // 错凭据 → 401
    let resp = reqwest::Client::new()
        .get(format!("http://{addr}/api/catalog"))
        .header("X-Mn-Ws-Token", "wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    // 对凭据 → 200
    let resp = reqwest::Client::new()
        .get(format!("http://{addr}/api/catalog"))
        .header("X-Mn-Ws-Token", "gate-token")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["count"], 0);
}

/// 辅助：让 clippy 不抱怨未用的 import。
#[allow(dead_code)]
fn _unused(_: Arc<()>) {}
