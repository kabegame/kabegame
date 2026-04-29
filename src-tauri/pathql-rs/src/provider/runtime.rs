//! ProviderRuntime — 路径解析 + longest-prefix cache。
//!
//! ctx-passing 设计：runtime 持 `Weak<Self>`，方法入口构造 `ProviderContext`
//! (含 `Arc<Self>`) 在调用栈生命周期内传递；调用返回后 ctx drop，**不形成长期循环引用**。

use super::{ChildEntry, EngineError, Provider, ProviderContext, SqlExecutor};
use crate::compose::ProviderQuery;
use crate::template::eval::{TemplateContext, TemplateValue};
use crate::ProviderRegistry;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

/// 调试开关 (临时调试期强制开启, 调完移除): 设环境变量 `PATHQL_DEBUG=1` 启用,
/// 但当前为了排查 path 解析问题强制 always-on。
pub(crate) fn dbg_enabled() -> bool {
    true
}

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
    /// 注入的 SQL 执行能力 (6d 起强制必填; DSL 动态 list SQL 项 + 反查需要它)。
    executor: Arc<dyn SqlExecutor>,
    globals: Arc<HashMap<String, TemplateValue>>,
    /// 路径前缀 (`/seg₁/.../segₖ`) → CachedNode。
    /// 6a 简化: HashMap, 容量无限制; 后期可换 LRU 不影响接口。
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    /// 6d 起 executor 必填。测试 / 简单场景用 `pathql_rs::ClosureExecutor`。
    pub fn new(
        registry: Arc<ProviderRegistry>,
        root: Arc<dyn Provider>,
        executor: Arc<dyn SqlExecutor>,
        globals: HashMap<String, TemplateValue>,
    ) -> Arc<Self> {
        let globals = Arc::new(globals);
        Arc::new_cyclic(|weak| Self {
            registry,
            root,
            weak_self: weak.clone(),
            executor,
            globals,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn registry(&self) -> &ProviderRegistry {
        &self.registry
    }

    /// 注入的 executor (6d 起必有)。DslProvider 通过此方法访问执行能力。
    pub fn executor(&self) -> &Arc<dyn SqlExecutor> {
        &self.executor
    }

    /// 6e+: 返回 Arc 引用; 调用方 `.clone()` 仅是 refcount bump, 不复制 HashMap。
    pub fn globals(&self) -> &Arc<HashMap<String, TemplateValue>> {
        &self.globals
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

    /// 顶层路径解析 (6e: 移除 `resolve_with_initial`; 路径解析始终从 root cold-start
    /// 或命中 longest-prefix cache 续 fold; delegate 不再绕过缓存)。
    pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
        let segments = self.normalize_path(path);
        let ctx = self.make_ctx();

        let (start_idx, mut current, mut composed) =
            self.find_longest_cached_prefix(&segments, &ctx);

        if dbg_enabled() {
            eprintln!(
                "[pathql] resolve({:?}) — segments={:?} cache_start_idx={}",
                path, segments, start_idx
            );
        }

        // 早退: 完整路径已缓存
        if start_idx == segments.len() {
            if dbg_enabled() {
                eprintln!("[pathql]   ← full-path cache hit, return");
            }
            return Ok(ResolvedNode {
                provider: current,
                composed,
            });
        }

        // Resume / cold-start: 从 start_idx 续 fold 剩余段
        let mut path_so_far = build_path_key(&segments[..start_idx]);
        for seg in &segments[start_idx..] {
            path_so_far.push('/');
            path_so_far.push_str(seg);
            let resolved = current.resolve(seg, &composed, &ctx);
            if dbg_enabled() {
                eprintln!(
                    "[pathql]   step seg={:?} at path={:?} → {}",
                    seg,
                    path_so_far,
                    if resolved.is_some() {
                        "Some(provider)"
                    } else {
                        "None (PathNotFound)"
                    }
                );
            }
            let next = resolved.ok_or_else(|| EngineError::PathNotFound(path_so_far.clone()))?;
            composed = next.apply_query(composed, &ctx);
            current = next;
            // 缓存命中非 Empty 项写入; Empty 占位跳过。
            if !current.is_empty() {
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

    /// 顶层 meta 入口 (§12.3 typed meta wire 格式)。
    /// 语义: `/a/b/c` 的 meta = 父路径 `/a/b` list 输出中 `name == c` 的 ChildEntry.meta。
    /// root (`/`) 无父, 返回 None。
    pub fn meta(&self, path: &str) -> Result<Option<serde_json::Value>, EngineError> {
        let segments = self.normalize_path(path);
        if segments.is_empty() {
            return Ok(None);
        }
        let last = segments.last().unwrap().clone();
        let parent_path = if segments.len() == 1 {
            "/".to_string()
        } else {
            build_path_key(&segments[..segments.len() - 1])
        };
        let children = self.list(&parent_path)?;
        Ok(children
            .into_iter()
            .find(|c| c.name == last)
            .and_then(|c| c.meta))
    }

    /// 构造含 globals 的 TemplateContext (Arc 共享, 不复制 HashMap)。
    /// fetch / count 内部用; 也可被外部调用方在需要原始 ProviderQuery + ctx 时复用。
    fn template_context(&self) -> TemplateContext {
        let mut ctx = TemplateContext::default();
        ctx.globals = self.globals.clone();
        ctx
    }

    /// 路径 → 行集 (path-only 公开 API; 调用方不持 ProviderQuery / TemplateContext)。
    /// 内部链路: resolve(path) → composed.build_sql(globals ctx, dialect) → executor.execute。
    pub fn fetch(&self, path: &str) -> Result<Vec<serde_json::Value>, EngineError> {
        let node = self.resolve(path)?;
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (sql, values) = node
            .composed
            .build_sql(&ctx, dialect)
            .map_err(|e| {
                EngineError::FactoryFailed(
                    "<runtime>".into(),
                    "fetch".into(),
                    e.to_string(),
                )
            })?;
        self.executor.execute(&sql, &values)
    }

    /// 路径 → 行数 (`SELECT COUNT(*) FROM (<inner>) AS pq_sub`)。
    /// pq_sub 别名硬编码; 与用户表别名重名概率近 0。
    pub fn count(&self, path: &str) -> Result<usize, EngineError> {
        let node = self.resolve(path)?;
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (inner_sql, values) = node
            .composed
            .build_sql(&ctx, dialect)
            .map_err(|e| {
                EngineError::FactoryFailed(
                    "<runtime>".into(),
                    "count".into(),
                    e.to_string(),
                )
            })?;
        let sql = format!("SELECT COUNT(*) AS n FROM ({}) AS pq_sub", inner_sql);
        let rows = self.executor.execute(&sql, &values)?;
        let n = rows
            .first()
            .and_then(|row| row.get("n"))
            .and_then(|v| v.as_u64())
            .ok_or_else(|| {
                EngineError::FactoryFailed(
                    "<runtime>".into(),
                    "count".into(),
                    "COUNT(*) returned no row or non-integer".into(),
                )
            })?;
        Ok(n as usize)
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

    /// 测试默认 executor: 不期望被调到 (无动态 SQL list 的纯路由测试场景)。
    fn no_op_executor() -> Arc<dyn crate::provider::SqlExecutor> {
        Arc::new(crate::provider::ClosureExecutor::new(
            crate::provider::SqlDialect::Sqlite,
            |_sql, _params| Ok(Vec::new()),
        ))
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
        let runtime =
            ProviderRuntime::new(empty_registry(), root, no_op_executor(), HashMap::new());
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
        let runtime =
            ProviderRuntime::new(empty_registry(), root, no_op_executor(), HashMap::new());
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
        let runtime = ProviderRuntime::new(
            empty_registry(),
            Arc::new(N),
            no_op_executor(),
            HashMap::new(),
        );
        let n = runtime.note("/").unwrap();
        assert_eq!(n, Some("hello".into()));
    }

    #[test]
    fn meta_returns_none_for_root() {
        let (runtime, _) = three_layer_runtime();
        let m = runtime.meta("/").unwrap();
        assert!(m.is_none());
    }

    #[test]
    fn meta_reads_parents_list_child_meta() {
        // root.list returns a child "k" with meta {"foo":"bar"}
        struct Inner;
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
                _: &str,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Option<Arc<dyn Provider>> {
                None
            }
        }
        struct Holder {
            child: Arc<dyn Provider>,
        }
        impl Provider for Holder {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ChildEntry>, EngineError> {
                Ok(vec![ChildEntry {
                    name: "k".into(),
                    provider: Some(self.child.clone()),
                    meta: Some(serde_json::json!({"foo":"bar"})),
                }])
            }
            fn resolve(
                &self,
                name: &str,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Option<Arc<dyn Provider>> {
                if name == "k" {
                    Some(self.child.clone())
                } else {
                    None
                }
            }
        }
        let leaf: Arc<dyn Provider> = Arc::new(Inner);
        let root = Arc::new(Holder { child: leaf });
        let runtime =
            ProviderRuntime::new(empty_registry(), root, no_op_executor(), HashMap::new());
        let m = runtime.meta("/k").unwrap();
        assert_eq!(m.unwrap(), serde_json::json!({"foo":"bar"}));
    }

    #[test]
    fn meta_returns_none_when_child_meta_unset() {
        let (runtime, _) = three_layer_runtime();
        // CountingProvider.list returns ChildEntry with meta=None
        let m = runtime.meta("/b").unwrap();
        assert!(m.is_none());
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
        let runtime =
            ProviderRuntime::new(empty_registry(), root, no_op_executor(), HashMap::new());
        let _ = runtime
            .resolve("/%E6%8C%89%E7%94%BB%E5%86%8C")
            .expect("percent-decoded path should resolve");
    }

    // ── S1e S1: fetch(path) / count(path) ────────────────────────────────

    /// 一个用 `from = images` 的简单叶子 provider, 配合 capturing executor 验证 fetch / count
    /// 拼出的 SQL 与 Rust 看到的一致。
    struct ImagesLeaf;
    impl Provider for ImagesLeaf {
        fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
            q.from = Some(crate::ast::SqlExpr("images".into()));
            q
        }
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
    }

    /// 记录 (sql, params) + 按 sql 子串返回伪行集的 executor。
    struct CapturingExecutor {
        captured: std::sync::Mutex<Vec<(String, Vec<TemplateValue>)>>,
        rows_for_inner: Vec<serde_json::Value>,
        rows_for_count: Vec<serde_json::Value>,
    }
    impl crate::provider::SqlExecutor for CapturingExecutor {
        fn dialect(&self) -> crate::provider::SqlDialect {
            crate::provider::SqlDialect::Sqlite
        }
        fn execute(
            &self,
            sql: &str,
            params: &[TemplateValue],
        ) -> Result<Vec<serde_json::Value>, EngineError> {
            self.captured
                .lock()
                .unwrap()
                .push((sql.to_string(), params.to_vec()));
            // count wrapper 总以 "SELECT COUNT(*) AS n" 开头
            if sql.starts_with("SELECT COUNT(*) AS n") {
                Ok(self.rows_for_count.clone())
            } else {
                Ok(self.rows_for_inner.clone())
            }
        }
    }

    #[test]
    fn fetch_resolves_path_then_executes() {
        let exec = Arc::new(CapturingExecutor {
            captured: std::sync::Mutex::new(Vec::new()),
            rows_for_inner: vec![
                serde_json::json!({"id": 1}),
                serde_json::json!({"id": 2}),
            ],
            rows_for_count: vec![],
        });
        let root: Arc<dyn Provider> = Arc::new(ImagesLeaf);
        let runtime = ProviderRuntime::new(
            empty_registry(),
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
            HashMap::new(),
        );

        let rows = runtime.fetch("/").expect("fetch ok");
        assert_eq!(rows.len(), 2);
        let captured = exec.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        // inner SQL 不带 COUNT wrapper
        assert!(captured[0].0.contains("FROM images"), "sql: {}", captured[0].0);
        assert!(!captured[0].0.contains("COUNT(*)"), "sql: {}", captured[0].0);
    }

    #[test]
    fn count_wraps_with_count_star() {
        let exec = Arc::new(CapturingExecutor {
            captured: std::sync::Mutex::new(Vec::new()),
            rows_for_inner: vec![],
            rows_for_count: vec![serde_json::json!({"n": 42})],
        });
        let root: Arc<dyn Provider> = Arc::new(ImagesLeaf);
        let runtime = ProviderRuntime::new(
            empty_registry(),
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
            HashMap::new(),
        );

        let n = runtime.count("/").expect("count ok");
        assert_eq!(n, 42);
        let captured = exec.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let sql = &captured[0].0;
        assert!(sql.starts_with("SELECT COUNT(*) AS n FROM ("), "sql: {}", sql);
        assert!(sql.contains("FROM images"), "inner sql missing: {}", sql);
        assert!(sql.ends_with(") AS pq_sub"), "sql: {}", sql);
    }

    #[test]
    fn fetch_returns_empty_on_limit_zero() {
        // limit=0 让 SQLite 返回 0 行; executor stub 也返回空 → fetch 返回空 Vec。
        struct LimitZeroLeaf;
        impl Provider for LimitZeroLeaf {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.from = Some(crate::ast::SqlExpr("images".into()));
                q.limit = Some(crate::ast::NumberOrTemplate::Number(0.0));
                q
            }
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
        }
        let exec = Arc::new(CapturingExecutor {
            captured: std::sync::Mutex::new(Vec::new()),
            rows_for_inner: vec![],
            rows_for_count: vec![serde_json::json!({"n": 0})],
        });
        let root: Arc<dyn Provider> = Arc::new(LimitZeroLeaf);
        let runtime = ProviderRuntime::new(
            empty_registry(),
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
            HashMap::new(),
        );

        let rows = runtime.fetch("/").expect("fetch ok");
        assert!(rows.is_empty());
        let captured = exec.captured.lock().unwrap();
        assert!(captured[0].0.contains("LIMIT"), "sql: {}", captured[0].0);
    }
}
