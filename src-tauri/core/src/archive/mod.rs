use std::fs;
use std::path::{Path, PathBuf};

/// Trait for archive processors
pub trait ArchiveProcessor: Send + Sync {
    /// Returns a list of supported archive types (e.g., "zip")
    fn supported_types(&self) -> Vec<&str>;

    /// Check if this processor can handle the given URL (e.g., based on extension)
    fn can_handle(&self, url: &str) -> bool;

    /// Process the archive: download (if necessary), extract, and return list of image files.
    ///
    /// # Arguments
    /// * `url` - The URL or local path of the archive
    /// * `temp_dir` - The temporary directory to use for extraction
    /// * `downloader` - A callback to download a file from a URL to a local path
    /// * `cancel_check` - A callback to check if the task is canceled
    fn process(
        &self,
        url: &str,
        temp_dir: &Path,
        downloader: &dyn Fn(&str, &Path) -> Result<(), String>,
        cancel_check: &dyn Fn() -> bool,
    ) -> Result<Vec<PathBuf>, String>;
}

/// Helper to resolve local path from URL
pub fn resolve_local_path_from_url(url: &str) -> Option<PathBuf> {
    let path = if url.starts_with("file://") {
        let path_str = if url.starts_with("file:///") {
            &url[8..]
        } else {
            &url[7..]
        };
        #[cfg(windows)]
        let path_str = path_str.replace("/", "\\");
        #[cfg(not(windows))]
        let path_str = path_str;
        PathBuf::from(path_str)
    } else {
        let p = PathBuf::from(url);
        if !p.exists() {
            return None;
        }
        p
    };

    path.canonicalize().ok()
}

/// Helper to collect images recursively
pub fn collect_images_recursive(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let p = entry.path();
        if p.is_dir() {
            collect_images_recursive(&p, out)?;
        } else if p.is_file() {
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if is_supported_image_ext(ext) {
                    out.push(p);
                }
            }
        }
    }
    Ok(())
}

fn is_supported_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "ico"
    )
}

#[cfg(not(target_os = "android"))]
pub mod rar;
pub mod zip;

/// Registry for archive processors
pub struct ArchiveManager {
    processors: Vec<Box<dyn ArchiveProcessor>>,
}

impl ArchiveManager {
    pub fn new() -> Self {
        let mut processors: Vec<Box<dyn ArchiveProcessor>> =
            vec![Box::new(zip::ZipProcessor)];
        #[cfg(not(target_os = "android"))]
        processors.push(Box::new(rar::RarProcessor));
        Self { processors }
    }

    pub fn register(&mut self, processor: Box<dyn ArchiveProcessor>) {
        self.processors.push(processor);
    }

    pub fn supported_types(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.processors {
            for t in p.supported_types() {
                let tt = t.trim().to_ascii_lowercase();
                if !tt.is_empty() && !out.iter().any(|x| x == &tt) {
                    out.push(tt);
                }
            }
        }
        out.sort();
        out
    }

    pub fn get_processor(
        &self,
        type_hint: Option<&str>,
        url: &str,
    ) -> Option<&dyn ArchiveProcessor> {
        // 1. Try explicit type hint
        if let Some(hint) = type_hint {
            for p in &self.processors {
                if p.supported_types()
                    .contains(&hint.to_ascii_lowercase().as_str())
                {
                    return Some(p.as_ref());
                }
            }
        }

        // 2. Try auto-detection
        for p in &self.processors {
            if p.can_handle(url) {
                return Some(p.as_ref());
            }
        }

        None
    }
}

// Global instance
use std::sync::OnceLock;

pub fn manager() -> &'static ArchiveManager {
    static MANAGER: OnceLock<ArchiveManager> = OnceLock::new();
    MANAGER.get_or_init(|| ArchiveManager::new())
}

pub fn supported_types() -> Vec<String> {
    manager().supported_types()
}
