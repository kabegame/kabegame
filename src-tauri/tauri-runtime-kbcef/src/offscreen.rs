//! 离屏 browser（windowless rendering）：不建 CEF Views 窗口，CEF 把每一帧交给应用登记的接收器。
//!
//! 应用建窗前按 label 登记（[`register_offscreen`]），runtime 建这个 label 的窗口时不建原生窗口，改建
//! windowless browser（`CefWindowInfo::windowless_rendering_enabled`）。窗口操作映射到 browser host：
//! 显示 / 隐藏 → `WasHidden`，改尺寸 → `WasResized`，关闭 / 销毁 → `CloseBrowser`（不经 `CloseRequested`）。
//! 帧经 [`set_offscreen_frame_sink`] 登记的接收器交出：加速绘制时是 CEF 缓冲池里的 dmabuf（只在 Linux，
//! 只在回调期间有效），软件绘制时是整帧像素。
//!
//! 进程级的 `CefSettings::windowless_rendering_enabled` 只在 Linux 打开（runtime 的 `initialize_cef`）：
//! 其它平台没有离屏 browser 的使用者，CEF 注明打开它可能拖慢普通窗口。
//!
//! 子 frame 的鼠标注入（CEF 补丁 11）照常可用：离屏 browser 和窗口 browser 一样按 label 登记。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use cef::*;

/// 离屏视图的几何：逻辑尺寸（DIP）与缩放；画布像素 = 逻辑尺寸 × 缩放。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffscreenGeometry {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

impl OffscreenGeometry {
    /// 宽或高为 0（应用不知道铺哪块屏）时换成 CEF 主显示器的 DIP 尺寸与缩放；CEF 也给不出时 1920×1080@1。
    /// 只能在 CEF UI 线程调用。
    pub(crate) fn or_primary_display(self) -> Self {
        if self.width > 0 && self.height > 0 {
            return self;
        }
        match display_get_primary() {
            Some(display) => {
                let bounds = display.bounds();
                Self {
                    width: bounds.width.max(1) as u32,
                    height: bounds.height.max(1) as u32,
                    scale_factor: f64::from(display.device_scale_factor()).max(0.01),
                }
            }
            None => Self {
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
        }
    }

    /// 画布的物理像素尺寸。
    pub fn physical_size(&self) -> (u32, u32) {
        let scale = self.scale_factor.max(0.01);
        (
            ((self.width as f64) * scale).round().max(1.0) as u32,
            ((self.height as f64) * scale).round().max(1.0) as u32,
        )
    }
}

/// 建窗前登记的离屏参数。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffscreenOptions {
    pub geometry: OffscreenGeometry,
    /// `OnPaint` / `OnAcceleratedPaint` 的最高帧率（CEF 下限 1）。
    pub frame_rate: u32,
    /// 走共享纹理（加速绘制，Linux 上交 dmabuf）；关掉时 CEF 软件绘制、交整帧像素。
    pub shared_texture: bool,
}

/// 帧的像素顺序（CEF 的 `cef_color_type_t`），每像素 4 字节。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffscreenPixelFormat {
    /// 内存里 B、G、R、A（DRM `ARGB8888`）。
    Bgra,
    /// 内存里 R、G、B、A（DRM `ABGR8888`）。
    Rgba,
}

/// dmabuf 的一个 plane。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DmaBufPlane {
    pub fd: i32,
    pub stride: u32,
    pub offset: u64,
    pub size: u64,
}

/// 交给接收器的一帧。
pub enum OffscreenFrame<'a> {
    /// CEF 缓冲池里的 dmabuf：只在本次回调内有效，接收器必须在返回前把内容拷走，不能留住 fd。
    /// `width` / `height` 是缓冲尺寸（coded size），有效内容在 `visible` 里。
    DmaBuf {
        planes: &'a [DmaBufPlane],
        modifier: u64,
        format: OffscreenPixelFormat,
        width: u32,
        height: u32,
        visible: (i32, i32, u32, u32),
    },
    /// 软件绘制的整帧，行距 `width * 4`。
    Cpu {
        data: &'a [u8],
        format: OffscreenPixelFormat,
        width: u32,
        height: u32,
    },
}

