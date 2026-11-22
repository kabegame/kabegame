//! 插件模式的壁纸推流：每个离屏壁纸窗口一个 PipeWire `Video/Source` 节点，Plasma 壁纸插件按节点属性找到它、
//! 用插件自己的消费端 `KabegameStreamItem` 显示（约定见 `.claude/plans/plasma-pipewire/README.md` 点 7；插件修订 2 起
//! 不再用 KPipeWire 的 `PipeWireSourceItem`，原因见 `src-plasma-wallpaper-plugin/README.md`「显示」）。
//!
//! 帧来自离屏 browser 的帧接收器（`tauri_runtime_kbcef::OffscreenFrameSink`），在 CEF UI 线程上同步调用：持着
//! 本流的 `pw_thread_loop` 锁取一个空缓冲、拷进去、入队，再 `trigger_process` 让图跑一轮（本流是驱动方，有新帧才出帧）。
//! 所以只能用底层接口：pipewire-rs 的高层类型不能跨线程。
//!
//! 格式只给 `BGRA`（插件的消费端只宣告它；当初的 KPipeWire 6.6 也不收 `BGRx`，2026-11-21 实测）、尺寸取帧的像素尺寸、帧率可变。帧尺寸变了就按
//! 新尺寸重新宣告格式，旧尺寸的帧丢掉。缓冲由本流分配（`ALLOC_BUFFERS`），两种：
//!
//! - **dmabuf**（离屏 browser 走共享纹理、[`super::gpu`] 可用时宣告在前）：宣告本设备的 modifier 列表
//!   （`MANDATORY | DONT_FIXATE`），消费者交回它也接受的那些，本流用 GBM 试分配挑一个、把定了 modifier 的格式放在最前面
//!   重新宣告，消费者再选它就定型（P0 实测的流程）。每帧把 CEF 的 dmabuf 用 GPU 拷进 GBM 分配的缓冲。
//! - **共享内存**（memfd，总宣告在最后兜底）：软件绘制的帧按行拷；CEF 给的是 dmabuf 时用 GPU 读回。
//!
//! 流的状态经回调交给调用方：所有链接都不在 `Streaming`（插件不可见、Plasma 暂停了流）时报 `false`，调用方据此让
//! 离屏 browser 停帧。
//!
//! 心跳：推流期间超过 [`IDLE_REFRESH`] 没有入队新帧（静态页面不出帧），就调调用方的 `on_idle` 请一整帧。没有它，
//! 后连上来的消费者（另一块屏上的插件实例、调试抓帧）在页面下一次变化之前拿不到任何画面：新链接不会让流的状态变化。

use std::ffi::{c_void, CString};
use std::os::fd::AsRawFd;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

use pipewire::spa;
use pipewire::sys as pw_sys;
use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
use spa::param::video::{VideoFormat, VideoInfoRaw};
use spa::param::ParamType;
use spa::pod::deserialize::PodDeserializer;
use spa::pod::serialize::PodSerializer;
use spa::pod::{self, ChoiceValue, Pod, Property, PropertyFlags, Value};
use spa::sys as spa_sys;
use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Rectangle, SpaTypes};
use tauri_runtime_kbcef::{OffscreenFrame, OffscreenFrameSink, OffscreenPixelFormat};

use super::gpu::{self, DmaBufSource, Gpu, GpuTarget};

/// 节点属性（与插件的约定）。
#[derive(Debug, Clone)]
pub struct StreamProps {
    /// `node.name`，如 `kabegame-wallpaper-0`
    pub node_name: String,
    pub description: String,
    /// `kabegame.wallpaper.slot`：输入消息里用它指明是哪一路
    pub slot: u32,
    /// `kabegame.wallpaper.screen`：接口名（DP-5）；不绑屏的那一路不写
    pub screen: Option<String>,
    /// `kabegame.wallpaper.input`：输入 socket 的绝对路径
    pub input: Option<String>,
    /// `maxFramerate`
    pub max_fps: u32,
    /// 宣告 dmabuf 格式：离屏 browser 走共享纹理（帧是 dmabuf）时为真，GPU 上下文不可用时自动当作假
    pub dmabuf: bool,
}

/// 约定的协议版本（节点属性 `kabegame.wallpaper.protocol`）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 流的状态变化：`true` 表示有消费者在拉流（`Streaming`）。在 PipeWire 线程上调用，不能阻塞。
pub type StateCallback = Box<dyn Fn(bool) + Send + Sync>;

/// 推流期间太久没有新帧：请帧源出一整帧。在心跳线程上调用，不能阻塞。
pub type IdleCallback = Box<dyn Fn() + Send + Sync>;

/// 推流期间多久没有新帧就请一整帧（同时是新消费者最多等多久拿到第一帧）。
const IDLE_REFRESH: Duration = Duration::from_secs(1);

