use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{ScheduleRotationArgs, SetWallpaperArgs};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Wallpaper<R>> {
    let handle = api.register_android_plugin("app.kabegame.plugin", "WallpaperPlugin")?;
    Ok(Wallpaper(handle))
}

pub struct Wallpaper<R: Runtime>(pub PluginHandle<R>);

impl<R: Runtime> Wallpaper<R> {
    /// 设置壁纸。Android 插件返回 { success, method, style }，Rust 端接受任意 JSON 并忽略，避免 "expected unit" 反序列化错误。
    pub async fn set_wallpaper(&self, file_path: &str, style: &str) -> crate::Result<()> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin_async(
                "setWallpaper",
                SetWallpaperArgs {
                    file_path: file_path.to_string(),
                    style: style.to_string(),
                },
            )
            .await?;
        Ok(())
    }

    pub async fn schedule_rotation(&self, interval_minutes: u32) -> crate::Result<()> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin_async(
                "scheduleRotation",
                ScheduleRotationArgs { interval_minutes },
            )
            .await?;
        Ok(())
    }

    pub async fn cancel_rotation(&self) -> crate::Result<()> {
        let _: serde_json::Value = self
            .0
            .run_mobile_plugin_async("cancelRotation", serde_json::json!({}))
            .await?;
        Ok(())
    }
}
