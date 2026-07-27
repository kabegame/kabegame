use super::{GifNativeMetadata, NativeEntry, NativeGroup};

const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_ANIMATION_FRAMES: u64 = 2000;

#[derive(Clone, Copy, Default)]
struct GraphicControl {
    delay_cs: u16,
    disposal: u8,
    transparent_index: Option<u8>,
}

#[derive(Default)]
struct FirstFrame {
    disposal: u8,
    delay_cs: u16,
    transparent_index: Option<u8>,
    interlaced: bool,
    local_color_table: bool,
}

struct SubBlocks {
    data: Vec<u8>,
    byte_len: u64,
}

struct CommentEntry {
    text_index: usize,
    count: u64,
}

pub(super) fn parse(bytes: &[u8]) -> GifNativeMetadata {
    let Some(signature) = bytes.get(0..6) else {
        return GifNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    };
    if signature != b"GIF87a" && signature != b"GIF89a" {
        return GifNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    }
    let version = String::from_utf8_lossy(signature).into_owned();
    if bytes.len() < 13 {
        return GifNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    }

    let Some(width) = read_le_u16(bytes, 6) else {
        return GifNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    };
    let Some(height) = read_le_u16(bytes, 8) else {
        return GifNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    };
    let packed = bytes[10];
    let has_global_color_table = packed & 0x80 != 0;
    let global_color_count = 1usize << (usize::from(packed & 0x07) + 1);
    let screen = vec![
        plain_entry("Version", version),
        plain_entry("CanvasWidth", width.to_string()),
        plain_entry("CanvasHeight", height.to_string()),
        plain_entry(
            "GlobalColorTable",
            if has_global_color_table {
                format!("Yes · {global_color_count} colors")
            } else {
                "No".to_string()
            },
        ),
        plain_entry("ColorResolution", (((packed >> 4) & 0x07) + 1).to_string()),
        plain_entry("SortFlag", yes_no(packed & 0x08 != 0)),
        plain_entry("BackgroundColorIndex", bytes[11].to_string()),
        plain_entry(
            "PixelAspectRatio",
            if bytes[12] == 0 {
                "0 · Unspecified".to_string()
            } else {
                format!(
                    "{} · {:.4}",
                    bytes[12],
                    (f64::from(bytes[12]) + 15.0) / 64.0
                )
            },
        ),
    ];

    let mut partial = false;
    let mut offset = 13usize;
    if has_global_color_table {
        let Some(table_bytes) = global_color_count.checked_mul(3) else {
            return finish(true, screen, Vec::new(), Vec::new(), Vec::new(), Vec::new());
        };
        let Some(table_end) = offset.checked_add(table_bytes) else {
            return finish(true, screen, Vec::new(), Vec::new(), Vec::new(), Vec::new());
        };
        if table_end > bytes.len() {
            return finish(true, screen, Vec::new(), Vec::new(), Vec::new(), Vec::new());
        }
        offset = table_end;
    }

    let mut text = Vec::new();
    let mut color = Vec::new();
    let mut other = Vec::new();
    let mut frame_count = 0u64;
    let mut total_duration_ms = 0u64;
    let mut loop_count = None;
    let mut pending_control: Option<GraphicControl> = None;
    let mut first_frame = None;
    let mut comments = Vec::new();
    let mut frames_truncated = false;
    let mut saw_trailer = false;

    while offset < bytes.len() {
        let Some(&introducer) = bytes.get(offset) else {
            partial = true;
            break;
        };
        offset += 1;

        match introducer {
            0x2c => {
                if frame_count >= MAX_ANIMATION_FRAMES {
                    frames_truncated = true;
                    break;
                }
                let Some(descriptor_end) = offset.checked_add(9) else {
                    partial = true;
                    break;
                };
                let Some(descriptor) = bytes.get(offset..descriptor_end) else {
                    partial = true;
                    break;
                };
                offset = descriptor_end;
                let frame_packed = descriptor[8];
                let has_local_color_table = frame_packed & 0x80 != 0;
                if has_local_color_table {
                    let color_count = 1usize << (usize::from(frame_packed & 0x07) + 1);
                    let Some(table_bytes) = color_count.checked_mul(3) else {
                        partial = true;
                        break;
                    };
                    let Some(table_end) = offset.checked_add(table_bytes) else {
                        partial = true;
                        break;
                    };
                    if table_end > bytes.len() {
                        partial = true;
                        break;
                    }
                    offset = table_end;
                }
                if bytes.get(offset).is_none() {
                    partial = true;
                    break;
                }
                offset += 1;
                if read_sub_blocks(bytes, &mut offset, 0).is_err() {
                    partial = true;
                    break;
                }

                let control = match pending_control.take() {
                    Some(control) => control,
                    None => GraphicControl::default(),
                };
                frame_count += 1;
                total_duration_ms = total_duration_ms
                    .saturating_add(u64::from(control.delay_cs).saturating_mul(10));
                if first_frame.is_none() {
                    first_frame = Some(FirstFrame {
                        disposal: control.disposal,
                        delay_cs: control.delay_cs,
                        transparent_index: control.transparent_index,
                        interlaced: frame_packed & 0x40 != 0,
                        local_color_table: has_local_color_table,
                    });
                }
            }
            0x21 => {
                let Some(&label) = bytes.get(offset) else {
                    partial = true;
                    break;
                };
                offset += 1;
                match label {
                    0xf9 => {
                        let Some(control) = parse_graphic_control(bytes, &mut offset) else {
                            partial = true;
                            break;
                        };
                        pending_control = Some(control);
                    }
                    0xfe => {
                        let blocks = match read_sub_blocks(bytes, &mut offset, MAX_TEXT_BYTES + 1) {
                            Ok(blocks) => blocks,
                            Err(()) => {
                                partial = true;
                                break;
                            }
                        };
                        push_comment(&mut text, &mut comments, blocks);
                    }
                    0x01 => {
                        let Some(&header_size) = bytes.get(offset) else {
                            partial = true;
                            break;
                        };
                        offset += 1;
                        if header_size != 12 {
                            partial = true;
                            break;
                        }
                        let Some(header_end) = offset.checked_add(12) else {
                            partial = true;
                            break;
                        };
                        if header_end > bytes.len() {
                            partial = true;
                            break;
                        }
                        offset = header_end;
                        let blocks = match read_sub_blocks(bytes, &mut offset, MAX_TEXT_BYTES + 1) {
                            Ok(blocks) => blocks,
                            Err(()) => {
                                partial = true;
                                break;
                            }
                        };
                        if blocks.byte_len > MAX_TEXT_BYTES as u64 {
                            text.push(binary_entry(
                                "PlainText".to_string(),
                                blocks.byte_len,
                                Some("Plain Text"),
                            ));
                        } else {
                            text.push(text_entry(
                                "PlainText".to_string(),
                                latin1(&blocks.data),
                                "Plain Text",
                            ));
                        }
                    }
                    0xff => {
                        let Some(&identifier_size) = bytes.get(offset) else {
                            partial = true;
                            break;
                        };
                        offset += 1;
                        if identifier_size != 11 {
                            partial = true;
                            break;
                        }
                        let Some(identifier_end) = offset.checked_add(11) else {
                            partial = true;
                            break;
                        };
                        let Some(identifier_bytes) = bytes.get(offset..identifier_end) else {
                            partial = true;
                            break;
                        };
                        let identifier = String::from_utf8_lossy(identifier_bytes).into_owned();
                        offset = identifier_end;
                        let collect_limit = if identifier_bytes == b"ICCRGBG1012" {
                            0
                        } else {
                            MAX_TEXT_BYTES + 257
                        };
                        let blocks = match read_sub_blocks(bytes, &mut offset, collect_limit) {
                            Ok(blocks) => blocks,
                            Err(()) => {
                                partial = true;
                                break;
                            }
                        };
                        match identifier_bytes {
                            b"NETSCAPE2.0" => {
                                if blocks.data.len() < 3 || blocks.data[0] != 0x01 {
                                    partial = true;
                                } else {
                                    loop_count = read_le_u16(&blocks.data, 1);
                                    if loop_count.is_none() {
                                        partial = true;
                                    }
                                }
                            }
                            b"XMP DataXMP" => {
                                if blocks.byte_len > MAX_TEXT_BYTES as u64 {
                                    text.push(binary_entry(
                                        "XMP".to_string(),
                                        blocks.byte_len,
                                        Some("XMP"),
                                    ));
                                } else {
                                    text.push(text_entry(
                                        "XMP".to_string(),
                                        String::from_utf8_lossy(&blocks.data).into_owned(),
                                        "XMP",
                                    ));
                                }
                            }
                            b"ICCRGBG1012" => color.push(binary_entry(
                                "Profile".to_string(),
                                blocks.byte_len,
                                Some("ICC"),
                            )),
                            _ => other.push(binary_entry(
                                identifier,
                                blocks.byte_len,
                                Some("Application"),
                            )),
                        }
                    }
                    _ => {
                        let blocks = match read_sub_blocks(bytes, &mut offset, 0) {
                            Ok(blocks) => blocks,
                            Err(()) => {
                                partial = true;
                                break;
                            }
                        };
                        other.push(binary_entry(
                            format!("Extension 0x{label:02X}"),
                            blocks.byte_len,
                            None,
                        ));
                    }
                }
            }
            0x3b => {
                saw_trailer = true;
                break;
            }
            value => {
                other.push(plain_entry(format!("Block 0x{value:02X}"), "Unknown block"));
                partial = true;
                break;
            }
        }
    }

    if !saw_trailer && !frames_truncated {
        partial = true;
    }

    let mut anim = Vec::new();
    if frame_count > 0 || frames_truncated {
        anim.push(entry_with_note(
            "FrameCount",
            frame_count.to_string(),
            frames_truncated.then(|| format!("Truncated after {MAX_ANIMATION_FRAMES} frames")),
        ));
        anim.push(entry_with_note(
            "TotalDuration",
            format!("{total_duration_ms} ms"),
            Some("Nominal GIF delay; browsers commonly render delay <= 1 as 100 ms".to_string()),
        ));
        anim.push(plain_entry(
            "LoopCount",
            match loop_count {
                Some(0) => "0 · Infinite".to_string(),
                Some(value) => value.to_string(),
                None => "Not declared · No loop".to_string(),
            },
        ));
        if let Some(frame) = first_frame {
            anim.extend([
                plain_entry("FirstFrameDisposal", frame.disposal.to_string()),
                plain_entry(
                    "FirstFrameDelay",
                    format!("{} ms", u64::from(frame.delay_cs) * 10),
                ),
                plain_entry(
                    "FirstFrameTransparentColor",
                    match frame.transparent_index {
                        Some(index) => format!("Yes · index {index}"),
                        None => "No".to_string(),
                    },
                ),
                plain_entry("FirstFrameInterlaced", yes_no(frame.interlaced)),
                plain_entry("FirstFrameLocalColorTable", yes_no(frame.local_color_table)),
            ]);
        }
    }

    finish(partial, screen, anim, text, color, other)
}

