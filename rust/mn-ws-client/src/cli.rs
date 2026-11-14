//! CLI 入口：解析参数、分派子命令。
//!
//! 使用方式与 TS 版**逐条对齐**（用户的使用方式不变）：
//!
//! ```text
//!   mn-ws serve [--port N] [--url ws://…] [--token …] [--apps a,b]
//!   mn-ws bridge start|stop
//!   mn-ws status
//!   mn-ws apps list|add|remove|set|known
//!   mn-ws catalog
//!   mn-ws auth login|list|switch|logout
//!   mn-ws help [命令]
//! ```
//!
//! 为什么不用 clap：这条 CLI 的参数面很小且要**逐条对齐**既有行为，
//! 手写解析器反而更可控（而且省一个依赖 —— 二进制小一截）。

use crate::apps;
use crate::auth;
use crate::bridge;
use crate::config;
use crate::control;
use crate::session;

/// CLI 的解析结果。
pub struct Args {
    pub command: Vec<String>,
    pub flags: Vec<(String, String)>,
    pub bools: Vec<String>,
}

impl Args {
    /// 取一个字符串 flag（`--flag value` 或 `--flag=value`）。
    pub fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// 是否有这个布尔 flag。
    pub fn has(&self, name: &str) -> bool {
        self.bools.iter().any(|b| b == name)
    }
}

/// 解析命令行参数。
///
/// 支持 `--flag value`、`--flag=value`、`--bool`。
/// `--` 之后的都当位置参数。
pub fn parse_args(argv: &[String]) -> Args {
    let mut command = Vec::new();
    let mut flags = Vec::new();
    let mut bools = Vec::new();

    let mut i = 0;
    let mut only_positional = false;
    while i < argv.len() {
        let a = &argv[i];
        if only_positional {
            command.push(a.clone());
            i += 1;
            continue;
        }
        if a == "--" {
            only_positional = true;
            i += 1;
            continue;
        }
        if let Some(rest) = a.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                flags.push((k.to_string(), v.to_string()));
            } else if i + 1 < argv.len() && !argv[i + 1].starts_with("--") {
                flags.push((rest.to_string(), argv[i + 1].clone()));
                i += 1;
            } else {
                bools.push(rest.to_string());
            }
            i += 1;
            continue;
        }
        command.push(a.clone());
        i += 1;
    }
    Args {
        command,
        flags,
        bools,
    }
}

