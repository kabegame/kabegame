//! IPC 持久连接管理
//!
//! 实现客户端的持久连接复用机制：
//! - 维护单一长连接用于所有请求-响应
//! - 支持请求 ID 匹配
//! - 自动重连
//! - 并发请求支持
//! - 防止并发创建多个连接

use crate::ipc::events::AppEvent;
use crate::ipc::ipc::{
    decode_frame, encode_frame, read_one_frame, IpcEnvelope, IpcRequest, IpcResponse,
};
use crate::ipc_dbg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};

/// 请求响应状态
struct RequestState {
    /// 请求 ID 计数器
    next_request_id: u64,
    /// 等待响应的请求：request_id -> oneshot sender
    pending_requests: HashMap<u64, oneshot::Sender<IpcResponse>>,
}

/// IPC 连接状态（公开枚举，用于外部订阅）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    /// 未连接
    Disconnected,
    /// 正在连接
    Connecting,
    /// 已连接
    /// 不把handle写在这里是因为handle不可序列化
    Connected,
}

/// 持久连接管理器
pub struct PersistentConnection {
    /// 连接状态
    pub status: Arc<RwLock<ConnectionStatus>>,
    /// 连上的时候才有handle
    pub handle: Arc<RwLock<Option<ConnectionHandle>>>,
    /// 请求响应状态
    pub request_state: Arc<Mutex<RequestState>>,
    /// 连接状态变化通知（用于外部订阅）
    status_notify: Arc<watch::Sender<ConnectionStatus>>,
    // 外部watch的值
    pub status_rx: watch::Receiver<ConnectionStatus>,
}

/// 连接句柄
pub struct ConnectionHandle {
    /// 发送请求的通道（客户端 -> 应用 IPC 服务）
    /// 不能并发发送请求
    pub request_tx: Arc<Mutex<mpsc::UnboundedSender<(u64, IpcRequest)>>>,
    /// 事件接收通道（客户端 <- 应用 IPC 服务），每条连接只能取走一次。
    pub event_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<Arc<AppEvent>>>>>,
}

#[cfg(target_os = "windows")]
type ClientStream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(any(target_os = "macos", target_os = "linux"))]
type ClientStream = tokio::net::UnixStream;

#[cfg(target_os = "windows")]
type WriteHalf = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

#[cfg(any(target_os = "macos", target_os = "linux"))]
type WriteHalf = tokio::io::WriteHalf<tokio::net::UnixStream>;

#[cfg(target_os = "windows")]
type ReadHalf = tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

#[cfg(any(target_os = "macos", target_os = "linux"))]
type ReadHalf = tokio::io::ReadHalf<tokio::net::UnixStream>;

impl PersistentConnection {
    pub fn new() -> Self {
        let (status_tx, status_rx) = watch::channel(ConnectionStatus::Disconnected);
        Self {
            status: Arc::new(RwLock::new(ConnectionStatus::Disconnected)),
            handle: Arc::new(RwLock::new(None)),
            request_state: Arc::new(Mutex::new(RequestState {
                next_request_id: 1,
                pending_requests: HashMap::new(),
            })),
            status_notify: Arc::new(status_tx),
            status_rx,
        }
    }

    /// 订阅连接状态变化
    pub fn subscribe_status(&self) -> watch::Receiver<ConnectionStatus> {
        self.status_rx.clone()
    }

    /// 获取当前连接状态
    pub async fn get_status(&self) -> ConnectionStatus {
        self.status.read().await.clone()
    }

    /// 内部辅助函数：统一更新连接状态
    async fn set_status(&self, status: ConnectionStatus) {
        *self.status.write().await = status;
        let _ = self.status_notify.send(status);
    }

