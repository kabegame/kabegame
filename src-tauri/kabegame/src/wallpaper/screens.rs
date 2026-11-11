//! 显示器枚举：回答「现在有哪些屏、各在哪、叫什么、持久标识是什么」。
//!
//! 持久标识取平台逐屏壁纸 API 本身要的那个值（Windows 为 device interface 路径，macOS 为 display UUID），
//! 让「窗口放在哪块屏」与「原生 API 设哪块屏」用同一个 id；壁纸目标 id = `screen:<id>`
//! （`kabegame_core::settings::screen_target`）。
//!
//! 不用 Tauri 的 monitor API：kbcef runtime 的 `available_monitors()` 是启动时的一次性快照，名字为空、
//! 没有持久标识，也不随热插拔更新。
//!
//! - 在线屏存在进程内缓存里，[`screens`] 只读缓存；缓存由 [`start_watcher`] 填充并维护。
//! - watcher：平台通知只负责唤醒，真正的判断是「重新枚举一次、和缓存比」；另有 2 s 轮询兜底。
//!   快照与缓存不同后要连续 300 ms 不再变化才提交（[`Debounce`]）——接上一块屏时系统会连发几次重排。
//! - 提交时依次：换缓存 → [`WallpaperController::on_screens_changed`] → 发 [`SCREENS_CHANGE_EVENT`]。
//!
//! 目前只有 macOS 有平台实现（[`mac`]）。其余平台缓存恒为空、[`screen_at_cursor`] 恒为 None，
//! 控制器因此只会给出「所有显示器同一张」的布置。

#[cfg(target_os = "macos")]
mod mac;

/// 按屏的持久标识现查 `NSScreen`（原生逐屏壁纸 API 用）。
#[cfg(target_os = "macos")]
pub(crate) use mac::find_ns_screen;

use std::sync::RwLock;
use std::time::{Duration, Instant};

/// 在线显示器变化事件，载荷 `{ screens: ScreenInfo[] }`（变化后的完整列表，顺序同 [`screens`]）。
pub const SCREENS_CHANGE_EVENT: &str = "wallpaper-screens-change";

/// 没有平台通知时多久重新枚举一次。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// 快照与缓存不同后，要保持这么久不再变化才提交。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SETTLE: Duration = Duration::from_millis(300);

/// 一块在线的显示器。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    /// 平台持久标识：Windows 为 device interface 路径（= `IDesktopWallpaper` 的 monitorID），
    /// macOS 为 display UUID。目标 id = `screen:<id>`。
    pub id: String,
    /// 友好名（Windows DisplayConfig 的 monitorFriendlyDeviceName，macOS localizedName）；拿不到为 None
    pub name: Option<String>,
    /// 左上原点的平台桌面坐标（Windows 物理像素、macOS 点）
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 物理像素分辨率（界面上显示用）。桌面坐标的单位随平台不同，前端不自己换算。
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// 设备缩放（物理像素 / 点）；窗口模式按它换算
    pub scale: f64,
    pub primary: bool,
}

static CACHE: RwLock<Vec<ScreenInfo>> = RwLock::new(Vec::new());

/// 当前在线的屏；主屏排第一，其余按 (y, x) 排。没有屏幕信息的平台、或 [`start_watcher`] 之前返回空。
pub fn screens() -> Vec<ScreenInfo> {
    CACHE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// 光标所在的屏（托盘「下一张」用）；光标不在任何一块屏的矩形里、或没有屏幕信息时返回 None。
pub fn screen_at_cursor() -> Option<ScreenInfo> {
    let screens = screens();
    let (x, y) = cursor_position(&screens)?;
    screen_containing(&screens, x, y).cloned()
}

/// 光标位置，与 [`ScreenInfo`] 同一坐标系（左上原点的平台桌面坐标）。
#[cfg(target_os = "macos")]
fn cursor_position(screens: &[ScreenInfo]) -> Option<(f64, f64)> {
    mac::cursor(screens)
}

#[cfg(not(target_os = "macos"))]
fn cursor_position(_screens: &[ScreenInfo]) -> Option<(f64, f64)> {
    None
}

/// 读一次在线屏填进缓存，再启动 watcher。之后屏幕增减、移动、改分辨率都会更新缓存、通知控制器并发事件。
///
/// 要在壁纸控制器初始化**之前**、在主线程上调用：控制器初始化时就要按在线屏算布局，而首次枚举是同步的
/// （macOS 的 `NSScreen` 只能在主线程读）。重复调用只生效一次。没有平台实现的平台上什么都不做。
pub fn start_watcher() {
    #[cfg(target_os = "macos")]
    {
        static STARTED: std::sync::Once = std::sync::Once::new();
        STARTED.call_once(|| {
            let list = mac::enumerate();
            tracing::info!("在线显示器 {} 块: {}", list.len(), describe(&list));
            replace_cache(list);
            match std::thread::Builder::new()
                .name("wallpaper-screens".into())
                .spawn(|| watch(mac::enumerate))
            {
                // 系统的显示器重排通知只用来提前唤醒 watcher
                Ok(handle) => mac::wake_on_reconfigure(handle.thread().clone()),
                Err(e) => tracing::warn!("启动显示器 watcher 失败: {e}"),
            }
        });
    }
}

/// 换掉缓存，返回换下来的那份。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn replace_cache(list: Vec<ScreenInfo>) -> Vec<ScreenInfo> {
    std::mem::replace(
        &mut *CACHE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
        list,
    )
}

