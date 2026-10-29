//! 应用日志：全进程一个 tracing 订阅器，主程序、Web 版与 CLI 共用。
//!
//! 由若干各带过滤器的层组成：控制台（stderr）、按天滚动文件、[`AppLogLayer`]（环形缓冲 +
//! 经事件循环广播 `AppEvent::Log`），以及调用方注入的额外层（主程序 debug 构建的
//! debug ingest 转发层）。约定与出口见 `cocs/debug/APP_LOGGING.md`。

mod file;
mod filter;
mod format;
mod layer;
mod record;

use std::io::IsTerminal;
use std::path::Path;
use std::sync::Once;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{Layer, Registry};

pub use file::MAX_LOG_FILES;
pub use filter::{AppFilter, WEBVIEW_TARGET};
pub use layer::AppLogLayer;
pub use record::{recent_logs, LogRecord, RECENT_CAPACITY};

#[doc(hidden)]
pub use tracing as __tracing;

/// 调用方注入的额外层（直接挂在 `Registry` 上，自带过滤器）。
pub type BoxedLayer = Box<dyn Layer<Registry> + Send + Sync + 'static>;

pub struct LoggingOptions {
    /// 是否输出到 stderr（Android 上看不到 stderr，传 false）。
    pub console: bool,
    pub extra: Option<BoxedLayer>,
}

/// 安装全局订阅器；幂等，只有第一次调用生效。
pub fn init(options: LoggingOptions) {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let (filter, filter_error) = AppFilter::from_env();
        let console = options.console.then(|| {
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(cfg!(debug_assertions) && std::io::stderr().is_terminal())
                .event_format(format::AppFormat)
                .with_filter(filter.clone())
        });
        let file = tracing_subscriber::fmt::layer()
            .with_writer(file::LateFile)
            .with_ansi(false)
            .event_format(format::AppFormat)
            .with_filter(filter.clone());
        let app = AppLogLayer.with_filter(filter);
        // try_init 同时安装 LogTracer，把 `log` crate 的记录接进来。
        let installed = tracing_subscriber::registry()
            .with(options.extra)
            .with(console)
            .with(file)
            .with(app)
            .try_init();
        if let Err(error) = installed {
            eprintln!("[logging] 安装日志订阅器失败: {error}");
        }
        if let Some(error) = filter_error {
            tracing::warn!("{error}");
        }
    });
}

/// 绑定日志目录（`<dir>/kabegame.<UTC 日期>.log`，保留 [`MAX_LOG_FILES`] 个）；重复调用无效果。
pub fn attach_log_dir(dir: &Path) -> Result<(), String> {
    file::attach(dir)?;
    tracing::info!("日志目录: {}", dir.display());
    Ok(())
}

/// panic 时先记一条 error 日志（发布版 `panic = "abort"`，这是落盘的最后机会），再交给原 hook。
pub fn install_panic_hook() {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "<non-string panic payload>".to_string());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_default();
            let thread = std::thread::current();
            tracing::error!(
                target: "kabegame::panic",
                thread = thread.name().unwrap_or("<unnamed>"),
                location = %location,
                "{message}"
            );
            previous(info);
        }));
    });
}

/// 开发期插桩：一条 `kabegame::debug` 的 TRACE 事件，由主程序 debug 构建的 debug ingest
/// 层转发到 dev server（见 `cocs/debug/DEBUG_INGEST.md`）。发布版不发出。
///
/// ```ignore
/// kabegame_core::kb_debug!("preview-debug-001", "backend_query_image", serde_json::json!({ "id": id }));
/// ```
#[macro_export]
macro_rules! kb_debug {
    ($session:expr, $name:expr, $payload:expr $(,)?) => {
        if cfg!(debug_assertions) {
            $crate::logging::__tracing::trace!(
                target: "kabegame::debug",
                session_id = %$session,
                name = %$name,
                payload = %$payload
            );
        }
    };
}
