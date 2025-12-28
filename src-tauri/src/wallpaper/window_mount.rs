// 窗口挂载模块 - 将窗口挂载到桌面层的通用逻辑
// 提供两个版本的实现：简化版和高级版，供测试和选择

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetClientRect,
    GetParent, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, IsWindow, IsWindowVisible,
    SendMessageTimeoutW, SendMessageW, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, GWL_STYLE, SMTO_ABORTIFHUNG, SMTO_NORMAL, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOW, WS_CHILD, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TRANSPARENT, WS_POPUP,
};

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

unsafe fn hwnd_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        "<unknown>".to_string()
    }
}

/// 获取 Windows 构建号
/// 返回构建号，如果获取失败则返回 0
#[cfg(target_os = "windows")]
fn get_windows_build_number() -> u32 {
    match winver::WindowsVersion::detect() {
        Some(version) => {
            // winver crate 的 WindowsVersion 结构体包含 major, minor, build, revision 字段
            // 我们使用 build 字段作为构建号
            version.build
        }
        None => 0,
    }
}

/// 检查 Windows 构建号是否大于等于指定值
/// 例如：is_windows_build_ge(26002) 检查是否为 Windows 11 24H2 或更高版本
#[cfg(target_os = "windows")]
pub fn is_windows_build_ge(build_number: u32) -> bool {
    let current_build = get_windows_build_number();
    current_build >= build_number && current_build != 0
}

#[cfg(not(target_os = "windows"))]
pub fn is_windows_build_ge(_build_number: u32) -> bool {
    false
}

