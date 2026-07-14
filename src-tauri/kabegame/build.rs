fn main() {
    // tauri_build only needed when the Tauri native stack is enabled
    // (standard / light / android features). #[cfg] is compile-time so tauri_build isn't linked in web mode.
    //
    // Windows 用自定义 app manifest(windows-app.manifest):在 tauri 默认的
    // Common-Controls 之上追加 <compatibility> supportedOS 与 PerMonitorV2 DPI。
    // supportedOS 段是 CEF 的硬性要求:Chromium GPU 进程用 WS_EX_LAYERED 子窗口做
    // DirectComposition 呈现(ui/gl/child_window_win.cc),layered 子窗口只对声明了
    // Windows 8+ 兼容性的进程开放;缺失则 GPU 进程 CreateWindowEx 返回 NULL →
    // NOTREACHED 崩溃循环(CEF #3765)。kabegame.exe 会被 CEF re-exec 为 GPU/renderer
    // 子进程,所以主 exe 必须带它。
    // 注意:manifest 文件须保持纯 ASCII、无 XML 声明/注释 —— 它经 RC 资源编译器
    // 内嵌,非 ASCII 内容会被 codepage 弄坏 XML,触发启动报 sxs 14001。
    #[cfg(any(feature = "standard", feature = "android"))]
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest")),
    ))
    .expect("failed to run tauri-build");

    // Android JNI symbol package override.
    //
    // tao/wry export the native entry points as `Java_<domain>_<app_name>_Rust_*`,
    // where <domain>/<app_name> come from two rustc-env vars that `tauri-build`
    // (called by try_build above) derives from `config.identifier`: it splits on
    // '.' (all-but-last → PREFIX, last → APP_NAME). Kabegame's identifier is
    // per-mode (dev `app.kabegame.dev` / prod `app.kabegame`) for side-by-side
    // installs, so the stock derivation yields `Java_app_kabegame_dev_Rust_*` for
    // dev — but the Kotlin `Rust` class lives in the fixed `namespace`
    // (`app.kabegame`, decoupled from applicationId via the forked cargo-tauri +
    // TAURI_ANDROID_PACKAGE). The JVM then can't resolve the native method:
    //   UnsatisfiedLinkError: No implementation found for void app.kabegame.Rust.create()
    //
    // Re-emit both env vars from TAURI_ANDROID_PACKAGE (the stable Java package,
    // = AGP namespace) so the JNI symbol stays `Java_app_kabegame_Rust_*`
    // regardless of the per-mode applicationId. These println!s run AFTER
    // try_build, and cargo uses the LAST value for a duplicated rustc-env key, so
    // ours override tauri-build's identifier-derived values.
    // See cocs/tauri/TAURI_CLI_FORK.md.
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PACKAGE");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        if let Ok(pkg) = std::env::var("TAURI_ANDROID_PACKAGE") {
            if !pkg.is_empty() {
                let parts: Vec<&str> = pkg.split('.').collect();
                let last = parts.len() - 1;
                // Mirror tauri-build's exact escaping: app_name replaces only '-',
                // prefix words replace '_' and '-' with the JNI escape "_1".
                let app_name = parts[last].replace('-', "_");
                let prefix = parts[..last]
                    .iter()
                    .map(|w| w.replace(['_', '-'], "_1"))
                    .collect::<Vec<_>>()
                    .join("_");
                println!("cargo:rustc-env=TAURI_ANDROID_PACKAGE_NAME_APP_NAME={app_name}");
                println!("cargo:rustc-env=TAURI_ANDROID_PACKAGE_NAME_PREFIX={prefix}");
            }
        }
    }

    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");

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
        println!("cargo:rustc-link-arg-bin=kabegame=delayimp.lib");
        // Delay-load dokan2.dll; binary won't fail to launch if the DLL is absent.
        println!("cargo:rustc-link-arg-bin=kabegame=/DELAYLOAD:dokan2.dll");
    }

    // Bundled shared libs live in:
    //   Linux .deb → /usr/lib/kabegame/   (binary at /usr/bin/kabegame)
    //   macOS .app → Contents/Frameworks/ (binary at Contents/MacOS/Kabegame)
    // See cocs/build/PLATFORM_SHARED_LIBS.md.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bin=kabegame=-Wl,-rpath,$ORIGIN/../lib/kabegame");
        println!("cargo:rustc-link-arg-bin=kabegame=-Wl,--enable-new-dtags");
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok() {
            println!("cargo:rustc-link-arg-bin=kabegame-cef-helper=-Wl,-rpath,$ORIGIN");
            println!("cargo:rustc-link-arg-bin=kabegame-cef-helper=-Wl,--enable-new-dtags");
            println!("cargo:rustc-link-arg-bin=cef-example=-Wl,-rpath,$ORIGIN");
            println!("cargo:rustc-link-arg-bin=cef-example=-Wl,--enable-new-dtags");
        }

        // Linux CEF backend (standard): hide the bundled SQLite (rusqlite)
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
        println!("cargo:rustc-link-arg-bin=kabegame=-Wl,-rpath,@executable_path/../Frameworks");
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok() {
            println!("cargo:rustc-link-arg-bin=kabegame-cef-helper=-Wl,-rpath,@executable_path/../Frameworks");
            println!(
                "cargo:rustc-link-arg-bin=cef-example=-Wl,-rpath,@executable_path/../Frameworks"
            );
        }
        // Give bare dev executables an embedded Info.plist for Retina, process
        // naming and automatic GPU switching. An app bundle's plist takes
        // precedence in release builds.
        println!("cargo:rerun-if-changed=macos/embedded-Info.plist");
        println!(
            "cargo:rustc-link-arg-bin=kabegame=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("macos/embedded-Info.plist")
                .display()
        );
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok() {
            println!("cargo:rerun-if-changed=macos/kabegame-cef-helper-Info.plist");
            println!(
                "cargo:rustc-link-arg-bin=kabegame-cef-helper=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("macos/kabegame-cef-helper-Info.plist")
                    .display()
            );
            println!(
                "cargo:rustc-link-arg-bin=cef-example=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("macos/embedded-Info.plist")
                    .display()
            );
        }
        // libfuse 弱链接:有 macFUSE 则可用虚拟盘,无则不崩(设置页检测并提示安装)
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok() {
            println!("cargo:rustc-link-arg-bin=kabegame=-Wl,-weak-lfuse");
        }
    }

    // Android: V8's ARM64 JIT emits calls to __clear_cache (icache flush) that
    // live as an undefined symbol in librusty_v8.a. rustc's link step doesn't
    // pull in the NDK compiler-rt builtins that define it — and clang's implicit
    // builtins land before the rust static libs, so lld never resolves the ref.
    // The cdylib links anyway (undefined symbols are allowed in a shared object)
    // but dlopen() then fails at runtime with UnsatisfiedLinkError. Append the
    // NDK builtins archive at the end of the link line so it (and any sibling
    // compiler-rt helpers V8 references) resolves.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rerun-if-env-changed=NDK_HOME");
        match ndk_compiler_rt_builtins() {
            Some(path) => println!("cargo:rustc-link-arg={}", path.display()),
            None => println!(
                "cargo:warning=NDK compiler-rt builtins not found under NDK_HOME; \
                 libkabegame.so may fail to load (UnsatisfiedLinkError: __clear_cache)"
            ),
        }
    }
}

/// Locate the NDK's static compiler-rt builtins archive for the current Android
/// target arch, e.g. `.../lib/clang/<ver>/lib/linux/libclang_rt.builtins-aarch64-android.a`.
fn ndk_compiler_rt_builtins() -> Option<std::path::PathBuf> {
    let ndk = std::env::var("NDK_HOME")
        .or_else(|_| std::env::var("ANDROID_NDK_HOME"))
        .or_else(|_| std::env::var("ANDROID_NDK_ROOT"))
        .ok()?;
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").ok()?.as_str() {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        "arm" => "arm",
        "x86" => "i686",
        _ => return None,
    };
    let libname = format!("libclang_rt.builtins-{arch}-android.a");
    // toolchains/llvm/prebuilt/<host>/lib/clang/<ver>/lib/linux/<libname>
    let prebuilt = std::path::Path::new(&ndk).join("toolchains/llvm/prebuilt");
    for host in std::fs::read_dir(&prebuilt).ok()?.flatten() {
        let Ok(vers) = std::fs::read_dir(host.path().join("lib/clang")) else {
            continue;
        };
        for ver in vers.flatten() {
            let cand = ver.path().join("lib/linux").join(&libname);
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}
