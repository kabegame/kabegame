//! macOS 的显示器枚举。
//!
//! - 列表来自 `NSScreen.screens`（只能在主线程读，经 `run_on_main` 派过去）：`frame`、`backingScaleFactor`、
//!   `localizedName`，以及 `deviceDescription["NSScreenNumber"]` 给出的 `CGDirectDisplayID`。
//! - 持久标识是 `CGDisplayCreateUUIDFromDisplayID` 的 UUID 字符串：`CGDirectDisplayID` 重启、重新接入后会变，
//!   UUID 对同一块真实显示器不变，`NSWorkspace` 逐屏设壁纸时也按屏对得上。
//! - 坐标：`NSScreen.frame` 是 Cocoa 屏幕坐标（主屏左下为原点、y 向上），这里翻成左上原点、y 向下的点坐标，
//!   与窗口服务的 CG 全局坐标一致（`input_forward/mac.rs` 用的是同一种换算）。
//! - 主屏指原点所在、带菜单栏的那块（`CGMainDisplayID`），不是 `NSScreen.mainScreen`（那是键盘焦点所在的屏）。

use std::ffi::c_void;
use std::sync::OnceLock;
use std::thread::Thread;

use core_foundation::base::{CFRelease, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::{
    CGDirectDisplayID, CGDisplay, CGDisplayRegisterReconfigurationCallback,
};
use dispatch2::run_on_main;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSScreen};
use objc2_foundation::{ns_string, NSNumber};

use super::{sort_screens, ScreenInfo};

/// `CGDisplayChangeSummaryFlags` 的 `kCGDisplayBeginConfigurationFlag`：重排开始前的那一次回调。
const BEGIN_CONFIGURATION_FLAG: u32 = 1;

#[link(name = "ColorSync", kind = "framework")]
extern "C" {
    /// 返回 `CFUUIDRef`（Create 规则，调用方释放）；该显示器没有 UUID 时为空。
    fn CGDisplayCreateUUIDFromDisplayID(display: CGDirectDisplayID) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFUUIDCreateString(allocator: *const c_void, uuid: *const c_void) -> CFStringRef;
}

/// 一块屏在 Cocoa 屏幕坐标下的原始数据（点；原点在主屏左下，y 向上）。
#[derive(Debug, Clone, PartialEq)]
struct CocoaScreen {
    /// display UUID；拿不到的屏不进列表
    id: String,
    name: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    main: bool,
}

/// 显示器的 UUID 字符串（大写、带连字符）。
fn display_uuid(display: CGDirectDisplayID) -> Option<String> {
    unsafe {
        let uuid = CGDisplayCreateUUIDFromDisplayID(display);
        if uuid.is_null() {
            return None;
        }
        let string = CFUUIDCreateString(std::ptr::null(), uuid);
        CFRelease(uuid);
        if string.is_null() {
            return None;
        }
        Some(CFString::wrap_under_create_rule(string).to_string())
    }
}

/// 一块 `NSScreen` 的 `CGDirectDisplayID`（`deviceDescription["NSScreenNumber"]`）。
fn display_id_of(screen: &NSScreen) -> Option<CGDirectDisplayID> {
    screen
        .deviceDescription()
        .objectForKey(ns_string!("NSScreenNumber"))
        .and_then(|number| number.downcast::<NSNumber>().ok())
        .map(|number| number.unsignedIntValue())
}

/// 按持久标识（[`ScreenInfo::id`]，即 display UUID）现查 `NSScreen`；该屏不在线时为 None。
///
/// 和枚举用的是同一条「`NSScreen` → `CGDirectDisplayID` → UUID」路径，所以原生逐屏壁纸 API 落到的屏与
/// 布局里的屏一定是同一块。`NSScreen` 对象在热插拔后会失效，不要缓存，每次用时现查。
pub(crate) fn find_ns_screen(mtm: MainThreadMarker, id: &str) -> Option<Retained<NSScreen>> {
    NSScreen::screens(mtm)
        .to_vec()
        .into_iter()
        .find(|screen| display_id_of(screen).and_then(display_uuid).as_deref() == Some(id))
}