/// `SPA_DATA_FLAG_MAPPABLE`（数据能直接 mmap）：比 0.3.65 还新的 PipeWire 才有这个宏，构建机（Ubuntu 22.04）的 0.3.48
/// 头文件里没有，所以自己写。它只是 `spa_data.flags` 里的一位，不认识它的消费端忽略。
const SPA_DATA_FLAG_MAPPABLE: u32 = 1 << 3;

static PW_INIT: Once = Once::new();

/// 一路壁纸流。drop 时断开并销毁节点。
pub struct WallpaperStream {
    inner: Box<Inner>,
}

// SAFETY: 两个裸指针只在持着 `pw_thread_loop` 锁时使用（构造、帧回调、drop），PipeWire 回调也在该线程循环上、持锁运行。
unsafe impl Send for WallpaperStream {}
unsafe impl Sync for WallpaperStream {}

struct Inner {
    thread_loop: *mut pw_sys::pw_thread_loop,
    stream: *mut pw_sys::pw_stream,
    props: StreamProps,
    /// 宣告 dmabuf 时的 GPU 上下文
    gpu: Option<&'static Gpu>,
    negotiated: Mutex<Negotiated>,
    on_state: StateCallback,
    heartbeat: Arc<Heartbeat>,
    heartbeat_thread: Option<std::thread::JoinHandle<()>>,
    /// 连续拷帧失败次数（日志限频用）
    failures: AtomicU32,
}

/// 定型后的缓冲种类与尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Shm { width: u32, height: u32 },
    DmaBuf { width: u32, height: u32, modifier: u64, planes: u32 },
}

