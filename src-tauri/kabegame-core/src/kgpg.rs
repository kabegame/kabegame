#![allow(dead_code)]

use std::io::Read;
use std::path::Path;
use tokio::io::AsyncReadExt;

/// KGPG v3：固定头部 + ZIP（SFX 兼容）
///
/// 布局（固定大小）：
/// - meta: 64 bytes
/// - icon: 128*128 RGB24 raw bytes (49152 bytes)
/// - zip: 从偏移 49216 开始
pub const KGPG3_META_SIZE: usize = 64;
pub const KGPG3_ICON_W: u32 = 128;
pub const KGPG3_ICON_H: u32 = 128;
pub const KGPG3_ICON_BPP: usize = 3; // RGB24（无 alpha）
pub const KGPG3_ICON_SIZE: usize =
    (KGPG3_ICON_W as usize) * (KGPG3_ICON_H as usize) * KGPG3_ICON_BPP;
pub const KGPG3_TOTAL_HEADER_SIZE: usize = KGPG3_META_SIZE + KGPG3_ICON_SIZE;

const MAGIC: &[u8; 4] = b"KGPG";
const VERSION: u16 = 3;

#[derive(Debug, Clone)]
pub struct Kgpg3Meta {
    pub flags: u8,
}

impl Kgpg3Meta {
    pub fn icon_present(&self) -> bool {
        self.flags & 0b0000_0001 != 0
    }
}

fn read_u16_le(buf: &[u8], off: usize) -> Option<u16> {
    if off + 2 > buf.len() {
        return None;
    }
    Some(u16::from_le_bytes([buf[off], buf[off + 1]]))
}

fn parse_kgpg3_meta_bytes(meta: &[u8]) -> Result<Kgpg3Meta, String> {
    if meta.len() < KGPG3_META_SIZE {
        return Err(format!("非法 KGPG 包：头部不足 {} 字节", KGPG3_META_SIZE));
    }
    if &meta[0..4] != MAGIC {
        return Err("非法 KGPG 包：magic 必须为 KGPG".to_string());
    }
    let ver = read_u16_le(&meta, 4).unwrap_or(0);
    if ver != VERSION {
        let relation = if ver < VERSION { "过低" } else { "过高" };
        return Err(format!(
            "非法 KGPG 包：容器版本 {ver} {relation}，仅支持版本 {VERSION}"
        ));
    }
    let meta_size = read_u16_le(&meta, 6).unwrap_or(0) as usize;
    if meta_size != KGPG3_META_SIZE {
        return Err(format!(
            "非法 KGPG 包：meta_size 为 {meta_size}，应为 {}",
            KGPG3_META_SIZE
        ));
    }

    // 固定布局字段
    let w = read_u16_le(&meta, 8).unwrap_or(0);
    let h = read_u16_le(&meta, 10).unwrap_or(0);
    if w as u32 != KGPG3_ICON_W || h as u32 != KGPG3_ICON_H {
        return Err(format!(
            "非法 KGPG 包：icon 尺寸为 {w}x{h}，应为 {}x{}",
            KGPG3_ICON_W, KGPG3_ICON_H
        ));
    }
    let pixel_format = meta[12]; // 1=RGB24
    if pixel_format != 1 {
        return Err(format!(
            "非法 KGPG 包：pixel_format 为 {pixel_format}，应为 1 (RGB24)"
        ));
    }
    let flags = meta[13];
    let zip_offset = u64::from_le_bytes(
        meta[16..24]
            .try_into()
            .map_err(|_| "非法 KGPG 包：缺少 zip_offset".to_string())?,
    );
    if zip_offset != KGPG3_TOTAL_HEADER_SIZE as u64 {
        return Err(format!(
            "非法 KGPG 包：zip_offset 为 {zip_offset}，应为 {}",
            KGPG3_TOTAL_HEADER_SIZE
        ));
    }

    Ok(Kgpg3Meta { flags })
}

/// 解析 KGPG v3 meta（纯字节版，无 IO）。
pub fn read_kgpg3_meta_from_bytes(bytes: &[u8]) -> Result<Kgpg3Meta, String> {
    parse_kgpg3_meta_bytes(bytes)
}

/// 异步读取并验证 KGPG v3 meta（不会移动到 zip 区域）。
pub async fn read_kgpg3_meta(path: &Path) -> Result<Kgpg3Meta, String> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("打开 KGPG 文件失败 {}: {e}", path.display()))?;
    let mut meta = [0u8; KGPG3_META_SIZE];
    f.read_exact(&mut meta)
        .await
        .map_err(|e| format!("读取 KGPG v3 头部失败: {e}"))?;
    parse_kgpg3_meta_bytes(&meta)
}

/// 同步读取并验证 KGPG v3 meta。
pub fn read_kgpg3_meta_sync(path: &Path) -> Result<Kgpg3Meta, String> {
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("打开 KGPG 文件失败 {}: {e}", path.display()))?;
    let mut meta = [0u8; KGPG3_META_SIZE];
    f.read_exact(&mut meta)
        .map_err(|e| format!("读取 KGPG v3 头部失败: {e}"))?;
    parse_kgpg3_meta_bytes(&meta)
}

/// 纯字节读取 KGPG v3 icon（RGB24）。
pub fn read_kgpg3_icon_rgb_from_bytes(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let meta = parse_kgpg3_meta_bytes(bytes)?;
    if !meta.icon_present() {
        return Ok(None);
    }
    let start = KGPG3_META_SIZE;
    let end = start + KGPG3_ICON_SIZE;
    if bytes.len() < end {
        return Err(format!("非法 KGPG 包：头部不足 {end} 字节"));
    }
    Ok(Some(bytes[start..end].to_vec()))
}

