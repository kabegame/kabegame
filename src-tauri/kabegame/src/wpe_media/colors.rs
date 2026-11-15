//! 封面配色：照 WPE 的 `winrtutil64.exe` 逐步移植（rea-p11-textures.md 第 4 节，常数、float / double 的位置照反编译）。
//!
//! 三色：alpha ≥ 16 的像素进 360 格色相直方图（权重 `(int)(M·s·100)`），主色取权重最大的格，次色、第三色按格距加权；
//! 再由主色对黑的对比度定高对比色，由次色 / 第三色定文字色。字段名按 p11-REPORT 的实测更正：脚本的
//! `highContrastColor` 是黑白，`textColor` 才可能是次色或第三色。
//! 在原尺寸（Spotify 预处理之后）的像素上算，不缩小采样；没有封面时五色全 0。

use image::RgbaImage;

/// 五个颜色，依次是 primary、secondary、tertiary、text、highContrast（脚本字段名），0–255。
pub type Colors = [[u8; 3]; 5];

/// 没有封面（或没选中任何格）时的颜色：全 0。
pub const NO_COLORS: Colors = [[0; 3]; 5];

/// 对比度门槛（WPE 的 `0x14034c694`）。
const CONTRAST_THRESHOLD: f32 = 2.5;

/// 从封面像素算五个颜色。
pub fn thumbnail_colors(image: &RgbaImage) -> Colors {
    let [c1, c2, c3] = three_colors(image);
    let (text_bw, text_color) = text_colors(c1, c2, c3);
    // 脚本字段名：textColor = 次色 / 第三色 / 黑白值，highContrastColor = 黑白值
    [c1, c2, c3, text_color, text_bw]
}

struct Bins {
    s: [f32; 360],
    v: [f32; 360],
    w: [i64; 360],
    n: [i64; 360],
}

/// 色相格间距（环形，最大 180）。
fn bin_dist(a: usize, b: usize) -> i32 {
    let d = (a as i32 - b as i32).abs();
    if d > 180 {
        360 - d
    } else {
        d
    }
}

fn three_colors(image: &RgbaImage) -> [[u8; 3]; 3] {
    let mut bins = Bins {
        s: [0.0; 360],
        v: [0.0; 360],
        w: [0; 360],
        n: [0; 360],
    };
    let (width, height) = image.dimensions();
    // 外层按列、内层按行，与 WPE 的累加顺序一致（float 累加与顺序有关）
    for x in 0..width {
        for y in 0..height {
            let [r8, g8, b8, a8] = image.get_pixel(x, y).0;
            if a8 < 16 {
                continue;
            }
            let r = r8 as f32 / 255.0;
            let g = g8 as f32 / 255.0;
            let b = b8 as f32 / 255.0;
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            let d = max - min;
            let (bin, s) = if d < 1e-5 || max <= 0.0 {
                (0usize, 0.0f32)
            } else {
                let s = d / max;
                let mut h: f32 = if r < max {
                    if g < max {
                        // b 最大：double 加法后转 float
                        (((r - g) / d) as f64 + 4.0) as f32
                    } else {
                        (((b - r) / d) as f64 + 2.0) as f32
                    }
                } else {
                    (g - b) / d
                };
                h /= 6.0;
                if h < 0.0 {
                    h += 1.0;
                }
                (((h * 360.0) as i32).clamp(0, 359) as usize, s)
            };
            bins.s[bin] += s;
            bins.v[bin] += max;
            bins.w[bin] += ((max * s) * 100.0) as i32 as i64;
            bins.n[bin] += 1;
        }
    }

    let color = |i: Option<usize>| match i {
        None => [0, 0, 0],
        Some(i) => hsv_to_rgb(
            i as f32 / 360.0,
            bins.s[i] / bins.n[i] as f32,
            bins.v[i] / bins.n[i] as f32,
        ),
    };

    // 主色：W 最大（严格大于才替换，初值 0，所以全 0 时不选任何格）
    let mut best: i64 = 0;
    let mut p = None;
    for i in 0..360 {
        if bins.w[i] > best {
            best = bins.w[i];
            p = Some(i);
        }
    }
    // 次色：W · d(i,p)/180；比较前 best 截断成整数
    let mut best: i64 = 0;
    let mut q = None;
    if let Some(p) = p {
        for i in 0..360 {
            let x = bins.w[i] as f32 * (bin_dist(i, p) as f32 / 180.0);
            if (best as f32) < x {
                best = x as i32 as i64;
                q = Some(i);
            }
        }
    }
    // 第三色：W · (d(i,p)/180 · d(i,q)/180)²
    let mut best: i64 = 0;
    let mut r3 = None;
    if let (Some(p), Some(q)) = (p, q) {
        for i in 0..360 {
            let k = ((bin_dist(i, p) as f32 / 180.0) * bin_dist(i, q) as f32) / 180.0;
            let x = bins.w[i] as f32 * k * k;
            if (best as f32) < x {
                best = x as i32 as i64;
                r3 = Some(i);
            }
        }
    }
    [color(p), color(q), color(r3)]
}

