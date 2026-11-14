//! mn-ws client 半 —— 库面。
//!
//! 二进制入口在 `main.rs`；这里暴露各模块，好让集成测试（`tests/panel_login.rs`）
//! 能直接驱动面板登录流程。
//!
//! ## 为什么要有 lib 目标
//!
//! 集成测试只能访问 **lib** 目标，不能访问 bin 目标里的模块。
//! 没有 lib 的话，登录流程的测试只能靠「起进程 + 打端口」——
//! 那会让每个用例都付一次进程启动的钱，而且拿不到流程内部状态。

pub mod apps;
pub mod auth;
pub mod bridge;
pub mod cli;
pub mod commands;
pub mod config;
pub mod control;
pub mod data_plane;
pub mod favorites;
pub mod session;
pub mod store;
pub mod views;

/// 共享协议层：帧格式与 app 路由规则。
///
/// server 半也依赖同一个 crate —— 协议只有**一份实现**，
/// 「帧能解、字段对不上」的静默漂移在结构上就不可能发生。
pub use mn_ws_core::protocol;
