//! 平台实现：Windows、macOS 读全局光标；Linux 读不到，由应用推送外部来源（`linux`）；其它平台是空实现。

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{
    native_window, position_in_window, push_external_pointer, register_external_pointer,
    unregister_external_pointer,
};
#[cfg(target_os = "macos")]
pub use macos::{native_window, position_in_window};
#[cfg(target_os = "windows")]
pub use windows::{native_window, position_in_window};

use crate::hub::Probe;

/// 窗口的原生标识：Windows 是 HWND，macOS 是 `NSWindow.windowNumber`，Linux 是外部来源登记时分配的序号。
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
    #[cfg(target_os = "linux")]
    {
        linux::ExternalProbe::new(native).map(|probe| Box::new(probe) as Box<dyn Probe>)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = native;
        None
    }
}

/// 取窗口的原生标识（macOS 上会同步等主线程：只在异步命令或不持锁处调用）。不支持的平台 `None`。
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow> {
    let _ = window;
    None
}

/// 一次性取光标在窗口里的视图坐标（CSS 像素，可越界）。
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)> {
    let _ = native;
    None
}