    /// 安装已建立的连接，然后在后台启动读写循环。
    async fn start_io(self: Arc<Self>, client: ClientStream) {
        use tokio::io::split;

        let (request_tx, mut request_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let handle = ConnectionHandle {
            request_tx: Arc::new(Mutex::new(request_tx)),
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
        };

        *self.handle.write().await = Some(handle);
        self.set_status(ConnectionStatus::Connected).await;
        ipc_dbg!("[DEBUG] PersistentConnection 持久连接已建立");

        let (read_half, mut write_half) = split(client);
        let read_task = tokio::spawn(Self::recieve_message_loop(
            self.clone(),
            read_half,
            event_tx,
        ));

        let write_task = tokio::spawn(async move {
            while let Some((request_id, req)) = request_rx.recv().await {
                if let Err(e) = Self::send_request(&mut write_half, request_id, req).await {
                    ipc_dbg!("[ERROR] PersistentConnection 发送请求失败: {}, 关闭连接", e);
                    break;
                }
            }
        });

        let connection = self.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = read_task => {}
                _ = write_task => {}
            }

            *connection.handle.write().await = None;
            connection
                .request_state
                .lock()
                .await
                .pending_requests
                .clear();
            connection.set_status(ConnectionStatus::Disconnected).await;
            ipc_dbg!("[DEBUG] PersistentConnection 连接已关闭");
        });
    }

    /// 发送请求
    async fn send_request(
        write_half: &mut WriteHalf,
        request_id: u64,
        req: IpcRequest,
    ) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;

        let envelope = IpcEnvelope {
            request_id,
            payload: req.clone(),
        };

        let frame = encode_frame(&envelope)?;

        ipc_dbg!(
            "[DEBUG] PersistentConnection 发送请求 #{}: {:?}",
            request_id,
            req
        );

        write_half
            .write_all(&frame)
            .await
            .map_err(|e| format!("写入失败: {}", e))?;
        // eprintln!("写入成功");
        write_half
            .flush()
            .await
            .map_err(|e| format!("刷新失败: {}", e))?;

        Ok(())
    }

    /// 主读取循环
    async fn recieve_message_loop(
        connection: Arc<PersistentConnection>,
        mut read_half: ReadHalf,
        event_tx: mpsc::UnboundedSender<Arc<AppEvent>>,
    ) {
        ipc_dbg!("[DEBUG] PersistentConnection 接收消息循环已启动");

        loop {
            match read_one_frame(&mut read_half).await {
                Ok(payload) => {
                    connection.process_message_frame(&payload, &event_tx).await;
                }
                Err(e) => {
                    if e.contains("EOF") {
                        connection.set_status(ConnectionStatus::Disconnected).await;
                        ipc_dbg!("[DEBUG] PersistentConnection 连接关闭 (EOF)");
                    } else {
                        ipc_dbg!("[ERROR] PersistentConnection 读取失败: {}", e);
                    }
                    break;
                }
            }
        }
    }

    /// 处理消息帧（共用逻辑）：区分响应和事件
    ///
    /// 响应特征：有 `ok` 字段（布尔值）
    /// 事件特征：没有 `ok` 字段
    async fn process_message_frame(
        &self,
        payload: &[u8],
        event_tx: &mpsc::UnboundedSender<Arc<AppEvent>>,
    ) {
        ipc_dbg!(
            "[DEBUG] PersistentConnection 收到 CBOR 帧，长度: {}",
            payload.len()
        );

        // 先尝试解析为响应
        match decode_frame::<IpcResponse>(payload) {
            Ok(resp) => {
                // 这是响应
                if let Some(id) = resp.request_id {
                    ipc_dbg!(
                        "[DEBUG] PersistentConnection 收到响应 #{}: ok={}",
                        id,
                        resp.ok
                    );

                    let mut state = self.request_state.lock().await;
                    if let Some(tx) = state.pending_requests.remove(&id) {
                        let _ = tx.send(resp);
                    } else {
                        ipc_dbg!("[WARN] PersistentConnection 响应 #{} 找不到对应的请求", id);
                    }
                } else {
                    ipc_dbg!(
                        "[WARN] PersistentConnection 收到无 request_id 的响应: ok={}",
                        resp.ok
                    );
                }
            }
            Err(_) => {
                // 解析响应失败，尝试解析为强类型事件。
                match decode_frame::<AppEvent>(payload) {
                    Ok(event) => {
                        ipc_dbg!("[DEBUG] PersistentConnection 收到事件");
                        if let Err(e) = event_tx.send(Arc::new(event)) {
                            ipc_dbg!("[WARN] PersistentConnection 发送事件失败: {}", e);
                        }
                    }
                    Err(e) => {
                        ipc_dbg!("[WARN] PersistentConnection 收到未知事件或无效 CBOR: {}", e);
                    }
                }
            }
        }
    }

    /// 连接到应用 IPC 服务。
    /// 不允许并发调用
    pub async fn connect(self: Arc<Self>) -> Result<(), String> {
        match self.get_status().await {
            ConnectionStatus::Connected => return Ok(()),
            ConnectionStatus::Connecting => return Err("正在连接中".to_string()),
            ConnectionStatus::Disconnected => {}
        }
        self.set_status(ConnectionStatus::Connecting).await;
        let stream = match Self::create_connection().await {
            Ok(stream) => stream,
            Err(error) => {
                self.set_status(ConnectionStatus::Disconnected).await;
                return Err(error);
            }
        };
        self.clone().start_io(stream).await;
        Ok(())
    }

    /// 等待连接就绪（不主动创建连接）
    ///
    /// 此方法会等待连接进入 Connected 状态，但不会主动调用 connect() 创建连接。
    /// 如果当前已经是 Connected 状态，立即返回。
    /// 如果是 Connecting 状态，等待连接完成。
    /// 如果是 Disconnected 状态，等待直到其他代码调用 connect() 创建连接。
    async fn wait_for_connection(&self) -> Result<(), String> {
        loop {
            // 1. 先检查当前状态
            if self.get_status().await == ConnectionStatus::Connected {
                return Ok(());
            }

            // 2. 等待 watch channel 变化
            let mut rx = self.status_rx.clone();
            while rx.changed().await.is_ok() {
                let value = rx.borrow().clone();
                if let ConnectionStatus::Connected = &value {
                    return Ok(());
                }
            }
        }
    }

    /// 发送请求并等待响应
    ///
    /// Connected 时直接发送；Connecting 时最多等待 10 秒；Disconnected 立即失败。
    pub async fn request(&self, req: IpcRequest) -> Result<IpcResponse, String> {
        match self.get_status().await {
            ConnectionStatus::Connected => {}
            ConnectionStatus::Disconnected => return Err("未连接到 Kabegame 主程序".to_string()),
            ConnectionStatus::Connecting => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    self.wait_for_connection(),
                )
                .await
                .map_err(|_| "等待连接超时（10秒）".to_string())??;
            }
        }

        let request_tx = {
            let conn = self.handle.read().await;
            conn.as_ref()
                .ok_or_else(|| "连接已断开".to_string())?
                .request_tx
                .clone()
        };

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
        if let Err(e) = request_tx.lock().await.send((request_id, req)) {
            // 发送失败，我们这里也不敢说连接断开了，只能返回错误
            self.request_state
                .lock()
                .await
                .pending_requests
                .remove(&request_id);
            return Err(format!("发送请求失败: {}", e));
        }

        // 等待响应
        match rx.await {
            Ok(resp) => {
                // eprintln!("响应: {:?}", resp);
                Ok(resp)
            }
            Err(_) => {
                // 等待响应失败（可能是连接断开），设置状态为断开
                self.set_status(ConnectionStatus::Disconnected).await;
                Err("请求被取消或连接已断开".to_string())
            }
        }
    }

    /// 连接（Unix）- 直接尝试连接，失败则返回错误
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    async fn create_connection() -> Result<tokio::net::UnixStream, String> {
        use tokio::net::UnixStream;

        use crate::ipc::ipc::unix_socket_path;

        let path_buf = unix_socket_path();
        let uds_path = path_buf.as_path();

        UnixStream::connect(uds_path).await.map_err(|e| {
            format!(
                "连接 Kabegame IPC 服务失败 ({}): {}\n请确保 Kabegame 主程序已启动",
                uds_path.display(),
                e
            )
        })
    }

    /// 连接（Windows）- 直接尝试连接，失败则返回错误
    #[cfg(target_os = "windows")]
    async fn create_connection() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String>
    {
        use crate::ipc::ipc::windows_pipe_name;
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = windows_pipe_name();

        ClientOptions::new().open(&pipe_name).map_err(|e| {
            format!(
                "连接 Kabegame IPC 服务失败 ({}): {}\n请确保 Kabegame 主程序已启动",
                pipe_name, e
            )
        })
    }
}
