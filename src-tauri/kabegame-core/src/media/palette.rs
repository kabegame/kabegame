//! 壁纸色盘：最多 5 个代表色及其面积占比，以及色盘到参考色的距离。
//! 纯计算，不碰数据库；入库、回填、现算排序与保存色桶（经宿主 SQL 函数）共用。
//! 只有 [`compute_for_row`] 是异步的：它把同步的 [`compute`] 放进阻塞线程。
//!
//! 一帧画面 → 色盘分四步：[`sample_cells`]（切成 16×16 个区域取平均）→ [`merge_cells`]
//! （从包围盒中心向外、按合并半径收点）→ [`remerge`]（把平均色相近的聚合点并回去）→
//! [`select_top`]（按占比取前几个）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::RgbaImage;
use tracing::{debug, warn};

use crate::media::image_type;

/// 采样前缩到的边长。图片从缩略图算（最长边本来就不超过它），视频抽帧时把帧缩到这个范围内
/// （见 `media::decode::sample_video_frames`）；区域平均直接在拿到的尺寸上做，不再缩一次。
pub const SAMPLE_SIZE: u32 = 512;
/// 每边切成多少个区域：16×16 = 256 个区域，512 的图上每个 32×32 像素。
pub const GRID: u32 = 16;
/// 合并半径（`color_diff` 的单位）：聚合时离种子不超过它的区域色并进同一个聚合点，
/// 再并时平均色相距不到它的两个聚合点并成一个。
pub const MERGE_RADIUS: f32 = 0.06;
/// 色盘最多几个颜色。
pub const MAX_COLORS: usize = 5;
/// 累计占比超过它就不再取。
pub const COVERAGE: f32 = 0.95;
/// 视频 / 动图抽几帧。
pub const FRAME_SAMPLES: usize = 8;
/// 区域的平均 alpha 低于它时不参与（透明背景）。
const MIN_CELL_ALPHA: f32 = 0.1;
/// 明度差的权重。1.0 时白色比深绿更接近纯绿（纯绿明度 0.87），折半后色相与彩度占主导。
const LIGHTNESS_WEIGHT: f32 = 0.5;
/// 映射到 [`DISTANCE_MAX`] 的色差。`color_diff` 在 sRGB 色域内的最大值约 0.62（纯绿对品红）。
const DISTANCE_FULL_SCALE: f32 = 0.65;
/// 有色盘的图的最大距离。不取 255：真实图片的距离集中在满量程中间的一小段，按 0..=255 存时
/// 3.5 万张图在每个色桶里只有一百多个不同的值，最大的并列组上千张。
const DISTANCE_MAX: f32 = 65535.0;
/// 没有色盘的图到任何色桶的距离。有色盘的图取 0..=65535，这个值比最大值大 1，
/// 所以类型是 u32（放不进 u16）、列是 INTEGER。
pub const NO_PALETTE_DISTANCE: u32 = 65536;
/// GIF 最多解多少帧（帧数事先不知道，边解边按步长留）。
const GIF_MAX_DECODED_FRAMES: usize = 240;
/// GIF 的格式键（`images.type` 的存储值，定义在 `image_type::MEDIA_FORMATS`）。
const GIF_FORMAT_KEY: &str = "image/gif";

// ---------------------------------------------------------------------------
// 色盘类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaletteColor {
    /// 0xRRGGBB
    pub rgb: u32,
    /// 1..=100
    pub percent: u8,
}

/// 非空，按占比降序。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette(pub Vec<PaletteColor>);

impl Palette {
    /// 只有一个颜色、占 100% 的色盘（WPE 的 `schemecolor`）。
    pub fn single(rgb: [u8; 3]) -> Self {
        let rgb = (u32::from(rgb[0]) << 16) | (u32::from(rgb[1]) << 8) | u32::from(rgb[2]);
        Self(vec![PaletteColor { rgb, percent: 100 }])
    }

