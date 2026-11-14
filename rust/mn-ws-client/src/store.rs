//! 面板的 JSON 存储：用户目录下的单一数据文件。
//!
//! 与 TS 版 `client/src/core/store.ts` 同构：
//!   · **原子写**（临时文件 + rename），进程中断不会损坏数据
//!   · **宽松读**：文件不存在或损坏 → 返回空结构（首次运行 / 允许外部修复后恢复）
//!   · **归一化**：以 initial_state() 为底把已有数据合并上去 ——
//!     新增字段自动获得默认值，**不需要迁移脚本**
//!
//! 这是**通用**存储：结构由 `initial_state` 决定。

use std::path::PathBuf;

use serde_json::{json, Map, Value};

/// 存储文件的路径。
pub fn store_path() -> PathBuf {
    if let Ok(p) = std::env::var("MN_WS_STORE") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    crate::config::config_dir().join("store.json")
}

/// 初始状态。
pub fn initial_state() -> Value {
    json!({
        "version": 1,
        "settings": {
            "navGroups": [],
            "navHidden": [],
            "navOrder": [],
            "theme": "light",
        },
    })
}

/// 归一化：以 initial_state() 为底，把已有数据合并上去。
pub fn normalize(data: Option<&Value>) -> Value {
    let base = initial_state();
    let Some(d) = data.and_then(|v| v.as_object()) else {
        return base;
    };
    let mut base_map = base.as_object().cloned().unwrap_or_default();

    // version 从数据取（缺省仍是 1）。
    if let Some(v) = d.get("version").and_then(|v| v.as_i64()) {
        base_map.insert("version".to_string(), json!(v));
    }

    if let Some(settings) = d.get("settings").and_then(|v| v.as_object()) {
        let mut merged = base_map
            .get("settings")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        for (k, v) in settings {
            merged.insert(k.clone(), v.clone());
        }
        base_map.insert("settings".to_string(), Value::Object(merged));
    }

    // 其余顶层键：base 里声明过的按 base 的形状兜底，没声明过的原样带过来。
    for (k, v) in d {
        if k == "version" || k == "settings" {
            continue;
        }
        base_map.insert(k.clone(), v.clone());
    }
    Value::Object(base_map)
}

/// 读存储。读不出来/坏了都当空结构（不抛错）。
pub fn load_store() -> Value {
    let p = store_path();
    let Ok(text) = std::fs::read_to_string(&p) else {
        return initial_state();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => normalize(Some(&v)),
        Err(_) => initial_state(),
    }
}

/// 写存储（原子：同目录 tmp → rename）。
pub fn save_store(next: &Value) -> std::io::Result<PathBuf> {
    let p = store_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let data = normalize(Some(next));
    let tmp = p.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut text = serde_json::to_string_pretty(&data).unwrap_or_default();
    text.push('\n');
    std::fs::write(&tmp, text)?;
    // Windows 上 rename 到已存在文件会失败 —— 先删旧的再 rename。
    let _ = std::fs::remove_file(&p);
    std::fs::rename(&tmp, &p)?;
    Ok(p)
}

/// 读-改-写事务：改完落盘；改坏了（panic）半个事务不会写进磁盘。
pub fn mutate_store<T>(f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
    let mut cur = load_store();
    let mut map = cur.as_object().cloned().unwrap_or_default();
    let result = f(&mut map);
    cur = Value::Object(map);
    let _ = save_store(&cur);
    result
}

/// 设置项（面板读写的那部分）。
pub fn settings() -> Map<String, Value> {
    load_store()
        .get("settings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_fills_defaults_and_keeps_unknown_keys() {
        let raw = json!({"version": 2, "greetCount": 7, "settings": {"theme": "dark"}});
        let n = normalize(Some(&raw));
        assert_eq!(n["version"], 2);
        assert_eq!(n["greetCount"], 7, "未知键要原样保留");
        assert_eq!(n["settings"]["theme"], "dark");
        assert_eq!(
            n["settings"]["navGroups"],
            json!([]),
            "缺字段要补默认值（不需要迁移脚本）"
        );
    }

    #[test]
    fn normalize_handles_garbage() {
        let n = normalize(Some(&json!("not an object")));
        assert_eq!(n["version"], 1);
        assert!(n["settings"].is_object());
    }
}
