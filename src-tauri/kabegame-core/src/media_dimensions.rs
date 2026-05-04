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

/// Video dimensions for a desktop or `file://` path. mp4/mov are supported
/// through the `mp4` crate. Returns `None` on error.
pub fn resolve_video_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    let path = local_path_to_path_buf(local_path);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to open video {}: {}",
                path.display(),
                e
            );
            return None;
        }
    };
    let size = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to stat video {}: {}",
                path.display(),
                e
            );
            return None;
        }
    };
    let reader = match mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size) {
        Ok(reader) => reader,
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to parse video {}: {}",
                path.display(),
                e
            );
            return None;
        }
    };

    for track in reader.tracks().values() {
        if track.track_type().ok() == Some(mp4::TrackType::Video) {
            let width = track.width() as u32;
            let height = track.height() as u32;
            if width > 0 && height > 0 {
                return Some((width, height));
            }
        }
    }
    eprintln!(
        "[media-dimensions] no video track dimensions found in {}",
        path.display()
    );
    None
}

/// Dispatcher for desktop or `file://` paths.
pub fn resolve_media_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    let path = local_path_to_path_buf(local_path);
    if crate::image_type::is_video_by_path(path.as_path()) {
        resolve_video_dimensions_sync(local_path)
    } else {
        resolve_image_dimensions_sync(local_path)
    }
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
        if uri.to_ascii_lowercase().contains(".mp4") || uri.to_ascii_lowercase().contains(".mov") {
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
