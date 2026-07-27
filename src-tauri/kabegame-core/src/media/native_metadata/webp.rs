use super::{NativeEntry, NativeGroup, WebpNativeMetadata};
use std::io::Cursor;

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_ANIMATION_FRAMES: u64 = 2000;

#[derive(Default)]
struct FirstFrame {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    duration_ms: u32,
    blend: bool,
    dispose: bool,
}

pub(super) fn parse(bytes: &[u8]) -> WebpNativeMetadata {
    if bytes.len() < 12
        || bytes.get(0..4) != Some(b"RIFF".as_slice())
        || bytes.get(8..12) != Some(b"WEBP".as_slice())
    {
        return WebpNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    }

    let Some(declared_size) = read_le_u32(bytes, 4).map(|value| value as usize) else {
        return WebpNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    };
    let Some(declared_end) = declared_size.checked_add(8) else {
        return WebpNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    };

    let mut partial = declared_end != bytes.len();
    let riff_end = declared_end.min(bytes.len());
    let mut offset = 12usize;
    let mut container_kind = None;
    let mut vp8x = Vec::new();
    let mut anim = Vec::new();
    let mut text = Vec::new();
    let mut color = Vec::new();
    let mut other = Vec::new();
    let mut exif_payload = None;
    let mut frame_count = 0u64;
    let mut total_duration_ms = 0u64;
    let mut first_frame = None;
    let mut frames_truncated = false;
    let mut saw_anim = false;

    while offset < riff_end {
        let Some(header_end) = offset.checked_add(8) else {
            partial = true;
            break;
        };
        if header_end > riff_end {
            partial = true;
            break;
        }

        let chunk_type = [
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ];
        let Some(length) = read_le_u32(bytes, offset + 4).map(|value| value as usize) else {
            partial = true;
            break;
        };
        let Some(data_end) = header_end.checked_add(length) else {
            partial = true;
            break;
        };
        let Some(chunk_end) = data_end.checked_add(length & 1) else {
            partial = true;
            break;
        };
        if chunk_end > riff_end {
            partial = true;
            break;
        }
        let data = &bytes[header_end..data_end];
        offset = chunk_end;

        match &chunk_type {
            b"VP8X" => {
                container_kind = Some("Extended");
                parse_vp8x(data, &mut vp8x, &mut partial);
            }
            b"VP8 " => {
                if container_kind.is_none() {
                    container_kind = Some("Simple lossy");
                }
                parse_vp8(data, &mut vp8x, &mut partial);
            }
            b"VP8L" => {
                if container_kind.is_none() {
                    container_kind = Some("Simple lossless");
                }
                parse_vp8l(data, &mut vp8x, &mut partial);
            }
            b"ALPH" => parse_alph(data, &mut vp8x, &mut partial),
            b"EXIF" => {
                if exif_payload.is_none() {
                    exif_payload = Some(data);
                }
            }
            b"XMP " => {
                if data.len() > MAX_TEXT_BYTES {
                    text.push(binary_entry(
                        "XMP".to_string(),
                        data.len() as u64,
                        Some("XMP"),
                    ));
                } else {
                    text.push(text_entry(
                        "XMP".to_string(),
                        String::from_utf8_lossy(data).into_owned(),
                        "XMP",
                    ));
                }
            }
            b"ICCP" => color.push(binary_entry(
                "Profile".to_string(),
                data.len() as u64,
                Some("ICCP"),
            )),
            b"ANIM" => {
                saw_anim = true;
                parse_anim(data, &mut anim, &mut partial);
            }
            b"ANMF" => {
                if frame_count >= MAX_ANIMATION_FRAMES {
                    frames_truncated = true;
                    continue;
                }
                match parse_anmf(data) {
                    Some(frame) => {
                        frame_count += 1;
                        total_duration_ms =
                            total_duration_ms.saturating_add(u64::from(frame.duration_ms));
                        if first_frame.is_none() {
                            first_frame = Some(frame);
                        }
                    }
                    None => partial = true,
                }
            }
            _ => {
                let name = String::from_utf8_lossy(&chunk_type).into_owned();
                other.push(binary_entry(name, data.len() as u64, None));
            }
        }
    }

    let container_kind = match container_kind {
        Some(kind) => kind,
        None => "Extended",
    };
    vp8x.insert(0, plain_entry("Container", container_kind));
    if saw_anim || frame_count > 0 || frames_truncated {
        let frame_note =
            frames_truncated.then(|| format!("Truncated after {MAX_ANIMATION_FRAMES} frames"));
        anim.push(entry_with_note(
            "FrameCount",
            frame_count.to_string(),
            frame_note,
        ));
        anim.push(plain_entry(
            "TotalDuration",
            format!("{total_duration_ms} ms"),
        ));
        if let Some(frame) = first_frame {
            anim.extend([
                plain_entry("FirstFrameOffset", format!("{}, {}", frame.x, frame.y)),
                plain_entry(
                    "FirstFrameSize",
                    format!("{} × {}", frame.width, frame.height),
                ),
                plain_entry("FirstFrameDuration", format!("{} ms", frame.duration_ms)),
                plain_entry(
                    "FirstFrameBlend",
                    if frame.blend { "Blend" } else { "No blend" },
                ),
                plain_entry(
                    "FirstFrameDispose",
                    if frame.dispose { "Background" } else { "None" },
                ),
            ]);
        }
    }

    let exif = match exif::Reader::new().read_from_container(&mut Cursor::new(bytes)) {
        Ok(exif) => Some(exif),
        Err(_) => exif_payload.and_then(|payload| {
            let raw = match payload.strip_prefix(b"Exif\0\0") {
                Some(raw) => raw,
                None => payload,
            };
            match exif::Reader::new().read_raw(raw.to_vec()) {
                Ok(exif) => Some(exif),
                Err(_) => {
                    partial = true;
                    None
                }
            }
        }),
    };

    let mut groups = Vec::new();
    push_group(&mut groups, "vp8x", "VP8X · VP8 · VP8L · ALPH", vp8x);
    if let Some(exif) = exif {
        groups.extend(super::exif_common::exif_groups(&exif));
    }
    push_group(&mut groups, "anim", "ANIM · ANMF", anim);
    push_group(&mut groups, "text", "XMP", text);
    push_group(&mut groups, "color", "ICCP", color);
    push_group(&mut groups, "other", "Unknown chunks", other);

    WebpNativeMetadata { partial, groups }
}

