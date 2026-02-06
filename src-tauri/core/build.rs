fn main() {
    use std::env;

    // Build-time mode injection:
    // - KABEGAME_MODE=normal | local | light
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE") / env!("KABEGAME_BUILTIN_PLUGINS")
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_BUILTIN_PLUGINS");

    println!("cargo:rustc-check-cfg=cfg(kabegame_mode, values(\"normal\", \"local\", \"light\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"cli\", \"unknown\"))"
    );

    let mode = env::var("KABEGAME_MODE").unwrap_or_else(|_| "normal".to_string());
    let normalized = match mode.as_str() {
        "local" => "local",
        "light" => "light",
        _ => "normal",
    };

    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);
    println!("cargo:rustc-cfg=kabegame_mode=\"{}\"", normalized);

    let component = env::var("KABEGAME_COMPONENT").unwrap_or_else(|_| "unknown".to_string());
    let component = match component.as_str() {
        "main" => "main",
        "cli" => "cli",
        _ => "unknown",
    };
    println!("cargo:rustc-cfg=kabegame_component=\"{}\"", component);

    // Builtin plugins list (comma-separated):
    // - local mode: all plugins are built-in
    // - normal mode: empty list
    let builtins =
        env::var("KABEGAME_BUILTIN_PLUGINS").unwrap_or_else(|_| "local-import".to_string());
    println!("cargo:rustc-env=KABEGAME_BUILTIN_PLUGINS={}", builtins);
}
