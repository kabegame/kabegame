// 壁纸相关命令和函数

use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::WallpaperRotator;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use std::path::Path;
use tauri::AppHandle;

pub async fn get_current_wallpaper_path_from_settings(
    _app: &tauri::AppHandle,
) -> Result<Option<String>, String> {
    // 从 Settings 获取 settings + image localPath
    if let Some(id) = Settings::global().get_current_wallpaper_image_id() {
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


#[tauri::command]
pub async fn set_wallpaper(file_path: String) -> Result<(), String> {
    // Android 上为 content:// URI，不能做 Path::exists/canonicalize
    let abs = if file_path.starts_with("content://") {
        file_path.clone()
    } else {
        let path = Path::new(&file_path);
        if !path.exists() {
            println!("DEBUG: File does not exist: {}", file_path);
            return Err("File does not exist".to_string());
        }
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string()
    };

    let controller = WallpaperController::global();
    let settings = Settings::global();
    let style = settings.get_wallpaper_rotation_style();

    controller.set_wallpaper(&abs, &style).await?;

    // 尽力同步更新"当前壁纸"（imageId）；失败不阻断
    let found = Storage::global().find_image_by_path(&abs).ok().flatten();
    let image_id = found.as_ref().map(|v| v.id.clone());
    let _ = settings.set_current_wallpaper_image_id(image_id);

    if let Some(ref img) = found {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = Storage::global().update_image_last_set_wallpaper_at(&img.id, now);
        let ids = vec![img.id.clone()];
        GlobalEmitter::global().emit_images_change("change", &ids, None, None);
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_by_image_id(image_id: String) -> Result<(), String> {
    let settings = Settings::global();
    let style = settings.get_wallpaper_rotation_style();

    let image = Storage::global()
        .find_image_by_id(&image_id)
        .map_err(|e| format!("Storage error: {}", e))?;

    let Some(info) = image else {
        return Err("图片不存在".to_string());
    };
    let local_path = info.local_path;

    let requires_window_mode = kabegame_core::image_type::requires_window_mode(Path::new(&local_path));
    if requires_window_mode {
        let current_mode = settings.get_wallpaper_mode();
        if current_mode != "window" {
            return Err("REQUIRES_WINDOW_MODE".to_string());
        }
    }

    let requires_plugin_mode = kabegame_core::image_type::requires_plugin_mode(Path::new(&local_path));
    if requires_plugin_mode {
        let current_mode = settings.get_wallpaper_mode();
        if current_mode != "plasma-plugin" {
            return Err("REQUIRES_PLUGIN_MODE".to_string());
        }
    }

    // Android 上为 content:// URI，不能用 Path::exists 判断
    if !local_path.starts_with("content://") && !Path::new(&local_path).exists() {
        let _ = settings.set_current_wallpaper_image_id(None);
        return Err("图片文件不存在".to_string());
    }

    let controller = WallpaperController::global();
    controller.set_wallpaper(&local_path, &style).await?;

    settings
        .set_current_wallpaper_image_id(Some(image_id.clone()))
        .map_err(|e| format!("Settings error: {}", e))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = Storage::global().update_image_last_set_wallpaper_at(&image_id, now);
    let ids = vec![image_id];
    GlobalEmitter::global().emit_images_change("change", &ids, None, None);
    Ok(())
}

#[tauri::command]
pub fn get_current_wallpaper_image_id() -> Option<String> {
    Settings::global().get_current_wallpaper_image_id()
}

#[tauri::command]
pub fn clear_current_wallpaper_image_id() -> Result<(), String> {
    Settings::global().set_current_wallpaper_image_id(None)
}

#[tauri::command]
pub async fn get_current_wallpaper_path(app: AppHandle) -> Result<Option<String>, String> {
    get_current_wallpaper_path_from_settings(&app).await
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
pub fn set_wallpaper_rotation_enabled(enabled: bool) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_enabled(enabled)
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
        let include = Settings::global().get_wallpaper_rotation_include_subalbums();
        let images = Storage::global()
            .get_album_images_for_wallpaper_rotation(&album_id, include)
            .map_err(|e| e.to_string())?;
        if images.is_empty() {
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
        .map_err(|e| format!("Settings error: {}", e))?;

    if normalized.is_none() {
        let rotator = WallpaperRotator::global();
        rotator.stop();
        return Ok(());
    }

    let settings = Settings::global();
    let enabled = settings.get_wallpaper_rotation_enabled();
    let album_id_opt = settings.get_wallpaper_rotation_album_id();

    if enabled {
        let rotator = WallpaperRotator::global();
        let start_from_current = album_id_opt
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
pub fn set_wallpaper_rotation_include_subalbums(include_subalbums: bool) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_include_subalbums(include_subalbums)
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();
    if rotator.is_running() {
        rotator.reset();
    }

    Ok(())
}

#[tauri::command]
pub async fn start_wallpaper_rotation() -> Result<RotationStartResult, String> {
    let settings = Settings::global();
    let enabled = settings.get_wallpaper_rotation_enabled();
    let album_id_opt = settings.get_wallpaper_rotation_album_id();

    if !enabled {
        return Err("壁纸轮播未启用".to_string());
    }

    let rotator = WallpaperRotator::global();
    let mut did_fallback = false;
    let mut warning: Option<String> = None;

    if let Some(saved) = album_id_opt.as_deref() {
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
pub fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> Result<(), String> {
    #[cfg(target_os = "android")]
    let minutes = minutes.max(15);
    #[cfg(not(target_os = "android"))]
    let minutes = minutes;

    Settings::global()
        .set_wallpaper_rotation_interval_minutes(minutes)
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();
    if rotator.is_running() {
        rotator.reset();
    }

    Ok(())
}

#[tauri::command]
pub fn set_wallpaper_rotation_mode(mode: String) -> Result<(), String> {
    Settings::global()
        .set_wallpaper_rotation_mode(mode)
        .map_err(|e| format!("Settings error: {}", e))
}

#[tauri::command]
pub async fn set_wallpaper_style(style: String, app: AppHandle) -> Result<(), String> {
    Settings::global().set_wallpaper_style(style.clone())?;

    let app_clone = app.clone();
    let style_clone = style.clone();
    let controller = WallpaperController::global();
    let manager = controller.active_manager().await?;
    manager.set_style(&style_clone).await?;
    if let Ok(Some(path)) = get_current_wallpaper_path_from_settings(&app_clone).await {
        if Path::new(&path).exists() {
            let _ = manager.set_wallpaper_path(&path).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_rotation_transition(transition: String) -> Result<(), String> {
    let enabled = Settings::global().get_wallpaper_rotation_enabled();

    Settings::global()
        .set_wallpaper_rotation_transition(transition.clone())
        .map_err(|e| format!("Settings error: {}", e))?;

    let transition_clone = transition.clone();
    let controller = WallpaperController::global();
    let rotator = WallpaperRotator::global();

    let manager = controller.active_manager().await?;
    manager.set_transition(&transition_clone).await?;
    if enabled && transition_clone != "none" {
        rotator.rotate().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_wallpaper_mode(mode: String, app: AppHandle) -> Result<(), String> {
    let settings = Settings::global();
    let old_mode = settings.get_wallpaper_mode();

    if old_mode == mode {
        return Ok(());
    }

    let rotator = WallpaperRotator::global();
    let controller = WallpaperController::global();

    let was_running = rotator.is_running();
    if was_running {
        rotator.stop();
    }

    let settings = Settings::global();
    let rotation_enabled = settings.get_wallpaper_rotation_enabled();
    let rotation_mode = settings.get_wallpaper_rotation_mode();
    let cur_style = settings.get_wallpaper_rotation_style();
    let cur_transition = settings.get_wallpaper_rotation_transition();

    let current_wallpaper = match get_current_wallpaper_path_from_settings(&app).await {
        Ok(Some(p)) => p,
        _ => {
            // 无当前壁纸时，对于 plasma-plugin 仍需调用 init 切换系统壁纸插件
            #[cfg(target_os = "linux")]
            if mode == "plasma-plugin" {
                let target = controller.manager_for_mode(&mode);
                target.init(app.clone()).map_err(|e| format!("切换系统壁纸插件失败: {}", e))?;
            }
            settings.set_wallpaper_mode(mode.clone())?;
            return Ok(());
        }
    };

    let target = controller.manager_for_mode(&mode);
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
        .swap_style_transition_for_mode_switch(&old_mode, &mode)
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

    eprintln!("[DEBUG] set_wallpaper_mode: 开始应用模式 {}", mode);
    target.init(app.clone()).map_err(|e| format!("init 失败: {}", e))?;
    #[cfg(not(target_os = "linux"))]
    let is_plugin_mode = false;
    #[cfg(target_os = "linux")]
    let is_plugin_mode = mode == "plasma-plugin";
    if !is_plugin_mode && !Path::new(&resolved_wallpaper).exists() {
        let error_msg = if old_mode == "native" {
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
        if was_running {
            let _ = rotator.start().await;
        }
        return Err(error_msg);
    }
    target.set_wallpaper_path(&resolved_wallpaper).await?;
    target.set_style(&style_to_apply).await?;
    if rotation_enabled {
        target.set_transition(&transition_to_apply).await?;
    }

    if old_mode == "window" && mode != "window" {
        controller
            .manager_for_mode("window")
            .cleanup()
            .unwrap_or_else(|e| eprintln!("清理 window 资源失败: {}", e));
    }
    #[cfg(target_os = "linux")]
    if old_mode == "plasma-plugin" && mode != "plasma-plugin" {
        controller
            .manager_for_mode("plasma-plugin")
            .cleanup()
            .unwrap_or_else(|e| eprintln!("清理 plasma-plugin 资源失败: {}", e));
    }
    if old_mode == "gdi" && mode != "gdi" {
        if let Err(e) = controller.manager_for_mode("gdi").cleanup() {
            eprintln!("[ERROR] 清理 gdi 资源失败: {}", e);
        }
    }

    settings.set_wallpaper_mode(mode.clone())?;

    if rotation_enabled {
        let _ = rotator.start().await;
    }

    Ok(())
}

#[tauri::command]
pub fn get_wallpaper_rotator_status() -> Result<String, String> {
    let rotator = WallpaperRotator::global();
    Ok(rotator.get_status())
}
