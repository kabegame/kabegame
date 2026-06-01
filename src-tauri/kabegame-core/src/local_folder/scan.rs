use crate::image_type::is_media_by_path;
use crate::local_folder::status::FolderStatus;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const STABLE_FOR_MS: u64 = 3000;

#[derive(Debug, Clone)]
pub struct LocalFile {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_unix_ms: u128,
}

pub struct ScanResult {
    pub files: Vec<LocalFile>,
    pub skipped_unstable: usize,
    pub skipped_missing: usize,
}

pub fn scan_dir(dir: &Path) -> Result<ScanResult, FolderStatus> {
    let meta = fs::metadata(dir).map_err(map_io_error)?;
    if !meta.is_dir() {
        return Err(FolderStatus::now_not_a_dir());
    }

    let read = fs::read_dir(dir).map_err(map_io_error)?;
    let mut files = Vec::new();
    let mut skipped_unstable = 0;
    let mut skipped_missing = 0;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_file() || !is_media_by_path(&path) {
            continue;
        }
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                skipped_missing += 1;
                continue;
            }
            Err(_) => continue,
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let mtime_ms = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        if now_ms.saturating_sub(mtime_ms) < STABLE_FOR_MS as u128 {
            skipped_unstable += 1;
            continue;
        }
        files.push(LocalFile {
            path,
            size: metadata.len(),
            mtime_unix_ms: mtime_ms,
        });
    }

    Ok(ScanResult {
        files,
        skipped_unstable,
        skipped_missing,
    })
}

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

fn map_io_error(err: io::Error) -> FolderStatus {
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
