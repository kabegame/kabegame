use super::ArchiveProcessor;
use std::path::{Path, PathBuf};
use url::Url;
use unrar::Archive;

pub struct RarProcessor;

impl ArchiveProcessor for RarProcessor {
    fn supported_types(&self) -> Vec<&str> {
        vec!["rar"]
    }

    fn can_handle(&self, url: &Url) -> bool {
        if let Ok(path) = url.to_file_path() {
            return path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("rar"))
                .unwrap_or(false);
        }
        url.path().to_ascii_lowercase().ends_with(".rar")
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
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| format!("Failed to create extract dir: {}", e))?;

        // 2. Extract
        let mut archive = Archive::new(path)
            .open_for_processing()
            .map_err(|e| format!("Failed to open rar archive: {}", e))?;

        while let Some(header) = archive
            .read_header()
            .map_err(|e| format!("Failed to read rar header: {}", e))?
        {
            let entry = header.entry();
            let entry_filename = entry.filename.clone();
            let is_directory = entry.is_directory();

            if is_directory {
                let dest_path = out_dir.join(&entry_filename);
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

            let mut dest_path = out_dir.join(&entry_filename);

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

            if dest_path.exists() {
                let filename = std::path::Path::new(&entry_filename)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("file");
                dest_path = crate::crawler::downloader::unique_path(
                    dest_path.parent().unwrap_or(&out_dir),
                    filename,
                );
            }

            std::fs::write(&dest_path, &data)
                .map_err(|e| format!("Failed to write file {:?}: {}", dest_path, e))?;
        }

        Ok(out_dir)
    }
}
