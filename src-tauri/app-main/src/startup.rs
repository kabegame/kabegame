// 启动步骤函数

use std::fs;
use tauri::{Listener, Manager};

use crate::commands::wallpaper::init_wallpaper_on_startup;
use crate::wallpaper::manager::WallpaperController;
use crate::wallpaper::WallpaperRotator;
#[cfg(target_os = "windows")]
use crate::wallpaper::WallpaperWindow;

pub fn startup_step_cleanup_user_data_if_marked(app: &tauri::AppHandle) -> bool {
    // 检查清理标记，如果存在则先清理旧数据目录
    let app_data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to resolve app data dir: {e}");
            return false;
        }
    };
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    let is_cleaning_data = cleanup_marker.exists();
    if is_cleaning_data {
        // 删除标记文件
        let _ = fs::remove_file(&cleanup_marker);
        // 尝试删除整个数据目录
        if app_data_dir.exists() {
            // 使用多次重试，因为文件可能还在被其他进程使用
            let mut retries = 5;
            while retries > 0 {
                match fs::remove_dir_all(&app_data_dir) {
                    Ok(_) => {
                        println!("成功清理应用数据目录");
                        break;
                    }
                    Err(e) => {
                        retries -= 1;
                        if retries == 0 {
                            eprintln!("警告：无法完全清理数据目录，部分文件可能仍在使用中: {}", e);
                            // 尝试删除单个文件而不是整个目录
                            // 至少删除数据库和设置文件
                            let _ = fs::remove_file(app_data_dir.join("images.db"));
                            let _ = fs::remove_file(app_data_dir.join("settings.json"));
                            let _ = fs::remove_file(app_data_dir.join("plugins.json"));
                        } else {
                            // 等待一段时间后重试
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                    }
                }
            }
        }
    }
    is_cleaning_data
}

pub fn startup_step_restore_main_window_state(app: &tauri::AppHandle, is_cleaning_data: bool) {
    // 不恢复 window_state：用户要求每次居中弹出
    if is_cleaning_data {
        return;
    }
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.center();
    }
}

pub fn startup_step_manage_wallpaper_components(app: &mut tauri::App) {
    // 初始化全局壁纸控制器（基础 manager）
    // 使用全局单例（不再使用 manage）
    if let Err(e) = WallpaperController::init_global(app.app_handle().clone()) {
        eprintln!("Failed to initialize WallpaperController: {}", e);
        return;
    }

    // 初始化壁纸轮播器
    // 使用全局单例（不再使用 manage）
    if let Err(e) = WallpaperRotator::init_global(app.app_handle().clone()) {
        eprintln!("Failed to initialize WallpaperRotator: {}", e);
        return;
    }

    // 创建壁纸窗口（用于窗口模式）
    #[cfg(target_os = "windows")]
    {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(
            app,
            "wallpaper",
            // 使用独立的 wallpaper.html，只渲染 WallpaperLayer 组件
            WebviewUrl::App("wallpaper.html".into()),
        )
        // 给壁纸窗口一个固定标题，便于脚本/调试定位到正确窗口
        .title("Kabegame Wallpaper")
        .fullscreen(true)
        .decorations(false)
        // 设置窗口为透明，背景为透明
        .transparent(true)
        .visible(false)
        .skip_taskbar(true)
        .build();
    }

    // 创建系统托盘（使用 Tauri 2.0 内置 API）
    #[cfg(feature = "tray")]
    {
        crate::tray::setup_tray(app.app_handle().clone());
    }

    tauri::async_runtime::spawn(async move {
        // 初始化壁纸控制器（如创建窗口等）
        if let Err(e) = WallpaperController::global().init() {
            eprintln!("[WARN] Failed to initialize wallpaper controller: {}", e);
        }

        if let Err(e) = init_wallpaper_on_startup().await {
            eprintln!("[WARN] init_wallpaper_on_startup failed: {}", e);
        }
    });
}
