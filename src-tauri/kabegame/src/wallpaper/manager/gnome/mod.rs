//! GNOME 下的插件模式：Kabegame 自己渲染壁纸，壁纸窗口是普通窗口（不是 Plasma 那样的离屏 browser + PipeWire），
//! 由 Kabegame 的 GNOME Shell 扩展（源码 `src-gnome-shell-extension/`，安装与检测见 [`extension`]）按标题
//! （[`super::window::WINDOWED_TITLE_PREFIX`]）认出、挂到桌面：铺满对应的屏、压到最底层，GNOME 49 起改成桌面类型窗口。
//! 鼠标直接进窗口，壁纸页面经 `push_window_pointer` 交给应用再注入 iframe。Linux 没有显示器枚举，只有一个窗口，扩展把它放到主屏。
//!
//! **插件模式必须有扩展在线**：
//! - 切进来之前由前端调 `get_plugin_mode_readiness` 检查 Shell 版本与扩展，不满足时提示升级系统或帮用户安装扩展；
//!   `set_wallpaper_mode` 自己也再查一次。
//! - 在插件模式里任何地方发现扩展不在线（后端初始化、设壁纸、对齐窗口、问窗口位置失败、扩展的 D-Bus 名字没了），
//!   都经 [`extension_lost`] 退回原生模式，并经 `user-message` 告诉用户。
//! - 开机自启时 Shell 可能还在加载扩展：[`settle_on_startup`] 在恢复壁纸之前最多等 [`STARTUP_GRACE`]。

pub mod extension;
pub mod window_locator;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::{
    DisplayMode, Placement, WallpaperManager, WallpaperOption, WindowAssignment,
    WindowWallpaperManager,
};
use crate::linux_desktop::{linux_desktop, LinuxDesktop};
use async_trait::async_trait;
use extension::Readiness;
use kabegame_core::emitter::{GlobalEmitter, UserMessageLevel};
use kabegame_core::settings::Settings;
use tauri::{AppHandle, Runtime};

/// 开机后等扩展上线的最长时间。
const STARTUP_GRACE: Duration = Duration::from_secs(15);

/// 当前是 GNOME 会话：插件模式由本后端提供（能力表据此列出插件模式；能不能真的切过去看 [`readiness`]）。
pub fn available() -> bool {
    linux_desktop() == LinuxDesktop::Gnome
}

/// 能不能切到插件模式：GNOME 会话看 Shell 版本与扩展，其它会话（Plasma / layer-shell）总是可以。
pub fn readiness() -> Result<Readiness, String> {
    if available() {
        extension::readiness()
    } else {
        Ok(Readiness::Ready {
            gnome: false,
            layer_shell: super::layer_shell::available(),
        })
    }
}

/// `set_wallpaper_mode` 切到插件模式前的检查（前端已经按 [`readiness`] 引导过，这里防 IPC / CLI 直接调）。
pub fn ensure_ready() -> Result<(), String> {
    match readiness()? {
        Readiness::Ready { .. } => Ok(()),
        other => Err(format!("GNOME_PLUGIN_MODE_NOT_READY: {other:?}")),
    }
}

/// 正处在 GNOME 的插件模式里（壁纸开着）。
fn plugin_mode_active() -> bool {
    if !available() {
        return false;
    }
    let settings = Settings::global();
    settings.get_wallpaper_enabled() && settings.get_wallpaper_mode() == "plasma-plugin"
}

static FALLING_BACK: AtomicBool = AtomicBool::new(false);

/// 插件模式下发现扩展不在线：退回原生模式（异步进行）。不在插件模式时什么都不做。
pub fn extension_lost(reason: &str) {
    if !plugin_mode_active() {
        return;
    }
    let reason = reason.to_string();
    tauri::async_runtime::spawn(async move { fall_back_to_native(&reason).await });
}

/// 先确认扩展真的不在线再退回（一次 D-Bus 调用失败可能只是 Shell 一时没响应）。
pub fn extension_lost_if_offline(reason: &str) {
    if plugin_mode_active() && !extension::is_online() {
        extension_lost(reason);
    }
}

fn on_name_lost() {
    extension_lost("扩展的 D-Bus 名字没了");
}

/// 切到原生模式（与用户在设置里切换同一条路，不换壁纸），再告诉用户。同一时间只跑一次。
async fn fall_back_to_native(reason: &str) {
    if !plugin_mode_active() || FALLING_BACK.swap(true, Ordering::SeqCst) {
        return;
    }
    tracing::warn!("Kabegame 的 GNOME Shell 扩展不在线（{reason}），插件模式退回原生模式");
    match crate::commands::wallpaper::switch_wallpaper_mode("native").await {
        Ok(()) => GlobalEmitter::global().emit_user_message(
            UserMessageLevel::Warning,
            "settings.gnomeExtensionOfflineFallback",
            serde_json::json!({}),
        ),
        Err(error) => tracing::error!("插件模式退回原生模式失败: {error}"),
    }
    FALLING_BACK.store(false, Ordering::SeqCst);
}

/// 启动时、恢复壁纸之前：插件模式下等扩展上线，等到了就开始监听掉线，等不到就退回原生模式。
pub async fn settle_on_startup() {
    if !plugin_mode_active() {
        return;
    }
    let deadline = Instant::now() + STARTUP_GRACE;
    loop {
        let online = tauri::async_runtime::spawn_blocking(extension::is_online)
            .await
            .unwrap_or(false);
        if online {
            extension::watch(on_name_lost);
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    fall_back_to_native(&format!("启动后 {} s 内没有上线", STARTUP_GRACE.as_secs())).await;
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

    /// 没有扩展，壁纸窗口只是一个普通窗口：不在线就不往下做，并退回原生模式（不在插件模式时只报错，由调用方中止切换）。
    fn ensure_online(&self) -> Result<(), String> {
        if extension::is_online() {
            return Ok(());
        }
        extension_lost("要用扩展时它不在线");
        Err("Kabegame 的 GNOME Shell 扩展不在线".to_string())
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
        self.ensure_online()?;
        self.window
            .set_wallpaper(file_path, style, transition, placement)
            .await
    }

    fn reconcile(&self) -> Result<(), String> {
        self.ensure_online()?;
        self.window.reconcile()
    }

    fn window_assignment(&self, label: &str) -> Option<WindowAssignment> {
        self.window.window_assignment(label)
    }

    fn cleanup(&self) -> Result<(), String> {
        self.window.cleanup()
    }

    fn init(&self) -> Result<(), String> {
        self.ensure_online()?;
        extension::watch(on_name_lost);
        self.window.init()
    }
}
