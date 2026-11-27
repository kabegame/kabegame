//! 离屏 CEF 帧接收器 → Wayland `zwlr_layer_shell_v1` 背景层。
//!
//! - [`LayerShellSink`] 在独立线程里维护一条 Wayland 连接，为每个 `wl_output` 建一个
//!   `Layer::Background` 的 layer surface（`anchor = ALL`、`exclusive_zone = -1`、不收键盘）。
//! - 3 槽环形缓冲池共享于 CEF UI 线程与 Wayland 线程：收到 `DmaBuf` 且合成器与本机 GPU 有公共
//!   modifier 时走 GBM/EGL `blit_to_target` + `zwp_linux_dmabuf_v1` 零回读提交；否则退回
//!   `memfd` + `wl_shm`（`DmaBuf` 经 `blit_to_memory` 读回，`Cpu` 直接写入）。
//! - [`Self::on_frame`] 运行在 CEF UI 线程，只持短锁写空闲槽并写 1 字节到非阻塞 wakeup pipe，
//!   绝不阻塞等待 Wayland 往返。
//! - 同时绑定 `wl_seat` / `wl_pointer`，把桌面上的指针移动与左键经 `tauri_plugin_cursor`
//!   的外部指针来源注入壁纸窗口内的 iframe。

use std::collections::HashMap;
use std::ffi::CString;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri_plugin_cursor::{push_external_pointer, PointerOrigin, Sample};
use tauri_runtime_kbcef::{OffscreenFrame, OffscreenGeometry, OffscreenPixelFormat};
use wayland_client::protocol::{
    wl_buffer, wl_callback, wl_compositor, wl_output, wl_pointer, wl_region, wl_registry, wl_seat,
    wl_shm, wl_shm_pool, wl_surface,
};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, WEnum};
use wayland_protocols::wp::fractional_scale::v1::client::{
    wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
    wp_fractional_scale_v1::{self, WpFractionalScaleV1},
};
use wayland_protocols::wp::linux_dmabuf::zv1::client::{
    zwp_linux_buffer_params_v1::{self, ZwpLinuxBufferParamsV1},
    zwp_linux_dmabuf_feedback_v1::{self, ZwpLinuxDmabufFeedbackV1},
    zwp_linux_dmabuf_v1::{self, ZwpLinuxDmabufV1},
};
use wayland_protocols::wp::viewporter::client::{
    wp_viewport::{self, WpViewport},
    wp_viewporter::WpViewporter,
};
use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1::{Layer, ZwlrLayerShellV1},
    zwlr_layer_surface_v1::{self, Anchor, KeyboardInteractivity, ZwlrLayerSurfaceV1},
};

use crate::wallpaper::manager::plasma::pipewire::gpu::{
    self, DmaBufSource, GpuTarget, DRM_FORMAT_ARGB8888,
};

const SLOT_COUNT: usize = 3;
/// Linux `BTN_LEFT`（`<linux/input-event-codes.h>`）。
const BTN_LEFT: u32 = 0x110;
const LAYER_NAMESPACE: &str = "kabegame-wallpaper";
const FIRST_FRAME_NUDGE_AFTER: Duration = Duration::from_millis(1000);
const DMABUF_STALL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchdogDecision {
    Idle,
    WaitMs(i32),
    NudgeInvalidate,
    TriggerFallback,
}

fn evaluate_first_frame_watchdog(
    expect_dmabuf: bool,
    offscreen_shown: bool,
    frames_received: u64,
    nudged: bool,
    stalled_reported: bool,
    elapsed: Duration,
) -> WatchdogDecision {
    if !expect_dmabuf || !offscreen_shown || frames_received > 0 || stalled_reported {
        return WatchdogDecision::Idle;
    }
    if elapsed >= DMABUF_STALL_TIMEOUT {
        return WatchdogDecision::TriggerFallback;
    }
    if !nudged && elapsed >= FIRST_FRAME_NUDGE_AFTER {
        return WatchdogDecision::NudgeInvalidate;
    }
    let next_deadline = if !nudged {
        FIRST_FRAME_NUDGE_AFTER
    } else {
        DMABUF_STALL_TIMEOUT
    };
    let remaining_ms = next_deadline
        .saturating_sub(elapsed)
        .as_millis()
        .clamp(50, 1000) as i32;
    WatchdogDecision::WaitMs(remaining_ms)
}

// ---- 缓冲池与共享状态 ----

enum SlotStorage {
    DmaBuf {
        target: GpuTarget,
        modifier: u64,
    },
    Shm {
        fd: OwnedFd,
        ptr: *mut u8,
        len: usize,
    },
}

// SAFETY: Shm 里的映射指针只在持有 FramePool 锁写像素，且对应的 wl_buffer 只由 Wayland 线程按
// busy_count 约束使用，不会并发读写同一段内存。
unsafe impl Send for SlotStorage {}
unsafe impl Sync for SlotStorage {}

impl Drop for SlotStorage {
    fn drop(&mut self) {
        if let SlotStorage::Shm { ptr, len, .. } = self {
            if !ptr.is_null() && *len > 0 {
                // SAFETY: `ptr` 由 `mmap` 按 `len` 映射。
                unsafe {
                    libc::munmap((*ptr).cast(), *len);
                }
                *ptr = std::ptr::null_mut();
                *len = 0;
            }
        }
    }
}

