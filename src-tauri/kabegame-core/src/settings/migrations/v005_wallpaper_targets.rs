//! 轮播与当前壁纸的 7 个扁平键并入 `wallpaperTargets.multiple`，并写入显示器模式 `wallpaperDisplayMode`。
//!
//! | 旧键 | 目标字段 |
//! | --- | --- |
//! | `wallpaperRotationPath` | `rotationPath` |
//! | `wallpaperRotationPosition` | `rotationPosition` |
//! | `wallpaperStyleByMode` + `wallpaperStyle` | `style`（壁纸模式 → 样式） |
//! | `wallpaperTransitionByMode` + `wallpaperRotationTransition` | `transition`（壁纸模式 → 过渡） |
//! | `currentWallpaperImageId` | `currentImageId` |
//!
//! `wallpaperStyle` / `wallpaperRotationTransition` 是当前壁纸模式下用户最后看到的值，覆盖 `ByMode[当前模式]`。
//! `wallpaperRotationEnabled`、`wallpaperRotationIntervalMinutes` 仍是全局键，不动。
//!
//! 旧键在就以旧键为准、逐字段覆盖 `multiple`：降级到旧版本时旧版本只认扁平键，保存时又把 `schemaVersion`
//! 写回 4，再升级会重跑本迁移，这时旧键是用户最后一次的选择（与 v004 的约定一致）。旧键不在的字段保留
//! `multiple` 里已有的值，都没有才用默认值，所以对已迁移的 JSON 重跑结果不变。类型不对的旧值按没有处理。

use serde_json::{json, Map, Value};

const TARGET: &str = "multiple";

fn non_empty_string(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(Value::String(s)),
        _ => None,
    }
}

/// 把 `source`（壁纸模式 → 值）里的字符串条目并进 `into`，后来的覆盖已有的。
fn merge_string_map(into: &mut Map<String, Value>, source: Option<Value>) {
    if let Some(Value::Object(source)) = source {
        for (mode, value) in source {
            if value.is_string() {
                into.insert(mode, value);
            }
        }
    }
}

