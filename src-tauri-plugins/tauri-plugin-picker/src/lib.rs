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

use crate::mobile::Picker;

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
            commands::pick_videos,
            commands::pick_kgpg_file,
            commands::open_image,
            commands::open_video,
            commands::get_image_thumbnail,
            commands::compute_hash,
            commands::get_mime_type,
            commands::get_display_name,
            commands::get_content_size,
            commands::get_image_dimensions,
            commands::get_video_dimensions,
            commands::is_directory,
            commands::list_content_children,
            commands::read_file_bytes,
            commands::take_persistable_permission,
            commands::copy_image_to_pictures,
            commands::copy_extracted_images_to_pictures,
        ])
        .setup(|app, api| {
            let picker = mobile::init(app, api)?;
            app.manage(picker);
            Ok(())
        })
        .build()
}
