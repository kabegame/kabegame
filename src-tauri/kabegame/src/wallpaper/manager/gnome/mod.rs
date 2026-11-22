//! GNOME 下的插件模式：Kabegame 自己渲染壁纸，壁纸窗口是普通窗口（不是 Plasma 那样的离屏 browser + PipeWire），
//! 由 Kabegame 的 GNOME Shell 扩展按标题（[`super::window::WINDOWED_TITLE_PREFIX`]）认出，改成桌面类型窗口、铺满对应的屏、
//! 压到最底层。鼠标直接进窗口，壁纸页面经 `push_window_pointer` 交给应用再注入 iframe。
//!
//! 目前是实验阶段（B0b）：扩展还在 `ignore/gnome-b0/`，不随应用分发、不自动安装；Linux 没有显示器枚举，只有一个窗口，
//! 扩展把它放到主屏。

pub mod window_locator;

use super::{
    DisplayMode, Placement, WallpaperManager, WallpaperOption, WindowAssignment,
    WindowWallpaperManager,
};
use crate::linux_desktop::{linux_desktop, LinuxDesktop};
use async_trait::async_trait;
use tauri::{AppHandle, Runtime};

/// 当前是 GNOME 会话：插件模式由本后端提供。
pub fn available() -> bool {
    linux_desktop() == LinuxDesktop::Gnome
}

/// GNOME 插件模式管理器：包一层普通窗口的窗口后端，挂到桌面层的事交给 Shell 扩展。
pub struct GnomeShellWallpaperManager<R: Runtime> {
    window: WindowWallpaperManager<R>,
}

impl<R: Runtime> GnomeShellWallpaperManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            window: WindowWallpaperManager::new_windowed(app, "plasma-plugin"),
        }
    }
}

#[async_trait]
impl<R: Runtime> WallpaperManager for GnomeShellWallpaperManager<R> {
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
        self.window.cleanup()
    }

    fn init(&self) -> Result<(), String> {
        self.window.init()
    }
}
