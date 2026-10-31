//! 网页壁纸用户属性的定义、校验与本地文件白名单。
//!
//! 属性定义（`general.properties`）只在这里解析一次，三处共用：写命令的校验（[`apply_changes`]）、
//! 给面板的视图、推给页面的状态（`properties::resolve_web_user_props`）。用户值存在图片 metadata
//! 顶层的 [`USER_PROPERTIES_KEY`] 段，只存与作者默认值不同的键；改写走
//! `Storage::rewrite_image_metadata`（新行 + 改指），事件由调用方发 `metadataId` 补丁。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Number, Value};

use crate::media::image_type::media_format_by_ext;

/// metadata 顶层的用户属性段：`{ key: 归一后的值 }`，为空时整段去掉。
pub const USER_PROPERTIES_KEY: &str = "userProperties";

/// 属性类型；`Group` / `Text` 只用于面板展示，不可编辑、不推给页面。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WpePropKind {
    Color,
    Slider,
    Bool,
    Combo,
    TextInput,
    File,
    Directory,
    Group,
    Text,
}

/// `combo` 的一个选项：`label` 是原文（未本地化），没有 label 时取 `value` 的字符串形式。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WpeComboOption {
    pub label: String,
    pub value: Value,
}

/// 一条解析后的属性定义。`text` 是原文（可能是 `ui_` 词条或带 HTML）；`default` 是 `project.json`
/// 里的原值（推给页面时保持原样）；`extensions` 来自 `file` 的 `filter`（`*.jpg|*.png` → `[jpg, png]`）；
/// `mode` 是 `directory` 的 `fetchall` / `ondemand`。
#[derive(Debug, Clone, PartialEq)]
pub struct WpePropDef {
    pub key: String,
    pub kind: WpePropKind,
    pub text: String,
    pub order: Option<f64>,
    pub condition: Option<String>,
    pub default: Option<Value>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<WpeComboOption>,
    pub extensions: Vec<String>,
    pub mode: Option<String>,
}

