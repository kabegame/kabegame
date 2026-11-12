//! 回环样本 → WPE 采集线程的 128 段原始频谱（API.md §3.2：左 0–63、右 64–127，各自低频在前）。
//!
//! 照 WPE 2.8.42 的采集线程逐行写（读码见 `.claude/plans/wpe-import/3-scene/phase4/rea-p4e-audio.md` 3.2：线程函数
//! `FUN_1400d02b0`，每批新样本数 `0x1400d1491`，写样本 `0x1400d19dd`，频段 `0x1400d1b9a`–`0x1400d1df6`）。只给场景用
//! （音频消息的 `raw`，P4e 步骤 4）：场景宿主再照 rea 3.3 做每帧的自适应归一化，粒子与场景脚本读归一化后的值。网页壁纸仍用
//! `spectrum.rs` 的自定频谱（2026-11-13 用户定：观感更好；WPE 给网页壁纸的其实是这份原值，rea 3.4）。
//!
//! - **长度**：`r = max(sr/44100, 1)`，`fftSize = int(r·64·30)`，每批新样本 `ns = int(fftSize − (10/30)·fftSize)`（f32 算完再截断）：
//!   44.1 kHz 为 1920 / 1280，48 kHz 为 2089 / 1392（都约 29 ms）；用到的 bin 数 `N = int(10·64) = 640`。
//! - **FFT**：每攒够 `ns` 个样本做一次长度 `fftSize` 的复数 FFT，不加窗、不重叠；`[ns, fftSize)` 一直是 `(127, 1/127)`，
//!   样本写成 `re = s·127 + 127`、`im = 1/re`。补满一批的那个数据包，多出来的样本丢掉（不留给下一批）。
//! - **频段**：bin `k = 1..N−1`：`m2 = im² + re²`（inf / NaN 置 0）；段 `idx = min(idx + 1, int(powf((k−1)/(N−1), 0.25)·64) % 64)`；
//!   倾斜 `w = 0.501 − cosf(π·(k−1)·(1/(N−1)))·(1 − 0.501)`；段内取 `sqrt(w·m2)` 的最大，最后乘
//!   `(增益·0.001)·(N/(fftSize·0.5))`。增益按缺省 `audioinputvolume 50` 取 1.0，阈值按缺省 0（不做）。
//! - **声道**：只取前两个，单声道时右 = 左。输出是最近一次 FFT 的结果，两次 FFT 之间不变。
//! - **静音**：数据包带 SILENT 标志（或读取失败）时立即清零；连续超过 1 s 没有数据包时清零，1 s 内保留上一次的结果。
//! - **`s = −1` 的样本**：`re = 0`、`im = inf`，那一批该声道整个变成 0（`m2` 全是 inf / NaN），照 WPE。
//!
//! 和 WPE 不同的地方（数学上不变，或差别不超过一轮轮询）：
//! - FFT 之前减掉常量 `(127, 1/127)`：常量只落在 bin 0（不用），bin 1..N−1 数学上不变；大直流不再进 FFT 的舍入，
//!   全 0 样本得到精确的 0（WPE 的 chirp-z 在这里只有舍入噪声）。
//! - WPE 在一轮轮询（`Sleep` 间隔）末尾才处理批次：一轮最多一次 FFT，批满之后本轮余下的包丢掉，本轮最后一个包是 SILENT
//!   时不做 FFT。这里按包即时处理。
//! - 无包计时 WPE 每轮累加名义的轮询间隔，这里由调用方传实际经过的时间。

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;
use std::time::Duration;

/// 每声道的频段数。
pub const BANDS: usize = 64;
/// 用到的 bin 数 `N = int(10·64)`（`T+0xf8`）：bin 1..N−1，bin 0（直流）不用。
const BINS: usize = 640;
/// 段下标的指数（`T+0xe4`）。
const BAND_EXPONENT: f32 = 0.25;
/// 频率倾斜系数 `a`（`T+0xe8`，`0x3f004189`）。
const TILT: f32 = 0.501;
/// 增益 `audioinputvolume·0.02`：缺省 50 → 1.0（`T+0xc`）。
const GAIN: f32 = 1.0;
/// 样本编码 `re = s·127 + 127`（`0x1404928fc`），也是缓冲初值的实部。
const OFFSET: f32 = 127.0;
/// 缓冲初值的虚部 `1/127`（`0x3c010204`）。
const OFFSET_IM: f32 = 1.0 / 127.0;
/// 连续没有数据包超过这么久，输出清零。
const IDLE_CLEAR: Duration = Duration::from_millis(1000);

