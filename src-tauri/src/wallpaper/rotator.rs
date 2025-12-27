use super::manager::{WallpaperController, WallpaperManager};
use crate::settings::Settings;
use crate::storage::Storage;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

pub struct WallpaperRotator {
    app: AppHandle,
    running: Arc<AtomicBool>,
    current_index: Arc<Mutex<usize>>, // 用于顺序模式
    control_flags: Arc<AtomicU8>,     // 轮播线程控制标志位
    notify: Arc<Notify>,              // 唤醒轮播线程（手动切换/重置）
}

impl WallpaperRotator {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            running: Arc::new(AtomicBool::new(false)),
            current_index: Arc::new(Mutex::new(0)),
            control_flags: Arc::new(AtomicU8::new(0)),
            notify: Arc::new(Notify::new()),
        }
    }

    fn active_manager(&self) -> Result<Arc<dyn WallpaperManager + Send + Sync>, String> {
        let controller = self.app.state::<WallpaperController>();
        controller.active_manager()
    }

    pub fn start(&self) -> Result<(), String> {
        if self.running.load(Ordering::Relaxed) {
            return Ok(()); // 已经在运行
        }

        self.running.store(true, Ordering::Relaxed);
        let app = self.app.clone();
        let running = Arc::clone(&self.running);
        let current_index = Arc::clone(&self.current_index);
        let notify = Arc::clone(&self.notify);
        let control_flags = Arc::clone(&self.control_flags);

        // 在新线程中创建 Tokio runtime
        std::thread::spawn(move || {
            // 创建新的 Tokio runtime
            let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                use tauri::Manager;
                const FLAG_ROTATE: u8 = 1;
                const FLAG_RESET: u8 = 2;

                // 用单一 ticker 控制轮播间隔；手动切换/重置通过 Notify 立即唤醒本线程处理。
                let mut current_interval_secs: u64 = 60;
                let mut ticker = interval(Duration::from_secs(current_interval_secs));

                loop {
                    tokio::select! {
                        _ = ticker.tick() => { /* timer */ }
                        _ = notify.notified() => { /* manual/reset */ }
                    }

                    if !running.load(Ordering::Relaxed) {
                        break;
                    }

                    // 获取设置
                    let settings_state = match app.try_state::<Settings>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取设置状态");
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

                    // 如果 interval 被用户改了，更新 ticker，并让下一次从现在开始计时
                    let desired_secs = (settings.wallpaper_rotation_interval_minutes as u64)
                        .saturating_mul(60)
                        .max(60);
                    if desired_secs != current_interval_secs {
                        current_interval_secs = desired_secs;
                        ticker = interval(Duration::from_secs(current_interval_secs));
                        ticker.reset();
                    }

                    // 处理控制指令
                    let flags = control_flags.swap(0, Ordering::Relaxed);
                    if (flags & FLAG_RESET) != 0 && (flags & FLAG_ROTATE) == 0 {
                        // 仅重置定时器，不触发切换
                        ticker.reset();
                        continue;
                    }

                    // 检查是否有选中的画册
                    let album_id: String = match &settings.wallpaper_rotation_album_id {
                        Some(id) => id.clone(),
                        None => break,
                    };

                    // 获取画册图片
                    let storage = match app.try_state::<Storage>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取存储状态");
                            continue;
                        }
                    };
                    let images: Vec<crate::storage::ImageInfo> =
                        match storage.get_album_images(&album_id) {
                            Ok(imgs) => imgs,
                            Err(e) => {
                                eprintln!("获取画册图片失败: {}", e);
                                break;
                            }
                        };

                    if images.is_empty() {
                        continue;
                    }

                    // 选择图片
                    let selected_image = match settings.wallpaper_rotation_mode.as_str() {
                        "sequential" => {
                            // 顺序模式：从当前索引开始，顺序找到第一张存在的图片
                            let mut idx = current_index.lock().unwrap();
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
                                // 没有找到存在的图片，continue
                                eprintln!("顺序模式下没有找到存在的图片");
                                continue;
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
                                // 没有找到存在的图片，continue
                                eprintln!("随机模式下没有找到存在的图片");
                                continue;
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

                    if let Err(e) = manager.set_wallpaper(
                        &wallpaper_path,
                        &settings.wallpaper_rotation_style,
                        &settings.wallpaper_rotation_transition,
                    ) {
                        eprintln!("设置壁纸失败: {}", e);
                    }

                    // 保存当前壁纸路径（通过 set_wallpaper_path 已经保存）
                    println!("壁纸已更换: {}", wallpaper_path);

                    // 本轮执行完后，让下一次从“现在”开始计时，确保手动切换/模式切换会重置计时器
                    ticker.reset();
                }
            });
        });

        Ok(())
    }

    /// 轮播层的 transition 预览：立即生效（用于“轮播开启时”的过渡效果设置）。
    pub fn apply_transition_now(&self, transition: &str) -> Result<(), String> {
        let manager = self.active_manager()?;
        manager.set_transition(transition, true)
    }

    /// 立刻切换到下一张壁纸（用于托盘菜单/快捷操作）
    ///
    /// - 如果轮播器正在运行，使用 interval 的 reset_immediately 来立即触发切换
    /// - 如果轮播已启用但未运行，直接 start 一个实例
    /// - 如果轮播未启用，执行一次壁纸切换（需要画册ID）
    /// - 依赖当前设置：画册、随机/顺序、原生/窗口模式、style/transition
    pub fn rotate(&self) -> Result<(), String> {
        use tauri::Manager;
        const FLAG_ROTATE: u8 = 1;

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

        // 检查是否有选中的画册
        let album_id = settings
            .wallpaper_rotation_album_id
            .clone()
            .ok_or_else(|| "未选择用于轮播的画册".to_string())?;

        // 获取画册图片
        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| "无法获取存储状态".to_string())?;
        let images: Vec<crate::storage::ImageInfo> = storage
            .get_album_images(&album_id)
            .map_err(|e| format!("获取画册图片失败: {}", e))?;

        if images.is_empty() {
            return Err("画册内没有图片".to_string());
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

        // 如果轮播已启用但未运行，启动轮播器
        if settings.wallpaper_rotation_enabled && !self.running.load(Ordering::Relaxed) {
            self.start()?;
        }

        Ok(())
    }

    pub fn stop(&self) {
        const FLAG_RESET: u8 = 2;
        self.running.store(false, Ordering::Relaxed);
        self.control_flags.fetch_or(FLAG_RESET, Ordering::Relaxed);
        self.notify.notify_one();
    }

    /// 重置定时器，使其从当前时间重新开始计算间隔
    pub fn reset(&self) {
        const FLAG_RESET: u8 = 2;
        self.control_flags.fetch_or(FLAG_RESET, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 重新应用当前壁纸（使用最新设置）
    /// 如果提供了 style 和 transition 参数，则使用这些参数；否则从设置中读取
    pub fn reapply_current_wallpaper(
        &self,
        style: Option<&str>,
        transition: Option<&str>,
    ) -> Result<(), String> {
        use tauri::Manager;

        println!("[DEBUG] reapply_current_wallpaper 被调用");
        println!(
            "[DEBUG] 传入的参数 - style: {:?}, transition: {:?}",
            style, transition
        );

        // 获取当前壁纸路径
        let wallpaper_path = {
            let manager = self.active_manager()?;
            manager.get_wallpaper_path()?
        };

        println!("[DEBUG] 当前壁纸路径: {}", wallpaper_path);

        // 检查文件是否存在
        if !Path::new(&wallpaper_path).exists() {
            return Err("当前壁纸文件不存在".to_string());
        }

        // 获取设置值：优先使用传入的参数，否则从设置中读取
        let (style_value, transition_value) = if let (Some(s), Some(t)) = (style, transition) {
            println!("[DEBUG] 使用传入的参数: style={}, transition={}", s, t);
            (s.to_string(), t.to_string())
        } else {
            let settings_state = self
                .app
                .try_state::<Settings>()
                .ok_or_else(|| "无法获取设置状态".to_string())?;
            let settings = settings_state
                .get_settings()
                .map_err(|e| format!("获取设置失败: {}", e))?;
            let s = style
                .map(|s| s.to_string())
                .unwrap_or_else(|| settings.wallpaper_rotation_style.clone());
            let t = transition
                .map(|t| t.to_string())
                .unwrap_or_else(|| settings.wallpaper_rotation_transition.clone());
            println!("[DEBUG] 从设置读取的值: style={}, transition={}", s, t);
            (s, t)
        };

        println!(
            "[DEBUG] 最终使用的值: style={}, transition={}",
            style_value, transition_value
        );

        // 使用壁纸管理器设置壁纸
        let manager = self.active_manager()?;
        manager.set_wallpaper(&wallpaper_path, &style_value, &transition_value)
    }
}
