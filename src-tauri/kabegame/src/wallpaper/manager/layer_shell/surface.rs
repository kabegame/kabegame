//! 离屏 CEF 帧接收器 → Wayland `zwlr_layer_shell_v1` 背景层。
//!
//! - [`LayerShellSink`] 在独立线程里维护一条 Wayland 连接，为每个 `wl_output` 建一个
//!   `Layer::Background` 的 layer surface（`anchor = ALL`、`exclusive_zone = -1`、不收键盘）。
//! - 动态环形缓冲池（至少 3 槽，随多屏输出数按需扩容并在空闲后缩容）共享于 CEF UI 线程与 Wayland 线程：
//!   收到 `DmaBuf` 且合成器与本机 GPU 有公共 modifier 时走 GBM/EGL `blit_to_target` +
//!   `zwp_linux_dmabuf_v1` 异步 `create`（`Created` 后提交、`Failed` 后安全降级 SHM）；否则退回
//!   `memfd` + `wl_shm`（`DmaBuf` 经 `blit_to_memory` 读回，`Cpu` 直接写入）。
//! - [`Self::on_frame`] 运行在 CEF UI 线程，只持短锁写空闲槽并写 1 字节到非阻塞 wakeup pipe，
//!   绝不阻塞等待 Wayland 往返。
//! - 同时绑定 `wl_seat` / `wl_pointer`，把桌面上的指针移动与左键经 `tauri_plugin_cursor`
//!   的外部指针来源注入壁纸窗口内的 iframe。

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri_plugin_cursor::{push_external_pointer, PointerOrigin, Sample};
use tauri_runtime_kbcef::{OffscreenFrame, OffscreenGeometry, OffscreenPixelFormat};
use wayland_client::backend::{ObjectId, WaylandError};
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

const MIN_SLOTS: usize = 3;
const MAX_SLOTS: usize = 16;
/// 连续无法通过 EGL 导入/读回 dmabuf 帧的阈值，达到后主动触发 CPU `OnPaint` 降级重建。
const MAX_CONSECUTIVE_DMABUF_FAILURES: u32 = 3;
/// Linux `BTN_LEFT`（`<linux/input-event-codes.h>`）。
const BTN_LEFT: u32 = 0x110;
const LAYER_NAMESPACE: &str = "kabegame-wallpaper";
const FIRST_FRAME_NUDGE_AFTER: Duration = Duration::from_millis(1000);
const DMABUF_STALL_TIMEOUT: Duration = Duration::from_secs(3);
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_SINK_ID: AtomicU64 = AtomicU64::new(1);

