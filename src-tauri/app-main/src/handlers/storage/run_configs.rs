//! Run Configs 表相关操作

use kabegame_core::ipc::ipc::CliIpcResponse;
use kabegame_core::storage::Storage;

pub async fn get_run_configs() -> CliIpcResponse {
    let storage = Storage::global();
    match storage.get_run_configs() {
        Ok(configs) => CliIpcResponse::ok_with_data(
            "ok",
            serde_json::to_value(configs).unwrap_or_default(),
        ),
        Err(e) => CliIpcResponse::err(e),
    }
}

pub async fn add_run_config(config: &serde_json::Value) -> CliIpcResponse {
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::RunConfig>(config.clone()) {
        Ok(config) => match storage.add_run_config(config.clone()) {
            Ok(()) => CliIpcResponse::ok_with_data(
                "added",
                serde_json::to_value(config).unwrap_or_default(),
            ),
            Err(e) => CliIpcResponse::err(e),
        },
        Err(e) => CliIpcResponse::err(format!("Invalid config data: {}", e)),
    }
}

pub async fn update_run_config(
    config: &serde_json::Value,
) -> CliIpcResponse {
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::RunConfig>(config.clone()) {
        Ok(config) => match storage.update_run_config(config) {
            Ok(()) => CliIpcResponse::ok("updated"),
            Err(e) => CliIpcResponse::err(e),
        },
        Err(e) => CliIpcResponse::err(format!("Invalid config data: {}", e)),
    }
}

pub async fn delete_run_config(config_id: &str) -> CliIpcResponse {
    let storage = Storage::global();
    match storage.delete_run_config(config_id) {
        Ok(()) => CliIpcResponse::ok("deleted"),
        Err(e) => CliIpcResponse::err(e),
    }
}
