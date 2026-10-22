//! 运行配置的 app IPC 入口。
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
    match kabegame_core::commands::task::add_run_config(config.clone()).await {
        Ok(result) => IpcResponse::ok_with_data("added", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn update_run_config(config: &serde_json::Value) -> IpcResponse {
    match kabegame_core::commands::task::update_run_config(config.clone()).await {
        Ok(result) => IpcResponse::ok_with_data("updated", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn delete_run_config(config_id: &str) -> IpcResponse {
    match kabegame_core::commands::task::delete_run_config(config_id.to_string()).await {
        Ok(_) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ipc_run_config_write_keeps_single_row_or_null() {
        for config in [json!({"id": "a", "pluginId": "p"}), serde_json::Value::Null] {
            let response = IpcResponse::ok_with_data("added", config.clone());
            assert!(response.ok);
            assert_eq!(response.data, config);
        }
        // 删除继续使用旧的不带 data 响应。
        assert_eq!(IpcResponse::ok("deleted").data, serde_json::Value::Null);
    }
}
