//! MPRIS 的纯逻辑（不碰总线，便于喂构造好的数据单测）：元数据解析、播放器表与「当前会话」的选法、和上次推出的读数比较、
//! 封面地址分类。
//!
//! MPRIS 没有系统指定的「当前会话」：会话总线上同时挂着多个 `org.mpris.MediaPlayer2.*`。这里按「最近一次开始播放的那个」
//! 选（[`Players::current`]）：有在播的取最近进入 Playing 的；都没在播取最近播过的（暂停的留在原地，同 Windows 上暂停的
//! 会话仍是当前会话）；都没播过取暂停的。没有标题的播放器不算会话（同 macOS）；`playerctld` 是转发别的播放器的代理，
//! 本进程自己的播放器是兜底排除（CEF 的 MPRIS 本来已关），都不算。
//!
//! 会话身份是进程（[`Player::session_key`]），不是总线名：VLC 开两条连接，`vlc` 与 `vlc.instance<pid>` 各挂一个内容相同的
//! 播放器（2026-11-22 实测，VLC 3），状态变化时两边先后到，当前会话会在两者之间来回切；按进程认就还是同一个会话，
//! 只推真正变了的那类读数。和 macOS 的「来源应用 + 进程号」一致。

use crate::models::{MediaKind, MediaProperties, MediaSnapshot, PlaybackStatus, Timeline};
use crate::MediaEvent;
use std::collections::HashMap;
use std::path::PathBuf;
use zbus::zvariant::{OwnedValue, Value};

pub const BUS_PREFIX: &str = "org.mpris.MediaPlayer2.";
pub const PLAYERCTLD: &str = "org.mpris.MediaPlayer2.playerctld";

/// 一首曲目的元数据（`Metadata` 属性里本插件用到的键）。拿不到的是空串 / 0。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genres: Vec<String>,
    pub length_micros: i64,
    pub art_url: String,
}

impl Metadata {
    /// 解析 `Metadata` 属性（`a{sv}`）。播放器给的类型不一定照规范：`mpris:length` 见过 `x` / `t` / `i`，
    /// `xesam:artist` 见过 `as` 也见过单个 `s`，值外面还可能再包一层变体，这里都认。
    pub fn parse(map: &HashMap<String, OwnedValue>) -> Self {
        let get = |key: &str| map.get(key).map(|value| unwrap(value));
        let text = |key: &str| get(key).and_then(as_text).unwrap_or_default();
        let texts = |key: &str| get(key).map(as_texts).unwrap_or_default();
        Self {
            track_id: text("mpris:trackid"),
            title: text("xesam:title"),
            artist: texts("xesam:artist").join(", "),
            album: text("xesam:album"),
            album_artist: texts("xesam:albumArtist").join(", "),
            genres: texts("xesam:genre"),
            length_micros: get("mpris:length").and_then(as_int).unwrap_or(0).max(0),
            art_url: text("mpris:artUrl"),
        }
    }

    /// 解析变体里的 `Metadata`（`a{sv}`）；不是字典给空。
    pub fn parse_value(value: &Value) -> Self {
        Self::parse(&dict(value))
    }

    /// 换了曲目（位置要重读）：曲目 id、标题或时长变了。
    pub fn same_track(&self, other: &Self) -> bool {
        self.track_id == other.track_id
            && self.title == other.title
            && self.length_micros == other.length_micros
    }
}

/// `a{sv}` → 表；键不是字符串、值复制不了（含文件描述符）的项跳过。
pub fn dict(value: &Value) -> HashMap<String, OwnedValue> {
    let Value::Dict(dict) = unwrap(value) else {
        return HashMap::new();
    };
    dict.iter()
        .filter_map(|(key, value)| {
            let key = as_text(key)?;
            let value = OwnedValue::try_from(value.try_clone().ok()?).ok()?;
            Some((key, value))
        })
        .collect()
}

/// 去掉外面包着的变体。
pub fn unwrap<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap(inner),
        other => other,
    }
}

