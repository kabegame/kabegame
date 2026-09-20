//! 文件系统操作命令
//!
//! 提供三个功能：
//! - open_path: 用系统默认程序打开一个路径，文件与文件夹共用这一个命令
//! - open_file_folder: 在文件夹中显示文件（reveal in folder）
//! - open_album_virtual_drive_folder: 打开虚拟盘中画册目录（路径与 VD i18n 一致）
//!
//! 实现一律走 `tauri-plugin-opener`，不要再在本仓手写 `ShellExecuteW` / `xdg-open`：
//! - 桌面：插件内部用 ShellExecuteExW（Windows，目录自带 "explore" verb 且 CREATE_NO_WINDOW，
//!   不弹黑框）/ NSWorkspace（macOS）/ xdg-open 与 FileManager1 D-Bus（Linux）。
//! - Android：经插件转成 Intent；`reveal_item_in_dir` 在 Android 不受支持，会返回错误。

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// 归一化外部传入的路径。
///
/// 有些路径来自 `canonicalize()`，在 Windows 上会带 `\\?\` 前缀，ShellExecute 系 API 对它的
/// 兼容性不稳定，这里统一剥掉，保持和资源管理器/默认程序一致的表现。
fn normalize_path(path: &str) -> &str {
    let path = path.trim();
    #[cfg(target_os = "windows")]
    {
        return path.trim_start_matches(r"\\?\");
    }
    #[cfg(not(target_os = "windows"))]
    path
}

/// 用系统默认程序打开一个路径（文件或目录）。
///
/// 文件夹与文件不做区分：目录交给系统默认的文件管理器（Windows 下 opener 内部对目录自带
/// "explore" verb），文件交给注册的默认程序。
fn open_with_default<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    let path = normalize_path(path);
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }

    app.opener()
        .open_path(path.to_string(), None::<&str>)
        .map_err(|e| format!("打开路径失败: {e}"))
}

/// 用系统默认程序打开一个路径：文件夹走文件管理器（Windows Explorer；macOS Finder；
/// Linux 文件管理器），文件走默认关联程序。
#[tauri::command]
pub fn open_path<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    open_with_default(&app, &path)
}

/// 在文件夹中定位并选中一个文件；Linux 失败时回退到打开父目录。
#[tauri::command]
pub fn open_file_folder<R: Runtime>(app: AppHandle<R>, file_path: String) -> Result<(), String> {
    let path = normalize_path(&file_path);
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }

    // 插件通过 FileManager1.ShowItems 请求文件管理器选中文件，并提供 Portal 回退。
    match app.opener().reveal_item_in_dir(path) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(target_os = "linux")]
            {
                // Linux 桌面环境千差万别，定位失败时退化成打开父目录，至少让用户看到文件所在处。
                eprintln!("定位文件失败，改为打开父目录: {error}");
                let parent = std::path::Path::new(path)
                    .parent()
                    .ok_or_else(|| "Invalid file path".to_string())?;
                return open_with_default(&app, &parent.to_string_lossy());
            }
            #[cfg(not(target_os = "linux"))]
            Err(format!("定位文件失败: {error}"))
        }
    }
}

/// 在资源管理器中打开虚拟盘内指定画册文件夹（含子画册路径，与 VD 目录结构一致）。
#[tauri::command]
pub async fn open_album_virtual_drive_folder<R: Runtime>(
    app: AppHandle<R>,
    album_id: String,
) -> Result<(), String> {
    #[cfg(not(feature = "standard"))]
    {
        let _ = (app, album_id);
        return Err("当前模式不支持虚拟盘".to_string());
    }
    #[cfg(feature = "standard")]
    {
        use kabegame_core::settings::Settings;
        use kabegame_core::virtual_driver::album_folder_abs_path_for_explorer;

        let id = album_id.trim();
        if id.is_empty() {
            return Err("画册 ID 不能为空".to_string());
        }
        let mount = Settings::global().get_album_drive_mount_point();
        let path = album_folder_abs_path_for_explorer(&mount, id)?;
        open_with_default(&app, &path)
    }
}
