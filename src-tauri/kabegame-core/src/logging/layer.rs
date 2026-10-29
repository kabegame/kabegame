//! 应用日志层：把事件记成 [`LogRecord`]，写入环形缓冲，有人订阅时经事件循环广播。

use super::filter::WEBVIEW_TARGET;
use super::record::{push_recent, LogRecord};
use serde_json::Value;
use std::cell::Cell;
use std::fmt;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Subscriber};
use tracing_log::NormalizeEvent;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::{LookupSpan, Scope};

thread_local! {
    /// 本层处理事件期间又产生日志（例如广播路径里的代码打日志）时直接丢弃，避免递归。
    static IN_LAYER: Cell<bool> = const { Cell::new(false) };
}

/// tauri-plugin-tracing 的 `log` 命令 span 上记录的窗口 label。
struct WebviewLabel(String);

pub struct AppLogLayer;

impl<S> Layer<S> for AppLogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let meta = attrs.metadata();
        if meta.name() != "log" || !meta.target().starts_with("tauri_plugin_tracing") {
            return;
        }
        let mut visitor = LabelVisitor(None);
        attrs.record(&mut visitor);
        if let (Some(label), Some(span)) = (visitor.0, ctx.span(id)) {
            span.extensions_mut().insert(WebviewLabel(label));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if IN_LAYER.with(|flag| flag.replace(true)) {
            return;
        }
        let _reset = ResetOnDrop;

        let normalized = event.normalized_metadata();
        let meta = normalized.as_ref().unwrap_or_else(|| event.metadata());
        let mut visitor = RecordVisitor::default();
        event.record(&mut visitor);
        let target = record_target(meta.target(), ctx.event_scope(event));

        let record = push_recent(LogRecord {
            seq: 0,
            ts: chrono::Utc::now().timestamp_millis(),
            level: meta.level().as_str().to_string(),
            target,
            message: visitor.message,
            fields: visitor.fields,
        });
        broadcast(record);
    }
}

/// 记录用的 target：前端日志（tauri-plugin-tracing 发出的空 target）取所在 `log{w=..}` span
/// 的窗口 label，记成 `webview:<label>`。控制台 / 文件格式（`format.rs`）共用这条规则。
pub(crate) fn record_target<'a, R: LookupSpan<'a>>(
    target: &str,
    scope: Option<Scope<'a, R>>,
) -> String {
    if !target.is_empty() {
        return target.to_string();
    }
    let label = scope.and_then(|scope| {
        scope.from_root().find_map(|span| {
            span.extensions()
                .get::<WebviewLabel>()
                .map(|label| label.0.clone())
        })
    });
    match label {
        Some(label) => format!("{WEBVIEW_TARGET}:{label}"),
        None => WEBVIEW_TARGET.to_string(),
    }
}

struct ResetOnDrop;

impl Drop for ResetOnDrop {
    fn drop(&mut self) {
        IN_LAYER.with(|flag| flag.set(false));
    }
}

#[cfg(feature = "ipc-server")]
fn broadcast(record: LogRecord) {
    use crate::ipc::events::{AppEvent, AppEventKind};
    use crate::ipc::server::EventBroadcaster;

    let Some(broadcaster) = EventBroadcaster::try_global() else {
        return;
    };
    // 没有订阅方时不序列化、不入队。
    if broadcaster.receiver_count(AppEventKind::Log) == 0 {
        return;
    }
    broadcaster.broadcast(std::sync::Arc::new(AppEvent::Log { record }));
}

#[cfg(not(feature = "ipc-server"))]
fn broadcast(_record: LogRecord) {}

struct LabelVisitor(Option<String>);

impl Visit for LabelVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "w" {
            self.0 = Some(value.to_string());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "w" {
            self.0 = Some(format!("{value:?}"));
        }
    }
}

/// 收集 message 与其余字段；`format.rs` 共用。
#[derive(Default)]
pub(crate) struct RecordVisitor {
    pub(crate) message: String,
    pub(crate) fields: serde_json::Map<String, Value>,
}

impl RecordVisitor {
    fn put(&mut self, field: &Field, value: Value) {
        match field.name() {
            "message" => {
                self.message = match value {
                    Value::String(s) => s,
                    other => other.to_string(),
                }
            }
            // tracing-log 的元字段，已由 normalized_metadata 还原到 target 上
            name if name.starts_with("log.") => {}
            // tauri-plugin-tracing 用空名字段记录前端调用位置；前端统一经 `utils/logger.ts`
            // 包装调用，取到的总是包装函数自己，没有信息量，丢弃。
            "" => {}
            name => {
                self.fields.insert(name.to_string(), value);
            }
        }
    }
}

impl Visit for RecordVisitor {
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, Value::from(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::from(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::from(value));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::recent_logs;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn records_message_fields_and_skips_reentrant_events() {
        let subscriber = tracing_subscriber::registry().with(AppLogLayer);
        tracing::subscriber::with_default(subscriber, || {
            let before = recent_logs(None, 1).first().map(|r| r.seq);
            tracing::warn!(target: "kabegame_core::test_layer", task_id = "t1", count = 3, "下载失败 {}", 42);
            // 模拟在本层处理中再次打日志：应被丢弃
            IN_LAYER.with(|flag| flag.set(true));
            tracing::warn!(target: "kabegame_core::test_layer", "reentrant");
            IN_LAYER.with(|flag| flag.set(false));

            let mine: Vec<_> = recent_logs(before, usize::MAX)
                .into_iter()
                .filter(|r| r.target == "kabegame_core::test_layer")
                .collect();
            assert_eq!(mine.len(), 1);
            assert_eq!(mine[0].level, "WARN");
            assert_eq!(mine[0].message, "下载失败 42");
            assert_eq!(mine[0].fields["task_id"], "t1");
            assert_eq!(mine[0].fields["count"], 3);
        });
    }

    #[test]
    fn empty_target_uses_webview_label_from_plugin_span() {
        let subscriber = tracing_subscriber::registry().with(AppLogLayer);
        tracing::subscriber::with_default(subscriber, || {
            let before = recent_logs(None, 1).first().map(|r| r.seq);
            // 与 tauri-plugin-tracing 的 `log` 命令相同的形状：target 为空、外层 span 带 w
            let span =
                tracing::info_span!(target: "tauri_plugin_tracing::commands", "log", w = "main");
            let _entered = span.enter();
            tracing::info!(target: "", message = "from js", "" = "App.vue:12");

            let mine: Vec<_> = recent_logs(before, usize::MAX)
                .into_iter()
                .filter(|r| r.message == "from js")
                .collect();
            assert_eq!(mine.len(), 1);
            assert_eq!(mine[0].target, "webview:main");
            assert!(mine[0].fields.is_empty());
        });
    }
}
