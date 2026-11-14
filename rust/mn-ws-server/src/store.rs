//! 审计落盘：每次经桥的请求记一行 JSONL。
//!
//! 为什么必须落盘：mn-ws server 是**新的公网暴露面**，它能代理到本机的
//! 十几个服务。出事时「谁在什么时候调了哪个 app 的哪个路径」必须查得到，
//! 否则就是一笔糊涂账。
//!
//! 与 mn-rt 的 client/lib/store.js 同款：JSONL 追加，尾部读。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// 审计存储。
pub struct Store {
    file: Option<PathBuf>,
    max_tail: usize,
    tail: std::sync::Mutex<Vec<Value>>,
}

impl Store {
    /// 构造。`dir` 为 `None` 时只在内存里留一份尾部（不落盘）。
    pub fn new(dir: Option<&Path>, name: &str, max_tail: usize) -> Store {
        let file = dir.map(|d| d.join(name));
        let mut tail = Vec::new();
        if let Some(f) = &file {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            tail = read_tail(f, max_tail);
        }
        Store {
            file,
            max_tail,
            tail: std::sync::Mutex::new(tail),
        }
    }

    /// 追加一条记录。
    pub fn append(&self, record: Value) -> Value {
        let record = match record.as_object() {
            Some(o) => {
                // ts 放最前（与 TS 版 `{ ts: Date.now(), ...record }` 一致：
                // record 里若已有 ts，会覆盖它 —— 这里反过来，先放 ts 再放 record 的字段）。
                let mut merged = serde_json::Map::new();
                merged.insert("ts".to_string(), Value::from(now_ms()));
                for (k, v) in o.iter() {
                    merged.insert(k.clone(), v.clone());
                }
                Value::Object(merged)
            }
            None => record,
        };
        {
            let mut tail = self.tail.lock().unwrap();
            tail.push(record.clone());
            let n = tail.len();
            if n > self.max_tail {
                tail.drain(0..n - self.max_tail);
            }
        }
        if let Some(f) = &self.file {
            // 落盘失败不阻断主流程（与 TS 版一致）。
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(f) {
                let _ = writeln!(file, "{record}");
            }
        }
        record
    }

    /// 最近若干条（内存里已有一份，进程起来就能读）。
    pub fn tail(&self, n: usize) -> Vec<Value> {
        let tail = self.tail.lock().unwrap();
        let k = tail.len().saturating_sub(n);
        tail[k..].to_vec()
    }

    /// 统计。
    pub fn stats(&self) -> (usize, Option<String>) {
        let n = self.tail.lock().unwrap().len();
        (n, self.file.as_ref().map(|f| f.to_string_lossy().to_string()))
    }
}

/// 现在的时间戳（毫秒）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 读文件尾部若干行。
fn read_tail(file: &Path, max: usize) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(max);
    lines[start..]
        .iter()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| serde_json::json!({ "raw": l })))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_keeps_tail_bounded() {
        let s = Store::new(None, "x.jsonl", 3);
        for i in 0..10 {
            s.append(serde_json::json!({ "app": format!("a{i}") }));
        }
        let tail = s.tail(50);
        assert_eq!(tail.len(), 3, "尾部只留最近 3 条");
        assert_eq!(tail[2]["app"], "a9");
    }

    #[test]
    fn append_stamps_ts() {
        let s = Store::new(None, "x.jsonl", 10);
        let rec = s.append(serde_json::json!({ "app": "nx" }));
        assert!(rec["ts"].as_i64().unwrap() > 0, "每条记录都要带时间戳");
        assert_eq!(rec["app"], "nx");
    }

    #[test]
    fn tail_reads_existing_file_on_start() {
        let dir = std::env::temp_dir().join(format!("mn-ws-store-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("requests.jsonl");
        std::fs::write(&file, "{\"app\":\"a\"}\n{\"app\":\"b\"}\n").unwrap();
        let s = Store::new(Some(&dir), "requests.jsonl", 200);
        assert_eq!(s.tail(50).len(), 2, "进程起来就能读到历史尾部");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
