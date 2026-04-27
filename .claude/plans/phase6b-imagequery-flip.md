# Phase 6b 详细计划 — core 接入 pathql-rs（编程注册 + ImageQuery 全切换）

## 重大架构调整说明

本期承接 Phase 6a 完成态：

- pathql-rs 已含 Provider trait + ChildEntry + ProviderRegistry + ProviderRuntime（编程注册 / 默认 feature 可用）
- `compose` feature 已删除
- 9 个 .json5 仍在 `src-tauri/core/src/providers/`，但 6b 不接 DSL（仅做编程注册路径）

Phase 6b 的核心变化：

**core 端旧 Provider 体系全部删除**——`core::providers::provider::Provider` trait、`ChildEntry`、`ProviderMeta`、`ProviderRuntime`、`ImageQuery`、`SqlFragment` 都将被 pathql-rs 中的对应类型替代或废弃。

**33 处硬编码 provider 改 impl `pathql_rs::Provider`**——通过 `register_provider(ns, name, factory)` 把每个硬编码 provider 注册到 pathql-rs Registry；由 pathql-rs ProviderRuntime 接管所有路径解析。

**6b 不接 DSL**——`include_dir!()` + `Json5Loader::load` + `validate` 留给 6c；6b 只用编程注册验证 runtime 是否真的能在 kabegame 业务路径（gallery / vd 全套）下工作。

---

## Context

承接 Phase 6a：pathql-rs 完整就绪，所有现有 351 + ~40 测试全过；core **完全未改动**。

Phase 6b 目标：

1. core 引用 pathql-rs（启用 `sqlite` feature；json5/validate 不开因为不接 DSL）
2. core 把 33 处硬编码 provider 全部改造为 impl `pathql_rs::Provider` + 注册到 pathql-rs Registry
3. 替换 core 自己的 ProviderRuntime 为 pathql-rs 版本
4. 删除 ImageQuery / SqlFragment / core 旧 Provider trait / core 旧 ChildEntry / core 旧 ProviderMeta

完成后：core 内部数据流全跑在 ProviderQuery 上；路径解析全由 pathql-rs ProviderRuntime 主导；硬编码 provider 通过编程注册参与；行为零回归；DSL 仍未启用（推迟到 6c）。

约束：
- **本期 core 中间状态会编译失败**——专用本地分支一气完成
- 行为零回归：`/gallery/all/x100x/1/` 等路径迁移前后查询结果集一致
- core 启用的 pathql-rs feature 集：`["sqlite"]`（json5/validate 留 6c 启用）
- 不接 DSL；不接 query feature；不接 include_dir
- DslProvider 在 pathql-rs 内已存在但本期不实例化（DSL 加载留 6c）

---

## Phase 6a 设计前提（已在 6a 完成 / 设计同步）

6a 采用 **ctx-passing 设计**——Provider trait 方法都接受 `&ProviderContext`；ctx 由 ProviderRuntime 在每次入口构造，包含 `Arc<ProviderRegistry>` + `Arc<ProviderRuntime>`（runtime 内部持 `Weak<Self>` 用于 upgrade）。**Provider 实现都不持 runtime / registry 字段**——状态最小化、无循环引用。

由此 6b 的工程难度大幅简化：路由壳 provider 不需要持 Arc<Registry> + Weak<Runtime>，直接是无字段（或仅持自己的 config）的纯 trait 实现。

具体设计（已在 [phase6a-foundation.md](./phase6a-foundation.md) 锁定）：

```rust
pub struct ProviderContext {
    pub registry: Arc<ProviderRegistry>,
    pub runtime: Arc<ProviderRuntime>,
}

pub trait Provider: Send + Sync {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery { current }
    fn list(&self, composed: &ProviderQuery, ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError>;
    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>>;
    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> { None }
    fn is_empty(&self) -> bool { false }
}

pub type ProviderFactory = Arc<
    dyn Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
        + Send + Sync + 'static
>;  // factory 不带 ctx 参数: provider 实例不持 ctx 字段, 构造时无需

impl ProviderRegistry {
    pub fn instantiate(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
        properties: &HashMap<String, TemplateValue>,
        _ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>>;
}
```