impl Mode {
    fn size(&self) -> (u32, u32) {
        match *self {
            Mode::Shm { width, height } | Mode::DmaBuf { width, height, .. } => (width, height),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct Negotiated {
    /// 宣告的尺寸（帧的像素尺寸）
    width: u32,
    height: u32,
    /// 宣告里带不带 dmabuf 格式
    offer_dmabuf: bool,
    /// dmabuf 定型中：已挑好的 modifier，重新宣告时放在最前面
    fixating: Option<u64>,
    /// 定型结果；`None` 表示还没定型或正在重新协商
    mode: Option<Mode>,
    streaming: bool,
}

/// 心跳线程与流共用的状态。
struct Heartbeat {
    streaming: AtomicBool,
    /// 上一次入队新帧（或请过整帧）的时刻
    last_frame: Mutex<Instant>,
    stop: Mutex<bool>,
    wake: Condvar,
    on_idle: IdleCallback,
}

impl Heartbeat {
    fn touch(&self) {
        *self.last_frame.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn run(&self) {
        let mut stop = self.stop.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let (guard, _) = self
                .wake
                .wait_timeout(stop, IDLE_REFRESH / 2)
                .unwrap_or_else(|e| e.into_inner());
            stop = guard;
            if *stop {
                return;
            }
            if !self.streaming.load(Ordering::Acquire) {
                continue;
            }
            let idle = self
                .last_frame
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .elapsed()
                >= IDLE_REFRESH;
            if idle {
                // 先记下：帧源出帧要一会儿，下一轮不重复请
                self.touch();
                (self.on_idle)();
            }
        }
    }
}

impl WallpaperStream {
    /// 建节点并连接。`width` / `height` 是首帧的像素尺寸（之后帧尺寸变了会自动重新协商）。
    pub fn new(
        props: StreamProps,
        width: u32,
        height: u32,
        on_state: StateCallback,
        on_idle: IdleCallback,
    ) -> Result<Self, String> {
        PW_INIT.call_once(|| unsafe { pw_sys::pw_init(ptr::null_mut(), ptr::null_mut()) });
        let gpu = if props.dmabuf { gpu::get() } else { None };
        let loop_name = CString::new("kabegame-wallpaper").unwrap();
        // SAFETY: 名字是有效 C 字符串，props 为空。
        let thread_loop = unsafe { pw_sys::pw_thread_loop_new(loop_name.as_ptr(), ptr::null()) };
        if thread_loop.is_null() {
            return Err("pw_thread_loop_new failed".to_string());
        }
        let mut inner = Box::new(Inner {
            thread_loop,
            stream: ptr::null_mut(),
            props,
            gpu,
            negotiated: Mutex::new(Negotiated {
                width: width.max(1),
                height: height.max(1),
                offer_dmabuf: gpu.is_some(),
                ..Default::default()
            }),
            on_state,
            heartbeat: Arc::new(Heartbeat {
                streaming: AtomicBool::new(false),
                last_frame: Mutex::new(Instant::now()),
                stop: Mutex::new(false),
                wake: Condvar::new(),
                on_idle,
            }),
            heartbeat_thread: None,
            failures: AtomicU32::new(0),
        });
        // 先启动线程循环，之后对流的操作都持锁
        // SAFETY: thread_loop 有效。
        if unsafe { pw_sys::pw_thread_loop_start(thread_loop) } < 0 {
            unsafe { pw_sys::pw_thread_loop_destroy(thread_loop) };
            return Err("pw_thread_loop_start failed".to_string());
        }
        let guard = LoopGuard::lock(thread_loop);
        let result = inner.connect();
        drop(guard);
        if let Err(error) = result {
            // inner 的 Drop 负责停线程循环、销毁
            drop(inner);
            return Err(error);
        }
        let heartbeat = inner.heartbeat.clone();
        inner.heartbeat_thread = Some(
            std::thread::Builder::new()
                .name(format!("{}-heartbeat", inner.props.node_name))
                .spawn(move || heartbeat.run())
                .map_err(|e| format!("启动心跳线程失败: {e}"))?,
        );
        Ok(Self { inner })
    }

    /// 节点名（日志用）。
    pub fn node_name(&self) -> &str {
        &self.inner.props.node_name
    }
}

impl Inner {
    fn lock_negotiated(&self) -> std::sync::MutexGuard<'_, Negotiated> {
        self.negotiated.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 在持锁状态下建流并连接。
    fn connect(&mut self) -> Result<(), String> {
        let props = self.node_properties()?;
        let name = CString::new("kabegame-wallpaper").unwrap();
        // SAFETY: thread_loop 有效，props 的所有权交给流，事件表是 'static，userdata 指向 Box 里不动的 Inner。
        let stream = unsafe {
            pw_sys::pw_stream_new_simple(
                pw_sys::pw_thread_loop_get_loop(self.thread_loop),
                name.as_ptr(),
                props,
                &*STREAM_EVENTS,
                (self as *mut Inner).cast::<c_void>(),
            )
        };
        if stream.is_null() {
            return Err("pw_stream_new_simple failed".to_string());
        }
        self.stream = stream;
        let formats = self.format_params(&self.lock_negotiated().clone())?;
        let mut params: Vec<*const spa_sys::spa_pod> = formats.iter().map(|bytes| pod_ptr(bytes)).collect();
        // SAFETY: 流有效，params 指向本栈帧里存活的 pod。
        let res = unsafe {
            pw_sys::pw_stream_connect(
                stream,
                spa_sys::SPA_DIRECTION_OUTPUT,
                pw_sys::PW_ID_ANY,
                pw_sys::pw_stream_flags_PW_STREAM_FLAG_DRIVER
                    | pw_sys::pw_stream_flags_PW_STREAM_FLAG_ALLOC_BUFFERS,
                params.as_mut_ptr(),
                params.len() as u32,
            )
        };
        if res < 0 {
            return Err(format!("pw_stream_connect failed: {res}"));
        }
        Ok(())
    }

    fn node_properties(&self) -> Result<*mut pw_sys::pw_properties, String> {
        let mut entries: Vec<(&str, String)> = vec![
            ("media.class", "Video/Source".to_string()),
            ("node.name", self.props.node_name.clone()),
            ("node.description", self.props.description.clone()),
            ("kabegame.wallpaper.protocol", PROTOCOL_VERSION.to_string()),
            ("kabegame.wallpaper.slot", self.props.slot.to_string()),
        ];
        if let Some(screen) = &self.props.screen {
            entries.push(("kabegame.wallpaper.screen", screen.clone()));
        }
        if let Some(input) = &self.props.input {
            entries.push(("kabegame.wallpaper.input", input.clone()));
        }
        // SAFETY: 变参以空指针结尾；返回的 properties 之后交给 pw_stream_new_simple。
        let properties = unsafe { pw_sys::pw_properties_new(ptr::null::<std::ffi::c_char>()) };
        if properties.is_null() {
            return Err("pw_properties_new failed".to_string());
        }
        for (key, value) in entries {
            let key = CString::new(key).map_err(|e| e.to_string())?;
            let value = CString::new(value).map_err(|e| e.to_string())?;
            // SAFETY: properties 有效，键值是有效 C 字符串（PipeWire 自己拷贝）。
            unsafe { pw_sys::pw_properties_set(properties, key.as_ptr(), value.as_ptr()) };
        }
        Ok(properties)
    }

    /// 要宣告的 `EnumFormat`，按优先顺序：定好 modifier 的 dmabuf、modifier 列表的 dmabuf、共享内存。
    fn format_params(&self, n: &Negotiated) -> Result<Vec<Vec<u8>>, String> {
        let (width, height, fps) = (n.width, n.height, self.props.max_fps);
        let mut formats = Vec::new();
        if let Some(modifier) = n.fixating {
            formats.push(enum_format(width, height, fps, ModifierSpec::Fixed(modifier))?);
        }
        if n.offer_dmabuf {
            if let Some(gpu) = self.gpu {
                formats.push(enum_format(width, height, fps, ModifierSpec::Choice(&gpu.modifiers()))?);
            }
        }
        formats.push(enum_format(width, height, fps, ModifierSpec::None)?);
        Ok(formats)
    }

    /// 重新宣告格式（持锁调用）。
    fn announce(&self, n: &Negotiated) {
        match self.format_params(n) {
            Ok(formats) => {
                let mut params: Vec<*const spa_sys::spa_pod> =
                    formats.iter().map(|bytes| pod_ptr(bytes)).collect();
                // SAFETY: 持锁、流有效。
                unsafe { pw_sys::pw_stream_update_params(self.stream, params.as_mut_ptr(), params.len() as u32) };
            }
            Err(error) => tracing::warn!("壁纸流 {} 拼格式失败: {error}", self.props.node_name),
        }
    }

    /// 帧尺寸变了，或要撤掉 dmabuf：按 `n` 重新宣告（持锁调用）。
    fn renegotiate(&self, update: impl FnOnce(&mut Negotiated)) {
        let n = {
            let mut n = self.lock_negotiated();
            update(&mut n);
            n.fixating = None;
            n.mode = None;
            n.clone()
        };
        tracing::debug!(
            "壁纸流 {} 按 {}x{}（dmabuf {}）重新协商",
            self.props.node_name,
            n.width,
            n.height,
            n.offer_dmabuf
        );
        self.announce(&n);
    }

    /// 拷帧失败：头一次与之后每 600 次记一条。
    fn report_failure(&self, error: &str) {
        let count = self.failures.fetch_add(1, Ordering::Relaxed);
        if count % 600 == 0 {
            tracing::warn!("壁纸流 {} 拷帧失败（第 {} 次）: {error}", self.props.node_name, count + 1);
        }
    }

    /// 把一帧 BGRA 拷进一个空缓冲并入队（持锁调用，共享内存）。没有空缓冲（消费者还没还回来）就丢掉这一帧。
    fn push_cpu(&self, data: &[u8], width: u32, height: u32) {
        let stride = width as usize * 4;
        // SAFETY: 持锁、流有效；缓冲是本流在 add_buffer 里分配并映射的 memfd。
        unsafe {
            let buffer = pw_sys::pw_stream_dequeue_buffer(self.stream);
            if buffer.is_null() {
                return;
            }
            let spa_buffer = (*buffer).buffer;
            if spa_buffer.is_null() || (*spa_buffer).n_datas < 1 {
                pw_sys::pw_stream_queue_buffer(self.stream, buffer);
                return;
            }
            let d = &mut *(*spa_buffer).datas;
            let len = stride * height as usize;
            let chunk = &mut *d.chunk;
            if !d.data.is_null() && d.maxsize as usize >= len && data.len() >= len {
                ptr::copy_nonoverlapping(data.as_ptr(), d.data.cast::<u8>(), len);
                set_chunk(chunk, 0, stride as u32, len as u32, true);
            } else {
                set_chunk(chunk, 0, 0, 0, false);
            }
            pw_sys::pw_stream_queue_buffer(self.stream, buffer);
            pw_sys::pw_stream_trigger_process(self.stream);
        }
        self.heartbeat.touch();
    }

    /// 把 CEF 的一帧 dmabuf 经 GPU 拷进一个空缓冲并入队（持锁调用）：dmabuf 模式拷进 GBM 缓冲，共享内存模式读回。
    fn push_gpu(&self, gpu: &Gpu, source: &DmaBufSource<'_>, mode: Mode) {
        // SAFETY: 持锁、流有效；dmabuf 模式的 user_data 是本流 add_buffer 里放的 `GpuTarget`，共享内存模式的 data 是 memfd 映射。
        unsafe {
            let buffer = pw_sys::pw_stream_dequeue_buffer(self.stream);
            if buffer.is_null() {
                return;
            }
            let spa_buffer = (*buffer).buffer;
            if spa_buffer.is_null() || (*spa_buffer).n_datas < 1 {
                pw_sys::pw_stream_queue_buffer(self.stream, buffer);
                return;
            }
            let datas = (*spa_buffer).datas;
            let n_datas = (*spa_buffer).n_datas as usize;
            let result = match mode {
                Mode::DmaBuf { .. } => {
                    let target = (*buffer).user_data.cast::<GpuTarget>();
                    if target.is_null() {
                        Err("缓冲没有分配到 GPU 目标".to_string())
                    } else {
                        let target = &*target;
                        gpu.blit_to_target(source, target).map(|()| {
                            for (index, plane) in target.planes.iter().enumerate().take(n_datas) {
                                let d = &mut *datas.add(index);
                                set_chunk(&mut *d.chunk, plane.offset, plane.stride, plane.stride * target.height, true);
                            }
                        })
                    }
                }
                Mode::Shm { width, height } => {
                    let d = &mut *datas;
                    if d.data.is_null() {
                        Err("共享内存缓冲没有映射".to_string())
                    } else {
                        let out = std::slice::from_raw_parts_mut(d.data.cast::<u8>(), d.maxsize as usize);
                        gpu.blit_to_memory(source, width, height, out).map(|()| {
                            set_chunk(&mut *d.chunk, 0, width * 4, width * height * 4, true);
                        })
                    }
                }
            };
            if let Err(error) = &result {
                self.report_failure(error);
                for index in 0..n_datas {
                    set_chunk(&mut *(*datas.add(index)).chunk, 0, 0, 0, false);
                }
            } else {
                self.failures.store(0, Ordering::Relaxed);
            }
            pw_sys::pw_stream_queue_buffer(self.stream, buffer);
            pw_sys::pw_stream_trigger_process(self.stream);
        }
        self.heartbeat.touch();
    }
}

/// 写一个 chunk；`ok` 为假时标成损坏、大小 0（这一帧作废，消费者跳过）。
fn set_chunk(chunk: &mut spa_sys::spa_chunk, offset: u32, stride: u32, size: u32, ok: bool) {
    chunk.offset = offset;
    chunk.stride = stride as i32;
    chunk.size = size;
    chunk.flags = if ok { 0 } else { spa_sys::SPA_CHUNK_FLAG_CORRUPTED as i32 };
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(thread) = self.heartbeat_thread.take() {
            *self.heartbeat.stop.lock().unwrap_or_else(|e| e.into_inner()) = true;
            self.heartbeat.wake.notify_all();
            let _ = thread.join();
        }
        // SAFETY: 先持锁销毁流（回调不会再进来，缓冲随之 remove_buffer），再停线程循环、销毁。
        unsafe {
            if !self.stream.is_null() {
                pw_sys::pw_thread_loop_lock(self.thread_loop);
                pw_sys::pw_stream_destroy(self.stream);
                self.stream = ptr::null_mut();
                pw_sys::pw_thread_loop_unlock(self.thread_loop);
            }
            pw_sys::pw_thread_loop_stop(self.thread_loop);
            pw_sys::pw_thread_loop_destroy(self.thread_loop);
        }
    }
}

impl OffscreenFrameSink for WallpaperStream {
    fn on_frame(&self, frame: OffscreenFrame<'_>) {
        let inner = &self.inner;
        // 流的尺寸取有效内容的尺寸：dmabuf 的缓冲（coded size）可能比画面大
        let (width, height) = match &frame {
            OffscreenFrame::Cpu { width, height, .. } => (*width, *height),
            OffscreenFrame::DmaBuf { visible, .. } => (visible.2, visible.3),
        };
        if width == 0 || height == 0 {
            return;
        }
        let _guard = LoopGuard::lock(inner.thread_loop);
        let n = inner.lock_negotiated().clone();
        if (n.width, n.height) != (width, height) {
            inner.renegotiate(|n| {
                n.width = width;
                n.height = height;
            });
            return;
        }
        let Some(mode) = n.mode else { return };
        if !n.streaming || mode.size() != (width, height) {
            return;
        }
        match frame {
            OffscreenFrame::Cpu { data, format, .. } => {
                if format != OffscreenPixelFormat::Bgra {
                    return;
                }
                match mode {
                    Mode::Shm { .. } => inner.push_cpu(data, width, height),
                    Mode::DmaBuf { .. } => {
                        // 共享纹理下 CEF 只在 GPU 合成退回软件时才交整帧像素：没法再给 dmabuf，撤掉 dmabuf 格式
                        tracing::warn!(
                            "壁纸流 {} 定型为 dmabuf 却收到软件绘制的帧，改用共享内存",
                            inner.props.node_name
                        );
                        inner.renegotiate(|n| n.offer_dmabuf = false);
                    }
                }
            }
            OffscreenFrame::DmaBuf {
                planes,
                modifier,
                format,
                width: coded_width,
                height: coded_height,
                visible,
            } => {
                let Some(gpu) = inner.gpu else {
                    inner.report_failure("收到 dmabuf 帧但没有 GPU 上下文（离屏 browser 不该开共享纹理）");
                    return;
                };
                let source = DmaBufSource {
                    planes,
                    modifier,
                    format,
                    width: coded_width,
                    height: coded_height,
                    visible,
                };
                inner.push_gpu(gpu, &source, mode);
            }
        }
    }
}

/// 持着 `pw_thread_loop` 锁的作用域。
struct LoopGuard(*mut pw_sys::pw_thread_loop);

impl LoopGuard {
    fn lock(thread_loop: *mut pw_sys::pw_thread_loop) -> Self {
        // SAFETY: thread_loop 在本流存活期间有效；锁可重入（PipeWire 回调里再拿也不会死锁）。
        unsafe { pw_sys::pw_thread_loop_lock(thread_loop) };
        Self(thread_loop)
    }
}

impl Drop for LoopGuard {
    fn drop(&mut self) {
        // SAFETY: 与 lock 配对。
        unsafe { pw_sys::pw_thread_loop_unlock(self.0) };
    }
}

fn serialize(value: Value) -> Result<Vec<u8>, String> {
    PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &value)
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|e| format!("pod serialize: {e:?}"))
}

