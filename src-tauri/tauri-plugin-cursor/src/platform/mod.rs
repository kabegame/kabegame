//! 平台实现：Windows、macOS 各一份，其它平台是空实现。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{native_window, position_in_window};
#[cfg(target_os = "windows")]
pub use windows::{native_window, position_in_window};

use crate::hub::Probe;

/// 窗口的原生标识：Windows 是 HWND，macOS 是 `NSWindow.windowNumber`。
pub type NativeWindow = isize;

/// 为 `native` 窗口造探针；不支持的平台返回 `None`。
pub(crate) fn probe(native: NativeWindow) -> Option<Box<dyn Probe>> {
    #[cfg(target_os = "windows")]
    {
        Some(Box::new(windows::WindowsProbe::new(native)))
    }
    #[cfg(target_os = "macos")]
    {
        Some(Box::new(macos::MacProbe::new(native)))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // TODO:[WPE_SCENE] Linux（X11 可用 XQueryPointer，Wayland 拿不到全局光标）
        let _ = native;
        None
    }
}

/// 取窗口的原生标识（macOS 上会同步等主线程：只在异步命令或不持锁处调用）。不支持的平台 `None`。
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow> {
    // TODO:[WPE_SCENE] Linux（X11 可用 XQueryPointer，Wayland 拿不到全局光标）
    let _ = window;
    None
}

/// 一次性取光标在窗口里的视图坐标（CSS 像素，可越界）。
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)> {
    // TODO:[WPE_SCENE] Linux（X11 可用 XQueryPointer，Wayland 拿不到全局光标）
    let _ = native;
    None
}