    /// 数据库列里的形态：`[[rgb,百分比],…]`，如 `[[16711680,62],[16777215,33]]`。
    pub fn to_json(&self) -> String {
        let mut text = String::with_capacity(2 + self.0.len() * 14);
        text.push('[');
        for (index, color) in self.0.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push_str(&format!("[{},{}]", color.rgb, color.percent));
        }
        text.push(']');
        text
    }

    /// 解析 [`Self::to_json`] 的输出。格式不对、空数组、rgb 超出 24 位或百分比不在 1..=100 → `None`。
    pub fn from_json(text: &str) -> Option<Self> {
        let pairs: Vec<(u32, u8)> = serde_json::from_str(text).ok()?;
        if pairs.is_empty() {
            return None;
        }
        let mut colors = Vec::with_capacity(pairs.len());
        for (rgb, percent) in pairs {
            if rgb > 0x00ff_ffff || !(1..=100).contains(&percent) {
                return None;
            }
            colors.push(PaletteColor { rgb, percent });
        }
        Some(Self(colors))
    }
}

// ---------------------------------------------------------------------------
// 色差
// ---------------------------------------------------------------------------

/// OKLab 颜色（Björn Ottosson）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

/// sRGB 8 位通道 → 线性光的查找表。
fn srgb_to_linear_table() -> &'static [f32; 256] {
    static TABLE: OnceLock<[f32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0.0f32; 256];
        for (value, slot) in table.iter_mut().enumerate() {
            let c = value as f32 / 255.0;
            *slot = if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            };
        }
        table
    })
}

/// 线性光通道（0..=1，超出的夹回去）→ sRGB 8 位。
fn linear_to_srgb_channel(value: f32) -> u8 {
    let c = value.clamp(0.0, 1.0);
    let encoded = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round().clamp(0.0, 255.0) as u8
}

fn linear_to_oklab(r: f32, g: f32, b: f32) -> Oklab {
    let l = 0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    Oklab {
        l: 0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        a: 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        b: 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    }
}

/// `0xRRGGBB` → OKLab（sRGB 先解 gamma）。高 8 位忽略。
pub fn srgb_to_oklab(rgb: u32) -> Oklab {
    let table = srgb_to_linear_table();
    linear_to_oklab(
        table[((rgb >> 16) & 0xff) as usize],
        table[((rgb >> 8) & 0xff) as usize],
        table[(rgb & 0xff) as usize],
    )
}

/// OKLab → `0xRRGGBB`。落在 sRGB 色域外的颜色逐通道夹回去。
pub fn oklab_to_srgb(color: Oklab) -> u32 {
    let l = color.l + 0.396_337_78 * color.a + 0.215_803_76 * color.b;
    let m = color.l - 0.105_561_346 * color.a - 0.063_854_17 * color.b;
    let s = color.l - 0.089_484_18 * color.a - 1.291_485_5 * color.b;
    let (l, m, s) = (l * l * l, m * m * m, s * s * s);
    let r = 4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s;
    let g = -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s;
    let b = -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s;
    (u32::from(linear_to_srgb_channel(r)) << 16)
        | (u32::from(linear_to_srgb_channel(g)) << 8)
        | u32::from(linear_to_srgb_channel(b))
}

/// 两个颜色的色差：OKLab 欧氏距离，明度差乘 [`LIGHTNESS_WEIGHT`]。
///
/// 合并半径、到包围盒中心的距离、到参考色的距离共用这一个函数：「多近算同一个颜色」和
/// 「离色桶多远」是同一把尺。
pub fn color_diff(x: Oklab, y: Oklab) -> f32 {
    let dl = (x.l - y.l) * LIGHTNESS_WEIGHT;
    let da = x.a - y.a;
    let db = x.b - y.b;
    (dl * dl + da * da + db * db).sqrt()
}

// ---------------------------------------------------------------------------
// 采样、聚合、再并、选取
// ---------------------------------------------------------------------------

/// 一个区域色（采样的输出）或一个聚合点（聚合的输出）。
#[derive(Debug, Clone, Copy)]
struct Cell {
    color: Oklab,
    weight: f32,
}

