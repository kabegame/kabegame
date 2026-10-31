//! CEF custom-protocol adapter.
//!
//! Tauri prepares the bundled frontend, asset protocol and IPC protocol as
//! asynchronous handlers on [`tauri_runtime::webview::PendingWebview`]. This
//! module translates CEF requests into `http` requests, invokes those handlers,
//! then exposes the buffered response through CEF's streaming resource API.
//!
//! ## 协议工厂架构(全局动态分发)
//!
//! 每个 scheme 注册**一个**进程级全局 factory(`GlobalSchemeHandlerFactory`)。
//! factory 的 `create(browser)` 回调通过 `browser.identifier()`(i32)在
//! `PROTOCOL_REGISTRY` 中查出对应 webview 的 label 和 `ProtocolHandler`,再
//! 构造 `CefResourceHandler`。注册表在 `on_browser_created` 时填入,在
//! `on_browser_destroyed` 时清除,保证请求期 label 始终正确。

use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};

use cef::{self, *};
use http::{header::CONTENT_TYPE, Request as HttpRequest, Response as HttpResponse};
use tauri_runtime::{webview::PendingWebview, Error, Result, UserEvent};

use crate::Cef;

pub(crate) type ResponseBody = Cow<'static, [u8]>;
pub(crate) type ProtocolHandler = dyn Fn(&str, HttpRequest<Vec<u8>>, Box<dyn FnOnce(HttpResponse<ResponseBody>) + Send>)
    + Send
    + Sync
    + 'static;

/// 一个 webview 的协议信息,在 `on_browser_created` 时以 browser id 为键写入注册表。
pub(crate) struct WebviewProtocols {
    pub(crate) label: String,
    pub(crate) schemes: HashMap<String, Arc<ProtocolHandler>>,
}

// browser id (i32) -> 该 browser 对应的 webview label + 各 scheme handler
static PROTOCOL_REGISTRY: OnceLock<Mutex<HashMap<i32, WebviewProtocols>>> = OnceLock::new();
/// 发起请求的 frame 身份,由 scheme factory 的 `create(browser, frame, ..)` 取得,经
/// `http::Request` 的 extension 交给协议 handler。CEF 对非 frame 发起的请求(如
/// `CefURLRequest`)给 `frame = NULL`,此时不插入该 extension。
///
/// 不记 frame 的 URL:CEF 的 `frame.url()` 是 UI 线程缓存,到 `DidFinishNavigation` 才刷新,而 IO
/// 线程上主 frame 的请求每次都换成浏览器当前的主 frame;新文档最早的请求读到的是空串或上一个文档
/// 的地址。请求来源改由 [`INITIATOR_ORIGIN_HEADER`] 提供。
#[derive(Debug, Clone)]
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,
}

/// IPC 请求(`ipc` / `cef-ipc`)的发起方 origin,由 `GetResourceRequestHandler` 的 `request_initiator`
/// 换算后写入([`origin_from_initiator`]),协议层用它覆写 `Origin`([`apply_initiator_origin`])。
/// `request_initiator` 是浏览器在提交导航时按文档算好、随子资源 factory 固定的值,没有上面的竞态,
/// 也不受渲染进程伪造。`Sec-` 前缀让页面脚本无法自带这个头。
pub(crate) const INITIATOR_ORIGIN_HEADER: &str = "Sec-Kabegame-Initiator-Origin";

