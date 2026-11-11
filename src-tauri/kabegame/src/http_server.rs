#[cfg(not(target_os = "android"))]
use std::path::Path;
#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
use std::sync::{Arc, OnceLock};

#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
use axum::{
    body::Body,
    http::Request,
    middleware::{from_fn, Next},
};
#[cfg(not(target_os = "android"))]
use axum::{
    extract::Path as UrlPath,
    http::{
        header::{
            HeaderValue, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
            RANGE,
        },
        StatusCode,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

#[cfg(not(target_os = "android"))]
use tokio::io::SeekFrom;
#[cfg(not(target_os = "android"))]
use tokio::io::{AsyncReadExt, AsyncSeekExt};
#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
use tokio::sync::Semaphore;

/// 单次 206 响应的最大字节数。响应体是一次性读进内存的 `Vec<u8>`,不能让开放式
/// Range 把整段视频拉进来。
#[cfg(not(target_os = "android"))]
const MAX_RANGE_CHUNK: u64 = 8 * 1024 * 1024;

/// 无 Range 的整文件响应按这个块大小流式读盘，进程内存不随文件大小增长。
#[cfg(not(target_os = "android"))]
const STREAM_CHUNK: usize = 256 * 1024;

#[cfg(not(target_os = "android"))]
fn mime_from_path(path: &str) -> Option<String> {
    if let Some(m) = kabegame_core::media::image_type::mime_type_from_path(Path::new(path)) {
        if let Some(mime) = kabegame_core::media::image_type::mime_from_format(&m) {
            return Some(mime.to_string());
        }
    }
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(kabegame_core::media::image_type::default_image_extension())
        .trim_start_matches('.')
        .to_ascii_lowercase();
    kabegame_core::media::image_type::mime_by_ext()
        .get(&ext)
        .cloned()
}

#[cfg(not(target_os = "android"))]
fn set_content_type_if_present(resp: &mut Response, mime_type: Option<&str>) {
    let Some(mime_type) = mime_type else { return };
    if let Ok(v) = HeaderValue::from_str(mime_type) {
        resp.headers_mut().insert(CONTENT_TYPE, v);
    }
}

#[cfg(not(target_os = "android"))]
const IMMUTABLE_CACHE_CONTROL: HeaderValue =
    HeaderValue::from_static("public, max-age=31536000, immutable");

#[cfg(not(target_os = "android"))]
fn set_immutable_cache(resp: &mut Response) {
    resp.headers_mut()
        .insert(CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL);
}

/// 本地路径端点共用的白名单校验。
///
/// 两道门缺一不可:文件要真实存在于磁盘,并且要能在 images 表里按路径查到。后者
/// 才是白名单本身——它把可读范围锁在图库已登记的文件上,否则端点就退化成任意本地
/// 文件读取。新增任何按本地路径取文件的端点一律走这里,不要再各写一份。
///
/// 通过时返回该图片的 `ImageInfo`(调用方要用它的 media_type 定 MIME);不通过时返回
/// 已经构造好的错误响应,调用方直接 return 即可。
#[cfg(not(target_os = "android"))]
async fn authorize_local_path(path: &str) -> Result<kabegame_core::storage::ImageInfo, Response> {
    if path.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing path").into_response());
    }
    // 先看磁盘,不存在就不必再查表。
    if tokio::fs::metadata(path).await.is_err() {
        return Err((StatusCode::NOT_FOUND, "file not found").into_response());
    }
    match kabegame_core::storage::Storage::find_image_by_path(path) {
        Ok(Some(info)) => Ok(info),
        _ => Err((StatusCode::NOT_FOUND, "file not found").into_response()),
    }
}

#[cfg(not(target_os = "android"))]
fn absolute_path_from_route(rest: String) -> String {
    // 通配段不带前导斜杠：Unix 绝对路径要补回来；Windows 的 `C:\...` 本身已完整。
    let bytes = rest.as_bytes();
    let windows_drive =
        bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':');
    if windows_drive || rest.starts_with(r"\\") {
        rest
    } else {
        format!("/{rest}")
    }
}

