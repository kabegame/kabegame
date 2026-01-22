fn main() {
    tauri_build::build();

    // Rust check-cfg: declare custom cfg keys used in this crate.
    // We inject `--cfg desktop="plasma"` at compile-time (via scripts/run.js --plasma),
    // so silence `unexpected_cfgs` warnings by declaring the allowed values here.
    println!("cargo:rustc-check-cfg=cfg(desktop, values(\"plasma\"))");

    // Keep consistent with kabegame-core build.rs:
    // expose KABEGAME_BUILD_MODE (= normal|local) to this crate as well,
    // so app-main can answer `get_build_mode` without depending on kabegame-core::plugin.
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    let mode = std::env::var("KABEGAME_MODE").unwrap_or_else(|_| "normal".to_string());
    let normalized = match mode.as_str() {
        "local" => "local",
        _ => "normal",
    };
    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);

    // On Windows, the virtual-driver feature depends on dokan2.dll.
    // Use delay-load so the app can start even when dokan2.dll isn't present;
    // we can then show a friendly error only when the user actually tries to mount VD.
    //
    // This only works on MSVC toolchain.
    let vd_enabled = std::env::var_os("CARGO_FEATURE_virtual_driver").is_some();
    if vd_enabled {
        #[cfg(all(target_os = "windows", target_env = "msvc"))]
        {
            // Needed for /DELAYLOAD.
            println!("cargo:rustc-link-lib=delayimp");
            // Delay-load dokan2.dll; binary won't fail to launch if the DLL is absent.
            println!("cargo:rustc-link-arg=/DELAYLOAD:dokan2.dll");
        }
    }
}
