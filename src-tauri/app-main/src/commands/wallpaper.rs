// 壁纸相关命令和函数

use crate::daemon_client;
use crate::wallpaper::{WallpaperController, WallpaperRotator};
use tauri::{AppHandle, Manager, Emitter};
use std::path::Path;

pub async fn get_current_wallpaper_path_from_settings(_app: &tauri::AppHandle) -> Result<Option<String>, String> {
    // IPC-only：从 daemon 获取 settings + image localPath
    let v = daemon_client::get_ipc_client().settings_get().await?;
    let id = v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    if let Some(id) = id {
        let img = daemon_client::get_ipc_client().storage_get_image_by_id(id).await?;
        Ok(img.get("localPath")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

/// 启动时初始化"当前壁纸"并按规则回退/降级
///
/// 规则（按用户需求）：
/// - 非轮播：尝试设置 currentWallpaperImageId；失败则清空并停止
/// - 轮播：优先在轮播源中找到 currentWallpaperImageId；找不到则回退到轮播源的一张；源无可用则画册->画廊->关闭轮播并清空
pub async fn init_wallpaper_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    let controller = app.state::<WallpaperController>();
    // IPC-only：启动时只"尝试还原 currentWallpaperImageId"，不在客户端做大规模选图/回退，
    // 回退与轮播逻辑由 daemon + rotator 负责（避免客户端依赖 Storage/Settings）。
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

    let style = settings_v
        .get("wallpaperRotationStyle")
        .and_then(|x| x.as_str())
        .unwrap_or("fill")
        .to_string();

    let Some(id) = settings_v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
    else {
        return Ok(());
    };

    let img_v = daemon_client::get_ipc_client()
        .storage_get_image_by_id(id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let Some(path) = img_v.get("localPath").and_then(|x| x.as_str()) else {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
        return Ok(());
    };

    if !Path::new(path).exists() {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
        return Ok(());
    }

    if controller.set_wallpaper(path, &style).await.is_err() {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper(file_path: String, app: AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        let controller = app_clone.state::<WallpaperController>();
        let settings_v = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let style = settings_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill");

        let abs = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();

        tauri::async_runtime::block_on(async {
            controller.set_wallpaper(&abs, style).await
        })?;

        let found = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().storage_find_image_by_path(abs.clone()).await
        })
        .ok();
        let image_id = found
            .as_ref()
            .and_then(|v| v.get("id").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        let _ = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(image_id)
                .await
        });

        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

#[tauri::command]
pub async fn set_wallpaper_by_image_id(image_id: String, app: AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let settings_v = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let style = settings_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill");

        let image = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .storage_get_image_by_id(image_id.clone())
                .await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let local_path = image
            .get("localPath")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "图片不存在".to_string())?
            .to_string();

        if !Path::new(&local_path).exists() {
            let _ = tauri::async_runtime::block_on(async {
                daemon_client::get_ipc_client()
                    .settings_set_current_wallpaper_image_id(None)
                    .await
            });
            return Err("图片文件不存在".to_string());
        }

        let controller = app_clone.state::<WallpaperController>();
        tauri::async_runtime::block_on(async {
            controller.set_wallpaper(&local_path, style).await
        })?;

        tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(Some(image_id))
                .await
                .map_err(|e| format!("Daemon unavailable: {}", e))
        })?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

#[tauri::command]
pub fn get_current_wallpaper_image_id() -> Result<Option<String>, String> {
    let v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(v.get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string()))
}

#[tauri::command]
pub fn clear_current_wallpaper_image_id() -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub async fn get_current_wallpaper_path(app: AppHandle) -> Result<Option<String>, String> {
    get_current_wallpaper_path_from_settings(&app).await
}

