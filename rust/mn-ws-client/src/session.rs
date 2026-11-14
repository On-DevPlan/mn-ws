//! 面板的登录态管理：与 TS 版 `core/session.ts` 同构。
//!
//! 面板跑在 127.0.0.1 上，但它**握着桥的凭据** —— 能连 server、能改白名单。
//! 所以「打开就能用」等于「任何能访问这个端口的东西都能用」，门禁必须落在
//! **服务端的登录态**上：面板自己只显示状态，真正的身份判定在 server 半。
//!
//! 这里保留一份「本机认为的登录态」，用途是：
//!   · 面板显示「当前是谁」
//!   · 起桥时取出设备令牌（复用 CLI 已存的登录态）

use serde_json::Value;

use crate::config;

/// 面板的登录态快照。
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

/// 复用 CLI 已存的设备令牌。
///
/// 读的是**激活账号**那一条：CLI 切了账号（auth switch），面板跟着切，
/// 不然会出现「命令行是 A、面板是 B」的分裂状态。
pub fn adopt_from_account_store(cfg: &serde_json::Map<String, Value>) -> Option<PanelSession> {
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
pub fn credential(cfg: &serde_json::Map<String, Value>) -> String {
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
