//! IPC 持久连接管理
//! 
//! 实现客户端的持久连接复用机制：
//! - 维护单一长连接用于所有请求-响应
//! - 支持请求 ID 匹配
//! - 自动重连
//! - 并发请求支持
//! - 防止并发创建多个连接

use super::ipc::{CliIpcRequest, CliIpcResponse, encode_line};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock, mpsc, oneshot, watch};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// 请求响应状态
struct RequestState {
    /// 请求 ID 计数器
    next_request_id: u64,
    /// 等待响应的请求：request_id -> oneshot sender
    pending_requests: HashMap<u64, oneshot::Sender<CliIpcResponse>>,
}

/// 连接状态枚举
enum ConnectionStatus {
    /// 未连接
    Disconnected,
    /// 正在连接（其他请求应等待）
    Connecting,
    /// 已连接
    Connected(Arc<ConnectionHandle>),
}

/// 持久连接管理器
#[derive(Clone)]
pub struct PersistentConnection {
    /// 连接状态
    status: Arc<Mutex<ConnectionStatus>>,
    /// 连接就绪通知（用于等待连接完成）
    ready_notify: Arc<watch::Sender<Option<Result<Arc<ConnectionHandle>, String>>>>,
    ready_rx: watch::Receiver<Option<Result<Arc<ConnectionHandle>, String>>>,
    /// 请求响应状态
    request_state: Arc<Mutex<RequestState>>,
}

/// 连接句柄
struct ConnectionHandle {
    /// 发送请求的通道
    request_tx: mpsc::UnboundedSender<(u64, CliIpcRequest)>,
}

/// 连接就绪通知（内部使用）
type ConnReadyTx = oneshot::Sender<Result<(), String>>;
type ConnReadyRx = oneshot::Receiver<Result<(), String>>;

impl PersistentConnection {
    pub fn new() -> Self {
        let (ready_tx, ready_rx) = watch::channel(None);
        Self {
            status: Arc::new(Mutex::new(ConnectionStatus::Disconnected)),
            ready_notify: Arc::new(ready_tx),
            ready_rx,
            request_state: Arc::new(Mutex::new(RequestState {
                next_request_id: 1,
                pending_requests: HashMap::new(),
            })),
        }
    }

    /// 确保连接已建立（如果未连接则创建新连接，如果正在连接则等待）
    async fn ensure_connected(&self) -> Result<Arc<ConnectionHandle>, String> {
        loop {
            // 检查当前状态
            let should_connect = {
                let mut status = self.status.lock().await;
                match &*status {
                    ConnectionStatus::Connected(handle) => {
                        return Ok(handle.clone());
                    }
                    ConnectionStatus::Connecting => {
                        // 正在连接，需要等待
                        false
                    }
                    ConnectionStatus::Disconnected => {
                        // 标记为正在连接，防止其他任务重复创建
                        *status = ConnectionStatus::Connecting;
                        true
                    }
                }
            };

            if should_connect {
                // 我们负责创建连接
                eprintln!("[DEBUG] PersistentConnection 创建新的持久连接");
                
                let (request_tx, request_rx) = mpsc::unbounded_channel();
                let (ready_tx, ready_rx) = oneshot::channel();
                let handle = Arc::new(ConnectionHandle { request_tx });
                
                // 启动后台任务
                let request_state = self.request_state.clone();
                let status = self.status.clone();
                let ready_notify = self.ready_notify.clone();
                let handle_for_task = handle.clone();
                
                tokio::spawn(async move {
                    Self::connection_task_inner(
                        request_rx, 
                        request_state, 
                        status, 
                        ready_notify,
                        ready_tx, 
                        handle_for_task
                    ).await;
                });
                
                // 等待连接结果
                match ready_rx.await {
                    Ok(Ok(())) => {
                        eprintln!("[DEBUG] PersistentConnection 连接已就绪");
                        return Ok(handle);
                    }
                    Ok(Err(e)) => {
                        eprintln!("[ERROR] PersistentConnection 连接失败: {}", e);
                        return Err(e);
                    }
                    Err(_) => {
                        eprintln!("[ERROR] PersistentConnection 连接任务意外终止");
                        return Err("连接任务意外终止".to_string());
                    }
                }
            } else {
                // 等待连接完成
                let mut rx = self.ready_rx.clone();
                
                // 等待通知
                loop {
                    rx.changed().await.map_err(|_| "连接通知通道关闭".to_string())?;
                    
                    if let Some(result) = rx.borrow().as_ref() {
                        match result {
                            Ok(handle) => return Ok(handle.clone()),
                            Err(e) => return Err(e.clone()),
                        }
                    }
                }
            }
        }
    }

