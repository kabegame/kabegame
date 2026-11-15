//! 场景快捷方式（`usershortcut`，P11d）：给场景宿主取图标、给应用页启动。
//!
//! 两个入口 [`icon`] 与 [`launch`] 共用同一组检查：图片在库里且是场景、属性在 `project.json` 里是 `usershortcut`、
//! 值只取 metadata 的 `userProperties`（用户在面板里配的，不取作者缺省值）、值能解析。图标按原值在内存里缓存。
//! 取图标与启动的平台部分只在 Windows（`windows.rs`），其它平台 [`icon`] 返回 `None`、[`launch`] 报错。

// 非 Windows 上平台部分不编译，取图标 / 启动的调用链里有一批只在 Windows 用的函数
#![cfg_attr(not(windows), allow(dead_code))]

pub mod cv;
pub mod web;
#[cfg(windows)]
pub mod windows;

use std::sync::{Arc, Mutex};

use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::storage::Storage;
use kabegame_core::wpe::user_props::{
    parse_defs, parse_user_shortcut, user_values, ShortcutKind, UserShortcut, WpePropKind,
};
use serde_json::Value;

/// 图标：直通 alpha 的 RGBA，`rgba.len() == width·height·4`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Icon {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Icon {
    /// 命令返回的字节：`[宽 u32 LE][高 u32 LE][RGBA…]`。
    pub fn to_ipc_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(8 + self.rgba.len());
        bytes.extend_from_slice(&self.width.to_le_bytes());
        bytes.extend_from_slice(&self.height.to_le_bytes());
        bytes.extend_from_slice(&self.rgba);
        bytes
    }
}

/// 文件 / 文件夹 / 命令图标的最后一步：透明区填色（rea-p11d 2.4）。
pub(crate) fn finish(mut icon: Icon) -> Icon {
    cv::fill_transparent(&mut icon.rgba, icon.width as usize, icon.height as usize);
    icon
}

/// 图片必须是库内场景（`x-wpe/scene`）。
fn ensure_scene(media_type: Option<&str>) -> Result<(), String> {
    if wpe_kind(media_type).as_deref() == Some("scene") {
        Ok(())
    } else {
        Err("not a scene wallpaper in the library".into())
    }
}

/// 在 `project.json` 原文（metadata）里查 `name`：不存在或类型不是 `usershortcut` 报错；用户没配（没有用户值、空串、
/// 格式不对）返回 `None`；否则返回（原值，解析结果）。作者缺省值不看。
fn lookup_in_metadata(raw: &Value, name: &str) -> Result<Option<(String, UserShortcut)>, String> {
    let def = parse_defs(raw)
        .into_iter()
        .find(|def| def.key == name)
        .ok_or_else(|| format!("未知属性: {name}"))?;
    if def.kind != WpePropKind::UserShortcut {
        return Err(format!("属性不是快捷方式: {name}"));
    }
    let values = user_values(raw);
    let Some(value) = values.get(name).and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(parse_user_shortcut(value).map(|shortcut| (value.to_owned(), shortcut)))
}

async fn lookup(image_id: &str, name: &str) -> Result<Option<(String, UserShortcut)>, String> {
    let info = Storage::find_image_by_id(image_id)
        .map_err(|error| error.to_string())?
        .ok_or("image not found")?;
    ensure_scene(info.media_type.as_deref())?;
    let id = info.id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    lookup_in_metadata(&raw.unwrap_or_default(), name)
}

/// 小 LRU：按原值缓存取到的图标（WPE 存在 `bin/thumbnail.cache`，不跨重启缓存在画面上没有区别）。
struct IconCache {
    capacity: usize,
    entries: Vec<(String, Arc<Icon>)>,
}

impl IconCache {
    const fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: Vec::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<Arc<Icon>> {
        let position = self.entries.iter().position(|(known, _)| known == key)?;
        let entry = self.entries.remove(position);
        let icon = entry.1.clone();
        self.entries.push(entry);
        Some(icon)
    }

