//! Tauri 适配器：让 Tauri 的 AppHandle 实现 Runtime trait
//!
//! 这个模块提供了 Tauri AppHandle 到 Runtime trait 的适配，
//! 使得前端应用可以无缝使用 Runtime 抽象。

use crate::runtime::{EventEmitter, Runtime, StateGuard, StateManager};
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Emitter, Manager};

/// Tauri 事件发送器：将 Tauri 的 emit 方法适配到 EventEmitter trait
pub struct TauriEventEmitter {
    app: AppHandle,
}

impl TauriEventEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

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
            "progress": progress
        });
        let _ = self.app.emit("task-progress", payload);
    }

    fn emit_task_error(&self, task_id: &str, error: &str) {
        let payload = serde_json::json!({
            "taskId": task_id,
            "error": error
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
        let mut payload = serde_json::json!({
            "taskId": task_id,
            "url": url,
            "startTime": start_time,
            "pluginId": plugin_id,
            "receivedBytes": received_bytes,
        });
        if let Some(total) = total_bytes {
            payload["totalBytes"] = serde_json::Value::Number(serde_json::Number::from(total));
        }
        let _ = self.app.emit("download-progress", payload);
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
}

/// Tauri 状态管理器：将 Tauri 的 state 方法适配到 StateManager trait
pub struct TauriStateManager {
    app: AppHandle,
}

impl TauriStateManager {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl StateManager for TauriStateManager {
    fn state<T: Send + Sync + 'static>(&self) -> StateGuard<T> {
        let tauri_state = self.app.state::<T>();
        StateGuard::new(tauri_state.inner().clone())
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<StateGuard<T>> {
        let tauri_state = self.app.try_state::<T>()?;
        Some(StateGuard::new(tauri_state.inner().clone()))
    }

    fn manage<T: Send + Sync + 'static>(&self, state: T) -> Result<(), String> {
        self.app.manage(state);
        Ok(())
    }
}

/// Tauri 运行时：组合 Tauri 的事件发送器和状态管理器
pub struct TauriRuntime {
    emitter: Arc<TauriEventEmitter>,
    state_manager: Arc<TauriStateManager>,
}

impl TauriRuntime {
    pub fn new(app: AppHandle) -> Self {
        Self {
            emitter: Arc::new(TauriEventEmitter::new(app.clone())),
            state_manager: Arc::new(TauriStateManager::new(app)),
        }
    }
}

impl EventEmitter for TauriRuntime {
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
        self.emitter.emit_download_progress(
            task_id,
            url,
            start_time,
            plugin_id,
            received_bytes,
            total_bytes,
        );
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

impl StateManager for TauriRuntime {
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

impl Runtime for TauriRuntime {}
