//! Phase 6a 真实 sqlite 端到端: programmatic provider + ProviderRuntime + 真 in-memory sqlite。
//! 验证: 路径解析 → ProviderQuery 累积 → build_sql → params_for → rusqlite 执行 → 结果集。
//!
//! 不接 DSL, 不接 SqlExecutor 注入 (那是 6c)。本期 sqlite 直接由测试代码持有 + 在 build_sql 后手动执行。

#![cfg(feature = "sqlite")]

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{JoinKind, Namespace, ProviderName, SimpleName, SqlExpr};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{
    ChildEntry, EngineError, Provider, ProviderContext, ProviderRuntime,
};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::ProviderRegistry;
use rusqlite::Connection;

fn fixture_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE images (id INTEGER PRIMARY KEY, title TEXT, plugin_id TEXT);
        CREATE TABLE album_images (album_id TEXT, image_id INTEGER);
        INSERT INTO images VALUES (1,'a','p1'),(2,'b','p1'),(3,'c','p2'),(4,'d','p2'),(5,'e','p1');
        INSERT INTO album_images VALUES ('A',1),('A',2),('A',3),('B',4),('B',5);
        ",
    )
    .unwrap();
    conn
}

/// 模拟 root: 设置 from = images, 路由到 albums / plugins
struct GalleryRoot;
impl Provider for GalleryRoot {
    fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
        q.from = Some(SqlExpr("images".into()));
        q
    }
    fn list(
        &self,
        _: &ProviderQuery,
        _: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            ChildEntry {
                name: "albums".into(),
                provider: None,
                meta: None,
            },
            ChildEntry {
                name: "plugins".into(),
                provider: None,
                meta: None,
            },
        ])
    }
    fn resolve(
        &self,
        name: &str,
        _: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let target = match name {
            "albums" => "albums_router",
            "plugins" => "plugins_router",
            _ => return None,
        };
        ctx.registry.instantiate(
            &Namespace("test".into()),
            &ProviderName(target.into()),
            &HashMap::new(),
            ctx,
        )
    }
}

/// AlbumsRouter: resolve album_id → AlbumProvider with where filter
struct AlbumsRouter;
impl Provider for AlbumsRouter {
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
    ) -> Option<Arc<dyn Provider>> {
        let mut props = HashMap::new();
        props.insert(
            "album_id".into(),
            TemplateValue::Text(name.to_string()),
        );
        ctx.registry.instantiate(
            &Namespace("test".into()),
            &ProviderName("album_provider".into()),
            &props,
            ctx,
        )
    }
}

/// AlbumProvider: 持 album_id, 加 INNER JOIN album_images + WHERE album_id = ?
struct AlbumProvider {
    album_id: String,
}
impl Provider for AlbumProvider {
    fn apply_query(&self, current: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
        current
            .with_join_raw(
                JoinKind::Inner,
                "album_images",
                "ai",
                Some("ai.image_id = images.id"),
                &[],
            )
            .expect("alias collision")
            .with_where_raw(
                "ai.album_id = ?",
                &[TemplateValue::Text(self.album_id.clone())],
            )
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

fn build_runtime() -> Arc<ProviderRuntime> {
    let mut registry = ProviderRegistry::new();
    let root: Arc<dyn Provider> = Arc::new(GalleryRoot);
    let root_for_factory = root.clone();
    registry
        .register_provider(
            Namespace("test".into()),
            SimpleName("root".into()),
            move |_| Ok(root_for_factory.clone()),
        )
        .unwrap();
    registry
        .register_provider(
            Namespace("test".into()),
            SimpleName("albums_router".into()),
            |_| Ok(Arc::new(AlbumsRouter) as Arc<dyn Provider>),
        )
        .unwrap();
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

    ProviderRuntime::new(Arc::new(registry), root)
}

fn execute_query(conn: &Connection, q: &ProviderQuery) -> Vec<i64> {
    let (sql, values) = q.build_sql(&TemplateContext::default()).unwrap();
    let params = params_for(&values);
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        r.get::<_, i64>(0)
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

#[test]
fn path_album_a_returns_three_image_ids() {
    let conn = fixture_db();
    let runtime = build_runtime();

    let resolved = runtime.resolve("/albums/A").unwrap();
    let mut ids = execute_query(&conn, &resolved.composed);
    ids.sort();
    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn path_album_b_returns_two_image_ids() {
    let conn = fixture_db();
    let runtime = build_runtime();

    let resolved = runtime.resolve("/albums/B").unwrap();
    let mut ids = execute_query(&conn, &resolved.composed);
    ids.sort();
    assert_eq!(ids, vec![4, 5]);
}

#[test]
fn longest_prefix_cache_skips_repeated_resolve() {
    let runtime = build_runtime();

    // First resolve populates cache for /albums and /albums/A
    runtime.resolve("/albums/A").unwrap();
    assert_eq!(runtime.cache_size(), 2);

    // Sibling /albums/B reuses /albums prefix; only adds /albums/B to cache
    runtime.resolve("/albums/B").unwrap();
    assert_eq!(runtime.cache_size(), 3);
}

#[test]
fn path_not_found_no_cache_pollution() {
    let runtime = build_runtime();
    let _ = runtime.resolve("/missing_route");
    assert_eq!(runtime.cache_size(), 0);
    let err = runtime.resolve("/missing_route").unwrap_err();
    assert!(matches!(err, EngineError::PathNotFound(_)));
}

#[test]
fn build_sql_from_resolved_state_executes_cleanly() {
    let conn = fixture_db();
    let runtime = build_runtime();
    let resolved = runtime.resolve("/albums/A").unwrap();

    let (sql, _params) = resolved
        .composed
        .build_sql(&TemplateContext::default())
        .unwrap();
    assert!(sql.contains("FROM images"));
    assert!(sql.contains("INNER JOIN album_images AS ai ON ai.image_id = images.id"));
    assert!(sql.contains("WHERE (ai.album_id = ?)"));

    // No SQL syntax errors
    let _ = conn.prepare(&sql).unwrap();
}
