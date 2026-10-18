use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{
    DownloadNotificationItem, NotificationPermissionResponse, UpdateNotificationsArgs,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<TaskNotification<R>> {
    let handle = api.register_android_plugin("app.kabegame.plugin", "TaskNotificationPlugin")?;
    Ok(TaskNotification(handle))
}

pub struct TaskNotification<R: Runtime>(pub PluginHandle<R>);

impl<R: Runtime> TaskNotification<R> {
    /// 在用户主动启动任务时请求 Android 13+ 通知权限。
    /// 返回拒绝不属于插件错误，调用方仍应继续启动任务。
    pub async fn request_permission(&self) -> crate::Result<bool> {
        let response = self
            .0
            .run_mobile_plugin_async::<NotificationPermissionResponse>("requestPermission", ())
            .await
            .map_err(crate::Error::from)?;
        Ok(response.granted)
    }

    /// 全量协调下载/任务通知:`items` 为当前活跃下载快照,Kotlin 据此 upsert/取消子通知并维护汇总。
    /// `running_count == 0 && items.is_empty()` 时停止前台服务并显示「全部完成」。
    pub async fn update_notifications(
        &self,
        running_count: u32,
        items: Vec<DownloadNotificationItem>,
    ) -> crate::Result<()> {
        let _: () = self
            .0
            .run_mobile_plugin_async::<()>(
                "updateNotifications",
                UpdateNotificationsArgs {
                    running_count,
                    items,
                },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(())
    }
}
