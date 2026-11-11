//! FFmpeg-backed static image decoding.
//!
//! HEIC images may be represented as a tile-grid stream group rather than one
//! full-size video frame. This module owns the unsafe stream-group inspection,
//! decodes the referenced tile streams, and presents callers with one RGB image.

use image::{Rgb, RgbImage};
use rsmpeg::avcodec::{AVCodec, AVCodecContext};
use rsmpeg::avformat::AVFormatContextInput;
use rsmpeg::avutil::{AVFrame, AVFrameWithImage, AVImage};
use rsmpeg::error::RsmpegError;
use rsmpeg::{ffi, swscale::SwsContext};
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::path::Path;

#[derive(Clone, Copy, Debug)]
struct TilePlacement {
    stream_index: usize,
    horizontal: u32,
    vertical: u32,
}

#[derive(Clone, Debug)]
struct TileGridInfo {
    coded_width: u32,
    coded_height: u32,
    horizontal_offset: u32,
    vertical_offset: u32,
    width: u32,
    height: u32,
    background: [u8; 4],
    placements: Vec<TilePlacement>,
}

fn checked_image_len(width: u32, height: u32) -> Result<usize, String> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| format!("image dimensions are too large: {width}x{height}"))
}

fn best_tile_grid(fmt: &AVFormatContextInput) -> Option<TileGridInfo> {
    let format = unsafe { &*fmt.as_ptr() };
    if format.nb_stream_groups == 0 || format.stream_groups.is_null() {
        return None;
    }

    let mut best: Option<TileGridInfo> = None;
    for group_index in 0..format.nb_stream_groups as usize {
        let group_ptr = unsafe { *format.stream_groups.add(group_index) };
        if group_ptr.is_null() {
            continue;
        }
        let group = unsafe { &*group_ptr };
        if group.type_ != ffi::AV_STREAM_GROUP_PARAMS_TILE_GRID || group.streams.is_null() {
            continue;
        }
        let grid_ptr = unsafe { group.params.tile_grid };
        if grid_ptr.is_null() {
            continue;
        }
        let grid = unsafe { &*grid_ptr };
        if grid.nb_tiles == 0
            || grid.offsets.is_null()
            || grid.coded_width <= 0
            || grid.coded_height <= 0
            || grid.horizontal_offset < 0
            || grid.vertical_offset < 0
            || grid.width <= 0
            || grid.height <= 0
        {
            continue;
        }

        let coded_width = grid.coded_width as u32;
        let coded_height = grid.coded_height as u32;
        let horizontal_offset = grid.horizontal_offset as u32;
        let vertical_offset = grid.vertical_offset as u32;
        let width = grid.width as u32;
        let height = grid.height as u32;
        if horizontal_offset.checked_add(width)? > coded_width
            || vertical_offset.checked_add(height)? > coded_height
            || checked_image_len(coded_width, coded_height).is_err()
        {
            continue;
        }

        let mut placements = Vec::with_capacity(grid.nb_tiles as usize);
        let mut valid = true;
        for tile_index in 0..grid.nb_tiles as usize {
            let offset = unsafe { *grid.offsets.add(tile_index) };
            if offset.idx >= group.nb_streams || offset.horizontal < 0 || offset.vertical < 0 {
                valid = false;
                break;
            }
            let stream_ptr = unsafe { *group.streams.add(offset.idx as usize) };
            if stream_ptr.is_null() {
                valid = false;
                break;
            }
            let stream_index = unsafe { (*stream_ptr).index };
            if stream_index < 0 || stream_index as usize >= fmt.nb_streams as usize {
                valid = false;
                break;
            }
            placements.push(TilePlacement {
                stream_index: stream_index as usize,
                horizontal: offset.horizontal as u32,
                vertical: offset.vertical as u32,
            });
        }
        if !valid || placements.is_empty() {
            continue;
        }

        let candidate = TileGridInfo {
            coded_width,
            coded_height,
            horizontal_offset,
            vertical_offset,
            width,
            height,
            background: grid.background,
            placements,
        };
        let area = u64::from(width) * u64::from(height);
        let best_area = best
            .as_ref()
            .map(|current| u64::from(current.width) * u64::from(current.height))
            .unwrap_or(0);
        if area > best_area {
            best = Some(candidate);
        }
    }
    best
}

