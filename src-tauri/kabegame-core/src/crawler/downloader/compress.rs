use std::io::Cursor;
use std::path::{Path, PathBuf};

#[cfg(target_os = "android")]
use async_trait::async_trait;
#[cfg(target_os = "android")]
use std::sync::{Arc, OnceLock};

#[cfg(target_os = "android")]
use image::codecs::gif::{GifEncoder, Repeat};
#[cfg(target_os = "android")]
use image::{Delay, Frame as ImageFrame};
#[cfg(target_os = "android")]
use std::fs::File;
#[cfg(target_os = "android")]
use std::io::BufWriter;

/// 视频预览压缩结果。
pub struct VideoCompressResult {
    pub preview_path: PathBuf,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[cfg(target_os = "android")]
#[async_trait]
pub trait AndroidVideoCompressProvider: Send + Sync + 'static {
    async fn compress_video_for_preview(
        &self,
        input_uri: &str,
        output_path: &Path,
    ) -> Result<VideoCompressResult, String>;
}

#[cfg(target_os = "android")]
static ANDROID_VIDEO_COMPRESS_PROVIDER: OnceLock<Arc<dyn AndroidVideoCompressProvider>> =
    OnceLock::new();

#[cfg(target_os = "android")]
pub fn set_android_video_compress_provider(
    provider: Arc<dyn AndroidVideoCompressProvider>,
) -> Result<(), String> {
    ANDROID_VIDEO_COMPRESS_PROVIDER
        .set(provider)
        .map_err(|_| "Android video compress provider already initialized".to_string())
}

#[cfg(target_os = "android")]
fn get_android_video_compress_provider() -> Option<Arc<dyn AndroidVideoCompressProvider>> {
    ANDROID_VIDEO_COMPRESS_PROVIDER.get().cloned()
}

/// Android：从 content URI 生成视频预览（GIF），走 Kotlin provider。
#[cfg(target_os = "android")]
pub async fn compress_video_for_preview(input_uri: &str) -> Result<VideoCompressResult, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;

    let preview_id = uuid::Uuid::new_v4();
    let out_path = thumbnails_dir.join(format!("{preview_id}.gif"));

    if let Some(provider) = get_android_video_compress_provider() {
        return provider
            .compress_video_for_preview(input_uri, &out_path)
            .await;
    }

    // 兜底：通过 content IO 读取字节写入输出文件
    let bytes = crate::crawler::content_io::get_content_io_provider()
        .read_file_bytes(input_uri)
        .await
        .map_err(|e| format!("Android fallback read failed: {e}"))?;
    tokio::fs::write(&out_path, &bytes)
        .await
        .map_err(|e| format!("Android fallback write failed: {e}"))?;
    Ok(VideoCompressResult {
        preview_path: out_path,
        width: None,
        height: None,
    })
}

/// 桌面：从文件路径生成视频预览（mp4），走 rsmpeg/FFmpeg。
#[cfg(not(target_os = "android"))]
pub async fn compress_video_for_preview(input_path: &Path) -> Result<VideoCompressResult, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;

    let preview_id = uuid::Uuid::new_v4();
    let out_path = thumbnails_dir.join(format!("{preview_id}.mp4"));

    let temp_dir = crate::app_paths::AppPaths::global().temp_dir.clone();
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;
    let temp_out_path = temp_dir.join(format!("{preview_id}.mp4"));

    let in_path = input_path.to_path_buf();
    let temp_out_path_for_task = temp_out_path.clone();
    let ffmpeg_result = tokio::task::spawn_blocking(move || {
        run_ffmpeg_transcode(&in_path, &temp_out_path_for_task)
    })
    .await
    .map_err(|e| format!("Video compress task join error: {e}"))
    .and_then(|r| r);

    let (width, height) = match ffmpeg_result {
        Ok(dims) => dims,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_out_path).await;
            return Err(e);
        }
    };

    if let Err(e) = tokio::fs::copy(&temp_out_path, &out_path).await {
        let _ = tokio::fs::remove_file(&temp_out_path).await;
        let _ = tokio::fs::remove_file(&out_path).await;
        return Err(format!(
            "Failed to copy video preview to thumbnails directory: {e}"
        ));
    }
    let _ = tokio::fs::remove_file(&temp_out_path).await;

    Ok(VideoCompressResult {
        preview_path: out_path,
        width: Some(width),
        height: Some(height),
    })
}

