#[cfg(target_os = "macos")]
use dispatch2::run_on_main;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowLevel, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect, NSSize};
#[cfg(target_os = "macos")]
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
use crate::wallpaper::screens::ScreenInfo;

/// 目标屏矩形：左上原点、y 向下的点坐标（[`ScreenInfo`] 的坐标系），`(x, y, width, height)`。
#[cfg(target_os = "macos")]
type TopLeftRect = (f64, f64, f64, f64);

/// 左上原点的屏矩形换成 Cocoa 屏幕坐标（主屏左下为原点、y 向上）下的 `(x, y, width, height)`：
/// 两个坐标系的原点都在主屏上，只差主屏高度（与 `screens/mac.rs` 的换算互逆）。
#[cfg(target_os = "macos")]
fn to_cocoa_frame(main_height: f64, (x, y, width, height): TopLeftRect) -> TopLeftRect {
    (x, main_height - (y + height), width, height)
}

/// 将 wallpaper WebView 窗口放到 macOS 桌面层（图标下方）并铺满 `screen`，返回窗口号
/// （`NSWindow.windowNumber`，桌面鼠标转发凭它向窗口服务查边界）。
///
/// `screen` 为 `None`（没有屏幕信息）时铺满窗口所在的屏，否则铺满指定的屏——每屏一窗时各窗口各自
/// frame 到各自的屏，不受「显示器具有单独的空间」设置影响。可以重复调用：屏的位置 / 尺寸变了之后
/// 再调一次即重新铺放。
/// 通过 dispatch2::run_on_main 保证 NSWindow 属性在主线程上设置（若已在主线程则直接执行）。
#[cfg(target_os = "macos")]
pub fn mount_to_desktop<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    screen: Option<&ScreenInfo>,
) -> Result<isize, String> {
    let ns_window_ptr = window
        .ns_window()
        .map_err(|e| format!("获取 NSWindow 句柄失败: {e}"))?;

    if ns_window_ptr.is_null() {
        return Err("NSWindow 句柄为空".to_string());
    }

    // 用 usize 中转，使闭包只捕获 Send 类型，避免 *mut c_void 跨线程约束
    let ptr_as_usize = ns_window_ptr as usize;
    let rect: Option<TopLeftRect> = screen.map(|screen| {
        (
            f64::from(screen.x),
            f64::from(screen.y),
            f64::from(screen.width),
            f64::from(screen.height),
        )
    });
    run_on_main(move |_| apply_desktop_window_props(ptr_as_usize as *mut std::ffi::c_void, rect))
}

/// 实际设置 NSWindow 属性（必须在主线程调用，由 run_on_main 保证）。
/// 与 LiveWallpaperMacOS 一致：无边框（无红绿灯）、铺满目标屏幕、桌面下层、透明、忽略鼠标。
/// 窗口忽略鼠标，真实点击穿透给 Finder 的桌面；网页 / 场景壁纸的交互由 `input_forward` 旁路观察后注入。
#[cfg(target_os = "macos")]
fn apply_desktop_window_props(
    ns_window_ptr: *mut std::ffi::c_void,
    rect: Option<TopLeftRect>,
) -> Result<isize, String> {
    const DESKTOP_WINDOW_LEVEL_MINUS_ONE: i64 = -2_147_483_623;

    let mtm = MainThreadMarker::new().ok_or("必须在主线程设置 NSWindow 属性".to_string())?;

    #[allow(unused_unsafe)]
    let window_number = unsafe {
        let ns_window: &NSWindow = &*ns_window_ptr.cast();

        // 无边框：去掉标题栏与红绿灯，与 LiveWallpaperMacOS 的 NSWindowStyleMaskBorderless 一致
        ns_window.setStyleMask(NSWindowStyleMask::Borderless);

        // 铺满目标屏幕（与 LiveWallpaperMacOS 的 visibleFrame = _targetScreen.frame 一致）：
        // 指定了屏就用它的矩形；没指定时优先用窗口所在屏，否则主屏。
        let screen_frame = match rect {
            Some(rect) => {
                // 主屏（原点所在、带菜单栏的那块）的高度；`NSScreen.screens` 的第一块就是它
                let main_height = NSScreen::screens(mtm)
                    .to_vec()
                    .first()
                    .map(|screen| screen.frame().size.height)
                    .ok_or("无法获取主屏 frame".to_string())?;
                let (x, y, width, height) = to_cocoa_frame(main_height, rect);
                NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
            }
            None => ns_window
                .screen()
                .as_ref()
                .map(|s| s.frame())
                .or_else(|| NSScreen::mainScreen(mtm).as_ref().map(|s| s.frame()))
                .ok_or("无法获取屏幕 frame".to_string())?,
        };
        ns_window.setFrame_display(screen_frame, true);

        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle;

        ns_window.setCollectionBehavior(behavior);
        ns_window.setLevel(DESKTOP_WINDOW_LEVEL_MINUS_ONE as NSWindowLevel);
        ns_window.setOpaque(false);
        ns_window.setHasShadow(false);
        ns_window.setIgnoresMouseEvents(true);

        let clear_color = NSColor::clearColor();
        ns_window.setBackgroundColor(Some(&clear_color));
        ns_window.windowNumber()
    };

    Ok(window_number)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::to_cocoa_frame;

    #[test]
    fn top_left_rect_flips_back_to_cocoa_frame() {
        // 主屏自身：两个坐标系里都从原点起
        assert_eq!(
            to_cocoa_frame(982.0, (0.0, 0.0, 1512.0, 982.0)),
            (0.0, 0.0, 1512.0, 982.0)
        );
        // 副屏在主屏右侧、顶边对齐、比主屏矮：Cocoa 下它的底边高出主屏底边 82
        assert_eq!(
            to_cocoa_frame(982.0, (1512.0, 0.0, 1440.0, 900.0)),
            (1512.0, 82.0, 1440.0, 900.0)
        );
        // 副屏在主屏正上方（左上坐标 y 为负）：Cocoa 的 y = 主屏高度
        assert_eq!(
            to_cocoa_frame(982.0, (36.0, -900.0, 1440.0, 900.0)),
            (36.0, 982.0, 1440.0, 900.0)
        );
        // 副屏在主屏正下方：Cocoa 的 y 为负
        assert_eq!(
            to_cocoa_frame(982.0, (0.0, 982.0, 1440.0, 900.0)),
            (0.0, -900.0, 1440.0, 900.0)
        );
    }
}
