fn main() {
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    // Build-time mode injection:
    // - KABEGAME_MODE=normal | local
    // - Expose to Rust code via env!("KABEGAME_BUILD_MODE")
    // - Also provide a compile-time cfg for optional conditional compilation
    println!("cargo:rerun-if-env-changed=KABEGAME_MODE");
    println!("cargo:rerun-if-env-changed=KABEGAME_BUILTIN_PLUGINS");

    let mode = env::var("KABEGAME_MODE").unwrap_or_else(|_| "normal".to_string());
    let normalized = match mode.as_str() {
        "local" => "local",
        _ => "normal",
    };

    println!("cargo:rustc-env=KABEGAME_BUILD_MODE={}", normalized);
    if normalized == "local" {
        // Allow `#[cfg(kabegame_mode_local)]` in code.
        println!("cargo:rustc-cfg=kabegame_mode_local");
    }

    // Builtin plugins list (comma-separated):
    // - local mode: all plugins are built-in (immutable, cannot be uninstalled)
    // - normal mode: no built-in concept (empty list)
    let builtins = if normalized == "local" {
        // 可通过环境变量自定义，否则用默认全量列表
        env::var("KABEGAME_BUILTIN_PLUGINS").unwrap_or_else(|_| {
            // 这种情况不应该出现
            "local-import".to_string()
        })
    } else {
        // normal 模式没有内置概念
        String::new()
    };
    println!("cargo:rustc-env=KABEGAME_BUILTIN_PLUGINS={}", builtins);

    // Sidecar placeholders (dev only):
    //
    // Tauri v2 会在编译期校验 `bundle.externalBin` 指向的文件是否存在。
    // 我们在 `pnpm build` 阶段会生成真实 sidecar 并复制到 src-tauri/bin/<name>-<triple>.exe。
    // 但 IDE / `cargo check` (debug) 不应被这个校验阻断，因此这里在 debug 下生成空占位文件。
    //
    // 注意：release 下如果缺失 sidecar，应当失败并提示用户使用 `pnpm build` 统一流程。
    let profile = env::var("PROFILE").unwrap_or_default();
    let target = env::var("TARGET").unwrap_or_default();
    let is_windows = target.contains("windows");
    let ext = if is_windows { ".exe" } else { "" };
    let bin_dir: PathBuf = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default())
        .join("bin");
    let _ = fs::create_dir_all(&bin_dir);

    let sidecars = ["kabegame-cli", "kabegame-plugin-editor"];
    for name in sidecars {
        let file_name = format!("{}-{}{}", name, target, ext);
        let p = bin_dir.join(file_name);
        if !p.exists() {
            if profile == "release" {
                // 生产打包必须有真实 sidecar，否则安装目录会缺文件。
                panic!(
                    "Sidecar binary missing: {}\n请使用 `pnpm build`（会先编译并复制 sidecar 到 src-tauri/bin）。",
                    p.display()
                );
            } else {
                // debug: create placeholder for compile-time validation
                let _ = fs::write(&p, []);
            }
        }
    }

    tauri_build::build()
}