/// 进程内 FFmpeg（rsmpeg/libav*）转码：解码首个视频流 → scale 缩放 → libx264 编码（无音轨，截取前 2.5s）→ 输出 mp4。
/// 返回输出视频的宽高（缩放后）。替代旧的 ffmpeg sidecar 进程调用。
#[cfg(not(target_os = "android"))]
fn run_ffmpeg_transcode(input_path: &Path, output_path: &Path) -> Result<(u32, u32), String> {
    use rsmpeg::avcodec::{AVCodec, AVCodecContext};
    use rsmpeg::avfilter::{AVFilter, AVFilterGraph, AVFilterInOut};
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::avutil::{av_inv_q, ra, AVDictionary};
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;
    use std::ffi::CString;

    // 预览只取前 2.5s（与旧 ffmpeg `-t 2.5` 一致）。
    const PREVIEW_SECONDS: f64 = 2.5;

    let to_cstring = |p: &Path| -> Result<CString, String> {
        CString::new(p.to_string_lossy().as_ref())
            .map_err(|e| format!("path contains NUL byte: {e}"))
    };
    let input_c = to_cstring(input_path)?;
    let output_c = to_cstring(output_path)?;

    // ---- 输入 + 解码器 ----
    let mut ifmt =
        AVFormatContextInput::open(&input_c).map_err(|e| format!("open input failed: {e:?}"))?;
    let (video_idx, decoder) = ifmt
        .find_best_stream(ffi::AVMEDIA_TYPE_VIDEO)
        .map_err(|e| format!("find_best_stream failed: {e:?}"))?
        .ok_or_else(|| "no video stream in input".to_string())?;
    let in_tb = ifmt.streams()[video_idx].time_base;
    let framerate = ifmt.streams()[video_idx]
        .guess_framerate()
        .unwrap_or_else(|| ra(25, 1));

    let mut dec_ctx = AVCodecContext::new(&decoder);
    dec_ctx
        .apply_codecpar(&ifmt.streams()[video_idx].codecpar())
        .map_err(|e| format!("apply_codecpar failed: {e:?}"))?;
    dec_ctx.set_pkt_timebase(in_tb);
    dec_ctx
        .open(None)
        .map_err(|e| format!("open decoder failed: {e:?}"))?;

    // ---- 滤镜图：buffer → scale='min(1280,iw)':-2 → buffersink(yuv420p) ----
    let filter_graph = AVFilterGraph::new();
    let buffersrc = AVFilter::get_by_name(c"buffer").ok_or("buffer filter missing")?;
    let buffersink = AVFilter::get_by_name(c"buffersink").ok_or("buffersink filter missing")?;
    let args = format!(
        "video_size={}x{}:pix_fmt={}:time_base={}/{}:pixel_aspect={}/{}",
        dec_ctx.width,
        dec_ctx.height,
        dec_ctx.pix_fmt,
        in_tb.num,
        in_tb.den,
        dec_ctx.sample_aspect_ratio.num,
        dec_ctx.sample_aspect_ratio.den,
    );
    let args_c = CString::new(args).map_err(|e| format!("filter args NUL: {e}"))?;
    {
        let mut src = filter_graph
            .create_filter_context(&buffersrc, c"in", Some(&args_c))
            .map_err(|e| format!("create buffersrc failed: {e:?}"))?;
        let mut sink = filter_graph
            .alloc_filter_context(&buffersink, c"out")
            .ok_or("alloc buffersink failed")?;
        // libx264 需要 yuv420p 输入
        sink.opt_set(c"pixel_formats", c"yuv420p")
            .map_err(|e| format!("set sink pix_fmt failed: {e:?}"))?;
        sink.init_str(None)
            .map_err(|e| format!("init buffersink failed: {e:?}"))?;

        let outputs = AVFilterInOut::new(c"in", &mut src, 0);
        let inputs = AVFilterInOut::new(c"out", &mut sink, 0);
        filter_graph
            .parse_ptr(c"scale='min(1280,iw)':-2", Some(inputs), Some(outputs))
            .map_err(|e| format!("parse filter graph failed: {e:?}"))?;
        filter_graph
            .config()
            .map_err(|e| format!("config filter graph failed: {e:?}"))?;
    }
    let mut buffersrc_ctx = filter_graph.get_filter(c"in").ok_or("buffersrc missing")?;
    let mut buffersink_ctx = filter_graph
        .get_filter(c"out")
        .ok_or("buffersink missing")?;
    let out_w = buffersink_ctx.get_w();
    let out_h = buffersink_ctx.get_h();
    let sink_tb = buffersink_ctx.get_time_base();

    // ---- 编码器 libx264 ----
    let encoder = AVCodec::find_encoder_by_name(c"libx264").ok_or("libx264 encoder not found")?;
    let mut enc_ctx = AVCodecContext::new(&encoder);
    enc_ctx.set_width(out_w);
    enc_ctx.set_height(out_h);
    enc_ctx.set_pix_fmt(ffi::AV_PIX_FMT_YUV420P);
    enc_ctx.set_time_base(av_inv_q(framerate));
    enc_ctx.set_framerate(framerate);

    // ---- 输出（mp4 muxer，按扩展名推断）----
    let mut ofmt = AVFormatContextOutput::create(&output_c)
        .map_err(|e| format!("create output failed: {e:?}"))?;
    if ofmt.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
        enc_ctx.set_flags(enc_ctx.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
    }
    let enc_opts = AVDictionary::new(c"preset", c"veryfast", 0).set(c"crf", c"30", 0);
    enc_ctx
        .open(Some(enc_opts))
        .map_err(|e| format!("open encoder failed: {e:?}"))?;

    let stream_index;
    {
        let mut out_stream = ofmt.new_stream();
        out_stream.set_codecpar(enc_ctx.extract_codecpar());
        out_stream.set_time_base(enc_ctx.time_base);
        stream_index = out_stream.index as usize;
    }
    ofmt.write_header(&mut None)
        .map_err(|e| format!("write_header failed: {e:?}"))?;

    let in_tb_secs = in_tb.num as f64 / in_tb.den as f64;

    // ---- 主循环：读包 → 解码 → （2.5s 截断）→ 滤镜 → 编码 → 写出 ----
    'outer: loop {
        let packet = match ifmt.read_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(e) => return Err(format!("read_packet failed: {e:?}")),
        };
        if packet.stream_index as usize != video_idx {
            continue;
        }
        dec_ctx
            .send_packet(Some(&packet))
            .map_err(|e| format!("send_packet failed: {e:?}"))?;
        loop {
            let mut frame = match dec_ctx.receive_frame() {
                Ok(f) => f,
                Err(RsmpegError::DecoderDrainError) | Err(RsmpegError::DecoderFlushedError) => {
                    break
                }
                Err(e) => return Err(format!("receive_frame failed: {e:?}")),
            };
            let ts = frame.best_effort_timestamp;
            if ts != ffi::AV_NOPTS_VALUE && (ts as f64) * in_tb_secs >= PREVIEW_SECONDS {
                break 'outer;
            }
            frame.set_pts(ts);
            filter_encode_write(
                &mut buffersrc_ctx,
                &mut buffersink_ctx,
                &mut enc_ctx,
                &mut ofmt,
                stream_index,
                sink_tb,
                Some(frame),
            )?;
        }
    }

    // 冲洗滤镜与编码器
    filter_encode_write(
        &mut buffersrc_ctx,
        &mut buffersink_ctx,
        &mut enc_ctx,
        &mut ofmt,
        stream_index,
        sink_tb,
        None,
    )?;
    encode_write(&mut enc_ctx, &mut ofmt, stream_index, None)?;
    ofmt.write_trailer()
        .map_err(|e| format!("write_trailer failed: {e:?}"))?;

    Ok((out_w as u32, out_h as u32))
}

