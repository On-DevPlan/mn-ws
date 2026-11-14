//! mn-ws server —— 公网侧的 HTTP ⇄ WebSocket 桥。
//!
//! 一个端口同时提供：
//!   · HTTP 面：/health /stats /clients /auth/* /api/catalog 以及 /<app>/* 桥接入口
//!   · WS  面：/ws —— 与本机 client half 的长连接
//!
//! ## 三层鉴权（缺一不可）
//!
//!   L1 通道层：谁能接入这个桥
//!      · 设备令牌（go-ah 统一登录签发，带 userId）→ 只能访问**自己名下**的桥
//!      · 静态门禁 token（MN_WS_TOKEN）→ 等价于全量访问（共享密钥，慎用）
//!   L2 路由层：请求的 app 必须在该桥的注册表里，且属主匹配
//!   L3 应用层：原始 Authorization / Cookie 原样透传给 nx，nx 自己那套鉴权照常生效
//!
//! ## 路由表按 app 索引
//!
//! bridges: app → 桥。一个 app 同时只有一个桥（后来者顶替前者）——
//! 同一台机器跑两份 nx 是异常状态，顶替比随机命中更可预期。

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use mn_ws_core::apps::{describe_app, resolve_app, AppDescriptor, ResolvedApp};
use mn_ws_core::protocol::{
    self, decode_frame, encode_frame, flatten_headers, next_request_id, normalize_headers,
    strip_response_headers, ProtocolHeaders,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::auth::{AuthHub, AuthError};
use crate::config::ServerConfig;
use crate::logger::Logger;
use crate::store::Store;

/// 心跳间隔（毫秒）：每轮 ping 一次所有连接。
///
/// 取 15s 的理由：既要快到「服务端发现死桥」不至于让路由表长期挂着僵尸，
/// 又要慢到不打扰正常链路（一条空闲的桥每 15s 一个 ping，开销可以忽略）。
const HEARTBEAT_INTERVAL_MS: u64 = 15_000;

/// 请求头：指定这次请求打**哪台 PC**。
///
/// 值是 bridgeId（client 半的稳定标识）。
const PC_HEADER: &str = "x-mn-ws-pc";

/// 一条等待中的请求。
struct Pending {
    /// 回给 HTTP 客户端的响应体
    responder: oneshot::Sender<Result<(u16, ProtocolHeaders, Vec<u8>), String>>,
    bridge_id: String,
    app: String,
    started_at: Instant,
}

/// 一条已注册的桥（路由表的一项）。
#[derive(Clone)]
struct Bridge {
    peer_id: usize,
    bridge_id: String,
    user_id: String,
    is_gate: bool,
    apps: Vec<AppDescriptor>,
    connected_at: String,
    ip: Option<String>,
}

/// 一台已注册的 **PC**（client half 所在的机器）。
#[derive(Clone)]
struct PcEntry {
    bridge_id: String,
    /// 电脑名（client 自报）；client 没报就用 bridgeId 兜底
    name: String,
    peer_id: usize,
    user_id: String,
    is_gate: bool,
    apps: Vec<AppDescriptor>,
    connected_at: String,
    ip: Option<String>,
}

/// 一条 WS 连接。
struct PeerMeta {
    peer_id: usize,
    bridge_id: Option<String>,
    user_id: Option<String>,
    registered: bool,
    connected_at: String,
    ip: Option<String>,
    is_gate: bool,
    /// 这条连接**注册过的** app 表（不限于它当前持有的）。
    ///
    /// 记它是为了「顶替后归还」：同一个 app 被新桥顶替时，旧桥那条记录会从
    /// bridges 里删掉，但**旧桥仍然连着**。新桥一旦先断开，服务端若只是把 app
    /// 摘干净，这个 app 就成了「没人能路由」——旧桥明明活着却再也接不到请求。
    app_list: Vec<AppDescriptor>,
    pc_name: String,
}

/// 调用方身份。
enum Caller {
    Ok { user_id: String, is_gate: bool },
    Denied { status: u16, error: &'static str },
}

/// 统计。
#[derive(Default, Clone)]
struct Stats {
    connections: u64,
    requests_in: u64,
    forwarded: u64,
    offline: u64,
    rejected: u64,
    errors: u64,
    bytes_in: u64,
    bytes_out: u64,
}

/// server 半的运行时状态。
struct State {
    /// app → 桥（**路由表**：app 名该打到哪条连接上）
    bridges: Mutex<HashMap<String, Bridge>>,
    /// bridgeId → PC（**展示表**：每台 PC 一条，互不顶替）。
    pcs: Mutex<HashMap<String, PcEntry>>,
    /// 曾经注册过的 app 名 —— 用来区分「从没这个应用」与「这个应用的桥掉线了」
    known_apps: Mutex<Vec<String>>,
    /// requestId → 等待中的请求
    pending: Mutex<HashMap<String, Pending>>,
    /// peer_id → 连接元信息
    peers: Mutex<HashMap<usize, PeerMeta>>,
    /// peer_id → 帧发送通道
    senders: Mutex<HashMap<usize, mpsc::UnboundedSender<Value>>>,
    stats: Mutex<Stats>,
    next_peer_id: AtomicU64,
}

/// server 半的构造参数。
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    pub ws_path: String,
    pub token: String,
    pub issuer: String,
    pub idp_client_id: String,
    pub login_client_id: String,
    pub redirect_uri: String,
    pub jwt_secret: String,
    pub auth_enabled: bool,
    pub request_timeout_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub data_dir: Option<std::path::PathBuf>,
    pub log_level: String,
}

impl Default for ServerOptions {
    fn default() -> Self {
        ServerOptions {
            host: "0.0.0.0".to_string(),
            port: 7777,
            ws_path: "/ws".to_string(),
            token: String::new(),
            issuer: "http://47.110.80.47:8082".to_string(),
            idp_client_id: "mn-ws-server".to_string(),
            login_client_id: "mn-ws-client".to_string(),
            redirect_uri: String::new(),
            jwt_secret: String::new(),
            auth_enabled: false,
            request_timeout_ms: protocol::DEFAULT_REQUEST_TIMEOUT_MS,
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            data_dir: None,
            log_level: "info".to_string(),
        }
    }
}

/// 起一个 server。返回监听地址。
pub async fn run(opts: ServerOptions) -> std::io::Result<SocketAddr> {
    let config = ServerConfig {
        host: opts.host.clone(),
        port: opts.port,
        ws_path: opts.ws_path.clone(),
        token: opts.token.clone(),
        issuer: opts.issuer.clone(),
        idp_client_id: opts.idp_client_id.clone(),
        login_client_id: opts.login_client_id.clone(),
        redirect_uri: opts.redirect_uri.clone(),
        jwt_secret: opts.jwt_secret.clone(),
        auth_enabled: Some(opts.auth_enabled),
        insecure: false,
        request_timeout_ms: opts.request_timeout_ms,
        log_level: opts.log_level.clone(),
        data_dir: opts.data_dir.clone(),
    };

    let logger = Arc::new(Logger::new(
        &opts.log_level,
        opts.data_dir.as_deref(),
        "mn-ws-server",
    ));
    let store = Arc::new(Store::new(
        opts.data_dir.as_deref(),
        "requests.jsonl",
        200,
    ));
    let auth = Arc::new(AuthHub::new(
        opts.auth_enabled,
        &opts.issuer,
        &opts.idp_client_id,
        &opts.login_client_id,
        &opts.redirect_uri,
        &opts.jwt_secret,
        opts.data_dir.as_deref(),
    ));

    let state = Arc::new(State {
        bridges: Mutex::new(HashMap::new()),
        pcs: Mutex::new(HashMap::new()),
        known_apps: Mutex::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        peers: Mutex::new(HashMap::new()),
        senders: Mutex::new(HashMap::new()),
        stats: Mutex::new(Stats::default()),
        next_peer_id: AtomicU64::new(1),
    });

    let addr: SocketAddr = format!("{}:{}", opts.host, opts.port)
        .parse()
        .map_err(|e: std::net::AddrParseError| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, e.to_string())
        })?;
    let listener: tokio::net::TcpListener = tokio::net::TcpListener::bind(addr).await?;

    // 心跳：回收已经死了的连接。
    //
    // 为什么必须有：TCP 是**半开**的 —— 容器被 `docker rm` 掉时对端不一定
    // 发来 FIN/RST（跨境链路 + 运营商 NAT 下 RST 会丢）。没有心跳，服务端会
    // 一直留着一条**已经死了**的桥：那台机器上的 app 还在路由表里，
    // 请求转发过去全部超时，而桥自己早就不知道了。
    {
        let state = state.clone();
        let interval = opts.heartbeat_interval_ms;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(interval));
            ticker.tick().await; // 第一次立即返回，先跳过
            loop {
                ticker.tick().await;
                let senders: Vec<mpsc::UnboundedSender<Value>> =
                    state.senders.lock().unwrap().values().cloned().collect();
                for tx in senders {
                    // 应用层 ping：收到 pong 才算这一轮还活着（见 WS 层）。
                    let _ = tx.send(json!({ "type": protocol::frame_type::PING }));
                }
            }
        });
    }

    let local = listener.local_addr()?;
    let ws_path = opts.ws_path.clone();
    let logger_svc = logger.clone();
    let state_svc = state.clone();
    let auth_svc = auth.clone();
    let store_svc = store.clone();
    let config_svc = config.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, peer_addr)) = listener.accept().await else {
                break;
            };
            let io = TokioIo::new(stream);
            let state = state_svc.clone();
            let logger = logger_svc.clone();
            let auth = auth_svc.clone();
            let store = store_svc.clone();
            let config = config_svc.clone();
            let ws_path = ws_path.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let state = state.clone();
                    let logger = logger.clone();
                    let auth = auth.clone();
                    let store = store.clone();
                    let config = config.clone();
                    let ws_path = ws_path.clone();
                    async move {
                        Ok::<_, Infallible>(
                            route(req, state, logger, auth, store, config, ws_path, peer_addr)
                                .await,
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, service)
                    .with_upgrades()
                    .await;
            });
        }
    });

    logger.info(
        "mn-ws server 已启动",
        Some(&json!({ "addr": local.to_string(), "wsPath": opts.ws_path })),
    );

    // 预热统一登录的发现文档（后台、幂等、带重试）。
    //
    // 为什么必须预热：`/auth/oidc/config` 报的 `idpAvailable` 含义是
    // 「**成功拉到过**发现文档」，而不是「认证中心在线」。
    // 不预热的话这个字段永远是 false —— 而部署脚本正是拿它断言
    // 「统一登录确实生效」，于是一个完全正常的部署会被判成失败。
    //
    // 为什么带重试：容器可能比认证中心先起来（编排顺序不保证），
    // 第一次失败就放弃 = 统一登录一直不可用，直到人工重启。
    //
    // 失败不固化缓存（AuthHub 只缓存成功的结果），所以重试是有效的。
    {
        let auth = auth.clone();
        let logger = logger.clone();
        tokio::spawn(async move {
            for attempt in 1..=DISCOVERY_WARMUP_MAX_ATTEMPTS {
                match auth.discover().await {
                    Ok(_) => {
                        logger.info(
                            "统一登录发现文档就绪",
                            Some(&json!({ "issuer": auth.issuer, "attempt": attempt })),
                        );
                        return;
                    }
                    Err(e) => {
                        logger.warn(
                            "发现文档拉取失败，稍后重试",
                            Some(&json!({ "attempt": attempt, "error": e.message })),
                        );
                        if attempt < DISCOVERY_WARMUP_MAX_ATTEMPTS {
                            tokio::time::sleep(Duration::from_millis(
                                DISCOVERY_WARMUP_RETRY_MS,
                            ))
                            .await;
                        }
                    }
                }
            }
        });
    }

    Ok(local)
}

