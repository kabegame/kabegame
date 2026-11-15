//! 系统媒体读数的两个投影（纯逻辑，不碰 WinRT，便于喂假读数单测）。
//!
//! 监视线程（`media.rs`）每次读一次系统数据，交给两个投影：
//! - **网页投影**：Phase 8 为网页壁纸做的行为原样保留——时间轴每秒外推、封面缩到长边 512 的 data URL、
//!   `contentType` 缺省 `music`、去重状态自己持有；只有五个颜色换成 WPE 的算法。
//! - **场景投影**：照 WPE `winrtutil64.exe` 逐条做——取值与超长清空、时间轴整秒且不外推、封面原尺寸 PNG、
//!   没有会话时复位、每类和上次发出的值比较，相同不发（初值是缺省值，所以缺省值一开始不发）。
//!
//! 封面的解码、Spotify 预处理与配色两个投影共用，同一份字节只解一次。

use super::colors::{thumbnail_colors, Colors, NO_COLORS};
use super::{WpeMediaFlavor, WpeMediaMessage};
use base64::Engine;
use image::{DynamicImage, RgbaImage};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

/// 场景属性里 `title` / `artist` / `genres` 的字节上限，超过整段清空。
const LONG_FIELD_MAX: usize = 0x400;
/// `subTitle` / `albumTitle` / `albumArtist` 的字节上限。
const SHORT_FIELD_MAX: usize = 0x100;
/// 网页壁纸封面长边上限（Phase 8 保留）。
const WEB_THUMBNAIL_MAX_SIDE: u32 = 512;

/// 一次属性读取（`TryGetMediaPropertiesAsync`）的结果。
#[derive(Debug, Clone, Default)]
pub struct RawProperties {
    /// 会话的 `SourceAppUserModelId`
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub sub_title: String,
    pub album_title: String,
    pub album_artist: String,
    pub genres: Vec<String>,
    /// `MediaPlaybackType` 原值：1 音乐、2 视频、3 图片，其余（含空引用）0
    pub playback_type: i32,
    /// 封面流的原始字节；没有封面或读不出为 `None`
    pub thumbnail: Option<Vec<u8>>,
}

/// 一次时间轴读取，全部是 100 ns 计数（`TimeSpan.Duration` / `DateTime.UniversalTime`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawTimeline {
    pub position: i64,
    pub start: i64,
    pub end: i64,
    /// 读数时间（1601 起）；0 表示播放器没给
    pub updated: i64,
}

/// 投影的一条输出：发给哪种订阅、什么消息。
#[derive(Debug, Clone, PartialEq)]
pub struct Output {
    pub flavor: WpeMediaFlavor,
    pub message: WpeMediaMessage,
}

/// 两个投影加共用的封面解码缓存。
#[derive(Default)]
pub struct Projections {
    web: WebProjection,
    scene: SceneProjection,
    cache: DecodeCache,
}

impl Projections {
    /// 换到新会话之前：丢掉网页投影的时间轴基准（场景投影靠去重，不需要）。
    pub fn detach(&mut self) {
        self.web.timeline = None;
    }

    /// 当前没有任何会话：网页投影推空属性 / 无封面 / 状态 0；场景投影各类回到缺省值，和上次不同才发。
    pub fn no_session(&mut self, now: i64) -> Vec<Output> {
        let mut out = Vec::new();
        let mut web = Vec::new();
        self.web.properties(None, None, None, &mut web);
        self.web.playback(0, now, &mut web);
        self.web.set_timeline(None, now, &mut web);
        push_all(&mut out, WpeMediaFlavor::Web, web);
        let mut scene = Vec::new();
        self.scene.reset(&mut scene);
        push_all(&mut out, WpeMediaFlavor::Scene, scene);
        out
    }

    /// 有会话时的属性与封面。`None` 表示这次读取失败：网页投影按空属性处理（原行为），场景投影什么都不做。
    pub fn properties(&mut self, raw: Option<&RawProperties>) -> Vec<Output> {
        let (key, decoded) = match raw {
            Some(raw) => self.cache.get(raw),
            None => (None, None),
        };
        let mut out = Vec::new();
        let mut web = Vec::new();
        self.web.properties(raw, key, decoded.as_deref(), &mut web);
        push_all(&mut out, WpeMediaFlavor::Web, web);
        if let Some(raw) = raw {
            let mut scene = Vec::new();
            self.scene.properties(raw, decoded.as_deref(), &mut scene);
            push_all(&mut out, WpeMediaFlavor::Scene, scene);
        }
        out
    }

