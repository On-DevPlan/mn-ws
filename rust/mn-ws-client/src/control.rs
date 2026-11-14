//! 控制面：本机 HTTP 服务 —— 伺服 React 面板 + 提供 `/api/*`。
//!
//! ## 前后端隔离
//!
//! 这个进程同时做两件事，但**边界清晰**：
//!   · **数据面**：桥的 WS 收发（`bridge.rs`）—— 帧 ↔ 本机 HTTP
//!   · **控制面**：面板的 HTTP 服务（**本文件**）—— 静态产物 + `/api/*`
//!
//! 面板是**纯前端产物**（React 构建期产物），它只通过 `/api/*` 与本进程说话，
//! **不碰数据面**。所以「换掉 client 半的语言」不会波及面板，
//! 「换掉面板的框架」也不会波及桥 —— 这就是隔离的收益。
//!
//! ## 静态产物在哪
//!
//! 运行时**零 Node 依赖**的关键：React 产物是**构建期**产物，
//! 由本进程当静态资源服务器伺服。二进制里带上产物目录即可。
//!
//! ## 路由表
//!
//! 与 TS 版 `client/src/runtime/registry.ts` 派生出来的 HTTP 路由**逐条对齐**
//! （面板的每个按钮都打这些端点 —— 少一个就是面板某个功能点不动）。
//! 路由清单见 `ROUTES`。

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Map, Value};

use crate::bridge::BridgeHandle;
use crate::config;
use crate::favorites;
use crate::session;
use crate::store;

/// 面板的静态产物目录。
///
/// 优先级：
///   1. `MN_WS_WEB_DIR`（开发/自测时指向构建产物）
///   2. 可执行文件同级的 `web/public`（发布布局：二进制 + 产物目录并排）
///   3. 仓库布局的 `client/dist/web/public`（monorepo 内跑）
pub fn web_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MN_WS_WEB_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let c = dir.join("web").join("public");
            if c.join("index.html").exists() {
                return c;
            }
        }
    }
    // monorepo 内跑：从 <repo>/rust/mn-ws-client/target/… 往上找
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for up in [
        PathBuf::from("client/dist/web/public"),
        PathBuf::from("../client/dist/web/public"),
        PathBuf::from("../../client/dist/web/public"),
    ] {
        let c = cwd.join(up);
        if c.join("index.html").exists() {
            return c;
        }
    }
    PathBuf::from("client/dist/web/public")
}

/// 面板的 MIME 类型。
fn mime_of(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if p.ends_with(".js") || p.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if p.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if p.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".ico") {
        "image/x-icon"
    } else if p.ends_with(".woff2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    }
}

/// 起面板服务。返回实际监听的端口。
pub async fn serve_panel(
    port: u16,
    handle: BridgeHandle,
    _no_open: bool,
) -> std::io::Result<u16> {
    serve_panel_with_session(port, handle, Arc::new(session::SessionManager::new())).await
}

/// 起面板服务（带登录态管理器）。
///
/// 面板登录流程要**跨请求**保持状态（起流程是一次请求，收回调是另一次），
/// 所以管理器得在所有请求间共享 —— 这里用 `Arc` 传进每个连接的闭包里。
pub async fn serve_panel_with_session(
    port: u16,
    handle: BridgeHandle,
    session: Arc<session::SessionManager>,
) -> std::io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual = listener.local_addr()?.port();

    let web = web_dir();
    // hyper 1.x：service_fn 直接接 http1::Builder::serve_connection，
    // 没有 0.14 时代那层 make_service_fn。
    //
    // ⚠️ svc 必须是**每次新建**的：serve_connection 会拿走它（move），
    //    而 accept 是循环 —— 共用一个 svc 会在第二次迭代就报「use of moved value」。
    //    所以这里留一个工厂函数，而不是造好一个 svc 反复用。
    let web_for_svc = web.clone();
    let handle_for_svc = handle.clone();
    let session_for_svc = session.clone();
    let make_svc = move || {
        let web = web_for_svc.clone();
        let handle = handle_for_svc.clone();
        let session = session_for_svc.clone();
        service_fn(move |req: Request<Incoming>| {
            let web = web.clone();
            let handle = handle.clone();
            let session = session.clone();
            async move {
                Ok::<_, Infallible>(route(req, web, handle, session, actual).await)
            }
        })
    };

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            let io = TokioIo::new(stream);
            let svc = make_svc();
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });
    Ok(actual)
}

