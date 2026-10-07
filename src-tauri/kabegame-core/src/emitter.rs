//! 全局事件发送器模块
//!
//! 替代原有的 runtime 模块，提供统一的事件发送接口。
//! 直接使用 IPC 事件发送器实现。
//!
//! 注意：此模块需要 `ipc-server` feature，因为它依赖于 EventBroadcaster。

use crate::crawler::downloader::DownloadState;
#[cfg(feature = "ipc-server")]
use crate::ipc::events::AppEvent;
use crate::ipc::events::ImagePatch;
#[cfg(feature = "ipc-server")]
use crate::ipc::server::EventBroadcaster;
use crate::storage::tasks::TaskFailedImage;
#[cfg(feature = "ipc-server")]
use crate::storage::Storage;
#[cfg(feature = "ipc-server")]
use serde_json::json;
#[cfg(feature = "ipc-server")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "ipc-server")]
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(feature = "ipc-server")]
static CHANGE_SEQ: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "ipc-server")]
static HELD_VIEW_EVENTS: Mutex<(usize, Vec<Arc<AppEvent>>)> = Mutex::new((0, Vec::new()));

/// 持有期间，视图相关事件仍分配序号，但延迟到最后一个守卫析构时广播。
pub struct EventHold(());

/// 返回最近一次已发出的图片或画册图片变更序号。
#[cfg(feature = "ipc-server")]
pub fn current_change_seq() -> u64 {
    CHANGE_SEQ.load(Ordering::SeqCst)
}