pub fn as_text(value: &Value) -> Option<String> {
    match unwrap(value) {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(p) => Some(p.to_string()),
        _ => None,
    }
}

/// 字符串数组；单个字符串当一项。空串项去掉。
pub fn as_texts(value: &Value) -> Vec<String> {
    let items: Vec<String> = match unwrap(value) {
        Value::Array(array) => array.iter().filter_map(as_text).collect(),
        other => as_text(other).into_iter().collect(),
    };
    items.into_iter().filter(|s| !s.is_empty()).collect()
}

pub fn as_int(value: &Value) -> Option<i64> {
    match unwrap(value) {
        Value::U8(v) => Some(i64::from(*v)),
        Value::I16(v) => Some(i64::from(*v)),
        Value::U16(v) => Some(i64::from(*v)),
        Value::I32(v) => Some(i64::from(*v)),
        Value::U32(v) => Some(i64::from(*v)),
        Value::I64(v) => Some(*v),
        Value::U64(v) => i64::try_from(*v).ok(),
        Value::F64(v) if v.is_finite() => Some(v.round() as i64),
        _ => None,
    }
}

pub fn as_float(value: &Value) -> Option<f64> {
    match unwrap(value) {
        Value::F64(v) => Some(*v),
        other => as_int(other).map(|v| v as f64),
    }
}

pub fn playback_status(text: &str) -> PlaybackStatus {
    match text {
        "Playing" => PlaybackStatus::Playing,
        "Paused" => PlaybackStatus::Paused,
        _ => PlaybackStatus::Other,
    }
}

/// 来源应用：根接口的 `DesktopEntry`（`spotify`、`vlc`、`google-chrome`）；没有时取总线名去掉前缀与 `.instance…` 后缀
/// （`chromium.instance12345` → `chromium`）。
pub fn app_id(desktop_entry: &str, bus_name: &str) -> String {
    if !desktop_entry.is_empty() {
        return desktop_entry.to_string();
    }
    let short = bus_name.strip_prefix(BUS_PREFIX).unwrap_or(bus_name);
    short
        .find(".instance")
        .map_or(short, |index| &short[..index])
        .to_string()
}

/// 一个播放器（以唯一总线名区分）。
#[derive(Debug, Clone)]
pub struct Player {
    /// 唯一总线名（`:1.42`），播放器表的键
    pub unique: String,
    /// 众所周知的名字（`org.mpris.MediaPlayer2.vlc`）
    pub name: String,
    pub app_id: String,
    pub pid: Option<u32>,
    pub status: PlaybackStatus,
    pub metadata: Metadata,
    pub rate: f64,
    /// 最近一次进入 Playing 的序号，0 是在本次监视里还没播过
    played: u64,
    /// 发现的先后，没播过的之间排先后用
    seen: u64,
}

impl Player {
    /// 会话身份：进程（拿不到 pid 时退回唯一总线名）。播放器重启就是新会话；同一进程的几个镜像是同一个会话。
    pub fn session_key(&self) -> String {
        match self.pid {
            Some(pid) => format!("pid:{pid}"),
            None => format!("bus:{}", self.unique),
        }
    }

    pub fn new(unique: String, name: String, app_id: String, pid: Option<u32>) -> Self {
        Self {
            unique,
            name,
            app_id,
            pid,
            status: PlaybackStatus::Other,
            metadata: Metadata::default(),
            rate: 1.0,
            played: 0,
            seen: 0,
        }
    }
}

/// 播放器表与「当前会话」的选法。
#[derive(Debug)]
pub struct Players {
    players: HashMap<String, Player>,
    /// 本进程的 pid：它的播放器不算会话（真总线测试里假播放器和测试同进程，传 `None`）
    own_pid: Option<u32>,
    seq: u64,
}

impl Players {
    pub fn new(own_pid: Option<u32>) -> Self {
        Self {
            players: HashMap::new(),
            own_pid,
            seq: 0,
        }
    }

    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// 加入（或替换同一唯一名的）播放器；`status` 已经是 Playing 时记为刚开始播放。
    pub fn insert(&mut self, mut player: Player) {
        player.seen = self.next();
        if player.status == PlaybackStatus::Playing {
            player.played = self.next();
        }
        self.players.insert(player.unique.clone(), player);
    }