/// 已有目标里的 `style` / `transition`：只留字符串条目，不是对象按空表。
fn existing_string_map(target: &Map<String, Value>, key: &str) -> Map<String, Value> {
    let mut map = Map::new();
    merge_string_map(&mut map, target.get(key).cloned());
    map
}

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };

    // 当前壁纸模式：决定扁平的当前样式 / 过渡记到哪个模式名下；键缺失时与解析设置用同一个平台默认值
    let mode = map
        .get("wallpaperMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(crate::settings::Settings::default_wallpaper_mode);

    let existing = map
        .get("wallpaperTargets")
        .and_then(|targets| targets.get(TARGET))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // 样式：已有目标 < ByMode 缓存（含历史 snake_case 键名）< 当前值
    let mut style = existing_string_map(&existing, "style");
    merge_string_map(&mut style, map.remove("wallpaper_style_by_mode"));
    merge_string_map(&mut style, map.remove("wallpaperStyleByMode"));
    if let Some(current) = non_empty_string(map.remove("wallpaperStyle")) {
        style.insert(mode.clone(), current);
    }

    let mut transition = existing_string_map(&existing, "transition");
    merge_string_map(&mut transition, map.remove("wallpaper_transition_by_mode"));
    merge_string_map(&mut transition, map.remove("wallpaperTransitionByMode"));
    if let Some(current) = non_empty_string(map.remove("wallpaperRotationTransition")) {
        transition.insert(mode, current);
    }

    let had_old_path = map.contains_key("wallpaperRotationPath");
    let old_path = non_empty_string(map.remove("wallpaperRotationPath"));
    let rotation_path = if had_old_path {
        old_path.unwrap_or(Value::Null)
    } else {
        non_empty_string(existing.get("rotationPath").cloned()).unwrap_or(Value::Null)
    };

    let rotation_position = map
        .remove("wallpaperRotationPosition")
        .and_then(|v| v.as_i64())
        .or_else(|| existing.get("rotationPosition").and_then(Value::as_i64))
        .unwrap_or(0)
        .max(-1);

    let had_old_current = map.contains_key("currentWallpaperImageId");
    let old_current = non_empty_string(map.remove("currentWallpaperImageId"));
    let current_image_id = if had_old_current {
        old_current.unwrap_or(Value::Null)
    } else {
        non_empty_string(existing.get("currentImageId").cloned()).unwrap_or(Value::Null)
    };

    let target = json!({
        "rotationPath": rotation_path,
        "rotationPosition": rotation_position,
        "style": style,
        "transition": transition,
        "currentImageId": current_image_id,
    });

    // 不是对象的 wallpaperTargets 按没有处理
    let targets = map.entry("wallpaperTargets").or_insert_with(|| json!({}));
    if !targets.is_object() {
        *targets = json!({});
    }
    if let Value::Object(targets) = targets {
        targets.insert(TARGET.into(), target);
    }

    let display_mode_valid = map
        .get("wallpaperDisplayMode")
        .and_then(Value::as_str)
        .is_some_and(|mode| matches!(mode, "multiple" | "span" | "single"));
    if !display_mode_valid {
        map.insert("wallpaperDisplayMode".into(), json!(TARGET));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    fn migrate(v: Value) -> Value {
        let mut v = v;
        super::up(&mut v).unwrap();
        v
    }

    const OLD_KEYS: [&str; 9] = [
        "wallpaperRotationPath",
        "wallpaperRotationPosition",
        "wallpaperStyle",
        "wallpaperRotationTransition",
        "wallpaperStyleByMode",
        "wallpaperTransitionByMode",
        "wallpaper_style_by_mode",
        "wallpaper_transition_by_mode",
        "currentWallpaperImageId",
    ];

    #[test]
    fn moves_flat_keys_into_multiple_target() {
        let v = migrate(json!({
            "wallpaperMode": "window",
            "wallpaperRotationEnabled": true,
            "wallpaperRotationIntervalMinutes": 30,
            "wallpaperRotationPath": "images://gallery/hide/plugin/pixiv",
            "wallpaperRotationPosition": 7,
            "wallpaperStyle": "fit",
            "wallpaperRotationTransition": "slide",
            "wallpaperStyleByMode": { "native": "fill", "window": "center" },
            "wallpaperTransitionByMode": { "native": "none" },
            "currentWallpaperImageId": "42",
            "x": 1
        }));
        assert_eq!(
            v["wallpaperTargets"],
            json!({
                "multiple": {
                    "rotationPath": "images://gallery/hide/plugin/pixiv",
                    "rotationPosition": 7,
                    // 当前值覆盖 ByMode[当前模式]
                    "style": { "native": "fill", "window": "fit" },
                    "transition": { "native": "none", "window": "slide" },
                    "currentImageId": "42"
                }
            })
        );
        assert_eq!(v["wallpaperDisplayMode"], "multiple");
        for key in OLD_KEYS {
            assert!(v.get(key).is_none(), "{key} 应被删除");
        }
        // 全局键与无关键不动
        assert_eq!(v["wallpaperRotationEnabled"], true);
        assert_eq!(v["wallpaperRotationIntervalMinutes"], 30);
        assert_eq!(v["wallpaperMode"], "window");
        assert_eq!(v["x"], 1);
    }

    #[test]
    fn current_values_go_under_current_wallpaper_mode() {
        let v = migrate(json!({
            "wallpaperMode": "native",
            "wallpaperStyle": "stretch",
            "wallpaperRotationTransition": "fade"
        }));
        let target = &v["wallpaperTargets"]["multiple"];
        assert_eq!(target["style"], json!({ "native": "stretch" }));
        assert_eq!(target["transition"], json!({ "native": "fade" }));
    }

    #[test]
    fn legacy_snake_case_by_mode_keys_are_merged() {
        let v = migrate(json!({
            "wallpaperMode": "native",
            "wallpaper_style_by_mode": { "window": "tile", "native": "fit" },
            "wallpaperStyleByMode": { "native": "center" }
        }));
        // camelCase 键覆盖历史 snake_case 键
        assert_eq!(
            v["wallpaperTargets"]["multiple"]["style"],
            json!({ "native": "center", "window": "tile" })
        );
        assert!(v.get("wallpaper_style_by_mode").is_none());
    }

    #[test]
    fn missing_keys_use_defaults() {
        let v = migrate(json!({ "x": 1 }));
        assert_eq!(
            v,
            json!({
                "x": 1,
                "wallpaperTargets": {
                    "multiple": {
                        "rotationPath": null,
                        "rotationPosition": 0,
                        "style": {},
                        "transition": {},
                        "currentImageId": null
                    }
                },
                "wallpaperDisplayMode": "multiple"
            })
        );
    }

    #[test]
    fn old_keys_win_over_existing_target() {
        // 降级后再升级：旧版本改过扁平键，multiple 里是更早的值
        let v = migrate(json!({
            "wallpaperMode": "window",
            "wallpaperRotationPath": "images://gallery/hide/all",
            "wallpaperRotationPosition": 3,
            "wallpaperStyle": "fill",
            "currentWallpaperImageId": null,
            "wallpaperDisplayMode": "single",
            "wallpaperTargets": {
                "multiple": {
                    "rotationPath": "images://gallery/hide/plugin/pixiv",
                    "rotationPosition": 9,
                    "style": { "window": "tile", "native": "fit" },
                    "transition": { "window": "zoom" },
                    "currentImageId": "42"
                },
                "screen:abc": { "rotationPath": null, "rotationPosition": 1 }
            }
        }));
        assert_eq!(
            v["wallpaperTargets"]["multiple"],
            json!({
                "rotationPath": "images://gallery/hide/all",
                "rotationPosition": 3,
                // 旧键在的字段以旧键为准，旧键没提到的模式与字段保留
                "style": { "native": "fit", "window": "fill" },
                "transition": { "window": "zoom" },
                // 旧键显式为 null：用户在旧版本里清掉了当前壁纸
                "currentImageId": null
            })
        );
        // 其它目标与已有的显示器模式不动
        assert_eq!(
            v["wallpaperTargets"]["screen:abc"],
            json!({ "rotationPath": null, "rotationPosition": 1 })
        );
        assert_eq!(v["wallpaperDisplayMode"], "single");
    }

    #[test]
    fn invalid_types_fall_back_to_defaults() {
        let v = migrate(json!({
            "wallpaperMode": "native",
            "wallpaperRotationPath": 5,
            "wallpaperRotationPosition": "seven",
            "wallpaperStyle": 3,
            "wallpaperRotationTransition": "",
            "wallpaperStyleByMode": ["fill"],
            "wallpaperTransitionByMode": { "native": 1, "window": "fade" },
            "currentWallpaperImageId": { "id": 1 },
            "wallpaperTargets": "broken",
            "wallpaperDisplayMode": "everywhere"
        }));
        assert_eq!(
            v["wallpaperTargets"],
            json!({
                "multiple": {
                    "rotationPath": null,
                    "rotationPosition": 0,
                    "style": {},
                    "transition": { "window": "fade" },
                    "currentImageId": null
                }
            })
        );
        assert_eq!(v["wallpaperDisplayMode"], "multiple");
        for key in OLD_KEYS {
            assert!(v.get(key).is_none(), "{key} 应被删除");
        }
    }

    #[test]
    fn position_keeps_from_start_marker() {
        let v = migrate(json!({ "wallpaperRotationPosition": -1 }));
        assert_eq!(v["wallpaperTargets"]["multiple"]["rotationPosition"], -1);
        let v = migrate(json!({ "wallpaperRotationPosition": -8 }));
        assert_eq!(v["wallpaperTargets"]["multiple"]["rotationPosition"], -1);
    }

    #[test]
    fn idempotent() {
        let once = migrate(json!({
            "wallpaperMode": "window",
            "wallpaperRotationPath": "images://gallery/hide/plugin/pixiv",
            "wallpaperRotationPosition": 7,
            "wallpaperStyle": "fit",
            "wallpaperRotationTransition": "slide",
            "wallpaperStyleByMode": { "native": "fill" },
            "currentWallpaperImageId": "42"
        }));
        assert_eq!(migrate(once.clone()), once);

        let empty_once = migrate(json!({}));
        assert_eq!(migrate(empty_once.clone()), empty_once);
    }

    #[test]
    fn non_object_json_is_untouched() {
        let v = migrate(json!([1, 2]));
        assert_eq!(v, json!([1, 2]));
    }
}