fn parse_vp8x(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 10 {
        *partial = true;
        return;
    }
    let Some(width) = read_le_u24(data, 4).and_then(|value| value.checked_add(1)) else {
        *partial = true;
        return;
    };
    let Some(height) = read_le_u24(data, 7).and_then(|value| value.checked_add(1)) else {
        *partial = true;
        return;
    };
    let flags = data[0];
    entries.extend([
        plain_entry("CanvasWidth", width.to_string()),
        plain_entry("CanvasHeight", height.to_string()),
        plain_entry("ICC", yes_no(flags & 0x20 != 0)),
        plain_entry("Alpha", yes_no(flags & 0x10 != 0)),
        plain_entry("EXIF", yes_no(flags & 0x08 != 0)),
        plain_entry("XMP", yes_no(flags & 0x04 != 0)),
        plain_entry("Animation", yes_no(flags & 0x02 != 0)),
    ]);
}

fn parse_vp8(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() < 10 || data.get(3..6) != Some(b"\x9d\x01\x2a".as_slice()) {
        *partial = true;
        return;
    }
    let Some(width) = read_le_u16(data, 6).map(|value| value & 0x3fff) else {
        *partial = true;
        return;
    };
    let Some(height) = read_le_u16(data, 8).map(|value| value & 0x3fff) else {
        *partial = true;
        return;
    };
    entries.extend([
        plain_entry("Bitstream", "Lossy"),
        plain_entry("BitstreamWidth", width.to_string()),
        plain_entry("BitstreamHeight", height.to_string()),
    ]);
}

fn parse_vp8l(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() < 5 || data[0] != 0x2f {
        *partial = true;
        return;
    }
    let width = 1 + u32::from(data[1]) + (u32::from(data[2] & 0x3f) << 8);
    let height = 1
        + (u32::from(data[2] >> 6) | (u32::from(data[3]) << 2) | (u32::from(data[4] & 0x0f) << 10));
    entries.extend([
        plain_entry("Bitstream", "Lossless"),
        plain_entry("BitstreamWidth", width.to_string()),
        plain_entry("BitstreamHeight", height.to_string()),
    ]);
}

fn parse_alph(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    let Some(&header) = data.first() else {
        *partial = true;
        return;
    };
    entries.extend([
        plain_entry("AlphaChunk", "Present"),
        plain_entry(
            "AlphaCompression",
            match header & 0x03 {
                0 => "0 · None".to_string(),
                value => value.to_string(),
            },
        ),
        plain_entry(
            "AlphaFilter",
            match (header >> 2) & 0x03 {
                0 => "0 · None".to_string(),
                1 => "1 · Horizontal".to_string(),
                2 => "2 · Vertical".to_string(),
                value => format!("{value} · Gradient"),
            },
        ),
        plain_entry(
            "AlphaPreprocessing",
            match (header >> 4) & 0x03 {
                0 => "0 · None".to_string(),
                1 => "1 · Level reduction".to_string(),
                value => value.to_string(),
            },
        ),
    ]);
}

fn parse_anim(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 6 {
        *partial = true;
        return;
    }
    let Some(loop_count) = read_le_u16(data, 4) else {
        *partial = true;
        return;
    };
    entries.extend([
        plain_entry(
            "BackgroundColor",
            format!("BGRA({}, {}, {}, {})", data[0], data[1], data[2], data[3]),
        ),
        plain_entry(
            "LoopCount",
            if loop_count == 0 {
                "0 · Infinite".to_string()
            } else {
                loop_count.to_string()
            },
        ),
    ]);
}

