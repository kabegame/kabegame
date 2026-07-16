//! Web JSON-RPC 相册后端层。见 `super::image` 模块注释：
//! 返回 `ImageInfo` 的函数必须先 [`crate::web::image_rewrite::rewrite_image_info`]。

use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    add_images_to_album_with_event, remove_images_from_album_with_event,
};
use kabegame_core::storage::{Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
use kabegame_i18n::t;
use serde_json::Value;

#[cfg(feature = "web")]
use crate::web::image_rewrite::rewrite_image_info;

pub fn get_albums() -> Result<Value, String> {
    let albums = Storage::global().list_all_albums()?;
    serde_json::to_value(albums).map_err(|e| e.to_string())
}

pub fn get_album_preview(album_id: String, limit: usize) -> Result<Value, String> {
    let mut images = Storage::global().get_album_preview(&album_id, limit)?;
    #[cfg(feature = "web")]
    for info in images.iter_mut() {
        rewrite_image_info(info);
    }
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub fn rename_album(album_id: String, new_name: String) -> Result<Value, String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn delete_album(album_id: String) -> Result<Value, String> {
    Storage::global().delete_album(&album_id)?;
    if let Some(id) = Settings::global().get_wallpaper_rotation_album_id() {
        if id == album_id {
            Settings::global().set_wallpaper_rotation_album_id(None)?;
        }
    }
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn move_album(album_id: String, new_parent_id: Option<String>) -> Result<Value, String> {
    Storage::global().move_album(&album_id, new_parent_id.as_deref())?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn add_album(name: String, parent_id: Option<String>) -> Result<Value, String> {
    let album = Storage::global().add_album(&name, parent_id.as_deref())?;
    serde_json::to_value(album).map_err(|e| e.to_string())
}

pub fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub fn add_task_images_to_album(task_id: String, album_id: String) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let image_ids = Storage::get_task_image_ids(&task_id)?;
    if image_ids.is_empty() {
        return Ok(serde_json::json!({
            "added": 0,
            "attempted": 0,
            "canAdd": 0,
            "currentCount": 0
        }));
    }
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub fn remove_images_from_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let removed = remove_images_from_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(removed).map_err(|e| e.to_string())
}

pub fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<Value, String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)?;
    Ok(Value::Null)
}

#[cfg(all(not(target_os = "android"), not(feature = "web")))]
pub async fn add_local_folder_album(
    name: String,
    parent_id: Option<String>,
    sync_folder: String,
    recursive: bool,
) -> Result<Value, String> {
    use kabegame_core::local_folder::build_entries_non_recursive;
    use std::path::Path;
    // 检查画册名称
    let name = name.trim();
    if name.is_empty() {
        return Err(t!("albums.localFolderErrors.nameRequired").to_string());
    }
    if name.contains('/') {
        return Err(t!("albums.localFolderErrors.nameNoSlash").to_string());
    }
    if matches!(
        parent_id.as_deref(),
        Some(HIDDEN_ALBUM_ID) | Some(FAVORITE_ALBUM_ID)
    ) {
        return Err(t!("albums.localFolderErrors.parentReadonly").to_string());
    }

    // 检查同步文件夹是否可用
    let sync_folder_raw = sync_folder.trim();
    let sync_folder = Path::new(sync_folder_raw);
    if !sync_folder.is_absolute() {
        return Err(t!("albums.localFolderErrors.absolutePathRequired").to_string());
    }
    if sync_folder == Path::new("/") {
        return Err(t!("albums.localFolderErrors.rootPathForbidden").to_string());
    }
    match std::fs::metadata(sync_folder) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(t!("albums.localFolderErrors.notDirectory").to_string()),
        Err(err) => {
            return Err(t!(
                "albums.localFolderErrors.folderAccessFailed",
                detail = err.to_string()
            )
            .to_string())
        }
    }

    let sync_canon = sync_folder
        .canonicalize()
        .unwrap_or_else(|_| sync_folder.to_path_buf());

    // 唯一需要刻意避开的「禁区根」：VD 挂载点。根命中直接报错；递归子目录由同步钩子 forbidden_roots 静默剪枝。
    // （下载输出目录不再禁止：同步时按路径复用图库已有图片，不会产生 local_path 冲突。）
    let mut forbidden_roots: Vec<std::path::PathBuf> = Vec::new();

    #[cfg(feature = "standard")]
    {
        if let Some(mount_point) = VirtualDriveService::global().current_mount_point() {
            let mount_path = Path::new(&mount_point);
            let mount_canon = mount_path
                .canonicalize()
                .unwrap_or_else(|_| mount_path.to_path_buf());
            if sync_canon == mount_canon || sync_canon.starts_with(&mount_canon) {
                return Err(t!(
                    "albums.localFolderErrors.virtualDrivePathForbidden",
                    path = mount_point
                )
                .to_string());
            }
            forbidden_roots.push(mount_canon);
        }
    }

    // 已存在同步画册的目录：根目录重复直接报错（前端亦会禁用创建按钮）。
    let existing_sync_folders: Vec<std::path::PathBuf> = Storage::global()
        .list_local_folder_albums()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|album| album.sync_folder.map(std::path::PathBuf::from))
        .collect();
    let duplicate_root = existing_sync_folders.iter().any(|p| {
        let pc = p.canonicalize().unwrap_or_else(|_| p.clone());
        pc == sync_canon
    });
    if duplicate_root {
        return Err(t!("albums.localFolderErrors.duplicateSyncFolder").to_string());
    }

    // 只建**根画册**；子画册与文件由后台同步（递归/非递归）经扫描钩子按需产生。
    let root_entry = build_entries_non_recursive(name, sync_folder, parent_id.as_deref());
    let root_id = root_entry.id.clone();
    let created =
        Storage::global().add_local_folder_albums_tx(std::slice::from_ref(&root_entry))?;

    tokio::spawn(async move {
        if recursive {
            let _ =
                kabegame_core::local_folder::sync_album_recursive(&root_id, forbidden_roots).await;
        } else {
            let _ = kabegame_core::local_folder::sync_album(&root_id).await;
        }
    });

    serde_json::to_value(created).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
