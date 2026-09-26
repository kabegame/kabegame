//! 相册命令的共享实现层。返回 `ImageInfo` 的函数一律回**原始本地路径**；
//! web 模式的 CDN 改写由调用方（`kabegame::web::dispatch`）在本层返回之后施加。

use crate::settings::Settings;
use crate::storage::image_events::{
    add_images_to_album_with_event, remove_images_from_album_with_event,
};
use crate::storage::Storage;
#[cfg(feature = "virtual-driver")]
use crate::virtual_driver::VirtualDriveService;
use kabegame_i18n::t;
use serde_json::Value;

pub fn get_albums() -> Result<Value, String> {
    let albums = Storage::global().list_all_albums()?;
    serde_json::to_value(albums).map_err(|e| e.to_string())
}

pub fn get_album_preview(album_id: String, limit: usize) -> Result<Value, String> {
    let images = Storage::global().get_album_preview(&album_id, limit)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub fn rename_album(album_id: String, new_name: String) -> Result<Value, String> {
    Storage::global().rename_album(&album_id, &new_name)?;
    #[cfg(feature = "virtual-driver")]
    crate::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn delete_album(album_id: String) -> Result<Value, String> {
    Storage::global().delete_album(&album_id)?;
    if let Some(id) = Settings::global().get_wallpaper_rotation_album_id() {
        if id == album_id {
            Settings::global().set_wallpaper_rotation_album_id(None)?;
        }
    }
    #[cfg(feature = "virtual-driver")]
    crate::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn move_album(album_id: String, new_parent_id: Option<String>) -> Result<Value, String> {
    Storage::global().move_album(&album_id, new_parent_id.as_deref())?;
    #[cfg(feature = "virtual-driver")]
    crate::virtual_driver::VirtualDriveService::global().bump_albums();
    Ok(Value::Null)
}

pub fn set_album_sync_mode(
    album_id: String,
    mode: crate::local_folder::SyncMode,
) -> Result<Value, String> {
    Storage::global().set_album_sync_mode(&album_id, mode)?;
    if matches!(
        mode,
        crate::local_folder::SyncMode::Shallow | crate::local_folder::SyncMode::Recursive
    ) {
        let descend = match mode {
            crate::local_folder::SyncMode::Shallow => crate::local_folder::Descend::None,
            crate::local_folder::SyncMode::Recursive => crate::local_folder::Descend::CreateMissing,
            _ => unreachable!(),
        };
        crate::local_folder::synchronizer::submit(
            crate::local_folder::synchronizer::SyncCmd::Full {
                album_id,
                opts: crate::local_folder::FullSyncOptions {
                    descend,
                    origin: crate::local_folder::SyncOrigin::System,
                    depth: 0,
                },
            },
        );
    }
    Ok(Value::Null)
}

#[cfg(not(target_os = "android"))]
pub async fn convert_local_folder_album_to_normal(album_id: String) -> Result<Value, String> {
    let album = Storage::global()
        .get_album_by_id(&album_id)?
        .ok_or_else(|| "画册不存在".to_string())?;
    if crate::local_folder::synchronizer::is_busy_under(&album.ancestor_path) {
        return Err(t!("albums.localFolderErrors.syncInProgress").to_string());
    }
    let converted_ids = Storage::global().convert_local_folder_album_to_normal(&album_id)?;
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().bump_albums();
    serde_json::to_value(converted_ids).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
pub async fn convert_local_folder_album_to_normal(_album_id: String) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.androidUnsupported").to_string())
}

pub fn add_album(name: String, parent_id: Option<String>) -> Result<Value, String> {
    let album = Storage::global().add_album(&name, parent_id.as_deref())?;
    serde_json::to_value(album).map_err(|e| e.to_string())
}

pub fn add_images_to_album(album_id: String, image_ids: Vec<String>) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "virtual-driver")]
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
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())
}

pub fn remove_images_from_album(album_id: String, image_ids: Vec<String>) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let removed = remove_images_from_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "virtual-driver")]
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

#[cfg(not(target_os = "android"))]
pub async fn add_local_folder_album(
    name: String,
    parent_id: Option<String>,
    sync_folder: String,
    recursive: bool,
) -> Result<Value, String> {
    use crate::local_folder::{build_entries_non_recursive, SyncMode};
    use std::path::Path;
    // 检查画册名称
    let name = name.trim();
    if name.is_empty() {
        return Err(t!("albums.localFolderErrors.nameRequired").to_string());
    }
    if name.contains('/') {
        return Err(t!("albums.localFolderErrors.nameNoSlash").to_string());
    }
    if let Some(deprecated_parent_id) = parent_id.as_deref() {
        eprintln!(
            "[deprecated] add_local_folder_album parent_id={deprecated_parent_id} is ignored; hierarchy is derived from sync_folder"
        );
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
    #[cfg(feature = "virtual-driver")]
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
    let mut root_entry = build_entries_non_recursive(name, sync_folder, None);
    root_entry.sync_mode = SyncMode::None;
    let root_id = root_entry.id.clone();
    let created =
        Storage::global().add_local_folder_albums_tx(std::slice::from_ref(&root_entry))?;
    Storage::global().rechain_local_folder_albums()?;

    crate::local_folder::synchronizer::submit(crate::local_folder::synchronizer::SyncCmd::Full {
        album_id: root_id,
        opts: crate::local_folder::FullSyncOptions {
            descend: if recursive {
                crate::local_folder::Descend::CreateMissing
            } else {
                crate::local_folder::Descend::None
            },
            origin: crate::local_folder::SyncOrigin::System,
            depth: 0,
        },
    });

    serde_json::to_value(created).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
pub async fn sync_local_folder_album(
    album_id: String,
    descend: Option<crate::local_folder::Descend>,
) -> Result<Value, String> {
    crate::local_folder::synchronizer::submit(crate::local_folder::synchronizer::SyncCmd::Full {
        album_id,
        opts: crate::local_folder::FullSyncOptions {
            descend: descend.unwrap_or(crate::local_folder::Descend::None),
            origin: crate::local_folder::SyncOrigin::Manual,
            depth: 0,
        },
    });
    Ok(Value::Null)
}

#[cfg(target_os = "android")]
pub async fn sync_local_folder_album(
    _album_id: String,
    _descend: Option<crate::local_folder::Descend>,
) -> Result<Value, String> {
    Err(t!("albums.localFolderErrors.androidUnsupported").to_string())
}

#[cfg(not(target_os = "android"))]
pub fn get_folder_sync_run_state() -> Result<Value, String> {
    let tasks = crate::local_folder::FolderSyncService::global().snapshot();
    Ok(serde_json::json!({ "tasks": tasks }))
}

#[cfg(target_os = "android")]
pub fn get_folder_sync_run_state() -> Result<Value, String> {
    Ok(serde_json::json!({ "tasks": [] }))
}

#[cfg(not(target_os = "android"))]
pub fn cancel_folder_sync(album_id: Option<String>) -> Result<Value, String> {
    let canceled = match album_id {
        Some(album_id) => usize::from(crate::local_folder::synchronizer::cancel(&album_id)),
        None => crate::local_folder::synchronizer::cancel_all(),
    };
    Ok(serde_json::json!({ "canceled": canceled }))
}

#[cfg(target_os = "android")]
pub fn cancel_folder_sync(_album_id: Option<String>) -> Result<Value, String> {
    Ok(serde_json::json!({ "canceled": 0 }))
}
