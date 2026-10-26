//! 畅游接收侧：脚本下载入队、页面下载入队与元数据归属（全平台）。
//!
//! 桌面端由 CEF 原生下载执行，浏览器自带 Cookie；安卓没有 CEF 下载通道，因此两类下载都在入队前
//! 补齐 `Cookie` / `User-Agent` / `Referer`，再由 reqwest 下载并直接入图库。
use kabegame_core::crawler::TaskScheduler;
use kabegame_core::storage::page_snapshot::SURF_METADATA_VERSION;
use kabegame_core::storage::Storage;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Runtime, Webview};
use url::Url;

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// `plugin_version` 为写入时运行插件的 packed 版本（应用维护，插件不可传入）。
pub(crate) fn insert_metadata(
    plugin_id: &str,
    metadata: Option<Value>,
    plugin_version: u32,
) -> Result<Option<i64>, String> {
    if let Some(value) = metadata {
        Ok(Some(Storage::global().insert_metadata_row(
            &value,
            plugin_id,
            plugin_version,
            None,
            None,
        )?))
    } else {
        Ok(None)
    }
}

pub(crate) fn surf_download_name_from_url(url: &Url) -> Option<String> {
    if matches!(url.scheme(), "blob" | "data") {
        return None;
    }
    url.path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.trim().is_empty()).last())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(ToOwned::to_owned)
}

#[derive(Debug)]
pub(crate) struct SurfReceiveCtx {
    pub(crate) images_dir: PathBuf,
    pub(crate) host: String,
    pub(crate) surf_record_id: String,
}

pub(crate) fn surf_ctx_from_label(label: &str) -> Result<SurfReceiveCtx, String> {
    let host = super::surf_common::host_from_surf_label(label)
        .ok_or_else(|| format!("Invalid surf window label: {label}"))?;
    let record = Storage::global()
        .get_surf_record_by_host(&host)?
        .ok_or_else(|| format!("Surf record not found for host: {host}"))?;
    Ok(SurfReceiveCtx {
        images_dir: kabegame_core::crawler::downloader::get_default_images_dir(),
        host,
        surf_record_id: record.id,
    })
}

/// 一次畅游下载请求。脚本下载（`surf_download_image`）与页面自发下载（安卓 `pageDownload`）
/// 都组装它，再交给 [`enqueue_surf_download`]，共用同一套补头与入队逻辑。
#[derive(Debug)]
pub(crate) struct SurfDownloadRequest {
    pub(crate) url: Url,
    pub(crate) name: Option<String>,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) metadata: Option<Value>,
    pub(crate) metadata_id: Option<i64>,
    pub(crate) collect_run_id: Option<u64>,
    pub(crate) source_url: Option<String>,
}

/// 安卓补头：`Cookie` 取媒体 URL 在 CookieManager 里的值（含 HttpOnly），`User-Agent` 按当前
/// 畅游会话的桌面 / 移动模式取 UA（与 Cookie 签发 UA 一致；爬虫会话恒为系统默认 UA），
/// `Referer` 用内容页当前地址。
///
/// Cookie 经 SurfPlugin 读取（见 `surf_android::cookie_header_for_url`），不用 wry 的
/// `cookies_for_url`：没有 Cookie 的 URL 会让 wry 生成的 Kotlin 抛 NPE。
///
/// 畅游（`enqueue_surf_download`）与爬虫（`crawl_download_image`、页面自发下载）共用这一份口径。
#[cfg(target_os = "android")]
pub(crate) async fn android_identity_headers<R: Runtime>(
    webview: &Webview<R>,
    url: &Url,
) -> HashMap<String, String> {
    use tauri::Manager;

    let mut headers = HashMap::new();
    if let Some(cookie) =
        super::surf_android::cookie_header_for_url(webview.app_handle(), url).await
    {
        headers.insert("Cookie".to_string(), cookie);
    }
    // 下载补头必须与页面当前 UA 一致（Cookie 与签发 UA 配对）：畅游看会话模式，爬虫宿主看
    // 建窗时选定的 UA。派生失败时回落到系统默认 UA，不能没有 UA。
    let label = webview.label();
    let user_agent = if super::surf_android::is_desktop_session(label) {
        kabegame_core::plugin::v8::android_desktop_user_agent()
            .or_else(kabegame_core::plugin::v8::android_webview_user_agent)
    } else if let Some(user_agent) = super::crawler_android::desktop_user_agent_for_label(label) {
        Some(user_agent)
    } else {
        kabegame_core::plugin::v8::android_webview_user_agent()
    };
    if let Some(user_agent) = user_agent {
        headers.insert("User-Agent".to_string(), user_agent);
    }
    if let Ok(current) = webview.url() {
        headers.insert("Referer".to_string(), current.to_string());
    }
    headers
}

/// 畅游下载唯一入队函数：scheme 校验、运行态校验、metadata 归属、补头、入队。
pub(crate) async fn enqueue_surf_download<R: Runtime>(
    webview: &Webview<R>,
    req: SurfDownloadRequest,
) -> Result<(), String> {
    let ctx = surf_ctx_from_label(webview.label())?;
    if !matches!(req.url.scheme(), "http" | "https") {
        return Err("Surf download only supports http or https URLs".to_string());
    }
    if let Some(run_id) = req.collect_run_id {
        if !super::surf_collect::is_run_active(webview.label(), run_id) {
            return Err(kabegame_i18n::t!("surf.collect.canceled"));
        }
    }

    let custom_name = req.name.or_else(|| surf_download_name_from_url(&req.url));
    let metadata_id = match req.metadata_id {
        Some(id) => {
            let owner = Storage::global().metadata_plugin_id(id)?;
            if owner.as_deref() != Some(ctx.host.as_str()) {
                return Err(format!("Metadata {id} does not belong to this surf site"));
            }
            Some(id)
        }
        None => insert_metadata(&ctx.host, req.metadata, SURF_METADATA_VERSION)?,
    };

    // 平台补的头覆盖页面给的：安卓上 Cookie / UA / Referer 只能从 WebView 侧取到真值。
    #[cfg(target_os = "android")]
    let http_headers = {
        let mut headers = req.headers;
        headers.extend(android_identity_headers(webview, &req.url).await);
        headers
    };
    #[cfg(not(target_os = "android"))]
    let http_headers = req.headers;

    let dq = TaskScheduler::global().download_queue();
    dq.download(
        req.url,
        ctx.images_dir,
        ctx.host,
        String::new(),
        now_ms(),
        None,
        Some(ctx.surf_record_id),
        http_headers,
        None,
        custom_name,
        metadata_id,
        req.collect_run_id.is_some(),
        req.source_url,
        Vec::new(),
    )
    .await
}

/// 畅游右键下载 / 一键下载统一入队。
///
/// 一键下载额外传 `collect_run_id`：run 已取消则直接拒绝，并以 blocking 方式入队（等下载池
/// 有空位），使取消能拦下尚未入队的候选；`metadata_id` 为同批共享的页面快照行，必须属于本站点。
#[tauri::command]
pub async fn surf_download_image<R: Runtime>(
    webview: Webview<R>,
    url: String,
    name: Option<String>,
    headers: Option<HashMap<String, String>>,
    metadata: Option<Value>,
    metadata_id: Option<i64>,
    collect_run_id: Option<u64>,
    source_url: Option<String>,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    enqueue_surf_download(
        &webview,
        SurfDownloadRequest {
            url: parsed,
            name,
            headers: headers.unwrap_or_default(),
            metadata,
            metadata_id,
            collect_run_id,
            source_url,
        },
    )
    .await
}