/// 路由：静态资源 + `/api/*` + `/callback`。
async fn route(
    req: Request<Incoming>,
    web: PathBuf,
    handle: BridgeHandle,
    session: Arc<session::SessionManager>,
    panel_port: u16,
) -> Response<Full<Bytes>> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    // ── OIDC 回调：浏览器把授权码送回面板的 /callback ──
    //
    // 放在 /api 之前：它不是 API，是认证中心指定的固定回调地址。
    // 路径固定 /callback、端口通配 —— 与 go-ah 里 mn-ws-client 的白名单一致。
    if path == "/callback" {
        return callback(req, session).await;
    }

    if path.starts_with("/api/") {
        return api(req, &path, &method, handle, session, panel_port).await;
    }
    if method != Method::GET && method != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "只支持 GET");
    }

    // 静态资源：路径里的 `..` 一律拒绝（越界读）。
    if path.contains("..") {
        return text_response(StatusCode::BAD_REQUEST, "非法路径");
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let file = web.join(rel);
    if !file.starts_with(&web) {
        return text_response(StatusCode::FORBIDDEN, "越界");
    }
    match std::fs::read(&file) {
        Ok(body) => {
            let mime = mime_of(rel);
            let mut resp = Response::new(Full::new(Bytes::from(body)));
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                hyper::header::CONTENT_TYPE,
                hyper::header::HeaderValue::from_static(mime),
            );
            resp
        }
        Err(_) => {
            // SPA fallback：未知路径回 index.html（前端路由）。
            match std::fs::read(web.join("index.html")) {
                Ok(body) => {
                    let mut resp = Response::new(Full::new(Bytes::from(body)));
                    *resp.status_mut() = StatusCode::OK;
                    resp.headers_mut().insert(
                        hyper::header::CONTENT_TYPE,
                        hyper::header::HeaderValue::from_static("text/html; charset=utf-8"),
                    );
                    resp
                }
                Err(e) => text_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("面板产物不存在（{}）。\n用 MN_WS_WEB_DIR 指定它，或先构建前端产物。", e),
                ),
            }
        }
    }
}

/// `/api/*` 的处理。
///
/// 路由表与 TS 版 `client/src/runtime/registry.ts` 派生出来的路由**逐条对齐**。
async fn api(
    req: Request<Incoming>,
    path: &str,
    method: &Method,
    handle: BridgeHandle,
    session: Arc<session::SessionManager>,
    panel_port: u16,
) -> Response<Full<Bytes>> {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);

    // GET 的参数走 query，POST/PATCH 的参数走 body。
    let query = query_of(&req);
    let body = if *method == Method::GET || *method == Method::HEAD {
        Value::Object(Map::new())
    } else {
        read_json_body(req).await
    };
    let params = merge_params(query, &body);

    let payload: Result<Value, ApiError> = match (method.as_str(), path) {
        // ── home ──
        ("GET", "/api/bootstrap") => Ok(bootstrap(&cfg, &resolved)),
        ("GET", "/api/routes") => Ok(routes()),
        ("GET", "/api/health") => Ok(health()),
        ("POST", "/api/greet") => greet(&params),
        ("GET", "/api/settings") => Ok(get_settings()),
        ("PATCH", "/api/settings") => set_settings(&params),

        // ── auth ──
        ("POST", "/api/auth/login/start") => {
            // 起一次授权码流程并弹浏览器；**立刻返回**（不阻塞 HTTP 请求），
            // 回调落在面板自己的 /callback 上。
            let prompt_login = params
                .get("newAccount")
                .map(|v| v == &json!(true) || v.as_str() == Some("true"))
                .unwrap_or(false);
            match session.start_login(&cfg, panel_port, prompt_login).await {
                Ok(authorize_url) => Ok(json!({
                    "ok": false,
                    "pending": true,
                    "authorizeUrl": authorize_url,
                    "via": "panel",
                })),
                Err(e) => Ok(json!({
                    "ok": false,
                    "pending": false,
                    "error": e,
                    "via": "panel",
                })),
            }
        }
        ("GET", "/api/auth/accounts") => Ok(accounts_view(&cfg)),
        ("POST", "/api/auth/switch") => auth_switch(&cfg, &params),
        ("GET", "/api/auth/status") => Ok(auth_status(&cfg)),
        ("POST", "/api/auth/logout") => auth_logout(&cfg, &params),

        // ── bridge ──
        ("GET", "/api/bridge/status") => Ok(bridge_status(&cfg, &resolved, &handle)),
        ("GET", "/api/bridge/apps") => Ok(bridge_apps(&cfg, &resolved).await),
        ("POST", "/api/bridge/whitelist") => {
            let r = set_whitelist(&cfg, &params);
            if r.is_ok() {
                bridge_refresh_from_config(&handle);
            }
            r
        }
        ("POST", "/api/bridge/apps/add") => {
            let r = add_custom_app(&cfg, &params);
            if r.is_ok() {
                bridge_refresh_from_config(&handle);
            }
            r
        }
        ("POST", "/api/bridge/apps/remove") => {
            let r = remove_custom_app(&cfg, &params);
            if r.is_ok() {
                bridge_refresh_from_config(&handle);
            }
            r
        }
        ("POST", "/api/bridge/apps/reopen") => reopen_favorite(&cfg, &params),
        ("GET", "/api/bridge/catalog") => match crate::bridge::fetch_catalog(&cfg).await {
            Ok(json) => Ok(json),
            Err(e) => Ok(json!({
                "ok": false,
                "error": e,
                "apps": [],
            })),
        },
        ("POST", "/api/bridge/start") => Ok(json!({
            "ok": true,
            "state": handle.state().label(),
        })),
        ("POST", "/api/bridge/stop") => {
            handle.shutdown();
            Ok(json!({ "ok": true, "state": handle.state().label() }))
        }
        ("GET", "/api/bridge/known") => Ok(json!({
            "ok": true,
            "apps": config::registered_apps(&cfg)
                .iter()
                .map(|a| json!({
                    "app": a.name,
                    "base": a.base,
                    "title": a.title.clone().unwrap_or_default(),
                }))
                .collect::<Vec<_>>(),
        })),

        _ => Err(ApiError::not_found(format!(
            "接口不存在: {} {}",
            method.as_str(),
            path
        ))),
    };

    match payload {
        Ok(data) => json_response(StatusCode::OK, json!({ "ok": true, "data": data })),
        Err(e) => {
            let mut resp = json_response(
                e.status,
                json!({ "ok": false, "error": e.message, "code": e.code }),
            );
            let _ = &mut resp;
            resp
        }
    }
}

