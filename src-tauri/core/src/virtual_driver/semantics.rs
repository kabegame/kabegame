//! 虚拟盘"文件系统语义/原语"层（不依赖 Dokan/Win32）。
//!
//! 目标：
//! - 提供跨平台的文件系统操作语义：read_dir/read_file/create_dir/delete/rename 等。
//! - 平台层（Windows Dokan handler）只负责把平台参数映射到这些原语，并将结果映射回平台返回值。

#![allow(dead_code)]

use std::{
    path::Path,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    providers::provider::{ChildEntry, ImageEntry, Provider, ProviderMeta},
    providers::ProviderRuntime,
    storage::gallery::ImageQuery,
    storage::{Storage, HIDDEN_ALBUM_ID},
};

/// VD 路径解析结果（virtual_driver 专用）。
pub enum ResolveResult {
    Directory {
        provider: Arc<dyn Provider>,
        composed: ImageQuery,
    },
    File {
        image_id: String,
        resolved_path: PathBuf,
        hidden: bool,
    },
    NotFound,
}

#[cfg(kabegame_mode = "standard")]
use super::virtual_drive_io::{VdFileMeta, VdReadHandle};

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

fn normalize_unix_secs(ts: u64) -> u64 {
    // 与 SQL 中的时间戳兼容逻辑保持一致：
    // - 若大于 9999-12-31 的秒级阈值，则认为是毫秒时间戳，降为秒
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

// TODO: 非windows可能返回不同的结果
fn system_time_from_fs_metadata(meta: &std::fs::Metadata) -> (SystemTime, SystemTime, SystemTime) {
    let created = meta.created().unwrap_or(UNIX_EPOCH);
    let accessed = meta.accessed().unwrap_or(created);
    let modified = meta.modified().unwrap_or(accessed);
    (created, accessed, modified)
}

/// app-main 的虚拟盘语义执行器：基于 core 的 Provider 树实现"文件系统操作语义"。
pub struct VfsSemantics<'a> {
    provider_rt: &'a ProviderRuntime,
}

impl<'a> VfsSemantics<'a> {
    pub fn new(provider_rt: &'a ProviderRuntime) -> Self {
        Self { provider_rt }
    }

    /// 检查第一个 VD 路径段是否对应某 canonical 类别（如 "task"/"album"）。
    pub(crate) fn is_vd_segment_canonical(&self, segment: &str, canonical_i18n_key: &str) -> bool {
        kabegame_i18n::vd_display_name(canonical_i18n_key) == segment
    }

    pub fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    fn vd_path(&self, segments: &[&str]) -> String {
        if segments.is_empty() {
            "vd".to_string()
        } else {
            format!("vd/{}", segments.join("/"))
        }
    }

