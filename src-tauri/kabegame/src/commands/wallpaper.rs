// 壁纸相关命令和函数

use crate::wallpaper::manager::{
    DisplayMode, Placement, WallpaperCapabilities, WallpaperController, WindowAssignment,
};
use crate::wallpaper::rotator::pick_random_gallery_wallpaper;
use crate::wallpaper::screens::{self, ScreenInfo};
use crate::wallpaper::WallpaperRotator;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::settings::{
    screen_id_of_target, Settings, WallpaperTargetConfig, WallpaperTargets,
};
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wpe::properties::WpeVideoProps;
use std::path::Path;

/// 「打开壁纸」关掉时，对用户主动发起的壁纸操作返回的提示文案。
/// 直接作为错误信息透传给前端展示（不使用专用错误码）。
const WALLPAPER_DISABLED_MSG: &str = "壁纸功能已关闭，请先在设置中重新开启";

/// 若已关闭壁纸功能，则返回错误以拒绝该操作。
fn reject_if_wallpaper_disabled() -> Result<(), String> {
    if !Settings::global().get_wallpaper_enabled() {
        return Err(WALLPAPER_DISABLED_MSG.to_string());
    }
    Ok(())
}

/// 把命令的可选 `target` 解析成活跃目标的 id：缺省为当前显示器模式的默认目标，
/// 指定的目标不在活跃集合里时报错。
fn resolve_target_id(target: Option<&str>) -> Result<String, String> {
    WallpaperController::global()
        .resolve_target(target)
        .map(|(id, _)| id)
}

/// 「当前壁纸」类命令的可选 `target`：没带时，调用方若是壁纸窗口就取该窗口的布置目标
/// （每个壁纸窗口显示的是自己那块屏的目标，不一定是默认目标），否则保持缺省（默认目标）。
fn target_for_caller<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    target: Option<String>,
) -> Option<String> {
    target.filter(|id| !id.trim().is_empty()).or_else(|| {
        WallpaperController::global()
            .window_assignment(webview.label())
            .map(|assignment| assignment.target_id)
    })
}

/// 读-改-写一个目标的配置（一次 `setting-change`）。活跃目标在算布局时已经落盘，这里的默认值只是兜底。
fn update_target(
    target_id: &str,
    f: impl FnOnce(&mut WallpaperTargetConfig),
) -> Result<(), String> {
    Settings::global()
        .update_wallpaper_target(target_id, WallpaperTargetConfig::default, f)
        .map_err(|e| format!("Settings error: {}", e))
}

pub async fn get_current_wallpaper_path_from_settings(
    target: Option<&str>,
) -> Result<Option<String>, String> {
    Ok(get_current_wallpaper_target_from_settings(target)
        .await?
        .map(|target| target.path))
}

/// 当前壁纸的完整目标：窗口前端据此决定播图还是播视频。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperTarget {
    pub id: String,
    pub path: String,
    /// `images.type`（如 `video/mp4`、`x-wpe/video`、`x-wpe/web`、`x-wpe/scene`）。
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    /// 浏览器兼容副本：普通视频仅在不可直接播放时有值；WPE 视频始终有值；WPE 网页为空
    /// （页面以入口 `file://` 加载，见 `web_entry`）。
    pub compatible_path: Option<String>,
    /// 目录型 WPE 视频壁纸的作者默认播放属性；其它类型为 null。
    pub wpe_video: Option<WpeVideoProps>,
    /// 网页壁纸（`x-wpe/web`）的入口 `file://`，由 `wallpaper::web_entry` 现算：图库预览与桌面壁纸窗口的
    /// `WallpaperStage` 直接把它赋给 web 层 iframe 的 `src`。其它类型、Android、读 `project.json` 失败为 None。
    pub web_entry: Option<String>,
    /// 场景壁纸（`x-wpe/scene`）解析内置资源的 `<WPE 安装目录>/assets` 绝对路径，按顺序查找
    /// （`wpe::discover::scene_asset_dirs`，来自设置 `wpeEngineDir`）。其它类型、Android、没找到安装目录为空。
    pub scene_assets: Vec<String>,
    /// 场景壁纸（`x-wpe/scene`）退回用的预览图：行的 `thumbnail_path`（导入时就是作者的 `preview.*`）。
    /// 不能渲染（含超时）时 `WallpaperStage` 才显示它，编译期间保持加载态；其它类型、缩略图为空时为 None。
    pub preview_path: Option<String>,
}