#[cfg(not(target_os = "android"))]
async fn handle_file_path(
    UrlPath(rest): UrlPath<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let path = absolute_path_from_route(rest);
    let path = path.as_str();
    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let image_info = match authorize_local_path(path).await {
        Ok(info) => info,
        // 路径不是任何行：可能是某个 WPE 壁纸目录里面的文件
        #[cfg(feature = "wpe")]
        Err(response) => match authorize_wpe_inner_file(path).await {
            Some(file) => {
                return serve_file_with_mime(
                    &file,
                    Some("application/octet-stream".to_string()),
                    range,
                )
                .await
            }
            None => return response,
        },
        #[cfg(not(feature = "wpe"))]
        Err(response) => return response,
    };
    // 目录型 WPE 壁纸的 local_path 是目录，不能当文件读：返回目录里的文件清单，
    // 客户端再按清单逐个请求目录内的文件。入口视频的播放仍走 /compatible（compatible_path）。
    if kabegame_core::media::image_type::is_wpe_type(image_info.media_type.as_deref()) {
        #[cfg(feature = "wpe")]
        return wpe_dir_listing(&image_info).await;
        #[cfg(not(feature = "wpe"))]
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    let mime = image_info
        .media_type
        .as_deref()
        .and_then(kabegame_core::media::image_type::mime_from_format)
        .map(str::to_string)
        .or_else(|| mime_from_path(path));

    serve_file_with_mime(path, mime, range).await
}

/// `/file/<WPE 壁纸目录>`：目录里的文件清单 `{ "type": "x-wpe/scene", "files": [{ "path", "size" }] }`。
///
/// 文件集合与目录哈希、整目录复制是同一个枚举（`dir_hash::list_files`）：相对路径用 `/` 分隔、
/// 按字节序排序，不含符号链接与 `.DS_Store` 这类系统文件。
#[cfg(all(not(target_os = "android"), feature = "wpe"))]
async fn wpe_dir_listing(image_info: &kabegame_core::storage::ImageInfo) -> Response {
    let dir = std::path::PathBuf::from(&image_info.local_path);
    let listed =
        tokio::task::spawn_blocking(move || kabegame_core::wpe::dir_hash::list_files(&dir)).await;
    let files = match listed {
        Ok(Ok(files)) => files,
        Ok(Err(error)) => {
            tracing::warn!("列出壁纸目录失败 {}: {error}", image_info.local_path);
            return (StatusCode::NOT_FOUND, "file not found").into_response();
        }
        Err(error) => {
            tracing::warn!("列出壁纸目录任务异常: {error}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "listing failed").into_response();
        }
    };
    let files: Vec<serde_json::Value> = files
        .into_iter()
        .map(|file| serde_json::json!({ "path": file.rel, "size": file.size }))
        .collect();
    let mut out = axum::Json(serde_json::json!({
        "type": image_info.media_type,
        "files": files,
    }))
    .into_response();
    // 清单随目录内容变，不能像媒体文件那样长期缓存
    out.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    out
}

/// `path` 不是任何图片行时，看它是不是某个 WPE 壁纸目录里面的文件。
///
/// 逐级向上按路径查行（走 `local_path` 唯一索引），第一个命中的行必须是 WPE 行；
/// 请求路径规范化后（解开 `..` 与符号链接）必须仍在该目录之内且是普通文件。
/// 通过时返回规范化后的文件路径。
#[cfg(all(not(target_os = "android"), feature = "wpe"))]
async fn authorize_wpe_inner_file(path: &str) -> Option<String> {
    let requested = Path::new(path);
    // 文件不存在就不必查表
    let canonical = tokio::fs::canonicalize(requested).await.ok()?;
    if !tokio::fs::metadata(&canonical).await.ok()?.is_file() {
        return None;
    }
    for ancestor in requested.ancestors().skip(1) {
        let ancestor = ancestor.to_str().filter(|text| !text.is_empty())?;
        let Ok(Some(info)) = kabegame_core::storage::Storage::find_image_by_path(ancestor) else {
            continue;
        };
        if !kabegame_core::media::image_type::is_wpe_type(info.media_type.as_deref()) {
            return None;
        }
        let root = tokio::fs::canonicalize(&info.local_path).await.ok()?;
        if canonical == root || !canonical.starts_with(&root) {
            return None;
        }
        return canonical.to_str().map(str::to_string);
    }
    None
}

/// 把整个文件作为流式响应体：按 [`STREAM_CHUNK`] 分块读盘，读错即结束流。
#[cfg(not(target_os = "android"))]
fn file_stream_body(file: tokio::fs::File) -> axum::body::Body {
    let stream = futures_util::stream::unfold(Some(file), |state| async move {
        let mut file = state?;
        let mut chunk = vec![0u8; STREAM_CHUNK];
        match file.read(&mut chunk).await {
            Ok(0) => None,
            Ok(read) => {
                chunk.truncate(read);
                Some((Ok::<_, std::io::Error>(chunk), Some(file)))
            }
            Err(error) => Some((Err(error), None)),
        }
    });
    axum::body::Body::from_stream(stream)
}

#[cfg(not(target_os = "android"))]
async fn handle_thumbnail_path(
    UrlPath(rest): UrlPath<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let path = absolute_path_from_route(rest);
    let path = path.as_str();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }

    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    match kabegame_core::storage::Storage::find_image_by_thumbnail_path(path) {
        Ok(Some(_)) => {}
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    }

    // 缩略图 MIME 优先根据缩略图文件路径推断（缩略图可能是 jpg 而原始文件是 mp4）
    let thumb_mime = mime_from_path(path);

    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    serve_file_with_mime(path, thumb_mime, range).await
}

#[cfg(not(target_os = "android"))]
async fn serve_file_with_mime(
    path: &str,
    mime_type: Option<String>,
    range_header: Option<String>,
) -> Response {
    if let Some(range_header) = range_header {
        match tokio::fs::metadata(path).await {
            Ok(meta) => {
                let file_size = meta.len();
                if file_size == 0 {
                    let mut out = (StatusCode::OK, Vec::<u8>::new()).into_response();
                    out.headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    set_content_type_if_present(&mut out, mime_type.as_deref());
                    set_immutable_cache(&mut out);
                    return out;
                }
                if let Some(range_part) = range_header.strip_prefix("bytes=") {
                    let mut split = range_part.splitn(2, '-');
                    let start_str = split.next().unwrap_or("").trim();
                    let end_str = split.next().unwrap_or("").trim();
                    let start = start_str.parse::<u64>().ok();
                    let end = if end_str.is_empty() {
                        None
                    } else {
                        end_str.parse::<u64>().ok()
                    };
                    if let Some(start) = start {
                        // 开放式区间(`bytes=N-`)按上限截断。Chromium 播放视频时首个
                        // media 请求就是 `bytes=0-`,原样满足会把整个文件读进内存;
                        // 截断后仍是合规 206,客户端照 Content-Range 继续要后续块。
                        let end = end
                            .unwrap_or_else(|| start.saturating_add(MAX_RANGE_CHUNK - 1))
                            .min(file_size - 1);
                        if start <= end && end < file_size {
                            let chunk_len = (end - start + 1) as usize;
                            let mut file = match tokio::fs::File::open(path).await {
                                Ok(f) => f,
                                Err(_) => {
                                    return (StatusCode::NOT_FOUND, "file not found")
                                        .into_response()
                                }
                            };
                            if file.seek(SeekFrom::Start(start)).await.is_err() {
                                return (StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                                    .into_response();
                            }
                            let mut buf = vec![0u8; chunk_len];
                            if file.read_exact(&mut buf).await.is_err() {
                                return (StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                                    .into_response();
                            }
                            let mut out = (StatusCode::PARTIAL_CONTENT, buf).into_response();
                            if let Ok(v) = HeaderValue::from_str(&format!(
                                "bytes {}-{}/{}",
                                start, end, file_size
                            )) {
                                out.headers_mut().insert(CONTENT_RANGE, v);
                            }
                            if let Ok(v) = HeaderValue::from_str(&(end - start + 1).to_string()) {
                                out.headers_mut().insert(CONTENT_LENGTH, v);
                            }
                            out.headers_mut()
                                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                            set_content_type_if_present(&mut out, mime_type.as_deref());
                            set_immutable_cache(&mut out);
                            return out;
                        }
                    }
                }
                let mut out =
                    (StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable").into_response();
                if let Ok(v) = HeaderValue::from_str(&format!("bytes */{}", file_size)) {
                    out.headers_mut().insert(CONTENT_RANGE, v);
                }
                return out;
            }
            Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
        }
    }

    // 无 Range 头:整文件返回(图片走这条;视频的 media 请求 Chromium 总会带 Range)。
    // 流式读盘:WPE 壁纸目录里的 `scene.pkg` 可以有几个 GB,不能整份读进内存。
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    let file_size = match file.metadata().await {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };
    let mut out = (StatusCode::OK, file_stream_body(file)).into_response();
    if let Ok(v) = HeaderValue::from_str(&file_size.to_string()) {
        out.headers_mut().insert(CONTENT_LENGTH, v);
    }
    out.headers_mut()
        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    // 流式响应体没有默认的 Content-Type：推断不出类型时与原先的字节响应一样按二进制流
    set_content_type_if_present(
        &mut out,
        Some(mime_type.as_deref().unwrap_or("application/octet-stream")),
    );
    set_immutable_cache(&mut out);
    out
}

#[cfg(not(target_os = "android"))]
async fn handle_compatible_path(
    UrlPath(rest): UrlPath<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    let path = absolute_path_from_route(rest);
    let path = path.as_str();
    if path.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    }

    if tokio::fs::metadata(path).await.is_err() {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    match kabegame_core::storage::Storage::find_image_by_compatible_path(path) {
        Ok(Some(info)) => {
            // compatible_path 可能与源记录格式不同，响应 MIME 必须描述实际返回的兼容文件。
            let mime = mime_from_path(path).or_else(|| {
                info.media_type
                    .as_deref()
                    .and_then(kabegame_core::media::image_type::mime_from_format)
                    .map(str::to_string)
            });
            let range = headers
                .get(RANGE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            serve_file_with_mime(path, mime, range).await
        }
        _ => (StatusCode::NOT_FOUND, "file not found").into_response(),
    }
}

/// 桌面应用 Web 服务器暴露的媒体路由。
///
/// 只允许访问图库白名单内的文件（`/file` `/thumbnail` `/compatible`），不含 `/plugin_file`。
#[cfg(all(not(target_os = "android"), not(feature = "web")))]
pub fn file_routes_media() -> Router {
    let routes = Router::new()
        .route("/file/{*path}", get(handle_file_path))
        .route("/thumbnail/{*path}", get(handle_thumbnail_path))
        .route("/compatible/{*path}", get(handle_compatible_path));

    #[cfg(any(debug_assertions, not(feature = "web")))]
    {
        routes.layer(from_fn(image_concurrency_mw))
    }
    #[cfg(all(not(debug_assertions), feature = "web"))]
    {
        routes
    }
}

/// web 模式专用路由。
///
/// - **Release**：只保留 `/plugin_file`。图库图片、缩略图和兼容副本直接由 CDN 返回，
///   只对插件包做按需磁盘读取；`commands::image`
///   在 `ImageInfo` 序列化前把本地媒体路径改写成 CDN URL。
/// - **Debug**：保留 `/file` `/thumbnail` `/compatible`，方便本地联调——
///   开发机没 CDN，走本地文件最直观。
#[cfg(all(feature = "web", debug_assertions))]
pub fn file_routes_web() -> Router {
    let gated = Router::new()
        .route("/file/{*path}", get(handle_file_path))
        .route("/thumbnail/{*path}", get(handle_thumbnail_path))
        .route("/compatible/{*path}", get(handle_compatible_path))
        .layer(from_fn(image_concurrency_mw));
    gated.merge(crate::plugin_file_server::plugin_file_routes())
}

#[cfg(all(feature = "web", not(debug_assertions)))]
pub fn file_routes_web() -> Router {
    Router::new().merge(crate::plugin_file_server::plugin_file_routes())
}

/// Debug-only：/file 与 /thumbnail 的并发闸（10 个并发 + 无限排队）。
/// Release 下 /file /thumbnail 不挂载，这些符号一起编译掉。
#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
const WEB_IMAGE_CONCURRENCY: usize = 10;

#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
static WEB_IMAGE_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
fn web_image_semaphore() -> Arc<Semaphore> {
    WEB_IMAGE_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(WEB_IMAGE_CONCURRENCY)))
        .clone()
}

#[cfg(all(
    not(target_os = "android"),
    any(debug_assertions, not(feature = "web"))
))]
async fn image_concurrency_mw(req: Request<Body>, next: Next) -> Response {
    let sem = web_image_semaphore();
    match sem.acquire_owned().await {
        Ok(permit) => {
            let resp = next.run(req).await;
            drop(permit);
            resp
        }
        Err(_) => next.run(req).await,
    }
}

