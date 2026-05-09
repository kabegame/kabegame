//! ProviderRuntime — 路径解析 + longest-prefix cache。
//!
//! ctx-passing 设计：runtime 持 `Weak<Self>`，方法入口构造 `ProviderContext`
//! (含 `Arc<Self>`) 在调用栈生命周期内传递；调用返回后 ctx drop，**不形成长期循环引用**。

use arc_swap::ArcSwap;

use super::{
    ChildEntry, DelegateTransform, EngineError, ListRef, Provider, ProviderContext, ProviderKey,
    ResolveRef, SqlExecutor,
};
use crate::ast::{Namespace, ProviderName};
use crate::compose::ProviderQuery;
use crate::template::eval::{TemplateContext, TemplateValue};
#[cfg(feature = "json5")]
use crate::LoaderType;
#[cfg(feature = "json5")]
use crate::Source;
#[cfg(feature = "json5")]
use crate::{Json5Loader, Loader};
use crate::{ProviderDef, ProviderRegistry};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// 调试开关: 设环境变量 `PATHQL_DEBUG=1` 启用。
pub(crate) fn dbg_enabled() -> bool {
    std::env::var("PATHQL_DEBUG").ok().as_deref() == Some("1")
}

pub struct ResolvedNode {
    pub provider: Option<Arc<dyn Provider>>,
    pub composed: ProviderQuery,
    pub(crate) provider_keys: Vec<ProviderKey>,
}

impl std::fmt::Debug for ResolvedNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedNode")
            .field("provider", &self.provider.as_ref().map(|_| "<Provider>"))
            .field("composed", &self.composed)
            .field("provider_keys", &self.provider_keys)
            .finish()
    }
}

#[derive(Clone)]
struct CachedNode {
    provider: Option<Arc<dyn Provider>>,
    composed: ProviderQuery,
    provider_keys: Vec<ProviderKey>,
}

#[derive(Clone)]
struct RootNode {
    provider: Arc<dyn Provider>,
    provider_keys: Vec<ProviderKey>,
}

pub struct ProviderRuntime {
    registry: ArcSwap<ProviderRegistry>,
    // 只能定义一次的root
    root: OnceLock<RootNode>,
    // 用来构建上下文
    weak_self: Weak<Self>,
    /// 注入的 SQL 执行能力 (6d 起强制必填; DSL 动态 list SQL 项 + 反查需要它)。
    executor: Arc<dyn SqlExecutor>,
    globals: Arc<HashMap<String, TemplateValue>>,
    /// 路径前缀 (`/seg₁/.../segₖ`) → CachedNode。
    /// 6a 简化: HashMap, 容量无限制; 后期可换 LRU 不影响接口。
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    /// executor 必填。测试 / 简单场景用 `pathql_rs::ClosureExecutor`。
    pub fn new(
        executor: Arc<dyn SqlExecutor>,
        globals: HashMap<String, TemplateValue>,
    ) -> Arc<Self> {
        Self::with_registry(Arc::new(ProviderRegistry::new()), executor, globals)
    }

    pub fn with_registry(
        registry: Arc<ProviderRegistry>,
        executor: Arc<dyn SqlExecutor>,
        globals: HashMap<String, TemplateValue>,
    ) -> Arc<Self> {
        let globals = Arc::new(globals);
        Arc::new_cyclic(|weak| Self {
            registry: ArcSwap::from(registry),
            root: OnceLock::new(),
            weak_self: weak.clone(),
            executor,
            globals,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn set_root(&self, namespace: &str, simple_name: &str) -> Result<(), EngineError> {
        let ctx = self.make_ctx();
        let key_mark = ctx.provider_key_mark();
        let root = ctx.registry.instantiate_result(
            &Namespace(namespace.to_string()),
            &ProviderName(simple_name.to_string()),
            &HashMap::new(),
            &ctx,
        )?;
        self.root
            .set(RootNode {
                provider: root,
                provider_keys: ctx.provider_keys_since(key_mark),
            })
            .map_err(|_| EngineError::RootAlreadyInitialized)
    }

    /// 动态注册一个dsl
    #[cfg(feature = "json5")]
    pub fn register_provider_dsl(
        &self,
        loader_type: LoaderType,
        source: Source<'_>,
    ) -> Result<(), EngineError> {
        let mut registry = (*self.registry.load_full()).clone();
        let provider = match loader_type {
            #[cfg(feature = "json5")]
            LoaderType::JSON5 => Json5Loader {}.load(source),
        }?;
        let key = provider_key_from_def(&provider);
        registry.register(provider)?;

        self.registry.store(Arc::new(registry));
        self.invalidate_provider_cache(&key);
        Ok(())
    }

    /// 动态注册一个 provider
    pub fn register_provider(&self, provider: ProviderDef) -> Result<(), EngineError> {
        let mut registry = (*self.registry.load_full()).clone();
        let key = provider_key_from_def(&provider);
        registry.register(provider)?;
        self.registry.store(Arc::new(registry));
        self.invalidate_provider_cache(&key);
        Ok(())
    }

    /// 动态注销一个 provider。返回 true 表示确实移除了条目。
    pub fn unregister_provider(&self, namespace: &str, simple_name: &str) -> bool {
        let mut registry = (*self.registry.load_full()).clone();
        let removed = registry.unregister(
            Namespace(namespace.to_string()),
            crate::ast::SimpleName(simple_name.to_string()),
        );
        if removed {
            self.registry.store(Arc::new(registry));
            self.invalidate_provider_cache(&ProviderKey::new(namespace, simple_name));
        }
        removed
    }

    #[cfg(feature = "validate")]
    pub fn validate(
        &self,
        cfg: &crate::validate::ValidateConfig,
    ) -> Result<(), Vec<crate::validate::ValidateError>> {
        let registry = self.registry.load_full();
        crate::validate::validate(&registry, cfg)
    }

    fn invalidate_provider_cache(&self, key: &ProviderKey) {
        self.cache
            .lock()
            .unwrap()
            .retain(|_, node| !node.provider_keys.iter().any(|node_key| node_key == key));
    }

    /// 注入的 executor (6d 起必有)。DslProvider 通过此方法访问执行能力。
    pub fn executor(&self) -> &Arc<dyn SqlExecutor> {
        &self.executor
    }

    /// 返回 Arc 引用; 调用方 `.clone()` 仅是 refcount bump, 不复制 HashMap。
    pub fn globals(&self) -> &Arc<HashMap<String, TemplateValue>> {
        &self.globals
    }

    /// 在路径解析入口构造 ctx; ctx 持 Arc<Self> 在调用栈生命期内存活。
    fn make_ctx(&self) -> ProviderContext {
        ProviderContext::new(
            self.registry.load_full(),
            self.weak_self
                .upgrade()
                .expect("ProviderRuntime weak_self upgrade failed (runtime dropped during call?)"),
        )
    }

    /// 顶层路径解析 (6e: 移除 `resolve_with_initial`; 路径解析始终从 root cold-start
    /// 或命中 longest-prefix cache 续 fold; delegate 不再绕过缓存)。
    pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
        let segments = self.normalize_path(path);
        let ctx = self.make_ctx();

        let (start_idx, mut current, mut composed, mut provider_keys) =
            self.find_longest_cached_prefix(&segments, &ctx)?;

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
                provider_keys,
            });
        }

