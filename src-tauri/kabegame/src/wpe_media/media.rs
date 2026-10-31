//! 系统媒体会话（SMTC，`GlobalSystemMediaTransportControlsSessionManager`）监视：把「当前会话」的属性、封面、
//! 播放状态、时间轴翻译成 WPE 的媒体回调数据，变化时才推。
//!
//! 一个专用线程（COM MTA）持有管理器与当前会话：WinRT 事件只往通道里发一个信号，读取、比较、封面解码都在这个线程里做；
//! 每秒醒一次给播放中的时间轴按 `LastUpdatedTime` 外推（很多播放器只在跳转时更新时间轴）。
//! 播放状态切换时不重读时间轴，按旧状态外推的位置作新基准。
//! 播放器不提供时间轴（`EndTime` 为 0）就不推，页面要能接受永不回调（官方文档）。

use super::colors::{default_colors, thumbnail_colors, ThumbnailColors};
use super::{ComGuard, WpeMediaMessage};
use base64::Engine;
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Media::MediaPlaybackType;
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

const TICK: Duration = Duration::from_secs(1);
/// 封面长边上限（WPE 同样推缩过的 PNG，API.md §3.2）。
const THUMBNAIL_MAX_SIDE: u32 = 512;
/// 算颜色用的缩略尺寸。
const COLOR_SAMPLE_SIDE: u32 = 64;
/// 读封面流的上限，防止异常大的流。
const THUMBNAIL_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// `DateTime.UniversalTime`（1601 起的 100ns）与 Unix 纪元之差。
const FILETIME_UNIX_OFFSET: i64 = 116_444_736_000_000_000;

enum Signal {
    Session,
    Properties,
    Playback,
    Timeline,
    Stop,
}

/// 运行中的媒体会话监视；丢弃即停止。
pub struct MediaWatcher {
    signals: Sender<Signal>,
    thread: Option<JoinHandle<()>>,
}

impl MediaWatcher {
    pub fn start(emit: impl Fn(WpeMediaMessage) + Send + 'static) -> Self {
        let (signals, receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("kabegame-wpe-media".to_string())
            .spawn({
                let signals = signals.clone();
                move || run(signals, receiver, &emit)
            })
            .map_err(|error| tracing::warn!("启动网页壁纸媒体会话线程失败: {error}"))
            .ok();
        Self { signals, thread }
    }
}

impl Drop for MediaWatcher {
    fn drop(&mut self) {
        let _ = self.signals.send(Signal::Stop);
        if let Some(thread) = self.thread.take() {
            // 监视线程自己触发的停止（广播时发现订阅全没了）不能 join 自己：它会在处理完当前信号后收到 Stop 退出
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

fn run(signals: Sender<Signal>, receiver: Receiver<Signal>, emit: &dyn Fn(WpeMediaMessage)) {
    let _com = ComGuard::init();
    let manager = match SessionManager::RequestAsync().and_then(|op| op.get()) {
        Ok(manager) => manager,
        Err(error) => {
            tracing::warn!("获取系统媒体会话失败，网页壁纸媒体集成不可用: {error}");
            emit(WpeMediaMessage::Playback { state: 0 });
            // 等停止信号，不再做任何事
            while !matches!(receiver.recv(), Ok(Signal::Stop) | Err(_)) {}
            return;
        }
    };
    let session_token = manager
        .CurrentSessionChanged(&TypedEventHandler::new({
            let signals = signals.clone();
            move |_, _| {
                let _ = signals.send(Signal::Session);
                Ok(())
            }
        }))
        .ok();

    let mut watcher = Watcher::new(emit, signals);
    watcher.attach(manager.GetCurrentSession().ok());
    loop {
        match receiver.recv_timeout(TICK) {
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Signal::Session) => watcher.attach(manager.GetCurrentSession().ok()),
            Ok(Signal::Properties) => watcher.refresh_properties(),
            Ok(Signal::Playback) => watcher.refresh_playback(),
            Ok(Signal::Timeline) => watcher.refresh_timeline(),
            Err(RecvTimeoutError::Timeout) => watcher.tick(),
        }
    }
    watcher.detach();
    if let Some(token) = session_token {
        let _ = manager.RemoveCurrentSessionChanged(token);
    }
}

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

struct Watcher<'a> {
    emit: &'a dyn Fn(WpeMediaMessage),
    signals: Sender<Signal>,
    session: Option<Session>,
    tokens: Vec<(EventKind, EventRegistrationToken)>,
    last_properties: Option<WpeMediaMessage>,
    /// 上次推送的封面字节哈希；外层 None 表示还没推过
    last_thumbnail: Option<Option<u64>>,
    last_playback: Option<u8>,
    timeline: Option<Timeline>,
    last_timeline: Option<(f64, f64)>,
}

#[derive(Clone, Copy)]
enum EventKind {
    Properties,
    Playback,
    Timeline,
}

impl<'a> Watcher<'a> {
    fn new(emit: &'a dyn Fn(WpeMediaMessage), signals: Sender<Signal>) -> Self {
        Self {
            emit,
            signals,
            session: None,
            tokens: Vec::new(),
            last_properties: None,
            last_thumbnail: None,
            last_playback: None,
            timeline: None,
            last_timeline: None,
        }
    }

