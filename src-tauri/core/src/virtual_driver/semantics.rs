//! 虚拟盘"文件系统语义/原语"层（不依赖 Dokan/Win32）。
//!
//! 目标：
//! - 提供跨平台的文件系统操作语义：read_dir/read_file/create_dir/delete/rename 等。
//! - 平台层（Windows Dokan handler）只负责把平台参数映射到这些原语，并将结果映射回平台返回值。
//! - 目录树通过 pathql `/vd/i18n-*/...` DSL 解析，图片文件由叶子 provider 的 fetch 行生成。

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pathql_rs::compose::ProviderQuery;
use pathql_rs::ProviderRuntime;
use serde_json::Value;

use crate::storage::HIDDEN_ALBUM_ID;

/// VD 路径解析结果（virtual_driver 专用）。
pub enum ResolveResult {
    Directory {
        composed: ProviderQuery,
    },
    File {
        image_id: String,
        resolved_path: PathBuf,
        hidden: bool,
    },
    NotFound,
}

use super::virtual_drive_io::{VdFileMeta, VdReadHandle};

fn is_shell_probe_file(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "desktop.ini" | "thumbs.db" | "folder.jpg" | "folder.png" | "autorun.inf"
    )
}

#[derive(Debug, Clone)]
pub struct VfsMetadata {
    pub is_dir: bool,
    pub size: u64,
    pub created: SystemTime,
    pub accessed: SystemTime,
    pub modified: SystemTime,
}

#[derive(Debug, Clone)]
pub enum VfsEntry {
    Directory {
        name: String,
        meta: VfsMetadata,
        hidden: bool,
    },
    File {
        name: String,
        image_id: String,
        resolved_path: PathBuf,
        meta: VfsMetadata,
        hidden: bool,
    },
}

impl VfsEntry {
    pub fn name(&self) -> &str {
        match self {
            VfsEntry::Directory { name, .. } => name,
            VfsEntry::File { name, .. } => name,
        }
    }
}

#[derive(Debug, Clone)]
pub enum VfsOpenedItem {
    Directory {
        path: Vec<String>,
        hidden: bool,
    },
    File {
        path: Vec<String>,
        image_id: String,
        resolved_path: PathBuf,
        size: u64,
        meta: VdFileMeta,
        read_handle: Arc<VdReadHandle>,
        hidden: bool,
    },
}

#[derive(Debug, Clone)]
pub enum VfsError {
    NotFound(String),
    NotADirectory(String),
    AccessDenied(String),
    AlreadyExists(String),
    InvalidParameter(String),
    Other(String),
}

impl VfsError {
    pub fn message(&self) -> &str {
        match self {
            VfsError::NotFound(s)
            | VfsError::NotADirectory(s)
            | VfsError::AccessDenied(s)
            | VfsError::AlreadyExists(s)
            | VfsError::InvalidParameter(s)
            | VfsError::Other(s) => s,
        }
    }
}

fn now() -> SystemTime {
    SystemTime::now()
}

#[derive(Debug, Clone)]
struct VdImageEntry {
    id: String,
    local_path: String,
    display_name: String,
    media_type: String,
    is_hidden: bool,
    crawled_at: u64,
}

/// app-main 的虚拟盘语义执行器：基于 pathql Provider 树实现"文件系统操作语义"。
pub struct VfsSemantics<'a> {
    provider_rt: &'a ProviderRuntime,
}

impl<'a> VfsSemantics<'a> {
    pub fn new(provider_rt: &'a ProviderRuntime) -> Self {
        Self { provider_rt }
    }

    pub(crate) fn is_vd_segment_canonical(&self, segment: &str, canonical_i18n_key: &str) -> bool {
        kabegame_i18n::vd_display_name(canonical_i18n_key) == segment
    }