/// 编码一帧并交错写入输出（frame=None 表示冲洗编码器）。
#[cfg(not(target_os = "android"))]
fn encode_write(
    enc_ctx: &mut rsmpeg::avcodec::AVCodecContext,
    ofmt_ctx: &mut rsmpeg::avformat::AVFormatContextOutput,
    stream_index: usize,
    mut frame: Option<rsmpeg::avutil::AVFrame>,
) -> Result<(), String> {
    use rsmpeg::avutil::av_rescale_q;
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;

    if let Some(f) = frame.as_mut() {
        if f.pts != ffi::AV_NOPTS_VALUE {
            f.set_pts(av_rescale_q(f.pts, f.time_base, enc_ctx.time_base));
        }
    }
    enc_ctx
        .send_frame(frame.as_ref())
        .map_err(|e| format!("send_frame failed: {e:?}"))?;
    loop {
        let mut pkt = match enc_ctx.receive_packet() {
            Ok(p) => p,
            Err(RsmpegError::EncoderDrainError) | Err(RsmpegError::EncoderFlushedError) => break,
            Err(e) => return Err(format!("receive_packet failed: {e:?}")),
        };
        pkt.set_stream_index(stream_index as i32);
        pkt.rescale_ts(
            enc_ctx.time_base,
            ofmt_ctx.streams()[stream_index].time_base,
        );
        ofmt_ctx
            .interleaved_write_frame(&mut pkt)
            .map_err(|e| format!("interleaved_write_frame failed: {e:?}"))?;
    }
    Ok(())
}

/// 将一帧送入滤镜图，取出滤镜输出帧并编码写出（frame=None 表示冲洗滤镜）。
#[cfg(not(target_os = "android"))]
#[allow(clippy::too_many_arguments)]
fn filter_encode_write(
    buffersrc_ctx: &mut rsmpeg::avfilter::AVFilterContextMut,
    buffersink_ctx: &mut rsmpeg::avfilter::AVFilterContextMut,
    enc_ctx: &mut rsmpeg::avcodec::AVCodecContext,
    ofmt_ctx: &mut rsmpeg::avformat::AVFormatContextOutput,
    stream_index: usize,
    sink_tb: rsmpeg::ffi::AVRational,
    frame: Option<rsmpeg::avutil::AVFrame>,
) -> Result<(), String> {
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;

    buffersrc_ctx
        .buffersrc_add_frame(frame, None)
        .map_err(|e| format!("buffersrc_add_frame failed: {e:?}"))?;
    loop {
        let mut filtered = match buffersink_ctx.buffersink_get_frame(None) {
            Ok(f) => f,
            Err(RsmpegError::BufferSinkDrainError) | Err(RsmpegError::BufferSinkEofError) => break,
            Err(e) => return Err(format!("buffersink_get_frame failed: {e:?}")),
        };
        filtered.set_time_base(sink_tb);
        filtered.set_pict_type(ffi::AV_PICTURE_TYPE_NONE);
        encode_write(enc_ctx, ofmt_ctx, stream_index, Some(filtered))?;
    }
    Ok(())
}

