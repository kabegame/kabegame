# Phase 7a 详细计划 — 基础设施 + i18n_en_US 补全 + pilot 迁移

## Context

承接 **Phase 6e 完成态**（另一 AI 已完成；delegate 改 ProviderCall + path-unaware；ByDelegate variant 删除）。

### Phase 7a 目标

1. **补 dangling**：`vd_en_US_root_router.json5`（vd_zh_CN 的英文翻译镜像）—— 解 6c 起一直的 `/vd/i18n-en_US/...` PathNotFound
2. **主机 SQL 函数注册框架**：core 端 `Storage::open` 期通过 `Connection::create_scalar_function` 注册标量函数
3. **`get_plugin(plugin_id [, locale]) -> JSON_TEXT`**：返回 `{id, name, description, baseUrl}` 基础元数据 JSON 对象；name / description i18n 解析
4. **2 个 pilot 迁移**：`sort_provider`（contrib query 路径验证）+ `gallery_search_router`（router 壳路径验证）
5. **parity 测试 helper**：可复用框架，给 7b/c/d 大量复用

### 约束

- 改造**不大但分散**：core 端 Storage / programmatic 模块都要动，但每条边界都小（pilot 两个 provider 各自 ~10 行 .json5）
- 行为零回归：sort + search 路径在 DSL 下与 programmatic 输出等价
- 共存策略：迁移完的 provider 同时存在 DSL + programmatic 注册时，registry 应 DSL 优先（实测：6c 的 `register_all_hardcoded` 跳过 DSL-covered 名字策略本期复用）

---

## 锁定的设计选择

### 决策 1：主机 SQL 函数注册位置 = `Storage::open`

不在 `KabegameSqlExecutor::new` 注册（构造期副作用 + 与 storage 共享 connection 但责任错位）；而是在 [`Storage::open`](../../src-tauri/core/src/storage/mod.rs) 内打开 connection 后立刻调 `dsl_funcs::register_dsl_functions(&mut conn)?`。

**Why**：
- 标量函数是 connection-scoped；连接复用方该负责注册
- Storage 持有 connection；它最了解何时注册 / 是否需要重新注册
- KabegameSqlExecutor 构造时连接早已就绪——分离构造与初始化更清晰

### 决策 2：新文件 `core/src/storage/dsl_funcs.rs`

模块职责：把"业务侧元数据"桥接为 sqlite 标量函数。本期只放 `get_plugin`；未来可扩展 `get_task` / `get_album_meta` 等。

```rust
//! sqlite 标量函数: 把业务侧元数据 (PluginManager / TaskRegistry / 等) 暴露给 DSL SQL 上下文。
//! 注册由 Storage::open 在打开 connection 后调用。

pub fn register_dsl_functions(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    register_get_plugin(conn)?;
    // 未来: register_get_task, register_get_album_meta, ...
    Ok(())
}

fn register_get_plugin(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function(
        "get_plugin",
        -1,    // 可变 1-2 个参数
        FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| -> rusqlite::Result<String> {
            let argc = ctx.len();
            let plugin_id: String = ctx.get(0)?;
            let locale: Option<String> = if argc >= 2 {
                Some(ctx.get(1)?)
            } else {
                None
            };
            Ok(get_plugin_json(&plugin_id, locale.as_deref()))
        },
    )
}

/// 返回 plugin 基础元数据 JSON 对象字符串; plugin 不存在时返回 "null" (SQL JSON null)。
fn get_plugin_json(plugin_id: &str, locale: Option<&str>) -> String {
    let plugin = match PluginManager::global_opt().and_then(|pm| pm.get_plugin(plugin_id)) {
        Some(p) => p,
        None => return "null".into(),
    };
    let locale_str = locale
        .map(String::from)
        .unwrap_or_else(|| rust_i18n::locale().to_string());
    let name = resolve_i18n_text(&plugin.name, &locale_str);
    let description = resolve_i18n_text(&plugin.description, &locale_str);
    let obj = serde_json::json!({
        "id": plugin.id,
        "name": name,
        "description": description,
        "baseUrl": plugin.base_url,
    });
    obj.to_string()
}

/// 解析多语言对象 (`{default, zh, en, ja, ...}`) 为单字符串; locale 缺失时回退 default → "" 序。
fn resolve_i18n_text(value: &serde_json::Value, locale: &str) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    if let Some(obj) = value.as_object() {
        // 优先匹配 locale; 其次 prefix 匹配; 再 default; 再 en; 最后空串
        if let Some(s) = obj.get(locale).and_then(|v| v.as_str()) {
            return s.into();
        }
        if let Some(prefix) = locale.split('_').next() {
            if let Some(s) = obj.get(prefix).and_then(|v| v.as_str()) {
                return s.into();
            }
        }
        if let Some(s) = obj.get("default").and_then(|v| v.as_str()) {
            return s.into();
        }
        if let Some(s) = obj.get("en").and_then(|v| v.as_str()) {
            return s.into();
        }
    }
    String::new()
}
```

