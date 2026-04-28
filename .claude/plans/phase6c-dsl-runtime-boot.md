# Phase 6c 详细计划 — DSL 加载启用 + DslProvider 收尾 + SqlExecutor 注入

## Context

承接：
- **Phase 6a**：pathql-rs Provider 体系内核就绪（Provider trait + ChildEntry + ProviderRuntime + ProviderRegistry 编程注册 + DslProvider 静态部分 + ctx-passing 设计）
- **Phase 6b**：core 已通过 register_provider 把 **39 个**硬编码 provider 全部注册到 pathql-rs Registry；ImageQuery 已删；ProviderRuntime 已切到 pathql-rs；行为零回归

Phase 6c 的目标：

1. **pathql-rs 内**：完善 DslProvider 动态部分（dynamic SQL list / dynamic delegate list / dynamic 反查）+ 引入 `SqlExecutor` 抽象解耦 DB 执行
2. **core 端**：启用 `json5` + `validate` feature；把 9 个 `.json5` 集中到 `core/src/providers/dsl/` 子目录后用 `include_dir!()` 嵌入；调 `Json5Loader::load` + `validate` + `Registry::register`；DSL 项与编程项共存于同一 registry
3. **共存策略**：9 个 DSL-covered provider 名字从 `register_all_hardcoded` 中**跳过**（这些名字由 DSL 占位）；其余 30 个仍走编程注册；DSL 路由壳通过 `ctx.registry.instantiate(...)` 找下层时**自然命中** programmatic 项
4. **root 切换**：root provider 改为 DSL 的 `kabegame.root_provider`；初始化时通过 `Registry::instantiate(...)` 走 DSL 实例化路径
5. **executor 注入**：core 实现 `SqlExecutor` 包装 rusqlite，注入到 ProviderRuntime；DSL provider 动态 list SQL 项通过 executor 执行
6. **IPC 层 meta 暴露**：`execute_provider_query_typed` 不再硬编码 `meta: None`，改为从 `runtime.resolve(path)` 返回的当前节点取 meta（如 DSL provider 在 `meta:` 字段产 JSON），让前端 `meta.kind` switch 能识别 typed kinds

完成后：
- 9 个 DSL provider 真正被 ProviderRuntime 解释执行
- 动态 SQL list 项（如 `query_page_provider` / `page_size_provider`）的 SQL 通过 SqlExecutor 跑通
- 行为零回归：`/gallery/all/x100x/1/` 等路径走 DSL 解析后查询结果一致

约束：
- pathql-rs **不**引入 sqlx / 不开 query feature；仍然 dialect-agnostic + 无 DB 驱动
- core **不**接 query feature；自管 rusqlite 通过 SqlExecutor 抽象注入
- 6c 测试节奏可分阶段：先 pathql-rs S0 测试通过，再做 core 集成

---

## 6a/6b 实测状态校正（基于 pathql-rs / core 代码核对）

写本计划时部分前置假设与代码实际状态有偏差；以下校正已并入子任务：

