//! WASAPI 共享模式回环采集：专用线程读默认输出设备（`eRender` / `eConsole`）的混音，每 33ms 产出一帧频谱。
//!
//! 推送定时器与采集包解耦：系统静音时回环不送包，包带 `AUDCLNT_BUFFERFLAGS_SILENT` 或这段时间没有包都按静音补零，
//! 页面照常收到逐帧衰减到 0 的数据，它的「空闲」判断才会生效。打不开设备（没有输出设备等）也照样推静音帧。
//! 默认设备变化靠每秒比对设备 id 发现（不实现 `IMMNotificationClient`），设备失效（`AUDCLNT_E_DEVICE_INVALIDATED`）
//! 立即重开。逐帧路径不打日志。

use super::spectrum::{Spectrum, BANDS};
use super::ComGuard;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::{GUID, PWSTR};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

const FRAME_INTERVAL: Duration = Duration::from_micros(33_333);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(1);
/// 共享模式缓冲时长（100ns 单位）：1 秒，轮询间隔远小于它，不会丢包。
const BUFFER_DURATION: i64 = 10_000_000;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

/// 运行中的回环采集；丢弃即停止。
pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AudioCapture {
    pub fn start(on_frame: impl Fn([f32; BANDS * 2]) + Send + 'static) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::Builder::new()
            .name("kabegame-wpe-audio".to_string())
            .spawn({
                let stop = stop.clone();
                move || run(&stop, &on_frame)
            })
            .map_err(|error| tracing::warn!("启动网页壁纸音频采集线程失败: {error}"))
            .ok();
        Self { stop, thread }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            // 采集线程自己触发的停止（广播时发现订阅全没了）不能 join 自己：置了标志，它会自行退出
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

fn run(stop: &AtomicBool, on_frame: &dyn Fn([f32; BANDS * 2])) {
    let _com = ComGuard::init();
    let enumerator: Option<IMMDeviceEnumerator> =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(enumerator) => Some(enumerator),
            Err(error) => {
                tracing::warn!("创建音频设备枚举器失败，网页壁纸音频按静音处理: {error}");
                None
            }
        };
    let mut stream: Option<LoopbackStream> = None;
    let mut sample_rate = 48_000;
    let mut spectrum = Spectrum::new(sample_rate);
    // 本帧周期内实际收到的样本帧数，不够的按静音补
    let mut received = 0usize;
    let mut open_failed = false;
    let mut next_frame = Instant::now();
    let mut next_device_check = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if let Some(enumerator) = &enumerator {
            if now >= next_device_check {
                next_device_check = now + DEVICE_CHECK_INTERVAL;
                let current = default_device_id(enumerator);
                let stale = match &stream {
                    Some(open) => current.as_deref() != Some(open.device_id.as_str()),
                    None => true,
                };
                if stale {
                    stream = None;
                    match LoopbackStream::open(enumerator) {
                        Ok(open) => {
                            tracing::info!(
                                sample_rate = open.sample_rate,
                                channels = open.channels,
                                "网页壁纸音频回环已打开"
                            );
                            if open.sample_rate != sample_rate {
                                sample_rate = open.sample_rate;
                                spectrum = Spectrum::new(sample_rate);
                            }
                            open_failed = false;
                            stream = Some(open);
                        }
                        Err(error) => {
                            if !open_failed {
                                tracing::warn!("打开音频回环失败，网页壁纸音频按静音处理: {error}");
                                open_failed = true;
                            }
                        }
                    }
                }
            }
        }
        if let Some(open) = &mut stream {
            match open.read(&mut spectrum) {
                Ok(frames) => received += frames,
                Err(error) => {
                    tracing::debug!("音频回环读取失败，稍后重开: {error}");
                    stream = None;
                    next_device_check = now;
                }
            }
        }
        if now >= next_frame {
            let expected = (sample_rate as f32 * FRAME_INTERVAL.as_secs_f32()) as usize;
            if received < expected {
                spectrum.push_silence(expected - received);
            }
            received = 0;
            on_frame(spectrum.frame());
            next_frame += FRAME_INTERVAL;
            // 落后太多（睡眠唤醒、线程被挂起）不补帧
            if next_frame < now {
                next_frame = now + FRAME_INTERVAL;
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn default_device_id(enumerator: &IMMDeviceEnumerator) -> Option<String> {
    unsafe {
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        device.GetId().ok().map(|id| take_pwstr(id))
    }
}

/// 取出 COM 分配的字符串并释放。
unsafe fn take_pwstr(value: PWSTR) -> String {
    let text = value.to_string().unwrap_or_default();
    CoTaskMemFree(Some(value.0 as *const _));
    text
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SampleFormat {
    F32,
    I16,
    /// 其它格式按静音处理（打开时记一次 warn）
    Unsupported,
}

/// 一条打开的回环流。
struct LoopbackStream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    device_id: String,
    sample_rate: u32,
    channels: usize,
    format: SampleFormat,
    /// 16 位样本转浮点的缓冲
    scratch: Vec<f32>,
}

impl LoopbackStream {
    fn open(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<Self> {
        unsafe {
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let device_id = take_pwstr(device.GetId()?);
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let mix = client.GetMixFormat()?;
            let (sample_rate, channels, format) = describe(mix);
            let initialized = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                BUFFER_DURATION,
                0,
                mix,
                None,
            );
            CoTaskMemFree(Some(mix as *const _));
            initialized?;
            let capture: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            if format == SampleFormat::Unsupported {
                tracing::warn!(
                    "音频混音格式不受支持（只处理 32 位浮点与 16 位整数），网页壁纸音频按静音处理"
                );
            }
            Ok(Self {
                client,
                capture,
                device_id,
                sample_rate,
                channels,
                format,
                scratch: Vec::new(),
            })
        }
    }

    /// 读完当前所有包喂给频谱，返回读到的样本帧数（静音包也算）。
    fn read(&mut self, spectrum: &mut Spectrum) -> windows::core::Result<usize> {
        let mut total = 0;
        unsafe {
            while self.capture.GetNextPacketSize()? > 0 {
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let count = frames as usize;
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                if silent || data.is_null() || self.channels == 0 {
                    spectrum.push_silence(count);
                } else {
                    let len = count * self.channels;
                    match self.format {
                        SampleFormat::F32 => {
                            let samples = std::slice::from_raw_parts(data as *const f32, len);
                            spectrum.push(samples, self.channels);
                        }
                        SampleFormat::I16 => {
                            let samples = std::slice::from_raw_parts(data as *const i16, len);
                            self.scratch.clear();
                            self.scratch
                                .extend(samples.iter().map(|v| *v as f32 / 32_768.0));
                            spectrum.push(&self.scratch, self.channels);
                        }
                        SampleFormat::Unsupported => spectrum.push_silence(count),
                    }
                }
                self.capture.ReleaseBuffer(frames)?;
                total += count;
            }
        }
        Ok(total)
    }
}

impl Drop for LoopbackStream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

/// 混音格式：采样率、声道数、样本类型。结构体是 `packed(1)`，一律按值不对齐读取。
unsafe fn describe(format: *const WAVEFORMATEX) -> (u32, usize, SampleFormat) {
    let base = std::ptr::read_unaligned(format);
    let tag = if base.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        let extensible = std::ptr::read_unaligned(format as *const WAVEFORMATEXTENSIBLE);
        let sub_format = extensible.SubFormat;
        if sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            WAVE_FORMAT_IEEE_FLOAT
        } else if sub_format == KSDATAFORMAT_SUBTYPE_PCM {
            WAVE_FORMAT_PCM
        } else {
            0
        }
    } else {
        base.wFormatTag
    };
    let sample_format = match (tag, base.wBitsPerSample) {
        (WAVE_FORMAT_IEEE_FLOAT, 32) => SampleFormat::F32,
        (WAVE_FORMAT_PCM, 16) => SampleFormat::I16,
        _ => SampleFormat::Unsupported,
    };
    (base.nSamplesPerSec, base.nChannels as usize, sample_format)
}
