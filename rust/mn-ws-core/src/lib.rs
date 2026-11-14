//! mn-ws 的**共享协议层** —— server 半与 client 半的唯一协议实现。
//!
//! 两半都转 Rust 之后，协议如果各写各的就有**两份实现**：漂移是静默的
//! （帧能解、字段对不上，症状是「桥接上了但请求莫名其妙失败」）。
//! 契约测试只能**发现**漂移，不能**杜绝**它 —— 共用一个 crate 才能杜绝。
//!
//! 模块：
//!   · `protocol` —— 帧格式、头的规范化与剥离
//!   · `apps`     —— app 标识与路由规则（resolveApp / describeApp）

pub mod apps;
pub mod protocol;

pub use apps::{describe_app, is_valid_app_name, resolve_app, AppDescriptor, ResolvedApp};
pub use protocol::{
    decode_frame, encode_frame, flatten_headers, next_request_id, normalize_headers,
    strip_request_headers, strip_response_headers, Frame, ProtocolHeaders, MAX_BODY_BYTES,
};