/// Return the presentation dimensions of the largest TILE_GRID stream group.
pub(crate) fn tile_grid_dimensions(fmt: &AVFormatContextInput) -> Option<(u32, u32)> {
    best_tile_grid(fmt).map(|grid| (grid.width, grid.height))
}

/// Return the video stream with the largest coded area.
///
/// Still-image containers may include thumbnails and individual HEIC tiles, so
/// choosing the first video stream can report a much smaller image.
pub(crate) fn largest_video_stream_index(fmt: &AVFormatContextInput) -> Option<usize> {
    fmt.streams()
        .iter()
        .enumerate()
        .filter_map(|(index, stream)| {
            let codecpar = stream.codecpar();
            if codecpar.codec_type != ffi::AVMEDIA_TYPE_VIDEO
                || codecpar.width <= 0
                || codecpar.height <= 0
            {
                return None;
            }
            let area = i64::from(codecpar.width) * i64::from(codecpar.height);
            Some((index, area))
        })
        .max_by_key(|(_, area)| *area)
        .map(|(index, _)| index)
}

fn frame_to_rgb(frame: &AVFrame) -> Result<RgbImage, String> {
    frame_to_rgb_within(frame, None)
}

/// 同 [`frame_to_rgb`]；给了 `max_edge` 且帧的最长边超过它时，按面积平均等比缩到最长边等于它。
fn frame_to_rgb_within(frame: &AVFrame, max_edge: Option<u32>) -> Result<RgbImage, String> {
    let width = frame.width;
    let height = frame.height;
    if width <= 0 || height <= 0 {
        return Err(format!(
            "decoded frame has invalid dimensions: {width}x{height}"
        ));
    }
    let longest = width.max(height) as u32;
    let (width_u32, height_u32, flags) = match max_edge {
        Some(max_edge) if max_edge > 0 && longest > max_edge => {
            let scale = |edge: i32| {
                ((u64::from(edge as u32) * u64::from(max_edge) + u64::from(longest) / 2)
                    / u64::from(longest))
                .max(1) as u32
            };
            (scale(width), scale(height), ffi::SWS_AREA)
        }
        _ => (width as u32, height as u32, ffi::SWS_BILINEAR),
    };
    let buffer_len = checked_image_len(width_u32, height_u32)?;
    let image = AVImage::new(
        ffi::AV_PIX_FMT_RGB24,
        width_u32 as i32,
        height_u32 as i32,
        1,
    )
    .ok_or_else(|| format!("failed to allocate RGB frame: {width_u32}x{height_u32}"))?;
    let mut rgb_frame = AVFrameWithImage::new(image);
    let mut sws = SwsContext::get_context(
        width,
        height,
        frame.format,
        width_u32 as i32,
        height_u32 as i32,
        ffi::AV_PIX_FMT_RGB24,
        flags,
        None,
        None,
        None,
    )
    .ok_or_else(|| "failed to create swscale context".to_string())?;
    sws.scale_frame(frame, 0, height, &mut rgb_frame)
        .map_err(|e| format!("failed to convert decoded frame to RGB: {e:?}"))?;

    let mut pixels = vec![0; buffer_len];
    let copied = rgb_frame
        .image_copy_to_buffer(&mut pixels, 1)
        .map_err(|e| format!("failed to copy RGB frame: {e:?}"))?;
    if copied != buffer_len {
        return Err(format!(
            "unexpected RGB frame size: copied {copied}, expected {buffer_len}"
        ));
    }
    RgbImage::from_raw(width_u32, height_u32, pixels)
        .ok_or_else(|| "failed to construct RGB image".to_string())
}

