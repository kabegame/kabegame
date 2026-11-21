//! Linux 的数据源：MPRIS（会话总线上的 `org.mpris.MediaPlayer2.*`）。
//!
//! 一条线程用 `zbus::block_on` 跑一个异步循环：先登记三条匹配规则（`NameOwnerChanged` 限 `org.mpris.MediaPlayer2`
//! 命名空间、Player 接口的 `PropertiesChanged`、`Seeked`），再列举已有的播放器，之后把总线消息、封面取回结果合成一个流
//! 逐条处理，每条处理完按 [`mpris::Players::current`] 选当前会话、和上次推出的比较（[`mpris::Reporter`]，会话身份是进程）。
//! 丢弃 [`LinuxWatch`] 发停止信号、等线程退出。会话总线连不上或断开时推「没有会话」，按 macOS 的退避重连。
//!
//! 位置（`Position`）没有变化信号，只在换会话、播放状态变、换曲目、速率变时重读，收到 `Seeked` 时直接用信号里的位置；
//! 读不到给 0、读数时刻 0。播放中的外推是消费方的事。
//!
//! 封面（`mpris:artUrl`）：`file://` 当场读、`data:` 当场解、`http(s)://` 另起短线程用 reqwest 取（总超时 2 s），
//! 上限 16 MB，只给当前会话取、按地址留一份。当前会话的封面在取时，读数整体延后到取回（或失败）再推，让标题和封面一起到。

mod mpris;

#[cfg(any(test, feature = "mpris-fixture"))]
pub mod fixture;

use crate::OnEvent;
use futures_channel::{mpsc, oneshot};
use futures_util::future::{self, Either};
use futures_util::stream::{self, StreamExt};
use mpris::{ArtSource, Metadata, Player, Players, Position, Reporter};
use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zbus::zvariant::OwnedValue;
use zbus::{Connection, MatchRule, Message, MessageStream};

const PLAYER_PATH: &str = "/org/mpris/MediaPlayer2";
const ROOT_IFACE: &str = "org.mpris.MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPERTIES_IFACE: &str = "org.freedesktop.DBus.Properties";
const DBUS_NAME: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
/// 播放器卡住不回时，一次调用最多等这么久（处理期间不读别的消息）
const METHOD_TIMEOUT: Duration = Duration::from_secs(2);
/// 每条匹配规则最多排队的消息数
const QUEUE: usize = 256;
const ART_TIMEOUT: Duration = Duration::from_secs(2);
const ART_MAX_BYTES: u64 = 16 << 20;
/// 重连退避：同 macOS，从 1 s 起翻倍、封顶 30 s；连续跑满一分钟后回到 1 s。
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const HEALTHY_RUN: Duration = Duration::from_secs(60);

pub struct LinuxWatch {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl LinuxWatch {
    pub fn start(emit: OnEvent) -> Self {
        Self::start_with(emit, Some(std::process::id()))
    }

