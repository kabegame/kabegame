use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{MediaEvent, Watch};

#[cfg(target_os = "macos")]
mod macos;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Sysmedia<R>> {
    Ok(Sysmedia(app.clone()))
}

/// Access to the sysmedia APIs.
pub struct Sysmedia<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Sysmedia<R> {
    /// 本平台有没有数据源（没有时 [`Self::watch`] 只推一次「没有会话」）。
    pub fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    /// 开始监视当前的媒体会话：先推一次 [`MediaEvent::Session`]，之后随变化推送。丢弃返回值即停止。
    pub fn watch(&self, on_event: impl Fn(MediaEvent) + Send + 'static) -> Watch {
        #[cfg(target_os = "macos")]
        {
            use tauri::Manager;
            match self.0.path().app_cache_dir() {
                Ok(cache) => {
                    return Watch::new(macos::MacWatch::start(
                        cache.join(crate::PLUGIN_NAME),
                        Box::new(on_event),
                    ))
                }
                Err(error) => tracing::warn!("取应用缓存目录失败，系统媒体会话不可用: {error}"),
            }
        }
        on_event(MediaEvent::Session(None));
        Watch::inert()
    }
}
