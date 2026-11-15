//! macOS 探针：`NSEvent` 的类属性读光标与左键，`+[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]`
//! 判断光标下是不是桌面。都不需要辅助功能 / 输入监控权限。
//!
//! 壁纸窗口在桌面层、`ignoresMouseEvents`，真实点击穿透给 Finder 的桌面图标窗口；这里旁路观察再由使用方注入。
//!
//! - 坐标：`NSEvent.mouseLocation` 是 Cocoa 屏幕坐标（左下原点），换成 CG 全局坐标（左上原点）后减去窗口**内容区**
//!   的左上角得视图坐标；两种坐标用主显示器高度互换。单位都是点，等于 CEF 的视图坐标（DIP），不用再除缩放。
//! - 内容区 = 窗口框 − 内缩。窗口框每次采样都向窗口服务现查（`kCGWindowBounds`，拖动、缩放中也是实时的，
//!   一次约 0.1 ms、不上主线程），同 Windows 每次采样现算 `ScreenToClient`；只按周期刷新会让拖动窗口时
//!   落点停在旧位置。内缩（原生标题栏等）只在样式变化（如进出全屏）时才变，按周期在主线程上读一次
//!   `NSWindow` 的 `contentRectForFrameRect(frame)`。不能直接拿窗口框当内容区：带原生标题栏的窗口（主窗口）
//!   会让视图坐标多出一个标题栏高度、命中点比光标偏下。
//! - 桌面的判定：`windowNumberAtPoint` 返回「这个位置的按下会落到哪个窗口」，会跳过点击穿透的窗口（Dock 的全屏
//!   透明窗口、水印 / 调光类覆盖层），语义同 Windows 的 `WindowFromPoint`；按窗口边界自己找最上层窗口则会被这些
//!   覆盖层挡住。命中窗口的层级不高于桌面图标层（Finder 的桌面窗口、壁纸层）即桌面；桌面小组件、程序坞、菜单栏
//!   层级更高，不算。

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::window::{
    copy_window_info, kCGWindowBounds, kCGWindowLayer, kCGWindowListOptionIncludingWindow,
    CGWindowID,
};
use dispatch2::run_on_main;
use objc2_app_kit::{NSApplication, NSEvent, NSWindow};
use objc2_foundation::{NSPoint, NSRect};

use super::NativeWindow;
use crate::hub::{Probe, Sample};

/// 每隔多少轮重新读一次内容区内缩与主显示器高度（约 1 秒）：进出全屏、分辨率、显示器排布变化后跟上。
/// 窗口框不在此列，每轮都现查。
const GEOMETRY_REFRESH_POLLS: u32 = 60;
/// 还没查到窗口时的重试间隔（约 0.1 秒）：订阅在窗口 `show()` 生效之前就可能开始，那时窗口服务还查不到它。
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

/// 向窗口服务查一个窗口（可以属于别的应用）的描述字典；窗口不存在时返回 `None`。
/// 只读层级与边界，不需要屏幕录制权限。
fn window_entry(number: CGWindowID) -> Option<CFDictionary<CFString, CFType>> {
    let list = copy_window_info(kCGWindowListOptionIncludingWindow, number)?;
    let first = list.get(0)?;
    Some(unsafe { CFDictionary::wrap_under_get_rule(*first as CFDictionaryRef) })
}

/// 窗口的层级。
fn window_layer(number: CGWindowID) -> Option<i64> {
    let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) };
    window_entry(number)?
        .find(&layer_key)?
        .downcast::<CFNumber>()?
        .to_i64()
}

/// 窗口框（含标题栏），CG 全局坐标（左上原点，点）。窗口服务维护，拖动中也是当前位置。
fn window_frame(number: CGWindowID) -> Option<CGRect> {
    let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) };
    let bounds = window_entry(number)?
        .find(&bounds_key)?
        .downcast::<CFDictionary>()?;
    CGRect::from_dict_representation(&bounds)
}

/// 内容区相对窗口框四边的内缩（点，CG 方向：`top` 是上边）。原生标题栏只有 `top`。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Insets {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Insets {
    /// 由 Cocoa 坐标（左下原点）的窗口框与内容区算内缩：Cocoa 的 y 向上，上内缩看两者顶边之差。
    fn between(frame: NSRect, content: NSRect) -> Self {
        Self {
            left: content.origin.x - frame.origin.x,
            top: (frame.origin.y + frame.size.height) - (content.origin.y + content.size.height),
            right: (frame.origin.x + frame.size.width) - (content.origin.x + content.size.width),
            bottom: content.origin.y - frame.origin.y,
        }
    }

    /// CG 坐标的窗口框内缩成内容区。
    fn apply(&self, frame: &CGRect) -> CGRect {
        CGRect::new(
            &CGPoint::new(frame.origin.x + self.left, frame.origin.y + self.top),
            &CGSize::new(
                frame.size.width - self.left - self.right,
                frame.size.height - self.top - self.bottom,
            ),
        )
    }
}

