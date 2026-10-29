//! 主程序日志装配：在 `kabegame_core::logging` 的订阅器上注入 debug ingest 层，
//! 并在 `AppPaths` 就绪后绑定按天滚动的日志目录。见 `cocs/debug/APP_LOGGING.md`。

/// 安装全局订阅器与 panic hook；幂等，`main()` 与各 `run()` 开头都会调用。
pub fn init() {
    kabegame_core::logging::init(kabegame_core::logging::LoggingOptions {
        // Android 上 stderr 不进 logcat，只留文件与查看器。
        console: !cfg!(target_os = "android"),
        extra: crate::debug_ingest::layer(),
    });
    kabegame_core::logging::install_panic_hook();
}

/// 绑定 `<data_dir>/logs`；失败只记 warn，不影响启动。
pub(crate) fn attach_log_dir() {
    let dir = kabegame_core::app_paths::AppPaths::global().logs_dir();
    if let Err(error) = kabegame_core::logging::attach_log_dir(&dir) {
        tracing::warn!("{error}");
    }
}
