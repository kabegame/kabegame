use super::ArchiveProcessor;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use unrar::Archive;
use url::Url;
use uuid;

pub struct RarProcessor;

#[async_trait::async_trait]
impl ArchiveProcessor for RarProcessor {
    fn supported_types(&self) -> Vec<&str> {
        vec!["rar"]
    }

    fn can_handle(&self, url: &Url, mime: Option<&str>) -> bool {
        if let Ok(path) = url.to_file_path() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                return ext.eq_ignore_ascii_case("rar");
            }
            if let Ok(Some(kind)) = infer::get_from_path(&path) {
                return kind.extension().eq_ignore_ascii_case("rar");
            }
            return false;
        }
        if let Some(m) = mime {
            let m = m.trim().to_lowercase();
            return matches!(
                m.as_str(),
                "application/x-rar-compressed" | "application/vnd.rar"
            );
        }
        url.path().to_ascii_lowercase().ends_with(".rar")
    }

    async fn process(&self, url: &Url, extract_dir: &Path) -> Result<PathBuf, String> {
        #[cfg(target_os = "android")]
        {
            use super::get_archive_extract_provider;
            let provider = get_archive_extract_provider();
            return provider
                .extract_rar(url.as_str(), extract_dir.to_str().unwrap())
                .await;
        }

        #[cfg(not(target_os = "android"))]
        {
            // Desktop / file:// — 原有同步逻辑包在 spawn_blocking 中
            let path = url
                .to_file_path()
                .map_err(|_| "Invalid file URL for archive".to_string())?;
            if !path.exists() {
                return Err(format!("Archive file not found: {}", path.display()));
            }

            let out_dir = extract_dir.join(uuid::Uuid::new_v4().to_string());
            let extract_dir_clone = extract_dir.to_path_buf();
            let path_clone = path.clone();

            tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&out_dir)
                    .map_err(|e| format!("Failed to create extract dir: {}", e))?;

                // Extract
                let mut archive = Archive::new(&path_clone)
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
                        std::fs::create_dir_all(&dest_path).map_err(|e| {
                            format!("Failed to create directory {:?}: {}", dest_path, e)
                        })?;

                        archive = header
                            .skip()
                            .map_err(|e| format!("Failed to skip directory entry: {}", e))?;
                        continue;
                    }

                    // It's a file. Read into memory and write to disk manually to have better control/error reporting.
                    let (data, new_archive) = header.read().map_err(|e| {
                        format!("Failed to read rar entry {:?}: {}", entry_filename, e)
                    })?;
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

                Ok::<PathBuf, String>(out_dir)
            })
            .await
            .map_err(|e| format!("Decompression task failed: {}", e))?
        }
    }
}
