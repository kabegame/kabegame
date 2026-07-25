use super::{NativeEntry, NativeGroup, PngNativeMetadata};
use flate2::read::ZlibDecoder;
use std::io::Read;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_TEXT_BYTES: usize = 256 * 1024;

pub(super) fn parse(bytes: &[u8]) -> PngNativeMetadata {
    if bytes.len() < PNG_SIGNATURE.len() || &bytes[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return PngNativeMetadata {
            partial: true,
            groups: Vec::new(),
        };
    }

    let mut partial = false;
    let mut offset = PNG_SIGNATURE.len();
    let mut ihdr = Vec::new();
    let mut text = Vec::new();
    let mut color = Vec::new();
    let mut phys = Vec::new();
    let mut other = Vec::new();
    let mut idat_count = 0u64;
    let mut idat_bytes = 0u64;
    let mut saw_iend = false;

    while offset < bytes.len() {
        let Some(header_end) = offset.checked_add(8) else {
            partial = true;
            break;
        };
        if header_end > bytes.len() {
            partial = true;
            break;
        }

        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk_type: [u8; 4] = bytes[offset + 4..header_end].try_into().unwrap();
        let Some(data_end) = header_end.checked_add(length) else {
            partial = true;
            break;
        };
        let Some(chunk_end) = data_end.checked_add(4) else {
            partial = true;
            break;
        };
        if chunk_end > bytes.len() {
            partial = true;
            break;
        }
        let data = &bytes[header_end..data_end];
        offset = chunk_end;

        match &chunk_type {
            b"IHDR" => parse_ihdr(data, &mut ihdr, &mut partial),
            b"tEXt" => parse_text(data, "tEXt", false, &mut text, &mut partial),
            b"zTXt" => parse_ztxt(data, &mut text, &mut partial),
            b"iTXt" => parse_itxt(data, &mut text, &mut partial),
            b"gAMA" => parse_gamma(data, &mut color, &mut partial),
            b"cHRM" => parse_chrm(data, &mut color, &mut partial),
            b"sRGB" => parse_srgb(data, &mut color, &mut partial),
            b"iCCP" => parse_iccp(data, &mut color, &mut partial),
            b"pHYs" => parse_phys(data, &mut phys, &mut partial),
            b"tIME" => parse_time(data, &mut phys, &mut partial),
            b"IDAT" => {
                idat_count += 1;
                idat_bytes = idat_bytes.saturating_add(data.len() as u64);
            }
            b"IEND" => {
                if !data.is_empty() {
                    partial = true;
                }
                saw_iend = true;
                break;
            }
            _ => {
                let name = String::from_utf8_lossy(&chunk_type).into_owned();
                other.push(binary_entry(name, data.len() as u64, None));
            }
        }
    }

    if idat_count > 0 {
        other.push(NativeEntry {
            tag: "IDAT".to_string(),
            value: format!("IDAT × {idat_count}, total {idat_bytes} bytes"),
            note: None,
            long: false,
            byte_len: None,
        });
    }
    if !saw_iend {
        partial = true;
    }

    let mut groups = Vec::new();
    push_group(&mut groups, "ihdr", "IHDR", ihdr);
    push_group(&mut groups, "text", "tEXt · iTXt · zTXt", text);
    push_group(&mut groups, "color", "gAMA · cHRM · sRGB · iCCP", color);
    push_group(&mut groups, "phys", "pHYs · tIME", phys);
    push_group(&mut groups, "other", "Unknown chunks", other);

    PngNativeMetadata { partial, groups }
}

fn parse_ihdr(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 13 {
        *partial = true;
        return;
    }
    let width = u32::from_be_bytes(data[0..4].try_into().unwrap());
    let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
    entries.extend([
        plain_entry("Width", width.to_string()),
        plain_entry("Height", height.to_string()),
        plain_entry("BitDepth", data[8].to_string()),
        plain_entry(
            "ColorType",
            match data[9] {
                0 => "0 · Grayscale".to_string(),
                2 => "2 · Truecolor".to_string(),
                3 => "3 · Indexed-color".to_string(),
                4 => "4 · Grayscale with alpha".to_string(),
                6 => "6 · Truecolor with alpha".to_string(),
                value => value.to_string(),
            },
        ),
        plain_entry("Compression", data[10].to_string()),
        plain_entry("Filter", data[11].to_string()),
        plain_entry(
            "Interlace",
            match data[12] {
                0 => "0 · None".to_string(),
                1 => "1 · Adam7".to_string(),
                value => value.to_string(),
            },
        ),
    ]);
}

