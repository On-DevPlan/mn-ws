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

/// 写回常用列表（排序 + 截断 + 落盘）。
fn write_favorites(list: Vec<FavoriteApp>) {
    let mut list = list;
    list.sort_by(|a, b| b.used_at.cmp(&a.used_at));
    list.truncate(FAVORITES_LIMIT);
    let mut raw = config::read_config_file();
    raw.insert(
        "favorites".into(),
        Value::Array(list.iter().map(|f| f.to_json()).collect()),
    );
    let _ = config::write_config_file(&raw);
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
    write_favorites(rest);
}

/// 删掉一条常用（按路由标识）。返回是否真的删了。
///
/// 为什么要有它：常用是「用过就记」，测试时的 3231、kkkk 也会留在这里 ——
/// 没有删除的话，这条列表只会被 20 条上限慢慢挤出，用户看着一直膈应。
pub fn remove_favorite(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let before = read_favorites();
    let rest: Vec<FavoriteApp> = before.iter().filter(|f| f.name != name).cloned().collect();
    if rest.len() == before.len() {
        return false;
    }
    write_favorites(rest);
    true
}

/// 编辑一条常用：换基址 / 换显示名（**路由标识不可改** —— reopen 靠它重开）。
///
/// 编辑不动 usedAt：改名不是「用过」，不该把条目顶到列表最前面。
/// 传 None 表示这一项保持原样；base 传空串报错（没有基址的常用没有意义）。
pub fn update_favorite(
    name: &str,
    base: Option<&str>,
    title: Option<&str>,
) -> Result<FavoriteApp, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("缺少路由标识：name".into());
    }
    if let Some(b) = base.map(str::trim) {
        if b.is_empty() {
            return Err(format!("{name}：基址不能为空"));
        }
    }
    let mut list = read_favorites();
    let Some(f) = list.iter_mut().find(|f| f.name == name) else {
        return Err(format!("常用里没有 {name}"));
    };
    if let Some(b) = base.map(str::trim) {
        f.base = b.to_string();
    }
    if let Some(t) = title {
        let t = t.trim();
        f.title = if t.is_empty() { None } else { Some(t.to_string()) };
    }
    let updated = f.clone();
    write_favorites(list);
    Ok(updated)
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

    #[test]
    fn remove_and_update_favorites() {
        // 隔离：测试落盘走临时目录（MN_WS_HOME），绝不碰真实配置
        let tmp = std::env::temp_dir().join(format!("mn-ws-fav-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let prev_home = std::env::var("MN_WS_HOME").ok();
        std::env::set_var("MN_WS_HOME", &tmp);

        remember_favorite("fav-a", "http://127.0.0.1:1111", None);
        remember_favorite("fav-b", "http://127.0.0.1:2222", None);

        // 编辑：换基址 + 清显示名
        let updated = update_favorite("fav-a", Some("http://127.0.0.1:1112"), Some("")).unwrap();
        assert_eq!(updated.base, "http://127.0.0.1:1112");
        assert_eq!(updated.title, None);
        let list = read_favorites();
        assert_eq!(list.iter().find(|f| f.name == "fav-a").unwrap().base, "http://127.0.0.1:1112");

        // 编辑不存在的条目报错；空基址报错
        assert!(update_favorite("nope", Some("http://x"), None).is_err());
        assert!(update_favorite("fav-a", Some("  "), None).is_err());

        // 删除：删得到 / 再删一次报 false
        assert!(remove_favorite("fav-b"));
        assert!(!read_favorites().iter().any(|f| f.name == "fav-b"));
        assert!(!remove_favorite("fav-b"));

        // 还原环境 + 清理临时目录
        match prev_home {
            Some(v) => std::env::set_var("MN_WS_HOME", v),
            None => std::env::remove_var("MN_WS_HOME"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
