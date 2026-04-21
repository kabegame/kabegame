fn main() {
    // tauri_build only needed for local (Tauri native) builds.
    // #[cfg] is a compile-time gate so tauri_build doesn't need to be linked in web mode.
    #[cfg(feature = "local")]
    tauri_build::build();

    // Rust check-cfg: declare custom cfg keys used in this crate.
    // We inject `--cfg desktop="plasma"` or `--cfg desktop="gnome"` at compile-time (via scripts/run.js --desktop),
    // so silence `unexpected_cfgs` warnings by declaring the allowed values here.
    println!("cargo:rustc-check-cfg=cfg(desktop, values(\"plasma\", \"gnome\"))");
    println!("cargo:rustc-check-cfg=cfg(kabegame_mode, values(\"standard\", \"light\", \"android\", \"web\"))");
    println!(
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"main\", \"cli\", \"unknown\"))"
    );
    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    // Keep consistent with kabegame-core build.rs:
    // expose KABEGAME_BUILD_MODE (= standard|light|android) to this crate as well,
    // so app-main can answer `get_build_mode` without depending on kabegame-core::plugin.
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");
    let mode = std::env::var("KABEGAME_MODE").unwrap_or_else(|_| "standard".to_string());
    let normalized = match mode.as_str() {
        "light" => "light",
        "android" => "android",
        "web" => "web",
        _ => "standard",
    };
    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);
    println!("cargo:rustc-cfg=kabegame_mode=\"{}\"", normalized);

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
    if normalized == "standard" {
        #[cfg(all(target_os = "windows", target_env = "msvc"))]
        {
            // Needed for /DELAYLOAD.
            println!("cargo:rustc-link-lib=delayimp");
            // Delay-load dokan2.dll; binary won't fail to launch if the DLL is absent.
            println!("cargo:rustc-link-arg=/DELAYLOAD:dokan2.dll");
        }
    }
}
