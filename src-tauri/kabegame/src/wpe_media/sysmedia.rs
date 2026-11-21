//! 系统媒体会话的读数（`tauri-plugin-sysmedia`）→ 两个投影（`projection.rs`）→ 推出。
//!
//! 插件读到就推、不攒批；这里照 `winrtutil64.exe` 的主循环攒批（rea-p11-media 1.4：每 100 ms 取一次队列）：
//! 收到第一条读数后把之后 100 ms 内到的攒成一批，批里有会话切换就只认最后一次切换的快照和它之后的读数，
//! 同类只认最后一条（[`plan_batch`]）。实测（P11c 走查）会话退出时先报一次播放状态、约 17 ms 后才切会话，
//! WPE 不发那条状态，攒批之后同样不发。macOS 自然切歌时新时长与「播放中」比新标题早约 300 ms，100 ms 盖不住，
//! 这段「旧标题 + 新时长」的混合态接受（`.claude/plans/sysmedia/README.md` 决策 6）。
//!
//! 每秒醒一次给网页投影的播放中时间轴外推（场景投影不外推）。投影的时间单位是 FILETIME（100 ns、1601 起），
//! 插件的是微秒与 Unix 纪元，在这里换算。
//!
//! 现在只有 macOS 走这里；Windows 仍是 `media.rs` 直接读 SMTC，迁进插件后（S2）也走这里。

use super::projection::{Output, Projections, RawProperties, RawTimeline};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_sysmedia::{
    MediaEvent, MediaKind, MediaProperties, MediaSnapshot, PlaybackStatus, SysmediaExt, Timeline,
    Watch,
};

const TICK: Duration = Duration::from_secs(1);
/// 攒批的时长：winrtutil 主循环取队列的间隔（`Sleep(100)`，rea-p11-media 1.4）。
const POLL: Duration = Duration::from_millis(100);
/// `DateTime.UniversalTime`（1601 起的 100ns）与 Unix 纪元之差。
const FILETIME_UNIX_OFFSET: i64 = 116_444_736_000_000_000;

#[derive(Debug)]
enum Signal {
    Event(MediaEvent),
    Stop,
}

/// 运行中的系统媒体会话监视；丢弃即停止。
pub struct SysmediaBridge {
    signals: Sender<Signal>,
    watch: Option<Watch>,
    thread: Option<JoinHandle<()>>,
}

impl SysmediaBridge {
    pub fn start<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        emit: impl Fn(Output) + Send + 'static,
    ) -> Self {
        let (signals, receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("kabegame-wpe-media".to_string())
            .spawn(move || run(receiver, &emit))
            .map_err(|error| tracing::warn!("启动网页壁纸媒体会话线程失败: {error}"))
            .ok();
        let watch = app.sysmedia().watch({
            let signals = signals.clone();
            move |event| {
                let _ = signals.send(Signal::Event(event));
            }
        });
        Self {
            signals,
            watch: Some(watch),
            thread,
        }
    }
}

