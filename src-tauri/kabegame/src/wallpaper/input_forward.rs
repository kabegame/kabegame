//! Windows 桌面鼠标转发：把用户在桌面上的移动与左键点击注入到壁纸窗口（WPE 网页壁纸）。
//!
//! 照 Wallpaper Engine 的做法：不装鼠标钩子，而是由后台线程每帧轮询光标位置与左键状态。
//! - 光标在壁纸窗口客户区内移动 → 客户区物理坐标除以窗口 DPI 缩放得视图坐标，注入 `Move`；
//!   离开客户区时注入一次 `Leave`。
//! - 左键按下沿 → `WindowFromPoint` 看光标下的窗口，只有它的根窗口是桌面宿主（`Progman` /
//!   `WorkerW`，即桌面图标层或壁纸层本身）才注入 `LeftDown`；抬起沿只要按下被转发过就注入
//!   `LeftUp`，保证按下 / 抬起成对。
//! - 不拦截、不吞掉任何输入：Explorer 照常收到点击。
//!
//! 只在「窗口模式 + 当前是网页壁纸」时运行，由 `wpe_web_host` 启停。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use tauri_runtime_cef::MouseInjection;
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetClientRect, GetCursorPos, IsWindow, WindowFromPoint, GA_ROOT,
};

/// 轮询周期（约 60 Hz）。
const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// 桌面宿主窗口类名：桌面图标层（`Progman` 下的 `SHELLDLL_DefView` / `SysListView32`）
/// 与壁纸层（`WorkerW`，壁纸窗口挂在它下面）的根窗口。
const DESKTOP_ROOT_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

/// 光标下窗口的根窗口类名是否属于桌面：点在桌面空白处或图标上，而不是别的应用窗口上。
pub(crate) fn is_desktop_root_class(root_class: &str) -> bool {
    DESKTOP_ROOT_CLASSES.contains(&root_class)
}

/// 正在运行的转发线程。`stop()` 只置停止标志、不 join：线程最多一个周期后自行退出，
/// 调用方（可能在主线程）不会被阻塞。
pub struct InputForwarder {
    stop: Arc<AtomicBool>,
    _handle: JoinHandle<()>,
}

impl InputForwarder {
    /// 为 `webview_label` 的壁纸窗口（`hwnd`）启动转发线程。
    pub fn start(webview_label: &str, hwnd: isize) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let label = webview_label.to_string();
        let thread_stop = stop.clone();
        let handle = std::thread::Builder::new()
            .name("wpe-input-forward".into())
            .spawn(move || run(label, hwnd as HWND, thread_stop))
            .expect("spawn wpe input forward thread");
        Self {
            stop,
            _handle: handle,
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for InputForwarder {
    fn drop(&mut self) {
        self.stop();
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// 光标处的窗口是否属于桌面（根窗口是 `Progman` / `WorkerW`）。
fn cursor_over_desktop(point: POINT) -> bool {
    let hit = unsafe { WindowFromPoint(point) };
    if hit == 0 {
        return false;
    }
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    if root == 0 {
        return false;
    }
    is_desktop_root_class(&class_name(root))
}

fn inject(label: &str, input: MouseInjection) {
    if let Err(error) = tauri_runtime_cef::inject_mouse(label, input) {
        tracing::warn!("注入鼠标事件失败: {error}");
    }
}

fn run(label: String, hwnd: HWND, stop: Arc<AtomicBool>) {
    // 上一次注入移动时的视图坐标（光标在客户区内时）。
    let mut last_move: Option<(i32, i32)> = None;
    // 上一帧的视图坐标（抬起 / 停止时补发用）。
    let mut last_view = (0, 0);
    let mut was_down = false;
    let mut down_forwarded = false;

    loop {
        if stop.load(Ordering::Acquire) || unsafe { IsWindow(hwnd) } == 0 {
            break;
        }

        let mut cursor = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut cursor) } != 0 {
            let left_down = (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0;

            let mut client = cursor;
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mapped = unsafe { ScreenToClient(hwnd, &mut client) } != 0
                && unsafe { GetClientRect(hwnd, &mut rect) } != 0;
            let inside = mapped
                && client.x >= 0
                && client.y >= 0
                && client.x < rect.right
                && client.y < rect.bottom;

            let dpi = unsafe { GetDpiForWindow(hwnd) };
            let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
            let view = (
                (client.x as f64 / scale).round() as i32,
                (client.y as f64 / scale).round() as i32,
            );

            if inside {
                if last_move != Some(view) {
                    inject(&label, MouseInjection::Move { x: view.0, y: view.1 });
                    last_move = Some(view);
                }
            } else if last_move.take().is_some() {
                inject(&label, MouseInjection::Leave { x: view.0, y: view.1 });
            }

            if left_down && !was_down {
                // 按下沿：只转发落在本窗口范围内、且光标下是桌面（空白处或图标）的点击。
                if inside && cursor_over_desktop(cursor) {
                    inject(&label, MouseInjection::LeftDown { x: view.0, y: view.1 });
                    down_forwarded = true;
                }
            } else if !left_down && was_down && down_forwarded {
                inject(&label, MouseInjection::LeftUp { x: view.0, y: view.1 });
                down_forwarded = false;
            }

            was_down = left_down;
            last_view = view;
        }

        std::thread::sleep(POLL_INTERVAL);
    }

    // 停止时若按下已转发而尚未抬起，补一次抬起，页面不会卡在「按住」状态。
    if down_forwarded {
        inject(
            &label,
            MouseInjection::LeftUp {
                x: last_view.0,
                y: last_view.1,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_roots_are_progman_and_workerw() {
        assert!(is_desktop_root_class("Progman"));
        assert!(is_desktop_root_class("WorkerW"));
        // 别的应用窗口（含用 SysListView32 做列表的普通程序，根窗口是它自己的顶层窗口）
        assert!(!is_desktop_root_class("RegEdit_RegEdit"));
        assert!(!is_desktop_root_class("CabinetWClass"));
        assert!(!is_desktop_root_class("Shell_TrayWnd"));
        assert!(!is_desktop_root_class(""));
    }
}
