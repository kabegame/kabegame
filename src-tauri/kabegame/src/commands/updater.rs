//! Tauri 命令薄包装：应用自动更新。具体逻辑在 `crate::updater`。
//!
//! 状态归后端 `UpdaterService` 权威；前端启动 `get_updater_state` hydrate，
//! 之后靠 `updater-state-change` / `update-download-progress` / `update-download-error` 事件刷新。
//! `checking` 与 `downloading` 独占、不可重入。

use crate::updater::{self, UpdaterService, UpdaterState};

/// 返回当前更新状态快照（前端启动期 hydrate）。
#[tauri::command]
pub async fn get_updater_state() -> Result<UpdaterState, String> {
    Ok(UpdaterService::global().snapshot())
}

/// 手动检查更新；`checking`/`downloading` 期间 no-op，返回当前快照（不重入、不打断）。
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdaterState, String> {
    UpdaterService::global().run_check().await;
    Ok(UpdaterService::global().snapshot())
}

/// 下载指定 release 的安装包到临时目录（仅可从 `updateAvailable` 进入）。
#[tauri::command]
pub async fn download_update(
    tag: String,
    asset_url: String,
    asset_name: String,
) -> Result<(), String> {
    updater::download_update(tag, asset_url, asset_name).await
}

/// 取消进行中的下载；仅 `downloading` 有效。返回是否真的发起取消。
#[tauri::command]
pub async fn cancel_download() -> Result<bool, String> {
    Ok(UpdaterService::global().cancel_download())
}

/// 应用已下载的更新并重启（restartable 下调用）。Linux 不支持。
#[tauri::command]
pub async fn apply_update_and_restart(app: tauri::AppHandle) -> Result<(), String> {
    let (_tag, path) = UpdaterService::global()
        .downloaded_package()
        .ok_or("没有已下载的更新包")?;
    updater::apply_update(&app, &path)
}
