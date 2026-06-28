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

// 全局动态分发 factory:每个 scheme 只注册一个实例,请求期按 browser id 查 label/handler。
wrap_scheme_handler_factory! {
    struct GlobalSchemeHandlerFactory { scheme: String }

    impl SchemeHandlerFactory {
        fn create(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            _request: Option<&mut cef::Request>,
        ) -> Option<ResourceHandler> {
            let id = browser?.identifier();
            let guard = registry().lock().ok()?;
            let entry = guard.get(&id)?;
            let protocol = entry.schemes.get(&self.scheme)?.clone();
            let label = entry.label.clone();
            Some(CefResourceHandler::new(
                label,
                protocol,
                Arc::new(Mutex::new(ResponseState::default())),
            ))
        }
    }
}

wrap_resource_handler! {
    struct CefResourceHandler {
        webview_label: String,
        protocol: Arc<ProtocolHandler>,
        state: Arc<Mutex<ResponseState>>,
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

            let request = match request_to_http(request) {
                Ok(request) => request,
                Err(()) => {
                    self.state.lock().unwrap().response = Some(bad_request());
                    *handle_request = 1;
                    return 1;
                }
            };

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
            // return a synchronous handled result instead. A later response
            // resumes the request via the cloned callback above.
            let response_is_ready = {
                let mut state = self.state.lock().unwrap();
                state.open_in_progress = false;
                state.response.is_some()
            };
            if response_is_ready {
                *handle_request = 1;
                1
            } else {
                0
            }
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

/// 向 CEF 全局注册 `scheme` 的 factory,首次调用才实际注册,重复调用为 no-op。
fn ensure_global_scheme_factory(scheme: &str) -> Result<()> {
    let mut set = registered_schemes().lock().unwrap();
    if set.contains(scheme) {
        return Ok(());
    }
    let mut factory = GlobalSchemeHandlerFactory::new(scheme.to_string());
    let ok = cef::register_scheme_handler_factory(
        Some(&CefString::from(scheme)),
        None,
        Some(&mut factory),
    );
    if ok == 1 {
        set.insert(scheme.to_string());
        Ok(())
    } else {
        Err(Error::CreateWebview(Box::new(std::io::Error::other(
            format!("CEF failed to register global {scheme:?} scheme factory"),
        ))))
    }
}

fn request_to_http(request: &cef::Request) -> std::result::Result<HttpRequest<Vec<u8>>, ()> {
    let cef_method = request.method();
    let method = CefString::from(&cef_method)
        .to_string()
        .parse()
        .map_err(|_| ())?;
    let cef_url = request.url();
    let uri = CefString::from(&cef_url)
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
    fn bad_request_response_is_stable() {
        let response = bad_request();
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        assert_eq!(response.body().as_ref(), b"invalid CEF protocol request");
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
