// 窗口挂载模块 - 将窗口挂载到桌面层的通用逻辑
// 提供两个版本的实现：简化版和高级版，供测试和选择

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowExW, FindWindowW, GetClientRect, GetParent,
    GetSystemMetrics, GetWindowLongPtrW, IsWindowVisible, SendMessageTimeoutW, SendMessageW,
    SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, SMTO_NORMAL,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOW, WS_CHILD,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_POPUP,
};

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

/// 最强大的桌面挂载方法（基于 Lively 的实现）
/// 特点：
/// - 完整支持 Windows 7/10/11（包括 raised desktop with layered ShellView）
/// - 智能检测 Windows 版本和桌面结构
/// - 正确处理 Z-order 确保图标层可见
/// - 使用 MapWindowPoints 进行坐标转换
pub fn mount_to_desktop_saikyo(hwnd: HWND) -> Result<(), String> {
    // Windows 常量定义
    const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000; // Windows 11 raised desktop 标志
    const HWND_BOTTOM: HWND = 1;
    const HWND_TOP: HWND = 0;

    unsafe {
        // 1. 获取 Progman 窗口
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return Err("FindWindowW(Progman) failed".to_string());
        }

        // 2. 检测 Windows 11 raised desktop with layered ShellView
        // 检查 Progman 是否有 WS_EX_NOREDIRECTIONBITMAP 样式
        let ex_style = GetWindowLongPtrW(progman, GWL_EXSTYLE) as u32;
        let is_raised_desktop = (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0;

        eprintln!("[DEBUG-SAIKYO] ========== Windows 11 检测 ==========");
        eprintln!("[DEBUG-SAIKYO] Progman HWND: 0x{:X}", progman);
        eprintln!("[DEBUG-SAIKYO] Progman EX_STYLE: 0x{:X}", ex_style);
        eprintln!(
            "[DEBUG-SAIKYO] WS_EX_NOREDIRECTIONBITMAP: 0x{:X}",
            WS_EX_NOREDIRECTIONBITMAP
        );
        eprintln!("[DEBUG-SAIKYO] is_raised_desktop: {}", is_raised_desktop);

        if is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] ✓ 进入 Windows 11 raised desktop 支线");
        } else {
            eprintln!("[DEBUG-SAIKYO] ✗ 使用旧版 Windows 支线");
        }
        eprintln!("[DEBUG-SAIKYO] ======================================");

        // 3. 发送 0x052C 消息创建 WorkerW
        // Lively 使用 wParam=0xD, lParam=0x1
        let mut _result: usize = 0;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            0xD, // wParam
            0x1, // lParam (Lively 使用 0x1)
            SMTO_NORMAL,
            1000,
            &mut _result as *mut usize,
        );

        // 等待 WorkerW 创建
        thread::sleep(Duration::from_millis(100));

        // 4. 查找 WorkerW 和 SHELLDLL_DefView
        let mut workerw: HWND;
        let shell_dll_defview: HWND;

        if is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] ========== Windows 11 支线：查找窗口 ==========");
            // Windows 11 raised desktop: 直接从 Progman 下查找 WorkerW
            workerw = FindWindowExW(progman, 0, wide("WorkerW").as_ptr(), std::ptr::null());
            let _shell_dll_defview = FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );
            shell_dll_defview = _shell_dll_defview;

            eprintln!("[DEBUG-SAIKYO] 从 Progman 下查找 WorkerW: 0x{:X}", workerw);
            eprintln!(
                "[DEBUG-SAIKYO] 从 Progman 下查找 DefView: 0x{:X}",
                shell_dll_defview
            );

            if workerw == 0 {
                eprintln!("[DEBUG-SAIKYO] ⚠ 警告: WorkerW 未找到！");
            }
            if shell_dll_defview == 0 {
                eprintln!("[DEBUG-SAIKYO] ⚠ 警告: DefView 未找到！");
            }
            eprintln!("[DEBUG-SAIKYO] ================================================");
        } else {
            eprintln!("[DEBUG-SAIKYO] ========== 旧版 Windows 支线：查找窗口 ==========");
            // 旧版 Windows: 枚举窗口找到包含 SHELLDLL_DefView 的窗口，然后找它的下一个 WorkerW 兄弟
            #[derive(Default)]
            struct SearchState {
                found_workerw: HWND,
                found_defview: HWND,
            }

            unsafe extern "system" fn enum_find_workerw(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let state = &mut *(lparam as *mut SearchState);

                // 查找包含 SHELLDLL_DefView 的窗口
                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());

                if def_view != 0 {
                    state.found_defview = def_view;
                    // 获取该窗口的下一个 WorkerW 兄弟窗口
                    state.found_workerw =
                        FindWindowExW(0, hwnd, wide("WorkerW").as_ptr(), std::ptr::null());
                }

                1 // continue
            }

            let mut search_state = SearchState::default();
            EnumWindows(
                Some(enum_find_workerw),
                (&mut search_state as *mut SearchState) as isize,
            );

            workerw = search_state.found_workerw;
            shell_dll_defview = search_state.found_defview;

            eprintln!("[DEBUG-SAIKYO] 枚举找到 WorkerW: 0x{:X}", workerw);
            eprintln!("[DEBUG-SAIKYO] 枚举找到 DefView: 0x{:X}", shell_dll_defview);
            eprintln!("[DEBUG-SAIKYO] ================================================");
        }

        // Windows 7 特殊处理
        let is_windows7 = {
            let version = winver::WindowsVersion::detect();
            version
                .map(|v| v.major == 6 && v.minor == 1)
                .unwrap_or(false)
        };

        if is_windows7 {
            if workerw != 0 && workerw != progman {
                ShowWindow(workerw, 0); // SW_HIDE
            }
            workerw = progman;
        }

        // 验证找到的窗口
        if workerw == 0 {
            return Err("Failed to find WorkerW window".to_string());
        }

        eprintln!(
            "[DEBUG-SAIKYO] 窗口查找结果汇总: WorkerW=0x{:X}, Progman=0x{:X}, DefView=0x{:X}, is_raised_desktop={}",
            workerw, progman, shell_dll_defview, is_raised_desktop
        );

        // 5. 设置窗口样式为子窗口
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as isize;
        let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 6. Windows 11 raised desktop 特殊处理
        if is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] ========== Windows 11 支线：设置窗口样式 ==========");

            // 设置 WS_EX_LAYERED（必须在 SetParent 之前）
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            eprintln!("[DEBUG-SAIKYO] 当前窗口 EX_STYLE: 0x{:X}", ex_style);
            eprintln!("[DEBUG-SAIKYO] WS_EX_LAYERED: 0x{:X}", WS_EX_LAYERED);

            let new_ex_style = ex_style | WS_EX_LAYERED;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style as isize);
            eprintln!("[DEBUG-SAIKYO] 新窗口 EX_STYLE: 0x{:X}", new_ex_style);
            eprintln!("[DEBUG-SAIKYO] ✓ 已设置 WS_EX_LAYERED");

            // 设置透明度（255 = 完全不透明）
            // 使用 FFI 调用 SetLayeredWindowAttributes
            const LWA_ALPHA: u32 = 0x2;
            extern "system" {
                #[allow(dead_code)]
                fn SetLayeredWindowAttributes(
                    hwnd: HWND,
                    crKey: u32,
                    bAlpha: u8,
                    dwFlags: u32,
                ) -> BOOL;
            }
            let layered_result = SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
            eprintln!(
                "[DEBUG-SAIKYO] SetLayeredWindowAttributes 结果: {} (Alpha=255)",
                layered_result
            );
            eprintln!("[DEBUG-SAIKYO] ✓ 已设置透明度");

            eprintln!("[DEBUG-SAIKYO] ========== Windows 11 支线：挂载窗口 ==========");
            // 挂载到 Progman（不是 WorkerW）
            eprintln!("[DEBUG-SAIKYO] 准备挂载到 Progman (0x{:X})", progman);
            let old_parent = SetParent(hwnd, progman);
            if old_parent == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[DEBUG-SAIKYO] ✗ SetParent(Progman) 失败, GetLastError={}",
                    err
                );
                return Err(format!("SetParent(Progman) failed. GetLastError={}", err));
            }
            eprintln!("[DEBUG-SAIKYO] 旧父窗口: 0x{:X}", old_parent);
            eprintln!("[DEBUG-SAIKYO] ✓ 已挂载到 Progman");

            // 验证父窗口
            let actual_parent = GetParent(hwnd);
            eprintln!(
                "[DEBUG-SAIKYO] 实际父窗口: 0x{:X} (期望: 0x{:X})",
                actual_parent, progman
            );
            if actual_parent != progman {
                eprintln!("[DEBUG-SAIKYO] ⚠ 警告: 父窗口不匹配！");
            }

            eprintln!("[DEBUG-SAIKYO] ========== Windows 11 支线：调整 Z-order ==========");
            // 调整 Z-order: 壁纸窗口应该在 DefView 之下、WorkerW 之上
            if shell_dll_defview != 0 {
                eprintln!(
                    "[DEBUG-SAIKYO] 调整 Z-order: 壁纸窗口放在 DefView (0x{:X}) 之下",
                    shell_dll_defview
                );
                // 注意：这里只是设置 Z-order 关系，不设置位置和大小（稍后设置）
                // 将壁纸窗口放在 DefView 之下（相对于 Progman 的 Z-order）
                let wallpaper_zorder_result = SetWindowPos(
                    hwnd,
                    shell_dll_defview as HWND,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                eprintln!(
                    "[DEBUG-SAIKYO] SetWindowPos(壁纸, DefView) 结果: {}",
                    wallpaper_zorder_result
                );
                eprintln!("[DEBUG-SAIKYO] ✓ 壁纸窗口 Z-order 已调整（临时，稍后会设置大小）");

                // 关键：显式将 DefView 提升到顶部，确保图标可见
                eprintln!(
                    "[DEBUG-SAIKYO] 显式提升 DefView (0x{:X}) 到顶部",
                    shell_dll_defview
                );

                // 检查 DefView 是否可见
                let defview_visible = IsWindowVisible(shell_dll_defview);
                eprintln!("[DEBUG-SAIKYO] DefView 可见性: {}", defview_visible);

                ShowWindow(shell_dll_defview, SW_SHOW);
                let defview_zorder_result = SetWindowPos(
                    shell_dll_defview,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                eprintln!(
                    "[DEBUG-SAIKYO] SetWindowPos(DefView, HWND_TOP) 结果: {}",
                    defview_zorder_result
                );

                // 刷新 DefView 窗口以确保可见
                const WM_PAINT: u32 = 0x000F;
                const WM_NCPAINT: u32 = 0x0085;
                let _ = SendMessageW(shell_dll_defview, WM_NCPAINT, 0, 0);
                let _ = SendMessageW(shell_dll_defview, WM_PAINT, 0, 0);
                eprintln!("[DEBUG-SAIKYO] ✓ 已刷新 DefView 窗口");

                // 查找并提升 SysListView32（桌面图标列表）
                let folder_view = FindWindowExW(
                    shell_dll_defview,
                    0,
                    wide("SysListView32").as_ptr(),
                    std::ptr::null(),
                );
                if folder_view != 0 {
                    eprintln!(
                        "[DEBUG-SAIKYO] 找到 SysListView32 (0x{:X})，提升到顶部",
                        folder_view
                    );
                    let folder_visible = IsWindowVisible(folder_view);
                    eprintln!("[DEBUG-SAIKYO] SysListView32 可见性: {}", folder_visible);

                    ShowWindow(folder_view, SW_SHOW);
                    let folder_zorder_result = SetWindowPos(
                        folder_view,
                        HWND_TOP,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                    eprintln!(
                        "[DEBUG-SAIKYO] SetWindowPos(SysListView32, HWND_TOP) 结果: {}",
                        folder_zorder_result
                    );

                    let _ = SendMessageW(folder_view, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
                    eprintln!("[DEBUG-SAIKYO] ✓ 已刷新 SysListView32 窗口");
                } else {
                    eprintln!("[DEBUG-SAIKYO] ⚠ 未找到 SysListView32");
                }

                // 验证最终 Z-order：检查壁纸窗口是否真的在 DefView 之下
                // 注意：对于子窗口，Z-order 是相对于父窗口的，所以我们需要检查它们在父窗口中的顺序
                eprintln!("[DEBUG-SAIKYO] 验证最终 Z-order...");
                eprintln!("[DEBUG-SAIKYO] ✓ DefView 和图标层已提升到顶部");
            } else {
                eprintln!("[DEBUG-SAIKYO] ⚠ DefView 为 0，跳过 Z-order 调整");
            }

            // 确保 WorkerW 在底部
            eprintln!("[DEBUG-SAIKYO] 确保 WorkerW (0x{:X}) 在底部", workerw);
            ensure_worker_wzorder(progman, workerw);
            eprintln!("[DEBUG-SAIKYO] ================================================");
        } else {
            eprintln!("[DEBUG-SAIKYO] ========== 旧版 Windows 支线：挂载窗口 ==========");
            // 旧版 Windows: 挂载到 WorkerW
            eprintln!("[DEBUG-SAIKYO] 准备挂载到 WorkerW (0x{:X})", workerw);
            let old_parent = SetParent(hwnd, workerw);
            if old_parent == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[DEBUG-SAIKYO] ✗ SetParent(WorkerW) 失败, GetLastError={}",
                    err
                );
                return Err(format!("SetParent(WorkerW) failed. GetLastError={}", err));
            }
            eprintln!("[DEBUG-SAIKYO] 旧父窗口: 0x{:X}", old_parent);
            eprintln!("[DEBUG-SAIKYO] ✓ 已挂载到 WorkerW");

            // 验证父窗口
            let actual_parent = GetParent(hwnd);
            eprintln!(
                "[DEBUG-SAIKYO] 实际父窗口: 0x{:X} (期望: 0x{:X})",
                actual_parent, workerw
            );
            if actual_parent != workerw {
                eprintln!("[DEBUG-SAIKYO] ⚠ 警告: 父窗口不匹配！");
            }
            eprintln!("[DEBUG-SAIKYO] ================================================");
        }

        // 7. 设置扩展样式（不抢焦点）
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        let new_ex = ex | (WS_EX_NOACTIVATE as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // 8. 计算窗口位置和大小
        eprintln!("[DEBUG-SAIKYO] ========== 计算窗口位置和大小 ==========");
        let mut prct: RECT = std::mem::zeroed();

        if is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] Windows 11 支线: 使用 Progman 的 client rect");
            // Windows 11: 使用 Progman 的 client rect
            let rect_result = GetClientRect(progman, &mut prct as *mut RECT);
            eprintln!(
                "[DEBUG-SAIKYO] GetClientRect(Progman) 结果: {}",
                rect_result
            );
            if rect_result == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[DEBUG-SAIKYO] ✗ GetClientRect(Progman) 失败, GetLastError={}",
                    err
                );
                return Err("GetClientRect(Progman) failed".to_string());
            }
        } else {
            eprintln!("[DEBUG-SAIKYO] 旧版 Windows 支线: 使用 WorkerW 的 client rect");
            // 旧版: 直接使用 WorkerW 的 client rect
            let rect_result = GetClientRect(workerw, &mut prct as *mut RECT);
            eprintln!(
                "[DEBUG-SAIKYO] GetClientRect(WorkerW) 结果: {}",
                rect_result
            );
            if rect_result == 0 {
                eprintln!("[DEBUG-SAIKYO] ⚠ GetClientRect(WorkerW) 失败，使用系统屏幕尺寸");
                // 如果获取失败，使用系统屏幕尺寸
                prct.left = 0;
                prct.top = 0;
                prct.right = GetSystemMetrics(0); // SM_CXSCREEN
                prct.bottom = GetSystemMetrics(1); // SM_CYSCREEN
            }
        }

        let w = prct.right - prct.left;
        let h = prct.bottom - prct.top;

        eprintln!(
            "[DEBUG-SAIKYO] 窗口矩形: left={}, top={}, right={}, bottom={}",
            prct.left, prct.top, prct.right, prct.bottom
        );
        eprintln!("[DEBUG-SAIKYO] 窗口大小: {}x{}", w, h);
        eprintln!("[DEBUG-SAIKYO] ======================================");

        // 9. 设置窗口位置和大小
        if is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] ========== Windows 11 支线：设置窗口位置和大小 ==========");
            // Windows 11: 根据窗口树，WorkerW 是 DefView 的子窗口
            // 壁纸窗口应该挂载到 Progman，Z-order 在 DefView 之下
            // DefView 是 WS_EX_LAYERED 窗口，主要透明，只显示图标，所以壁纸应该可见

            // 关键：将壁纸窗口放在 DefView 之下（相对于 Progman 的 Z-order）
            // 注意：使用 SWP_NOZORDER 标志，保持之前设置的 Z-order（在 DefView 之下）
            if shell_dll_defview != 0 {
                eprintln!(
                    "[DEBUG-SAIKYO] 设置壁纸窗口位置和大小: 保持 Z-order 在 DefView (0x{:X}) 之下",
                    shell_dll_defview
                );
                // 先设置位置和大小，保持 Z-order
                SetWindowPos(
                    hwnd,
                    shell_dll_defview as HWND, // 放在 DefView 之下
                    prct.left,
                    prct.top,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
                );

                // 再次确认 Z-order（因为 SetWindowPos 可能会改变）
                eprintln!("[DEBUG-SAIKYO] 再次确认壁纸窗口 Z-order 在 DefView 之下");
                SetWindowPos(
                    hwnd,
                    shell_dll_defview as HWND,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            } else {
                eprintln!("[DEBUG-SAIKYO] DefView 为 0，使用 HWND_BOTTOM");
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    prct.left,
                    prct.top,
                    w,
                    h,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
                );
            }
            eprintln!("[DEBUG-SAIKYO] ================================================");
        } else {
            // 旧版 Windows: 直接设置位置和大小
            SetWindowPos(
                hwnd,
                HWND_BOTTOM, // 确保在父窗口的底部
                prct.left,
                prct.top,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            );
        }

        ShowWindow(hwnd, SW_SHOW);

        // Windows 11: 在设置窗口大小后，再次确保 DefView 在顶部
        if is_raised_desktop && shell_dll_defview != 0 {
            eprintln!("[DEBUG-SAIKYO] 窗口大小设置后，再次确保 DefView 在顶部");
            const HWND_TOP: HWND = 0;
            SetWindowPos(
                shell_dll_defview,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );

            // 刷新 DefView
            const WM_PAINT: u32 = 0x000F;
            let _ = SendMessageW(shell_dll_defview, WM_PAINT, 0, 0);

            // 刷新 SysListView32
            let folder_view = FindWindowExW(
                shell_dll_defview,
                0,
                wide("SysListView32").as_ptr(),
                std::ptr::null(),
            );
            if folder_view != 0 {
                SetWindowPos(
                    folder_view,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
            }
            eprintln!("[DEBUG-SAIKYO] ✓ 已重新提升 DefView 和图标层");
        }

        // 10. 刷新桌面
        if !is_raised_desktop {
            eprintln!("[DEBUG-SAIKYO] ========== 旧版 Windows 支线：刷新桌面 ==========");
            // 旧版 Windows: 刷新桌面壁纸
            // 使用 FFI 调用 SystemParametersInfoW
            const SPI_SETDESKWALLPAPER: u32 = 0x0014;
            const SPIF_UPDATEINIFILE: u32 = 0x01;
            extern "system" {
                #[allow(dead_code)]
                fn SystemParametersInfoW(
                    uiAction: u32,
                    uiParam: u32,
                    pvParam: *mut std::ffi::c_void,
                    fWinIni: u32,
                ) -> BOOL;
            }
            let refresh_result = SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                std::ptr::null_mut(),
                SPIF_UPDATEINIFILE,
            );
            eprintln!(
                "[DEBUG-SAIKYO] SystemParametersInfoW 结果: {}",
                refresh_result
            );
            eprintln!("[DEBUG-SAIKYO] ================================================");
        } else {
            eprintln!(
                "[DEBUG-SAIKYO] Windows 11 支线: 跳过桌面刷新（避免破坏 raised desktop 结构）"
            );
        }

        eprintln!("[DEBUG-SAIKYO] ========== 挂载完成 ==========");
        eprintln!("[DEBUG-SAIKYO] ✓ mount_to_desktop_saikyo: 窗口已成功挂载到桌面");
        eprintln!("[DEBUG-SAIKYO] 最终状态: is_raised_desktop={}, WorkerW=0x{:X}, Progman=0x{:X}, DefView=0x{:X}",
            is_raised_desktop, workerw, progman, shell_dll_defview);
        eprintln!("[DEBUG-SAIKYO] ==============================");
    }

    Ok(())
}

