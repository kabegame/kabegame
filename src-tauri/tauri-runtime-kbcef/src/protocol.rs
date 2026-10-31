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
    webview::{IpcFrame, PendingWebview, SubframeId},
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
/// 发起请求的 frame 身份，经请求 extension 交给 Tauri。文档 URL 只从 CEF 补丁 07 的头读取。
#[derive(Debug, Clone)]
pub(crate) struct RequestFrame {
    pub(crate) is_main: bool,
    /// CEF 的 frame 标识，子 frame 用它接收事件、Channel 与回退响应。
    pub(crate) id: Option<String>,
}

impl RequestFrame {
    pub(crate) fn ipc_frame(&self) -> IpcFrame {
        if self.is_main {
            IpcFrame::Main
        } else {
            IpcFrame::Sub
        }
    }

    pub(crate) fn subframe_id(&self) -> Option<SubframeId> {
        if self.is_main {
            return None;
        }
        self.id.as_deref().map(SubframeId::new)
    }
}

/// CEF 0007 写入的私有头。空值表示无法归属；不存在表示 CEF 未带补丁。
pub(crate) const DOCUMENT_URL_HEADER: &str = "Sec-Kabegame-Document-Url";
pub(crate) const PARENT_DOCUMENT_URL_HEADER: &str = "Sec-Kabegame-Parent-Document-Url";
const PRIVATE_HEADER_PREFIX: &str = "sec-kabegame-";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DocumentAttribution {
    pub(crate) patched: bool,
    pub(crate) document: Option<String>,
    pub(crate) parent: Option<String>,
}

impl DocumentAttribution {
    pub(crate) fn of_request(request: &cef::Request) -> Self {
        let mut headers = CefStringMultimap::new();
        request.header_map(Some(&mut headers));
        Self::from_headers(
            headers
                .into_iter()
                .map(|(name, values)| (name, values.into_iter().next().unwrap_or_default())),
        )
    }

    fn from_headers(headers: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut out = Self::default();
        for (name, value) in headers {
            let slot = if name.eq_ignore_ascii_case(DOCUMENT_URL_HEADER) {
                &mut out.document
            } else if name.eq_ignore_ascii_case(PARENT_DOCUMENT_URL_HEADER) {
                &mut out.parent
            } else {
                continue;
            };
            out.patched = true;
            *slot = Some(value).filter(|value| !value.is_empty());
        }
        out
    }
}

/// IPC 主通道与回退通道的逻辑 scheme。
pub(crate) fn ipc_scheme(url: &str) -> Option<&'static str> {
    let (scheme, _) = url.split_once(':')?;
    if scheme.eq_ignore_ascii_case("ipc") {
        Some("ipc")
    } else if scheme.eq_ignore_ascii_case(crate::ipc::CEF_IPC_SCHEME) {
        Some(crate::ipc::CEF_IPC_SCHEME)
    } else {
        None
    }
}

/// 以浏览器给出的 initiator 为来源；仅对 file: 用文档 URL 细化身份。
pub(crate) fn ipc_origin(initiator: &str, doc: &DocumentAttribution) -> String {
    let initiator = initiator.trim();
    if initiator.is_empty() || initiator == "null" {
        return "null".to_string();
    }
    if !crate::file_access::is_file_url(initiator) {
        return initiator.to_string();
    }
    doc.document
        .as_deref()
        .and_then(|document| file_document_origin(initiator, document))
        .unwrap_or_else(|| "null".to_string())
}

fn file_document_origin(initiator: &str, document: &str) -> Option<String> {
    let mut url = url::Url::parse(document).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let initiator_host = initiator.get("file://".len()..).unwrap_or_default();
    if !url
        .host_str()
        .unwrap_or_default()
        .eq_ignore_ascii_case(initiator_host)
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn lookup_protocol(browser_id: i32, scheme: &str) -> Option<(String, Arc<ProtocolHandler>)> {
    let guard = registry().lock().ok()?;
    let entry = guard.get(&browser_id)?;
    Some((entry.label.clone(), entry.schemes.get(scheme)?.clone()))
}

fn request_frame_of(frame: &Frame) -> RequestFrame {
    RequestFrame {
        is_main: frame.is_main() == 1,
        id: Some(CefString::from(&frame.identifier()).to_string()).filter(|id| !id.is_empty()),
    }
}

// IPC 请求由 GetResourceHandler 直接交给 Tauri 协议处理器（不经过全局 scheme factory）。
wrap_resource_request_handler! {
    pub(crate) struct IpcResourceRequestHandler {
        scheme: &'static str,
        origin: String,
    }
    impl ResourceRequestHandler {
        // 必须显式放行：cef-rs 的默认实现返回 `ReturnValue::default()`，即 RV_CANCEL（不是 C++ 的
        // RV_CONTINUE），不实现就会取消每个 IPC 请求，页面只看到 `Failed to fetch`。
        fn on_before_resource_load(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _request: Option<&mut cef::Request>,
            _callback: Option<&mut Callback>,
        ) -> ReturnValue {
            ReturnValue::CONTINUE
        }

        fn resource_handler(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            let (label, protocol) = lookup_protocol(browser?.identifier(), self.scheme)?;
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
                frame.map(|frame| request_frame_of(frame)),
                Some(self.origin.clone()),
            ))
        }
    }
}

