use super::manager::WallpaperController;
use kabegame_core::settings::Settings;
use kabegame_core::storage::{ImageInfo, Storage};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

// 轮播线程控制标志位
const FLAG_ROTATE: u8 = 1; // 立即切换壁纸
const FLAG_RESET: u8 = 2; // 重置定时器

// 轮播状态
const STATE_IDLE: u8 = 0; // 空闲
const STATE_STARTING: u8 = 1; // 开启中
const STATE_RUNNING: u8 = 2; // 运行中
const STATE_STOPPING: u8 = 3; // 关闭中

#[derive(Debug, Clone)]
enum RotationSource {
    Album(String),
    Gallery,
}

#[derive(Debug, Clone)]
struct ImageLite {
    id: String,
    local_path: String,
}

pub struct WallpaperRotator {
    app: AppHandle,
    running: Arc<AtomicBool>,
    state: Arc<AtomicU8>,             // 轮播状态：Idle/Starting/Running/Stopping
    current_index: Arc<Mutex<usize>>, // 用于顺序模式
    control_flags: Arc<AtomicU8>,     // 轮播线程控制标志位
    notify: Arc<Notify>,              // 唤醒轮播线程（手动切换/重置）
}

// 全局 WallpaperRotator 单例
static WALLPAPER_ROTATOR: OnceLock<WallpaperRotator> = OnceLock::new();

