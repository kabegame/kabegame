//! mediaremote-adapter `stream --micros` 的输出 → 读数（纯逻辑，不碰进程，便于喂实测行单测）。
//!
//! 每行一个 JSON：`{"type":"data","diff":bool,"payload":{…}}`。`diff` 为假时 `payload` 是完整状态，为真时只带变了的键，
//! 值为 `null` 的键表示没了。合并成当前状态后推出一份快照，和上次推出的比较，按类只推变了的（[`Tracker::apply`]）。
//!
//! 实测（2026-11-21，macOS 26.6.2，Amazon 的 Pake 网页应用）：
//! - 每次更新都会带 `artworkMimeType`，在 `image/tiff` 与 `image/jpeg` 之间来回跳，封面字节其实是 TIFF：不看它；
//! - 网页播放器的 `bundleIdentifier` 是 `com.apple.WebKit.GPU`，宿主应用在 `parentApplicationBundleIdentifier`；
//! - 没有标题的媒体适配器当作没有（`payload` 为空），和「没有会话」一样。

use crate::models::{MediaKind, MediaProperties, MediaSnapshot, PlaybackStatus, Timeline};
use crate::MediaEvent;
use base64::Engine;
use serde_json::{Map, Value};

/// 会话的身份：来源应用与进程。换了任一个都算换会话（同一应用重开也是新会话）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionKey {
    app_id: String,
    pid: Option<i64>,
}

/// 封面的 base64 只在变了时解码。
#[derive(Default)]
struct ArtworkCache {
    encoded: String,
    decoded: Option<Vec<u8>>,
}

impl ArtworkCache {
    fn get(&mut self, encoded: Option<&str>) -> Option<Vec<u8>> {
        let encoded = encoded.filter(|s| !s.is_empty())?;
        if self.encoded != encoded {
            self.encoded = encoded.to_string();
            // 适配器输出的 base64 不带换行；保险起见去掉空白再解
            let compact: String = encoded.chars().filter(|c| !c.is_whitespace()).collect();
            self.decoded = base64::engine::general_purpose::STANDARD
                .decode(compact)
                .map_err(|error| tracing::debug!("封面 base64 解码失败，按无封面处理: {error}"))
                .ok()
                .filter(|bytes| !bytes.is_empty());
        }
        self.decoded.clone()
    }
}

/// 适配器输出的合并状态与上次推出的快照。
#[derive(Default)]
pub struct Tracker {
    raw: Map<String, Value>,
    artwork: ArtworkCache,
    /// `None`：还没推过任何读数（第一行无论如何都推一次会话）
    reported: Option<Option<(SessionKey, MediaSnapshot)>>,
}

