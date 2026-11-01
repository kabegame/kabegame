//! 场景宿主（P3-0）的命令。

/// 场景宿主 `index.html` 的 `file:///` 地址（见 `wallpaper::wpe_scene_host`）：主窗口 / 壁纸窗口的应用页把它赋给
/// iframe，sandbox 同网页壁纸。只给这两个窗口的应用页用（它们免 ACL），宿主自己的 capability 不含这条。
/// 宿主还没构建时报错；场景壁纸只在 Windows 提供，其它平台返回错误。
#[tauri::command]
pub async fn get_wpe_scene_host_url() -> Result<String, String> {
    if !cfg!(target_os = "windows") {
        return Err("the scene host is only available on Windows".to_string());
    }
    tauri::async_runtime::spawn_blocking(crate::wallpaper::wpe_scene_host::prepare_host_entry_url)
        .await
        .map_err(|error| error.to_string())?
}
