//! CEF OSR webview 半边。
//!
//! Phase 3 只实现前端渲染所需的最小表面:创建 windowless CEF browser、
//! 导航、执行脚本、跟随 tao 窗口 resize,以及把 `on_paint` 产出的 BGRA
//! 帧通过 softbuffer 绘制到 tao 顶层窗口。

#[cfg(feature = "cef-backend")]
mod imp {
    use std::{
        cell::Cell,
        num::NonZeroU32,
        rc::Rc,
        sync::{mpsc::channel, Arc},
        time::{Duration, Instant},
    };

    use cef::{self, *};
    use gtk::prelude::{IMContextExt, WidgetExt};
    use tao::{
        event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent as TaoWindowEvent},
        keyboard::{Key, KeyCode, KeyLocation, ModifiersState, NativeKeyCode},
        platform::unix::WindowExtUnix,
        window::{CursorIcon as TaoCursorIcon, Window as TaoWindow},
    };
    use tauri_runtime::webview::PageLoadEvent;
    use tauri_runtime::window::WebviewEvent;
    use tauri_runtime::window::WindowId;
    use tauri_runtime::{
        dpi::{PhysicalPosition, PhysicalSize, Rect as RuntimeRect, Size},
        webview::{DetachedWebview, PendingWebview},
        Cookie, Error, Result, UserEvent, WebviewDispatch, WebviewEventId,
    };
    use tauri_utils::config::Color;
    use url::Url;

    use crate::{ipc, protocol, runtime, Cef};

    /// Tauri webview dispatcher 的 CEF 实现。
    ///
    /// 保存 window/webview id 和 runtime context；所有 CEF browser 操作都通过
    /// runtime 消息回到主线程执行。
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

        /// 把任务转发到 runtime 主线程执行。
        fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
            self.context.send(runtime::Message::Task(Box::new(f)))
        }

        /// 注册 webview 事件监听器。
        ///
        /// Phase 3 暂时只保留监听器表,后续输入/加载/IPC 事件接入时复用。
        fn on_webview_event<F: Fn(&WebviewEvent) + Send + 'static>(&self, f: F) -> WebviewEventId {
            let id = self.context.next_webview_event_id();
            let _ = self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::AddEventListener(id, Box::new(f)),
            ));
            id
        }

        /// 运行一个拿到平台 webview 对象的回调。
        ///
        /// CEF OSR 当前没有稳定暴露给上层的原生 webview 对象,所以 Phase 3
        /// 传入占位对象；后续如果需要暴露 browser/host,应在这里收敛接口。
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
            let _ = self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::OpenDevTools,
            ));
        }

        fn close_devtools(&self) {
            let _ = self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::CloseDevTools,
            ));
        }

        fn is_devtools_open(&self) -> Result<bool> {
            webview_getter(self, runtime::WebviewGetter::DevToolsOpen)
        }

        fn url(&self) -> Result<String> {
            webview_getter(self, runtime::WebviewGetter::Url)
        }

        fn bounds(&self) -> Result<RuntimeRect> {
            let size = self.size()?;
            Ok(RuntimeRect {
                position: PhysicalPosition::new(0, 0).into(),
                size: size.into(),
            })
        }

        fn position(&self) -> Result<PhysicalPosition<i32>> {
            Ok(PhysicalPosition::new(0, 0))
        }

        fn size(&self) -> Result<PhysicalSize<u32>> {
            webview_getter(self, runtime::WebviewGetter::Size)
        }

        fn navigate(&self, url: Url) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::Navigate(url.to_string()),
            ))
        }

        fn reload(&self) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::Reload,
            ))
        }

        fn print(&self) -> Result<()> {
            unsupported()
        }

        fn close(&self) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::Close,
            ))
        }

        fn set_bounds(&self, bounds: RuntimeRect) -> Result<()> {
            self.set_size(bounds.size)
        }

        fn set_size(&self, size: Size) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetSize(size),
            ))
        }

        fn set_position(&self, _position: tauri_runtime::dpi::Position) -> Result<()> {
            Ok(())
        }

        fn set_focus(&self) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetFocus,
            ))
        }

        fn hide(&self) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetVisible(false),
            ))
        }

        fn show(&self) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetVisible(true),
            ))
        }

        fn eval_script<S: Into<String>>(&self, script: S) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::Eval(script.into()),
            ))
        }

        fn reparent(&self, _window_id: WindowId) -> Result<()> {
            unsupported()
        }

        fn cookies_for_url(&self, _url: Url) -> Result<Vec<Cookie<'static>>> {
            Ok(Vec::new())
        }

        fn cookies(&self) -> Result<Vec<Cookie<'static>>> {
            Ok(Vec::new())
        }

        fn set_cookie(&self, _cookie: Cookie<'_>) -> Result<()> {
            Ok(())
        }

        fn delete_cookie(&self, _cookie: Cookie<'_>) -> Result<()> {
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
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetAutoResize(auto_resize),
            ))
        }

        fn set_zoom(&self, scale_factor: f64) -> Result<()> {
            self.context.send(runtime::Message::Webview(
                self.webview_id,
                runtime::WebviewMessage::SetZoom(scale_factor),
            ))
        }

        fn set_background_color(&self, _color: Option<Color>) -> Result<()> {
            Ok(())
        }

        fn clear_all_browsing_data(&self) -> Result<()> {
            Ok(())
        }
    }

    /// 执行同步 webview getter。
    ///
    /// 请求进入 runtime 主线程后返回 `Any` 装箱值,这里按类型参数 `R`
    /// downcast 为具体返回类型。
    fn webview_getter<T: UserEvent, R: Send + 'static>(
        dispatcher: &CefWebviewDispatcher<T>,
        getter: runtime::WebviewGetter<R>,
    ) -> Result<R> {
        let (tx, rx) = channel();
        dispatcher.context.send(runtime::Message::Webview(
            dispatcher.webview_id,
            runtime::WebviewMessage::Get(getter.kind, tx),
        ))?;
        let boxed = rx.recv().map_err(|_| Error::FailedToReceiveMessage)??;
        boxed
            .downcast::<R>()
            .map(|v| *v)
            .map_err(|_| Error::FailedToReceiveMessage)
    }

    /// 返回一个明确的“当前 CEF runtime 尚未实现”错误。
    ///
    /// 用于 Phase 3 暂未接入的打印、reparent 等 webview 能力。
    fn unsupported<T>() -> Result<T> {
        Err(Error::CreateWebview(Box::new(std::io::Error::other(
            "operation is not implemented by the CEF runtime yet",
        ))))
    }

    /// CEF `on_paint` 输出的最近一帧像素。
    ///
    /// CEF OSR 软件渲染输出 BGRA 字节序；`blit` 时会转换为 softbuffer 期望的
    /// `0x00RRGGBB`。
    #[derive(Default)]
    pub(crate) struct FrameBuf {
        pub(crate) w: i32,
        pub(crate) h: i32,
        pub(crate) bgra: Vec<u8>,
    }

    /// 一个 OSR webview 的共享渲染状态。
    ///
    /// CEF external pump、tao event loop 和 `on_paint` 都在同一主线程执行,
    /// 因此这里使用 `Rc<RefCell>`/`Cell` 而不是跨线程锁。
    #[derive(Clone)]
    pub(crate) struct OsrState {
        pub(crate) size: Rc<std::cell::RefCell<(i32, i32)>>,
        pub(crate) scale_factor: Rc<Cell<f32>>,
        pub(crate) frame: Rc<std::cell::RefCell<FrameBuf>>,
        pub(crate) dirty: Rc<Cell<bool>>,
    }

    impl OsrState {
        /// 创建指定初始视口大小的 OSR 状态。
        pub(crate) fn new(w: i32, h: i32, scale_factor: f32) -> Self {
            Self {
                size: Rc::new(std::cell::RefCell::new((w, h))),
                scale_factor: Rc::new(Cell::new(scale_factor.max(1.0))),
                frame: Rc::new(std::cell::RefCell::new(FrameBuf::default())),
                dirty: Rc::new(Cell::new(false)),
            }
        }
    }

    // CEF OSR 渲染回调。
    //
    // `view_rect` 告诉 CEF 当前逻辑视口大小；`on_paint` 接收 CEF 光栅化后的
    // BGRA 帧并标记 dirty,等待 tao 循环末尾 blit。
    wrap_render_handler! {
        pub(crate) struct OsrRenderHandler {
            osr: OsrState,
        }
        impl RenderHandler {
            fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut cef::Rect>) {
                if let Some(rect) = rect {
                    let (w, h) = *self.osr.size.borrow();
                    let scale = self.osr.scale_factor.get().max(1.0);
                    rect.x = 0;
                    rect.y = 0;
                    rect.width = ((w as f32 / scale).ceil() as i32).max(1);
                    rect.height = ((h as f32 / scale).ceil() as i32).max(1);
                }
            }

            fn screen_info(
                &self,
                _browser: Option<&mut Browser>,
                screen_info: Option<&mut ScreenInfo>,
            ) -> ::std::os::raw::c_int {
                let Some(screen_info) = screen_info else { return 0 };
                let (w, h) = *self.osr.size.borrow();
                let scale = self.osr.scale_factor.get().max(1.0);
                let rect = cef::Rect {
                    x: 0,
                    y: 0,
                    width: ((w as f32 / scale).ceil() as i32).max(1),
                    height: ((h as f32 / scale).ceil() as i32).max(1),
                };
                screen_info.device_scale_factor = scale;
                screen_info.depth = 24;
                screen_info.depth_per_component = 8;
                screen_info.is_monochrome = 0;
                screen_info.rect = rect.clone();
                screen_info.available_rect = rect;
                1
            }

            fn on_paint(
                &self,
                _browser: Option<&mut Browser>,
                _type_: PaintElementType,
                _dirty_rects: Option<&[Rect]>,
                buffer: *const u8,
                width: ::std::os::raw::c_int,
                height: ::std::os::raw::c_int,
            ) {
                if buffer.is_null() || width <= 0 || height <= 0 {
                    return;
                }
                let n = (width * height * 4) as usize;
                let slice = unsafe { std::slice::from_raw_parts(buffer, n) };
                let mut frame = self.osr.frame.borrow_mut();
                frame.w = width;
                frame.h = height;
                frame.bgra.clear();
                frame.bgra.extend_from_slice(slice);
                self.osr.dirty.set(true);
            }
        }
    }

    wrap_display_handler! {
        pub(crate) struct OsrDisplayHandler {
            window: Arc<TaoWindow>,
        }
        impl DisplayHandler {
            fn on_cursor_change(
                &self,
                _browser: Option<&mut Browser>,
                _cursor: ::std::os::raw::c_ulong,
                type_: CursorType,
                _custom_cursor_info: Option<&CursorInfo>,
            ) -> ::std::os::raw::c_int {
                if type_ == CursorType::NONE {
                    self.window.set_cursor_visible(false);
                } else {
                    self.window.set_cursor_visible(true);
                    self.window.set_cursor_icon(to_tao_cursor(type_));
                }
                1
            }
        }
    }

    type PageLoadHandler = Rc<Box<dyn Fn(Url, PageLoadEvent) + Send>>;

    // Browser-process injection used for Phase 3.1. CEF invokes this callback
    // for each frame navigation; main-frame-only scripts retain Tauri's
    // `InitializationScript` semantics. The same load hooks also forward
    // Tauri's page-load lifecycle so global/plugin hooks run under CEF.
    wrap_load_handler! {
        pub(crate) struct InitializationLoadHandler {
            scripts: Vec<tauri_runtime::webview::InitializationScript>,
            on_page_load: Option<PageLoadHandler>,
        }
        impl LoadHandler {
            fn on_load_start(
                &self,
                _browser: Option<&mut Browser>,
                frame: Option<&mut Frame>,
                _transition_type: TransitionType,
            ) {
                let Some(frame) = frame else { return };
                let is_main = frame.is_main() == 1;
                let cef_source_url = frame.url();
                let source_url = CefString::from(&cef_source_url).to_string();
                for script in &self.scripts {
                    if script.for_main_frame_only && !is_main {
                        continue;
                    }
                    frame.execute_java_script(
                        Some(&CefString::from(script.script.as_str())),
                        Some(&CefString::from(source_url.as_str())),
                        0,
                    );
                }
                emit_page_load(frame, &self.on_page_load, PageLoadEvent::Started);
            }

            fn on_load_end(
                &self,
                _browser: Option<&mut Browser>,
                frame: Option<&mut Frame>,
                _http_status_code: ::std::os::raw::c_int,
            ) {
                let Some(frame) = frame else { return };
                emit_page_load(frame, &self.on_page_load, PageLoadEvent::Finished);
            }
        }
    }

    fn emit_page_load(frame: &Frame, on_page_load: &Option<PageLoadHandler>, event: PageLoadEvent) {
        if frame.is_main() != 1 {
            return;
        }
        let Some(on_page_load) = on_page_load else {
            return;
        };
        let cef_url = frame.url();
        let url = CefString::from(&cef_url).to_string();
        let Ok(url) = Url::parse(&url) else {
            return;
        };
        on_page_load(url, event);
    }

    // 挂载 `OsrRenderHandler` 的 CEF client。
    //
    // windowless browser 必须通过 client 返回 render handler,否则不会触发
    // OSR paint 回调。
    wrap_client! {
        pub(crate) struct OsrClient {
            render_handler: RenderHandler,
            load_handler: LoadHandler,
            display_handler: DisplayHandler,
        }
        impl Client {
            fn render_handler(&self) -> Option<RenderHandler> {
                Some(self.render_handler.clone())
            }

            fn load_handler(&self) -> Option<LoadHandler> {
                Some(self.load_handler.clone())
            }

            fn display_handler(&self) -> Option<DisplayHandler> {
                Some(self.display_handler.clone())
            }
        }
    }

    // Windowed/Views browser client. Unlike OSR this does not expose a
    // RenderHandler; CEF owns the native view and GPU composition.
    wrap_client! {
        pub(crate) struct ViewsClient {
            load_handler: LoadHandler,
        }
        impl Client {
            fn load_handler(&self) -> Option<LoadHandler> {
                Some(self.load_handler.clone())
            }
        }
    }

    wrap_browser_view_delegate! {
        pub(crate) struct ViewsBrowserViewDelegate {}

        impl ViewDelegate {}

        impl BrowserViewDelegate {
            fn browser_runtime_style(&self) -> RuntimeStyle {
                RuntimeStyle::ALLOY
            }
        }
    }

    /// CEF browser wrapper。
    ///
    /// cef-rs browser 类型不是普通 `Send/Sync` 类型；本 runtime 保证它只在主线程
    /// 使用,wrapper 仅用于满足 Tauri dispatcher/状态容器的类型边界。
    pub(crate) struct CefBrowser {
        pub(crate) inner: Browser,
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefBrowser {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefBrowser {}

    pub(crate) struct CefBrowserView {
        pub(crate) inner: BrowserView,
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefBrowserView {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefBrowserView {}

    /// 单个 CEF webview 的运行期状态。
    ///
    /// 包含 CEF browser、OSR frame buffer、当前 URL、自动 resize 标记和事件
    /// 监听器列表。
    pub(crate) struct CefWebviewState {
        pub(crate) label: String,
        /// OSR 用 `browser_host_create_browser_sync` 同步创建,此处为 `Some`。
        /// windowed(CEF Views `BrowserView`)的 browser 是**异步**创建的
        /// (要等 view 挂窗+显示后经 `on_after_created` 才有),创建时为 `None`,
        /// 通过 [`CefWebviewState::resolve_browser`] 延迟从 `browser_view` 解析。
        pub(crate) browser: Option<CefBrowser>,
        pub(crate) browser_view: Option<CefBrowserView>,
        pub(crate) osr: Option<OsrState>,
        pub(crate) url: String,
        pub(crate) auto_resize: bool,
        pub(crate) visible: bool,
        pub(crate) listeners: crate::window::WebviewListeners,
        input: InputState,
        /// 每个 webview 持久化一个 softbuffer surface(参考 wry 的"每窗口复用绘制上下文")。
        /// 之前每帧 `Context::new` 都新开一个 X11 连接且不释放,连续重绘几百帧后即
        /// `Maximum number of clients reached` 崩溃。这里只在首帧创建、之后复用。
        surface: std::cell::RefCell<Option<softbuffer::Surface<Arc<TaoWindow>, Arc<TaoWindow>>>>,
    }

    impl CefWebviewState {
        /// 解析当前 browser:OSR 直接用同步创建的;windowed 延迟从 `browser_view`
        /// 取(异步创建,首次可能为 `None`,挂窗显示后即可用)。
        pub(crate) fn resolve_browser(&self) -> Option<Browser> {
            if let Some(browser) = &self.browser {
                return Some(browser.inner.clone());
            }
            self.browser_view
                .as_ref()
                .and_then(|view| view.inner.browser())
        }
    }

    #[derive(Default)]
    struct InputState {
        cursor: (i32, i32),
        modifiers: ModifiersState,
        mouse_buttons: u32,
        last_click: Option<ClickState>,
        active_click_count: i32,
        native_ime: Option<NativeIme>,
    }

    struct ClickState {
        button: MouseButton,
        position: (i32, i32),
        at: Instant,
        count: i32,
    }

    struct NativeIme {
        context: gtk::IMMulticontext,
        pending: Rc<std::cell::RefCell<Vec<PendingImeEvent>>>,
    }

    enum PendingImeEvent {
        Preedit { text: String, cursor: u32 },
        Commit(String),
    }

    /// 在指定 tao 窗口上创建 CEF windowless browser。
    ///
    /// 这里不会创建原生 CEF 子窗口；`WindowInfo.windowless_rendering_enabled = 1`
    /// 后,Cef 会把页面绘制到 `OsrRenderHandler::on_paint` 提供的内存帧。
    pub(crate) fn create_cef_webview<T: UserEvent>(
        window: &Arc<TaoWindow>,
        window_id: WindowId,
        webview_id: runtime::WebviewId,
        context: runtime::CefContext<T>,
        mut pending: PendingWebview<T, Cef<T>>,
    ) -> Result<CefWebviewState> {
        let init = window.inner_size();
        let osr = OsrState::new(
            init.width as i32,
            init.height as i32,
            window.scale_factor() as f32,
        );

        let window_info = WindowInfo {
            windowless_rendering_enabled: 1,
            ..Default::default()
        };
        let protocol_keys = pending
            .uri_scheme_protocols
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        eprintln!(
            "[cef-runtime] webview '{}' IPC state: protocols={protocol_keys:?}, ipc_handler={}",
            pending.label,
            pending.ipc_handler.is_some()
        );
        let detached = detached_webview(pending.label.clone(), window_id, webview_id, context);
        let initial_url = pending.url.clone();
        ipc::install_post_message_bridge(&mut pending, detached, initial_url);
        eprintln!("[cef-runtime] registering webview protocols");
        // Per-webview RequestContext so each webview's scheme factories (and thus
        // the webview label used for Tauri IPC/ACL) stay isolated. Global
        // registration would let the last webview's label clobber the others.
        let mut request_context =
            request_context_create_context(Some(&RequestContextSettings::default()), None)
                .ok_or_else(|| {
                    Error::CreateWebview(Box::new(std::io::Error::other(
                        "CEF failed to create a request context",
                    )))
                })?;
        protocol::register_webview_protocols(&mut pending, &mut request_context)?;
        eprintln!(
            "[cef-runtime] creating windowless browser for {}",
            pending.url
        );
        let scripts = std::mem::take(&mut pending.webview_attributes.initialization_scripts);
        let on_page_load = pending.on_page_load_handler.take().map(Rc::new);
        let mut client = OsrClient::new(
            OsrRenderHandler::new(osr.clone()),
            InitializationLoadHandler::new(scripts, on_page_load),
            OsrDisplayHandler::new(window.clone()),
        );
        let url = pending.url.clone();
        let browser = browser_host_create_browser_sync(
            Some(&window_info),
            Some(&mut client),
            Some(&CefString::from(url.as_str())),
            Some(&BrowserSettings::default()),
            None,
            Some(&mut request_context),
        )
        .ok_or_else(|| {
            Error::CreateWebview(Box::new(std::io::Error::other(
                "CEF failed to create a windowless browser",
            )))
        })?;
        eprintln!("[cef-runtime] windowless browser created");
        if browser.is_valid() != 1 {
            return Err(Error::CreateWebview(Box::new(std::io::Error::other(
                "CEF created an invalid browser",
            ))));
        }

        let native_ime = install_native_ime(window);
        Ok(CefWebviewState {
            label: pending.label,
            browser: Some(CefBrowser { inner: browser }),
            browser_view: None,
            osr: Some(osr),
            url,
            auto_resize: true,
            visible: true,
            listeners: Vec::new(),
            input: InputState {
                native_ime,
                ..Default::default()
            },
            surface: std::cell::RefCell::new(None),
        })
    }

    /// Create a CEF Views BrowserView for windowed mode.
    ///
    /// This keeps the Phase 3/4 protocol, IPC and init-script path, but skips
    /// OSR-only render/display/input handlers.
    pub(crate) fn create_cef_browser_view<T: UserEvent>(
        window_id: WindowId,
        webview_id: runtime::WebviewId,
        context: runtime::CefContext<T>,
        mut pending: PendingWebview<T, Cef<T>>,
    ) -> Result<(CefWebviewState, BrowserView)> {
        let protocol_keys = pending
            .uri_scheme_protocols
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        eprintln!(
            "[cef-runtime] windowed webview '{}' IPC state: protocols={protocol_keys:?}, ipc_handler={}",
            pending.label,
            pending.ipc_handler.is_some()
        );
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
        let mut client = ViewsClient::new(InitializationLoadHandler::new(scripts, on_page_load));
        let mut browser_view_delegate = ViewsBrowserViewDelegate::new();
        let url = pending.url.clone();
        let browser_view = browser_view_create(
            Some(&mut client),
            Some(&CefString::from(url.as_str())),
            Some(&BrowserSettings::default()),
            None,
            Some(&mut request_context),
            Some(&mut browser_view_delegate),
        )
        .ok_or_else(|| {
            Error::CreateWebview(Box::new(std::io::Error::other(
                "CEF failed to create a BrowserView",
            )))
        })?;
        // NB: BrowserView 的 browser 是异步创建的(挂窗+显示后经 on_after_created
        // 才有),这里不能同步取,否则必为 None。延迟由 resolve_browser() 从
        // browser_view 解析。
        let state = CefWebviewState {
            label: pending.label,
            browser: None,
            browser_view: Some(CefBrowserView {
                inner: browser_view.clone(),
            }),
            osr: None,
            url,
            auto_resize: true,
            visible: true,
            listeners: Vec::new(),
            input: InputState::default(),
            surface: std::cell::RefCell::new(None),
        };
        Ok((state, browser_view))
    }

    /// 构造返回给 Tauri 的 detached webview。
    ///
    /// Tauri 只持有 dispatcher；后续操作通过 dispatcher 的 id 回到 runtime 状态表。
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

    /// 更新 OSR 视口大小,并通知 CEF 重新布局/重绘。
    pub(crate) fn resize_webview(
        webview: &CefWebviewState,
        width: u32,
        height: u32,
        scale_factor: f64,
    ) {
        if let Some(osr) = &webview.osr {
            *osr.size.borrow_mut() = (width as i32, height as i32);
            osr.scale_factor.set((scale_factor as f32).max(1.0));
            if let Some(host) = webview.resolve_browser().and_then(|b| b.host()) {
                host.notify_screen_info_changed();
                host.was_resized();
            }
        } else if let Some(browser_view) = &webview.browser_view {
            browser_view.inner.set_size(Some(&cef::Size {
                width: width as i32,
                height: height as i32,
            }));
        }
    }

    /// Forward one tao window input event to a windowless CEF browser.
    pub(crate) fn handle_window_input(
        webview: &mut CefWebviewState,
        event: &TaoWindowEvent<'_>,
        scale_factor: f64,
    ) {
        let Some(host) = webview.resolve_browser().and_then(|b| b.host()) else {
            return;
        };
        match event {
            TaoWindowEvent::ModifiersChanged(modifiers) => {
                if modifiers.is_empty() {
                    webview.input.modifiers = ModifiersState::empty();
                } else {
                    webview.input.modifiers.insert(*modifiers);
                }
            }
            TaoWindowEvent::CursorMoved { position, .. } => {
                webview.input.cursor = (
                    (position.x / scale_factor).round() as i32,
                    (position.y / scale_factor).round() as i32,
                );
                let event = mouse_event(&webview.input);
                host.send_mouse_move_event(Some(&event), 0);
            }
            TaoWindowEvent::CursorEntered { .. } => {
                let event = mouse_event(&webview.input);
                host.send_mouse_move_event(Some(&event), 0);
            }
            TaoWindowEvent::CursorLeft { .. } => {
                let event = mouse_event(&webview.input);
                host.send_mouse_move_event(Some(&event), 1);
            }
            TaoWindowEvent::MouseInput { state, button, .. } => {
                let Some((cef_button, button_flag)) = mouse_button(*button) else {
                    return;
                };
                let mouse_up = *state == ElementState::Released;
                if mouse_up {
                    webview.input.mouse_buttons &= !button_flag;
                } else {
                    // GTK 把双击/三击额外发 GDK_2BUTTON_PRESS / GDK_3BUTTON_PRESS,
                    // tao 把它们当成**重复的 Pressed**(中间没有 Release)转发。直接
                    // 转给 CEF 会把序列搞成 down(2)→down(3)→up,导致 DOM dblclick 不
                    // 触发。按钮已按下时跳过这种合成重复按下:每个"真实按下"(在一次
                    // Release 之后)才递增 click count,CEF 依据真实按下的 clickCount
                    // 自行判定双击/三击。
                    if webview.input.mouse_buttons & button_flag != 0 {
                        return;
                    }
                    webview.input.mouse_buttons |= button_flag;
                    webview.input.active_click_count = click_count(&mut webview.input, *button);
                }
                let event = mouse_event(&webview.input);
                eprintln!(
                    "[dc-diag] click btn={button:?} {} count={} cursor={:?}",
                    if mouse_up { "UP" } else { "DOWN" },
                    webview.input.active_click_count.max(1),
                    webview.input.cursor
                );
                host.send_mouse_click_event(
                    Some(&event),
                    cef_button,
                    i32::from(mouse_up),
                    webview.input.active_click_count.max(1),
                );
            }
            TaoWindowEvent::MouseWheel { delta, .. } => {
                let (delta_x, delta_y) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => {
                        ((*x * 120.0).round() as i32, (*y * 120.0).round() as i32)
                    }
                    MouseScrollDelta::PixelDelta(position) => (
                        (position.x / scale_factor).round() as i32,
                        (position.y / scale_factor).round() as i32,
                    ),
                    _ => return,
                };
                let event = mouse_event(&webview.input);
                host.send_mouse_wheel_event(Some(&event), delta_x, delta_y);
            }
            TaoWindowEvent::KeyboardInput { event, .. } => {
                // Ctrl+Shift+D → 打开 DevTools(独立原生窗口)。OSR 下前端无法用
                // 右键菜单/F12 唤起,这里给一个不依赖页面状态的硬快捷键。
                let m = webview.input.modifiers;
                if event.state == ElementState::Pressed
                    && m.control_key()
                    && m.shift_key()
                    && event.physical_key == KeyCode::KeyD
                {
                    host.show_dev_tools(
                        Some(&WindowInfo::default()),
                        None,
                        Some(&BrowserSettings::default()),
                        None,
                    );
                    return;
                }
                send_key_input(&host, event, webview.input.modifiers);
            }
            TaoWindowEvent::ReceivedImeText(text) => {
                // tao 0.35 Linux uses IMContextSimple and cannot expose real
                // preedit state. Prefer the IMMulticontext queue installed by
                // this backend; keep this event as a non-GTK fallback.
                if webview.input.native_ime.is_none() {
                    send_committed_text(&host, text, webview.input.modifiers);
                }
            }
            TaoWindowEvent::Focused(focused) => {
                host.set_focus(i32::from(*focused));
                if let Some(ime) = &webview.input.native_ime {
                    if *focused {
                        ime.context.focus_in();
                    } else {
                        ime.context.focus_out();
                        ime.context.reset();
                    }
                }
                if !*focused {
                    host.ime_cancel_composition();
                    webview.input.mouse_buttons = 0;
                }
            }
            _ => {}
        }
        flush_native_ime(&host, &webview.input);
    }

    fn install_native_ime(window: &Arc<TaoWindow>) -> Option<NativeIme> {
        let gtk_window = window.gtk_window();
        let client_window = gtk_window.window()?;
        let context = gtk::IMMulticontext::new();
        context.set_client_window(Some(&client_window));
        context.focus_in();

        let pending = Rc::new(std::cell::RefCell::new(Vec::new()));
        let pending_commit = pending.clone();
        context.connect_commit(move |_, text| {
            pending_commit
                .borrow_mut()
                .push(PendingImeEvent::Commit(text.to_string()));
        });

        let pending_preedit = pending.clone();
        context.connect_preedit_changed(move |context| {
            let (text, _, cursor) = context.preedit_string();
            let text = text.to_string();
            let cursor = text
                .chars()
                .take(cursor.max(0) as usize)
                .map(char::len_utf16)
                .sum::<usize>() as u32;
            pending_preedit
                .borrow_mut()
                .push(PendingImeEvent::Preedit { text, cursor });
        });

        let key_context = context.clone();
        gtk_window.connect_key_press_event(move |_, event| {
            if key_context.filter_keypress(event) {
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });

        Some(NativeIme { context, pending })
    }

    fn flush_native_ime(host: &BrowserHost, input: &InputState) {
        let Some(ime) = &input.native_ime else { return };
        for event in ime.pending.borrow_mut().drain(..) {
            match event {
                PendingImeEvent::Preedit { text, cursor } => {
                    let length = text.encode_utf16().count() as u32;
                    if length == 0 {
                        host.ime_cancel_composition();
                        continue;
                    }
                    let underline = CompositionUnderline {
                        range: cef::Range {
                            from: 0,
                            to: length,
                        },
                        color: 0xFF000000,
                        background_color: 0,
                        style: CompositionUnderlineStyle::SOLID,
                        ..Default::default()
                    };
                    let selection = cef::Range {
                        from: cursor.min(length),
                        to: cursor.min(length),
                    };
                    host.ime_set_composition(
                        Some(&CefString::from(text.as_str())),
                        Some(&[underline]),
                        None,
                        Some(&selection),
                    );
                }
                PendingImeEvent::Commit(text) => {
                    send_committed_text(host, &text, input.modifiers);
                }
            }
        }
    }

    fn mouse_event(input: &InputState) -> cef::MouseEvent {
        cef::MouseEvent {
            x: input.cursor.0,
            y: input.cursor.1,
            modifiers: cef_modifiers(input.modifiers) | input.mouse_buttons,
        }
    }

    fn mouse_button(button: MouseButton) -> Option<(MouseButtonType, u32)> {
        Some(match button {
            MouseButton::Left => (MouseButtonType::LEFT, event_flag_left_mouse()),
            MouseButton::Middle => (MouseButtonType::MIDDLE, event_flag_middle_mouse()),
            MouseButton::Right => (MouseButtonType::RIGHT, event_flag_right_mouse()),
            _ => return None,
        })
    }

    fn click_count(input: &mut InputState, button: MouseButton) -> i32 {
        const MAX_DELAY: Duration = Duration::from_millis(500);
        const MAX_DISTANCE: i32 = 4;
        let now = Instant::now();
        let count = input
            .last_click
            .as_ref()
            .filter(|last| {
                last.button == button
                    && now.duration_since(last.at) <= MAX_DELAY
                    && (last.position.0 - input.cursor.0).abs() <= MAX_DISTANCE
                    && (last.position.1 - input.cursor.1).abs() <= MAX_DISTANCE
            })
            .map_or(1, |last| (last.count + 1).min(3));
        input.last_click = Some(ClickState {
            button,
            position: input.cursor,
            at: now,
            count,
        });
        count
    }

    fn send_key_input(host: &BrowserHost, event: &tao::event::KeyEvent, modifiers: ModifiersState) {
        let windows_key_code = windows_key_code(event);
        let character = event
            .text
            .and_then(|text| text.encode_utf16().next())
            .unwrap_or_default();
        let unmodified_character = match event.key_without_modifiers() {
            Key::Character(text) => text.encode_utf16().next().unwrap_or_default(),
            _ => 0,
        };
        let mut flags = cef_modifiers(modifiers) | key_location_flags(event.location);
        if event.repeat {
            flags |= event_flag_repeat();
        }
        let cef_event = cef::KeyEvent {
            type_: if event.state == ElementState::Pressed {
                KeyEventType::RAWKEYDOWN
            } else {
                KeyEventType::KEYUP
            },
            modifiers: flags,
            windows_key_code,
            native_key_code: native_key_code(event.physical_key, windows_key_code),
            is_system_key: i32::from(modifiers.alt_key()),
            character,
            unmodified_character,
            ..Default::default()
        };
        host.send_key_event(Some(&cef_event));
    }

    fn send_committed_text(host: &BrowserHost, text: &str, modifiers: ModifiersState) {
        if text.is_ascii() {
            for character in text.encode_utf16() {
                let event = cef::KeyEvent {
                    type_: KeyEventType::CHAR,
                    modifiers: cef_modifiers(modifiers),
                    windows_key_code: character as i32,
                    character,
                    unmodified_character: character,
                    ..Default::default()
                };
                host.send_key_event(Some(&event));
            }
        } else {
            host.ime_commit_text(Some(&CefString::from(text)), None, 0);
        }
    }

    fn cef_modifiers(modifiers: ModifiersState) -> u32 {
        let mut flags = 0;
        if modifiers.shift_key() {
            flags |= event_flag_shift();
        }
        if modifiers.control_key() {
            flags |= event_flag_control();
        }
        if modifiers.alt_key() {
            flags |= event_flag_alt();
        }
        if modifiers.super_key() {
            flags |= event_flag_command();
        }
        flags
    }

    fn key_location_flags(location: KeyLocation) -> u32 {
        match location {
            KeyLocation::Left => event_flag_is_left(),
            KeyLocation::Right => event_flag_is_right(),
            KeyLocation::Numpad => event_flag_is_keypad(),
            KeyLocation::Standard => 0,
            _ => 0,
        }
    }

    fn native_key_code(key: KeyCode, fallback: i32) -> i32 {
        match key {
            KeyCode::Unidentified(NativeKeyCode::Gtk(code)) => code as i32,
            _ => fallback,
        }
    }

    fn windows_key_code(event: &tao::event::KeyEvent) -> i32 {
        if let Key::Character(text) = &event.logical_key {
            if let Some(character) = text.chars().next().filter(|_| text.chars().count() == 1) {
                if character.is_ascii_alphanumeric() {
                    return character.to_ascii_uppercase() as i32;
                }
            }
        }
        physical_windows_key_code(event.physical_key)
    }

    #[allow(clippy::match_same_arms)]
    fn physical_windows_key_code(key: KeyCode) -> i32 {
        use KeyCode::*;
        match key {
            Digit0 => 0x30,
            Digit1 => 0x31,
            Digit2 => 0x32,
            Digit3 => 0x33,
            Digit4 => 0x34,
            Digit5 => 0x35,
            Digit6 => 0x36,
            Digit7 => 0x37,
            Digit8 => 0x38,
            Digit9 => 0x39,
            KeyA => 0x41,
            KeyB => 0x42,
            KeyC => 0x43,
            KeyD => 0x44,
            KeyE => 0x45,
            KeyF => 0x46,
            KeyG => 0x47,
            KeyH => 0x48,
            KeyI => 0x49,
            KeyJ => 0x4A,
            KeyK => 0x4B,
            KeyL => 0x4C,
            KeyM => 0x4D,
            KeyN => 0x4E,
            KeyO => 0x4F,
            KeyP => 0x50,
            KeyQ => 0x51,
            KeyR => 0x52,
            KeyS => 0x53,
            KeyT => 0x54,
            KeyU => 0x55,
            KeyV => 0x56,
            KeyW => 0x57,
            KeyX => 0x58,
            KeyY => 0x59,
            KeyZ => 0x5A,
            Backspace | NumpadBackspace => 0x08,
            Tab => 0x09,
            Enter | NumpadEnter => 0x0D,
            ShiftLeft | ShiftRight => 0x10,
            ControlLeft | ControlRight => 0x11,
            AltLeft | AltRight => 0x12,
            Pause => 0x13,
            CapsLock => 0x14,
            Escape => 0x1B,
            Convert => 0x1C,
            NonConvert => 0x1D,
            Space => 0x20,
            PageUp => 0x21,
            PageDown => 0x22,
            End => 0x23,
            Home => 0x24,
            ArrowLeft => 0x25,
            ArrowUp => 0x26,
            ArrowRight => 0x27,
            ArrowDown => 0x28,
            PrintScreen => 0x2C,
            Insert => 0x2D,
            Delete => 0x2E,
            SuperLeft => 0x5B,
            SuperRight => 0x5C,
            ContextMenu => 0x5D,
            Numpad0 => 0x60,
            Numpad1 => 0x61,
            Numpad2 => 0x62,
            Numpad3 => 0x63,
            Numpad4 => 0x64,
            Numpad5 => 0x65,
            Numpad6 => 0x66,
            Numpad7 => 0x67,
            Numpad8 => 0x68,
            Numpad9 => 0x69,
            NumpadMultiply => 0x6A,
            NumpadAdd => 0x6B,
            NumpadSubtract => 0x6D,
            NumpadDecimal => 0x6E,
            NumpadDivide => 0x6F,
            F1 => 0x70,
            F2 => 0x71,
            F3 => 0x72,
            F4 => 0x73,
            F5 => 0x74,
            F6 => 0x75,
            F7 => 0x76,
            F8 => 0x77,
            F9 => 0x78,
            F10 => 0x79,
            F11 => 0x7A,
            F12 => 0x7B,
            F13 => 0x7C,
            F14 => 0x7D,
            F15 => 0x7E,
            F16 => 0x7F,
            F17 => 0x80,
            F18 => 0x81,
            F19 => 0x82,
            F20 => 0x83,
            F21 => 0x84,
            F22 => 0x85,
            F23 => 0x86,
            F24 => 0x87,
            NumLock => 0x90,
            ScrollLock => 0x91,
            Semicolon => 0xBA,
            Equal | Plus | NumpadEqual => 0xBB,
            Comma | NumpadComma => 0xBC,
            Minus => 0xBD,
            Period => 0xBE,
            Slash => 0xBF,
            Backquote => 0xC0,
            BracketLeft => 0xDB,
            Backslash | IntlBackslash | IntlRo | IntlYen => 0xDC,
            BracketRight => 0xDD,
            Quote => 0xDE,
            _ => 0,
        }
    }

    fn to_tao_cursor(cursor: CursorType) -> TaoCursorIcon {
        if cursor == CursorType::CROSS {
            TaoCursorIcon::Crosshair
        } else if cursor == CursorType::HAND {
            TaoCursorIcon::Hand
        } else if cursor == CursorType::IBEAM {
            TaoCursorIcon::Text
        } else if cursor == CursorType::WAIT {
            TaoCursorIcon::Wait
        } else if cursor == CursorType::HELP {
            TaoCursorIcon::Help
        } else if cursor == CursorType::EASTRESIZE {
            TaoCursorIcon::EResize
        } else if cursor == CursorType::WESTRESIZE {
            TaoCursorIcon::WResize
        } else if cursor == CursorType::NORTHRESIZE {
            TaoCursorIcon::NResize
        } else if cursor == CursorType::SOUTHRESIZE {
            TaoCursorIcon::SResize
        } else if cursor == CursorType::NORTHEASTRESIZE {
            TaoCursorIcon::NeResize
        } else if cursor == CursorType::NORTHWESTRESIZE {
            TaoCursorIcon::NwResize
        } else if cursor == CursorType::SOUTHEASTRESIZE {
            TaoCursorIcon::SeResize
        } else if cursor == CursorType::SOUTHWESTRESIZE {
            TaoCursorIcon::SwResize
        } else if cursor == CursorType::NORTHSOUTHRESIZE {
            TaoCursorIcon::NsResize
        } else if cursor == CursorType::EASTWESTRESIZE {
            TaoCursorIcon::EwResize
        } else if cursor == CursorType::NORTHEASTSOUTHWESTRESIZE {
            TaoCursorIcon::NeswResize
        } else if cursor == CursorType::NORTHWESTSOUTHEASTRESIZE {
            TaoCursorIcon::NwseResize
        } else if cursor == CursorType::COLUMNRESIZE {
            TaoCursorIcon::ColResize
        } else if cursor == CursorType::ROWRESIZE {
            TaoCursorIcon::RowResize
        } else if cursor == CursorType::MOVE {
            TaoCursorIcon::Move
        } else if cursor == CursorType::VERTICALTEXT {
            TaoCursorIcon::VerticalText
        } else if cursor == CursorType::CELL {
            TaoCursorIcon::Cell
        } else if cursor == CursorType::CONTEXTMENU {
            TaoCursorIcon::ContextMenu
        } else if cursor == CursorType::ALIAS {
            TaoCursorIcon::Alias
        } else if cursor == CursorType::PROGRESS {
            TaoCursorIcon::Progress
        } else if cursor == CursorType::NODROP {
            TaoCursorIcon::NoDrop
        } else if cursor == CursorType::COPY {
            TaoCursorIcon::Copy
        } else if cursor == CursorType::NOTALLOWED {
            TaoCursorIcon::NotAllowed
        } else if cursor == CursorType::ZOOMIN {
            TaoCursorIcon::ZoomIn
        } else if cursor == CursorType::ZOOMOUT {
            TaoCursorIcon::ZoomOut
        } else if cursor == CursorType::GRAB {
            TaoCursorIcon::Grab
        } else if cursor == CursorType::GRABBING {
            TaoCursorIcon::Grabbing
        } else {
            TaoCursorIcon::Default
        }
    }

    fn event_flag_shift() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0
    }
    fn event_flag_control() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0
    }
    fn event_flag_alt() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_ALT_DOWN.0
    }
    fn event_flag_command() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0
    }
    fn event_flag_left_mouse() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_LEFT_MOUSE_BUTTON.0
    }
    fn event_flag_middle_mouse() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_MIDDLE_MOUSE_BUTTON.0
    }
    fn event_flag_right_mouse() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_RIGHT_MOUSE_BUTTON.0
    }
    fn event_flag_is_keypad() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_IS_KEY_PAD.0
    }
    fn event_flag_is_left() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_IS_LEFT.0
    }
    fn event_flag_is_right() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_IS_RIGHT.0
    }
    fn event_flag_repeat() -> u32 {
        cef::sys::cef_event_flags_t::EVENTFLAG_IS_REPEAT.0
    }

    /// 把最近一帧 OSR BGRA 像素绘制到 tao 顶层窗口。
    ///
    /// Phase 3 为正确性优先,每次 dirty 帧都会创建 softbuffer surface 并逐像素
    /// 转换。后续性能优化可以复用 surface 或改走 GPU 路线。
    pub(crate) fn blit(window: &Arc<TaoWindow>, webview: &CefWebviewState) {
        let Some(osr) = &webview.osr else {
            return;
        };
        if !webview.visible || !osr.dirty.get() {
            return;
        }
        let ws = window.inner_size();
        let (Some(win_w), Some(win_h)) = (NonZeroU32::new(ws.width), NonZeroU32::new(ws.height))
        else {
            return;
        };

        // 首帧创建一次 surface 后缓存复用;Context 用完即弃(Surface 已内部持有 X11
        // 连接),避免每帧新开 X 连接导致 "Maximum number of clients reached"。
        // 窗口尚未实现(如启动时隐藏创建的 crawler 窗口)时,其原生 window handle
        // 不可用。此时绝不能 `Context::new`:softbuffer 会开一个 X 连接、随后
        // `Surface::new` 因 handle 不可用而失败,而该连接不会被回收 → 每帧泄漏一个,
        // 几百帧后即 "Maximum number of clients reached" 崩溃。等窗口真正显示后再建。
        if raw_window_handle::HasWindowHandle::window_handle(&**window).is_err() {
            return;
        }

        let mut surface_slot = webview.surface.borrow_mut();
        if surface_slot.is_none() {
            let Ok(context) = softbuffer::Context::new(window.clone()) else {
                return;
            };
            let Ok(surface) = softbuffer::Surface::new(&context, window.clone()) else {
                return;
            };
            *surface_slot = Some(surface);
        }
        let surface = surface_slot.as_mut().unwrap();
        if surface.resize(win_w, win_h).is_err() {
            return;
        }
        let Ok(mut buf) = surface.buffer_mut() else {
            return;
        };

        let frame = osr.frame.borrow();
        if frame.bgra.is_empty() {
            return;
        }
        let fw = frame.w as u32;
        let fh = frame.h as u32;
        let copy_w = fw.min(ws.width);
        let copy_h = fh.min(ws.height);

        for y in 0..copy_h {
            let src_row = (y * fw) as usize * 4;
            let dst_row = (y * ws.width) as usize;
            for x in 0..copy_w as usize {
                let si = src_row + x * 4;
                let b = frame.bgra[si] as u32;
                let g = frame.bgra[si + 1] as u32;
                let r = frame.bgra[si + 2] as u32;
                buf[dst_row + x] = (r << 16) | (g << 8) | b;
            }
        }
        let _ = buf.present();
        osr.dirty.set(false);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_common_windows_key_codes() {
            assert_eq!(physical_windows_key_code(KeyCode::KeyA), 0x41);
            assert_eq!(physical_windows_key_code(KeyCode::Enter), 0x0D);
            assert_eq!(physical_windows_key_code(KeyCode::ArrowLeft), 0x25);
            assert_eq!(physical_windows_key_code(KeyCode::F12), 0x7B);
        }

        #[test]
        fn combines_cef_modifier_flags() {
            let flags = cef_modifiers(ModifiersState::SHIFT | ModifiersState::CONTROL);
            assert_ne!(flags & event_flag_shift(), 0);
            assert_ne!(flags & event_flag_control(), 0);
            assert_eq!(flags & event_flag_alt(), 0);
        }

        #[test]
        fn recognizes_double_clicks_at_the_same_position() {
            let mut input = InputState {
                cursor: (12, 24),
                ..Default::default()
            };
            assert_eq!(click_count(&mut input, MouseButton::Left), 1);
            assert_eq!(click_count(&mut input, MouseButton::Left), 2);
        }

        #[test]
        fn maps_link_cursor_to_hand() {
            assert_eq!(to_tao_cursor(CursorType::HAND), TaoCursorIcon::Hand);
        }
    }
}

#[cfg(feature = "cef-backend")]
pub(crate) use imp::*;
