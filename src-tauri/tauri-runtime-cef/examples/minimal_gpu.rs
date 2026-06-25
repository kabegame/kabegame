//! Phase 2.5 — GPU 加速 OSR(shared texture / dmabuf)+ tao + wgpu。
//!
//! 对照 `examples/minimal.rs`(纯软件 softbuffer blit),本例验证 **GPU 零拷贝路径**:
//!   1. CEF 以 windowless + `shared_texture_enabled` 在 **GPU** 上把页面渲染到一块
//!      dmabuf 共享纹理,通过 `on_accelerated_paint` 把**纹理句柄**交给我们。
//!   2. cef-rs 的 `osr_texture_import`(Vulkan external memory)把它**零拷贝**导入
//!      wgpu,我们用全屏 quad 合成到 tao 窗口的 wgpu surface。
//!   3. external begin-frame 驱动:每帧 `send_external_begin_frame` → `do_message_loop_work`
//!      → `render`。
//!
//! ⚠️ 本机 NVIDIA 关键前提(见 README §9.2.1):必须 `--use-angle=vulkan` +
//! `--enable-features=Vulkan`,让 CEF 的 GPU 合成走 Vulkan,与 cef-rs 的 Vulkan
//! dmabuf 导入器对齐;否则默认 GL/Ganesh 后端在 NVIDIA 上产不出共享纹理
//! (`ProduceSkiaGanesh failed to create GL representation`,`on_accelerated_paint` 0 次)。
//!
//! 运行:
//! ```sh
//! export CEF_PATH="$HOME/.local/share/cef"
//! export LD_LIBRARY_PATH="$CEF_PATH:$LD_LIBRARY_PATH"
//! cargo run -p tauri-runtime-cef --example minimal_gpu --features accelerated-osr
//! ```
//!
//! 大量 wgpu 管线代码改编自 cef-rs `examples/osr`(Apache-2.0 / MIT)。

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("`minimal_gpu` example is Linux-only.");
}

#[cfg(target_os = "linux")]
fn main() {
    // SAFETY: 进程最早期、单线程。让 tao(GTK)走 X11。
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    gpu::run();
}

#[cfg(target_os = "linux")]
mod gpu {
    use cef::{args::Args, *};
    use std::cell::RefCell;
    use std::rc::Rc;
    use tao::{
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoop},
        platform::run_return::EventLoopExtRunReturn,
        window::{Window, WindowBuilder},
    };

    const SHADER: &str = r#"
