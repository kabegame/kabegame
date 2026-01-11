//! Windows 视觉效果相关工具（DWM 模糊等）。
//!
//! 目标：用 DWM BlurBehind + HRGN 实现“只在侧栏区域”出现毛玻璃，
//! 需要窗口本身开启透明（Tauri window.transparent=true），并让侧栏背景半透明。

use windows_sys::Win32::{
    Foundation::{BOOL, HWND},
    Graphics::{
        Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND},
        Gdi::{CreateRectRgn, DeleteObject},
    },
    UI::WindowsAndMessaging::GetClientRect,
};

/// 启用“窗口左侧矩形区域”的 DWM 模糊。
///
/// - `sidebar_width`: 侧栏宽度（像素，逻辑=物理由系统 DPI 决定；我们以 client rect 为准）
///
/// 说明：
/// - DWM 的 blur behind 只会在“透明像素”处可见，所以前端侧栏背景要有 alpha。
/// - 只设置 blur region 不会让区域自动透明。
pub fn enable_left_rect_blur(hwnd: HWND, sidebar_width: i32) -> Result<(), String> {
    if hwnd == 0 {
        return Err("hwnd is null".into());
    }
    if sidebar_width <= 0 {
        // 宽度为 0：等价于关闭 blur region（仍可保持 enable=false）
        return disable_blur(hwnd);
    }

    unsafe {
        let mut rect = std::mem::MaybeUninit::uninit();
        if GetClientRect(hwnd, rect.as_mut_ptr()) == 0 {
            return Err("GetClientRect failed".into());
        }
        let rect = rect.assume_init();
        let height = rect.bottom - rect.top;
        if height <= 0 {
            return Err("client rect height is invalid".into());
        }

        let width = sidebar_width.min(rect.right - rect.left).max(1);
        let rgn = CreateRectRgn(0, 0, width, height);
        if rgn == 0 {
            return Err("CreateRectRgn failed".into());
        }

        let bb = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
            fEnable: 1 as BOOL,
            hRgnBlur: rgn,
            fTransitionOnMaximized: 0 as BOOL,
        };

        let hr = DwmEnableBlurBehindWindow(hwnd, &bb);
        // 释放 GDI object
        let _ = DeleteObject(rgn);

        // windows-sys HRESULT: 0 表示 S_OK
        if hr != 0 {
            return Err(format!(
                "DwmEnableBlurBehindWindow failed: HRESULT=0x{hr:08X}"
            ));
        }
        Ok(())
    }
}

/// 关闭窗口 blur behind。
pub fn disable_blur(hwnd: HWND) -> Result<(), String> {
    if hwnd == 0 {
        return Err("hwnd is null".into());
    }
    unsafe {
        let bb = DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE,
            fEnable: 0 as BOOL,
            hRgnBlur: 0,
            fTransitionOnMaximized: 0 as BOOL,
        };
        let hr = DwmEnableBlurBehindWindow(hwnd, &bb);
        if hr != 0 {
            return Err(format!(
                "DwmEnableBlurBehindWindow(disable) failed: HRESULT=0x{hr:08X}"
            ));
        }
        Ok(())
    }
}
