//! Windows implementation of the wallpaper mount.
//!
//! Behaviour is modelled on static + runtime observation of Wallpaper Engine
//! 2.8.0.42 (see `step3-callchain-report-20261025.md`):
//!
//! * a background `WorkerW` is requested from Explorer with `WM_0x052C`;
//! * the render window becomes a `WS_CHILD` of that host, sized to the monitor
//!   in **physical** pixels, with frame-changing `SetWindowPos` flags;
//! * the host is validated with `IsWindow` + its property before every use;
//! * unmount restores the original parent, style, extended style and rectangle.

use std::ptr::{null, null_mut};

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{SetLastError, HANDLE, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MapWindowPoints, MonitorFromWindow, HDC, HMONITOR,
    MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, FindWindowExW, FindWindowW, GetClassNameW, GetParent, GetPropW, GetWindow,
    GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible, RemovePropW, SendMessageTimeoutW,
    SetParent, SetPropW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE,
    GW_CHILD, GW_HWNDNEXT, MONITORINFOF_PRIMARY, SMTO_NORMAL, SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOOWNERZORDER, SWP_NOZORDER, SW_HIDE, SW_SHOW,
    SW_SHOWNORMAL, WS_CAPTION, WS_CHILD, WS_EX_NOACTIVATE, WS_MAXIMIZE, WS_MINIMIZE, WS_SYSMENU,
    WS_THICKFRAME,
};

use crate::error::{Error, Result};
use crate::models::{MonitorInfo, Rect};

/// 请求 Explorer 创建壁纸 WorkerW 的未公开消息。
const WM_SPAWN_WORKERW: u32 = 0x052C;

/// Own property used to recognise a host this plugin prepared.
///
/// Deliberately **not** Wallpaper Engine's `WallpaperEngineParent`: marking a
/// window with WE's property would make WE (and other tools) believe they own
/// our host. We only ever read WE's property.
const WEMT_HOST_PROP: &str = "WemtHost";

/// Everything needed to undo a mount.
#[derive(Clone, Copy)]
pub struct WindowSnapshot {
    hwnd: isize,
    parent: isize,
    style: isize,
    ex_style: isize,
    rect: RECT,
    visible: bool,
}

impl std::fmt::Debug for WindowSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WindowSnapshot")
            .field("hwnd", &format_args!("0x{:x}", self.hwnd))
            .field("parent", &format_args!("0x{:x}", self.parent))
            .field("style", &format_args!("0x{:x}", self.style))
            .field("ex_style", &format_args!("0x{:x}", self.ex_style))
            .field(
                "rect",
                &format_args!(
                    "{},{},{},{}",
                    self.rect.left, self.rect.top, self.rect.right, self.rect.bottom
                ),
            )
            .field("visible", &self.visible)
            .finish()
    }
}

struct MonitorEntry {
    hmon: HMONITOR,
    info: MONITORINFO,
}

extern "system" fn collect_monitor(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let entries = unsafe { &mut *(data as *mut Vec<MonitorEntry>) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(hmon, &mut info) } != 0 {
        entries.push(MonitorEntry { hmon, info });
    }
    1
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn last_error(call: &'static str) -> Error {
    Error::win32(call, unsafe {
        windows_sys::Win32::Foundation::GetLastError()
    })
}

fn to_isize(hwnd: HWND) -> isize {
    hwnd as isize
}

fn from_isize(value: isize) -> HWND {
    value as HWND
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        None
    } else {
        Some(rect)
    }
}

fn child_of(hwnd: HWND, class: &str) -> bool {
    let mut child = unsafe { GetWindow(hwnd, GW_CHILD) };
    while !child.is_null() {
        if class_name(child).eq_ignore_ascii_case(class) {
            return true;
        }
        child = unsafe { GetWindow(child, GW_HWNDNEXT) };
    }
    false
}

/// True when `hwnd` looks like a wallpaper host: a `WorkerW` with no
/// `SHELLDLL_DefView` child and a usable size.
fn is_candidate_workerw(hwnd: HWND) -> bool {
    if !class_name(hwnd).eq_ignore_ascii_case("WorkerW") {
        return false;
    }
    if child_of(hwnd, "SHELLDLL_DefView") {
        return false;
    }
    window_rect(hwnd).is_some_and(|rect| rect.bottom - rect.top > 0x100)
}

struct HostSearch {
    found: Option<HWND>,
}