**已就绪（6c 不需重做）**：
- ✅ `apply_query` 处理 `Query::Delegate`（[`dsl_provider.rs:148-153`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs#L148-L153)）—— `gallery_all_router.json5` 与 `gallery_page_router.json5` 的 `query: { delegate: ... }` 已经能跑
- ✅ `DslProvider::get_note` 模板插值（[`dsl_provider.rs:224-233`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs#L224-L233)）—— `gallery_all_router.json5` `note:` 字段无需额外工作
- ✅ `EngineError::ExecutorMissing` variant 已定义（[`provider/mod.rs:93-94`](../../src-tauri/pathql-rs/src/provider/mod.rs#L93-L94)）—— S0 不需新增 enum variant，直接用
- ✅ `wrap_typed_meta_json` + `MetaEntityKind` 已落地，programmatic provider 已在用（gallery_albums.rs / gallery_filters.rs / vd.rs）
- ✅ `runtime.note(path)` API 已存在（[`runtime.rs:159`](../../src-tauri/pathql-rs/src/provider/runtime.rs#L159)），core IPC 层已在用
- ✅ `ValidateConfig::with_default_reserved()` + `table_whitelist: Option<HashSet<String>>` API 已就绪

**计划与实测有偏差（已修正到子任务）**：
- ❌ **register 数 39 ≠ 33**：[`programmatic/mod.rs`](../../src-tauri/core/src/providers/programmatic/mod.rs) 实测 `register()` 调用 39 次；6c skip 9 后剩 30，非 24
- ❌ **`include_dir` 未加入 workspace deps**：根 [`Cargo.toml`](../../Cargo.toml) `[workspace.dependencies]` 实测无 `include_dir` 项；6c S1 必须真正添加
- ❌ **直接 `include_dir!("$CARGO_MANIFEST_DIR/src/providers")` 会嵌入整棵 .rs 源码** —— providers/ 下含 `provider.rs / init.rs / programmatic/*.rs / gallery/*.rs` 等业务代码；编译期序列化进二进制是无谓体积膨胀。**决策**：把 9 个 .json5 集中到 `core/src/providers/dsl/` 子目录后再 include_dir；providers/ 根目录恢复纯 Rust 模块结构

**Plan 没覆盖、6c 需要补的**：
- 🆕 **IPC 层 meta 暴露**（[`query.rs:150,176`](../../src-tauri/core/src/providers/query.rs#L150)）：当前 `execute_provider_query_typed` 对 Entry / Listing 都硬编码 `meta: None`，DSL provider 在 `meta:` 字段产的 JSON 永远不到前端。S5bis 修
- 🆕 **typed meta wire format 兼容性预测试**：当前 9 个 .json5 都没 `meta:` 字段，但 Phase 7 必加（如 vd_albums_provider.json5 产 `meta: { kind: "album", ... }`）；6c 加一组 inline-DSL typed-meta 测试预防 Phase 7 才发现 wire 兼容问题

**已知接受的现状（6c 不修，Phase 7 处理）**：
- `GalleryBrowseEntry::Dir.total = None`（[`browse.rs:37`](../../src-tauri/core/src/gallery/browse.rs#L37)）—— per-child total 计算暂留 None；如有 UI 回归归到 Phase 7
- `vd_ops.rs` 文件系统 note 写入仍然只供 programmatic VD 用；DSL VD provider（Phase 7 补）若需要文件系统类数据，**需要在 pathql-rs 加另一个 executor 抽象（非 SQL）** —— Phase 7 第一件事，本期不做

---

## 锁定的设计选择

1. **`SqlExecutor` 抽象在 pathql-rs**：
   ```rust
   pub type SqlExecutor = Arc<
       dyn Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
           + Send + Sync + 'static
   >;
   ```
   - 输入：SQL 字符串 + bind 参数序列
   - 输出：每行 = `serde_json::Value::Object`（列名 → JSON 值）；用作 `${data_var.col}` 求值
   - 错误统一为 `EngineError`（含驱动错误转换）
2. **executor 注入到 ProviderRuntime**：
   - `ProviderRuntime::new(registry, root)` 不变；executor 缺省 = None
   - 加 `pub fn with_executor(self, exec: SqlExecutor) -> Self` 或 builder
   - 或更直接：`ProviderRuntime::new_with_executor(registry, root, executor)`
   - DslProvider 通过 `ctx.runtime.executor()` 拿；为 None 时动态项返回空 + log warning（与 6a S3 的 placeholder 一致）
3. **DslProvider 动态部分实现**（pathql-rs S0）：
   - `list()` 完整支持 Static / DynamicSql / DynamicDelegate 三态
   - `resolve()` 第三步：动态反查（朴素跑全数据源 + 模板比对，性能优化推后）
   - `materialize_dynamic_sql` / `materialize_dynamic_delegate` / `reverse_lookup_dynamic` 三 helper
4. **9 个 DSL-covered provider 名字**（从 `register_all_hardcoded` 跳过）：
   - `root_provider`
   - `gallery_route`
   - `gallery_all_router`
   - `gallery_paginate_router`
   - `gallery_page_router`
   - `page_size_provider`
   - `query_page_provider`
   - `vd_root_router`
   - `vd_zh_CN_root_router`
   
   其余 24 个（gallery_albums_router、gallery_album_provider、gallery_plugin_provider 等）保留 programmatic（仍是 hardcoded 实现，未来 Phase 7+ 才迁 DSL）。
5. **DSL 加载与硬编码 provider 共存**：DSL load → register；register_all_hardcoded → register（跳过 9 个名字）；同一 registry 含 DSL + Programmatic；resolve / instantiate 自然按 namespace 链查找
6. **dangling provider 处理**：DSL 文件引用了未注册的 provider（如 `gallery_albums_router` 在 root_provider 的 list 里）—— 由于 `cross_ref` 默认 off（spec §12.4），加载期不报错；运行期路径解析到该项时，registry.lookup 命中 programmatic 注册项即可
7. **fail-fast**：DSL 加载或 validate 失败 → core 启动 panic + 详细 stderr
8. **前端 ProviderMeta wire format 兼容**：6c 完成后 ChildEntry.meta 是 `Option<serde_json::Value>`（DSL meta 字段产出 JSON）；前端按 `meta.kind` switch 仍能识别 typed kind（"album" / "task" / "plugin" 等），因为 `wrap_typed_meta_json` helper 在 6b 已落地兼容；DSL meta 字段也产同形态 JSON（按 §4.5 启发式 / 模板渲染）即可

---

## 测试节奏

- **S0** 完成后 `cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿，pathql-rs 自包含 Mock SqlExecutor 测试
- **S1-S5** 串行做完后再跑 core 全套测试 + bun check + 手测

---

## 子任务拆解

### S0. pathql-rs：DslProvider 动态部分 + SqlExecutor 抽象

#### S0a. `SqlExecutor` 类型 + ProviderRuntime 注入

修改 `pathql-rs/src/provider/mod.rs`（或新建 `provider/executor.rs`）：

```rust
use std::sync::Arc;
use crate::template::eval::TemplateValue;
use super::EngineError;

/// SQL 执行能力的注入抽象。pathql-rs 不绑驱动; 终端注入实现 (rusqlite / sqlx / 等)。
///
/// 输入: SQL 字符串 + bind 参数序列
/// 输出: 每行 = JSON 对象 (列名 → 值); 作 `${data_var.col}` 求值上下文
pub type SqlExecutor = Arc<
    dyn Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
        + Send + Sync + 'static
>;
```

修改 `pathql-rs/src/provider/runtime.rs`：

```rust
pub struct ProviderRuntime {
    registry: Arc<ProviderRegistry>,
    root: Arc<dyn Provider>,
    weak_self: Weak<Self>,
    executor: Option<SqlExecutor>,  // 新增
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    /// 现有 new (executor = None)
    pub fn new(registry: Arc<ProviderRegistry>, root: Arc<dyn Provider>) -> Arc<Self> {
        Self::new_with_executor(registry, root, None)
    }

    /// 注入可选 executor。
    pub fn new_with_executor(
        registry: Arc<ProviderRegistry>,
        root: Arc<dyn Provider>,
        executor: Option<SqlExecutor>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            registry, root, executor,
            weak_self: weak.clone(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn executor(&self) -> Option<&SqlExecutor> {
        self.executor.as_ref()
    }
}
```

**测试要点**：
- `runtime_with_executor_some` / `_none`：构造两种 runtime；`executor()` 返回 Some/None
- `mock_executor_called`：构造 mock SqlExecutor，触发 DslProvider 动态项时被调用（S0b/c 完成后才能跑）

⚠️ `EngineError::ExecutorMissing` variant 已在 [`provider/mod.rs:93-94`](../../src-tauri/pathql-rs/src/provider/mod.rs#L93-L94) 定义；本子任务**不需新增 enum variant**，直接用即可。

**Test**：`cargo test -p pathql-rs provider::runtime`。

---

#### S0b. DslProvider 动态 list 实现

修改 `pathql-rs/src/provider/dsl_provider.rs`：

```rust
impl DslProvider {
    fn list_dynamic_sql(
        &self,
        entry: &DynamicSqlEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
        list_key_template: &str,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // 1. 取 executor (无则报错)
        let executor = ctx.runtime.executor()
            .ok_or_else(|| EngineError::FactoryFailed(...))?;

        // 2. 渲染 entry.sql, 处理 ${composed} 子查询替换
        let (composed_sql, composed_params) = composed
            .build_sql(&crate::template::eval::TemplateContext::default())?;
        let mut tctx = crate::template::eval::TemplateContext::default();
        tctx.composed = Some((composed_sql, composed_params));
        tctx.properties = self.properties.clone();
        let aliases = crate::compose::AliasTable::default();
        let (final_sql, final_params) = crate::compose::render_to_owned(
            &entry.sql.0,
            &tctx,
            &aliases,
        )?;

        // 3. 执行 SQL 拿行
        let rows = executor(&final_sql, &final_params)?;

        // 4. 每行渲染 key 模板 + properties + meta → 构造 ChildEntry
        let mut out = Vec::new();
        for row in rows {
            let mut row_ctx = crate::template::eval::TemplateContext::default();
            row_ctx.properties = self.properties.clone();
            row_ctx.data_var = Some((entry.data_var.0.clone(), row.clone()));

            let name = render_template_to_string(list_key_template, &row_ctx)?;

            // properties 渲染 (如有)
            let child_props = render_properties(&entry.properties, &row_ctx)?;

            // 实例化 child provider (entry.provider 三态)
            let child_provider = match &entry.provider {
                None => None,
                Some(name) => ctx.registry.instantiate(
                    /* current_ns */, name, &child_props, ctx,
                ),
            };

            // meta 渲染
            let child_meta = render_meta(&entry.meta, &row_ctx, &aliases)?;

            out.push(ChildEntry {
                name,
                provider: child_provider,
                meta: child_meta,
            });
        }
        Ok(out)
    }

    fn list_dynamic_delegate(
        &self,
        entry: &DynamicDelegateEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
        list_key_template: &str,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        // 1. resolve delegate 路径取目标 provider 的 children
        let target = ctx.runtime.resolve_with_initial(&entry.delegate.0, Some(composed.clone()))?;
        let sub_children = target.provider.list(&target.composed, ctx)?;

        // 2. 每个 sub_child 渲染 key 模板 (用 child_var) → 构造新 ChildEntry
        let mut out = Vec::new();
        for sub_child in sub_children {
            let child_json = serde_json::json!({
                "name": sub_child.name,
                "provider": sub_child.provider.is_some(),  // 占位; provider 不可序列化
                "meta": sub_child.meta,
            });

            let mut row_ctx = crate::template::eval::TemplateContext::default();
            row_ctx.properties = self.properties.clone();
            row_ctx.child_var = Some((entry.child_var.0.clone(), child_json));

            let name = render_template_to_string(list_key_template, &row_ctx)?;
            let child_props = render_properties(&entry.properties, &row_ctx)?;

            // entry.provider 三态:
            //   None → child.provider passthrough
            //   ProviderName → 通过 registry instantiate
            //   ${child_var.provider} → 用 sub_child.provider 透传
            let child_provider = match &entry.provider {
                None => sub_child.provider.clone(),  // passthrough
                Some(DelegateProviderField::Name(name)) => ctx.registry.instantiate(
                    /* current_ns */, name, &child_props, ctx,
                ),
                Some(DelegateProviderField::ChildRef(_)) => sub_child.provider.clone(),
            };

            let child_meta = render_meta(&entry.meta, &row_ctx, &Default::default())?;

            out.push(ChildEntry {
                name,
                provider: child_provider,
                meta: child_meta,
            });
        }
        Ok(out)
    }
}

impl Provider for DslProvider {
    fn list(&self, composed: &ProviderQuery, ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        let Some(list) = &self.def.list else { return Ok(Vec::new()) };
        let mut out = Vec::new();
        for (key, entry) in &list.entries {
            match entry {
                ListEntry::Static(invocation) => {
                    if let Some(child) = self.materialize_static(key, invocation, composed, ctx)? {
                        out.push(child);
                    }
                }
                ListEntry::Dynamic(DynamicListEntry::Sql(s)) => {
                    out.extend(self.list_dynamic_sql(s, composed, ctx, key)?);
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(d)) => {
                    out.extend(self.list_dynamic_delegate(d, composed, ctx, key)?);
                }
            }
        }
        Ok(out)
    }
}
```

**新 helper（`compose/render.rs`）**：

```rust
/// 渲染模板为纯字符串（无 SQL ? 占位; 把 TemplateValue 转为字面字符串拼接）。
/// 用于 key 模板、note 模板、object 形态 meta 模板等"纯字符串拼装"场景。
pub fn render_template_to_string(
    template: &str,
    ctx: &TemplateContext,
) -> Result<String, RenderError> {
    let ast = parse(template)?;
    let mut out = String::new();
    for seg in &ast.segments {
        match seg {
            Segment::Text(s) => out.push_str(s),
            Segment::Var(var) => {
                let v = evaluate_var(var, ctx)?;
                out.push_str(&template_value_to_string(&v));
            }
        }
    }
    Ok(out)
}

fn template_value_to_string(v: &TemplateValue) -> String {
    match v {
        TemplateValue::Null => "".into(),
        TemplateValue::Bool(b) => b.to_string(),
        TemplateValue::Int(i) => i.to_string(),
        TemplateValue::Real(r) => r.to_string(),
        TemplateValue::Text(s) => s.clone(),
        TemplateValue::Json(j) => j.to_string(),
    }
}
```

`render_properties / render_meta` 同样新建为内部 helper（递归渲染 HashMap / serde_json::Value）。

**测试要点**：
- `dsl_list_dynamic_sql_three_rows`：mock executor 返回 3 行；DslProvider.list 返回 3 ChildEntry；name 由 key 模板插值
- `dsl_list_dynamic_sql_with_composed`：entry.sql 含 `${composed}`；验证子查询字符串嵌入 + params 合并
- `dsl_list_dynamic_sql_no_executor`：runtime 无 executor → 返回错误（或 log + 空列表，按 §4.5 决策）
- `dsl_list_dynamic_delegate_two_children`：mock 子 provider list 返回 2 child；DSL provider 包装后名称按 child_var 渲染
- `dsl_list_dynamic_delegate_provider_passthrough`：entry.provider 缺省时 child.provider 透传
- `dsl_list_dynamic_delegate_provider_named`：entry.provider 为命名 provider → registry.instantiate

**Test**：`cargo test -p pathql-rs provider::dsl_provider`。

---

#### S0c. DslProvider 动态反查（resolve 第 3 步）

```rust
impl DslProvider {
    fn reverse_lookup_dynamic(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        let list = self.def.list.as_ref()?;
        // 朴素实现: 跑所有动态项的数据源, 每个产物渲染 key, 比对 name
        for (key, entry) in &list.entries {
            if let ListEntry::Dynamic(d) = entry {
                let candidates = match d {
                    DynamicListEntry::Sql(s) => self.list_dynamic_sql(s, composed, ctx, key).ok()?,
                    DynamicListEntry::Delegate(de) => self.list_dynamic_delegate(de, composed, ctx, key).ok()?,
                };
                for child in candidates {
                    if child.name == name {
                        return child.provider.clone();
                    }
                }
            }
        }
        None
    }
}

impl Provider for DslProvider {
    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        // 1. resolve.entries (regex)
        if let Some(resolve) = &self.def.resolve { /* ...原逻辑... */ }
        // 2. 静态 list 字面
        if let Some(list) = &self.def.list { /* ...原逻辑... */ }
        // 3. 动态反查（本步骤新增）
        self.reverse_lookup_dynamic(name, composed, ctx)
    }
}
```

⚠️ 性能：朴素实现可能跑全量数据源后才比对；千万级数据时不可接受。短期可用 LRU 缓存最近 list 结果（runtime 已有路径缓存）；长期需要"反向 SQL"——把 key 模板结构反推 WHERE 条件。本期标注风险，不优化。

**测试要点**：
- `dsl_resolve_dynamic_reverse_match`：mock executor 返回 5 行，name 命中第 3 行 → resolve 返回该 provider
- `dsl_resolve_dynamic_reverse_miss`：name 不在任何行 → None
- `dsl_resolve_three_step_priority`：regex / 静态 / 动态各有一个匹配 → 优先 regex

**Test**：`cargo test -p pathql-rs provider::dsl_provider`。

---

#### S0d. 真实 sqlite 集成测试 — DSL 动态 list 经 SqlExecutor 执行（`tests/dsl_dynamic_sqlite.rs`）

S0a-c 在 mock executor 下完成单元测试；S0d 用**真 in-memory sqlite** 包成 SqlExecutor，验证完整链路：DSL 加载 → ProviderQuery 累积 → render entry.sql → SqlExecutor → rows → ChildEntry。

新建 `pathql-rs/tests/dsl_dynamic_sqlite.rs`：

```rust
//! Phase 6c S0d: DSL 动态 list (SQL 数据源) + SqlExecutor (rusqlite) 端到端。
//! 不接 DSL 加载真文件; 用 inline ProviderDef fixture (json5 解析) 简化测试。

#![cfg(all(feature = "json5", feature = "sqlite"))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pathql_rs::ast::{Namespace, ProviderName, SimpleName};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{
    EngineError, Provider, ProviderContext, ProviderRuntime, SqlExecutor,
};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};
use rusqlite::Connection;
use serde_json::{Map, Value};

fn fixture_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE images (id INTEGER PRIMARY KEY, plugin_id TEXT);
        INSERT INTO images VALUES (1,'p1'),(2,'p1'),(3,'p2'),(4,'p2'),(5,'p3');
        ",
    ).unwrap();
    conn
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> SqlExecutor {
    Arc::new(move |sql: &str, params: &[TemplateValue]| -> Result<Vec<Value>, EngineError> {
        let conn = conn.lock().unwrap();
        let rusqlite_params = params_for(params);
        let mut stmt = conn.prepare(sql)
            .map_err(|e| EngineError::FactoryFailed("sql".into(), "prepare".into(), e.to_string()))?;
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(rusqlite_params.iter()), |row| {
            let mut obj = Map::new();
            for (i, col) in cols.iter().enumerate() {
                let v: rusqlite::types::Value = row.get(i)?;
                obj.insert(col.clone(), match v {
                    rusqlite::types::Value::Null => Value::Null,
                    rusqlite::types::Value::Integer(i) => Value::from(i),
                    rusqlite::types::Value::Real(f) => Value::from(f),
                    rusqlite::types::Value::Text(s) => Value::String(s),
                    rusqlite::types::Value::Blob(_) => Value::Null,
                });
            }
            Ok(Value::Object(obj))
        }).map_err(|e| EngineError::FactoryFailed("sql".into(), "query".into(), e.to_string()))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| EngineError::FactoryFailed("sql".into(), "rows".into(), e.to_string()))
    })
}

#[test]
fn dynamic_sql_list_yields_one_child_per_distinct_plugin() {
    let conn = Arc::new(Mutex::new(fixture_db()));
    let executor = make_executor(conn.clone());

    // 加载一个 inline DSL: list 里一个动态 SQL 项
    let json = r#"{
        "namespace": "test",
        "name": "plugins",
        "query": { "from": "images" },
        "list": {
            "${row.plugin_id}": {
                "sql": "SELECT DISTINCT plugin_id FROM (${composed})",
                "data_var": "row"
            }
        }
    }"#;
    let def = Json5Loader.load(Source::Str(json)).unwrap();
    let mut registry = ProviderRegistry::new();
    registry.register(def).unwrap();
    let registry = Arc::new(registry);

    // root = DslProvider 直接构造 (registry.lookup → Dsl entry → 包 DslProvider)
    let root: Arc<dyn Provider> = match registry.lookup(
        &Namespace("test".into()),
        &ProviderName("plugins".into()),
    ).unwrap() {
        pathql_rs::registry::RegistryEntry::Dsl(def) => {
            Arc::new(pathql_rs::provider::DslProvider {
                def: def.clone(),
                properties: HashMap::new(),
            })
        }
        _ => panic!(),
    };

    let runtime = ProviderRuntime::new_with_executor(registry, root, Some(executor));

    // list 触发 dynamic SQL 执行
    let children = runtime.list("/").unwrap();
    let names: Vec<String> = children.iter().map(|c| c.name.clone()).collect();

    // 期望: 3 个 distinct plugin_id
    assert_eq!(names.len(), 3);
    assert!(names.contains(&"p1".to_string()));
    assert!(names.contains(&"p2".to_string()));
    assert!(names.contains(&"p3".to_string()));
}

#[test]
fn dynamic_reverse_lookup_finds_specific_plugin() {
    /* 类似上面, 用 runtime.resolve("/p2") 触发动态反查; 验证返回非 None */
}

#[test]
fn dynamic_sql_with_composed_filters_upstream() {
    /* 在 root 加 where 过滤 (id > 2), 确认 ${composed} 子查询正确嵌入 + 结果反映过滤 */
}
```

**测试目标**：
- DslProvider 动态 list SQL 项的 executor 注入路径
- ${composed} 子查询正确替换为父级 ProviderQuery 的 build_sql 结果
- 行 → JSON → TemplateContext.data_var → key 模板渲染整链
- runtime.list 触发动态项执行；runtime.resolve 触发动态反查

**Test**：`cargo test -p pathql-rs --features "json5 sqlite" --test dsl_dynamic_sqlite`。

---

### S1pre. 把 9 个 `.json5` 移到 `core/src/providers/dsl/` 子目录

**目标**：让 `include_dir!()` 嵌入范围最小化、不混入业务 .rs 源码。

**目录调整**：

```
src-tauri/core/src/providers/
├── dsl/                              ← 新建
│   ├── root_provider.json
│   ├── schema.json5                  ← 移过来; loader 仍按 basename ignore
│   ├── gallery/
│   │   ├── gallery_route.json5
│   │   ├── gallery_all_router.json5
│   │   ├── gallery_paginate_router.json5
│   │   └── gallery_page_router.json5
│   ├── shared/
│   │   ├── page_size_provider.json5
│   │   └── query_page_provider.json5
│   └── vd/
│       ├── vd_root_router.json5
│       └── vd_zh_CN_root_router.json5
├── gallery/        ← 删除子目录（只剩 .json5 在 dsl/gallery/）
├── shared/         ← 删除子目录
├── vd/             ← 删除子目录
├── programmatic/   ← 保持不动
├── provider.rs / init.rs / mod.rs / query.rs / vd_ops.rs   ← 保持不动
└── (gallery / shared / vd 子目录删除后, 业务 Rust 模块全在 programmatic/ 内)
```

⚠️ 同步检查：
- `core/src/providers/gallery/` / `shared/` / `vd/` 目录在 6b 已经只剩 `.json5`（无 .rs 文件了；programmatic/ 是业务实现的归宿）→ 直接 `git mv` 三个子目录到 `dsl/` 下即可
- `core/src/providers/schema.json5` + `root_provider.json` 也一并移到 `dsl/`
- `mod.rs` / `init.rs` / `query.rs` 等 Rust 文件不动，仍在 `providers/` 根

**git 操作**：

```bash
mkdir src-tauri/core/src/providers/dsl
git mv src-tauri/core/src/providers/gallery       src-tauri/core/src/providers/dsl/gallery
git mv src-tauri/core/src/providers/shared        src-tauri/core/src/providers/dsl/shared
git mv src-tauri/core/src/providers/vd            src-tauri/core/src/providers/dsl/vd
git mv src-tauri/core/src/providers/root_provider.json  src-tauri/core/src/providers/dsl/root_provider.json
git mv src-tauri/core/src/providers/schema.json5  src-tauri/core/src/providers/dsl/schema.json5
```

⚠️ `pathql-rs/tests/load_real_providers.rs`（Phase 2 集成测试）路径常量从 `core/src/providers/...` 改为 `core/src/providers/dsl/...`；同步更新。

**测试要点**：仅文件移动，无代码逻辑改变。

**Test**：
- `cargo test -p pathql-rs --features json5` 全绿（路径常量更新后 load_real_providers 仍通过）
- `cargo build -p kabegame-core` 干净（providers/mod.rs 没有 mod gallery / shared / vd 引用，无影响）

---

### S1. core 升级 pathql-rs feature 集 + 引入 include_dir

**1a. 根 [`Cargo.toml`](../../Cargo.toml) `[workspace.dependencies]` 加入 include_dir**：

```toml
[workspace.dependencies]
# ... existing
include_dir = "0.7"
```

⚠️ 实测此 dep 当前**不在 workspace deps**——必须本期添加，不是 6b 遗留。

**1b. [`src-tauri/core/Cargo.toml`](../../src-tauri/core/Cargo.toml)** 升级 feature 集 + 加 include_dir：

```toml
[dependencies]
pathql-rs = { workspace = true, features = ["json5", "validate", "sqlite"] }
include_dir = { workspace = true }
```

**测试要点**：纯依赖变更。

**Test**：`cargo check -p kabegame-core` 通过；`cargo test -p kabegame-core` 全绿（无回归）。

---

### S2. core SqlExecutor 实现（`core/src/providers/sql_executor.rs`）

```rust
//! 把 rusqlite 包装为 pathql-rs SqlExecutor。
//! 6c: 不开 query feature (sqlx); 自管 rusqlite。

use std::sync::Arc;
use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{EngineError, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use serde_json::{Map, Value as JsonValue};

use crate::storage::Storage;

pub fn make_sql_executor() -> SqlExecutor {
    Arc::new(|sql: &str, params: &[TemplateValue]| -> Result<Vec<JsonValue>, EngineError> {
        let storage = Storage::global();
        let conn = storage.conn.lock().unwrap();
        let rusqlite_params = params_for(params);
        let mut stmt = conn.prepare(sql)
            .map_err(|e| EngineError::FactoryFailed("sql".into(), "prepare".into(), e.to_string()))?;
        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(rusqlite_params.iter()), |row| {
            let mut obj = Map::with_capacity(column_names.len());
            for (i, col) in column_names.iter().enumerate() {
                let val: rusqlite::types::Value = row.get(i)?;
                obj.insert(col.clone(), rusqlite_value_to_json(val));
            }
            Ok(JsonValue::Object(obj))
        })
        .map_err(|e| EngineError::FactoryFailed("sql".into(), "query".into(), e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| EngineError::FactoryFailed("sql".into(), "rows".into(), e.to_string()))
    })
}

fn rusqlite_value_to_json(v: rusqlite::types::Value) -> JsonValue {
    match v {
        rusqlite::types::Value::Null => JsonValue::Null,
        rusqlite::types::Value::Integer(i) => JsonValue::from(i),
        rusqlite::types::Value::Real(f) => JsonValue::from(f),
        rusqlite::types::Value::Text(s) => JsonValue::String(s),
        rusqlite::types::Value::Blob(b) => JsonValue::String(base64::encode(&b)),
    }
}
```

⚠️ 注意 `Storage::global()` 假设是单例；如果 rusqlite Connection 在测试期 mock，要相应处理。`base64` 已在 workspace deps；如未引入，删掉 Blob → base64 改用 null。

⚠️ **存储锁重入约束**：SqlExecutor 闭包内部 `storage.conn.lock()`；如果 SqlExecutor 在 *已经持有* `storage.conn` 锁的栈上下文里被调用，会**死锁**（`Mutex` 非递归）。当前 [`query.rs`](../../src-tauri/core/src/providers/query.rs) 调用顺序是：

```
runtime.list(path) → DslProvider.list → SqlExecutor (lock acquire / release)
  ⤷ 然后串行：fetch_images_for(...) → Storage::get_images_*_by_query (lock acquire / release)
  ⤷ 然后串行：Storage::get_images_count_by_query (lock acquire / release)
```

各 step 串行释放锁，安全。**约束**：今后任何在 `Storage` 方法内部已持锁、内部又触发 `runtime.list / runtime.resolve / runtime.meta` 的代码路径都会死锁；新增此类调用时必须改为先释放锁再调 runtime。S2 实现注释明示此点。

**测试要点**：
- 构造内存 sqlite + 注册 SqlExecutor → 跑简单 SELECT → 行返回正确
- 列类型映射：Integer / Real / Text / Null → JSON 对应类型

**Test**：`cargo test -p kabegame-core providers::sql_executor`。

---

### S3. core DSL loader 模块（`core/src/providers/dsl_loader.rs`）

```rust
//! DSL 加载: include_dir 嵌入 + Json5Loader.load + validate + 注入 registry。

use std::collections::HashSet;
use include_dir::{include_dir, Dir};
use pathql_rs::ast::{Namespace, ProviderName};
use pathql_rs::validate::{validate, ValidateConfig};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

// 仅嵌入 DSL 子目录, 不混入 .rs 业务源码 (S1pre 已把 .json5 集中到 dsl/)
static EMBEDDED_PROVIDERS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/src/providers/dsl");

const IGNORED_BASENAMES: &[&str] = &["schema.json5"];

#[derive(Debug, thiserror::Error)]
pub enum LoadDslError {
    #[error("load errors:\n  {0}")]
    Load(String),
    #[error("validate failed with {n} error(s):\n  {first}")]
    Validate { n: usize, first: String },
}

/// 把 9 个真实 .json5 加载到现有 registry; 与 programmatic 项共存。
/// 加载失败立即返回错误。
pub fn load_dsl_into(
    registry: &mut ProviderRegistry,
    table_whitelist: Option<HashSet<String>>,
) -> Result<usize, LoadDslError> {
    let loader = Json5Loader;
    let mut errors = Vec::new();
    let mut count = 0;

    for entry in EMBEDDED_PROVIDERS.find("**/*").into_iter().flatten() {
        let Some(file) = entry.as_file() else { continue };
        let path = file.path();
        let basename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if IGNORED_BASENAMES.contains(&basename) { continue; }
        let ext = path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("json") | Some("json5")) { continue; }
        match loader.load(Source::Bytes(file.contents())) {
            Ok(def) => {
                if let Err(e) = registry.register(def) {
                    errors.push(format!("register {}: {}", path.display(), e));
                } else {
                    count += 1;
                }
            }
            Err(e) => {
                errors.push(format!("load {}: {}", path.display(), e));
            }
        }
    }

    if !errors.is_empty() {
        return Err(LoadDslError::Load(errors.join("\n  ")));
    }

    let mut cfg = ValidateConfig::with_default_reserved();
    cfg.table_whitelist = table_whitelist;
    if let Err(verrs) = validate(registry, &cfg) {
        let n = verrs.len();
        let first = verrs.iter().take(20).map(|e| e.to_string()).collect::<Vec<_>>().join("\n  ");
        return Err(LoadDslError::Validate { n, first });
    }

    Ok(count)
}

/// 业务表白名单 (ValidateConfig.table_whitelist)
pub fn build_kabegame_table_whitelist() -> HashSet<String> {
    [
        "images", "albums", "album_images", "tasks", "surf_records",
        "plugins", "run_configs", "hidden_albums", "favorites", "thumbnails",
        // ... 其他业务表名 (按实际 schema 补)
    ].into_iter().map(String::from).collect()
}
```

**测试要点**：
- `loads_9_dsl_providers`：调 `load_dsl_into(empty_registry, Some(whitelist))` → count = 9，registry 含 `kabegame.root_provider` 等
- `validate_failure_panics`：注入 broken whitelist（缺业务表）→ Validate 错误返回

**Test**：`cargo test -p kabegame-core providers::dsl_loader`。

---

### S4. `register_all_hardcoded` 跳过 9 个 DSL-covered 名字

#### S4a. 核对 9 个 DSL 名字是否在当前 programmatic 注册清单中

实测 [`programmatic/mod.rs`](../../src-tauri/core/src/providers/programmatic/mod.rs) 内 39 处 `register()`。**先 grep 核对 9 个 DSL-covered 名字均在被注册之列**——若某个名字现在没被 programmatic 注册（如 `gallery_page_router` 也许是嵌套 stateless 内联 struct，未独立 register），则"skip"是无操作，必须 grep 后确认：

```bash
for name in root_provider gallery_route gallery_all_router gallery_paginate_router \
            gallery_page_router page_size_provider query_page_provider \
            vd_root_router vd_zh_CN_root_router; do
  echo "=== $name ==="
  grep -n "register(reg, \"$name\"" src-tauri/core/src/providers/programmatic/mod.rs
done
```

预期 9 行命中；未命中的名字要么本来就没 programmatic 实现（dangling，DSL 唯一来源），要么名字写错。

#### S4b. 跳过 9 个名字的 register 调用

修改 [`programmatic/mod.rs`](../../src-tauri/core/src/providers/programmatic/mod.rs)：

```rust
/// 9 个由 DSL 覆盖的 provider 名字; programmatic 注册跳过。
const DSL_COVERED: &[&str] = &[
    "root_provider",
    "gallery_route",
    "gallery_all_router",
    "gallery_paginate_router",
    "gallery_page_router",
    "page_size_provider",
    "query_page_provider",
    "vd_root_router",
    "vd_zh_CN_root_router",
];

pub fn register_all_hardcoded(reg: &mut ProviderRegistry) -> Result<(), pathql_rs::RegistryError> {
    // ── shared (跳过 page_size_provider, query_page_provider) ──
    register(reg, "sort_provider", |_| { ... })?;
    // register(reg, "page_size_provider", ...)  ← 注释 (DSL covered)
    // register(reg, "query_page_provider", ...) ← 注释 (DSL covered)

    // ── root + gallery routes (跳过 root_provider, gallery_route, gallery_all_router, gallery_paginate_router) ──
    // register(reg, "root_provider", ...)         ← 注释 (DSL covered)
    // register(reg, "gallery_route", ...)         ← 注释 (DSL covered)
    // register(reg, "gallery_all_router", ...)    ← 注释 (DSL covered)
    // register(reg, "gallery_paginate_router", ...) ← 注释 (DSL covered)
    // gallery_page_router: 6b 内嵌于 gallery_paginate_router 还是独立 register? 由 S4a 核对决定

    register(reg, "gallery_albums_router", |_| { ... })?;
    register(reg, "gallery_album_provider", |props| { ... })?;
    // ... 其余 24+ 个保留

    // ── vd (跳过 vd_root_router, vd_zh_CN_root_router) ──
    // register(reg, "vd_root_router", ...)        ← 注释 (DSL covered)
    // register(reg, "vd_zh_CN_root_router", ...)  ← 注释 (DSL covered, 若已 register)

    register(reg, "vd_albums_provider", |props| { ... })?;
    // ... 其余 vd 项

    Ok(())
}
```

总计：**39 - 9 = 30** 个 register 调用（注释而非删除：保留函数体方便 Phase 7+ 切换或 fallback）。

⚠️ S4a 若发现某个 DSL-covered 名字本来就没 programmatic 注册（如 `gallery_page_router` 是别名？），从 `DSL_COVERED` 中移除；最终 skip 数可能小于 9。

**测试要点**：
- `register_all_hardcoded_count_30`：运行后 registry programmatic 项 = 30（按 S4a 核对结果可能略变）
- `dsl_covered_names_not_programmatically_registered`：lookup `kabegame.root_provider` 返回 None（DSL load 之前）

**Test**：`cargo test -p kabegame-core providers::programmatic`。

---

### S5. core init.rs 改造（`core/src/providers/init.rs`）

```rust
//! ProviderRuntime 启动期初始化 (6c: DSL + programmatic 共存)。

use std::sync::Arc;
use std::sync::OnceLock;
use std::collections::HashMap;
use pathql_rs::{ProviderRegistry, ProviderRuntime};
use pathql_rs::ast::{Namespace, ProviderName};

use super::dsl_loader::{load_dsl_into, build_kabegame_table_whitelist};
use super::programmatic::register_all_hardcoded;
use super::sql_executor::make_sql_executor;

static RUNTIME: OnceLock<Arc<ProviderRuntime>> = OnceLock::new();

pub fn provider_runtime() -> &'static Arc<ProviderRuntime> {
    RUNTIME.get_or_init(|| {
        let mut registry = ProviderRegistry::new();

        // 1. 先注册 programmatic (24 个; 跳过 DSL-covered)
        register_all_hardcoded(&mut registry).expect("register hardcoded providers");

        // 2. 再加载 DSL (9 个 .json5)
        let whitelist = build_kabegame_table_whitelist();
        let dsl_count = load_dsl_into(&mut registry, Some(whitelist))
            .expect("DSL load failed");
        log::info!("DSL providers loaded: {}", dsl_count);

        let registry = Arc::new(registry);

        // 3. 实例化 root_provider via DSL (registry.instantiate 命中 DSL 项构造 DslProvider)
        // 由于 DslProvider 是 stateless (def + properties only), 直接通过 lookup 获取 def 后实例化
        let root_def = registry.lookup(
            &Namespace("kabegame".into()),
            &ProviderName("root_provider".into()),
        ).expect("root_provider not found");
        let root: Arc<dyn pathql_rs::Provider> = match root_def {
            pathql_rs::registry::RegistryEntry::Dsl(def) => Arc::new(pathql_rs::DslProvider {
                def: def.clone(),
                properties: HashMap::new(),
            }),
            _ => panic!("root_provider expected to be DSL in 6c"),
        };

        // 4. 构造 SqlExecutor 并创建 runtime
        let executor = make_sql_executor();
        ProviderRuntime::new_with_executor(registry, root, Some(executor))
    })
}
```

⚠️ root 实例化方式：当前直接 lookup + 构造 `DslProvider`；理论上可以走 `Registry::instantiate(...)` 但需要 ctx，而 ctx 需要 runtime——直接构造 DslProvider 更简洁。DslProvider 在 ctx-passing 设计下不持 runtime/registry 字段，只需 def + properties。

**测试要点**：
- `init_succeeds`：调 `provider_runtime()` 不 panic，runtime 含 30 + 9 = 39 个 registry 项（按 S4a 实测调整）
- `runtime_has_executor`：`runtime.executor()` 返回 Some
- `root_is_dsl_provider`：root 是 DslProvider 实例（可通过 downcast 或行为验证）
- `resolve_gallery_all_x100x_1_works`：`runtime.resolve("/gallery/all/x100x/1/")` 走 DSL 链 → 命中 query_page_provider；composed.from = "images"; offset / limit 来自 query_page_provider 的 ContribQuery

**Test**：`cargo test -p kabegame-core providers::init`。

---

### S5bis. IPC 层暴露当前节点 meta（**新增子任务**）

**问题**：[`query.rs:150,176`](../../src-tauri/core/src/providers/query.rs#L150) `execute_provider_query_typed` 对 Entry / Listing 都硬编码 `meta: None`；DSL provider 在 `meta:` 字段产的 JSON 永远不到前端。本期补：让"当前路径节点的 meta"从 runtime 取出送 IPC。

#### S5bis-a. pathql-rs 新增 `runtime.meta(path)` API

**语义**：路径 `/a/b/c` 的 meta = "父节点 `/a/b` list 输出中 `name=c` 那个 ChildEntry 的 meta"。`/`（root）无 meta（无父）。

新增 `pathql-rs/src/provider/runtime.rs`：

```rust
impl ProviderRuntime {
    /// 返回路径对应节点在父级 list 中的 meta（无父或父 list 不含该名时返回 None）。
    pub fn meta(&self, path: &str) -> Result<Option<serde_json::Value>, EngineError> {
        let normalized = normalize(path); // 已有 helper
        let segs: Vec<&str> = normalized.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        if segs.is_empty() { return Ok(None); }  // root 无 meta
        let last = segs.last().unwrap().to_string();
        let parent_path = if segs.len() == 1 {
            "/".to_string()
        } else {
            format!("/{}", segs[..segs.len()-1].join("/"))
        };
        let children = self.list(&parent_path)?;
        Ok(children.into_iter().find(|c| c.name == last).and_then(|c| c.meta))
    }
}
```

⚠️ 性能：`meta(path)` 走父级 `list()`；如果父级 list 是 dynamic SQL，每次 meta 调用就跑一次 SQL。runtime 的路径 LRU 缓存覆盖了 list 结果时是 O(1)；冷启动或被踢出时是 O(N)。短期可接受；长期需要 list 结果缓存（独立于路径解析缓存）。

**测试要点**：
- `meta_root_returns_none`
- `meta_child_with_meta_field`：mock 父 provider list 产 `[{name:"x", meta: Some(json!({"k":"v"}))}]`；`meta("/x")` 返回 `Some(json!({"k":"v"}))`
- `meta_child_without_meta_field`：父 list 产 `[{name:"x", meta: None}]`；返回 None
- `meta_path_not_found`：父 list 不含该 name；返回 None
- `meta_root_provider_list_works`：从真 root_provider DSL list 取 "gallery" / "vd" 项 meta（DSL 当前无 meta 字段，应返回 None — wire format 兼容验证）

#### S5bis-b. core IPC 层调用 runtime.meta

修改 [`core/src/providers/query.rs`](../../src-tauri/core/src/providers/query.rs)：

```rust
// in execute_provider_query_typed Entry arm:
let meta = rt.meta(&rt_path).ok().flatten();  // ← 替代 meta: None
Ok(ProviderQueryTyped::Entry { name: last, meta, note: parse_note(raw_note), total })

