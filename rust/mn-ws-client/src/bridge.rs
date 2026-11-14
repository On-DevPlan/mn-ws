//! 桥连接器：连 server 半、注册、重连、心跳。
//!
//! 与 TS 版 `client/src/core/bridge.ts` 同构。关键行为（**都要一致**）：
//!
//!   · 注册帧带上 app 表 + 每个 app 的元信息（标题、端口）+ 电脑名
//!   · 心跳：15s 一次 ping，没等到 pong 就判定连接已死并重连
//!     （TCP 半开时对端不发 FIN/RST，跨境链路 + 运营商 NAT 下 RST 会丢；
//!      没心跳就会出现「面板显示已连接，实际一帧都发不出去」）
//!   · 指数退避重连：1s → 2s → 4s … 封顶 30s
//!   · **4403 = 注册被拒（设备令牌无效/过期/被吊销）时停止重连**。
//!     重连用的是同一枚令牌，再连一百次也是同样的 4403 —— 无限重连只会刷屏，
//!     而真正要用户做的事（重新 auth login）一句提示都不会有。
//!     （与 mn-rt 的 client/lib/ws-client.js 同款处置）

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::config::ResolvedApps;
use crate::protocol;

const RECONNECT_BASE_MS: u64 = 1000;
const RECONNECT_MAX_MS: u64 = 30_000;
/// 心跳间隔：比服务端的心跳略长一点，两边不会在同一拍上互相打断。
const HEARTBEAT_INTERVAL_MS: u64 = 15_000;

/// 连接状态（与 TS 版 BridgeStatus 的 state 取值一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeState {
    Idle,
    Connecting,
    Connected,
    Registered,
    Reconnecting,
    Stopped,
    Shutdown,
    Error,
}

impl BridgeState {
    /// 状态的中文标签（与 TS 版 stateLabel 一致）。
    pub fn label(self) -> &'static str {
        match self {
            Self::Idle => "未启动",
            Self::Connecting => "连接中",
            Self::Connected => "已连接（注册中）",
            Self::Registered => "已注册",
            Self::Reconnecting => "重连中",
            Self::Stopped => "已停止",
            Self::Shutdown => "服务端要求下线",
            Self::Error => "出错",
        }
    }
}

/// 一次请求的等待槽。
///
/// 一条 WS 上并发跑多个 HTTP 请求，响应按 id 归位 —— 这就是 §多路复用。
struct Pending {
    responder: tokio::sync::oneshot::Sender<Result<(u16, HashMap<String, Vec<String>>, Vec<u8>), String>>,
}

/// 桥连接器的可共享句柄。
///
/// 面板的 `/api/*` 与 CLI 都通过它操作桥 —— 与 TS 版「controller 持有连接」同构。
#[derive(Clone)]
pub struct BridgeHandle {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    state: Mutex<BridgeState>,
    apps: Mutex<Vec<(String, String)>>,
    /// 请求 id -> 等待槽
    pending: Mutex<HashMap<String, Pending>>,
    stopped: AtomicBool,
    /// 设备令牌（注册用）
    token: Mutex<String>,
    url: Mutex<String>,
    bridge_id: Mutex<String>,
    pc_name: Mutex<String>,
}

impl BridgeHandle {
    /// 当前状态。
    pub fn state(&self) -> BridgeState {
        *self.inner.state.lock().unwrap()
    }

    /// 当前可桥的应用。
    pub fn apps(&self) -> Vec<(String, String)> {
        self.inner.apps.lock().unwrap().clone()
    }

    /// 停桥（不再重连）。
    pub fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        *self.inner.state.lock().unwrap() = BridgeState::Stopped;
    }
}

