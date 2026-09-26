use crate::local_folder::fs_listener::FsBatch;
use crate::local_folder::scan_service::ScannedDir;
use crate::local_folder::sync::{
    create_child_albums, local_folder_forbidden_roots, remove_album_tree,
};
use crate::local_folder::synchronizer::{submit, Descend, FullSyncOptions, SyncCmd, SyncOrigin};
use crate::local_folder::SyncMode;
use crate::media::image_type::is_media_by_path;
use crate::storage::{Album, Storage};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use url::Url;

pub(crate) struct DiffRequest {
    pub album_id: String,
    pub ancestor_path: String,
    pub paths: BTreeSet<PathBuf>,
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn album_index(albums: &[Album]) -> HashMap<PathBuf, Album> {
    albums
        .iter()
        .filter_map(|album| {
            album
                .sync_folder
                .as_deref()
                .map(|path| (normalize_path(Path::new(path)), album.clone()))
        })
        .collect()
}

pub(crate) async fn process_batch(batch: FsBatch) -> Result<Vec<DiffRequest>, String> {
    let mut albums = Storage::global().list_local_folder_albums()?;
    let mut index = album_index(&albums);

    let missing_paths: Vec<_> = batch
        .changes
        .keys()
        .filter(|path| {
            matches!(
                std::fs::metadata(path),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound
            )
        })
        .cloned()
        .collect();
    let mut removed = albums
        .iter()
        .filter(|album| {
            let Some(sync_folder) = album.sync_folder.as_deref() else {
                return false;
            };
            let sync_path = normalize_path(Path::new(sync_folder));
            missing_paths
                .iter()
                .any(|missing| sync_path == *missing || sync_path.starts_with(missing))
        })
        .cloned()
        .collect::<Vec<_>>();
    removed.sort_by_key(|album| album.ancestor_path.len());
    let mut removed_roots = Vec::<String>::new();
    for album in removed {
        if removed_roots
            .iter()
            .any(|root| album.ancestor_path.starts_with(root))
        {
            continue;
        }
        removed_roots.push(album.ancestor_path.clone());
        remove_album_tree(&album.id).await?;
    }

    if !removed_roots.is_empty() {
        albums = Storage::global().list_local_folder_albums()?;
        index = album_index(&albums);
    }

    let forbidden = local_folder_forbidden_roots();
    let mut new_dirs: HashMap<String, Vec<ScannedDir>> = HashMap::new();
    for path in batch.changes.keys() {
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata.is_dir() || index.contains_key(&normalize_path(path)) {
            continue;
        }
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let canon = normalize_path(path);
        if forbidden
            .iter()
            .any(|root| canon == *root || canon.starts_with(root))
        {
            continue;
        }
        let Some(parent_path) = path.parent().map(normalize_path) else {
            continue;
        };
        let Some(parent) = index.get(&parent_path) else {
            continue;
        };
        let Some(mode) = SyncMode::from_str(&parent.sync_mode) else {
            continue;
        };
        if !matches!(mode, SyncMode::Recursive | SyncMode::Delegated) {
            continue;
        }
        let Ok(url) = Url::from_file_path(path) else {
            continue;
        };
        new_dirs
            .entry(parent.id.clone())
            .or_default()
            .push(ScannedDir {
                url,
                path: Some(path.to_path_buf()),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                depth: 1,
            });
    }

    let mut created = Vec::new();
    for (parent_id, dirs) in new_dirs {
        created.extend(create_child_albums(&parent_id, &dirs)?);
    }
    if !created.is_empty() {
        Storage::global().rechain_local_folder_albums()?;
        crate::local_folder::fs_listener::reconcile_now().await;
        for album in created {
            submit(SyncCmd::Full {
                album_id: album.id,
                opts: FullSyncOptions {
                    descend: Descend::CreateMissing,
                    origin: SyncOrigin::Event,
                    depth: 0,
                },
            });
        }
        albums = Storage::global().list_local_folder_albums()?;
        index = album_index(&albums);
    }

    let removed_ids: HashSet<_> = removed_roots.into_iter().collect();
    let mut grouped: HashMap<String, DiffRequest> = HashMap::new();
    for path in batch.changes.keys() {
        if !is_media_by_path(path) {
            continue;
        }
        let Some(parent_path) = path.parent().map(normalize_path) else {
            continue;
        };
        let Some(album) = index.get(&parent_path) else {
            continue;
        };
        if removed_ids
            .iter()
            .any(|root| album.ancestor_path.starts_with(root))
            || SyncMode::from_str(&album.sync_mode) == Some(SyncMode::None)
        {
            continue;
        }
        grouped
            .entry(album.id.clone())
            .or_insert_with(|| DiffRequest {
                album_id: album.id.clone(),
                ancestor_path: album.ancestor_path.clone(),
                paths: BTreeSet::new(),
            })
            .paths
            .insert(path.to_path_buf());
    }
    Ok(grouped.into_values().collect())
}
