//! Run Configs 陦ｨ逶ｸ蜈ｳ謫堺ｽ・
use kabegame_core::ipc::ipc::IpcResponse;
use kabegame_core::storage::Storage;

pub async fn get_run_configs() -> IpcResponse {
    let storage = Storage::global();
    match storage.get_run_configs() {
        Ok(configs) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(configs).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn add_run_config(config: &serde_json::Value) -> IpcResponse {
    match kabegame_core::commands::task::add_run_config(config.clone(), None, None).await {
        Ok(result) => IpcResponse::ok_with_data("added", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn update_run_config(config: &serde_json::Value) -> IpcResponse {
    match kabegame_core::commands::task::update_run_config(config.clone(), None, None).await {
        Ok(result) => IpcResponse::ok_with_data("updated", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn delete_run_config(config_id: &str) -> IpcResponse {
    match kabegame_core::commands::task::delete_run_config(config_id.to_string(), None, None).await
    {
        Ok(_) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}
