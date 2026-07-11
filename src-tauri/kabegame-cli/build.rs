// CLI 与 GUI 同装在 /usr/bin/,共用 /usr/lib/kabegame/ 下的捆绑动态库。
// macOS:x264 已静态嵌入 FFmpeg,libfuse 通过弱链接(-weak-lfuse)延迟加载,二进制无 brew dylib 硬依赖。
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");
        println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        println!("cargo:rustc-link-arg=-Wl,-weak-lfuse");
    }
}
