//! 数据面：把 WS 帧还原成本机 HTTP 请求。
//!
//! 与 TS 版 `client/src/core/bridge.ts` 的 `BridgeClient` **逐条对齐**：
//!
//!   1. 应用没登记 → 回 `unknown_app`
//!   2. base 非法 → 回 `bad_base`
//!   3. body 是 base64 → 解码；超上限 → 回 `body_too_large`
//!   4. 剥掉不能转发的头（含 **X-Mn-Ws-Token** 与 **Origin**）
//!   5. content-length 按**实际 body 长度**重算（body 走过一趟 base64）
//!   6. 响应体超上限 → 断掉请求（不回半个响应）
//!   7. 响应帧带 status / headers / base64 body / ts
//!
//! ## 为什么 content-length 要重算
//!
//! body 在帧里是 base64（膨胀 ~33%），直接透传长度会让本机服务按错误的长度读 body ——
//! 轻则截断、重则挂住。TS 版是 `delete` 后按实际长度重设，这里照做。

use std::collections::HashMap;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::protocol;

/// 一次 HTTP 响应（状态码 / 头 / 体）。
pub struct HttpResult {
    pub status: u16,
    pub headers: HashMap<String, Vec<String>>,
    pub body: Vec<u8>,
}

/// 数据面的发送端：把帧写回 WS。
pub type FrameSender = Arc<dyn Fn(Value) + Send + Sync>;

/// 正在跑的请求（用于 abort）。
struct Inflight {
    handle: tokio::task::JoinHandle<()>,
}

/// 数据面客户端：帧 → 本机 HTTP → 帧。
pub struct BridgeClient {
    /// app -> base
    apps: HashMap<String, String>,
    send: FrameSender,
    inflight: Arc<Mutex<HashMap<String, Inflight>>>,
    /// 单个 HTTP 客户端复用连接（与 TS 版的 http.Client 同思路）。
    http: reqwest::Client,
}

