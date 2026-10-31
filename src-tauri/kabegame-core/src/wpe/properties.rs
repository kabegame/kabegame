//! 把 `project.json` 的**作者默认值**换算成壁纸窗口可用的视频播放属性；网页壁纸则原样取出
//! 带 `value` 的条目（[`resolve_web_user_props`]），由垫片投递给页面的 `applyUserProperties`。
//!
//! WPE 不在磁盘上生成任何壁纸副本：缩放、对齐、翻转、背景色、播放速率、音量与
//! 亮度 / 对比度 / 饱和度 / 色相全部是播放时的逐壁纸属性。Kabegame 同样只播原文件，
//! 由壁纸窗口用 CSS 复现这些属性。
//!
//! 只读 `project.json` 的 `general.properties`，**不读** WPE 的 `config.json` /
//! `wproperties`——用户在 WPE 里改过的值不带入。Kabegame 自己的样式 / 音量 / 倍速
//! 在壁纸窗口前端覆盖（见 `apps/kabegame/src/components/wallpaper/WallpaperStage.vue`），后端只给作者值。

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
    raw.get("general")?.get("properties")?.as_object()
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
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|v| v as i64)),
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
    resolve_video_props_from_raw(&project.raw)
}

/// 同 [`resolve_video_props`]，直接吃 `project.json` 原文。壁纸目标组装用它读图片 metadata
/// （导入时写入的 `project.json` 原文），不重读磁盘；用户属性落地后也合并在这份元数据里。
pub fn resolve_video_props_from_raw(raw: &Value) -> WpeVideoProps {
    let Some(props) = properties(raw) else {
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
        volume: prop_f32(props, "volume").map(|value| (value / 100.0).clamp(0.0, 1.0)),
        color,
    }
}

/// 网页壁纸用户属性：作者默认值叠加本张图片的用户值。
pub fn resolve_web_user_props(raw: &Value) -> serde_json::Map<String, Value> {
    use super::user_props::{parse_defs, user_values, WpePropKind};
    let mut out = serde_json::Map::new();
    let user = user_values(raw);
    for def in parse_defs(raw) {
        if matches!(def.kind, WpePropKind::Group | WpePropKind::Text) {
            continue;
        }
        let Some(mut value) = user.get(&def.key).cloned().or(def.default) else {
            continue;
        };
        if matches!(def.kind, WpePropKind::File | WpePropKind::Directory) {
            if let Some(path) = value.as_str() {
                value = Value::String(path.replace('\\', "/"));
            }
        }
        out.insert(
            def.key,
            serde_json::json!({ "type": def.kind, "value": value }),
        );
    }
    out
}

/// Kabegame 界面语言（`Settings::get_resolved_language`）→ WPE 语言码（webwallpaper64 码表，连字符形式）。
pub fn wpe_language_code(locale: &str) -> &'static str {
    match locale {
        "zh" => "zh-chs",
        "zhtw" => "zh-cht",
        "ja" => "ja-jp",
        "ko" => "ko-kr",
        _ => "en-us",
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

    /// kaguya（创意工坊 3679122549）`project.json` 的 `general.properties` 片段，外加分组 / 说明行。
    fn kaguya_raw() -> Value {
        json!({
            "type": "web",
            "file": "index.html",
            "general": {
                "properties": {
                    "audio_sensitivity": {
                        "index": 5, "max": 1.5, "min": 0.5, "order": 105, "step": 0.1,
                        "text": "Audio Sensitivity", "type": "slider", "value": 1
                    },
                    "bg_mouse_sensitivity": {
                        "index": 1, "max": 3, "min": 0.1, "order": 101, "step": 0.1,
                        "text": "Mouse Animation Sensitivity", "type": "slider", "value": 1
                    },
                    "custom_user_bg": {
                        "filter": "*.jpg|*.png|*.jpeg|*.webp", "index": 0, "order": 100,
                        "text": "Custom BG Image", "type": "file"
                    },
                    "playback_rate": {
                        "index": 2, "max": 2, "min": 0.25, "order": 102, "step": 0.25,
                        "text": "Playback Speed", "type": "slider", "value": 1
                    },
                    "schemecolor": {
                        "order": 0, "text": "ui_browse_properties_scheme_color", "type": "color",
                        "value": "0.7529411764705882 0.7529411764705882 0.7529411764705882"
                    },
                    "text_color": {
                        "index": 3, "order": 103, "text": "Text Color", "type": "color", "value": "1 1 1"
                    },
                    "visualizer_color": {
                        "index": 4, "order": 104, "text": "Visualizer Color", "type": "color", "value": "1 1 1"
                    },
                    "group_audio": { "order": 200, "text": "<h3>Audio</h3>", "type": "group" },
                    "note": { "order": 201, "text": "Only a description line" }
                }
            }
        })
    }

    #[test]
    fn web_user_props_keep_entries_with_value() {
        let props = resolve_web_user_props(&kaguya_raw());
        let mut keys: Vec<_> = props.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "audio_sensitivity",
                "bg_mouse_sensitivity",
                "playback_rate",
                "schemecolor",
                "text_color",
                "visualizer_color"
            ]
        );
        // 只保留 type 与 value，展示字段（text / min / max / step / order）不推
        assert_eq!(
            props["audio_sensitivity"],
            json!({ "type": "slider", "value": 1 })
        );
        assert_eq!(
            props["schemecolor"],
            json!({
                "type": "color",
                "value": "0.7529411764705882 0.7529411764705882 0.7529411764705882"
            })
        );
        // 没有默认值的 file 属性、分组与说明行被跳过
        assert!(!props.contains_key("custom_user_bg"));
        assert!(!props.contains_key("group_audio"));
        assert!(!props.contains_key("note"));
    }

    #[test]
    fn web_user_props_without_type_or_properties() {
        let props = resolve_web_user_props(&json!({
            "general": { "properties": { "x": { "value": false } } }
        }));
        assert!(props.is_empty());
        assert!(resolve_web_user_props(&json!({ "type": "web" })).is_empty());
    }

    #[test]
    fn web_user_props_overlay_and_file_without_default() {
        let mut raw = kaguya_raw();
        raw["userProperties"] =
            json!({"playback_rate": 1.5, "custom_user_bg": "C:\\Users\\me\\wall.png"});
        let props = resolve_web_user_props(&raw);
        assert_eq!(
            props["playback_rate"],
            json!({"type":"slider", "value":1.5})
        );
        assert_eq!(
            props["custom_user_bg"],
            json!({"type":"file", "value":"C:/Users/me/wall.png"})
        );
    }

    #[test]
    fn wpe_language_codes() {
        assert_eq!(wpe_language_code("zh"), "zh-chs");
        assert_eq!(wpe_language_code("zhtw"), "zh-cht");
        assert_eq!(wpe_language_code("ja"), "ja-jp");
        assert_eq!(wpe_language_code("ko"), "ko-kr");
        assert_eq!(wpe_language_code("en"), "en-us");
        assert_eq!(wpe_language_code("fr"), "en-us");
    }
}