fn pod_ptr(bytes: &[u8]) -> *const spa_sys::spa_pod {
    Pod::from_bytes(bytes)
        .map(|pod| pod.as_raw_ptr().cast_const())
        .unwrap_or(ptr::null())
}

/// `EnumFormat` 里的 modifier。
enum ModifierSpec<'a> {
    /// 共享内存：不带 modifier
    None,
    /// dmabuf，候选列表待定型
    Choice(&'a [u64]),
    /// dmabuf，已定型
    Fixed(u64),
}

/// `EnumFormat`：BGRA、固定尺寸、可变帧率（`framerate 0/1` + `maxFramerate`），dmabuf 再带 modifier。
fn enum_format(width: u32, height: u32, max_fps: u32, modifier: ModifierSpec<'_>) -> Result<Vec<u8>, String> {
    let max_fps = max_fps.max(1);
    let mut properties = vec![
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(FormatProperties::VideoFormat, Id, VideoFormat::BGRA),
    ];
    match modifier {
        ModifierSpec::None => {}
        ModifierSpec::Choice(list) => {
            let Some(first) = list.first() else {
                return Err("modifier 列表为空".to_string());
            };
            properties.push(Property {
                key: spa_sys::SPA_FORMAT_VIDEO_modifier,
                flags: PropertyFlags::from_bits_retain(
                    spa_sys::SPA_POD_PROP_FLAG_MANDATORY | spa_sys::SPA_POD_PROP_FLAG_DONT_FIXATE,
                ),
                value: Value::Choice(ChoiceValue::Long(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum {
                        default: *first as i64,
                        alternatives: list.iter().map(|modifier| *modifier as i64).collect(),
                    },
                ))),
            });
        }
        ModifierSpec::Fixed(modifier) => properties.push(Property {
            key: spa_sys::SPA_FORMAT_VIDEO_modifier,
            flags: PropertyFlags::MANDATORY,
            value: Value::Long(modifier as i64),
        }),
    }
    properties.push(pod::property!(
        FormatProperties::VideoSize,
        Rectangle,
        Rectangle { width, height }
    ));
    properties.push(pod::property!(
        FormatProperties::VideoFramerate,
        Fraction,
        Fraction { num: 0, denom: 1 }
    ));
    properties.push(pod::property!(
        FormatProperties::VideoMaxFramerate,
        Choice,
        Range,
        Fraction,
        Fraction { num: max_fps, denom: 1 },
        Fraction { num: 1, denom: 1 },
        Fraction { num: max_fps, denom: 1 }
    ));
    serialize(Value::Object(pod::Object {
        type_: SpaTypes::ObjectParamFormat.as_raw(),
        id: ParamType::EnumFormat.as_raw(),
        properties,
    }))
}

