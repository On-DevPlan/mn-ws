//! CLI 与面板共用的业务命令。
//!
//! ## 为什么单独一个模块
//!
//! 每个动作**都有一份实现**，CLI 与面板只是两个入口：
//! `mn-ws greet 世界` 与 `POST /api/greet` 做的是同一件事。
//!
//! 这一点是「Web 上每个操作都有等价 CLI 命令」的结构性保证 ——
//! 实现只有一份，不可能两边分叉。
//!
//! ## 输出形态
//!
//! 每个命令有两种输出：
//!   · **人读模式**（默认）：给人看的文本
//!   · **--json**：机器可读的 JSON（脚本消费）
//!
//! 与 TS 版同款：`--json` 时错误信封也走 stdout（人读模式走 stderr），
//! 这样脚本 `mn-ws greet --json | jq` 不用管流。

use serde_json::{json, Map, Value};

use crate::config;
use crate::control;

/// 一个命令的执行结果（数据 + 人读渲染）。
pub struct Outcome {
    pub data: Value,
    pub text: String,
}

/// 输出结果（按 `--json` 决定形态）。
///
/// 失败时错误信封走 stdout（--json 模式）或 stderr（人读模式）。
pub fn emit(outcome: Outcome, json_mode: bool) -> i32 {
    if json_mode {
        println!("{}", serde_json::to_string(&outcome.data).unwrap_or_default());
    } else {
        println!("{}", outcome.text);
    }
    0
}

/// 输出一个错误。
pub fn emit_error(message: &str, code: &str, json_mode: bool) -> i32 {
    if json_mode {
        let payload = json!({ "ok": false, "error": message, "code": code });
        println!("{}", serde_json::to_string(&payload).unwrap_or_default());
    } else {
        eprintln!("{message}");
    }
    1
}

/// `bootstrap show`：一次取齐面板启动所需的全部上下文。
pub fn bootstrap_show() -> Outcome {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);
    let data = control::bootstrap(&cfg, &resolved);
    let text = serde_json::to_string_pretty(&data).unwrap_or_default();
    Outcome { data, text }
}

