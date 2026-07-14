use std::io::Cursor;
use std::path::{Path, PathBuf};

/// 视频预览压缩结果。
pub struct VideoCompressResult {
    pub preview_path: PathBuf,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Android：从 content:// URI 生成 10fps 动图 GIF 视频预览。
/// 安卓网格无鼠标悬浮，静帧 <video> 无意义，故用动图预览（前端以 `<img>` 展示）。
/// 先经 ContentIoProvider.open_fd 拿到 detach 的 fd，再用 `/proc/self/fd/N` 交给进程内
/// FFmpeg(rsmpeg) 的 `run_ffmpeg_gif`（fps+scale+palettegen+paletteuse），取代旧的慢速
/// Kotlin 帧提取 + image crate GIF 编码。
#[cfg(target_os = "android")]
pub async fn compress_video_for_preview(input_uri: &str) -> Result<VideoCompressResult, String> {
    use std::os::fd::{FromRawFd, OwnedFd};

    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;
    let out_path = thumbnails_dir.join(format!("{}.gif", uuid::Uuid::new_v4()));

    let fd = crate::crawler::content_io::get_content_io_provider()
        .open_fd(input_uri)
        .await
        .map_err(|e| format!("open_fd content URI failed: {e}"))?;

    let out_for_task = out_path.clone();
    // OwnedFd 在阻塞任务内持有，任务结束时关闭我们这份 fd；FFmpeg 打开 /proc/self/fd/N
    // 时会 open() 出自己的副本，故只需在转码期间保持该 fd 存活。
    let result = tokio::task::spawn_blocking(move || {
        let owned = unsafe { OwnedFd::from_raw_fd(fd) };
        let proc_path = PathBuf::from(format!("/proc/self/fd/{fd}"));
        let dims = run_ffmpeg_gif(&proc_path, &out_for_task);
        drop(owned);
        dims
    })
    .await
    .map_err(|e| format!("Android gif task join error: {e}"))
    .and_then(|r| r);

    match result {
        Ok((w, h)) => Ok(VideoCompressResult {
            preview_path: out_path,
            width: Some(w),
            height: Some(h),
        }),
        Err(e) => {
            let _ = tokio::fs::remove_file(&out_path).await;
            Err(e)
        }
    }
}

/// 桌面：从文件路径生成 H.264 MP4 视频预览。
#[cfg(not(target_os = "android"))]
pub async fn compress_video_for_preview(input_path: &Path) -> Result<VideoCompressResult, String> {
    generate_video_preview_from_path(input_path).await
}

/// 桌面：给定文件路径，用进程内 FFmpeg 解码首个视频流 → scale 缩放 → H.264/MP4 编码
/// （无音轨、前 2.5s），产出预览缩略图（桌面用 <video> 悬浮自动播放）。
#[cfg(not(target_os = "android"))]
async fn generate_video_preview_from_path(
    input_path: &Path,
) -> Result<VideoCompressResult, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;

    let preview_id = uuid::Uuid::new_v4();
    let extension = "mp4";
    let out_path = thumbnails_dir.join(format!("{preview_id}.{extension}"));

