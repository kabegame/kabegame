use kabegame_core::storage::Storage;
use serde_json::Value;

fn normalize_surf_host(host: &str) -> String {
    host.trim().to_lowercase()
}

pub async fn surf_update_root_url(host: String, root_url: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_root_url(&record.id, &root_url)?;
    Ok(Value::Null)
}

pub async fn surf_update_name(host: String, name: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().update_surf_record_name(&record.id, &name)?;
    Ok(Value::Null)
}

pub async fn surf_delete_record(host: String) -> Result<Value, String> {
    let host = normalize_surf_host(&host);
    let Some(record) = Storage::global().get_surf_record_by_host(&host)? else {
        return Err("畅游记录不存在".to_string());
    };
    Storage::global().delete_surf_record(&record.id)?;
    Ok(Value::Null)
}
