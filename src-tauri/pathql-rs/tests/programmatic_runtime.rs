//! Phase 6a 端到端: 完全用 register_provider 编程注册测试 ProviderRuntime,
//! 不涉及 DSL 加载, 不涉及 SQL 执行。验证 runtime 路径解析、命名空间链查找、
//! 缓存策略、resolve 三步顺序的核心逻辑。

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{Namespace, ProviderName, SimpleName, SqlExpr};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{
    ChildEntry, ClosureExecutor, EngineError, Provider, ProviderContext, ProviderRuntime,
    SqlDialect, SqlExecutor,
};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::ProviderRegistry;

fn no_op_executor() -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(SqlDialect::Sqlite, |_sql, _params| {
        Ok(Vec::new())
    }))
}

fn runtime_with_registry(
    mut registry: ProviderRegistry,
    root: Arc<dyn Provider>,
) -> Arc<ProviderRuntime> {
    let root_for_factory = root.clone();
    registry
        .register_provider(
            Namespace(String::new()),
            SimpleName("__root".into()),
            move |_| Ok(root_for_factory.clone()),
        )
        .unwrap();
    let runtime =
        ProviderRuntime::with_registry(Arc::new(registry), no_op_executor(), Default::default());
    runtime.set_root("", "__root").unwrap();
    runtime
}

fn runtime_with_root(root: Arc<dyn Provider>) -> Arc<ProviderRuntime> {
    runtime_with_registry(ProviderRegistry::new(), root)
}

/// 简单 provider 实现: 给 from + 静态 children + 字面 resolve。
/// **不持 registry / runtime 字段**——demo ctx-passing 设计。
struct StaticProvider {
    from_table: Option<String>,
    children: Vec<(String, Arc<dyn Provider>)>,
    note: Option<String>,
}

impl Provider for StaticProvider {
    fn apply_query(&self, mut q: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        if let Some(t) = &self.from_table {
            q.from = Some(SqlExpr(t.clone()));
        }
        q
    }
    fn list(
        &self,
        _: &ProviderQuery,
        _ctx: &ProviderContext,
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
    fn resolve(&self, name: &str, _: &ProviderQuery, _ctx: &ProviderContext) -> Option<ChildEntry> {
        self.children
            .iter()
            .find(|(n, _)| n == name)
            .map(|(n, p)| ChildEntry {
                name: n.clone(),
                provider: Some(p.clone()),
                meta: None,
            })
    }
    fn get_note(&self, _: &ProviderQuery, _: &ProviderContext) -> Option<String> {
        self.note.clone()
    }
}

#[test]
fn three_level_chain_via_register_provider() {
    let leaf = Arc::new(StaticProvider {
        from_table: Some("leaf_table".into()),
        children: vec![],
        note: None,
    });
    let mid = Arc::new(StaticProvider {
        from_table: None,
        children: vec![("c".into(), leaf.clone() as Arc<dyn Provider>)],
        note: None,
    });
    let root = Arc::new(StaticProvider {
        from_table: Some("root_table".into()),
        children: vec![("b".into(), mid.clone() as Arc<dyn Provider>)],
        note: Some("root provider".into()),
    });

    let mut registry = ProviderRegistry::new();
    let root_clone = root.clone();
    registry
        .register_provider(
            Namespace("test".into()),
            SimpleName("root".into()),
            move |_props| Ok(root_clone.clone() as Arc<dyn Provider>),
        )
        .unwrap();

    let runtime = runtime_with_registry(registry, root);

    let resolved = runtime.resolve("/b/c").unwrap();
    assert_eq!(resolved.composed.from.unwrap().0, "leaf_table");
    assert_eq!(runtime.cache_size(), 2); // /b 和 /b/c

    // 第二次命中缓存 (cache size 不变)
    let _ = runtime.resolve("/b/c").unwrap();
    assert_eq!(runtime.cache_size(), 2);

    // list
    let children = runtime.list("/b").unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "c");

    // note
    let note = runtime.note("/").unwrap();
    assert_eq!(note, Some("root provider".into()));
}

#[test]
fn path_not_found_returns_error() {
    let root: Arc<dyn Provider> = Arc::new(StaticProvider {
        from_table: None,
        children: vec![],
        note: None,
    });
    let mut registry = ProviderRegistry::new();
    let root_clone = root.clone();
    registry
        .register_provider(
            Namespace("test".into()),
            SimpleName("root".into()),
            move |_| Ok(root_clone.clone()),
        )
        .unwrap();

    let runtime = runtime_with_registry(registry, root);
    let err = runtime.resolve("/missing").unwrap_err();
    assert!(matches!(err, EngineError::PathNotFound(_)));
    assert_eq!(runtime.cache_size(), 0);
}

