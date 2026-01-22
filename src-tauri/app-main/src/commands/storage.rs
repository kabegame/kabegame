// 存储相关命令（包括 self-hosted 和 daemon IPC）

#[cfg(feature = "self-hosted")]
use crate::storage::images::PaginatedImages;
#[cfg(feature = "self-hosted")]
use crate::storage::{Album, ImageInfo, Storage};

// 这些命令已经在 daemon.rs 中定义，这里只保留 self-hosted 特有的

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub fn local_get_images() -> Result<Vec<ImageInfo>, String> {
    Storage::global().get_all_images()
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub fn local_get_images_paginated(
    page: usize,
    page_size: usize,
) -> Result<PaginatedImages, String> {
    Storage::global().get_images_paginated(page, page_size)
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub fn local_get_albums() -> Result<Vec<Album>, String> {
    Storage::global().get_albums()
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub fn local_add_album(app: tauri::AppHandle, name: String) -> Result<Album, String> {
    let album = Storage::global().add_album(&name)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "add"
        }),
    );
    #[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
    {
        crate::virtual_driver::VirtualDriveService::global().bump_albums();
    }
    Ok(album)
}

#[tauri::command]
#[cfg(feature = "self-hosted")]
pub fn local_delete_album(app: tauri::AppHandle, album_id: String) -> Result<(), String> {
    Storage::global().delete_album(&album_id)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "delete"
        }),
    );
    #[cfg(all(feature = "virtual-driver", feature = "self-hosted"))]
    {
        crate::virtual_driver::VirtualDriveService::global().bump_albums();
    }
    Ok(())
}

// 其他存储相关的命令（通过 daemon IPC）
// 这些命令已经在 daemon.rs 中定义