    pub fn remove(&mut self, unique: &str) -> Option<Player> {
        self.players.remove(unique)
    }

    pub fn contains(&self, unique: &str) -> bool {
        self.players.contains_key(unique)
    }

    pub fn get(&self, unique: &str) -> Option<&Player> {
        self.players.get(unique)
    }

    /// 改播放状态；从别的状态进入 Playing 记为刚开始播放。返回是否变了。
    pub fn set_status(&mut self, unique: &str, status: PlaybackStatus) -> bool {
        let seq = self.seq + 1;
        let Some(player) = self.players.get_mut(unique) else {
            return false;
        };
        if player.status == status {
            return false;
        }
        player.status = status;
        if status == PlaybackStatus::Playing {
            player.played = seq;
            self.seq = seq;
        }
        true
    }

    /// 改元数据，返回是否换了曲目（[`Metadata::same_track`]）。
    pub fn set_metadata(&mut self, unique: &str, metadata: Metadata) -> bool {
        let Some(player) = self.players.get_mut(unique) else {
            return false;
        };
        let new_track = !player.metadata.same_track(&metadata);
        player.metadata = metadata;
        new_track
    }

    /// 改速率，返回是否变了。
    pub fn set_rate(&mut self, unique: &str, rate: f64) -> bool {
        let Some(player) = self.players.get_mut(unique) else {
            return false;
        };
        let changed = player.rate != rate;
        player.rate = rate;
        changed
    }

    fn eligible(&self, player: &Player) -> bool {
        !player.metadata.title.is_empty()
            && player.name != PLAYERCTLD
            && (self.own_pid.is_none() || player.pid != self.own_pid)
    }

    /// 当前会话：在播的里最近开始播放的；都没在播取最近播过的；都没播过先暂停的、再后发现的。
    pub fn current(&self) -> Option<&Player> {
        let candidates = self.players.values().filter(|p| self.eligible(p));
        let playing = candidates
            .clone()
            .filter(|p| p.status == PlaybackStatus::Playing)
            .max_by_key(|p| p.played);
        playing.or_else(|| {
            candidates.max_by_key(|p| (p.played, p.status == PlaybackStatus::Paused, p.seen))
        })
    }
}

/// 当前会话的位置读数。`at_unix_micros` 为 0 是没读到（播放器不实现 `Position`），位置也给 0。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Position {
    pub micros: i64,
    pub at_unix_micros: i64,
}

/// 播放器 → 快照。封面由调用方按 `metadata.art_url` 取好传进来。
pub fn snapshot(player: &Player, position: Position, thumbnail: Option<Vec<u8>>) -> MediaSnapshot {
    let m = &player.metadata;
    MediaSnapshot {
        properties: Some(MediaProperties {
            app_id: player.app_id.clone(),
            title: m.title.clone(),
            artist: m.artist.clone(),
            sub_title: String::new(),
            album_title: m.album.clone(),
            album_artist: m.album_artist.clone(),
            genres: m.genres.clone(),
            // MPRIS 没有媒体类型
            kind: MediaKind::Unknown,
            thumbnail,
        }),
        playback: player.status,
        timeline: Some(Timeline {
            start_micros: 0,
            end_micros: m.length_micros,
            position_micros: position.micros,
            updated_unix_micros: position.at_unix_micros,
        }),
    }
}

/// 和上次推出的比较（同 `macos/stream.rs` 的 `Tracker::report`）：第一次或换了会话推完整快照；同一会话按
/// 属性 → 播放 → 时间轴 推变了的类。会话身份见 [`Player::session_key`]。
#[derive(Default)]
pub struct Reporter {
    /// `None`：还没推过任何读数（第一次无论如何都推一次会话）
    reported: Option<Option<(String, MediaSnapshot)>>,
}

