use std::path::{Path, PathBuf};
use url::Url;

#[cfg(target_os = "android")]
use std::sync::OnceLock;

/// Trait for archive processors
#[async_trait::async_trait]
pub trait ArchiveProcessor: Send + Sync {
    /// Returns a list of supported archive types (e.g., "zip")
    fn supported_types(&self) -> Vec<&str>;

    /// Check if this processor can handle the given URL (e.g., based on path/extension or MIME).
    /// When `mime` is Some (e.g. from Android content URI), it is used for matching; otherwise path/extension or infer is used.
    fn can_handle(&self, url: &Url, mime: Option<&str>) -> bool;

    /// Process the archive: extract to a UUID-named subdirectory under the given directory,
    /// and return the path of the extracted folder.
    /// The caller is responsible for recursively processing the folder. The caller should check for cancellation before calling.
    ///
    /// # Arguments
    /// * `url` - The URL of the archive file (file:// or content://)
    /// * `extract_dir` - Target directory; extraction will create `extract_dir/{uuid}/`
    async fn process(&self, url: &Url, extract_dir: &Path) -> Result<PathBuf, String>;
}

/// Check if the given file extension is a supported image type.
/// 委托给统一数据源 [crate::image_type].
pub fn is_supported_image_ext(ext: &str) -> bool {
    crate::image_type::is_supported_image_ext(ext)
}

/// 支持的压缩扩展名（小写），与 `supported_types()` 一致。
fn supported_archive_extensions() -> Vec<String> {
    supported_types()
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
pub fn get_processor_by_path(path: &Path) -> Option<&'static ArchiveProcessorEnum> {
    if let Ok(url) = Url::from_file_path(path) {
        if let Some(p) = get_processor_by_url(&url, None) {
            return Some(p);
        }
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        let ext = kind.extension();
        if let Ok(url) = Url::parse(&format!("file:///dummy.{}", ext)) {
            if let Some(p) = get_processor_by_url(&url, None) {
                return Some(p);
            }
        }
    }
    None
}

pub mod rar;
pub mod zip;

/// 宏：根据 (类型列表, 变体名, 类型路径) 静态生成枚举、trait 实现和注册表，避免重复代码。
macro_rules! define_archive_processor_registry {
    ($( ($types:expr, $variant:ident, $type:path) ),* $(,)?) => {
        pub enum ArchiveProcessorEnum {
            $($variant($type),)*
        }

        #[async_trait::async_trait]
        impl ArchiveProcessor for ArchiveProcessorEnum {
            fn supported_types(&self) -> Vec<&str> {
                match self {
                    $(Self::$variant(p) => p.supported_types(),)*
                }
            }

            fn can_handle(&self, url: &Url, mime: Option<&str>) -> bool {
                match self {
                    $(Self::$variant(p) => p.can_handle(url, mime),)*
                }
            }

            async fn process(&self, url: &Url, extract_dir: &Path) -> Result<PathBuf, String> {
                match self {
                    $(Self::$variant(p) => p.process(url, extract_dir).await,)*
                }
            }
        }

        /// 静态处理器注册表：(类型列表, 处理器)。无需 OnceLock，编译期确定。
        static ARCHIVE_PROCESSOR_REGISTRY: &[(&[&'static str], ArchiveProcessorEnum)] = &[
            $(($types, ArchiveProcessorEnum::$variant($type)),)*
        ];
    };
}

define_archive_processor_registry! {
    (&["zip"], Zip, zip::ZipProcessor),
    (&["rar"], Rar, rar::RarProcessor),
}

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

/// 按明确类型获取处理器。
pub fn get_processor(archive_type: ArchiveType) -> Option<&'static ArchiveProcessorEnum> {
    let type_str = archive_type.as_str();
    ARCHIVE_PROCESSOR_REGISTRY
        .iter()
        .find(|(types, _)| types.iter().any(|t| t.eq_ignore_ascii_case(type_str)))
        .map(|(_, p)| p)
}

/// 根据 URL（及可选的 MIME）猜测格式并返回对应处理器。
pub fn get_processor_by_url(
    url: &Url,
    mime: Option<&str>,
) -> Option<&'static ArchiveProcessorEnum> {
    ARCHIVE_PROCESSOR_REGISTRY
        .iter()
        .find(|(_, processor)| processor.can_handle(url, mime))
        .map(|(_, p)| p)
}

/// 返回当前支持的压缩类型列表。
pub fn supported_types() -> Vec<String> {
    let mut out: Vec<String> = ARCHIVE_PROCESSOR_REGISTRY
        .iter()
        .flat_map(|(types, _)| types.iter().map(|s| s.to_string()))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Android 归档解压提供者抽象。由 kabegame 通过 tauri-plugin-archiver 实现并注册。
#[cfg(target_os = "android")]
#[async_trait::async_trait]
pub trait ArchiveExtractProvider: Send + Sync {
    async fn extract_zip(&self, archive_uri: &str, output_dir: &str) -> Result<PathBuf, String>;
    async fn extract_rar(&self, archive_uri: &str, output_dir: &str) -> Result<PathBuf, String>;
}

#[cfg(target_os = "android")]
static ARCHIVE_EXTRACT_PROVIDER: OnceLock<Box<dyn ArchiveExtractProvider>> = OnceLock::new();

/// 注册 ArchiveExtractProvider（仅 Android，由 kabegame 在 setup 时调用）。
#[cfg(target_os = "android")]
pub fn set_archive_extract_provider(provider: Box<dyn ArchiveExtractProvider>) {
    let _ = ARCHIVE_EXTRACT_PROVIDER.set(provider);
}

/// 获取已注册的 ArchiveExtractProvider。
#[cfg(target_os = "android")]
pub fn get_archive_extract_provider() -> &'static dyn ArchiveExtractProvider {
    ARCHIVE_EXTRACT_PROVIDER.get().map(|b| b.as_ref()).unwrap()
}

/// 从 URL（file:// 或 content://）解析压缩包名称（不含扩展名）。
/// 用于创建 images_dir 下的子文件夹名称。
pub async fn resolve_archive_name(url: &Url) -> String {
    // file:// → path.file_stem()
    if let Ok(path) = url.to_file_path() {
        return path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("archive")
            .to_string();
    }
    // content:// (Android) → get_display_name → strip extension
    #[cfg(target_os = "android")]
    {
        use crate::crawler::content_io::get_content_io_provider;
        if let Ok(name) = get_content_io_provider()
            .get_display_name(url.as_str())
            .await
        {
            return std::path::Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("archive")
                .to_string();
        }
    }
    "archive".to_string()
}