#[test]
fn case_sensitive_paths() {
    let leaf: Arc<dyn Provider> = Arc::new(StaticProvider {
        from_table: Some("hello_table".into()),
        children: vec![],
        note: None,
    });
    let root = Arc::new(StaticProvider {
        from_table: None,
        children: vec![("Hello".into(), leaf.clone())],
        note: None,
    });
    let runtime = runtime_with_root(root);

    // /Hello 命中
    assert!(runtime.resolve("/Hello").is_ok());
    // /hello (小写) 不命中
    assert!(matches!(
        runtime.resolve("/hello").unwrap_err(),
        EngineError::PathNotFound(_)
    ));
}

#[test]
fn factory_uses_properties() {
    /// 持 album_id 的叶子 provider; factory 从 properties 构造。
    struct AlbumProvider {
        album_id: String,
    }
    impl Provider for AlbumProvider {
        fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
            q.from = Some(SqlExpr(format!("images_for_album_{}", self.album_id)));
            q
        }
        fn list(
            &self,
            _: &ProviderQuery,
            _: &ProviderContext,
        ) -> Result<Vec<ChildEntry>, EngineError> {
            Ok(Vec::new())
        }
        fn resolve(&self, _: &str, _: &ProviderQuery, _: &ProviderContext) -> Option<ChildEntry> {
            None
        }
    }

    /// router resolves 任意段名 → instantiate AlbumProvider with album_id = 段名
    struct AlbumRouter;
    impl Provider for AlbumRouter {
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
            ctx: &ProviderContext,
        ) -> Option<ChildEntry> {
            let mut props = HashMap::new();
            props.insert("album_id".into(), TemplateValue::Text(name.to_string()));
            ctx.registry
                .instantiate(
                    &Namespace("test".into()),
                    &ProviderName("album_provider".into()),
                    &props,
                    ctx,
                )
                .map(|provider| ChildEntry {
                    name: name.to_string(),
                    provider: Some(provider),
                    meta: None,
                })
        }
    }

    let mut registry = ProviderRegistry::new();
    registry
        .register_provider(
            Namespace("test".into()),
            SimpleName("album_provider".into()),
            |props| {
                let id = match props.get("album_id") {
                    Some(TemplateValue::Text(s)) => s.clone(),
                    _ => {
                        return Err(EngineError::FactoryFailed(
                            "test".into(),
                            "album_provider".into(),
                            "missing album_id".into(),
                        ))
                    }
                };
                Ok(Arc::new(AlbumProvider { album_id: id }) as Arc<dyn Provider>)
            },
        )
        .unwrap();

    let root: Arc<dyn Provider> = Arc::new(AlbumRouter);
    let runtime = runtime_with_registry(registry, root);

    let r1 = runtime.resolve("/A1").unwrap();
    let r2 = runtime.resolve("/B7").unwrap();

    assert_eq!(r1.composed.from.unwrap().0, "images_for_album_A1");
    assert_eq!(r2.composed.from.unwrap().0, "images_for_album_B7");
}

#[test]
fn programmatic_and_dsl_coexist_in_namespace_chain() {
    use pathql_rs::ast::{ProviderDef, ProviderName, SimpleName};
    let mut registry = ProviderRegistry::new();

    // DSL provider
    let dsl_def = ProviderDef {
        schema: None,
        namespace: Some(Namespace("kabegame".into())),
        name: SimpleName("dsl_one".into()),
        properties: None,
        query: None,
        list: None,
        resolve: None,
        note: Some("dsl note".into()),
    };
    registry.register(dsl_def).unwrap();

    // Programmatic provider in the same namespace
    registry
        .register_provider(
            Namespace("kabegame".into()),
            SimpleName("prog_one".into()),
            |_| {
                struct Stub;
                impl Provider for Stub {
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
                    ) -> Option<ChildEntry> {
                        None
                    }
                }
                Ok(Arc::new(Stub) as Arc<dyn Provider>)
            },
        )
        .unwrap();

    assert_eq!(registry.len(), 2);

    // Both findable via lookup
    assert!(registry
        .lookup(
            &Namespace("kabegame".into()),
            &ProviderName("dsl_one".into())
        )
        .is_some());
    assert!(registry
        .lookup(
            &Namespace("kabegame".into()),
            &ProviderName("prog_one".into())
        )
        .is_some());
}
