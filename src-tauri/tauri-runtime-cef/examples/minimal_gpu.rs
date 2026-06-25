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
//! 诊断:
//! ```sh
//! GPU_RENDER_SOURCE=clear ... # 只清屏成蓝色,验证 wgpu surface/present
//! GPU_RENDER_SOURCE=test  ... # 采样 CPU 写入的 2x2 纹理,验证 pipeline/UV/sampler
//! GPU_RENDER_SOURCE=imported  # 默认,回调内把 CEF dmabuf 转存到自有 texture 后采样
//! GPU_RENDER_SOURCE=imported-direct # 旧路径,回调外直接采样 CEF dmabuf imported texture
//! GPU_RENDER_SOURCE=vk-copy # raw Vulkan acquire+copy 到自有 texture 后采样
//! GPU_RENDER_SOURCE=vk-readback # raw Vulkan copy 到 CPU buffer,打印非零统计
//! GPU_VK_COPY_OLD_LAYOUT=general|color|shader|transfer|undefined
//! GPU_VK_COPY_QUEUE_FAMILY=foreign|external|ignored
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
    use ash::vk;
    use cef::{args::Args, *};
    use std::cell::RefCell;
    use std::fmt;
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

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum RenderSource {
        Imported,
        ImportedDirect,
        VulkanCopy,
        VulkanReadback,
        TestTexture,
        ClearColor,
    }

    impl RenderSource {
        fn from_env() -> Self {
            match std::env::var("GPU_RENDER_SOURCE").as_deref() {
                Ok("test") | Ok("test-texture") => Self::TestTexture,
                Ok("clear") | Ok("clear-color") => Self::ClearColor,
                Ok("imported-direct") | Ok("direct") => Self::ImportedDirect,
                Ok("vk-copy") | Ok("vulkan-copy") => Self::VulkanCopy,
                Ok("vk-readback") | Ok("vulkan-readback") => Self::VulkanReadback,
                _ => Self::Imported,
            }
        }
    }

    struct StderrTracing;

    impl tracing::Subscriber for StderrTracing {
        fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
            metadata.target().contains("osr_texture_import")
                || metadata.target().starts_with("cef::osr_texture_import")
        }

        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            if !self.enabled(event.metadata()) {
                return;
            }
            let mut visitor = EventVisitor::default();
            event.record(&mut visitor);
            eprintln!(
                "[cef-tracing] {} {}: {}",
                event.metadata().level(),
                event.metadata().target(),
                visitor.output
            );
        }

        fn enter(&self, _span: &tracing::span::Id) {}

        fn exit(&self, _span: &tracing::span::Id) {}
    }

    #[derive(Default)]
    struct EventVisitor {
        output: String,
    }

    impl tracing::field::Visit for EventVisitor {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
            if !self.output.is_empty() {
                self.output.push_str(", ");
            }
            self.output
                .push_str(format!("{}={value:?}", field.name()).as_str());
        }
    }

    fn install_tracing() {
        let _ = tracing::subscriber::set_global_default(StderrTracing);
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
        render_source: RenderSource,
    }

    impl State {
        async fn new(window: &Window, render_source: RenderSource) -> State {
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
                render_source,
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
            if self.render_source == RenderSource::ClearColor {
                {
                    let _rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("cef clear-color diagnostic pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color {
                                    r: 0.05,
                                    g: 0.35,
                                    b: 0.95,
                                    a: 1.0,
                                }),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        ..Default::default()
                    });
                }
                self.queue.submit(std::iter::once(encoder.finish()));
                surface_texture.present();
                return;
            }
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
        let bind_group = create_texture_bind_group(device, texture, "cef frame");
        TEXTURE.with_borrow_mut(|t| {
            t.replace(bind_group);
        });
    }

    fn create_texture_bind_group(
        device: &wgpu::Device,
        texture: &wgpu::Texture,
        label: &'static str,
    ) -> wgpu::BindGroup {
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
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
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
        })
    }

    /// Store a small CPU-filled texture to prove the wgpu surface, shader,
    /// bind group, sampler and fullscreen quad are correct.
    fn store_test_texture(device: &wgpu::Device, queue: &wgpu::Queue) {
        let size = wgpu::Extent3d {
            width: 2,
            height: 2,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cef diagnostic test texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut pixels = vec![0u8; 256 * 2];
        pixels[0..8].copy_from_slice(&[255, 0, 0, 255, 0, 255, 0, 255]);
        pixels[256..264].copy_from_slice(&[0, 0, 255, 255, 255, 255, 255, 255]);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(2),
            },
            size,
        );
        store_frame(device, &texture);
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
        queue: wgpu::Queue,
        surface_format: wgpu::TextureFormat,
        pipeline: wgpu::RenderPipeline,
        quad: Geometry,
        size: Rc<RefCell<(i32, i32)>>,
        scale: f32,
        accel_paints: Rc<std::cell::Cell<u64>>,
        did_readback: Rc<std::cell::Cell<bool>>,
        render_source: RenderSource,
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
                let n = self.h.accel_paints.get() + 1;
                self.h.accel_paints.set(n);
                if n <= 3 || n % 60 == 0 {
                    log_accelerated_paint_info(n, info);
                }
                if !matches!(
                    self.h.render_source,
                    RenderSource::Imported
                        | RenderSource::ImportedDirect
                        | RenderSource::VulkanCopy
                        | RenderSource::VulkanReadback
                ) {
                    if n <= 3 || n % 60 == 0 {
                        eprintln!(
                            "[gpu] render source {:?}; skipping dmabuf import",
                            self.h.render_source
                        );
                    }
                    return;
                }
                let handle = SharedTextureHandle::new(info);
                if let SharedTextureHandle::Unsupported = handle {
                    eprintln!("[gpu] accelerated paint UNSUPPORTED on this platform");
                    return;
                }
                if self.h.render_source == RenderSource::VulkanCopy {
                    match vk_copy_dmabuf_to_owned_texture(&self.h.device, &self.h.queue, info) {
                        Ok(owned) => store_frame(&self.h.device, &owned),
                        Err(e) => eprintln!("[gpu] vk-copy FAILED: {e}"),
                    }
                    return;
                }
                if self.h.render_source == RenderSource::VulkanReadback {
                    if !self.h.did_readback.replace(true) {
                        match vk_readback_dmabuf_stats(&self.h.device, &self.h.queue, info) {
                            Ok(()) => {}
                            Err(e) => eprintln!("[gpu] vk-readback FAILED: {e}"),
                        }
                    }
                    return;
                }
                match handle.import_texture(&self.h.device) {
                    Ok(texture) => {
                        if n <= 3 || n % 60 == 0 {
                            eprintln!("[gpu] on_accelerated_paint #{n}: dmabuf import OK (zero-copy)");
                        }
                        if self.h.render_source == RenderSource::ImportedDirect {
                            store_frame(&self.h.device, &texture);
                        } else {
                            let owned = blit_imported_to_owned_texture(
                                &self.h.device,
                                &self.h.queue,
                                self.h.surface_format,
                                &self.h.pipeline,
                                &self.h.quad,
                                &texture,
                                info.extra.coded_size.width.max(1) as u32,
                                info.extra.coded_size.height.max(1) as u32,
                            );
                            store_frame(&self.h.device, &owned);
                        }
                    }
                    Err(e) => eprintln!("[gpu] import_texture FAILED: {e:?}"),
                }
            }
        }
    }

    fn log_accelerated_paint_info(n: u64, info: &AcceleratedPaintInfo) {
        eprintln!(
            "[gpu] paint #{n}: format={:?} modifier=0x{:x} coded={}x{} source={}x{} planes={} capture_counter={}",
            info.format,
            info.modifier,
            info.extra.coded_size.width,
            info.extra.coded_size.height,
            info.extra.source_size.width,
            info.extra.source_size.height,
            info.plane_count,
            info.extra.capture_counter,
        );
        for i in 0..(info.plane_count.max(0) as usize).min(info.planes.len()) {
            let plane = &info.planes[i];
            eprintln!(
                "[gpu]   plane[{i}]: fd={} stride={} offset={} size={}",
                plane.fd, plane.stride, plane.offset, plane.size
            );
        }
    }

    /// Sample the short-lived CEF imported texture inside `on_accelerated_paint`
    /// and render it into an application-owned texture that can be used later.
    fn blit_imported_to_owned_texture(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_format: wgpu::TextureFormat,
        pipeline: &wgpu::RenderPipeline,
        quad: &Geometry,
        imported: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> wgpu::Texture {
        let owned = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cef owned frame texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: surface_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let owned_view = owned.create_view(&wgpu::TextureViewDescriptor {
            label: Some("cef owned frame view"),
            format: Some(surface_format),
            ..Default::default()
        });
        let imported_bind_group = create_texture_bind_group(device, imported, "cef imported frame");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("cef imported-to-owned encoder"),
        });
        {
            let mut rp = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cef imported-to-owned pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &owned_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });
            rp.set_pipeline(pipeline);
            rp.set_bind_group(0, &imported_bind_group, &[]);
            rp.set_vertex_buffer(0, quad.vertex_buffer.slice(..));
            rp.draw(0..quad.vertex_count, 0..1);
        }
        queue.submit(std::iter::once(encoder.finish()));
        owned
    }

    struct RawImportedImage<'a> {
        device: &'a ash::Device,
        image: vk::Image,
        memory: vk::DeviceMemory,
    }

    impl Drop for RawImportedImage<'_> {
        fn drop(&mut self) {
            unsafe {
                self.device.destroy_image(self.image, None);
                self.device.free_memory(self.memory, None);
            }
        }
    }

    struct RawReadbackBuffer<'a> {
        device: &'a ash::Device,
        buffer: vk::Buffer,
        memory: vk::DeviceMemory,
        size: vk::DeviceSize,
    }

    impl RawReadbackBuffer<'_> {
        unsafe fn bytes(&self) -> Result<Vec<u8>, String> {
            let ptr = self
                .device
                .map_memory(self.memory, 0, self.size, vk::MemoryMapFlags::empty())
                .map_err(|e| format!("map readback memory: {e:?}"))?;
            let slice = std::slice::from_raw_parts(ptr.cast::<u8>(), self.size as usize);
            let bytes = slice.to_vec();
            self.device.unmap_memory(self.memory);
            Ok(bytes)
        }
    }

    impl Drop for RawReadbackBuffer<'_> {
        fn drop(&mut self) {
            unsafe {
                self.device.destroy_buffer(self.buffer, None);
                self.device.free_memory(self.memory, None);
            }
        }
    }

    fn vk_copy_dmabuf_to_owned_texture(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        info: &AcceleratedPaintInfo,
    ) -> Result<wgpu::Texture, String> {
        let width = info.extra.coded_size.width.max(1) as u32;
        let height = info.extra.coded_size.height.max(1) as u32;
        let owned = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cef vk-copy owned frame"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        unsafe {
            let hal_device_guard = device
                .as_hal::<wgpu::hal::api::Vulkan>()
                .ok_or_else(|| "wgpu device is not Vulkan".to_string())?;
            let hal_owned_guard = owned
                .as_hal::<wgpu::hal::api::Vulkan>()
                .ok_or_else(|| "owned texture is not Vulkan".to_string())?;

            let raw_device = hal_device_guard.raw_device();
            let imported = create_raw_imported_dmabuf(&hal_device_guard, info, width, height)?;
            let owned_image = hal_owned_guard.raw_handle();
            let queue_family = hal_device_guard.queue_family_index();
            let old_layout = vk_copy_old_layout();
            let src_queue_family = vk_copy_src_queue_family();
            if info.extra.capture_counter <= 3 {
                eprintln!(
                    "[gpu] vk-copy acquire: old_layout={old_layout:?} src_queue_family={} dst_queue_family={queue_family}",
                    queue_family_name(src_queue_family)
                );
            }

            let mut pre_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("cef vk-copy pre-transition encoder"),
            });
            pre_encoder.transition_resources(
                std::iter::empty(),
                std::iter::once(wgpu::TextureTransition {
                    texture: &owned,
                    selector: None,
                    state: wgpu::TextureUses::COPY_DST,
                }),
            );
            let pre = pre_encoder.finish();

            let mut raw_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("cef vk-copy raw encoder"),
            });
            raw_encoder.as_hal_mut::<wgpu::hal::api::Vulkan, _, _>(|hal_encoder| {
                let Some(hal_encoder) = hal_encoder else {
                    return Err("missing Vulkan command encoder".to_string());
                };
                let cmd = hal_encoder.raw_handle();
                let subresource = vk::ImageSubresourceRange::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .base_mip_level(0)
                    .level_count(1)
                    .base_array_layer(0)
                    .layer_count(1);

                let acquire = vk::ImageMemoryBarrier::default()
                    .src_access_mask(
                        vk::AccessFlags::MEMORY_WRITE | vk::AccessFlags::COLOR_ATTACHMENT_WRITE,
                    )
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ)
                    .old_layout(old_layout)
                    .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .src_queue_family_index(src_queue_family)
                    .dst_queue_family_index(queue_family)
                    .image(imported.image)
                    .subresource_range(subresource);
                raw_device.cmd_pipeline_barrier(
                    cmd,
                    vk::PipelineStageFlags::ALL_COMMANDS
                        | vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[acquire],
                );

                let copy = vk::ImageCopy::default()
                    .src_subresource(
                        vk::ImageSubresourceLayers::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .mip_level(0)
                            .base_array_layer(0)
                            .layer_count(1),
                    )
                    .dst_subresource(
                        vk::ImageSubresourceLayers::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .mip_level(0)
                            .base_array_layer(0)
                            .layer_count(1),
                    )
                    .extent(vk::Extent3D {
                        width,
                        height,
                        depth: 1,
                    });
                raw_device.cmd_copy_image(
                    cmd,
                    imported.image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    owned_image,
                    vk::ImageLayout::TRANSFER_DST_OPTIMAL,
                    &[copy],
                );
                Ok(())
            })?;
            let raw = raw_encoder.finish();

            let mut post_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("cef vk-copy post-transition encoder"),
            });
            post_encoder.transition_resources(
                std::iter::empty(),
                std::iter::once(wgpu::TextureTransition {
                    texture: &owned,
                    selector: None,
                    state: wgpu::TextureUses::RESOURCE,
                }),
            );
            let post = post_encoder.finish();

            queue.submit([pre, raw, post]);
            std::mem::forget(imported);
        }

        Ok(owned)
    }

    fn vk_readback_dmabuf_stats(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        info: &AcceleratedPaintInfo,
    ) -> Result<(), String> {
        let width = info.extra.coded_size.width.max(1) as u32;
        let height = info.extra.coded_size.height.max(1) as u32;
        unsafe {
            let hal_device_guard = device
                .as_hal::<wgpu::hal::api::Vulkan>()
                .ok_or_else(|| "wgpu device is not Vulkan".to_string())?;
            let raw_device = hal_device_guard.raw_device();
            let imported = create_raw_imported_dmabuf(&hal_device_guard, info, width, height)?;
            let readback =
                create_raw_readback_buffer(&hal_device_guard, (width * height * 4) as u64)?;
            let queue_family = hal_device_guard.queue_family_index();
            let old_layout = vk_copy_old_layout();
            let src_queue_family = vk_copy_src_queue_family();
            eprintln!(
                "[gpu] vk-readback acquire: old_layout={old_layout:?} src_queue_family={} dst_queue_family={queue_family}",
                queue_family_name(src_queue_family)
            );

            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("cef vk-readback raw encoder"),
            });
            encoder.as_hal_mut::<wgpu::hal::api::Vulkan, _, _>(|hal_encoder| {
                let Some(hal_encoder) = hal_encoder else {
                    return Err("missing Vulkan command encoder".to_string());
                };
                let cmd = hal_encoder.raw_handle();
                let subresource = vk::ImageSubresourceRange::default()
                    .aspect_mask(vk::ImageAspectFlags::COLOR)
                    .base_mip_level(0)
                    .level_count(1)
                    .base_array_layer(0)
                    .layer_count(1);
                let acquire = vk::ImageMemoryBarrier::default()
                    .src_access_mask(
                        vk::AccessFlags::MEMORY_WRITE | vk::AccessFlags::COLOR_ATTACHMENT_WRITE,
                    )
                    .dst_access_mask(vk::AccessFlags::TRANSFER_READ)
                    .old_layout(old_layout)
                    .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                    .src_queue_family_index(src_queue_family)
                    .dst_queue_family_index(queue_family)
                    .image(imported.image)
                    .subresource_range(subresource);
                raw_device.cmd_pipeline_barrier(
                    cmd,
                    vk::PipelineStageFlags::ALL_COMMANDS
                        | vk::PipelineStageFlags::COLOR_ATTACHMENT_OUTPUT,
                    vk::PipelineStageFlags::TRANSFER,
                    vk::DependencyFlags::empty(),
                    &[],
                    &[],
                    &[acquire],
                );
                let copy = vk::BufferImageCopy::default()
                    .buffer_offset(0)
                    .buffer_row_length(width)
                    .buffer_image_height(height)
                    .image_subresource(
                        vk::ImageSubresourceLayers::default()
                            .aspect_mask(vk::ImageAspectFlags::COLOR)
                            .mip_level(0)
                            .base_array_layer(0)
                            .layer_count(1),
                    )
                    .image_extent(vk::Extent3D {
                        width,
                        height,
                        depth: 1,
                    });
                raw_device.cmd_copy_image_to_buffer(
                    cmd,
                    imported.image,
                    vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
                    readback.buffer,
                    &[copy],
                );
                Ok(())
            })?;

            let submission = queue.submit(std::iter::once(encoder.finish()));
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: Some(submission),
                    timeout: None,
                })
                .map_err(|e| format!("device poll wait: {e:?}"))?;
            let bytes = readback.bytes()?;
            let nonzero = bytes.iter().filter(|b| **b != 0).count();
            let sample_len = bytes.len().min(32);
            eprintln!(
                "[gpu] vk-readback bytes={} nonzero={} first{:?}",
                bytes.len(),
                nonzero,
                &bytes[..sample_len]
            );
            std::mem::forget(imported);
            Ok(())
        }
    }

    unsafe fn create_raw_readback_buffer<'a>(
        hal_device: &'a <wgpu::hal::api::Vulkan as wgpu::hal::Api>::Device,
        size: vk::DeviceSize,
    ) -> Result<RawReadbackBuffer<'a>, String> {
        let raw_device = hal_device.raw_device();
        let create_info = vk::BufferCreateInfo::default()
            .size(size)
            .usage(vk::BufferUsageFlags::TRANSFER_DST)
            .sharing_mode(vk::SharingMode::EXCLUSIVE);
        let buffer = raw_device
            .create_buffer(&create_info, None)
            .map_err(|e| format!("create readback buffer: {e:?}"))?;
        let req = raw_device.get_buffer_memory_requirements(buffer);
        let memory_properties = hal_device
            .shared_instance()
            .raw_instance()
            .get_physical_device_memory_properties(hal_device.raw_physical_device());
        let memory_type_index = (0..memory_properties.memory_type_count)
            .find(|&i| {
                (req.memory_type_bits & (1 << i)) != 0
                    && memory_properties.memory_types[i as usize]
                        .property_flags
                        .contains(
                            vk::MemoryPropertyFlags::HOST_VISIBLE
                                | vk::MemoryPropertyFlags::HOST_COHERENT,
                        )
            })
            .ok_or_else(|| "no host-visible readback memory type".to_string())?;
        let alloc = vk::MemoryAllocateInfo::default()
            .allocation_size(req.size)
            .memory_type_index(memory_type_index);
        let memory = match raw_device.allocate_memory(&alloc, None) {
            Ok(memory) => memory,
            Err(e) => {
                raw_device.destroy_buffer(buffer, None);
                return Err(format!("allocate readback memory: {e:?}"));
            }
        };
        if let Err(e) = raw_device.bind_buffer_memory(buffer, memory, 0) {
            raw_device.free_memory(memory, None);
            raw_device.destroy_buffer(buffer, None);
            return Err(format!("bind readback memory: {e:?}"));
        }
        Ok(RawReadbackBuffer {
            device: raw_device,
            buffer,
            memory,
            size,
        })
    }

    fn vk_copy_old_layout() -> vk::ImageLayout {
        match std::env::var("GPU_VK_COPY_OLD_LAYOUT").as_deref() {
            Ok("color") | Ok("color-attachment") => vk::ImageLayout::COLOR_ATTACHMENT_OPTIMAL,
            Ok("shader") | Ok("shader-read") => vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            Ok("transfer") | Ok("transfer-src") => vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            Ok("undefined") => vk::ImageLayout::UNDEFINED,
            _ => vk::ImageLayout::GENERAL,
        }
    }

    fn vk_copy_src_queue_family() -> u32 {
        match std::env::var("GPU_VK_COPY_QUEUE_FAMILY").as_deref() {
            Ok("external") => vk::QUEUE_FAMILY_EXTERNAL,
            Ok("ignored") | Ok("ignore") => vk::QUEUE_FAMILY_IGNORED,
            _ => vk::QUEUE_FAMILY_FOREIGN_EXT,
        }
    }

    fn queue_family_name(value: u32) -> &'static str {
        if value == vk::QUEUE_FAMILY_FOREIGN_EXT {
            "FOREIGN_EXT"
        } else if value == vk::QUEUE_FAMILY_EXTERNAL {
            "EXTERNAL"
        } else if value == vk::QUEUE_FAMILY_IGNORED {
            "IGNORED"
        } else {
            "custom"
        }
    }

    unsafe fn create_raw_imported_dmabuf<'a>(
        hal_device: &'a <wgpu::hal::api::Vulkan as wgpu::hal::Api>::Device,
        info: &AcceleratedPaintInfo,
        width: u32,
        height: u32,
    ) -> Result<RawImportedImage<'a>, String> {
        if info.plane_count != 1 {
            return Err(format!(
                "vk-copy currently supports one plane, got {}",
                info.plane_count
            ));
        }
        if *info.format.as_ref() != cef::sys::cef_color_type_t::CEF_COLOR_TYPE_BGRA_8888 {
            return Err(format!(
                "vk-copy currently supports BGRA_8888, got {:?}",
                info.format
            ));
        }

        let raw_device = hal_device.raw_device();
        let plane = &info.planes[0];
        let plane_layouts = [vk::SubresourceLayout {
            offset: plane.offset,
            size: 0,
            row_pitch: plane.stride as u64,
            array_pitch: 0,
            depth_pitch: 0,
        }];
        let mut drm_format_modifier = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default()
            .drm_format_modifier(info.modifier)
            .plane_layouts(&plane_layouts);
        let mut external_memory_image = vk::ExternalMemoryImageCreateInfo::default()
            .handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let image_create_info = vk::ImageCreateInfo::default()
            .image_type(vk::ImageType::TYPE_2D)
            .format(vk::Format::B8G8R8A8_UNORM)
            .extent(vk::Extent3D {
                width,
                height,
                depth: 1,
            })
            .mip_levels(1)
            .array_layers(1)
            .samples(vk::SampleCountFlags::TYPE_1)
            .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT)
            .usage(
                vk::ImageUsageFlags::SAMPLED
                    | vk::ImageUsageFlags::COLOR_ATTACHMENT
                    | vk::ImageUsageFlags::TRANSFER_SRC,
            )
            .sharing_mode(vk::SharingMode::EXCLUSIVE)
            .push_next(&mut drm_format_modifier)
            .push_next(&mut external_memory_image);

        let image = raw_device
            .create_image(&image_create_info, None)
            .map_err(|e| format!("create_image: {e:?}"))?;
        let memory_requirements = raw_device.get_image_memory_requirements(image);
        let dup_fd = libc::dup(plane.fd);
        if dup_fd == -1 {
            raw_device.destroy_image(image, None);
            return Err("dup dmabuf fd failed".to_string());
        }
        let mut import_memory_fd = vk::ImportMemoryFdInfoKHR::default()
            .handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT)
            .fd(dup_fd);
        let external_memory_fd = ash::khr::external_memory_fd::Device::new(
            hal_device.shared_instance().raw_instance(),
            raw_device,
        );
        let mut fd_properties = vk::MemoryFdPropertiesKHR::default();
        external_memory_fd
            .get_memory_fd_properties(
                vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT,
                dup_fd,
                &mut fd_properties,
            )
            .map_err(|e| {
                raw_device.destroy_image(image, None);
                format!("get_memory_fd_properties: {e:?}")
            })?;
        let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let memory_properties = hal_device
            .shared_instance()
            .raw_instance()
            .get_physical_device_memory_properties(hal_device.raw_physical_device());
        let memory_type_bits =
            memory_requirements.memory_type_bits & fd_properties.memory_type_bits;
        eprintln!(
            "[gpu] dmabuf memory bits: image=0x{:x} fd=0x{:x} intersection=0x{:x}",
            memory_requirements.memory_type_bits, fd_properties.memory_type_bits, memory_type_bits
        );
        let memory_type_index = (0..memory_properties.memory_type_count)
            .find(|&i| (memory_type_bits & (1 << i)) != 0)
            .ok_or_else(|| "no suitable dmabuf memory type".to_string())?;
        let allocate_info = vk::MemoryAllocateInfo::default()
            .allocation_size(memory_requirements.size)
            .memory_type_index(memory_type_index)
            .push_next(&mut import_memory_fd)
            .push_next(&mut dedicated);
        let memory = match raw_device.allocate_memory(&allocate_info, None) {
            Ok(memory) => memory,
            Err(e) => {
                raw_device.destroy_image(image, None);
                return Err(format!("allocate_memory: {e:?}"));
            }
        };
        if let Err(e) = raw_device.bind_image_memory(image, memory, 0) {
            raw_device.free_memory(memory, None);
            raw_device.destroy_image(image, None);
            return Err(format!("bind_image_memory: {e:?}"));
        }
        Ok(RawImportedImage {
            device: raw_device,
            image,
            memory,
        })
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
        install_tracing();
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
        let did_readback = Rc::new(std::cell::Cell::new(false));
        let render_source = RenderSource::from_env();
        eprintln!("[gpu] render source = {render_source:?}");
        let mut state = pollster::block_on(State::new(&window, render_source));
        if render_source == RenderSource::TestTexture {
            store_test_texture(&state.device, &state.queue);
        }

        // windowless + 共享纹理 + 外部 begin-frame
        let window_info = WindowInfo {
            windowless_rendering_enabled: 1,
            shared_texture_enabled: 1,
            external_begin_frame_enabled: 1,
            ..Default::default()
        };
        let mut client = OsrClient::new(OsrRenderHandler::new(Handler {
            device: state.device.clone(),
            queue: state.queue.clone(),
            surface_format: state.surface_format,
            pipeline: state.pipeline.clone(),
            quad: state.quad.clone(),
            size: size.clone(),
            scale: window.scale_factor() as f32,
            accel_paints: accel_paints.clone(),
            did_readback: did_readback.clone(),
            render_source,
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

    #[derive(Clone)]
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
