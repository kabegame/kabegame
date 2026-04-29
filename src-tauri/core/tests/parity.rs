//! Phase 7a S5: Provider parity 测试 — programmatic vs DSL 在同一路径上的输出等价。
//!
//! 目的: 每个 7a/b/c/d 迁移到 DSL 的 provider, 都构造 `programmatic factory + DSL JSON5`
//! 一对, 用同一 fixture registry 跑 resolve/list, 比较输出。失败说明迁移破坏行为。
//!
//! Helper 跨子期复用; 7b 起每个新迁加 1 个 case 即可。

use std::collections::HashMap;
use std::sync::Arc;

use kabegame_core::providers::programmatic;
use pathql_rs::ast::SqlExpr;
use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{
    ClosureExecutor, Provider, ProviderContext, ProviderRuntime, SqlDialect, SqlExecutor,
};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

// ── 公共 helpers ───────────────────────────────────────────────────────────

fn no_op_executor() -> Arc<dyn SqlExecutor> {
    Arc::new(ClosureExecutor::new(SqlDialect::Sqlite, |_sql, _params| {
        Ok(Vec::new())
    }))
}

/// 给定 programmatic provider Arc + DSL JSON5 字符串, 包装成两个独立的 ProviderRuntime
/// (各自单 root provider), 比较 root 上同一段 `seg` 的 resolve / list / apply_query 输出。
///
/// `dsl_properties` 给 DSL provider 注入实例属性 (模拟 registry.instantiate 的注入)。
fn assert_provider_parity_with_props(
    case_name: &str,
    programmatic: Arc<dyn Provider>,
    dsl_json: &str,
    dsl_properties: HashMap<String, TemplateValue>,
    test_segments: &[&str],
    test_apply_query: bool,
    test_list: bool,
) {
    // 1. programmatic registry: 直接把 provider 当 root 跑
    let prog_registry = Arc::new(ProviderRegistry::new());
    let prog_runtime = ProviderRuntime::new(prog_registry, programmatic.clone(), no_op_executor());

    // 2. DSL registry: 加载 JSON5 + 把 DslProvider 当 root
    let dsl_def = Json5Loader.load(Source::Str(dsl_json)).expect("load DSL");
    let mut dsl_registry = ProviderRegistry::new();
    dsl_registry.register(dsl_def.clone()).expect("register DSL");
    let dsl_root: Arc<dyn Provider> = Arc::new(pathql_rs::DslProvider {
        def: Arc::new(dsl_def),
        properties: dsl_properties,
    });
    let dsl_runtime = ProviderRuntime::new(Arc::new(dsl_registry), dsl_root, no_op_executor());

    // 3. apply_query parity: 比较 build_sql 输出 (真行为, 而非 Debug 投影)
    if test_apply_query {
        let prog_node = prog_runtime
            .resolve("/")
            .expect("prog runtime resolve(/) failed");
        let dsl_node = dsl_runtime
            .resolve("/")
            .expect("dsl runtime resolve(/) failed");
        // 行为等价的最严苛对比: 把 ProviderQuery build_sql 出 (sql_string, bind_params) 再比。
        // 没有 from 的 contrib leaf → 加个 dummy from 让 build_sql 能跑
        let prog_sql = render_with_dummy_from(&prog_node.composed);
        let dsl_sql = render_with_dummy_from(&dsl_node.composed);
        assert_eq!(
            prog_sql, dsl_sql,
            "[{}] build_sql output diverges:\n  prog: {:?}\n  dsl:  {:?}",
            case_name, prog_sql, dsl_sql
        );
    }

    // 4. list parity: 比较 children name 序列
    if test_list {
        let prog_children = prog_runtime.list("/").expect("prog list(/) failed");
        let dsl_children = dsl_runtime.list("/").expect("dsl list(/) failed");
        let prog_names: Vec<&str> = prog_children.iter().map(|c| c.name.as_str()).collect();
        let dsl_names: Vec<&str> = dsl_children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            prog_names, dsl_names,
            "[{}] list children names diverge:\n  prog: {:?}\n  dsl:  {:?}",
            case_name, prog_names, dsl_names
        );
    }

    // 5. resolve parity: 给定 segment, 两边都应该返回 Some / 都返回 None
    for seg in test_segments {
        let ctx = make_test_ctx(&prog_runtime);
        let prog_resolved = programmatic
            .resolve(seg, &prog_runtime.resolve("/").unwrap().composed, &ctx)
            .is_some();
        let dsl_resolved = dsl_runtime.resolve(&format!("/{}", seg)).is_ok();
        assert_eq!(
            prog_resolved, dsl_resolved,
            "[{}] resolve('{}') divergence: prog Some={} dsl Ok={}",
            case_name, seg, prog_resolved, dsl_resolved
        );
    }
}

/// 旧 API 兼容 wrapper — 不注入 properties (空 HashMap).
fn assert_provider_parity(
    case_name: &str,
    programmatic: Arc<dyn Provider>,
    dsl_json: &str,
    test_segments: &[&str],
    test_apply_query: bool,
    test_list: bool,
) {
    assert_provider_parity_with_props(
        case_name,
        programmatic,
        dsl_json,
        HashMap::new(),
        test_segments,
        test_apply_query,
        test_list,
    );
}

