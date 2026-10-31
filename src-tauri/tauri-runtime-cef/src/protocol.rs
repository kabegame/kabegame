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
use tauri_runtime::{
    webview::{IpcFrame, PendingWebview},
    Error, Result, UserEvent,
};

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
/// `http::Request` 的 extension 交给协议 handler。CEF 对非 frame 发起的请求(service worker、
/// `CefURLRequest`)给 `frame = NULL`,此时不插入该 extension;dedicated worker 的请求记在创建它的
/// frame 上。
///
/// 另有给 Tauri ACL 用的 [`IpcFrame`] extension,每个请求都插(见 [`attach_request_frame`])。
#[derive(Debug, Clone)]
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,
    /// 发起请求的 frame 当前 URL;`file:` 文档据此改写 `Origin`,IPC 来源判成远程 `file:`。
    pub(crate) url: Option<String>,
}

impl RequestFrame {
    /// 对应的 Tauri ACL frame 位置:capability 的 `frames` 据此匹配。
    pub(crate) fn ipc_frame(&self) -> IpcFrame {
        if self.is_main {
            IpcFrame::Main
        } else {
            IpcFrame::Sub
        }
    }
}

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
            // 记下发起请求的 frame:是否主 frame(`cef-ipc` 据此拒绝子 frame,见 crate::ipc)
            // 与当前 URL(`file:` 文档据此改写 Origin,见 `pin_file_frame_origin`)
            let request_frame = frame.map(|frame| RequestFrame {
                is_main: frame.is_main() == 1,
                url: Some(CefString::from(&frame.url()).to_string()).filter(|url| !url.is_empty()),
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
            attach_request_frame(&mut request, self.request_frame.as_ref());

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

/// 把发起请求的 frame 交给协议 handler:`RequestFrame`(运行时内部用)与 Tauri ACL 用的
/// [`IpcFrame`]。extension 由浏览器进程填入、不随请求字节传递,页面无法伪造(请求头可以)。
/// CEF 没给出 frame 时记为 [`IpcFrame::Unknown`],只有写了 `frames: "any"` 的 capability 能匹配;
/// 不能留空,Tauri 把缺这个 extension 的请求当主 frame。
fn attach_request_frame(request: &mut HttpRequest<Vec<u8>>, frame: Option<&RequestFrame>) {
    if let Some(frame) = frame {
        pin_file_frame_origin(request, frame);
        request.extensions_mut().insert(frame.clone());
    }
    request
        .extensions_mut()
        .insert(frame.map_or(IpcFrame::Unknown, RequestFrame::ipc_frame));
}

/// `file:` 文档的 `Origin` 是 `null`:Tauri 的 `ipc://` 主通道解析失败后,前端脚本改走
/// `cef-ipc` 回退通道,而回退通道拿不到合法 Origin 时会退到 webview 初始 URL(应用页),
/// 请求就被当成本地来源。这里统一把 `file:` frame 发出的请求的 `Origin` 改写成 frame 自己的
/// URL,两条通道都判成远程 `file:` 来源,由 ACL 按 `remote.urls` 匹配 capability。
/// 其它来源的 `Origin` 头不动。
fn pin_file_frame_origin(request: &mut HttpRequest<Vec<u8>>, frame: &RequestFrame) {
    let Some(url) = frame
        .url
        .as_deref()
        .filter(|url| crate::file_access::is_file_url(url))
    else {
        return;
    };
    if let Ok(value) = http::HeaderValue::from_str(url) {
        request.headers_mut().insert(http::header::ORIGIN, value);
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

    fn frame(url: &str) -> RequestFrame {
        RequestFrame {
            is_main: true,
            url: Some(url.to_string()),
        }
    }

    fn origin_of(request: &HttpRequest<Vec<u8>>) -> Option<&str> {
        request
            .headers()
            .get(http::header::ORIGIN)
            .and_then(|value| value.to_str().ok())
    }

    #[test]
    fn file_frame_origin_is_pinned_to_frame_url() {
        const ENTRY: &str = "file:///D:/wpe/3679122549/index.html";
        // `file:` 文档的 Origin 是字面量 "null"
        let mut request = request_with_origin(Some("null"));
        pin_file_frame_origin(&mut request, &frame(ENTRY));
        assert_eq!(origin_of(&request), Some(ENTRY));
        // 缺 Origin 同样补上
        let mut request = request_with_origin(None);
        pin_file_frame_origin(&mut request, &frame(ENTRY));
        assert_eq!(origin_of(&request), Some(ENTRY));
    }

    #[test]
    fn non_file_frame_origin_is_untouched() {
        let mut request = request_with_origin(Some("http://127.0.0.1:33050"));
        pin_file_frame_origin(&mut request, &frame("http://127.0.0.1:33050/wpe/1/index.html"));
        assert_eq!(origin_of(&request), Some("http://127.0.0.1:33050"));
        // 非 file: frame 缺 Origin 时也不补
        let mut request = request_with_origin(None);
        pin_file_frame_origin(&mut request, &frame("tauri://localhost/"));
        assert_eq!(origin_of(&request), None);
        // frame URL 未知时不动
        let mut request = request_with_origin(Some("null"));
        pin_file_frame_origin(
            &mut request,
            &RequestFrame {
                is_main: true,
                url: None,
            },
        );
        assert_eq!(origin_of(&request), Some("null"));
    }

    fn ipc_frame_of(request: &HttpRequest<Vec<u8>>) -> Option<IpcFrame> {
        request.extensions().get::<IpcFrame>().copied()
    }

    #[test]
    fn request_frame_is_reported_to_tauri_acl() {
        // 主 frame
        let mut request = request_with_origin(Some("tauri://localhost"));
        attach_request_frame(&mut request, Some(&frame("tauri://localhost/")));
        assert_eq!(ipc_frame_of(&request), Some(IpcFrame::Main));
        assert!(request
            .extensions()
            .get::<RequestFrame>()
            .is_some_and(|f| f.is_main));

        // 子 frame
        let mut request = request_with_origin(Some("tauri://localhost"));
        let sub = RequestFrame {
            is_main: false,
            url: Some("tauri://localhost/frame.html".to_string()),
        };
        attach_request_frame(&mut request, Some(&sub));
        assert_eq!(ipc_frame_of(&request), Some(IpcFrame::Sub));
        assert!(request
            .extensions()
            .get::<RequestFrame>()
            .is_some_and(|f| !f.is_main));

        // CEF 没给出 frame:记为 Unknown(不能缺省,缺省会被 Tauri 当成主 frame)
        let mut request = request_with_origin(Some("tauri://localhost"));
        attach_request_frame(&mut request, None);
        assert_eq!(ipc_frame_of(&request), Some(IpcFrame::Unknown));
        assert!(request.extensions().get::<RequestFrame>().is_none());
    }

    #[test]
    fn request_frame_still_pins_file_origin() {
        const ENTRY: &str = "file:///D:/wpe/3679122549/index.html";
        let mut request = request_with_origin(Some("null"));
        attach_request_frame(&mut request, Some(&frame(ENTRY)));
        assert_eq!(origin_of(&request), Some(ENTRY));
        assert_eq!(ipc_frame_of(&request), Some(IpcFrame::Main));
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
