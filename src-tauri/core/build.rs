fn main() {
    use std::env;

    // Build-time mode injection:
    // - KABEGAME_MODE=standard | light
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE")
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");

    println!("cargo:rustc-check-cfg=cfg(kabegame_mode, values(\"standard\", \"light\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"cli\", \"unknown\"))"
    );

    let mode = env::var("KABEGAME_MODE").unwrap_or_else(|_| "standard".to_string());
    let normalized = match mode.as_str() {
        "light" => "light",
        _ => "standard",
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

}
