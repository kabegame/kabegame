fn main() {
    use std::env;

    // Build-time mode injection:
    // - KABEGAME_MODE=normal | local
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE") / env!("KABEGAME_BUILTIN_PLUGINS")
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
    // - local mode: all plugins are built-in
    // - normal mode: empty list
    let builtins = if normalized == "local" {
        env::var("KABEGAME_BUILTIN_PLUGINS").unwrap_or_else(|_| "local-import".to_string())
    } else {
        String::new()
    };
    println!("cargo:rustc-env=KABEGAME_BUILTIN_PLUGINS={}", builtins);
}


