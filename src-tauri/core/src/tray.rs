// 系统托盘模块

use crate::wallpaper::WallpaperRotator;
use governor::{Quota, RateLimiter};
use std::num::NonZeroU32;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

type DefaultDirectRateLimiter = RateLimiter<
    governor::state::NotKeyed,
    governor::state::InMemoryState,
    governor::clock::DefaultClock,
    governor::middleware::NoOpMiddleware,
>;

const TRAY_CLICK_DEBOUNCE_MS: u64 = 500; // 500ms 防抖

/// 初始化系统托盘
/// 延迟初始化，确保窗口已经创建
pub fn setup_tray(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));

        // 创建防抖限流器
        let limiter = RateLimiter::direct(
            Quota::with_period(Duration::from_millis(TRAY_CLICK_DEBOUNCE_MS))
                .unwrap()
                .allow_burst(NonZeroU32::new(1).unwrap()),
        );

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

        // 仅在开发模式下创建调试菜单项
        #[cfg(debug_assertions)]
        let debug_wallpaper_item = match MenuItem::with_id(
            &app,
            "debug_wallpaper",
            "调试：打开调试窗口",
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
        #[cfg(debug_assertions)]
        let menu = match Menu::with_items(
            &app,
            &[
                &show_item,
                &hide_item,
                &next_wallpaper_item,
                &debug_wallpaper_item,
                &quit_item,
            ],
        ) {
            Ok(menu) => menu,
            Err(e) => {
                eprintln!("创建菜单失败: {}", e);
                return;
            }
        };

        #[cfg(not(debug_assertions))]
        let menu = match Menu::with_items(
            &app,
            &[&show_item, &hide_item, &next_wallpaper_item, &quit_item],
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

        // 创建托盘，明确禁止左键点击显示菜单
        let tray = match TrayIconBuilder::new()
            .icon(icon)
            .tooltip("Kabegame")
            .show_menu_on_left_click(false) // 关键：禁止左键显示菜单
            .build(&app)
        {
            Ok(tray) => tray,
            Err(e) => {
                eprintln!("创建系统托盘失败: {}", e);
                return;
            }
        };

        // 设置菜单（只在右键时显示）
        if let Err(e) = tray.set_menu(Some(menu)) {
            eprintln!("设置托盘菜单失败: {}", e);
        }

        // 处理托盘图标事件（带防抖）
        tray.on_tray_icon_event(move |tray, event| {
            handle_tray_icon_event(&handle_clone2, tray, event, &limiter);
        });

        // 处理菜单事件
        tray.on_menu_event(move |_tray, event| {
            handle_menu_event(&handle_clone1, event);
        });
    });
}

/// 恢复窗口状态
fn restore_window_state(app: &AppHandle, window: &tauri::WebviewWindow) {
    use crate::settings::Settings;
    if let Some(settings) = app.try_state::<Settings>() {
        if let Ok(Some(window_state)) = settings.get_window_state() {
            // 恢复窗口大小
            if let Err(e) = window.set_size(tauri::LogicalSize::new(
                window_state.width,
                window_state.height,
            )) {
                eprintln!("恢复窗口大小失败: {}", e);
            }
            // 恢复窗口位置
            if let (Some(x), Some(y)) = (window_state.x, window_state.y) {
                if let Err(e) = window.set_position(tauri::LogicalPosition::new(x, y)) {
                    eprintln!("恢复窗口位置失败: {}", e);
                }
            }
            // 恢复最大化状态
            if window_state.maximized {
                if let Err(e) = window.maximize() {
                    eprintln!("恢复窗口最大化状态失败: {}", e);
                }
            }
        }
    }
}

/// 处理菜单事件
fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "show" => {
            // 只显示主窗口（label 为 "main"），排除壁纸窗口
            if let Some(main_window) = app.get_webview_window("main") {
                // 恢复窗口状态
                restore_window_state(app, &main_window);
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
        }
        "hide" => {
            // 只隐藏主窗口（label 为 "main"），排除壁纸窗口
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.hide();
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
                if let Some(w) = app_handle.get_webview_window("wallpaper-debug") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return;
                }

                let _ = WebviewWindowBuilder::new(
                    &app_handle,
                    "wallpaper-debug",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Kabegame Wallpaper Debug")
                .resizable(true)
                .decorations(true)
                .transparent(false)
                .visible(true)
                .skip_taskbar(false)
                .inner_size(900.0, 600.0)
                .build();
            });
        }
        _ => {}
    }
}

/// 处理托盘图标事件
fn handle_tray_icon_event(
    app: &AppHandle,
    _tray: &tauri::tray::TrayIcon,
    event: TrayIconEvent,
    limiter: &DefaultDirectRateLimiter,
) {
    // 只处理左键按下事件（不处理释放事件，避免重复）
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Down,
        ..
    } = event
    {
        // 防抖检查：防止快速连击导致窗口状态混乱
        if limiter.check().is_err() {
            eprintln!("[托盘] 点击过快，已忽略（防抖）");
            return;
        }

        // 切换主窗口显示/隐藏
        if let Some(main_window) = app.get_webview_window("main") {
            let is_visible = main_window.is_visible().unwrap_or(false);

            if is_visible {
                let _ = main_window.hide();
            } else {
                restore_window_state(app, &main_window);
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
        }
    }
    // 右键点击会自动显示菜单（通过 set_menu 设置）
}
