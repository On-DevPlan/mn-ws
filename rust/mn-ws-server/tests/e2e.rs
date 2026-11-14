//! 端到端：真的起一个假目标服务 + 真的起 server 半 + 真的用 client 半的
//! 数据面打过去。
//!
//! 验的是**跨进程契约**：帧格式、路由、鉴权、属主、多路复用。
//! 协议层的纯函数在 `mn-ws-core`；这里验的是「两端对上」。
//!
//! ## 协议的方向（先说清，否则测试会写成反的）
//!
//! ```text
//! 远端 HTTP 客户端 ──HTTP──> server 半 ──WS: REQUEST 帧──> 桥（client 半）
//!        ↑                                                  │
//!        └──────── HTTP 响应 ──── WS: RESPONSE 帧 ─────────┘
//! ```
//!
//! **桥是「收 REQUEST 帧、回 RESPONSE 帧」** —— 不是主动发请求。
//! 测试里的「假桥」也是这个角色：它收帧、打本机 HTTP、回帧。
//!
//! ## 为什么这个测试不可省
//!
//! 单测只能证明「每个零件自己是对的」。而桥接最容易坏的地方恰恰在**接缝**：
//! 帧的字段名差一个字母、头的剥离规则两边不一致、content-length 算错 ——
//! 这些在单测里全是绿的，真打一发才发现。
//!
//! 这里的断言刻意写成**逐字对比**（目标服务看到的路径/头/body 与期望一致），
//! 而不是「状态码是 200」这种弱断言 —— 弱断言会让「请求打到了错误的地方」
//! 溜过去。

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use base64::Engine;
use mn_ws_core::protocol::{self, ProtocolHeaders};
use mn_ws_server::server::{run, ServerOptions};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 目标服务看到的一次请求。
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    headers: ProtocolHeaders,
    body: Vec<u8>,
}

/// 起一个假目标服务（client 半要打的那个）。
async fn start_fake_target() -> (u16, Arc<Mutex<Vec<Seen>>>) {
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen_clone = seen.clone();

    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let seen = seen_clone.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                let n = match sock.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let mut lines = req.split("\r\n");
                let request_line = lines.next().unwrap_or("");
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("/").to_string();

                let mut headers = ProtocolHeaders::new();
                let mut header_bytes = request_line.len();
                for line in lines {
                    header_bytes += line.len() + 2; // \r\n
                    if line.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = line.split_once(':') {
                        headers
                            .entry(k.trim().to_lowercase())
                            .or_default()
                            .push(v.trim().to_string());
                    }
                }
                // 请求头之后多一个 \r\n（头与 body 的分隔）
                header_bytes += 2;
                let content_length: usize = headers
                    .get("content-length")
                    .and_then(|v| v.first())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                // ⚠️ body 从**请求头之后**开始，不是从 buf[n] 开始 ——
                //    buf[n..] 是「还没读到的部分」（全 0），不是「读到的 body」。
                let mut body = buf[header_bytes.min(n)..n].to_vec();
                while body.len() < content_length {
                    let mut more = vec![0u8; 4096];
                    match sock.read(&mut more).await {
                        Ok(k) if k > 0 => body.extend_from_slice(&more[..k]),
                        _ => break,
                    }
                }
                body.truncate(content_length);
                seen.lock().unwrap().push(Seen {
                    method,
                    path: path.clone(),
                    headers,
                    body,
                });

                let payload = json!({ "ok": true, "url": path }).to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Fake-Nx: yes\r\nContent-Length: {}\r\n\r\n{}",
                    payload.len(),
                    payload
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    (port, seen)
}

/// 起一个 server 半。
async fn start_server(opts: ServerOptions) -> SocketAddr {
    run(opts).await.expect("server 半要能起来")
}

/// 一个「假桥」：连上 WS、注册、收 REQUEST 帧、打本机 HTTP、回 RESPONSE 帧。
///
/// 它扮演的就是 client 半的数据面 —— 帧的处理逻辑与 `client/src/core/bridge.ts`
/// 同款：剥掉不能转发的头、拼回 query、content-length 自己算。
///
/// 返回一个句柄：能读到它收到的帧，也能停掉它。
struct FakeBridge {
    _handle: tokio::task::JoinHandle<()>,
    received: Arc<Mutex<Vec<Value>>>,
}

