// 系统托盘模块（app-main）
// 仅在非移动端平台编译

use governor::{Quota, RateLimiter};
use kabegame_i18n::t;
use std::num::NonZeroU32;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::startup;

type DefaultDirectRateLimiter = RateLimiter<
    governor::state::NotKeyed,
    governor::state::InMemoryState,
    governor::clock::DefaultClock,
    governor::middleware::NoOpMiddleware,
>;

const TRAY_ID: &str = "main";
const TRAY_CLICK_DEBOUNCE_MS: u64 = 500; // 500ms 防抖

/// 使用当前 locale 构建托盘菜单（供首次创建与语言切换后刷新共用）
fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let show_item = MenuItem::with_id(app, "show", t!("tray.showWindow"), true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {}", e))?;
    let hide_item = MenuItem::with_id(app, "hide", t!("tray.hideWindow"), true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {}", e))?;
    let next_wallpaper_item = MenuItem::with_id(
        app,
        "next_wallpaper",
        t!("tray.nextWallpaper"),
        true,
        None::<&str>,
    )
    .map_err(|e| format!("创建菜单项失败: {}", e))?;
    let quit_item = MenuItem::with_id(app, "quit", t!("tray.quit"), true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {}", e))?;

    #[cfg(debug_assertions)]
    let menu = Menu::with_items(
        app,
        &[&show_item, &hide_item, &next_wallpaper_item, &quit_item],
    )
    .map_err(|e| format!("创建菜单失败: {}", e))?;

    #[cfg(not(debug_assertions))]
    let menu = Menu::with_items(
        app,
        &[&show_item, &hide_item, &next_wallpaper_item, &quit_item],
    )
    .map_err(|e| format!("创建菜单失败: {}", e))?;

    Ok(menu)
}

/// 刷新托盘菜单与 tooltip（语言切换后由 setting-change 回调调用，与磁盘挂载等实现方式一致）
pub fn update_tray_menu(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu = build_tray_menu(app)?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("设置托盘菜单失败: {}", e))?;
    tray.set_tooltip(Some(t!("common.appName")));
    Ok(())
}

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

        let menu = match build_tray_menu(&app) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("{}", e);
                return;
            }
        };

        // 创建托盘图标
        // macOS：使用乌龟模板图（黑+alpha），随系统深色/浅色菜单栏自适应
        // 其他平台：沿用窗口默认图标
        #[cfg(target_os = "macos")]
        let icon = {
            const TURTLE_PNG: &[u8] = include_bytes!("../icons/tray/turtle-tray@2x.png");
            match tauri::image::Image::from_bytes(TURTLE_PNG) {
                Ok(img) => img,
                Err(e) => {
                    eprintln!("加载托盘图标失败: {}", e);
                    return;
                }
            }
        };
        #[cfg(not(target_os = "macos"))]
        let icon = match app.default_window_icon() {
            Some(icon) => icon.clone(),
            None => {
                eprintln!("无法获取默认图标");
                return;
            }
        };

        let handle_clone1 = app.clone();
        let handle_clone2 = app.clone();

        // 创建托盘（带 id 以便语言切换后 tray_by_id 刷新菜单），明确禁止左键点击显示菜单
        let builder = TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip(t!("common.appName"))
            .show_menu_on_left_click(false); // 关键：禁止左键显示菜单

        // macOS 菜单栏图标使用 template 模式，由系统按主题自动反色
        #[cfg(target_os = "macos")]
        let builder = builder.icon_as_template(true);

        let tray = match builder.build(&app) {
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

/// 处理菜单事件
fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "show" => {
            if let Err(e) = startup::ensure_main_window(app.clone()) {
                eprintln!("[托盘] 显示窗口失败: {}", e);
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
            tauri::async_runtime::spawn(async move {
                // 使用全局单例（不再使用 state）
                let rotator = crate::wallpaper::WallpaperRotator::global();
                if let Err(e) = rotator.rotate().await {
                    eprintln!("托盘切换下一张壁纸失败: {}", e);
                }
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

        // 左键点击托盘总是显示并激活主窗口，不再切换隐藏。
        if startup::ensure_main_window(app.clone()).is_err() {
            eprintln!("[托盘] 创建并显示窗口失败");
        }
    }
    // 右键点击会自动显示菜单（通过 set_menu 设置）
}
