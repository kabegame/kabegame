#![cfg(target_os = "linux")]

use std::env;
use std::sync::OnceLock;



/// 运行时检测到的 Linux 桌面环境
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxDesktop {
    Plasma,
    Gnome,
    Unknown,
}

static LINUX_DESKTOP: OnceLock<LinuxDesktop> = OnceLock::new();

/// 启动时调用一次，检测并写入缓存
pub fn init_linux_desktop() -> LinuxDesktop {
    #[cfg(target_os = "linux")]
    {
        let detected = detect_linux_desktop();
        let _ = LINUX_DESKTOP.set(detected);
        println!(
            "[LINUX_DESKTOP] detected desktop environment: {:?}",
            detected
        );
        detected
    }

    #[cfg(not(target_os = "linux"))]
    {
        LinuxDesktop::Unknown
    }
}

/// 业务代码读取缓存结果；若尚未初始化，则返回 Unknown
#[cfg(target_os = "linux")]
pub fn linux_desktop() -> LinuxDesktop {
    *LINUX_DESKTOP
        .get()
        .unwrap_or(&LinuxDesktop::Unknown)
}

fn detect_linux_desktop() -> LinuxDesktop {
    // 1. 优先通过环境变量判定
    if let Some(from_env) = detect_from_env() {
        return from_env;
    }

    // 2. 用 systemctl --user 看实际在跑的桌面服务，比 gsettings 能力探测更稳妥
    //    （Plasma 上常有 gsettings，单靠能力探测会误判为 GNOME）
    if let Some(from_systemd) = detect_from_systemd_services() {
        return from_systemd;
    }

    // 3. 能力探测兜底（无 systemctl 或非 user session 时）
    if detect_plasma_capability() {
        return LinuxDesktop::Plasma;
    }
    if detect_gnome_capability() {
        return LinuxDesktop::Gnome;
    }

    LinuxDesktop::Unknown
}

fn detect_from_env() -> Option<LinuxDesktop> {
    fn env_lower(name: &str) -> Option<String> {
        env::var(name).ok().map(|v| v.to_lowercase())
    }

    let xdg_current = env_lower("XDG_CURRENT_DESKTOP");
    let xdg_session = env_lower("XDG_SESSION_DESKTOP");
    let desktop_session = env_lower("DESKTOP_SESSION");

    let kde_full = env_lower("KDE_FULL_SESSION");
    let kde_version = env_lower("KDE_SESSION_VERSION");

    let all = [
        xdg_current.as_deref(),
        xdg_session.as_deref(),
        desktop_session.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    // 若存在 KDE 相关环境变量，则优先认为是 Plasma
    if kde_full.is_some() || kde_version.is_some() {
        return Some(LinuxDesktop::Plasma);
    }

    // 环境变量中包含 plasma/kde
    if all.iter().any(|v| v.contains("plasma") || v.contains("kde")) {
        return Some(LinuxDesktop::Plasma);
    }

    // 环境变量中包含 gnome/ubuntu:gnome 等
    if all.iter().any(|v| v.contains("gnome")) {
        return Some(LinuxDesktop::Gnome);
    }

    None
}

/// 通过 systemctl --user list-units 检测实际运行的桌面服务，避免仅因存在 gsettings 误判为 GNOME。
/// 与 README 中「根据输出选择 Plasma 或 GNOME 安装包」的检查方式一致。
fn detect_from_systemd_services() -> Option<LinuxDesktop> {
    use std::process::Command;

    let output = Command::new("systemctl")
        .args(["--user", "list-units", "--type=service"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lower = stdout.to_lowercase();
    // 先匹配 plasma，再匹配 gnome，避免 Plasma 上同时有 gnome 相关服务时误判
    eprintln!("detected: {}", lower);
    if lower.contains("plasma") {
        return Some(LinuxDesktop::Plasma);
    }
    if lower.contains("gnome") {
        return Some(LinuxDesktop::Gnome);
    }
    // 可选：xfce/cinnamon/mate/sway/hyprland 等当前映射为 Unknown，后续可扩展
    None
}

#[cfg(target_os = "linux")]
fn detect_gnome_capability() -> bool {
    use std::process::Command;

    let output = Command::new("gsettings")
        .args([
            "get",
            "org.gnome.desktop.background",
            "picture-options",
        ])
        .output();

    match output {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn detect_plasma_capability() -> bool {
    use std::process::{Command, Stdio};

    // Plasma 6: qdbus6；Plasma 5: qdbus
    for program in ["qdbus6", "qdbus"] {
        match Command::new(program)
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(_) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => continue,
        }
    }

    false
}

