//! runtime 里的 state 已经全部用
use crate::ipc::EventBroadcaster;
use crate::runtime::EventEmitter;
use std::sync::Arc;

/// 基于 IPC 的事件发送器
pub struct IpcEventEmitter {
    broadcaster: Arc<EventBroadcaster>,
}

impl IpcEventEmitter {
    pub fn new(broadcaster: Arc<EventBroadcaster>) -> Self {
        Self { broadcaster }
    }
}

impl EventEmitter for IpcEventEmitter {
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        let level = level.to_string();
        let message = message.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_task_log(&bc, task_id, level, message).await;
        });
    }

    fn emit_download_state(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        state: &str,
        error: Option<&str>,
    ) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        let url = url.to_string();
        let plugin_id = plugin_id.to_string();
        let state = state.to_string();
        let error = error.map(|e| e.to_string());
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_download_state(
                &bc, task_id, url, start_time, plugin_id, state, error,
            )
            .await;
        });
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        let status = status.to_string();
        let error = error.map(|e| e.to_string());
        let current_wallpaper = current_wallpaper.map(|w| w.to_string());
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_task_status(
                &bc,
                task_id,
                status,
                progress,
                error,
                current_wallpaper,
            )
            .await;
        });
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let bc = self.broadcaster.clone();
        let event = event.to_string();
        let payload = payload;
        tokio::spawn(async move {
            bc.broadcast(crate::ipc::events::DaemonEvent::Generic { event, payload })
                .await;
        });
    }

    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        let bc = self.broadcaster.clone();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_dedupe_progress(
                &bc,
                processed,
                total,
                removed,
                batch_index,
            )
            .await;
        });
    }

    fn emit_dedupe_finished(&self, processed: usize, total: usize, removed: usize, canceled: bool) {
        let bc = self.broadcaster.clone();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_dedupe_finished(&bc, processed, total, removed, canceled)
                .await;
        });
    }

    fn emit_task_progress(&self, task_id: &str, progress: f64) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_task_progress(&bc, task_id, progress).await;
        });
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        let error = error.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_task_error(&bc, task_id, error).await;
        });
    }

    fn emit_download_progress(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        received_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let bc = self.broadcaster.clone();
        let task_id = task_id.to_string();
        let url = url.to_string();
        let plugin_id = plugin_id.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_download_progress(
                &bc,
                task_id,
                url,
                start_time,
                plugin_id,
                received_bytes,
                total_bytes,
            )
            .await;
        });
    }

    fn emit_wallpaper_update_image(&self, image_path: &str) {
        let bc = self.broadcaster.clone();
        let image_path = image_path.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_wallpaper_update_image(&bc, image_path).await;
        });
    }

    fn emit_wallpaper_update_style(&self, style: &str) {
        let bc = self.broadcaster.clone();
        let style = style.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_wallpaper_update_style(&bc, style).await;
        });
    }

    fn emit_wallpaper_update_transition(&self, transition: &str) {
        let bc = self.broadcaster.clone();
        let transition = transition.to_string();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_wallpaper_update_transition(&bc, transition).await;
        });
    }
}

impl IpcEventEmitter {
    /// 发送设置变更事件
    pub fn emit_setting_change(&self, changes: serde_json::Value) {
        let bc = self.broadcaster.clone();
        tokio::spawn(async move {
            bc.broadcast(crate::ipc::events::DaemonEvent::SettingChange { changes }).await;
        });
    }
}