/// API 层的错误（带错误码与 HTTP 状态）。
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    fn bad_input(message: impl Into<String>) -> ApiError {
        ApiError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_input",
            message: message.into(),
        }
    }
    fn not_found(message: impl Into<String>) -> ApiError {
        ApiError {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }
}

/// 面板启动上下文。
///
/// 形态与 TS 版 `modules/home/index.ts` 的 `bootstrap()` 对齐：
/// `app` / `storePath` / `storeEnv` / `commands`。
pub fn bootstrap(cfg: &Map<String, Value>, resolved: &config::ResolvedApps) -> Value {
    json!({
        "app": {
            "name": "mn-ws",
            "title": "mn-ws",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "HTTP 与 WebSocket 双向桥的客户端半：把本机的 HTTP 服务桥给远端 HTTP 客户端",
        },
        "views": crate::views::views(),
        "commands": command_table(),
        "storePath": store::store_path().to_string_lossy(),
        "storeEnv": "MN_WS_STORE",
        "apps": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    })
}

/// 命令表（CLI ↔ HTTP 的对照）。
///
/// 面板的类型化客户端靠它解析路由（`typed-client.ts`）—— 所以每个
/// action 都要在这里出现，缺一个面板就有一个按钮点不动。
pub fn command_table() -> Vec<Value> {
    vec![
        cmd("home.bootstrap", "home", &["bootstrap", "show"], Some(("GET", "/api/bootstrap")), "一次取齐面板启动所需的全部上下文"),
        cmd("home.routes", "home", &["routes"], Some(("GET", "/api/routes")), "列出 CLI 命令与 HTTP 路由的对照表"),
        cmd("home.health", "home", &["health"], Some(("GET", "/api/health")), "自检：存储目录是否可写"),
        cmd("home.greet", "home", &["greet"], Some(("POST", "/api/greet")), "打个招呼（演示动作）"),
        cmd("setting.get", "home", &["setting", "get"], Some(("GET", "/api/settings")), "读取全部设置"),
        cmd("setting.set", "home", &["setting", "set"], Some(("PATCH", "/api/settings")), "修改设置"),
        cmd("auth.login", "auth", &["auth", "login"], Some(("POST", "/api/auth/login/start")), "统一登录（弹浏览器）"),
        cmd("auth.list", "auth", &["auth", "list"], Some(("GET", "/api/auth/accounts")), "列出本机已存账号"),
        cmd("auth.switch", "auth", &["auth", "switch"], Some(("POST", "/api/auth/switch")), "切换当前生效账号"),
        cmd("auth.status", "auth", &["auth", "status"], Some(("GET", "/api/auth/status")), "查看当前身份"),
        cmd("auth.logout", "auth", &["auth", "logout"], Some(("POST", "/api/auth/logout")), "清除登录凭据"),
        cmd("bridge.status", "bridge", &["status"], Some(("GET", "/api/bridge/status")), "桥接状态"),
        cmd("bridge.apps", "bridge", &["apps"], Some(("GET", "/api/bridge/apps")), "列出可桥接的应用"),
        cmd("bridge.whitelist.set", "bridge", &["apps", "set"], Some(("POST", "/api/bridge/whitelist")), "设置白名单"),
        cmd("bridge.apps.add", "bridge", &["apps", "add"], Some(("POST", "/api/bridge/apps/add")), "动态登记一个应用"),
        cmd("bridge.apps.remove", "bridge", &["apps", "remove"], Some(("POST", "/api/bridge/apps/remove")), "移除一个自定义应用"),
        cmd("bridge.apps.reopen", "bridge", &["apps", "reopen"], Some(("POST", "/api/bridge/apps/reopen")), "重新暴露一个用过的应用"),
        cmd("bridge.catalog", "bridge", &["catalog"], Some(("GET", "/api/bridge/catalog")), "拉远端目录"),
        cmd("bridge.start", "bridge", &["bridge", "start"], Some(("POST", "/api/bridge/start")), "起桥"),
        cmd("bridge.stop", "bridge", &["bridge", "stop"], Some(("POST", "/api/bridge/stop")), "停桥"),
        cmd("bridge.known", "bridge", &["apps", "known"], Some(("GET", "/api/bridge/known")), "列出已登记的应用"),
    ]
}

/// 命令表的一行。
///
/// `cli` 是命令的各段（`["status"]` = `mn-ws status`，`["apps", "set"]` = `mn-ws apps set`）。
fn cmd(
    id: &str,
    module: &str,
    cli: &[&str],
    http: Option<(&str, &str)>,
    summary: &str,
) -> Value {
    json!({
        "id": id,
        "module": module,
        "command": cli,
        "http": http.map(|(m, p)| json!({ "method": m, "path": p })),
        "summary": summary,
    })
}