    pub fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    fn locale_route_segment() -> &'static str {
        match kabegame_i18n::current_vd_locale() {
            "zh" => "i18n-zh_CN",
            "zhtw" => "i18n-zhtw",
            "ja" => "i18n-ja",
            "ko" => "i18n-ko",
            "en" | _ => "i18n-en_US",
        }
    }

    fn vd_path(&self, segments: &[&str]) -> String {
        let mut path = format!("/vd/{}", Self::locale_route_segment());
        for segment in segments {
            path.push('/');
            path.push_str(segment);
        }
        path
    }

    fn image_entry_file_name(image: &VdImageEntry) -> String {
        if image.media_type == "text/plain" && !image.display_name.trim().is_empty() {
            let name = image.display_name.trim();
            if name.ends_with(".txt") {
                return sanitize_file_name(name);
            }
            return sanitize_file_name(&format!("{name}.txt"));
        }

        let ext = Path::new(&image.local_path)
            .extension()
            .and_then(|e| e.to_str())
            .filter(|e| !e.trim().is_empty())
            .unwrap_or("bin");
        sanitize_file_name(&format!("{}.{}", image.id, ext))
    }

    fn image_entries_at(&self, segments: &[&str]) -> Result<Vec<VdImageEntry>, VfsError> {
        let path = self.vd_path(segments);
        let node = self
            .provider_rt
            .resolve(&path)
            .map_err(|e| VfsError::Other(e.to_string()))?;
        if node.composed.from.is_none() || node.composed.limit.is_none() {
            return Ok(Vec::new());
        }

        let rows = self
            .provider_rt
            .fetch(&path)
            .map_err(|e| VfsError::Other(e.to_string()))?;
        Ok(rows.iter().filter_map(vd_image_entry_from_row).collect())
    }

    fn image_entry_from_parent(
        &self,
        parent_segs: &[&str],
        file_name: &str,
    ) -> Option<VdImageEntry> {
        self.image_entries_at(parent_segs)
            .ok()?
            .into_iter()
            .find(|image| Self::image_entry_file_name(image) == file_name)
    }

    /// 解析路径：目录走 pathql resolve，文件走父目录 fetch 后按虚拟文件名反查。
    pub fn resolve_cached(&self, segments: &[&str]) -> ResolveResult {
        let is_likely_file = segments.last().map(|s| s.contains('.')).unwrap_or(false);
        if segments
            .last()
            .map(|name| is_shell_probe_file(name))
            .unwrap_or(false)
        {
            return ResolveResult::NotFound;
        }
        if is_likely_file && segments.len() >= 2 {
            let parent_segs = &segments[..segments.len() - 1];
            let file_name = segments[segments.len() - 1];
            if let Some(image) = self.image_entry_from_parent(parent_segs, file_name) {
                return ResolveResult::File {
                    image_id: image.id,
                    resolved_path: PathBuf::from(image.local_path),
                    hidden: image.is_hidden,
                };
            }
        }

        let vd_path = self.vd_path(segments);
        if let Ok(node) = self.provider_rt.resolve(&vd_path) {
            return ResolveResult::Directory {
                composed: node.composed,
            };
        }

        if !segments.is_empty() {
            let parent_segs = &segments[..segments.len().saturating_sub(1)];
            let file_name = segments[segments.len() - 1];
            if let Some(image) = self.image_entry_from_parent(parent_segs, file_name) {
                return ResolveResult::File {
                    image_id: image.id,
                    resolved_path: PathBuf::from(image.local_path),
                    hidden: image.is_hidden,
                };
            }
        }

        ResolveResult::NotFound
    }

    pub fn open_existing(&self, path: &[String]) -> Result<VfsOpenedItem, VfsError> {
        if path.is_empty() {
            return Ok(VfsOpenedItem::Directory {
                path: Vec::new(),
                hidden: false,
            });
        }
        let segs = Self::path_to_segments(path);
        match self.resolve_cached(&segs) {
            ResolveResult::Directory { .. } => Ok(VfsOpenedItem::Directory {
                path: path.to_vec(),
                hidden: false,
            }),
            ResolveResult::File {
                image_id,
                resolved_path,
                hidden,
            } => {
                let (handle, meta) = VdReadHandle::open(&resolved_path)
                    .map_err(|_| VfsError::NotFound("文件不存在".to_string()))?;
                let size = handle.len();
                Ok(VfsOpenedItem::File {
                    path: path.to_vec(),
                    image_id,
                    resolved_path,
                    size,
                    meta,
                    read_handle: Arc::new(handle),
                    hidden,
                })
            }
            ResolveResult::NotFound => Err(VfsError::NotFound("路径不存在".to_string())),
        }
    }

    pub fn read_dir(&self, path: &[String]) -> Result<Vec<VfsEntry>, VfsError> {
        let segments = Self::path_to_segments(path);
        match self.resolve_cached(&segments) {
            ResolveResult::Directory { .. } => {}
            ResolveResult::File { .. } => {
                return Err(VfsError::NotADirectory("目标不是目录".to_string()))
            }
            ResolveResult::NotFound => return Err(VfsError::NotFound("路径不存在".to_string())),
        }

        let vd_path = self.vd_path(&segments);
        let children = self
            .provider_rt
            .list(&vd_path)
            .map_err(|e| VfsError::Other(e.to_string()))?;
        let images = self.image_entries_at(&segments)?;

        let mut out = Vec::with_capacity(children.len() + images.len());
        for child in children {
            let t = now();
            out.push(VfsEntry::Directory {
                hidden: child_meta_is_hidden_album(&child.meta),
                name: child.name,
                meta: VfsMetadata {
                    is_dir: true,
                    size: 0,
                    created: t,
                    accessed: t,
                    modified: t,
                },
            });
        }

        for image in images {
            let resolved_path = PathBuf::from(&image.local_path);
            let Ok(meta) = std::fs::metadata(&resolved_path) else {
                continue;
            };
            let (created, accessed, modified) = if image.crawled_at > 0 {
                let t = system_time_from_gallery_ts(image.crawled_at);
                (t, t, t)
            } else {
                system_time_from_fs_metadata(&meta)
            };
            out.push(VfsEntry::File {
                name: Self::image_entry_file_name(&image),
                image_id: image.id,
                resolved_path,
                meta: VfsMetadata {
                    is_dir: false,
                    size: meta.len(),
                    created,
                    accessed,
                    modified,
                },
                hidden: image.is_hidden,
            });
        }

        Ok(out)
    }

    pub fn read_file(
        &self,
        read_handle: &Arc<VdReadHandle>,
        offset: u64,
        buffer: &mut [u8],
    ) -> Result<usize, VfsError> {
        read_handle
            .read_at(offset, buffer)
            .map_err(|e| VfsError::Other(e))
    }

    /// VD 为只读文件系统 — 所有写操作返回 AccessDenied。
    pub fn create_dir(&self, _parent_path: &[String], _dir_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "虚拟盘为只读，不支持创建目录".to_string(),
        ))
    }

    pub fn create_file(&self, _path: &[String]) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "虚拟盘为只读，不支持创建文件".to_string(),
        ))
    }

    pub fn can_delete_child_at(
        &self,
        _parent_path: &[String],
        _name: &str,
    ) -> Result<bool, VfsError> {
        Ok(false)
    }

    pub fn commit_delete_child_at(
        &self,
        _parent_path: &[String],
        _name: &str,
    ) -> Result<bool, VfsError> {
        Ok(false)
    }

    pub fn rename_dir(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "虚拟盘为只读，不支持重命名".to_string(),
        ))
    }

    pub fn rename_file(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持重命名文件".to_string(),
        ))
    }
}