/// 顶层入口。返回进程退出码。
pub fn run(argv: Vec<String>) -> i32 {
    // --version / -v 在解析前就认出来：
    // parse_args 会把 "--version" 当成布尔 flag（command 为空），
    // 于是它会落到 help 分支 —— 问版本号却打印帮助，是最让人困惑的一种不对。
    if argv.iter().any(|a| a == "--version" || a == "-v") {
        println!("mn-ws {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let args = parse_args(&argv);
    let cmd: Vec<&str> = args.command.iter().map(|s| s.as_str()).collect();

    match cmd.as_slice() {
        [] | ["help"] => {
            print_help();
            0
        }
        ["help", sub] => {
            print_sub_help(sub);
            0
        }
        ["serve"] => serve(&args),
        ["bridge", "start"] => bridge_cmd_start(&args),
        ["bridge", "stop"] => bridge_cmd_stop(),
        ["status"] => status(),
        ["apps", rest @ ..] => apps_cmd(rest, &args),
        ["catalog"] => catalog_cmd(),
        ["auth", rest @ ..] => auth_cmd(rest, &args),
        other => {
            eprintln!("未知命令: {}", other.join(" "));
            eprintln!("用 `mn-ws help` 看用法。");
            1
        }
    }
}

/// 起桥 + 起面板（本机 HTTP），并开浏览器。
fn serve(args: &Args) -> i32 {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("起运行时失败: {e}");
            return 1;
        }
    };
    rt.block_on(async move {
        let cfg = config::read_config_file();
        let resolved = config::resolve_apps(&cfg);

        if resolved.apps.is_empty() {
            eprintln!("白名单为空 —— 一个都不桥。");
            eprintln!("  用 `mn-ws apps add <名字> --port <端口>` 登记一个，");
            eprintln!("  或 `mn-ws serve --apps my-api=http://127.0.0.1:9999`。");
            return 1;
        }
        if !resolved.missing.is_empty() {
            eprintln!(
                "这些应用没有登记基址、已跳过: {}",
                resolved.missing.join(", ")
            );
            eprintln!("  登记方式: `mn-ws apps add <名字> --port <端口>`");
        }

        let web_port: u16 = args
            .flag("port")
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| {
                cfg.get("webPort")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(7777) as u16
            });
        let no_open = args.has("no-open");

        // 面板 + 桥在同一个进程里：面板的 /api/* 操作的正是这条桥。
        let handle = bridge::start_bridge(&cfg, &resolved).await;

        // 面板的登录态管理器：跨请求共享（起流程与收回调是两次请求）。
        let session = std::sync::Arc::new(session::SessionManager::new());
        // 复用 CLI 已存的登录态 —— 「命令行登一次，面板直接能用」。
        session.adopt_from_account_store(&cfg);

        let port = match control::serve_panel_with_session(
            web_port,
            handle.clone(),
            session,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("面板起不来: {e}");
                handle.shutdown();
                return 1;
            }
        };

        println!("面板: http://127.0.0.1:{port}/#/bridge");
        println!(
            "桥: 已连接 {}（白名单: {}）",
            cfg.get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("(未配置)"),
            resolved
                .apps
                .iter()
                .map(|(n, _)| n.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        if !no_open {
            let _ = webbrowser::open(&format!("http://127.0.0.1:{port}/#/bridge"));
        }

        // 常驻：等 Ctrl-C。
        let _ = tokio::signal::ctrl_c().await;
        println!("\n退出。");
        handle.shutdown();
        0
    })
}

