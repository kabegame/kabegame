//! Windows 探针：`GetCursorPos` / `GetAsyncKeyState` 读光标与左键，`WindowFromPoint` 判断光标下是不是桌面。
//!
//! 光标的客户区物理坐标除以窗口 DPI 缩放得视图坐标。桌面的判定：光标下窗口的根窗口是桌面宿主
//! （`Progman` / `WorkerW`，即桌面图标层或壁纸层本身）。

use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetClassNameW, GetClientRect, GetCursorPos, IsWindow, WindowFromPoint, GA_ROOT,
};

use super::{DesktopProbe, Sample};

/// 桌面宿主窗口类名：桌面图标层（`Progman` 下的 `SHELLDLL_DefView` / `SysListView32`）
/// 与壁纸层（`WorkerW`，壁纸窗口挂在它下面）的根窗口。
const DESKTOP_ROOT_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

/// 光标下窗口的根窗口类名是否属于桌面：点在桌面空白处或图标上，而不是别的应用窗口上。
pub(crate) fn is_desktop_root_class(root_class: &str) -> bool {
    DESKTOP_ROOT_CLASSES.contains(&root_class)
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

/// 壁纸窗口（`hwnd`）的探针。
pub(crate) struct WindowsProbe {
    /// 以 `isize` 保存句柄，结构体可以交给转发线程。
    hwnd: isize,
    /// 上一次采样的光标屏幕坐标，按下沿判断桌面用。
    cursor: (i32, i32),
}

impl WindowsProbe {
    pub(crate) fn new(hwnd: isize) -> Self {
        Self {
            hwnd,
            cursor: (0, 0),
        }
    }
}

impl DesktopProbe for WindowsProbe {
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
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        let view = (
            (client.x as f64 / scale).round() as i32,
            (client.y as f64 / scale).round() as i32,
        );

        Some(Sample {
            view,
            inside,
            left_down,
        })
    }

    fn over_desktop(&mut self) -> bool {
        cursor_over_desktop(POINT {
            x: self.cursor.0,
            y: self.cursor.1,
        })
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
