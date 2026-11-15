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

// ---------- 从 Steam 拉取：登录与会话（只给主窗口用，免 ACL，注册进 generate_handler 即可） ----------

/// 「从 Steam 拉取」卡片的状态（当前 WPE 目录、是否 Kabegame 管理、已装信息、可复用的登录）。
#[tauri::command]
pub async fn wpe_steam_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(kabegame_core::commands::wpe::wpe_steam_status)
        .await
        .map_err(|error| error.to_string())?
}

/// 复用前验证已存的登录（连一次 CM），失效时删掉并报错。
#[tauri::command]
pub async fn wpe_steam_verify_session(account: String) -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_verify_session(account).await
}

#[tauri::command]
pub async fn wpe_steam_forget_session(account: String) -> Result<(), String> {
    kabegame_core::commands::wpe::wpe_steam_forget_session(account).await
}

/// 「从 Steam 导入」的订阅列表：一页订阅与每条的本地状态。
#[tauri::command]
pub async fn wpe_steam_subscriptions(
    account: String,
    page: u32,
    per_page: u32,
    sort: Option<String>,
    ratings: Option<Vec<String>>,
) -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_subscriptions(account, page, per_page, sort, ratings).await
}

/// 「从 Steam 导入」的工坊发现：一页创意工坊条目与每条的本地状态。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn wpe_steam_workshop_query(
    account: String,
    page: u32,
    per_page: u32,
    sort: Option<String>,
    days: Option<u32>,
    text: Option<String>,
    ratings: Option<Vec<String>>,
    kinds: Option<Vec<String>>,
) -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_workshop_query(account, page, per_page, sort, days, text, ratings, kinds)
        .await
}

#[tauri::command]
pub async fn wpe_steam_login_qr() -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_login_qr().await
}

/// 账号密码登录第一步。密码只在这一次调用里经过内存，不落库、不进日志。
#[tauri::command]
pub async fn wpe_steam_login_credentials(account: String, password: String) -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_login_credentials(account, password).await
}

#[tauri::command]
pub async fn wpe_steam_login_submit_code(login_id: String, code: String, kind: String) -> Result<(), String> {
    kabegame_core::commands::wpe::wpe_steam_login_submit_code(login_id, code, kind).await
}

#[tauri::command]
pub async fn wpe_steam_login_poll(login_id: String) -> Result<Value, String> {
    kabegame_core::commands::wpe::wpe_steam_login_poll(login_id).await
}

#[tauri::command]
pub async fn wpe_steam_login_cancel(login_id: String) -> Result<(), String> {
    kabegame_core::commands::wpe::wpe_steam_login_cancel(login_id);
    Ok(())
}
