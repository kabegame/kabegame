//! 从 Steam 拉取 Wallpaper Engine（内建插件 `wpe-import` 的「从 Steam 拉取」来源）。
//!
//! 分两半：
//! - **登录**（[`auth`]）：对话框分步完成，每一步一次 HTTPS 调用 `IAuthenticationService`（扫码或账号密码 +
//!   Steam Guard），以 `SteamClient` 平台类型拿到能登录 CM 的 refresh token。token 存在 `wpe-import` 插件数据的
//!   宿主私有区（[`sessions`]），任务参数里只有账号名。
//! - **下载**（[`cm`]、[`cdn`]、[`install`]）：任务用 refresh token 登录 CM（`steam-vent`），查 PICS、取 depot
//!   密钥与 manifest request code，再从 CDN 下载 manifest 与 chunk，解密、解压、校验后写进
//!   [`managed_engine_dir`]，按 manifest 增量更新。
//!
//! 流程照 DepotDownloader / SteamKit2 实测对齐，要点见 `cocs/wpe/WPE_STEAM.md`。
//! 安装目录照 Steam 库排：`<插件数据目录>/steamapps/common/wallpaper_engine`，[`super::discover`] 把插件数据目录
//! 当作一个库补登，三类壁纸根与安装目录的查找都不用另写。

pub mod auth;
pub mod cdn;
pub mod cm;
pub mod crypto;
pub mod install;
pub mod sessions;

use std::path::PathBuf;

use crate::app_paths::AppPaths;
use crate::wpe::WPE_IMPORT_PLUGIN_ID;

/// Wallpaper Engine 的 Steam app id。
pub const WPE_APP_ID: u32 = 431960;

/// Kabegame 管理的「Steam 库」：`wpe-import` 的插件数据目录。AppPaths 未初始化时为 None。
pub fn managed_library() -> Option<PathBuf> {
    AppPaths::try_global()?
        .plugin_data_dir(WPE_IMPORT_PLUGIN_ID)
        .ok()
}

/// 拉取的 WPE 安装目录：`<managed_library>/steamapps/common/wallpaper_engine`。
pub fn managed_engine_dir() -> Option<PathBuf> {
    managed_library().map(|library| {
        library
            .join("steamapps")
            .join("common")
            .join("wallpaper_engine")
    })
}
