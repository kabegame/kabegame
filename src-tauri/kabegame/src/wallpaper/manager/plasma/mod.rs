//! Plasma 壁纸插件模式管理器：Kabegame 自己渲染壁纸（离屏壁纸窗口），每一帧经 PipeWire 推给 Kabegame 的
//! Plasma 壁纸插件显示；插件只读流、不渲染内容。见 `.claude/plans/plasma-pipewire/README.md`。
//!
//! 切到插件模式（`init`）与启动对齐（[`ensure_plasma_plugin_aligned`]）前先确保插件装好且不旧（[`install`]），切换时
//! 把各桌面的配置项 `General/Entry` 写成生效那份的内容文件：插件刚升级时 plasmashell 不用重启就换到新修订。

pub mod install;
pub mod kwin_window;
pub mod pipewire;
pub mod qdbus;

use super::{
    DisplayMode, Placement, WallpaperManager, WallpaperOption, WindowAssignment,
    WindowWallpaperManager,
};
use async_trait::async_trait;
use tauri::{AppHandle, Runtime};

/// Plasma 壁纸插件模式管理器：包一层窗口后端（壁纸窗口在 Linux 上是离屏 browser + PipeWire 流，
/// 见 [`WindowWallpaperManager`]），另外负责切换各桌面的 Plasma 壁纸插件。
///
/// 壁纸内容、样式、过渡与窗口模式一样由壁纸页面按自己的布置渲染，本后端不经 qdbus 推壁纸。
pub struct PlasmaPluginWallpaperManager<R: Runtime> {
    window: WindowWallpaperManager<R>,
}

impl<R: Runtime> PlasmaPluginWallpaperManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            window: WindowWallpaperManager::new(app, "plasma-plugin"),
        }
    }
}

/// 内容文件名只能是字母、数字、`.`、`_`、`-`（要拼进脚本）。
fn is_safe_entry(entry: &str) -> bool {
    !entry.is_empty()
        && entry
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 各桌面换成 Kabegame 插件的脚本：已经是的不动插件；`entry` 非空时把配置项 `General/Entry` 写成它（插件的壳按它加载内容，
/// 值变了就换到新修订）。
fn kabegame_plugin_script(entry: &str) -> String {
    let id = qdbus::KABEGAME_PLASMA_WALLPAPER_PLUGIN_ID;
    let write_entry = if is_safe_entry(entry) {
        format!(
            "d.currentConfigGroup = ['Wallpaper', '{id}', 'General']; d.writeConfig('Entry', '{entry}');"
        )
    } else {
        String::new()
    };
    format!(
        r#"
        var allDesktops = desktops();
        for (var i = 0; i < allDesktops.length; i++) {{
            var d = allDesktops[i];
            if (d.wallpaperPlugin !== '{id}') d.wallpaperPlugin = '{id}';
            {write_entry}
        }}
        "#
    )
}

/// 确保插件装好（没有或旧了就装内置的），再把所有桌面换成它、写好 `Entry`。
fn switch_to_kabegame_plugin() -> Result<(), String> {
    let package = install::ensure_installed()?;
    qdbus::run_qdbus_evaluate_script(&kabegame_plugin_script(&package.entry))
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
    qdbus::run_qdbus_evaluate_script(script)
}

/// 应用正常退出时（托盘「退出」、关主窗口时确认退出等，都经 `RunEvent::Exit`）：插件模式下把各桌面换回 `org.kde.image`。
/// 不换的话桌面仍挂着 Kabegame 的插件，推流随进程结束而断，桌面一片黑；下次启动时 [`ensure_plasma_plugin_aligned`] 再换回来。
/// `RunEvent::Exit` 在销毁壁纸窗口之前发，此时推流还在，先换插件不会闪黑。
///
/// 只在本进程拉起过插件模式时换：壁纸控制器初始化过（启动页出错退出、只转发请求就退出的第二个实例都没有）、Plasma 6 会话、
/// 设置是插件模式且壁纸开着（关着时 `cleanup` 已经换回去了）。
pub fn restore_system_plugin_on_exit() {
    if super::WallpaperController::try_global().is_none() || !install::is_plasma6_session() {
        return;
    }
    let settings = kabegame_core::settings::Settings::global();
    if !settings.get_wallpaper_enabled() || settings.get_wallpaper_mode() != "plasma-plugin" {
        return;
    }
    match switch_to_org_kde_image() {
        Ok(()) => tracing::info!("退出：各桌面的壁纸插件换回 org.kde.image"),
        Err(e) => tracing::warn!("退出时换回 org.kde.image 失败，桌面会停在 Kabegame 插件上（无画面）: {e}"),
    }
}

/// 启动时对齐：设置是插件模式时，确保插件装好且不旧（应用升级带来新修订时在这里装上），各桌面换成它、`Entry` 指向生效的
/// 内容文件（与 Windows / macOS 窗口模式启动时挂载窗口一致）。
pub fn ensure_plasma_plugin_aligned() -> Result<(), String> {
    switch_to_kabegame_plugin()
}

#[async_trait]
impl<R: Runtime> WallpaperManager for PlasmaPluginWallpaperManager<R> {
    fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption> {
        self.window.supported_styles(display)
    }

    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption> {
        self.window.supported_transitions(display)
    }

    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
        match display {
            DisplayMode::Multiple => None,
            // 逐屏独立与跨屏拼接要知道有哪些屏：Linux 还没有显示器枚举
            DisplayMode::Single | DisplayMode::Span => Some("settings.displayModeLater"),
        }
    }

    async fn set_wallpaper(
        &self,
        file_path: &str,
        style: &str,
        transition: &str,
        placement: &Placement,
    ) -> Result<(), String> {
        self.window
            .set_wallpaper(file_path, style, transition, placement)
            .await
    }

    fn reconcile(&self) -> Result<(), String> {
        self.window.reconcile()
    }

    fn window_assignment(&self, label: &str) -> Option<WindowAssignment> {
        self.window.window_assignment(label)
    }

    fn cleanup(&self) -> Result<(), String> {
        // 先换回系统壁纸插件，再拆离屏窗口：插件先不再读流，避免桌面短暂露出「流断开」的空白
        let switched = switch_to_org_kde_image();
        let cleaned = self.window.cleanup();
        switched.and(cleaned)
    }

    fn init(&self) -> Result<(), String> {
        // 先建离屏窗口与流，再切插件：插件一加载就能找到节点
        let initialized = self.window.init();
        if let Err(e) = switch_to_kabegame_plugin() {
            tracing::warn!("切换到 Kabegame Plasma 壁纸插件失败: {e}");
            return initialized.and(Err(e));
        }
        initialized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_script_writes_the_entry_only_when_it_is_a_plain_file_name() {
        let script = kabegame_plugin_script("KabegameWallpaperR3.qml");
        assert!(script.contains("d.wallpaperPlugin = 'org.kabegame.wallpaper'"));
        assert!(script.contains("d.writeConfig('Entry', 'KabegameWallpaperR3.qml')"));
        // 旧版插件没有内容文件名、或名字里有引号：只换插件不写 Entry
        assert!(!kabegame_plugin_script("").contains("writeConfig"));
        assert!(!kabegame_plugin_script("a'); evil('").contains("writeConfig"));
    }
}
