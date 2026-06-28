//! Minimal CEF-owned top-level window experiment.
//!
//! This intentionally does not use tao, software compositing, or dmabuf import. It
//! exercises the route that worked in the upstream `cefsimple` baseline: let CEF
//! create and own a top-level Views window, with GPU enabled.
//!
//! Run:
//! ```sh
//! export CEF_PATH="$HOME/.local/share/cef"
//! export LD_LIBRARY_PATH="$CEF_PATH:$LD_LIBRARY_PATH"
//! CEF_WINDOWED_URL=file:///tmp/cef-gpu-readback.html \
//!   cargo run -p tauri-runtime-cef --example minimal_windowed
//!
//! # Same CEF-owned window, but with an external message pump like the runtime.
//! CEF_WINDOWED_PUMP=external \
//! CEF_WINDOWED_URL=file:///tmp/cef-gpu-readback.html \
//!   cargo run -p tauri-runtime-cef --example minimal_windowed
//! ```

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("`minimal_windowed` example is Linux-only.");
}

#[cfg(target_os = "linux")]
fn main() {
    // Keep this baseline on X11/XWayland, matching the known-working cefsimple
    // environment and avoiding Wayland/Ozone as a second variable.
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    minimal_windowed::run();
}

#[cfg(target_os = "linux")]
mod minimal_windowed {
    use cef::{args::Args, *};
    use gtk::glib::MainContext;
    use std::cell::RefCell;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum PumpMode {
        Cef,
        External,
    }

    impl PumpMode {
        fn from_env() -> Self {
            match std::env::var("CEF_WINDOWED_PUMP").as_deref() {
                Ok("external") => Self::External,
                _ => Self::Cef,
            }
        }

        fn uses_external_pump(self) -> bool {
            matches!(self, Self::External)
        }
    }