impl Reporter {
    pub fn report(&mut self, current: Option<(String, MediaSnapshot)>) -> Vec<MediaEvent> {
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
}

/// 封面地址的来源。
#[derive(Debug, PartialEq)]
pub enum ArtSource {
    None,
    /// `file://`（Chrome、Firefox、VLC 把封面写到本地文件）
    File(PathBuf),
    /// `data:…;base64,`（解好的字节）；解不了的 `data:` 归 `None`
    Data(Vec<u8>),
    /// `http(s)://`（Spotify 的 CDN）
    Http(String),
}

pub fn classify_art(url: &str) -> ArtSource {
    let url = url.trim();
    if let Some(rest) = strip_prefix_ignore_case(url, "file://") {
        // `file:///path` 或 `file://localhost/path`；别的主机不认
        let path = rest.strip_prefix("localhost").unwrap_or(rest);
        if !path.starts_with('/') {
            return ArtSource::None;
        }
        use std::os::unix::ffi::OsStrExt;
        let bytes: Vec<u8> = percent_encoding::percent_decode_str(path).collect();
        return ArtSource::File(PathBuf::from(std::ffi::OsStr::from_bytes(&bytes)));
    }
    if let Some(rest) = strip_prefix_ignore_case(url, "data:") {
        let Some((header, data)) = rest.split_once(',') else {
            return ArtSource::None;
        };
        if !header.to_ascii_lowercase().ends_with(";base64") {
            return ArtSource::None;
        }
        use base64::Engine;
        let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
        return match base64::engine::general_purpose::STANDARD.decode(compact) {
            Ok(bytes) if !bytes.is_empty() => ArtSource::Data(bytes),
            _ => ArtSource::None,
        };
    }
    if strip_prefix_ignore_case(url, "http://").is_some()
        || strip_prefix_ignore_case(url, "https://").is_some()
    {
        return ArtSource::Http(url.to_string());
    }
    ArtSource::None
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::{Array, ObjectPath, Str};

    fn owned(value: Value<'static>) -> OwnedValue {
        OwnedValue::try_from(value).unwrap()
    }

    fn strings(items: &[&str]) -> Value<'static> {
        Value::Array(Array::from(
            items.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        ))
    }

    fn metadata_map() -> HashMap<String, OwnedValue> {
        let mut map = HashMap::new();
        map.insert(
            "mpris:trackid".into(),
            owned(Value::ObjectPath(
                ObjectPath::try_from("/org/vlc/track/3").unwrap(),
            )),
        );
        map.insert("xesam:title".into(), owned(Value::Str(Str::from("ALIVE"))));
        map.insert(
            "xesam:artist".into(),
            owned(strings(&["ClariS", "", "Kalafina"])),
        );
        map.insert("xesam:album".into(), owned(Value::Str(Str::from("Album"))));
        map.insert("xesam:albumArtist".into(), owned(strings(&["ClariS"])));
        map.insert("xesam:genre".into(), owned(strings(&["J-Pop", "Anime"])));
        map.insert("mpris:length".into(), owned(Value::I64(227_046_000)));
        map.insert(
            "mpris:artUrl".into(),
            owned(Value::Str(Str::from("file:///tmp/art%20cover.jpg"))),
        );
        map
    }

    #[test]
    fn metadata_fields_are_mapped() {
        let m = Metadata::parse(&metadata_map());
        assert_eq!(m.track_id, "/org/vlc/track/3");
        assert_eq!(m.title, "ALIVE");
        assert_eq!(m.artist, "ClariS, Kalafina");
        assert_eq!(m.album, "Album");
        assert_eq!(m.album_artist, "ClariS");
        assert_eq!(m.genres, vec!["J-Pop", "Anime"]);
        assert_eq!(m.length_micros, 227_046_000);
        assert_eq!(m.art_url, "file:///tmp/art%20cover.jpg");
    }

