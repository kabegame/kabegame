//! Runtime / RuntimeHandle / EventLoopProxy 实现。
//!
//! 这一层负责把 Tauri 的 runtime trait 映射到 tao 事件循环和 CEF 外部消息泵。
//! 所有 CEF browser 操作都应通过内部 `Message` 投递回主循环,避免跨线程直接
//! 调用 CEF UI 对象。

#[cfg(feature = "cef-backend")]
mod imp {
    #![allow(non_upper_case_globals)]
    use std::{
        any::Any,
        cell::{Cell, RefCell},
        collections::{BTreeMap, VecDeque},
        fmt,
        sync::{
            atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering},
            mpsc::{channel, Sender},
            Arc, Mutex, OnceLock,
        },
        thread::{current as current_thread, ThreadId as StdThreadId},
        time::{Duration, Instant},
    };

    use cef::{args::Args, *};
    use gtk::{glib::MainContext, prelude::WidgetExt};
    use raw_window_handle::HasWindowHandle;
    use tao::{
        event::{Event, WindowEvent as TaoWindowEvent},
        event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
        platform::{
            run_return::EventLoopExtRunReturn,
            unix::{EventLoopBuilderExtUnix, WindowExtUnix},
        },
        window::{Icon as TaoIcon, Window as TaoWindow},
    };
    use tauri_runtime::window::WindowId;
    use tauri_runtime::{
        dpi::{PhysicalPosition, PhysicalSize, Position, Size},
        monitor::Monitor,
        webview::{DetachedWebview, PendingWebview},
        window::{DetachedWindow, DetachedWindowWebview, PendingWindow, RawWindow, WindowEvent},
        DeviceEventFilter, Error, EventLoopProxy as RuntimeEventLoopProxy,
        ExitRequestedEventAction, Result, RunEvent, Runtime, RuntimeHandle, RuntimeInitArgs,
        UserEvent, WebviewEventId, WindowEventId,
    };
    use tauri_utils::Theme;

    use crate::{webview, window, Cef, CefEventLoopProxy, CefHandle};

    /// runtime 内部使用的 webview 标识。
    ///
    /// Tauri 的 `WindowId` 来自 `tauri-runtime`,但 webview 没有直接暴露一个
    /// 可复用的公开 id 类型,所以这里维护独立递增 id。
    pub(crate) type WebviewId = u32;

    /// CEF backend 的渲染/窗口模式。
    ///
    /// 默认保留 OSR,便于回退和对照。设置
    /// `KABEGAME_CEF_WINDOW_MODE=windowed` 后启用 CEF Views 自建顶层窗口。
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum WindowMode {
        Osr,
        Windowed,
    }

    impl WindowMode {
        fn from_env() -> Self {
            let explicit = std::env::var("KABEGAME_CEF_WINDOW_MODE").ok();
            match explicit.as_deref() {
                Some("windowed" | "views") => Self::Windowed,
                Some("osr" | "windowless") => Self::Osr,
                _ => Self::Osr,
            }
        }

        fn is_windowed(self) -> bool {
            matches!(self, Self::Windowed)
        }

        fn env_debug_value() -> String {
            let mode = std::env::var("KABEGAME_CEF_WINDOW_MODE").ok();
            let kabegame_url = std::env::var("KABEGAME_CEF_WINDOWED_URL").ok();
            let legacy_url = std::env::var("CEF_WINDOWED_URL").ok();
            let legacy_pump = std::env::var("CEF_WINDOWED_PUMP").ok();
            format!(
                "KABEGAME_CEF_WINDOW_MODE={mode:?} KABEGAME_CEF_WINDOWED_URL={kabegame_url:?} CEF_WINDOWED_URL={legacy_url:?} CEF_WINDOWED_PUMP={legacy_pump:?}"
            )
        }
    }

    static WINDOWED_QUIT: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    static WINDOWED_CONTEXT_INITIALIZED: AtomicBool = AtomicBool::new(false);

    fn windowed_quit() -> Arc<AtomicBool> {
        WINDOWED_QUIT
            .get_or_init(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// CEF runtime 的主状态。
    ///
    /// 它只应在 tao 主事件循环线程上被实际驱动。`RefCell` 存储窗口/webview
    /// 表是因为 tao `run_return` 闭包在单线程内同步访问这些状态,不需要跨线程
    /// 锁；跨线程请求通过 `CefContext::send` 进入主循环。
    pub(crate) struct CefRuntime<T: UserEvent> {
        pub(crate) context: CefContext<T>,
        pub(crate) event_loop: EventLoop<Message<T>>,
        window_mode: WindowMode,
        windows: Arc<CefWindows>,
        tao_to_tauri: Arc<CefWindowIdMap>,
        webviews: Arc<CefWebviews>,
        pub(crate) exit_code: Cell<i32>,
    }

    impl<T: UserEvent> fmt::Debug for CefRuntime<T> {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("CefRuntime")
                .field("windows", &self.context.windows.0.borrow().len())
                .field("webviews", &self.context.webviews.0.borrow().len())
                .finish()
        }
    }

    /// 可克隆的 runtime 上下文。
    ///
    /// dispatcher/handle/proxy 都持有它,用 tao `EventLoopProxy` 把操作投递回
    /// runtime 主线程,并集中分配 window/webview/event listener id。
    #[derive(Clone)]
    pub(crate) struct CefContext<T: UserEvent> {
        tao_proxy: EventLoopProxy<Message<T>>,
        messages: Arc<CefMessageQueue<T>>,
        main_thread_id: StdThreadId,
        windows: Arc<CefWindows>,
        tao_to_tauri: Arc<CefWindowIdMap>,
        webviews: Arc<CefWebviews>,
        main_runtime: Arc<AtomicPtr<CefRuntime<T>>>,
        next_window_id: Arc<AtomicU32>,
        next_webview_id: Arc<AtomicU32>,
        next_window_event_id: Arc<AtomicU32>,
        next_webview_event_id: Arc<AtomicU32>,
    }

    impl<T: UserEvent> fmt::Debug for CefContext<T> {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("CefContext").finish_non_exhaustive()
        }
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl<T: UserEvent> Send for CefContext<T> {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl<T: UserEvent> Sync for CefContext<T> {}

    impl<T: UserEvent> CefContext<T> {
        /// 向 runtime 主循环发送一条内部消息。
        ///
        /// OSR 模式用 tao proxy 唤醒事件循环；windowed 模式由纯 CEF/GLib pump
        /// 轮询同一队列。调用方不应直接持有或操作 `TaoWindow` / CEF UI 对象。
        pub(crate) fn send(&self, message: Message<T>) -> Result<()> {
            match message {
                Message::UserEvent(_) | Message::RequestExit(_) => self.enqueue(message),
                message => {
                    if current_thread().id() == self.main_thread_id {
                        let runtime = self.main_runtime.load(Ordering::Acquire);
                        if !runtime.is_null() {
                            return unsafe { &*runtime }.handle_main_thread_message(message);
                        }
                    }
                    self.enqueue(message)
                }
            }
        }

        fn enqueue(&self, message: Message<T>) -> Result<()> {
            self.messages.push(message);
            let _ = self.tao_proxy.send_event(Message::Wake);
            Ok(())
        }

        fn pop_message(&self) -> Option<Message<T>> {
            self.messages.pop()
        }

        /// 分配一个新的 Tauri window id。
        pub(crate) fn next_window_id(&self) -> WindowId {
            self.next_window_id.fetch_add(1, Ordering::Relaxed).into()
        }

        /// 分配一个新的内部 webview id。
        pub(crate) fn next_webview_id(&self) -> WebviewId {
            self.next_webview_id.fetch_add(1, Ordering::Relaxed)
        }

        /// 分配一个新的窗口事件监听器 id。
        pub(crate) fn next_window_event_id(&self) -> WindowEventId {
            self.next_window_event_id.fetch_add(1, Ordering::Relaxed)
        }

        /// 分配一个新的 webview 事件监听器 id。
        pub(crate) fn next_webview_event_id(&self) -> WebviewEventId {
            self.next_webview_event_id.fetch_add(1, Ordering::Relaxed)
        }
    }

    struct CefMessageQueue<T: UserEvent>(Mutex<VecDeque<Message<T>>>);

    impl<T: UserEvent> CefMessageQueue<T> {
        fn new() -> Self {
            Self(Mutex::new(VecDeque::new()))
        }

        fn push(&self, message: Message<T>) {
            self.0
                .lock()
                .expect("CEF message queue mutex poisoned")
                .push_back(message);
        }

        fn pop(&self) -> Option<Message<T>> {
            self.0
                .lock()
                .expect("CEF message queue mutex poisoned")
                .pop_front()
        }
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl<T: UserEvent> Send for CefMessageQueue<T> {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl<T: UserEvent> Sync for CefMessageQueue<T> {}

    struct CefWindows(RefCell<BTreeMap<WindowId, CefWindowState>>);
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefWindows {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefWindows {}

    struct CefWindowIdMap(RefCell<BTreeMap<tao::window::WindowId, WindowId>>);
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefWindowIdMap {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefWindowIdMap {}

    struct CefWebviews(RefCell<BTreeMap<WebviewId, webview::CefWebviewState>>);
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefWebviews {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefWebviews {}

    /// runtime 内部消息。
    ///
    /// Tauri runtime trait 的大多数方法都可以被任意线程调用；这里把它们统一
    /// 表达为消息,由 tao 主循环消费后再操作窗口、webview 或回调上层 Tauri。
    pub(crate) enum Message<T: UserEvent> {
        /// Tauri 用户自定义事件。
        UserEvent(T),
        /// tao-only wakeup used after a message has been queued.
        Wake,
        /// 需要在主线程执行的一次性任务。
        Task(Box<dyn FnOnce() + Send>),
        /// 请求退出事件循环。
        RequestExit(i32),
        /// 在主线程创建 tao 窗口,并返回 Tauri detached window。
        CreateWindow {
            window_id: WindowId,
            pending: PendingWindow<T, Cef<T>>,
            after_window_creation: Option<Box<dyn Fn(RawWindow) + Send>>,
            tx: Sender<Result<DetachedWindow<T, Cef<T>>>>,
        },
        /// 在已存在窗口上创建 CEF windowless webview。
        CreateWebview {
            window_id: WindowId,
            webview_id: WebviewId,
            pending: PendingWebview<T, Cef<T>>,
            tx: Sender<Result<DetachedWebview<T, Cef<T>>>>,
        },
        /// 派发窗口操作或 getter。
        Window(WindowId, WindowMessage),
        /// 派发 webview 操作或 getter。
        Webview(WebviewId, WebviewMessage),
    }

    impl<T: UserEvent> fmt::Debug for Message<T> {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::UserEvent(event) => f.debug_tuple("UserEvent").field(event).finish(),
                Self::Wake => f.write_str("Wake"),
                Self::Task(_) => f.write_str("Task"),
                Self::RequestExit(code) => f.debug_tuple("RequestExit").field(code).finish(),
                Self::CreateWindow { window_id, .. } => {
                    f.debug_tuple("CreateWindow").field(window_id).finish()
                }
                Self::CreateWebview {
                    window_id,
                    webview_id,
                    ..
                } => f
                    .debug_tuple("CreateWebview")
                    .field(window_id)
                    .field(webview_id)
                    .finish(),
                Self::Window(id, _) => f.debug_tuple("Window").field(id).finish(),
                Self::Webview(id, _) => f.debug_tuple("Webview").field(id).finish(),
            }
        }
    }

    /// 单个 tao 窗口的运行期状态。
    ///
    /// 记录 Tauri label、原生窗口、窗口事件监听器以及挂载到该窗口上的 CEF
    /// webview id。窗口 resize 时会按这个列表通知 webview 调整 OSR 视口。
    pub(crate) struct CefWindowState {
        pub(crate) label: String,
        pub(crate) kind: CefWindowKind,
        pub(crate) listeners: window::WindowListeners,
        pub(crate) webviews: Vec<WebviewId>,
    }

    pub(crate) enum CefWindowKind {
        Osr { window: Arc<TaoWindow> },
        Windowed(WindowedWindowState),
    }

    pub(crate) struct WindowedWindowState {
        shared: Arc<Mutex<WindowedWindowShared>>,
        title: String,
        size: PhysicalSize<u32>,
        position: Option<PhysicalPosition<i32>>,
        resizable: bool,
        maximizable: bool,
        minimizable: bool,
        closable: bool,
        decorated: bool,
        visible: bool,
        fullscreen: bool,
        maximized: bool,
        minimized: bool,
        focused: bool,
        always_on_top: bool,
    }

    impl WindowedWindowState {
        /// 在 CEF UI 线程上,用活的 CEF Views `Window` 执行闭包(窗口已创建时)。
        ///
        /// windowed getter 借此直接查询真实窗口状态(尺寸/位置/最大化/全屏/DPI…),
        /// 而非读可能过期的缓存;窗口尚未创建或不可用时返回 `None`,调用方回退到缓存。
        ///
        /// 仅应在窗口消息循环(= CEF UI 线程)上调用 —— 与 `apply_windowed_window_set`
        /// 一致;CEF Views API 要求在 UI 线程访问。
        fn with_cef_window<R>(&self, f: impl FnOnce(&cef::Window) -> R) -> Option<R> {
            let shared = self.shared.lock().ok()?;
            shared.window.as_ref().map(|w| f(&w.inner))
        }
    }

    struct WindowedWindowShared {
        window: Option<CefWindow>,
        browser_view: Option<webview::CefBrowserView>,
        browser_view_attached: bool,
        quit: Arc<AtomicBool>,
    }

    pub(crate) struct CefWindow {
        inner: cef::Window,
    }

    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for CefWindow {}
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Sync for CefWindow {}

    /// 允许 GTK window 跨内部 mpsc 返回的 wrapper。
    ///
    /// GTK 类型本身不是 `Send`,但这里的通道只用于主循环同步回复 dispatcher
    /// getter,使用方式与 `tauri-runtime-wry` 的 wrapper 相同。
    pub(crate) struct GtkWindow(pub gtk::ApplicationWindow);
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for GtkWindow {}

    /// 允许 GTK box 跨内部 mpsc 返回的 wrapper。
    pub(crate) struct GtkBox(pub gtk::Box);
    #[allow(clippy::non_send_fields_in_send_ty)]
    unsafe impl Send for GtkBox {}

    /// 允许 raw window handle 跨内部 mpsc 返回的 wrapper。
    pub(crate) struct SendRawWindowHandle(pub raw_window_handle::RawWindowHandle);
    unsafe impl Send for SendRawWindowHandle {}

    /// 窗口层消息。
    ///
    /// getter 使用 `Any` 装箱返回,由 dispatcher 按请求类型 downcast；setter 则
    /// 通过 `WindowSet` 聚合,避免为每个窗口操作定义一条顶层消息。
    pub(crate) enum WindowMessage {
        AddEventListener(WindowEventId, Box<dyn Fn(&WindowEvent) + Send>),
        Get(WindowGetterKind, Sender<Result<Box<dyn Any + Send>>>),
        MonitorFromPoint(Sender<Option<tao::monitor::MonitorHandle>>, f64, f64),
        Set(WindowSet),
        Center,
        RequestUserAttention(Option<tao::window::UserAttentionType>),
    }

    /// 类型化窗口 getter 请求。
    ///
    /// `R` 只存在于编译期,帮助调用点表达期望返回类型；运行期实际发送的是
    /// `WindowGetterKind`,响应通过 `Any` downcast 回 `R`。
    pub(crate) struct WindowGetter<R> {
        pub(crate) kind: WindowGetterKind,
        _marker: std::marker::PhantomData<R>,
    }

    /// 窗口 getter 的运行期种类。
    #[derive(Clone, Copy)]
    pub(crate) enum WindowGetterKind {
        ScaleFactor,
        InnerPosition,
        OuterPosition,
        InnerSize,
        OuterSize,
        IsFullscreen,
        IsMinimized,
        IsMaximized,
        IsFocused,
        IsDecorated,
        IsResizable,
        IsMaximizable,
        IsMinimizable,
        IsClosable,
        IsVisible,
        IsEnabled,
        IsAlwaysOnTop,
        Title,
        CurrentMonitor,
        PrimaryMonitor,
        AvailableMonitors,
        GtkWindow,
        GtkBox,
        RawWindowHandle,
        Theme,
    }

    impl WindowGetter<f64> {
        pub(crate) const ScaleFactor: Self = Self::from_kind(WindowGetterKind::ScaleFactor);
    }

    /// 窗口 setter/命令的聚合枚举。
    ///
    /// 这些操作最终在主线程由 `apply_window_set` 映射到 tao window API。
    pub(crate) enum WindowSet {
        Resizable(bool),
        Enabled(bool),
        Maximizable(bool),
        Minimizable(bool),
        Closable(bool),
        Title(String),
        Maximize,
        Unmaximize,
        Minimize,
        Unminimize,
        Show,
        Hide,
        Close,
        Destroy,
        Decorations(bool),
        AlwaysOnBottom(bool),
        AlwaysOnTop(bool),
        VisibleOnAllWorkspaces(bool),
        ContentProtected(bool),
        Size(Size),
        MinSize(Option<Size>),
        MaxSize(Option<Size>),
        SizeConstraints(tauri_runtime::window::WindowSizeConstraints),
        Position(Position),
        Fullscreen(bool),
        Focus,
        Focusable(bool),
        Icon(TaoIcon),
        SkipTaskbar(bool),
        CursorGrab(bool),
        CursorVisible(bool),
        CursorIcon(tao::window::CursorIcon),
        CursorPosition(Position),
        IgnoreCursorEvents(bool),
        StartDragging,
        StartResizeDragging(tao::window::ResizeDirection),
        Theme(Option<Theme>),
    }

    /// webview 层消息。
    ///
    /// Phase 3 只实现启动渲染所需的导航、脚本执行、尺寸和可见性控制；
    /// IPC、完整 cookie/devtools 等能力后续按阶段补齐。
    pub(crate) enum WebviewMessage {
        AddEventListener(
            WebviewEventId,
            Box<dyn Fn(&tauri_runtime::window::WebviewEvent) + Send>,
        ),
        Get(WebviewGetterKind, Sender<Result<Box<dyn Any + Send>>>),
        WithWebview(Box<dyn FnOnce(Box<dyn Any>) + Send>),
        OpenDevTools,
        CloseDevTools,
        Navigate(String),
        Reload,
        Close,
        SetSize(Size),
        SetFocus,
        SetVisible(bool),
        Eval(String),
        SetAutoResize(bool),
        SetZoom(f64),
    }

    /// 类型化 webview getter 请求。
    pub(crate) struct WebviewGetter<R> {
        pub(crate) kind: WebviewGetterKind,
        _marker: std::marker::PhantomData<R>,
    }

    impl<R> WebviewGetter<R> {
        pub(crate) const fn from_kind(kind: WebviewGetterKind) -> Self {
            Self {
                kind,
                _marker: std::marker::PhantomData,
            }
        }
    }

    /// webview getter 的运行期种类。
    #[derive(Clone, Copy)]
    pub(crate) enum WebviewGetterKind {
        Url,
        Size,
        DevToolsOpen,
    }

    thread_local! {
        /// CEF app prepared by the executable's earliest subprocess-dispatch call.
        ///
        /// Keeping this thread-local preserves the exact app instance passed to
        /// `cef_execute_process` so runtime initialization does not dispatch the
        /// browser process a second time. Both operations happen on the UI thread.
        static PREPARED_CEF_APP: RefCell<Option<cef::App>> = const { RefCell::new(None) };
        static CEF_INITIALIZED: Cell<bool> = const { Cell::new(false) };
    }

    type CefUiTaskCallback = Box<dyn FnOnce() + Send>;

    wrap_task! {
        struct CefUiTask {
            task: Arc<Mutex<Option<CefUiTaskCallback>>>,
        }

        impl Task {
            fn execute(&self) {
                let Some(task) = self
                    .task
                    .lock()
                    .expect("CEF UI task mutex poisoned")
                    .take()
                else {
                    return;
                };
                task();
            }
        }
    }

    /// 派发 CEF 子进程并在子进程中退出。
    ///
    /// 应用主进程调用后会继续返回；renderer/gpu 等 CEF 子进程会在这里
    /// `std::process::exit`,不会进入 Tauri 初始化。
    pub fn execute_cef_subprocess_and_exit() {
        // Match the proven OSR bootstrap order: select X11 before CEF parses
        // the process environment or launches any child process.
        unsafe {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        let window_mode = WindowMode::from_env();
        eprintln!(
            "[cef-runtime] early subprocess dispatch mode={window_mode:?} {}",
            WindowMode::env_debug_value()
        );
        let mut app = init_cef_app_and_maybe_exit(true, window_mode);
        initialize_cef(&mut app, window_mode)
            .expect("failed to initialize CEF before Tauri startup");
        PREPARED_CEF_APP.with(|prepared| prepared.replace(Some(app)));
        CEF_INITIALIZED.with(|initialized| initialized.set(true));
    }

    wrap_app! {
        struct CefRuntimeApp {
            window_mode: WindowMode,
            windowed_quit: Arc<AtomicBool>,
        }
        impl App {
            fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
                let Some(registrar) = registrar else { return };
                let options = (SchemeOptions::STANDARD.get_raw()
                    | SchemeOptions::SECURE.get_raw()
                    | SchemeOptions::CORS_ENABLED.get_raw()
                    | SchemeOptions::FETCH_ENABLED.get_raw()) as i32;
                for scheme in ["tauri", "asset", "ipc", "cef-ipc"] {
                    registrar.add_custom_scheme(Some(&CefString::from(scheme)), options);
                }
            }

            fn on_before_command_line_processing(
                &self,
                _process_type: Option<&CefString>,
                command_line: Option<&mut CommandLine>,
            ) {
                let Some(cl) = command_line else { return };
                if cl.has_switch(Some(&CefString::from("ozone-platform"))) == 0 {
                    cl.append_switch_with_value(
                        Some(&CefString::from("ozone-platform")),
                        Some(&CefString::from("x11")),
                    );
                }
                cl.append_switch(Some(&CefString::from("no-sandbox")));
                if self.window_mode.is_windowed() {
                    cl.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from("vulkan")),
                    );
                    cl.append_switch_with_value(
                        Some(&CefString::from("enable-features")),
                        Some(&CefString::from("Vulkan")),
                    );
                } else {
                    cl.append_switch(Some(&CefString::from("disable-gpu")));
                    cl.append_switch(Some(&CefString::from("disable-gpu-compositing")));
                }
                // 禁用 zygote:Linux 下渲染进程默认从 zygote fork,**不会**重新
                // `execute_process` → 不跑 `on_register_custom_schemes` → fork 出的
                // renderer 不认 `ipc://` / `cef-ipc://`(`ERR_UNKNOWN_URL_SCHEME`),
                // 导致 Tauri IPC 全断、ACL 因 `is_local=false` 拒命令。关掉 zygote
                // 后每个 renderer 作为独立进程 re-exec 本二进制,自己注册自定义 scheme。
                cl.append_switch(Some(&CefString::from("no-zygote")));
                // NOTE: 不要开 `single-process`。CEF/Chromium 单进程模式已弃用且极不
                // 稳定(OSR 首帧后 SIGSEGV,并伴随 "Cannot use V8 Proxy resolver in
                // single process mode")。多进程下渲染/GPU 子进程会 re-exec 本二进制,
                // 由 `execute_cef_subprocess_and_exit()` 在 main 最早期拦下退出
                // (见 main.rs + browser_subprocess_path)。minimal.rs 多进程已验证可用。
            }

            fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
                self.window_mode.is_windowed().then(|| {
                    WindowedBrowserProcessHandler::new(
                        RefCell::new(None),
                        self.windowed_quit.clone(),
                    )
                })
            }
        }
    }

    wrap_window_delegate! {
        struct WindowedTopLevelWindowDelegate {
            shared: Arc<Mutex<WindowedWindowShared>>,
            initial_bounds: cef::Rect,
            initial_show_state: ShowState,
            frameless: bool,
            resizable: bool,
            maximizable: bool,
            minimizable: bool,
            closable: bool,
        }

        impl ViewDelegate {
            fn preferred_size(&self, _view: Option<&mut View>) -> cef::Size {
                cef::Size {
                    width: self.initial_bounds.width,
                    height: self.initial_bounds.height,
                }
            }
        }

        impl PanelDelegate {}

        impl WindowDelegate {
            fn on_window_created(&self, window: Option<&mut cef::Window>) {
                let Some(window) = window else { return };
                let mut shared = self.shared.lock().expect("windowed state mutex poisoned");
                shared.window = Some(CefWindow {
                    inner: window.clone(),
                });
                if !shared.browser_view_attached {
                    if let Some(browser_view) = shared.browser_view.as_ref() {
                        let mut view = View::from(&browser_view.inner);
                        window.add_child_view(Some(&mut view));
                        shared.browser_view_attached = true;
                    }
                }
                if self.initial_show_state != ShowState::HIDDEN {
                    window.show();
                }
                eprintln!("[cef-runtime] windowed top-level CEF window shown");
            }

            fn on_window_destroyed(&self, _window: Option<&mut cef::Window>) {
                let mut shared = self.shared.lock().expect("windowed state mutex poisoned");
                shared.window = None;
                shared.quit.store(true, Ordering::Release);
            }

            fn can_close(&self, _window: Option<&mut cef::Window>) -> i32 {
                if !self.closable {
                    return 0;
                }
                let shared = self.shared.lock().expect("windowed state mutex poisoned");
                let Some(browser_view) = shared.browser_view.as_ref() else {
                    return 1;
                };
                let Some(browser) = browser_view.inner.browser() else {
                    return 1;
                };
                let Some(host) = browser.host() else {
                    return 1;
                };
                host.try_close_browser()
            }

            fn initial_bounds(&self, _window: Option<&mut cef::Window>) -> cef::Rect {
                self.initial_bounds.clone()
            }

            fn initial_show_state(&self, _window: Option<&mut cef::Window>) -> ShowState {
                self.initial_show_state
            }

            fn is_frameless(&self, _window: Option<&mut cef::Window>) -> i32 {
                i32::from(self.frameless)
            }

            fn can_resize(&self, _window: Option<&mut cef::Window>) -> i32 {
                i32::from(self.resizable)
            }

            fn can_maximize(&self, _window: Option<&mut cef::Window>) -> i32 {
                i32::from(self.maximizable)
            }

            fn can_minimize(&self, _window: Option<&mut cef::Window>) -> i32 {
                i32::from(self.minimizable)
            }

            fn window_runtime_style(&self) -> RuntimeStyle {
                RuntimeStyle::ALLOY
            }
        }
    }

    wrap_browser_view_delegate! {
        struct WindowedBrowserViewDelegate {}

        impl ViewDelegate {}

        impl BrowserViewDelegate {
            fn browser_runtime_style(&self) -> RuntimeStyle {
                RuntimeStyle::ALLOY
            }
        }
    }

    wrap_client! {
        struct WindowedClient {
            life_span_handler: LifeSpanHandler,
            load_handler: LoadHandler,
        }

        impl Client {
            fn life_span_handler(&self) -> Option<LifeSpanHandler> {
                Some(self.life_span_handler.clone())
            }

            fn load_handler(&self) -> Option<LoadHandler> {
                Some(self.load_handler.clone())
            }
        }
    }

    wrap_life_span_handler! {
        struct WindowedLifeSpanHandler {
            quit: Arc<AtomicBool>,
        }

        impl LifeSpanHandler {
            fn on_after_created(&self, browser: Option<&mut Browser>) {
                let runtime_style = browser
                    .and_then(|browser| browser.host())
                    .map(|host| host.runtime_style());
                eprintln!("[cef-runtime] windowed browser created; runtime_style={runtime_style:?}");
            }

            fn on_before_close(&self, _browser: Option<&mut Browser>) {
                eprintln!("[cef-runtime] windowed browser closed; quitting external pump");
                self.quit.store(true, Ordering::Release);
                quit_message_loop();
            }
        }
    }

    wrap_load_handler! {
        struct WindowedLoadHandler;

        impl LoadHandler {
            fn on_load_error(
                &self,
                _browser: Option<&mut Browser>,
                _frame: Option<&mut Frame>,
                error_code: Errorcode,
                error_text: Option<&CefString>,
                failed_url: Option<&CefString>,
            ) {
                eprintln!(
                    "[cef-runtime] windowed load error: code={:?} text={} url={}",
                    error_code,
                    error_text.map(CefString::to_string).unwrap_or_default(),
                    failed_url.map(CefString::to_string).unwrap_or_default()
                );
            }
        }
    }

    wrap_browser_process_handler! {
        struct WindowedBrowserProcessHandler {
            client: RefCell<Option<Client>>,
            quit: Arc<AtomicBool>,
        }

        impl BrowserProcessHandler {
            fn on_schedule_message_pump_work(&self, _delay_ms: i64) {}

            fn on_context_initialized(&self) {
                WINDOWED_CONTEXT_INITIALIZED.store(true, Ordering::Release);
                if std::env::var("KABEGAME_CEF_WINDOWED_BOOTSTRAP").as_deref() != Ok("1") {
                    return;
                }

                let url = CefString::from(
                    std::env::var("KABEGAME_CEF_WINDOWED_URL")
                        .or_else(|_| std::env::var("CEF_WINDOWED_URL"))
                        .unwrap_or_else(|_| "https://example.com".to_string())
                        .as_str(),
                );
                eprintln!("[cef-runtime] windowed url={url}");

                *self.client.borrow_mut() = Some(WindowedClient::new(
                    WindowedLifeSpanHandler::new(self.quit.clone()),
                    WindowedLoadHandler::new(),
                ));

                let settings = BrowserSettings::default();
                let mut client = self.client.borrow().clone();
                let mut browser_view_delegate = WindowedBrowserViewDelegate::new();
                let browser_view = browser_view_create(
                    client.as_mut(),
                    Some(&url),
                    Some(&settings),
                    None,
                    None,
                    Some(&mut browser_view_delegate),
                );
                eprintln!(
                    "[cef-runtime] windowed browser_view created = {}",
                    browser_view.is_some()
                );

                let mut window_delegate =
                    WindowedTopLevelWindowDelegate::new(
                        Arc::new(Mutex::new(WindowedWindowShared {
                            window: None,
                            browser_view: browser_view.map(|inner| webview::CefBrowserView { inner }),
                            browser_view_attached: false,
                            quit: self.quit.clone(),
                        })),
                        cef::Rect {
                            x: 0,
                            y: 0,
                            width: 1024,
                            height: 768,
                        },
                        ShowState::NORMAL,
                        false,
                        true,
                        true,
                        true,
                        true,
                    );
                let window = window_create_top_level(Some(&mut window_delegate));
                eprintln!(
                    "[cef-runtime] windowed window_create_top_level = {}",
                    window.is_some()
                );
            }
        }
    }

    /// 创建 CEF app 并执行 `cef::execute_process`。
    ///
    /// `exit_subprocess` 为 true 时用于应用 `main` 最早阶段；为 false 时用于
    /// runtime 初始化阶段,此时 browser 主进程应继续执行 `cef::initialize`。
    fn init_cef_app_and_maybe_exit(exit_subprocess: bool, window_mode: WindowMode) -> cef::App {
        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let args = Args::new();
        let cmd = args.as_cmd_line().expect("failed to parse command line");
        let is_browser_process = cmd.has_switch(Some(&CefString::from("type"))) != 1;
        let process_type = if is_browser_process {
            "browser".to_string()
        } else {
            CefString::from(&cmd.switch_value(Some(&CefString::from("type")))).to_string()
        };
        eprintln!(
            "[cef-runtime] cef_execute_process pid={} type={process_type} mode={window_mode:?} args={:?}",
            std::process::id(),
            std::env::args().collect::<Vec<_>>()
        );
        let mut app = CefRuntimeApp::new(window_mode, windowed_quit());

        let code = execute_process(
            Some(args.as_main_args()),
            Some(&mut app),
            std::ptr::null_mut(),
        );
        eprintln!(
            "[cef-runtime] cef_execute_process returned pid={} type={process_type} code={code}",
            std::process::id()
        );
        if exit_subprocess && !is_browser_process {
            std::process::exit(code.max(0));
        }
        app
    }

    /// 初始化 CEF browser 主进程。
    ///
    /// 关键配置:
    /// - `external_message_pump = 1`:由 runtime 主循环主动调用 `do_message_loop_work`。
    /// - OSR 模式设置 `windowless_rendering_enabled = 1`;windowed 模式让 CEF
    ///   Views 创建真实顶层窗口。
    /// - `CEF_PATH`:可指定 CEF resources/locales 所在目录。
    fn initialize_cef(app: &mut cef::App, window_mode: WindowMode) -> Result<()> {
        let args = Args::new();
        if window_mode.is_windowed() {
            WINDOWED_CONTEXT_INITIALIZED.store(false, Ordering::Release);
        }
        eprintln!("[cef-runtime] cef_initialize mode={window_mode:?}");
        let mut settings = Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            log_severity: LogSeverity::VERBOSE,
            browser_subprocess_path: CefString::from(
                std::env::current_exe()
                    .expect("failed to resolve CEF subprocess executable")
                    .to_string_lossy()
                    .as_ref(),
            ),
            root_cache_path: CefString::from(
                std::env::temp_dir()
                    .join("kabegame-cef")
                    .to_string_lossy()
                    .as_ref(),
            ),
            ..Default::default()
        };
        if !window_mode.is_windowed() {
            settings.windowless_rendering_enabled = 1;
        }
        if let Ok(cef_path) = std::env::var("CEF_PATH") {
            if !cef_path.is_empty() {
                settings.resources_dir_path = CefString::from(cef_path.as_str());
                settings.locales_dir_path = CefString::from(format!("{cef_path}/locales").as_str());
            }
        }

        if initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(app),
            std::ptr::null_mut(),
        ) == 1
        {
            Ok(())
        } else {
            Err(Error::CreateWebview(Box::new(std::io::Error::other(
                "cef::initialize failed",
            ))))
        }
    }

    impl<R> WindowGetter<R> {
        pub(crate) const fn from_kind(kind: WindowGetterKind) -> Self {
            Self {
                kind,
                _marker: std::marker::PhantomData,
            }
        }
    }

    impl WindowGetter<PhysicalPosition<i32>> {
        pub(crate) const InnerPosition: Self = Self::from_kind(WindowGetterKind::InnerPosition);
        pub(crate) const OuterPosition: Self = Self::from_kind(WindowGetterKind::OuterPosition);
    }
    impl WindowGetter<PhysicalSize<u32>> {
        pub(crate) const InnerSize: Self = Self::from_kind(WindowGetterKind::InnerSize);
        pub(crate) const OuterSize: Self = Self::from_kind(WindowGetterKind::OuterSize);
    }
    impl WindowGetter<bool> {
        pub(crate) const IsFullscreen: Self = Self::from_kind(WindowGetterKind::IsFullscreen);
        pub(crate) const IsMinimized: Self = Self::from_kind(WindowGetterKind::IsMinimized);
        pub(crate) const IsMaximized: Self = Self::from_kind(WindowGetterKind::IsMaximized);
        pub(crate) const IsFocused: Self = Self::from_kind(WindowGetterKind::IsFocused);
        pub(crate) const IsDecorated: Self = Self::from_kind(WindowGetterKind::IsDecorated);
        pub(crate) const IsResizable: Self = Self::from_kind(WindowGetterKind::IsResizable);
        pub(crate) const IsMaximizable: Self = Self::from_kind(WindowGetterKind::IsMaximizable);
        pub(crate) const IsMinimizable: Self = Self::from_kind(WindowGetterKind::IsMinimizable);
        pub(crate) const IsClosable: Self = Self::from_kind(WindowGetterKind::IsClosable);
        pub(crate) const IsVisible: Self = Self::from_kind(WindowGetterKind::IsVisible);
        pub(crate) const IsEnabled: Self = Self::from_kind(WindowGetterKind::IsEnabled);
        pub(crate) const IsAlwaysOnTop: Self = Self::from_kind(WindowGetterKind::IsAlwaysOnTop);
    }
    impl WindowGetter<String> {
        pub(crate) const Title: Self = Self::from_kind(WindowGetterKind::Title);
    }
    impl WindowGetter<Option<tao::monitor::MonitorHandle>> {
        pub(crate) const CurrentMonitor: Self = Self::from_kind(WindowGetterKind::CurrentMonitor);
        pub(crate) const PrimaryMonitor: Self = Self::from_kind(WindowGetterKind::PrimaryMonitor);
    }
    impl WindowGetter<Vec<tao::monitor::MonitorHandle>> {
        pub(crate) const AvailableMonitors: Self =
            Self::from_kind(WindowGetterKind::AvailableMonitors);
    }
    impl WindowGetter<GtkWindow> {
        pub(crate) const GtkWindow: Self = Self::from_kind(WindowGetterKind::GtkWindow);
    }
    impl WindowGetter<GtkBox> {
        pub(crate) const GtkBox: Self = Self::from_kind(WindowGetterKind::GtkBox);
    }
    impl WindowGetter<std::result::Result<SendRawWindowHandle, raw_window_handle::HandleError>> {
        pub(crate) const RawWindowHandle: Self = Self::from_kind(WindowGetterKind::RawWindowHandle);
    }
    impl WindowGetter<Theme> {
        pub(crate) const Theme: Self = Self::from_kind(WindowGetterKind::Theme);
    }

    impl WebviewGetter<String> {
        pub(crate) const Url: Self = Self::from_kind(WebviewGetterKind::Url);
    }
    impl WebviewGetter<PhysicalSize<u32>> {
        pub(crate) const Size: Self = Self::from_kind(WebviewGetterKind::Size);
    }
    impl WebviewGetter<bool> {
        pub(crate) const DevToolsOpen: Self = Self::from_kind(WebviewGetterKind::DevToolsOpen);
    }

    impl<T: UserEvent> RuntimeEventLoopProxy<T> for CefEventLoopProxy<T> {
        /// 把 Tauri 用户事件包装成 runtime 内部消息并投递给 runtime 队列。
        fn send_event(&self, event: T) -> Result<()> {
            self.context.send(Message::UserEvent(event))
        }
    }

    impl<T: UserEvent> RuntimeHandle<T> for CefHandle<T> {
        type Runtime = Cef<T>;

        /// 从 handle 派生一个用户事件代理。
        fn create_proxy(&self) -> CefEventLoopProxy<T> {
            CefEventLoopProxy {
                context: self.context.clone(),
            }
        }

        /// 请求主循环退出。
        ///
        /// 实际退出前会触发 `RunEvent::ExitRequested`,上层仍可通过 tx 阻止退出。
        fn request_exit(&self, code: i32) -> Result<()> {
            self.context.send(Message::RequestExit(code))
        }

        /// 从非主线程请求创建窗口。
        ///
        /// 请求通过 mpsc 回复结果；真正的 tao window 创建发生在主循环线程。
        fn create_window<F: Fn(RawWindow) + Send + 'static>(
            &self,
            pending: PendingWindow<T, Self::Runtime>,
            after_window_creation: Option<F>,
        ) -> Result<DetachedWindow<T, Self::Runtime>> {
            let window_id = self.context.next_window_id();
            let (tx, rx) = channel();
            self.context.send(Message::CreateWindow {
                window_id,
                pending,
                after_window_creation: after_window_creation
                    .map(|f| Box::new(f) as Box<dyn Fn(RawWindow) + Send>),
                tx,
            })?;
            rx.recv().map_err(|_| Error::FailedToReceiveMessage)?
        }

        /// 从非主线程请求在指定窗口上创建 CEF webview。
        fn create_webview(
            &self,
            window_id: WindowId,
            pending: PendingWebview<T, Self::Runtime>,
        ) -> Result<DetachedWebview<T, Self::Runtime>> {
            let webview_id = self.context.next_webview_id();
            let (tx, rx) = channel();
            self.context.send(Message::CreateWebview {
                window_id,
                webview_id,
                pending,
                tx,
            })?;
            rx.recv().map_err(|_| Error::FailedToReceiveMessage)?
        }

        /// 把任务转发到 runtime 主线程执行。
        fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> Result<()> {
            self.context.send(Message::Task(Box::new(f)))
        }

        fn display_handle(
            &self,
        ) -> std::result::Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError>
        {
            Err(raw_window_handle::HandleError::Unavailable)
        }

        fn primary_monitor(&self) -> Option<Monitor> {
            None
        }

        fn monitor_from_point(&self, _x: f64, _y: f64) -> Option<Monitor> {
            None
        }

        fn available_monitors(&self) -> Vec<Monitor> {
            Vec::new()
        }

        fn cursor_position(&self) -> Result<PhysicalPosition<f64>> {
            Err(Error::FailedToGetCursorPosition)
        }

        fn set_theme(&self, theme: Option<Theme>) {
            let _ = self.context.send(Message::Window(
                0.into(),
                WindowMessage::Set(WindowSet::Theme(theme)),
            ));
        }

        fn set_device_event_filter(&self, _filter: DeviceEventFilter) {}
    }

    impl<T: UserEvent> Runtime<T> for Cef<T> {
        type WindowDispatcher = window::CefWindowDispatcher<T>;
        type WebviewDispatcher = webview::CefWebviewDispatcher<T>;
        type Handle = CefHandle<T>;
        type EventLoopProxy = CefEventLoopProxy<T>;

        /// 创建 runtime。
        ///
        /// Linux CEF 后端允许 any-thread event loop,所以这里直接复用
        /// `new_any_thread`。
        fn new(args: RuntimeInitArgs) -> Result<Self> {
            Self::new_any_thread(args)
        }

        /// 初始化 CEF、创建 tao event loop,并准备 runtime 状态表。
        fn new_any_thread(args: RuntimeInitArgs) -> Result<Self> {
            unsafe {
                std::env::set_var("GDK_BACKEND", "x11");
            }
            let window_mode = WindowMode::from_env();
            eprintln!(
                "[cef-runtime] runtime new_any_thread mode={window_mode:?} initialized={} {}",
                CEF_INITIALIZED.with(Cell::get),
                WindowMode::env_debug_value()
            );
            if !CEF_INITIALIZED.with(Cell::get) {
                let mut app = init_cef_app_and_maybe_exit(false, window_mode);
                initialize_cef(&mut app, window_mode)?;
                PREPARED_CEF_APP.with(|prepared| prepared.replace(Some(app)));
                CEF_INITIALIZED.with(|initialized| initialized.set(true));
            }

            let mut builder = EventLoopBuilder::<Message<T>>::with_user_event();
            builder.with_any_thread(true);
            if let Some(app_id) = args.app_id {
                builder.with_app_id(app_id);
            }
            let event_loop = builder.build();
            let messages = Arc::new(CefMessageQueue::new());
            let windows = Arc::new(CefWindows(RefCell::new(BTreeMap::new())));
            let tao_to_tauri = Arc::new(CefWindowIdMap(RefCell::new(BTreeMap::new())));
            let webviews = Arc::new(CefWebviews(RefCell::new(BTreeMap::new())));
            let context = CefContext {
                tao_proxy: event_loop.create_proxy(),
                messages,
                main_thread_id: current_thread().id(),
                windows: windows.clone(),
                tao_to_tauri: tao_to_tauri.clone(),
                webviews: webviews.clone(),
                main_runtime: Arc::new(AtomicPtr::new(std::ptr::null_mut())),
                next_window_id: Arc::new(AtomicU32::new(1)),
                next_webview_id: Arc::new(AtomicU32::new(1)),
                next_window_event_id: Arc::new(AtomicU32::new(1)),
                next_webview_event_id: Arc::new(AtomicU32::new(1)),
            };

            Ok(Self {
                inner: CefRuntime {
                    context,
                    event_loop,
                    window_mode,
                    windows,
                    tao_to_tauri,
                    webviews,
                    exit_code: Cell::new(0),
                },
            })
        }

        /// 创建可用于投递 Tauri 用户事件的代理。
        fn create_proxy(&self) -> Self::EventLoopProxy {
            CefEventLoopProxy {
                context: self.inner.context.clone(),
            }
        }

        /// 获取 runtime handle,供 Tauri 在运行期创建窗口/webview 或退出。
        fn handle(&self) -> Self::Handle {
            CefHandle {
                context: self.inner.context.clone(),
            }
        }

        /// 同步创建窗口。
        ///
        /// 这是 Tauri `Builder::build` 阶段的主路径；因为已经在主线程,可以直接
        /// 调 `create_window_now`。
        fn create_window<F: Fn(RawWindow) + Send + 'static>(
            &self,
            pending: PendingWindow<T, Self>,
            after_window_creation: Option<F>,
        ) -> Result<DetachedWindow<T, Self>> {
            let window_id = self.inner.context.next_window_id();
            self.inner.create_window_now(
                &self.inner.event_loop,
                window_id,
                pending,
                after_window_creation.map(|f| Box::new(f) as Box<dyn Fn(RawWindow) + Send>),
            )
        }

        /// 同步创建 webview。
        fn create_webview(
            &self,
            window_id: WindowId,
            pending: PendingWebview<T, Self>,
        ) -> Result<DetachedWebview<T, Self>> {
            let webview_id = self.inner.context.next_webview_id();
            self.inner
                .create_webview_now(window_id, webview_id, pending)
        }

        fn primary_monitor(&self) -> Option<Monitor> {
            self.inner
                .event_loop
                .primary_monitor()
                .map(window::monitor_from_tao)
        }

        fn monitor_from_point(&self, x: f64, y: f64) -> Option<Monitor> {
            self.inner
                .event_loop
                .monitor_from_point(x, y)
                .map(window::monitor_from_tao)
        }

        fn available_monitors(&self) -> Vec<Monitor> {
            self.inner
                .event_loop
                .available_monitors()
                .map(window::monitor_from_tao)
                .collect()
        }

        fn cursor_position(&self) -> Result<PhysicalPosition<f64>> {
            self.inner
                .event_loop
                .cursor_position()
                .map_err(|_| Error::FailedToGetCursorPosition)
        }

        fn set_theme(&self, theme: Option<Theme>) {
            self.inner
                .event_loop
                .set_theme(theme.map(window::to_tao_theme));
        }

        fn set_device_event_filter(&mut self, _filter: DeviceEventFilter) {}

        /// 单步驱动 CEF 消息泵并刷新 OSR 脏帧。
        ///
        /// 这里只提供最小实现；应用常规运行使用 `run` / `run_return`。
        fn run_iteration<F: FnMut(RunEvent<T>) + 'static>(&mut self, callback: F) {
            let mut callback = callback;
            if self.inner.window_mode.is_windowed() {
                pump_glib(&MainContext::default());
                do_message_loop_work();
                callback(RunEvent::MainEventsCleared);
                return;
            }
            do_message_loop_work();
            self.inner.blit_all();
            callback(RunEvent::MainEventsCleared);
        }

        /// 运行 tao 主循环,返回应用退出码。
        fn run_return<F: FnMut(RunEvent<T>) + 'static>(self, callback: F) -> i32 {
            self.inner.run_loop(callback, false)
        }

        /// 运行 tao 主循环并以返回码结束进程。
        fn run<F: FnMut(RunEvent<T>) + 'static>(self, callback: F) {
            let code = self.run_return(callback);
            std::process::exit(code);
        }
    }

    impl<T: UserEvent> CefRuntime<T> {
        /// 在主线程立即创建 tao 窗口,并在需要时同步创建首个 webview。
        fn create_window_now(
            &self,
            event_loop: &tao::event_loop::EventLoopWindowTarget<Message<T>>,
            window_id: WindowId,
            pending: PendingWindow<T, Cef<T>>,
            after_window_creation: Option<Box<dyn Fn(RawWindow) + Send>>,
        ) -> Result<DetachedWindow<T, Cef<T>>> {
            eprintln!(
                "[cef-runtime] create_window_now id={window_id:?} label={} mode={:?}",
                pending.label, self.window_mode
            );
            if self.window_mode.is_windowed() {
                return self.create_windowed_window_now(window_id, pending, after_window_creation);
            }

            let label = pending.label.clone();
            let mut pending_webview = pending.webview;
            let use_https_scheme = pending_webview
                .as_ref()
                .map(|w| w.webview_attributes.use_https_scheme)
                .unwrap_or(false);

            let window = window::build_tao_window(event_loop, pending.window_builder)?;
            if let Some(after) = after_window_creation {
                after(window::raw_window_for_callback(&window));
            }

            self.tao_to_tauri
                .0
                .borrow_mut()
                .insert(window.id(), window_id);
            self.windows.0.borrow_mut().insert(
                window_id,
                CefWindowState {
                    label: label.clone(),
                    kind: CefWindowKind::Osr {
                        window: window.clone(),
                    },
                    listeners: Vec::new(),
                    webviews: Vec::new(),
                },
            );

            let detached_webview = if let Some(webview) = pending_webview.take() {
                let webview_id = self.context.next_webview_id();
                let detached = self.create_webview_now(window_id, webview_id, webview)?;
                Some(DetachedWindowWebview {
                    webview: detached,
                    use_https_scheme,
                })
            } else {
                None
            };

            Ok(DetachedWindow {
                id: window_id,
                label,
                dispatcher: window::CefWindowDispatcher {
                    window_id,
                    context: self.context.clone(),
                },
                webview: detached_webview,
            })
        }

        fn create_windowed_window_now(
            &self,
            window_id: WindowId,
            pending: PendingWindow<T, Cef<T>>,
            after_window_creation: Option<Box<dyn Fn(RawWindow) + Send>>,
        ) -> Result<DetachedWindow<T, Cef<T>>> {
            let context = self.context.clone();
            let windows = self.windows.clone();
            let webviews = self.webviews.clone();
            post_cef_ui_task(move || {
                Self::create_windowed_window_on_cef_ui(
                    context,
                    windows,
                    webviews,
                    window_id,
                    pending,
                    after_window_creation,
                )
            })
        }

        fn create_windowed_window_on_cef_ui(
            context: CefContext<T>,
            windows: Arc<CefWindows>,
            webviews: Arc<CefWebviews>,
            window_id: WindowId,
            pending: PendingWindow<T, Cef<T>>,
            after_window_creation: Option<Box<dyn Fn(RawWindow) + Send>>,
        ) -> Result<DetachedWindow<T, Cef<T>>> {
            if after_window_creation.is_some() {
                eprintln!(
                    "[cef-runtime] windowed mode cannot expose a tao RawWindow during create_window"
                );
            }

            let label = pending.label.clone();
            let mut pending_webview = pending.webview;
            let use_https_scheme = pending_webview
                .as_ref()
                .map(|w| w.webview_attributes.use_https_scheme)
                .unwrap_or(false);
            let attrs = pending.window_builder.inner.window.clone();
            let size = tao_size_to_physical(attrs.inner_size, 1024, 768);
            let position = attrs
                .position
                .map(|position| position.to_physical::<i32>(1.0));
            let shared = Arc::new(Mutex::new(WindowedWindowShared {
                window: None,
                browser_view: None,
                browser_view_attached: false,
                quit: windowed_quit(),
            }));

            let mut detached_webview = None;
            let mut webview_id = None;
            if let Some(webview) = pending_webview.take() {
                let id = context.next_webview_id();
                let label = webview.label.clone();
                let (state, browser_view) =
                    webview::create_cef_browser_view(window_id, id, context.clone(), webview)?;
                shared
                    .lock()
                    .expect("windowed state mutex poisoned")
                    .browser_view = Some(webview::CefBrowserView {
                    inner: browser_view,
                });
                webviews.0.borrow_mut().insert(id, state);
                detached_webview = Some(DetachedWindowWebview {
                    webview: webview::detached_webview(label, window_id, id, context.clone()),
                    use_https_scheme,
                });
                webview_id = Some(id);
            }

            let mut delegate = WindowedTopLevelWindowDelegate::new(
                shared.clone(),
                cef::Rect {
                    x: position.map(|p| p.x).unwrap_or(0),
                    y: position.map(|p| p.y).unwrap_or(0),
                    width: size.width as i32,
                    height: size.height as i32,
                },
                initial_show_state(attrs.visible, attrs.maximized, attrs.fullscreen.is_some()),
                !attrs.decorations,
                attrs.resizable,
                attrs.maximizable,
                attrs.minimizable,
                attrs.closable,
            );
            let window = window_create_top_level(Some(&mut delegate)).ok_or_else(|| {
                eprintln!("[cef-runtime] CEF failed to create a top-level Views window");
                Error::CreateWindow
            })?;
            if attrs.always_on_top {
                window.set_always_on_top(1);
            }
            window.set_title(Some(&CefString::from(attrs.title.as_str())));
            {
                let mut shared = shared.lock().expect("windowed state mutex poisoned");
                shared.window = Some(CefWindow {
                    inner: window.clone(),
                });
                if !shared.browser_view_attached {
                    if let Some(browser_view) = shared.browser_view.as_ref() {
                        let mut view = View::from(&browser_view.inner);
                        browser_view.inner.set_size(Some(&cef::Size {
                            width: size.width as i32,
                            height: size.height as i32,
                        }));
                        window.add_child_view(Some(&mut view));
                        shared.browser_view_attached = true;
                    }
                }
            }
            if attrs.visible {
                window.show();
            }
            eprintln!("[cef-runtime] windowed top-level CEF window created and attached");

            let mut webviews = Vec::new();
            if let Some(id) = webview_id {
                webviews.push(id);
            }
            windows.0.borrow_mut().insert(
                window_id,
                CefWindowState {
                    label: label.clone(),
                    kind: CefWindowKind::Windowed(WindowedWindowState {
                        shared,
                        title: attrs.title,
                        size,
                        position,
                        resizable: attrs.resizable,
                        maximizable: attrs.maximizable,
                        minimizable: attrs.minimizable,
                        closable: attrs.closable,
                        decorated: attrs.decorations,
                        visible: attrs.visible,
                        fullscreen: attrs.fullscreen.is_some(),
                        maximized: attrs.maximized,
                        minimized: false,
                        focused: attrs.focused,
                        always_on_top: attrs.always_on_top,
                    }),
                    listeners: Vec::new(),
                    webviews,
                },
            );

            Ok(DetachedWindow {
                id: window_id,
                label,
                dispatcher: window::CefWindowDispatcher { window_id, context },
                webview: detached_webview,
            })
        }

        /// 在已存在的 tao 窗口上创建 CEF windowless webview。
        fn create_webview_now(
            &self,
            window_id: WindowId,
            webview_id: WebviewId,
            pending: PendingWebview<T, Cef<T>>,
        ) -> Result<DetachedWebview<T, Cef<T>>> {
            if self.window_mode.is_windowed() {
                return self.create_windowed_webview_now(window_id, webview_id, pending);
            }

            let window = self
                .windows
                .0
                .borrow()
                .get(&window_id)
                .and_then(|w| match &w.kind {
                    CefWindowKind::Osr { window } => Some(window.clone()),
                    CefWindowKind::Windowed(_) => None,
                })
                .ok_or(Error::WindowNotFound)?;

            let label = pending.label.clone();
            let state = webview::create_cef_webview(
                &window,
                window_id,
                webview_id,
                self.context.clone(),
                pending,
            )?;
            self.webviews.0.borrow_mut().insert(webview_id, state);
            if let Some(window) = self.windows.0.borrow_mut().get_mut(&window_id) {
                window.webviews.push(webview_id);
            }
            Ok(webview::detached_webview(
                label,
                window_id,
                webview_id,
                self.context.clone(),
            ))
        }

        fn create_windowed_webview_now(
            &self,
            window_id: WindowId,
            webview_id: WebviewId,
            pending: PendingWebview<T, Cef<T>>,
        ) -> Result<DetachedWebview<T, Cef<T>>> {
            let context = self.context.clone();
            let windows = self.windows.clone();
            let webviews = self.webviews.clone();
            post_cef_ui_task(move || {
                Self::create_windowed_webview_on_cef_ui(
                    context, windows, webviews, window_id, webview_id, pending,
                )
            })
        }

        fn create_windowed_webview_on_cef_ui(
            context: CefContext<T>,
            windows: Arc<CefWindows>,
            webviews: Arc<CefWebviews>,
            window_id: WindowId,
            webview_id: WebviewId,
            pending: PendingWebview<T, Cef<T>>,
        ) -> Result<DetachedWebview<T, Cef<T>>> {
            let label = pending.label.clone();
            let (state, browser_view) =
                webview::create_cef_browser_view(window_id, webview_id, context.clone(), pending)?;
            let mut window_states = windows.0.borrow_mut();
            let Some(window) = window_states.get_mut(&window_id) else {
                return Err(Error::WindowNotFound);
            };
            let CefWindowKind::Windowed(windowed) = &mut window.kind else {
                return Err(Error::WindowNotFound);
            };
            let mut view = View::from(&browser_view);
            {
                let mut shared = windowed
                    .shared
                    .lock()
                    .expect("windowed state mutex poisoned");
                if let Some(window) = shared.window.as_ref() {
                    window.inner.add_child_view(Some(&mut view));
                    shared.browser_view_attached = true;
                }
                shared.browser_view = Some(webview::CefBrowserView {
                    inner: browser_view,
                });
            }
            window.webviews.push(webview_id);
            drop(window_states);
            webviews.0.borrow_mut().insert(webview_id, state);

            Ok(webview::detached_webview(
                label, window_id, webview_id, context,
            ))
        }

        /// runtime 主循环。
        ///
        /// 每轮循环处理 tao 事件和内部消息,随后调用 `cef::do_message_loop_work`
        /// 驱动 CEF 外部消息泵,最后把所有 OSR 脏帧 blit 到对应 tao 窗口。
        fn run_loop<F: FnMut(RunEvent<T>) + 'static>(mut self, mut callback: F, once: bool) -> i32 {
            if self.window_mode.is_windowed() {
                return self.run_windowed_loop(callback, once);
            }

            eprintln!("[cef-runtime] event loop started");
            let runtime_ptr = &mut self as *mut Self;
            self.context
                .main_runtime
                .store(runtime_ptr, Ordering::Release);
            callback(RunEvent::Ready);

            let this = &self as *const Self;
            self.event_loop
                .run_return(move |event, target, control_flow| {
                    let this = unsafe { &*this };
                    *control_flow = if once {
                        ControlFlow::Exit
                    } else {
                        ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(8))
                    };

                    match event {
                        Event::UserEvent(message) => {
                            this.handle_message(target, message, &mut callback, control_flow);
                        }
                        Event::WindowEvent {
                            window_id, event, ..
                        } => {
                            if let Some(id) = this.tao_to_tauri.0.borrow().get(&window_id).copied()
                            {
                                this.handle_tao_window_event(
                                    id,
                                    event,
                                    &mut callback,
                                    control_flow,
                                );
                            }
                        }
                        Event::MainEventsCleared => {
                            callback(RunEvent::MainEventsCleared);
                        }
                        Event::LoopDestroyed => {
                            eprintln!("[cef-runtime] tao loop destroyed");
                            callback(RunEvent::Exit);
                        }
                        _ => {}
                    }

                    this.drain_messages(target, &mut callback, control_flow);
                    do_message_loop_work();
                    this.blit_all();
                });

            shutdown();
            eprintln!("[cef-runtime] CEF shutdown complete");
            self.context
                .main_runtime
                .store(std::ptr::null_mut(), Ordering::Release);
            self.exit_code.get()
        }

        /// CEF Views windowed 路径的外部消息泵。
        ///
        /// 这条路径不进入 tao `run_return`:CEF Views 自己创建真实窗口,并且
        /// Linux 上必须在同一个主线程持续泵 GLib/X11 和 CEF message loop。
        /// Tauri runtime 消息从 `CefContext` 队列 drain。
        fn run_windowed_loop<F: FnMut(RunEvent<T>) + 'static>(
            mut self,
            mut callback: F,
            once: bool,
        ) -> i32 {
            eprintln!("[cef-runtime] windowed pure CEF/GLib pump started");
            let runtime_ptr = &mut self as *mut Self;
            self.context
                .main_runtime
                .store(runtime_ptr, Ordering::Release);
            callback(RunEvent::Ready);

            let quit = windowed_quit();
            let main_context = MainContext::default();
            loop {
                let mut control_flow = ControlFlow::WaitUntil(
                    Instant::now() + Duration::from_millis(if once { 0 } else { 1 }),
                );
                self.drain_messages(&self.event_loop, &mut callback, &mut control_flow);
                callback(RunEvent::MainEventsCleared);
                let did_glib_work = pump_glib(&main_context);
                do_message_loop_work();

                if matches!(control_flow, ControlFlow::Exit) || once || quit.load(Ordering::Acquire)
                {
                    break;
                }
                if !did_glib_work {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }

            callback(RunEvent::Exit);

            shutdown();
            eprintln!("[cef-runtime] CEF shutdown complete");
            self.context
                .main_runtime
                .store(std::ptr::null_mut(), Ordering::Release);
            self.exit_code.get()
        }

        /// 主线程上的同步 runtime 调用必须立即执行。
        ///
        /// Tauri 会在 `RunEvent::Ready` 回调里通过 `RuntimeHandle` 创建配置窗口；
        /// 如果这时仍把消息投回同一个 tao loop 并等待回复，会造成主线程自锁。
        fn handle_main_thread_message(&self, message: Message<T>) -> Result<()> {
            match message {
                Message::Task(task) => task(),
                Message::CreateWindow {
                    window_id,
                    pending,
                    after_window_creation,
                    tx,
                } => {
                    let _ = tx.send(self.create_window_now(
                        &self.event_loop,
                        window_id,
                        pending,
                        after_window_creation,
                    ));
                }
                Message::CreateWebview {
                    window_id,
                    webview_id,
                    pending,
                    tx,
                } => {
                    let _ = tx.send(self.create_webview_now(window_id, webview_id, pending));
                }
                Message::Window(window_id, message) => {
                    self.handle_window_message(window_id, message, &self.event_loop);
                }
                Message::Webview(webview_id, message) => {
                    self.handle_webview_message(webview_id, message);
                }
                message @ (Message::UserEvent(_) | Message::RequestExit(_)) => {
                    self.context.enqueue(message)?;
                }
                Message::Wake => {}
            }
            Ok(())
        }

        /// 处理 runtime 内部消息。
        ///
        /// 这是跨线程请求进入主线程后的统一入口。
        fn drain_messages<F: FnMut(RunEvent<T>) + 'static>(
            &self,
            target: &tao::event_loop::EventLoopWindowTarget<Message<T>>,
            callback: &mut F,
            control_flow: &mut ControlFlow,
        ) {
            while let Some(message) = self.context.pop_message() {
                self.handle_message(target, message, callback, control_flow);
                if matches!(*control_flow, ControlFlow::Exit) {
                    break;
                }
            }
        }

        fn handle_message<F: FnMut(RunEvent<T>) + 'static>(
            &self,
            target: &tao::event_loop::EventLoopWindowTarget<Message<T>>,
            message: Message<T>,
            callback: &mut F,
            control_flow: &mut ControlFlow,
        ) {
            match message {
                Message::UserEvent(event) => callback(RunEvent::UserEvent(event)),
                Message::Wake => {}
                Message::Task(task) => task(),
                Message::RequestExit(code) => {
                    let (tx, rx) = channel();
                    callback(RunEvent::ExitRequested {
                        code: Some(code),
                        tx,
                    });
                    if !matches!(rx.try_recv(), Ok(ExitRequestedEventAction::Prevent)) {
                        self.exit_code.set(code);
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Message::CreateWindow {
                    window_id,
                    pending,
                    after_window_creation,
                    tx,
                } => {
                    let _ = tx.send(self.create_window_now(
                        target,
                        window_id,
                        pending,
                        after_window_creation,
                    ));
                }
                Message::CreateWebview {
                    window_id,
                    webview_id,
                    pending,
                    tx,
                } => {
                    let _ = tx.send(self.create_webview_now(window_id, webview_id, pending));
                }
                Message::Window(window_id, message) => {
                    self.handle_window_message(window_id, message, target)
                }
                Message::Webview(webview_id, message) => {
                    self.handle_webview_message(webview_id, message)
                }
            }
        }

        /// 把 tao 原生窗口事件转换为 Tauri `RunEvent::WindowEvent`。
        ///
        /// CloseRequested 需要特殊处理,因为 Tauri 允许监听器阻止关闭。
        fn handle_tao_window_event<F: FnMut(RunEvent<T>) + 'static>(
            &self,
            window_id: WindowId,
            event: TaoWindowEvent<'_>,
            callback: &mut F,
            control_flow: &mut ControlFlow,
        ) {
            if let Some(window) = self.windows.0.borrow().get(&window_id) {
                match &event {
                    TaoWindowEvent::CloseRequested => {
                        let (tx, rx) = channel();
                        let event = WindowEvent::CloseRequested { signal_tx: tx };
                        for (_, listener) in &window.listeners {
                            listener(&event);
                        }
                        callback(RunEvent::WindowEvent {
                            label: window.label.clone(),
                            event,
                        });
                        if rx.try_recv().unwrap_or(false) {
                            return;
                        }
                        *control_flow = ControlFlow::Exit;
                    }
                    TaoWindowEvent::Resized(size) => {
                        for webview_id in &window.webviews {
                            if let Some(webview) = self.webviews.0.borrow().get(webview_id) {
                                if webview.auto_resize {
                                    let scale_factor = match &window.kind {
                                        CefWindowKind::Osr { window } => window.scale_factor(),
                                        CefWindowKind::Windowed(_) => 1.0,
                                    };
                                    webview::resize_webview(
                                        webview,
                                        size.width,
                                        size.height,
                                        scale_factor,
                                    );
                                }
                            }
                        }
                        self.emit_window_event(window_id, &event, callback);
                    }
                    TaoWindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                    } => {
                        for webview_id in &window.webviews {
                            if let Some(webview) = self.webviews.0.borrow().get(webview_id) {
                                if webview.auto_resize {
                                    webview::resize_webview(
                                        webview,
                                        new_inner_size.width,
                                        new_inner_size.height,
                                        *scale_factor,
                                    );
                                }
                            }
                        }
                        self.emit_window_event(window_id, &event, callback);
                    }
                    _ => self.emit_window_event(window_id, &event, callback),
                }

                if let CefWindowKind::Osr { window: tao_window } = &window.kind {
                    let scale_factor = tao_window.scale_factor();
                    let mut webviews = self.webviews.0.borrow_mut();
                    for webview_id in &window.webviews {
                        if let Some(webview) = webviews.get_mut(webview_id) {
                            webview::handle_window_input(webview, &event, scale_factor);
                        }
                    }
                }
            }
        }

        /// 发送普通窗口事件给窗口监听器和 Tauri runtime 回调。
        fn emit_window_event<F: FnMut(RunEvent<T>) + 'static>(
            &self,
            window_id: WindowId,
            event: &TaoWindowEvent<'_>,
            callback: &mut F,
        ) {
            let Some(mapped) = window::map_window_event(event) else {
                return;
            };
            if let Some(window) = self.windows.0.borrow().get(&window_id) {
                for (_, listener) in &window.listeners {
                    listener(&mapped);
                }
                callback(RunEvent::WindowEvent {
                    label: window.label.clone(),
                    event: mapped,
                });
            }
        }

        /// 处理某个窗口的 getter/setter/listener 消息。
        fn handle_window_message(
            &self,
            window_id: WindowId,
            message: WindowMessage,
            target: &tao::event_loop::EventLoopWindowTarget<Message<T>>,
        ) {
            let mut windows = self.windows.0.borrow_mut();
            let Some(state) = windows.get_mut(&window_id) else {
                return;
            };
            match message {
                WindowMessage::AddEventListener(id, listener) => {
                    state.listeners.push((id, listener));
                }
                WindowMessage::Get(kind, tx) => {
                    let _ = tx.send(self.window_get(state, kind, target));
                }
                WindowMessage::MonitorFromPoint(tx, x, y) => {
                    let _ = tx.send(target.monitor_from_point(x, y));
                }
                WindowMessage::Set(set) => apply_window_set(&mut state.kind, set),
                WindowMessage::Center => {}
                WindowMessage::RequestUserAttention(request_type) => {
                    if let CefWindowKind::Osr { window } = &state.kind {
                        window.request_user_attention(request_type);
                    }
                }
            }
        }

        /// 执行窗口 getter,返回装箱结果供 dispatcher downcast。
        fn window_get(
            &self,
            state: &CefWindowState,
            kind: WindowGetterKind,
            target: &tao::event_loop::EventLoopWindowTarget<Message<T>>,
        ) -> Result<Box<dyn Any + Send>> {
            use tao::platform::unix::WindowExtUnix;
            let value: Box<dyn Any + Send> = match kind {
                WindowGetterKind::ScaleFactor => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.scale_factor()),
                    CefWindowKind::Windowed(_) => Box::new(1.0),
                },
                WindowGetterKind::InnerPosition | WindowGetterKind::OuterPosition => {
                    match &state.kind {
                        CefWindowKind::Osr { window } => Box::new(
                            window
                                .inner_position()
                                .map(|p| PhysicalPosition::new(p.x, p.y))
                                .map_err(|_| Error::CreateWindow)?,
                        ),
                        CefWindowKind::Windowed(window) => {
                            Box::new(window.position.unwrap_or(PhysicalPosition::new(0, 0)))
                        }
                    }
                }
                WindowGetterKind::InnerSize | WindowGetterKind::OuterSize => match &state.kind {
                    CefWindowKind::Osr { window } => {
                        let s = window.inner_size();
                        Box::new(PhysicalSize::new(s.width, s.height))
                    }
                    CefWindowKind::Windowed(window) => Box::new(window.size),
                },
                WindowGetterKind::IsFullscreen => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.fullscreen().is_some()),
                    CefWindowKind::Windowed(window) => Box::new(window.fullscreen),
                },
                WindowGetterKind::IsMinimized => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_minimized()),
                    CefWindowKind::Windowed(window) => Box::new(window.minimized),
                },
                WindowGetterKind::IsMaximized => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_maximized()),
                    CefWindowKind::Windowed(window) => Box::new(window.maximized),
                },
                WindowGetterKind::IsFocused => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_focused()),
                    CefWindowKind::Windowed(window) => Box::new(window.focused),
                },
                WindowGetterKind::IsDecorated => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_decorated()),
                    CefWindowKind::Windowed(window) => Box::new(window.decorated),
                },
                WindowGetterKind::IsResizable => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_resizable()),
                    CefWindowKind::Windowed(window) => Box::new(window.resizable),
                },
                WindowGetterKind::IsMaximizable => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_maximizable()),
                    CefWindowKind::Windowed(window) => Box::new(window.maximizable),
                },
                WindowGetterKind::IsMinimizable => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_minimizable()),
                    CefWindowKind::Windowed(window) => Box::new(window.minimizable),
                },
                WindowGetterKind::IsClosable => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_closable()),
                    CefWindowKind::Windowed(window) => Box::new(window.closable),
                },
                WindowGetterKind::IsVisible => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.is_visible()),
                    CefWindowKind::Windowed(window) => Box::new(window.visible),
                },
                WindowGetterKind::IsEnabled => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.gtk_window().is_sensitive()),
                    CefWindowKind::Windowed(_) => Box::new(true),
                },
                WindowGetterKind::IsAlwaysOnTop => match &state.kind {
                    CefWindowKind::Osr { .. } => Box::new(false),
                    CefWindowKind::Windowed(window) => Box::new(window.always_on_top),
                },
                WindowGetterKind::Title => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.title()),
                    CefWindowKind::Windowed(window) => Box::new(window.title.clone()),
                },
                WindowGetterKind::CurrentMonitor => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(window.current_monitor()),
                    CefWindowKind::Windowed(_) => Box::new(None::<tao::monitor::MonitorHandle>),
                },
                WindowGetterKind::PrimaryMonitor => Box::new(target.primary_monitor()),
                WindowGetterKind::AvailableMonitors => {
                    Box::new(target.available_monitors().collect::<Vec<_>>())
                }
                WindowGetterKind::GtkWindow => match &state.kind {
                    CefWindowKind::Osr { window } => {
                        Box::new(GtkWindow(window.gtk_window().clone()))
                    }
                    CefWindowKind::Windowed(_) => return Err(Error::CreateWindow),
                },
                WindowGetterKind::GtkBox => match &state.kind {
                    CefWindowKind::Osr { window } => {
                        Box::new(GtkBox(window.default_vbox().unwrap().clone()))
                    }
                    CefWindowKind::Windowed(_) => return Err(Error::CreateWindow),
                },
                WindowGetterKind::RawWindowHandle => match &state.kind {
                    CefWindowKind::Osr { window } => Box::new(
                        window
                            .window_handle()
                            .map(|h| SendRawWindowHandle(h.as_raw())),
                    ),
                    CefWindowKind::Windowed(_) => {
                        Box::new(Err::<SendRawWindowHandle, raw_window_handle::HandleError>(
                            raw_window_handle::HandleError::Unavailable,
                        ))
                    }
                },
                WindowGetterKind::Theme => match &state.kind {
                    CefWindowKind::Osr { window } => {
                        Box::new(window::from_tao_theme(window.theme()))
                    }
                    CefWindowKind::Windowed(_) => Box::new(Theme::Light),
                },
            };
            Ok(value)
        }

        /// 处理某个 CEF webview 的运行期操作。
        fn handle_webview_message(&self, webview_id: WebviewId, message: WebviewMessage) {
            let mut webviews = self.webviews.0.borrow_mut();
            let Some(state) = webviews.get_mut(&webview_id) else {
                return;
            };
            match message {
                WebviewMessage::AddEventListener(id, listener) => {
                    state.listeners.push((id, listener))
                }
                WebviewMessage::Get(kind, tx) => {
                    let _ = tx.send(webview_get(state, kind));
                }
                WebviewMessage::WithWebview(f) => f(Box::new(())),
                WebviewMessage::OpenDevTools => {
                    if let Some(host) = state.resolve_browser().and_then(|b| b.host()) {
                        host.show_dev_tools(
                            Some(&WindowInfo::default()),
                            None,
                            Some(&BrowserSettings::default()),
                            None,
                        );
                    }
                }
                WebviewMessage::CloseDevTools => {
                    if let Some(host) = state.resolve_browser().and_then(|b| b.host()) {
                        host.close_dev_tools();
                    }
                }
                WebviewMessage::Navigate(url) => {
                    if let Some(frame) = state.resolve_browser().and_then(|b| b.main_frame()) {
                        frame.load_url(Some(&CefString::from(url.as_str())));
                        state.url = url;
                    }
                }
                WebviewMessage::Reload => {
                    if let Some(browser) = state.resolve_browser() {
                        browser.reload();
                    }
                }
                WebviewMessage::Close => {
                    if let Some(host) = state.resolve_browser().and_then(|b| b.host()) {
                        host.close_browser(1);
                    }
                }
                WebviewMessage::SetSize(size) => {
                    let (w, h) = match size {
                        Size::Physical(s) => (s.width, s.height),
                        Size::Logical(s) => (s.width as u32, s.height as u32),
                    };
                    let scale_factor = state
                        .osr
                        .as_ref()
                        .map(|osr| osr.scale_factor.get() as f64)
                        .unwrap_or(1.0);
                    webview::resize_webview(state, w, h, scale_factor);
                }
                WebviewMessage::SetFocus => {
                    if let Some(host) = state.resolve_browser().and_then(|b| b.host()) {
                        host.set_focus(1);
                    }
                }
                WebviewMessage::SetVisible(visible) => {
                    if let Some(browser_view) = &state.browser_view {
                        browser_view.inner.set_visible(i32::from(visible));
                    }
                    state.visible = visible;
                }
                WebviewMessage::Eval(script) => {
                    if let Some(frame) = state.resolve_browser().and_then(|b| b.main_frame()) {
                        frame.execute_java_script(
                            Some(&CefString::from(script.as_str())),
                            Some(&CefString::from(state.url.as_str())),
                            0,
                        );
                    }
                }
                WebviewMessage::SetAutoResize(auto_resize) => state.auto_resize = auto_resize,
                WebviewMessage::SetZoom(scale_factor) => {
                    if let Some(host) = state.resolve_browser().and_then(|b| b.host()) {
                        host.set_zoom_level(scale_factor);
                    }
                }
            }
        }

        /// 遍历所有 webview,把 CEF OSR 最新脏帧呈现到对应窗口。
        fn blit_all(&self) {
            let windows = self.windows.0.borrow();
            let webviews = self.webviews.0.borrow();
            for window in windows.values() {
                if let CefWindowKind::Osr { window: tao_window } = &window.kind {
                    for id in &window.webviews {
                        if let Some(webview) = webviews.get(id) {
                            webview::blit(tao_window, webview);
                        }
                    }
                }
            }
        }
    }

    /// 执行 webview getter,返回装箱结果供 dispatcher downcast。
    fn webview_get(
        state: &webview::CefWebviewState,
        kind: WebviewGetterKind,
    ) -> Result<Box<dyn Any + Send>> {
        let value: Box<dyn Any + Send> = match kind {
            WebviewGetterKind::Url => Box::new(state.url.clone()),
            WebviewGetterKind::Size => {
                if let Some(osr) = &state.osr {
                    let (w, h) = *osr.size.borrow();
                    Box::new(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))
                } else if let Some(browser_view) = &state.browser_view {
                    let size = browser_view.inner.size();
                    Box::new(PhysicalSize::new(
                        size.width.max(1) as u32,
                        size.height.max(1) as u32,
                    ))
                } else {
                    Box::new(PhysicalSize::new(1, 1))
                }
            }
            WebviewGetterKind::DevToolsOpen => Box::new(
                state
                    .resolve_browser()
                    .and_then(|browser| browser.host())
                    .is_some_and(|host| host.has_dev_tools() == 1),
            ),
        };
        Ok(value)
    }

    fn pump_glib(main_context: &MainContext) -> bool {
        let mut did_glib_work = false;
        while main_context.pending() {
            did_glib_work |= main_context.iteration(false);
        }
        did_glib_work
    }

    fn post_cef_ui_task<R, F>(task: F) -> Result<R>
    where
        R: Send + 'static,
        F: FnOnce() -> Result<R> + Send + 'static,
    {
        // 必须先等 CEF browser-process 上下文初始化完成,否则在 `on_context_initialized`
        // 之前发起的 `browser_view_create` / `window_create_top_level` 会因上下文未就绪
        // 而卡死(post 的任务在 do_message_loop_work 里 FIFO 执行,可能排在
        // on_context_initialized 之前)。在 UI 线程上同步 pump 直到 flag 置位。
        {
            let main_context = MainContext::default();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !WINDOWED_CONTEXT_INITIALIZED.load(Ordering::Acquire) {
                if Instant::now() >= deadline {
                    eprintln!(
                        "[cef-runtime] timed out waiting for windowed CEF context initialization"
                    );
                    return Err(Error::CreateWindow);
                }
                pump_glib(&main_context);
                do_message_loop_work();
                std::thread::sleep(Duration::from_millis(1));
            }
        }

        let (tx, rx) = channel();
        let callback: CefUiTaskCallback = Box::new(move || {
            let _ = tx.send(task());
        });
        let mut task = CefUiTask::new(Arc::new(Mutex::new(Some(callback))));
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            return Err(Error::CreateWindow);
        }

        let main_context = MainContext::default();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(result) => return result,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(Error::FailedToReceiveMessage);
                }
            }
            pump_glib(&main_context);
            do_message_loop_work();
            std::thread::sleep(Duration::from_millis(1));
        }

        Err(Error::CreateWindow)
    }

    fn tao_size_to_physical(
        size: Option<tao::dpi::Size>,
        default_w: u32,
        default_h: u32,
    ) -> PhysicalSize<u32> {
        size.map(|size| size.to_physical::<u32>(1.0))
            .unwrap_or_else(|| PhysicalSize::new(default_w, default_h))
    }

    fn runtime_size_to_physical(size: Size) -> PhysicalSize<u32> {
        match size {
            Size::Physical(size) => size,
            Size::Logical(size) => PhysicalSize::new(size.width as u32, size.height as u32),
        }
    }

    fn runtime_position_to_physical(position: Position) -> PhysicalPosition<i32> {
        match position {
            Position::Physical(position) => position,
            Position::Logical(position) => {
                PhysicalPosition::new(position.x as i32, position.y as i32)
            }
        }
    }

    fn initial_show_state(visible: bool, maximized: bool, fullscreen: bool) -> ShowState {
        if !visible {
            ShowState::HIDDEN
        } else if fullscreen {
            ShowState::FULLSCREEN
        } else if maximized {
            ShowState::MAXIMIZED
        } else {
            ShowState::NORMAL
        }
    }

    /// 把 runtime 的窗口命令映射到当前窗口后端 API。
    fn apply_window_set(kind: &mut CefWindowKind, set: WindowSet) {
        match kind {
            CefWindowKind::Osr { window } => apply_tao_window_set(window, set),
            CefWindowKind::Windowed(window) => apply_windowed_window_set(window, set),
        }
    }

    fn apply_tao_window_set(window: &TaoWindow, set: WindowSet) {
        match set {
            WindowSet::Resizable(v) => window.set_resizable(v),
            WindowSet::Enabled(v) => {
                use tao::platform::unix::WindowExtUnix;
                window.gtk_window().set_sensitive(v);
            }
            WindowSet::Maximizable(v) => window.set_maximizable(v),
            WindowSet::Minimizable(v) => window.set_minimizable(v),
            WindowSet::Closable(v) => window.set_closable(v),
            WindowSet::Title(v) => window.set_title(&v),
            WindowSet::Maximize => window.set_maximized(true),
            WindowSet::Unmaximize => window.set_maximized(false),
            WindowSet::Minimize => window.set_minimized(true),
            WindowSet::Unminimize => window.set_minimized(false),
            WindowSet::Show => window.set_visible(true),
            WindowSet::Hide => window.set_visible(false),
            WindowSet::Close | WindowSet::Destroy => window.set_visible(false),
            WindowSet::Decorations(v) => window.set_decorations(v),
            WindowSet::AlwaysOnBottom(v) => window.set_always_on_bottom(v),
            WindowSet::AlwaysOnTop(v) => window.set_always_on_top(v),
            WindowSet::VisibleOnAllWorkspaces(v) => window.set_visible_on_all_workspaces(v),
            WindowSet::ContentProtected(v) => window.set_content_protection(v),
            WindowSet::Size(v) => window.set_inner_size(window::to_tao_size(v)),
            WindowSet::MinSize(v) => window.set_min_inner_size(v.map(window::to_tao_size)),
            WindowSet::MaxSize(v) => window.set_max_inner_size(v.map(window::to_tao_size)),
            WindowSet::SizeConstraints(_c) => {}
            WindowSet::Position(v) => window.set_outer_position(window::to_tao_position(v)),
            WindowSet::Fullscreen(v) => {
                window.set_fullscreen(v.then_some(tao::window::Fullscreen::Borderless(None)))
            }
            WindowSet::Focus => window.set_focus(),
            WindowSet::Focusable(v) => window.set_focusable(v),
            WindowSet::Icon(v) => window.set_window_icon(Some(v)),
            WindowSet::SkipTaskbar(v) => {
                let _ = window.set_skip_taskbar(v);
            }
            WindowSet::CursorGrab(v) => {
                let _ = window.set_cursor_grab(v);
            }
            WindowSet::CursorVisible(v) => window.set_cursor_visible(v),
            WindowSet::CursorIcon(v) => window.set_cursor_icon(v),
            WindowSet::CursorPosition(v) => {
                let _ = window.set_cursor_position(window::to_tao_position(v));
            }
            WindowSet::IgnoreCursorEvents(v) => {
                let _ = window.set_ignore_cursor_events(v);
            }
            WindowSet::StartDragging => {
                let _ = window.drag_window();
            }
            WindowSet::StartResizeDragging(direction) => {
                let _ = window.drag_resize_window(direction);
            }
            WindowSet::Theme(theme) => window.set_theme(theme.map(window::to_tao_theme)),
        }
    }

    fn apply_windowed_window_set(window: &mut WindowedWindowState, set: WindowSet) {
        let shared = window.shared.lock().expect("windowed state mutex poisoned");
        let cef_window = shared.window.as_ref().map(|window| &window.inner);
        match set {
            WindowSet::Resizable(v) => window.resizable = v,
            WindowSet::Enabled(_) => {}
            WindowSet::Maximizable(v) => window.maximizable = v,
            WindowSet::Minimizable(v) => window.minimizable = v,
            WindowSet::Closable(v) => window.closable = v,
            WindowSet::Title(v) => {
                if let Some(cef_window) = cef_window {
                    cef_window.set_title(Some(&CefString::from(v.as_str())));
                }
                window.title = v;
            }
            WindowSet::Maximize => {
                if let Some(cef_window) = cef_window {
                    cef_window.maximize();
                }
                window.maximized = true;
                window.minimized = false;
            }
            WindowSet::Unmaximize => {
                if let Some(cef_window) = cef_window {
                    cef_window.restore();
                }
                window.maximized = false;
            }
            WindowSet::Minimize => {
                if let Some(cef_window) = cef_window {
                    cef_window.minimize();
                }
                window.minimized = true;
            }
            WindowSet::Unminimize => {
                if let Some(cef_window) = cef_window {
                    cef_window.restore();
                }
                window.minimized = false;
            }
            WindowSet::Show => {
                if let Some(cef_window) = cef_window {
                    cef_window.show();
                }
                window.visible = true;
            }
            WindowSet::Hide => {
                if let Some(cef_window) = cef_window {
                    cef_window.hide();
                }
                window.visible = false;
            }
            WindowSet::Close | WindowSet::Destroy => {
                if let Some(cef_window) = cef_window {
                    cef_window.close();
                }
                window.visible = false;
            }
            WindowSet::Decorations(v) => window.decorated = v,
            WindowSet::AlwaysOnBottom(_) => {}
            WindowSet::AlwaysOnTop(v) => {
                if let Some(cef_window) = cef_window {
                    cef_window.set_always_on_top(i32::from(v));
                }
                window.always_on_top = v;
            }
            WindowSet::VisibleOnAllWorkspaces(_) => {}
            WindowSet::ContentProtected(_) => {}
            WindowSet::Size(v) => {
                let size = runtime_size_to_physical(v);
                if let Some(cef_window) = cef_window {
                    cef_window.set_bounds(Some(&cef::Rect {
                        x: window.position.map(|p| p.x).unwrap_or(0),
                        y: window.position.map(|p| p.y).unwrap_or(0),
                        width: size.width as i32,
                        height: size.height as i32,
                    }));
                }
                window.size = size;
            }
            WindowSet::MinSize(_) | WindowSet::MaxSize(_) | WindowSet::SizeConstraints(_) => {}
            WindowSet::Position(v) => {
                let position = runtime_position_to_physical(v);
                if let Some(cef_window) = cef_window {
                    cef_window.set_bounds(Some(&cef::Rect {
                        x: position.x,
                        y: position.y,
                        width: window.size.width as i32,
                        height: window.size.height as i32,
                    }));
                }
                window.position = Some(position);
            }
            WindowSet::Fullscreen(v) => {
                if let Some(cef_window) = cef_window {
                    cef_window.set_fullscreen(i32::from(v));
                }
                window.fullscreen = v;
            }
            WindowSet::Focus => {
                if let Some(cef_window) = cef_window {
                    cef_window.activate();
                }
                window.focused = true;
            }
            WindowSet::Focusable(_) => {}
            WindowSet::Icon(_) => {}
            WindowSet::SkipTaskbar(_) => {}
            WindowSet::CursorGrab(_) => {}
            WindowSet::CursorVisible(_) => {}
            WindowSet::CursorIcon(_) => {}
            WindowSet::CursorPosition(_) => {}
            WindowSet::IgnoreCursorEvents(_) => {}
            WindowSet::StartDragging => {}
            WindowSet::StartResizeDragging(_) => {}
            WindowSet::Theme(_) => {}
        }
    }
}

#[cfg(feature = "cef-backend")]
pub use imp::*;
