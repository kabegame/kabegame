// Wallpaper Engine 导出相关命令

use crate::wallpaper::engine_export::WeExportOptions;
use serde_json;

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let opt: Option<WeExportOptions> = match options {
        None => None,
        Some(v) => serde_json::from_value(v).map_err(|e| format!("Invalid options: {}", e))?,
    };
    let result = crate::wallpaper::engine_export::export_album_to_we_project(
        album_id,
        album_name,
        output_parent_dir,
        opt,
    )
    .await?;
    serde_json::to_value(result).map_err(|e| format!("序列化结果失败: {}", e))
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let opt: Option<WeExportOptions> = match options {
        None => None,
        Some(v) => serde_json::from_value(v).map_err(|e| format!("Invalid options: {}", e))?,
    };
    let result = crate::wallpaper::engine_export::export_images_to_we_project(
        image_paths,
        title,
        output_parent_dir,
        opt,
    )
    .await?;
    serde_json::to_value(result).map_err(|e| format!("序列化结果失败: {}", e))
}
