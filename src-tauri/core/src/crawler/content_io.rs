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

/// Android content:// IO 操作抽象。由 app-main 用 PluginHandle 实现并注册。异步 trait，避免在调度器 runtime 上 block_on 导致死锁。
#[cfg(target_os = "android")]
#[async_trait::async_trait]
pub trait ContentIoProvider: Send + Sync {
    async fn is_directory(&self, uri: &str) -> Result<bool, String>;
    async fn get_mime_type(&self, uri: &str) -> Result<Option<String>, String>;
    async fn list_children(&self, uri: &str) -> Result<Vec<ContentEntry>, String>;
    async fn read_file_bytes(&self, uri: &str) -> Result<Vec<u8>, String>;
    async fn take_persistable_permission(&self, uri: &str) -> Result<(), String>;
    async fn get_image_dimensions(&self, uri: &str) -> Result<(u32, u32), String>;
    async fn get_display_name(&self, uri: &str) -> Result<String, String>;
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
pub fn get_content_io_provider() -> &'static dyn ContentIoProvider {
    CONTENT_IO_PROVIDER.get().map(|b| b.as_ref()).unwrap()
}
