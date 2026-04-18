//! Provider 运行期纯内存 LRU（最多 1024 条）。
//!
//! 设计目标：
//! - 无 sled 持久化、无 ProviderDescriptor、无 ProviderFactory
//! - resolve_new(path)：按路径段线性调用 Provider::get_child + apply_query，缓存 ResolvedNode
//! - clear_cache()：清空 LRU

use std::sync::{Arc, Mutex, OnceLock};

use lru::LruCache;

use crate::providers::provider::{
    ChildEntry, ImageEntry, Provider, ProviderMeta, ResolvedNode,
};
use crate::storage::gallery::ImageQuery;

#[derive(Debug, Clone)]
pub struct ProviderCacheConfig {
    /// LRU 容量（条目数）
    pub lru_capacity: usize,
}

impl Default for ProviderCacheConfig {
    fn default() -> Self {
        Self { lru_capacity: 1024 }
    }
}

/// ProviderRuntime：纯内存 LRU provider 缓存。
pub struct ProviderRuntime {
    cfg: ProviderCacheConfig,
    root: Arc<dyn Provider>,
    lru: Mutex<LruCache<String, ResolvedNode>>,
}

// 全局单例
static PROVIDER_RT: OnceLock<ProviderRuntime> = OnceLock::new();

impl ProviderRuntime {
    /// 初始化全局 ProviderRuntime（必须在首次使用前调用）。
    pub fn init_global(root: Arc<dyn Provider>, cfg: ProviderCacheConfig) -> Result<(), String> {
        let cap = std::num::NonZeroUsize::new(cfg.lru_capacity.max(1))
            .unwrap_or_else(|| std::num::NonZeroUsize::new(1024).unwrap());
        let rt = Self {
            cfg,
            root,
            lru: Mutex::new(LruCache::new(cap)),
        };
        PROVIDER_RT
            .set(rt)
            .map_err(|_| "ProviderRuntime already initialized".to_string())?;
        Ok(())
    }

    /// 获取全局 ProviderRuntime 引用。
    #[inline]
    pub fn global() -> &'static ProviderRuntime {
        PROVIDER_RT
            .get()
            .expect("ProviderRuntime not initialized. Call ProviderRuntime::init_global() first.")
    }

    /// 清空 provider 内存 LRU（供前端在分页策略变更后触发重试）。
    pub fn clear_cache(&self) -> Result<(), String> {
        let cap = std::num::NonZeroUsize::new(self.cfg.lru_capacity.max(1))
            .unwrap_or_else(|| std::num::NonZeroUsize::new(1024).unwrap());
        if let Ok(mut lru) = self.lru.lock() {
            *lru = LruCache::new(cap);
        }
        Ok(())
    }

    fn normalize_seg(seg: &str) -> String {
        seg.chars()
            .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c })
            .collect()
    }

    fn make_key(segments: &[&str]) -> String {
        segments.iter().map(|s| Self::normalize_seg(s)).collect::<Vec<_>>().join("/")
    }

    /// 解析路径，缓存 ResolvedNode（provider + composed query）。
    pub fn resolve(&self, path: &str) -> Result<Option<ResolvedNodeRef>, String> {
        let segs: Vec<&str> = path
            .split('/')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        let full_key = Self::make_key(&segs);

        if let Ok(mut lru) = self.lru.lock() {
            if let Some(node) = lru.get(&full_key) {
                return Ok(Some(ResolvedNodeRef {
                    provider: node.provider.clone(),
                    composed: node.composed.clone(),
                }));
            }
        }

        let mut composed = ImageQuery::new();
        let mut provider: Arc<dyn Provider> = self.root.clone();
        composed = provider.apply_query(composed);

        for (i, seg) in segs.iter().enumerate() {
            let norm = Self::normalize_seg(seg);
            let prefix_key = Self::make_key(&segs[..=i]);

            if let Ok(mut lru) = self.lru.lock() {
                if let Some(node) = lru.get(&prefix_key) {
                    provider = node.provider.clone();
                    composed = node.composed.clone();
                    continue;
                }
            }

            match provider.get_child(&norm, &composed) {
                Some(child) => {
                    composed = child.apply_query(composed.clone());
                    if let Ok(mut lru) = self.lru.lock() {
                        lru.put(
                            prefix_key,
                            ResolvedNode { provider: child.clone(), composed: composed.clone() },
                        );
                    }
                    provider = child;
                }
                None => return Ok(None),
            }
        }

        Ok(Some(ResolvedNodeRef { provider, composed }))
    }

    /// 列结构子目录（不含 images）。
    pub fn list_dir(&self, path: &str) -> Result<Vec<ChildEntry>, String> {
        let node = self
            .resolve(path)?
            .ok_or_else(|| format!("路径不存在: {}", path))?;
        node.provider.list_children(&node.composed)
    }

    /// 列结构子目录 + meta。
    pub fn list_dir_with_meta(&self, path: &str) -> Result<Vec<ChildEntry>, String> {
        let node = self
            .resolve(path)?
            .ok_or_else(|| format!("路径不存在: {}", path))?;
        node.provider.list_children_with_meta(&node.composed)
    }

    /// 列该路径的 images。若 composed.order_bys 为空自动兜底 `images.id ASC`。
    pub fn list_images(&self, path: &str) -> Result<Vec<ImageEntry>, String> {
        let node = self
            .resolve(path)?
            .ok_or_else(|| format!("路径不存在: {}", path))?;
        let composed = if node.composed.order_bys.is_empty() {
            node.composed.clone().with_order("images.id ASC")
        } else {
            node.composed.clone()
        };
        node.provider.list_images(&composed)
    }

    /// 返回该路径节点的 meta。
    pub fn get_meta(&self, path: &str) -> Result<Option<ProviderMeta>, String> {
        let node = self
            .resolve(path)?
            .ok_or_else(|| format!("路径不存在: {}", path))?;
        Ok(node.provider.get_meta())
    }
}

/// resolve_new 返回的轻量引用（克隆出来，不持有 LRU 锁）。
pub struct ResolvedNodeRef {
    pub provider: Arc<dyn Provider>,
    pub composed: ImageQuery,
}