6b 完全基于此设计；不需要回 6a 改 trait 签名。

---

## 锁定的设计选择

1. **`apply_query / list / resolve / get_note` 全用 pathql-rs 版**：core 保留 `pub use pathql_rs::Provider;` 等 reexport 让现有调用代码尽量少改
2. **`ChildEntry.meta` 改 untyped JSON**：core 旧 `ProviderMeta` enum 全删；从 pathql-rs `ChildEntry { meta: Option<serde_json::Value> }` 直接消费；前端 wire format 在 IPC 层做映射（typed ProviderMeta 序列化逻辑保留为 helper：`fn provider_meta_typed_from_json(v: &Value) -> Option<ProviderMeta>` 用于前端兼容）
3. **`fetch_provider_meta` 退役**：现有 `fetch_provider_meta(id, kind)` 函数从专用 SQL 查询返回 typed ProviderMeta；改造后由 DSL 的 meta 字段产 JSON（DSL 还没接，6b 期硬编码 provider 用 ChildEntry 时直接构造合适 JSON）；废弃 typed 路径
4. **Storage 接口签名重构**：
   - `get_images_count_by_query(&ProviderQuery) -> Result<usize, _>` 内部 build_sql + COUNT(*) wrapper
   - `get_images_info_range_by_query(&ProviderQuery) -> Result<Vec<ImageInfo>, _>` 直接执行 build_sql 结果；外部 offset/limit 参数**删除**
   - 用 `pathql_rs::drivers::sqlite::params_for(&values)` 转 bind params
5. **`shared/sort.rs` `to_desc()` 等价**：`current.order.global = Some(OrderDirection::Revert)`；语义在 build_sql 渲染期统一应用
6. **删除清单**（确认 0 引用后）：
   - `crate::storage::gallery::ImageQuery`
   - `crate::storage::gallery::SqlFragment`
   - 所有 `ImageQuery::with_*` builder
   - `crate::providers::provider::Provider` trait（保留 reexport）
   - `crate::providers::provider::ChildEntry` (struct)（保留 reexport）
   - `crate::providers::provider::ProviderMeta` enum（**完全删除**，typed wire format 由前端兼容层补）
   - `crate::providers::provider::fetch_provider_meta` 函数
   - `crate::providers::runtime::ProviderRuntime`（替换为 `pathql_rs::ProviderRuntime`）
7. **保留**：典型 SQL 子查询函数（如 `wallpaper_set_filter`）外部化为独立 helper 模块
8. **6b 测试策略**：行为零回归——所有 core 原有测试经迁移后保持全绿 + `bun check` 通过 + 手测 dev server 浏览 Gallery
9. **commit 规划建议**：
   - commit 1: core/Cargo.toml + pathql-rs reexports
   - commit 2: ProviderMeta 处理 + Storage 接口（中间编译失败）
   - commit 3..N: 33 个硬编码 provider 逐个迁移（每文件一 commit；每 commit 仍可能编译失败，最后 N 才通）
   - commit M: register_all_hardcoded_providers + ProviderRuntime swap
   - commit M+1: 删除 ImageQuery / SqlFragment / 旧 Provider trait + cleanup
   - commit M+2: 测试套件修整 + 全套测试全绿

---

## 测试节奏

⚠️ **本期不能在子任务之间跑 `cargo test`**——中间状态编译失败。建议：
- 在专用本地分支
- 每完成一组逻辑单元后 `cargo check` 看进度
- 全部 33 处迁移 + runtime swap 完成后跑 `cargo test -p kabegame-core` 一次性确认零回归

---

## 子任务拆解

### S1. core/Cargo.toml + workspace deps

修改根 [`Cargo.toml`](../../Cargo.toml) `[workspace.dependencies]`：

```toml
pathql-rs = { path = "./src-tauri/pathql-rs", default-features = false }
```