fn parse_anmf(data: &[u8]) -> Option<FirstFrame> {
    if data.len() < 16 {
        return None;
    }
    Some(FirstFrame {
        x: read_le_u24(data, 0)?.saturating_mul(2),
        y: read_le_u24(data, 3)?.saturating_mul(2),
        width: read_le_u24(data, 6)?.checked_add(1)?,
        height: read_le_u24(data, 9)?.checked_add(1)?,
        duration_ms: read_le_u24(data, 12)?,
        blend: data[15] & 0x02 == 0,
        dispose: data[15] & 0x01 != 0,
    })
}

fn read_le_u16(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let value = data.get(offset..end)?;
    Some(u16::from_le_bytes([value[0], value[1]]))
}

fn read_le_u24(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(3)?;
    let value = data.get(offset..end)?;
    Some(u32::from(value[0]) | (u32::from(value[1]) << 8) | (u32::from(value[2]) << 16))
}

fn read_le_u32(data: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let value = data.get(offset..end)?;
    Some(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "Yes"
    } else {
        "No"
    }
}

fn plain_entry(tag: impl Into<String>, value: impl Into<String>) -> NativeEntry {
    NativeEntry {
        tag: tag.into(),
        value: value.into(),
        note: None,
        long: false,
        byte_len: None,
    }
}

fn entry_with_note(
    tag: impl Into<String>,
    value: impl Into<String>,
    note: Option<String>,
) -> NativeEntry {
    NativeEntry {
        tag: tag.into(),
        value: value.into(),
        note,
        long: false,
        byte_len: None,
    }
}

fn text_entry(tag: String, value: String, chunk_name: &str) -> NativeEntry {
    NativeEntry {
        tag,
        long: value.chars().count() > 120,
        value,
        note: Some(chunk_name.to_string()),
        byte_len: None,
    }
}

fn binary_entry(tag: String, byte_len: u64, note: Option<&str>) -> NativeEntry {
    NativeEntry {
        tag,
        value: format!("<{byte_len} bytes>"),
        note: note.map(str::to_string),
        long: false,
        byte_len: Some(byte_len),
    }
}

fn push_group(groups: &mut Vec<NativeGroup>, id: &str, subtitle: &str, entries: Vec<NativeEntry>) {
    if !entries.is_empty() {
        groups.push(NativeGroup {
            id: id.to_string(),
            subtitle: subtitle.to_string(),
            entries,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(&(data.len() as u32).to_le_bytes());
        chunk.extend_from_slice(data);
        if data.len() & 1 != 0 {
            chunk.push(0);
        }
        chunk
    }

    fn webp(chunks: &[Vec<u8>]) -> Vec<u8> {
        let payload_len = 4usize + chunks.iter().map(Vec::len).sum::<usize>();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(payload_len as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        for chunk in chunks {
            bytes.extend_from_slice(chunk);
        }
        bytes
    }

    #[test]
    fn simple_lossy_has_container_group_only() {
        let bytes = webp(&[chunk(b"VP8 ", &[0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0])]);
        let metadata = parse(&bytes);

        assert!(!metadata.partial);
        assert_eq!(metadata.groups.len(), 1);
        assert_eq!(metadata.groups[0].id, "vp8x");
        assert_eq!(metadata.groups[0].entries[0].value, "Simple lossy");
    }

    #[test]
    fn extended_exif_with_preamble_uses_raw_fallback() {
        let mut tiff = b"II\x2a\0\x08\0\0\0\x01\0".to_vec();
        tiff.extend_from_slice(&[0x0f, 0x01, 0x02, 0x00, 0x04, 0, 0, 0, b'C', b'a', b'm', 0]);
        tiff.extend_from_slice(&[0, 0, 0, 0]);
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(&tiff);
        let bytes = webp(&[
            chunk(b"VP8X", &[0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            chunk(b"EXIF", &exif),
        ]);
        let metadata = parse(&bytes);

        assert!(!metadata.partial);
        assert_eq!(metadata.groups[0].id, "vp8x");
        assert!(metadata.groups.iter().any(|group| group.id == "image"));
    }

    #[test]
    fn aggregates_two_animation_frames() {
        let mut first = [0u8; 16];
        first[12] = 40;
        let mut second = [0u8; 16];
        second[12] = 60;
        let bytes = webp(&[
            chunk(b"VP8X", &[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            chunk(b"ANIM", &[1, 2, 3, 4, 0, 0]),
            chunk(b"ANMF", &first),
            chunk(b"ANMF", &second),
        ]);
        let metadata = parse(&bytes);
        let anim = metadata
            .groups
            .iter()
            .find(|group| group.id == "anim")
            .expect("测试数据应产出动画组");

        assert!(!metadata.partial);
        assert!(anim
            .entries
            .iter()
            .any(|entry| entry.tag == "FrameCount" && entry.value == "2"));
        assert!(anim
            .entries
            .iter()
            .any(|entry| entry.tag == "TotalDuration" && entry.value == "100 ms"));
    }
}
