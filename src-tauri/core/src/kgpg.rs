#![allow(dead_code)]

use std::io::SeekFrom;
use std::path::Path;
use std::io;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// KGPG v2：固定头部 + ZIP（SFX 兼容）
///
/// 布局（固定大小）：
/// - meta: 64 bytes
/// - icon: 128*128 RGB24 raw bytes (49152 bytes)
/// - manifest: 4096 bytes（UTF-8 JSON，剩余 0 填充）
/// - zip: 从固定偏移开始（不要求解析 zip 才能取 icon/manifest）
pub const KGPG2_META_SIZE: usize = 64;
pub const KGPG2_ICON_W: u32 = 128;
pub const KGPG2_ICON_H: u32 = 128;
pub const KGPG2_ICON_BPP: usize = 3; // RGB24（无 alpha）
pub const KGPG2_ICON_SIZE: usize =
    (KGPG2_ICON_W as usize) * (KGPG2_ICON_H as usize) * KGPG2_ICON_BPP;
pub const KGPG2_MANIFEST_SLOT_SIZE: usize = 4096;
pub const KGPG2_TOTAL_HEADER_SIZE: usize =
    KGPG2_META_SIZE + KGPG2_ICON_SIZE + KGPG2_MANIFEST_SLOT_SIZE;

const MAGIC: &[u8; 4] = b"KGPG";
const VERSION: u16 = 2;

#[derive(Debug, Clone)]
pub struct Kgpg2Meta {
    pub flags: u8,
    pub manifest_len: u16,
}

impl Kgpg2Meta {
    pub fn icon_present(&self) -> bool {
        self.flags & 0b0000_0001 != 0
    }
    pub fn manifest_present(&self) -> bool {
        self.flags & 0b0000_0010 != 0
    }
}

fn read_u16_le(buf: &[u8], off: usize) -> Option<u16> {
    if off + 2 > buf.len() {
        return None;
    }
    Some(u16::from_le_bytes([buf[off], buf[off + 1]]))
}

fn parse_kgpg2_meta_bytes(meta: &[u8]) -> Option<Kgpg2Meta> {
    if meta.len() < KGPG2_META_SIZE {
        return None;
    }
    if &meta[0..4] != MAGIC {
        return None;
    }
    let ver = read_u16_le(&meta, 4).unwrap_or(0);
    // 版本协商：
    // - ver < 2：视为旧格式（回退 zip v1）
    // - ver >= 2：尽量按当前最高支持版本(v2)解析（如果头部布局不匹配，仍会回退）
    if ver < VERSION {
        return None;
    }
    let meta_size = read_u16_le(&meta, 6).unwrap_or(0) as usize;
    if meta_size != KGPG2_META_SIZE {
        return None;
    }

    // 固定布局字段
    let w = read_u16_le(&meta, 8).unwrap_or(0);
    let h = read_u16_le(&meta, 10).unwrap_or(0);
    if w as u32 != KGPG2_ICON_W || h as u32 != KGPG2_ICON_H {
        return None;
    }
    let pixel_format = meta[12]; // 1=RGB24
    if pixel_format != 1 {
        return None;
    }
    let flags = meta[13];
    let manifest_len = read_u16_le(&meta, 14).unwrap_or(0);
    if manifest_len as usize > KGPG2_MANIFEST_SLOT_SIZE {
        return None;
    }

    Some(Kgpg2Meta {
        flags,
        manifest_len,
    })
}

/// 解析 KGPG v2 meta（纯字节版，无 IO）。
pub fn read_kgpg2_meta_from_bytes(bytes: &[u8]) -> Option<Kgpg2Meta> {
    parse_kgpg2_meta_bytes(bytes)
}

/// 异步读取 KGPG v2 meta（不会移动到 zip 区域）。
pub async fn read_kgpg2_meta(path: &Path) -> io::Result<Option<Kgpg2Meta>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(SeekFrom::Start(0)).await?;
    let mut meta = [0u8; KGPG2_META_SIZE];
    if let Err(e) = f.read_exact(&mut meta).await {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(e);
    }
    Ok(parse_kgpg2_meta_bytes(&meta))
}

/// 纯字节读取 KGPG v2 icon（RGB24）。
pub fn read_kgpg2_icon_rgb_from_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let meta = parse_kgpg2_meta_bytes(bytes)?;
    if !meta.icon_present() {
        return Some(vec![]);
    }
    let start = KGPG2_META_SIZE;
    let end = start + KGPG2_ICON_SIZE;
    if bytes.len() < end {
        return None;
    }
    Some(bytes[start..end].to_vec())
}

/// 异步读取 KGPG v2 icon（RGB24）。
pub async fn read_kgpg2_icon_rgb(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(SeekFrom::Start(0)).await?;
    let mut bytes = vec![0u8; KGPG2_META_SIZE + KGPG2_ICON_SIZE];
    if let Err(e) = f.read_exact(&mut bytes).await {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(e);
    }
    Ok(read_kgpg2_icon_rgb_from_bytes(&bytes))
}

