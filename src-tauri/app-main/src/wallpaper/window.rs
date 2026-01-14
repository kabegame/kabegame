// 窗口壁纸模块 - 类似 Wallpaper Engine 的实现

use kabegame_core::settings::Settings;
use std::sync::{Condvar, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

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

pub struct WallpaperWindow {
    window: WebviewWindow,
    app: AppHandle,
}

impl WallpaperWindow {
    pub fn new(app: AppHandle) -> Self {
        Self {
            window: app.get_webview_window("wallpaper").unwrap(),
            app,
        }
    }

    #[allow(dead_code)]
    pub fn sync_wallpaper(&self, image_path: &str) -> Result<(), String> {
        // 等待窗口完全初始化（前端 DOM + Vue 组件 + 事件监听器都已就绪）
        // 超时时间：最多等待 100 秒
        Self::wait_ready(std::time::Duration::from_secs(100))?;

        // 如果窗口已就绪，则直接推送壁纸更新事件到窗口
        self.app
            .emit("wallpaper-update-image", image_path)
            .map_err(|e| format!("推送壁纸图片事件失败: {}", e))?;

        // 推送样式和过渡效果事件
        if let Some(settings_state) = self.app.try_state::<Settings>() {
            if let Ok(s) = settings_state.get_settings() {
                let _ = self
                    .app
                    .emit("wallpaper-update-style", s.wallpaper_rotation_style);
                let _ = self.app.emit(
                    "wallpaper-update-transition",
                    s.wallpaper_rotation_transition,
                );
            }
        }

        // 在 Windows 上设置窗口为壁纸层
        self.set_window_as_wallpaper()
            .map_err(|e| format!("设置窗口为壁纸层失败: {}", e))?;

        // 显示窗口
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;
        Ok(())
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

    /// 重置 ready 标记（窗口重新创建或隐藏时调用）
    #[allow(dead_code)]
    pub fn reset_ready() {
        let n = ready_notify();
        if let Ok(mut ready) = n.ready.lock() {
            *ready = false;
        }
    }

    /// 检查窗口是否已 ready
    #[allow(dead_code)]
    pub fn is_ready() -> bool {
        let n = ready_notify();
        n.ready.lock().map(|g| *g).unwrap_or(false)
    }

    /// 等待窗口 ready（用于 window_manager 在 set_wallpaper 时阻塞等待）
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

    /// 更新壁纸图片
    pub fn update_image(&self, image_path: &str) -> Result<(), String> {
        // 事件改为广播，不依赖任何窗口引用（方便用 wallpaper-debug 验证事件是否到达）
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-image", image_path)
            .map_err(|e| format!("广播壁纸图片事件失败: {}", e))?;

        Ok(())
    }

    /// 重新挂载窗口到桌面（用于从原生模式切换回窗口模式时）
    pub fn remount(&self) -> Result<(), String> {
        // 先挂载窗口到桌面
        self.set_window_as_wallpaper()
            .map_err(|e| format!("重新挂载窗口到桌面失败: {}", e))?;

        // 显示窗口
        self.window
            .show()
            .map_err(|e| format!("显示壁纸窗口失败: {}", e))?;

        // 关键：show() 后可能会改变 Z-order，需要再次确保 DefView 在顶部
        // 特别是在从原生模式切换到窗口模式时
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowExW, FindWindowW, GetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
        };

        let tauri_hwnd = self
            .window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

        // 检查是否是 Windows 11 raised desktop
        unsafe {
            fn wide(s: &str) -> Vec<u16> {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                OsStr::new(s).encode_wide().chain(Some(0)).collect()
            }

            const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;
            const HWND_TOP: HWND = 0;

            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            if progman != 0 {
                let ex_style = GetWindowLongPtrW(progman, GWL_EXSTYLE) as u32;
                let is_raised_desktop = (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0;

                if is_raised_desktop {
                    eprintln!("[DEBUG-SAIKYO] remount: 检测到 Windows 11 raised desktop，确保 DefView 在顶部");

                    // 查找 DefView
                    let shell_dll_defview = FindWindowExW(
                        progman,
                        0,
                        wide("SHELLDLL_DefView").as_ptr(),
                        std::ptr::null(),
                    );

                    if shell_dll_defview != 0 {
                        // 确保 DefView 在顶部
                        ShowWindow(shell_dll_defview, SW_SHOW);
                        SetWindowPos(
                            shell_dll_defview,
                            HWND_TOP,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );

                        // 查找并提升 SysListView32
                        let folder_view = FindWindowExW(
                            shell_dll_defview,
                            0,
                            wide("SysListView32").as_ptr(),
                            std::ptr::null(),
                        );
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

                        // 确保壁纸窗口在 DefView 之下
                        SetWindowPos(
                            tauri_hwnd,
                            shell_dll_defview as HWND,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );

                        eprintln!("[DEBUG-SAIKYO] remount: ✓ 已重新调整 Z-order");
                    }
                }
            }
        }

        Ok(())
    }

    /// 更新壁纸样式
    pub fn update_style(&self, style: &str) -> Result<(), String> {
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-style", style)
            .map_err(|e| format!("广播壁纸样式事件失败: {}", e))?;
        Ok(())
    }

    /// 更新壁纸过渡效果
    pub fn update_transition(&self, transition: &str) -> Result<(), String> {
        let _ = self.window.as_ref();
        let _ = self.app.get_webview_window("wallpaper");
        self.app
            .emit("wallpaper-update-transition", transition)
            .map_err(|e| format!("广播壁纸过渡事件失败: {}", e))?;
        Ok(())
    }

    fn set_window_as_wallpaper(&self) -> Result<(), String> {
        use std::time::Duration;

        // 等待 wallpaper 窗口前端 ready（由 mark_ready() -> notify_all() 唤醒），
        // 避免靠固定 sleep 猜测窗口/DOM 初始化时机
        Self::wait_ready(Duration::from_secs(100))?;

        use crate::wallpaper::window_mount;
        use windows_sys::Win32::Foundation::HWND;

        let tauri_hwnd = self
            .window
            .hwnd()
            .map_err(|e| format!("无法获取壁纸窗口句柄(hwnd): {}", e))?;
        let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

        // 使用高级版挂载函数（来自 Window.rs 的完整实现）
        window_mount::mount_to_desktop_saikyo(tauri_hwnd)?;

        Ok(())
    }
}
