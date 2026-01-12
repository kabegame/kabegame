//! Provider 缓存（sled 持久化）+ 运行期 LRU（最多 1024 条）。
//!
//! 设计目标（按用户最新约束）：
//! - sled 保存：`kabegame:provider:<访问路径(用冒号分隔)> -> ProviderDescriptor(JSON)`（字节值）
//! - 不用 id 引用 provider：通过 descriptor + factory 重建，避免内存“爆表”
//! - 运行期仅缓存 1024 个 provider 实例（LRU）：key=访问路径 key
//! - “设置 key” 只发生在两类操作：
//!   1) `list()`：列目录时为所有 child 目录写入 key（value=child.descriptor）
//!   2) 画册重命名：将新路径 key 写入旧路径的 descriptor（B 策略），旧 key 允许成为幽灵
//! - “找不到 key” 时：按最长前缀回退到已知 provider，然后 `list()` 刷新 child keys

use std::sync::{Arc, Mutex};

use lru::LruCache;
use sled::Db;

use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::factory::ProviderFactory;
use crate::providers::provider::{FsEntry, Provider};
use crate::storage::Storage;

#[derive(Debug, Clone)]
pub struct ProviderCacheConfig {
    /// 最大递归节点数（防止极端情况下 warm 爆炸）
    pub warm_max_nodes: usize,
    /// sled 目录（持久化）
    pub db_dir: std::path::PathBuf,
    /// key 前缀
    pub key_prefix: String,
    /// LRU 容量（条目数）
    pub lru_capacity: usize,
}

impl Default for ProviderCacheConfig {
    fn default() -> Self {
        Self {
            warm_max_nodes: 20_000,
            db_dir: crate::app_paths::kabegame_data_dir().join("provider-cache-db"),
            key_prefix: "kabegame:provider".to_string(),
            lru_capacity: 1024,
        }
    }
}

/// ProviderRuntime：RocksDB + LRU
pub struct ProviderRuntime {
    cfg: ProviderCacheConfig,
    db: Db,
    lru: Mutex<LruCache<String, Arc<dyn Provider>>>,
}

impl ProviderRuntime {
    pub fn new(cfg: ProviderCacheConfig) -> Result<Self, String> {
        let db = sled::open(&cfg.db_dir).map_err(|e| format!("open sled failed: {}", e))?;
        let cap = std::num::NonZeroUsize::new(cfg.lru_capacity.max(1))
            .unwrap_or_else(|| std::num::NonZeroUsize::new(1024).unwrap());
        Ok(Self {
            cfg,
            db,
            lru: Mutex::new(LruCache::new(cap)),
        })
    }

    fn normalize_seg(seg: &str) -> String {
        // Windows 路径对 ASCII 通常大小写不敏感；这里统一 ASCII lower，非 ASCII 原样
        let mut out = String::with_capacity(seg.len());
        for ch in seg.chars() {
            if ch.is_ascii_uppercase() {
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push(ch);
            }
        }
        out
    }

    fn key_for_segments(&self, segments: &[&str]) -> String {
        if segments.is_empty() {
            return self.cfg.key_prefix.clone();
        }
        let mut s = String::with_capacity(self.cfg.key_prefix.len() + 1 + segments.len() * 8);
        s.push_str(&self.cfg.key_prefix);
        for seg in segments {
            s.push(':');
            s.push_str(&Self::normalize_seg(seg));
        }
        s
    }

    fn db_get_descriptor_by_key(&self, key: &str) -> Result<Option<ProviderDescriptor>, String> {
        let v = self
            .db
            .get(key.as_bytes())
            .map_err(|e| format!("sled get failed: {}", e))?;
        let Some(bytes) = v else {
            return Ok(None);
        };
        let desc = serde_json::from_slice::<ProviderDescriptor>(&bytes)
            .map_err(|e| format!("decode ProviderDescriptor failed: {}", e))?;
        Ok(Some(desc))
    }

    fn db_put_descriptor_by_key(&self, key: &str, desc: &ProviderDescriptor) -> Result<(), String> {
        let bytes = serde_json::to_vec(desc)
            .map_err(|e| format!("encode ProviderDescriptor failed: {}", e))?;
        self.db
            .insert(key.as_bytes(), bytes)
            .map_err(|e| format!("sled insert failed: {}", e))?;
        let _ = self.db.flush();
        Ok(())
    }

    /// 读取某个访问路径对应的 descriptor（仅查 DB）
    pub fn get_descriptor_for_path(
        &self,
        segments: &[&str],
    ) -> Result<Option<ProviderDescriptor>, String> {
        let key = self.key_for_segments(segments);
        self.db_get_descriptor_by_key(&key)
    }

    /// 设置某个访问路径对应的 descriptor（用于 list 写入 & 画册重命名 B 策略）
    pub fn set_descriptor_for_path(
        &self,
        segments: &[&str],
        desc: &ProviderDescriptor,
    ) -> Result<(), String> {
        let key = self.key_for_segments(segments);
        self.db_put_descriptor_by_key(&key, desc)
    }

    fn get_or_build_provider_by_key(&self, key: &str) -> Result<Option<Arc<dyn Provider>>, String> {
        if let Ok(mut lru) = self.lru.lock() {
            if let Some(p) = lru.get(key) {
                return Ok(Some(p.clone()));
            }
        }
        let Some(desc) = self.db_get_descriptor_by_key(key)? else {
            return Ok(None);
        };
        let p = ProviderFactory::build(&desc);
        if let Ok(mut lru) = self.lru.lock() {
            lru.put(key.to_string(), p.clone());
        }
        Ok(Some(p))
    }

