use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::PickerExt;

#[command]
pub(crate) async fn pickFolder<R: Runtime>(app: AppHandle<R>) -> Result<PickFolderResult, String> {
  let result: PickFolderResult = app
    .picker()
    .0
    .run_mobile_plugin_async("pickFolder", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}

#[command]
pub(crate) async fn pickImages<R: Runtime>(app: AppHandle<R>) -> Result<PickImagesResponse, String> {
  let result: PickImagesResponse = app
    .picker()
    .0
    .run_mobile_plugin_async("pickImages", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}

#[command]
pub(crate) async fn pickKgpgFile<R: Runtime>(app: AppHandle<R>) -> Result<PickKgpgFileResponse, String> {
  let result: PickKgpgFileResponse = app
    .picker()
    .0
    .run_mobile_plugin_async("pickKgpgFile", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}
