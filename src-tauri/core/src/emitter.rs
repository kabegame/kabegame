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
#[cfg(feature = "ipc-server")]
use crate::storage::Storage;
use std::sync::OnceLock;

// ==================== IPC 实现 ====================

/// 全局 IPC 事件发送器
///
/// 注意：此类型仅在启用 `ipc-server` feature 时可用
#[cfg(feature = "ipc-server")]
pub struct GlobalEmitter;

// TODO: 写一个emit宏，用于简化事件发送
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
        let _ = Storage::global().add_task_log(task_id, level, message);
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
        self.emit_download_state_with_native(task_id, url, start_time, plugin_id, state, error, false);
    }

    pub fn emit_download_state_with_native(
        &self,
        task_id: &str,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        state: &str,
        error: Option<&str>,
        native: bool,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::DownloadState {
            task_id: task_id.to_string(),
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            state: state.to_string(),
            error: error.map(|e| e.to_string()),
            native,
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

    /// 发送整理进度事件
    pub fn emit_organize_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        regenerated: usize,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::OrganizeProgress {
            processed,
            total,
            removed,
            regenerated,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送整理完成事件
    pub fn emit_organize_finished(
        &self,
        removed: usize,
        regenerated: usize,
        canceled: bool,
    ) {
        let event = std::sync::Arc::new(DaemonEvent::OrganizeFinished {
            removed,
            regenerated,
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

    /// 发送设置变更事件
    pub fn emit_setting_change(&self, changes: serde_json::Value) {
        let event = std::sync::Arc::new(DaemonEvent::SettingChange { changes });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送图片变更事件（如整理删除、批量操作等导致图库变化）
    pub fn emit_images_change(&self, reason: &str, image_ids: &[String]) {
        let event = std::sync::Arc::new(DaemonEvent::ImagesChange {
            reason: reason.to_string(),
            image_ids: image_ids.to_vec(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送畅游记录变更事件（用于前端刷新畅游列表）
    pub fn emit_surf_records_change(&self, reason: &str, surf_record_id: &str) {
        let event = std::sync::Arc::new(DaemonEvent::SurfRecordsChange {
            reason: reason.to_string(),
            surf_record_id: surf_record_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送 Daemon 关闭事件（退出前通知 IPC 客户端）
    pub fn emit_daemon_shutdown(&self, reason: &str) {
        let event = std::sync::Arc::new(DaemonEvent::DaemonShutdown {
            reason: reason.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册名称变更事件（底层 DB 重命名后由 storage 调用，前端与 VD 据此更新）
    pub fn emit_album_name_changed(&self, album_id: &str, new_name: &str) {
        let event = std::sync::Arc::new(DaemonEvent::AlbumNameChanged {
            album_id: album_id.to_string(),
            new_name: new_name.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册添加事件（底层 DB 插入后由 storage 调用）
    pub fn emit_album_added(&self, id: &str, name: &str, created_at: u64) {
        let event = std::sync::Arc::new(DaemonEvent::AlbumAdded {
            id: id.to_string(),
            name: name.to_string(),
            created_at,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册删除事件（底层 DB 删除后由 storage 调用）
    pub fn emit_album_deleted(&self, album_id: &str) {
        let event = std::sync::Arc::new(DaemonEvent::AlbumDeleted {
            album_id: album_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 从存储读取任务并发送 task-status，用于下载失败等场景下刷新任务列表（避免一直显示“处理中”）。
    pub fn emit_task_status_from_storage(&self, task_id: &str) {
        let storage = crate::storage::Storage::global();
        if let Ok(Some(task)) = storage.get_task(task_id) {
            self.emit_task_status(
                task_id,
                &task.status,
                Some(task.progress),
                task.start_time,
                task.end_time,
                task.error.as_deref(),
                None,
            );
        }
    }
}

/// 全局 emitter 单例存储
#[cfg(feature = "ipc-server")]
static GLOBAL_EMITTER: OnceLock<GlobalEmitter> = OnceLock::new();

// ==================== No-op 实现 ====================

/// No-op 全局事件发送器
///
/// 用于在未启用 `ipc-server` feature 时通过编译。
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

    pub fn emit_download_state_with_native(
        &self,
        _task_id: &str,
        _url: &str,
        _start_time: u64,
        _plugin_id: &str,
        _state: &str,
        _error: Option<&str>,
        _native: bool,
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

    pub fn emit_organize_progress(
        &self,
        _processed: usize,
        _total: usize,
        _removed: usize,
        _regenerated: usize,
    ) {
    }

    pub fn emit_organize_finished(
        &self,
        _removed: usize,
        _regenerated: usize,
        _canceled: bool,
    ) {
    }

    pub fn emit_wallpaper_update_image(&self, _image_path: &str) {}

    pub fn emit_setting_change(&self, _changes: serde_json::Value) {}

    pub fn emit_images_change(&self, _reason: &str, _image_ids: &[String]) {}

    pub fn emit_surf_records_change(&self, _reason: &str, _surf_record_id: &str) {}

    pub fn emit_daemon_shutdown(&self, _reason: &str) {}

    pub fn emit_album_name_changed(&self, _album_id: &str, _new_name: &str) {}

    pub fn emit_album_added(&self, _id: &str, _name: &str, _created_at: u64) {}

    pub fn emit_album_deleted(&self, _album_id: &str) {}

    pub fn emit_pending_queue_change(&self, _pending_count: usize) {}

    pub fn emit_task_status_from_storage(&self, _task_id: &str) {}
}
