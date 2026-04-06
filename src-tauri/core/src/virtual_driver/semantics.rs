//! 虚拟盘“文件系统语义/原语”层（不依赖 Dokan/Win32）。
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
    providers::descriptor::{ProviderDescriptor, ProviderGroupKind},
    providers::provider::Provider,
    providers::ProviderRuntime,
    storage::Storage,
};

use super::vd_locale_sync::vd_locale_segment_for_settings_sync;

/// VD 路径解析结果（virtual_driver 专用，不属于 Provider trait）。
pub enum ResolveResult {
    Directory(Arc<dyn Provider>),
    File {
        image_id: String,
        resolved_path: PathBuf,
    },
    NotFound,
}

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
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
    },
    File {
        name: String,
        image_id: String,
        resolved_path: PathBuf,
        meta: VfsMetadata,
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
    },
    File {
        path: Vec<String>,
        image_id: String,
        resolved_path: PathBuf,
        size: u64,
        meta: VdFileMeta,
        read_handle: Arc<VdReadHandle>,
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

/// app-main 的虚拟盘语义执行器：基于 core 的 Provider 树实现“文件系统操作语义”。
pub struct VfsSemantics<'a> {
    provider_rt: &'a ProviderRuntime,
    vd_locale: &'static str,
}

impl<'a> VfsSemantics<'a> {
    pub fn new(provider_rt: &'a ProviderRuntime) -> Self {
        Self {
            provider_rt,
            vd_locale: vd_locale_segment_for_settings_sync(),
        }
    }

    /// 第一段路径是否解析为指定 `Group`（用于替代硬编码的 VD 目录名）。
    pub fn resolved_segment_is_group(&self, segment: &str, kind: ProviderGroupKind) -> bool {
        match self.resolve_provider(&[segment]) {
            Ok(Some(p)) => matches!(p.descriptor(), ProviderDescriptor::Group { kind: k, .. } if k == kind),
            _ => false,
        }
    }

    /// `path` 首段是否为某 Group（例如画册根下的「画册」文件夹名）。
    pub fn path_starts_with_group(&self, path: &[String], kind: ProviderGroupKind) -> bool {
        path.first()
            .map(|s| self.resolved_segment_is_group(s.as_str(), kind))
            .unwrap_or(false)
    }

    pub fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    fn vd_path(&self, segments: &[&str]) -> String {
        if segments.is_empty() {
            format!("vd/{}", self.vd_locale)
        } else {
            format!("vd/{}/{}", self.vd_locale, segments.join("/"))
        }
    }