// in Listing arm:
let meta = rt.meta(&rt_path).ok().flatten();  // ← 替代 meta: None
Ok(ProviderQueryTyped::Listing { entries, total, meta, note: parse_note(raw_note) })
```

⚠️ 错误处理：meta 解析失败（父 provider list 报错）→ 静默返回 None，不阻断 entry/listing 主流程；list 错误已经在主路径捕获。

#### S5bis-c. typed-meta wire format 兼容性测试（Phase 7 预防）

当前 9 个 .json5 都没 `meta:` 字段；本测试用 inline DSL 验证 typed meta 的 wire format 路径：

新建 `pathql-rs/tests/dsl_typed_meta_wire.rs`（feature `json5`）：

```rust
#![cfg(feature = "json5")]

#[test]
fn typed_meta_album_kind_round_trips_to_json_object() {
    let json = r#"{
        "namespace": "test",
        "name": "albums_provider",
        "list": {
            "alpha": {
                "provider": "leaf_provider",
                "meta": { "kind": "album", "data": { "id": "alpha-1", "title": "Alpha" } }
            }
        }
    }"#;
    let def = Json5Loader.load(Source::Str(json)).unwrap();
    // ... 注册 mock leaf_provider; 构造 DslProvider; 调 list() → 取 children[0].meta
    // 期望 meta = Some(json!({"kind":"album","data":{"id":"alpha-1","title":"Alpha"}}))
    // 验证序列化为 JSON 后与 wrap_typed_meta_json(MetaEntityKind::Album) 同形
}

