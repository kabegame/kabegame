use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{CompressVideoForPreviewArgs, CompressVideoForPreviewResponse};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Compress<R>> {
    let handle = api.register_android_plugin("app.kabegame.plugin", "CompressPlugin")?;
    Ok(Compress(handle))
}

pub struct Compress<R: Runtime>(pub PluginHandle<R>);

impl<R: Runtime> Compress<R> {
    pub async fn compress_video_for_preview(
        &self,
        input_path: String,
        output_path: String,
    ) -> crate::Result<CompressVideoForPreviewResponse> {
        let result: CompressVideoForPreviewResponse = self
            .0
            .run_mobile_plugin_async(
                "compressVideoForPreview",
                CompressVideoForPreviewArgs {
                    input_path,
                    output_path,
                },
            )
            .await
            .map_err(crate::Error::from)?;
        Ok(result)
    }
}
