use super::resolve_local_path_from_url;
use super::ArchiveProcessor;
use std::fs;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

pub struct ZipProcessor;

impl ArchiveProcessor for ZipProcessor {
    fn supported_types(&self) -> Vec<&str> {
        vec!["zip"]
    }

    fn can_handle(&self, url: &str) -> bool {
        if let Some(path) = resolve_local_path_from_url(url) {
            return path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("zip"))
                .unwrap_or(false);
        }
        url.to_ascii_lowercase().ends_with(".zip")
    }

    fn process(&self, path: &Path, temp_dir: &Path) -> Result<PathBuf, String> {
        if !path.exists() {
            return Err(format!("Archive file not found: {}", path.display()));
        }

        let archive_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archive");
        let extract_dir = temp_dir.join(archive_stem);
        fs::create_dir_all(&extract_dir)
            .map_err(|e| format!("Failed to create extract dir: {}", e))?;

        extract_zip_to_dir(path, &extract_dir)?;

        Ok(extract_dir)
    }
}

fn extract_zip_to_dir(zip_path: &Path, extract_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to open zip: {}", e))?;

    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{}: {}", i, e))?;

        let Some(rel) = f.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };

        let out_path = extract_dir.join(rel);
        if f.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir {}: {}", out_path.display(), e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
        }

        let mut out_file =
            fs::File::create(&out_path).map_err(|e| format!("Failed to write file: {}", e))?;
        std::io::copy(&mut f, &mut out_file)
            .map_err(|e| format!("Failed to extract zip entry: {}", e))?;
    }

    Ok(())
}
