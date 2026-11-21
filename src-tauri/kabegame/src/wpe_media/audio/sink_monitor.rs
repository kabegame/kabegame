//! Linux 系统音频回环：PipeWire 采集默认输出设备的监听端口（monitor）。推帧循环在 `mod.rs`。
//!
//! - **流**：一条 `Stream/Input/Audio` 流，`stream.capture.sink = true`、不指定目标，由会话管理器（WirePlumber）链到默认
//!   输出设备的 monitor 端口，即系统混音，同 Windows 的回环。默认设备换了会话管理器自己把流重链过去（2026-11-21 实测），
//!   所以这里不盯默认设备：`default_id` 恒为同一个值，只在出错时重开。
//! - **格式**：要 32 位浮点、立体声（FL / FR），采样率不指定、跟图的采样率。多声道设备由 PipeWire 下混，同 macOS 的立体声
//!   tap（两份频谱都只取前两个声道）。协商出的采样率与打开时报的不同（打开时没等到协商、或重链到别的采样率），读的时候
//!   报错重开。
//! - **passive**：`node.passive = true`，这条链接不让输出设备保持运行：没有声音时设备照常挂起、回调不来，按「没有包」处理
//!   （网页壁纸补零衰减、WPE 原始频谱 1 s 后清零）；有声音时数据照常来（2026-11-21 实测：空闲时一帧都没有，放 3 s 正弦波
//!   收满 3 s）。不加的话只要开着订阅，输出设备就一直不挂起。
//! - **线程**：不另起线程，也不要实时回调。主循环挂在采集线程上，`read` 每轮非阻塞地跑一次，`process` 回调就在这里把样本
//!   攒进缓冲、同一轮取走。PipeWire 对象都不跨线程。
//! - **连不上**（系统只有 PulseAudio、没有 PipeWire）：打开报错，采集线程照样推静音帧，每秒重试。
//! - Plasma 把录音流一律当成「麦克风在用」（plasma-pa 只跳过没有客户端的流，不区分监听，KDE bug 410637）：有音频订阅期间
//!   托盘有麦克风指示，没有正当办法避开。

use super::super::spectrum::Spectrum;
use super::super::wpe_spectrum::Spectrum as WpeSpectrum;
use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use pw::stream::{StreamFlags, StreamState};
use spa::param::audio::{AudioFormat, AudioInfoRaw};
use spa::param::format::{MediaSubtype, MediaType};
use spa::param::format_utils;
use spa::param::ParamType;
use spa::pod::serialize::PodSerializer;
use spa::pod::{Object, Pod, Value};
use spa::utils::{Direction, SpaTypes};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// 打开时等格式协商的上限。输出设备在跑时几毫秒就协商完（2026-11-21 实测 6 ms）；设备挂起时 passive 链接要等它跑起来才
/// 协商，等不到。等不到就先按 [`FALLBACK_RATE`] 报，协商出来不一样再重开。等待期间推帧循环停着，所以不能长。
const NEGOTIATE_TIMEOUT: Duration = Duration::from_millis(200);
/// 没等到协商时报的采样率：PipeWire 图的缺省 `default.clock.rate`。
const FALLBACK_RATE: u32 = 48_000;
/// 要的声道数（FL、FR）。
const CHANNELS: usize = 2;
const SAMPLE_BYTES: usize = std::mem::size_of::<f32>();
/// `read` 每轮最多跑几次非阻塞迭代：一次迭代处理当时就绪的全部事件，多跑几次是为了接上处理中途新到的。
const MAX_ITERATIONS: usize = 8;
/// `default_id` 的固定值：默认设备的变化由会话管理器重链，不靠重开。
const DEVICE_ID: &str = "pipewire:default-sink-monitor";

/// 回环在 Linux 上没有要跨轮持有的设备对象；连接放在每条流自己身上，出错时随流一起重建。
pub(super) struct Devices;

impl Devices {
    pub(super) fn new() -> Option<Self> {
        pw::init();
        Some(Self)
    }

    pub(super) fn default_id(&self) -> Option<String> {
        Some(DEVICE_ID.to_string())
    }

    pub(super) fn open(&self) -> Result<LoopbackStream, String> {
        LoopbackStream::open()
    }
}

/// 回调与 `read` 共用的状态。两边都在采集线程上（回调只在 `read` / `open` 迭代主循环时被调），用 `Rc<RefCell>`。
#[derive(Default)]
struct Shared {
    /// 交错的立体声样本
    samples: Vec<f32>,
    /// 自上次取走以来 `process` 拿到的缓冲数
    packets: usize,
    /// 协商出的采样率；还没协商时 `None`
    rate: Option<u32>,
    /// 流或连接出错的原因；有值就让 `read` 报错重开
    failed: Option<String>,
}

impl Shared {
    fn fail(&mut self, reason: String) {
        self.failed.get_or_insert(reason);
    }
}

