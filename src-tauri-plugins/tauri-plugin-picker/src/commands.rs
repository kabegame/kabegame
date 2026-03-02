use tauri::{AppHandle, Runtime};

use crate::models::*;
use crate::PickerExt;

#[tauri::command]
pub(crate) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<PickFolderResult, String> {
  let result: PickFolderResult = app
    .picker()
    .0
    .run_mobile_plugin_async("pickFolder", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}

#[tauri::command]
pub(crate) async fn pick_images<R: Runtime>(app: AppHandle<R>) -> Result<PickImagesResponse, String> {
  let result: PickImagesResponse = app
    .picker()
    .0
    .run_mobile_plugin_async("pickImages", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}

#[tauri::command]
pub(crate) async fn pick_kgpg_file<R: Runtime>(app: AppHandle<R>) -> Result<PickKgpgFileResponse, String> {
  let result: PickKgpgFileResponse = app
    .picker()
    .0
    .run_mobile_plugin_async("pickKgpgFile", ())
    .await
    .map_err(|e| e.to_string())?;
  Ok(result)
}

#[tauri::command]
pub(crate) async fn open_image<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<(), String> {
  app
    .picker()
    .0
    .run_mobile_plugin_async::<()>("openImage", crate::models::OpenImageArgs { uri })
    .await
    .map_err(|e| e.to_string())?;
  Ok(())
}
