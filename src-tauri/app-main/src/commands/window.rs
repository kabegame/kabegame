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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        window.hide().map_err(|e| format!("隐藏窗口失败: {}", e))?;
    }

    // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn(async move {
            fix_wallpaper_window_zorder(app).await;
        });
    }

    Ok(())
}

/// 为主窗口启用毛玻璃效果。
/// Windows/macOS 均在窗口创建时通过 tauri.conf 的 windowEffects 设置一次（Tauri 接口）。
/// 此处仅在需要关闭效果时（sidebar_width == 0）调用 set_effects(None)。
#[tauri::command]
pub fn set_main_sidebar_blur(app: tauri::AppHandle, sidebar_width: u32) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        use tauri::Manager;

        if sidebar_width == 0 {
            let Some(window) = app.get_webview_window("main") else {
                return Err("找不到主窗口".to_string());
            };
            window
                .set_effects(None)
                .map_err(|e| format!("set_effects(None) failed: {}", e))?;
            #[cfg(debug_assertions)]
            eprintln!("[Vibrancy] window effects disabled");
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
