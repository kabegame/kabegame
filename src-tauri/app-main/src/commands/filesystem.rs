//! 文件系统操作命令
//!
//! 提供三个功能：
//! - open_explorer: 打开文件夹
//! - open_file_path: 用默认程序打开文件
//! - open_file_folder: 在文件夹中显示文件（reveal in folder）

use kabegame_core::shell_open;

/// 在资源管理器中打开一个文件夹（Windows Explorer；macOS Finder；Linux 文件管理器）
#[tauri::command]
pub fn open_explorer(path: String) -> Result<(), String> {
    shell_open::open_explorer(&path)
}

/// 用系统默认程序打开一个文件
#[tauri::command]
pub fn open_file_path(file_path: String) -> Result<(), String> {
    shell_open::open_path(&file_path)
}

/// 在文件夹中定位并选中一个文件（Windows Explorer 选中；macOS Finder reveal；Linux 打开父目录）
#[tauri::command]
pub fn open_file_folder(file_path: String) -> Result<(), String> {
    shell_open::reveal_in_folder(&file_path)
}
