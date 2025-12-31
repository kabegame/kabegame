use super::manager::WallpaperController;
use crate::settings::Settings;
use crate::storage::Storage;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
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

pub struct WallpaperRotator {
    app: AppHandle,
    running: Arc<AtomicBool>,
    state: Arc<AtomicU8>,             // 轮播状态：Idle/Starting/Running/Stopping
    current_index: Arc<Mutex<usize>>, // 用于顺序模式
    control_flags: Arc<AtomicU8>,     // 轮播线程控制标志位
    notify: Arc<Notify>,              // 唤醒轮播线程（手动切换/重置）
}

impl WallpaperRotator {
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

    fn source_from_settings(settings: &crate::settings::AppSettings) -> Option<RotationSource> {
        match settings.wallpaper_rotation_album_id.as_deref() {
            None => None,
            Some(id) if id.trim().is_empty() => Some(RotationSource::Gallery),
            Some(id) => Some(RotationSource::Album(id.to_string())),
        }
    }

    fn load_images_for_source(
        app: &AppHandle,
        source: &RotationSource,
    ) -> Result<Vec<crate::storage::ImageInfo>, String> {
        let storage = app
            .try_state::<Storage>()
            .ok_or_else(|| "无法获取存储状态".to_string())?;
        match source {
            RotationSource::Album(id) => {
                if !storage.album_exists(id)? {
                    return Err("画册不存在".to_string());
                }
                storage.get_album_images(id)
            }
            RotationSource::Gallery => storage.get_all_images(),
        }
    }

    fn get_current_wallpaper_path(app: &AppHandle) -> Option<String> {
        let settings = app.try_state::<Settings>()?.get_settings().ok()?;
        let id = settings.current_wallpaper_image_id?;
        let storage = app.try_state::<Storage>()?;
        let img = storage.find_image_by_id(&id).ok().flatten()?;
        // 轮播对齐/排除当前壁纸时，只对“真实存在的文件”生效
        if Path::new(&img.local_path).exists() {
            Some(img.local_path)
        } else {
            None
        }
    }

