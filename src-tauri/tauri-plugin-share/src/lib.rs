#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod mobile;

pub use error::{Error, Result};
use mobile::Share;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the share plugin.
pub trait ShareExt<R: Runtime> {
    fn share(&self) -> &Share<R>;
}

impl<R: Runtime, T: Manager<R>> ShareExt<R> for T {
    fn share(&self) -> &Share<R> {
        self.state::<Share<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("share")
        .setup(|app, api| {
            let share = mobile::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