    fn vd_segments<'b>(&self, segments: &'b [&'b str]) -> Vec<&'b str> {
        let mut out = Vec::with_capacity(segments.len() + 2);
        out.push("vd");
        out.push(self.vd_locale);
        out.extend_from_slice(segments);
        out
    }

    fn image_entry_file_name(image: &crate::providers::provider::ImageEntry) -> String {
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

    fn image_entry_from_parent_file_name(
        &self,
        parent: &Arc<dyn Provider>,
        file_name: &str,
    ) -> Option<crate::providers::provider::ImageEntry> {
        let entries = parent.list_entries().ok()?;
        for entry in entries {
            let crate::providers::provider::ListEntry::Image(image) = entry else {
                continue;
            };
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
            return match self.resolve_provider(segments) {
                Ok(Some(root)) => ResolveResult::Directory(root),
                _ => ResolveResult::NotFound,
            };
        }

        // 如果最后一段看起来像文件名（包含 '.'），优先尝试文件解析，避免被误判为目录
        let is_likely_file = segments.last().map(|s| s.contains('.')).unwrap_or(false);

        if is_likely_file && segments.len() >= 2 {
            // 文件：优先用 parent.list_entries() 的 Image 条目解析
            let parent_segs = &segments[..segments.len() - 1];
            let file_name = segments[segments.len() - 1];
            if let Ok(Some(parent)) = self.resolve_provider(parent_segs) {
                if let Some(image) = self.image_entry_from_parent_file_name(&parent, file_name) {
                    return ResolveResult::File {
                        image_id: image.id,
                        resolved_path: PathBuf::from(image.local_path),
                    };
                }
            }
        }

        // 目录：尝试把完整 segments 解析成 provider
        if let Ok(Some(p)) = self.resolve_provider(segments) {
            return ResolveResult::Directory(p);
        }

        // 文件（兜底）：当目录解析失败时，再尝试 resolve_file（支持无扩展名的说明文件）
        if !segments.is_empty() {
            let parent_segs = &segments[..segments.len().saturating_sub(1)];
            let file_name = segments[segments.len() - 1];
            if let Ok(Some(parent)) = self.resolve_provider(parent_segs) {
                if let Some(image) = self.image_entry_from_parent_file_name(&parent, file_name) {
                    return ResolveResult::File {
                        image_id: image.id,
                        resolved_path: PathBuf::from(image.local_path),
                    };
                }
            }
        }

        ResolveResult::NotFound
    }

    /// 根据路径解析 Provider
    pub fn resolve_provider(
        &self,
        segments: &[&str],
    ) -> Result<Option<Arc<dyn Provider>>, VfsError> {
        // 复用 core 的 ProviderRuntime：
        // - 最长前缀回退（LRU / sled descriptor）
        // - list 刷新写入 child key
        // - Dynamic 子节点仅入 LRU（避免污染持久缓存）
        self.provider_rt
            .resolve(&self.vd_path(segments))
            .map_err(VfsError::Other)
    }

    /// 打开（仅支持 open existing；创建由 create_* 原语处理）
    pub fn open_existing(&self, path: &[String]) -> Result<VfsOpenedItem, VfsError> {
        let segs: Vec<&str> = Self::path_to_segments(path);
        match self.resolve_cached(&segs) {
            ResolveResult::Directory(_) => Ok(VfsOpenedItem::Directory {
                path: path.to_vec(),
            }),
            ResolveResult::File {
                image_id,
                resolved_path,
            } => {
                let (handle, meta) = VdReadHandle::open(&resolved_path)
                    .map_err(|_| VfsError::NotFound("文件不存在".to_string()))?;
                let size = handle.len();
                // 文件时间戳与画廊数据一致：优先取 DB 的 COALESCE(order, crawled_at)。
                // 这里做一次轻量查询并缓存到 context，避免 get_file_information 再次查 DB / stat。
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
                })
            }
            ResolveResult::NotFound => Err(VfsError::NotFound("路径不存在".to_string())),
        }
    }

    pub fn read_dir(&self, path: &[String]) -> Result<Vec<VfsEntry>, VfsError> {
        let segments = Self::path_to_segments(path);
        let provider = match self.resolve_cached(&segments) {
            ResolveResult::Directory(p) => p,
            ResolveResult::File { .. } => {
                return Err(VfsError::NotADirectory("目标不是目录".to_string()))
            }
            ResolveResult::NotFound => return Err(VfsError::NotFound("路径不存在".to_string())),
        };

        // 使用新 API：list_entries（child provider + image）
        let entries = provider.list_entries().map_err(VfsError::Other)?;
        let mut file_ids: Vec<String> = entries
            .iter()
            .filter_map(|e| match e {
                crate::providers::provider::ListEntry::Image(image) => Some(image.id.clone()),
                _ => None,
            })
            .collect();

        // 注入说明文件（若 provider 提供）
        if let Some((title, content)) = provider.get_note() {
            if let Ok((id, path)) = crate::providers::vd_ops::ensure_note_file(&title, &content) {
                file_ids.push(id);
                // 用临时条目拼接到 entries 后面（不参与 child cache）
                let mut ext_entries = entries;
                ext_entries.push(crate::providers::provider::ListEntry::Image(
                    crate::providers::provider::ImageEntry {
                        id: file_ids.last().cloned().unwrap_or_default(),
                        url: None,
                        local_path: path.to_string_lossy().to_string(),
                        plugin_id: String::new(),
                        crawled_at: 0,
                        hash: String::new(),
                        width: None,
                        height: None,
                        display_name: title,
                        media_type: Some("text/plain".to_string()),
                    },
                ));
                return self.read_dir_entries_with_ts(&segments, ext_entries, &file_ids);
            }
        }

        self.read_dir_entries_with_ts(&segments, entries, &file_ids)
    }