/// 只起桥。
fn bridge_cmd_start(args: &Args) -> i32 {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("起运行时失败: {e}");
            return 1;
        }
    };
    rt.block_on(async move {
        let mut cfg = config::read_config_file();
        if let Some(v) = args.flag("apps") {
            cfg.insert("apps".into(), serde_json::json!(v));
        }
        if let Some(v) = args.flag("url") {
            cfg.insert("url".into(), serde_json::json!(v));
        }
        if let Some(v) = args.flag("token") {
            cfg.insert("token".into(), serde_json::json!(v));
        }
        if let Some(v) = args.flag("device-name") {
            cfg.insert("deviceName".into(), serde_json::json!(v));
        }
        let _ = config::write_config_file(&cfg);

        let resolved = config::resolve_apps(&cfg);
        if resolved.apps.is_empty() {
            eprintln!("白名单为空 —— 一个都不桥。");
            return 1;
        }
        let handle = bridge::start_bridge(&cfg, &resolved).await;
        println!(
            "桥: 已连接 {}（白名单: {}）",
            cfg.get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("(未配置)"),
            resolved
                .apps
                .iter()
                .map(|(n, _)| n.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        let _ = tokio::signal::ctrl_c().await;
        handle.shutdown();
        0
    })
}

/// 停桥。
fn bridge_cmd_stop() -> i32 {
    // 停桥 = 断掉正在跑的那个进程。TS 版靠「面板上的停桥」或杀进程；
    // 命令行这里给出明确提示 —— 真的停一个长驻进程需要知道它的 pid。
    let pid_file = config::config_dir().join("bridge.pid");
    if let Ok(text) = std::fs::read_to_string(&pid_file) {
        let pid: u32 = text.trim().parse().unwrap_or(0);
        if pid > 0 {
            // Windows 没有 SIGTERM 的跨平台等价 —— 直接结束进程。
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
            #[cfg(unix)]
            {
                unsafe {
                    libc_kill(pid as i32, 15);
                }
            }
            let _ = std::fs::remove_file(&pid_file);
            println!("已停桥 (pid {pid})");
            return 0;
        }
    }
    println!("没有正在跑的桥。");
    0
}

/// 看状态。
fn status() -> i32 {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);
    let accounts = config::with_accounts(&cfg);
    let active = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
    let cur = accounts.iter().find(|(k, _)| k == active);

    println!("桥接状态: {}", bridge::state_label());
    println!(
        "  server    {}",
        cfg.get("url").and_then(|v| v.as_str()).unwrap_or("(未配置)")
    );
    println!(
        "  本机标识  {}",
        cfg.get("clientId").and_then(|v| v.as_str()).unwrap_or("(未配置)")
    );
    println!(
        "  白名单    {}",
        resolved
            .apps
            .iter()
            .map(|(n, _)| n.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    let identity = cur
        .map(|(_, e)| {
            if e.nickname.is_empty() {
                e.email.clone()
            } else {
                e.nickname.clone()
            }
        })
        .unwrap_or_else(|| "静态门禁".to_string());
    println!("  身份      {}", identity);
    if !resolved.missing.is_empty() {
        println!("  说明      这些应用没有登记基址、已跳过: {}", resolved.missing.join(", "));
    }
    0
}

/// apps 子命令。
fn apps_cmd(rest: &[&str], args: &Args) -> i32 {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);
    match rest {
        ["list"] => {
            println!("可桥的应用（白名单）");
            if resolved.apps.is_empty() {
                println!("  （白名单为空 —— 一个都不桥。用 mn-ws apps set --apps my-api 设置）");
            } else {
                for (name, base) in &resolved.apps {
                    let title = resolved
                        .titles
                        .iter()
                        .find(|(t, _)| t == name)
                        .map(|(_, v)| v.as_str())
                        .unwrap_or("");
                    let port = base
                        .rsplit(':')
                        .next()
                        .and_then(|p| p.split('/').next())
                        .unwrap_or("");
                    println!("  {:<12} {:<26} {}", name, base, port);
                    if !title.is_empty() && title != name {
                        println!("               {}", title);
                    }
                }
            }
            if !resolved.missing.is_empty() {
                println!("\n这些应用在白名单里但没有登记基址、已跳过: {}", resolved.missing.join(", "));
            }
            0
        }
        ["known"] => {
            println!("已登记的应用");
            for a in config::registered_apps(&cfg) {
                println!("  {:<12} {:<26} {}", a.name, a.base, a.title.unwrap_or_default());
            }
            0
        }
        ["add"] => {
            let Some(name) = args.command.get(2).map(|s| s.as_str()) else {
                eprintln!("用法: mn-ws apps add <名字> [--port N] [--base URL] [--title 标题]");
                return 1;
            };
            if !config::is_valid_app_name(name) {
                eprintln!("应用名不合法: {name}");
                eprintln!("  规则: 小写字母开头，只含小写字母/数字/连字符，最长 32 位");
                return 1;
            }
            let base = if let Some(b) = args.flag("base") {
                b.to_string()
            } else if let Some(p) = args.flag("port") {
                format!("http://127.0.0.1:{p}")
            } else {
                eprintln!("要给 --port 或 --base");
                return 1;
            };
            let mut list = config::registered_apps(&cfg)
                .into_iter()
                .filter(|a| a.name != name)
                .collect::<Vec<_>>();
            list.push(config::CustomApp {
                name: name.to_string(),
                base,
                title: args.flag("title").map(|t| t.to_string()),
            });
            match config::save_custom_apps(&list) {
                Ok(_) => {
                    println!("已登记 {name}");
                    0
                }
                Err(e) => {
                    eprintln!("登记失败: {e}");
                    1
                }
            }
        }
        ["remove"] => {
            let Some(name) = args.command.get(2).map(|s| s.as_str()) else {
                eprintln!("用法: mn-ws apps remove <名字>");
                return 1;
            };
            let list = config::registered_apps(&cfg)
                .into_iter()
                .filter(|a| a.name != name)
                .collect::<Vec<_>>();
            // 连带把它从白名单里摘掉
            let mut raw = cfg.clone();
            if let Some(serde_json::Value::Array(a)) = raw.get("apps").cloned() {
                let kept: Vec<serde_json::Value> = a
                    .iter()
                    .filter(|v| {
                        let s = v.as_str().unwrap_or("");
                        s.split('=').next().unwrap_or(s) != name
                    })
                    .map(|v| serde_json::json!(v.as_str().unwrap_or("")))
                    .collect();
                raw.insert("apps".into(), serde_json::Value::Array(kept));
            }
            let _ = config::write_config_file(&raw);
            match config::save_custom_apps(&list) {
                Ok(_) => {
                    println!("已移除 {name}");
                    0
                }
                Err(e) => {
                    eprintln!("移除失败: {e}");
                    1
                }
            }
        }
        ["set"] => {
            let Some(spec) = args.flag("apps") else {
                eprintln!("用法: mn-ws apps set --apps my-api,other=http://127.0.0.1:7800");
                return 1;
            };
            let (names, overrides) = config::parse_apps(spec);
            let mut raw = cfg.clone();
            let mut arr: Vec<serde_json::Value> =
                names.iter().map(|n| serde_json::json!(n)).collect();
            for (n, b) in &overrides {
                if let Some(e) = arr.iter_mut().find(|v| v.as_str() == Some(n.as_str())) {
                    *e = serde_json::json!(format!("{n}={b}"));
                } else {
                    arr.push(serde_json::json!(format!("{n}={b}")));
                }
            }
            raw.insert("apps".into(), serde_json::Value::Array(arr));
            if !overrides.is_empty() {
                let mut m = serde_json::Map::new();
                for (n, b) in &overrides {
                    m.insert(n.clone(), serde_json::json!({"base": b}));
                }
                raw.insert("appMap".into(), serde_json::Value::Object(m));
            }
            match config::write_config_file(&raw) {
                Ok(_) => {
                    println!("白名单已更新: {}", names.join(", "));
                    0
                }
                Err(e) => {
                    eprintln!("写配置失败: {e}");
                    1
                }
            }
        }
        other => {
            eprintln!("未知子命令: apps {}", other.join(" "));
            1
        }
    }
}

/// 拉远端目录。
fn catalog_cmd() -> i32 {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("起运行时失败: {e}");
            return 1;
        }
    };
    rt.block_on(async move {
        let cfg = config::read_config_file();
        match bridge::fetch_catalog(&cfg).await {
            Ok(json) => {
                println!("{}", serde_json::to_string_pretty(&json).unwrap_or_default());
                0
            }
            Err(e) => {
                eprintln!("拉目录失败: {e}");
                1
            }
        }
    })
}

