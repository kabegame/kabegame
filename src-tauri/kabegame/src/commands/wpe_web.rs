//! WPE 网页壁纸（`x-wpe/web`）的宿主协议：页面里的垫片（`webview_js/wpe_shim.js`）向宿主
//! **拉取**完整状态，自己订阅应用事件、看到相关变化就重拉，差异与投递时机全由垫片决定。
//!
//! - 桌面壁纸窗口（主 frame 是 `file://` 入口）：垫片直接调 [`wpe_web_pull_state`]，权限只来自
//!   `wpe-web-capability`（远程 `file:` 来源）；
//! - 图库预览（主窗口里的 `file:` iframe，碰不到 IPC）：垫片 `postMessage` 给宿主页，宿主页用主窗口权限调
//!   [`get_wpe_web_state`] 代办（`apps/kabegame/src/components/wallpaper/wpeWebBridge.ts`）。
//!   iframe 的 `file:` 请求与桌面同一套运行时目录拦截，根目录由 [`set_wpe_web_preview`] 在预览挂载 /
//!   卸载时设置 / 清空；它设好根目录后返回入口 `file://`，前端给 iframe 赋 `src`（应用页能加载
//!   `file:` 子 frame 靠 CEF 补丁 0005，主窗口建窗前登记 `allow_app_local_resources("main")`）。
//!
//! 状态只在这里计算、每次都读图片当前的 metadata；宿主不推状态、不排队、不记版本号，乱序由垫片
//! 按自己的拉取编号丢弃。

use crate::wallpaper::manager::WallpaperController;
use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use kabegame_core::wpe::properties::{resolve_web_user_props, wpe_language_code};

/// 垫片注入脚本（壁纸窗口与主窗口共用，all-frames；按地址自判是否启用）。
pub const WPE_SHIM_JS: &str = include_str!("../webview_js/wpe_shim.js");

/// 网页壁纸页面拉取的完整状态。乱序由垫片按自己的拉取序号丢弃，这里不带版本号。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebState {
    /// 垫片按它过滤 `metadataId` 补丁（只认本张）。
    pub image_id: String,
    /// 推给 `applyUserProperties` 的用户属性：`{ key: { type, value } }`。
    pub user: serde_json::Map<String, serde_json::Value>,
    /// 推给 `applyGeneralProperties` 的通用属性。
    pub general: WpeWebGeneral,
}

/// 通用属性：第一版只有界面语言。`fps` 等到 Phase 6 有了设置再推（推 0 会让按 `1000 / fps`
/// 算间隔的页面停住）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebGeneral {
    /// WPE 语言码（`zh-chs` / `zh-cht` / `en-us` / `ja-jp` / `ko-kr`）。
    pub language: &'static str,
}

/// 按 id 组装状态，每次都读图片当前的 metadata（导入时存的 `project.json` 原文）；
/// 行不存在或不是 `x-wpe/web` 返回 None。metadata 读取放 blocking 线程。
pub async fn build_wpe_web_state(image_id: &str) -> Result<Option<WpeWebState>, String> {
    let Some(info) =
        Storage::find_image_by_id(image_id).map_err(|e| format!("Storage error: {}", e))?
    else {
        return Ok(None);
    };
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("web") {
        return Ok(None);
    }
    let id = info.id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    // metadata 缺失时按「作者没有声明属性」处理，页面照常收到空的用户属性。
    let user = raw
        .as_ref()
        .map(resolve_web_user_props)
        .unwrap_or_default();
    Ok(Some(WpeWebState {
        image_id: info.id,
        user,
        general: WpeWebGeneral {
            language: wpe_language_code(Settings::global().get_resolved_language()),
        },
    }))
}

/// 预览宿主页（主窗口应用页，main-capability）替 iframe 拉取。
#[tauri::command]
pub async fn get_wpe_web_state(image_id: String) -> Result<Option<WpeWebState>, String> {
    build_wpe_web_state(&image_id).await
}

/// 桌面网页壁纸页面（wpe-web-capability）。不接收 id：按调用方窗口找到 manager 里的
/// `WallpaperWindow`，只返回它当前显示的那张，页面拿不到别的图片的 metadata。
#[tauri::command]
pub async fn wpe_web_pull_state<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<WpeWebState, String> {
    // 只有窗口模式的壁纸窗口会返回 Some：别的 label、应用页、非窗口模式都是 None。
    let dir = WallpaperController::global()
        .manager_for_mode("window")
        .web_wallpaper_dir(webview.label())
        .ok_or("no web wallpaper")?;
    // dir 来自 read_project 的规范化目录，与入库时的 local_path 同形。
    let image = Storage::find_image_by_path(&dir.to_string_lossy())
        .map_err(|e| format!("Storage error: {}", e))?
        .ok_or("web wallpaper row missing")?;
    build_wpe_web_state(&image.id)
        .await?
        .ok_or_else(|| "web wallpaper row missing".to_string())
}