    #[test]
    fn metadata_type_variants_are_accepted() {
        let mut map = HashMap::new();
        // 单个字符串的 artist、u64 / i32 的时长、外面再包一层变体
        map.insert("xesam:artist".into(), owned(Value::Str(Str::from("Solo"))));
        map.insert("mpris:length".into(), owned(Value::U64(5_000_000)));
        map.insert(
            "xesam:title".into(),
            owned(Value::Value(Box::new(Value::Str(Str::from("Wrapped"))))),
        );
        let m = Metadata::parse(&map);
        assert_eq!(m.artist, "Solo");
        assert_eq!(m.length_micros, 5_000_000);
        assert_eq!(m.title, "Wrapped");
        map.insert("mpris:length".into(), owned(Value::I32(42)));
        assert_eq!(Metadata::parse(&map).length_micros, 42);
        map.insert("mpris:length".into(), owned(Value::I64(-1)));
        assert_eq!(Metadata::parse(&map).length_micros, 0);
        assert_eq!(Metadata::parse(&HashMap::new()), Metadata::default());
    }

    #[test]
    fn metadata_parses_from_a_dict_value() {
        let mut dict = zbus::zvariant::Dict::new(
            &zbus::zvariant::Signature::Str,
            &zbus::zvariant::Signature::Variant,
        );
        dict.add("xesam:title", Value::new("In a dict")).unwrap();
        dict.add("mpris:length", Value::new(3_000_000i64)).unwrap();
        let m = Metadata::parse_value(&Value::Dict(dict));
        assert_eq!(m.title, "In a dict");
        assert_eq!(m.length_micros, 3_000_000);
        assert_eq!(
            Metadata::parse_value(&Value::new("not a dict")),
            Metadata::default()
        );
    }

    #[test]
    fn app_id_prefers_desktop_entry() {
        assert_eq!(
            app_id("spotify", "org.mpris.MediaPlayer2.spotify"),
            "spotify"
        );
        assert_eq!(
            app_id("", "org.mpris.MediaPlayer2.chromium.instance12345"),
            "chromium"
        );
        assert_eq!(
            app_id("", "org.mpris.MediaPlayer2.firefox.instance_1_23"),
            "firefox"
        );
        assert_eq!(app_id("", "org.mpris.MediaPlayer2.vlc"), "vlc");
    }

    fn player(unique: &str, title: &str, status: PlaybackStatus) -> Player {
        let mut p = Player::new(
            unique.to_string(),
            format!("{BUS_PREFIX}{}", unique.trim_start_matches(':')),
            "app".to_string(),
            Some(100),
        );
        p.metadata.title = title.to_string();
        p.status = status;
        p
    }

    fn current(players: &Players) -> Option<&str> {
        players.current().map(|p| p.unique.as_str())
    }

    #[test]
    fn the_most_recently_started_player_is_current() {
        let mut players = Players::new(Some(1));
        players.insert(player(":1.1", "a", PlaybackStatus::Playing));
        players.insert(player(":1.2", "b", PlaybackStatus::Paused));
        assert_eq!(current(&players), Some(":1.1"));
        // b 开始播放：换到 b；a 还在播也不换回去
        players.set_status(":1.2", PlaybackStatus::Playing);
        assert_eq!(current(&players), Some(":1.2"));
        // b 暂停：a 在播，回到 a
        players.set_status(":1.2", PlaybackStatus::Paused);
        assert_eq!(current(&players), Some(":1.1"));
        // a 也暂停：都没在播，取最近开始播放的 b（a 一直在播，开始得更早）
        players.set_status(":1.1", PlaybackStatus::Paused);
        assert_eq!(current(&players), Some(":1.2"));
    }

    #[test]
    fn a_paused_current_player_stays_until_another_one_plays() {
        let mut players = Players::new(Some(1));
        players.insert(player(":1.1", "a", PlaybackStatus::Paused));
        players.insert(player(":1.2", "b", PlaybackStatus::Playing));
        players.set_status(":1.2", PlaybackStatus::Paused);
        assert_eq!(current(&players), Some(":1.2"));
        players.set_status(":1.1", PlaybackStatus::Playing);
        assert_eq!(current(&players), Some(":1.1"));
    }

