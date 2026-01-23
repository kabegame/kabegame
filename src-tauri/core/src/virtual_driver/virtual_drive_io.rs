//! 虚拟盘（virtual-driver feature）专用：高频只读文件读取优化（面向 Explorer 缩略图/预览）。
//!
//! 约束：
//! - 仅提供"按 offset 读取"能力（read_at），供 app-main 的 Dokan handler 使用。
//! - Windows 下优先使用 file mapping（section / mmap）减少大量小块 ReadFile syscall。
//! - 失败/不适用时回退到 `FileExt::seek_read`。

#![cfg(all(not(kabegame_mode = "light"), target_os = "windows"))]

use std::{
    fs::File,
    num::NonZeroUsize,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use lru::LruCache;
use memmap2::{Mmap, MmapOptions};
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

const MMAP_LRU_CAP: usize = 64;
const MAX_MMAP_BYTES: u64 = 256 * 1024 * 1024; // 256MB：更大的文件直接走 seek_read，避免长期持有大映射

struct MmapCache {
    lru: LruCache<String, Arc<Mmap>>,
}

static MMAP_CACHE: OnceLock<Mutex<MmapCache>> = OnceLock::new();

fn mmap_cache() -> &'static Mutex<MmapCache> {
    MMAP_CACHE.get_or_init(|| {
        Mutex::new(MmapCache {
            lru: LruCache::new(NonZeroUsize::new(MMAP_LRU_CAP).unwrap()),
        })
    })
}

#[derive(Clone)]
enum Backend {
    Mmap(Arc<Mmap>),
    File(Arc<File>),
}

/// 虚拟盘高频只读文件句柄（支持 read_at）。
///
/// 注意：这个类型应当被 `Arc` 包装并放入 Dokan context 中复用，减少重复 open/映射成本。
#[derive(Clone)]
pub struct VdReadHandle {
    len: u64,
    backend: Backend,
}

impl fmt::Debug for VdReadHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match &self.backend {
            Backend::Mmap(_) => "mmap",
            Backend::File(_) => "file",
        };
        f.debug_struct("VdReadHandle")
            .field("len", &self.len)
            .field("backend", &kind)
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
        let file = Arc::new(file);

        // 0 字节文件：不做映射，直接回退 File
        if len == 0 {
            return Ok((
                Self {
                    len,
                    backend: Backend::File(file),
                },
                times,
            ));
        }

        // 过大文件：避免长期持有巨型映射（壁纸一般不会这么大，但要防御）
        if len > MAX_MMAP_BYTES {
            return Ok((
                Self {
                    len,
                    backend: Backend::File(file),
                },
                times,
            ));
        }

        // 映射需要 usize 长度
        if usize::try_from(len).is_err() {
            return Ok((
                Self {
                    len,
                    backend: Backend::File(file),
                },
                times,
            ));
        }

        // Windows 路径大小写不敏感；这里用字符串做 key 即可（重复映射的风险低，且 LRU 会限制）
        let key = path.to_string_lossy().to_string();

        // 尝试复用 mmap
        if let Ok(mut g) = mmap_cache().lock() {
            if let Some(m) = g.lru.get(&key) {
                return Ok((
                    Self {
                        len,
                        backend: Backend::Mmap(m.clone()),
                    },
                    times,
                ));
            }
        }

        // 创建 mmap（只读）
        let mmap = unsafe { MmapOptions::new().map(&*file) }
            .map(Arc::new)
            .map_err(|e| format!("mmap failed: {}", e))?;

        if let Ok(mut g) = mmap_cache().lock() {
            g.lru.put(key, mmap.clone());
        }

        Ok((
            Self {
                len,
                backend: Backend::Mmap(mmap),
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

        match &self.backend {
            Backend::Mmap(m) => {
                let start = offset as usize;
                let end = (offset.saturating_add(buffer.len() as u64)).min(self.len) as usize;
                let n = end.saturating_sub(start);
                if n == 0 {
                    return Ok(0);
                }
                buffer[..n].copy_from_slice(&m[start..end]);
                Ok(n)
            }
            Backend::File(f) => {
                use std::os::windows::fs::FileExt;
                f.seek_read(buffer, offset)
                    .map_err(|e| format!("seek_read failed: {}", e))
            }
        }
    }
}