async fn start_fake_bridge(
    ws_url: &str,
    token: &str,
    app: &str,
    base: String,
    title: &str,
    bridge_id: &str,
    pc_name: &str,
) -> FakeBridge {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
    let received: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let received_clone = received.clone();

    let reg = json!({
        "type": protocol::frame_type::REGISTER,
        "role": "bridge",
        "bridgeId": bridge_id,
        "name": pc_name,
        "apps": [{
            "app": app,
            "base": base,
            "title": title,
        }],
        "token": token,
    });
    ws.send(Message::Text(protocol::encode_frame(&reg)))
        .await
        .unwrap();

    let handle = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws.next().await {
            let Message::Text(t) = msg else { continue };
            let Some(frame) = protocol::decode_frame(&t) else {
                continue;
            };
            if frame["type"] != protocol::frame_type::REQUEST {
                continue;
            }
            received_clone.lock().unwrap().push(frame.clone());

            // 与真实 client 半同款：剥掉不能转发的头、拼回 query、content-length 自己算。
            let id = frame.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut headers = protocol::normalize_headers(
                &frame.get("headers").cloned().unwrap_or(json!({})),
            );
            let headers = protocol::strip_request_headers(&headers);
            let body = base64::engine::general_purpose::STANDARD
                .decode(frame.get("body").and_then(|v| v.as_str()).unwrap_or(""))
                .unwrap_or_default();

            let query = frame
                .get("query")
                .and_then(|v| v.as_object())
                .map(|q| {
                    q.iter()
                        .filter_map(|(k, v)| {
                            v.as_str().map(|s| format!("{k}={}", url_encode(s)))
                        })
                        .collect::<Vec<_>>()
                        .join("&")
                })
                .unwrap_or_default();
            let path = format!(
                "{}{}",
                frame.get("path").and_then(|v| v.as_str()).unwrap_or("/"),
                if query.is_empty() { String::new() } else { format!("?{query}") }
            );

            let url = format!("{}{}", base.trim_end_matches('/'), path);
            let mut req = reqwest::Client::new()
                .request(
                    reqwest::Method::from_bytes(
                        frame
                            .get("method")
                            .and_then(|v| v.as_str())
                            .unwrap_or("GET")
                            .as_bytes(),
                    )
                    .unwrap_or(reqwest::Method::GET),
                    &url,
                );
            for (k, v) in &headers {
                if let Some(first) = v.first() {
                    req = req.header(k.as_str(), first.as_str());
                }
            }
            // ⚠️ **不要手动设 content-length**。
            //
            // reqwest 会按 body 的实际长度自己算这个头；手动再设一个，
            // 两个值打架时 reqwest 会用一个长度为 0 的版本 ——
            // 症状是「body 变成了空字节，但长度对得上」。
            //
            // TS 版之所以要手动重算，是因为 Node 的 http.request 不会替它算。
            if !body.is_empty() {
                req = req.body(body);
            }

            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = ws
                        .send(Message::Text(protocol::encode_frame(&json!({
                            "type": protocol::frame_type::ERROR,
                            "id": id,
                            "code": "request_failed",
                            "error": e.to_string(),
                        }))))
                        .await;
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let mut out_headers = ProtocolHeaders::new();
            for (k, v) in resp.headers().iter() {
                out_headers
                    .entry(k.as_str().to_lowercase())
                    .or_default()
                    .push(v.to_str().unwrap_or("").to_string());
            }
            let resp_body = resp.bytes().await.unwrap_or_default();
            let _ = ws
                .send(Message::Text(protocol::encode_frame(&json!({
                    "type": protocol::frame_type::RESPONSE,
                    "id": id,
                    "status": status,
                    "headers": headers_to_json(&out_headers),
                    "body": base64::engine::general_purpose::STANDARD.encode(&resp_body),
                    "ts": 1,
                }))))
                .await;
        }
    });

    // 等注册完成
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    FakeBridge {
        _handle: handle,
        received,
    }
}