    fn align_sequential_index_from_current(
        &self,
        images: &[crate::storage::ImageInfo],
        current_path: &str,
    ) {
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

    fn spawn_thread(&self) {
        let app = self.app.clone();
        let running = Arc::clone(&self.running);
        let state = Arc::clone(&self.state);
        let current_index = Arc::clone(&self.current_index);
        let notify = Arc::clone(&self.notify);
        let control_flags = Arc::clone(&self.control_flags);

        // 在新线程中创建 Tokio runtime
        std::thread::spawn(move || {
            // 创建新的 Tokio runtime
            let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                // 线程启动成功，设置状态为“运行中”
                state.store(STATE_RUNNING, Ordering::Release);
                // 从用户设置中读取初始 interval
                let initial_interval_secs = {
                    if let Some(settings_state) = app.try_state::<Settings>() {
                        if let Ok(settings) = settings_state.get_settings() {
                            (settings.wallpaper_rotation_interval_minutes as u64)
                                .saturating_mul(60)
                                .max(60)
                        } else {
                            60
                        }
                    } else {
                        60
                    }
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

                    // 检查状态：如果是 Stopping 或 running=false，则退出
                    let current_state = state.load(Ordering::Acquire);
                    if current_state == STATE_STOPPING || !running.load(Ordering::Relaxed) {
                        break;
                    }

                    // 获取设置
                    let settings_state = match app.try_state::<Settings>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取设置状态");
                            // 设置状态缺失：停止线程，避免 running 假死
                            break;
                        }
                    };
                    let settings = match settings_state.get_settings() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("获取设置失败: {}", e);
                            break;
                        }
                    };

                    // 未启用轮播：仅保持线程等待（便于后续快速启用），不做任何切换
                    if !settings.wallpaper_rotation_enabled {
                        continue;
                    }

                    // 如果 interval 被用户改了，更新 ticker，并重置定时器让下一次从现在开始计时
                    let desired_secs = (settings.wallpaper_rotation_interval_minutes as u64)
                        .saturating_mul(60)
                        .max(60);
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
                    let source = match Self::source_from_settings(&settings) {
                        Some(s) => s,
                        None => {
                            // 未设置来源：不做切换（线程不退出，避免 running 假死）
                            continue;
                        }
                    };

                    // 获取图片列表
                    let mut source = source;
                    let mut images = match Self::load_images_for_source(&app, &source) {
                        Ok(imgs) => imgs,
                        Err(e) => {
                            // 画册不存在：回退到画廊
                            if e.contains("画册不存在") {
                                if let Ok(_) =
                                    settings_state.set_wallpaper_rotation_album_id(Some("".to_string()))
                                {
                                    source = RotationSource::Gallery;
                                    Self::load_images_for_source(&app, &source).unwrap_or_default()
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
                                if settings_state
                                    .set_wallpaper_rotation_album_id(Some("".to_string()))
                                    .is_ok()
                                {
                                    source = RotationSource::Gallery;
                                    images =
                                        Self::load_images_for_source(&app, &source).unwrap_or_default();
                                }
                            }
                            RotationSource::Gallery => {}
                        }

                        if images.is_empty() {
                            // 画廊也没有：降级到非轮播
                            let _ = settings_state.set_wallpaper_rotation_enabled(false);
                            let _ = settings_state.set_wallpaper_rotation_album_id(None);
                            let _ = settings_state.set_current_wallpaper_image_id(None);
                        }
                        continue;
                    }

                    // 选择图片
                    let selected_image = match settings.wallpaper_rotation_mode.as_str() {
                        "sequential" => {
                            // 顺序模式：从 current_index 开始，顺序找到第一张存在的图片
                            let mut idx = match current_index.lock() {
                                Ok(i) => i,
                                Err(_) => continue,
                            };
                            let start_idx = *idx;
                            let mut selected: Option<crate::storage::ImageInfo> = None;
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
                            let current_wallpaper_path = Self::get_current_wallpaper_path(&app);
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

                    // 设置壁纸
                    let wallpaper_path = selected_image.local_path.clone();

                    let controller = match app.try_state::<WallpaperController>() {
                        Some(c) => c,
                        None => {
                            eprintln!("无法获取 WallpaperController 状态");
                            break;
                        }
                    };
                    let manager = match controller.active_manager() {
                        Ok(m) => m,
                        Err(e) => {
                            eprintln!("获取壁纸后端失败: {}", e);
                            continue;
                        }
                    };

                    let style = match manager.get_style() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("获取壁纸样式失败: {}", e);
                            continue;
                        }
                    };
                    let transition = match manager.get_transition() {
                        Ok(t) => t,
                        Err(e) => {
                            eprintln!("获取壁纸过渡效果失败: {}", e);
                            continue;
                        }
                    };
                    if let Err(e) = manager.set_wallpaper(&wallpaper_path, &style, &transition) {
                        eprintln!("设置壁纸失败: {}", e);
                        continue;
                    }

                    // 同步更新全局“当前壁纸”（imageId）
                    let _ = settings_state
                        .set_current_wallpaper_image_id(Some(selected_image.id.clone()));

                    // 本轮执行完后，让下一次从“现在”开始计时，确保手动切换/模式切换会重置计时器
                    ticker.reset();
                }

                // 线程退出：设置状态为"空闲"，确保 running 标志复位，避免"假运行"
                state.store(STATE_IDLE, Ordering::Release);
                running.store(false, Ordering::Relaxed);
            });
        });
    }

    pub fn start(&self) -> Result<(), String> {
        // 兼容旧调用点：start() 尝试按“当前设置”确保轮播线程存在。
        // 注意：如果用户未启用轮播或未选择来源（album_id=None），这里不会强制启动线程。
        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;
        if !settings.wallpaper_rotation_enabled {
            return Ok(());
        }
        let start_from_current = settings
            .wallpaper_rotation_album_id
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(false);
        self.ensure_running(start_from_current)
    }

    /// 确保轮播线程已启动（必要时会做一次“启动前验证/首张壁纸兜底”）。
    ///
    /// - start_from_current=true：当轮播来源为“画廊”（album_id="") 时，优先从当前壁纸开始（不立刻换壁纸）。
    /// - 注意：开启/切换轮播不会立刻切换当前壁纸；首次自动切换发生在 interval 到期后（或用户手动触发 rotate）。
    pub fn ensure_running(&self, start_from_current: bool) -> Result<(), String> {
        // 已在运行：切换轮播来源时不应报错，直接 reset 让线程按新设置继续运行即可。
        if self.running.load(Ordering::Relaxed) {
            if start_from_current {
                if let Some(settings_state) = self.app.try_state::<Settings>() {
                    if let Ok(settings) = settings_state.get_settings() {
                        if matches!(
                            Self::source_from_settings(&settings),
                            Some(RotationSource::Gallery)
                        ) && settings.wallpaper_rotation_mode == "sequential"
                        {
                            if let Ok(images) =
                                Self::load_images_for_source(&self.app, &RotationSource::Gallery)
                            {
                                if let Some(cur) = Self::get_current_wallpaper_path(&self.app) {
                                    self.align_sequential_index_from_current(&images, &cur);
                                }
                            }
                        }
                    }
                }
            }
            self.reset();
            return Ok(());
        }

        let start_res: Result<(), String> = (|| {
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

            let settings_state = self
                .app
                .try_state::<Settings>()
                .ok_or_else(|| "无法获取设置状态".to_string())?;
            let settings = settings_state
                .get_settings()
                .map_err(|e| format!("获取设置失败: {}", e))?;
            if !settings.wallpaper_rotation_enabled {
                return Err("壁纸轮播未启用".to_string());
            }
            let source = Self::source_from_settings(&settings)
                .ok_or_else(|| "未选择轮播来源（画册/画廊）".to_string())?;

            let images = Self::load_images_for_source(&self.app, &source)?;
            if images.is_empty() {
                return Err(match source {
                    RotationSource::Album(_) => "画册内没有图片".to_string(),
                    RotationSource::Gallery => "画廊内没有图片".to_string(),
                });
            }

            // 尽量基于当前壁纸对齐顺序索引（不触发立即切换）
            let current_path = Self::get_current_wallpaper_path(&self.app);
            if let Some(cur) = current_path.as_deref() {
                if images
                    .iter()
                    .any(|img| Self::normalize_path(&img.local_path) == Self::normalize_path(cur))
                {
                    if settings.wallpaper_rotation_mode == "sequential" {
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
            self.spawn_thread();
            Ok(())
        })();

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
    pub fn rotate(&self) -> Result<(), String> {
        use tauri::Manager;

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
        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        let source = Self::source_from_settings(&settings)
            .ok_or_else(|| "未选择轮播来源（画册/画廊）".to_string())?;

        let mut source = source;
        let mut images = Self::load_images_for_source(&self.app, &source).unwrap_or_default();

        // 无可用图片：画册->画廊->关闭轮播并清空 currentWallpaperImageId
        if images.is_empty() {
            if matches!(source, RotationSource::Album(_)) {
                // 回退到画廊
                let _ = settings_state.set_wallpaper_rotation_album_id(Some("".to_string()));
                source = RotationSource::Gallery;
                images = Self::load_images_for_source(&self.app, &source).unwrap_or_default();
            }

            if images.is_empty() {
                // 画廊也没有：降级到非轮播
                let _ = settings_state.set_wallpaper_rotation_enabled(false);
                let _ = settings_state.set_wallpaper_rotation_album_id(None);
                let _ = settings_state.set_current_wallpaper_image_id(None);
                return Ok(());
            }
        }

        // 选择图片
        let selected_image = match settings.wallpaper_rotation_mode.as_str() {
            "sequential" => {
                // 顺序模式：从当前索引开始，顺序找到第一张存在的图片
                let mut idx = self
                    .current_index
                    .lock()
                    .map_err(|e| format!("无法获取顺序索引: {}", e))?;
                let start_idx = *idx;
                let mut found = false;
                let mut selected: Option<crate::storage::ImageInfo> = None;

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
                let existing_images: Vec<&crate::storage::ImageInfo> = images
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
        let controller = self.app.state::<WallpaperController>();
        let manager = controller.active_manager()?;

        manager.set_wallpaper(
            &wallpaper_path,
            &settings.wallpaper_rotation_style,
            &settings.wallpaper_rotation_transition,
        )?;

        println!("壁纸已更换: {}", wallpaper_path);

        // 同步更新全局“当前壁纸”（imageId）
        let _ = settings_state
            .set_current_wallpaper_image_id(Some(selected_image.id.clone()));

        // 如果轮播已启用但未运行，启动轮播器
        if settings.wallpaper_rotation_enabled && !self.running.load(Ordering::Relaxed) {
            // 这里不要求“从当前壁纸开始”，因为 rotate 本身就是用户手动触发的一次切换
            self.ensure_running(false)?;
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
