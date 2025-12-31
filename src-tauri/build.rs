fn main() {
    use std::env;

    // Build-time mode injection:
    // - KABEGAME_MODE=normal | local
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE")
    // - Also provide a compile-time cfg for optional conditional compilation
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_BUILTIN_PLUGINS");

    let mode = env::var("KABEGAME_MODE").unwrap_or_else(|_| "normal".to_string());
    let normalized = match mode.as_str() {
        "local" => "local",
        _ => "normal",
    };

    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);
    if normalized == "local" {
        // Allow `#[cfg(kabegame_mode_local)]` in code.
        println!("cargo:rustc-cfg=kabegame_mode_local");
    }

    // Builtin plugins list (comma-separated):
    // - local mode: all plugins are built-in (immutable, cannot be uninstalled)
    // - normal mode: no built-in concept (empty list)
    let builtins = if normalized == "local" {
        // 可通过环境变量自定义，否则用默认全量列表
        env::var("KABEGAME_BUILTIN_PLUGINS").unwrap_or_else(|_| {
            // 这种情况不应该出现
            "single-file-import,local-folder-import".to_string()
        })
    } else {
        // normal 模式没有内置概念
        String::new()
    };
    println!("cargo:rustc-env=KABEGAME_BUILTIN_PLUGINS={}", builtins);

    tauri_build::build()
}
