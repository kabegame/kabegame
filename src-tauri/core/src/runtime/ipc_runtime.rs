//! IPC Runtime：在 daemon 侧使用 EventBroadcaster 实现事件分发，配合内置 StateManager。
//! 
//! 适用场景：
//! - daemon 作为核心进程，前端仅通过 IPC 订阅事件
//! - 无 Tauri 依赖
//! 
//! 用法示例：
//! ```rust
//! use kabegame_core::ipc::EventBroadcaster;
//! use kabegame_core::runtime::ipc_runtime::IpcRuntime;
//! 
//! let broadcaster = std::sync::Arc::new(EventBroadcaster::default());
//! let runtime = IpcRuntime::new(broadcaster.clone());
//! runtime.manage(plugin_manager)?;
//! runtime.emit_task_log("task-1", "info", "hello");
//! ```

use crate::ipc::EventBroadcaster;
use crate::runtime::{EventEmitter, Runtime, StateGuard, StateManager};
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

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
                &bc,
                task_id,
                url,
                start_time,
                plugin_id,
                state,
                error,
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
            crate::ipc::broadcaster::emit_dedupe_progress(&bc, processed, total, removed, batch_index).await;
        });
    }

    fn emit_dedupe_finished(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        canceled: bool,
    ) {
        let bc = self.broadcaster.clone();
        tokio::spawn(async move {
            crate::ipc::broadcaster::emit_dedupe_finished(&bc, processed, total, removed, canceled).await;
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

/// 基于 HashMap 的状态管理器（与 NoopRuntime 类似，但拆分为独立组件）
pub struct IpcStateManager {
    states: Arc<RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>>,
}

impl IpcStateManager {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Default for IpcStateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl StateManager for IpcStateManager {
    fn state<T: Send + Sync + 'static>(&self) -> StateGuard<T> {
        self.try_state::<T>().expect("State not found")
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<StateGuard<T>> {
        let type_id = TypeId::of::<T>();
        let states = self.states.read().ok()?;
        let state = states.get(&type_id)?;
        let state = state.clone().downcast::<T>().ok()?;
        Some(StateGuard::new(state))
    }

    fn manage<T: Send + Sync + 'static>(&self, state: T) -> Result<(), String> {
        let type_id = TypeId::of::<T>();
        let mut states = self
            .states
            .write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;

        if states.contains_key(&type_id) {
            return Err(format!("State of type {:?} already exists", type_id));
        }

        states.insert(type_id, Arc::new(state));
        Ok(())
    }
}

/// IpcRuntime：组合 IPC 事件发送 + 状态管理
pub struct IpcRuntime {
    emitter: Arc<IpcEventEmitter>,
    state_manager: Arc<IpcStateManager>,
}

impl IpcRuntime {
    pub fn new(broadcaster: Arc<EventBroadcaster>) -> Self {
        Self {
            emitter: Arc::new(IpcEventEmitter::new(broadcaster)),
            state_manager: Arc::new(IpcStateManager::new()),
        }
    }
}

impl EventEmitter for IpcRuntime {
    fn emit_task_log(&self, task_id: &str, level: &str, message: &str) {
        self.emitter.emit_task_log(task_id, level, message);
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
        self.emitter
            .emit_download_state(task_id, url, start_time, plugin_id, state, error);
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        self.emitter
            .emit_task_status(task_id, status, progress, error, current_wallpaper);
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.emitter.emit(event, payload);
    }

    fn emit_dedupe_progress(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        batch_index: usize,
    ) {
        self.emitter.emit_dedupe_progress(processed, total, removed, batch_index);
    }

    fn emit_dedupe_finished(
        &self,
        processed: usize,
        total: usize,
        removed: usize,
        canceled: bool,
    ) {
        self.emitter.emit_dedupe_finished(processed, total, removed, canceled);
    }

    fn emit_task_progress(&self, task_id: &str, progress: f64) {
        self.emitter.emit_task_progress(task_id, progress);
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        self.emitter.emit_task_error(task_id, error);
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
        self.emitter.emit_download_progress(task_id, url, start_time, plugin_id, received_bytes, total_bytes);
    }

    fn emit_wallpaper_update_image(&self, image_path: &str) {
        self.emitter.emit_wallpaper_update_image(image_path);
    }

    fn emit_wallpaper_update_style(&self, style: &str) {
        self.emitter.emit_wallpaper_update_style(style);
    }

    fn emit_wallpaper_update_transition(&self, transition: &str) {
        self.emitter.emit_wallpaper_update_transition(transition);
    }
}

impl StateManager for IpcRuntime {
    fn state<T: Send + Sync + 'static>(&self) -> StateGuard<T> {
        self.state_manager.state::<T>()
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<StateGuard<T>> {
        self.state_manager.try_state::<T>()
    }

    fn manage<T: Send + Sync + 'static>(&self, state: T) -> Result<(), String> {
        self.state_manager.manage(state)
    }
}

impl Runtime for IpcRuntime {}
