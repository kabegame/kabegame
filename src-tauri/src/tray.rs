// 系统托盘模块

use crate::wallpaper::{WallpaperRotator, WallpaperWindow};
use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 初始化系统托盘
/// 延迟初始化，确保窗口已经创建
pub fn setup_tray(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));

        // 创建菜单项
        let show_item = match MenuItem::with_id(&app, "show", "显示窗口", true, None::<&str>) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        let hide_item = match MenuItem::with_id(&app, "hide", "隐藏窗口", true, None::<&str>) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        let next_wallpaper_item =
            match MenuItem::with_id(&app, "next_wallpaper", "下一张壁纸", true, None::<&str>) {
                Ok(item) => item,
                Err(e) => {
                    eprintln!("创建菜单项失败: {}", e);
                    return;
                }
            };

        let debug_wallpaper_item = match MenuItem::with_id(
            &app,
            "debug_wallpaper",
            "调试：打开壁纸窗口",
            true,
            None::<&str>,
        ) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        let popup_wallpaper_item = match MenuItem::with_id(
            &app,
            "popup_wallpaper",
            "调试：弹出壁纸窗口(3秒)",
            true,
            None::<&str>,
        ) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        let popup_wallpaper_detach_item = match MenuItem::with_id(
            &app,
            "popup_wallpaper_detach",
            "调试：脱离桌面层弹出(3秒)",
            true,
            None::<&str>,
        ) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        let quit_item = match MenuItem::with_id(&app, "quit", "退出", true, None::<&str>) {
            Ok(item) => item,
            Err(e) => {
                eprintln!("创建菜单项失败: {}", e);
                return;
            }
        };

        // 创建菜单
        let menu = match Menu::with_items(
            &app,
            &[
                &show_item,
                &hide_item,
                &next_wallpaper_item,
                &debug_wallpaper_item,
                &popup_wallpaper_item,
                &popup_wallpaper_detach_item,
                &quit_item,
            ],
        ) {
            Ok(menu) => menu,
            Err(e) => {
                eprintln!("创建菜单失败: {}", e);
                return;
            }
        };

        // 创建托盘图标
        let icon = match app.default_window_icon() {
            Some(icon) => icon.clone(),
            None => {
                eprintln!("无法获取默认图标");
                return;
            }
        };

        let handle_clone1 = app.clone();
        let handle_clone2 = app.clone();
        let _tray = match TrayIconBuilder::new()
            .icon(icon)
            .menu(&menu)
            .tooltip("Kabegami")
            .on_menu_event(move |_tray, event| {
                handle_menu_event(&handle_clone1, event);
            })
            .on_tray_icon_event(move |_tray, event| {
                handle_tray_icon_event(&handle_clone2, &event);
            })
            .build(&app)
        {
            Ok(tray) => tray,
            Err(e) => {
                eprintln!("创建系统托盘失败: {}", e);
                return;
            }
        };
    });
}

/// 处理菜单事件
fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "show" => {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "hide" => {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.hide();
            }
        }
        "quit" => {
            // 优雅地退出应用
            app.exit(0);
        }
        "next_wallpaper" => {
            // 后台切换下一张壁纸，避免阻塞托盘事件线程
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let rotator = app_handle.state::<WallpaperRotator>();
                if let Err(e) = rotator.rotate() {
                    eprintln!("托盘切换下一张壁纸失败: {}", e);
                }
            });
        }
        "debug_wallpaper" => {
            // 打开一个普通可见窗口（不挂到桌面层），用于确认 WallpaperLayer 是否在渲染/收事件
            let app_handle = app.clone();
            std::thread::spawn(move || {
                if let Some(w) = app_handle.get_webview_window("wallpaper_debug") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return;
                }

                let _ = WebviewWindowBuilder::new(
                    &app_handle,
                    "wallpaper_debug",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Kabegami Wallpaper Debug")
                .resizable(true)
                .decorations(true)
                .transparent(false)
                .visible(true)
                .skip_taskbar(false)
                .inner_size(900.0, 600.0)
                .build();
            });
        }
        "popup_wallpaper" => {
            // 临时把 wallpaper 窗口弹出到前台 3 秒，用于确认 wallpaper 窗口实际是否在渲染 WallpaperLayer
            let app_handle = app.clone();
            std::thread::spawn(move || {
                if let Some(w) = app_handle.get_webview_window("wallpaper") {
                    // 兜底推送一次当前壁纸到 wallpaper webview，避免因为窗口模式挂载失败导致窗口内容空白
                    // 注意：debug_push_current_to_wallpaper_windows 方法可能不存在于当前版本的 WallpaperRotator
                    // let rotator = app_handle.state::<WallpaperRotator>();
                    // let _ = rotator.debug_push_current_to_wallpaper_windows();

                    let _ = w.show();
                    let _ = w.set_always_on_top(true);
                    let _ = w.set_focus();
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = w.set_always_on_top(false);
                    // 调试弹出结束后自动隐藏，避免"看起来一直在最上层"造成误解
                    let _ = w.hide();
                } else {
                    eprintln!("wallpaper 窗口不存在，无法弹出");
                }
            });
        }
        _ => {}
    }
}

/// 处理托盘图标事件
fn handle_tray_icon_event(app: &AppHandle, event: &TrayIconEvent) {
    // 在 Windows 上，右键点击会自动显示菜单，不需要额外处理
    // 左键点击可以切换窗口显示/隐藏
    if let TrayIconEvent::Click { button, .. } = event {
        // 只在左键点击时切换窗口，右键点击会由系统自动显示菜单
        if *button == MouseButton::Left {
            if let Some(window) = app.webview_windows().values().next() {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        // 右键点击（MouseButton::Right）会由系统自动显示菜单，不需要处理
    }
}
