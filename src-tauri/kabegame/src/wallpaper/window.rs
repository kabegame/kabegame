// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{Runtime, WebviewWindow};

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

/// 一个壁纸窗口。
///
/// 窗口始终停在应用页（`index.html?window=wallpaper`，`WallpaperWindow.vue`），图片 / 视频 / 网页壁纸
/// 都由 `WallpaperStage` 自驱动渲染：网页壁纸（`x-wpe/web`）是 web 层里的 `file:` iframe，与图库预览
/// 同一套组件与代码路径，窗口本身不再导航。后端只负责 Windows 的桌面鼠标转发（[`Self::set_mouse_forwarding`]），
/// 以及 ping 看门狗。
pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
    /// ping 看门狗：mount 完成后启动，随本对象丢弃而停止。
    pinger: Option<super::ping::Pinger>,
    /// 窗口句柄：`mount()` 时取，鼠标转发用。
    #[cfg(target_os = "windows")]
    hwnd: Option<isize>,
    /// 桌面鼠标转发：只在显示网页壁纸期间运行，丢弃即停止（见 `InputForwarder` 的 `Drop`）。
    #[cfg(target_os = "windows")]
    forwarder: Option<super::input_forward::InputForwarder>,
}

impl<R: Runtime> WallpaperWindow<R> {
    /// 由 `WindowWallpaperManager::init()` 在确保窗口已创建后调用。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self {
            window,
            pinger: None,
            #[cfg(target_os = "windows")]
            hwnd: None,
            #[cfg(target_os = "windows")]
            forwarder: None,
        }
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
        // 之后 `set_mouse_forwarding` 在 manager 锁内只用记下的句柄。
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
                // 旧文档主 frame 的 JS 监听（含 wallpaper-ping）随重载作废，Tauri 不会自己清；
                // 网页壁纸 iframe 的监听随 frame 销毁（`SubframeDestroyed`）清掉，这里一并清也无妨。
                target.clear_js_listeners();
            },
        ));
        Ok(())
    }

    /// 开关 Windows 的桌面鼠标转发：显示网页壁纸时开（桌面上的移动与左键点击注入到窗口，落到 web 层的
    /// iframe），否则关。重复调用幂等；其它平台什么都不做。
    ///
    /// 不调会同步等主线程的 getter：调用方持着 manager 锁。
    pub fn set_mouse_forwarding(&mut self, enabled: bool) {
        #[cfg(target_os = "windows")]
        {
            if !enabled {
                // 丢弃即置停止标志，线程最多一个周期后自行退出。
                self.forwarder = None;
                return;
            }
            if self.forwarder.is_some() {
                return;
            }
            match self.hwnd {
                Some(hwnd) => {
                    self.forwarder = Some(super::input_forward::InputForwarder::start(
                        self.window.label(),
                        hwnd,
                    ))
                }
                None => tracing::warn!("没有壁纸窗口句柄，不转发桌面鼠标"),
            }
        }
        #[cfg(not(target_os = "windows"))]
        let _ = enabled;
    }
}