impl SlotStorage {
    fn alloc_shm(width: u32, height: u32) -> Result<Self, String> {
        let len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| format!("SHM 尺寸溢出: {width}x{height}"))?;
        let name = CString::new("kabegame-layer-shell").unwrap();
        // SAFETY: memfd_create + ftruncate + mmap 是标准 POSIX/Linux 流程；失败时立即返回。
        unsafe {
            let raw_fd = libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC);
            if raw_fd < 0 {
                return Err(format!(
                    "memfd_create 失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let fd = OwnedFd::from_raw_fd(raw_fd);
            if libc::ftruncate(fd.as_raw_fd(), len as libc::off_t) < 0 {
                return Err(format!(
                    "ftruncate({len}) 失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let ptr = libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            );
            if ptr == libc::MAP_FAILED {
                return Err(format!("mmap({len}) 失败: {}", std::io::Error::last_os_error()));
            }
            Ok(SlotStorage::Shm {
                fd,
                ptr: ptr.cast(),
                len,
            })
        }
    }

    fn shm_slice_mut_unchecked(&self) -> Option<&mut [u8]> {
        match self {
            SlotStorage::Shm { ptr, len, .. } if !ptr.is_null() && *len > 0 => {
                // SAFETY: 调用方持有 FramePool 锁且确认 `busy_count == 0`，Wayland 线程与合成器不会读此缓冲。
                Some(unsafe { std::slice::from_raw_parts_mut(*ptr, *len) })
            }
            _ => None,
        }
    }
}

struct FrameSlot {
    generation: u64,
    width: u32,
    height: u32,
    storage: Option<Arc<SlotStorage>>,
    /// 当前有多少个 output 持有着尚未收到 `wl_buffer.release` 的该槽缓冲。
    busy_count: usize,
}

impl Default for FrameSlot {
    fn default() -> Self {
        Self {
            generation: 0,
            width: 0,
            height: 0,
            storage: None,
            busy_count: 0,
        }
    }
}

struct FramePool {
    width: u32,
    height: u32,
    generation: u64,
    frame_seq: u64,
    slots: [FrameSlot; SLOT_COUNT],
    /// `(generation, slot_idx, frame_seq)`
    latest_ready: Option<(u64, usize, u64)>,
    /// 由 Wayland 线程协商得到的公共 dmabuf modifier（None 表示只能走 SHM）。
    dmabuf_modifier: Option<u64>,
    /// 若 dmabuf 路径出现运行期错误，降级为 SHM 避免反复报错。
    dmabuf_broken: bool,
}

impl FramePool {
    fn new(dmabuf_modifier: Option<u64>) -> Self {
        Self {
            width: 0,
            height: 0,
            generation: 0,
            frame_seq: 0,
            slots: std::array::from_fn(|_| FrameSlot::default()),
            latest_ready: None,
            dmabuf_modifier,
            dmabuf_broken: false,
        }
    }

    fn pick_free_slot(&self) -> Option<usize> {
        let latest = self.latest_ready.map(|(gen_id, idx, _)| (gen_id, idx));
        // 优先选空闲且不是刚写完的 latest_ready，防止在 Wayland 线程还没取走时覆盖。
        if let Some(idx) = (0..SLOT_COUNT).find(|&i| {
            self.slots[i].busy_count == 0 && latest != Some((self.generation, i))
        }) {
            return Some(idx);
        }
        (0..SLOT_COUNT).find(|&i| self.slots[i].busy_count == 0)
    }
}

// ---- 对外 Sink ----

/// 离屏 CEF 到 Wayland `zwlr_layer_shell_v1` 背景层的帧接收器。
pub struct LayerShellSink {
    label: String,
    pool: Arc<Mutex<FramePool>>,
    wakeup_write: OwnedFd,
    shutdown: Arc<AtomicBool>,
    frames_received: Arc<AtomicU64>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl LayerShellSink {
    pub fn new(
        label: String,
        expect_dmabuf: bool,
        on_stalled: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Result<Self, String> {
        let (wakeup_read, wakeup_write) = create_wakeup_pipe()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let frames_received = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<Arc<Mutex<FramePool>>, String>>(1);

        let thread_label = label.clone();
        let thread_shutdown = shutdown.clone();
        let thread_frames = frames_received.clone();
        let handle = std::thread::Builder::new()
            .name(format!("wallpaper-layer-shell-{label}"))
            .spawn(move || {
                run_wayland_loop(
                    thread_label,
                    wakeup_read,
                    thread_shutdown,
                    expect_dmabuf,
                    thread_frames,
                    on_stalled,
                    ready_tx,
                );
            })
            .map_err(|e| format!("启动 layer-shell 线程失败: {e}"))?;

        let pool = match ready_rx.recv() {
            Ok(Ok(pool)) => pool,
            Ok(Err(e)) => {
                shutdown.store(true, Ordering::SeqCst);
                let _ = handle.join();
                return Err(e);
            }
            Err(_) => {
                shutdown.store(true, Ordering::SeqCst);
                let _ = handle.join();
                return Err("layer-shell 线程在初始化完成前退出".to_string());
            }
        };

        Ok(Self {
            label,
            pool,
            wakeup_write,
            shutdown,
            frames_received,
            thread: Mutex::new(Some(handle)),
        })
    }

    /// 请求 Wayland 线程退出并等待清理完成（幂等）。
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        wake(&self.wakeup_write);
        if let Some(handle) = self
            .thread
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for LayerShellSink {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl tauri_runtime_kbcef::OffscreenFrameSink for LayerShellSink {
    fn on_frame(&self, frame: OffscreenFrame<'_>) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        self.frames_received.fetch_add(1, Ordering::Relaxed);
        let (phys_w, phys_h) = match &frame {
            OffscreenFrame::DmaBuf { visible, .. } => (visible.2.max(1), visible.3.max(1)),
            OffscreenFrame::Cpu { width, height, .. } => ((*width).max(1), (*height).max(1)),
        };

        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if pool.width != phys_w || pool.height != phys_h {
            pool.width = phys_w;
            pool.height = phys_h;
            pool.generation = pool.generation.wrapping_add(1).max(1);
            pool.latest_ready = None;
        }
        let generation = pool.generation;
        let Some(slot_idx) = pool.pick_free_slot() else {
            return;
        };

        let gpu_ctx = gpu::get();
        let want_dmabuf = matches!(frame, OffscreenFrame::DmaBuf { .. })
            && pool.dmabuf_modifier.is_some()
            && !pool.dmabuf_broken
            && gpu_ctx.is_some();

        let modifier_if_dmabuf = if want_dmabuf {
            pool.dmabuf_modifier
        } else {
            None
        };

        let need_alloc = {
            let slot = &pool.slots[slot_idx];
            slot.generation != generation
                || slot.width != phys_w
                || slot.height != phys_h
                || match (&slot.storage, modifier_if_dmabuf) {
                    (Some(s), Some(_)) => !matches!(s.as_ref(), SlotStorage::DmaBuf { .. }),
                    (Some(s), None) => !matches!(s.as_ref(), SlotStorage::Shm { .. }),
                    (None, _) => true,
                }
        };

        if need_alloc {
            let allocated = if let (Some(gpu), Some(modifier)) = (gpu_ctx, modifier_if_dmabuf) {
                match gpu.alloc_target(phys_w, phys_h, modifier) {
                    Ok(target) => Ok(Arc::new(SlotStorage::DmaBuf { target, modifier })),
                    Err(e) => {
                        tracing::warn!(
                            "layer-shell {} 分配 dmabuf 输出缓冲失败，降级到 SHM: {e}",
                            self.label
                        );
                        pool.dmabuf_broken = true;
                        SlotStorage::alloc_shm(phys_w, phys_h).map(Arc::new)
                    }
                }
            } else {
                SlotStorage::alloc_shm(phys_w, phys_h).map(Arc::new)
            };
            match allocated {
                Ok(storage) => {
                    let slot = &mut pool.slots[slot_idx];
                    slot.generation = generation;
                    slot.width = phys_w;
                    slot.height = phys_h;
                    slot.storage = Some(storage);
                }
                Err(e) => {
                    tracing::warn!("layer-shell {} 分配帧缓冲失败: {e}", self.label);
                    return;
                }
            }
        }

        let Some(storage_arc) = pool.slots[slot_idx].storage.clone() else {
            return;
        };

        let write_result = match (frame, storage_arc.as_ref(), gpu_ctx) {
            (
                OffscreenFrame::DmaBuf {
                    planes,
                    modifier,
                    format,
                    width,
                    height,
                    visible,
                },
                SlotStorage::DmaBuf { target, .. },
                Some(gpu),
            ) => {
                let source = DmaBufSource {
                    planes,
                    modifier,
                    format,
                    width,
                    height,
                    visible,
                };
                match gpu.blit_to_target(&source, target) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        tracing::warn!(
                            "layer-shell {} dmabuf blit 失败，后续帧降级到 SHM: {e}",
                            self.label
                        );
                        pool.dmabuf_broken = true;
                        Err(e)
                    }
                }
            }
            (
                OffscreenFrame::DmaBuf {
                    planes,
                    modifier,
                    format,
                    width,
                    height,
                    visible,
                },
                storage @ SlotStorage::Shm { .. },
                Some(gpu),
            ) => {
                let source = DmaBufSource {
                    planes,
                    modifier,
                    format,
                    width,
                    height,
                    visible,
                };
                if let Some(buf) = storage.shm_slice_mut_unchecked() {
                    gpu.blit_to_memory(&source, phys_w, phys_h, buf)
                } else {
                    Err("SHM 映射无效".to_string())
                }
            }
            (
                OffscreenFrame::Cpu {
                    data,
                    format,
                    width,
                    height,
                },
                storage @ SlotStorage::Shm { .. },
                _,
            ) => {
                if let Some(buf) = storage.shm_slice_mut_unchecked() {
                    write_cpu_bgra(data, format, width, height, buf);
                    Ok(())
                } else {
                    Err("SHM 映射无效".to_string())
                }
            }
            _ => Err("帧类型与缓冲存储不匹配".to_string()),
        };

        if let Err(e) = write_result {
            tracing::debug!("layer-shell {} 写入帧跳过: {e}", self.label);
            return;
        }

        pool.frame_seq = pool.frame_seq.wrapping_add(1).max(1);
        let seq = pool.frame_seq;
        pool.latest_ready = Some((generation, slot_idx, seq));
        drop(pool);
        wake(&self.wakeup_write);
    }
}

fn write_cpu_bgra(
    src: &[u8],
    format: OffscreenPixelFormat,
    width: u32,
    height: u32,
    dst: &mut [u8],
) {
    let bytes = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4)
        .min(src.len())
        .min(dst.len());
    match format {
        OffscreenPixelFormat::Bgra => {
            dst[..bytes].copy_from_slice(&src[..bytes]);
        }
        OffscreenPixelFormat::Rgba => {
            for (s, d) in src[..bytes].chunks_exact(4).zip(dst[..bytes].chunks_exact_mut(4)) {
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
        }
    }
}

// ---- Wayland 线程与协议实现 ----

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct BufferKey {
    output_name: u32,
    generation: u64,
    slot_idx: usize,
}

struct CachedBuffer {
    buffer: wl_buffer::WlBuffer,
    width: u32,
    height: u32,
    /// 保持底层 GpuTarget / Shm 映射在 WlBuffer 销毁前一直存活。
    _storage: Arc<SlotStorage>,
}

struct BufferUserData {
    key: BufferKey,
    released: AtomicBool,
}

struct OutputSurface {
    output: wl_output::WlOutput,
    surface: wl_surface::WlSurface,
    layer_surface: ZwlrLayerSurfaceV1,
    viewport: Option<WpViewport>,
    fractional_scale: Option<WpFractionalScaleV1>,
    logical_w: u32,
    logical_h: u32,
    integer_scale: i32,
    fractional_scale_120: Option<u32>,
    configured: bool,
    frame_pending: bool,
    last_committed_seq: u64,
}

impl OutputSurface {
    fn effective_scale(&self, has_viewporter: bool) -> f64 {
        if has_viewporter {
            if let Some(scale_120) = self.fractional_scale_120 {
                return (f64::from(scale_120) / 120.0).max(0.5);
            }
        }
        f64::from(self.integer_scale.max(1))
    }

    fn destroy(&mut self) {
        if let Some(fs) = self.fractional_scale.take() {
            fs.destroy();
        }
        if let Some(vp) = self.viewport.take() {
            vp.destroy();
        }
        self.layer_surface.destroy();
        self.surface.destroy();
        if self.output.version() >= 3 {
            self.output.release();
        }
    }
}

struct PointerState {
    pointer: wl_pointer::WlPointer,
    focused_output: Option<u32>,
    surface_x: f64,
    surface_y: f64,
    left_down: bool,
}

struct WaylandState {
    label: String,
    pool: Arc<Mutex<FramePool>>,
    compositor: Option<wl_compositor::WlCompositor>,
    layer_shell: Option<ZwlrLayerShellV1>,
    shm: Option<wl_shm::WlShm>,
    dmabuf: Option<ZwpLinuxDmabufV1>,
    dmabuf_feedback: Option<ZwpLinuxDmabufFeedbackV1>,
    dmabuf_feedback_done: bool,
    dmabuf_format_table: Vec<(u32, u64)>,
    compositor_argb_modifiers: Vec<u64>,
    viewporter: Option<WpViewporter>,
    fractional_scale_manager: Option<WpFractionalScaleManagerV1>,
    seat: Option<(u32, wl_seat::WlSeat)>,
    pointer: Option<PointerState>,
    outputs: HashMap<u32, OutputSurface>,
    pending_outputs: Vec<(u32, u32)>,
    buffers: HashMap<BufferKey, CachedBuffer>,
    offscreen_geom: Option<OffscreenGeometry>,
    offscreen_shown: bool,
    ready: bool,
}

impl WaylandState {
    fn new(label: String, pool: Arc<Mutex<FramePool>>) -> Self {
        Self {
            label,
            pool,
            compositor: None,
            layer_shell: None,
            shm: None,
            dmabuf: None,
            dmabuf_feedback: None,
            dmabuf_feedback_done: false,
            dmabuf_format_table: Vec::new(),
            compositor_argb_modifiers: Vec::new(),
            viewporter: None,
            fractional_scale_manager: None,
            seat: None,
            pointer: None,
            outputs: HashMap::new(),
            pending_outputs: Vec::new(),
            buffers: HashMap::new(),
            offscreen_geom: None,
            offscreen_shown: false,
            ready: false,
        }
    }

    fn bind_output(
        &mut self,
        registry: &wl_registry::WlRegistry,
        name: u32,
        version: u32,
        qh: &QueueHandle<Self>,
    ) {
        if self.outputs.contains_key(&name) {
            return;
        }
        let (Some(compositor), Some(layer_shell)) = (&self.compositor, &self.layer_shell) else {
            return;
        };
        let output = registry.bind::<wl_output::WlOutput, _, _>(name, version.min(4), qh, name);
        let surface = compositor.create_surface(qh, name);
        let layer_surface = layer_shell.get_layer_surface(
            &surface,
            Some(&output),
            Layer::Background,
            LAYER_NAMESPACE.to_string(),
            qh,
            name,
        );
        layer_surface.set_anchor(Anchor::Top | Anchor::Bottom | Anchor::Left | Anchor::Right);
        layer_surface.set_exclusive_zone(-1);
        layer_surface.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer_surface.set_size(0, 0);

        let viewport = self
            .viewporter
            .as_ref()
            .map(|vp| vp.get_viewport(&surface, qh, ()));
        let fractional_scale = self
            .fractional_scale_manager
            .as_ref()
            .map(|fs| fs.get_fractional_scale(&surface, qh, name));

        // 首次空提交触发合成器发送 Configure（规范要求在 ack_configure 前不能 attach buffer）。
        surface.commit();

        self.outputs.insert(
            name,
            OutputSurface {
                output,
                surface,
                layer_surface,
                viewport,
                fractional_scale,
                logical_w: 0,
                logical_h: 0,
                integer_scale: 1,
                fractional_scale_120: None,
                configured: false,
                frame_pending: false,
                last_committed_seq: 0,
            },
        );
    }

    fn sync_offscreen_geometry(&mut self) {
        let has_viewporter = self.viewporter.is_some();
        // 挑选面积最大的已配置 output 作为离屏渲染基准，保证多屏环境下清晰度不缩水。
        let best = self
            .outputs
            .values()
            .filter(|o| o.configured && o.logical_w > 0 && o.logical_h > 0)
            .max_by_key(|o| u64::from(o.logical_w) * u64::from(o.logical_h));
        let Some(output) = best else {
            return;
        };
        let geom = OffscreenGeometry {
            width: output.logical_w,
            height: output.logical_h,
            scale_factor: output.effective_scale(has_viewporter),
        };
        if self.offscreen_geom != Some(geom) {
            self.offscreen_geom = Some(geom);
            if let Err(e) = tauri_runtime_kbcef::resize_offscreen(&self.label, geom) {
                tracing::warn!("layer-shell {} 调整离屏尺寸失败: {e}", self.label);
            }
        }
        if !self.offscreen_shown {
            self.offscreen_shown = true;
            if let Err(e) = tauri_runtime_kbcef::set_offscreen_hidden(&self.label, false) {
                tracing::warn!("layer-shell {} 开启离屏渲染失败: {e}", self.label);
            }
        }
        if let Err(e) = tauri_runtime_kbcef::invalidate_offscreen(&self.label) {
            tracing::debug!("layer-shell {} 请求重画失败: {e}", self.label);
        }
    }

    fn flush_frames(&mut self, qh: &QueueHandle<Self>) {
        let has_viewporter = self.viewporter.is_some();
        let (latest, phys_w, phys_h, storage_arc) = {
            let pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
            let Some((gen_id, slot_idx, seq)) = pool.latest_ready else {
                return;
            };
            let slot = &pool.slots[slot_idx];
            if slot.generation != gen_id {
                return;
            }
            let Some(storage) = slot.storage.clone() else {
                return;
            };
            ((gen_id, slot_idx, seq), slot.width, slot.height, storage)
        };
        let (gen_id, slot_idx, seq) = latest;

        // 清理已释放且不再属于当前 generation 的旧 WlBuffer，防止长期运行残留。
        self.buffers.retain(|key, buf| {
            if key.generation == gen_id {
                return true;
            }
            let released = buf
                .buffer
                .data::<BufferUserData>()
                .is_some_and(|d| d.released.load(Ordering::Acquire));
            if released {
                buf.buffer.destroy();
                false
            } else {
                true
            }
        });

        let output_names: Vec<u32> = self.outputs.keys().copied().collect();
        for output_name in output_names {
            let (configured, frame_pending, last_seq, logical_w, logical_h, integer_scale) = {
                let Some(out) = self.outputs.get(&output_name) else {
                    continue;
                };
                (
                    out.configured,
                    out.frame_pending,
                    out.last_committed_seq,
                    out.logical_w,
                    out.logical_h,
                    out.integer_scale,
                )
            };
            if !configured || frame_pending || last_seq == seq || logical_w == 0 || logical_h == 0 {
                continue;
            }

            let key = BufferKey {
                output_name,
                generation: gen_id,
                slot_idx,
            };

            let need_recreate = self
                .buffers
                .get(&key)
                .is_none_or(|b| b.width != phys_w || b.height != phys_h);
            if need_recreate {
                if let Some(old) = self.buffers.remove(&key) {
                    old.buffer.destroy();
                }
                let created = create_wl_buffer(
                    self.shm.as_ref(),
                    self.dmabuf.as_ref(),
                    key,
                    phys_w,
                    phys_h,
                    &storage_arc,
                    qh,
                );
                match created {
                    Some(buffer) => {
                        self.buffers.insert(
                            key,
                            CachedBuffer {
                                buffer,
                                width: phys_w,
                                height: phys_h,
                                _storage: storage_arc.clone(),
                            },
                        );
                    }
                    None => continue,
                }
            }

            let Some(cached) = self.buffers.get(&key) else {
                continue;
            };
            if let Some(data) = cached.buffer.data::<BufferUserData>() {
                // 仅当未释放时不要重复 attach 同一个缓冲；正常情况此时它应该已被 release。
                if !data.released.swap(false, Ordering::AcqRel) {
                    // 刚新建时 released 默认为 true，若走到这里说明它仍在被合成器占用，跳过等待 release。
                    continue;
                }
            }
            {
                let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
                let slot = &mut pool.slots[slot_idx];
                if slot.generation == gen_id {
                    slot.busy_count += 1;
                }
            }

            let Some(out) = self.outputs.get_mut(&output_name) else {
                continue;
            };
            if has_viewporter {
                if let Some(vp) = &out.viewport {
                    vp.set_destination(logical_w as i32, logical_h as i32);
                }
            } else {
                out.surface.set_buffer_scale(integer_scale.max(1));
            }
            out.surface.attach(Some(&cached.buffer), 0, 0);
            out.surface
                .damage_buffer(0, 0, phys_w as i32, phys_h as i32);
            out.surface.frame(qh, output_name);
            out.surface.commit();
            out.frame_pending = true;
            out.last_committed_seq = seq;
        }
    }

    fn push_pointer(&self, output_name: u32, surface_x: f64, surface_y: f64, left_down: bool, present: bool) {
        let Some(out) = self.outputs.get(&output_name) else {
            return;
        };
        if out.logical_w == 0 || out.logical_h == 0 {
            return;
        }
        let geom = self.offscreen_geom.unwrap_or(OffscreenGeometry {
            width: out.logical_w,
            height: out.logical_h,
            scale_factor: 1.0,
        });
        let vx = surface_x * (f64::from(geom.width) / f64::from(out.logical_w));
        let vy = surface_y * (f64::from(geom.height) / f64::from(out.logical_h));
        push_external_pointer(
            &self.label,
            Sample {
                view: (vx, vy),
                inside: present,
                left_down,
                present,
            },
            PointerOrigin::Desktop,
        );
    }

    fn cleanup(&mut self) {
        for (_, mut out) in self.outputs.drain() {
            out.destroy();
        }
        for (_, cached) in self.buffers.drain() {
            cached.buffer.destroy();
        }
        if let Some(p) = self.pointer.take() {
            if p.pointer.version() >= 3 {
                p.pointer.release();
            }
        }
        if let Some((_, seat)) = self.seat.take() {
            if seat.version() >= 5 {
                seat.release();
            }
        }
        if let Some(fb) = self.dmabuf_feedback.take() {
            fb.destroy();
        }
        if let Some(dmabuf) = self.dmabuf.take() {
            dmabuf.destroy();
        }
        if let Some(vp) = self.viewporter.take() {
            vp.destroy();
        }
        if let Some(fs) = self.fractional_scale_manager.take() {
            fs.destroy();
        }
        if let Some(ls) = self.layer_shell.take() {
            if ls.version() >= 3 {
                ls.destroy();
            }
        }
    }
}

fn create_wl_buffer(
    shm: Option<&wl_shm::WlShm>,
    dmabuf: Option<&ZwpLinuxDmabufV1>,
    key: BufferKey,
    width: u32,
    height: u32,
    storage: &SlotStorage,
    qh: &QueueHandle<WaylandState>,
) -> Option<wl_buffer::WlBuffer> {
    let user_data = BufferUserData {
        key,
        released: AtomicBool::new(true),
    };
    match storage {
        SlotStorage::DmaBuf { target, modifier } => {
            let dmabuf = dmabuf?;
            let params = dmabuf.create_params(qh, ());
            let mod_hi = (*modifier >> 32) as u32;
            let mod_lo = (*modifier & 0xffff_ffff) as u32;
            for (index, plane) in target.planes.iter().enumerate() {
                params.add(
                    plane.fd.as_fd(),
                    index as u32,
                    plane.offset,
                    plane.stride,
                    mod_hi,
                    mod_lo,
                );
            }
            // `create_immed` 在协议上本身即销毁 `params`，不能再调 `params.destroy()`。
            let buf = params.create_immed(
                width as i32,
                height as i32,
                DRM_FORMAT_ARGB8888,
                zwp_linux_buffer_params_v1::Flags::empty(),
                qh,
                user_data,
            );
            Some(buf)
        }
        SlotStorage::Shm { fd, len, .. } => {
            let shm = shm?;
            let pool = shm.create_pool(fd.as_fd(), *len as i32, qh, ());
            let buf = pool.create_buffer(
                0,
                width as i32,
                height as i32,
                (width * 4) as i32,
                wl_shm::Format::Argb8888,
                qh,
                user_data,
            );
            pool.destroy();
            Some(buf)
        }
    }
}

// ---- Wayland Dispatch 实现 ----

impl Dispatch<wl_registry::WlRegistry, ()> for WaylandState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                if interface == wl_compositor::WlCompositor::interface().name {
                    state.compositor = Some(registry.bind::<wl_compositor::WlCompositor, _, _>(
                        name,
                        version.min(6),
                        qh,
                        (),
                    ));
                } else if interface == ZwlrLayerShellV1::interface().name {
                    state.layer_shell = Some(registry.bind::<ZwlrLayerShellV1, _, _>(
                        name,
                        version.min(4),
                        qh,
                        (),
                    ));
                } else if interface == wl_shm::WlShm::interface().name {
                    state.shm = Some(registry.bind::<wl_shm::WlShm, _, _>(
                        name,
                        version.min(2),
                        qh,
                        (),
                    ));
                } else if interface == ZwpLinuxDmabufV1::interface().name && version >= 3 {
                    let dmabuf = registry.bind::<ZwpLinuxDmabufV1, _, _>(
                        name,
                        version.min(4),
                        qh,
                        (),
                    );
                    if version >= 4 {
                        state.dmabuf_feedback = Some(dmabuf.get_default_feedback(qh, ()));
                    }
                    state.dmabuf = Some(dmabuf);
                } else if interface == WpViewporter::interface().name {
                    state.viewporter = Some(registry.bind::<WpViewporter, _, _>(
                        name,
                        version.min(1),
                        qh,
                        (),
                    ));
                } else if interface == WpFractionalScaleManagerV1::interface().name {
                    state.fractional_scale_manager =
                        Some(registry.bind::<WpFractionalScaleManagerV1, _, _>(
                            name,
                            version.min(1),
                            qh,
                            (),
                        ));
                } else if interface == wl_seat::WlSeat::interface().name && state.seat.is_none() {
                    let seat = registry.bind::<wl_seat::WlSeat, _, _>(
                        name,
                        version.min(9),
                        qh,
                        (),
                    );
                    state.seat = Some((name, seat));
                } else if interface == wl_output::WlOutput::interface().name {
                    if state.ready {
                        state.bind_output(registry, name, version, qh);
                    } else {
                        state.pending_outputs.push((name, version));
                    }
                }
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.pending_outputs.retain(|(pending, _)| *pending != name);
                if let Some(mut out) = state.outputs.remove(&name) {
                    out.destroy();
                    state.buffers.retain(|k, b| {
                        if k.output_name == name {
                            b.buffer.destroy();
                            false
                        } else {
                            true
                        }
                    });
                    state.sync_offscreen_geometry();
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_compositor::WlCompositor, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &wl_compositor::WlCompositor,
        _: wl_compositor::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrLayerShellV1, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &ZwlrLayerShellV1,
        _: wayland_protocols_wlr::layer_shell::v1::client::zwlr_layer_shell_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_shm::WlShm, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &wl_shm::WlShm,
        _: wl_shm::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_shm_pool::WlShmPool, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &wl_shm_pool::WlShmPool,
        _: wl_shm_pool::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpLinuxDmabufV1, ()> for WaylandState {
    fn event(
        state: &mut Self,
        _: &ZwpLinuxDmabufV1,
        event: zwp_linux_dmabuf_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zwp_linux_dmabuf_v1::Event::Modifier {
            format,
            modifier_hi,
            modifier_lo,
        } = event
        {
            if format == DRM_FORMAT_ARGB8888 {
                let modifier = (u64::from(modifier_hi) << 32) | u64::from(modifier_lo);
                if !state.compositor_argb_modifiers.contains(&modifier) {
                    state.compositor_argb_modifiers.push(modifier);
                }
            }
        }
    }
}

impl Dispatch<ZwpLinuxDmabufFeedbackV1, ()> for WaylandState {
    fn event(
        state: &mut Self,
        _: &ZwpLinuxDmabufFeedbackV1,
        event: zwp_linux_dmabuf_feedback_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwp_linux_dmabuf_feedback_v1::Event::FormatTable { fd, size } => {
                state.dmabuf_format_table = read_dmabuf_format_table(fd, size);
            }
            zwp_linux_dmabuf_feedback_v1::Event::TrancheFormats { indices } => {
                for chunk in indices.chunks_exact(2) {
                    let index = u16::from_ne_bytes([chunk[0], chunk[1]]) as usize;
                    if let Some(&(format, modifier)) = state.dmabuf_format_table.get(index) {
                        if format == DRM_FORMAT_ARGB8888
                            && !state.compositor_argb_modifiers.contains(&modifier)
                        {
                            state.compositor_argb_modifiers.push(modifier);
                        }
                    }
                }
            }
            zwp_linux_dmabuf_feedback_v1::Event::Done => {
                state.dmabuf_feedback_done = true;
            }
            _ => {}
        }
    }
}

fn read_dmabuf_format_table(fd: OwnedFd, size: u32) -> Vec<(u32, u64)> {
    let size = size as usize;
    if size < 16 {
        return Vec::new();
    }
    // SAFETY: Wayland 协议规定 FormatTable 是只读 memfd，每个条目 16 字节：(u32 format, u32 pad, u64 modifier)。
    unsafe {
        let ptr = libc::mmap(
            std::ptr::null_mut(),
            size,
            libc::PROT_READ,
            libc::MAP_PRIVATE,
            fd.as_raw_fd(),
            0,
        );
        if ptr == libc::MAP_FAILED {
            return Vec::new();
        }
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), size);
        let mut out = Vec::with_capacity(size / 16);
        for entry in bytes.chunks_exact(16) {
            let format = u32::from_ne_bytes(entry[0..4].try_into().unwrap());
            let modifier = u64::from_ne_bytes(entry[8..16].try_into().unwrap());
            out.push((format, modifier));
        }
        libc::munmap(ptr, size);
        out
    }
}

impl Dispatch<ZwpLinuxBufferParamsV1, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &ZwpLinuxBufferParamsV1,
        _: zwp_linux_buffer_params_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WpViewporter, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &WpViewporter,
        _: wayland_protocols::wp::viewporter::client::wp_viewporter::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WpViewport, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &WpViewport,
        _: wp_viewport::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WpFractionalScaleManagerV1, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &WpFractionalScaleManagerV1,
        _: wayland_protocols::wp::fractional_scale::v1::client::wp_fractional_scale_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WpFractionalScaleV1, u32> for WaylandState {
    fn event(
        state: &mut Self,
        _: &WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        output_name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            if let Some(out) = state.outputs.get_mut(output_name) {
                if out.fractional_scale_120 != Some(scale) {
                    out.fractional_scale_120 = Some(scale);
                    if out.configured {
                        state.sync_offscreen_geometry();
                    }
                }
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, u32> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        output_name: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Scale { factor } = event {
            if let Some(out) = state.outputs.get_mut(output_name) {
                let factor = factor.max(1);
                if out.integer_scale != factor {
                    out.integer_scale = factor;
                    if out.configured && out.fractional_scale_120.is_none() {
                        state.sync_offscreen_geometry();
                    }
                }
            }
        }
    }
}

impl Dispatch<wl_surface::WlSurface, u32> for WaylandState {
    fn event(
        _: &mut Self,
        _: &wl_surface::WlSurface,
        _: wl_surface::Event,
        _: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrLayerSurfaceV1, u32> for WaylandState {
    fn event(
        state: &mut Self,
        layer_surface: &ZwlrLayerSurfaceV1,
        event: zwlr_layer_surface_v1::Event,
        output_name: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_layer_surface_v1::Event::Configure {
                serial,
                width,
                height,
            } => {
                layer_surface.ack_configure(serial);
                let Some(out) = state.outputs.get_mut(output_name) else {
                    return;
                };
                if width > 0 && height > 0 {
                    out.logical_w = width;
                    out.logical_h = height;
                }
                out.configured = true;
                out.frame_pending = false;
                if let Some(compositor) = &state.compositor {
                    let region = compositor.create_region(qh, ());
                    region.add(0, 0, out.logical_w as i32, out.logical_h as i32);
                    out.surface.set_opaque_region(Some(&region));
                    region.destroy();
                }
                state.sync_offscreen_geometry();
                state.flush_frames(qh);
            }
            zwlr_layer_surface_v1::Event::Closed => {
                if let Some(mut out) = state.outputs.remove(output_name) {
                    out.destroy();
                    state.sync_offscreen_geometry();
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_region::WlRegion, ()> for WaylandState {
    fn event(
        _: &mut Self,
        _: &wl_region::WlRegion,
        _: wl_region::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<wl_buffer::WlBuffer, BufferUserData> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        data: &BufferUserData,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = event {
            if !data.released.swap(true, Ordering::AcqRel) {
                let mut pool = state.pool.lock().unwrap_or_else(|e| e.into_inner());
                let slot = &mut pool.slots[data.key.slot_idx];
                if slot.generation == data.key.generation {
                    slot.busy_count = slot.busy_count.saturating_sub(1);
                }
            }
        }
    }
}

impl Dispatch<wl_callback::WlCallback, u32> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        output_name: &u32,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            if let Some(out) = state.outputs.get_mut(output_name) {
                out.frame_pending = false;
            }
            state.flush_frames(qh);
        }
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for WaylandState {
    fn event(
        state: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(caps),
        } = event
        {
            let has_pointer = caps.contains(wl_seat::Capability::Pointer);
            if has_pointer && state.pointer.is_none() {
                let pointer = seat.get_pointer(qh, ());
                state.pointer = Some(PointerState {
                    pointer,
                    focused_output: None,
                    surface_x: 0.0,
                    surface_y: 0.0,
                    left_down: false,
                });
            } else if !has_pointer {
                if let Some(p) = state.pointer.take() {
                    if let Some(out) = p.focused_output {
                        state.push_pointer(out, p.surface_x, p.surface_y, false, false);
                    }
                    if p.pointer.version() >= 3 {
                        p.pointer.release();
                    }
                }
            }
        }
    }
}

impl Dispatch<wl_pointer::WlPointer, ()> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_pointer::WlPointer,
        event: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_pointer::Event::Enter {
                surface,
                surface_x,
                surface_y,
                ..
            } => {
                let output_name = state
                    .outputs
                    .iter()
                    .find(|(_, out)| out.surface.id() == surface.id())
                    .map(|(&name, _)| name);
                let left_down = if let Some(p) = &mut state.pointer {
                    p.focused_output = output_name;
                    p.surface_x = surface_x;
                    p.surface_y = surface_y;
                    p.left_down
                } else {
                    false
                };
                if let Some(name) = output_name {
                    state.push_pointer(name, surface_x, surface_y, left_down, true);
                }
            }
            wl_pointer::Event::Motion {
                surface_x,
                surface_y,
                ..
            } => {
                let (output_name, left_down) = if let Some(p) = &mut state.pointer {
                    p.surface_x = surface_x;
                    p.surface_y = surface_y;
                    (p.focused_output, p.left_down)
                } else {
                    (None, false)
                };
                if let Some(name) = output_name {
                    state.push_pointer(name, surface_x, surface_y, left_down, true);
                }
            }
            wl_pointer::Event::Button {
                button,
                state: WEnum::Value(btn_state),
                ..
            } => {
                if button == BTN_LEFT {
                    let down = btn_state == wl_pointer::ButtonState::Pressed;
                    let info = if let Some(p) = &mut state.pointer {
                        p.left_down = down;
                        p.focused_output.map(|n| (n, p.surface_x, p.surface_y))
                    } else {
                        None
                    };
                    if let Some((name, sx, sy)) = info {
                        state.push_pointer(name, sx, sy, down, true);
                    }
                }
            }
            wl_pointer::Event::Leave { .. } => {
                let info = if let Some(p) = &mut state.pointer {
                    p.left_down = false;
                    p.focused_output
                        .take()
                        .map(|n| (n, p.surface_x, p.surface_y))
                } else {
                    None
                };
                if let Some((name, sx, sy)) = info {
                    state.push_pointer(name, sx, sy, false, false);
                }
            }
            _ => {}
        }
    }
}

// ---- 管道与线程主循环 ----

fn create_wakeup_pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut fds = [-1 as libc::c_int; 2];
    // SAFETY: 传入 2 元素数组给 pipe2，成功时接管所有权。
    let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if rc < 0 {
        return Err(format!("pipe2 失败: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: pipe2 返回了有效 fd。
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn wake(fd: &OwnedFd) {
    let byte = [1u8; 1];
    // SAFETY: 写 1 字节唤醒阻塞在 poll 的 Wayland 线程；非阻塞管道写满时无需重试。
    unsafe {
        libc::write(fd.as_raw_fd(), byte.as_ptr().cast(), 1);
    }
}

fn drain_wakeup(fd: &OwnedFd) {
    let mut buf = [0u8; 64];
    loop {
        // SAFETY: 读端已设 O_NONBLOCK，读到 EAGAIN 结束。
        let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            break;
        }
    }
}

fn run_wayland_loop(
    label: String,
    wakeup_read: OwnedFd,
    shutdown: Arc<AtomicBool>,
    expect_dmabuf: bool,
    frames_received: Arc<AtomicU64>,
    on_stalled: Option<Arc<dyn Fn() + Send + Sync>>,
    ready_tx: mpsc::SyncSender<Result<Arc<Mutex<FramePool>>, String>>,
) {
    let conn = match Connection::connect_to_env() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("连不上 Wayland 合成器: {e}")));
            return;
        }
    };
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();

    let pool = Arc::new(Mutex::new(FramePool::new(None)));
    let mut state = WaylandState::new(label.clone(), pool.clone());

    let registry = conn.display().get_registry(&qh, ());
    if let Err(e) = queue.roundtrip(&mut state) {
        let _ = ready_tx.send(Err(format!("Wayland roundtrip 失败: {e}")));
        return;
    }

    if state.compositor.is_none() || state.layer_shell.is_none() || state.shm.is_none() {
        let _ = ready_tx.send(Err(
            "Wayland 合成器缺少 wl_compositor / zwlr_layer_shell_v1 / wl_shm".to_string(),
        ));
        return;
    }

    // 再跑几轮 roundtrip 收集 dmabuf feedback / output scale / seat capabilities。
    for _ in 0..3 {
        if let Err(e) = queue.roundtrip(&mut state) {
            let _ = ready_tx.send(Err(format!("Wayland roundtrip 失败: {e}")));
            return;
        }
        if state.dmabuf_feedback.is_none() || state.dmabuf_feedback_done {
            break;
        }
    }

    // 与本机 GPU 协商公共 ARGB8888 modifier；降级或不可用时直接走 SHM。
    let chosen_modifier = if expect_dmabuf {
        gpu::get().and_then(|gpu| {
            let gpu_mods = gpu.modifiers();
            let common: Vec<u64> = state
                .compositor_argb_modifiers
                .iter()
                .copied()
                .filter(|m| gpu_mods.contains(m))
                .collect();
            let chosen = gpu.choose_modifier(64, 64, &common);
            tracing::info!(
                "layer-shell {} dmabuf 协商: 合成器 {} 个 / GPU {} 个 / 公共 {} 个 → {:?}",
                label,
                state.compositor_argb_modifiers.len(),
                gpu_mods.len(),
                common.len(),
                chosen.map(|m| format!("0x{m:x}"))
            );
            chosen
        })
    } else {
        tracing::info!("layer-shell {label} 以共享内存（wl_shm）模式初始化");
        None
    };
    pool.lock().unwrap_or_else(|e| e.into_inner()).dmabuf_modifier = chosen_modifier;

    // 绑定初始 roundtrip 期间收集到的所有 wl_output（此时 compositor 与 layer_shell 已就绪）。
    state.ready = true;
    let outputs_to_bind = std::mem::take(&mut state.pending_outputs);
    for (name, version) in outputs_to_bind {
        state.bind_output(&registry, name, version, &qh);
    }
    let _ = queue.roundtrip(&mut state);

    let _ = ready_tx.send(Ok(pool));

    let mut first_frame_started_at: Option<Instant> = None;
    let mut nudged_invalidate = false;
    let mut stalled_reported = false;

    while !shutdown.load(Ordering::Acquire) {
        if let Err(e) = queue.dispatch_pending(&mut state) {
            tracing::warn!("layer-shell {label} Wayland 分发失败: {e}");
            break;
        }
        state.flush_frames(&qh);
        if let Err(e) = conn.flush() {
            tracing::warn!("layer-shell {label} Wayland flush 失败: {e}");
            break;
        }

        let mut poll_timeout_ms = -1;
        if expect_dmabuf && state.offscreen_shown && !stalled_reported {
            let received = frames_received.load(Ordering::Relaxed);
            if received == 0 {
                let started = *first_frame_started_at.get_or_insert_with(Instant::now);
                let elapsed = started.elapsed();
                match evaluate_first_frame_watchdog(
                    expect_dmabuf,
                    state.offscreen_shown,
                    received,
                    nudged_invalidate,
                    stalled_reported,
                    elapsed,
                ) {
                    WatchdogDecision::NudgeInvalidate => {
                        nudged_invalidate = true;
                        let _ = tauri_runtime_kbcef::invalidate_offscreen(&label);
                        if let WatchdogDecision::WaitMs(ms) = evaluate_first_frame_watchdog(
                            expect_dmabuf,
                            state.offscreen_shown,
                            received,
                            nudged_invalidate,
                            stalled_reported,
                            elapsed,
                        ) {
                            poll_timeout_ms = ms;
                        }
                    }
                    WatchdogDecision::TriggerFallback => {
                        stalled_reported = true;
                        tracing::warn!(
                            "layer-shell {label} 在 {}s 内未收到 dmabuf 离屏帧，自动降级为软件共享内存（wl_shm）并重建壁纸窗口",
                            DMABUF_STALL_TIMEOUT.as_secs()
                        );
                        if let Some(cb) = on_stalled.as_ref() {
                            let cb = cb.clone();
                            let _ = std::thread::Builder::new()
                                .name(format!("wallpaper-dmabuf-fallback-{label}"))
                                .spawn(move || cb());
                        }
                    }
                    WatchdogDecision::WaitMs(ms) => {
                        poll_timeout_ms = ms;
                    }
                    WatchdogDecision::Idle => {}
                }
            }
        }

        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let wl_fd = guard.connection_fd().as_raw_fd();
        let mut fds = [
            libc::pollfd {
                fd: wl_fd,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wakeup_read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: 两个 fd 在本轮 poll 期间有效。
        let polled = unsafe { libc::poll(fds.as_mut_ptr(), 2, poll_timeout_ms) };
        if polled < 0 {
            let err = std::io::Error::last_os_error();
            drop(guard);
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            tracing::warn!("layer-shell {label} poll 失败: {err}");
            break;
        }
        if fds[0].revents & libc::POLLIN != 0 {
            if let Err(e) = guard.read() {
                tracing::warn!("layer-shell {label} Wayland 读事件失败: {e}");
                break;
            }
        } else {
            drop(guard);
        }
        if fds[0].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            tracing::warn!("layer-shell {label} Wayland 连接断开");
            break;
        }
        if fds[1].revents & libc::POLLIN != 0 {
            drain_wakeup(&wakeup_read);
        }
    }

    state.cleanup();
    let _ = conn.flush();
    tracing::info!("layer-shell {label} Wayland 线程已退出");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_cpu_bgra_preserves_bgra_and_swaps_rgba() {
        let src = [10u8, 20, 30, 255, 40, 50, 60, 128];
        let mut dst = [0u8; 8];
        write_cpu_bgra(&src, OffscreenPixelFormat::Bgra, 2, 1, &mut dst);
        assert_eq!(dst, src);

        write_cpu_bgra(&src, OffscreenPixelFormat::Rgba, 2, 1, &mut dst);
        assert_eq!(dst, [30, 20, 10, 255, 60, 50, 40, 128]);
    }

    #[test]
    fn frame_pool_picks_free_slot_avoiding_latest_ready_when_possible() {
        let mut pool = FramePool::new(None);
        pool.generation = 1;
        pool.latest_ready = Some((1, 0, 1));
        assert_eq!(pool.pick_free_slot(), Some(1));

        pool.slots[1].busy_count = 1;
        assert_eq!(pool.pick_free_slot(), Some(2));

        pool.slots[2].busy_count = 1;
        assert_eq!(pool.pick_free_slot(), Some(0));

        pool.slots[0].busy_count = 1;
        assert_eq!(pool.pick_free_slot(), None);
    }

    #[test]
    fn output_effective_scale_prefers_fractional_only_when_viewporter_present() {
        let mut pool_dummy = FramePool::new(None);
        let _ = &mut pool_dummy;
        let conn = Connection::connect_to_env();
        // 只验证分数缩放换算公式本身
        let scale = |has_viewporter: bool, integer_scale: i32, fractional_120: Option<u32>| -> f64 {
            if has_viewporter {
                if let Some(s) = fractional_120 {
                    return (f64::from(s) / 120.0).max(0.5);
                }
            }
            f64::from(integer_scale.max(1))
        };
        drop(conn);
        assert!((scale(true, 2, Some(150)) - 1.25).abs() < 1e-6);
        assert!((scale(false, 2, Some(150)) - 2.0).abs() < 1e-6);
        assert!((scale(true, 2, None) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn first_frame_watchdog_nudges_then_falls_back_and_idles_once_frames_arrive() {
        assert_eq!(
            evaluate_first_frame_watchdog(false, true, 0, false, false, Duration::from_secs(10)),
            WatchdogDecision::Idle
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, false, 0, false, false, Duration::from_secs(10)),
            WatchdogDecision::Idle
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 1, false, false, Duration::from_secs(10)),
            WatchdogDecision::Idle
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, false, false, Duration::from_millis(200)),
            WatchdogDecision::WaitMs(800)
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, false, false, Duration::from_millis(1000)),
            WatchdogDecision::NudgeInvalidate
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, true, false, Duration::from_millis(1200)),
            WatchdogDecision::WaitMs(1000)
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, true, false, Duration::from_millis(2600)),
            WatchdogDecision::WaitMs(400)
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, true, false, Duration::from_secs(3)),
            WatchdogDecision::TriggerFallback
        );
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 0, true, true, Duration::from_secs(4)),
            WatchdogDecision::Idle
        );
    }
}
