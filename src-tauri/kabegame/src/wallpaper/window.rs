// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{Runtime, WebviewWindow};
use url::Url;

// 标记壁纸窗口是否已完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
// 由 wallpaper_window_ready 命令设置为 true，并通过 notify_all 唤醒所有等待者
struct ReadyNotify {
    ready: Mutex<bool>,
    cv: Condvar,
}

static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();

fn ready_notify() -> &'static ReadyNotify {
    WALLPAPER_WINDOW_READY.get_or_init(|| ReadyNotify {
        ready: Mutex::new(false),
        cv: Condvar::new(),
    })
}

/// 壁纸窗口当前停留的网页壁纸（`x-wpe/web`）。
struct WebPage {
    /// 壁纸目录：CEF 只放行这个目录内的 `file:` 请求。
    dir: PathBuf,
    /// 入口的 `file://` URL。
    entry: Url,
}

/// 一个壁纸窗口，以及它当前显示的内容。
///
/// 图片 / 视频由应用页（`index.html?window=wallpaper`，`WallpaperWindow.vue`）监听
/// `setting-change` 自驱动渲染；网页壁纸（`x-wpe/web`）由 [`Self::show_web`] 把**整个主 frame**
/// 导航到入口的 `file://`，[`Self::show_app`] 再导航回应用页。网页壁纸相关的状态（应用页 URL、
/// 当前入口、Windows 上的鼠标转发线程）都跟着本对象走，随它一起丢弃。
pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
    /// 应用页 URL：`mount()` 时读一次记住，导航回应用页用（dev 是 vite 地址，prod 是内置资源地址，不手拼）。
    app_url: Option<Url>,
    /// 当前网页壁纸；`None` 表示停在应用页。
    web: Option<WebPage>,
    /// ping 看门狗：mount 完成后启动，随本对象丢弃而停止。
    pinger: Option<super::ping::Pinger>,
    /// 窗口句柄：`mount()` 时取，鼠标转发用。
    #[cfg(target_os = "windows")]
    hwnd: Option<isize>,
    /// 桌面鼠标转发：只在停留网页壁纸期间运行，丢弃即停止（见 `InputForwarder` 的 `Drop`）。
    #[cfg(target_os = "windows")]
    forwarder: Option<super::input_forward::InputForwarder>,
}

