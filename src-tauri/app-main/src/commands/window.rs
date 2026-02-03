// 窗口管理相关命令

#[cfg(target_os = "windows")]
pub(super) async fn fix_wallpaper_window_zorder(app: tauri::AppHandle) {
    use tauri::Manager;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
    };

    // 检查是否是窗口模式（从 Settings 读取 settings.wallpaperMode）
    let is_window_mode = kabegame_core::settings::Settings::global()
        .get_wallpaper_mode()
        .await
        .ok()
        .map(|s| s == "window")
        .unwrap_or(false);

    if !is_window_mode {
        return;
    }

    // 获取壁纸窗口
    let Some(wallpaper_window) = app.get_webview_window("wallpaper") else {
        return;
    };

    let Ok(tauri_hwnd) = wallpaper_window.hwnd() else {
        return;
    };
    let tauri_hwnd: HWND = tauri_hwnd.0 as isize;

    unsafe {
        fn wide(s: &str) -> Vec<u16> {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;
            OsStr::new(s).encode_wide().chain(Some(0)).collect()
        }

        const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x00200000;
        const HWND_TOP: HWND = 0;

        let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        if progman == 0 {
            return;
        }

        let ex_style = GetWindowLongPtrW(progman, GWL_EXSTYLE) as u32;
        let is_raised_desktop = (ex_style & WS_EX_NOREDIRECTIONBITMAP) != 0;

        if is_raised_desktop {
            eprintln!("[DEBUG] fix_wallpaper_window_zorder: 修复壁纸窗口 Z-order (Windows 11 raised desktop)");

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

                eprintln!("[DEBUG] fix_wallpaper_window_zorder: ✓ 壁纸窗口 Z-order 已修复");
            }
        }
    }
}

/// 隐藏主窗口（用于窗口关闭事件处理）
#[tauri::command]
pub fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    // 明确获取主窗口，而不是使用 values().next()（可能获取到壁纸窗口）
    let Some(window) = app.get_webview_window("main") else {
        return Err("找不到主窗口".to_string());
    };

    // 不保存 window_state：用户要求每次居中弹出

    window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;

    // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn(async move {
            fix_wallpaper_window_zorder(app).await;
        });
    }

    Ok(())
}

/// Windows：为主窗口左侧导航栏启用 DWM 模糊（BlurBehind + HRGN）。
/// - sidebar_width: 侧栏宽度（px）
/// TODO: MacOS用不同的实现
#[tauri::command]
#[cfg(target_os = "windows")]
pub fn set_main_sidebar_blur(app: tauri::AppHandle, sidebar_width: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use std::mem::transmute;
        use tauri::Manager;
        use windows_sys::Win32::Foundation::BOOL;
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::Graphics::Dwm::{
            DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND,
        };
        use windows_sys::Win32::Graphics::Gdi::{CreateRectRgn, DeleteObject};
        use windows_sys::Win32::System::LibraryLoader::{
            GetModuleHandleW, GetProcAddress, LoadLibraryW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

        let Some(window) = app.get_webview_window("main") else {
            return Err("找不到主窗口".to_string());
        };

        let tauri_hwnd = window
            .hwnd()
            .map_err(|e| format!("获取主窗口 HWND 失败: {}", e))?;
        let hwnd: HWND = tauri_hwnd.0 as isize;

        #[cfg(debug_assertions)]
        {
            eprintln!(
                "[DWM] set_main_sidebar_dwm_blur: hwnd={:?}, sidebar_width={}",
                hwnd, sidebar_width
            );
        }

        if hwnd == 0 {
            return Err("hwnd is null".into());
        }

        // ---- 优先：SetWindowCompositionAttribute + ACCENT_ENABLE_ACRYLICBLURBEHIND（Win11 更常见/更稳定）----
        // 我们给"整个窗口"开启 acrylic，但由于主内容区域是不透明背景，视觉上只有侧栏（半透明）会显现毛玻璃。
        #[repr(C)]
        struct ACCENT_POLICY {
            accent_state: i32,
            accent_flags: i32,
            gradient_color: u32,
            animation_id: i32,
        }

        #[repr(C)]
        struct WINDOWCOMPOSITIONATTRIBDATA {
            attrib: i32,
            pv_data: *mut c_void,
            cb_data: u32,
        }

        // Undocumented: WCA_ACCENT_POLICY = 19
        const WCA_ACCENT_POLICY: i32 = 19;
        // Undocumented: ACCENT_ENABLE_ACRYLICBLURBEHIND = 4
        const ACCENT_ENABLE_ACRYLICBLURBEHIND: i32 = 4;

        unsafe {
            // 动态加载：避免 MSVC 链接阶段找不到 __imp_SetWindowCompositionAttribute 导致 LNK2019
            unsafe fn wide(s: &str) -> Vec<u16> {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                OsStr::new(s).encode_wide().chain(Some(0)).collect()
            }

            type SetWcaFn =
                unsafe extern "system" fn(HWND, *mut WINDOWCOMPOSITIONATTRIBDATA) -> BOOL;

            let user32 = {
                let m = GetModuleHandleW(wide("user32.dll").as_ptr());
                if m != 0 {
                    m
                } else {
                    LoadLibraryW(wide("user32.dll").as_ptr())
                }
            };

            let set_wca: Option<SetWcaFn> = if user32 != 0 {
                // windows-sys 的 GetProcAddress 返回 Option<FARPROC>
                GetProcAddress(user32, b"SetWindowCompositionAttribute\0".as_ptr())
                    .map(|f| transmute(f))
            } else {
                None
            };

            // GradientColor 常见实现为 0xAABBGGRR；白色不受通道顺序影响。
            let accent = ACCENT_POLICY {
                accent_state: ACCENT_ENABLE_ACRYLICBLURBEHIND,
                accent_flags: 2,
                gradient_color: 0x99FFFFFF, // 半透明白
                animation_id: 0,
            };

            let mut data = WINDOWCOMPOSITIONATTRIBDATA {
                attrib: WCA_ACCENT_POLICY,
                pv_data: (&accent as *const ACCENT_POLICY) as *mut c_void,
                cb_data: std::mem::size_of::<ACCENT_POLICY>() as u32,
            };

            if let Some(set_wca) = set_wca {
                let ok = set_wca(hwnd, &mut data);
                if ok != 0 {
                    #[cfg(debug_assertions)]
                    eprintln!("[DWM] acrylic enabled via SetWindowCompositionAttribute");
                    return Ok(());
                }
            } else {
                #[cfg(debug_assertions)]
                eprintln!("[DWM] SetWindowCompositionAttribute not found (GetProcAddress)");
            }
        }

        #[cfg(debug_assertions)]
        eprintln!("[DWM] acrylic failed, fallback to DwmEnableBlurBehindWindow");

        if sidebar_width == 0 {
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
            }
            return Ok(());
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

            let width = (sidebar_width as i32).min(rect.right - rect.left).max(1);
            #[cfg(debug_assertions)]
            eprintln!(
                "[DWM] client_rect={}x{}, blur_width={}",
                rect.right - rect.left,
                rect.bottom - rect.top,
                width
            );
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
            let _ = DeleteObject(rgn);
            if hr != 0 {
                return Err(format!(
                    "DwmEnableBlurBehindWindow failed: HRESULT=0x{hr:08X}"
                ));
            }
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = sidebar_width;
        Ok(())
    }
}