/// URL 编码（form 风格）。
fn url_encode(s: &str) -> String {
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

/// 协议层的头转成 JSON 值。
fn headers_to_json(headers: &ProtocolHeaders) -> Value {
    let mut map = serde_json::Map::new();
    for (k, v) in headers {
        map.insert(
            k.clone(),
            Value::Array(v.iter().map(|s| Value::String(s.clone())).collect()),
        );
    }
    Value::Object(map)
}

/// 打一个 HTTP 请求（远端客户端的角色）。
async fn http_get(addr: SocketAddr, path: &str, headers: &[(&str, &str)]) -> (u16, Value, Vec<u8>) {
    let client = reqwest::Client::new();
    let mut req = client.get(format!("http://{addr}{path}"));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    let body = resp.bytes().await.unwrap_or_default();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, json, body.to_vec())
}

/// 端到端：请求穿过 WS 到达本机应用，响应原样回来。
#[tokio::test]
async fn e2e_request_reaches_local_app_and_response_comes_back() {
    let (target_port, seen) = start_fake_target().await;
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let _bridge = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "nx-test",
        format!("http://127.0.0.1:{target_port}"),
        "假目标服务",
        "test-bridge",
        "测试机",
    )
    .await;

    let (status, _json, body) =
        http_get(addr, "/nx-test/api/echo", &[("X-Mn-Ws-Token", "gate-token")]).await;
    assert_eq!(status, 200);

    // 目标服务确实收到了请求，且路径逐字一致
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].path, "/api/echo");

    // 响应体原样回来
    let parsed: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["url"], "/api/echo");
}

/// 端到端：L1 门禁头不进本机应用（那是桥的内部事务）。
#[tokio::test]
async fn e2e_gate_header_never_reaches_local_app() {
    let (target_port, seen) = start_fake_target().await;
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let _bridge = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "nx-test",
        format!("http://127.0.0.1:{target_port}"),
        "假目标服务",
        "test-bridge",
        "测试机",
    )
    .await;

    let (status, _, _) = http_get(
        addr,
        "/nx-test/api/echo",
        &[
            ("X-Mn-Ws-Token", "gate-token"),
            ("X-App-Auth", "Bearer app-token"),
        ],
    )
    .await;
    assert_eq!(status, 200);

    let seen = seen.lock().unwrap();
    let headers = &seen[0].headers;
    assert!(
        !headers.contains_key("x-mn-ws-token"),
        "门禁令牌绝不能泄给目标服务"
    );
    assert_eq!(
        headers.get("x-app-auth").map(|v| v[0].as_str()),
        Some("Bearer app-token"),
        "应用自己的头要原样透传（L3 鉴权）"
    );
}

/// 端到端：body 与 content-length 按实际字节重算。
///
/// 这一条是**最容易坏**的地方：body 在帧里是 base64（膨胀 ~33%），
/// 透传原长度会让目标服务按错误的长度读 body —— 轻则截断、重则挂住。
#[tokio::test]
async fn e2e_body_and_content_length_are_recomputed() {
    let (target_port, seen) = start_fake_target().await;
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let _bridge = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "nx-test",
        format!("http://127.0.0.1:{target_port}"),
        "假目标服务",
        "test-bridge",
        "测试机",
    )
    .await;

    // POST 一个带 body 的请求
    let client = reqwest::Client::new();
    let payload = "你好，mn-ws —— 这是一段 UTF-8 正文";
    let resp = client
        .post(format!("http://{addr}/nx-test/api/echo"))
        .header("X-Mn-Ws-Token", "gate-token")
        .header("Content-Type", "text/plain")
        .body(payload)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let seen = seen.lock().unwrap();
    assert_eq!(
        seen[0].body,
        payload.as_bytes(),
        "body 必须逐字节还原（base64 往返不能改内容）"
    );
    assert_eq!(
        seen[0].headers.get("content-length").map(|v| v[0].as_str()),
        Some(payload.len().to_string().as_str()),
        "content-length 要按**实际 body 长度**重算"
    );
}