/// 起一条桥。
///
/// 返回句柄；连接在后台任务里跑，失败会自己退避重连。
pub async fn start_bridge(cfg: &serde_json::Map<String, Value>, resolved: &ResolvedApps) -> BridgeHandle {
    let url = cfg
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let token = cfg
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let bridge_id = cfg
        .get("clientId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let pc_name = cfg
        .get("deviceName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let handle = BridgeHandle {
        inner: Arc::new(BridgeInner {
            state: Mutex::new(BridgeState::Idle),
            apps: Mutex::new(resolved.apps.clone()),
            pending: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            token: Mutex::new(token),
            url: Mutex::new(url),
            bridge_id: Mutex::new(bridge_id),
            pc_name: Mutex::new(pc_name),
        }),
    };

    let h = handle.clone();
    tokio::spawn(async move {
        run_bridge(h).await;
    });
    handle
}

/// 桥的主循环：连接 → 注册 → 心跳；断了就退避重连。
async fn run_bridge(handle: BridgeHandle) {
    let mut attempts: u32 = 0;
    loop {
        if handle.inner.stopped.load(Ordering::SeqCst) {
            return;
        }
        *handle.inner.state.lock().unwrap() = BridgeState::Connecting;

        let url = handle.inner.url.lock().unwrap().clone();
        match connect_once(&handle, &url).await {
            ConnectOutcome::Registered(ws) => {
                attempts = 0;
                *handle.inner.state.lock().unwrap() = BridgeState::Registered;
                // 注册成功后进入收发 + 心跳循环，直到断开。
                if let Some(code) = serve_connection(&handle, ws).await {
                    if code == 4403 {
                        // 鉴权被拒：**停止重连**并明确告诉用户该做什么。
                        eprintln!("注册被服务端拒绝（设备令牌无效、已过期或已被吊销），已停止重连。");
                        eprintln!("请重新登录: mn-ws auth login");
                        *handle.inner.state.lock().unwrap() = BridgeState::Error;
                        return;
                    }
                    attempts = 0;
                }
            }
            ConnectOutcome::AuthRejected => {
                eprintln!("注册被服务端拒绝（设备令牌无效、已过期或已被吊销），已停止重连。");
                eprintln!("请重新登录: mn-ws auth login");
                *handle.inner.state.lock().unwrap() = BridgeState::Error;
                return;
            }
            ConnectOutcome::Failed(e) => {
                let delay = Duration::from_millis(
                    (RECONNECT_BASE_MS * 2u64.pow(attempts.min(5))).min(RECONNECT_MAX_MS),
                );
                attempts = attempts.saturating_add(1);
                *handle.inner.state.lock().unwrap() = BridgeState::Reconnecting;
                eprintln!("连接断开（{e}），{delay:?} 后重连");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

enum ConnectOutcome {
    /// 注册成功，把 ws 交出去进入收发循环。
    Registered(WsStream),
    /// 服务端以 4403 拒绝注册 —— 鉴权失败，不该重连。
    AuthRejected,
    /// 连接失败/异常。
    Failed(String),
}

/// 已建立的 WS 连接。
type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// 建立一次连接并完成注册。
async fn connect_once(handle: &BridgeHandle, url: &str) -> ConnectOutcome {
    if url.is_empty() {
        return ConnectOutcome::Failed("未配置 server 地址".into());
    }
    let connect_url = match normalize_ws_url(url) {
        Ok(u) => u,
        Err(e) => return ConnectOutcome::Failed(e),
    };

    let (mut ws, _) = match tokio_tungstenite::connect_async(&connect_url).await {
        Ok(v) => v,
        Err(e) => return ConnectOutcome::Failed(format!("连不上 {url}: {e}")),
    };
    *handle.inner.state.lock().unwrap() = BridgeState::Connected;

    // 注册帧：app 表 + 元信息 + 电脑名 + 令牌
    let apps: Vec<Value> = handle
        .inner
        .apps
        .lock()
        .unwrap()
        .iter()
        .map(|(name, base)| {
            let port = base
                .rsplit(':')
                .next()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(0);
            json!({"app": name, "base": base, "port": port, "title": name})
        })
        .collect();
    let mut reg = json!({
        "type": protocol::frame_type::REGISTER,
        "role": "bridge",
        "bridgeId": handle.inner.bridge_id.lock().unwrap().clone(),
        "apps": apps,
        "token": handle.inner.token.lock().unwrap().clone(),
    });
    let pc = handle.inner.pc_name.lock().unwrap().clone();
    if !pc.is_empty() {
        reg["name"] = json!(pc);
    }
    if let Err(e) = ws.send(Message::Text(protocol::encode_frame(&reg))).await {
        return ConnectOutcome::Failed(format!("注册帧发不出去: {e}"));
    }

    // 等服务端确认注册（registered）或拒绝（error + 4403）。
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let msg = tokio::time::timeout(Duration::from_secs(15), ws.next()).await;
        let Ok(Some(Ok(m))) = msg else {
            return ConnectOutcome::Failed("注册无应答".into());
        };
        let text = match m {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => return ConnectOutcome::Failed("连接被关".into()),
            _ => continue,
        };
        let Some(frame) = protocol::decode_frame(&text) else {
            continue;
        };
        match frame.get("type").and_then(|v| v.as_str()) {
            Some(protocol::frame_type::REGISTERED) => return ConnectOutcome::Registered(ws),
            Some(protocol::frame_type::ERROR) => {
                let err = frame.get("error").and_then(|v| v.as_str()).unwrap_or("");
                if err == "invalid_token" {
                    return ConnectOutcome::AuthRejected;
                }
                return ConnectOutcome::Failed(format!("服务端报错: {err}"));
            }
            _ => {}
        }
    }
    ConnectOutcome::Failed("注册超时".into())
}

/// 收发 + 心跳的主循环。
///
/// 返回 Some(关闭码) 表示连接已断（外层据此决定重连还是停），None 表示被主动停掉。
///
/// ## 为什么拆成收发两半
///
/// 数据面处理一个慢请求时（比如目标服务要 20 秒），心跳不能被堵住 ——
/// 心跳被堵住的后果是「连接其实死了但我们以为活着」，
/// 症状是面板显示已连接、实际一帧都发不出去（TCP 半开）。
async fn serve_connection(handle: &BridgeHandle, ws: WsStream) -> Option<u16> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let (mut sink, mut stream) = ws.split();

    // 发帧的通道：数据面与心跳都往这里写。
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    // 心跳任务
    let heartbeat_tx = tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
        ticker.tick().await; // 第一次立即返回，先跳过
        loop {
            ticker.tick().await;
            if heartbeat_tx.send(json!({"type": protocol::frame_type::PING})).is_err() {
                break;
            }
        }
    });

    // 写侧任务：把通道里的帧写进 WS
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let text = protocol::encode_frame(&frame);
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // 数据面：收到 request 帧 → 打本机 HTTP → 回帧（经 tx 写回 WS）
    let apps: HashMap<String, String> = handle
        .inner
        .apps
        .lock()
        .unwrap()
        .iter()
        .map(|(n, b)| (n.clone(), b.clone()))
        .collect();
    let tx_for_data = tx.clone();
    let data = crate::data_plane::BridgeClient::new(
        apps,
        Arc::new(move |frame: Value| {
            let _ = tx_for_data.send(frame);
        }),
    );
    let data = Arc::new(data);

    // 收侧循环
    let mut close_code: Option<u16> = None;
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(frame) => {
                close_code = frame.map(|f| u16::from(f.code));
                break;
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        let Some(frame) = protocol::decode_frame(&text) else {
            continue;
        };
        match frame.get("type").and_then(|v| v.as_str()) {
            Some(protocol::frame_type::REQUEST) => {
                let d = data.clone();
                let f = frame.clone();
                tokio::spawn(async move { d.handle_request(&f).await; });
            }
            Some(protocol::frame_type::ABORT) => {
                let id = frame.get("id").and_then(|v| v.as_str()).unwrap_or("");
                data.abort(id).await;
            }
            Some(protocol::frame_type::PING) => {
                let _ = tx.send(json!({"type": protocol::frame_type::PONG}));
            }
            Some(protocol::frame_type::SHUTDOWN) => {
                *handle.inner.state.lock().unwrap() = BridgeState::Shutdown;
            }
            Some(protocol::frame_type::ERROR) => {
                let err = frame.get("error").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!("服务端报错: {err}");
            }
            _ => {}
        }
    }

    heartbeat.abort();
    writer.abort();
    data.abort_all().await;
    close_code
}

/// 桥的主收发任务（连接建立后调用）。
///
/// 拆成收发两半：读侧处理 server 的请求帧，写侧给心跳与响应用。
async fn bridge_task(_handle: &BridgeHandle) -> Option<u16> {
    // TODO(实现期)：真实的 WS 收发循环。
    // 见 docs/RUST-CLIENT-EVAL.md 的阶段 2。
    None
}

/// 补全 ws:// / wss:// 前缀。
fn normalize_ws_url(url: &str) -> Result<String, String> {
    if url.starts_with("ws://") || url.starts_with("wss://") {
        return Ok(url.to_string());
    }
    if url.starts_with("http://") {
        return Ok(format!("ws://{}", &url["http://".len()..]));
    }
    if url.starts_with("https://") {
        return Ok(format!("wss://{}", &url["https://".len()..]));
    }
    Err(format!("不是合法的 ws 地址: {url}"))
}

/// 全局状态标签（给 CLI 的 status 用）。
pub fn state_label() -> &'static str {
    "已停止"
}

/// 拉远端目录（server 半的 /api/catalog）。
pub async fn fetch_catalog(cfg: &serde_json::Map<String, Value>) -> Result<Value, String> {
    let base = cfg
        .get("serverHttp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    if base.is_empty() {
        return Err("缺少服务端地址（serverHttp）".into());
    }
    let token = cfg
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/api/catalog"))
        .header("X-Mn-Ws-Token", token)
        .send()
        .await
        .map_err(|e| format!("连不上 {base}: {e}"))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("响应不是 JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_normalization() {
        assert_eq!(normalize_ws_url("ws://a/b").unwrap(), "ws://a/b");
        assert_eq!(normalize_ws_url("http://a/b").unwrap(), "ws://a/b");
        assert_eq!(normalize_ws_url("https://a/b").unwrap(), "wss://a/b");
        assert!(normalize_ws_url("ftp://a").is_err());
    }

    #[test]
    fn state_labels_match_ts() {
        assert_eq!(BridgeState::Registered.label(), "已注册");
        assert_eq!(BridgeState::Reconnecting.label(), "重连中");
        assert_eq!(BridgeState::Error.label(), "出错");
    }
}