#[cfg(all(target_os = "android", not(feature = "web")))]
#[tauri::command]
pub async fn get_http_server_base_url<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    use tauri_plugin_picker::PickerExt;

    app.picker()
        .get_http_server_base(crate::plugin_file_server::start_plugin_file_server().await?)
        .await
        .map(|r| r.base_url.trim_end_matches('/').to_string())
        .map_err(|e| e.to_string())
}

#[cfg(all(test, not(target_os = "android"), not(feature = "web")))]
mod tests {
    use super::absolute_path_from_route;

    #[test]
    fn media_route_restores_unix_absolute_path() {
        assert_eq!(
            absolute_path_from_route("home/cm/Pictures/a.png".to_string()),
            "/home/cm/Pictures/a.png"
        );
    }

    #[test]
    fn media_route_keeps_windows_absolute_path() {
        assert_eq!(
            absolute_path_from_route(r"C:\Users\cm\Pictures\a.png".to_string()),
            r"C:\Users\cm\Pictures\a.png"
        );
        assert_eq!(
            absolute_path_from_route(r"\\server\share\a.png".to_string()),
            r"\\server\share\a.png"
        );
    }

    #[tokio::test]
    async fn media_routes_only_accept_wildcard_path_form() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind test listener");
        let address = listener.local_addr().expect("read test address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                super::file_routes_media()
                    .fallback(|| async { (axum::http::StatusCode::NOT_FOUND, "not found") }),
            )
            .await
            .expect("serve test router");
        });

        let base = format!("http://{address}");
        let wildcard_body = reqwest::get(format!("{base}/file/definitely-missing-kabegame-media"))
            .await
            .expect("request wildcard route")
            .text()
            .await
            .expect("read wildcard response");
        let query_body = reqwest::get(format!(
            "{base}/file?path=/definitely-missing-kabegame-media"
        ))
        .await
        .expect("request removed query route")
        .text()
        .await
        .expect("read query response");
        let download_body =
            reqwest::get(format!("{base}/download/definitely-missing-kabegame-media"))
                .await
                .expect("request removed download route")
                .text()
                .await
                .expect("read download response");

        assert_eq!(wildcard_body, "file not found");
        assert_eq!(query_body, "not found");
        assert_eq!(download_body, "not found");
        server.abort();
    }

    // ---------- /file 与 WPE 壁纸目录 ----------

    #[cfg(feature = "wpe")]
    mod wpe_routes {
        use kabegame_core::app_paths::AppPaths;
        use kabegame_core::settings::Settings;
        use kabegame_core::storage::{ImageInfo, Storage};
        use std::path::{Path, PathBuf};
        use std::sync::Once;

        /// 本 crate 的其它测试不碰全局单例；这里用一个进程级临时根初始化一次。
        fn init_globals() {
            static INIT: Once = Once::new();
            INIT.call_once(|| {
                let root =
                    std::env::temp_dir().join(format!("kabegame-app-tests-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&root);
                std::fs::create_dir_all(&root).unwrap();
                AppPaths::init(AppPaths {
                    data_dir: root.join("data"),
                    cache_dir: root.join("cache"),
                    temp_dir: root.join("tmp"),
                    resource_dir: root.join("resources"),
                    exe_dir: None,
                    external_data_dir: None,
                    pictures_dir: Some(root.join("pictures")),
                    compatibles_dir_path: root.join("compatibles"),
                })
                .unwrap();
                let _ = Settings::init_global();
                Storage::init_global().unwrap();
                let _ = kabegame_core::providers::provider_runtime();
            });
        }

        fn temp_root() -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("kabegame-file-route-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            dir.canonicalize().unwrap()
        }

        fn add_row(local_path: &Path, media_type: &str) {
            Storage::global()
                .add_image(ImageInfo {
                    id: String::new(),
                    url: None,
                    local_path: local_path.to_string_lossy().into_owned(),
                    plugin_id: Some("test".to_string()),
                    task_id: None,
                    surf_record_id: None,
                    crawled_at: 1,
                    metadata_id: None,
                    image_metadata_id: None,
                    thumbnail_path: String::new(),
                    favorite: false,
                    is_hidden: false,
                    local_exists: true,
                    hash: format!("hash-{}", uuid::Uuid::new_v4()),
                    width: None,
                    height: None,
                    display_name: "row".to_string(),
                    media_type: Some(media_type.to_string()),
                    last_set_wallpaper_at: None,
                    size: None,
                    album_order: None,
                    compatible_path: None,
                    post_url: None,
                    palette: None,
                })
                .unwrap();
        }

        async fn serve() -> (String, tokio::task::JoinHandle<()>) {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, super::super::file_routes_media())
                    .await
                    .unwrap();
            });
            (format!("http://{address}"), server)
        }

        /// 与 kabegame-server 插件同样的地址形态：`/file/<绝对路径去掉前导斜杠>`，各段单独编码。
        fn file_url(base: &str, path: &Path, rel: &str) -> String {
            let mut url = reqwest::Url::parse(base).unwrap();
            {
                let mut segments = url.path_segments_mut().unwrap();
                segments.push("file");
                for segment in path.to_string_lossy().split('/').filter(|s| !s.is_empty()) {
                    segments.push(segment);
                }
                for segment in rel.split('/').filter(|s| !s.is_empty()) {
                    segments.push(segment);
                }
            }
            url.to_string()
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn wpe_directory_lists_files_and_serves_inner_files_only() {
            init_globals();
            let root = temp_root();
            let wall = root.join("壁纸 dir");
            std::fs::create_dir_all(wall.join("materials")).unwrap();
            std::fs::write(wall.join("project.json"), br#"{"type":"scene"}"#).unwrap();
            // 大于一个流式分块，覆盖多块读取
            let pkg: Vec<u8> = (0..super::super::STREAM_CHUNK * 2 + 123)
                .map(|index| (index % 251) as u8)
                .collect();
            std::fs::write(wall.join("scene.pkg"), &pkg).unwrap();
            std::fs::write(wall.join("materials/贴图 a.tex"), b"texture").unwrap();
            std::fs::write(wall.join(".DS_Store"), b"finder").unwrap();
            add_row(&wall, "x-wpe/scene");

            // 目录外的文件、另一个没入库的目录
            std::fs::write(root.join("secret.txt"), b"secret").unwrap();
            let stranger = root.join("stranger");
            std::fs::create_dir_all(&stranger).unwrap();
            std::fs::write(stranger.join("a.txt"), b"not in library").unwrap();
            // 目录里指向外面的符号链接
            std::os::unix::fs::symlink(root.join("secret.txt"), wall.join("escape.txt")).unwrap();

            let (base, server) = serve().await;

            // 目录本身：清单
            let response = reqwest::get(file_url(&base, &wall, "")).await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
            let listing: serde_json::Value = response.json().await.unwrap();
            assert_eq!(listing["type"], "x-wpe/scene");
            assert_eq!(
                listing["files"],
                serde_json::json!([
                    { "path": "materials/贴图 a.tex", "size": 7 },
                    { "path": "project.json", "size": 16 },
                    { "path": "scene.pkg", "size": pkg.len() },
                ])
            );

            // 目录内文件：整文件流式返回，带长度
            let response = reqwest::get(file_url(&base, &wall, "scene.pkg"))
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(
                response.content_length(),
                Some(pkg.len() as u64),
                "流式响应仍带 Content-Length"
            );
            assert_eq!(response.bytes().await.unwrap().as_ref(), pkg.as_slice());

            let response = reqwest::get(file_url(&base, &wall, "materials/贴图 a.tex"))
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.bytes().await.unwrap().as_ref(), b"texture");

            // Range 仍可用
            let response = reqwest::Client::new()
                .get(file_url(&base, &wall, "scene.pkg"))
                .header("range", "bytes=10-19")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 206);
            assert_eq!(response.bytes().await.unwrap().as_ref(), &pkg[10..20]);

            // 越界：`..`、符号链接、没入库的目录、目录内不存在的文件、子目录本身
            for (rel, label) in [
                ("%2e%2e/secret.txt", "encoded parent"),
                ("materials/%2e%2e/%2e%2e/secret.txt", "nested parent"),
                ("escape.txt", "symlink escape"),
                ("missing.bin", "missing file"),
                ("materials", "inner directory"),
            ] {
                let url = format!("{}/{rel}", file_url(&base, &wall, ""));
                let response = reqwest::get(&url).await.unwrap();
                assert_eq!(response.status(), 404, "{label}: {url}");
            }
            let response = reqwest::get(file_url(&base, &stranger, "a.txt"))
                .await
                .unwrap();
            assert_eq!(response.status(), 404);
            let response = reqwest::get(file_url(&base, &root, "secret.txt"))
                .await
                .unwrap();
            assert_eq!(response.status(), 404);

            server.abort();
            let _ = std::fs::remove_dir_all(root);
        }

        /// 普通图片行的行为不变：整文件返回、类型取自行；它旁边的文件不会被当成「目录内文件」。
        #[cfg(unix)]
        #[tokio::test]
        async fn plain_image_rows_keep_their_behaviour() {
            init_globals();
            let root = temp_root();
            let image = root.join("a.png");
            std::fs::write(&image, b"png-bytes").unwrap();
            std::fs::write(root.join("b.png"), b"sibling").unwrap();
            add_row(&image, "image/png");

            let (base, server) = serve().await;

            let response = reqwest::get(file_url(&base, &image, "")).await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.headers().get("content-type").unwrap(), "image/png");
            assert_eq!(response.headers().get("accept-ranges").unwrap(), "bytes");
            assert_eq!(response.content_length(), Some(9));
            assert_eq!(response.bytes().await.unwrap().as_ref(), b"png-bytes");

            // 没入库的同目录文件、把图片行当目录往下取：都是 404
            let response = reqwest::get(file_url(&base, &root, "b.png")).await.unwrap();
            assert_eq!(response.status(), 404);
            let response = reqwest::get(file_url(&base, &image, "inner"))
                .await
                .unwrap();
            assert_eq!(response.status(), 404);

            server.abort();
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
