//! 结构化日志记录与进程内环形缓冲。

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;

/// 环形缓冲容量：查看器 / CLI 打开时能拿到的历史条数。
pub const RECENT_CAPACITY: usize = 2000;

/// 一条应用日志；经 `AppEvent::Log` 广播，也是 `recent_logs` 的返回单位。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    /// 进程内单调递增（入缓冲时分配），前端与 CLI 按它去重、排序。
    pub seq: u64,
    /// 毫秒时间戳。
    pub ts: i64,
    /// `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE`。
    pub level: String,
    /// 模块路径；前端日志为 `webview:<窗口 label>`。
    pub target: String,
    pub message: String,
    /// 事件上除 message 外的结构化字段。
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// 缓冲与序号放在同一把锁里，保证缓冲内按 seq 有序。
struct Recent {
    next_seq: u64,
    buf: VecDeque<LogRecord>,
}

impl Recent {
    const fn new() -> Self {
        Self {
            next_seq: 1,
            buf: VecDeque::new(),
        }
    }

    fn push(&mut self, mut record: LogRecord, capacity: usize) -> LogRecord {
        record.seq = self.next_seq;
        self.next_seq += 1;
        if self.buf.len() >= capacity {
            self.buf.pop_front();
        }
        self.buf.push_back(record.clone());
        record
    }

    /// `since_seq` 之后（不含）的记录中最新的至多 `limit` 条，按 seq 升序。
    fn read(&self, since_seq: Option<u64>, limit: usize) -> Vec<LogRecord> {
        let start = since_seq
            .map(|seq| self.buf.partition_point(|r| r.seq <= seq))
            .unwrap_or(0);
        let skip = (self.buf.len() - start).saturating_sub(limit);
        self.buf.iter().skip(start + skip).cloned().collect()
    }
}

static RECENT: Mutex<Recent> = Mutex::new(Recent::new());

/// 分配 seq 并写入缓冲，返回带 seq 的记录。
pub(crate) fn push_recent(record: LogRecord) -> LogRecord {
    RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(record, RECENT_CAPACITY)
}

/// 读取 `since_seq` 之后（不含）最新的至多 `limit` 条日志，按 seq 升序。
pub fn recent_logs(since_seq: Option<u64>, limit: usize) -> Vec<LogRecord> {
    RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .read(since_seq, limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(message: &str) -> LogRecord {
        LogRecord {
            seq: 0,
            ts: 0,
            level: "INFO".into(),
            target: "test".into(),
            message: message.into(),
            fields: Default::default(),
        }
    }

    #[test]
    fn push_assigns_increasing_seq_and_evicts_oldest() {
        let mut recent = Recent::new();
        for i in 0..5 {
            recent.push(record(&i.to_string()), 3);
        }
        let all = recent.read(None, usize::MAX);
        assert_eq!(all.iter().map(|r| r.seq).collect::<Vec<_>>(), [3, 4, 5]);
        assert_eq!(all[0].message, "2");
    }

    #[test]
    fn read_since_and_limit_return_newest_tail() {
        let mut recent = Recent::new();
        for i in 0..10 {
            recent.push(record(&i.to_string()), 100);
        }
        let seqs = |v: Vec<LogRecord>| v.into_iter().map(|r| r.seq).collect::<Vec<_>>();
        assert_eq!(seqs(recent.read(Some(7), 100)), [8, 9, 10]);
        assert_eq!(seqs(recent.read(None, 2)), [9, 10]);
        assert_eq!(seqs(recent.read(Some(3), 2)), [9, 10]);
        assert!(recent.read(Some(10), 100).is_empty());
        // 早于缓冲起点的 since 等同于全部
        assert_eq!(recent.read(Some(0), 100).len(), 10);
    }

    #[test]
    fn serializes_camel_case_without_empty_fields() {
        let mut r = record("hello");
        r.seq = 7;
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"seq":7,"ts":0,"level":"INFO","target":"test","message":"hello"})
        );
    }
}
