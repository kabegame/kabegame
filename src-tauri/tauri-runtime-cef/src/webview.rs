//! CEF Views-backed Tauri webviews.

#[cfg(feature = "cef-backend")]
mod imp {
    use std::{rc::Rc, sync::mpsc::channel};

    use cef::{self, *};
    use tauri_runtime::{
        dpi::{PhysicalPosition, PhysicalSize, Rect as RuntimeRect, Size},
        webview::{DetachedWebview, PageLoadEvent, PendingWebview},
        window::{WebviewEvent, WindowId},
        Cookie, Error, Result, UserEvent, WebviewDispatch, WebviewEventId,
    };
    use tauri_utils::config::Color;
    use url::Url;

    use crate::{ipc, protocol, runtime, Cef};

    #[derive(Clone)]
    pub struct CefWebviewDispatcher<T: UserEvent> {
        pub(crate) window_id: WindowId,
        pub(crate) webview_id: runtime::WebviewId,
        pub(crate) context: runtime::CefContext<T>,
    }

    impl<T: UserEvent> std::fmt::Debug for CefWebviewDispatcher<T> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("CefWebviewDispatcher")
                .field("window_id", &self.window_id)
                .field("webview_id", &self.webview_id)
                .finish()
        }
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl<T: UserEvent> Sync for CefWebviewDispatcher<T> {}

    impl<T: UserEvent> WebviewDispatch<T> for CefWebviewDispatcher<T> {
        type Runtime = Cef<T>;

        fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
            self.context.send(runtime::Message::Task(Box::new(f)))
        }

        fn on_webview_event<F: Fn(&WebviewEvent) + Send + 'static>(&self, f: F) -> WebviewEventId {
            let id = self.context.next_webview_event_id();
            let _ = self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::AddEventListener(id, Box::new(f)),
            ));
            id
        }

        fn with_webview<F: FnOnce(Box<dyn std::any::Any>) + Send + 'static>(
            &self,
            f: F,
        ) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::WithWebview(Box::new(f)),
            ))
        }

        fn open_devtools(&self) {
            let _ = self.send(runtime::WebviewMessage::OpenDevTools);
        }
        fn close_devtools(&self) {
            let _ = self.send(runtime::WebviewMessage::CloseDevTools);
        }
        fn is_devtools_open(&self) -> Result<bool> {
            webview_getter(self, runtime::WebviewGetter::DevToolsOpen)
        }
        fn url(&self) -> Result<String> {
            webview_getter(self, runtime::WebviewGetter::Url)
        }
        fn bounds(&self) -> Result<RuntimeRect> {
            Ok(RuntimeRect {
                position: PhysicalPosition::new(0, 0).into(),
                size: self.size()?.into(),
            })
        }
        fn position(&self) -> Result<PhysicalPosition<i32>> {
            Ok(PhysicalPosition::new(0, 0))
        }
        fn size(&self) -> Result<PhysicalSize<u32>> {
            webview_getter(self, runtime::WebviewGetter::Size)
        }
        fn navigate(&self, url: Url) -> Result<()> {
            self.send(runtime::WebviewMessage::Navigate(url.to_string()))
        }
        fn reload(&self) -> Result<()> {
            self.send(runtime::WebviewMessage::Reload)
        }
        fn print(&self) -> Result<()> {
            unsupported()
        }
        fn close(&self) -> Result<()> {
            self.send(runtime::WebviewMessage::Close)
        }
        fn set_bounds(&self, bounds: RuntimeRect) -> Result<()> {
            self.set_size(bounds.size)
        }
        fn set_size(&self, size: Size) -> Result<()> {
            self.send(runtime::WebviewMessage::SetSize(size))
        }
        fn set_position(&self, _: tauri_runtime::dpi::Position) -> Result<()> {
            Ok(())
        }
        fn set_focus(&self) -> Result<()> {
            self.send(runtime::WebviewMessage::SetFocus)
        }
        fn hide(&self) -> Result<()> {
            self.send(runtime::WebviewMessage::SetVisible(false))
        }
        fn show(&self) -> Result<()> {
            self.send(runtime::WebviewMessage::SetVisible(true))
        }
        fn eval_script<S: Into<String>>(&self, script: S) -> Result<()> {
            self.send(runtime::WebviewMessage::Eval(script.into()))
        }
        fn reparent(&self, _: WindowId) -> Result<()> {
            unsupported()
        }
        fn cookies_for_url(&self, _: Url) -> Result<Vec<Cookie<'static>>> {
            Ok(Vec::new())
        }
        fn cookies(&self) -> Result<Vec<Cookie<'static>>> {
            Ok(Vec::new())
        }
        fn set_cookie(&self, _: Cookie<'_>) -> Result<()> {
            Ok(())
        }
        fn delete_cookie(&self, _: Cookie<'_>) -> Result<()> {
            Ok(())
        }
        fn eval_script_with_callback<S: Into<String>>(
            &self,
            script: S,
            callback: impl Fn(String) + Send + 'static,
        ) -> Result<()> {
            self.eval_script(script)?;
            callback(String::new());
            Ok(())
        }
        fn set_auto_resize(&self, auto_resize: bool) -> Result<()> {
            self.send(runtime::WebviewMessage::SetAutoResize(auto_resize))
        }
        fn set_zoom(&self, scale_factor: f64) -> Result<()> {
            self.send(runtime::WebviewMessage::SetZoom(scale_factor))
        }
        fn set_background_color(&self, _: Option<Color>) -> Result<()> {
            Ok(())
        }
        fn clear_all_browsing_data(&self) -> Result<()> {
            Ok(())
        }
    }

    impl<T: UserEvent> CefWebviewDispatcher<T> {
        fn send(&self, message: runtime::WebviewMessage) -> Result<()> {
            self.context
                .send(runtime::Message::Webview(self.webview_id, message))
        }
    }

    fn webview_getter<T: UserEvent, R: Send + 'static>(
        dispatcher: &CefWebviewDispatcher<T>,
        getter: runtime::WebviewGetter<R>,
    ) -> Result<R> {
        let (tx, rx) = channel();
        dispatcher.context.send(runtime::Message::Webview(
            dispatcher.webview_id,
            runtime::WebviewMessage::Get(getter.kind, tx),
        ))?;
        rx.recv()
            .map_err(|_| Error::FailedToReceiveMessage)?
            .and_then(|boxed| {
                boxed
                    .downcast::<R>()
                    .map(|value| *value)
                    .map_err(|_| Error::FailedToReceiveMessage)
            })
    }

    fn unsupported<T>() -> Result<T> {
        Err(Error::CreateWebview(Box::new(std::io::Error::other(
            "operation is not implemented by the CEF runtime yet",
        ))))
    }

    type PageLoadHandler = Rc<Box<dyn Fn(Url, PageLoadEvent) + Send>>;

    wrap_load_handler! {
        pub(crate) struct InitializationLoadHandler {
            scripts: Vec<tauri_runtime::webview::InitializationScript>,
            on_page_load: Option<PageLoadHandler>,
        }
        impl LoadHandler {
            fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition: TransitionType) {
                let Some(frame) = frame else { return };
                let main_frame = frame.is_main() == 1;
                let source_url = CefString::from(&frame.url()).to_string();
                for script in &self.scripts {
                    if !script.for_main_frame_only || main_frame {
                        frame.execute_java_script(Some(&CefString::from(script.script.as_str())), Some(&CefString::from(source_url.as_str())), 0);
                    }
                }
                emit_page_load(frame, &self.on_page_load, PageLoadEvent::Started);
            }
            fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: ::std::os::raw::c_int) {
                if let Some(frame) = frame { emit_page_load(frame, &self.on_page_load, PageLoadEvent::Finished); }
            }
        }
    }

    fn emit_page_load(frame: &Frame, handler: &Option<PageLoadHandler>, event: PageLoadEvent) {
        if frame.is_main() != 1 {
            return;
        }
        let Some(handler) = handler else {
            return;
        };
        if let Ok(url) = Url::parse(&CefString::from(&frame.url()).to_string()) {
            handler(url, event);
        }
    }

    wrap_client! {
        pub(crate) struct ViewsClient { load_handler: LoadHandler, keyboard_handler: KeyboardHandler }
        impl Client {
            fn load_handler(&self) -> Option<LoadHandler> { Some(self.load_handler.clone()) }
            fn keyboard_handler(&self) -> Option<KeyboardHandler> { Some(self.keyboard_handler.clone()) }
        }
    }

    wrap_keyboard_handler! {
        pub(crate) struct DevToolsKeyboardHandler {}
        impl KeyboardHandler {
            fn on_pre_key_event(&self, browser: Option<&mut Browser>, event: Option<&KeyEvent>, _os_event: Option<&mut cef::sys::XEvent>, _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>) -> ::std::os::raw::c_int {
                let Some(event) = event else { return 0 };
                if event.type_ != KeyEventType::RAWKEYDOWN || event.windows_key_code != b'D' as i32 || event.modifiers & (event_flag_control() | event_flag_shift()) != event_flag_control() | event_flag_shift() { return 0; }
                if let Some(host) = browser.and_then(|browser| browser.host()) {
                    host.show_dev_tools(Some(&WindowInfo::default()), None, Some(&BrowserSettings::default()), None);
                    return 1;
                }
                0
            }
        }
    }

    fn event_flag_control() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0
    }
    fn event_flag_shift() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0
    }

    wrap_browser_view_delegate! {
        pub(crate) struct ViewsBrowserViewDelegate {}
        impl ViewDelegate {}
        impl BrowserViewDelegate { fn browser_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::ALLOY } }
    }

    pub(crate) struct CefBrowserView {
        pub(crate) inner: BrowserView,
    }
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefBrowserView {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefBrowserView {}

    pub(crate) struct CefWebviewState {
        pub(crate) label: String,
        pub(crate) browser_view: Option<CefBrowserView>,
        pub(crate) url: String,
        pub(crate) auto_resize: bool,
        pub(crate) visible: bool,
        pub(crate) listeners: crate::window::WebviewListeners,
    }

    impl CefWebviewState {
        pub(crate) fn resolve_browser(&self) -> Option<Browser> {
            self.browser_view
                .as_ref()
                .and_then(|view| view.inner.browser())
        }
    }

    pub(crate) fn create_cef_browser_view<T: UserEvent>(
        window_id: WindowId,
        webview_id: runtime::WebviewId,
        context: runtime::CefContext<T>,
        mut pending: PendingWebview<T, Cef<T>>,
    ) -> Result<(CefWebviewState, BrowserView)> {
        let detached = detached_webview(pending.label.clone(), window_id, webview_id, context);
        let initial_url = pending.url.clone();
        ipc::install_post_message_bridge(&mut pending, detached, initial_url);
        let mut request_context =
            request_context_create_context(Some(&RequestContextSettings::default()), None)
                .ok_or_else(|| {
                    Error::CreateWebview(Box::new(std::io::Error::other(
                        "CEF failed to create a request context",
                    )))
                })?;
        protocol::register_webview_protocols(&mut pending, &mut request_context)?;
        let scripts = std::mem::take(&mut pending.webview_attributes.initialization_scripts);
        let on_page_load = pending.on_page_load_handler.take().map(Rc::new);
        let mut client = ViewsClient::new(
            InitializationLoadHandler::new(scripts, on_page_load),
            DevToolsKeyboardHandler::new(),
        );
        let mut delegate = ViewsBrowserViewDelegate::new();
        let url = pending.url.clone();
        let browser_view = browser_view_create(
            Some(&mut client),
            Some(&CefString::from(url.as_str())),
            Some(&BrowserSettings::default()),
            None,
            Some(&mut request_context),
            Some(&mut delegate),
        )
        .ok_or_else(|| {
            Error::CreateWebview(Box::new(std::io::Error::other(
                "CEF failed to create a BrowserView",
            )))
        })?;
        let state = CefWebviewState {
            label: pending.label,
            browser_view: Some(CefBrowserView {
                inner: browser_view.clone(),
            }),
            url,
            auto_resize: true,
            visible: true,
            listeners: Vec::new(),
        };
        Ok((state, browser_view))
    }

    pub(crate) fn detached_webview<T: UserEvent>(
        label: String,
        window_id: WindowId,
        webview_id: runtime::WebviewId,
        context: runtime::CefContext<T>,
    ) -> DetachedWebview<T, Cef<T>> {
        DetachedWebview {
            label,
            dispatcher: CefWebviewDispatcher {
                window_id,
                webview_id,
                context,
            },
        }
    }
}

#[cfg(feature = "cef-backend")]
pub use imp::*;
