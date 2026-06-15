use tauri::{AppHandle, Runtime};

use crate::models::*;
use crate::PickerExt;

#[tauri::command]
pub(crate) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<PickFolderResult, String> {
    app.picker()
        .0
        .run_mobile_plugin_async("pickFolder", ())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn pick_images<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PickImagesResponse, String> {
    app.picker()
        .0
        .run_mobile_plugin_async("pickImages", ())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn pick_videos<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PickVideosResponse, String> {
    app.picker()
        .0
        .run_mobile_plugin_async("pickVideos", ())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn pick_kgpg_file<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PickKgpgFileResponse, String> {
    app.picker()
        .0
        .run_mobile_plugin_async("pickKgpgFile", ())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn open_image<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<(), String> {
    app.picker()
        .0
        .run_mobile_plugin_async::<()>("openImage", OpenImageArgs { uri })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn open_video<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<(), String> {
    app.picker()
        .0
        .run_mobile_plugin_async::<()>("openVideo", OpenVideoArgs { uri })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_image_thumbnail<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
    output_path: String,
) -> Result<(), String> {
    app.picker()
        .get_image_thumbnail(uri, output_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn compute_hash<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<ComputeHashResponse, String> {
    app.picker().compute_hash(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_mime_type<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<GetMimeTypeResponse, String> {
    app.picker().get_mime_type(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_display_name<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<GetDisplayNameResponse, String> {
    app.picker().get_display_name(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_content_size<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<GetContentSizeResponse, String> {
    app.picker().get_content_size(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_image_dimensions<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<GetImageDimensionsResponse, String> {
    app.picker().get_image_dimensions(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn get_video_dimensions<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<GetVideoDimensionsResponse, String> {
    app.picker().get_video_dimensions(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn is_directory<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<IsDirectoryResponse, String> {
    app.picker().is_directory(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn list_content_children<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<ListContentChildrenResponse, String> {
    app.picker().list_content_children(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn read_file_bytes<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<ReadFileBytesResponse, String> {
    app.picker().read_file_bytes(uri).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn take_persistable_permission<R: Runtime>(
    app: AppHandle<R>,
    uri: String,
) -> Result<(), String> {
    app.picker()
        .take_persistable_permission(uri)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn copy_image_to_pictures<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
    mime_type: String,
    display_name: String,
) -> Result<CopyImageToPicturesResponse, String> {
    app.picker()
        .copy_image_to_pictures(source_path, mime_type, display_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn copy_extracted_images_to_pictures<R: Runtime>(
    app: AppHandle<R>,
    source_dir: String,
) -> Result<CopyExtractedImagesToPicturesResponse, String> {
    app.picker()
        .copy_extracted_images_to_pictures(source_dir)
        .await
        .map_err(|e| e.to_string())
}
