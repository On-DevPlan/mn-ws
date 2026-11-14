//! 应用登记表：应用名 ↔ 基址 ↔ 标题。
//!
//! mn-ws **不认识任何具体服务** —— 它只认「名字 + 基址」这一层抽象。
//! 名字是**路由标识**（远端用 `X-Mn-Ws-App` 或路径前缀 `/<name>/...` 命中它），
//! 基址是本机的 HTTP 服务地址。

use serde_json::Value;

use crate::config::{self, CustomApp};

/// 一条已登记的应用。
pub fn list_registered(cfg: &serde_json::Map<String, Value>) -> Vec<CustomApp> {
    config::registered_apps(cfg)
}

/// 应用名是否合法（与 server 侧 `APP_NAME_RE` 同一条规则）。
pub fn is_valid_name(name: &str) -> bool {
    config::is_valid_app_name(name)
}

/// 从 `--apps` 参数解析白名单（名字，可带内联基址）。
pub fn parse_apps(spec: &str) -> (Vec<String>, Vec<(String, String)>) {
    config::parse_apps(spec)
}