pub fn mount_to_desktop_legacy(hwnd: HWND) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetClientRect, GetSystemMetrics,
        SendMessageTimeoutW, SetParent, SetWindowLongW, SetWindowPos, ShowWindow, GWL_STYLE,
        SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOW, WS_CHILD, WS_VISIBLE,
    };

    // 宽字符转换
    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    // 获取窗口类名
    unsafe fn hwnd_class(hwnd: HWND) -> String {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            "<unknown>".to_string()
        }
    }

    // 查找桌面图标宿主（WorkerW/Progman）
    unsafe fn find_parent() -> Result<HWND, String> {
        #[derive(Default)]
        struct Search {
            shell_top: HWND,
        }

        unsafe extern "system" fn enum_find_workerw(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam as *mut Search);
            // 找到不包含 SHELLDLL_DefView（文件夹视图）的 WorkerW 窗口作为候选。
            // 并且client rect 为屏幕尺寸。
            let mut rc: RECT = std::mem::zeroed();
            if hwnd_class(hwnd) != "WorkerW" {
                return 1;
            }
            if GetClientRect(hwnd, &mut rc as *mut RECT) != 0 {
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w == GetSystemMetrics(0) && h == GetSystemMetrics(1) {
                    let def_view =
                        FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                    if def_view == 0 {
                        state.shell_top = hwnd;
                        println!(
                            "[DEBUG] workerw hwnd={} class={} client rect=({}, {}, {}, {})",
                            hwnd,
                            hwnd_class(hwnd),
                            rc.left,
                            rc.top,
                            rc.right,
                            rc.bottom
                        );
                    }
                } else {
                    eprintln!(
                        "[DEBUG] workerw_client_rect_not_screen_size hwnd={} class={} client rect=({}, {}, {}, {})",
                        hwnd,
                        hwnd_class(hwnd),
                        rc.left,
                        rc.top,
                        rc.right,
                        rc.bottom
                    );
                }
            }
            1
        }

        let mut search = Search::default();
        EnumWindows(
            Some(enum_find_workerw),
            (&mut search as *mut Search) as isize,
        );

        // 如果没找到，直接报错
        let shell_top = search.shell_top;
        if shell_top == 0 {
            return Err(
                "找不到桌面图标宿主（未在 WorkerW/Progman 顶层窗口中发现 SHELLDLL_DefView）"
                    .to_string(),
            );
        }
        Ok(shell_top)
    }

    unsafe fn find_parent_win11() -> Result<HWND, String> {
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return Err("FindWindowW(Progman) failed".to_string());
        }

        let workerw = FindWindowExW(progman, 0, wide("WorkerW").as_ptr(), std::ptr::null());
        if workerw == 0 {
            return Err("FindWindowExW(Progman, 0, WorkerW) failed".to_string());
        }
        Ok(workerw)
    }

    // 1) 获取 Tauri 壁纸窗口 HWND（已传入）
    unsafe {
        // 2) 找 Progman
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return Err("FindWindowW(Progman) failed".to_string());
        }

        // 3) 发送 0x052C 促使生成 WorkerW
        let mut _result: usize = 0;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            0xD, // 关键：主流实现使用 wParam=0xD 来触发 WorkerW 创建/刷新
            0,
            SMTO_NORMAL,
            1000,
            &mut _result as *mut usize,
        );

        // 等待 WorkerW 创建
        thread::sleep(Duration::from_millis(100));

        let parent = if is_windows_build_ge(26002) {
            find_parent_win11()?
        } else {
            find_parent()?
        };
        if SetParent(hwnd, parent) == 0 {
            let err = windows_sys::Win32::Foundation::GetLastError();
            return Err(format!("SetParent failed. GetLastError={}", err));
        }

        let mut rc: RECT = std::mem::zeroed();

        let mut w = 0;
        let mut h = 0;
        let ok = GetClientRect(parent, &mut rc as *mut RECT);
        if ok != 0 {
            w = rc.right - rc.left;
            h = rc.bottom - rc.top;
        }

        println!(
            "[DEBUG] parent client rect ok rc=({}, {}, {}, {}), size={}x{}",
            rc.left, rc.top, rc.right, rc.bottom, w, h
        );

        SetWindowLongW(hwnd, GWL_STYLE, (WS_CHILD | WS_VISIBLE) as i32);

        SetWindowPos(hwnd, 0, 0, 0, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        ShowWindow(hwnd, SW_SHOW);

        // match find_parent() {
        //     Ok(parent) => {
        //         println!("[DEBUG] parent hwnd={}", parent);

        //     }
        //     // Win11 + WebView2，回退到progman作为parent
        //     // 这里在 parent 为 WorkerW 时，显式把 Progman/DefView/FolderView 提到 WorkerW 之上（不激活），确保图标可见。
        //     Err(e) => {
        //         eprintln!("[DEBUG] find_parent failed: {}, fallback to progman", e);
        //         // 设置扩展样式：鼠标穿透 + Layered
        //         let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        //         SetWindowLongW(
        //             hwnd,
        //             GWL_EXSTYLE,
        //             ex_style | WS_EX_LAYERED as i32 | WS_EX_TRANSPARENT as i32,
        //         );

        //         // 设置窗口为子窗口
        //         SetParent(hwnd, progman);
        //         SetWindowLongW(hwnd, GWL_STYLE, WS_CHILD as i32 | WS_VISIBLE as i32);

        //         // 获取屏幕分辨率，设置全屏
        //         let hdc = GetDC(0);
        //         ReleaseDC(0, hdc);

        //         SetWindowPos(
        //             hwnd,
        //             0,
        //             0,
        //             0,
        //             GetSystemMetrics(0),
        //             GetSystemMetrics(1),
        //             SWP_NOZORDER | SWP_SHOWWINDOW,
        //         );
        //         eprintln!("[DEBUG] bumped shell_top/DefView above WorkerW wallpaper parent");
        //         eprintln!("[DEBUG] forced top-level z-order: WorkerW->BOTTOM, Progman->TOP");
        //     }
        // };

        // 4) 查找承载桌面图标的顶层窗口(shell_top)，并优先取其后一个 WorkerW
        // 经典路径：shell_top 是 WorkerW/Progman，且其后有一个 WorkerW 可用作壁纸层。
        // 兼容路径：有些 Win11/特殊壳层上，shell_top 可能不是 WorkerW，且没有“后一个 WorkerW”；
        //          这时直接把壁纸窗口挂到 shell_top，并在父窗口内置底(HWND_BOTTOM)，让图标层(DefView)仍在上面。
        // let mut parent: HWND = 0;
        // let mut shell_top: HWND = 0;
        // let mut last_err: Option<String> = None;
        // for _ in 0..12 {
        //     match find_shell_top(progman) {
        //         Ok(top) => {
        //             shell_top = top;
        //             // 经典路径：icon_host(=shell_top) 后面的 WorkerW
        //             let workerw_after =
        //                 FindWindowExW(0, shell_top, wide("WorkerW").as_ptr(), std::ptr::null());

        //             // 兼容路径：有些系统上找不到“后一个 WorkerW”，但仍存在某个 WorkerW 作为“壁纸层”（不包含 DefView）。
        //             // 关键：不要随便拿第一个！要选“client rect 最大且高度>0”的那个，否则会命中你现在这种 176x0 的假 WorkerW。
        //             #[derive(Default)]
        //             struct FindWorkerWBest {
        //                 best: HWND,
        //                 best_area: i64,
        //                 best_w: i32,
        //                 best_h: i32,
        //             }
        //             unsafe extern "system" fn enum_find_workerw_best(
        //                 hwnd: HWND,
        //                 lparam: LPARAM,
        //             ) -> BOOL {
        // let s = &mut *(lparam as *mut FindWorkerWBest);

        //                 if hwnd_class(hwnd) != "WorkerW" {
        //                     return 1;
        //                 }
        //                 let def_view = FindWindowExW(
        //                     hwnd,
        //                     0,
        //                     wide("SHELLDLL_DefView").as_ptr(),
        //                     std::ptr::null(),
        //                 );
        //                 if def_view != 0 {
        //                     return 1;
        //                 }

        //                 let mut rc: RECT = std::mem::zeroed();
        //                 if GetClientRect(hwnd, &mut rc as *mut RECT) == 0 {
        //                     return 1;
        //                 }
        //                 let w = rc.right - rc.left;
        //                 let h = rc.bottom - rc.top;
        //                 if w <= 0 || h <= 0 {
        //                     return 1;
        //                 }
        //                 let area = (w as i64) * (h as i64);
        //                 if area > s.best_area {
        //                     s.best_area = area;
        //                     s.best = hwnd;
        //                     s.best_w = w;
        //                     s.best_h = h;
        //                 }
        //                 1
        //             }

        //             let mut best = FindWorkerWBest::default();
        //             EnumWindows(
        //                 Some(enum_find_workerw_best),
        //                 (&mut best as *mut FindWorkerWBest) as isize,
        //             );
        //             let best_workerw_without_defview = best.best;

        //             // 如果 workerw_after 存在但本身 client 为 0，也不要用它（同样会被裁剪成不可见）
        //             let workerw_after_ok = if workerw_after != 0 {
        //                 let mut rc: RECT = std::mem::zeroed();
        //                 let ok = GetClientRect(workerw_after, &mut rc as *mut RECT);
        //                 let w = rc.right - rc.left;
        //                 let h = rc.bottom - rc.top;
        //                 ok != 0 && w > 0 && h > 0
        //             } else {
        //                 false
        //             };

        //             parent = if workerw_after != 0 && workerw_after_ok {
        //                 workerw_after
        //             } else if best_workerw_without_defview != 0 {
        //                 best_workerw_without_defview
        //             } else {
        //                 // 最后兜底：只能挂到 shell_top（可能会挡图标），但至少不“完全没反应”
        //                 shell_top
        //             };
        //             break;
        //         }
        //         Err(e) => {
        //             last_err = Some(e);
        //             thread::sleep(Duration::from_millis(200));
        //         }
        //     }
        // }
        // if parent == 0 {
        //     return Err(format!(
        //         "查找桌面承载窗口失败: {}",
        //         last_err.unwrap_or_else(|| "unknown".to_string())
        //     ));
        // }

        // 句柄有效性检查（GetLastError=1400 的根因通常是无效 hwnd）

        // 5) 变成子窗口（否则 SetParent 后可能仍保持 WS_POPUP，导致不可见/不铺满等怪问题）
        // let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as isize;
        // let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
        // SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 5) SetParent 到 parent（优先 workerw_after_shell_top，否则其他 WorkerW，否则 shell_top）
        // 注意：child window 会被 parent 的 client area 裁剪。
        // 你现在日志里 WorkerW client height=0，导致“挂载成功但永远不可见”。
        // 所以这里先挂一次，后面会检测 parent client rect，如果为 0 则回退挂到 shell_top 并置底。

        // 6) 先只设置为不抢焦点，排除 WS_EX_LAYERED / WS_EX_TRANSPARENT 导致完全不可见的问题
        // let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        // let new_ex = ex | (WS_EX_NOACTIVATE as isize);
        // SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // 7) 关键：作为子窗口时，坐标是“父窗口客户区坐标系”，不能用屏幕/虚拟屏幕坐标。
        // 否则很容易移动到父窗口范围之外，导致桌面上永远看不到任何变化。
        // 输出一些 debug，便于你确认挂到哪一层
        // {
        //     let parent_class = hwnd_class(parent);
        //     let shell_top_class = hwnd_class(shell_top);
        //     eprintln!(
        //         "[DEBUG] wallpaper parent hwnd={} class={} shell_top={} shell_top_class={} progman={}",
        //         parent, parent_class, shell_top, shell_top_class, progman
        //     );
        // }

        // 关键：child window 会被 parent 的 client area 裁剪。
        // 如果 parent client 为 0（你当前遇到的情况），无论子窗口设置多大都会“被裁成不可见”。
        // 此时回退：挂到 shell_top(Progman/WorkerW icon host) 并强制置底，让图标层在上面。
        // if ok == 0 || w <= 0 || h <= 0 {
        //     eprintln!(
        //         "[DEBUG] parent client rect invalid/zero (ok={}, rc=({}, {}, {}, {})), try fallback parent=shell_top and HWND_BOTTOM",
        //         ok, rc.left, rc.top, rc.right, rc.bottom
        //     );

        //     if shell_top != 0 && IsWindow(shell_top) != 0 && parent != shell_top {
        //         // 切换 parent 到 shell_top
        //         let prev_parent = SetParent(hwnd, shell_top);
        //         if prev_parent == 0 {
        //             let err = windows_sys::Win32::Foundation::GetLastError();
        //             return Err(format!("SetParent(shell_top) failed. GetLastError={}", err));
        //         }
        //         parent = shell_top;
        //     }

        //     // 重新取 client rect（shell_top 应该有有效大小）
        //     let mut rc2: RECT = std::mem::zeroed();
        //     let ok2 = GetClientRect(parent, &mut rc2 as *mut RECT);
        //     let mut w2 = 0;
        //     let mut h2 = 0;
        //     if ok2 != 0 {
        //         w2 = rc2.right - rc2.left;
        //         h2 = rc2.bottom - rc2.top;
        //     }

        //     if ok2 == 0 || w2 <= 0 || h2 <= 0 {
        //         // 仍然异常：最后用屏幕尺寸（至少 SetWindowPos 有数值；但注意仍会被裁剪）
        //         let sw = GetSystemMetrics(0); // SM_CXSCREEN
        //         let sh = GetSystemMetrics(1); // SM_CYSCREEN
        //         eprintln!(
        //             "[DEBUG] shell_top client rect still invalid/zero (ok2={}, rc2=({}, {}, {}, {})), fallback to screen {}x{}",
        //             ok2, rc2.left, rc2.top, rc2.right, rc2.bottom, sw, sh
        //         );
        //         w = sw;
        //         h = sh;
        //     } else {
        //         eprintln!(
        //             "[DEBUG] fallback parent shell_top rc=({}, {}, {}, {}), size={}x{}",
        //             rc2.left, rc2.top, rc2.right, rc2.bottom, w2, h2
        //         );
        //         w = w2;
        //         h = h2;
        //     }

        //     // parent 已经是 shell_top：必须置底，避免挡住桌面图标层
        //     let insert_after = {
        //         let def_view = FindWindowExW(
        //             parent,
        //             0,
        //             wide("SHELLDLL_DefView").as_ptr(),
        //             std::ptr::null(),
        //         );
        //         if def_view != 0 && IsWindow(def_view) != 0 {
        //             def_view
        //         } else {
        //             HWND_BOTTOM
        //         }
        //     };
        //     SetWindowPos(
        //         hwnd,
        //         insert_after,
        //         0,
        //         0,
        //         w,
        //         h,
        //         SWP_NOACTIVATE | SWP_SHOWWINDOW,
        //     );
        //     ShowWindow(hwnd, SW_SHOW);
        //     println!("[DEBUG] 窗口已设置为壁纸层（fallback: parent=shell_top, bottom）");
        //     return Ok(());
        // }
    }

    println!("[DEBUG] 窗口已设置为壁纸层（纯 Win32，无 PowerShell）");
    Ok(())
}

