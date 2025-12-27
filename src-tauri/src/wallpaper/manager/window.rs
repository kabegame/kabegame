use super::WallpaperManager;
use crate::settings::Settings;
use crate::wallpaper::window::WallpaperWindow;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// 窗口模式壁纸管理器（使用窗口句柄显示壁纸）
pub struct WindowWallpaperManager {
    app: AppHandle,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>,
    // 窗口模式的壁纸路径状态，通过通信机制与窗口保持一致
    current_wallpaper_path: Arc<Mutex<Option<String>>>,
}

impl WindowWallpaperManager {
    pub fn new(app: AppHandle, wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>) -> Self {
        Self {
            app,
            wallpaper_window,
            // 初始化时壁纸路径为空
            current_wallpaper_path: Arc::new(Mutex::new(None)),
        }
    }
}

impl WallpaperManager for WindowWallpaperManager {
    fn get_wallpaper_path(&self) -> Result<String, String> {
        // 从 manager 的状态中获取当前壁纸路径
        let path = self
            .current_wallpaper_path
            .lock()
            .map_err(|e| format!("无法获取壁纸路径锁: {}", e))?;
        path.clone().ok_or_else(|| "当前没有设置壁纸".to_string())
    }

    fn get_style(&self) -> Result<String, String> {
        // 从 Settings 中获取当前样式
        let settings = self.app.state::<Settings>();
        let current_settings = settings
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;
        Ok(current_settings.wallpaper_rotation_style.clone())
    }

