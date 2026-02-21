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
) -> crate::Result<Picker<R>> {
  let handle = api.register_android_plugin("app.kabegame.plugin.picker", "PickerPlugin")?;
  Ok(Picker(handle))
}

/// Access to the picker APIs.
pub struct Picker<R: Runtime>(pub(crate) PluginHandle<R>);

impl<R: Runtime> Picker<R> {
  pub async fn is_directory(&self, uri: String) -> crate::Result<IsDirectoryResponse> {
    let result: IsDirectoryResponse = self
      .0
      .run_mobile_plugin_async("isDirectory", IsDirectoryArgs { uri })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  pub async fn get_mime_type(&self, uri: String) -> crate::Result<GetMimeTypeResponse> {
    let result: GetMimeTypeResponse = self
      .0
      .run_mobile_plugin_async("getMimeType", GetMimeTypeArgs { uri })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  pub async fn list_content_children(&self, uri: String) -> crate::Result<ListContentChildrenResponse> {
    let result: ListContentChildrenResponse = self
      .0
      .run_mobile_plugin_async("listContentChildren", ListContentChildrenArgs { uri })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  pub async fn read_file_bytes(&self, uri: String) -> crate::Result<ReadFileBytesResponse> {
    let result: ReadFileBytesResponse = self
      .0
      .run_mobile_plugin_async("readFileBytes", ReadFileBytesArgs { uri })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  pub async fn take_persistable_permission(&self, uri: String) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin_async::<()>("takePersistablePermission", TakePersistablePermissionArgs { uri })
      .await
      .map_err(crate::Error::from)?;
    Ok(())
  }

  pub async fn extract_archive_to_media_store(
    &self,
    archive_uri: String,
    folder_name: String,
  ) -> crate::Result<ExtractArchiveResponse> {
    let result: ExtractArchiveResponse = self
      .0
      .run_mobile_plugin_async(
        "extractArchiveToMediaStore",
        ExtractArchiveArgs {
          archive_uri,
          folder_name,
        },
      )
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }

  /// 从 APK assets 的 resources/plugins 解压 .kgpg 到指定目录（仅 Android）。
  pub async fn extract_bundled_plugins(&self, target_dir: String) -> crate::Result<ExtractBundledPluginsResponse> {
    let result: ExtractBundledPluginsResponse = self
      .0
      .run_mobile_plugin_async("extractBundledPlugins", ExtractBundledPluginsArgs { target_dir })
      .await
      .map_err(crate::Error::from)?;
    Ok(result)
  }
}
