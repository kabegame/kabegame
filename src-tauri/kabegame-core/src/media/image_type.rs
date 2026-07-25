//! 支持的媒体格式、扩展名与标准 MIME，集中定义供后端与前端一致使用。
//! `images.type` 存格式键；HTTP 与 Android MediaStore 等边界再映射为标准 MIME。

use std::collections::HashMap;
use std::path::Path;

/// 统一媒体格式表项，以「格式键」（kind/规范后缀）为主键。
///
/// 种类由 `key` 的 `image/`、`video/` 前缀编码，不另设字段。
pub struct MediaFormat {
    /// 格式键，也是 `images.type` 的存储值。
    pub key: &'static str,
    /// 标准 MIME，用于 HTTP Content-Type、Android MediaStore 等外部边界。
    pub mime: &'static str,
    /// 支持的扩展名，第一个为规范后缀；空表示不可摄入。
    pub extensions: &'static [&'static str],
    /// 额外 MIME 别名，仅用于解析。
    pub aliases: &'static [&'static str],
    /// 浏览器是否可直接显示；仅图片有意义。
    pub browser_safe: bool,
    /// Linux/Windows 原生壁纸后端是否可直接解码。
    pub native_wallpaper_safe: bool,
}

impl MediaFormat {
    /// 返回落盘使用的规范后缀。
    pub fn canonical_ext(&self) -> Option<&'static str> {
        self.extensions.first().copied()
    }

    /// 是否允许摄入。
    pub fn ingestible(&self) -> bool {
        !self.extensions.is_empty()
    }

    /// 是否为视频格式。
    pub fn is_video(&self) -> bool {
        self.key.starts_with("video/")
    }

    /// 是否为图片格式。
    pub fn is_image(&self) -> bool {
        self.key.starts_with("image/")
    }
}