/// 定型格式里的 modifier。
enum ModifierValue {
    /// 没有：共享内存
    Absent,
    /// 消费者交回的候选（`DONT_FIXATE` 让它保持为选择），等本流挑
    Candidates(Vec<u64>),
    Fixed(u64),
}

/// 从协商出的 `Format` 里取 modifier。
///
/// SAFETY: `param` 指向一个完整的 spa_pod。
unsafe fn format_modifier(param: *const spa_sys::spa_pod) -> ModifierValue {
    let len = std::mem::size_of::<spa_sys::spa_pod>() + (*param).size as usize;
    let bytes = std::slice::from_raw_parts(param.cast::<u8>(), len);
    let Ok((_, Value::Object(object))) = PodDeserializer::deserialize_any_from(bytes) else {
        return ModifierValue::Absent;
    };
    let Some(property) = object
        .properties
        .into_iter()
        .find(|property| property.key == spa_sys::SPA_FORMAT_VIDEO_modifier)
    else {
        return ModifierValue::Absent;
    };
    match property.value {
        Value::Long(modifier) => ModifierValue::Fixed(modifier as u64),
        Value::Choice(ChoiceValue::Long(Choice(_, ChoiceEnum::None(modifier)))) => {
            ModifierValue::Fixed(modifier as u64)
        }
        Value::Choice(ChoiceValue::Long(Choice(_, ChoiceEnum::Enum { alternatives, .. }))) => {
            ModifierValue::Candidates(alternatives.into_iter().map(|modifier| modifier as u64).collect())
        }
        _ => ModifierValue::Absent,
    }
}

