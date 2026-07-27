use serde::{Deserialize, Serialize};

mod exif_common;
mod gif;
mod jpeg;
mod png;
mod webp;

/// 前端需同步下面这组各格式解析器版本常量。
pub const JPEG_PARSER_VERSION: u32 = 1;
pub const PNG_PARSER_VERSION: u32 = 1;
pub const WEBP_PARSER_VERSION: u32 = 1;
pub const GIF_PARSER_VERSION: u32 = 1;

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
#[serde(rename_all = "camelCase")]
pub struct WebpNativeMetadata {
    pub partial: bool,
    pub groups: Vec<NativeGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifNativeMetadata {
    pub partial: bool,
    pub groups: Vec<NativeGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum NativeMetadata {
    Jpeg(JpegNativeMetadata),
    Png(PngNativeMetadata),
    Webp(WebpNativeMetadata),
    Gif(GifNativeMetadata),
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
        "image/webp" => Some(NativeMetadata::Webp(webp::parse(bytes))),
        "image/gif" => Some(NativeMetadata::Gif(gif::parse(bytes))),
        _ => None,
    }
}

/// 返回该格式解析器的当前版本；不支持的格式返回 `None`。
pub fn parser_version_for(format_key: &str) -> Option<u32> {
    match format_key.trim().to_ascii_lowercase().as_str() {
        "image/jpg" | "image/jpeg" => Some(JPEG_PARSER_VERSION),
        "image/png" => Some(PNG_PARSER_VERSION),
        "image/webp" => Some(WEBP_PARSER_VERSION),
        "image/gif" => Some(GIF_PARSER_VERSION),
        _ => None,
    }
}

pub fn supports_native_metadata(format_key: &str) -> bool {
    parser_version_for(format_key).is_some()
}

fn is_false(value: &bool) -> bool {
    !*value
}
