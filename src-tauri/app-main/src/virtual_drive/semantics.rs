//! 虚拟盘“文件系统语义/原语”层（不依赖 Dokan/Win32）。
//!
//! 目标：
//! - 提供跨平台的文件系统操作语义：read_dir/read_file/create_dir/delete/rename 等。
//! - 平台层（Windows Dokan handler）只负责把平台参数映射到这些原语，并将结果映射回平台返回值。

#![allow(dead_code)]

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use kabegame_core::{
    providers::provider::{
        DeleteChildKind, DeleteChildMode, FsEntry, Provider, ResolveResult, VdOpsContext,
    },
    providers::{root::DIR_ALBUMS, root::DIR_BY_TASK, ProviderRuntime},
    storage::Storage,
};

#[cfg(all(feature = "virtual-drive", target_os = "windows"))]
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
    storage: &'a Storage,
    root: &'a Arc<dyn Provider>,
    provider_rt: &'a ProviderRuntime,
}

impl<'a> VfsSemantics<'a> {
    pub fn new(
        storage: &'a Storage,
        root: &'a Arc<dyn Provider>,
        provider_rt: &'a ProviderRuntime,
    ) -> Self {
        Self {
            storage,
            root,
            provider_rt,
        }
    }

    pub fn path_to_segments(path: &[String]) -> Vec<&str> {
        path.iter().map(|s| s.as_str()).collect()
    }

    /// 解析路径：最长前缀回退 + list 刷新
    pub fn resolve_cached(&self, segments: &[&str]) -> ResolveResult {
        if segments.is_empty() {
            return ResolveResult::Directory(self.root.clone());
        }

        // 如果最后一段看起来像文件名（包含 '.'），优先尝试文件解析，避免被误判为目录
        let is_likely_file = segments.last().map(|s| s.contains('.')).unwrap_or(false);

        if is_likely_file && segments.len() >= 2 {
            // 文件：用 parent provider 的 resolve_file 解析最后一段
            let parent_segs = &segments[..segments.len() - 1];
            let file_name = segments[segments.len() - 1];
            if let Ok(Some(parent)) = self.resolve_provider(parent_segs) {
                if let Some((image_id, resolved_path)) =
                    parent.resolve_file(self.storage, file_name)
                {
                    return ResolveResult::File {
                        image_id,
                        resolved_path,
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
                if let Some((image_id, resolved_path)) =
                    parent.resolve_file(self.storage, file_name)
                {
                    return ResolveResult::File {
                        image_id,
                        resolved_path,
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
            .resolve_provider_for_root(self.storage, self.root.clone(), segments)
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
                let meta = self
                    .storage
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

        // 走 core runtime：list 并缓存 child keys/provider（避免后续 resolve 再做昂贵 get_child）
        let entries = self
            .provider_rt
            .list_and_cache_children(self.storage, &segments, provider)
            .map_err(VfsError::Other)?;

        // 为了让虚拟盘“文件时间戳”与画廊数据一致：
        // - 对本次 list 中出现的文件，一次性批量查询它们的 gallery ts（COALESCE(order, crawled_at)）
        // - 找不到的再回退到磁盘文件 metadata（兼容被手动移动/缺失的文件）
        let mut file_ids: Vec<String> = Vec::new();
        for e in &entries {
            if let FsEntry::File { image_id, .. } = e {
                file_ids.push(image_id.clone());
            }
        }
        let ts_map = self
            .storage
            .get_images_gallery_ts_by_ids(&file_ids)
            .unwrap_or_default();

        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            match entry {
                FsEntry::Directory { name } => {
                    // 任务目录：modified = task end_time（无 end_time 则回退 start_time/now）
                    let (created, accessed, modified) =
                        if segments.len() == 1 && segments[0].eq_ignore_ascii_case(DIR_BY_TASK) {
                            let task_id = name
                                .rsplit_once(" - ")
                                .map(|(_, id)| id)
                                .unwrap_or(name.as_str())
                                .trim();

                            if let Ok(Some(task)) = self.storage.get_task(task_id) {
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
                FsEntry::File {
                    name,
                    image_id,
                    resolved_path,
                } => {
                    let meta = std::fs::metadata(&resolved_path)
                        .map_err(|_| VfsError::NotFound("文件不存在".to_string()))?;
                    let (created, accessed, modified) = if let Some(ts) = ts_map.get(&image_id) {
                        let t = system_time_from_gallery_ts(*ts);
                        (t, t, t)
                    } else {
                        system_time_from_fs_metadata(&meta)
                    };
                    out.push(VfsEntry::File {
                        name,
                        image_id,
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
        ctx: &dyn VdOpsContext,
    ) -> Result<(), VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;

        if !parent.can_create_child_dir() {
            return Err(VfsError::AccessDenied("不支持创建目录".to_string()));
        }
        parent
            .create_child_dir(self.storage, dir_name, ctx)
            .map_err(VfsError::Other)?;
        Ok(())
    }

    pub fn create_file(&self, _path: &[String]) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持创建文件".to_string(),
        ))
    }

    pub fn delete_dir(
        &self,
        parent_path: &[String],
        dir_name: &str,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
    ) -> Result<bool, VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;
        parent
            .delete_child(
                self.storage,
                dir_name,
                DeleteChildKind::Directory,
                mode,
                ctx,
            )
            .map_err(VfsError::Other)
    }

    pub fn delete_file(
        &self,
        parent_path: &[String],
        file_name: &str,
        mode: DeleteChildMode,
        ctx: &dyn VdOpsContext,
    ) -> Result<bool, VfsError> {
        let parent_segs = Self::path_to_segments(parent_path);
        let parent = self
            .resolve_provider(&parent_segs)?
            .ok_or_else(|| VfsError::NotFound("父目录不存在".to_string()))?;
        parent
            .delete_child(self.storage, file_name, DeleteChildKind::File, mode, ctx)
            .map_err(VfsError::Other)
    }

    pub fn rename_dir(&self, path: &[String], new_name: &str) -> Result<(), VfsError> {
        let segs = Self::path_to_segments(path);
        let provider = self
            .resolve_provider(&segs)?
            .ok_or_else(|| VfsError::NotFound("路径不存在".to_string()))?;
        if !provider.can_rename() {
            return Err(VfsError::AccessDenied("不支持重命名".to_string()));
        }
        provider
            .rename(self.storage, new_name)
            .map_err(VfsError::Other)?;
        Ok(())
    }

    pub fn rename_file(&self, _path: &[String], _new_name: &str) -> Result<(), VfsError> {
        Err(VfsError::AccessDenied(
            "当前虚拟盘不支持重命名文件".to_string(),
        ))
    }

    /// 便捷：判断某个目录是否位于“画册”根下（用于默认只读策略）
    pub fn is_under_albums_root(path: &[String]) -> bool {
        path.first()
            .map(|s| s.eq_ignore_ascii_case(DIR_ALBUMS))
            .unwrap_or(false)
    }
}
