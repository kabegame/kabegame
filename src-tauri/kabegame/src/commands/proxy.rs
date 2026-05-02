//! Tauri 命令薄包装：代理 GET 请求，具体实现在 `commands_core::proxy`，与 Web 模式 RPC 共享。

use std::collections::HashMap;

#[tauri::command]
pub async fn proxy_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    crate::commands_core::proxy::proxy_fetch(url, headers).await
}
