//! WPE 网页壁纸（`x-wpe/web`）的宿主协议：页面里的垫片（`webview_js/wpe_shim.js`）向宿主
//! **拉取**完整状态，自己订阅应用事件、看到相关变化就重拉，差异与投递时机全由垫片决定。
//!
//! - 桌面壁纸窗口（主 frame 是 `file://` 入口）：垫片直接调 [`wpe_web_pull_state`]，权限只来自
//!   `wpe-web-capability`（远程 `file:` 来源）；
//! - 图库预览（主窗口里的跨源 iframe）：垫片 `postMessage` 给宿主页，宿主页用主窗口权限调
//!   [`get_wpe_web_state`] 代办（`apps/kabegame/src/components/wallpaper/wpeWebBridge.ts`）。
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

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use tauri::utils::acl::RemoteUrlPattern;
    use url::Url;

    /// `wpe-web-capability` 的 `remote.urls`：`file:///*` 能匹配桌面网页壁纸入口，
    /// 不匹配应用页、预览用的本地 HTTP 源。
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
        assert!(!pattern.test(&Url::parse("http://127.0.0.1:33050/wpe/12097/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("https://example.com/").unwrap()));
    }
}