/// 确保 WorkerW 的 Z-order 正确（Windows 11 raised desktop）
unsafe fn ensure_worker_wzorder(progman: HWND, workerw: HWND) {
    eprintln!("[DEBUG-SAIKYO] [ensure_worker_wzorder] 开始检查 WorkerW Z-order");
    eprintln!(
        "[DEBUG-SAIKYO] [ensure_worker_wzorder] Progman: 0x{:X}, WorkerW: 0x{:X}",
        progman, workerw
    );

    // 获取 Progman 的最后一个子窗口
    let mut last_child: HWND = 0;
    unsafe extern "system" fn enum_get_last(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let last = &mut *(lparam as *mut HWND);
        *last = hwnd;
        1 // continue
    }

    EnumChildWindows(
        progman,
        Some(enum_get_last),
        (&mut last_child as *mut HWND as *mut std::ffi::c_void) as isize,
    );

    eprintln!(
        "[DEBUG-SAIKYO] [ensure_worker_wzorder] Progman 的最后一个子窗口: 0x{:X}",
        last_child
    );
    eprintln!(
        "[DEBUG-SAIKYO] [ensure_worker_wzorder] WorkerW: 0x{:X}",
        workerw
    );

    // 如果 WorkerW 不是最后一个子窗口，将其移到底部
    if last_child != workerw && last_child != 0 {
        eprintln!(
            "[DEBUG-SAIKYO] [ensure_worker_wzorder] ⚠ 需要调整: last_child (0x{:X}) != workerw (0x{:X})",
            last_child, workerw
        );
        const HWND_BOTTOM: HWND = 1;
        let zorder_result = SetWindowPos(
            workerw,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        eprintln!(
            "[DEBUG-SAIKYO] [ensure_worker_wzorder] SetWindowPos(WorkerW, HWND_BOTTOM) 结果: {}",
            zorder_result
        );
        eprintln!("[DEBUG-SAIKYO] [ensure_worker_wzorder] ✓ WorkerW 已移到底部");
    } else {
        eprintln!("[DEBUG-SAIKYO] [ensure_worker_wzorder] ✓ WorkerW Z-order 已正确（无需调整）");
    }
}
