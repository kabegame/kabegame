fn main() {
    use std::env;

    // Build-time injection:
    // - KABEGAME_COMPONENT=kabegame | kabegame-cli | unknown
    // - KABEGAME_DATA=dev | prod
    // Mode (standard / light / android / web) is now expressed entirely via Cargo features
    // on the consumer crate (kabegame). Core only sees feature flags like `virtual-driver`.
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");

    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"kabegame\", \"kabegame-cli\", \"unknown\"))"
    );
    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    let component = env::var("KABEGAME_COMPONENT").unwrap_or_else(|_| "unknown".to_string());
    let component = match component.as_str() {
        "kabegame" => "kabegame",
        "kabegame-cli" => "kabegame-cli",
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
