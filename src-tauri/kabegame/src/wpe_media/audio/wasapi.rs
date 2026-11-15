//! WASAPI 共享模式回环采集：读默认输出设备（`eRender` / `eConsole`）的混音。推帧循环在 `mod.rs`。
//!
//! 包带 `AUDCLNT_BUFFERFLAGS_SILENT`、空数据或不支持的格式时，网页壁纸的频谱按静音补零，WPE 原始频谱立即清零。
//! 默认设备变化靠循环每秒比对设备 id 发现（不实现 `IMMNotificationClient`），设备失效（`AUDCLNT_E_DEVICE_INVALIDATED`）
//! 表现为读取失败、立即重开。

use super::super::spectrum::Spectrum;
use super::super::wpe_spectrum::Spectrum as WpeSpectrum;
use super::super::ComGuard;
use windows::core::{GUID, PWSTR};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

/// 共享模式缓冲时长（100ns 单位）：1 秒，轮询间隔远小于它，不会丢包。
const BUFFER_DURATION: i64 = 10_000_000;

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

/// 采集线程上的设备枚举器；持有本线程的 COM 初始化（MTA）。
pub(super) struct Devices {
    // 字段按声明顺序析构：枚举器先于 COM 反初始化
    enumerator: IMMDeviceEnumerator,
    _com: ComGuard,
}

impl Devices {
    /// 创建失败（记一次 warn）时返回 `None`，采集线程照样推静音帧。
    pub(super) fn new() -> Option<Self> {
        let com = ComGuard::init();
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(enumerator) => Some(Self {
                enumerator,
                _com: com,
            }),
            Err(error) => {
                tracing::warn!("创建音频设备枚举器失败，网页壁纸音频按静音处理: {error}");
                None
            }
        }
    }

    /// 当前默认输出设备的 id；没有时 `None`。
    pub(super) fn default_id(&self) -> Option<String> {
        default_device_id(&self.enumerator)
    }

    pub(super) fn open(&self) -> windows::core::Result<LoopbackStream> {
        LoopbackStream::open(&self.enumerator)
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
pub(super) struct LoopbackStream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    pub(super) device_id: String,
    pub(super) sample_rate: u32,
    pub(super) channels: usize,
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

    /// 读完当前所有包喂给两份频谱，返回读到的样本帧数与包数（静音包都算）。网页壁纸的频谱把静音包、空数据与不支持的格式按静音补零；
    /// WPE 原始频谱让它们立即清零。
    pub(super) fn read(
        &mut self,
        spectrum: &mut Spectrum,
        wpe: &mut WpeSpectrum,
    ) -> windows::core::Result<(usize, usize)> {
        let mut total = 0;
        let mut packets = 0;
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
                    wpe.silent();
                } else {
                    let len = count * self.channels;
                    match self.format {
                        SampleFormat::F32 => {
                            let samples = std::slice::from_raw_parts(data as *const f32, len);
                            spectrum.push(samples, self.channels);
                            wpe.push(samples, self.channels);
                        }
                        SampleFormat::I16 => {
                            let samples = std::slice::from_raw_parts(data as *const i16, len);
                            self.scratch.clear();
                            self.scratch
                                .extend(samples.iter().map(|v| *v as f32 / 32_768.0));
                            spectrum.push(&self.scratch, self.channels);
                            wpe.push(&self.scratch, self.channels);
                        }
                        SampleFormat::Unsupported => {
                            spectrum.push_silence(count);
                            wpe.silent();
                        }
                    }
                }
                self.capture.ReleaseBuffer(frames)?;
                total += count;
                packets += 1;
            }
        }
        Ok((total, packets))
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
