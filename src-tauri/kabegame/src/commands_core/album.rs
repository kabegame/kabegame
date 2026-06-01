//! Web JSON-RPC 相册后端层。见 `super::image` 模块注释：
//! 返回 `ImageInfo` 的函数必须先 [`crate::web::image_rewrite::rewrite_image_info`]。

use kabegame_core::settings::Settings;
use kabegame_core::storage::image_events::{
    add_images_to_album_with_event, remove_images_from_album_with_event,
};
use kabegame_core::storage::{Storage, FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID};
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
use kabegame_i18n::t;
use serde_json::Value;

#[cfg(feature = "web")]
use crate::web::image_rewrite::rewrite_image_info;

pub async fn get_albums() -> Result<Value, String> {
    let albums = Storage::global().list_all_albums()?;
    serde_json::to_value(albums).map_err(|e| e.to_string())
}

pub async fn get_album_preview(album_id: String, limit: usize) -> Result<Value, String> {
    let mut images = Storage::global().get_album_preview(&album_id, limit)?;
    #[cfg(feature = "web")]
    for info in images.iter_mut() {
        rewrite_image_info(info);
    }
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn rename_album(album_id: String, new_name: String) -> Result<Value, String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub async fn delete_album(album_id: String) -> Result<Value, String> {
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

pub async fn move_album(album_id: String, new_parent_id: Option<String>) -> Result<Value, String> {
    Storage::global().move_album(&album_id, new_parent_id.as_deref())?;
    #[cfg(feature = "standard")]
    kabegame_core::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub async fn add_album(name: String, parent_id: Option<String>) -> Result<Value, String> {
    let album = Storage::global().add_album(&name, parent_id.as_deref())?;
    serde_json::to_value(album).map_err(|e| e.to_string())
}

pub async fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub async fn add_task_images_to_album(task_id: String, album_id: String) -> Result<Value, String> {
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

pub async fn remove_images_from_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let removed = remove_images_from_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "standard")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(removed).map_err(|e| e.to_string())
}

pub async fn update_album_images_order(
    album_id: String,
    image_orders: Vec<(String, i64)>,
) -> Result<Value, String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)?;
    Ok(Value::Null)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalFolderAlbumArgs {
    pub name: String,
    pub parent_id: Option<String>,
    pub sync_folder: String,
    pub recursive: bool,
}

#[cfg(target_os = "macos")]
pub async fn add_local_folder_album(args: AddLocalFolderAlbumArgs) -> Result<Value, String> {
    use kabegame_core::local_folder::{build_entries_non_recursive, build_entries_recursive};
    use std::path::Path;

    let name = args.name.trim();
    if name.is_empty() {
        return Err(t!("albums.localFolderErrors.nameRequired").to_string());
    }
    if name.contains('/') {
        return Err(t!("albums.localFolderErrors.nameNoSlash").to_string());
    }
    if matches!(
        args.parent_id.as_deref(),
        Some(HIDDEN_ALBUM_ID) | Some(FAVORITE_ALBUM_ID)
    ) {
        return Err(t!("albums.localFolderErrors.parentReadonly").to_string());
    }

    let sync_folder_raw = args.sync_folder.trim();
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

    #[cfg(feature = "standard")]
    {
        if let Some(mount_point) = VirtualDriveService::global().current_mount_point() {
            let mount_path = Path::new(&mount_point);
            let mount_canon = mount_path
                .canonicalize()
                .unwrap_or_else(|_| mount_path.to_path_buf());
            let sync_canon = sync_folder
                .canonicalize()
                .unwrap_or_else(|_| sync_folder.to_path_buf());
            if sync_canon == mount_canon || sync_canon.starts_with(&mount_canon) {
                return Err(t!(
                    "albums.localFolderErrors.virtualDrivePathForbidden",
                    path = mount_point
                )
                .to_string());
            }
        }
    }

    let entries = if args.recursive {
        build_entries_recursive(name, sync_folder, args.parent_id.as_deref())?
    } else {
        vec![build_entries_non_recursive(
            name,
            sync_folder,
            args.parent_id.as_deref(),
        )]
    };

    let created = Storage::global().add_local_folder_albums_tx(&entries)?;
    let created_ids: Vec<String> = created.iter().map(|album| album.id.clone()).collect();
    tokio::spawn(async move {
        let _ = kabegame_core::local_folder::sync_albums_by_ids(&created_ids).await;
    });

    serde_json::to_value(created).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn add_local_folder_album(_args: AddLocalFolderAlbumArgs) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.macosOnly").to_string())
}

#[cfg(target_os = "macos")]
pub async fn sync_local_folder_album(album_id: String) -> Result<Value, String> {
    let report = kabegame_core::local_folder::sync_album(&album_id).await?;
    serde_json::to_value(report).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn sync_local_folder_album(_album_id: String) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.macosOnly").to_string())
}

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
pub async fn sync_local_folder_albums(_album_ids: Vec<String>) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.macosOnly").to_string())
}
