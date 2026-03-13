//! 支持的图片扩展名与 MIME 类型，集中定义供后端与前端一致使用。
//! 后端初始支持常见类型；前端通过 Tauri 命令上报 WebView 可解码的格式（如 avif、heic）以扩展该列表。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, OnceLock, RwLock};

/// 后端内置支持的图片扩展名（小写，不含点号）。前端可通过 set_frontend_supported_image_formats 扩展。
const BUILTIN_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp",
];
/// 后端内置支持的视频扩展名（小写，不含点号）。
const BUILTIN_VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov"];

/// 扩展名到 MIME 的映射（含前端可能上报的 avif、heic）。
const EXT_MIME: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
    ("mp4", "video/mp4"),
    ("mov", "video/quicktime"),
];

static MIME_BY_EXT: OnceLock<HashMap<String, String>> = OnceLock::new();

/// 前端上报的、当前 WebView 支持解码的扩展名（在内置列表基础上扩展）。
static FRONTEND_EXTENSIONS: LazyLock<RwLock<HashSet<String>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

fn mime_by_ext_map() -> &'static HashMap<String, String> {
    MIME_BY_EXT.get_or_init(|| {
        EXT_MIME
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    })
}

/// 由前端在启动时调用（Tauri 命令），将当前 WebView 检测到的支持格式合并进支持列表。
pub fn set_frontend_supported_image_formats(formats: Vec<String>) {
    let mut set = match FRONTEND_EXTENSIONS.write() {
        Ok(s) => s,
        Err(_) => return,
    };
    set.clear();
    for f in formats {
        let e = f.trim().trim_start_matches('.').to_lowercase();
        if !e.is_empty() {
            set.insert(e);
        }
    }
}

/// 判断扩展名是否为支持的图片类型。`ext` 可为含点或小写。包含内置 + 前端扩展。
#[inline]
pub fn is_supported_image_ext(ext: &str) -> bool {
    let e = ext.trim().trim_start_matches('.').to_lowercase();
    if e.is_empty() {
        return false;
    }
    if BUILTIN_IMAGE_EXTENSIONS.contains(&e.as_str()) {
        return true;
    }
    if let Ok(guard) = FRONTEND_EXTENSIONS.read() {
        guard.contains(&e)
    } else {
        false
    }
}

/// 当前支持的图片 MIME 类型集合（与支持扩展名一致，infer 推断时仅接受该集合内类型）。
fn supported_image_mime_types() -> HashSet<String> {
    let map = mime_by_ext_map();
    supported_image_extensions()
        .into_iter()
        .filter_map(|ext| map.get(&ext).map(|m| m.to_lowercase()))
        .collect()
}

/// 当前支持的视频 MIME 类型集合。
fn supported_video_mime_types() -> HashSet<String> {
    let map = mime_by_ext_map();
    supported_video_extensions()
        .into_iter()
        .filter_map(|ext| map.get(&ext).map(|m| m.to_lowercase()))
        .collect()
}

/// 当前支持的媒体 MIME 类型集合（图片 + 视频）。
fn supported_media_mime_types() -> HashSet<String> {
    let mut out = supported_image_mime_types();
    out.extend(supported_video_mime_types());
    out
}

/// 根据本地路径判断是否为支持的图片：先看扩展名，再按文件内容用 infer 推断。
/// infer 推断出的类型也必须在支持列表中才视为图片。
pub fn is_image_by_path(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if is_supported_image_ext(ext) {
        return true;
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        let mime = kind.mime_type().to_lowercase();
        if supported_image_mime_types().contains(&mime) {
            return true;
        }
    }
    false
}

/// 根据本地文件路径用 infer 推断 MIME 类型；仅当推断结果在支持列表中时返回 `Some(mime)`。
/// 用于下载入库、迁移回填等需要“按内容推断”的场景。
pub fn mime_type_from_path(path: &Path) -> Option<String> {
    let kind = infer::get_from_path(path).ok().flatten()?;
    let mime = kind.mime_type().to_lowercase();
    if supported_media_mime_types().contains(&mime) {
        Some(mime)
    } else {
        None
    }
}