/// 将目录下 frame_000.png, frame_001.png, ... 编码为动图 GIF（4fps），仅 Android 使用。
#[cfg(target_os = "android")]
pub fn encode_frames_dir_to_gif(frame_dir: &Path, output_path: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(frame_dir)
        .map_err(|e| format!("读取帧目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|x| x.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
                && e.file_name().to_string_lossy().starts_with("frame_")
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    if entries.is_empty() {
        return Err("帧目录下没有 frame_*.png".to_string());
    }
    // 与 ffmpeg 一致：预览最多 2.5s，4fps => 最多 10 帧
    const MAX_FRAMES_2_5S: usize = 10;
    if entries.len() > MAX_FRAMES_2_5S {
        entries.truncate(MAX_FRAMES_2_5S);
    }

    // 4fps = 250ms 每帧
    let delay = Delay::from_numer_denom_ms(250, 1);

    let out_file = File::create(output_path).map_err(|e| format!("创建 GIF 文件失败: {e}"))?;
    let mut encoder = GifEncoder::new_with_speed(BufWriter::new(out_file), 10);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| format!("set_repeat 失败: {e}"))?;

    for entry in entries {
        let path = entry.path();
        let img = image::open(&path).map_err(|e| format!("加载帧 {} 失败: {e}", path.display()))?;
        let rgba = img.to_rgba8();
        let frame = ImageFrame::from_parts(rgba, 0, 0, delay);
        encoder
            .encode_frame(frame)
            .map_err(|e| format!("编码帧 {} 失败: {e}", path.display()))?;
    }

    Ok(())
}

/// 兼容图片最长边像素上限。超过此上限的图片（或浏览器不支持的格式）会生成 PNG 兼容副本。
pub const IMAGE_COMPATIBLE_MAX_DIM: u32 = 4096;
/// 兼容视频高度上限（1080p）。
pub const VIDEO_COMPATIBLE_MAX_HEIGHT: u32 = 1080;

/// 仅当原图文件大于此阈值才生成独立预览缩略图；否则前端直接用原图。
pub const IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES: u64 = 512 * 1024;
/// 预览缩略图最长边像素上限。缩略图仅用于 UI（画廊网格 + 预览渐进占位），
/// 全屏查看与设壁纸都用原图，所以无需接近原图分辨率。
pub const IMAGE_THUMBNAIL_MAX_DIM: u32 = 512;
/// 预览缩略图固定 JPEG 质量（80~85 区间视觉接近无损，压缩与速度均衡）。
const IMAGE_THUMBNAIL_JPEG_QUALITY: u8 = 82;
pub fn image_needs_independent_thumbnail(source_size: u64) -> bool {
    source_size > IMAGE_THUMBNAIL_SOURCE_THRESHOLD_BYTES
}

/// 缩略图尺寸是否「可接受」：最长边不超过上限。
/// 生成时据此决定是否缩放；organize 维护时据此判断既有缩略图是否需要重生成。
pub fn image_thumbnail_dimensions_acceptable(width: u32, height: u32) -> bool {
    width.max(height) <= IMAGE_THUMBNAIL_MAX_DIM
}

fn encode_jpeg_rgb(rgb: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ColorType::Rgb8,
        )
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;
    Ok(cursor.into_inner())
}

/// 生成预览缩略图字节：按最长边 ≤ `IMAGE_THUMBNAIL_MAX_DIM` 缩放一次，再以固定质量编码一次。
/// 不再按字节大小做「缩放×质量」二分搜索——单次重采样 + 单次编码，避免在超大原图上反复重采样。
fn build_compressed_thumbnail_bytes(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    use image::GenericImageView;

    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return Err("Image has invalid dimensions".to_string());
    }

    let rgb = if width.max(height) > IMAGE_THUMBNAIL_MAX_DIM {
        let scale = IMAGE_THUMBNAIL_MAX_DIM as f64 / width.max(height) as f64;
        let target_w = ((width as f64) * scale).round().clamp(1.0, width as f64) as u32;
        let target_h = ((height as f64) * scale).round().clamp(1.0, height as f64) as u32;
        img.resize(target_w, target_h, image::imageops::FilterType::Lanczos3)
            .to_rgb8()
    } else {
        img.to_rgb8()
    };

    encode_jpeg_rgb(&rgb, IMAGE_THUMBNAIL_JPEG_QUALITY)
}

async fn write_thumbnail_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {}", e))?;
    let thumbnail_path = thumbnails_dir.join(format!("{}.jpg", uuid::Uuid::new_v4()));
    tokio::fs::write(&thumbnail_path, bytes)
        .await
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    Ok(thumbnail_path)
}

