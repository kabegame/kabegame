//! 代理配置：环境变量 + Windows 注册表系统代理
//!
//! 优先读取 HTTP_PROXY/HTTPS_PROXY 等环境变量；
//! 在 Windows 上，当环境变量未设置时，读取注册表中的系统代理配置
//! (HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings)。

/// 代理配置：代理 URL 与直连排除列表
#[derive(Default)]
pub struct ProxyConfig {
    /// 代理 URL，如 `http://127.0.0.1:7890`。HTTPS 请求也应通过 HTTP 协议连接代理。
    pub proxy_url: Option<String>,
    /// 直连排除列表，逗号分隔（NO_PROXY 语义）
    pub no_proxy: Option<String>,
}

/// 获取代理配置：优先环境变量，Windows 上环境变量未设置时读取注册表系统代理。
pub fn get_proxy_config() -> ProxyConfig {
    // 1. 环境变量
    let proxy_url = std::env::var("HTTP_PROXY")
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .or_else(|_| std::env::var("https_proxy"))
        .ok()
        .filter(|s| !s.trim().is_empty());

    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .ok()
        .filter(|s| !s.trim().is_empty());

    if proxy_url.is_some() {
        return ProxyConfig {
            proxy_url,
            no_proxy,
        };
    }

    // 2. Windows 注册表系统代理
    #[cfg(target_os = "windows")]
    {
        if let Some(reg_proxy) = get_windows_system_proxy() {
            let reg_no_proxy = get_windows_proxy_override();
            return ProxyConfig {
                proxy_url: Some(reg_proxy),
                no_proxy: reg_no_proxy.or(no_proxy),
            };
        }
    }

    ProxyConfig {
        proxy_url: None,
        no_proxy,
    }
}

/// Windows：从注册表读取系统代理地址。
/// 路径：HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
/// ProxyEnable=1 时读取 ProxyServer，解析为 http://host:port 格式。
#[cfg(target_os = "windows")]
fn get_windows_system_proxy() -> Option<String> {
    use winreg::RegKey;

    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;

    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled != 1 {
        return None;
    }

    let server: String = settings.get_value("ProxyServer").ok()?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }

    // 解析 ProxyServer 格式：
    // - http=127.0.0.1:7890;https=127.0.0.1:7890
    // - 127.0.0.1:7890
    let host_port = if let Some(idx) = server.find("https=") {
        let after = &server[idx + 6..];
        after.split(';').next().unwrap_or(after).trim()
    } else if let Some(idx) = server.find("http=") {
        let after = &server[idx + 5..];
        after.split(';').next().unwrap_or(after).trim()
    } else {
        server.split(';').next().unwrap_or(server).trim()
    };

    if host_port.is_empty() {
        return None;
    }

    // HTTPS 请求连接代理时应使用 http://，由代理做 CONNECT 隧道
    Some(format!(
        "http://{}",
        host_port.trim_start_matches("http://").trim_start_matches("https://")
    ))
}

/// Windows：从注册表读取 ProxyOverride（直连排除列表）。
#[cfg(target_os = "windows")]
fn get_windows_proxy_override() -> Option<String> {
    use winreg::RegKey;

    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;

    let override_val: String = settings.get_value("ProxyOverride").ok()?;
    let override_val = override_val.trim();
    if override_val.is_empty() {
        return None;
    }

    // ProxyOverride 使用分号分隔，NO_PROXY 使用逗号，转换为逗号
    let normalized = override_val.replace(';', ",");
    Some(normalized)
}
