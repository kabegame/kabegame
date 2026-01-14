fn main() {
    tauri_build::build();

    // On Windows, the virtual-drive feature depends on dokan2.dll.
    // Use delay-load so the app can start even when dokan2.dll isn't present;
    // we can then show a friendly error only when the user actually tries to mount VD.
    //
    // This only works on MSVC toolchain.
    let vd_enabled = std::env::var_os("CARGO_FEATURE_VIRTUAL_DRIVE").is_some();
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
