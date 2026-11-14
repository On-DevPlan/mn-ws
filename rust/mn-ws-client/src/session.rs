//! 面板的登录态管理：与 TS 版 `core/session.ts` 同构。
//!
//! 面板跑在 127.0.0.1 上，但它**握着桥的凭据** —— 能连 server、能改白名单。
//! 所以「打开就能用」等于「任何能访问这个端口的东西都能用」，门禁必须落在
//! **服务端的登录态**上：面板自己只显示状态，真正的身份判定在 server 半。
//!
//! 这里保留一份「本机认为的登录态」，用途是：
//!   · 面板显示「当前是谁」
//!   · 起桥时取出设备令牌（复用 CLI 已存的登录态）
//!
//! ## 两种拿登录态的方式（按优先级）
//!
//!   1. **复用 CLI 的设备令牌** —— 本机 `mn-ws auth login` 存下来的那一份。
//!      面板启动时读账号簿，有未过期的设备令牌就直接进入登录态（via=cli）。
//!      这样「命令行登一次，面板直接能用」，不必登两遍。
//!   2. **面板里现登** —— 前端点「登录」→ 弹浏览器 → PKCE 回环回调到
//!      面板自己的 `/callback` → 换到设备令牌 → 存进账号簿（via=panel）。
//!
//! 凭据一律存在**服务端**，浏览器页面自己不发凭据 ——
//! 页面里没有任何可以泄漏的令牌。

use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::auth::{self, IdpConfig, Pkce};
use crate::config;

/// 面板当前的登录态。
#[derive(Debug, Clone, Default)]
pub struct PanelSession {
    pub logged_in: bool,
    pub user_id: String,
    pub email: String,
    pub nickname: String,
    /// 设备令牌（起桥时用）。
    pub device_token: String,
    pub expires_at: i64,
    /// 登录来源：`cli`（复用 CLI 存的）/ `panel`（面板自己登的）/ `none`。
    pub via: String,
}

/// 一次进行中的面板登录。
struct PendingLogin {
    cfg: IdpConfig,
    pkce: Pkce,
    redirect_uri: String,
    server_http: String,
    client_id: String,
    device_name: String,
    url: String,
    client_id_of_server: String,
}

/// 面板的登录态管理器。
///
/// 与 TS 版 `SessionManager` 同构：持有当前登录态 + 一个进行中的登录流程。
///
/// 用 `Mutex` 而不是 `RwLock`：面板的访问量极低（人点按钮的频率），
/// 而登录流程要**跨请求**保持状态（起流程是一次请求，收回调是另一次）——
/// 简单起见用一把锁足够。
pub struct SessionManager {
    session: Mutex<Option<PanelSession>>,
    pending: Mutex<Option<PendingLogin>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        SessionManager::new()
    }
}

