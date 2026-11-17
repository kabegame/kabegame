//! 场景宿主（P3-0）的命令。

use std::collections::BTreeMap;

/// 场景宿主 `index.html` 的 `file:///` 地址（见 `wallpaper::wpe_scene_host`）：主窗口 / 壁纸窗口的应用页把它赋给
/// iframe，sandbox 同网页壁纸。只给这两个窗口的应用页用（它们免 ACL），宿主自己的 capability 不含这条。
/// 宿主还没构建时报错。
#[tauri::command]
pub async fn get_wpe_scene_host_url() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::wallpaper::wpe_scene_host::prepare_host_entry_url)
        .await
        .map_err(|error| error.to_string())?
}

/// 宿主按图片 id 取得场景目录、WPE 内置资源目录与系统字体表。
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
        // 读内存表、不再解析：宿主能跑起来，说明应用页已经取过宿主地址（`get_wpe_scene_host_url` 先
        // `refresh_scene_host`），启动时 `init_heavy_globals` 也解析过一次，这里拿到的就是闸门正在用的那份。
        system_fonts: crate::wallpaper::wpe_scene_host::system_fonts(),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeSceneTarget {
    pub path: String,
    pub scene_assets: Vec<String>,
    /// 文本对象的系统字体：名字（WPE 在 `%WINDIR%\Fonts` 下的文件名，宿主的 `system:<名字>`）→ 本机文件的路径。
    /// 后端按平台解析（`wallpaper::wpe_scene_host::system_fonts`），本机没有的名字不在表里，宿主读它时当读不到。
    pub system_fonts: BTreeMap<String, String>,
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

/// 开场指针（P5a 收尾）：光标在调用方 webview 所在窗口客户区里的位置（CSS 像素），不论光标在不在窗口里（可为负或越界）。
/// `WpeSceneView` 在宿主建好时问一次，按 iframe 的显示矩形换成宿主里的归一化坐标交过去，宿主开场就用真实光标，
/// 不必等第一个 `pointermove`（桌面壁纸窗口的页面本身收不到鼠标事件）。换算在 `tauri-plugin-cursor`
/// （Windows 用 `GetCursorPos` + `ScreenToClient` + `GetDpiForWindow`，macOS 也有了，未实测）；拿不到或 Linux 返回
/// `null`，调用方退回页面自己记的鼠标位置。
/// 只给主窗口 / 壁纸窗口的应用页用（免 ACL）。异步命令：取窗口句柄要等主线程回执，不能在主线程上同步等。
#[tauri::command]
pub async fn wpe_scene_cursor<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Option<WpeSceneCursor> {
    let native = tauri_plugin_cursor::native_window(&webview.window())?;
    let (x, y) = tauri_plugin_cursor::position_in_window(native)?;
    Some(WpeSceneCursor { x, y })
}

/// 场景宿主取快捷方式图标（P11d）：按图片 id 读 metadata 里这一项的值，Windows 上照 winrtutil 取正方形图标，
/// 回 `[宽 u32 LE][高 u32 LE][RGBA，直通 alpha]`；没配置、取不到、非 Windows 回 0 字节。图片要是库内场景、
/// 属性类型要是 `usershortcut`，值只取用户配的（不取工程缺省值）。进 `wpe-scene-host.toml`。
#[tauri::command]
pub async fn wpe_scene_shortcut_icon(
    image_id: String,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = crate::wallpaper::wpe_shortcut::icon(&image_id, &name)
        .await?
        .map(|icon| icon.to_ipc_bytes())
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(bytes))
}

/// 启动场景的快捷方式（P11d）。只登记进 `generate_handler!`、不进任何 `permissions/*.toml`：只有主窗口与壁纸窗口的
/// 应用页（免 ACL）调得到，场景宿主与网页壁纸都调不到；应用页负责核对用户激活并传自己持有的图片 id。
/// 图片要是库内场景；属性在 `project.json` 里要是 `usershortcut`；值只取用户配过的。Windows 上
/// `ShellExecuteW` 返回值 > 32 为成功（`true`），没配返回 `false`，其它平台报错。
#[tauri::command]
pub async fn wpe_open_user_shortcut(image_id: String, name: String) -> Result<bool, String> {
    crate::wallpaper::wpe_shortcut::launch(&image_id, &name).await
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
    /// 运行中出现的不支持项（活的场景图 L5 点 5）：场景不退回，相关对象没画出。宿主同实例同键只报一次。
    Unsupported {
        instance: String,
        /// 宿主地址里的 `kbScene`（图片 id），取不到时为空串
        image: String,
        keys: Vec<String>,
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
        WpeSceneReport::Unsupported {
            instance,
            image,
            keys,
        } => {
            let label = webview.label();
            // 桌面壁纸窗口没有看板娘：提示一律送主窗口（补丁 14：emit_to 只送这个 label），文案按来源区分
            let surface = if crate::wallpaper::is_wallpaper_label(label) {
                "desktop"
            } else {
                "preview"
            };
            tracing::warn!(
                target: "kabegame::wpe_scene_host",
                "{label}: 场景 {image}（实例 {instance}）运行中用到不支持的特性：{}",
                keys.join(", ")
            );
            webview
                .emit_to(
                    "main",
                    "wpe-scene-unsupported",
                    serde_json::json!({ "image": image, "surface": surface, "keys": keys }),
                )
                .map_err(|error| error.to_string())
        }
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
    use super::WpeSceneReport;

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
        assert!(
            matches!(serde_json::from_value::<WpeSceneReport>(serde_json::json!({"kind":"unsupported","instance":"3","image":"img-1","keys":["particle:renderers","text:engine"]})), Ok(WpeSceneReport::Unsupported { instance, image, keys }) if instance == "3" && image == "img-1" && keys == ["particle:renderers", "text:engine"])
        );
    }
}
