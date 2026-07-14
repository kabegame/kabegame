// CLI 与 GUI 同装时，共用安装目录中的 FFmpeg 等捆绑动态库。
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/kabegame");
        println!("cargo:rustc-link-arg=-Wl,--enable-new-dtags");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    // Windows: 静态链接 vcruntime，让 kabegame-cli.exe 不依赖 VCRUNTIME140.dll
    // (VC++ 可再发行运行库)，在未装 redist 的干净机器上也能直接运行。
    //
    // GUI 主程序走 `cargo tauri build`，由 tauri-build 在 STATIC_VCRUNTIME=true 时
    // 做同样处理；但 kabegame-cli 是纯 cargo 组件、不依赖 tauri-build，那条 env 对它
    // 无效，所以这里自带一份等价逻辑。采用 static_vcruntime 方案(仅静态 vcruntime，
    // 保留动态 UCRT ucrtbase.dll —— Win10+ 系统自带)，而非 `+crt-static` 全静态：
    // 后者会与项目里按动态 CRT 预编的 FFmpeg/x264 静态库冲突。主程序用同一方案 +
    // 同一批 FFmpeg 库已验证可行。移植自 third/tauri tauri-build 的 static_vcruntime.rs。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        static_vcruntime();
    }
}

/// 复刻 tauri-build 的 static_vcruntime::build()：静态链接 vcruntime，保留动态 UCRT。
/// 仅在 target 为 windows-msvc 时经运行时判断调用；逻辑本身可移植，不按 host 门控，
/// 以支持从非 Windows host 交叉编译 windows-msvc target。
fn static_vcruntime() {
    override_msvcrt_lib();

    // 关掉 Rust 未硬编、可能引入动态 vcruntime 的默认库
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:libvcruntimed.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:vcruntime.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:vcruntimed.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:libcmtd.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:msvcrt.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:msvcrtd.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:libucrt.lib");
    println!("cargo:rustc-link-arg=/NODEFAULTLIB:libucrtd.lib");
    // 指定要用的静态 CRT + 动态 UCRT
    println!("cargo:rustc-link-arg=/DEFAULTLIB:libcmt.lib");
    println!("cargo:rustc-link-arg=/DEFAULTLIB:libvcruntime.lib");
    println!("cargo:rustc-link-arg=/DEFAULTLIB:ucrt.lib");
}

/// rustc 会把 `msvcrt.lib` 作为显式链接输入传入，`/NODEFAULTLIB` 只能压制 defaultlib
/// 指令、压不掉显式输入。于是在链接搜索路径上放一个(几乎)空的同名 lib 遮蔽它。
fn override_msvcrt_lib() {
    use std::io::Write;

    let arch = std::env::var("CARGO_CFG_TARGET_ARCH");
    let machine: &[u8] = if arch.as_deref() == Ok("x86_64") {
        &[0x64, 0x86]
    } else if arch.as_deref() == Ok("x86") {
        &[0x4C, 0x01]
    } else {
        return;
    };
    let bytes: &[u8] = &[
        1, 0, 94, 3, 96, 98, 60, 0, 0, 0, 1, 0, 0, 0, 0, 0, 132, 1, 46, 100, 114, 101, 99, 116,
        118, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 10, 16, 0, 46, 100, 114, 101, 99, 116, 118, 101, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0, 4, 0,
        0, 0,
    ];

    let out_dir = std::env::var("OUT_DIR").unwrap();
    let path = std::path::Path::new(&out_dir).join("msvcrt.lib");
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    if let Ok(mut f) = f {
        f.write_all(machine).unwrap();
        f.write_all(bytes).unwrap();
    }
    println!("cargo:rustc-link-search=native={out_dir}");
}
