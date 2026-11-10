//! macOS 探针：`NSEvent` 的类属性读光标与左键，`+[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]`
//! 判断光标下是不是桌面。都不需要辅助功能 / 输入监控权限。
//!
//! 壁纸窗口在桌面层、`ignoresMouseEvents`，真实点击穿透给 Finder 的桌面图标窗口；这里旁路观察再注入。
//!
//! - 坐标：`NSEvent.mouseLocation` 是 Cocoa 屏幕坐标（左下原点），窗口边界取自窗口服务（CG 全局坐标，左上原点），
//!   两者用主显示器高度互换。单位都是点，等于 CEF 的视图坐标（DIP），不用再除缩放。
//! - 桌面的判定：`windowNumberAtPoint` 返回「这个位置的按下会落到哪个窗口」，会跳过点击穿透的窗口（Dock 的全屏
//!   透明窗口、水印 / 调光类覆盖层），语义同 Windows 的 `WindowFromPoint`；按窗口边界自己找最上层窗口则会被这些
//!   覆盖层挡住。命中窗口的层级不高于桌面图标层（Finder 的桌面窗口、壁纸层）即桌面；桌面小组件、程序坞、菜单栏
//!   层级更高，不算。

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    copy_window_info, kCGWindowBounds, kCGWindowLayer, kCGWindowListOptionIncludingWindow,
    CGWindowID,
};
use dispatch2::run_on_main;
use objc2_app_kit::{NSEvent, NSWindow};
use objc2_foundation::NSPoint;

use super::{DesktopProbe, Sample};

/// 每隔多少轮重新读一次壁纸窗口边界与主显示器高度（约 1 秒）：分辨率、显示器排布变化后跟上。
const GEOMETRY_REFRESH_POLLS: u32 = 60;
/// 还没查到窗口时的重试间隔（约 0.1 秒）：转发在窗口 `show()` 生效之前就启动，那时窗口服务还查不到它。
const GEOMETRY_RETRY_POLLS: u32 = 6;

/// `CGWindowLevelKey` 的 `kCGDesktopIconWindowLevelKey`。
const DESKTOP_ICON_WINDOW_LEVEL_KEY: i32 = 18;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}

/// 桌面图标层的窗口层级（Finder 的桌面窗口在这一层）。
fn desktop_icon_level() -> i64 {
    i64::from(unsafe { CGWindowLevelForKey(DESKTOP_ICON_WINDOW_LEVEL_KEY) })
}

struct WindowInfo {
    layer: i64,
    /// CG 全局坐标（左上原点，点）。
    bounds: CGRect,
}

/// 向窗口服务查一个窗口（可以属于别的应用）的层级与边界；窗口不存在时返回 `None`。
/// 只读层级与边界，不需要屏幕录制权限。
fn window_info(number: CGWindowID) -> Option<WindowInfo> {
    let list = copy_window_info(kCGWindowListOptionIncludingWindow, number)?;
    let first = list.get(0)?;
    let entry: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_get_rule(*first as CFDictionaryRef) };
    let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) };
    let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) };
    let layer = entry.find(&layer_key)?.downcast::<CFNumber>()?.to_i64()?;
    let bounds = entry.find(&bounds_key)?.downcast::<CFDictionary>()?;
    Some(WindowInfo {
        layer,
        bounds: CGRect::from_dict_representation(&bounds)?,
    })
}

/// 光标的 CG 全局坐标是否落在 `bounds` 内，以及它相对 `bounds` 左上角的视图坐标。
fn locate(bounds: &CGRect, x: f64, y: f64) -> (bool, (i32, i32)) {
    let dx = x - bounds.origin.x;
    let dy = y - bounds.origin.y;
    let inside = dx >= 0.0 && dy >= 0.0 && dx < bounds.size.width && dy < bounds.size.height;
    (inside, (dx.round() as i32, dy.round() as i32))
}

/// 命中窗口的层级是否属于桌面（不高于桌面图标层）。
fn is_desktop_layer(layer: i64, icon_level: i64) -> bool {
    layer <= icon_level
}

/// 壁纸窗口（窗口号 `window`）的探针。
pub(crate) struct MacProbe {
    window: CGWindowID,
    /// 壁纸窗口边界，CG 全局坐标。
    bounds: Option<CGRect>,
    /// 主显示器高度：Cocoa 屏幕坐标与 CG 全局坐标的 y 互换用。
    main_height: f64,
    polls: u32,
    /// 上一次采样的光标位置（Cocoa 屏幕坐标），按下沿判断桌面用。
    cursor: (f64, f64),
}

