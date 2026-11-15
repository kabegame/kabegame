//! 系统媒体会话（SMTC，`GlobalSystemMediaTransportControlsSessionManager`）监视：只负责读系统数据，
//! 翻译成网页 / 场景两个投影（`projection.rs`，纯逻辑）并按 flavor 推出，变化时才推。
//!
//! 一个专用线程（COM MTA）持有管理器与当前会话：WinRT 事件只往通道里发一个信号，读取、解码都在这个线程里做；
//! 每秒醒一次给网页投影的播放中时间轴按 `LastUpdatedTime` 外推（场景投影不外推）。
//! 当前会话的来源是 `CurrentSessionChanged` 与 `SessionsChanged`（WPE 里两个事件都只是重取当前会话）。
//! 播放器不提供时间轴（`EndTime` 为 0）网页投影就不推，页面要能接受永不回调（官方文档）。
//!
//! 信号照 `winrtutil64.exe` 的主循环处理（rea-p11-media 1.2–1.4）：它每 100 ms 取一次自己的队列，丢掉不是当前会话发来的事件。
//! 这里收到第一个信号后把之后 100 ms 内到的攒成一批（[`collect_batch`]），会话上的三个事件带着挂接时的代数，
//! 批里有会话切换就只重新挂接（挂接会全部重读），旧代数的信号丢掉（[`plan_batch`]）。
//! 实测（P11c 走查）：会话退出时它先报一次播放状态，约 17 ms 后系统才切到别的会话，WPE 不发那条状态，不攒批就会多发一条。

use super::projection::{Output, Projections, RawProperties, RawTimeline};
use super::ComGuard;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::Foundation::{EventRegistrationToken, TypedEventHandler};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

const TICK: Duration = Duration::from_secs(1);
/// 攒批的时长：winrtutil 主循环取队列的间隔（`Sleep(100)`，rea-p11-media 1.4）。
const POLL: Duration = Duration::from_millis(100);
/// 读封面流的上限，防止异常大的流。
const THUMBNAIL_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// `DateTime.UniversalTime`（1601 起的 100ns）与 Unix 纪元之差。
const FILETIME_UNIX_OFFSET: i64 = 116_444_736_000_000_000;

/// 监视线程的信号。会话上的三个事件带着挂接时的代数（[`Watcher::generation`]），换会话之后旧会话迟到的信号据此丢掉。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    Session,
    Properties(u64),
    Playback(u64),
    Timeline(u64),
    Stop,
}

/// 一批信号要做的事。
#[derive(Debug, Default, PartialEq, Eq)]
struct BatchPlan {
    stop: bool,
    /// 重取当前会话并重新挂接（挂接会重读三类，本批别的读取不再单做）
    reattach: bool,
    properties: bool,
    playback: bool,
    timeline: bool,
}

/// 照 winrtutil：一批里有停止就停；有会话切换就只重新挂接；否则只认当前代数（当前会话）发来的信号，同类只读一次。
fn plan_batch(batch: &[Signal], generation: u64) -> BatchPlan {
    let mut plan = BatchPlan::default();
    for signal in batch {
        match *signal {
            Signal::Stop => plan.stop = true,
            Signal::Session => plan.reattach = true,
            Signal::Properties(g) if g == generation => plan.properties = true,
            Signal::Playback(g) if g == generation => plan.playback = true,
            Signal::Timeline(g) if g == generation => plan.timeline = true,
            // 不是当前会话发来的（旧代数）：丢掉
            _ => {}
        }
    }
    if plan.stop || plan.reattach {
        plan.properties = false;
        plan.playback = false;
        plan.timeline = false;
    }
    plan
}

