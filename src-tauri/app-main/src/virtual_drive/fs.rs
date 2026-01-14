use std::sync::Arc;

use kabegame_core::{providers::provider::Provider, storage::Storage};
use tauri::AppHandle;

/// Kabegame 虚拟文件系统 Handler（Dokan 实现）
pub struct KabegameFs {
    pub storage: Storage,
    pub mount_point: Arc<str>,
    pub app: AppHandle,
    pub root: Arc<dyn Provider>,
}