impl Tracker {
    /// 应用一行输出，返回要推的读数。解析不了的行返回空（并记日志）。
    pub fn apply(&mut self, line: &str) -> Vec<MediaEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                tracing::debug!(
                    "mediaremote-adapter 输出不是 JSON（{error}）: {}",
                    preview(line)
                );
                return Vec::new();
            }
        };
        let diff = message
            .get("diff")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let Some(payload) = message.get("payload").and_then(Value::as_object) else {
            return Vec::new();
        };
        if diff {
            for (key, value) in payload {
                if value.is_null() {
                    self.raw.remove(key);
                } else {
                    self.raw.insert(key.clone(), value.clone());
                }
            }
        } else {
            self.raw = payload.clone();
        }
        let current = self.snapshot();
        self.report(current)
    }

    /// 和上次推出的比较：第一次或换了会话推完整快照；同一会话按 属性 → 播放 → 时间轴 推变了的类。
    fn report(&mut self, current: Option<(SessionKey, MediaSnapshot)>) -> Vec<MediaEvent> {
        let mut events = Vec::new();
        match (&self.reported, &current) {
            (Some(Some((old_key, old))), Some((key, new))) if old_key == key => {
                if old.properties != new.properties {
                    events.push(MediaEvent::Properties(new.properties.clone()));
                }
                if old.playback != new.playback {
                    events.push(MediaEvent::Playback(new.playback));
                }
                if old.timeline != new.timeline {
                    events.push(MediaEvent::Timeline(new.timeline));
                }
            }
            (Some(None), None) => {}
            _ => events.push(MediaEvent::Session(
                current.as_ref().map(|(_, snapshot)| snapshot.clone()),
            )),
        }
        self.reported = Some(current);
        events
    }

    /// 当前合并状态 → 会话与快照；没有标题或来源应用就是没有会话。
    fn snapshot(&mut self) -> Option<(SessionKey, MediaSnapshot)> {
        let raw = &self.raw;
        let text = |key: &str| {
            raw.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let app_id = ["parentApplicationBundleIdentifier", "bundleIdentifier"]
            .iter()
            .map(|key| text(key))
            .find(|id| !id.is_empty())?;
        let title = text("title");
        if title.is_empty() {
            return None;
        }
        let genre = text("genre");
        let thumbnail = self
            .artwork
            .get(raw.get("artworkData").and_then(Value::as_str));
        let properties = MediaProperties {
            app_id: app_id.clone(),
            title,
            artist: text("artist"),
            sub_title: String::new(),
            album_title: text("album"),
            album_artist: String::new(),
            genres: if genre.is_empty() {
                Vec::new()
            } else {
                vec![genre]
            },
            kind: media_kind(&text("mediaType")),
            thumbnail,
        };
        let playback = match raw.get("playing").and_then(Value::as_bool) {
            Some(true) => PlaybackStatus::Playing,
            Some(false) => PlaybackStatus::Paused,
            None => PlaybackStatus::Other,
        };
        let micros = |key: &str| {
            raw.get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
                .map(|v| v.round() as i64)
                .unwrap_or(0)
        };
        let timeline = Timeline {
            start_micros: 0,
            end_micros: micros("durationMicros"),
            position_micros: micros("elapsedTimeMicros"),
            updated_unix_micros: micros("timestampEpochMicros"),
        };
        let key = SessionKey {
            app_id,
            pid: raw.get("processIdentifier").and_then(Value::as_i64),
        };
        Some((
            key,
            MediaSnapshot {
                properties: Some(properties),
                playback,
                timeline: Some(timeline),
            },
        ))
    }
}

/// `mediaType` 没有文档，实测见过 `MRMediaRemoteMediaTypeMusic`、`kMRMediaRemoteNowPlayingInfoTypeAudio`；按关键词归类。
fn media_kind(media_type: &str) -> MediaKind {
    let lower = media_type.to_ascii_lowercase();
    if lower.contains("video") {
        MediaKind::Video
    } else if lower.contains("music") || lower.contains("audio") {
        MediaKind::Music
    } else if lower.contains("image") || lower.contains("photo") {
        MediaKind::Image
    } else {
        MediaKind::Unknown
    }
}