/// 以 `first` 开头，把之后 [`POLL`] 内到的信号攒成一批；收到停止或通道断开立即返回（停止不等）。
fn collect_batch(first: Signal, receiver: &Receiver<Signal>) -> Vec<Signal> {
    let mut batch = vec![first];
    if first == Signal::Stop {
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
                batch.push(signal);
                if signal == Signal::Stop {
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

/// 运行中的媒体会话监视；丢弃即停止。
pub struct MediaWatcher {
    signals: Sender<Signal>,
    thread: Option<JoinHandle<()>>,
}

impl MediaWatcher {
    pub fn start(emit: impl Fn(Output) + Send + 'static) -> Self {
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

fn run(signals: Sender<Signal>, receiver: Receiver<Signal>, emit: &dyn Fn(Output)) {
    let _com = ComGuard::init();
    let manager = match SessionManager::RequestAsync().and_then(|op| op.get()) {
        Ok(manager) => manager,
        Err(error) => {
            tracing::warn!("获取系统媒体会话失败，网页壁纸媒体集成不可用: {error}");
            for output in Projections::default().playback(0, now_filetime()) {
                emit(output);
            }
            // 等停止信号，不再做任何事
            while !matches!(receiver.recv(), Ok(Signal::Stop) | Err(_)) {}
            return;
        }
    };
    let current_token = manager
        .CurrentSessionChanged(&TypedEventHandler::new({
            let signals = signals.clone();
            move |_, _| {
                let _ = signals.send(Signal::Session);
                Ok(())
            }
        }))
        .ok();
    let sessions_token = manager
        .SessionsChanged(&TypedEventHandler::new({
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
        let first = match receiver.recv_timeout(TICK) {
            Ok(signal) => signal,
            Err(RecvTimeoutError::Timeout) => {
                watcher.tick();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let plan = plan_batch(&collect_batch(first, &receiver), watcher.generation);
        if plan.stop {
            break;
        }
        if plan.reattach {
            watcher.attach(manager.GetCurrentSession().ok());
            continue;
        }
        if plan.properties {
            watcher.refresh_properties();
        }
        if plan.playback {
            watcher.refresh_playback();
        }
        if plan.timeline {
            watcher.refresh_timeline();
        }
    }
    watcher.detach();
    if let Some(token) = current_token {
        let _ = manager.RemoveCurrentSessionChanged(token);
    }
    if let Some(token) = sessions_token {
        let _ = manager.RemoveSessionsChanged(token);
    }
}

struct Watcher<'a> {
    emit: &'a dyn Fn(Output),
    signals: Sender<Signal>,
    session: Option<Session>,
    tokens: Vec<(EventKind, EventRegistrationToken)>,
    projections: Projections,
    /// 挂接代数：每次挂接加一，挂在会话上的事件发的信号带着它（[`plan_batch`] 只认当前代数）
    generation: u64,
}

#[derive(Clone, Copy)]
enum EventKind {
    Properties,
    Playback,
    Timeline,
}

impl<'a> Watcher<'a> {
    fn new(emit: &'a dyn Fn(Output), signals: Sender<Signal>) -> Self {
        Self {
            emit,
            signals,
            session: None,
            tokens: Vec::new(),
            projections: Projections::default(),
            generation: 0,
        }
    }

    /// 换到新的当前会话（可能为空）并全量刷新。代数加一：旧会话上已发出、还没处理的信号从此作废。
    fn attach(&mut self, session: Option<Session>) {
        self.detach();
        self.generation += 1;
        let generation = self.generation;
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
                            let _ = signals.send(Signal::Properties(generation));
                            Ok(())
                        }))
                    }
                    EventKind::Playback => {
                        session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                            let _ = signals.send(Signal::Playback(generation));
                            Ok(())
                        }))
                    }
                    EventKind::Timeline => {
                        session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                            let _ = signals.send(Signal::Timeline(generation));
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
        if self.session.is_none() {
            // 没有会话：网页投影推空属性 / 状态 0，场景投影各类回到缺省值
            let outputs = self.projections.no_session(now_filetime());
            self.send_all(outputs);
            return;
        }
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
        self.projections.detach();
    }

    fn send_all(&self, outputs: Vec<Output>) {
        for output in outputs {
            (self.emit)(output);
        }
    }

    /// 属性与封面（一次读取，交给两个投影）。
    fn refresh_properties(&mut self) {
        let Some(session) = &self.session else {
            return;
        };
        let raw = read_properties(session);
        let outputs = self.projections.properties(raw.as_ref());
        self.send_all(outputs);
    }

    /// 播放状态：Playing → 1、Paused → 2，其余 → 0。
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
        let outputs = self.projections.playback(state, now_filetime());
        self.send_all(outputs);
    }

    /// 重新读时间轴。
    fn refresh_timeline(&mut self) {
        let read = self
            .session
            .as_ref()
            .and_then(|session| session.GetTimelineProperties().ok())
            .and_then(|props| {
                Some(RawTimeline {
                    start: props.StartTime().ok()?.Duration,
                    end: props.EndTime().ok()?.Duration,
                    position: props.Position().ok()?.Duration,
                    updated: props
                        .LastUpdatedTime()
                        .map(|t| t.UniversalTime)
                        .unwrap_or(0),
                })
            });
        let outputs = self.projections.timeline(read, now_filetime());
        self.send_all(outputs);
    }

    /// 每秒：网页投影按读数时间外推播放中的位置。
    fn tick(&mut self) {
        let outputs = self.projections.tick(now_filetime());
        self.send_all(outputs);
    }
}

/// 读一次属性与封面原始字节；读取失败返回 `None`。
fn read_properties(session: &Session) -> Option<RawProperties> {
    let props = session
        .TryGetMediaPropertiesAsync()
        .and_then(|op| op.get())
        .ok()?;
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
        })
        .unwrap_or_default();
    // 空引用 / 读不出都按 0（未知）
    let playback_type = props
        .PlaybackType()
        .and_then(|t| t.Value())
        .map(|t| t.0)
        .unwrap_or(0);
    let thumbnail = props
        .Thumbnail()
        .ok()
        .and_then(|reference| read_stream(&reference).ok())
        .filter(|bytes| !bytes.is_empty());
    Some(RawProperties {
        app_id: text(session.SourceAppUserModelId()),
        title: text(props.Title()),
        artist: text(props.Artist()),
        sub_title: text(props.Subtitle()),
        album_title: text(props.AlbumTitle()),
        album_artist: text(props.AlbumArtist()),
        genres,
        playback_type,
        thumbnail,
    })
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
    use super::*;

    #[test]
    fn session_switch_in_the_batch_drops_the_old_session_signals() {
        // P11c 走查：夹具退出时它先报播放状态，约 17 ms 后才切会话；同一批里只重新挂接，旧会话那条状态不读
        let plan = plan_batch(&[Signal::Playback(3), Signal::Session], 3);
        assert_eq!(
            plan,
            BatchPlan {
                reattach: true,
                ..BatchPlan::default()
            }
        );
    }

    #[test]
    fn signals_from_an_old_generation_are_dropped() {
        // 挂接之后旧会话迟到的信号（WPE 丢掉不是当前会话发来的事件）
        let plan = plan_batch(
            &[
                Signal::Properties(1),
                Signal::Playback(1),
                Signal::Timeline(1),
            ],
            2,
        );
        assert_eq!(plan, BatchPlan::default());
    }

    #[test]
    fn current_signals_are_read_once_per_kind() {
        let plan = plan_batch(
            &[
                Signal::Properties(2),
                Signal::Playback(2),
                Signal::Properties(2),
                Signal::Timeline(1),
            ],
            2,
        );
        assert_eq!(
            plan,
            BatchPlan {
                properties: true,
                playback: true,
                ..BatchPlan::default()
            }
        );
    }

    #[test]
    fn stop_wins_over_everything() {
        let plan = plan_batch(&[Signal::Playback(2), Signal::Session, Signal::Stop], 2);
        assert_eq!(
            plan,
            BatchPlan {
                stop: true,
                reattach: true,
                ..BatchPlan::default()
            }
        );
    }

    #[test]
    fn batch_collects_what_arrives_within_the_poll_window() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Signal::Session).unwrap();
        let late = std::thread::spawn(move || {
            std::thread::sleep(POLL * 3);
            let _ = sender.send(Signal::Timeline(1));
        });
        let start = Instant::now();
        let batch = collect_batch(Signal::Playback(1), &receiver);
        assert_eq!(batch, vec![Signal::Playback(1), Signal::Session]);
        assert!(start.elapsed() >= POLL);
        late.join().unwrap();
        // 窗口之后到的留给下一批
        assert_eq!(receiver.recv().unwrap(), Signal::Timeline(1));
    }

    #[test]
    fn stop_returns_without_waiting() {
        let (sender, receiver) = mpsc::channel::<Signal>();
        let start = Instant::now();
        assert_eq!(collect_batch(Signal::Stop, &receiver), vec![Signal::Stop]);
        assert!(start.elapsed() < POLL);
        sender.send(Signal::Stop).unwrap();
        let start = Instant::now();
        assert_eq!(
            collect_batch(Signal::Session, &receiver),
            vec![Signal::Session, Signal::Stop]
        );
        assert!(start.elapsed() < POLL);
        drop(sender);
        assert_eq!(
            collect_batch(Signal::Session, &receiver),
            vec![Signal::Session, Signal::Stop]
        );
    }
}
