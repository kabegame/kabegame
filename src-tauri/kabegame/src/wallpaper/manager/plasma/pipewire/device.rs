//! 找合成器的主显示设备（render node）。dmabuf 必须分配在这张卡上：插件的消费端不做设备协商，在别的卡上分配的
//! dmabuf 导入失败（KPipeWire 时代报 `EGL_BAD_ALLOC`），消费端就整路改用共享内存重新连。
//! CEF 的 GPU 进程在 Wayland 下也按合成器的主设备选卡，所以两边自然在同一张卡上。
//!
//! Wayland：`zwp_linux_dmabuf_v1` v4 的默认 feedback 的 `main_device`（Chromium 选卡用的也是它）。X11 不找：plasmashell 默认
//! 用 GLX，消费端没有 EGL 就只要共享内存。
//!
//! 环境变量 `KABEGAME_PIPEWIRE_RENDER_NODE`：`none` / `off` / `0` 关掉 dmabuf（离屏 browser 走软件绘制、流只给共享内存），
//! 其它值当作 render node 路径直接用（调试多卡用）。

use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use wayland_client::backend::WaylandError;
use wayland_client::protocol::{wl_callback, wl_registry};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_dmabuf_feedback_v1::{
    self, ZwpLinuxDmabufFeedbackV1,
};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_dmabuf_v1::{
    self, ZwpLinuxDmabufV1,
};

const ENV_OVERRIDE: &str = "KABEGAME_PIPEWIRE_RENDER_NODE";
const DEVICE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// dmabuf 推流用哪张卡；`None` 表示不走 dmabuf（原因已记日志）。
pub fn render_node() -> Option<PathBuf> {
    if let Ok(value) = std::env::var(ENV_OVERRIDE) {
        let value = value.trim();
        if matches!(value, "" | "none" | "off" | "0") {
            tracing::info!("{ENV_OVERRIDE}={value:?}：壁纸推流不用 dmabuf");
            return None;
        }
        return Some(PathBuf::from(value));
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_none_or(|display| display.is_empty()) {
        tracing::info!("不是 Wayland 会话：壁纸推流只用共享内存");
        return None;
    }
    let dev = match wayland_main_device() {
        Ok(dev) => dev,
        Err(e) => {
            tracing::warn!("取合成器的主显示设备失败，壁纸推流只用共享内存: {e}");
            return None;
        }
    };
    match render_node_for_dev(dev) {
        Some(node) => {
            tracing::info!(
                "合成器的主显示设备 {}:{} → {}",
                libc::major(dev),
                libc::minor(dev),
                node.display()
            );
            Some(node)
        }
        None => {
            tracing::warn!(
                "合成器的主显示设备 {}:{} 找不到对应的 render node，壁纸推流只用共享内存",
                libc::major(dev),
                libc::minor(dev)
            );
            None
        }
    }
}

#[derive(Default)]
struct Probe {
    dmabuf: Option<ZwpLinuxDmabufV1>,
    main_device: Option<libc::dev_t>,
    done: bool,
    sync_done: bool,
}

impl Dispatch<wl_registry::WlRegistry, ()> for Probe {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == ZwpLinuxDmabufV1::interface().name && version >= 4 {
                state.dmabuf = Some(registry.bind::<ZwpLinuxDmabufV1, _, _>(name, 4, qh, ()));
            }
        }
    }
}

