use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Share<R>> {
    let handle = api.register_android_plugin("app.kabegame.plugin", "SharePlugin")?;
    Ok(Share(handle))
}

/// Access to the share plugin (Android): share file, copy image to clipboard.
pub struct Share<R: Runtime>(pub PluginHandle<R>);