    /// 找到“最长可用前缀”：优先命中 LRU，其次读 sled db 描述符重建。
    pub fn find_longest_prefix_provider(
        &self,
        segments: &[&str],
    ) -> Result<Option<(usize, Arc<dyn Provider>)>, String> {
        for len in (0..=segments.len()).rev() {
            let key = self.key_for_segments(&segments[..len]);
            if let Some(p) = self.get_or_build_provider_by_key(&key)? {
                return Ok(Some((len, p)));
            }
        }
        Ok(None)
    }

    /// 从 list 结果缓存子目录
    fn cache_children_from_list(
        &self,
        storage: &Storage,
        parent_segments: &[&str],
        parent: Arc<dyn Provider>,
    ) -> Result<Vec<(String, Arc<dyn Provider>)>, String> {
        let entries = parent.list(storage)?;
        let mut children: Vec<(String, Arc<dyn Provider>)> = Vec::new();
        for e in &entries {
            let FsEntry::Directory { name } = e else {
                continue;
            };
            if let Some(child) = parent.get_child(storage, name) {
                let mut child_path: Vec<&str> = parent_segments.to_vec();
                child_path.push(name);
                let key = self.key_for_segments(&child_path);
                let desc = child.descriptor();
                let _ = self.db_put_descriptor_by_key(&key, &desc);
                if let Ok(mut lru) = self.lru.lock() {
                    lru.put(key, child.clone());
                }
                children.push((name.clone(), child));
            }
        }
        Ok(children)
    }

    /// 列目录并为所有 child 目录写入 key（并把 child provider 放入内存）。
    ///
    /// 返回 list 结果（原样）。
    pub fn list_and_cache_children(
        &self,
        storage: &Storage,
        parent_segments: &[&str],
        parent: Arc<dyn Provider>,
    ) -> Result<Vec<FsEntry>, String> {
        // 先 cache 一次 children（符合“由 list 设置 key”的规则）
        let _ = self.cache_children_from_list(storage, parent_segments, parent.clone());
        // 再返回 list 结果（避免为了返回 entries 重复 list：这里直接再 list 一次，成本可接受；
        // 如需极致优化可把 entries 缓存下来一起返回）
        parent.list(storage)
    }

    fn ensure_root_descriptor(&self, root: Arc<dyn Provider>) -> Result<(), String> {
        let root_key = self.key_for_segments(&[]);
        if self.db_get_descriptor_by_key(&root_key)?.is_none() {
            let desc = root.descriptor();
            self.db_put_descriptor_by_key(&root_key, &desc)?;
        }
        if let Ok(mut lru) = self.lru.lock() {
            // root provider 放入 LRU，便于最长前缀回退
            lru.put(root_key, root);
        }
        Ok(())
    }

    /// 解析路径到 Provider（目录）。
    /// 若该路径未缓存，则从最长前缀开始不断 `list_and_cache_children` 刷新，直到解析到目标或无法推进。
    pub fn resolve_provider_for_root(
        &self,
        storage: &Storage,
        root: Arc<dyn Provider>,
        segments: &[&str],
    ) -> Result<Option<Arc<dyn Provider>>, String> {
        self.ensure_root_descriptor(root.clone())?;

        if segments.is_empty() {
            return Ok(Some(root));
        }

        // 找到最长前缀
        let Some((mut prefix_len, mut provider)) = self.find_longest_prefix_provider(segments)?
        else {
            // 理论上不应发生：ensure_root_descriptor 已写入 root key，并把 root 放入 LRU。
            let _ = self.list_and_cache_children(storage, &[], root.clone());
            return Ok(None);
        };

        // 若已经命中完整路径，直接返回
        if prefix_len == segments.len() {
            return Ok(Some(provider));
        }

        // 线性推进：每次用当前 prefix provider 刷新下一层，然后尝试获取 prefix_len+1 的 provider
        while prefix_len < segments.len() {
            let _ =
                self.list_and_cache_children(storage, &segments[..prefix_len], provider.clone());
            prefix_len += 1;
            let key = self.key_for_segments(&segments[..prefix_len]);
            let Some(p) = self.get_or_build_provider_by_key(&key)? else {
                // 列过目录仍拿不到下一层，说明路径不存在或该段不是目录
                return Ok(None);
            };
            provider = p;
        }

        Ok(Some(provider))
    }

    /// warm cache：递归扫描 provider 树，并把所有 provider 注册/落 Redis。
    ///
    /// 返回 root 的 descriptor（便于调试）。
    pub fn warm_cache(
        &self,
        storage: &Storage,
        root: Arc<dyn Provider>,
    ) -> Result<ProviderDescriptor, String> {
        // 写入 root key
        let root_key = self.key_for_segments(&[]);
        let root_desc = root.descriptor();
        self.db_put_descriptor_by_key(&root_key, &root_desc)?;
        if let Ok(mut lru) = self.lru.lock() {
            lru.put(root_key, root.clone());
        }
        let mut visited = 0usize;
        self.warm_recursive(storage, Vec::new(), root, &mut visited)?;
        Ok(root_desc)
    }

    fn warm_recursive(
        &self,
        storage: &Storage,
        parent_segments: Vec<String>,
        parent: Arc<dyn Provider>,
        visited: &mut usize,
    ) -> Result<(), String> {
        if *visited >= self.cfg.warm_max_nodes {
            return Err(format!(
                "warm cache exceeded max nodes: {}",
                self.cfg.warm_max_nodes
            ));
        }

        let parent_segs_ref: Vec<&str> = parent_segments.iter().map(|s| s.as_str()).collect();
        let children = self.cache_children_from_list(storage, &parent_segs_ref, parent.clone())?;
        for (name, child) in children {
            *visited += 1;
            let mut next = parent_segments.clone();
            next.push(name);
            self.warm_recursive(storage, next, child, visited)?;
        }
        Ok(())
    }
}
