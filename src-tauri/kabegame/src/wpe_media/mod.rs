//! WPE 网页壁纸的音频与媒体集成（Phase 8）：页面登记 `wallpaperRegisterAudioListener` /
//! `wallpaperRegisterMedia*Listener` 时，垫片向宿主订阅一类数据并交出一个 Tauri Channel，数据只推回发起订阅的
//! 那个 iframe（tauri 补丁 18 起，作为命令参数的 Channel 只投递到调用方 frame）。
//!
//! 订阅归属 `(webview label, 子 frame, 类型)`：frame 销毁（`WebviewEvent::SubframeDestroyed`）即释放，同一 frame
//! 再订阅同一类替换旧条，窗口销毁释放整个 label，发送失败只作兜底——Channel 发往已销毁的 frame 会被运行时静默
//! 丢弃、发送照样成功，所以不能只靠它。
//!
//! 有 audio 订阅才开 WASAPI 回环采集（`audio.rs`），有 media 订阅且「媒体集成」打开才开系统媒体会话监视
//! （`media.rs`）；最后一个订阅离开即停。系统接口只在 Windows（WPE 网页壁纸只支持 Windows），其它桌面平台订阅表
//! 照常、永远没有数据。见 `cocs/wpe/WPE_IMPORT.md`「音频与媒体集成」。

#[cfg(target_os = "windows")]
mod audio;
#[cfg(target_os = "windows")]
mod colors;
#[cfg(target_os = "windows")]
mod media;
#[cfg(target_os = "windows")]
mod spectrum;

use kabegame_core::settings::Settings;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::webview::SubframeId;

/// 推给网页壁纸页面的一条数据，字段与 WPE 回调参数同名（API.md §3.2），`type` 区分是哪个回调。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WpeMediaMessage {
    /// 128 个浮点：0–63 左声道、64–127 右声道，各自低频在前；已去掉 NaN / Infinity。
    Audio {
        data: Vec<f32>,
    },
    Status {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Properties {
        title: String,
        artist: String,
        sub_title: String,
        album_title: String,
        album_artist: String,
        /// 逗号分隔
        genres: String,
        /// `music` / `video` / `image`
        content_type: String,
    },
    #[serde(rename_all = "camelCase")]
    Thumbnail {
        /// `data:image/png;base64,…`，无封面时为空串
        thumbnail: String,
        primary_color: String,
        secondary_color: String,
        tertiary_color: String,
        text_color: String,
        high_contrast_color: String,
    },
    /// 0 停止 / 1 播放 / 2 暂停
    Playback {
        state: u8,
    },
    /// 秒
    Timeline {
        position: f64,
        duration: f64,
    },
}

impl WpeMediaMessage {
    /// 媒体快照里的槽位（新订阅按 Properties → Thumbnail → Playback → Timeline 补发）；状态与音频不缓存。
    fn media_slot(&self) -> Option<usize> {
        match self {
            Self::Properties { .. } => Some(0),
            Self::Thumbnail { .. } => Some(1),
            Self::Playback { .. } => Some(2),
            Self::Timeline { .. } => Some(3),
            Self::Audio { .. } | Self::Status { .. } => None,
        }
    }
}

/// 订阅的数据类别：`audio` 对应音频监听，`media` 对应五个媒体监听。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WpeMediaKind {
    Audio,
    Media,
}

/// 一条订阅的发送端；返回 false 表示对端 webview 已不存在，订阅随即删除。
/// frame 已销毁时 Tauri Channel 的发送照样成功，frame 级释放靠 [`WpeMediaHub::release_frame`]。
pub trait MediaSink: Send + Sync {
    fn send(&self, message: &WpeMediaMessage) -> bool;
}

impl MediaSink for tauri::ipc::Channel<WpeMediaMessage> {
    fn send(&self, message: &WpeMediaMessage) -> bool {
        tauri::ipc::Channel::send(self, message.clone()).is_ok()
    }
}

/// 采集 / 监视的启动器：生产用系统实现，单测换成不碰系统接口的假实现。返回的句柄丢弃即停止。
trait MediaSources: Send + Sync {
    fn start_audio(&self) -> Box<dyn Send>;
    fn start_media(&self) -> Box<dyn Send>;
}