/// 一条打开的回环流。
pub(super) struct LoopbackStream {
    // 字段按声明顺序析构：先摘监听、销毁流，再断开连接，最后销毁上下文与主循环
    _listener: pw::stream::StreamListener<()>,
    _stream: pw::stream::StreamRc,
    _core_listener: pw::core::Listener,
    _core: pw::core::CoreRc,
    _context: pw::context::ContextRc,
    main_loop: pw::main_loop::MainLoopRc,
    shared: Rc<RefCell<Shared>>,
    /// 换出来处理的样本
    scratch: Vec<f32>,
    pub(super) device_id: String,
    pub(super) sample_rate: u32,
    pub(super) channels: usize,
}

impl LoopbackStream {
    fn open() -> Result<Self, String> {
        let main_loop = pw::main_loop::MainLoopRc::new(None)
            .map_err(|error| format!("创建 PipeWire 主循环失败: {error}"))?;
        // 客户端名：pavucontrol 的录音页与 Plasma 的麦克风指示显示它
        let context = pw::context::ContextRc::new(
            &main_loop,
            Some(properties! { *pw::keys::APP_NAME => "Kabegame" }),
        )
        .map_err(|error| format!("创建 PipeWire 上下文失败: {error}"))?;
        let core = context
            .connect_rc(None)
            .map_err(|error| format!("连接 PipeWire 失败: {error}"))?;

        let shared = Rc::new(RefCell::new(Shared::default()));
        let core_listener = core
            .add_listener_local()
            .error({
                let shared = shared.clone();
                move |id, _seq, res, message| {
                    // 只认连接本身的错误（守护进程退出等）；别的对象的错误与这条流无关
                    if id == pw::core::PW_ID_CORE {
                        shared
                            .borrow_mut()
                            .fail(format!("PipeWire 连接出错（{res}）: {message}"));
                    }
                }
            })
            .register();

        let stream = pw::stream::StreamRc::new(
            core.clone(),
            "kabegame-wallpaper-audio",
            properties! {
                *pw::keys::MEDIA_TYPE => "Audio",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::STREAM_CAPTURE_SINK => "true",
                *pw::keys::NODE_PASSIVE => "true",
                *pw::keys::NODE_NAME => "kabegame-wallpaper-audio",
                *pw::keys::NODE_DESCRIPTION => "Kabegame wallpaper audio",
            },
        )
        .map_err(|error| format!("创建回环流失败: {error}"))?;

        let listener = stream
            .add_local_listener_with_user_data(())
            .param_changed({
                let shared = shared.clone();
                move |_, _, id, param| {
                    if id != ParamType::Format.as_raw() {
                        return;
                    }
                    // 格式被清掉（断开链接）时是 None：保留上次的采样率
                    if let Some(param) = param {
                        on_format(&mut shared.borrow_mut(), param);
                    }
                }
            })
            .state_changed({
                let shared = shared.clone();
                move |_, _, _, state| {
                    if let StreamState::Error(message) = state {
                        shared.borrow_mut().fail(format!("回环流出错: {message}"));
                    }
                }
            })
            .process({
                let shared = shared.clone();
                move |stream, _| drain(stream, &mut shared.borrow_mut())
            })
            .register()
            .map_err(|error| format!("登记回环流监听失败: {error}"))?;

        let format = format_param()?;
        let mut params = [Pod::from_bytes(&format).ok_or("回环格式参数无效")?];
        stream
            .connect(
                Direction::Input,
                None,
                StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
                &mut params,
            )
            .map_err(|error| format!("连接回环流失败: {error}"))?;

        // 等格式协商：调用方据采样率建频谱
        let deadline = Instant::now() + NEGOTIATE_TIMEOUT;
        loop {
            {
                let state = shared.borrow();
                if let Some(error) = &state.failed {
                    return Err(error.clone());
                }
                if state.rate.is_some() {
                    break;
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                tracing::debug!(
                    "音频回环 {} ms 内没协商出格式，先按 {FALLBACK_RATE} Hz",
                    NEGOTIATE_TIMEOUT.as_millis()
                );
                break;
            }
            main_loop
                .loop_()
                .iterate(pw::loop_::Timeout::Finite(left));
        }
        let sample_rate = shared.borrow().rate.unwrap_or(FALLBACK_RATE);

        Ok(Self {
            _listener: listener,
            _stream: stream,
            _core_listener: core_listener,
            _core: core,
            _context: context,
            main_loop,
            shared,
            scratch: Vec::new(),
            device_id: DEVICE_ID.to_string(),
            sample_rate,
            channels: CHANNELS,
        })
    }

    /// 跑一轮主循环，取走 `process` 攒下的样本喂给两份频谱，返回样本帧数与缓冲数。没有声音时输出设备挂起、一个缓冲都没有，
    /// 由推帧循环按静音处理。
    pub(super) fn read(
        &mut self,
        spectrum: &mut Spectrum,
        wpe: &mut WpeSpectrum,
    ) -> Result<(usize, usize), String> {
        for _ in 0..MAX_ITERATIONS {
            if self.main_loop.loop_().iterate(pw::loop_::Timeout::None) <= 0 {
                break;
            }
        }
        let packets = {
            let mut shared = self.shared.borrow_mut();
            if let Some(error) = shared.failed.take() {
                return Err(error);
            }
            if let Some(rate) = shared.rate {
                if rate != self.sample_rate {
                    return Err(format!(
                        "回环采样率变了：{} → {rate} Hz",
                        self.sample_rate
                    ));
                }
            }
            std::mem::swap(&mut shared.samples, &mut self.scratch);
            std::mem::take(&mut shared.packets)
        };
        let frames = self.scratch.len() / CHANNELS;
        if frames > 0 {
            spectrum.push(&self.scratch, CHANNELS);
            wpe.push(&self.scratch, CHANNELS);
        }
        self.scratch.clear();
        Ok((frames, packets))
    }
}

/// `EnumFormat`：32 位浮点、立体声 FL / FR，采样率不填（跟图）。
fn format_param() -> Result<Vec<u8>, String> {
    let mut info = AudioInfoRaw::new();
    info.set_format(AudioFormat::F32LE);
    info.set_channels(CHANNELS as u32);
    let mut position = [0; spa::sys::SPA_AUDIO_MAX_CHANNELS as usize];
    position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
    position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    info.set_position(position);
    let object = Object {
        type_: SpaTypes::ObjectParamFormat.as_raw(),
        id: ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &Value::Object(object))
        .map(|(cursor, _)| cursor.into_inner())
        .map_err(|error| format!("序列化回环格式失败: {error:?}"))
}

/// 协商定型的格式：只收要的那一种，别的当出错（重开）。
fn on_format(shared: &mut Shared, param: &Pod) {
    let Ok((media_type, media_subtype)) = format_utils::parse_format(param) else {
        return;
    };
    if media_type != MediaType::Audio || media_subtype != MediaSubtype::Raw {
        return;
    }
    let mut info = AudioInfoRaw::new();
    if info.parse(param).is_err() {
        return;
    }
    if info.format() != AudioFormat::F32LE || info.channels() as usize != CHANNELS || info.rate() == 0
    {
        shared.fail(format!(
            "回环协商出的格式不对：{:?}、{} 声道、{} Hz",
            info.format(),
            info.channels(),
            info.rate()
        ));
        return;
    }
    shared.rate = Some(info.rate());
}

/// `process`：取出全部排队的缓冲，样本追加到共享缓冲（缓冲在析构时还给流）。
fn drain(stream: &pw::stream::Stream, shared: &mut Shared) {
    while let Some(mut buffer) = stream.dequeue_buffer() {
        shared.packets += 1;
        let Some(data) = buffer.datas_mut().first_mut() else {
            continue;
        };
        let offset = data.chunk().offset() as usize;
        let size = data.chunk().size() as usize;
        let Some(bytes) = data.data() else {
            continue;
        };
        append_samples(bytes, offset, size, &mut shared.samples);
    }
}

/// 把一个缓冲里有效区间（`offset`、`size`，越界的截掉）的小端 f32 样本追加进 `out`，只取整帧。
fn append_samples(bytes: &[u8], offset: usize, size: usize, out: &mut Vec<f32>) {
    let end = offset.saturating_add(size).min(bytes.len());
    let start = offset.min(end);
    let valid = &bytes[start..end];
    let frame_bytes = SAMPLE_BYTES * CHANNELS;
    let whole = valid.len() / frame_bytes * frame_bytes;
    out.extend(
        valid[..whole]
            .chunks_exact(SAMPLE_BYTES)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_of(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn appends_whole_frames_from_the_valid_range() {
        let bytes = bytes_of(&[9.0, 9.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
        let mut out = Vec::new();
        // 从第 2 个样本起、5 个样本：只取两整帧，落单的第 5 个丢掉
        append_samples(&bytes, 2 * SAMPLE_BYTES, 5 * SAMPLE_BYTES, &mut out);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn out_of_range_chunk_is_clamped() {
        let bytes = bytes_of(&[1.0, 2.0, 3.0, 4.0]);
        let mut out = Vec::new();
        append_samples(&bytes, 2 * SAMPLE_BYTES, 100, &mut out);
        assert_eq!(out, [3.0, 4.0]);
        out.clear();
        append_samples(&bytes, 100, 8, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn format_param_asks_for_stereo_float_without_rate() {
        let bytes = format_param().unwrap();
        let pod = Pod::from_bytes(&bytes).unwrap();
        let mut info = AudioInfoRaw::new();
        info.parse(pod).unwrap();
        assert_eq!(info.format(), AudioFormat::F32LE);
        assert_eq!(info.channels(), 2);
        assert_eq!(info.rate(), 0);
        assert_eq!(info.position()[0], spa::sys::SPA_AUDIO_CHANNEL_FL);
        assert_eq!(info.position()[1], spa::sys::SPA_AUDIO_CHANNEL_FR);
    }
}
