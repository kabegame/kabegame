//! IPC 持久连接管理
//!
//! 实现客户端的持久连接复用机制：
//! - 维护单一长连接用于所有请求-响应
//! - 支持请求 ID 匹配
//! - 自动重连
//! - 并发请求支持
//! - 防止并发创建多个连接

use crate::ipc::daemon_startup::IPC_CLIENT;
use crate::ipc::DaemonEventKind;

use super::ipc::{
    decode_frame, encode_frame, read_one_frame, CliIpcRequest, CliIpcResponse, IpcEnvelope,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::{collections::HashMap, sync::OnceLock};
use tokio::sync::{mpsc, mpsc::channel, oneshot, watch, Mutex, RwLock};

/// 请求响应状态
struct RequestState {
    /// 请求 ID 计数器
    next_request_id: u64,
    /// 等待响应的请求：request_id -> oneshot sender
    pending_requests: HashMap<u64, oneshot::Sender<CliIpcResponse>>,
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
    /// 发送请求的通道（客户端 -> daemon）
    /// 不能并发发送请求
    pub request_tx: Arc<Mutex<mpsc::UnboundedSender<(u64, CliIpcRequest)>>>,
    /// 事件接收通道spsc（客户端 <- daemon）
    pub event_rx: Arc<Mutex<mpsc::Receiver<serde_json::Value>>>,
}

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

    /// 连接处理任务内部实现 - Unix
    // #[cfg(not(target_os = "windows"))]
    // async fn connection_task_inner(
    //     mut request_rx: mpsc::UnboundedReceiver<(u64, CliIpcRequest)>,
    //     request_state: Arc<Mutex<RequestState>>,
    //     status: Arc<Mutex<ConnectionStatus>>,
    //     ready_notify: Arc<watch::Sender<Option<Result<Arc<ConnectionHandle>, String>>>>,
    //     status_notify: Arc<watch::Sender<IpcConnStatus>>,
    //     ready_tx: ConnReadyTx,
    //     handle: Arc<ConnectionHandle>,
    // ) {
    //     use super::ipc::unix_socket_path;
    //     use tokio::io::split;
    //     use tokio::net::UnixStream;
    //     let path = unix_socket_path();
    //     // 设置状态为正在连接
    //     Self::set_status(&status, &status_notify, ConnectionStatus::Connecting).await;
    //     // 尝试连接，如果失败则等待 daemon 启动
    //     let stream = match Self::create_connection(&path).await {
    //         Ok(s) => s,
    //         Err(e) => {
    //             eprintln!(
    //                 "[ERROR] PersistentConnection 连接失败 ({}): {}",
    //                 path.display(),
    //                 e
    //             );
    //             // 重置状态为未连接
    //             Self::set_status(&status, &status_notify, ConnectionStatus::Disconnected).await;
    //             // 通知等待者连接失败
    //             let _ = ready_notify.send(Some(Err(e.clone())));
    //             let _ = ready_tx.send(Err(e));
    //             return;
    //         }
    //     };
    //     eprintln!("[DEBUG] PersistentConnection 持久连接已建立 (Unix)");
    //     // 连接成功，更新状态
    //     Self::set_status(
    //         &status,
    //         &status_notify,
    //         ConnectionStatus::Connected(handle.clone()),
    //     )
    //     .await;
    //     // 通知所有等待者连接成功
    //     let _ = ready_notify.send(Some(Ok(handle.clone())));
    //     // 通知发起者连接就绪
    //     let _ = ready_tx.send(Ok(()));
    //     // 使用 split 分离读写端
    //     let (read_half, mut write_half) = split(stream);
    //     // 启动读取任务
    //     let state_clone = request_state.clone();
    //     let event_tx_clone = handle.event_tx.clone();
    //     let read_task = tokio::spawn(Self::recieve_message_loop(
    //         read_half,
    //         state_clone,
    //         event_tx_clone,
    //     ));
    //     // 写入任务（处理请求队列）
    //     while let Some((request_id, req)) = request_rx.recv().await {
    //         if let Err(e) = Self::send_request(&mut write_half, request_id, req).await {
    //             eprintln!("[ERROR] PersistentConnection 发送请求失败: {}, 关闭连接", e);
    //             break;
    //         }
    //     }
    //     // 连接断开，清理
    //     read_task.abort();
    //     Self::set_status(&status, &status_notify, ConnectionStatus::Disconnected).await;
    //     // 清除通知，允许重新连接
    //     let _ = ready_notify.send(None);
    //     eprintln!("[DEBUG] PersistentConnection 连接已关闭");
    // }
    /// 真正处理连接，干活的
    /// 1. 创建命名管道或者UnixSocket连接
    /// 2. 写入全局连接句柄
    /// 3. 启动读循环
    /// 4. 进入主循环，处理请求队列和事件
    async fn connection_loop(self: Arc<Self>) {
        use tokio::io::split;

        // 设置状态为正在连接
        self.set_status(ConnectionStatus::Connecting).await;

        // 尝试连接，如果失败则返回错误。上层会处理重启daemon等操作
        let client = match Self::create_connection().await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[ERROR] PersistentConnection 连接失败: {}", e);
                // 重置状态为未连接
                self.set_status(ConnectionStatus::Disconnected).await;
                return;
            }
        };

        let (request_tx, mut request_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = mpsc::channel(1);
        let handle = ConnectionHandle {
            request_tx: Arc::new(Mutex::new(request_tx)),
            event_rx: Arc::new(Mutex::new(event_rx)),
        };

        eprintln!("[DEBUG] PersistentConnection 持久连接已建立 (Windows)");

        // 连接成功，更新状态
        *self.handle.write().await = Some(handle);
        self.set_status(ConnectionStatus::Connected).await;

        // 使用 split 分离读写端
        let (read_half, mut write_half) = split(client);

        // 启动读取任务
        let read_task = tokio::spawn(Self::recieve_message_loop(
            self.clone(),
            read_half,
            event_tx,
        ));

        // 写入任务（处理请求队列）
        while let Some((request_id, req)) = request_rx.recv().await {
            if let Err(e) = Self::send_request(&mut write_half, request_id, req).await {
                eprintln!("[ERROR] PersistentConnection 发送请求失败: {}, 关闭连接", e);
                break;
            }
        }

        // 连接断开，清理
        read_task.abort();
        *self.handle.write().await = None;
        self.set_status(ConnectionStatus::Disconnected).await;
        eprintln!("[DEBUG] PersistentConnection 连接已关闭");
    }

    /// 发送请求
    async fn send_request(
        write_half: &mut WriteHalf,
        request_id: u64,
        req: CliIpcRequest,
    ) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;

        let envelope = IpcEnvelope {
            request_id,
            payload: req.clone(),
        };

        let frame = encode_frame(&envelope)?;

        eprintln!(
            "[DEBUG] PersistentConnection 发送请求 #{}: {:?}",
            request_id, req
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
        event_tx: mpsc::Sender<serde_json::Value>,
    ) {
        eprintln!("[DEBUG] PersistentConnection 接收消息循环已启动 (Windows)");

        loop {
            match read_one_frame(&mut read_half).await {
                Ok(payload) => {
                    connection.process_message_frame(&payload, &event_tx).await;
                }
                Err(e) => {
                    if e.contains("EOF") {
                        connection.set_status(ConnectionStatus::Disconnected).await;
                        eprintln!("[DEBUG] PersistentConnection 连接关闭 (EOF)");
                    } else {
                        eprintln!("[ERROR] PersistentConnection 读取失败: {}", e);
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
        event_tx: &mpsc::Sender<serde_json::Value>,
    ) {
        eprintln!(
            "[DEBUG] PersistentConnection 收到 CBOR 帧，长度: {}",
            payload.len()
        );

        // 先尝试解析为响应
        match decode_frame::<CliIpcResponse>(payload) {
            Ok(resp) => {
                // 这是响应
                if let Some(id) = resp.request_id {
                    eprintln!(
                        "[DEBUG] PersistentConnection 收到响应 #{}: ok={}",
                        id, resp.ok
                    );

                    let mut state = self.request_state.lock().await;
                    if let Some(tx) = state.pending_requests.remove(&id) {
                        let _ = tx.send(resp);
                    } else {
                        eprintln!("[WARN] PersistentConnection 响应 #{} 找不到对应的请求", id);
                    }
                } else {
                    eprintln!(
                        "[WARN] PersistentConnection 收到无 request_id 的响应: ok={}",
                        resp.ok
                    );
                }
            }
            Err(_) => {
                // 解析响应失败，尝试解析为事件（serde_json::Value）
                match decode_frame::<serde_json::Value>(payload) {
                    Ok(value) => {
                        eprintln!("[DEBUG] PersistentConnection 收到事件");
                        if let Err(e) = event_tx.send(value).await {
                            eprintln!("[WARN] PersistentConnection 发送事件失败: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[WARN] PersistentConnection 收到无效 CBOR: {}", e);
                    }
                }
            }
        }
    }

    /// 连接到 daemon
    /// 不允许并发调用
    pub async fn connect(self: Arc<Self>) -> Result<(), String> {
        loop {
            match self.get_status().await {
                ConnectionStatus::Connected => {
                    // 已经连接，直接返回成功
                    return Ok(());
                }
                //
                ConnectionStatus::Connecting => {
                    return Err("正在连接中".to_string());
                }
                ConnectionStatus::Disconnected => {
                    // 需要启动连接，设置状态为 Connecting
                    // let status_notify_clone = self.statuss_notify.clone();
                    // Self::set_status(
                    //     &self.status,
                    //     &status_notify_clone,
                    //     ConnectionStatus::Connecting,
                    // )
                    // .await;

                    // // 创建连接通道
                    // let (request_tx, request_rx) = mpsc::unbounded_channel();
                    // let (event_tx, event_rx) = mpsc::unbounded_channel();
                    // let handle = Arc::new(ConnectionHandle {
                    //     request_tx,
                    //     event_rx,
                    // });

                    // 创建连接就绪通知
                    // let (ready_tx, ready_rx) = oneshot::channel();

                    // 克隆需要的 Arc
                    // let status_clone = self.status.clone();
                    // let request_state_clone = self.request_state.clone();
                    // let status_notify_clone = self.status_notify.clone();
                    // let handle_clone = handle.clone();

                    // 启动连接任务
                    tokio::spawn(self.connection_loop());

                    // 等待连接完成
                    return Ok(());
                }
            }
        }
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
    /// 此方法会等待连接进入 Connected 状态（最多10秒），但不会主动创建连接。
    /// 如果请求失败（发送失败或等待响应超时），会自动将连接状态设置为 Disconnected。
    /// 如果是连接相关错误，会弹出原生错误窗口提示用户先启动 kabegame。
    pub async fn request(&self, req: CliIpcRequest) -> Result<CliIpcResponse, String> {
        // 等待连接就绪（最多10秒），但不主动创建连接
        let connection_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.wait_for_connection(),
        )
        .await;

        if let Err(_) = connection_result {
            let error_msg = "等待连接超时（10秒）".to_string();
            super::daemon_status::handle_daemon_connection_error(&error_msg);
            return Err(error_msg);
        }

        let conn = self.handle.read().await;
        let conn = conn.as_ref().unwrap();

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
        if let Err(e) = conn.request_tx.lock().await.send((request_id, req)) {
            // 发送失败，我们这里也不敢说连接断开了，只能返回错误
            let error_msg = format!("发送请求失败: {}", e);
            super::daemon_status::handle_daemon_connection_error(&error_msg);
            return Err(error_msg);
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
                let error_msg = "请求被取消或连接已断开".to_string();
                super::daemon_status::handle_daemon_connection_error(&error_msg);
                Err(error_msg)
            }
        }
    }

    /// 连接（Unix）- 直接尝试连接，失败则返回错误
    #[cfg(not(target_os = "windows"))]
    async fn create_connection(path: &std::path::Path) -> Result<tokio::net::UnixStream, String> {
        use tokio::net::UnixStream;

        UnixStream::connect(path).await.map_err(|e| {
            format!(
                "连接 daemon 失败 ({}): {}\n请确保 kabegame-daemon 已启动",
                path.display(),
                e
            )
        })
    }

    /// 连接（Windows）- 直接尝试连接，失败则返回错误
    #[cfg(target_os = "windows")]
    async fn create_connection() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String>
    {
        use super::ipc::windows_pipe_name;
        use tokio::net::windows::named_pipe::ClientOptions;

        let pipe_name = windows_pipe_name();

        ClientOptions::new().open(&pipe_name).map_err(|e| {
            format!(
                "连接 daemon 失败 ({}): {}\n请确保 kabegame-daemon 已启动",
                pipe_name, e
            )
        })
    }
}