/// 一帧 → 至多 `GRID × GRID` 个区域色，按行优先的区域下标排列。
///
/// 第 `(gx, gy)` 个区域覆盖像素 `[gx*w/GRID, (gx+1)*w/GRID) × [gy*h/GRID, (gy+1)*h/GRID)`，
/// 区域内在线性光下按 alpha 加权取平均。与「先盒式缩到 512×512 再每 32×32 平均」等价，
/// 所以不另外缩图；图不到 512 时也不放大。
fn sample_cells(frame: &RgbaImage) -> Vec<Cell> {
    let (width, height) = frame.dimensions();
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let table = srgb_to_linear_table();
    let raw = frame.as_raw();
    let stride = width as usize * 4;
    let grid = u64::from(GRID);
    let edge = |index: u32, size: u32| (u64::from(index) * u64::from(size) / grid) as usize;

    let mut cells = Vec::with_capacity((GRID * GRID) as usize);
    for gy in 0..GRID {
        let (y0, y1) = (edge(gy, height), edge(gy + 1, height));
        for gx in 0..GRID {
            let (x0, x1) = (edge(gx, width), edge(gx + 1, width));
            // 图比 16 像素还小时区域可能为空
            if x0 == x1 || y0 == y1 {
                continue;
            }
            let mut sum = [0.0f64; 3];
            let mut sum_alpha = 0.0f64;
            for y in y0..y1 {
                let row = &raw[y * stride + x0 * 4..y * stride + x1 * 4];
                for pixel in row.chunks_exact(4) {
                    let alpha = f64::from(pixel[3]) / 255.0;
                    sum[0] += f64::from(table[pixel[0] as usize]) * alpha;
                    sum[1] += f64::from(table[pixel[1] as usize]) * alpha;
                    sum[2] += f64::from(table[pixel[2] as usize]) * alpha;
                    sum_alpha += alpha;
                }
            }
            let pixels = ((x1 - x0) * (y1 - y0)) as f64;
            if sum_alpha / pixels < f64::from(MIN_CELL_ALPHA) {
                continue;
            }
            cells.push(Cell {
                color: linear_to_oklab(
                    (sum[0] / sum_alpha) as f32,
                    (sum[1] / sum_alpha) as f32,
                    (sum[2] / sum_alpha) as f32,
                ),
                weight: 1.0,
            });
        }
    }
    cells
}

/// 从包围盒中心向外聚合。
///
/// 1. 中心 = 全部点的包围盒中心（OKLab 各通道最小值与最大值的中点），整个过程不变。
/// 2. 点按到中心的 `color_diff` 升序排一次（并列按输入下标，保证同一输入得到同一结果）。
/// 3. 顺序扫：遇到还没被取走的点，就以它为种子，把剩余点里 `color_diff(种子, 点) <= MERGE_RADIUS`
///    的全部取走，产出一个聚合点：颜色 = 取走的点（含种子）按权重的 OKLab 平均，权重 = 它们的权重之和。
///
/// 到中心的距离与合并半径用同一个 `color_diff`（明度折半）。输出按种子被取到的先后排列。
fn merge_cells(cells: Vec<Cell>) -> Vec<Cell> {
    let Some(first) = cells.first() else {
        return Vec::new();
    };
    let mut low = first.color;
    let mut high = first.color;
    for cell in &cells {
        low.l = low.l.min(cell.color.l);
        low.a = low.a.min(cell.color.a);
        low.b = low.b.min(cell.color.b);
        high.l = high.l.max(cell.color.l);
        high.a = high.a.max(cell.color.a);
        high.b = high.b.max(cell.color.b);
    }
    let center = Oklab {
        l: (low.l + high.l) / 2.0,
        a: (low.a + high.a) / 2.0,
        b: (low.b + high.b) / 2.0,
    };

    let to_center: Vec<f32> = cells
        .iter()
        .map(|cell| color_diff(cell.color, center))
        .collect();
    let mut order: Vec<usize> = (0..cells.len()).collect();
    order.sort_by(|&x, &y| to_center[x].total_cmp(&to_center[y]).then(x.cmp(&y)));

    let mut taken = vec![false; cells.len()];
    let mut clusters = Vec::new();
    for (position, &seed_index) in order.iter().enumerate() {
        if taken[seed_index] {
            continue;
        }
        let seed = cells[seed_index].color;
        let mut sum = [0.0f64; 3];
        let mut weight = 0.0f64;
        // 排在种子前面的点都已经被取走，只看它自己和后面的
        for &index in &order[position..] {
            if taken[index] {
                continue;
            }
            let cell = cells[index];
            if color_diff(seed, cell.color) > MERGE_RADIUS {
                continue;
            }
            taken[index] = true;
            let w = f64::from(cell.weight);
            sum[0] += f64::from(cell.color.l) * w;
            sum[1] += f64::from(cell.color.a) * w;
            sum[2] += f64::from(cell.color.b) * w;
            weight += w;
        }
        if weight > 0.0 {
            clusters.push(Cell {
                color: Oklab {
                    l: (sum[0] / weight) as f32,
                    a: (sum[1] / weight) as f32,
                    b: (sum[2] / weight) as f32,
                },
                weight: weight as f32,
            });
        }
    }
    clusters
}

