//! 构造本地文件夹同步画册的批量创建条目。

use std::fs;
use std::path::Path;

const MAX_DEPTH: usize = 16;
const NAME_SEPARATOR: &str = "-";

#[derive(Debug, Clone)]
pub struct NewLocalFolderEntry {
    pub id: String,
    pub name: String,
    pub sync_folder: String,
    pub parent_id: Option<String>,
}

pub fn build_entries_non_recursive(
    root_name: &str,
    sync_folder: &Path,
    parent_id: Option<&str>,
) -> NewLocalFolderEntry {
    NewLocalFolderEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: root_name.to_string(),
        sync_folder: sync_folder.to_string_lossy().into_owned(),
        parent_id: parent_id.map(|s| s.to_string()),
    }
}

pub fn build_entries_recursive(
    root_name: &str,
    sync_folder: &Path,
    parent_id: Option<&str>,
) -> Result<Vec<NewLocalFolderEntry>, String> {
    if !sync_folder.is_absolute() {
        return Err(format!(
            "sync_folder must be absolute: {}",
            sync_folder.display()
        ));
    }

    let mut out = Vec::new();
    let root = NewLocalFolderEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name: root_name.to_string(),
        sync_folder: sync_folder.to_string_lossy().into_owned(),
        parent_id: parent_id.map(|s| s.to_string()),
    };
    let root_id = root.id.clone();
    out.push(root);
    walk(sync_folder, root_name, &root_id, 0, &mut out)?;
    Ok(out)
}

fn walk(
    dir: &Path,
    prefix: &str,
    parent_id: &str,
    depth: usize,
    out: &mut Vec<NewLocalFolderEntry>,
) -> Result<(), String> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }

    let mut entries = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .collect::<Vec<fs::DirEntry>>(),
        Err(err) => {
            eprintln!("[local_folder] skip subdir {}: {err}", dir.display());
            return Ok(());
        }
    };
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }

        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if name_str.starts_with('.') {
            continue;
        }

        let child_path = entry.path();
        let child_album_name = format!("{prefix}{NAME_SEPARATOR}{name_str}");
        let child_id = uuid::Uuid::new_v4().to_string();
        out.push(NewLocalFolderEntry {
            id: child_id.clone(),
            name: child_album_name.clone(),
            sync_folder: child_path.to_string_lossy().into_owned(),
            parent_id: Some(parent_id.to_string()),
        });
        walk(&child_path, &child_album_name, &child_id, depth + 1, out)?;
    }

    Ok(())
}
