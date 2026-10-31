//! 按天滚动的日志文件；订阅器先装好，目录在 `AppPaths` 就绪后再绑定。
//!
//! 直接用 `RollingFileAppender` 同步写，不用 `tracing_appender::non_blocking`：发布版是
//! `panic = "abort"`，后台写线程的 guard 放在 static 里永远不会 drop，崩溃前最后几行必丢。

use std::path::Path;
use std::sync::OnceLock;
use tracing_appender::rolling::{RollingFileAppender, RollingWriter, Rotation};
use tracing_subscriber::fmt::writer::{MakeWriter, OptionalWriter};

/// 保留的日志文件个数（按天，文件名日期为 UTC）。
pub const MAX_LOG_FILES: usize = 14;

static FILE: OnceLock<RollingFileAppender> = OnceLock::new();

pub(crate) fn attach(dir: &Path) -> Result<(), String> {
    if FILE.get().is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录失败 {}: {e}", dir.display()))?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("kabegame")
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)
        .map_err(|e| format!("打开日志文件失败 {}: {e}", dir.display()))?;
    let _ = FILE.set(appender);
    Ok(())
}

/// 未绑定目录前写入被丢弃（这段时间的日志仍在控制台与环形缓冲里）。
#[derive(Clone, Copy)]
pub(crate) struct LateFile;

impl<'a> MakeWriter<'a> for LateFile {
    type Writer = OptionalWriter<RollingWriter<'a>>;

    fn make_writer(&'a self) -> Self::Writer {
        match FILE.get() {
            Some(appender) => OptionalWriter::some(appender.make_writer()),
            None => OptionalWriter::none(),
        }
    }
}
