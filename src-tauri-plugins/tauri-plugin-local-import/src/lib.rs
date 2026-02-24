use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::LocalImport;
#[cfg(mobile)]
use mobile::LocalImport;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the local-import APIs.
pub trait LocalImportExt<R: Runtime> {
  fn local_import(&self) -> &LocalImport<R>;
}

impl<R: Runtime, T: Manager<R>> crate::LocalImportExt<R> for T {
  fn local_import(&self) -> &LocalImport<R> {
    self.state::<LocalImport<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("local-import")
    .invoke_handler(tauri::generate_handler![commands::ping])
    .setup(|app, api| {
      #[cfg(mobile)]
      let local_import = mobile::init(app, api)?;
      #[cfg(desktop)]
      let local_import = desktop::init(app, api)?;
      app.manage(local_import);
      Ok(())
    })
    .build()
}
