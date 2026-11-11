//! Plasma 壁纸插件模式管理器：通过 kabegame 的 Plasma 壁纸插件显示壁纸，
//! 而非 org.kde.plasmashell 原生接口。支持视频壁纸和过渡效果。

use super::plasma_qdbus;
use super::{
    style_options, transition_options, DisplayMode, Placement, WallpaperManager, WallpaperOption,
};
use async_trait::async_trait;
use tauri::{AppHandle, Runtime};

/// Plasma 壁纸插件模式管理器。
/// 壁纸、样式、过渡都由调用方写进 `multiple` 目标的设置，Plasma 插件通过 IPC 事件同步并显示；
/// 本后端不输出任何东西。
pub struct PlasmaPluginWallpaperManager;

impl PlasmaPluginWallpaperManager {
    pub fn new<R: Runtime>(_app: AppHandle<R>) -> Self {
        Self
    }

    /// 将所有桌面的 wallpaperPlugin 切换为 kabegame 插件
    fn switch_to_kabegame_plugin() -> Result<(), String> {
        let id = plasma_qdbus::KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID;
        let script = format!(
            r#"
            var allDesktops = desktops();
            for (var i = 0; i < allDesktops.length; i++) {{
                var d = allDesktops[i];
                d.wallpaperPlugin = '{}';
            }}
            "#,
            id
        );
        plasma_qdbus::run_qdbus_evaluate_script(&script)
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
        let current =
            plasma_qdbus::get_current_plasma_wallpaper_plugin().unwrap_or_else(|_| String::new());
        if current.trim() == plasma_qdbus::KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID {
            return Ok(());
        }
        Self::switch_to_kabegame_plugin()
    }
}

#[async_trait]
impl WallpaperManager for PlasmaPluginWallpaperManager {
    fn supported_styles(&self, _display: DisplayMode) -> Vec<WallpaperOption> {
        style_options(&["fill", "fit", "stretch", "center", "tile"])
    }

    fn supported_transitions(&self, _display: DisplayMode) -> Vec<WallpaperOption> {
        transition_options(
            &["none", "fade", "slide", "zoom"],
            "settings.transitionNone",
        )
    }

    async fn set_wallpaper(
        &self,
        _file_path: &str,
        _style: &str,
        _transition: &str,
        _placement: &Placement,
    ) -> Result<(), String> {
        // 插件模式：不调用 qdbus。rotator / 命令把当前壁纸、样式、过渡写进目标配置，
        // 触发 setting-change 事件，插件通过 IPC 获取并显示。
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Self::switch_to_org_kde_image()
    }

    fn init(&self) -> Result<(), String> {
        Self::switch_to_kabegame_plugin()
    }
}
