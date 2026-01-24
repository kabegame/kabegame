use super::collect_images_recursive;
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

    fn process(
        &self,
        url: &str,
        temp_dir: &Path,
        downloader: &dyn Fn(&str, &Path) -> Result<(), String>,
        cancel_check: &dyn Fn() -> bool,
    ) -> Result<Vec<PathBuf>, String> {
        // 1. Get the zip file path
        let zip_path = if let Some(p) = resolve_local_path_from_url(url) {
            p
        } else if url.starts_with("http://") || url.starts_with("https://") {
            let archive_path = temp_dir.join("__kg_archive.zip");
            downloader(url, &archive_path)?;
            archive_path
        } else {
            return Err(format!("Unsupported archive url: {}", url));
        };

        if cancel_check() {
            return Err("Task canceled".to_string());
        }

        // 2. Extract
        extract_zip_to_dir(&zip_path, temp_dir)?;

        if cancel_check() {
            return Err("Task canceled".to_string());
        }

        // 3. Collect images
        let mut images = Vec::new();
        collect_images_recursive(temp_dir, &mut images)?;

        Ok(images)
    }
}

fn extract_zip_to_dir(zip_path: &Path, dst_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to open zip: {}", e))?;

    for i in 0..archive.len() {
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry #{}: {}", i, e))?;

        let Some(rel) = f.enclosed_name().map(|p| p.to_owned()) else {
            continue;
        };

        let out_path = dst_dir.join(rel);
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