    #[test]
    fn never_played_players_prefer_paused_then_later_seen() {
        let mut players = Players::new(Some(1));
        players.insert(player(":1.1", "a", PlaybackStatus::Paused));
        players.insert(player(":1.2", "b", PlaybackStatus::Other));
        assert_eq!(current(&players), Some(":1.1"));
        players.insert(player(":1.3", "c", PlaybackStatus::Paused));
        assert_eq!(current(&players), Some(":1.3"));
        players.remove(":1.3");
        players.remove(":1.1");
        assert_eq!(current(&players), Some(":1.2"));
        players.remove(":1.2");
        assert_eq!(current(&players), None);
    }

    #[test]
    fn untitled_playerctld_and_own_players_are_not_sessions() {
        let mut players = Players::new(Some(100));
        let mut own = player(":1.1", "own", PlaybackStatus::Playing);
        own.pid = Some(100);
        players.insert(own);
        let mut proxy = player(":1.2", "proxied", PlaybackStatus::Playing);
        proxy.name = PLAYERCTLD.to_string();
        proxy.pid = Some(7);
        players.insert(proxy);
        let mut untitled = player(":1.3", "", PlaybackStatus::Playing);
        untitled.pid = Some(8);
        players.insert(untitled);
        assert_eq!(current(&players), None);
        let mut real = player(":1.4", "real", PlaybackStatus::Paused);
        real.pid = Some(9);
        players.insert(real);
        assert_eq!(current(&players), Some(":1.4"));
    }

    #[test]
    fn setters_report_changes() {
        let mut players = Players::new(Some(1));
        players.insert(player(":1.1", "a", PlaybackStatus::Paused));
        assert!(!players.set_status(":1.1", PlaybackStatus::Paused));
        assert!(players.set_status(":1.1", PlaybackStatus::Playing));
        assert!(!players.set_status(":1.9", PlaybackStatus::Playing));
        let mut m = players.get(":1.1").unwrap().metadata.clone();
        m.artist = "x".into();
        assert!(!players.set_metadata(":1.1", m.clone()), "只改歌手不算换曲");
        m.title = "b".into();
        assert!(players.set_metadata(":1.1", m));
        assert!(!players.set_rate(":1.1", 1.0));
        assert!(players.set_rate(":1.1", 2.0));
    }

    fn snap(title: &str, status: PlaybackStatus, position: i64) -> MediaSnapshot {
        let p = player(":1.1", title, status);
        snapshot(
            &p,
            Position {
                micros: position,
                at_unix_micros: 1,
            },
            None,
        )
    }