    /// 播放状态（Playing 1、Paused 2、其余 0）。场景投影只比较同值、不重推时间轴。
    pub fn playback(&mut self, state: u8, now: i64) -> Vec<Output> {
        let mut out = Vec::new();
        let mut web = Vec::new();
        self.web.playback(state, now, &mut web);
        push_all(&mut out, WpeMediaFlavor::Web, web);
        let mut scene = Vec::new();
        self.scene.playback(state, &mut scene);
        push_all(&mut out, WpeMediaFlavor::Scene, scene);
        out
    }

    /// 时间轴读数；`None` 是读取失败（网页投影清掉基准、场景投影不动）。
    pub fn timeline(&mut self, raw: Option<RawTimeline>, now: i64) -> Vec<Output> {
        let mut out = Vec::new();
        let mut web = Vec::new();
        self.web.set_timeline(raw, now, &mut web);
        push_all(&mut out, WpeMediaFlavor::Web, web);
        if let Some(raw) = raw {
            let mut scene = Vec::new();
            self.scene.timeline(raw, &mut scene);
            push_all(&mut out, WpeMediaFlavor::Scene, scene);
        }
        out
    }

    /// 每秒一次：只有网页投影外推时间轴。
    pub fn tick(&mut self, now: i64) -> Vec<Output> {
        let mut out = Vec::new();
        let mut web = Vec::new();
        self.web.tick(now, &mut web);
        push_all(&mut out, WpeMediaFlavor::Web, web);
        out
    }
}

fn push_all(out: &mut Vec<Output>, flavor: WpeMediaFlavor, messages: Vec<WpeMediaMessage>) {
    out.extend(
        messages
            .into_iter()
            .map(|message| Output { flavor, message }),
    );
}

// ───────────────────────── 封面解码（共用）─────────────────────────

/// 解码后的封面：Spotify 预处理之后的原尺寸 PNG、五色、网页用的缩图 data URL。
struct Decoded {
    scene_png: Vec<u8>,
    colors: Colors,
    web_url: String,
}

#[derive(Default)]
struct DecodeCache {
    key: Option<u64>,
    value: Option<Rc<Decoded>>,
}

impl DecodeCache {
    /// 返回 `(字节键, 解码结果)`；没有封面字节时键为 `None`。解码失败按无封面处理（结果 `None`，键仍在）。
    fn get(&mut self, raw: &RawProperties) -> (Option<u64>, Option<Rc<Decoded>>) {
        let Some(bytes) = raw.thumbnail.as_ref().filter(|b| !b.is_empty()) else {
            return (None, None);
        };
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        raw.app_id.to_lowercase().hash(&mut hasher);
        bytes.hash(&mut hasher);
        let key = hasher.finish();
        if self.key != Some(key) {
            self.value = decode(bytes, &raw.app_id)
                .map_err(|error| tracing::debug!("封面解码失败，按无封面处理: {error}"))
                .ok()
                .map(Rc::new);
            self.key = Some(key);
        }
        (Some(key), self.value.clone())
    }
}

fn decode(bytes: &[u8], app_id: &str) -> Result<Decoded, image::ImageError> {
    let mut rgba = image::load_from_memory(bytes)?.to_rgba8();
    if app_id.to_lowercase().starts_with("spotify") {
        rgba = spotify_preprocess(rgba);
    }
    let colors = thumbnail_colors(&rgba);
    let image = DynamicImage::ImageRgba8(rgba);
    let mut scene_png = Vec::new();
    image.write_to(
        &mut std::io::Cursor::new(&mut scene_png),
        image::ImageFormat::Png,
    )?;
    let web_image = if image.width().max(image.height()) > WEB_THUMBNAIL_MAX_SIDE {
        image.thumbnail(WEB_THUMBNAIL_MAX_SIDE, WEB_THUMBNAIL_MAX_SIDE)
    } else {
        image
    };
    let mut web_png = Vec::new();
    web_image.write_to(
        &mut std::io::Cursor::new(&mut web_png),
        image::ImageFormat::Png,
    )?;
    Ok(Decoded {
        scene_png,
        colors,
        web_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&web_png)
        ),
    })
}

