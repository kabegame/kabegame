# 01 色盘提取

## 总体设计思路

色盘提取是一个不碰数据库、不碰异步的纯计算模块 `kabegame_core::media::palette`，对外三样东西：色盘类型 `Palette`、来源描述 `PaletteSource`、入口 `compute(source) -> Option<Palette>`。入库的三个入口与回填作业都先用同一个选择函数 `source_for_row` 从「类型 + 路径」推出来源，再在阻塞线程里调 `compute`。任何一步失败（文件读不了、解码失败、全透明）都返回 `None`，由存储层记成「没有色盘」，不阻断入库。

计算分四步，每步一个函数，方便单测：

1. **采样**：一帧画面 → 至多 256 个区域色。缩到 512×512（不保持宽高比，只是为了让每个区域面积相等），切成 16×16 个区域，每个区域在线性光下按 alpha 加权取平均，转成 OKLab。几乎全透明的区域丢掉。
2. **聚合**：区域色 → 若干聚合点。把全部区域色看成颜色空间里的点，取它们的包围盒中心（各通道最小值与最大值的中点）；从离中心最近的点开始，以它为种子，把离它不超过合并半径的点全部收进同一个聚合点，聚合点的颜色取这些成员的加权平均，然后把这些点取走；再取剩下的点里离中心最近的那个，重复到取完。整个过程中心不变，所以等价于「按到中心的距离排一次序，顺序扫一遍」。色差低的画面会收成一两个聚合点，这就是「色差阈值」的作用；个数由画面决定，不预设。
3. **再并**：聚合点之间，反复把平均色相距最近、且不到合并半径的一对按权重并成一个，直到没有这样的对。上一步里种子落在色团边缘时一块颜色会被拆成几个聚合点，这一步把它们并回去。
4. **选取**：聚合点按占比降序，累计超过 95% 或取满 5 个即停，转回 sRGB 整数与百分比。

多帧来源（视频、GIF）把各帧的区域色合在一起（8 帧至多 2048 个点），聚合一次、再并一次、选取一次。聚合是「排序 + 每个种子扫一遍剩余点」，点数乘聚合点数量级，不需要逐帧先压缩。

几条性质与取舍（数据来自 3.5 万张真实缩略图的对比实验）：

- 种子只用来圈定成员，代表色是成员的平均（在 OKLab 里按权重平均）。种子是这团颜色里离中心最近的点、偏在色团朝向中心的一侧，直接拿它当颜色会让代表色朝整张图的平均色偏；取平均就落回色团中间。
- 只做第 2 步时，比合并半径宽的色团会被拆成几个聚合点：87% 的多色色盘里有两个颜色相差不到合并半径（蓝天出 3–5 个蓝），5 个颜色平均只盖住 86% 的画面，小面积的点缀色被挤掉。加上第 3 步后这个比例降到 1.3%，覆盖升到 95%，耗时没有可测的变化。
- 再并之后，一个代表色可能盖住比两倍半径更宽的一段颜色（并是连锁的）。只剩 1 个颜色的图因此从 0.6% 增到 3%，其中约四成是能看出几种淡色的粉彩插画——淡色在 OKLab 里挤在一起，淡粉与淡蓝的色差可以小于半径，固定半径分不开它们。这是接受的代价。
- 聚合用和距离同一把尺（明度折半）。试过聚合改用不折半的色差：同一种颜色的明暗变化被拆开，97% 的图取满 5 色、只盖住 62% 的画面，不采用。

中心取包围盒中心而不是最小包围球的球心：聚合只用到「离中心多远」这个排序，包围球的半径不参与计算，两种中心排出来的顺序几乎一样，包围盒中心一遍扫描就能得到。

色差函数 `color_diff` 在这里定义，合并半径、到中心的距离与 [02-storage.md](02-storage.md) 的距离算法共用它。

## 现状锚点

**a. 图片解码与缩略图**（`crawler/downloader/compress.rs:703`）

```rust
// 现状：缩略图最长边 ≤ 512；源文件 ≤ 512 KB 且浏览器能显示时不生成，直接拿原图当缩略图。
pub async fn generate_thumbnail(image_path: &Path) -> Result<Option<PathBuf>, String> {
    ...
    if !browser_unsafe && !image_needs_independent_thumbnail(source_size) {
        return Ok(None);
    }
    let img = match image::ImageReader::open(image_path) {
        Ok(mut reader) => {
            reader.no_limits();
            match reader.with_guessed_format() {
                Ok(r) => match r.decode() {
                    Ok(img) => img,
                    // image crate 解不了的（HEIC 等）退到 FFmpeg
                    Err(_) => match crate::media::decode::decode_image_via_ffmpeg(image_path) { ... },
                },
                ...
```