#[test]
fn dynamic_template_meta_renders_properties_and_capture() {
    // DSL meta 字段含 ${properties.X} / ${capture[N]} 模板, 验证 walk_meta_value 渲染正确
}
```

**目标**：Phase 7 把 vd_albums_provider 等 typed-meta provider 迁 DSL 时，wire format 已经预验证通过。

**Test**：`cargo test -p pathql-rs --features json5 --test dsl_typed_meta_wire`。

---

### S6. 端到端验证 — 真 sqlite 全链测试（在 pathql-rs 内）

**核心约束**：所有"真 SQL 执行"端到端测试都放 pathql-rs 内，**不在 core 里测**——pathql-rs 自包含、不依赖 kabegame DB schema、用 mock fixture 模拟典型业务场景。core 端验证仅靠 cargo test + bun check + 手测 dev server。

**新建** `pathql-rs/tests/dsl_full_chain_sqlite.rs`：加载现有 9 个真 .json5 文件（沿用 Phase 2 `tests/load_real_providers.rs` 的相对路径访问 `../../core/src/providers/`）+ 注册一组 mock programmatic providers 模拟 6b 中 24 个硬编码项 + 真 in-memory sqlite + SqlExecutor 注入 + 跑核心路径。

```rust
//! Phase 6c S6: 用 pathql-rs 自包含端到端验证 DSL + programmatic 混合 + 真 sqlite 执行。
//! 测试 fixture: 加载 9 个真 .json5 + 注册 mock programmatic provider 模拟 24 处硬编码 +
//!              SQLite in-memory schema 模拟 kabegame 主要表。