/// 从字节生成图片预览图；小于等于阈值时返回 None，让调用方使用原图路径。
pub async fn generate_thumbnail_from_bytes(bytes: &[u8]) -> Result<Option<PathBuf>, String> {
    if !image_needs_independent_thumbnail(bytes.len() as u64) {
        return Ok(None);
    }
    let img = match image::load_from_memory(bytes) {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };
    let thumbnail_bytes = build_compressed_thumbnail_bytes(&img)?;
    write_thumbnail_bytes(thumbnail_bytes).await.map(Some)
}

/// 图片缩略图策略：小文件直接用原图，大文件用 image crate 生成最长边 ≤ IMAGE_THUMBNAIL_MAX_DIM 的 JPEG 预览图。
pub async fn generate_thumbnail(image_path: &Path) -> Result<Option<PathBuf>, String> {
    if !crate::image_type::is_image_by_path(image_path) {
        return Ok(None);
    }
    let source_size = match tokio::fs::metadata(image_path).await {
        Ok(metadata) => metadata.len(),
        Err(_) => return Ok(None),
    };
    if !image_needs_independent_thumbnail(source_size) {
        return Ok(None);
    }

    let img = match image::open(image_path) {
        Ok(img) => img,
        Err(_) => return Ok(None),
    };
    let thumbnail_bytes = build_compressed_thumbnail_bytes(&img)?;
    write_thumbnail_bytes(thumbnail_bytes).await.map(Some)
}

/// 桌面：生成图片兼容副本（PNG）。
/// 当图片格式浏览器不支持（heic/avif）或最长边 > `IMAGE_COMPATIBLE_MAX_DIM` 时生成；
/// 否则返回 `Ok(None)`，不浪费 IO。
/// 输出文件放在 `compatibles_dir`，命名为 UUID.png。
#[cfg(not(target_os = "android"))]
pub async fn generate_compatible_image(
    image_path: &Path,
    mime_type: &str,
    width: u32,
    height: u32,
) -> Result<Option<PathBuf>, String> {
    use crate::image_type::image_mime_browser_safe;
    let max_dim = width.max(height);
    if image_mime_browser_safe(mime_type) && max_dim <= IMAGE_COMPATIBLE_MAX_DIM {
        return Ok(None);
    }
    let compatibles_dir = crate::app_paths::AppPaths::global().compatibles_dir();
    tokio::fs::create_dir_all(&compatibles_dir)
        .await
        .map_err(|e| format!("Failed to create compatibles directory: {e}"))?;
    let out_path = compatibles_dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    let in_path = image_path.to_path_buf();
    let out_for_task = out_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        transcode_compatible_image_sync(&in_path, &out_for_task)
    })
    .await
    .map_err(|e| format!("Compatible image task join error: {e}"))
    .and_then(|r| r);
    match result {
        Ok(()) => Ok(Some(out_path)),
        Err(e) => {
            let _ = tokio::fs::remove_file(&out_path).await;
            Err(e)
        }
    }
}

/// 桌面：生成视频兼容副本（H.264 mp4，含音频）。
/// 当 `probe.browser_safe == false` 时转码；否则返回 `Ok(None)`。
/// 输出文件放在 `compatibles_dir`，命名为 UUID.mp4。
#[cfg(not(target_os = "android"))]
pub async fn generate_compatible_video(
    video_path: &Path,
    probe: &crate::media_dimensions::MediaProbeResult,
) -> Result<Option<PathBuf>, String> {
    if probe.browser_safe {
        return Ok(None);
    }
    let compatibles_dir = crate::app_paths::AppPaths::global().compatibles_dir();
    tokio::fs::create_dir_all(&compatibles_dir)
        .await
        .map_err(|e| format!("Failed to create compatibles directory: {e}"))?;
    let out_path = compatibles_dir.join(format!("{}.mp4", uuid::Uuid::new_v4()));
    let in_path = video_path.to_path_buf();
    let out_for_task = out_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        transcode_compatible_video_sync(&in_path, &out_for_task)
    })
    .await
    .map_err(|e| format!("Compatible video task join error: {e}"))
    .and_then(|r| r);
    match result {
        Ok(()) => Ok(Some(out_path)),
        Err(e) => {
            let _ = tokio::fs::remove_file(&out_path).await;
            Err(e)
        }
    }
}