/// 壁纸目标 `target`（缺省为默认目标）的当前壁纸。
pub async fn get_current_wallpaper_target_from_settings(
    target: Option<&str>,
) -> Result<Option<WallpaperTarget>, String> {
    let target_id = resolve_target_id(target)?;
    let Some(id) = Settings::global()
        .get_wallpaper_target(&target_id)
        .and_then(|config| config.current_image_id)
    else {
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
pub(crate) async fn build_wallpaper_target(info: ImageInfo) -> WallpaperTarget {
    let wpe_video =
        if kabegame_core::media::image_type::is_wpe_video_type(info.media_type.as_deref()) {
            let image_id = info.id.clone();
            let raw =
                tokio::task::spawn_blocking(move || Storage::global().get_metadata(&image_id))
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
    let web_entry = web_entry_of(&info).await;
    let scene_assets = scene_assets_of(&info).await;
    let preview_path = scene_preview_of(&info);

    WallpaperTarget {
        id: info.id,
        path: info.local_path,
        media_type: info.media_type,
        compatible_path: info.compatible_path,
        wpe_video,
        web_entry,
        scene_assets,
        preview_path,
    }
}

/// 场景壁纸退回用的预览图（行的缩略图）；其它类型不填。缩略图为空、或作者没有 preview 时回落成的
/// 壁纸目录本身（与 `local_path` 相同）都不填。
fn scene_preview_of(info: &ImageInfo) -> Option<String> {
    let kind = kabegame_core::media::image_type::wpe_kind(info.media_type.as_deref());
    if kind.as_deref() != Some("scene") {
        return None;
    }
    let thumbnail = info.thumbnail_path.trim();
    (!thumbnail.is_empty() && thumbnail != info.local_path.trim()).then(|| thumbnail.to_string())
}

/// 网页壁纸的入口 `file://`（读一个小的 `project.json`，放 blocking 线程）；其它类型不读盘。
async fn web_entry_of(info: &ImageInfo) -> Option<String> {
    let kind = kabegame_core::media::image_type::wpe_kind(info.media_type.as_deref());
    if kind.as_deref() != Some("web") {
        return None;
    }
    let dir = std::path::PathBuf::from(&info.local_path);
    match tokio::task::spawn_blocking(move || crate::wallpaper::web_entry(&dir)).await {
        Ok(Ok(entry)) => entry.map(|(_, entry)| entry.to_string()),
        Ok(Err(error)) => {
            tracing::warn!("网页壁纸 {} 没有可用入口: {error}", info.id);
            None
        }
        Err(error) => {
            tracing::warn!("读取网页壁纸 {} 入口失败: {error}", info.id);
            None
        }
    }
}

/// 场景壁纸的 `<WPE 安装目录>/assets`（发现 Steam 库要读注册表与 `libraryfolders.vdf`，放 blocking 线程）；
/// 其它类型不读盘。
#[cfg(feature = "wpe")]
async fn scene_assets_of(info: &ImageInfo) -> Vec<String> {
    let kind = kabegame_core::media::image_type::wpe_kind(info.media_type.as_deref());
    if kind.as_deref() != Some("scene") {
        return Vec::new();
    }
    let dirs = tokio::task::spawn_blocking(kabegame_core::wpe::discover::scene_asset_dirs)
        .await
        .unwrap_or_default();
    if dirs.is_empty() {
        tracing::warn!(
            "场景壁纸 {} 找不到 WPE 安装目录，可在壁纸设置里指定",
            info.id
        );
    }
    dirs.into_iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}

/// 没有 `wpe` feature 就没有发现逻辑，场景行只显示预览图。
#[cfg(not(feature = "wpe"))]
async fn scene_assets_of(_info: &ImageInfo) -> Vec<String> {
    Vec::new()
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

/// 把一张图设为壁纸目标 `target`（缺省为默认目标）的壁纸。
#[tauri::command]
pub async fn set_wallpaper_by_image_id(
    image_id: String,
    target: Option<String>,
) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let controller = WallpaperController::global();
    let (target_id, placement) = controller.resolve_target(target.as_deref())?;

    let image =
        Storage::find_image_by_id(&image_id).map_err(|e| format!("Storage error: {}", e))?;

    let Some(info) = image else {
        return Err("图片不存在".to_string());
    };
    let media_type = info.media_type.clone();
    let local_path = info.local_path;

    // 目录型 WPE 壁纸第一阶段只支持窗口模式；用与视频相同的错误码让前端引导切换模式。
    // Linux 没有窗口模式，引导过去也切不了，直接报错。
    if kabegame_core::media::image_type::is_wpe_type(media_type.as_deref())
        && settings.get_wallpaper_mode() != "window"
    {
        return Err(if cfg!(target_os = "linux") {
            "Linux 暂不支持把 Wallpaper Engine 壁纸设为桌面".to_string()
        } else {
            "REQUIRES_WINDOW_MODE".to_string()
        });
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
        let _ = update_target(&target_id, |config| config.set_current_image_id(None));
        return Err("图片文件不存在".to_string());
    }

    // 单张设置不带过渡（过渡只属于轮播）
    let style = controller.effective_style(
        &settings
            .get_wallpaper_target(&target_id)
            .unwrap_or_default(),
    );
    controller
        .active_manager()
        .await?
        .set_wallpaper(&local_path, &style, "none", &placement)
        .await?;

    update_target(&target_id, |config| {
        config.set_current_image_id(Some(image_id.clone()))
    })?;

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

/// 壁纸目标 `target` 的当前壁纸图片 id；`target` 缺省时壁纸窗口取自己的布置目标，其余调用方取默认目标。
#[tauri::command]
pub fn get_current_wallpaper_image_id<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    target: Option<String>,
) -> Result<Option<String>, String> {
    let target = target_for_caller(&webview, target);
    let target_id = resolve_target_id(target.as_deref())?;
    Ok(Settings::global()
        .get_wallpaper_target(&target_id)
        .and_then(|config| config.current_image_id))
}

/// 清空壁纸目标 `target` 的当前壁纸；`target` 缺省规则同 [`get_current_wallpaper_image_id`]。
#[tauri::command]
pub fn clear_current_wallpaper_image_id<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    target: Option<String>,
) -> Result<(), String> {
    let target = target_for_caller(&webview, target);
    let target_id = resolve_target_id(target.as_deref())?;
    update_target(&target_id, |config| config.set_current_image_id(None))
}

#[tauri::command]
pub fn get_wallpaper_capabilities() -> Result<WallpaperCapabilities, String> {
    Ok(WallpaperController::global().capabilities())
}

/// 调用方壁纸窗口的布置（显示哪个目标、出不出声）：按调用方 label 查，壁纸窗口启动时取一次，之后变化时
/// 后端向该窗口发 `wallpaper-assignment`。调用方不是壁纸窗口、或窗口不在册时为 None。
///
/// 必须是 async：同步命令在主线程上执行，而读窗口表要拿的锁不能在主线程上等。
#[tauri::command]
pub async fn get_wallpaper_window_assignment<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<Option<WindowAssignment>, String> {
    Ok(WallpaperController::global().window_assignment(webview.label()))
}

/// 全部壁纸目标的配置（目标 id → 配置），与 `setting-change` 里 `wallpaperTargets` 的形状相同。
#[tauri::command]
pub fn get_wallpaper_targets() -> WallpaperTargets {
    Settings::global().get_wallpaper_targets()
}

/// 当前在线的显示器（主屏在前）；没有屏幕信息的平台为空。变化时另发 `wallpaper-screens-change`。
#[tauri::command]
pub fn list_wallpaper_screens() -> Vec<ScreenInfo> {
    screens::screens()
}

/// 切换显示器模式；该模式在当前壁纸模式下不可用时报错（错误信息是不可用的原因）。
#[tauri::command]
pub async fn set_wallpaper_display_mode(mode: DisplayMode) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    WallpaperController::global().set_display_mode(mode).await
}

/// 设置逐屏独立下的默认显示器：屏必须在线。空串表示清除（默认回到主屏）。
#[tauri::command]
pub fn set_wallpaper_default_screen(screen_id: String) -> Result<(), String> {
    let screen_id = screen_id.trim();
    if screen_id.is_empty() {
        return Settings::global().set_wallpaper_default_screen(None);
    }
    if !screens::screens()
        .iter()
        .any(|screen| screen.id == screen_id)
    {
        return Err("该显示器不在线".to_string());
    }
    Settings::global().set_wallpaper_default_screen(Some(screen_id.to_string()))
}

/// 忘记一个已断开显示器的目标配置：只允许删不在活跃集合里的 `screen:*` 目标。
#[tauri::command]
pub fn forget_wallpaper_target(target_id: String) -> Result<(), String> {
    if screen_id_of_target(&target_id).is_none() {
        return Err("只能忘记显示器目标".to_string());
    }
    let layout = WallpaperController::global().layout();
    if layout.placement_of(&target_id).is_some() {
        return Err("该显示器仍在使用，不能忘记".to_string());
    }
    Settings::global().remove_wallpaper_target(&target_id)
}

/// 壁纸目标 `target` 的当前壁纸路径；`target` 缺省规则同 [`get_current_wallpaper_image_id`]。
#[tauri::command]
pub async fn get_current_wallpaper_path<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    target: Option<String>,
) -> Result<Option<String>, String> {
    let target = target_for_caller(&webview, target);
    get_current_wallpaper_path_from_settings(target.as_deref()).await
}

