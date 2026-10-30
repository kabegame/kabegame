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
    let image_info = match authorize_local_path(path).await {
        Ok(info) => info,
        Err(response) => return response,
    };
    // 目录型 WPE 壁纸的 local_path 是目录，不能当文件读；入口视频走 /compatible（compatible_path）。
    if kabegame_core::media::image_type::is_wpe_type(image_info.media_type.as_deref()) {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

    let mime = image_info
        .media_type
        .as_deref()
        .and_then(kabegame_core::media::image_type::mime_from_format)
        .map(str::to_string)
        .or_else(|| mime_from_path(path));

    let range = headers
        .get(RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    serve_file_with_mime(path, mime, range).await
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

    // 无 Range 头:整文件返回(图片走这条;视频的 media 请求 Chromium 总会带 Range)
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mut out = (StatusCode::OK, bytes).into_response();
            out.headers_mut()
                .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            set_content_type_if_present(&mut out, mime_type.as_deref());
            set_immutable_cache(&mut out);
            out
        }
        Err(_) => (StatusCode::NOT_FOUND, "file not found").into_response(),
    }
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

#[cfg(not(target_os = "android"))]
pub async fn start_http_server() -> Result<u16, String> {
    if let Some(port) = HTTP_SERVER_PORT.get() {
        return Ok(*port);
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind file server failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read file server local addr failed: {e}"))?
        .port();

    let app = file_routes().fallback(handle_unmatched);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::debug!("stopped: {e}");
        }
    });

    let _ = HTTP_SERVER_PORT.set(port);
    Ok(port)
}

#[cfg(all(not(target_os = "android"), not(feature = "web")))]
#[tauri::command]
pub async fn get_http_server_base_url() -> Result<String, String> {
    for _ in 0..60 {
        if let Some(port) = HTTP_SERVER_PORT.get() {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("file server not ready".to_string())
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
}
