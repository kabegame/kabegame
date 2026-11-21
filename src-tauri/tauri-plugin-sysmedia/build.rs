// 本期不开 JS 命令：消费方都在 Rust（`app.sysmedia()`）。
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_mediaremote_adapter();
    }
}

/// 把嵌入的 mediaremote-adapter 编成动态库放进 `OUT_DIR`，由 `desktop/macos.rs` 用 `include_bytes!` 编进程序。
/// 参数照上游 `CMakeLists.txt`：ARC、符号可见（perl 要按名字找导出函数），链接 Foundation / AppKit /
/// UniformTypeIdentifiers。只编目标架构；最低系统版本跟应用（`MACOSX_DEPLOYMENT_TARGET`，没设取 11.0，
/// 同 `tauri.conf.json` 的 `minimumSystemVersion`），否则旧系统上 dyld 会拒绝加载。arm64 产物由链接器自动 ad-hoc 签名。
fn build_mediaremote_adapter() {
    use std::path::PathBuf;
    use std::process::Command;

    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("macos")
        .join("mediaremote-adapter");
    println!("cargo:rerun-if-changed={}", root.display());
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");

    let mut sources = Vec::new();
    for dir in ["adapter", "private", "utility"] {
        let mut files: Vec<PathBuf> = std::fs::read_dir(root.join("src").join(dir))
            .unwrap_or_else(|error| panic!("读 mediaremote-adapter 源码目录失败: {error}"))
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "m"))
            .collect();
        files.sort();
        sources.extend(files);
    }

    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        other => panic!("mediaremote-adapter 不支持的架构: {other:?}"),
    };
    let min_version =
        std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "11.0".to_string());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("MediaRemoteAdapter");

    let status = Command::new("xcrun")
        .args([
            "clang",
            "-dynamiclib",
            "-fobjc-arc",
            "-fvisibility=default",
            "-O2",
        ])
        .args(["-arch", arch])
        .arg(format!("-mmacosx-version-min={min_version}"))
        .arg("-I")
        .arg(root.join("include"))
        .arg("-I")
        .arg(root.join("src"))
        .args(["-framework", "Foundation", "-framework", "AppKit"])
        .args(["-framework", "UniformTypeIdentifiers"])
        .args(["-install_name", "@rpath/MediaRemoteAdapter"])
        .arg("-o")
        .arg(&out)
        .args(&sources)
        .status()
        .unwrap_or_else(|error| panic!("启动 clang 失败（要装 Xcode 命令行工具）: {error}"));
    assert!(status.success(), "编译 mediaremote-adapter 失败: {status}");
}