修改 [`src-tauri/core/Cargo.toml`](../../src-tauri/core/Cargo.toml) `[dependencies]`：

```toml
pathql-rs = { workspace = true, features = ["sqlite"] }
```

⚠️ 6b 不开 `json5` / `validate`（不接 DSL），不开 `query`（自管 rusqlite 执行）。6c 启用 json5+validate；query 等更后期。

**测试要点**：纯依赖变更，编译验证。

**Test**：
- `cargo check -p kabegame-core` 通过
- `cargo test -p kabegame-core` 全绿（无回归；pathql-rs 引入但暂未使用）

---

### S2. core 旧 ProviderMeta 处理 + 类型 reexport（[`provider.rs`](../../src-tauri/core/src/providers/provider.rs)）

这是改造的入口点；`provider.rs` 大重写：

```rust
//! Provider trait 与核心数据类型 — 全部 reexport 自 pathql-rs (6b 起)。
//!
//! 旧 typed ProviderMeta enum 已废弃 — meta 现在是 untyped JSON。
//! 前端 wire format 兼容由 IPC 层 helper 补 (见 mod.rs 末尾)。

pub use pathql_rs::{ChildEntry, EngineError, Provider};
pub use pathql_rs::compose::ProviderQuery;
pub use pathql_rs::template::eval::TemplateValue;
pub use pathql_rs::ast::{Namespace, ProviderName, SimpleName};

use serde::Serialize;
use serde_json::Value as JsonValue;

use crate::plugin::{Plugin, PluginManager};
use crate::storage::run_configs::RunConfig;
use crate::storage::tasks::TaskInfo;
use crate::storage::{Album, Storage, SurfRecord};

// === 前端 wire format 兼容: typed ProviderMeta 序列化 helper ===
//
// 旧 ProviderMeta enum 序列化为 {"kind": "album", "data": {...}} 之类。
// 6b 起 ChildEntry.meta 是 serde_json::Value (untyped); 调用方按需调
// `wrap_typed_meta(album)` 等把 typed 实体包成兼容 JSON。

#[derive(Debug, Clone, Copy)]
pub enum MetaEntityKind {
    Album,
    SurfRecord,
    Task,
    Plugin,
    RunConfig,
}

/// 把 typed 实体包成与旧 ProviderMeta 序列化一致的 JSON。
pub fn wrap_typed_meta_json(id: &str, kind: MetaEntityKind) -> Option<JsonValue> {
    let (kind_str, data) = match kind {
        MetaEntityKind::Album => {
            let album = Storage::global().get_album_by_id(id).ok()??;
            ("album", serde_json::to_value(album).ok()?)
        }
        MetaEntityKind::SurfRecord => {
            let r = Storage::global().get_surf_record(id).ok()??;
            ("surfRecord", serde_json::to_value(r).ok()?)
        }
        MetaEntityKind::Task => {
            let t = Storage::global().get_task(id).ok()??;
            ("task", serde_json::to_value(t).ok()?)
        }
        MetaEntityKind::Plugin => {
            let p = PluginManager::global().get_plugin(id)?;
            ("plugin", serde_json::to_value(p).ok()?)
        }
        MetaEntityKind::RunConfig => {
            let rc = Storage::global().get_run_config(id).ok()??;
            ("runConfig", serde_json::to_value(rc).ok()?)
        }
    };
    Some(serde_json::json!({"kind": kind_str, "data": data}))
}

/// 别名（保留向后兼容）
pub type ImageEntry = crate::storage::ImageInfo;
```

⚠️ 注意：原 `ProviderMeta::Album(Album)` enum variant 序列化为 `{"kind": "album", "data": {...}}`。新 helper `wrap_typed_meta_json` 直接产相同形态 JSON。前端不变。

**测试要点**：
- `wrap_typed_meta_json_album_format` / `_plugin_format` 等：构造测试 fixture，确保 wire format 与旧 ProviderMeta::Album 一致
- 跑 core 现有 provider 测试，目前还未改动，应有大量编译错误（trait 类型不匹配）—— 暂时忍受