/// 路由表（`/api/routes` 的内容）。
pub fn routes() -> Value {
    json!({ "routes": command_table() })
}

/// 自检：存储目录是否可写。
///
/// 形态与 TS 版一致：{ status: 'ok' | 'blocked', storePath, reason }
pub fn health() -> Value {
    let p = store::store_path();
    let mut reason = String::new();
    let ok = match store::save_store(&store::load_store()) {
        Ok(_) => true,
        Err(e) => {
            reason = e.to_string();
            false
        }
    };
    json!({
        "status": if ok { "ok" } else { "blocked" },
        "storePath": p.to_string_lossy(),
        "reason": reason,
    })
}

/// 演示动作：问候次数累计进本机存储。
pub fn greet(params: &Map<String, Value>) -> Result<Value, ApiError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(ApiError::bad_input("要给名字"));
    }
    let loud = params
        .get("loud")
        .map(|v| v == &json!(true) || v.as_str() == Some("true"))
        .unwrap_or(false);
    let count = store::mutate_store(|s| {
        let n = s.get("greetCount").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        s.insert("greetCount".to_string(), json!(n));
        n
    });
    let mut greeting = format!("你好，{name}！这是第 {count} 次问候。");
    if loud {
        greeting = greeting.to_uppercase();
    }
    Ok(json!({
        "greeting": greeting,
        "name": name,
        "count": count,
        "at": crate::auth::now_ms(),
    }))
}

/// 读取全部设置。
pub fn get_settings() -> Value {
    json!({
        "settings": Value::Object(store::settings()),
        "views": crate::views::views(),
        "schema": [
            json!({"key": "navGroups", "hint": "头部导航分组：[{title, views:[页面id…]}]，数组顺序 = 显示顺序"}),
            json!({"key": "navHidden", "hint": "隐藏的页面 id（入口不显示，直达仍可用）"}),
            json!({"key": "navOrder", "hint": "平铺区的显示顺序（页面 id 数组）"}),
            json!({"key": "theme", "hint": "色彩主题：light / dark / auto"}),
        ],
    })
}

/// 修改设置（PATCH 语义：只改传入的项）。
pub fn set_settings(params: &Map<String, Value>) -> Result<Value, ApiError> {
    // 两种形状：`{key, value}` 或 `{set: {...}}`
    let mut patch: Map<String, Value> = Map::new();
    if let Some(Value::Object(set)) = params.get("set") {
        for (k, v) in set {
            patch.insert(k.clone(), v.clone());
        }
    }
    if let Some(k) = params.get("key").and_then(|v| v.as_str()) {
        patch.insert(k.to_string(), params.get("value").cloned().unwrap_or(Value::Null));
    }
    if patch.is_empty() {
        return Err(ApiError::bad_input(
            "至少要给一项：setting set --key <名> --value <值>，或 --set k=v（可重复）",
        ));
    }

    let mut resolved: Map<String, Value> = Map::new();
    for (k, v) in &patch {
        match k.as_str() {
            "theme" => {
                let t = v.as_str().unwrap_or("").trim().to_lowercase();
                if !["light", "dark", "auto"].contains(&t.as_str()) {
                    return Err(ApiError::bad_input(format!(
                        "主题只能是 light / dark / auto，收到: {}",
                        v
                    )));
                }
                resolved.insert(k.clone(), json!(t));
            }
            "navHidden" | "navOrder" => {
                resolved.insert(k.clone(), Value::Array(coerce_id_list(v, k)?));
            }
            "navGroups" => {
                resolved.insert(k.clone(), Value::Array(coerce_nav_groups(v)?));
            }
            _ => {
                return Err(ApiError::not_found(format!(
                    "未知设置项: {k}（可用: navGroups, navHidden, navOrder, theme）"
                )))
            }
        }
    }

    let settings = store::mutate_store(|s| {
        let mut st = s
            .get("settings")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        for (k, v) in &resolved {
            st.insert(k.clone(), v.clone());
        }
        s.insert("settings".to_string(), Value::Object(st.clone()));
        st
    });
    Ok(json!({ "status": "ok", "settings": Value::Object(settings) }))
}

/// 「页面 id 清单」校验（隐藏清单 / 平铺顺序共用）。
fn coerce_id_list(value: &Value, label: &str) -> Result<Vec<Value>, ApiError> {
    let raw: Vec<Value> = match value {
        Value::Array(a) => a.clone(),
        Value::String(s) => {
            let t = s.trim();
            if t.starts_with('[') {
                serde_json::from_str::<Value>(t)
                    .ok()
                    .and_then(|v| v.as_array().cloned())
                    .ok_or_else(|| {
                        ApiError::bad_input(format!("{label}需要 JSON 数组或逗号分隔: {t}"))
                    })?
            } else {
                t.split(',')
                    .map(|x| Value::String(x.trim().to_string()))
                    .collect()
            }
        }
        other => vec![other.clone()],
    };
    let mut out: Vec<Value> = Vec::new();
    let ids = view_ids();
    for item in raw {
        let id = item.as_str().unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        if !ids.contains(&id) {
            return Err(ApiError::bad_input(format!("{label}里的页面不存在: {id}")));
        }
        if !out.iter().any(|v| v.as_str() == Some(id.as_str())) {
            out.push(json!(id));
        }
    }
    Ok(out)
}