/// 媒体格式的唯一事实来源。
pub const MEDIA_FORMATS: &[MediaFormat] = &[
    MediaFormat {
        key: "image/jpg",
        mime: "image/jpeg",
        extensions: &["jpg", "jpeg"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "image/png",
        mime: "image/png",
        extensions: &["png"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "image/gif",
        mime: "image/gif",
        extensions: &["gif"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "image/bmp",
        mime: "image/bmp",
        extensions: &["bmp"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "image/webp",
        mime: "image/webp",
        extensions: &["webp"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "image/avif",
        mime: "image/avif",
        extensions: &["avif"],
        aliases: &[],
        browser_safe: true,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "image/heic",
        mime: "image/heic",
        extensions: &["heic"],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "image/heif",
        mime: "image/heif",
        extensions: &["heif"],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "image/tiff",
        mime: "image/tiff",
        extensions: &[],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: true,
    },
    MediaFormat {
        key: "video/mp4",
        mime: "video/mp4",
        extensions: &["mp4", "m4v", "3gp", "3g2"],
        aliases: &["video/x-m4v", "video/3gpp", "video/3gpp2"],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "video/mov",
        mime: "video/quicktime",
        extensions: &["mov"],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "video/wmv",
        mime: "video/x-ms-wmv",
        extensions: &["wmv", "asf"],
        aliases: &["video/x-ms-asf"],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "video/webm",
        mime: "video/webm",
        extensions: &["webm"],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "video/mkv",
        mime: "video/x-matroska",
        extensions: &["mkv"],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
];

/// 按格式键、标准 MIME 或 MIME 别名解析媒体格式。
///
/// 输入会先去除首尾空白、转为小写，并忽略 `;codecs=...` 等参数。
pub fn media_format(input: &str) -> Option<&'static MediaFormat> {
    let base = input
        .trim()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if base.is_empty() {
        return None;
    }
    MEDIA_FORMATS.iter().find(|format| {
        format.key == base || format.mime == base || format.aliases.contains(&base.as_str())
    })
}

/// 按扩展名解析媒体格式。
pub fn media_format_by_ext(ext: &str) -> Option<&'static MediaFormat> {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ext.is_empty() {
        return None;
    }
    MEDIA_FORMATS
        .iter()
        .find(|format| format.extensions.contains(&ext.as_str()))
}

/// 把格式键、标准 MIME 或 MIME 别名映射为标准 MIME。
pub fn mime_from_format(input: &str) -> Option<&'static str> {
    media_format(input).map(|format| format.mime)
}

/// 判断图片 MIME 是否可在浏览器中直接显示（不需要生成兼容副本）。
pub fn image_mime_browser_safe(mime: &str) -> bool {
    media_format(mime).is_some_and(|format| format.is_image() && format.browser_safe)
}

/// 判断图片 MIME 是否可直接交给 Linux/Windows 原生桌面壁纸后端。
pub fn image_mime_native_wallpaper_safe(mime: &str) -> bool {
    media_format(mime).is_some_and(|format| format.is_image() && format.native_wallpaper_safe)
}

/// 判断扩展名是否为支持的图片类型。`ext` 可为含点或小写。
#[inline]
pub fn is_supported_image_ext(ext: &str) -> bool {
    media_format_by_ext(ext).is_some_and(MediaFormat::is_image)
}

/// 根据本地路径判断是否为支持的图片：先看扩展名，再按文件内容用 infer 推断。
/// infer 推断出的类型也必须在支持列表中才视为图片。
pub fn is_image_by_path(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if is_supported_image_ext(ext) {
        return true;
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        return media_format(kind.mime_type())
            .is_some_and(|format| format.ingestible() && format.is_image());
    }
    false
}

/// 根据本地文件路径用 infer 推断格式键；仅当推断结果可摄入时返回。
/// 用于下载入库、迁移回填等需要“按内容推断”的场景。
pub fn mime_type_from_path(path: &Path) -> Option<String> {
    let kind = infer::get_from_path(path).ok().flatten()?;
    media_format(kind.mime_type())
        .filter(|format| format.ingestible())
        .map(|format| format.key.to_string())
}

/// 根据内存字节用 infer 推断格式键；仅当推断结果可摄入时返回。
pub fn mime_type_from_bytes(bytes: &[u8]) -> Option<String> {
    let kind = infer::get(bytes)?;
    media_format(kind.mime_type())
        .filter(|format| format.ingestible())
        .map(|format| format.key.to_string())
}

/// 判断 URL 是否以支持的图片扩展名结尾。
pub fn url_has_image_extension(url: &str) -> bool {
    let url_lower = url.to_lowercase();
    if let Some(dot) = url_lower.rfind('.') {
        let ext = url_lower[dot + 1..].trim();
        is_supported_image_ext(ext)
    } else {
        false
    }
}

/// 返回支持的图片扩展名列表（内置，去重，供前端等使用）。
pub fn supported_image_extensions() -> Vec<String> {
    let mut out: Vec<String> = MEDIA_FORMATS
        .iter()
        .filter(|format| format.is_image())
        .flat_map(|format| format.extensions.iter().copied())
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 返回支持的视频扩展名列表（内置，去重）。
pub fn supported_video_extensions() -> Vec<String> {
    let mut out: Vec<String> = MEDIA_FORMATS
        .iter()
        .filter(|format| format.is_video())
        .flat_map(|format| format.extensions.iter().copied())
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 返回支持的媒体扩展名（图片 + 视频）。
pub fn supported_media_extensions() -> Vec<String> {
    let mut out = supported_image_extensions();
    out.extend(supported_video_extensions());
    out.sort();
    out.dedup();
    out
}

/// 返回扩展名 -> MIME 映射（仅包含当前支持的扩展名，供前端分享等使用）。
pub fn mime_by_ext() -> HashMap<String, String> {
    MEDIA_FORMATS
        .iter()
        .flat_map(|format| {
            format
                .extensions
                .iter()
                .map(move |ext| ((*ext).to_string(), format.mime.to_string()))
        })
        .collect()
}

/// 默认图片扩展名（无扩展名时的 fallback，如下载、缩略图）。
pub fn default_image_extension() -> &'static str {
    "jpg"
}

/// 根据格式键、标准 MIME 或别名返回规范扩展名（小写，不含点）。
pub fn ext_from_mime(mime: &str) -> Option<String> {
    media_format(mime)
        .and_then(MediaFormat::canonical_ext)
        .map(str::to_string)
}

/// 根据格式键或 MIME 判断是否为支持的图片（用于 Android content:// URI）。
pub fn is_image_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    media_format(m).is_some_and(|format| format.ingestible() && format.is_image())
}

/// 根据格式键或 MIME 判断是否为支持的视频（用于 Android content:// URI）。
pub fn is_video_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    media_format(m).is_some_and(|format| format.ingestible() && format.is_video())
}

/// 默认图片格式键（无类型或历史存 `image` 时）。
pub fn default_image_format() -> &'static str {
    "image/jpg"
}

/// 默认视频格式键（历史存 `video` 且无更细信息时）。
pub fn default_video_format() -> &'static str {
    "video/mp4"
}

/// 将数据库/API 中的 `type` 规范为格式键；未知特殊值仅转小写后透传。
pub fn normalize_stored_media_type(media_type: Option<String>) -> Option<String> {
    let raw = media_type.unwrap_or_default();
    let s = raw.trim();
    if s.is_empty() {
        return Some(default_image_format().to_string());
    }
    let lower = s.to_lowercase();
    if lower == "image" {
        return Some(default_image_format().to_string());
    }
    if lower == "video" {
        return Some(default_video_format().to_string());
    }
    Some(
        media_format(&lower)
            .map(|format| format.key.to_string())
            .unwrap_or(lower),
    )
}