**Test**：跳过——本期开始进入"中间编译失败"状态。

---

### S3. Storage 接口改 ProviderQuery（[`storage/gallery.rs`](../../src-tauri/core/src/storage/gallery.rs)）

```rust
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateContext;
use pathql_rs::drivers::sqlite::params_for;

impl Storage {
    pub fn get_images_count_by_query(&self, query: &ProviderQuery) -> Result<usize, String> {
        let ctx = TemplateContext::default();
        let (sql, values) = query
            .build_sql(&ctx)
            .map_err(|e| format!("build_sql: {}", e))?;
        let count_sql = format!("SELECT COUNT(*) FROM ({}) AS sub", sql);
        let params = params_for(&values);
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row(&count_sql, rusqlite::params_from_iter(params.iter()), |r| r.get(0))
            .map_err(|e| format!("count query: {}", e))?;
        Ok(n as usize)
    }

    pub fn get_images_info_range_by_query(&self, query: &ProviderQuery) -> Result<Vec<ImageInfo>, String> {
        let ctx = TemplateContext::default();
        let (sql, values) = query
            .build_sql(&ctx)
            .map_err(|e| format!("build_sql: {}", e))?;
        let params = params_for(&values);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| ImageInfo::from_row(r))
            .map_err(|e| format!("query: {}", e))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("rows: {}", e))
    }
}
```

外部 offset / limit 参数**删除**：所有调用方先在 ProviderQuery 上设置 limit/offset 再传入。

```rust
// 旧:
storage.get_images_info_range_by_query(&iq, offset, limit)?;

// 新:
let mut q = q;
q.offset_terms.push(NumberOrTemplate::Number(offset as f64));
q.limit = Some(NumberOrTemplate::Number(limit as f64));
storage.get_images_info_range_by_query(&q)?;
```

⚠️ 调用点要 grep：`grep -rn "get_images_(count|info_range)_by_query" src-tauri/`。

**测试要点**：本步骤后 storage 测试大概率会有编译错误（旧 ImageQuery 还存在，调用点未改）—— 等 S5/S7 收尾才通。

---

### S4. 33 处硬编码 provider 迁移（**主体工作量**）

每个 provider 改造模板：

**before**（典型 [`gallery/album.rs`](../../src-tauri/core/src/providers/gallery/album.rs)）：

```rust
use crate::providers::provider::{ChildEntry, Provider};
use crate::storage::gallery::ImageQuery;

pub struct AlbumProvider {
    pub album_id: String,
}

impl Provider for AlbumProvider {
    fn apply_query(&self, current: ImageQuery) -> ImageQuery {
        current
            .with_join("INNER JOIN album_images ai ON ai.image_id = images.id", vec![])
            .with_where("ai.album_id = ?", vec![self.album_id.clone()])
    }
    fn list_children(&self, _composed: &ImageQuery) -> Result<Vec<ChildEntry>, String> {
        Ok(Vec::new())
    }
    fn get_child(&self, _name: &str, _composed: &ImageQuery) -> Option<Arc<dyn Provider>> {
        None
    }
}
```

**after**：

```rust
use std::sync::Arc;
use pathql_rs::ast::{JoinKind, OrderDirection};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{ChildEntry, EngineError, Provider, ProviderContext};

pub struct AlbumProvider {
    pub album_id: String,
}

impl Provider for AlbumProvider {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        current
            .with_join_raw(
                JoinKind::Inner,
                "album_images",
                "ai",
                Some("ai.image_id = images.id"),
                &[],
            )
            .expect("alias collision")
            .with_where_raw("ai.album_id = ?", &[TemplateValue::Text(self.album_id.clone())])
    }
    fn list(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())
    }
    fn resolve(&self, _name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        None
    }
}
```

**叶子 provider 的常见模式**：仅持自己的 config（如 `album_id`），trait 方法接受 ctx 但不用——`_ctx` 占位。

**完整文件清单**（按 `grep -rn "fn apply_query"` 命中顺序）：