/// HSV → RGB（`FUN_140063cc0`）：`h' = fmod(h·6, 6)` 是 double，其余 float；各分量 `(int)(x·255)` 夹到 [0, 255]。
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [u8; 3] {
    let c = v * s;
    let hp = (h as f64 * 6.0) % 6.0;
    let x = c * (1.0 - ((hp % 2.0) - 1.0).abs()) as f32;
    let m = v - c;
    let sector = (hp as i32).clamp(0, 5);
    let (r, g, b) = match sector {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let q = |ch: f32| (((ch + m) * 255.0) as i32).clamp(0, 255) as u8;
    [q(r), q(g), q(b)]
}

/// WCAG 相对亮度（`powf`、float）。
fn luminance(c: [u8; 3]) -> f32 {
    let lin = |v: u8| {
        let x = v as f32 / 255.0;
        if x > 0.03928 {
            ((x + 0.055) / 1.055).powf(2.4)
        } else {
            x / 12.92
        }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

fn contrast(a: [u8; 3], b: [u8; 3]) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// `(黑白值, 文字色)`：黑白值 = 主色对黑的对比度 < 2.5 时白、否则黑；
/// 文字色 = 次色（对比度 ≥ 2.5 且大于第三色的）/ 第三色（≥ 2.5）/ 否则同黑白值。
fn text_colors(c1: [u8; 3], c2: [u8; 3], c3: [u8; 3]) -> ([u8; 3], [u8; 3]) {
    let bw = if contrast(c1, [0, 0, 0]) < CONTRAST_THRESHOLD {
        [255, 255, 255]
    } else {
        [0, 0, 0]
    };
    let k2 = contrast(c1, c2);
    let k3 = contrast(c1, c3);
    let text = if k2 >= CONTRAST_THRESHOLD && k2 > k3 {
        c2
    } else if k3 >= CONTRAST_THRESHOLD {
        c3
    } else {
        bw
    };
    (bw, text)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use image::Rgba;

    const W: u32 = 320;
    const H: u32 = 180;

    /// 按 `ignore/p11/media_colors.py` 的 `make()` 生成的测试封面（320×180）。
    pub fn make(name: &str) -> RgbaImage {
        RgbaImage::from_fn(W, H, |x, _| match name {
            "m1" => Rgba([200, 40, 40, 255]),
            "m2" => {
                if x < 192 {
                    Rgba([30, 120, 220, 255])
                } else {
                    Rgba([240, 200, 40, 255])
                }
            }
            "m3" => {
                if x < 160 {
                    Rgba([220, 30, 30, 255])
                } else if x < 256 {
                    Rgba([30, 200, 60, 255])
                } else {
                    Rgba([40, 60, 230, 255])
                }
            }
            "m4" => {
                let g = (255.0 * x as f64 / (W - 1) as f64) as u8;
                Rgba([g, g, g, 255])
            }
            "m6" => {
                if x < 160 {
                    Rgba([0, 255, 0, 0])
                } else {
                    Rgba([250, 140, 20, 255])
                }
            }
            _ => unreachable!(),
        })
    }

    /// 期望值取 WPE 日志（p11-REPORT），脚本字段名：primary、secondary、tertiary、text、highContrast。
    #[test]
    fn matches_wpe_logs_for_png_covers() {
        let z = [0, 0, 0];
        let cases: [(&str, Colors); 5] = [
            ("m1", [[200, 39, 39], z, z, z, z]),
            ("m2", [[30, 121, 220], [240, 200, 40], z, z, z]),
            ("m3", [[220, 30, 30], [30, 199, 58], [39, 62, 230], z, z]),
            ("m4", [z, z, z, [255; 3], [255; 3]]),
            ("m6", [[250, 138, 20], z, z, z, z]),
        ];
        for (name, expected) in cases {
            assert_eq!(thumbnail_colors(&make(name)), expected, "{name}");
        }
    }

    #[test]
    fn transparent_image_selects_no_bin() {
        // 全部 alpha < 16：不选任何格，三色黑；算法照样跑，主色黑对黑的对比度 1 < 2.5 → 黑白值白，文字色也落到黑白值
        // （同 m4 全灰时 WPE 给的白）。只有「没有封面」才是五色全 0（NO_COLORS，不经这个函数）。
        let image = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 10]));
        assert_eq!(
            thumbnail_colors(&image),
            [
                [0, 0, 0],
                [0, 0, 0],
                [0, 0, 0],
                [255, 255, 255],
                [255, 255, 255]
            ]
        );
    }

    /// `textColor` 与 `highContrastColor` 分开的两例（PNG 夹具里两者都相同，测不出对应关系）：输入的三色与期望值都取 WPE 日志
    /// （`ignore/p11/out/p11-media-log.txt`：m5.jpg 一行，与 Kabegame 预览会话的封面一行）。
    #[test]
    fn text_color_is_the_contrasting_hue_and_high_contrast_is_black_or_white() {
        // m5：p=(112,179,35) s=(101,35,178) t=(184,53,36) → text = s，hc = 黑
        assert_eq!(
            text_colors([112, 179, 35], [101, 35, 178], [184, 53, 36]),
            ([0, 0, 0], [101, 35, 178])
        );
        // 预览会话封面：p=(152,79,118) s=(235,210,194) t=(170,152,188) → text = s，hc = 黑
        assert_eq!(
            text_colors([152, 79, 118], [235, 210, 194], [170, 152, 188]),
            ([0, 0, 0], [235, 210, 194])
        );
    }

    /// 五色的排列：`textColor`（下标 3）是次色、`highContrastColor`（下标 4）是黑。三块色照 m5 的三色，绿占多数。
    #[test]
    fn text_and_high_contrast_slots_are_not_swapped() {
        let image = RgbaImage::from_fn(W, H, |x, _| match x {
            0..=191 => Rgba([112, 179, 35, 255]),
            192..=271 => Rgba([101, 35, 178, 255]),
            _ => Rgba([184, 53, 36, 255]),
        });
        let colors = thumbnail_colors(&image);
        assert_ne!(colors[1], [0, 0, 0]);
        assert_eq!(colors[3], colors[1]);
        assert_eq!(colors[4], [0, 0, 0]);
    }

    #[test]
    fn grey_image_has_no_hue_bin() {
        // 全灰：权重为 0，不选任何格；主色黑 → 黑白值白
        let image = RgbaImage::from_pixel(8, 8, Rgba([128, 128, 128, 255]));
        let colors = thumbnail_colors(&image);
        assert_eq!(colors[0], [0, 0, 0]);
        assert_eq!(colors[4], [255, 255, 255]);
    }
}