/// 在主线程上读 `NSScreen.screens`。镜像显示时一组镜像只出一块屏，与系统「显示器」排布一致。
fn read_screens(mtm: MainThreadMarker) -> Vec<CocoaScreen> {
    let main_display = CGDisplay::main().id;
    NSScreen::screens(mtm)
        .to_vec()
        .into_iter()
        .filter_map(|screen| {
            let name = screen.localizedName().to_string();
            // 变量不叫 display：tracing 的宏里 `display` 是它自己的格式化函数
            let display_id = display_id_of(&screen);
            let Some(display_id) = display_id else {
                tracing::warn!("显示器「{name}」没有 NSScreenNumber，跳过");
                return None;
            };
            let Some(id) = display_uuid(display_id) else {
                tracing::warn!("显示器「{name}」（#{display_id}）没有 UUID，跳过");
                return None;
            };
            let frame = screen.frame();
            Some(CocoaScreen {
                id,
                name,
                x: frame.origin.x,
                y: frame.origin.y,
                width: frame.size.width,
                height: frame.size.height,
                scale: screen.backingScaleFactor(),
                main: display_id == main_display,
            })
        })
        .collect()
}

/// Cocoa 屏幕坐标的 y（向上）换成左上原点的 y（向下）：两个坐标系的原点都在主屏上，只差主屏高度。
fn flip_y(main_height: f64, cocoa_y: f64) -> f64 {
    main_height - cocoa_y
}

/// 把 Cocoa 坐标下的屏列表换成对外的 [`ScreenInfo`]：翻转 Y、取整、算物理像素、排序。
fn to_screen_infos(raw: Vec<CocoaScreen>) -> Vec<ScreenInfo> {
    // 主屏的 frame 原点恒为 (0, 0)；没有标记时（理论上不会）退回原点所在的那块，再退回第一块
    let main_index = raw
        .iter()
        .position(|screen| screen.main)
        .or_else(|| {
            raw.iter()
                .position(|screen| screen.x == 0.0 && screen.y == 0.0)
        })
        .or_else(|| (!raw.is_empty()).then_some(0));
    let Some(main_index) = main_index else {
        return Vec::new();
    };
    let main_height = raw[main_index].height;
    let mut screens: Vec<ScreenInfo> = raw
        .into_iter()
        .enumerate()
        .map(|(index, screen)| ScreenInfo {
            id: screen.id,
            name: Some(screen.name).filter(|name| !name.trim().is_empty()),
            x: screen.x.round() as i32,
            // 矩形的上边 = Cocoa 下的 y + 高度
            y: flip_y(main_height, screen.y + screen.height).round() as i32,
            width: screen.width.round() as u32,
            height: screen.height.round() as u32,
            pixel_width: (screen.width * screen.scale).round() as u32,
            pixel_height: (screen.height * screen.scale).round() as u32,
            scale: screen.scale,
            primary: index == main_index,
        })
        .collect();
    sort_screens(&mut screens);
    screens
}

/// 枚举在线屏。可以在任意线程调用（不在主线程时同步派到主线程，等它读完）。
pub(super) fn enumerate() -> Vec<ScreenInfo> {
    to_screen_infos(run_on_main(read_screens))
}

/// 光标位置，左上原点的点坐标。`NSEvent.mouseLocation` 是类属性，任意线程可读。
pub(super) fn cursor(screens: &[ScreenInfo]) -> Option<(f64, f64)> {
    // 主屏在两个坐标系里都从 y = 0 起，它的高度就是翻转用的量
    let main = screens.iter().find(|screen| screen.primary)?;
    let location = NSEvent::mouseLocation();
    Some((location.x, flip_y(f64::from(main.height), location.y)))
}

static WATCHER: OnceLock<Thread> = OnceLock::new();

/// 系统的显示器重排回调（在主线程的 run loop 上调用）：只唤醒 watcher，由它重新枚举。
unsafe extern "C" fn on_reconfigure(_display: CGDirectDisplayID, flags: u32, _user: *const c_void) {
    // 每次重排回调两轮：开始前一轮、完成后一轮。开始前那轮还读不到新状态。
    if flags & BEGIN_CONFIGURATION_FLAG != 0 {
        return;
    }
    if let Some(thread) = WATCHER.get() {
        thread.unpark();
    }
}