fn receive_first_frame(decoder: &mut AVCodecContext) -> Result<Option<RgbImage>, String> {
    match decoder.receive_frame() {
        Ok(frame) => frame_to_rgb(&frame).map(Some),
        Err(RsmpegError::DecoderDrainError) | Err(RsmpegError::DecoderFlushedError) => Ok(None),
        Err(e) => Err(format!("failed to receive decoded image frame: {e:?}")),
    }
}

fn open_stream_decoder(
    fmt: &AVFormatContextInput,
    stream_index: usize,
) -> Result<AVCodecContext, String> {
    let stream = fmt
        .streams()
        .get(stream_index)
        .ok_or_else(|| format!("image stream index out of bounds: {stream_index}"))?;
    let codecpar = stream.codecpar();
    let decoder = AVCodec::find_decoder(codecpar.codec_id)
        .ok_or_else(|| format!("no decoder for image stream {stream_index}"))?;
    let mut context = AVCodecContext::new(&decoder);
    context
        .apply_codecpar(&codecpar)
        .map_err(|e| format!("failed to apply image codec parameters: {e:?}"))?;
    context.set_pkt_timebase(stream.time_base);
    context
        .open(None)
        .map_err(|e| format!("failed to open image decoder: {e:?}"))?;
    Ok(context)
}

fn decode_streams(
    fmt: &mut AVFormatContextInput,
    stream_indices: &HashSet<usize>,
) -> Result<HashMap<usize, RgbImage>, String> {
    let mut decoders = HashMap::with_capacity(stream_indices.len());
    for &stream_index in stream_indices {
        decoders.insert(stream_index, open_stream_decoder(fmt, stream_index)?);
    }

    let mut decoded = HashMap::with_capacity(stream_indices.len());
    while decoded.len() < stream_indices.len() {
        let packet = match fmt.read_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(e) => return Err(format!("failed to read image packet: {e:?}")),
        };
        let stream_index = packet.stream_index as usize;
        if decoded.contains_key(&stream_index) {
            continue;
        }
        let Some(decoder) = decoders.get_mut(&stream_index) else {
            continue;
        };
        decoder
            .send_packet(Some(&packet))
            .map_err(|e| format!("failed to send image packet for stream {stream_index}: {e:?}"))?;
        if let Some(image) = receive_first_frame(decoder)? {
            decoded.insert(stream_index, image);
        }
    }

    for (&stream_index, decoder) in &mut decoders {
        if decoded.contains_key(&stream_index) {
            continue;
        }
        match decoder.send_packet(None) {
            Ok(()) | Err(RsmpegError::DecoderFlushedError) => {}
            Err(e) => {
                return Err(format!(
                    "failed to flush image decoder for stream {stream_index}: {e:?}"
                ));
            }
        }
        if let Some(image) = receive_first_frame(decoder)? {
            decoded.insert(stream_index, image);
        }
    }

    if decoded.len() != stream_indices.len() {
        let missing: Vec<_> = stream_indices
            .iter()
            .filter(|index| !decoded.contains_key(index))
            .copied()
            .collect();
        return Err(format!("no decoded frame for image streams: {missing:?}"));
    }
    Ok(decoded)
}

fn place_tile(canvas: &mut RgbImage, tile: &RgbImage, x: u32, y: u32) {
    if x >= canvas.width() || y >= canvas.height() {
        return;
    }
    let copy_width = tile.width().min(canvas.width() - x) as usize;
    let copy_height = tile.height().min(canvas.height() - y);
    let canvas_stride = canvas.width() as usize * 3;
    let tile_stride = tile.width() as usize * 3;
    let copy_bytes = copy_width * 3;
    for row in 0..copy_height as usize {
        let source_start = row * tile_stride;
        let destination_start = (y as usize + row) * canvas_stride + x as usize * 3;
        canvas.as_flat_samples_mut().samples[destination_start..destination_start + copy_bytes]
            .copy_from_slice(&tile.as_raw()[source_start..source_start + copy_bytes]);
    }
}