fn record_dmabuf_write_result(
    consecutive_failures: &AtomicU32,
    health: &SinkHealth,
    ok: bool,
) -> bool {
    if ok {
        consecutive_failures.store(0, Ordering::Release);
        return false;
    }
    let failures = consecutive_failures.fetch_add(1, Ordering::AcqRel) + 1;
    if failures >= MAX_CONSECUTIVE_DMABUF_FAILURES {
        health.dmabuf_unrecoverable.store(true, Ordering::Release);
        return true;
    }
    false
}

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
    frames_published: u64,
    dmabuf_unrecoverable: bool,
    nudged: bool,
    stalled_reported: bool,
    elapsed: Duration,
) -> WatchdogDecision {
    if !expect_dmabuf || stalled_reported {
        return WatchdogDecision::Idle;
    }
    if dmabuf_unrecoverable {
        return WatchdogDecision::TriggerFallback;
    }
    if !offscreen_shown || frames_published > 0 {
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

fn compute_effective_scale(
    has_viewporter: bool,
    integer_scale: i32,
    fractional_scale_120: Option<u32>,
) -> f64 {
    if has_viewporter {
        if let Some(scale_120) = fractional_scale_120.filter(|&s| s > 0) {
            return (f64::from(scale_120) / 120.0).max(0.5);
        }
    }
    f64::from(integer_scale.max(1))
}

/// 在多块已配置屏幕里按**物理像素面积**选出渲染基准：
/// 避免 `1920x1080@2`（3840x2160）与 `2560x1440@1`（2560x1440）混用时误选后者导致高分屏糊掉。
fn select_offscreen_geometry(outputs: &[(u32, u32, f64)]) -> Option<OffscreenGeometry> {
    outputs
        .iter()
        .copied()
        .filter(|&(w, h, _)| w > 0 && h > 0)
        .max_by_key(|&(w, h, scale)| {
            let pw = ((f64::from(w)) * scale).round().max(1.0) as u64;
            let ph = ((f64::from(h)) * scale).round().max(1.0) as u64;
            let logical = u64::from(w) * u64::from(h);
            (pw.saturating_mul(ph), logical)
        })
        .map(|(width, height, scale_factor)| OffscreenGeometry {
            width,
            height,
            scale_factor,
        })
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ViewportSource {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 当缓冲宽高比与当前 output 逻辑宽高比不同（例如横屏与竖屏混用）时，
/// 居中裁剪出等比源矩形给 `wp_viewport.set_source`，防止非等比拉伸破坏构图。
fn compute_viewport_source(
    phys_w: u32,
    phys_h: u32,
    logical_w: u32,
    logical_h: u32,
) -> Option<ViewportSource> {
    if phys_w == 0 || phys_h == 0 || logical_w == 0 || logical_h == 0 {
        return None;
    }
    let buf_ratio = f64::from(phys_w) / f64::from(phys_h);
    let out_ratio = f64::from(logical_w) / f64::from(logical_h);
    if (buf_ratio - out_ratio).abs() <= 1e-4 {
        return None;
    }
    let pw = f64::from(phys_w);
    let ph = f64::from(phys_h);
    if buf_ratio > out_ratio {
        let h = ph;
        let w = (h * out_ratio).clamp(1.0, pw);
        let x = ((pw - w) * 0.5).max(0.0);
        Some(ViewportSource { x, y: 0.0, w, h })
    } else {
        let w = pw;
        let h = (w / out_ratio).clamp(1.0, ph);
        let y = ((ph - h) * 0.5).max(0.0);
        Some(ViewportSource { x: 0.0, y, w, h })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CommittedPresentation {
    surface_w: f64,
    surface_h: f64,
    phys_w: u32,
    phys_h: u32,
    source_crop: Option<ViewportSource>,
    view_w: u32,
    view_h: u32,
}

fn geometry_matches_physical(geom: OffscreenGeometry, phys_w: u32, phys_h: u32) -> bool {
    let (expected_w, expected_h) = geom.physical_size();
    expected_w.abs_diff(phys_w) <= 1 && expected_h.abs_diff(phys_h) <= 1
}

fn build_committed_presentation(
    logical_w: u32,
    logical_h: u32,
    phys_w: u32,
    phys_h: u32,
    geom: OffscreenGeometry,
) -> CommittedPresentation {
    // 无论是否具备 wp_viewporter，提交给合成器的表面都按 logical_w x logical_h 铺满，
    // 当物理比例不一致时，有 viewporter 走硬件 set_source，无 viewporter 走等价的 SHM 居中裁剪缩放。
    CommittedPresentation {
        surface_w: f64::from(logical_w),
        surface_h: f64::from(logical_h),
        phys_w,
        phys_h,
        source_crop: compute_viewport_source(phys_w, phys_h, logical_w, logical_h),
        view_w: geom.width,
        view_h: geom.height,
    }
}

/// 按单个屏幕最近一次实际提交给合成器的画面状态，把 Wayland surface 局部坐标映射到 CEF 离屏逻辑坐标。
fn map_pointer_to_committed_view(
    surface_x: f64,
    surface_y: f64,
    pres: CommittedPresentation,
) -> (f64, f64) {
    if pres.surface_w <= 0.0 || pres.surface_h <= 0.0 || pres.phys_w == 0 || pres.phys_h == 0 {
        return (0.0, 0.0);
    }
    let u = (surface_x / pres.surface_w).clamp(0.0, 1.0);
    let v = (surface_y / pres.surface_h).clamp(0.0, 1.0);
    if let Some(src) = pres.source_crop {
        let buf_u = (src.x + u * src.w) / f64::from(pres.phys_w);
        let buf_v = (src.y + v * src.h) / f64::from(pres.phys_h);
        (buf_u * f64::from(pres.view_w), buf_v * f64::from(pres.view_h))
    } else {
        (u * f64::from(pres.view_w), v * f64::from(pres.view_h))
    }
}

/// 无 `wp_viewporter` 时把源 SHM 帧按与 `compute_viewport_source` 一致的居中裁剪矩形缩放到目标像素尺寸。
fn crop_and_scale_bgra(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst: &mut [u8],
    dst_w: u32,
    dst_h: u32,
) {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return;
    }
    let src_needed = (src_w as usize).saturating_mul(src_h as usize).saturating_mul(4);
    let dst_needed = (dst_w as usize).saturating_mul(dst_h as usize).saturating_mul(4);
    if src.len() < src_needed || dst.len() < dst_needed {
        return;
    }
    let crop = compute_viewport_source(src_w, src_h, dst_w, dst_h).unwrap_or(ViewportSource {
        x: 0.0,
        y: 0.0,
        w: f64::from(src_w),
        h: f64::from(src_h),
    });
    let max_sx = src_w - 1;
    let max_sy = src_h - 1;
    let mut x_map = Vec::with_capacity(dst_w as usize);
    for dx in 0..dst_w {
        let sx_f = crop.x + ((f64::from(dx) + 0.5) / f64::from(dst_w)) * crop.w;
        let sx = (sx_f.floor().max(0.0) as u32).min(max_sx) as usize;
        x_map.push(sx * 4);
    }
    let src_stride = (src_w as usize) * 4;
    let dst_stride = (dst_w as usize) * 4;
    for dy in 0..dst_h {
        let sy_f = crop.y + ((f64::from(dy) + 0.5) / f64::from(dst_h)) * crop.h;
        let sy = (sy_f.floor().max(0.0) as u32).min(max_sy) as usize;
        let src_row = &src[sy * src_stride..(sy + 1) * src_stride];
        let dst_row = &mut dst[dy as usize * dst_stride..(dy as usize + 1) * dst_stride];
        for (dx, &sx_off) in x_map.iter().enumerate() {
            let dx_off = dx * 4;
            dst_row[dx_off..dx_off + 4].copy_from_slice(&src_row[sx_off..sx_off + 4]);
        }
    }
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
// TrackedStorage::busy_count 约束使用，不会并发读写同一段内存。
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
                // SAFETY: 调用方持有 FramePool 锁且确认 `TrackedStorage::is_free()`（retired/busy/leases 均为 0），
                // Wayland 线程与合成器不会读此缓冲。
                Some(unsafe { std::slice::from_raw_parts_mut(*ptr, *len) })
            }
            _ => None,
        }
    }

    fn shm_slice_ro(&self) -> Option<&[u8]> {
        match self {
            SlotStorage::Shm { ptr, len, .. } if !ptr.is_null() && *len > 0 => {
                // SAFETY: 调用方已持有对应 StorageReadLease 或保证底层映射在本帧期间只读且有效。
                Some(unsafe { std::slice::from_raw_parts(*ptr, *len) })
            }
            _ => None,
        }
    }
}

struct StorageReadLease {
    storage: Arc<TrackedStorage>,
}

impl Drop for StorageReadLease {
    fn drop(&mut self) {
        self.storage.reader_leases.fetch_sub(1, Ordering::AcqRel);
    }
}

struct TrackedStorage {
    id: u64,
    width: u32,
    height: u32,
    inner: SlotStorage,
    /// 当前有多少个尚未收到 `wl_buffer.release` 的 `wl_buffer` 引用此存储。
    busy_count: AtomicUsize,
    /// 当前有多少个 Wayland 消费阶段租约（如待提交或异步 dmabuf 导入中）持有此存储。
    reader_leases: AtomicUsize,
    /// 若该存储关联的输出在未收到 release 时退休，则永久标记退休并踢出可写池。
    retired: AtomicBool,
}

impl TrackedStorage {
    fn new(id: u64, width: u32, height: u32, inner: SlotStorage) -> Self {
        Self {
            id,
            width,
            height,
            inner,
            busy_count: AtomicUsize::new(0),
            reader_leases: AtomicUsize::new(0),
            retired: AtomicBool::new(false),
        }
    }

    fn acquire_read_lease(self: &Arc<Self>) -> StorageReadLease {
        self.reader_leases.fetch_add(1, Ordering::AcqRel);
        StorageReadLease {
            storage: self.clone(),
        }
    }

    fn mark_retired(&self) {
        self.retired.store(true, Ordering::Release);
    }

    fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    fn is_free(&self) -> bool {
        !self.is_retired()
            && self.busy_count.load(Ordering::Acquire) == 0
            && self.reader_leases.load(Ordering::Acquire) == 0
    }
}

#[derive(Default)]
struct FrameSlot {
    generation: u64,
    storage: Option<Arc<TrackedStorage>>,
    /// 生产这帧像素时 CEF 离屏视图实际使用的逻辑几何（与像素同步提交，不受异步 resize_offscreen 抢先改写）。
    frame_geometry: Option<OffscreenGeometry>,
}

impl FrameSlot {
    fn is_free(&self) -> bool {
        self.storage
            .as_ref()
            .is_none_or(|storage| storage.is_free())
    }
}

struct FramePool {
    width: u32,
    height: u32,
    generation: u64,
    frame_seq: u64,
    next_storage_id: u64,
    active_outputs: usize,
    producer_closed: bool,
    slots: Vec<FrameSlot>,
    /// 缓存已确认过的「物理像素尺寸 → 离屏几何」映射，用于兜底异步过渡期或旧尺寸匹配。
    known_geometries: HashMap<(u32, u32), OffscreenGeometry>,
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
            next_storage_id: 1,
            active_outputs: 1,
            producer_closed: false,
            slots: (0..MIN_SLOTS).map(|_| FrameSlot::default()).collect(),
            known_geometries: HashMap::new(),
            latest_ready: None,
            dmabuf_modifier,
            dmabuf_broken: false,
        }
    }

    fn max_slots(&self) -> usize {
        (self.active_outputs.saturating_mul(2).saturating_add(2)).clamp(MIN_SLOTS, MAX_SLOTS)
    }

    fn alloc_storage_id(&mut self) -> u64 {
        let id = self.next_storage_id;
        self.next_storage_id = self.next_storage_id.wrapping_add(1).max(1);
        id
    }

    fn active_storage_ids(&self) -> HashSet<u64> {
        self.slots
            .iter()
            .filter_map(|slot| slot.storage.as_ref().map(|s| s.id))
            .collect()
    }

    /// 持池锁期间取出最新帧并立即登记消费者读租约，防止放锁后被生产者覆盖。
    fn checkout_latest_for_consumer(
        &self,
    ) -> Option<(u64, usize, u64, StorageReadLease, HashSet<u64>, Option<OffscreenGeometry>)> {
        if self.producer_closed {
            return None;
        }
        let (gen_id, slot_idx, seq) = self.latest_ready?;
        let slot = self.slots.get(slot_idx)?;
        if slot.generation != gen_id {
            return None;
        }
        let storage = slot.storage.as_ref()?;
        if storage.is_retired() {
            return None;
        }
        let lease = storage.acquire_read_lease();
        let active_ids = self.active_storage_ids();
        Some((gen_id, slot_idx, seq, lease, active_ids, slot.frame_geometry))
    }

    /// 把已退休存储从可写槽位中永久移除，释放槽位名额以重新分配新存储。
    fn evict_retired_slots(&mut self) {
        let latest_idx = self.latest_ready.map(|(_, idx, _)| idx);
        for (idx, slot) in self.slots.iter_mut().enumerate() {
            if slot.storage.as_ref().is_some_and(|s| s.is_retired()) {
                slot.storage = None;
                slot.generation = 0;
                slot.frame_geometry = None;
                if latest_idx == Some(idx) {
                    self.latest_ready = None;
                }
            }
        }
        self.shrink_idle_slots();
    }

    /// 在 Wayland 线程终止清理前调用：永久关闭生产写入入口，并把池内现有存储全部退休移出。
    fn close_producer_and_retire_all(&mut self) {
        self.producer_closed = true;
        self.latest_ready = None;
        for slot in &mut self.slots {
            if let Some(storage) = slot.storage.take() {
                storage.mark_retired();
            }
            slot.generation = 0;
            slot.frame_geometry = None;
        }
        self.slots.clear();
    }

    fn pick_free_slot(&mut self) -> Option<usize> {
        let latest = self.latest_ready.map(|(gen_id, idx, _)| (gen_id, idx));
        // 1. 优先选空闲且不是刚写完的 latest_ready，防止在 Wayland 线程还没取走时覆盖。
        if let Some(idx) = (0..self.slots.len()).find(|&i| {
            self.slots[i].is_free() && latest != Some((self.generation, i))
        }) {
            return Some(idx);
        }
        // 2. 退而选任意空闲槽位。
        if let Some(idx) = (0..self.slots.len()).find(|&i| self.slots[i].is_free()) {
            return Some(idx);
        }
        // 3. 多屏下慢消费者或被遮挡屏幕长期占用旧槽时，在上限内按需扩容。
        if self.slots.len() < self.max_slots() {
            self.slots.push(FrameSlot::default());
            return Some(self.slots.len() - 1);
        }
        None
    }

    /// 回收尾部多余且空闲的槽位，避免临时扩容后常驻大量内存。
    fn shrink_idle_slots(&mut self) {
        let latest_idx = self.latest_ready.map(|(_, idx, _)| idx);
        while self.slots.len() > MIN_SLOTS {
            let last_idx = self.slots.len() - 1;
            if latest_idx == Some(last_idx) || !self.slots[last_idx].is_free() {
                break;
            }
            self.slots.pop();
        }
    }
}

// ---- 对外 Sink 与健康状态 ----

/// 供上层恢复回调校验的 Sink 实时健康状态（无锁读取，不触发阻塞）。
#[derive(Clone)]
pub struct SinkHealth {
    sink_id: u64,
    cancelled: Arc<AtomicBool>,
    frames_published: Arc<AtomicU64>,
    dmabuf_unrecoverable: Arc<AtomicBool>,
    first_published_at: Arc<Mutex<Option<Instant>>>,
}

impl SinkHealth {
    fn new() -> Self {
        Self {
            sink_id: NEXT_SINK_ID.fetch_add(1, Ordering::Relaxed),
            cancelled: Arc::new(AtomicBool::new(false)),
            frames_published: Arc::new(AtomicU64::new(0)),
            dmabuf_unrecoverable: Arc::new(AtomicBool::new(false)),
            first_published_at: Arc::new(Mutex::new(None)),
        }
    }

