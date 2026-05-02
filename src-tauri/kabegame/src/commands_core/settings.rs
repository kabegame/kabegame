use kabegame_core::settings::Settings;
use serde_json::Value;

pub fn get_favorite_album_id() -> Result<Value, String> {
    Ok(Value::String(
        "00000000-0000-0000-0000-000000000001".to_string(),
    ))
}

pub fn get_import_recommended_schedule_enabled() -> Result<Value, String> {
    Ok(Value::Bool(
        Settings::global().get_import_recommended_schedule_enabled(),
    ))
}

pub fn get_max_concurrent_downloads() -> Result<Value, String> {
    Ok(serde_json::json!(
        Settings::global().get_max_concurrent_downloads()
    ))
}

pub fn get_max_concurrent_tasks() -> Result<Value, String> {
    Ok(serde_json::json!(
        Settings::global().get_max_concurrent_tasks()
    ))
}

pub fn get_download_interval_ms() -> Result<Value, String> {
    Ok(serde_json::json!(
        Settings::global().get_download_interval_ms()
    ))
}

pub fn get_network_retry_count() -> Result<Value, String> {
    Ok(serde_json::json!(
        Settings::global().get_network_retry_count()
    ))
}

pub fn get_auto_deduplicate() -> Result<Value, String> {
    Ok(Value::Bool(Settings::global().get_auto_deduplicate()))
}

pub fn set_max_concurrent_downloads(count: u32) -> Result<Value, String> {
    Settings::global().set_max_concurrent_downloads(count)?;
    Ok(Value::Null)
}

pub async fn set_max_concurrent_tasks(count: u32) -> Result<Value, String> {
    Settings::global().set_max_concurrent_tasks(count)?;
    Ok(Value::Null)
}

pub async fn set_download_interval_ms(interval_ms: u32) -> Result<Value, String> {
    Settings::global().set_download_interval_ms(interval_ms)?;
    Ok(Value::Null)
}

pub async fn set_network_retry_count(count: u32) -> Result<Value, String> {
    Settings::global().set_network_retry_count(count)?;
    Ok(Value::Null)
}

pub async fn set_auto_deduplicate(enabled: bool) -> Result<Value, String> {
    Settings::global().set_auto_deduplicate(enabled)?;
    Ok(Value::Null)
}

pub async fn set_import_recommended_schedule_enabled(enabled: bool) -> Result<Value, String> {
    Settings::global().set_import_recommended_schedule_enabled(enabled)?;
    Ok(Value::Null)
}
