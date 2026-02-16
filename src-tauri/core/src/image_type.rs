//! 支持的图片扩展名与 MIME 类型，集中定义供后端与前端一致使用。

use std::collections::HashMap;

/// 支持的图片扩展名（小写，不含点号）。唯一数据源。
const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "svg",
];

/// 扩展名到 MIME 的映射（小写扩展名 -> MIME）。
fn mime_by_ext_map() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("jpg".to_string(), "image/jpeg".to_string());
    m.insert("jpeg".to_string(), "image/jpeg".to_string());
    m.insert("png".to_string(), "image/png".to_string());
    m.insert("gif".to_string(), "image/gif".to_string());
    m.insert("webp".to_string(), "image/webp".to_string());
    m.insert("bmp".to_string(), "image/bmp".to_string());
    m.insert("ico".to_string(), "image/x-icon".to_string());
    m.insert("svg".to_string(), "image/svg+xml".to_string());
    m
}

/// 判断扩展名是否为支持的图片类型。`ext` 可为含点或小写。
#[inline]
pub fn is_supported_image_ext(ext: &str) -> bool {
    let e = ext.trim().trim_start_matches('.').to_lowercase();
    SUPPORTED_IMAGE_EXTENSIONS.contains(&e.as_str())
}

/// 判断 URL 是否以支持的图片扩展名结尾（用于 Rhai `is_image_url` 等）。
pub fn url_has_image_extension(url: &str) -> bool {
    let url_lower = url.to_lowercase();
    for ext in SUPPORTED_IMAGE_EXTENSIONS {
        if url_lower.ends_with(&format!(".{}", ext)) {
            return true;
        }
    }
    false
}

/// 返回支持的图片扩展名列表（供前端等使用）。
pub fn supported_image_extensions() -> Vec<String> {
    SUPPORTED_IMAGE_EXTENSIONS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// 返回扩展名 -> MIME 映射（供前端分享等使用）。
pub fn mime_by_ext() -> HashMap<String, String> {
    mime_by_ext_map()
}

/// 默认图片扩展名（无扩展名时的 fallback，如下载、缩略图）。
pub fn default_image_extension() -> &'static str {
    "jpg"
}