    let temp_dir = crate::app_paths::AppPaths::global().temp_dir.clone();
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;
    let temp_out_path = temp_dir.join(format!("{preview_id}.{extension}"));

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

/// 进程内 FFmpeg（rsmpeg/libav*）转码：解码首个视频流 → scale 缩放 → 编码（无音轨，截取前 2.5s）。
/// 桌面统一使用 H.264/MP4（Android 视频预览走 `run_ffmpeg_gif`）。
/// 返回输出视频的宽高（缩放后）。替代旧的 ffmpeg sidecar 进程调用。
#[cfg(not(target_os = "android"))]
fn run_ffmpeg_transcode(input_path: &Path, output_path: &Path) -> Result<(u32, u32), String> {
    use rsmpeg::avcodec::{AVCodec, AVCodecContext};
    use rsmpeg::avfilter::{AVFilter, AVFilterGraph, AVFilterInOut};
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::avutil::{AVDictionary, av_inv_q, ra};
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
        // 目标编码器均使用 yuv420p 输入。
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

    let encoder = AVCodec::find_encoder_by_name(c"libx264").ok_or("libx264 encoder not found")?;
    let mut enc_ctx = AVCodecContext::new(&encoder);
    enc_ctx.set_width(out_w);
    enc_ctx.set_height(out_h);
    enc_ctx.set_pix_fmt(ffi::AV_PIX_FMT_YUV420P);
    enc_ctx.set_time_base(av_inv_q(framerate));
    enc_ctx.set_framerate(framerate);

    // ---- 输出（按扩展名推断 MP4 muxer）----
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
                    break;
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

/// Android：进程内 FFmpeg 生成 10fps 动图 GIF 预览（无鼠标悬浮，用动图而非静帧）。
/// 解码首个视频流 → `fps=10,scale=最长边≤320:lanczos` → split/palettegen/paletteuse
/// 自适应调色板 → gif 编码/封装（gif муxer 默认无限循环）。截取前 2.5s。返回输出宽高。
/// palettegen 读完全部输入才在 EOF 产出调色板，故先把帧全部喂入 buffersrc 再一次性抽帧。
#[cfg(target_os = "android")]
fn run_ffmpeg_gif(input_path: &Path, output_path: &Path) -> Result<(u32, u32), String> {
    use rsmpeg::avcodec::{AVCodec, AVCodecContext};
    use rsmpeg::avfilter::{AVFilter, AVFilterGraph, AVFilterInOut};
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::avutil::ra;
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;
    use std::ffi::CString;

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

    let mut dec_ctx = AVCodecContext::new(&decoder);
    dec_ctx
        .apply_codecpar(&ifmt.streams()[video_idx].codecpar())
        .map_err(|e| format!("apply_codecpar failed: {e:?}"))?;
    dec_ctx.set_pkt_timebase(in_tb);
    dec_ctx
        .open(None)
        .map_err(|e| format!("open decoder failed: {e:?}"))?;

    // ---- 滤镜图：buffer → fps=10,scale,split/palettegen/paletteuse → buffersink(pal8) ----
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
        // gif 编码器要求调色板像素格式。
        sink.opt_set(c"pixel_formats", c"pal8")
            .map_err(|e| format!("set sink pix_fmt failed: {e:?}"))?;
        sink.init_str(None)
            .map_err(|e| format!("init buffersink failed: {e:?}"))?;

        let outputs = AVFilterInOut::new(c"in", &mut src, 0);
        let inputs = AVFilterInOut::new(c"out", &mut sink, 0);
        filter_graph
            .parse_ptr(
                c"fps=10,scale='min(320,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                Some(inputs),
                Some(outputs),
            )
            .map_err(|e| format!("parse gif filter graph failed: {e:?}"))?;
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

    // ---- gif 编码器 + 封装 ----
    let encoder = AVCodec::find_encoder(ffi::AV_CODEC_ID_GIF).ok_or("gif encoder not found")?;
    let mut enc_ctx = AVCodecContext::new(&encoder);
    enc_ctx.set_width(out_w);
    enc_ctx.set_height(out_h);
    enc_ctx.set_pix_fmt(ffi::AV_PIX_FMT_PAL8);
    // gif 以 1/100s（厘秒）为时基；10fps → 每帧 10 厘秒。
    enc_ctx.set_time_base(ra(1, 100));
    enc_ctx.set_framerate(ra(10, 1));

    let mut ofmt = AVFormatContextOutput::create(&output_c)
        .map_err(|e| format!("create output failed: {e:?}"))?;
    if ofmt.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
        enc_ctx.set_flags(enc_ctx.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
    }
    enc_ctx
        .open(None)
        .map_err(|e| format!("open gif encoder failed: {e:?}"))?;

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

    // ---- 先把 2.5s 内所有解码帧喂入滤镜（palettegen 要读完全部输入）----
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
                    break;
                }
                Err(e) => return Err(format!("receive_frame failed: {e:?}")),
            };
            let ts = frame.best_effort_timestamp;
            if ts != ffi::AV_NOPTS_VALUE && (ts as f64) * in_tb_secs >= PREVIEW_SECONDS {
                break 'outer;
            }
            frame.set_pts(ts);
            buffersrc_ctx
                .buffersrc_add_frame(Some(frame), None)
                .map_err(|e| format!("buffersrc_add_frame failed: {e:?}"))?;
        }
    }
    // 冲洗解码器（补齐 2.5s 内的尾帧）
    let _ = dec_ctx.send_packet(None);
    loop {
        let mut frame = match dec_ctx.receive_frame() {
            Ok(f) => f,
            Err(_) => break,
        };
        let ts = frame.best_effort_timestamp;
        if ts != ffi::AV_NOPTS_VALUE && (ts as f64) * in_tb_secs >= PREVIEW_SECONDS {
            break;
        }
        frame.set_pts(ts);
        buffersrc_ctx
            .buffersrc_add_frame(Some(frame), None)
            .map_err(|e| format!("buffersrc_add_frame failed: {e:?}"))?;
    }
    // EOF → 触发 palettegen 出调色板、paletteuse 出帧
    buffersrc_ctx
        .buffersrc_add_frame(None, None)
        .map_err(|e| format!("buffersrc EOF failed: {e:?}"))?;

    // ---- 抽取滤镜输出帧 → gif 编码 → 写出 ----
    loop {
        let mut filtered = match buffersink_ctx.buffersink_get_frame(None) {
            Ok(f) => f,
            Err(RsmpegError::BufferSinkDrainError) | Err(RsmpegError::BufferSinkEofError) => break,
            Err(e) => return Err(format!("buffersink_get_frame failed: {e:?}")),
        };
        filtered.set_time_base(sink_tb);
        filtered.set_pict_type(ffi::AV_PICTURE_TYPE_NONE);
        encode_write(&mut enc_ctx, &mut ofmt, stream_index, Some(filtered))?;
    }
    encode_write(&mut enc_ctx, &mut ofmt, stream_index, None)?;
    ofmt.write_trailer()
        .map_err(|e| format!("write_trailer failed: {e:?}"))?;

    Ok((out_w as u32, out_h as u32))
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

