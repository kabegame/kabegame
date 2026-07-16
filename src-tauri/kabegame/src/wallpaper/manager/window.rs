use super::WallpaperManager;
use crate::wallpaper::window::WallpaperWindow;
use async_trait::async_trait;
use kabegame_i18n::t;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 壁纸窗口的 label。窗口是**懒建**的：只在 `wallpaperMode == "window"` 期间存在。
const WALLPAPER_LABEL: &str = "wallpaper";

/// 窗口模式壁纸管理器。
///
/// **本 manager 不负责壁纸内容**——内容由壁纸页面（`wallpaper.ts`）监听
/// `setting-change` 自驱动渲染。本 manager 只负责窗口的**生命周期**：
/// `init()` 建窗口并挂到桌面层，`cleanup()` 销毁它。窗口一旦建立即常显，
/// 中途不 hide/show。
///
/// 因此窗口的存在期与 `wallpaperMode == "window"` 严格同寿命。
pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>,
}

impl<R: Runtime> WindowWallpaperManager<R> {
    pub fn new(app: AppHandle<R>, wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>) -> Self {
        Self {
            app,
            wallpaper_window,
        }
    }

    /// 绊线：本 manager 的内容类方法都是 no-op，**不会**兜底建窗。
    ///
    /// 窗口只由 `init()` 创建，而 `init()` 只在两个地方被调用：启动
    /// （`startup.rs` → `WallpaperController::init()`）和模式/开关切换
    /// （`commands/wallpaper.rs` 的 `apply_backend_lifecycle` / `set_wallpaper_disabled`）。
    /// 任何新增的"让壁纸生效"路径若漏调 `init()`，症状是**静默无窗口**——
    /// 类型系统抓不到（改成 no-op 后已连续踩到三次：模式切换的无壁纸早返回、
    /// 切换中止路径、关闭壁纸后重新开启）。这行日志把它变成可见的。
    fn warn_if_window_missing(&self, who: &str) {
        if self.app.get_webview_window(WALLPAPER_LABEL).is_none() {
            eprintln!(
                "[WARN] {}: 处于 window 模式但壁纸窗口不存在 —— 某条路径漏调了 \
                 WindowWallpaperManager::init()，壁纸不会显示",
                who
            );
        }
    }

    /// 建立壁纸窗口本体（不挂载）。已存在则直接复用。
    fn create_window(&self) -> Result<WebviewWindow<R>, String> {
        if let Some(w) = self.app.get_webview_window(WALLPAPER_LABEL) {
            return Ok(w);
        }

        // 独立的 wallpaper.html，只渲染壁纸层。
        let builder = WebviewWindowBuilder::new(
            &self.app,
            WALLPAPER_LABEL,
            WebviewUrl::App("wallpaper.html".into()),
        )
        // 固定标题，便于脚本/调试定位到正确窗口。
        .title(t!("window.wallpaperTitle"))
        .fullscreen(true)
        .decorations(false)
        .skip_taskbar(true);

        #[cfg(target_os = "windows")]
        let builder = builder.transparent(true);

        // 建成时不可见：挂载会把它改成 Progman 的子窗口并搬到桌面层，
        // 期间若可见会先在屏幕上闪一下全屏窗口。`mount()` 内部挂完即 show，
        // 之后在 window 模式的整个生命周期里保持常显、不再 hide。
        builder
            .visible(false)
            .build()
            .map_err(|e| format!("创建壁纸窗口失败: {:?}", e))
    }
}

#[async_trait]
impl<R: Runtime> WallpaperManager for WindowWallpaperManager<R> {
    async fn get_style(&self) -> Result<String, String> {
        Ok(kabegame_core::settings::Settings::global().get_wallpaper_rotation_style())
    }

    async fn get_transition(&self) -> Result<String, String> {
        Ok(kabegame_core::settings::Settings::global().get_wallpaper_rotation_transition())
    }

    async fn set_wallpaper_path(&self, _file_path: &str) -> Result<(), String> {
        // 窗口模式：内容由壁纸页面监听 setting-change 自驱动，窗口在 init() 时
        // 已挂载且常显，此处无需做任何事。
        self.warn_if_window_missing("set_wallpaper_path");
        Ok(())
    }

    async fn set_style(&self, _style: &str) -> Result<(), String> {
        // 同 set_wallpaper_path：内容侧自驱动。
        Ok(())
    }

    async fn set_transition(&self, _transition: &str) -> Result<(), String> {
        // 同 set_wallpaper_path：内容侧自驱动。
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // 离开 window 模式：销毁窗口，而不是藏起来。窗口挂载时被改成了 Progman 的
        // 子窗口（WS_CHILD + 改过的扩展样式），留着它下次只会在一个已被改过的窗口上
        // 再挂一次。
        if let Ok(mut wp) = self.wallpaper_window.lock() {
            *wp = None;
        }
        if let Some(window) = self.app.get_webview_window(WALLPAPER_LABEL) {
            // `destroy()` 而非 `close()`：这是程序化拆除，不是「请求关闭」。
            // `close()` 会走 CloseRequested 事件，可被 `api.prevent_close()` 拦下
            // （`lib.rs` 已对 `crawler-*` 这么做）——一旦哪天拦截条件放宽到本窗口，
            // 窗口就关不掉，而「窗口存在 ⟺ mode==window ∧ !disabled」会**静默**失效。
            // 仓库内其他程序化销毁（surf / startup）也都用 `destroy()`。
            window
                .destroy()
                .map_err(|e| format!("销毁壁纸窗口失败: {:?}", e))?;
        }
        // ready 是进程级静态，必须随窗口一起重置，否则下次重建时 wait_ready 会
        // 立刻返回，挂载会打在一个前端尚未加载的新窗口上。
        WallpaperWindow::<R>::reset_ready();
        Ok(())
    }

    fn refresh_desktop(&self) -> Result<(), String> {
        // 窗口模式不刷新系统桌面：壁纸由本窗口自己画。
        Ok(())
    }

    fn init(&self) -> Result<(), String> {
        if self
            .wallpaper_window
            .lock()
            .map(|wp| wp.is_some())
            .unwrap_or(false)
        {
            // 已建立且已挂载。
            return Ok(());
        }

        println!("初始化窗口模式壁纸管理器");
        let window = self.create_window()?;
        let wp_window = WallpaperWindow::new(window);

        // 挂到桌面层。内部会先等前端 ready 再动窗口句柄。
        wp_window.mount()?;

        self.wallpaper_window
            .lock()
            .map(|mut wp| *wp = Some(wp_window))
            .map_err(|_| "无法获取窗口锁".to_string())
    }
}
