//! 供详情 iframe 内插件模板代理调用的 HTTP 接口（绕过浏览器 CORS）
//!
//! 响应体以 Base64 编码返回；JSON 解析在前端注入脚本侧通过 `options.json` 完成。
//! 同时被 Tauri 命令与 Web 模式 JSON-RPC 共享。

use base64::Engine;
use std::collections::HashMap;

const PROXY_FETCH_BYTES_MAX: usize = 3 * 1024 * 1024;

pub async fn proxy_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let mut client_builder =
        reqwest::Client::builder().redirect(reqwest::redirect::Policy::default());
    if let Some(ref proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            client_builder = client_builder.proxy(proxy);
        }
    }
    let client = client_builder.build().map_err(|e| e.to_string())?;

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
