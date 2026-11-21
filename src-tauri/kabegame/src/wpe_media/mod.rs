//! WPE 网页壁纸的音频与媒体集成（Phase 8）：页面登记 `wallpaperRegisterAudioListener` /
//! `wallpaperRegisterMedia*Listener` 时，垫片向宿主订阅一类数据并交出一个 Tauri Channel，数据只推回发起订阅的
//! 那个 iframe（tauri 补丁 18 起，作为命令参数的 Channel 只投递到调用方 frame）。
//!
//! 订阅归属 `(webview label, 子 frame, 类型)`：frame 销毁（`WebviewEvent::SubframeDestroyed`）即释放，同一 frame
//! 再订阅同一类替换旧条，窗口销毁释放整个 label，发送失败只作兜底——Channel 发往已销毁的 frame 会被运行时静默
//! 丢弃、发送照样成功，所以不能只靠它。
//!
//! 有 audio 订阅才开系统音频回环采集（`audio/`：Windows 是 WASAPI 回环，macOS 是 Core Audio 进程 tap），有 media
//! 订阅且「媒体集成」打开才开系统媒体会话监视（Windows 是 `media.rs` 直接读 SMTC，macOS 经 `tauri-plugin-sysmedia`
//! 的读数走 `sysmedia.rs`）；最后一个订阅离开即停。订阅命令按平台放行：Windows、macOS 两类都收，Linux 都拒。
//! 见 `cocs/wpe/WPE_IMPORT.md`「音频与媒体集成」。

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod audio;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod colors;
#[cfg(target_os = "windows")]
mod media;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod projection;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod spectrum;
#[cfg(target_os = "macos")]
mod sysmedia;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod wpe_spectrum;

use kabegame_core::settings::Settings;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::webview::SubframeId;

/// 推给网页壁纸页面的一条数据，字段与 WPE 回调参数同名（API.md §3.2），`type` 区分是哪个回调。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WpeMediaMessage {
    /// 128 个浮点：0–63 左声道、64–127 右声道，各自低频在前；已去掉 NaN / Infinity。
    /// `data` 是网页壁纸用的自定频谱（`spectrum.rs`，大致 0–1）；`raw` 是 WPE 采集线程的原始频谱（`wpe_spectrum.rs`，线性原值，
    /// P4e 步骤 4），只给场景宿主用，它再照 WPE 做每帧的自适应归一化。网页壁纸的垫片只读 `data`。
    Audio {
        data: Vec<f32>,
        raw: Vec<f32>,
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
    /// 场景宿主的封面：原尺寸 PNG（Spotify 预处理之后）的 base64、不带 `data:` 前缀，空串表示没有封面；
    /// `colors` 依次是 primary、secondary、tertiary、text、highContrast，0–255 整数，没有封面时全 0。
    /// 只发给 [`WpeMediaFlavor::Scene`] 的订阅；网页订阅收到的是 [`Self::Thumbnail`]。
    SceneThumbnail {
        png: String,
        colors: [[u8; 3]; 5],
    },
}

/// 媒体订阅的投影：网页壁纸沿用 Phase 8 的数据（外推、缩图、`music` 缺省），场景宿主照 WPE 的数据
/// （整秒时间轴、原尺寸封面、没有会话时复位）。由命令按调用方文档决定，页面不能自己选。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WpeMediaFlavor {
    Web,
    Scene,
}

impl WpeMediaFlavor {
    fn index(self) -> usize {
        match self {
            Self::Web => 0,
            Self::Scene => 1,
        }
    }
}

