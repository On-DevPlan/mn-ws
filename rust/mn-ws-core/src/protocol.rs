//! mn-ws 的**共享协议层**：server 半与 client 半的唯一协议实现。
//!
//! 帧是 JSON 文本。**请求类帧带 id 用于配对** —— 一条 WS 连接上同时跑多个
//! HTTP 请求，响应按 id 归位。
//!
//! 这套协议刻意做成**零语义**的：帧里装的就是「一次 HTTP 请求」与
//! 「一次 HTTP 响应」，server 半原样转发、client 半原样还原。
//! 任何业务语义（nx 的 action、鉴权规则）都不进协议层。
//!
//! ## 为什么两半共用一个 crate
//!
//! 两半都转 Rust 之后，协议如果各写各的就有**两份实现**：
//! 「帧能解、字段对不上」的漂移是**静默**的 —— 症状是「桥接上了但请求莫名其妙失败」。
//! 契约测试只能**发现**漂移，不能**杜绝**它。
//!
//! 共用一个 crate 之后，改协议必须改一处，两端同时生效 —— 漂移在结构上不可能发生。
//!
//! ## 键序
//!
//! 帧的 JSON **键序**与 TS 版一致（`serde_json` 的 `preserve_order`）。
//! 这不是审美问题：键序变了，帧的字节就变了，「逐字节对比」会误报成协议不一致。

use indexmap::IndexMap;
use serde_json::Value;

/// 协议版本。server 半用它拒绝版本不符的连接。
pub const PROTOCOL_VERSION: u32 = 1;

/// 帧类型。
pub mod frame_type {
    // server → client
    pub const WELCOME: &str = "welcome";
    pub const REGISTERED: &str = "registered";
    pub const REQUEST: &str = "request";
    pub const ABORT: &str = "abort";
    pub const PING: &str = "ping";
    pub const SHUTDOWN: &str = "shutdown";
    pub const ERROR: &str = "error";
    // client → server
    pub const REGISTER: &str = "register";
    pub const RESPONSE: &str = "response";
    pub const CHUNK: &str = "chunk";
    pub const PONG: &str = "pong";
}

/// 不能跨代理转发的头（hop-by-hop）。
///
/// 这些头描述的是**某一次连接**的属性，转发到下一跳会出错或无意义：
///   · Connection: keep-alive  —— 新连接会自己协商
///   · Transfer-Encoding: chunked —— body 已经被完整读成 buffer，重新算长度
///   · Upgrade / Proxy-*        —— 代理自己的协商，不该替下游决定
pub const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// 请求头里必须**剥离**的头：
///   · hop-by-hop —— 描述的是某一次连接，不该跨代理
///   · Origin     —— 很多服务的同源防护只放行本机来源，透传浏览器 Origin 会 403
///   · X-Mn-Ws-Token —— **mn-ws 自己的 L1 凭据**，属于桥接层内部事务，
///     泄给目标服务等于把门禁令牌交出去
pub const STRIP_REQUEST_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "origin",
    "x-mn-ws-token",
];

/// 响应头里不能转发的头。
///
/// `content-length` 会在 client half 重新按实际 body 长度计算；
/// `content-encoding` 由 client half 的 http 客户端处理，body 到手时已解码。
pub const STRIP_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
];

/// 请求体上限（字节）。24MB 上限，base64 后约 32MB 帧。
pub const MAX_BODY_BYTES: usize = 24 * 1024 * 1024;

/// 单个 HTTP 请求在 server 半的最长等待时间（毫秒）。
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;

/// 协议层的头：键统一小写，值统一成数组（保住 set-cookie 这类多值头）。
///
/// 用 `IndexMap` 而不是 `HashMap`：头的**顺序**会进到帧的 JSON 里，
/// 而帧的字节要与 TS 版逐字对齐 —— `HashMap` 的随机序会让每次序列化都不同。
pub type ProtocolHeaders = IndexMap<String, Vec<String>>;

/// 帧的通用形状。具体帧再各自收窄。
///
/// 用 `serde_json::Value` 而不是逐字段结构体：协议是**零语义**的，
/// server 半原样转发、client 半原样还原 —— 任何业务语义都不进协议层。
/// 逐字段结构体会在遇到未知字段时丢数据（那是协议演进要命的）。
pub type Frame = Value;