/// 发现文档预热的重试参数（次 / 毫秒）。
const DISCOVERY_WARMUP_MAX_ATTEMPTS: u32 = 10;
const DISCOVERY_WARMUP_RETRY_MS: u64 = 15_000;

/// HTTP 路由。
#[allow(clippy::too_many_arguments)]
async fn route(
    req: Request<Incoming>,
    state: Arc<State>,
    logger: Arc<Logger>,
    auth: Arc<AuthHub>,
    store: Arc<Store>,
    config: ServerConfig,
    ws_path: String,
    peer_addr: SocketAddr,
) -> Response<Full<Bytes>> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // ── WS 升级 ────────────────────────────────────────────────────
    // 同一个端口既跑 HTTP 又跑 WS（与 TS 版 `WebSocketServer({server})` 一致）。
    if path == ws_path && is_ws_upgrade(&req) {
        return upgrade_to_ws(req, state, logger, auth, store, config, peer_addr).await;
    }

    if method == Method::OPTIONS {
        return Response::new(Full::new(Bytes::new()));
    }

    // ── 公开端点 ───────────────────────────────────────────────────
    if path == "/health" {
        let bridges = state.bridges.lock().unwrap().len();
        let pending = state.pending.lock().unwrap().len();
        return send_json(
            200,
            json!({
                "ok": true,
                "service": "mn-ws-server",
                "uptime": uptime_secs(),
                "bridges": bridges,
                "pending": pending,
                "authEnabled": config.auth_enabled,
            }),
        );
    }

    if path == "/stats" {
        let stats = state.stats.lock().unwrap().clone();
        let apps: Vec<String> = state.bridges.lock().unwrap().keys().cloned().collect();
        let pending = state.pending.lock().unwrap().len();
        return send_json(
            200,
            json!({
                "ok": true,
                "stats": stats_json(&stats),
                "apps": apps,
                "pending": pending,
            }),
        );
    }

    // ── 统一登录的公开参数（绝不含 secret）────────────────────────
    if path == "/auth/oidc/config" {
        let cfg = auth.public_config();
        return send_json(
            200,
            json!({
                "ok": true,
                "enabled": cfg.enabled,
                "issuer": cfg.issuer,
                "clientId": cfg.client_id,
                "loginClientId": cfg.login_client_id,
                "redirectUri": cfg.redirect_uri,
                "scopes": cfg.scopes,
                "authorizationEndpoint": cfg.authorization_endpoint,
                "tokenEndpoint": cfg.token_endpoint,
                "idpAvailable": cfg.idp_available,
                "idpError": cfg.idp_error,
            }),
        );
    }

    // ── 授权码 → 本服务的令牌（业务令牌端点）──────────────────────
    if path == "/auth/oidc/callback" && method == Method::POST {
        let body = match read_body(req).await {
            Ok(b) => b,
            Err(_) => {
                return send_json(
                    400,
                    json!({ "ok": false, "error": "bad_request", "message": "请求体读不出来" }),
                )
            }
        };
        let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let verifier = body.get("codeVerifier").and_then(|v| v.as_str()).unwrap_or("");
        let redirect = body.get("redirectUri").and_then(|v| v.as_str());

        let who = match auth.exchange(code, verifier, redirect).await {
            Ok(w) => w,
            Err(e) => {
                let status = if e.code == "bad_request" { 400 } else { 401 };
                return send_json(
                    status,
                    json!({
                        "ok": false,
                        "error": e.code,
                        "message": e.message,
                    }),
                );
            }
        };

        let mut out = json!({
            "ok": true,
            "userId": who.user_id,
            "sub": who.sub,
            "email": who.email,
            "username": who.preferred_username,
            "nickname": who.name,
        });

        let client_id = body
            .get("clientId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let device_name = body
            .get("deviceName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if !client_id.is_empty() {
            if let Err(e) = auth.register_device(&client_id, &who.user_id, &device_name) {
                // 这台设备已属于别的账号：不发令牌、不改绑。
                // 能确定的只有「归属不在你这」，不该悄悄换成新账号。
                return send_json(
                    403,
                    json!({
                        "ok": false,
                        "error": e.code,
                        "message": e.message,
                    }),
                );
            }
        }

        let dn = if !device_name.is_empty() {
            device_name
        } else if !client_id.is_empty() {
            String::new()
        } else {
            "phone".to_string()
        };
        return match auth.issue_device_token(&who.user_id, &client_id, &dn) {
            Ok(issued) => {
                if let Some(o) = out.as_object_mut() {
                    o.insert("token".into(), json!(issued.token));
                    o.insert("tokenExpiresAt".into(), json!(issued.expires_at));
                    o.insert("jti".into(), json!(issued.jti));
                    if !client_id.is_empty() {
                        o.insert("clientId".into(), json!(client_id));
                    }
                }
                send_json(200, out)
            }
            Err(e) => send_json(
                500,
                json!({ "ok": false, "error": e.code, "message": e.message }),
            ),
        }
    }

    // ── 用认证中心的 access_token 换本服务的设备令牌 ──────────────
    //
    // 注意这里读的是 **Authorization**：这一段是「拿认证中心的令牌换设备令牌」，
    // 与 L1 的 X-Mn-Ws-Token 不是一回事。
    if path == "/auth/verify" && method == Method::POST {
        // bearer 要在读 body 之前取 —— `read_body` 会把 req 拿走。
        let bearer = authorization_bearer_of(&req);
        let body = match read_body(req).await {
            Ok(b) => b,
            Err(_) => {
                return send_json(
                    400,
                    json!({ "ok": false, "error": "bad_request", "message": "请求体读不出来" }),
                )
            }
        };
        let body: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
        let identity = match auth.verify_bearer(&bearer).await {
            Ok(i) => i,
            Err(e) => {
                return send_json(
                    401,
                    json!({ "ok": false, "error": e.code, "message": e.message }),
                )
            }
        };
        let client_id = body
            .get("clientId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if client_id.is_empty() {
            return send_json(
                400,
                json!({ "ok": false, "error": "缺少 clientId", "code": "bad_request" }),
            );
        }
        let device_name = body
            .get("deviceName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Err(e) = auth.register_device(&client_id, &identity.user_id, &device_name) {
            return send_json(
                403,
                json!({ "ok": false, "error": e.code, "message": e.message }),
            );
        }
        return match auth.issue_device_token(&identity.user_id, &client_id, &device_name) {
            Ok(issued) => send_json(
                200,
                json!({
                    "ok": true,
                    "userId": identity.user_id,
                    "email": identity.email,
                    "username": identity.preferred_username,
                    "nickname": identity.name,
                    "token": issued.token,
                    "tokenExpiresAt": issued.expires_at,
                    "clientId": client_id,
                    "deviceName": device_name,
                }),
            ),
            Err(e) => send_json(
                500,
                json!({ "ok": false, "error": e.code, "message": e.message }),
            ),
        };
    }

    // ── 元信息目录：登录后拉「哪些可以路由」────────────────────────
    if path == "/api/catalog" {
        let caller = identify_caller(&req, &config, &auth);
        let (user_id, is_gate) = match caller {
            Caller::Ok { user_id, is_gate } => (user_id, is_gate),
            Caller::Denied { status, error } => {
                return send_json(status, json!({ "ok": false, "error": error }))
            }
        };
        return send_json(200, build_catalog(&state, &user_id, is_gate));
    }

    // ── 已注册桥的清单（要鉴权）──────────────────────────────────
    if path == "/clients" {
        let caller = identify_caller(&req, &config, &auth);
        let (user_id, is_gate) = match caller {
            Caller::Ok { user_id, is_gate } => (user_id, is_gate),
            Caller::Denied { status, error } => {
                return send_json(status, json!({ "ok": false, "error": error }))
            }
        };
        let bridges = state.bridges.lock().unwrap();
        let mut list: Vec<Value> = Vec::new();
        for (app, b) in bridges.iter() {
            if !is_gate && b.user_id != user_id {
                continue;
            }
            list.push(json!({
                "app": app,
                "bridgeId": b.bridge_id,
                "userId": b.user_id,
                "connectedAt": b.connected_at,
            }));
        }
        let count = list.len();
        return send_json(200, json!({ "ok": true, "count": count, "bridges": list }));
    }

    // ── 桥接入口：/<app>/* ───────────────────────────────────────
    bridge_entry(
        req, state, logger, auth, store, config, method, path,
    )
    .await
}

