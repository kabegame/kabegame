//! 打开文件/文件夹的跨平台工具。
//!
//! 目标：
//! - Windows 下不要通过 `cmd.exe /C start`（会弹黑框）。
//! - 尽量使用系统级 API（Windows: ShellExecuteW）来交给默认程序处理。

#[cfg(target_os = "windows")]
fn normalize_windows_path_for_shell(path: &str) -> String {
    // 有些路径可能来自 canonicalize()，会带 \\?\ 前缀；ShellExecuteW 对这种前缀的兼容性不稳定，
    // 这里统一剥掉，保持和资源管理器/默认程序一致的表现。
    path.trim_start_matches(r"\\?\").to_string()
}

/// 用系统默认程序打开一个路径（文件/目录）。
pub fn open_path(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let path = normalize_windows_path_for_shell(path);

        let op: Vec<u16> = OsStr::new("open").encode_wide().chain(Some(0)).collect();
        let file: Vec<u16> = OsStr::new(&path).encode_wide().chain(Some(0)).collect();

        // https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shellexecutew
        // 返回值 <= 32 表示错误码。
        let rc = unsafe {
            ShellExecuteW(
                0,
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc as isize <= 32 {
            return Err(format!(
                "Failed to open path (ShellExecuteW rc={}): {}",
                rc, path
            ));
        }

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open path: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open path: {}", e))?;
        return Ok(());
    }
}

/// 在资源管理器中打开一个目录（Windows Explorer；macOS Finder；Linux 文件管理器）。
/// 使用 "explore" 操作确保在新窗口中打开目录。
pub fn open_explorer(path: &str) -> Result<(), String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("路径不能为空".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let path = normalize_windows_path_for_shell(p);

        // 使用 "explore" 操作在新窗口中打开目录
        let operation: Vec<u16> = OsStr::new("explore")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let path_wide: Vec<u16> = OsStr::new(&path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let result = unsafe {
            ShellExecuteW(
                0, // HWND = 0 表示无父窗口
                operation.as_ptr(),
                path_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL as i32,
            )
        };

        // ShellExecuteW 返回值 > 32 表示成功
        if result as usize > 32 {
            Ok(())
        } else {
            Err(format!("打开资源管理器失败，错误码: {}", result as usize))
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
        Ok(())
    }
}

/// 以管理员权限（UAC）启动一个程序（Windows 专用）。
///
/// 说明：
/// - 会触发 UAC 弹窗（如果当前进程未提权且系统启用了 UAC）。
/// - 该 API 仅负责“发起提权启动”，不保证子进程成功执行到某一步。
pub fn runas(exe_path: &str, params: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let exe_path = normalize_windows_path_for_shell(exe_path);
        let params_str = params;

        let op: Vec<u16> = OsStr::new("runas").encode_wide().chain(Some(0)).collect();
        let file: Vec<u16> = OsStr::new(&exe_path).encode_wide().chain(Some(0)).collect();
        let params: Vec<u16> = OsStr::new(params_str)
            .encode_wide()
            .chain(Some(0))
            .collect();

        let rc = unsafe {
            ShellExecuteW(
                0,
                op.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc as isize <= 32 {
            return Err(format!(
                "Failed to runas (ShellExecuteW rc={}): {} {}",
                rc, exe_path, params_str
            ));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (exe_path, params);
        Err("runas 仅支持 Windows".to_string())
    }
}

/// 在文件夹中定位一个文件（Windows Explorer 选中；macOS Finder reveal；Linux 打开父目录）。
pub fn reveal_in_folder(file_path: &str) -> Result<(), String> {
    use std::path::Path;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        // CREATE_NO_WINDOW: 0x08000000
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let file_path = normalize_windows_path_for_shell(file_path);
        let path = Path::new(&file_path);
        if path.parent().is_none() {
            return Err("Invalid file path".to_string());
        }

        Command::new("explorer.exe")
            .args(["/select,", &file_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to reveal in folder: {}", e))?;

        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let path = Path::new(file_path);
        if path.parent().is_none() {
            return Err("Invalid file path".to_string());
        }
        Command::new("open")
            .arg("-R")
            .arg(file_path)
            .spawn()
            .map_err(|e| format!("Failed to reveal in folder: {}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let path = Path::new(file_path);
        let Some(parent) = path.parent() else {
            return Err("Invalid file path".to_string());
        };
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
        return Ok(());
    }
}