/// 帧编码：把一个对象序列化成 WS 文本帧。
pub fn encode_frame(obj: &Frame) -> String {
    serde_json::to_string(obj).unwrap_or_else(|_| "{\"type\":\"error\"}".to_string())
}

/// 帧解码。返回 `None` 表示「这不是一帧合法的协议消息」——
/// 调用方应当忽略并计数，而不是把解析异常抛给连接层。
pub fn decode_frame(raw: &str) -> Option<Frame> {
    let obj: serde_json::Value = serde_json::from_str(raw).ok()?;
    if !obj.is_object() {
        return None;
    }
    match obj.get("type") {
        Some(serde_json::Value::String(t)) if !t.is_empty() => Some(obj),
        _ => None,
    }
}

/// 生成一个跨连接唯一的请求 id。
///
/// server 半的 pending 表是**全局**的（不按连接分表），所以 id 必须全局唯一：
/// 只带连接内计数的话，两条连接上的 "1" 会撞车，响应会被配到错误的请求上。
pub fn next_request_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = (SEQ.fetch_add(1, Ordering::Relaxed) + 1) % 0x00ff_ffff;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand: u32 = rand::random();
    format!("{prefix}-{now:x}-{seq:x}-{rand:06x}")
}

/// 头对象规范化：键统一小写，值统一成数组。
///
/// 输入是「原始头」：值可能是字符串、也可能是数组（`set-cookie` 这类多值头）。
///
/// 与 TS 版 `normalizeHeaders` 逐条对齐：
///   · `null` / 缺省的值**跳过**（不是变成字符串 "null"）
///   · 数字 / 布尔转成字符串
///   · 数组里的每个元素都转成字符串
pub fn normalize_headers(headers: &Value) -> ProtocolHeaders {
    let mut out = ProtocolHeaders::new();
    let Some(obj) = headers.as_object() else {
        return out;
    };
    for (k, v) in obj {
        let key = k.to_lowercase();
        match v {
            Value::Null => continue,
            Value::Array(a) => {
                out.insert(key, a.iter().map(|x| json_to_string(x)).collect());
            }
            other => {
                out.insert(key, vec![json_to_string(other)]);
            }
        }
    }
    out
}

/// 把一个 JSON 值转成字符串（对齐 JS 的 `String(x)`）。
///
/// 对象的 `String(x)` 在 JS 里是 `"[object Object]"` —— 这里给同样的结果，
/// 免得两端在畸形头上报出不同的字面量。
fn json_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => json_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// 取头的第一个值（大小写不敏感）。
pub fn header_value<'a>(headers: &'a ProtocolHeaders, name: &str) -> Option<&'a str> {
    let key = name.to_lowercase();
    let v = headers.get(&key)?;
    let first = v.first()?;
    if first.is_empty() {
        None
    } else {
        Some(first.as_str())
    }
}

