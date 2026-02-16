use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Trait for archive processors
pub trait ArchiveProcessor: Send + Sync {
    /// Returns a list of supported archive types (e.g., "zip")
    fn supported_types(&self) -> Vec<&str>;

    /// Check if this processor can handle the given URL (e.g., based on extension)
    fn can_handle(&self, url: &str) -> bool;

    /// Process the archive: extract to a subdirectory named after the archive (without extension),
    /// and return the path of the extracted folder. The caller is responsible for recursively
    /// processing the folder. The caller should check for cancellation before calling.
    ///
    /// # Arguments
    /// * `path` - The local path of the archive file
    /// * `temp_dir` - The temporary directory; extraction will create `temp_dir/{archive_stem}/`
    fn process(&self, path: &Path, temp_dir: &Path) -> Result<PathBuf, String>;
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

/// Check if the given file extension is a supported image type.
/// 委托给统一数据源 [crate::image_type].
pub fn is_supported_image_ext(ext: &str) -> bool {
    crate::image_type::is_supported_image_ext(ext)
}

#[cfg(not(target_os = "android"))]
pub mod rar;
pub mod zip;

/// Archive format type for type-safe processor selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveType {
    Zip,
    Rar,
}

impl ArchiveType {
    pub fn parse(s: &str) -> Option<Self> {
        let t = s.trim().to_ascii_lowercase();
        match t.as_str() {
            "zip" => Some(ArchiveType::Zip),
            "rar" => Some(ArchiveType::Rar),
            _ => None,
        }
    }

    /// Returns the type string used for matching with processor `supported_types()`.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArchiveType::Zip => "zip",
            ArchiveType::Rar => "rar",
        }
    }
}

/// 按类型字符串注册的处理器哈希表。
pub struct ArchiveManager {
    processors: HashMap<String, Arc<dyn ArchiveProcessor>>,
}

impl ArchiveManager {
    pub fn new() -> Self {
        let mut processors: HashMap<String, Arc<dyn ArchiveProcessor>> = HashMap::new();
        let zip: Arc<dyn ArchiveProcessor> = Arc::new(zip::ZipProcessor);
        for t in zip.supported_types() {
            let key = t.trim().to_ascii_lowercase().to_string();
            if !key.is_empty() {
                processors.insert(key, Arc::clone(&zip));
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            let rar: Arc<dyn ArchiveProcessor> = Arc::new(rar::RarProcessor);
            for t in rar.supported_types() {
                let key = t.trim().to_ascii_lowercase().to_string();
                if !key.is_empty() {
                    processors.insert(key, Arc::clone(&rar));
                }
            }
        }
        Self { processors }
    }

    pub fn supported_types(&self) -> Vec<String> {
        let mut out: Vec<String> = self.processors.keys().cloned().collect();
        out.sort();
        out
    }

    /// 按明确类型获取处理器。
    pub fn get_processor(&self, archive_type: ArchiveType) -> Option<&dyn ArchiveProcessor> {
        self.processors
            .get(archive_type.as_str())
            .map(|a| a.as_ref())
    }

    /// 根据 URL 猜测格式并返回对应处理器。
    pub fn get_processor_by_url(&self, url_hint: &str) -> Option<&dyn ArchiveProcessor> {
        for p in self.processors.values() {
            if p.can_handle(url_hint) {
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