/// 壁纸窗口使用的当前壁纸目标（含类型、兼容副本与 WPE 视频属性）；`target` 缺省时壁纸窗口取自己的布置目标，
/// 其余调用方取默认目标。
#[tauri::command]
pub async fn get_current_wallpaper_target<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    target: Option<String>,
) -> Result<Option<WallpaperTarget>, String> {
    let target = target_for_caller(&webview, target);
    get_current_wallpaper_target_from_settings(target.as_deref()).await
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

/// 设置壁纸目标 `target`（缺省为默认目标）的轮播来源 PathQL 路径（不含分页尾）；空串表示默认全画廊随机路径。
/// 先校验路径能 count、非空且能取到图片行。路径变化时设置层把该目标的位置置为
/// `WALLPAPER_ROTATION_FROM_START`，这里随即唤醒轮播立刻把这个目标切到新路径的第 1 张（不论轮播是否开启），
/// 之后按当前壁纸续接；其它目标不动。
#[tauri::command]
pub async fn set_wallpaper_rotation_path(
    path: String,
    target: Option<String>,
) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let target_id = resolve_target_id(target.as_deref())?;
    let normalized = kabegame_core::wallpaper_rotation::normalize_path(&path);
    if let Some(p) = normalized.clone() {
        let mode = settings.get_wallpaper_mode();
        tokio::task::spawn_blocking(move || {
            crate::wallpaper::rotator::validate_rotation_path(&p, &mode)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let mut changed = false;
    update_target(&target_id, |config| {
        changed = config.set_rotation_path(normalized);
    })?;
    let rotator = WallpaperRotator::global();
    if changed {
        // 线程运行中：由线程切换并重置计时器；未运行：在这里直接切一次
        rotator.rotate(Some(&target_id)).await?;
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
    // 轮播是全局的；结果里的路径与回落只报默认目标的
    let target_id = resolve_target_id(None)?;
    let rotation_path = || {
        settings
            .get_wallpaper_target(&target_id)
            .and_then(|config| config.rotation_path)
    };
    let before = rotation_path();
    WallpaperRotator::global().ensure_running().await?;
    let path = rotation_path();
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

/// 设置壁纸目标 `target`（缺省为默认目标）在当前壁纸模式下的样式，并把它的当前壁纸重新输出一次。
/// 当前组合下样式是全屏共用的（`sharedStyle`）时，对全部活跃目标写同一个值。
#[tauri::command]
pub async fn set_wallpaper_style(style: String, target: Option<String>) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let controller = WallpaperController::global();
    let target_id = resolve_target_id(target.as_deref())?;
    let mode = settings.get_wallpaper_mode();
    let display = controller.display_mode();
    let manager = controller.active_manager().await?;
    if !manager
        .supported_styles(display)
        .iter()
        .any(|option| option.value == style)
    {
        return Err(format!("当前壁纸模式不支持该样式: {style}"));
    }

    let affected = if manager.shared_style(display) {
        controller.layout().target_ids()
    } else {
        vec![target_id]
    };
    settings.update_all_wallpaper_targets(|id, config| {
        if affected.iter().any(|affected_id| affected_id == id) {
            config.style.insert(mode.clone(), style.clone());
        }
    })?;
    for target_id in &affected {
        if let Err(e) = controller.reapply_target(target_id).await {
            tracing::warn!("set_wallpaper_style: 重新输出目标 {target_id} 失败: {e}");
        }
    }
    Ok(())
}

/// 设置壁纸目标 `target`（缺省为默认目标）在当前壁纸模式下的轮播过渡；
/// 轮播开着且过渡不是 `none` 时把这个目标切一张演示一次。
#[tauri::command]
pub async fn set_wallpaper_rotation_transition(
    transition: String,
    target: Option<String>,
) -> Result<(), String> {
    reject_if_wallpaper_disabled()?;
    let settings = Settings::global();
    let controller = WallpaperController::global();
    let target_id = resolve_target_id(target.as_deref())?;
    let mode = settings.get_wallpaper_mode();
    if !controller
        .active_manager()
        .await?
        .supported_transitions(controller.display_mode())
        .iter()
        .any(|option| option.value == transition)
    {
        return Err(format!("当前壁纸模式不支持该过渡: {transition}"));
    }
    let enabled = settings.get_wallpaper_rotation_enabled();

    update_target(&target_id, |config| {
        config.transition.insert(mode, transition.clone());
    })?;

    if enabled && transition != "none" {
        WallpaperRotator::global().rotate(Some(&target_id)).await?;
    }
    Ok(())
}

/// 把后端切到 `mode`：新后端 `init()`，旧后端 `cleanup()`。
///
/// 后端资源的存续与 `wallpaperMode` **同寿命**，与"当前有没有壁纸"无关，因此
/// `set_wallpaper_mode` 的**每一条**成功路径都必须调用本函数——包括无当前壁纸的
/// 早返回。`WindowWallpaperManager::set_wallpaper` 不兜底懒挂载（窗口不存在时什么都不做）：
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

/// 切换壁纸模式（原生 / 窗口 / 插件）。
///
/// 当前显示器模式在新模式下不可用时先回落 `multiple`；随后对新布局里的每个活跃目标做
/// 「WPE / 文件不存在时兜底换图」并用新模式下的样式、过渡输出一次。任何一个目标无图可用都中止切换，
/// 中止时不留下半切换状态（后端生命周期在所有检查之后才动）。
#[tauri::command]
pub async fn set_wallpaper_mode(mode: String) -> Result<(), String> {
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

    let rotation_enabled = settings.get_wallpaper_rotation_enabled();
    let backend = controller.manager_for_mode(&mode);

    // 新模式下的布局：显示器模式回落时，缺的目标从切换前的默认目标复制
    let old_layout = controller.layout();
    let new_display = controller.display_mode_for(&mode);
    let seed = settings.get_wallpaper_target(&old_layout.default_target);
    let layout = controller.layout_for(new_display, seed.as_ref());

    #[cfg(not(target_os = "linux"))]
    let is_plugin_mode = false;
    #[cfg(target_os = "linux")]
    let is_plugin_mode = mode == "plasma-plugin";

    // 逐目标确定新模式下要显示的文件；没有当前壁纸的目标内容无从谈起，跳过
    let mut outputs: Vec<(String, Placement, String)> = Vec::new();
    for (target_id, placement) in &layout.targets {
        let current = settings
            .get_wallpaper_target(target_id)
            .and_then(|config| config.current_image_id)
            .and_then(|id| Storage::find_image_by_id(&id).ok().flatten());
        let Some(current) = current else {
            continue;
        };
        let current_wallpaper = current.local_path;
        let current_cleaned = current_wallpaper
            .trim()
            .trim_start_matches(r"\\?\")
            .to_string();

        // 目录型 WPE 壁纸只在窗口模式有内容；切到原生 / 插件模式时换成画廊里可用的兜底图。
        let current_is_wpe =
            kabegame_core::media::image_type::is_wpe_type(current.media_type.as_deref());

        let resolved_wallpaper = if current_is_wpe && mode != "window" {
            match pick_random_gallery_wallpaper(&mode) {
                Some(p) => {
                    tracing::warn!(
                        "set_wallpaper_mode: 当前壁纸是 WPE 目录型壁纸，切到 {} 模式改用兜底图片: {}",
                        mode,
                        p
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
                p,
                current_wallpaper
            );
            p
        } else {
            current_cleaned.clone()
        };

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
        outputs.push((target_id.clone(), placement.clone(), resolved_wallpaper));
    }

    // 样式 / 过渡按壁纸模式各记各的：目标在新模式名下还没有值（第一次进入）时才把旧模式的值带过去。
    // 必须排在建窗之前：窗口后端 init 会阻塞到壁纸页面初始化完成，页面初始化时就读目标配置，
    // 晚写的话新窗口会先按旧的窗口样式渲染、再被事件纠正。
    if let Err(e) = controller.carry_style_to_mode(&old_mode, &mode) {
        tracing::warn!("set_wallpaper_mode: 沿用样式 / 过渡失败: {}", e);
    }
    if new_display != old_layout.display_mode {
        settings.set_wallpaper_display_mode(new_display.as_str())?;
    }

    // 放在所有可能中止切换的检查之后：中止时不应留下半切换状态
    // （窗口已建但模式没落 / 窗口已毁但模式还是 window）。
    apply_backend_lifecycle(controller, &old_mode, &mode)?;

    for (target_id, placement, path) in &outputs {
        let config = settings.get_wallpaper_target(target_id).unwrap_or_default();
        backend
            .set_wallpaper(
                path,
                &controller.effective_style_in(&mode, new_display, &config),
                &controller.effective_transition_in(&mode, new_display, &config),
                placement,
            )
            .await?;
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
pub fn get_wallpaper_enabled() -> bool {
    Settings::global().get_wallpaper_enabled()
}

/// 切换「打开壁纸」开关，并执行副作用：
/// - 关掉时：停止轮播，隐藏壁纸窗口（window 模式）/ 切回 org.kde.image（plasma-plugin 模式）；
///   native 模式保持系统壁纸现状不动（无法自动还原）。保留各目标的当前壁纸。
/// - 打开时：复用启动逻辑逐目标恢复上次壁纸，并在轮播启用时恢复轮播。
#[tauri::command]
pub async fn set_wallpaper_enabled(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();
    settings
        .set_wallpaper_enabled(enabled)
        .map_err(|e| format!("Settings error: {}", e))?;

    let rotator = WallpaperRotator::global();

    if !enabled {
        // 停止轮播
        rotator.stop();
        // 隐藏/还原各模式（保留各目标的当前壁纸）
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
        // 顺序不可颠倒，且这一步不可省：上面关掉分支的 `cleanup()` 已经把
        // 壁纸窗口**销毁**了（不是隐藏），而 `init_wallpaper_on_startup()` 终点是
        // `set_wallpaper()` —— 它在 window 模式下不会兜底建窗。
        // 少了这行，关掉再打开壁纸就永远显示不出来。
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        if let Err(e) = WallpaperController::global().init() {
            tracing::warn!("set_wallpaper_enabled: 初始化壁纸后端失败: {}", e);
        }

        // 恢复上次壁纸（复用启动恢复逻辑）
        if let Err(e) = crate::startup::init_wallpaper_on_startup().await {
            tracing::warn!("set_wallpaper_enabled: 恢复壁纸失败: {}", e);
        }
        // 之前开启过轮播则恢复轮播
        if settings.get_wallpaper_rotation_enabled() {
            if let Err(e) = rotator.ensure_running().await {
                tracing::warn!("set_wallpaper_enabled: 恢复轮播失败: {}", e);
            }
        }
    }

    Ok(())
}
