//! Tauri 命令薄包装：代理 GET 请求，具体实现在 `commands::proxy`，与 Web 模式 RPC 共享。

use std::collections::HashMap;

#[tauri::command]
pub async fn proxy_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    kabegame_core::commands::proxy::proxy_fetch(url, headers).await
}
