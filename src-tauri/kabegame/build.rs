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
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        // libfuse 弱链接:有 macFUSE 则可用虚拟盘,无则不崩(设置页检测并提示安装)
        if std::env::var("CARGO_FEATURE_STANDARD").is_ok() {
            println!("cargo:rustc-link-arg=-Wl,-weak-lfuse");
        }
    }
}