/// 分组校验与归一。
fn coerce_nav_groups(value: &Value) -> Result<Vec<Value>, ApiError> {
    let arr: Vec<Value> = match value {
        Value::Array(a) => a.clone(),
        Value::String(s) => serde_json::from_str::<Value>(s.trim())
            .ok()
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(|| {
                ApiError::bad_input(format!(
                    "navGroups 需要 JSON 数组：[{{\"title\":\"求职\",\"views\":[\"home\"]}}, …]"
                ))
            })?,
        _ => {
            return Err(ApiError::bad_input(
                "navGroups 需要是数组：[{\"title\":\"求职\",\"views\":[\"home\"]}, …]",
            ))
        }
    };
    let ids = view_ids();
    let mut owner: Vec<(String, String)> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (i, raw) in arr.iter().enumerate() {
        let Some(g) = raw.as_object() else {
            return Err(ApiError::bad_input(format!("第 {} 个分组不是对象", i + 1)));
        };
        let title = g
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            return Err(ApiError::bad_input(format!("第 {} 个分组缺少 title（组名）", i + 1)));
        }
        let mut views: Vec<Value> = Vec::new();
        if let Some(items) = g.get("views").and_then(|v| v.as_array()) {
            for item in items {
                let id = item.as_str().unwrap_or("").trim().to_string();
                if id.is_empty() || views.iter().any(|v| v.as_str() == Some(id.as_str())) {
                    continue;
                }
                if !ids.contains(&id) {
                    return Err(ApiError::bad_input(format!(
                        "分组「{title}」里的页面不存在: {id}"
                    )));
                }
                if let Some((_, owner_title)) = owner.iter().find(|(v, _)| v == &id) {
                    return Err(ApiError::bad_input(format!(
                        "页面 {id} 同时在分组「{owner_title}」与「{title}」里——一个页面只能属于一个分组"
                    )));
                }
                owner.push((id.clone(), title.clone()));
                views.push(json!(id));
            }
        }
        if views.is_empty() {
            return Err(ApiError::bad_input(format!(
                "分组「{title}」没有任何页面——要么加一个，要么删掉这个分组"
            )));
        }
        out.push(json!({ "title": title, "views": views }));
    }
    Ok(out)
}

/// 所有页面 id。
fn view_ids() -> Vec<String> {
    crate::views::views()
        .iter()
        .filter_map(|v| v["id"].as_str().map(|s| s.to_string()))
        .collect()
}

/// 账号簿视图。
pub fn accounts_view(cfg: &Map<String, Value>) -> Value {
    let accounts = config::with_accounts(cfg);
    let active = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
    let list: Vec<Value> = accounts
        .iter()
        .map(|(key, e)| {
            json!({
                "key": key,
                "label": config::label_of(e),
                "userId": e.user_id,
                "email": e.email,
                "expired": config::is_expired(e),
                "active": key == active,
            })
        })
        .collect();
    json!({ "accounts": list, "activeKey": active })
}

/// 当前身份。
pub fn auth_status(cfg: &Map<String, Value>) -> Value {
    let sess = session::adopt_from_account_store(cfg);
    let accounts = config::with_accounts(cfg);
    let active = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
    let cur = accounts.iter().find(|(k, _)| k == active).map(|(_, e)| e);
    let mut out = session::snapshot(&sess);
    if let Some(o) = out.as_object_mut() {
        o.insert(
            "clientId".into(),
            json!(cfg.get("clientId").and_then(|v| v.as_str()).unwrap_or("")),
        );
        o.insert(
            "serverHttp".into(),
            json!(cfg.get("serverHttp").and_then(|v| v.as_str()).unwrap_or("")),
        );
        o.insert(
            "expiresAt".into(),
            json!(cur.map(|e| e.expires_at).unwrap_or(0)),
        );
        o.insert(
            "expired".into(),
            json!(cur.map(config::is_expired).unwrap_or(true)),
        );
    }
    out
}

/// 切换当前生效账号。
pub fn auth_switch(cfg: &Map<String, Value>, params: &Map<String, Value>) -> Result<Value, ApiError> {
    let target = params
        .get("account")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if target.is_empty() {
        return Err(ApiError::bad_input("需要指定账号（序号 / 邮箱 / 用户名 / 昵称）"));
    }
    let accounts = config::with_accounts(cfg);
    let Some((key, entry)) = accounts.iter().find(|(k, e)| {
        k == &target
            || config::entry_key_of(e) == target
            || config::label_of(e) == target
    }) else {
        return Err(ApiError::not_found(format!("没有这个账号: {target}")));
    };
    let mut raw = cfg.clone();
    raw.insert("activeAccount".into(), json!(key));
    config::write_config_file(&raw).map_err(|e| ApiError::bad_input(e.to_string()))?;
    Ok(json!({
        "ok": true,
        "changed": true,
        "key": key,
        "label": config::label_of(entry),
    }))
}