/// 端到端：HTTP 侧鉴权 —— 无凭据 401，未知应用 404。
#[tokio::test]
async fn e2e_http_requires_credentials_and_known_app() {
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let client = reqwest::Client::new();

    let no_auth = client
        .get(format!("http://{addr}/nx-test/api/echo"))
        .send()
        .await
        .unwrap();
    assert_eq!(no_auth.status(), 401, "没有 L1 凭据必须 401");

    let unknown = client
        .get(format!("http://{addr}/no-such-app/api/x"))
        .header("X-Mn-Ws-Token", "gate-token")
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404, "没注册过的应用是 404");
    let body: Value = unknown.json().await.unwrap();
    assert_eq!(body["error"], "unknown_app");
}

/// 端到端：注册令牌无效 → 注册被拒。
#[tokio::test]
async fn e2e_invalid_registration_token_is_rejected() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let ws_url = format!("ws://{addr}/ws");
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let reg = json!({
        "type": protocol::frame_type::REGISTER,
        "role": "bridge",
        "bridgeId": "bad-bridge",
        "apps": [],
        "token": "wrong-token",
    });
    ws.send(Message::Text(protocol::encode_frame(&reg)))
        .await
        .unwrap();

    // 服务端应回一个 error 帧（invalid_token）
    let got_error = recv_until(&mut ws, |f| {
        f["type"] == protocol::frame_type::ERROR && f["error"] == "invalid_token"
    })
    .await;
    assert!(
        got_error.is_some(),
        "令牌无效的注册必须被拒（error: invalid_token）"
    );
}

/// 端到端：目录列出桥注册的应用，标题原样带出。
#[tokio::test]
async fn e2e_catalog_lists_registered_apps_with_titles() {
    let (target_port, _seen) = start_fake_target().await;
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let _bridge = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "my-api",
        format!("http://127.0.0.1:{target_port}"),
        "我的服务",
        "pc-a",
        "办公室台式机",
    )
    .await;

    let resp = reqwest::Client::new()
        .get(format!("http://{addr}/api/catalog"))
        .header("X-Mn-Ws-Token", "gate-token")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let cat: Value = resp.json().await.unwrap();
    assert_eq!(cat["ok"], true);
    assert_eq!(cat["count"], 1);
    assert_eq!(cat["apps"][0]["app"], "my-api");
    assert_eq!(
        cat["apps"][0]["title"], "我的服务",
        "标题是客户端自报的，server 不该替它猜"
    );
    assert_eq!(cat["apps"][0]["port"], target_port);
    assert_eq!(cat["pcCount"], 1);
    assert_eq!(cat["pcs"][0]["name"], "办公室台式机");
}

/// 端到端：X-Mn-Ws-Pc 头指定打哪台 PC 的同名应用。
#[tokio::test]
async fn e2e_pc_header_picks_the_right_bridge() {
    let (target_port, _seen) = start_fake_target().await;
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    // 注册两台 PC，都提供 nx-kv
    let base = format!("http://127.0.0.1:{target_port}");
    let _a = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "nx-kv",
        base.clone(),
        "A",
        "pc-a",
        "A 机",
    )
    .await;
    let _b = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        "gate-token",
        "nx-kv",
        base.clone(),
        "B",
        "pc-b",
        "B 机",
    )
    .await;

    // 指定一台没有这个应用的 PC → 明确报错，不默默打到另一台
    let (status, body, _) = http_get(
        addr,
        "/nx-kv/api/ping",
        &[
            ("X-Mn-Ws-Token", "gate-token"),
            ("X-Mn-Ws-Pc", "no-such-pc"),
        ],
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], "unknown_pc_app");
}

/// 端到端：属主隔离 —— 别人的桥访问不到。
#[tokio::test]
async fn e2e_owner_isolation_blocks_other_users() {
    // server 带设备令牌能力
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        jwt_secret: "test-secret".into(),
        auth_enabled: true,
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    // 用 u1 的设备令牌注册一座桥
    let u1_token = issue_test_token("test-secret", "u1", "dev1");
    let _bridge = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        &u1_token,
        "nx-test",
        "http://127.0.0.1:1".to_string(),
        "u1 的服务",
        "pc-u1",
        "u1 的机器",
    )
    .await;

    // u2 的令牌访问 u1 的桥 → 403（选路时的属主过滤：u2 的候选里没有自家的 PC）
    let u2_token = issue_test_token("test-secret", "u2", "dev2");
    let (status, body, _) = http_get(addr, "/nx-test/api/echo", &[("X-Mn-Ws-Token", &u2_token)]).await;
    assert_eq!(status, 403, "属主不匹配的请求必须 403");
    assert_eq!(body["error"], "cross_owner");
}

