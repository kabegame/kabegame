// 虚拟磁盘相关命令

#[cfg(feature = "virtual-drive")]
use crate::storage::Storage;
#[cfg(feature = "virtual-drive")]
use crate::virtual_drive::{drive_service::VirtualDriveServiceTrait, VirtualDriveService};

#[cfg(feature = "virtual-drive")]
#[tauri::command]
pub fn mount_virtual_drive(
    app: tauri::AppHandle,
    mount_point: String,
    storage: tauri::State<Storage>,
    drive: tauri::State<VirtualDriveService>,
) -> Result<(), String> {
    drive.mount(&mount_point, storage.inner().clone(), app)
}

#[cfg(feature = "virtual-drive")]
#[tauri::command]
pub fn unmount_virtual_drive(
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

        let mp_norm = crate::virtual_drive::drive_service::normalize_mount_point(mp)?;

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
                        "已请求管理员权限启动 VD daemon，但 IPC 未就绪。\n\n如果找不到日志文件，说明 daemon 大概率没有启动成功：\n- 日志路径：{}\n\n下一步建议：\n1) 让用户打开任务管理器-详细信息，确认是否存在 kabegame-cli.exe / kabegame-cliw.exe；\n2) 让用户以管理员手动运行：kabegame-cli.exe vd daemon（看是否立即退出/是否生成日志）；\n3) 如果有杀软/企业策略，检查是否拦截了新进程/命名管道。\n\n原始错误：{}",
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
pub fn mount_virtual_drive_and_open_explorer(
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

                let mp_norm = crate::virtual_drive::drive_service::normalize_mount_point(&mount_point)?;

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