    fn get_transition(&self) -> Result<String, String> {
        // 从 Settings 中获取当前过渡效果
        let settings = self.app.state::<Settings>();
        let current_settings = settings
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;
        Ok(current_settings.wallpaper_rotation_transition.clone())
    }

    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String> {
        use std::path::Path;

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        // 等待 wallpaper 窗口前端 ready，避免事件在监听器注册前发出导致丢失
        WallpaperWindow::wait_ready(std::time::Duration::from_secs(100))?;

        // 更新 manager 中的壁纸路径状态
        {
            let mut current_path = self
                .current_wallpaper_path
                .lock()
                .map_err(|e| format!("无法获取壁纸路径锁: {}", e))?;
            *current_path = Some(file_path.to_string());
        }

        // 通过通信机制更新窗口（emit 事件）
        // 这样保证 manager 状态与窗口一致
        self.app
            .emit("wallpaper-update-image", file_path)
            .map_err(|e| format!("发送壁纸更新事件失败: {}", e))?;

        // 假设窗口已存在（通过 init 方法创建）
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                // 窗口已存在，更新图片（双重保险，确保窗口收到更新）
                if let Err(e) = wp_window.update_image(file_path) {
                    return Err(e);
                }
                // 窗口模式：避免每次切换都 remount（会触发 SetParent/SetWindowPos/ShowWindow，导致桌面闪烁）。
                // immediate=true 只表示“立刻显示这张图”，通过事件推送已满足。
                // 仅在窗口不可见时才 remount 一次（例如刚从 native 模式切回、或窗口被隐藏）。
                if immediate {
                    if let Some(w) = self.app.get_webview_window("wallpaper") {
                        // is_visible 失败时更倾向于“认为不可见”，确保第一次能挂载显示
                        if w.is_visible().unwrap_or(false) == false {
                            if let Err(e) = wp_window.remount() {
                                eprintln!("[WARN] 重新挂载窗口失败: {}, 但继续执行", e);
                            }
                        }
                    }
                }
            } else {
                return Err("窗口未初始化，请先调用 init 方法".to_string());
            }
        } else {
            return Err("无法获取窗口锁".to_string());
        }

        Ok(())
    }

    fn set_style(&self, style: &str, immediate: bool) -> Result<(), String> {
        // 保存样式到 Settings
        let settings = self.app.state::<Settings>();
        settings
            .set_wallpaper_style(style.to_string())
            .map_err(|e| format!("保存样式设置失败: {}", e))?;

        // 无论窗口是否已创建，都先广播事件，确保前端（WallpaperLayer）立即拿到最新样式
        let _ = self.app.emit("wallpaper-update-style", style);

        // 更新窗口样式
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                wp_window
                    .update_style(style)
                    .map_err(|e| format!("更新窗口样式失败: {}", e))?;
            } else {
                // 窗口不存在，只保存设置即可
            }
        }

        // 如果 immediate 为 true，重新挂载窗口以确保立即生效
        if immediate {
            if let Ok(wp) = self.wallpaper_window.lock() {
                if let Some(ref wp_window) = *wp {
                    // 避免每次都 remount 导致闪烁；仅在窗口不可见时 remount
                    if let Some(w) = self.app.get_webview_window("wallpaper") {
                        if w.is_visible().unwrap_or(false) == false {
                            let _ = wp_window.remount();
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String> {
        // 保存过渡效果到 Settings
        let settings = self.app.state::<Settings>();
        settings
            .set_wallpaper_rotation_transition(transition.to_string())
            .map_err(|e| format!("保存过渡效果设置失败: {}", e))?;

        // 无论窗口是否已创建，都先广播事件，确保前端（WallpaperLayer）立即拿到最新过渡
        let _ = self.app.emit("wallpaper-update-transition", transition);

        // 更新窗口过渡效果
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                wp_window
                    .update_transition(transition)
                    .map_err(|e| format!("更新窗口过渡效果失败: {}", e))?;
            } else {
                // 窗口不存在，只保存设置即可
            }
        }

        // 如果 immediate 为 true，重新挂载窗口以确保立即生效
        if immediate {
            if let Ok(wp) = self.wallpaper_window.lock() {
                if let Some(ref wp_window) = *wp {
                    // 避免每次都 remount 导致闪烁；仅在窗口不可见时 remount
                    if let Some(w) = self.app.get_webview_window("wallpaper") {
                        if w.is_visible().unwrap_or(false) == false {
                            let _ = wp_window.remount();
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        // 同时设置原生壁纸作为后备，如果窗口模式失败，用户至少能看到壁纸
        // 窗口会覆盖在原生壁纸之上，所以不会影响视觉效果
        // let native_manager = NativeWallpaperManager::new(self.app.clone());
        // let _ = native_manager.set_wallpaper(file_path, style, transition);

        // 更新 manager 中的壁纸路径状态
        {
            let mut current_path = self
                .current_wallpaper_path
                .lock()
                .map_err(|e| format!("无法获取壁纸路径锁: {}", e))?;
            *current_path = Some(file_path.to_string());
        }

        // 等待 wallpaper 窗口前端 ready，避免事件在监听器注册前发出导致丢失
        WallpaperWindow::wait_ready(std::time::Duration::from_secs(100))?;

        // 通过通信机制更新窗口（emit 事件）
        // 这样保证 manager 状态与窗口一致
        self.app
            .emit("wallpaper-update-image", file_path)
            .map_err(|e| format!("发送壁纸更新事件失败: {}", e))?;

        // 假设窗口已存在（通过 init 方法创建）
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                // 窗口已存在，更新图片并重新挂载（确保从原生模式切换回来时窗口正确显示）
                if let Err(e) = wp_window.update_image(file_path) {
                    return Err(e);
                }
                let _ = wp_window.update_style(style);
                let _ = wp_window.update_transition(transition);
                // 同上：避免每次 set_wallpaper 都 remount 导致闪烁；仅在窗口不可见时 remount。
                if let Some(w) = self.app.get_webview_window("wallpaper") {
                    // is_visible 失败时更倾向于“认为不可见”，确保第一次能挂载显示
                    if w.is_visible().unwrap_or(false) == false {
                        if let Err(e) = wp_window.remount() {
                            eprintln!("[WARN] 重新挂载窗口失败: {}, 但继续执行", e);
                        }
                    }
                }
            } else {
                return Err("窗口未初始化，请先调用 init 方法".to_string());
            }
        }
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // 隐藏窗口，但不销毁（因为窗口在应用生命周期内复用）
        if let Some(window) = self.app.get_webview_window("wallpaper") {
            window
                .hide()
                .map_err(|e| format!("隐藏窗口失败: {:?}", e))?;
        }
        Ok(())
    }

    fn refresh_desktop(&self) -> Result<(), String> {
        // 窗口模式不需要刷新桌面，因为壁纸是通过窗口显示的
        Ok(())
    }

    fn init(&self, app: AppHandle) -> Result<(), String> {
        println!("初始化窗口模式壁纸管理器");
        // 检查窗口是否已存在
        if let Ok(wp) = self.wallpaper_window.lock() {
            if wp.is_some() {
                // 窗口已存在，无需重复初始化
                return Ok(());
            }
        }

        // 关键：init 阶段不要调用 WallpaperWindow::create("")。
        // create() 会把窗口挂载到桌面层并 show，如果此时没有有效图片路径，会导致桌面上“看不到壁纸”（被空内容窗口覆盖）。
        // 我们只确保 wallpaper WebviewWindow 已存在且保持隐藏；真正显示/挂载留到第一次 set_wallpaper_path(immediate=true) 触发 remount。
        if app.get_webview_window("wallpaper").is_none() {
            return Err("壁纸窗口不存在。请确保在应用启动时已创建 wallpaper 窗口".to_string());
        }
        if let Some(w) = app.get_webview_window("wallpaper") {
            let _ = w.hide();
        }

        // 创建并记录 WallpaperWindow（不挂载/不 show）
        let new_wp = WallpaperWindow::new(app.clone());

        // 更新窗口状态
        if let Ok(mut wp) = self.wallpaper_window.lock() {
            *wp = Some(new_wp);
        } else {
            return Err("无法获取窗口锁".to_string());
        }

        Ok(())
    }
}