pub async fn sync_local_folder_album(
    album_id: String,
    recursive: Option<bool>,
    create_missing_albums: Option<bool>,
) -> Result<Value, String> {
    if recursive.unwrap_or(false) {
        let forbidden_roots = local_folder_forbidden_roots();
        let options = kabegame_core::local_folder::RecursiveSyncOptions {
            create_missing_albums: create_missing_albums.unwrap_or(true),
        };
        let report = kabegame_core::local_folder::sync_album_recursive_with_options(
            &album_id,
            forbidden_roots,
            options,
        )
        .await?;
        serde_json::to_value(report).map_err(|e| e.to_string())
    } else {
        let report = kabegame_core::local_folder::sync_album(&album_id).await?;
        serde_json::to_value(report).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "android")]
pub async fn sync_local_folder_album(
    _album_id: String,
    _recursive: Option<bool>,
    _create_missing_albums: Option<bool>,
) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.androidUnsupported").to_string())
}

#[cfg(not(target_os = "android"))]
pub async fn sync_local_folder_albums(album_ids: Vec<String>) -> Result<Value, String> {
    let results = kabegame_core::local_folder::sync_albums_by_ids(&album_ids).await;
    let payload: Vec<Value> = album_ids
        .iter()
        .zip(results.into_iter())
        .map(|(id, result)| match result {
            Ok(report) => serde_json::json!({
                "albumId": id,
                "ok": report,
                "err": null,
            }),
            Err(err) => serde_json::json!({
                "albumId": id,
                "ok": null,
                "err": err,
            }),
        })
        .collect();
    Ok(Value::Array(payload))
}

#[cfg(target_os = "android")]
pub async fn sync_local_folder_albums(_album_ids: Vec<String>) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.androidUnsupported").to_string())
}

/// 递归同步/创建时需要刻意避开的「禁区根」（规范化）：仅 VD 挂载点。
#[cfg(not(target_os = "android"))]
fn local_folder_forbidden_roots() -> Vec<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(feature = "standard")]
    {
        if let Some(mount_point) = VirtualDriveService::global().current_mount_point() {
            let p = std::path::Path::new(&mount_point);
            roots.push(p.canonicalize().unwrap_or_else(|_| p.to_path_buf()));
        }
    }
    roots
}