/// 异步读取 KGPG v3 icon（RGB24）。
pub async fn read_kgpg3_icon_rgb(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("打开 KGPG 文件失败 {}: {e}", path.display()))?;
    let mut bytes = vec![0u8; KGPG3_TOTAL_HEADER_SIZE];
    f.read_exact(&mut bytes)
        .await
        .map_err(|e| format!("读取 KGPG v3 头部失败: {e}"))?;
    read_kgpg3_icon_rgb_from_bytes(&bytes)
}

// -------------------------
// 写入/打包（共用代码：Tauri/CLI/插件编辑器/Node 调用 CLI）
// -------------------------

/// 从 PNG 图标生成固定 `128x128 RGB24` 的 raw bytes（无 alpha）。
pub fn icon_png_to_rgb24_fixed(path: &Path) -> Result<Vec<u8>, String> {
    use image::imageops::FilterType;

    let img = image::open(path).map_err(|e| format!("读取 icon.png 失败: {}", e))?;
    let resized = img.resize_exact(KGPG3_ICON_W, KGPG3_ICON_H, FilterType::Lanczos3);
    let rgb = resized.to_rgb8().into_raw();
    if rgb.len() != KGPG3_ICON_SIZE {
        return Err(format!(
            "icon RGB 大小不符合预期：got={} expected={}",
            rgb.len(),
            KGPG3_ICON_SIZE
        ));
    }
    Ok(rgb)
}

/// 构造 KGPG v3 固定头部（长度恒为 `KGPG3_TOTAL_HEADER_SIZE`）。
///
/// - `icon_rgb24`：若为 None 或长度不正确，则视为 icon 不存在（写全 0）
pub fn build_kgpg3_header(icon_rgb24: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let icon_ok = icon_rgb24
        .map(|b| b.len() == KGPG3_ICON_SIZE)
        .unwrap_or(false);
    let flags: u8 = if icon_ok { 0b0000_0001 } else { 0 };

    let mut header = vec![0u8; KGPG3_TOTAL_HEADER_SIZE];
    // meta
    header[0..4].copy_from_slice(MAGIC);
    header[4..6].copy_from_slice(&VERSION.to_le_bytes()); // version
    header[6..8].copy_from_slice(&(KGPG3_META_SIZE as u16).to_le_bytes()); // meta_size
    header[8..10].copy_from_slice(&(KGPG3_ICON_W as u16).to_le_bytes()); // w
    header[10..12].copy_from_slice(&(KGPG3_ICON_H as u16).to_le_bytes()); // h
    header[12] = 1; // pixel_format: 1=RGB24
    header[13] = flags;
    header[16..24].copy_from_slice(&(KGPG3_TOTAL_HEADER_SIZE as u64).to_le_bytes()); // zip_offset

    // icon slot
    if icon_ok {
        let off = KGPG3_META_SIZE;
        header[off..off + KGPG3_ICON_SIZE].copy_from_slice(icon_rgb24.unwrap());
    }

    Ok(header)
}

/// 写出最终 `.kgpg` 文件：`header + zip_bytes`
/// - 为了避免中途失败留下半文件，使用 `.tmp` 再 rename。
pub fn write_kgpg3_from_zip_bytes(
    output_path: &Path,
    header: &[u8],
    zip_bytes: &[u8],
) -> Result<(), String> {
    if header.len() != KGPG3_TOTAL_HEADER_SIZE {
        return Err(format!(
            "header 大小错误：got={} expected={}",
            header.len(),
            KGPG3_TOTAL_HEADER_SIZE
        ));
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
    }

    let tmp = output_path.with_extension("kgpg.tmp");
    {
        use std::io::Write;
        let mut out =
            std::fs::File::create(&tmp).map_err(|e| format!("创建输出文件失败: {}", e))?;
        out.write_all(header)
            .map_err(|e| format!("写入 KGPG 头部失败: {}", e))?;
        out.write_all(zip_bytes)
            .map_err(|e| format!("写入 ZIP 数据失败: {}", e))?;
        let _ = out.flush();
    }

    // Windows 覆盖行为不一致：先删再 rename
    if output_path.exists() {
        let _ = std::fs::remove_file(output_path);
    }
    std::fs::rename(&tmp, output_path).map_err(|e| format!("完成输出失败: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kgpg3_header_has_exact_layout() {
        let icon = vec![0x5a; KGPG3_ICON_SIZE];
        let header = build_kgpg3_header(Some(&icon)).unwrap();

        assert_eq!(header.len(), 49_216);
        assert_eq!(&header[0..4], b"KGPG");
        assert_eq!(u16::from_le_bytes(header[4..6].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(header[6..8].try_into().unwrap()), 64);
        assert_eq!(u16::from_le_bytes(header[8..10].try_into().unwrap()), 128);
        assert_eq!(u16::from_le_bytes(header[10..12].try_into().unwrap()), 128);
        assert_eq!(header[12], 1);
        assert_eq!(header[13], 1);
        assert_eq!(
            u64::from_le_bytes(header[16..24].try_into().unwrap()),
            49_216
        );
        assert_eq!(&header[64..49_216], icon.as_slice());
        assert!(read_kgpg3_meta_from_bytes(&header).unwrap().icon_present());
    }

    #[test]
    fn kgpg3_parser_rejects_every_other_container_version() {
        for version in [0, 1, 2, 4, u16::MAX] {
            let mut header = build_kgpg3_header(None).unwrap();
            header[4..6].copy_from_slice(&version.to_le_bytes());
            let error = read_kgpg3_meta_from_bytes(&header).unwrap_err();
            assert!(error.contains("仅支持版本 3"), "{error}");
        }
    }
}
