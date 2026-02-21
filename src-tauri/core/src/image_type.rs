//! 支持的图片扩展名与 MIME 类型，集中定义供后端与前端一致使用。
//! 后端初始支持常见类型；前端通过 Tauri 命令上报 WebView 可解码的格式（如 avif、heic）以扩展该列表。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, OnceLock, RwLock};

/// 后端内置支持的图片扩展名（小写，不含点号）。前端可通过 set_frontend_supported_image_formats 扩展。
const BUILTIN_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg",
];

/// 扩展名到 MIME 的映射（含前端可能上报的 avif、heic）。
const EXT_MIME: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("heic", "image/heic"),
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
fn supported_mime_types() -> HashSet<String> {
    let map = mime_by_ext_map();
    supported_image_extensions()
        .into_iter()
        .filter_map(|ext| map.get(&ext).map(|m| m.to_lowercase()))
        .collect()
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
        if supported_mime_types().contains(&mime) {
            return true;
        }
    }
    false
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

/// 返回扩展名 -> MIME 映射（仅包含当前支持的扩展名，供前端分享等使用）。
pub fn mime_by_ext() -> HashMap<String, String> {
    let map = mime_by_ext_map();
    supported_image_extensions()
        .into_iter()
        .filter_map(|ext| map.get(&ext).map(|mime| (ext, mime.clone())))
        .collect()
}

/// 默认图片扩展名（无扩展名时的 fallback，如下载、缩略图）。
pub fn default_image_extension() -> &'static str {
    "jpg"
}

/// 根据 MIME 类型判断是否为支持的图片（用于 Android content:// URI）。
pub fn is_image_mime(mime: &Option<String>) -> bool {
    let Some(m) = mime else { return false };
    let m = m.trim().to_lowercase();
    if m.is_empty() {
        return false;
    }
    supported_mime_types().contains(&m)
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
