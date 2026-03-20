// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        kabegame_core::workarounds::apply_wayland_webkit_workaround();
        kabegame_core::workarounds::apply_nvidia_dmabuf_renderer_workaround();
    }
    // 单例检测：若已有实例在运行则转发请求并退出（必须在 init_shortcut 之前，避免第二实例注册快捷键失败导致 panic）
    kabegame::startup::try_forward_to_existing_instance_and_exit();
    kabegame::run();
}