| # | 文件 | apply_query 数 | 迁移要点 |
|---|---|---:|---|
| 1 | `gallery/album.rs` | 5 | join + where（5 个 sub-provider） |
| 2 | `gallery/all.rs` | 2 | order；root 路由壳 apply_query 直返 |
| 3 | `gallery/date.rs` | 3 | order |
| 4 | `gallery/date_range.rs` | 1 | where + bind |
| 5 | `gallery/hide.rs` | 1 | where + JOIN（NOT EXISTS / IS NULL） |
| 6 | `gallery/search.rs` | 1 | where LIKE |
| 7 | `shared/album.rs` | 2 | join + where |
| 8 | `shared/date/day.rs` | 1 | where（日期范围） |
| 9 | `shared/date/month.rs` | 1 | 同上 |
| 10 | `shared/date/year.rs` | 1 | 同上 |
| 11 | `shared/date/years.rs` | 1 | order |
| 12 | `shared/hide.rs` | 1 | where + JOIN |
| 13 | `shared/media_type.rs` | 1 | where IN |
| 14 | `shared/plugin.rs` | 1 | where = |
| 15 | `shared/search.rs` | 1 | where LIKE |
| 16 | `shared/sort.rs` | 1 | **特殊**：`current.order.global = Some(OrderDirection::Revert);` 等价 to_desc |
| 17 | `shared/surf.rs` | 1 | join |
| 18 | `shared/task.rs` | 1 | join |
| 19 | `vd/albums.rs` | 2 | |
| 20 | `vd/by_time.rs` | 3 | |
| 21 | `vd/root.rs` | 1 | router |
| 22 | `vd/sub_album_gate.rs` | 1 | |

**总计**：33 处 apply_query。

**特殊：路由壳 provider**（无字段，stateless）的 list/resolve 通过 ctx 调 registry：

```rust
// 例如 GalleryRoot 需要 resolve("albums") → AlbumsRouter
// 无字段; ctx-passing 设计下完全 stateless
pub struct GalleryRoot;

impl Provider for GalleryRoot {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        // 设置默认 from = "images" + limit = 0 (root 不直接列图)
        let mut q = current;
        q.from = Some(SqlExpr("images".into()));
        q.limit = Some(NumberOrTemplate::Number(0.0));
        q
    }

    fn list(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        // 返回静态 children 列表; provider 字段空 (resolve 时再实例化)
        Ok(vec![
            ChildEntry { name: "all".into(), provider: None, meta: None },
            ChildEntry { name: "albums".into(), provider: None, meta: None },
            ChildEntry { name: "plugins".into(), provider: None, meta: None },
            // ...
        ])
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        let target_name = match name {
            "all" => "gallery_all_router",
            "albums" => "gallery_albums_router",
            "plugins" => "gallery_plugins_router",
            // ... 其他静态 mapping
            _ => return None,
        };
        ctx.registry.instantiate(
            &Namespace("kabegame".into()),
            &ProviderName(target_name.into()),
            &HashMap::new(),
            ctx,
        )
    }
}
```

类似处理路由壳（`gallery_all_router` / `gallery_paginate_router` / `gallery_page_router` / `vd_root` 等）：
- **无字段** struct（`GalleryRoot;` / `GalleryAllRouter;` 等）
- list 返回 ChildEntry 占位（provider=None；下层 resolve 时实例化）
- resolve 通过 `ctx.registry.instantiate(...)` 找下层 provider

**特殊：动态属性 provider**（如 GalleryAllRouter resolve x100x → page_size=100）：

```rust
fn resolve(&self, name: &str, _composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
    if let Some(captures) = regex::Regex::new(r"^x([1-9][0-9]*)x$").ok()?.captures(name) {
        let page_size: i64 = captures.get(1)?.as_str().parse().ok()?;
        let mut props = HashMap::new();
        props.insert("page_size".into(), TemplateValue::Int(page_size));
        return ctx.registry.instantiate(
            &Namespace("kabegame".into()),
            &ProviderName("gallery_paginate_router".into()),
            &props,
            ctx,
        );
    }
    // 静态 list: "desc"
    match name {
        "desc" => ctx.registry.instantiate(
            &Namespace("kabegame".into()),
            &ProviderName("gallery_all_desc_router".into()),
            &HashMap::new(),
            ctx,
        ),
        _ => None,
    }
}
```