impl WallpaperRotator {
    /// 初始化全局 WallpaperRotator（必须在首次使用前调用）
    pub fn init_global(app: AppHandle) -> Result<(), String> {
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

    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            running: Arc::new(AtomicBool::new(false)),
            state: Arc::new(AtomicU8::new(STATE_IDLE)),
            current_index: Arc::new(Mutex::new(0)),
            control_flags: Arc::new(AtomicU8::new(0)),
            notify: Arc::new(Notify::new()),
        }
    }

    fn normalize_path(p: &str) -> String {
        // Windows 下避免因为 \\?\ 前缀 / 斜杠方向 / 大小写导致“当前壁纸”比对失败
        p.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_ascii_lowercase()
    }

    fn images_from_info(v: Vec<ImageInfo>) -> Vec<ImageLite> {
        let mut out: Vec<ImageLite> = Vec::with_capacity(v.len());
        for it in v {
            out.push(ImageLite {
                id: it.id,
                local_path: it.local_path,
            });
        }
        out
    }

    async fn load_images_for_source(source: &RotationSource) -> Result<Vec<ImageLite>, String> {
        match source {
            RotationSource::Album(id) => {
                let v = Storage::global()
                    .get_album_images(id)
                    .map_err(|e| format!("Storage error: {}", e))?;
                Ok(Self::images_from_info(v))
            }
            RotationSource::Gallery => {
                let v = Storage::global()
                    .get_all_images()
                    .map_err(|e| format!("Storage error: {}", e))?;
                Ok(Self::images_from_info(v))
            }
        }
    }

    async fn get_current_wallpaper_path(_app: &AppHandle) -> Option<String> {
        let id = Settings::global()
            .get_current_wallpaper_image_id()
            .await
            .ok()
            .flatten()?;
        let img = Storage::global().find_image_by_id(&id).ok().flatten()?;
        let p = img.local_path;
        if Path::new(&p).exists() {
            Some(p)
        } else {
            None
        }
    }

    fn align_sequential_index_from_current(&self, images: &[ImageLite], current_path: &str) {
        let cur = Self::normalize_path(current_path);
        if let Some(pos) = images
            .iter()
            .position(|img| Self::normalize_path(&img.local_path) == cur)
        {
            if let Ok(mut idx) = self.current_index.lock() {
                *idx = (pos + 1) % images.len();
            }
        }
    }

    fn spawn_task(&self) {
        let app = self.app.clone();
        let running = Arc::clone(&self.running);
        let state = Arc::clone(&self.state);
        let current_index = Arc::clone(&self.current_index);
        let notify = Arc::clone(&self.notify);
        let control_flags = Arc::clone(&self.control_flags);

        tauri::async_runtime::spawn(async move {
            // 线程启动成功，设置状态为“运行中”
            state.store(STATE_RUNNING, Ordering::Release);
            // 从用户设置中读取初始 interval
            let initial_interval_secs = {
                Settings::global()
                    .get_wallpaper_rotation_interval_minutes()
                    .await
                    .unwrap_or(1)
                    .saturating_mul(60)
                    .max(60) as u64
            };

            // 用单一 ticker 控制轮播间隔；手动切换/重置通过 Notify 立即唤醒本线程处理。
            let mut current_interval_secs: u64 = initial_interval_secs;
            let mut ticker = interval(Duration::from_secs(current_interval_secs));

            // 重要：tokio interval 第一次 tick 会立刻触发；我们先消费一次，让“自动轮播”从 interval 后才开始。
            ticker.tick().await;

            loop {
                tokio::select! {
                    _ = ticker.tick() => { /* timer */ }
                    _ = notify.notified() => { /* manual/reset */ }
                }

                eprintln!("尝试轮播下一张");

                // 检查状态：如果是 Stopping 或 running=false，则退出
                let current_state = state.load(Ordering::Acquire);
                if current_state == STATE_STOPPING || !running.load(Ordering::Relaxed) {
                    eprintln!("状态变化，退出轮播线程");
                    break;
                }

                // 获取设置
                let settings = Settings::global();
                let (enabled_result, mode_result, interval_result) = tokio::join!(
                    settings.get_wallpaper_rotation_enabled(),
                    settings.get_wallpaper_mode(),
                    settings.get_wallpaper_rotation_interval_minutes()
                );

                // 如果获取设置失败，跳过
                let enabled = match enabled_result {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("获取设置失败: {}", e);
                        continue;
                    }
                };

                // 未启用轮播：仅保持线程等待（便于后续快速启用），不做任何切换
                if !enabled {
                    eprintln!("未启用轮播，跳过");
                    continue;
                }

                // Plasma 插件模式：不执行实际切换（避免干扰 Plasma 插件的壁纸管理）
                // 但保持线程运行，以便后续切换模式时能快速恢复
                if mode_result.unwrap_or_default() == "plasma-plugin" {
                    continue;
                }

                // 如果 interval 被用户改了，更新 ticker，并重置定时器让下一次从现在开始计时
                let desired_secs = interval_result.unwrap_or(1).saturating_mul(60).max(60) as u64;
                if desired_secs != current_interval_secs {
                    current_interval_secs = desired_secs;
                    ticker = interval(Duration::from_secs(current_interval_secs));
                    // 同上：先消费一次“立即 tick”，避免改间隔后立刻切一次
                    ticker.tick().await;
                    continue;
                }

                // 处理控制指令
                let flags = control_flags.swap(0, Ordering::Relaxed);
                if (flags & FLAG_RESET) != 0 && (flags & FLAG_ROTATE) == 0 {
                    // 仅重置定时器，不触发切换
                    ticker.reset();
                    continue;
                }

                // 选择轮播来源：画册 / 画廊
                let album_id_result = settings.get_wallpaper_rotation_album_id().await;
                let source = match album_id_result {
                    Ok(Some(id)) if !id.trim().is_empty() => RotationSource::Album(id),
                    Ok(Some(_)) | Ok(None) => RotationSource::Gallery,
                    Err(_) => {
                        // 获取设置失败：不做切换（线程不退出，避免 running 假死）
                        eprintln!("获取轮播来源失败");
                        continue;
                    }
                };

                // 获取图片列表
                let mut source = source;
                let mut images = match Self::load_images_for_source(&source).await {
                    Ok(imgs) => imgs,
                    Err(e) => {
                        // 画册不存在：回退到画廊
                        if e.contains("画册不存在") {
                            if settings
                                .set_wallpaper_rotation_album_id(Some("".to_string()))
                                .await
                                .is_ok()
                            {
                                source = RotationSource::Gallery;
                                Self::load_images_for_source(&source)
                                    .await
                                    .unwrap_or_default()
                            } else {
                                eprintln!("获取轮播图片失败: {}", e);
                                Vec::new()
                            }
                        } else {
                            eprintln!("获取轮播图片失败: {}", e);
                            Vec::new()
                        }
                    }
                };

                // 无可用图片：画册->画廊->关闭轮播并清空 currentWallpaperImageId
                if images.is_empty() {
                    match source {
                        RotationSource::Album(_) => {
                            // 先回退到画廊
                            if settings
                                .set_wallpaper_rotation_album_id(Some("".to_string()))
                                .await
                                .is_ok()
                            {
                                source = RotationSource::Gallery;
                                images = Self::load_images_for_source(&source)
                                    .await
                                    .unwrap_or_default();
                            }
                        }
                        RotationSource::Gallery => {}
                    }

                    if images.is_empty() {
                        // 画廊也没有：降级到非轮播
                        let _ = settings.set_wallpaper_rotation_enabled(false).await;
                        let _ = settings.set_wallpaper_rotation_album_id(None).await;
                        let _ = settings.set_current_wallpaper_image_id(None).await;
                    }
                    eprintln!("无可用轮播图片，退出");
                    continue;
                }

                // 选择图片
                let rotation_mode = settings
                    .get_wallpaper_rotation_mode()
                    .await
                    .unwrap_or_else(|_| "random".to_string());
                let selected_image = match rotation_mode.as_str() {
                    "sequential" => {
                        // 顺序模式：从 current_index 开始，顺序找到第一张存在的图片
                        let mut idx = match current_index.lock() {
                            Ok(i) => i,
                            Err(_) => continue,
                        };
                        let start_idx = *idx;
                        let mut selected: Option<ImageLite> = None;
                        for i in 0..images.len() {
                            let current_idx = (start_idx + i) % images.len();
                            let image = &images[current_idx];
                            if Path::new(&image.local_path).exists() {
                                selected = Some(image.clone());
                                *idx = (current_idx + 1) % images.len();
                                break;
                            }
                        }
                        match selected {
                            Some(s) => s,
                            None => continue,
                        }
                    }
                    _ => {
                        // 随机模式：尽量排除当前壁纸
                        let current_wallpaper_path = Self::get_current_wallpaper_path(&app).await;
                        let current_norm =
                            current_wallpaper_path.as_deref().map(Self::normalize_path);

                        let existing_indices: Vec<usize> = images
                            .iter()
                            .enumerate()
                            .filter_map(|(idx, img)| {
                                if !Path::new(&img.local_path).exists() {
                                    return None;
                                }
                                if let Some(ref cur) = current_norm {
                                    if Self::normalize_path(&img.local_path) == *cur {
                                        return None;
                                    }
                                }
                                Some(idx)
                            })
                            .collect();

                        let candidates = if existing_indices.is_empty() {
                            // 没有候选：退化为“任意存在的图片”
                            images
                                .iter()
                                .enumerate()
                                .filter_map(|(idx, img)| {
                                    if Path::new(&img.local_path).exists() {
                                        Some(idx)
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>()
                        } else {
                            existing_indices
                        };
                        if candidates.is_empty() {
                            continue;
                        }
                        let random_idx = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos() as usize)
                            % candidates.len();
                        images[candidates[random_idx]].clone()
                    }
                };

                eprintln!("选择图片 {}", selected_image.local_path);

                // 设置壁纸
                let wallpaper_path = selected_image.local_path.clone();

                let controller = WallpaperController::global();
                let manager = match controller.active_manager().await {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("获取壁纸后端失败: {}", e);
                        continue;
                    }
                };

                let style = match manager.get_style().await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("获取壁纸样式失败: {}", e);
                        continue;
                    }
                };
                let transition = match manager.get_transition().await {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("获取壁纸过渡效果失败: {}", e);
                        continue;
                    }
                };
                if let Err(e) = manager
                    .set_wallpaper(&wallpaper_path, &style, &transition)
                    .await
                {
                    eprintln!("设置壁纸失败: {}", e);
                    continue;
                }

                // 同步更新全局“当前壁纸”（imageId）
                let _ = settings
                    .set_current_wallpaper_image_id(Some(selected_image.id.clone()))
                    .await;

                // 本轮执行完后，让下一次从“现在”开始计时，确保手动切换/模式切换会重置计时器
                ticker.reset();
            }

            // 任务退出：设置状态为"空闲"，确保 running 标志复位，避免"假运行"
            state.store(STATE_IDLE, Ordering::Release);
            running.store(false, Ordering::Relaxed);
        });
    }

    pub async fn start(&self) -> Result<(), String> {
        // 兼容旧调用点：start() 尝试按"当前设置"确保轮播线程存在。
        // 注意：如果用户未启用轮播或未选择来源（album_id=None），这里不会强制启动线程。
        let settings = Settings::global();
        let enabled = settings
            .get_wallpaper_rotation_enabled()
            .await
            .map_err(|e| format!("Settings error: {}", e))?;
        if !enabled {
            return Ok(());
        }
        let album_id = settings
            .get_wallpaper_rotation_album_id()
            .await
            .ok()
            .flatten();
        let start_from_current = album_id
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(false);
        self.ensure_running(start_from_current).await
    }

    /// 确保轮播线程已启动（必要时会做一次“启动前验证/首张壁纸兜底”）。
    ///
    /// - start_from_current=true：当轮播来源为“画廊”（album_id="") 时，优先从当前壁纸开始（不立刻换壁纸）。
    /// - 注意：开启/切换轮播不会立刻切换当前壁纸；首次自动切换发生在 interval 到期后（或用户手动触发 rotate）。
    pub async fn ensure_running(&self, start_from_current: bool) -> Result<(), String> {
        // 已在运行：切换轮播来源时不应报错，直接 reset 让任务按新设置继续运行即可。
        if self.running.load(Ordering::Relaxed) {
            if start_from_current {
                // 画廊顺序模式：对齐 current_index 到"当前壁纸之后"
                let settings = Settings::global();
                let (album_id_result, mode_result) = tokio::join!(
                    settings.get_wallpaper_rotation_album_id(),
                    settings.get_wallpaper_rotation_mode()
                );
                let is_gallery = album_id_result
                    .ok()
                    .flatten()
                    .as_deref()
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(false);
                let is_seq = mode_result.unwrap_or_else(|_| "random".to_string()) == "sequential";
                if is_gallery && is_seq {
                    if let Ok(images) = Self::load_images_for_source(&RotationSource::Gallery).await
                    {
                        if let Some(cur) = Self::get_current_wallpaper_path(&self.app).await {
                            self.align_sequential_index_from_current(&images, &cur);
                        }
                    }
                }
            }
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
            let enabled = settings
                .get_wallpaper_rotation_enabled()
                .await
                .map_err(|e| format!("Settings error: {}", e))?;
            if !enabled {
                return Err("壁纸轮播未启用".to_string());
            }

            let album_id = settings
                .get_wallpaper_rotation_album_id()
                .await
                .map_err(|e| format!("Settings error: {}", e))?;
            let source = match album_id {
                Some(id) if !id.trim().is_empty() => RotationSource::Album(id),
                _ => RotationSource::Gallery,
            };

            let images = Self::load_images_for_source(&source).await?;
            if images.is_empty() {
                return Err(match source {
                    RotationSource::Album(_) => "画册内没有图片".to_string(),
                    RotationSource::Gallery => "画廊内没有图片".to_string(),
                });
            }

            // 尽量基于当前壁纸对齐顺序索引（不触发立即切换）
            let current_path = Self::get_current_wallpaper_path(&self.app).await;
            if let Some(cur) = current_path.as_deref() {
                if images
                    .iter()
                    .any(|img| Self::normalize_path(&img.local_path) == Self::normalize_path(cur))
                {
                    let rotation_mode = settings
                        .get_wallpaper_rotation_mode()
                        .await
                        .unwrap_or_else(|_| "random".to_string());
                    if rotation_mode == "sequential" {
                        // 顺序模式：让下一次轮播从 current 后一张开始
                        self.align_sequential_index_from_current(&images, cur);
                    }
                }
            }

            // 兼容旧语义：start_from_current 目前只影响“画廊轮播”下的顺序对齐；
            // 但无论如何，我们都不在启动时 set_wallpaper（遵循“开启不换壁纸”原则）。
            if start_from_current {
                // no-op：逻辑已由上面的对齐处理覆盖
            }

            self.running.store(true, Ordering::Relaxed);
            self.spawn_task();
            Ok(())
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
    /// - 如果轮播器正在运行，使用 interval 的 reset_immediately 来立即触发切换
    /// - 如果轮播已启用但未运行，直接 start 一个实例
    /// - 如果轮播未启用，执行一次壁纸切换（需要画册ID）
    /// - 依赖当前设置：画册、随机/顺序、原生/窗口模式、style/transition
    pub async fn rotate(&self) -> Result<(), String> {
        // 检查轮播器是否正在运行
        if self.running.load(Ordering::Relaxed) {
            // 轮播线程里可能正在 await tick；如果这里去抢 std::sync::Mutex 会卡住很久。
            // 改为：设置标志位 + notify，轮播线程会立即处理一次切换。
            self.control_flags.fetch_or(FLAG_ROTATE, Ordering::Relaxed);
            self.notify.notify_one();
            return Ok(());
        }
        println!("[DEBUG] 切换 轮播器没有运行，启动");

        // 获取设置
        let settings = Settings::global();
        let album_id = settings
            .get_wallpaper_rotation_album_id()
            .await
            .map_err(|e| format!("Settings error: {}", e))?;
        let source = match album_id {
            Some(id) if !id.trim().is_empty() => RotationSource::Album(id),
            _ => RotationSource::Gallery,
        };

        let mut source = source;
        let mut images = Self::load_images_for_source(&source)
            .await
            .unwrap_or_default();

        // 无可用图片：画册->画廊->关闭轮播并清空 currentWallpaperImageId
        if images.is_empty() {
            if matches!(source, RotationSource::Album(_)) {
                // 回退到画廊
                let _ = settings
                    .set_wallpaper_rotation_album_id(Some("".to_string()))
                    .await;
                source = RotationSource::Gallery;
                images = Self::load_images_for_source(&source)
                    .await
                    .unwrap_or_default();
            }

            if images.is_empty() {
                // 画廊也没有：降级到非轮播
                let _ = settings.set_wallpaper_rotation_enabled(false).await;
                let _ = settings.set_wallpaper_rotation_album_id(None).await;
                let _ = settings.set_current_wallpaper_image_id(None).await;
                return Ok(());
            }
        }

        // 选择图片
        let rotation_mode = settings
            .get_wallpaper_rotation_mode()
            .await
            .unwrap_or_else(|_| "random".to_string());
        let selected_image = match rotation_mode.as_str() {
            "sequential" => {
                // 顺序模式：从当前索引开始，顺序找到第一张存在的图片
                let mut idx = self
                    .current_index
                    .lock()
                    .map_err(|e| format!("无法获取顺序索引: {}", e))?;
                let start_idx = *idx;
                let mut found = false;
                let mut selected: Option<ImageLite> = None;

                // 从当前索引开始循环查找
                for i in 0..images.len() {
                    let current_idx = (start_idx + i) % images.len();
                    let image = &images[current_idx];
                    if Path::new(&image.local_path).exists() {
                        selected = Some(image.clone());
                        *idx = (current_idx + 1) % images.len();
                        found = true;
                        break;
                    }
                }

                if !found {
                    return Err("顺序模式下没有找到存在的图片".to_string());
                }

                selected.unwrap()
            }
            _ => {
                // 随机模式：找到所有存在的图片，然后随机抽取一张
                let existing_images: Vec<&ImageLite> = images
                    .iter()
                    .filter(|img| Path::new(&img.local_path).exists())
                    .collect();

                if existing_images.is_empty() {
                    return Err("随机模式下没有找到存在的图片".to_string());
                }

                // 随机选择一张
                let random_idx = (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos() as usize)
                    % existing_images.len();
                existing_images[random_idx].clone()
            }
        };

        // 设置壁纸
        let wallpaper_path = selected_image.local_path.clone();

        // 使用壁纸管理器设置壁纸
        let controller = WallpaperController::global();
        let manager = controller.active_manager().await?;

        let (style_result, transition_result) = tokio::join!(
            settings.get_wallpaper_rotation_style(),
            settings.get_wallpaper_rotation_transition()
        );
        let style = style_result.unwrap_or_else(|_| "fill".to_string());
        let transition = transition_result.unwrap_or_else(|_| "none".to_string());
        manager
            .set_wallpaper(&wallpaper_path, &style, &transition)
            .await?;

        println!("壁纸已更换: {}", wallpaper_path);

        // 同步更新全局"当前壁纸"（imageId）
        let _ = settings
            .set_current_wallpaper_image_id(Some(selected_image.id.clone()))
            .await;

        // 如果轮播已启用但未运行，启动轮播器
        let enabled = settings
            .get_wallpaper_rotation_enabled()
            .await
            .unwrap_or(false);
        if enabled && !self.running.load(Ordering::Relaxed) {
            // 这里不要求“从当前壁纸开始”，因为 rotate 本身就是用户手动触发的一次切换
            self.ensure_running(false).await?;
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

        // 注意：这里不等待线程退出，线程会在检查到 STATE_STOPPING 后自行退出并设置为 STATE_IDLE
    }

    /// 重置定时器，使其从当前时间重新开始计算间隔
    pub fn reset(&self) {
        self.control_flags.fetch_or(FLAG_RESET, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 获取轮播状态："idle" | "starting" | "running" | "stopping"
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
