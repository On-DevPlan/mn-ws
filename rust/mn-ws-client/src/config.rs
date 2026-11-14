//! 配置：`~/.mn-ws/config.json` 的读写。
//!
//! ⚠️ **与 TS 侧 `client/src/core/config.ts` 共用同一份文件**，字段名逐字对齐。
//! 用户从旧版升到 Rust 版时，配置不能丢 —— 登录态、白名单、登记的应用
//! 都在这里。所以这里是「读懂 TS 写出来的 JSON」而不是「定义一套新格式」。
//!
//! 读取策略：**宽松读、严格写**。
//!   · 读：任何字段缺失/类型不对都退回默认值，绝不让一份坏配置把程序搞崩
//!     （崩了 = 用户连 `mn-ws status` 都跑不了，等于失去自救手段）
//!   · 写：整份原子替换（同目录 tmp → fsync → rename），
//!     因为写入方不止一个（serve 注册成功后回写、用户随时在另一个终端 auth login），
//!     半截文件被下一次读当成空配置，等于把凭据静默清空

use serde_json::{json, Map, Value};
use std::path::PathBuf;

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

/// 配置文件路径。
pub fn config_file() -> PathBuf {
    config_dir().join("config.json")
}

/// 读配置文件。读不出来/坏了都当空配置（不抛错）。
pub fn read_config_file() -> Map<String, Value> {
    let f = config_file();
    let Ok(text) = std::fs::read_to_string(&f) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// 原子写整份配置文件。
///
/// 同目录 tmp → fsync → rename（Windows 上 rename 到已存在文件会失败，
/// 所以先删旧的再 rename —— 删+rename 之间有个极短的窗口，
/// 但对这个文件可接受：它由本进程独占写，且写的是可重建的配置）。
pub fn write_config_file(next: &Map<String, Value>) -> std::io::Result<PathBuf> {
    let f = config_file();
    if let Some(dir) = f.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = f.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut text = serde_json::to_string_pretty(next)?;
    text.push('\n');
    std::fs::write(&tmp, text)?;

    // fsync：确保内容真的落盘（否则断电后文件可能为空）
    #[cfg(unix)]
    {
        use std::io::Write;
        let ft = std::fs::File::open(&tmp)?;
        ft.sync_all()?;
    }

    let _ = std::fs::remove_file(&f);
    std::fs::rename(&tmp, &f)?;
    Ok(f)
}

/// 一个已登记的应用（名字 + 基址 + 标题）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomApp {
    pub name: String,
    pub base: String,
    pub title: Option<String>,
}

/// 白名单解析的结果。
#[derive(Debug, Clone, Default)]
pub struct ResolvedApps {
    /// app -> base
    pub apps: Vec<(String, String)>,
    /// app -> 标题
    pub titles: Vec<(String, String)>,
    /// 在白名单里、但**没有登记基址**的应用名（被跳过的，要明确报出来）
    pub missing: Vec<String>,
}

/// 解析白名单里的应用名与内联基址。
///
/// 白名单项可以是纯名字（`nx-kv`）或带基址（`my-api=http://127.0.0.1:9999`）。
pub fn parse_apps(raw: &str) -> (Vec<String>, Vec<(String, String)>) {
    let mut names = Vec::new();
    let mut overrides = Vec::new();
    for part in raw.split(',') {
        let s = part.trim();
        if s.is_empty() {
            continue;
        }
        if let Some((name, base)) = s.split_once('=') {
            let name = name.trim();
            let base = base.trim();
            if !name.is_empty() && !base.is_empty() {
                if !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
                overrides.push((name.to_string(), base.to_string()));
            }
        } else if !names.iter().any(|n| n == s) {
            names.push(s.to_string());
        }
    }
    (names, overrides)
}

/// 应用名合法形态（与 server 侧 `APP_NAME_RE` 同一条规则）。
pub const CUSTOM_APP_NAME_RE: &str = r"^[a-z][a-z0-9-]{0,31}$";

/// 应用名是否合法。
pub fn is_valid_app_name(name: &str) -> bool {
    // 不引 regex 依赖：这条规则用字符判断就够，且更快。
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    let rest: Vec<char> = chars.collect();
    if rest.len() > 31 {
        return false;
    }
    rest.iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
}