    /// 连接处理任务内部实现 - Unix
    #[cfg(not(target_os = "windows"))]
    async fn connection_task_inner(
        mut request_rx: mpsc::UnboundedReceiver<(u64, CliIpcRequest)>,
        request_state: Arc<Mutex<RequestState>>,
        status: Arc<Mutex<ConnectionStatus>>,
        ready_notify: Arc<watch::Sender<Option<Result<Arc<ConnectionHandle>, String>>>>,
        ready_tx: ConnReadyTx,
        handle: Arc<ConnectionHandle>,
    ) {
        use tokio::net::UnixStream;
        use tokio::io::split;
        use super::ipc::unix_socket_path;
        use std::time::Duration;
        
        let path = unix_socket_path();
        
        // 尝试连接，如果失败则等待 daemon 启动
        let stream = match Self::connect_with_retry_unix(&path).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ERROR] PersistentConnection 连接失败 ({}): {}", path.display(), e);
                // 重置状态为未连接
                *status.lock().await = ConnectionStatus::Disconnected;
                // 通知等待者连接失败
                let _ = ready_notify.send(Some(Err(e.clone())));
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        eprintln!("[DEBUG] PersistentConnection 持久连接已建立 (Unix)");
        
        // 连接成功，更新状态
        *status.lock().await = ConnectionStatus::Connected(handle.clone());
        
        // 通知所有等待者连接成功
        let _ = ready_notify.send(Some(Ok(handle.clone())));
        
        // 通知发起者连接就绪
        let _ = ready_tx.send(Ok(()));

        // 使用 split 分离读写端
        let (read_half, mut write_half) = split(stream);

        // 启动读取任务
        let state_clone = request_state.clone();
        let read_task = tokio::spawn(Self::read_task_unix(read_half, state_clone));

        // 写入任务（处理请求队列）
        while let Some((request_id, req)) = request_rx.recv().await {
            if let Err(e) = Self::send_request_unix(&mut write_half, request_id, req).await {
                eprintln!("[ERROR] PersistentConnection 发送请求失败: {}, 关闭连接", e);
                break;
            }
        }