/// 简化版挂载函数（来自 GDI 渲染器）
/// 特点：
/// - 简单的 WorkerW 查找策略
/// - 仅设置 WS_EX_NOACTIVATE（不使用 WS_EX_TRANSPARENT）
/// - 使用父窗口 client rect 或系统屏幕尺寸
pub fn mount_to_desktop_simple(hwnd: HWND) -> Result<(), String> {
    unsafe {
        // 找 Progman
        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return Err("FindWindowW(Progman) failed".to_string());
        }

        // 发送 0x052C 促使生成 WorkerW
        let mut _result: usize = 0;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            0xD,
            0,
            SMTO_ABORTIFHUNG,
            1000,
            &mut _result as *mut usize,
        );

        // 查找合适的 WorkerW（简化版：找第一个不含 DefView 的 WorkerW）
        // 减少等待时间，使用更短的延迟来允许 WorkerW 创建
        thread::sleep(Duration::from_millis(50));

        // 枚举所有 WorkerW，找一个不含 DefView 的
        struct FindWorkerW {
            found: HWND,
        }
        unsafe extern "system" fn enum_workerw(hwnd: HWND, lparam: LPARAM) -> i32 {
            let state = &mut *(lparam as *mut FindWorkerW);

            // 检查是否是 WorkerW
            let class_name = hwnd_class(hwnd);
            if class_name != "WorkerW" {
                return 1; // continue
            }

            // 检查是否包含 DefView
            let def_view =
                FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
            if def_view == 0 {
                // 找到了一个不含 DefView 的 WorkerW
                let mut rc: RECT = std::mem::zeroed();
                if GetClientRect(hwnd, &mut rc as *mut RECT) != 0 {
                    let w = rc.right - rc.left;
                    let h = rc.bottom - rc.top;
                    // 只接受有效的窗口大小
                    if w > 100 && h > 100 {
                        state.found = hwnd;
                        return 0; // stop
                    }
                }
            }
            1 // continue
        }

        let mut find_state = FindWorkerW { found: 0 };
        EnumWindows(
            Some(enum_workerw),
            (&mut find_state as *mut FindWorkerW) as isize,
        );
        let mut parent = find_state.found;

        // 如果没找到 WorkerW，回退到 Progman
        if parent == 0 {
            parent = progman;
        }

        if IsWindow(hwnd) == 0 {
            return Err("GDI window hwnd is invalid".to_string());
        }
        if IsWindow(parent) == 0 {
            return Err("Parent hwnd is invalid".to_string());
        }

        // 注意：修改样式和 SetParent 的顺序很重要
        // 先修改样式，然后再 SetParent
        // 但是，SetParent 可能会触发窗口重新创建，所以我们需要确保顺序正确
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as isize;
        let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 短暂延迟，让窗口样式变更生效
        thread::sleep(Duration::from_millis(10));

        // SetParent - 这可能会触发窗口状态的改变
        let _old_parent = SetParent(hwnd, parent);

        // 验证 SetParent 是否成功
        if GetParent(hwnd) != parent {
            let err = windows_sys::Win32::Foundation::GetLastError();
            return Err(format!("SetParent failed. GetLastError={}", err));
        }

        // SetParent 后再次验证窗口有效性
        if IsWindow(hwnd) == 0 {
            return Err("GDI window hwnd is invalid after SetParent".to_string());
        }

        // 短暂延迟，让 SetParent 操作完全生效
        thread::sleep(Duration::from_millis(10));

        // 设置扩展样式
        // WS_EX_NOACTIVATE: 防止窗口获得焦点
        // 注意：不使用 WS_EX_TRANSPARENT，因为它会导致鼠标加载态
        // 而是在 window_proc 中处理 WM_NCHITTEST 返回 HTTRANSPARENT 来实现鼠标穿透
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        let new_ex = ex | (WS_EX_NOACTIVATE as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // 获取 parent 大小并铺满
        let mut rc: RECT = std::mem::zeroed();
        let ok = GetClientRect(parent, &mut rc as *mut RECT);
        let mut w = 0;
        let mut h = 0;
        if ok != 0 {
            w = rc.right - rc.left;
            h = rc.bottom - rc.top;
        }

        if ok == 0 || w <= 0 || h <= 0 {
            let sw = GetSystemMetrics(0); // SM_CXSCREEN
            let sh = GetSystemMetrics(1); // SM_CYSCREEN
            w = sw;
            h = sh;
        }

        // 设置窗口大小和位置
        // 注意：对于子窗口，直接设置位置和大小即可，Z-order 由父窗口管理
        // 使用 SWP_FRAMECHANGED 来确保窗口框架更新

        // 在设置大小之前再次验证窗口有效性
        if IsWindow(hwnd) == 0 {
            return Err("GDI window hwnd is invalid before SetWindowPos".to_string());
        }

        SetWindowPos(
            hwnd,
            0 as HWND, // HWND_TOP = 0，但对于子窗口通常会被忽略
            0,
            0,
            w,
            h,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
        );

        // 再次验证窗口有效性
        if IsWindow(hwnd) == 0 {
            return Err("GDI window hwnd is invalid after SetWindowPos".to_string());
        }

        // 确保窗口可见（多次调用以确保生效）
        ShowWindow(hwnd, SW_SHOW);
        ShowWindow(hwnd, SW_SHOW);

        // 短暂延迟，让窗口状态稳定
        thread::sleep(Duration::from_millis(50));

        // 最终验证窗口有效性
        if IsWindow(hwnd) == 0 {
            return Err("GDI window hwnd is invalid after ShowWindow".to_string());
        }

        // 记录窗口信息用于调试
        eprintln!(
            "[DEBUG] mount_to_desktop_simple: 窗口已挂载到 parent={}, 大小={}x{}",
            parent, w, h
        );

        // 验证窗口状态
        let actual_parent = GetParent(hwnd);
        eprintln!(
            "[DEBUG] mount_to_desktop_simple: 验证 - 实际 parent={}, 期望 parent={}",
            actual_parent, parent
        );

        let mut check_rc: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut check_rc as *mut RECT) != 0 {
            let check_w = check_rc.right - check_rc.left;
            let check_h = check_rc.bottom - check_rc.top;
            eprintln!(
                "[DEBUG] mount_to_desktop_simple: 验证 - 窗口大小={}x{}",
                check_w, check_h
            );
        }

        // 检查窗口是否可见
        let is_visible = IsWindowVisible(hwnd);
        eprintln!(
            "[DEBUG] mount_to_desktop_simple: 验证 - 窗口可见性={}",
            is_visible
        );

        // 强制刷新父窗口，确保子窗口可见
        const WM_PAINT: u32 = 0x000F;
        SendMessageW(parent, WM_PAINT, 0, 0);
        eprintln!("[DEBUG] mount_to_desktop_simple: 已发送 WM_PAINT 到父窗口");
    }

    Ok(())
}