/// `routes`：列出 CLI 命令与 HTTP 路由的对照表。
pub fn routes() -> Outcome {
    let table = control::command_table();
    let count = table.len();
    let mut lines = vec![format!("共 {count} 条命令（CLI ↔ HTTP 对照）"), String::new()];
    // 表格宽度按**命令行**的字符数算（不是段数）—— 否则短命令的列会错位。
    let cli_texts: Vec<String> = table
        .iter()
        .map(|c| {
            c["command"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default()
        })
        .collect();
    let width = cli_texts.iter().map(|s| s.chars().count()).max().unwrap_or(0);
    let mut rows: Vec<Value> = Vec::new();
    for (i, c) in table.iter().enumerate() {
        let cli = &cli_texts[i];
        let http = c["http"]
            .as_object()
            .map(|h| {
                format!(
                    "{} {}",
                    h["method"].as_str().unwrap_or(""),
                    h["path"].as_str().unwrap_or("")
                )
            })
            .unwrap_or_else(|| "(仅 CLI)".to_string());
        let summary = c["summary"].as_str().unwrap_or("");
        // ⚠️ 宽度差用 saturating_sub —— cli 的字符数可能超过 width
        //    （width 是本表里的最大值，理论上不会，但一旦表变了就会下溢 panic）。
        let pad = width.saturating_sub(cli.chars().count());
        lines.push(format!("  {cli}{}{http}", " ".repeat(pad + 2)));
        if !summary.is_empty() {
            lines.push(format!("      {summary}"));
        }
        // JSON 形态与 TS 版一致：http 是**字符串**（"GET /api/x"），不是对象。
        rows.push(json!({
            "id": c["id"],
            "module": c["module"],
            "cli": c["command"],
            "http": if http == "(仅 CLI)" { Value::Null } else { json!(http) },
            "summary": summary,
        }));
    }
    let data = json!({
        "status": "ok",
        "count": count,
        "routes": rows,
    });
    Outcome {
        data,
        text: lines.join("\n"),
    }
}

/// `health`：自检 —— 存储目录是否可写。
///
/// 实现复用 `control::health` —— CLI 与面板是同一件事的两��入口。
pub fn health() -> Outcome {
    let data = control::health();
    let ok = data["status"] == "ok";
    let text = if ok {
        format!("正常 · 存储 {}", data["storePath"].as_str().unwrap_or(""))
    } else {
        format!("异常 · {}", data["reason"].as_str().unwrap_or(""))
    };
    Outcome { data, text }
}

/// `greet`：打个招呼（问候次数累计进本机存储）。
pub fn greet(name: &str, loud: bool) -> Result<Outcome, (String, String)> {
    let mut params = Map::new();
    params.insert("name".into(), json!(name));
    if loud {
        params.insert("loud".into(), json!(true));
    }
    match control::greet(&params) {
        Ok(data) => {
            let text = data["greeting"].as_str().unwrap_or("").to_string();
            Ok(Outcome { data, text })
        }
        Err(e) => Err((e.message, e.code.to_string())),
    }
}

/// `setting get`：读取全部设置。
pub fn setting_get() -> Outcome {
    let data = control::get_settings();
    let mut lines = vec![format!(
        "当前设置（改：mn-ws setting set --set k=v）· 主题: {}",
        data["settings"]["theme"].as_str().unwrap_or("light")
    )];
    if let Some(schema) = data["schema"].as_array() {
        for s in schema {
            lines.push(format!(
                "  {:<12} {}",
                s["key"].as_str().unwrap_or(""),
                s["hint"].as_str().unwrap_or("")
            ));
        }
    }
    let hidden: Vec<String> = data["settings"]["navHidden"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(views) = data["views"].as_array() {
        lines.push(String::new());
        lines.push(format!("页面（{}）· 隐藏 {} 个", views.len(), hidden.len()));
        for v in views {
            let id = v["id"].as_str().unwrap_or("");
            let title = v["title"].as_str().unwrap_or("");
            lines.push(format!(
                "  {:<12} {:<10} {}",
                id,
                title,
                if hidden.iter().any(|h| h == id) {
                    "隐藏"
                } else {
                    "显示"
                }
            ));
        }
    }
    if let Some(groups) = data["settings"]["navGroups"].as_array() {
        lines.push(String::new());
        if groups.is_empty() {
            lines.push("分组：无（全部页面平铺在头部）".to_string());
        } else {
            lines.push(format!("分组（{}）· 组顺序 = 头部顺序，组内顺序 = 展开列表顺序", groups.len()));
            for g in groups {
                let views: Vec<String> = g["views"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                lines.push(format!("  {}: {}", g["title"].as_str().unwrap_or(""), views.join(" → ")));
            }
        }
    }
    Outcome {
        data,
        text: lines.join("\n"),
    }
}

/// `setting set`：修改设置（PATCH 语义：只改传入的项）。
///
/// 支持 `--key <名> --value <值>` 与 `--set k=v`（可重复）。
pub fn setting_set(
    key: Option<&str>,
    value: Option<&str>,
    sets: &[(&str, &str)],
    dry_run: bool,
) -> Result<Outcome, (String, String)> {
    let mut params = Map::new();
    if let Some(k) = key {
        params.insert("key".into(), json!(k));
        params.insert(
            "value".into(),
            match value {
                Some(v) => json!(v),
                None => Value::Null,
            },
        );
    }
    if !sets.is_empty() {
        let mut m = Map::new();
        for (k, v) in sets {
            m.insert((*k).to_string(), json!(v));
        }
        params.insert("set".into(), Value::Object(m));
    }
    if dry_run {
        params.insert("dry-run".into(), json!(true));
    }
    match control::set_settings(&params) {
        Ok(data) => {
            let text = if data["status"] == "skipped" {
                let would = data["wouldSet"].clone();
                format!(
                    "试运行（未落盘）：将写入 {}",
                    serde_json::to_string(&would).unwrap_or_default()
                )
            } else {
                let groups = data["settings"]["navGroups"].as_array().map(|a| a.len()).unwrap_or(0);
                let hidden = data["settings"]["navHidden"].as_array().map(|a| a.len()).unwrap_or(0);
                format!("已更新设置：{groups} 个导航分组，隐藏 {hidden} 个页面")
            };
            Ok(Outcome { data, text })
        }
        Err(e) => Err((e.message, e.code.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_include_every_expected_command() {
        let o = routes();
        let ids: Vec<&str> = o.data["routes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["id"].as_str())
            .collect();
        for expect in [
            "home.bootstrap",
            "home.routes",
            "home.health",
            "home.greet",
            "setting.get",
            "setting.set",
            "auth.login",
            "auth.list",
            "auth.switch",
            "auth.status",
            "auth.logout",
            "auth.prune",
            "bridge.status",
            "bridge.apps",
            "bridge.whitelist.set",
            "bridge.apps.add",
            "bridge.apps.remove",
            "bridge.apps.reopen",
            "bridge.catalog",
            "bridge.start",
            "bridge.stop",
            "bridge.known",
        ] {
            assert!(ids.contains(&expect), "命令表缺 {expect}");
        }
    }

    #[test]
    fn routes_text_mentions_http_mapping() {
        let o = routes();
        assert!(o.text.contains("CLI ↔ HTTP 对照"));
        assert!(o.text.contains("GET /api/bootstrap"));
    }
}