/// 定型后的 `Buffers` 与 `Meta`。
fn buffer_params(mode: Mode) -> Result<(Vec<u8>, Vec<u8>), String> {
    let count = Property::new(
        spa_sys::SPA_PARAM_BUFFERS_buffers,
        Value::Choice(ChoiceValue::Int(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::Range {
                default: 4,
                min: 2,
                max: 8,
            },
        ))),
    );
    let data_type = |kind: u32| Property {
        key: spa_sys::SPA_PARAM_BUFFERS_dataType,
        flags: PropertyFlags::empty(),
        value: Value::Choice(ChoiceValue::Int(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::Flags {
                default: 1i32 << kind,
                flags: vec![1i32 << kind],
            },
        ))),
    };
    let properties = match mode {
        Mode::Shm { width, height } => {
            let stride = (width * 4) as i32;
            vec![
                count,
                Property::new(spa_sys::SPA_PARAM_BUFFERS_blocks, Value::Int(1)),
                Property::new(spa_sys::SPA_PARAM_BUFFERS_size, Value::Int(stride * height as i32)),
                Property::new(spa_sys::SPA_PARAM_BUFFERS_stride, Value::Int(stride)),
                data_type(spa_sys::SPA_DATA_MemFd),
            ]
        }
        Mode::DmaBuf { planes, .. } => vec![
            count,
            Property::new(spa_sys::SPA_PARAM_BUFFERS_blocks, Value::Int(planes as i32)),
            data_type(spa_sys::SPA_DATA_DmaBuf),
        ],
    };
    let buffers = serialize(Value::Object(pod::Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties,
    }))?;
    let meta = serialize(Value::Object(pod::Object {
        type_: SpaTypes::ObjectParamMeta.as_raw(),
        id: ParamType::Meta.as_raw(),
        properties: vec![
            Property::new(
                spa_sys::SPA_PARAM_META_type,
                Value::Id(spa::utils::Id(spa_sys::SPA_META_Header)),
            ),
            Property::new(
                spa_sys::SPA_PARAM_META_size,
                Value::Int(std::mem::size_of::<spa_sys::spa_meta_header>() as i32),
            ),
        ],
    }))?;
    Ok((buffers, meta))
}

