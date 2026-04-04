use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Archiver<R>> {
  let handle = api.register_android_plugin("app.kabegame.plugin", "ArchiverPlugin")?;
  Ok(Archiver(handle))
}

/// Access to the archiver APIs.
pub struct Archiver<R: Runtime>(pub(crate) PluginHandle<R>);

impl<R: Runtime> Archiver<R> {
  pub async fn extract_zip(&self, archive_uri: String, output_dir: String) -> crate::Result<ExtractResponse> {
    let result: ExtractResponse = self
      .0
      .run_mobile_plugin_async("extractZip", ExtractZipArgs { archive_uri, output_dir })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  pub async fn extract_rar(&self, archive_uri: String, output_dir: String) -> crate::Result<ExtractResponse> {
    let result: ExtractResponse = self
      .0
      .run_mobile_plugin_async("extractRar", ExtractRarArgs { archive_uri, output_dir })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }
}