/// 一条订阅：归属某个 webview 里的某个子 frame（网页壁纸 iframe）。
struct Subscription {
    label: String,
    frame: SubframeId,
    kind: WpeMediaKind,
    sink: Box<dyn MediaSink>,
}

struct HubState {
    subs: Vec<Subscription>,
    media_enabled: bool,
    /// 运行中的回环采集，丢弃即停。
    audio: Option<Box<dyn Send>>,
    /// 运行中的媒体会话监视，丢弃即停。
    media: Option<Box<dyn Send>>,
    /// 媒体每类最后一条，新订阅补发；监视停止即清空，避免重开后补发过期数据。
    last_media: [Option<WpeMediaMessage>; 4],
}

static HUB: OnceLock<WpeMediaHub> = OnceLock::new();

/// 全局订阅表：有 audio 订阅才开采集线程，有 media 订阅且「媒体集成」打开才开媒体监视；
/// 每次增删后按订阅表重算两者该不该运行（[`Self::reconcile`]）。
///
/// 采集 / 监视线程会回调 [`Self::broadcast`]（要拿状态锁），所以停止它们（丢弃句柄会 join 线程）一律放在锁外。
pub struct WpeMediaHub {
    state: Mutex<HubState>,
    sources: Box<dyn MediaSources>,
}

