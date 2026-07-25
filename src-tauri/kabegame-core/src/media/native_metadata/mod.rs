use serde::{Deserialize, Serialize};

mod jpeg;
mod png;

/// 与前端 `NATIVE_METADATA_PARSER_VERSION` 保持同步。
pub const PARSER_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEntry {
    pub tag: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub long: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_len: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGroup {
    pub id: String,
    pub subtitle: String,
    pub entries: Vec<NativeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JpegNativeMetadata {
    pub partial: bool,
    pub groups: Vec<NativeGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PngNativeMetadata {
    pub partial: bool,
    pub groups: Vec<NativeGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum NativeMetadata {
    Jpeg(JpegNativeMetadata),
    Png(PngNativeMetadata),
}

/// 读取原图字节；Android 的 `content://` 通过内容提供器读取。
pub async fn read_image_bytes(local_path: &str) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "android")]
    if local_path.starts_with("content://") {
        return crate::crawler::content_io::get_content_io_provider()
            .read_file_bytes(local_path)
            .await
            .map_err(|_| "native-metadata:file-missing".to_string());
    }

    tokio::fs::read(local_path)
        .await
        .map_err(|_| "native-metadata:file-missing".to_string())
}

/// 按 `images.type` 格式键解析图片内嵌元数据；其他格式不处理。
pub fn parse_native_metadata(format_key: &str, bytes: &[u8]) -> Option<NativeMetadata> {
    match format_key.trim().to_ascii_lowercase().as_str() {
        "image/jpg" | "image/jpeg" => Some(NativeMetadata::Jpeg(jpeg::parse(bytes))),
        "image/png" => Some(NativeMetadata::Png(png::parse(bytes))),
        _ => None,
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}
