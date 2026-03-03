use std::env;
use std::sync::OnceLock;

/// 运行时检测到的 Linux 桌面环境
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxDesktop {
    Plasma,
    Gnome,
    Unknown,
}

#[cfg(target_os = "linux")]
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
pub fn linux_desktop() -> LinuxDesktop {
    #[cfg(target_os = "linux")]
    {
        *LINUX_DESKTOP
            .get()
            .unwrap_or(&LinuxDesktop::Unknown)
    }

    #[cfg(not(target_os = "linux"))]
    {
        LinuxDesktop::Unknown
    }
}

#[cfg(target_os = "linux")]
fn detect_linux_desktop() -> LinuxDesktop {
    // 1. 优先通过环境变量判定
    if let Some(from_env) = detect_from_env() {
        return from_env;
    }

    // 2. 能力探测兜底
    if detect_gnome_capability() {
        return LinuxDesktop::Gnome;
    }
    if detect_plasma_capability() {
        return LinuxDesktop::Plasma;
    }

    // 3. 仍无法判断则 Unknown
    LinuxDesktop::Unknown
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

