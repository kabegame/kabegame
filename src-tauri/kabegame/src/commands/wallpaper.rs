// 壁纸相关命令和函数

use crate::wallpaper::manager::{WallpaperCapabilities, WallpaperController};
use crate::wallpaper::rotator::pick_random_gallery_wallpaper;
use crate::wallpaper::WallpaperRotator;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::settings::Settings;
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wpe::properties::WpeVideoProps;
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
    Ok(get_current_wallpaper_target_from_settings()
        .await?
        .map(|target| target.path))
}

/// 当前壁纸的完整目标：窗口前端据此决定播图还是播视频。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperTarget {
    pub id: String,
    pub path: String,
    /// `images.type`（如 `video/mp4`、`x-wpe/video`、`x-wpe/web`）。
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    /// 浏览器兼容副本：普通视频仅在不可直接播放时有值；WPE 视频始终有值；WPE 网页为空
    /// （页面经 `/wpe/<id>/` 加载）。
    pub compatible_path: Option<String>,
    /// 目录型 WPE 视频壁纸的作者默认播放属性；其它类型为 null。
    pub wpe_video: Option<WpeVideoProps>,
}

pub async fn get_current_wallpaper_target_from_settings(
) -> Result<Option<WallpaperTarget>, String> {
    let Some(id) = Settings::global().get_current_wallpaper_image_id() else {
        return Ok(None);
    };
    let img = Storage::find_image_by_id(&id).map_err(|e| format!("Storage error: {}", e))?;
    let Some(info) = img else {
        return Ok(None);
    };
    Ok(Some(build_wallpaper_target(info).await))
}

/// 由图片行组装壁纸目标（当前壁纸、图库预览、应用背景共用）：
/// WPE 视频的作者属性取自图片 metadata（导入时写入的 `project.json` 原文），不重读磁盘——
/// 用户属性以后也作为同一份元数据里的一段合并进来；其它类型 `wpe_video` 为 None。
async fn build_wallpaper_target(info: ImageInfo) -> WallpaperTarget {
    let wpe_video = if kabegame_core::media::image_type::is_wpe_video_type(info.media_type.as_deref())
    {
        let image_id = info.id.clone();
        let raw = tokio::task::spawn_blocking(move || Storage::global().get_metadata(&image_id))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        Some(
            raw.map(|raw| kabegame_core::wpe::properties::resolve_video_props_from_raw(&raw))
                .unwrap_or_default(),
        )
    } else {
        None
    };

    WallpaperTarget {
        id: info.id,
        path: info.local_path,
        media_type: info.media_type,
        compatible_path: info.compatible_path,
        wpe_video,
    }
}

/// 图库预览 / 应用背景按 id 取壁纸目标，与当前壁纸共用 [`build_wallpaper_target`]，
/// 所以预览画布与桌面拿到的是同一份目标结构。行不存在返回 None。
#[tauri::command]
pub async fn get_wallpaper_target_for_image(
    image_id: String,
) -> Result<Option<WallpaperTarget>, String> {
    let Some(info) =
        Storage::find_image_by_id(&image_id).map_err(|e| format!("Storage error: {}", e))?
    else {
        return Ok(None);
    };
    Ok(Some(build_wallpaper_target(info).await))
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
    let media_type = info.media_type.clone();
    let local_path = info.local_path;

    // 目录型 WPE 壁纸第一阶段只支持窗口模式；用与视频相同的错误码让前端引导切换模式。
    if kabegame_core::media::image_type::is_wpe_type(media_type.as_deref())
        && settings.get_wallpaper_mode() != "window"
    {
        return Err("REQUIRES_WINDOW_MODE".to_string());
    }

    let requires_window_mode =
        kabegame_core::media::image_type::requires_window_mode(Path::new(&local_path));
    if requires_window_mode {
        let current_mode = settings.get_wallpaper_mode();
        if current_mode != "window" {
            return Err("REQUIRES_WINDOW_MODE".to_string());
        }
    }

    let requires_plugin_mode =
        kabegame_core::media::image_type::requires_plugin_mode(Path::new(&local_path));
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
    let ids = vec![image_id];
    if Storage::global()
        .update_image_last_set_wallpaper_at(&ids[0], now)
        .is_ok()
    {
        GlobalEmitter::global()
            .emit_image_fields(&ids, serde_json::json!({ "lastSetWallpaperAt": now }));
    }
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
pub fn get_wallpaper_capabilities() -> Result<WallpaperCapabilities, String> {
    Ok(WallpaperController::global().capabilities())
}

#[tauri::command]
pub async fn get_current_wallpaper_path<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    get_current_wallpaper_path_from_settings(&app).await
}

