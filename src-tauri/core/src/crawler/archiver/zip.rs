use super::ArchiveProcessor;
use encoding_rs::{GBK, SHIFT_JIS};
use std::fs;
use std::path::{Component, Path, PathBuf};
use url::Url;
use zip::ZipArchive;

/// 解码 ZIP 条目文件名，解决非 UTF-8 编码（如 GBK、Shift-JIS）导致的乱码。
fn decode_filename(raw: &[u8], is_utf8_flag: bool) -> String {
    if is_utf8_flag {
        if let Ok(s) = std::str::from_utf8(raw) {
            return s.to_string();
        }
    }

    // 尝试 UTF-8
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }

    // 尝试 GBK（中文 Windows 常见）
    let (cow, _, had_errors) = GBK.decode(raw);
    if !had_errors {
        return cow.into_owned();
    }

    // 尝试 Shift-JIS（日文常见）
    let (cow, _, had_errors) = SHIFT_JIS.decode(raw);
    if !had_errors {
        return cow.into_owned();
    }

    // 最后 fallback CP437（老式 ZIP 默认）
    raw.iter().map(|&b| b as char).collect()
}

/// 校验解码后的路径是否安全（无路径穿越、非绝对路径）。
fn is_safe_relative_path(decoded: &str) -> bool {
    if decoded.contains('\0') {
        return false;
    }
    let p = Path::new(decoded);
    if p.is_absolute() {
        return false;
    }
    p.components().all(|c| c != Component::ParentDir)
}

pub struct ZipProcessor;

impl ArchiveProcessor for ZipProcessor {
    fn supported_types(&self) -> Vec<&str> {
        vec!["zip"]
    }

    fn can_handle(&self, url: &Url) -> bool {
        if let Ok(path) = url.to_file_path() {
            return path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("zip"))
                .unwrap_or(false);
        }
        url.path().to_ascii_lowercase().ends_with(".zip")
    }

    fn process(&self, path: &Path, extract_dir: &Path) -> Result<PathBuf, String> {
        if !path.exists() {
            return Err(format!("Archive file not found: {}", path.display()));
        }

        let archive_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archive");
        let out_dir = extract_dir.join(archive_stem);
        fs::create_dir_all(&out_dir)
            .map_err(|e| format!("Failed to create extract dir: {}", e))?;

        extract_zip_to_dir(path, &out_dir)?;

        Ok(out_dir)
    }
}

fn extract_zip_to_dir(zip_path: &Path, extract_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to open zip: {}", e))?;

    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{}: {}", i, e))?;

        let raw = f.name_raw();
        let decoded = decode_filename(raw, false);
        if !is_safe_relative_path(&decoded) {
            continue;
        }
        let rel = PathBuf::from(decoded);

        let out_path = extract_dir.join(&rel);
        let is_dir = raw.ends_with(b"/") || raw.ends_with(b"\\");
        if is_dir {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {}: {}", out_path.display(), e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
        }

        let out_path = if out_path.exists() {
            let filename = rel
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file");
            crate::crawler::downloader::unique_path(
                out_path.parent().unwrap_or(extract_dir),
                filename,
            )
        } else {
            out_path
        };

        let mut out_file =
            fs::File::create(&out_path).map_err(|e| format!("Failed to write file: {}", e))?;
        std::io::copy(&mut f, &mut out_file)
            .map_err(|e| format!("Failed to extract zip entry: {}", e))?;
    }

    Ok(())
}
