//! 「壁纸」收集入口的只读命令：扫描自动来源 / 识别用户选中的目录。

use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

use crate::storage::Storage;
use crate::wpe::scan::{path_key, scan_extra_dir, scan_sources};

fn imported_paths() -> HashSet<String> {
    Storage::global()
        .list_wpe_local_paths()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path_key(&path))
        .collect()
}

/// 扫描自动发现的 Steam 库来源（创意工坊 / 官方默认 / 我的项目）。
pub fn scan_wpe_sources() -> Result<Value, String> {
    let result = scan_sources(&imported_paths());
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// 「从 Steam 拉取」卡片的状态：当前 WPE 目录、它是否是 Kabegame 管理的那份、已装信息、可复用的登录。
/// 先跑一次自动查找（会把 Steam 库里的 WPE 写进设置）。阻塞调用。
pub fn wpe_steam_status() -> Result<Value, String> {
    use crate::wpe::steam::{install, managed_engine_dir, sessions};
    let engine_dir = crate::wpe::discover::engine_dir();
    let setting = crate::settings::Settings::global().get_wpe_engine_dir();
    let engine_is_managed = setting
        .as_deref()
        .is_some_and(|dir| install::is_managed_engine_dir(Path::new(dir)));
    Ok(serde_json::json!({
        // 设置里的目录（可能已失效）与它是否可用
        "engineDir": setting,
        "engineValid": engine_dir.is_some(),
        "engineIsManaged": engine_is_managed,
        "managedEngineDir": managed_engine_dir().map(|dir| dir.to_string_lossy().into_owned()),
        "managedInstall": install::managed_install_info(),
        "sessions": sessions::list(),
    }))
}

/// 复用前验证一个已存的登录：连一次 CM。失效时会话被删掉、返回错误。
pub async fn wpe_steam_verify_session(account: String) -> Result<Value, String> {
    let info = crate::wpe::steam::cm::verify_session(&account).await?;
    serde_json::to_value(info).map_err(|error| error.to_string())
}

/// 删掉一个已存的登录（「换个账号」「退出」）。
pub fn wpe_steam_forget_session(account: String) -> Result<(), String> {
    crate::wpe::steam::sessions::remove(&account)
}

pub async fn wpe_steam_login_qr() -> Result<Value, String> {
    let start = crate::wpe::steam::auth::begin_qr().await?;
    serde_json::to_value(start).map_err(|error| error.to_string())
}

pub async fn wpe_steam_login_credentials(account: String, password: String) -> Result<Value, String> {
    let start = crate::wpe::steam::auth::begin_credentials(&account, &password).await?;
    serde_json::to_value(start).map_err(|error| error.to_string())
}

pub async fn wpe_steam_login_submit_code(login_id: String, code: String, kind: String) -> Result<(), String> {
    crate::wpe::steam::auth::submit_code(&login_id, &code, &kind).await
}

pub async fn wpe_steam_login_poll(login_id: String) -> Result<Value, String> {
    let poll = crate::wpe::steam::auth::poll(&login_id).await?;
    serde_json::to_value(poll).map_err(|error| error.to_string())
}

pub fn wpe_steam_login_cancel(login_id: String) {
    crate::wpe::steam::auth::cancel(&login_id);
}

/// 识别一个用户选中的文件夹，返回它展开后的壁纸数量。
pub fn recognize_wpe_dir(path: String) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".to_string());
    }
    let info = scan_extra_dir(Path::new(trimmed), &imported_paths())?;
    serde_json::to_value(info).map_err(|error| error.to_string())
}
