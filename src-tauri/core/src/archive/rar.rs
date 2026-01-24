use super::resolve_local_path_from_url;
use super::ArchiveProcessor;
use std::path::{Path, PathBuf};
use unrar::Archive;

pub struct RarProcessor;

impl ArchiveProcessor for RarProcessor {
    fn supported_types(&self) -> Vec<&str> {
        vec!["rar"]
    }

    fn can_handle(&self, url: &str) -> bool {
        if let Some(path) = resolve_local_path_from_url(url) {
            return path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("rar"))
                .unwrap_or(false);
        }
        url.to_ascii_lowercase().ends_with(".rar")
    }

    fn process(
        &self,
        url: &str,
        temp_dir: &Path,
        downloader: &dyn Fn(&str, &Path) -> Result<(), String>,
        cancel_check: &dyn Fn() -> bool,
    ) -> Result<Vec<PathBuf>, String> {
        // 1. Get the rar file path
        let rar_path = if let Some(p) = resolve_local_path_from_url(url) {
            p
        } else if url.starts_with("http://") || url.starts_with("https://") {
            let archive_path = temp_dir.join("__kg_archive.rar");
            downloader(url, &archive_path)?;
            archive_path
        } else {
            return Err(format!("Unsupported archive url: {}", url));
        };

        if cancel_check() {
            return Err("Task canceled".to_string());
        }

        // 2. Extract
        // Note: unrar extract_to extracts relative to the destination directory
        let mut archive = Archive::new(&rar_path)
            .open_for_processing()
            .map_err(|e| format!("Failed to open rar archive: {}", e))?;

        while let Some(header) = archive
            .read_header()
            .map_err(|e| format!("Failed to read rar header: {}", e))?
        {
            if cancel_check() {
                return Err("Task canceled".to_string());
            }

            let entry = header.entry();
            let entry_filename = entry.filename.clone();
            let is_directory = entry.is_directory();

            if is_directory {
                // For directories, we just ensure they exist if we were extracting properly,
                // but since we handle file extraction manually below by creating parents,
                // we can just skip directory entries or create them if empty dirs matter.
                // Let's create them to be safe.
                let dest_path = temp_dir.join(&entry_filename);
                std::fs::create_dir_all(&dest_path)
                    .map_err(|e| format!("Failed to create directory {:?}: {}", dest_path, e))?;

                archive = header
                    .skip()
                    .map_err(|e| format!("Failed to skip directory entry: {}", e))?;
                continue;
            }

            // It's a file. Read into memory and write to disk manually to have better control/error reporting.
            let (data, new_archive) = header
                .read()
                .map_err(|e| format!("Failed to read rar entry {:?}: {}", entry_filename, e))?;
            archive = new_archive;

            let dest_path = temp_dir.join(&entry_filename);

            // Ensure parent directory exists
            if let Some(parent) = dest_path.parent() {
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        format!(
                            "Failed to create parent dir for {:?}: {}",
                            entry_filename, e
                        )
                    })?;
                }
            }

            std::fs::write(&dest_path, &data)
                .map_err(|e| format!("Failed to write file {:?}: {}", dest_path, e))?;
        }

        if cancel_check() {
            return Err("Task canceled".to_string());
        }

        // 3. Collect images
        let mut images = Vec::new();
        super::collect_images_recursive(temp_dir, &mut images)?;

        Ok(images)
    }
}
