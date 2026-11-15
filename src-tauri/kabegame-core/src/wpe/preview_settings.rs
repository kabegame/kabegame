//! WPE 壁纸的「预览设置」：图库预览（与应用背景）用的一套通用设置，每张壁纸一份，存在 metadata 顶层的
//! [`PREVIEW_SETTINGS_KEY`] 段，与作者属性 `userProperties` 并列。只存与 Kabegame 默认值不同的键，没设的项取
//! 下面的默认值，不回落到全局的「壁纸设置」（那一套只给桌面）。改写走 `Storage::rewrite_image_metadata`，
//! 之后由调用方发 `metadataId` 补丁。
//!
//! 字段表与默认值在前端 `apps/kabegame/src/utils/wpeSettings.ts` 有一份镜像，改一处要同步另一处。
//! 预览的暂停不在这里：它是预览弹窗里的内存状态。

use serde_json::{Map, Number, Value};

/// metadata 顶层的段名。
pub const PREVIEW_SETTINGS_KEY: &str = "previewSettings";

const VOLUME: &str = "volume";
const PLAYBACK_RATE: &str = "playbackRate";
const MEDIA_INTEGRATION: &str = "mediaIntegration";
const POSTPROCESS: &str = "postprocess";
const REFLECTION: &str = "reflection";
const SHADOWS: &str = "shadows";
const VOLUMETRICS: &str = "volumetrics";

/// Kabegame 自己的默认值（与 WPE 出厂值一致）。
const DEFAULT_VOLUME: f64 = 1.0;
const DEFAULT_PLAYBACK_RATE: f64 = 1.0;
const DEFAULT_MEDIA_INTEGRATION: bool = true;
const DEFAULT_POSTPROCESS: &str = "enabled";
const DEFAULT_REFLECTION: &str = "enabled";
const DEFAULT_SHADOWS: &str = "medium";
const DEFAULT_VOLUMETRICS: &str = "medium";

/// 把一个值规整成能存的形状；键不认识或值非法返回 Err，数值钳到范围内。
fn normalize(key: &str, value: &Value) -> Result<Value, String> {
    let number = |min: f64, max: f64| {
        value
            .as_f64()
            .filter(|v| v.is_finite())
            .and_then(|v| Number::from_f64(v.clamp(min, max)))
            .map(Value::Number)
            .ok_or_else(|| format!("预览设置 {key} 不是数字"))
    };
    let choice = |valid: fn(&str) -> bool| match value.as_str() {
        Some(text) if valid(text) => Ok(Value::String(text.to_owned())),
        _ => Err(format!("预览设置 {key} 的取值无效")),
    };
    match key {
        VOLUME => number(0.0, 1.0),
        PLAYBACK_RATE => number(0.25, 3.0),
        MEDIA_INTEGRATION => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("预览设置 {key} 不是布尔值")),
        POSTPROCESS => choice(crate::settings::is_wpe_scene_postprocess),
        REFLECTION => choice(crate::settings::is_wpe_scene_reflection),
        SHADOWS => choice(crate::settings::is_wpe_scene_shadows),
        VOLUMETRICS => choice(crate::settings::is_wpe_scene_volumetrics),
        _ => Err(format!("未知预览设置: {key}")),
    }
}

fn default_of(key: &str) -> Value {
    match key {
        VOLUME => Value::from(DEFAULT_VOLUME),
        PLAYBACK_RATE => Value::from(DEFAULT_PLAYBACK_RATE),
        MEDIA_INTEGRATION => Value::Bool(DEFAULT_MEDIA_INTEGRATION),
        POSTPROCESS => Value::from(DEFAULT_POSTPROCESS),
        REFLECTION => Value::from(DEFAULT_REFLECTION),
        VOLUMETRICS => Value::from(DEFAULT_VOLUMETRICS),
        _ => Value::from(DEFAULT_SHADOWS),
    }
}

