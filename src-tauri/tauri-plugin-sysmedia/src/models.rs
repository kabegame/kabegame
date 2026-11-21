//! 平台无关的读数：插件只报「系统当前的媒体会话是什么样」，不做任何为某个消费方的换算。
//!
//! 一个会话就是系统认为「正在播放」的那个来源（Windows 的 SMTC 当前会话、macOS 的 Now Playing 应用）。
//! 读数按会话的三类数据分开推，换会话时推一份完整快照；同一会话里旧数据迟到的事件由插件丢掉，消费方按顺序应用即可。

use serde::{Deserialize, Serialize};

/// 媒体类型（Windows `MediaPlaybackType`、macOS `mediaType`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    #[default]
    Unknown,
    Music,
    Video,
    Image,
}

/// 一次属性读取。拿不到的字段是空串。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProperties {
    /// 来源应用：Windows 是 `SourceAppUserModelId`；macOS 是 bundle id，经共享进程播放（网页播放器走 WebKit 的
    /// GPU 进程）时取宿主应用的
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub sub_title: String,
    pub album_title: String,
    pub album_artist: String,
    pub genres: Vec<String>,
    pub kind: MediaKind,
    /// 封面原始字节，格式不定（macOS 实测是 TIFF，而播放器声明的 mime 并不可靠），按文件头识别；没有封面为 `None`
    pub thumbnail: Option<Vec<u8>>,
}

/// 播放状态。只区分消费方关心的两种，其余（停止、打开中、切换中等）都是 `Other`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    #[default]
    Other,
    Playing,
    Paused,
}

/// 时间轴，单位微秒。`position_micros` 是 `updated_unix_micros` 那一刻的位置（播放中的位置要按速率外推）；
/// 播放器不给时间轴时 `end_micros` 为 0，不给读数时刻时 `updated_unix_micros` 为 0。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub start_micros: i64,
    pub end_micros: i64,
    pub position_micros: i64,
    /// Unix 纪元起的微秒
    pub updated_unix_micros: i64,
}

/// 换到一个会话时它的完整状态。属性 / 时间轴为 `None` 表示这次读取失败（不是「没有」）。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    pub properties: Option<MediaProperties>,
    pub playback: PlaybackStatus,
    pub timeline: Option<Timeline>,
}

/// 一条读数。`watch` 开始时先推一次 [`MediaEvent::Session`]（当前没有会话就是 `None`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum MediaEvent {
    /// 当前会话换了（含从无到有、从有到无），带新会话的完整快照
    Session(Option<MediaSnapshot>),
    /// 当前会话的属性或封面变了；`None` 是读取失败
    Properties(Option<MediaProperties>),
    Playback(PlaybackStatus),
    /// 当前会话的时间轴变了；`None` 是读取失败
    Timeline(Option<Timeline>),
}