#![cfg(all(feature = "json5", feature = "validate", feature = "sqlite"))]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pathql_rs::ast::{Namespace, ProviderName, SimpleName};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{
    ChildEntry, EngineError, Provider, ProviderContext, ProviderRuntime, SqlExecutor,
};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::validate::{validate, ValidateConfig};
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

/// 9 个真 .json5 文件路径 (相对 pathql-rs/tests/)
const PROVIDER_FILES: &[&str] = &[
    "../../core/src/providers/root_provider.json",
    "../../core/src/providers/gallery/gallery_route.json5",
    "../../core/src/providers/gallery/gallery_all_router.json5",
    "../../core/src/providers/gallery/gallery_paginate_router.json5",
    "../../core/src/providers/gallery/gallery_page_router.json5",
    "../../core/src/providers/shared/page_size_provider.json5",
    "../../core/src/providers/shared/query_page_provider.json5",
    "../../core/src/providers/vd/vd_root_router.json5",
    "../../core/src/providers/vd/vd_zh_CN_root_router.json5",
];

fn fixture_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            title TEXT,
            plugin_id TEXT,
            crawled_at INTEGER
        );
        CREATE TABLE album_images (album_id TEXT, image_id INTEGER);
        INSERT INTO images VALUES
            (1,'a','p1',1700000000),
            (2,'b','p1',1700000100),
            (3,'c','p2',1700000200),
            (4,'d','p2',1700000300),
            (5,'e','p3',1700000400);
        INSERT INTO album_images VALUES ('A',1),('A',2),('B',3),('B',4);
        ",
    ).unwrap();
    conn
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> SqlExecutor {
    /* 同 S0d 版本 */
    todo!()
}

