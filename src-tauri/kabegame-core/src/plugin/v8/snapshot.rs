//! Device-generated baseline startup snapshot cache for the V8 plugin runtime.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAGIC: &[u8; 8] = b"KGVSNAP1";

/// Snapshot content fingerprint. Increment this when any of the following
/// changes:
/// - vendored `deno_core` snapshot/sidecar layout;
/// - deno_webidl / deno_web / deno_crypto versions;
/// - the extension set or order in `base_extensions`;
/// - kabegame_v8 ESM (`prelude.js` / `deno_dom_wasm_noinit.js`).
///
/// `CRYPTO_INIT_SCRIPT` runs after restore and does not require a bump. The V8
/// version is recorded separately in the metadata below.
const SNAPSHOT_FINGERPRINT: u32 = 1;
const MAX_META_LEN: usize = 4096;

static LOADED: OnceLock<&'static [u8]> = OnceLock::new();
static LOAD_GUARD: Mutex<()> = Mutex::new(());
static DISABLED: AtomicBool = AtomicBool::new(false);
static GENERATING: AtomicBool = AtomicBool::new(false);

fn meta_string() -> String {
    format!(
        "fp={SNAPSHOT_FINGERPRINT};v8={}",
        deno_core::v8::VERSION_STRING
    )
}

fn snapshot_file() -> PathBuf {
    crate::app_paths::AppPaths::global()
        .plugin_snapshots_dir()
        .join(format!("runtime@{SNAPSHOT_FINGERPRINT}.bin"))
}

fn disabled_by_env() -> bool {
    matches!(
        std::env::var("KABEGAME_DISABLE_V8_SNAPSHOT").as_deref(),
        Ok("1" | "true")
    )
}

/// Return the process-wide leaked snapshot payload after validating the custom
/// file envelope. Invalid bytes are never handed to deno_core/V8.
pub(crate) fn try_load() -> Option<&'static [u8]> {
    if DISABLED.load(Ordering::Acquire) || disabled_by_env() {
        return None;
    }
    if let Some(blob) = LOADED.get() {
        return Some(*blob);
    }

    let _guard = LOAD_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(blob) = LOADED.get() {
        return Some(*blob);
    }

    let path = snapshot_file();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("[v8-snapshot] failed to read {}: {error}", path.display());
            return None;
        }
    };

    match decode_file(&bytes) {
        Ok(payload) => {
            let leaked: &'static [u8] = Box::leak(payload.into_boxed_slice());
            let _ = LOADED.set(leaked);
            LOADED.get().copied()
        }
        Err(error) => {
            eprintln!(
                "[v8-snapshot] invalid cache {}, regenerating: {error}",
                path.display()
            );
            let _ = fs::remove_file(&path);
            spawn_generate_if_missing();
            None
        }
    }
}

/// Disable snapshot restore for this process after a restore-level failure and
/// invalidate the on-disk cache so a later process can regenerate it.
pub(crate) fn disable_and_invalidate() {
    DISABLED.store(true, Ordering::Release);
    let path = snapshot_file();
    if let Err(error) = fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "[v8-snapshot] failed to invalidate {}: {error}",
                path.display()
            );
        }
    }
}

/// Ensure a current baseline snapshot exists without delaying the caller.
/// Concurrent callers are coalesced into one blocking generation task.
pub fn spawn_generate_if_missing() {
    if DISABLED.load(Ordering::Acquire) || disabled_by_env() || LOADED.get().is_some() {
        return;
    }

    let path = snapshot_file();
    if file_meta_is_current(&path) {
        return;
    }
    if GENERATING.swap(true, Ordering::AcqRel) {
        return;
    }

    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        GENERATING.store(false, Ordering::Release);
        eprintln!("[v8-snapshot] generation skipped outside a Tokio runtime");
        return;
    };

    handle.spawn_blocking(move || {
        let started = Instant::now();
        match generate_and_write(&path) {
            Ok(size) => eprintln!(
                "[v8-snapshot] generated {} ({} bytes) in {} ms",
                path.display(),
                size,
                started.elapsed().as_millis()
            ),
            Err(error) => eprintln!("[v8-snapshot] generation failed: {error}"),
        }
        GENERATING.store(false, Ordering::Release);
    });
}

/// Bake extension ESM only. Crypto globals are deliberately initialized after
/// restore because their cppgc objects cannot be serialized in a V8 snapshot.
pub(super) fn generate_snapshot_bytes() -> Result<Box<[u8]>, String> {
    let runtime = deno_core::JsRuntimeForSnapshot::try_new(deno_core::RuntimeOptions {
        module_loader: None,
        extensions: super::base_extensions(super::KabegameOpState::snapshot_placeholder()),
        ..Default::default()
    })
    .map_err(|error| format!("snapshot runtime init: {error}"))?;
    Ok(runtime.snapshot())
}

fn generate_and_write(path: &Path) -> Result<usize, String> {
    let payload = generate_snapshot_bytes()?;
    let size = payload.len();
    let encoded = encode_file(&payload);
    write_atomic(path, &encoded)?;
    if let Some(dir) = path.parent() {
        cleanup_stale(dir, path);
    }
    Ok(size)
}

fn encode_file(payload: &[u8]) -> Vec<u8> {
    let meta = meta_string();
    let mut encoded = Vec::with_capacity(8 + 4 + meta.len() + 8 + 4 + payload.len());
    encoded.extend_from_slice(MAGIC);
    encoded.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    encoded.extend_from_slice(meta.as_bytes());
    encoded.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    encoded.extend_from_slice(&crc32fast::hash(payload).to_le_bytes());
    encoded.extend_from_slice(payload);
    encoded
}