/// WPE 对来源 App ID 以 `spotify` 开头的封面做的预处理（rea-p11-textures 3.1 第 3 步，常数 0.06 / 0.4 都是 float）：
/// 去掉 Spotify 的透明边，或把角标区的半透明像素改成灰。判定行取 `y = (int)(0.4h)`【推：读码没写取哪一行，按两个探测点的行】。
fn spotify_preprocess(image: RgbaImage) -> RgbaImage {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return image;
    }
    let alpha = |x: i64, y: i64| -> Option<u8> {
        (x >= 0 && y >= 0 && (x as u32) < w && (y as u32) < h)
            .then(|| image.get_pixel(x as u32, y as u32).0[3])
    };
    let (wf, hf) = (w as f32, h as f32);
    let x_left = (0.06f32 * wf) as i64;
    let x_right = (wf - 0.06f32 * wf) as i64;
    let row = (0.4f32 * hf) as i64;
    if alpha(x_left, row) == Some(0) && alpha(x_right, row) == Some(0) {
        // 从 x_left 向右找第一个 alpha ≠ 0 的列，最多走 w/2 步
        let found = (0..(w / 2) as i64)
            .map(|k| x_left + k)
            .find(|&x| alpha(x, row).is_some_and(|a| a != 0));
        if let Some(l) = found {
            let side = w as i64 - 2 * l;
            let slack = 2 * l - w as i64 + h as i64;
            // 0 ≤ L < 0.4w 且 0 ≤ 2L − w + h < 0.4h 才裁成左上角在 (L, 0)、边长 w − 2L 的正方形
            if l >= 0
                && (l as f32) < 0.4f32 * wf
                && slack >= 0
                && (slack as f32) < 0.4f32 * hf
                && side > 0
            {
                return image::imageops::crop_imm(&image, l as u32, 0, side as u32, side as u32)
                    .to_image();
            }
        }
        return image;
    }
    // 【推】「否则若」按外层 if 的 else 解读：上下两点不都透明、且顶边中点透明时，把角标区改灰
    if alpha((w / 2) as i64, 0) == Some(0) {
        let mut image = image;
        for y in 77..227u32.min(h) {
            for x in 44..256u32.min(w) {
                let pixel = image.get_pixel_mut(x, y);
                let a = pixel.0[3];
                if a != 255 {
                    pixel.0 = [a, a, a, 255];
                }
            }
        }
        return image;
    }
    image
}

// ───────────────────────── 场景投影 ─────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
struct SceneProps {
    title: String,
    artist: String,
    sub_title: String,
    album_title: String,
    album_artist: String,
    genres: String,
    content_type: String,
}

impl SceneProps {
    fn from_raw(raw: &RawProperties) -> Self {
        // 超长（按 UTF-8 字节）整段清空
        let limit = |s: &str, max: usize| {
            if s.len() > max {
                String::new()
            } else {
                s.to_string()
            }
        };
        Self {
            title: limit(&raw.title, LONG_FIELD_MAX),
            artist: limit(&raw.artist, LONG_FIELD_MAX),
            sub_title: limit(&raw.sub_title, SHORT_FIELD_MAX),
            album_title: limit(&raw.album_title, SHORT_FIELD_MAX),
            album_artist: limit(&raw.album_artist, SHORT_FIELD_MAX),
            genres: limit(&raw.genres.join(","), LONG_FIELD_MAX),
            content_type: match raw.playback_type {
                1 => "music",
                2 => "video",
                3 => "image",
                _ => "",
            }
            .to_string(),
        }
    }

    fn message(&self) -> WpeMediaMessage {
        WpeMediaMessage::Properties {
            title: self.title.clone(),
            artist: self.artist.clone(),
            sub_title: self.sub_title.clone(),
            album_title: self.album_title.clone(),
            album_artist: self.album_artist.clone(),
            genres: self.genres.clone(),
            content_type: self.content_type.clone(),
        }
    }
}

/// 每类「上次发出的值」，初值是缺省值。
#[derive(Default)]
struct SceneProjection {
    props: SceneProps,
    /// 上次发出的封面 PNG 字节；空表示无封面
    png: Vec<u8>,
    playback: u8,
    /// 上次发出的 `(position, duration)` 整秒
    timeline: (i64, i64),
}

impl SceneProjection {
    /// 先比属性、再比封面（封面比重新编码后的 PNG 字节，含有 → 无）。
    fn properties(
        &mut self,
        raw: &RawProperties,
        decoded: Option<&Decoded>,
        out: &mut Vec<WpeMediaMessage>,
    ) {
        let props = SceneProps::from_raw(raw);
        if props != self.props {
            out.push(props.message());
            self.props = props;
        }
        let png: &[u8] = decoded.map_or(&[], |d| d.scene_png.as_slice());
        if png != self.png.as_slice() {
            self.png = png.to_vec();
            out.push(scene_thumbnail(decoded));
        }
    }

