//! app 标识与路由规则。
//!
//! 与 TS 版 `server/src/apps.ts` 逐条对应 —— **server 半与 client 半共用**。
//!
//! ## mn-ws 是**通用 HTTP 桥**，不是某个服务家族的附属
//!
//! 一个「应用」在本项目里只有三样东西：**名字**（路由标识）、**基址**
//! （`http://127.0.0.1:9999`）、**标题**（给人看的名字）。
//!
//! 这三样**全部由 client 半登记**（命令行 `--apps` / 面板上的动态注册），
//! server 半只从注册帧里学到它们。它不需要知道被桥的是什么 ——
//! 桥的是 KV 清单中枢、仓库中枢，还是一个临时起的调试服务，对它没有区别。
//!
//! 之所以要这样切：**「服务长什么样」是业务侧的事，「怎么把 HTTP 桥出去」
//! 是桥的事。**把某个服务族的名字、端口、用法写进桥的发行包，等于让桥背上
//! 别人的业务知识 —— 那个族一改版，桥就得跟着改；而桥的价值恰恰在于
//! 能桥任何东西。

use serde_json::{json, Value};

/// 请求头：应用标识的备用载体。
pub const APP_HEADER: &str = "x-mn-ws-app";

/// 应用名的合法形态：小写字母开头，只含小写字母/数字/连字符。
///
/// 它要当**路由标识**用（路径前缀 / X-Mn-Ws-App 头），所以必须是合法标识符。
///
/// 长度上限 32 位 —— 与 TS 版 `APP_NAME_RE` 的 `{0,31}` 一致。
pub fn is_valid_app_name(name: &str) -> bool {
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

/// 保留路径段：这些第一段**不可能**是应用标识。
///
/// 有这张表时，'/api/todo/list' 的第一段 'api' 会被当成 app 名 ——
/// 合法字符、全小写、还长得像个应用 —— 于是请求被路由到不存在的 app。
/// 这张表把服务自身的路径前缀排除掉。
pub const RESERVED_PATH_SEGMENTS: &[&str] = &[
    "api", "auth", "health", "stats", "clients", "push", "ws", "files", "assets", "static", "docs",
    "favicon.ico",
];

/// 从基址里取出端口。
///
/// 基址是唯一的事实来源 —— 端口是基址的一部分，不是另填的一张表。
pub fn port_of_base(base: &str) -> Option<u16> {
    if base.is_empty() {
        return None;
    }
    let u = url::Url::parse(base).ok()?;
    u.port().or_else(|| {
        // 没写端口时，http 默认 80、https 默认 443 —— 但「没写端口」
        // 与「显式写了默认端口」对调用方是一回事（都要知道往哪连）。
        match u.scheme() {
            "http" => Some(80),
            "https" => Some(443),
            _ => None,
        }
    })
}

/// 一个**已登记**的应用：名字 + 本地基址 + 标题。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDescriptor {
    /// 路由标识
    pub app: String,
    /// 本地基址，如 `http://127.0.0.1:9999`
    pub base: Option<String>,
    /// 端口（从基址里取）
    pub port: Option<u16>,
    /// 显示名。登记时没给就用名字兜底。
    pub title: String,
}

/// app 的元信息（注册时上报给 server，汇总成 catalog）。
///
/// client 半注册时把这份元信息一并报上�� server 半，server 把它汇总成
/// **元信息目录**（catalog）—— 远端客户端登录后先拉目录、
/// 看清楚「哪些能路由」再选。标题是动态注册的应用唯一能被认出来的线索，
/// 所以它必须一起报上去。
pub fn describe_app(app: &str, base: Option<&str>, title: Option<&str>) -> AppDescriptor {
    let base = base.map(|s| s.to_string());
    AppDescriptor {
        app: app.to_string(),
        port: base.as_deref().and_then(port_of_base),
        title: title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| app.to_string()),
        base,
    }
}

/// 描述成 JSON（注册帧里的形状）。
pub fn describe_app_json(d: &AppDescriptor) -> Value {
    json!({
        "app": d.app,
        "base": d.base,
        "port": d.port,
        "title": d.title,
    })
}

/// 解析结果：要么给出 app 与剩余路径，要么给出错误码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedApp {
    Resolved { app: String, path: String },
    Error(&'static str),
}

