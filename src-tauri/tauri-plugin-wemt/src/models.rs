//! Plain data exchanged with the frontend.

use serde::{Deserialize, Serialize};

/// Stable identifier of the current mount state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MountState {
    /// The window is an ordinary application window.
    Detached,
    /// The window is parented to a desktop worker window.
    Attached,
    /// The plugin believes the window is mounted, but the host is gone
    /// (typically after an Explorer restart). Call `refresh` to remount.
    HostLost,
    /// The last operation failed; see `message`.
    Failed,
}

/// Physical-pixel rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(self) -> i32 {
        self.right - self.left
    }

    pub fn height(self) -> i32 {
        self.bottom - self.top
    }
}

/// One display monitor in physical pixels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: u32,
    pub primary: bool,
    pub rect: Rect,
}

/// Options accepted by `attach`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AttachOptions {
    /// Zero-based monitor index. `None` uses the monitor that contains the host window.
    pub monitor: Option<u32>,
    /// Show the worker host window after mounting (observed in Wallpaper Engine).
    pub show_host: bool,
}

impl Default for AttachOptions {
    fn default() -> Self {
        Self {
            monitor: None,
            show_host: true,
        }
    }
}

/// Result of a successful mount.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachReport {
    pub window_hwnd: u64,
    pub host_hwnd: u64,
    pub monitor: MonitorInfo,
    pub target_rect: Rect,
    /// Style flags applied to the window.
    pub style: u32,
    pub ex_style: u32,
}

/// Current status for one window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountStatus {
    pub state: MountState,
    pub window_hwnd: u64,
    pub host_hwnd: Option<u64>,
    pub monitor: Option<MonitorInfo>,
    pub target_rect: Option<Rect>,
    pub message: Option<String>,
}