/// 本应用窗口（窗口号 `number`）内容区相对窗口框的内缩；不是本应用的窗口时 `None`。
/// 内容区就是 CEF 浏览器视图：它的左上角是视图坐标原点。AppKit 的窗口接口要在主线程上。
fn content_insets(number: CGWindowID) -> Option<Insets> {
    run_on_main(move |mtm| {
        let window =
            NSApplication::sharedApplication(mtm).windowWithWindowNumber(number as isize)?;
        let frame = window.frame();
        Some(Insets::between(
            frame,
            window.contentRectForFrameRect(frame),
        ))
    })
}

/// 光标的 CG 全局坐标是否落在 `bounds` 内，以及它相对 `bounds` 左上角的视图坐标（不取整）。
fn locate(bounds: &CGRect, x: f64, y: f64) -> (bool, (f64, f64)) {
    let dx = x - bounds.origin.x;
    let dy = y - bounds.origin.y;
    let inside = dx >= 0.0 && dy >= 0.0 && dx < bounds.size.width && dy < bounds.size.height;
    (inside, (dx, dy))
}

/// 命中窗口的层级是否属于桌面（不高于桌面图标层）。
fn is_desktop_layer(layer: i64, icon_level: i64) -> bool {
    layer <= icon_level
}

/// 窗口（窗口号 `window`）的探针。
pub(crate) struct MacProbe {
    window: CGWindowID,
    /// 内容区相对窗口框的内缩，按周期刷新；还没查到窗口时为 `None`。
    insets: Option<Insets>,
    /// 主显示器高度：Cocoa 屏幕坐标与 CG 全局坐标的 y 互换用。
    main_height: f64,
    polls: u32,
    /// 上一次采样的光标位置（Cocoa 屏幕坐标），按下沿判断桌面用。
    cursor: (f64, f64),
}

impl MacProbe {
    /// `window_number` 是 `NSWindow.windowNumber`。
    pub(crate) fn new(window_number: NativeWindow) -> Self {
        Self {
            window: window_number as CGWindowID,
            insets: None,
            main_height: 0.0,
            polls: 0,
            cursor: (0.0, 0.0),
        }
    }
}

impl Probe for MacProbe {
    /// 窗口的生灭由使用方管（丢弃订阅即停止），这里不自行判死：一时查不到窗口
    /// （刚建好还没显示）只是暂时没有内缩，[`Self::sample`] 那几轮返回 `None`。
    fn alive(&mut self) -> bool {
        let interval = if self.insets.is_some() {
            GEOMETRY_REFRESH_POLLS
        } else {
            GEOMETRY_RETRY_POLLS
        };
        if self.polls % interval == 0 {
            self.main_height = CGDisplay::main().bounds().size.height;
            let insets = content_insets(self.window);
            if insets.is_none() && self.insets.is_some() {
                tracing::warn!("查不到窗口 #{}，暂停光标采样", self.window);
            }
            self.insets = insets;
        }
        self.polls = self.polls.wrapping_add(1);
        true
    }

    fn sample(&mut self) -> Option<Sample> {
        let insets = self.insets?;
        // 窗口框每轮现查：拖动、缩放窗口时落点跟着走
        let bounds = insets.apply(&window_frame(self.window)?);
        let location = NSEvent::mouseLocation();
        self.cursor = (location.x, location.y);
        let (inside, view) = locate(&bounds, location.x, self.main_height - location.y);
        Some(Sample {
            view,
            inside,
            left_down: NSEvent::pressedMouseButtons() & 1 != 0,
        })
    }

    fn over_desktop(&mut self) -> bool {
        let hit = window_number_at(self.cursor);
        if hit <= 0 {
            // 这个位置没有任何窗口接收点击（没有桌面图标层时）：按桌面处理
            return true;
        }
        let hit = hit as CGWindowID;
        hit == self.window
            || window_layer(hit).is_some_and(|layer| is_desktop_layer(layer, desktop_icon_level()))
    }

    // TODO:[WPE_SCENE] macOS 未实测
    fn over_window(&mut self) -> bool {
        window_number_at(self.cursor) == self.window as isize
    }
}

/// Cocoa 屏幕坐标处「按下会落到哪个窗口」的窗口号（会跳过点击穿透的窗口）；没有窗口时不大于 0。
/// 只在按下沿调用一次；AppKit 的窗口接口要在主线程上。
fn window_number_at(cursor: (f64, f64)) -> isize {
    let point = NSPoint::new(cursor.0, cursor.1);
    run_on_main(move |mtm| NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(point, 0, mtm))
}