/// 未带 0007 的 CEF 遇到需要文档归属的请求时只警告一次。
pub(crate) fn report_missing_document_patch() {
    static REPORTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !REPORTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!("CEF patch 07 missing (no {DOCUMENT_URL_HEADER}): IPC and file: access of file: documents are denied until CEF is rebuilt");
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
            let (label, protocol) = lookup_protocol(browser?.identifier(), &self.logical_scheme)?;
            // 未归属的 IPC 请求经 scheme factory 兜底时失败关闭。
            let ipc_origin = ipc_scheme(&format!("{}:", self.logical_scheme)).map(|scheme| {
                tracing::debug!("unattributed {scheme} request reached the scheme factory");
                "null".to_string()
            });
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
                frame.map(|frame| request_frame_of(frame)),
                ipc_origin,
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
        ipc_origin: Option<String>,
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
            strip_private_headers(&mut request);
            if let Some(origin) = self.ipc_origin.as_deref() {
                set_origin(&mut request, origin);
            }
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

/// 内部归属头不传给 Tauri 或其它协议处理器。
fn strip_private_headers(request: &mut HttpRequest<Vec<u8>>) {
    let names: Vec<_> = request
        .headers()
        .keys()
        .filter(|name| name.as_str().starts_with(PRIVATE_HEADER_PREFIX))
        .cloned()
        .collect();
    for name in names {
        request.headers_mut().remove(name);
    }
}

fn set_origin(request: &mut HttpRequest<Vec<u8>>, origin: &str) {
    let value = http::HeaderValue::from_str(origin)
        .unwrap_or_else(|_| http::HeaderValue::from_static("null"));
    request.headers_mut().insert(http::header::ORIGIN, value);
}

/// frame 位置与子 frame 路由标识由浏览器进程放入 extension，页面无法伪造。
fn attach_request_frame(request: &mut HttpRequest<Vec<u8>>, frame: Option<&RequestFrame>) {
    if let Some(frame) = frame {
        request.extensions_mut().insert(frame.clone());
        if let Some(id) = frame.subframe_id() {
            request.extensions_mut().insert(id);
        }
    }
    request
        .extensions_mut()
        .insert(frame.map_or(IpcFrame::Unknown, RequestFrame::ipc_frame));
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

    #[test]
    fn ipc_scheme_is_recognized() {
        assert_eq!(ipc_scheme("ipc://localhost/cmd"), Some("ipc"));
        assert_eq!(ipc_scheme("CEF-IPC://localhost/"), Some("cef-ipc"));
        assert_eq!(ipc_scheme("tauri://localhost/"), None);
    }

    #[test]
    fn ipc_origin_keeps_initiator_for_non_file_documents() {
        let doc = DocumentAttribution {
            document: Some("file:///D:/wpe/index.html".into()),
            ..Default::default()
        };
        assert_eq!(ipc_origin("tauri://localhost", &doc), "tauri://localhost");
        assert_eq!(
            ipc_origin("https://example.com", &doc),
            "https://example.com"
        );
    }

    #[test]
    fn ipc_origin_identifies_file_documents() {
        let doc = DocumentAttribution {
            document: Some("file:///D:/wpe/1/index.html?x#y".into()),
            ..Default::default()
        };
        assert_eq!(ipc_origin("file://", &doc), "file:///D:/wpe/1/index.html");
    }

    #[test]
    fn ipc_origin_fails_closed() {
        for initiator in ["null", "", "file://"] {
            assert_eq!(
                ipc_origin(initiator, &DocumentAttribution::default()),
                "null"
            );
        }
        for document in ["about:srcdoc", "tauri://localhost/", "file://other/share/a"] {
            let doc = DocumentAttribution {
                document: Some(document.into()),
                ..Default::default()
            };
            assert_eq!(ipc_origin("file://server", &doc), "null");
        }
    }

    #[test]
    fn document_attribution_reads_headers() {
        assert!(!DocumentAttribution::from_headers([]).patched);
        let doc = DocumentAttribution::from_headers([(DOCUMENT_URL_HEADER.into(), String::new())]);
        assert!(doc.patched);
        assert_eq!(doc.document, None);
    }

    #[test]
    fn private_headers_are_stripped_and_origin_set_once() {
        let mut request = request_with_origin(Some("tauri://forged"));
        request.headers_mut().insert(
            DOCUMENT_URL_HEADER,
            http::HeaderValue::from_static("file:///D:/secret"),
        );
        set_origin(&mut request, "null");
        strip_private_headers(&mut request);
        assert_eq!(origin_of(&request), Some("null"));
        assert!(request.headers().get(DOCUMENT_URL_HEADER).is_none());
    }

    #[test]
    fn request_frame_is_reported_to_tauri_acl() {
        let mut request = request_with_origin(None);
        attach_request_frame(
            &mut request,
            Some(&RequestFrame {
                is_main: true,
                id: None,
            }),
        );
        assert_eq!(
            request.extensions().get::<IpcFrame>(),
            Some(&IpcFrame::Main)
        );
        assert!(request.extensions().get::<SubframeId>().is_none());
        let mut request = request_with_origin(None);
        attach_request_frame(
            &mut request,
            Some(&RequestFrame {
                is_main: false,
                id: Some("3-7".into()),
            }),
        );
        assert_eq!(request.extensions().get::<IpcFrame>(), Some(&IpcFrame::Sub));
        assert_eq!(
            request.extensions().get::<SubframeId>(),
            Some(&SubframeId::new("3-7"))
        );
        let mut request = request_with_origin(None);
        attach_request_frame(&mut request, None);
        assert_eq!(
            request.extensions().get::<IpcFrame>(),
            Some(&IpcFrame::Unknown)
        );
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
