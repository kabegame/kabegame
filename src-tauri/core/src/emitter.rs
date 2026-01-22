//! 全局事件发送器模块
//!
//! 替代原有的 runtime 模块，提供统一的事件发送接口。
//! 支持 Tauri 前端和 IPC Daemon 两种模式。

use crate::ipc::events::{DaemonEvent, DaemonEventKind};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};

#[cfg(feature = "tauri")]
use tauri::{AppHandle, Emitter, Manager};

/// 事件发送器 trait：抽象事件发送功能
pub trait EventEmitter: Send + Sync {
    /// 发送任务日志事件
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str);

    /// 发送下载状态事件
    fn emit_download_state(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        state: &str,
        error: Option<&str>,
    );

    /// 发送任务状态事件
    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    );

    /// 发送通用事件（用于扩展）
    fn emit(&self, event: &str, payload: serde_json::Value);

    /// 发送任务进度事件
    fn emit_task_progress(&self, task_id: &str, progress: f64);

    /// 发送任务错误事件
    fn emit_task_error(&self, task_id: &str, error: &str);

    /// 发送下载进度事件
    fn emit_download_progress(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        received_bytes: u64,
        total_bytes: Option<u64>,
    );

    /// 发送去重进度事件
    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    );

    /// 发送去重完成事件
    fn emit_dedupe_finished(&self, processed: usize, total: usize, removed: usize, canceled: bool);

    /// 发送壁纸图片更新事件
    fn emit_wallpaper_update_image(&self, image_path: &str);

    /// 发送壁纸样式更新事件
    fn emit_wallpaper_update_style(&self, style: &str);

    /// 发送壁纸过渡效果更新事件
    fn emit_wallpaper_update_transition(&self, transition: &str);

    /// 发送设置变更事件
    fn emit_setting_change(&self, changes: serde_json::Value);
}

/// 全局 emitter 单例存储
static GLOBAL_EMITTER: OnceLock<Arc<dyn EventEmitter>> = OnceLock::new();

/// 全局 EventEmitter（用于向后兼容和统一 API）
pub struct GlobalEmitter;

impl GlobalEmitter {
    /// 初始化全局 emitter（Tauri 版本）
    #[cfg(feature = "tauri")]
    pub fn init_global_tauri(app: AppHandle) -> Result<(), String> {
        GLOBAL_EMITTER
            .set(Arc::new(TauriEventEmitter::new(app)))
            .map_err(|_| "Global emitter already initialized".to_string())
    }

    /// 初始化全局 emitter（IPC 版本）
    pub fn init_global_ipc(broadcaster: Arc<dyn DaemonEventSink>) -> Result<(), String> {
        GLOBAL_EMITTER
            .set(Arc::new(IpcEventEmitter::new(broadcaster)))
            .map_err(|_| "Global emitter already initialized".to_string())
    }

    /// 获取全局 emitter 引用
    ///
    /// # Panics
    /// 如果尚未初始化，会 panic
    pub fn global() -> &'static dyn EventEmitter {
        GLOBAL_EMITTER
            .get()
            .map(|e| e.as_ref())
            .expect("Global emitter not initialized. Call GlobalEmitter::init_global_*() first.")
    }

    /// 尝试获取全局 emitter 引用
    ///
    /// # 返回
    /// 如果已初始化返回 Some，否则返回 None
    pub fn try_global() -> Option<&'static dyn EventEmitter> {
        GLOBAL_EMITTER.get().map(|e| e.as_ref())
    }
}

// ==================== Tauri 实现 ====================

#[cfg(feature = "tauri")]
pub struct TauriEventEmitter {
    app: AppHandle,
}

#[cfg(feature = "tauri")]
impl TauriEventEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(feature = "tauri")]
impl EventEmitter for TauriEventEmitter {
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        use crate::crawler::TaskLogEvent;
        use std::time::{SystemTime, UNIX_EPOCH};