/// 桥接入口：把 HTTP 请求转成帧发给桥，响应原路写回。
async fn bridge_entry(
    req: Request<Incoming>,
    state: Arc<State>,
    logger: Arc<Logger>,
    auth: Arc<AuthHub>,
    store: Arc<Store>,
    config: ServerConfig,
    method: Method,
    path: String,
) -> Response<Full<Bytes>> {
    let req_headers = normalize_headers(&headers_to_value(&req));
    let (app, rest_path) = match resolve_app(&path, &req_headers) {
        ResolvedApp::Resolved { app, path } => (app, path),
        ResolvedApp::Error(e) => {
            state.stats.lock().unwrap().rejected += 1;
            return send_json(400, json!({ "ok": false, "error": e }));
        }
    };

    let (caller_user, is_gate) = match identify_caller(&req, &config, &auth) {
        Caller::Ok { user_id, is_gate } => (user_id, is_gate),
        Caller::Denied { status, error } => {
            return send_json(status, json!({ "ok": false, "error": error }));
        }
    };

    // ── 选哪台 PC 来服务这个请求 ───────────────────────────────
    // 默认按路由表（app 名 → 桥，撞名时后来者接管）。
    // 但**多台 PC 可能有同名 app**（两台机器都跑 nx-kv），这时调用方可以
    // 用 `X-Mn-Ws-Pc: <bridgeId>` 指定打哪一台。
    let mut bridge = state.bridges.lock().unwrap().get(&app).cloned();
    let pc_hint = protocol::header_value(&req_headers, PC_HEADER).unwrap_or("");
    if !pc_hint.is_empty() {
        let pcs = state.pcs.lock().unwrap();
        match pcs.get(pc_hint) {
            Some(pc) if pc.apps.iter().any(|a| a.app == app) => {
                bridge = Some(Bridge {
                    peer_id: pc.peer_id,
                    bridge_id: pc.bridge_id.clone(),
                    user_id: pc.user_id.clone(),
                    is_gate: pc.is_gate,
                    apps: pc.apps.clone(),
                    connected_at: pc.connected_at.clone(),
                    ip: pc.ip.clone(),
                });
            }
            _ => {
                // 指定了但不在这台 PC 上 → 明确说，别默默打到另一台去
                state.stats.lock().unwrap().rejected += 1;
                return send_json(
                    404,
                    json!({ "ok": false, "error": "unknown_pc_app", "app": app, "pc": pc_hint }),
                );
            }
        }
    }

    let Some(bridge) = bridge else {
        state.stats.lock().unwrap().offline += 1;
        // 区分两种「没有」：这个应用从来没注册过（404），
        // 还是注册过但桥掉线了（502，桥会自动重连）。
        let known = state.known_apps.lock().unwrap().iter().any(|a| a == &app);
        store.append(json!({
            "app": app,
            "method": method.as_str(),
            "path": rest_path,
            "status": if known { 502 } else { 404 },
            "userId": caller_user,
        }));
        return send_json(
            if known { 502 } else { 404 },
            json!({
                "ok": false,
                "error": if known { "bridge_offline" } else { "unknown_app" },
                "app": app,
            }),
        );
    };

    // ── 属主校验（L2）──────────────────────────────────────────
    if !is_gate && bridge.user_id != caller_user {
        state.stats.lock().unwrap().rejected += 1;
        logger.warn(
            "rejected: 跨属主访问",
            Some(&json!({ "app": app, "userId": caller_user, "owner": bridge.user_id })),
        );
        store.append(json!({
            "app": app,
            "method": method.as_str(),
            "path": rest_path,
            "status": 403,
            "userId": caller_user,
        }));
        return send_json(403, json!({ "ok": false, "error": "forbidden", "app": app }));
    }

    state.stats.lock().unwrap().requests_in += 1;

    // query 要在 body 之前取 —— `read_body` 会把 req 拿走。
    let query = query_of(&req);
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => {
            state.stats.lock().unwrap().rejected += 1;
            return send_json(
                413,
                json!({ "ok": false, "error": "body_too_large", "limit": protocol::MAX_BODY_BYTES }),
            );
        }
    };
    state.stats.lock().unwrap().bytes_in += body.len() as u64;

    let id = next_request_id("r");
    let headers = req_headers;
    let frame = json!({
        "type": protocol::frame_type::REQUEST,
        "id": id,
        "app": app,
        "method": method.as_str(),
        "path": rest_path,
        "query": query,
        "headers": headers_to_value_json(&headers),
        "body": base64_encode(&body),
        "ts": crate::store::now_ms(),
    });

    let (tx, rx) = oneshot::channel();
    let timer = tokio::time::timeout(
        Duration::from_millis(config.request_timeout_ms),
        rx,
    );
    state.pending.lock().unwrap().insert(
        id.clone(),
        Pending {
            responder: tx,
            bridge_id: bridge.bridge_id.clone(),
            app: app.clone(),
            started_at: Instant::now(),
        },
    );

    let sent = {
        let senders = state.senders.lock().unwrap();
        senders.get(&bridge.peer_id).cloned()
    };
    let Some(tx) = sent else {
        // 桥刚断 —— 摘掉它，重来一次路由判定。
        state.pending.lock().unwrap().remove(&id);
        state.stats.lock().unwrap().errors += 1;
        return send_json(
            502,
            json!({ "ok": false, "error": "bridge_offline", "app": app }),
        );
    };
    if tx.send(frame).is_err() {
        state.pending.lock().unwrap().remove(&id);
        state.stats.lock().unwrap().errors += 1;
        return send_json(
            502,
            json!({ "ok": false, "error": "bridge_send_failed", "app": app }),
        );
    }
    state.stats.lock().unwrap().forwarded += 1;

    // 等桥的响应（或超时）。
    match timer.await {
        Ok(Ok(Ok((status, resp_headers, resp_body)))) => {
            state.stats.lock().unwrap().bytes_out += resp_body.len() as u64;
            store.append(json!({
                "app": app,
                "status": status,
                "bytes": resp_body.len(),
                "durationMs": state
                    .pending
                    .lock()
                    .unwrap()
                    .get(&id)
                    .map(|p| p.started_at.elapsed().as_millis() as u64)
                    .unwrap_or(0),
            }));
            let mut headers_out: Vec<(String, String)> = Vec::new();
            for (k, values) in flatten_headers(&strip_response_headers(&resp_headers), &["set-cookie"]) {
                for v in values {
                    headers_out.push((k.clone(), v));
                }
            }
            // content-length 由我们自己算：body 可能被 base64 往返过
            headers_out.push(("content-length".to_string(), resp_body.len().to_string()));
            let mut resp = Response::new(Full::new(Bytes::from(resp_body)));
            *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
            for (k, v) in headers_out {
                if let (Ok(name), Ok(value)) = (
                    hyper::header::HeaderName::from_bytes(k.as_bytes()),
                    hyper::header::HeaderValue::from_str(&v),
                ) {
                    resp.headers_mut().append(name, value);
                }
            }
            resp
        }
        Ok(Ok(Err(msg))) => {
            state.stats.lock().unwrap().errors += 1;
            send_json(
                502,
                json!({ "ok": false, "error": "bridge_error", "detail": msg, "app": app }),
            )
        }
        Ok(Err(_)) => {
            // 等待通道被丢弃（桥断了）
            state.stats.lock().unwrap().errors += 1;
            send_json(
                502,
                json!({ "ok": false, "error": "bridge_disconnected", "app": app }),
            )
        }
        Err(_) => {
            // 超时
            state.pending.lock().unwrap().remove(&id);
            state.stats.lock().unwrap().errors += 1;
            store.append(json!({
                "app": app,
                "method": method.as_str(),
                "path": rest_path,
                "status": 504,
                "userId": caller_user,
            }));
            send_json(
                504,
                json!({ "ok": false, "error": "bridge_timeout", "app": app }),
            )
        }
    }
}