    fn playback(&mut self, state: u8, out: &mut Vec<WpeMediaMessage>) {
        if state != self.playback {
            self.playback = state;
            out.push(WpeMediaMessage::Playback { state });
        }
    }

    /// 整秒截断（向零）：`position = Position`、`duration = EndTime`（不减 `StartTime`）。
    fn timeline(&mut self, raw: RawTimeline, out: &mut Vec<WpeMediaMessage>) {
        const SECOND: i64 = 10_000_000;
        let current = (raw.position / SECOND, raw.end / SECOND);
        if current != self.timeline {
            self.timeline = current;
            out.push(WpeMediaMessage::Timeline {
                position: current.0 as f64,
                duration: current.1 as f64,
            });
        }
    }

    /// 没有会话：各类回到缺省值，和上次不同才发（顺序同 WPE：属性、封面、播放、时间轴）。
    fn reset(&mut self, out: &mut Vec<WpeMediaMessage>) {
        let default = SceneProps::default();
        if self.props != default {
            self.props = default;
            out.push(self.props.message());
        }
        if !self.png.is_empty() {
            self.png.clear();
            out.push(scene_thumbnail(None));
        }
        self.playback(0, out);
        if self.timeline != (0, 0) {
            self.timeline = (0, 0);
            out.push(WpeMediaMessage::Timeline {
                position: 0.0,
                duration: 0.0,
            });
        }
    }
}

fn scene_thumbnail(decoded: Option<&Decoded>) -> WpeMediaMessage {
    match decoded {
        Some(d) => WpeMediaMessage::SceneThumbnail {
            png: base64::engine::general_purpose::STANDARD.encode(&d.scene_png),
            colors: d.colors,
        },
        None => WpeMediaMessage::SceneThumbnail {
            png: String::new(),
            colors: NO_COLORS,
        },
    }
}

// ───────────────────────── 网页投影 ─────────────────────────

/// 时间轴的最后一次读数，用来在播放中外推位置。
#[derive(Clone, Copy)]
struct Timeline {
    position: f64,
    duration: f64,
    /// 读数时间（1601 起的 100ns）；0 表示播放器没给
    updated: i64,
}

impl Timeline {
    /// `now` 时刻的位置：播放中按读数时间外推；读数时间在未来或过于久远都不可信，不外推。
    fn position_at(&self, playing: bool, now: i64) -> f64 {
        if !playing || self.updated <= 0 {
            return self.position;
        }
        let elapsed = (now - self.updated) as f64 / 1e7;
        if (0.0..86_400.0).contains(&elapsed) {
            (self.position + elapsed).min(self.duration)
        } else {
            self.position
        }
    }

    /// 以 `now` 为新读数时间，位置取按 `playing` 外推到 `now` 的值。
    fn rebased(self, playing: bool, now: i64) -> Self {
        Self {
            position: self.position_at(playing, now),
            updated: now,
            ..self
        }
    }
}

#[derive(Default)]
struct WebProjection {
    last_properties: Option<WpeMediaMessage>,
    /// 上次推送的封面字节哈希；外层 None 表示还没推过
    last_thumbnail: Option<Option<u64>>,
    last_playback: Option<u8>,
    timeline: Option<Timeline>,
    last_timeline: Option<(f64, f64)>,
}

impl WebProjection {
    /// 属性与封面：`raw` 为 `None`（没有会话或读取失败）时都清空。
    fn properties(
        &mut self,
        raw: Option<&RawProperties>,
        thumbnail_key: Option<u64>,
        decoded: Option<&Decoded>,
        out: &mut Vec<WpeMediaMessage>,
    ) {
        let message = match raw {
            Some(raw) => WpeMediaMessage::Properties {
                title: raw.title.clone(),
                artist: raw.artist.clone(),
                sub_title: raw.sub_title.clone(),
                album_title: raw.album_title.clone(),
                album_artist: raw.album_artist.clone(),
                genres: raw.genres.join(","),
                content_type: match raw.playback_type {
                    2 => "video",
                    3 => "image",
                    _ => "music",
                }
                .to_string(),
            },
            None => WpeMediaMessage::Properties {
                title: String::new(),
                artist: String::new(),
                sub_title: String::new(),
                album_title: String::new(),
                album_artist: String::new(),
                genres: String::new(),
                content_type: "music".to_string(),
            },
        };
        if self.last_properties.as_ref() != Some(&message) {
            self.last_properties = Some(message.clone());
            out.push(message);
        }
        // 封面：按字节哈希判断是否变化
        if self.last_thumbnail == Some(thumbnail_key) {
            return;
        }
        self.last_thumbnail = Some(thumbnail_key);
        out.push(match decoded {
            Some(d) => web_thumbnail(d.web_url.clone(), d.colors),
            None => web_thumbnail(String::new(), NO_COLORS),
        });
    }

