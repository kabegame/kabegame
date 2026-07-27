use super::{NativeEntry, NativeGroup};
use exif::{Context, In, Tag, Value};

const LONG_VALUE_CHARS: usize = 120;
const MAX_VALUE_CHARS: usize = 4096;

pub(super) fn exif_groups(exif: &exif::Exif) -> Vec<NativeGroup> {
    let mut image = Vec::new();
    let mut capture = Vec::new();
    let mut gps = Vec::new();
    let mut thumbnail = Vec::new();
    let mut misc = Vec::new();

    for field in exif.fields() {
        let entry = field_entry(field, exif);
        let target = if field.ifd_num == In::THUMBNAIL {
            &mut thumbnail
        } else if field.tag == Tag::MakerNote || field.tag.description().is_none() {
            &mut misc
        } else {
            match field.tag.context() {
                Context::Gps => &mut gps,
                Context::Exif => &mut capture,
                Context::Tiff => &mut image,
                _ => &mut misc,
            }
        };
        target.push(entry);
    }

    let mut groups = Vec::new();
    push_group(&mut groups, "image", "IFD0 · Primary", image);
    push_group(&mut groups, "capture", "Exif IFD", capture);
    push_group(&mut groups, "gps", "GPS IFD", gps);
    push_group(&mut groups, "thumbnail", "IFD1 · Thumbnail", thumbnail);
    push_group(&mut groups, "misc", "MakerNote · Unknown", misc);
    groups
}

fn field_entry(field: &exif::Field, exif: &exif::Exif) -> NativeEntry {
    let tag = if field.tag.description().is_some() {
        field.tag.to_string()
    } else {
        format!("Tag(0x{:04X})", field.tag.number())
    };

    let binary_len = match &field.value {
        Value::Undefined(data, _)
            if field.tag == Tag::MakerNote || data.len() > MAX_VALUE_CHARS =>
        {
            Some(data.len() as u64)
        }
        _ => None,
    };
    if let Some(byte_len) = binary_len {
        return NativeEntry {
            tag,
            value: format!("<{byte_len} bytes>"),
            note: None,
            long: false,
            byte_len: Some(byte_len),
        };
    }

    let value = field.display_value().with_unit(exif).to_string();
    let char_count = value.chars().count();
    let long = char_count > LONG_VALUE_CHARS;
    let (value, note) = if char_count > MAX_VALUE_CHARS {
        (
            value.chars().take(MAX_VALUE_CHARS).collect(),
            Some(format!("Truncated from {char_count} characters")),
        )
    } else {
        (value, None)
    };

    NativeEntry {
        tag,
        value,
        note,
        long,
        byte_len: None,
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