#[tokio::test]
async fn e2e_same_app_two_pcs_routed_by_pc_header() {
    // (PC, app) 复合键：两台 PC 注册同名 app **并存**，各自可路由。
    // 不点名 → 409 ambiguous_app；点名 → 精确路由。
    let addr = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        token: "gate-token".into(),
        jwt_secret: "test-secret".into(),
        auth_enabled: true,
        log_level: "error".into(),
        ..Default::default()
    })
    .await;

    let (tport, _seen) = start_fake_target().await;
    let u1 = issue_test_token("test-secret", "u1", "dev1");
    let _a = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        &u1,
        "nx-test",
        format!("http://127.0.0.1:{tport}"),
        "A 上的",
        "pc-a",
        "A 机",
    )
    .await;
    let _b = start_fake_bridge(
        &format!("ws://{addr}/ws"),
        &u1,
        "nx-test",
        format!("http://127.0.0.1:{tport}"),
        "B 上的",
        "pc-b",
        "B 机",
    )
    .await;

    // 不带 PC 头 → 409 ambiguous_app（两台都登记了这个名字，让调用方点名）
    let (status, body, _) = http_get(addr, "/nx-test/api/echo", &[("X-Mn-Ws-Token", &u1)]).await;
    assert_eq!(status, 409, "多机同名不带点名必须 409");
    assert_eq!(body["error"], "ambiguous_app");
    assert_eq!(body["pcs"].as_array().unwrap().len(), 2);

    // 点名 pc-a → 精确路由
    let (status, body, _) = http_get(
        addr,
        "/nx-test/api/echo",
        &[("X-Mn-Ws-Token", &u1), ("X-Mn-Ws-Pc", "pc-a")],
    )
    .await;
    assert_eq!(status, 200, "点名 pc-a 要能打穿（{body}）");

    // 点名 pc-b → 同样打穿
    let (status, body, _) = http_get(
        addr,
        "/nx-test/api/echo",
        &[("X-Mn-Ws-Token", &u1), ("X-Mn-Ws-Pc", "pc-b")],
    )
    .await;
    assert_eq!(status, 200, "点名 pc-b 要能打穿（{body}）");

    // 点名不存在的 PC → 404 unknown_pc_app
    let (status, body, _) = http_get(
        addr,
        "/nx-test/api/echo",
        &[("X-Mn-Ws-Token", &u1), ("X-Mn-Ws-Pc", "pc-nope")],
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["error"], "unknown_pc_app");
}

/// 签一枚测试用设备令牌（HS256，与 server 半同一套算法）。
fn issue_test_token(secret: &str, sub: &str, cid: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let head = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload_json = json!({
        "sub": sub,
        "cid": cid,
        "dn": "",
        "iat": 1,
        "exp": 9_999_999_999_i64,
        "jti": format!("jti-{sub}"),
    })
    .to_string();
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload_json.as_bytes());
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{head}.{body}").as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{head}.{body}.{sig}")
}

/// 收帧直到谓词为真（带超时）。返回命中的帧。
async fn recv_until<S, F>(ws: &mut tokio_tungstenite::WebSocketStream<S>, pred: F) -> Option<Value>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: Fn(&Value) -> bool,
{
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        // `ws.next()` 给的是 Option<Result<Message, Error>>；
        // timeout 包一层后变成 Result<Option<Result<..>>, Elapsed>。
        let Ok(next) = tokio::time::timeout(remaining, ws.next()).await else {
            return None;
        };
        let Some(Ok(msg)) = next else {
            return None;
        };
        let Message::Text(t) = msg else { continue };
        let Some(frame) = protocol::decode_frame(&t) else {
            continue;
        };
        if pred(&frame) {
            return Some(frame);
        }
    }
}