**b. 视频预览只有前 2.5 秒**（`crawler/downloader/compress.rs:119`）

```rust
/// 进程内 FFmpeg（rsmpeg/libav*）转码：解码首个视频流 → scale 缩放 → 编码（无音轨，截取前 2.5s）。
fn run_ffmpeg_transcode(input_path: &Path, output_path: &Path) -> Result<(u32, u32), String> {
    // 预览只取前 2.5s（与旧 ffmpeg `-t 2.5` 一致）。
    const PREVIEW_SECONDS: f64 = 2.5;
```

**c. FFmpeg 解一帧**（`media/decode.rs:310`）

```rust
// 现状：只有「打开文件、解出第一帧」，没有按时间点 seek 的入口。
pub fn decode_image_via_ffmpeg(path: &Path) -> Result<RgbImage, String> {
    let mut fmt = AVFormatContextInput::open(&path_c)...;
    ...
    let stream_index = largest_video_stream_index(&fmt)...;
    decode_streams(&mut fmt, &stream_indices)?.remove(&stream_index)...
}
```

**d. WPE 的 schemecolor**（`wpe/properties.rs:130`）

```rust
// 现状：私有函数，只给视频属性 resolve_video_props_from_raw 用。
/// `"r g b"`（0–1 浮点）→ 8 位 RGB。
fn parse_scheme_color(props: &serde_json::Map<String, Value>) -> Option<[u8; 3]> {
    let raw = prop_value(props, "schemecolor")?.as_str()?.trim();
    ...
}
```

---

## 点 1 — 色盘类型与常量（新文件 `media/palette.rs`）

- **新增**
  - `Palette` / `PaletteColor`，以及与数据库列互转的 `to_json` / `from_json`。
    > 列里的格式是 `[[rgb, 百分比], …]`，如 `[[16711680,62],[16777215,33]]`，按占比降序。
  - 全部可调常量集中在文件头。

```rust
//! 壁纸色盘：最多 5 个代表色及其面积占比，以及色盘到参考色的距离。
//! 纯计算，不碰数据库与异步；入库、回填、现算排序与保存色桶（经宿主 SQL 函数）共用。

/// 采样前缩到的边长（不保持宽高比）。
pub const SAMPLE_SIZE: u32 = 512;
/// 每边切成多少个区域：16×16 = 256 个区域，每个 32×32 像素。
pub const GRID: u32 = 16;
/// 合并半径：离种子不超过它的区域色并进同一个聚合点（`color_diff` 的单位）。
pub const MERGE_RADIUS: f32 = 0.06;
/// 色盘最多几个颜色。
pub const MAX_COLORS: usize = 5;
/// 累计占比超过它就不再取。
pub const COVERAGE: f32 = 0.95;
/// 视频 / 动图抽几帧。
pub const FRAME_SAMPLES: usize = 8;
/// 区域的平均 alpha 低于它时不参与（透明背景）。
const MIN_CELL_ALPHA: f32 = 0.1;

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
    pub fn single(rgb: [u8; 3]) -> Self { ... }            // WPE schemecolor：一个颜色 100%
    pub fn to_json(&self) -> String { ... }                 // "[[rgb,percent],…]"
    pub fn from_json(text: &str) -> Option<Self> { ... }    // 格式不对 / 空数组 → None
}
```

## 点 2 — 色差函数（`media/palette.rs`）

- **新增**
  - `Oklab`、`srgb_to_oklab` / `oklab_to_srgb`（Björn Ottosson 的标准矩阵，sRGB 先解 gamma）。
  - `color_diff`：OKLab 欧氏距离，明度差乘 `LIGHTNESS_WEIGHT`。
    > 说明：合并半径、到中心的距离、到参考色的距离共用这一个函数，「多近算同一个颜色」和「离色桶多远」是同一把尺。

```rust
#[derive(Debug, Clone, Copy)]
pub struct Oklab { pub l: f32, pub a: f32, pub b: f32 }

/// 明度差的权重。1.0 时白色比深绿更接近纯绿（纯绿明度 0.87），折半后色相与彩度占主导。
const LIGHTNESS_WEIGHT: f32 = 0.5;

pub fn color_diff(x: Oklab, y: Oklab) -> f32 {
    let dl = (x.l - y.l) * LIGHTNESS_WEIGHT;
    let da = x.a - y.a;
    let db = x.b - y.b;
    (dl * dl + da * da + db * db).sqrt()
}
```

## 点 3 — 采样（`media/palette.rs`）