    /// 播放状态切换时不重读时间轴，按旧状态外推的位置作新基准。
    fn playback(&mut self, state: u8, now: i64, out: &mut Vec<WpeMediaMessage>) {
        if self.last_playback != Some(state) {
            let was_playing = self.last_playback == Some(1);
            if let Some(timeline) = self.timeline.as_mut() {
                *timeline = timeline.rebased(was_playing, now);
            }
            self.last_playback = Some(state);
            out.push(WpeMediaMessage::Playback { state });
            self.push_timeline(now, out);
        }
    }

    /// 重新读时间轴；播放器不提供（`EndTime` 不大于 `StartTime`）或读取失败就不推。
    fn set_timeline(&mut self, raw: Option<RawTimeline>, now: i64, out: &mut Vec<WpeMediaMessage>) {
        self.timeline = raw.and_then(|raw| {
            let duration = (raw.end - raw.start) as f64 / 1e7;
            (duration > 0.0).then(|| Timeline {
                position: ((raw.position - raw.start) as f64 / 1e7).clamp(0.0, duration),
                duration,
                updated: raw.updated,
            })
        });
        self.push_timeline(now, out);
    }

    fn tick(&mut self, now: i64, out: &mut Vec<WpeMediaMessage>) {
        if self.last_playback == Some(1) {
            self.push_timeline(now, out);
        }
    }

    fn push_timeline(&mut self, now: i64, out: &mut Vec<WpeMediaMessage>) {
        let Some(timeline) = self.timeline else {
            return;
        };
        let position = timeline.position_at(self.last_playback == Some(1), now);
        let current = (position, timeline.duration);
        let changed = match self.last_timeline {
            Some((last_position, last_duration)) => {
                (last_position - position).abs() >= 0.05 || last_duration != timeline.duration
            }
            None => true,
        };
        if changed {
            self.last_timeline = Some(current);
            out.push(WpeMediaMessage::Timeline {
                position,
                duration: timeline.duration,
            });
        }
    }
}