/// 修复壁纸窗口 Z-order（供前端在最小化等事件时调用）
#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn fix_wallpaper_zorder(app: tauri::AppHandle) {
    fix_wallpaper_window_zorder(app).await;
}

/// 壁纸窗口前端 ready 后调用，用于触发一次"推送当前壁纸到壁纸窗口"。
/// 解决壁纸窗口尚未注册事件监听时，后端先 emit 导致事件丢失的问题。
#[tauri::command]
#[cfg(target_os = "windows")]
pub fn wallpaper_window_ready(_app: tauri::AppHandle) -> Result<(), String> {
    // 标记窗口已完全初始化
    println!("壁纸窗口已就绪");
    crate::wallpaper::WallpaperWindow::mark_ready();
    Ok(())
}

/// 切换主窗口全屏状态
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;

    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())?;

    Ok(())
}

// // Windows：将文件列表写入剪贴板为 CF_HDROP，便于原生应用粘贴/拖拽识别
// #[tauri::command]
// #[cfg(target_os = "windows")]
// pub fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
//     use windows_sys::Win32::System::{
//         DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
//         Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
//     };
//     use windows_sys::Win32::UI::Shell::DROPFILES;
//     use windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics;

//     const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

//     if paths.is_empty() {
//         return Err("paths is empty".into());
//     }

//     // 构造双零结尾的 UTF-16 路径列表（以 '\0' 分隔，末尾再加 '\0'）
//     let mut path_list = String::new();
//     for (idx, p) in paths.iter().enumerate() {
//         if idx > 0 {
//             path_list.push('\0');
//         }
//         // 去掉 Windows 长路径前缀 \\?\
//         let cleaned = p.trim_start_matches(r"\\?\");
//         path_list.push_str(cleaned);
//     }
//     path_list.push('\0'); // 额外终止符

//     let wide: Vec<u16> = path_list.encode_utf16().collect();
//     let bytes_len = wide.len() * 2;
//     let dropfiles_size = std::mem::size_of::<DROPFILES>();
//     let total_size = dropfiles_size + bytes_len;

//     unsafe {
//         // 分配全局内存
//         let h_mem = GlobalAlloc(GMEM_MOVEABLE, total_size);
//         if h_mem == std::ptr::null_mut() {
//             return Err("GlobalAlloc failed".into());
//         }

//         let p_mem = GlobalLock(h_mem);
//         if p_mem.is_null() {
//             return Err("GlobalLock failed".into());
//         }

//         // 写入 DROPFILES 结构
//         let dropfiles = DROPFILES {
//             pFiles: dropfiles_size as u32,
//             pt: std::mem::zeroed(),
//             fNC: 0,
//             fWide: 1, // 使用 Unicode
//         };
//         std::ptr::copy_nonoverlapping(
//             &dropfiles as *const _ as *const u8,
//             p_mem as *mut u8,
//             dropfiles_size,
//         );

//         // 写入路径列表
//         let paths_ptr = p_mem.add(dropfiles_size);
//         std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, paths_ptr as *mut u8, bytes_len);

//         GlobalUnlock(h_mem);

//         // 打开剪贴板并设置数据
//         if OpenClipboard(0) == 0 {
//             return Err("OpenClipboard failed".into());
//         }

//         if EmptyClipboard() == 0 {
//             CloseClipboard();
//             return Err("EmptyClipboard failed".into());
//         }

//         if SetClipboardData(CF_HDROP_FORMAT, h_mem as isize) == 0 {
//             CloseClipboard();
//             return Err("SetClipboardData failed".into());
//         }

//         CloseClipboard();
//     }

//     Ok(())
// }

// #[cfg(not(target_os = "windows"))]
// #[tauri::command]
// pub fn copy_files_to_clipboard(_paths: Vec<String>) -> Result<(), String> {
//     Err("copy_files_to_clipboard is only supported on Windows".into())
// }