/// 把 `general.properties` 解析成按 `(order, key)` 排好序的定义：未知 `type` 跳过，没有 `type` 但有
/// `text` 的条目当 `Text`，缺 `order` 的排到最后。
pub fn parse_defs(raw: &Value) -> Vec<WpePropDef> {
    let Some(props) = raw
        .pointer("/general/properties")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut defs: Vec<_> = props
        .iter()
        .filter_map(|(key, prop)| {
            let kind = match prop.get("type").and_then(Value::as_str) {
                Some("color") => WpePropKind::Color,
                Some("slider") => WpePropKind::Slider,
                Some("bool") => WpePropKind::Bool,
                Some("combo") => WpePropKind::Combo,
                Some("textinput") => WpePropKind::TextInput,
                Some("file") => WpePropKind::File,
                Some("directory") => WpePropKind::Directory,
                Some("group") => WpePropKind::Group,
                Some("text") | None if prop.get("text").is_some() => WpePropKind::Text,
                _ => return None,
            };
            let options = prop
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let value = option.get("value")?.clone();
                            if !value.is_string() && !value.is_number() {
                                return None;
                            }
                            let label = option
                                .get("label")
                                .or_else(|| option.get("text"))
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| {
                                    value
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| value.to_string())
                                });
                            Some(WpeComboOption { label, value })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let extensions = prop
                .get("filter")
                .and_then(Value::as_str)
                .unwrap_or("")
                .split('|')
                .filter_map(|part| part.trim().strip_prefix("*.").map(str::to_owned))
                .collect();
            Some(WpePropDef {
                key: key.clone(),
                kind,
                text: prop
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .to_owned(),
                order: prop.get("order").and_then(Value::as_f64),
                condition: prop
                    .get("condition")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                default: prop.get("value").cloned(),
                min: prop.get("min").and_then(Value::as_f64),
                max: prop.get("max").and_then(Value::as_f64),
                step: prop.get("step").and_then(Value::as_f64),
                options,
                extensions,
                mode: prop.get("mode").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect();
    defs.sort_by(|a, b| {
        a.order
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b.order.unwrap_or(f64::INFINITY))
            .then_with(|| a.key.cmp(&b.key))
    });
    defs
}

/// 读 metadata 里的用户值段；不是对象就当空。
pub fn user_values(raw: &Value) -> Map<String, Value> {
    raw.get(USER_PROPERTIES_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(v) => v.as_f64(),
        Value::String(v) => v.trim().parse().ok(),
        _ => None,
    }
}

/// 按类型校验并归一：`bool` → 布尔，`slider` → 夹到范围的数字（整数存整数），`combo` → 选项的原始值，
/// `color` → 三个夹到 0–1 的分量，`file` / `directory` → 空串或存在的绝对路径。作者默认值也过一遍，
/// 供面板显示与「等于默认值」的比较。
pub fn normalize_value(def: &WpePropDef, value: &Value) -> Result<Value, String> {
    let bad = || format!("属性 {} 的值无效", def.key);
    match def.kind {
        WpePropKind::Bool => {
            let bool_value = match value {
                Value::Bool(v) => *v,
                Value::Number(v) => v.as_f64().ok_or_else(bad)? != 0.0,
                Value::String(v) => match v.trim().to_ascii_lowercase().as_str() {
                    "true" | "1" | "yes" | "on" => true,
                    "false" | "0" | "no" | "off" | "" => false,
                    _ => return Err(bad()),
                },
                _ => return Err(bad()),
            };
            Ok(Value::Bool(bool_value))
        }
        WpePropKind::Slider => {
            let mut v = number(value).filter(|v| v.is_finite()).ok_or_else(bad)?;
            if let Some(min) = def.min {
                v = v.max(min);
            }
            if let Some(max) = def.max {
                v = v.min(max);
            }
            slider_number(v).ok_or_else(bad)
        }
        WpePropKind::Combo => {
            let text = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            def.options
                .iter()
                .find(|option| {
                    option
                        .value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| option.value.to_string())
                        == text
                })
                .map(|option| option.value.clone())
                .ok_or_else(bad)
        }
        WpePropKind::Color => {
            let parts: Vec<_> = value.as_str().ok_or_else(bad)?.split_whitespace().collect();
            if parts.len() != 3 {
                return Err(bad());
            }
            let channels: Result<Vec<_>, _> = parts
                .iter()
                .map(|part| {
                    part.parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite())
                        .map(|v| v.clamp(0.0, 1.0).to_string())
                        .ok_or_else(bad)
                })
                .collect();
            Ok(Value::String(channels?.join(" ")))
        }
        WpePropKind::TextInput => Ok(Value::String(value.as_str().ok_or_else(bad)?.to_owned())),
        WpePropKind::File | WpePropKind::Directory => {
            let path = value.as_str().ok_or_else(bad)?;
            if !path.is_empty() {
                let p = Path::new(path);
                if !p.is_absolute()
                    || p.is_symlink()
                    || (def.kind == WpePropKind::File && !p.is_file())
                    || (def.kind == WpePropKind::Directory && !p.is_dir())
                {
                    return Err(bad());
                }
            }
            Ok(Value::String(path.to_owned()))
        }
        WpePropKind::Group | WpePropKind::Text => Err(bad()),
    }
}

/// 滑块数值入 JSON：整数存整数，其余存浮点。
fn slider_number(v: f64) -> Option<Value> {
    if v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        return Some(Value::Number(Number::from(v as i64)));
    }
    Number::from_f64(v).map(Value::Number)
}

/// 十进制小数位数（`f64` 的 `Display` 不用科学计数法）。
fn decimals(v: f64) -> usize {
    format!("{v}")
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len())
}

