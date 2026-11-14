//! 极简分级日志器。
//!
//! 与 mn-rt 的 client/lib/logger.js 同款：写文件 + 控制台，
//! 不引第三方依赖（这个包要能被 npx 一把跑起来，依赖越少越好）。

use std::io::Write;
use std::path::Path;

/// 日志级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
}

impl Level {
    /// 按名字取级别；认不出来的按 info（与 TS 版 `LEVELS[level] ?? LEVELS.info` 一致）。
    pub fn parse(name: &str) -> Level {
        match name {
            "debug" => Level::Debug,
            "warn" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// 分级日志器。
pub struct Logger {
    level: Level,
    dir: Option<std::path::PathBuf>,
    name: String,
}

impl Logger {
    /// 构造。`dir` 为 `None` 时只打控制台。
    pub fn new(level: &str, dir: Option<&Path>, name: &str) -> Logger {
        Logger {
            level: Level::parse(level),
            dir: dir.map(|d| d.to_path_buf()),
            name: name.to_string(),
        }
    }

    fn log(&self, level: Level, msg: &str, extra: Option<&serde_json::Value>) {
        if level < self.level {
            return;
        }
        let ts = iso_now();
        let line = match extra {
            Some(v) => format!("{ts} [{}] {msg} {}", level.label(), safe_json(v)),
            None => format!("{ts} [{}] {msg}", level.label()),
        };
        let stdout = std::io::stdout();
        let mut h = stdout.lock();
        let _ = writeln!(h, "{line}");
        let _ = h.flush();

        if let Some(dir) = &self.dir {
            // 写不了日志不是致命错误，降级成只打控制台（与 TS 版一致）。
            if std::fs::create_dir_all(dir).is_ok() {
                let file = dir.join(format!("{}.log", self.name));
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file)
                {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
    }

    pub fn debug(&self, msg: &str, extra: Option<&serde_json::Value>) {
        self.log(Level::Debug, msg, extra);
    }
    pub fn info(&self, msg: &str, extra: Option<&serde_json::Value>) {
        self.log(Level::Info, msg, extra);
    }
    pub fn warn(&self, msg: &str, extra: Option<&serde_json::Value>) {
        self.log(Level::Warn, msg, extra);
    }
    pub fn error(&self, msg: &str, extra: Option<&serde_json::Value>) {
        self.log(Level::Error, msg, extra);
    }
}

/// JSON 序列化失败时不炸（TS 版同款：'[unserializable]'）。
fn safe_json(v: &serde_json::Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[unserializable]".to_string())
}

/// 当前时间的 ISO-8601 字符串（UTC，毫秒精度）。
pub fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (y, mo, d, h, mi, s) = civil_from_unix(secs as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Unix 时间戳 → (年, 月, 日, 时, 分, 秒)，UTC。
///
/// 手写而不是引 chrono：只需要这一个转换，引库会带来一整条供应链。
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    );
    // Howard Hinnant 的 civil_from_days 算法（days since 1970-01-01）。
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_parsing_falls_back_to_info() {
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("error"), Level::Error);
        assert_eq!(Level::parse("nonsense"), Level::Info);
        assert_eq!(Level::parse(""), Level::Info);
    }

    #[test]
    fn civil_conversion_matches_known_dates() {
        // 1970-01-01T00:00:00Z
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        // 2026-12-04T03:50:00Z（用 Node 的 Date.toISOString 校准过）
        assert_eq!(civil_from_unix(1_796_356_200), (2026, 12, 4, 3, 50, 0));
        // 闰日
        assert_eq!(civil_from_unix(1_709_164_800), (2024, 2, 29, 0, 0, 0));
    }

    #[test]
    fn iso_now_has_the_right_shape() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "形如 2026-11-12T08:30:00.123Z");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
