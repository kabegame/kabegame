// 壁纸相关命令和函数

use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::WallpaperRotator;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub async fn get_current_wallpaper_path_from_settings(
    _app: &tauri::AppHandle,
) -> Result<Option<String>, String> {
    // 从 Settings 获取 settings + image localPath
    let id = Settings::global().get_current_wallpaper_image_id().await?;
    if let Some(id) = id {
        let img = Storage::global()
            .find_image_by_id(&id)
            .map_err(|e| format!("Storage error: {}", e))?;
        if let Some(info) = img {
            Ok(Some(info.local_path))
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
}

/// 启动时初始化"当前壁纸"并按规则回退/降级
///
/// 规则（按用户需求）：
/// - 非轮播：尝试设置 currentWallpaperImageId；失败则清空并停止
/// - 轮播：优先在轮播源中找到 currentWallpaperImageId；找不到则回退到轮播源的一张；源无可用则画册->画廊->关闭轮播并清空
pub async fn init_wallpaper_on_startup() -> Result<(), String> {
    use std::path::Path;

    let controller = WallpaperController::global();
    // 启动时只"尝试还原 currentWallpaperImageId"，不在客户端做大规模选图/回退，
    // 回退与轮播逻辑由 rotator 负责（避免客户端依赖 Storage/Settings）。
    let settings = Settings::global();
    let (style_result, id_result) = tokio::join!(
        settings.get_wallpaper_rotation_style(),
        settings.get_current_wallpaper_image_id()
    );

    let style = style_result.unwrap_or_else(|_| "fill".to_string());
    let Some(id) = id_result.ok().flatten() else {
        return Ok(());
    };

    let img_v = Storage::global()
        .find_image_by_id(&id)
        .map_err(|e| format!("Storage error: {}", e))?;

    let Some(img_info) = img_v else {
        let _ = settings.set_current_wallpaper_image_id(None).await;
        return Ok(());
    };
    let path = img_info.local_path;

    if !Path::new(&path).exists() {
        let _ = settings.set_current_wallpaper_image_id(None).await;
        return Ok(());
    }

    if controller.set_wallpaper(&path, &style).await.is_err() as bool {
        let _ = settings.set_current_wallpaper_image_id(None).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        println!("DEBUG: File does not exist: {}", file_path);
        return Err("File does not exist".to_string());
    }
    let controller = WallpaperController::global();
    let settings = Settings::global();
    let style = settings
        .get_wallpaper_rotation_style()
        .await
        .unwrap_or_else(|_| "fill".to_string());

    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();

    controller.set_wallpaper(&abs, &style).await?;

    // 尽力同步更新“当前壁纸”（imageId）；失败不阻断
    let found = Storage::global().find_image_by_path(&abs).ok().flatten();
    let image_id = found.as_ref().map(|v| v.id.clone());
    let _ = settings.set_current_wallpaper_image_id(image_id).await;
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_by_image_id(image_id: String) -> Result<(), String> {
    let settings = Settings::global();
    let style = settings
        .get_wallpaper_rotation_style()
        .await
        .unwrap_or_else(|_| "fill".to_string());

    let image = Storage::global()
        .find_image_by_id(&image_id)
        .map_err(|e| format!("Storage error: {}", e))?;

    let Some(info) = image else {
        return Err("图片不存在".to_string());
    };
    let local_path = info.local_path;

    if !Path::new(&local_path).exists() {
        let _ = settings.set_current_wallpaper_image_id(None).await;
        return Err("图片文件不存在".to_string());
    }

    let controller = WallpaperController::global();
    controller.set_wallpaper(&local_path, &style).await?;

    settings
        .set_current_wallpaper_image_id(Some(image_id))
        .await
        .map_err(|e| format!("Settings error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_current_wallpaper_image_id() -> Result<Option<String>, String> {
    Settings::global()
        .get_current_wallpaper_image_id()
        .await
        .map_err(|e| format!("Settings error: {}", e))
}

#[tauri::command]
pub async fn clear_current_wallpaper_image_id() -> Result<(), String> {
    Settings::global()
        .set_current_wallpaper_image_id(None)
        .await
        .map_err(|e| format!("Settings error: {}", e))
}

#[tauri::command]
pub async fn get_current_wallpaper_path(app: AppHandle) -> Result<Option<String>, String> {
    get_current_wallpaper_path_from_settings(&app).await
}

#[tauri::command]
pub fn migrate_images_from_json() -> Result<usize, String> {
    Storage::global().migrate_from_json()
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

// TODO: setting-change event driven
#[tauri::command]
pub async fn set_wallpaper_rotation_enabled(enabled: bool) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_enabled(enabled)
        .await
        .map_err(|e| format!("Settings error: {}", e))?;

    if !enabled {
        let rotator = WallpaperRotator::global();
        rotator.stop();
    }

    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_rotation_album_id(album_id: String) -> Result<(), String> {
    if album_id != "" {
        if Storage::global()
            .get_album_image_ids(&album_id)
            .unwrap()
            .len()
            == 0
        {
            return Err(String::from("该画册没有画哟，先去画廊添加进去吧！"));
        }
    }
    let normalized: Option<String> = if album_id.clone() == "" {
        None
    } else {
        Some(album_id)
    };

    Settings::global()
        .set_wallpaper_rotation_album_id(normalized.clone())
        .await
        .map_err(|e| format!("Settings error: {}", e))?;

    if normalized.is_none() {
        let rotator = WallpaperRotator::global();
        rotator.stop();
        return Ok(());
    }

    let settings = Settings::global();
    let (enabled_result, album_id_result) = tokio::join!(
        settings.get_wallpaper_rotation_enabled(),
        settings.get_wallpaper_rotation_album_id()
    );

    if enabled_result.unwrap_or(false) {
        let rotator = WallpaperRotator::global();
        let start_from_current = album_id_result
            .ok()
            .flatten()
            .map(|s| s.is_empty())
            .unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .await
            .map_err(|e| format!("启动轮播失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn start_wallpaper_rotation() -> Result<RotationStartResult, String> {
    let settings = Settings::global();
    let (enabled_result, album_id_result) = tokio::join!(
        settings.get_wallpaper_rotation_enabled(),
        settings.get_wallpaper_rotation_album_id()
    );

    if !enabled_result.unwrap_or(false) {
        return Err("壁纸轮播未启用".to_string());
    }

    let rotator = WallpaperRotator::global();
    let mut did_fallback = false;
    let mut warning: Option<String> = None;

    if let Some(saved) = album_id_result.ok().flatten().as_deref() {
        if !saved.trim().is_empty() {
            match rotator.ensure_running(false).await {
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

    settings
        .set_wallpaper_rotation_album_id(Some("".to_string()))
        .await
        .map_err(|e| format!("Settings error: {}", e))?;
    rotator.ensure_running(true).await?;

    Ok(RotationStartResult {
        started: true,
        source: "gallery".to_string(),
        album_id: Some("".to_string()),
        fallback: did_fallback,
        warning,
    })
}

#[tauri::command]
pub async fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_interval_minutes(minutes)
        .await
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();
    if rotator.is_running() {
        rotator.reset();
    }

    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_rotation_mode(mode: String) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_mode(mode)
        .await
        .map_err(|e| format!("Settings error: {}", e))
}

#[tauri::command]
pub async fn set_wallpaper_style(style: String, app: AppHandle) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_style(style.clone())
        .await?;

    let app_clone = app.clone();
    let style_clone = style.clone();
    let controller = WallpaperController::global();
    let manager = controller.active_manager().await?;
    manager.set_style(&style_clone, true).await?;
    if let Ok(Some(path)) = get_current_wallpaper_path_from_settings(&app_clone).await {
        if Path::new(&path).exists() {
            let _ = manager.set_wallpaper_path(&path, true).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_rotation_transition(transition: String) -> Result<(), String> {
    let enabled = Settings::global()
        .get_wallpaper_rotation_enabled()
        .await
        .unwrap_or(false);

    Settings::global()
        .set_wallpaper_rotation_transition(transition.clone())
        .await
        .map_err(|e| format!("Settings error: {}", e))?;

    let transition_clone = transition.clone();
    let controller = WallpaperController::global();
    let rotator = WallpaperRotator::global();

    let manager = controller.active_manager().await?;
    manager.set_transition(&transition_clone, enabled).await?;
    if enabled && transition_clone != "none" {
        rotator.rotate().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_mode(mode: String, app: AppHandle) -> Result<(), String> {
    let settings = Settings::global();
    let old_mode = settings
        .get_wallpaper_mode()
        .await
        .unwrap_or_else(|_| "native".to_string());

    if old_mode == mode {
        return Ok(());
    }

    let mode_clone = mode.clone();
    let old_mode_clone = old_mode.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let rotator = WallpaperRotator::global();
        let controller = WallpaperController::global();

        let was_running = rotator.is_running();
        if was_running {
            rotator.stop();
        }

        let settings = Settings::global();
        let (
            rotation_enabled_result,
            rotation_mode_result,
            cur_style_result,
            cur_transition_result,
        ) = tokio::join!(
            settings.get_wallpaper_rotation_enabled(),
            settings.get_wallpaper_rotation_mode(),
            settings.get_wallpaper_rotation_style(),
            settings.get_wallpaper_rotation_transition()
        );

        let rotation_enabled = rotation_enabled_result.unwrap_or(false);
        let rotation_mode = rotation_mode_result.unwrap_or_else(|_| "random".to_string());
        let cur_style = cur_style_result.unwrap_or_else(|_| "fill".to_string());
        let cur_transition = cur_transition_result.unwrap_or_else(|_| "none".to_string());

        let current_wallpaper = match get_current_wallpaper_path_from_settings(&app_clone).await {
            Ok(Some(p)) => p,
            _ => {
                match settings.set_wallpaper_mode(mode_clone.clone()).await {
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
                let images_v = match Storage::global().get_all_images() {
                    Ok(v) => v,
                    Err(_) => return None,
                };
                // images_v is Vec<ImageInfo>
                let mut existing: Vec<String> = Vec::new();
                for it in images_v {
                    if Path::new(&it.local_path).exists() {
                        existing.push(it.local_path.clone());
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
            }
            .await;

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
        let (style_to_apply, transition_to_apply) = match settings
            .swap_style_transition_for_mode_switch(&old_mode_clone, &mode_clone)
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
                if let Err(e) = settings.set_wallpaper_mode(mode_clone.clone()).await {
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
                    let _ = rotator.start().await;
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
                    let _ = rotator.start().await;
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
pub fn get_wallpaper_rotator_status() -> Result<String, String> {
    let rotator = WallpaperRotator::global();
    Ok(rotator.get_status())
}