/// 壁纸窗口使用的当前壁纸目标（含类型、兼容副本与 WPE 视频属性）。
#[tauri::command]
pub async fn get_current_wallpaper_target<R: tauri::Runtime>(
    _app: AppHandle<R>,
) -> Result<Option<WallpaperTarget>, String> {
    get_current_wallpaper_target_from_settings().await
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationStartResult {
    pub started: bool,
    /// 实际使用的轮播路径
    pub path: Option<String>,
    /// 原路径 count / 取行出错，已回落默认随机路径
    pub fallback: bool,
    pub warning: Option<String>,
}

/// 开启时直接拉起轮播线程（位置沿用设置里保存的值，路径不变就接着上次的下一张）；
/// 拉起失败（如轮播路径下没有图片）回滚为关闭并返回错误。
#[tauri::command]
pub async fn set_wallpaper_rotation_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        reject_if_wallpaper_disabled()?;
    }
    let settings = Settings::global();
    settings
        .set_wallpaper_rotation_enabled(enabled)
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();
    if !enabled {
        rotator.stop();
        return Ok(());
    }
    if let Err(e) = rotator.ensure_running().await {
        let _ = settings.set_wallpaper_rotation_enabled(false);
        return Err(format!("启动轮播失败: {}", e));
    }
    Ok(())
}