/// 帧接收器。在 CEF UI 线程上同步调用，不能阻塞太久（会拖住整个 browser 进程的 UI 线程）。
pub trait OffscreenFrameSink: Send + Sync {
    fn on_frame(&self, frame: OffscreenFrame<'_>);
}

static OPTIONS: OnceLock<Mutex<HashMap<String, OffscreenOptions>>> = OnceLock::new();
static SINKS: OnceLock<Mutex<HashMap<String, Arc<dyn OffscreenFrameSink>>>> = OnceLock::new();
static VIEWS: OnceLock<Mutex<HashMap<String, Arc<OffscreenView>>>> = OnceLock::new();

fn options() -> &'static Mutex<HashMap<String, OffscreenOptions>> {
    OPTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sinks() -> &'static Mutex<HashMap<String, Arc<dyn OffscreenFrameSink>>> {
    SINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn views() -> &'static Mutex<HashMap<String, Arc<OffscreenView>>> {
    VIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn register_offscreen(webview_label: &str, opts: OffscreenOptions) {
    if let Ok(mut map) = options().lock() {
        map.insert(webview_label.to_string(), opts);
    }
}

pub(crate) fn unregister_offscreen(webview_label: &str) {
    if let Ok(mut map) = options().lock() {
        map.remove(webview_label);
    }
}

/// 建窗时查：这个 label 登记过离屏就返回参数。
pub(crate) fn options_for(webview_label: &str) -> Option<OffscreenOptions> {
    options().lock().ok()?.get(webview_label).copied()
}

pub(crate) fn set_frame_sink(webview_label: &str, sink: Option<Arc<dyn OffscreenFrameSink>>) {
    if let Ok(mut map) = sinks().lock() {
        match sink {
            Some(sink) => {
                map.insert(webview_label.to_string(), sink);
            }
            None => {
                map.remove(webview_label);
            }
        }
    }
}

fn sink_for(webview_label: &str) -> Option<Arc<dyn OffscreenFrameSink>> {
    sinks().lock().ok()?.get(webview_label).cloned()
}

/// 一个离屏 browser 的视图：几何由窗口状态、渲染回调与公开接口共用。
pub(crate) struct OffscreenView {
    pub(crate) label: String,
    geometry: Mutex<OffscreenGeometry>,
}

impl OffscreenView {
    /// 新建并登记（同 label 的旧视图被替换）。
    pub(crate) fn register(label: &str, geometry: OffscreenGeometry) -> Arc<Self> {
        let view = Arc::new(Self {
            label: label.to_string(),
            geometry: Mutex::new(geometry),
        });
        if let Ok(mut map) = views().lock() {
            map.insert(label.to_string(), view.clone());
        }
        view
    }

    /// browser 关掉后注销（只注销自己，同 label 新建的视图不受影响）。
    pub(crate) fn unregister(self: &Arc<Self>) {
        if let Ok(mut map) = views().lock() {
            if map.get(&self.label).is_some_and(|v| Arc::ptr_eq(v, self)) {
                map.remove(&self.label);
            }
        }
    }

    pub(crate) fn geometry(&self) -> OffscreenGeometry {
        *self.geometry.lock().expect("offscreen geometry mutex poisoned")
    }

    /// 换几何，返回缩放是否变了（变了要 `NotifyScreenInfoChanged`）。
    pub(crate) fn set_geometry(&self, geometry: OffscreenGeometry) -> bool {
        let mut current = self.geometry.lock().expect("offscreen geometry mutex poisoned");
        let scale_changed = current.scale_factor != geometry.scale_factor;
        *current = geometry;
        scale_changed
    }
}

pub(crate) fn view_for(webview_label: &str) -> Option<Arc<OffscreenView>> {
    views().lock().ok()?.get(webview_label).cloned()
}

pub(crate) fn resize(webview_label: &str, geometry: OffscreenGeometry) -> Result<(), String> {
    crate::webview::with_offscreen_browser(webview_label, move |browser, view| {
        let scale_changed = view.set_geometry(geometry);
        if let Some(host) = browser.host() {
            if scale_changed {
                host.notify_screen_info_changed();
            }
            host.was_resized();
        }
    })
}

pub(crate) fn set_hidden(webview_label: &str, hidden: bool) -> Result<(), String> {
    crate::webview::with_offscreen_browser(webview_label, move |browser, _| {
        if let Some(host) = browser.host() {
            host.was_hidden(i32::from(hidden));
        }
    })
}

pub(crate) fn set_frame_rate(webview_label: &str, frame_rate: u32) -> Result<(), String> {
    crate::webview::with_offscreen_browser(webview_label, move |browser, _| {
        if let Some(host) = browser.host() {
            host.set_windowless_frame_rate(frame_rate.max(1) as i32);
        }
    })
}

pub(crate) fn invalidate(webview_label: &str) -> Result<(), String> {
    crate::webview::with_offscreen_browser(webview_label, |browser, _| {
        if let Some(host) = browser.host() {
            host.invalidate(PaintElementType::default());
        }
    })
}

/// 离屏 browser 的 `CefWindowInfo`。
pub(crate) fn window_info(opts: &OffscreenOptions) -> WindowInfo {
    WindowInfo {
        windowless_rendering_enabled: 1,
        // 共享纹理只在 Linux 接了接收路径（dmabuf）
        shared_texture_enabled: (cfg!(target_os = "linux") && opts.shared_texture) as _,
        ..Default::default()
    }
}

/// 离屏 browser 的 `CefBrowserSettings`：帧率上限，背景不透明（壁纸不需要透明）。
pub(crate) fn browser_settings(opts: &OffscreenOptions) -> BrowserSettings {
    BrowserSettings {
        windowless_frame_rate: opts.frame_rate.max(1) as _,
        background_color: 0xff00_0000,
        ..Default::default()
    }
}

fn pixel_format(format: &ColorType) -> OffscreenPixelFormat {
    if *format.as_ref() == cef::sys::cef_color_type_t::CEF_COLOR_TYPE_RGBA_8888 {
        OffscreenPixelFormat::Rgba
    } else {
        OffscreenPixelFormat::Bgra
    }
}

wrap_render_handler! {
    pub(crate) struct OffscreenRenderHandler {
        view: Arc<OffscreenView>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let geometry = self.view.geometry();
                rect.x = 0;
                rect.y = 0;
                rect.width = geometry.width.max(1) as _;
                rect.height = geometry.height.max(1) as _;
            }
        }

