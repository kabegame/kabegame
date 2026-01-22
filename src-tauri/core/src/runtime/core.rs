//! 运行时抽象层：提供事件发送和状态管理功能，不依赖 Tauri
//!
//! 这个模块提供了与 Tauri 的 `Manager` 和 `Emitter` trait 类似的抽象，
//! 但完全独立，可以在 daemon 模式或非 Tauri 环境中使用。
//!
//! ## 使用示例
//!
//! ### Daemon 模式（无 Tauri）
//! ```rust
//! use kabegame_core::runtime::{NoopRuntime, Runtime};
//!
//! let runtime = NoopRuntime::new();
//! runtime.manage(plugin_manager);
//! runtime.manage(storage);
//! let pm = runtime.state::<PluginManager>();
//! ```
//!
//! ### Tauri 前端应用
//! ```rust
//! use kabegame_core::runtime::tauri_runtime::TauriRuntime;
//!
//! let runtime = TauriRuntime::new(app.handle().clone());
//! runtime.manage(plugin_manager);
//! let pm = runtime.state::<PluginManager>();
//! ```

use std::sync::Arc;

// TODO: 具化事件，只有动态事件才用通用emit
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
}

/// 状态管理器 trait：抽象状态存储和获取功能
pub trait StateManager: Send + Sync {
    /// 获取状态（如果不存在则 panic）
    fn state<T: Send + Sync + 'static>(&self) -> StateGuard<T>;

    /// 尝试获取状态（如果不存在返回 None）
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<StateGuard<T>>;

    /// 注册状态
    fn manage<T: Send + Sync + 'static>(&self, state: T) -> Result<(), String>;
}

/// 状态守卫：提供对状态的访问
pub struct StateGuard<T> {
    inner: Arc<T>,
}

impl<T> StateGuard<T> {
    pub fn new(inner: Arc<T>) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &T {
        &self.inner
    }

    pub fn clone_inner(&self) -> Arc<T> {
        Arc::clone(&self.inner)
    }
}

impl<T> std::ops::Deref for StateGuard<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// 无实现，占位
/// 这里的代码最终不会运行，但没有这个编译无法通过
pub struct NoopEventEmitter;

impl EventEmitter for NoopEventEmitter {
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        eprintln!("[task-log] {} [{}] {}", task_id, level, message);
    }

    fn emit_download_state(
        &self,
        task_id: &str,
        url: &str,
        _start_time: u64,
        plugin_id: &str,
        state: &str,
        error: Option<&str>,
    ) {
        if let Some(err) = error {
            eprintln!(
                "[download-state] {} [{}] {} {}: {}",
                task_id, state, plugin_id, url, err
            );
        } else {
            eprintln!(
                "[download-state] {} [{}] {} {}",
                task_id, state, plugin_id, url
            );
        }
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        _current_wallpaper: Option<&str>,
    ) {
        if let Some(err) = error {
            eprintln!("[task-status] {} [{}] error: {}", task_id, status, err);
        } else if let Some(prog) = progress {
            eprintln!(
                "[task-status] {} [{}] progress: {:.2}%",
                task_id,
                status,
                prog * 100.0
            );
        } else {
            eprintln!("[task-status] {} [{}]", task_id, status);
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        eprintln!("[event] {}: {}", event, payload);
    }

    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        eprintln!(
            "[dedupe-progress] processed: {}/{}, removed: {}, batch: {}",
            processed, total, removed, batch_index
        );
    }

    fn emit_dedupe_finished(&self, processed: usize, total: usize, removed: usize, canceled: bool) {
        eprintln!(
            "[dedupe-finished] processed: {}/{}, removed: {}, canceled: {}",
            processed, total, removed, canceled
        );
    }

    fn emit_task_progress(&self, task_id: &str, progress: f64) {
        eprintln!(
            "[task-progress] {} progress: {:.2}%",
            task_id,
            progress * 100.0
        );
    }

    fn emit_wallpaper_update_image(&self, image_path: &str) {
        eprintln!("[wallpaper-update-image] {}", image_path);
    }

    fn emit_wallpaper_update_style(&self, style: &str) {
        eprintln!("[wallpaper-update-style] {}", style);
    }

    fn emit_wallpaper_update_transition(&self, transition: &str) {
        eprintln!("[wallpaper-update-transition] {}", transition);
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        eprintln!("[task-error] {} error: {}", task_id, error);
    }

    fn emit_download_progress(
        &self,
        task_id: &str,
        url: &str,
        _start_time: u64,
        _plugin_id: &str,
        received_bytes: u64,
        total_bytes: Option<u64>,
    ) {
        if let Some(total) = total_bytes {
            eprintln!(
                "[download-progress] {} {}: {}/{} bytes",
                task_id, url, received_bytes, total
            );
        } else {
            eprintln!(
                "[download-progress] {} {}: {} bytes",
                task_id, url, received_bytes
            );
        }
    }
}