/// `(fftSize, ns)`：FFT 长度与每批新样本数。
fn lengths(sample_rate: u32) -> (usize, usize) {
    let r = (sample_rate as f32 / 44_100.0).max(1.0);
    let fft_size = (r * 64.0 * 30.0) as usize;
    let size = fft_size as f32;
    // 先 f32 算完再截断：48 kHz 是 int(2089 − 696.33) = 1392，不是 2089 − int(2089/3) = 1393
    let batch = (size - (10.0f32 / 30.0) * size) as usize;
    (fft_size, batch)
}

/// bin 1..N−1 各自的段下标与倾斜系数 `w`；只和 `k` 有关，建时算好。
fn bin_table() -> Vec<(usize, f32)> {
    let last = (BINS - 1) as f32;
    let inv = 1.0 / last;
    let mut idx = 0i32;
    (1..BINS)
        .map(|k| {
            let x = (k - 1) as f32;
            // `(int)` 截断后按 C 取余 64；x ≤ N−2，所以实际到不了 64
            let band = ((x / last).powf(BAND_EXPONENT) * 64.0) as i32 % 64;
            idx = (idx + 1).min(band);
            let w = TILT - (x * std::f32::consts::PI * inv).cos() * (1.0 - TILT);
            (idx as usize, w)
        })
        .collect()
}

/// 一个样本写进 FFT 输入：先照 WPE 编码，再减掉常量（见模块说明）。
fn encode(sample: f32) -> Complex<f32> {
    let re = sample * OFFSET + OFFSET;
    let im = 1.0 / re;
    Complex::new(re - OFFSET, im - OFFSET_IM)
}

/// 把立体声样本流变成 WPE 的 128 段原始频谱。
pub struct Spectrum {
    fft: Arc<dyn Fft<f32>>,
    /// 每批新样本数 `ns`。
    batch: usize,
    /// 输出系数 `(增益·0.001)·(N/(fftSize·0.5))`。
    scale: f32,
    bins: Vec<(usize, f32)>,
    /// 两个声道的 FFT 输入（已减常量）：`[0, batch)` 是这一批的样本，`[batch, fftSize)` 恒为 0。
    input: [Vec<Complex<f32>>; 2],
    work: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    /// 这一批已写入的样本数。
    filled: usize,
    /// 这一批的声道数：变了就从头攒。
    channels: usize,
    /// 连续没有数据包的时长。
    idle: Duration,
    /// 最近一次 FFT 的结果（已乘系数），静音时清零。
    output: [f32; BANDS * 2],
}

impl Spectrum {
    pub fn new(sample_rate: u32) -> Self {
        let (fft_size, batch) = lengths(sample_rate);
        let fft = FftPlanner::<f32>::new().plan_fft_forward(fft_size);
        let zero = Complex::new(0.0, 0.0);
        Self {
            scratch: vec![zero; fft.get_inplace_scratch_len()],
            fft,
            batch,
            scale: (GAIN * 0.001) * (BINS as f32 / (fft_size as f32 * 0.5)),
            bins: bin_table(),
            input: [vec![zero; fft_size], vec![zero; fft_size]],
            work: vec![zero; fft_size],
            filled: 0,
            channels: 0,
            idle: Duration::ZERO,
            output: [0.0; BANDS * 2],
        }
    }

    /// 一个有声的数据包（交错样本）：只取前两个声道，写到这一批满为止，满了就做一次 FFT。
    /// 样本不做清洗：非有限值和 `−1` 会让那一批该声道变成 0（同 WPE），输出始终是有限值。
    pub fn push(&mut self, interleaved: &[f32], channels: usize) {
        if channels == 0 {
            return;
        }
        self.idle = Duration::ZERO;
        if channels != self.channels {
            self.channels = channels;
            self.filled = 0;
        }
        let room = self.batch - self.filled;
        for frame in interleaved.chunks_exact(channels).take(room) {
            self.input[0][self.filled] = encode(frame[0]);
            if channels > 1 {
                self.input[1][self.filled] = encode(frame[1]);
            }
            self.filled += 1;
        }
        if self.filled == self.batch {
            self.transform();
            self.filled = 0;
        }
    }

