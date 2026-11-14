//! mn-ws-server 的 CLI。
//!
//! server 半只有一个职责：把公网 HTTP 请求桥给本机的 nx 服务。
//! 所以这里**不套** client 半那套 action 框架 —— 那套是为「CLI 与 Web 面板
//! 同源」设计的，而 server 半没有面板。一台只有一个动作的服务，
//! 用框架反而是负担。
//!
//! 命令：
//!   mn-ws-server              启动中继服务（公网半，HTTP 与 WS 同端口共存）
//!   mn-ws-server doctor       环境自检（端口占用 / 鉴权配置）

use serde_json::{Map, Value};

use crate::config::{load_server_config, ServerConfig};

const C_RESET: &str = "\x1b[0m";
const C_BOLD: &str = "\x1b[1m";
const C_DIM: &str = "\x1b[90m";
const C_RED: &str = "\x1b[31m";
const C_GREEN: &str = "\x1b[32m";
const C_YELLOW: &str = "\x1b[33m";
const C_CYAN: &str = "\x1b[36m";

/// 解析命令行参数：`--key value` / `--key=value` / `--flag` / 位置参数。
///
/// 与 TS 版 `parseArgs` 同款：`-` 开头的是 flag（值取下一个非 `--` 开头的参数），
/// 其余是位置参数。`--` 之后全当位置参数。
pub fn parse_args(argv: &[String]) -> (Map<String, Value>, Vec<String>) {
    let mut flags = Map::new();
    let mut positional = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--" {
            positional.extend_from_slice(&argv[i + 1..]);
            break;
        }
        if let Some(rest) = a.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                flags.insert(camel(k), Value::String(v.to_string()));
            } else {
                let key = camel(rest);
                let next = argv.get(i + 1);
                match next {
                    Some(v) if !v.starts_with("--") => {
                        flags.insert(key, Value::String(v.clone()));
                        i += 1;
                    }
                    _ => {
                        flags.insert(key, Value::Bool(true));
                    }
                }
            }
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    (flags, positional)
}