fn parse_text(
    data: &[u8],
    chunk_name: &str,
    utf8: bool,
    entries: &mut Vec<NativeEntry>,
    partial: &mut bool,
) {
    if push_oversized_text(data, chunk_name, entries, partial) {
        return;
    }
    let Some((keyword, value)) = split_once_nul(data) else {
        *partial = true;
        return;
    };
    let keyword = png_keyword(keyword);
    let value = if utf8 {
        String::from_utf8_lossy(value).into_owned()
    } else {
        latin1(value)
    };
    entries.push(text_entry(
        fallback_keyword(&keyword, chunk_name),
        value,
        chunk_name,
    ));
}

fn parse_ztxt(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if push_oversized_text(data, "zTXt", entries, partial) {
        return;
    }
    let Some((keyword, rest)) = split_once_nul(data) else {
        *partial = true;
        return;
    };
    let keyword = png_keyword(keyword);
    let Some((&method, compressed)) = rest.split_first() else {
        *partial = true;
        return;
    };
    if method != 0 {
        *partial = true;
        return;
    }
    match decompress_limited(compressed) {
        Ok(Some(value)) => entries.push(text_entry(
            fallback_keyword(&keyword, "zTXt"),
            latin1(&value),
            "zTXt",
        )),
        Ok(None) => entries.push(binary_entry(
            fallback_keyword(&keyword, "zTXt"),
            compressed.len() as u64,
            Some("zTXt"),
        )),
        Err(()) => {
            *partial = true;
            entries.push(binary_entry(
                fallback_keyword(&keyword, "zTXt"),
                compressed.len() as u64,
                Some("zTXt"),
            ));
        }
    }
}

fn parse_itxt(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if push_oversized_text(data, "iTXt", entries, partial) {
        return;
    }
    let Some((keyword, rest)) = split_once_nul(data) else {
        *partial = true;
        return;
    };
    let keyword = png_keyword(keyword);
    if rest.len() < 2 {
        *partial = true;
        return;
    }
    let compression_flag = rest[0];
    let compression_method = rest[1];
    if compression_method != 0 {
        *partial = true;
    }
    let Some((_, after_language)) = split_once_nul(&rest[2..]) else {
        *partial = true;
        return;
    };
    let Some((_, text_bytes)) = split_once_nul(after_language) else {
        *partial = true;
        return;
    };

    let decoded = match compression_flag {
        0 => Some(text_bytes.to_vec()),
        1 if compression_method == 0 => match decompress_limited(text_bytes) {
            Ok(value) => value,
            Err(()) => {
                *partial = true;
                None
            }
        },
        _ => {
            *partial = true;
            None
        }
    };
    match decoded {
        Some(value) if value.len() <= MAX_TEXT_BYTES => entries.push(text_entry(
            fallback_keyword(&keyword, "iTXt"),
            String::from_utf8_lossy(&value).into_owned(),
            "iTXt",
        )),
        _ => entries.push(binary_entry(
            fallback_keyword(&keyword, "iTXt"),
            text_bytes.len() as u64,
            Some("iTXt"),
        )),
    }
}

fn parse_gamma(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 4 {
        *partial = true;
        return;
    }
    let gamma = u32::from_be_bytes(data.try_into().unwrap()) as f64 / 100_000.0;
    entries.push(plain_entry("Gamma", format!("{gamma:.5}")));
}

fn parse_chrm(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 32 {
        *partial = true;
        return;
    }
    let names = [
        "WhitePointX",
        "WhitePointY",
        "RedX",
        "RedY",
        "GreenX",
        "GreenY",
        "BlueX",
        "BlueY",
    ];
    for (index, name) in names.into_iter().enumerate() {
        let start = index * 4;
        let value =
            u32::from_be_bytes(data[start..start + 4].try_into().unwrap()) as f64 / 100_000.0;
        entries.push(plain_entry(name, format!("{value:.5}")));
    }
}

