//! 壁纸轮播：一律读设置里的一个 PathQL 路径，按持久化位置逐张前进。
//!
//! 每次切换：`count(有效路径)` → 出错落回默认随机路径 → 定起点（当前壁纸 id 在路径里的下一张，
//! 找不到才用持久化位置）→ 取该位置的一张（页大小 1）→ 设壁纸后写回 `currentWallpaperImageId`
//! 与 `位置 + 1`。换路径时设置层把位置置为 `WALLPAPER_ROTATION_FROM_START`（-1），下一次从第 1 张
//! 开始、不按当前 id 定位；`set_wallpaper_rotation_path` 命令随即唤醒轮播切这一次。路径与有效路径的约定见
//! `kabegame_core::wallpaper_rotation`，整体说明见 `cocs/wallpaper/ROTATION_PATHQL.md`。

use super::manager::WallpaperController;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::providers::{count_at, images_at, query_fetch};
use kabegame_core::settings::{Settings, WALLPAPER_ROTATION_FROM_START};
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wallpaper_rotation as rotation_path;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
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
}

/// 把设置路径换成新的默认随机路径（位置随之置为从头开始）。
fn fall_back_to_default(reason: &str) -> Result<String, String> {
    let path = rotation_path::default_path();
    eprintln!("[WALLPAPER_ROTATOR] {reason}，回落默认路径 {path}");
    Settings::global().set_wallpaper_rotation_path(Some(path.clone()))?;
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
    })
}