/// 纯字节读取 KGPG v2 manifest JSON。
pub fn read_kgpg2_manifest_json_from_bytes(bytes: &[u8]) -> Option<String> {
    let meta = parse_kgpg2_meta_bytes(bytes)?;
    if !meta.manifest_present() || meta.manifest_len == 0 {
        return Some(String::new());
    }
    let start = KGPG2_META_SIZE + KGPG2_ICON_SIZE;
    let end = start + KGPG2_MANIFEST_SLOT_SIZE;
    if bytes.len() < end {
        return None;
    }
    let slot = &bytes[start..end];
    let len = meta.manifest_len as usize;
    if len > slot.len() {
        return None;
    }
    Some(String::from_utf8_lossy(&slot[..len]).to_string())
}

/// 异步读取 KGPG v2 manifest JSON。
pub async fn read_kgpg2_manifest_json(path: &Path) -> io::Result<Option<String>> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(SeekFrom::Start(0)).await?;
    let mut bytes = vec![0u8; KGPG2_TOTAL_HEADER_SIZE];
    if let Err(e) = f.read_exact(&mut bytes).await {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(e);
    }
    Ok(read_kgpg2_manifest_json_from_bytes(&bytes))
}

/// 兼容别名：异步文件版。
pub async fn read_kgpg2_icon_rgb_from_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    read_kgpg2_icon_rgb(path).await
}

/// 兼容别名：异步文件版。
pub async fn read_kgpg2_manifest_json_from_file(path: &Path) -> io::Result<Option<String>> {
    read_kgpg2_manifest_json(path).await
}

// -------------------------
// 写入/打包（共用代码：Tauri/CLI/插件编辑器/Node 调用 CLI）
// -------------------------

/// 从 PNG 图标生成固定 `128x128 RGB24` 的 raw bytes（无 alpha）。
pub fn icon_png_to_rgb24_fixed(path: &Path) -> Result<Vec<u8>, String> {
    use image::imageops::FilterType;

    let img = image::open(path).map_err(|e| format!("读取 icon.png 失败: {}", e))?;
    let resized = img.resize_exact(KGPG2_ICON_W, KGPG2_ICON_H, FilterType::Lanczos3);
    let rgb = resized.to_rgb8().into_raw();
    if rgb.len() != KGPG2_ICON_SIZE {
        return Err(format!(
            "icon RGB 大小不符合预期：got={} expected={}",
            rgb.len(),
            KGPG2_ICON_SIZE
        ));
    }
    Ok(rgb)
}

/// 构造 KGPG v2 固定头部（长度恒为 `KGPG2_TOTAL_HEADER_SIZE`）。
///
/// - `icon_rgb24`：若为 None 或长度不正确，则视为 icon 不存在（写全 0）
/// - `manifest_json`：UTF-8 JSON bytes（长度必须 <= 4096）
pub fn build_kgpg2_header(
    icon_rgb24: Option<&[u8]>,
    manifest_json: &[u8],
) -> Result<Vec<u8>, String> {
    if manifest_json.len() > KGPG2_MANIFEST_SLOT_SIZE {
        return Err(format!(
            "manifest 槽位超限：{} bytes（上限 {}）",
            manifest_json.len(),
            KGPG2_MANIFEST_SLOT_SIZE
        ));
    }

    let icon_ok = icon_rgb24
        .map(|b| b.len() == KGPG2_ICON_SIZE)
        .unwrap_or(false);
    let flags: u8 = (if icon_ok { 0b0000_0001 } else { 0 }) | 0b0000_0010; // manifest_present

    let mut header = vec![0u8; KGPG2_TOTAL_HEADER_SIZE];
    // meta
    header[0..4].copy_from_slice(MAGIC);
    header[4..6].copy_from_slice(&VERSION.to_le_bytes()); // version
    header[6..8].copy_from_slice(&(KGPG2_META_SIZE as u16).to_le_bytes()); // meta_size
    header[8..10].copy_from_slice(&(KGPG2_ICON_W as u16).to_le_bytes()); // w
    header[10..12].copy_from_slice(&(KGPG2_ICON_H as u16).to_le_bytes()); // h
    header[12] = 1; // pixel_format: 1=RGB24
    header[13] = flags;
    header[14..16].copy_from_slice(&(manifest_json.len() as u16).to_le_bytes());
    header[16..24].copy_from_slice(&(KGPG2_TOTAL_HEADER_SIZE as u64).to_le_bytes()); // zip_offset（预留）

    // icon slot
    if icon_ok {
        let off = KGPG2_META_SIZE;
        header[off..off + KGPG2_ICON_SIZE].copy_from_slice(icon_rgb24.unwrap());
    }

    // manifest slot
    let manifest_off = KGPG2_META_SIZE + KGPG2_ICON_SIZE;
    header[manifest_off..manifest_off + manifest_json.len()].copy_from_slice(manifest_json);
    Ok(header)
}

/// 写出最终 `.kgpg` 文件：`header + zip_bytes`
/// - 为了避免中途失败留下半文件，使用 `.tmp` 再 rename。
pub fn write_kgpg2_from_zip_bytes(
    output_path: &Path,
    header: &[u8],
    zip_bytes: &[u8],
) -> Result<(), String> {
    if header.len() != KGPG2_TOTAL_HEADER_SIZE {
        return Err(format!(
            "header 大小错误：got={} expected={}",
            header.len(),
            KGPG2_TOTAL_HEADER_SIZE
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