// 已向 CEF 全局注册过 factory 的 scheme 集合(每 scheme 只注册一次)
static REGISTERED_SCHEMES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<i32, WebviewProtocols>> {
    PROTOCOL_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registered_schemes() -> &'static Mutex<HashSet<String>> {
    REGISTERED_SCHEMES.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 将 browser id 与对应 webview 的协议信息关联。由 `on_browser_created` 调用。
pub(crate) fn insert_browser_protocols(id: i32, protocols: WebviewProtocols) {
    registry().lock().unwrap().insert(id, protocols);
}

/// 清除 browser id 对应的协议信息。由 `on_browser_destroyed` 调用。
pub(crate) fn remove_browser_protocols(id: i32) {
    registry().lock().unwrap().remove(&id);
}

#[derive(Default)]
struct ResponseState {
    response: Option<HttpResponse<ResponseBody>>,
    offset: usize,
    cancelled: bool,
    open_in_progress: bool,
}

// 全局动态分发 factory:每个逻辑 scheme 只注册一个实例,请求期按 browser id 查
// label/handler。`logical_scheme` 是 `pending.uri_scheme_protocols` 的键(如
// `tauri`),三平台均用逻辑 scheme 注册并查找 handler。
wrap_scheme_handler_factory! {
    struct GlobalSchemeHandlerFactory { logical_scheme: String }

    impl SchemeHandlerFactory {
        fn create(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            let id = browser?.identifier();
            let guard = registry().lock().ok()?;
            let entry = guard.get(&id)?;
            let protocol = entry.schemes.get(&self.logical_scheme)?.clone();
            let label = entry.label.clone();
            // 记下发起请求的是否主 frame(`cef-ipc` 据此拒绝子 frame,见 crate::ipc)
            let request_frame = frame.map(|frame| RequestFrame {
                is_main: frame.is_main() == 1,
            });
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
                request_frame,
            ))
        }
    }
}