/// 构造目录（两份视图：按 PC 分组 + 扁平列表）。
fn build_catalog(state: &Arc<State>, user_id: &str, is_gate: bool) -> Value {
    let visible = |u: &str| is_gate || u == user_id;
    let bridges = state.bridges.lock().unwrap();
    let pcs = state.pcs.lock().unwrap();

    let mut groups: Vec<Value> = Vec::new();
    for pc in pcs.values() {
        if !visible(&pc.user_id) {
            continue;
        }
        let apps: Vec<Value> = pc
            .apps
            .iter()
            .map(|m| {
                json!({
                    "app": m.app,
                    "title": m.title,
                    "port": m.port,
                    "base": m.base,
                    "bridgeId": pc.bridge_id,
                    // 这个 app 名现在路由到谁那儿 —— 路由表里的主人
                    "active": bridges.get(&m.app).map(|b| b.bridge_id == pc.bridge_id).unwrap_or(false),
                })
            })
            .collect();
        groups.push(json!({
            "bridgeId": pc.bridge_id,
            "name": pc.name,
            "userId": pc.user_id,
            "connectedAt": pc.connected_at,
            "apps": apps,
        }));
    }
    // 组内按名字排，组之间按电脑名排 —— 目录每次读出来顺序都一样，
    // 免得刷新一下顺序就变了、用户以为谁动了谁的。
    groups.sort_by(|a, b| {
        let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
        an.cmp(bn)
    });

    let mut list: Vec<Value> = Vec::new();
    for g in &groups {
        let gname = g.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let gconnected = g.get("connectedAt").cloned().unwrap_or(Value::Null);
        if let Some(apps) = g.get("apps").and_then(|v| v.as_array()) {
            for a in apps {
                let mut item = a.clone();
                if let Some(o) = item.as_object_mut() {
                    o.insert("pcName".into(), json!(gname));
                    o.insert("connectedAt".into(), gconnected.clone());
                    // 路由不到这台 PC 时明确标出来
                    let active = o.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                    o.remove("active");
                    o.insert("pcNameMissing".into(), json!(!active));
                }
                list.push(item);
            }
        }
    }

    let count = list.len();
    let pc_count = groups.len();
    json!({
        "ok": true,
        "count": count,
        "apps": list,
        "pcs": groups,
        "pcCount": pc_count,
    })
}

