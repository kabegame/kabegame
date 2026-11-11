// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use crate::wallpaper::screens::ScreenInfo;
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{Runtime, WebviewWindow};

// 已完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）的壁纸窗口 label。
// 由 wallpaper_window_ready 命令按调用方 label 登记，并通过 notify_all 唤醒所有等待者；
// 每个壁纸窗口各等各的。
struct ReadyNotify {
    ready: Mutex<HashSet<String>>,
    cv: Condvar,
}

static WALLPAPER_WINDOW_READY: OnceLock<ReadyNotify> = OnceLock::new();

fn ready_notify() -> &'static ReadyNotify {
    WALLPAPER_WINDOW_READY.get_or_init(|| ReadyNotify {
        ready: Mutex::new(HashSet::new()),
        cv: Condvar::new(),
    })
}

/// 一个壁纸窗口。窗口模式下每块在线屏一个（见 `manager::window`），各有各的就绪握手、ping 看门狗与
/// 桌面鼠标转发。
///
/// 窗口始终停在应用页（`index.html?window=wallpaper`，`WallpaperWindow.vue`），图片 / 视频 / 网页壁纸
/// 都由 `WallpaperStage` 自驱动渲染：网页壁纸（`x-wpe/web`）是 web 层里的 `file:` iframe，与图库预览
/// 同一套组件与代码路径，窗口本身不再导航。后端只负责桌面鼠标转发（[`Self::set_mouse_forwarding`]），
/// 以及 ping 看门狗。
pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
    /// ping 看门狗：mount 完成后启动，随本对象丢弃而停止。
    pinger: Option<super::ping::Pinger>,
    /// 窗口的原生标识：`mount()` 时取，鼠标转发用。Windows 是 HWND，macOS 是窗口号（`NSWindow.windowNumber`）。
    native_id: Option<isize>,
    /// 桌面鼠标转发：只在显示网页 / 场景壁纸期间运行，丢弃即停止（见 `InputForwarder` 的 `Drop`）。
    forwarder: Option<super::input_forward::InputForwarder>,
}

impl<R: Runtime> WallpaperWindow<R> {
    /// 由 `WindowWallpaperManager::init()` 在确保窗口已创建后调用。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self {
            window,
            pinger: None,
            native_id: None,
            forwarder: None,
        }
    }

    /// 标记壁纸窗口 `label` 已完全初始化（由 wallpaper_window_ready 命令按调用方 label 调用）
    pub fn mark_ready(label: &str) {
        let n = ready_notify();
        // poisoned 也照常登记，不阻断主流程
        n.ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(label.to_string());
        n.cv.notify_all();
    }

    /// 撤销 `label` 的 ready 标记。**必须**在销毁该壁纸窗口时调用：标记是进程级静态、label 会被复用，
    /// 不撤销的话下次用同一个 label 重建窗口时 `wait_ready` 会立刻返回，挂载会打在一个
    /// 前端尚未加载的窗口上。
    pub fn reset_ready(label: &str) {
        ready_notify()
            .ready
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(label);
    }

    /// 等待窗口 `label` ready（挂载前阻塞等待前端加载完成）
    pub fn wait_ready(label: &str, timeout: std::time::Duration) -> Result<(), String> {
        let n = ready_notify();
        let guard = n
            .ready
            .lock()
            .map_err(|_| "WALLPAPER_WINDOW_READY mutex poisoned".to_string())?;

        let (guard, wait_res) =
            n.cv.wait_timeout_while(guard, timeout, |ready| !ready.contains(label))
                .map_err(|_| "WALLPAPER_WINDOW_READY condvar wait failed".to_string())?;

        if guard.contains(label) {
            Ok(())
        } else if wait_res.timed_out() {
            Err(format!("壁纸窗口 {label} 初始化超时，放弃挂载"))
        } else {
            Err(format!("壁纸窗口 {label} 等待就绪失败"))
        }
    }

    /// 把窗口挂到桌面层并显示。窗口在其存续期间保持挂载与常显，故本方法只在
    /// `WindowWallpaperManager` 建立窗口时调用一次；之后屏的位置 / 尺寸变了用 [`Self::place`]。
    ///
    /// `screen` 是窗口要铺满的屏；`None`（没有屏幕信息的平台）时铺满窗口所在的屏。
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    pub fn mount(&mut self, screen: Option<&ScreenInfo>) -> Result<(), String> {
        // 等待前端 ready（由 mark_ready() -> notify_all() 唤醒）后再挂载：
        // 挂载会读取窗口句柄并改其父子/样式，必须等 webview 真正建起来。
        Self::wait_ready(self.window.label(), std::time::Duration::from_secs(100))?;

        // 窗口 getter 会同步等主线程回执，只在这里（不持 manager 锁）读一次并记住；
        // 之后 `set_mouse_forwarding` 在 manager 锁内只用记下的标识。
        #[cfg(target_os = "windows")]
        match self.window.hwnd() {
            Ok(hwnd) => self.native_id = Some(hwnd.0 as isize),
            Err(error) => tracing::warn!("取壁纸窗口句柄失败: {error}"),
        }

        #[cfg(target_os = "windows")]
        tauri_plugin_wemt::attach_window(&self.window, None).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        {
            self.native_id = Some(crate::wallpaper::window_mount_macos::mount_to_desktop(
                &self.window,
                screen,
            )?);
        }

        // 建窗时是 visible(false)（避免挂载前闪一下窗口），挂好后转常显。
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
                // 旧文档主 frame 的 JS 监听（含 wallpaper-ping）随重载作废，Tauri 不会自己清；
                // 网页壁纸 iframe 的监听随 frame 销毁（`SubframeDestroyed`）清掉，这里一并清也无妨。
                target.clear_js_listeners();
            },
        ));
        Ok(())
    }

    /// 已挂载的壁纸窗口重新铺到 `screen`（屏的位置 / 尺寸变了、系统重排后）。只动窗口的 frame 与层级，
    /// 页面不重载。会同步等主线程，调用方不能持 manager 的窗口表锁。
    ///
    /// Windows 目前没有显示器枚举（只有一个窗口、铺主屏），不会走到这里。
    #[cfg(target_os = "macos")]
    pub fn place(window: &WebviewWindow<R>, screen: &ScreenInfo) -> Result<(), String> {
        crate::wallpaper::window_mount_macos::mount_to_desktop(window, Some(screen)).map(|_| ())
    }

    /// 开关桌面鼠标转发：显示网页 / 场景壁纸时开（桌面上的移动与左键点击注入到窗口，落到 web 层的
    /// iframe 或场景宿主），否则关。「暂停壁纸」不经这里：转发线程每轮自己读设置，暂停期间不注入。
    /// 重复调用幂等。
    ///
    /// 不调会同步等主线程的 getter：调用方持着 manager 锁。
    pub fn set_mouse_forwarding(&mut self, enabled: bool) {
        if !enabled {
            // 丢弃即置停止标志，线程最多一个周期后自行退出。
            self.forwarder = None;
            return;
        }
        if self.forwarder.is_some() {
            return;
        }
        let Some(native_id) = self.native_id else {
            tracing::warn!("没有壁纸窗口标识，不转发桌面鼠标");
            return;
        };
        #[cfg(target_os = "windows")]
        let probe = super::input_forward::win::WindowsProbe::new(native_id);
        #[cfg(target_os = "macos")]
        let probe = super::input_forward::mac::MacProbe::new(native_id);
        self.forwarder = Some(super::input_forward::InputForwarder::start(
            self.window.label(),
            probe,
        ));
    }
}