fn parse_graphic_control(bytes: &[u8], offset: &mut usize) -> Option<GraphicControl> {
    let block_size = *bytes.get(*offset)?;
    *offset = offset.checked_add(1)?;
    if block_size != 4 {
        return None;
    }
    let end = offset.checked_add(4)?;
    let data = bytes.get(*offset..end)?;
    *offset = end;
    if *bytes.get(*offset)? != 0 {
        return None;
    }
    *offset = offset.checked_add(1)?;
    let delay_cs = u16::from_le_bytes([data[1], data[2]]);
    Some(GraphicControl {
        delay_cs,
        disposal: (data[0] >> 2) & 0x07,
        transparent_index: (data[0] & 0x01 != 0).then_some(data[3]),
    })
}

fn read_sub_blocks(
    bytes: &[u8],
    offset: &mut usize,
    collect_limit: usize,
) -> Result<SubBlocks, ()> {
    let mut data = Vec::new();
    let mut byte_len = 0u64;
    loop {
        let size = usize::from(*bytes.get(*offset).ok_or(())?);
        *offset = offset.checked_add(1).ok_or(())?;
        if size == 0 {
            return Ok(SubBlocks { data, byte_len });
        }
        let end = offset.checked_add(size).ok_or(())?;
        let block = bytes.get(*offset..end).ok_or(())?;
        *offset = end;
        byte_len = byte_len.saturating_add(size as u64);
        if data.len() < collect_limit {
            let remaining = collect_limit - data.len();
            data.extend_from_slice(&block[..block.len().min(remaining)]);
        }
    }
}