/// 判定调用方身份（L1 通道层）。
fn identify_caller(req: &Request<Incoming>, config: &ServerConfig, auth: &AuthHub) -> Caller {
    let headers = normalize_headers(&headers_to_value(req));
    let gate = protocol::header_value(&headers, "x-mn-ws-token").unwrap_or("");
    if gate.is_empty() {
        return Caller::Denied {
            status: 401,
            error: "missing_mn_ws_token",
        };
    }
    // 设备令牌 → 具名用户，只能访问自己名下的桥
    if let Some(payload) = auth.verify_device_token(gate) {
        return Caller::Ok {
            user_id: payload.sub,
            is_gate: false,
        };
    }
    // 静态门禁 → 全量访问（共享密钥，慎用）
    if !config.token.is_empty() && gate == config.token {
        return Caller::Ok {
            user_id: "@gate".to_string(),
            is_gate: true,
        };
    }
    Caller::Denied {
        status: 401,
        error: "invalid_token",
    }
}

/// 判断是不是 WS 升级请求。
fn is_ws_upgrade(req: &Request<Incoming>) -> bool {
    let has = |name: &str| {
        req.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default()
    };
    has("upgrade").contains("websocket") && has("connection").contains("upgrade")
}

/// 升级到 WebSocket。
async fn upgrade_to_ws(
    mut req: Request<Incoming>,
    state: Arc<State>,
    logger: Arc<Logger>,
    auth: Arc<AuthHub>,
    store: Arc<Store>,
    config: ServerConfig,
    peer_addr: SocketAddr,
) -> Response<Full<Bytes>> {
    let key = req
        .headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if key.is_empty() {
        return send_json(400, json!({ "ok": false, "error": "缺少 Sec-WebSocket-Key" }));
    }
    // RFC 6455 的 accept key：base64(sha1(key + GUID))
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());

    let on_upgrade = hyper::upgrade::on(&mut req);

    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let io = TokioIo::new(upgraded);
        let ws = tokio_tungstenite::WebSocketStream::from_raw_socket(io, tokio_tungstenite::tungstenite::protocol::Role::Server, None).await;
        let peer_id = state.next_peer_id.fetch_add(1, Ordering::SeqCst) as usize;
        serve_peer(
            ws, peer_id, state, logger, auth, store, config, peer_addr,
        )
        .await;
    });

    // 101 Switching Protocols
    let mut resp = Response::new(Full::new(Bytes::new()));
    *resp.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let headers = resp.headers_mut();
    headers.insert(
        hyper::header::CONNECTION,
        hyper::header::HeaderValue::from_static("Upgrade"),
    );
    headers.insert(
        hyper::header::UPGRADE,
        hyper::header::HeaderValue::from_static("websocket"),
    );
    if let Ok(v) = hyper::header::HeaderValue::from_str(&accept) {
        headers.insert("sec-websocket-accept", v);
    }
    resp
}

