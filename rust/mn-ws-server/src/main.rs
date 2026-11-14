//! mn-ws server 半 —— Rust 实现。
//!
//! 职责：把公网侧的 HTTP 请求桥给本机的 HTTP 服务。
//!
//!   远端 HTTP 客户端 → **server 半（公网）** → WS → client 半（本机）
//!     → 本机 HTTP 服务 → 响应原路返回
//!
//! 运行时**零 Node 依赖**：本进程是原生二进制。
//!
//! 协议层（帧格式 + app 路由规则）在 `mn-ws-core` crate ——
//! client 半也依赖它，两半只有**一份**协议实现。

use mn_ws_server::cli;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // tokio 运行时：多线程（WS 收、发、HTTP 转发要能并发）。
    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("起运行时失败: {e}");
            std::process::exit(1);
        }
    };
    std::process::exit(rt.block_on(cli::run(args)));
}