/// Decode a static image with FFmpeg, including HEIC TILE_GRID composition.
pub fn decode_image_via_ffmpeg(path: &Path) -> Result<RgbImage, String> {
    let path_c = CString::new(path.to_string_lossy().as_ref())
        .map_err(|e| format!("image path contains NUL byte: {e}"))?;
    let mut fmt = AVFormatContextInput::open(&path_c)
        .map_err(|e| format!("failed to open image with FFmpeg: {e:?}"))?;

    if let Some(grid) = best_tile_grid(&fmt) {
        let stream_indices: HashSet<_> = grid
            .placements
            .iter()
            .map(|placement| placement.stream_index)
            .collect();
        let decoded = decode_streams(&mut fmt, &stream_indices)?;
        let mut canvas = RgbImage::from_pixel(
            grid.coded_width,
            grid.coded_height,
            Rgb([grid.background[0], grid.background[1], grid.background[2]]),
        );
        for placement in &grid.placements {
            let tile = decoded
                .get(&placement.stream_index)
                .ok_or_else(|| format!("missing decoded tile stream {}", placement.stream_index))?;
            place_tile(&mut canvas, tile, placement.horizontal, placement.vertical);
        }
        return Ok(image::imageops::crop_imm(
            &canvas,
            grid.horizontal_offset,
            grid.vertical_offset,
            grid.width,
            grid.height,
        )
        .to_image());
    }

    let stream_index = largest_video_stream_index(&fmt)
        .ok_or_else(|| "no decodable image stream found".to_string())?;
    let stream_indices = HashSet::from([stream_index]);
    decode_streams(&mut fmt, &stream_indices)?
        .remove(&stream_index)
        .ok_or_else(|| format!("no decoded frame for image stream {stream_index}"))
}

/// Decode in-memory image bytes through a temporary file in the application
/// temp directory. The file is removed regardless of decode success.
pub fn decode_image_via_ffmpeg_bytes(bytes: &[u8]) -> Result<RgbImage, String> {
    let temp_dir = crate::app_paths::AppPaths::global()
        .temp_dir
        .join("image-decode");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("failed to create image decode temp directory: {e}"))?;
    let temp_path = temp_dir.join(format!("{}.img", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, bytes)
        .map_err(|e| format!("failed to write image decode temp file: {e}"))?;
    let result = decode_image_via_ffmpeg(&temp_path);
    let _ = std::fs::remove_file(&temp_path);
    result
}

/// 抽帧结果的最长边上限。抽帧只用来取色，不需要原尺寸：4K 视频 8 帧的原尺寸 RGB 约 200 MB，
/// 缩到色盘采样的边长以内后每帧不到 1 MB。
const SAMPLED_FRAME_MAX_EDGE: u32 = crate::media::palette::SAMPLE_SIZE;

/// 一个时间点上为了等到一帧最多读多少个包（含音频等其它流的包）。
const SAMPLE_MAX_PACKETS_PER_POINT: usize = 2048;

fn open_video_input(path: &Path) -> Result<(AVFormatContextInput, usize, AVCodecContext), String> {
    let path_c = CString::new(path.to_string_lossy().as_ref())
        .map_err(|e| format!("video path contains NUL byte: {e}"))?;
    let fmt = AVFormatContextInput::open(&path_c)
        .map_err(|e| format!("failed to open video with FFmpeg: {e:?}"))?;
    let stream_index = match fmt.find_best_stream(ffi::AVMEDIA_TYPE_VIDEO) {
        Ok(Some((index, _))) => index,
        _ => largest_video_stream_index(&fmt)
            .ok_or_else(|| "no decodable video stream found".to_string())?,
    };
    let decoder = open_stream_decoder(&fmt, stream_index)?;
    Ok((fmt, stream_index, decoder))
}

