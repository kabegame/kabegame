fn main() {
    tauri_build::build();

    // Rust check-cfg: declare custom cfg keys used in this crate.
    // We inject `--cfg desktop="plasma"` or `--cfg desktop="gnome"` at compile-time (via scripts/run.js --desktop),
    // so silence `unexpected_cfgs` warnings by declaring the allowed values here.
    println!("cargo:rustc-check-cfg=cfg(desktop, values(\"plasma\", \"gnome\"))");
    println!("cargo:rustc-check-cfg=cfg(kabegame_mode, values(\"normal\", \"local\", \"light\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"plugin-editor\", \"cli\", \"unknown\"))"
    );

    // Keep consistent with kabegame-core build.rs:
    // expose KABEGAME_BUILD_MODE (= normal|local|light) to this crate as well,
    // so app-main can answer `get_build_mode` without depending on kabegame-core::plugin.
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    let mode = std::env::var("KABEGAME_MODE").unwrap_or_else(|_| "normal".to_string());
    let normalized = match mode.as_str() {
        "local" => "local",
        "light" => "light",
        _ => "normal",
    };
    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);
    println!("cargo:rustc-cfg=kabegame_mode=\"{}\"", normalized);

    let component = std::env::var("KABEGAME_COMPONENT").unwrap_or_else(|_| "unknown".to_string());
    let component = match component.as_str() {
        "main" => "main",
        "plugin-editor" => "plugin-editor",
        "cli" => "cli",
        _ => "unknown",
    };
    println!("cargo:rustc-cfg=kabegame_component=\"{}\"", component);
    let vd_feature_enabled = std::env::var_os("CARGO_FEATURE_VIRTUAL_DRIVER").is_some();

    // On Windows, the virtual-driver feature depends on dokan2.dll.
    // Use delay-load so the app can start even when dokan2.dll isn't present;
    // we can then show a friendly error only when the user actually tries to mount VD.
    //
    // This only works on MSVC toolchain.
    if normalized != "light" && vd_feature_enabled {
        #[cfg(all(target_os = "windows", target_env = "msvc"))]
        {
            // Needed for /DELAYLOAD.
            println!("cargo:rustc-link-lib=delayimp");
            // Delay-load dokan2.dll; binary won't fail to launch if the DLL is absent.
            println!("cargo:rustc-link-arg=/DELAYLOAD:dokan2.dll");
        }
    }
}
