use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use url::Url;

/// Trait for archive processors
pub trait ArchiveProcessor: Send + Sync {
    /// Returns a list of supported archive types (e.g., "zip")
    fn supported_types(&self) -> Vec<&str>;

    /// Check if this processor can handle the given URL (e.g., based on path/extension).
    fn can_handle(&self, url: &Url) -> bool;

    /// Process the archive: extract to a subdirectory named after the archive (without extension)
    /// under the given directory, and return the path of the extracted folder.
    /// The caller is responsible for recursively processing the folder. The caller should check for cancellation before calling.
    ///
    /// # Arguments
    /// * `path` - The local path of the archive file
    /// * `extract_dir` - Target directory; extraction will create `extract_dir/{archive_stem}/`
    fn process(&self, path: &Path, extract_dir: &Path) -> Result<PathBuf, String>;
}

/// Check if the given file extension is a supported image type.
/// 委托给统一数据源 [crate::image_type].
pub fn is_supported_image_ext(ext: &str) -> bool {
    crate::image_type::is_supported_image_ext(ext)
}

/// 支持的压缩扩展名（小写），与 [ArchiveManager] 的 supported_types 一致。
fn supported_archive_extensions() -> Vec<String> {
    manager().supported_types()
}

/// 根据本地路径判断是否为支持的压缩包：先看扩展名，再按文件内容用 infer 推断。
/// 用于本地导入、解压队列及前端拖入文件分类。
pub fn is_archive_by_path(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let supported = supported_archive_extensions();
    if supported.iter().any(|s| s == &ext) {
        return true;
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        let inferred_ext = kind.extension().to_lowercase();
        if supported.iter().any(|s| s == &inferred_ext) {
            return true;
        }
    }
    false
}

/// 根据本地路径获取对应的压缩处理器：先按路径转 file URL 匹配，再按 infer 推断扩展名匹配。
pub fn get_processor_by_path(path: &Path) -> Option<&dyn ArchiveProcessor> {
    if let Ok(url) = Url::from_file_path(path) {
        if let Some(p) = manager().get_processor_by_url(&url) {
            return Some(p);
        }
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        let ext = kind.extension();
        if let Ok(url) = Url::parse(&format!("file:///dummy.{}", ext)) {
            if let Some(p) = manager().get_processor_by_url(&url) {
                return Some(p);
            }
        }
    }
    None
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
    pub fn get_processor_by_url(&self, url: &Url) -> Option<&dyn ArchiveProcessor> {
        for p in self.processors.values() {
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
