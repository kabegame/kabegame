use super::WallpaperManager;
use crate::wallpaper::window::WallpaperWindow;
use async_trait::async_trait;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// 窗口模式壁纸管理器（使用窗口句柄显示壁纸）
/// 内容由壁纸页面通过 setting-change 自驱动，本 manager 仅负责窗口可见性（remount/show）
pub struct WindowWallpaperManager {
    app: AppHandle,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>,
}

impl WindowWallpaperManager {
    pub fn new(app: AppHandle, wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>>) -> Self {
        Self {
            app,
            wallpaper_window,
        }
    }
}

#[async_trait]
impl WallpaperManager for WindowWallpaperManager {
    async fn get_style(&self) -> Result<String, String> {
        kabegame_core::settings::Settings::global()
            .get_wallpaper_rotation_style()
            .await
    }

    async fn get_transition(&self) -> Result<String, String> {
        kabegame_core::settings::Settings::global()
            .get_wallpaper_rotation_transition()
            .await
    }

    async fn set_wallpaper_path(&self, file_path: &str) -> Result<(), String> {
        use std::path::Path;

        let path = Path::new(file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        WallpaperWindow::wait_ready(std::time::Duration::from_secs(100))?;

        // 内容由壁纸页面通过 setting-change 自驱动，此处仅管理窗口可见性（remount/show）
        if let Ok(wp) = self.wallpaper_window.lock() {
            if let Some(ref wp_window) = *wp {
                if let Some(w) = self.app.get_webview_window("wallpaper") {
                    let vis = w.is_visible().unwrap_or(false);
                    if !vis {
                        if let Err(e) = wp_window.remount() {
                            eprintln!("[WARN] 重新挂载窗口失败: {}, 但继续执行", e);
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

    async fn set_style(&self, _style: &str) -> Result<(), String> {
        // 窗口模式：内容由壁纸页面监听 setting-change 自驱动，此处 no-op
        Ok(())
    }

    async fn set_transition(&self, _transition: &str) -> Result<(), String> {
        // 窗口模式：内容由壁纸页面监听 setting-change 自驱动，此处 no-op
        Ok(())
    }

    async fn set_wallpaper(
        &self,
        file_path: &str,
        _style: &str,
        _transition: &str,
    ) -> Result<(), String> {
        // 内容由壁纸页面监听 setting-change 自驱动，此处仅负责窗口可见性（remount）
        self.set_wallpaper_path(file_path).await
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

        // 这里不创建窗口，因为只能拿到app句柄，拿不到manager
        // create() 会把窗口挂载到桌面层并 show，如果此时没有有效图片路径，会导致桌面上"看不到壁纸"（被空内容窗口覆盖）。
        // 我们只确保 wallpaper WebviewWindow 已存在且保持隐藏；真正显示/挂载留到第一次 set_wallpaper_path 触发 remount。
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