wrap_resource_handler! {
    struct CefResourceHandler {
        webview_label: String,
        protocol: Arc<ProtocolHandler>,
        state: Arc<Mutex<ResponseState>>,
        // 发起请求的 frame;`None` 表示 CEF 未给出 frame。
        request_frame: Option<RequestFrame>,
    }

    impl ResourceHandler {
        fn open(
            &self,
            request: Option<&mut cef::Request>,
            handle_request: Option<&mut ::std::os::raw::c_int>,
            callback: Option<&mut Callback>,
        ) -> ::std::os::raw::c_int {
            let (Some(request), Some(handle_request), Some(callback)) =
                (request, handle_request, callback)
            else {
                return 0;
            };

            let mut request = match request_to_http(request) {
                Ok(request) => request,
                Err(()) => {
                    self.state.lock().unwrap().response = Some(bad_request());
                    *handle_request = 1;
                    return 1;
                }
            };
            apply_initiator_origin(&mut request);
            if let Some(frame) = &self.request_frame {
                request.extensions_mut().insert(frame.clone());
            }

            self.state.lock().unwrap().open_in_progress = true;
            let state = self.state.clone();
            let callback = callback.clone();
            (self.protocol)(
                &self.webview_label,
                request,
                Box::new(move |response| {
                    let should_continue = {
                        let mut state = state.lock().unwrap();
                        if state.cancelled {
                            false
                        } else {
                            state.response = Some(response);
                            !state.open_in_progress
                        }
                    };
                    if should_continue {
                        callback.cont();
                    }
                }),
            );

            // Tauri handlers are allowed to respond inline. In that case CEF
            // must not receive `cont()` re-entrantly while `open` is running;
            // return a synchronous handled result (`handle_request=1`) instead.
            //
            // 异步响应(invoke 命令等)按 CEF 契约必须**仍返回 1** 且
            // `handle_request=0`,稍后经上面克隆的 callback `cont()` 恢复;
            // 返回 0 的语义是"取消请求",会让页面侧 fetch 立刻
            // `TypeError: Failed to fetch`(cef-ipc:///raw 二进制通道就栽在这)。
            let response_is_ready = {
                let mut state = self.state.lock().unwrap();
                state.open_in_progress = false;
                state.response.is_some()
            };
            *handle_request = i32::from(response_is_ready);
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut cef::Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let Some(response) = response else { return };
            let state = self.state.lock().unwrap();
            let Some(http_response) = state.response.as_ref() else {
                response.set_status(500);
                return;
            };

            let status = http_response.status();
            response.set_status(status.as_u16() as i32);
            if let Some(reason) = status.canonical_reason() {
                response.set_status_text(Some(&CefString::from(reason)));
            }

            let mut headers = CefStringMultimap::new();
            for (name, value) in http_response.headers() {
                if let Ok(value) = value.to_str() {
                    headers.append(name.as_str(), value);
                }
            }
            response.set_header_map(Some(&mut headers));

            if let Some(content_type) = http_response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
            {
                let mut parts = content_type.split(';').map(str::trim);
                if let Some(mime) = parts.next().filter(|mime| !mime.is_empty()) {
                    response.set_mime_type(Some(&CefString::from(mime)));
                }
                if let Some(charset) = parts.find_map(|part| part.strip_prefix("charset=")) {
                    response.set_charset(Some(&CefString::from(charset.trim_matches('"'))));
                }
            }

            if let Some(response_length) = response_length {
                *response_length = http_response.body().len() as i64;
            }
        }

        fn skip(
            &self,
            bytes_to_skip: i64,
            bytes_skipped: Option<&mut i64>,
            _callback: Option<&mut ResourceSkipCallback>,
        ) -> ::std::os::raw::c_int {
            if bytes_to_skip <= 0 {
                return 0;
            }
            let mut state = self.state.lock().unwrap();
            let Some(response) = state.response.as_ref() else { return 0 };
            let skipped = (bytes_to_skip as usize)
                .min(response.body().len().saturating_sub(state.offset));
            state.offset += skipped;
            if let Some(bytes_skipped) = bytes_skipped {
                *bytes_skipped = skipped as i64;
            }
            i32::from(skipped > 0)
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: ::std::os::raw::c_int,
            bytes_read: Option<&mut ::std::os::raw::c_int>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> ::std::os::raw::c_int {
            if data_out.is_null() || bytes_to_read <= 0 {
                return 0;
            }

            let mut state = self.state.lock().unwrap();
            let Some(response) = state.response.as_ref() else { return 0 };
            let body = response.body().as_ref();
            if state.offset >= body.len() {
                return 0;
            }

            let count = (bytes_to_read as usize).min(body.len() - state.offset);
            unsafe {
                std::ptr::copy_nonoverlapping(body.as_ptr().add(state.offset), data_out, count);
            }
            state.offset += count;
            if let Some(bytes_read) = bytes_read {
                *bytes_read = count as i32;
            }
            1
        }

        fn cancel(&self) {
            self.state.lock().unwrap().cancelled = true;
        }
    }
}

/// 从 `pending` 中取出所有协议 handler,向 CEF 全局注册各 scheme 的 factory(每个
/// scheme 只注册一次),返回 `(webview_label, schemes_map)` 供调用方通过
/// `on_browser_created` delegate 写入 [`PROTOCOL_REGISTRY`]。
///
/// 该函数在 CEF UI 线程的窗口创建任务中调用(`post_cef_ui_task` 已等待
/// `WINDOWED_CONTEXT_INITIALIZED`),满足全局注册时序要求。
pub(crate) fn take_webview_protocols<T: UserEvent>(
    pending: &mut PendingWebview<T, Cef<T>>,
) -> Result<(String, HashMap<String, Arc<ProtocolHandler>>)> {
    let label = pending.label.clone();
    let mut schemes: HashMap<String, Arc<ProtocolHandler>> = HashMap::new();
    for (scheme, protocol) in std::mem::take(&mut pending.uri_scheme_protocols) {
        ensure_global_scheme_factory(&scheme)?;
        schemes.insert(scheme, Arc::from(protocol));
    }
    Ok((label, schemes))
}

/// 向 CEF 全局注册 `logical_scheme` 的 factory,首次调用才实际注册,重复调用为 no-op。
///
/// 三平台都以逻辑 scheme、空域注册；请求期按 browser id 查对应 handler。
fn ensure_global_scheme_factory(logical_scheme: &str) -> Result<()> {
    let mut set = registered_schemes().lock().unwrap();
    if set.contains(logical_scheme) {
        return Ok(());
    }
    let mut factory = GlobalSchemeHandlerFactory::new(logical_scheme.to_string());
    let ok = cef::register_scheme_handler_factory(
        Some(&CefString::from(logical_scheme)),
        None,
        Some(&mut factory),
    );
    if ok == 1 {
        set.insert(logical_scheme.to_string());
        Ok(())
    } else {
        Err(Error::CreateWebview(Box::new(std::io::Error::other(
            format!("CEF failed to register global {logical_scheme:?} scheme factory"),
        ))))
    }
}

/// CEF 把自定义 scheme 注册为标准来源；`url` crate 对它们仍返回 opaque origin。
/// 对有 host 的非特殊 scheme 手动拼出 Web origin，其余使用 `url` 的元组 origin。
pub(crate) fn web_origin(url: &url::Url) -> Option<String> {
    let origin = url.origin();
    if origin.is_tuple() {
        return Some(origin.ascii_serialization());
    }
    if url.scheme() == "file" {
        return None;
    }
    let host = url.host_str()?;
    let port = url.port().map(|port| format!(":{port}")).unwrap_or_default();
    Some(format!("{}://{host}{port}", url.scheme()))
}

/// 是否 IPC 请求(Tauri 主通道 `ipc://` 或回退通道 `cef-ipc://`)。只有它们的来源要按发起方覆写。
pub(crate) fn is_ipc_url(url: &str) -> bool {
    url.split_once(':').is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("ipc") || scheme.eq_ignore_ascii_case(crate::ipc::CEF_IPC_SCHEME)
    })
}