/// 处理一条 WS 连接（直到断开）。
///
/// `S: 'static` 是必须的 —— 写侧任务被 `tokio::spawn` 出去，
/// 捕获的 sink 必须能活到 task 结束。
async fn serve_peer<S>(
    ws: tokio_tungstenite::WebSocketStream<S>,
    peer_id: usize,
    state: Arc<State>,
    logger: Arc<Logger>,
    auth: Arc<AuthHub>,
    store: Arc<Store>,
    config: ServerConfig,
    peer_addr: SocketAddr,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    state.senders.lock().unwrap().insert(peer_id, tx.clone());

    let connected_at = crate::logger::iso_now();
    state.peers.lock().unwrap().insert(
        peer_id,
        PeerMeta {
            peer_id,
            bridge_id: None,
            user_id: None,
            registered: false,
            connected_at: connected_at.clone(),
            ip: Some(peer_addr.ip().to_string()),
            is_gate: false,
            app_list: Vec::new(),
            pc_name: String::new(),
        },
    );
    state.stats.lock().unwrap().connections += 1;
    logger.info(
        "peer connected",
        Some(&json!({ "peerId": peer_id, "ip": peer_addr.ip().to_string() })),
    );

    // 连接后立即下发欢迎帧，便于客户端确认链路
    let _ = tx.send(json!({
        "type": protocol::frame_type::WELCOME,
        "peerId": format!("peer-{peer_id}"),
        "server": "mn-ws-server",
        "wsPath": config.ws_path,
        "protocol": protocol::PROTOCOL_VERSION,
    }));

    // 写侧任务
    let writer = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let text = encode_frame(&frame);
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // 收侧循环
    while let Some(msg) = stream.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        let Some(frame) = decode_frame(&text) else {
            state.stats.lock().unwrap().rejected += 1;
            logger.warn("收到非法帧", Some(&json!({ "peerId": peer_id })));
            let _ = tx.send(json!({ "type": protocol::frame_type::ERROR, "error": "invalid_json" }));
            continue;
        };
        handle_peer_frame(
            &frame, peer_id, &state, &logger, &auth, &store, &config, &tx,
        )
        .await;
    }

    // 断开清理
    writer.abort();
    state.senders.lock().unwrap().remove(&peer_id);
    let meta = state.peers.lock().unwrap().remove(&peer_id);
    if let Some(meta) = meta {
        restore_replaced_apps(&state, &logger, peer_id, &meta);
        // 该桥上还没回的请求全部失败
        let ids: Vec<String> = {
            let pending = state.pending.lock().unwrap();
            pending
                .iter()
                .filter(|(_, p)| p.bridge_id == meta.bridge_id.clone().unwrap_or_default())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            let item = state.pending.lock().unwrap().remove(&id);
            if let Some(p) = item {
                state.stats.lock().unwrap().errors += 1;
                let _ = p.responder.send(Err("bridge_disconnected".to_string()));
            }
        }
        // 展示表里也摘掉这台 PC（目录不该留着已经断开的机器）
        if let Some(bid) = &meta.bridge_id {
            state.pcs.lock().unwrap().remove(bid);
        }
    }
}

/// 处理一条来自桥的帧。
#[allow(clippy::too_many_arguments)]
async fn handle_peer_frame(
    frame: &Value,
    peer_id: usize,
    state: &Arc<State>,
    logger: &Arc<Logger>,
    auth: &Arc<AuthHub>,
    store: &Arc<Store>,
    config: &ServerConfig,
    tx: &mpsc::UnboundedSender<Value>,
) {
    let frame_type = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // ── 应用层心跳 ───────────────────────────────────────────
    if frame_type == protocol::frame_type::PING {
        let _ = tx.send(json!({ "type": protocol::frame_type::PONG }));
        return;
    }

    // ── 注册 ─────────────────────────────────────────────────
    if frame_type == protocol::frame_type::REGISTER {
        handle_register(frame, peer_id, state, logger, auth, config, tx);
        return;
    }

    // 未注册完成的连接不接受任何请求帧
    let registered = state
        .peers
        .lock()
        .unwrap()
        .get(&peer_id)
        .map(|m| m.registered)
        .unwrap_or(false);
    if !registered {
        state.stats.lock().unwrap().rejected += 1;
        let _ = tx.send(json!({ "type": protocol::frame_type::ERROR, "error": "not_registered" }));
        return;
    }

    // ── 响应 / 错误 / 分块 ───────────────────────────────────
    if frame_type == protocol::frame_type::RESPONSE || frame_type == protocol::frame_type::ERROR {
        let id = frame.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let item = state.pending.lock().unwrap().remove(&id);
        let Some(p) = item else {
            logger.warn("收到无主的响应帧", Some(&json!({ "peerId": peer_id, "id": id })));
            return;
        };
        if frame_type == protocol::frame_type::ERROR {
            // **错误帧不能走写回响应**：那里按 msg.status 写响应头，
            // 而 ERROR 帧没有 status（是 undefined → 0），writeHead(0) 抛错后
            // 退化成「200 + 空 body」——客户端看到的是「请求成功了但没内容」。
            // 这里明确回 502，并把错误原文带上。
            state.stats.lock().unwrap().errors += 1;
            let code = frame.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let error = frame.get("error").and_then(|v| v.as_str()).unwrap_or("");
            logger.warn(
                "本机执行失败",
                Some(&json!({ "app": p.app, "code": code, "error": error, "id": id })),
            );
            store.append(json!({
                "app": p.app,
                "status": 502,
                "error": if error.is_empty() { code } else { error },
                "durationMs": p.started_at.elapsed().as_millis() as u64,
            }));
            let _ = p.responder.send(Err(format!(
                "{}: {}",
                if code.is_empty() { "bridge_error" } else { code },
                error
            )));
            return;
        }
        let status = frame.get("status").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
        let headers = frame
            .get("headers")
            .cloned()
            .map(|v| normalize_headers(&v))
            .unwrap_or_default();
        let body = frame
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| base64_decode(s))
            .unwrap_or_default();
        let _ = p.responder.send(Ok((status, headers, body)));
    }
}

