//! 「壁纸」收集入口的命令包装：只读扫描 / 识别，阻塞 IO 放到阻塞线程池。

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
