use std::sync::Arc;

use kabegame_core::emitter::DaemonEventSink;
use kabegame_core::ipc::events::{DaemonEvent, DaemonEventKind};
use kabegame_core::ipc::{CliIpcRequest, CliIpcResponse};
use tokio::sync::{broadcast, mpsc, RwLock};

#[cfg(target_os = "windows")]
use crate::server_windows::serve;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::server_unix::serve;

pub struct EventBroadcaster {
    next_id: Arc<RwLock<u64>>,
    event_txs: Vec<broadcast::Sender<(u64, DaemonEvent)>>,
    sync_tx: mpsc::UnboundedSender<DaemonEvent>,
}

impl EventBroadcaster {
    pub fn new(_max_queue_size: usize) -> Self {
        let mut event_txs = Vec::with_capacity(DaemonEventKind::COUNT);
        for _ in 0..DaemonEventKind::COUNT {
            let (tx, _) = broadcast::channel(1024);
            event_txs.push(tx);
        }

        let (sync_tx, mut sync_rx) = mpsc::unbounded_channel::<DaemonEvent>();

        let broadcaster = Self {
            next_id: Arc::new(RwLock::new(0)),
            event_txs,
            sync_tx,
        };

        let next_id = broadcaster.next_id.clone();
        let event_txs = broadcaster.event_txs.clone();
        tokio::spawn(async move {
            while let Some(event) = sync_rx.recv().await {
                let event_with_id = {
                    let mut next_id_guard = next_id.write().await;
                    let id = *next_id_guard;
                    *next_id_guard += 1;
                    (id, event.clone())
                };

                let idx = event.kind().as_usize();
                let tx = match event_txs.get(idx) {
                    Some(tx) => tx,
                    None => {
                        eprintln!("[DEBUG] EventBroadcaster 路由失败(同步)：idx={} 越界", idx);
                        continue;
                    }
                };

                let receiver_count = tx.receiver_count();

                if receiver_count == 0 {
                    continue;
                }

                let _ = tx.send(event_with_id);
            }
        });

        broadcaster
    }

    pub async fn broadcast(&self, event: DaemonEvent) {
        let _ = self.sync_tx.send(event);
    }

    pub fn broadcast_sync(&self, event: DaemonEvent) {
        let _ = self.sync_tx.send(event);
    }

    pub fn subscribe(&self, kind: DaemonEventKind) -> broadcast::Receiver<(u64, DaemonEvent)> {
        self.event_txs[kind.as_usize()].subscribe()
    }

    pub fn subscribe_all_stream(&self) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        self.subscribe_filtered_stream(&DaemonEventKind::ALL)
    }

    pub fn subscribe_filtered_stream(
        &self,
        kinds: &[DaemonEventKind],
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
        let (tx, rx) = mpsc::unbounded_channel::<(u64, DaemonEvent)>();

        for kind in kinds {
            let mut brx = self.subscribe(*kind);
            let tx = tx.clone();
            tokio::spawn(async move {
                loop {
                    match brx.recv().await {
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
            });
        }

        rx
    }

    pub async fn latest_id(&self) -> u64 {
        let next_id = self.next_id.read().await;
        next_id.saturating_sub(1)
    }

    pub fn receiver_count(&self, kind: DaemonEventKind) -> usize {
        let idx = kind.as_usize();
        match self.event_txs.get(idx) {
            Some(tx) => tx.receiver_count(),
            None => 0,
        }
    }
}

impl Default for EventBroadcaster {
    fn default() -> Self {
        Self::new(1000)
    }
}

impl DaemonEventSink for EventBroadcaster {
    fn broadcast(&self, event: DaemonEvent) {
        self.broadcast_sync(event);
    }

    fn receiver_count(&self, kind: DaemonEventKind) -> usize {
        EventBroadcaster::receiver_count(self, kind)
    }
}

struct SubscriptionState {
    kinds: Vec<DaemonEventKind>,
    cancel_tx: broadcast::Sender<()>,
}

pub struct SubscriptionManager {
    broadcaster: Arc<EventBroadcaster>,
    subscriptions: Arc<RwLock<std::collections::HashMap<String, SubscriptionState>>>,
}

impl SubscriptionManager {
    pub fn new(broadcaster: Arc<EventBroadcaster>) -> Self {
        Self {
            broadcaster,
            subscriptions: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    pub async fn subscribe(
        &self,
        client_id: &str,
        kinds: Vec<DaemonEventKind>,
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
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

        let (forward_tx, forward_rx) = mpsc::unbounded_channel::<(u64, DaemonEvent)>();

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

    async fn forward_task(
        mut brx: broadcast::Receiver<(u64, DaemonEvent)>,
        tx: mpsc::UnboundedSender<(u64, DaemonEvent)>,
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
    ) -> mpsc::UnboundedReceiver<(u64, DaemonEvent)> {
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

pub async fn serve_with_events<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve_impl(handler, broadcaster, subscription_manager).await
}

async fn serve_impl<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
    subscription_manager: Option<Arc<SubscriptionManager>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve(handler, broadcaster, subscription_manager).await
}