/// 设置轮播来源 PathQL 路径（不含分页尾）；空串表示默认全画廊随机路径。
/// 先校验路径能 count、非空且能取到图片行。路径变化时设置层把位置置为
/// `WALLPAPER_ROTATION_FROM_START`，这里随即唤醒轮播立刻切到新路径的第 1 张（不论轮播是否开启），
/// 之后按当前壁纸续接。
#[tauri::command]
pub async fn set_wallpaper_rotation_path(path: String) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let normalized = kabegame_core::wallpaper_rotation::normalize_path(&path);
    if let Some(p) = normalized.clone() {
        let mode = settings.get_wallpaper_mode();
        tokio::task::spawn_blocking(move || {
            crate::wallpaper::rotator::validate_rotation_path(&p, &mode)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let changed = settings.get_wallpaper_rotation_path() != normalized;
    settings
        .set_wallpaper_rotation_path(normalized)
        .map_err(|e| format!("Settings error: {}", e))?;
    let rotator = WallpaperRotator::global();
    if changed {
        // 线程运行中：由线程切换并重置计时器；未运行：在这里直接切一次
        rotator.rotate().await?;
    }

    // 已开启时 ensure_running 会重置计时器，下一次自动切换从现在起算
    if settings.get_wallpaper_rotation_enabled() {
        rotator
            .ensure_running()
            .await
            .map_err(|e| format!("启动轮播失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn start_wallpaper_rotation() -> Result<RotationStartResult, String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    if !settings.get_wallpaper_rotation_enabled() {
        return Err("壁纸轮播未启用".to_string());
    }
    let before = settings.get_wallpaper_rotation_path();
    WallpaperRotator::global().ensure_running().await?;
    let path = settings.get_wallpaper_rotation_path();
    // 原先有路径、启动后被换掉 = count 出错回落了默认路径
    let fallback = before.is_some() && before != path;
    Ok(RotationStartResult {
        started: true,
        path,
        fallback,
        warning: fallback.then(|| "原轮播路径不可用，已回退到画廊随机轮播".to_string()),
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

/// 把后端切到 `mode`：新后端 `init()`，旧后端 `cleanup()`。
///
/// 后端资源的存续与 `wallpaperMode` **同寿命**，与"当前有没有壁纸"无关，因此
/// `set_wallpaper_mode` 的**每一条**成功路径都必须调用本函数——包括无当前壁纸的
/// 早返回。`WindowWallpaperManager::set_wallpaper_path` 已是 no-op，不再兜底懒挂载：
/// 切入 window 时漏掉 `init()` 就永远建不出窗口；切出 window 时漏掉 `cleanup()`
/// 会留下一个孤儿壁纸窗口继续挂在桌面上。
///
/// 反过来，本函数必须在所有可能**中止**切换的检查之后调用，否则中止会留下半切换状态。
fn apply_backend_lifecycle(
    controller: &'static WallpaperController,
    old_mode: &str,
    mode: &str,
) -> Result<(), String> {
    tracing::debug!("set_wallpaper_mode: 开始应用模式 {}", mode);
    controller
        .manager_for_mode(mode)
        .init()
        .map_err(|e| format!("init 失败: {}", e))?;

    if old_mode == "window" && mode != "window" {
        controller
            .manager_for_mode("window")
            .cleanup()
            .unwrap_or_else(|e| tracing::warn!("清理 window 资源失败: {}", e));
    }
    #[cfg(target_os = "linux")]
    if old_mode == "plasma-plugin" && mode != "plasma-plugin" {
        controller
            .manager_for_mode("plasma-plugin")
            .cleanup()
            .unwrap_or_else(|e| tracing::warn!("清理 plasma-plugin 资源失败: {}", e));
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

    let target = controller.manager_for_mode(&mode);

    let current_wallpaper = match get_current_wallpaper_path_from_settings(&app).await {
        Ok(Some(p)) => p,
        _ => {
            // 无当前壁纸：内容无从谈起，但后端仍必须切换到位（见
            // `apply_backend_lifecycle` 的说明），否则切入 window 永远建不出窗口、
            // 切出 window 会留下孤儿窗口。
            apply_backend_lifecycle(controller, &old_mode, &mode)?;
            settings.set_wallpaper_mode(mode.clone())?;
            crate::wallpaper::rotator::relocate_position_for_mode(&mode);
            return Ok(());
        }
    };

    let current_cleaned = current_wallpaper
        .trim()
        .trim_start_matches(r"\\?\")
        .to_string();

    // 目录型 WPE 壁纸只在窗口模式有内容；切到原生 / 插件模式时换成画廊里可用的兜底图。
    let current_is_wpe = Settings::global()
        .get_current_wallpaper_image_id()
        .and_then(|id| Storage::find_image_by_id(&id).ok().flatten())
        .is_some_and(|img| {
            kabegame_core::media::image_type::is_wpe_type(img.media_type.as_deref())
        });

    let resolved_wallpaper = if current_is_wpe && mode != "window" {
        match pick_random_gallery_wallpaper(&mode) {
            Some(p) => {
                tracing::warn!(
                    "set_wallpaper_mode: 当前壁纸是 WPE 目录型壁纸，切到 {} 模式改用兜底图片: {}",
                    mode, p
                );
                p
            }
            None => {
                if was_running {
                    let _ = rotator.start().await;
                }
                return Err(
                    "当前壁纸是 Wallpaper Engine 壁纸，只能使用窗口模式；画廊中没有其它可用图片可兜底。"
                        .to_string(),
                );
            }
        }
    } else if Path::new(&current_cleaned).exists() {
        current_cleaned.clone()
    } else if let Some(p) = pick_random_gallery_wallpaper(&mode) {
        tracing::warn!(
            "set_wallpaper_mode: 当前壁纸文件不存在，将从画廊选择兜底图片: {} (原路径: {})",
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
                tracing::warn!(
                    "set_wallpaper_mode: swap_style_transition_for_mode_switch 失败: {}",
                    e
                );
                (cur_style.clone(), cur_transition.clone())
            }
        };

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

    // 放在所有可能中止切换的检查之后：中止时不应留下半切换状态
    // （窗口已建但模式没落 / 窗口已毁但模式还是 window）。
    apply_backend_lifecycle(controller, &old_mode, &mode)?;

    target.set_wallpaper_path(&resolved_wallpaper).await?;
    target.set_style(&style_to_apply).await?;
    if rotation_enabled {
        target.set_transition(&transition_to_apply).await?;
    }

    settings.set_wallpaper_mode(mode.clone())?;
    // 有效路径随模式加 / 去媒体过滤：按当前壁纸 id 重定位，保持「下一张」语义
    crate::wallpaper::rotator::relocate_position_for_mode(&mode);

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
        // 重新启用：先把当前模式的后端拉起来，再恢复壁纸内容。
        //
        // 顺序不可颠倒，且这一步不可省：上面 `disabled` 分支的 `cleanup()` 已经把
        // 壁纸窗口**销毁**了（不是隐藏），而 `init_wallpaper_on_startup()` 终点是
        // `set_wallpaper_path()` —— 它在 window 模式下是 no-op，不会兜底建窗。
        // 少了这行，关掉再打开壁纸就永远显示不出来。
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        if let Err(e) = WallpaperController::global().init() {
            tracing::warn!("set_wallpaper_disabled: 初始化壁纸后端失败: {}", e);
        }

        // 恢复上次壁纸（复用启动恢复逻辑）
        if let Err(e) = crate::startup::init_wallpaper_on_startup().await {
            tracing::warn!("set_wallpaper_disabled: 恢复壁纸失败: {}", e);
        }
        // 之前开启过轮播则恢复轮播
        if settings.get_wallpaper_rotation_enabled() {
            if let Err(e) = rotator.ensure_running().await {
                tracing::warn!("set_wallpaper_disabled: 恢复轮播失败: {}", e);
            }
        }
    }

    Ok(())
}
