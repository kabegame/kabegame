use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{MediaEvent, Watch};

// initializes the Kotlin plugin class（项目不支持 iOS）
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Sysmedia<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.kabegame.plugin", "SysmediaPlugin")?;
    #[cfg(not(target_os = "android"))]
    let handle: PluginHandle<R> = {
        let _ = api;
        unreachable!("kabegame does not support iOS")
    };
    Ok(Sysmedia(handle))
}

/// Access to the sysmedia APIs.
pub struct Sysmedia<R: Runtime>(PluginHandle<R>);

#[derive(serde::Deserialize)]
struct Available {
    available: bool,
}

impl<R: Runtime> Sysmedia<R> {
    /// 本平台有没有数据源。Android 还没有：读别的应用的媒体会话要用户授予「通知使用权」（`MediaSessionManager`）。
    pub fn available(&self) -> bool {
        self.0
            .run_mobile_plugin::<Available>("available", ())
            .map(|reply| reply.available)
            .unwrap_or(false)
    }

    /// 同桌面的 `watch`；没有数据源时只推一次「没有会话」。
    pub fn watch(&self, on_event: impl Fn(MediaEvent) + Send + 'static) -> Watch {
        // TODO: Android 的 MediaSessionManager（通知使用权）
        on_event(MediaEvent::Session(None));
        Watch::inert()
    }
}
