//! builtin `webpage`（网页收集）任务：配置二次校验、按后端分流。
//!
//! 两个后端都只是把编排 JS 放进**已有**运行时：
//! - `v8`：V8 运行时执行 `plugin::webpage::v8_collect_module()`（`Kabegame.to` 静态取页 +
//!   DOMParser + 同一份 `discoverMedia`），任务 Header（含可选注入的畅游 Cookie / CEF UA）
//!   作用于取页与媒体下载；
//! - `webview`：复用爬虫窗口会话（隐藏 CEF 窗口、bootstrap 的 Kabegame API、心跳看门狗），
//!   注入脚本由 app crate 的 `CrawlerWebViewHandler` 按 [`is_webview_task`] 选择；下载走 CEF 原生
//!   通道（[`crate::crawler::task_scheduler::TaskParams::uses_webview_transport`]）以保留登录态。

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use url::Url;

use crate::crawler::downloader::DownloadQueue;
use crate::crawler::task_scheduler::{Task, TaskError, TaskResult};
use crate::media::image_type::{supported_image_extensions, supported_video_extensions};
use crate::plugin::webpage::WEBPAGE_PLUGIN_ID;
use crate::settings::Settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebpageBackend {
    V8,
    Webview,
}

/// 网页任务的冻结参数（来自任务 userConfig，已按 var_defs 补默认值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebpageConfig {
    /// 用户提交的初始 URL（已去首尾空白）；`post_url` 与快照 `sourceUrl` 的唯一来源。
    pub url: String,
    pub backend: WebpageBackend,
    pub inject_surf_cookie: bool,
    pub inject_cef_user_agent: bool,
}

/// 入口 URL：去首尾空白后必须是绝对 http(s)，且不带用户名 / 密码。
pub fn validate_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("网页 URL 不能为空".to_string());
    }
    let url = Url::parse(trimmed).map_err(|e| format!("网页 URL 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("网页 URL 只支持 http / https".to_string());
    }
    if url.host_str().map_or(true, str::is_empty) {
        return Err("网页 URL 缺少主机名".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("网页 URL 不能包含用户名或密码".to_string());
    }
    Ok(url)
}

fn parse_backend(value: Option<&Value>) -> Result<WebpageBackend, String> {
    match value.and_then(Value::as_str).unwrap_or("v8") {
        "v8" => Ok(WebpageBackend::V8),
        "webview" => {
            if cfg!(target_os = "android") {
                Err("Android 不支持网页收集的 WebView 后端".to_string())
            } else {
                Ok(WebpageBackend::Webview)
            }
        }
        other => Err(format!("未知的网页收集后端：{other}")),
    }
}

impl WebpageConfig {
    pub fn from_config(config: &HashMap<String, Value>) -> Result<Self, String> {
        let raw_url = config
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        validate_url(raw_url)?;
        let flag = |key: &str| config.get(key).and_then(Value::as_bool).unwrap_or(true);
        Ok(Self {
            url: raw_url.trim().to_string(),
            backend: parse_backend(config.get("backend"))?,
            inject_surf_cookie: flag("injectSurfCookie"),
            inject_cef_user_agent: flag("injectCefUserAgent"),
        })
    }
}

/// 由 HTTP 客户端维护、不允许用户覆盖的头（小写）。
const RESERVED_HEADERS: &[&str] = &["host", "content-length", "connection", "transfer-encoding"];

/// 任务 Header：WebView 后端必须为空（身份只来自浏览器会话）；V8 后端校验名与值。
pub fn validate_http_headers(
    backend: WebpageBackend,
    headers: &HashMap<String, String>,
) -> Result<(), String> {
    if backend == WebpageBackend::Webview {
        if headers.is_empty() {
            return Ok(());
        }
        return Err("WebView 后端不接受自定义 HTTP 头".to_string());
    }
    for (name, value) in headers {
        let name = name.trim();
        if name.is_empty() {
            return Err("HTTP 头名称不能为空".to_string());
        }
        if name.contains([':', '\r', '\n']) {
            return Err(format!("HTTP 头名称不合法：{name}"));
        }
        if RESERVED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!("不允许自定义 HTTP 头：{name}"));
        }
        if reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err() {
            return Err(format!("HTTP 头名称不合法：{name}"));
        }
        // 只报名称：值按凭据处理，不进错误正文
        if value.contains(['\r', '\n']) || reqwest::header::HeaderValue::from_str(value).is_err() {
            return Err(format!("HTTP 头 {name} 的值不合法"));
        }
    }
    Ok(())
}

/// 任务提交入口的校验（建任务前），非法直接拒绝，不创建任务记录。
pub fn validate_submission(
    user_config: Option<&HashMap<String, Value>>,
    http_headers: Option<&HashMap<String, String>>,
) -> Result<(), String> {
    let empty = HashMap::new();
    let cfg = WebpageConfig::from_config(user_config.unwrap_or(&empty))?;
    validate_http_headers(cfg.backend, http_headers.unwrap_or(&HashMap::new()))
}

/// 该任务是否为 `webpage + webview`（决定爬虫窗口注入脚本与下载 transport）。
pub fn is_webview_task(plugin_id: &str, config: &HashMap<String, Value>) -> bool {
    plugin_id == WEBPAGE_PLUGIN_ID
        && config.get("backend").and_then(Value::as_str) == Some("webview")
}