/// 把平均色相近的聚合点并回去：反复找平均色相距最近的一对，色差 < [`MERGE_RADIUS`] 就按权重
/// 并成一个（颜色取加权平均，留在下标小的那个位置上），直到最近的一对也不小于半径。
/// 并列取下标小的一对。
///
/// [`merge_cells`] 里种子落在色团朝向中心的一侧，一块颜色常被拆成几个平均色几乎一样的聚合点，
/// 占掉色盘的名额；这一步把它们并回去。并是连锁的，所以并完之后一个代表色可能盖住比两倍半径
/// 更宽的一段颜色。聚合点通常只有几十个，朴素扫描即可（8 帧视频最多 2048 个区域色时实测
/// 每个约 1.3 毫秒）。
fn remerge(mut clusters: Vec<Cell>) -> Vec<Cell> {
    loop {
        let mut closest: Option<(f32, usize, usize)> = None;
        for first in 0..clusters.len() {
            for second in first + 1..clusters.len() {
                let diff = color_diff(clusters[first].color, clusters[second].color);
                if diff < MERGE_RADIUS && closest.map_or(true, |(best, _, _)| diff < best) {
                    closest = Some((diff, first, second));
                }
            }
        }
        let Some((_, first, second)) = closest else {
            return clusters;
        };
        let (x, y) = (clusters[first], clusters[second]);
        let weight = x.weight + y.weight;
        clusters[first] = Cell {
            color: Oklab {
                l: (x.color.l * x.weight + y.color.l * y.weight) / weight,
                a: (x.color.a * x.weight + y.color.a * y.weight) / weight,
                b: (x.color.b * x.weight + y.color.b * y.weight) / weight,
            },
            weight,
        };
        clusters.remove(second);
    }
}

/// 按权重降序（并列按 rgb 升序），累计占比 > [`COVERAGE`] 或取满 [`MAX_COLORS`] 即停。
/// 百分比按全部聚合点的总权重算、四舍五入、至少为 1；被截掉的尾部不再分摊。
fn select_top(clusters: Vec<Cell>) -> Option<Palette> {
    let total: f32 = clusters.iter().map(|cluster| cluster.weight).sum();
    if clusters.is_empty() || total <= 0.0 {
        return None;
    }
    let mut entries: Vec<(u32, f32)> = clusters
        .iter()
        .map(|cluster| (oklab_to_srgb(cluster.color), cluster.weight))
        .collect();
    entries.sort_by(|x, y| y.1.total_cmp(&x.1).then(x.0.cmp(&y.0)));

    let mut colors = Vec::with_capacity(MAX_COLORS);
    let mut covered = 0.0f32;
    for (rgb, weight) in entries {
        let share = weight / total;
        colors.push(PaletteColor {
            rgb,
            percent: (share * 100.0).round().clamp(1.0, 100.0) as u8,
        });
        covered += share;
        if covered > COVERAGE || colors.len() == MAX_COLORS {
            break;
        }
    }
    Some(Palette(colors))
}

fn palette_from_cells(cells: Vec<Cell>) -> Option<Palette> {
    select_top(remerge(merge_cells(cells)))
}

/// 各帧的区域色合在一起，聚合一次、再并一次、选取一次。没有帧、或全部区域都透明时返回 `None`。
pub fn palette_from_frames<'a>(frames: impl Iterator<Item = &'a RgbaImage>) -> Option<Palette> {
    palette_from_cells(frames.flat_map(sample_cells).collect())
}

// ---------------------------------------------------------------------------
// 距离
// ---------------------------------------------------------------------------

