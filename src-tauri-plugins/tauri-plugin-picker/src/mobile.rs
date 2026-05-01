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
    let handle = api.register_android_plugin("app.kabegame.plugin", "PickerPlugin")?;
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

    pub async fn get_image_dimensions(
        &self,
        uri: String,
    ) -> crate::Result<GetImageDimensionsResponse> {
        let result: GetImageDimensionsResponse = self
            .0
            .run_mobile_plugin_async("getImageDimensions", GetImageDimensionsArgs { uri })
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }

    pub async fn get_content_size(&self, uri: String) -> crate::Result<GetContentSizeResponse> {
        let result: GetContentSizeResponse = self
            .0
            .run_mobile_plugin_async("getContentSize", GetContentSizeArgs { uri })
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }

    pub async fn list_content_children(
        &self,
        uri: String,
    ) -> crate::Result<ListContentChildrenResponse> {
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
        self.0
            .run_mobile_plugin_async::<()>(
                "takePersistablePermission",
                TakePersistablePermissionArgs { uri },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(())
    }

    pub async fn get_display_name(&self, uri: String) -> crate::Result<GetDisplayNameResponse> {
        let result: GetDisplayNameResponse = self
            .0
            .run_mobile_plugin_async("getDisplayName", GetDisplayNameArgs { uri })
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }

    pub async fn copy_image_to_pictures(
        &self,
        source_path: String,
        mime_type: String,
        display_name: String,
    ) -> crate::Result<CopyImageToPicturesResponse> {
        let result: CopyImageToPicturesResponse = self
            .0
            .run_mobile_plugin_async(
                "copyImageToPictures",
                CopyImageToPicturesArgs {
                    source_path,
                    mime_type,
                    display_name,
                },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }

    pub async fn copy_extracted_images_to_pictures(
        &self,
        source_dir: String,
    ) -> crate::Result<CopyExtractedImagesToPicturesResponse> {
        let result: CopyExtractedImagesToPicturesResponse = self
            .0
            .run_mobile_plugin_async(
                "copyExtractedImagesToPictures",
                CopyExtractedImagesToPicturesArgs { source_dir },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }
}