impl WpeMediaMessage {
    /// 媒体快照里的槽位（新订阅按 Properties → Thumbnail → Playback → Timeline 补发）；状态与音频不缓存。
    fn media_slot(&self) -> Option<usize> {
        match self {
            Self::Properties { .. } => Some(0),
            Self::Thumbnail { .. } | Self::SceneThumbnail { .. } => Some(1),
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

/// media 订阅的「媒体集成」开关跟谁：桌面（壁纸窗口）跟全局设置 `wpeMediaIntegration`，预览（主窗口，
/// 含应用背景）跟这张壁纸自己的预览设置（metadata 的 `previewSettings.mediaIntegration`）。由命令按调用方
/// 窗口决定，页面不能自己选。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaGate {
    Global,
    Preview { image_id: String },
}

/// 一条订阅：归属某个 webview 里的某个子 frame（网页壁纸 iframe）。
struct Subscription {
    label: String,
    frame: SubframeId,
    kind: WpeMediaKind,
    /// 只对 media 订阅有意义（audio 订阅不分投影）
    flavor: WpeMediaFlavor,
    /// 只对 media 订阅有意义：开关跟谁、当前是否打开（关着的订阅只收过 `Status { enabled: false }`）
    gate: MediaGate,
    enabled: bool,
    sink: Box<dyn MediaSink>,
}

struct HubState {
    subs: Vec<Subscription>,
    /// 全局「媒体集成」设置，只管 [`MediaGate::Global`] 的订阅
    media_enabled: bool,
    /// 运行中的回环采集，丢弃即停。
    audio: Option<Box<dyn Send>>,
    /// 运行中的媒体会话监视，丢弃即停。
    media: Option<Box<dyn Send>>,
    /// 媒体每类最后一条（按 flavor 各一份），新订阅补发；监视停止即清空，避免重开后补发过期数据。
    last_media: [[Option<WpeMediaMessage>; 4]; 2],
}

static HUB: OnceLock<WpeMediaHub> = OnceLock::new();

/// 全局订阅表：有 audio 订阅才开采集线程，有打开了「媒体集成」的 media 订阅才开媒体监视；
/// 每次增删后按订阅表重算两者该不该运行（[`Self::reconcile`]）。
///
/// 采集 / 监视线程会回调 [`Self::broadcast`]（要拿状态锁），所以停止它们（丢弃句柄会 join 线程）一律放在锁外。
pub struct WpeMediaHub {
    state: Mutex<HubState>,
    sources: Box<dyn MediaSources>,
}

impl WpeMediaHub {
    /// 首次调用时创建并读取「媒体集成」设置，只在订阅路径（Settings 已就绪）调用。`app` 只在创建时用：
    /// 系统媒体会话经 `tauri-plugin-sysmedia`（`app.sysmedia()`）读。
    pub fn global<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &'static Self {
        HUB.get_or_init(|| {
            Self::new(
                Box::new(SystemSources::new(app)),
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
    /// media 先收到 `Status`，监视在运行时再补发自己 flavor 的当前快照，之后随变化推送。
    /// 补发：网页订阅补全部缓存；场景订阅照 WPE 的 `AddMediaListener`，`title` 非空才补属性、有封面才补封面、
    /// 状态非 0 才补播放、`duration` 非 0 才补时间轴。
    pub fn subscribe(
        &self,
        label: &str,
        frame: SubframeId,
        kind: WpeMediaKind,
        flavor: WpeMediaFlavor,
        sink: Box<dyn MediaSink>,
    ) {
        self.subscribe_gated(label, frame, kind, flavor, MediaGate::Global, false, sink);
    }

    /// 同 [`Self::subscribe`]，另给开关归属；`preview_enabled` 只对 [`MediaGate::Preview`] 有意义（这张壁纸预览设置的
    /// 当前值，由命令读 metadata 得出），[`MediaGate::Global`] 取全局设置。
    #[allow(clippy::too_many_arguments)]
    pub fn subscribe_gated(
        &self,
        label: &str,
        frame: SubframeId,
        kind: WpeMediaKind,
        flavor: WpeMediaFlavor,
        gate: MediaGate,
        preview_enabled: bool,
        sink: Box<dyn MediaSink>,
    ) {
        let stopped = {
            let mut state = self.lock();
            state
                .subs
                .retain(|s| !(s.label == label && s.frame == frame && s.kind == kind));
            let enabled = match gate {
                MediaGate::Global => state.media_enabled,
                MediaGate::Preview { .. } => preview_enabled,
            };
            let mut alive = true;
            if kind == WpeMediaKind::Media {
                alive = sink.send(&WpeMediaMessage::Status { enabled });
                if alive && enabled && state.media.is_some() {
                    alive = replay_cache(&state.last_media, flavor, sink.as_ref());
                }
            }
            if alive {
                state.subs.push(Subscription {
                    label: label.to_string(),
                    frame: frame.clone(),
                    kind,
                    flavor,
                    gate,
                    enabled,
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

    /// 全局设置「媒体集成」变化：只改跟全局的订阅（桌面），见 [`set_enabled_where`]。
    pub fn set_media_enabled(&self, enabled: bool) {
        let stopped = {
            let mut state = self.lock();
            if state.media_enabled == enabled {
                return;
            }
            state.media_enabled = enabled;
            set_enabled_where(&mut state, |gate| *gate == MediaGate::Global, enabled);
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 某张壁纸的预览设置「媒体集成」变化：只改跟这张预览设置的订阅（预览与应用背景）。
    pub fn set_preview_enabled(&self, image_id: &str, enabled: bool) {
        let stopped = {
            let mut state = self.lock();
            set_enabled_where(
                &mut state,
                |gate| matches!(gate, MediaGate::Preview { image_id: id } if id == image_id),
                enabled,
            );
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 监视器回调：一条媒体消息只发给同 flavor 的 media 订阅，并记入该 flavor 的缓存。
    /// 监视已停止（迟到的消息）直接丢弃，发送失败的订阅删除后重算启停。
    fn broadcast_media(&self, flavor: WpeMediaFlavor, message: &WpeMediaMessage) {
        let stopped = {
            let mut state = self.lock();
            if state.media.is_none() {
                return;
            }
            if let Some(slot) = message.media_slot() {
                state.last_media[flavor.index()][slot] = Some(message.clone());
            }
            let before = state.subs.len();
            state.subs.retain(|s| {
                s.kind != WpeMediaKind::Media
                    || s.flavor != flavor
                    || !s.enabled
                    || s.sink.send(message)
            });
            if state.subs.len() == before {
                return;
            }
            tracing::debug!(
                ?flavor,
                subscriptions = state.subs.len(),
                "媒体订阅发送失败，已删除"
            );
            self.reconcile(&mut state)
        };
        drop(stopped);
    }

    /// 采集线程回调：音频按 kind 广播（不分 flavor），发送失败的订阅删除后重算启停。
    /// 对应的源已停止时（迟到的最后一帧）直接丢弃。
    fn broadcast(&self, kind: WpeMediaKind, message: &WpeMediaMessage) {
        let stopped = {
            let mut state = self.lock();
            match kind {
                WpeMediaKind::Audio if state.audio.is_none() => return,
                WpeMediaKind::Media if state.media.is_none() => return,
                _ => {}
            }
            let before = state.subs.len();
            state.subs.retain(|s| {
                s.kind != kind
                    || (kind == WpeMediaKind::Media && !s.enabled)
                    || s.sink.send(message)
            });
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
        let want_media = state
            .subs
            .iter()
            .any(|s| s.kind == WpeMediaKind::Media && s.enabled);
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

/// 把开关归属匹配、且当前值不同的 media 订阅改成 `enabled`：先推 `Status`。打开时若监视已在运行（别的订阅开着），
/// 照新订阅补发缓存；监视没在运行则由 reconcile 启动、之后照常推送。关闭时场景订阅在 Status 之后再收缓存里
/// 不是缺省值的那几类的复位消息（读码推断 WPE 要等重新打开才一起到，这里选当场发，记为已知差异）。缓存只在
/// 监视停止时清空（reconcile）：别的订阅还开着时缓存仍是当前数据，留给之后重新打开的订阅补发。
fn set_enabled_where(state: &mut HubState, matches: impl Fn(&MediaGate) -> bool, enabled: bool) {
    let HubState {
        subs,
        media,
        last_media,
        ..
    } = state;
    let running = media.is_some();
    let resets = if enabled {
        Vec::new()
    } else {
        scene_resets(&last_media[WpeMediaFlavor::Scene.index()])
    };
    subs.retain_mut(|s| {
        if s.kind != WpeMediaKind::Media || s.enabled == enabled || !matches(&s.gate) {
            return true;
        }
        s.enabled = enabled;
        if !s.sink.send(&WpeMediaMessage::Status { enabled }) {
            return false;
        }
        if enabled {
            !running || replay_cache(last_media, s.flavor, s.sink.as_ref())
        } else {
            s.flavor != WpeMediaFlavor::Scene || resets.iter().all(|reset| s.sink.send(reset))
        }
    });
}

/// 给一条 media 订阅补发它 flavor 的缓存；发送失败返回 false。
fn replay_cache(
    last_media: &[[Option<WpeMediaMessage>; 4]; 2],
    flavor: WpeMediaFlavor,
    sink: &dyn MediaSink,
) -> bool {
    last_media[flavor.index()]
        .iter()
        .flatten()
        .filter(|message| flavor == WpeMediaFlavor::Web || scene_replays(message))
        .all(|message| sink.send(message))
}

/// 场景订阅补发的条件（照 WPE `AddMediaListener`）：`title` 非空才补属性，有封面才补封面，
/// 状态非 0 才补播放，`duration` 非 0 才补时间轴。
fn scene_replays(message: &WpeMediaMessage) -> bool {
    match message {
        WpeMediaMessage::Properties { title, .. } => !title.is_empty(),
        WpeMediaMessage::SceneThumbnail { png, .. } => !png.is_empty(),
        WpeMediaMessage::Playback { state } => *state != 0,
        WpeMediaMessage::Timeline { duration, .. } => *duration != 0.0,
        _ => false,
    }
}

/// 关闭「媒体集成」时场景订阅要收的复位消息：缓存里不是缺省值的那几类，回到缺省值。
fn scene_resets(cache: &[Option<WpeMediaMessage>; 4]) -> Vec<WpeMediaMessage> {
    cache
        .iter()
        .flatten()
        .filter_map(|message| match message {
            WpeMediaMessage::Properties {
                title,
                artist,
                sub_title,
                album_title,
                album_artist,
                genres,
                content_type,
            } if [
                title,
                artist,
                sub_title,
                album_title,
                album_artist,
                genres,
                content_type,
            ]
            .iter()
            .any(|s| !s.is_empty()) =>
            {
                Some(WpeMediaMessage::Properties {
                    title: String::new(),
                    artist: String::new(),
                    sub_title: String::new(),
                    album_title: String::new(),
                    album_artist: String::new(),
                    genres: String::new(),
                    content_type: String::new(),
                })
            }
            WpeMediaMessage::SceneThumbnail { png, .. } if !png.is_empty() => {
                Some(WpeMediaMessage::SceneThumbnail {
                    png: String::new(),
                    colors: [[0; 3]; 5],
                })
            }
            WpeMediaMessage::Playback { state } if *state != 0 => {
                Some(WpeMediaMessage::Playback { state: 0 })
            }
            WpeMediaMessage::Timeline { position, duration }
                if *position != 0.0 || *duration != 0.0 =>
            {
                Some(WpeMediaMessage::Timeline {
                    position: 0.0,
                    duration: 0.0,
                })
            }
            _ => None,
        })
        .collect()
}

/// 启动媒体会话监视的闭包：返回的句柄丢弃即停止。
type StartMedia = Box<dyn Fn() -> Box<dyn Send> + Send + Sync>;

/// 系统实现：音频回环在 Windows（WASAPI）与 macOS（进程 tap）；媒体会话 Windows 是 `media.rs`（SMTC），
/// macOS 经插件（`sysmedia.rs`），其余不产生数据。
struct SystemSources {
    start_media: StartMedia,
}

impl SystemSources {
    fn new<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        #[cfg(target_os = "macos")]
        let start_media: StartMedia = {
            let app = app.clone();
            Box::new(move || Box::new(sysmedia::SysmediaBridge::start(&app, broadcast_media_output)))
        };
        // TODO(sysmedia S2): Windows 的 SMTC 迁进插件后同样走 `sysmedia.rs`
        #[cfg(target_os = "windows")]
        let start_media: StartMedia = {
            let _ = app;
            Box::new(|| Box::new(media::MediaWatcher::start(broadcast_media_output)))
        };
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let start_media: StartMedia = {
            let _ = app;
            Box::new(|| Box::new(()))
        };
        Self { start_media }
    }
}

/// 媒体监视的输出交给 hub（hub 一定已建好：监视是它启动的）。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn broadcast_media_output(output: projection::Output) {
    if let Some(hub) = WpeMediaHub::existing() {
        hub.broadcast_media(output.flavor, &output.message)
    }
}

impl MediaSources for SystemSources {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn start_audio(&self) -> Box<dyn Send> {
        Box::new(audio::AudioCapture::start(|web, raw| {
            if let Some(hub) = WpeMediaHub::existing() {
                hub.broadcast(
                    WpeMediaKind::Audio,
                    &WpeMediaMessage::Audio {
                        data: web.to_vec(),
                        raw: raw.to_vec(),
                    },
                )
            }
        }))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    fn start_audio(&self) -> Box<dyn Send> {
        Box::new(())
    }

    fn start_media(&self) -> Box<dyn Send> {
        (self.start_media)()
    }
}

/// 本平台能不能订阅这一类数据（`wpe_web_media_subscribe` 的门控）：有数据源才放行，没有的直接拒，垫片与宿主按
/// 「不可用」处理（场景脚本收到 `enabled: false`）。媒体会话问插件；Windows 的还没迁进插件（S2），先按平台放行。
pub fn kind_available<R: tauri::Runtime>(app: &tauri::AppHandle<R>, kind: WpeMediaKind) -> bool {
    use tauri_plugin_sysmedia::SysmediaExt;
    match kind {
        WpeMediaKind::Audio => cfg!(any(target_os = "windows", target_os = "macos")),
        WpeMediaKind::Media => cfg!(target_os = "windows") || app.sysmedia().available(),
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
            raw: vec![value; 128],
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
            WpeMediaFlavor::Web,
            Box::new(old.clone()),
        );
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            WpeMediaFlavor::Web,
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
            WpeMediaFlavor::Web,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "main",
            frame("a"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "wallpaper",
            frame("a"),
            WpeMediaKind::Audio,
            WpeMediaFlavor::Web,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "main",
            frame("b"),
            WpeMediaKind::Audio,
            WpeMediaFlavor::Web,
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
            WpeMediaFlavor::Web,
            Box::new(Sink::default()),
        );
        hub.subscribe(
            "wallpaper",
            frame("b"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
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
            WpeMediaFlavor::Web,
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
            WpeMediaFlavor::Web,
            Box::new(first.clone()),
        );
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);
        let playback = WpeMediaMessage::Playback { state: 1 };
        let timeline = WpeMediaMessage::Timeline {
            position: 3.0,
            duration: 10.0,
        };
        hub.broadcast_media(WpeMediaFlavor::Web, &timeline);
        hub.broadcast_media(WpeMediaFlavor::Web, &playback);
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
            WpeMediaFlavor::Web,
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
            WpeMediaFlavor::Web,
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
        hub.broadcast_media(WpeMediaFlavor::Web, &WpeMediaMessage::Playback { state: 2 });

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
            WpeMediaFlavor::Web,
            Box::new(late.clone()),
        );
        assert_eq!(
            late.received(),
            vec![WpeMediaMessage::Status { enabled: true }]
        );
    }

    #[test]
    fn preview_gate_follows_its_own_setting() {
        let (hub, counters) = hub(false);
        let desktop = Sink::default();
        let preview = Sink::default();
        let other = Sink::default();
        hub.subscribe(
            "wallpaper",
            frame("d"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            Box::new(desktop.clone()),
        );
        hub.subscribe_gated(
            "main",
            frame("p"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            MediaGate::Preview {
                image_id: "1".into(),
            },
            true,
            Box::new(preview.clone()),
        );
        hub.subscribe_gated(
            "main",
            frame("q"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            MediaGate::Preview {
                image_id: "2".into(),
            },
            false,
            Box::new(other.clone()),
        );
        // 预览开着就开监视，全局关着的桌面与关着的另一张都只有 Status false、收不到数据
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);
        let playing = WpeMediaMessage::Playback { state: 1 };
        hub.broadcast_media(WpeMediaFlavor::Web, &playing);
        let off = WpeMediaMessage::Status { enabled: false };
        let on = WpeMediaMessage::Status { enabled: true };
        assert_eq!(desktop.received(), vec![off.clone()]);
        assert_eq!(preview.received(), vec![on.clone(), playing.clone()]);
        assert_eq!(other.received(), vec![off.clone()]);

        // 全局打开：监视已在运行，桌面补发缓存
        hub.set_media_enabled(true);
        assert_eq!(
            desktop.received(),
            vec![off.clone(), on.clone(), playing.clone()]
        );
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);

        // 关掉图 1 的预览：只有它收 Status false；桌面还开着，监视不停
        hub.set_preview_enabled("1", false);
        assert_eq!(preview.received().last(), Some(&off));
        assert_eq!(other.received(), vec![off.clone()]);
        assert_eq!(counters.media_stopped.load(Ordering::SeqCst), 0);
        // 同值不重复推
        hub.set_preview_enabled("1", false);
        assert_eq!(preview.received().len(), 3);

        hub.set_media_enabled(false);
        assert_eq!(counters.media_stopped.load(Ordering::SeqCst), 1);
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

    fn props(title: &str) -> WpeMediaMessage {
        WpeMediaMessage::Properties {
            title: title.into(),
            artist: String::new(),
            sub_title: String::new(),
            album_title: String::new(),
            album_artist: String::new(),
            genres: String::new(),
            content_type: "music".into(),
        }
    }

    fn scene_thumb(png: &str) -> WpeMediaMessage {
        WpeMediaMessage::SceneThumbnail {
            png: png.into(),
            colors: if png.is_empty() {
                [[0; 3]; 5]
            } else {
                [[1, 2, 3]; 5]
            },
        }
    }

    #[test]
    fn flavors_get_their_own_messages_and_replays() {
        let (hub, counters) = hub(true);
        let web = Sink::default();
        let scene = Sink::default();
        hub.subscribe(
            "main",
            frame("web"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            Box::new(web.clone()),
        );
        hub.subscribe(
            "main",
            frame("scene"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(scene.clone()),
        );
        // 两种订阅共用一个监视
        assert_eq!(counters.media_started.load(Ordering::SeqCst), 1);

        let web_thumb = WpeMediaMessage::Thumbnail {
            thumbnail: "data:x".into(),
            primary_color: "rgb(1, 2, 3)".into(),
            secondary_color: "rgb(1, 2, 3)".into(),
            tertiary_color: "rgb(1, 2, 3)".into(),
            text_color: "rgb(1, 2, 3)".into(),
            high_contrast_color: "rgb(1, 2, 3)".into(),
        };
        hub.broadcast_media(WpeMediaFlavor::Web, &props("web title"));
        hub.broadcast_media(WpeMediaFlavor::Web, &web_thumb);
        hub.broadcast_media(WpeMediaFlavor::Scene, &props("scene title"));
        hub.broadcast_media(WpeMediaFlavor::Scene, &scene_thumb("AAAA"));
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Playback { state: 2 },
        );
        // 广播不串
        assert_eq!(
            web.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                props("web title"),
                web_thumb.clone()
            ]
        );
        assert_eq!(
            scene.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                props("scene title"),
                scene_thumb("AAAA"),
                WpeMediaMessage::Playback { state: 2 }
            ]
        );

        // 晚来的订阅各补自己 flavor 的缓存
        let late_web = Sink::default();
        hub.subscribe(
            "w2",
            frame("a"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            Box::new(late_web.clone()),
        );
        assert_eq!(
            late_web.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                props("web title"),
                web_thumb
            ]
        );
        let late_scene = Sink::default();
        hub.subscribe(
            "w3",
            frame("a"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(late_scene.clone()),
        );
        assert_eq!(
            late_scene.received(),
            vec![
                WpeMediaMessage::Status { enabled: true },
                props("scene title"),
                scene_thumb("AAAA"),
                WpeMediaMessage::Playback { state: 2 }
            ]
        );
    }

    #[test]
    fn scene_replay_skips_default_values() {
        let (hub, _) = hub(true);
        hub.subscribe(
            "main",
            frame("first"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(Sink::default()),
        );
        // title 空不补属性（哪怕别的字段非空）、无封面不补、状态 0 不补、duration 0 不补
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Properties {
                title: String::new(),
                artist: "a".into(),
                sub_title: String::new(),
                album_title: String::new(),
                album_artist: String::new(),
                genres: String::new(),
                content_type: "music".into(),
            },
        );
        hub.broadcast_media(WpeMediaFlavor::Scene, &scene_thumb(""));
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Playback { state: 0 },
        );
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Timeline {
                position: 5.0,
                duration: 0.0,
            },
        );
        let late = Sink::default();
        hub.subscribe(
            "main",
            frame("late"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(late.clone()),
        );
        assert_eq!(
            late.received(),
            vec![WpeMediaMessage::Status { enabled: true }]
        );
        // duration 非 0 才补时间轴
        let timeline = WpeMediaMessage::Timeline {
            position: 5.0,
            duration: 200.0,
        };
        hub.broadcast_media(WpeMediaFlavor::Scene, &timeline);
        let later = Sink::default();
        hub.subscribe(
            "main",
            frame("later"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(later.clone()),
        );
        assert_eq!(
            later.received(),
            vec![WpeMediaMessage::Status { enabled: true }, timeline]
        );
    }

    #[test]
    fn disabling_integration_resets_scene_subscribers_and_clears_cache() {
        let (hub, _) = hub(true);
        let scene = Sink::default();
        let web = Sink::default();
        hub.subscribe(
            "main",
            frame("scene"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(scene.clone()),
        );
        hub.subscribe(
            "main",
            frame("web"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Web,
            Box::new(web.clone()),
        );
        hub.broadcast_media(WpeMediaFlavor::Scene, &props("t"));
        hub.broadcast_media(WpeMediaFlavor::Scene, &scene_thumb("AAAA"));
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Playback { state: 0 },
        );
        hub.broadcast_media(
            WpeMediaFlavor::Scene,
            &WpeMediaMessage::Timeline {
                position: 0.0,
                duration: 0.0,
            },
        );
        let before = scene.received().len();
        hub.set_media_enabled(false);
        let got = scene.received()[before..].to_vec();
        // Status{false} 之后只复位缓存里不是缺省值的类别（属性、封面），状态 0 与时间轴 0/0 已是缺省值
        assert_eq!(
            got,
            vec![
                WpeMediaMessage::Status { enabled: false },
                WpeMediaMessage::Properties {
                    title: String::new(),
                    artist: String::new(),
                    sub_title: String::new(),
                    album_title: String::new(),
                    album_artist: String::new(),
                    genres: String::new(),
                    content_type: String::new(),
                },
                scene_thumb(""),
            ]
        );
        // 网页订阅只收 Status
        assert_eq!(
            web.received().last(),
            Some(&WpeMediaMessage::Status { enabled: false })
        );
        // 重新打开：缓存已清空，新订阅只有 Status
        hub.set_media_enabled(true);
        let late = Sink::default();
        hub.subscribe(
            "main",
            frame("late"),
            WpeMediaKind::Media,
            WpeMediaFlavor::Scene,
            Box::new(late.clone()),
        );
        assert_eq!(
            late.received(),
            vec![WpeMediaMessage::Status { enabled: true }]
        );
    }

    #[test]
    fn audio_subscription_ignores_flavor() {
        let (hub, _) = hub(true);
        let sink = Sink::default();
        hub.subscribe(
            "main",
            frame("scene"),
            WpeMediaKind::Audio,
            WpeMediaFlavor::Scene,
            Box::new(sink.clone()),
        );
        hub.broadcast(WpeMediaKind::Audio, &audio(0.5));
        assert_eq!(sink.received(), vec![audio(0.5)]);
    }

    #[test]
    fn scene_thumbnail_serializes_like_the_agreed_shape() {
        let value = serde_json::to_value(WpeMediaMessage::SceneThumbnail {
            png: "iVBO".into(),
            colors: [
                [1, 2, 3],
                [4, 5, 6],
                [7, 8, 9],
                [10, 11, 12],
                [255, 255, 255],
            ],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "sceneThumbnail",
                "png": "iVBO",
                "colors": [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [255, 255, 255]],
            })
        );
    }
}
