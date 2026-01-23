//! 连接处理逻辑（Windows 和 Unix 通用）

use std::sync::Arc;

use crate::ipc::ipc::{decode_frame, encode_frame, read_one_frame};
use crate::ipc::{CliIpcRequest, CliIpcResponse};
use crate::ipc_dbg;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::{EventBroadcaster, SubscriptionManager};

/// 处理单个客户端连接
pub async fn handle_connection<R, W, F, Fut>(
    mut read_half: R,
    mut write_half: W,
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
    client_id: String,
) where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    // 创建写入通道：用于发送响应和事件
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // 事件订阅状态
    let mut event_rx: Option<
        tokio::sync::mpsc::UnboundedReceiver<(
            u64,
            std::sync::Arc<crate::ipc::events::DaemonEvent>,
        )>,
    > = None;

    // 启动写入任务
    let write_task = tokio::spawn(async move {
        while let Some(data) = write_rx.recv().await {
            if let Err(e) = write_half.write_all(&data).await {
                eprintln!("[DEBUG] IPC 服务器写入失败: {}", e);
                return;
            }
            if let Err(e) = write_half.flush().await {
                eprintln!("[DEBUG] IPC 服务器刷新失败: {}", e);
                return;
            }
        }
    });

    loop {
        // 使用 select! 同时监听：读取请求 和 事件流（如果已订阅）
        tokio::select! {
            // 读取一个 CBOR 帧
            read_result = read_one_frame(&mut read_half) => {
                match read_result {
                    Ok(payload) => {
                        ipc_dbg!("[DEBUG] IPC 服务器读取 CBOR 帧，长度: {}", payload.len());

                        // 尝试解析为 IpcEnvelope<CliIpcRequest>（带 request_id）
                        let (req, request_id): (CliIpcRequest, Option<u64>) = match decode_frame::<crate::ipc::ipc::IpcEnvelope<CliIpcRequest>>(&payload) {
                            Ok(envelope) => {
                                ipc_dbg!("[DEBUG] IPC 服务器解析为 IpcEnvelope，request_id={}", envelope.request_id);
                                (envelope.payload, Some(envelope.request_id))
                            }
                            Err(_) => {
                                // 回退：尝试直接解析为 CliIpcRequest（无 request_id）
                                match decode_frame::<CliIpcRequest>(&payload) {
                                    Ok(req) => {
                                        ipc_dbg!("[DEBUG] IPC 服务器解析为 CliIpcRequest（无 request_id）");
                                        (req, None)
                                    }
                                    Err(e) => {
                                        ipc_dbg!("[DEBUG] IPC 服务器解析请求失败: {}", e);
                                        continue;
                                    }
                                }
                            }
                        };

                        // 检查是否是 SubscribeEvents 请求
                        if let CliIpcRequest::SubscribeEvents { kinds } = req.clone() {
                            ipc_dbg!(
                                "[DEBUG] IPC 服务器收到 SubscribeEvents 请求, client_id={}, kinds={:?}",
                                client_id, kinds
                            );

                            // 发送初始响应
                            let mut resp = handler(req).await;
                            resp.request_id = request_id;

                            let bytes = match encode_frame(&resp) {
                                Ok(b) => b,
                                Err(e) => {
                                    ipc_dbg!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                                    break;
                                }
                            };

                            if write_tx.send(bytes).is_err() {
                                ipc_dbg!("[DEBUG] IPC 服务器写入通道关闭");
                                break;
                            }

                            // 使用 SubscriptionManager 订阅事件
                            if let Some(ref sm) = subscription_manager {
                                // 解析事件类型列表：空列表 = 订阅全部
                                let event_kinds: Vec<crate::ipc::events::DaemonEventKind> =
                                    if kinds.is_empty() {
                                        crate::ipc::events::DaemonEventKind::ALL.to_vec()
                                    } else {
                                        kinds
                                        .iter()
                                        .filter_map(|s| {
                                            crate::ipc::events::DaemonEventKind::from_str(s)
                                        })
                                        .collect()
                                    };
                                ipc_dbg!("[DEBUG] IPC 服务器解析后的事件类型: {:?}", event_kinds);
                                event_rx = Some(sm.subscribe(&client_id, event_kinds).await);
                                ipc_dbg!("[DEBUG] IPC 服务器开始推送事件（通过 SubscriptionManager）");
                            } else {
                                if let Some(ref broadcaster) = broadcaster {
                                    if let Ok(broadcaster) =
                                        broadcaster.clone().downcast::<EventBroadcaster>()
                                    {
                                        let event_kinds: Vec<crate::ipc::events::DaemonEventKind> =
                                            if kinds.is_empty() {
                                                crate::ipc::events::DaemonEventKind::ALL.to_vec()
                                            } else {
                                                kinds
                                                .iter()
                                                .filter_map(|s| {
                                                    crate::ipc::events::DaemonEventKind::from_str(s)
                                                })
                                                .collect()
                                            };
                                        event_rx = Some(broadcaster.subscribe_filtered_stream(&event_kinds));
                                        ipc_dbg!("[DEBUG] IPC 服务器开始推送事件（回退到 broadcaster）");
                                    }
                                }
                            }
                            // 不再 return，继续处理后续请求
                            continue;
                        }

                        // 普通请求：处理并发送响应
                        let mut resp = handler(req).await;
                        resp.request_id = request_id;

                        ipc_dbg!(
                            "[DEBUG] IPC 服务器准备发送响应, request_id={:?}, ok={}",
                            request_id, resp.ok
                        );

                        let bytes = match encode_frame(&resp) {
                            Ok(b) => {
                                ipc_dbg!(
                                    "[DEBUG] IPC 服务器编码响应成功, 长度={}",
                                    b.len()
                                );
                                b
                            }
                            Err(e) => {
                                ipc_dbg!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                                continue;
                            }
                        };

                        if write_tx.send(bytes).is_err() {
                            ipc_dbg!("[DEBUG] IPC 服务器写入通道关闭");
                            break;
                        }

                        ipc_dbg!("[DEBUG] IPC 服务器已发送响应, request_id={:?}", request_id);
                    }
                    Err(e) => {
                        if e.contains("EOF") || e.contains("连接关闭") {
                            ipc_dbg!("[DEBUG] IPC 服务器连接关闭 (EOF)");
                        } else {
                            ipc_dbg!("[DEBUG] IPC 服务器读取失败: {}", e);
                        }
                        break;
                    }
                }
            }

            // 事件流（仅在已订阅时监听）
            event_result = async {
                if let Some(ref mut rx) = event_rx {
                    rx.recv().await
                } else {
                    // 未订阅事件，永远 pending
                    std::future::pending().await
                }
            } => {
                match event_result {
                    Some((id, event)) => {
                        match encode_frame(&event) {
                            Ok(bytes) => {
                                if write_tx.send(bytes).is_err() {
                                    ipc_dbg!("[DEBUG] IPC 服务器写入通道关闭");
                                    break;
                                }
                                ipc_dbg!("[DEBUG] IPC 服务器已推送事件: id={}", id);
                            }
                            Err(e) => {
                                ipc_dbg!("[DEBUG] IPC 服务器序列化事件失败: {}", e);
                            }
                        }
                    }
                    None => {
                        // 事件流关闭
                        ipc_dbg!("[DEBUG] IPC 服务器事件流关闭");
                        break;
                    }
                }
            }
        }
    }

    // 关闭写入通道，等待写入任务完成
    drop(write_tx);
    let _ = write_task.await;

    // 清理订阅
    if let Some(ref sm) = subscription_manager {
        let cleaned = sm.unsubscribe(&client_id).await;
        eprintln!(
            "[DEBUG] IPC 服务器清理客户端订阅: client_id={}, cleaned={}",
            client_id, cleaned
        );
    } else {
        eprintln!(
            "[DEBUG] IPC 服务器连接结束但无 subscription_manager: client_id={}",
            client_id
        );
    }

    eprintln!("[DEBUG] IPC 服务器连接处理完成: client_id={}", client_id);
}
