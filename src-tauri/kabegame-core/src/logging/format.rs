//! 控制台与日志文件共用的单行格式，与查看器「复制」、CLI `log tail` 一致：
//! `2026-10-29 18:37:04.877  INFO kabegame::core_init: 消息 k=v`。
//!
//! 不用 tracing-subscriber 的默认格式：它会把前端日志打成 `log{w=main}: : 消息 =<调用位置>`
//! （tauri-plugin-tracing 的空 target、外层 span 与空名字段），这里按 [`super::AppLogLayer`]
//! 的规则改写成 `webview:<窗口>`，也不打印 span。

use super::layer::{record_target, RecordVisitor};
use serde_json::Value;
use std::fmt;
use tracing::{Event, Level, Subscriber};
use tracing_log::NormalizeEvent;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::registry::LookupSpan;

pub(crate) struct AppFormat;

fn level_color(level: &Level) -> &'static str {
    match *level {
        Level::ERROR => "\x1b[31m",
        Level::WARN => "\x1b[33m",
        Level::INFO => "\x1b[32m",
        Level::DEBUG => "\x1b[34m",
        Level::TRACE => "\x1b[35m",
    }
}

impl<S, N> FormatEvent<S, N> for AppFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let normalized = event.normalized_metadata();
        let meta = normalized.as_ref().unwrap_or_else(|| event.metadata());
        let mut visitor = RecordVisitor::default();
        event.record(&mut visitor);
        let target = record_target(meta.target(), ctx.event_scope());
        let time = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let level = meta.level();

        if writer.has_ansi_escapes() {
            write!(
                writer,
                "\x1b[2m{time}\x1b[0m {}{:>5}\x1b[0m \x1b[2m{target}:\x1b[0m {}",
                level_color(level),
                level.as_str(),
                visitor.message
            )?;
        } else {
            write!(
                writer,
                "{time} {:>5} {target}: {}",
                level.as_str(),
                visitor.message
            )?;
        }
        for (key, value) in &visitor.fields {
            match value {
                Value::String(text) => write!(writer, " {key}={text}")?,
                other => write!(writer, " {key}={other}")?,
            }
        }
        writeln!(writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::AppLogLayer;
    use std::io;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::layer::SubscriberExt;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Buffer {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn capture(emit: impl FnOnce()) -> String {
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::registry().with(AppLogLayer).with(
            tracing_subscriber::fmt::layer()
                .with_writer(move || writer.clone())
                .with_ansi(false)
                .event_format(AppFormat),
        );
        tracing::subscriber::with_default(subscriber, emit);
        let bytes = buffer.0.lock().unwrap().clone();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn formats_backend_event_on_one_line() {
        let line = capture(
            || tracing::warn!(target: "kabegame_core::test_fmt", task_id = "t1", count = 3, "下载失败 {}", 42),
        );
        assert!(
            line.ends_with('\n') && line.lines().count() == 1,
            "{line:?}"
        );
        assert!(
            line.contains("  WARN kabegame_core::test_fmt: 下载失败 42"),
            "{line:?}"
        );
        assert!(
            line.contains(" task_id=t1") && line.contains(" count=3"),
            "{line:?}"
        );
    }

    #[test]
    fn formats_frontend_event_with_webview_target_and_no_span() {
        let line = capture(|| {
            let span =
                tracing::info_span!(target: "tauri_plugin_tracing::commands", "log", w = "main");
            let _entered = span.enter();
            tracing::info!(target: "", message = "from js", "" = "logger.ts:30:22");
        });
        assert!(line.contains("  INFO webview:main: from js\n"), "{line:?}");
        assert!(
            !line.contains("log{") && !line.contains("logger.ts"),
            "{line:?}"
        );
    }
}
