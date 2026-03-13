#[cfg(target_os = "macos")]
use dispatch2::run_on_main;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior, NSWindowLevel, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use tauri::WebviewWindow;

/// 将 wallpaper WebView 窗口放到 macOS 桌面层（图标下方）。
/// 通过 dispatch2::run_on_main 保证 NSWindow 属性在主线程上设置（若已在主线程则直接执行）。
#[cfg(target_os = "macos")]
pub fn mount_to_desktop(window: &WebviewWindow) -> Result<(), String> {
    let ns_window_ptr = window
        .ns_window()
        .map_err(|e| format!("获取 NSWindow 句柄失败: {e}"))?;

    if ns_window_ptr.is_null() {
        return Err("NSWindow 句柄为空".to_string());
    }

    // 用 usize 中转，使闭包只捕获 Send 类型，避免 *mut c_void 跨线程约束
    let ptr_as_usize = ns_window_ptr as usize;
    run_on_main(move |_| apply_desktop_window_props(ptr_as_usize as *mut std::ffi::c_void))
}

/// 实际设置 NSWindow 属性（必须在主线程调用，由 run_on_main 保证）。
/// 与 LiveWallpaperMacOS 一致：无边框（无红绿灯）、铺满目标屏幕、桌面下层、透明、忽略鼠标。
#[cfg(target_os = "macos")]
fn apply_desktop_window_props(ns_window_ptr: *mut std::ffi::c_void) -> Result<(), String> {
    const DESKTOP_WINDOW_LEVEL_MINUS_ONE: i64 = -2_147_483_623;

    let mtm = MainThreadMarker::new()
        .ok_or("必须在主线程设置 NSWindow 属性".to_string())?;

    #[allow(unused_unsafe)]
    unsafe {
        let ns_window: &NSWindow = &*ns_window_ptr.cast();

        // 无边框：去掉标题栏与红绿灯，与 LiveWallpaperMacOS 的 NSWindowStyleMaskBorderless 一致
        ns_window.setStyleMask(NSWindowStyleMask::Borderless);

        // 铺满目标屏幕：优先用窗口所在屏，否则主屏（与 LiveWallpaperMacOS 的 visibleFrame = _targetScreen.frame 一致）
        let screen_frame = ns_window
            .screen()
            .as_ref()
            .map(|s| s.frame())
            .or_else(|| NSScreen::mainScreen(mtm).as_ref().map(|s| s.frame()))
            .ok_or("无法获取屏幕 frame".to_string())?;
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
    }

    Ok(())
}