fn read_le_u16(data: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let value = data.get(offset..end)?;
    Some(u16::from_le_bytes([value[0], value[1]]))
}

fn latin1(data: &[u8]) -> String {
    data.iter().map(|byte| char::from(*byte)).collect()
}

fn push_comment(text: &mut Vec<NativeEntry>, comments: &mut Vec<CommentEntry>, blocks: SubBlocks) {
    let value = (blocks.byte_len <= MAX_TEXT_BYTES as u64).then(|| latin1(&blocks.data));
    let duplicate = comments.iter().position(|comment| {
        let Some(entry) = text.get(comment.text_index) else {
            return false;
        };
        match &value {
            Some(value) => entry.byte_len.is_none() && entry.value == value.as_str(),
            None => entry.byte_len == Some(blocks.byte_len),
        }
    });

    if let Some(index) = duplicate {
        if let Some(comment) = comments.get_mut(index) {
            comment.count = comment.count.saturating_add(1);
            if let Some(entry) = text.get_mut(comment.text_index) {
                entry.note = Some(format!("Comment × {}", comment.count));
            }
        }
        return;
    }

    let number = comments.len() + 1;
    let tag = if number == 1 {
        "Comment".to_string()
    } else {
        format!("Comment {number}")
    };
    let entry = match value {
        Some(value) => text_entry(tag, value, "Comment"),
        None => binary_entry(tag, blocks.byte_len, Some("Comment")),
    };
    comments.push(CommentEntry {
        text_index: text.len(),
        count: 1,
    });
    text.push(entry);
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

fn text_entry(tag: String, value: String, block_name: &str) -> NativeEntry {
    NativeEntry {
        tag,
        long: value.chars().count() > 120,
        value,
        note: Some(block_name.to_string()),
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

fn finish(
    partial: bool,
    screen: Vec<NativeEntry>,
    anim: Vec<NativeEntry>,
    text: Vec<NativeEntry>,
    color: Vec<NativeEntry>,
    other: Vec<NativeEntry>,
) -> GifNativeMetadata {
    let mut groups = Vec::new();
    push_group(
        &mut groups,
        "screen",
        "Header · Logical Screen Descriptor",
        screen,
    );
    push_group(
        &mut groups,
        "anim",
        "Image Descriptor · Graphic Control",
        anim,
    );
    push_group(&mut groups, "text", "Comment · XMP", text);
    push_group(&mut groups, "color", "ICC", color);
    push_group(&mut groups, "other", "Unknown blocks", other);
    GifNativeMetadata { partial, groups }
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn image() -> Vec<u8> {
        vec![0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]
    }

    fn gce(delay_cs: u16) -> Vec<u8> {
        let [low, high] = delay_cs.to_le_bytes();
        vec![0x21, 0xf9, 4, 0, low, high, 0, 0]
    }

    fn comment(value: &[u8]) -> Vec<u8> {
        let mut extension = vec![0x21, 0xfe];
        for block in value.chunks(255) {
            extension.push(block.len() as u8);
            extension.extend_from_slice(block);
        }
        extension.push(0);
        extension
    }

    #[test]
    fn minimal_gif87a_is_complete() {
        let mut gif = b"GIF87a\x01\0\x01\0\0\0\0".to_vec();
        gif.extend(image());
        gif.push(0x3b);
        let metadata = parse(&gif);

        assert!(!metadata.partial);
        assert_eq!(metadata.groups[0].id, "screen");
        assert_eq!(metadata.groups[1].id, "anim");
    }

    #[test]
    fn gif89a_collects_comment_loop_and_two_frames() {
        let mut gif = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
        gif.extend_from_slice(b"\x21\xfe\x05hello\0");
        gif.extend_from_slice(b"\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0");
        gif.extend(gce(2));
        gif.extend(image());
        gif.extend(gce(3));
        gif.extend(image());
        gif.push(0x3b);
        let metadata = parse(&gif);
        let text = metadata
            .groups
            .iter()
            .find(|group| group.id == "text")
            .expect("测试数据应产出文本组");
        let anim = metadata
            .groups
            .iter()
            .find(|group| group.id == "anim")
            .expect("测试数据应产出动画组");

        assert!(!metadata.partial);
        assert_eq!(text.entries[0].value, "hello");
        assert!(anim
            .entries
            .iter()
            .any(|entry| entry.tag == "FrameCount" && entry.value == "2"));
        assert!(anim
            .entries
            .iter()
            .any(|entry| entry.tag == "TotalDuration" && entry.value == "50 ms"));
        assert!(anim
            .entries
            .iter()
            .any(|entry| entry.tag == "LoopCount" && entry.value == "0 · Infinite"));
    }

    #[test]
    fn merges_duplicate_comments_in_first_seen_order() {
        let mut gif = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
        gif.extend(comment(b"same"));
        gif.extend(comment(b"different"));
        gif.extend(comment(b"same"));
        gif.extend(comment(b"same"));
        gif.extend(image());
        gif.push(0x3b);
        let metadata = parse(&gif);
        let text = metadata
            .groups
            .iter()
            .find(|group| group.id == "text")
            .expect("测试数据应产出文本组");

        assert!(!metadata.partial);
        assert_eq!(text.entries.len(), 2);
        assert_eq!(text.entries[0].tag, "Comment");
        assert_eq!(text.entries[0].value, "same");
        assert_eq!(text.entries[0].note.as_deref(), Some("Comment × 3"));
        assert_eq!(text.entries[1].tag, "Comment 2");
        assert_eq!(text.entries[1].value, "different");
        assert_eq!(text.entries[1].note.as_deref(), Some("Comment"));
    }

    #[test]
    fn truncated_gif_is_partial() {
        let mut gif = b"GIF89a\x01\0\x01\0\0\0\0".to_vec();
        gif.extend_from_slice(&[0x21, 0xfe, 5, b'a']);

        assert!(parse(&gif).partial);
    }
}
