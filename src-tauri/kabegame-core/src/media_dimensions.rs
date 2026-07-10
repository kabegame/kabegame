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
    match image::io::Reader::open(&path) {
        Ok(reader) => match reader.with_guessed_format() {
            Ok(r) => match r.into_dimensions() {
                Ok((w, h)) => Some((w as u32, h as u32)),
                Err(e) => {
                    eprintln!(
                        "[media-dimensions] failed to read image dimensions from {}: {}",
                        path.display(),
                        e
                    );
                    #[cfg(not(target_os = "android"))]
                    {
                        avformat_media_dimensions(&path)
                    }
                    #[cfg(target_os = "android")]
                    None
                }
            },
            Err(e) => {
                eprintln!(
                    "[media-dimensions] failed to guess image format for {}: {}",
                    path.display(),
                    e
                );
                None
            }
        },
        Err(e) => {
            eprintln!(
                "[media-dimensions] failed to open image reader for {}: {}",
                path.display(),
                e
            );
            None
        }
    }
}

/// Desktop: use libavformat to probe media dimensions from the first video stream's codecpar.
/// Useful as a fallback for image formats like AVIF that image crate can't decode,
/// since the mp4/mov demuxer can read width/height from the container without a decoder.
#[cfg(not(target_os = "android"))]
fn avformat_media_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    use rsmpeg::avformat::AVFormatContextInput;
    use std::ffi::CString;

    let path_c = CString::new(path.to_string_lossy().as_ref()).ok()?;
    let fmt = AVFormatContextInput::open(&path_c).ok()?;
    let video_idx = first_video_stream_index(&fmt)?;
    let codecpar = fmt.streams()[video_idx].codecpar();
    let (width, height) = (codecpar.width, codecpar.height);
    if width > 0 && height > 0 {
        Some((width as u32, height as u32))
    } else {
        None
    }
}

/// Video dimensions for a desktop or `file://` path. Reads the first video
/// stream's `codecpar` width/height via libavformat (rsmpeg), so it works
/// uniformly for mp4/mov/wmv/webm/mkv. Returns `None` on error.
///
/// Android does not link FFmpeg; `content://` video dimensions come from the
/// async ContentIoProvider path in the `android` submodule.
///
/// First video stream index by `codec_type`, WITHOUT requiring a decoder.
/// `find_best_stream` skips streams whose decoder isn't compiled (this build has no
/// AV1 decoder), which would hide AV1 video from probing that only reads `codecpar`.
#[cfg(not(target_os = "android"))]
fn first_video_stream_index(fmt: &rsmpeg::avformat::AVFormatContextInput) -> Option<usize> {
    use rsmpeg::ffi;
    let count = fmt.nb_streams as usize;
    let streams = fmt.streams();
    (0..count).find(|&i| streams[i].codecpar().codec_type == ffi::AVMEDIA_TYPE_VIDEO)
}

#[cfg(not(target_os = "android"))]
pub fn resolve_video_dimensions_sync(local_path: &str) -> Option<(u32, u32)> {
    let path = local_path_to_path_buf(local_path);
    match avformat_media_dimensions(&path) {
        Some(dims) => Some(dims),
        None => {
            eprintln!(
                "[media-dimensions] failed to read video dimensions from {}",
                path.display()
            );
            None
        }
    }
}

/// Android stub: FFmpeg is not linked; real `content://` video dimensions come
/// from the async ContentIoProvider path in the `android` submodule.
#[cfg(target_os = "android")]
pub fn resolve_video_dimensions_sync(_local_path: &str) -> Option<(u32, u32)> {
    None
}

/// 桌面端视频探测结果。FFmpeg/rsmpeg 仅用于视频处理路径，不用于图片类型推断。
#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone)]
pub struct MediaProbeResult {
    pub is_video: bool,
    /// 探测得到的受支持视频 MIME；不受支持时 `probe_media_sync` 返回 `None`。
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    /// 当前平台的内嵌浏览器能否直接显示/播放此内容，无需转码。
    /// 桌面 Chromium/CEF 将非 HEVC 的 MP4 与 VP8/VP9/AV1 WebM 视为可直播放。
    pub browser_safe: bool,
}

/// 桌面端：用 libavformat 打开文件并探测首个视频流，返回视频 MIME/宽高/浏览器兼容性。
/// 打开失败、无视频流、宽高非法或类型不受支持时返回 `None`。图片不走此函数。
#[cfg(not(target_os = "android"))]
pub fn probe_media_sync(path: &std::path::Path) -> Option<MediaProbeResult> {
    use rsmpeg::avformat::AVFormatContextInput;
    use std::ffi::CString;

    let path_c = CString::new(path.to_string_lossy().as_ref()).ok()?;
    let fmt = AVFormatContextInput::open(&path_c).ok()?;
    let video_idx = first_video_stream_index(&fmt)?;
    let codecpar = fmt.streams()[video_idx].codecpar();
    let (w, h) = (codecpar.width, codecpar.height);
    if w <= 0 || h <= 0 {
        return None;
    }
    let fmt_name = fmt.iformat().name().to_string_lossy().to_lowercase();
    let (mime, browser_safe) = classify_video_probe_mime(codecpar.codec_id, &fmt_name)?;
    Some(MediaProbeResult {
        is_video: true,
        browser_safe,
        mime_type: mime,
        width: w as u32,
        height: h as u32,
    })
}

/// 把 (视频编码器 id, 容器格式名) 映射到受支持的 (MIME, browser_safe)。
#[cfg(not(target_os = "android"))]
fn classify_video_probe_mime(
    codec_id: rsmpeg::ffi::AVCodecID,
    fmt_name: &str,
) -> Option<(String, bool)> {
    use rsmpeg::ffi;
    let (video_mime, safe): (&str, bool) = if fmt_name.contains("asf") || fmt_name.contains("wmv") {
        ("video/x-ms-wmv", false)
    } else if fmt_name.contains("matroska") || fmt_name.contains("webm") {
        if codec_id == ffi::AV_CODEC_ID_VP8
            || codec_id == ffi::AV_CODEC_ID_VP9
            || codec_id == ffi::AV_CODEC_ID_AV1
        {
            ("video/webm", true)
        } else {
            ("video/x-matroska", false)
        }
    } else if fmt_name.contains("mp4")
        || fmt_name.contains("mov")
        || fmt_name.contains("quicktime")
        || fmt_name.contains("m4a")
        || fmt_name.contains("3gp")
        || fmt_name.contains("mj2")
    {
        let safe = codec_id != ffi::AV_CODEC_ID_HEVC;
        ("video/mp4", safe)
    } else {
        return None;
    };
    Some((video_mime.to_string(), safe))
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