/// 日志用的一行摘要：`名字 宽x高@(x,y)`，主屏带 `*`。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn describe(screens: &[ScreenInfo]) -> String {
    screens
        .iter()
        .map(|screen| {
            format!(
                "{}{} {}x{}@({},{})",
                screen.name.as_deref().unwrap_or(&screen.id),
                if screen.primary { "*" } else { "" },
                screen.width,
                screen.height,
                screen.x,
                screen.y
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// watcher 线程本体：枚举 → 与缓存比 → 稳定后提交。线程被 `unpark` 时提前醒来再枚举一次。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn watch(enumerate: fn() -> Vec<ScreenInfo>) {
    let mut debounce = Debounce::default();
    loop {
        let wait = match debounce.observe(&screens(), enumerate(), Instant::now()) {
            Observation::Unchanged => POLL_INTERVAL,
            Observation::Pending(wait) => wait,
            Observation::Changed(list) => {
                commit(list);
                POLL_INTERVAL
            }
        };
        std::thread::park_timeout(wait);
    }
}

/// 提交一次变化：换缓存 → 控制器重算布局 → 发事件。顺序有讲究：控制器先把新接入的屏的目标补种落盘，
/// 前端收到屏幕事件时目标配置已经在了。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn commit(list: Vec<ScreenInfo>) {
    tracing::info!("在线显示器变为 {} 块: {}", list.len(), describe(&list));
    // 变化前的在线屏交给控制器：原生模式据此只给新接入的屏输出
    let previous = replace_cache(list.clone());
    if let Some(controller) = crate::wallpaper::manager::WALLPAPER_CONTROLLER.get() {
        controller.on_screens_changed(&previous);
    }
    kabegame_core::emitter::GlobalEmitter::global()
        .emit(SCREENS_CHANGE_EVENT, serde_json::json!({ "screens": list }));
}

/// 一次枚举的结论。
#[derive(Debug, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Observation {
    /// 与缓存相同
    Unchanged,
    /// 与缓存不同但还没稳定，过这么久再看
    Pending(Duration),
    /// 已稳定，提交这份
    Changed(Vec<ScreenInfo>),
}

/// 去抖：快照与缓存不同后，同一份快照要保持 [`SETTLE`] 才算数；中途又变就从新的那份重新计时，
/// 变回缓存的样子就当什么都没发生。
#[derive(Default)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Debounce {
    candidate: Option<(Vec<ScreenInfo>, Instant)>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Debounce {
    fn observe(
        &mut self,
        current: &[ScreenInfo],
        snapshot: Vec<ScreenInfo>,
        now: Instant,
    ) -> Observation {
        if snapshot == current {
            self.candidate = None;
            return Observation::Unchanged;
        }
        if let Some((candidate, since)) = &self.candidate {
            if *candidate == snapshot {
                let elapsed = now.saturating_duration_since(*since);
                if elapsed < SETTLE {
                    return Observation::Pending(SETTLE - elapsed);
                }
                self.candidate = None;
                return Observation::Changed(snapshot);
            }
        }
        self.candidate = Some((snapshot, now));
        Observation::Pending(SETTLE)
    }
}

/// 排成对外的顺序：主屏第一，其余按 (y, x)。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sort_screens(screens: &mut [ScreenInfo]) {
    screens.sort_by_key(|screen| (!screen.primary, screen.y, screen.x));
}