extern "system" fn enum_host(hwnd: HWND, data: LPARAM) -> BOOL {
    let search = unsafe { &mut *(data as *mut HostSearch) };
    if search.found.is_none() && is_candidate_workerw(hwnd) {
        search.found = Some(hwnd);
    }
    1
}

/// Ask Explorer for a background `WorkerW` and return the best candidate.
pub fn discover_host() -> Option<isize> {
    let progman = unsafe { FindWindowW(wide("Progman").as_ptr(), null()) };
    if progman.is_null() {
        return None;
    }

    // 先走 WE 在 Win11 上的 Progman 直属 WorkerW 路径。发送 0x52c 后 Explorer
    // 可能稍后才建窗，因此做有界重试，而不是只枚举一次。
    let mut host = find_host(progman);
    if host.is_none() {
        for (wparam, lparam) in [(0xd, 1), (0, 0)] {
            unsafe {
                SendMessageTimeoutW(
                    progman,
                    WM_SPAWN_WORKERW,
                    wparam,
                    lparam,
                    SMTO_NORMAL,
                    2500,
                    null_mut(),
                );
            }
            for _ in 0..10 {
                host = find_host(progman);
                if host.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if host.is_some() {
                break;
            }
        }
    }
    let host = host?;
    let prop = wide(WEMT_HOST_PROP);
    unsafe {
        if SetPropW(host, prop.as_ptr(), 1 as HANDLE) == 0 {
            return None;
        }
    }
    Some(to_isize(host))
}

fn find_host(progman: HWND) -> Option<HWND> {
    let worker_class = wide("WorkerW");
    let mut child = null_mut();
    loop {
        child = unsafe { FindWindowExW(progman, child, worker_class.as_ptr(), null()) };
        if child.is_null() {
            break;
        }
        if is_candidate_workerw(child) {
            return Some(child);
        }
    }
    let mut search = HostSearch { found: None };
    unsafe { EnumChildWindows(null_mut(), Some(enum_host), &mut search as *mut _ as LPARAM) };
    search.found
}

/// A host is usable only while the window lives and still carries our marker.
pub fn is_host_valid(host: isize) -> bool {
    if host == 0 {
        return false;
    }
    let hwnd = from_isize(host);
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let prop = wide(WEMT_HOST_PROP);
    let marker = unsafe { GetPropW(hwnd, prop.as_ptr()) };
    !marker.is_null()
}

pub fn release_host(host: isize) {
    if is_host_valid(host) {
        unsafe { RemovePropW(from_isize(host), wide(WEMT_HOST_PROP).as_ptr()) };
    }
}

pub fn is_attached(hwnd: isize, host: isize) -> bool {
    is_host_valid(host) && unsafe { GetParent(from_isize(hwnd)) == from_isize(host) }
}

pub fn snapshot(hwnd: isize) -> Result<WindowSnapshot> {
    let hwnd = from_isize(hwnd);
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(Error::InvalidWindow(to_isize(hwnd)));
    }
    let rect = window_rect(hwnd).ok_or_else(|| last_error("GetWindowRect"))?;
    Ok(WindowSnapshot {
        hwnd: to_isize(hwnd),
        parent: to_isize(unsafe { GetParent(hwnd) }),
        style: unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) },
        ex_style: unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) },
        rect,
        visible: unsafe { IsWindowVisible(hwnd) } != 0,
    })
}

/// Physical-pixel monitor list, ordered as Windows reports it.
fn monitors() -> Vec<MonitorEntry> {
    let mut entries: Vec<MonitorEntry> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            null_mut(),
            null(),
            Some(collect_monitor),
            &mut entries as *mut _ as LPARAM,
        );
    }
    entries
}

/// Resolve the target monitor and its physical rectangle.
pub fn monitor_for(hwnd: isize, index: Option<u32>) -> Result<(MonitorInfo, Rect)> {
    let entries = monitors();
    if entries.is_empty() {
        return Err(Error::HostNotFound);
    }

    let chosen = match index {
        Some(index) => entries.get(index as usize).ok_or(Error::HostNotFound)?,
        None => {
            let hmon = unsafe { MonitorFromWindow(from_isize(hwnd), MONITOR_DEFAULTTOPRIMARY) };
            entries
                .iter()
                .find(|entry| entry.hmon == hmon)
                .unwrap_or(&entries[0])
        }
    };

    let rect = Rect {
        left: chosen.info.rcMonitor.left,
        top: chosen.info.rcMonitor.top,
        right: chosen.info.rcMonitor.right,
        bottom: chosen.info.rcMonitor.bottom,
    };
    Ok((
        MonitorInfo {
            index: entries
                .iter()
                .position(|entry| entry.hmon == chosen.hmon)
                .unwrap_or(0) as u32,
            primary: chosen.info.dwFlags & MONITORINFOF_PRIMARY != 0,
            rect,
        },
        rect,
    ))
}

