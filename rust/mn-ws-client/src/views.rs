//! 面板的视图清单。
//!
//! 与 TS 版 `client/src/core/views.ts` 同款：**面板有哪些页**由后端下发，
//! 前端只按 id 找组件渲染。加一页 = 后端登记一行 + 前端登记一个组件。
//!
//! 这里刻意只放**页面清单**（id / title / order），不载组件 —— 组件在 React 侧，
//! 由 Vite 打包成懒加载 chunk。
//!
//! ⚠️ 用函数而不是 `const` 数组：`json!` 不是 const fn，编译期构造不了。

use serde_json::{json, Value};

/// 视图清单（id / title / order）。
pub fn views() -> Vec<Value> {
    vec![
        json!({"id": "home", "title": "首页", "order": 1}),
        json!({"id": "bridge", "title": "桥接", "order": 2}),
        json!({"id": "auth", "title": "登录", "order": 3}),
        json!({"id": "skill", "title": "技能", "order": 4}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_ids_are_unique_and_bridge_present() {
        let mut seen: Vec<String> = Vec::new();
        for v in views() {
            // 取出**拥有所有权**的 id：借用的 &str 会活不过 views() 的临时值。
            let id = v["id"].as_str().unwrap().to_string();
            assert!(!seen.contains(&id), "视图 id 重复: {id}");
            seen.push(id);
        }
        assert!(seen.iter().any(|s| s == "bridge"), "桥接页必须在");
    }
}
