//! 供详情 iframe 内插件模板通过 postMessage 代理调用的 HTTP 接口（绕过浏览器 CORS）
//!
//! 响应体以 Base64 经 IPC 传回；JSON 解析在注入脚本侧通过 `options.json` 完成。

use base64::Engine;
use std::collections::HashMap;

const PROXY_FETCH_BYTES_MAX: usize = 3 * 1024 * 1024;

#[tauri::command]
pub async fn proxy_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(&k, &v);
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > PROXY_FETCH_BYTES_MAX {
        return Err(format!(
            "response too large: {} bytes (max {})",
            bytes.len(),
            PROXY_FETCH_BYTES_MAX
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({
        "base64": b64,
        "contentType": ct,
    }))
}