#[tauri::command]
#[cfg(feature = "self-host")]
pub fn migrate_images_from_json(state: tauri::State<crate::storage::Storage>) -> Result<usize, String> {
    state.migrate_from_json()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationStartResult {
    pub started: bool,
    pub source: String,
    pub album_id: Option<String>,
    pub fallback: bool,
    pub warning: Option<String>,
}

#[tauri::command]
#[cfg(target_os = "windows")]
pub fn set_wallpaper_rotation_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_enabled(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    if !enabled {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
    }

    Ok(())
}

#[tauri::command]
pub fn set_wallpaper_rotation_album_id(album_id: Option<String>, app: AppHandle) -> Result<(), String> {
    let normalized = album_id.map(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            "".to_string()
        } else {
            t
        }
    });

    let normalized_for_ipc = normalized.clone();
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_album_id(normalized_for_ipc)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    if normalized.is_none() {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
        return Ok(());
    }

    let settings_v = tokio::runtime::Handle::current().block_on(async {
        daemon_client::get_ipc_client()
            .settings_get()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    if settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        let rotator = app.state::<WallpaperRotator>();
        let start_from_current = settings_v
            .get("wallpaperRotationAlbumId")
            .and_then(|x| x.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .map_err(|e| format!("启动轮播失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn start_wallpaper_rotation(app: AppHandle) -> Result<RotationStartResult, String> {
    let settings_v = tokio::runtime::Handle::current().block_on(async {
        daemon_client::get_ipc_client()
            .settings_get()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    if !settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        return Err("壁纸轮播未启用".to_string());
    }

    let rotator = app.state::<WallpaperRotator>();
    let mut did_fallback = false;
    let mut warning: Option<String> = None;

    if let Some(saved) = settings_v.get("wallpaperRotationAlbumId").and_then(|x| x.as_str()) {
        if !saved.trim().is_empty() {
            match rotator.ensure_running(false) {
                Ok(_) => {
                    return Ok(RotationStartResult {
                        started: true,
                        source: "album".to_string(),
                        album_id: Some(saved.to_string()),
                        fallback: false,
                        warning: None,
                    });
                }
                Err(e) => {
                    if e.contains("画册内没有图片") {
                        return Err(e);
                    }
                    if e.contains("画册不存在") {
                        eprintln!(
                            "[WARN] start_wallpaper_rotation: saved album_id missing, fallback to gallery. err={}",
                            e
                        );
                        did_fallback = true;
                        warning = Some("上次选择的画册不存在，已回退到画廊轮播".to_string());
                    } else {
                        return Err(e);
                    }
                }
            }
        }
    }

    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_album_id(Some("".to_string()))
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    rotator.ensure_running(true)?;

    Ok(RotationStartResult {
        started: true,
        source: "gallery".to_string(),
        album_id: Some("".to_string()),
        fallback: did_fallback,
        warning,
    })
}

#[tauri::command]
pub fn set_wallpaper_rotation_interval_minutes(minutes: u32, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_interval_minutes(minutes)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    if let Some(rotator) = app.try_state::<WallpaperRotator>() {
        if rotator.is_running() {
            rotator.reset();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_wallpaper_rotation_mode(mode: String) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_mode(mode)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
pub async fn set_wallpaper_style(style: String, app: AppHandle) -> Result<(), String> {
    println!("[DEBUG] set_wallpaper_style 被调用，传入的 style: {}", style);

    daemon_client::get_ipc_client().settings_set_wallpaper_style(style.clone()).await?;
    println!("[DEBUG] 已保存新 style: {}", style);

    let app_clone = app.clone();
    let style_clone = style.clone();
    let controller = app_clone.state::<WallpaperController>();
    let manager = controller.active_manager().await?;
    let res = manager.set_style(&style_clone, true).await;
    if let Ok(Some(path)) = get_current_wallpaper_path_from_settings(&app_clone).await {
        if Path::new(&path).exists() {
            let _ = manager.set_wallpaper_path(&path, true).await;
        }
    }
    match res {
        Ok(_) => {
            let _ = app_clone.emit(
                "wallpaper-style-apply-complete",
                serde_json::json!({
                    "success": true,
                    "style": style_clone
                }),
            );
        }
        Err(e) => {
            let _ = app_clone.emit(
                "wallpaper-style-apply-complete",
                serde_json::json!({
                    "success": false,
                    "style": style_clone,
                    "error": e
                }),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_rotation_transition(transition: String, app: AppHandle) -> Result<(), String> {
    println!("[DEBUG] set_wallpaper_rotation_transition 被调用，传入的 transition: {}", transition);

    let settings_v = daemon_client::get_ipc_client().settings_get().await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let enabled = settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !enabled {
        return Err("未开启壁纸轮播，无法设置过渡效果".to_string());
    }

    daemon_client::get_ipc_client()
        .settings_set_wallpaper_rotation_transition(transition.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    println!("[DEBUG] 已保存新 transition: {}", transition);

    let app_clone = app.clone();
    let transition_clone = transition.clone();
    let controller = app_clone.state::<WallpaperController>();
    let rotator = app_clone.state::<WallpaperRotator>();

    let manager = controller.active_manager().await?;
    let res = manager.set_transition(&transition_clone, true).await;

    if res.is_ok() && transition_clone != "none" {
        rotator.rotate().await?;
    }

    match res {
        Ok(_) => {
            let _ = app_clone.emit(
                "wallpaper-transition-apply-complete",
                serde_json::json!({
                    "success": true,
                    "transition": transition_clone
                }),
            );
        }
        Err(e) => {
            let _ = app_clone.emit(
                "wallpaper-transition-apply-complete",
                serde_json::json!({
                    "success": false,
                    "transition": transition_clone,
                    "error": e
                }),
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_mode(mode: String, app: AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let current_settings_v = daemon_client::get_ipc_client().settings_get().await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let old_mode = current_settings_v
        .get("wallpaperMode")
        .and_then(|x| x.as_str())
        .unwrap_or("native")
        .to_string();

    if old_mode == mode {
        return Ok(());
    }

    let mode_clone = mode.clone();
    let old_mode_clone = old_mode.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let rotator = app_clone.state::<WallpaperRotator>();
        let controller = app_clone.state::<WallpaperController>();

        let was_running = rotator.is_running();
        if was_running {
            rotator.stop();
        }

        let s_v = match daemon_client::get_ipc_client().settings_get().await {
            Ok(v) => v,
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("获取设置失败: {}", e)
                    }),
                );
                return;
            }
        };
        let rotation_enabled = s_v
            .get("wallpaperRotationEnabled")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let rotation_mode = s_v
            .get("wallpaperRotationMode")
            .and_then(|x| x.as_str())
            .unwrap_or("random")
            .to_string();
        let cur_style = s_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill")
            .to_string();
        let cur_transition = s_v
            .get("wallpaperRotationTransition")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string();

        let current_wallpaper = match get_current_wallpaper_path_from_settings(&app_clone).await {
            Ok(Some(p)) => p,
            _ => {
                match daemon_client::get_ipc_client()
                    .settings_set_wallpaper_mode(mode_clone.clone())
                    .await
                {
                    Ok(_) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": true,
                                "mode": mode_clone
                            }),
                        );
                    }
                    Err(e2) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": false,
                                "mode": mode_clone,
                                "error": format!("保存模式失败: {}", e2)
                            }),
                        );
                    }
                }
                return;
            }
        };

        let target = controller.manager_for_mode(&mode_clone);
        let current_cleaned = current_wallpaper
            .trim()
            .trim_start_matches(r"\\?\")
            .to_string();

        let resolved_wallpaper = if Path::new(&current_cleaned).exists() {
            current_cleaned.clone()
        } else {
            let picked_from_gallery: Option<String> = async {
                let images_v = match daemon_client::get_ipc_client().storage_get_images().await {
                    Ok(v) => v,
                    Err(_) => return None,
                };
                let arr = match images_v.as_array() {
                    Some(a) => a,
                    None => return None,
                };
                let mut existing: Vec<String> = Vec::new();
                for it in arr {
                    if let Some(p) = it.get("localPath").and_then(|x| x.as_str()) {
                        if Path::new(p).exists() {
                            existing.push(p.to_string());
                        }
                    }
                }
                if existing.is_empty() {
                    None
                } else {
                    match rotation_mode.as_str() {
                        "sequential" => Some(existing[0].clone()),
                        _ => {
                            let idx = (std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_nanos() as usize)
                                % existing.len();
                            Some(existing[idx].clone())
                        }
                    }
                }
            }.await;

            if let Some(p) = picked_from_gallery {
                eprintln!(
                    "[WARN] set_wallpaper_mode: 当前壁纸文件不存在，将从画廊选择兜底图片: {} (原路径: {})",
                    p, current_wallpaper
                );
                p
            } else {
                current_cleaned.clone()
            }
        };
        let (style_to_apply, transition_to_apply) =
            match daemon_client::get_ipc_client()
                .settings_swap_style_transition_for_mode_switch(
                    old_mode_clone.clone(),
                    mode_clone.clone(),
                )
                .await
            {
                Ok(v) => v,
                Err(e) => {
                    eprintln!(
                        "[WARN] set_wallpaper_mode: swap_style_transition_for_mode_switch 失败: {}",
                        e
                    );
                    (cur_style.clone(), cur_transition.clone())
                }
            };

        let apply_res = async {
            eprintln!("[DEBUG] set_wallpaper_mode: 开始应用模式 {}", mode_clone);
            eprintln!("[DEBUG] set_wallpaper_mode: 调用 target.init");
            target.init(app_clone.clone())?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.init 完成");
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_wallpaper_path: {}",
                resolved_wallpaper
            );
            if !Path::new(&resolved_wallpaper).exists() {
                let error_msg = if old_mode_clone == "native" {
                    format!(
                        "无法切换到窗口模式：当前系统壁纸文件不存在（可能是主题缓存或临时文件），且画廊中没有可用图片。请先在画廊中添加图片，或手动设置一张壁纸后再切换。\n原路径: {}",
                        resolved_wallpaper
                    )
                } else {
                    format!(
                        "无法切换到窗口模式：壁纸文件不存在，且画廊中没有可用图片作为兜底。请先在画廊中添加图片。\n路径: {}",
                        resolved_wallpaper
                    )
                };
                return Err(error_msg);
            }
            target.set_wallpaper_path(&resolved_wallpaper, true).await?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_wallpaper_path 完成");
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_style: {}",
                style_to_apply
            );
            target.set_style(&style_to_apply, true).await?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_style 完成");
            if rotation_enabled {
                eprintln!(
                    "[DEBUG] set_wallpaper_mode: 调用 target.set_transition: {}",
                    transition_to_apply
                );
                target.set_transition(&transition_to_apply, true).await?;
                eprintln!("[DEBUG] set_wallpaper_mode: target.set_transition 完成");
            }
            eprintln!("[DEBUG] set_wallpaper_mode: 应用模式完成");
            Ok::<(), String>(())
        }.await;

        match apply_res {
            Ok(_) => {
                eprintln!("[DEBUG] set_wallpaper_mode: apply_res 成功");
                if old_mode_clone == "window" && mode_clone != "window" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 清理 window 资源");
                    controller
                        .manager_for_mode("window")
                        .cleanup()
                        .unwrap_or_else(|e| eprintln!("清理 window 资源失败: {}", e));
                }
                if old_mode_clone == "gdi" && mode_clone != "gdi" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 开始清理 gdi 资源（从 gdi 模式切换到其他模式）");
                    match controller.manager_for_mode("gdi").cleanup() {
                        Ok(_) => eprintln!("[DEBUG] set_wallpaper_mode: gdi 资源清理成功"),
                        Err(e) => eprintln!("[ERROR] 清理 gdi 资源失败: {}", e),
                    }
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 保存模式设置");
                if let Err(e) = daemon_client::get_ipc_client()
                    .settings_set_wallpaper_mode(mode_clone.clone())
                    .await
                {
                    eprintln!("[ERROR] set_wallpaper_mode: 保存模式失败: {}", e);
                    let _ = app_clone.emit(
                        "wallpaper-mode-switch-complete",
                        serde_json::json!({
                            "success": false,
                            "mode": mode_clone,
                            "error": format!("保存模式失败: {}", e)
                        }),
                    );
                    return;
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 模式设置已保存");

                if rotation_enabled {
                    eprintln!("[DEBUG] set_wallpaper_mode: 恢复轮播");
                    let _ = rotator.start();
                }

                eprintln!("[DEBUG] set_wallpaper_mode: 发送成功事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": true,
                        "mode": mode_clone
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 成功事件已发送");
            }
            Err(e) => {
                eprintln!("[ERROR] 切换到 {} 模式失败: {}", mode_clone, e);
                if was_running {
                    let _ = rotator.start();
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 发送失败事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("切换模式失败: {}", e)
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 失败事件已发送");
            }
        };
    });
    Ok(())
}

#[tauri::command]
pub fn get_wallpaper_rotator_status(app: AppHandle) -> Result<String, String> {
    let rotator = app.state::<WallpaperRotator>();
    Ok(rotator.get_status())
}

#[tauri::command]
pub fn get_native_wallpaper_styles() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(target_os = "macos")]
    {
        Ok(vec!["fill".to_string(), "center".to_string()])
    }

    #[cfg(target_os = "linux")]
    {
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Ok(vec!["fill".to_string()])
    }
}
