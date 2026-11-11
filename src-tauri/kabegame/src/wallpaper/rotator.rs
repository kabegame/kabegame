//! 壁纸轮播：每个壁纸目标各读自己的一个 PathQL 路径，按持久化位置逐张前进。
//!
//! 开关与间隔是全局的，一个 ticker：到点时对当前所有活跃目标各切一张，手动切换可以只切某个目标。
//! 活跃目标由 `WallpaperController::layout()` 给出，这里只按目标 id 调度。
//!
//! 一个目标的一次切换：`count(有效路径)` → 出错落回默认随机路径 → 定起点（该目标当前壁纸 id 在路径里的
//! 下一张，找不到才用持久化位置）→ 取该位置的一张（页大小 1）→ 设壁纸后写回该目标的 `currentImageId`
//! 与 `位置 + 1`。换路径时设置层把位置置为 `WALLPAPER_ROTATION_FROM_START`（-1），下一次从第 1 张
//! 开始、不按当前 id 定位；`set_wallpaper_rotation_path` 命令随即唤醒轮播切这一次。路径与有效路径的约定见
//! `kabegame_core::wallpaper_rotation`，整体说明见 `cocs/wallpaper/ROTATION_PATHQL.md`。

use super::manager::WallpaperController;
use async_trait::async_trait;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::providers::{count_at, images_at, query_fetch};
use kabegame_core::settings::{Settings, WallpaperTargetConfig, WALLPAPER_ROTATION_FROM_START};
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wallpaper_rotation as rotation_path;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

/// 从当前时间戳生成均匀分布的随机索引（splitmix64 位混合）。
/// 避免直接 `nanos % len`：Windows 上 nanos 精度为 100ns（始终是 100 的倍数），
/// 当 len 整除 100 时取模结果恒为 0。
pub(crate) fn random_index(len: usize) -> usize {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut x = nanos as u64;
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58476d1ce4e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d049bb133111eb);
    x ^= x >> 31;
    (x as usize) % len
}

/// 文件是否还在。媒体类型不在这里判断：原生模式的有效路径已带 `_kb_fc/media-type/image`
/// （见 `rotation_path::effective_path`），前端「用当前视图轮播」的视频跳过提示与此对应。
/// Android 的 `content://` 无法用 `Path::exists` 判断，视为存在。
pub(crate) fn wallpaper_file_available(img: &ImageInfo) -> bool {
    img.local_path.starts_with("content://") || Path::new(&img.local_path).exists()
}

/// 本轮解析出的轮播来源。
struct RotationSource {
    /// 设置里的原始路径
    path: String,
    /// 按壁纸模式加过媒体过滤的路径，count 与取行都用它
    effective: String,
    count: u64,
    /// count / 取行出错后改用了默认随机路径
    fallback: bool,
    /// 目录型 WPE 壁纸能否参与：只有窗口模式能渲染，原生 / Plasma 插件逐张跳过。
    /// 不放进有效路径：Plasma 能播视频、有效路径不带媒体过滤，WPE 行仍会被 count 进来。
    allow_wpe: bool,
}

/// 目标的当前配置；目标还没落盘时按默认值读。
fn target_config(target_id: &str) -> WallpaperTargetConfig {
    Settings::global()
        .get_wallpaper_target(target_id)
        .unwrap_or_default()
}

/// 读-改-写一个目标的配置（一次 `setting-change`）。
fn update_target(
    target_id: &str,
    f: impl FnOnce(&mut WallpaperTargetConfig),
) -> Result<(), String> {
    Settings::global().update_wallpaper_target(target_id, WallpaperTargetConfig::default, f)
}

/// 把目标的轮播路径换成新的默认随机路径（位置随之置为从头开始）。
fn fall_back_to_default(target_id: &str, reason: &str) -> Result<String, String> {
    let path = rotation_path::default_path();
    tracing::warn!("{reason}，目标 {target_id} 回落默认路径 {path}");
    update_target(target_id, |config| {
        config.set_rotation_path(Some(path.clone()));
    })?;
    Ok(path)
}

fn count_source(
    path: String,
    wallpaper_mode: &str,
    fallback: bool,
) -> Result<RotationSource, String> {
    let effective = rotation_path::effective_path(&path, wallpaper_mode);
    let count = count_at(&effective)? as u64;
    Ok(RotationSource {
        path,
        effective,
        count,
        fallback,
        allow_wpe: wallpaper_mode == "window",
    })
}

/// 读目标的轮播路径并 count；未设置时写入默认随机路径，count 出错时回落默认路径再 count 一次。
fn resolve_source(target_id: &str, wallpaper_mode: &str) -> Result<RotationSource, String> {
    let path = match target_config(target_id).rotation_path {
        Some(p) => p,
        None => {
            let p = rotation_path::default_path();
            update_target(target_id, |config| {
                config.set_rotation_path(Some(p.clone()));
            })?;
            p
        }
    };
    match count_source(path.clone(), wallpaper_mode, false) {
        Ok(src) => Ok(src),
        Err(e) => {
            let default = fall_back_to_default(target_id, &format!("count {path} 失败: {e}"))?;
            count_source(default, wallpaper_mode, true)
        }
    }
}

/// 设置位置在当前 count 下的起点：越过末尾统一回到第 1 张。
fn wrapped_position(position: u64, count: u64) -> u64 {
    if position >= count {
        0
    } else {
        position
    }
}