        fn screen_info(
            &self,
            _browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> ::std::os::raw::c_int {
            let Some(screen_info) = screen_info else {
                return 0;
            };
            let geometry = self.view.geometry();
            screen_info.device_scale_factor = geometry.scale_factor as f32;
            let rect = Rect {
                x: 0,
                y: 0,
                width: geometry.width.max(1) as _,
                height: geometry.height.max(1) as _,
            };
            screen_info.rect = rect.clone();
            screen_info.available_rect = rect;
            1
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            buffer: *const u8,
            width: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ) {
            // 弹出控件（<select> 下拉等）不单独交出：壁纸不交互这类控件
            if type_ != PaintElementType::default() || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            let Some(sink) = sink_for(&self.view.label) else {
                return;
            };
            let len = width as usize * height as usize * 4;
            // SAFETY: CEF 保证 buffer 是 width × height 的 BGRA 像素，在本次回调内有效。
            let data = unsafe { std::slice::from_raw_parts(buffer, len) };
            sink.on_frame(OffscreenFrame::Cpu {
                data,
                format: OffscreenPixelFormat::Bgra,
                width: width as u32,
                height: height as u32,
            });
        }

        #[cfg(target_os = "linux")]
        fn on_accelerated_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            info: Option<&AcceleratedPaintInfo>,
        ) {
            let Some(info) = info else { return };
            if type_ != PaintElementType::default() {
                return;
            }
            let Some(sink) = sink_for(&self.view.label) else {
                return;
            };
            let count = (info.plane_count.max(0) as usize).min(info.planes.len());
            let mut planes = [DmaBufPlane { fd: -1, stride: 0, offset: 0, size: 0 }; 4];
            for (dst, src) in planes.iter_mut().zip(&info.planes[..count]) {
                *dst = DmaBufPlane {
                    fd: src.fd,
                    stride: src.stride,
                    offset: src.offset,
                    size: src.size,
                };
            }
            let visible = &info.extra.visible_rect;
            sink.on_frame(OffscreenFrame::DmaBuf {
                planes: &planes[..count],
                modifier: info.modifier,
                format: pixel_format(&info.format),
                width: info.extra.coded_size.width.max(0) as u32,
                height: info.extra.coded_size.height.max(0) as u32,
                visible: (
                    visible.x,
                    visible.y,
                    visible.width.max(0) as u32,
                    visible.height.max(0) as u32,
                ),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_size_rounds_and_never_hits_zero() {
        let g = OffscreenGeometry { width: 2649, height: 1490, scale_factor: 1.45 };
        assert_eq!(g.physical_size(), (3841, 2161));
        let tiny = OffscreenGeometry { width: 0, height: 0, scale_factor: 1.0 };
        assert_eq!(tiny.physical_size(), (1, 1));
    }

    #[test]
    fn options_are_per_label() {
        let opts = OffscreenOptions {
            geometry: OffscreenGeometry { width: 800, height: 600, scale_factor: 1.0 },
            frame_rate: 30,
            shared_texture: true,
        };
        register_offscreen("offscreen-test-a", opts);
        assert_eq!(options_for("offscreen-test-a"), Some(opts));
        assert_eq!(options_for("offscreen-test-b"), None);
        unregister_offscreen("offscreen-test-a");
        assert_eq!(options_for("offscreen-test-a"), None);
    }
}