impl Dispatch<ZwpLinuxDmabufV1, ()> for Probe {
    fn event(
        _: &mut Self,
        _: &ZwpLinuxDmabufV1,
        _: zwp_linux_dmabuf_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwpLinuxDmabufFeedbackV1, ()> for Probe {
    fn event(
        state: &mut Self,
        _: &ZwpLinuxDmabufFeedbackV1,
        event: zwp_linux_dmabuf_feedback_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwp_linux_dmabuf_feedback_v1::Event::MainDevice { device } => {
                // 协议：dev_t 按本机字节序原样放进数组
                if let Ok(bytes) = <[u8; std::mem::size_of::<libc::dev_t>()]>::try_from(device.as_slice()) {
                    state.main_device = Some(libc::dev_t::from_ne_bytes(bytes));
                }
            }
            zwp_linux_dmabuf_feedback_v1::Event::Done => state.done = true,
            _ => {}
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

fn is_would_block(err: &WaylandError) -> bool {
    matches!(err, WaylandError::Io(io_err) if io_err.kind() == std::io::ErrorKind::WouldBlock)
}

fn roundtrip_probe(
    conn: &Connection,
    queue: &mut wayland_client::EventQueue<Probe>,
    qh: &QueueHandle<Probe>,
    probe: &mut Probe,
    deadline: Instant,
) -> Result<(), String> {
    probe.sync_done = false;
    conn.display().sync(qh, ());
    let mut need_flush = true;

    while !probe.sync_done {
        queue
            .dispatch_pending(probe)
            .map_err(|e| format!("Wayland 分发失败: {e}"))?;
        if probe.sync_done {
            break;
        }
        if need_flush {
            match conn.flush() {
                Ok(()) => need_flush = false,
                Err(ref e) if is_would_block(e) => need_flush = true,
                Err(e) => return Err(format!("Wayland flush 失败: {e}")),
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("Wayland roundtrip 超时".to_string());
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
        // SAFETY: `pfd.fd` 来自本次有效的 `guard`。
        let polled = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if polled < 0 {
            let err = std::io::Error::last_os_error();
            drop(guard);
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Wayland poll 失败: {err}"));
        }
        if pfd.revents & libc::POLLIN != 0 {
            match guard.read() {
                Ok(_) => {}
                Err(ref e) if is_would_block(e) => {}
                Err(e) => return Err(format!("Wayland 读事件失败: {e}")),
            }
        } else {
            drop(guard);
        }
        if pfd.revents & libc::POLLOUT != 0 {
            need_flush = true;
        }
        if pfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
            return Err("Wayland 连接断开".to_string());
        }
    }
    Ok(())
}

/// 单独连一次合成器，读默认 feedback 的 `main_device`，读完就断开。
fn wayland_main_device() -> Result<libc::dev_t, String> {
    let deadline = Instant::now() + DEVICE_PROBE_TIMEOUT;
    let conn = crate::wallpaper::manager::layer_shell::connect_wayland_with_timeout(deadline, None)?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut probe = Probe::default();
    roundtrip_probe(&conn, &mut queue, &qh, &mut probe, deadline)?;
    let Some(dmabuf) = probe.dmabuf.clone() else {
        return Err("合成器没有 zwp_linux_dmabuf_v1 v4".to_string());
    };
    let feedback = dmabuf.get_default_feedback(&qh, ());
    // feedback 的事件在一两轮 roundtrip 内到齐，以 done 收尾
    for _ in 0..4 {
        if probe.done {
            break;
        }
        roundtrip_probe(&conn, &mut queue, &qh, &mut probe, deadline)?;
    }
    feedback.destroy();
    dmabuf.destroy();
    let _ = conn.flush();
    probe
        .main_device
        .ok_or_else(|| "默认 feedback 没有给 main_device".to_string())
}

/// 设备号（可能是 card 节点，也可能就是 render node）→ 同一块 GPU 的 render node：按 sysfs 里的 `device` 链接比对。
fn render_node_for_dev(dev: libc::dev_t) -> Option<PathBuf> {
    let sys_device = std::fs::canonicalize(format!(
        "/sys/dev/char/{}:{}/device",
        libc::major(dev),
        libc::minor(dev)
    ))
    .ok()?;
    let entries = std::fs::read_dir("/dev/dri").ok()?;
    let mut nodes: Vec<String> = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("renderD"))
        .collect();
    nodes.sort();
    nodes.into_iter().find_map(|name| {
        let device = std::fs::canonicalize(Path::new("/sys/class/drm").join(&name).join("device")).ok()?;
        (device == sys_device).then(|| Path::new("/dev/dri").join(name))
    })
}
