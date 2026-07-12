//! CEF renderer/GPU/utility subprocess entrypoint.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri_runtime_cef::run_cef_subprocess();
}
