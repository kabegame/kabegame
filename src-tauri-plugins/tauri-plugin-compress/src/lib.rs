#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod mobile;
mod models;

pub use error::{Error, Result};
pub use models::CompressVideoForPreviewResponse;

use mobile::Compress;

pub trait CompressExt<R: Runtime> {
    fn compress(&self) -> &Compress<R>;
}

impl<R: Runtime, T: Manager<R>> CompressExt<R> for T {
    fn compress(&self) -> &Compress<R> {
        self.state::<Compress<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("compress")
        .setup(|app, api| {
            let compress = mobile::init(app, api)?;
            app.manage(compress);
            Ok(())
        })
        .build()
}
