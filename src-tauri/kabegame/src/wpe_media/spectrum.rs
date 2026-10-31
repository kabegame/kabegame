//! 回环样本 → WPE 的 128 段频谱（API.md §3.2：左 0–63、右 64–127，各自低频在前，大致 0–1）。
//!
//! WPE 的具体算法没有公开资料，这里自定：Hann 窗 → 2048 点实数 FFT → 64 个对数间隔频段（30 Hz – 16 kHz，
//! 不超过奈奎斯特）取段内最大幅值 → 换成 dB、加高频补偿后线性映射到 0–1（可略超 1）→ 上升即时、下降按帧衰减。
//! 常数集中在 [`SpectrumTuning`]，真机按样本的观感调。

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// FFT 点数，也是每声道保留的样本数。
pub const FFT_SIZE: usize = 2048;
/// 每声道的频段数。
pub const BANDS: usize = 64;
const LOW_HZ: f32 = 30.0;
const HIGH_HZ: f32 = 16_000.0;
/// 高频补偿的参考频率：这里不加也不减。
const REFERENCE_HZ: f32 = 1_000.0;
/// 输出上限：允许略超 1（WPE 的数据也会偶尔超过），但不让页面画出界太多。
const MAX_VALUE: f32 = 1.2;

/// 频谱观感的可调常数。
#[derive(Debug, Clone, Copy)]
pub struct SpectrumTuning {
    /// 映射到 0 的电平（dBFS）。
    pub min_db: f32,
    /// 映射区间：`min_db + range_db` 对应 1.0。
    pub range_db: f32,
    /// 高频补偿：相对 1 kHz 每倍频程加多少 dB（音乐的高频能量天然更低）。
    pub tilt_db_per_octave: f32,
    /// 下降时每帧保留的比例（33ms 一帧，0.75 约 0.1 s 衰减一半）。
    pub release: f32,
}

impl SpectrumTuning {
    pub const DEFAULT: Self = Self {
        min_db: -70.0,
        range_db: 60.0,
        tilt_db_per_octave: 3.0,
        release: 0.75,
    };
}

/// 单声道环形缓冲，保留最近 [`FFT_SIZE`] 个样本。
struct Ring {
    samples: Vec<f32>,
    next: usize,
}

impl Ring {
    fn new() -> Self {
        Self {
            samples: vec![0.0; FFT_SIZE],
            next: 0,
        }
    }

    fn push(&mut self, sample: f32) {
        self.samples[self.next] = if sample.is_finite() { sample } else { 0.0 };
        self.next = (self.next + 1) % FFT_SIZE;
    }

    /// 按时间顺序（旧 → 新）乘上窗函数写进 `out`。
    fn windowed(&self, window: &[f32], out: &mut [f32]) {
        for (i, out) in out.iter_mut().enumerate() {
            *out = self.samples[(self.next + i) % FFT_SIZE] * window[i];
        }
    }
}

/// 把立体声样本流变成 WPE 的 128 段频谱。
pub struct Spectrum {
    tuning: SpectrumTuning,
    left: Ring,
    right: Ring,
    smoothed: [f32; BANDS * 2],
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    output: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    /// 每段的 FFT 下标区间（闭区间）；低频段可能共用一个下标。
    bands: Vec<(usize, usize)>,
    /// 每段的高频补偿（dB）。
    tilt: Vec<f32>,
}

impl Spectrum {
    pub fn new(sample_rate: u32) -> Self {
        Self::with_tuning(sample_rate, SpectrumTuning::DEFAULT)
    }

    pub fn with_tuning(sample_rate: u32, tuning: SpectrumTuning) -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|i| {
                let phase = 2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32;
                0.5 - 0.5 * phase.cos()
            })
            .collect();
        let edges = band_edges(sample_rate);
        let tilt = edges
            .windows(2)
            .map(|pair| {
                let center = (pair[0] * pair[1]).sqrt();
                tuning.tilt_db_per_octave * (center / REFERENCE_HZ).log2()
            })
            .collect();
        Self {
            tuning,
            left: Ring::new(),
            right: Ring::new(),
            smoothed: [0.0; BANDS * 2],
            input: fft.make_input_vec(),
            output: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window,
            bands: band_ranges(sample_rate),
            tilt,
        }
    }

    /// 交错样本：只取前两个声道，单声道复制到两边；非有限值按 0 处理。
    pub fn push(&mut self, interleaved: &[f32], channels: usize) {
        if channels == 0 {
            return;
        }
        for frame in interleaved.chunks_exact(channels) {
            let left = frame[0];
            let right = if channels > 1 { frame[1] } else { left };
            self.left.push(left);
            self.right.push(right);
        }
    }

    /// 静音时调用：往缓冲里补零，让频谱自然衰减到 0。
    pub fn push_silence(&mut self, frames: usize) {
        for _ in 0..frames.min(FFT_SIZE) {
            self.left.push(0.0);
            self.right.push(0.0);
        }
    }

    /// 一帧 128 个值：0–63 左声道、64–127 右声道，非有限值置 0。
    pub fn frame(&mut self) -> [f32; BANDS * 2] {
        let left = self.levels(false);
        let right = self.levels(true);
        let release = self.tuning.release;
        for (i, level) in left.iter().chain(right.iter()).enumerate() {
            let held = self.smoothed[i] * release;
            let value = level.max(held);
            self.smoothed[i] = if value.is_finite() { value } else { 0.0 };
        }
        self.smoothed
    }

    /// 一个声道的 64 段电平（未平滑）。
    fn levels(&mut self, right: bool) -> [f32; BANDS] {
        let ring = if right { &self.right } else { &self.left };
        ring.windowed(&self.window, &mut self.input);
        let mut levels = [0.0; BANDS];
        if self
            .fft
            .process_with_scratch(&mut self.input, &mut self.output, &mut self.scratch)
            .is_err()
        {
            return levels;
        }
        // Hann 窗的相干增益是 0.5：满幅正弦的峰值 |X| = N/4，乘 4/N 归一到 1.0（0 dBFS）
        let scale = 4.0 / FFT_SIZE as f32;
        for (band, ((start, end), tilt)) in self.bands.iter().zip(&self.tilt).enumerate() {
            let peak = self.output[*start..=*end]
                .iter()
                .map(|bin| bin.norm() * scale)
                .fold(0.0f32, f32::max);
            let db = 20.0 * peak.max(1e-9).log10() + tilt;
            let value = ((db - self.tuning.min_db) / self.tuning.range_db).clamp(0.0, MAX_VALUE);
            levels[band] = if value.is_finite() { value } else { 0.0 };
        }
        levels
    }
}

