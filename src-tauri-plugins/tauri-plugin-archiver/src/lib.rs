#![cfg(mobile)]

use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

mod mobile;

mod error;
mod models;

pub use error::{Error, Result};

use crate::mobile::Archiver;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the archiver APIs.
pub trait ArchiverExt<R: Runtime> {
    fn archiver(&self) -> &Archiver<R>;
}

impl<R: Runtime, T: Manager<R>> crate::ArchiverExt<R> for T {
    fn archiver(&self) -> &Archiver<R> {
        self.state::<Archiver<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("archiver")
        .setup(|app, api| {
            let archiver = mobile::init(app, api)?;
            app.manage(archiver);
            Ok(())
        })
        .build()
}