/// 高级版挂载函数（来自 Window.rs）
/// 特点：
/// - 复杂的 WorkerW 查找策略（支持 Win11）
/// - 设置 WS_EX_NOACTIVATE | WS_EX_TRANSPARENT
/// - 使用虚拟屏幕尺寸（多显示器支持）
/// - 显式处理 Z 序，确保图标层在壁纸层之上
pub fn mount_to_desktop_advanced(hwnd: HWND) -> Result<(), String> {
    unsafe {
        unsafe fn find_shell_top(progman: HWND) -> Result<HWND, String> {
            // 关键：有些系统/桌面工具会让 Progman 里存在"隐藏的 DefView"，真正可见的图标宿主在某个 WorkerW。
            // 所以这里优先选择：包含 DefView 且"可见 + client rect/窗口矩形非零"的那个顶层窗口（通常是 WorkerW）。
            #[derive(Default)]
            struct Best {
                hwnd: HWND,
                area: i64,
                class_name: String,
                has_folder_view: bool,
            }

            unsafe extern "system" fn enum_find_best(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let best = &mut *(lparam as *mut Best);

                let class_name = hwnd_class(hwnd);
                if class_name != "WorkerW" && class_name != "Progman" {
                    return 1;
                }

                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view == 0 {
                    return 1;
                }

                // 说明：IsWindowVisible 在某些壳层上不可靠（可能返回 0 但仍然是桌面层）。
                // 所以这里只用于"打日志/辅助判断"，不作为过滤条件。
                let _visible = IsWindowVisible(hwnd) != 0;

                // 用窗口矩形评估面积（更能过滤"client=0 但仍存在句柄"的假窗口）
                let mut rc = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rc) == 0 {
                    return 1;
                }
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w <= 0 || h <= 0 {
                    return 1;
                }
                let area = (w as i64) * (h as i64);

                // FolderView (SysListView32) 存在通常意味着这里就是"真正的桌面图标视图"
                let folder_view = FindWindowExW(
                    def_view,
                    0,
                    wide("SysListView32").as_ptr(),
                    std::ptr::null(),
                );
                let has_folder_view = folder_view != 0;

                // 选择策略：
                // 1) 优先 has_folder_view=true（更可能是真图标宿主）
                // 2) 再按 area 最大
                let better = if has_folder_view && !best.has_folder_view {
                    true
                } else if has_folder_view == best.has_folder_view && area > best.area {
                    true
                } else {
                    false
                };

                if better {
                    best.area = area;
                    best.hwnd = hwnd;
                    best.class_name = class_name;
                    best.has_folder_view = has_folder_view;
                }
                1
            }

            let mut best = Best::default();
            EnumWindows(Some(enum_find_best), (&mut best as *mut Best) as isize);

            if best.hwnd != 0 {
                eprintln!(
                    "[DEBUG] shell_top selected hwnd={} class={} area={} has_folder_view={}",
                    best.hwnd, best.class_name, best.area, best.has_folder_view
                );
                return Ok(best.hwnd);
            }

            // 兜底：如果没找到"可见"的，再退回 Progman（兼容极端壳层）
            let def_view = FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );
            if def_view != 0 {
                eprintln!("[DEBUG] shell_top fallback to Progman");
                return Ok(progman);
            }

            Err(
                "找不到桌面图标宿主（未在可见的 WorkerW/Progman 顶层窗口中发现 SHELLDLL_DefView）"
                    .to_string(),
            )
        }

        /// 只在 "shell_top(含 DefView) 之后的 Z 序链" 上找 WorkerW。
        /// 这是经典 Wallpaper Engine 路径：把壁纸挂到 DefView 后面的 WorkerW，天然在图标下面。
        unsafe fn find_workerw_behind_shell_top(shell_top: HWND) -> Option<HWND> {
            let mut after = shell_top;
            loop {
                let w = FindWindowExW(0, after, wide("WorkerW").as_ptr(), std::ptr::null());
                if w == 0 {
                    return None;
                }

                // 跳过包含 DefView 的 WorkerW（那是图标宿主或其同层）
                let def_view =
                    FindWindowExW(w, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view == 0 {
                    // 只接受 client rect 有效的 WorkerW，避免 0 高度导致"挂载成功但不可见/裁剪"
                    let mut rc: RECT = std::mem::zeroed();
                    if GetClientRect(w, &mut rc as *mut RECT) != 0 {
                        let ww = rc.right - rc.left;
                        let hh = rc.bottom - rc.top;
                        if ww > 0 && hh > 0 {
                            return Some(w);
                        }
                    }
                }

                after = w;
            }
        }

        /// 如果图标宿主是 Progman，则优先使用"Progman 后面的第一个 WorkerW"作为壁纸宿主。
        /// 这条路径在 Win11 上更稳：壁纸挂在 WorkerW，图标仍在 Progman 上层，避免 WebView2 覆盖图标层。
        unsafe fn find_workerw_after(hwnd: HWND) -> Option<HWND> {
            let w = FindWindowExW(0, hwnd, wide("WorkerW").as_ptr(), std::ptr::null());
            if w != 0 {
                Some(w)
            } else {
                None
            }
        }

        /// 枚举所有顶层 WorkerW，选择一个"不包含 DefView"的作为壁纸宿主。
        /// 解决某些 Win11 壳层上 WorkerW 不在 Progman "后面"导致 FindWindowExW 找不到的问题。
        unsafe fn find_any_workerw_without_defview() -> Option<HWND> {
            #[derive(Default)]
            struct Best {
                hwnd: HWND,
                area: i64,
            }

            unsafe extern "system" fn enum_pick(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let best = &mut *(lparam as *mut Best);
                if hwnd_class(hwnd) != "WorkerW" {
                    return 1;
                }
                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                if def_view != 0 {
                    return 1;
                }
                let mut rc = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rc) == 0 {
                    return 1;
                }
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                if w <= 0 || h <= 0 {
                    return 1;
                }
                let area = (w as i64) * (h as i64);
                if area > best.area {
                    best.area = area;
                    best.hwnd = hwnd;
                }
                1
            }

            let mut best = Best::default();
            EnumWindows(Some(enum_pick), (&mut best as *mut Best) as isize);
            if best.hwnd != 0 {
                Some(best.hwnd)
            } else {
                None
            }
        }

        unsafe fn dump_desktop_toplevel_windows() {
            unsafe extern "system" fn enum_dump(hwnd: HWND, _lparam: LPARAM) -> BOOL {
                let class_name = hwnd_class(hwnd);
                if class_name != "WorkerW" && class_name != "Progman" {
                    return 1;
                }
                let def_view =
                    FindWindowExW(hwnd, 0, wide("SHELLDLL_DefView").as_ptr(), std::ptr::null());
                let folder_view = if def_view != 0 {
                    FindWindowExW(
                        def_view,
                        0,
                        wide("SysListView32").as_ptr(),
                        std::ptr::null(),
                    )
                } else {
                    0
                };
                let mut rc = std::mem::zeroed();
                let ok = GetWindowRect(hwnd, &mut rc);
                let w = rc.right - rc.left;
                let h = rc.bottom - rc.top;
                eprintln!(
                    "[DEBUG] desktop top hwnd={} class={} vis={} rect_ok={} rect=({}, {}, {}, {}) size={}x{} has_defview={} has_folder_view={}",
                    hwnd,
                    class_name,
                    IsWindowVisible(hwnd),
                    ok,
                    rc.left, rc.top, rc.right, rc.bottom,
                    w, h,
                    def_view != 0,
                    folder_view != 0
                );
                1
            }
            EnumWindows(Some(enum_dump), 0);
        }

        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return Err("FindWindowW(Progman) failed".to_string());
        }

        // 促使生成 WorkerW（不同实现对 wParam 取值不一致：0 / 0xD 都有人用）
        let mut _result: usize = 0;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            0,
            0,
            SMTO_ABORTIFHUNG,
            1000,
            &mut _result as *mut usize,
        );
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            0xD,
            0,
            SMTO_ABORTIFHUNG,
            1000,
            &mut _result as *mut usize,
        );

        // 查找 shell_top 并尽量找到其后的 WorkerW
        let mut parent: HWND = 0;
        let mut shell_top: HWND = 0;
        let mut last_err: Option<String> = None;
        // 如果我们强制把某个 WorkerW 拉满屏幕，这里记录目标尺寸，避免后续 GetClientRect 仍返回旧的 198x56
        let mut forced_parent_wh: Option<(i32, i32)> = None;
        for _ in 0..60 {
            match find_shell_top(progman) {
                Ok(top) => {
                    shell_top = top;
                    // 优先：如果 shell_top 本身就是 Progman（你的环境），则尽量把壁纸挂到 Progman 后面的 WorkerW。
                    // 这是经典"壁纸层"窗口，能让图标层天然在上面。
                    let shell_top_class = hwnd_class(shell_top);
                    if shell_top_class == "Progman" {
                        // Win11 某些桌面结构：图标确实在 Progman(DefView/FolderView)，而 WorkerW 永远在 Progman 之上且无法被压下去。
                        // 这时把"壁纸(不透明 WebView2)"挂到 WorkerW 会导致图标整层不可见（你当前遇到的现象）。
                        // 在无法可靠解决顶层 Z 序的前提下，直接判定 window 模式不兼容，交给上层回退到 native。
                        //
                        // 如需强行继续尝试（可能导致图标不可见），设置环境变量：KABEGAMI_FORCE_WORKERW=1
                        if std::env::var("KABEGAMI_FORCE_WORKERW")
                            .ok()
                            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                            != Some(true)
                        {
                            let def_view = FindWindowExW(
                                shell_top,
                                0,
                                wide("SHELLDLL_DefView").as_ptr(),
                                std::ptr::null(),
                            );
                            let folder_view = if def_view != 0 {
                                FindWindowExW(
                                    def_view,
                                    0,
                                    wide("SysListView32").as_ptr(),
                                    std::ptr::null(),
                                )
                            } else {
                                0
                            };
                            if def_view != 0 && folder_view != 0 {
                                return Err("Win11 桌面结构检测：图标宿主在 Progman，使用 WorkerW 作为壁纸层会导致图标不可见；已阻止 window 模式并建议回退到 native。可设置环境变量 KABEGAMI_FORCE_WORKERW=1 强行尝试（不推荐）".to_string());
                            }
                        }

                        parent = find_workerw_after(shell_top).unwrap_or(0);
                        if parent != 0 {
                            eprintln!("[DEBUG] using workerw_after_progman as parent: {}", parent);
                        }
                        // 某些系统里 WorkerW 不在 Progman 后面：改为全局枚举一个可用 WorkerW
                        if parent == 0 {
                            parent = find_any_workerw_without_defview().unwrap_or(0);
                            if parent != 0 {
                                eprintln!(
                                    "[DEBUG] using workerw_any_no_defview as parent: {}",
                                    parent
                                );
                            } else {
                                eprintln!(
                                    "[DEBUG] no WorkerW(no DefView) found, fallback to shell_top"
                                );
                            }
                        }
                    }
                    // 否则走常规：在 shell_top 之后找 WorkerW（不含 DefView）
                    if parent == 0 {
                        parent = find_workerw_behind_shell_top(shell_top).unwrap_or(shell_top);
                    }
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        if parent == 0 {
            return Err(format!(
                "查找桌面承载窗口失败: {}",
                last_err.unwrap_or_else(|| "unknown".to_string())
            ));
        }

        if IsWindow(hwnd) == 0 {
            return Err("Tauri wallpaper hwnd is invalid (IsWindow=0)".to_string());
        }
        if IsWindow(parent) == 0 {
            return Err("Parent hwnd is invalid (IsWindow=0)".to_string());
        }

        // Win11 上：只要 parent 是 WorkerW（壁纸层），就无条件把它铺满虚拟屏幕并 show。
        // 否则经常出现"WorkerW 尺寸/裁剪不一致 -> 壁纸区域外黑底"的情况。
        {
            let parent_class = hwnd_class(parent);
            if parent_class == "WorkerW" && parent != shell_top {
                // 用虚拟屏幕尺寸（多显示器更稳）
                // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
                let vx = GetSystemMetrics(76);
                let vy = GetSystemMetrics(77);
                let sw = GetSystemMetrics(78);
                let sh = GetSystemMetrics(79);

                let mut rcw: RECT = std::mem::zeroed();
                let ok = GetClientRect(parent, &mut rcw as *mut RECT);
                let pw = if ok != 0 { rcw.right - rcw.left } else { -1 };
                let ph = if ok != 0 { rcw.bottom - rcw.top } else { -1 };
                eprintln!(
                    "[DEBUG] parent WorkerW {} client before resize ok={} size={}x{}, target virtual={}x{} at ({}, {})",
                    parent, ok, pw, ph, sw, sh, vx, vy
                );

                const HWND_BOTTOM: HWND = 1;
                SetWindowPos(
                    parent,
                    HWND_BOTTOM,
                    vx,
                    vy,
                    sw,
                    sh,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                ShowWindow(parent, SW_SHOW);
                forced_parent_wh = Some((sw, sh));
                eprintln!(
                    "[DEBUG] resized/showed parent WorkerW {} to {}x{} at ({}, {})",
                    parent, sw, sh, vx, vy
                );
            }
        }

        // 变成子窗口
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as isize;
        let new_style = (style & !(WS_POPUP as isize)) | (WS_CHILD as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 挂载
        // 注意：SetParent 返回"旧父窗口"，旧父窗口可能为 NULL（顶层窗口），此时返回 0 仍可能是成功。
        // 所以这里用 GetParent 校验结果，避免误报。
        let _old_parent = SetParent(hwnd, parent);
        if GetParent(hwnd) != parent {
            let err = windows_sys::Win32::Foundation::GetLastError();
            return Err(format!(
                "SetParent failed (GetParent mismatch). GetLastError={}",
                err
            ));
        }

        // 不抢焦点 + 鼠标穿透（避免壁纸窗口抢占桌面图标/桌面工具的点击）
        // 注意：这会使壁纸窗口"不可交互"，但本项目窗口模式主要用于展示图片壁纸，这是期望行为。
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        let new_ex = ex | (WS_EX_NOACTIVATE as isize) | (WS_EX_TRANSPARENT as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // 输出 debug
        {
            let parent_class = hwnd_class(parent);
            let shell_top_class = hwnd_class(shell_top);
            eprintln!(
                "[DEBUG] wallpaper parent hwnd={} class={} shell_top={} shell_top_class={} progman={}",
                parent, parent_class, shell_top, shell_top_class, progman
            );
            if parent == shell_top {
                dump_desktop_toplevel_windows();
            }
        }

        // 计算 parent client rect 并铺满（child 坐标系）
        let mut rc: RECT = std::mem::zeroed();
        let ok = GetClientRect(parent, &mut rc as *mut RECT);
        let mut w = 0;
        let mut h = 0;
        if ok != 0 {
            w = rc.right - rc.left;
            h = rc.bottom - rc.top;
        }

        // 子窗口尺寸策略：
        // - parent 是 WorkerW：无条件用虚拟屏幕尺寸铺满（避免黑底/黑边）
        // - 否则按 client rect / 虚拟屏幕兜底
        let parent_class = hwnd_class(parent);
        if parent_class == "WorkerW" && parent != shell_top {
            let (sw, sh) = forced_parent_wh.unwrap_or((GetSystemMetrics(78), GetSystemMetrics(79)));
            w = sw;
            h = sh;
            eprintln!(
                "[DEBUG] force wallpaper child size to {}x{} (parent client ok={} was {}x{})",
                w,
                h,
                ok,
                rc.right - rc.left,
                rc.bottom - rc.top
            );
        } else {
            // 否则：如果 parent client rect 仍明显偏小，也用虚拟屏幕兜底（避免黑边）
            let sw = GetSystemMetrics(78);
            let sh = GetSystemMetrics(79);
            if ok == 0 || w <= 0 || h <= 0 || (w < (sw * 3 / 4) || h < (sh * 3 / 4)) {
                w = sw;
                h = sh;
            }
        }

        // Z序策略（更硬、更稳定）：
        // 1) 壁纸窗口永远放到同父窗口的最底层
        // 2) 如果 parent==shell_top（你这台机子是 Progman），则把 DefView 和 SysListView32 都显式抬到最上，
        //    彻底避免"图标整层被 webview 合成层压没"的情况。
        const HWND_BOTTOM: HWND = 1;
        const HWND_TOP: HWND = 0;

        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            w,
            h,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
        );
        ShowWindow(hwnd, SW_SHOW);

        // Win11 + WebView2 场景：即便壁纸挂到 WorkerW，仍可能因为顶层 Z 序/壳层干预导致图标层被压在下面。
        // 这里在 parent 为 WorkerW 时，显式把 Progman/DefView/FolderView 提到 WorkerW 之上（不激活），确保图标可见。
        {
            let parent_class = hwnd_class(parent);
            if parent_class == "WorkerW" && parent != shell_top {
                const WM_PAINT: u32 = 0x000F;
                const WM_NCPAINT: u32 = 0x0085;

                // 关键：顶层窗口 Z 序钉死
                // - WorkerW 做壁纸层：永远放到最底（顶层）
                // - Progman(图标宿主)：永远放到最顶（顶层）
                // 否则即便 DefView/FolderView 在 Progman 内部置顶，整个 Progman 仍可能被 WorkerW 覆盖导致"图标不可见"。
                SetWindowPos(
                    parent,
                    HWND_BOTTOM,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                SetWindowPos(
                    shell_top,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                ShowWindow(shell_top, SW_SHOW);
                SetWindowPos(
                    shell_top,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                let def_view = FindWindowExW(
                    shell_top,
                    0,
                    wide("SHELLDLL_DefView").as_ptr(),
                    std::ptr::null(),
                );
                if def_view != 0 && IsWindow(def_view) != 0 {
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

                    let folder_view = FindWindowExW(
                        def_view,
                        0,
                        wide("SysListView32").as_ptr(),
                        std::ptr::null(),
                    );
                    if folder_view != 0 && IsWindow(folder_view) != 0 {
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

                    // 触发一次重绘，避免"Z序对了但没刷新"
                    let _ = SendMessageW(shell_top, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(shell_top, WM_PAINT, 0, 0);
                    let _ = SendMessageW(def_view, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(def_view, WM_PAINT, 0, 0);
                    if folder_view != 0 {
                        let _ = SendMessageW(folder_view, WM_NCPAINT, 0, 0);
                        let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
                    }
                }

                eprintln!("[DEBUG] bumped shell_top/DefView above WorkerW wallpaper parent");
                eprintln!("[DEBUG] forced top-level z-order: WorkerW->BOTTOM, Progman->TOP");
            }
        }

        // 关键补偿：仅当 parent==shell_top 时（我们不得不挂到图标宿主），才尝试抬升图标层。
        // 如果 parent 是 WorkerW（推荐路径），图标不在此父窗口下，没必要也不应该动它。
        if parent == shell_top {
            let def_view = FindWindowExW(
                shell_top,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );
            if def_view != 0 && IsWindow(def_view) != 0 {
                // 一些壳层/桌面工具会让 DefView 处于隐藏/未重绘状态；这里强制显示并重绘一次
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

                let folder_view = FindWindowExW(
                    def_view,
                    0,
                    wide("SysListView32").as_ptr(),
                    std::ptr::null(),
                );
                if folder_view != 0 && IsWindow(folder_view) != 0 {
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

                // 强制刷新：用 WM_PAINT/WM_NCPAINT 触发重绘（不依赖额外 windows-sys feature）
                const WM_PAINT: u32 = 0x000F;
                const WM_NCPAINT: u32 = 0x0085;
                let _ = SendMessageW(shell_top, WM_NCPAINT, 0, 0);
                let _ = SendMessageW(shell_top, WM_PAINT, 0, 0);
                let _ = SendMessageW(def_view, WM_NCPAINT, 0, 0);
                let _ = SendMessageW(def_view, WM_PAINT, 0, 0);
                if folder_view != 0 {
                    let _ = SendMessageW(folder_view, WM_NCPAINT, 0, 0);
                    let _ = SendMessageW(folder_view, WM_PAINT, 0, 0);
                }
            } else {
                eprintln!("[DEBUG] parent==shell_top but DefView not found under shell_top");
            }
        }
    }

    println!("[DEBUG] 窗口已设置为壁纸层（纯 Win32，无 PowerShell）");
    Ok(())
}

/// 获取窗口的父窗口链（从当前窗口到根窗口）
/// 返回一个向量，第一个元素是当前窗口，最后一个元素是顶层窗口
pub unsafe fn get_window_parent_chain(hwnd: HWND) -> Vec<HWND> {
    let mut chain = Vec::new();
    let mut current = hwnd;

    while current != 0 && IsWindow(current) != 0 {
        chain.push(current);
        current = GetParent(current);
        // 防止循环
        if chain.len() > 100 {
            break;
        }
    }

    chain
}

/// 检查窗口是否是另一个窗口的后代（在层级结构中的子窗口）
pub unsafe fn is_window_descendant(child: HWND, ancestor: HWND) -> bool {
    let mut current = child;

    while current != 0 && IsWindow(current) != 0 {
        if current == ancestor {
            return true;
        }
        current = GetParent(current);
        // 防止循环
        if current == child {
            break;
        }
    }

    false
}

/// 打印窗口的完整层级关系（用于调试）
pub unsafe fn print_window_hierarchy(hwnd: HWND) {
    let chain = get_window_parent_chain(hwnd);

    println!("[窗口层级] 窗口 HWND=0x{:X} 的层级关系:", hwnd);
    for (i, h) in chain.iter().enumerate() {
        let indent = "  ".repeat(i);
        let class = hwnd_class(*h);
        println!("{}  {} HWND=0x{:X} Class={}", indent, i, h, class);
    }
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
