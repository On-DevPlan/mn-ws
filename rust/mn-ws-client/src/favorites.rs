//! 「常用应用」记忆：最近暴露过的应用 + 它的基址。
//!
//! 与 TS 版 `client/src/core/favorites.ts` 同构。
//!
//! 为什么要有它：用户反复做的是同一件事 —— 「把这个端口再暴露一次」。
//! 原来每次都要重新敲名字和端口（而名字得是合法路由标识，端口得对），
//! 第二次暴露比第一次还费劲。这里把用过的条目记下来，面板上点一下就能重开。
//!
//! 与 customApps 的分工：
//!   customApps  = **当前**登记着的应用（进白名单、被桥）
//!   favorites   = **用过**的应用（含已经移除的），供一键重开
//! 所以移除一个应用不会把它从常用里抹掉 —— 否则「移除」就等于「忘记」。

use serde_json::{json, Value};

use crate::config;

/// 上限 20 条：再多就是日志而不是设置了。
const FAVORITES_LIMIT: usize = 20;

/// 一个用过的应用。
#[derive(Debug, Clone)]
pub struct FavoriteApp {
    pub name: String,
    pub base: String,
    pub title: Option<String>,
    /// 最近一次使用的时间戳（ms）；用于排序，越近越靠前
    pub used_at: i64,
}

impl FavoriteApp {
    /// 转成 JSON。
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("base".into(), json!(self.base));
        if let Some(t) = &self.title {
            m.insert("title".into(), json!(t));
        }
        m.insert("usedAt".into(), json!(self.used_at));
        Value::Object(m)
    }
}

/// 读常用应用（按最近使用排序）。
pub fn read_favorites() -> Vec<FavoriteApp> {
    let raw = config::read_config_file();
    let list = match raw.get("favorites") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let mut by_name: Vec<FavoriteApp> = Vec::new();
    for x in list {
        let Some(rec) = x.as_object() else { continue };
        let name = rec
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let base = rec
            .get("base")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() || base.is_empty() {
            continue;
        }
        let title = rec
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string());
        let used_at = rec.get("usedAt").and_then(|v| v.as_i64()).unwrap_or(0);
        // 同一个名字只留最近的一条
        match by_name.iter_mut().find(|f| f.name == name) {
            Some(prev) if prev.used_at >= used_at => {}
            Some(prev) => {
                prev.base = base;
                prev.title = title;
                prev.used_at = used_at;
            }
            None => by_name.push(FavoriteApp {
                name,
                base,
                title,
                used_at,
            }),
        }
    }
    by_name.sort_by(|a, b| b.used_at.cmp(&a.used_at));
    by_name.truncate(FAVORITES_LIMIT);
    by_name
}

/// 记一次「用过这个应用」。
///
/// 同名覆盖：同一个路由标识换了端口，就该更新而不是多出一条 ——
/// 否则常用列表里会出现两个同名项，用户点哪个全靠猜。
pub fn remember_favorite(name: &str, base: &str, title: Option<&str>) {
    let name = name.trim();
    let base = base.trim();
    if name.is_empty() || base.is_empty() {
        return;
    }
    let mut rest: Vec<FavoriteApp> = read_favorites()
        .into_iter()
        .filter(|f| f.name != name)
        .collect();
    rest.insert(
        0,
        FavoriteApp {
            name: name.to_string(),
            base: base.to_string(),
            title: title.map(|t| t.to_string()),
            used_at: crate::auth::now_ms(),
        },
    );
    rest.truncate(FAVORITES_LIMIT);

    let mut raw = config::read_config_file();
    raw.insert(
        "favorites".into(),
        Value::Array(rest.iter().map(|f| f.to_json()).collect()),
    );
    let _ = config::write_config_file(&raw);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorite_json_shape() {
        let f = FavoriteApp {
            name: "my-api".into(),
            base: "http://127.0.0.1:9999".into(),
            title: Some("我的服务".into()),
            used_at: 123,
        };
        let j = f.to_json();
        assert_eq!(j["name"], "my-api");
        assert_eq!(j["title"], "我的服务");
        assert_eq!(j["usedAt"], 123);
    }
}