/// 两个后端共用的宿主参数：冻结开关、受支持扩展名（来自 `MEDIA_FORMATS`）、用户显式 Header 名。
pub fn collect_params(run: &Task) -> Value {
    let user_header_names: Vec<String> = run.headers_snapshot().into_keys().collect();
    json!({
        "freeze": Settings::global().get_surf_freeze_page(),
        "imageExtensions": supported_image_extensions(),
        "videoExtensions": supported_video_extensions(),
        "userHeaderNames": user_header_names,
    })
}

/// 调度入口：二次校验后按后端分流；两条路径都经下载排空收尾。
pub async fn run_builtin_webpage(download_queue: Arc<DownloadQueue>, run: Arc<Task>) -> TaskResult {
    let cfg = WebpageConfig::from_config(&run.params.config).map_err(TaskError::Other)?;
    validate_http_headers(cfg.backend, &run.headers_snapshot()).map_err(TaskError::Other)?;

    match cfg.backend {
        WebpageBackend::V8 => run_v8(download_queue, run).await,
        WebpageBackend::Webview => {
            #[cfg(not(target_os = "android"))]
            {
                crate::crawler::task_scheduler::run_webview_session(&download_queue, &run, cfg.url)
                    .await
            }
            #[cfg(target_os = "android")]
            {
                let _ = download_queue;
                Err(TaskError::Other(
                    "Android 不支持网页收集的 WebView 后端".to_string(),
                ))
            }
        }
    }
}

#[cfg(feature = "plugin-runtime")]
async fn run_v8(download_queue: Arc<DownloadQueue>, run: Arc<Task>) -> TaskResult {
    let common = collect_params(&run);
    let custom = Value::Object(run.params.config.clone().into_iter().collect());
    crate::crawler::task_scheduler::run_v8_and_drain(&download_queue, &run, move |run| {
        crate::plugin::v8::execute_v8_entry(
            run,
            WEBPAGE_PLUGIN_ID,
            crate::plugin::webpage::v8_collect_module(),
            common,
            custom,
        )
    })
    .await
}

#[cfg(not(feature = "plugin-runtime"))]
async fn run_v8(_download_queue: Arc<DownloadQueue>, _run: Arc<Task>) -> TaskResult {
    Err(TaskError::Other(
        "当前构建未包含 V8 运行时，无法执行网页收集".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn url_rules() {
        assert_eq!(
            validate_url("  https://example.com/a?b=1#c ")
                .unwrap()
                .as_str(),
            "https://example.com/a?b=1#c"
        );
        assert!(validate_url("").is_err());
        assert!(validate_url("example.com/a").is_err());
        assert!(validate_url("ftp://example.com/a").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("https://user:pw@example.com/").is_err());
        assert!(validate_url("https://user@example.com/").is_err());
    }

    #[test]
    fn config_defaults_and_trim() {
        let c = WebpageConfig::from_config(&cfg(&[("url", json!(" https://a.com/p "))])).unwrap();
        assert_eq!(c.url, "https://a.com/p");
        assert_eq!(c.backend, WebpageBackend::V8);
        assert!(c.inject_surf_cookie);
        assert!(c.inject_cef_user_agent);

        let c = WebpageConfig::from_config(&cfg(&[
            ("url", json!("https://a.com/")),
            ("backend", json!("v8")),
            ("injectSurfCookie", json!(false)),
            ("injectCefUserAgent", json!(false)),
        ]))
        .unwrap();
        assert!(!c.inject_surf_cookie);
        assert!(!c.inject_cef_user_agent);

        assert!(WebpageConfig::from_config(&cfg(&[
            ("url", json!("https://a.com/")),
            ("backend", json!("host")),
        ]))
        .is_err());
        assert!(WebpageConfig::from_config(&cfg(&[])).is_err());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn webview_backend_on_desktop() {
        let c = WebpageConfig::from_config(&cfg(&[
            ("url", json!("https://a.com/")),
            ("backend", json!("webview")),
        ]))
        .unwrap();
        assert_eq!(c.backend, WebpageBackend::Webview);
        assert!(is_webview_task(
            WEBPAGE_PLUGIN_ID,
            &cfg(&[("backend", json!("webview"))])
        ));
        assert!(!is_webview_task(
            WEBPAGE_PLUGIN_ID,
            &cfg(&[("backend", json!("v8"))])
        ));
        assert!(!is_webview_task(
            "other",
            &cfg(&[("backend", json!("webview"))])
        ));
    }

    #[test]
    fn header_rules() {
        let h = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let v8 = WebpageBackend::V8;
        assert!(validate_http_headers(
            v8,
            &h(&[("Referer", "https://a.com/"), ("X-Token", "abc")])
        )
        .is_ok());
        assert!(validate_http_headers(v8, &h(&[(" ", "x")])).is_err());
        assert!(validate_http_headers(v8, &h(&[("A:B", "x")])).is_err());
        assert!(validate_http_headers(v8, &h(&[("X-A\r\nB", "x")])).is_err());
        assert!(validate_http_headers(v8, &h(&[("X-A", "a\r\nInjected: 1")])).is_err());
        for reserved in ["Host", "content-length", "Connection", "Transfer-Encoding"] {
            assert!(validate_http_headers(v8, &h(&[(reserved, "x")])).is_err());
        }
        let err = validate_http_headers(v8, &h(&[("X-A", "secret\n")])).unwrap_err();
        assert!(!err.contains("secret"));

        assert!(validate_http_headers(WebpageBackend::Webview, &h(&[])).is_ok());
        assert!(validate_http_headers(WebpageBackend::Webview, &h(&[("Referer", "x")])).is_err());
    }
}