/// 图片兼容副本生成（同步）：用 image crate 打开 → 超限缩放 → PNG。
#[cfg(not(target_os = "android"))]
fn transcode_compatible_image_sync(
    input_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    use image::GenericImageView;
    let img = image::open(input_path)
        .map_err(|e| format!("Failed to open image for compatible: {e}"))?;
    let (w, h) = img.dimensions();
    let max = w.max(h);
    let img = if max > IMAGE_COMPATIBLE_MAX_DIM {
        let scale = IMAGE_COMPATIBLE_MAX_DIM as f64 / max as f64;
        let tw = ((w as f64 * scale).round() as u32).max(1);
        let th = ((h as f64 * scale).round() as u32).max(1);
        img.resize(tw, th, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    img.save_with_format(output_path, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to save compatible PNG: {e}"))
}

/// 视频兼容副本转码（同步）：解码 → scale(-2:min(1080,ih)) + yuv420p → libx264 CRF 23；
/// 含音频轨时同步解码 → aresample=44100 → AAC 128k 编入同一 mp4。
#[cfg(not(target_os = "android"))]
fn transcode_compatible_video_sync(input_path: &Path, output_path: &Path) -> Result<(), String> {
    use rsmpeg::avcodec::{AVCodec, AVCodecContext};
    use rsmpeg::avfilter::{AVFilter, AVFilterGraph, AVFilterInOut};
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::avutil::{av_inv_q, ra, AVDictionary};
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;
    use std::ffi::{CStr, CString};

    const MAX_H: i32 = VIDEO_COMPATIBLE_MAX_HEIGHT as i32;

    let to_cs = |p: &Path| -> Result<CString, String> {
        CString::new(p.to_string_lossy().as_ref()).map_err(|e| format!("path NUL: {e}"))
    };
    let input_c = to_cs(input_path)?;
    let output_c = to_cs(output_path)?;

    // ── Input ──
    let mut ifmt =
        AVFormatContextInput::open(&input_c).map_err(|e| format!("open input: {e:?}"))?;

    // ── Video stream ──
    let (v_idx, v_dec) = ifmt
        .find_best_stream(ffi::AVMEDIA_TYPE_VIDEO)
        .map_err(|e| format!("find video: {e:?}"))?
        .ok_or("no video stream")?;
    let in_v_tb = ifmt.streams()[v_idx].time_base;
    let framerate = ifmt.streams()[v_idx]
        .guess_framerate()
        .unwrap_or_else(|| ra(25, 1));

    let mut v_dec_ctx = AVCodecContext::new(&v_dec);
    v_dec_ctx
        .apply_codecpar(&ifmt.streams()[v_idx].codecpar())
        .map_err(|e| format!("video apply_codecpar: {e:?}"))?;
    v_dec_ctx.set_pkt_timebase(in_v_tb);
    v_dec_ctx
        .open(None)
        .map_err(|e| format!("open video decoder: {e:?}"))?;

    // ── Audio stream (optional) ──
    let audio_stream = ifmt
        .find_best_stream(ffi::AVMEDIA_TYPE_AUDIO)
        .ok()
        .flatten();
    let mut a_idx: Option<usize> = None;
    let mut a_dec_ctx: Option<AVCodecContext> = None;
    if let Some((idx, a_dec)) = audio_stream {
        let mut ctx = AVCodecContext::new(&a_dec);
        if ctx.apply_codecpar(&ifmt.streams()[idx].codecpar()).is_ok() {
            ctx.set_pkt_timebase(ifmt.streams()[idx].time_base);
            if ctx.open(None).is_ok() {
                a_idx = Some(idx);
                a_dec_ctx = Some(ctx);
            }
        }
    }
    let has_audio = a_dec_ctx.is_some();

    // ── Video filter: buffer → scale=-2:'min(MAX_H,ih)' → format=yuv420p → buffersink ──
    let vfg = AVFilterGraph::new();
    let vbuf = AVFilter::get_by_name(c"buffer").ok_or("buffer filter missing")?;
    let vbuf_sink = AVFilter::get_by_name(c"buffersink").ok_or("buffersink filter missing")?;
    let v_args = CString::new(format!(
        "video_size={}x{}:pix_fmt={}:time_base={}/{}:pixel_aspect={}/{}",
        v_dec_ctx.width,
        v_dec_ctx.height,
        v_dec_ctx.pix_fmt,
        in_v_tb.num,
        in_v_tb.den,
        v_dec_ctx.sample_aspect_ratio.num.max(1),
        v_dec_ctx.sample_aspect_ratio.den.max(1),
    ))
    .map_err(|e| format!("v_args NUL: {e}"))?;
    {
        let mut v_src = vfg
            .create_filter_context(&vbuf, c"v_in", Some(&v_args))
            .map_err(|e| format!("create v_src: {e:?}"))?;
        let mut v_sink_ctx = vfg
            .alloc_filter_context(&vbuf_sink, c"v_out")
            .ok_or("alloc v_sink")?;
        v_sink_ctx
            .opt_set(c"pixel_formats", c"yuv420p")
            .map_err(|e| format!("set v_sink pix_fmt: {e:?}"))?;
        v_sink_ctx
            .init_str(None)
            .map_err(|e| format!("init v_sink: {e:?}"))?;
        let outs = AVFilterInOut::new(c"in", &mut v_src, 0);
        let ins = AVFilterInOut::new(c"out", &mut v_sink_ctx, 0);
        let spec = CString::new(format!("scale=-2:'2*trunc(min({MAX_H},ih)/2)'"))
            .map_err(|e| format!("v filter spec NUL: {e}"))?;
        vfg.parse_ptr(&spec, Some(ins), Some(outs))
            .map_err(|e| format!("parse v filter: {e:?}"))?;
        vfg.config()
            .map_err(|e| format!("config v filter: {e:?}"))?;
    }
    let mut v_src_ctx = vfg.get_filter(c"v_in").ok_or("v_in missing")?;
    let mut v_sink_ctx = vfg.get_filter(c"v_out").ok_or("v_out missing")?;
    let out_w = v_sink_ctx.get_w();
    let out_h = v_sink_ctx.get_h();
    let v_sink_tb = v_sink_ctx.get_time_base();

    // ── Audio filter (if available): abuffer → aresample=44100 → aformat → abuffersink ──
    // Stored in Option to handle missing audio gracefully.
    let afg = AVFilterGraph::new();
    let mut a_src_ctx_opt: Option<rsmpeg::avfilter::AVFilterContextMut> = None;
    let mut a_sink_ctx_opt: Option<rsmpeg::avfilter::AVFilterContextMut> = None;
    if let Some(ref ac) = a_dec_ctx {
        let abuf = AVFilter::get_by_name(c"abuffer").ok_or("abuffer filter missing")?;
        let abuf_sink =
            AVFilter::get_by_name(c"abuffersink").ok_or("abuffersink filter missing")?;
        let sfmt_name = unsafe {
            let ptr = ffi::av_get_sample_fmt_name(ac.sample_fmt);
            if ptr.is_null() {
                "fltp"
            } else {
                CStr::from_ptr(ptr).to_str().unwrap_or("fltp")
            }
        };
        let nb_ch = ac.ch_layout().nb_channels;
        let ch_layout_name = if nb_ch >= 2 { "stereo" } else { "mono" };
        let a_args = CString::new(format!(
            "time_base=1/{}:sample_rate={}:sample_fmt={}:channel_layout={}",
            ac.sample_rate, ac.sample_rate, sfmt_name, ch_layout_name,
        ))
        .map_err(|e| format!("a_args NUL: {e}"))?;

        let setup = (|| -> Result<(), String> {
            let mut a_src = afg
                .create_filter_context(&abuf, c"a_in", Some(&a_args))
                .map_err(|e| format!("create a_src: {e:?}"))?;
            let mut a_sink = afg
                .alloc_filter_context(&abuf_sink, c"a_out")
                .ok_or("alloc a_sink")?;
            a_sink
                .init_str(None)
                .map_err(|e| format!("init a_sink: {e:?}"))?;
            let outs = AVFilterInOut::new(c"in", &mut a_src, 0);
            let ins = AVFilterInOut::new(c"out", &mut a_sink, 0);
            afg.parse_ptr(
                c"aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,asetnsamples=n=1024:p=0",
                Some(ins),
                Some(outs),
            )
            .map_err(|e| format!("parse a filter: {e:?}"))?;
            afg.config()
                .map_err(|e| format!("config a filter: {e:?}"))?;
            Ok(())
        })();
        if setup.is_ok() {
            a_src_ctx_opt = afg.get_filter(c"a_in");
            a_sink_ctx_opt = afg.get_filter(c"a_out");
        } else {
            eprintln!("[compat-video] audio filter setup failed, proceeding video-only");
        }
    }
    let has_audio_filter = a_src_ctx_opt.is_some() && a_sink_ctx_opt.is_some();

    // ── Video encoder: libx264 ──
    let v_enc = AVCodec::find_encoder_by_name(c"libx264").ok_or("libx264 not found")?;
    let mut v_enc_ctx = AVCodecContext::new(&v_enc);
    v_enc_ctx.set_width(out_w);
    v_enc_ctx.set_height(out_h);
    v_enc_ctx.set_pix_fmt(ffi::AV_PIX_FMT_YUV420P);
    v_enc_ctx.set_time_base(av_inv_q(framerate));
    v_enc_ctx.set_framerate(framerate);

    // ── Output container ──
    let mut ofmt =
        AVFormatContextOutput::create(&output_c).map_err(|e| format!("create output: {e:?}"))?;
    if ofmt.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
        v_enc_ctx.set_flags(v_enc_ctx.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
    }
    let v_enc_opts = AVDictionary::new(c"preset", c"veryfast", 0).set(c"crf", c"23", 0);
    v_enc_ctx
        .open(Some(v_enc_opts))
        .map_err(|e| format!("open video encoder: {e:?}"))?;

    let v_out_idx;
    {
        let mut vs = ofmt.new_stream();
        vs.set_codecpar(v_enc_ctx.extract_codecpar());
        vs.set_time_base(v_enc_ctx.time_base);
        v_out_idx = vs.index as usize;
    }

    // ── Audio encoder: AAC (only if audio filter pipeline succeeded) ──
    let mut a_enc_ctx_opt: Option<AVCodecContext> = None;
    let mut a_out_idx: usize = 0;
    if has_audio_filter {
        if let Some(aac) = AVCodec::find_encoder(ffi::AV_CODEC_ID_AAC) {
            let mut ctx = AVCodecContext::new(&aac);
            ctx.set_sample_rate(44100);
            ctx.set_sample_fmt(ffi::AV_SAMPLE_FMT_FLTP);
            ctx.set_bit_rate(128_000);
            let mut ch_layout = unsafe { std::mem::zeroed::<ffi::AVChannelLayout>() };
            unsafe { ffi::av_channel_layout_default(&mut ch_layout, 2) };
            ctx.set_ch_layout(ch_layout);
            if ofmt.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
                ctx.set_flags(ctx.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
            }
            if ctx.open(None).is_ok() {
                let mut a_stream = ofmt.new_stream();
                a_stream.set_codecpar(ctx.extract_codecpar());
                a_stream.set_time_base(ctx.time_base);
                a_out_idx = a_stream.index as usize;
                a_enc_ctx_opt = Some(ctx);
            }
        }
    }

    ofmt.write_header(&mut None)
        .map_err(|e| format!("write_header: {e:?}"))?;

    let in_v_tb_secs = in_v_tb.num as f64 / in_v_tb.den as f64;

    // ── Main loop ──
    loop {
        let pkt = match ifmt.read_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(e) => return Err(format!("read_packet: {e:?}")),
        };
        let pkt_idx = pkt.stream_index as usize;

        if pkt_idx == v_idx {
            // Video: decode → filter → encode → write
            v_dec_ctx
                .send_packet(Some(&pkt))
                .map_err(|e| format!("send video pkt: {e:?}"))?;
            loop {
                let mut frame = match v_dec_ctx.receive_frame() {
                    Ok(f) => f,
                    Err(RsmpegError::DecoderDrainError) | Err(RsmpegError::DecoderFlushedError) => {
                        break
                    }
                    Err(e) => return Err(format!("receive video frame: {e:?}")),
                };
                let ts = frame.best_effort_timestamp;
                frame.set_pts(ts);
                filter_encode_write(
                    &mut v_src_ctx,
                    &mut v_sink_ctx,
                    &mut v_enc_ctx,
                    &mut ofmt,
                    v_out_idx,
                    v_sink_tb,
                    Some(frame),
                )?;
            }
        } else if let (Some(ai), Some(ref mut a_enc), Some(ref mut a_src), Some(ref mut a_sink)) = (
            a_idx,
            a_enc_ctx_opt.as_mut(),
            a_src_ctx_opt.as_mut(),
            a_sink_ctx_opt.as_mut(),
        ) {
            if pkt_idx == ai {
                // Audio: decode → filter → encode → write
                if let Some(ref mut adc) = a_dec_ctx {
                    adc.send_packet(Some(&pkt))
                        .map_err(|e| format!("send audio pkt: {e:?}"))?;
                    loop {
                        let frame = match adc.receive_frame() {
                            Ok(f) => f,
                            Err(RsmpegError::DecoderDrainError)
                            | Err(RsmpegError::DecoderFlushedError) => break,
                            Err(e) => return Err(format!("receive audio frame: {e:?}")),
                        };
                        a_src
                            .buffersrc_add_frame(Some(frame), None)
                            .map_err(|e| format!("a_src add_frame: {e:?}"))?;
                        loop {
                            let af = match a_sink.buffersink_get_frame(None) {
                                Ok(f) => f,
                                Err(RsmpegError::BufferSinkDrainError)
                                | Err(RsmpegError::BufferSinkEofError) => break,
                                Err(e) => return Err(format!("a_sink get_frame: {e:?}")),
                            };
                            encode_write(a_enc, &mut ofmt, a_out_idx, Some(af))?;
                        }
                    }
                }
            }
        }
    }

    // ── Flush video ──
    filter_encode_write(
        &mut v_src_ctx,
        &mut v_sink_ctx,
        &mut v_enc_ctx,
        &mut ofmt,
        v_out_idx,
        v_sink_tb,
        None,
    )?;
    encode_write(&mut v_enc_ctx, &mut ofmt, v_out_idx, None)?;

    // ── Flush audio ──
    if let (Some(ref mut a_enc), Some(ref mut a_src), Some(ref mut a_sink)) = (
        a_enc_ctx_opt.as_mut(),
        a_src_ctx_opt.as_mut(),
        a_sink_ctx_opt.as_mut(),
    ) {
        if let Some(ref mut adc) = a_dec_ctx {
            let _ = adc.send_packet(None);
            loop {
                let frame = match adc.receive_frame() {
                    Ok(f) => f,
                    Err(_) => break,
                };
                let _ = a_src.buffersrc_add_frame(Some(frame), None);
            }
        }
        let _ = a_src.buffersrc_add_frame(None, None);
        loop {
            let af = match a_sink.buffersink_get_frame(None) {
                Ok(f) => f,
                Err(_) => break,
            };
            let _ = encode_write(a_enc, &mut ofmt, a_out_idx, Some(af));
        }
        let _ = encode_write(a_enc, &mut ofmt, a_out_idx, None);
    }

    ofmt.write_trailer()
        .map_err(|e| format!("write_trailer: {e:?}"))?;
    Ok(())
}
