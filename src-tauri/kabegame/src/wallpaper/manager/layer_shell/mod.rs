//! 通用 Wayland `zwlr_layer_shell_v1` 壁纸后端（niri / Hyprland / Sway / River 等）。
//!
//! Kabegame 自己建离屏 CEF 壁纸窗口（[`WindowWallpaperManager::new_layer_shell`]），
//! 由 [`surface::LayerShellSink`] 把每一帧直接提交到每个 `wl_output` 的 `background` 层 surface，
//! 不绕 PipeWire、不依赖 Plasma / GNOME Shell 扩展，进程退出时合成器自动移除表面。

pub mod surface;

use std::sync::OnceLock;

use async_trait::async_trait;
use tauri::{AppHandle, Runtime};
use wayland_client::protocol::{wl_compositor, wl_registry, wl_shm};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols_wlr::layer_shell::v1::client::zwlr_layer_shell_v1::ZwlrLayerShellV1;

use super::{
    DisplayMode, Placement, WallpaperManager, WallpaperOption, WindowAssignment,
    WindowWallpaperManager,
};

#[derive(Default)]
struct Probe {
    has_layer_shell: bool,
    has_compositor: bool,
    has_shm: bool,
}

impl Dispatch<wl_registry::WlRegistry, ()> for Probe {
    fn event(
        state: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            interface, version, ..
        } = event
        {
            if interface == ZwlrLayerShellV1::interface().name && version >= 1 {
                state.has_layer_shell = true;
            } else if interface == wl_compositor::WlCompositor::interface().name {
                state.has_compositor = true;
            } else if interface == wl_shm::WlShm::interface().name {
                state.has_shm = true;
            }
        }
    }
}

/// 当前会话是否可用通用 `wlr-layer-shell` 后端。
///
/// Plasma 6 与 GNOME 已有各自专用后端；其余桌面在 Wayland 会话下探测是否暴露
/// `zwlr_layer_shell_v1`、`wl_compositor` 与 `wl_shm`。结果进程内缓存。
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        if super::plasma::install::available() || super::gnome::available() {
            return false;
        }
        if std::env::var_os("WAYLAND_DISPLAY").is_none_or(|v| v.is_empty()) {
            return false;
        }
        match probe_layer_shell() {
            Ok(ok) => {
                if ok {
                    tracing::info!("检测到 Wayland zwlr_layer_shell_v1，启用通用 layer-shell 壁纸后端");
                } else {
                    tracing::info!("Wayland 合成器未暴露 zwlr_layer_shell_v1，layer-shell 壁纸后端不可用");
                }
                ok
            }
            Err(e) => {
                tracing::debug!("探测 zwlr_layer_shell_v1 失败: {e}");
                false
            }
        }
    })
}

fn probe_layer_shell() -> Result<bool, String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("连不上 Wayland 合成器: {e}"))?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut probe = Probe::default();
    queue
        .roundtrip(&mut probe)
        .map_err(|e| format!("Wayland roundtrip 失败: {e}"))?;
    Ok(probe.has_layer_shell && probe.has_compositor && probe.has_shm)
}

/// 通用 `wlr-layer-shell` 壁纸模式管理器：包一层离屏窗口后端，帧与指针直接走 Wayland。
pub struct LayerShellWallpaperManager<R: Runtime> {
    window: WindowWallpaperManager<R>,
}

impl<R: Runtime> LayerShellWallpaperManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            window: WindowWallpaperManager::new_layer_shell(app, "plasma-plugin"),
        }
    }
}

#[async_trait]
impl<R: Runtime> WallpaperManager for LayerShellWallpaperManager<R> {
    fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption> {
        self.window.supported_styles(display)
    }

    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption> {
        self.window.supported_transitions(display)
    }

    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
        match display {
            DisplayMode::Multiple => None,
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

    fn restart_if_active(&self) -> Result<(), String> {
        self.window.restart_if_active()
    }
}
