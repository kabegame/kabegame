use crate::local_folder::scan::LocalFile;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct DbImageRow {
    pub image_id: String,
    pub local_path: String,
    pub size: Option<u64>,
    pub crawled_at: u64,
    pub hash: String,
    pub metadata_id: Option<i64>,
    pub display_name: String,
    pub order: Option<i64>,
}

#[derive(Debug)]
pub struct Plan {
    pub adds: Vec<LocalFile>,
    pub deletes: Vec<String>,
    pub maybe_reimports: Vec<MaybeReimport>,
}

#[derive(Debug, Clone)]
pub struct MaybeReimport {
    pub fs: LocalFile,
    pub db: DbImageRow,
}

pub fn diff(fs_files: &[LocalFile], db_rows: &[DbImageRow]) -> Plan {
    let mut db_by_path: HashMap<PathBuf, DbImageRow> = db_rows
        .iter()
        .map(|row| (PathBuf::from(&row.local_path), row.clone()))
        .collect();

    let mut adds = Vec::new();
    let mut maybe_reimports = Vec::new();

    for file in fs_files {
        if let Some(db_row) = db_by_path.remove(&file.path) {
            if file.mtime_unix_ms > (db_row.crawled_at as u128) * 1000 + 1000 {
                maybe_reimports.push(MaybeReimport {
                    fs: file.clone(),
                    db: db_row,
                });
            }
        } else {
            adds.push(file.clone());
        }
    }

    let deletes = db_by_path.into_values().map(|row| row.image_id).collect();

    Plan {
        adds,
        deletes,
        maybe_reimports,
    }
}
