//! Frontend-facing commands.
//!
//! All Win32 calls run on the calling thread. `SetParent` / `SetWindowLongPtr`
//! are cross-thread safe, but the window keeps being owned by the thread that
//! created it, so Tauri's own message loop stays in charge of it.

use tauri::{Manager, Runtime, State, WebviewWindow};

use crate::error::{Error, Result};
use crate::models::{AttachOptions, AttachReport, MountState, MountStatus};
use crate::platform;
use crate::state::{Mounted, WemtState};

/// Resolve the native handle of a Tauri window.
fn window_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<isize> {
    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| Error::WindowHandle(error.to_string()))?;
        // `tauri` re-exports the `windows` crate HWND (a pointer newtype).
        Ok(hwnd.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err(Error::Unsupported)
    }
}

fn status_for(hwnd: isize, state: &WemtState) -> MountStatus {
    let mounted = state.get(hwnd).ok().flatten();
    let failure = state.failure(hwnd);

    let (mount_state, host, monitor, rect, message) = match mounted {
        Some(entry) => {
            if platform::is_attached(hwnd, entry.host) {
                (
                    MountState::Attached,
                    Some(entry.host),
                    Some(entry.monitor),
                    Some(entry.rect),
                    None,
                )
            } else {
                (
                    MountState::HostLost,
                    Some(entry.host),
                    Some(entry.monitor),
                    Some(entry.rect),
                    Some("desktop host window is gone; call wemt_refresh".to_string()),
                )
            }
        }
        None => match failure {
            Some(message) => (MountState::Failed, None, None, None, Some(message)),
            None => (MountState::Detached, None, None, None, None),
        },
    };

    MountStatus {
        state: mount_state,
        window_hwnd: hwnd as u64,
        host_hwnd: host.map(|value| value as u64),
        monitor,
        target_rect: rect,
        message,
    }
}

/// Mount the calling window behind the desktop icons.
#[tauri::command]
pub fn wemt_attach<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, WemtState>,
    options: Option<AttachOptions>,
) -> Result<AttachReport> {
    attach_with_state(&window, &state, options)
}

/// 供宿主 Rust 代码调用同一挂载路径。
pub fn attach_window<R: Runtime>(
    window: &WebviewWindow<R>,
    options: Option<AttachOptions>,
) -> Result<AttachReport> {
    let state = window.app_handle().state::<WemtState>();
    attach_with_state(window, &state, options)
}

fn attach_with_state<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &WemtState,
    options: Option<AttachOptions>,
) -> Result<AttachReport> {
    let hwnd = window_hwnd(&window)?;
    let options = options.unwrap_or_default();

    if let Ok(Some(existing)) = state.get(hwnd) {
        if platform::is_attached(hwnd, existing.host) {
            return Ok(AttachReport {
                window_hwnd: hwnd as u64,
                host_hwnd: existing.host as u64,
                monitor: existing.monitor,
                target_rect: existing.rect,
                style: existing.style,
                ex_style: existing.ex_style,
            });
        }
        // 宿主失效时先恢复原始窗口，再重新截取状态。
        platform::restore(existing.snapshot)?;
        state.remove(hwnd).map_err(|_| Error::StatePoisoned)?;
        if !state.has_host(existing.host) {
            platform::release_host(existing.host);
        }
    }

    let mut discovered_host = None;
    let result = (|| -> Result<(AttachReport, Mounted)> {
        let host = platform::discover_host().ok_or(Error::HostNotFound)?;
        discovered_host = Some(host);
        let snapshot = platform::snapshot(hwnd)?;
        let (monitor, rect) = platform::monitor_for(hwnd, options.monitor)?;
        let (style, ex_style) = platform::mount(hwnd, host, rect, options.show_host, snapshot)?;

        let mounted = Mounted {
            host,
            snapshot,
            monitor,
            rect,
            style,
            ex_style,
        };
        Ok((
            AttachReport {
                window_hwnd: hwnd as u64,
                host_hwnd: host as u64,
                monitor,
                target_rect: rect,
                style,
                ex_style,
            },
            mounted,
        ))
    })();

    match result {
        Ok((report, mounted)) => {
            if state.insert(hwnd, mounted).is_err() {
                let _ = platform::restore(mounted.snapshot);
                if !state.has_host(mounted.host) {
                    platform::release_host(mounted.host);
                }
                return Err(Error::StatePoisoned);
            }
            Ok(report)
        }
        Err(error) => {
            if let Some(host) = discovered_host {
                if !state.has_host(host) {
                    platform::release_host(host);
                }
            }
            state.record_failure(hwnd, error.to_string());
            Err(error)
        }
    }
}

/// Restore the window to its pre-mount state.
#[tauri::command]
pub fn wemt_detach<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, WemtState>,
) -> Result<MountStatus> {
    detach_with_state(&window, &state)
}

pub fn detach_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<MountStatus> {
    let state = window.app_handle().state::<WemtState>();
    detach_with_state(window, &state)
}

fn detach_with_state<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &WemtState,
) -> Result<MountStatus> {
    let hwnd = window_hwnd(&window)?;
    let entry = state.get(hwnd).map_err(|_| Error::StatePoisoned)?;
    match entry {
        Some(entry) => {
            platform::restore(entry.snapshot)?;
            state.remove(hwnd).map_err(|_| Error::StatePoisoned)?;
            if !state.has_host(entry.host) {
                platform::release_host(entry.host);
            }
            state.clear_failure(hwnd);
        }
        None => return Err(Error::NotMounted(hwnd)),
    }
    Ok(status_for(hwnd, &state))
}

/// Report the current mount state without changing anything.
#[tauri::command]
pub fn wemt_status<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, WemtState>,
) -> Result<MountStatus> {
    let hwnd = window_hwnd(&window)?;
    Ok(status_for(hwnd, &state))
}

/// Re-discover the host and remount, e.g. after Explorer restarted.
#[tauri::command]
pub fn wemt_refresh<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, WemtState>,
    options: Option<AttachOptions>,
) -> Result<AttachReport> {
    let hwnd = window_hwnd(&window)?;
    if let Some(entry) = state.get(hwnd).map_err(|_| Error::StatePoisoned)? {
        platform::restore(entry.snapshot)?;
        state.remove(hwnd).map_err(|_| Error::StatePoisoned)?;
        if !state.has_host(entry.host) {
            platform::release_host(entry.host);
        }
    }
    wemt_attach(window, state, options)
}