        // Resume / cold-start: 从 start_idx 续 fold 剩余段
        let mut path_so_far = build_path_key(&segments[..start_idx]);
        for seg in &segments[start_idx..] {
            let path_before_seg = path_so_far.clone();
            path_so_far.push('/');
            path_so_far.push_str(seg);
            let key_mark = ctx.provider_key_mark();
            let c = current
                .as_ref()
                .ok_or_else(|| EngineError::PathNotFound(path_so_far.clone()))?;

            let mut resolve_provider: Arc<dyn Provider> = c.clone();
            let mut seg_composed = composed.clone();
            let mut transform_stack: Vec<DelegateTransform> = Vec::new();

            let terminal: Option<ChildEntry> = loop {
                let resolved = resolve_provider.resolve(seg, &seg_composed, &ctx);
                if dbg_enabled() {
                    eprintln!(
                        "[pathql]   step seg={:?} at path={:?} → {}",
                        seg,
                        path_so_far,
                        match &resolved {
                            ResolveRef::Terminal(Some(child)) if child.provider.is_some() => {
                                "Terminal(Some(child.provider))"
                            }
                            ResolveRef::Terminal(Some(_)) => {
                                "Terminal(Some(child without provider))"
                            }
                            ResolveRef::Terminal(None) => "Terminal(None)",
                            ResolveRef::Delegate { .. } => "Delegate",
                        }
                    );
                }
                match resolved {
                    ResolveRef::Terminal(opt) => break opt,
                    ResolveRef::Delegate { target, transform } => {
                        transform_stack.push(transform);
                        seg_composed = target.apply_query(seg_composed, &ctx);
                        resolve_provider = target;
                    }
                }
            };

            let no_delegate = transform_stack.is_empty();
            let mut from_list_fallback = false;
            let raw_child = if terminal.is_some() {
                terminal
            } else {
                let list_key_mark = ctx.provider_key_mark();
                let list_refs = resolve_provider.list(&seg_composed, &ctx)?;
                let list_provider_keys = ctx.provider_keys_since(list_key_mark);
                let expanded = self.expand_list_refs(
                    list_refs,
                    &path_before_seg,
                    &seg_composed,
                    &provider_keys,
                    &list_provider_keys,
                    &ctx,
                    no_delegate,
                )?;
                let found = expanded.into_iter().find(|ch| ch.name == seg.as_str());
                from_list_fallback = found.is_some();
                found
            };

            let mut final_child = raw_child;
            for transform in transform_stack.into_iter().rev() {
                final_child = transform(final_child.as_ref(), &ctx);
            }

            if final_child.is_none() {
                return Err(EngineError::PathNotFound(path_so_far.clone()));
            }

            if from_list_fallback && no_delegate {
                let cached = self.cache.lock().unwrap().get(&path_so_far).cloned();
                if let Some(cn) = cached {
                    current = cn.provider;
                    composed = cn.composed;
                    extend_provider_keys(&mut provider_keys, cn.provider_keys);
                    continue;
                }
            }

            let next_opt = final_child.and_then(|ch| ch.provider);
            if let Some(next) = &next_opt {
                composed = next.apply_query(seg_composed, &ctx);
            } else {
                composed = seg_composed;
            }
            current = next_opt;
            extend_provider_keys(&mut provider_keys, ctx.provider_keys_since(key_mark));
            // 缓存命中非 Empty 项写入; no-provider 节点也缓存。
            if current.as_ref().map(|p| !p.is_empty()).unwrap_or(true) {
                self.cache.lock().unwrap().insert(
                    path_so_far.clone(),
                    CachedNode {
                        provider: current.clone(),
                        composed: composed.clone(),
                        provider_keys: provider_keys.clone(),
                    },
                );
            }
        }

