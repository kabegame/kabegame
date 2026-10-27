//! Tauri 2 plugin that mounts a webview window as a Windows desktop wallpaper.
//!
//! The mount target is the background `WorkerW` that Explorer creates below
//! `Progman`. Observable behaviour was derived from Wallpaper Engine 2.8.0.42
//! with REA (static decompilation + runtime hooking); see
//! `step3-callchain-report-20261025.md` in this crate's directory.
//!
//! Feature `plugin` (default) enables the Tauri command surface. Building with
//! `--no-default-features` keeps only the platform layer so the Win32 code can
//! be compiled and tested without the Tauri dependency tree.

mod error;
mod models;
#[cfg_attr(not(feature = "plugin"), allow(dead_code))]
mod platform;
#[cfg_attr(not(feature = "plugin"), allow(dead_code))]
mod state;

#[cfg(feature = "plugin")]
mod commands;

pub use error::Error;
pub use models::{AttachOptions, AttachReport, MonitorInfo, MountState, MountStatus, Rect};

#[cfg(feature = "plugin")]
pub use commands_surface::*;

#[cfg(feature = "plugin")]
mod commands_surface {
    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{Manager, Runtime};

    /// Plugin name used by the frontend (`plugin:wemt|...`).
    pub const PLUGIN_NAME: &str = "wemt";

    /// Register the plugin with a Tauri application.
    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new(PLUGIN_NAME)
            .invoke_handler(tauri::generate_handler![
                super::commands::wemt_attach,
                super::commands::wemt_detach,
                super::commands::wemt_status,
                super::commands::wemt_refresh,
            ])
            .setup(|app, _api| {
                app.manage(super::state::WemtState::default());
                Ok(())
            })
            .build()
    }
}

#[cfg(feature = "plugin")]
pub use commands::{attach_window, detach_window};
