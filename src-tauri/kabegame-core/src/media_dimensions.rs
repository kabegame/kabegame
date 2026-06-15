//! Width/height extraction for stored media.
//!
//! Sync helpers handle desktop and `file://` paths. Android `content://`
//! helpers route through the registered ContentIoProvider.

use std::path::PathBuf;

fn local_path_to_path_buf(local_path: &str) -> PathBuf {
    if let Ok(url) = url::Url::parse(local_path) {
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                return path;
            }
        }
    }
    PathBuf::from(local_path)
}

/// Image dimensions for a desktop or `file://` path. Returns `None` on error.
pub fn resolve_image_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    let path = local_path_to_path_buf(local_path);
    match image::image_dimensions(&path) {
        Ok((w, h)) => Some((w, h)),
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to read image dimensions from {}: {}",
                path.display(),
                e
            );
            None
        }
    }
}

/// Video dimensions for a desktop or `file://` path. Reads the first video
/// stream's `codecpar` width/height via libavformat (rsmpeg), so it works
/// uniformly for mp4/mov/wmv/webm/mkv. Returns `None` on error.
///
/// Android does not link FFmpeg; `content://` video dimensions come from the
/// async ContentIoProvider path in the `android` submodule.
#[cfg(not(target_os = "android"))]
pub fn resolve_video_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    use rsmpeg::avformat::AVFormatContextInput;
    use rsmpeg::ffi;
    use std::ffi::CString;

    let path = local_path_to_path_buf(local_path);
    let path_c = match CString::new(path.to_string_lossy().as_ref()) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let fmt = match AVFormatContextInput::open(&path_c) {
        Ok(fmt) => fmt,
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to open video {}: {:?}",
                path.display(),
                e
            );
            return None;
        }
    };
    let video_idx = match fmt.find_best_stream(ffi::AVMEDIA_TYPE_VIDEO) {
        Ok(Some((idx, _dec))) => idx,
        _ => {
            eprintln!(
                "[media-dimensions] no video stream found in {}",
                path.display()
            );
            return None;
        }
    };
    let codecpar = fmt.streams()[video_idx].codecpar();
    let (width, height) = (codecpar.width, codecpar.height);
    if width > 0 && height > 0 {
        Some((width as u32, height as u32))
    } else {
        eprintln!(
            "[media-dimensions] no video stream dimensions in {}",
            path.display()
        );
        None
    }
}

/// Android stub: FFmpeg is not linked; real `content://` video dimensions come
/// from the async ContentIoProvider path in the `android` submodule.
#[cfg(target_os = "android")]
pub fn resolve_video_dimensions_sync(_local_path: &str) -> Option<(u32, u32)> {
    None
}

/// Dispatcher for desktop or `file://` paths.
pub fn resolve_media_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    let path = local_path_to_path_buf(local_path);
    if crate::image_type::is_video_by_path(path.as_path()) {
        return resolve_video_dimensions_sync(local_path);
    }
    resolve_image_dimensions_sync(local_path)
}

/// File size for a desktop or `file://` path.
pub fn resolve_file_size_sync(local_path: &str) -> Option<u64> {
    let path = local_path_to_path_buf(local_path);
    std::fs::metadata(path).ok().map(|m| m.len())
}

#[cfg(target_os = "android")]
pub mod android {
    use crate::crawler::content_io::get_content_io_provider;

    /// Image dimensions for a `content://` URI.
    pub async fn resolve_image_dimensions(uri: &str) -> Option<(u32, u32)> {
        get_content_io_provider()
            .get_image_dimensions(uri)
            .await
            .map_err(|e| {
                eprintln!("[media-dimensions] get_image_dimensions failed: {}", e);
                e
            })
            .ok()
    }

    /// Video dimensions for a `content://` URI.
    pub async fn resolve_video_dimensions(uri: &str) -> Option<(u32, u32)> {
        get_content_io_provider()
            .get_video_dimensions(uri)
            .await
            .map_err(|e| {
                eprintln!("[media-dimensions] get_video_dimensions failed: {}", e);
                e
            })
            .ok()
    }

    /// Dispatcher for `content://` URIs. Uses MIME first, then falls back to
    /// the URI text if the provider cannot report a MIME type.
    pub async fn resolve_media_dimensions(uri: &str) -> Option<(u32, u32)> {
        let mime = get_content_io_provider()
            .get_mime_type(uri)
            .await
            .ok()
            .flatten();
        if crate::image_type::is_video_mime(&mime) {
            return resolve_video_dimensions(uri).await;
        }
        if crate::image_type::is_image_mime(&mime) {
            return resolve_image_dimensions(uri).await;
        }
        if crate::image_type::url_has_video_extension(uri) {
            resolve_video_dimensions(uri).await
        } else {
            resolve_image_dimensions(uri).await
        }
    }

    pub async fn resolve_content_size(uri: &str) -> Option<u64> {
        get_content_io_provider()
            .get_content_size(uri)
            .await
            .map_err(|e| {
                eprintln!("[media-dimensions] get_content_size failed: {}", e);
                e
            })
            .ok()
    }
}
