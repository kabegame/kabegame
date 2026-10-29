//! `log tail`：读取并跟随运行中主程序的应用日志。
//!
//! 先经 IPC 订阅 `log` 事件，再拉环形缓冲里的历史，按 seq 去重后依次输出——先订阅
//! 是为了不漏掉拉历史期间产生的日志。见 `cocs/debug/APP_LOGGING.md`。

use crate::backend::{choose_backend, LocalNeeds, Via};
use clap::{Args, ValueEnum};
use kabegame_core::ipc::events::AppEvent;
use kabegame_core::logging::{LogRecord, RECENT_CAPACITY};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
pub enum LevelArg {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Args, Debug)]
pub struct LogTailArgs {
    /// 最低级别
    #[arg(long, value_enum, default_value_t = LevelArg::Info)]
    level: LevelArg,
    /// 只看该模块及其子模块的日志，按 `::` 分段匹配（如 `kabegame_core::crawler`、`webview`）
    #[arg(long)]
    target: Option<String>,
    /// 只看消息或字段包含该文本的日志
    #[arg(long)]
    grep: Option<String>,
    /// 先输出的历史条数（按筛选后的条数计）
    #[arg(long, default_value_t = 200)]
    history: usize,
    /// 输出历史后退出，不持续跟随
    #[arg(long)]
    no_follow: bool,
}

fn level_rank(level: &str) -> LevelArg {
    match level {
        "ERROR" => LevelArg::Error,
        "WARN" => LevelArg::Warn,
        "INFO" => LevelArg::Info,
        "DEBUG" => LevelArg::Debug,
        _ => LevelArg::Trace,
    }
}

impl LogTailArgs {
    fn matches(&self, record: &LogRecord) -> bool {
        if level_rank(&record.level) > self.level {
            return false;
        }
        if let Some(prefix) = &self.target {
            let prefix = prefix.trim_end_matches(':');
            let in_module = record.target == prefix
                || record
                    .target
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with(':'));
            if !in_module {
                return false;
            }
        }
        if let Some(text) = &self.grep {
            let in_fields = record.fields.values().any(|v| v.to_string().contains(text));
            if !record.message.contains(text.as_str()) && !in_fields {
                return false;
            }
        }
        true
    }
}

fn print_record(record: &LogRecord) {
    let time = chrono::DateTime::from_timestamp_millis(record.ts)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_default();
    let level = format!("{:>5}", record.level);
    let level = match record.level.as_str() {
        "ERROR" => console::style(level).red(),
        "WARN" => console::style(level).yellow(),
        "INFO" => console::style(level).green(),
        _ => console::style(level).dim(),
    };
    let mut line = format!(
        "{} {} {}: {}",
        console::style(time).dim(),
        level,
        console::style(&record.target).dim(),
        record.message
    );
    for (key, value) in &record.fields {
        let value = match value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        line.push_str(&format!(
            " {}",
            console::style(format!("{key}={value}")).dim()
        ));
    }
    println!("{line}");
}

pub async fn log_tail(args: LogTailArgs, via: Via) -> Result<(), String> {
    if via == Via::Local {
        return Err("日志只能从运行中的主程序读取，不支持 --via local".to_string());
    }
    crate::init_paths()?;
    let backend = choose_backend(Via::App, LocalNeeds::DATA)
        .await
        .map_err(|e| format!("日志只能从运行中的主程序读取：{e}"))?;

    let mut events = if args.no_follow {
        None
    } else {
        Some(backend.subscribe_logs().await?)
    };
    // 拉整个环形缓冲再筛选，`--history` 才是筛选后的条数。
    let history = backend.app_logs(None, RECENT_CAPACITY).await?;
    let mut last_seq = history.last().map(|r| r.seq).unwrap_or(0);
    let matched: Vec<&LogRecord> = history.iter().filter(|r| args.matches(r)).collect();
    for record in &matched[matched.len().saturating_sub(args.history)..] {
        print_record(record);
    }

    let Some(events) = events.as_mut() else {
        return Ok(());
    };
    while let Some(event) = events.recv().await {
        let AppEvent::Log { record } = &*event else {
            continue;
        };
        if record.seq <= last_seq {
            continue;
        }
        last_seq = record.seq;
        if args.matches(record) {
            print_record(record);
        }
    }
    Err("与主程序的连接已断开".to_string())
}
