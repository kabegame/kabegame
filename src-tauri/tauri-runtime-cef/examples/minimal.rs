//! Phase 2 — 最小运行时闭环(OSR 离屏渲染 + tao)。
//!
//! 背景(见 README §7 / 根计划):在本机 NVIDIA + XWayland 上,把 CEF 作为子窗口
//! parent 进 tao 的 GTK/X11 窗口会双重失败 —— GPU 进程 SIGSEGV(exit 139),
//! 回退软件呈现器又对 X11 子窗口 `XGetWindowAttributes failed`,只画出背景。
//! 而 CEF **自建窗口**时 GPU/软件都满屏正确。结论:问题在"parent 子窗口"这条路。
//!
//! 因此 Phase 2 改走 **OSR(off-screen rendering)**:
//!   1. CEF 以 windowless 模式把页面**软件光栅**到一块 BGRA 像素 buffer
//!      (`CefRenderHandler::on_paint`),完全不创建 X11 窗口、不碰会崩的 GPU 进程。
//!   2. 我们用 `softbuffer` 把这块 buffer `XPutImage` 到 **tao 顶层窗口**
//!      —— 走的是标准 X11 顶层窗口呈现路径,绕开了 CEF 子窗口呈现器的失败点。
//!   3. external message pump 仍挂进 tao 的 `run_return`。
//!
//! 这样窗口归 tao 管(后续可照抄 tauri-runtime-wry 的窗口实现),CEF 只产出像素。
//!
//! 运行:
//! ```sh
//! export CEF_PATH="$HOME/.local/share/cef"
//! export LD_LIBRARY_PATH="$CEF_PATH:$LD_LIBRARY_PATH"
//! cargo run -p tauri-runtime-cef --example minimal --features cef-backend
//! ```

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("`minimal` example is Linux-only (CEF backend targets Linux desktop).");
}

#[cfg(target_os = "linux")]
fn main() {
    // tao(GTK)走 X11(XWayland),让 softbuffer 拿到真实 X11 顶层窗口呈现。
    // SAFETY: 进程最早期、单线程,尚无其他线程读取环境变量。
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    minimal::run();
}

#[cfg(target_os = "linux")]
mod minimal {
    use cef::{args::Args, *};
    use std::{cell::Cell, num::NonZeroU32, rc::Rc};
    use tao::{
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        platform::run_return::EventLoopExtRunReturn,
        window::WindowBuilder,
    };

    // ── 共享的离屏帧缓冲 ──────────────────────────────────────────────
    // on_paint 在 CEF 的 UI 线程被调用 = 我们的主线程(external pump),事件循环
    // 也在主线程,所以单线程 Rc<RefCell> 足矣,无需 Arc/Mutex。
    #[derive(Default)]
    struct FrameBuf {
        w: i32,
        h: i32,
        bgra: Vec<u8>, // CEF on_paint 输出,每像素 [B,G,R,A]
    }

    #[derive(Clone)]
    struct Osr {
        size: Rc<std::cell::RefCell<(i32, i32)>>, // 当前视口尺寸(供 view_rect 上报)
        frame: Rc<std::cell::RefCell<FrameBuf>>,  // 最近一帧
        dirty: Rc<Cell<bool>>,                    // 有新帧待呈现
    }

    impl Osr {
        fn new(w: i32, h: i32) -> Self {
            Self {
                size: Rc::new(std::cell::RefCell::new((w, h))),
                frame: Rc::new(std::cell::RefCell::new(FrameBuf::default())),
                dirty: Rc::new(Cell::new(false)),
            }
        }
    }

