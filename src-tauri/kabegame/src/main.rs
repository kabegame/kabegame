// Prevents additional console window on Windows in release (local/Tauri GUI only).
// Web mode is a console server — keep the default console subsystem so stdout/stderr are visible.
#![cfg_attr(
    all(not(debug_assertions), not(feature = "web")),
    windows_subsystem = "windows"
)]

fn main() {
    #[cfg(all(
        target_os = "linux",
        not(feature = "web"),
        any(feature = "standard", feature = "light")
    ))]
    tauri_runtime_cef::execute_cef_subprocess_and_exit();

    #[cfg(all(
        target_os = "linux",
        any(feature = "web", not(any(feature = "standard", feature = "light")))
    ))]
    {
        kabegame_core::workarounds::apply_wayland_webkit_workaround();
        kabegame_core::workarounds::apply_nvidia_dmabuf_renderer_workaround();
    }
    // 单例检测：若已有实例在运行则转发请求并退出（必须在 init_shortcut 之前，避免第二实例注册快捷键失败导致 panic）
    #[cfg(all(
        not(feature = "web"),
        not(all(target_os = "linux", any(feature = "standard", feature = "light")))
    ))]
    kabegame::startup::try_forward_to_existing_instance_and_exit();
    kabegame::run();
}
