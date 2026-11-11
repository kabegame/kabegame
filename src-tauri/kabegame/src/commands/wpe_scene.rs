//! 场景宿主（P3-0）的命令。

/// 场景宿主 `index.html` 的 `file:///` 地址（见 `wallpaper::wpe_scene_host`）：主窗口 / 壁纸窗口的应用页把它赋给
/// iframe，sandbox 同网页壁纸。只给这两个窗口的应用页用（它们免 ACL），宿主自己的 capability 不含这条。
/// 宿主还没构建时报错。
#[tauri::command]
pub async fn get_wpe_scene_host_url() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::wallpaper::wpe_scene_host::prepare_host_entry_url)
        .await
        .map_err(|error| error.to_string())?
}

/// 宿主按图片 id 取得场景目录和 WPE 内置资源目录。
#[tauri::command]
pub async fn wpe_scene_target(image_id: String) -> Result<WpeSceneTarget, String> {
    use kabegame_core::media::image_type::wpe_kind;
    use kabegame_core::storage::Storage;

    let info = Storage::find_image_by_id(&image_id)
        .map_err(|error| error.to_string())?
        .ok_or("image not found")?;
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("scene") {
        return Err("not a scene wallpaper in the library".into());
    }
    let target = super::wallpaper::build_wallpaper_target(info).await;
    Ok(WpeSceneTarget {
        path: target.path,
        scene_assets: target.scene_assets,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeSceneTarget {
    pub path: String,
    pub scene_assets: Vec<String>,
}

/// 「清空脚本存储」：存储在宿主的 `file:` 来源里，应用页碰不到，所以广播给宿主，同一张图的全部宿主收到后停脚本、
/// 删本场景的前缀、重建脚本环境。只给应用页用（免 ACL），宿主与网页壁纸的权限里都没有这条；宿主能监听这个事件靠
/// `wpe-web-capability` 的 `allow-listen`。没有宿主存活时事件没人收，这次清空不生效：入口只在预览的右键菜单与工具条里（预览有实时实例）。
#[tauri::command]
pub fn wpe_scene_clear_storage<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    image_id: String,
) -> Result<(), String> {
    use crate::wallpaper::wpe_web_dir_index::WpeWebDirIndex;
    use tauri::Emitter;

    if !WpeWebDirIndex::global().is_scene(&image_id) {
        return Err("not a scene wallpaper in the library".into());
    }
    app.emit(
        "wpe-scene-clear-storage",
        serde_json::json!({ "imageId": image_id }),
    )
    .map_err(|error| error.to_string())
}

/// 窗口客户区里的一点，CSS 像素（和应用页的 `clientX` / `getBoundingClientRect` 同一坐标系）。
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct WpeSceneCursor {
    pub x: f64,
    pub y: f64,
}

/// 客户区物理像素 → CSS 像素：除以窗口的 DPI 缩放（`dpi / 96`，取不到 DPI 时 `dpi` 为 0，按 1 算）。和
/// `wallpaper::input_forward` 把光标换成视图坐标的映射相同，只是不取整：这里交给页面按显示矩形换算，不注入事件。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn client_to_css(x: i32, y: i32, dpi: u32) -> WpeSceneCursor {
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    WpeSceneCursor {
        x: x as f64 / scale,
        y: y as f64 / scale,
    }
}

/// 开场指针（P5a 收尾）：光标在调用方 webview 所在窗口客户区里的位置（CSS 像素），不论光标在不在窗口里（可为负或越界）。
/// `WpeSceneView` 在宿主建好时问一次，按 iframe 的显示矩形换成宿主里的归一化坐标交过去，宿主开场就用真实光标，
/// 不必等第一个 `pointermove`（桌面壁纸窗口的页面本身收不到鼠标事件）。Windows 用 `GetCursorPos` + `ScreenToClient`
/// + `GetDpiForWindow`，同鼠标转发；拿不到或其它平台返回 `null`，调用方退回页面自己记的鼠标位置。
/// 只给主窗口 / 壁纸窗口的应用页用（免 ACL）。异步命令：取窗口句柄要等主线程回执，不能在主线程上同步等。
#[tauri::command]
pub async fn wpe_scene_cursor<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Option<WpeSceneCursor> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{HWND, POINT};
        use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
        use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let hwnd = match webview.window().hwnd() {
            Ok(hwnd) => hwnd.0 as isize as HWND,
            Err(error) => {
                tracing::debug!("取窗口句柄失败: {error}");
                return None;
            }
        };
        let mut point = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0
            || unsafe { ScreenToClient(hwnd, &mut point) } == 0
        {
            return None;
        }
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        Some(client_to_css(point.x, point.y, dpi))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = webview;
        None
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WpeSceneReport {
    Ready {
        instance: String,
    },
    Fallback {
        instance: String,
        reasons: Vec<String>,
    },
    Log {
        level: String,
        message: String,
    },
}

#[tauri::command]
pub fn wpe_scene_report<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    report: WpeSceneReport,
) -> Result<(), String> {
    use tauri::Emitter;
    match report {
        WpeSceneReport::Ready { instance } => webview
            .emit_to(
                webview.label(),
                "wpe-scene-status",
                serde_json::json!({ "instance": instance, "kind": "ready" }),
            )
            .map_err(|error| error.to_string()),
        WpeSceneReport::Fallback { instance, reasons } => webview
            .emit_to(
                webview.label(),
                "wpe-scene-status",
                serde_json::json!({ "instance": instance, "kind": "fallback", "reasons": reasons }),
            )
            .map_err(|error| error.to_string()),
        WpeSceneReport::Log { level, message } => {
            let label = webview.label();
            match level.as_str() {
                "error" => {
                    tracing::error!(target: "kabegame::wpe_scene_host", "{label}: {message}")
                }
                "warn" => tracing::warn!(target: "kabegame::wpe_scene_host", "{label}: {message}"),
                "debug" => {
                    tracing::debug!(target: "kabegame::wpe_scene_host", "{label}: {message}")
                }
                "trace" => {
                    tracing::trace!(target: "kabegame::wpe_scene_host", "{label}: {message}")
                }
                _ => tracing::info!(target: "kabegame::wpe_scene_host", "{label}: {message}"),
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{client_to_css, WpeSceneCursor, WpeSceneReport};

    #[test]
    fn client_to_css_divides_by_dpi_scale() {
        // 96 DPI 是 100%：物理像素就是 CSS 像素
        assert_eq!(
            client_to_css(300, 200, 96),
            WpeSceneCursor { x: 300.0, y: 200.0 }
        );
        // 150%：除以 1.5，不取整
        assert_eq!(
            client_to_css(301, 150, 144),
            WpeSceneCursor {
                x: 301.0 / 1.5,
                y: 100.0
            }
        );
        // 光标在窗口外：负数与越界照原样换算
        assert_eq!(
            client_to_css(-192, 4000, 192),
            WpeSceneCursor {
                x: -96.0,
                y: 2000.0
            }
        );
        // 取不到 DPI（0）按 100%
        assert_eq!(client_to_css(7, 9, 0), WpeSceneCursor { x: 7.0, y: 9.0 });
    }

    #[test]
    fn scene_report_deserializes_each_kind() {
        assert!(
            matches!(serde_json::from_value::<WpeSceneReport>(serde_json::json!({"kind":"ready","instance":"1"})), Ok(WpeSceneReport::Ready { instance }) if instance == "1")
        );
        assert!(
            matches!(serde_json::from_value::<WpeSceneReport>(serde_json::json!({"kind":"fallback","instance":"2","reasons":["gpu"]})), Ok(WpeSceneReport::Fallback { reasons, .. }) if reasons == ["gpu"])
        );
        assert!(
            matches!(serde_json::from_value::<WpeSceneReport>(serde_json::json!({"kind":"log","level":"info","message":"ok"})), Ok(WpeSceneReport::Log { message, .. }) if message == "ok")
        );
    }
}