/// 兼容图片最长边像素上限。超过此上限的图片（或浏览器不支持的格式）会生成兼容副本。
pub const IMAGE_COMPATIBLE_MAX_DIM: u32 = 4096;
/// 无 alpha 图片的兼容 JPEG 质量。
const IMAGE_COMPATIBLE_JPEG_QUALITY: u8 = 90;
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
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
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
    let browser_unsafe = crate::image_type::mime_type_from_bytes(bytes)
        .map(|mime| !crate::image_type::image_mime_browser_safe(&mime))
        .unwrap_or(false);
    if !browser_unsafe && !image_needs_independent_thumbnail(bytes.len() as u64) {
        return Ok(None);
    }
    let img = match image::load_from_memory(bytes) {
        Ok(img) => img,
        Err(_) => match crate::media_decode::decode_image_via_ffmpeg_bytes(bytes) {
            Ok(img) => image::DynamicImage::ImageRgb8(img),
            Err(_) => return Ok(None),
        },
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
    let browser_unsafe = crate::image_type::mime_type_from_path(image_path)
        .map(|mime| !crate::image_type::image_mime_browser_safe(&mime))
        .unwrap_or(false);
    if !browser_unsafe && !image_needs_independent_thumbnail(source_size) {
        return Ok(None);
    }

    let img = match image::io::Reader::open(image_path) {
        Ok(mut reader) => {
            reader.no_limits();
            match reader.with_guessed_format() {
                Ok(r) => match r.decode() {
                    Ok(img) => img,
                    Err(_) => match crate::media_decode::decode_image_via_ffmpeg(image_path) {
                        Ok(img) => image::DynamicImage::ImageRgb8(img),
                        Err(_) => return Ok(None),
                    },
                },
                Err(_) => match crate::media_decode::decode_image_via_ffmpeg(image_path) {
                    Ok(img) => image::DynamicImage::ImageRgb8(img),
                    Err(_) => return Ok(None),
                },
            }
        }
        Err(_) => match crate::media_decode::decode_image_via_ffmpeg(image_path) {
            Ok(img) => image::DynamicImage::ImageRgb8(img),
            Err(_) => return Ok(None),
        },
    };
    let thumbnail_bytes = build_compressed_thumbnail_bytes(&img)?;
    write_thumbnail_bytes(thumbnail_bytes).await.map(Some)
}

