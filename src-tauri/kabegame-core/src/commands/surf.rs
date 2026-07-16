use crate::storage::{RangedSurfRecords, Storage, SurfRecord};
use serde_json::Value;

fn normalize_surf_host(host: &str) -> String {
    host.trim().to_lowercase()
}

pub fn surf_list_records(offset: usize, limit: usize) -> Result<RangedSurfRecords, String> {
    let page_limit = if limit == 0 { 10 } else { limit };
    Storage::global().list_surf_records(offset, page_limit)
}

pub fn surf_get_all_records() -> Result<Vec<SurfRecord>, String> {
    Storage::global().list_all_surf_records()
}

/// 按传入 id 顺序返回（去空白、缺失的 id 跳过）。
pub fn surf_get_records_by_ids(ids: Vec<String>) -> Result<Vec<SurfRecord>, String> {
    let ids: Vec<String> = ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let map = Storage::global().get_surf_records_by_ids(&ids)?;
    Ok(ids
        .into_iter()
        .filter_map(|id| map.get(&id).cloned())
        .collect())
}

pub fn surf_get_record(host: String) -> Result<Option<SurfRecord>, String> {
    let host = normalize_surf_host(&host);
    if host.is_empty() {
        return Ok(None);
    }
    Storage::global().get_surf_record_by_host(&host)
}

pub fn surf_get_record_images(host: String, offset: usize, limit: usize) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    let page_limit = if limit == 0 { 50 } else { limit };
    let images = Storage::global().get_surf_record_images(&record.id, offset, page_limit)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub fn surf_update_root_url(host: String, root_url: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_root_url(&record.id, &root_url)?;
    Ok(Value::Null)
}

pub fn surf_update_name(host: String, name: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_name(&record.id, &name)?;
    Ok(Value::Null)
}

pub fn surf_delete_record(host: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().delete_surf_record(&record.id)?;
    Ok(Value::Null)
}
