//! 文件系统操作命令
//!
//! 提供三个功能：
//! - open_explorer: 打开文件夹
//! - open_file_path: 用默认程序打开文件
//! - open_file_folder: 在文件夹中显示文件（reveal in folder）
//! - open_album_virtual_drive_folder: 打开虚拟盘中画册目录（路径与 VD i18n 一致）

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

/// 在资源管理器中打开虚拟盘内指定画册文件夹（含子画册路径，与 VD 目录结构一致）。
#[tauri::command]
pub async fn open_album_virtual_drive_folder(album_id: String) -> Result<(), String> {
    #[cfg(any(kabegame_mode = "light", target_os = "android"))]
    {
        let _ = album_id;
        return Err("当前模式不支持虚拟盘".to_string());
    }
    #[cfg(kabegame_mode = "standard")]
    {
        use kabegame_core::settings::Settings;
        use kabegame_core::virtual_driver::album_folder_abs_path_for_explorer;

        let id = album_id.trim();
        if id.is_empty() {
            return Err("画册 ID 不能为空".to_string());
        }
        let mount = Settings::global().get_album_drive_mount_point();
        let path = album_folder_abs_path_for_explorer(&mount, id)?;
        shell_open::open_explorer(&path)
    }
}