fn receive_sampled_frame(decoder: &mut AVCodecContext) -> Result<Option<(i64, RgbImage)>, String> {
    match decoder.receive_frame() {
        Ok(frame) => {
            let image = frame_to_rgb_within(&frame, Some(SAMPLED_FRAME_MAX_EDGE))?;
            Ok(Some((frame.best_effort_timestamp, image)))
        }
        Err(RsmpegError::DecoderDrainError) | Err(RsmpegError::DecoderFlushedError) => Ok(None),
        Err(e) => Err(format!("failed to receive decoded video frame: {e:?}")),
    }
}

/// 从当前读位置起解出 `stream_index` 的下一帧，返回（时间戳，缩小后的画面）。
/// 读到文件尾或读满 [`SAMPLE_MAX_PACKETS_PER_POINT`] 个包仍没有帧时返回 `None`。
fn decode_next_frame(
    fmt: &mut AVFormatContextInput,
    decoder: &mut AVCodecContext,
    stream_index: usize,
) -> Result<Option<(i64, RgbImage)>, String> {
    for _ in 0..SAMPLE_MAX_PACKETS_PER_POINT {
        let packet = match fmt.read_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => {
                // 文件尾：把解码器里压着的帧冲出来
                match decoder.send_packet(None) {
                    Ok(()) | Err(RsmpegError::DecoderFlushedError) => {}
                    Err(e) => return Err(format!("failed to flush video decoder: {e:?}")),
                }
                return receive_sampled_frame(decoder);
            }
            Err(e) => return Err(format!("failed to read video packet: {e:?}")),
        };
        if packet.stream_index as usize != stream_index {
            continue;
        }
        // seek 之后的头几个包可能解不了（缺参考帧），跳过等下一个
        if decoder.send_packet(Some(&packet)).is_err() {
            continue;
        }
        if let Some(found) = receive_sampled_frame(decoder)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// 在视频时长上均匀取 `count` 个时间点各解一帧：第 i 个点在时长的 `(i + 0.5) / count` 处，
/// seek 到它之前最近的关键帧、解出第一帧。只解关键帧附近的一帧，不逐帧解码。
///
/// 帧数可能少于 `count`：seek 或解码失败的点跳过，相邻的点落在同一帧上时只留一份（短视频、
/// 关键帧稀疏）。时长未知或所有点都没解出来时，只返回从头解出的第一帧。
///
/// 返回的画面最长边不超过 [`SAMPLED_FRAME_MAX_EDGE`]（等比缩小），供取色用，不是原尺寸。
pub fn sample_video_frames(path: &Path, count: usize) -> Result<Vec<RgbImage>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let (mut fmt, stream_index, mut decoder) = open_video_input(path)?;

    // 容器级的时长与起点，单位是 AV_TIME_BASE（微秒）
    let duration = fmt.duration;
    let start = if fmt.start_time == ffi::AV_NOPTS_VALUE {
        0
    } else {
        fmt.start_time
    };

    let mut frames = Vec::with_capacity(count);
    if duration != ffi::AV_NOPTS_VALUE && duration > 0 {
        let mut last_timestamp = None;
        for index in 0..count {
            let offset = (duration as f64 * (index as f64 + 0.5) / count as f64) as i64;
            if fmt
                .seek(-1, start + offset, ffi::AVSEEK_FLAG_BACKWARD as i32)
                .is_err()
            {
                continue;
            }
            decoder.flush_buffers();
            let Ok(Some((timestamp, image))) =
                decode_next_frame(&mut fmt, &mut decoder, stream_index)
            else {
                continue;
            };
            if timestamp != ffi::AV_NOPTS_VALUE && last_timestamp == Some(timestamp) {
                continue;
            }
            last_timestamp = Some(timestamp);
            frames.push(image);
        }
    }

    if frames.is_empty() {
        // 重新打开再从头解：前面失败的 seek 可能已经把读位置挪走了
        let (mut fmt, stream_index, mut decoder) = open_video_input(path)?;
        match decode_next_frame(&mut fmt, &mut decoder, stream_index)? {
            Some((_, image)) => frames.push(image),
            None => return Err("no decodable video frame found".to_string()),
        }
    }
    Ok(frames)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rsmpeg::avformat::AVFormatContextOutput;
    use rsmpeg::avutil::{ra, AVDictionary};

    const TEST_VIDEO_SIZE: usize = 64;

    /// 用 libx264 + MP4（与桌面视频预览相同的编码路径）写一段测试视频：
    /// 灰度画面，亮度随帧号从暗到亮；每 `gop` 帧一个关键帧。
    pub(crate) fn write_test_video(path: &Path, frame_count: usize, fps: i32, gop: i32) {
        let encoder = AVCodec::find_encoder_by_name(c"libx264").expect("libx264 encoder");
        let mut encoder_context = AVCodecContext::new(&encoder);
        encoder_context.set_width(TEST_VIDEO_SIZE as i32);
        encoder_context.set_height(TEST_VIDEO_SIZE as i32);
        encoder_context.set_pix_fmt(ffi::AV_PIX_FMT_YUV420P);
        encoder_context.set_time_base(ra(1, fps));
        encoder_context.set_framerate(ra(fps, 1));
        encoder_context.set_gop_size(gop);
        encoder_context.set_max_b_frames(0);

        let path_c = CString::new(path.to_str().unwrap()).unwrap();
        let mut output = AVFormatContextOutput::create(&path_c).expect("create output");
        if output.oformat().flags & ffi::AVFMT_GLOBALHEADER as i32 != 0 {
            encoder_context
                .set_flags(encoder_context.flags | ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32);
        }
        // scenecut=0：关键帧只按 gop 出，测试里的时间点才对得上
        let options =
            AVDictionary::new(c"preset", c"ultrafast", 0).set(c"x264-params", c"scenecut=0", 0);
        encoder_context.open(Some(options)).expect("open encoder");
        {
            let mut stream = output.new_stream();
            stream.set_codecpar(encoder_context.extract_codecpar());
            stream.set_time_base(encoder_context.time_base);
        }
        output.write_header(&mut None).expect("write header");

        let mut frame = AVFrame::new();
        frame.set_format(ffi::AV_PIX_FMT_YUV420P);
        frame.set_width(TEST_VIDEO_SIZE as i32);
        frame.set_height(TEST_VIDEO_SIZE as i32);
        frame.alloc_buffer().expect("alloc frame");

        let mut write_packets = |encoder_context: &mut AVCodecContext, frame: Option<&AVFrame>| {
            encoder_context.send_frame(frame).expect("send frame");
            loop {
                let mut packet = match encoder_context.receive_packet() {
                    Ok(packet) => packet,
                    Err(RsmpegError::EncoderDrainError) | Err(RsmpegError::EncoderFlushedError) => {
                        break
                    }
                    Err(e) => panic!("receive packet: {e:?}"),
                };
                packet.set_stream_index(0);
                packet.rescale_ts(encoder_context.time_base, output.streams()[0].time_base);
                output
                    .interleaved_write_frame(&mut packet)
                    .expect("write packet");
            }
        };

        for index in 0..frame_count {
            frame.make_writable().expect("writable frame");
            let luma = (16 + index * 200 / frame_count.saturating_sub(1).max(1)) as u8;
            let data = frame.data;
            let linesize = frame.linesize;
            unsafe {
                for plane in 0..3 {
                    let rows = if plane == 0 {
                        TEST_VIDEO_SIZE
                    } else {
                        TEST_VIDEO_SIZE / 2
                    };
                    let value = if plane == 0 { luma } else { 128 };
                    std::ptr::write_bytes(data[plane], value, rows * linesize[plane] as usize);
                }
            }
            frame.set_pts(index as i64);
            write_packets(&mut encoder_context, Some(&frame));
        }
        write_packets(&mut encoder_context, None);
        output.write_trailer().expect("write trailer");
    }

    fn brightness(image: &RgbImage) -> u32 {
        let pixel = image.get_pixel(image.width() / 2, image.height() / 2);
        u32::from(pixel[0]) + u32::from(pixel[1]) + u32::from(pixel[2])
    }

    #[test]
    fn sample_video_frames_spreads_over_the_duration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.mp4");
        // 4 秒、每 0.5 秒一个关键帧：8 个时间点各落在不同的关键帧上
        write_test_video(&path, 40, 10, 5);

        let frames = sample_video_frames(&path, 8).unwrap();

        assert_eq!(frames.len(), 8);
        let levels: Vec<u32> = frames.iter().map(brightness).collect();
        assert!(
            levels.windows(2).all(|pair| pair[0] < pair[1]),
            "frames are not in time order: {levels:?}"
        );
        assert!(
            levels[levels.len() - 1] > levels[0] + 150,
            "first and last frames look the same: {levels:?}"
        );
        assert_eq!(frames[0].dimensions(), (64, 64));
    }

    #[test]
    fn decode_image_via_ffmpeg_returns_the_first_frame_at_full_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        write_test_video(&path, 10, 10, 5);

        let image = decode_image_via_ffmpeg(&path).unwrap();

        assert_eq!(image.dimensions(), (64, 64));
        // 第一帧是最暗的一帧
        assert!(brightness(&image) < 60, "{}", brightness(&image));
    }

    #[test]
    fn sample_video_frames_handles_a_sub_second_video() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.mp4");
        // 0.5 秒、只有开头一个关键帧
        write_test_video(&path, 5, 10, 250);

        let frames = sample_video_frames(&path, 8).unwrap();

        // 8 个时间点都落在同一个关键帧上，只留一份
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn sample_video_frames_reports_missing_and_non_video_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sample_video_frames(&dir.path().join("missing.mp4"), 8).is_err());

        let text = dir.path().join("not-a-video.mp4");
        std::fs::write(&text, b"this is not a video").unwrap();
        assert!(sample_video_frames(&text, 8).is_err());
    }

    #[test]
    fn sample_video_frames_with_zero_count_returns_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sample_video_frames(&dir.path().join("missing.mp4"), 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn frame_to_rgb_within_keeps_the_aspect_ratio_and_never_upscales() {
        let mut frame = AVFrame::new();
        frame.set_format(ffi::AV_PIX_FMT_YUV420P);
        frame.set_width(640);
        frame.set_height(320);
        frame.alloc_buffer().unwrap();
        let data = frame.data;
        let linesize = frame.linesize;
        unsafe {
            std::ptr::write_bytes(data[0], 200, 320 * linesize[0] as usize);
            std::ptr::write_bytes(data[1], 128, 160 * linesize[1] as usize);
            std::ptr::write_bytes(data[2], 128, 160 * linesize[2] as usize);
        }

        assert_eq!(frame_to_rgb(&frame).unwrap().dimensions(), (640, 320));
        assert_eq!(
            frame_to_rgb_within(&frame, Some(1024))
                .unwrap()
                .dimensions(),
            (640, 320)
        );
        let small = frame_to_rgb_within(&frame, Some(128)).unwrap();
        assert_eq!(small.dimensions(), (128, 64));
        // 缩小不改变颜色（整幅同一个灰度）
        let (first, last) = (small.get_pixel(0, 0), small.get_pixel(127, 63));
        assert_eq!(first, last);
        assert!(first[0] > 150, "{first:?}");
    }
}