/// 从配置里读出「已登记应用」（customApps + appMap/appOverrides）。
pub fn registered_apps(raw: &Map<String, Value>) -> Vec<CustomApp> {
    let mut out: Vec<CustomApp> = Vec::new();

    // appMap（TS 版主键名）；appOverrides 是同义别名，两种都认。
    for key in ["appMap", "appOverrides"] {
        if let Some(Value::Object(m)) = raw.get(key) {
            for (name, v) in m {
                let base = v
                    .get("base")
                    .and_then(|b| b.as_str())
                    .unwrap_or("")
                    .to_string();
                if base.is_empty() {
                    continue;
                }
                let title = v
                    .get("title")
                    .and_then(|t| t.as_str())
                    .filter(|t| !t.is_empty())
                    .map(|t| t.to_string());
                if let Some(prev) = out.iter_mut().find(|a| a.name == *name) {
                    prev.base = base;
                    if title.is_some() {
                        prev.title = title;
                    }
                } else {
                    out.push(CustomApp {
                        name: name.clone(),
                        base,
                        title,
                    });
                }
            }
        }
    }

    // customApps 覆盖同名项（动态登记优先）。
    if let Some(Value::Array(arr)) = raw.get("customApps") {
        for item in arr {
            let Some(obj) = item.as_object() else { continue };
            let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let base = obj.get("base").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() || base.is_empty() {
                continue;
            }
            let title = obj
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|t| !t.is_empty())
                .map(|t| t.to_string());
            if let Some(prev) = out.iter_mut().find(|a| a.name == name) {
                prev.base = base;
                prev.title = title;
            } else {
                out.push(CustomApp { name, base, title });
            }
        }
    }
    out
}

/// 合并白名单与登记表 → 可桥的应用。
///
/// **白名单说了算**：只有既在白名单里、又有登记基址的应用才会被桥。
/// 端口探测只用来显示状态，绝不因为「扫到端口在监听」就自动开桥 ——
/// 扫到就开桥等于把整台机器暴露出去。
pub fn resolve_apps(raw: &Map<String, Value>) -> ResolvedApps {
    let mut wanted: Vec<String> = match raw.get("apps") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    };

    let registered = registered_apps(raw);
    let mut by_name: Vec<(String, String)> = Vec::new();
    for app in &registered {
        by_name.push((app.name.clone(), app.base.clone()));
    }

    // 白名单里的内联基址（"名字=基址"）也要认。
    for item in &wanted {
        if let Some((name, base)) = item.split_once('=') {
            let name = name.trim().to_string();
            let base = base.trim().to_string();
            if !name.is_empty() && !base.is_empty() {
                if let Some(e) = by_name.iter_mut().find(|(n, _)| *n == name) {
                    e.1 = base;
                } else {
                    by_name.push((name, base));
                }
            }
        }
    }
    // 白名单项去掉内联基址部分，只留名字。
    wanted = wanted
        .iter()
        .map(|s| s.split('=').next().unwrap_or(s).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    // 动态登记的应用登记即进白名单（与 TS 版一致）。
    for app in &registered {
        if !wanted.contains(&app.name) {
            wanted.push(app.name.clone());
        }
    }

    let mut out = ResolvedApps::default();
    for name in &wanted {
        match by_name.iter().find(|(n, _)| n == name) {
            Some((_, base)) => {
                out.apps.push((name.clone(), base.clone()));
                let title = registered
                    .iter()
                    .find(|a| &a.name == name)
                    .and_then(|a| a.title.clone())
                    .unwrap_or_else(|| name.clone());
                out.titles.push((name.clone(), title));
            }
            None => out.missing.push(name.clone()),
        }
    }
    out
}

/// 账号簿里的一条账号。
#[derive(Debug, Clone, Default)]
pub struct AccountEntry {
    pub user_id: String,
    pub email: String,
    pub username: String,
    pub nickname: String,
    pub device_token: String,
    pub expires_at: i64,
    pub device_name: String,
    pub client_id: String,
    pub url: String,
    pub server_http: String,
    pub login_at: i64,
}

/// 读账号簿。
pub fn with_accounts(raw: &Map<String, Value>) -> Vec<(String, AccountEntry)> {
    let Some(Value::Object(accounts)) = raw.get("accounts") else {
        return Vec::new();
    };
    let mut out: Vec<(String, AccountEntry)> = Vec::new();
    for (key, v) in accounts {
        let Some(o) = v.as_object() else { continue };
        let g = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let e = AccountEntry {
            user_id: g("userId"),
            email: g("email"),
            username: g("username"),
            nickname: g("nickname"),
            device_token: g("deviceToken"),
            expires_at: o.get("expiresAt").and_then(|x| x.as_i64()).unwrap_or(0),
            device_name: g("deviceName"),
            client_id: g("clientId"),
            url: g("url"),
            server_http: g("serverHttp"),
            login_at: o.get("loginAt").and_then(|x| x.as_i64()).unwrap_or(0),
        };
        out.push((key.clone(), e));
    }
    out
}