⚠️ 这块工作量大；每个路由壳的 resolve / list 都要按现有硬编码逻辑重写。建议每个文件迁移成一个 commit。**好消息**：路由壳现在是 stateless（无字段），factory 只是 `|_props| Ok(Arc::new(GalleryRoot) as _)` 一行。

---

### S5. 33 个 provider 的注册函数 + 主聚合器

新建 `core/src/providers/programmatic.rs`：

```rust
//! 把 33 处硬编码 provider 注册到 pathql-rs Registry。
//! 每个 provider 一个 register_xxx 函数; register_all 聚合调用。

use std::sync::Arc;
use pathql_rs::ast::{Namespace, SimpleName};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::{EngineError, Provider, ProviderRegistry};

use crate::providers::gallery;
use crate::providers::shared;
use crate::providers::vd;

pub fn register_all_hardcoded(registry: &mut ProviderRegistry) -> Result<(), pathql_rs::RegistryError> {
    // === gallery ===
    register_gallery_route(registry)?;
    register_gallery_all_router(registry)?;
    register_gallery_paginate_router(registry)?;
    register_gallery_page_router(registry)?;
    register_gallery_album_provider(registry)?;
    // ... 其他
    
    // === shared ===
    register_query_page_provider(registry)?;
    register_page_size_provider(registry)?;
    register_sort_provider(registry)?;
    // ... 其他
    
    // === vd ===
    register_vd_root_router(registry)?;
    // ... 其他
    
    Ok(())
}

/// 叶子 provider: factory 提取 properties 构造实例。
fn register_gallery_album_provider(registry: &mut ProviderRegistry) -> Result<(), pathql_rs::RegistryError> {
    registry.register_provider(
        Namespace("kabegame".into()),
        SimpleName("gallery_album_provider".into()),
        |props| {
            let album_id = match props.get("album_id") {
                Some(TemplateValue::Text(s)) => s.clone(),
                _ => return Err(EngineError::FactoryFailed(
                    "kabegame".into(),
                    "gallery_album_provider".into(),
                    "missing album_id property".into(),
                )),
            };
            Ok(Arc::new(gallery::album::AlbumProvider { album_id }) as Arc<dyn Provider>)
        },
    )
}

/// 路由壳 provider: stateless, factory 一行构造。
fn register_gallery_all_router(registry: &mut ProviderRegistry) -> Result<(), pathql_rs::RegistryError> {
    registry.register_provider(
        Namespace("kabegame".into()),
        SimpleName("gallery_all_router".into()),
        |_props| Ok(Arc::new(gallery::all::GalleryAllRouter) as Arc<dyn Provider>),
    )
}

// ... 其他 32 个 register_xxx 函数
```

总计 33 个注册函数 + 1 个 aggregator。每个 ~5-15 行（路由壳极简，叶子 provider 略长）。

---

### S6. core ProviderRuntime swap（删旧 [`runtime.rs`](../../src-tauri/core/src/providers/runtime.rs)，用 pathql-rs 版本）

新建 `core/src/providers/init.rs`：

```rust
//! ProviderRuntime 启动期初始化。
//! 6b: 仅注册 33 个硬编码 provider; 不接 DSL。

use std::sync::Arc;
use std::sync::OnceLock;
use std::collections::HashMap;
use pathql_rs::{ProviderRegistry, ProviderRuntime};
use pathql_rs::ast::{Namespace, ProviderName};

use super::programmatic::register_all_hardcoded;

static RUNTIME: OnceLock<Arc<ProviderRuntime>> = OnceLock::new();

pub fn provider_runtime() -> &'static Arc<ProviderRuntime> {
    RUNTIME.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        register_all_hardcoded(&mut registry).expect("register hardcoded providers");
        let registry = Arc::new(registry);

        // ctx-passing 设计下 root provider 是 stateless (无 registry/runtime 字段);
        // 直接通过 factory 实例化即可, 不需要 ctx (factory 签名只收 props)。
        let root_factory = match registry.lookup(
            &Namespace("kabegame".into()),
            &ProviderName("root_provider".into()),
        ).expect("root_provider not registered") {
            pathql_rs::registry::RegistryEntry::Programmatic(f) => f.clone(),
            _ => panic!("root_provider must be programmatic in 6b (no DSL)"),
        };
        let root = root_factory(&HashMap::new()).expect("root_provider factory failed");

        ProviderRuntime::new(registry, root)
    })
}
```