fn image_requires_compatible_copy(mime_type: &str, width: u32, height: u32) -> bool {
    !crate::image_type::image_mime_browser_safe(mime_type)
        || width.max(height) > IMAGE_COMPATIBLE_MAX_DIM
}

/// 生成图片兼容副本（无 alpha 时 JPEG，有 alpha 时 PNG）。
/// 当图片格式浏览器不支持（HEIC/HEIF）或最长边 > `IMAGE_COMPATIBLE_MAX_DIM` 时生成；
/// 否则返回 `Ok(None)`，不浪费 IO。
/// 输出文件放在 `compatibles_dir`，扩展名由解码后的 alpha 通道决定。
pub async fn generate_compatible_image(
    image_path: &Path,
    mime_type: &str,
    width: u32,
    height: u32,
) -> Result<Option<PathBuf>, String> {
    if !image_requires_compatible_copy(mime_type, width, height) {
        return Ok(None);
    }
    let compatibles_dir = crate::app_paths::AppPaths::global().compatibles_dir();
    tokio::fs::create_dir_all(&compatibles_dir)
        .await
        .map_err(|e| format!("Failed to create compatibles directory: {e}"))?;
    let output_id = uuid::Uuid::new_v4().to_string();
    let in_path = image_path.to_path_buf();
    let dir_for_task = compatibles_dir.clone();
    let id_for_task = output_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        transcode_compatible_image_sync(&in_path, &dir_for_task, &id_for_task)
    })
    .await
    .map_err(|e| format!("Compatible image task join error: {e}"))
    .and_then(|r| r);
    match result {
        Ok(path) => Ok(Some(path)),
        Err(e) => {
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.jpg"))).await;
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.png"))).await;
            Err(e)
        }
    }
}

/// 强制生成供 Linux/Windows 原生桌面壁纸后端使用的兼容图片副本。
/// 输出文件放在 `compatibles_dir`，无 alpha 时为 JPEG，有 alpha 时为 PNG。
pub async fn generate_wallpaper_compatible_image(image_path: &Path) -> Result<PathBuf, String> {
    let compatibles_dir = crate::app_paths::AppPaths::global().compatibles_dir();
    tokio::fs::create_dir_all(&compatibles_dir)
        .await
        .map_err(|e| format!("Failed to create compatibles directory: {e}"))?;
    let output_id = uuid::Uuid::new_v4().to_string();
    let in_path = image_path.to_path_buf();
    let dir_for_task = compatibles_dir.clone();
    let id_for_task = output_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        transcode_compatible_image_sync(&in_path, &dir_for_task, &id_for_task)
    })
    .await
    .map_err(|e| format!("Wallpaper compatible image task join error: {e}"))
    .and_then(|r| r);
    match result {
        Ok(path) => Ok(path),
        Err(e) => {
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.jpg"))).await;
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.png"))).await;
            Err(e)
        }
    }
}

