//! 事件订阅管理器
//!
//! 管理所有客户端的事件订阅，支持动态添加/取消订阅

use super::broadcaster::EventBroadcaster;
use super::events::{DaemonEvent, DaemonEventKind};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

/// 订阅状态
struct SubscriptionState {
    /// 订阅的事件类型列表
    kinds: Vec<DaemonEventKind>,
    /// 取消信号发送端（用于主动取消订阅，使用 broadcast 以便通知多个转发任务）
    cancel_tx: broadcast::Sender<()>,
}

/// 事件订阅管理器
///
/// 管理所有客户端的事件订阅，每个客户端可以有独立的订阅配置。
/// 当客户端连接断开时，会自动清理对应的订阅。
pub struct SubscriptionManager {
    broadcaster: Arc<EventBroadcaster>,
    /// client_id -> SubscriptionState
    subscriptions: Arc<RwLock<HashMap<String, SubscriptionState>>>,
}

impl SubscriptionManager {
    /// 创建新的订阅管理器
    pub fn new(broadcaster: Arc<EventBroadcaster>) -> Self {
        Self {
            broadcaster,
            subscriptions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 订阅事件，返回事件接收器
    ///
    /// 如果客户端已存在订阅，会先取消旧订阅再创建新订阅。
    ///
    /// # 参数
    /// - `client_id`: 客户端唯一标识符
    /// - `kinds`: 要订阅的事件类型列表，空列表表示订阅全部事件
    ///
    /// # 返回
    /// 返回事件接收器，客户端可以通过此接收器接收事件
    pub async fn subscribe(
        &self,
        client_id: &str,
        kinds: Vec<DaemonEventKind>,
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        // 如果已存在订阅，先取消
        {
            let mut subs = self.subscriptions.write().await;
            if let Some(state) = subs.remove(client_id) {
                let _ = state.cancel_tx.send(());
            }
        }

        // 解析事件类型：空列表 = 订阅全部
        let event_kinds = if kinds.is_empty() {
            DaemonEventKind::ALL.to_vec()
        } else {
            kinds
        };

        // 创建取消信号通道（使用 broadcast 以便通知多个转发任务）
        let (cancel_tx, _) = broadcast::channel::<()>(1);

        // 创建转发通道
        let (forward_tx, forward_rx) = mpsc::unbounded_channel::<(u64, DaemonEvent)>();

        // 直接订阅 broadcast channel，并为每个事件类型启动转发任务
        // 当 cancel_tx 发送信号时，所有任务会退出并 drop broadcast::Receiver
        for kind in &event_kinds {
            let brx = self.broadcaster.subscribe(*kind);
            let tx = forward_tx.clone();
            let cancel_rx = cancel_tx.subscribe();

            tokio::spawn(Self::forward_task(brx, tx, cancel_rx));
        }

        let mut subs = self.subscriptions.write().await;
        let kinds_count = event_kinds.len();
        subs.insert(
            client_id.to_string(),
            SubscriptionState {
                kinds: event_kinds,
                cancel_tx,
            },
        );
        eprintln!(
            "[DEBUG] SubscriptionManager::subscribe client_id={}, 订阅 {} 种事件, 当前总订阅数: {}",
            client_id,
            kinds_count,
            subs.len()
        );

        forward_rx
    }

    /// 转发任务：从 broadcast::Receiver 转发到 mpsc::UnboundedSender
    /// 同时监听取消信号
    async fn forward_task(
        mut brx: broadcast::Receiver<(u64, DaemonEvent)>,
        tx: mpsc::UnboundedSender<(u64, DaemonEvent)>,
        mut cancel_rx: broadcast::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                biased; // 优先检查取消信号

                // 收到取消信号，立即退出
                _ = cancel_rx.recv() => {
                    break;
                }

                // 接收事件
                result = brx.recv() => {
                    match result {
                        Ok(item) => {
                            // 若对端已断开（连接关闭），直接退出转发任务
                            if tx.send(item).is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // 滞后时继续
                            continue;
                        }
                    }
                }
            }
        }
    }

    /// 取消订阅
    ///
    /// # 参数
    /// - `client_id`: 客户端唯一标识符
    ///
    /// # 返回
    /// 如果成功取消订阅返回 `true`，如果客户端不存在订阅返回 `false`
    pub async fn unsubscribe(&self, client_id: &str) -> bool {
        let mut subs = self.subscriptions.write().await;
        if let Some(state) = subs.remove(client_id) {
            // 发送取消信号给所有转发任务（忽略错误，因为任务可能已经退出）
            let receiver_count = state.cancel_tx.receiver_count();
            let _ = state.cancel_tx.send(());
            eprintln!(
                "[DEBUG] SubscriptionManager::unsubscribe client_id={}, 发送取消信号给 {} 个转发任务, 剩余订阅数: {}",
                client_id,
                receiver_count,
                subs.len()
            );
            true
        } else {
            eprintln!(
                "[DEBUG] SubscriptionManager::unsubscribe client_id={} 不存在订阅",
                client_id
            );
            false
        }
    }

    /// 更新订阅（会取消旧订阅，创建新订阅）
    ///
    /// 这是 `unsubscribe` + `subscribe` 的便捷方法。
    pub async fn update_subscription(
        &self,
        client_id: &str,
        kinds: Vec<DaemonEventKind>,
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        self.subscribe(client_id, kinds).await
    }

    /// 查询客户端订阅状态
    ///
    /// # 返回
    /// 返回客户端订阅的事件类型列表，如果客户端不存在订阅返回 `None`
    pub async fn get_subscription(&self, client_id: &str) -> Option<Vec<DaemonEventKind>> {
        let subs = self.subscriptions.read().await;
        subs.get(client_id).map(|state| state.kinds.clone())
    }

    /// 获取所有活跃订阅数量
    pub async fn active_count(&self) -> usize {
        let subs = self.subscriptions.read().await;
        subs.len()
    }

    /// 清理所有订阅（用于测试或关闭时）
    pub async fn clear_all(&self) {
        let mut subs = self.subscriptions.write().await;
        for state in subs.values() {
            let _ = state.cancel_tx.send(());
        }
        subs.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_subscribe_unsubscribe() {
        let broadcaster = Arc::new(EventBroadcaster::new(100));
        let manager = SubscriptionManager::new(broadcaster);

        // 订阅
        let rx = manager
            .subscribe("client1", vec![DaemonEventKind::TaskLog])
            .await;
        assert_eq!(manager.active_count().await, 1);

        // 取消订阅
        assert!(manager.unsubscribe("client1").await);
        assert_eq!(manager.active_count().await, 0);
        assert!(!manager.unsubscribe("client1").await); // 再次取消应该返回 false

        // 确保接收器已关闭
        drop(rx);
    }

    #[tokio::test]
    async fn test_update_subscription() {
        let broadcaster = Arc::new(EventBroadcaster::new(100));
        let manager = SubscriptionManager::new(broadcaster);

        // 初始订阅
        let _rx1 = manager
            .subscribe("client1", vec![DaemonEventKind::TaskLog])
            .await;
        assert_eq!(manager.active_count().await, 1);

        // 更新订阅（应该替换旧订阅）
        let _rx2 = manager.update_subscription("client1", vec![DaemonEventKind::TaskStatus]);
        assert_eq!(manager.active_count().await, 1); // 仍然是 1 个订阅

        // 查询订阅状态
        let kinds = manager.get_subscription("client1").await;
        assert_eq!(kinds, Some(vec![DaemonEventKind::TaskStatus]));
    }
}
