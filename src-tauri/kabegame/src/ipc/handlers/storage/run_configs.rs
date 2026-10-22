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
    match kabegame_core::commands::task::add_run_config(config.clone(), None).await {
        Ok(result) => run_config_response("added", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn update_run_config(config: &serde_json::Value) -> IpcResponse {
    match kabegame_core::commands::task::update_run_config(config.clone(), None).await {
        Ok(result) => run_config_response("updated", result),
        Err(e) => IpcResponse::err(e),
    }
}

pub async fn delete_run_config(config_id: &str) -> IpcResponse {
    match kabegame_core::commands::task::delete_run_config(config_id.to_string(), None).await {
        Ok(_) => IpcResponse::ok("deleted"),
        Err(e) => IpcResponse::err(e),
    }
}

/// app IPC 保持旧单行载荷，共享写结果的外层对象不跨此 IPC 边界。
fn run_config_response(message: &str, mut result: serde_json::Value) -> IpcResponse {
    IpcResponse::ok_with_data(message, result["config"].take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ipc_run_config_response_keeps_legacy_single_row_or_null() {
        for config in [json!({"id": "a", "pluginId": "p"}), serde_json::Value::Null] {
            let response = run_config_response(
                "added",
                json!({
                    "config": config, "configId": "a", "seq": 7, "view": null
                }),
            );
            assert!(response.ok);
            assert_eq!(response.data, config);
        }
        // 删除继续使用旧的不带 data 响应。
        assert_eq!(IpcResponse::ok("deleted").data, serde_json::Value::Null);
    }
}