/// 清除登录凭据。
pub fn auth_logout(cfg: &Map<String, Value>, params: &Map<String, Value>) -> Result<Value, ApiError> {
    let all = params
        .get("all")
        .map(|v| v == &json!(true) || v.as_str() == Some("true"))
        .unwrap_or(false);
    let mut raw = cfg.clone();
    let accounts = config::with_accounts(&raw);
    let active = raw.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut map = match raw.get("accounts") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    if all {
        map.clear();
        raw.insert("activeAccount".into(), json!(""));
    } else {
        map.remove(&active);
        raw.insert("activeAccount".into(), json!(""));
    }
    raw.insert("accounts".into(), Value::Object(map));
    config::write_config_file(&raw).map_err(|e| ApiError::bad_input(e.to_string()))?;
    let remaining = config::with_accounts(&raw).len();
    Ok(json!({ "ok": true, "remaining": remaining }))
}

/// 桥接状态。
fn bridge_status(
    cfg: &Map<String, Value>,
    resolved: &config::ResolvedApps,
    handle: &BridgeHandle,
) -> Value {
    let sess = session::adopt_from_account_store(cfg);
    let identity = match &sess {
        Some(s) if !s.nickname.is_empty() => s.nickname.clone(),
        Some(s) if !s.email.is_empty() => s.email.clone(),
        Some(s) if !s.user_id.is_empty() => s.user_id.clone(),
        Some(_) => "已登录".to_string(),
        None => "静态门禁".to_string(),
    };
    json!({
        "state": handle.state().label(),
        "url": cfg.get("url").and_then(|v| v.as_str()).unwrap_or(""),
        "clientId": cfg.get("clientId").and_then(|v| v.as_str()).unwrap_or(""),
        "apps": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        "registered": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        "identity": identity,
        "loggedIn": sess.is_some(),
        "via": sess.as_ref().map(|s| s.via.clone()).unwrap_or_else(|| "none".to_string()),
    })
}

/// 可桥接应用清单。
///
/// 与 TS 版 `modules/bridge/service.ts` 的 `bridgeApps` 同款：
///   · `configured` —— 白名单里的应用 + **端口存活探测**
///   · `candidates` —— 已登记但不在白名单里的（面板据此勾选）
///   · `missing`    —— 在白名单里但没有登记基址的
///   · `favorites`  —— 用过的应用（一键重开）
///
/// 存活探测用 **TCP connect**（不是 HTTP 请求）：桥接关心的是
/// 「这个服务在不在」，不是「它返回什么」。连不上就是不在，多问一句没意义。
pub async fn bridge_apps(cfg: &Map<String, Value>, resolved: &config::ResolvedApps) -> Value {
    let mut configured: Vec<Value> = Vec::new();
    for (name, base) in &resolved.apps {
        let title = resolved
            .titles
            .iter()
            .find(|(t, _)| t == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| name.clone());
        let alive = probe_alive(base).await;
        let custom = config::registered_apps(cfg)
            .iter()
            .any(|a| a.name == *name);
        configured.push(json!({
            "app": name,
            "title": title,
            "port": port_of(base),
            "base": base,
            "alive": alive,
            "custom": custom,
        }));
    }

    // 候选项：已登记（appMap / customApps）但没进白名单的。
    let registered = config::registered_apps(cfg);
    let mut candidates: Vec<Value> = Vec::new();
    for a in &registered {
        if resolved.apps.iter().any(|(n, _)| n == &a.name) {
            continue;
        }
        let alive = probe_alive(&a.base).await;
        candidates.push(json!({
            "app": a.name,
            "title": a.title.clone().unwrap_or_else(|| a.name.clone()),
            "port": port_of(&a.base),
            "alive": alive,
        }));
    }

    json!({
        "configured": configured,
        "candidates": candidates,
        "missing": resolved.missing,
        "favorites": favorites::read_favorites()
            .iter()
            .map(|f| f.to_json())
            .collect::<Vec<_>>(),
    })
}

/// 探测基址上的端口是否在监听（TCP connect，超时 400ms）。
pub(crate) async fn probe_alive(base: &str) -> bool {
    let Some(port) = mn_ws_core::apps::port_of_base(base) else {
        return false;
    };
    let host = url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "127.0.0.1".to_string());
    match tokio::time::timeout(
        std::time::Duration::from_millis(400),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(s)) => {
            drop(s);
            true
        }
        _ => false,
    }
}

/// 从基址取端口。
fn port_of(base: &str) -> Value {
    match mn_ws_core::apps::port_of_base(base) {
        Some(p) => json!(p),
        None => Value::Null,
    }
}

/// 设置白名单。
/// 配置里的应用表变了 —— 运行中的桥**立刻热更**（换表 + 踢连接重注册）。
///
/// 不这么做的话，注册帧里的应用表永远停在起桥那一刻：面板上加的应用
/// 手机上看不见，要手动停桥/起桥才出现。桥没在跑就是空操作
/// （refresh_apps 对未连接的桥踢不出什么，下次起桥自然带新表）。
fn bridge_refresh_from_config(handle: &crate::bridge::BridgeHandle) {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);
    handle.refresh_apps(resolved.apps);
}