impl<R: Runtime> WallpaperWindow<R> {
    /// 由 `WindowWallpaperManager::init()` 在确保窗口已创建后调用。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self {
            window,
            app_url: None,
            web: None,
            pinger: None,
            #[cfg(target_os = "windows")]
            hwnd: None,
            #[cfg(target_os = "windows")]
            forwarder: None,
        }
    }

    /// 窗口 label（本地字段，不等主线程）。
    pub fn label(&self) -> &str {
        self.window.label()
    }

    /// 当前显示的网页壁纸目录；停在应用页时为 None。
    pub fn web_dir(&self) -> Option<&Path> {
        self.web.as_ref().map(|web| web.dir.as_path())
    }

    /// 标记壁纸窗口已完全初始化（由 wallpaper_window_ready 命令调用）
    pub fn mark_ready() {
        let n = ready_notify();
        if let Ok(mut ready) = n.ready.lock() {
            *ready = true;
            n.cv.notify_all();
        } else {
            // poisoned，不阻断主流程
            n.cv.notify_all();
        }
    }

    /// 重置 ready 标记。**必须**在销毁壁纸窗口时调用：ready 是进程级静态，
    /// 不重置的话下次重建窗口时 `wait_ready` 会立刻返回，挂载会打在一个
    /// 前端尚未加载的窗口上。
    pub fn reset_ready() {
        let n = ready_notify();
        if let Ok(mut ready) = n.ready.lock() {
            *ready = false;
        }
    }

    /// 等待窗口 ready（挂载前阻塞等待前端加载完成）
    pub fn wait_ready(timeout: std::time::Duration) -> Result<(), String> {
        let n = ready_notify();
        let guard = n
            .ready
            .lock()
            .map_err(|_| "WALLPAPER_WINDOW_READY mutex poisoned".to_string())?;

        if *guard {
            return Ok(());
        }

        let (guard, wait_res) =
            n.cv.wait_timeout_while(guard, timeout, |ready| !*ready)
                .map_err(|_| "WALLPAPER_WINDOW_READY condvar wait failed".to_string())?;

        if *guard {
            Ok(())
        } else if wait_res.timed_out() {
            Err("壁纸窗口初始化超时，放弃推送".to_string())
        } else {
            Err("壁纸窗口等待就绪失败".to_string())
        }
    }

    /// 把窗口挂到桌面层并显示。窗口在 window 模式的整个生命周期内保持挂载与常显，
    /// 故本方法只在 `WindowWallpaperManager::init()` 建立窗口时调用一次。
    pub fn mount(&mut self) -> Result<(), String> {
        // 等待前端 ready（由 mark_ready() -> notify_all() 唤醒）后再挂载：
        // 挂载会读取窗口句柄并改其父子/样式，必须等 webview 真正建起来。
        Self::wait_ready(std::time::Duration::from_secs(100))?;

        // 窗口 getter 会同步等主线程回执，只在这里（不持 manager 锁）读一次并记住；
        // 之后 `show_web` / `show_app` 在 manager 锁内只调 `navigate`。
        // 读取失败只记日志：图片 / 视频不受影响，网页壁纸会报「未知应用页 URL」。
        match self.window.url() {
            Ok(url) if url.scheme() != "file" => self.app_url = Some(url),
            Ok(url) => tracing::warn!("挂载时壁纸窗口不在应用页: {url}"),
            Err(error) => tracing::warn!("读取壁纸窗口 URL 失败: {error}"),
        }
        #[cfg(target_os = "windows")]
        match self.window.hwnd() {
            Ok(hwnd) => self.hwnd = Some(hwnd.0 as isize),
            Err(error) => tracing::warn!("取壁纸窗口句柄失败: {error}"),
        }

        #[cfg(target_os = "windows")]
        tauri_plugin_wemt::attach_window(&self.window, None).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        {
            crate::wallpaper::window_mount_macos::mount_to_desktop(&self.window)?;
        }

        // 建窗时是 visible(false)（避免挂载前闪一下全屏窗口），挂好后转常显。
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;

        let target = self.window.clone();
        self.pinger = Some(super::ping::Pinger::start(
            self.window.label().to_string(),
            // 重载当前文档；窗口已销毁时 reload 返回错误，只记日志。
            move || {
                if let Err(error) = target.reload() {
                    tracing::warn!("重载壁纸窗口失败: {error}");
                    return;
                }
                // 同 `show_web`：旧文档的 JS 监听（含 wallpaper-ping）随重载作废，Tauri 不会自己清。
                target.clear_js_listeners();
            },
        ));
        Ok(())
    }

    fn reset_pinger(&self) {
        if let Some(pinger) = &self.pinger {
            pinger.reset();
        }
    }

    /// 显示网页壁纸：把整个窗口导航到入口的 `file://`。同一入口重复调用直接返回
    /// （改样式等也会走到这里，不重新加载页面）。
    ///
    /// 只调 `navigate`（投递即返回），不调会同步等主线程的 getter：调用方持着 manager 锁。
    pub fn show_web(&mut self, dir: PathBuf, entry: Url) -> Result<(), String> {
        if self.web.as_ref().is_some_and(|web| web.entry == entry) {
            return Ok(());
        }
        // 没有回程地址就不离开应用页，否则之后切回图片 / 视频壁纸时回不来。
        if self.app_url.is_none() {
            return Err("未知应用页 URL，无法显示网页壁纸".to_string());
        }
        let label = self.window.label();
        tauri_runtime_cef::set_file_document_root(label, Some(dir.clone()))
            .map_err(|error| format!("设置文件根目录失败: {error}"))?;
        if let Err(error) = self.window.navigate(entry.clone()) {
            // 页面没换：根目录恢复成仍在显示的那张（应用页则清空）。
            let previous = self.web.as_ref().map(|web| web.dir.clone());
            let _ = tauri_runtime_cef::set_file_document_root(label, previous);
            return Err(format!("导航到网页壁纸失败: {error}"));
        }
        // 旧文档（应用页或上一张网页壁纸）注册的 JS 事件监听随它作废：Tauri 只在销毁 webview 时
        // 清理，留着的话之后每个这类事件仍会向新文档 eval 投递脚本。新文档要先加载、执行脚本
        // 才会 listen，晚于这里。导航失败时页面没换，监听保留（上面已返回）。
        self.window.clear_js_listeners();
        self.reset_pinger();
        tracing::debug!("壁纸窗口 → {entry}");
        self.web = Some(WebPage { dir, entry });
        #[cfg(target_os = "windows")]
        if self.forwarder.is_none() {
            match self.hwnd {
                Some(hwnd) => {
                    self.forwarder = Some(super::input_forward::InputForwarder::start(label, hwnd))
                }
                None => tracing::warn!("没有壁纸窗口句柄，不转发桌面鼠标"),
            }
        }
        Ok(())
    }

    /// 回到应用页，由 Vue 渲染图片 / 视频。本来就在应用页时什么都不做。
    ///
    /// 同 [`Self::show_web`]，只调 `navigate`。
    pub fn show_app(&mut self) {
        let Some(web) = self.web.take() else {
            return;
        };
        #[cfg(target_os = "windows")]
        {
            // 丢弃即置停止标志，线程最多一个周期后自行退出。
            self.forwarder = None;
        }
        let label = self.window.label();
        let _ = tauri_runtime_cef::set_file_document_root(label, None);
        // `show_web` 保证进入网页壁纸时 app_url 已有值。
        let Some(app_url) = self.app_url.clone() else {
            return;
        };
        if let Err(error) = self.window.navigate(app_url.clone()) {
            tracing::warn!("从 {} 导航回应用页失败: {error}", web.entry);
            return;
        }
        // 同 `show_web`：清掉网页壁纸垫片注册的监听。
        self.window.clear_js_listeners();
        self.reset_pinger();
        tracing::debug!("壁纸窗口 → {app_url}");
    }
}

impl<R: Runtime> Drop for WallpaperWindow<R> {
    /// 离开窗口模式（`WindowWallpaperManager::cleanup`）时随窗口一起丢弃：清空文件根目录，
    /// 鼠标转发线程由 `InputForwarder` 自己的 `Drop` 停止。
    fn drop(&mut self) {
        let _ = tauri_runtime_cef::set_file_document_root(self.window.label(), None);
    }
}
