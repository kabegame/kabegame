//! KDE Plasma（KWin）上查 Kabegame 主窗口在全局逻辑坐标里的位置。Wayland 不让应用知道自己的窗口在屏上哪里，KWin 的 D-Bus 能给：
//! 插件模式里桌面上的光标（Plasma 壁纸插件发来的全局坐标）要换算到主窗口里，图库预览的网页 / 场景壁纸才能跟着桌面上的光标
//! （同 Windows 的全局光标，见 `pointer_socket`）。
//!
//! - 先经 KWin 的窗口搜索（krunner 接口 `/WindowsRunner` `org.kde.krunner1.Match`）找类名或标题含 `kabegame` 的窗口拿 uuid，
//!   再 `org.kde.KWin.getWindowInfo(uuid)` 取框架几何（含窗口装饰，逻辑像素）、标题、类名、是否最小化；类名是 `kabegame`、标题是
//!   主窗口标题的那个就是主窗口，记住 uuid，之后只调 `getWindowInfo`。
//! - 只读，不改任何窗口；也不经 plasmashell（在壁纸插件里用任务管理器模型取窗口几何时 plasmashell 卡死过，2026-11-22）。
//! - KWin 不在（别的桌面环境、X11 会话也有，但不保证）或调用失败时给 `None`，主窗口就不跟桌面上的光标。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use zbus::zvariant::OwnedValue;

/// D-Bus 调用的超时：KWin 卡住时不能拖住鼠标线程。
const CALL_TIMEOUT: Duration = Duration::from_millis(300);
/// 找不到主窗口时多久再搜一次（搜索结果带窗口图标，比较大）。
const SEARCH_INTERVAL: Duration = Duration::from_secs(2);
/// 连不上 session bus 时多久再试。
const CONNECT_INTERVAL: Duration = Duration::from_secs(10);
/// Kabegame 窗口的类名（Wayland app_id / X11 WM_CLASS）。
const RESOURCE_CLASS: &str = "kabegame";

/// 窗口的框架几何（全局逻辑坐标，含装饰）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `getWindowInfo` 里用到的几项。
#[derive(Debug, Clone, PartialEq)]
struct WindowInfo {
    caption: String,
    resource_class: String,
    minimized: bool,
    geometry: Option<FrameGeometry>,
}

impl WindowInfo {
    fn from_map(map: &HashMap<String, OwnedValue>) -> Self {
        let text = |key: &str| {
            map.get(key)
                .and_then(|value| value.downcast_ref::<&str>().ok().map(str::to_string))
                .unwrap_or_default()
        };
        let number = |key: &str| map.get(key).and_then(|value| value.downcast_ref::<f64>().ok());
        let geometry = match (number("x"), number("y"), number("width"), number("height")) {
            (Some(x), Some(y), Some(width), Some(height)) if width > 0.0 && height > 0.0 => {
                Some(FrameGeometry {
                    x,
                    y,
                    width,
                    height,
                })
            }
            _ => None,
        };
        Self {
            caption: text("caption"),
            resource_class: text("resourceClass"),
            minimized: map
                .get("minimized")
                .and_then(|value| value.downcast_ref::<bool>().ok())
                .unwrap_or(false),
            geometry,
        }
    }

    /// 是不是标题为 `title` 的 Kabegame 窗口（KWin 给同名窗口的标题加 ` <2>` 之类的后缀，所以比前缀）。
    fn is_window(&self, title: &str) -> bool {
        !title.is_empty()
            && self.resource_class.eq_ignore_ascii_case(RESOURCE_CLASS)
            && self.caption.starts_with(title)
    }
}

/// 从 krunner 的匹配 id（`<动作>_{uuid}`）取窗口 uuid。
fn uuid_of_match(id: &str) -> Option<&str> {
    let (_, uuid) = id.split_once('_')?;
    (uuid.starts_with('{') && uuid.ends_with('}')).then_some(uuid)
}

/// 在 KWin 里找 Kabegame 的主窗口。不是线程安全的，给鼠标线程独占。
pub struct KwinWindowLocator {
    connection: Option<zbus::blocking::Connection>,
    last_connect: Option<Instant>,
    uuid: Option<String>,
    last_search: Option<Instant>,
}

impl KwinWindowLocator {
    pub fn new() -> Self {
        Self {
            connection: None,
            last_connect: None,
            uuid: None,
            last_search: None,
        }
    }

    fn connection(&mut self) -> Option<zbus::blocking::Connection> {
        if self.connection.is_none()
            && self
                .last_connect
                .is_none_or(|at| at.elapsed() >= CONNECT_INTERVAL)
        {
            self.last_connect = Some(Instant::now());
            match zbus::blocking::connection::Builder::session()
                .and_then(|builder| builder.method_timeout(CALL_TIMEOUT).build())
            {
                Ok(connection) => self.connection = Some(connection),
                Err(error) => tracing::debug!("连不上 session bus，主窗口不跟桌面上的光标: {error}"),
            }
        }
        self.connection.clone()
    }