impl MacProbe {
    /// `window_number` 是 `NSWindow.windowNumber`。
    pub(crate) fn new(window_number: isize) -> Self {
        Self {
            window: window_number as CGWindowID,
            bounds: None,
            main_height: 0.0,
            polls: 0,
            cursor: (0.0, 0.0),
        }
    }
}

impl DesktopProbe for MacProbe {
    /// 窗口的生灭由 `WallpaperWindow` 管（丢弃即停止转发），这里不自行判死：窗口服务一时查不到窗口
    /// （刚建好还没显示）只是暂时没有边界，[`Self::sample`] 那几轮返回 `None`。
    fn alive(&mut self) -> bool {
        let interval = if self.bounds.is_some() {
            GEOMETRY_REFRESH_POLLS
        } else {
            GEOMETRY_RETRY_POLLS
        };
        if self.polls % interval == 0 {
            let info = window_info(self.window);
            if info.is_none() && self.bounds.is_some() {
                tracing::warn!("查不到壁纸窗口 #{}，暂停桌面鼠标转发", self.window);
            }
            self.bounds = info.map(|info| info.bounds);
            self.main_height = CGDisplay::main().bounds().size.height;
        }
        self.polls = self.polls.wrapping_add(1);
        true
    }

    fn sample(&mut self) -> Option<Sample> {
        let bounds = self.bounds.as_ref()?;
        let location = NSEvent::mouseLocation();
        self.cursor = (location.x, location.y);
        let (inside, view) = locate(bounds, location.x, self.main_height - location.y);
        Some(Sample {
            view,
            inside,
            left_down: NSEvent::pressedMouseButtons() & 1 != 0,
        })
    }

    fn over_desktop(&mut self) -> bool {
        let point = NSPoint::new(self.cursor.0, self.cursor.1);
        // 只在按下沿调用一次；AppKit 的窗口接口要在主线程上
        let hit = run_on_main(move |mtm| {
            NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(point, 0, mtm)
        });
        if hit <= 0 {
            // 这个位置没有任何窗口接收点击（没有桌面图标层时）：按桌面处理
            return true;
        }
        let hit = hit as CGWindowID;
        hit == self.window
            || window_info(hit)
                .is_some_and(|info| is_desktop_layer(info.layer, desktop_icon_level()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_graphics::geometry::{CGPoint, CGSize};

    #[test]
    fn locate_maps_global_point_to_view_coordinates() {
        // 副屏在主屏左侧：窗口原点为负
        let bounds = CGRect::new(&CGPoint::new(-1920.0, 0.0), &CGSize::new(1920.0, 1080.0));
        assert_eq!(locate(&bounds, -1920.0, 0.0), (true, (0, 0)));
        assert_eq!(locate(&bounds, -960.4, 539.6), (true, (960, 540)));
        // 右、下边界不含
        assert_eq!(locate(&bounds, 0.0, 10.0), (false, (1920, 10)));
        assert_eq!(locate(&bounds, -100.0, 1080.0), (false, (1820, 1080)));
        assert_eq!(locate(&bounds, -1921.0, 5.0), (false, (-1, 5)));
    }

    /// 对屏幕上真实存在的窗口逐个查一遍：层级与边界都要能解析出来。没有窗口服务（无界面环境）时列表为空，跳过。
    #[test]
    fn window_info_parses_every_on_screen_window() {
        use core_graphics::window::{
            kCGNullWindowID, kCGWindowListOptionOnScreenOnly, kCGWindowNumber,
        };
        let Some(list) = copy_window_info(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) else {
            return;
        };
        let number_key = unsafe { CFString::wrap_under_get_rule(kCGWindowNumber) };
        for item in list.iter() {
            let entry: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
            let number = entry
                .find(&number_key)
                .and_then(|value| value.downcast::<CFNumber>())
                .and_then(|value| value.to_i64())
                .expect("window number");
            let info = window_info(number as CGWindowID)
                .unwrap_or_else(|| panic!("window_info(#{number}) should resolve"));
            assert!(info.bounds.size.width >= 0.0 && info.bounds.size.height >= 0.0);
        }
    }

    #[test]
    fn desktop_layers_are_at_or_below_the_icon_layer() {
        let icon_level = desktop_icon_level();
        // 桌面图标层远低于普通窗口层
        assert!(icon_level < 0);
        assert!(is_desktop_layer(icon_level, icon_level));
        // 壁纸层、系统桌面图片在图标层之下
        assert!(is_desktop_layer(icon_level - 20, icon_level));
        // 桌面小组件（图标层之上）、普通窗口、程序坞、菜单栏都不算
        assert!(!is_desktop_layer(icon_level + 2, icon_level));
        assert!(!is_desktop_layer(0, icon_level));
        assert!(!is_desktop_layer(20, icon_level));
        assert!(!is_desktop_layer(24, icon_level));
    }
}