    fn insert(&mut self, key: String, icon: Arc<Icon>) {
        self.entries.retain(|(known, _)| *known != key);
        self.entries.push((key, icon));
        if self.entries.len() > self.capacity {
            self.entries.remove(0);
        }
    }
}

static ICON_CACHE: Mutex<IconCache> = Mutex::new(IconCache::new(48));

/// 取图标。没配置、取不到、非 Windows 返回 `None`；图片不是库内场景、属性类型不对报错。
pub async fn icon(image_id: &str, name: &str) -> Result<Option<Icon>, String> {
    let Some((raw, shortcut)) = lookup(image_id, name).await? else {
        return Ok(None);
    };
    if let Some(hit) = ICON_CACHE.lock().ok().and_then(|mut cache| cache.get(&raw)) {
        return Ok(Some((*hit).clone()));
    }
    let Some(icon) = render(shortcut).await else {
        return Ok(None);
    };
    if let Ok(mut cache) = ICON_CACHE.lock() {
        cache.insert(raw, Arc::new(icon.clone()));
    }
    Ok(Some(icon))
}

#[cfg(windows)]
async fn render(shortcut: UserShortcut) -> Option<Icon> {
    match shortcut.kind {
        ShortcutKind::Web => web::icon(&shortcut.path).await,
        _ => tauri::async_runtime::spawn_blocking(move || {
            windows::prefill_icon(&shortcut.path).map(finish)
        })
        .await
        .ok()
        .flatten(),
    }
}

#[cfg(not(windows))]
async fn render(_shortcut: UserShortcut) -> Option<Icon> {
    // TODO:[WPE_SCENE] macOS / Linux 上做快捷方式图标：Windows 照 winrtutil 取 Shell 缩略图与系统图标，
    // 其它平台没有对应接口，先一律没有图标（场景里的图标槽用缺省纹理）。
    None
}

/// 启动。没配返回 `false`；图片不是库内场景、属性类型不对、非 Windows 报错；Windows 上
/// `ShellExecuteW` 返回值 > 32 为 `true`。
pub async fn launch(image_id: &str, name: &str) -> Result<bool, String> {
    let Some((_, shortcut)) = lookup(image_id, name).await? else {
        return Ok(false);
    };
    launch_shortcut(shortcut).await
}

#[cfg(windows)]
async fn launch_shortcut(shortcut: UserShortcut) -> Result<bool, String> {
    let ok = tauri::async_runtime::spawn_blocking(move || {
        windows::shell_execute(&shortcut.path, &shortcut.args)
    })
    .await
    .map_err(|error| error.to_string())?;
    if !ok {
        tracing::warn!("启动场景快捷方式失败（ShellExecute 返回值 ≤ 32）");
    }
    Ok(ok)
}

