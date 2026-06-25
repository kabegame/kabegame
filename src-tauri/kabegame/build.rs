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
        "cargo:rustc-check-cfg=cfg(kabegame_component, values(\"kabegame\", \"kabegame-cli\", \"unknown\"))"
    );
    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    println!("cargo:rerun-if-env-changed=KABEGAME_COMPONENT");
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");

    let component = std::env::var("KABEGAME_COMPONENT").unwrap_or_else(|_| "unknown".to_string());
    let component = match component.as_str() {
        "kabegame" => "kabegame",
        "kabegame-cli" => "kabegame-cli",
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

    // Bundled shared libs live in:
    //   Linux .deb → /usr/lib/kabegame/   (binary at /usr/bin/kabegame)
    //   macOS .app → Contents/Frameworks/ (binary at Contents/MacOS/Kabegame)
    // See cocs/build/PLATFORM_SHARED_LIBS.md.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");
        println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");

        // Linux CEF backend (standard/light): hide the bundled SQLite (rusqlite)
        // symbols from the dynamic symbol table.
        //
        // Chromium/CEF performs TLS certificate verification via NSS, which
        // dlopen()s libsoftokn3 → system libsqlite3 to open its cert DB. Because
        // the MAIN executable's global symbols take precedence, softokn binds
        // `sqlite3_*` to OUR statically-linked SQLite (rusqlite, 3.45.0) instead
        // of the system libsqlite3 (3.46.1) it was built against → mismatched
        // VFS/struct layout → call through a null pointer → SIGSEGV on startup.
        //
        // Localizing `sqlite3_*` makes softokn resolve to the system libsqlite3;
        // our own rusqlite calls are resolved at static-link time and unaffected.
        // (This was the real cause of the CEF crash — NOT the tao runtime.)
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok()
            || std::env::var("CARGO_FEATURE_LIGHT").is_ok()
        {
            let out = std::env::var("OUT_DIR").unwrap();
            let map = std::path::Path::new(&out).join("hide-sqlite-symbols.map");
            std::fs::write(&map, "{\n  local:\n    sqlite3_*;\n};\n")
                .expect("write sqlite version script");
            println!(
                "cargo:rustc-link-arg=-Wl,--version-script={}",
                map.display()
            );
        }
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
}
