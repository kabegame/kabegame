//! 全局订阅管理器模块
//!
//! 提供全局单例的 SubscriptionManager，参照 EventBroadcaster 的实现模式

use std::sync::OnceLock;

use crate::ipc::events::{ArcDaemonEvent, DaemonEventKind};
use crate::ipc::server::EventBroadcaster;
use tokio::sync::{broadcast, mpsc, RwLock};

struct SubscriptionState {
    kinds: Vec<DaemonEventKind>,
    cancel_tx: broadcast::Sender<()>,
}

/// 全局订阅管理器单例
pub struct SubscriptionManager {
    subscriptions: RwLock<std::collections::HashMap<String, SubscriptionState>>,
}

static SUBSCRIPTION_MANAGER: OnceLock<SubscriptionManager> = OnceLock::new();

impl SubscriptionManager {
    /// 初始化全局 SubscriptionManager（必须在首次使用前调用）
    pub fn init_global() -> Result<(), String> {
        SUBSCRIPTION_MANAGER
            .set(SubscriptionManager {
                subscriptions: RwLock::new(std::collections::HashMap::new()),
            })
            .map_err(|_| "SubscriptionManager already initialized".to_string())?;

        Ok(())
    }

    /// 获取全局 SubscriptionManager 引用
    pub fn global() -> &'static SubscriptionManager {
        SUBSCRIPTION_MANAGER
            .get()
            .expect("SubscriptionManager not initialized. Call SubscriptionManager::init_global() first.")
    }

    pub async fn subscribe(
        &self,
        client_id: &str,
        kinds: Vec<DaemonEventKind>,
    ) -> mpsc::UnboundedReceiver<(u64, ArcDaemonEvent)> {
        // 先取消注册了所有已经注册的
        {
            let mut subs = self.subscriptions.write().await;
            if let Some(state) = subs.remove(client_id) {
                let _ = state.cancel_tx.send(());
            }
        }

        let event_kinds = if kinds.is_empty() {
            DaemonEventKind::ALL.to_vec()
        } else {
            kinds
        };

        let (cancel_tx, _) = broadcast::channel::<()>(1);

        let (forward_tx, forward_rx) = mpsc::unbounded_channel::<(u64, ArcDaemonEvent)>();

        let broadcaster = EventBroadcaster::global();
        for kind in &event_kinds {
            let brx = broadcaster.subscribe(*kind);
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

    async fn forward_task(
        mut brx: broadcast::Receiver<(u64, ArcDaemonEvent)>,
        tx: mpsc::UnboundedSender<(u64, ArcDaemonEvent)>,
        mut cancel_rx: broadcast::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                biased;

                _ = cancel_rx.recv() => {
                    break;
                }

                result = brx.recv() => {
                    match result {
                        Ok(item) => {
                            if tx.send(item).is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                    }
                }
            }
        }
    }

    pub async fn unsubscribe(&self, client_id: &str) -> bool {
        let mut subs = self.subscriptions.write().await;
        if let Some(state) = subs.remove(client_id) {
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

    pub async fn update_subscription(
        &self,
        client_id: &str,
        kinds: Vec<DaemonEventKind>,
    ) -> mpsc::UnboundedReceiver<(u64, ArcDaemonEvent)> {
        self.subscribe(client_id, kinds).await
    }

    pub async fn get_subscription(&self, client_id: &str) -> Option<Vec<DaemonEventKind>> {
        let subs = self.subscriptions.read().await;
        subs.get(client_id).map(|state| state.kinds.clone())
    }

    pub async fn active_count(&self) -> usize {
        let subs = self.subscriptions.read().await;
        subs.len()
    }

    pub async fn clear_all(&self) {
        let mut subs = self.subscriptions.write().await;
        for state in subs.values() {
            let _ = state.cancel_tx.send(());
        }
        subs.clear();
    }
}