/// 图片 `current_image_id` 在 `effective` 里的 1 起序号，即下一张的 0 起位置；id 为空或不在路径里返回 None。
fn locate_after_current(current_image_id: Option<&str>, effective: &str) -> Option<u64> {
    let id = current_image_id?;
    query_fetch(&rotation_path::rank_path(effective, id))
        .ok()?
        .into_iter()
        .next()?
        .get("row_index")?
        .as_u64()
}

/// 目标本轮的起点：查询视图会随图片增删、改字段而变，持久化位置可能已经错位，所以优先取
/// 「该目标当前壁纸的下一张」并写回位置；当前壁纸不在路径里时才用持久化位置。
/// 刚换的路径（位置为 `WALLPAPER_ROTATION_FROM_START`）从第 1 张开始，不定位。
fn start_position(target_id: &str, src: &RotationSource) -> u64 {
    let config = target_config(target_id);
    if config.rotation_position == WALLPAPER_ROTATION_FROM_START {
        return 0;
    }
    match locate_after_current(config.current_image_id.as_deref(), &src.effective) {
        Some(n) => {
            let _ = update_target(target_id, |config| config.set_rotation_position(n as i64));
            wrapped_position(n, src.count)
        }
        None => wrapped_position(config.rotation_position.max(0) as u64, src.count),
    }
}

/// 从 `start` 起循环取最多 `limit` 张文件仍在的图，返回 `(0 起位置, 图)`；最多扫一整轮。
/// 按 `chunk` 张一页取行：切换壁纸用 1，Android 预取队列用 100。
fn collect_available(
    src: &RotationSource,
    start: u64,
    limit: usize,
    chunk: u64,
) -> Result<Vec<(u64, ImageInfo)>, String> {
    let mut out = Vec::new();
    if src.count == 0 || limit == 0 {
        return Ok(out);
    }
    let chunk = chunk.max(1);
    let mut pos = wrapped_position(start, src.count);
    let mut scanned = 0u64;
    while out.len() < limit && scanned < src.count {
        let page = pos / chunk + 1;
        let rows = images_at(&rotation_path::rows_path(&src.effective, chunk, page))?;
        if rows.is_empty() {
            // count 之后数据变少：本页已越过末尾，回到开头继续扫
            if pos == 0 {
                break;
            }
            pos = 0;
            continue;
        }
        let page_start = (page - 1) * chunk;
        for (i, img) in rows.into_iter().enumerate() {
            let p = page_start + i as u64;
            if p < pos {
                continue;
            }
            scanned += 1;
            let wpe_ok = src.allow_wpe
                || !kabegame_core::media::image_type::is_wpe_type(img.media_type.as_deref());
            if wpe_ok && wallpaper_file_available(&img) {
                out.push((p, img));
            }
            if out.len() >= limit || scanned >= src.count {
                break;
            }
        }
        pos = page * chunk;
        if pos >= src.count {
            pos = 0;
        }
    }
    Ok(out)
}

/// 给目标选出下一张：返回图与写回的新位置；本轮没有可用图返回 None。
/// 取行出错与 count 出错同等对待：回落默认路径重试一次。
fn pick_next(target_id: &str, wallpaper_mode: &str) -> Result<Option<(ImageInfo, u64)>, String> {
    let mut src = resolve_source(target_id, wallpaper_mode)?;
    let picked = match collect_available(&src, start_position(target_id, &src), 1, 1) {
        Ok(v) => v,
        Err(e) if !src.fallback => {
            let default = fall_back_to_default(target_id, &format!("取行 {} 失败: {e}", src.path))?;
            src = count_source(default, wallpaper_mode, true)?;
            collect_available(&src, start_position(target_id, &src), 1, 1)?
        }
        Err(e) => return Err(e),
    };
    Ok(picked.into_iter().next().map(|(pos, img)| (img, pos + 1)))
}

/// 把一个目标切到下一张并写回它的状态；定时器与手动切换共用。返回是否换了壁纸。
/// 目标必须在当前活跃集合里。
async fn advance_and_apply(target_id: &str) -> Result<bool, String> {
    let controller = WallpaperController::global();
    let (target_id, placement) = controller.resolve_target(Some(target_id))?;
    let wallpaper_mode = Settings::global().get_wallpaper_mode();
    let picked = {
        let target_id = target_id.clone();
        tokio::task::spawn_blocking(move || pick_next(&target_id, &wallpaper_mode))
            .await
            .map_err(|e| format!("轮播选图任务失败: {e}"))??
    };
    let Some((image, next_position)) = picked else {
        tracing::warn!("目标 {target_id} 的轮播路径下没有可用图片，跳过本轮");
        return Ok(false);
    };

    // 先推进位置：即使这张设壁纸失败，下一轮也不会卡在同一张上
    update_target(&target_id, |config| {
        config.set_rotation_position(next_position as i64)
    })?;

    // 交给后端的是原始 local_path：原生后端在 native.rs 里经
    // wallpaper_compat::ensure_native_wallpaper_path 按需生成 / 复用 wallpaper_compatible_path
    let config = target_config(&target_id);
    let manager = controller.active_manager().await?;
    manager
        .set_wallpaper(
            &image.local_path,
            &controller.effective_style(&config),
            &controller.effective_transition(&config),
            &placement,
        )
        .await?;
    tracing::info!("壁纸已更换（{target_id}）: {}", image.local_path);

    let _ = update_target(&target_id, |config| {
        config.set_current_image_id(Some(image.id.clone()))
    });
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let ids = vec![image.id];
    if Storage::global()
        .update_image_last_set_wallpaper_at(&ids[0], now_ts)
        .is_ok()
    {
        GlobalEmitter::global()
            .emit_image_fields(&ids, serde_json::json!({ "lastSetWallpaperAt": now_ts }));
    }
    Ok(true)
}

