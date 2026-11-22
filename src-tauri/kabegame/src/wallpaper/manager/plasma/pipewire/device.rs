//! 找合成器的主显示设备（render node）。dmabuf 必须分配在这张卡上：KPipeWire 不做设备协商，在别的卡上分配的
//! dmabuf 它导入报 `EGL_BAD_ALLOC`，逐个剔掉 modifier 重协商、最后才落到共享内存（P0 实测约 200 ms、12 次）。
//! CEF 的 GPU 进程在 Wayland 下也按合成器的主设备选卡，所以两边自然在同一张卡上。
//!
//! Wayland：`zwp_linux_dmabuf_v1` v4 的默认 feedback 的 `main_device`（Chromium 选卡用的也是它）。X11 不找：plasmashell 默认
//! 用 GLX，KPipeWire 导入不了 dmabuf，本来就走共享内存。
//!
//! 环境变量 `KABEGAME_PIPEWIRE_RENDER_NODE`：`none` / `off` / `0` 关掉 dmabuf（离屏 browser 走软件绘制、流只给共享内存），
//! 其它值当作 render node 路径直接用（调试多卡用）。

use std::path::{Path, PathBuf};

use wayland_client::protocol::wl_registry;
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_dmabuf_feedback_v1::{
    self, ZwpLinuxDmabufFeedbackV1,
};
use wayland_protocols::wp::linux_dmabuf::zv1::client::zwp_linux_dmabuf_v1::{
    self, ZwpLinuxDmabufV1,
};

const ENV_OVERRIDE: &str = "KABEGAME_PIPEWIRE_RENDER_NODE";

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

/// 单独连一次合成器，读默认 feedback 的 `main_device`，读完就断开。
fn wayland_main_device() -> Result<libc::dev_t, String> {
    let conn = Connection::connect_to_env().map_err(|e| format!("连不上 Wayland 合成器: {e}"))?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut probe = Probe::default();
    queue
        .roundtrip(&mut probe)
        .map_err(|e| format!("Wayland roundtrip 失败: {e}"))?;
    let Some(dmabuf) = probe.dmabuf.clone() else {
        return Err("合成器没有 zwp_linux_dmabuf_v1 v4".to_string());
    };
    let feedback = dmabuf.get_default_feedback(&qh, ());
    // feedback 的事件在一两轮 roundtrip 内到齐，以 done 收尾
    for _ in 0..4 {
        if probe.done {
            break;
        }
        queue
            .roundtrip(&mut probe)
            .map_err(|e| format!("Wayland roundtrip 失败: {e}"))?;
    }
    feedback.destroy();
    dmabuf.destroy();
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
