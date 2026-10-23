use kabegame_core::storage::{RangedSurfRecords, SurfRecord};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfSessionStatus {
    pub active: bool,
    /// 当前畅游站点 host（对外索引键，与路由 `/surf/:host/images` 一致）
    pub surf_host: Option<String>,
}

pub(crate) fn parse_external_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("无效 URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持 http 或 https URL".to_string());
    }
    Ok(parsed)
}

/// 新建畅游记录时写入的「根 URL」：与用户输入一致（保留 path、query），仅去掉 fragment。
pub(crate) fn resolve_root_url(parsed: &url::Url) -> String {
    let mut root = parsed.clone();
    root.set_fragment(None);
    root.to_string()
}

pub(crate) fn surf_label(host: &str) -> String {
    // Tauri window labels only allow [a-zA-Z0-9-/:_]; replace '.' with '_'
    format!("surf-{}", host.trim().to_lowercase().replace('.', "_"))
}

/// 桌面导航栏 webview 的 label；安卓没有导航栏，不参与目标编译。
#[cfg(not(target_os = "android"))]
pub(crate) fn surf_navbar_label(host: &str) -> String {
    format!("{}-navbar", surf_label(host))
}

/// 内容 webview label → host。桌面为 `surf-<host>`，安卓为 `surf-<host>:<会话序号>`。
///
/// Tauri 的 label 只允许 `[a-zA-Z0-9-/:_]`，host 里的 `.` 已换成 `_`，这里换回来。
pub(crate) fn host_from_surf_label(label: &str) -> Option<String> {
    let rest = label.strip_prefix("surf-")?;
    if rest.is_empty() || rest.ends_with("-navbar") {
        return None;
    }
    let host_part = rest.split_once(':').map_or(rest, |(host, _)| host);
    (!host_part.is_empty()).then(|| host_part.replace('_', "."))
}

pub(crate) fn is_surf_content_label(label: &str) -> bool {
    host_from_surf_label(label).is_some()
}

/// 畅游内容页要注入的全部脚本，桌面与安卓共用同一份。
///
/// - 桌面：直接按顺序 `.initialization_script(...)`，与拆分前完全一致。
/// - 安卓：wry 用 `addDocumentStartJavaScript(…, setOf("*"))`，脚本会进所有 iframe；每段再包一层
///   顶层守卫，让行为与桌面「只进主框架」一致。安卓没有导航栏 webview，`surf_url_report.js`
///   不注入（地址由原生工具栏直接读）。
/// - 一键下载的发现 / 快照 / 编排拼进同一个封闭 IIFE，不挂 window 全局；发现脚本是 builtin
///   `webpage` 插件的载荷（core 唯一一份），故运行时拼接。
pub(crate) fn surf_initialization_scripts() -> Vec<String> {
    let mut scripts = vec![
        include_str!("../webview_js/webview_i18n.js").to_string(),
        include_str!("../webview_js/media_capture.js").to_string(),
        include_str!("../webview_js/media_download.js").to_string(),
        concat!(
            "(function () {\n\"use strict\";\n",
            include_str!("../webview_js/surf_download_name.js"),
            include_str!("../webview_js/surf_bootstrap.js"),
            "\n})();\n"
        )
        .to_string(),
        [
            "(function () {\n\"use strict\";\n",
            include_str!("../webview_js/surf_download_name.js"),
            kabegame_core::plugin::webpage::PAGE_DISCOVER_JS,
            include_str!("../webview_js/page_snapshot.js"),
            include_str!("../webview_js/surf_collect.js"),
            "\n})();\n",
        ]
        .concat(),
        include_str!("../webview_js/surf_toast.js").to_string(),
        include_str!("../webview_js/surf_context_menu.js").to_string(),
    ];
    #[cfg(not(target_os = "android"))]
    scripts.push(include_str!("../webview_js/surf_url_report.js").to_string());
    #[cfg(target_os = "android")]
    {
        scripts = scripts
            .into_iter()
            .enumerate()
            .map(|(index, script)| android_init_script(script, &format!("surf-{index}")))
            .collect();
    }
    scripts
}

/// 安卓初始化脚本的两道守卫，畅游与爬虫宿主 Activity 共用。
///
/// 1. 只在顶层文档运行：wry 安卓用 `addDocumentStartJavaScript(…, setOf("*"))` 注入到每个 frame，
///    桌面 Tauri 只注入主框架。
/// 2. 每个文档只运行一次：wry 生成的 `RustWebViewClient.onPageStarted` 对没经它拦截的请求（外部网页
///    都是）会再 `evaluateJavascript` 一遍全部初始化脚本，且不看 document-start 注入是否已生效。
///    没有这道守卫，爬虫 bootstrap 会在同一页里把插件并行跑两份。标记是 window 上不可枚举、不可改的
///    属性，`key` 在同一 webview 的脚本之间必须唯一。
#[cfg(target_os = "android")]
pub(crate) fn android_init_script(script: String, key: &str) -> String {
    let marker = serde_json::to_string(&format!("__kb_init_{key}__")).unwrap_or_default();
    format!(
        "(function () {{\nif (window.top !== window) return;\n\
         if (Object.prototype.hasOwnProperty.call(window, {marker})) return;\n\
         Object.defineProperty(window, {marker}, {{ value: true }});\n\
         {script}\n}})();\n"
    )
}

