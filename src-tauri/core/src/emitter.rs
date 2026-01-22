//! 全局事件发送器模块
//!
//! 替代原有的 runtime 模块，提供统一的事件发送接口。
//! 直接使用 IPC 事件发送器实现。

use crate::ipc::events::{DaemonEvent, DaemonEventKind};
use crate::server::EventBroadcaster;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

// ==================== IPC 实现 ====================

/// 全局 IPC 事件发送器
pub struct GlobalEmitter {
    broadcaster: crate::server::EventBroadcaster,
}

impl GlobalEmitter {
    /// 创建新的全局 emitter
    pub fn new(broadcaster: crate::server::EventBroadcaster) -> Self {
        Self { broadcaster }
    }

    /// 初始化全局 emitter
    ///
    /// # Panics
    /// 如果已经初始化，会 panic
    pub fn init_global(broadcaster: crate::server::EventBroadcaster) -> Result<(), String> {
        GLOBAL_EMITTER
            .set(Self::new(broadcaster))
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
        let event = DaemonEvent::TaskLog {
            task_id: task_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        };
        self.broadcaster.broadcast_sync(event);
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
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送任务状态事件
    pub fn emit_task_status(
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
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送通用事件（用于扩展）
    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        let event = DaemonEvent::Generic {
            event: event.to_string(),
            payload,
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送任务进度事件
    pub fn emit_task_progress(&self, task_id: &str, progress: f64) {
        let event = DaemonEvent::TaskProgress {
            task_id: task_id.to_string(),
            progress,
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送任务错误事件
    pub fn emit_task_error(&self, task_id: &str, error: &str) {
        let event = DaemonEvent::TaskError {
            task_id: task_id.to_string(),
            error: error.to_string(),
        };
        self.broadcaster.broadcast_sync(event);
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
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送去重进度事件
    pub fn emit_dedupe_progress(
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
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送去重完成事件
    pub fn emit_dedupe_finished(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        canceled: bool,
    ) {
        let event = DaemonEvent::DedupeFinished {
            processed,
            total,
            removed,
            canceled,
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送壁纸图片更新事件
    pub fn emit_wallpaper_update_image(&self, image_path: &str) {
        let event = DaemonEvent::WallpaperUpdateImage {
            image_path: image_path.to_string(),
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送壁纸样式更新事件
    pub fn emit_wallpaper_update_style(&self, style: &str) {
        let event = DaemonEvent::WallpaperUpdateStyle {
            style: style.to_string(),
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送壁纸过渡效果更新事件
    pub fn emit_wallpaper_update_transition(&self, transition: &str) {
        let event = DaemonEvent::WallpaperUpdateTransition {
            transition: transition.to_string(),
        };
        self.broadcaster.broadcast_sync(event);
    }

    /// 发送设置变更事件
    pub fn emit_setting_change(&self, changes: serde_json::Value) {
        let event = DaemonEvent::SettingChange { changes };
        self.broadcaster.broadcast_sync(event);
    }
}

/// 全局 emitter 单例存储
static GLOBAL_EMITTER: OnceLock<GlobalEmitter> = OnceLock::new();