    /// `own_pid` 的播放器不算会话；真总线测试里假播放器与测试同进程，传 `None`。
    fn start_with(emit: OnEvent, own_pid: Option<u32>) -> Self {
        let (stop, stop_rx) = oneshot::channel();
        let thread = std::thread::Builder::new()
            .name("kabegame-sysmedia".to_string())
            .spawn(move || run(stop_rx, &emit, own_pid))
            .map_err(|error| tracing::warn!("启动系统媒体会话线程失败: {error}"))
            .ok();
        Self {
            stop: Some(stop),
            thread,
        }
    }
}

impl Drop for LinuxWatch {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

enum Outcome {
    Stopped,
    Disconnected,
}

fn run(mut stop: oneshot::Receiver<()>, emit: &OnEvent, own_pid: Option<u32>) {
    let mut reporter = Reporter::default();
    let mut backoff = BACKOFF_MIN;
    loop {
        let started = Instant::now();
        match zbus::block_on(serve(&mut stop, &mut reporter, emit, own_pid)) {
            Ok(Outcome::Stopped) => return,
            Ok(Outcome::Disconnected) => {
                tracing::warn!("会话总线连接断开，{backoff:?} 后重连（MPRIS）")
            }
            Err(error) => tracing::warn!("读 MPRIS 失败（{backoff:?} 后重试）: {error}"),
        }
        // 连不上或断开：照约定报「没有会话」（第一次连不上也报一次）
        for event in reporter.report(None) {
            emit(event);
        }
        if started.elapsed() >= HEALTHY_RUN {
            backoff = BACKOFF_MIN;
        }
        if wait_or_stop(&mut stop, backoff) {
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// 等 `total`，期间收到停止返回真。
fn wait_or_stop(stop: &mut oneshot::Receiver<()>, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    loop {
        // 发了停止或句柄已丢（发送端没了）都算停止
        if !matches!(stop.try_recv(), Ok(None)) {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        std::thread::sleep(left.min(Duration::from_millis(100)));
    }
}

enum Input {
    Bus(zbus::Result<Message>),
    BusClosed,
    Art(String, Option<Vec<u8>>),
}

async fn serve(
    stop: &mut oneshot::Receiver<()>,
    reporter: &mut Reporter,
    emit: &OnEvent,
    own_pid: Option<u32>,
) -> zbus::Result<Outcome> {
    let conn = zbus::connection::Builder::session()?
        .method_timeout(METHOD_TIMEOUT)
        .build()
        .await?;
    // 先登记再列举：列举期间的变化不会漏（处理顺序见 `State::on_message`）
    let signal = zbus::message::Type::Signal;
    let rules = [
        MatchRule::builder()
            .msg_type(signal)
            .sender(DBUS_NAME)?
            .interface(DBUS_NAME)?
            .member("NameOwnerChanged")?
            .arg0ns("org.mpris.MediaPlayer2")?
            .build(),
        MatchRule::builder()
            .msg_type(signal)
            .interface(PROPERTIES_IFACE)?
            .member("PropertiesChanged")?
            .path(PLAYER_PATH)?
            .arg(0, PLAYER_IFACE)?
            .build(),
        MatchRule::builder()
            .msg_type(signal)
            .interface(PLAYER_IFACE)?
            .member("Seeked")?
            .path(PLAYER_PATH)?
            .build(),
    ];
    let mut streams = Vec::with_capacity(rules.len());
    for rule in rules {
        streams.push(MessageStream::for_match_rule(rule, &conn, Some(QUEUE)).await?);
    }
    let bus = stream::select_all(streams)
        .map(Input::Bus)
        .chain(stream::once(future::ready(Input::BusClosed)));
    let (art_tx, art_rx) = mpsc::unbounded();
    let art = art_rx.map(|(url, bytes)| Input::Art(url, bytes));
    let mut inputs = stream::select(bus, art);

    let mut state = State::new(conn, own_pid, art_tx);
    state.enumerate().await?;
    state.publish(reporter, emit).await;
    loop {
        let input = match future::select(inputs.next(), &mut *stop).await {
            Either::Right(_) => return Ok(Outcome::Stopped),
            Either::Left((input, _)) => input,
        };
        match input {
            None | Some(Input::BusClosed) => return Ok(Outcome::Disconnected),
            Some(Input::Bus(Ok(message))) => state.on_message(&message).await,
            Some(Input::Bus(Err(error))) => tracing::debug!("MPRIS 消息读取出错: {error}"),
            Some(Input::Art(url, bytes)) => state.on_art(&url, bytes),
        }
        state.publish(reporter, emit).await;
    }
}

enum ArtState {
    Ready(Option<Vec<u8>>),
    Pending,
}

struct State {
    conn: Connection,
    players: Players,
    /// 当前会话的位置读数（会话身份 + 读数）；`None` 或不是当前会话的时下次推之前重读。按会话身份（进程）记，
    /// 当前会话换到同一进程的另一个镜像时不重读
    position: Option<(String, Position)>,
    art_url: String,
    art: ArtState,
    art_tx: mpsc::UnboundedSender<(String, Option<Vec<u8>>)>,
}

impl State {
    fn new(
        conn: Connection,
        own_pid: Option<u32>,
        art_tx: mpsc::UnboundedSender<(String, Option<Vec<u8>>)>,
    ) -> Self {
        Self {
            conn,
            players: Players::new(own_pid),
            position: None,
            art_url: String::new(),
            art: ArtState::Ready(None),
            art_tx,
        }
    }

    async fn enumerate(&mut self) -> zbus::Result<()> {
        let names: Vec<String> = self.dbus("ListNames", &()).await?;
        for name in names
            .into_iter()
            .filter(|n| n.starts_with(mpris::BUS_PREFIX))
        {
            match self
                .dbus::<_, String>("GetNameOwner", &(name.as_str(),))
                .await
            {
                Ok(unique) => self.add_player(unique, name).await,
                // 列举之后、取主之前退出了：随后的 NameOwnerChanged 会说明
                Err(error) => tracing::debug!("取 {name} 的唯一名失败: {error}"),
            }
        }
        Ok(())
    }

    async fn add_player(&mut self, unique: String, name: String) {
        let props = match self.get_all(&unique, PLAYER_IFACE).await {
            Ok(props) => props,
            Err(error) => {
                tracing::debug!("读 {name} 的 Player 属性失败，不当作播放器: {error}");
                return;
            }
        };
        let pid = self
            .dbus::<_, u32>("GetConnectionUnixProcessID", &(unique.as_str(),))
            .await
            .ok();
        let desktop_entry = self
            .get(&unique, ROOT_IFACE, "DesktopEntry")
            .await
            .ok()
            .and_then(|value| mpris::as_text(&value))
            .unwrap_or_default();
        let mut player = Player::new(
            unique,
            name.clone(),
            mpris::app_id(&desktop_entry, &name),
            pid,
        );
        if let Some(status) = props.get("PlaybackStatus").and_then(|v| mpris::as_text(v)) {
            player.status = mpris::playback_status(&status);
        }
        if let Some(metadata) = props.get("Metadata") {
            player.metadata = Metadata::parse_value(metadata);
        }
        if let Some(rate) = props.get("Rate").and_then(|v| mpris::as_float(v)) {
            player.rate = rate;
        }
        tracing::debug!(
            name = %player.name,
            unique = %player.unique,
            app_id = %player.app_id,
            pid = ?player.pid,
            "MPRIS 播放器加入"
        );
        // 同一唯一名重复加入（列举与 NameOwnerChanged 撞上）：替换，位置作废
        let unique = player.unique.clone();
        self.players.insert(player);
        self.forget_position_of(&unique);
    }

    /// 这个播放器所在会话的位置读数作废（下次推之前重读）。
    fn forget_position_of(&mut self, unique: &str) {
        let Some(key) = self.players.get(unique).map(Player::session_key) else {
            return;
        };
        if self
            .position
            .as_ref()
            .is_some_and(|(owner, _)| *owner == key)
        {
            self.position = None;
        }
    }

    async fn on_message(&mut self, message: &Message) {
        let header = message.header();
        let member = header.member().map(|m| m.as_str().to_string());
        let sender = header.sender().map(|s| s.as_str().to_string());
        let body = message.body();
        match member.as_deref() {
            Some("NameOwnerChanged") => {
                let Ok((name, old, new)) = body.deserialize::<(String, String, String)>() else {
                    return;
                };
                if !name.starts_with(mpris::BUS_PREFIX) {
                    return;
                }
                if !old.is_empty() && self.players.get(&old).is_some_and(|p| p.name == name) {
                    tracing::debug!(name = %name, unique = %old, "MPRIS 播放器离开");
                    self.forget_position_of(&old);
                    self.players.remove(&old);
                }
                if !new.is_empty() {
                    self.add_player(new, name).await;
                }
            }
            Some("PropertiesChanged") => {
                let Some(sender) = sender.filter(|s| self.players.contains(s)) else {
                    return;
                };
                let Ok((interface, mut changed, invalidated)) =
                    body.deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                else {
                    return;
                };
                if interface != PLAYER_IFACE {
                    return;
                }
                // 只说「变了」不给值的：自己读
                for key in ["PlaybackStatus", "Metadata", "Rate"] {
                    if invalidated.iter().any(|k| k == key) && !changed.contains_key(key) {
                        if let Ok(value) = self.get(&sender, PLAYER_IFACE, key).await {
                            changed.insert(key.to_string(), value);
                        }
                    }
                }
                let mut reread = false;
                if let Some(status) = changed
                    .get("PlaybackStatus")
                    .and_then(|v| mpris::as_text(v))
                {
                    reread |= self
                        .players
                        .set_status(&sender, mpris::playback_status(&status));
                }
                if let Some(metadata) = changed.get("Metadata") {
                    reread |= self
                        .players
                        .set_metadata(&sender, Metadata::parse_value(metadata));
                }
                if let Some(rate) = changed.get("Rate").and_then(|v| mpris::as_float(v)) {
                    reread |= self.players.set_rate(&sender, rate);
                }
                if reread {
                    self.forget_position_of(&sender);
                }
            }
            Some("Seeked") => {
                let Some(key) = sender
                    .and_then(|sender| self.players.get(&sender))
                    .map(Player::session_key)
                else {
                    return;
                };
                let Ok((micros,)) = body.deserialize::<(i64,)>() else {
                    return;
                };
                if self
                    .position
                    .as_ref()
                    .is_some_and(|(owner, _)| *owner == key)
                {
                    self.position = Some((
                        key,
                        Position {
                            micros: micros.max(0),
                            at_unix_micros: now_unix_micros(),
                        },
                    ));
                }
            }
            _ => {}
        }
    }

    fn on_art(&mut self, url: &str, bytes: Option<Vec<u8>>) {
        if self.art_url == url && matches!(self.art, ArtState::Pending) {
            if bytes.is_none() {
                tracing::debug!("取 MPRIS 封面失败，按无封面处理: {url}");
            }
            self.art = ArtState::Ready(bytes);
        }
    }

    /// 当前会话的封面换了地址就重新取；http 另起线程，取回前是 `Pending`。
    fn ensure_art(&mut self, url: &str) {
        if self.art_url == url {
            return;
        }
        self.art_url = url.to_string();
        self.art = match mpris::classify_art(url) {
            ArtSource::None => ArtState::Ready(None),
            ArtSource::File(path) => ArtState::Ready(
                std::fs::File::open(&path)
                    .map_err(|error| {
                        tracing::debug!("读 MPRIS 封面 {} 失败: {error}", path.display())
                    })
                    .ok()
                    .and_then(read_capped),
            ),
            ArtSource::Data(bytes) => {
                ArtState::Ready((bytes.len() as u64 <= ART_MAX_BYTES).then_some(bytes))
            }
            ArtSource::Http(url) => {
                fetch_http(url, self.art_tx.clone());
                ArtState::Pending
            }
        };
    }

    /// 选当前会话、补读位置与封面后交给 `reporter`；当前会话的封面还在取时这次不推。
    async fn publish(&mut self, reporter: &mut Reporter, emit: &OnEvent) {
        let current = self
            .players
            .current()
            .map(|p| (p.unique.clone(), p.session_key()));
        let snapshot = match current {
            None => None,
            Some((unique, key)) => {
                if self.position.as_ref().map(|(owner, _)| owner) != Some(&key) {
                    let position = self.read_position(&unique).await;
                    self.position = Some((key.clone(), position));
                }
                // 读位置期间播放器可能退出了：下一条 NameOwnerChanged 会再推
                let Some(player) = self.players.get(&unique) else {
                    return;
                };
                let art_url = player.metadata.art_url.clone();
                self.ensure_art(&art_url);
                let thumbnail = match &self.art {
                    ArtState::Pending => return,
                    ArtState::Ready(bytes) => bytes.clone(),
                };
                let position = self.position.as_ref().map(|(_, p)| *p).unwrap_or_default();
                let player = self.players.get(&unique).expect("刚取到过");
                Some((key, mpris::snapshot(player, position, thumbnail)))
            }
        };
        for event in reporter.report(snapshot) {
            emit(event);
        }
    }

    async fn read_position(&self, unique: &str) -> Position {
        match self.get(unique, PLAYER_IFACE, "Position").await {
            Ok(value) => match mpris::as_int(&value) {
                Some(micros) => Position {
                    micros: micros.max(0),
                    at_unix_micros: now_unix_micros(),
                },
                None => Position::default(),
            },
            Err(error) => {
                tracing::debug!("读 {unique} 的 Position 失败: {error}");
                Position::default()
            }
        }
    }

    async fn dbus<B, R>(&self, method: &str, body: &B) -> zbus::Result<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
    {
        let reply = self
            .conn
            .call_method(Some(DBUS_NAME), DBUS_PATH, Some(DBUS_NAME), method, body)
            .await?;
        reply.body().deserialize()
    }

    async fn get(&self, unique: &str, interface: &str, property: &str) -> zbus::Result<OwnedValue> {
        let reply = self
            .conn
            .call_method(
                Some(unique),
                PLAYER_PATH,
                Some(PROPERTIES_IFACE),
                "Get",
                &(interface, property),
            )
            .await?;
        reply.body().deserialize()
    }

    async fn get_all(
        &self,
        unique: &str,
        interface: &str,
    ) -> zbus::Result<HashMap<String, OwnedValue>> {
        let reply = self
            .conn
            .call_method(
                Some(unique),
                PLAYER_PATH,
                Some(PROPERTIES_IFACE),
                "GetAll",
                &(interface,),
            )
            .await?;
        reply.body().deserialize()
    }
}

fn now_unix_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// 读到上限为止；超过上限或为空当作没有。
fn read_capped(reader: impl Read) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(ART_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (!bytes.is_empty() && bytes.len() as u64 <= ART_MAX_BYTES).then_some(bytes)
}

/// 另起短线程取 http(s) 封面，结果（失败为 `None`）送回循环。reqwest 的阻塞客户端自带运行时，不能在异步上下文里建，
/// 所以在这条普通线程里建、全进程共用一个。
fn fetch_http(url: String, results: mpsc::UnboundedSender<(String, Option<Vec<u8>>)>) {
    let spawned = std::thread::Builder::new()
        .name("kabegame-sysmedia-art".to_string())
        .spawn({
            let url = url.clone();
            let results = results.clone();
            move || {
                let bytes = http_client(is_loopback(&url)).and_then(|client| {
                    client
                        .get(&url)
                        .send()
                        .and_then(|response| response.error_for_status())
                        .map_err(|error| tracing::debug!("取 MPRIS 封面 {url} 失败: {error}"))
                        .ok()
                        .and_then(read_capped)
                });
                let _ = results.unbounded_send((url, bytes));
            }
        });
    if spawned.is_err() {
        let _ = results.unbounded_send((url, None));
    }
}

/// 封面地址是不是本机回环（有的播放器在本机起 http 服务给封面）。
fn is_loopback(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// 两个客户端：一般地址照系统代理（环境变量）走，本机回环直连（应用从桌面启动时不一定有 `NO_PROXY`）。
fn http_client(loopback: bool) -> Option<&'static reqwest::blocking::Client> {
    static PROXIED: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    static DIRECT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    let slot = if loopback { &DIRECT } else { &PROXIED };
    slot.get_or_init(|| {
        let builder = reqwest::blocking::Client::builder().timeout(ART_TIMEOUT);
        let builder = if loopback {
            builder.no_proxy()
        } else {
            builder
        };
        builder
            .build()
            .map_err(|error| tracing::warn!("建 MPRIS 封面的 HTTP 客户端失败: {error}"))
            .ok()
    })
    .as_ref()
}

#[cfg(test)]
mod tests;