pub fn set_whitelist(cfg: &Map<String, Value>, params: &Map<String, Value>) -> Result<Value, ApiError> {
    let apps: Vec<String> = params
        .get("apps")
        .and_then(|v| v.as_str())
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let mut raw = cfg.clone();
    if apps.is_empty() {
        // 不给任何东西 = 清空白名单（= 一个都不桥）。
        raw.remove("apps");
        raw.remove("ports");
        raw.remove("appMap");
        raw.remove("appOverrides");
    } else {
        let (names, overrides) = config::parse_apps(&apps.join(","));
        let mut arr: Vec<Value> = names.iter().map(|n| json!(n)).collect();
        let mut map = Map::new();
        for (n, b) in &overrides {
            let inline = format!("{n}={b}");
            match arr.iter_mut().find(|v| v.as_str() == Some(inline.as_str())) {
                Some(_) => {}
                None => arr.push(json!(inline)),
            }
            map.insert(n.clone(), json!({ "base": b }));
        }
        raw.insert("apps".into(), Value::Array(arr));
        if !map.is_empty() {
            raw.insert("appMap".into(), Value::Object(map));
        }
    }
    config::write_config_file(&raw).map_err(|e| ApiError::bad_input(e.to_string()))?;
    let resolved = config::resolve_apps(&raw);
    Ok(json!({
        "ok": true,
        "apps": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        "applied": false,
    }))
}

/// 动态登记一个应用。
pub fn add_custom_app(cfg: &Map<String, Value>, params: &Map<String, Value>) -> Result<Value, ApiError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !config::is_valid_app_name(&name) {
        return Err(ApiError::bad_input(format!(
            "应用名不合法：{}（要小写字母开头，只含小写字母/数字/连字符，最长 32 位）",
            if name.is_empty() { "(空)" } else { &name }
        )));
    }
    let mut base = params
        .get("base")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if base.is_empty() {
        // 端口可能是数字，也可能是**字符串**（CLI 的 `--port 9911` 就是字符串）——
        // 两种都要认。
        if let Some(p) = params.get("port").and_then(|v| match v {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse::<u64>().ok(),
            _ => None,
        }) {
            base = format!("http://127.0.0.1:{p}");
        }
    }
    if base.is_empty() {
        return Err(ApiError::bad_input("要给端口或完整基址"));
    }
    let parsed = match url::Url::parse(&base) {
        Ok(u) => u,
        Err(_) => return Err(ApiError::bad_input(format!("基址不是合法 URL：{base}"))),
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(ApiError::bad_input("基址只支持 http / https"));
    }
    base = parsed.origin().ascii_serialization();

    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut list: Vec<config::CustomApp> = config::registered_apps(cfg)
        .into_iter()
        .filter(|a| a.name != name)
        .collect();
    list.push(config::CustomApp {
        name: name.clone(),
        base: base.clone(),
        title: if title.is_empty() { None } else { Some(title.clone()) },
    });
    config::save_custom_apps(&list).map_err(|e| ApiError::bad_input(e.to_string()))?;
    favorites::remember_favorite(&name, &base, if title.is_empty() { None } else { Some(&title) });

    let resolved = config::resolve_apps(&config::read_config_file());
    Ok(json!({
        "ok": true,
        "app": name,
        "base": base,
        "apps": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    }))
}

/// 移除一个自定义应用。
pub fn remove_custom_app(
    cfg: &Map<String, Value>,
    params: &Map<String, Value>,
) -> Result<Value, ApiError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let list: Vec<config::CustomApp> = config::registered_apps(cfg)
        .into_iter()
        .filter(|a| a.name != name)
        .collect();
    if list.len() == config::registered_apps(cfg).len() {
        return Err(ApiError::not_found(format!("没有这个自定义应用：{name}")));
    }
    config::save_custom_apps(&list).map_err(|e| ApiError::bad_input(e.to_string()))?;
    let resolved = config::resolve_apps(&config::read_config_file());
    Ok(json!({
        "ok": true,
        "removed": name,
        "apps": resolved.apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
    }))
}

/// 一键重新暴露一个用过的应用。
pub fn reopen_favorite(cfg: &Map<String, Value>, params: &Map<String, Value>) -> Result<Value, ApiError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let fav = favorites::read_favorites()
        .into_iter()
        .find(|f| f.name == name)
        .ok_or_else(|| ApiError::not_found(format!("没有用过这个应用：{name}")))?;
    // 已经桥着就不用动：重启桥会打断正在跑的连接，而用户的意图只是「确保它在」
    if config::registered_apps(cfg).iter().any(|a| a.name == name) {
        return Ok(json!({
            "ok": true,
            "app": name,
            "base": fav.base,
            "apps": config::resolve_apps(cfg).apps.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
        }));
    }
    let mut params = Map::new();
    params.insert("name".into(), json!(fav.name));
    params.insert("base".into(), json!(fav.base));
    if let Some(t) = &fav.title {
        params.insert("title".into(), json!(t));
    }
    add_custom_app(cfg, &params)
}

/// 取请求的 query（转成字符串字典）。
fn query_of(req: &Request<Incoming>) -> Map<String, Value> {
    let mut map = Map::new();
    if let Some(q) = req.uri().query() {
        for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
            map.insert(k.into_owned(), Value::String(v.into_owned()));
        }
    }
    map
}