/// 剔除不该转发的请求头。
///
/// 注意：这里比对的是**已经小写**的键（协议层规范化时统一小写）。
pub fn strip_request_headers(headers: &ProtocolHeaders) -> ProtocolHeaders {
    headers
        .iter()
        .filter(|(k, _)| !STRIP_REQUEST_HEADERS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// 剔除不该转发的响应头。
pub fn strip_response_headers(headers: &ProtocolHeaders) -> ProtocolHeaders {
    headers
        .iter()
        .filter(|(k, _)| !STRIP_RESPONSE_HEADERS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// 把协议层的头（值统一是数组）压平成能吃的形状。
///
/// 协议层把头的值统一存成数组，是为了**保住 set-cookie 这类多值头**
/// （一个响应里可以有几十条 Set-Cookie，用 string 就只剩最后一条）。
/// 但最终写进 HTTP 报文时，除 set-cookie 外只能用字符串。
///
/// `array_allowed` 是允许保留数组的键（响应侧的 `set-cookie`）。
/// 不在名单里的数组键只留**第一个**值 —— 与 TS 版 `flattenHeaders` 一致。
pub fn flatten_headers(
    headers: &ProtocolHeaders,
    array_allowed: &[&str],
) -> IndexMap<String, Vec<String>> {
    let mut out: IndexMap<String, Vec<String>> = IndexMap::new();
    for (k, v) in headers {
        if v.is_empty() {
            continue;
        }
        if array_allowed.contains(&k.as_str()) {
            out.insert(k.clone(), v.clone());
        } else {
            out.insert(k.clone(), vec![v[0].clone()]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decode_frame_rejects_non_object_and_non_string_type() {
        assert!(decode_frame("not-json").is_none());
        assert!(decode_frame("[1,2]").is_none());
        assert!(decode_frame("null").is_none());
        assert!(decode_frame("{\"id\":\"x\"}").is_none(), "缺 type 的不算协议帧");
        assert!(decode_frame("{\"type\":123}").is_none(), "type 必须是字符串");
    }

    #[test]
    fn decode_frame_keeps_unknown_fields() {
        let f = decode_frame("{\"type\":\"request\",\"id\":\"r-1\",\"foo\":\"bar\"}").unwrap();
        assert_eq!(f["type"], "request");
        assert_eq!(f["id"], "r-1");
        assert_eq!(f["foo"], "bar", "未知字段不能被丢掉（协议要演进）");
    }

    #[test]
    fn normalize_headers_lowercases_and_arrays() {
        let raw = json!({
            "Content-Type": "application/json",
            "Set-Cookie": ["a=1", "b=2"],
        });
        let n = normalize_headers(&raw);
        assert_eq!(n["content-type"], vec!["application/json"]);
        assert_eq!(n["set-cookie"].len(), 2, "多值头必须保住");
    }

    #[test]
    fn normalize_headers_skips_null_but_stringifies_scalars() {
        let raw = json!({"X-N": 42, "X-B": true, "X-Skip": null});
        let n = normalize_headers(&raw);
        assert_eq!(n["x-n"], vec!["42"]);
        assert_eq!(n["x-b"], vec!["true"]);
        assert!(!n.contains_key("x-skip"), "null 的头要跳过，不能变成字符串 \"null\"");
    }

    #[test]
    fn strip_request_headers_removes_gate_and_origin() {
        let mut h = ProtocolHeaders::new();
        h.insert("x-mn-ws-token".into(), vec!["secret".into()]);
        h.insert("origin".into(), vec!["http://evil".into()]);
        h.insert("authorization".into(), vec!["Bearer app".into()]);
        h.insert("connection".into(), vec!["keep-alive".into()]);
        let out = strip_request_headers(&h);
        assert!(!out.contains_key("x-mn-ws-token"), "门禁令牌绝不能泄给目标服务");
        assert!(!out.contains_key("origin"));
        assert!(!out.contains_key("connection"));
        assert_eq!(out["authorization"], vec!["Bearer app"], "应用自己的头要原样透传");
    }

    #[test]
    fn strip_response_headers_removes_content_length() {
        let mut h = ProtocolHeaders::new();
        h.insert("content-length".into(), vec!["123".into()]);
        h.insert("set-cookie".into(), vec!["a=1".into(), "b=2".into()]);
        let out = strip_response_headers(&h);
        assert!(!out.contains_key("content-length"), "长度要按实际 body 重算");
        assert_eq!(out["set-cookie"].len(), 2, "set-cookie 多值要保住");
    }

    #[test]
    fn flatten_headers_keeps_arrays_only_for_allowed_keys() {
        let mut h = ProtocolHeaders::new();
        h.insert("set-cookie".into(), vec!["a=1".into(), "b=2".into()]);
        h.insert("x-multi".into(), vec!["v1".into(), "v2".into()]);
        let out = flatten_headers(&h, &["set-cookie"]);
        assert_eq!(out["set-cookie"].len(), 2);
        assert_eq!(out["x-multi"], vec!["v1".to_string()]);
    }

    #[test]
    fn frame_key_order_is_stable() {
        // 键序变了，帧的字节就变了 —— 逐字节对比会误报成协议不一致。
        let f = json!({"type": "response", "id": "r1", "status": 200});
        assert_eq!(
            encode_frame(&f),
            "{\"type\":\"response\",\"id\":\"r1\",\"status\":200}"
        );
    }

    #[test]
    fn next_request_id_is_globally_unique() {
        let a = next_request_id("r");
        let b = next_request_id("r");
        assert_ne!(a, b, "id 必须全局唯一（pending 表不按连接分表）");
        assert!(a.starts_with("r-"));
    }
}