    #[test]
    fn the_reporter_pushes_sessions_then_only_changed_kinds() {
        let mut reporter = Reporter::default();
        let events = reporter.report(Some((":1.1".into(), snap("a", PlaybackStatus::Playing, 0))));
        assert!(matches!(events.as_slice(), [MediaEvent::Session(Some(_))]));
        // 同一会话：暂停 + 新位置
        let events = reporter.report(Some((":1.1".into(), snap("a", PlaybackStatus::Paused, 5))));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0], MediaEvent::Playback(PlaybackStatus::Paused));
        assert!(matches!(events[1], MediaEvent::Timeline(Some(t)) if t.position_micros == 5));
        // 什么都没变
        assert!(reporter
            .report(Some((":1.1".into(), snap("a", PlaybackStatus::Paused, 5))))
            .is_empty());
        // 换曲：只推属性
        let events = reporter.report(Some((":1.1".into(), snap("b", PlaybackStatus::Paused, 5))));
        assert!(matches!(events.as_slice(), [MediaEvent::Properties(Some(p))] if p.title == "b"));
        // 换了播放器：推快照；没有会话：推一次 None、之后不重复
        let events = reporter.report(Some((":1.2".into(), snap("b", PlaybackStatus::Paused, 5))));
        assert!(matches!(events.as_slice(), [MediaEvent::Session(Some(_))]));
        assert_eq!(reporter.report(None), vec![MediaEvent::Session(None)]);
        assert!(reporter.report(None).is_empty());
    }

    /// VLC 的两个镜像（同一进程、两个唯一名）先后收到状态变化：只推播放状态，不推换会话。
    #[test]
    fn mirrors_of_one_process_are_one_session() {
        let mut players = Players::new(Some(1));
        let mut a = player(":1.751", "Song", PlaybackStatus::Playing);
        a.pid = Some(42);
        let mut b = a.clone();
        b.unique = ":1.752".into();
        players.insert(a);
        players.insert(b);
        let mut reporter = Reporter::default();
        let mut publish = |players: &Players| {
            let current = players
                .current()
                .map(|p| (p.session_key(), snapshot(p, Position::default(), None)));
            reporter.report(current)
        };
        assert!(matches!(
            publish(&players).as_slice(),
            [MediaEvent::Session(Some(_))]
        ));
        let mut events = Vec::new();
        for status in [PlaybackStatus::Paused, PlaybackStatus::Playing] {
            for unique in [":1.751", ":1.752"] {
                players.set_status(unique, status);
                events.extend(publish(&players));
            }
        }
        assert_eq!(
            events,
            vec![
                MediaEvent::Playback(PlaybackStatus::Paused),
                MediaEvent::Playback(PlaybackStatus::Playing),
            ]
        );
    }

    #[test]
    fn session_key_is_the_process() {
        let mut p = player(":1.9", "t", PlaybackStatus::Playing);
        p.pid = Some(42);
        assert_eq!(p.session_key(), "pid:42");
        p.pid = None;
        assert_eq!(p.session_key(), "bus::1.9");
    }

    #[test]
    fn the_first_report_is_a_session_even_when_nothing_plays() {
        let mut reporter = Reporter::default();
        assert_eq!(reporter.report(None), vec![MediaEvent::Session(None)]);
    }

    #[test]
    fn snapshot_maps_player_fields() {
        let mut p = player(":1.1", "t", PlaybackStatus::Playing);
        p.metadata = Metadata::parse(&metadata_map());
        p.app_id = "vlc".into();
        let s = snapshot(
            &p,
            Position {
                micros: 7,
                at_unix_micros: 9,
            },
            Some(vec![1, 2]),
        );
        let props = s.properties.unwrap();
        assert_eq!(props.app_id, "vlc");
        assert_eq!(props.artist, "ClariS, Kalafina");
        assert_eq!(props.kind, MediaKind::Unknown);
        assert_eq!(props.thumbnail, Some(vec![1, 2]));
        assert_eq!(s.playback, PlaybackStatus::Playing);
        assert_eq!(
            s.timeline,
            Some(Timeline {
                start_micros: 0,
                end_micros: 227_046_000,
                position_micros: 7,
                updated_unix_micros: 9,
            })
        );
    }

    #[test]
    fn art_urls_are_classified() {
        assert_eq!(
            classify_art("file:///tmp/art%20cover.jpg"),
            ArtSource::File(PathBuf::from("/tmp/art cover.jpg"))
        );
        assert_eq!(
            classify_art("file://localhost/home/a/%E5%B0%81%E9%9D%A2.png"),
            ArtSource::File(PathBuf::from("/home/a/封面.png"))
        );
        assert_eq!(classify_art("file://otherhost/x.png"), ArtSource::None);
        assert_eq!(
            classify_art("data:image/png;base64,TU0A\nKg=="),
            ArtSource::Data(b"MM\0*".to_vec())
        );
        assert_eq!(classify_art("data:image/png,raw"), ArtSource::None);
        assert_eq!(classify_art("data:image/png;base64,***"), ArtSource::None);
        assert_eq!(
            classify_art("https://i.scdn.co/image/ab67"),
            ArtSource::Http("https://i.scdn.co/image/ab67".into())
        );
        assert_eq!(
            classify_art("HTTP://example.com/a.jpg"),
            ArtSource::Http("HTTP://example.com/a.jpg".into())
        );
        assert_eq!(classify_art(""), ArtSource::None);
        assert_eq!(classify_art("ftp://x/y"), ArtSource::None);
    }
}