// TODO:[WPE_SCENE] macOS 未实测
/// 取窗口的 `NSWindow.windowNumber`（要上主线程读，同 `wallpaper/window_mount_macos.rs`）。
pub fn native_window<R: tauri::Runtime>(window: &tauri::Window<R>) -> Option<NativeWindow> {
    let ptr = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        Ok(_) => return None,
        Err(error) => {
            tracing::debug!("取 NSWindow 句柄失败: {error}");
            return None;
        }
    };
    // 用 usize 中转，使闭包只捕获 Send 类型
    let addr = ptr as usize;
    Some(run_on_main(move |_| {
        let ns_window: &NSWindow = unsafe { &*(addr as *mut std::ffi::c_void).cast() };
        ns_window.windowNumber()
    }))
}

// TODO:[WPE_SCENE] macOS 未实测
/// 一次性取光标在窗口里的视图坐标（点，可越界）：窗口框、内缩与主显示器高度现查。
/// 会同步等主线程：只在异步命令或不持锁处调用。
pub fn position_in_window(native: NativeWindow) -> Option<(f64, f64)> {
    let number = native as CGWindowID;
    let insets = content_insets(number)?;
    let bounds = insets.apply(&window_frame(number)?);
    let main_height = CGDisplay::main().bounds().size.height;
    let location = NSEvent::mouseLocation();
    Some(locate(&bounds, location.x, main_height - location.y).1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_bar_inset_moves_the_view_origin_down() {
        use objc2_foundation::NSSize;
        // 窗口框 1200×800、原生标题栏 32pt：Cocoa 里内容区和框底边对齐、高 768
        let frame = NSRect::new(NSPoint::new(-140.0, 139.0), NSSize::new(1200.0, 800.0));
        let content = NSRect::new(NSPoint::new(-140.0, 139.0), NSSize::new(1200.0, 768.0));
        let insets = Insets::between(frame, content);
        assert_eq!(
            insets,
            Insets {
                left: 0.0,
                top: 32.0,
                right: 0.0,
                bottom: 0.0
            }
        );
        // 窗口服务给的框（CG，左上原点）在 (-140, 43)：内容区左上角在 (-140, 75)
        let cg_frame = CGRect::new(&CGPoint::new(-140.0, 43.0), &CGSize::new(1200.0, 800.0));
        let view = insets.apply(&cg_frame);
        assert_eq!((view.origin.x, view.origin.y), (-140.0, 75.0));
        assert_eq!((view.size.width, view.size.height), (1200.0, 768.0));
        // 光标在标题栏下沿：视图坐标 y 是 0，不是 32
        assert_eq!(locate(&view, 0.0, 75.0), (true, (140.0, 0.0)));
        // 没有标题栏的窗口（壁纸窗口）内缩全 0，内容区就是窗口框
        let bare = Insets::between(frame, frame);
        let bare_view = bare.apply(&cg_frame);
        assert_eq!(
            (
                bare_view.origin.x,
                bare_view.origin.y,
                bare_view.size.width,
                bare_view.size.height
            ),
            (-140.0, 43.0, 1200.0, 800.0)
        );
    }

    #[test]
    fn locate_maps_global_point_to_view_coordinates() {
        // 副屏在主屏左侧：窗口原点为负
        let bounds = CGRect::new(&CGPoint::new(-1920.0, 0.0), &CGSize::new(1920.0, 1080.0));
        assert_eq!(locate(&bounds, -1920.0, 0.0), (true, (0.0, 0.0)));
        assert_eq!(locate(&bounds, -960.4, 539.6), (true, (959.6, 539.6)));
        // 右、下边界不含
        assert_eq!(locate(&bounds, 0.0, 10.0), (false, (1920.0, 10.0)));
        assert_eq!(locate(&bounds, -100.0, 1080.0), (false, (1820.0, 1080.0)));
        assert_eq!(locate(&bounds, -1921.0, 5.0), (false, (-1.0, 5.0)));
    }

    /// 对屏幕上真实存在的窗口逐个查一遍：层级与边界都要能解析出来。没有窗口服务（无界面环境）时列表为空，跳过。
    #[test]
    fn window_layer_and_frame_parse_for_every_on_screen_window() {
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
            window_layer(number as CGWindowID)
                .unwrap_or_else(|| panic!("window_layer(#{number}) should resolve"));
            let frame = window_frame(number as CGWindowID)
                .unwrap_or_else(|| panic!("window_frame(#{number}) should resolve"));
            assert!(frame.size.width >= 0.0 && frame.size.height >= 0.0);
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