#[cfg(not(windows))]
async fn launch_shortcut(_shortcut: UserShortcut) -> Result<bool, String> {
    // TODO:[WPE_SCENE] macOS / Linux 上做快捷方式启动（`open` / `xdg-open`）；目前只有 Windows。
    Err("scene shortcuts can only be launched on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw() -> Value {
        json!({
            "general": { "properties": {
                "app": { "type": "usershortcut", "text": "App", "value": "" },
                "withdefault": { "type": "usershortcut", "value": "cmd:calc" },
                "note": { "type": "textinput", "value": "cmd:calc" },
                "unset": { "type": "usershortcut", "value": "" }
            } },
            "userProperties": {
                "app": "file:C:\\Windows\\System32\\notepad.exe|-x",
                "note": "cmd:calc"
            }
        })
    }

    #[test]
    fn lookup_takes_only_user_configured_shortcuts() {
        let found = lookup_in_metadata(&raw(), "app").unwrap().unwrap();
        assert_eq!(found.1.kind, ShortcutKind::File);
        assert_eq!(found.1.args, "-x");
        assert!(found.0.starts_with("file:"));
        // 没配
        assert_eq!(lookup_in_metadata(&raw(), "unset").unwrap(), None);
        // 只有作者缺省值：不认
        assert_eq!(lookup_in_metadata(&raw(), "withdefault").unwrap(), None);
        // 类型不对（textinput 里存了合法的值也不认）、属性不存在：报错
        assert!(lookup_in_metadata(&raw(), "note").is_err());
        assert!(lookup_in_metadata(&raw(), "missing").is_err());
        // 值存的是格式不对的串：当没配
        let mut broken = raw();
        broken["userProperties"]["app"] = json!("garbage");
        assert_eq!(lookup_in_metadata(&broken, "app").unwrap(), None);
        // metadata 缺失：属性不存在
        assert!(lookup_in_metadata(&Value::Null, "app").is_err());
    }

    #[test]
    fn only_library_scenes_pass_the_scene_check() {
        assert!(ensure_scene(Some("x-wpe/scene")).is_ok());
        for other in [
            Some("x-wpe/web"),
            Some("x-wpe/video"),
            Some("image/png"),
            None,
        ] {
            assert!(ensure_scene(other).is_err(), "{other:?}");
        }
    }

    #[test]
    fn ipc_bytes_are_width_height_then_rgba() {
        let icon = Icon {
            width: 2,
            height: 1,
            rgba: vec![1, 2, 3, 4, 5, 6, 7, 8],
        };
        assert_eq!(
            icon.to_ipc_bytes(),
            [2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]
        );
    }

    #[test]
    fn cache_evicts_the_least_recently_used() {
        let icon = |n: u8| {
            Arc::new(Icon {
                width: 1,
                height: 1,
                rgba: vec![n; 4],
            })
        };
        let mut cache = IconCache::new(2);
        cache.insert("a".into(), icon(1));
        cache.insert("b".into(), icon(2));
        // 读 a 之后 b 成了最久未用
        assert_eq!(cache.get("a").unwrap().rgba[0], 1);
        cache.insert("c".into(), icon(3));
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some() && cache.get("c").is_some());
        // 同键覆盖不增加条目
        cache.insert("a".into(), icon(9));
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.get("a").unwrap().rgba[0], 9);
    }

    /// 核对用（`#[ignore]`，Windows）：按 `KB_SHORTCUT_DUMP`（`名字=原值;名字=原值`，原值是 `<类型>:<路径>[|<参数>]`）
    /// 取图标，跳过 metadata 检查，写成 `<KB_SHORTCUT_DUMP_DIR>/<名字>.png`；文件 / 文件夹 / 命令另写一份透明区填色之前的
    /// `<名字>.prefill.png`。网址项会联网。
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn dump_shortcut_icons() {
        let spec = std::env::var("KB_SHORTCUT_DUMP").expect("缺 KB_SHORTCUT_DUMP");
        let dir = std::path::PathBuf::from(
            std::env::var("KB_SHORTCUT_DUMP_DIR").expect("缺 KB_SHORTCUT_DUMP_DIR"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let save = |icon: &Icon, file: String| {
            image::RgbaImage::from_raw(icon.width, icon.height, icon.rgba.clone())
                .expect("尺寸与像素数不符")
                .save(dir.join(file))
                .unwrap();
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for item in spec.split(';').filter(|item| !item.trim().is_empty()) {
            let (name, value) = item.split_once('=').expect("项要写成 名字=原值");
            let shortcut = parse_user_shortcut(value).unwrap_or_else(|| panic!("{name}: 值不合法"));
            let icon = match shortcut.kind {
                ShortcutKind::Web => runtime.block_on(web::icon(&shortcut.path)),
                _ => {
                    let path = shortcut.path.clone();
                    let prefill = std::thread::spawn(move || windows::prefill_icon(&path))
                        .join()
                        .unwrap();
                    if let Some(prefill) = &prefill {
                        save(prefill, format!("{name}.prefill.png"));
                    }
                    prefill.map(finish)
                }
            };
            match icon {
                Some(icon) => {
                    println!("{name}: {}x{}", icon.width, icon.height);
                    save(&icon, format!("{name}.png"));
                }
                None => println!("{name}: 没有图标"),
            }
        }
    }
}
