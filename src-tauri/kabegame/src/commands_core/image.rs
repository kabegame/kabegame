//! Web JSON-RPC 的命令后端层。
//!
//! 唯一调用方是 `crate::web::dispatch`（桌面 Tauri 走 `crate::commands::image`，另一套）。
//! 本模块事实上就是 web 边界：任何返回 `ImageInfo`（或嵌套 `ImageInfo`）的函数，
//! **必须**在序列化前调用 `crate::web::image_rewrite::rewrite_image_info`，
//! 把 `local_path` / `thumbnail_path` 改写成 CDN 绝对 URL。否则 web 客户端拿到
//! 的是服务器本地路径，浏览器没法直接加载。

use kabegame_core::gallery::GalleryBrowseEntry;
use kabegame_core::providers::{
    decode_provider_path_segments, execute_provider_query_typed, provider_query_to_json,
    provider_runtime, ProviderQueryTyped,
};
use kabegame_core::storage::image_events::{
    delete_images_with_events, toggle_image_favorite_with_event,
};
use kabegame_core::storage::Storage;
use serde_json::Value;

#[cfg(feature = "web")]
use crate::web::image_rewrite::rewrite_image_info;

fn encode_provider_path_segment(s: &str) -> String {
    s.bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![b as char]
            }
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

/// 对 typed provider 查询结果里的每个 Image 条目做 CDN URL 改写。
#[cfg(feature = "web")]
fn rewrite_provider_query(t: &mut ProviderQueryTyped) {
    if let ProviderQueryTyped::Listing { entries, .. } = t {
        for entry in entries.iter_mut() {
            if let GalleryBrowseEntry::Image { image } = entry {
                rewrite_image_info(image);
            }
        }
    }
}

pub async fn browse_gallery_provider(path: String) -> Result<Value, String> {
    let full = format!("gallery/{}", path.trim().trim_start_matches('/'));
    let full = decode_provider_path_segments(&full);
    let result = tokio::task::spawn_blocking(move || {
        let mut typed = execute_provider_query_typed(&full)?;
        #[cfg(feature = "web")]
        rewrite_provider_query(&mut typed);
        provider_query_to_json(&typed)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

pub async fn list_provider_children(path: String) -> Result<Value, String> {
    let full = format!("gallery/{}", path.trim().trim_start_matches('/'));
    let full = decode_provider_path_segments(&full);
    let result = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let rt = provider_runtime();
        let path = if full.starts_with('/') {
            full.clone()
        } else {
            format!("/{}", full)
        };
        let children = rt.list(&path).map_err(|e| format!("list failed: {}", e))?;
        let base = path.trim_end_matches('/').to_string();
        let entries = children
            .into_iter()
            .map(|child| {
                let name = child.name;
                let meta = child.meta;
                let child_path = format!("{}/{}", base, encode_provider_path_segment(&name));
                let total = rt.count(&child_path).ok();
                serde_json::json!({
                    "kind": "dir",
                    "name": name,
                    "meta": meta,
                    "total": total,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_value(entries).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

pub async fn query_provider(path: String) -> Result<Value, String> {
    let p = path.trim().to_string();
    let result = tokio::task::spawn_blocking(move || {
        let mut typed = execute_provider_query_typed(&p)?;
        #[cfg(feature = "web")]
        rewrite_provider_query(&mut typed);
        provider_query_to_json(&typed)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

pub async fn get_images_count() -> Result<Value, String> {
    let count = Storage::global().get_total_count()?;
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub async fn get_gallery_plugin_groups() -> Result<Value, String> {
    let groups = Storage::global().get_gallery_plugin_groups()?;
    serde_json::to_value(groups).map_err(|e| e.to_string())
}

pub async fn get_gallery_media_type_counts() -> Result<Value, String> {
    let c = Storage::global().get_gallery_media_type_counts()?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub async fn get_album_media_type_counts(album_id: String) -> Result<Value, String> {
    let c = Storage::global().get_album_media_type_counts(&album_id)?;
    serde_json::to_value(c).map_err(|e| e.to_string())
}

pub async fn get_gallery_time_filter_data() -> Result<Value, String> {
    let p = Storage::global().get_gallery_time_filter_payload()?;
    serde_json::to_value(p).map_err(|e| e.to_string())
}

pub async fn get_image_by_id(image_id: String) -> Result<Value, String> {
    let mut image = Storage::global().find_image_by_id(&image_id)?;
    #[cfg(feature = "web")]
    if let Some(info) = image.as_mut() {
        rewrite_image_info(info);
    }
    serde_json::to_value(image).map_err(|e| e.to_string())
}

pub async fn get_image_metadata(image_id: String) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata(&image_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn get_image_metadata_by_metadata_id(metadata_id: i64) -> Result<Value, String> {
    let meta = Storage::global().get_image_metadata_by_metadata_id(metadata_id)?;
    serde_json::to_value(meta).map_err(|e| e.to_string())
}

pub async fn toggle_image_favorite(image_id: String, favorite: bool) -> Result<Value, String> {
    toggle_image_favorite_with_event(&image_id, favorite)?;
    #[cfg(all(feature = "standard", feature = "vd-legacy"))]
    {
        use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
        kabegame_core::virtual_driver::VirtualDriveService::global()
            .notify_album_dir_changed(kabegame_core::storage::FAVORITE_ALBUM_ID);
    }
    Ok(Value::Null)
}

pub async fn delete_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(&[image_id], true)?;
    Ok(Value::Null)
}

pub async fn remove_image(image_id: String) -> Result<Value, String> {
    delete_images_with_events(&[image_id], false)?;
    Ok(Value::Null)
}

pub async fn batch_delete_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, true)?;
    Ok(Value::Null)
}

pub async fn batch_remove_images(image_ids: Vec<String>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, false)?;
    Ok(Value::Null)
}
