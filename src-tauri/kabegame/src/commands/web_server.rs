use kabegame_core::settings::Settings;

use crate::web_server_service::WebServerService;

#[tauri::command]
pub fn get_web_server_enabled() -> bool {
    Settings::global().get_web_server_enabled()
}

#[tauri::command]
pub fn get_web_server_port() -> u32 {
    Settings::global().get_web_server_port()
}

#[tauri::command]
pub fn get_web_server_lan_access() -> bool {
    Settings::global().get_web_server_lan_access()
}

/// 本机局域网 IPv4，供设置页拼出局域网访问地址；探测不到时返回 `None`。
///
/// UDP `connect` 只让系统按路由表选出出口网卡、不发任何包，读 `local_addr`
/// 即得该网卡地址；无默认路由（离线）时 connect 失败。
#[tauri::command]
pub fn get_web_server_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect(("8.8.8.8", 80)).ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => {
            Some(ip.to_string())
        }
        _ => None,
    }
}

#[tauri::command]
pub async fn set_web_server_enabled(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();
    let service = WebServerService::global();
    if enabled {
        let port: u16 = settings
            .get_web_server_port()
            .try_into()
            .map_err(|_| "Web 服务器端口设置超出有效范围".to_string())?;
        let lan = settings.get_web_server_lan_access();
        // 先成功绑定再落盘；端口占用时设置保持关闭。
        service.start(port, lan).await?;
        settings.set_web_server_enabled(true)?;
    } else {
        service.stop().await;
        settings.set_web_server_enabled(false)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_web_server_port(port: u16) -> Result<(), String> {
    let settings = Settings::global();
    let service = WebServerService::global();
    if service.is_running() {
        let lan = settings.get_web_server_lan_access();
        if let Err(e) = service.restart(port, lan).await {
            disable_after_restart_failure(settings);
            return Err(e);
        }
    }
    settings.set_web_server_port(port.into())
}

#[tauri::command]
pub async fn set_web_server_lan_access(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();
    let service = WebServerService::global();
    if service.is_running() {
        let port: u16 = settings
            .get_web_server_port()
            .try_into()
            .map_err(|_| "Web 服务器端口设置超出有效范围".to_string())?;
        if let Err(e) = service.restart(port, enabled).await {
            disable_after_restart_failure(settings);
            return Err(e);
        }
    }
    settings.set_web_server_lan_access(enabled)
}

/// 重启失败时旧监听器已停，服务实际处于关闭态：把 enabled 落为 false，
/// setter 会发 setting-change，前端开关随之自动关闭；新端口 / 局域网值不落盘。
fn disable_after_restart_failure(settings: &Settings) {
    if let Err(e) = settings.set_web_server_enabled(false) {
        eprintln!("[Web Server] 重启失败后关闭开关失败: {e}");
    }
}
