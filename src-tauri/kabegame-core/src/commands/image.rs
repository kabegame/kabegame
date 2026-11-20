//! 图片命令的共享实现层。
//!
//! 调用方（均在 `kabegame` crate）：`web::dispatch`（web 模式 JSON-RPC）与
//! `commands::image`（桌面 Tauri 薄包装）。两者共用本实现。
//! 返回 `ImageInfo`（或嵌套）的函数一律回**原始本地路径**；web 模式的 CDN 改写
//! 由 `kabegame::web::dispatch` 在本层返回之后施加，本层不感知 web。

use crate::providers::{
    decode_provider_path_segments, query_all, query_entry, query_fetch, query_list, PathqlQuery,
};
use crate::settings::Settings;
use crate::storage::image_events::{
    begin_delete_images_with_events, delete_images_with_events, emit_native_metadata_attached,
    toggle_image_favorite_with_event,
};
use crate::storage::Storage;
use serde_json::{json, Value};

pub async fn pathql_entry(path: String) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_entry(&path))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn pathql_list(path: String, with_count: bool) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_list(&path, with_count))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn pathql_fetch(path: String) -> Result<Value, String> {
    let path = decode_provider_path_segments(&path);
    let result = tokio::task::spawn_blocking(move || query_fetch(&path))
        .await
        .map_err(|e| e.to_string())??;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn pathql_all(mut queries: Vec<PathqlQuery>) -> Result<Vec<Value>, String> {
    for query in &mut queries {
        let (PathqlQuery::List { path, .. }
        | PathqlQuery::Entry { path }
        | PathqlQuery::Fetch { path }
        | PathqlQuery::Count { path }) = query;
        *path = decode_provider_path_segments(path);
    }
    tokio::task::spawn_blocking(move || query_all(&queries))
        .await
        .map_err(|e| e.to_string())?
}

pub fn get_images_count() -> Result<Value, String> {
    let count = Storage::global().get_total_count()?;
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub fn get_gallery_plugin_groups() -> Result<Value, String> {
    let groups = Storage::global().get_gallery_plugin_groups()?;
    serde_json::to_value(groups).map_err(|e| e.to_string())
}

pub fn get_gallery_media_type_counts() -> Result<Value, String> {
    let c = Storage::global().get_gallery_media_type_counts()?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub fn get_album_media_type_counts(album_id: String) -> Result<Value, String> {
    let c = Storage::global().get_album_media_type_counts(&album_id)?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub fn get_gallery_time_filter_data() -> Result<Value, String> {
    let p = Storage::global().get_gallery_time_filter_payload()?;
    serde_json::to_value(p).map_err(|e| e.to_string())
}

pub fn get_image_metadata(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_metadata(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub fn get_image_metadata_full(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_metadata_full(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn get_image_native_metadata(image_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    let row = storage
        .get_image_native_metadata_row(&image_id)?
        .ok_or_else(|| "native-metadata:image-not-found".to_string())?;
    let format_key = row.format_key.as_deref().unwrap_or("");
    if !crate::media::native_metadata::supports_native_metadata(format_key) {
        return Ok(Value::Null);
    }
    let Some(expected_version) = crate::media::native_metadata::parser_version_for(format_key)
    else {
        return Ok(Value::Null);
    };

    if row.parser_version == Some(expected_version) {
        if let Some(data) = row.data.as_deref() {
            return native_metadata_payload(data, expected_version);
        }
    }

    // 查看时才懒解析 / 挂载：挂载会改变 `search/native-metadata` 的成员，必须通知视图重查——
    // 否则带原生元数据过滤的列表要等手动刷新才会把这张图移出（预览自己会保留它）。
    let bytes = crate::media::native_metadata::read_image_bytes(&row.local_path).await?;
    let parsed = crate::media::native_metadata::parse_native_metadata(format_key, &bytes)
        .ok_or_else(|| "native-metadata:unsupported-format".to_string())?;
    let json = serde_json::to_string(&parsed)
        .map_err(|e| format!("native-metadata:serialize-failed:{e}"))?;
    let metadata_id = storage.replace_image_native_metadata(&image_id, expected_version, &json)?;
    emit_native_metadata_attached(&image_id, metadata_id);
    native_metadata_payload(&json, expected_version)
}

fn native_metadata_payload(data: &str, parser_version: u32) -> Result<Value, String> {
    let mut payload: Value =
        serde_json::from_str(data).map_err(|e| format!("native-metadata:invalid-cache:{e}"))?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "native-metadata:invalid-cache".to_string())?;
    object.insert("v".to_string(), json!(parser_version));
    Ok(payload)
}

pub fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    Ok(Value::Null)
}

/// 图片被移出图库后，把所有壁纸目标里指向它的当前壁纸清空，避免留下悬空引用。
fn clear_current_wallpaper_if_removed(removed_ids: &[String]) {
    let _ = Settings::global().clear_wallpaper_targets_current_images(removed_ids);
}

/// 把视频（含 `x-wpe/video`）在 `time_secs` 秒（前端 `<video>.currentTime`）时的画面设为封面，返回新的缩略图路径。
///
/// 后端从视频文件解那一帧（[`generate_video_cover`]），不截屏：放大、控制条都不影响结果。普通视频先读原文件、解不了再读
/// 兼容副本（时间轴相同）；WPE 视频读 `compatible_path`（入口视频或兼容副本），壁纸目录本身不是文件。换 `thumbnail_path`
/// 后发 `thumbnailPath` 补丁；旧缩略图只删 `thumbnails_dir` 里的，WPE 作者的 `preview.*` 不动。封面和首帧缩略图是同一种
/// 形态（`thumbnails_dir` 里的 JPEG），回填与整理都不会把它换回首帧。只在桌面（Android 的视频缩略图是 GIF 动图）。
///
/// [`generate_video_cover`]: crate::crawler::downloader::compress::generate_video_cover
#[cfg(not(target_os = "android"))]
pub async fn set_video_cover(image_id: String, time_secs: f64) -> Result<String, String> {
    use crate::media::image_type::{is_video_like_type, is_wpe_video_type};

    if !time_secs.is_finite() || time_secs < 0.0 {
        return Err(format!("invalid time: {time_secs}"));
    }
    let info = Storage::find_image_by_id(&image_id)?.ok_or("image not found")?;
    let media_type = info.media_type.as_deref();
    if !is_video_like_type(media_type) {
        return Err("not a video".into());
    }
    let compatible = info
        .compatible_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let sources: Vec<&str> = if is_wpe_video_type(media_type) {
        compatible.into_iter().collect()
    } else {
        std::iter::once(info.local_path.trim())
            .filter(|path| !path.is_empty())
            .chain(compatible)
            .collect()
    };

    let mut failure = "no playable video file".to_string();
    let mut cover = None;
    for source in sources {
        match crate::crawler::downloader::compress::generate_video_cover(source, time_secs).await {
            Ok(path) => {
                cover = Some(path);
                break;
            }
            Err(error) => failure = error,
        }
    }
    let cover = cover.ok_or(failure)?;
    let path = cover.to_string_lossy().into_owned();

    let (id, target) = (image_id.clone(), path.clone());
    let replaced = tokio::task::spawn_blocking(move || {
        Storage::global().replace_image_thumbnail_path(&id, &target)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    if let Err(error) = replaced {
        // 没换上的封面没有行引用它，留着就成了孤儿文件
        let _ = std::fs::remove_file(&cover);
        return Err(error);
    }
    crate::emitter::GlobalEmitter::global().emit_image_fields(
        std::slice::from_ref(&image_id),
        json!({ "thumbnailPath": path }),
    );
    Ok(path)
}

pub async fn delete_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(std::slice::from_ref(&image_id), true).await?;
    clear_current_wallpaper_if_removed(std::slice::from_ref(&image_id));
    Ok(Value::Null)
}

pub async fn remove_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(std::slice::from_ref(&image_id), false).await?;
    clear_current_wallpaper_if_removed(std::slice::from_ref(&image_id));
    Ok(Value::Null)
}

pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<Value, String> {
    let pending = begin_delete_images_with_events(&image_ids, true)?;
    clear_current_wallpaper_if_removed(&image_ids);
    pending.finish().await;
    Ok(Value::Null)
}

pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<Value, String> {
    let pending = begin_delete_images_with_events(&image_ids, false)?;
    clear_current_wallpaper_if_removed(&image_ids);
    pending.finish().await;
    Ok(Value::Null)
}