fn build_full_runtime(conn: Arc<Mutex<Connection>>) -> Arc<ProviderRuntime> {
    let mut registry = ProviderRegistry::new();

    // 1. 加载 9 个真 .json5
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let loader = Json5Loader;
    for rel in PROVIDER_FILES {
        let path = manifest.join("tests").join(rel);
        let def = loader.load(Source::Path(&path)).unwrap();
        registry.register(def).unwrap();
    }

    // 2. validate (cross_ref off; programmatic 项稍后注册)
    let cfg = ValidateConfig::with_default_reserved();
    validate(&registry, &cfg).unwrap();

    // 3. 注册 mock programmatic providers 模拟 6b 硬编码项 (本测试用 stub: list/resolve 返回空 / 简单)
    register_mock_gallery_albums_router(&mut registry);
    register_mock_gallery_album_provider(&mut registry);
    // ... 其他 mocks 按测试覆盖范围补
    
    let registry = Arc::new(registry);

    // 4. 实例化 root via DSL (root_provider 是 DSL)
    let root = match registry.lookup(
        &Namespace("kabegame".into()),
        &ProviderName("root_provider".into()),
    ).unwrap() {
        pathql_rs::registry::RegistryEntry::Dsl(def) => Arc::new(
            pathql_rs::provider::DslProvider {
                def: def.clone(),
                properties: HashMap::new(),
            }
        ) as Arc<dyn Provider>,
        _ => panic!(),
    };

    let executor = make_executor(conn);
    ProviderRuntime::new_with_executor(registry, root, Some(executor))
}

