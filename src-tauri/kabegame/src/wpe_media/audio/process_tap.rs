//! macOS 系统音频回环：Core Audio 进程 tap（macOS 14.2+）。推帧循环在 `mod.rs`。
//!
//! - **tap**：`CATapDescription` 的「全局立体声、不排除任何进程」（`initStereoGlobalTapButExcludeProcesses:@[]`），即整个
//!   系统混音下混成立体声，同 Windows 的回环；`muteBehavior` 保持缺省（不静音原输出）。
//! - **读取**：tap 不能直接读，要挂进一个私有聚合设备（只放 tap、不放子设备：放了输出设备做时钟的话，带麦克风的耳机会
//!   连麦克风一起开）。聚合设备的 IOProc 跑在 Core Audio 的实时线程上，只把输入缓冲拷进预留好容量的共享缓冲
//!   （`try_lock`，拿不到锁或满了就丢，不分配内存）；采集线程每轮把它整个换出来喂给两份频谱。
//! - **权限**：第一次启动聚合设备时系统弹「录制系统音频」授权（`NSAudioCaptureUsageDescription`，见
//!   `macos/embedded-Info.plist`），拒绝时 tap 只送静音，按静音处理。权限记在负责进程名下：dev 从终端拉起时是终端 / VS Code。
//! - **可用性**：最低系统版本是 11，两个 14.2 才有的函数用 `dlsym` 取、`CATapDescription` 按类名找，取不到时打开报错，
//!   采集线程照样推静音帧。
//! - **设备变化**：全局 tap 跟随系统混音，不绑输出设备；仍按默认输出设备的 id 判断要不要重开，换设备后采样率可能变。

use super::super::spectrum::Spectrum;
use super::super::wpe_spectrum::Spectrum as WpeSpectrum;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use objc2::msg_send;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::{NSArray, NSString};
use std::ffi::{c_char, c_void, CStr};
use std::sync::{Arc, Mutex, OnceLock};

type OsStatus = i32;
type AudioObjectId = u32;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

/// `AudioStreamBasicDescription`
#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    byte_size: u32,
    data: *mut c_void,
}

/// `AudioBufferList`：`buffers` 是变长数组，实际有 `count` 个。
#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 1],
}

const fn fourcc(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const SYSTEM_OBJECT: AudioObjectId = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const ELEMENT_MAIN: u32 = 0;
const DEFAULT_OUTPUT_DEVICE: u32 = fourcc(b"dOut");
/// `kAudioTapPropertyFormat`
const TAP_FORMAT: u32 = fourcc(b"tfmt");
const FORMAT_LINEAR_PCM: u32 = fourcc(b"lpcm");
const FLAG_IS_FLOAT: u32 = 1;
const FLAG_NON_INTERLEAVED: u32 = 1 << 5;

type IoProc = unsafe extern "C" fn(
    device: AudioObjectId,
    now: *const c_void,
    input: *const AudioBufferList,
    input_time: *const c_void,
    output: *mut AudioBufferList,
    output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: CFDictionaryRef,
        device: *mut AudioObjectId,
    ) -> OsStatus;
    fn AudioHardwareDestroyAggregateDevice(device: AudioObjectId) -> OsStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectId,
        proc: IoProc,
        client: *mut c_void,
        proc_id: *mut *mut c_void,
    ) -> OsStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectId, proc_id: *mut c_void) -> OsStatus;
    fn AudioDeviceStart(device: AudioObjectId, proc_id: *mut c_void) -> OsStatus;
    fn AudioDeviceStop(device: AudioObjectId, proc_id: *mut c_void) -> OsStatus;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// `RTLD_DEFAULT`（`<dlfcn.h>`：`((void *) -2)`）
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

type CreateProcessTap = unsafe extern "C" fn(*mut AnyObject, *mut AudioObjectId) -> OsStatus;
type DestroyProcessTap = unsafe extern "C" fn(AudioObjectId) -> OsStatus;