/// 色盘到参考色（已换成 OKLab）的距离，0..=65535，越小越接近；没有色盘为 65536。
///
/// 色盘各颜色到参考色的色差按占比加权平均，线性映射到 0..=65535（[`DISTANCE_FULL_SCALE`] 对应 65535）。
/// 宿主 SQL 函数把参考色缓存成 OKLab 后直接调它，和 [`distance_to`] 是同一段代码。
pub fn distance_to_lab(palette: Option<&Palette>, bucket: Oklab) -> u32 {
    let Some(palette) = palette else {
        return NO_PALETTE_DISTANCE;
    };
    let total: f32 = palette.0.iter().map(|c| f32::from(c.percent)).sum();
    if total <= 0.0 {
        // 手工构造的空色盘：当作没有
        return NO_PALETTE_DISTANCE;
    }
    let mean = palette
        .0
        .iter()
        .map(|c| f32::from(c.percent) * color_diff(srgb_to_oklab(c.rgb), bucket))
        .sum::<f32>()
        / total;
    ((mean / DISTANCE_FULL_SCALE) * DISTANCE_MAX)
        .round()
        .clamp(0.0, DISTANCE_MAX) as u32
}

/// 色盘到参考色 `0xRRGGBB` 的距离，0..=65535，越小越接近；没有色盘为 65536。
pub fn distance_to(palette: Option<&Palette>, bucket_rgb: u32) -> u32 {
    distance_to_lab(palette, srgb_to_oklab(bucket_rgb))
}