/// 存了且合法的键（非法的当没设，规整后返回）。
pub fn stored(raw: &Value) -> Map<String, Value> {
    raw.get(PREVIEW_SETTINGS_KEY)
        .and_then(Value::as_object)
        .map(|section| {
            section
                .iter()
                .filter_map(|(key, value)| Some((key.clone(), normalize(key, value).ok()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// 写入 `{ key: 新值 | null }`：`null` 删键，等于默认值也删键，段空了删掉整段。没有变化返回 `None`。
pub fn apply_changes(raw: &Value, changes: &Map<String, Value>) -> Result<Option<Value>, String> {
    let mut values = stored(raw);
    for (key, value) in changes {
        if value.is_null() {
            // 不认识的键删除时也要报错，免得调用方拼错键名而不自知
            normalize(key, &default_of(key))?;
            values.remove(key);
            continue;
        }
        let normalized = normalize(key, value)?;
        if normalized == default_of(key) {
            values.remove(key);
        } else {
            values.insert(key.clone(), normalized);
        }
    }
    let mut next = raw.clone();
    let object = next.as_object_mut().ok_or("metadata 不是对象")?;
    if values.is_empty() {
        object.remove(PREVIEW_SETTINGS_KEY);
    } else {
        object.insert(PREVIEW_SETTINGS_KEY.to_owned(), Value::Object(values));
    }
    Ok((next != *raw).then_some(next))
}

/// 预览的媒体集成是否打开（没设取默认）。
pub fn media_integration(raw: &Value) -> bool {
    stored(raw)
        .get(MEDIA_INTEGRATION)
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_MEDIA_INTEGRATION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn changes(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn apply_stores_only_non_default_values() {
        let raw = json!({ "general": {}, "userProperties": { "a": 1 } });
        let next = apply_changes(
            &raw,
            &changes(json!({ "volume": 0.5, "shadows": "medium", "postprocess": "follow" })),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            next[PREVIEW_SETTINGS_KEY],
            json!({ "volume": 0.5, "postprocess": "follow" })
        );
        // 作者属性段原样保留
        assert_eq!(next["userProperties"], json!({ "a": 1 }));
    }

    #[test]
    fn apply_clamps_and_rejects_invalid() {
        let raw = json!({});
        let next = apply_changes(&raw, &changes(json!({ "playbackRate": 9, "volume": -1 })))
            .unwrap()
            .unwrap();
        assert_eq!(
            next[PREVIEW_SETTINGS_KEY],
            json!({ "playbackRate": 3.0, "volume": 0.0 })
        );
        assert!(apply_changes(&raw, &changes(json!({ "reflection": "ultra" }))).is_err());
        assert!(apply_changes(&raw, &changes(json!({ "mediaIntegration": 1 }))).is_err());
        assert!(apply_changes(&raw, &changes(json!({ "paused": true }))).is_err());
        assert!(apply_changes(&raw, &changes(json!({ "paused": null }))).is_err());
    }

    #[test]
    fn null_and_default_remove_keys_and_empty_section() {
        let raw = json!({ PREVIEW_SETTINGS_KEY: { "volume": 0.5, "mediaIntegration": false } });
        let next = apply_changes(
            &raw,
            &changes(json!({ "volume": null, "mediaIntegration": true })),
        )
        .unwrap()
        .unwrap();
        assert!(next.get(PREVIEW_SETTINGS_KEY).is_none());
        // 没有变化不改写
        assert_eq!(
            apply_changes(&next, &changes(json!({ "volume": 1 }))).unwrap(),
            None
        );
    }

    #[test]
    fn stored_drops_invalid_entries() {
        let raw = json!({ PREVIEW_SETTINGS_KEY: { "volume": "loud", "shadows": "high", "x": 1 } });
        assert_eq!(Value::Object(stored(&raw)), json!({ "shadows": "high" }));
        assert!(media_integration(&raw));
        let off = json!({ PREVIEW_SETTINGS_KEY: { "mediaIntegration": false } });
        assert!(!media_integration(&off));
    }

    #[test]
    fn volumetrics_choices_and_default() {
        let raw = json!({});
        // 默认 medium 不存，其余档位存；不认识的值报错
        assert_eq!(
            apply_changes(&raw, &changes(json!({ "volumetrics": "medium" }))).unwrap(),
            None
        );
        let next = apply_changes(&raw, &changes(json!({ "volumetrics": "ultra" })))
            .unwrap()
            .unwrap();
        assert_eq!(
            next[PREVIEW_SETTINGS_KEY],
            json!({ "volumetrics": "ultra" })
        );
        assert!(apply_changes(&raw, &changes(json!({ "volumetrics": "enabled" }))).is_err());
    }
}