- **新增**
  - `sample_cells(frame: &RgbaImage) -> Vec<Cell>`。
    > 实现上允许一步到位（直接对原尺寸按区域做面积平均），结果与「先缩到 512 再每 32×32 平均」在盒式滤波下等价；缩略图本身不到 512 时不放大，直接按比例切 16×16。

```rust
#[derive(Debug, Clone, Copy)]
struct Cell { color: Oklab, weight: f32 }

/// 一帧 → 至多 GRID×GRID 个区域色。
fn sample_cells(frame: &image::RgbaImage) -> Vec<Cell> {
    // 1. 宽或高为 0 → 空
    // 2. 第 (gx, gy) 个区域覆盖像素 [gx*w/GRID, (gx+1)*w/GRID) × [gy*h/GRID, (gy+1)*h/GRID)
    //    （图比 16 像素还小时区域可能为空，跳过）
    // 3. 区域内：sRGB → 线性光，按 alpha 加权累加；平均 alpha < MIN_CELL_ALPHA 的区域丢弃
    // 4. 线性平均色 → Oklab，weight = 1.0
}
```

## 点 4 — 聚合与选取（`media/palette.rs`）

- **新增**
  - `merge_cells`：从包围盒中心向外、按合并半径收点。
  - `remerge`：把平均色相近的聚合点并回去。
  - `select_top`：按占比截取。
  - `palette_from_frames`：单帧 / 多帧共用的编排。

```rust
/// 从包围盒中心向外聚合。
///
/// 1. 中心 = 全部点的包围盒中心（OKLab 各通道最小值与最大值的中点），整个过程不变。
/// 2. 点按到中心的 `color_diff` 升序排一次（并列按输入下标，保证同一输入得到同一结果）。
/// 3. 顺序扫：遇到还没被取走的点，就以它为种子，把剩余点里 `color_diff(种子, 点) <= MERGE_RADIUS`
///    的全部取走，产出一个聚合点：颜色 = 取走的点（含种子）按权重的 OKLab 平均，权重 = 它们的权重之和。
///
/// 到中心的距离与合并半径用同一个 `color_diff`（明度折半）。
fn merge_cells(cells: Vec<Cell>) -> Vec<Cell> { ... }

/// 反复找平均色相距最近的一对聚合点，色差 < MERGE_RADIUS 就按权重并成一个（颜色取加权平均），
/// 直到最近的一对也不小于半径。并列取下标小的一对。聚合点通常只有几十个，朴素扫描即可
/// （实测 8 帧视频最多 2048 个区域色时每个 1.3 毫秒）。
fn remerge(clusters: Vec<Cell>) -> Vec<Cell> { ... }

/// 按权重降序（并列按 rgb 升序），累计占比 > COVERAGE 或取满 MAX_COLORS 即停。
/// 百分比按全部聚合点的总权重算、四舍五入、至少为 1；被截掉的尾部不再分摊。
fn select_top(clusters: Vec<Cell>) -> Option<Palette> { ... }

/// 各帧的区域色合在一起聚合一次。
pub fn palette_from_frames<'a>(frames: impl Iterator<Item = &'a image::RgbaImage>) -> Option<Palette> {
    let cells: Vec<Cell> = frames.flat_map(sample_cells).collect();
    select_top(remerge(merge_cells(cells)))
}
```

行为举例（也是单测用例）：

| 输入 | 色盘 |
|---|---|
| 纯色图（含带轻微噪点的） | 1 个颜色，100% |
| 左半红右半蓝 | 2 个颜色，各 50%（中心在两色中间，两边等距，按下标先取一边） |
| 256 个区域全部落在离中心最近的那个点的合并半径内的渐变 | 1 个颜色，颜色是全部区域的平均 |
| 跨度是合并半径 4 倍的单色渐变 | 第 2 步得到多个聚合点（中间一个盖两倍半径，两侧向外依次各一个）；它们的平均色彼此不到半径时第 3 步并回去，否则保留 |
| 一团颜色被第 2 步拆成两个平均色相近的聚合点 | 第 3 步并成 1 个，颜色是两者按权重的平均 |
| 两团相距远大于半径的颜色，各自内部有小幅变化 | 2 个颜色，各是自己那一团的平均 |
| 色相环（每个区域都不同） | 5 个颜色，累计不到 95%，按占比降序 |
| 全透明 PNG | `None` |
| 透明底上一个红色图标 | 只有红色，100%（透明区域不参与） |

## 点 5 — 视频抽帧（`media/decode.rs`）

