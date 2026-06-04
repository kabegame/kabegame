//! 本地文件夹同步画册（type = "local_folder"）的核心算法。

pub mod create;
pub mod import;
pub mod scan;
pub mod scan_service;
pub mod status;
pub mod sync;
pub mod watch;

#[cfg(test)]
mod tests;

pub use create::{build_entries_non_recursive, NewLocalFolderEntry};
pub use scan_service::{
    scan_and_visit, FolderScanHook, ScanOptions, ScanSummary, ScannedDir, ScannedFile,
};
pub use status::FolderStatus;
pub use sync::{
    sync_album, sync_album_recursive, sync_albums_by_ids, sync_all_local_folder_albums,
    RecursiveSyncReport, SyncReport,
};