/// 点 (x, y) 落在哪块屏的矩形里；右、下边界不含。
pub(crate) fn screen_containing(screens: &[ScreenInfo], x: f64, y: f64) -> Option<&ScreenInfo> {
    screens.iter().find(|screen| {
        let dx = x - f64::from(screen.x);
        let dy = y - f64::from(screen.y);
        dx >= 0.0 && dy >= 0.0 && dx < f64::from(screen.width) && dy < f64::from(screen.height)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(id: &str, primary: bool, x: i32, y: i32, width: u32, height: u32) -> ScreenInfo {
        ScreenInfo {
            id: id.to_string(),
            name: None,
            x,
            y,
            width,
            height,
            pixel_width: width,
            pixel_height: height,
            scale: 1.0,
            primary,
        }
    }

    fn ids(screens: &[ScreenInfo]) -> Vec<&str> {
        screens.iter().map(|screen| screen.id.as_str()).collect()
    }

    #[test]
    fn primary_sorts_first_then_by_row_and_column() {
        let mut screens = vec![
            screen("right", false, 1920, 0, 1920, 1080),
            screen("below", false, 0, 1080, 1920, 1080),
            screen("left", false, -1920, 0, 1920, 1080),
            screen("main", true, 0, 0, 1920, 1080),
            screen("above", false, 0, -1080, 1920, 1080),
        ];
        sort_screens(&mut screens);
        assert_eq!(ids(&screens), ["main", "above", "left", "right", "below"]);
    }

    #[test]
    fn sorting_without_a_primary_is_plain_row_column_order() {
        let mut screens = vec![
            screen("b", false, 100, 0, 10, 10),
            screen("a", false, 0, 0, 10, 10),
        ];
        sort_screens(&mut screens);
        assert_eq!(ids(&screens), ["a", "b"]);
    }

    #[test]
    fn point_hits_the_screen_whose_rect_contains_it() {
        let screens = [
            screen("main", true, 0, 0, 1512, 982),
            screen("left", false, -1440, 82, 1440, 900),
        ];
        let hit = |x, y| screen_containing(&screens, x, y).map(|screen| screen.id.as_str());
        assert_eq!(hit(0.0, 0.0), Some("main"));
        assert_eq!(hit(1511.9, 981.9), Some("main"));
        // 负坐标的屏
        assert_eq!(hit(-1440.0, 82.0), Some("left"));
        assert_eq!(hit(-0.5, 500.0), Some("left"));
        // 右、下边界不含
        assert_eq!(hit(1512.0, 10.0), None);
        assert_eq!(hit(10.0, 982.0), None);
        // 两块屏高低错开留下的空角
        assert_eq!(hit(-100.0, 10.0), None);
        assert_eq!(screen_containing(&[], 0.0, 0.0), None);
    }

    #[test]
    fn unchanged_snapshot_is_ignored() {
        let current = [screen("a", true, 0, 0, 10, 10)];
        let mut debounce = Debounce::default();
        assert_eq!(
            debounce.observe(&current, current.to_vec(), Instant::now()),
            Observation::Unchanged
        );
    }

    #[test]
    fn change_commits_only_after_it_settles() {
        let current = [screen("a", true, 0, 0, 10, 10)];
        let next = vec![current[0].clone(), screen("b", false, 10, 0, 10, 10)];
        let start = Instant::now();
        let mut debounce = Debounce::default();
        assert_eq!(
            debounce.observe(&current, next.clone(), start),
            Observation::Pending(SETTLE)
        );
        // 提前醒来（系统通知连发）：只等剩下的时间
        let early = Duration::from_millis(100);
        assert_eq!(
            debounce.observe(&current, next.clone(), start + early),
            Observation::Pending(SETTLE - early)
        );
        assert_eq!(
            debounce.observe(&current, next.clone(), start + SETTLE),
            Observation::Changed(next.clone())
        );
        // 提交后调用方换了缓存，同一份快照不再算变化
        assert_eq!(
            debounce.observe(&next, next.clone(), start + SETTLE),
            Observation::Unchanged
        );
    }

    #[test]
    fn a_different_snapshot_restarts_the_wait() {
        let current = [screen("a", true, 0, 0, 10, 10)];
        let first = vec![current[0].clone(), screen("b", false, 10, 0, 10, 10)];
        // 同一块屏，系统先报了临时位置再挪到最终位置
        let second = vec![current[0].clone(), screen("b", false, -10, 0, 10, 10)];
        let start = Instant::now();
        let mut debounce = Debounce::default();
        debounce.observe(&current, first, start);
        let later = start + Duration::from_millis(250);
        assert_eq!(
            debounce.observe(&current, second.clone(), later),
            Observation::Pending(SETTLE)
        );
        assert_eq!(
            debounce.observe(&current, second.clone(), later + SETTLE),
            Observation::Changed(second)
        );
    }

    #[test]
    fn reverting_before_settling_drops_the_change() {
        let current = [screen("a", true, 0, 0, 10, 10)];
        let start = Instant::now();
        let mut debounce = Debounce::default();
        debounce.observe(&current, Vec::new(), start);
        assert_eq!(
            debounce.observe(
                &current,
                current.to_vec(),
                start + Duration::from_millis(100)
            ),
            Observation::Unchanged
        );
        // 之后再出现同一份变化要重新等满
        assert_eq!(
            debounce.observe(&current, Vec::new(), start + SETTLE),
            Observation::Pending(SETTLE)
        );
    }

    #[test]
    fn screen_info_serializes_as_camel_case() {
        let value = serde_json::to_value(screen("a", true, 0, 0, 10, 20)).unwrap();
        assert_eq!(value["pixelWidth"], 10);
        assert_eq!(value["pixelHeight"], 20);
        assert_eq!(value["primary"], true);
    }
}
