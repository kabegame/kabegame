//! 把 `project.json` 的**作者默认值**换算成壁纸窗口可用的视频播放属性。
//!
//! WPE 不在磁盘上生成任何壁纸副本：缩放、对齐、翻转、背景色、播放速率、音量与
//! 亮度 / 对比度 / 饱和度 / 色相全部是播放时的逐壁纸属性。Kabegame 同样只播原文件，
//! 由壁纸窗口用 CSS 复现这些属性。
//!
//! 只读 `project.json` 的 `general.properties`，**不读** WPE 的 `config.json` /
//! `wproperties`——用户在 WPE 里改过的值不带入。Kabegame 自己的样式 / 音量 / 倍速
//! 在壁纸窗口前端覆盖（见 `apps/kabegame/src/wallpaper.ts`），后端只给作者值。

use serde::Serialize;
use serde_json::Value;

use super::project::WpeProject;

/// WPE 标准对齐方式（`alignment` 属性）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WpeAlignment {
    Cover,
    Fill,
    Stretch,
    Center,
    Free,
}

impl WpeAlignment {
    pub fn from_value(value: i64) -> Self {
        match value {
            1 => Self::Fill,
            2 => Self::Stretch,
            3 => Self::Center,
            4 => Self::Free,
            _ => Self::Cover,
        }
    }
}

/// `wec_e` 开启时的颜色调整，各分量取值 −1…1（0 为不调整）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeColorAdjust {
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub hue: f32,
}

/// 壁纸窗口复现所需的作者默认值。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeVideoProps {
    pub alignment: WpeAlignment,
    /// `alignmentposition` × 0.01，−1…1；cover / fill 时沿溢出轴的位置。
    pub position: f32,
    /// `alignmentx` × 0.01，−1…1。
    pub offset_x: f32,
    /// `alignmenty` × 0.01，−1…1。
    pub offset_y: f32,
    /// `alignmentz` × 0.01；1 表示原始大小。
    pub zoom: f32,
    pub flip_h: bool,
    /// `schemecolor`（留边 / 背景色）。
    pub background: Option<[u8; 3]>,
    /// `rate / 100`；作者未声明时为 `None`。
    pub rate: Option<f32>,
    /// `volume / 100`；作者未声明时为 `None`。
    pub volume: Option<f32>,
    /// `wec_e` 开启时的颜色调整。
    pub color: Option<WpeColorAdjust>,
}

impl Default for WpeVideoProps {
    fn default() -> Self {
        Self {
            alignment: WpeAlignment::Cover,
            position: 0.0,
            offset_x: 0.0,
            offset_y: 0.0,
            zoom: 1.0,
            flip_h: false,
            background: None,
            rate: None,
            volume: None,
            color: None,
        }
    }
}

fn properties(raw: &Value) -> Option<&serde_json::Map<String, Value>> {
    raw.get("general")?
        .get("properties")?
        .as_object()
}

fn prop_value<'a>(props: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a Value> {
    props.get(key)?.get("value")
}

fn prop_f32(props: &serde_json::Map<String, Value>, key: &str) -> Option<f32> {
    match prop_value(props, key)? {
        Value::Number(number) => number.as_f64().map(|value| value as f32),
        Value::String(text) => text.trim().parse::<f32>().ok(),
        _ => None,
    }
}

