use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use url::Url;
/// 在阻塞线程中计算文件 SHA256，使用大缓冲区顺序读，避免 tokio 小缓冲 + 多次 await 的开销。
pub async fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[allow(dead_code)]
pub fn compute_bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub const MAX_SAFE_FILENAME_LEN: usize = 180;

/// 将字符串裁剪到不超过 `max_len` 字节。`max_len` 是**字节**预算(多数文件系统按字节
/// 限制文件名长度,如 ext4/APFS 的 255 字节),但裁剪点会回退到最近的 UTF-8 字符边界,
/// 避免把一个多字节字符(如中文)截断成非法 UTF-8。
pub fn clamp_utf8_len(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub fn is_windows_reserved_device_name(stem: &str) -> bool {
    let u = stem
        .trim()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if (u.starts_with("COM") || u.starts_with("LPT")) && u.len() == 4 {
        return matches!(
            u.chars().nth(3),
            Some('1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9')
        );
    }
    false
}

/// 跨平台文件名非法字符:Windows 保留的 `< > : " / \ | ? *`、路径分隔符,以及任意控制字符
/// (含 Unicode 控制字符)。其余字符——包括中文、日文假名、韩文、重音拉丁等——一律保留,
/// 因此生成的文件名可以宽松地承载多语言标题,同时在 Windows/macOS/Linux 上都合法。
fn is_forbidden_filename_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
}

pub fn sanitize_stem_for_filename(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| if is_forbidden_filename_char(c) { '_' } else { c })
        .collect();

    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    let out = out.trim().trim_end_matches([' ', '.']).to_string();

    let mut out = if out.is_empty() {
        "image".to_string()
    } else {
        out
    };
    if is_windows_reserved_device_name(&out) {
        out = format!("_{}", out);
    }
    out
}

pub fn normalize_ext(ext: &str, fallback_ext: &str) -> String {
    let e = ext.trim().trim_start_matches('.').trim();
    let e = if e.is_empty() { fallback_ext.trim() } else { e };
    let e = e.trim().trim_start_matches('.').trim();
    if e.is_empty() {
        crate::image_type::default_image_extension().to_string()
    } else {
        e.to_ascii_lowercase()
    }
}

pub fn build_safe_filename(hint_filename: &str, fallback_ext: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let raw_ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let ext = normalize_ext(raw_ext, fallback_ext);
    let stem = sanitize_stem_for_filename(raw_stem);

    let reserve = 1 + ext.len();
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);

    format!("{}.{}", stem_final, ext)
}

/// 生成无扩展名的安全文件名。仅桌面端在 URL 无扩展名时使用，不添加默认扩展名。
pub fn build_safe_filename_no_ext(hint_filename: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let stem = sanitize_stem_for_filename(raw_stem);
    let stem_max = MAX_SAFE_FILENAME_LEN.max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    stem_final.to_string()
}

fn build_safe_custom_filename(hint_name: &str, ext: Option<&str>) -> String {
    let hint_name = hint_name.replace(['/', '\\'], "_");
    let Some(ext) = ext.filter(|value| !value.trim().trim_start_matches('.').is_empty()) else {
        let stem = sanitize_stem_for_filename(&hint_name);
        let stem_max = MAX_SAFE_FILENAME_LEN.max(1);
        let stem_final = clamp_utf8_len(&stem, stem_max);
        return stem_final.to_string();
    };

    let ext = normalize_ext(ext, crate::image_type::default_image_extension());
    let suffix = format!(".{ext}");
    let raw_stem = hint_name
        .strip_suffix(&suffix)
        .or_else(|| {
            let lower = hint_name.to_ascii_lowercase();
            lower
                .strip_suffix(&suffix)
                .map(|stem| &hint_name[..stem.len()])
        })
        .unwrap_or(hint_name.as_str());
    let stem = sanitize_stem_for_filename(raw_stem);
    let reserve = 1 + ext.len();
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    format!("{}.{}", stem_final, ext)
}

pub fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let mut candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut idx = 1;
    loop {
        let suffix = format!("({})", idx);
        let (stem_max, ext_part) = if ext.is_empty() {
            (
                MAX_SAFE_FILENAME_LEN.saturating_sub(suffix.len()).max(1),
                String::new(),
            )
        } else {
            (
                MAX_SAFE_FILENAME_LEN
                    .saturating_sub(suffix.len() + 1 + ext.len())
                    .max(1),
                format!(".{}", ext),
            )
        };
        let stem_final = clamp_utf8_len(stem, stem_max);
        let new_name = format!("{}{}{}", stem_final, suffix, ext_part);
        candidate = dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
        idx += 1;
    }
}