### 决策 3：`get_plugin` 返回形态 = JSON 字符串（非 SQL 多列）

返回单 JSON 字符串而非 SQLite 元组 / 多列。DSL 用 `json_extract` 拆字段：

```sql
SELECT 
    plugin_id,
    json_extract(get_plugin(plugin_id, '${properties.locale}'), '$.name') AS plugin_name,
    json_extract(get_plugin(plugin_id, '${properties.locale}'), '$.description') AS plugin_desc
FROM plugins
```

**Why**：
- SQL 标量函数不能返回多列；返回 JSON 字符串是工业惯例
- DSL 可按需 `json_extract` 拆需要的字段；不取的字段成本几乎为 0（sqlite 缓存）
- 可扩展：未来加 `iconBase64` / `version` 字段不破坏 DSL 调用方

### 决策 4：`get_plugin` 重复调用的开销

DSL 写 `get_plugin(id, locale)` 在每行都调一次 → SQLite 内部缓存确定性函数调用结果（FunctionFlags::SQLITE_DETERMINISTIC），同 (id, locale) 二元组在同一 query 内只算一次；再次跨 query 调可能重算。

短期接受；7d 大迁移后如有性能问题再加 rust 端 LRU。本期 7a 不优化。

### 决策 5：`vd_en_US_root_router.json5` 路径段命名

参照 [`vd_zh_CN_root_router.json5`](../../src-tauri/core/src/providers/dsl/vd/vd_zh_CN_root_router.json5)：

| zh_CN | en_US |
|---|---|
| 按画册 | albums |
| 按插件 | plugins |
| 按任务 | tasks |
| 按浏览 | surfs |
| 按媒体 | media |
| 按时间 | dates |
| 全部 | all |

注：英文路径段用纯 ASCII（避免 URL encoding 麻烦），与 gallery 侧 `gallery_route.json5` 风格一致。

### 决策 6：i18n locale 在 DSL 里的传递

不依赖全局 `rust_i18n::locale()`；vd_zh_CN_root / vd_en_US_root 各自 list 项 properties **显式传 locale**：

```jsonc
// vd_zh_CN_root_router.json5 (改后):
"按画册": {
    "provider": "vd_albums_provider",
    "properties": { "locale": "zh_CN" }
}

// vd_en_US_root_router.json5:
"albums": {
    "provider": "vd_albums_provider",
    "properties": { "locale": "en_US" }
}
```

下层 vd_albums_provider（Phase 7d 迁移时）以 `${properties.locale}` 形式向 SQL 上下文传 locale，调 `get_plugin(id, '${properties.locale}')`。

⚠️ **注意 7a 不动 vd_zh_CN_root_router**——已上线工作正常；vd_en_US_root 用同样模式但不强制 7a 改 zh_CN（保留为 7d 工作）。本期只补 en_US 文件，**不传 locale**（vd_albums_provider 还没 DSL 化，传了也用不上）；后续 7d 迁移 vd_albums_provider 时再补 locale。

简化版 vd_en_US_root_router.json5：

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "vd_en_US_root_router",
    "list": {
        "albums":  { "provider": "vd_albums_provider" },
        "plugins": { "provider": "vd_plugins_provider" },
        "tasks":   { "provider": "vd_tasks_provider" },
        "surfs":   { "provider": "vd_surfs_provider" },
        "media":   { "provider": "vd_media_type_provider" },
        "dates":   { "provider": "vd_dates_provider" },
        "all":     { "provider": "vd_all_provider" }
    }
}
```

vd_albums_provider 等仍是 programmatic（7d 迁），直接命中即可。

### 决策 7：pilot 选 `sort_provider` + `gallery_search_router`

**`sort_provider`**：单 contrib query；apply_query 设置 `order.global = Revert`；无 list / resolve children。验证 contrib query 路径；DSL 写法：

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "sort_provider",
    "query": {
        "order": { "all": "revert" }
    }
}
```

