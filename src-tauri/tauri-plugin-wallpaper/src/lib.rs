#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

mod error;
mod mobile;
mod models;

pub use error::{Error, Result};
use mobile::Wallpaper;

pub trait WallpaperExt<R: Runtime> {
    fn wallpaper(&self) -> &Wallpaper<R>;
}

impl<R: Runtime, T: Manager<R>> WallpaperExt<R> for T {
    fn wallpaper(&self) -> &Wallpaper<R> {
        self.state::<Wallpaper<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("wallpaper")
        .setup(|app, api| {
            let wallpaper = mobile::init(app, api)?;
            app.manage(wallpaper);
            Ok(())
        })
        .build()
}
