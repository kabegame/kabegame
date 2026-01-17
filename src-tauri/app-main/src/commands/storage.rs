// 存储相关命令（包括 self-host 和 daemon IPC）

#[cfg(feature = "self-host")]
use crate::storage::{Album, ImageInfo, Storage};
#[cfg(feature = "self-host")]
use crate::storage::images::PaginatedImages;

// 这些命令已经在 daemon.rs 中定义，这里只保留 self-host 特有的

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_get_images(state: tauri::State<Storage>) -> Result<Vec<ImageInfo>, String> {
    state.get_all_images()
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_get_images_paginated(
    page: usize,
    page_size: usize,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_images_paginated(page, page_size)
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_get_albums(state: tauri::State<Storage>) -> Result<Vec<Album>, String> {
    state.get_albums()
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_add_album(
    app: tauri::AppHandle,
    name: String,
    state: tauri::State<Storage>,
    #[cfg(feature = "virtual-drive")] drive: tauri::State<crate::virtual_drive::VirtualDriveService>,
) -> Result<Album, String> {
    let album = state.add_album(&name)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "add"
        }),
    );
    #[cfg(feature = "virtual-drive")]
    {
        drive.bump_albums();
    }
    Ok(album)
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn local_delete_album(
    app: tauri::AppHandle,
    album_id: String,
    state: tauri::State<Storage>,
    #[cfg(feature = "virtual-drive")] drive: tauri::State<crate::virtual_drive::VirtualDriveService>,
) -> Result<(), String> {
    state.delete_album(&album_id)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "delete"
        }),
    );
    #[cfg(feature = "virtual-drive")]
    {
        drive.bump_albums();
    }
    Ok(())
}

// 其他存储相关的命令（通过 daemon IPC）
// 这些命令已经在 daemon.rs 中定义
