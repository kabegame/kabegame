//! ProviderRuntime — 路径解析 + longest-prefix cache。
//!
//! ctx-passing 设计：runtime 持 `Weak<Self>`，方法入口构造 `ProviderContext`
//! (含 `Arc<Self>`) 在调用栈生命周期内传递；调用返回后 ctx drop，**不形成长期循环引用**。

use super::{ChildEntry, EngineError, Provider, ProviderContext};
use crate::compose::ProviderQuery;
use crate::ProviderRegistry;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

pub struct ResolvedNode {
    pub provider: Arc<dyn Provider>,
    pub composed: ProviderQuery,
}

impl std::fmt::Debug for ResolvedNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedNode")
            .field("provider", &"<Provider>")
            .field("composed", &self.composed)
            .finish()
    }
}

#[derive(Clone)]
struct CachedNode {
    provider: Arc<dyn Provider>,
    composed: ProviderQuery,
}

pub struct ProviderRuntime {
    registry: Arc<ProviderRegistry>,
    root: Arc<dyn Provider>,
    weak_self: Weak<Self>,
    /// 路径前缀 (`/seg₁/.../segₖ`) → CachedNode。
    /// 6a 简化：HashMap, 容量无限制；后期可换 LRU 不影响接口。
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    pub fn new(registry: Arc<ProviderRegistry>, root: Arc<dyn Provider>) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            registry,
            root,
            weak_self: weak.clone(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn registry(&self) -> &ProviderRegistry {
        &self.registry
    }

    /// 在路径解析入口构造 ctx; ctx 持 Arc<Self> 在调用栈生命期内存活。
    fn make_ctx(&self) -> ProviderContext {
        ProviderContext {
            registry: self.registry.clone(),
            runtime: self
                .weak_self
                .upgrade()
                .expect("ProviderRuntime weak_self upgrade failed (runtime dropped during call?)"),
        }
    }

    /// 顶层路径解析。
    pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
        self.resolve_with_initial(path, None)
    }

    /// 指定可选起点 ProviderQuery 的路径解析。
    /// - `initial = None` 走标准路径 (含 longest-prefix cache lookup)
    /// - `initial = Some(state)` 跳过缓存, 从给定 state cold-start fold (DslProvider DelegateQuery 用)
    pub fn resolve_with_initial(
        &self,
        path: &str,
        initial: Option<ProviderQuery>,
    ) -> Result<ResolvedNode, EngineError> {
        let segments = self.normalize_path(path);
        let ctx = self.make_ctx();
        let initial_provided = initial.is_some();

        // === Longest-prefix cache lookup ===
        // 仅 initial == None 时启用; 否则强制 cold start。
        let (start_idx, mut current, mut composed) = match initial {
            None => self.find_longest_cached_prefix(&segments, &ctx),
            Some(q) => {
                let q = self.root.apply_query(q, &ctx);
                (0usize, self.root.clone(), q)
            }
        };

        // === 早退: 完整路径已缓存 ===
        if start_idx == segments.len() {
            return Ok(ResolvedNode {
                provider: current,
                composed,
            });
        }

        // === Resume / cold-start: 从 start_idx 续 fold 剩余段 ===
        let mut path_so_far = build_path_key(&segments[..start_idx]);
        for seg in &segments[start_idx..] {
            path_so_far.push('/');
            path_so_far.push_str(seg);
            let next = current
                .resolve(seg, &composed, &ctx)
                .ok_or_else(|| EngineError::PathNotFound(path_so_far.clone()))?;
            composed = next.apply_query(composed, &ctx);
            current = next;
            // 缓存: 命中非 Empty 且非 cold-start-from-initial → 写入; 否则跳过。
            if !current.is_empty() && !initial_provided {
                self.cache.lock().unwrap().insert(
                    path_so_far.clone(),
                    CachedNode {
                        provider: current.clone(),
                        composed: composed.clone(),
                    },
                );
            }
        }

        Ok(ResolvedNode {
            provider: current,
            composed,
        })
    }

    /// 从最长前缀向短回退, 找到第一个缓存命中点。
    /// 返回 (起点 segment 索引, 起点 provider, 起点 composed)。
    /// - prefix_len=N (== segments.len()) → 完整路径已缓存
    /// - prefix_len=K (0<K<N) → 命中 /seg₁/.../segₖ 缓存, 续 fold segₖ₊₁..
    /// - prefix_len=0 → 全 miss, cold start (从 root 起 fold)
    fn find_longest_cached_prefix(
        &self,
        segments: &[String],
        ctx: &ProviderContext,
    ) -> (usize, Arc<dyn Provider>, ProviderQuery) {
        let cache = self.cache.lock().unwrap();
        for prefix_len in (1..=segments.len()).rev() {
            let key = build_path_key(&segments[..prefix_len]);
            if let Some(cached) = cache.get(&key) {
                return (prefix_len, cached.provider.clone(), cached.composed.clone());
            }
        }
        drop(cache);
        // 全 miss: 从 root cold start
        let composed = self.root.apply_query(ProviderQuery::new(), ctx);
        (0, self.root.clone(), composed)
    }