static STREAM_EVENTS: LazyLock<pw_sys::pw_stream_events> = LazyLock::new(|| {
    // SAFETY: 全零是「没有回调」的合法初值。
    let mut events: pw_sys::pw_stream_events = unsafe { std::mem::zeroed() };
    events.version = pw_sys::PW_VERSION_STREAM_EVENTS;
    events.state_changed = Some(on_state_changed);
    events.param_changed = Some(on_param_changed);
    events.add_buffer = Some(on_add_buffer);
    events.remove_buffer = Some(on_remove_buffer);
    events
});

unsafe extern "C" fn on_state_changed(
    data: *mut c_void,
    _old: pw_sys::pw_stream_state,
    state: pw_sys::pw_stream_state,
    error: *const std::ffi::c_char,
) {
    let inner = &*data.cast::<Inner>();
    let streaming = state == pw_sys::pw_stream_state_PW_STREAM_STATE_STREAMING;
    if state == pw_sys::pw_stream_state_PW_STREAM_STATE_ERROR {
        let message = if error.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(error).to_string_lossy().into_owned()
        };
        tracing::warn!("壁纸流 {} 出错: {message}", inner.props.node_name);
    }
    let changed = {
        let mut n = inner.lock_negotiated();
        let changed = n.streaming != streaming;
        n.streaming = streaming;
        changed
    };
    if changed {
        tracing::debug!("壁纸流 {} streaming={streaming}", inner.props.node_name);
        inner.heartbeat.streaming.store(streaming, Ordering::Release);
        if streaming {
            // 状态回调会请整帧，心跳从现在起算
            inner.heartbeat.touch();
        }
        (inner.on_state)(streaming);
    }
}

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const spa_sys::spa_pod) {
    if id != spa_sys::SPA_PARAM_Format || param.is_null() {
        return;
    }
    let inner = &*data.cast::<Inner>();
    let mut info = VideoInfoRaw::new();
    if info.parse(Pod::from_raw(param)).is_err() {
        tracing::warn!("壁纸流 {} 解析不了协商出的格式", inner.props.node_name);
        return;
    }
    let size = info.size();
    let (width, height) = (size.width, size.height);
    let mode = match format_modifier(param) {
        ModifierValue::Absent => Mode::Shm { width, height },
        ModifierValue::Candidates(candidates) => {
            // 消费者交回了它也接受的 modifier：挑一个本设备分配得出来的，定型后放在最前面重新宣告
            let chosen = inner
                .gpu
                .and_then(|gpu| gpu.choose_modifier(width, height, &candidates));
            let n = {
                let mut n = inner.lock_negotiated();
                n.mode = None;
                match chosen {
                    Some(modifier) => {
                        tracing::debug!(
                            "壁纸流 {} 消费者接受 {} 个 modifier，定为 0x{modifier:x}",
                            inner.props.node_name,
                            candidates.len()
                        );
                        n.fixating = Some(modifier);
                    }
                    None => {
                        tracing::warn!(
                            "壁纸流 {} 消费者接受的 {} 个 modifier 本设备都分配不了，改用共享内存",
                            inner.props.node_name,
                            candidates.len()
                        );
                        n.fixating = None;
                        n.offer_dmabuf = false;
                    }
                }
                n.clone()
            };
            inner.announce(&n);
            return;
        }
        ModifierValue::Fixed(modifier) => {
            let planes = inner
                .gpu
                .and_then(|gpu| gpu.plane_count(width, height, modifier));
            match planes {
                Some(planes) => Mode::DmaBuf {
                    width,
                    height,
                    modifier,
                    planes,
                },
                None => {
                    tracing::warn!(
                        "壁纸流 {} 定型的 modifier 0x{modifier:x} 本设备分配不了，改用共享内存",
                        inner.props.node_name
                    );
                    inner.renegotiate(|n| n.offer_dmabuf = false);
                    return;
                }
            }
        }
    };
    inner.lock_negotiated().mode = Some(mode);
    tracing::debug!("壁纸流 {} 定型 {mode:?} {:?}", inner.props.node_name, info.format());
    match buffer_params(mode) {
        Ok((buffers, meta)) => {
            let mut params = [pod_ptr(&buffers), pod_ptr(&meta)];
            pw_sys::pw_stream_update_params(inner.stream, params.as_mut_ptr(), params.len() as u32);
        }
        Err(error) => tracing::warn!("壁纸流 {} 拼缓冲参数失败: {error}", inner.props.node_name),
    }
}

