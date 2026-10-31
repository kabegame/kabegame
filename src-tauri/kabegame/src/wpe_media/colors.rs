//! 封面配色：WPE 的封面回调除了图片还给五个颜色（主色三个、文字色、高对比色）。官方没写算法与格式，这里
//! 用量化直方图按像素占比取三个主色，文字色取与主色对比度够的那个，输出 CSS `rgb(r, g, b)`（页面通常直接赋给 style）。

use image::RgbaImage;
use std::collections::HashMap;

/// WCAG 正文对比度门槛。
const TEXT_CONTRAST: f32 = 4.5;
/// 两个主色至少相差这么远（RGB 欧氏距离），否则视为同一种颜色。
const DISTINCT_DISTANCE: f32 = 48.0;

const BLACK: Rgb = Rgb([0, 0, 0]);
const WHITE: Rgb = Rgb([255, 255, 255]);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rgb([u8; 3]);

impl Rgb {
    fn css(self) -> String {
        let [r, g, b] = self.0;
        format!("rgb({r}, {g}, {b})")
    }

    fn distance(self, other: Rgb) -> f32 {
        self.0
            .iter()
            .zip(other.0)
            .map(|(a, b)| (*a as f32 - b as f32).powi(2))
            .sum::<f32>()
            .sqrt()
    }

    /// WCAG 相对亮度。
    fn luminance(self) -> f32 {
        let linear = |c: u8| {
            let c = c as f32 / 255.0;
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let [r, g, b] = self.0;
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    fn contrast(self, other: Rgb) -> f32 {
        let (a, b) = (self.luminance(), other.luminance());
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    /// 黑白里与它对比度更高的那个。
    fn high_contrast(self) -> Rgb {
        if self.contrast(WHITE) >= self.contrast(BLACK) {
            WHITE
        } else {
            BLACK
        }
    }
}

/// 封面回调的五个颜色。
pub struct ThumbnailColors {
    pub primary: String,
    pub secondary: String,
    pub tertiary: String,
    pub text: String,
    pub high_contrast: String,
}

/// 没有封面时用的颜色：深灰底、白字。
pub fn default_colors() -> ThumbnailColors {
    format_colors([Rgb([32, 32, 32]); 3])
}

/// 从（已缩小的）封面算五个颜色；全透明的图退回 [`default_colors`]。
pub fn thumbnail_colors(image: &RgbaImage) -> ThumbnailColors {
    match dominant_colors(image) {
        Some(colors) => format_colors(colors),
        None => default_colors(),
    }
}

fn format_colors([primary, secondary, tertiary]: [Rgb; 3]) -> ThumbnailColors {
    let text = text_color(primary, secondary, tertiary);
    ThumbnailColors {
        primary: primary.css(),
        secondary: secondary.css(),
        tertiary: tertiary.css(),
        text: text.css(),
        high_contrast: primary.high_contrast().css(),
    }
}

/// 文字色：次色、第三色里先满足对比度的那个，都不够就用黑白里对比更高的（总能到 4.5 左右）。
fn text_color(primary: Rgb, secondary: Rgb, tertiary: Rgb) -> Rgb {
    [secondary, tertiary]
        .into_iter()
        .find(|c| primary.contrast(*c) >= TEXT_CONTRAST)
        .unwrap_or_else(|| primary.high_contrast())
}

/// 按像素占比排序的三个主色：每通道量化到 16 级做直方图，桶内取平均色；与已选颜色太近的跳过，
/// 不够三个就重复最后一个。忽略半透明以下的像素。
fn dominant_colors(image: &RgbaImage) -> Option<[Rgb; 3]> {
    let mut buckets: HashMap<[u8; 3], (u32, [u64; 3])> = HashMap::new();
    for pixel in image.pixels() {
        let [r, g, b, a] = pixel.0;
        if a < 128 {
            continue;
        }
        let entry = buckets.entry([r >> 4, g >> 4, b >> 4]).or_default();
        entry.0 += 1;
        entry.1[0] += r as u64;
        entry.1[1] += g as u64;
        entry.1[2] += b as u64;
    }
    let mut ranked: Vec<_> = buckets
        .into_iter()
        .map(|(key, (count, sum))| {
            let n = count as u64;
            let color = Rgb([(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8]);
            (count, key, color)
        })
        .collect();
    // 占比相同时按量化键排序，结果与 HashMap 的遍历顺序无关
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut picked: Vec<Rgb> = Vec::with_capacity(3);
    for (_, _, color) in ranked {
        if picked.len() == 3 {
            break;
        }
        if picked
            .iter()
            .all(|p| p.distance(color) >= DISTINCT_DISTANCE)
        {
            picked.push(color);
        }
    }
    let last = *picked.last()?;
    picked.resize(3, last);
    Some([picked[0], picked[1], picked[2]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn parse(css: &str) -> Rgb {
        let inner = css.trim_start_matches("rgb(").trim_end_matches(')');
        let parts: Vec<u8> = inner.split(", ").map(|v| v.parse().unwrap()).collect();
        Rgb([parts[0], parts[1], parts[2]])
    }

    #[test]
    fn solid_image_has_three_equal_colors() {
        let image = RgbaImage::from_pixel(64, 64, Rgba([200, 30, 60, 255]));
        let colors = thumbnail_colors(&image);
        assert_eq!(colors.primary, "rgb(200, 30, 60)");
        assert_eq!(colors.secondary, colors.primary);
        assert_eq!(colors.tertiary, colors.primary);
    }

    #[test]
    fn black_with_white_text_has_white_high_contrast() {
        let mut image = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 255]));
        for x in 10..54 {
            for y in 28..36 {
                image.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let colors = thumbnail_colors(&image);
        assert_eq!(colors.primary, "rgb(0, 0, 0)");
        assert_eq!(colors.secondary, "rgb(255, 255, 255)");
        assert_eq!(colors.high_contrast, "rgb(255, 255, 255)");
        assert_eq!(colors.text, "rgb(255, 255, 255)");
    }

    #[test]
    fn text_color_contrasts_with_primary() {
        // 各种底色（含与黑白对比都最弱的中灰）
        for base in [
            [128, 128, 128],
            [119, 119, 119],
            [250, 220, 40],
            [20, 40, 160],
            [90, 200, 120],
        ] {
            let mut image = RgbaImage::from_pixel(64, 64, Rgba([base[0], base[1], base[2], 255]));
            // 少量相近的杂色，次色与第三色对比不够
            for x in 0..8 {
                image.put_pixel(
                    x,
                    0,
                    Rgba([base[0].saturating_add(30), base[1], base[2], 255]),
                );
            }
            let colors = thumbnail_colors(&image);
            let contrast = parse(&colors.primary).contrast(parse(&colors.text));
            assert!(contrast >= TEXT_CONTRAST, "{base:?}: {contrast}");
        }
    }

    #[test]
    fn transparent_image_falls_back_to_defaults() {
        let image = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 0]));
        assert_eq!(thumbnail_colors(&image).primary, default_colors().primary);
    }
}
