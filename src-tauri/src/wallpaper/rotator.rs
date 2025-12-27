use crate::settings::Settings;
use crate::storage::Storage;
use super::manager::{NativeWallpaperManager, WallpaperManager, WindowWallpaperManager};
#[cfg(target_os = "windows")]
use super::window::WallpaperWindow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{interval, Duration};

pub struct WallpaperRotator {
    app: AppHandle,
    running: Arc<AtomicBool>,
    current_index: Arc<Mutex<usize>>,              // 用于顺序模式
    current_wallpaper: Arc<Mutex<Option<String>>>, // 当前壁纸路径
    #[cfg(target_os = "windows")]
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>, // 窗口壁纸（仅 Windows）
    _native_manager: Arc<NativeWallpaperManager>,
    #[cfg(target_os = "windows")]
    _window_manager: Arc<WindowWallpaperManager>,
}

impl WallpaperRotator {
    pub fn new(app: AppHandle) -> Self {
        #[cfg(target_os = "windows")]
        let wallpaper_window = Arc::new(Mutex::new(None));
        
        let _native_manager = Arc::new(NativeWallpaperManager::new(app.clone()));
        
        #[cfg(target_os = "windows")]
        let _window_manager = Arc::new(WindowWallpaperManager::new(
            app.clone(),
            Arc::clone(&wallpaper_window),
        ));
        
        Self {
            app,
            running: Arc::new(AtomicBool::new(false)),
            current_index: Arc::new(Mutex::new(0)),
            current_wallpaper: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            wallpaper_window,
            _native_manager,
            #[cfg(target_os = "windows")]
            _window_manager,
        }
    }

    /// 根据当前设置获取对应的壁纸管理器
    fn get_wallpaper_manager(&self) -> Result<Box<dyn WallpaperManager + Send + Sync>, String> {
        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        #[cfg(target_os = "windows")]
        {
            if settings.wallpaper_mode == "window" {
                Ok(Box::new(WindowWallpaperManager::new(
                    self.app.clone(),
                    Arc::clone(&self.wallpaper_window),
                )) as Box<dyn WallpaperManager + Send + Sync>)
            } else {
                Ok(Box::new(NativeWallpaperManager::new(self.app.clone()))
                    as Box<dyn WallpaperManager + Send + Sync>)
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            Ok(Box::new(NativeWallpaperManager::new(self.app.clone()))
                as Box<dyn WallpaperManager + Send + Sync>)
        }
    }

    pub fn start(&self) -> Result<(), String> {
        if self.running.load(Ordering::Relaxed) {
            return Ok(()); // 已经在运行
        }

        self.running.store(true, Ordering::Relaxed);
        let app = self.app.clone();
        let running = Arc::clone(&self.running);
        let current_index = Arc::clone(&self.current_index);
        let current_wallpaper = Arc::clone(&self.current_wallpaper);
        #[cfg(target_os = "windows")]
        let wallpaper_window = Arc::clone(&self.wallpaper_window);

        // 在新线程中创建 Tokio runtime
        std::thread::spawn(move || {
            // 创建新的 Tokio runtime
            let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");

            rt.block_on(async move {
                use tauri::Manager;
                let mut interval_timer = interval(Duration::from_secs(60)); // 每分钟检查一次

                loop {
                    interval_timer.tick().await;

                    if !running.load(Ordering::Relaxed) {
                        break;
                    }

                    // 获取设置
                    let settings_state = match app.try_state::<Settings>() {
                        Some(state) => state,
                        None => {
                            eprintln!("无法获取设置状态");
                            continue;
                        }
                    };
                    let settings = match settings_state.get_settings() {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("获取设置失败: {}", e);
                            continue;
                        }
                    };

                    // 检查是否启用轮播
                    if !settings.wallpaper_rotation_enabled {
                        continue;
                    }

                    // 检查是否有选中的画册
                    let album_id: String = match &settings.wallpaper_rotation_album_id {
                        Some(id) => id.clone(),
                        None => continue,
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
                                continue;
                            }
                        };

                    if images.is_empty() {
                        continue;
                    }

                    // 选择图片
                    let selected_image = match settings.wallpaper_rotation_mode.as_str() {
                        "sequential" => {
                            let mut idx = current_index.lock().unwrap();
                            let image = &images[*idx % images.len()];
                            *idx = (*idx + 1) % images.len();
                            image.clone()
                        }
                        _ => {
                            // 随机模式
                            let random_idx = (std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap()
                                .as_nanos() as usize)
                                % images.len();
                            images[random_idx].clone()
                        }
                    };

                    // 检查文件是否存在
                    if !Path::new(&selected_image.local_path).exists() {
                        eprintln!("图片文件不存在: {}", selected_image.local_path);
                        continue;
                    }

                    // 设置壁纸
                    let wallpaper_path = selected_image.local_path.clone();
                    
                    // 使用壁纸管理器设置壁纸
                    #[cfg(target_os = "windows")]
                    let manager: Box<dyn WallpaperManager + Send + Sync> = if settings.wallpaper_mode == "window" {
                        Box::new(WindowWallpaperManager::new(
                            app.clone(),
                            Arc::clone(&wallpaper_window),
                        ))
                    } else {
                        Box::new(NativeWallpaperManager::new(app.clone()))
                    };
                    
                    #[cfg(not(target_os = "windows"))]
                    let manager: Box<dyn WallpaperManager + Send + Sync> = 
                        Box::new(NativeWallpaperManager::new(app.clone()));
                    
                    if let Err(e) = manager.set_wallpaper(
                        &wallpaper_path,
                        &settings.wallpaper_rotation_style,
                        &settings.wallpaper_rotation_transition,
                    ) {
                        eprintln!("设置壁纸失败: {}", e);
                    }

                    // 保存当前壁纸路径
                    if let Ok(mut current) = current_wallpaper.lock() {
                        *current = Some(wallpaper_path.clone());
                    }
                    println!("壁纸已更换: {}", wallpaper_path);

                    // 等待指定的间隔时间
                    let interval_seconds = settings.wallpaper_rotation_interval_minutes as u64 * 60;
                    let mut wait_interval = interval(Duration::from_secs(interval_seconds));
                    wait_interval.tick().await; // 跳过第一次立即触发
                }
            });
        });