/// 读 JSON 请求体。
async fn read_json_body(req: Request<Incoming>) -> Value {
    use http_body_util::BodyExt;
    let bytes = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => return Value::Object(Map::new()),
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// 合并 query 与 body 的参数（body 优先）。
fn merge_params(query: Map<String, Value>, body: &Value) -> Map<String, Value> {
    let mut out = query;
    if let Some(o) = body.as_object() {
        for (k, v) in o {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

/// 处理 OIDC 回调：收回调 → 换 access_token → 换设备令牌 → 存账号簿。
///
/// 失败时**如实说失败**：页面显示错误 + 原因，而不是一个「登录成功」的假象。
async fn callback(
    req: Request<Incoming>,
    session: Arc<session::SessionManager>,
) -> Response<Full<Bytes>> {
    let cfg = config::read_config_file();
    let q = query_of(&req);
    let code = q.get("code").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state = q.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let err = q.get("error").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if !err.is_empty() {
        return html_response(
            StatusCode::OK,
            &format!(
                "<h3>授权未通过</h3><p>{}</p><p>可以关闭这个页面了。</p>",
                escape_html(&err)
            ),
        );
    }

    match session.complete_login(&cfg, &code, &state).await {
        Ok(s) => {
            let who = if !s.nickname.is_empty() {
                s.nickname.clone()
            } else if !s.email.is_empty() {
                s.email.clone()
            } else if !s.user_id.is_empty() {
                s.user_id.clone()
            } else {
                "已登录".to_string()
            };
            html_response(
                StatusCode::OK,
                &format!(
                    "<h3>✅ 已登录</h3><p>{}</p><p>可以关闭这个页面，回到面板了。</p>",
                    escape_html(&who)
                ),
            )
        }
        Err(e) => {
            session.cancel_login();
            html_response(
                StatusCode::BAD_REQUEST,
                &format!(
                    "<h3>登录失败</h3><p>{}</p><p>可以关闭这个页面，回到面板重试。</p>",
                    escape_html(&e)
                ),
            )
        }
    }
}

/// 最小 HTML 转义：回调页会回显错误文本，不能让它变成可执行脚本。
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// 一个 HTML 响应。
fn html_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("text/html; charset=utf-8"),
    );
    resp
}

/// 一个纯文本响应。
fn text_response(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from(body.to_string())));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

/// 一个 JSON 响应。
fn json_response(status: StatusCode, payload: Value) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    let mut resp = Response::new(Full::new(Bytes::from(body)));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}

/// 静态资源的 MIME 判定（测试用）。
pub fn mime_for_test(path: &str) -> &'static str {
    mime_of(path)
}

/// 静态目录的查找（测试用）。
pub fn web_dir_for_test() -> PathBuf {
    web_dir()
}

/// 路径越界检查（测试用）。
pub fn is_under(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_table_covers_every_api_route() {
        // 每个 /api/* 端点都要在命令表里出现 —— 面板的类型化客户端
        // 靠它解析路由，缺一个就是面板有个按钮点不动。
        let routes: Vec<String> = command_table()
            .iter()
            .filter_map(|c| {
                c["http"]
                    .as_object()
                    .map(|h| format!("{} {}", h["method"].as_str().unwrap_or(""), h["path"].as_str().unwrap_or("")))
            })
            .collect();
        for expect in [
            "GET /api/bootstrap",
            "GET /api/routes",
            "GET /api/health",
            "POST /api/greet",
            "GET /api/settings",
            "PATCH /api/settings",
            "POST /api/auth/login/start",
            "GET /api/auth/accounts",
            "POST /api/auth/switch",
            "GET /api/auth/status",
            "POST /api/auth/logout",
            "GET /api/bridge/status",
            "GET /api/bridge/apps",
            "POST /api/bridge/whitelist",
            "POST /api/bridge/apps/add",
            "POST /api/bridge/apps/remove",
            "POST /api/bridge/apps/reopen",
            "GET /api/bridge/catalog",
            "POST /api/bridge/start",
            "POST /api/bridge/stop",
            "GET /api/bridge/known",
        ] {
            assert!(routes.contains(&expect.to_string()), "命令表缺 {expect}");
        }
    }

    #[test]
    fn theme_is_whitelisted() {
        let mut p = Map::new();
        p.insert("key".into(), json!("theme"));
        p.insert("value".into(), json!("purple"));
        assert!(set_settings(&p).is_err(), "非法主题必须被拒");

        let mut p = Map::new();
        p.insert("key".into(), json!("theme"));
        p.insert("value".into(), json!("dark"));
        assert!(set_settings(&p).is_ok(), "合法主题要通过");
    }

    #[test]
    fn unknown_setting_is_rejected() {
        let mut p = Map::new();
        p.insert("key".into(), json!("nope"));
        p.insert("value".into(), json!(1));
        assert!(set_settings(&p).is_err());
    }

    #[test]
    fn id_list_rejects_unknown_views() {
        let v = json!(["home", "not-a-view"]);
        assert!(coerce_id_list(&v, "隐藏清单").is_err());
        let v = json!(["home", "bridge"]);
        assert!(coerce_id_list(&v, "隐藏清单").is_ok());
    }

    #[test]
    fn nav_groups_reject_duplicate_view() {
        let v = json!([
            {"title": "A", "views": ["home"]},
            {"title": "B", "views": ["home"]},
        ]);
        assert!(coerce_nav_groups(&v).is_err(), "一个页面只能属于一个分组");
    }

    #[test]
    fn nav_groups_reject_empty_group() {
        let v = json!([{"title": "A", "views": []}]);
        assert!(coerce_nav_groups(&v).is_err());
    }
}