#[test]
fn gallery_all_x100x_1_resolves_via_dsl_chain() {
    let conn = Arc::new(Mutex::new(fixture_db()));
    let runtime = build_full_runtime(conn.clone());
    
    let resolved = runtime.resolve("/gallery/all/x100x/1/").unwrap();
    
    // 期望 composed:
    // - from = "images" (gallery_route 设置)
    // - limit = ${properties.page_size} (= 100, query_page_provider)
    // - offset = ${properties.page_size} * (${properties.page_num} - 1) (= 0)
    let (sql, values) = resolved.composed.build_sql(&TemplateContext::default()).unwrap();
    
    assert!(sql.contains("FROM images"));
    assert!(sql.contains("LIMIT"));
    assert!(sql.contains("OFFSET"));
    
    // 真 sqlite 执行
    let conn_lock = conn.lock().unwrap();
    let params = params_for(&values);
    let mut stmt = conn_lock.prepare(&sql).unwrap();
    let ids: Vec<i64> = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    
    assert!(ids.len() <= 100);  // 分页生效
}

#[test]
fn gallery_all_x100x_lists_pages_via_dynamic_sql() {
    let conn = Arc::new(Mutex::new(fixture_db()));
    let runtime = build_full_runtime(conn);
    
    // page_size_provider 的动态 list 跑 SELECT page_num... 
    let children = runtime.list("/gallery/all/x100x/").unwrap();
    
    // 5 张图 / page_size 100 = 1 页
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "1");
}

#[test]
fn vd_zh_cn_root_resolves_static_routes() {
    let conn = Arc::new(Mutex::new(fixture_db()));
    let runtime = build_full_runtime(conn);
    
    // vd_root_router (i18n 分发) → vd_zh_CN_root_router → "按画册"
    // 由于 vd_albums_provider 是 dangling (未在 9 个真文件中), 期望 PathNotFound
    let result = runtime.resolve("/vd/i18n-zh_CN/按画册/");
    assert!(matches!(result, Err(EngineError::PathNotFound(_))));
}

