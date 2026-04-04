//! 虚拟盘（virtual-driver feature）专用：Linux 版本的文件读取（不使用内存映射）。
//!
//! 约束：
//! - 仅提供"按 offset 读取"能力（read_at），供 FUSE handler 使用。
//! - Linux 版本直接使用文件读取，不使用内存映射优化。

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use std::fmt;

#[derive(Debug, Clone)]
pub struct VdFileMeta {
    pub created: SystemTime,
    pub accessed: SystemTime,
    pub modified: SystemTime,
}

fn meta_times(meta: &std::fs::Metadata) -> VdFileMeta {
    let created = meta.created().unwrap_or(UNIX_EPOCH);
    let accessed = meta.accessed().unwrap_or(created);
    let modified = meta.modified().unwrap_or(accessed);
    VdFileMeta {
        created,
        accessed,
        modified,
    }
}

/// 虚拟盘高频只读文件句柄（支持 read_at）。
///
/// 注意：这个类型应当被 `Arc` 包装并放入 FUSE context 中复用，减少重复 open 成本。
#[derive(Clone)]
pub struct VdReadHandle {
    len: u64,
    file: Arc<Mutex<File>>,
}

impl fmt::Debug for VdReadHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VdReadHandle")
            .field("len", &self.len)
            .field("backend", &"file")
            .finish()
    }
}

impl VdReadHandle {
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn open(path: &Path) -> Result<(Self, VdFileMeta), String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("metadata failed: {}", e))?;
        let len = meta.len();
        let times = meta_times(&meta);

        let file = File::open(path).map_err(|e| format!("open failed: {}", e))?;
        let file = Arc::new(Mutex::new(file));

        Ok((
            Self {
                len,
                file,
            },
            times,
        ))
    }

    /// 按 offset 读取：返回实际读取字节数（可能小于 buffer.len）。
    pub fn read_at(&self, offset: u64, buffer: &mut [u8]) -> Result<usize, String> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if offset >= self.len {
            return Ok(0);
        }

        let mut file = self.file.lock()
            .map_err(|e| format!("lock failed: {}", e))?;
        
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("seek failed: {}", e))?;
        
        let max_read = (self.len - offset) as usize;
        let read_size = buffer.len().min(max_read);
        let n = file.read(&mut buffer[..read_size])
            .map_err(|e| format!("read failed: {}", e))?;
        
        Ok(n)
    }
}