impl SessionManager {
    /// 构造。
    pub fn new() -> SessionManager {
        SessionManager {
            session: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    /// 复用 CLI 已存的设备令牌。
    ///
    /// 读的是**激活账号**那一条：CLI 切了账号（auth switch），面板跟着切，
    /// 不然会出现「命令行是 A、面板是 B」的分裂状态。
    pub fn adopt_from_account_store(&self, cfg: &Map<String, Value>) -> bool {
        let Some(s) = adopt_from_account_store(cfg) else {
            return false;
        };
        *self.session.lock().unwrap() = Some(s);
        true
    }

    /// 当前登录态（对外只给必要字段）。
    pub fn snapshot(&self) -> Option<PanelSession> {
        self.session.lock().unwrap().clone()
    }

    /// 当前用的凭据（注册到 server 半时用）。
    pub fn credential(&self, cfg: &Map<String, Value>) -> String {
        if let Some(s) = self.snapshot() {
            if !s.device_token.is_empty() {
                return s.device_token;
            }
        }
        cfg.get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    /// 面板里点「登录」：起一次授权码流程并弹浏览器。
    ///
    /// 回调地址是**面板自己的** `http://127.0.0.1:<port>/callback` ——
    /// go-ah 里 mn-ws-client 的回调白名单是「127.0.0.1 + 任意端口 + /callback」，
    /// 端口通配、路径固定，所以面板端口运行时怎么选都能回调。
    ///
    /// 返回 authorize URL（前端要显示它 —— 弹浏览器失败时用户得手动打开）。
    pub async fn start_login(
        &self,
        cfg: &Map<String, Value>,
        panel_port: u16,
        prompt_login: bool,
    ) -> Result<String, String> {
        if self.pending.lock().unwrap().is_some() {
            return Err("已有一个登录在进行中".into());
        }
        let server_http = cfg
            .get("serverHttp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        if server_http.is_empty() {
            return Err("缺少服务端地址（serverHttp）".into());
        }
        let idp = auth::fetch_idp_config(&server_http).await?;
        let redirect_uri = format!("http://127.0.0.1:{panel_port}/callback");
        let pkce = Pkce::generate();
        let url = auth::build_authorize_url(&idp, &pkce, &redirect_uri, prompt_login);

        *self.pending.lock().unwrap() = Some(PendingLogin {
            cfg: idp,
            pkce,
            redirect_uri,
            server_http,
            client_id: cfg
                .get("clientId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            device_name: cfg
                .get("deviceName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: url.clone(),
            client_id_of_server: String::new(),
        });

        // 弹浏览器。失败不致命 —— 前端会把 URL 显示出来让用户手动打开。
        if let Err(e) = webbrowser::open(&url) {
            eprintln!("自动打开浏览器失败（{e}），请手动打开上面打印的授权地址");
        }
        Ok(url)
    }

    /// 面板的 `/callback` 路由调用它：收回调 → 换 access_token → 换设备令牌。
    pub async fn complete_login(
        &self,
        cfg: &Map<String, Value>,
        code: &str,
        state: &str,
    ) -> Result<PanelSession, String> {
        let pending = self.pending.lock().unwrap().take().ok_or(
            "没有进行中的登录（可能已超时或重复回调）".to_string(),
        )?;

        let access_token = auth::finish_oauth(
            &pending.cfg,
            &pending.pkce,
            code,
            state,
            &pending.redirect_uri,
        )
        .await?;

        let res = auth::verify_exchange(
            &pending.server_http,
            &access_token,
            &pending.client_id,
            &pending.device_name,
        )
        .await?;

        let user_id = res.get("userId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let email = res.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let username = res
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let nickname = res
            .get("nickname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let device_token = res.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let expires_at = res
            .get("tokenExpiresAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let client_id = res
            .get("clientId")
            .and_then(|v| v.as_str())
            .unwrap_or(&pending.client_id)
            .to_string();
        let device_name = res
            .get("deviceName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&pending.device_name)
            .to_string();

        // 落进账号簿并激活 —— 与 CLI 登录写的是同一份账号簿。
        save_auth_account(
            cfg,
            &config::AccountEntry {
                user_id: user_id.clone(),
                email: email.clone(),
                username,
                nickname: nickname.clone(),
                device_token: device_token.clone(),
                expires_at,
                device_name,
                client_id,
                url: cfg.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                server_http: pending.server_http.clone(),
                login_at: auth::now_ms(),
            },
        )?;

        let session = PanelSession {
            logged_in: true,
            user_id,
            email,
            nickname,
            device_token,
            expires_at,
            via: "panel".to_string(),
        };
        *self.session.lock().unwrap() = Some(session.clone());
        Ok(session)
    }

    /// 登录失败/超时后清掉进行中的流程。
    pub fn cancel_login(&self) {
        *self.pending.lock().unwrap() = None;
    }

    /// 清除登录态（logout 用）。
    pub fn reset(&self) {
        *self.session.lock().unwrap() = None;
        *self.pending.lock().unwrap() = None;
    }

    /// 进行中的登录（测试用）。
    #[cfg(test)]
    fn has_pending(&self) -> bool {
        self.pending.lock().unwrap().is_some()
    }
}

/// 复用 CLI 已存的设备令牌（一次性快照，不持有管理器）。
pub fn adopt_from_account_store(cfg: &Map<String, Value>) -> Option<PanelSession> {
    let accounts = config::with_accounts(cfg);
    let active_key = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
    let entry = accounts
        .iter()
        .find(|(k, _)| k == active_key)
        .map(|(_, e)| e)
        .or_else(|| accounts.first().map(|(_, e)| e))?;
    if entry.device_token.is_empty() || config::is_expired(entry) {
        return None;
    }
    Some(PanelSession {
        logged_in: true,
        user_id: entry.user_id.clone(),
        email: entry.email.clone(),
        nickname: entry.nickname.clone(),
        device_token: entry.device_token.clone(),
        expires_at: entry.expires_at,
        via: "cli".to_string(),
    })
}

/// 起桥时要用的凭据：优先面板登录态的设备令牌，其次 CLI 存的，最后静态门禁。
pub fn credential(cfg: &Map<String, Value>) -> String {
    if let Some(s) = adopt_from_account_store(cfg) {
        if !s.device_token.is_empty() {
            return s.device_token;
        }
    }
    cfg.get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 面板的登录态快照（对外只给必要字段）。
pub fn snapshot(s: &Option<PanelSession>) -> Value {
    match s {
        None => serde_json::json!({
            "loggedIn": false,
            "via": "none",
        }),
        Some(p) => serde_json::json!({
            "loggedIn": p.logged_in,
            "userId": p.user_id,
            "email": p.email,
            "nickname": p.nickname,
            "via": p.via,
        }),
    }
}

/// 把一个账号写进账号簿并设为当前。
pub fn save_auth_account(
    cfg: &Map<String, Value>,
    entry: &config::AccountEntry,
) -> Result<(), String> {
    let mut raw = cfg.clone();
    let mut accounts = match raw.get("accounts") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    let key = config::entry_key_of(entry);
    let key = if key.is_empty() {
        "active".to_string()
    } else {
        key
    };
    let mut m = Map::new();
    m.insert("userId".into(), json!(entry.user_id));
    m.insert("email".into(), json!(entry.email));
    m.insert("username".into(), json!(entry.username));
    m.insert("nickname".into(), json!(entry.nickname));
    m.insert("deviceToken".into(), json!(entry.device_token));
    m.insert("expiresAt".into(), json!(entry.expires_at));
    m.insert("deviceName".into(), json!(entry.device_name));
    m.insert("clientId".into(), json!(entry.client_id));
    m.insert("url".into(), json!(entry.url));
    m.insert("serverHttp".into(), json!(entry.server_http));
    m.insert("loginAt".into(), json!(entry.login_at));
    accounts.insert(key.clone(), Value::Object(m));
    raw.insert("accounts".into(), Value::Object(accounts));
    raw.insert("activeAccount".into(), json!(key));
    config::write_config_file(&raw)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_starts_without_session() {
        let m = SessionManager::new();
        assert!(m.snapshot().is_none());
        assert!(!m.has_pending());
    }

    #[test]
    fn reset_clears_session() {
        let m = SessionManager::new();
        *m.session.lock().unwrap() = Some(PanelSession {
            logged_in: true,
            via: "panel".into(),
            ..Default::default()
        });
        assert!(m.snapshot().is_some());
        m.reset();
        assert!(m.snapshot().is_none());
    }

    #[test]
    fn credential_falls_back_to_static_gate() {
        let mut cfg = Map::new();
        cfg.insert("token".into(), json!("gate"));
        assert_eq!(credential(&cfg), "gate");
    }
}
