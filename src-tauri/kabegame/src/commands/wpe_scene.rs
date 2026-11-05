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
    }
}