**`gallery_search_router`**：纯 router 壳；单 static child `display-name` → `gallery_search_display_name_router`。验证 router list / resolve 路径；DSL 写法：

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "gallery_search_router",
    "list": {
        "display-name": { "provider": "gallery_search_display_name_router" }
    }
}
```

注：`gallery_search_display_name_router` + `gallery_search_display_name_query_provider` 仍 programmatic；DSL → programmatic 跨调用边界由 ProviderRuntime 自然处理。

### 决策 8：parity 测试 helper

新建 `pathql-rs/tests/helpers/parity.rs`（或 core 端 `tests/parity.rs`）：

```rust
/// 给定一组 (programmatic_factory, dsl_def_str, fixture_data, test_paths),
/// 跑两套 runtime, 比较 (composed.build_sql, list children names, list children meta) 等价。
pub fn assert_provider_parity(
    programmatic_factory: impl Fn(&HashMap<...>) -> Arc<dyn Provider>,
    dsl_json: &str,
    fixture_db: &Connection,
    test_paths: &[&str],
) {
    // 1. 构造 programmatic registry; 解析每条 path; 收集结果
    // 2. 构造 DSL registry (从 dsl_json 加载); 解析每条 path; 收集结果
    // 3. 逐项对比: SQL 字符串等价 / list children names 集合等价 / etc
}
```

放在 pathql-rs 里更好（不依赖 core 业务类型）；7b/c/d 任何迁移都通过 helper 验证 parity。

---

## Commit checkpoint 策略

7a 是**编译大部分时间 clean** 的小改造，分 6 个 commit：

```
S1  vd_en_US_root_router.json5 新文件 (compile-clean; pure data)
S2  Storage::open + dsl_funcs.rs + get_plugin 实现 (compile-clean)
S3  sort_provider DSL 迁移 + register 跳过 (compile-clean; DSL 优先)
S4  gallery_search_router DSL 迁移 + register 跳过 (compile-clean)
S5  parity test helper + sort/search parity 测试 (compile-clean)
S6  RULES.md / memory 更新 + 全套验证 (compile-clean)
```

每个 commit 独立可合并。

---

## 子任务拆解

### S1. `vd_en_US_root_router.json5` 新文件

新建 [`core/src/providers/dsl/vd/vd_en_US_root_router.json5`](../../src-tauri/core/src/providers/dsl/vd/vd_en_US_root_router.json5)（决策 5 内容）。

**Test (S1)**：
- `cargo test -p pathql-rs --test load_real_providers` 全绿（10 个真 .json5 全部加载）
- 启动 dev server `bun dev -c main --data prod`；浏览 `/vd/i18n-en_US/` 不再 PathNotFound；列出 7 个英文 segment

**Commit message**：
```
feat(phase7a/S1): add vd_en_US_root_router DSL (resolve dangling)

Adds vd_en_US_root_router.json5 mirroring vd_zh_CN_root_router with
English path segments (albums/plugins/tasks/surfs/media/dates/all).
Resolves the long-standing dangling provider reference from
vd_root_router.json5 (since 6c). Path /vd/i18n-en_US/... now lists
7 child segments instead of returning PathNotFound.

vd_albums_provider etc. remain programmatic (7d migration target).
DSL → programmatic interop verified working through registry.

Files: src-tauri/core/src/providers/dsl/vd/vd_en_US_root_router.json5
```

---

### S2. Storage SQL 函数注册 + `get_plugin` 实现

#### S2a. 新文件 `core/src/storage/dsl_funcs.rs`

完整内容见决策 2。

#### S2b. `Storage::open` 调用注册

修改 [`core/src/storage/mod.rs`](../../src-tauri/core/src/storage/mod.rs) 的 open / connect 入口：

```rust
// 在 open() 内连接打开后立刻调用:
let mut conn = Connection::open(&db_path)?;
// ... 原有 schema migration / pragma 设置
crate::storage::dsl_funcs::register_dsl_functions(&mut conn)
    .map_err(|e| format!("register DSL scalar functions: {e}"))?;
```

⚠️ 注：dsl_funcs 应在 schema migration 之后调用（避免 plugin 表未就绪时注册函数）。

`storage/mod.rs` 加 `mod dsl_funcs;`（不 pub —— 仅 storage 内部用）。

#### S2c. 单元测试 `dsl_funcs.rs` 内 `#[cfg(test)] mod tests`