fn decode_file(bytes: &[u8]) -> Result<Vec<u8>, String> {
    const FIXED_PREFIX: usize = 8 + 4;
    const PAYLOAD_HEADER: usize = 8 + 4;

    if bytes.len() < FIXED_PREFIX + PAYLOAD_HEADER {
        return Err("file is truncated before metadata".to_string());
    }
    if bytes.get(..MAGIC.len()) != Some(MAGIC.as_slice()) {
        return Err("magic mismatch".to_string());
    }

    let meta_len = u32::from_le_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| "invalid metadata length".to_string())?,
    ) as usize;
    if meta_len > MAX_META_LEN {
        return Err(format!("metadata is too large: {meta_len}"));
    }
    let meta_end = FIXED_PREFIX
        .checked_add(meta_len)
        .ok_or_else(|| "metadata length overflow".to_string())?;
    let payload_header_end = meta_end
        .checked_add(PAYLOAD_HEADER)
        .ok_or_else(|| "payload header overflow".to_string())?;
    if payload_header_end > bytes.len() {
        return Err("file is truncated in metadata or payload header".to_string());
    }

    let meta = std::str::from_utf8(&bytes[FIXED_PREFIX..meta_end])
        .map_err(|error| format!("metadata is not UTF-8: {error}"))?;
    let expected_meta = meta_string();
    if meta != expected_meta {
        return Err(format!("metadata mismatch: {meta:?}"));
    }

    let payload_len = u64::from_le_bytes(
        bytes[meta_end..meta_end + 8]
            .try_into()
            .map_err(|_| "invalid payload length".to_string())?,
    );
    let payload_len = usize::try_from(payload_len)
        .map_err(|_| "payload length does not fit this platform".to_string())?;
    let expected_crc = u32::from_le_bytes(
        bytes[meta_end + 8..payload_header_end]
            .try_into()
            .map_err(|_| "invalid payload CRC".to_string())?,
    );
    let payload_end = payload_header_end
        .checked_add(payload_len)
        .ok_or_else(|| "payload length overflow".to_string())?;
    if payload_end != bytes.len() {
        return Err(format!(
            "payload length mismatch: header={payload_len}, available={}",
            bytes.len().saturating_sub(payload_header_end)
        ));
    }

    let payload = &bytes[payload_header_end..payload_end];
    let actual_crc = crc32fast::hash(payload);
    if actual_crc != expected_crc {
        return Err(format!(
            "payload CRC mismatch: expected={expected_crc:08x}, actual={actual_crc:08x}"
        ));
    }
    Ok(payload.to_vec())
}

fn file_meta_is_current(path: &Path) -> bool {
    let expected = meta_string();
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut prefix = [0_u8; 12];
    if file.read_exact(&mut prefix).is_err() || &prefix[..8] != MAGIC {
        return false;
    }
    let meta_len = u32::from_le_bytes(prefix[8..12].try_into().expect("fixed slice")) as usize;
    if meta_len > MAX_META_LEN || meta_len != expected.len() {
        return false;
    }
    let mut meta = vec![0_u8; meta_len];
    file.read_exact(&mut meta).is_ok() && meta == expected.as_bytes()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("snapshot path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid snapshot file name: {}", path.display()))?;
    let temp = parent.join(format!("{file_name}.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&temp);

    let result = (|| {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("create {}: {error}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temp.display()))?;
        drop(file);

        match fs::rename(&temp, path) {
            Ok(()) => Ok(()),
            Err(first_error) if path.exists() => {
                fs::remove_file(path)
                    .map_err(|error| format!("replace {}: {error}", path.display()))?;
                fs::rename(&temp, path).map_err(|error| {
                    format!(
                        "rename {} to {} after {first_error}: {error}",
                        temp.display(),
                        path.display()
                    )
                })
            }
            Err(error) => Err(format!(
                "rename {} to {}: {error}",
                temp.display(),
                path.display()
            )),
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn cleanup_stale(dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if (name.starts_with("runtime@") && name.ends_with(".bin")) || name.contains(".tmp-") {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_rejects_bad_meta_crc_and_truncation() {
        let payload = b"snapshot-payload";
        let encoded = encode_file(payload);
        assert_eq!(decode_file(&encoded).expect("valid envelope"), payload);

        let mut bad_meta = encoded.clone();
        bad_meta[12] ^= 1;
        assert!(decode_file(&bad_meta).unwrap_err().contains("metadata"));

        let mut bad_crc = encoded.clone();
        *bad_crc.last_mut().expect("payload byte") ^= 1;
        assert!(decode_file(&bad_crc).unwrap_err().contains("CRC"));

        assert!(decode_file(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn atomic_write_and_stale_cleanup_round_trip() {
        let temp = tempfile::tempdir().expect("tempdir");
        let keep = temp.path().join("runtime@1.bin");
        let stale = temp.path().join("runtime@0.bin");
        let abandoned = temp.path().join("runtime@1.bin.tmp-old");
        fs::write(&stale, b"old").expect("write stale");
        fs::write(&abandoned, b"partial").expect("write abandoned");

        let encoded = encode_file(b"payload");
        write_atomic(&keep, &encoded).expect("atomic write");
        assert_eq!(decode_file(&fs::read(&keep).unwrap()).unwrap(), b"payload");
        cleanup_stale(temp.path(), &keep);
        assert!(keep.exists());
        assert!(!stale.exists());
        assert!(!abandoned.exists());
    }
}