/// 内存字节版图片兼容副本生成。用于 Android 下载尚保有内存源的路径。
pub async fn generate_compatible_image_from_bytes(
    bytes: &[u8],
    mime_type: &str,
    width: u32,
    height: u32,
) -> Result<Option<PathBuf>, String> {
    if !image_requires_compatible_copy(mime_type, width, height) {
        return Ok(None);
    }
    let compatibles_dir = crate::app_paths::AppPaths::global().compatibles_dir();
    tokio::fs::create_dir_all(&compatibles_dir)
        .await
        .map_err(|e| format!("Failed to create compatibles directory: {e}"))?;
    let output_id = uuid::Uuid::new_v4().to_string();
    let owned_bytes = bytes.to_vec();
    let dir_for_task = compatibles_dir.clone();
    let id_for_task = output_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        transcode_compatible_image_bytes_sync(&owned_bytes, &dir_for_task, &id_for_task)
    })
    .await
    .map_err(|e| format!("Compatible image task join error: {e}"))
    .and_then(|r| r);
    match result {
        Ok(path) => Ok(Some(path)),
        Err(e) => {
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.jpg"))).await;
            let _ = tokio::fs::remove_file(compatibles_dir.join(format!("{output_id}.png"))).await;
            Err(e)
        }
    }
}

/// 桌面：生成视频兼容副本（含音频）。
/// 桌面统一使用 H.264/AAC MP4。当 `probe.browser_safe == true` 时不转码。
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
    let extension = "mp4";
    let out_path = compatibles_dir.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
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

/// 桌面：把页面捕获到的分离 MSE 音视频流 stream-copy 合流成单文件。
#[cfg(not(target_os = "android"))]
pub fn mux_media_streams(inputs: &[(PathBuf, String)], output_path: &Path) -> Result<(), String> {
    use rsmpeg::avcodec::AVCodecParameters;
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::ffi;
    use std::ffi::CString;

    if inputs.len() < 2 {
        return Err("Media mux requires at least two input streams".to_string());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create media mux directory: {e}"))?;
    }

    let to_cs = |p: &Path| -> Result<CString, String> {
        CString::new(p.to_string_lossy().as_ref()).map_err(|e| format!("path NUL: {e}"))
    };
    let output_c = to_cs(output_path)?;
    let mut ofmt = AVFormatContextOutput::create(&output_c)
        .map_err(|e| format!("create mux output: {e:?}"))?;

    struct OpenInput {
        ctx: AVFormatContextInput,
        mapped_stream: usize,
        output_stream: usize,
        input_time_base: ffi::AVRational,
        output_time_base: ffi::AVRational,
    }

    let mut opened = Vec::with_capacity(inputs.len());
    for (path, _mime) in inputs {
        let input_c = to_cs(path)?;
        let ifmt =
            AVFormatContextInput::open(&input_c).map_err(|e| format!("open mux input: {e:?}"))?;
        // Select the first video (else audio) stream by codec_type directly, WITHOUT
        // requiring a decoder. `find_best_stream` skips streams whose decoder isn't
        // compiled in (this build has no AV1 decoder), which would drop bilibili's AV1
        // video from what is only a stream-copy mux.
        let mapped_stream = {
            let count = ifmt.nb_streams as usize;
            let streams = ifmt.streams();
            let ty = |i: usize| streams[i].codecpar().codec_type;
            (0..count)
                .find(|&i| ty(i) == ffi::AVMEDIA_TYPE_VIDEO)
                .or_else(|| (0..count).find(|&i| ty(i) == ffi::AVMEDIA_TYPE_AUDIO))
                .ok_or_else(|| format!("no audio/video stream in {}", path.display()))?
        };
        let input_stream = &ifmt.streams()[mapped_stream];
        let input_time_base = input_stream.time_base;
        let output_stream;
        {
            let mut out_stream = ofmt.new_stream();
            let mut codecpar = AVCodecParameters::new();
            codecpar.copy(&input_stream.codecpar());
            out_stream.set_codecpar(codecpar);
            out_stream.set_time_base(input_time_base);
            output_stream = out_stream.index as usize;
        }
        opened.push(OpenInput {
            ctx: ifmt,
            mapped_stream,
            output_stream,
            input_time_base,
            // 占位:真正的 output_time_base 只有在 write_header 之后才确定
            // (mov/mp4 muxer 会把音轨 timescale 改写成采样率),此处先填输入值,
            // write_header 后再回读实际值,否则 rescale_ts 会用陈旧 timescale 导致时长错乱。
            output_time_base: input_time_base,
        });
    }

    ofmt.write_header(&mut None)
        .map_err(|e| format!("write mux header: {e:?}"))?;

    // write_header 之后 muxer 才最终确定各输出流的 time_base,回读真实值用于 rescale。
    for input in &mut opened {
        input.output_time_base = ofmt.streams()[input.output_stream].time_base;
    }

    for input in &mut opened {
        loop {
            let mut packet = match input.ctx.read_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => break,
                Err(e) => return Err(format!("read mux packet: {e:?}")),
            };
            if packet.stream_index as usize != input.mapped_stream {
                continue;
            }
            packet.set_stream_index(input.output_stream as i32);
            packet.rescale_ts(input.input_time_base, input.output_time_base);
            ofmt.interleaved_write_frame(&mut packet)
                .map_err(|e| format!("write mux packet: {e:?}"))?;
        }
    }

    ofmt.write_trailer()
        .map_err(|e| format!("write mux trailer: {e:?}"))?;
    Ok(())
}