```rust
#[test]
fn get_plugin_returns_null_for_unknown_id() {
    let mut conn = Connection::open_in_memory().unwrap();
    register_dsl_functions(&mut conn).unwrap();
    let result: String = conn
        .query_row("SELECT get_plugin('nonexistent')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(result, "null");
}

#[test]
fn get_plugin_returns_basic_metadata_json() {
    // 需要构造 mock PluginManager; 或用 #[cfg(test)] 的 fixture
    // 断言返回 {"id":..., "name":..., "description":..., "baseUrl":...}
}

#[test]
fn get_plugin_uses_locale_arg_when_provided() {
    // 同 plugin 在 zh_CN vs en_US 下 name 不同
}

#[test]
fn get_plugin_falls_back_to_global_locale_when_arg_omitted() {
    // 调 rust_i18n::set_locale("zh"); 调 get_plugin('p1') 单参; 期望 zh 名
}

#[test]
fn resolve_i18n_text_locale_priority() {
    // 单测 resolve_i18n_text: locale 完整 > prefix > default > en > ""
}
```

⚠️ mock PluginManager 是工程难点：`PluginManager::global_opt()` 是单例。本期可以接受**集成测试用真实启动**（`Storage::open` 全栈跑），单测 `resolve_i18n_text` 这种纯函数即可。

**Test (S2)**：
- `cargo test -p kabegame-core storage::dsl_funcs` 全绿（至少 3 个单测覆盖纯函数）
- 启动 dev server，DB 中已有 plugin 数据；在 sqlite shell（如 dev 工具）查 `SELECT get_plugin('pixiv')`，返回 JSON 对象字符串

**Commit message**：
```
feat(phase7a/S2): host SQL function infrastructure + get_plugin

New module core/src/storage/dsl_funcs.rs hosts sqlite scalar function
registrations. Currently registers `get_plugin(plugin_id [, locale])`
returning JSON {"id","name","description","baseUrl"} with i18n-resolved
name + description. Plugin not found → JSON 'null'.

Storage::open now calls register_dsl_functions(conn) after schema
migration so DSL providers (Phase 7b/c/d) can access plugin metadata
from SQL contexts via:
    SELECT json_extract(get_plugin(plugin_id, '${properties.locale}'),
                        '$.name') AS name FROM plugins;

Functions framework is extensible — future get_task / get_album_meta
etc. follow same pattern.

Files: src-tauri/core/src/storage/dsl_funcs.rs (new),
       src-tauri/core/src/storage/mod.rs (mod dsl_funcs; + open hook)
```

---

### S3. pilot 迁移：`sort_provider`

#### S3a. 新建 `core/src/providers/dsl/shared/sort_provider.json5`

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "sort_provider",
    "query": {
        "order": { "all": "revert" }
    }
}
```

#### S3b. `programmatic/mod.rs` 注释掉 `sort_provider` register

```diff
- register(reg, "sort_provider", |_| {
-     Ok(Arc::new(shared::SortProvider) as Arc<dyn Provider>)
- })?;
+ // 7a: sort_provider 已迁移到 DSL (dsl/shared/sort_provider.json5)
+ // register(reg, "sort_provider", |_| {
+ //     Ok(Arc::new(shared::SortProvider) as Arc<dyn Provider>)
+ // })?;
```

⚠️ 暂保留 `programmatic::shared::SortProvider` struct 不删——7d 大迁移收尾时统一删 programmatic 模块；本期保留方便随时回滚。

**Test (S3)**：
- `cargo test -p pathql-rs --test load_real_providers` 通过（11 个 .json5 加载）
- `cargo test -p kabegame-core` 全绿
- 手测 dev server `/gallery/all/x100x/1/desc/`（搜索 desc 这种走 sort_provider 的路径），输出顺序应翻转

**Commit message**：
```
feat(phase7a/S3): migrate sort_provider to DSL (pilot 1/2)

First pilot migration: sort_provider moves from programmatic
(struct SortProvider with apply_query setting order.global = Revert)
to a one-line DSL contrib query:
    "query": { "order": { "all": "revert" } }

Verifies that ContribQuery → fold_contrib path produces the same
ProviderQuery state as the programmatic impl.

programmatic::SortProvider struct retained but `register(...)` call
commented; full removal deferred to 7d cleanup.