#[cfg(feature = "ipc-server")]
pub(crate) fn next_change_seq() -> u64 {
    CHANGE_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

/// 未启用事件服务时没有变更序号。
#[cfg(not(feature = "ipc-server"))]
pub fn current_change_seq() -> u64 {
    0
}

#[cfg(not(feature = "ipc-server"))]
pub(crate) fn next_change_seq() -> u64 {
    0
}

#[cfg(feature = "ipc-server")]
pub(crate) fn dispatch_view_event(event: Arc<AppEvent>) {
    let mut held = HELD_VIEW_EVENTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if held.0 > 0 {
        held.1.push(event);
    } else {
        EventBroadcaster::global().broadcast(event);
    }
}

#[cfg(feature = "ipc-server")]
impl Drop for EventHold {
    fn drop(&mut self) {
        let mut held = HELD_VIEW_EVENTS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        held.0 = held.0.saturating_sub(1);
        if held.0 == 0 {
            for event in held.1.drain(..) {
                EventBroadcaster::global().broadcast(event);
            }
        }
    }
}

#[cfg(not(feature = "ipc-server"))]
impl Drop for EventHold {
    fn drop(&mut self) {}
}

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

    pub fn hold(&self) -> EventHold {
        let mut held = HELD_VIEW_EVENTS
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        held.0 += 1;
        EventHold(())
    }

    /// 发送任务日志事件
    pub fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        let _ = Storage::global().add_task_log(task_id, level, message);
        let event = std::sync::Arc::new(AppEvent::TaskLog {
            task_id: task_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    pub fn emit_download_state(
        &self,
        id: u64,
        url: &str,
        start_time: u64,
        plugin_id: &str,
        state: DownloadState,
        error: Option<&str>,
        retried_for: Option<i64>,
    ) {
        let event = std::sync::Arc::new(AppEvent::DownloadState {
            id,
            url: url.to_string(),
            start_time,
            plugin_id: plugin_id.to_string(),
            state,
            error: error.map(|e| e.to_string()),
            retried_for,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送下载条目移除事件（后端 wait 完成后调用，前端据此从活跃列表删除）
    pub fn emit_download_removed(&self, id: u64) {
        let event = std::sync::Arc::new(AppEvent::DownloadRemoved { id });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送通用事件（用于扩展）
    pub fn emit(&self, event: &str, payload: serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::Generic {
            event: event.to_string(),
            payload,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送任务进度事件（统一走 `tasks-change` / `TaskChanged`）
    pub fn emit_task_progress(&self, task_id: &str, progress: f64) {
        self.emit_task_changed(task_id, json!({ "progress": progress }));
    }

    /// 任务新增（完整任务 JSON）
    pub fn emit_task_added(&self, task: &serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::TaskAdded { task: task.clone() });
        EventBroadcaster::global().broadcast(event);
    }

    /// 任务删除
    pub fn emit_task_deleted(&self, task_id: &str) {
        let event = std::sync::Arc::new(AppEvent::TaskDeleted {
            task_id: task_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 任务字段增量更新
    pub fn emit_task_changed(&self, task_id: &str, diff: serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::TaskChanged {
            task_id: task_id.to_string(),
            diff,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 后台忙碌任务开始或变为可见时唤醒前端快照轮询。
    pub fn emit_busy_tasks_change(&self, kind: &str) {
        self.emit("busy-tasks-change", json!({ "kind": kind }));
    }

    /// 发送整理完成事件
    pub fn emit_organize_finished(
        &self,
        removed: usize,
        regenerated: usize,
        backfilled: usize,
        canceled: bool,
        error: Option<String>,
    ) {
        let event = std::sync::Arc::new(AppEvent::OrganizeFinished {
            removed,
            regenerated,
            backfilled,
            canceled,
            error,
        });
        EventBroadcaster::global().broadcast(event);
    }

    pub fn emit_hidden_cleanup_finished(
        &self,
        removed: usize,
        kept_files: usize,
        canceled: bool,
        error: Option<String>,
    ) {
        let event = std::sync::Arc::new(AppEvent::HiddenCleanupFinished {
            removed,
            kept_files,
            canceled,
            error,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送壁纸图片更新事件
    pub fn emit_wallpaper_update_image(&self, image_path: &str) {
        let event = std::sync::Arc::new(AppEvent::WallpaperUpdateImage {
            image_path: image_path.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送设置变更事件
    pub fn emit_setting_change(&self, changes: serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::SettingChange { changes });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送 `ImageInfo` 字段绝对值快照。
    pub fn emit_image_changed(&self, patches: Vec<ImagePatch>) {
        if patches.is_empty() {
            return;
        }
        let seq = next_change_seq();
        let event = std::sync::Arc::new(AppEvent::ImageChanged { seq, patches });
        dispatch_view_event(event);
    }

    /// 发送一批图片共享同一份字段绝对值快照的增量事件。
    pub fn emit_image_changed_uniform(&self, image_ids: &[String], diff: serde_json::Value) {
        if image_ids.is_empty() {
            return;
        }
        self.emit_image_changed(vec![ImagePatch {
            image_ids: image_ids.to_vec(),
            diff,
        }]);
    }

    /// 发送 `images` 表变更事件（reason: `add` | `delete` | `change`）
    pub fn emit_images_change(
        &self,
        reason: &str,
        image_ids: &[String],
        task_ids: Option<&[String]>,
        surf_record_ids: Option<&[String]>,
        plugin_ids: Option<&[String]>,
    ) {
        let seq = next_change_seq();
        let opt_vec = |s: Option<&[String]>| {
            s.and_then(|v| if v.is_empty() { None } else { Some(v.to_vec()) })
        };
        let event = std::sync::Arc::new(AppEvent::ImagesChange {
            seq,
            reason: reason.to_string(),
            image_ids: image_ids.to_vec(),
            task_ids: opt_vec(task_ids),
            surf_record_ids: opt_vec(surf_record_ids),
            plugin_ids: opt_vec(plugin_ids),
        });
        dispatch_view_event(event);
    }

    /// 畅游记录新增（完整 record JSON）
    pub fn emit_surf_record_added(&self, record: serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::SurfRecordAdded { record });
        EventBroadcaster::global().broadcast(event);
    }

    /// 畅游记录删除
    pub fn emit_surf_record_deleted(&self, surf_record_id: &str) {
        let event = std::sync::Arc::new(AppEvent::SurfRecordDeleted {
            surf_record_id: surf_record_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 畅游记录字段增量更新（与 `TaskChanged` 类似，diff 为绝对值快照）
    pub fn emit_surf_record_changed(&self, surf_record_id: &str, diff: serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::SurfRecordChanged {
            surf_record_id: surf_record_id.to_string(),
            diff,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送失败图片新增事件
    pub fn emit_failed_image_added(&self, task_id: &str, failed_image: &TaskFailedImage) {
        let event = std::sync::Arc::new(AppEvent::FailedImagesChange {
            reason: "added".to_string(),
            task_id: task_id.to_string(),
            failed_image_ids: Some(vec![failed_image.id]),
            failed_images: Some(vec![failed_image.clone()]),
            failed_image: Some(failed_image.clone()),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送失败图片移除事件
    pub fn emit_failed_image_removed(&self, task_id: &str, failed_image_id: i64) {
        self.emit_failed_images_removed(task_id, &[failed_image_id]);
    }

    /// 发送失败图片批量移除事件
    pub fn emit_failed_images_removed(&self, task_id: &str, failed_image_ids: &[i64]) {
        let event = std::sync::Arc::new(AppEvent::FailedImagesChange {
            reason: "removed".to_string(),
            task_id: task_id.to_string(),
            failed_image_ids: Some(failed_image_ids.to_vec()),
            failed_images: None,
            failed_image: None,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送失败图片更新事件
    pub fn emit_failed_image_updated(&self, task_id: &str, failed_image: &TaskFailedImage) {
        let event = std::sync::Arc::new(AppEvent::FailedImagesChange {
            reason: "updated".to_string(),
            task_id: task_id.to_string(),
            failed_image_ids: Some(vec![failed_image.id]),
            failed_images: None,
            failed_image: Some(failed_image.clone()),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送任务图片数量更新事件（统一走 `tasks-change` / `TaskChanged`）
    pub fn emit_task_image_counts(
        &self,
        task_id: &str,
        success_count: Option<i64>,
        deleted_count: Option<i64>,
        failed_count: Option<i64>,
        dedup_count: Option<i64>,
    ) {
        let mut diff = serde_json::Map::new();
        if let Some(v) = success_count {
            diff.insert("successCount".to_string(), json!(v));
        }
        if let Some(v) = deleted_count {
            diff.insert("deletedCount".to_string(), json!(v));
        }
        if let Some(v) = failed_count {
            diff.insert("failedCount".to_string(), json!(v));
        }
        if let Some(v) = dedup_count {
            diff.insert("dedupCount".to_string(), json!(v));
        }
        if diff.is_empty() {
            return;
        }
        self.emit_task_changed(task_id, serde_json::Value::Object(diff));
    }

    /// 发送应用关闭事件（退出前通知 IPC 客户端）。
    pub fn emit_app_shutdown(&self, reason: &str) {
        let event = std::sync::Arc::new(AppEvent::AppShutdown {
            reason: reason.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册属性变更事件（重命名、移动等；`changes` 为增量 JSON）
    pub fn emit_album_changed(&self, album_id: &str, changes: serde_json::Value) {
        let seq = next_change_seq();
        let event = std::sync::Arc::new(AppEvent::AlbumChanged {
            seq,
            album_id: album_id.to_string(),
            changes,
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册添加事件（底层 DB 插入后由 storage 调用）
    pub fn emit_album_added(&self, album: &crate::storage::Album) {
        let event = std::sync::Arc::new(AppEvent::AlbumAdded {
            id: album.id.clone(),
            name: album.name.clone(),
            created_at: album.created_at,
            parent_id: album.parent_id.clone(),
            album_type: album.kind.clone(),
            sync_folder: album.sync_folder.clone(),
            folder_status: album.folder_status.clone(),
            sync_mode: album.sync_mode.clone(),
            ancestor_path: album.ancestor_path.clone(),
            label_key: album.label_key.clone(),
            label_path: album.label_path.clone(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 发送画册删除事件（底层 DB 删除后由 storage 调用）
    pub fn emit_album_deleted(&self, album: &crate::storage::Album) {
        let event = std::sync::Arc::new(AppEvent::AlbumDeleted {
            album_id: album.id.clone(),
            parent_id: album.parent_id.clone(),
            ancestor_path: album.ancestor_path.clone(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 运行配置变更（`reason`: `configadd` | `configdelete` | `configchange`）
    pub fn emit_auto_config_change(&self, reason: &str, config_id: &str) {
        let event = std::sync::Arc::new(AppEvent::AutoConfigChange {
            reason: reason.to_string(),
            config_id: config_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 插件新增安装（首次安装，完整 Plugin JSON）
    pub fn emit_plugin_added(&self, plugin: &serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::PluginAdded {
            plugin: plugin.clone(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 插件卸载
    pub fn emit_plugin_deleted(&self, plugin_id: &str) {
        let event = std::sync::Arc::new(AppEvent::PluginDeleted {
            plugin_id: plugin_id.to_string(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 插件更新/重装（同 ID 覆盖安装，完整 Plugin JSON）
    pub fn emit_plugin_updated(&self, plugin: &serde_json::Value) {
        let event = std::sync::Arc::new(AppEvent::PluginUpdated {
            plugin: plugin.clone(),
        });
        EventBroadcaster::global().broadcast(event);
    }

    /// 从存储读取任务并发送 `TaskChanged`，用于下载失败等场景下刷新任务列表（避免一直显示“处理中”）。
    pub fn emit_task_status_from_storage(&self, task_id: &str) {
        let storage = crate::storage::Storage::global();
        if let Ok(Some(task)) = storage.get_task(task_id) {
            let mut diff = serde_json::Map::new();
            diff.insert("status".to_string(), json!(task.status));
            diff.insert("progress".to_string(), json!(task.progress));
            if let Some(t) = task.start_time {
                diff.insert("startTime".to_string(), json!(t));
            }
            if let Some(t) = task.end_time {
                diff.insert("endTime".to_string(), json!(t));
            }
            if let Some(ref e) = task.error {
                diff.insert("error".to_string(), json!(e));
            }
            self.emit_task_changed(task_id, serde_json::Value::Object(diff));
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
    /// No-op 模式无需建立 IPC 单例，保留统一初始化接口供 standalone 调用方复用。
    pub fn init_global() -> Result<(), String> {
        Ok(())
    }

    /// 获取全局 emitter 引用（No-op）
    pub fn global() -> &'static GlobalEmitter {
        static INSTANCE: GlobalEmitter = GlobalEmitter;
        &INSTANCE
    }

    /// 尝试获取全局 emitter 引用（No-op）
    pub fn try_global() -> Option<&'static GlobalEmitter> {
        Some(Self::global())
    }

    pub fn hold(&self) -> EventHold {
        EventHold(())
    }

    pub fn emit_task_log(&self, _task_id: &str, _level: &str, _message: &str) {}

    pub fn emit_download_state(
        &self,
        _id: u64,
        _url: &str,
        _start_time: u64,
        _plugin_id: &str,
        _state: DownloadState,
        _error: Option<&str>,
        _retried_for: Option<i64>,
    ) {
    }

    pub fn emit_download_removed(&self, _id: u64) {}

    pub fn emit(&self, _event: &str, _payload: serde_json::Value) {}

    pub fn emit_task_progress(&self, _task_id: &str, _progress: f64) {}

    pub fn emit_task_added(&self, _task: &serde_json::Value) {}

    pub fn emit_task_deleted(&self, _task_id: &str) {}

    pub fn emit_task_changed(&self, _task_id: &str, _diff: serde_json::Value) {}

    pub fn emit_busy_tasks_change(&self, _kind: &str) {}

    pub fn emit_organize_finished(
        &self,
        _removed: usize,
        _regenerated: usize,
        _backfilled: usize,
        _canceled: bool,
        _error: Option<String>,
    ) {
    }

    pub fn emit_hidden_cleanup_finished(
        &self,
        _removed: usize,
        _kept_files: usize,
        _canceled: bool,
        _error: Option<String>,
    ) {
    }

    pub fn emit_wallpaper_update_image(&self, _image_path: &str) {}

    pub fn emit_setting_change(&self, _changes: serde_json::Value) {}

    pub fn emit_image_changed(&self, _patches: Vec<ImagePatch>) {}

    pub fn emit_image_changed_uniform(&self, _image_ids: &[String], _diff: serde_json::Value) {}

    pub fn emit_images_change(
        &self,
        _reason: &str,
        _image_ids: &[String],
        _task_ids: Option<&[String]>,
        _surf_record_ids: Option<&[String]>,
        _plugin_ids: Option<&[String]>,
    ) {
    }

    pub fn emit_surf_record_added(&self, _record: serde_json::Value) {}

    pub fn emit_surf_record_deleted(&self, _surf_record_id: &str) {}

    pub fn emit_surf_record_changed(&self, _surf_record_id: &str, _diff: serde_json::Value) {}

    pub fn emit_failed_image_added(&self, _task_id: &str, _failed_image: &TaskFailedImage) {}

    pub fn emit_failed_image_removed(&self, _task_id: &str, _failed_image_id: i64) {}

    pub fn emit_failed_images_removed(&self, _task_id: &str, _failed_image_ids: &[i64]) {}

    pub fn emit_failed_image_updated(&self, _task_id: &str, _failed_image: &TaskFailedImage) {}

    pub fn emit_task_image_counts(
        &self,
        _task_id: &str,
        _success_count: Option<i64>,
        _deleted_count: Option<i64>,
        _failed_count: Option<i64>,
        _dedup_count: Option<i64>,
    ) {
    }

    pub fn emit_app_shutdown(&self, _reason: &str) {}

    pub fn emit_album_changed(&self, _album_id: &str, _changes: serde_json::Value) {}

    pub fn emit_album_added(&self, _album: &crate::storage::Album) {}

    pub fn emit_album_deleted(&self, _album: &crate::storage::Album) {}

    pub fn emit_auto_config_change(&self, _reason: &str, _config_id: &str) {}

    pub fn emit_pending_queue_change(&self, _pending_count: usize) {}

    pub fn emit_task_status_from_storage(&self, _task_id: &str) {}

    pub fn emit_plugin_added(&self, _plugin: &serde_json::Value) {}

    pub fn emit_plugin_deleted(&self, _plugin_id: &str) {}

    pub fn emit_plugin_updated(&self, _plugin: &serde_json::Value) {}
}
