//! 隐藏图片清理命令的共享实现层。

use crate::storage::hidden_cleanup::HiddenCleanupService;
use crate::storage::Storage;
use serde_json::Value;
use std::sync::Arc;

pub async fn start_hidden_cleanup() -> Result<Value, String> {
    HiddenCleanupService::global()
        .start(Arc::new(Storage::global().clone()))
        .await?;
    Ok(Value::Null)
}

pub fn get_hidden_cleanup_run_state() -> Result<Value, String> {
    serde_json::to_value(HiddenCleanupService::global().get_run_state()).map_err(|e| e.to_string())
}

pub fn cancel_hidden_cleanup() -> Result<Value, String> {
    serde_json::to_value(HiddenCleanupService::global().cancel()?).map_err(|e| e.to_string())
}