fn preview(line: &str) -> &str {
    let end = line
        .char_indices()
        .nth(200)
        .map_or(line.len(), |(index, _)| index);
    &line[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    // 实测行（2026-11-21，Amazon 的 Pake 网页应用），封面换成短的假数据
    const FULL: &str = r#"{"type":"data","diff":false,"payload":{"playbackRate":1,"timestampEpochMicros":1795271690788919,"album":"Listen!!","elapsedTimeMicros":17700088,"playing":true,"bundleIdentifier":"com.apple.WebKit.GPU","processIdentifier":41523,"parentApplicationBundleIdentifier":"com.pake.a540759","artworkData":"TU0AKg==","title":"Listen!!","uniqueIdentifier":638898,"artworkMimeType":"image/jpeg","durationMicros":227046000,"artist":"放課後ティータイム","contentItemIdentifier":"638898"}}"#;
    const PAUSE: &str = r#"{"type":"data","diff":true,"payload":{"playing":false}}"#;
    const PAUSE_TIMELINE: &str = r#"{"type":"data","diff":true,"payload":{"elapsedTimeMicros":97600029,"playbackRate":0,"timestampEpochMicros":1795271770624506,"artworkMimeType":"image/tiff"}}"#;
    const MIME_FLAP: &str =
        r#"{"type":"data","diff":true,"payload":{"artworkMimeType":"image/jpeg"}}"#;

    fn properties(events: &[MediaEvent]) -> Vec<&MediaProperties> {
        events
            .iter()
            .filter_map(|event| match event {
                MediaEvent::Properties(Some(p)) => Some(p),
                MediaEvent::Session(Some(s)) => s.properties.as_ref(),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn first_full_payload_is_a_session_with_mapped_fields() {
        let mut tracker = Tracker::default();
        let events = tracker.apply(FULL);
        assert_eq!(events.len(), 1);
        let MediaEvent::Session(Some(snapshot)) = &events[0] else {
            panic!("expected a session: {events:?}");
        };
        let p = snapshot.properties.as_ref().unwrap();
        assert_eq!(p.app_id, "com.pake.a540759");
        assert_eq!(p.title, "Listen!!");
        assert_eq!(p.artist, "放課後ティータイム");
        assert_eq!(p.album_title, "Listen!!");
        assert_eq!(p.kind, MediaKind::Unknown);
        assert_eq!(p.thumbnail.as_deref(), Some(&b"MM\0*"[..]));
        assert_eq!(snapshot.playback, PlaybackStatus::Playing);
        assert_eq!(
            snapshot.timeline,
            Some(Timeline {
                start_micros: 0,
                end_micros: 227_046_000,
                position_micros: 17_700_088,
                updated_unix_micros: 1_795_271_690_788_919,
            })
        );
    }

    #[test]
    fn diffs_push_only_the_changed_kinds_and_ignore_the_mime_flap() {
        let mut tracker = Tracker::default();
        tracker.apply(FULL);
        assert_eq!(
            tracker.apply(PAUSE),
            vec![MediaEvent::Playback(PlaybackStatus::Paused)]
        );
        let events = tracker.apply(PAUSE_TIMELINE);
        assert!(
            matches!(events.as_slice(), [MediaEvent::Timeline(Some(t))] if t.position_micros == 97_600_029),
            "{events:?}"
        );
        assert!(tracker.apply(MIME_FLAP).is_empty());
    }

    #[test]
    fn a_new_title_on_the_same_app_is_a_properties_change_not_a_session() {
        let mut tracker = Tracker::default();
        tracker.apply(FULL);
        let next = FULL.replace("\"title\":\"Listen!!\"", "\"title\":\"ALIVE\"");
        let events = tracker.apply(&next);
        assert_eq!(properties(&events).len(), 1);
        assert!(matches!(events[0], MediaEvent::Properties(Some(ref p)) if p.title == "ALIVE"));
    }

    #[test]
    fn another_app_or_an_empty_payload_switches_the_session() {
        let mut tracker = Tracker::default();
        tracker.apply(FULL);
        let other = FULL.replace("com.pake.a540759", "com.spotify.client");
        assert!(matches!(
            tracker.apply(&other).as_slice(),
            [MediaEvent::Session(Some(_))]
        ));
        let empty = r#"{"type":"data","diff":false,"payload":{}}"#;
        assert_eq!(tracker.apply(empty), vec![MediaEvent::Session(None)]);
        // 一直没有会话：不重复推
        assert!(tracker.apply(empty).is_empty());
    }

    #[test]
    fn the_first_line_reports_a_session_even_when_nothing_plays() {
        let mut tracker = Tracker::default();
        let empty = r#"{"type":"data","diff":false,"payload":{}}"#;
        assert_eq!(tracker.apply(empty), vec![MediaEvent::Session(None)]);
    }

    #[test]
    fn a_null_key_in_a_diff_removes_it() {
        let mut tracker = Tracker::default();
        tracker.apply(FULL);
        let events = tracker.apply(r#"{"type":"data","diff":true,"payload":{"artworkData":null}}"#);
        assert!(
            matches!(events.as_slice(), [MediaEvent::Properties(Some(p))] if p.thumbnail.is_none())
        );
        // 标题没了 = 没有会话
        let events = tracker.apply(r#"{"type":"data","diff":true,"payload":{"title":null}}"#);
        assert_eq!(events, vec![MediaEvent::Session(None)]);
    }

    #[test]
    fn garbage_lines_are_ignored() {
        let mut tracker = Tracker::default();
        assert!(tracker.apply("not json").is_empty());
        assert!(tracker.apply("").is_empty());
        assert!(tracker.apply(r#"{"type":"data"}"#).is_empty());
    }

    #[test]
    fn media_types_map_by_keyword() {
        assert_eq!(media_kind("MRMediaRemoteMediaTypeMusic"), MediaKind::Music);
        assert_eq!(
            media_kind("kMRMediaRemoteNowPlayingInfoTypeAudio"),
            MediaKind::Music
        );
        assert_eq!(
            media_kind("kMRMediaRemoteNowPlayingInfoTypeVideo"),
            MediaKind::Video
        );
        assert_eq!(media_kind(""), MediaKind::Unknown);
    }
}
