// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{Runtime, WebviewWindow};

/// 桌面层 Z-order 的**唯一实现**。
///
/// 壁纸窗口是 Progman 的子窗口,和桌面图标层(`SHELLDLL_DefView` / `SysListView32`)
/// 以及 `WorkerW` 是兄弟。任何会改变 Z-order 的操作(SetParent、show、主窗口最小化…)
/// 之后都要重新压一次层次,否则壁纸会盖住桌面图标。
///
/// 此前这套逻辑在四处各抄了一份(挂载中、挂载后、remount、fix_wallpaper_zorder 命令),
/// 必然同步漂移;现全部改为调用本模块。
#[cfg(target_os = "windows")]
pub(crate) mod zorder {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
    };

    const HWND_TOP: HWND = 0;

    /// Win11 "raised desktop" 标志。注意:读的是 **Progman 的**扩展样式,
    /// 用来判断桌面结构形态 —— 与壁纸窗口自身是否带该标志无关。
    const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x0020_0000;

    pub(crate) fn wide(s: &str) -> Vec<u16> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    /// 桌面根窗口。
    pub(crate) fn progman() -> Option<HWND> {
        let hwnd = unsafe { FindWindowW(wide("Progman").as_ptr(), std::ptr::null()) };
        (hwnd != 0).then_some(hwnd)
    }

    /// Progman 是否为 Win11 raised desktop 形态(其 EX_STYLE 带
    /// `WS_EX_NOREDIRECTIONBITMAP`)。Win10 及更早返回 false。
    pub(crate) fn is_raised_desktop(progman: HWND) -> bool {
        let ex_style = unsafe { GetWindowLongPtrW(progman, GWL_EXSTYLE) } as u32;
        (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0
    }

    /// Progman 下的桌面图标层。
    pub(crate) fn def_view(progman: HWND) -> Option<HWND> {
        let hwnd = unsafe {
            FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            )
        };
        (hwnd != 0).then_some(hwnd)
    }

    /// 把桌面图标层提到 Progman 子窗口的最顶。
    pub(crate) fn raise_icon_layer(def_view: HWND) {
        unsafe {
            ShowWindow(def_view, SW_SHOW);
            SetWindowPos(
                def_view,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );

            let folder_view =
                FindWindowExW(def_view, 0, wide("SysListView32").as_ptr(), std::ptr::null());
            if folder_view != 0 {
                ShowWindow(folder_view, SW_SHOW);
                SetWindowPos(
                    folder_view,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    }

    /// 把壁纸窗口压到图标层之下(只改 Z-order,不动位置和尺寸)。
    pub(crate) fn sink_below_icons(wallpaper: HWND, def_view: HWND) {
        unsafe {
            SetWindowPos(
                wallpaper,
                def_view,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    /// 恢复桌面层次:图标层在上、壁纸窗口在下。
    ///
    /// 只在 Win11 raised desktop 下生效 —— 旧版 Windows 的壁纸窗口挂在 WorkerW 下,
    /// 天然就在图标层之下,无需干预。
    ///
    /// `wallpaper` 为 `None` 时只提升图标层(用于还没有壁纸窗口句柄的场景)。
    pub(crate) fn restore(wallpaper: Option<HWND>) {
        let Some(progman) = progman() else { return };
        if !is_raised_desktop(progman) {
            return;
        }
        let Some(def_view) = def_view(progman) else {
            return;
        };
        raise_icon_layer(def_view);
        if let Some(wallpaper) = wallpaper {
            sink_below_icons(wallpaper, def_view);
        }
    }
}

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

pub struct WallpaperWindow<R: Runtime> {
    window: WebviewWindow<R>,
}

impl<R: Runtime> WallpaperWindow<R> {
    /// 由 `WindowWallpaperManager::init()` 在确保窗口已创建后调用。
    pub fn new(window: WebviewWindow<R>) -> Self {
        Self { window }
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
    pub fn mount(&self) -> Result<(), String> {
        // 等待前端 ready（由 mark_ready() -> notify_all() 唤醒）后再挂载：
        // 挂载会读取窗口句柄并改其父子/样式，必须等 webview 真正建起来。
        Self::wait_ready(std::time::Duration::from_secs(100))?;

        #[cfg(target_os = "windows")]
        {
            use crate::wallpaper::window_mount;
            window_mount::mount_to_desktop_saikyo(self.hwnd()?)?;
        }

        #[cfg(target_os = "macos")]
        {
            crate::wallpaper::window_mount_macos::mount_to_desktop(&self.window)?;
        }

        // 建窗时是 visible(false)（避免挂载前闪一下全屏窗口），挂好后转常显。
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;

        // show() 会打乱 Z-order，收尾再压一次层次。
        #[cfg(target_os = "windows")]
        zorder::restore(Some(self.hwnd()?));

        Ok(())
    }

    /// 壁纸窗口的原生句柄。
    #[cfg(target_os = "windows")]
    pub fn hwnd(&self) -> Result<windows_sys::Win32::Foundation::HWND, String> {
        let hwnd = self
            .window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        Ok(hwnd.0 as isize)
    }
}