/// 读设置路径并 count；未设置时写入默认随机路径，count 出错时回落默认路径再 count 一次。
fn resolve_source(wallpaper_mode: &str) -> Result<RotationSource, String> {
    let path = match Settings::global().get_wallpaper_rotation_path() {
        Some(p) => p,
        None => {
            let p = rotation_path::default_path();
            Settings::global().set_wallpaper_rotation_path(Some(p.clone()))?;
            p
        }
    };
    match count_source(path.clone(), wallpaper_mode, false) {
        Ok(src) => Ok(src),
        Err(e) => {
            let default = fall_back_to_default(&format!("count {path} 失败: {e}"))?;
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

/// 当前壁纸在 `effective` 里的 1 起序号，即下一张的 0 起位置；当前 id 为空或不在路径里返回 None。
fn locate_after_current(effective: &str) -> Option<u64> {
    let id = Settings::global().get_current_wallpaper_image_id()?;
    query_fetch(&rotation_path::rank_path(effective, &id))
        .ok()?
        .into_iter()
        .next()?
        .get("row_index")?
        .as_u64()
}

/// 本轮起点：查询视图会随图片增删、改字段而变，持久化位置可能已经错位，所以优先取
/// 「当前壁纸的下一张」并写回位置；当前壁纸不在路径里时才用持久化位置。
/// 刚换的路径（位置为 `WALLPAPER_ROTATION_FROM_START`）从第 1 张开始，不定位。
fn start_position(src: &RotationSource) -> u64 {
    let settings = Settings::global();
    let position = settings.get_wallpaper_rotation_position();
    if position == WALLPAPER_ROTATION_FROM_START {
        return 0;
    }
    match locate_after_current(&src.effective) {
        Some(n) => {
            let _ = settings.set_wallpaper_rotation_position(n as i64);
            wrapped_position(n, src.count)
        }
        None => wrapped_position(position.max(0) as u64, src.count),
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
            if wallpaper_file_available(&img) {
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

/// 选出下一张：返回图与写回的新位置；本轮没有可用图返回 None。
/// 取行出错与 count 出错同等对待：回落默认路径重试一次。
fn pick_next(wallpaper_mode: &str) -> Result<Option<(ImageInfo, u64)>, String> {
    let mut src = resolve_source(wallpaper_mode)?;
    let picked = match collect_available(&src, start_position(&src), 1, 1) {
        Ok(v) => v,
        Err(e) if !src.fallback => {
            let default = fall_back_to_default(&format!("取行 {} 失败: {e}", src.path))?;
            src = count_source(default, wallpaper_mode, true)?;
            collect_available(&src, start_position(&src), 1, 1)?
        }
        Err(e) => return Err(e),
    };
    Ok(picked.into_iter().next().map(|(pos, img)| (img, pos + 1)))
}

/// 切到下一张并写回状态；定时器与手动切换共用。返回是否换了壁纸。
async fn advance_and_apply() -> Result<bool, String> {
    let settings = Settings::global();
    let wallpaper_mode = settings.get_wallpaper_mode();
    let mode = wallpaper_mode.clone();
    let picked = tokio::task::spawn_blocking(move || pick_next(&mode))
        .await
        .map_err(|e| format!("轮播选图任务失败: {e}"))??;
    let Some((image, next_position)) = picked else {
        eprintln!("[WALLPAPER_ROTATOR] 轮播路径下没有可用图片，跳过本轮");
        return Ok(false);
    };

    // 先推进位置：即使这张设壁纸失败，下一轮也不会卡在同一张上
    settings.set_wallpaper_rotation_position(next_position as i64)?;

    // 交给后端的是原始 local_path：原生后端在 native.rs 里经
    // wallpaper_compat::ensure_native_wallpaper_path 按需生成 / 复用 wallpaper_compatible_path
    let manager = WallpaperController::global().active_manager().await?;
    let style = settings.get_wallpaper_rotation_style();
    let transition = settings.get_wallpaper_rotation_transition();
    manager
        .set_wallpaper(&image.local_path, &style, &transition)
        .await?;
    eprintln!("[WALLPAPER_ROTATOR] 壁纸已更换: {}", image.local_path);

    let _ = settings.set_current_wallpaper_image_id(Some(image.id.clone()));
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

/// 切换壁纸模式会改变有效路径（加 / 去媒体过滤）：按当前壁纸 id 在新有效路径里重定位位置。
/// 下一次切换本身也会重定位，这里提前写回，让设置里的位置与新模式一致。
/// 当前 id 为空、不在新有效路径里，或刚换了路径还没切过，则保留原位置。
pub fn relocate_position_for_mode(wallpaper_mode: &str) {
    let settings = Settings::global();
    let Some(path) = settings.get_wallpaper_rotation_path() else {
        return;
    };
    if settings.get_wallpaper_rotation_position() == WALLPAPER_ROTATION_FROM_START {
        return;
    }
    let effective = rotation_path::effective_path(&path, wallpaper_mode);
    if let Some(n) = locate_after_current(&effective) {
        let _ = settings.set_wallpaper_rotation_position(n as i64);
    }
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
#[cfg(target_os = "android")]
mod android_queue {
    use super::*;

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

        if let Some(old) = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            let same_path = old.get("path").and_then(|v| v.as_str())
                == settings.get_wallpaper_rotation_path().as_deref();
            // 只有 Worker 真的切过（写了 currentImageId）才同步：否则文件里的 position 只是
            // 上次写下的起点，会把刚换路径时的 WALLPAPER_ROTATION_FROM_START 覆盖掉
            let consumed_id = old.get("currentImageId").and_then(|v| v.as_str());
            if let (true, Some(id)) = (same_path, consumed_id) {
                if let Some(pos) = old.get("position").and_then(|v| v.as_i64()) {
                    let _ = settings.set_wallpaper_rotation_position(pos);
                }
                let _ = settings.set_current_wallpaper_image_id(Some(id.to_string()));
            }
        }

        let src = resolve_source(&settings.get_wallpaper_mode())?;
        let start = start_position(&src);
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
        eprintln!("[WALLPAPER_ROTATOR] 刷新 Android 轮播队列失败: {e}");
    }
}

// 轮播线程控制标志位
const FLAG_ROTATE: u8 = 1; // 立即切换壁纸
const FLAG_RESET: u8 = 2; // 重置定时器

// 轮播状态
const STATE_IDLE: u8 = 0; // 空闲
const STATE_STARTING: u8 = 1; // 开启中
const STATE_RUNNING: u8 = 2; // 运行中
const STATE_STOPPING: u8 = 3; // 关闭中

pub struct WallpaperRotator {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    app: AppHandle<crate::AppRuntime>,
    running: Arc<AtomicBool>,
    state: Arc<AtomicU8>,         // 轮播状态：Idle/Starting/Running/Stopping
    control_flags: Arc<AtomicU8>, // 轮播线程控制标志位
    notify: Arc<Notify>,          // 唤醒轮播线程（手动切换/重置）
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
            running: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(STATE_IDLE)),
            control_flags: Arc::new(AtomicU8::new(0)),
            notify: Arc::new(Notify::new()),
        }
    }

    fn spawn_task(&self) {
        let running = Arc::clone(&self.running);
        let state = Arc::clone(&self.state);
        let notify = Arc::clone(&self.notify);
        let control_flags = Arc::clone(&self.control_flags);

        tauri::async_runtime::spawn(async move {
            // 线程启动成功，设置状态为“运行中”
            state.store(STATE_RUNNING, Ordering::Release);
            println!("[WALLPAPER_ROTATOR] start");
            // 从用户设置中读取初始 interval
            let initial_interval_secs = Settings::global()
                .get_wallpaper_rotation_interval_minutes()
                .saturating_mul(60)
                .max(60) as u64;

            // 用单一 ticker 控制轮播间隔；手动切换/重置通过 Notify 立即唤醒本线程处理。
            let mut current_interval_secs: u64 = initial_interval_secs;
            let mut ticker = interval(Duration::from_secs(current_interval_secs));

            // 重要：tokio interval 第一次 tick 会立刻触发；我们先消费一次，让“自动轮播”从 interval 后才开始。
            ticker.tick().await;

            loop {
                let woke_by_timer = tokio::select! {
                    _ = ticker.tick() => true,
                    _ = notify.notified() => false, // manual/reset
                };

                // 检查状态：如果是 Stopping 或 running=false，则退出
                let current_state = state.load(Ordering::Acquire);
                if current_state == STATE_STOPPING || !running.load(Ordering::Relaxed) {
                    eprintln!("状态变化，退出轮播线程");
                    break;
                }

                let settings = Settings::global();

                // 未启用轮播：仅保持线程等待（便于后续快速启用），不做任何切换
                if !settings.get_wallpaper_rotation_enabled() {
                    continue;
                }

                // 如果 interval 被用户改了，更新 ticker，并重置定时器让下一次从现在开始计时
                let desired_secs = settings
                    .get_wallpaper_rotation_interval_minutes()
                    .saturating_mul(60)
                    .max(60) as u64;
                if desired_secs != current_interval_secs {
                    current_interval_secs = desired_secs;
                    ticker = interval(Duration::from_secs(current_interval_secs));
                    // 同上：先消费一次“立即 tick”，避免改间隔后立刻切一次
                    ticker.tick().await;
                    continue;
                }

                // 处理控制指令
                let flags = control_flags.swap(0, Ordering::Relaxed);
                if (flags & FLAG_ROTATE) == 0 {
                    if (flags & FLAG_RESET) != 0 {
                        // 仅重置定时器，不触发切换
                        ticker.reset();
                        continue;
                    }
                    if !woke_by_timer {
                        // notify 留下的 permit：标志已在上一轮一并处理（如 rotate 紧跟 reset），
                        // 不能当成定时器到期再切一次
                        continue;
                    }
                }

                if let Err(e) = advance_and_apply().await {
                    eprintln!("[WALLPAPER_ROTATOR] 轮播切换失败: {}", e);
                }

                // 本轮执行完后，让下一次从“现在”开始计时，确保手动切换/模式切换会重置计时器
                ticker.reset();
            }

            // 任务退出：设置状态为"空闲"，确保 running 标志复位，避免"假运行"
            state.store(STATE_IDLE, Ordering::Release);
            running.store(false, Ordering::Relaxed);
        });
    }

    /// 按"当前设置"确保轮播线程存在；未启用轮播时不启动。
    pub async fn start(&self) -> Result<(), String> {
        if !Settings::global().get_wallpaper_rotation_enabled() {
            return Ok(());
        }
        self.ensure_running().await
    }

    /// 确保轮播线程已启动。开启 / 恢复轮播不会立刻换壁纸，首次自动切换发生在 interval 到期后
    /// （或用户手动触发 rotate）；位置沿用设置里保存的值，路径不变就接着上次的下一张。
    pub async fn ensure_running(&self) -> Result<(), String> {
        // 壁纸功能已关闭：静默跳过，不启动轮播线程。
        if Settings::global().get_wallpaper_disabled() {
            return Ok(());
        }
        // 已在运行：设置变化后 reset 让任务按新设置继续运行即可。
        if self.running.load(Ordering::Relaxed) {
            self.reset();
            return Ok(());
        }

        // 未在运行：检查状态，避免并发启动/关闭导致重复 spawn
        let current_state = self.state.load(Ordering::Acquire);
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
        self.state.store(STATE_STARTING, Ordering::Release);

        let start_res: Result<(), String> = async {
            let settings = Settings::global();
            if !settings.get_wallpaper_rotation_enabled() {
                return Err("壁纸轮播未启用".to_string());
            }

            let mode = settings.get_wallpaper_mode();
            let src = tokio::task::spawn_blocking(move || resolve_source(&mode))
                .await
                .map_err(|e| format!("轮播启动校验失败: {e}"))??;
            if src.count == 0 {
                return Err("轮播路径下没有图片".to_string());
            }

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

                self.running.store(true, Ordering::Relaxed);
                self.state.store(STATE_RUNNING, Ordering::Release);
                return Ok(());
            }

            #[cfg(not(target_os = "android"))]
            {
                self.running.store(true, Ordering::Relaxed);
                self.spawn_task();
                Ok(())
            }
        }
        .await;

        if start_res.is_err() {
            // 启动失败：复位状态，避免卡在 starting
            self.state.store(STATE_IDLE, Ordering::Release);
            self.running.store(false, Ordering::Relaxed);
        }

        start_res
    }

    /// 立刻切换到下一张壁纸（用于托盘菜单/快捷操作）
    ///
    /// - 轮播线程正在运行：设置标志位 + notify，由线程立即处理一次切换
    /// - 否则在当前任务里切换一次；轮播已启用则随后启动轮播线程
    pub async fn rotate(&self) -> Result<(), String> {
        // 壁纸功能已关闭：静默跳过，不切换壁纸。
        if Settings::global().get_wallpaper_disabled() {
            return Ok(());
        }
        // 桌面端运行中：轮播线程可能正在 await tick，交给它处理
        #[cfg(not(target_os = "android"))]
        if self.running.load(Ordering::Relaxed) {
            self.control_flags.fetch_or(FLAG_ROTATE, Ordering::Relaxed);
            self.notify.notify_one();
            return Ok(());
        }

        advance_and_apply().await?;
        refresh_android_queue();

        let enabled = Settings::global().get_wallpaper_rotation_enabled();
        if enabled && !self.running.load(Ordering::Relaxed) {
            self.ensure_running().await?;
        }
        Ok(())
    }

    pub fn stop(&self) {
        let current_state = self.state.load(Ordering::Acquire);

        // 如果已经是空闲或关闭中，直接返回
        if current_state == STATE_IDLE || current_state == STATE_STOPPING {
            return;
        }

        // 设置状态为“关闭中”
        self.state.store(STATE_STOPPING, Ordering::Release);
        self.running.store(false, Ordering::Relaxed);
        self.control_flags.fetch_or(FLAG_RESET, Ordering::Relaxed);
        self.notify.notify_one();

        #[cfg(target_os = "android")]
        {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_wallpaper::WallpaperExt;
                let _ = app.wallpaper().cancel_rotation().await;
            });
            self.state.store(STATE_IDLE, Ordering::Release);
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

        self.control_flags.fetch_or(FLAG_RESET, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 获取轮播状态："idle" | "starting" | "running" | "stopping"
    #[allow(dead_code)]
    pub fn get_status(&self) -> String {
        match self.state.load(Ordering::Acquire) {
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
    use super::wrapped_position;

    #[test]
    fn position_past_end_wraps_to_first() {
        assert_eq!(wrapped_position(3, 10), 3);
        assert_eq!(wrapped_position(10, 10), 0);
        assert_eq!(wrapped_position(25, 7), 0);
    }
}