/// 切换壁纸模式会改变有效路径（加 / 去媒体过滤）：每个目标按自己的当前壁纸 id 在新有效路径里重定位位置。
/// 下一次切换本身也会重定位，这里提前写回，让设置里的位置与新模式一致。
/// 当前 id 为空、不在新有效路径里，或刚换了路径还没切过，则保留原位置。
pub fn relocate_position_for_mode(wallpaper_mode: &str) {
    let settings = Settings::global();
    let relocated: std::collections::BTreeMap<String, i64> = settings
        .get_wallpaper_targets()
        .into_iter()
        .filter_map(|(id, config)| {
            let path = config.rotation_path.as_deref()?;
            if config.rotation_position == WALLPAPER_ROTATION_FROM_START {
                return None;
            }
            let effective = rotation_path::effective_path(path, wallpaper_mode);
            let n = locate_after_current(config.current_image_id.as_deref(), &effective)?;
            Some((id, n as i64))
        })
        .collect();
    if relocated.is_empty() {
        return;
    }
    let _ = settings.update_all_wallpaper_targets(|id, config| {
        if let Some(position) = relocated.get(id) {
            config.set_rotation_position(*position);
        }
    });
}

/// 校验一个将要设为轮播来源的路径：count 成功、非空，且第 1 张能解析成图片行。
pub fn validate_rotation_path(path: &str, wallpaper_mode: &str) -> Result<(), String> {
    let effective = rotation_path::effective_path(path, wallpaper_mode);
    let count = count_at(&effective).map_err(|e| format!("轮播路径无效: {e}"))?;
    if count == 0 {
        return Err("该视图下没有可作壁纸的图片".to_string());
    }
    images_at(&rotation_path::rows_path(&effective, 1, 1))
        .map_err(|e| format!("轮播路径无效: {e}"))?;
    Ok(())
}

/// 模式切换 / 兜底场景：从默认随机路径里随机取一张文件仍在的图，返回 local_path。
/// `commands::wallpaper::set_wallpaper_mode` 在原壁纸文件不存在时用作 fallback。
pub fn pick_random_gallery_wallpaper(wallpaper_mode: &str) -> Option<String> {
    let src = count_source(rotation_path::default_path(), wallpaper_mode, false).ok()?;
    if src.count == 0 {
        return None;
    }
    let start = random_index(src.count.min(usize::MAX as u64) as usize) as u64;
    collect_available(&src, start, 1, 1)
        .ok()?
        .into_iter()
        .next()
        .map(|(_, img)| img.local_path)
}

/// Android：WorkManager Worker 在冷进程里跑、没有 PathQL，由这里预取后续可用图写成队列文件，
/// Worker 只弹队首。格式：`{ path, count, position, currentImageId?, items: [{ id, localPath, position }] }`。
/// Android 只有 `multiple` 一个目标，队列读写的就是它（Worker 读 settings.json 的 `wallpaperTargets.multiple`）。
#[cfg(target_os = "android")]
mod android_queue {
    use super::*;
    use kabegame_core::settings::TARGET_MULTIPLE;

    const QUEUE_LEN: usize = 100;
    const QUEUE_FILE: &str = "rotation_queue.json";
    /// 旧版 Worker 的游标文件，迁到队列后删除
    const LEGACY_STATE_FILE: &str = "rotation_state.json";

    fn data_dir() -> std::path::PathBuf {
        let settings_json = kabegame_core::app_paths::AppPaths::global().settings_json();
        settings_json
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    }

    /// 先把 Worker 推进的位置与当前壁纸同步回设置，再从该位置重新预取。
    pub fn refill() -> Result<(), String> {
        let dir = data_dir();
        let file = dir.join(QUEUE_FILE);
        let _ = std::fs::remove_file(dir.join(LEGACY_STATE_FILE));
        let settings = Settings::global();
        let target_id = TARGET_MULTIPLE;

        if let Some(old) = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            let same_path = old.get("path").and_then(|v| v.as_str())
                == target_config(target_id).rotation_path.as_deref();
            // 只有 Worker 真的切过（写了 currentImageId）才同步：否则文件里的 position 只是
            // 上次写下的起点，会把刚换路径时的 WALLPAPER_ROTATION_FROM_START 覆盖掉
            let consumed_id = old.get("currentImageId").and_then(|v| v.as_str());
            if let (true, Some(id)) = (same_path, consumed_id) {
                let position = old.get("position").and_then(|v| v.as_i64());
                let _ = update_target(target_id, |config| {
                    if let Some(position) = position {
                        config.set_rotation_position(position);
                    }
                    config.set_current_image_id(Some(id.to_string()));
                });
            }
        }