/// auth 子命令。
fn auth_cmd(rest: &[&str], args: &Args) -> i32 {
    let cfg = config::read_config_file();
    match rest {
        ["list"] => {
            let accounts = config::with_accounts(&cfg);
            let active = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
            println!("账号");
            if accounts.is_empty() {
                println!("  （本机还没有已存账号。登录一次: mn-ws auth login）");
            } else {
                for (key, e) in &accounts {
                    let mut line = format!(
                        "  {} {}{}",
                        config::label_of(e),
                        if key == active { "[当前] " } else { "" },
                        if config::is_expired(e) { "[已过期] " } else { "" }
                    );
                    if e.email != config::label_of(e) {
                        line.push_str(&format!("  {}", e.email));
                    }
                    println!("{line}");
                }
            }
            0
        }
        ["switch"] => {
            let Some(target) = args.command.get(2).map(|s| s.as_str()) else {
                eprintln!("用法: mn-ws auth switch <账号>");
                return 1;
            };
            let accounts = config::with_accounts(&cfg);
            let Some((key, _)) = accounts.iter().find(|(k, e)| {
                k == target
                    || config::entry_key_of(e) == target
                    || config::label_of(e) == target
            }) else {
                eprintln!("没有这个账号: {target}");
                return 1;
            };
            let mut raw = cfg.clone();
            raw.insert("activeAccount".into(), serde_json::json!(key));
            match config::write_config_file(&raw) {
                Ok(_) => {
                    println!("已切到 {target}");
                    0
                }
                Err(e) => {
                    eprintln!("切换失败: {e}");
                    1
                }
            }
        }
        ["logout"] => {
            let mut raw = cfg.clone();
            raw.insert("activeAccount".into(), serde_json::json!(""));
            if let Some(serde_json::Value::Object(accounts)) = raw.get("accounts").cloned() {
                let mut kept = accounts;
                kept.remove("activeAccount");
                raw.insert("accounts".into(), serde_json::Value::Object(kept));
            }
            match config::write_config_file(&raw) {
                Ok(_) => {
                    println!("已清空本机登录凭据");
                    0
                }
                Err(e) => {
                    eprintln!("清除失败: {e}");
                    1
                }
            }
        }
        ["login"] => {
            let rt = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("起运行时失败: {e}");
                    return 1;
                }
            };
            rt.block_on(async move { auth::login(&cfg).await })
        }
        other => {
            eprintln!("未知子命令: auth {}", other.join(" "));
            1
        }
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, sig: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, sig);
}