fn web_thumbnail(url: String, colors: Colors) -> WpeMediaMessage {
    let css = |c: [u8; 3]| format!("rgb({}, {}, {})", c[0], c[1], c[2]);
    WpeMediaMessage::Thumbnail {
        thumbnail: url,
        primary_color: css(colors[0]),
        secondary_color: css(colors[1]),
        tertiary_color: css(colors[2]),
        text_color: css(colors[3]),
        high_contrast_color: css(colors[4]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wpe_media::colors::tests::make;
    use image::Rgba;

    const SECOND: i64 = 10_000_000;

    fn png_of(image: &RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(image.clone())
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    fn props(title: &str) -> RawProperties {
        RawProperties {
            app_id: "player.exe".into(),
            title: title.into(),
            playback_type: 1,
            ..Default::default()
        }
    }

    fn scene(out: Vec<Output>) -> Vec<WpeMediaMessage> {
        out.into_iter()
            .filter(|o| o.flavor == WpeMediaFlavor::Scene)
            .map(|o| o.message)
            .collect()
    }

    fn web(out: Vec<Output>) -> Vec<WpeMediaMessage> {
        out.into_iter()
            .filter(|o| o.flavor == WpeMediaFlavor::Web)
            .map(|o| o.message)
            .collect()
    }

    fn scene_props(title: &str, content_type: &str) -> WpeMediaMessage {
        WpeMediaMessage::Properties {
            title: title.into(),
            artist: String::new(),
            sub_title: String::new(),
            album_title: String::new(),
            album_artist: String::new(),
            genres: String::new(),
            content_type: content_type.into(),
        }
    }

    // ── 场景投影 ──

    #[test]
    fn scene_default_values_are_not_sent_first() {
        let mut p = Projections::default();
        // 全空且 playbackType 0：属性、封面都是缺省值，不发
        let out = scene(p.properties(Some(&RawProperties::default())));
        assert!(out.is_empty());
        assert!(scene(p.playback(0, 0)).is_empty());
        let timeline = RawTimeline {
            position: 0,
            start: 0,
            end: 0,
            updated: 0,
        };
        assert!(scene(p.timeline(Some(timeline), 0)).is_empty());
        // 没有会话时同样什么都不发
        assert!(scene(p.no_session(0)).is_empty());
    }

    #[test]
    fn scene_content_type_values() {
        for (value, expected) in [(0, ""), (1, "music"), (2, "video"), (3, "image"), (4, "")] {
            let mut p = Projections::default();
            let mut raw = props("t");
            raw.playback_type = value;
            assert_eq!(
                scene(p.properties(Some(&raw))),
                vec![scene_props("t", expected)]
            );
        }
    }

    #[test]
    fn scene_genres_joined_with_comma_and_long_fields_cleared() {
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.genres = vec!["a".into(), "b".into()];
        match &scene(p.properties(Some(&raw)))[0] {
            WpeMediaMessage::Properties { genres, .. } => assert_eq!(genres, "a,b"),
            other => panic!("{other:?}"),
        }

        // 刚好 1024 / 256 字节不清空，多一个字节整段清空（按 UTF-8 字节，不是字符数）
        let mut p = Projections::default();
        let mut raw = props(&"a".repeat(1024));
        raw.artist = "b".repeat(1025);
        raw.sub_title = "c".repeat(256);
        raw.album_title = "d".repeat(257);
        raw.album_artist = "é".repeat(129); // 258 字节
        raw.genres = vec!["g".repeat(1025)];
        match &scene(p.properties(Some(&raw)))[0] {
            WpeMediaMessage::Properties {
                title,
                artist,
                sub_title,
                album_title,
                album_artist,
                genres,
                ..
            } => {
                assert_eq!(title.len(), 1024);
                assert_eq!(artist, "");
                assert_eq!(sub_title.len(), 256);
                assert_eq!(album_title, "");
                assert_eq!(album_artist, "");
                assert_eq!(genres, "");
            }
            other => panic!("{other:?}"),
        }
        // 4 个汉字 = 12 字节：字符数不超、字节数也不超；341 个汉字 = 1023 字节不清空，342 个 = 1026 清空
        let mut p = Projections::default();
        let mut raw = props(&"汉".repeat(341));
        raw.artist = "汉".repeat(342);
        match &scene(p.properties(Some(&raw)))[0] {
            WpeMediaMessage::Properties { title, artist, .. } => {
                assert_eq!(title.len(), 1023);
                assert_eq!(artist, "");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn scene_properties_dedup() {
        let mut p = Projections::default();
        assert_eq!(scene(p.properties(Some(&props("a")))).len(), 1);
        assert!(scene(p.properties(Some(&props("a")))).is_empty());
        assert_eq!(
            scene(p.properties(Some(&props("b")))),
            vec![scene_props("b", "music")]
        );
        // 读取失败：场景什么都不做（网页投影照旧处理）
        assert!(scene(p.properties(None)).is_empty());
        assert!(scene(p.properties(Some(&props("b")))).is_empty());
    }

    #[test]
    fn scene_timeline_truncates_whole_seconds_without_extrapolation() {
        let mut p = Projections::default();
        let read = |position: i64, end: i64| RawTimeline {
            position,
            start: 5 * SECOND, // 不减 StartTime
            end,
            updated: 1,
        };
        let out = scene(p.timeline(Some(read(378_000_000, 2_005_000_000)), 0));
        assert_eq!(
            out,
            vec![WpeMediaMessage::Timeline {
                position: 37.0,
                duration: 200.0
            }]
        );
        // 两个值各自截断后相同 → 不发（37.8 → 37.99 仍是 37）
        assert!(scene(p.timeline(Some(read(379_999_999, 2_009_999_999)), 0)).is_empty());
        // 播放状态变化不重推时间轴，tick 也不外推
        assert!(scene(p.playback(1, 100 * SECOND)).len() == 1);
        assert!(scene(p.tick(1_000 * SECOND)).is_empty());
        // 只有一个值变了就发
        let out = scene(p.timeline(Some(read(380_000_000, 2_005_000_000)), 0));
        assert_eq!(
            out,
            vec![WpeMediaMessage::Timeline {
                position: 38.0,
                duration: 200.0
            }]
        );
        // 向零截断：负数位置
        let mut p = Projections::default();
        let out = scene(p.timeline(Some(read(-15_000_000, 0)), 0));
        assert_eq!(
            out,
            vec![WpeMediaMessage::Timeline {
                position: -1.0,
                duration: 0.0
            }]
        );
    }

    #[test]
    fn scene_playback_values_and_dedup() {
        let mut p = Projections::default();
        assert_eq!(
            scene(p.playback(1, 0)),
            vec![WpeMediaMessage::Playback { state: 1 }]
        );
        assert!(scene(p.playback(1, 0)).is_empty());
        assert_eq!(
            scene(p.playback(2, 0)),
            vec![WpeMediaMessage::Playback { state: 2 }]
        );
    }

    #[test]
    fn scene_no_session_resets_what_changed() {
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.thumbnail = Some(png_of(&make("m1")));
        p.properties(Some(&raw));
        p.playback(1, 0);
        p.timeline(
            Some(RawTimeline {
                position: 10 * SECOND,
                start: 0,
                end: 20 * SECOND,
                updated: 0,
            }),
            0,
        );
        let out = scene(p.no_session(0));
        assert_eq!(
            out,
            vec![
                scene_props("", ""),
                WpeMediaMessage::SceneThumbnail {
                    png: String::new(),
                    colors: NO_COLORS
                },
                WpeMediaMessage::Playback { state: 0 },
                WpeMediaMessage::Timeline {
                    position: 0.0,
                    duration: 0.0
                },
            ]
        );
        // 再来一次：都已是缺省值，不发
        assert!(scene(p.no_session(0)).is_empty());
        // 只有部分类别变过时只复位那几类
        p.playback(2, 0);
        assert_eq!(
            scene(p.no_session(0)),
            vec![WpeMediaMessage::Playback { state: 0 }]
        );
    }

    #[test]
    fn scene_thumbnail_dedup_and_removal() {
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.thumbnail = Some(png_of(&make("m2")));
        let out = scene(p.properties(Some(&raw)));
        assert_eq!(out.len(), 2); // 属性 + 封面，先属性后封面
        let WpeMediaMessage::SceneThumbnail { png, colors } = &out[1] else {
            panic!("{out:?}")
        };
        assert_eq!(colors[0], [30, 121, 220]);
        // 原尺寸 PNG（base64、不带 data: 前缀）
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap();
        let image = image::load_from_memory(&decoded).unwrap();
        assert_eq!((image.width(), image.height()), (320, 180));
        // 相同字节不发
        assert!(scene(p.properties(Some(&raw))).is_empty());
        // 有 → 无要发
        raw.thumbnail = None;
        assert_eq!(
            scene(p.properties(Some(&raw))),
            vec![WpeMediaMessage::SceneThumbnail {
                png: String::new(),
                colors: NO_COLORS
            }]
        );
        // 无 → 无不发；解码失败当无封面
        assert!(scene(p.properties(Some(&raw))).is_empty());
        raw.thumbnail = Some(vec![1, 2, 3]);
        assert!(scene(p.properties(Some(&raw))).is_empty());
    }

    #[test]
    fn scene_large_cover_keeps_original_size() {
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.thumbnail = Some(png_of(&RgbaImage::from_pixel(
            1200,
            800,
            Rgba([10, 20, 30, 255]),
        )));
        let out = scene(p.properties(Some(&raw)));
        let WpeMediaMessage::SceneThumbnail { png, .. } = &out[1] else {
            panic!()
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1200, 800));
        // 网页投影同一份读数缩到 512
        let mut p = Projections::default();
        let out = web(p.properties(Some(&raw)));
        let WpeMediaMessage::Thumbnail { thumbnail, .. } = &out[1] else {
            panic!("{out:?}")
        };
        let b64 = thumbnail.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (512, 341));
    }

    // ── 网页投影 ──

    #[test]
    fn web_content_type_defaults_to_music() {
        for (value, expected) in [(0, "music"), (1, "music"), (2, "video"), (3, "image")] {
            let mut p = Projections::default();
            let mut raw = props("t");
            raw.playback_type = value;
            let out = web(p.properties(Some(&raw)));
            assert_eq!(
                out[0],
                WpeMediaMessage::Properties {
                    title: "t".into(),
                    artist: String::new(),
                    sub_title: String::new(),
                    album_title: String::new(),
                    album_artist: String::new(),
                    genres: String::new(),
                    content_type: expected.into(),
                }
            );
        }
    }

    #[test]
    fn web_without_cover_has_black_colors_and_failed_read_is_empty() {
        let mut p = Projections::default();
        let out = web(p.properties(None));
        assert_eq!(out.len(), 2);
        let WpeMediaMessage::Thumbnail {
            thumbnail,
            primary_color,
            high_contrast_color,
            ..
        } = &out[1]
        else {
            panic!("{out:?}")
        };
        assert_eq!(thumbnail, "");
        assert_eq!(primary_color, "rgb(0, 0, 0)");
        assert_eq!(high_contrast_color, "rgb(0, 0, 0)");
    }

    #[test]
    fn web_thumbnail_uses_wpe_colors() {
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.thumbnail = Some(png_of(&make("m3")));
        let out = web(p.properties(Some(&raw)));
        let WpeMediaMessage::Thumbnail {
            primary_color,
            secondary_color,
            tertiary_color,
            text_color,
            high_contrast_color,
            ..
        } = &out[1]
        else {
            panic!("{out:?}")
        };
        assert_eq!(primary_color, "rgb(220, 30, 30)");
        assert_eq!(secondary_color, "rgb(30, 199, 58)");
        assert_eq!(tertiary_color, "rgb(39, 62, 230)");
        assert_eq!(text_color, "rgb(0, 0, 0)");
        assert_eq!(high_contrast_color, "rgb(0, 0, 0)");
        // 同字节不重发
        assert!(web(p.properties(Some(&raw))).is_empty());
    }

    #[test]
    fn web_timeline_extrapolates_while_playing() {
        let mut p = Projections::default();
        let start = 100 * SECOND;
        let read = RawTimeline {
            position: 10 * SECOND,
            start: 0,
            end: 200 * SECOND,
            updated: start,
        };
        // 暂停（未播放）：按读数推一次
        let out = web(p.timeline(Some(read), start));
        assert_eq!(
            out,
            vec![WpeMediaMessage::Timeline {
                position: 10.0,
                duration: 200.0
            }]
        );
        // 切到播放：以切换时刻为新基准
        let out = web(p.playback(1, start));
        assert_eq!(out[0], WpeMediaMessage::Playback { state: 1 });
        // 播放中每秒外推
        let out = web(p.tick(start + 3 * SECOND));
        assert_eq!(
            out,
            vec![WpeMediaMessage::Timeline {
                position: 13.0,
                duration: 200.0
            }]
        );
        // 变化不到 0.05 秒不推
        assert!(web(p.tick(start + 3 * SECOND + SECOND / 100)).is_empty());
    }

    #[test]
    fn web_pause_and_resume_keep_the_position() {
        let start = 100 * SECOND;
        let timeline = Timeline {
            position: 0.0,
            duration: 15.0,
            updated: start,
        };
        let paused = timeline.rebased(true, start + 7 * SECOND);
        assert_eq!(paused.position_at(false, start + 30 * SECOND), 7.0);
        let resumed = paused.rebased(false, start + 30 * SECOND);
        assert_eq!(resumed.position_at(true, start + 30 * SECOND), 7.0);
        assert_eq!(resumed.position_at(true, start + 32 * SECOND), 9.0);
    }

    #[test]
    fn web_extrapolation_is_clamped_and_untrusted_times_ignored() {
        let start = 100 * SECOND;
        let timeline = Timeline {
            position: 12.0,
            duration: 15.0,
            updated: start,
        };
        assert_eq!(timeline.position_at(true, start + 7 * SECOND), 15.0);
        assert_eq!(
            Timeline {
                updated: 0,
                ..timeline
            }
            .position_at(true, start),
            12.0
        );
        assert_eq!(timeline.position_at(true, start - SECOND), 12.0);
        assert_eq!(timeline.position_at(true, start + 86_400 * SECOND), 12.0);
    }

    // ── Spotify 预处理 ──

    #[test]
    fn spotify_cover_is_cropped_to_the_square() {
        // 100×100：两侧各 8 / 8 列透明，中间不透明 → 左上角 (8, 0)、边长 84
        let image = RgbaImage::from_fn(100, 100, |x, _| {
            if (8..92).contains(&x) {
                Rgba([200, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        let out = spotify_preprocess(image.clone());
        assert_eq!(out.dimensions(), (84, 84));
        assert_eq!(out.get_pixel(0, 0).0, [200, 40, 40, 255]);
        // 不是 Spotify 的来源不动：走 decode 时不调预处理
        let mut p = Projections::default();
        let mut raw = props("t");
        raw.thumbnail = Some(png_of(&image));
        let out = scene(p.properties(Some(&raw)));
        let WpeMediaMessage::SceneThumbnail { png, .. } = &out[1] else {
            panic!()
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 100);
        // Spotify 来源（App ID 大小写不限）裁掉
        let mut p = Projections::default();
        raw.app_id = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify".into();
        let out = scene(p.properties(Some(&raw)));
        let WpeMediaMessage::SceneThumbnail { png, .. } = &out[1] else {
            panic!()
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 84);
    }
}
