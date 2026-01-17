// Wallpaper Engine 导出相关命令

use crate::daemon_client;

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .we_export_album_to_project(album_id, album_name, output_parent_dir, options)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .we_export_images_to_project(image_paths, title, output_parent_dir, options)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}