        Ok(())
    }

    /// 立刻切换到下一张壁纸（用于托盘菜单/快捷操作）
    ///
    /// - 依赖当前设置：是否启用、画册、随机/顺序、原生/窗口模式、style/transition
    /// - 成功/失败会通过 `wallpaper-actual-mode` 事件反馈到前端（与轮播逻辑一致）
    pub fn rotate_once_now(&self) -> Result<(), String> {
        use tauri::Manager;

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

        let album_id = settings
            .wallpaper_rotation_album_id
            .clone()
            .ok_or_else(|| "未选择用于轮播的画册".to_string())?;

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

        // 选择一张存在的图片（避免本地文件丢失导致失败）
        let mut picked: Option<crate::storage::ImageInfo> = None;
        for _ in 0..images.len().min(50) {
            let candidate = match settings.wallpaper_rotation_mode.as_str() {
                "sequential" => {
                    let mut idx = self
                        .current_index
                        .lock()
                        .map_err(|e| format!("无法获取顺序索引: {}", e))?;
                    let img = images[*idx % images.len()].clone();
                    *idx = (*idx + 1) % images.len();
                    img
                }
                _ => {
                    let random_idx = (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as usize)
                        % images.len();
                    images[random_idx].clone()
                }
            };

            if Path::new(&candidate.local_path).exists() {
                picked = Some(candidate);
                break;
            }
        }

        let picked = picked.ok_or_else(|| "未找到存在的图片文件".to_string())?;
        let wallpaper_path = picked.local_path.clone();

        // 使用壁纸管理器设置壁纸
        let manager = self.get_wallpaper_manager()?;
        manager.set_wallpaper(
            &wallpaper_path,
            &settings.wallpaper_rotation_style,
            &settings.wallpaper_rotation_transition,
        )?;

        // 保存当前壁纸路径（用于 reapply）
        if let Ok(mut current) = self.current_wallpaper.lock() {
            *current = Some(wallpaper_path.clone());
        }

        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// 调试/兜底：把“当前壁纸 + 当前样式/过渡设置”推送给 wallpaper webview（不依赖 WorkerW/SetParent 成功）。
    /// 目的：即使窗口模式挂载失败，也能在弹出/调试窗口里看到实际渲染内容，快速区分“渲染链路问题”还是“桌面层级问题”。
    pub fn debug_push_current_to_wallpaper_windows(&self) -> Result<(), String> {
        use tauri::Manager;

        let path = {
            let current = self
                .current_wallpaper
                .lock()
                .map_err(|e| format!("无法获取当前壁纸: {}", e))?;
            current.clone()
        }
        .ok_or_else(|| "没有当前壁纸可推送（请先成功设置一次壁纸）".to_string())?;

        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;
        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        // 广播给所有窗口（wallpaper / wallpaper_debug）
        let _ = self.app.emit("wallpaper-update-image", path.clone());
        let _ = self.app.emit(
            "wallpaper-update-style",
            settings.wallpaper_rotation_style.clone(),
        );
        let _ = self.app.emit(
            "wallpaper-update-transition",
            settings.wallpaper_rotation_transition.clone(),
        );

        Ok(())
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
            let current = self
                .current_wallpaper
                .lock()
                .map_err(|e| format!("无法获取当前壁纸: {}", e))?;
            current.clone()
        };

        if let Some(path) = wallpaper_path {
            println!("[DEBUG] 当前壁纸路径: {}", path);

            // 检查文件是否存在
            if !Path::new(&path).exists() {
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
            let manager = self.get_wallpaper_manager()?;
            manager.set_wallpaper(&path, &style_value, &transition_value)
        } else {
            println!("[DEBUG] 没有当前壁纸可重新应用");
            Err("没有当前壁纸可重新应用".to_string())
        }
    }

}
