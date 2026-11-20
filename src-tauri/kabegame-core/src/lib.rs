//! Kabegame 后端核心库入口（供多个 app crate 复用）。

pub mod app_paths;
/// 命令后端层：Tauri 命令 / Web JSON-RPC / IPC 共用的实现（原 `kabegame::commands_core`）。
pub mod commands;
pub mod ipc;

pub mod crawler;

pub mod gallery;
pub mod kgpg;
pub mod local_folder;
/// 应用日志：tracing 订阅器装配、最近日志缓冲与事件广播（见 cocs/debug/APP_LOGGING.md）。
pub mod logging;
pub mod media;
pub mod plugin;
pub mod providers;

pub mod emitter;
pub mod schedule_sync;
pub mod scheduler;
pub mod settings;
pub mod storage;
pub mod wallpaper_compat;
pub mod wallpaper_rotation;
pub mod workarounds;
pub mod wpe;

