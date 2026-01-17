//! IPC 服务器端连接处理
//! 
//! 支持持久连接模式：
//! - 每个连接支持多个请求-响应
//! - 在响应中携带 request_id

use super::ipc::{CliIpcRequest, CliIpcResponse, encode_line, decode_line, read_one_line, write_all};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 处理单个连接（支持多个请求-响应）
pub async fn handle_connection<F, Fut, S>(
    mut stream: S,
    handler: Arc<F>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    eprintln!("[DEBUG] IPC 服务器接受新连接（持久连接模式）");
    
    loop {
        // 读取请求
        let line = match read_one_line(&mut stream).await {
            Ok(line) => line,
            Err(e) => {
                eprintln!("[DEBUG] IPC 服务器读取请求失败: {}, 关闭连接", e);
                break;
            }
        };
        
        eprintln!("[DEBUG] IPC 服务器读取请求成功: {}", line);
        
        // 解析为 JSON
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[DEBUG] IPC 服务器解析 JSON 失败: {}", e);
                continue;
            }
        };
        
        // 提取 request_id（如果有）
        let request_id = value.get("request_id").and_then(|v| v.as_u64());
        
        // 解析为 CliIpcRequest
        let req: CliIpcRequest = match serde_json::from_value(value.clone()) {
            Ok(req) => {
                eprintln!("[DEBUG] IPC 服务器解析请求成功: {:?}, request_id={:?}", req, request_id);
                req
            },
            Err(e) => {
                eprintln!("[DEBUG] IPC 服务器解析请求失败: {}", e);
                continue;
            }
        };
        
        // 处理请求
        let mut resp = handler(req).await;
        resp.request_id = request_id;
        
        // 发送响应
        let bytes = match encode_line(&resp) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                continue;
            }
        };
        
        if let Err(e) = write_all(&mut stream, &bytes).await {
            eprintln!("[DEBUG] IPC 服务器写入响应失败: {}, 关闭连接", e);
            break;
        }
        
        eprintln!("[DEBUG] IPC 服务器已发送响应, request_id={:?}", request_id);
    }
    
    eprintln!("[DEBUG] IPC 服务器连接已关闭");
    Ok(())
}