/// 64 段的 65 个边界频率（对数间隔）；上限不超过奈奎斯特的 95%。
fn band_edges(sample_rate: u32) -> Vec<f32> {
    let high = HIGH_HZ.min(sample_rate as f32 / 2.0 * 0.95);
    (0..=BANDS)
        .map(|i| LOW_HZ * (high / LOW_HZ).powf(i as f32 / BANDS as f32))
        .collect()
}

/// 每段对应的 FFT 下标闭区间：至少一个下标，下标单调不减。
fn band_ranges(sample_rate: u32) -> Vec<(usize, usize)> {
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let max_bin = FFT_SIZE / 2;
    band_edges(sample_rate)
        .windows(2)
        .map(|pair| {
            let start = ((pair[0] / bin_hz).round() as usize).clamp(1, max_bin);
            let end = ((pair[1] / bin_hz).round() as usize)
                .saturating_sub(1)
                .clamp(start, max_bin);
            (start, end)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    /// 左声道正弦、右声道静音的交错样本。
    fn sine_left(freq: f32, amplitude: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let t = i as f32 / RATE as f32;
                [
                    amplitude * (2.0 * std::f32::consts::PI * freq * t).sin(),
                    0.0,
                ]
            })
            .collect()
    }

    #[test]
    fn sine_lands_in_its_band_and_channels_are_independent() {
        let mut spectrum = Spectrum::new(RATE);
        spectrum.push(&sine_left(1_000.0, 0.5, FFT_SIZE), 2);
        let frame = spectrum.frame();
        let (left, right) = frame.split_at(BANDS);
        let (peak_band, peak) =
            left.iter().enumerate().fold(
                (0, 0.0f32),
                |best, (i, v)| if *v > best.1 { (i, *v) } else { best },
            );
        assert!(peak > 0.5, "1 kHz 的电平太低: {peak}");
        let bin = (1_000.0 / (RATE as f32 / FFT_SIZE as f32)).round() as usize;
        let (start, end) = band_ranges(RATE)[peak_band];
        assert!(
            start <= bin + 1 && bin <= end + 1,
            "峰值段 {peak_band} = {start}..={end}，1 kHz 在 {bin}"
        );
        // 远离 1 kHz 的低频段几乎没有泄漏
        assert!(left[0] < 0.05, "低频段泄漏: {}", left[0]);
        assert!(right.iter().all(|v| *v == 0.0), "右声道应为 0: {right:?}");
    }

    #[test]
    fn silence_decays_to_zero() {
        let mut spectrum = Spectrum::new(RATE);
        assert!(spectrum.frame().iter().all(|v| *v == 0.0));
        spectrum.push(&sine_left(440.0, 0.8, FFT_SIZE), 2);
        assert!(spectrum.frame().iter().any(|v| *v > 0.5));
        spectrum.push_silence(FFT_SIZE);
        let mut last = [1.0; BANDS * 2];
        for _ in 0..60 {
            last = spectrum.frame();
        }
        assert!(
            last.iter().all(|v| *v < 1e-3),
            "静音后没有衰减到 0: {last:?}"
        );
    }

    #[test]
    fn non_finite_input_never_leaks_out() {
        let mut spectrum = Spectrum::new(RATE);
        let mut samples = sine_left(2_000.0, 0.5, FFT_SIZE);
        for (i, sample) in samples.iter_mut().enumerate() {
            if i % 7 == 0 {
                *sample = f32::NAN;
            } else if i % 11 == 0 {
                *sample = f32::INFINITY;
            }
        }
        spectrum.push(&samples, 2);
        assert!(spectrum.frame().iter().all(|v| v.is_finite()));
    }

    #[test]
    fn mono_is_copied_to_both_channels() {
        let mut spectrum = Spectrum::new(RATE);
        let mono: Vec<f32> = sine_left(1_000.0, 0.5, FFT_SIZE)
            .into_iter()
            .step_by(2)
            .collect();
        spectrum.push(&mono, 1);
        let frame = spectrum.frame();
        assert_eq!(frame[..BANDS], frame[BANDS..]);
    }

    #[test]
    fn band_ranges_are_monotonic_and_cover_all_bands() {
        for rate in [44_100, 48_000] {
            let ranges = band_ranges(rate);
            assert_eq!(ranges.len(), BANDS);
            for (start, end) in &ranges {
                assert!(
                    1 <= *start && start <= end && *end <= FFT_SIZE / 2,
                    "{rate}: {start}..={end}"
                );
            }
            for pair in ranges.windows(2) {
                assert!(
                    pair[0].0 <= pair[1].0 && pair[0].1 <= pair[1].1,
                    "{rate}: {pair:?}"
                );
            }
        }
    }
}
