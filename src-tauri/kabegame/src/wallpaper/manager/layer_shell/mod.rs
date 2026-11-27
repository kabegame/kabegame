//! 通用 Wayland `zwlr_layer_shell_v1` 原生（`native`）壁纸后端（niri / Hyprland / Sway / River 等）。
//!
//! 在支持 `zwlr_layer_shell_v1` 的合成器下无需安装外部插件或同步桌面状态，直接作为 `native` 模式运行：
//! Kabegame 自己建离屏 CEF 壁纸窗口（[`WindowWallpaperManager::new_layer_shell`]），
//! 由 [`surface::LayerShellSink`] 把每一帧直接提交到每个 `wl_output` 的 `background` 层 surface，
//! 不绕 PipeWire、不依赖 Plasma / GNOME Shell 扩展，进程退出时合成器自动移除表面。

pub mod surface;

use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tauri::{AppHandle, Runtime};
use wayland_client::backend::WaylandError;
use wayland_client::protocol::{wl_callback, wl_compositor, wl_registry, wl_shm};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols_wlr::layer_shell::v1::client::zwlr_layer_shell_v1::ZwlrLayerShellV1;

use super::{
    DisplayMode, Placement, WallpaperManager, WallpaperOption, WindowAssignment,
    WindowWallpaperManager,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Probe {
    has_layer_shell: bool,
    has_compositor: bool,
    has_shm: bool,
    sync_done: bool,
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

impl Dispatch<wl_callback::WlCallback, ()> for Probe {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        event: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_callback::Event::Done { .. } = event {
            state.sync_done = true;
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

fn is_would_block(err: &WaylandError) -> bool {
    matches!(err, WaylandError::Io(io_err) if io_err.kind() == std::io::ErrorKind::WouldBlock)
}

fn drain_wakeup_fd(fd: &OwnedFd) {
    let mut buf = [0u8; 64];
    loop {
        // SAFETY: 唤醒管道读端非阻塞，读空到 EAGAIN 为止。
        let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 {
            break;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConnectAttempt {
    Connected,
    InProgress,
    AgainRetry,
    Failed(String),
}

fn connect_unix_with_ops<FConnect, FWaitRetry, FWaitWritable, FCheckError, FCheckPeer>(
    deadline: Instant,
    is_cancelled: &dyn Fn() -> bool,
    mut try_connect: FConnect,
    mut wait_retry: FWaitRetry,
    mut wait_writable: FWaitWritable,
    mut check_so_error: FCheckError,
    mut check_peer_connected: FCheckPeer,
) -> Result<(), String>
where
    FConnect: FnMut() -> ConnectAttempt,
    FWaitRetry: FnMut(Duration) -> Result<(), String>,
    FWaitWritable: FnMut(i32) -> Result<(), String>,
    FCheckError: FnMut() -> Result<(), String>,
    FCheckPeer: FnMut() -> Result<(), String>,
{
    let mut retry_backoff = Duration::from_millis(5);
    loop {
        if is_cancelled() {
            return Err("Wayland 连接被取消".to_string());
        }
        if Instant::now() >= deadline {
            return Err("连接 Wayland 合成器超时".to_string());
        }
        match try_connect() {
            ConnectAttempt::Connected => return Ok(()),
            ConnectAttempt::Failed(err) => return Err(err),
            ConnectAttempt::AgainRetry => {
                // Linux AF_UNIX 监听队列满时非阻塞 connect 返回 EAGAIN，此时尚未入队，
                // 不能走 POLLOUT/SO_ERROR，只能在截止时间与取消约束内退避重调 connect。
                let now = Instant::now();
                if now >= deadline {
                    return Err("连接 Wayland 合成器超时（合成器忙）".to_string());
                }
                let wait = retry_backoff.min(deadline.saturating_duration_since(now));
                retry_backoff = (retry_backoff * 2).min(Duration::from_millis(25));
                wait_retry(wait)?;
                if is_cancelled() {
                    return Err("Wayland 连接被取消".to_string());
                }
            }
            ConnectAttempt::InProgress => {
                loop {
                    if is_cancelled() {
                        return Err("Wayland 连接被取消".to_string());
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        return Err("连接 Wayland 合成器超时".to_string());
                    }
                    let timeout_ms = deadline
                        .saturating_duration_since(now)
                        .as_millis()
                        .clamp(1, i32::MAX as u128) as i32;
                    wait_writable(timeout_ms)?;
                    if is_cancelled() {
                        return Err("Wayland 连接被取消".to_string());
                    }
                    check_so_error()?;
                    check_peer_connected()?;
                    return Ok(());
                }
            }
        }
    }
}

pub(crate) fn connect_unix_socket_with_timeout(
    socket_path: &Path,
    deadline: Instant,
    cancel: Option<(&OwnedFd, &AtomicBool)>,
) -> Result<UnixStream, String> {
    let is_cancelled = || cancel.is_some_and(|(_, shutdown)| shutdown.load(Ordering::Acquire));
    if is_cancelled() {
        return Err("Wayland 连接在建立前被取消".to_string());
    }
    let path_cstr = CString::new(socket_path.as_os_str().as_bytes())
        .map_err(|_| format!("Wayland 套接字路径含空字节: {}", socket_path.display()))?;
    // SAFETY: `libc::sockaddr_un` 按零初始化后填入 sun_family 与以 '\0' 结尾的路径字节。
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = path_cstr.as_bytes_with_nul();
    if bytes.len() > addr.sun_path.len() {
        return Err(format!("Wayland 套接字路径过长: {}", socket_path.display()));
    }
    for (dst, &src) in addr.sun_path.iter_mut().zip(bytes.iter()) {
        *dst = src as libc::c_char;
    }

    // SAFETY: 创建非阻塞 unix socket 并立刻用 OwnedFd 接管。
    let raw_fd = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw_fd < 0 {
        return Err(format!(
            "创建 Wayland 套接字失败: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `raw_fd` 是刚成功创建的新 fd。
    let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
    let addr_len = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len()) as libc::socklen_t;

    let try_connect = || loop {
        // SAFETY: `addr` 已完整填充，长度由 offset_of + bytes.len() 精确给出。
        let rc = unsafe {
            libc::connect(
                fd.as_raw_fd(),
                (&raw const addr).cast::<libc::sockaddr>(),
                addr_len,
            )
        };
        if rc == 0 {
            return ConnectAttempt::Connected;
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return match err.raw_os_error() {
            Some(libc::EINPROGRESS) => ConnectAttempt::InProgress,
            Some(libc::EAGAIN) => ConnectAttempt::AgainRetry,
            _ => ConnectAttempt::Failed(format!("连不上 Wayland 合成器: {err}")),
        };
    };

    let wait_retry = |wait: Duration| -> Result<(), String> {
        let mut remaining = wait;
        while !remaining.is_zero() {
            if is_cancelled() {
                return Err("Wayland 连接被取消".to_string());
            }
            let start = Instant::now();
            let ms = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
            let polled = if let Some((wake_fd, _)) = cancel {
                let mut pfd = libc::pollfd {
                    fd: wake_fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                // SAFETY: `wake_fd` 在等待期间有效。
                let r = unsafe { libc::poll(&mut pfd, 1, ms) };
                if r > 0 && (pfd.revents & libc::POLLIN != 0) {
                    drain_wakeup_fd(wake_fd);
                }
                r
            } else {
                // SAFETY: 无 fd 等待，仅作为可响应 EINTR 的短退避。
                unsafe { libc::poll(std::ptr::null_mut(), 0, ms) }
            };
            if polled < 0 {
                let poll_err = std::io::Error::last_os_error();
                if poll_err.kind() == std::io::ErrorKind::Interrupted {
                    remaining = remaining.saturating_sub(start.elapsed());
                    continue;
                }
                return Err(format!("Wayland 重试等待 poll 失败: {poll_err}"));
            }
            break;
        }
        Ok(())
    };

    let wait_writable = |mut timeout_ms: i32| -> Result<(), String> {
        let loop_deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1) as u64);
        loop {
            let mut fds = [
                libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                },
                libc::pollfd {
                    fd: cancel.map_or(-1, |(w, _)| w.as_raw_fd()),
                    events: if cancel.is_some() { libc::POLLIN } else { 0 },
                    revents: 0,
                },
            ];
            let nfds = if cancel.is_some() { 2 } else { 1 };
            // SAFETY: 两个 fd 在本次 poll 期间均有效。
            let polled = unsafe { libc::poll(fds.as_mut_ptr(), nfds, timeout_ms) };
            if polled < 0 {
                let poll_err = std::io::Error::last_os_error();
                if poll_err.kind() == std::io::ErrorKind::Interrupted {
                    let now = Instant::now();
                    if now >= loop_deadline {
                        return Err("连接 Wayland 合成器超时".to_string());
                    }
                    timeout_ms = loop_deadline
                        .saturating_duration_since(now)
                        .as_millis()
                        .clamp(1, i32::MAX as u128) as i32;
                    continue;
                }
                return Err(format!("Wayland 连接 poll 失败: {poll_err}"));
            }
            if polled == 0 {
                return Err("连接 Wayland 合成器超时".to_string());
            }
            if cancel.is_some() && (fds[1].revents & libc::POLLIN != 0) {
                if let Some((wake_fd, _)) = cancel {
                    drain_wakeup_fd(wake_fd);
                    if is_cancelled() {
                        return Err("Wayland 连接被取消".to_string());
                    }
                }
            }
            if fds[0].revents & (libc::POLLOUT | libc::POLLERR | libc::POLLHUP) != 0 {
                return Ok(());
            }
            let now = Instant::now();
            if now >= loop_deadline {
                return Err("连接 Wayland 合成器超时".to_string());
            }
            timeout_ms = loop_deadline
                .saturating_duration_since(now)
                .as_millis()
                .clamp(1, i32::MAX as u128) as i32;
        }
    };

    let check_so_error = || -> Result<(), String> {
        let mut so_error: libc::c_int = 0;
        let mut opt_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        // SAFETY: `fd` 有效，`so_error` 与 `opt_len` 对齐且可写。
        let gso = unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&raw mut so_error).cast(),
                &raw mut opt_len,
            )
        };
        if gso < 0 {
            return Err(format!(
                "检查 Wayland 连接状态失败: {}",
                std::io::Error::last_os_error()
            ));
        }
        if so_error != 0 {
            return Err(format!(
                "连不上 Wayland 合成器: {}",
                std::io::Error::from_raw_os_error(so_error)
            ));
        }
        Ok(())
    };

    let check_peer_connected = || -> Result<(), String> {
        // SAFETY: 零初始化 peer sockaddr_storage，检查 socket 是否真实连上对端。
        let mut peer: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
        let mut peer_len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        // SAFETY: `fd` 有效，`peer` 与 `peer_len` 可写。
        let rc = unsafe {
            libc::getpeername(
                fd.as_raw_fd(),
                (&raw mut peer).cast::<libc::sockaddr>(),
                &raw mut peer_len,
            )
        };
        if rc < 0 {
            return Err(format!(
                "Wayland 套接字未建立连接: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    };

    connect_unix_with_ops(
        deadline,
        &is_cancelled,
        try_connect,
        wait_retry,
        wait_writable,
        check_so_error,
        check_peer_connected,
    )?;

    // 切回阻塞标志，与 `UnixStream::connect` + `wayland-backend` 一致。
    // SAFETY: `fd` 为刚建立的有效 socket。
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags >= 0 && (flags & libc::O_NONBLOCK != 0) {
        // SAFETY: 清除 O_NONBLOCK 标志。
        let _ = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) };
    }
    Ok(UnixStream::from(fd))
}

pub(crate) fn connect_wayland_with_timeout(
    deadline: Instant,
    cancel: Option<(&OwnedFd, &AtomicBool)>,
) -> Result<Connection, String> {
    if let Some((_, shutdown)) = cancel {
        if shutdown.load(Ordering::Acquire) {
            return Err("Wayland 连接在建立前被取消".to_string());
        }
    }

    // 探测与后台壁纸后端总是按 WAYLAND_DISPLAY 独立建连，绝不在多线程运行期读写/移除
    // `WAYLAND_SOCKET`，避免环境变量并发修改 UB 或重复接管同一个继承 fd。
    let socket_name = std::env::var_os("WAYLAND_DISPLAY")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "WAYLAND_DISPLAY 未设置".to_string())?;

    let socket_path = if socket_name.is_absolute() {
        socket_name
    } else {
        let mut dir = std::env::var_os("XDG_RUNTIME_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "XDG_RUNTIME_DIR 未设置".to_string())?;
        if !dir.is_absolute() {
            return Err("XDG_RUNTIME_DIR 不是绝对路径".to_string());
        }
        dir.push(socket_name);
        dir
    };

    let stream = connect_unix_socket_with_timeout(&socket_path, deadline, cancel)?;
    Connection::from_socket(stream).map_err(|e| format!("连不上 Wayland 合成器: {e}"))
}

fn probe_layer_shell() -> Result<bool, String> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let conn = connect_wayland_with_timeout(deadline, None)?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    conn.display().sync(&qh, ());

    let mut probe = Probe::default();
    let mut need_flush = true;

    while !probe.sync_done {
        queue
            .dispatch_pending(&mut probe)
            .map_err(|e| format!("Wayland 探测分发失败: {e}"))?;
        if probe.sync_done {
            break;
        }
        if need_flush {
            match conn.flush() {
                Ok(()) => need_flush = false,
                Err(ref e) if is_would_block(e) => need_flush = true,
                Err(e) => return Err(format!("Wayland 探测 flush 失败: {e}")),
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("Wayland 探测超时".to_string());
        }
        let timeout_ms = deadline
            .saturating_duration_since(now)
            .as_millis()
            .clamp(1, i32::MAX as u128) as i32;
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut pfd = libc::pollfd {
            fd: guard.connection_fd().as_raw_fd(),
            events: libc::POLLIN | if need_flush { libc::POLLOUT } else { 0 },
            revents: 0,
        };
        // SAFETY: `pfd.fd` 指向本次 guard 持有的有效 Wayland 连接 fd。
        let polled = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if polled < 0 {
            let err = std::io::Error::last_os_error();
            drop(guard);
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Wayland 探测 poll 失败: {err}"));
        }
        if pfd.revents & libc::POLLIN != 0 {
            match guard.read() {
                Ok(_) => {}
                Err(ref e) if is_would_block(e) => {}
                Err(e) => return Err(format!("Wayland 探测读事件失败: {e}")),
            }
        } else {
            drop(guard);
        }
        if pfd.revents & libc::POLLOUT != 0 {
            need_flush = true;
        }
        if pfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err("Wayland 探测连接断开".to_string());
        }
    }

    Ok(probe.has_layer_shell && probe.has_compositor && probe.has_shm)
}

/// 通用 `wlr-layer-shell` 原生模式管理器：包一层离屏窗口后端，帧与指针直接走 Wayland。
pub struct LayerShellWallpaperManager<R: Runtime> {
    window: WindowWallpaperManager<R>,
}

impl<R: Runtime> LayerShellWallpaperManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            window: WindowWallpaperManager::new_layer_shell(app, "native"),
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

    fn recover_layer_shell(
        &self,
        expected_gen: u64,
        label: &str,
        health: &surface::SinkHealth,
        disable_dmabuf: bool,
        reason: Option<&str>,
    ) -> Result<(), String> {
        self.window
            .recover_layer_shell(expected_gen, label, health, disable_dmabuf, reason)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn connect_state_machine_retries_eagain_without_polling_writable() {
        let calls = Cell::new(0usize);
        let retries = Cell::new(0usize);
        let waited_writable = Cell::new(false);
        let shutdown = false;

        let res = connect_unix_with_ops(
            Instant::now() + Duration::from_secs(2),
            &|| shutdown,
            || {
                let n = calls.get() + 1;
                calls.set(n);
                if n < 3 {
                    ConnectAttempt::AgainRetry
                } else {
                    ConnectAttempt::Connected
                }
            },
            |_| {
                retries.set(retries.get() + 1);
                Ok(())
            },
            |_| {
                waited_writable.set(true);
                Ok(())
            },
            || Ok(()),
            || Ok(()),
        );
        assert!(res.is_ok());
        assert_eq!(calls.get(), 3);
        assert_eq!(retries.get(), 2);
        assert!(!waited_writable.get());
    }

    #[test]
    fn connect_state_machine_eagain_respects_cancel_before_timeout() {
        let cancelled = Cell::new(false);
        let res = connect_unix_with_ops(
            Instant::now() + Duration::from_secs(5),
            &|| cancelled.get(),
            || ConnectAttempt::AgainRetry,
            |_| {
                cancelled.set(true);
                Ok(())
            },
            |_| unreachable!("EAGAIN 不应进入 POLLOUT 等待"),
            || Ok(()),
            || Ok(()),
        );
        let err = res.unwrap_err();
        assert!(err.contains("取消"), "unexpected error: {err}");
    }

    #[test]
    fn connect_state_machine_in_progress_checks_so_error_and_peer() {
        let ok = connect_unix_with_ops(
            Instant::now() + Duration::from_secs(2),
            &|| false,
            || ConnectAttempt::InProgress,
            |_| Ok(()),
            |_| Ok(()),
            || Ok(()),
            || Ok(()),
        );
        assert!(ok.is_ok());

        let so_err = connect_unix_with_ops(
            Instant::now() + Duration::from_secs(2),
            &|| false,
            || ConnectAttempt::InProgress,
            |_| Ok(()),
            |_| Ok(()),
            || Err("ECONNREFUSED".to_string()),
            || Ok(()),
        );
        assert_eq!(so_err.unwrap_err(), "ECONNREFUSED");

        let no_peer = connect_unix_with_ops(
            Instant::now() + Duration::from_secs(2),
            &|| false,
            || ConnectAttempt::InProgress,
            |_| Ok(()),
            |_| Ok(()),
            || Ok(()),
            || Err("ENOTCONN".to_string()),
        );
        assert_eq!(no_peer.unwrap_err(), "ENOTCONN");
    }

    #[test]
    fn connect_unix_socket_with_timeout_real_socket_cancel_and_success() {
        static SEQ: AtomicUsize = AtomicUsize::new(1);
        let sock_path = std::env::temp_dir().join(format!(
            "kabegame-ls-test-{}-{}.sock",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&sock_path);
        let listener = UnixListener::bind(&sock_path).unwrap();

        let (read_fd, _write_fd) = super::surface::create_wakeup_pipe().unwrap();
        let cancelled = AtomicBool::new(true);
        let err = connect_unix_socket_with_timeout(
            &sock_path,
            Instant::now() + Duration::from_secs(2),
            Some((&read_fd, &cancelled)),
        )
        .unwrap_err();
        assert!(err.contains("取消"), "unexpected error: {err}");

        let active = AtomicBool::new(false);
        let stream = connect_unix_socket_with_timeout(
            &sock_path,
            Instant::now() + Duration::from_secs(2),
            Some((&read_fd, &active)),
        )
        .unwrap();
        drop(stream);
        drop(listener);
        let _ = std::fs::remove_file(&sock_path);
    }
}