impl BridgeClient {
    /// 构造。
    pub fn new(apps: HashMap<String, String>, send: FrameSender) -> Self {
        // 桥接层的 HTTP 客户端：不跟随重定向（目标服务自己决定）、
        // 不自动解压（body 按原样回传，与 TS 版一致）。
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(
                protocol::DEFAULT_REQUEST_TIMEOUT_MS,
            ))
            .build()
            .unwrap_or_default();
        BridgeClient {
            apps,
            send,
            inflight: Arc::new(Mutex::new(HashMap::new())),
            http,
        }
    }

    /// 处理一个 request 帧。
    pub async fn handle_request(&self, frame: &Value) {
        let id = frame
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let app = frame
            .get("app")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let Some(base) = self.apps.get(&app).cloned() else {
            self.respond_error(&id, "unknown_app", &format!("未注册应用 {app}"));
            return;
        };

        let Ok(mut url) = url::Url::parse(&base) else {
            self.respond_error(&id, "bad_base", &format!("应用 {app} 的 base 不是合法 URL：{base}"));
            return;
        };

        // 路径 + query
        //
        // base 的 path 与请求的 path 要**拼**（base 可能是 http://h:port 或带前缀），
        // query 单独挂上去。
        let path = frame
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("/")
            .to_string();
        let query = match frame.get("query").and_then(|v| v.as_object()) {
            Some(q) => {
                let mut pairs: Vec<(String, String)> = Vec::new();
                for (k, v) in q {
                    if let Some(s) = v.as_str() {
                        pairs.push((k.clone(), s.to_string()));
                    } else if !v.is_null() {
                        pairs.push((k.clone(), v.to_string()));
                    }
                }
                // 与 TS 的 URLSearchParams 同序（按插入序），避免签名类接口挑参数。
                Some(
                    url::form_urlencoded::Serializer::new(String::new())
                        .extend_pairs(pairs)
                        .finish(),
                )
            }
            None => None,
        };

        // 拼最终 URL：base 的 path 前缀 + 请求 path。
        let base_path = url.path().trim_end_matches('/').to_string();
        let joined = if path.starts_with('/') {
            format!("{base_path}{path}")
        } else {
            format!("{base_path}/{path}")
        };
        url.set_path(&joined);
        if let Some(q) = &query {
            url.set_query(Some(q));
        }

        // body：帧里是 base64
        let body_b64 = frame.get("body").and_then(|v| v.as_str()).unwrap_or("");
        let body = match B64.decode(body_b64) {
            Ok(b) => b,
            Err(_) => {
                self.respond_error(&id, "bad_body", "body 不是合法 base64");
                return;
            }
        };
        if body.len() > protocol::MAX_BODY_BYTES {
            self.respond_error(
                &id,
                "body_too_large",
                &format!("body {} 超过上限 {}", body.len(), protocol::MAX_BODY_BYTES),
            );
            return;
        }

        // 剥掉不能转发的头。
        //
        // 归一化（小写 + 值成数组）交给共享协议层 —— server 半用的是**同一个**函数，
        // 两边的头处理不可能对不上。
        let raw_headers = frame
            .get("headers")
            .cloned()
            .map(|v| protocol::normalize_headers(&v))
            .unwrap_or_default();
        let mut headers = protocol::strip_request_headers(&raw_headers);
        // content-length 按实际 body 重算
        headers.remove("content-length");
        if !body.is_empty() {
            headers.insert(
                "content-length".to_string(),
                vec![body.len().to_string()],
            );
        }

        let method = frame
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_string();
        let reqwest_method = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(_) => {
                self.respond_error(&id, "bad_method", &format!("方法不合法: {method}"));
                return;
            }
        };

        // 发出去
        let mut req = self.http.request(reqwest_method, url.clone());
        for (k, v) in &headers {
            if let Some(first) = v.first() {
                req = req.header(k.as_str(), first.as_str());
            }
        }
        if !body.is_empty() {
            req = req.body(body.clone());
        }

        let send = self.send.clone();
        let rid = id.clone();
        let inflight = self.inflight.clone();
        let handle = tokio::spawn(async move {
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let mut hdrs: HashMap<String, Vec<String>> = HashMap::new();
                    for (k, v) in resp.headers().iter() {
                        let key = k.as_str().to_lowercase();
                        let val = v.to_str().unwrap_or("").to_string();
                        hdrs.entry(key).or_default().push(val);
                    }
                    let bytes = match resp.bytes().await {
                        Ok(b) => b,
                        Err(e) => {
                            send(json!({
                                "type": protocol::frame_type::ERROR,
                                "id": rid,
                                "code": "response_failed",
                                "error": e.to_string(),
                            }));
                            return;
                        }
                    };
                    if bytes.len() > protocol::MAX_BODY_BYTES {
                        send(json!({
                            "type": protocol::frame_type::ERROR,
                            "id": rid,
                            "code": "response_too_large",
                            "error": format!(
                                "响应体 {} 超过上限 {}",
                                bytes.len(),
                                protocol::MAX_BODY_BYTES
                            ),
                        }));
                        return;
                    }
                    send(json!({
                        "type": protocol::frame_type::RESPONSE,
                        "id": rid,
                        "status": status,
                        "headers": hdrs,
                        "body": B64.encode(&bytes),
                        "ts": now_ms(),
                    }));
                }
                Err(e) => {
                    let code = if e.is_timeout() { "timeout" } else { "request_failed" };
                    send(json!({
                        "type": protocol::frame_type::ERROR,
                        "id": rid,
                        "code": code,
                        "error": e.to_string(),
                    }));
                }
            }
            inflight.lock().await.remove(&rid);
        });

        self.inflight
            .lock()
            .await
            .insert(id, Inflight { handle });
    }

    /// 中断一个在跑的请求（server 侧 HTTP 客户端断开了）。
    pub async fn abort(&self, id: &str) -> bool {
        let item = self.inflight.lock().await.remove(id);
        match item {
            Some(i) => {
                i.handle.abort();
                true
            }
            None => false,
        }
    }

    /// 断开时把所有在跑的请求收掉。
    pub async fn abort_all(&self) {
        let mut map = self.inflight.lock().await;
        for (_, i) in map.drain() {
            i.handle.abort();
        }
    }

    /// 回一个错误帧。
    fn respond_error(&self, id: &str, code: &str, message: &str) {
        (self.send)(json!({
            "type": protocol::frame_type::ERROR,
            "id": id,
            "code": code,
            "error": message,
        }));
    }
}

/// 现在的时间戳（毫秒）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 帧收集器走同步 Mutex：send 回调是同步闭包，不能 await。
    use std::sync::Mutex as StdMutex;

    #[test]
    fn base64_body往返() {
        let raw = b"hello mn-ws".to_vec();
        let enc = B64.encode(&raw);
        assert_eq!(B64.decode(&enc).unwrap(), raw);
    }

    #[test]
    fn 未注册的应用回unknown_app() {
        let sent: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let s2 = sent.clone();
        let c = BridgeClient::new(
            HashMap::new(),
            Arc::new(move |v: Value| {
                if let Ok(mut g) = s2.lock() {
                    g.push(v);
                }
            }),
        );
        let frame = json!({"type": "request", "id": "r1", "app": "nope", "path": "/x"});
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            c.handle_request(&frame).await;
            let g = sent.lock().unwrap();
            assert_eq!(g.len(), 1);
            assert_eq!(g[0]["type"], "error");
            assert_eq!(g[0]["code"], "unknown_app");
        });
    }

    #[test]
    fn 非法base64回bad_body() {
        let sent: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let s2 = sent.clone();
        let mut apps = HashMap::new();
        apps.insert("a".to_string(), "http://127.0.0.1:1".to_string());
        let c = BridgeClient::new(
            apps,
            Arc::new(move |v: Value| {
                if let Ok(mut g) = s2.lock() {
                    g.push(v);
                }
            }),
        );
        let frame = json!({"type": "request", "id": "r1", "app": "a", "body": "!!!not-base64!!!"});
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            c.handle_request(&frame).await;
            let g = sent.lock().unwrap();
            assert_eq!(g[0]["code"], "bad_body");
        });
    }
}