        let src = resolve_source(target_id, &settings.get_wallpaper_mode())?;
        let start = start_position(target_id, &src);
        let items: Vec<serde_json::Value> = collect_available(&src, start, QUEUE_LEN, 100)?
            .into_iter()
            .map(|(pos, img)| {
                serde_json::json!({ "id": img.id, "localPath": img.local_path, "position": pos })
            })
            .collect();
        let queue = serde_json::json!({
            "path": src.path,
            "count": src.count,
            "position": start,
            "items": items,
        });
        let tmp = dir.join(format!("{QUEUE_FILE}.tmp"));
        std::fs::write(&tmp, queue.to_string()).map_err(|e| format!("写轮播队列失败: {e}"))?;
        std::fs::rename(&tmp, &file).map_err(|e| format!("替换轮播队列失败: {e}"))
    }
}

/// Android 上刷新 Worker 队列；其它平台无操作。
pub fn refresh_android_queue() {
    #[cfg(target_os = "android")]
    if let Err(e) = android_queue::refill() {
        tracing::warn!("刷新 Android 轮播队列失败: {e}");
    }
}

// 轮播状态
const STATE_IDLE: u8 = 0; // 空闲
const STATE_STARTING: u8 = 1; // 开启中
const STATE_RUNNING: u8 = 2; // 运行中
const STATE_STOPPING: u8 = 3; // 关闭中

/// 手动切换请求：同一轮内的多个请求合并成一个。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum Manual {
    /// 没有请求
    #[default]
    None,
    /// 所有活跃目标
    All,
    /// 指定的几个目标
    Targets(BTreeSet<String>),
}

impl Manual {
    fn target(target_id: &str) -> Self {
        Manual::Targets(BTreeSet::from([target_id.to_string()]))
    }

    fn merge(&mut self, other: Manual) {
        *self = match (std::mem::take(self), other) {
            (Manual::All, _) | (_, Manual::All) => Manual::All,
            (Manual::None, manual) | (manual, Manual::None) => manual,
            (Manual::Targets(mut a), Manual::Targets(b)) => {
                a.extend(b);
                Manual::Targets(a)
            }
        };
    }

    /// 本轮要切的目标，按活跃目标的顺序（默认目标在前）；请求里已不在活跃集合的目标丢弃。
    fn into_targets(self, active: Vec<String>) -> Vec<String> {
        match self {
            Manual::None => Vec::new(),
            Manual::All => active,
            Manual::Targets(wanted) => {
                for id in wanted.iter().filter(|id| !active.contains(id)) {
                    tracing::warn!("手动切换的壁纸目标 {id} 不在活跃集合里，跳过");
                }
                active
                    .into_iter()
                    .filter(|id| wanted.contains(id))
                    .collect()
            }
        }
    }
}

/// 轮播线程与外部共享的控制状态。
struct Control {
    running: AtomicBool,
    /// 轮播状态：Idle / Starting / Running / Stopping
    state: AtomicU8,
    /// 重置定时器，不触发切换
    reset: AtomicBool,
    /// 手动切换请求
    manual: Mutex<Manual>,
    /// 唤醒轮播线程（手动切换 / 重置 / 停止）
    notify: Notify,
}

impl Control {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            state: AtomicU8::new(STATE_IDLE),
            reset: AtomicBool::new(false),
            manual: Mutex::new(Manual::None),
            notify: Notify::new(),
        }
    }

    fn request_manual(&self, manual: Manual) {
        if let Ok(mut pending) = self.manual.lock() {
            pending.merge(manual);
        }
        self.notify.notify_one();
    }

    fn request_reset(&self) {
        self.reset.store(true, Ordering::Relaxed);
        self.notify.notify_one();
    }

    fn take_manual(&self) -> Manual {
        self.manual
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
}

/// 轮播线程向外要的东西：全局开关与间隔、当前活跃目标、把一个目标切到下一张。
/// 生产实现读设置与控制器（[`AppHost`]），单测注入假的活跃目标列表与切换动作。
#[async_trait]
trait RotationHost: Send + Sync + 'static {
    fn rotation_enabled(&self) -> bool;
    /// 轮播间隔（秒）
    fn interval_secs(&self) -> u64;
    /// 当前活跃目标，默认目标在前；每轮现取，显示器模式与在线屏变化后下一轮即生效
    fn active_targets(&self) -> Vec<String>;
    async fn advance(&self, target_id: &str) -> Result<bool, String>;
}

struct AppHost;

#[async_trait]
impl RotationHost for AppHost {
    fn rotation_enabled(&self) -> bool {
        Settings::global().get_wallpaper_rotation_enabled()
    }

    fn interval_secs(&self) -> u64 {
        Settings::global()
            .get_wallpaper_rotation_interval_minutes()
            .saturating_mul(60)
            .max(60) as u64
    }

    fn active_targets(&self) -> Vec<String> {
        WallpaperController::global().layout().target_ids()
    }

    async fn advance(&self, target_id: &str) -> Result<bool, String> {
        advance_and_apply(target_id).await
    }
}

