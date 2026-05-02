//! Run Configs 陦ｨ逶ｸ蜈ｳ謫堺ｽ・
use kabegame_core::ipc::ipc::IpcResponse;
use kabegame_core::scheduler::Scheduler;
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
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::RunConfig>(config.clone()) {
        Ok(config) => match storage.add_run_config(config.clone()) {
            Ok(()) => {
                let _ = Scheduler::global().reload_config(&config.id).await;
                IpcResponse::ok_with_data("added", serde_json::to_value(config).unwrap_or_default())
            }
            Err(e) => IpcResponse::err(e),
        },
        Err(e) => IpcResponse::err(format!("Invalid config data: {}", e)),
    }
}

pub async fn update_run_config(config: &serde_json::Value) -> IpcResponse {
    let storage = Storage::global();
    match serde_json::from_value::<kabegame_core::storage::RunConfig>(config.clone()) {
        Ok(config) => match storage.update_run_config(config.clone()) {
            Ok(()) => {
                let _ = Scheduler::global().reload_config(&config.id).await;
                IpcResponse::ok("updated")
            }
            Err(e) => IpcResponse::err(e),
        },
        Err(e) => IpcResponse::err(format!("Invalid config data: {}", e)),
    }
}

pub async fn delete_run_config(config_id: &str) -> IpcResponse {
    let storage = Storage::global();
    let _ = Scheduler::global().remove_config(config_id).await;
    match storage.delete_run_config(config_id) {
        Ok(()) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}
