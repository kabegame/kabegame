//! 本地文件夹同步画册（type = "local_folder"）的核心算法。

pub mod create;
pub mod diff;
pub mod import;
pub mod scan;
pub mod status;
pub mod sync;
pub mod watch;

#[cfg(test)]
mod tests;

pub use create::{build_entries_non_recursive, build_entries_recursive, NewLocalFolderEntry};
pub use status::FolderStatus;
pub use sync::{sync_album, sync_albums_by_ids, sync_all_local_folder_albums, SyncReport};
