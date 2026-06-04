use crate::local_folder::status::FolderStatus;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 文件「稳定」最小年龄（毫秒）：mtime 距今不足此值的文件视为仍在写入，扫描时跳过。
pub const STABLE_FOR_MS: u64 = 3000;

/// 目录自身 mtime（毫秒），用于 SkipUnchangedFolder 优化判断。
pub fn dir_mtime_unix_ms(dir: &Path) -> Result<u64, FolderStatus> {
    let meta = fs::metadata(dir).map_err(map_io_error)?;
    if !meta.is_dir() {
        return Err(FolderStatus::now_not_a_dir());
    }
    Ok(system_time_unix_ms(
        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    ))
}

fn system_time_unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

/// 将 IO 错误映射为画册文件夹状态（缺失 / 拒绝 / 其它 IO）。
pub fn map_io_error(err: io::Error) -> FolderStatus {
    match err.kind() {
        io::ErrorKind::NotFound => FolderStatus::now_missing(),
        io::ErrorKind::PermissionDenied => FolderStatus::now_denied(err.to_string()),
        _ => {
            #[cfg(target_os = "macos")]
            if err.raw_os_error() == Some(1) {
                return FolderStatus::now_denied(err.to_string());
            }
            FolderStatus::now_io_error(err.to_string())
        }
    }
}