/// macOS 14.2 才有的接口：两个函数与 `CATapDescription` 类。
struct TapApi {
    create: CreateProcessTap,
    destroy: DestroyProcessTap,
    description: &'static AnyClass,
}

fn tap_api() -> Option<&'static TapApi> {
    static API: OnceLock<Option<TapApi>> = OnceLock::new();
    API.get_or_init(|| {
        let symbol = |name: &CStr| {
            let ptr = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
            (!ptr.is_null()).then_some(ptr)
        };
        let create = symbol(c"AudioHardwareCreateProcessTap")?;
        let destroy = symbol(c"AudioHardwareDestroyProcessTap")?;
        let description = AnyClass::get(c"CATapDescription")?;
        Some(TapApi {
            create: unsafe { std::mem::transmute::<*mut c_void, CreateProcessTap>(create) },
            destroy: unsafe { std::mem::transmute::<*mut c_void, DestroyProcessTap>(destroy) },
            description,
        })
    })
    .as_ref()
}

fn check(status: OsStatus, what: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("{what} 失败（OSStatus {status}）"))
    }
}

/// 读一个定长属性（全局域、主元素）。
fn property<T: Default>(object: AudioObjectId, selector: u32) -> Result<T, OsStatus> {
    let address = PropertyAddress {
        selector,
        scope: SCOPE_GLOBAL,
        element: ELEMENT_MAIN,
    };
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut T).cast(),
        )
    };
    if status == 0 {
        Ok(value)
    } else {
        Err(status)
    }
}

/// 回环在 macOS 上没有要跨轮持有的设备对象；只按默认输出设备判断要不要重开。
pub(super) struct Devices;

impl Devices {
    pub(super) fn new() -> Option<Self> {
        Some(Self)
    }

    /// 当前默认输出设备的 `AudioObjectID`；没有输出设备时 `None`。
    pub(super) fn default_id(&self) -> Option<String> {
        property::<AudioObjectId>(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE)
            .ok()
            .filter(|id| *id != 0)
            .map(|id| id.to_string())
    }

    pub(super) fn open(&self) -> Result<LoopbackStream, String> {
        LoopbackStream::open(self.default_id().unwrap_or_default())
    }
}

/// tap 的样本布局：声道数与是否交错；只收 32 位浮点线性 PCM。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Layout {
    channels: usize,
    interleaved: bool,
}

impl Layout {
    fn of(format: &StreamDescription) -> Result<Self, String> {
        let float = format.format_id == FORMAT_LINEAR_PCM
            && format.format_flags & FLAG_IS_FLOAT != 0
            && format.bits_per_channel == 32;
        if !float || format.channels_per_frame == 0 {
            return Err(format!("tap 格式不受支持（只处理 32 位浮点）：{format:?}"));
        }
        Ok(Self {
            channels: format.channels_per_frame as usize,
            interleaved: format.format_flags & FLAG_NON_INTERLEAVED == 0,
        })
    }

    /// 把一次 IOProc 的输入（tap 的流排在缓冲列表末尾）按交错顺序追加进 `out`；`out` 放不下时整段丢弃、不扩容。
    /// 返回追加的样本帧数。
    fn append(&self, buffers: &[AudioBuffer], out: &mut Vec<f32>) -> usize {
        let float = std::mem::size_of::<f32>();
        if self.interleaved {
            let Some(buffer) = buffers.last() else {
                return 0;
            };
            if buffer.data.is_null() || buffer.channels as usize != self.channels {
                return 0;
            }
            let len = buffer.byte_size as usize / float / self.channels * self.channels;
            if out.len() + len > out.capacity() {
                return 0;
            }
            let samples = unsafe { std::slice::from_raw_parts(buffer.data as *const f32, len) };
            out.extend_from_slice(samples);
            len / self.channels
        } else {
            if buffers.len() < self.channels {
                return 0;
            }
            let planes = &buffers[buffers.len() - self.channels..];
            if planes.iter().any(|b| b.data.is_null() || b.channels != 1) {
                return 0;
            }
            let frames = planes
                .iter()
                .map(|b| b.byte_size as usize / float)
                .min()
                .unwrap_or(0);
            if out.len() + frames * self.channels > out.capacity() {
                return 0;
            }
            for frame in 0..frames {
                for plane in planes {
                    let sample = unsafe { *(plane.data as *const f32).add(frame) };
                    out.push(sample);
                }
            }
            frames
        }
    }
}

