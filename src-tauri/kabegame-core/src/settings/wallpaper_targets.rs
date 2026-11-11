//! 壁纸目标（target）：轮播路径与位置、样式、过渡、当前壁纸的设置单位。
//!
//! 目标 id 有三种：[`TARGET_MULTIPLE`]（各屏复制，所有显示器同一张）、[`TARGET_SPAN`]（跨屏拼接）、
//! `screen:<平台持久标识>`（逐屏独立，见 [`screen_target`]）。全部目标存在一个设置键
//! `wallpaperTargets: { [targetId]: WallpaperTargetConfig }` 里，一次读-改-写发一次 `setting-change`（整个 map）。
//!
//! 这里只有按目标 id 寻址的领域操作，不认识显示器模式：「显示器模式 → 活跃目标 / 默认目标 / 缺了从哪复制」
//! 的规则在 app crate 的壁纸控制器里。样式与过渡按壁纸模式存（`style: { native, window }`），
//! 读取时由控制器按当前能力归一化，切壁纸模式时不需要改写。

use super::{SettingKey, SettingValue, Settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// 各屏复制：所有显示器显示同一张壁纸的唯一目标。
pub const TARGET_MULTIPLE: &str = "multiple";
/// 跨屏拼接：整个桌面当一块画布的唯一目标。
pub const TARGET_SPAN: &str = "span";

const SCREEN_TARGET_PREFIX: &str = "screen:";

/// 逐屏独立的目标 id：`screen:<平台持久标识>`。
pub fn screen_target(screen_id: &str) -> String {
    format!("{SCREEN_TARGET_PREFIX}{screen_id}")
}

/// `screen:<id>` 目标对应的屏幕持久标识；其它目标返回 None。
pub fn screen_id_of_target(target_id: &str) -> Option<&str> {
    target_id
        .strip_prefix(SCREEN_TARGET_PREFIX)
        .filter(|id| !id.is_empty())
}

/// `rotationPosition` 的特殊值：刚换了轮播路径，下一次切换从第 1 张开始，
/// 不按当前壁纸 id 定位。切换成功后被写成正常位置。
pub const WALLPAPER_ROTATION_FROM_START: i64 = -1;

/// 目标 id → 配置。用 `BTreeMap` 让写出的 settings.json 与事件里的键序稳定。
pub type WallpaperTargets = BTreeMap<String, WallpaperTargetConfig>;

/// 一个目标的配置。轮播开关与间隔是全局设置，不在这里。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WallpaperTargetConfig {
    /// 轮播来源 PathQL 路径（不含分页尾）；None 表示尚未设置，由 rotator 落到默认随机路径
    pub rotation_path: Option<String>,
    /// 下一张在轮播路径中的 0 起序号；[`WALLPAPER_ROTATION_FROM_START`] 表示刚换了路径
    pub rotation_position: i64,
    /// 壁纸模式 → 样式；缺省或不在当前能力里时由控制器取能力表第一项
    pub style: BTreeMap<String, String>,
    /// 壁纸模式 → 过渡；规则同 `style`
    pub transition: BTreeMap<String, String>,
    /// 当前壁纸的图片 id
    pub current_image_id: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn string_map_from_json(json: Option<&Value>) -> BTreeMap<String, String> {
    json.and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

impl WallpaperTargetConfig {
    /// 设置轮播来源路径，返回是否变化。值真正变化时位置置为 [`WALLPAPER_ROTATION_FROM_START`]
    /// （换路径从第 1 张开始）；停止 / 开始轮播不经过这里，所以同一路径的位置得以保持。
    pub fn set_rotation_path(&mut self, path: Option<String>) -> bool {
        let normalized = path
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        if self.rotation_path == normalized {
            return false;
        }
        self.rotation_path = normalized;
        self.rotation_position = WALLPAPER_ROTATION_FROM_START;
        true
    }

    pub fn set_rotation_position(&mut self, position: i64) {
        self.rotation_position = position.max(WALLPAPER_ROTATION_FROM_START);
    }

    /// 空串按未设置处理。
    pub fn set_current_image_id(&mut self, image_id: Option<String>) {
        self.current_image_id = non_empty(image_id);
    }

    /// 逐字段宽松解析：类型不对的字段取默认值，不让一个坏字段丢掉整个目标。
    fn from_json(json: &Value) -> Self {
        let text = |key: &str| non_empty(json.get(key).and_then(Value::as_str).map(str::to_owned));
        Self {
            rotation_path: text("rotationPath"),
            rotation_position: json
                .get("rotationPosition")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .max(WALLPAPER_ROTATION_FROM_START),
            style: string_map_from_json(json.get("style")),
            transition: string_map_from_json(json.get("transition")),
            current_image_id: text("currentImageId"),
        }
    }
}

/// 解析设置文件里的 `wallpaperTargets`；不是对象的条目跳过。
pub(super) fn targets_from_json(json: &Value) -> WallpaperTargets {
    json.as_object()
        .map(|obj| {
            obj.iter()
                .filter(|(_, v)| v.is_object())
                .map(|(id, v)| (id.clone(), WallpaperTargetConfig::from_json(v)))
                .collect()
        })
        .unwrap_or_default()
}

/// 在 map 上改一个目标，返回是否有变化；目标不存在时以 `seed` 为初值并插入（即使 `f` 什么都没改）。
fn update_one(
    targets: &mut WallpaperTargets,
    id: &str,
    seed: impl FnOnce() -> WallpaperTargetConfig,
    f: impl FnOnce(&mut WallpaperTargetConfig),
) -> bool {
    let before = targets.get(id).cloned();
    let mut config = before.clone().unwrap_or_else(seed);
    f(&mut config);
    if before.as_ref() == Some(&config) {
        return false;
    }
    targets.insert(id.to_string(), config);
    true
}

/// 把指向 `removed_ids` 里任一图片的当前壁纸清空（所有目标，含休眠屏与别的显示器模式的目标）。
fn clear_current_images(targets: &mut WallpaperTargets, removed_ids: &[String]) {
    for config in targets.values_mut() {
        if config
            .current_image_id
            .as_ref()
            .is_some_and(|current| removed_ids.contains(current))
        {
            config.current_image_id = None;
        }
    }
}

/// 目标的读-改-写互斥：轮播线程、命令、删图清理会并发改同一个 map。
static TARGETS_WRITE: Mutex<()> = Mutex::new(());

impl Settings {
    pub fn get_wallpaper_targets(&self) -> WallpaperTargets {
        Self::cells()
            .get(&SettingKey::WallpaperTargets)
            .and_then(|c| c.load().as_wallpaper_targets().cloned())
            .unwrap_or_default()
    }

    /// 目标不存在返回 None；「缺了就复制」的规则在控制器里（它知道从哪个目标复制）。
    pub fn get_wallpaper_target(&self, id: &str) -> Option<WallpaperTargetConfig> {
        Self::cells()
            .get(&SettingKey::WallpaperTargets)
            .and_then(|c| {
                c.load()
                    .as_wallpaper_targets()
                    .and_then(|m| m.get(id).cloned())
            })
    }

    fn store_wallpaper_targets(targets: WallpaperTargets) {
        let new_value = SettingValue::WallpaperTargets(targets);
        if let Some(cell) = Self::cells().get(&SettingKey::WallpaperTargets) {
            cell.store(Arc::new(new_value.clone()));
        }
        Self::emit_setting_change(SettingKey::WallpaperTargets, &new_value);
    }

    /// 读-改-写一个目标，有变化才发一次 `setting-change`（整个 map）；目标不存在时以 `seed` 为初值并落盘。
    pub fn update_wallpaper_target(
        &self,
        id: &str,
        seed: impl FnOnce() -> WallpaperTargetConfig,
        f: impl FnOnce(&mut WallpaperTargetConfig),
    ) -> Result<(), String> {
        let _guard = TARGETS_WRITE
            .lock()
            .map_err(|_| "壁纸目标写锁已损坏".to_string())?;
        let mut targets = self.get_wallpaper_targets();
        if update_one(&mut targets, id, seed, f) {
            Self::store_wallpaper_targets(targets);
        }
        Ok(())
    }

    /// 对所有已有目标执行 `f`（删画册清路径、删图清当前壁纸、共用样式级联），有变化才发一次事件。
    pub fn update_all_wallpaper_targets(
        &self,
        mut f: impl FnMut(&str, &mut WallpaperTargetConfig),
    ) -> Result<(), String> {
        let _guard = TARGETS_WRITE
            .lock()
            .map_err(|_| "壁纸目标写锁已损坏".to_string())?;
        let before = self.get_wallpaper_targets();
        let mut targets = before.clone();
        for (id, config) in targets.iter_mut() {
            f(id, config);
        }
        if targets != before {
            Self::store_wallpaper_targets(targets);
        }
        Ok(())
    }

    pub fn remove_wallpaper_target(&self, id: &str) -> Result<(), String> {
        let _guard = TARGETS_WRITE
            .lock()
            .map_err(|_| "壁纸目标写锁已损坏".to_string())?;
        let mut targets = self.get_wallpaper_targets();
        if targets.remove(id).is_some() {
            Self::store_wallpaper_targets(targets);
        }
        Ok(())
    }

    /// 图片被移出图库后，把所有目标里指向它们的当前壁纸清空，避免留下悬空引用。
    pub fn clear_wallpaper_targets_current_images(
        &self,
        removed_ids: &[String],
    ) -> Result<(), String> {
        if removed_ids.is_empty() {
            return Ok(());
        }
        let _guard = TARGETS_WRITE
            .lock()
            .map_err(|_| "壁纸目标写锁已损坏".to_string())?;
        let before = self.get_wallpaper_targets();
        let mut targets = before.clone();
        clear_current_images(&mut targets, removed_ids);
        if targets != before {
            Self::store_wallpaper_targets(targets);
        }
        Ok(())
    }

    /// 显示器模式：`multiple` / `span` / `single`。哪些可用由控制器按能力判断，这里只存值。
    pub fn get_wallpaper_display_mode(&self) -> String {
        Self::cells()
            .get(&SettingKey::WallpaperDisplayMode)
            .and_then(|c| c.load().as_string())
            .filter(|mode| is_wallpaper_display_mode(mode))
            .unwrap_or_else(|| TARGET_MULTIPLE.to_string())
    }

    pub fn set_wallpaper_display_mode(&self, mode: &str) -> Result<(), String> {
        if !is_wallpaper_display_mode(mode) {
            return Err(format!("无效的显示器模式：{mode}"));
        }
        let new_value = SettingValue::String(mode.to_string());
        if let Some(cell) = Self::cells().get(&SettingKey::WallpaperDisplayMode) {
            cell.store(Arc::new(new_value.clone()));
        }
        Self::emit_setting_change(SettingKey::WallpaperDisplayMode, &new_value);
        Ok(())
    }

    /// 逐屏独立下的默认显示器（屏幕持久标识）；None 或该屏不在线时控制器取主屏。
    pub fn get_wallpaper_default_screen(&self) -> Option<String> {
        Self::cells()
            .get(&SettingKey::WallpaperDefaultScreen)
            .and_then(|c| c.load().as_option_string())
            .flatten()
    }

    pub fn set_wallpaper_default_screen(&self, screen_id: Option<String>) -> Result<(), String> {
        let new_value = SettingValue::OptionString(non_empty(screen_id));
        if let Some(cell) = Self::cells().get(&SettingKey::WallpaperDefaultScreen) {
            cell.store(Arc::new(new_value.clone()));
        }
        Self::emit_setting_change(SettingKey::WallpaperDefaultScreen, &new_value);
        Ok(())
    }
}

pub(super) fn is_wallpaper_display_mode(mode: &str) -> bool {
    matches!(mode, "multiple" | "span" | "single")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screen_target_round_trips() {
        let id = screen_target("37D8832A-2D66-02CA-B9F7-8F30A301B230");
        assert_eq!(id, "screen:37D8832A-2D66-02CA-B9F7-8F30A301B230");
        assert_eq!(
            screen_id_of_target(&id),
            Some("37D8832A-2D66-02CA-B9F7-8F30A301B230")
        );
        assert_eq!(screen_id_of_target(TARGET_MULTIPLE), None);
        assert_eq!(screen_id_of_target(TARGET_SPAN), None);
        assert_eq!(screen_id_of_target("screen:"), None);
    }

    #[test]
    fn changing_rotation_path_restarts_from_first() {
        let mut config = WallpaperTargetConfig {
            rotation_path: Some("images://gallery/hide/all".into()),
            rotation_position: 7,
            ..Default::default()
        };
        // 规范化后相同：不算变化，位置保持
        assert!(!config.set_rotation_path(Some(" images://gallery/hide/all/ ".into())));
        assert_eq!(config.rotation_position, 7);

        assert!(config.set_rotation_path(Some("images://gallery/hide/plugin/pixiv".into())));
        assert_eq!(config.rotation_position, WALLPAPER_ROTATION_FROM_START);

        config.set_rotation_position(3);
        assert!(config.set_rotation_path(Some("  ".into())));
        assert_eq!(config.rotation_path, None);
        assert_eq!(config.rotation_position, WALLPAPER_ROTATION_FROM_START);
    }

    #[test]
    fn position_and_current_image_are_normalized() {
        let mut config = WallpaperTargetConfig::default();
        config.set_rotation_position(-9);
        assert_eq!(config.rotation_position, WALLPAPER_ROTATION_FROM_START);
        config.set_current_image_id(Some("  ".into()));
        assert_eq!(config.current_image_id, None);
        config.set_current_image_id(Some(" 42 ".into()));
        assert_eq!(config.current_image_id.as_deref(), Some("42"));
    }

    #[test]
    fn update_seeds_missing_target_and_reports_changes() {
        let mut targets = WallpaperTargets::new();
        let seed = || WallpaperTargetConfig {
            rotation_path: Some("images://gallery/hide/all".into()),
            rotation_position: 5,
            ..Default::default()
        };

        // 目标不存在：以种子为初值落盘，即使闭包什么都没改
        assert!(update_one(&mut targets, "screen:a", seed, |_| {}));
        assert_eq!(targets["screen:a"].rotation_position, 5);

        // 目标已存在：种子不再使用，没有变化就不算写入
        assert!(!update_one(
            &mut targets,
            "screen:a",
            WallpaperTargetConfig::default,
            |_| {}
        ));
        assert_eq!(targets["screen:a"].rotation_position, 5);

        assert!(update_one(
            &mut targets,
            "screen:a",
            WallpaperTargetConfig::default,
            |config| config.set_current_image_id(Some("42".into()))
        ));
        assert_eq!(targets["screen:a"].current_image_id.as_deref(), Some("42"));
        // 只动了这一个目标
        assert_eq!(targets.len(), 1);
    }

    #[test]
    fn removed_images_are_cleared_from_every_target() {
        let with_current = |id: &str| WallpaperTargetConfig {
            current_image_id: Some(id.to_string()),
            ..Default::default()
        };
        let mut targets = WallpaperTargets::from([
            (TARGET_MULTIPLE.to_string(), with_current("1")),
            (screen_target("a"), with_current("2")),
            (screen_target("b"), with_current("1")),
            (TARGET_SPAN.to_string(), WallpaperTargetConfig::default()),
        ]);
        clear_current_images(&mut targets, &["1".to_string(), "9".to_string()]);
        assert_eq!(targets[TARGET_MULTIPLE].current_image_id, None);
        assert_eq!(targets["screen:a"].current_image_id.as_deref(), Some("2"));
        assert_eq!(targets["screen:b"].current_image_id, None);
        assert_eq!(targets[TARGET_SPAN].current_image_id, None);
    }

    #[test]
    fn serializes_as_camel_case() {
        let config = WallpaperTargetConfig {
            rotation_path: Some("images://gallery/hide/all".into()),
            rotation_position: 2,
            style: BTreeMap::from([("native".to_string(), "fill".to_string())]),
            transition: BTreeMap::from([("window".to_string(), "fade".to_string())]),
            current_image_id: Some("42".into()),
        };
        assert_eq!(
            serde_json::to_value(&config).unwrap(),
            json!({
                "rotationPath": "images://gallery/hide/all",
                "rotationPosition": 2,
                "style": { "native": "fill" },
                "transition": { "window": "fade" },
                "currentImageId": "42"
            })
        );
    }

    #[test]
    fn parses_leniently_field_by_field() {
        let targets = targets_from_json(&json!({
            "multiple": {
                "rotationPath": "",
                "rotationPosition": -5,
                "style": { "native": "fit", "window": 3 },
                "transition": "fade",
                "currentImageId": 42
            },
            "screen:abc": { "rotationPath": "images://gallery/hide/all", "rotationPosition": 4 },
            "broken": "not an object"
        }));
        assert_eq!(targets.len(), 2);
        let multiple = &targets[TARGET_MULTIPLE];
        assert_eq!(multiple.rotation_path, None);
        assert_eq!(multiple.rotation_position, WALLPAPER_ROTATION_FROM_START);
        assert_eq!(
            multiple.style,
            BTreeMap::from([("native".to_string(), "fit".to_string())])
        );
        assert!(multiple.transition.is_empty());
        assert_eq!(multiple.current_image_id, None);
        assert_eq!(targets["screen:abc"].rotation_position, 4);

        assert!(targets_from_json(&json!([1, 2])).is_empty());
    }
}