    /// 顶层 list 入口。
    pub fn list(&self, path: &str) -> Result<Vec<ChildEntry>, EngineError> {
        let node = self.resolve(path)?;
        node.provider.list(&node.composed, &self.make_ctx())
    }

    /// 顶层 get_note 入口。
    pub fn note(&self, path: &str) -> Result<Option<String>, EngineError> {
        let node = self.resolve(path)?;
        Ok(node.provider.get_note(&node.composed, &self.make_ctx()))
    }

    /// 路径段 normalize: percent-decode, 不做 lowercase 折叠 (§2 大小写敏感)。
    fn normalize_path(&self, path: &str) -> Vec<String> {
        path.trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| {
                percent_encoding::percent_decode_str(s)
                    .decode_utf8_lossy()
                    .into_owned()
            })
            .collect()
    }

    pub fn cache_size(&self) -> usize {
        self.cache.lock().unwrap().len()
    }

    pub fn clear_cache(&self) {
        self.cache.lock().unwrap().clear();
    }
}

fn build_path_key(segments: &[String]) -> String {
    let mut s = String::new();
    for seg in segments {
        s.push('/');
        s.push_str(seg);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::SqlExpr;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 计数 apply_query 调用次数, 验证 longest-prefix cache 行为。
    struct CountingProvider {
        from: Option<String>,
        children: Vec<(String, Arc<dyn Provider>)>,
        apply_count: Arc<AtomicU32>,
    }

    impl Provider for CountingProvider {
        fn apply_query(&self, mut q: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
            self.apply_count.fetch_add(1, Ordering::SeqCst);
            if let Some(t) = &self.from {
                q.from = Some(SqlExpr(t.clone()));
            }
            q
        }
        fn list(
            &self,
            _: &ProviderQuery,
            _: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(self
                .children
                .iter()
                .map(|(name, p)| ChildEntry {
                    name: name.clone(),
                    provider: Some(p.clone()),
                    meta: None,
                })
                .collect())
        }
        fn resolve(
            &self,
            name: &str,
            _: &ProviderQuery,
            _: &ProviderContext,
        ) -> Option<Arc<dyn Provider>> {
            self.children
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, p)| p.clone())
        }
    }

    fn empty_registry() -> Arc<ProviderRegistry> {
        Arc::new(ProviderRegistry::new())
    }

    fn three_layer_runtime() -> (Arc<ProviderRuntime>, Arc<AtomicU32>) {
        let counter = Arc::new(AtomicU32::new(0));
        let leaf = Arc::new(CountingProvider {
            from: Some("leaf_table".into()),
            children: vec![],
            apply_count: counter.clone(),
        });
        let mid = Arc::new(CountingProvider {
            from: None,
            children: vec![("c".into(), leaf as Arc<dyn Provider>)],
            apply_count: counter.clone(),
        });
        let root = Arc::new(CountingProvider {
            from: Some("root_table".into()),
            children: vec![("b".into(), mid as Arc<dyn Provider>)],
            apply_count: counter.clone(),
        });
        let runtime = ProviderRuntime::new(empty_registry(), root);
        (runtime, counter)
    }

    #[test]
    fn resolves_root() {
        let (runtime, _) = three_layer_runtime();
        let r = runtime.resolve("/").unwrap();
        assert_eq!(r.composed.from.unwrap().0, "root_table");
    }

    #[test]
    fn resolves_one_level() {
        let (runtime, _) = three_layer_runtime();
        let r = runtime.resolve("/b").unwrap();
        // mid has from=None, so root_table cascades through (mid does set q.from to None? No: it sets from only if Some)
        // Actually mid's apply_query keeps current.from since its from is None
        assert_eq!(r.composed.from.unwrap().0, "root_table");
    }

    #[test]
    fn resolves_three_levels() {
        let (runtime, _) = three_layer_runtime();
        let r = runtime.resolve("/b/c").unwrap();
        // leaf overrides from to "leaf_table"
        assert_eq!(r.composed.from.unwrap().0, "leaf_table");
    }

    #[test]
    fn path_not_found_at_first_level() {
        let (runtime, _) = three_layer_runtime();
        let err = runtime.resolve("/missing").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(p) if p == "/missing"));
    }

    #[test]
    fn path_not_found_at_deeper_level() {
        let (runtime, _) = three_layer_runtime();
        let err = runtime.resolve("/b/missing").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(p) if p == "/b/missing"));
    }

    #[test]
    fn caches_resolves_correctly() {
        let (runtime, _) = three_layer_runtime();
        runtime.resolve("/b/c").unwrap();
        // /b and /b/c cached
        assert_eq!(runtime.cache_size(), 2);
        // re-resolve doesn't grow cache
        runtime.resolve("/b/c").unwrap();
        assert_eq!(runtime.cache_size(), 2);
    }

    #[test]
    fn no_cache_pollution_on_path_not_found() {
        let (runtime, _) = three_layer_runtime();
        let _ = runtime.resolve("/missing");
        assert_eq!(runtime.cache_size(), 0);
    }

    #[test]
    fn case_sensitive_paths() {
        let (runtime, _) = three_layer_runtime();
        // children["b"] exists, /B does not
        let err = runtime.resolve("/B").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(_)));
    }

    #[test]
    fn list_dispatches_to_provider() {
        let (runtime, _) = three_layer_runtime();
        let children = runtime.list("/b").unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "c");
    }

    #[test]
    fn longest_prefix_full_path_hit_zero_apply() {
        let (runtime, counter) = three_layer_runtime();
        runtime.resolve("/b/c").unwrap();
        let after_first = counter.load(Ordering::SeqCst);
        runtime.resolve("/b/c").unwrap();
        let after_second = counter.load(Ordering::SeqCst);
        // second call hits cached /b/c; no apply_query needed
        assert_eq!(after_second - after_first, 0);
    }

    #[test]
    fn longest_prefix_partial_hit_resumes() {
        let (runtime, counter) = three_layer_runtime();
        runtime.resolve("/b").unwrap(); // caches /b
        let after_first = counter.load(Ordering::SeqCst);
        runtime.resolve("/b/c").unwrap(); // resumes from /b
        let after_second = counter.load(Ordering::SeqCst);
        // only c segment's apply_query runs
        assert_eq!(after_second - after_first, 1);
    }

    #[test]
    fn longest_prefix_finds_longest_not_first() {
        let (runtime, counter) = three_layer_runtime();
        runtime.resolve("/b").unwrap();
        runtime.resolve("/b/c").unwrap();
        let before = counter.load(Ordering::SeqCst);
        // resolve /b/c again — should hit the LONGEST cache (/b/c), not /b
        runtime.resolve("/b/c").unwrap();
        let after = counter.load(Ordering::SeqCst);
        assert_eq!(after - before, 0);
    }

    #[test]
    fn longest_prefix_cache_invalidates_after_clear() {
        let (runtime, counter) = three_layer_runtime();
        runtime.resolve("/b/c").unwrap();
        let cold_count = counter.load(Ordering::SeqCst);
        runtime.clear_cache();
        runtime.resolve("/b/c").unwrap();
        let after_clear = counter.load(Ordering::SeqCst);
        // after clearing cache, full cold start again — same number of apply_query calls
        assert_eq!(after_clear - cold_count, cold_count);
    }

    #[test]
    fn empty_provider_does_not_cache() {
        // Build a chain where /a is an EmptyDslProvider (is_empty=true)
        struct Holder {
            children: Vec<(String, Arc<dyn Provider>)>,
        }
        impl Provider for Holder {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ChildEntry>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(
                &self,
                name: &str,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Option<Arc<dyn Provider>> {
                self.children
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, p)| p.clone())
            }
        }
        let empty_provider: Arc<dyn Provider> =
            Arc::new(crate::provider::dsl_provider::EmptyDslProvider);
        let root = Arc::new(Holder {
            children: vec![("e".into(), empty_provider.clone())],
        });
        let runtime = ProviderRuntime::new(empty_registry(), root);
        runtime.resolve("/e").unwrap();
        // Empty provider hit doesn't cache
        assert_eq!(runtime.cache_size(), 0);
    }

    #[test]
    fn note_dispatches_to_provider() {
        struct N;
        impl Provider for N {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ChildEntry>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(
                &self,
                _: &str,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Option<Arc<dyn Provider>> {
                None
            }
            fn get_note(&self, _: &ProviderQuery, _: &ProviderContext) -> Option<String> {
                Some("hello".into())
            }
        }
        let runtime = ProviderRuntime::new(empty_registry(), Arc::new(N));
        let n = runtime.note("/").unwrap();
        assert_eq!(n, Some("hello".into()));
    }

    #[test]
    fn percent_decode_path_segments() {
        // simulate /vd/i18n-zh_CN/%E6%8C%89%E7%94%BB%E5%86%8C  (UTF-8 percent-encoded "按画册")
        struct Inner {
            children: Vec<(String, Arc<dyn Provider>)>,
        }
        impl Provider for Inner {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ChildEntry>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(
                &self,
                name: &str,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Option<Arc<dyn Provider>> {
                self.children
                    .iter()
                    .find(|(n, _)| n == name)
                    .map(|(_, p)| p.clone())
            }
        }
        let leaf: Arc<dyn Provider> = Arc::new(Inner { children: vec![] });
        let root = Arc::new(Inner {
            children: vec![("按画册".into(), leaf)],
        });
        let runtime = ProviderRuntime::new(empty_registry(), root);
        let _ = runtime
            .resolve("/%E6%8C%89%E7%94%BB%E5%86%8C")
            .expect("percent-decoded path should resolve");
    }

}
