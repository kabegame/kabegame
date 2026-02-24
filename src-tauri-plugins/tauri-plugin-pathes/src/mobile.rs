use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

/// Android only: initializes the Kotlin PathesPlugin.
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Pathes<R>> {
  let handle = api.register_android_plugin("app.kabegame.plugin", "PathesPlugin")?;
  Ok(Pathes(handle))
}

/// Access to the pathes APIs (Android).
pub struct Pathes<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Pathes<R> {
  pub fn get_app_data_dir(&self) -> crate::Result<AppDataDirResponse> {
    self
      .0
      .run_mobile_plugin("getAppDataDir", ())
      .map_err(Into::into)
  }

  pub fn get_cache_paths(&self) -> crate::Result<CachePathsResponse> {
    self
      .0
      .run_mobile_plugin("getCachePaths", ())
      .map_err(Into::into)
  }

  pub fn get_external_data_dir(&self) -> crate::Result<ExternalDataDirResponse> {
    self
      .0
      .run_mobile_plugin("getExternalDataDir", ())
      .map_err(Into::into)
  }

  pub fn get_archive_extract_dir(&self) -> crate::Result<ArchiveExtractDirResponse> {
    self
      .0
      .run_mobile_plugin("getArchiveExtractDir", ())
      .map_err(Into::into)
  }
}
