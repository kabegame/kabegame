//! 本地文件夹同步画册（type = "local_folder"）的核心算法。

pub mod create;
pub mod import;
pub mod run_state;
pub mod scan;
pub mod scan_service;
pub mod status;
pub mod sync;
pub mod sync_mode;
pub mod watch;

#[cfg(test)]
mod tests;

pub use create::{build_entries_non_recursive, NewLocalFolderEntry};
pub use run_state::{FolderSyncRunGuard, FolderSyncService, FolderSyncTaskState};
pub use scan_service::{
    scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanIssue, ScanOptions, ScannedDir,
    ScannedFile,
};
pub use status::FolderStatus;
pub use sync::{
    sync_album, sync_albums_by_ids, sync_all_local_folder_albums, SyncAlbumOptions, SyncReport,
};
pub use sync_mode::SyncMode;
