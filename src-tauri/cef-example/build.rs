fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        // kabegame.exe 的 manifest 由 tauri-build 的 WindowsAttributes::app_manifest
        // 提供,须包含同样的 <compatibility> 段,理由见 windows-app.manifest 注释。
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("..")
            .join("tauri-runtime-cef")
            .join("windows-app.manifest");
        println!("cargo::rustc-link-arg-bins=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg-bins=/MANIFESTINPUT:{}",
            manifest.display()
        );
        println!("cargo::rerun-if-changed={}", manifest.display());
    }
}