        // 连接断开，清理
        read_task.abort();
        *status.lock().await = ConnectionStatus::Disconnected;
        // 清除通知，允许重新连接
        let _ = ready_notify.send(None);
        eprintln!("[DEBUG] PersistentConnection 连接已关闭");
    }

    /// 连接处理任务内部实现 - Windows
    #[cfg(target_os = "windows")]
    async fn connection_task_inner(
        mut request_rx: mpsc::UnboundedReceiver<(u64, CliIpcRequest)>,
        request_state: Arc<Mutex<RequestState>>,
        status: Arc<Mutex<ConnectionStatus>>,
        ready_notify: Arc<watch::Sender<Option<Result<Arc<ConnectionHandle>, String>>>>,
        ready_tx: ConnReadyTx,
        handle: Arc<ConnectionHandle>,
    ) {
        use tokio::net::windows::named_pipe::ClientOptions;
        use super::ipc::windows_pipe_name;
        
        // 尝试连接，如果失败则等待 daemon 启动
        let client = match Self::connect_with_retry_windows().await {
            Ok(c) => Arc::new(tokio::sync::Mutex::new(c)),
            Err(e) => {
                eprintln!("[ERROR] PersistentConnection 连接失败: {}", e);
                // 重置状态为未连接
                *status.lock().await = ConnectionStatus::Disconnected;
                // 通知等待者连接失败
                let _ = ready_notify.send(Some(Err(e.clone())));
                let _ = ready_tx.send(Err(e));
                return;
            }
        };

        eprintln!("[DEBUG] PersistentConnection 持久连接已建立 (Windows)");
        
        // 连接成功，更新状态
        *status.lock().await = ConnectionStatus::Connected(handle.clone());
        
        // 通知所有等待者连接成功
        let _ = ready_notify.send(Some(Ok(handle.clone())));
        
        // 通知发起者连接就绪
        let _ = ready_tx.send(Ok(()));

        // 启动读取任务（使用 Arc 共享连接）
        let state_clone = request_state.clone();
        let read_client = client.clone();
        let read_task = tokio::spawn(Self::read_task_windows(read_client, state_clone));

        // 写入任务（处理请求队列）
        while let Some((request_id, req)) = request_rx.recv().await {
            if let Err(e) = Self::send_request_windows(&client, request_id, req).await {
                eprintln!("[ERROR] PersistentConnection 发送请求失败: {}, 关闭连接", e);
                break;
            }
        }

        // 连接断开，清理
        read_task.abort();
        *status.lock().await = ConnectionStatus::Disconnected;
        // 清除通知，允许重新连接
        let _ = ready_notify.send(None);
        eprintln!("[DEBUG] PersistentConnection 连接已关闭");
    }

    /// 发送请求 - Unix
    #[cfg(not(target_os = "windows"))]
    async fn send_request_unix(
        write_half: &mut tokio::io::WriteHalf<tokio::net::UnixStream>,
        request_id: u64,
        req: CliIpcRequest,
    ) -> Result<(), String> {
        let mut req_value = serde_json::to_value(&req)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        
        if let Some(obj) = req_value.as_object_mut() {
            obj.insert("request_id".to_string(), serde_json::Value::Number(request_id.into()));
        }

        let line = encode_line(&req_value)?;

        eprintln!("[DEBUG] PersistentConnection 发送请求 #{}: {:?}", request_id, req);

        write_half.write_all(&line).await
            .map_err(|e| format!("写入失败: {}", e))?;
        write_half.flush().await
            .map_err(|e| format!("刷新失败: {}", e))?;

        Ok(())
    }

    /// 发送请求 - Windows
    #[cfg(target_os = "windows")]
    async fn send_request_windows(
        client: &Arc<tokio::sync::Mutex<tokio::net::windows::named_pipe::NamedPipeClient>>,
        request_id: u64,
        req: CliIpcRequest,
    ) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        
        let mut req_value = serde_json::to_value(&req)
            .map_err(|e| format!("序列化请求失败: {}", e))?;
        
        if let Some(obj) = req_value.as_object_mut() {
            obj.insert("request_id".to_string(), serde_json::Value::Number(request_id.into()));
        }

        let line = encode_line(&req_value)?;

        eprintln!("[DEBUG] PersistentConnection 发送请求 #{}: {:?}", request_id, req);

        let mut guard = client.lock().await;
        guard.write_all(&line).await
            .map_err(|e| format!("写入失败: {}", e))?;
        guard.flush().await
            .map_err(|e| format!("刷新失败: {}", e))?;

        Ok(())
    }

    /// 读取任务 - Unix
    #[cfg(not(target_os = "windows"))]
    async fn read_task_unix(
        read_half: tokio::io::ReadHalf<tokio::net::UnixStream>,
        state: Arc<Mutex<RequestState>>,
    ) {
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    eprintln!("[DEBUG] PersistentConnection 连接关闭 (EOF)");
                    break;
                }
                Ok(_) => {
                    // 去掉换行符
                    let line = line.trim_end();
                    if line.is_empty() {
                        continue;
                    }
                    
                    Self::process_response_line(line, &state).await;
                }
                Err(e) => {
                    eprintln!("[ERROR] PersistentConnection 读取失败: {}", e);
                    break;
                }
            }
        }
    }

    /// 读取任务 - Windows
    #[cfg(target_os = "windows")]
    async fn read_task_windows(
        client: Arc<tokio::sync::Mutex<tokio::net::windows::named_pipe::NamedPipeClient>>,
        state: Arc<Mutex<RequestState>>,
    ) {
        use tokio::io::AsyncReadExt;
        
        let mut line_buf = Vec::with_capacity(1024);
        loop {
            let mut tmp = [0u8; 1];
            let n = {
                let mut guard = client.lock().await;
                guard.read(&mut tmp).await
            };
            
            match n {
                Ok(0) => {
                    eprintln!("[DEBUG] PersistentConnection 连接关闭 (EOF)");
                    break;
                }
                Ok(_) => {
                    if tmp[0] == b'\n' {
                        let line = String::from_utf8_lossy(&line_buf).to_string();
                        line_buf.clear();
                        
                        Self::process_response_line(&line, &state).await;
                        continue;
                    }
                    line_buf.push(tmp[0]);
                    if line_buf.len() > 256 * 1024 {
                        eprintln!("[ERROR] PersistentConnection 行过长");
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[ERROR] PersistentConnection 读取失败: {}", e);
                    break;
                }
            }
        }
    }

    /// 处理响应行（共用逻辑）
    async fn process_response_line(line: &str, state: &Arc<Mutex<RequestState>>) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            // 提取 request_id
            if let Some(req_id) = value.get("requestId").and_then(|v| v.as_u64())
                .or_else(|| value.get("request_id").and_then(|v| v.as_u64()))
            {
                // 解析为响应
                if let Ok(resp) = serde_json::from_value::<CliIpcResponse>(value) {
                    eprintln!("[DEBUG] PersistentConnection 收到响应 #{}: ok={}", req_id, resp.ok);
                    
                    let mut state = state.lock().await;
                    if let Some(tx) = state.pending_requests.remove(&req_id) {
                        let _ = tx.send(resp);
                    }
                }
            } else {
                eprintln!("[WARN] PersistentConnection 收到无 request_id 的消息: {}", line);
            }
        } else {
            eprintln!("[WARN] PersistentConnection 收到无效 JSON: {}", line);
        }
    }

    /// 发送请求并等待响应
    pub async fn request(&self, req: CliIpcRequest) -> Result<CliIpcResponse, String> {
        // 确保连接已建立
        let conn = self.ensure_connected().await?;
        
        // 分配请求 ID 并注册等待响应
        let (request_id, rx) = {
            let mut state = self.request_state.lock().await;
            let request_id = state.next_request_id;
            state.next_request_id += 1;
            
            let (tx, rx) = oneshot::channel();
            state.pending_requests.insert(request_id, tx);
            (request_id, rx)
        };

        // 发送请求
        conn.request_tx.send((request_id, req))
            .map_err(|_| "连接已关闭".to_string())?;

        // 等待响应
        let resp = rx.await
            .map_err(|_| "请求被取消".to_string())?;

        Ok(resp)
    }

    /// 带重试的连接（Unix）- 如果连接失败，等待 daemon 启动并重试
    #[cfg(not(target_os = "windows"))]
    async fn connect_with_retry_unix(path: &std::path::Path) -> Result<tokio::net::UnixStream, String> {
        use tokio::net::UnixStream;
        use std::time::Duration;
        
        // 第一次尝试连接
        match UnixStream::connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(_) => {
                // 连接失败，可能 daemon 未启动，尝试确保 daemon 已启动
                eprintln!("[DEBUG] PersistentConnection 连接失败，尝试启动 daemon");
            }
        }

        // 尝试确保 daemon 已启动（如果可能的话）
        // 注意：这里不依赖 daemon_startup 模块，避免循环依赖
        // 只是简单重试连接
        
        let timeout = Duration::from_secs(10);
        let start = std::time::Instant::now();
        let mut retry_count = 0;
        
        while start.elapsed() < timeout {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            retry_count += 1;
            
            match UnixStream::connect(path).await {
                Ok(stream) => {
                    eprintln!("[DEBUG] PersistentConnection 连接成功（重试 {} 次）", retry_count);
                    return Ok(stream);
                }
                Err(e) if retry_count % 10 == 0 => {
                    // 每 2 秒输出一次日志
                    eprintln!("[DEBUG] PersistentConnection 连接失败，继续等待... ({}: {})", path.display(), e);
                }
                Err(_) => {
                    // 继续重试
                }
            }
        }
        
        Err(format!(
            "连接 daemon 超时（10 秒，{}）\n请确保 kabegame-daemon 已启动",
            path.display()
        ))
    }

    /// 带重试的连接（Windows）- 如果连接失败，等待 daemon 启动并重试
    #[cfg(target_os = "windows")]
    async fn connect_with_retry_windows() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
        use tokio::net::windows::named_pipe::ClientOptions;
        use super::ipc::windows_pipe_name;
        use std::time::Duration;
        
        let pipe_name = windows_pipe_name();
        
        // 第一次尝试连接
        match ClientOptions::new().open(&pipe_name) {
            Ok(client) => return Ok(client),
            Err(_) => {
                // 连接失败，可能 daemon 未启动，尝试确保 daemon 已启动
                eprintln!("[DEBUG] PersistentConnection 连接失败，尝试启动 daemon");
            }
        }

        // 尝试确保 daemon 已启动（如果可能的话）
        // 注意：这里不依赖 daemon_startup 模块，避免循环依赖
        // 只是简单重试连接
        
        let timeout = Duration::from_secs(10);
        let start = std::time::Instant::now();
        let mut retry_count = 0;
        
        while start.elapsed() < timeout {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            retry_count += 1;
            
            match ClientOptions::new().open(&pipe_name) {
                Ok(client) => {
                    eprintln!("[DEBUG] PersistentConnection 连接成功（重试 {} 次）", retry_count);
                    return Ok(client);
                }
                Err(e) if retry_count % 10 == 0 => {
                    // 每 2 秒输出一次日志
                    eprintln!("[DEBUG] PersistentConnection 连接失败，继续等待... ({})", e);
                }
                Err(_) => {
                    // 继续重试
                }
            }
        }
        
        Err(format!(
            "连接 daemon 超时（10 秒，{}）\n请确保 kabegame-daemon 已启动",
            pipe_name
        ))
    }
}