    /// 带 `AUDCLNT_BUFFERFLAGS_SILENT` 的数据包（读取失败同样处理）：输出立即清零。这一批已攒的样本保留。
    pub fn silent(&mut self) {
        self.idle = Duration::ZERO;
        self.output = [0.0; BANDS * 2];
    }

    /// 这一轮轮询没有数据包，`elapsed` 是距上一轮的时间：无包时长先判断再累加（照 WPE），超过 1 s 起每轮清零。
    pub fn no_packet(&mut self, elapsed: Duration) {
        if self.idle > IDLE_CLEAR {
            self.output = [0.0; BANDS * 2];
        } else {
            self.idle += elapsed;
        }
    }

    /// 一帧 128 个值：0–63 左声道、64–127 右声道，就是最近一次 FFT 的结果（或静音后的 0）。
    pub fn frame(&self) -> [f32; BANDS * 2] {
        self.output
    }

    /// 对这一批做 FFT、按段取最大、乘系数，写进输出。
    fn transform(&mut self) {
        let stereo = self.channels > 1;
        let used = if stereo { 2 } else { 1 };
        let mut bands = [[0.0f32; BANDS]; 2];
        for (input, out) in self.input.iter().zip(&mut bands).take(used) {
            self.work.copy_from_slice(input);
            let fft = &self.fft;
            fft.process_with_scratch(&mut self.work, &mut self.scratch);
            for (bin, &(band, w)) in self.work[1..BINS].iter().zip(&self.bins) {
                let mut m2 = bin.im * bin.im + bin.re * bin.re;
                if !m2.is_finite() {
                    m2 = 0.0;
                }
                out[band] = out[band].max((w * m2).sqrt());
            }
        }
        if !stereo {
            bands[1] = bands[0];
        }
        for (dst, src) in self.output.iter_mut().zip(bands.iter().flatten()) {
            *dst = src * self.scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// P6a 实测的 7 个频率与它们落的 64 段（p6-REPORT 第 19 行，rea 3.2「和 P6a 实测对照」）。
    const P6A: [(f64, usize); 7] = [
        (125.0, 4),
        (250.0, 10),
        (500.0, 21),
        (1000.0, 32),
        (2000.0, 38),
        (4000.0, 46),
        (8000.0, 54),
    ];
    /// rea-p4e-audio 3.2 的完整段表（读码复算的 band.txt）里 64 段各自的起始 bin。
    const BAND_STARTS: [usize; BANDS] = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 32, 37, 41, 47, 52, 59, 65, 73, 81, 90, 99, 109, 120, 132, 144, 158,
        172, 187, 204, 221, 240, 259, 280, 302, 325, 350, 376, 404, 433, 463, 495, 529, 564, 601,
    ];
    const RATES: [u32; 2] = [44_100, 48_000];

    fn fft_size(spectrum: &Spectrum) -> usize {
        spectrum.work.len()
    }

    /// 单声道正弦，按 f64 算再转 f32。
    fn sine(rate: u32, freq: f64, amplitude: f64, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|n| (amplitude * (2.0 * PI * freq * n as f64 / rate as f64).sin()) as f32)
            .collect()
    }

    fn interleave(left: &[f32], right: &[f32]) -> Vec<f32> {
        left.iter().zip(right).flat_map(|(l, r)| [*l, *r]).collect()
    }