/// 内容 webview 的 label：桌面按 host 推导，安卓取当前会话（label 带会话序号）。
fn content_label_for_host(host: &str) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        crate::commands::surf_android::session_label_for_host(host)
    }
    #[cfg(not(target_os = "android"))]
    {
        Some(surf_label(host))
    }
}

/// 在畅游内容页里弹一条页内 toast（桌面与安卓同一套注入脚本）。
pub(crate) fn surf_toast_for_host<R: Runtime>(
    app: &AppHandle<R>,
    host: &str,
    message: &str,
    kind: &str,
) {
    let Some(label) = content_label_for_host(host) else {
        return;
    };
    let Some(webview) = app.get_webview(&label) else {
        return;
    };
    let message_json = serde_json::to_string(message).unwrap_or_else(|_| "\"下载失败\"".to_string());
    let kind_json = serde_json::to_string(kind).unwrap_or_else(|_| "\"failed\"".to_string());
    let script = format!("window.__kabegame_toast?.({}, {});", message_json, kind_json);
    let _ = webview.eval(script.as_str());
}

/// 页面自发下载是否明确是压缩包（看文件名扩展名或 MIME）。
///
/// 安卓畅游只在这种情况下提前拒绝：解压交给各爬虫插件。其余认不出类型的（如
/// `application/octet-stream` 且 URL 无扩展名、`guessFileName` 给出 `xxx.bin`）照样入队，
/// 由下载后处理按字节判定，真媒体能入库，非媒体在那里报「格式不受支持」。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn is_archive_download(name: Option<&str>, mime_type: Option<&str>) -> bool {
    const EXTENSIONS: &[&str] = &[
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "cbz", "cbr",
    ];
    const MIMES: &[&str] = &[
        "application/zip",
        "application/x-zip-compressed",
        "application/vnd.rar",
        "application/x-rar-compressed",
        "application/x-7z-compressed",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip",
        "application/x-bzip2",
        "application/x-xz",
        "application/zstd",
        "application/vnd.comicbook+zip",
        "application/vnd.comicbook-rar",
    ];
    let by_name = name
        .and_then(|name| std::path::Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)));
    let by_mime = mime_type
        .and_then(|mime| mime.split(';').next())
        .map(str::trim)
        .is_some_and(|mime| MIMES.iter().any(|known| known.eq_ignore_ascii_case(mime)));
    by_name || by_mime
}

/// 页面自发下载是否明确是安卓应用安装包（apk / apks / xapk / aab）。
///
/// 安装包既不是媒体也不在压缩包名单：安卓畅游提前拒绝并提示切到桌面版网站，
/// 避免入队、下载完才在后处理报「格式不受支持」。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn is_app_package_download(name: Option<&str>, mime_type: Option<&str>) -> bool {
    const EXTENSIONS: &[&str] = &["apk", "apks", "xapk", "aab"];
    const MIMES: &[&str] = &["application/vnd.android.package-archive"];
    let by_name = name
        .and_then(|name| std::path::Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)));
    let by_mime = mime_type
        .and_then(|mime| mime.split(';').next())
        .map(str::trim)
        .is_some_and(|mime| MIMES.iter().any(|known| known.eq_ignore_ascii_case(mime)));
    by_name || by_mime
}

/// 桌面导航栏 URL 的 query 编码；安卓没有 navbar，不参与目标编译。
#[cfg(not(target_os = "android"))]
pub(crate) fn encode_query_value(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(crate) fn normalize_surf_host(host: &str) -> String {
    host.trim().to_lowercase()
}

/// 与 `host` 对应的畅游记录 host 候选：先精确匹配，再试 `www.` 前缀的有无
/// （畅游打开 `xiaohongshu.com` 与插件 `kbBaseUrl` 写 `www.xiaohongshu.com` 应视为同一站点）。
#[cfg(any(target_os = "android", test))]
pub(crate) fn surf_host_candidates(host: &str) -> Vec<String> {
    let host = normalize_surf_host(host);
    let alternate = match host.strip_prefix("www.") {
        Some(bare) => bare.to_string(),
        None => format!("www.{host}"),
    };
    vec![host, alternate]
}

/// 安卓上其它 WebView（爬虫宿主）打开 `url` 时应使用的 UA：该站畅游记录为桌面版网站时返回
/// 桌面 UA，否则 `None`（保持系统默认 UA）。共用 `CookieManager`，Cookie 与签发 UA 必须配对。
#[cfg(target_os = "android")]
pub(crate) fn android_desktop_user_agent_for_url(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    let desktop = surf_host_candidates(host).iter().any(|candidate| {
        kabegame_core::storage::Storage::global()
            .get_surf_record_by_host(candidate)
            .ok()
            .flatten()
            .is_some_and(|record| record.desktop_mode)
    });
    if desktop {
        kabegame_core::plugin::v8::android_desktop_user_agent()
    } else {
        None
    }
}

#[tauri::command]
pub async fn surf_open_in_browser<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let parsed = parse_external_url(url.trim())?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("打开浏览器失败: {e}"))
}

