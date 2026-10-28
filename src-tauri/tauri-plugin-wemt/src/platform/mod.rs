//! Platform dispatch. Only Windows has a verified implementation.

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
mod unsupported {
    use crate::error::{Error, Result};
    use crate::models::{MonitorInfo, Rect};

    /// Everything needed to undo a mount. Opaque outside the platform layer.
    #[derive(Debug, Clone, Copy)]
    pub struct WindowSnapshot;

    pub fn discover_host() -> Option<isize> {
        None
    }

    pub fn is_host_valid(_host: isize) -> bool {
        false
    }

    pub fn release_host(_host: isize) {}

    pub fn is_attached(_hwnd: isize, _host: isize) -> bool {
        false
    }

    pub fn snapshot(_hwnd: isize) -> Result<WindowSnapshot> {
        Err(Error::Unsupported)
    }

    pub fn monitor_for(_hwnd: isize, _index: Option<u32>) -> Result<(MonitorInfo, Rect)> {
        Err(Error::Unsupported)
    }

    pub fn mount(
        _hwnd: isize,
        _host: isize,
        _rect: Rect,
        _show_host: bool,
        _snapshot: WindowSnapshot,
    ) -> Result<(u32, u32)> {
        Err(Error::Unsupported)
    }

    pub fn restore(_snapshot: WindowSnapshot) -> Result<()> {
        Err(Error::Unsupported)
    }
}

#[cfg(not(windows))]
pub use unsupported::*;