/// 用户写入的滑块值按作者 `step` 对齐到 `min + k×step`（缺 `min` 从 0 起算），再夹回范围，
/// 并按步长与起点的小数位消掉浮点噪声。作者默认值不对齐：没有用户值时页面拿到的是原值。
fn snap_to_step(def: &WpePropDef, value: Value) -> Value {
    let Some(step) = def.step.filter(|step| step.is_finite() && *step > 0.0) else {
        return value;
    };
    let Some(v) = value.as_f64().filter(|_| def.kind == WpePropKind::Slider) else {
        return value;
    };
    let base = def.min.unwrap_or(0.0);
    let mut snapped = base + ((v - base) / step).round() * step;
    if let Some(max) = def.max {
        snapped = snapped.min(max);
    }
    if let Some(min) = def.min {
        snapped = snapped.max(min);
    }
    let scale = 10f64.powi(decimals(step).max(decimals(base)).min(10) as i32);
    slider_number((snapped * scale).round() / scale).unwrap_or(value)
}

/// 把 `{ key: 新值 | null }` 套到 metadata 上（`null` = 恢复默认），返回新的整份 metadata；没有变化返回
/// `None`。键不存在或不可编辑时整个请求报错；滑块值按步长对齐；归一后等于作者默认值的键删掉，段为空时整段去掉。
pub fn apply_changes(raw: &Value, changes: &Map<String, Value>) -> Result<Option<Value>, String> {
    let defs = parse_defs(raw);
    let mut values = user_values(raw);
    for (key, value) in changes {
        let def = defs
            .iter()
            .find(|def| def.key == *key)
            .ok_or_else(|| format!("未知属性: {key}"))?;
        if matches!(def.kind, WpePropKind::Group | WpePropKind::Text) {
            return Err(format!("属性不可编辑: {key}"));
        }
        if value.is_null() {
            values.remove(key);
            continue;
        }
        let normalized = snap_to_step(def, normalize_value(def, value)?);
        if matches!(def.kind, WpePropKind::File | WpePropKind::Directory)
            && normalized == Value::String(String::new())
            && def.default.is_none()
        {
            values.remove(key);
            continue;
        }
        let default = def
            .default
            .as_ref()
            .and_then(|v| normalize_value(def, v).ok());
        if default.as_ref() == Some(&normalized) {
            values.remove(key);
        } else {
            values.insert(key.clone(), normalized);
        }
    }
    let mut next = raw.clone();
    let object = next.as_object_mut().ok_or("metadata 不是对象")?;
    if values.is_empty() {
        object.remove(USER_PROPERTIES_KEY);
    } else {
        object.insert(USER_PROPERTIES_KEY.to_owned(), Value::Object(values));
    }
    Ok((next != *raw).then_some(next))
}

/// 照 WPE 的顺序本地化 `ui_` 词条：当前语言 → `en-us` → 原文，每一级里 WPE 内置词条（`builtin`）
/// 覆盖项目 `general.localization` 的同名词条。非 `ui_` 开头的文本原样返回。本函数不读文件。
pub fn localize(
    raw: &Value,
    language: &str,
    text: &str,
    builtin: &dyn Fn(&str, &str) -> Option<String>,
) -> String {
    if !text.starts_with("ui_") {
        return text.to_owned();
    }
    for lang in [language, "en-us"] {
        if let Some(value) = builtin(lang, text) {
            return value;
        }
        if let Some(value) = raw
            .pointer("/general/localization")
            .and_then(|v| v.get(lang))
            .and_then(|v| v.get(text))
            .and_then(Value::as_str)
        {
            return value.to_owned();
        }
    }
    text.to_owned()
}

/// `directory` 属性的文件列表：递归、不跟随符号链接，只留格式表里 `browser_safe` 的媒体。
/// 每层按文件名排序遍历，够 `limit` 个即停，不必走完整棵树（每次拉取状态都会重新列举）。
pub fn list_directory_files(dir: &Path, limit: usize) -> Vec<PathBuf> {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && !entry.path_is_symlink())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|v| v.to_str())
                .and_then(media_format_by_ext)
                .is_some_and(|format| format.browser_safe)
        })
        .map(|entry| entry.into_path())
        .take(limit)
        .collect()
}

/// 用户为本张壁纸选的本地路径（已 canonicalize）：文件只放行它本身，目录放行其中的普通文件。
pub struct WpeFileGrant {
    pub path: PathBuf,
    pub is_dir: bool,
}