/// 账号的稳定 key：优先 userId，其次邮箱/用户名/昵称。
pub fn entry_key_of(e: &AccountEntry) -> String {
    for v in [&e.user_id, &e.email, &e.username, &e.nickname, &e.client_id] {
        if !v.is_empty() {
            return v.clone();
        }
    }
    String::new()
}

/// 账号的显示名。
pub fn label_of(e: &AccountEntry) -> String {
    for v in [&e.nickname, &e.username, &e.email, &e.user_id, &e.client_id] {
        if !v.is_empty() {
            return v.clone();
        }
    }
    "(未知账号)".to_string()
}

/// 设备令牌是否已过期。
pub fn is_expired(e: &AccountEntry) -> bool {
    if e.expires_at == 0 {
        return true;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    e.expires_at <= now_ms
}

/// 这条账号记录能不能真的拿来用：有设备令牌，且令牌没过期。
///
/// 与 `is_expired` 是**两个问题**：`is_expired` 回答「令牌过期了吗」，
/// 而「压根没有令牌」不是过期，是历史残留（旧版本写的半截条目，或某次
/// 登录只拿到了 clientId）。两者混在一起报「已过期」会把用户引到
/// 「切到它」按钮上 —— 切完反而丢掉登录态，症状正是「这个登录态总是会过期」。
pub fn is_usable(e: &AccountEntry) -> bool {
    !e.device_token.is_empty() && !is_expired(e)
}

/// 只有键、没有任何账号字段的残留记录（无令牌、无 userId/邮箱/用户名/昵称）。
///
/// 这类条目既不能登录也不能切换，只会在账号列表里冒充一个「已过期账号」。
pub fn is_orphan(e: &AccountEntry) -> bool {
    e.device_token.is_empty()
        && e.user_id.is_empty()
        && e.email.is_empty()
        && e.username.is_empty()
        && e.nickname.is_empty()
}

/// 清掉无令牌的残留记录，返回被清掉的键。
///
/// 只动真正没用的条目：有令牌的（哪怕已过期）保留，用户还能靠它认出
/// 「上次是哪个账号」。写盘由调用方决定。
pub fn prune_orphan_accounts(raw: &mut Map<String, Value>) -> Vec<String> {
    let mut removed: Vec<String> = Vec::new();
    let Some(Value::Object(accounts)) = raw.get("accounts") else {
        return removed;
    };
    let active = raw
        .get("activeAccount")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut kept = Map::new();
    for (key, v) in accounts.clone() {
        let Some(o) = v.as_object() else { continue };
        let g = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let e = AccountEntry {
            user_id: g("userId"),
            email: g("email"),
            username: g("username"),
            nickname: g("nickname"),
            device_token: g("deviceToken"),
            expires_at: o.get("expiresAt").and_then(|x| x.as_i64()).unwrap_or(0),
            device_name: g("deviceName"),
            client_id: g("clientId"),
            url: g("url"),
            server_http: g("serverHttp"),
            login_at: o.get("loginAt").and_then(|x| x.as_i64()).unwrap_or(0),
        };
        if is_orphan(&e) {
            removed.push(key);
            continue;
        }
        kept.insert(key, v);
    }
    if !removed.is_empty() {
        raw.insert("accounts".into(), Value::Object(kept));
        // 当前账号指着一条残骸时，把指向一起撤掉 —— 否则桥会因为
        // 「activeAccount 找不到对应记录」退化成静态门禁。
        if removed.iter().any(|k| k == &active) {
            raw.insert("activeAccount".into(), json!(""));
        }
    }
    removed
}

/// 保存自定义应用列表（面板上的「添加 / 移除」走这里）。
///
/// 同时把名字并进 `apps` 白名单 —— 白名单是**唯一的准入依据**。
/// 分开存是为了让「有哪些自定义应用」与「哪些被桥了」在配置里分得清。
pub fn save_custom_apps(list: &[CustomApp]) -> std::io::Result<PathBuf> {
    let mut existing = read_config_file();

    // ⚠️ 白名单里可能带**内联基址**（"名字=基址"），那必须**原样保留**：
    //    只把名字留下来，基址就没了 —— 下一次启动那些应用会被跳过，
    //    症状是「刚配好能用，重启后桥上就没它们了」。
    let mut raw_apps: Vec<String> = match existing.get("apps") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .collect(),
        _ => Vec::new(),
    };
    let (mut names, _) = parse_apps(&raw_apps.join(","));
    for a in list {
        if !names.contains(&a.name) {
            names.push(a.name.clone());
            raw_apps.push(a.name.clone());
        }
    }
    existing.insert("apps".into(), json!(raw_apps));

    let clean: Vec<Value> = list
        .iter()
        .filter(|a| !a.name.is_empty() && !a.base.is_empty() && is_valid_app_name(&a.name))
        .map(|a| {
            let mut m = Map::new();
            m.insert("name".into(), json!(a.name));
            m.insert("base".into(), json!(a.base));
            if let Some(t) = a.title.as_ref().filter(|t| !t.is_empty()) {
                m.insert("title".into(), json!(t));
            }
            Value::Object(m)
        })
        .collect();
    existing.insert("customApps".into(), Value::Array(clean));

    write_config_file(&existing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        m
    }

    #[test]
    fn parse_apps_handles_names_and_inline_bases() {
        let (names, overrides) = parse_apps("a, b=http://127.0.0.1:1, a");
        assert_eq!(names, vec!["a".to_string(), "b".to_string()], "重复要合并");
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].1, "http://127.0.0.1:1");
    }

    #[test]
    fn resolve_apps_reports_missing_bases() {
        let r = resolve_apps(&raw(&[
            ("apps", json!(["nx-kv", "other"])),
            ("appMap", json!({"nx-kv": {"base": "http://127.0.0.1:7877"}})),
        ]));
        assert_eq!(r.apps.len(), 1, "只有登记了基址的才桥");
        assert_eq!(r.apps[0].0, "nx-kv");
        assert_eq!(r.missing, vec!["other".to_string()], "跳过的必须报出来");
    }

    #[test]
    fn resolve_apps_includes_custom_apps() {
        let r = resolve_apps(&raw(&[(
            "customApps",
            json!([{"name": "my-api", "base": "http://127.0.0.1:9999"}]),
        )]));
        assert_eq!(r.apps.len(), 1);
        assert_eq!(r.apps[0].0, "my-api");
    }

    #[test]
    fn resolve_apps_honors_inline_base_in_whitelist() {
        let r = resolve_apps(&raw(&[(
            "apps",
            json!(["my-api=http://127.0.0.1:9999"]),
        )]));
        assert_eq!(r.apps.len(), 1);
        assert_eq!(r.apps[0].1, "http://127.0.0.1:9999");
    }

    #[test]
    fn app_name_validation_matches_server_rules() {
        assert!(is_valid_app_name("my-api"));
        assert!(is_valid_app_name("a1"));
        assert!(!is_valid_app_name("My-API"), "必须小写开头");
        assert!(!is_valid_app_name("1api"));
        assert!(!is_valid_app_name("my_api"), "不允许下划线");
        assert!(!is_valid_app_name(""));
        assert!(!is_valid_app_name(&"a".repeat(33)), "最长 32 位");
    }

    #[test]
    fn broken_config_falls_back_to_defaults() {
        let r = resolve_apps(&raw(&[("apps", json!("not-an-array"))]));
        assert!(r.apps.is_empty());
        assert!(r.missing.is_empty());
    }

    #[test]
    fn read_accounts_uses_empty_string_for_missing_fields() {
        let a = with_accounts(&raw(&[(
            "accounts",
            json!({"5": {"userId": "5", "deviceToken": "tok"}}),
        )]));
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].1.device_token, "tok");
        assert_eq!(a[0].1.email, "");
    }

    #[test]
    fn orphan_is_not_the_same_as_expired() {
        let mut orphan = AccountEntry::default();
        orphan.client_id = "laptop-1bkctmo0-d9a7u3".into();
        assert!(is_orphan(&orphan));
        assert!(!is_usable(&orphan));
        // expiresAt=0 仍然算「过期」，但界面必须靠 is_orphan 区分：
        // 没有令牌的条目给「切到它」按钮，切完就是退出登录。
        assert!(is_expired(&orphan));

        let mut expired = AccountEntry::default();
        expired.user_id = "6".into();
        expired.device_token = "tok".into();
        expired.expires_at = 1;
        assert!(!is_orphan(&expired), "有令牌的过期账号不是残骸");
        assert!(!is_usable(&expired));
    }

    #[test]
    fn prune_drops_orphans_and_clears_active_pointer() {
        let mut m = raw(&[
            ("activeAccount", json!("laptop-x")),
            (
                "accounts",
                json!({
                    "6": {"userId": "6", "deviceToken": "tok", "expiresAt": 4_102_444_800_000_i64},
                    "laptop-x": {"clientId": "laptop-x"}
                }),
            ),
        ]);
        let removed = prune_orphan_accounts(&mut m);
        assert_eq!(removed, vec!["laptop-x".to_string()]);
        assert_eq!(m["activeAccount"], json!(""), "当前账号指着残骸时要把指向一起撤掉");
        assert_eq!(with_accounts(&m).len(), 1);
    }
}