/// Build the final local download path for a URL inside `output_dir`.
///
/// This function only computes a path; it does not create `output_dir` and does not create
/// the returned file. The filename stem is derived from the URL path. When `ext` is `Some`,
/// that caller-provided extension is used; otherwise the URL filename keeps its own extension
/// rules. The full name is passed through [`unique_path`] so an existing file becomes
/// `name(1).ext`, `name(2).ext`, and so on.
///
/// Use this for all non-content download targets, including queue downloads and native
/// browser/surf downloads, so they share the same filename and deduplication rules.
///
/// # Example
///
/// ```rust,no_run
/// use kabegame_core::crawler::downloader::compute_unique_download_path;
///
/// let output_dir = std::env::temp_dir();
/// let path = compute_unique_download_path(
///     &output_dir,
///     "https://example.com/gallery/wallpaper.jpg?size=large",
///     Some("jpg"),
/// )?;
///
/// assert!(path.starts_with(&output_dir));
/// assert_eq!(path.file_name().and_then(|name| name.to_str()), Some("wallpaper.jpg"));
/// # Ok::<(), String>(())
/// ```
pub fn compute_unique_download_path(
    output_dir: &Path,
    url: &Url,
    ext: Option<&str>,
) -> Result<PathBuf, String> {
    let url_path = url
        .path_segments()
        .and_then(|segments| segments.last())
        .unwrap_or("image");
    let filename = if let Some(ext) = ext.filter(|e| !e.trim().trim_start_matches('.').is_empty()) {
        let path = Path::new(url_path);
        let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
        let ext = normalize_ext(ext, crate::image_type::default_image_extension());
        let stem = sanitize_stem_for_filename(raw_stem);
        let reserve = 1 + ext.len();
        let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
        let stem_final = clamp_utf8_len(&stem, stem_max);
        format!("{}.{}", stem_final, ext)
    } else {
        let extension = Path::new(url_path).extension().and_then(|e| e.to_str());
        #[cfg(target_os = "android")]
        {
            build_safe_filename(
                url_path,
                extension.unwrap_or(crate::image_type::default_image_extension()),
            )
        }
        #[cfg(not(target_os = "android"))]
        {
            match extension {
                Some(ext) => build_safe_filename(url_path, ext),
                None => build_safe_filename_no_ext(url_path),
            }
        }
    };
    Ok(unique_path(output_dir, &filename))
}

pub fn compute_unique_download_path_with_name(
    output_dir: &Path,
    url: &Url,
    ext: Option<&str>,
    name: Option<&str>,
) -> Result<PathBuf, String> {
    let Some(name) = name.filter(|value| !value.trim().is_empty()) else {
        return compute_unique_download_path(output_dir, url, ext);
    };

    let fallback_ext = ext.or_else(|| {
        url.path_segments()
            .and_then(|segments| segments.last())
            .and_then(|name| Path::new(name).extension())
            .and_then(|ext| ext.to_str())
    });
    #[cfg(target_os = "android")]
    let fallback_ext = fallback_ext.or_else(|| Some(crate::image_type::default_image_extension()));

    Ok(unique_path(
        output_dir,
        &build_safe_custom_filename(name, fallback_ext),
    ))
}

#[cfg(test)]
mod tests {
    use super::{compute_unique_download_path, compute_unique_download_path_with_name};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use url::Url;

    #[test]
    fn compute_unique_download_path_uses_linear_probe_without_hash_suffix() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("wallpaper.jpg"), b"existing").unwrap();
        let first = compute_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.jpg?size=large").unwrap(),
            Some("jpg"),
        )
        .unwrap();
        assert_eq!(
            first.file_name().and_then(|name| name.to_str()),
            Some("wallpaper(1).jpg")
        );

        fs::write(&first, b"existing").unwrap();
        let second = compute_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.jpg?size=large").unwrap(),
            Some("jpg"),
        )
        .unwrap();
        assert_eq!(
            second.file_name().and_then(|name| name.to_str()),
            Some("wallpaper(2).jpg")
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compute_unique_download_path_uses_explicit_extension() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-ext-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        let path = compute_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.txt?size=large").unwrap(),
            Some("png"),
        )
        .unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("wallpaper.png")
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sanitize_stem_keeps_cjk_and_strips_only_forbidden_chars() {
        use super::sanitize_stem_for_filename;
        // 中文/日文假名保留,仅 Windows 保留字符被替换为下划线。
        assert_eq!(sanitize_stem_for_filename("壁纸标题"), "壁纸标题");
        assert_eq!(
            sanitize_stem_for_filename("東方 <幻想郷>: レミリア"),
            "東方 _幻想郷__ レミリア"
        );
        assert_eq!(sanitize_stem_for_filename("a/b\\c"), "a_b_c");
    }

    #[test]
    fn clamp_utf8_len_never_splits_a_multibyte_char() {
        use super::clamp_utf8_len;
        let s = "壁纸"; // 每个汉字 3 字节,共 6 字节
        // max_len 落在字符中间时应回退到边界,而不是 panic 或产生非法 UTF-8。
        assert_eq!(clamp_utf8_len(s, 4), "壁");
        assert_eq!(clamp_utf8_len(s, 3), "壁");
        assert_eq!(clamp_utf8_len(s, 2), "");
        assert_eq!(clamp_utf8_len(s, 6), "壁纸");
    }

    #[test]
    fn compute_unique_download_path_with_name_preserves_title_prefix() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-name-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        let path = compute_unique_download_path_with_name(
            &dir,
            &Url::parse("https://example.com/video/media.mp4?download=1").unwrap(),
            None,
            Some("Some.Page / media.mp4"),
        )
        .unwrap();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Some_Page _ media.mp4")
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(target_os = "android")]
pub(super) fn derive_display_name_from_url(url: &str) -> String {
    let fallback_ext = crate::image_type::default_image_extension();
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return format!("image.{}", fallback_ext),
    };
    let last = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("image");
    let path = Path::new(last);
    let stem =
        sanitize_stem_for_filename(path.file_stem().and_then(|s| s.to_str()).unwrap_or("image"));
    let ext = normalize_ext(
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        fallback_ext,
    );
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(ext.len() + 1).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    format!("{}.{}", stem_final, ext)
}

#[cfg(target_os = "android")]
pub(super) fn mime_type_from_filename(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(crate::image_type::default_image_extension())
        .trim_start_matches('.')
        .to_ascii_lowercase();
    crate::image_type::mime_by_ext()
        .get(&ext)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

#[cfg(windows)]
pub(super) fn remove_zone_identifier(file_path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::DeleteFileW;

    let mut stream_path = file_path.as_os_str().to_owned();
    stream_path.push(":Zone.Identifier");

    let wide_path: Vec<u16> = OsStr::new(&stream_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        DeleteFileW(wide_path.as_ptr());
    }
}