#[tauri::command]
pub async fn surf_list_records(offset: usize, limit: usize) -> Result<RangedSurfRecords, String> {
    kabegame_core::commands::surf::surf_list_records(offset, limit)
}

#[tauri::command]
pub async fn surf_get_all_records() -> Result<Vec<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_all_records()
}

#[tauri::command]
pub async fn surf_get_records_by_ids(ids: Vec<String>) -> Result<Vec<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_records_by_ids(ids)
}

#[tauri::command]
pub async fn surf_get_record(host: String) -> Result<Option<SurfRecord>, String> {
    kabegame_core::commands::surf::surf_get_record(host)
}

#[tauri::command]
pub async fn surf_update_root_url(
    host: String,
    root_url: String,
) -> Result<serde_json::Value, String> {
    kabegame_core::commands::surf::surf_update_root_url(host, root_url)
}

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
pub async fn surf_update_name<R: Runtime>(
    app: AppHandle<R>,
    host: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let result = kabegame_core::commands::surf::surf_update_name(host.clone(), name)?;
    // 已固定到桌面的快捷方式跟着改名。
    #[cfg(target_os = "android")]
    super::surf_android::refresh_shortcut(&app, &host).await;
    Ok(result)
}

#[tauri::command]
#[cfg_attr(not(target_os = "android"), allow(unused_variables))]
pub async fn surf_delete_record<R: Runtime>(
    app: AppHandle<R>,
    host: String,
) -> Result<serde_json::Value, String> {
    let result = kabegame_core::commands::surf::surf_delete_record(host.clone())?;
    #[cfg(target_os = "android")]
    super::surf_android::disable_shortcut(&app, &host).await;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        host_from_surf_label, is_app_package_download, is_archive_download, surf_host_candidates,
    };

    #[test]
    fn surf_host_candidates_toggle_www_prefix() {
        assert_eq!(
            surf_host_candidates("WWW.XiaoHongShu.com"),
            vec!["www.xiaohongshu.com", "xiaohongshu.com"]
        );
        assert_eq!(surf_host_candidates("weibo.com"), vec!["weibo.com", "www.weibo.com"]);
    }

    #[test]
    fn app_package_download_detected_by_name_or_mime() {
        assert!(is_app_package_download(Some("app.apk"), None));
        assert!(is_app_package_download(Some("split.APKS"), None));
        assert!(is_app_package_download(Some("game.xapk"), None));
        assert!(is_app_package_download(Some("bundle.aab"), None));
        assert!(is_app_package_download(
            None,
            Some("application/vnd.android.package-archive")
        ));
        assert!(is_app_package_download(
            Some("download.bin"),
            Some("application/vnd.android.package-archive; charset=binary")
        ));
        // 媒体与压缩包都不算安装包，各自走原逻辑。
        assert!(!is_app_package_download(Some("photo.png"), Some("image/png")));
        assert!(!is_app_package_download(Some("probe.zip"), Some("application/zip")));
        assert!(!is_app_package_download(None, None));
    }

    #[test]
    fn archive_download_detected_by_name_or_mime() {
        assert!(is_archive_download(Some("probe.zip"), None));
        assert!(is_archive_download(Some("a.TAR.GZ"), Some("application/octet-stream")));
        assert!(is_archive_download(None, Some("application/x-7z-compressed; charset=binary")));
        // 认不出类型的不算压缩包，交给后处理按字节判定
        assert!(!is_archive_download(Some("octet.bin"), Some("application/octet-stream")));
        assert!(!is_archive_download(Some("photo.png"), Some("image/png")));
        assert!(!is_archive_download(None, None));
    }

    #[test]
    fn desktop_label_maps_back_to_host() {
        assert_eq!(
            host_from_surf_label("surf-example_com").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            host_from_surf_label("surf-localhost").as_deref(),
            Some("localhost")
        );
    }

    #[test]
    fn android_label_strips_session_sequence() {
        // 安卓 label 带进程内会话序号，host 解析必须剥掉 `:<n>`。
        assert_eq!(
            host_from_surf_label("surf-example_com:7").as_deref(),
            Some("example.com")
        );
        assert_eq!(host_from_surf_label("surf-example_com:").as_deref(), Some("example.com"));
    }

    #[test]
    fn navbar_and_empty_labels_are_not_content_webviews() {
        assert!(host_from_surf_label("surf-example_com-navbar").is_none());
        assert!(host_from_surf_label("surf-").is_none());
        assert!(host_from_surf_label("surf-:3").is_none());
        assert!(host_from_surf_label("-navbar").is_none());
        assert!(host_from_surf_label("main").is_none());
        assert!(host_from_surf_label("crawler-task-1").is_none());
    }
}