        Ok(ResolvedNode {
            provider: current,
            composed,
            provider_keys,
        })
    }

    fn get_root(&self) -> Result<RootNode, EngineError> {
        Ok(self
            .root
            .get()
            .ok_or(EngineError::RootNotInitialized)?
            .clone())
    }

    /// 从最长前缀向短回退, 找到第一个缓存命中点的下一个index（或者说命中seg段的长度）。
    /// 返回 (起点 segment 索引, 起点 provider, 起点 composed)。
    /// - prefix_len=N (== segments.len()) → 完整路径已缓存
    /// - prefix_len=K (0<K<N) → 命中 /seg₁/.../segₖ 缓存, 续 fold segₖ₊₁..
    /// - prefix_len=0 → 全 miss, cold start (从 root 起 fold)
    fn find_longest_cached_prefix(
        &self,
        segments: &[String],
        ctx: &ProviderContext,
    ) -> Result<
        (
            usize,
            Option<Arc<dyn Provider>>,
            ProviderQuery,
            Vec<ProviderKey>,
        ),
        EngineError,
    > {
        let cache = self.cache.lock().unwrap();
        for prefix_len in (1..=segments.len()).rev() {
            let key = build_path_key(&segments[..prefix_len]);
            if let Some(cached) = cache.get(&key) {
                return Ok((
                    prefix_len,
                    cached.provider.clone(),
                    cached.composed.clone(),
                    cached.provider_keys.clone(),
                ));
            }
        }
        drop(cache);
        let root_provider = self.get_root()?;
        // 全 miss: 从 root cold start
        let key_mark = ctx.provider_key_mark();
        let composed = root_provider
            .provider
            .apply_query(ProviderQuery::new(), ctx);
        let mut provider_keys = root_provider.provider_keys.clone();
        extend_provider_keys(&mut provider_keys, ctx.provider_keys_since(key_mark));
        Ok((0, Some(root_provider.provider), composed, provider_keys))
    }

    /// 顶层 list 入口。
    pub fn list(&self, path: &str) -> Result<Vec<ChildEntry>, EngineError> {
        let node = self.resolve(path)?;
        let provider = node
            .provider
            .ok_or_else(|| EngineError::NoProvider(path.to_string()))?;
        let ctx = self.make_ctx();
        let key_mark = ctx.provider_key_mark();
        let refs = provider.list(&node.composed, &ctx)?;
        let list_provider_keys = ctx.provider_keys_since(key_mark);
        self.expand_list_refs(
            refs,
            &canonical_path_key(path),
            &node.composed,
            &node.provider_keys,
            &list_provider_keys,
            &ctx,
            true,
        )
    }

    fn expand_list_refs(
        &self,
        list_refs: Vec<ListRef>,
        parent_path: &str,
        composed: &ProviderQuery,
        parent_keys: &[ProviderKey],
        list_provider_keys: &[ProviderKey],
        ctx: &ProviderContext,
        cache_expanded_children: bool,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let mut out = Vec::new();
        for list_ref in list_refs {
            match list_ref {
                ListRef::Direct(child) => out.push(child),
                ListRef::DelegateExpand { target, expand } => {
                    let target_composed = target.apply_query(composed.clone(), ctx);
                    let nested_key_mark = ctx.provider_key_mark();
                    let target_refs = target.list(&target_composed, ctx)?;
                    let mut inherited_keys = parent_keys.to_vec();
                    extend_provider_keys(&mut inherited_keys, list_provider_keys.to_vec());
                    extend_provider_keys(
                        &mut inherited_keys,
                        ctx.provider_keys_since(nested_key_mark),
                    );
                    let target_children = self.expand_list_refs(
                        target_refs,
                        parent_path,
                        &target_composed,
                        &inherited_keys,
                        &[],
                        ctx,
                        false,
                    )?;

                    for target_child in &target_children {
                        let child_key_mark = ctx.provider_key_mark();
                        if let Some(outer_child) = (expand)(target_child, ctx)? {
                            let (child_provider, child_composed, cacheable) =
                                if let Some(provider) = &outer_child.provider {
                                    let child_composed =
                                        provider.apply_query(target_composed.clone(), ctx);
                                    (Some(provider.clone()), child_composed, !provider.is_empty())
                                } else {
                                    (None, target_composed.clone(), true)
                                };
                            let mut child_keys = inherited_keys.clone();
                            extend_provider_keys(
                                &mut child_keys,
                                ctx.provider_keys_since(child_key_mark),
                            );

                            if cache_expanded_children && cacheable {
                                self.cache.lock().unwrap().insert(
                                    child_path_key(parent_path, &outer_child.name),
                                    CachedNode {
                                        provider: child_provider,
                                        composed: child_composed,
                                        provider_keys: child_keys,
                                    },
                                );
                            }
                            out.push(outer_child);
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    /// 顶层 get_note 入口。
    pub fn note(&self, path: &str) -> Result<Option<String>, EngineError> {
        let node = self.resolve(path)?;
        let provider = node
            .provider
            .ok_or_else(|| EngineError::NoProvider(path.to_string()))?;
        Ok(provider.get_note(&node.composed, &self.make_ctx()))
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
        if node.provider.is_none() {
            return Err(EngineError::NoProvider(path.to_string()));
        }
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (sql, values) = node.composed.build_sql(&ctx, dialect).map_err(|e| {
            EngineError::FactoryFailed("<runtime>".into(), "fetch".into(), e.to_string())
        })?;
        self.executor.execute(&sql, &values)
    }

    /// 路径 → 行数 (`SELECT COUNT(*) FROM (<inner>) AS pq_sub`)。
    /// pq_sub 别名硬编码; 与用户表别名重名概率近 0。
    pub fn count(&self, path: &str) -> Result<usize, EngineError> {
        let node = self.resolve(path)?;
        if node.provider.is_none() {
            return Err(EngineError::NoProvider(path.to_string()));
        }
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (inner_sql, values) = node.composed.build_sql(&ctx, dialect).map_err(|e| {
            EngineError::FactoryFailed("<runtime>".into(), "count".into(), e.to_string())
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

fn canonical_path_key(path: &str) -> String {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

fn child_path_key(parent_path: &str, child_name: &str) -> String {
    if parent_path.is_empty() {
        format!("/{child_name}")
    } else {
        format!("{parent_path}/{child_name}")
    }
}

fn provider_key_from_def(def: &ProviderDef) -> ProviderKey {
    ProviderKey::new(
        def.namespace.as_ref().map(|ns| ns.0.as_str()).unwrap_or(""),
        def.name.0.as_str(),
    )
}

fn extend_provider_keys(provider_keys: &mut Vec<ProviderKey>, new_keys: Vec<ProviderKey>) {
    for key in new_keys {
        if !provider_keys.iter().any(|existing| existing == &key) {
            provider_keys.push(key);
        }
    }
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
        ) -> Result<Vec<ListRef>, EngineError> {
            Ok(self
                .children
                .iter()
                .map(|(name, p)| {
                    ListRef::Direct(ChildEntry {
                        name: name.clone(),
                        provider: Some(p.clone()),
                        meta: None,
                    })
                })
                .collect())
        }
        fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
            ResolveRef::Terminal(self.children.iter().find(|(n, _)| n == name).map(|(n, p)| {
                ChildEntry {
                    name: n.clone(),
                    provider: Some(p.clone()),
                    meta: None,
                }
            }))
        }
    }

    struct NoteLeaf {
        note: &'static str,
        from: Option<&'static str>,
    }

    impl Provider for NoteLeaf {
        fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
            if let Some(from) = self.from {
                q.from = Some(SqlExpr(from.into()));
            }
            q
        }

        fn get_note(&self, _: &ProviderQuery, _: &ProviderContext) -> Option<String> {
            Some(self.note.into())
        }
    }

    fn note_leaf(note: &'static str, from: Option<&'static str>) -> Arc<dyn Provider> {
        Arc::new(NoteLeaf { note, from })
    }

    /// 测试默认 executor: 不期望被调到 (无动态 SQL list 的纯路由测试场景)。
    fn no_op_executor() -> Arc<dyn crate::provider::SqlExecutor> {
        Arc::new(crate::provider::ClosureExecutor::new(
            crate::provider::SqlDialect::Sqlite,
            |_sql, _params| Ok(Vec::new()),
        ))
    }

    fn runtime_with_root(root: Arc<dyn Provider>) -> Arc<ProviderRuntime> {
        runtime_with_root_and_executor(root, no_op_executor())
    }

    fn runtime_with_root_and_executor(
        root: Arc<dyn Provider>,
        executor: Arc<dyn crate::provider::SqlExecutor>,
    ) -> Arc<ProviderRuntime> {
        let mut registry = ProviderRegistry::new();
        let root_for_factory = root.clone();
        registry
            .register_provider(
                Namespace(String::new()),
                crate::ast::SimpleName("__root".into()),
                move |_| Ok(root_for_factory.clone()),
            )
            .unwrap();
        let runtime = ProviderRuntime::with_registry(Arc::new(registry), executor, HashMap::new());
        runtime.set_root("", "__root").unwrap();
        runtime
    }

    fn runtime_with_root_def(def: ProviderDef) -> Arc<ProviderRuntime> {
        let root_name = def.name.0.clone();
        let root_ns = def
            .namespace
            .as_ref()
            .map(|ns| ns.0.clone())
            .unwrap_or_default();
        let mut registry = ProviderRegistry::new();
        registry.register(def).unwrap();
        let runtime =
            ProviderRuntime::with_registry(Arc::new(registry), no_op_executor(), HashMap::new());
        runtime.set_root(&root_ns, &root_name).unwrap();
        runtime
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
        let runtime = runtime_with_root(root);
        (runtime, counter)
    }

    #[test]
    fn resolve_before_set_root_returns_error() {
        let runtime = ProviderRuntime::new(no_op_executor(), HashMap::new());
        let err = runtime.resolve("/").unwrap_err();
        assert!(matches!(err, EngineError::RootNotInitialized));
    }

    #[test]
    fn set_root_only_once() {
        let mut registry = ProviderRegistry::new();
        registry
            .register_provider(
                Namespace(String::new()),
                crate::ast::SimpleName("__root".into()),
                |_| Ok(Arc::new(ImagesLeaf)),
            )
            .unwrap();
        let runtime =
            ProviderRuntime::with_registry(Arc::new(registry), no_op_executor(), HashMap::new());
        runtime.set_root("", "__root").unwrap();
        let err = runtime.set_root("", "__root").unwrap_err();
        assert!(matches!(err, EngineError::RootAlreadyInitialized));
    }

    #[test]
    fn register_provider_updates_runtime_registry() {
        let root_def: ProviderDef = serde_json::from_str(
            r#"{
                "name": "root",
                "list": {
                    "child": { "provider": "child" }
                }
            }"#,
        )
        .unwrap();
        let child_def: ProviderDef = serde_json::from_str(
            r#"{
                "name": "child",
                "query": { "from": "dynamic_child_table" }
            }"#,
        )
        .unwrap();
        let runtime = runtime_with_root_def(root_def);

        let err = runtime.resolve("/child").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(p) if p == "/child"));

        runtime.register_provider(child_def).unwrap();
        let resolved = runtime.resolve("/child").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "dynamic_child_table");
    }

    #[test]
    fn unregister_provider_clears_cached_resolved_nodes() {
        let root_def: ProviderDef = serde_json::from_str(
            r#"{
                "name": "root",
                "list": {
                    "child": { "provider": "child" }
                }
            }"#,
        )
        .unwrap();
        let child_v1: ProviderDef = serde_json::from_str(
            r#"{
                "name": "child",
                "query": { "from": "child_v1" }
            }"#,
        )
        .unwrap();
        let child_v2: ProviderDef = serde_json::from_str(
            r#"{
                "name": "child",
                "query": { "from": "child_v2" }
            }"#,
        )
        .unwrap();
        let runtime = runtime_with_root_def(root_def);

        runtime.register_provider(child_v1).unwrap();
        let resolved = runtime.resolve("/child").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "child_v1");

        assert!(runtime.unregister_provider("", "child"));
        assert!(!runtime.unregister_provider("", "child"));
        runtime.register_provider(child_v2).unwrap();

        let resolved = runtime.resolve("/child").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "child_v2");
    }

    #[test]
    fn provider_invalidation_is_scoped_by_provider_key() {
        let root_def: ProviderDef = serde_json::from_str(
            r#"{
                "name": "root",
                "list": {
                    "one": { "provider": "one" },
                    "two": { "provider": "two" }
                }
            }"#,
        )
        .unwrap();
        let one_def: ProviderDef =
            serde_json::from_str(r#"{ "name": "one", "query": { "from": "one_table" } }"#).unwrap();
        let two_def: ProviderDef =
            serde_json::from_str(r#"{ "name": "two", "query": { "from": "two_table" } }"#).unwrap();
        let runtime = runtime_with_root_def(root_def);
        runtime.register_provider(one_def).unwrap();
        runtime.register_provider(two_def).unwrap();

        runtime.resolve("/one").unwrap();
        runtime.resolve("/two").unwrap();
        assert_eq!(runtime.cache_size(), 2);

        assert!(runtime.unregister_provider("", "one"));
        assert_eq!(runtime.cache_size(), 1);
        let resolved = runtime.resolve("/two").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "two_table");
    }

    #[cfg(feature = "json5")]
    #[test]
    fn register_provider_dsl_loads_and_updates_runtime_registry() {
        let root_def: ProviderDef = serde_json::from_str(
            r#"{
                "name": "root",
                "list": {
                    "json5_child": { "provider": "json5_child" }
                }
            }"#,
        )
        .unwrap();
        let runtime = runtime_with_root_def(root_def);

        runtime
            .register_provider_dsl(
                LoaderType::JSON5,
                Source::Str(
                    r#"{
                        // exercise JSON5 loader path
                        name: "json5_child",
                        query: { from: "json5_child_table" },
                    }"#,
                ),
            )
            .unwrap();

        let resolved = runtime.resolve("/json5_child").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "json5_child_table");
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
    fn delegate_expand_lists_transformed_child_and_caches_path_with_target_contrib() {
        struct Leaf;
        impl Provider for Leaf {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.from = Some(SqlExpr("leaf_table".into()));
                q
            }
        }

        struct Target;
        impl Provider for Target {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.fields.push(crate::compose::FieldFrag {
                    sql: SqlExpr("target_tags.name".into()),
                    alias: None,
                    in_need: true,
                });
                q
            }

            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "x".into(),
                    provider: None,
                    meta: Some(serde_json::json!({"page_num": 1})),
                })])
            }
        }

        struct Parent {
            target: Arc<dyn Provider>,
            leaf: Arc<dyn Provider>,
        }
        impl Provider for Parent {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                let leaf = self.leaf.clone();
                Ok(vec![ListRef::DelegateExpand {
                    target: self.target.clone(),
                    expand: Arc::new(move |child, _ctx| {
                        let page = child
                            .meta
                            .as_ref()
                            .and_then(|meta| meta.get("page_num"))
                            .and_then(|value| value.as_i64())
                            .unwrap();
                        Ok(Some(ChildEntry {
                            name: format!("page-{page}"),
                            provider: Some(leaf.clone()),
                            meta: child.meta.clone(),
                        }))
                    }),
                }])
            }
        }

        struct Root {
            parent: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "parent").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: Some(self.parent.clone()),
                    meta: None,
                }))
            }
        }

        let parent: Arc<dyn Provider> = Arc::new(Parent {
            target: Arc::new(Target),
            leaf: Arc::new(Leaf),
        });
        let runtime = runtime_with_root(Arc::new(Root { parent }));

        let children = runtime.list("/parent").unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "page-1");
        assert_eq!(runtime.cache_size(), 2);

        let resolved = runtime.resolve("/parent/page-1").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "leaf_table");
        assert!(resolved
            .composed
            .fields
            .iter()
            .any(|field| field.sql.0 == "target_tags.name"));
    }

    #[test]
    fn delegate_expand_skips_child_cache_for_empty_provider() {
        struct Target;
        impl Provider for Target {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "x".into(),
                    provider: None,
                    meta: None,
                })])
            }
        }

        struct Parent {
            target: Arc<dyn Provider>,
        }
        impl Provider for Parent {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::DelegateExpand {
                    target: self.target.clone(),
                    expand: Arc::new(|_, _| {
                        Ok(Some(ChildEntry {
                            name: "page-1".into(),
                            provider: Some(Arc::new(
                                crate::provider::dsl_provider::EmptyDslProvider,
                            )),
                            meta: None,
                        }))
                    }),
                }])
            }
        }

        struct Root {
            parent: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "parent").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: Some(self.parent.clone()),
                    meta: None,
                }))
            }
        }

        let parent: Arc<dyn Provider> = Arc::new(Parent {
            target: Arc::new(Target),
        });
        let runtime = runtime_with_root(Arc::new(Root { parent }));

        let children = runtime.list("/parent").unwrap();
        assert_eq!(children[0].name, "page-1");
        assert_eq!(runtime.cache_size(), 1);
    }

    #[test]
    fn delegate_expand_recurses_into_nested_delegate_refs() {
        struct InnerTarget;
        impl Provider for InnerTarget {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "inner".into(),
                    provider: None,
                    meta: None,
                })])
            }
        }

        struct OuterTarget {
            inner: Arc<dyn Provider>,
        }
        impl Provider for OuterTarget {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::DelegateExpand {
                    target: self.inner.clone(),
                    expand: Arc::new(|child, _| {
                        Ok(Some(ChildEntry {
                            name: format!("mid-{}", child.name),
                            provider: None,
                            meta: None,
                        }))
                    }),
                }])
            }
        }

        struct Parent {
            target: Arc<dyn Provider>,
        }
        impl Provider for Parent {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::DelegateExpand {
                    target: self.target.clone(),
                    expand: Arc::new(|child, _| {
                        Ok(Some(ChildEntry {
                            name: format!("page-{}", child.name),
                            provider: None,
                            meta: None,
                        }))
                    }),
                }])
            }
        }

        let runtime = runtime_with_root(Arc::new(Parent {
            target: Arc::new(OuterTarget {
                inner: Arc::new(InnerTarget),
            }),
        }));

        let children = runtime.list("/").unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "page-mid-inner");
        assert_eq!(runtime.cache_size(), 1);
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
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal(self.children.iter().find(|(n, _)| n == name).map(|(n, p)| {
                    ChildEntry {
                        name: n.clone(),
                        provider: Some(p.clone()),
                        meta: None,
                    }
                }))
            }
        }
        let empty_provider: Arc<dyn Provider> =
            Arc::new(crate::provider::dsl_provider::EmptyDslProvider);
        let root = Arc::new(Holder {
            children: vec![("e".into(), empty_provider.clone())],
        });
        let runtime = runtime_with_root(root);
        runtime.resolve("/e").unwrap();
        // Empty provider hit doesn't cache
        assert_eq!(runtime.cache_size(), 0);
    }

    #[test]
    fn no_provider_child_resolves_and_is_cached() {
        struct Root;
        impl Provider for Root {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "no_prov").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: None,
                    meta: None,
                }))
            }
        }

        let runtime = runtime_with_root(Arc::new(Root));
        let resolved = runtime.resolve("/no_prov").unwrap();
        assert!(resolved.provider.is_none());
        assert_eq!(runtime.cache_size(), 1);
    }

    #[test]
    fn operations_on_no_provider_return_no_provider() {
        struct Root;
        impl Provider for Root {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "no_prov").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: None,
                    meta: None,
                }))
            }
        }

        let runtime = runtime_with_root(Arc::new(Root));
        let err = runtime.list("/no_prov").unwrap_err();
        assert!(matches!(err, EngineError::NoProvider(p) if p == "/no_prov"));
    }

    #[test]
    fn navigation_past_no_provider_returns_path_not_found() {
        struct Root;
        impl Provider for Root {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "no_prov").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: None,
                    meta: None,
                }))
            }
        }

        let runtime = runtime_with_root(Arc::new(Root));
        let err = runtime.resolve("/no_prov/child").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(p) if p == "/no_prov/child"));
    }

    #[test]
    fn delegate_with_no_final_provider_resolves_as_no_provider() {
        struct Target;
        impl Provider for Target {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.from = Some(crate::ast::SqlExpr("target_table".into()));
                q
            }
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
        }

        struct Root {
            target: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name == "delegated" {
                    ResolveRef::Delegate {
                        target: self.target.clone(),
                        transform: Arc::new(|_, _| {
                            Some(ChildEntry {
                                name: "delegated".to_string(),
                                provider: None,
                                meta: None,
                            })
                        }),
                    }
                } else {
                    ResolveRef::Terminal(None)
                }
            }
        }

        let runtime = runtime_with_root(Arc::new(Root {
            target: Arc::new(Target),
        }));
        let resolved = runtime.resolve("/delegated").unwrap();
        assert!(resolved.provider.is_none());
        assert_eq!(resolved.composed.from.unwrap().0, "target_table");
        let err = runtime.list("/delegated").unwrap_err();
        assert!(matches!(err, EngineError::NoProvider(p) if p == "/delegated"));
    }

    #[test]
    fn delegate_resolve_chain_unwinds_transforms_and_folds_each_target_query() {
        struct TargetC {
            leaf: Arc<dyn Provider>,
        }
        impl Provider for TargetC {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.fields.push(crate::compose::FieldFrag {
                    sql: SqlExpr("c_mark".into()),
                    alias: None,
                    in_need: true,
                });
                q
            }

            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal((name == "x").then(|| ChildEntry {
                    name: name.to_string(),
                    provider: Some(self.leaf.clone()),
                    meta: Some(serde_json::json!({"leaf": true})),
                }))
            }
        }

        struct TargetB {
            target: Arc<dyn Provider>,
            leaf: Arc<dyn Provider>,
        }
        impl Provider for TargetB {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.fields.push(crate::compose::FieldFrag {
                    sql: SqlExpr("b_mark".into()),
                    alias: None,
                    in_need: true,
                });
                q
            }

            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name != "x" {
                    return ResolveRef::Terminal(None);
                }
                let leaf = self.leaf.clone();
                ResolveRef::Delegate {
                    target: self.target.clone(),
                    transform: Arc::new(move |child, _| {
                        let child = child?;
                        child
                            .meta
                            .as_ref()
                            .and_then(|meta| meta.get("leaf"))
                            .and_then(|value| value.as_bool())
                            .filter(|ok| *ok)?;
                        Some(ChildEntry {
                            name: child.name.clone(),
                            provider: Some(leaf.clone()),
                            meta: Some(serde_json::json!({"mid": true})),
                        })
                    }),
                }
            }
        }

        struct Root {
            target: Arc<dyn Provider>,
            leaf: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name != "x" {
                    return ResolveRef::Terminal(None);
                }
                let leaf = self.leaf.clone();
                ResolveRef::Delegate {
                    target: self.target.clone(),
                    transform: Arc::new(move |child, _| {
                        let child = child?;
                        child
                            .meta
                            .as_ref()
                            .and_then(|meta| meta.get("mid"))
                            .and_then(|value| value.as_bool())
                            .filter(|ok| *ok)?;
                        Some(ChildEntry {
                            name: "x".into(),
                            provider: Some(leaf.clone()),
                            meta: Some(serde_json::json!({"outer": true})),
                        })
                    }),
                }
            }
        }

        let target_c: Arc<dyn Provider> = Arc::new(TargetC {
            leaf: note_leaf("raw-c", Some("raw_c_table")),
        });
        let target_b: Arc<dyn Provider> = Arc::new(TargetB {
            target: target_c,
            leaf: note_leaf("mid-b", Some("mid_b_table")),
        });
        let runtime = runtime_with_root(Arc::new(Root {
            target: target_b,
            leaf: note_leaf("outer-a", Some("outer_a_table")),
        }));

        let resolved = runtime.resolve("/x").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "outer_a_table");
        assert!(resolved
            .composed
            .fields
            .iter()
            .any(|field| field.sql.0 == "b_mark"));
        assert!(resolved
            .composed
            .fields
            .iter()
            .any(|field| field.sql.0 == "c_mark"));
        assert_eq!(runtime.note("/x").unwrap(), Some("outer-a".into()));
    }

    #[test]
    fn delegate_list_fallback_uses_deepest_target_and_unwinds_transforms() {
        struct TargetC {
            leaf: Arc<dyn Provider>,
        }
        impl Provider for TargetC {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.fields.push(crate::compose::FieldFrag {
                    sql: SqlExpr("c_list_scope".into()),
                    alias: None,
                    in_need: true,
                });
                q
            }

            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "x".into(),
                    provider: Some(self.leaf.clone()),
                    meta: Some(serde_json::json!({"origin": "c-list"})),
                })])
            }
        }

        struct TargetB {
            target: Arc<dyn Provider>,
            wrong_leaf: Arc<dyn Provider>,
        }
        impl Provider for TargetB {
            fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
                q.fields.push(crate::compose::FieldFrag {
                    sql: SqlExpr("b_delegate_scope".into()),
                    alias: None,
                    in_need: true,
                });
                q
            }

            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "x".into(),
                    provider: Some(self.wrong_leaf.clone()),
                    meta: Some(serde_json::json!({"origin": "b-list"})),
                })])
            }

            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name != "x" {
                    return ResolveRef::Terminal(None);
                }
                ResolveRef::Delegate {
                    target: self.target.clone(),
                    transform: Arc::new(move |child, _| {
                        let child = child?;
                        (child.meta.as_ref()?.get("origin")? == "c-list").then(|| ChildEntry {
                            name: child.name.clone(),
                            provider: child.provider.clone(),
                            meta: Some(serde_json::json!({"via": "b"})),
                        })
                    }),
                }
            }
        }

        struct Root {
            target: Arc<dyn Provider>,
            leaf: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name != "x" {
                    return ResolveRef::Terminal(None);
                }
                let leaf = self.leaf.clone();
                ResolveRef::Delegate {
                    target: self.target.clone(),
                    transform: Arc::new(move |child, _| {
                        let child = child?;
                        (child.meta.as_ref()?.get("via")? == "b").then(|| ChildEntry {
                            name: "x".into(),
                            provider: Some(leaf.clone()),
                            meta: None,
                        })
                    }),
                }
            }
        }

        let target_c: Arc<dyn Provider> = Arc::new(TargetC {
            leaf: note_leaf("raw-c", None),
        });
        let target_b: Arc<dyn Provider> = Arc::new(TargetB {
            target: target_c,
            wrong_leaf: note_leaf("wrong-b-list", None),
        });
        let runtime = runtime_with_root(Arc::new(Root {
            target: target_b,
            leaf: note_leaf("outer-a", Some("outer_a_table")),
        }));

        let resolved = runtime.resolve("/x").unwrap();
        assert_eq!(resolved.composed.from.unwrap().0, "outer_a_table");
        assert!(resolved
            .composed
            .fields
            .iter()
            .any(|field| field.sql.0 == "b_delegate_scope"));
        assert!(resolved
            .composed
            .fields
            .iter()
            .any(|field| field.sql.0 == "c_list_scope"));
        assert_eq!(runtime.note("/x").unwrap(), Some("outer-a".into()));
    }

    #[test]
    fn delegate_transform_none_turns_list_fallback_match_into_path_not_found() {
        struct Target {
            leaf: Arc<dyn Provider>,
        }
        impl Provider for Target {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "x".into(),
                    provider: Some(self.leaf.clone()),
                    meta: None,
                })])
            }
        }

        struct Root {
            target: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name == "x" {
                    ResolveRef::Delegate {
                        target: self.target.clone(),
                        transform: Arc::new(|_, _| None),
                    }
                } else {
                    ResolveRef::Terminal(None)
                }
            }
        }

        let runtime = runtime_with_root(Arc::new(Root {
            target: Arc::new(Target {
                leaf: note_leaf("raw-target", None),
            }),
        }));

        let err = runtime.resolve("/x").unwrap_err();
        assert!(matches!(err, EngineError::PathNotFound(path) if path == "/x"));
        assert_eq!(runtime.cache_size(), 0);
    }

    #[test]
    fn delegate_list_fallback_does_not_cache_raw_siblings_at_outer_path() {
        struct Target {
            raw_leaf: Arc<dyn Provider>,
        }
        impl Provider for Target {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(["hit", "sibling"]
                    .into_iter()
                    .map(|name| {
                        ListRef::Direct(ChildEntry {
                            name: name.into(),
                            provider: Some(self.raw_leaf.clone()),
                            meta: None,
                        })
                    })
                    .collect())
            }
        }

        struct Root {
            target: Arc<dyn Provider>,
            outer_leaf: Arc<dyn Provider>,
        }
        impl Provider for Root {
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                if name != "hit" && name != "sibling" {
                    return ResolveRef::Terminal(None);
                }
                let outer_leaf = self.outer_leaf.clone();
                ResolveRef::Delegate {
                    target: self.target.clone(),
                    transform: Arc::new(move |child, _| {
                        let child = child?;
                        Some(ChildEntry {
                            name: child.name.clone(),
                            provider: Some(outer_leaf.clone()),
                            meta: None,
                        })
                    }),
                }
            }
        }

        let runtime = runtime_with_root(Arc::new(Root {
            target: Arc::new(Target {
                raw_leaf: note_leaf("raw-target", None),
            }),
            outer_leaf: note_leaf("outer-transformed", None),
        }));

        assert_eq!(
            runtime.note("/hit").unwrap(),
            Some("outer-transformed".into())
        );
        assert_eq!(runtime.cache_size(), 1);
        assert_eq!(
            runtime.note("/sibling").unwrap(),
            Some("outer-transformed".into())
        );
        assert_eq!(runtime.cache_size(), 2);
    }

    #[test]
    fn note_dispatches_to_provider() {
        struct N;
        impl Provider for N {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn get_note(&self, _: &ProviderQuery, _: &ProviderContext) -> Option<String> {
                Some("hello".into())
            }
        }
        let runtime = runtime_with_root(Arc::new(N));
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
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
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
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(vec![ListRef::Direct(ChildEntry {
                    name: "k".into(),
                    provider: Some(self.child.clone()),
                    meta: Some(serde_json::json!({"foo":"bar"})),
                })])
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal(if name == "k" {
                    Some(ChildEntry {
                        name: "k".into(),
                        provider: Some(self.child.clone()),
                        meta: Some(serde_json::json!({"foo":"bar"})),
                    })
                } else {
                    None
                })
            }
        }
        let leaf: Arc<dyn Provider> = Arc::new(Inner);
        let root = Arc::new(Holder { child: leaf });
        let runtime = runtime_with_root(root);
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
        // simulate /vd/i18n-zh_CN/%E6%8C%89%E7%94%BB%E5%86%8C  (UTF-8 percent-encoded "画册")
        struct Inner {
            children: Vec<(String, Arc<dyn Provider>)>,
        }
        impl Provider for Inner {
            fn list(
                &self,
                _: &ProviderQuery,
                _: &ProviderContext,
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
            fn resolve(&self, name: &str, _: &ProviderQuery, _: &ProviderContext) -> ResolveRef {
                ResolveRef::Terminal(self.children.iter().find(|(n, _)| n == name).map(|(n, p)| {
                    ChildEntry {
                        name: n.clone(),
                        provider: Some(p.clone()),
                        meta: None,
                    }
                }))
            }
        }
        let leaf: Arc<dyn Provider> = Arc::new(Inner { children: vec![] });
        let root = Arc::new(Inner {
            children: vec![("按画册".into(), leaf)],
        });
        let runtime = runtime_with_root(root);
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
        ) -> Result<Vec<ListRef>, EngineError> {
            Ok(Vec::new())
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
            rows_for_inner: vec![serde_json::json!({"id": 1}), serde_json::json!({"id": 2})],
            rows_for_count: vec![],
        });
        let root: Arc<dyn Provider> = Arc::new(ImagesLeaf);
        let runtime = runtime_with_root_and_executor(
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
        );

        let rows = runtime.fetch("/").expect("fetch ok");
        assert_eq!(rows.len(), 2);
        let captured = exec.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        // inner SQL 不带 COUNT wrapper
        assert!(
            captured[0].0.contains("FROM images"),
            "sql: {}",
            captured[0].0
        );
        assert!(
            !captured[0].0.contains("COUNT(*)"),
            "sql: {}",
            captured[0].0
        );
    }

    #[test]
    fn count_wraps_with_count_star() {
        let exec = Arc::new(CapturingExecutor {
            captured: std::sync::Mutex::new(Vec::new()),
            rows_for_inner: vec![],
            rows_for_count: vec![serde_json::json!({"n": 42})],
        });
        let root: Arc<dyn Provider> = Arc::new(ImagesLeaf);
        let runtime = runtime_with_root_and_executor(
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
        );

        let n = runtime.count("/").expect("count ok");
        assert_eq!(n, 42);
        let captured = exec.captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        let sql = &captured[0].0;
        assert!(
            sql.starts_with("SELECT COUNT(*) AS n FROM ("),
            "sql: {}",
            sql
        );
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
            ) -> Result<Vec<ListRef>, EngineError> {
                Ok(Vec::new())
            }
        }
        let exec = Arc::new(CapturingExecutor {
            captured: std::sync::Mutex::new(Vec::new()),
            rows_for_inner: vec![],
            rows_for_count: vec![serde_json::json!({"n": 0})],
        });
        let root: Arc<dyn Provider> = Arc::new(LimitZeroLeaf);
        let runtime = runtime_with_root_and_executor(
            root,
            exec.clone() as Arc<dyn crate::provider::SqlExecutor>,
        );

        let rows = runtime.fetch("/").expect("fetch ok");
        assert!(rows.is_empty());
        let captured = exec.captured.lock().unwrap();
        assert!(captured[0].0.contains("LIMIT"), "sql: {}", captured[0].0);
    }
}