    fn window_info(&mut self, uuid: &str) -> Option<WindowInfo> {
        let connection = self.connection()?;
        let reply = connection
            .call_method(
                Some("org.kde.KWin"),
                "/KWin",
                Some("org.kde.KWin"),
                "getWindowInfo",
                &(uuid,),
            )
            .ok()?;
        let map: HashMap<String, OwnedValue> = reply.body().deserialize().ok()?;
        // 窗口不在时 KWin 回空表
        (!map.is_empty()).then(|| WindowInfo::from_map(&map))
    }

    fn search(&mut self) -> Vec<String> {
        let Some(connection) = self.connection() else {
            return Vec::new();
        };
        type Match = (String, String, String, i32, f64, HashMap<String, OwnedValue>);
        let matches: Vec<Match> = match connection
            .call_method(
                Some("org.kde.KWin"),
                "/WindowsRunner",
                Some("org.kde.krunner1"),
                "Match",
                &(RESOURCE_CLASS,),
            )
            .and_then(|reply| reply.body().deserialize().map_err(Into::into))
        {
            Ok(matches) => matches,
            Err(error) => {
                tracing::debug!("KWin 的窗口搜索失败: {error}");
                return Vec::new();
            }
        };
        let mut uuids: Vec<String> = Vec::new();
        for (id, ..) in &matches {
            if let Some(uuid) = uuid_of_match(id) {
                if !uuids.iter().any(|known| known == uuid) {
                    uuids.push(uuid.to_string());
                }
            }
        }
        uuids
    }

    /// 标题为 `title` 的 Kabegame 窗口的框架几何；找不到、最小化或 KWin 不在时 `None`。
    pub fn locate(&mut self, title: &str) -> Option<FrameGeometry> {
        if let Some(uuid) = self.uuid.clone() {
            match self.window_info(&uuid) {
                Some(info) if info.is_window(title) => {
                    return if info.minimized { None } else { info.geometry };
                }
                // 窗口没了或换了标题对不上：重新找
                _ => self.uuid = None,
            }
        }
        if self
            .last_search
            .is_some_and(|at| at.elapsed() < SEARCH_INTERVAL)
        {
            return None;
        }
        self.last_search = Some(Instant::now());
        for uuid in self.search() {
            let Some(info) = self.window_info(&uuid) else {
                continue;
            };
            if info.is_window(title) {
                tracing::debug!("KWin 里的主窗口: {uuid}（{}）", info.caption);
                self.uuid = Some(uuid);
                return if info.minimized { None } else { info.geometry };
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::Value;

    fn info(entries: &[(&str, Value<'static>)]) -> WindowInfo {
        let map: HashMap<String, OwnedValue> = entries
            .iter()
            .map(|(key, value)| (key.to_string(), OwnedValue::try_from(value.clone()).unwrap()))
            .collect();
        WindowInfo::from_map(&map)
    }

    #[test]
    fn reads_the_fields_kwin_returns() {
        // 实测（KWin 6.6.4）的取值形状
        let window = info(&[
            ("caption", Value::from("遐蝶 - 画廊 - Kabegame")),
            ("resourceClass", Value::from("kabegame")),
            ("minimized", Value::from(false)),
            ("x", Value::from(776.375_785_087_852_6)),
            ("y", Value::from(470.723_676_880_105_1)),
            ("width", Value::from(1199.310_344_827_586_3)),
            ("height", Value::from(827.586_206_896_551_6)),
        ]);
        assert_eq!(
            window.geometry,
            Some(FrameGeometry {
                x: 776.375_785_087_852_6,
                y: 470.723_676_880_105_1,
                width: 1199.310_344_827_586_3,
                height: 827.586_206_896_551_6,
            })
        );
        assert!(window.is_window("遐蝶 - 画廊 - Kabegame"));
        assert!(!window.is_window("画廊 - Kabegame"), "标题要从头对上");
        assert!(!window.is_window(""));
    }

    #[test]
    fn other_apps_and_duplicate_suffixes() {
        let other = info(&[
            ("caption", Value::from("画廊 - Kabegame")),
            ("resourceClass", Value::from("code")),
        ]);
        assert!(!other.is_window("画廊 - Kabegame"));
        let duplicate = info(&[
            ("caption", Value::from("画廊 - Kabegame <2>")),
            ("resourceClass", Value::from("kabegame")),
        ]);
        assert!(duplicate.is_window("画廊 - Kabegame"));
        assert_eq!(duplicate.geometry, None, "缺几何字段时没有几何");
    }

    #[test]
    fn uuid_from_match_ids() {
        assert_eq!(
            uuid_of_match("0_{2bbce072-a129-4f19-bcf4-f1a1c06bd0d8}"),
            Some("{2bbce072-a129-4f19-bcf4-f1a1c06bd0d8}")
        );
        assert_eq!(uuid_of_match("desktop"), None);
        assert_eq!(uuid_of_match("1_notauuid"), None);
    }
}