fn write_compatible_image(
    img: image::DynamicImage,
    has_alpha: bool,
    output_dir: &Path,
    output_id: &str,
) -> Result<PathBuf, String> {
    use image::GenericImageView;
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
    if has_alpha {
        let output_path = output_dir.join(format!("{output_id}.png"));
        img.save_with_format(&output_path, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to save compatible PNG: {e}"))?;
        Ok(output_path)
    } else {
        let output_path = output_dir.join(format!("{output_id}.jpg"));
        let encoded = encode_jpeg_rgb(&img.to_rgb8(), IMAGE_COMPATIBLE_JPEG_QUALITY)?;
        std::fs::write(&output_path, encoded)
            .map_err(|e| format!("Failed to save compatible JPEG: {e}"))?;
        Ok(output_path)
    }
}

/// 图片兼容副本生成（同步）：优先 image crate，失败时回退 FFmpeg。
fn transcode_compatible_image_sync(
    input_path: &Path,
    output_dir: &Path,
    output_id: &str,
) -> Result<PathBuf, String> {
    let decoded = (|| {
        let mut reader = image::io::Reader::open(input_path)?;
        reader.no_limits();
        reader.with_guessed_format()?.decode()
    })();
    let (img, has_alpha) = match decoded {
        Ok(img) => {
            let has_alpha = img.color().has_alpha();
            (img, has_alpha)
        }
        Err(_) => (
            image::DynamicImage::ImageRgb8(crate::media_decode::decode_image_via_ffmpeg(
                input_path,
            )?),
            false,
        ),
    };
    write_compatible_image(img, has_alpha, output_dir, output_id)
}

fn transcode_compatible_image_bytes_sync(
    bytes: &[u8],
    output_dir: &Path,
    output_id: &str,
) -> Result<PathBuf, String> {
    let (img, has_alpha) = match image::load_from_memory(bytes) {
        Ok(img) => {
            let has_alpha = img.color().has_alpha();
            (img, has_alpha)
        }
        Err(_) => (
            image::DynamicImage::ImageRgb8(crate::media_decode::decode_image_via_ffmpeg_bytes(
                bytes,
            )?),
            false,
        ),
    };
    write_compatible_image(img, has_alpha, output_dir, output_id)
}

/// 视频兼容副本转码（同步）：解码 → scale(-2:min(1080,ih)) + yuv420p。
/// 桌面统一输出 H.264/AAC MP4。
#[cfg(not(target_os = "android"))]
fn transcode_compatible_video_sync(input_path: &Path, output_path: &Path) -> Result<(), String> {
    use rsmpeg::avcodec::{AVCodec, AVCodecContext};
    use rsmpeg::avfilter::{AVFilter, AVFilterGraph, AVFilterInOut};
    use rsmpeg::avformat::{AVFormatContextInput, AVFormatContextOutput};
    use rsmpeg::avutil::{AVDictionary, av_inv_q, ra};
    use rsmpeg::error::RsmpegError;
    use rsmpeg::ffi;
    use std::ffi::{CStr, CString};

    const MAX_H: i32 = VIDEO_COMPATIBLE_MAX_HEIGHT as i32;
    const COMPATIBLE_AUDIO_RATE: i32 = 44_100;
    const COMPATIBLE_AUDIO_FRAME_SIZE: i32 = 1_024;
    const COMPATIBLE_AUDIO_SAMPLE_FORMAT: rsmpeg::ffi::AVSampleFormat = ffi::AV_SAMPLE_FMT_FLTP;
    const COMPATIBLE_AUDIO_SAMPLE_FORMAT_NAME: &str = "fltp";

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
        .map_err(|e| format!("find audio stream: {e:?}"))?;
    let mut a_idx: Option<usize> = None;
    let mut a_dec_ctx: Option<AVCodecContext> = None;
    if let Some((idx, a_dec)) = audio_stream {
        let mut ctx = AVCodecContext::new(&a_dec);
        ctx.apply_codecpar(&ifmt.streams()[idx].codecpar())
            .map_err(|e| format!("audio apply_codecpar: {e:?}"))?;
        ctx.set_pkt_timebase(ifmt.streams()[idx].time_base);
        ctx.open(None)
            .map_err(|e| format!("open audio decoder: {e:?}"))?;
        a_idx = Some(idx);
        a_dec_ctx = Some(ctx);
    }

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

    // ── Audio filter (if available): abuffer → platform output format → abuffersink ──
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
            let spec = CString::new(format!(
                "aresample={COMPATIBLE_AUDIO_RATE},aformat=sample_fmts={COMPATIBLE_AUDIO_SAMPLE_FORMAT_NAME}:channel_layouts=stereo,asetnsamples=n={COMPATIBLE_AUDIO_FRAME_SIZE}:p=0"
            ))
            .map_err(|e| format!("audio filter spec NUL: {e}"))?;
            afg.parse_ptr(&spec, Some(ins), Some(outs))
                .map_err(|e| format!("parse a filter: {e:?}"))?;
            afg.config()
                .map_err(|e| format!("config a filter: {e:?}"))?;
            Ok(())
        })();
        setup.map_err(|e| format!("audio filter setup failed: {e}"))?;
        a_src_ctx_opt = afg.get_filter(c"a_in");
        a_sink_ctx_opt = afg.get_filter(c"a_out");
    }
    let has_audio_filter = a_src_ctx_opt.is_some() && a_sink_ctx_opt.is_some();

    // ── Video encoder: desktop WebViews use H.264. ──
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

    // ── Audio encoder: desktop WebViews use AAC. ──
    let mut a_enc_ctx_opt: Option<AVCodecContext> = None;
    let mut a_out_idx: usize = 0;
    if has_audio_filter {
        let audio_encoder =
            AVCodec::find_encoder(ffi::AV_CODEC_ID_AAC).ok_or("AAC encoder not found")?;
        let mut ctx = AVCodecContext::new(&audio_encoder);
        ctx.set_sample_rate(COMPATIBLE_AUDIO_RATE);
        ctx.set_sample_fmt(COMPATIBLE_AUDIO_SAMPLE_FORMAT);
        ctx.set_time_base(ra(1, COMPATIBLE_AUDIO_RATE));
        ctx.set_bit_rate(128_000);
        let mut ch_layout = unsafe { std::mem::zeroed::<ffi::AVChannelLayout>() };
        unsafe { ffi::av_channel_layout_default(&mut ch_layout, 2) };
        ctx.set_ch_layout(ch_layout);
        if ofmt.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
            ctx.set_flags(ctx.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
        }
        ctx.open(None)
            .map_err(|e| format!("open audio encoder: {e:?}"))?;
        let mut a_stream = ofmt.new_stream();
        a_stream.set_codecpar(ctx.extract_codecpar());
        a_stream.set_time_base(ctx.time_base);
        a_out_idx = a_stream.index as usize;
        a_enc_ctx_opt = Some(ctx);
    }

    ofmt.write_header(&mut None)
        .map_err(|e| format!("write_header: {e:?}"))?;

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
                        break;
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