#[test]
fn longest_prefix_cache_works_in_full_chain() {
    let conn = Arc::new(Mutex::new(fixture_db()));
    let runtime = build_full_runtime(conn);
    
    let _ = runtime.resolve("/gallery/all/x100x/1/").unwrap();
    let cache_size_after_first = runtime.cache_size();
    let _ = runtime.resolve("/gallery/all/x100x/2/").unwrap();
    let cache_size_after_second = runtime.cache_size();
    
    // 第二次 /x100x/1 → /x100x/2 共享前缀 /gallery/all/x100x; 仅新增 /2 一项
    assert_eq!(cache_size_after_second, cache_size_after_first + 1);
}
// ⚠️ runtime.cache_size() 是 pathql-rs 测试专用 public 访问器; 当前未必暴露,
// S6 实现前需 grep ProviderRuntime 确认; 缺则在本期顺手加 #[cfg(any(test, feature = "test-internals"))] 公开。
```

**测试目标**：
- 9 个真 .json5 加载 + validate 无错（重复 Phase 2 测试在 6c 上下文下）
- DSL fold + build_sql 在真 SQL 引擎上语义正确
- DSL ↔ programmatic 跨调用边界（DSL `gallery_route.list` 引用 mock `gallery_albums_router` 等）
- 动态 SQL list 通过真 SqlExecutor 执行得正确行
- longest-prefix 缓存在真路径下生效
- ${composed} 子查询在嵌套场景下嵌入正确

**Test**：`cargo test -p pathql-rs --features "json5 validate sqlite" --test dsl_full_chain_sqlite`。

---

### S6b. core 端验证（仅编译 + 手测，无新测试）

```bash
cargo build -p kabegame-core           # 编译干净
cargo test -p kabegame-core            # 现有测试不回归
cargo test -p pathql-rs --features "json5 validate sqlite"  # pathql-rs 全套通过
bun check -c main --skip vue
```

**手测**：

```bash
bun dev -c main --data prod
# 浏览 /gallery/all/x100x/1/ → 应能列图
# 浏览 /vd/i18n-zh_CN/按画册/<album_id>/ → 应能列图 (经 dangling provider gallery_albums_router 走 programmatic)
# 浏览未覆盖路径 → 仍 OK (programmatic 路径)
# 检查启动 log: "DSL providers loaded: 9"
```

⚠️ 预期某些 dangling 路径仍 404（如 vd_en_US_root_router 还没补）；记录但不影响验证主路径。

**注意**：core 端**不写专门的集成测试**（避免依赖业务 DB schema + Tauri runtime 启动栈）。pathql-rs 内的 S6 全链测试已经覆盖核心 DSL→SQL→执行链路；core 端只确保编译通过 + 手测主路径不回归。

---

### S7. 前端 ProviderMeta wire format 验证

DSL meta 字段产出 `serde_json::Value` 直接通过 IPC（S5bis 暴露后）走给前端。前端代码 `meta.kind` switch 期望是字符串字面（"album" / "task" / "plugin" 等）。

**核查清单**：
- 9 个 DSL 文件中**没有**显式 meta 字段 → 前端拿到 `meta = null`，与硬编码版本（也无 meta）一致
- programmatic 路径的 meta 走 `wrap_typed_meta_json` helper（6b 实现）→ wire format 一致：`{kind: "album", data: {...}}`
- DSL typed meta 兼容路径已在 S5bis-c 通过 inline DSL `dsl_typed_meta_wire.rs` 测试预验证

**6c 期实测点**：
1. grep `core/src/providers/dsl/**/*.json5` 中 `"meta"` 字段，逐个核查产出形态
2. 当前 9 个 .json5 应全部无 meta（设计上 root + 路由壳 + 分页 provider 都不需要 typed meta）
3. 前端 dev server 浏览 `/gallery/all/x100x/1/` 等路径，确认 entry/listing 响应中 `meta = null`，与 6b 行为一致

**Test**：手动核查 + 前端 dev server 浏览验证不出错 + S5bis-c `cargo test -p pathql-rs --features json5 --test dsl_typed_meta_wire`。

---

## 完成标准

- [ ] S1pre：9 个 .json5 + schema.json5 已 git mv 到 `core/src/providers/dsl/`；`pathql-rs/tests/load_real_providers.rs` 路径常量同步更新；`cargo test -p pathql-rs --features json5` 全绿
- [ ] `cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿（含 S0 ~12 单测 + S0d sqlite dynamic 集成 + S5bis-c typed-meta wire + S6 全链 sqlite 集成）
- [ ] `cargo test -p pathql-rs --features "json5 sqlite" --test dsl_dynamic_sqlite` 全绿（S0d）
- [ ] `cargo test -p pathql-rs --features json5 --test dsl_typed_meta_wire` 全绿（S5bis-c）
- [ ] `cargo test -p pathql-rs --features "json5 validate sqlite" --test dsl_full_chain_sqlite` 全绿（S6）
- [ ] `cargo test -p kabegame-core` 全绿（含 sql_executor / dsl_loader / programmatic / init 新测试 + S5bis-b IPC meta 测试）
- [ ] `cargo build -p kabegame-core` warning 清零；二进制不含 .rs 业务源码（include_dir 范围限定 `dsl/`）
- [ ] `bun check -c main --skip vue` 通过
- [ ] 启动 log 含 "DSL providers loaded: 9"
- [ ] `runtime.resolve("/gallery/all/x100x/1/")` 走 DSL 链通过
- [ ] `runtime.meta(path)` API 实现 + IPC 层不再硬编码 `meta: None`
- [ ] 9 个 DSL provider 实际被实例化 + 走 ProviderRuntime
- [ ] 30 个 programmatic provider 仍正常工作（S4a 实测调整后的精确数）
- [ ] DSL ↔ programmatic 跨注册命中（`kabegame.root_provider` 是 DSL，引用的 `kabegame.gallery_route` 也是 DSL；DSL 的 `gallery_route` 引用 `gallery_albums_router` 等 programmatic 项）
- [ ] 手测 dev server 浏览主路径不回归

## 风险点

1. **DSL ↔ programmatic 跨调用边界**：DSL `gallery_route` 在 list 中引用 `gallery_albums_router`（programmatic）；当 DSL provider 调 `ctx.registry.instantiate(...)` 时会命中 programmatic factory；factory 返回 GalleryAlbumsRouter（这是 6b 的 programmatic struct）。这条链路必须通——加一组专门测试。
2. **dangling provider 处理**：DSL 文件引用未注册的 provider（如 `vd_en_US_root_router` 仍未补）→ 路径解析时 `ctx.registry.instantiate(...)` 返回 None → resolve 返回 None → PathNotFound。6c 接受此行为；Phase 7 才补全 dangling。
3. **动态反查性能**：DslProvider.resolve 第 3 步朴素跑全数据源；千万级数据下慢。6c 仅做朴素实现；优化推后到性能调优期。
4. **executor 在 list 调用栈中频繁触发**：每次 list 命中 dynamic SQL 都触发一次 SQL 执行（无缓存）。runtime 路径缓存可降低重复访问；但同 path 内多次 list 会重复执行。监控 log，如有问题加 list 结果 LRU。
5. **ChildEntry passthrough 的 provider 字段**：DSL `dynamic delegate` 模式下 `entry.provider = None` 时 child.provider 透传父级 child 的 provider。注意 Arc 克隆开销；空 child.provider（None）也合法。
6. **table_whitelist 维护成本**：S3 的 `build_kabegame_table_whitelist` 硬编码业务表名；新增表时需要同步加入。可作为后期工作从 schema migration 自动派生。
7. **Storage::global() 全局单例假设**：S2 的 SqlExecutor 直接调 `Storage::global()`；测试期需要确保 storage 已初始化。如测试不需要真 DB，传 mock executor。
8. **fail-fast 启动 vs 开发体验**：DSL 加载或 validate 失败 → core 启动 panic。开发期手抖改坏 .json5 → 启动直接挂。可考虑 `KABEGAME_DSL_DEV_MODE` env var 触发降级（落地 Phase 7）。
9. **render_template_to_string vs render_template_sql 的命名规范**：S0b 加的新 helper 与现有 `render_to_owned`（产 `?` 占位 SQL）并列；命名要清晰区分语义；建议统一在 `compose/render.rs` 内。
10. **runtime.meta(path) 性能**：S5bis-a 实现走父 list；父 list 含 dynamic SQL 时每次 meta 调用一次 SQL。runtime 路径 LRU 命中时父 list 结果已缓存（O(1)）；冷或被踢时 O(N)。Phase 7 性能调优期再决定是否引入独立 list 结果缓存。
11. **per-child total = None**：[`browse.rs:37`](../../src-tauri/core/src/gallery/browse.rs#L37) `GalleryBrowseEntry::Dir.total` 6c 期保持 None；如有"目录后空 (?)"UI 回归归到 Phase 7 处理（每个 child 实例化下层 provider 后跑 count 是昂贵操作）。
12. **非 SQL executor 抽象（Phase 7 预警）**：`vd_ops.rs` 的文件系统读 / 插件 manifest 等非 SQL 数据源不能用 SqlExecutor。Phase 7 把 VD `按画册 / 按插件` 等迁 DSL 时，pathql-rs 需要补另一个 executor 抽象（如 `ResourceExecutor` 或主机回调）。本期不做，但 SqlExecutor 类型签名/命名要为未来扩展留余地（不要叫 "Executor" 太泛化）。

## 完成 6c 后的下一步

进入 **Phase 7**：
- 补全 dangling provider .json5 文件（gallery_albums_router / gallery_dates_router / vd_*_provider / vd_en_US_root_router 等约 17 个）
- 注册 `get_plugin` 主机 SQL 函数（`Connection::create_scalar_function`）支持插件维度
- 删除被 DSL 替代的 programmatic provider 实现（gallery/album.rs / vd/albums.rs 等）
- Tauri commands 切换到 DSL root（如果尚未）
- 集成测试 `tests/dsl_e2e.rs`：真 sqlite + fixture，全路径端到端 + parity 验证
- 性能 sanity（LRU 命中率、SQL plan cache、dynamic list 反查代价）
- 前端 ProviderMeta wire format 全面协调（如果 DSL 路径产出 typed meta）
