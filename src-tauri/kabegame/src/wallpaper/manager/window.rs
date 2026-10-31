use super::{style_options, transition_options, WallpaperManager, WallpaperOption};
use crate::wallpaper::web_entry;
use crate::wallpaper::window::WallpaperWindow;
use async_trait::async_trait;
use kabegame_i18n::t;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 壁纸窗口 label。
pub const WALLPAPER_LABEL: &str = "wallpaper";

/// 窗口模式壁纸管理器。壁纸窗口的 label 见 [`WALLPAPER_LABEL`]，窗口是**懒建**的：
/// 只在 `wallpaperMode == "window"` 期间存在。
///
/// 窗口的**生命周期**：`init()` 建窗口并挂到桌面层，`cleanup()` 销毁它。窗口一旦建立
/// 即常显，中途不 hide/show。因此窗口的存在期与 `wallpaperMode == "window"` 严格同寿命。
///
/// 窗口的**内容**：图片 / 视频 / 网页壁纸都由壁纸页面（`WallpaperWindow.vue` → `WallpaperStage`）监听
/// `setting-change` 自驱动渲染，网页壁纸（`x-wpe/web`）是 web 层里的 `file:` iframe，窗口不导航。
/// `set_wallpaper_path` 只按当前壁纸开关 Windows 的桌面鼠标转发（[`WallpaperWindow::set_mouse_forwarding`]）。
pub struct WindowWallpaperManager<R: Runtime> {
    app: AppHandle<R>,
    wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>,
}

impl<R: Runtime> WindowWallpaperManager<R> {
    pub fn new(
        app: AppHandle<R>,
        wallpaper_window: Arc<Mutex<Option<WallpaperWindow<R>>>>,
    ) -> Self {
        Self {
            app,
            wallpaper_window,
        }
    }

    /// 绊线：本 manager 的内容类方法**不会**兜底建窗（窗口不存在时 `set_wallpaper_path`
    /// 什么都不做）。
    ///
    /// 窗口只由 `init()` 创建，而 `init()` 只在两个地方被调用：启动
    /// （`startup.rs` → `WallpaperController::init()`）和模式/开关切换
    /// （`commands/wallpaper.rs` 的 `apply_backend_lifecycle` / `set_wallpaper_disabled`）。
    /// 任何新增的"让壁纸生效"路径若漏调 `init()`，症状是**静默无窗口**——
    /// 类型系统抓不到（去掉兜底建窗后已连续踩到三次：模式切换的无壁纸早返回、
    /// 切换中止路径、关闭壁纸后重新开启）。这行日志把它变成可见的。
    fn warn_if_window_missing(&self, who: &str) {
        if self.app.get_webview_window(WALLPAPER_LABEL).is_none() {
            tracing::warn!(
                "{}: 处于 window 模式但壁纸窗口不存在 —— 某条路径漏调了 \
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

        // 网页壁纸是 web 层里的 file: iframe，页面要读同目录文件：建窗前登记 label，CEF 只给这个 browser
        // 打开文件访问偏好（补丁 0004），file: 文档的请求由运行时按网页壁纸目录索引约束。
        // WPE 网页壁纸暂只支持 Windows（`web_entry` 在其它平台恒为 None），其它平台不登记。
        #[cfg(target_os = "windows")]
        tauri_runtime_cef::allow_file_documents(WALLPAPER_LABEL);
        // 壁纸窗口的 Vue 页用 <img> / <video> 显示图库媒体（file://），也要给 iframe 赋 file: src：登记
        // CEF 补丁 0005 + 0006，应用页主 frame 的 file: 子资源免检，iframe 导航须落进库里某个网页壁纸目录。
        tauri_runtime_cef::allow_app_local_resources(WALLPAPER_LABEL);

        // 与主窗口同一个 index.html，前端 main.ts 按 ?window= 分发到壁纸 bootstrap。
        let builder = WebviewWindowBuilder::new(
            &self.app,
            WALLPAPER_LABEL,
            WebviewUrl::App("index.html?window=wallpaper".into()),
        )
        // 固定标题，便于脚本/调试定位到正确窗口。
        .title(t!("window.wallpaperTitle"))
        // WPE 网页壁纸垫片：只在顶层的直接子 file: iframe 里启用，应用页里第一行就返回。
        .initialization_script_for_all_frames(crate::commands::wpe_web::WPE_SHIM_JS)
        .fullscreen(true)
        .decorations(false)
        .skip_taskbar(true);

        #[cfg(target_os = "windows")]
        let builder = builder.transparent(true);

        // 建成时不可见：挂载会把它改成背景 WorkerW 的子窗口并搬到桌面层，
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
    fn supported_styles(&self) -> Vec<WallpaperOption> {
        style_options(&["fill", "fit", "stretch", "center", "tile"])
    }

    fn supported_transitions(&self) -> Vec<WallpaperOption> {
        transition_options(
            &["none", "fade", "slide", "zoom"],
            "settings.transitionNone",
        )
    }

    async fn set_wallpaper_path(&self, file_path: &str) -> Result<(), String> {
        // 窗口在 init() 时已挂载且常显。图片 / 视频 / 网页壁纸都由壁纸页面监听 setting-change
        // 自驱动渲染，这里只按当前壁纸开关桌面鼠标转发。设图、轮播、启动恢复、切换模式、
        // 重新开启壁纸、改样式都会走到这里。
        self.warn_if_window_missing("set_wallpaper_path");
        // 判定在窗口锁外做（读 project.json），开关在锁内同步完成；锁内不调会同步等主线程的 getter。
        let is_web = web_entry(Path::new(file_path))?.is_some();
        let mut guard = self
            .wallpaper_window
            .lock()
            .map_err(|_| "无法获取窗口锁".to_string())?;
        let Some(wp) = guard.as_mut() else {
            // 尚未 init：什么都不做，不兜底建窗。
            return Ok(());
        };
        wp.set_mouse_forwarding(is_web);
        Ok(())
    }

    async fn set_style(&self, _style: &str) -> Result<(), String> {
        // 样式由壁纸页面监听 setting-change 自驱动；对网页壁纸不生效。
        Ok(())
    }

    async fn set_transition(&self, _transition: &str) -> Result<(), String> {
        // 同 set_style：过渡由壁纸页面自驱动（网页壁纸与图片 / 视频之间走同一套淡入淡出）。
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        // 离开 window 模式：销毁窗口，而不是藏起来。窗口挂载时被改成了 WorkerW 的
        // 子窗口（WS_CHILD + 改过的扩展样式），留着它下次只会在一个已被改过的窗口上
        // 再挂一次。
        // 丢弃 WallpaperWindow：鼠标转发线程随之停止（`InputForwarder` 的 Drop）。
        if let Ok(mut wp) = self.wallpaper_window.lock() {
            *wp = None;
        }
        if let Some(window) = self.app.get_webview_window(WALLPAPER_LABEL) {
            #[cfg(target_os = "windows")]
            if let Err(error) = tauri_plugin_wemt::detach_window(&window) {
                tracing::warn!("解绑桌面窗口失败，仍将销毁窗口: {error}");
            }
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

        tracing::debug!("初始化窗口模式壁纸管理器");
        let window = self.create_window()?;
        let mut wp_window = WallpaperWindow::new(window);

        // 挂到桌面层。内部会先等前端 ready 再动窗口句柄，并记下窗口句柄。
        wp_window.mount()?;

        self.wallpaper_window
            .lock()
            .map(|mut wp| *wp = Some(wp_window))
            .map_err(|_| "无法获取窗口锁".to_string())
    }
}