    // App:给所有进程注入 x11/no-sandbox/软件渲染开关。
    wrap_app! {
        struct OsrApp;
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
                // NVIDIA GPU 进程会崩;OSR 软件光栅即可,强制 CPU 渲染。
                cl.append_switch(Some(&CefString::from("disable-gpu")));
                cl.append_switch(Some(&CefString::from("disable-gpu-compositing")));
            }
        }
    }

    // RenderHandler:上报视口尺寸 + 接收每帧像素。
    wrap_render_handler! {
        struct OsrRenderHandler {
            osr: Osr,
        }
        impl RenderHandler {
            fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
                if let Some(rect) = rect {
                    let (w, h) = *self.osr.size.borrow();
                    if w > 0 && h > 0 {
                        rect.x = 0;
                        rect.y = 0;
                        rect.width = w;
                        rect.height = h;
                    }
                }
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
                let mut f = self.osr.frame.borrow_mut();
                f.w = width;
                f.h = height;
                f.bgra.clear();
                f.bgra.extend_from_slice(slice);
                self.osr.dirty.set(true);
            }
        }
    }

    // Client:把 RenderHandler 挂上去(OSR 必需)。
    wrap_client! {
        struct OsrClient {
            render_handler: RenderHandler,
        }
        impl Client {
            fn render_handler(&self) -> Option<RenderHandler> {
                Some(self.render_handler.clone())
            }
        }
    }

    pub fn run() {
        // ── 1. CEF API 版本 + 多进程派发 ─────────────────────────────
        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let args = Args::new();
        let cmd = args.as_cmd_line().expect("failed to parse command line");
        let is_browser_process = cmd.has_switch(Some(&CefString::from("type"))) != 1;

        let mut app = OsrApp::new();
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

        // ── 2. 初始化 CEF(windowless + external pump)────────────────
        let mut settings = Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            windowless_rendering_enabled: 1,
            root_cache_path: CefString::from(
                std::env::temp_dir()
                    .join("tauri-runtime-cef-phase2")
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

        // ── 3. tao 窗口 + softbuffer 呈现面 ───────────────────────────
        let mut event_loop = EventLoop::new();
        let window = WindowBuilder::new()
            .with_title("tauri-runtime-cef · phase2 osr")
            .with_inner_size(tao::dpi::LogicalSize::new(1024.0, 768.0))
            .build(&event_loop)
            .expect("failed to build tao window");

        let init = window.inner_size();
        let osr = Osr::new(init.width as i32, init.height as i32);

        let sb_context = softbuffer::Context::new(&window)
            .expect("softbuffer context (needs X11/GDK_BACKEND=x11)");
        let mut sb_surface =
            softbuffer::Surface::new(&sb_context, &window).expect("softbuffer surface");

        // ── 4. 创建 windowless 浏览器(parent_window=0)────────────────
        let window_info = WindowInfo {
            windowless_rendering_enabled: 1,
            ..Default::default()
        };
        let mut client = OsrClient::new(OsrRenderHandler::new(osr.clone()));
        let url = CefString::from(
            std::env::var("PHASE2_URL")
                .unwrap_or_else(|_| "file:///tmp/cef-test.html".to_string())
                .as_str(),
        );
        let browser = browser_host_create_browser_sync(
            Some(&window_info),
            Some(&mut client),
            Some(&url),
            Some(&BrowserSettings {
                windowless_frame_rate: 60,
                ..Default::default()
            }),
            None,
            None,
        );
        println!(
            "[phase2-osr] browser created = {}, viewport {}x{}",
            browser.is_some(),
            init.width,
            init.height
        );

        let cursor = std::cell::Cell::new((100i32, 100i32));
        // ── 5. tao 事件循环:驱动 CEF + 把帧 blit 到窗口 ───────────────
        // 不用 `move`:softbuffer 的 Surface 借用了 window,window 不能再被移动;
        // tao 的 run_return 不要求 'static 闭包(与 tauri-runtime-wry 一致),
        // 所以闭包按引用借用 window / sb_surface / osr / browser 即可。
        event_loop.run_return(|event, _target, control_flow| {
            *control_flow = ControlFlow::WaitUntil(
                std::time::Instant::now() + std::time::Duration::from_millis(8),
            );

            match &event {
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                Event::WindowEvent {
                    event: WindowEvent::Resized(new_size),
                    ..
                } => {
                    *osr.size.borrow_mut() = (new_size.width as i32, new_size.height as i32);
                    if let Some(b) = browser.as_ref() {
                        if let Some(host) = b.host() {
                            host.was_resized();
                        }
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CursorMoved { position, .. },
                    ..
                } => {
                    cursor.set((position.x as i32, position.y as i32));
                    if let Some(host) = browser.as_ref().and_then(|b| b.host()) {
                        let (x, y) = cursor.get();
                        host.send_mouse_move_event(Some(&MouseEvent { x, y, modifiers: 0 }), 0);
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::MouseWheel { delta, .. },
                    ..
                } => {
                    let (dx, dy) = match delta {
                        tao::event::MouseScrollDelta::LineDelta(x, y) => {
                            ((*x * 120.0) as i32, (*y * 120.0) as i32)
                        }
                        tao::event::MouseScrollDelta::PixelDelta(p) => (p.x as i32, p.y as i32),
                        _ => (0, 0),
                    };
                    if let Some(host) = browser.as_ref().and_then(|b| b.host()) {
                        let (x, y) = cursor.get();
                        host.send_mouse_wheel_event(
                            Some(&MouseEvent { x, y, modifiers: 0 }),
                            dx,
                            dy,
                        );
                    }
                }
                _ => {}
            }

            // 驱动 CEF(外部消息泵)。不在任何 CEF 回调内,无重入风险。
            do_message_loop_work();

            // 有新帧 → blit 到 tao 窗口。
            if osr.dirty.get() {
                blit(&mut sb_surface, &window, &osr);
                osr.dirty.set(false);
            }
        });

        // ── 6. 收尾 ───────────────────────────────────────────────────
        shutdown();
        println!("[phase2-osr] clean shutdown");
    }

    /// 把最近一帧 BGRA 像素呈现到 tao 窗口(softbuffer → XPutImage)。
    fn blit(
        surface: &mut softbuffer::Surface<&tao::window::Window, &tao::window::Window>,
        window: &tao::window::Window,
        osr: &Osr,
    ) {
        let ws = window.inner_size();
        let (Some(win_w), Some(win_h)) = (NonZeroU32::new(ws.width), NonZeroU32::new(ws.height))
        else {
            return;
        };
        if surface.resize(win_w, win_h).is_err() {
            return;
        }
        let Ok(mut buf) = surface.buffer_mut() else {
            return;
        };

        let f = osr.frame.borrow();
        if f.bgra.is_empty() {
            return;
        }
        let fw = f.w as u32;
        let fh = f.h as u32;
        let copy_w = fw.min(ws.width);
        let copy_h = fh.min(ws.height);

        // softbuffer 像素格式:0x00RRGGBB。CEF 字节序 [B,G,R,A] 正好对得上。
        for y in 0..copy_h {
            let src_row = (y * fw) as usize * 4;
            let dst_row = (y * ws.width) as usize;
            for x in 0..copy_w as usize {
                let si = src_row + x * 4;
                let b = f.bgra[si] as u32;
                let g = f.bgra[si + 1] as u32;
                let r = f.bgra[si + 2] as u32;
                buf[dst_row + x] = (r << 16) | (g << 8) | b;
            }
        }
        let _ = buf.present();
    }
}
