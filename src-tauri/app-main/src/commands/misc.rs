// 杂项命令

use tauri::{AppHandle, Manager};
use std::fs;

#[tauri::command]
pub async fn clear_user_data(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    if !app_data_dir.exists() {
        return Ok(()); // 目录不存在，无需清理
    }

    // 方案：创建清理标记文件，在应用重启后清理
    // 这样可以避免删除正在使用的文件
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    fs::write(&cleanup_marker, "1")
        .map_err(|e| format!("Failed to create cleanup marker: {}", e))?;

    // 延迟重启，确保响应已发送
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        app.restart();
    });

    Ok(())
}

#[tauri::command]
pub async fn start_dedupe_gallery_by_hash_batched(delete_files: bool) -> Result<(), String> {
    let ctx = crate::ipc::handlers::Store::global();
    ctx.dedupe_service
        .clone()
        .start_batched(
            std::sync::Arc::new(kabegame_core::storage::Storage::global().clone()),
            ctx.broadcaster.clone(),
            delete_files,
            10_000,
        )
        .await
}

#[tauri::command]
pub async fn cancel_dedupe_gallery_by_hash_batched() -> Result<bool, String> {
    let ctx = crate::ipc::handlers::Store::global();
    ctx.dedupe_service.cancel()
}

#[tauri::command]
pub fn open_plugin_editor_window(_app: AppHandle) -> Result<(), String> {
    use kabegame_core::bin_finder::spawn_binary;

    spawn_binary("plugin-editor", Vec::new())
        .map_err(|e| format!("启动插件编辑器失败: {e}"))
}

#[tauri::command]
pub async fn get_gallery_image(image_path: String) -> Result<Vec<u8>, String> {
    use std::path::Path;

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))
}
