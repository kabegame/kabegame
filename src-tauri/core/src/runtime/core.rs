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
//! use kabegame_core::runtime::tauri_adapter::TauriRuntime;
//!
//! let runtime = TauriRuntime::new(app.handle().clone());
//! runtime.manage(plugin_manager);
//! let pm = runtime.state::<PluginManager>();
//! ```

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

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

/// 运行时上下文：组合事件发送器和状态管理器
pub trait Runtime: EventEmitter + StateManager {}

/// 空实现：用于 daemon 模式或不需要事件/状态管理的场景
pub struct NoopRuntime {
    states: Arc<RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>>,
}

impl NoopRuntime {
    pub fn new() -> Self {
        Self {
            states: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Default for NoopRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl EventEmitter for NoopRuntime {
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
            eprintln!("[download-state] {} [{}] {} {}: {}", task_id, state, plugin_id, url, err);
        } else {
            eprintln!("[download-state] {} [{}] {} {}", task_id, state, plugin_id, url);
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
            eprintln!("[task-status] {} [{}] progress: {:.2}%", task_id, status, prog * 100.0);
        } else {
            eprintln!("[task-status] {} [{}]", task_id, status);
        }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        eprintln!("[event] {}: {}", event, payload);
    }
}

impl StateManager for NoopRuntime {
    fn state<T: Send + Sync + 'static>(&self) -> StateGuard<T> {
        self.try_state::<T>()
            .expect("State not found")
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
        let mut states = self.states.write()
            .map_err(|e| format!("Failed to acquire write lock: {}", e))?;
        
        if states.contains_key(&type_id) {
            return Err(format!("State of type {:?} already exists", type_id));
        }

        states.insert(type_id, Arc::new(state));
        Ok(())
    }
}

impl Runtime for NoopRuntime {}

/// 组合运行时：将事件发送器和状态管理器组合在一起
pub struct CompositeRuntime<E, S> {
    emitter: Arc<E>,
    state_manager: Arc<S>,
}

impl<E, S> CompositeRuntime<E, S>
where
    E: EventEmitter + Send + Sync,
    S: StateManager + Send + Sync,
{
    pub fn new(emitter: E, state_manager: S) -> Self {
        Self {
            emitter: Arc::new(emitter),
            state_manager: Arc::new(state_manager),
        }
    }
}

impl<E, S> EventEmitter for CompositeRuntime<E, S>
where
    E: EventEmitter + Send + Sync,
    S: StateManager + Send + Sync,
{
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
        self.emitter.emit_download_state(task_id, url, start_time, plugin_id, state, error);
    }

    fn emit_task_status(
        &self,
        task_id: &str,
        status: &str,
        progress: Option<f64>,
        error: Option<&str>,
        current_wallpaper: Option<&str>,
    ) {
        self.emitter.emit_task_status(task_id, status, progress, error, current_wallpaper);
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.emitter.emit(event, payload);
    }
}

impl<E, S> StateManager for CompositeRuntime<E, S>
where
    E: EventEmitter + Send + Sync,
    S: StateManager + Send + Sync,
{
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

impl<E, S> Runtime for CompositeRuntime<E, S>
where
    E: EventEmitter + Send + Sync,
    S: StateManager + Send + Sync,
{
}

