//! 虚拟盘 IPC（跨平台）：用于主进程（非管理员）与提权 helper（管理员）通信。
//!
//! 设计目标：
//! - Windows：命名管道（\\.\pipe\...）
//! - Unix：使用 Unix domain socket 作为等价的“命名管道”通道
//! - 协议：单行 JSON（request/response 各一行），便于复用同一套解析/序列化逻辑

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum VdIpcRequest {
    Mount { mount_point: String },
    Unmount { mount_point: String },
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdIpcResponse {
    pub ok: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub mounted: Option<bool>,
    #[serde(default)]
    pub mount_point: Option<String>,
}

impl VdIpcResponse {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            mounted: None,
            mount_point: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            mounted: None,
            mount_point: None,
        }
    }
}

fn encode_line<T: Serialize>(v: &T) -> Result<Vec<u8>, String> {
    let mut s = serde_json::to_string(v).map_err(|e| format!("ipc json encode failed: {}", e))?;
    s.push('\n');
    Ok(s.into_bytes())
}

fn decode_line<T: for<'de> Deserialize<'de>>(line: &str) -> Result<T, String> {
    serde_json::from_str(line).map_err(|e| format!("ipc json decode failed: {}", e))
}

async fn read_one_line<R>(mut r: R) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1];
    loop {
        let n = r
            .read(&mut tmp)
            .await
            .map_err(|e| format!("ipc read failed: {}", e))?;
        if n == 0 {
            break;
        }
        if tmp[0] == b'\n' {
            break;
        }
        buf.push(tmp[0]);
        // 防御：避免无限增长
        if buf.len() > 256 * 1024 {
            return Err("ipc line too long".to_string());
        }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

async fn write_all<W>(mut w: W, bytes: &[u8]) -> Result<(), String>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    w.write_all(bytes)
        .await
        .map_err(|e| format!("ipc write failed: {}", e))?;
    w.flush()
        .await
        .map_err(|e| format!("ipc flush failed: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_pipe_name() -> &'static str {
    r"\\.\pipe\kabegame-vd"
}

#[cfg(not(target_os = "windows"))]
fn unix_socket_path() -> std::path::PathBuf {
    // 放在系统临时目录：不需要额外权限；daemon 退出后文件可清理。
    std::env::temp_dir().join("kabegame-vd.sock")
}

/// 客户端：发送一次请求并等待响应。
pub async fn request(req: VdIpcRequest) -> Result<VdIpcResponse, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        let mut client = ClientOptions::new()
            .open(windows_pipe_name())
            .map_err(|e| format!("ipc open pipe failed: {}", e))?;

        let bytes = encode_line(&req)?;
        write_all(&mut client, &bytes).await?;
        let line = read_one_line(&mut client).await?;
        let resp: VdIpcResponse = decode_line(&line)?;
        return Ok(resp);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tokio::net::UnixStream;
        let path = unix_socket_path();
        let mut s = UnixStream::connect(&path)
            .await
            .map_err(|e| format!("ipc connect failed ({}): {}", path.display(), e))?;
        let bytes = encode_line(&req)?;
        write_all(&mut s, &bytes).await?;
        let line = read_one_line(&mut s).await?;
        let resp: VdIpcResponse = decode_line(&line)?;
        return Ok(resp);
    }
}

/// 服务端：循环处理请求。
///
/// - 每个连接只处理一次 request/response，然后关闭。
/// - handler 返回 response（包含 ok/错误信息等）。
pub async fn serve<F, Fut>(handler: F) -> Result<(), String>
where
    F: Fn(VdIpcRequest) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = VdIpcResponse> + Send,
{
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        use windows_sys::Win32::Foundation::{LocalFree, BOOL};
        use windows_sys::Win32::Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        };

        fn sddl_to_security_attributes(
            sddl: &str,
        ) -> Result<(SECURITY_ATTRIBUTES, *mut core::ffi::c_void), String> {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;

            let sddl_w: Vec<u16> = OsStr::new(sddl).encode_wide().chain(Some(0)).collect();
            let mut sd_ptr: *mut core::ffi::c_void = core::ptr::null_mut();
            let mut sd_len: u32 = 0;

            // SAFETY: windows api contract
            let ok: BOOL = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl_w.as_ptr(),
                    1, // SDDL_REVISION_1
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

        fn create_secure_server() -> Result<tokio::net::windows::named_pipe::NamedPipeServer, String>
        {
            // 允许普通用户进程连接管理员创建的 pipe（避免 Win10 上 os error 5）。
            // SY=LocalSystem, BA=Built-in Administrators, AU=Authenticated Users
            // 这里给 AU 也授予 GA，简化权限兼容性（仅本机 pipe，且默认 reject_remote_clients=true）。
            let sddl = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)";
            let (attrs, sd_ptr) = sddl_to_security_attributes(sddl)?;
            let server = unsafe {
                ServerOptions::new().create_with_security_attributes_raw(
                    windows_pipe_name(),
                    &attrs as *const _ as *mut _,
                )
            }
            .map_err(|e| format!("ipc create pipe failed: {}", e))?;

            // SAFETY: ConvertString... allocates with LocalAlloc; must free with LocalFree.
            unsafe { LocalFree(sd_ptr as _) };
            Ok(server)
        }

        // 按 tokio 文档建议：始终保持至少一个 server instance 可用，避免客户端偶发 NotFound。
        let mut server = create_secure_server()?;
        loop {
            server
                .connect()
                .await
                .map_err(|e| format!("ipc pipe connect failed: {}", e))?;

            // 在处理已连接 client 之前，先准备下一个 server instance
            let connected = server;
            server = create_secure_server()?;

            let mut connected = connected;
            let line = read_one_line(&mut connected).await?;
            let req: VdIpcRequest = decode_line(&line)?;
            let resp = handler(req).await;
            let bytes = encode_line(&resp)?;
            let _ = write_all(&mut connected, &bytes).await;
            // drop connected -> disconnect
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tokio::net::UnixListener;
        let path = unix_socket_path();
        // 如果已存在旧 socket 文件，先删掉（daemon 崩溃/异常退出时常见）
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)
            .map_err(|e| format!("ipc bind failed ({}): {}", path.display(), e))?;

        loop {
            let (mut s, _) = listener
                .accept()
                .await
                .map_err(|e| format!("ipc accept failed: {}", e))?;
            let line = read_one_line(&mut s).await?;
            let req: VdIpcRequest = decode_line(&line)?;
            let resp = handler(req).await;
            let bytes = encode_line(&resp)?;
            let _ = write_all(&mut s, &bytes).await;
        }
    }
}
