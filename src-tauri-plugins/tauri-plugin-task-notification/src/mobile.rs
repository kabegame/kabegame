use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::UpdateTaskNotificationArgs;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<TaskNotification<R>> {
    let handle = api.register_android_plugin("app.kabegame.plugin", "TaskNotificationPlugin")?;
    Ok(TaskNotification(handle))
}

pub struct TaskNotification<R: Runtime>(pub PluginHandle<R>);

impl<R: Runtime> TaskNotification<R> {
    pub async fn update_task_notification(&self, running_count: u32) -> crate::Result<()> {
        let _: () = self
            .0
            .run_mobile_plugin_async::<()>(
                "updateTaskNotification",
                UpdateTaskNotificationArgs { running_count },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(())
    }

    pub async fn clear_task_notification(&self) -> crate::Result<()> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin_async("clearTaskNotification", serde_json::json!({}))
            .await
            .map_err(crate::Error::from)?;
        Ok(())
    }
}