    wrap_app! {
        struct WindowedApp {
            quit: Arc<AtomicBool>,
        }

        impl App {
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

                // Default to the Vulkan/ANGLE stack validated for this NVIDIA setup.
                // on this NVIDIA box. Set CEF_WINDOWED_GPU_MODE=default to leave
                // Chromium's normal GPU choice untouched.
                if std::env::var("CEF_WINDOWED_GPU_MODE").as_deref() != Ok("default") {
                    cl.append_switch_with_value(
                        Some(&CefString::from("use-angle")),
                        Some(&CefString::from("vulkan")),
                    );
                    cl.append_switch_with_value(
                        Some(&CefString::from("enable-features")),
                        Some(&CefString::from("Vulkan")),
                    );
                }
            }

            fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
                Some(WindowedBrowserProcessHandler::new(
                    RefCell::new(None),
                    self.quit.clone(),
                ))
            }
        }
    }

    wrap_window_delegate! {
        struct TopLevelWindowDelegate {
            browser_view: RefCell<Option<BrowserView>>,
        }

        impl ViewDelegate {
            fn preferred_size(&self, _view: Option<&mut View>) -> Size {
                Size {
                    width: 1024,
                    height: 768,
                }
            }
        }

        impl PanelDelegate {}

        impl WindowDelegate {
            fn on_window_created(&self, window: Option<&mut Window>) {
                let browser_view = self.browser_view.borrow();
                let (Some(window), Some(browser_view)) = (window, browser_view.as_ref()) else {
                    return;
                };
                let mut view = View::from(browser_view);
                window.add_child_view(Some(&mut view));
                window.show();
                println!("[windowed] top-level CEF window shown");
            }

            fn on_window_destroyed(&self, _window: Option<&mut Window>) {
                *self.browser_view.borrow_mut() = None;
            }

            fn can_close(&self, _window: Option<&mut Window>) -> i32 {
                let browser_view = self.browser_view.borrow();
                let Some(browser_view) = browser_view.as_ref() else {
                    return 1;
                };
                let Some(browser) = browser_view.browser() else {
                    return 1;
                };
                let Some(host) = browser.host() else {
                    return 1;
                };
                host.try_close_browser()
            }
        }
    }

    wrap_browser_view_delegate! {
        struct TopLevelBrowserViewDelegate {}

        impl ViewDelegate {}

        impl BrowserViewDelegate {}
    }

    wrap_client! {
        struct WindowedClient {
            life_span_handler: LifeSpanHandler,
            load_handler: LoadHandler,
            display_handler: DisplayHandler,
        }

        impl Client {
            fn life_span_handler(&self) -> Option<LifeSpanHandler> {
                Some(self.life_span_handler.clone())
            }

            fn load_handler(&self) -> Option<LoadHandler> {
                Some(self.load_handler.clone())
            }

            fn display_handler(&self) -> Option<DisplayHandler> {
                Some(self.display_handler.clone())
            }
        }
    }

    // Forward page diagnostics to the terminal so media capability tests do
    // not depend on DevTools being open.
    wrap_display_handler! {
        struct WindowedConsoleDisplayHandler;

        impl DisplayHandler {
            fn on_console_message(
                &self,
                _browser: Option<&mut Browser>,
                level: LogSeverity,
                message: Option<&CefString>,
                source: Option<&CefString>,
                line: ::std::os::raw::c_int,
            ) -> ::std::os::raw::c_int {
                println!(
                    "[windowed][console][{level:?}] {}:{} {}",
                    source.map(CefString::to_string).unwrap_or_default(),
                    line,
                    message.map(CefString::to_string).unwrap_or_default(),
                );
                0
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
                println!("[windowed] browser created; runtime_style={runtime_style:?}");
            }

            fn on_before_close(&self, _browser: Option<&mut Browser>) {
                println!("[windowed] browser closed; quitting message loop");
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
                println!(
                    "[windowed] load error: code={:?} text={} url={}",
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
            fn on_schedule_message_pump_work(&self, delay_ms: i64) {
                if PumpMode::from_env().uses_external_pump() {
                    println!("[windowed] schedule message pump delay_ms={delay_ms}");
                }
            }

            fn on_context_initialized(&self) {
                let url = CefString::from(
                    std::env::var("CEF_WINDOWED_URL")
                        .unwrap_or_else(|_| "file:///tmp/cef-test.html".to_string())
                        .as_str(),
                );
                let gpu_mode = std::env::var("CEF_WINDOWED_GPU_MODE")
                    .unwrap_or_else(|_| "vulkan".to_string());
                println!("[windowed] url={url} gpu_mode={gpu_mode}");

                *self.client.borrow_mut() = Some(WindowedClient::new(
                    WindowedLifeSpanHandler::new(self.quit.clone()),
                    WindowedLoadHandler::new(),
                    WindowedConsoleDisplayHandler::new(),
                ));

                let settings = BrowserSettings::default();
                let mut client = self.client.borrow().clone();
                let mut browser_view_delegate = TopLevelBrowserViewDelegate::new();
                let browser_view = browser_view_create(
                    client.as_mut(),
                    Some(&url),
                    Some(&settings),
                    None,
                    None,
                    Some(&mut browser_view_delegate),
                );
                println!("[windowed] browser_view created = {}", browser_view.is_some());

                let mut window_delegate = TopLevelWindowDelegate::new(RefCell::new(browser_view));
                let window = window_create_top_level(Some(&mut window_delegate));
                println!("[windowed] window_create_top_level = {}", window.is_some());
            }
        }
    }

    pub fn run() {
        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let args = Args::new();
        let cmd = args.as_cmd_line().expect("failed to parse command line");
        let is_browser_process = cmd.has_switch(Some(&CefString::from("type"))) != 1;
        let quit = Arc::new(AtomicBool::new(false));
        let pump_mode = PumpMode::from_env();

        let mut app = WindowedApp::new(quit.clone());
        let code = execute_process(
            Some(args.as_main_args()),
            Some(&mut app),
            std::ptr::null_mut(),
        );
        if !is_browser_process {
            std::process::exit(code.max(0));
        }
        assert_eq!(
            code, -1,
            "browser process: execute_process should return -1"
        );

        let mut settings = Settings {
            no_sandbox: 1,
            external_message_pump: pump_mode.uses_external_pump() as i32,
            root_cache_path: CefString::from(
                std::env::var_os("CEF_WINDOWED_CACHE_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::env::temp_dir().join("tauri-runtime-cef-windowed"))
                    .to_str()
                    .unwrap_or(""),
            ),
            ..Default::default()
        };
        if let Ok(cef_path) = std::env::var("CEF_PATH") {
            if !cef_path.is_empty() {
                settings.resources_dir_path = CefString::from(cef_path.as_str());
                settings.locales_dir_path = CefString::from(format!("{cef_path}/locales").as_str());
            }
        }

        assert_eq!(
            initialize(
                Some(args.as_main_args()),
                Some(&settings),
                Some(&mut app),
                std::ptr::null_mut(),
            ),
            1,
            "cef::initialize failed"
        );

        match pump_mode {
            PumpMode::Cef => {
                println!("[windowed] using cef run_message_loop");
                run_message_loop();
            }
            PumpMode::External => run_external_pump(&quit),
        }
        shutdown();
    }

    fn pump_glib(main_context: &MainContext) -> bool {
        let mut did_glib_work = false;
        while main_context.pending() {
            did_glib_work |= main_context.iteration(false);
        }
        did_glib_work
    }

    fn run_external_pump(quit: &AtomicBool) {
        println!("[windowed] using external message pump + glib main context");
        let main_context = MainContext::default();
        while !quit.load(Ordering::Acquire) {
            let did_glib_work = pump_glib(&main_context);
            do_message_loop_work();
            if !did_glib_work {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
}