    /// 换到新的当前会话（可能为空）并全量刷新。
    fn attach(&mut self, session: Option<Session>) {
        self.detach();
        if let Some(session) = &session {
            for kind in [
                EventKind::Properties,
                EventKind::Playback,
                EventKind::Timeline,
            ] {
                // 三个事件的参数类型不同，各自建 handler；回调只发信号，读取在本线程做
                let signals = self.signals.clone();
                let token = match kind {
                    EventKind::Properties => {
                        session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                            let _ = signals.send(Signal::Properties);
                            Ok(())
                        }))
                    }
                    EventKind::Playback => {
                        session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                            let _ = signals.send(Signal::Playback);
                            Ok(())
                        }))
                    }
                    EventKind::Timeline => {
                        session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                            let _ = signals.send(Signal::Timeline);
                            Ok(())
                        }))
                    }
                };
                match token {
                    Ok(token) => self.tokens.push((kind, token)),
                    Err(error) => tracing::debug!("订阅媒体会话事件失败: {error}"),
                }
            }
        }
        self.session = session;
        self.refresh_properties();
        self.refresh_playback();
        self.refresh_timeline();
    }

    fn detach(&mut self) {
        if let Some(session) = &self.session {
            for (kind, token) in self.tokens.drain(..) {
                let _ = match kind {
                    EventKind::Properties => session.RemoveMediaPropertiesChanged(token),
                    EventKind::Playback => session.RemovePlaybackInfoChanged(token),
                    EventKind::Timeline => session.RemoveTimelinePropertiesChanged(token),
                };
            }
        }
        self.tokens.clear();
        self.session = None;
        self.timeline = None;
    }

    fn send(&self, message: WpeMediaMessage) {
        (self.emit)(message);
    }

    /// 属性与封面：没有会话时都清空。
    fn refresh_properties(&mut self) {
        let props = self.session.as_ref().and_then(|session| {
            session
                .TryGetMediaPropertiesAsync()
                .and_then(|op| op.get())
                .ok()
        });
        let message = match &props {
            Some(props) => {
                let text = |value: windows::core::Result<windows::core::HSTRING>| {
                    value.map(|s| s.to_string()).unwrap_or_default()
                };
                let genres = props
                    .Genres()
                    .map(|list| {
                        let count = list.Size().unwrap_or(0);
                        (0..count)
                            .filter_map(|i| list.GetAt(i).ok())
                            .map(|s| s.to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                let content_type = match props.PlaybackType().and_then(|t| t.Value()) {
                    Ok(MediaPlaybackType::Video) => "video",
                    Ok(MediaPlaybackType::Image) => "image",
                    _ => "music",
                };
                WpeMediaMessage::Properties {
                    title: text(props.Title()),
                    artist: text(props.Artist()),
                    sub_title: text(props.Subtitle()),
                    album_title: text(props.AlbumTitle()),
                    album_artist: text(props.AlbumArtist()),
                    genres,
                    content_type: content_type.to_string(),
                }
            }
            None => empty_properties(),
        };
        if self.last_properties.as_ref() != Some(&message) {
            self.last_properties = Some(message.clone());
            self.send(message);
        }
        self.refresh_thumbnail(props.and_then(|props| props.Thumbnail().ok()));
    }

    /// 封面：按字节哈希判断是否变化，变了才解码、缩小、编码并算颜色。
    fn refresh_thumbnail(&mut self, reference: Option<IRandomAccessStreamReference>) {
        let bytes = reference
            .and_then(|reference| read_stream(&reference).ok())
            .filter(|bytes| !bytes.is_empty());
        let hash = bytes.as_ref().map(|bytes| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut hasher);
            hasher.finish()
        });
        if self.last_thumbnail == Some(hash) {
            return;
        }
        self.last_thumbnail = Some(hash);
        let message = match bytes {
            Some(bytes) => encode_thumbnail(&bytes).unwrap_or_else(|error| {
                tracing::debug!("封面解码失败，按无封面处理: {error}");
                thumbnail_message(String::new(), default_colors())
            }),
            None => thumbnail_message(String::new(), default_colors()),
        };
        self.send(message);
    }

    /// 播放状态：Playing → 1、Paused → 2，其余（含没有会话）→ 0。
    fn refresh_playback(&mut self) {
        let status = self
            .session
            .as_ref()
            .and_then(|session| session.GetPlaybackInfo().ok())
            .and_then(|info| info.PlaybackStatus().ok());
        let state = match status {
            Some(PlaybackStatus::Playing) => 1,
            Some(PlaybackStatus::Paused) => 2,
            _ => 0,
        };
        if self.last_playback != Some(state) {
            // 播放器的时间轴读数常停在上次跳转。状态切换时按旧状态把当前位置定成新基准，
            // 避免暂停推回旧读数、恢复时把暂停时长也外推进去。
            let was_playing = self.last_playback == Some(1);
            if let Some(timeline) = self.timeline.as_mut() {
                *timeline = timeline.rebased(was_playing, now_filetime());
            }
            self.last_playback = Some(state);
            self.send(WpeMediaMessage::Playback { state });
            self.push_timeline();
        }
    }

    /// 重新读时间轴；播放器不提供（`EndTime` 不大于 `StartTime`）就不推。
    fn refresh_timeline(&mut self) {
        let read = self
            .session
            .as_ref()
            .and_then(|session| session.GetTimelineProperties().ok())
            .and_then(|props| {
                let start = props.StartTime().ok()?.Duration;
                let end = props.EndTime().ok()?.Duration;
                let position = props.Position().ok()?.Duration;
                let updated = props
                    .LastUpdatedTime()
                    .map(|t| t.UniversalTime)
                    .unwrap_or(0);
                let duration = (end - start) as f64 / 1e7;
                (duration > 0.0).then(|| Timeline {
                    position: ((position - start) as f64 / 1e7).clamp(0.0, duration),
                    duration,
                    updated,
                })
            });
        self.timeline = read;
        self.push_timeline();
    }

    /// 每秒：播放中按读数时间外推位置并推送。
    fn tick(&mut self) {
        if self.last_playback == Some(1) {
            self.push_timeline();
        }
    }

    fn push_timeline(&mut self) {
        let Some(timeline) = self.timeline else {
            return;
        };
        let position = timeline.position_at(self.last_playback == Some(1), now_filetime());
        let current = (position, timeline.duration);
        let changed = match self.last_timeline {
            Some((last_position, last_duration)) => {
                (last_position - position).abs() >= 0.05 || last_duration != timeline.duration
            }
            None => true,
        };
        if changed {
            self.last_timeline = Some(current);
            self.send(WpeMediaMessage::Timeline {
                position,
                duration: timeline.duration,
            });
        }
    }
}