// 一些 helper（虽然 stub 不用，但 fuse.rs / windows.rs 可能引用）
fn normalize_unix_secs(ts: u64) -> u64 {
    const MAX_SEC_9999: u64 = 253402300799;
    if ts > MAX_SEC_9999 {
        ts / 1000
    } else {
        ts
    }
}

fn system_time_from_gallery_ts(ts: u64) -> SystemTime {
    let secs = normalize_unix_secs(ts);
    UNIX_EPOCH
        .checked_add(Duration::from_secs(secs))
        .unwrap_or_else(now)
}

fn system_time_from_fs_metadata(meta: &std::fs::Metadata) -> (SystemTime, SystemTime, SystemTime) {
    let created = meta.created().unwrap_or(UNIX_EPOCH);
    let accessed = meta.accessed().unwrap_or(created);
    let modified = meta.modified().unwrap_or(accessed);
    (created, accessed, modified)
}

fn sanitize_file_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => out.push('_'),
            c if c.is_control() => out.push('_'),
            c => out.push(c),
        }
    }
    let trimmed = out.trim_matches([' ', '.']).trim();
    if trimmed.is_empty() {
        "unnamed.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn json_string(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|i| i.to_string()))
            .or_else(|| v.as_u64().map(|i| i.to_string()))
    })
}

fn json_u64(row: &Value, key: &str) -> Option<u64> {
    row.get(key).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().and_then(|i| u64::try_from(i).ok()))
            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
    })
}

fn json_bool(row: &Value, key: &str) -> bool {
    match row.get(key) {
        Some(Value::Bool(v)) => *v,
        Some(v) => v.as_i64().unwrap_or(0) != 0,
        None => false,
    }
}

fn vd_image_entry_from_row(row: &Value) -> Option<VdImageEntry> {
    Some(VdImageEntry {
        id: json_string(row, "id")?,
        local_path: json_string(row, "local_path")?,
        display_name: json_string(row, "display_name").unwrap_or_default(),
        media_type: json_string(row, "media_type").unwrap_or_else(|| "image".to_string()),
        is_hidden: json_bool(row, "is_hidden"),
        crawled_at: json_u64(row, "crawled_at").unwrap_or(0),
    })
}

fn child_meta_is_hidden_album(meta: &Option<Value>) -> bool {
    fn has_hidden_id(value: &Value) -> bool {
        match value {
            Value::String(s) => s == HIDDEN_ALBUM_ID,
            Value::Array(items) => items.iter().any(has_hidden_id),
            Value::Object(map) => {
                map.get("id").is_some_and(has_hidden_id)
                    || map.get("album_id").is_some_and(has_hidden_id)
                    || map.get("albumId").is_some_and(has_hidden_id)
                    || map.get("data").is_some_and(has_hidden_id)
            }
            _ => false,
        }
    }

    meta.as_ref().is_some_and(has_hidden_id)
}
