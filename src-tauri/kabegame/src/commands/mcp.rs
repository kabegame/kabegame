use kabegame_core::settings::Settings;

use crate::mcp_capabilities::{all_mcp_capabilities, McpCapability};
use crate::mcp_service::McpService;

// ── 单键 getter（供 settings descriptor 的单键 refresh；批量读仍走 get_settings）──

#[tauri::command]
pub fn get_mcp_enabled() -> bool {
    Settings::global().get_mcp_enabled()
}

#[tauri::command]
pub fn get_mcp_port() -> u32 {
    Settings::global().get_mcp_port()
}

#[tauri::command]
pub fn get_mcp_disabled_capabilities() -> Vec<String> {
    Settings::global().get_mcp_disabled_capabilities()
}

// ── setter（走 settings 架构：内部 set_* 会 emit_setting_change 同步前端）──

#[tauri::command]
pub async fn set_mcp_enabled(enabled: bool) -> Result<(), String> {
    let settings = Settings::global();
    let service = McpService::global();
    if enabled {
        let port: u16 = settings
            .get_mcp_port()
            .try_into()
            .map_err(|_| "MCP 端口设置超出有效范围".to_string())?;
        // 先启动，成功后才落盘 enabled：启动失败（如端口占用）直接返回 Err，
        // 设置保持关闭、不发 setting-change，前端 save 抛错并提示，开关不动。
        service.start(port).await?;
        settings.set_mcp_enabled(true)?;
    } else {
        service.stop().await;
        settings.set_mcp_enabled(false)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_mcp_port(port: u16) -> Result<(), String> {
    let settings = Settings::global();
    let service = McpService::global();
    // 运行中改端口需重启到新端口；重启失败（新端口占用）返回 Err，不落盘端口。
    if service.is_running() {
        service.restart(port).await?;
    }
    settings.set_mcp_port(port.into())?;
    Ok(())
}

#[tauri::command]
pub fn set_mcp_disabled_capabilities(disabled: Vec<String>) -> Result<(), String> {
    Settings::global().set_mcp_disabled_capabilities(disabled)
}

// ── 能力清单（元数据，非设置项）──

#[tauri::command]
pub fn get_mcp_capabilities() -> Vec<McpCapability> {
    all_mcp_capabilities().to_vec()
}