/// 用户值里 `file` / `directory` 属性选的路径。只看用户值、不看作者默认值；空串、符号链接、已不存在的
/// 路径跳过。桌面与预览的追加放行都用这一份。
pub fn user_file_grants(raw: &Value) -> Vec<WpeFileGrant> {
    let values = user_values(raw);
    parse_defs(raw)
        .into_iter()
        .filter_map(|def| {
            if !matches!(def.kind, WpePropKind::File | WpePropKind::Directory) {
                return None;
            }
            let value = values.get(&def.key)?.as_str()?;
            if value.is_empty() {
                return None;
            }
            let path = Path::new(value);
            if path.is_symlink() {
                return None;
            }
            let is_dir = def.kind == WpePropKind::Directory;
            if !(if is_dir {
                path.is_dir()
            } else {
                path.is_file()
            }) {
                return None;
            }
            Some(WpeFileGrant {
                path: path.canonicalize().ok()?,
                is_dir,
            })
        })
        .collect()
}

fn comparable(path: &Path) -> String {
    let value = path
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

/// 页面读本地文件的白名单：项目目录 ∪ 用户选的文件 ∪ 用户选的目录。运行时的闸门不依赖 core，
/// 在 `tauri-runtime-cef` 的 `file_access` 里按同一规则另写一份，这里是规则的参照实现。
pub fn file_allowed(project_dir: &Path, raw: &Value, target: &Path) -> bool {
    if target.is_symlink() || !target.is_file() {
        return false;
    }
    let Ok(target) = target.canonicalize() else {
        return false;
    };
    let target = comparable(&target);
    let inside = |dir: &Path| {
        let dir = comparable(dir);
        target.starts_with(&(dir.trim_end_matches('/').to_owned() + "/"))
    };
    if let Ok(root) = project_dir.canonicalize() {
        if inside(&root) {
            return true;
        }
    }
    user_file_grants(raw).iter().any(|grant| {
        if grant.is_dir {
            inside(&grant.path)
        } else {
            target == comparable(&grant.path)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> Value {
        json!({"general":{"properties":{
            "later":{"type":"bool","text":"Later","value":"true"},
            "slider":{"type":"slider","order":2,"value":"150","min":0,"max":200},
            "first":{"type":"color","order":1,"value":"1 1 1"},
            "combo":{"type":"combo","options":[{"label":"One","value":1},{"label":"Two","value":2}],"value":1},
            "note":{"text":"<h3>Note</h3>"},
            "file":{"type":"file"},"directory":{"type":"directory"},
            "group":{"type":"group"},"unknown":{"type":"odd"}
        },"localization":{"zh-chs":{"ui_x":"项目中文"},"en-us":{"ui_y":"English"}}}})
    }

    #[test]
    fn definitions_and_normalization() {
        let defs = parse_defs(&raw());
        assert_eq!(defs[0].key, "first");
        assert_eq!(defs[1].key, "slider");
        assert!(!defs.iter().any(|def| def.key == "unknown"));
        assert_eq!(
            defs.iter().find(|def| def.key == "note").unwrap().kind,
            WpePropKind::Text
        );
        let find = |key: &str| defs.iter().find(|def| def.key == key).unwrap();
        assert_eq!(
            normalize_value(find("later"), &json!("true")).unwrap(),
            json!(true)
        );
        assert_eq!(
            normalize_value(find("slider"), &json!("250")).unwrap(),
            json!(200)
        );
        assert_eq!(
            normalize_value(find("combo"), &json!("2")).unwrap(),
            json!(2)
        );
        assert_eq!(
            normalize_value(find("first"), &json!("-1 0.5 2")).unwrap(),
            json!("0 0.5 1")
        );
    }

    #[test]
    fn changes_remove_defaults_and_empty_section() {
        let source = raw();
        let mut changes = Map::new();
        changes.insert("later".into(), json!(false));
        let changed = apply_changes(&source, &changes).unwrap().unwrap();
        assert_eq!(user_values(&changed)["later"], json!(false));
        assert!(apply_changes(&changed, &changes).unwrap().is_none());
        changes.insert("later".into(), json!("true"));
        let reset = apply_changes(&changed, &changes).unwrap().unwrap();
        assert!(reset.get(USER_PROPERTIES_KEY).is_none());
        changes.clear();
        changes.insert("missing".into(), json!(1));
        assert!(apply_changes(&source, &changes).is_err());
        changes.clear();
        changes.insert("group".into(), json!(1));
        assert!(apply_changes(&source, &changes).is_err());
        let mut with_file = source.clone();
        with_file[USER_PROPERTIES_KEY] = json!({"file": "C:/example.png"});
        changes.clear();
        changes.insert("file".into(), json!(""));
        assert!(apply_changes(&with_file, &changes)
            .unwrap()
            .unwrap()
            .get(USER_PROPERTIES_KEY)
            .is_none());
    }

    #[test]
    fn slider_writes_snap_to_step() {
        let mut source = raw();
        source["general"]["properties"]["rate"] =
            json!({"type":"slider","value":1,"min":0.5,"max":2,"step":0.25});
        source["general"]["properties"]["odd"] =
            json!({"type":"slider","value":0.3,"min":0,"max":1,"step":0.3});
        let write = |key: &str, value: Value| {
            let mut changes = Map::new();
            changes.insert(key.into(), value);
            apply_changes(&source, &changes)
                .unwrap()
                .map(|next| user_values(&next).get(key).cloned())
                .unwrap_or_default()
        };
        // 输入框键入的值对齐到 min + k×step
        assert_eq!(write("rate", json!(1.3)), Some(json!(1.25)));
        assert_eq!(write("rate", json!(1.4)), Some(json!(1.5)));
        assert_eq!(write("rate", json!(5)), Some(json!(2)));
        assert_eq!(write("rate", json!(0.6)), Some(json!(0.5)));
        // 对齐后等于默认值：不留键
        assert_eq!(write("rate", json!(1.1)), None);
        // 上限不在网格上时停在最近的格点，不越过 max；结果不带浮点噪声
        assert_eq!(write("odd", json!(1)), Some(json!(0.9)));
        // 没有 step 的滑块不对齐
        assert_eq!(write("slider", json!(33.3)), Some(json!(33.3)));
    }

    #[test]
    fn localization_order() {
        let source = raw();
        let builtin = |lang: &str, key: &str| {
            (lang == "zh-chs" && key == "ui_x").then(|| "内置中文".to_string())
        };
        assert_eq!(localize(&source, "zh-chs", "ui_x", &builtin), "内置中文");
        assert_eq!(localize(&source, "ja-jp", "ui_y", &builtin), "English");
        assert_eq!(localize(&source, "zh-chs", "plain", &builtin), "plain");
    }

    #[test]
    fn file_grants_do_not_expand_file_siblings() {
        let base = std::env::temp_dir().join(format!("wpe-user-props-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        let external = base.join("external");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let own = project.join("own.png");
        let selected = external.join("selected.png");
        let sibling = external.join("sibling.png");
        for file in [&own, &selected, &sibling] {
            std::fs::write(file, "x").unwrap();
        }
        let mut source = raw();
        source[USER_PROPERTIES_KEY] = json!({"file": selected.to_string_lossy()});
        assert!(file_allowed(&project, &source, &own));
        assert!(file_allowed(&project, &source, &selected));
        assert!(!file_allowed(&project, &source, &sibling));
        let mut only_default = raw();
        only_default["general"]["properties"]["file"]["value"] = json!(selected.to_string_lossy());
        assert!(!file_allowed(&project, &only_default, &selected));
        source[USER_PROPERTIES_KEY] = json!({"directory": external.to_string_lossy()});
        assert!(file_allowed(&project, &source, &sibling));
        assert!(!file_allowed(&project, &source, &external));
        let link = project.join("link.png");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&sibling, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&sibling, &link).is_ok();
        if linked {
            assert!(!file_allowed(&project, &source, &link));
        }
        let _ = std::fs::remove_dir_all(base);
    }
}