Files: src-tauri/core/src/providers/dsl/shared/sort_provider.json5 (new),
       src-tauri/core/src/providers/programmatic/mod.rs (skip register)
```

---

### S4. pilot 迁移：`gallery_search_router`

#### S4a. 新建 `core/src/providers/dsl/gallery/gallery_search_router.json5`

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "gallery_search_router",
    "list": {
        "display-name": { "provider": "gallery_search_display_name_router" }
    }
}
```

#### S4b. `programmatic/mod.rs` 注释掉 `gallery_search_router` register

```diff
- register(reg, "gallery_search_router", |_| {
-     Ok(Arc::new(gallery_filters::GallerySearchRouter) as Arc<dyn Provider>)
- })?;
+ // 7a: gallery_search_router 已迁移到 DSL (dsl/gallery/gallery_search_router.json5)
+ // register(reg, "gallery_search_router", |_| { ... })?;
```

⚠️ `gallery_search_display_name_router` + `gallery_search_display_name_query_provider` **仍 programmatic 注册**；DSL → programmatic 跨调用通过 ProviderRuntime 自然处理。

**Test (S4)**：
- `cargo test -p kabegame-core` 全绿
- 手测 dev server 浏览 `/gallery/search/` → list 应有 `display-name` 子项（DSL 输出）；浏览 `/gallery/search/display-name/<query>/` → 命中 query provider 输出 SQL（programmatic 输出）

**Commit message**：
```
feat(phase7a/S4): migrate gallery_search_router to DSL (pilot 2/2)

Second pilot migration: pure router shell with single static child.
DSL `list` table maps "display-name" → gallery_search_display_name_router
(which remains programmatic — verifies DSL → programmatic interop
through ProviderRuntime registry lookup).

Files: src-tauri/core/src/providers/dsl/gallery/gallery_search_router.json5 (new),
       src-tauri/core/src/providers/programmatic/mod.rs (skip register)
```

---

### S5. parity 测试 helper + sort / search parity 测试

#### S5a. parity helper 模块

新建 [`pathql-rs/tests/parity_helper/mod.rs`](../../src-tauri/pathql-rs/tests/parity_helper/mod.rs)：

```rust
//! Parity 测试 helper: 比较 programmatic vs DSL provider 在同一路径上的输出等价。
//! 给 7a-7d 所有迁移用。

use std::sync::Arc;
use std::collections::HashMap;
use pathql_rs::{
    ProviderRegistry, Provider, ProviderRuntime,
    Json5Loader, Loader, Source,
    SqlExecutor, ClosureExecutor, SqlDialect,
};
use pathql_rs::ast::{Namespace, ProviderName};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::template::eval::{TemplateContext, TemplateValue};

pub struct ParityCase<'a> {
    pub name: &'a str,
    pub programmatic_factory: Box<dyn Fn() -> Arc<dyn Provider>>,
    pub dsl_json: &'a str,
    pub test_paths: &'a [&'a str],
    pub test_resolve: bool,    // 比较 resolve 结果?
    pub test_list: bool,       // 比较 list children?
    pub test_build_sql: bool,  // 比较 composed.build_sql 输出?
}

pub fn run_parity_case(case: ParityCase, executor: Arc<dyn SqlExecutor>) {
    // 1. programmatic registry: register provider + 简单 root
    // 2. DSL registry: load dsl_json + 简单 root
    // 3. 对每条 test_path:
    //    - 跑 programmatic.resolve(path), DSL.resolve(path)
    //    - 比较 composed.build_sql(ctx, dialect) 字符串等价 (test_build_sql=true)
    //    - 比较 list children 名字 + meta 等价 (test_list=true)
    //    - 不等 → panic 报清楚 (path, lhs vs rhs diff)
}
```

⚠️ helper 复杂度可观；7a 实现一个 minimal viable 版本（只比较 build_sql 字符串）；7b 加 list children 比较；7d 加 meta 比较。

#### S5b. sort_provider parity 测试

新建 `pathql-rs/tests/parity_sort_provider.rs`：

```rust
mod parity_helper;
use parity_helper::*;

#[test]
fn sort_provider_parity() {
    // programmatic 端: 直接构造 SortProvider 实例 (需要从 core 导入 — 但 core 是 binary, 不能在 pathql-rs 测试里依赖)
    // 替代: 在 pathql-rs 测试里写一个 mock SortProvider (复制 5 行 apply_query 逻辑)
    
    let dsl_json = r#"{
        "namespace":"kabegame","name":"sort_provider",
        "query":{"order":{"all":"revert"}}
    }"#;
    
    // 跑 parity case ...
}
```