/// 轮播线程主体：一个 ticker 控制间隔，到点对每个活跃目标各切一张；
/// 手动切换 / 重置通过 `Control::notify` 立即唤醒处理。
async fn run_loop<H: RotationHost>(host: H, control: Arc<Control>) {
    // 线程启动成功，设置状态为“运行中”
    control.state.store(STATE_RUNNING, Ordering::Release);
    tracing::debug!("start");

    let mut current_interval_secs = host.interval_secs();
    let mut ticker = interval(Duration::from_secs(current_interval_secs));

    // 重要：tokio interval 第一次 tick 会立刻触发；我们先消费一次，让“自动轮播”从 interval 后才开始。
    ticker.tick().await;

    loop {
        let woke_by_timer = tokio::select! {
            _ = ticker.tick() => true,
            _ = control.notify.notified() => false, // manual/reset
        };

        // 检查状态：如果是 Stopping 或 running=false，则退出
        let current_state = control.state.load(Ordering::Acquire);
        if current_state == STATE_STOPPING || !control.running.load(Ordering::Relaxed) {
            tracing::debug!("状态变化，退出轮播线程");
            break;
        }

        // 控制指令在本轮一次取走
        let manual = control.take_manual();
        let reset = control.reset.swap(false, Ordering::Relaxed);

        // 未启用轮播：仅保持线程等待（便于后续快速启用），不做任何切换
        if !host.rotation_enabled() {
            continue;
        }

        // 如果 interval 被用户改了，更新 ticker，下一次从现在开始计时
        let desired_secs = host.interval_secs();
        if desired_secs != current_interval_secs {
            current_interval_secs = desired_secs;
            ticker = interval(Duration::from_secs(current_interval_secs));
            // 同上：先消费一次“立即 tick”，避免改间隔后立刻切一次
            ticker.tick().await;
            if manual == Manual::None {
                continue;
            }
        }

        let targets = if manual != Manual::None {
            // 手动切换：全部活跃目标，或指定的几个
            manual.into_targets(host.active_targets())
        } else if reset {
            // 仅重置定时器，不触发切换
            ticker.reset();
            continue;
        } else if !woke_by_timer {
            // notify 留下的 permit：指令已在上一轮一并处理（如 rotate 紧跟 reset），
            // 不能当成定时器到期再切一次
            continue;
        } else {
            // 定时器到期：所有活跃目标各切一张
            host.active_targets()
        };

        // 按顺序逐个切（默认目标在前）；一个目标失败不影响其它
        for target_id in &targets {
            if let Err(e) = host.advance(target_id).await {
                tracing::warn!("轮播切换失败（{target_id}）: {e}");
            }
        }

        // 本轮执行完后，让下一次从“现在”开始计时，确保手动切换/模式切换会重置计时器
        ticker.reset();
    }

    // 任务退出：设置状态为"空闲"，确保 running 标志复位，避免"假运行"
    control.state.store(STATE_IDLE, Ordering::Release);
    control.running.store(false, Ordering::Relaxed);
}

pub struct WallpaperRotator {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    app: AppHandle<crate::AppRuntime>,
    control: Arc<Control>,
}

// 全局 WallpaperRotator 单例
static WALLPAPER_ROTATOR: OnceLock<WallpaperRotator> = OnceLock::new();

impl WallpaperRotator {
    /// 初始化全局 WallpaperRotator（必须在首次使用前调用）
    pub fn init_global(app: AppHandle<crate::AppRuntime>) -> Result<(), String> {
        let rotator = WallpaperRotator::new(app);
        WALLPAPER_ROTATOR
            .set(rotator)
            .map_err(|_| "WallpaperRotator already initialized".to_string())?;
        Ok(())
    }

