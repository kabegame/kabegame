//! 全局事件发送器模块
//!
//! 替代原有的 runtime 模块，提供统一的事件发送接口。
//! 直接使用 IPC 事件发送器实现。
//!
//! 注意：此模块需要 `ipc-server` feature，因为它依赖于 EventBroadcaster。

#[cfg(feature = "ipc-server")]
use crate::ipc::events::DaemonEvent;
#[cfg(feature = "ipc-server")]
use crate::ipc::server::EventBroadcaster;
use std::sync::OnceLock;

// ==================== IPC 实现 ====================

/// 全局 IPC 事件发送器
///
/// 注意：此类型仅在启用 `ipc-server` feature 时可用
#[cfg(feature = "ipc-server")]
pub struct GlobalEmitter;

#[cfg(feature = "ipc-server")]
impl GlobalEmitter {
    /// 初始化全局 emitter
    ///
    /// # Panics
    /// 如果已经初始化，会 panic
    pub fn init_global() -> Result<(), String> {
        GLOBAL_EMITTER
            .set(GlobalEmitter)
            .map_err(|_| "Global emitter already initialized".to_string())
    }

    /// 获取全局 emitter 引用
    ///
    /// # Panics
    /// 如果尚未初始化，会 panic
    pub fn global() -> &'static GlobalEmitter {
        GLOBAL_EMITTER
            .get()
            .expect("Global emitter not initialized. Call GlobalEmitter::init_global() first.")
    }

    /// 尝试获取全局 emitter 引用
    ///
    /// # 返回
    /// 如果已初始化返回 Some，否则返回 None
    pub fn try_global() -> Option<&'static GlobalEmitter> {
        GLOBAL_EMITTER.get()
    }

    /// 发送任务日志事件
    pub fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        let event = std::sync::Arc::new(DaemonEvent::TaskLog {
            task_id: task_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送下载状态事件
    pub fn emit_download_state(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        state: &str,
        error: Option<&str>,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::DownloadState {
            task_id: task_id.to_string(),
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            state: state.to_string(),
            error: error.map(|e| e.to_string()),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送任务状态事件
    pub fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        start_time: Option<u64>,
        end_time: Option<u64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::TaskStatus {
            task_id: task_id.to_string(),
            status: status.to_string(),
            progress,
            start_time,
            end_time,
            error: error.map(|e| e.to_string()),
            current_wallpaper: current_wallpaper.map(|w| w.to_string()),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送通用事件（用于扩展）
    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        let event = std::sync::Arc::new(DaemonEvent::Generic {
            event: event.to_string(),
            payload,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送任务进度事件
    pub fn emit_task_progress(&self, task_id: &str, progress: f64) {
        let event = std::sync::Arc::new(DaemonEvent::TaskProgress {
            task_id: task_id.to_string(),
            progress,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送任务错误事件
    pub fn emit_task_error(&self, task_id: &str, error: &str) {
        let event = std::sync::Arc::new(DaemonEvent::TaskError {
            task_id: task_id.to_string(),
            error: error.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送下载进度事件
    pub fn emit_download_progress(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        received_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::DownloadProgress {
            task_id: task_id.to_string(),
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            received_bytes,
            total_bytes,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送去重进度事件
    pub fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::DedupeProgress {
            processed,
            total,
            removed,
            batch_index,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送去重完成事件
    pub fn emit_dedupe_finished(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        canceled: bool,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::DedupeFinished {
            processed,
            total,
            removed,
            canceled,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送壁纸图片更新事件
    pub fn emit_wallpaper_update_image(&self, image_path: &str) {
        let event = std::sync::Arc::new(DaemonEvent::WallpaperUpdateImage {
            image_path: image_path.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送壁纸样式更新事件
    pub fn emit_wallpaper_update_style(&self, style: &str) {
        let event = std::sync::Arc::new(DaemonEvent::WallpaperUpdateStyle {
            style: style.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送壁纸过渡效果更新事件
    pub fn emit_wallpaper_update_transition(&self, transition: &str) {
        let event = std::sync::Arc::new(DaemonEvent::WallpaperUpdateTransition {
            transition: transition.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送设置变更事件
    pub fn emit_setting_change(&self, changes: serde_json::Value) {
        let event = std::sync::Arc::new(DaemonEvent::SettingChange { changes });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送 pending 队列变化事件
    pub fn emit_pending_queue_change(&self, pending_count: usize) {
        let event = std::sync::Arc::new(DaemonEvent::PendingQueueChange { pending_count });
        EventBroadcaster::global().broadcast(event);
    }
}

/// 全局 emitter 单例存储
#[cfg(feature = "ipc-server")]
static GLOBAL_EMITTER: OnceLock<GlobalEmitter> = OnceLock::new();

// ==================== No-op 实现 ====================

/// No-op 全局事件发送器
///
/// 用于在未启用 `ipc-server` feature 时（如 plugin-editor）通过编译。
/// 所有方法均为空实现。
#[cfg(not(feature = "ipc-server"))]
pub struct GlobalEmitter;

#[cfg(not(feature = "ipc-server"))]
impl GlobalEmitter {
    /// 获取全局 emitter 引用（No-op）
    pub fn global() -> &'static GlobalEmitter {
        static INSTANCE: GlobalEmitter = GlobalEmitter;
        &INSTANCE
    }

    /// 尝试获取全局 emitter 引用（No-op）
    pub fn try_global() -> Option<&'static GlobalEmitter> {
        Some(Self::global())
    }

    pub fn emit_task_log(&self, _task_id: &str, _level: &str, _message: &str) {}

    pub fn emit_download_state(
        &self,
        _task_id: &str,
        _url: &str,
        _start_time: u64,
        _plugin_id: &str,
        _state: &str,
        _error: Option<&str>,
    ) {
    }

    pub fn emit_task_status(
        &self,
        _task_id: &str,
        _status: &str,
        _progress: Option<f64>,
        _start_time: Option<u64>,
        _end_time: Option<u64>,
        _error: Option<&str>,
        _current_wallpaper: Option<&str>,
    ) {
    }

    pub fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    pub fn emit_task_progress(&self, _task_id: &str, _progress: f64) {}

    pub fn emit_task_error(&self, _task_id: &str, _error: &str) {}

    pub fn emit_download_progress(
        &self,
        _task_id: &str,
        _url: &str,
        _start_time: u64,
        _plugin_id: &str,
        _received_bytes: u64,
        _total_bytes: Option<u64>,
    ) {
    }

    pub fn emit_dedupe_progress(
        &self,
        _processed: usize,
        _total: usize,
        _removed: usize,
        _batch_index: usize,
    ) {
    }

    pub fn emit_dedupe_finished(
        &self,
        _processed: usize,
        _total: usize,
        _removed: usize,
        _canceled: bool,
    ) {
    }

    pub fn emit_wallpaper_update_image(&self, _image_path: &str) {}

    pub fn emit_wallpaper_update_style(&self, _style: &str) {}

    pub fn emit_wallpaper_update_transition(&self, _transition: &str) {}

    pub fn emit_setting_change(&self, _changes: serde_json::Value) {}

    pub fn emit_pending_queue_change(&self, _pending_count: usize) {}
}