struct VertexInput { @location(0) pos: vec4<f32>, @location(1) tex: vec2<f32> };
struct VertexOutput { @builtin(position) pos: vec4<f32>, @location(0) tex: vec2<f32> };
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
    var o: VertexOutput; o.pos = input.pos; o.tex = input.tex; return o;
}
@group(0) @binding(0) var tex0: texture_2d<f32>;
@group(0) @binding(1) var samp0: sampler;
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(tex0, samp0, input.tex);
}
"#;

    // 最近一帧合成好的 bind group(纹理 + sampler),render() 取用。
    thread_local! {
        static TEXTURE: RefCell<Option<wgpu::BindGroup>> = const { RefCell::new(None) };
    }

    // 把窗口的 raw display handle 包成一个可 'static 持有的对象,交给 wgpu 实例。
    // X11 的 Display 指针随 X 连接存活(整个进程),在运行期始终有效。
    #[derive(Debug)]
    struct DisplayWrap(raw_window_handle::RawDisplayHandle);
    unsafe impl Send for DisplayWrap {}
    unsafe impl Sync for DisplayWrap {}
    impl raw_window_handle::HasDisplayHandle for DisplayWrap {
        fn display_handle(
            &self,
        ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
            // SAFETY: X11 Display 指针在进程运行期有效。
            Ok(unsafe { raw_window_handle::DisplayHandle::borrow_raw(self.0) })
        }
    }

    // ── wgpu 渲染状态 ─────────────────────────────────────────────────
    struct State {
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
        surface_format: wgpu::TextureFormat,
        pipeline: wgpu::RenderPipeline,
        quad: Geometry,
        size: tao::dpi::PhysicalSize<u32>,
    }

    impl State {
        async fn new(window: &Window) -> State {
            // wgpu 29:Vulkan 需在 instance 创建时拿到 display handle(否则建 surface
            // 报 MissingDisplayHandle)。从 tao 窗口取 raw display handle 传进去。
            use raw_window_handle::HasDisplayHandle;
            let raw_display = window
                .display_handle()
                .expect("tao window display handle")
                .as_raw();
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::VULKAN, // dmabuf 导入需 Vulkan
                ..wgpu::InstanceDescriptor::new_with_display_handle(Box::new(DisplayWrap(
                    raw_display,
                )))
            });

            // tao 窗口非 Send,用 unsafe 目标从 raw handle 建 surface(Surface<'static>)。
            let surface = unsafe {
                instance
                    .create_surface_unsafe(
                        wgpu::SurfaceTargetUnsafe::from_window(window)
                            .expect("surface target from tao window"),
                    )
                    .expect("create_surface_unsafe")
            };

            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                })
                .await
                .expect("request_adapter (Vulkan)");

            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    required_limits: wgpu::Limits {
                        max_non_sampler_bindings: 2048,
                        ..Default::default()
                    },
                    ..Default::default()
                })
                .await
                .expect("request_device");

            let size = window.inner_size();
            let surface_format = wgpu::TextureFormat::Bgra8Unorm;

            let bgl = bind_group_layout(&device);
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("cef shader"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("cef pipeline layout"),
                bind_group_layouts: &[Some(&bgl)],
                immediate_size: 0,
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("cef pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[Vertex::desc()],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_format,
                        blend: Some(wgpu::BlendState {
                            color: wgpu::BlendComponent::OVER,
                            alpha: wgpu::BlendComponent::OVER,
                        }),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleStrip,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Cw,
                    cull_mode: Some(wgpu::Face::Back),
                    polygon_mode: wgpu::PolygonMode::Fill,
                    unclipped_depth: false,
                    conservative: false,
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState {
                    count: 1,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                multiview_mask: None,
                cache: None,
            });

            let quad = Geometry::new(&device);
            let state = State {
                device,
                queue,
                surface,
                surface_format,
                pipeline,
                quad,
                size,
            };
            state.configure_surface();
            state
        }

        fn configure_surface(&self) {
            self.surface.configure(
                &self.device,
                &wgpu::SurfaceConfiguration {
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    format: self.surface_format,
                    view_formats: vec![self.surface_format],
                    alpha_mode: wgpu::CompositeAlphaMode::Auto,
                    width: self.size.width.max(1),
                    height: self.size.height.max(1),
                    desired_maximum_frame_latency: 2,
                    present_mode: wgpu::PresentMode::AutoVsync,
                },
            );
        }

        fn resize(&mut self, new: tao::dpi::PhysicalSize<u32>) {
            if new.width > 0 && new.height > 0 {
                self.size = new;
                self.configure_surface();
            }
        }

        fn render(&mut self) {
            let surface_texture = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(s) => s,
                wgpu::CurrentSurfaceTexture::Suboptimal(s) => {
                    self.configure_surface();
                    s
                }
                _ => return,
            };
            let view = surface_texture
                .texture
                .create_view(&wgpu::TextureViewDescriptor {
                    label: Some("surface view"),
                    format: Some(self.surface_format),
                    ..Default::default()
                });
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("encoder"),
                });
            TEXTURE.with_borrow(|tex| {
                let Some(bind_group) = tex.as_ref() else {
                    return;
                };
                {
                    let mut rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("cef render pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        ..Default::default()
                    });
                    rp.set_pipeline(&self.pipeline);
                    rp.set_bind_group(0, bind_group, &[]);
                    rp.set_vertex_buffer(0, self.quad.vertex_buffer.slice(..));
                    rp.draw(0..self.quad.vertex_count, 0..1);
                }
                self.queue.submit(std::iter::once(encoder.finish()));
            });
            surface_texture.present();
        }
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cef bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    /// 把一帧 wgpu 纹理包成 bind group 存入 TEXTURE。
    fn store_frame(device: &wgpu::Device, texture: &wgpu::Texture) {
        let view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("cef frame view"),
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let bgl = bind_group_layout(device);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("cef frame bind group"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        TEXTURE.with_borrow_mut(|t| {
            t.replace(bind_group);
        });
    }

    // ── App:强制 Vulkan + x11 ─────────────────────────────────────────
    wrap_app! {
        struct OsrApp;
        impl App {
            fn on_before_command_line_processing(
                &self,
                _process_type: Option<&CefString>,
                command_line: Option<&mut CommandLine>,
            ) {
                let Some(cl) = command_line else { return };
                cl.append_switch_with_value(
                    Some(&CefString::from("ozone-platform")),
                    Some(&CefString::from("x11")),
                );
                cl.append_switch(Some(&CefString::from("no-sandbox")));
                // 关键:让 CEF GPU 合成走 Vulkan,与 cef-rs 的 Vulkan dmabuf 导入对齐。
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
    }

    // ── RenderHandler:上报尺寸 + 接收 GPU 共享纹理 ────────────────────
    #[derive(Clone)]
    struct Handler {
        device: wgpu::Device,
        size: Rc<RefCell<(i32, i32)>>,
        scale: f32,
        accel_paints: Rc<std::cell::Cell<u64>>,
    }

    wrap_render_handler! {
        struct OsrRenderHandler {
            h: Handler,
        }
        impl RenderHandler {
            fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
                if let Some(rect) = rect {
                    let (w, h) = *self.h.size.borrow();
                    if w > 0 && h > 0 {
                        rect.x = 0;
                        rect.y = 0;
                        rect.width = w;
                        rect.height = h;
                    }
                }
            }

            fn screen_info(
                &self,
                _browser: Option<&mut Browser>,
                screen_info: Option<&mut ScreenInfo>,
            ) -> ::std::os::raw::c_int {
                if let Some(si) = screen_info {
                    si.device_scale_factor = self.h.scale;
                    return 1;
                }
                0
            }

            fn on_accelerated_paint(
                &self,
                _browser: Option<&mut Browser>,
                type_: PaintElementType,
                _dirty_rects: Option<&[Rect]>,
                info: Option<&AcceleratedPaintInfo>,
            ) {
                use cef::osr_texture_import::shared_texture_handle::SharedTextureHandle;
                let Some(info) = info else { return };
                if type_ != PaintElementType::default() {
                    return;
                }
                let handle = SharedTextureHandle::new(info);
                if let SharedTextureHandle::Unsupported = handle {
                    eprintln!("[gpu] accelerated paint UNSUPPORTED on this platform");
                    return;
                }
                match handle.import_texture(&self.h.device) {
                    Ok(texture) => {
                        let n = self.h.accel_paints.get() + 1;
                        self.h.accel_paints.set(n);
                        if n <= 3 || n % 60 == 0 {
                            eprintln!("[gpu] on_accelerated_paint #{n}: dmabuf import OK (zero-copy)");
                        }
                        store_frame(&self.h.device, &texture);
                    }
                    Err(e) => eprintln!("[gpu] import_texture FAILED: {e:?}"),
                }
            }
        }
    }

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
        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let args = Args::new();
        let cmd = args.as_cmd_line().expect("cmd line");
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
        assert_eq!(code, -1, "browser process expects -1 from execute_process");

        let mut settings = Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            windowless_rendering_enabled: 1,
            root_cache_path: CefString::from(
                std::env::temp_dir()
                    .join("tauri-runtime-cef-phase2-gpu")
                    .to_str()
                    .unwrap_or(""),
            ),
            ..Default::default()
        };
        if let Ok(p) = std::env::var("CEF_PATH") {
            if !p.is_empty() {
                settings.resources_dir_path = CefString::from(p.as_str());
                settings.locales_dir_path = CefString::from(format!("{p}/locales").as_str());
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

        // 窗口 + wgpu
        let mut event_loop = EventLoop::new();
        let window = WindowBuilder::new()
            .with_title("tauri-runtime-cef · phase2 GPU OSR")
            .with_inner_size(tao::dpi::LogicalSize::new(1024.0, 768.0))
            .build(&event_loop)
            .expect("tao window");

        let init = window.inner_size();
        let size = Rc::new(RefCell::new((init.width as i32, init.height as i32)));
        let accel_paints = Rc::new(std::cell::Cell::new(0u64));
        let mut state = pollster::block_on(State::new(&window));

        // windowless + 共享纹理 + 外部 begin-frame
        let window_info = WindowInfo {
            windowless_rendering_enabled: 1,
            shared_texture_enabled: 1,
            external_begin_frame_enabled: 1,
            ..Default::default()
        };
        let mut client = OsrClient::new(OsrRenderHandler::new(Handler {
            device: state.device.clone(),
            size: size.clone(),
            scale: window.scale_factor() as f32,
            accel_paints: accel_paints.clone(),
        }));
        let url = CefString::from(
            std::env::var("GPU_URL")
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
        println!("[gpu] browser created = {}", browser.is_some());

        event_loop.run_return(|event, _target, control_flow| {
            *control_flow = ControlFlow::WaitUntil(
                std::time::Instant::now() + std::time::Duration::from_millis(16),
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
                    *size.borrow_mut() = (new_size.width as i32, new_size.height as i32);
                    state.resize(*new_size);
                    if let Some(host) = browser.as_ref().and_then(|b| b.host()) {
                        host.was_resized();
                    }
                }
                _ => {}
            }

            // 外部 begin-frame 驱动 CEF 产帧 → 泵 → 合成。
            if let Some(host) = browser.as_ref().and_then(|b| b.host()) {
                host.send_external_begin_frame();
            }
            do_message_loop_work();
            state.render();
        });

        shutdown();
        println!(
            "[gpu] clean shutdown; total accelerated paints = {}",
            accel_paints.get()
        );
    }

    // ── 全屏 quad ─────────────────────────────────────────────────────
    #[repr(C)]
    #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
    struct Vertex {
        position: [f32; 3],
        tex_coords: [f32; 2],
    }

    impl Vertex {
        const ATTRIBS: [wgpu::VertexAttribute; 2] =
            wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2];
        fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
            wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &Self::ATTRIBS,
            }
        }
    }

    struct Geometry {
        vertex_buffer: wgpu::Buffer,
        vertex_count: u32,
    }

    impl Geometry {
        fn new(device: &wgpu::Device) -> Self {
            use wgpu::util::DeviceExt;
            let (x, y, w, h, z) = (-1.0f32, 1.0f32, 2.0f32, 2.0f32, 1.0f32);
            let vertices = [
                Vertex {
                    position: [x, y, z],
                    tex_coords: [0.0, 0.0],
                },
                Vertex {
                    position: [x + w, y, z],
                    tex_coords: [1.0, 0.0],
                },
                Vertex {
                    position: [x, y - h, z],
                    tex_coords: [0.0, 1.0],
                },
                Vertex {
                    position: [x + w, y - h, z],
                    tex_coords: [1.0, 1.0],
                },
            ];
            let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("quad vbuf"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
            Self {
                vertex_buffer,
                vertex_count: vertices.len() as u32,
            }
        }
    }
}
