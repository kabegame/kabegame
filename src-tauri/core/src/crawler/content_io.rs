//! Android content:// URI IO 抽象，由 app-main 通过 PickerPlugin 实现并注册。

#[cfg(target_os = "android")]
use std::sync::OnceLock;

/// Android content:// 下的子项（来自 listContentChildren）。
#[derive(Debug, Clone)]
pub struct ContentEntry {
    pub uri: String,
    pub name: String,
    pub is_directory: bool,
}

/// extractArchiveToMediaStore 的返回结果。
#[derive(Debug, Clone)]
pub struct ExtractArchiveResult {
    pub uris: Vec<String>,
    pub count: u32,
}

/// Android content:// IO 操作抽象。由 app-main 用 PluginHandle 实现并注册。
#[cfg(target_os = "android")]
pub trait ContentIoProvider: Send + Sync {
    fn is_directory(&self, uri: &str) -> Result<bool, String>;
    fn get_mime_type(&self, uri: &str) -> Result<Option<String>, String>;
    fn list_children(&self, uri: &str) -> Result<Vec<ContentEntry>, String>;
    fn read_file_bytes(&self, uri: &str) -> Result<Vec<u8>, String>;
    fn take_persistable_permission(&self, uri: &str) -> Result<(), String>;
    fn extract_archive_to_media_store(
        &self,
        archive_uri: &str,
        folder_name: &str,
    ) -> Result<ExtractArchiveResult, String>;
}

#[cfg(target_os = "android")]
static CONTENT_IO_PROVIDER: OnceLock<Box<dyn ContentIoProvider>> = OnceLock::new();

/// 注册 ContentIoProvider（仅 Android，由 app-main 在 setup 时调用）。
#[cfg(target_os = "android")]
pub fn set_content_io_provider(provider: Box<dyn ContentIoProvider>) {
    let _ = CONTENT_IO_PROVIDER.set(provider);
}

/// 获取已注册的 ContentIoProvider。
#[cfg(target_os = "android")]
pub fn get_content_io_provider() -> Option<&'static dyn ContentIoProvider> {
    CONTENT_IO_PROVIDER.get().map(|b| b.as_ref())
}