/// 打印用法。
fn print_help() {
    println!("mn-ws —— HTTP ⇄ WebSocket 双向桥（client 半）\n");
    println!("用法: mn-ws <命令> [选项]\n");
    println!("命令:");
    println!("  serve              起桥 + 起面板（本机 HTTP），自动开浏览器");
    println!("  bridge start       只起桥");
    println!("  bridge stop        停桥");
    println!("  status             看桥接状态");
    println!("  apps list          列出可桥的应用（白名单 + 端口探测）");
    println!("  apps add <名字>    登记一个应用（--port N 或 --base URL）");
    println!("  apps remove <名字> 移除一个应用");
    println!("  apps set           设白名单（--apps a,b=http://127.0.0.1:7800）");
    println!("  apps known         列出已登记的应用");
    println!("  catalog            拉远端目录");
    println!("  auth login         登录统一登录平台");
    println!("  auth list          列出已存账号");
    println!("  auth switch <账号> 切换账号");
    println!("  auth logout        清空登录凭据");
    println!("  help [命令]        看某个命令的用法");
    println!("\n常用选项:");
    println!("  --port N           面板端口（默认 7777）");
    println!("  --url ws://…       server 半地址");
    println!("  --token …          注册门禁");
    println!("  --apps a,b         白名单");
    println!("  --no-open          不自动开浏览器");
}

/// 打印某个命令的用法。
fn print_sub_help(sub: &str) {
    match sub {
        "serve" => println!(
            "mn-ws serve [--port N] [--url ws://…] [--token …] [--apps a,b] [--no-open]\n\n\
             起桥 + 起面板。面板在 127.0.0.1:<port>，自动开浏览器。"
        ),
        "apps" => println!(
            "mn-ws apps list|add|remove|set|known\n\n\
             list   列出可桥的应用\n\
             add    mn-ws apps add <名字> [--port N] [--base URL] [--title 标题]\n\
             remove mn-ws apps remove <名字>\n\
             set    mn-ws apps set --apps my-api,other=http://127.0.0.1:7800\n\
             known  列出已登记的应用"
        ),
        "auth" => println!(
            "mn-ws auth login|list|switch|logout\n\n\
             login  登录统一登录平台（浏览器授权）\n\
             list   列出已存账号\n\
             switch mn-ws auth switch <账号>\n\
             logout 清空本机登录凭据"
        ),
        _ => {
            print_help();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_handles_three_long_option_forms() {
        let argv: Vec<String> = ["serve", "--port", "9000", "--no-open", "--apps=a,b"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse_args(&argv);
        assert_eq!(a.command, vec!["serve".to_string()]);
        assert_eq!(a.flag("port"), Some("9000"));
        assert_eq!(a.flag("apps"), Some("a,b"));
        assert!(a.has("no-open"));
    }

    #[test]
    fn parse_args_handles_nested_subcommands() {
        let argv: Vec<String> = ["apps", "add", "my-api", "--port", "9999"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let a = parse_args(&argv);
        assert_eq!(a.command, vec!["apps", "add", "my-api"]);
        assert_eq!(a.flag("port"), Some("9999"));
    }
}
