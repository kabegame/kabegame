//! 「壁纸」收集入口的命令包装：只读扫描 / 识别，阻塞 IO 放到阻塞线程池。

use kabegame_core::settings::Settings;
use kabegame_core::wpe::discover;
use serde_json::Value;

#[tauri::command]
pub async fn wpe_scan() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(kabegame_core::commands::wpe::scan_wpe_sources)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn wpe_recognize_dir(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        kabegame_core::commands::wpe::recognize_wpe_dir(path)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 壁纸设置「Wallpaper Engine 目录」：设置为空时先自动查找，界面打开就能看到结果。
/// 返回设置原值，目录失效时用户仍能看到是哪一个。
#[tauri::command]
pub async fn get_wpe_engine_dir() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        discover::engine_dir();
        Settings::global().get_wpe_engine_dir()
    })
    .await
    .map_err(|error| error.to_string())
}

/// 写设置后立即刷新场景宿主的 `file:` 范围。传空清掉设置，这次刷新同时重新查找。
#[tauri::command]
pub async fn set_wpe_engine_dir(dir: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        discover::set_engine_dir(dir)?;
        crate::wallpaper::wpe_scene_host::refresh_scene_host();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