fn parse_srgb(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 1 {
        *partial = true;
        return;
    }
    let value = match data[0] {
        0 => "0 · Perceptual".to_string(),
        1 => "1 · Relative colorimetric".to_string(),
        2 => "2 · Saturation".to_string(),
        3 => "3 · Absolute colorimetric".to_string(),
        value => value.to_string(),
    };
    entries.push(plain_entry("RenderingIntent", value));
}

fn parse_iccp(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    let Some((profile_name, rest)) = split_once_nul(data) else {
        *partial = true;
        return;
    };
    let Some((&method, compressed)) = rest.split_first() else {
        *partial = true;
        return;
    };
    if method != 0 {
        *partial = true;
    }
    entries.push(NativeEntry {
        tag: "Profile".to_string(),
        value: fallback_keyword(&png_keyword(profile_name), "iCCP"),
        note: Some("iCCP".to_string()),
        long: false,
        byte_len: Some(compressed.len() as u64),
    });
}

fn parse_phys(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 9 {
        *partial = true;
        return;
    }
    let x = u32::from_be_bytes(data[0..4].try_into().unwrap());
    let y = u32::from_be_bytes(data[4..8].try_into().unwrap());
    entries.extend([
        plain_entry("PixelsPerUnitX", x.to_string()),
        plain_entry("PixelsPerUnitY", y.to_string()),
        plain_entry(
            "Unit",
            match data[8] {
                0 => "Unknown".to_string(),
                1 => "Metre".to_string(),
                value => value.to_string(),
            },
        ),
    ]);
}

fn parse_time(data: &[u8], entries: &mut Vec<NativeEntry>, partial: &mut bool) {
    if data.len() != 7 {
        *partial = true;
        return;
    }
    let year = u16::from_be_bytes(data[0..2].try_into().unwrap());
    entries.push(plain_entry(
        "LastModificationTime",
        format!(
            "{year:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            data[2], data[3], data[4], data[5], data[6]
        ),
    ));
}

fn decompress_limited(data: &[u8]) -> Result<Option<Vec<u8>>, ()> {
    let decoder = ZlibDecoder::new(data);
    let mut output = Vec::new();
    decoder
        .take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| ())?;
    if output.len() > MAX_TEXT_BYTES {
        Ok(None)
    } else {
        Ok(Some(output))
    }
}

fn split_once_nul(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let index = data.iter().position(|byte| *byte == 0)?;
    Some((&data[..index], &data[index + 1..]))
}

fn push_oversized_text(
    data: &[u8],
    chunk_name: &str,
    entries: &mut Vec<NativeEntry>,
    partial: &mut bool,
) -> bool {
    if data.len() <= MAX_TEXT_BYTES {
        return false;
    }
    let keyword = if let Some((keyword, _)) = split_once_nul(data) {
        png_keyword(keyword)
    } else {
        *partial = true;
        String::new()
    };
    entries.push(binary_entry(
        fallback_keyword(&keyword, chunk_name),
        data.len() as u64,
        Some(chunk_name),
    ));
    true
}

fn latin1(data: &[u8]) -> String {
    data.iter().map(|byte| char::from(*byte)).collect()
}

fn png_keyword(data: &[u8]) -> String {
    latin1(&data[..data.len().min(79)])
}

fn fallback_keyword(keyword: &str, fallback: &str) -> String {
    if keyword.trim().is_empty() {
        fallback.to_string()
    } else {
        keyword.to_string()
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
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0; 4]);
        chunk
    }

    #[test]
    fn walks_minimal_png_chunks() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
        png.extend(chunk(b"tEXt", b"prompt\0a turtle"));
        png.extend(chunk(b"IEND", &[]));

        let metadata = parse(&png);
        assert!(!metadata.partial);
        assert_eq!(metadata.groups.len(), 2);
        assert_eq!(metadata.groups[0].id, "ihdr");
        assert_eq!(metadata.groups[1].id, "text");
        assert_eq!(metadata.groups[1].entries[0].tag, "prompt");
        assert_eq!(metadata.groups[1].entries[0].value, "a turtle");
    }
}