/// build_sql 出 (sql, params) — 用 dummy from 占位让无 from 的 contrib-only provider 能跑。
fn render_with_dummy_from(q: &ProviderQuery) -> (String, Vec<TemplateValue>) {
    let mut q2 = q.clone();
    if q2.from.is_none() {
        q2.from = Some(SqlExpr("__dummy__".into()));
    }
    q2.build_sql(&TemplateContext::default(), SqlDialect::Sqlite)
        .expect("build_sql failed")
}

/// 用 reflection trick: ProviderContext 需要 runtime 的 Arc, 但我们不给外部测试代码
/// 暴露 make_ctx; 退路: 临时构造一个 Empty runtime 的 ctx 不可行 (registry mismatch).
/// 当前简化方案: 借 prog_runtime 的 list("/") 间接走 ctx, 这里我们手动构造一个
/// Empty registry + dummy ctx 仅供 resolve 调用。
fn make_test_ctx(rt: &Arc<ProviderRuntime>) -> ProviderContext {
    // 通过 list("/") 已经工作过 → registry 与 weak_self 都已经初始化。
    // 这里我们通过 Arc 的内部访问构造 ctx 不可能 (private)。
    // 退路: 用 list("/") 作为 ctx 来源不可用 (内部已 drop)。
    // 最干净的办法: 导出 ProviderRuntime::make_ctx 为 pub(crate)。
    // 临时方案: skip resolve check by short-circuiting。
    // FIXME(7b+): 解决方案 — 把 make_ctx 公开 / 加 ProviderRuntime::with_ctx() helper。
    let _ = rt;
    panic!("test_segments resolve check not yet wired (need ProviderRuntime ctx accessor)");
}

// ── 7a S5b: sort_provider parity ───────────────────────────────────────────

#[test]
fn sort_provider_parity() {
    use programmatic::shared::SortProvider;

    let dsl_json = r#"{
        "namespace": "kabegame",
        "name": "sort_provider",
        "query": { "order": { "all": "revert" } }
    }"#;

    assert_provider_parity(
        "sort_provider",
        Arc::new(SortProvider) as Arc<dyn Provider>,
        dsl_json,
        &[], // 不测 resolve (sort_provider 是 leaf, resolve 永远 None)
        true,  // 测 apply_query (核心: order.global = Revert)
        true,  // 测 list (都应返回空)
    );
}

// ── 7a S5c: gallery_search_router parity ───────────────────────────────────

#[test]
fn gallery_search_router_parity() {
    use programmatic::gallery_filters::GallerySearchRouter;

    let dsl_json = r#"{
        "namespace": "kabegame",
        "name": "gallery_search_router",
        "list": {
            "display-name": { "provider": "gallery_search_display_name_router" }
        }
    }"#;

    assert_provider_parity(
        "gallery_search_router",
        Arc::new(GallerySearchRouter) as Arc<dyn Provider>,
        dsl_json,
        &[], // 不测 resolve (gallery_search_display_name_router 跨 registry, 在 isolated
             // helper 里两边都拿不到目标 → 都 None / 都 Err, 等价但 trivially 等价不值得断言)
        false, // 不测 apply_query (router 壳无 apply_query 贡献; 二者均 noop, ProviderQuery
               // 的 Default Debug 字符串等价 — 但 dsl_def.query=None 与 programmatic 的
               // default 实现不一致时会有 trivial 字符串差异, 不是行为差异)
        true,  // 测 list (核心: 输出 ["display-name"])
    );
}

// ── 7b S4: gallery_hide_router parity ──────────────────────────────────────
//
// 验证 ByDelegate 复活后 (S1+S2), gallery_hide_router DSL 行为与 programmatic 等价:
// - apply_query: contrib HIDE WHERE
// - list: target.list(gallery_route) 委派 (programmatic) vs ".*" delegate forward (DSL)
//
// 注: 跨 registry 的 list parity 比较起来复杂 — programmatic GalleryHideRouter.list
// 调 instantiate_named("gallery_route") 但 helper 用 isolated registry, 所以
// programmatic 一侧拿不到 gallery_route → list 会返回空。这里只比 apply_query 行为
// (核心 contrib WHERE), list parity 留 7d E2E 测试覆盖。

#[test]
fn gallery_hide_router_apply_query_parity() {
    use programmatic::gallery_filters::GalleryHideRouter;

    let dsl_json = r#"{
        "namespace": "kabegame",
        "name": "gallery_hide_router",
        "properties": {
            "hidden_album_id": {
                "type": "string",
                "default": "00000000-0000-0000-0000-000000000000",
                "optional": false
            }
        },
        "query": {
            "where": "/*HIDE*/ NOT EXISTS (SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ${properties.hidden_album_id})"
        },
        "resolve": {
            ".*": { "delegate": { "provider": "gallery_route" } }
        }
    }"#;

    let mut props = HashMap::new();
    props.insert(
        "hidden_album_id".into(),
        TemplateValue::Text("00000000-0000-0000-0000-000000000000".into()),
    );

    assert_provider_parity_with_props(
        "gallery_hide_router",
        Arc::new(GalleryHideRouter) as Arc<dyn Provider>,
        dsl_json,
        props,
        &[],
        true,  // apply_query: contrib HIDE WHERE 等价 (build_sql 后 SQL+params 完全一致)
        false, // list: 跨 registry 比较不可行 (上方注释)
    );
}

// ── (TODO) 移动 ctx accessor 到 pathql-rs ───────────────────────────────────
// 当前 helper 的 resolve 路径用了 panic 占位; 7b 起 cause 修正后可启用 segment-level 测试。
// 短期: helper 接受 test_segments=&[] 跳过 resolve 校验 (apply_query + list 已覆盖核心 parity)。
