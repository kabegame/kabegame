// 壁纸相关命令和函数

use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::rotator::pick_random_gallery_wallpaper;
use crate::wallpaper::WallpaperRotator;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
use std::path::Path;
use tauri::AppHandle;

/// 当"关闭壁纸"开关开启时，对用户主动发起的壁纸操作返回的提示文案。
/// 直接作为错误信息透传给前端展示（不使用专用错误码）。
const WALLPAPER_DISABLED_MSG: &str = "壁纸功能已关闭，请先在设置中重新开启";

/// 若已关闭壁纸功能，则返回错误以拒绝该操作。
fn reject_if_wallpaper_disabled() -> Result<(), String> {
    if Settings::global().get_wallpaper_disabled() {
        return Err(WALLPAPER_DISABLED_MSG.to_string());
    }
    Ok(())
}

pub async fn get_current_wallpaper_path_from_settings<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    // 从 Settings 获取 settings + image localPath
    if let Some(id) = Settings::global().get_current_wallpaper_image_id() {
        let img = Storage::find_image_by_id(&id).map_err(|e| format!("Storage error: {}", e))?;
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
pub async fn set_wallpaper_by_image_id(image_id: String) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let style = settings.get_wallpaper_rotation_style();

    let image =
        Storage::find_image_by_id(&image_id).map_err(|e| format!("Storage error: {}", e))?;

    let Some(info) = image else {
        return Err("图片不存在".to_string());
    };
    let local_path = info.local_path;
    let plugin_id = info.plugin_id;

    let requires_window_mode =
        kabegame_core::image_type::requires_window_mode(Path::new(&local_path));
    if requires_window_mode {
        let current_mode = settings.get_wallpaper_mode();
        if current_mode != "window" {
            return Err("REQUIRES_WINDOW_MODE".to_string());
        }
    }

    let requires_plugin_mode =
        kabegame_core::image_type::requires_plugin_mode(Path::new(&local_path));
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
    GlobalEmitter::global().emit_images_change("change", &ids, None, None, Some(&[plugin_id]));
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
pub async fn get_current_wallpaper_path<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
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
    if enabled {
        reject_if_wallpaper_disabled()?;
    }
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
    reject_if_wallpaper_disabled()?;
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
        let start_from_current = album_id_opt.map(|s| s.is_empty()).unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .await
            .map_err(|e| format!("启动轮播失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_wallpaper_rotation_include_subalbums(include_subalbums: bool) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
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
    reject_if_wallpaper_disabled()?;
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
    reject_if_wallpaper_disabled()?;
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
    reject_if_wallpaper_disabled()?;
    Settings::global()
        .set_wallpaper_rotation_mode(mode)
        .map_err(|e| format!("Settings error: {}", e))
}

#[tauri::command]
pub async fn set_wallpaper_style<R: tauri::Runtime>(
    style: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
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
    reject_if_wallpaper_disabled()?;
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
pub async fn set_wallpaper_mode<R: tauri::Runtime>(
    mode: String,
    app: AppHandle<R>,
) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
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
    let cur_style = settings.get_wallpaper_rotation_style();
    let cur_transition = settings.get_wallpaper_rotation_transition();

    let current_wallpaper = match get_current_wallpaper_path_from_settings(&app).await {
        Ok(Some(p)) => p,
        _ => {
            // 无当前壁纸时，对于 plasma-plugin 仍需调用 init 切换系统壁纸插件
            #[cfg(target_os = "linux")]
            if mode == "plasma-plugin" {
                let target = controller.manager_for_mode(&mode);
                target
                    .init()
                    .map_err(|e| format!("切换系统壁纸插件失败: {}", e))?;
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
    } else if let Some(p) = pick_random_gallery_wallpaper(&mode) {
        eprintln!(
            "[WARN] set_wallpaper_mode: 当前壁纸文件不存在，将从画廊选择兜底图片: {} (原路径: {})",
            p, current_wallpaper
        );
        p
    } else {
        current_cleaned.clone()
    };
    let (style_to_apply, transition_to_apply) =
        match settings.swap_style_transition_for_mode_switch(&old_mode, &mode) {
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
    target.init().map_err(|e| format!("init 失败: {}", e))?;
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
pub fn get_wallpaper_disabled() -> bool {
    Settings::global().get_wallpaper_disabled()
}

/// 切换"关闭壁纸"开关，并执行副作用：
/// - 开启时：停止轮播，隐藏壁纸窗口（window 模式）/ 切回 org.kde.image（plasma-plugin 模式）；
///   native 模式保持系统壁纸现状不动（无法自动还原）。保留 currentWallpaperImageId。
/// - 关闭时：复用启动逻辑恢复上次壁纸，并在轮播启用时恢复轮播。
#[tauri::command]
pub async fn set_wallpaper_disabled<R: tauri::Runtime>(
    disabled: bool,
    _app: AppHandle<R>,
) -> Result<(), String> {
    let settings = Settings::global();
    settings
        .set_wallpaper_disabled(disabled)
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();

    if disabled {
        // 停止轮播
        rotator.stop();
        // 隐藏/还原各模式（保留 currentWallpaperImageId）
        // native 模式：保持系统壁纸现状不动（无法自动还原，警告由前端提示）
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            let controller = WallpaperController::global();
            match settings.get_wallpaper_mode().as_str() {
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                "window" => {
                    let _ = controller.manager_for_mode("window").cleanup();
                }
                #[cfg(target_os = "linux")]
                "plasma-plugin" => {
                    let _ = controller.manager_for_mode("plasma-plugin").cleanup();
                }
                _ => {}
            }
        }
    } else {
        // 重新启用：恢复上次壁纸（复用启动恢复逻辑）
        if let Err(e) = crate::startup::init_wallpaper_on_startup().await {
            eprintln!("[WARN] set_wallpaper_disabled: 恢复壁纸失败: {}", e);
        }
        // 之前开启过轮播则恢复轮播
        if settings.get_wallpaper_rotation_enabled() {
            if let Err(e) = rotator.ensure_running(true).await {
                eprintln!("[WARN] set_wallpaper_disabled: 恢复轮播失败: {}", e);
            }
        }
    }

    Ok(())
}