✅ ctx-passing 设计下 **不需要 `new_with_root_factory`**：
- root provider 是 stateless（不持 registry/runtime 字段）
- factory 签名 `Fn(&props)`，不需要 ctx
- 直接调 factory 拿 root，再传给 `ProviderRuntime::new(registry, root)`
- runtime 内部用 `Arc::new_cyclic` 持 `Weak<Self>`，方法调用时构造 ctx

---

删除：
- 全部 `core/src/providers/runtime.rs` （或保留文件但改成只导出 init.rs 内容 + reexport pathql-rs::ProviderRuntime）
- core/src/providers/mod.rs 同步：`pub use init::provider_runtime;` + `pub use pathql_rs::ProviderRuntime;`

调用点改造：所有 `crate::providers::ProviderRuntime::global()` / `Self::resolve(path)` 等改为 `provider_runtime().resolve(path)` / 等价。grep `ProviderRuntime::` 找全。

---

### S7. 删除 ImageQuery / SqlFragment + 全工程 cleanup

确认全工程 0 引用后：
- `storage/gallery.rs` 中的 `ImageQuery` struct 与 `SqlFragment` struct 删除
- 所有 `ImageQuery` 关联的 builder 方法（`with_join`, `with_where`, `with_order`, `prepend_order_by`, `merge`, `build_sql`, `to_desc`, `album_id`, `wallpaper_set_filter`, `year_filter`, ...）删除
- `SqlFragment` 关联 helper 删除
- 仍有用的语义函数（如 `wallpaper_set_filter() -> SqlExpr`）迁移到独立模块（如 `crate::storage::query_helpers`）

验证：

```bash
grep -rn "ImageQuery\|SqlFragment" src-tauri/core/ src-tauri/app-main/ src-tauri/app-cli/ \
  | grep -v "/target/" | grep -v "kabegame-i18n"
# 期望: 0 行
```

---

### S8. 测试套件修整 + 全套验证

`core/src/providers/tests.rs` 和各模块 `#[cfg(test)]` 中所有 `ImageQuery::new().with_*` → 改造为 ProviderQuery snapshot：

```rust
// before
let q = ImageQuery::new();
let q = provider.apply_query(q);
assert!(q.wheres.iter().any(|f| f.sql.contains("plugin_id")));

// after
let q = ProviderQuery::new();
let q = provider.apply_query(q);
let (sql, _params) = q.build_sql(&TemplateContext::default()).unwrap();
assert!(sql.contains("plugin_id"));
```

测试目标：所有 core 现有测试在迁移后保持全绿。如有行为差异（典型如 sort 翻转语义），把差异显式断言并对齐 ProviderQuery 行为为准。

**最终验证命令**：

```bash
cargo build -p kabegame-core
cargo test -p kabegame-core
cargo test -p pathql-rs --features "json5 validate sqlite"   # pathql-rs 不能回归
bun check -c main --skip vue
```

手测：
- `bun dev -c main --data prod` 起 dev server
- 浏览 `/gallery/all/` 路径 — 应能正常列图
- 浏览 `/vd/i18n-zh_CN/按画册/<album_id>/` — 应能正常列图
- 浏览 `/gallery/albums/` — 行为不变（仍由硬编码 AlbumsRouter 处理；Phase 7 才补 DSL 版）

---

## 完成标准

