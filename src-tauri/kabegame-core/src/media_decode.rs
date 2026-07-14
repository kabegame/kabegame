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
    let width = frame.width;
    let height = frame.height;
    if width <= 0 || height <= 0 {
        return Err(format!(
            "decoded frame has invalid dimensions: {width}x{height}"
        ));
    }
    let width_u32 = width as u32;
    let height_u32 = height as u32;
    let buffer_len = checked_image_len(width_u32, height_u32)?;
    let image = AVImage::new(ffi::AV_PIX_FMT_RGB24, width, height, 1)
        .ok_or_else(|| format!("failed to allocate RGB frame: {width}x{height}"))?;
    let mut rgb_frame = AVFrameWithImage::new(image);
    let mut sws = SwsContext::get_context(
        width,
        height,
        frame.format,
        width,
        height,
        ffi::AV_PIX_FMT_RGB24,
        ffi::SWS_BILINEAR,
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

fn decode_streams(
    fmt: &mut AVFormatContextInput,
    stream_indices: &HashSet<usize>,
) -> Result<HashMap<usize, RgbImage>, String> {
    let mut decoders = HashMap::with_capacity(stream_indices.len());
    for &stream_index in stream_indices {
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
        decoders.insert(stream_index, context);
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
        canvas.as_flat_samples_mut().samples
            [destination_start..destination_start + copy_bytes]
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