/// kebab-case → camelCase（与 TS 版 `camel` 一致）。
fn camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut upper = false;
    for c in s.chars() {
        if c == '-' {
            upper = true;
            continue;
        }
        if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// 打印帮助。
fn print_help(version: &str) {
    println!();
    println!(
        "{C_BOLD}mn-ws-server{C_RESET} v{version} — mn-ws 的 server 半：公网侧的 HTTP ⇄ WebSocket 桥"
    );
    println!();
    println!("{C_BOLD}用法{C_RESET}");
    println!("  npx mn-ws-server [options]");
    println!();
    println!("{C_BOLD}选项{C_RESET}");
    println!("  --host <h>             监听地址（默认 0.0.0.0；无鉴权时只允许 127.0.0.1）");
    println!("  --port <n>             监听端口（默认 7777）");
    println!("  --ws-path <p>          WebSocket 路径（默认 /ws）");
    println!("  --token <TOKEN>        静态注册门禁（与 client 半配同一个）");
    println!("  --jwt-secret <s>       统一登录的 JWT 签名密钥（配了就启用设备令牌）");
    println!("  --auth-enabled <bool>  显式开/关统一登录（1/true/yes/on 与 0/false/no/off）");
    println!("  --issuer <url>         认证中心地址（默认 http://47.110.80.47:8082）");
    println!("  --idp-client-id <id>   server 半在认证中心的身份（默认 mn-ws-server）");
    println!("  --login-client-id <id> client 半在认证中心的身份（默认 mn-ws-client）");
    println!("  --insecure             允许无鉴权启动（**仅限本机自测**）");
    println!("  --log-level <level>    debug | info | warn | error（默认 info）");
    println!("  --help                 显示帮助");
    println!("  --version              显示版本");
    println!();
}

/// 顶层入口。返回进程退出码。
pub async fn run(argv: Vec<String>) -> i32 {
    let (flags, positional) = parse_args(&argv);
    let version = env!("CARGO_PKG_VERSION");

    if flags.get("version").is_some() {
        println!("{version}");
        return 0;
    }
    if flags.get("help").is_some() || positional.first().map(|s| s.as_str()) == Some("help") {
        print_help(version);
        return 0;
    }
    if positional.first().map(|s| s.as_str()) == Some("doctor") {
        return run_doctor(&flags).await;
    }
    if !positional.is_empty() {
        println!("{C_RED}未知命令：{}{C_RESET}", positional.join(" "));
        print_help(version);
        return 1;
    }

    let cfg = match load_server_config(&flags) {
        Ok(c) => c,
        Err(e) => {
            println!("{C_RED}✗ 配置有问题：{e}{C_RESET}");
            return 1;
        }
    };

    // ── 闸 1：没有鉴权就不许起 ──
    let has_gate = !cfg.token.is_empty();
    let has_jwt = !cfg.jwt_secret.is_empty();
    let want_auth = cfg.auth_enabled.unwrap_or(has_jwt);

    if want_auth && !has_jwt {
        println!("{C_RED}✗ 拒绝启动：统一登录已开启，但没有 JWT secret{C_RESET}");
        println!(
            "{C_DIM}签不出设备令牌 = 统一登录等于没开。给一个随机串，或把 MN_WS_AUTH_ENABLED 关掉。{C_RESET}"
        );
        return 1;
    }
    if !want_auth && has_jwt {
        println!(
            "{C_YELLOW}! 统一登录已显式关闭{C_RESET}{C_DIM}，JWT secret 不会生效{C_RESET}"
        );
    }
    if !has_gate && !want_auth && !cfg.insecure {
        println!("{C_RED}✗ 拒绝启动：没有任何鉴权配置{C_RESET}");
        println!(
            "{C_DIM}mn-ws server 会把本机的 nx 服务桥到公网，没有鉴权等于把整台机器挂在网上。{C_RESET}"
        );
        println!();
        println!(
            "  {C_CYAN}--token <TOKEN>{C_RESET}    与客户端配同一个静态门禁"
        );
        println!(
            "  {C_CYAN}MN_WS_JWT_SECRET=<随机>{C_RESET}  启用统一登录（推荐，可按用户隔离）"
        );
        println!(
            "  {C_CYAN}--insecure{C_RESET}          仅限本机自测，明知风险才用"
        );
        return 1;
    }
    if !has_gate && !want_auth && cfg.insecure {
        println!(
            "{C_YELLOW}! 已用 --insecure：无鉴权启动{C_RESET}{C_DIM} —— 任何人都能通过它调用本机服务{C_RESET}"
        );
    }

    // ── 闸 2：无鉴权时只许绑回环 ──
    if cfg.host == "0.0.0.0" && !has_gate && !want_auth {
        println!(
            "{C_RED}✗ 无鉴权时不允许绑 0.0.0.0{C_RESET}：请用 --host 127.0.0.1 自测"
        );
        return 1;
    }

    // ── 闸 3：端口被占 → 明确报错，不静默顺延 ──
    match crate::port::is_port_free(cfg.port, &cfg.host).await {
        Ok(true) => {}
        Ok(false) => {
            println!(
                "{C_RED}✗ 端口 {} 已被占用{C_RESET}{C_DIM}{C_RESET}",
                cfg.port
            );
            println!(
                "{C_DIM}换端口：--port <n>。不静默顺延 —— 客户端还按 {} 连，顺延只会让两边对不上账。{C_RESET}",
                cfg.port
            );
            return 1;
        }
        Err(e) => {
            println!("{C_RED}✗ 端口探测失败：{e}{C_RESET}");
            return 1;
        }
    }

    let options = crate::server::ServerOptions {
        host: cfg.host.clone(),
        port: cfg.port,
        ws_path: cfg.ws_path.clone(),
        token: cfg.token.clone(),
        issuer: cfg.issuer.clone(),
        idp_client_id: cfg.idp_client_id.clone(),
        login_client_id: cfg.login_client_id.clone(),
        redirect_uri: if cfg.redirect_uri.is_empty() {
            format!("http://127.0.0.1:{}/auth/callback", cfg.port)
        } else {
            cfg.redirect_uri.clone()
        },
        jwt_secret: cfg.jwt_secret.clone(),
        auth_enabled: want_auth,
        request_timeout_ms: cfg.request_timeout_ms,
        heartbeat_interval_ms: 15_000,
        data_dir: cfg.data_dir.clone(),
        log_level: cfg.log_level.clone(),
    };

    let actual = match crate::server::run(options).await {
        Ok(a) => a,
        Err(e) => {
            println!("{C_RED}✗ 起不来：{e}{C_RESET}");
            return 1;
        }
    };

    println!(
        "{C_GREEN}✓ mn-ws server 已启动{C_RESET}  http://{}:{}  ws={}",
        cfg.host,
        actual.port(),
        cfg.ws_path
    );
    println!(
        "{}  鉴权：{}{}{}{}{}",
        C_DIM,
        if want_auth { "统一登录（设备令牌）" } else { "" },
        if want_auth && has_gate { " + " } else { "" },
        if has_gate { "静态门禁" } else { "" },
        if !want_auth && !has_gate { "无（--insecure）" } else { "" },
        C_RESET,
    );
    println!(
        "{C_DIM}  配置目录：{}{C_RESET}",
        crate::config::config_dir().display()
    );

    // 常驻：等 Ctrl-C。
    let _ = tokio::signal::ctrl_c().await;
    println!("\n{C_DIM}退出。{C_RESET}");
    0
}

/// 环境自检。
async fn run_doctor(flags: &Map<String, Value>) -> i32 {
    let cfg = match load_server_config(flags) {
        Ok(c) => c,
        Err(e) => {
            println!("{C_RED}✗ 配置有问题：{e}{C_RESET}");
            return 1;
        }
    };
    let version = env!("CARGO_PKG_VERSION");
    println!("{C_BOLD}mn-ws-server doctor{C_RESET}  {C_DIM}v{version}{C_RESET}");
    println!();
    println!("{C_BOLD}端口{C_RESET}");
    match crate::port::is_port_free(cfg.port, &cfg.host).await {
        Ok(true) => println!("  server :{}  {C_GREEN}空闲{C_RESET}", cfg.port),
        Ok(false) => println!("  server :{}  {C_RED}已被占用{C_RESET}", cfg.port),
        Err(e) => println!("  server :{}  {C_RED}探测失败：{e}{C_RESET}", cfg.port),
    }
    println!();
    println!("{C_BOLD}鉴权{C_RESET}");
    if !cfg.jwt_secret.is_empty() {
        println!("  {C_GREEN}✓{C_RESET} 统一登录密钥已配置");
    } else {
        println!("  {C_YELLOW}!{C_RESET} 未配置统一登录密钥（MN_WS_JWT_SECRET）");
    }
    if !cfg.token.is_empty() {
        println!("  {C_GREEN}✓{C_RESET} 静态门禁 token（共享密钥，等价全量访问）");
    } else {
        println!("  {C_YELLOW}!{C_RESET} 未配置静态门禁（客户端只能用设备令牌注册）");
    }
    println!();
    println!("{C_BOLD}身份{C_RESET}");
    println!("  issuer              {}", cfg.issuer);
    println!("  server 半 client_id {}", cfg.idp_client_id);
    println!("  client 半 client_id {}", cfg.login_client_id);
    println!();
    println!(
        "{C_DIM}  数据目录：{}{C_RESET}",
        cfg.data_dir
            .as_ref()
            .map(|d| d.display().to_string())
            .unwrap_or_default()
    );
    0
}

/// 配置的只读视图（测试用）。
pub fn config_view(cfg: &ServerConfig) -> Value {
    serde_json::json!({
        "host": cfg.host,
        "port": cfg.port,
        "wsPath": cfg.ws_path,
        "token": cfg.token,
        "issuer": cfg.issuer,
        "idpClientId": cfg.idp_client_id,
        "loginClientId": cfg.login_client_id,
        "redirectUri": cfg.redirect_uri,
        "authEnabled": cfg.auth_enabled,
        "requestTimeoutMs": cfg.request_timeout_ms,
        "logLevel": cfg.log_level,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_handles_three_forms() {
        let argv: Vec<String> = ["--host", "127.0.0.1", "--port=8888", "--insecure"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (flags, positional) = parse_args(&argv);
        assert_eq!(flags["host"], Value::String("127.0.0.1".into()));
        assert_eq!(flags["port"], Value::String("8888".into()));
        assert_eq!(flags["insecure"], Value::Bool(true));
        assert!(positional.is_empty());
    }

    #[test]
    fn bare_flag_swallows_the_next_argument() {
        // 与 TS 版 `parseArgs` 同款语义：`--flag` 后面的非 `--` 参数被当成它的值。
        // （所以 `--insecure doctor` 里 `doctor` 会变成 `--insecure` 的值 ——
        //  这不是 bug，是「布尔开关写成 `--flag value` 形态」的必然结果，
        //  TS 版一模一样。真正的布尔开关要写成 `--insecure` 单独一个。）
        let argv: Vec<String> = ["--insecure", "doctor"].iter().map(|s| s.to_string()).collect();
        let (flags, positional) = parse_args(&argv);
        assert_eq!(flags["insecure"], Value::String("doctor".into()));
        assert!(positional.is_empty());
    }

    #[test]
    fn kebab_flags_become_camel_case() {
        let argv: Vec<String> = ["--ws-path", "/ws2", "--jwt-secret", "s", "--log-level", "debug"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (flags, _) = parse_args(&argv);
        assert_eq!(flags["wsPath"], Value::String("/ws2".into()));
        assert_eq!(flags["jwtSecret"], Value::String("s".into()));
        assert_eq!(flags["logLevel"], Value::String("debug".into()));
    }

    #[test]
    fn double_dash_stops_flag_parsing() {
        let argv: Vec<String> = ["--", "--not-a-flag", "x"].iter().map(|s| s.to_string()).collect();
        let (flags, positional) = parse_args(&argv);
        assert!(flags.is_empty());
        assert_eq!(positional, vec!["--not-a-flag".to_string(), "x".to_string()]);
    }
}
