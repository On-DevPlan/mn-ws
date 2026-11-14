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
use crate::commands;
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

    /// 取**全部**同名 flag（`--set k=v` 可重复）。
    pub fn flags_all(&self, name: &str) -> Vec<&str> {
        self.flags
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    /// 是否有这个布尔 flag。
    pub fn has(&self, name: &str) -> bool {
        self.bools.iter().any(|b| b == name)
    }

    /// 位置参数（去掉命令名本身）。
    ///
    /// ⚠️ `command[0]` 是命令名本身（`mn-ws greet 世界` → command = ["greet", "世界"]），
    ///    所以位置参数从索引 1 ���。
    pub fn positional(&self) -> &[String] {
        if self.command.is_empty() {
            &[]
        } else {
            &self.command[1..]
        }
    }

    /// 是否要 JSON 输出（`--json`）。
    pub fn json_mode(&self) -> bool {
        self.has("json")
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
    //
    // 输出**裸版本号**（与 `mn-ws version` 一致）：脚本里
    // `V=$(mn-ws --version)` 要能直接消费。
    if argv.iter().any(|a| a == "--version" || a == "-v") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let args = parse_args(&argv);
    // 命令名最多取**两段**（`bootstrap show`），其余位置参数是命令的实参。
    //
    // ⚠️ 匹配要「先试长的，再试短的」：`greet 世界` 的 command 是 ["greet", "世界"]，
    //    两段匹配不到 `greet`，得退到一段；而 `bootstrap show` 必须先按两段匹配，
    //    否则会被当成 `bootstrap` + 参数 "show"。
    let cmd2: Vec<&str> = args.command.iter().take(2).map(|s| s.as_str()).collect();
    let cmd1: Vec<&str> = args.command.iter().take(1).map(|s| s.as_str()).collect();

    // 先试两段，再试一段。
    let r = dispatch(&args, &cmd2);
    if r.is_none() && cmd2.len() > 1 {
        dispatch(&args, &cmd1)
    } else {
        r
    }
    .unwrap_or_else(|| {
        eprintln!("未知命令: {}", cmd2.join(" "));
        eprintln!("用 `mn-ws help` 看用法。");
        1
    })
}

/// 命令分发。返回 `None` 表示「这个命令名不认」（让调用方试更短的匹配）。
fn dispatch(args: &Args, cmd: &[&str]) -> Option<i32> {
    let one = cmd.len() <= 1;
    match cmd {
        ["help"] => {
            print_help();
            Some(0)
        }
        ["help", rest @ ..] => {
            print_sub_help(rest.first().copied());
            Some(0)
        }
        ["version"] => {
            // 裸版本号：脚本里 `V=$(mn-ws version)` 要能直接消费。
            println!("{}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        ["serve"] => Some(serve(args)),
        ["bridge", "start"] => Some(bridge_cmd_start(args)),
        ["bridge", "stop"] => Some(bridge_cmd_stop()),
        ["status"] => Some(status()),
        ["bootstrap", "show"] => Some(commands::emit(commands::bootstrap_show(), args.json_mode())),
        ["routes"] => Some(commands::emit(commands::routes(), args.json_mode())),
        ["health"] => Some(commands::emit(commands::health(), args.json_mode())),
        ["greet"] => Some(greet_cmd(args)),
        ["setting", "get"] => Some(commands::emit(commands::setting_get(), args.json_mode())),
        ["setting", "set"] => Some(setting_set_cmd(args)),
        ["apps", rest @ ..] => {
            let rest: Vec<&str> = if one { vec![] } else { rest.to_vec() };
            Some(apps_cmd(&rest, args))
        }
        ["catalog"] => Some(catalog_cmd()),
        ["auth", rest @ ..] => {
            let rest: Vec<&str> = if one { vec![] } else { rest.to_vec() };
            Some(auth_cmd(&rest, args))
        }
        _ => None,
    }
}

/// `greet`：打个招呼（演示动作：问候次数累计进本机存储）。
fn greet_cmd(args: &Args) -> i32 {
    let name = args.positional().first().map(|s| s.as_str()).unwrap_or("");
    if name.is_empty() {
        return commands::emit_error("缺少必填参数：name", "bad_input", args.json_mode());
    }
    let loud = args.has("loud");
    match commands::greet(name, loud) {
        Ok(o) => commands::emit(o, args.json_mode()),
        Err((msg, code)) => commands::emit_error(&msg, &code, args.json_mode()),
    }
}

/// `setting set`：修改设置。
fn setting_set_cmd(args: &Args) -> i32 {
    // `--set k=v` 可重复；`--key`/`--value` 是另一种写法。
    let mut sets: Vec<(String, String)> = Vec::new();
    for raw in args.flags_all("set") {
        match raw.split_once('=') {
            Some((k, v)) => sets.push((k.to_string(), v.to_string())),
            None => {
                return commands::emit_error(
                    &format!("--set 要写成 k=v（收到: {raw}）"),
                    "bad_input",
                    args.json_mode(),
                )
            }
        }
    }
    let refs: Vec<(&str, &str)> = sets.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    match commands::setting_set(
        args.flag("key"),
        args.flag("value"),
        &refs,
        args.has("dry-run"),
    ) {
        Ok(o) => commands::emit(o, args.json_mode()),
        Err((msg, code)) => commands::emit_error(&msg, &code, args.json_mode()),
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
            // 白名单为空**不阻止启动** —— 面板正是配置入口：
            // 用户还没登记任何应用时，面板必须能起来，否则他没法配。
            //
            // 桥会连上 server 但不注册任何 app（那是 server 侧的事），
            // 面板照常可用：登记应用、设白名单、登录，全在面板里做。
            eprintln!("! 白名单为空 —— 一个都不桥（面板仍可用，在那儿登记应用）");
            eprintln!("  登记方式: `mn-ws apps add <名字> --port <端口>`");
            eprintln!("  或 `mn-ws serve --apps my-api=http://127.0.0.1:9999`。");
        } else if !resolved.missing.is_empty() {
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
///
/// 实现复用 `control.rs` 里���面板同款函数 —— CLI 与面板是同一件事的两个入口，
/// 一份实现不可能分叉。JSON 形态与 TS 版逐条对齐。
fn apps_cmd(rest: &[&str], args: &Args) -> i32 {
    let cfg = config::read_config_file();
    let resolved = config::resolve_apps(&cfg);
    let json_mode = args.json_mode();
    match rest {
        ["list"] => {
            // 端口存活探测是异步的（TCP connect）—— 要起运行时。
            let rt = match tokio::runtime::Runtime::new() {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("起运行时失败: {e}");
                    return 1;
                }
            };
            let (data, text) = rt.block_on(async move {
                let data = control::bridge_apps(&cfg, &resolved).await;
                let text = render_apps_list(&resolved, &data);
                (data, text)
            });
            commands::emit(commands::Outcome { data, text }, json_mode)
        }
        ["known"] => {
            let data = serde_json::json!({
                "ok": true,
                "apps": config::registered_apps(&cfg)
                    .iter()
                    .map(|a| serde_json::json!({
                        "app": a.name,
                        "base": a.base,
                        "title": a.title.clone().unwrap_or_default(),
                    }))
                    .collect::<Vec<_>>(),
            });
            let text = {
                let mut lines = vec!["已登记的应用".to_string()];
                for a in config::registered_apps(&cfg) {
                    lines.push(format!(
                        "  {:<12} {:<26} {}",
                        a.name,
                        a.base,
                        a.title.unwrap_or_default()
                    ));
                }
                lines.join("\n")
            };
            commands::emit(commands::Outcome { data, text }, json_mode)
        }
        ["add"] => {
            let Some(name) = args.command.get(2).map(|s| s.as_str()) else {
                return commands::emit_error(
                    "用法: mn-ws apps add <名字> [--port N] [--base URL] [--title 标题]",
                    "bad_input",
                    json_mode,
                );
            };
            let mut params = serde_json::Map::new();
            params.insert("name".into(), serde_json::json!(name));
            if let Some(b) = args.flag("base") {
                params.insert("base".into(), serde_json::json!(b));
            }
            if let Some(p) = args.flag("port") {
                params.insert("port".into(), serde_json::json!(p));
            }
            if let Some(t) = args.flag("title") {
                params.insert("title".into(), serde_json::json!(t));
            }
            match control::add_custom_app(&cfg, &params) {
                Ok(data) => {
                    let text = format!(
                        "已登记 {}",
                        data["app"].as_str().unwrap_or(name)
                    );
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
            }
        }
        ["remove"] => {
            let Some(name) = args.command.get(2).map(|s| s.as_str()) else {
                return commands::emit_error(
                    "用法: mn-ws apps remove <名字>",
                    "bad_input",
                    json_mode,
                );
            };
            let mut params = serde_json::Map::new();
            params.insert("name".into(), serde_json::json!(name));
            match control::remove_custom_app(&cfg, &params) {
                Ok(data) => {
                    let text = format!("已移除 {name}");
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
            }
        }
        ["reopen"] => {
            let Some(name) = args.command.get(2).map(|s| s.as_str()) else {
                return commands::emit_error(
                    "用法: mn-ws apps reopen <名字>",
                    "bad_input",
                    json_mode,
                );
            };
            let mut params = serde_json::Map::new();
            params.insert("name".into(), serde_json::json!(name));
            match control::reopen_favorite(&cfg, &params) {
                Ok(data) => {
                    let text = format!(
                        "已重新暴露 {}",
                        data["app"].as_str().unwrap_or(name)
                    );
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
            }
        }
        ["set"] => {
            let Some(spec) = args.flag("apps") else {
                return commands::emit_error(
                    "用法: mn-ws apps set --apps my-api,other=http://127.0.0.1:7800",
                    "bad_input",
                    json_mode,
                );
            };
            let mut params = serde_json::Map::new();
            params.insert("apps".into(), serde_json::json!(spec));
            match control::set_whitelist(&cfg, &params) {
                Ok(data) => {
                    let apps: Vec<String> = data["apps"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let text = format!("白名单已更新: {}", apps.join(", "));
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
            }
        }
        other => {
            eprintln!("未知子命令: apps {}", other.join(" "));
            1
        }
    }
}

/// 渲染可桥应用清单（人读模式）。
///
/// 用的是**探测后**的数据（`alive` 字段）—— 渲染要反映真实存活情况。
fn render_apps_list(resolved: &config::ResolvedApps, data: &serde_json::Value) -> String {
    let mut lines = vec!["可桥的应用（白名单）".to_string()];
    let configured = data["configured"].as_array().cloned().unwrap_or_default();
    if configured.is_empty() {
        lines.push("  （白名单为空 —— 一个都不桥。用 mn-ws apps set --apps my-api 设置）".to_string());
    } else {
        for a in &configured {
            let port = a["port"]
                .as_u64()
                .map(|p| p.to_string())
                .unwrap_or_else(|| "—".to_string());
            let base = a["base"].as_str().unwrap_or("");
            let title = a["title"].as_str().unwrap_or("");
            let app = a["app"].as_str().unwrap_or("");
            lines.push(format!(
                "  {:<10} {:<7} {}  {}",
                app,
                port,
                if a["alive"].as_bool().unwrap_or(false) {
                    "✓ 在监听"
                } else {
                    "✗ 未运行"
                },
                base
            ));
            if !title.is_empty() && title != app {
                lines.push(format!("               {title}"));
            }
        }
    }
    if !resolved.missing.is_empty() {
        lines.push(String::new());
        lines.push(format!(
            "这些应用在白名单里但没有登记基址、已跳过: {}",
            resolved.missing.join(", ")
        ));
    }
    // 本机在跑但不在白名单里的（勾上才会被桥）。
    let alive_candidates: Vec<&serde_json::Value> = data["candidates"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|c| c["alive"].as_bool().unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    if !alive_candidates.is_empty() {
        lines.push(String::new());
        lines.push("本机在跑但不在白名单里（勾上才会被桥）：".to_string());
        for c in alive_candidates {
            lines.push(format!(
                "  {:<10} {:<7} {}",
                c["app"].as_str().unwrap_or(""),
                c["port"]
                    .as_u64()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "—".to_string()),
                c["title"].as_str().unwrap_or("")
            ));
        }
    }
    lines.join("\n")
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
///
/// 与 apps 同款：复用 `control.rs` 的面板实现，JSON 形态与 TS 版对齐。
fn auth_cmd(rest: &[&str], args: &Args) -> i32 {
    let cfg = config::read_config_file();
    let json_mode = args.json_mode();
    match rest {
        ["list"] => {
            let data = control::accounts_view(&cfg);
            let text = {
                let accounts = config::with_accounts(&cfg);
                let active = cfg.get("activeAccount").and_then(|v| v.as_str()).unwrap_or("");
                let mut lines = vec!["账号".to_string()];
                if accounts.is_empty() {
                    lines.push("  （本机还没有已存账号。登录一次: mn-ws auth login）".to_string());
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
                        lines.push(line);
                    }
                }
                lines.join("\n")
            };
            commands::emit(commands::Outcome { data, text }, json_mode)
        }
        ["status"] => {
            let data = control::auth_status(&cfg);
            let text = {
                let logged = data["loggedIn"].as_bool().unwrap_or(false);
                let who = if logged {
                    let n = data["nickname"].as_str().unwrap_or("");
                    let e = data["email"].as_str().unwrap_or("");
                    let u = data["userId"].as_str().unwrap_or("");
                    let who = if !n.is_empty() {
                        n.to_string()
                    } else if !e.is_empty() {
                        e.to_string()
                    } else if !u.is_empty() {
                        u.to_string()
                    } else {
                        "已登录".to_string()
                    };
                    format!(
                        "当前身份\n  {who}（{}）",
                        if data["via"].as_str() == Some("cli") {
                            "复用 CLI 登录态"
                        } else {
                            "面板登录"
                        }
                    )
                } else {
                    "当前身份\n  未登录：用静态门禁 token".to_string()
                };
                let mut lines = vec![who];
                lines.push(format!(
                    "  本机标识 {}",
                    data["clientId"].as_str().unwrap_or("")
                ));
                lines.push(format!(
                    "  server    {}",
                    data["serverHttp"].as_str().unwrap_or("")
                ));
                if data["expired"].as_bool().unwrap_or(false) {
                    lines.push("  ! 账号的设备令牌已过期：重新执行 mn-ws auth login".to_string());
                }
                lines.join("\n")
            };
            commands::emit(commands::Outcome { data, text }, json_mode)
        }
        ["switch"] => {
            let Some(target) = args.command.get(2).map(|s| s.as_str()) else {
                return commands::emit_error(
                    "用法: mn-ws auth switch <账号>",
                    "bad_input",
                    json_mode,
                );
            };
            let mut params = serde_json::Map::new();
            params.insert("account".into(), serde_json::json!(target));
            match control::auth_switch(&cfg, &params) {
                Ok(data) => {
                    let text = format!(
                        "已切换到: {}",
                        data["label"].as_str().unwrap_or(target)
                    );
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
            }
        }
        ["logout"] => {
            let mut params = serde_json::Map::new();
            if args.has("all") {
                params.insert("all".into(), serde_json::json!(true));
            }
            match control::auth_logout(&cfg, &params) {
                Ok(data) => {
                    let remaining = data["remaining"].as_u64().unwrap_or(0);
                    let text = if remaining > 0 {
                        format!("已清除当前账号的登录凭据（还剩 {remaining} 个账号）")
                    } else {
                        "已清空本机登录凭据".to_string()
                    };
                    commands::emit(commands::Outcome { data, text }, json_mode)
                }
                Err(e) => commands::emit_error(&e.message, e.code, json_mode),
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
    println!("  apps reopen <名字> 一键重新暴露一个用过的应用");
    println!("  apps set           设白名单（--apps a,b=http://127.0.0.1:7800）");
    println!("  apps known         列出已登记的应用");
    println!("  catalog            拉远端目录");
    println!("  auth login         登录统一登录平台");
    println!("  auth list          列出已存账号");
    println!("  auth switch <账号> 切换账号");
    println!("  auth status        看当前身份");
    println!("  auth logout        清空登录凭据");
    println!("  bootstrap show     一次取齐面板启动所需的全部上下文");
    println!("  routes             列出 CLI 命令与 HTTP 路由的对照表");
    println!("  health             自检：存储目录是否可写");
    println!("  setting get        读取全部设置");
    println!("  setting set        修改设置（--key/--value 或 --set k=v）");
    println!("  greet <名字>       打个招呼（演示动作）");
    println!("  version            显示版本号");
    println!("  help [命令]        看某个命令的用法");
    println!("\n常用选项:");
    println!("  --port N           面板端口（默认 7777）");
    println!("  --url ws://…       server 半地址");
    println!("  --token …          注册门禁");
    println!("  --apps a,b         白名单");
    println!("  --no-open          不自动开浏览器");
    println!("  --json             输出 JSON（脚本消费）");
}

/// 打印某个命令的用法。
fn print_sub_help(sub: Option<&str>) {
    let Some(sub) = sub else {
        print_help();
        return;
    };
    match sub {
        "serve" => println!(
            "mn-ws serve [--port N] [--url ws://…] [--token …] [--apps a,b] [--no-open]\n\n\
             起桥 + 起面板。面板在 127.0.0.1:<port>，自动开浏览器。"
        ),
        "apps" => println!(
            "mn-ws apps list|add|remove|reopen|set|known\n\n\
             list   列出可桥的应用\n\
             add    mn-ws apps add <名字> [--port N] [--base URL] [--title 标题]\n\
             remove mn-ws apps remove <名字>\n\
             reopen mn-ws apps reopen <名字>   一键重新暴露一个用过的应用\n\
             set    mn-ws apps set --apps my-api,other=http://127.0.0.1:7800\n\
             known  列出已登记的应用"
        ),
        "auth" => println!(
            "mn-ws auth login|list|switch|status|logout\n\n\
             login  登录统一登录平台（浏览器授权）\n\
             list   列出已存账号\n\
             switch mn-ws auth switch <账号>\n\
             status 看当前身份\n\
             logout 清空本机登录凭据"
        ),
        "setting" => println!(
            "mn-ws setting get|set\n\n\
             get 读取全部设置\n\
             set  mn-ws setting set --key theme --value dark\n\
             set  mn-ws setting set --set navGroups='[{{\"title\":\"求职\",\"views\":[\"home\"]}}]'\n\
             set  支持 --dry-run（只试算不落盘）"
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