    fn image_entry_file_name(image: &ImageEntry) -> String {
        if image.media_type.as_deref() == Some("text/plain") && !image.display_name.trim().is_empty()
        {
            let n = image.display_name.trim();
            if n.ends_with(".txt") {
                return n.to_string();
            }
            return format!("{}.txt", n);
        }
        let ext = Path::new(&image.local_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        format!("{}.{}", image.id, ext)
    }

    /// 通过父路径和文件名查找匹配的 ImageEntry。
    fn image_entry_from_parent(
        &self,
        parent_segs: &[&str],
        file_name: &str,
    ) -> Option<ImageEntry> {
        let vd_path = self.vd_path(parent_segs);
        let node = self.provider_rt.resolve(&vd_path).ok()??;
        let composed = if node.composed.order_bys.is_empty() {
            node.composed.clone().with_order("images.id ASC")
        } else {
            node.composed.clone()
        };
        let images = node.provider.list_images(&composed).ok()?;
        for image in images {
            if Self::image_entry_file_name(&image) != file_name {
                continue;
            }
            if std::fs::metadata(&image.local_path).is_ok() {
                return Some(image);
            }
        }
        None
    }

    /// 解析路径：最长前缀回退 + list 刷新
    pub fn resolve_cached(&self, segments: &[&str]) -> ResolveResult {
        if segments.is_empty() {
            let vd_path = self.vd_path(segments);
            return match self.provider_rt.resolve(&vd_path) {
                Ok(Some(node)) => ResolveResult::Directory {
                    provider: node.provider,
                    composed: node.composed,
                },
                _ => ResolveResult::NotFound,
            };
        }

        // 如果最后一段看起来像文件名（包含 '.'），优先尝试文件解析，避免被误判为目录
        let is_likely_file = segments.last().map(|s| s.contains('.')).unwrap_or(false);

        if is_likely_file && segments.len() >= 2 {
            // 文件：优先用 parent.list_images() 的 Image 条目解析
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

        // 目录：尝试把完整 segments 解析成 provider
        let vd_path = self.vd_path(segments);
        if let Ok(Some(node)) = self.provider_rt.resolve(&vd_path) {
            return ResolveResult::Directory {
                provider: node.provider,
                composed: node.composed,
            };
        }

        // 文件（兜底）：当目录解析失败时，再尝试（支持无扩展名的说明文件）
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

    /// 打开（仅支持 open existing；创建由 create_* 原语处理）
    pub fn open_existing(&self, path: &[String]) -> Result<VfsOpenedItem, VfsError> {
        let segs: Vec<&str> = Self::path_to_segments(path);
        match self.resolve_cached(&segs) {
            ResolveResult::Directory { provider, .. } => {
                let hidden = matches!(
                    provider.get_meta(),
                    Some(ProviderMeta::Album(ref a)) if a.id == HIDDEN_ALBUM_ID
                );
                Ok(VfsOpenedItem::Directory {
                    path: path.to_vec(),
                    hidden,
                })
            }
            ResolveResult::File {
                image_id,
                resolved_path,
                hidden,
            } => {
                let (handle, meta) = VdReadHandle::open(&resolved_path)
                    .map_err(|_| VfsError::NotFound("文件不存在".to_string()))?;
                let size = handle.len();
                // 文件时间戳与画廊数据一致：优先取 DB 的 COALESCE(order, crawled_at)。
                let meta = Storage::global()
                    .get_images_gallery_ts_by_ids(&[image_id.clone()])
                    .ok()
                    .and_then(|m| m.get(&image_id).copied())
                    .map(|ts| {
                        let t = system_time_from_gallery_ts(ts);
                        VdFileMeta {
                            created: t,
                            accessed: t,
                            modified: t,
                        }
                    })
                    .unwrap_or(meta);
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
        let (provider, composed) = match self.resolve_cached(&segments) {
            ResolveResult::Directory { provider, composed } => (provider, composed),
            ResolveResult::File { .. } => {
                return Err(VfsError::NotADirectory("目标不是目录".to_string()))
            }
            ResolveResult::NotFound => return Err(VfsError::NotFound("路径不存在".to_string())),
        };

        // 使用新 API：list_children_with_meta（批量拿到每个 Child 的 meta）
        let children = provider.list_children_with_meta(&composed).map_err(VfsError::Other)?;
        let composed_images = if composed.order_bys.is_empty() {
            composed.clone().with_order("images.id ASC")
        } else {
            composed.clone()
        };
        let mut images = provider.list_images(&composed_images).map_err(VfsError::Other)?;

        let mut file_ids: Vec<String> = images.iter().map(|img| img.id.clone()).collect();

        // 注入说明文件（若 provider 提供）
        if let Some((title, content)) = provider.get_note() {
            if let Ok((id, fpath)) = crate::providers::vd_ops::ensure_note_file(&title, &content) {
                file_ids.push(id.clone());
                images.push(ImageEntry {
                    id,
                    url: None,
                    local_path: fpath.to_string_lossy().to_string(),
                    plugin_id: String::new(),
                    task_id: None,
                    surf_record_id: None,
                    crawled_at: 0,
                    metadata: None,
                    metadata_id: None,
                    thumbnail_path: String::new(),
                    favorite: false,
                    is_hidden: false,
                    local_exists: true,
                    hash: String::new(),
                    width: None,
                    height: None,
                    display_name: title,
                    media_type: Some("text/plain".to_string()),
                    last_set_wallpaper_at: None,
                    size: None,
                });
            }
        }

        self.read_dir_entries(&segments, children, images, &file_ids)
    }

    fn read_dir_entries(
        &self,
        _segments: &[&str],
        children: Vec<ChildEntry>,
        images: Vec<ImageEntry>,
        file_ids: &[String],
    ) -> Result<Vec<VfsEntry>, VfsError> {
        let ts_map = Storage::global()
            .get_images_gallery_ts_by_ids(file_ids)
            .unwrap_or_default();

        let mut out = Vec::with_capacity(children.len() + images.len());

        // 目录条目（children）
        for child in children {
            let hidden = matches!(
                &child.meta,
                Some(ProviderMeta::Album(a)) if a.id == HIDDEN_ALBUM_ID
            );
            // list_children_with_meta 已批量填充 meta 字段
            let (created, accessed, modified) = match child.meta {
                Some(ProviderMeta::Task(task)) => {
                    let ts = task
                        .end_time
                        .or(task.start_time)
                        .map(normalize_unix_secs)
                        .unwrap_or_else(|| {
                            now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                        });
                    let t = UNIX_EPOCH
                        .checked_add(Duration::from_secs(ts))
                        .unwrap_or_else(now);
                    (t, t, t)
                }
                Some(ProviderMeta::Album(album)) => {
                    let t = system_time_from_gallery_ts(album.created_at);
                    (t, t, t)
                }
                Some(ProviderMeta::SurfRecord(sr)) => {
                    let t = system_time_from_gallery_ts(sr.last_visit_at);
                    (t, t, t)
                }
                _ => {
                    let t = now();
                    (t, t, t)
                }
            };

            out.push(VfsEntry::Directory {
                name: child.name,
                meta: VfsMetadata {
                    is_dir: true,
                    size: 0,
                    created,
                    accessed,
                    modified,
                },
                hidden,
            });
        }

        // 文件条目（images）
        for image in images {
            let resolved_path = PathBuf::from(&image.local_path);
            let Ok(meta) = std::fs::metadata(&resolved_path) else {
                continue;
            };
            let (created, accessed, modified) = if let Some(ts) = ts_map.get(&image.id) {
                let t = system_time_from_gallery_ts(*ts);
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
    pub fn create_dir(
        &self,
        _parent_path: &[String],
        _dir_name: &str,
    ) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied("虚拟盘为只读，不支持创建目录".to_string()))
    }

    pub fn create_file(&self, _path: &[String]) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied("虚拟盘为只读，不支持创建文件".to_string()))
    }

    /// VD 只读 — 始终返回 false，不允许删除。
    pub fn can_delete_child_at(&self, _parent_path: &[String], _name: &str) -> Result<bool, VfsError> {
        Ok(false)
    }

    /// VD 只读 — 始终返回 Ok(false)，不执行删除。
    pub fn commit_delete_child_at(
        &self,
        _parent_path: &[String],
        _name: &str,
    ) -> Result<bool, VfsError> {
        Ok(false)
    }

    /// VD 只读 — 始终返回 AccessDenied。
    pub fn rename_dir(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied("虚拟盘为只读，不支持重命名".to_string()))
    }

    pub fn rename_file(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持重命名文件".to_string(),
        ))
    }
}
