//! mn-ws server 半 —— 库面。
//!
//! 二进制入口在 `main.rs`；这里暴露各模块，好让集成测试（`tests/e2e.rs`）
//! 能直接起一个真的 server 半来打穿。
//!
//! ## 为什么要有 lib 目标
//!
//! 集成测试只能访问 **lib** 目标，不能访问 bin 目标里的模块。
//! 没有 lib 的话，e2e 测试只能靠「起进程 + 打端口」—— 那会让每个用例
//! 都付一次进程启动的钱，而且拿不到 server 内部状态。

pub mod auth;
pub mod cli;
pub mod config;
pub mod logger;
pub mod port;
pub mod server;
pub mod store;