/// Turn an ordinary window into a wallpaper child of `host`.
pub fn mount(
    hwnd: isize,
    host: isize,
    rect: Rect,
    show_host: bool,
    snap: WindowSnapshot,
) -> Result<(u32, u32)> {
    let window = from_isize(hwnd);
    let host = from_isize(host);
    if unsafe { IsWindow(window) } == 0 {
        return Err(Error::InvalidWindow(hwnd));
    }

    let style = unsafe { GetWindowLongPtrW(window, GWL_STYLE) };
    let ex_style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
    let strip = (WS_MINIMIZE
        | WS_MAXIMIZE
        | WS_CAPTION
        | WS_SYSMENU
        | WS_THICKFRAME
        | windows_sys::Win32::UI::WindowsAndMessaging::WS_POPUP) as isize;
    let new_style = (style & !strip) | WS_CHILD as isize;

    unsafe {
        SetWindowLongPtrW(window, GWL_STYLE, new_style);
        SetWindowLongPtrW(window, GWL_EXSTYLE, ex_style | WS_EX_NOACTIVATE as isize);
        SetLastError(0);
        SetParent(window, host);
    }
    if unsafe { GetParent(window) } != host {
        let error = last_error("SetParent");
        let _ = restore(snap);
        return Err(error);
    }

    // SetWindowPos 对子窗口使用父窗口客户区坐标；监视器矩形是桌面坐标。
    let mut origin = POINT {
        x: rect.left,
        y: rect.top,
    };
    unsafe { MapWindowPoints(null_mut(), host, &mut origin, 1) };

    let width = rect.width();
    let height = rect.height();
    let flags = SWP_FRAMECHANGED
        | SWP_NOACTIVATE
        | SWP_NOZORDER
        | SWP_NOOWNERZORDER
        | SWP_NOCOPYBITS
        | SWP_ASYNCWINDOWPOS;
    if unsafe { SetWindowPos(window, null_mut(), origin.x, origin.y, width, height, flags) } == 0 {
        let error = last_error("SetWindowPos");
        let _ = restore(snap);
        return Err(error);
    }

    if show_host {
        unsafe { ShowWindow(host, SW_SHOWNORMAL) };
    }
    unsafe { ShowWindow(window, SW_SHOW) };

    Ok((
        new_style as u32,
        (ex_style | WS_EX_NOACTIVATE as isize) as u32,
    ))
}

/// Undo a mount: parent, style, extended style and rectangle.
pub fn restore(snap: WindowSnapshot) -> Result<()> {
    let window = from_isize(snap.hwnd);
    if unsafe { IsWindow(window) } == 0 {
        // The window died; nothing to restore.
        return Ok(());
    }

    unsafe {
        SetLastError(0);
        SetParent(window, from_isize(snap.parent));
    }
    if unsafe { GetParent(window) } != from_isize(snap.parent) {
        return Err(last_error("SetParent"));
    }
    let mut origin = POINT {
        x: snap.rect.left,
        y: snap.rect.top,
    };
    if snap.parent != 0 {
        unsafe { MapWindowPoints(null_mut(), from_isize(snap.parent), &mut origin, 1) };
    }
    let positioned = unsafe {
        SetWindowLongPtrW(window, GWL_STYLE, snap.style);
        SetWindowLongPtrW(window, GWL_EXSTYLE, snap.ex_style);
        SetWindowPos(
            window,
            null_mut(),
            origin.x,
            origin.y,
            snap.rect.right - snap.rect.left,
            snap.rect.bottom - snap.rect.top,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
    };
    if positioned == 0 {
        return Err(last_error("SetWindowPos"));
    }
    if snap.visible {
        unsafe { ShowWindow(window, SW_SHOW) };
    } else {
        unsafe { ShowWindow(window, SW_HIDE) };
    }
    Ok(())
}

/// Used by tests and diagnostics: current class name for a raw handle.
#[allow(dead_code)]
pub fn debug_class(hwnd: isize) -> String {
    class_name(from_isize(hwnd))
}
