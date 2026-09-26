//! 本地文件夹同步画册（type = "local_folder"）的核心算法。

pub mod create;
pub mod fs_batch;
pub mod fs_listener;
pub mod import;
pub mod run_state;
pub mod scan;
pub mod scan_service;
pub mod status;
pub mod sync;
pub mod sync_mode;
pub mod synchronizer;

#[cfg(test)]
mod tests;

pub use create::{build_entries_non_recursive, NewLocalFolderEntry};
pub use run_state::{FolderSyncRunGuard, FolderSyncService, FolderSyncTaskState};
pub use scan_service::{
    list_child_dirs, scan_and_visit, FolderScanHook, ScanCtx, ScanError, ScanIssue, ScanOptions,
    ScannedDir, ScannedFile,
};
pub use status::FolderStatus;
pub use sync_mode::SyncMode;
pub use synchronizer::{Descend, FullSyncOptions, SyncOrigin};

pub const DEBOUNCE_MS: u64 = 1500;

/// 启动执行管道与文件事件管道，并投递一次启动同步。
pub async fn start() {
    synchronizer::start();
    fs_listener::set_enabled(true).await;

    let handle = tokio::runtime::Handle::current();
    let albums = match tokio::task::spawn_blocking(move || {
        handle.block_on(async { crate::storage::Storage::global().list_local_folder_albums() })
    })
    .await
    {
        Ok(Ok(albums)) => albums,
        Ok(Err(err)) => {
            eprintln!("[local_folder] startup list albums failed: {err}");
            return;
        }
        Err(err) => {
            eprintln!("[local_folder] startup list task panicked: {err}");
            return;
        }
    };
    for album in albums {
        let Some(mode) = SyncMode::from_str(&album.sync_mode) else {
            continue;
        };
        let descend = match mode {
            SyncMode::Shallow => Descend::None,
            SyncMode::Recursive => Descend::CreateMissing,
            SyncMode::Delegated | SyncMode::None => continue,
        };
        synchronizer::submit(synchronizer::SyncCmd::Full {
            album_id: album.id,
            opts: FullSyncOptions {
                descend,
                origin: SyncOrigin::Startup,
                depth: 0,
            },
        });
    }
}
