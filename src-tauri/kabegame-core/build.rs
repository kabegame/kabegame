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
    if target_os != "android" && target_os != "ios" {
        build_v8_snapshot();
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_v8_snapshot() {
    use deno_core::error::CoreError;
    use deno_core::snapshot::{create_snapshot, CreateSnapshotOptions};
    use deno_core::{Extension, ExtensionFileSourceCode};
    use deno_web::{BlobStore, InMemoryBroadcastChannel};
    use std::collections::HashSet;
    use std::env;
    use std::fs;
    use std::io::Write as _;
    use std::path::PathBuf;
    use std::sync::Arc;

    // No stub ops here. The real `op_kabegame_*` are declared only in the runtime
    // extension (src/plugin/v8.rs) and registered at runtime. deno_core lays out the
    // V8 external-reference table as [snapshot ops...][runtime-only ops...] (see
    // `create_external_references`): because `kabegame_v8` is the LAST extension in
    // both this snapshot list and the runtime list, the deno_* ops occupy identical
    // prefix positions, and the runtime's real kabegame ops are appended after the
    // snapshot's op set. The prelude only *references* `Deno.core.ops.*` inside
    // closures (never called during snapshot eval), so they resolve at runtime once
    // the real ops are bound (runtime keeps skip_op_registration = false).
    //
    // INVARIANT: keep `kabegame_v8` LAST here and the deno extension order identical
    // to `runtime_extension_args` in v8.rs, or the external-reference prefix breaks.
    deno_core::extension!(
        kabegame_v8,
        esm_entry_point = "ext:kabegame_v8/prelude.js",
        esm = [ dir "src/plugin/v8", "deno_dom_wasm_noinit.js", "prelude.js" ],
        state = |state| {
            let parser = Arc::new(deno_permissions::RuntimePermissionDescriptorParser::new(
                sys_traits::impls::RealSys,
            ));
            state.put(deno_permissions::PermissionsContainer::allow_all(parser));
            state.put(Arc::new(deno_features::FeatureChecker::default()));
        },
        docs = "Kabegame V8 crawler prelude snapshot (no ops; real ops live in v8.rs).",
    );

    fn snapshot_extensions() -> Vec<Extension> {
        vec![
            deno_webidl::deno_webidl::init(),
            deno_web::deno_web::init(
                BlobStore::default_arc(),
                None,
                false,
                InMemoryBroadcastChannel::default(),
            ),
            deno_crypto::deno_crypto::init(None),
            deno_fetch::deno_fetch::init(deno_fetch::Options {
                user_agent: "Kabegame/1.0".to_string(),
                ..Default::default()
            }),
            kabegame_v8::init(),
        ]
    }

    fn write_snapshot() -> Result<(), CoreError> {
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
        let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
        let snapshot_path = out_dir.join("kabegame_v8_snapshot.bin");

        // Collect all LoadedFromFsDuringSnapshot lazy_loaded_js entries BEFORE
        // snapshot creation so we can determine which ones are residual afterward.
        // deno extension crates declare lazy_loaded_js as LoadedFromFsDuringSnapshot
        // (path-only, not embedded in the binary). Entries consumed by prelude.js
        // during snapshot eval end up in consumed_lazy_specifiers and are accessible
        // at runtime via the loadedScripts cache baked into the snapshot heap.
        // Unconsumed entries are not in the binary and must be provided via
        // RuntimeOptions::residual_lazy_js_sources so loadExtScript can find them.
        let mut lazy_fs: Vec<(&'static str, &'static str)> = Vec::new();
        for ext in snapshot_extensions() {
            for file in ext.lazy_loaded_js_files.iter() {
                if let ExtensionFileSourceCode::LoadedFromFsDuringSnapshot(path) = &file.code {
                    lazy_fs.push((file.specifier, *path));
                }
            }
        }

        let output = create_snapshot(
            CreateSnapshotOptions {
                cargo_manifest_dir: Box::leak(manifest_dir.into_boxed_str()),
                startup_snapshot: None,
                skip_op_registration: false,
                extensions: snapshot_extensions(),
                extension_transpiler: None,
                with_runtime_cb: None,
            },
            None,
        )?;

        for path in &output.files_loaded_during_snapshot {
            println!("cargo:rerun-if-changed={}", path.display());
        }
        fs::write(&snapshot_path, &output.output).expect("write V8 snapshot");

        // Generate residual_lazy_js.rs: a const array of (specifier, source) pairs
        // for lazy_loaded_js files that were NOT consumed during snapshot eval.
        // These are provided to RuntimeOptions::residual_lazy_js_sources so that
        // Deno.core.loadExtScript() can find them at runtime.
        let consumed: HashSet<&str> = output
            .consumed_lazy_specifiers
            .iter()
            .map(|s| s.as_str())
            .collect();

        let residual_rs_path = out_dir.join("residual_lazy_js.rs");
        let mut f = fs::File::create(&residual_rs_path).expect("create residual_lazy_js.rs");
        writeln!(f, "const KABEGAME_RESIDUAL_LAZY_JS: &[(&str, &str)] = &[").unwrap();

        for (specifier, path) in &lazy_fs {
            if consumed.contains(specifier) {
                continue;
            }
            // Derive a filesystem-safe name from the specifier.
            let dest_name = format!(
                "residual_{}.js",
                specifier
                    .replace("ext:", "")
                    .replace(['/', ':'], "_")
            );
            let dest = out_dir.join(&dest_name);
            fs::copy(path, &dest)
                .unwrap_or_else(|e| panic!("copy residual {path}: {e}"));
            println!("cargo:rerun-if-changed={path}");
            writeln!(
                f,
                r#"    ("{specifier}", include_str!(concat!(env!("OUT_DIR"), "/{dest_name}"))),"#
            )
            .unwrap();
        }
        writeln!(f, "];").unwrap();

        Ok(())
    }

    println!("cargo:rerun-if-changed=src/plugin/v8/prelude.js");
    println!("cargo:rerun-if-changed=src/plugin/v8/deno_dom_wasm_noinit.js");
    write_snapshot().expect("create Kabegame V8 snapshot");
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn build_v8_snapshot() {}
