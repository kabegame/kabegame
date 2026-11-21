//! 假的 MPRIS 播放器：真总线单测与 `examples/mpris_fixture.rs` 共用（feature `mpris-fixture`）。
//!
//! 在会话总线上占一个 `org.mpris.MediaPlayer2.<后缀>`，实现根接口与 Player 接口里本插件读的属性；改值时照规范发
//! `PropertiesChanged`（`Position` 不发），`seek` 发 `Seeked`。丢弃即释放名字（总线发 `NameOwnerChanged`）。
//! 方法都是阻塞的（内部 `zbus::block_on`），不能在异步上下文里调。

use std::collections::HashMap;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::{interface, Connection};

const PATH: &str = "/org/mpris/MediaPlayer2";

/// 一首曲目。
#[derive(Debug, Clone, Default)]
pub struct Track {
    pub id: u32,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub length_micros: i64,
    pub art_url: String,
}

impl Track {
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut map = HashMap::new();
        let mut put = |key: &str, value: Value<'_>| {
            if let Ok(value) = OwnedValue::try_from(value) {
                map.insert(key.to_string(), value);
            }
        };
        let track_id = format!("/app/kabegame/fixture/track/{}", self.id);
        if let Ok(path) = ObjectPath::try_from(track_id.as_str()) {
            put("mpris:trackid", Value::ObjectPath(path));
        }
        put("xesam:title", Value::new(self.title.as_str()));
        put("xesam:artist", Value::new(self.artists.clone()));
        put("xesam:album", Value::new(self.album.as_str()));
        put("mpris:length", Value::new(self.length_micros));
        if !self.art_url.is_empty() {
            put("mpris:artUrl", Value::new(self.art_url.as_str()));
        }
        map
    }
}

struct Root {
    identity: String,
    desktop_entry: String,
}

#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {}
    fn quit(&self) {}
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> String {
        self.identity.clone()
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> String {
        self.desktop_entry.clone()
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

struct PlayerIface {
    status: String,
    track: Track,
    position: i64,
    rate: f64,
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl PlayerIface {
    #[zbus(property)]
    fn playback_status(&self) -> String {
        self.status.clone()
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        self.track.metadata()
    }
    /// 规范：`Position` 变了不发 `PropertiesChanged`
    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.position
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        self.rate
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }
    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;
}

/// 一个假播放器；丢弃即退出。
pub struct FakePlayer {
    conn: Connection,
    pub name: String,
}

impl FakePlayer {
    /// 以 `org.mpris.MediaPlayer2.<suffix>` 上线；`status` 是 `Playing` / `Paused` / `Stopped`。
    pub fn start(
        suffix: &str,
        desktop_entry: &str,
        track: Track,
        status: &str,
    ) -> zbus::Result<Self> {
        let name = format!("org.mpris.MediaPlayer2.{suffix}");
        let conn = zbus::block_on(async {
            zbus::connection::Builder::session()?
                .name(name.as_str())?
                .serve_at(
                    PATH,
                    Root {
                        identity: format!("Kabegame fixture {suffix}"),
                        desktop_entry: desktop_entry.to_string(),
                    },
                )?
                .serve_at(
                    PATH,
                    PlayerIface {
                        status: status.to_string(),
                        track,
                        position: 0,
                        rate: 1.0,
                    },
                )?
                .build()
                .await
        })?;
        Ok(Self { conn, name })
    }

    async fn player(&self) -> zbus::Result<InterfaceRef<PlayerIface>> {
        self.conn
            .object_server()
            .interface::<_, PlayerIface>(PATH)
            .await
    }

    pub fn set_status(&self, status: &str) -> zbus::Result<()> {
        zbus::block_on(async {
            let iface = self.player().await?;
            let mut player = iface.get_mut().await;
            player.status = status.to_string();
            player.playback_status_changed(iface.signal_emitter()).await
        })
    }

    /// 换曲目：位置归零，发 `Metadata` 的变化。
    pub fn set_track(&self, track: Track) -> zbus::Result<()> {
        zbus::block_on(async {
            let iface = self.player().await?;
            let mut player = iface.get_mut().await;
            player.track = track;
            player.position = 0;
            player.metadata_changed(iface.signal_emitter()).await
        })
    }

    /// 只改位置（规范不发信号，读的人要自己读）。
    pub fn set_position(&self, micros: i64) -> zbus::Result<()> {
        zbus::block_on(async {
            self.player().await?.get_mut().await.position = micros;
            Ok(())
        })
    }

    /// 跳转：改位置并发 `Seeked`。
    pub fn seek(&self, micros: i64) -> zbus::Result<()> {
        zbus::block_on(async {
            let iface = self.player().await?;
            iface.get_mut().await.position = micros;
            PlayerIface::seeked(iface.signal_emitter(), micros).await
        })
    }

    pub fn set_rate(&self, rate: f64) -> zbus::Result<()> {
        zbus::block_on(async {
            let iface = self.player().await?;
            let mut player = iface.get_mut().await;
            player.rate = rate;
            player.rate_changed(iface.signal_emitter()).await
        })
    }
}
