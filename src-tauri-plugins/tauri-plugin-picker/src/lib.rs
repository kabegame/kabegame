#![cfg(mobile)]

use tauri::{
  plugin::{Builder, PluginHandle, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

use mobile::Picker;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the picker APIs.
pub trait PickerExt<R: Runtime> {
  fn picker(&self) -> &Picker<R>;
}

impl<R: Runtime, T: Manager<R>> crate::PickerExt<R> for T {
  fn picker(&self) -> &Picker<R> {
    self.state::<Picker<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("picker")
    .invoke_handler(tauri::generate_handler![
      commands::pick_folder,
      commands::pick_images,
      commands::pick_kgpg_file,
    ])
    .setup(|app, api| {
      let picker = mobile::init(app, api)?;
      app.manage(picker);
      Ok(())
    })
    .build()
}

