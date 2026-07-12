fn main() {
    use std::env;

    // Build-time injection:
    // - KABEGAME_DATA=dev | prod
    // Mode (standard / light / android / web) is now expressed entirely via Cargo features
    // on the consumer crate (kabegame). Core only sees feature flags like `virtual-driver`.
    println!("cargo:rerun-if-env-changed=KABEGAME_DATA");
    // rsmpeg/rusty_ffmpeg 经此环境变量定位 third/FFmpeg-build/install 的 libav* 库（由 scripts 注入）。
    println!("cargo:rerun-if-env-changed=FFMPEG_PKG_CONFIG_PATH");
    // ffmpeg lib
    println!("cargo:rerun-if-changed=../../third/FFmpeg-build/install/lib");

    println!("cargo:rustc-check-cfg=cfg(kabegame_data, values(\"dev\", \"prod\"))");

    let data = env::var("KABEGAME_DATA").unwrap_or_else(|_| "prod".to_string());
    let normalized_data = match data.as_str() {
        "dev" => "dev",
        _ => "prod",
    };
    println!("cargo:rustc-cfg=kabegame_data=\"{}\"", normalized_data);

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // iOS is unsupported. Every other target (desktop + Android) links the V8
    // runtime and needs the residual lazy-JS table. build.rs always runs on the
    // desktop host, so the deno build-deps are available regardless of --target.
    if target_os != "ios" {
        build_v8_residual_js();
    }
}

// NOTE: build scripts always compile for the HOST, so this cfg is effectively
// "desktop host" and is compiled whenever we build (including cross-builds for
// Android). The empty `ios`/`android` variant only exists for an iOS/Android host,
// which never happens for this project.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_v8_residual_js() {
    use deno_core::{Extension, ExtensionFileSourceCode};
    use deno_web::{BlobStore, InMemoryBroadcastChannel};
    use std::env;
    use std::fs;
    use std::io::Write as _;
    use std::path::PathBuf;

    // The runtime carries NO V8 startup snapshot (removed: snapshots are not
    // portable across architectures — a host-built snapshot cannot load in the
    // Android target's V8, and startup cost is not a bottleneck). deno extension
    // crates declare their JS as `lazy_loaded_js` with `LoadedFromFsDuringSnapshot`
    // (path-only, NOT embedded in the binary). Without a snapshot to bake them into
    // the heap, EVERY lazy source consumed by prelude.js must be inlined into the
    // binary and handed to `RuntimeOptions::residual_lazy_js_sources` so that
    // `Deno.core.loadExtScript()` resolves at runtime. We therefore emit the full
    // set here (deno_fetch is gone; networking is host-side).
    fn residual_extensions() -> Vec<Extension> {
        vec![
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                BlobStore::default_arc(),
                None,
                false,
                InMemoryBroadcastChannel::default(),
            ),
            deno_crypto::deno_crypto::init(None),
        ]
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let residual_rs_path = out_dir.join("residual_lazy_js.rs");
    let mut f = fs::File::create(&residual_rs_path).expect("create residual_lazy_js.rs");
    writeln!(f, "const KABEGAME_RESIDUAL_LAZY_JS: &[(&str, &str)] = &[").unwrap();

    for ext in residual_extensions() {
        for file in ext.lazy_loaded_js_files.iter() {
            let ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(path) = &file.code else {
                // IncludedInBinary sources are already embedded; loadExtScript finds
                // them without a residual entry.
                continue;
            };
            let specifier = file.specifier;
            // Derive a filesystem-safe name from the specifier.
            let dest_name = format!(
                "residual_{}.js",
                specifier.replace("ext:", "").replace(['/', ':'], "_")
            );
            let dest = out_dir.join(&dest_name);
            fs::copy(path, &dest).unwrap_or_else(|e| panic!("copy residual {path}: {e}"));
            println!("cargo:rerun-if-changed={path}");
            writeln!(
                f,
                r#"    ("{specifier}", include_str!(concat!(env!("OUT_DIR"), "/{dest_name}"))),"#
            )
            .unwrap();
        }
    }
    writeln!(f, "];").unwrap();

    println!("cargo:rerun-if-changed=src/plugin/v8/prelude.js");
    println!("cargo:rerun-if-changed=src/plugin/v8/deno_dom_wasm_noinit.js");
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn build_v8_residual_js() {}
