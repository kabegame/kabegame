#[cfg(not(target_os = "android"))]
use crate::crawler::downloader::compress::{
    compress_video_for_preview, generate_compatible_image, generate_compatible_video,
};
use crate::crawler::downloader::{
    compute_file_hash, generate_thumbnail, wait_after_download_if_needed, wait_after_non_pool_download_if_needed
};
use crate::emitter::GlobalEmitter;
use crate::image_type::{is_video_by_path, mime_type_from_path};
use crate::media_dimensions::{resolve_file_size_sync, resolve_media_dimensions_sync};
use crate::storage::{ImageInfo, Storage};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOCAL_FOLDER_PLUGIN_ID: &str = "local-import";

#[derive(Debug, Clone)]
pub struct CarryFromOld {
    pub display_name: String,
    pub metadata_id: Option<i64>,
    pub order: Option<i64>,
}

pub async fn import_local_file(
    path: &Path,
    album_id: &str,
    size: u64,
    carry: Option<CarryFromOld>,
) -> Result<String, String> {
    let import_start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // local_path 唯一约束：若该路径已入库（来自其它导入途径或画册），
    // 不再重复插入，而是把既有图片关联到本画册（幂等）。reimport 已在调用方先删旧行，
    // 因此这里不会误命中旧记录。
    let path_str = path.to_string_lossy();
    if let Some(existing) = Storage::find_image_by_path(&path_str).ok().flatten() {
        let storage = Storage::global();
        let image_id = existing.id.clone();
        let added = storage.add_images_to_album_silent(album_id, &[image_id.clone()]);
        if let Some(order) = carry.as_ref().and_then(|old| old.order) {
            storage.update_album_images_order(album_id, &[(image_id.clone(), order)])?;
        }
        if added > 0 {
            let album_ids = vec![album_id.to_string()];
            let image_ids = vec![image_id.clone()];
            GlobalEmitter::global().emit_album_images_change("add", &album_ids, &image_ids);
        }
        wait_after_download_if_needed(import_start_time, None).await;
        return Ok(image_id);
    }

    let hash = compute_file_hash(path).await?;
    let is_video = is_video_by_path(path);
    let thumbnail_path = build_thumbnail_path(path, is_video).await;
    let (width, height) = resolve_media_dimensions_sync(&path.to_string_lossy())
        .map(|(w, h)| (Some(w), Some(h)))
        .unwrap_or((None, None));

    let resolved_size = resolve_file_size_sync(&path.to_string_lossy()).or(Some(size));

    let basename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string();
    let display_name = carry
        .as_ref()
        .map(|old| old.display_name.clone())
        .unwrap_or(basename);
    let metadata_id = carry.as_ref().and_then(|old| old.metadata_id);
    let crawled_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let media_type = mime_type_from_path(path).or_else(|| {
        Some(
            if is_video {
                crate::image_type::default_video_mime()
            } else {
                crate::image_type::default_image_mime()
            }
            .to_string(),
        )
    });

    let compatible_path = build_compatible_path(path, is_video, &media_type, width, height).await;

    let image = ImageInfo {
        id: String::new(),
        url: None,
        local_path: path.to_string_lossy().into_owned(),
        plugin_id: LOCAL_FOLDER_PLUGIN_ID.to_string(),
        task_id: None,
        surf_record_id: None,
        crawled_at,
        metadata_id,
        metadata_version: 0,
        thumbnail_path,
        favorite: false,
        is_hidden: false,
        local_exists: true,
        hash,
        width,
        height,
        display_name,
        media_type,
        last_set_wallpaper_at: None,
        size: resolved_size,
        album_order: None,
        compatible_path,
    };

    let storage = Storage::global();
    let inserted = storage.add_image(image)?;
    let image_id = inserted.id.clone();
    storage.add_images_to_album(album_id, &[image_id.clone()])?;
    if let Some(order) = carry.as_ref().and_then(|old| old.order) {
        storage.update_album_images_order(album_id, &[(image_id.clone(), order)])?;
    }

    let album_ids = vec![album_id.to_string()];
    let image_ids = vec![image_id.clone()];
    let plugin_ids = vec![LOCAL_FOLDER_PLUGIN_ID.to_string()];
    GlobalEmitter::global().emit_images_change("add", &image_ids, None, None, Some(&plugin_ids));
    GlobalEmitter::global().emit_album_images_change("add", &album_ids, &image_ids);

    wait_after_download_if_needed(import_start_time, None).await;
    Ok(image_id)
}

#[cfg(not(target_os = "android"))]
async fn build_thumbnail_path(path: &Path, is_video: bool) -> String {
    let result = if is_video {
        compress_video_for_preview(path)
            .await
            .map(|result| Some(result.preview_path))
    } else {
        generate_thumbnail(path).await
    };
    match result {
        Ok(Some(path)) => path
            .canonicalize()
            .ok()
            .map(|p| {
                p.to_string_lossy()
                    .trim_start_matches("\\\\?\\")
                    .to_string()
            })
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        _ => path.to_string_lossy().into_owned(),
    }
}

#[cfg(target_os = "android")]
async fn build_thumbnail_path(path: &Path, _is_video: bool) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(not(target_os = "android"))]
async fn build_compatible_path(
    path: &Path,
    is_video: bool,
    media_type: &Option<String>,
    width: Option<u32>,
    height: Option<u32>,
) -> Option<String> {
    let result = if is_video {
        match crate::media_dimensions::probe_media_sync(path) {
            Some(probe) => generate_compatible_video(path, &probe).await,
            None => Ok(None),
        }
    } else {
        match (width, height, media_type.as_deref()) {
            (Some(w), Some(h), Some(mime)) => generate_compatible_image(path, mime, w, h).await,
            _ => Ok(None),
        }
    };
    match result {
        Ok(Some(p)) => p.canonicalize().ok().map(|cp| {
            cp.to_string_lossy()
                .trim_start_matches("\\\\?\\")
                .to_string()
        }),
        Ok(None) => None,
        Err(e) => {
            eprintln!("[local-import] compatible generation failed: {e}");
            None
        }
    }
}

#[cfg(target_os = "android")]
async fn build_compatible_path(
    _path: &Path,
    _is_video: bool,
    _media_type: &Option<String>,
    _width: Option<u32>,
    _height: Option<u32>,
) -> Option<String> {
    None
}
