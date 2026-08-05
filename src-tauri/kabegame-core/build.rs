fn main() {
    use std::env;

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let platform = match target_os.as_str() {
        "macos" => "macos",
        "windows" => "windows",
        "android" => "android",
        _ => "linux",
    };
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let arch = match target_arch.as_str() {
        "aarch64" => "arm64",
        _ => "x86_64",
    };
    println!("cargo:rerun-if-changed=../../bin/{platform}/{arch}/FFmpeg-build/install/lib");

    // Build-time injection:
    // - KABEGAME_DATA=dev | prod
    // Mode (standard / light / android / web) is now expressed entirely via Cargo features
    // on the consumer crate (kabegame). Core only sees feature flags like `virtual-driver`.
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");
    // rsmpeg/rusty_ffmpeg 经此环境变量定位 bin/{platform}/{arch}/FFmpeg-build/install 的 libav* 库（由 scripts 注入）。
    println!("cargo:rerun-if-env-changed=FFMPEG_PKG_CONFIG_PATH");

    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    let data = env::var("KABEGAME_DATA").unwrap_or_else(|_| "prod".to_string());
    let normalized_data = match data.as_str() {
        "dev" => "dev",
        _ => "prod",
    };
    println!("cargo:rustc-cfg=kabegame_data=\"{}\"", normalized_data);

    // The V8 runtime registers deno extension JS normally at `init(...)` (no startup
    // snapshot, no residual lazy-JS table). See src/plugin/v8.rs.
    println!("cargo:rerun-if-changed=src/plugin/v8/prelude.js");
    println!("cargo:rerun-if-changed=src/plugin/v8/deno_dom_wasm_noinit.js");
}