/// 让系统的显示器重排通知唤醒 `watcher` 线程。只登记一次；登记失败时 watcher 仍靠轮询跟上。
pub(super) fn wake_on_reconfigure(watcher: Thread) {
    if WATCHER.set(watcher).is_err() {
        return;
    }
    let error =
        unsafe { CGDisplayRegisterReconfigurationCallback(on_reconfigure, std::ptr::null()) };
    if error != 0 {
        tracing::warn!("登记显示器重排回调失败（CGError {error}），只靠轮询");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cocoa(id: &str, main: bool, x: f64, y: f64, width: f64, height: f64) -> CocoaScreen {
        CocoaScreen {
            id: id.to_string(),
            name: id.to_string(),
            x,
            y,
            width,
            height,
            scale: 2.0,
            main,
        }
    }

    fn rect(screen: &ScreenInfo) -> (i32, i32, u32, u32) {
        (screen.x, screen.y, screen.width, screen.height)
    }

    #[test]
    fn main_screen_keeps_origin_after_flip() {
        let screens = to_screen_infos(vec![cocoa("main", true, 0.0, 0.0, 1512.0, 982.0)]);
        assert_eq!(rect(&screens[0]), (0, 0, 1512, 982));
        assert!(screens[0].primary);
        assert_eq!(
            (screens[0].pixel_width, screens[0].pixel_height),
            (3024, 1964)
        );
        assert_eq!(screens[0].scale, 2.0);
    }

    #[test]
    fn y_flips_around_the_main_screen_height() {
        // Cocoa：副屏在主屏右侧、底边对齐（y = 0）、比主屏矮 → 左上坐标里它的上边在主屏上边之下
        let screens = to_screen_infos(vec![
            cocoa("main", true, 0.0, 0.0, 1512.0, 982.0),
            cocoa("right", false, 1512.0, 0.0, 1440.0, 900.0),
        ]);
        assert_eq!(rect(&screens[1]), (1512, 82, 1440, 900));

        // 副屏在主屏正上方：Cocoa 的 y = 主屏高度 → 左上坐标里 y 为负
        let screens = to_screen_infos(vec![
            cocoa("main", true, 0.0, 0.0, 1512.0, 982.0),
            cocoa("above", false, 36.0, 982.0, 1440.0, 900.0),
        ]);
        assert_eq!(rect(&screens[1]), (36, -900, 1440, 900));

        // 副屏在主屏正下方：Cocoa 的 y 为负 → 左上坐标里 y = 主屏高度
        let screens = to_screen_infos(vec![
            cocoa("main", true, 0.0, 0.0, 1512.0, 982.0),
            cocoa("below", false, 0.0, -900.0, 1440.0, 900.0),
        ]);
        assert_eq!(rect(&screens[1]), (0, 982, 1440, 900));
    }

    #[test]
    fn output_is_sorted_main_first_then_row_column() {
        // NSScreen.screens 的顺序不保证主屏在前
        let screens = to_screen_infos(vec![
            cocoa("right", false, 1512.0, 82.0, 1440.0, 900.0),
            cocoa("left", false, -1440.0, 82.0, 1440.0, 900.0),
            cocoa("main", true, 0.0, 0.0, 1512.0, 982.0),
        ]);
        let ids: Vec<&str> = screens.iter().map(|screen| screen.id.as_str()).collect();
        assert_eq!(ids, ["main", "left", "right"]);
        assert_eq!(screens.iter().filter(|screen| screen.primary).count(), 1);
    }

    #[test]
    fn falls_back_to_the_origin_screen_when_none_is_marked_main() {
        let screens = to_screen_infos(vec![
            cocoa("side", false, 1512.0, 0.0, 1440.0, 900.0),
            cocoa("origin", false, 0.0, 0.0, 1512.0, 982.0),
        ]);
        assert_eq!(screens[0].id, "origin");
        assert!(screens[0].primary);
        assert_eq!(rect(&screens[1]), (1512, 82, 1440, 900));
        assert!(to_screen_infos(Vec::new()).is_empty());
    }

    #[test]
    fn blank_name_becomes_none() {
        let mut raw = cocoa("main", true, 0.0, 0.0, 100.0, 100.0);
        raw.name = "  ".to_string();
        assert_eq!(to_screen_infos(vec![raw])[0].name, None);
    }

    #[test]
    fn cursor_flip_matches_screen_rects() {
        // Cocoa 的光标 y 从主屏下边往上数：主屏左上角是 (0, 主屏高度)
        assert_eq!(flip_y(982.0, 982.0), 0.0);
        assert_eq!(flip_y(982.0, 0.0), 982.0);
        // 在主屏上方的副屏里：Cocoa y 大于主屏高度 → 左上坐标为负
        assert_eq!(flip_y(982.0, 1082.0), -100.0);
    }

    /// 真机上核对光标换算：和窗口服务自己报的光标位置（CG 全局坐标，左上原点）是同一个点，
    /// 且落在某块屏里。光标在两次读取之间可能在动，留一点余量、重试几次。无界面环境没有屏时跳过。
    #[test]
    fn cursor_matches_window_server_location() {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let screens = to_screen_infos(read_screens(mtm));
        if screens.is_empty() {
            return;
        }
        let window_server_cursor = || {
            let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
            Some(CGEvent::new(source).ok()?.location())
        };
        let mut last = None;
        for _ in 0..5 {
            let Some(expected) = window_server_cursor() else {
                return;
            };
            let (x, y) = cursor(&screens).expect("有主屏就能换算");
            last = Some(((x, y), (expected.x, expected.y)));
            if (x - expected.x).abs() <= 2.0 && (y - expected.y).abs() <= 2.0 {
                assert!(
                    super::super::screen_containing(&screens, x, y).is_some(),
                    "光标 ({x}, {y}) 不在任何一块屏里: {screens:?}"
                );
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("光标换算与窗口服务不一致（换算值, 窗口服务）: {last:?}");
    }

    /// 真机上核对「按 id 现查 `NSScreen`」与枚举是同一种对应：每块枚举到的屏都能按 id 查回，查回的那块
    /// frame 与枚举时的相同；不存在的 id 查不到。无界面环境没有屏时跳过。
    #[test]
    fn finds_each_enumerated_screen_by_id() {
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        for raw in read_screens(mtm) {
            let found = find_ns_screen(mtm, &raw.id).expect("枚举到的屏应能按 id 查回");
            let frame = found.frame();
            assert_eq!(
                (
                    frame.origin.x,
                    frame.origin.y,
                    frame.size.width,
                    frame.size.height
                ),
                (raw.x, raw.y, raw.width, raw.height),
                "{}",
                raw.id
            );
        }
        assert!(find_ns_screen(mtm, "00000000-0000-0000-0000-000000000000").is_none());
    }

    /// 真机上读一遍：恰有一块主屏、主屏在原点、UUID 形态、屏与屏不重叠。无界面环境没有屏时跳过。
    #[test]
    fn enumerates_real_screens() {
        // 单测线程不是主线程，也没有 run loop 可以派过去；NSScreen 的这些只读属性在此直接读
        let mtm = unsafe { MainThreadMarker::new_unchecked() };
        let screens = to_screen_infos(read_screens(mtm));
        if screens.is_empty() {
            return;
        }
        assert_eq!(screens.iter().filter(|screen| screen.primary).count(), 1);
        assert!(screens[0].primary);
        assert_eq!((screens[0].x, screens[0].y), (0, 0));
        for screen in &screens {
            assert_eq!(screen.id.len(), 36, "{}", screen.id);
            assert_eq!(screen.id.matches('-').count(), 4, "{}", screen.id);
            assert!(screen.width > 0 && screen.height > 0);
            assert!(screen.scale >= 1.0);
        }
        for (index, a) in screens.iter().enumerate() {
            for b in &screens[index + 1..] {
                assert_ne!(a.id, b.id);
                let apart = a.x + a.width as i32 <= b.x
                    || b.x + b.width as i32 <= a.x
                    || a.y + a.height as i32 <= b.y
                    || b.y + b.height as i32 <= a.y;
                assert!(apart, "{a:?} 与 {b:?} 重叠");
            }
        }
    }
}
