//! 端口探测。
//!
//! 探测用 **TCP connect** 而不是 HTTP 请求：桥接关心的是「这个服务在不在」，
//! 不是「它返回什么」。连不上就是不在，多问一句没有意义。

use std::time::Duration;

use tokio::net::TcpStream;

/// 探测本机某个端口是否在监听。
pub async fn probe_port(host: &str, port: u16) -> bool {
    let Ok(connect) = TcpStream::connect((host, port)).await else {
        return false;
    };
    drop(connect);
    true
}

/// 探测（带超时）。
pub async fn probe_port_with_timeout(host: &str, port: u16, timeout_ms: u64) -> bool {
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        TcpStream::connect((host, port)),
    )
    .await
    {
        Ok(Ok(s)) => {
            drop(s);
            true
        }
        _ => false,
    }
}

/// 检查某个端口能不能绑（= 现在没人占）。
///
/// 为什么要有：**静默顺延端口是这里最坏的处理**。server 顺延到 7778，
/// 客户端还按 7777 去连 —— 连不上还是连不上，而用户看到的现象是
/// 「服务端说起来了、客户端说连不上」，两边对不上账。宁可**明确报错退出**。
pub async fn is_port_free(port: u16, host: &str) -> Result<bool, String> {
    // 绑 0.0.0.0 与绑具体地址的语义不同：server 半默认绑 0.0.0.0，
    // 那就按 0.0.0.0 试（否则「绑 127.0.0.1 成功」会掩盖「0.0.0.0 被占」）。
    let bind_host = if host == "0.0.0.0" { "0.0.0.0" } else { host };
    let listener = tokio::net::TcpListener::bind((bind_host, port)).await;
    match listener {
        Ok(l) => {
            drop(l);
            Ok(true)
        }
        Err(e) => {
            // 端口被占 → 不算错误，是「不空闲」。
            if e.kind() == std::io::ErrorKind::AddrInUse {
                Ok(false)
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn free_port_is_free_and_used_port_is_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_free(port, "127.0.0.1").await.unwrap());
        drop(listener);
        assert!(is_port_free(port, "127.0.0.1").await.unwrap());
    }

    #[tokio::test]
    async fn probe_detects_a_listening_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_port("127.0.0.1", port).await);
        drop(listener);
    }
}