        let task_id = task_id.trim();
        if task_id.is_empty() {
            return;
        }

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let _ = self.app.emit(
            "task-log",
            TaskLogEvent {
                task_id: task_id.to_string(),
                level: level.to_string(),
                message: message.to_string(),
                ts,
            },
        );
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
        let mut payload = serde_json::json!({
            "taskId": task_id,
            "url": url,
            "startTime": start_time,
            "pluginId": plugin_id,
            "state": state,
        });
        if let Some(e) = error {
            payload["error"] = serde_json::Value::String(e.to_string());
        }
        let _ = self.app.emit("download-state", payload);
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        let mut payload = serde_json::json!({
            "taskId": task_id,
            "status": status,
        });
        if let Some(p) = progress {
            payload["progress"] = serde_json::Value::Number(
                serde_json::Number::from_f64(p).unwrap_or_else(|| serde_json::Number::from(0)),
            );
        }
        if let Some(e) = error {
            payload["error"] = serde_json::Value::String(e.to_string());
        }
        if let Some(wp) = current_wallpaper {
            payload["currentWallpaper"] = serde_json::Value::String(wp.to_string());
        }
        let _ = self.app.emit("task-status", payload);
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    fn emit_task_progress(&self, task_id: &str, progress: f64) {
        let payload = serde_json::json!({
            "taskId": task_id,
            "progress": progress,
        });
        let _ = self.app.emit("task-progress", payload);
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        let payload = serde_json::json!({
            "taskId": task_id,
            "error": error,
        });
        let _ = self.app.emit("task-error", payload);
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
        let payload = serde_json::json!({
            "taskId": task_id,
            "url": url,
            "startTime": start_time,
            "pluginId": plugin_id,
            "receivedBytes": received_bytes,
            "totalBytes": total_bytes,
        });
        let _ = self.app.emit("download-progress", payload);
    }

    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        let payload = serde_json::json!({
            "processed": processed,
            "total": total,
            "removed": removed,
            "batchIndex": batch_index,
        });
        let _ = self.app.emit("dedupe-progress", payload);
    }

    fn emit_dedupe_finished(&self, processed: usize, total: usize, removed: usize, canceled: bool) {
        let payload = serde_json::json!({
            "processed": processed,
            "total": total,
            "removed": removed,
            "canceled": canceled,
        });
        let _ = self.app.emit("dedupe-finished", payload);
    }

    fn emit_wallpaper_update_image(&self, image_path: &str) {
        let _ = self.app.emit("wallpaper-update-image", image_path);
    }

    fn emit_wallpaper_update_style(&self, style: &str) {
        let _ = self.app.emit("wallpaper-update-style", style);
    }

    fn emit_wallpaper_update_transition(&self, transition: &str) {
        let _ = self.app.emit("wallpaper-update-transition", transition);
    }

    fn emit_setting_change(&self, changes: serde_json::Value) {
        let _ = self.app.emit("setting-change", changes);
    }
}

// ==================== IPC 实现 ====================

pub trait DaemonEventSink: Send + Sync {
    fn broadcast(&self, event: DaemonEvent);
    fn receiver_count(&self, kind: DaemonEventKind) -> usize;
}

/// 基于 IPC 的事件发送器
pub struct IpcEventEmitter {
    broadcaster: Arc<dyn DaemonEventSink>,
}

impl IpcEventEmitter {
    pub fn new(broadcaster: Arc<dyn DaemonEventSink>) -> Self {
        Self { broadcaster }
    }
}

impl EventEmitter for IpcEventEmitter {
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        let event = DaemonEvent::TaskLog {
            task_id: task_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        self.broadcaster.broadcast(event);
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
        if self
            .broadcaster
            .receiver_count(DaemonEventKind::DownloadState)
            == 0
        {
            return;
        }
        let event = DaemonEvent::DownloadState {
            task_id: task_id.to_string(),
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            state: state.to_string(),
            error: error.map(|e| e.to_string()),
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        let event = DaemonEvent::TaskStatus {
            task_id: task_id.to_string(),
            status: status.to_string(),
            progress,
            error: error.map(|e| e.to_string()),
            current_wallpaper: current_wallpaper.map(|w| w.to_string()),
        };
        self.broadcaster.broadcast(event);
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let event = DaemonEvent::Generic {
            event: event.to_string(),
            payload,
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_task_progress(&self, task_id: &str, progress: f64) {
        let event = DaemonEvent::TaskProgress {
            task_id: task_id.to_string(),
            progress,
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        let event = DaemonEvent::TaskError {
            task_id: task_id.to_string(),
            error: error.to_string(),
        };
        self.broadcaster.broadcast(event);
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
        if self
            .broadcaster
            .receiver_count(DaemonEventKind::DownloadProgress)
            == 0
        {
            return;
        }
        let event = DaemonEvent::DownloadProgress {
            task_id: task_id.to_string(),
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            received_bytes,
            total_bytes,
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        let event = DaemonEvent::DedupeProgress {
            processed,
            total,
            removed,
            batch_index,
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_dedupe_finished(&self, processed: usize, total: usize, removed: usize, canceled: bool) {
        let event = DaemonEvent::DedupeFinished {
            processed,
            total,
            removed,
            canceled,
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_wallpaper_update_image(&self, image_path: &str) {
        let event = DaemonEvent::WallpaperUpdateImage {
            image_path: image_path.to_string(),
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_wallpaper_update_style(&self, style: &str) {
        let event = DaemonEvent::WallpaperUpdateStyle {
            style: style.to_string(),
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_wallpaper_update_transition(&self, transition: &str) {
        let event = DaemonEvent::WallpaperUpdateTransition {
            transition: transition.to_string(),
        };
        self.broadcaster.broadcast(event);
    }

    fn emit_setting_change(&self, changes: serde_json::Value) {
        let event = DaemonEvent::SettingChange { changes };
        self.broadcaster.broadcast(event);
    }
}