fn empty_properties() -> WpeMediaMessage {
    WpeMediaMessage::Properties {
        title: String::new(),
        artist: String::new(),
        sub_title: String::new(),
        album_title: String::new(),
        album_artist: String::new(),
        genres: String::new(),
        content_type: "music".to_string(),
    }
}

fn thumbnail_message(thumbnail: String, colors: ThumbnailColors) -> WpeMediaMessage {
    WpeMediaMessage::Thumbnail {
        thumbnail,
        primary_color: colors.primary,
        secondary_color: colors.secondary,
        tertiary_color: colors.tertiary,
        text_color: colors.text,
        high_contrast_color: colors.high_contrast,
    }
}

/// 封面字节 → 长边不超过 512 的 PNG data URL 与五个颜色。
fn encode_thumbnail(bytes: &[u8]) -> Result<WpeMediaMessage, image::ImageError> {
    let mut image = image::load_from_memory(bytes)?;
    if image.width().max(image.height()) > THUMBNAIL_MAX_SIDE {
        image = image.thumbnail(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE);
    }
    let sample = image::imageops::resize(
        &image.to_rgba8(),
        COLOR_SAMPLE_SIDE,
        COLOR_SAMPLE_SIDE,
        image::imageops::FilterType::Triangle,
    );
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    Ok(thumbnail_message(url, thumbnail_colors(&sample)))
}

fn read_stream(reference: &IRandomAccessStreamReference) -> windows::core::Result<Vec<u8>> {
    let stream = reference.OpenReadAsync()?.get()?;
    let size = stream.Size()?;
    if size == 0 || size > THUMBNAIL_MAX_BYTES {
        return Ok(Vec::new());
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    let loaded = reader.LoadAsync(size as u32)?.get()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

fn now_filetime() -> i64 {
    let since_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() / 100)
        .unwrap_or(0);
    since_unix as i64 + FILETIME_UNIX_OFFSET
}

#[cfg(test)]
mod tests {
    use super::Timeline;

    const SECOND: i64 = 10_000_000;

    #[test]
    fn pause_and_resume_keep_the_position() {
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
    fn extrapolation_is_clamped_and_untrusted_times_ignored() {
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
}
