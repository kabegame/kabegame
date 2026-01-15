// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use base64::Engine;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::Shell::DROPFILES,
    UI::WindowsAndMessaging::GetSystemMetrics,
};

#[cfg(target_os = "windows")]
const CF_HDROP_FORMAT: u32 = 15; // Clipboard format for file drop

#[cfg(feature = "local-backend")]
mod storage;
#[cfg(feature = "tray")]
mod tray;
mod wallpaper;
mod daemon_client;
mod event_listeners;

// ==================== Daemon IPC 命令（客户端侧 wrappers）====================

#[tauri::command]
async fn check_daemon_status() -> Result<serde_json::Value, String> {
    daemon_client::try_connect_daemon().await
}

#[tauri::command]
async fn get_images() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_images()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_images_paginated(page: usize, page_size: usize) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_images_paginated(page, page_size)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_albums() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_albums()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn add_album(name: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_add_album(name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn delete_album(album_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_album(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_all_tasks() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_all_tasks()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_task(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn add_task(task: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_add_task(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn update_task(task: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_task(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn delete_task(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_task(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[cfg(feature = "local-backend")]
use kabegame_core::settings::Settings;
// app-main 默认只做 IPC client：不要直接依赖 kabegame_core::plugin（除非 local-backend）
#[cfg(feature = "local-backend")]
use kabegame_core::plugin;
#[cfg(feature = "local-backend")]
use plugin::PluginManager;
use std::fs;
#[cfg(feature = "local-backend")]
use storage::images::PaginatedImages;
#[cfg(feature = "local-backend")]
use storage::{Album, ImageInfo, Storage, TaskInfo};
use wallpaper::{WallpaperController, WallpaperRotator};
#[cfg(target_os = "windows")]
use wallpaper::WallpaperWindow;

// Wallpaper Engine 导出：走 daemon IPC（不直接依赖 core 的 Settings/Storage）
#[cfg(feature = "virtual-drive")]
mod virtual_drive;
// 导入trait保证可用
#[cfg(feature = "virtual-drive")]
use virtual_drive::{drive_service::VirtualDriveServiceTrait, VirtualDriveService};

// 任务失败图片（用于 TaskDetail 展示 + 重试）

// ---- wrappers: tauri::command 必须在当前 app crate 中定义，不能直接复用依赖 crate 的 command 宏产物 ----

/// TaskDetail 专用：分页结果（字段名使用 camelCase，与前端 `PaginatedImages` 对齐）。
#[tauri::command]
#[cfg(target_os = "windows")]
async fn export_album_to_we_project(
    album_id: String,
    album_name: String,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .we_export_album_to_project(album_id, album_name, output_parent_dir, options)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(target_os = "windows")]
async fn export_images_to_we_project(
    image_paths: Vec<String>,
    title: Option<String>,
    output_parent_dir: String,
    options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .we_export_images_to_project(image_paths, title, output_parent_dir, options)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

fn get_current_wallpaper_path_from_settings(_app: &tauri::AppHandle) -> Option<String> {
    // IPC-only：从 daemon 获取 settings + image localPath
    let v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .ok()?;
    let id = v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())?;
    let img = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .storage_get_image_by_id(id)
        .await
    })
    .ok()?;
    img.get("localPath")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// 启动时初始化“当前壁纸”并按规则回退/降级
///
/// 规则（按用户需求）：
/// - 非轮播：尝试设置 currentWallpaperImageId；失败则清空并停止
/// - 轮播：优先在轮播源中找到 currentWallpaperImageId；找不到则回退到轮播源的一张；源无可用则画册->画廊->关闭轮播并清空
async fn init_wallpaper_on_startup(app: &tauri::AppHandle) -> Result<(), String> {
    use std::path::Path;

    let controller = app.state::<WallpaperController>();
    // IPC-only：启动时只“尝试还原 currentWallpaperImageId”，不在客户端做大规模选图/回退，
    // 回退与轮播逻辑由 daemon + rotator 负责（避免客户端依赖 Storage/Settings）。
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

    let style = settings_v
        .get("wallpaperRotationStyle")
        .and_then(|x| x.as_str())
        .unwrap_or("fill")
        .to_string();

    let Some(id) = settings_v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
    else {
        return Ok(());
    };

    let img_v = daemon_client::get_ipc_client()
        .storage_get_image_by_id(id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let Some(path) = img_v.get("localPath").and_then(|x| x.as_str()) else {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
        return Ok(());
    };

    if !Path::new(path).exists() {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
        return Ok(());
    }

    if controller.set_wallpaper(path, &style).is_err() {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }

    Ok(())
}

#[tauri::command]
async fn get_plugins() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 前端手动刷新“已安装源”：触发后端重扫 plugins-directory 并重建缓存
#[tauri::command]
async fn refresh_installed_plugins_cache() -> Result<(), String> {
    // daemon 侧会在 get_plugins 时刷新 installed cache
    let _ = daemon_client::get_ipc_client()
        .plugin_get_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

/// 前端安装/更新后可调用：按 pluginId 局部刷新缓存
#[tauri::command]
fn refresh_installed_plugin_cache(
    plugin_id: String,
) -> Result<(), String> {
    // 兜底：触发一次 detail 加载，相当于“按 id 刷新缓存”
    tauri::async_runtime::block_on(async {
        let _ = daemon_client::get_ipc_client()
            .plugin_get_detail(plugin_id)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
fn get_build_mode() -> Result<String, String> {
    Ok(env!("KABEGAME_BUILD_MODE").to_string())
}

#[tauri::command]
async fn delete_plugin(plugin_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .plugin_delete(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 创建任务并立刻入队执行（合并 `add_task` + `crawl_images_command`）
#[tauri::command]
async fn start_task(task: serde_json::Value) -> Result<(), String> {
    let _task_id = daemon_client::get_ipc_client()
        .task_start(task)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_get_images(state: tauri::State<Storage>) -> Result<Vec<ImageInfo>, String> {
    state.get_all_images()
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_get_images_paginated(
    page: usize,
    page_size: usize,
    state: tauri::State<Storage>,
) -> Result<PaginatedImages, String> {
    state.get_images_paginated(page, page_size)
}

#[tauri::command]
async fn get_images_range(offset: usize, limit: usize) -> Result<serde_json::Value, String> {
    // 兼容旧前端 offset+limit：使用 daemon 的 page+page_size
    let page = if limit == 0 { 0 } else { offset / limit };
    daemon_client::get_ipc_client()
        .storage_get_images_paginated(page, limit)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn browse_gallery_provider(path: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .gallery_browse_provider(path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}
// NOTE: 旧的 browse_gallery_provider_main（客户端拼虚拟目录树 + query helpers）已废弃，
// 现在完全由 daemon 侧 ProviderRuntime + `GalleryBrowseProvider` 提供。

#[tauri::command]
async fn get_image_by_id(image_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_image_by_id(image_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_get_albums(state: tauri::State<Storage>) -> Result<Vec<Album>, String> {
    state.get_albums()
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_add_album(
    app: tauri::AppHandle,
    name: String,
    state: tauri::State<Storage>,
    #[cfg(feature = "virtual-drive")] drive: tauri::State<VirtualDriveService>,
) -> Result<Album, String> {
    let album = state.add_album(&name)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "add"
        }),
    );
    #[cfg(feature = "virtual-drive")]
    {
        drive.bump_albums();
    }
    Ok(album)
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
async fn rename_album(
    _app: tauri::AppHandle,
    album_id: String,
    new_name: String,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_rename_album(album_id, new_name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
async fn rename_album(
    _app: tauri::AppHandle,
    album_id: String,
    new_name: String,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_rename_album(album_id, new_name)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    drive.bump_albums();
    Ok(())
}

// --- Windows 虚拟盘（Dokan） ---

#[cfg(feature = "virtual-drive")]
#[tauri::command]
fn mount_virtual_drive(
    app: tauri::AppHandle,
    mount_point: String,
    storage: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    drive.mount(&mount_point, storage.inner().clone(), app)
}

#[cfg(feature = "virtual-drive")]
#[tauri::command]
fn unmount_virtual_drive(
    drive: tauri::State<VirtualDriveService>,
    mount_point: Option<String>,
) -> Result<bool, String> {
    // 1) 先尝试用当前进程卸载（如果本进程是挂载者或具备权限）
    match drive.unmount() {
        Ok(v) if v => return Ok(true),
        Ok(_) => {
            // 继续走兜底
        }
        Err(_) => {
            // 继续走兜底
        }
    }

    // 2) 兜底：通过提权 helper 卸载（适用于挂载由提权进程完成的情况）
    #[cfg(target_os = "windows")]
    {
        let Some(mp) = mount_point.as_deref() else {
            return Ok(false);
        };
        let mp = mp.trim();
        if mp.is_empty() {
            return Ok(false);
        }

        use kabegame_core::virtual_drive::ipc::{VdIpcRequest, VdIpcResponse};

        let mp_norm = virtual_drive::drive_service::normalize_mount_point(mp)?;

        let try_unmount_via_ipc = || -> Result<VdIpcResponse, String> {
            tauri::async_runtime::block_on(async {
                kabegame_core::virtual_drive::ipc::request(VdIpcRequest::Unmount {
                    mount_point: mp_norm.clone(),
                })
                .await
            })
        };

        let resp = match try_unmount_via_ipc() {
            Ok(r) => r,
            Err(_ipc_err) => {
                // daemon 不存在：runas 启动
                let mut cliw =
                    std::env::current_exe().map_err(|e| format!("current_exe failed: {}", e))?;
                cliw.set_file_name("kabegame-cliw.exe");
                if !cliw.is_file() {
                    return Err(format!(
                        "卸载需要管理员权限，但找不到提权 helper: {}",
                        cliw.display()
                    ));
                }
                kabegame_core::shell_open::runas(&cliw.to_string_lossy(), "vd daemon")?;

                // 等待 daemon 就绪
                let mut ready = false;
                for _ in 0..100 {
                    if tauri::async_runtime::block_on(async {
                        kabegame_core::virtual_drive::ipc::request(VdIpcRequest::Status)
                            .await
                            .is_ok()
                    }) {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                if !ready {
                    let log_path = std::env::temp_dir().join("kabegame-vd-daemon.log");
                    return Err(format!(
                        "已请求管理员权限启动 VD daemon，但 IPC 未就绪。\n\n如果找不到日志文件，说明 daemon 大概率没有启动成功：\n- 日志路径：{}\n\n下一步建议：\n1) 让用户打开“任务管理器-详细信息”，确认是否存在 kabegame-cli.exe / kabegame-cliw.exe；\n2) 让用户以管理员手动运行：kabegame-cli.exe vd daemon（看是否立即退出/是否生成日志）；\n3) 如果有杀软/企业策略，检查是否拦截了新进程/命名管道。\n\n原始错误：{}",
                        log_path.display(),
                        _ipc_err
                    ));
                }

                try_unmount_via_ipc()?
            }
        };

        if !resp.ok {
            return Err(resp.message.unwrap_or_else(|| "卸载失败".to_string()));
        }
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

#[cfg(feature = "virtual-drive")]
#[tauri::command]
fn mount_virtual_drive_and_open_explorer(
    app: tauri::AppHandle,
    mount_point: String,
    storage: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    // 先尝试直接挂载（如果当前进程已提权，或系统允许）
    match drive.mount(&mount_point, storage.inner().clone(), app.clone()) {
        Ok(()) => {
            let open_path = drive.current_mount_point().unwrap_or(mount_point);
            std::process::Command::new("explorer")
                .arg(open_path)
                .spawn()
                .map_err(|e| format!("已挂载，但打开资源管理器失败: {}", e))?;
            return Ok(());
        }
        Err(e) => {
            // Windows：常见是未提权导致 Dokan 挂载失败。这里兜底走提权 daemon + 命名管道 IPC（不重启主进程）。
            #[cfg(target_os = "windows")]
            {
                use kabegame_core::virtual_drive::ipc::{VdIpcRequest, VdIpcResponse};

                let mp_norm = virtual_drive::drive_service::normalize_mount_point(&mount_point)?;

                // 1) 先尝试直接走 IPC（如果 daemon 已存在则不会弹 UAC）
                let try_mount_via_ipc = || -> Result<VdIpcResponse, String> {
                    tauri::async_runtime::block_on(async {
                        kabegame_core::virtual_drive::ipc::request(VdIpcRequest::Mount {
                            mount_point: mp_norm.clone(),
                        })
                        .await
                    })
                };

                let resp = match try_mount_via_ipc() {
                    Ok(r) => r,
                    Err(_ipc_err) => {
                        // 2) daemon 不存在：用 runas 启动提权 daemon（常驻）
                        let mut cliw = std::env::current_exe()
                            .map_err(|e| format!("current_exe failed: {}", e))?;
                        cliw.set_file_name("kabegame-cliw.exe");
                        if !cliw.is_file() {
                            return Err(format!(
                                "{}\n\n挂载需要管理员权限，但找不到提权 helper: {}",
                                e,
                                cliw.display()
                            ));
                        }

                        kabegame_core::shell_open::runas(&cliw.to_string_lossy(), "vd daemon")?;

                        // 3) 等待 daemon 就绪：轮询 IPC status（默认最多 30s；Win10 + 杀软环境可能更慢）
                        let mut ready = false;
                        for _ in 0..300 {
                            if tauri::async_runtime::block_on(async {
                                kabegame_core::virtual_drive::ipc::request(VdIpcRequest::Status)
                                    .await
                                    .is_ok()
                            }) {
                                ready = true;
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                        if !ready {
                            return Err(format!(
                                "已请求管理员权限启动 VD daemon，但 IPC 未就绪。\n\n可能原因：\n- UAC 未确认/被策略或杀软拦截\n- daemon 启动即崩溃（缺依赖/权限/运行时错误）\n\n请让用户查看日志：%TEMP%\\kabegame-vd-daemon.log\n（如果日志不存在，说明 daemon 可能根本没有启动成功）\n\n原始挂载失败原因：{}",
                                e
                            ));
                        }

                        try_mount_via_ipc()?
                    }
                };

                if !resp.ok {
                    return Err(resp.message.unwrap_or_else(|| "挂载失败".to_string()));
                }

                let open_path = resp.mount_point.unwrap_or_else(|| mp_norm.clone());
                std::process::Command::new("explorer")
                    .arg(open_path)
                    .spawn()
                    .map_err(|e| format!("已挂载，但打开资源管理器失败: {}", e))?;
                return Ok(());
            }

            #[cfg(not(target_os = "windows"))]
            {
                return Err(e);
            }
        }
    }
}

#[tauri::command]
fn open_explorer(path: String) -> Result<(), String> {
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

fn reveal_in_folder_native(file_path: &str) -> Result<(), String> {
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
#[cfg(feature = "local-backend")]
fn local_delete_album(
    app: tauri::AppHandle,
    album_id: String,
    state: tauri::State<Storage>,
    #[cfg(feature = "virtual-drive")] drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    state.delete_album(&album_id)?;
    let _ = app.emit(
        "albums-changed",
        serde_json::json!({
            "reason": "delete"
        }),
    );
    #[cfg(feature = "virtual-drive")]
    {
        drive.bump_albums();
    }
    Ok(())
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
async fn add_images_to_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
 ) -> Result<serde_json::Value, String> {
    let r = daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "add"
            ,"imageIds": image_ids
        }),
    );
    Ok(r)
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
async fn remove_images_from_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let removed = v.as_u64().unwrap_or(0) as usize;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "remove"
            ,"imageIds": image_ids
        }),
    );
    Ok(removed)
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
async fn add_images_to_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<serde_json::Value, String> {
    let r = daemon_client::get_ipc_client()
        .storage_add_images_to_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "add"
            ,"imageIds": image_ids
        }),
    );
        drive.notify_album_dir_changed(state.inner(), &album_id);
    Ok(r)
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
async fn remove_images_from_album(
    app: tauri::AppHandle,
    album_id: String,
    image_ids: Vec<String>,
    state: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<usize, String> {
    let v = daemon_client::get_ipc_client()
        .storage_remove_images_from_album(album_id.clone(), image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let removed = v.as_u64().unwrap_or(0) as usize;
    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": album_id,
            "reason": "remove"
            ,"imageIds": image_ids
        }),
    );
    drive.notify_album_dir_changed(state.inner(), &album_id);
    Ok(removed)
}

#[tauri::command]
async fn get_album_images(album_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_images(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_album_image_ids(album_id: String) -> Result<Vec<String>, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_image_ids(album_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_album_preview(album_id: String, limit: usize) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_preview(album_id, limit)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_album_counts() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_album_counts()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_album_images_order(album_id, image_orders)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_images_count() -> Result<usize, String> {
    daemon_client::get_ipc_client()
        .storage_get_images_count()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn delete_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_image(image_id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    if settings_v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        == Some(image_id.as_str())
    {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
async fn remove_image(image_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_remove_image(image_id.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    if settings_v
        .get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        == Some(image_id.as_str())
    {
        let _ = daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await;
    }
    Ok(())
}

#[tauri::command]
async fn batch_delete_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_batch_delete_images(image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    if let Some(cur) = settings_v.get("currentWallpaperImageId").and_then(|x| x.as_str()) {
        if image_ids.iter().any(|id| id == cur) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn batch_remove_images(image_ids: Vec<String>) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_batch_remove_images(image_ids.clone())
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let settings_v = daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    if let Some(cur) = settings_v.get("currentWallpaperImageId").and_then(|x| x.as_str()) {
        if image_ids.iter().any(|id| id == cur) {
            let _ = daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(None)
                .await;
        }
    }
    Ok(())
}

/// 启动“分批按 hash 去重”后台任务（daemon 执行，事件通过 Generic 转发到前端）。
#[tauri::command]
async fn start_dedupe_gallery_by_hash_batched(delete_files: bool) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .dedupe_start_gallery_by_hash_batched(delete_files, Some(10_000))
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 取消“分批按 hash 去重”后台任务。
#[tauri::command]
async fn cancel_dedupe_gallery_by_hash_batched() -> Result<bool, String> {
    daemon_client::get_ipc_client()
        .dedupe_cancel_gallery_by_hash_batched()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

// 清理应用数据（仅用户数据，不包括应用本身）
#[tauri::command]
async fn clear_user_data(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    if !app_data_dir.exists() {
        return Ok(()); // 目录不存在，无需清理
    }

    // 不处理 window_state：已取消保存/恢复

    // 方案：创建清理标记文件，在应用重启后清理
    // 这样可以避免删除正在使用的文件
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    fs::write(&cleanup_marker, "1")
        .map_err(|e| format!("Failed to create cleanup marker: {}", e))?;

    // 延迟重启，确保响应已发送
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        app.restart();
    });

    Ok(())
}

#[tauri::command]
#[cfg(not(all(feature = "virtual-drive", target_os = "windows")))]
async fn toggle_image_favorite(
    app: tauri::AppHandle,
    image_id: String,
    favorite: bool,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_toggle_image_favorite(image_id.clone(), favorite)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": "00000000-0000-0000-0000-000000000001",
            "reason": if favorite { "add" } else { "remove" },
            "imageIds": [image_id]
        }),
    );

    Ok(())
}

#[tauri::command]
#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
async fn toggle_image_favorite(
    app: tauri::AppHandle,
    image_id: String,
    favorite: bool,
    state: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_toggle_image_favorite(image_id.clone(), favorite)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;

    let _ = app.emit(
        "album-images-changed",
        serde_json::json!({
            "albumId": "00000000-0000-0000-0000-000000000001",
            "reason": if favorite { "add" } else { "remove" },
            "imageIds": [image_id]
        }),
    );

    drive.notify_album_dir_changed(state.inner(), "00000000-0000-0000-0000-000000000001");
    Ok(())
}

#[tauri::command]
fn open_file_path(file_path: String) -> Result<(), String> {
    open_path_native(&file_path)
}

#[tauri::command]
fn open_file_folder(file_path: String) -> Result<(), String> {
    reveal_in_folder_native(&file_path)
}

#[tauri::command]
async fn set_wallpaper(file_path: String, app: tauri::AppHandle) -> Result<(), String> {
    // 壁纸设置可能包含阻塞的系统调用（Windows API / Explorer 刷新等）。
    // 若在主线程执行，会导致前端 WebView “整页卡死”，因此必须放到 blocking 线程。
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::path::Path;

        let path = Path::new(&file_path);
        if !path.exists() {
            return Err("File does not exist".to_string());
        }

        // 使用全局 WallpaperController：适配“单张壁纸”并支持 native/window 两种后端模式。
        // 注意：这里不涉及 transition（过渡效果由“轮播 manager”负责，并受“是否启用轮播”约束）。
        let controller = app_clone.state::<WallpaperController>();
        let settings_v = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let style = settings_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill");

        let abs = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();

        controller.set_wallpaper(&abs, style)?;

        // 维护全局“当前壁纸”（imageId）
        // - 若能从 DB 根据 local_path 找到 image：写入该 imageId
        // - 否则清空（避免残留旧值）
        let found = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().storage_find_image_by_path(abs.clone()).await
        })
        .ok();
        let image_id = found
            .as_ref()
            .and_then(|v| v.get("id").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        let _ = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(image_id)
                .await
        });

        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// 按 imageId 设置壁纸，并同步更新 settings.currentWallpaperImageId
#[tauri::command]
async fn set_wallpaper_by_image_id(image_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::path::Path;

        let settings_v = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().settings_get().await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let style = settings_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill");

        let image = tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .storage_get_image_by_id(image_id.clone())
                .await
        })
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
        let local_path = image
            .get("localPath")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "图片不存在".to_string())?
            .to_string();

        if !Path::new(&local_path).exists() {
            // 图片已被删除/移除/文件丢失：清空 currentWallpaperImageId
            let _ = tauri::async_runtime::block_on(async {
                daemon_client::get_ipc_client()
                    .settings_set_current_wallpaper_image_id(None)
                    .await
            });
            return Err("图片文件不存在".to_string());
        }

        let controller = app_clone.state::<WallpaperController>();
        controller.set_wallpaper(&local_path, style)?;

        tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client()
                .settings_set_current_wallpaper_image_id(Some(image_id))
                .await
                .map_err(|e| format!("Daemon unavailable: {}", e))
        })?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

#[tauri::command]
fn get_current_wallpaper_image_id() -> Result<Option<String>, String> {
    // IPC-only：从 daemon 获取
    let v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(v.get("currentWallpaperImageId")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string()))
}

#[tauri::command]
fn clear_current_wallpaper_image_id() -> Result<(), String> {
    // IPC-only：从 daemon 设置
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_current_wallpaper_image_id(None)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

/// 根据 imageId 取图片本地路径（用于 UI 展示/定位）
#[tauri::command]
fn get_image_local_path_by_id(
    image_id: String,
) -> Result<Option<String>, String> {
    let v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .storage_get_image_by_id(image_id)
            .await
    })
    .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(v.get("localPath").and_then(|x| x.as_str()).map(|s| s.to_string()))
}

/// 获取当前正在使用的壁纸路径（与当前 wallpaper_mode 对应）
///
/// - 返回 `None` 表示当前后端没有记录壁纸（例如从未设置过 window/gdi 壁纸）
/// - 返回 `Some(path)` 表示当前后端记录的壁纸路径（不保证文件一定存在）
#[tauri::command]
fn get_current_wallpaper_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(get_current_wallpaper_path_from_settings(&app))
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn migrate_images_from_json(state: tauri::State<Storage>) -> Result<usize, String> {
    state.migrate_from_json()
}

#[tauri::command]
async fn get_plugin_vars(plugin_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_vars(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_browser_plugins() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_browser_plugins()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_plugin_sources() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_plugin_sources()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn save_plugin_sources(sources: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .plugin_save_plugin_sources(sources)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_store_plugins(
    source_id: Option<String>,
    force_refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_store_plugins(source_id, force_refresh.unwrap_or(false))
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 统一的“源详情”加载：
/// - 本地已安装：从 plugins_directory 下的 .kgpg 读取
/// - 商店/官方源：根据 downloadUrl 远程下载到内存并解析（带缓存）
#[tauri::command]
async fn get_plugin_detail(
    plugin_id: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_get_detail_for_ui(plugin_id, download_url, sha256, size_bytes)
                .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn validate_plugin_source(index_url: String) -> Result<(), String> {
    let _ = daemon_client::get_ipc_client()
        .plugin_validate_source(index_url)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn preview_import_plugin(
    zip_path: String,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_preview_import(zip_path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 商店安装/更新：先下载到临时文件并做预览（版本变更/变更日志），由前端确认后再调用 import_plugin_from_zip 安装
#[tauri::command]
async fn preview_store_install(
    download_url: String,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_preview_store_install(download_url, sha256, size_bytes)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn import_plugin_from_zip(zip_path: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_import(zip_path)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
        .map(|plugin_id| serde_json::json!({ "pluginId": plugin_id }))
}

#[tauri::command]
async fn install_browser_plugin(plugin_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .plugin_install_browser_plugin(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_gallery_image(image_path: String) -> Result<Vec<u8>, String> {
    use std::fs;
    use std::path::Path;

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))
}

// ============================
// task_failed_images
// ============================

#[tauri::command]
async fn get_task_failed_images(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_failed_images(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 失败图片重试：daemon 侧复用 DownloadQueue（会触发 download-state 等事件）
#[tauri::command]
async fn retry_task_failed_image(failed_id: i64) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .task_retry_failed_image(failed_id)
    .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_plugin_image(plugin_id: String, image_path: String) -> Result<Vec<u8>, String> {
    // 统一走 daemon（已安装插件也可读取），返回 base64
    let v = daemon_client::get_ipc_client()
        .plugin_get_image_for_detail(plugin_id, image_path, None, None, None)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64 = v
        .get("base64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "Invalid response: missing base64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))
}

/// 详情页渲染文档图片用：本地已安装/远程商店源统一入口
#[tauri::command]
async fn get_plugin_image_for_detail(
    plugin_id: String,
    image_path: String,
    download_url: Option<String>,
    sha256: Option<String>,
    size_bytes: Option<u64>,
) -> Result<Vec<u8>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_image_for_detail(plugin_id, image_path, download_url, sha256, size_bytes)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64 = v
        .get("base64")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "Invalid response: missing base64".to_string())?;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))
}

#[tauri::command]
async fn get_plugin_icon(
    plugin_id: String,
) -> Result<Option<Vec<u8>>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_icon(plugin_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64_opt = v.get("base64").and_then(|x| x.as_str()).map(|s| s.to_string());
    let Some(b64) = b64_opt else { return Ok(None) };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    Ok(Some(bytes))
}

/// 商店列表 icon：KGPG v2 固定头部 + HTTP Range 读取（返回 PNG bytes）。
#[tauri::command]
async fn get_remote_plugin_icon(
    download_url: String,
) -> Result<Option<Vec<u8>>, String> {
    let v = daemon_client::get_ipc_client()
        .plugin_get_remote_icon_v2(download_url)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let b64_opt = v.get("base64").and_then(|x| x.as_str()).map(|s| s.to_string());
    let Some(b64) = b64_opt else { return Ok(None) };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    Ok(Some(bytes))
}

#[tauri::command]
async fn get_settings() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .settings_get()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_setting(key: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .settings_get_key(key)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
fn get_favorite_album_id() -> Result<String, String> {
    Ok("00000000-0000-0000-0000-000000000001".to_string())
}

#[tauri::command]
#[cfg(feature = "virtual-drive")]
fn set_album_drive_enabled(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_album_drive_enabled(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
#[cfg(feature = "virtual-drive")]
fn set_album_drive_mount_point(
    mount_point: String,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_album_drive_mount_point(mount_point)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_auto_launch(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_auto_launch(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_max_concurrent_downloads(
    count: u32,
) -> Result<(), String> {
    // 设置落盘 + 并发调整在 daemon 完成
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_max_concurrent_downloads(count)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    // 本地轮播器可能在跑：唤醒等待（保持原行为）
    Ok(())
}

#[tauri::command]
fn set_network_retry_count(count: u32) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_network_retry_count(count)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_image_click_action(action: String) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_image_click_action(action)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_gallery_image_aspect_ratio_match_window(
    enabled: bool,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_gallery_image_aspect_ratio_match_window(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_gallery_image_aspect_ratio(
    aspect_ratio: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_gallery_image_aspect_ratio(aspect_ratio)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn get_desktop_resolution() -> Result<(u32, u32), String> {
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let width = GetSystemMetrics(0) as u32; // SM_CXSCREEN
            let height = GetSystemMetrics(1) as u32; // SM_CYSCREEN
            Ok((width, height))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 其他平台可以返回默认值或实现相应逻辑
        Ok((1920, 1080))
    }
}

#[tauri::command]
fn set_auto_deduplicate(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_auto_deduplicate(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_default_download_dir(
    dir: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_default_download_dir(dir)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_wallpaper_engine_dir(
    dir: Option<String>,
) -> Result<(), String> {
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_engine_dir(dir)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn get_wallpaper_engine_myprojects_dir(
) -> Result<Option<String>, String> {
    tokio::runtime::Handle::current().block_on(async move {
        let v = daemon_client::get_ipc_client()
            .settings_get_wallpaper_engine_myprojects_dir()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))?;
        serde_json::from_value(v).map_err(|e| format!("Invalid response: {e}"))
    })
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn get_default_images_dir(state: tauri::State<Storage>) -> Result<String, String> {
    Ok(state
        .get_images_dir()
        .to_string_lossy()
        .to_string()
        .trim_start_matches("\\\\?\\")
        .to_string())
}

#[tauri::command]
async fn add_run_config(config: serde_json::Value) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_add_run_config(config)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn update_run_config(config: serde_json::Value) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_update_run_config(config)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_run_configs() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_run_configs()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn delete_run_config(config_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_delete_run_config(config_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn cancel_task(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .task_cancel(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_active_downloads() -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .get_active_downloads()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

// 任务相关命令
#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_add_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.add_task(task)
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_update_task(task: TaskInfo, state: tauri::State<Storage>) -> Result<(), String> {
    state.update_task(task)
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_get_task(task_id: String, state: tauri::State<Storage>) -> Result<Option<TaskInfo>, String> {
    state.get_task(&task_id)
}

#[tauri::command]
#[cfg(feature = "local-backend")]
fn local_get_all_tasks(state: tauri::State<Storage>) -> Result<Vec<TaskInfo>, String> {
    state.get_all_tasks()
}

/// 将任务的 Rhai 失败 dump 标记为“已确认/已读”（用于任务列表右上角小按钮）
#[tauri::command]
async fn confirm_task_rhai_dump(task_id: String) -> Result<(), String> {
    daemon_client::get_ipc_client()
        .storage_confirm_task_rhai_dump(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

/// 清除所有已完成、失败或取消的任务（保留 pending 和 running 的任务）
/// 返回被删除的任务数量
#[tauri::command]
async fn clear_finished_tasks() -> Result<usize, String> {
    daemon_client::get_ipc_client()
        .storage_clear_finished_tasks()
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_task_images(task_id: String) -> Result<serde_json::Value, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_images(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_task_images_paginated(
    task_id: String,
    page: usize,
    page_size: usize,
) -> Result<serde_json::Value, String> {
    let offset = page.saturating_mul(page_size);
    daemon_client::get_ipc_client()
        .storage_get_task_images_paginated(task_id, offset, page_size)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

#[tauri::command]
async fn get_task_image_ids(task_id: String) -> Result<Vec<String>, String> {
    daemon_client::get_ipc_client()
        .storage_get_task_image_ids(task_id)
        .await
        .map_err(|e| format!("Daemon unavailable: {}", e))
}

// Windows：将文件列表写入剪贴板为 CF_HDROP，便于原生应用粘贴/拖拽识别
#[cfg(target_os = "windows")]
#[tauri::command]
fn set_wallpaper_rotation_enabled(
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_enabled(enabled)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    // 注意：此命令只负责“开关落盘/停播清理”，不负责启动轮播线程。
    // 轮播线程仅在“设置轮播画册ID”（或回落到画廊轮播）时启动，避免在未选择来源时启动后立刻退出/假死。
    if !enabled {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RotationStartResult {
    started: bool,
    source: String,           // "album" | "gallery"
    album_id: Option<String>, // source=album 时为 Some(id)，source=gallery 时为 Some("")（保留设置值）
    fallback: bool,           // 是否发生“画册 -> 画廊”的回退
    warning: Option<String>,  // 需要提示给用户的警告（例如回退原因）
}

#[tauri::command]
fn set_wallpaper_rotation_album_id(
    album_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 约定：
    // - Some(non-empty) => 轮播指定画册
    // - Some("")        => 轮播整个画廊（从当前壁纸开始）
    // - None            => 清空来源并停止轮播线程
    let normalized = album_id.map(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            "".to_string()
        } else {
            t
        }
    });

    let normalized_for_ipc = normalized.clone();
    tokio::runtime::Handle::current().block_on(async move {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_album_id(normalized_for_ipc)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    // 清空来源：停止线程（但不更改 enabled 开关）
    if normalized.is_none() {
        let rotator = app.state::<WallpaperRotator>();
        rotator.stop();
        return Ok(());
    }

    // 仅当“轮播已启用”时才尝试启动线程
    // daemon settings 用于判断 enabled（避免本地 settings 依赖）
    let settings_v = tokio::runtime::Handle::current().block_on(async {
        daemon_client::get_ipc_client()
            .settings_get()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    if settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        let rotator = app.state::<WallpaperRotator>();
        // 当选择为画廊轮播（空字符串）时：从当前壁纸开始
        let start_from_current = settings_v
            .get("wallpaperRotationAlbumId")
            .and_then(|x| x.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(false);
        rotator
            .ensure_running(start_from_current)
            .map_err(|e| format!("启动轮播失败: {}", e))?;
    }

    Ok(())
}

/// 启动轮播（仅当 wallpaper_rotation_enabled=true）
///
/// - 若设置里保存了上次画册ID：优先尝试用画册轮播
/// - 若失败或未保存：回落到“画廊轮播”（album_id = ""），并从当前壁纸开始
#[tauri::command]
fn start_wallpaper_rotation(
    app: tauri::AppHandle,
) -> Result<RotationStartResult, String> {
    let settings_v = tokio::runtime::Handle::current().block_on(async {
        daemon_client::get_ipc_client()
            .settings_get()
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    if !settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        return Err("壁纸轮播未启用".to_string());
    }

    let rotator = app.state::<WallpaperRotator>();
    let mut did_fallback = false;
    let mut warning: Option<String> = None;

    // 1) 优先尝试：如果保存了“上次画册ID”且非空，则先用画册轮播
    if let Some(saved) = settings_v.get("wallpaperRotationAlbumId").and_then(|x| x.as_str()) {
        if !saved.trim().is_empty() {
            // 先不改设置，直接按当前设置尝试启动
            match rotator.ensure_running(false) {
                Ok(_) => {
                    return Ok(RotationStartResult {
                        started: true,
                        source: "album".to_string(),
                        album_id: Some(saved.to_string()),
                        fallback: false,
                        warning: None,
                    });
                }
                Err(e) => {
                    // 画册为空：直接失败，不回退
                    if e.contains("画册内没有图片") {
                        return Err(e);
                    }
                    // 画册不存在：回退到画廊
                    if e.contains("画册不存在") {
                        eprintln!(
                            "[WARN] start_wallpaper_rotation: saved album_id missing, fallback to gallery. err={}",
                        e
                    );
                        did_fallback = true;
                        warning = Some("上次选择的画册不存在，已回退到画廊轮播".to_string());
                    } else {
                        // 其他错误：不擅自回退，直接失败
                        return Err(e);
                    }
                }
            }
        }
    }

    // 2) 回落到画廊轮播：写入 album_id="" 并启动（从当前壁纸开始）
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_album_id(Some("".to_string()))
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    rotator.ensure_running(true)?;

    Ok(RotationStartResult {
        started: true,
        source: "gallery".to_string(),
        album_id: Some("".to_string()),
        fallback: did_fallback,
        warning,
    })
}
#[tauri::command]
fn set_wallpaper_rotation_interval_minutes(
    minutes: u32,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_interval_minutes(minutes)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;

    // 如果轮播器正在运行，重置定时器以应用新的间隔设置
    if let Some(rotator) = app.try_state::<WallpaperRotator>() {
        if rotator.is_running() {
            rotator.reset();
        }
    }

    Ok(())
}

#[tauri::command]
fn set_wallpaper_rotation_mode(mode: String) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_mode(mode)
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })
}

#[tauri::command]
fn set_wallpaper_style(
    style: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    println!(
        "[DEBUG] set_wallpaper_style 被调用，传入的 style: {}",
        style
    );

    // 先保存设置（daemon）
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_style(style.clone())
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    println!("[DEBUG] 已保存新 style: {}", style);

    // 原生模式下应用样式可能较慢（PowerShell/注册表/广播），放到后台线程避免前端卡顿
    let app_clone = app.clone();
    let style_clone = style.clone();
    std::thread::spawn(move || {
        let controller = app_clone.state::<WallpaperController>();
        let res = controller.active_manager().and_then(|m| {
            // 1) 先设置样式
            m.set_style(&style_clone, true)?;
            // 2) 再重载当前壁纸路径，强制桌面立即用新样式重新渲染
            //    （否则部分系统/场景只改注册表不会立刻重绘）
            if let Some(path) = get_current_wallpaper_path_from_settings(&app_clone) {
                if std::path::Path::new(&path).exists() {
                    let _ = m.set_wallpaper_path(&path, true);
                }
            }
            Ok(())
        });
        match res {
            Ok(_) => {
                let _ = app_clone.emit(
                    "wallpaper-style-apply-complete",
                    serde_json::json!({
                        "success": true,
                        "style": style_clone
                    }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-style-apply-complete",
                    serde_json::json!({
                        "success": false,
                        "style": style_clone,
                        "error": e
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn set_wallpaper_rotation_transition(
    transition: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    println!(
        "[DEBUG] set_wallpaper_rotation_transition 被调用，传入的 transition: {}",
        transition
    );

    // 未开启轮播时，不允许设置过渡效果（单张模式不支持 transition）
    let settings_v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let enabled = settings_v
        .get("wallpaperRotationEnabled")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    if !enabled {
        return Err("未开启壁纸轮播，无法设置过渡效果".to_string());
    }

    // 先保存设置（daemon）
    tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client()
            .settings_set_wallpaper_rotation_transition(transition.clone())
            .await
            .map_err(|e| format!("Daemon unavailable: {}", e))
    })?;
    println!("[DEBUG] 已保存新 transition: {}", transition);

    // 立即触发一次展示效果（先应用 transition，再切换一张壁纸）
    // 注意：对于 "none"（无过渡），只保存设置，不切换壁纸（避免触发系统默认的淡入效果）
    let app_clone = app.clone();
    let transition_clone = transition.clone();
    std::thread::spawn(move || {
        let controller = app_clone.state::<WallpaperController>();
        let rotator = app_clone.state::<WallpaperRotator>();

        let res: Result<(), String> = (|| {
            // 1) 先应用 transition（立即）
            let m = controller.active_manager()?;
            m.set_transition(&transition_clone, true)?;

            // 2) 对于 "none"（无过渡），不切换壁纸，只保存设置
            // 对于其他 transition（如 "fade"），触发一次"下一张"，让用户立刻看到过渡效果
            if transition_clone != "none" {
                rotator.rotate()?;
            }
            Ok(())
        })();

        match res {
            Ok(_) => {
                let _ = app_clone.emit(
                    "wallpaper-transition-apply-complete",
                    serde_json::json!({
                        "success": true,
                        "transition": transition_clone
                    }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-transition-apply-complete",
                    serde_json::json!({
                        "success": false,
                        "transition": transition_clone,
                        "error": e
                    }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn set_wallpaper_mode(
    mode: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;

    let current_settings_v = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .map_err(|e| format!("Daemon unavailable: {}", e))?;
    let old_mode = current_settings_v
        .get("wallpaperMode")
        .and_then(|x| x.as_str())
        .unwrap_or("native")
        .to_string();

    // 如果模式和当前设置相同，直接返回成功
    if old_mode == mode {
        return Ok(());
    }

    // 在后台线程中执行可能耗时的操作，避免阻塞主线程
    let mode_clone = mode.clone();
    let old_mode_clone = old_mode.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let rotator = app_clone.state::<WallpaperRotator>();
        let controller = app_clone.state::<WallpaperController>();

        // 关键：切换模式期间先暂停轮播，避免轮播线程仍按旧 mode（native）调用 SPI_SETDESKWALLPAPER，
        // 导致 Explorer 刷新把刚挂载的 window wallpaper “顶掉”，表现为“闪一下就没了”。
        let was_running = rotator.is_running();
        if was_running {
            rotator.stop();
        }

        // 读取最新设置（style/transition/是否启用轮播）
        let s_v = match tauri::async_runtime::block_on(async {
            daemon_client::get_ipc_client().settings_get().await
        }) {
            Ok(v) => v,
            Err(e) => {
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("获取设置失败: {}", e)
                    }),
                );
                return;
            }
        };
        let rotation_enabled = s_v
            .get("wallpaperRotationEnabled")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let rotation_mode = s_v
            .get("wallpaperRotationMode")
            .and_then(|x| x.as_str())
            .unwrap_or("random")
            .to_string();
        let cur_style = s_v
            .get("wallpaperRotationStyle")
            .and_then(|x| x.as_str())
            .unwrap_or("fill")
            .to_string();
        let cur_transition = s_v
            .get("wallpaperRotationTransition")
            .and_then(|x| x.as_str())
            .unwrap_or("none")
            .to_string();

        // 1) 从旧后端读取“当前壁纸路径”（尽量保持当前壁纸不变）
        let current_wallpaper = match get_current_wallpaper_path_from_settings(&app_clone) {
            Some(p) => p,
            None => {
                // 没有当前壁纸：仍允许切换模式（仅保存 mode），但不做 reapply
                match tauri::async_runtime::block_on(async {
                    daemon_client::get_ipc_client()
                        .settings_set_wallpaper_mode(mode_clone.clone())
                        .await
                }) {
                    Ok(_) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": true,
                                "mode": mode_clone
                            }),
                        );
                    }
                    Err(e2) => {
                        let _ = app_clone.emit(
                            "wallpaper-mode-switch-complete",
                            serde_json::json!({
                                "success": false,
                                "mode": mode_clone,
                                "error": format!("保存模式失败: {}", e2)
                            }),
                        );
                    }
                }
                return;
            }
        };

        // 2) 在目标后端上应用同一张壁纸（style 立即生效；transition 仅在轮播启用时预览）
        let target = controller.manager_for_mode(&mode_clone);
        // Windows 下，有时系统返回的“当前壁纸路径”可能不存在（例如主题缓存/临时文件）。
        // 切换到 window 模式时必须保证文件真实存在，否则 WindowWallpaperManager 会报 File does not exist。
        // 先做一次“温和清洗”：去掉 Windows 长路径前缀（\\?\）与前后空格，避免部分 API 返回的格式影响 exists 判断
        let current_cleaned = current_wallpaper
            .trim()
            .trim_start_matches(r"\\?\")
            .to_string();

        let resolved_wallpaper = if std::path::Path::new(&current_cleaned).exists() {
            current_cleaned.clone()
        } else {
            // 兜底策略（按你的需求）：当“当前壁纸文件不存在”时，直接从【画廊】按轮播策略挑一张存在的图片
            // - sequential：取画廊排序中的第一张存在图片（与轮播的顺序语义一致）
            // - random：从所有存在图片中随机挑一张
            let picked_from_gallery: Option<String> = (|| {
                let images_v = tauri::async_runtime::block_on(async {
                    daemon_client::get_ipc_client().storage_get_images().await
                })
                .ok()?;
                let arr = images_v.as_array()?;
                let mut existing: Vec<String> = Vec::new();
                for it in arr {
                    if let Some(p) = it.get("localPath").and_then(|x| x.as_str()) {
                        if std::path::Path::new(p).exists() {
                            existing.push(p.to_string());
                        }
                    }
                }
                if existing.is_empty() {
                    return None;
                }
                match rotation_mode.as_str() {
                    "sequential" => Some(existing[0].clone()),
                    _ => {
                        let idx = (std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos() as usize)
                            % existing.len();
                        Some(existing[idx].clone())
                    }
                }
            })();

            if let Some(p) = picked_from_gallery {
                eprintln!(
                    "[WARN] set_wallpaper_mode: 当前壁纸文件不存在，将从画廊选择兜底图片: {} (原路径: {})",
                    p, current_wallpaper
                );
                p
            } else {
                // 找不到可用图片：这里直接保留“不可用路径”，让后续 set_wallpaper_path 抛错并走失败事件，
                // 但错误信息会更聚焦（比单纯 File does not exist 更容易理解）
                current_cleaned.clone()
            }
        };
        // 2.5) 切换模式时：尽量保留/恢复该模式的 style/transition（按模式缓存）
        // - 优先“尽量保留当前值”：如果当前值在目标模式下仍可用，就沿用当前值
        // - 若当前值在目标模式下不可用：回退到目标模式的“上一次值”（若存在）
        // - 同时对 native 做 normalize，避免 slide/zoom 等不支持值污染全局设置
        let (style_to_apply, transition_to_apply) =
            match tauri::async_runtime::block_on(async {
                daemon_client::get_ipc_client()
                    .settings_swap_style_transition_for_mode_switch(
                        old_mode_clone.clone(),
                        mode_clone.clone(),
                    )
                    .await
            }) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[WARN] set_wallpaper_mode: swap_style_transition_for_mode_switch 失败: {}",
                    e
                );
                    (cur_style.clone(), cur_transition.clone())
            }
        };

        let apply_res: Result<(), String> = (|| {
            eprintln!("[DEBUG] set_wallpaper_mode: 开始应用模式 {}", mode_clone);
            // 关键：确保目标后端已初始化（尤其是 window 模式需要提前把 WallpaperWindow 放进 manager 状态）
            // 否则会报 “窗口未初始化，请先调用 init 方法”，前端就会一直显示“切换中”。
            eprintln!("[DEBUG] set_wallpaper_mode: 调用 target.init");
            target.init(app_clone.clone())?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.init 完成");
            // 先切换壁纸路径
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_wallpaper_path: {}",
                resolved_wallpaper
            );
            // 如果 resolved_wallpaper 仍然不存在，给一个更可读的错误（尤其是"从未设置过壁纸/系统返回缓存路径"的场景）
            if !std::path::Path::new(&resolved_wallpaper).exists() {
                let error_msg = if old_mode_clone == "native" {
                    format!(
                        "无法切换到窗口模式：当前系统壁纸文件不存在（可能是主题缓存或临时文件），且画廊中没有可用图片。请先在画廊中添加图片，或手动设置一张壁纸后再切换。\n原路径: {}",
                        resolved_wallpaper
                    )
                } else {
                    format!(
                        "无法切换到窗口模式：壁纸文件不存在，且画廊中没有可用图片作为兜底。请先在画廊中添加图片。\n路径: {}",
                        resolved_wallpaper
                    )
                };
                return Err(error_msg);
            }
            target.set_wallpaper_path(&resolved_wallpaper, true)?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_wallpaper_path 完成");
            // 再应用样式
            eprintln!(
                "[DEBUG] set_wallpaper_mode: 调用 target.set_style: {}",
                style_to_apply
            );
            target.set_style(&style_to_apply, true)?;
            eprintln!("[DEBUG] set_wallpaper_mode: target.set_style 完成");
            // 过渡效果属于轮播能力：只在轮播启用时做立即预览
            if rotation_enabled {
                // 最后应用transition
                eprintln!(
                    "[DEBUG] set_wallpaper_mode: 调用 target.set_transition: {}",
                    transition_to_apply
                );
                target.set_transition(&transition_to_apply, true)?;
                eprintln!("[DEBUG] set_wallpaper_mode: target.set_transition 完成");
            }
            eprintln!("[DEBUG] set_wallpaper_mode: 应用模式完成");
            Ok(())
        })();

        match apply_res {
            Ok(_) => {
                eprintln!("[DEBUG] set_wallpaper_mode: apply_res 成功");
                // 切换 away from window 模式时，清理 window 后端（隐藏壁纸窗口）
                if old_mode_clone == "window" && mode_clone != "window" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 清理 window 资源");
                    controller
                        .manager_for_mode("window")
                        .cleanup()
                        .unwrap_or_else(|e| eprintln!("清理 window 资源失败: {}", e));
                }
                // 切换 away from gdi 模式时，清理 gdi 后端（销毁 GDI 窗口）
                // 注意：cleanup 可能阻塞（等待线程退出），但我们需要确保清理完成
                // 所以仍然同步执行，但会在日志中显示进度
                if old_mode_clone == "gdi" && mode_clone != "gdi" {
                    eprintln!("[DEBUG] set_wallpaper_mode: 开始清理 gdi 资源（从 gdi 模式切换到其他模式）");
                    match controller.manager_for_mode("gdi").cleanup() {
                        Ok(_) => eprintln!("[DEBUG] set_wallpaper_mode: gdi 资源清理成功"),
                        Err(e) => eprintln!("[ERROR] 清理 gdi 资源失败: {}", e),
                    }
                }
                // 3) 应用成功后再持久化 mode
                eprintln!("[DEBUG] set_wallpaper_mode: 保存模式设置");
                if let Err(e) = tauri::async_runtime::block_on(async {
                    daemon_client::get_ipc_client()
                        .settings_set_wallpaper_mode(mode_clone.clone())
                        .await
                }) {
                    eprintln!("[ERROR] set_wallpaper_mode: 保存模式失败: {}", e);
                    let _ = app_clone.emit(
                        "wallpaper-mode-switch-complete",
                        serde_json::json!({
                            "success": false,
                            "mode": mode_clone,
                            "error": format!("保存模式失败: {}", e)
                        }),
                    );
                    return;
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 模式设置已保存");

                // 4) 轮播开启时重置定时器（切换模式也算一次“用户触发”）
                if rotation_enabled {
                    eprintln!("[DEBUG] set_wallpaper_mode: 恢复轮播");
                    // 切换完成后再恢复轮播（若之前在跑或用户开启了轮播）
                    // 这里用 start 确保轮播线程按新 mode 工作
                    let _ = rotator.start();
                }

                eprintln!("[DEBUG] set_wallpaper_mode: 发送成功事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": true,
                        "mode": mode_clone
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 成功事件已发送");
            }
            Err(e) => {
                eprintln!("[ERROR] 切换到 {} 模式失败: {}", mode_clone, e);
                // 失败时恢复轮播（如果之前在运行）
                if was_running {
                    let _ = rotator.start();
                }
                eprintln!("[DEBUG] set_wallpaper_mode: 发送失败事件");
                let _ = app_clone.emit(
                    "wallpaper-mode-switch-complete",
                    serde_json::json!({
                        "success": false,
                        "mode": mode_clone,
                        "error": format!("切换模式失败: {}", e)
                    }),
                );
                eprintln!("[DEBUG] set_wallpaper_mode: 失败事件已发送");
            }
        };
    });
    // 立即返回，不等待后台线程完成
    // 前端会通过事件来获知切换结果
    Ok(())
}

#[tauri::command]
fn get_wallpaper_rotator_status(app: tauri::AppHandle) -> Result<String, String> {
    let rotator = app.state::<WallpaperRotator>();
    Ok(rotator.get_status())
}

/// 获取系统原生模式支持的壁纸样式列表
#[tauri::command]
fn get_native_wallpaper_styles() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        // Windows 支持所有样式
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 原生支持较少，主要支持 fill 和 center
        Ok(vec!["fill".to_string(), "center".to_string()])
    }

    #[cfg(target_os = "linux")]
    {
        // Linux 取决于桌面环境，尝试检测并返回支持的样式
        // 默认返回所有样式，让用户选择（如果系统不支持会自动回退）
        Ok(vec![
            "fill".to_string(),
            "fit".to_string(),
            "stretch".to_string(),
            "center".to_string(),
            "tile".to_string(),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        // 其他平台默认只支持 fill
        Ok(vec!["fill".to_string()])
    }
}

/// 修复壁纸窗口的 Z-order（确保在 DefView 之下，WorkerW 之上）
#[cfg(target_os = "windows")]
fn fix_wallpaper_window_zorder(app: &tauri::AppHandle) {
    use tauri::Manager;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOW,
    };

    // 检查是否是窗口模式（IPC-only：从 daemon 读取 settings.wallpaperMode）
    let is_window_mode = tauri::async_runtime::block_on(async {
        daemon_client::get_ipc_client().settings_get().await
    })
    .ok()
    .and_then(|v| v.get("wallpaperMode").and_then(|x| x.as_str()).map(|s| s == "window"))
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
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
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
        fix_wallpaper_window_zorder(&app);
    }

    Ok(())
}

/// Windows：为主窗口左侧导航栏启用 DWM 模糊（BlurBehind + HRGN）。
/// - sidebar_width: 侧栏宽度（px）
#[tauri::command]
fn set_main_sidebar_dwm_blur(app: tauri::AppHandle, sidebar_width: u32) -> Result<(), String> {
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
        eprintln!(
            "[DWM] set_main_sidebar_dwm_blur: sidebar_width={}",
            sidebar_width
        );

        if hwnd == 0 {
            return Err("hwnd is null".into());
        }

        // ---- 优先：SetWindowCompositionAttribute + ACCENT_ENABLE_ACRYLICBLURBEHIND（Win11 更常见/更稳定）----
        // 我们给“整个窗口”开启 acrylic，但由于主内容区域是不透明背景，视觉上只有侧栏（半透明）会显现毛玻璃。
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

/// 打开插件编辑器（以独立进程运行 kabegame-plugin-editor.exe）
///
/// 注意：我们不使用 Tauri sidecar 机制（因为它更适合“同一 app 的附属工具”）。
/// 这里直接从当前安装目录启动 `kabegame-plugin-editor.exe`，由安装脚本确保它与主程序在同一目录下。
#[tauri::command]
fn open_plugin_editor_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("获取当前可执行文件路径失败: {e}"))?
        .parent()
        .ok_or_else(|| "无法获取当前可执行文件目录".to_string())?
        .to_path_buf();

    let editor_exe = exe_dir.join("kabegame-plugin-editor.exe");
    if !editor_exe.exists() {
        return Err(format!(
            "找不到插件编辑器可执行文件：{}\n请确认安装包已将其复制到安装目录。",
            editor_exe.display()
        ));
    }

    app.shell()
        .command(editor_exe)
        .spawn()
        .map_err(|e| format!("启动插件编辑器进程失败: {e}"))?;

    Ok(())
}

/// 修复壁纸窗口 Z-order（供前端在最小化等事件时调用）
#[tauri::command]
fn fix_wallpaper_zorder(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        fix_wallpaper_window_zorder(&app);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// 壁纸窗口前端 ready 后调用，用于触发一次"推送当前壁纸到壁纸窗口"。
/// 解决壁纸窗口尚未注册事件监听时，后端先 emit 导致事件丢失的问题。
#[tauri::command]
#[cfg(target_os = "windows")]
fn wallpaper_window_ready(_app: tauri::AppHandle) -> Result<(), String> {
    // 标记窗口已完全初始化
    println!("壁纸窗口已就绪");
    WallpaperWindow::mark_ready();
    Ok(())
}

// Windows：将文件列表写入剪贴板为 CF_HDROP，便于原生应用粘贴/拖拽识别
#[cfg(target_os = "windows")]
#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("paths is empty".into());
    }

    // 构造双零结尾的 UTF-16 路径列表（以 '\0' 分隔，末尾再加 '\0'）
    let mut path_list = String::new();
    for (idx, p) in paths.iter().enumerate() {
        if idx > 0 {
            path_list.push('\0');
        }
        // 去掉 Windows 长路径前缀 \\?\
        let cleaned = p.trim_start_matches(r"\\?\");
        path_list.push_str(cleaned);
    }
    path_list.push('\0'); // 额外终止符

    let wide: Vec<u16> = path_list.encode_utf16().collect();
    let bytes_len = wide.len() * 2;
    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let total_size = dropfiles_size + bytes_len;

    unsafe {
        // GlobalAlloc 返回 HGLOBAL（指针），NULL 表示失败
        let h_global: *mut std::ffi::c_void = GlobalAlloc(GMEM_MOVEABLE, total_size);
        if h_global.is_null() {
            return Err("GlobalAlloc failed".into());
        }

        let ptr = GlobalLock(h_global);
        if ptr.is_null() {
            return Err("GlobalLock failed".into());
        }

        // 写入 DROPFILES
        let df_ptr = ptr as *mut DROPFILES;
        (*df_ptr).pFiles = dropfiles_size as u32;
        (*df_ptr).pt.x = 0;
        (*df_ptr).pt.y = 0;
        (*df_ptr).fNC = 0;
        (*df_ptr).fWide = 1; // UTF-16

        // 写入路径字符串
        let data_ptr = (ptr as usize + dropfiles_size) as *mut u8;
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, data_ptr, bytes_len);

        GlobalUnlock(h_global);

        if OpenClipboard(0) == 0 {
            return Err("OpenClipboard failed".into());
        }
        if EmptyClipboard() == 0 {
            let _ = CloseClipboard();
            return Err("EmptyClipboard failed".into());
        }

        // SetClipboardData 接管内存，不要释放 h_global
        let res = SetClipboardData(CF_HDROP_FORMAT, h_global as isize);
        if res == 0 {
            let _ = CloseClipboard();
            return Err("SetClipboardData failed".into());
        }

        CloseClipboard();
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn copy_files_to_clipboard(_paths: Vec<String>) -> Result<(), String> {
    Err("copy_files_to_clipboard is only supported on Windows".into())
}

// =========================
// Startup steps (split setup into small functions)
// =========================

fn startup_step_cleanup_user_data_if_marked(app: &tauri::AppHandle) -> bool {
    // 检查清理标记，如果存在则先清理旧数据目录
    let app_data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to resolve app data dir: {e}");
            return false;
        }
    };
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    let is_cleaning_data = cleanup_marker.exists();
    if is_cleaning_data {
        // 删除标记文件
        let _ = fs::remove_file(&cleanup_marker);
        // 尝试删除整个数据目录
        if app_data_dir.exists() {
            // 使用多次重试，因为文件可能还在被其他进程使用
            let mut retries = 5;
            while retries > 0 {
                match fs::remove_dir_all(&app_data_dir) {
                    Ok(_) => {
                        println!("成功清理应用数据目录");
                        break;
                    }
                    Err(e) => {
                        retries -= 1;
                        if retries == 0 {
                            eprintln!("警告：无法完全清理数据目录，部分文件可能仍在使用中: {}", e);
                            // 尝试删除单个文件而不是整个目录
                            // 至少删除数据库和设置文件
                            let _ = fs::remove_file(app_data_dir.join("images.db"));
                            let _ = fs::remove_file(app_data_dir.join("settings.json"));
                            let _ = fs::remove_file(app_data_dir.join("plugins.json"));
                        } else {
                            // 等待一段时间后重试
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                    }
                }
            }
        }
    }
    is_cleaning_data
}

#[cfg(feature = "local-backend")]
fn startup_step_manage_plugin_manager(app: &mut tauri::App) {
    // 初始化插件管理器
    let plugin_manager = PluginManager::new();
    app.manage(plugin_manager);

    // 每次启动：异步覆盖复制内置插件到用户插件目录（确保可用性/不变性）
    let app_handle_plugins = app.app_handle().clone();
    std::thread::spawn(move || {
        let pm = app_handle_plugins.state::<PluginManager>();
        if let Err(e) = pm.ensure_prepackaged_plugins_installed() {
            eprintln!("[WARN] 启动时安装内置插件失败: {}", e);
        }
        // 内置插件复制完成后，初始化/刷新一次已安装插件缓存（减少后续频繁读盘）
        let _ = pm.refresh_installed_plugins_cache();
    });
}

#[cfg(feature = "local-backend")]
fn startup_step_manage_storage(app: &mut tauri::App) -> Result<(), String> {
    // 初始化存储管理器
    let storage = Storage::new();
    storage
        .init()
        .map_err(|e| format!("Failed to initialize storage: {}", e))?;
    // 应用启动时清理所有临时文件
    match storage.cleanup_temp_files() {
        Ok(count) => {
            if count > 0 {
                println!("启动时清理了 {} 个临时文件", count);
            }
        }
        Err(e) => {
            eprintln!("清理临时文件失败: {}", e);
        }
    }
    app.manage(storage);
    Ok(())
}

#[cfg(feature = "local-backend")]
fn startup_step_manage_provider_runtime(app: &mut tauri::App) {
    let mut cfg = kabegame_core::providers::ProviderCacheConfig::default();
    // 可选覆盖 RocksDB 目录
    if let Ok(dir) = std::env::var("KABEGAME_PROVIDER_DB_DIR") {
        cfg.db_dir = std::path::PathBuf::from(dir);
    }
    let rt = match kabegame_core::providers::ProviderRuntime::new(cfg) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[providers] init ProviderRuntime failed, fallback to default cfg: {}",
                e
            );
            kabegame_core::providers::ProviderRuntime::new(
                kabegame_core::providers::ProviderCacheConfig::default(),
            )
            .expect("ProviderRuntime fallback init failed")
        }
    };
    app.manage(rt);
}

#[cfg(feature = "local-backend")]
fn startup_step_warm_provider_cache(app: &tauri::AppHandle) {
    // Provider 树缓存 warm：后台执行，失败只记录 warning（不阻塞启动）
    let app_handle = app.clone();
    let storage = app_handle.state::<Storage>().inner().clone();
    tauri::async_runtime::spawn(async move {
        // 给启动留一点时间（避免与大量 IO 初始化竞争）
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;

        // NOTE: 这里直接从 AppHandle 取 state（AppHandle 是 Send+Sync，可跨线程使用）
        let rt = app_handle.state::<kabegame_core::providers::ProviderRuntime>();
        let root = std::sync::Arc::new(kabegame_core::providers::RootProvider::default())
            as std::sync::Arc<dyn kabegame_core::providers::provider::Provider>;
        match rt.warm_cache(&storage, root) {
            Ok(_root_desc) => println!("[providers] warm cache ok"),
            Err(e) => eprintln!("[providers] warm cache failed: {}", e),
        }
    });
}

#[cfg(feature = "virtual-drive")]
fn startup_step_manage_virtual_drive_service(_app: &mut tauri::App) {
    // Windows：虚拟盘服务（Dokan）
    #[cfg(target_os = "windows")]
    {
        use tauri::Listener;
        use tauri::Manager;

        app.manage(VirtualDriveService::default());

        // 通过后端事件监听把“数据变更”转成“Explorer 刷新”，避免 core 直接依赖 VD。
        let app_handle = app.app_handle().clone();
        // 1) 画册内容变更：刷新对应画册目录
        let app_handle_album_images = app_handle.clone();
        let _album_images_listener = app_handle.listen("album-images-changed", move |event| {
            let payload = event.payload();
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                return;
            };
            let Some(album_id) = v.get("albumId").and_then(|x| x.as_str()) else {
                return;
            };
            let drive = app_handle_album_images.state::<VirtualDriveService>();
            let storage = app_handle_album_images.state::<Storage>();
            drive.notify_album_dir_changed(storage.inner(), album_id);
        });

        // 2) 画册列表变更：刷新画册子树（新增/删除/重命名等）
        let app_handle_albums = app_handle.clone();
        let _albums_listener = app_handle.listen("albums-changed", move |_event: tauri::Event| {
            let drive = app_handle_albums.state::<VirtualDriveService>();
            drive.bump_albums();
        });

        // 3) 任务列表变更：刷新按任务子树（删除任务等）
        let app_handle_tasks = app_handle.clone();
        let _tasks_listener = app_handle.listen("tasks-changed", move |_event: tauri::Event| {
            let drive = app_handle_tasks.state::<VirtualDriveService>();
            drive.bump_tasks();
        });

        // 4) 任务运行中新增图片：刷新“按任务”根目录 + 对应任务目录（Explorer 正在浏览该目录时可见更新）
        let app_handle_task_images = app_handle.clone();
        let _task_images_listener = app_handle.listen("image-added", move |event: tauri::Event| {
            let payload = event.payload();
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                return;
            };
            let Some(task_id) = v.get("taskId").and_then(|x| x.as_str()) else {
                return;
            };
            let task_id = task_id.trim();
            if task_id.is_empty() {
                return;
            }
            let drive = app_handle_task_images.state::<VirtualDriveService>();
            let storage = app_handle_task_images.state::<Storage>();
            drive.notify_task_dir_changed(storage.inner(), task_id);
            drive.notify_gallery_tree_changed();
        });
    }
}

#[cfg(feature = "local-backend")]
fn startup_step_manage_settings(app: &mut tauri::App) {
    // 初始化设置管理器
    let settings = Settings::new();
    app.manage(settings);
}

#[cfg(feature = "virtual-drive")]
fn startup_step_auto_mount_album_drive(app: &tauri::AppHandle) {
    // 按设置自动挂载画册盘（不自动弹出 Explorer）
    // 注意：挂载操作可能耗时（尤其是首次挂载或 Dokan 驱动初始化），放到后台线程避免阻塞启动
    let settings = app.state::<Settings>().get_settings().ok();
    if let Some(s) = settings {
        if s.album_drive_enabled {
            let mount_point = s.album_drive_mount_point.clone();
            let storage = app.state::<Storage>().inner().clone();
            let app_handle = app.clone();

            // 在后台线程中执行挂载，避免阻塞主线程
            tauri::async_runtime::spawn(async move {
                // 稍等片刻确保所有服务已初始化完成
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                let drive = app_handle.state::<VirtualDriveService>();
                match drive.mount(&mount_point, storage, app_handle.clone()) {
                    Ok(_) => {
                        println!("启动时自动挂载画册盘成功: {}", mount_point);
                    }
                    Err(e) => {
                        eprintln!("启动时自动挂载画册盘失败: {} (挂载点: {})", e, mount_point);
                    }
                }
            });
        }
    }
}

fn startup_step_restore_main_window_state(app: &tauri::AppHandle, is_cleaning_data: bool) {
    // 不恢复 window_state：用户要求每次居中弹出
    if is_cleaning_data {
        return;
    }
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.center();
    }
}

fn startup_step_manage_wallpaper_components(app: &mut tauri::App) {
    // 初始化全局壁纸控制器（基础 manager）
    let wallpaper_controller = WallpaperController::new(app.app_handle().clone());
    app.manage(wallpaper_controller);

    // 初始化壁纸轮播器
    let rotator = WallpaperRotator::new(app.app_handle().clone());
    app.manage(rotator);

    // 创建壁纸窗口（用于窗口模式）
    #[cfg(target_os = "windows")]
    {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(
            app,
            "wallpaper",
            // 使用独立的 wallpaper.html，只渲染 WallpaperLayer 组件
            WebviewUrl::App("wallpaper.html".into()),
        )
        // 给壁纸窗口一个固定标题，便于脚本/调试定位到正确窗口
        .title("Kabegame Wallpaper")
        .fullscreen(true)
        .decorations(false)
        // 设置窗口为透明，背景为透明
        .transparent(true)
        .visible(false)
        .skip_taskbar(true)
        .build();
    }

    // 创建系统托盘（使用 Tauri 2.0 内置 API）
    tray::setup_tray(app.app_handle().clone());

    // 初始化壁纸控制器，然后根据设置决定是否启动轮播
    // 注意：不要在 Tokio runtime 内再 `block_on`（会触发 “Cannot start a runtime from within a runtime”）
    let app_handle = app.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await; // 延迟启动，确保应用完全初始化

        // 初始化壁纸控制器（如创建窗口等）
        let controller = app_handle.state::<WallpaperController>();
        if let Err(e) = controller.init().await {
            eprintln!("初始化壁纸控制器失败: {}", e);
        }

        println!("初始化壁纸控制器完成");

        // 启动时：按规则恢复/回退“当前壁纸”
        if let Err(e) = init_wallpaper_on_startup(&app_handle).await {
            eprintln!("启动时初始化壁纸失败: {}", e);
        }

        // 初始化完成后：若轮播仍启用，则启动轮播线程
        if let Ok(v) = daemon_client::get_ipc_client().settings_get().await {
            if v.get("wallpaperRotationEnabled")
                .and_then(|x| x.as_bool())
                .unwrap_or(false)
            {
                let rotator = app_handle.state::<WallpaperRotator>();
                if let Err(e) = rotator.start() {
                    eprintln!("启动壁纸轮播失败: {}", e);
                }
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let is_cleaning_data = startup_step_cleanup_user_data_if_marked(app.app_handle());
            #[cfg(feature = "local-backend")]
            startup_step_manage_plugin_manager(app);
            #[cfg(feature = "local-backend")]
            startup_step_manage_storage(app)?;
            #[cfg(feature = "virtual-drive")]
            startup_step_manage_virtual_drive_service(app);
            #[cfg(feature = "local-backend")]
            startup_step_manage_provider_runtime(app);
            #[cfg(feature = "local-backend")]
            startup_step_manage_settings(app);
            #[cfg(feature = "local-backend")]
            startup_step_warm_provider_cache(app.app_handle());
            #[cfg(feature = "virtual-drive")]
            startup_step_auto_mount_album_drive(app.app_handle());
            #[cfg(feature = "local-backend")]
            {
                // 本地 dedupe manager 已被 daemon-side DedupeService 替代
            }
            startup_step_restore_main_window_state(app.app_handle(), is_cleaning_data);
            startup_step_manage_wallpaper_components(app);

            // 启动事件监听器（从 daemon 轮询事件并转发到前端）
            let app_handle_for_events = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                event_listeners::init_event_listeners(app_handle_for_events).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ========== Daemon IPC 命令（需要 daemon 运行）==========
            check_daemon_status,
            get_images,
            get_images_paginated,
            get_albums,
            add_album,
            delete_album,
            get_all_tasks,
            get_task,
            add_task,
            update_task,
            delete_task,
            // ========== 仍保留的本地命令（非 daemon 范围）==========
            confirm_task_rhai_dump,
            clear_finished_tasks,
            get_task_images,
            get_task_images_paginated,
            get_task_image_ids,
            get_task_failed_images,
            // retry_task_failed_image（本地下载队列）已迁移到 daemon
            // 原有命令
            get_plugins,
            refresh_installed_plugins_cache,
            refresh_installed_plugin_cache,
            get_build_mode,
            delete_plugin,
            // crawl_images_command（本地任务调度）已迁移到 daemon
            get_images_range,
            browse_gallery_provider,
            get_image_by_id,
            rename_album,
            add_images_to_album,
            remove_images_from_album,
            get_album_images,
            get_album_image_ids,
            get_album_preview,
            get_album_counts,
            // Windows 虚拟盘
            #[cfg(feature = "virtual-drive")]
            mount_virtual_drive,
            #[cfg(feature = "virtual-drive")]
            unmount_virtual_drive,
            #[cfg(feature = "virtual-drive")]
            mount_virtual_drive_and_open_explorer,
            // TODO: 跨平台实现
            #[cfg(target_os = "windows")]
            open_explorer,
            get_images_count,
            delete_image,
            remove_image,
            batch_delete_images,
            batch_remove_images,
            // start/cancel_dedupe_*（本地去重）已迁移到 daemon
            toggle_image_favorite,
            update_album_images_order,
            open_file_path,
            open_file_folder,
            set_wallpaper,
            set_wallpaper_by_image_id,
            get_current_wallpaper_image_id,
            clear_current_wallpaper_image_id,
            get_image_local_path_by_id,
            get_current_wallpaper_path,
            #[cfg(feature = "local-backend")]
            migrate_images_from_json,
            get_browser_plugins,
            get_plugin_sources,
            save_plugin_sources,
            get_store_plugins,
            get_plugin_detail,
            validate_plugin_source,
            preview_import_plugin,
            preview_store_install,
            import_plugin_from_zip,
            install_browser_plugin,
            get_plugin_image,
            get_plugin_image_for_detail,
            get_plugin_icon,
            get_remote_plugin_icon,
            get_gallery_image,
            get_plugin_vars,
            get_settings,
            get_setting,
            get_favorite_album_id,
            set_auto_launch,
            #[cfg(feature = "virtual-drive")]
            set_album_drive_enabled,
            #[cfg(feature = "virtual-drive")]
            set_album_drive_mount_point,
            set_max_concurrent_downloads,
            set_network_retry_count,
            set_image_click_action,
            set_gallery_image_aspect_ratio_match_window,
            set_gallery_image_aspect_ratio,
            get_desktop_resolution,
            start_task,
            set_auto_deduplicate,
            set_default_download_dir,
            set_wallpaper_engine_dir,
            get_wallpaper_engine_myprojects_dir,
            #[cfg(feature = "local-backend")]
            get_default_images_dir,
            get_active_downloads,
            add_run_config,
            update_run_config,
            get_run_configs,
            delete_run_config,
            cancel_task,
            copy_files_to_clipboard,
            #[cfg(target_os = "windows")]
            set_wallpaper_rotation_enabled,
            set_wallpaper_rotation_album_id,
            start_wallpaper_rotation,
            set_wallpaper_rotation_interval_minutes,
            set_wallpaper_rotation_mode,
            set_wallpaper_style,
            set_wallpaper_rotation_transition,
            set_wallpaper_mode,
            get_wallpaper_rotator_status,
            get_native_wallpaper_styles,
            #[cfg(target_os = "windows")]
            wallpaper_window_ready,
            set_main_sidebar_dwm_blur,
            hide_main_window,
            open_plugin_editor_window,
            fix_wallpaper_zorder,
            // Wallpaper Engine 导出
            #[cfg(target_os = "windows")]
            export_album_to_we_project,
            #[cfg(target_os = "windows")]
            export_images_to_we_project,
            clear_user_data,
            // Debug: 生成大量测试图片数据
            // 注意：debug_clone_images 依赖本地 storage 扩展（已迁移期移除）
        ])
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            // 监听窗口关闭事件
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // 阻止默认关闭行为
                    api.prevent_close();
                    // 不保存 window_state：用户要求每次居中弹出

                    // 隐藏主窗口（直接隐藏，不关闭）
                    if let Err(e) = window.hide() {
                        eprintln!("隐藏主窗口失败: {}", e);
                    } else {
                        // 隐藏主窗口后，修复壁纸窗口的 Z-order（防止壁纸窗口覆盖桌面图标）
                        #[cfg(target_os = "windows")]
                        {
                            fix_wallpaper_window_zorder(window.app_handle());
                        }
                    }
                } else if window.label().starts_with("wallpaper") {
                    api.prevent_close();
                } else if window.label() == "plugin-editor" {
                    // 插件编辑器窗口：阻止销毁，只隐藏
                    // 避免重新打开时需要动态创建窗口导致 Monaco editor 初始化问题
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
