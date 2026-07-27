use super::JpegNativeMetadata;
use exif::Error;
use std::io::Cursor;

pub(super) fn parse(bytes: &[u8]) -> JpegNativeMetadata {
    let mut cursor = Cursor::new(bytes);
    let exif = match exif::Reader::new().read_from_container(&mut cursor) {
        Ok(exif) => exif,
        Err(Error::NotFound(_)) => {
            return JpegNativeMetadata {
                partial: false,
                groups: Vec::new(),
            };
        }
        Err(_) => {
            return JpegNativeMetadata {
                partial: true,
                groups: Vec::new(),
            };
        }
    };

    JpegNativeMetadata {
        partial: false,
        groups: super::exif_common::exif_groups(&exif),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn jpeg_without_exif_is_empty_not_partial() {
        let jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9";
        let metadata = parse(jpeg);
        assert!(!metadata.partial);
        assert!(metadata.groups.is_empty());
    }
}
