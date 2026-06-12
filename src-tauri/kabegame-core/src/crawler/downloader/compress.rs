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
        input_path: &Path,
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

/// 将视频转换为用于列表/预览的小 mp4。
/// 仅在 Android（走 Kotlin provider）或启用 video feature（standard 模式）时可用。
/// light 模式不链接 rsmpeg，此函数不存在，调用方须用 #[cfg(feature = "video")] 门控。
#[cfg(any(target_os = "android", feature = "video"))]
pub async fn compress_video_for_preview(input_path: &Path) -> Result<VideoCompressResult, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;

    let preview_id = uuid::Uuid::new_v4();
    #[cfg(target_os = "android")]
    let out_path = thumbnails_dir.join(format!("{preview_id}.gif"));
    #[cfg(not(target_os = "android"))]
    let out_path = thumbnails_dir.join(format!("{preview_id}.mp4"));

    #[cfg(target_os = "android")]
    {
        if let Some(provider) = get_android_video_compress_provider() {
            return provider
                .compress_video_for_preview(input_path, &out_path)
                .await;
        }

        // 安卓兜底：若压缩插件未注册，则先拷贝原视频，避免下载链路中断。
        tokio::fs::copy(input_path, &out_path)
            .await
            .map_err(|e| format!("Android fallback copy failed: {e}"))?;
        return Ok(VideoCompressResult {
            preview_path: out_path,
            width: None,
            height: None,
        });
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

/// 进程内 FFmpeg（rsmpeg/libav*）转码：解码首个视频流 → scale 缩放 → libx264 编码（无音轨，截取前 2.5s）→ 输出 mp4。
/// 返回输出视频的宽高（缩放后）。替代旧的 ffmpeg sidecar 进程调用。
#[cfg(all(not(target_os = "android"), feature = "video"))]
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
#[cfg(all(not(target_os = "android"), feature = "video"))]
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
#[cfg(all(not(target_os = "android"), feature = "video"))]
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

/// 从字节生成图片预览图；小于等于 1MiB 时返回 None，让调用方使用原图路径。
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

/// 图片缩略图策略：小文件直接用原图，大文件生成最长边 ≤ IMAGE_THUMBNAIL_MAX_DIM 的 JPEG 预览图。
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
