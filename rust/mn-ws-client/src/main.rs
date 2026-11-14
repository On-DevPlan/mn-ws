//! mn-ws client 半 —— Rust 实现。
//!
//! 职责：把本机的 HTTP 服务桥给远端 HTTP 客户端。
//!
//!   远端 HTTP 客户端 → server 半（公网） → WS → **client 半（本进程）**
//!     → 本机 HTTP 服务 → 响应原路返回
//!
//! 运行形态与 TS 版**完全一致**（用户的使用方式不变）：
//!
//!   mn-ws serve            起桥 + 起面板（本机 HTTP），自动开浏览器
//!   mn-ws bridge start     只起桥
//!   mn-ws bridge stop      停桥
//!   mn-ws status           看状态
//!   mn-ws apps add/set/remove   管白名单
//!   mn-ws catalog          拉远端目录
//!   mn-ws auth login/list/switch/logout   管登录态
//!
//! 运行时**零 Node 依赖**：本进程是原生二进制，React 面板是构建期产物，
//! 由本进程当静态资源服务器伺服。

use mn_ws_client::cli;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(cli::run(args));
}