impl WpeMediaHub {
    /// 首次调用时创建并读取「媒体集成」设置，只在订阅路径（Settings 已就绪）调用。
    pub fn global() -> &'static Self {
        HUB.get_or_init(|| {
            Self::new(
                Box::new(SystemSources),
                Settings::global().get_wpe_media_integration(),
            )
        })
    }

    /// 已创建才返回。释放与设置变化走这里：没创建就没有订阅，而窗口 / frame 销毁事件可能早于 Settings
    /// 初始化（主窗口在初始化之前就建好），不能为此去创建（[`Self::global`] 会读设置）。
    pub fn existing() -> Option<&'static Self> {
        HUB.get()
    }

    fn new(sources: Box<dyn MediaSources>, media_enabled: bool) -> Self {
        Self {
            state: Mutex::new(HubState {
                subs: Vec::new(),
                media_enabled,
                audio: None,
                media: None,
                last_media: Default::default(),
            }),
            sources,
        }
    }

    fn lock(&self) -> MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 新订阅；同一 `(label, frame, kind)` 已有的旧条被替换（iframe 自己刷新、frame 不变）。
    /// media 先收到 `Status`，监视在运行时再补发当前快照，之后随变化推送。
    pub fn subscribe(
        &self,
        label: &str,
        frame: SubframeId,
        kind: WpeMediaKind,
        sink: Box<dyn MediaSink>,
    ) {
        let stopped = {
            let mut state = self.lock();
            state
                .subs
                .retain(|s| !(s.label == label && s.frame == frame && s.kind == kind));
            let mut alive = true;
            if kind == WpeMediaKind::Media {
                alive = sink.send(&WpeMediaMessage::Status {
                    enabled: state.media_enabled,
                });
                if alive && state.media_enabled && state.media.is_some() {
                    alive = state
                        .last_media
                        .iter()
                        .flatten()
                        .all(|message| sink.send(message));
                }
            }
            if alive {
                state.subs.push(Subscription {
                    label: label.to_string(),
                    frame: frame.clone(),
                    kind,
                    sink,
                });
            }
            tracing::debug!(
                label,
                frame = &*frame.0,
                ?kind,
                subscriptions = state.subs.len(),
                "网页壁纸媒体订阅"
            );
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 子 frame 销毁（`WebviewEvent::SubframeDestroyed`）：删这个 frame 的全部订阅。
    pub fn release_frame(&self, label: &str, frame: &SubframeId) {
        self.release(
            |s| s.label == label && &s.frame == frame,
            label,
            Some(frame),
        );
    }

    /// 窗口销毁：删这个 webview 的全部订阅。
    pub fn release_label(&self, label: &str) {
        self.release(|s| s.label == label, label, None);
    }

    fn release(
        &self,
        matches: impl Fn(&Subscription) -> bool,
        label: &str,
        frame: Option<&SubframeId>,
    ) {
        let stopped = {
            let mut state = self.lock();
            let before = state.subs.len();
            state.subs.retain(|s| !matches(s));
            if state.subs.len() == before {
                return;
            }
            tracing::debug!(
                label,
                frame = frame.map(|f| &*f.0),
                released = before - state.subs.len(),
                subscriptions = state.subs.len(),
                "释放网页壁纸媒体订阅"
            );
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 设置「媒体集成」变化：向全部 media 订阅推 `Status`，并启停监视（关掉时快照随之清空）。
    pub fn set_media_enabled(&self, enabled: bool) {
        let stopped = {
            let mut state = self.lock();
            if state.media_enabled == enabled {
                return;
            }
            state.media_enabled = enabled;
            let status = WpeMediaMessage::Status { enabled };
            state
                .subs
                .retain(|s| s.kind != WpeMediaKind::Media || s.sink.send(&status));
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 采集线程 / 监视器回调：按 kind 广播，发送失败的订阅删除后重算启停。
    /// 对应的源已停止时（迟到的最后一帧）直接丢弃。
    fn broadcast(&self, kind: WpeMediaKind, message: &WpeMediaMessage) {
        let stopped = {
            let mut state = self.lock();
            match kind {
                WpeMediaKind::Audio if state.audio.is_none() => return,
                WpeMediaKind::Media if state.media.is_none() => return,
                _ => {}
            }
            if let Some(slot) = message.media_slot() {
                state.last_media[slot] = Some(message.clone());
            }
            let before = state.subs.len();
            state
                .subs
                .retain(|s| s.kind != kind || s.sink.send(message));
            if state.subs.len() == before {
                return;
            }
            tracing::debug!(
                ?kind,
                subscriptions = state.subs.len(),
                "网页壁纸媒体订阅发送失败，已删除"
            );
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 按订阅表启停采集与监视。启动在锁内（新线程回调广播时会等锁释放）；要停的句柄交给调用方在锁外丢弃。
    #[must_use]
    fn reconcile(&self, state: &mut HubState) -> Vec<Box<dyn Send>> {
        let mut stopped = Vec::new();
        let want_audio = state.subs.iter().any(|s| s.kind == WpeMediaKind::Audio);
        let want_media =
            state.media_enabled && state.subs.iter().any(|s| s.kind == WpeMediaKind::Media);
        if want_audio && state.audio.is_none() {
            state.audio = Some(self.sources.start_audio());
            tracing::info!("网页壁纸音频采集已启动");
        } else if !want_audio {
            if let Some(handle) = state.audio.take() {
                stopped.push(handle);
                tracing::info!("网页壁纸音频采集已停止");
            }
        }
        if want_media && state.media.is_none() {
            state.media = Some(self.sources.start_media());
            tracing::info!("网页壁纸媒体会话监视已启动");
        } else if !want_media {
            if let Some(handle) = state.media.take() {
                stopped.push(handle);
                state.last_media = Default::default();
                tracing::info!("网页壁纸媒体会话监视已停止");
            }
        }
        stopped
    }
}

/// 系统实现：Windows 用 WASAPI 回环与 SMTC，其它平台不产生数据。
struct SystemSources;

#[cfg(target_os = "windows")]
impl MediaSources for SystemSources {
    fn start_audio(&self) -> Box<dyn Send> {
        Box::new(audio::AudioCapture::start(|frame| {
            WpeMediaHub::global().broadcast(
                WpeMediaKind::Audio,
                &WpeMediaMessage::Audio {
                    data: frame.to_vec(),
                },
            )
        }))
    }

    fn start_media(&self) -> Box<dyn Send> {
        Box::new(media::MediaWatcher::start(|message| {
            WpeMediaHub::global().broadcast(WpeMediaKind::Media, &message)
        }))
    }
}

#[cfg(not(target_os = "windows"))]
impl MediaSources for SystemSources {
    fn start_audio(&self) -> Box<dyn Send> {
        Box::new(())
    }

    fn start_media(&self) -> Box<dyn Send> {
        Box::new(())
    }
}

/// 采集 / 监视线程的 COM 初始化（MTA），线程退出时对称反初始化。
#[cfg(target_os = "windows")]
struct ComGuard(bool);

#[cfg(target_os = "windows")]
impl ComGuard {
    fn init() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        Self(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

#[cfg(target_os = "windows")]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct Counters {
        audio_started: AtomicUsize,
        audio_stopped: AtomicUsize,
        media_started: AtomicUsize,
        media_stopped: AtomicUsize,
    }

    struct Handle(Arc<Counters>, bool);

    impl Drop for Handle {
        fn drop(&mut self) {
            let counter = if self.1 {
                &self.0.audio_stopped
            } else {
                &self.0.media_stopped
            };
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeSources(Arc<Counters>);

    impl MediaSources for FakeSources {
        fn start_audio(&self) -> Box<dyn Send> {
            self.0.audio_started.fetch_add(1, Ordering::SeqCst);
            Box::new(Handle(self.0.clone(), true))
        }

        fn start_media(&self) -> Box<dyn Send> {
            self.0.media_started.fetch_add(1, Ordering::SeqCst);
            Box::new(Handle(self.0.clone(), false))
        }
    }

    #[derive(Clone, Default)]
    struct Sink {
        received: Arc<Mutex<Vec<WpeMediaMessage>>>,
        dead: Arc<AtomicBool>,
    }

    impl Sink {
        fn received(&self) -> Vec<WpeMediaMessage> {
            self.received.lock().unwrap().clone()
        }
    }

    impl MediaSink for Sink {
        fn send(&self, message: &WpeMediaMessage) -> bool {
            if self.dead.load(Ordering::SeqCst) {
                return false;
            }
            self.received.lock().unwrap().push(message.clone());
            true
        }
    }

    fn hub(media_enabled: bool) -> (WpeMediaHub, Arc<Counters>) {
        let counters = Arc::new(Counters::default());
        (
            WpeMediaHub::new(Box::new(FakeSources(counters.clone())), media_enabled),
            counters,
        )
    }

    fn frame(id: &str) -> SubframeId {
        SubframeId::new(id)
    }

    fn count(hub: &WpeMediaHub) -> usize {
        hub.lock().subs.len()
    }

    fn audio(value: f32) -> WpeMediaMessage {
        WpeMediaMessage::Audio {
            data: vec![value; 128],
        }
    }

    #[test]
    fn same_frame_same_kind_replaces_old_subscription() {
        let (hub, counters) = hub(true);
        let old = Sink::default();
        let new = Sink::default();
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(old.clone()),
        );
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(new.clone()),
        );
        assert_eq!(count(&hub), 1);
        hub.broadcast(WpeMediaKind::Audio, &audio(0.5));
        assert!(old.received().is_empty());
        assert_eq!(new.received(), vec![audio(0.5)]);
        // 替换不会重启采集
        assert_eq!(counters.audio_started.load(Ordering::SeqCst), 1);
        assert_eq!(counters.audio_stopped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn release_frame_only_drops_that_frame() {
        let (hub, counters) = hub(true);
        hub.subscribe(
            "main",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "main",
            frame("a"),
            WpeMediaKind::Media,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "main",
            frame("b"),
            WpeMediaKind::Audio,
            Box::new(Sink::default()),
        );
        hub.release_frame("main", &frame("a"));
        assert_eq!(count(&hub), 2);
        // 还有 audio 订阅：采集不停；media 没了：监视停
        assert_eq!(counters.audio_stopped.load(Ordering::SeqCst), 0);
        assert_eq!(counters.media_stopped.load(Ordering::SeqCst), 1);
        // 迟到的销毁事件（frame 已无订阅）什么都不做
        hub.release_frame("main", &frame("a"));
        assert_eq!(count(&hub), 2);
    }

    #[test]
    fn release_label_drops_whole_webview_and_stops_sources() {
        let (hub, counters) = hub(true);
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "wallpaper",
            frame("b"),
            WpeMediaKind::Media,
            Box::new(Sink::default()),
        );
        hub.release_label("wallpaper");
        assert_eq!(count(&hub), 0);
        assert_eq!(counters.audio_stopped.load(Ordering::SeqCst), 1);
        assert_eq!(counters.media_stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_send_removes_subscription_and_reconciles() {
        let (hub, counters) = hub(true);
        let sink = Sink::default();
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            Box::new(sink.clone()),
        );
        sink.dead.store(true, Ordering::SeqCst);
        hub.broadcast(WpeMediaKind::Audio, &audio(0.1));
        assert_eq!(count(&hub), 0);
        assert_eq!(counters.audio_stopped.load(Ordering::SeqCst), 1);
        // 源停了之后迟到的帧丢弃
        hub.broadcast(WpeMediaKind::Audio, &audio(0.2));
        assert!(sink.received().is_empty());
    }

    #[test]
    fn media_subscription_gets_status_and_snapshot() {
        let (hub, counters) = hub(true);
        let first = Sink::default();
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Media,
            Box::new(first.clone()),
        );
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);
        let playback = WpeMediaMessage::Playback { state: 1 };
        let timeline = WpeMediaMessage::Timeline {
            position: 3.0,
            duration: 10.0,
        };
        hub.broadcast(WpeMediaKind::Media, &timeline);
        hub.broadcast(WpeMediaKind::Media, &playback);
        assert_eq!(
            first.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                timeline.clone(),
                playback.clone()
            ]
        );
        // 晚来的订阅按 Properties → Thumbnail → Playback → Timeline 补快照
        let late = Sink::default();
        hub.subscribe(
            "main",
            frame("b"),
            WpeMediaKind::Media,
            Box::new(late.clone()),
        );
        assert_eq!(
            late.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                playback,
                timeline
            ]
        );
        // 音频订阅收不到媒体数据，媒体订阅也收不到音频
        hub.broadcast(WpeMediaKind::Audio, &audio(1.0));
        assert_eq!(late.received().len(), 3);
    }

    #[test]
    fn media_integration_toggle_pushes_status_and_restarts_watcher() {
        let (hub, counters) = hub(false);
        let sink = Sink::default();
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Media,
            Box::new(sink.clone()),
        );
        // 关闭时只收到 enabled: false，不开监视
        assert_eq!(
            sink.received(),
            vec![WpeMediaMessage::Status { enabled: false }]
        );
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 0);

        hub.set_media_enabled(true);
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);
        hub.broadcast(WpeMediaKind::Media, &WpeMediaMessage::Playback { state: 2 });

        hub.set_media_enabled(false);
        assert_eq!(counters.media_stopped.load(Ordering::SeqCst), 1);
        assert_eq!(
            sink.received(),
            vec![
                WpeMediaMessage::Status { enabled: false },
                WpeMediaMessage::Status { enabled: true },
                WpeMediaMessage::Playback { state: 2 },
                WpeMediaMessage::Status { enabled: false },
            ]
        );
        // 快照随监视停止清空：再打开后的新订阅不会收到过期的播放状态
        hub.set_media_enabled(true);
        let late = Sink::default();
        hub.subscribe(
            "main",
            frame("b"),
            WpeMediaKind::Media,
            Box::new(late.clone()),
        );
        assert_eq!(
            late.received(),
            vec![WpeMediaMessage::Status { enabled: true }]
        );
    }

    #[test]
    fn messages_serialize_like_wpe_callbacks() {
        let value = serde_json::to_value(WpeMediaMessage::Thumbnail {
            thumbnail: String::new(),
            primary_color: "rgb(0, 0, 0)".into(),
            secondary_color: "rgb(1, 1, 1)".into(),
            tertiary_color: "rgb(2, 2, 2)".into(),
            text_color: "rgb(255, 255, 255)".into(),
            high_contrast_color: "rgb(255, 255, 255)".into(),
        })
        .unwrap();
        assert_eq!(value["type"], "thumbnail");
        assert_eq!(value["primaryColor"], "rgb(0, 0, 0)");
        assert_eq!(value["highContrastColor"], "rgb(255, 255, 255)");
        let value = serde_json::to_value(WpeMediaMessage::Properties {
            title: "t".into(),
            artist: String::new(),
            sub_title: "s".into(),
            album_title: String::new(),
            album_artist: String::new(),
            genres: String::new(),
            content_type: "music".into(),
        })
        .unwrap();
        assert_eq!(value["type"], "properties");
        assert_eq!(value["subTitle"], "s");
        assert_eq!(value["contentType"], "music");
        let kind: WpeMediaKind = serde_json::from_value(serde_json::json!("audio")).unwrap();
        assert_eq!(kind, WpeMediaKind::Audio);
    }
}
