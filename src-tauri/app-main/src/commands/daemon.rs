// Local Storage Commands (replacing Daemon IPC)
// Refactored to use embedded Storage directly

use kabegame_core::storage::Storage;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn check_daemon_status() -> Result<serde_json::Value, String> {
    // Since we are embedded, we are always connected
    Ok(serde_json::json!({
        "status": "connected",
        "info": {
            "version": env!("CARGO_PKG_VERSION"),
            "mode": "embedded"
        }
    }))
}

#[tauri::command]
pub async fn reconnect_daemon() -> Result<(), String> {
    // No-op for embedded mode
    Ok(())
}

#[tauri::command]
pub async fn get_images() -> Result<serde_json::Value, String> {
    let images = Storage::global()
        .get_all_images()
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(images).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_images_paginated(
    page: usize,
    page_size: usize,
) -> Result<serde_json::Value, String> {
    let result = Storage::global()
        .get_images_paginated(page, page_size)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_albums() -> Result<serde_json::Value, String> {
    let albums = Storage::global().get_albums().map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(albums).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn add_album(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let album = Storage::global().add_album(&name).map_err(|e| e.to_string())?;
    
    // Emit event
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({ "reason": "add" }),
    );

    #[cfg(feature = "virtual-driver")]
    {
        use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
        use kabegame_core::virtual_driver::VirtualDriveService;
        VirtualDriveService::global().bump_albums();
    }

    Ok(serde_json::to_value(album).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn delete_album(app: AppHandle, album_id: String) -> Result<(), String> {
    Storage::global().delete_album(&album_id).map_err(|e| e.to_string())?;
    
    // Emit event
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({ "reason": "delete" }),
    );

    #[cfg(feature = "virtual-driver")]
    {
        use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
        use kabegame_core::virtual_driver::VirtualDriveService;
        VirtualDriveService::global().bump_albums();
    }

    Ok(())
}

#[tauri::command]
pub async fn get_images_range(offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    // Compat: calculate page/size
    let page = if limit == 0 { 0 } else { offset / limit };
    let result = Storage::global()
        .get_images_paginated(page, limit)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn browse_gallery_provider(path: String) -> Result<serde_json::Value, String> {
    let result = kabegame_core::gallery::browse::browse_gallery_provider(
        Storage::global(),
        kabegame_core::providers::ProviderRuntime::global(),
        &path,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn get_image_by_id(image_id: String) -> Result<serde_json::Value, String> {
    let image = Storage::global()
        .find_image_by_id(&image_id)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(image).map_err(|e| e.to_string())?)
}