/// 从请求里解析出应用标识与剩余路径。
///
/// @param pathname  请求路径（不含 query）
/// @param headers  规范化后的小写头对象
pub fn resolve_app(pathname: &str, headers: &crate::protocol::ProtocolHeaders) -> ResolvedApp {
    let segs: Vec<&str> = pathname.split('/').filter(|s| !s.is_empty()).collect();
    let first = segs.first().copied();

    // ① 路径前缀：第一段就是声明过的 app 名（且不是服务自身的保留段）
    let mut path_app: Option<&str> = None;
    if let Some(f) = first {
        if is_valid_app_name(f) && !RESERVED_PATH_SEGMENTS.contains(&f) {
            path_app = Some(f);
        }
    }

    // ② 请求头
    let mut header_app: Option<String> = None;
    if let Some(hv) = headers.get(APP_HEADER) {
        if let Some(v) = hv.first() {
            let v = v.trim();
            if !v.is_empty() {
                if !is_valid_app_name(v) {
                    return ResolvedApp::Error("invalid_app_name");
                }
                header_app = Some(v.to_string());
            }
        }
    }

    // 两者都缺 → app_required；两者冲突 → app_conflict。
    // **冲突时报错而不是猜**：猜错等于把请求打到别人的服务上。
    if let (Some(pa), Some(ha)) = (path_app, header_app.as_deref()) {
        if pa != ha {
            return ResolvedApp::Error("app_conflict");
        }
    }
    let app = path_app.map(|s| s.to_string()).or(header_app);
    let Some(app) = app else {
        return ResolvedApp::Error("app_required");
    };

    let rest = if path_app.is_some() { &segs[1..] } else { &segs[..] };
    let path = format!("/{}", rest.join("/"));
    let path = if path == "/" {
        "/".to_string()
    } else {
        path.trim_end_matches('/').to_string()
    };
    ResolvedApp::Resolved { app, path }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ProtocolHeaders;

    fn headers(pairs: &[(&str, &str)]) -> ProtocolHeaders {
        let mut h = ProtocolHeaders::new();
        for (k, v) in pairs {
            h.insert(k.to_string(), vec![v.to_string()]);
        }
        h
    }

    #[test]
    fn app_name_rules_match_ts() {
        assert!(is_valid_app_name("my-api"));
        assert!(is_valid_app_name("a1"));
        assert!(!is_valid_app_name("My-API"), "必须小写开头");
        assert!(!is_valid_app_name("1api"));
        assert!(!is_valid_app_name("my_api"), "不允许下划线");
        assert!(!is_valid_app_name(""), "空名不合法");
        assert!(!is_valid_app_name(&"a".repeat(33)), "最长 32 位");
        assert!(is_valid_app_name(&"a".repeat(32)), "32 位合法");
    }

    #[test]
    fn path_prefix_resolves_app() {
        let r = resolve_app("/my-api/api/todo/list", &ProtocolHeaders::new());
        match r {
            ResolvedApp::Resolved { app, path } => {
                assert_eq!(app, "my-api");
                assert_eq!(path, "/api/todo/list");
            }
            other => panic!("应解析出 app，实际 {other:?}"),
        }
    }

    #[test]
    fn reserved_segment_is_not_an_app() {
        // 'api' 是保留段 → 不能被当成 app 名 → 缺 app → app_required
        let r = resolve_app("/api/todo/list", &ProtocolHeaders::new());
        assert_eq!(r, ResolvedApp::Error("app_required"));
    }

    #[test]
    fn header_resolves_app() {
        let r = resolve_app("/api/ping", &headers(&[("x-mn-ws-app", "my-api")]));
        match r {
            ResolvedApp::Resolved { app, path } => {
                assert_eq!(app, "my-api");
                assert_eq!(path, "/api/ping");
            }
            other => panic!("应解析出 app，实际 {other:?}"),
        }
    }

    #[test]
    fn conflicting_path_and_header_is_an_error() {
        let r = resolve_app("/other/x", &headers(&[("x-mn-ws-app", "my-api")]));
        assert_eq!(r, ResolvedApp::Error("app_conflict"));
    }

    #[test]
    fn matching_path_and_header_is_fine() {
        let r = resolve_app("/my-api/x", &headers(&[("x-mn-ws-app", "my-api")]));
        assert_eq!(
            r,
            ResolvedApp::Resolved {
                app: "my-api".into(),
                path: "/x".into()
            }
        );
    }

    #[test]
    fn invalid_header_app_name_is_rejected() {
        let r = resolve_app("/api/x", &headers(&[("x-mn-ws-app", "Bad_Name")]));
        assert_eq!(r, ResolvedApp::Error("invalid_app_name"));
    }

    #[test]
    fn trailing_slash_is_trimmed() {
        let r = resolve_app("/my-api/api/x/", &ProtocolHeaders::new());
        assert_eq!(
            r,
            ResolvedApp::Resolved {
                app: "my-api".into(),
                path: "/api/x".into()
            }
        );
    }

    #[test]
    fn port_of_base_reads_the_port() {
        assert_eq!(port_of_base("http://127.0.0.1:9999"), Some(9999));
        assert_eq!(port_of_base("http://127.0.0.1"), Some(80));
        assert_eq!(port_of_base("https://example.com"), Some(443));
        assert_eq!(port_of_base("not a url"), None);
        assert_eq!(port_of_base(""), None);
    }

    #[test]
    fn describe_app_falls_back_to_name_for_title() {
        let d = describe_app("my-api", Some("http://127.0.0.1:9999"), None);
        assert_eq!(d.title, "my-api");
        assert_eq!(d.port, Some(9999));
        let d = describe_app("my-api", Some("http://127.0.0.1:9999"), Some("我的服务"));
        assert_eq!(d.title, "我的服务");
        // 空白标题也当没给
        let d = describe_app("my-api", None, Some("   "));
        assert_eq!(d.title, "my-api");
    }
}