/// 图库预览：把调用方窗口的 `file:` 根目录设成这张网页壁纸的目录，并返回它的入口 `file://`
/// （`Some(id)` → `Some(入口)`；`None` 只清空根目录、返回 `None`）。本命令不导航，前端拿到入口后给
/// 预览 iframe 赋 `src`。预览 iframe 的每个 `file:` 请求都经运行时按这个根目录拦截；壁纸窗口不走这里。
///
/// 应用页（http / tauri 源）能给子 frame 赋 `src = "file:…"`，靠的是主窗口建窗前登记的
/// `tauri_runtime_cef::allow_app_local_resources("main")`（CEF 补丁 0005：渲染侧放过
/// `SecurityOrigin::CanDisplay`，浏览器侧给主 frame 进程 `file` 请求权）。补丁只开门，加载哪些文件
/// 仍由这里设的根目录裁决，所以必须先设根目录、再交出入口。
///
/// 只给主窗口（`permissions/main.toml`，不进 `wpe-web.toml`）。`main-capability` 也绑定壁纸窗口的应用页，
/// 所以按 label 拒绝壁纸窗口：那里的根目录由 `WallpaperWindow` 随导航管理。
#[tauri::command]
pub async fn set_wpe_web_preview<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    image_id: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let label = webview.label().to_string();
        check_preview_label(&label)?;
        let Some(id) = image_id else {
            tauri_runtime_cef::set_file_document_root(&label, None)?;
            return Ok(None);
        };
        // 先开根目录再交出入口：主窗口的每个 `file:` 请求都按它拦截，没设好时连入口页都会被拒
        let (root, entry) = preview_entry(&id).await?;
        tauri_runtime_cef::set_file_document_root(&label, Some(root))?;
        Ok(Some(entry.to_string()))
    }
    // WPE 网页壁纸暂只支持 Windows；前端据此报错并退回作者预览图。
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (webview, image_id);
        Err("WPE web wallpapers are Windows-only for now".to_string())
    }
}

/// 预览根目录只能设在壁纸窗口以外的 webview 上。
#[cfg(target_os = "windows")]
fn check_preview_label(label: &str) -> Result<(), String> {
    if label == crate::wallpaper::manager::window::WALLPAPER_LABEL {
        return Err("set_wpe_web_preview is not available in the wallpaper window".to_string());
    }
    Ok(())
}

/// 预览的根目录与入口：行必须是 `x-wpe/web`，二者都取 [`crate::wallpaper::web_entry`]（与桌面壁纸窗口
/// 同一份算法：规范化目录 + 目录内的入口 `file://`，所以入口一定落在根目录内）。读 `project.json` 放 blocking 线程。
#[cfg(target_os = "windows")]
async fn preview_entry(image_id: &str) -> Result<(std::path::PathBuf, url::Url), String> {
    let info = Storage::find_image_by_id(image_id)
        .map_err(|e| format!("Storage error: {}", e))?
        .ok_or("image not found")?;
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("web") {
        return Err("not a web wallpaper".to_string());
    }
    let dir = std::path::PathBuf::from(&info.local_path);
    let entry = tauri::async_runtime::spawn_blocking(move || crate::wallpaper::web_entry(&dir))
        .await
        .map_err(|error| error.to_string())??;
    entry.ok_or_else(|| "web wallpaper entry missing".to_string())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use tauri::utils::acl::RemoteUrlPattern;
    use url::Url;

    /// 预览根目录命令拒绝壁纸窗口，主窗口放行。
    #[cfg(target_os = "windows")]
    #[test]
    fn preview_root_rejects_wallpaper_window() {
        assert!(
            super::check_preview_label(crate::wallpaper::manager::window::WALLPAPER_LABEL).is_err()
        );
        assert!(super::check_preview_label("main").is_ok());
    }

    /// `wpe-web-capability` 的 `remote.urls`：`file:///*` 能匹配桌面网页壁纸入口，
    /// 不匹配应用页与本地 HTTP 源。图库预览的 iframe 同样是 `file:`，但这个 capability 只绑定
    /// `wallpaper` 窗口，在 `main` 里零授权。
    #[test]
    fn wpe_web_capability_pattern_matches_file_urls() {
        let pattern = RemoteUrlPattern::from_str("file:///*").expect("file:///* 应能解析");
        let entry = Url::parse("file:///D:/Applications/Steam/steamapps/workshop/content/431960/3679122549/index.html")
            .unwrap();
        assert!(pattern.test(&entry));
        // 百分号编码路径（含空格、中文目录）
        let encoded = Url::parse("file:///D:/WPE%20Lib/%E5%A3%81%E7%BA%B8/index.html").unwrap();
        assert!(pattern.test(&encoded));
        // cef-ipc 回退通道交给 Tauri 的 `file://localhost/…` 经 url 归一后同样匹配
        let localhost = Url::parse("file://localhost/D:/x/y/index.html").unwrap();
        assert!(pattern.test(&localhost));
        assert!(!pattern.test(&Url::parse("http://127.0.0.1/").unwrap()));
        assert!(!pattern.test(&Url::parse("http://127.0.0.1:33050/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("https://example.com/").unwrap()));
    }
}
