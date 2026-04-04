#![cfg(mobile)]

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod mobile;
mod models;

pub use error::{Error, Result};

use mobile::TaskNotification;

pub trait TaskNotificationExt<R: Runtime> {
    fn task_notification(&self) -> &TaskNotification<R>;
}

impl<R: Runtime, T: Manager<R>> TaskNotificationExt<R> for T {
    fn task_notification(&self) -> &TaskNotification<R> {
        self.state::<TaskNotification<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("task-notification")
        .setup(|app, api| {
            let task_notification = mobile::init(app, api)?;
            app.manage(task_notification);
            Ok(())
        })
        .build()
}