/// IOProc 与采集线程之间的缓冲。
struct Shared {
    layout: Layout,
    pending: Mutex<Pending>,
}

struct Pending {
    /// 交错样本；容量在打开时一次预留（1 秒），实时线程只往里追加、不扩容。
    samples: Vec<f32>,
    /// 自上次取走以来 IOProc 被调了几次
    packets: usize,
}

/// 聚合设备的 IOProc：实时线程，不分配内存、不阻塞。
unsafe extern "C" fn io_proc(
    _device: AudioObjectId,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    _output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus {
    let shared = &*(client as *const Shared);
    let Ok(mut pending) = shared.pending.try_lock() else {
        return 0;
    };
    pending.packets += 1;
    if !input.is_null() {
        let list = &*input;
        let buffers = std::slice::from_raw_parts(list.buffers.as_ptr(), list.count as usize);
        shared.layout.append(buffers, &mut pending.samples);
    }
    0
}

struct Tap(AudioObjectId);

impl Drop for Tap {
    fn drop(&mut self) {
        if let Some(api) = tap_api() {
            unsafe { (api.destroy)(self.0) };
        }
    }
}

struct Aggregate(AudioObjectId);

impl Drop for Aggregate {
    fn drop(&mut self) {
        unsafe { AudioHardwareDestroyAggregateDevice(self.0) };
    }
}

/// 已登记的 IOProc；析构时停止、注销，再放掉交给它的 `Shared` 引用。
struct Proc {
    device: AudioObjectId,
    id: *mut c_void,
    client: *const Shared,
}

impl Drop for Proc {
    fn drop(&mut self) {
        unsafe {
            AudioDeviceStop(self.device, self.id);
            AudioDeviceDestroyIOProcID(self.device, self.id);
            drop(Arc::from_raw(self.client));
        }
    }
}

/// 一条打开的回环流。
pub(super) struct LoopbackStream {
    // 字段按声明顺序析构：先停 IOProc，再拆聚合设备，最后销毁 tap
    _proc: Proc,
    _aggregate: Aggregate,
    _tap: Tap,
    shared: Arc<Shared>,
    /// 与 `Pending::samples` 等容量，换出来处理
    scratch: Vec<f32>,
    pub(super) device_id: String,
    pub(super) sample_rate: u32,
    pub(super) channels: usize,
}

impl LoopbackStream {
    fn open(device_id: String) -> Result<Self, String> {
        let api = tap_api().ok_or("系统音频回环需要 macOS 14.2 或更高版本")?;
        let description = new_tap_description(api.description)?;
        let tap_uuid = tap_uuid(&description)?;
        let mut tap = 0;
        check(
            unsafe { (api.create)(Retained::as_ptr(&description) as *mut AnyObject, &mut tap) },
            "创建系统音频 tap",
        )?;
        let tap = Tap(tap);
        let format: StreamDescription = property(tap.0, TAP_FORMAT)
            .map_err(|status| format!("读 tap 格式失败（OSStatus {status}）"))?;
        let layout = Layout::of(&format)?;
        let sample_rate = format.sample_rate.round() as u32;
        if sample_rate == 0 {
            return Err(format!("tap 采样率无效：{format:?}"));
        }

        let aggregate = {
            let dict = aggregate_description(&tap_uuid);
            let mut device = 0;
            check(
                unsafe {
                    AudioHardwareCreateAggregateDevice(dict.as_concrete_TypeRef(), &mut device)
                },
                "创建回环聚合设备",
            )?;
            Aggregate(device)
        };

        let capacity = sample_rate as usize * layout.channels;
        let shared = Arc::new(Shared {
            layout,
            pending: Mutex::new(Pending {
                samples: Vec::with_capacity(capacity),
                packets: 0,
            }),
        });
        let client = Arc::into_raw(shared.clone());
        let mut proc_id = std::ptr::null_mut();
        let status = unsafe {
            AudioDeviceCreateIOProcID(aggregate.0, io_proc, client as *mut c_void, &mut proc_id)
        };
        if let Err(error) = check(status, "登记回环 IOProc") {
            unsafe { drop(Arc::from_raw(client)) };
            return Err(error);
        }
        let proc = Proc {
            device: aggregate.0,
            id: proc_id,
            client,
        };
        check(
            unsafe { AudioDeviceStart(aggregate.0, proc_id) },
            "启动回环聚合设备",
        )?;
        Ok(Self {
            _proc: proc,
            _aggregate: aggregate,
            _tap: tap,
            shared,
            scratch: Vec::with_capacity(capacity),
            device_id,
            sample_rate,
            channels: layout.channels,
        })
    }

    /// 取走 IOProc 攒下的样本喂给两份频谱，返回样本帧数与 IOProc 调用次数。静音时 tap 送的是全 0 样本，照常喂。
    pub(super) fn read(
        &mut self,
        spectrum: &mut Spectrum,
        wpe: &mut WpeSpectrum,
    ) -> Result<(usize, usize), String> {
        let packets = {
            let mut pending = self
                .shared
                .pending
                .lock()
                .map_err(|_| "回环缓冲锁中毒".to_string())?;
            // 换出等容量的空缓冲：实时线程继续往里追加不会扩容
            std::mem::swap(&mut pending.samples, &mut self.scratch);
            std::mem::take(&mut pending.packets)
        };
        let frames = self.scratch.len() / self.channels;
        if frames > 0 {
            spectrum.push(&self.scratch, self.channels);
            wpe.push(&self.scratch, self.channels);
        }
        self.scratch.clear();
        Ok((frames, packets))
    }
}

/// `[[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]]`
fn new_tap_description(class: &AnyClass) -> Result<Retained<AnyObject>, String> {
    let excluded = NSArray::<AnyObject>::new();
    let allocated: Allocated<AnyObject> = unsafe { msg_send![class, alloc] };
    let description: Option<Retained<AnyObject>> =
        unsafe { msg_send![allocated, initStereoGlobalTapButExcludeProcesses: &*excluded] };
    let description = description.ok_or("创建 CATapDescription 失败")?;
    let name = NSString::from_str("Kabegame wallpaper audio");
    let _: () = unsafe { msg_send![&description, setName: &*name] };
    Ok(description)
}

/// tap 的 `UUID.UUIDString`：聚合设备按它找 tap。
fn tap_uuid(description: &AnyObject) -> Result<String, String> {
    let uuid: Option<Retained<AnyObject>> = unsafe { msg_send![description, UUID] };
    let uuid = uuid.ok_or("CATapDescription 没有 UUID")?;
    let text: Option<Retained<NSString>> = unsafe { msg_send![&uuid, UUIDString] };
    Ok(text
        .ok_or("CATapDescription 的 UUID 取不出字符串")?
        .to_string())
}

/// 私有聚合设备的描述：只放 tap，tap 随设备启动（键名见 `<CoreAudio/AudioHardware.h>` 的
/// `kAudioAggregateDevice*Key` / `kAudioSubTap*Key`）。
fn aggregate_description(tap_uuid: &str) -> CFDictionary<CFString, CFType> {
    let tap = CFDictionary::from_CFType_pairs(&[(
        CFString::from_static_string("uid"),
        CFString::new(tap_uuid).as_CFType(),
    )]);
    let taps = CFArray::from_CFTypes(&[tap]);
    let pairs: [(CFString, CFType); 6] = [
        (
            CFString::from_static_string("name"),
            CFString::from_static_string("Kabegame Loopback").as_CFType(),
        ),
        (
            CFString::from_static_string("uid"),
            CFString::new(&format!("app.kabegame.loopback.{tap_uuid}")).as_CFType(),
        ),
        (
            CFString::from_static_string("private"),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            CFString::from_static_string("stacked"),
            CFBoolean::false_value().as_CFType(),
        ),
        (
            CFString::from_static_string("tapautostart"),
            CFBoolean::true_value().as_CFType(),
        ),
        (CFString::from_static_string("taps"), taps.as_CFType()),
    ];
    CFDictionary::from_CFType_pairs(&pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn float_format(channels: u32, non_interleaved: bool) -> StreamDescription {
        StreamDescription {
            sample_rate: 48_000.0,
            format_id: FORMAT_LINEAR_PCM,
            format_flags: FLAG_IS_FLOAT
                | if non_interleaved {
                    FLAG_NON_INTERLEAVED
                } else {
                    0
                },
            bits_per_channel: 32,
            channels_per_frame: channels,
            ..Default::default()
        }
    }

    fn buffer(channels: u32, samples: &mut [f32]) -> AudioBuffer {
        AudioBuffer {
            channels,
            byte_size: (samples.len() * 4) as u32,
            data: samples.as_mut_ptr().cast(),
        }
    }

    #[test]
    fn layout_accepts_only_32_bit_float_pcm() {
        assert_eq!(
            Layout::of(&float_format(2, false)),
            Ok(Layout {
                channels: 2,
                interleaved: true
            })
        );
        assert!(!Layout::of(&float_format(2, true)).unwrap().interleaved);
        let mut int16 = float_format(2, false);
        int16.format_flags = 4;
        int16.bits_per_channel = 16;
        assert!(Layout::of(&int16).is_err());
        assert!(Layout::of(&float_format(0, false)).is_err());
    }

    #[test]
    fn interleaved_input_takes_the_last_buffer() {
        let layout = Layout::of(&float_format(2, false)).unwrap();
        // 前面多一个（假想的子设备）流：只取末尾 tap 的那个
        let mut other = [9.0; 4];
        let mut tap = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
        let buffers = [buffer(2, &mut other), buffer(2, &mut tap)];
        let mut out = Vec::with_capacity(16);
        assert_eq!(layout.append(&buffers, &mut out), 3);
        assert_eq!(out, vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    }

    #[test]
    fn planar_input_is_interleaved_from_the_trailing_planes() {
        let layout = Layout::of(&float_format(2, true)).unwrap();
        let mut other = [9.0; 3];
        let mut left = [1.0, 2.0, 3.0];
        let mut right = [-1.0, -2.0, -3.0];
        let buffers = [
            buffer(1, &mut other),
            buffer(1, &mut left),
            buffer(1, &mut right),
        ];
        let mut out = Vec::with_capacity(16);
        assert_eq!(layout.append(&buffers, &mut out), 3);
        assert_eq!(out, vec![1.0, -1.0, 2.0, -2.0, 3.0, -3.0]);
    }

    #[test]
    fn full_buffer_drops_the_whole_callback_without_growing() {
        let layout = Layout::of(&float_format(2, false)).unwrap();
        let mut tap = [0.5; 8];
        let buffers = [buffer(2, &mut tap)];
        let mut out = Vec::with_capacity(6);
        let capacity = out.capacity();
        assert_eq!(layout.append(&buffers, &mut out), 0);
        assert!(out.is_empty());
        assert_eq!(out.capacity(), capacity);
    }

    #[test]
    fn mismatched_channel_count_is_ignored() {
        let layout = Layout::of(&float_format(2, false)).unwrap();
        let mut mono = [0.5; 4];
        let buffers = [buffer(1, &mut mono)];
        let mut out = Vec::with_capacity(16);
        assert_eq!(layout.append(&buffers, &mut out), 0);
    }
}