- [ ] `cargo build -p kabegame-core` 干净（warning 清零）
- [ ] `cargo test -p kabegame-core` 全绿（行为零回归）
- [ ] `cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿（无回归）
- [ ] `bun check -c main --skip vue` 通过
- [ ] 全工程 `ImageQuery` / `SqlFragment` 引用 0
- [ ] 33 处硬编码 apply_query 全部接 ProviderQuery
- [ ] 33 个 register_xxx 函数全部就绪 + register_all_hardcoded 调用全过
- [ ] `Storage::get_images_*_by_query` 接 ProviderQuery
- [ ] core ProviderRuntime 替换为 pathql-rs 版本；`provider_runtime().resolve(path)` 工作正常
- [ ] DSL 仍未启用（`Json5Loader::load` 0 调用；include_dir 不接）
- [ ] 手测 `bun dev -c main --data prod` 浏览 Gallery / VD 主路径不回归

## 风险点

1. **路由壳 Provider 改造工作量较大但代码简洁**：每个路由壳（GalleryRoot、GalleryAllRouter、GalleryPaginateRouter、VdRoot 等）改 list / resolve 调 `ctx.registry.instantiate()`；ctx-passing 设计下 router struct 都是 `pub struct Foo;` 无字段，factory 一行；改造主要是 list/resolve 内部逻辑翻译。占 6b 30-40% 工作量。
2. **shared/sort.rs 等价语义**：`to_desc()` 即时翻转 vs `OrderState::global = Revert` 延迟应用——位置不同时结果应该一致；**必须**加端到端测试覆盖 sort provider 在不同位置的链。
3. **ProviderMeta 删除对前端的冲击**：现 IPC 命令返回 ChildEntry.meta 为 typed `ProviderMeta::Album(...)` JSON；6b 起改 untyped JSON。前端如果按 `meta.kind` switch，对 Album / Task / Plugin 等 kind 仍能识别（wrap_typed_meta_json helper 保 wire format 一致）。**必须**搜前端代码确认所有使用点不受影响。
4. **fetch_provider_meta 调用点**：grep `fetch_provider_meta` 找全；改为 `wrap_typed_meta_json` 直接调。
5. **build_sql 失败的兜底**：原 ImageQuery 的 build_sql 不会失败（纯字符串拼）；ProviderQuery 的 build_sql 可能 fail；Storage 接口已返回 Result，调用方处理 Result（log + 默认空集）。
6. **register_provider Duplicate 错误**：33 个 register_xxx 都注册到 `kabegame` namespace；如有重名（不应该有，每个 simple_name 不同）报错。建议每个 register_xxx 在测试里调一次确认通过。
7. **Provider trait 方法重命名（list_children → list, get_child → resolve）**：core 内所有调用点 grep + 改名。
8. **Phase 6a 设计是 6b 的前提**：6a 的 ctx-passing 设计（Provider trait 方法收 ctx；factory 不收 ctx；router 无 registry/runtime 字段；ProviderRuntime 内部 weak_self；`Registry::instantiate(_, _, _, _ctx)` helper）必须在 6b 启动前在 pathql-rs 内完成 + 测试通过；否则 6b 的设计假设不成立。
9. **DSL provider 验证未覆盖**：6b 不接 DSL，所以现有 9 个 .json5 provider 都没真正走通过 ProviderRuntime —— 6c 才覆盖。这意味着 6b 完成后，硬编码版本走通，DSL 路径仍未验证。

## 完成 6b 后的下一步

进入 **Phase 6c**：DSL 加载启用 + 动态 list 实现 + dangling provider 处理 + frontend 配合。
- core/Cargo.toml 加 `json5` / `validate` feature
- include_dir 嵌入 + Json5Loader.load + validate
- DSL providers 与编程 providers 在同 registry 共存（命名不冲突的话；冲突则编程 provider 优先 / DSL 替换）
- 动态 list SQL 项执行：通过外部 executor 注入回调（不开 query feature 时）
- Phase 7 再补 dangling provider .json5 + 删除被 DSL 替代的硬编码 provider