/// 把 `request_initiator`(Chromium `url::Origin::Serialize`)换成 IPC 请求的 `Origin` 值:
/// - `file:` 文档序列化成 `"file://"`(不是合法 URL),写成 `file:///`,Tauri 判成远程 `file:` 来源,
///   ACL 按 `remote.urls` 匹配(WPE 网页壁纸只得 `wpe-web-capability`);
/// - 普通 origin 原样;
/// - opaque(沙箱页、错误页)或缺失写成 `null`,两条通道都拒绝,不会退到别的地址被判成本地来源。
pub(crate) fn origin_from_initiator(initiator: Option<&str>) -> String {
    match initiator.map(str::trim) {
        Some("file://") => "file:///".to_string(),
        Some(origin) if !origin.is_empty() => origin.to_string(),
        _ => "null".to_string(),
    }
}

/// 有 [`INITIATOR_ORIGIN_HEADER`] 时用它覆写 `Origin`,并去掉这个内部头;没有时(非 IPC 请求)不动。
fn apply_initiator_origin(request: &mut HttpRequest<Vec<u8>>) {
    if let Some(origin) = request.headers_mut().remove(INITIATOR_ORIGIN_HEADER) {
        request.headers_mut().insert(http::header::ORIGIN, origin);
    }
}

fn request_to_http(request: &cef::Request) -> std::result::Result<HttpRequest<Vec<u8>>, ()> {
    let cef_method = request.method();
    let method = CefString::from(&cef_method)
        .to_string()
        .parse()
        .map_err(|_| ())?;
    let cef_url = request.url();
    let uri: http::Uri = CefString::from(&cef_url)
        .to_string()
        .parse()
        .map_err(|_| ())?;
    let mut http_request = HttpRequest::new(post_data_bytes(request));
    *http_request.method_mut() = method;
    *http_request.uri_mut() = uri;

    let mut headers = CefStringMultimap::new();
    request.header_map(Some(&mut headers));
    for (name, values) in headers {
        let Ok(name) = name.parse::<http::HeaderName>() else {
            continue;
        };
        for value in values {
            let Ok(value) = value.parse::<http::HeaderValue>() else {
                continue;
            };
            http_request.headers_mut().append(name.clone(), value);
        }
    }
    Ok(http_request)
}

fn post_data_bytes(request: &cef::Request) -> Vec<u8> {
    let Some(post_data) = request.post_data() else {
        return Vec::new();
    };
    let mut elements = vec![None; post_data.element_count()];
    post_data.elements(Some(&mut elements));

    let mut body = Vec::new();
    for element in elements.into_iter().flatten() {
        let count = element.bytes_count();
        if count == 0 {
            continue;
        }
        let start = body.len();
        body.resize(start + count, 0);
        let written = element.bytes(count, body[start..].as_mut_ptr());
        body.truncate(start + written);
    }
    body
}

