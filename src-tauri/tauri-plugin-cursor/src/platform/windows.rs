//! Windows 探针：`GetCursorPos` / `GetAsyncKeyState` 读光标与左键，`WindowFromPoint` 判断光标下是什么。
//!
//! 光标的客户区物理坐标除以窗口 DPI 缩放得视图坐标（不取整）。桌面的判定：光标下窗口的根窗口是桌面宿主
//! （`Progman` / `WorkerW`，即桌面图标层或壁纸层本身）。本窗口的判定：光标下窗口的根窗口就是被观察窗口的
//! 根窗口（应用自己的弹出窗口、别的应用窗口盖在上面时不算）。

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetClientRect, GetCursorPos, IsWindow, WindowFromPoint, GA_ROOT,
};

use super::NativeWindow;
use crate::hub::{Probe, Sample};

/// 桌面宿主窗口类名：桌面图标层（`Progman` 下的 `SHELLDLL_DefView` / `SysListView32`）
/// 与壁纸层（`WorkerW`，壁纸窗口挂在它下面）的根窗口。
const DESKTOP_ROOT_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

/// 光标下窗口的根窗口类名是否属于桌面：点在桌面空白处或图标上，而不是别的应用窗口上。
pub(crate) fn is_desktop_root_class(root_class: &str) -> bool {
    DESKTOP_ROOT_CLASSES.contains(&root_class)
}

/// 客户区物理像素 → CSS 像素：除以窗口的 DPI 缩放（`dpi / 96`，取不到 DPI 时 `dpi` 为 0，按 1 算）。不取整。
fn client_to_css(x: i32, y: i32, dpi: u32) -> (f64, f64) {
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    (x as f64 / scale, y as f64 / scale)
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// 光标处窗口的根窗口；没有窗口时 `0`。
fn root_at(point: POINT) -> HWND {
    let hit = unsafe { WindowFromPoint(point) };
    if hit == 0 {
        return 0;
    }
    unsafe { GetAncestor(hit, GA_ROOT) }
}

/// 光标处的窗口是否属于桌面（根窗口是 `Progman` / `WorkerW`）。
fn cursor_over_desktop(point: POINT) -> bool {
    let root = root_at(point);
    root != 0 && is_desktop_root_class(&class_name(root))
}

/// 光标处窗口的根窗口是不是 `hwnd` 的根窗口。
fn cursor_over_window(point: POINT, hwnd: HWND) -> bool {
    let root = root_at(point);
    root != 0 && root == unsafe { GetAncestor(hwnd, GA_ROOT) }
}

/// 窗口（`hwnd`）的探针。
pub(crate) struct WindowsProbe {
    /// 以 `isize` 保存句柄，结构体可以交给轮询线程。
    hwnd: isize,
    /// 上一次采样的光标屏幕坐标，按下沿判断桌面用。
    cursor: (i32, i32),
}

impl WindowsProbe {
    pub(crate) fn new(hwnd: NativeWindow) -> Self {
        Self {
            hwnd,
            cursor: (0, 0),
        }
    }
}

impl Probe for WindowsProbe {
    fn alive(&mut self) -> bool {
        unsafe { IsWindow(self.hwnd as HWND) != 0 }
    }

    fn sample(&mut self) -> Option<Sample> {
        let hwnd = self.hwnd as HWND;
        let mut cursor = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut cursor) } == 0 {
            return None;
        }
        self.cursor = (cursor.x, cursor.y);
        let left_down = (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as u16 & 0x8000) != 0;

        let mut client = POINT {
            x: cursor.x,
            y: cursor.y,
        };
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
        Some(Sample {
            view: client_to_css(client.x, client.y, dpi),
            inside,
            left_down,
            present: true,
        })
    }

    fn over_desktop(&mut self) -> bool {
        cursor_over_desktop(POINT {
            x: self.cursor.0,
            y: self.cursor.1,
        })
    }

    fn over_window(&mut self) -> bool {
        cursor_over_window(
            POINT {
                x: self.cursor.0,
                y: self.cursor.1,
            },
            self.hwnd as HWND,
        )
    }
}

/// 取窗口的 HWND。
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow> {
    match window.hwnd() {
        Ok(hwnd) => Some(hwnd.0 as isize),
        Err(error) => {
            tracing::debug!("取窗口句柄失败: {error}");
            None
        }
    }
}

/// 一次性取光标在窗口客户区里的位置（CSS 像素，不论光标在不在窗口里，可为负或越界）。
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)> {
    let hwnd = native as HWND;
    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) } == 0 || unsafe { ScreenToClient(hwnd, &mut point) } == 0
    {
        return None;
    }
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    Some(client_to_css(point.x, point.y, dpi))
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

    #[test]
    fn client_to_css_divides_by_dpi_scale_without_rounding() {
        assert_eq!(client_to_css(300, 150, 96), (300.0, 150.0));
        assert_eq!(client_to_css(300, 150, 144), (200.0, 100.0));
        // 取不到 DPI 按 1 算；越界（负）不钳制；不取整
        assert_eq!(client_to_css(-30, 20, 0), (-30.0, 20.0));
        assert_eq!(client_to_css(100, 0, 120), (80.0, 0.0));
        assert_eq!(client_to_css(1, 0, 144), (1.0 / 1.5, 0.0));
    }
}
