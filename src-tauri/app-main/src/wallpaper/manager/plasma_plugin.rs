//! Plasma 壁纸插件模式管理器：通过 kabegame 的 Plasma 壁纸插件显示壁纸，
//! 而非 org.kde.plasmashell 原生接口。支持视频壁纸和过渡效果。

use super::plasma_qdbus;
use super::WallpaperManager;
use async_trait::async_trait;
use kabegame_core::settings::Settings;
use tauri::AppHandle;

/// Plasma 壁纸插件模式管理器。
/// 所有壁纸/样式/过渡操作仅保存到 Settings，由 Plasma 插件通过 IPC 事件同步并显示。
pub struct PlasmaPluginWallpaperManager {
    _app: AppHandle,
}

impl PlasmaPluginWallpaperManager {
    pub fn new(app: AppHandle) -> Self {
        Self { _app: app }
    }

    /// 将所有桌面的 wallpaperPlugin 切换为 kabegame 插件
    fn switch_to_kabegame_plugin() -> Result<(), String> {
        let script = r#"
            var allDesktops = desktops();
            for (var i = 0; i < allDesktops.length; i++) {
                var d = allDesktops[i];
                d.wallpaperPlugin = 'org.kabegame.wallpaper';
            }
        "#;
        plasma_qdbus::run_qdbus_evaluate_script(script)
    }

    /// 将所有桌面的 wallpaperPlugin 恢复为 org.kde.image
    fn switch_to_org_kde_image() -> Result<(), String> {
        let script = r#"
            var allDesktops = desktops();
            for (var i = 0; i < allDesktops.length; i++) {
                var d = allDesktops[i];
                d.wallpaperPlugin = 'org.kde.image';
            }
        "#;
        plasma_qdbus::run_qdbus_evaluate_script(script)
    }

    /// 启动时边缘对齐：若当前为 Plasma 且设置是插件模式，但系统壁纸插件不是 Kabegame，
    /// 则自动切到 Kabegame 插件（与 Windows/macOS 窗口模式启动时自动挂载窗口一致）。
    pub fn ensure_plasma_plugin_aligned() -> Result<(), String> {
        let current = plasma_qdbus::get_current_plasma_wallpaper_plugin()
            .unwrap_or_else(|_| String::new());
        if current.trim() == "org.kabegame.wallpaper" {
            return Ok(());
        }
        Self::switch_to_kabegame_plugin()
    }
}

#[async_trait]
impl WallpaperManager for PlasmaPluginWallpaperManager {
    async fn get_style(&self) -> Result<String, String> {
        Settings::global()
            .get_wallpaper_rotation_style()
            .await
            .map_err(|e| format!("Settings error: {}", e))
    }

    async fn get_transition(&self) -> Result<String, String> {
        Settings::global()
            .get_wallpaper_rotation_transition()
            .await
            .map_err(|e| format!("Settings error: {}", e))
    }

    async fn set_style(&self, style: &str) -> Result<(), String> {
        Settings::global()
            .set_wallpaper_style(style.to_string())
            .await
            .map_err(|e| format!("Settings error: {}", e))
    }

    async fn set_transition(&self, transition: &str) -> Result<(), String> {
        Settings::global()
            .set_wallpaper_rotation_transition(transition.to_string())
            .await
            .map_err(|e| format!("Settings error: {}", e))
    }

    async fn set_wallpaper_path(&self, _file_path: &str) -> Result<(), String> {
        // 插件模式：不调用 qdbus。壁纸路径由 rotator/commands 更新 currentWallpaperImageId，
        // 触发 setting-change 事件，插件通过 IPC 获取路径并显示。
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Self::switch_to_org_kde_image()
    }

    fn refresh_desktop(&self) -> Result<(), String> {
        Ok(())
    }

    fn init(&self, _app: AppHandle) -> Result<(), String> {
        Self::switch_to_kabegame_plugin()
    }
}
