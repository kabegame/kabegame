#[cfg(target_os = "windows")]
pub mod gdi;
pub mod native;
#[cfg(target_os = "windows")]
pub mod window;

// 导出管理器类型
#[cfg(target_os = "windows")]
pub use gdi::GdiWallpaperManager;
pub use native::NativeWallpaperManager;
#[cfg(target_os = "windows")]
pub use window::WindowWallpaperManager;

use crate::settings::Settings;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use crate::wallpaper::window::WallpaperWindow;

/// 全局壁纸控制器（基础 manager）：负责根据当前 `wallpaper_mode` 选择后端（native/window/gdi），并保留 window/gdi 模式的运行状态。
///
/// 注意：此控制器不承诺“过渡效果可用”，过渡效果应由更上层的轮播 manager 控制（并受“是否启用轮播”约束）。
pub struct WallpaperController {
    app: AppHandle,
    native: Arc<NativeWallpaperManager>,
    #[cfg(target_os = "windows")]
    window: Arc<WindowWallpaperManager>,
    #[cfg(target_os = "windows")]
    gdi: Arc<GdiWallpaperManager>,
}

impl WallpaperController {
    pub fn new(app: AppHandle) -> Self {
        let native = Arc::new(NativeWallpaperManager::new(app.clone()));

        #[cfg(target_os = "windows")]
        let wallpaper_window: Arc<Mutex<Option<WallpaperWindow>>> = Arc::new(Mutex::new(None));

        #[cfg(target_os = "windows")]
        let window = Arc::new(WindowWallpaperManager::new(
            app.clone(),
            Arc::clone(&wallpaper_window),
        ));

        #[cfg(target_os = "windows")]
        let gdi = Arc::new(GdiWallpaperManager::new(app.clone()));

        Self {
            app,
            native,
            #[cfg(target_os = "windows")]
            window,
            #[cfg(target_os = "windows")]
            gdi,
        }
    }

    /// 根据当前设置选择活动后端（native/window/gdi）。
    pub fn active_manager(&self) -> Result<Arc<dyn WallpaperManager + Send + Sync>, String> {
        let settings_state = self
            .app
            .try_state::<Settings>()
            .ok_or_else(|| "无法获取设置状态".to_string())?;

        let settings = settings_state
            .get_settings()
            .map_err(|e| format!("获取设置失败: {}", e))?;

        Ok(match settings.wallpaper_mode.as_str() {
            #[cfg(target_os = "windows")]
            "window" => self.window.clone() as Arc<dyn WallpaperManager + Send + Sync>,
            #[cfg(target_os = "windows")]
            "gdi" => self.gdi.clone() as Arc<dyn WallpaperManager + Send + Sync>,
            _ => self.native.clone() as Arc<dyn WallpaperManager + Send + Sync>,
        })
    }

    /// 按指定模式选择后端（不依赖 settings 中的 wallpaper_mode）。
    pub fn manager_for_mode(&self, mode: &str) -> Arc<dyn WallpaperManager + Send + Sync> {
        match mode {
            #[cfg(target_os = "windows")]
            "window" => self.window.clone() as Arc<dyn WallpaperManager + Send + Sync>,
            #[cfg(target_os = "windows")]
            "gdi" => self.gdi.clone() as Arc<dyn WallpaperManager + Send + Sync>,
            _ => self.native.clone() as Arc<dyn WallpaperManager + Send + Sync>,
        }
    }

    /// 单张壁纸设置：只应用 `file_path + style`，不涉及 transition（用于适配"非轮播/单张"场景）。
    pub fn set_wallpaper(&self, file_path: &str, style: &str) -> Result<(), String> {
        let manager = self.active_manager()?;
        manager.set_wallpaper(file_path, style, "none")?;
        Ok(())
    }

    /// 初始化活动管理器（如创建窗口等）
    /// 异步执行，完成后返回结果
    pub async fn init(&self) -> Result<(), String> {
        // 注意：这里不要只初始化 active_manager（它依赖 settings.wallpaper_mode）。
        // 启动时经常是 native 模式，但用户可能随后切换到 window/gdi 模式；
        // 若 window/gdi manager 未 init，会导致切换时报 “窗口未初始化，请先调用 init 方法”，前端卡在“切换中”。
        //
        // 我们在 Windows 上同时初始化三个后端：
        // - native: no-op
        // - window: 只确保 wallpaper 窗口存在且保持隐藏，不做挂载/显示
        // - gdi: no-op（GDI 窗口在 set_wallpaper_path 时按需创建）
        println!("初始化 manager 开始");
        self.native.init(self.app.clone())?;

        #[cfg(target_os = "windows")]
        {
            self.window.init(self.app.clone())?;
            self.gdi.init(self.app.clone())?;
        }
        println!("初始化 manager 完成");
        Ok(())
    }
}

/// 壁纸管理器 trait，定义壁纸设置的通用接口
pub trait WallpaperManager: Send + Sync {
    ///
    /// # Returns
    /// * `String` - 当前样式
    ///
    /// # Errors
    /// * `String` - 错误信息
    #[allow(dead_code)]
    fn get_style(&self) -> Result<String, String>;

    ///
    /// # Returns
    /// * `String` - 当前过渡效果
    ///
    /// # Errors
    /// * `String` - 错误信息
    #[allow(dead_code)]
    fn get_transition(&self) -> Result<String, String>;

    /// 更新壁纸样式，如果immediate为true，则立即生效
    ///
    /// # Arguments
    /// * `style` - 显示样式（fill/fit/stretch/center/tile）
    fn set_style(&self, style: &str, immediate: bool) -> Result<(), String>;

    /// 更新壁纸过渡效果，立即生效预览
    ///
    /// # Arguments
    /// * `transition` - 过渡效果（none/fade/slide/zoom）
    fn set_transition(&self, transition: &str, immediate: bool) -> Result<(), String>;

    /// 设置壁纸路径，立即生效预览
    ///
    /// # Arguments
    /// * `file_path` - 壁纸文件路径
    fn set_wallpaper_path(&self, file_path: &str, immediate: bool) -> Result<(), String>;

    /// 设置壁纸，按照style和transition设置壁纸
    ///
    /// # Arguments
    /// * `file_path` - 壁纸文件路径
    /// * `style` - 显示样式（fill/fit/stretch/center/tile）
    /// * `transition` - 过渡效果（none/fade/slide/zoom）
    fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        self.set_style(style, false)?;
        self.set_transition(transition, false)?;
        // 重要：历史实现只会“设置一次壁纸路径”。
        // 之前这里会连续调用两次 set_wallpaper_path（先 immediate=false 再 immediate=true），
        // 等于触发两次 SPI_SETDESKWALLPAPER，在一些系统上肉眼会像“淡入/过渡”。
        // 改为：只调用一次 immediate=true（需要立即生效的 set_wallpaper 语义本就如此）。
        self.set_wallpaper_path(file_path, true)?;
        Ok(())
    }

    /// 清理资源（如关闭窗口等）
    #[allow(dead_code)]
    fn cleanup(&self) -> Result<(), String>;

    /// 手动刷新桌面以同步壁纸设置
    ///
    /// 当使用 set_wallpaper_path 设置壁纸但不刷新桌面时，
    /// 可以调用此方法来手动触发桌面刷新，使壁纸设置生效
    #[allow(dead_code)]
    fn refresh_desktop(&self) -> Result<(), String>;

    /// 初始化管理器（如创建窗口等）
    ///
    /// # Arguments
    /// * `app` - Tauri 应用句柄
    fn init(&self, app: AppHandle) -> Result<(), String>;
}
