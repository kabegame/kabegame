//! 虚拟盘"文件系统语义/原语"层（不依赖 Dokan/Win32）。
//!
//! **Phase 6b stub mode**:
//! 6b 阶段 Provider trait 切换到 pathql-rs 后，旧 VfsSemantics 依赖的
//! `Provider::list_images` / `get_meta` typed enum / `(title, content)` note
//! 都已不复存在；完整的 VD 路径解析将在 Phase 6c 通过 SqlExecutor 注入恢复。
//!
//! 当前 stub 保留 [`VfsSemantics`] 公开 API 形状，但所有路径解析返回 NotFound / 空 /
//! AccessDenied — 意味着 VD 在 6b 期间不能真正列举目录 / 读文件。
//! 写操作（create_dir / rename_*）一直就是 AccessDenied。
//! Phase 6c 完成后此文件会被完整重写。

#![allow(unused_variables, dead_code)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pathql_rs::compose::ProviderQuery;
use pathql_rs::ProviderRuntime;

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

/// app-main 的虚拟盘语义执行器。Phase 6b stub 版本。
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

    /// Phase 6b stub：永远返回 NotFound。
    pub fn resolve_cached(&self, _segments: &[&str]) -> ResolveResult {
        ResolveResult::NotFound
    }

    pub fn open_existing(&self, _path: &[String]) -> Result<VfsOpenedItem, VfsError> {
        Err(VfsError::NotFound("VD 6b stub: 暂不支持路径解析".to_string()))
    }

    pub fn read_dir(&self, _path: &[String]) -> Result<Vec<VfsEntry>, VfsError> {
        Ok(Vec::new())
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

    pub fn can_delete_child_at(&self, _parent_path: &[String], _name: &str) -> Result<bool, VfsError> {
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
        Err(VfsError::AccessDenied("虚拟盘为只读，不支持重命名".to_string()))
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