fn bad_request() -> HttpResponse<ResponseBody> {
    HttpResponse::builder()
        .status(http::StatusCode::BAD_REQUEST)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Borrowed(&b"invalid CEF protocol request"[..]))
        .expect("static bad-request response must be valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_origin_handles_native_and_http_schemes() {
        assert_eq!(
            web_origin(&url::Url::parse("tauri://localhost/index.html").unwrap()).as_deref(),
            Some("tauri://localhost")
        );
        assert_eq!(
            web_origin(&url::Url::parse("ipc://localhost/command").unwrap()).as_deref(),
            Some("ipc://localhost")
        );
        assert_eq!(
            web_origin(&url::Url::parse("https://example.com:8443/path").unwrap()).as_deref(),
            Some("https://example.com:8443")
        );
        assert_eq!(
            web_origin(&url::Url::parse("file:///D:/wallpaper/index.html").unwrap()),
            None
        );
        assert_eq!(web_origin(&url::Url::parse("file://server/share").unwrap()), None);
    }

    #[test]
    fn bad_request_response_is_stable() {
        let response = bad_request();
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        assert_eq!(response.body().as_ref(), b"invalid CEF protocol request");
    }

    fn request_with_origin(origin: Option<&str>) -> HttpRequest<Vec<u8>> {
        let mut builder = HttpRequest::builder().uri("ipc://localhost/cmd");
        if let Some(origin) = origin {
            builder = builder.header(http::header::ORIGIN, origin);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn origin_of(request: &HttpRequest<Vec<u8>>) -> Option<&str> {
        request
            .headers()
            .get(http::header::ORIGIN)
            .and_then(|value| value.to_str().ok())
    }

    /// 与 `request_to_http` 一样经 `HeaderName` 解析插入(名字转小写)。
    fn with_initiator(mut request: HttpRequest<Vec<u8>>, origin: &str) -> HttpRequest<Vec<u8>> {
        request.headers_mut().append(
            INITIATOR_ORIGIN_HEADER.parse::<http::HeaderName>().unwrap(),
            origin.parse().unwrap(),
        );
        request
    }

    #[test]
    fn ipc_urls_are_recognized() {
        assert!(is_ipc_url("ipc://localhost/plugin%3Aevent%7Clisten"));
        assert!(is_ipc_url("IPC://localhost/cmd"));
        assert!(is_ipc_url("cef-ipc://localhost/"));
        assert!(!is_ipc_url("tauri://localhost/index.html"));
        assert!(!is_ipc_url("file:///D:/wpe/1/index.html"));
        assert!(!is_ipc_url("https://ipc.localhost/cmd"));
    }

    #[test]
    fn initiator_maps_to_ipc_origin() {
        // `file:` 文档：`url::Origin::Serialize` 给 "file://"
        assert_eq!(origin_from_initiator(Some("file://")), "file:///");
        assert_eq!(origin_from_initiator(Some("tauri://localhost")), "tauri://localhost");
        assert_eq!(origin_from_initiator(Some("http://localhost:1420")), "http://localhost:1420");
        // opaque 与缺失都不能被判成任何地址
        assert_eq!(origin_from_initiator(Some("null")), "null");
        assert_eq!(origin_from_initiator(Some("")), "null");
        assert_eq!(origin_from_initiator(None), "null");
        // 换算结果 Tauri 都能当 URL 解析（null 除外，由它拒绝）
        assert!(url::Url::parse(&origin_from_initiator(Some("file://"))).is_ok());
    }

    #[test]
    fn initiator_header_overrides_origin() {
        // `file:` 文档的渲染进程发 "null"，按发起方写成 file:///，内部头被去掉
        let mut request = with_initiator(request_with_origin(Some("null")), "file:///");
        apply_initiator_origin(&mut request);
        assert_eq!(origin_of(&request), Some("file:///"));
        assert!(request.headers().get(INITIATOR_ORIGIN_HEADER).is_none());
        // 刚离开网页壁纸的应用页：渲染进程的 Origin 与发起方一致，原样保留
        let mut request = with_initiator(request_with_origin(Some("tauri://localhost")), "tauri://localhost");
        apply_initiator_origin(&mut request);
        assert_eq!(origin_of(&request), Some("tauri://localhost"));
        // 渲染进程声称的来源与发起方不符：以发起方为准
        let mut request = with_initiator(request_with_origin(Some("tauri://localhost")), "null");
        apply_initiator_origin(&mut request);
        assert_eq!(origin_of(&request), Some("null"));
        // 没有内部头（非 IPC 请求）：不动
        let mut request = request_with_origin(Some("null"));
        apply_initiator_origin(&mut request);
        assert_eq!(origin_of(&request), Some("null"));
        let mut request = request_with_origin(None);
        apply_initiator_origin(&mut request);
        assert_eq!(origin_of(&request), None);
    }

    #[test]
    fn response_state_starts_empty() {
        let state = ResponseState::default();
        assert!(state.response.is_none());
        assert_eq!(state.offset, 0);
        assert!(!state.cancelled);
        assert!(!state.open_in_progress);
    }
}