/// 处理注册帧。
fn handle_register(
    frame: &Value,
    peer_id: usize,
    state: &Arc<State>,
    logger: &Arc<Logger>,
    auth: &Arc<AuthHub>,
    config: &ServerConfig,
    tx: &mpsc::UnboundedSender<Value>,
) {
    let bearer = frame.get("token").and_then(|v| v.as_str()).unwrap_or("");
    let mut user_id = String::new();
    let mut is_gate = false;

    let payload = auth.verify_device_token(bearer);
    if let Some(p) = payload {
        user_id = p.sub;
    } else if !config.token.is_empty() && bearer == config.token {
        user_id = "@gate".to_string();
        is_gate = true;
    } else {
        state.stats.lock().unwrap().rejected += 1;
        logger.warn("rejected: 注册令牌无效", Some(&json!({ "peerId": peer_id })));
        let _ = tx.send(json!({ "type": protocol::frame_type::ERROR, "error": "invalid_token" }));
        return;
    }

    // 归一化元信息（标题 / 端口）—— client 报的是它本地认定的元信息，
    // server 不去猜：client 给了标题就用它的。
    let mut clean: Vec<AppDescriptor> = Vec::new();
    if let Some(apps) = frame.get("apps").and_then(|v| v.as_array()) {
        for a in apps {
            let Some(app) = a.get("app").and_then(|v| v.as_str()) else {
                continue;
            };
            let base = a.get("base").and_then(|v| v.as_str()).unwrap_or("");
            let title = a.get("title").and_then(|v| v.as_str());
            clean.push(describe_app(app, Some(base), title));
        }
    }

    let bridge_id = frame
        .get("bridgeId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("peer-{peer_id}"));
    // 电脑名：client 自报；没报就用 bridgeId 兜底（目录里至少有个能认出来的名字）
    let pc_name = frame
        .get("name")
        .or_else(|| frame.get("pcName"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| bridge_id.clone());

    let connected_at = crate::logger::iso_now();

    // ── 同一台 PC 的旧登记（重连）先摘掉 ─────────────────────
    let prev_pc = state.pcs.lock().unwrap().get(&bridge_id).cloned();
    if let Some(prev) = prev_pc {
        if prev.peer_id != peer_id {
            let mut bridges = state.bridges.lock().unwrap();
            bridges.retain(|_, b| b.peer_id != prev.peer_id);
        }
    }

    // ── 展示表：每台 PC 一条，互不顶替 ───────────────────────
    state.pcs.lock().unwrap().insert(
        bridge_id.clone(),
        PcEntry {
            bridge_id: bridge_id.clone(),
            name: pc_name.clone(),
            peer_id,
            user_id: user_id.clone(),
            is_gate,
            apps: clean.clone(),
            connected_at: connected_at.clone(),
            ip: state.peers.lock().unwrap().get(&peer_id).and_then(|m| m.ip.clone()),
        },
    );

    // ── 路由表：app 名该打到哪条连接 ─────────────────────────
    // 同 app 被别的 PC 占用 → 路由交给后来者（这是**路由**的选择，
    // 不影响展示：两台 PC 在目录里都还在，请求可用 X-Mn-Ws-Pc 指定目标）。
    let mut replaced: Vec<String> = Vec::new();
    {
        let mut bridges = state.bridges.lock().unwrap();
        for m in &clean {
            let prev = bridges.get(&m.app).cloned();
            if let Some(prev) = prev {
                if prev.peer_id != peer_id {
                    replaced.push(m.app.clone());
                    bridges.remove(&m.app);
                    logger.warn(
                        "同 app 被新桥顶替",
                        Some(&json!({ "app": m.app, "old": prev.bridge_id, "next": peer_id })),
                    );
                }
            }
        }
        for m in &clean {
            bridges.insert(
                m.app.clone(),
                Bridge {
                    peer_id,
                    bridge_id: bridge_id.clone(),
                    user_id: user_id.clone(),
                    is_gate,
                    apps: clean.clone(),
                    connected_at: connected_at.clone(),
                    ip: state.peers.lock().unwrap().get(&peer_id).and_then(|x| x.ip.clone()),
                },
            );
        }
    }
    {
        let mut known = state.known_apps.lock().unwrap();
        for m in &clean {
            if !known.iter().any(|a| a == &m.app) {
                known.push(m.app.clone());
            }
        }
    }

    // 更新连接元信息
    if let Some(meta) = state.peers.lock().unwrap().get_mut(&peer_id) {
        meta.registered = true;
        meta.bridge_id = Some(bridge_id.clone());
        meta.user_id = Some(user_id.clone());
        meta.is_gate = is_gate;
        meta.app_list = clean.clone();
        meta.pc_name = pc_name.clone();
    }

    logger.info(
        "bridge registered",
        Some(&json!({
            "peerId": peer_id,
            "bridgeId": bridge_id,
            "pcName": pc_name,
            "userId": user_id,
            "apps": clean.iter().map(|a| a.app.clone()).collect::<Vec<_>>(),
        })),
    );
    let _ = tx.send(json!({
        "type": protocol::frame_type::REGISTERED,
        "bridgeId": bridge_id,
        "name": pc_name,
        "apps": clean.iter().map(|a| a.app.clone()).collect::<Vec<_>>(),
        "replaced": replaced,
    }));
}

/// 把被顶替走的 app 归还给**仍然连着**的旧桥。
///
/// 顶替是「一个 app 同时只有一个桥」的取舍，但顶替者一旦先断开，app 就会空档：
/// 旧桥明明活着却接不到请求，调用方拿到的是 502「注册过但桥掉线了」。
fn restore_replaced_apps(
    state: &Arc<State>,
    logger: &Arc<Logger>,
    dead_peer_id: usize,
    dead_meta: &PeerMeta,
) {
    for app_meta in &dead_meta.app_list {
        let app = &app_meta.app;
        if state.bridges.lock().unwrap().contains_key(app) {
            continue; // 现在有主了 —— 后来者仍然优先
        }
        // 候选：仍连着、且注册过这个 app 的桥。
        // 优先挑**当前还在展示表里**的那台 PC —— 同一台 PC 重连过的话，
        // 它的旧连接虽然还开着，但已经不是「这台 PC」了，路由还给它是错的。
        let pcs = state.pcs.lock().unwrap();
        let mut candidates: Vec<usize> = state
            .peers
            .lock()
            .unwrap()
            .iter()
            .filter(|(pid, p)| {
                **pid != dead_peer_id && p.app_list.iter().any(|a| a.app == *app)
            })
            .map(|(pid, _)| *pid)
            .collect();
        drop(pcs);
        candidates.sort_by_key(|pid| {
            if state
                .pcs
                .lock()
                .unwrap()
                .values()
                .any(|pc| pc.peer_id == *pid)
            {
                0
            } else {
                1
            }
        });
        for pid in candidates {
            let (peer_bridge_id, peer_user_id, peer_is_gate, own) = {
                let peers = state.peers.lock().unwrap();
                let Some(p) = peers.get(&pid) else { continue };
                let own = p.app_list.iter().find(|a| a.app == *app).cloned();
                match own {
                    Some(o) => (
                        p.bridge_id.clone().unwrap_or_default(),
                        p.user_id.clone().unwrap_or_default(),
                        p.is_gate,
                        o,
                    ),
                    None => continue,
                }
            };
            state.bridges.lock().unwrap().insert(
                app.clone(),
                Bridge {
                    peer_id: pid,
                    bridge_id: peer_bridge_id,
                    user_id: peer_user_id,
                    is_gate: peer_is_gate,
                    apps: Vec::new(),
                    connected_at: dead_meta.connected_at.clone(),
                    ip: dead_meta.ip.clone(),
                },
            );
            logger.info(
                "顶替者断开，app 归还给仍在连接的桥",
                Some(&json!({ "app": app, "peerId": pid })),
            );
            break;
        }
    }
}

/// 把请求头转成 JSON 值（给 normalize_headers 用）。
///
/// 重复的头用 `get_all` 全取 —— Node 的 `req.headers` 对 `set-cookie` 这类
/// 多值头给的是数组。少了这一步，多值头到目标服务时会只剩一条。
fn headers_to_value(req: &Request<Incoming>) -> Value {
    let mut map = serde_json::Map::new();
    for (k, v) in req.headers().iter() {
        // `iter()` 每个 key 只给**第一个**值；多值头要用 `get_all` 全取 ——
        // Node 的 `req.headers` 对 `set-cookie` 这类头给的是数组。
        // 少了这一步，多值头到目标服务时会只剩一条。
        let values: Vec<Value> = req
            .headers()
            .get_all(k)
            .iter()
            .map(|x| Value::String(x.to_str().unwrap_or("").to_string()))
            .collect();
        map.insert(k.as_str().to_string(), Value::Array(values));
    }
    Value::Object(map)
}

/// 把协议层的头转成 JSON 值（写进帧）。
fn headers_to_value_json(headers: &ProtocolHeaders) -> Value {
    let mut map = serde_json::Map::new();
    for (k, v) in headers {
        map.insert(
            k.clone(),
            Value::Array(v.iter().map(|s| Value::String(s.clone())).collect()),
        );
    }
    Value::Object(map)
}

/// 取请求的 query（转成字符串字典）。
fn query_of(req: &Request<Incoming>) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(q) = req.uri().query() {
        for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
            map.insert(k.into_owned(), Value::String(v.into_owned()));
        }
    }
    Value::Object(map)
}