⚠️ pathql-rs 测试不能 import core 的 SortProvider —— 需要 mock。这是 parity 测试的现实代价：**对每个迁移 provider，pathql-rs 测试里写一个等价 mock**。代码重复 ~5-10 行/provider，可接受。

或者：parity 测试放在 **core 端**（`core/tests/parity.rs`）；core 能 import programmatic 实现 + 通过 pathql-rs API 加载 DSL。

**推荐**：parity 测试放 core 端；helper 仍在 pathql-rs（pure logic; 不 import 业务）；core 端 wrapper 调 helper 注入 programmatic 实现。

#### S5c. search_router parity 测试（见 S5b 模式）

类似 sort，但比较 list children name 序列。

**Test (S5)**：
- `cargo test -p kabegame-core --test parity` 全绿（含 sort + search 两个 parity case）

**Commit message**：
```
test(phase7a/S5): parity test infrastructure + sort + search verified

Adds pathql-rs/tests/parity_helper/ — reusable test utility comparing
programmatic vs DSL provider behavior on identical paths. Compares:
- composed.build_sql() string equivalence (apply_query path)
- list children name sequence (list path)
- (later 7d) meta equivalence

core/tests/parity.rs runs the helper with real programmatic factories
imported from core::providers::programmatic + DSL loaded from
core/src/providers/dsl/. Validates 7a pilot migrations:
- sort_provider: ContribQuery (order.global = Revert) parity
- gallery_search_router: list children = ["display-name"] parity

Same helper will cover 7b/7c/7d migrations.

Files: src-tauri/pathql-rs/tests/parity_helper/mod.rs (new),
       src-tauri/core/tests/parity.rs (new)
```

---

### S6. RULES.md / memory 更新 + 全套验证

#### S6a. RULES.md 主机 SQL 函数章节

