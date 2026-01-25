//! Windows 特定的服务器实现

use std::sync::Arc;

use crate::ipc::ipc::{encode_frame, read_one_frame, windows_pipe_name, write_all};
use crate::ipc::{CliIpcRequest, CliIpcResponse};
use crate::ipc_dbg;
use tokio::io::split;
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
use tokio::time::{timeout, Duration};
use uuid;
use windows_sys::Win32::Foundation::{LocalFree, BOOL};
use windows_sys::Win32::Security::{
    Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
};

use super::connection_handler;
use super::SubscriptionManager;

/// 检查是否有其他 daemon 正在运行
pub async fn check_other_daemon_running() -> bool {
    // 尝试连接现有的命名管道
    let client_result = timeout(Duration::from_millis(100), async {
        ClientOptions::new().open(windows_pipe_name()).ok()
    })
    .await;

    if let Ok(Some(mut client)) = client_result {
        // 如果连接成功，尝试发送 Status 请求验证
        let status_req = CliIpcRequest::Status;
        if let Ok(bytes) = encode_frame(&status_req) {
            if write_all(&mut client, &bytes).await.is_ok() {
                // 尝试读取响应（但不等待太久）
                if timeout(Duration::from_millis(100), read_one_frame(&mut client))
                    .await
                    .is_ok()
                {
                    return true; // 成功连接并得到响应，说明有其他 daemon 在运行
                }
            }
        }
    }
    false
}

fn sddl_to_security_attributes(
    sddl: &str,
) -> Result<(SECURITY_ATTRIBUTES, *mut core::ffi::c_void), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let sddl_w: Vec<u16> = OsStr::new(sddl).encode_wide().chain(Some(0)).collect();
    let mut sd_ptr: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut sd_len: u32 = 0;

    let ok: BOOL = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_w.as_ptr(),
            1,
            &mut sd_ptr as *mut _ as *mut _,
            &mut sd_len,
        )
    };
    if ok == 0 || sd_ptr.is_null() {
        return Err(format!(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let attrs = SECURITY_ATTRIBUTES {
        nLength: core::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd_ptr as *mut _,
        bInheritHandle: 0,
    };
    Ok((attrs, sd_ptr))
}

fn create_secure_server() -> Result<NamedPipeServer, String> {
    // SY=LocalSystem, BA=Built-in Administrators, AU=Authenticated Users
    // 允许普通用户连接（仅本机 pipe）
    let sddl = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)";
    let (attrs, sd_ptr) = sddl_to_security_attributes(sddl)?;
    let server = unsafe {
        ServerOptions::new()
            .create_with_security_attributes_raw(windows_pipe_name(), &attrs as *const _ as *mut _)
    }
    .map_err(|e| format!("ipc create pipe failed: {}", e))?;
    eprintln!("[DEBUG] IPC 服务器创建命名管道成功 {}", windows_pipe_name());
    unsafe { LocalFree(sd_ptr as _) };
    Ok(server)
}

/// Windows 平台的服务实现
pub async fn serve<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    // 绑定命名管道
    let mut server = match create_secure_server() {
        Ok(s) => s,
        Err(e) => {
            // 绑定失败，检查是否有其他 daemon 正在运行
            if check_other_daemon_running().await {
                eprintln!(
                    "错误: 无法绑定命名管道 {}，因为已有其他 daemon 正在运行。",
                    windows_pipe_name()
                );
                eprintln!("请先停止正在运行的 daemon，或确保只有一个 daemon 实例。");
                return Err(format!("另一个 daemon 实例正在运行: {}", e));
            }
            // 如果没有其他 daemon 运行，可能是其他原因导致的绑定失败
            return Err(format!("无法创建命名管道: {}", e));
        }
    };

    loop {
        server
            .connect()
            .await
            .map_err(|e| format!("ipc pipe connect failed: {}", e))?;

        let connected = server;
        server = create_secure_server()?;

        ipc_dbg!("[DEBUG] IPC 服务器接受新连接（持久连接模式）");

        // 为每个连接 spawn 一个任务来处理多个请求
        let handler = handler.clone();
        let broadcaster = broadcaster.clone();
        let subscription_manager = subscription_manager.clone();

        // 为每个连接生成唯一的 client_id
        let client_id = uuid::Uuid::new_v4().to_string();

        tokio::spawn(async move {
            // 分离读写端，允许并发读写
            let (read_half, write_half) = split(connected);

            connection_handler::handle_connection(
                read_half,
                write_half,
                handler,
                broadcaster,
                subscription_manager,
                client_id,
            )
            .await;

            eprintln!("[DEBUG] IPC 服务器连接处理完成");
        });
    }
}
