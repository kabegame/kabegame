//! 系统音频回环采集：专用线程读默认输出设备的混音，每 33ms 产出一帧频谱。平台只提供「设备 + 回环流」：
//! Windows 是 WASAPI 共享模式回环（`wasapi.rs`），macOS 是 Core Audio 进程 tap（`process_tap.rs`，14.2+），Linux 是 PipeWire 的
//! 默认输出设备监听（`sink_monitor.rs`）。
//!
//! 推送定时器与采集包解耦：系统静音时回环不送包（或送静音包），这段时间没有样本就按静音补零，页面照常收到逐帧
//! 衰减到 0 的数据，它的「空闲」判断才会生效。打不开设备（没有输出设备、系统版本不够等）也照样推静音帧。
//! 默认设备变化靠每秒比对设备 id 发现，读取失败立即重开。逐帧路径不打日志。
//!
//! 同一批样本另喂给 WPE 的原始频谱（`wpe_spectrum.rs`，P4e 步骤 4，只给场景用）：每攒够约 29 ms 的样本做一次 FFT，推的是最近
//! 一次的结果；静音照 WPE，静音包或读取失败时立即清零，连续超过 1 s 没有包时清零，1 s 内保留。
//! 两份每 33 ms 一起推（`on_frame(网页壁纸的, WPE 原始的)`）。

#[cfg(target_os = "macos")]
mod process_tap;
#[cfg(target_os = "linux")]
mod sink_monitor;
#[cfg(target_os = "windows")]
mod wasapi;

#[cfg(target_os = "macos")]
use process_tap as backend;
#[cfg(target_os = "linux")]
use sink_monitor as backend;
#[cfg(target_os = "windows")]
use wasapi as backend;

use super::spectrum::{Spectrum, BANDS};
use super::wpe_spectrum::Spectrum as WpeSpectrum;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const FRAME_INTERVAL: Duration = Duration::from_micros(33_333);
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// 运行中的回环采集；丢弃即停止。
pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AudioCapture {
    pub fn start(on_frame: impl Fn([f32; BANDS * 2], [f32; BANDS * 2]) + Send + 'static) -> Self {
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

fn run(stop: &AtomicBool, on_frame: &dyn Fn([f32; BANDS * 2], [f32; BANDS * 2])) {
    // 先于回环流声明：流（持有平台对象）先析构，设备（Windows 上持有 COM 初始化）后析构
    let devices = backend::Devices::new();
    let mut stream: Option<backend::LoopbackStream> = None;
    let mut sample_rate = 48_000;
    let mut spectrum = Spectrum::new(sample_rate);
    let mut wpe = WpeSpectrum::new(sample_rate);
    let mut last_poll = Instant::now();
    // 本帧周期内实际收到的样本帧数，不够的按静音补
    let mut received = 0usize;
    let mut open_failed = false;
    let mut next_frame = Instant::now();
    let mut next_device_check = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if let Some(devices) = &devices {
            if now >= next_device_check {
                next_device_check = now + DEVICE_CHECK_INTERVAL;
                let current = devices.default_id();
                let stale = match &stream {
                    Some(open) => current.as_deref() != Some(open.device_id.as_str()),
                    None => true,
                };
                if stale {
                    stream = None;
                    match devices.open() {
                        Ok(open) => {
                            tracing::info!(
                                sample_rate = open.sample_rate,
                                channels = open.channels,
                                "网页壁纸音频回环已打开"
                            );
                            if open.sample_rate != sample_rate {
                                sample_rate = open.sample_rate;
                                spectrum = Spectrum::new(sample_rate);
                                wpe = WpeSpectrum::new(sample_rate);
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
        // WPE 原始频谱：这一轮读到的包数（静音包也算）；一个都没有时累计无包时长，连续超过 1 s 清零
        let elapsed = now.duration_since(last_poll);
        last_poll = now;
        let mut packets = 0;
        if let Some(open) = &mut stream {
            match open.read(&mut spectrum, &mut wpe) {
                Ok((frames, count)) => {
                    received += frames;
                    packets = count;
                }
                Err(error) => {
                    tracing::debug!("音频回环读取失败，稍后重开: {error}");
                    // WPE 读取失败也立即清零
                    wpe.silent();
                    stream = None;
                    next_device_check = now;
                }
            }
        }
        if packets == 0 {
            wpe.no_packet(elapsed);
        }
        if now >= next_frame {
            let expected = (sample_rate as f32 * FRAME_INTERVAL.as_secs_f32()) as usize;
            if received < expected {
                spectrum.push_silence(expected - received);
            }
            received = 0;
            on_frame(spectrum.frame(), wpe.frame());
            next_frame += FRAME_INTERVAL;
            // 落后太多（睡眠唤醒、线程被挂起）不补帧
            if next_frame < now {
                next_frame = now + FRAME_INTERVAL;
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