[`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md) 新增 §11.2 / §13（编号待定）"主机 SQL 函数"小节：

- 引擎不内置主机函数；消费者（如 kabegame-core）通过 `Connection::create_scalar_function` 在 SqlExecutor 持有的 connection 上注册自定义标量函数
- DSL 文件里通过函数名 + sqlite JSON1 函数（json_extract 等）拆解返回值
- kabegame 当前注册：`get_plugin(plugin_id [, locale]) -> JSON_TEXT`，返回 `{id, name, description, baseUrl}`
- 未来扩展：`get_task` / `get_album_meta` 等同模式

#### S6b. memory 更新

[`project_dsl_architecture.md`](C:/Users/Lenovo/.claude/projects/d--Codes-kabegame/memory/project_dsl_architecture.md) 加决策 5：

```
**决策 5：主机 SQL 函数 (host scalar function) 注入 — Phase 7a 起**

非 SQL 表数据源（PluginManager 等业务侧元数据）通过 sqlite 标量函数桥
接给 DSL SQL 上下文。kabegame-core/src/storage/dsl_funcs.rs 在 Storage::open
后通过 Connection::create_scalar_function 注册函数; DSL .json5 直接调用 +
json_extract 拆字段。

**Why:** DSL 是 SQL-first 的; 业务元数据（如插件 manifest）不在 SQL 表
里, 需要桥接才能在 ContribQuery 上下文中用. 标量函数是 sqlite 工业惯例,
比独立 RPC 通道简单. JSON 字符串返回让函数签名稳定 (新字段加在 JSON 里
不破坏 DSL 调用方).

**How to apply:**
- pathql-rs 不感知主机函数; 仅 SqlExecutor 实现者负责注册
- core/src/storage/dsl_funcs.rs 集中所有标量函数定义
- 命名: get_<entity>(id [, locale]) -> JSON_TEXT
- 当前注册: get_plugin
- DSL 调用模式: SELECT json_extract(get_plugin(plugin_id, '${properties.locale}'), '$.name')
```

#### S6c. 全套验证

```bash
cargo test -p pathql-rs --features "json5 validate"
cargo test -p kabegame-core
bun check -c main --skip vue
bun dev -c main --data prod
```

手测：
- `/vd/i18n-en_US/` → 列出 7 个英文 segment（不再 PathNotFound）
- `/vd/i18n-zh_CN/` → 行为不变（zh_CN 路径未动）
- `/gallery/all/x100x/1/desc/` → sort_provider DSL 翻转生效（实际呈现倒序）
- `/gallery/search/` → 列出 `display-name` 子项；`/gallery/search/display-name/foo/` → 走 programmatic search_display_name_router 命中

⚠️ 重点验证：sort + search 路径的实际 SQL / image set 与 7a 之前一致（行为零回归）。

**Commit message**：
```
docs(phase7a/S6): RULES.md host SQL functions + memory + final verify

- RULES.md adds host scalar function section (registry pattern,
  get_plugin signature, json_extract usage convention)
- Memory project_dsl_architecture.md: decision 5 (host SQL functions)
- Verified: cargo test pathql-rs/core green, bun check passes,
  manual /vd/i18n-en_US/ + /gallery/.../desc/ + /gallery/search/
  paths exhibit no regression

Phase 7a complete; 7b can now leverage:
- get_plugin scalar function for plugins migration
- parity_helper test framework for behavior verification
- pilot pattern proven (DSL ↔ programmatic interop)
```

---

## 完成标准

- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿
- [ ] `cargo test -p kabegame-core` 全绿（含 dsl_funcs / parity 测试）
- [ ] `bun check -c main --skip vue` 通过
- [ ] `vd_en_US_root_router.json5` 落地，`/vd/i18n-en_US/` 路径不再 PathNotFound
- [ ] `Storage::open` 注册 `get_plugin` 标量函数；sqlite 内可调
- [ ] `get_plugin('pixiv', 'en_US')` 返回 `{id, name, description, baseUrl}` JSON 对象字符串；name / description 按 locale 解析
- [ ] `sort_provider` + `gallery_search_router` 已 DSL 化；programmatic register 调用注释；行为零回归
- [ ] parity 测试覆盖 sort + search；helper 模板可被 7b/c/d 复用
- [ ] RULES.md / memory 更新

## 风险点

1. **`PluginManager::global_opt()` 在测试期可能未初始化**：S2c 单测里直接调 `get_plugin_json('p1')` 会拿到 `"null"`（PluginManager 未启）→ 测试通过但语义不全。**缓解**：单测重点测 `resolve_i18n_text` 纯函数；`get_plugin` 行为留给手测 / 集成测试

2. **`rusqlite::Context::get(1)` 在只传 1 参数时报错**：得先检查 `ctx.len()`（决策 2 已处理）。需测：单参数 / 双参数 / 三参数（应该报错，因为 -1 接受 1+ 参数；具体行为需查 rusqlite 文档）

3. **`Connection::create_scalar_function` 与 connection clone**：rusqlite 函数注册是 per-connection；如果 Storage 用连接池或 clone connection，新连接没有函数。**实测当前**：core 是单连接 `Arc<Mutex<Connection>>`，无连接池 → 注册一次即可；如未来切池要重新设计

4. **DSL → programmatic 跨调用边界**：S4 的 `gallery_search_router`（DSL）→ `gallery_search_display_name_router`（programmatic）；ProviderRuntime registry lookup 已支持但要验证；手测 `/gallery/search/display-name/foo/` 是核心 sanity check

5. **parity helper 测试代码重复**：每个迁移 provider 在 pathql-rs 测试里需要一个 mock impl 复制 apply_query 逻辑（如果 parity 测试不放 core 端）。决策 8 推荐放 core 端避免此问题；如最终放 pathql-rs，可接受 ~5 行/provider 重复

6. **sort_provider 在 DSL `order.all = revert` 形态对应正确性**：实测 6c 的 fold_contrib 对 `order: {"all":"revert"}` 应解析为 `OrderState.global = Some(OrderDirection::Revert)`；S3 跑通就证明等价；如失败需查 fold.rs 实现

7. **`/vd/i18n-en_US/` 7 个 segment 与前端期望对齐**：前端可能预期固定的英文段名（如 `albums` 而非 `album`）；S1 决定的 7 个英文段需要前端 review 一遍 —— 如有歧义本期可以 commit 后再调整文件

---

## 完成 7a 后的下一步

进入 **Phase 7b** —— Gallery 滤镜 17 个 provider 大迁移：
- 用 7a 建立的 parity helper 框架
- 用 7a 注册的 `get_plugin` 主机函数（gallery_plugin_provider 迁移时直接用）
- 逐个 provider commit，每个加 parity 测试