    /// 获取全局 WallpaperRotator 引用
    pub fn global() -> &'static WallpaperRotator {
        WALLPAPER_ROTATOR
            .get()
            .expect("WallpaperRotator not initialized. Call WallpaperRotator::init_global() first.")
    }

    pub fn new(app: AppHandle<crate::AppRuntime>) -> Self {
        Self {
            app,
            control: Arc::new(Control::new()),
        }
    }

    #[cfg_attr(target_os = "android", allow(dead_code))]
    fn spawn_task(&self) {
        tauri::async_runtime::spawn(run_loop(AppHost, Arc::clone(&self.control)));
    }

    /// 按"当前设置"确保轮播线程存在；未启用轮播时不启动。
    pub async fn start(&self) -> Result<(), String> {
        if !Settings::global().get_wallpaper_rotation_enabled() {
            return Ok(());
        }
        self.ensure_running().await
    }

    /// 确保轮播线程已启动。开启 / 恢复轮播不会立刻换壁纸，首次自动切换发生在 interval 到期后
    /// （或用户手动触发 rotate）；各目标的位置沿用设置里保存的值，路径不变就接着上次的下一张。
    pub async fn ensure_running(&self) -> Result<(), String> {
        // 壁纸功能已关闭：静默跳过，不启动轮播线程。
        if !Settings::global().get_wallpaper_enabled() {
            return Ok(());
        }
        // 已在运行：设置变化后 reset 让任务按新设置继续运行即可。
        if self.control.running.load(Ordering::Relaxed) {
            self.reset();
            return Ok(());
        }

        // 刚 stop() 过：线程要等被唤醒才退出，给它一点时间，
        // 避免「先停后启」（切壁纸模式 / 显示器模式）正好落在“关闭中”上而启动失败
        for _ in 0..50 {
            if self.control.state.load(Ordering::Acquire) != STATE_STOPPING {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // 未在运行：检查状态，避免并发启动/关闭导致重复 spawn
        let current_state = self.control.state.load(Ordering::Acquire);
        if current_state == STATE_STARTING || current_state == STATE_STOPPING {
            return Err(format!(
                "轮播线程状态异常，无法启动：当前状态={}",
                match current_state {
                    STATE_STARTING => "开启中",
                    STATE_STOPPING => "关闭中",
                    _ => "未知",
                }
            ));
        }

        // 设置状态为“开启中”
        self.control.state.store(STATE_STARTING, Ordering::Release);

        let start_res: Result<(), String> = async {
            let settings = Settings::global();
            if !settings.get_wallpaper_rotation_enabled() {
                return Err("壁纸轮播未启用".to_string());
            }

            // 逐个活跃目标解析轮播来源（未设置路径的写入默认路径、坏路径回落）；
            // 至少要有一个目标的路径下有图片才启动
            let mode = settings.get_wallpaper_mode();
            let targets = WallpaperController::global().layout().target_ids();
            tokio::task::spawn_blocking(move || {
                let mut has_images = false;
                let mut last_error = None;
                for target_id in &targets {
                    match resolve_source(target_id, &mode) {
                        Ok(src) => has_images |= src.count > 0,
                        Err(e) => last_error = Some(e),
                    }
                }
                if has_images {
                    Ok(())
                } else {
                    Err(last_error.unwrap_or_else(|| "轮播路径下没有图片".to_string()))
                }
            })
            .await
            .map_err(|e| format!("轮播启动校验失败: {e}"))??;

            #[cfg(target_os = "android")]
            {
                use tauri_plugin_wallpaper::WallpaperExt;

                refresh_android_queue();
                let interval = settings.get_wallpaper_rotation_interval_minutes().max(15) as u32;

                self.app
                    .wallpaper()
                    .schedule_rotation(interval)
                    .await
                    .map_err(|e| format!("WorkManager schedule failed: {}", e))?;

                self.control.running.store(true, Ordering::Relaxed);
                self.control.state.store(STATE_RUNNING, Ordering::Release);
                return Ok(());
            }

            #[cfg(not(target_os = "android"))]
            {
                self.control.running.store(true, Ordering::Relaxed);
                self.spawn_task();
                Ok(())
            }
        }
        .await;

        if start_res.is_err() {
            // 启动失败：复位状态，避免卡在 starting
            self.control.state.store(STATE_IDLE, Ordering::Release);
            self.control.running.store(false, Ordering::Relaxed);
        }

        start_res
    }

    /// 立刻切换到下一张壁纸（托盘菜单、换轮播路径、演示过渡）。
    /// `target` 为 `Some` 时只切这个目标，`None` 切所有活跃目标。
    ///
    /// - 轮播线程正在运行：登记请求 + notify，由线程立即处理一次切换（并重置计时）
    /// - 否则在当前任务里切换一次；轮播已启用则随后启动轮播线程
    pub async fn rotate(&self, target: Option<&str>) -> Result<(), String> {
        // 壁纸功能已关闭：静默跳过，不切换壁纸。
        if !Settings::global().get_wallpaper_enabled() {
            return Ok(());
        }
        // 桌面端运行中：轮播线程可能正在 await tick，交给它处理
        #[cfg(not(target_os = "android"))]
        if self.control.running.load(Ordering::Relaxed) {
            self.control.request_manual(match target {
                Some(target_id) => Manual::target(target_id),
                None => Manual::All,
            });
            return Ok(());
        }

        let targets = match target {
            Some(target_id) => vec![target_id.to_string()],
            None => WallpaperController::global().layout().target_ids(),
        };
        // 一个目标失败不影响其它；全部试过之后把第一个错误交给调用方
        let mut first_error = None;
        for target_id in &targets {
            if let Err(e) = advance_and_apply(target_id).await {
                tracing::warn!("切换壁纸失败（{target_id}）: {e}");
                first_error.get_or_insert(e);
            }
        }
        if let Some(e) = first_error {
            return Err(e);
        }
        refresh_android_queue();

        let enabled = Settings::global().get_wallpaper_rotation_enabled();
        if enabled && !self.control.running.load(Ordering::Relaxed) {
            self.ensure_running().await?;
        }
        Ok(())
    }

    pub fn stop(&self) {
        let current_state = self.control.state.load(Ordering::Acquire);

        // 如果已经是空闲或关闭中，直接返回
        if current_state == STATE_IDLE || current_state == STATE_STOPPING {
            return;
        }

        // 设置状态为“关闭中”
        self.control.state.store(STATE_STOPPING, Ordering::Release);
        self.control.running.store(false, Ordering::Relaxed);
        self.control.request_reset();

        #[cfg(target_os = "android")]
        {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_wallpaper::WallpaperExt;
                let _ = app.wallpaper().cancel_rotation().await;
            });
            self.control.state.store(STATE_IDLE, Ordering::Release);
            return;
        }

        // 注意：这里不等待线程退出，线程会在检查到 STATE_STOPPING 后自行退出并设置为 STATE_IDLE
    }

    /// 重置定时器，使其从当前时间重新开始计算间隔
    pub fn reset(&self) {
        #[cfg(target_os = "android")]
        {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_wallpaper::WallpaperExt;
                let _ = tokio::task::spawn_blocking(refresh_android_queue).await;
                let interval = Settings::global().get_wallpaper_rotation_interval_minutes();
                let _ = app
                    .wallpaper()
                    .schedule_rotation(interval.max(15) as u32)
                    .await;
            });
            return;
        }

        self.control.request_reset();
    }

    pub fn is_running(&self) -> bool {
        self.control.running.load(Ordering::Relaxed)
    }

    /// 获取轮播状态："idle" | "starting" | "running" | "stopping"
    #[allow(dead_code)]
    pub fn get_status(&self) -> String {
        match self.control.state.load(Ordering::Acquire) {
            STATE_IDLE => "idle".to_string(),
            STATE_STARTING => "starting".to_string(),
            STATE_RUNNING => "running".to_string(),
            STATE_STOPPING => "stopping".to_string(),
            _ => "unknown".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use tokio::time::Instant;

    #[test]
    fn position_past_end_wraps_to_first() {
        assert_eq!(wrapped_position(3, 10), 3);
        assert_eq!(wrapped_position(10, 10), 0);
        assert_eq!(wrapped_position(25, 7), 0);
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn manual_requests_merge_within_one_round() {
        let mut manual = Manual::None;
        manual.merge(Manual::target("b"));
        manual.merge(Manual::None);
        manual.merge(Manual::target("a"));
        assert_eq!(
            manual,
            Manual::Targets(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        // 「全部」吸收指定目标，之后再来的指定目标也不会把它缩回去
        manual.merge(Manual::All);
        manual.merge(Manual::target("c"));
        assert_eq!(manual, Manual::All);
    }

    #[test]
    fn manual_targets_follow_active_order_and_drop_inactive() {
        let active = ids(&["screen:b", "screen:a", "screen:c"]);
        assert_eq!(
            Manual::None.into_targets(active.clone()),
            Vec::<String>::new()
        );
        assert_eq!(Manual::All.into_targets(active.clone()), active);
        let mut manual = Manual::target("screen:c");
        manual.merge(Manual::target("screen:b"));
        manual.merge(Manual::target("screen:gone"));
        // 按活跃目标的顺序（默认目标在前），已不活跃的目标丢弃
        assert_eq!(manual.into_targets(active), ids(&["screen:b", "screen:c"]));
    }

    /// 假宿主：活跃目标列表、开关、间隔可随时改；记录每次切换发生的时刻（距启动的秒数）与目标。
    struct FakeHost {
        started: Instant,
        enabled: AtomicBool,
        interval_secs: AtomicU64,
        targets: Mutex<Vec<String>>,
        failing: Mutex<BTreeSet<String>>,
        attempts: Mutex<Vec<(u64, String)>>,
        switched: Mutex<Vec<(u64, String)>>,
    }

    impl FakeHost {
        fn new(targets: &[&str], interval_secs: u64) -> Arc<Self> {
            Arc::new(Self {
                started: Instant::now(),
                enabled: AtomicBool::new(true),
                interval_secs: AtomicU64::new(interval_secs),
                targets: Mutex::new(ids(targets)),
                failing: Mutex::new(BTreeSet::new()),
                attempts: Mutex::new(Vec::new()),
                switched: Mutex::new(Vec::new()),
            })
        }

        fn attempts(&self) -> Vec<(u64, String)> {
            self.attempts.lock().unwrap().clone()
        }

        fn switched(&self) -> Vec<(u64, String)> {
            self.switched.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RotationHost for Arc<FakeHost> {
        fn rotation_enabled(&self) -> bool {
            self.enabled.load(Ordering::Relaxed)
        }

        fn interval_secs(&self) -> u64 {
            self.interval_secs.load(Ordering::Relaxed)
        }

        fn active_targets(&self) -> Vec<String> {
            self.targets.lock().unwrap().clone()
        }

        async fn advance(&self, target_id: &str) -> Result<bool, String> {
            let at = self.started.elapsed().as_secs();
            self.attempts
                .lock()
                .unwrap()
                .push((at, target_id.to_string()));
            if self.failing.lock().unwrap().contains(target_id) {
                return Err(format!("{target_id} 选图失败"));
            }
            self.switched
                .lock()
                .unwrap()
                .push((at, target_id.to_string()));
            Ok(true)
        }
    }

    fn at(secs: u64, id: &str) -> (u64, String) {
        (secs, id.to_string())
    }

    /// 起一个轮播线程（时间已暂停，由 sleep 推进）。
    fn spawn_loop(host: &Arc<FakeHost>) -> Arc<Control> {
        let control = Arc::new(Control::new());
        control.running.store(true, Ordering::Relaxed);
        tokio::spawn(run_loop(Arc::clone(host), Arc::clone(&control)));
        control
    }

    async fn sleep_secs(secs: u64) {
        tokio::time::sleep(Duration::from_secs(secs)).await;
    }

    /// 让轮播线程把已经到达的唤醒处理完（不推进到下一个整秒）。
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn timer_switches_every_active_target_in_order() {
        let host = FakeHost::new(&["screen:a", "screen:b"], 60);
        let control = spawn_loop(&host);

        sleep_secs(59).await;
        // 启动不立刻切，首次切换在一个间隔之后
        assert!(host.switched().is_empty());
        assert_eq!(control.state.load(Ordering::Acquire), STATE_RUNNING);

        sleep_secs(2).await;
        assert_eq!(
            host.switched(),
            vec![at(60, "screen:a"), at(60, "screen:b")]
        );

        sleep_secs(60).await;
        assert_eq!(
            host.switched()[2..],
            [at(120, "screen:a"), at(120, "screen:b")]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn manual_request_switches_only_that_target_and_resets_timer() {
        let host = FakeHost::new(&["screen:a", "screen:b"], 60);
        let control = spawn_loop(&host);

        sleep_secs(30).await;
        control.request_manual(Manual::target("screen:b"));
        settle().await;
        // 只切指定的目标，别的目标不动
        assert_eq!(host.switched(), vec![at(30, "screen:b")]);

        // 计时从手动切换时起算：原定 60s 的那次不再发生，下一次自动切换在 30 + 60
        sleep_secs(59).await;
        assert_eq!(host.switched(), vec![at(30, "screen:b")]);
        sleep_secs(2).await;
        assert_eq!(
            host.switched()[1..],
            [at(90, "screen:a"), at(90, "screen:b")]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn manual_all_switches_every_active_target() {
        let host = FakeHost::new(&["screen:a", "screen:b"], 60);
        let control = spawn_loop(&host);

        sleep_secs(10).await;
        control.request_manual(Manual::All);
        settle().await;
        assert_eq!(
            host.switched(),
            vec![at(10, "screen:a"), at(10, "screen:b")]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn one_failing_target_does_not_block_the_others() {
        let host = FakeHost::new(&["screen:a", "screen:b", "screen:c"], 60);
        host.failing.lock().unwrap().insert("screen:a".to_string());
        let _control = spawn_loop(&host);

        sleep_secs(61).await;
        assert_eq!(
            host.attempts(),
            vec![at(60, "screen:a"), at(60, "screen:b"), at(60, "screen:c")]
        );
        assert_eq!(
            host.switched(),
            vec![at(60, "screen:b"), at(60, "screen:c")]
        );

        // 失败的目标下一轮照常再试
        sleep_secs(60).await;
        assert_eq!(host.attempts()[3], at(120, "screen:a"));
    }

    #[tokio::test(start_paused = true)]
    async fn each_round_reads_the_current_active_targets() {
        let host = FakeHost::new(&["multiple"], 60);
        let _control = spawn_loop(&host);

        sleep_secs(61).await;
        assert_eq!(host.switched(), vec![at(60, "multiple")]);

        // 活跃目标变了（换显示器模式 / 接入新屏）：下一轮按新的集合切
        *host.targets.lock().unwrap() = ids(&["screen:a", "screen:b"]);
        sleep_secs(60).await;
        assert_eq!(
            host.switched()[1..],
            [at(120, "screen:a"), at(120, "screen:b")]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reset_restarts_timer_without_switching() {
        let host = FakeHost::new(&["multiple"], 60);
        let control = spawn_loop(&host);

        sleep_secs(40).await;
        control.request_reset();
        settle().await;
        sleep_secs(59).await;
        // 原定 60s 的那次被重置掉，且重置本身不切换
        assert!(host.switched().is_empty());
        sleep_secs(2).await;
        assert_eq!(host.switched(), vec![at(100, "multiple")]);
    }

    #[tokio::test(start_paused = true)]
    async fn rotate_followed_by_reset_switches_once() {
        let host = FakeHost::new(&["multiple"], 60);
        let control = spawn_loop(&host);

        sleep_secs(10).await;
        // 换轮播路径时的调用顺序：rotate 紧跟 reset，第二次 notify 留下一个 permit
        control.request_manual(Manual::All);
        control.request_reset();
        settle().await;
        sleep_secs(5).await;
        assert_eq!(host.switched(), vec![at(10, "multiple")]);
    }

    #[tokio::test(start_paused = true)]
    async fn interval_change_takes_effect_from_now() {
        let host = FakeHost::new(&["multiple"], 60);
        let control = spawn_loop(&host);

        sleep_secs(10).await;
        // 改间隔的命令：写设置后 reset
        host.interval_secs.store(120, Ordering::Relaxed);
        control.request_reset();
        settle().await;

        sleep_secs(119).await;
        assert!(host.switched().is_empty());
        sleep_secs(2).await;
        // 从改间隔的时刻起算一个新间隔
        assert_eq!(host.switched(), vec![at(130, "multiple")]);
    }

    #[tokio::test(start_paused = true)]
    async fn disabled_rotation_does_not_switch() {
        let host = FakeHost::new(&["multiple"], 60);
        host.enabled.store(false, Ordering::Relaxed);
        let control = spawn_loop(&host);

        sleep_secs(130).await;
        control.request_manual(Manual::All);
        settle().await;
        assert!(host.attempts().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_request_ends_the_loop() {
        let host = FakeHost::new(&["multiple"], 60);
        let control = spawn_loop(&host);
        settle().await;
        assert_eq!(control.state.load(Ordering::Acquire), STATE_RUNNING);

        // 与 `WallpaperRotator::stop` 相同的三步
        control.state.store(STATE_STOPPING, Ordering::Release);
        control.running.store(false, Ordering::Relaxed);
        control.request_reset();
        settle().await;
        assert_eq!(control.state.load(Ordering::Acquire), STATE_IDLE);

        sleep_secs(120).await;
        assert!(host.attempts().is_empty());
    }
}