/// 从 Authorization 头取 bearer 令牌。
fn authorization_bearer_of(req: &Request<Incoming>) -> String {
    req.headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim())
        .filter(|v| v.len() > 7 && v[..7].eq_ignore_ascii_case("bearer "))
        .map(|v| v[7..].trim().to_string())
        .unwrap_or_default()
}

/// 读请求体（超上限直接拒）。
///
/// 用 `Limited` 包一层：body 超过上限时**立刻**断掉，而不是先收完再判断 ——
/// 一个 1GB 的 body 会把内存吃光。
async fn read_body(req: Request<Incoming>) -> Result<Vec<u8>, ()> {
    use http_body_util::BodyExt;
    let limited = http_body_util::Limited::new(req.into_body(), protocol::MAX_BODY_BYTES);
    match limited.collect().await {
        Ok(c) => Ok(c.to_bytes().to_vec()),
        Err(_) => Err(()),
    }
}

/// 回一个 JSON 响应。
fn send_json(status: u16, obj: Value) -> Response<Full<Bytes>> {
    let payload = serde_json::to_vec(&obj).unwrap_or_default();
    let mut resp = Response::new(Full::new(Bytes::from(payload)));
    *resp.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = resp.headers_mut();
    headers.insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        hyper::header::CACHE_CONTROL,
        hyper::header::HeaderValue::from_static("no-store"),
    );
    resp
}

/// base64 编码。
fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// base64 解码（宽容：坏字符丢掉）。
fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

/// 统计转 JSON。
fn stats_json(s: &Stats) -> Value {
    json!({
        "connections": s.connections,
        "requestsIn": s.requests_in,
        "forwarded": s.forwarded,
        "offline": s.offline,
        "rejected": s.rejected,
        "errors": s.errors,
        "bytesIn": s.bytes_in,
        "bytesOut": s.bytes_out,
    })
}

/// 进程已运行的秒数（近似：取进程启动以来的墙钟）。
fn uptime_secs() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs()
}
