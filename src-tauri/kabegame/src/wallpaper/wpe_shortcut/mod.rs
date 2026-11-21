//! 场景快捷方式（`usershortcut`，P11d）：给场景宿主取图标、给应用页启动。
//!
//! 两个入口 [`icon`] 与 [`launch`] 共用同一组检查：图片在库里且是场景、属性在 `project.json` 里是 `usershortcut`、
//! 值只取 metadata 的 `userProperties`（用户在面板里配的，不取作者缺省值）、值能解析。图标按原值在内存里缓存。
//! 取图标与启动的平台部分在 Windows（`windows.rs`）、macOS（`mac.rs`）与 Linux（`linux.rs`），后两者共用 `unix.rs`；
//! 网址图标（`web.rs`）与透明区填色（`cv.rs`）不分平台。别的平台（没有 `wpe` 的 Android / Web 本来不编译这里）
//! [`icon`] 返回 `None`、[`launch`] 报错。

// 没有平台部分的目标上，取图标 / 启动的调用链里有一批用不到的函数
#![cfg_attr(
    not(any(windows, target_os = "macos", target_os = "linux")),
    allow(dead_code)
)]

pub mod cv;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod unix;
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

/// 本平台有没有快捷方式（取图标与启动）。没有时后端给场景宿主的快捷方式一律未绑定、面板不显示这类属性
/// （前端同规则：`WpeWebPropertiesPanel.vue`）。三个桌面平台都有。
pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos", target_os = "linux"));

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

/// 取图标。没配置、取不到、平台不支持返回 `None`；图片不是库内场景、属性类型不对报错。
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

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
async fn render(shortcut: UserShortcut) -> Option<Icon> {
    match shortcut.kind {
        ShortcutKind::Web => web::icon(&shortcut.path).await,
        _ => tauri::async_runtime::spawn_blocking(move || prefill(&shortcut).map(finish))
            .await
            .ok()
            .flatten(),
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn render(_shortcut: UserShortcut) -> Option<Icon> {
    None
}

/// 文件 / 文件夹 / 命令的图标，还没做透明区填色。在阻塞线程里调。
#[cfg(windows)]
fn prefill(shortcut: &UserShortcut) -> Option<Icon> {
    windows::prefill_icon(&shortcut.path)
}

/// 文件 / 文件夹 / 命令的图标，还没做透明区填色。在阻塞线程里调。命令取 shell 命令行里的程序。
#[cfg(target_os = "macos")]
fn prefill(shortcut: &UserShortcut) -> Option<Icon> {
    mac::prefill_icon(&unix::icon_target(shortcut))
}

/// 文件 / 文件夹 / 命令的图标，还没做透明区填色。在阻塞线程里调（按主题渲染时会等 GTK 主线程）。
#[cfg(target_os = "linux")]
fn prefill(shortcut: &UserShortcut) -> Option<Icon> {
    linux::prefill_icon(shortcut)
}

/// 启动。没配返回 `Ok(false)`，启动请求发出去了返回 `Ok(true)`；图片不是库内场景、属性类型不对、平台不支持，以及当场能知道的
/// 启动失败（目标不存在、系统打不开、程序起不来）返回给用户看的原因，由命令层经 `user-message` 通道交给前端。程序起来后很快
/// 出错退出的（拼错的命令等）事后由 `unix.rs` 经同一个通道报。
pub async fn launch(image_id: &str, name: &str) -> Result<bool, String> {
    let Some((_, shortcut)) = lookup(image_id, name).await? else {
        return Ok(false);
    };
    launch_shortcut(shortcut).await
}

/// Windows：`ShellExecuteW` 返回值 > 32 为成功。网址在这里补协议（保存时不补，见 [`web::launch_url`]）。
#[cfg(windows)]
async fn launch_shortcut(shortcut: UserShortcut) -> Result<bool, String> {
    let path = match shortcut.kind {
        ShortcutKind::Web => web::launch_url(&shortcut.path)
            .map(String::from)
            .ok_or_else(|| format!("网址不合法：{}", shortcut.path))?,
        _ => shortcut.path.clone(),
    };
    let args = shortcut.args.clone();
    let ok = tauri::async_runtime::spawn_blocking(move || windows::shell_execute(&path, &args))
        .await
        .map_err(|error| error.to_string())?;
    if ok {
        Ok(true)
    } else {
        Err(format!("系统没能打开：{}", shortcut.path))
    }
}

#[cfg(target_os = "macos")]
async fn launch_shortcut(shortcut: UserShortcut) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || mac::launch(&shortcut))
        .await
        .map_err(|error| error.to_string())?
        .map(|()| true)
}

#[cfg(target_os = "linux")]
async fn launch_shortcut(shortcut: UserShortcut) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || linux::launch(&shortcut))
        .await
        .map_err(|error| error.to_string())?
        .map(|()| true)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn launch_shortcut(_shortcut: UserShortcut) -> Result<bool, String> {
    Err("scene shortcuts can only be launched on desktop platforms".into())
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

    /// 核对用（`#[ignore]`，三个桌面平台）：按 `KB_SHORTCUT_DUMP`（`名字=原值;名字=原值`，原值是
    /// `<类型>:<路径>[|<参数>]`）取图标，跳过 metadata 检查，写成 `<KB_SHORTCUT_DUMP_DIR>/<名字>.png`；文件 / 文件夹 / 命令
    /// 另写一份透明区填色之前的 `<名字>.prefill.png`。网址项会联网。
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore]
    fn dump_shortcut_icons() {
        // Linux：按主题渲染要有人转 GTK 主上下文，本线程初始化 GTK、取图标在别的线程跑时本线程转（见 [`gtk_pump`]）
        #[cfg(target_os = "linux")]
        gtk::init().expect("初始化 GTK 失败（要有图形会话）");
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
                    let raw = gtk_pump(std::thread::spawn(move || prefill(&shortcut)));
                    if let Some(raw) = &raw {
                        save(raw, format!("{name}.prefill.png"));
                    }
                    raw.map(finish)
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

    /// 等 `handle` 结束；Linux 上等的同时转默认主上下文，让 [`linux`] 交给「主线程」的渲染在本线程执行。
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    fn gtk_pump<T>(handle: std::thread::JoinHandle<T>) -> T {
        #[cfg(target_os = "linux")]
        {
            let context = gtk::glib::MainContext::default();
            while !handle.is_finished() {
                if !context.iteration(false) {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
        handle.join().unwrap()
    }
}