// ---------------------------------------------------------------------------
// 来源与入口
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaletteSource {
    /// 静态图：解一帧。
    Still(PathBuf),
    /// GIF：均匀取 [`FRAME_SAMPLES`] 帧。
    Animated(PathBuf),
    /// 视频：从 `video` 抽帧；解不了时退到 `fallback`（预览文件，按扩展名当视频或 GIF）。
    Video {
        video: PathBuf,
        fallback: Option<PathBuf>,
    },
    /// 已知的单一颜色（WPE schemecolor）。
    Fixed([u8; 3]),
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 一个媒体文件该怎么读：按扩展名分成视频、GIF、静态图。只看路径，不读盘。
fn source_for_file(path: &Path) -> PaletteSource {
    let format = path
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(image_type::media_format_by_ext);
    match format {
        Some(format) if format.is_video() => PaletteSource::Video {
            video: path.to_path_buf(),
            fallback: None,
        },
        Some(format) if format.key == GIF_FORMAT_KEY => PaletteSource::Animated(path.to_path_buf()),
        _ => PaletteSource::Still(path.to_path_buf()),
    }
}

/// 一行图片该从哪里算色盘。`None` = 没有可用来源。只看类型与路径文本，不读盘。
///
/// | 类型 | 来源 |
/// |---|---|
/// | `image/gif` | 原文件抽帧 |
/// | 其它图片 | 缩略图（与原图相同或缺失时用原图） |
/// | `video/*` | 原视频抽帧，退到预览文件 |
/// | `x-wpe/video` | `compatible_path`（入口视频或兼容副本）抽帧，退到预览图 |
/// | `x-wpe/web`、`x-wpe/scene` | `scheme_color`，没有则预览图（`thumbnail_path`，GIF 抽帧），再没有则 None |
///
/// `media_type` 是 `images.type` 的格式键，也接受标准 MIME。
pub fn source_for_row(
    media_type: &str,
    local_path: &str,
    thumbnail_path: &str,
    compatible_path: Option<&str>,
    scheme_color: Option<[u8; 3]>,
) -> Option<PaletteSource> {
    let local = non_empty(local_path);
    let thumbnail = non_empty(thumbnail_path);

    if image_type::is_wpe_type(Some(media_type)) {
        // `local_path` 是壁纸目录，不能当文件读
        if image_type::is_wpe_video_type(Some(media_type)) {
            if let Some(video) = compatible_path.and_then(non_empty) {
                return Some(PaletteSource::Video {
                    video: PathBuf::from(video),
                    fallback: thumbnail.map(PathBuf::from),
                });
            }
        } else if let Some(rgb) = scheme_color {
            return Some(PaletteSource::Fixed(rgb));
        }
        return thumbnail.map(|path| source_for_file(Path::new(path)));
    }

    if image_type::is_video_like_type(Some(media_type)) {
        let Some(video) = local else {
            return thumbnail.map(|path| source_for_file(Path::new(path)));
        };
        return Some(PaletteSource::Video {
            video: PathBuf::from(video),
            fallback: thumbnail.filter(|path| *path != video).map(PathBuf::from),
        });
    }

    let is_gif =
        image_type::media_format(media_type).is_some_and(|format| format.key == GIF_FORMAT_KEY);
    if is_gif {
        // 缩略图只有第一帧，动图要读原文件
        if let Some(local) = local {
            return Some(PaletteSource::Animated(PathBuf::from(local)));
        }
    }
    thumbnail
        .or(local)
        .map(|path| PaletteSource::Still(PathBuf::from(path)))
}

/// 解一张静态图。`image` crate 解不了的（HEIC 等）退到 FFmpeg，顺序与缩略图生成一致。
fn decode_still(path: &Path) -> Option<RgbaImage> {
    let decoded = image::ImageReader::open(path).ok().and_then(|mut reader| {
        reader.no_limits();
        reader.with_guessed_format().ok()?.decode().ok()
    });
    if let Some(image) = decoded {
        return Some(image.into_rgba8());
    }
    match crate::media::decode::decode_image_via_ffmpeg(path) {
        Ok(image) => Some(image::DynamicImage::ImageRgb8(image).into_rgba8()),
        Err(error) => {
            debug!("palette: cannot decode image {}: {error}", path.display());
            None
        }
    }
}

/// GIF → 均匀取 [`FRAME_SAMPLES`] 帧的区域色。打不开或一帧都解不出来返回 `None`。
///
/// 帧数事先不知道：按步长留帧，留满两倍就丢掉一半、步长翻倍，最后从留下的里均匀取。
/// 留的是每帧的区域色（至多 256 个）而不是整帧画面，内存与帧的尺寸无关。
fn sample_gif_cells(path: &Path) -> Option<Vec<Cell>> {
    use image::AnimationDecoder;

    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            debug!("palette: cannot open gif {}: {error}", path.display());
            return None;
        }
    };
    let decoder = match image::codecs::gif::GifDecoder::new(std::io::BufReader::new(file)) {
        Ok(decoder) => decoder,
        Err(error) => {
            debug!("palette: cannot decode gif {}: {error}", path.display());
            return None;
        }
    };

    let mut kept: Vec<Vec<Cell>> = Vec::with_capacity(FRAME_SAMPLES * 2);
    let mut stride = 1usize;
    for (index, frame) in decoder
        .into_frames()
        .take(GIF_MAX_DECODED_FRAMES)
        .enumerate()
    {
        // 中途坏帧：用已经解出来的
        let Ok(frame) = frame else { break };
        if index % stride != 0 {
            continue;
        }
        kept.push(sample_cells(frame.buffer()));
        if kept.len() == FRAME_SAMPLES * 2 {
            let mut position = 0usize;
            kept.retain(|_| {
                position += 1;
                (position - 1) % 2 == 0
            });
            stride *= 2;
        }
    }
    if kept.is_empty() {
        debug!("palette: gif has no decodable frame: {}", path.display());
        return None;
    }

    let count = kept.len();
    if count <= FRAME_SAMPLES {
        return Some(kept.into_iter().flatten().collect());
    }
    Some(
        (0..FRAME_SAMPLES)
            .flat_map(|slot| {
                kept[(2 * slot + 1) * count / (2 * FRAME_SAMPLES)]
                    .iter()
                    .copied()
            })
            .collect(),
    )
}