/// 判断 URL 是否以支持的图片扩展名结尾（用于 Rhai `is_image_url` 等）。
pub fn url_has_image_extension(url: &str) -> bool {
    let url_lower = url.to_lowercase();
    if let Some(dot) = url_lower.rfind('.') {
        let ext = url_lower[dot + 1..].trim();
        is_supported_image_ext(ext)
    } else {
        false
    }
}

/// 返回支持的图片扩展名列表（内置 + 前端扩展，去重，供前端等使用）。
pub fn supported_image_extensions() -> Vec<String> {
    let mut exts: HashSet<String> = BUILTIN_IMAGE_EXTENSIONS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if let Ok(guard) = FRONTEND_EXTENSIONS.read() {
        exts.extend(guard.iter().cloned());
    }
    let mut out: Vec<String> = exts.into_iter().collect();
    out.sort();
    out
}

/// 返回支持的视频扩展名列表（内置，去重）。
pub fn supported_video_extensions() -> Vec<String> {
    let mut out: Vec<String> = BUILTIN_VIDEO_EXTENSIONS
        .iter()
        .map(|s| (*s).to_string())
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
    let map = mime_by_ext_map();
    supported_media_extensions()
        .into_iter()
        .filter_map(|ext| map.get(&ext).map(|mime| (ext, mime.clone())))
        .collect()
}

/// 默认图片扩展名（无扩展名时的 fallback，如下载、缩略图）。
pub fn default_image_extension() -> &'static str {
    "jpg"
}

/// 支持的 MIME 到规范扩展名的映射（用于 infer 后为文件补全/修正扩展名）。
const MIME_TO_EXT: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/bmp", "bmp"),
    ("image/avif", "avif"),
    ("image/heic", "heic"),
    ("video/mp4", "mp4"),
    ("video/quicktime", "mov"),
];

static EXT_BY_MIME: OnceLock<HashMap<String, String>> = OnceLock::new();

fn ext_by_mime_map() -> &'static HashMap<String, String> {
    EXT_BY_MIME.get_or_init(|| {
        MIME_TO_EXT
            .iter()
            .map(|(mime, ext)| ((*mime).to_string(), (*ext).to_string()))
            .collect()
    })
}

/// 根据支持的图片 MIME 返回规范扩展名（小写，不含点）。仅当 mime 在支持列表中时返回。用于 infer 推断后为无扩展名或错误扩展名的文件补全/修正。
pub fn ext_from_mime(mime: &str) -> Option<String> {
    let m = mime.trim().to_lowercase();
    if supported_media_mime_types().contains(&m) {
        ext_by_mime_map().get(&m).cloned()
    } else {
        None
    }
}

/// 根据 MIME 类型判断是否为支持的图片（用于 Android content:// URI）。
pub fn is_image_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    let m = m.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    supported_image_mime_types().contains(&m)
}

/// 根据 MIME 类型判断是否为支持的视频（用于 Android content:// URI）。
pub fn is_video_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    let m = m.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    supported_video_mime_types().contains(&m)
}

/// 判断扩展名是否为支持的视频类型。
#[inline]
pub fn is_supported_video_ext(ext: &str) -> bool {
    let e = ext.trim().trim_start_matches('.').to_lowercase();
    if e.is_empty() {
        return false;
    }
    BUILTIN_VIDEO_EXTENSIONS.contains(&e.as_str())
}

/// 判断扩展名是否为支持的媒体类型（图片 + 视频）。
#[inline]
pub fn is_supported_media_ext(ext: &str) -> bool {
    is_supported_image_ext(ext) || is_supported_video_ext(ext)
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
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if is_supported_video_ext(ext) {
        return true;
    }
    if let Ok(Some(kind)) = infer::get_from_path(path) {
        let mime = kind.mime_type().to_lowercase();
        if supported_video_mime_types().contains(&mime) {
            return true;
        }
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

/// 根据 MIME 类型判断是否为支持的压缩包（用于 Android content:// URI）。
pub fn is_archive_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    let m = m.trim().to_lowercase();
    matches!(
        m.as_str(),
        "application/zip"
            | "application/x-zip-compressed"
            | "application/x-rar-compressed"
            | "application/vnd.rar"
            | "application/x-7z-compressed"
            | "application/x-tar"
            | "application/gzip"
            | "application/x-gzip"
            | "application/x-bzip2"
            | "application/x-xz"
    )
}