unsafe extern "C" fn on_add_buffer(data: *mut c_void, buffer: *mut pw_sys::pw_buffer) {
    let inner = &*data.cast::<Inner>();
    let spa_buffer = (*buffer).buffer;
    if spa_buffer.is_null() || (*spa_buffer).n_datas < 1 {
        return;
    }
    let Some(mode) = inner.lock_negotiated().mode else {
        return;
    };
    let datas = (*spa_buffer).datas;
    match mode {
        Mode::DmaBuf {
            width,
            height,
            modifier,
            ..
        } => {
            let Some(gpu) = inner.gpu else { return };
            match gpu.alloc_target(width, height, modifier) {
                Ok(target) => {
                    let n_datas = (*spa_buffer).n_datas as usize;
                    for (index, plane) in target.planes.iter().enumerate().take(n_datas) {
                        let d = &mut *datas.add(index);
                        d.type_ = spa_sys::SPA_DATA_DmaBuf;
                        d.flags = spa_sys::SPA_DATA_FLAG_READWRITE;
                        d.fd = plane.fd.as_raw_fd() as i64;
                        d.mapoffset = 0;
                        d.maxsize = plane.stride * height;
                        d.data = ptr::null_mut();
                        set_chunk(&mut *d.chunk, plane.offset, plane.stride, plane.stride * height, true);
                    }
                    (*buffer).user_data = Box::into_raw(Box::new(target)).cast();
                }
                Err(error) => tracing::warn!("壁纸流 {} 分配 dmabuf 缓冲失败: {error}", inner.props.node_name),
            }
        }
        Mode::Shm { width, height } => {
            let d = &mut *datas;
            let size = width as usize * 4 * height as usize;
            let name = CString::new("kabegame-wallpaper").unwrap();
            let fd = libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING);
            if fd < 0 {
                tracing::warn!("壁纸流 {} memfd_create 失败", inner.props.node_name);
                return;
            }
            if libc::ftruncate(fd, size as libc::off_t) < 0 {
                libc::close(fd);
                return;
            }
            libc::fcntl(
                fd,
                libc::F_ADD_SEALS,
                libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL,
            );
            let map = libc::mmap(
                ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            );
            if map == libc::MAP_FAILED {
                libc::close(fd);
                return;
            }
            d.type_ = spa_sys::SPA_DATA_MemFd;
            d.flags = spa_sys::SPA_DATA_FLAG_READWRITE | SPA_DATA_FLAG_MAPPABLE;
            d.fd = fd as i64;
            d.mapoffset = 0;
            d.maxsize = size as u32;
            d.data = map;
        }
    }
}

unsafe extern "C" fn on_remove_buffer(_data: *mut c_void, buffer: *mut pw_sys::pw_buffer) {
    let spa_buffer = (*buffer).buffer;
    let target = (*buffer).user_data.cast::<GpuTarget>();
    if !target.is_null() {
        // dmabuf：GL 对象与 GBM 缓冲随 GpuTarget 释放，fd 由它关闭
        (*buffer).user_data = ptr::null_mut();
        drop(Box::from_raw(target));
        if !spa_buffer.is_null() {
            for index in 0..(*spa_buffer).n_datas as usize {
                (*(*spa_buffer).datas.add(index)).fd = -1;
            }
        }
        return;
    }
    if spa_buffer.is_null() || (*spa_buffer).n_datas < 1 {
        return;
    }
    let d = &mut *(*spa_buffer).datas;
    if d.type_ == spa_sys::SPA_DATA_MemFd {
        if !d.data.is_null() {
            libc::munmap(d.data, d.maxsize as usize);
            d.data = ptr::null_mut();
        }
        if d.fd >= 0 {
            libc::close(d.fd as i32);
            d.fd = -1;
        }
    }
}
