fn main() {
    // tauri_build only needed when the Tauri native stack is enabled
    // (standard / light / android features). #[cfg] is compile-time so tauri_build isn't linked in web mode.
    #[cfg(any(feature = "standard", feature = "light", feature = "android"))]
    tauri_build::build();

    // Rust check-cfg: declare custom cfg keys used in this crate.
    // We inject `--cfg desktop="plasma"` or `--cfg desktop="gnome"` at compile-time (via scripts/run.js --desktop),
    // so silence `unexpected_cfgs` warnings by declaring the allowed values here.
    println!("cargo:rustc-check-cfg=cfg(desktop, values(\"plasma\", \"gnome\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"cli\", \"unknown\"))"
    );
    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");

    let component = std::env::var("KABEGAME_COMPONENT").unwrap_or_else(|_| "unknown".to_string());
    let component = match component.as_str() {
        "main" => "main",
        "cli" => "cli",
        _ => "unknown",
    };
    println!("cargo:rustc-cfg=kabegame_component=\"{}\"", component);

    let data = std::env::var("KABEGAME_DATA").unwrap_or_else(|_| "prod".to_string());
    let normalized_data = match data.as_str() {
        "dev" => "dev",
        _ => "prod",
    };
    println!("cargo:rustc-cfg=kabegame_data=\"{}\"", normalized_data);

    // On Windows, the virtual-driver feature depends on dokan2.dll.
    // Use delay-load so the app can start even when dokan2.dll isn't present;
    // we can then show a friendly error only when the user actually tries to mount VD.
    //
    // This only works on MSVC toolchain.
    #[cfg(all(feature = "standard", target_os = "windows", target_env = "msvc"))]
    {
        // Needed for /DELAYLOAD.
        println!("cargo:rustc-link-lib=delayimp");
        // Delay-load dokan2.dll; binary won't fail to launch if the DLL is absent.
        println!("cargo:rustc-link-arg=/DELAYLOAD:dokan2.dll");
    }
}