/// 从来源算色盘。同步、可能读盘与解码，调用方放进阻塞线程（或用 [`compute_for_row`]）。
/// 失败一律 `None` 并 `debug!` 记原因。
pub fn compute(source: &PaletteSource) -> Option<Palette> {
    match source {
        PaletteSource::Fixed(rgb) => Some(Palette::single(*rgb)),
        PaletteSource::Still(path) => palette_from_frames(std::iter::once(&decode_still(path)?)),
        PaletteSource::Animated(path) => match sample_gif_cells(path) {
            Some(cells) => palette_from_cells(cells),
            // 类型写的是 GIF、内容不是：按静态图再试一次
            None => palette_from_frames(std::iter::once(&decode_still(path)?)),
        },
        PaletteSource::Video { video, fallback } => {
            match crate::media::decode::sample_video_frames(video, FRAME_SAMPLES) {
                Ok(frames) if !frames.is_empty() => {
                    let frames: Vec<RgbaImage> = frames
                        .into_iter()
                        .map(|frame| image::DynamicImage::ImageRgb8(frame).into_rgba8())
                        .collect();
                    return palette_from_frames(frames.iter());
                }
                Ok(_) => debug!("palette: no frame decoded from {}", video.display()),
                Err(error) => {
                    debug!("palette: cannot sample video {}: {error}", video.display())
                }
            }
            let fallback = fallback.as_deref()?;
            compute(&source_for_file(fallback))
        }
    }
}

/// 入库入口用：[`source_for_row`] + 在阻塞线程里 [`compute`]。尽力而为，任何失败都返回 `None`，
/// 不阻断入库。Android 上 `content://` 的原文件先经 `ContentIoProvider.open_fd` 换成
/// `/proc/self/fd/N` 再读。
pub async fn compute_for_row(
    media_type: &str,
    local_path: &str,
    thumbnail_path: &str,
    compatible_path: Option<&str>,
    scheme_color: Option<[u8; 3]>,
) -> Option<Palette> {
    let source = source_for_row(
        media_type,
        local_path,
        thumbnail_path,
        compatible_path,
        scheme_color,
    )?;

    #[cfg(target_os = "android")]
    let (source, content_fd) = open_content_source(source, thumbnail_path).await;

    let task = tokio::task::spawn_blocking(move || {
        let palette = compute(&source);
        // fd 在阻塞任务里持有到解码结束：FFmpeg / image 打开 `/proc/self/fd/N` 时各自 open() 出副本
        #[cfg(target_os = "android")]
        drop(content_fd);
        palette
    });
    match task.await {
        Ok(palette) => palette,
        Err(error) => {
            warn!("palette task failed: {error}");
            None
        }
    }
}

/// Android：来源的原文件是 `content://` 时换成 `/proc/self/fd/N`，并把 fd 交给调用方持有。
/// 拿不到 fd：视频留给 [`compute`] 自己退到预览文件，图片改读缩略图文件。
#[cfg(target_os = "android")]
async fn open_content_source(
    source: PaletteSource,
    thumbnail_path: &str,
) -> (PaletteSource, Option<std::os::fd::OwnedFd>) {
    use std::os::fd::{FromRawFd, OwnedFd};

    const CONTENT_SCHEME: &str = "content://";
    let uri = match &source {
        PaletteSource::Still(path)
        | PaletteSource::Animated(path)
        | PaletteSource::Video { video: path, .. } => path
            .to_str()
            .filter(|text| text.starts_with(CONTENT_SCHEME))
            .map(str::to_string),
        PaletteSource::Fixed(_) => None,
    };
    let Some(uri) = uri else {
        return (source, None);
    };

    match crate::crawler::content_io::get_content_io_provider()
        .open_fd(&uri)
        .await
    {
        Ok(fd) => {
            let owned = unsafe { OwnedFd::from_raw_fd(fd) };
            let proc_path = PathBuf::from(format!("/proc/self/fd/{fd}"));
            let source = match source {
                PaletteSource::Still(_) => PaletteSource::Still(proc_path),
                PaletteSource::Animated(_) => PaletteSource::Animated(proc_path),
                PaletteSource::Video { fallback, .. } => PaletteSource::Video {
                    video: proc_path,
                    fallback,
                },
                fixed @ PaletteSource::Fixed(_) => fixed,
            };
            (source, Some(owned))
        }
        Err(error) => {
            debug!("palette: open_fd failed for {uri}: {error}");
            let thumbnail =
                non_empty(thumbnail_path).filter(|path| !path.starts_with(CONTENT_SCHEME));
            let source = match (source, thumbnail) {
                (PaletteSource::Still(_) | PaletteSource::Animated(_), Some(thumbnail)) => {
                    source_for_file(Path::new(thumbnail))
                }
                (source, _) => source,
            };
            (source, None)
        }
    }
}

#[cfg(test)]
mod tests;