    fn read_dir_entries_with_ts(
        &self,
        segments: &[&str],
        entries: Vec<crate::providers::provider::ListEntry>,
        file_ids: &[String],
    ) -> Result<Vec<VfsEntry>, VfsError> {
        let ts_map = Storage::global()
            .get_images_gallery_ts_by_ids(&file_ids)
            .unwrap_or_default();

        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            match entry {
                crate::providers::provider::ListEntry::Child { name, .. } => {
                    // 任务目录：modified = task end_time（无 end_time 则回退 start_time/now）
                    let (created, accessed, modified) =
                        if segments.len() == 1
                            && self.resolved_segment_is_group(segments[0], ProviderGroupKind::Task)
                        {
                            let task_id = name
                                .rsplit_once(" - ")
                                .map(|(_, id)| id)
                                .unwrap_or(name.as_str())
                                .trim();

                            if let Ok(Some(task)) = Storage::global().get_task(task_id) {
                                // 兼容：若是毫秒时间戳（大于 9999-12-31 秒级阈值），则降为秒
                                fn normalize_unix_secs(ts: u64) -> u64 {
                                    const MAX_SEC_9999: u64 = 253402300799;
                                    if ts > MAX_SEC_9999 {
                                        ts / 1000
                                    } else {
                                        ts
                                    }
                                }
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
                            } else {
                                let t = now();
                                (t, t, t)
                            }
                        } else {
                            let t = now();
                            (t, t, t)
                        };

                    out.push(VfsEntry::Directory {
                        name,
                        meta: VfsMetadata {
                            is_dir: true,
                            size: 0,
                            created,
                            accessed,
                            modified,
                        },
                    });
                }
                crate::providers::provider::ListEntry::Image(image) => {
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
                    });
                }
            }
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

    pub fn create_dir(
        &self,
        parent_path: &[String],
        dir_name: &str,
    ) -> Result<(), VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;

        if parent.can_add_child() {
            parent.add_child(dir_name).map_err(VfsError::Other)?;
            return Ok(());
        }
        Err(VfsError::AccessDenied("不支持创建目录".to_string()))
    }

    pub fn create_file(&self, _path: &[String]) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持创建文件".to_string(),
        ))
    }

    /// Dokan「删除目录」预检：是否允许删除（不修改数据）。
    pub fn can_delete_child_at(&self, parent_path: &[String], name: &str) -> Result<bool, VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;
        Ok(parent.can_delete_child(name))
    }

    /// 执行删除子目录或子「文件」条目（画册下图片等），与 [`Self::can_delete_child_at`] 配对使用。
    pub fn commit_delete_child_at(
        &self,
        parent_path: &[String],
        name: &str,
    ) -> Result<bool, VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;
        if parent.can_delete_child(name) {
            parent.delete_child(name).map_err(VfsError::Other)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn rename_dir(&self, path: &[String], new_name: &str) -> Result<(), VfsError> {
        if path.is_empty() {
            return Err(VfsError::InvalidParameter("路径不能为空".to_string()));
        }
        let parent_path = &path[..path.len() - 1];
        let old_name = path[path.len() - 1].as_str();
        let parent_segs = Self::path_to_segments(parent_path);
        if let Some(parent) = self.resolve_provider(&parent_segs)? {
            if parent.can_rename_child() {
                parent
                    .rename_child(old_name, new_name)
                    .map_err(VfsError::Other)?;
                return Ok(());
            }
        }
        Err(VfsError::AccessDenied("不支持重命名".to_string()))
    }

    pub fn rename_file(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持重命名文件".to_string(),
        ))
    }

}