fn prop_i64(props: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    match prop_value(props, key)? {
        Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|v| v as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn prop_bool(props: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    match prop_value(props, key)? {
        Value::Bool(value) => Some(*value),
        Value::Number(number) => Some(number.as_f64().unwrap_or(0.0) != 0.0),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" | "" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `"r g b"`（0–1 浮点）→ 8 位 RGB。
fn parse_scheme_color(props: &serde_json::Map<String, Value>) -> Option<[u8; 3]> {
    let raw = prop_value(props, "schemecolor")?.as_str()?.trim();
    let mut parts = raw.split_whitespace();
    let mut channels = [0u8; 3];
    for channel in &mut channels {
        let value = parts.next()?.parse::<f32>().ok()?;
        *channel = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    Some(channels)
}

fn clamp_unit(value: f32) -> f32 {
    value.clamp(-1.0, 1.0)
}

/// 解析作者默认值。缺失的字段用 WPE 标准默认值（cover / 居中 / 100%）。
pub fn resolve_video_props(project: &WpeProject) -> WpeVideoProps {
    let Some(props) = properties(&project.raw) else {
        return WpeVideoProps::default();
    };

    let alignment = WpeAlignment::from_value(prop_i64(props, "alignment").unwrap_or(0));
    let zoom = prop_f32(props, "alignmentz")
        .map(|value| value * 0.01)
        .filter(|zoom| zoom.is_finite() && *zoom > 0.0)
        .unwrap_or(1.0)
        .clamp(0.01, 8.0);

    let color = if prop_bool(props, "wec_e").unwrap_or(false) {
        let channel = |key: &str| {
            prop_f32(props, key)
                .map(|value| clamp_unit(value / 50.0 - 1.0))
                .unwrap_or(0.0)
        };
        Some(WpeColorAdjust {
            brightness: channel("wec_brs"),
            contrast: channel("wec_con"),
            saturation: channel("wec_sa"),
            hue: channel("wec_hue"),
        })
    } else {
        None
    };

    WpeVideoProps {
        alignment,
        position: prop_f32(props, "alignmentposition")
            .map(|value| clamp_unit(value * 0.01))
            .unwrap_or(0.0),
        offset_x: prop_f32(props, "alignmentx")
            .map(|value| clamp_unit(value * 0.01))
            .unwrap_or(0.0),
        offset_y: prop_f32(props, "alignmenty")
            .map(|value| clamp_unit(value * 0.01))
            .unwrap_or(0.0),
        zoom,
        flip_h: prop_bool(props, "alignmentfliph").unwrap_or(false),
        background: parse_scheme_color(props),
        rate: prop_f32(props, "rate")
            .map(|value| value / 100.0)
            .filter(|rate| rate.is_finite() && *rate > 0.0),
        volume: prop_f32(props, "volume")
            .map(|value| (value / 100.0).clamp(0.0, 1.0)),
        color,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(raw: Value) -> WpeProject {
        WpeProject {
            dir: std::path::PathBuf::from("C:\\wpe\\sample"),
            kind: super::super::project::WpeKind::Video,
            file: Some("entry.mp4".to_string()),
            preview: None,
            title: "T".to_string(),
            description: None,
            tags: Vec::new(),
            workshop_id: None,
            content_rating: None,
            raw,
        }
    }

    #[test]
    fn defaults_follow_wpe_standard() {
        let props = resolve_video_props(&project(json!({ "type": "video" })));
        assert_eq!(props.alignment, WpeAlignment::Cover);
        assert_eq!(props.position, 0.0);
        assert_eq!(props.zoom, 1.0);
        assert!(!props.flip_h);
        assert_eq!(props.background, None);
        assert_eq!(props.color, None);
    }

    #[test]
    fn converts_author_properties() {
        let props = resolve_video_props(&project(json!({
            "general": {
                "properties": {
                    "schemecolor": { "type": "color", "value": "0.5 0.25 1" },
                    "alignment": { "type": "combo", "value": "1" },
                    "alignmentposition": { "type": "slider", "value": 40 },
                    "alignmentx": { "type": "slider", "value": -50 },
                    "alignmenty": { "type": "slider", "value": 25 },
                    "alignmentz": { "type": "slider", "value": 150 },
                    "alignmentfliph": { "type": "bool", "value": true },
                    "rate": { "type": "slider", "value": 200 },
                    "volume": { "type": "slider", "value": 60 },
                    "wec_e": { "type": "bool", "value": true },
                    "wec_brs": { "type": "slider", "value": 75 },
                    "wec_con": { "type": "slider", "value": 25 },
                    "wec_sa": { "type": "slider", "value": 50 },
                    "wec_hue": { "type": "slider", "value": 0 }
                }
            }
        })));
        assert_eq!(props.alignment, WpeAlignment::Fill);
        assert!((props.position - 0.4).abs() < f32::EPSILON);
        assert!((props.offset_x + 0.5).abs() < f32::EPSILON);
        assert!((props.offset_y - 0.25).abs() < f32::EPSILON);
        assert!((props.zoom - 1.5).abs() < f32::EPSILON);
        assert!(props.flip_h);
        assert_eq!(props.background, Some([128, 64, 255]));
        assert!((props.rate.unwrap() - 2.0).abs() < f32::EPSILON);
        assert!((props.volume.unwrap() - 0.6).abs() < f32::EPSILON);
        let color = props.color.expect("wec_e 开启应有颜色调整");
        assert!((color.brightness - 0.5).abs() < f32::EPSILON);
        assert!((color.contrast + 0.5).abs() < f32::EPSILON);
        assert!((color.saturation - 0.0).abs() < f32::EPSILON);
    }

    #[test]
    fn unknown_alignment_falls_back_to_cover() {
        let props = resolve_video_props(&project(json!({
            "general": { "properties": { "alignment": { "value": 99 } } }
        })));
        assert_eq!(props.alignment, WpeAlignment::Cover);
    }
}
