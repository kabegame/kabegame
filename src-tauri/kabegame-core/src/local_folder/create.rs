//! 构造本地文件夹同步画册的「根画册」条目。
//!
//! 历史上的递归建树（`build_entries_recursive`）与递归对齐（`build_reconcile_entries`）已被
//! `scan_service` + 同步钩子取代：画册创建只建根画册，子画册由同步时的 `on_enter_dir` 钩子按需创建。

use std::path::Path;

#[derive(Debug, Clone)]
pub struct NewLocalFolderEntry {
    pub id: String,
    pub name: String,
    pub sync_folder: String,
    pub parent_id: Option<String>,
}

/// 构造单个本地文件夹画册条目（根画册，或同步钩子中的一个子画册）。
pub fn build_entries_non_recursive(
    name: &str,
    sync_folder: &Path,
    parent_id: Option<&str>,
) -> NewLocalFolderEntry {
    NewLocalFolderEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        sync_folder: sync_folder.to_string_lossy().into_owned(),
        parent_id: parent_id.map(|s| s.to_string()),
    }
}
