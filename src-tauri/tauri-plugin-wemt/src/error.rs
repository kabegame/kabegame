//! Error type shared by the plugin surface and the platform layer.

use serde::Serialize;

/// Result alias used across the plugin.
pub type Result<T> = std::result::Result<T, Error>;

/// Every failure mode the plugin can report to the frontend.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The host platform is not Windows; the plugin has no verified behaviour there.
    #[error("wemt is only implemented on Windows")]
    Unsupported,

    /// The window handle could not be obtained from Tauri.
    #[error("could not resolve the window handle: {0}")]
    WindowHandle(String),

    /// The supplied HWND is not a live window.
    #[error("window 0x{0:x} is not a valid window")]
    InvalidWindow(isize),

    /// No desktop worker window could be discovered (Explorer not running, or 0x052C was refused).
    #[error("desktop wallpaper host (WorkerW) not found; is explorer.exe running?")]
    HostNotFound,

    /// A Win32 call failed.
    #[error("{call} failed: {source}")]
    Win32 {
        /// Win32 API that failed.
        call: &'static str,
        /// Underlying OS error.
        #[source]
        source: std::io::Error,
    },

    /// The window was never mounted by this plugin instance, so there is nothing to restore.
    #[error("window 0x{0:x} is not tracked as mounted")]
    NotMounted(isize),

    /// State bookkeeping failed (poisoned lock).
    #[error("internal state lock poisoned")]
    StatePoisoned,
}

impl Error {
    pub(crate) fn win32(call: &'static str, code: u32) -> Self {
        Error::Win32 {
            call,
            source: std::io::Error::from_raw_os_error(code as i32),
        }
    }
}

/// Serializable error payload for the frontend.
#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
}

impl From<&Error> for ErrorPayload {
    fn from(error: &Error) -> Self {
        let code = match error {
            Error::Unsupported => "unsupported",
            Error::WindowHandle(_) => "window_handle",
            Error::InvalidWindow(_) => "invalid_window",
            Error::HostNotFound => "host_not_found",
            Error::Win32 { .. } => "win32",
            Error::NotMounted(_) => "not_mounted",
            Error::StatePoisoned => "state_poisoned",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        ErrorPayload::from(self).serialize(serializer)
    }
}