- **新增**
  - `sample_video_frames(path, count) -> Result<Vec<RgbImage>, String>`：按时长均匀取 `count` 个时间点（第 i 帧在 `(i + 0.5) / count` 处），每个点 `av_seek_frame` 到最近的关键帧、解出第一帧，复用现有的 `frame_to_rgb`。
    > 时长未知或 seek 失败时只返回从头解出的第一帧（等同现有 `decode_streams`）。只解关键帧附近的一帧，不逐帧解码；8 个点本地文件约 0.1–0.4 秒。
    > 门控与本文件其余函数一致（`cfg(not(target_os = "ios"))`）。Android 的 `content://` 视频沿用现有做法：`ContentIoProvider.open_fd` 后传 `/proc/self/fd/N`。

```rust
/// 在视频时长上均匀取 `count` 个时间点各解一帧。帧数可能少于 count（短视频、seek 失败的点跳过）。
pub fn sample_video_frames(path: &Path, count: usize) -> Result<Vec<RgbImage>, String> { ... }
```

## 点 6 — 来源与入口（`media/palette.rs`）

- **新增**
  - `PaletteSource`、`source_for_row`、`compute`。
    > `source_for_row` 是「什么类型从哪里算」的唯一一处，入库三个入口与回填都调它，不各写一遍分支。

```rust
pub enum PaletteSource {
    /// 静态图：解一帧。
    Still(PathBuf),
    /// GIF：均匀取 FRAME_SAMPLES 帧。
    Animated(PathBuf),
    /// 视频：从 `video` 抽帧；解不了时退到 `fallback`（预览文件，按扩展名当视频或 GIF）。
    Video { video: PathBuf, fallback: Option<PathBuf> },
    /// 已知的单一颜色（WPE schemecolor）。
    Fixed([u8; 3]),
}

/// 一行图片该从哪里算色盘。`None` = 没有可用来源。
///
/// | 类型 | 来源 |
/// |---|---|
/// | `image/gif` | 原文件抽帧 |
/// | 其它图片 | 缩略图（与原图相同或缺失时用原图） |
/// | `video/*` | 原视频抽帧，退到预览文件 |
/// | `x-wpe/video` | `compatible_path`（入口视频或兼容副本）抽帧，退到预览图 |
/// | `x-wpe/web`、`x-wpe/scene` | `scheme_color`，没有则预览图（`thumbnail_path`，GIF 抽帧），再没有则 None |
pub fn source_for_row(
    media_type: &str,
    local_path: &str,
    thumbnail_path: &str,
    compatible_path: Option<&str>,
    scheme_color: Option<[u8; 3]>,
) -> Option<PaletteSource> { ... }

/// 同步、可能读盘与解码，调用方放进阻塞线程。失败一律 None 并 `debug!` 记原因。
pub fn compute(source: &PaletteSource) -> Option<Palette> {
    match source {
        PaletteSource::Fixed(rgb) => Some(Palette::single(*rgb)),
        PaletteSource::Still(path) => palette_from_frames(std::iter::once(&decode_still(path)?)),
        PaletteSource::Animated(path) => palette_from_frames(decode_gif_frames(path)?.iter()),
        PaletteSource::Video { video, fallback } => { /* sample_video_frames → 空则 fallback */ }
    }
}
```

- `decode_still`：`image::ImageReader`（`no_limits` + `with_guessed_format`），失败退到 `decode_image_via_ffmpeg`，与锚点 a 的顺序一致。
- `decode_gif_frames`：`image::codecs::gif::GifDecoder::into_frames()`，按下标均匀留 `FRAME_SAMPLES` 帧；帧数未知，边迭代边按步长留，最多迭代 240 帧。
- Android 上 `local_path` 是 `content://`：图片几乎总有缩略图文件，直接用；GIF 与视频要读原文件时经 `open_fd`。拿不到 fd 就退到缩略图 / 预览（Android 的视频预览本身是 GIF，走 `decode_gif_frames`）。

## 点 7 — 公开 schemecolor 解析（`wpe/properties.rs`）

- **修改**
  - 把 `parse_scheme_color` 包一层按 `project.json` 原文取值的 `pub(crate) fn scheme_color_from_raw(raw: &Value) -> Option<[u8; 3]>`，原函数与 `resolve_video_props_from_raw` 不变。
    > `wpe` 模块受 cargo feature `wpe` 门控。Android / Web 不编译它，那里的 `x-wpe/*` 行（若有）传 `scheme_color: None`，直接走预览图。

```rust
/// `general.properties.schemecolor` 的作者值。
pub(crate) fn scheme_color_from_raw(raw: &Value) -> Option<[u8; 3]> {
    parse_scheme_color(properties(raw)?)     // 新增：复用现有两个私有函数
}
```
