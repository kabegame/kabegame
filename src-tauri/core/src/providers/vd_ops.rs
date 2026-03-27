//! 虚拟盘（virtual-driver feature）专用：可写操作的辅助函数。
//!
//! 约束：
//! - 仅用于 core/providers 的 VD 方法实现（mkdir/delete/说明文件等）。
//! - Dokan/挂载/Windows 句柄等实现细节在 app-main。

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 从文件名中提取 image_id
pub(crate) fn image_id_from_filename(name: &str) -> Option<&str> {
    let image_id = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let trimmed = image_id.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// 从 ImageQuery 中提取 album_id
pub(crate) fn album_id_from_query(query: &ImageQuery) -> Option<&str> {
    query.album_id()
}

pub(crate) fn query_can_delete_child_file(query: &ImageQuery) -> bool {
    // 仅当该查询代表“画册视图”（by_album）时才允许 delete file = remove from album
    album_id_from_query(query).is_some()
}

pub(crate) fn query_delete_child_file(
    query: &ImageQuery,
    child_name: &str,
) -> Result<bool, String> {
    let Some(album_id) = album_id_from_query(query) else {
        return Err("当前目录不支持删除文件".to_string());
    };
    let image_id = image_id_from_filename(child_name)
        .ok_or_else(|| "文件名无效".to_string())?
        .to_string();
    let removed = Storage::global().remove_images_from_album(album_id, &[image_id])?;
    Ok(removed > 0)
}

/// 在虚拟盘中创建画册子目录
pub(crate) fn albums_create_child_dir(child_name: &str) -> Result<(), String> {
    Storage::global().add_album(child_name).map(|_| ())
}

/// 在虚拟盘中将一张图片移除画册
pub(crate) fn album_delete_child_file(
    album_id: &str,
    child_name: &str,
) -> Result<bool, String> {
    let image_id = image_id_from_filename(child_name)
        .ok_or_else(|| "文件名无效".to_string())?
        .to_string();
    let removed = Storage::global().remove_images_from_album(album_id, &[image_id])?;
    Ok(removed > 0)
}

// === plugin manifest name（VD 任务目录展示用）===

static PLUGIN_NAME_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub(crate) fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    let pid = plugin_id.trim();
    if pid.is_empty() {
        return None;
    }

    let cache = PLUGIN_NAME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(v) = guard.get(pid) {
            return if v.is_empty() { None } else { Some(v.clone()) };
        }
    }

    let pm = crate::plugin::PluginManager::global_opt()?;
    let name = pm.get_cached_plugin_display_name_sync(pid)?;

    if let Ok(mut guard) = cache.lock() {
        guard.insert(pid.to_string(), name.clone());
    }
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

// === 说明文件（VD 专用）===

#[cfg(not(target_os = "android"))]
fn note_dir() -> PathBuf {
    crate::app_paths::AppPaths::global().virtual_driver_notes()
}

fn note_id_for_name(name: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    let mut h = DefaultHasher::new();
    name.hash(&mut h);
    format!("{}", h.finish())
}

pub(crate) fn ensure_note_file(
    display_name: &str,
    content: &str,
) -> Result<(String, PathBuf), String> {
    let dir = note_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建虚拟盘说明文件目录失败: {}", e))?;

    let id = note_id_for_name(display_name);
    let path = dir.join(format!("{}.txt", &id));
    if !path.exists() {
        // Windows/Explorer 对 CRLF 更友好
        let mut text = content.replace('\n', "\r\n");
        if !text.ends_with("\r\n") {
            text.push_str("\r\n");
        }
        std::fs::write(&path, text).map_err(|e| format!("写入虚拟盘说明文件失败: {}", e))?;
    }
    Ok((id, path))
}
