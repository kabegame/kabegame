use kabegame_core::settings::Settings;

use crate::mcp_capabilities::{all_mcp_capabilities, McpCapability};
#[tauri::command]
pub fn get_mcp_disabled_capabilities() -> Vec<String> {
    Settings::global().get_mcp_disabled_capabilities()
}

// ── setter（走 settings 架构：内部 set_* 会 emit_setting_change 同步前端）──

#[tauri::command]
pub fn set_mcp_disabled_capabilities(disabled: Vec<String>) -> Result<(), String> {
    Settings::global().set_mcp_disabled_capabilities(disabled)
}

// ── 能力清单（元数据，非设置项）──

#[tauri::command]
pub fn get_mcp_capabilities() -> Vec<McpCapability> {
    all_mcp_capabilities().to_vec()
}
