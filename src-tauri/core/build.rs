fn main() {
    use std::env;

    // Build-time mode injection:
    // - KABEGAME_MODE=standard | light | android
    // - KABEGAME_DATA=dev | prod
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE")
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");

    println!("cargo:rustc-check-cfg=cfg(kabegame_mode, values(\"standard\", \"light\", \"android\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"cli\", \"unknown\"))"
    );
    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    let mode = env::var("KABEGAME_MODE").unwrap_or_else(|_| "standard".to_string());
    let normalized = match mode.as_str() {
        "light" => "light",
        "android" => "android",
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

    let data = env::var("KABEGAME_DATA").unwrap_or_else(|_| "prod".to_string());
    let normalized_data = match data.as_str() {
        "dev" => "dev",
        _ => "prod",
    };
    println!("cargo:rustc-cfg=kabegame_data=\"{}\"", normalized_data);
}