    pub fn sink_id(&self) -> u64 {
        self.sink_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn frames_published(&self) -> u64 {
        self.frames_published.load(Ordering::Acquire)
    }

    pub fn dmabuf_unrecoverable(&self) -> bool {
        self.dmabuf_unrecoverable.load(Ordering::Acquire)
    }

    pub fn healthy_duration(&self, now: Instant) -> Duration {
        if self.frames_published() == 0 || self.dmabuf_unrecoverable() {
            return Duration::ZERO;
        }
        let started = *self
            .first_published_at
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        started.map_or(Duration::ZERO, |ts| now.saturating_duration_since(ts))
    }

    #[cfg(test)]
    pub(crate) fn new_for_test() -> Self {
        Self::new()
    }

    #[cfg(test)]
    pub(crate) fn test_record_published(&self, now: Instant) {
        if self.frames_published.fetch_add(1, Ordering::Release) == 0 {
            let mut guard = self
                .first_published_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(now);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn test_set_unrecoverable(&self, val: bool) {
        self.dmabuf_unrecoverable.store(val, Ordering::Release);
    }
}

/// 离屏 CEF 到 Wayland `zwlr_layer_shell_v1` 背景层的帧接收器。
pub struct LayerShellSink {
    label: String,
    pool: Arc<Mutex<FramePool>>,
    wakeup_write: OwnedFd,
    shutdown: Arc<AtomicBool>,
    health: SinkHealth,
    consecutive_dmabuf_failures: AtomicU32,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl LayerShellSink {
    pub fn new(
        label: String,
        expect_dmabuf: bool,
        make_on_stalled: impl FnOnce(SinkHealth) -> Option<Arc<dyn Fn() + Send + Sync>>,
        make_on_fatal: impl FnOnce(SinkHealth) -> Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> Result<Self, String> {
        let (wakeup_read, wakeup_write) = create_wakeup_pipe()?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let health = SinkHealth::new();
        let on_stalled = make_on_stalled(health.clone());
        let on_fatal = make_on_fatal(health.clone());
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<Arc<Mutex<FramePool>>, String>>(1);
        let init_deadline = Instant::now() + INIT_TIMEOUT;

        let thread_label = label.clone();
        let thread_shutdown = shutdown.clone();
        let thread_health = health.clone();
        let handle = std::thread::Builder::new()
            .name(format!("wallpaper-layer-shell-{label}"))
            .spawn(move || {
                run_wayland_loop(
                    thread_label,
                    wakeup_read,
                    thread_shutdown,
                    expect_dmabuf,
                    init_deadline,
                    thread_health,
                    on_stalled,
                    on_fatal,
                    ready_tx,
                );
            })
            .map_err(|e| format!("启动 layer-shell 线程失败: {e}"))?;

        let wait_budget = init_deadline
            .saturating_duration_since(Instant::now())
            .saturating_add(Duration::from_secs(1));
        let pool = match ready_rx.recv_timeout(wait_budget) {
            Ok(Ok(pool)) => pool,
            Ok(Err(e)) => {
                health.cancelled.store(true, Ordering::SeqCst);
                shutdown.store(true, Ordering::SeqCst);
                wake(&wakeup_write);
                let _ = handle.join();
                return Err(e);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                health.cancelled.store(true, Ordering::SeqCst);
                shutdown.store(true, Ordering::SeqCst);
                wake(&wakeup_write);
                let _ = handle.join();
                return Err("layer-shell 初始化超时".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                health.cancelled.store(true, Ordering::SeqCst);
                shutdown.store(true, Ordering::SeqCst);
                wake(&wakeup_write);
                let _ = handle.join();
                return Err("layer-shell 线程在初始化完成前退出".to_string());
            }
        };

        Ok(Self {
            label,
            pool,
            wakeup_write,
            shutdown,
            health,
            consecutive_dmabuf_failures: AtomicU32::new(0),
            thread: Mutex::new(Some(handle)),
        })
    }

    pub fn health(&self) -> &SinkHealth {
        &self.health
    }

    /// 请求 Wayland 线程退出并等待清理完成（幂等）。
    pub fn shutdown(&self) {
        self.health.cancelled.store(true, Ordering::SeqCst);
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
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        let (phys_w, phys_h, frame_geom) = match &frame {
            OffscreenFrame::DmaBuf {
                visible, geometry, ..
            } => (visible.2.max(1), visible.3.max(1), *geometry),
            OffscreenFrame::Cpu {
                width,
                height,
                geometry,
                ..
            } => ((*width).max(1), (*height).max(1), *geometry),
        };

        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if pool.producer_closed || self.shutdown.load(Ordering::Acquire) {
            return;
        }
        if pool.width != phys_w || pool.height != phys_h {
            pool.width = phys_w;
            pool.height = phys_h;
            pool.generation = pool.generation.wrapping_add(1).max(1);
            pool.latest_ready = None;
            pool.shrink_idle_slots();
        }
        let resolved_geom = if geometry_matches_physical(frame_geom, phys_w, phys_h) {
            if pool.known_geometries.len() >= 16
                && !pool.known_geometries.contains_key(&(phys_w, phys_h))
            {
                pool.known_geometries.clear();
            }
            pool.known_geometries.insert((phys_w, phys_h), frame_geom);
            Some(frame_geom)
        } else {
            pool.known_geometries.get(&(phys_w, phys_h)).copied()
        };
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
                || match (&slot.storage, modifier_if_dmabuf) {
                    (Some(s), Some(_)) => {
                        s.width != phys_w
                            || s.height != phys_h
                            || !matches!(s.inner, SlotStorage::DmaBuf { .. })
                    }
                    (Some(s), None) => {
                        s.width != phys_w
                            || s.height != phys_h
                            || !matches!(s.inner, SlotStorage::Shm { .. })
                    }
                    (None, _) => true,
                }
        };

        if need_alloc {
            let allocated = if let (Some(gpu), Some(modifier)) = (gpu_ctx, modifier_if_dmabuf) {
                match gpu.alloc_target(phys_w, phys_h, modifier) {
                    Ok(target) => Ok(SlotStorage::DmaBuf { target, modifier }),
                    Err(e) => {
                        tracing::warn!(
                            "layer-shell {} 分配 dmabuf 输出缓冲失败，降级到 SHM: {e}",
                            self.label
                        );
                        pool.dmabuf_broken = true;
                        SlotStorage::alloc_shm(phys_w, phys_h)
                    }
                }
            } else {
                SlotStorage::alloc_shm(phys_w, phys_h)
            };
            match allocated {
                Ok(inner) => {
                    let storage_id = pool.alloc_storage_id();
                    let tracked = Arc::new(TrackedStorage::new(storage_id, phys_w, phys_h, inner));
                    let slot = &mut pool.slots[slot_idx];
                    slot.generation = generation;
                    slot.storage = Some(tracked);
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

        let is_dmabuf_frame = matches!(frame, OffscreenFrame::DmaBuf { .. });
        let write_result = match (frame, &storage_arc.inner, gpu_ctx) {
            (
                OffscreenFrame::DmaBuf {
                    planes,
                    modifier,
                    format,
                    width,
                    height,
                    visible,
                    ..
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
                    ..
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
                    ..
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
            if is_dmabuf_frame {
                // 无论是 dmabuf 直传还是初始无公共 modifier 走 EGL blit_to_memory，只要输入是 dmabuf
                // 且持续写入失败，都必须累计并在达到阈值后唤醒循环降级 CPU OnPaint。
                let triggered = record_dmabuf_write_result(
                    &self.consecutive_dmabuf_failures,
                    &self.health,
                    false,
                );
                drop(pool);
                if triggered {
                    wake(&self.wakeup_write);
                }
            }
            return;
        }

        record_dmabuf_write_result(&self.consecutive_dmabuf_failures, &self.health, true);
        pool.frame_seq = pool.frame_seq.wrapping_add(1).max(1);
        let seq = pool.frame_seq;
        pool.slots[slot_idx].frame_geometry = resolved_geom;
        pool.latest_ready = Some((generation, slot_idx, seq));
        let prev_published = self.health.frames_published.fetch_add(1, Ordering::Release);
        drop(pool);
        if prev_published == 0 {
            let mut guard = self
                .health
                .first_published_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(Instant::now());
            }
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct BufferKey {
    output_name: u32,
    storage_id: u64,
}

struct CachedBuffer {
    buffer: wl_buffer::WlBuffer,
    width: u32,
    height: u32,
    /// 保持底层 GpuTarget / Shm 映射在 WlBuffer 销毁前一直存活。
    storage: Arc<TrackedStorage>,
}

struct BufferUserData {
    released: AtomicBool,
    storage: OnceLock<Arc<TrackedStorage>>,
}

impl BufferUserData {
    fn new_with_storage(storage: Arc<TrackedStorage>) -> Self {
        let cell = OnceLock::new();
        let _ = cell.set(storage);
        Self {
            released: AtomicBool::new(true),
            storage: cell,
        }
    }

    fn new_unassigned() -> Self {
        Self {
            released: AtomicBool::new(true),
            storage: OnceLock::new(),
        }
    }

    fn acquire_busy(&self) -> bool {
        if self.released.swap(false, Ordering::AcqRel) {
            if let Some(storage) = self.storage.get() {
                storage.busy_count.fetch_add(1, Ordering::AcqRel);
            }
            true
        } else {
            false
        }
    }

    fn mark_released(&self) -> bool {
        if !self.released.swap(true, Ordering::AcqRel) {
            if let Some(storage) = self.storage.get() {
                storage.busy_count.fetch_sub(1, Ordering::AcqRel);
            }
            true
        } else {
            false
        }
    }

    fn is_released(&self) -> bool {
        self.released.load(Ordering::Acquire)
    }
}

struct PendingDmabufParams {
    key: BufferKey,
    width: u32,
    height: u32,
    storage: Arc<TrackedStorage>,
}

struct PendingParamEntry<H> {
    canceled: bool,
    lease: Option<StorageReadLease>,
    handle: H,
}

/// 管理异步创建请求的句柄与活动 key 索引，防止取消后迟到事件误删同 key 的新请求并确保租约归还。
struct PendingParamsTracker<Id: Eq + std::hash::Hash + Clone, H> {
    active_keys: HashMap<BufferKey, Id>,
    entries: HashMap<Id, PendingParamEntry<H>>,
}

impl<Id: Eq + std::hash::Hash + Clone, H> PendingParamsTracker<Id, H> {
    fn new() -> Self {
        Self {
            active_keys: HashMap::new(),
            entries: HashMap::new(),
        }
    }

    fn has_active_key(&self, key: &BufferKey) -> bool {
        self.active_keys.contains_key(key)
    }

    fn has_active_output(&self, output_name: u32) -> bool {
        self.active_keys.keys().any(|k| k.output_name == output_name)
    }

    fn insert(&mut self, id: Id, key: BufferKey, lease: StorageReadLease, handle: H) {
        self.active_keys.insert(key, id.clone());
        self.entries.insert(
            id,
            PendingParamEntry {
                canceled: false,
                lease: Some(lease),
                handle,
            },
        );
    }

    fn cancel_by_key(&mut self, key: &BufferKey) {
        if let Some(id) = self.active_keys.remove(key) {
            if let Some(entry) = self.entries.get_mut(&id) {
                entry.canceled = true;
            }
        }
    }

    fn cancel_output(&mut self, output_name: u32) {
        let keys: Vec<BufferKey> = self
            .active_keys
            .keys()
            .copied()
            .filter(|k| k.output_name == output_name)
            .collect();
        for key in keys {
            self.cancel_by_key(&key);
        }
    }

    fn cancel_stale_storage(&mut self, active_ids: &HashSet<u64>) {
        let keys: Vec<BufferKey> = self
            .active_keys
            .keys()
            .copied()
            .filter(|k| !active_ids.contains(&k.storage_id))
            .collect();
        for key in keys {
            self.cancel_by_key(&key);
        }
    }

    fn finish_event(&mut self, id: &Id, key: &BufferKey) -> (bool, Option<StorageReadLease>) {
        if self.active_keys.get(key) == Some(id) {
            self.active_keys.remove(key);
        }
        if let Some(mut entry) = self.entries.remove(id) {
            (entry.canceled, entry.lease.take())
        } else {
            (true, None)
        }
    }

    fn drain_handles(&mut self) -> Vec<H> {
        self.active_keys.clear();
        self.entries
            .drain()
            .map(|(_, entry)| entry.handle)
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DmabufParamsOutcome {
    CacheBuffer,
    DestroyLateBuffer,
    MarkDmabufBroken,
    IgnoreCanceledFailure,
}

fn decide_dmabuf_params_event(
    canceled: bool,
    output_alive: bool,
    storage_active: bool,
    is_created: bool,
) -> DmabufParamsOutcome {
    if is_created {
        if !canceled && output_alive && storage_active {
            DmabufParamsOutcome::CacheBuffer
        } else {
            DmabufParamsOutcome::DestroyLateBuffer
        }
    } else if !canceled && output_alive {
        DmabufParamsOutcome::MarkDmabufBroken
    } else {
        DmabufParamsOutcome::IgnoreCanceledFailure
    }
}

#[derive(Clone, Copy)]
enum CallbackKind {
    Frame(u32),
    InitSync(u64),
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
    last_presentation: Option<CommittedPresentation>,
    /// 无 wp_viewporter 时用于副屏不同比例/尺寸裁剪缩放的每屏本地 SHM 缓冲池。
    scaled_buffers: Vec<CachedBuffer>,
}

impl OutputSurface {
    fn effective_scale(&self, has_viewporter: bool) -> f64 {
        compute_effective_scale(has_viewporter, self.integer_scale, self.fractional_scale_120)
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
    params_tracker: PendingParamsTracker<ObjectId, ZwpLinuxBufferParamsV1>,
    retired_buffers: HashMap<ObjectId, (u32, CachedBuffer)>,
    offscreen_geom: Option<OffscreenGeometry>,
    offscreen_shown: bool,
    ready: bool,
    next_sync_id: u64,
    completed_sync_id: u64,
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
            params_tracker: PendingParamsTracker::new(),
            retired_buffers: HashMap::new(),
            offscreen_geom: None,
            offscreen_shown: false,
            ready: false,
            next_sync_id: 1,
            completed_sync_id: 0,
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
                last_presentation: None,
                scaled_buffers: Vec::new(),
            },
        );
        self.pool.lock().unwrap_or_else(|e| e.into_inner()).active_outputs =
            self.outputs.len().max(1);
    }

    fn retire_buffer(&mut self, output_name: u32, cached: CachedBuffer) -> Option<Arc<TrackedStorage>> {
        let released = cached
            .buffer
            .data::<BufferUserData>()
            .is_none_or(|d| d.is_released());
        if released {
            cached.buffer.destroy();
            None
        } else {
            let storage = cached.storage.clone();
            let id = cached.buffer.id();
            self.retired_buffers.insert(id, (output_name, cached));
            Some(storage)
        }
    }

    /// 统一处理 output 退出（覆盖 `Closed`、`GlobalRemove`、缓冲退休、异步 params 取消与指针收尾）。
    ///
    /// 若仍有未收到 `wl_buffer.release` 的缓冲，永久将其底层存储标为已退休并移出可写池，
    /// 由新分配的存储补位，退休缓冲静待合成器真实发送 `wl_buffer.release` 后再销毁。
    fn retire_output(&mut self, output_name: u32) {
        self.pending_outputs.retain(|(pending, _)| *pending != output_name);

        if let Some(p) = &mut self.pointer {
            if p.focused_output == Some(output_name) {
                let (sx, sy) = (p.surface_x, p.surface_y);
                p.focused_output = None;
                p.left_down = false;
                self.push_pointer(output_name, sx, sy, false, false);
            }
        }

        let removed_output = self.outputs.remove(&output_name);
        if let Some(mut out) = removed_output {
            for cached in out.scaled_buffers.drain(..) {
                if let Some(storage) = self.retire_buffer(output_name, cached) {
                    storage.mark_retired();
                }
            }
            out.destroy();
        }

        self.params_tracker.cancel_output(output_name);

        let buffer_keys: Vec<BufferKey> = self
            .buffers
            .keys()
            .copied()
            .filter(|k| k.output_name == output_name)
            .collect();
        let mut retired_any = false;
        for key in buffer_keys {
            if let Some(cached) = self.buffers.remove(&key) {
                if let Some(storage) = self.retire_buffer(output_name, cached) {
                    storage.mark_retired();
                    retired_any = true;
                }
            }
        }
        // 已因尺寸变化早先进入 retired_buffers 的同输出未释放缓冲，其底层存储也一并退休。
        for (retired_out, cached) in self.retired_buffers.values() {
            if *retired_out == output_name {
                cached.storage.mark_retired();
                retired_any = true;
            }
        }

        {
            let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
            pool.active_outputs = self.outputs.len().max(1);
            if retired_any {
                pool.evict_retired_slots();
            } else {
                pool.shrink_idle_slots();
            }
        }

        self.sync_offscreen_geometry();
    }

    fn sync_offscreen_geometry(&mut self) {
        let has_viewporter = self.viewporter.is_some();
        let candidates: Vec<(u32, u32, f64)> = self
            .outputs
            .values()
            .filter(|o| o.configured && o.logical_w > 0 && o.logical_h > 0)
            .map(|o| (o.logical_w, o.logical_h, o.effective_scale(has_viewporter)))
            .collect();
        let Some(geom) = select_offscreen_geometry(&candidates) else {
            return;
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
        let Some((_gen_id, _slot_idx, seq, lease, active_ids, frame_geom)) = self
            .pool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .checkout_latest_for_consumer()
        else {
            return;
        };
        let storage_arc = &lease.storage;
        let phys_w = storage_arc.width;
        let phys_h = storage_arc.height;

        // 清理不再属于活动槽位存储的旧 WlBuffer：已释放立即销毁，未释放转入退休集合等 release。
        let stale_keys: Vec<BufferKey> = self
            .buffers
            .keys()
            .copied()
            .filter(|k| !active_ids.contains(&k.storage_id))
            .collect();
        for key in stale_keys {
            if let Some(cached) = self.buffers.remove(&key) {
                self.retire_buffer(key.output_name, cached);
            }
        }
        self.params_tracker.cancel_stale_storage(&active_ids);

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

            let scale = integer_scale.max(1) as u32;
            let target_w = logical_w.saturating_mul(scale).max(1);
            let target_h = logical_h.saturating_mul(scale).max(1);

            if !has_viewporter && (phys_w != target_w || phys_h != target_h) {
                // 无 wp_viewporter 且副屏尺寸/比例与基准缓冲不同：使用每屏 SHM 居中裁剪并缩放到目标物理尺寸，
                // 让每块屏幕都能严格铺满 logical_w x logical_h，opaque region 与指针映射随之完全对齐。
                let Some(src_slice) = storage_arc.inner.shm_slice_ro() else {
                    continue;
                };
                let Some(shm) = self.shm.clone() else {
                    continue;
                };
                let existing_scaled = self
                    .outputs
                    .get_mut(&output_name)
                    .map(|out| std::mem::take(&mut out.scaled_buffers))
                    .unwrap_or_default();
                let mut kept = Vec::with_capacity(existing_scaled.len().min(3));
                for b in existing_scaled {
                    if b.width == target_w && b.height == target_h {
                        kept.push(b);
                    } else {
                        self.retire_buffer(output_name, b);
                    }
                }
                let free_idx = kept.iter().position(|b| {
                    b.buffer
                        .data::<BufferUserData>()
                        .is_none_or(|d| d.is_released())
                });
                let chosen_idx = if let Some(i) = free_idx {
                    i
                } else if kept.len() < 3 {
                    let Ok(shm_storage) = SlotStorage::alloc_shm(target_w, target_h) else {
                        if let Some(out) = self.outputs.get_mut(&output_name) {
                            out.scaled_buffers = kept;
                        }
                        continue;
                    };
                    let sid = self
                        .pool
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .alloc_storage_id();
                    let tracked = Arc::new(TrackedStorage::new(sid, target_w, target_h, shm_storage));
                    let SlotStorage::Shm { fd, len, .. } = &tracked.inner else {
                        continue;
                    };
                    let user_data = BufferUserData::new_with_storage(tracked.clone());
                    let shm_pool = shm.create_pool(fd.as_fd(), *len as i32, qh, ());
                    let buffer = shm_pool.create_buffer(
                        0,
                        target_w as i32,
                        target_h as i32,
                        (target_w * 4) as i32,
                        wl_shm::Format::Argb8888,
                        qh,
                        user_data,
                    );
                    shm_pool.destroy();
                    kept.push(CachedBuffer {
                        buffer,
                        width: target_w,
                        height: target_h,
                        storage: tracked,
                    });
                    kept.len() - 1
                } else {
                    if let Some(out) = self.outputs.get_mut(&output_name) {
                        out.scaled_buffers = kept;
                    }
                    continue;
                };

                {
                    let Some(dst_slice) = kept[chosen_idx].storage.inner.shm_slice_mut_unchecked()
                    else {
                        if let Some(out) = self.outputs.get_mut(&output_name) {
                            out.scaled_buffers = kept;
                        }
                        continue;
                    };
                    crop_and_scale_bgra(src_slice, phys_w, phys_h, dst_slice, target_w, target_h);
                }

                if let Some(data) = kept[chosen_idx].buffer.data::<BufferUserData>() {
                    if !data.acquire_busy() {
                        if let Some(out) = self.outputs.get_mut(&output_name) {
                            out.scaled_buffers = kept;
                        }
                        continue;
                    }
                }
                let pres = frame_geom.map(|geom| {
                    build_committed_presentation(logical_w, logical_h, phys_w, phys_h, geom)
                });
                let Some(out) = self.outputs.get_mut(&output_name) else {
                    if let Some(data) = kept[chosen_idx].buffer.data::<BufferUserData>() {
                        data.mark_released();
                    }
                    continue;
                };
                out.surface.set_buffer_scale(scale as i32);
                out.surface.attach(Some(&kept[chosen_idx].buffer), 0, 0);
                out.surface
                    .damage_buffer(0, 0, target_w as i32, target_h as i32);
                out.surface.frame(qh, CallbackKind::Frame(output_name));
                out.surface.commit();
                out.frame_pending = true;
                out.last_committed_seq = seq;
                out.last_presentation = pres;
                out.scaled_buffers = kept;
                continue;
            }

            let key = BufferKey {
                output_name,
                storage_id: storage_arc.id,
            };

            let need_recreate = self
                .buffers
                .get(&key)
                .is_none_or(|b| b.width != phys_w || b.height != phys_h);
            if need_recreate {
                if let Some(old) = self.buffers.remove(&key) {
                    self.retire_buffer(output_name, old);
                }
                match &storage_arc.inner {
                    SlotStorage::DmaBuf { target, modifier } => {
                        if self.params_tracker.has_active_key(&key) {
                            continue;
                        }
                        let Some(dmabuf) = self.dmabuf.as_ref() else {
                            continue;
                        };
                        let params = dmabuf.create_params(
                            qh,
                            PendingDmabufParams {
                                key,
                                width: phys_w,
                                height: phys_h,
                                storage: storage_arc.clone(),
                            },
                        );
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
                        params.create(
                            phys_w as i32,
                            phys_h as i32,
                            DRM_FORMAT_ARGB8888,
                            zwp_linux_buffer_params_v1::Flags::empty(),
                        );
                        let params_id = params.id();
                        self.params_tracker.insert(
                            params_id,
                            key,
                            storage_arc.acquire_read_lease(),
                            params,
                        );
                        continue;
                    }
                    SlotStorage::Shm { fd, len, .. } => {
                        let Some(shm) = self.shm.as_ref() else {
                            continue;
                        };
                        let user_data = BufferUserData::new_with_storage(storage_arc.clone());
                        let shm_pool = shm.create_pool(fd.as_fd(), *len as i32, qh, ());
                        let buffer = shm_pool.create_buffer(
                            0,
                            phys_w as i32,
                            phys_h as i32,
                            (phys_w * 4) as i32,
                            wl_shm::Format::Argb8888,
                            qh,
                            user_data,
                        );
                        shm_pool.destroy();
                        self.buffers.insert(
                            key,
                            CachedBuffer {
                                buffer,
                                width: phys_w,
                                height: phys_h,
                                storage: storage_arc.clone(),
                            },
                        );
                    }
                }
            }

            let Some(cached) = self.buffers.get(&key) else {
                continue;
            };
            if let Some(data) = cached.buffer.data::<BufferUserData>() {
                // 在仍持有 StorageReadLease 的前提下原子登记 busy_count，消除与 CEF 写入的空窗。
                if !data.acquire_busy() {
                    continue;
                }
            }

            let pres = frame_geom
                .map(|geom| build_committed_presentation(logical_w, logical_h, phys_w, phys_h, geom));

            let Some(out) = self.outputs.get_mut(&output_name) else {
                if let Some(data) = cached.buffer.data::<BufferUserData>() {
                    data.mark_released();
                }
                continue;
            };
            if has_viewporter {
                if let Some(vp) = &out.viewport {
                    if let Some(src) = compute_viewport_source(phys_w, phys_h, logical_w, logical_h) {
                        vp.set_source(src.x, src.y, src.w, src.h);
                    } else {
                        vp.set_source(-1.0, -1.0, -1.0, -1.0);
                    }
                    vp.set_destination(logical_w as i32, logical_h as i32);
                }
            } else {
                out.surface.set_buffer_scale(scale as i32);
            }
            out.surface.attach(Some(&cached.buffer), 0, 0);
            out.surface
                .damage_buffer(0, 0, phys_w as i32, phys_h as i32);
            out.surface.frame(qh, CallbackKind::Frame(output_name));
            out.surface.commit();
            out.frame_pending = true;
            out.last_committed_seq = seq;
            out.last_presentation = pres;
        }
    }

    fn push_pointer(
        &self,
        output_name: u32,
        surface_x: f64,
        surface_y: f64,
        left_down: bool,
        present: bool,
    ) {
        let Some(out) = self.outputs.get(&output_name) else {
            return;
        };
        let Some(pres) = out.last_presentation else {
            return;
        };
        if let Some(cur_geom) = self.offscreen_geom {
            // CEF 离屏几何已切换到新目标尺寸而本输出仍显示旧尺寸帧时暂停指针注入，等待对齐帧到达。
            if (pres.view_w, pres.view_h) != (cur_geom.width, cur_geom.height) {
                return;
            }
        }
        let (vx, vy) = map_pointer_to_committed_view(surface_x, surface_y, pres);
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
        // 先关闭生产者写入入口并退休/清空可写池，阻止在途或异常退出后的 on_frame 继续写旧存储，
        // 同时保持 `shutdown` 原值以便非主动退出照常触发 `on_fatal`。
        self.pool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close_producer_and_retire_all();

        for (_, mut out) in self.outputs.drain() {
            for cached in out.scaled_buffers.drain(..) {
                cached.buffer.destroy();
            }
            out.destroy();
        }
        for params in self.params_tracker.drain_handles() {
            params.destroy();
        }
        for (_, cached) in self.buffers.drain() {
            cached.buffer.destroy();
        }
        for (_, (_, cached)) in self.retired_buffers.drain() {
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

// ---- Wayland Dispatch 实现 ----

impl Dispatch<wl_registry::WlRegistry, ()> for WaylandState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _conn: &Connection,
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
                if state.outputs.contains_key(&name)
                    || state.pending_outputs.iter().any(|(p, _)| *p == name)
                    || state.buffers.keys().any(|k| k.output_name == name)
                    || state.params_tracker.has_active_output(name)
                {
                    state.retire_output(name);
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

impl Dispatch<ZwpLinuxBufferParamsV1, PendingDmabufParams> for WaylandState {
    fn event(
        state: &mut Self,
        params: &ZwpLinuxBufferParamsV1,
        event: zwp_linux_buffer_params_v1::Event,
        data: &PendingDmabufParams,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        // 无论是 `create` 还是 `create_immed`，`zwp_linux_buffer_params_v1` 都没有协议自动销毁语义，必须显式 destroy。
        // 被取消的 params 也会等到 Created/Failed 到齐后再销毁并归还唯一租约，避免 backend 吞掉迟到 Created 导致服务端 buffer 泄漏。
        let id = params.id();
        let (canceled, lease) = state.params_tracker.finish_event(&id, &data.key);
        params.destroy();

        let is_created = matches!(event, zwp_linux_buffer_params_v1::Event::Created { .. });
        let output_alive = state.outputs.contains_key(&data.key.output_name);
        let storage_active = state
            .pool
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active_storage_ids()
            .contains(&data.key.storage_id);
        let outcome = decide_dmabuf_params_event(canceled, output_alive, storage_active, is_created);

        match (event, outcome) {
            (zwp_linux_buffer_params_v1::Event::Created { buffer }, DmabufParamsOutcome::CacheBuffer) => {
                let storage = data.storage.clone();
                if let Some(udata) = buffer.data::<BufferUserData>() {
                    let _ = udata.storage.set(storage.clone());
                }
                if let Some(old) = state.buffers.insert(
                    data.key,
                    CachedBuffer {
                        buffer,
                        width: data.width,
                        height: data.height,
                        storage,
                    },
                ) {
                    state.retire_buffer(data.key.output_name, old);
                }
                drop(lease);
                state.flush_frames(qh);
            }
            (
                zwp_linux_buffer_params_v1::Event::Created { buffer },
                DmabufParamsOutcome::DestroyLateBuffer,
            ) => {
                drop(lease);
                buffer.destroy();
            }
            (zwp_linux_buffer_params_v1::Event::Failed, DmabufParamsOutcome::MarkDmabufBroken) => {
                drop(lease);
                tracing::warn!(
                    "layer-shell {} dmabuf 缓冲导入被合成器拒绝，后续帧降级到 SHM",
                    state.label
                );
                {
                    let mut pool = state.pool.lock().unwrap_or_else(|e| e.into_inner());
                    pool.dmabuf_broken = true;
                }
                let _ = tauri_runtime_kbcef::invalidate_offscreen(&state.label);
            }
            (
                zwp_linux_buffer_params_v1::Event::Failed,
                DmabufParamsOutcome::IgnoreCanceledFailure,
            ) => {
                drop(lease);
                tracing::debug!(
                    "layer-shell {} 已取消的 dmabuf params 返回 Failed，忽略",
                    state.label
                );
            }
            _ => {
                drop(lease);
            }
        }
    }

    wayland_client::event_created_child!(WaylandState, ZwpLinuxBufferParamsV1, [
        zwp_linux_buffer_params_v1::EVT_CREATED_OPCODE => (wl_buffer::WlBuffer, BufferUserData::new_unassigned()),
    ]);
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
        _conn: &Connection,
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
                state.retire_output(*output_name);
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
        buffer: &wl_buffer::WlBuffer,
        event: wl_buffer::Event,
        data: &BufferUserData,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = event {
            data.mark_released();
            if let Some((_, retired)) = state.retired_buffers.remove(&buffer.id()) {
                retired.buffer.destroy();
            }
        }
    }
}

impl Dispatch<wl_callback::WlCallback, CallbackKind> for WaylandState {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        kind: &CallbackKind,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let wl_callback::Event::Done { .. } = event else {
            return;
        };
        match *kind {
            CallbackKind::Frame(output_name) => {
                if let Some(out) = state.outputs.get_mut(&output_name) {
                    out.frame_pending = false;
                }
                state.flush_frames(qh);
            }
            CallbackKind::InitSync(sync_id) => {
                state.completed_sync_id = state.completed_sync_id.max(sync_id);
            }
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

// ---- 管道、背压、超时往返与线程主循环 ----

fn is_would_block(err: &WaylandError) -> bool {
    matches!(err, WaylandError::Io(io_err) if io_err.kind() == std::io::ErrorKind::WouldBlock)
}

fn roundtrip_with_timeout(
    conn: &Connection,
    queue: &mut wayland_client::EventQueue<WaylandState>,
    qh: &QueueHandle<WaylandState>,
    state: &mut WaylandState,
    wakeup_read: &OwnedFd,
    shutdown: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let sync_id = state.next_sync_id;
    state.next_sync_id += 1;
    conn.display().sync(qh, CallbackKind::InitSync(sync_id));
    let mut need_flush = true;

    while state.completed_sync_id < sync_id {
        if shutdown.load(Ordering::Acquire) {
            return Err("layer-shell 初始化被取消".to_string());
        }
        queue
            .dispatch_pending(state)
            .map_err(|e| format!("Wayland 分发失败: {e}"))?;
        if state.completed_sync_id >= sync_id {
            break;
        }
        if need_flush {
            match conn.flush() {
                Ok(()) => need_flush = false,
                Err(ref e) if is_would_block(e) => need_flush = true,
                Err(e) => return Err(format!("Wayland flush 失败: {e}")),
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("Wayland roundtrip 超时".to_string());
        }
        let timeout_ms = deadline
            .saturating_duration_since(now)
            .as_millis()
            .clamp(1, i32::MAX as u128) as i32;

        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut fds = [
            libc::pollfd {
                fd: guard.connection_fd().as_raw_fd(),
                events: libc::POLLIN | if need_flush { libc::POLLOUT } else { 0 },
                revents: 0,
            },
            libc::pollfd {
                fd: wakeup_read.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // SAFETY: 两个 fd 在本轮 poll 期间有效。
        let polled = unsafe { libc::poll(fds.as_mut_ptr(), 2, timeout_ms) };
        if polled < 0 {
            let err = std::io::Error::last_os_error();
            drop(guard);
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Wayland 初始化 poll 失败: {err}"));
        }
        if fds[1].revents & libc::POLLIN != 0 {
            drain_wakeup(wakeup_read);
        }
        if fds[0].revents & libc::POLLIN != 0 {
            match guard.read() {
                Ok(_) => {}
                Err(ref e) if is_would_block(e) => {}
                Err(e) => return Err(format!("Wayland 读事件失败: {e}")),
            }
        } else {
            drop(guard);
        }
        if fds[0].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err("Wayland 连接在初始化期间断开".to_string());
        }
    }
    Ok(())
}

pub(super) fn create_wakeup_pipe() -> Result<(OwnedFd, OwnedFd), String> {
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

#[allow(clippy::too_many_arguments)]
fn run_wayland_loop(
    label: String,
    wakeup_read: OwnedFd,
    shutdown: Arc<AtomicBool>,
    expect_dmabuf: bool,
    init_deadline: Instant,
    health: SinkHealth,
    on_stalled: Option<Arc<dyn Fn() + Send + Sync>>,
    on_fatal: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ready_tx: mpsc::SyncSender<Result<Arc<Mutex<FramePool>>, String>>,
) {
    let conn = match super::connect_wayland_with_timeout(
        init_deadline,
        Some((&wakeup_read, &shutdown)),
    ) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();

    let pool = Arc::new(Mutex::new(FramePool::new(None)));
    let mut state = WaylandState::new(label.clone(), pool.clone());

    let registry = conn.display().get_registry(&qh, ());
    if let Err(e) = roundtrip_with_timeout(
        &conn,
        &mut queue,
        &qh,
        &mut state,
        &wakeup_read,
        &shutdown,
        init_deadline,
    ) {
        state.cleanup();
        let _ = ready_tx.send(Err(e));
        return;
    }

    if state.compositor.is_none() || state.layer_shell.is_none() || state.shm.is_none() {
        state.cleanup();
        let _ = ready_tx.send(Err(
            "Wayland 合成器缺少 wl_compositor / zwlr_layer_shell_v1 / wl_shm".to_string(),
        ));
        return;
    }

    // 再跑几轮 roundtrip 收集 dmabuf feedback / output scale / seat capabilities。
    for _ in 0..3 {
        if let Err(e) = roundtrip_with_timeout(
            &conn,
            &mut queue,
            &qh,
            &mut state,
            &wakeup_read,
            &shutdown,
            init_deadline,
        ) {
            state.cleanup();
            let _ = ready_tx.send(Err(e));
            return;
        }
        if state.dmabuf_feedback.is_none() || state.dmabuf_feedback_done {
            break;
        }
    }

    // 与本机 GPU 协商公共 ARGB8888 modifier；若合成器缺少 wp_viewporter，
    // 为保证多屏不同尺寸/比例能走软件居中裁剪缩放铺满，统一走 SHM 而不启用零拷贝 dmabuf。
    let chosen_modifier = if expect_dmabuf && state.viewporter.is_some() {
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
    if let Err(e) = roundtrip_with_timeout(
        &conn,
        &mut queue,
        &qh,
        &mut state,
        &wakeup_read,
        &shutdown,
        init_deadline,
    ) {
        state.cleanup();
        let _ = ready_tx.send(Err(e));
        return;
    }

    let _ = ready_tx.send(Ok(pool));

    let mut first_frame_started_at: Option<Instant> = None;
    let mut nudged_invalidate = false;
    let mut stalled_reported = false;
    let mut fatal_reason: Option<String> = None;

    while !shutdown.load(Ordering::Acquire) {
        if let Err(e) = queue.dispatch_pending(&mut state) {
            let msg = format!("layer-shell {label} Wayland 分发失败: {e}");
            tracing::warn!("{msg}");
            fatal_reason = Some(msg);
            break;
        }
        state.flush_frames(&qh);
        let need_flush = match conn.flush() {
            Ok(()) => false,
            Err(ref e) if is_would_block(e) => true,
            Err(e) => {
                let msg = format!("layer-shell {label} Wayland flush 失败: {e}");
                tracing::warn!("{msg}");
                fatal_reason = Some(msg);
                break;
            }
        };

        let mut poll_timeout_ms = -1;
        if expect_dmabuf && !stalled_reported {
            let published = health.frames_published.load(Ordering::Acquire);
            let unrecoverable = health.dmabuf_unrecoverable.load(Ordering::Acquire);
            let elapsed = if state.offscreen_shown && published == 0 {
                first_frame_started_at
                    .get_or_insert_with(Instant::now)
                    .elapsed()
            } else {
                Duration::ZERO
            };
            match evaluate_first_frame_watchdog(
                expect_dmabuf,
                state.offscreen_shown,
                published,
                unrecoverable,
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
                        published,
                        unrecoverable,
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
                        "layer-shell {label} dmabuf 离屏通道异常（{}s 未出帧或无法读回），请求降级为软件共享内存（wl_shm）并重建壁纸窗口",
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

        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let wl_fd = guard.connection_fd().as_raw_fd();
        let mut fds = [
            libc::pollfd {
                fd: wl_fd,
                events: libc::POLLIN | if need_flush { libc::POLLOUT } else { 0 },
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
            let msg = format!("layer-shell {label} poll 失败: {err}");
            tracing::warn!("{msg}");
            fatal_reason = Some(msg);
            break;
        }
        if fds[1].revents & libc::POLLIN != 0 {
            drain_wakeup(&wakeup_read);
        }
        if fds[0].revents & libc::POLLIN != 0 {
            match guard.read() {
                Ok(_) => {}
                Err(ref e) if is_would_block(e) => {}
                Err(e) => {
                    let msg = format!("layer-shell {label} Wayland 读事件失败: {e}");
                    tracing::warn!("{msg}");
                    fatal_reason = Some(msg);
                    break;
                }
            }
        } else {
            drop(guard);
        }
        if fds[0].revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            let msg = format!("layer-shell {label} Wayland 连接断开");
            tracing::warn!("{msg}");
            fatal_reason = Some(msg);
            break;
        }
    }

    state.cleanup();
    let _ = conn.flush();
    tracing::info!("layer-shell {label} Wayland 线程已退出");

    if !shutdown.load(Ordering::Acquire) {
        if let Some(reason) = fatal_reason {
            if let Some(cb) = on_fatal {
                let _ = std::thread::Builder::new()
                    .name(format!("wallpaper-layer-shell-recover-{label}"))
                    .spawn(move || cb(reason));
            }
        }
    }
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
    fn frame_pool_dynamic_slots_and_storage_ids() {
        let mut pool = FramePool::new(None);
        pool.active_outputs = 3;
        pool.generation = 1;
        let id1 = pool.alloc_storage_id();
        let id2 = pool.alloc_storage_id();
        let id3 = pool.alloc_storage_id();
        assert_ne!(id1, id2);
        assert_ne!(id2, id3);

        let st0 = Arc::new(TrackedStorage::new(
            id1,
            1920,
            1080,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let st1 = Arc::new(TrackedStorage::new(
            id2,
            1920,
            1080,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let st2 = Arc::new(TrackedStorage::new(
            id3,
            1920,
            1080,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        pool.slots[0].storage = Some(st0.clone());
        pool.slots[1].storage = Some(st1.clone());
        pool.slots[2].storage = Some(st2.clone());
        pool.latest_ready = Some((1, 0, 1));

        // 优先避开 latest_ready(0)
        assert_eq!(pool.pick_free_slot(), Some(1));

        // 模拟 3 块屏分别占用 3 个槽，池在 max_slots(8) 内自动扩容到槽 3
        st0.busy_count.store(1, Ordering::Release);
        st1.busy_count.store(1, Ordering::Release);
        st2.busy_count.store(1, Ordering::Release);
        assert_eq!(pool.pick_free_slot(), Some(3));
        assert_eq!(pool.slots.len(), 4);

        // 释放后可缩容回 MIN_SLOTS
        pool.shrink_idle_slots();
        assert_eq!(pool.slots.len(), MIN_SLOTS);
    }

    #[test]
    fn buffer_user_data_lease_is_idempotent_across_release_and_retire() {
        let st = Arc::new(TrackedStorage::new(
            42,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let data = BufferUserData::new_with_storage(st.clone());
        assert!(data.acquire_busy());
        // 未释放时再次 acquire 返回 false，不重复计数
        assert!(!data.acquire_busy());
        assert_eq!(st.busy_count.load(Ordering::Acquire), 1);

        // 首次释放减 1，重复释放不负溢出
        assert!(data.mark_released());
        assert!(!data.mark_released());
        assert_eq!(st.busy_count.load(Ordering::Acquire), 0);
        assert!(st.is_free());
    }

    #[test]
    fn buffer_key_distinguishes_replaced_storage_of_same_dimensions() {
        let mut pool = FramePool::new(None);
        let first_id = pool.alloc_storage_id();
        let second_id = pool.alloc_storage_id();
        let key1 = BufferKey {
            output_name: 7,
            storage_id: first_id,
        };
        let key2 = BufferKey {
            output_name: 7,
            storage_id: second_id,
        };
        assert_ne!(key1, key2);
    }

    #[test]
    fn compute_effective_scale_prefers_fractional_only_when_viewporter_present() {
        assert!((compute_effective_scale(true, 2, Some(150)) - 1.25).abs() < 1e-6);
        assert!((compute_effective_scale(false, 2, Some(150)) - 2.0).abs() < 1e-6);
        assert!((compute_effective_scale(true, 2, None) - 2.0).abs() < 1e-6);
        assert!((compute_effective_scale(true, 1, Some(0)) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn select_offscreen_geometry_prefers_highest_physical_resolution() {
        // 1920x1080@2.0 (3840x2160) 应胜过 2560x1440@1.0
        let chosen = select_offscreen_geometry(&[(2560, 1440, 1.0), (1920, 1080, 2.0)]).unwrap();
        assert_eq!(chosen.width, 1920);
        assert_eq!(chosen.height, 1080);
        assert!((chosen.scale_factor - 2.0).abs() < 1e-6);

        assert!(select_offscreen_geometry(&[(0, 1080, 1.0)]).is_none());
    }

    #[test]
    fn viewport_crop_and_pointer_mapping_preserve_aspect_ratio_across_orientations() {
        // 1920x1080 横屏内容贴到 1080x1920 竖屏：应按 9:16 居中裁剪出 607.5x1080
        let crop = compute_viewport_source(1920, 1080, 1080, 1920).unwrap();
        assert!((crop.h - 1080.0).abs() < 1e-6);
        assert!((crop.w - 607.5).abs() < 1e-4);
        assert!((crop.x - 656.25).abs() < 1e-4);
        assert!((crop.y - 0.0).abs() < 1e-6);

        let geom = OffscreenGeometry {
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        };
        let pres = build_committed_presentation(1080, 1920, 1920, 1080, geom);
        assert_eq!(pres.source_crop, Some(crop));
        let (cx, cy) = map_pointer_to_committed_view(540.0, 960.0, pres);
        assert!((cx - 960.0).abs() < 1e-4);
        assert!((cy - 540.0).abs() < 1e-4);

        // 同比例无需裁剪
        assert!(compute_viewport_source(3840, 2160, 1920, 1080).is_none());
    }

    #[test]
    fn committed_presentation_pointer_mapping_and_frame_geometry_alignment() {
        let geom_1x = OffscreenGeometry {
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        };
        // 即使合成器无 wp_viewporter，提交层也通过 SHM 居中裁剪铺满 1080x1920，与有 viewporter 坐标严格一致。
        let pres = build_committed_presentation(1080, 1920, 1920, 1080, geom_1x);
        assert!((pres.surface_w - 1080.0).abs() < 1e-6);
        assert!((pres.surface_h - 1920.0).abs() < 1e-6);
        assert_eq!(pres.view_w, 1920);
        assert_eq!(pres.view_h, 1080);
        let (vx, vy) = map_pointer_to_committed_view(540.0, 960.0, pres);
        assert!((vx - 960.0).abs() < 1e-4);
        assert!((vy - 540.0).abs() < 1e-4);

        // 模拟异步 resize_offscreen 已改目标尺寸到 2560x1440@2，但当前出队帧仍携带 1920x1080@1：
        // 池内绑定几何仍保持 1920x1080，绝不把新视图尺寸与旧像素帧拼成错误呈现记录。
        let mut pool = FramePool::new(None);
        pool.generation = 1;
        pool.width = 1920;
        pool.height = 1080;
        let id = pool.alloc_storage_id();
        let st = Arc::new(TrackedStorage::new(
            id,
            1920,
            1080,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        pool.known_geometries.insert((1920, 1080), geom_1x);
        pool.slots[0].generation = 1;
        pool.slots[0].storage = Some(st);
        pool.slots[0].frame_geometry = Some(geom_1x);
        pool.latest_ready = Some((1, 0, 1));
        let (_, _, _, _lease, _, checked_geom) = pool.checkout_latest_for_consumer().unwrap();
        assert_eq!(checked_geom, Some(geom_1x));
        assert!(geometry_matches_physical(geom_1x, 1920, 1080));
        let geom_2x = OffscreenGeometry {
            width: 2560,
            height: 1440,
            scale_factor: 2.0,
        };
        assert!(!geometry_matches_physical(geom_2x, 1920, 1080));
    }

    #[test]
    fn crop_and_scale_bgra_centers_crop_for_portrait_output() {
        // 8x4 横屏源图：中间 2x4（x=3..5）为纯红，左右两侧为纯蓝。
        let mut src = vec![0u8; 8 * 4 * 4];
        for y in 0..4u32 {
            for x in 0..8u32 {
                let off = ((y * 8 + x) * 4) as usize;
                if (3..=4).contains(&x) {
                    src[off..off + 4].copy_from_slice(&[0, 0, 255, 255]);
                } else {
                    src[off..off + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        // 裁剪缩放到 4x8 竖屏（目标宽 = 4 * (4/8) = 2，正好居中截取 x=3..5 纯红列）。
        let mut dst = vec![0u8; 4 * 8 * 4];
        crop_and_scale_bgra(&src, 8, 4, &mut dst, 4, 8);
        for px in dst.chunks_exact(4) {
            assert_eq!(px, &[0, 0, 255, 255]);
        }
    }

    #[test]
    fn storage_read_lease_blocks_producer_until_dropped_and_busy_released() {
        let mut pool = FramePool::new(None);
        pool.generation = 1;
        let id = pool.alloc_storage_id();
        let st = Arc::new(TrackedStorage::new(
            id,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        pool.slots[0].generation = 1;
        pool.slots[0].storage = Some(st.clone());
        pool.latest_ready = Some((1, 0, 1));

        // 消费者在池锁内取出帧并取得读租约：即使新帧进来换走 latest_ready，旧槽位在租约释放前也不空闲。
        let (_, _, _, lease, _, _) = pool.checkout_latest_for_consumer().unwrap();
        pool.latest_ready = Some((1, 1, 2));
        assert!(!st.is_free());
        assert_ne!(pool.pick_free_slot(), Some(0));

        // 在释放读租约前登记 compositor busy_count，做到 lease -> busy 无缝交接。
        let data = BufferUserData::new_with_storage(st.clone());
        assert!(data.acquire_busy());
        drop(lease);
        assert!(!st.is_free());
        assert_ne!(pool.pick_free_slot(), Some(0));

        // 只有 compositor 也 release 之后，存储才真正回到可写空闲状态。
        assert!(data.mark_released());
        assert!(st.is_free());
        assert_eq!(pool.pick_free_slot(), Some(0));
    }

    #[test]
    fn cleanup_closes_producer_and_prevents_reuse_of_busy_storage() {
        let mut pool = FramePool::new(None);
        pool.generation = 1;
        let st = Arc::new(TrackedStorage::new(
            1,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let data = BufferUserData::new_with_storage(st.clone());
        assert!(data.acquire_busy());
        pool.slots[0].generation = 1;
        pool.slots[0].storage = Some(st.clone());
        pool.latest_ready = Some((1, 0, 1));

        // 终止清理首先在池锁内关停生产者并退休全部存储，绝不把未完成读取的 busy 存储重新开放写入。
        pool.close_producer_and_retire_all();
        assert!(pool.producer_closed);
        assert!(pool.checkout_latest_for_consumer().is_none());
        assert!(st.is_retired());
        assert!(!st.is_free());
        assert_eq!(st.busy_count.load(Ordering::Acquire), 1);
    }

    #[test]
    fn retired_storage_evicted_from_pool_without_artificial_release() {
        let mut pool = FramePool::new(None);
        pool.generation = 1;
        let st = Arc::new(TrackedStorage::new(
            1,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let data = BufferUserData::new_with_storage(st.clone());
        assert!(data.acquire_busy());
        pool.slots[0].generation = 1;
        pool.slots[0].storage = Some(st.clone());
        pool.latest_ready = Some((1, 0, 1));

        // 输出热拔出且未收到 wl_buffer.release：标为退休并踢出可写池，不人为减少 busy_count。
        st.mark_retired();
        assert!(!st.is_free());
        pool.evict_retired_slots();
        assert!(pool.slots[0].storage.is_none());
        assert!(pool.latest_ready.is_none());
        assert_eq!(st.busy_count.load(Ordering::Acquire), 1);

        // 真正收到 release 后计数才归零。
        assert!(data.mark_released());
        assert_eq!(st.busy_count.load(Ordering::Acquire), 0);
    }

    #[test]
    fn dmabuf_shm_readback_failures_trigger_unrecoverable_even_after_first_frame() {
        let health = SinkHealth::new_for_test();
        let failures = AtomicU32::new(0);
        // 即使此前已经成功发布过帧（例如初始 dmabuf_modifier=None 直接走 EGL readback），
        // 之后连续失败达到阈值仍必须触发 unrecoverable 并让看门狗立刻降级。
        health.test_record_published(Instant::now());
        assert!(!record_dmabuf_write_result(&failures, &health, false));
        assert!(!record_dmabuf_write_result(&failures, &health, false));
        assert!(!health.dmabuf_unrecoverable());
        assert!(record_dmabuf_write_result(&failures, &health, false));
        assert!(health.dmabuf_unrecoverable());
        assert_eq!(
            evaluate_first_frame_watchdog(true, true, 1, health.dmabuf_unrecoverable(), false, false, Duration::from_millis(10)),
            WatchdogDecision::TriggerFallback
        );
    }

    #[test]
    fn pending_params_tracker_late_created_preserves_new_key_and_releases_lease() {
        let st1 = Arc::new(TrackedStorage::new(
            1,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let st2 = Arc::new(TrackedStorage::new(
            1,
            2,
            2,
            SlotStorage::alloc_shm(2, 2).unwrap(),
        ));
        let key = BufferKey {
            output_name: 9,
            storage_id: 1,
        };
        let mut tracker: PendingParamsTracker<u64, &'static str> = PendingParamsTracker::new();
        tracker.insert(101, key, st1.acquire_read_lease(), "first");
        assert!(tracker.has_active_key(&key));
        assert!(!st1.is_free());

        // 取消旧请求 #101，同 key 新发请求 #102。
        tracker.cancel_by_key(&key);
        assert!(!tracker.has_active_key(&key));
        tracker.insert(102, key, st2.acquire_read_lease(), "second");
        assert!(tracker.has_active_key(&key));

        // 旧请求 #101 迟到收到 Created：被判定销毁服务端 buffer、释放 #101 租约，且绝不删掉新请求 #102 的 active key！
        let (canceled1, lease1) = tracker.finish_event(&101, &key);
        assert!(canceled1);
        assert_eq!(
            decide_dmabuf_params_event(canceled1, true, true, true),
            DmabufParamsOutcome::DestroyLateBuffer
        );
        drop(lease1);
        assert!(st1.is_free());
        assert!(tracker.has_active_key(&key));

        // 新请求 #102 正常到达 Created：正常缓存并释放租约。
        let (canceled2, lease2) = tracker.finish_event(&102, &key);
        assert!(!canceled2);
        assert_eq!(
            decide_dmabuf_params_event(canceled2, true, true, true),
            DmabufParamsOutcome::CacheBuffer
        );
        drop(lease2);
        assert!(st2.is_free());
        assert!(!tracker.has_active_key(&key));
    }

    #[test]
    fn dmabuf_params_lifecycle_destroys_late_created_after_cancel() {
        assert_eq!(
            decide_dmabuf_params_event(false, true, true, true),
            DmabufParamsOutcome::CacheBuffer
        );
        // 已被取消后迟到的 Created 必须销毁服务端 buffer，而不是丢弃事件泄漏资源。
        assert_eq!(
            decide_dmabuf_params_event(true, true, true, true),
            DmabufParamsOutcome::DestroyLateBuffer
        );
        assert_eq!(
            decide_dmabuf_params_event(false, false, true, true),
            DmabufParamsOutcome::DestroyLateBuffer
        );
        assert_eq!(
            decide_dmabuf_params_event(false, true, false, true),
            DmabufParamsOutcome::DestroyLateBuffer
        );
        // 已取消对象的 Failed 不应污染仍在使用的新配置。
        assert_eq!(
            decide_dmabuf_params_event(true, true, true, false),
            DmabufParamsOutcome::IgnoreCanceledFailure
        );
        assert_eq!(
            decide_dmabuf_params_event(false, true, true, false),
            DmabufParamsOutcome::MarkDmabufBroken
        );
    }

    #[test]
    fn first_frame_watchdog_handles_nudges_failures_and_published_frames() {
        assert_eq!(
            evaluate_first_frame_watchdog(
                false,
                true,
                0,
                false,
                false,
                false,
                Duration::from_secs(10)
            ),
            WatchdogDecision::Idle
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                false,
                0,
                false,
                false,
                false,
                Duration::from_secs(10)
            ),
            WatchdogDecision::Idle
        );
        // 成功发布可用帧后才停止看门狗
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                1,
                false,
                false,
                false,
                Duration::from_secs(10)
            ),
            WatchdogDecision::Idle
        );
        // 连续 GPU 导入/读回失败：即使曾经有帧或回调不断到达，也立即触发 CPU 降级
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                1,
                true,
                false,
                false,
                Duration::from_millis(100)
            ),
            WatchdogDecision::TriggerFallback
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                0,
                false,
                false,
                false,
                Duration::from_millis(200)
            ),
            WatchdogDecision::WaitMs(800)
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                0,
                false,
                false,
                false,
                Duration::from_millis(1000)
            ),
            WatchdogDecision::NudgeInvalidate
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                0,
                false,
                true,
                false,
                Duration::from_millis(2600)
            ),
            WatchdogDecision::WaitMs(400)
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                0,
                false,
                true,
                false,
                Duration::from_secs(3)
            ),
            WatchdogDecision::TriggerFallback
        );
        assert_eq!(
            evaluate_first_frame_watchdog(
                true,
                true,
                0,
                true,
                true,
                true,
                Duration::from_secs(4)
            ),
            WatchdogDecision::Idle
        );
    }
}
