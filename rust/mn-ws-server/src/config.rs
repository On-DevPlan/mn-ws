//! server 半的配置解析。
//!
//! 优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**（与 mn-rt 同一套）。
//!
//! 配置文件位置：~/.mn-ws/server.json（环境变量 MN_WS_HOME 可覆盖）。
//!
//! ⚠️ 账号表（多账号登录态）在 **client 半**——只有它需要「谁登录了这台机器」。
//! server 半只认凭据，不认人；人的身份由 client 半带来的设备令牌断言。

use std::path::PathBuf;

use serde_json::{json, Map, Value};

/// server 半的最终配置。
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub ws_path: String,
    pub token: String,
    pub issuer: String,
    /// server 半自己的 OIDC 身份
    pub idp_client_id: String,
    /// client 半的身份：真正发起授权码流程的是它
    pub login_client_id: String,
    pub redirect_uri: String,
    pub jwt_secret: String,
    /// `None` = 没表态（跟随「有没有 jwt secret」推导）
    pub auth_enabled: Option<bool>,
    pub insecure: bool,
    pub request_timeout_ms: u64,
    pub log_level: String,
    pub data_dir: Option<PathBuf>,
}

/// 配置目录：`MN_WS_HOME` 或 `~/.mn-ws`。
pub fn config_dir() -> PathBuf {
    if let Ok(home) = std::env::var("MN_WS_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".mn-ws")
}

/// server 半的配置文件路径。
pub fn server_config_file() -> PathBuf {
    config_dir().join("server.json")
}

/// 读配置文件。读不出来/坏了都当空配置（不抛错）。
pub fn read_config_file() -> Map<String, Value> {
    let f = server_config_file();
    let Ok(text) = std::fs::read_to_string(&f) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// 真值判定：1 / true / yes / on（大小写不敏感）。
pub fn is_env_truthy(value: Option<&str>) -> bool {
    let Some(s) = value else { return false };
    let s = s.trim().to_lowercase();
    s == "1" || s == "true" || s == "yes" || s == "on"
}

/// 布尔开关的严格解析。
///
/// 空 → `None`（**没表态**，让上层按「跟随其他配置」处理）；
/// 1/true/yes/on → true；0/false/no/off → false；其他值 → **直接报错**。
///
/// 为什么要严格：部署脚本里 `MN_WS_AUTH_ENABLED=1` 被当成「关闭」时，
/// 服务照常启动、/health 照样绿，而整套按用户隔离的属主判据**静默不存在** ——
/// CI 全绿、人以为开着。这类「配了等于没配」必须在解析层就炸掉。
pub fn parse_bool_flag(v: Option<&str>) -> Result<Option<bool>, String> {
    let Some(v) = v else { return Ok(None) };
    if v.is_empty() {
        return Ok(None);
    }
    let s = v.trim().to_lowercase();
    match s.as_str() {
        "1" | "true" | "yes" | "on" => Ok(Some(true)),
        "0" | "false" | "no" | "off" => Ok(Some(false)),
        _ => Err(format!(
            "布尔开关取值无法识别：{v:?}（认 1/true/yes/on 与 0/false/no/off）"
        )),
    }
}

/// 取第一个**有值**的候选（空串与 null 视为没给）。
fn pick(vals: &[Option<String>]) -> Option<String> {
    for v in vals {
        if let Some(s) = v {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
    }
    None
}

/// 从环境变量取候选。
fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// 从配置文件取候选。
fn file_str(file: &Map<String, Value>, key: &str) -> Option<String> {
    file.get(key).map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    })
}

/// 把一个 JSON 值转成**裸字符串**（不带引号）。
///
/// ⚠️ 不能直接用 `Value::to_string()` —— 那是 **JSON 序列化**：
///    `Value::String("7791").to_string()` 给的是 `"7791"`（带引号）。
///    端口解析拿着带引号的串去 `parse::<u16>()` 就失败了。
///    命令行 flag 与配置文件里的值都可能是字符串，所以这里统一处理。
fn value_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 合并出最终配置。
///
/// 环境变量前缀 `MN_WS_`。
pub fn load_server_config(flags: &Map<String, Value>) -> Result<ServerConfig, String> {
    let file = read_config_file();

    let host = pick(&[
        flags.get("host").map(value_str),
        env_var("MN_WS_HOST"),
        file_str(&file, "host"),
        Some("0.0.0.0".to_string()),
    ])
    .unwrap_or_default();

    let port_raw = pick(&[
        flags.get("port").map(value_str),
        env_var("MN_WS_PORT"),
        file_str(&file, "port"),
        Some("7777".to_string()),
    ])
    .unwrap_or_default();
    let port: u16 = port_raw
        .trim()
        .parse()
        .map_err(|_| format!("端口不是合法数字：{port_raw:?}"))?;

    let auth_enabled = parse_bool_flag(
        pick(&[
            flags.get("authEnabled").map(value_str),
            env_var("MN_WS_AUTH_ENABLED"),
            file_str(&file, "authEnabled"),
        ])
        .as_deref(),
    )?;

    Ok(ServerConfig {
        host,
        port,
        ws_path: pick(&[
            flags.get("wsPath").map(value_str),
            env_var("MN_WS_WS_PATH"),
            file_str(&file, "wsPath"),
            Some("/ws".to_string()),
        ])
        .unwrap_or_default(),
        token: pick(&[
            flags.get("token").map(value_str),
            env_var("MN_WS_TOKEN"),
            file_str(&file, "token"),
            Some(String::new()),
        ])
        .unwrap_or_default(),
        issuer: pick(&[
            flags.get("issuer").map(value_str),
            env_var("MN_WS_ISSUER"),
            file_str(&file, "issuer"),
            Some("http://47.110.80.47:8082".to_string()),
        ])
        .unwrap_or_default(),
        idp_client_id: pick(&[
            flags.get("idpClientId").map(value_str),
            env_var("MN_WS_IDP_CLIENT_ID"),
            file_str(&file, "idpClientId"),
            Some("mn-ws-server".to_string()),
        ])
        .unwrap_or_default(),
        login_client_id: pick(&[
            flags.get("loginClientId").map(value_str),
            env_var("MN_WS_LOGIN_CLIENT_ID"),
            file_str(&file, "loginClientId"),
            Some("mn-ws-client".to_string()),
        ])
        .unwrap_or_default(),
        redirect_uri: pick(&[
            flags.get("redirectUri").map(value_str),
            env_var("MN_WS_REDIRECT_URI"),
            file_str(&file, "redirectUri"),
            Some(String::new()),
        ])
        .unwrap_or_default(),
        jwt_secret: pick(&[
            flags.get("jwtSecret").map(value_str),
            env_var("MN_WS_JWT_SECRET"),
            file_str(&file, "jwtSecret"),
            Some(String::new()),
        ])
        .unwrap_or_default(),
        auth_enabled,
        insecure: flags.get("insecure").map(|v| v == &json!(true)).unwrap_or(false)
            || std::env::var("MN_WS_INSECURE").as_deref() == Ok("1"),
        request_timeout_ms: pick(&[
            flags.get("requestTimeout").map(value_str),
            env_var("MN_WS_REQUEST_TIMEOUT"),
            file_str(&file, "requestTimeoutMs"),
            Some("30000".to_string()),
        ])
        .unwrap_or_default()
        .trim()
        .parse()
        .unwrap_or(30_000),
        log_level: pick(&[
            flags.get("logLevel").map(value_str),
            env_var("MN_WS_LOG_LEVEL"),
            file_str(&file, "logLevel"),
            Some("info".to_string()),
        ])
        .unwrap_or_default(),
        data_dir: Some(config_dir().join("data")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bool_flag_is_strict() {
        assert_eq!(parse_bool_flag(None).unwrap(), None);
        assert_eq!(parse_bool_flag(Some("")).unwrap(), None);
        assert_eq!(parse_bool_flag(Some("1")).unwrap(), Some(true));
        assert_eq!(parse_bool_flag(Some("TRUE")).unwrap(), Some(true));
        assert_eq!(parse_bool_flag(Some("on")).unwrap(), Some(true));
        assert_eq!(parse_bool_flag(Some("0")).unwrap(), Some(false));
        assert_eq!(parse_bool_flag(Some("off")).unwrap(), Some(false));
        // 认不出来的值必须报错 —— 「配了等于没配」要在解析层就炸掉
        assert!(parse_bool_flag(Some("maybe")).is_err());
    }

    #[test]
    fn env_truthy_accepts_common_spellings() {
        assert!(is_env_truthy(Some("1")));
        assert!(is_env_truthy(Some("YES")));
        assert!(is_env_truthy(Some(" on ")));
        assert!(!is_env_truthy(Some("0")));
        assert!(!is_env_truthy(Some("off")));
        assert!(!is_env_truthy(None));
    }
}
