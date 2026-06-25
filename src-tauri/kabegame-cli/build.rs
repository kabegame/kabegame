// CLI 与 GUI 同装在 /usr/bin/,共用 /usr/lib/kabegame/ 下的捆绑动态库(libx264 等)。
// 详见 cocs/build/PLATFORM_SHARED_LIBS.md。
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");
        println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");
    }
    // macOS:CLI 当前不进 .dmg/.app,但 brew x264/libfuse 的绝对 install_name 会写入 CLI 二进制依赖列表。
    // 留好 rpath:若将来把 CLI 放到 .app/Contents/MacOS/ 旁(与 GUI 共用 Frameworks/),自动可解析;
    // 留作独立分发时则需 OSPlugin.fixupMacOS 改写 CLI 的依赖路径(见 cocs/build/PLATFORM_SHARED_LIBS.md)。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }
}