impl Drop for SysmediaBridge {
    fn drop(&mut self) {
        // 先停插件（不再有读数进来），再停本线程
        drop(self.watch.take());
        let _ = self.signals.send(Signal::Stop);
        if let Some(thread) = self.thread.take() {
            // 本线程自己触发的停止（广播时发现订阅全没了）不能 join 自己：它处理完当前批会收到 Stop 退出
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

fn run(receiver: Receiver<Signal>, emit: &dyn Fn(Output)) {
    let mut projections = Projections::default();
    loop {
        let first = match receiver.recv_timeout(TICK) {
            Ok(signal) => signal,
            Err(RecvTimeoutError::Timeout) => {
                send_all(emit, projections.tick(now_filetime()));
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let Some(plan) = plan_batch(collect_batch(first, &receiver)) else {
            break;
        };
        apply(&mut projections, plan, emit);
    }
}

fn send_all(emit: &dyn Fn(Output), outputs: Vec<Output>) {
    for output in outputs {
        emit(output);
    }
}

/// 以 `first` 开头，把之后 [`POLL`] 内到的信号攒成一批；收到停止或通道断开立即返回（停止不等）。
fn collect_batch(first: Signal, receiver: &Receiver<Signal>) -> Vec<Signal> {
    let stop = matches!(first, Signal::Stop);
    let mut batch = vec![first];
    if stop {
        return batch;
    }
    let deadline = Instant::now() + POLL;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return batch;
        }
        match receiver.recv_timeout(left) {
            Ok(signal) => {
                let stop = matches!(signal, Signal::Stop);
                batch.push(signal);
                if stop {
                    return batch;
                }
            }
            Err(RecvTimeoutError::Timeout) => return batch,
            Err(RecvTimeoutError::Disconnected) => {
                batch.push(Signal::Stop);
                return batch;
            }
        }
    }
}

/// 一批读数要做的事：会话切换（最后一次的快照）之后，再按 属性 → 播放 → 时间轴 应用切换之后各类的最后一条。
#[derive(Debug, Default, PartialEq)]
struct BatchPlan {
    session: Option<Option<MediaSnapshot>>,
    properties: Option<Option<MediaProperties>>,
    playback: Option<PlaybackStatus>,
    timeline: Option<Option<Timeline>>,
}

/// 照 winrtutil：一批里有停止就停（返回 `None`）；有会话切换就丢掉切换之前的读数；同类只认最后一条。
fn plan_batch(batch: Vec<Signal>) -> Option<BatchPlan> {
    let mut plan = BatchPlan::default();
    for signal in batch {
        match signal {
            Signal::Stop => return None,
            Signal::Event(MediaEvent::Session(snapshot)) => {
                plan = BatchPlan {
                    session: Some(snapshot),
                    ..BatchPlan::default()
                };
            }
            Signal::Event(MediaEvent::Properties(properties)) => plan.properties = Some(properties),
            Signal::Event(MediaEvent::Playback(status)) => plan.playback = Some(status),
            Signal::Event(MediaEvent::Timeline(timeline)) => plan.timeline = Some(timeline),
        }
    }
    Some(plan)
}

/// 同 `media.rs` 的挂接与三类刷新：换会话先丢网页投影的时间轴基准，没有会话时两个投影复位。
fn apply(projections: &mut Projections, plan: BatchPlan, emit: &dyn Fn(Output)) {
    let now = now_filetime();
    if let Some(session) = plan.session {
        projections.detach();
        match session {
            None => send_all(emit, projections.no_session(now)),
            Some(snapshot) => {
                let properties = snapshot.properties.map(raw_properties);
                send_all(emit, projections.properties(properties.as_ref()));
                send_all(
                    emit,
                    projections.playback(playback_state(snapshot.playback), now),
                );
                send_all(
                    emit,
                    projections.timeline(snapshot.timeline.map(raw_timeline), now),
                );
            }
        }
    }
    if let Some(properties) = plan.properties {
        let properties = properties.map(raw_properties);
        send_all(emit, projections.properties(properties.as_ref()));
    }
    if let Some(status) = plan.playback {
        send_all(emit, projections.playback(playback_state(status), now));
    }
    if let Some(timeline) = plan.timeline {
        send_all(emit, projections.timeline(timeline.map(raw_timeline), now));
    }
}

fn raw_properties(properties: MediaProperties) -> RawProperties {
    RawProperties {
        app_id: properties.app_id,
        title: properties.title,
        artist: properties.artist,
        sub_title: properties.sub_title,
        album_title: properties.album_title,
        album_artist: properties.album_artist,
        genres: properties.genres,
        // `MediaPlaybackType` 原值：1 音乐、2 视频、3 图片，其余 0
        playback_type: match properties.kind {
            MediaKind::Music => 1,
            MediaKind::Video => 2,
            MediaKind::Image => 3,
            MediaKind::Unknown => 0,
        },
        thumbnail: properties.thumbnail,
    }
}

/// 投影的播放状态：Playing 1、Paused 2，其余 0。
fn playback_state(status: PlaybackStatus) -> u8 {
    match status {
        PlaybackStatus::Playing => 1,
        PlaybackStatus::Paused => 2,
        PlaybackStatus::Other => 0,
    }
}

/// 微秒 → 100 ns；读数时刻从 Unix 纪元换到 1601 起，0（播放器没给）保持 0。
fn raw_timeline(timeline: Timeline) -> RawTimeline {
    RawTimeline {
        position: timeline.position_micros * 10,
        start: timeline.start_micros * 10,
        end: timeline.end_micros * 10,
        updated: if timeline.updated_unix_micros == 0 {
            0
        } else {
            timeline.updated_unix_micros * 10 + FILETIME_UNIX_OFFSET
        },
    }
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
    use super::*;

    fn props(title: &str) -> MediaProperties {
        MediaProperties {
            app_id: "com.pake.a540759".to_string(),
            title: title.to_string(),
            ..MediaProperties::default()
        }
    }

    fn event(event: MediaEvent) -> Signal {
        Signal::Event(event)
    }

    #[test]
    fn a_session_switch_drops_the_readings_before_it() {
        // 会话退出时先报一次播放状态、随后才切会话：那条状态不发（P11c 实测）
        let plan = plan_batch(vec![
            event(MediaEvent::Playback(PlaybackStatus::Paused)),
            event(MediaEvent::Session(None)),
        ])
        .unwrap();
        assert_eq!(
            plan,
            BatchPlan {
                session: Some(None),
                ..BatchPlan::default()
            }
        );
    }

    #[test]
    fn readings_after_the_switch_and_the_last_of_each_kind_are_kept() {
        let snapshot = MediaSnapshot {
            properties: Some(props("A")),
            ..MediaSnapshot::default()
        };
        let plan = plan_batch(vec![
            event(MediaEvent::Session(Some(snapshot.clone()))),
            event(MediaEvent::Playback(PlaybackStatus::Playing)),
            event(MediaEvent::Properties(Some(props("B")))),
            event(MediaEvent::Properties(Some(props("C")))),
        ])
        .unwrap();
        assert_eq!(plan.session, Some(Some(snapshot)));
        assert_eq!(plan.properties, Some(Some(props("C"))));
        assert_eq!(plan.playback, Some(PlaybackStatus::Playing));
        assert_eq!(plan.timeline, None);
    }

    #[test]
    fn a_stop_in_the_batch_stops() {
        assert_eq!(
            plan_batch(vec![event(MediaEvent::Session(None)), Signal::Stop]),
            None
        );
    }

    #[test]
    fn timelines_convert_to_filetime() {
        let raw = raw_timeline(Timeline {
            start_micros: 0,
            end_micros: 227_046_000,
            position_micros: 17_700_088,
            updated_unix_micros: 1_795_271_690_788_919,
        });
        assert_eq!(raw.end, 2_270_460_000);
        assert_eq!(raw.position, 177_000_880);
        assert_eq!(raw.updated, 17_952_716_907_889_190 + FILETIME_UNIX_OFFSET);
        assert_eq!(raw_timeline(Timeline::default()).updated, 0);
    }

    #[test]
    fn a_snapshot_reaches_both_projections() {
        let outputs = std::sync::Mutex::new(Vec::new());
        let mut projections = Projections::default();
        apply(
            &mut projections,
            BatchPlan {
                session: Some(Some(MediaSnapshot {
                    properties: Some(MediaProperties {
                        artist: "放課後ティータイム".to_string(),
                        ..props("Listen!!")
                    }),
                    playback: PlaybackStatus::Playing,
                    timeline: Some(Timeline {
                        start_micros: 0,
                        end_micros: 227_046_000,
                        position_micros: 17_700_088,
                        updated_unix_micros: 0,
                    }),
                })),
                ..BatchPlan::default()
            },
            &|output| outputs.lock().unwrap().push(output),
        );
        let outputs = outputs.into_inner().unwrap();
        for flavor in [
            super::super::WpeMediaFlavor::Web,
            super::super::WpeMediaFlavor::Scene,
        ] {
            assert!(
                outputs.iter().any(|o| o.flavor == flavor
                    && matches!(&o.message, super::super::WpeMediaMessage::Properties { title, .. } if title == "Listen!!")),
                "{flavor:?}: {outputs:?}"
            );
            assert!(
                outputs.iter().any(|o| o.flavor == flavor
                    && o.message == super::super::WpeMediaMessage::Playback { state: 1 }),
                "{flavor:?}: {outputs:?}"
            );
        }
    }
}