    /// 确定性的伪随机样本（−0.6..0.6）。
    fn noise(seed: u32, frames: usize) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).max(1);
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f64 / u32::MAX as f64 * 1.2 - 0.6) as f32
            })
            .collect()
    }

    fn argmax(values: &[f32]) -> usize {
        (0..values.len()).fold(0, |best, i| if values[i] > values[best] { i } else { best })
    }

    fn band_of(spectrum: &Spectrum, k: usize) -> usize {
        spectrum.bins[k - 1].0
    }

    /// 照 WPE 字面的输入（不减常量，`[ns, fftSize)` 为 `(127, 1/127)`）做 f64 直接 DFT，再走同一张段表与系数。
    fn reference(spectrum: &Spectrum, samples: &[f32]) -> [f32; BANDS] {
        let size = fft_size(spectrum);
        let mut re = vec![OFFSET as f64; size];
        let mut im = vec![OFFSET_IM as f64; size];
        for (i, s) in samples.iter().take(spectrum.batch).enumerate() {
            let r = s * OFFSET + OFFSET;
            re[i] = r as f64;
            im[i] = (1.0 / r) as f64;
        }
        let mut out = [0.0f64; BANDS];
        for (j, &(band, w)) in spectrum.bins.iter().enumerate() {
            let k = j + 1;
            let (mut xr, mut xi) = (0.0, 0.0);
            for n in 0..size {
                let (sin, cos) = (-2.0 * PI * ((k * n) % size) as f64 / size as f64).sin_cos();
                xr += re[n] * cos - im[n] * sin;
                xi += re[n] * sin + im[n] * cos;
            }
            out[band] = out[band].max((w as f64 * (xr * xr + xi * xi)).sqrt());
        }
        out.map(|v| (v * spectrum.scale as f64) as f32)
    }

    /// 照 WPE 字面的输入（不减常量）用同一个 rustfft 做，单声道：量减常量的改写差多少。
    fn literal(spectrum: &mut Spectrum, samples: &[f32]) -> [f32; BANDS] {
        let size = fft_size(spectrum);
        let mut buffer = vec![Complex::new(OFFSET, OFFSET_IM); size];
        for (i, s) in samples.iter().take(spectrum.batch).enumerate() {
            let re = s * OFFSET + OFFSET;
            buffer[i] = Complex::new(re, 1.0 / re);
        }
        spectrum
            .fft
            .process_with_scratch(&mut buffer, &mut spectrum.scratch);
        let mut out = [0.0f32; BANDS];
        for (bin, &(band, w)) in buffer[1..BINS].iter().zip(&spectrum.bins) {
            let mut m2 = bin.im * bin.im + bin.re * bin.re;
            if !m2.is_finite() {
                m2 = 0.0;
            }
            out[band] = out[band].max((w * m2).sqrt());
        }
        out.map(|v| v * spectrum.scale)
    }

    #[test]
    fn constants_match_wpe_bits() {
        assert_eq!(TILT.to_bits(), 0x3f00_4189);
        assert_eq!(OFFSET.to_bits(), 0x42fe_0000);
        assert_eq!(OFFSET_IM.to_bits(), 0x3c01_0204);
        assert_eq!(0.001f32.to_bits(), 0x3a83_126f);
        assert_eq!(std::f32::consts::PI.to_bits(), 0x4049_0fdb);
    }

    #[test]
    fn fft_lengths_match_wpe() {
        assert_eq!(lengths(44_100), (1920, 1280));
        assert_eq!(lengths(48_000), (2089, 1392));
        // 低于 44.1 kHz 时 r 钳到 1
        assert_eq!(lengths(22_050), (1920, 1280));
        assert_eq!(lengths(96_000), (4179, 2786));
        let spectrum = Spectrum::new(48_000);
        assert_eq!((fft_size(&spectrum), spectrum.batch), (2089, 1392));
    }

    #[test]
    fn band_table_matches_rea() {
        let bins = bin_table();
        assert_eq!(bins.len(), BINS - 1);
        for (band, &start) in BAND_STARTS.iter().enumerate() {
            assert_eq!(bins[start - 1].0, band, "段 {band} 应从 bin {start} 开始");
            if start > 1 {
                assert_eq!(
                    bins[start - 2].0,
                    band - 1,
                    "bin {} 应在段 {}",
                    start - 1,
                    band - 1
                );
            }
        }
        assert_eq!(bins[BINS - 2].0, BANDS - 1);
        // 段下标单调、每次最多加一
        for pair in bins.windows(2) {
            assert!(
                pair[1].0 == pair[0].0 || pair[1].0 == pair[0].0 + 1,
                "{pair:?}"
            );
        }
        // 倾斜：bin 1 是 0.501 − 0.499 = 0.002，bin 639 是 0.501 + 0.499·cos(π/639) ≈ 0.999994
        for (k, expected) in [(1, 0.002), (639, 0.501 + 0.499 * (PI / 639.0).cos())] {
            let w = bins[k - 1].1 as f64;
            assert!((w - expected).abs() < 1e-6, "bin {k}：{w} vs {expected}");
        }
    }

    #[test]
    fn p6a_frequencies_land_in_wpe_bands() {
        for rate in RATES {
            for &(freq, expected) in &P6A {
                let probe = Spectrum::new(rate);
                let size = fft_size(&probe);
                let k = (freq * size as f64 / rate as f64).round();
                // 名义频率与 bin 中心各测一次
                for f in [freq, k * rate as f64 / size as f64] {
                    let mut spectrum = Spectrum::new(rate);
                    let left = sine(rate, f, 0.5, spectrum.batch);
                    let right = vec![0.0; spectrum.batch];
                    spectrum.push(&interleave(&left, &right), 2);
                    let frame = spectrum.frame();
                    let band = argmax(&frame[..BANDS]);
                    assert_eq!(
                        band, expected,
                        "{rate} Hz 采样、{f:.2} Hz（bin {k}）落在段 {band}"
                    );
                    assert_eq!(band / 4, expected / 4);
                    assert!(frame[BANDS..].iter().all(|v| *v == 0.0), "右声道应为 0");
                }
            }
        }
    }

    #[test]
    fn full_scale_sine_magnitude() {
        for rate in RATES {
            let probe = Spectrum::new(rate);
            let size = fft_size(&probe);
            // rea 3.2：bin 中心的正弦 m ≈ 127·A·ns/2·scale·√w
            let gain = 127.0 * (probe.batch as f32 / 2.0) * probe.scale;
            println!("{rate} Hz：127·ns/2·scale = {gain:.3}");
            for &(freq, _) in &P6A {
                let k = (freq * size as f64 / rate as f64).round() as usize;
                for amplitude in [0.5, 0.9] {
                    let mut spectrum = Spectrum::new(rate);
                    let f = k as f64 * rate as f64 / size as f64;
                    spectrum.push(&sine(rate, f, amplitude, spectrum.batch), 1);
                    let got = spectrum.frame()[band_of(&spectrum, k)];
                    let w = spectrum.bins[k - 1].1;
                    let expected = gain * amplitude as f32 * w.sqrt();
                    let ratio = got / expected;
                    println!(
                        "  bin {k:3}（{f:7.1} Hz）A {amplitude}：{got:.5}，54 类常数 = {:.3}，比值 {ratio:.4}",
                        got / (amplitude as f32 * w.sqrt())
                    );
                    // 低频 bin 的负频率泄漏最多约 4%（1/ns·|sin(2πk·ns/F)/sin(2πk/F)|）
                    assert!(
                        (ratio - 1.0).abs() < 0.05,
                        "{rate} Hz、bin {k}、A {amplitude}：{ratio}"
                    );
                }
            }
        }
    }

    #[test]
    fn matches_direct_dft_of_literal_input() {
        for rate in RATES {
            let mut spectrum = Spectrum::new(rate);
            let left = noise(rate, spectrum.batch);
            let mut mix = sine(rate, 1_234.5, 0.3, spectrum.batch);
            for (m, n) in mix.iter_mut().zip(noise(rate + 1, spectrum.batch)) {
                *m += 0.05 * n;
            }
            let expected = [reference(&spectrum, &left), reference(&spectrum, &mix)];
            spectrum.push(&interleave(&left, &mix), 2);
            let frame = spectrum.frame();
            let mut worst = 0.0f32;
            for (ch, expected) in expected.iter().enumerate() {
                let peak = expected.iter().fold(0.0f32, |a, b| a.max(*b));
                for band in 0..BANDS {
                    let got = frame[ch * BANDS + band];
                    let error = (got - expected[band]).abs() / peak;
                    worst = worst.max(error);
                    assert!(
                        error < 1e-4,
                        "{rate} Hz 声道 {ch} 段 {band}：{got} vs {}",
                        expected[band]
                    );
                }
            }
            println!("{rate} Hz：和 f64 直接 DFT 的最大相对误差（相对峰值）{worst:.2e}");
        }
    }

    #[test]
    fn subtracting_the_constant_changes_nothing_measurable() {
        for rate in RATES {
            let mut spectrum = Spectrum::new(rate);
            let batch = spectrum.batch;
            let silence = vec![0.0f32; batch];
            let floor = literal(&mut spectrum, &silence)
                .iter()
                .fold(0.0f32, |a, b| a.max(*b));
            println!("{rate} Hz：字面写法（不减常量）全 0 样本的舍入噪声最大 {floor:.3e}");
            assert!(floor < 1e-4, "字面写法的噪声已到场景静音门限: {floor}");
            let signal = noise(7, batch);
            let lit = literal(&mut spectrum, &signal);
            spectrum.push(&signal, 1);
            let frame = spectrum.frame();
            let peak = lit.iter().fold(0.0f32, |a, b| a.max(*b));
            let worst = (0..BANDS)
                .map(|b| (frame[b] - lit[b]).abs() / peak)
                .fold(0.0f32, f32::max);
            println!("{rate} Hz：减常量与字面写法的最大相对差 {worst:.2e}");
            assert!(worst < 1e-4);
        }
    }

    #[test]
    fn output_holds_until_the_batch_is_full() {
        let mut spectrum = Spectrum::new(48_000);
        let batch = spectrum.batch;
        let first = sine(48_000, 1_000.0, 0.5, batch);
        spectrum.push(&first[..batch - 1], 1);
        assert!(
            spectrum.frame().iter().all(|v| *v == 0.0),
            "攒不够 ns 不该出结果"
        );
        spectrum.push(&first[batch - 1..], 1);
        let held = spectrum.frame();
        assert!(held.iter().any(|v| *v > 0.0));
        // 下一批攒到 ns − 1 之前一直是上一次的结果
        let second = sine(48_000, 4_000.0, 0.5, batch);
        for chunk in second[..batch - 1].chunks(480) {
            spectrum.push(chunk, 1);
            assert_eq!(spectrum.frame(), held);
        }
        spectrum.push(&second[batch - 1..], 1);
        assert_ne!(spectrum.frame(), held);
    }

    #[test]
    fn rest_of_the_completing_packet_is_dropped() {
        let mut spectrum = Spectrum::new(44_100);
        let batch = spectrum.batch;
        // 一包 ns + 100 个样本：一次 FFT，多的 100 个丢掉
        spectrum.push(&sine(44_100, 1_000.0, 0.5, batch + 100), 1);
        let held = spectrum.frame();
        assert!(held.iter().any(|v| *v > 0.0));
        assert_eq!(spectrum.filled, 0);
        // 多的样本没留给下一批：还要整整 ns 个才出下一次
        let next = sine(44_100, 4_000.0, 0.5, batch);
        spectrum.push(&next[..batch - 1], 1);
        assert_eq!(spectrum.frame(), held);
        spectrum.push(&next[batch - 1..], 1);
        assert_ne!(spectrum.frame(), held);
    }

    #[test]
    fn silent_packet_clears_immediately() {
        let mut spectrum = Spectrum::new(48_000);
        let batch = spectrum.batch;
        spectrum.push(&sine(48_000, 1_000.0, 0.5, batch), 1);
        assert!(spectrum.frame().iter().any(|v| *v > 0.0));
        // 攒了半批时来一个 SILENT 包：输出当即清零，已攒的半批保留
        let half = sine(48_000, 2_000.0, 0.5, batch);
        spectrum.push(&half[..batch / 2], 1);
        spectrum.silent();
        assert!(spectrum.frame().iter().all(|v| *v == 0.0));
        spectrum.push(&half[batch / 2..batch - 1], 1);
        assert!(spectrum.frame().iter().all(|v| *v == 0.0));
        spectrum.push(&half[batch - 1..], 1);
        let frame = spectrum.frame();
        assert_eq!(
            argmax(&frame[..BANDS]),
            38,
            "保留的半批接着攒，2 kHz 落在段 38"
        );
    }

    #[test]
    fn missing_packets_clear_after_one_second() {
        let tick = Duration::from_millis(10);
        let mut spectrum = Spectrum::new(48_000);
        let batch = spectrum.batch;
        spectrum.push(&sine(48_000, 1_000.0, 0.5, batch), 1);
        let held = spectrum.frame();
        // 1 s 内保留：累计到正好 1000 ms 时还不清零（先判断 > 1 s 再累加）
        for _ in 0..101 {
            spectrum.no_packet(tick);
            assert_eq!(spectrum.frame(), held);
        }
        assert_eq!(spectrum.idle, Duration::from_millis(1010));
        spectrum.no_packet(tick);
        assert!(
            spectrum.frame().iter().all(|v| *v == 0.0),
            "超过 1 s 没有包应清零"
        );
        // 收到包就重新计时
        spectrum.push(&sine(48_000, 1_000.0, 0.5, batch), 1);
        for _ in 0..90 {
            spectrum.no_packet(tick);
        }
        spectrum.push(&[0.1; 4], 1);
        for _ in 0..90 {
            spectrum.no_packet(tick);
        }
        assert_eq!(spectrum.frame(), held);
        // SILENT 包也算收到包
        for _ in 0..90 {
            spectrum.no_packet(tick);
        }
        spectrum.silent();
        assert_eq!(spectrum.idle, Duration::ZERO);
    }

    #[test]
    fn mono_right_equals_left() {
        for rate in RATES {
            let mut mono = Spectrum::new(rate);
            let samples = noise(3, mono.batch);
            mono.push(&samples, 1);
            let frame = mono.frame();
            assert!(frame.iter().any(|v| *v > 0.0));
            assert_eq!(frame[..BANDS], frame[BANDS..]);
            // 和两个声道都给同一信号的结果相同
            let mut stereo = Spectrum::new(rate);
            stereo.push(&interleave(&samples, &samples), 2);
            assert_eq!(stereo.frame(), frame);
        }
    }

    #[test]
    fn only_the_first_two_channels_are_used() {
        let mut two = Spectrum::new(48_000);
        let batch = two.batch;
        let left = sine(48_000, 500.0, 0.5, batch);
        let right = sine(48_000, 8_000.0, 0.5, batch);
        two.push(&interleave(&left, &right), 2);
        let mut eight = Spectrum::new(48_000);
        let loud = noise(11, batch * 6);
        let interleaved: Vec<f32> = (0..batch)
            .flat_map(|i| {
                let mut frame = vec![left[i], right[i]];
                frame.extend_from_slice(&loud[i * 6..i * 6 + 6]);
                frame
            })
            .collect();
        eight.push(&interleaved, 8);
        assert_eq!(eight.frame(), two.frame());
    }

    #[test]
    fn zero_samples_give_exact_zero() {
        for rate in RATES {
            let mut spectrum = Spectrum::new(rate);
            let silence = vec![0.0f32; spectrum.batch * 2];
            spectrum.push(&silence, 2);
            assert!(
                spectrum.frame().iter().all(|v| *v == 0.0),
                "{rate}: {:?}",
                spectrum.frame()
            );
        }
    }

    #[test]
    fn minus_one_blanks_that_channel_like_wpe() {
        let mut spectrum = Spectrum::new(48_000);
        let batch = spectrum.batch;
        let mut left = sine(48_000, 1_000.0, 0.5, batch);
        left[100] = -1.0;
        let right = sine(48_000, 1_000.0, 0.5, batch);
        spectrum.push(&interleave(&left, &right), 2);
        let frame = spectrum.frame();
        assert!(
            frame[..BANDS].iter().all(|v| *v == 0.0),
            "左声道这一批应整体为 0"
        );
        assert!(frame[BANDS..].iter().any(|v| *v > 0.0));
    }

    #[test]
    fn non_finite_input_never_leaks_out() {
        let mut spectrum = Spectrum::new(48_000);
        let mut samples = noise(5, spectrum.batch * 2);
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
    fn channel_count_change_restarts_the_batch() {
        let mut spectrum = Spectrum::new(48_000);
        let batch = spectrum.batch;
        let stereo = interleave(&noise(1, batch), &noise(2, batch));
        spectrum.push(&stereo[..(batch - 10) * 2], 2);
        // 换成单声道：前面攒的双声道样本不算，要重新攒满一批
        spectrum.push(&noise(3, batch - 1), 1);
        assert!(spectrum.frame().iter().all(|v| *v == 0.0));
        spectrum.push(&[0.2], 1);
        let frame = spectrum.frame();
        assert!(frame.iter().any(|v| *v > 0.0));
        assert_eq!(frame[..BANDS], frame[BANDS..]);
    }
}
