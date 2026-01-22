//! 全局 EventEmitter 单例
//!
//! 根据编译时的 feature 选择不同的 emitter 类型：
//! - 如果启用了 `tauri-runtime` feature，使用 `TauriEventEmitter`
//! - 否则使用 `IpcEventEmitter`（用于 daemon）

use crate::runtime::{core::NoopEventEmitter, EventEmitter};
use std::sync::OnceLock;

#[cfg(not(any(feature = "ipc-server", feature = "ipc-client")))]
use crate::runtime::tauri_runtime::TauriEventEmitter;
#[cfg(not(any(feature = "ipc-server", feature = "ipc-client")))]
use tauri::AppHandle;

#[cfg(feature = "ipc-server")]
use crate::ipc::EventBroadcaster;
#[cfg(feature = "ipc-server")]
use crate::runtime::ipc_runtime::IpcEventEmitter;

/// Emitter 类型别名：根据 feature 在编译时确定
#[cfg(not(any(feature = "ipc-server", feature = "ipc-client")))]
pub type GlobalEmitterType = TauriEventEmitter;

#[cfg(feature = "ipc-server")]
pub type GlobalEmitterType = IpcEventEmitter;

/// 无实现，占位
#[cfg(feature = "ipc-client")]
pub type GlobalEmitterType = NoopEventEmitter;

/// 全局 emitter 单例存储
static GLOBAL_EMITTER: OnceLock<GlobalEmitterType> = OnceLock::new();

/// 全局 EventEmitter（用于向后兼容和统一 API）
pub struct GlobalEmitter;

impl GlobalEmitter {
    /// 初始化全局 emitter（Tauri 版本）
    #[cfg(not(any(feature = "ipc-server", feature = "ipc-client")))]
    pub fn init_global(app: AppHandle) -> Result<(), String> {
        GLOBAL_EMITTER
            .set(TauriEventEmitter::new(app))
            .map_err(|_| "Global emitter already initialized".to_string())
    }

    /// 初始化全局 emitter（IPC 版本）
    #[cfg(feature = "ipc-server")]
    pub fn init_global(broadcaster: std::sync::Arc<EventBroadcaster>) -> Result<(), String> {
        GLOBAL_EMITTER
            .set(IpcEventEmitter::new(broadcaster))
            .map_err(|_| "Global emitter already initialized".to_string())
    }

    /// 获取全局 emitter 引用
    ///
    /// # Panics
    /// 如果尚未初始化，会 panic
    pub fn global() -> &'static GlobalEmitterType {
        GLOBAL_EMITTER
            .get()
            .expect("Global emitter not initialized. Call GlobalEmitter::init_global() first.")
    }

    /// 尝试获取全局 emitter 引用
    ///
    /// # 返回
    /// 如果已初始化返回 Some，否则返回 None
    pub fn try_global() -> Option<&'static GlobalEmitterType> {
        GLOBAL_EMITTER.get()
    }

    /// 通过 EventEmitter trait 访问全局 emitter
    ///
    /// 这个函数返回一个实现了 EventEmitter 的引用，可以用于需要 trait object 的地方
    pub fn as_trait() -> &'static dyn EventEmitter {
        // GlobalEmitterType 在编译时确定，并且实现了 EventEmitter
        Self::global() as &'static dyn EventEmitter
    }
}
