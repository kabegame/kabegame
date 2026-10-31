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

    /// 是否为目录型 WPE 壁纸（`local_path` 是目录，不是可直接读取的媒体文件）。
    pub fn is_wpe(&self) -> bool {
        self.key.starts_with("x-wpe/")
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
    // 目录型 WPE 壁纸：`local_path` 是壁纸目录，入口文件与预览由目录服务解析。
    // 扩展名为空表示不能按扩展名摄入，只能经 `project.json` 入库；
    // `mime` 只是格式表占位，目录型条目永远不经 `mime_from_format` 出边界。
    MediaFormat {
        key: "x-wpe/video",
        mime: "application/x-wpe-project",
        extensions: &[],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "x-wpe/web",
        mime: "application/x-wpe-project",
        extensions: &[],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
    MediaFormat {
        key: "x-wpe/scene",
        mime: "application/x-wpe-project",
        extensions: &[],
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

/// 目录型 WPE 壁纸的类型键前缀。
pub const WPE_FORMAT_PREFIX: &str = "x-wpe/";

/// 格式键是否表示目录型 WPE 壁纸。
pub fn is_wpe_format_key(value: &str) -> bool {
    value
        .trim()
        .to_ascii_lowercase()
        .starts_with(WPE_FORMAT_PREFIX)
}

/// `images.type` 是否表示目录型 WPE 壁纸。
pub fn is_wpe_type(media_type: Option<&str>) -> bool {
    wpe_kind(media_type).is_some()
}

/// 取 WPE 壁纸的子类型（`video` / `web` / `scene` / 其它作者自定义值）。
///
/// 返回小写后缀；非 `x-wpe/*` 返回 `None`。
pub fn wpe_kind(media_type: Option<&str>) -> Option<String> {
    let raw = media_type?.trim();
    raw.to_ascii_lowercase()
        .strip_prefix(WPE_FORMAT_PREFIX)
        .map(str::to_string)
}

/// 是否为 `x-wpe/video`（目录型视频壁纸）。
pub fn is_wpe_video_type(media_type: Option<&str>) -> bool {
    wpe_kind(media_type).as_deref() == Some("video")
}

/// 按 `images.type` 判断是否「播放为视频」：`video/*`、历史 `video` 或 `x-wpe/video`。
///
/// 这是后端唯一需要区分「视频形态」的判断口径；不要再用扩展名猜目录型壁纸。
pub fn is_video_like_type(media_type: Option<&str>) -> bool {
    let Some(raw) = media_type.map(str::trim).filter(|t| !t.is_empty()) else {
        return false;
    };
    let lower = raw.to_ascii_lowercase();
    lower == "video" || lower.starts_with("video/") || lower == "x-wpe/video"
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

/// 根据格式键或 MIME 判断是否为可摄入的媒体（图片或视频）。
///
/// 用于页面自发下载的 MIME 判定：`application/octet-stream`、压缩包等一律返回 false。
pub fn is_supported_media_mime(mime: &str) -> bool {
    media_format(mime)
        .is_some_and(|format| format.ingestible() && (format.is_image() || format.is_video()))
}

/// 默认图片格式键（无类型或历史存 `image` 时）。
pub fn default_image_format() -> &'static str {
    "image/jpg"
}

/// 默认视频格式键（历史存 `video` 且无更细信息时）。
pub fn default_video_format() -> &'static str {
    "video/mp4"
}

/// `images.type` 的唯一规范化入口：返回值一定非空、小写、形如「主类/子类」且两段都非空。
/// 所有写入 `images.type` 的路径都必须经过它（查询层据此直接读列，不再包 LOWER / COALESCE）。
pub fn normalize_stored_media_type(media_type: Option<String>) -> String {
    let raw = media_type.unwrap_or_default();
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() || lower == "image" {
        return default_image_format().to_string();
    }
    if lower == "video" {
        return default_video_format().to_string();
    }
    if let Some(format) = media_format(&lower) {
        return format.key.to_string();
    }
    // 格式表外的值按 v049 的同一条规则兜底
    match lower.find('/') {
        None => format!("image/{lower}"),
        Some(0) => default_image_format().to_string(),
        Some(_) if lower.ends_with('/') => default_image_format().to_string(),
        Some(_) => lower,
    }
}

/// 是否满足 `images.type` 的不变量（测试与断言用）。
pub fn is_stored_media_type(value: &str) -> bool {
    value == value.trim().to_lowercase()
        && !value.ends_with('/')
        && value
            .find('/')
            .is_some_and(|slash| slash > 0 && slash + 1 < value.len())
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
    fn stored_media_type_always_satisfies_invariant() {
        for (input, expected) in [
            (None, "image/jpg"),
            (Some(""), "image/jpg"),
            (Some(" IMAGE "), "image/jpg"),
            (Some("Video"), "video/mp4"),
            (Some("gif"), "image/gif"),
            (Some("/webp"), "image/jpg"),
            (Some("image/"), "image/jpg"),
            (Some("x-wpe/web"), "x-wpe/web"),
            (Some("image/jpeg"), "image/jpg"),
            (Some("text/plain"), "text/plain"),
            (Some("\tTEXT/PLAIN\n"), "text/plain"),
            (Some("自定义/格式"), "自定义/格式"),
        ] {
            let actual = normalize_stored_media_type(input.map(str::to_owned));
            assert_eq!(actual, expected, "input={input:?}");
            assert!(is_stored_media_type(&actual), "input={input:?}: {actual}");
        }
        for invalid in [
            "",
            "image",
            "/jpg",
            "image/",
            "image//",
            "image/jpg/",
            " Image/jpg",
            "IMAGE/JPG",
            "image/jpg ",
        ] {
            assert!(!is_stored_media_type(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn stored_media_type_fallback_matches_v049_sql() {
        use crate::storage::migrations::v049_images_type_normalized::NORMALIZED_TYPE_SQL;

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE images (type TEXT)")
            .unwrap();
        let sql = format!("SELECT {NORMALIZED_TYPE_SQL} FROM images");
        // 已知别名由运行时格式表归并，迁移只保证形态；只对未命中格式表的 ASCII 输入比较。
        for input in [
            None,
            Some(""),
            Some("  "),
            Some("image"),
            Some("VIDEO"),
            Some(" GIF "),
            Some("/webp"),
            Some("image/"),
            Some("/"),
            Some("text/plain"),
            Some(" CUSTOM/FORMAT "),
            Some("custom/format/extra"),
        ] {
            assert!(input.is_none_or(|value| media_format(value).is_none()));
            conn.execute("DELETE FROM images", []).unwrap();
            conn.execute("INSERT INTO images(type) VALUES (?1)", [input])
                .unwrap();
            let migrated: String = conn.query_row(&sql, [], |row| row.get(0)).unwrap();
            let written = normalize_stored_media_type(input.map(str::to_owned));
            assert_eq!(migrated, written, "input={input:?}");
            assert!(is_stored_media_type(&migrated));
        }
    }

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
            normalize_stored_media_type(Some("image/jpeg".to_string())),
            "image/jpg"
        );
        assert_eq!(
            normalize_stored_media_type(Some("text/plain".to_string())),
            "text/plain"
        );
    }

    #[test]
    fn wpe_directory_formats_are_resolvable_but_not_ingestible() {
        let format = media_format("x-wpe/video").expect("x-wpe/video 必须能解析");
        assert_eq!(format.key, "x-wpe/video");
        assert!(format.is_wpe());
        assert!(!format.ingestible());
        assert!(!format.is_image());
        assert!(!format.is_video());
        assert_eq!(
            normalize_stored_media_type(Some("x-wpe/video".to_string())),
            "x-wpe/video"
        );
        assert!(media_format("x-wpe/web").is_some());
        assert!(media_format("x-wpe/scene").is_some());
        // 目录型条目不得进入按扩展名摄入的列表。
        assert!(!supported_media_extensions()
            .iter()
            .any(|ext| ext == "x-wpe/video"));
        assert!(!mime_by_ext()
            .values()
            .any(|m| m == "application/x-wpe-project"));

        assert_eq!(wpe_kind(Some("x-wpe/video")).as_deref(), Some("video"));
        assert!(is_wpe_type(Some("X-WPE/VIDEO")));
        assert!(!is_wpe_type(Some("video/mp4")));
        assert!(is_wpe_video_type(Some("x-wpe/video")));
        assert!(!is_wpe_video_type(Some("x-wpe/web")));

        assert!(is_video_like_type(Some("x-wpe/video")));
        assert!(is_video_like_type(Some("video/mp4")));
        assert!(is_video_like_type(Some("video")));
        assert!(!is_video_like_type(Some("x-wpe/web")));
        assert!(!is_video_like_type(Some("image/jpg")));
        assert!(!is_video_like_type(None));
    }
}
