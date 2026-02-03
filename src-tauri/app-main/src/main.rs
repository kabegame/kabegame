// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    kabegame_core::workarounds::apply_nvidia_dmabuf_renderer_workaround();

    kabegame::run();
}