/// 判断扩展名是否为支持的视频类型。
#[inline]
pub fn is_supported_video_ext(ext: &str) -> bool {
    media_format_by_ext(ext).is_some_and(MediaFormat::is_video)
}

/// 判断扩展名是否为支持的媒体类型（图片 + 视频）。
#[inline]
pub fn is_supported_media_ext(ext: &str) -> bool {
    is_supported_image_ext(ext) || is_supported_video_ext(ext)
}

/// 指定平台下该媒体是否必须走插件模式设置壁纸（Linux Plasma）。
///
/// - Linux: GIF + 所有支持的视频类型（mp4/mov）需要插件模式
/// - 其他平台: false
pub fn requires_plugin_mode(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .trim_start_matches('.')
            .to_lowercase();
        ext == "gif" || is_supported_video_ext(&ext)
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// 指定平台下该媒体是否必须走窗口模式设置壁纸。
///
/// - macOS: GIF + 所有支持的视频类型（mp4/mov）
/// - Windows: 仅 mp4
/// - 其他平台: false
pub fn requires_window_mode(path: &Path) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .trim_start_matches('.')
        .to_lowercase();

    #[cfg(target_os = "macos")]
    {
        return ext == "gif" || is_supported_video_ext(&ext);
    }

    #[cfg(target_os = "windows")]
    {
        return ext == "mp4";
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// 根据本地路径判断是否为支持的视频：先看扩展名，再按文件内容 infer 推断。
pub fn is_video_by_path(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if is_supported_video_ext(ext) {
        return true;
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        return media_format(kind.mime_type())
            .is_some_and(|format| format.ingestible() && format.is_video());
    }
    false
}

/// 根据本地路径判断是否为支持的媒体（图片 + 视频）。
pub fn is_media_by_path(path: &Path) -> bool {
    is_image_by_path(path) || is_video_by_path(path)
}

/// 判断 URL 是否以支持的视频扩展名结尾。
pub fn url_has_video_extension(url: &str) -> bool {
    let url_lower = url.to_lowercase();
    if let Some(dot) = url_lower.rfind('.') {
        let ext = url_lower[dot + 1..].trim();
        is_supported_video_ext(ext)
    } else {
        false
    }
}

/// 判断 URL 是否以支持的媒体扩展名结尾。
pub fn url_has_media_extension(url: &str) -> bool {
    url_has_image_extension(url) || url_has_video_extension(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_image_support_includes_modern_and_heif_formats() {
        let extensions = supported_image_extensions();
        assert!(extensions.iter().any(|ext| ext == "webp"));
        assert!(extensions.iter().any(|ext| ext == "avif"));
        assert!(extensions.iter().any(|ext| ext == "heic"));
        assert!(extensions.iter().any(|ext| ext == "heif"));
        assert!(is_supported_image_ext("avif"));
        assert!(is_supported_image_ext("heic"));
        assert!(image_mime_browser_safe("image/avif"));
        assert!(!image_mime_browser_safe("image/heic"));
        assert!(!image_mime_browser_safe("image/heif"));
        assert!(image_mime_native_wallpaper_safe("image/png"));
        assert!(!image_mime_native_wallpaper_safe("image/webp"));
        assert!(!image_mime_native_wallpaper_safe("image/avif"));
        assert!(!image_mime_browser_safe("image/tiff"));
        assert!(image_mime_native_wallpaper_safe("image/tiff"));

        let mime_by_ext = mime_by_ext();
        assert_eq!(
            mime_by_ext.get("avif").map(String::as_str),
            Some("image/avif")
        );
        assert_eq!(
            mime_by_ext.get("heif").map(String::as_str),
            Some("image/heif")
        );
        assert_eq!(
            mime_by_ext.get("jpg").map(String::as_str),
            Some("image/jpeg")
        );
    }

    #[test]
    fn media_format_resolves_keys_mimes_aliases_and_parameters() {
        assert_eq!(
            media_format("image/jpeg").map(|format| format.key),
            Some("image/jpg")
        );
        assert_eq!(
            media_format("video/webm;codecs=vp9").map(|format| format.key),
            Some("video/webm")
        );
        assert_eq!(ext_from_mime("video/x-matroska").as_deref(), Some("mkv"));
        assert_eq!(mime_from_format("image/jpg"), Some("image/jpeg"));
        assert_eq!(
            normalize_stored_media_type(Some("image/jpeg".to_string())).as_deref(),
            Some("image/jpg")
        );
        assert_eq!(
            normalize_stored_media_type(Some("text/plain".to_string())).as_deref(),
            Some("text/plain")
        );
    }
}
