// 文件系统操作命令

#[tauri::command]
pub fn open_explorer(path: String) -> Result<(), String> {
    open_path_native(&path)
}

fn open_path_native(path: &str) -> Result<(), String> {
    use std::process::Command;
    let p = path.trim();
    if p.is_empty() {
        return Err("Empty path".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = p;
        Err("Unsupported platform".to_string())
    }
}

pub fn reveal_in_folder_native(file_path: &str) -> Result<(), String> {
    use std::path::Path;
    let p = file_path.trim();
    if p.is_empty() {
        return Err("Empty path".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", p])
            .spawn()
            .map_err(|e| format!("Failed to reveal in folder: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", p])
            .spawn()
            .map_err(|e| format!("Failed to reveal in folder: {e}"))?;
        return Ok(());
    }

    // Linux/others: fallback to opening the parent directory
    let dir = Path::new(p).parent().map(|x| x.to_path_buf());
    let Some(dir) = dir else {
        return open_path_native(p);
    };
    open_path_native(&dir.to_string_lossy())
}

#[tauri::command]
pub fn open_file_path(file_path: String) -> Result<(), String> {
    reveal_in_folder_native(&file_path)
}

#[tauri::command]
pub fn open_file_folder(file_path: String) -> Result<(), String> {
    reveal_in_folder_native(&file_path)
}
