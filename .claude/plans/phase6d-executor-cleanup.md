# Phase 6d 详细计划 — Executor trait 化 + 强制注入 + drivers 模块清退

## Context

承接 **Phase 6c 实际完成态**（与原 6c 计划有偏差，校正基线）：

- ✅ 6c 实现：DSL 加载、validate、SqlExecutor 抽象、IPC meta 暴露、动态 list、reverse lookup、9 个 .json5 端到端跑通
- ❌ 6c 未实现（推到 6d）：
  - **`SqlExecutor` 仍是 `Arc<dyn Fn(&str, &[TemplateValue]) -> Result<...>>`**（type alias），无 `dialect()` 方法
  - **`ProviderRuntime` 持 `Option<SqlExecutor>`**，executor 缺省 = None；DSL 动态 SQL 项遇 None 抛 `EngineError::ExecutorMissing`
  - **`pathql_rs::drivers::sqlite`** 模块仍在 + 仍 public；core 在 7 处直接调 `params_for(...)`：1 处 sql_executor.rs + 6 处 storage/gallery.rs
  - sync/async feature 切换 / 内置 sqlx_executor 等更高阶设计 —— 6d **不**做（推 Phase 7+；6d 仅为它们清理障碍）

### Phase 6d 目标

1. **Executor 强制 + 方言标注**：`SqlExecutor` 从 type alias 改 trait，加 `fn dialect() -> SqlDialect`；`ProviderRuntime::new` 接 `Arc<dyn SqlExecutor>` 必填，删除 `Option` / `new_with_executor` 双路 / `EngineError::ExecutorMissing`
2. **删除 `drivers::sqlite` 类型桥**：pathql-rs 不再依赖 rusqlite；`drivers/` 模块整个删除；`sqlite` feature 废弃
3. **类型桥下沉到 core**：6 行 `template_to_rusqlite / template_params_for` 移到 `core/src/storage/template_bridge.rs`，`pub(crate)` 私有
4. **build_sql 接收 dialect**：渲染期按方言选 placeholder（`?` vs `$1, $2, ...`）；6d 仅完整支持 Sqlite，其他方言占位 `unimplemented!()`
5. **零行为回归**：core 端 IPC / Tauri commands / 用户可见行为不变

完成后：pathql-rs 与 rusqlite 完全解耦；executor 接口 trait 化、有方言契约、为 Phase 7+ 引入 async / sqlx_executor 准备好土壤。

### 约束

- pathql-rs 删 rusqlite 后 `cargo build -p pathql-rs --no-default-features` 干净（**纯 dialect-agnostic 渲染 + 抽象 executor + AST/validate**）
- 6d 不引入 async / 不接 sqlx / 不切 feature 切签名 —— sync trait 单形态
- core 端调用点改造一次性完成；中间状态会编译失败（依赖项被替换）

---

## 锁定的设计选择

### 决策 1：`SqlExecutor` trait + 方言

```rust
// pathql-rs/src/provider/mod.rs

pub enum SqlDialect {
    Sqlite,
    Postgres,
    Mysql,
    // 6d 仅完整支持 Sqlite; Postgres / Mysql 在 build_sql 渲染处占位 unimplemented!
}

pub trait SqlExecutor: Send + Sync + 'static {
    fn dialect(&self) -> SqlDialect;

    fn execute(
        &self,
        sql: &str,
        params: &[TemplateValue],
    ) -> Result<Vec<serde_json::Value>, EngineError>;
}
```

### 决策 2：附 `ClosureExecutor` helper（pathql-rs 自带，测试 / 简单场景用）

```rust
pub struct ClosureExecutor<F> {
    dialect: SqlDialect,
    f: F,
}

impl<F> ClosureExecutor<F>
where
    F: Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
        + Send + Sync + 'static,
{
    pub fn new(dialect: SqlDialect, f: F) -> Self { Self { dialect, f } }
}

impl<F> SqlExecutor for ClosureExecutor<F>
where
    F: Fn(&str, &[TemplateValue]) -> Result<Vec<serde_json::Value>, EngineError>
        + Send + Sync + 'static,
{
    fn dialect(&self) -> SqlDialect { self.dialect }
    fn execute(&self, sql: &str, params: &[TemplateValue])
        -> Result<Vec<serde_json::Value>, EngineError>
    {
        (self.f)(sql, params)
    }
}
```

测试 + 简单 backend 用闭包；正式 backend（持 connection state）用 struct + impl。

### 决策 3：`ProviderRuntime::new` executor 必填

```rust
impl ProviderRuntime {
    pub fn new(
        registry: Arc<ProviderRegistry>,
        root: Arc<dyn Provider>,
        executor: Arc<dyn SqlExecutor>,    // 必填
    ) -> Arc<Self>;
}
```

删除：`new_with_executor` / `Option<SqlExecutor>` 字段 / `executor()` 返回 `Option<...>` / `EngineError::ExecutorMissing` variant。

### 决策 4：`build_sql` 加 dialect 参数

```rust
impl ProviderQuery {
    pub fn build_sql(
        &self,
        ctx: &TemplateContext,
        dialect: SqlDialect,   // 新增
    ) -> Result<(String, Vec<TemplateValue>), BuildError>;
}
```

调用点：
- pathql-rs 内 DslProvider 调 build_sql 时取 `ctx.runtime.executor().dialect()`
- core Storage::get_images_*_by_query 直接传 `SqlDialect::Sqlite`（core 是 Sqlite-only）

渲染期 dispatch：

```rust
match dialect {
    SqlDialect::Sqlite | SqlDialect::Mysql => sql.push_str("?"),
    SqlDialect::Postgres => {
        sql.push_str(&format!("${}", params.len()));   // 注意 params 已 push
    }
}
```

6d 仅 Sqlite 路径覆盖完整测试；Postgres / Mysql 路径加 sanity 单测但不要求所有 fixture 路径覆盖。

### 决策 5：drivers 模块整个删除

不保留兼容、不保留 deprecate 期、不留空 `mod drivers;` —— **当不存在**：

```
pathql-rs/src/
├── ast/
├── compose/
├── drivers/         ← 删除整个目录
├── loader.rs
├── ...
```

`Cargo.toml` `[features]` 删除 `sqlite = ["dep:rusqlite"]`；`[dependencies]` 删除 `rusqlite = { workspace = true, optional = true }`。

### 决策 6：core 类型桥位置 & 可见性

新文件 `core/src/storage/template_bridge.rs`：

```rust
//! TemplateValue → rusqlite::Value 桥接 (6d 起 core 私有, pathql-rs 已删此功能)。

use pathql_rs::template::eval::TemplateValue;
use rusqlite::types::Value;

pub(crate) fn template_to_rusqlite(v: &TemplateValue) -> Value {
    match v {
        TemplateValue::Null => Value::Null,
        TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        TemplateValue::Int(i) => Value::Integer(*i),
        TemplateValue::Real(r) => Value::Real(*r),
        TemplateValue::Text(s) => Value::Text(s.clone()),
        TemplateValue::Json(v) => Value::Text(v.to_string()),
    }
}

pub(crate) fn template_params_for(values: &[TemplateValue]) -> Vec<Value> {
    values.iter().map(template_to_rusqlite).collect()
}
```

`pub(crate)` 而非 `pub` —— core 内部使用即可，无外部 lib 用户。

---

## Commit checkpoint 策略

6d 是**小型 atomic 改造**（与 6b 比起来），但仍含中间编译失败状态。建议 4 个 commit checkpoint：

```
┌──────────────────────────────────────────────────────────────┐
│ Stage A (compile-FAIL begins, pathql-rs 内部翻转)             │
│   S1  pathql-rs SqlExecutor → trait + ClosureExecutor +     │
│       SqlDialect + build_sql(dialect 参数) + ExecutorMissing │
│       删除 + Runtime executor 强制                           │
├──────────────────────────────────────────────────────────────┤
│ Stage B (compile-FAIL persists, drivers 删 + bridge 下沉)     │
│   S2  pathql-rs 删 drivers/ + sqlite feature + rusqlite dep  │
│   S3  core 新建 template_bridge.rs + 改 7 处调用点            │
│   S4  core sql_executor.rs 改 struct + impl SqlExecutor;    │
│       init.rs / runtime 入口改 Arc<dyn SqlExecutor>          │
├──────────────────────────────────────────────────────────────┤
│ Stage C (compile-clean 恢复)                                  │
│   S5  pathql-rs + core 测试套件修整 + 全套验证                │
└──────────────────────────────────────────────────────────────┘
```

每个 commit 必须明示：
- 完成范围
- 编译状态（`compile-broken` / `compile-clean`）
- 已知 broken 调用点（grep 结果可贴 commit body）

---

## 子任务拆解

### S1. pathql-rs：SqlExecutor 改 trait + dialect + 强制注入

#### S1a. `SqlExecutor` 类型替换

修改 [`pathql-rs/src/provider/mod.rs`](../../src-tauri/pathql-rs/src/provider/mod.rs):

**替换**（删除原 `pub type SqlExecutor = Arc<dyn Fn(...)>`）→ trait 定义（决策 1）+ ClosureExecutor 助手（决策 2）。

`SqlDialect` enum 加在同一文件（或独立 `provider/dialect.rs` 子模块）。

#### S1b. 删除 `EngineError::ExecutorMissing` variant

```rust
// provider/mod.rs
pub enum EngineError {
    // ... 其他 variant
    // #[error("executor not provided in runtime; ...")]
    // ExecutorMissing,   ← 删除
}
```

调用点 grep `EngineError::ExecutorMissing` 全部改为：拿不到 executor 的代码路径（决策 3 后不存在）整个删除——不再有 `Option<SqlExecutor>` 检查。

#### S1c. `ProviderRuntime` executor 强制

[`pathql-rs/src/provider/runtime.rs`](../../src-tauri/pathql-rs/src/provider/runtime.rs):

```rust
pub struct ProviderRuntime {
    registry: Arc<ProviderRegistry>,
    root: Arc<dyn Provider>,
    weak_self: Weak<Self>,
    executor: Arc<dyn SqlExecutor>,     // 6d: 必填, 不再 Option
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    pub fn new(
        registry: Arc<ProviderRegistry>,
        root: Arc<dyn Provider>,
        executor: Arc<dyn SqlExecutor>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            registry, root, executor,
            weak_self: weak.clone(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn executor(&self) -> &Arc<dyn SqlExecutor> { &self.executor }

    // 删除: pub fn new_with_executor(...)
}
```

#### S1d. `build_sql` 加 dialect 参数

[`pathql-rs/src/compose/build.rs`](../../src-tauri/pathql-rs/src/compose/build.rs):

```rust
impl ProviderQuery {
    pub fn build_sql(
        &self,
        ctx: &TemplateContext,
        dialect: SqlDialect,
    ) -> Result<(String, Vec<TemplateValue>), BuildError> {
        // ... 原渲染逻辑
        // placeholder push 处:
        match dialect {
            SqlDialect::Sqlite | SqlDialect::Mysql => sql.push('?'),
            SqlDialect::Postgres => {
                let n = params.len() + 1;  // 当前要 push 的参数序号
                sql.push_str(&format!("${}", n));
            }
        }
        // ...
    }
}
```

注：placeholder 替换发生在 [`compose/render.rs`](../../src-tauri/pathql-rs/src/compose/render.rs) 的 `render_template_sql` 内部 push `?` 处；本子任务把 `?` 改为 `placeholder_for(dialect, params.len())` 调用，render 函数也加 `dialect` 参数。

build.rs / render.rs / 所有内部使用点签名同步更新。

#### S1e. DslProvider / 任何 build_sql 调用点改造

[`pathql-rs/src/provider/dsl_provider.rs`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs):

```rust
// 原:
let (sql, params) = composed.build_sql(&ctx)?;

// 新:
let dialect = ctx.runtime.executor().dialect();
let (sql, params) = composed.build_sql(&ctx, dialect)?;
```

grep `build_sql(&` 全部加第二参数。

**Test (S1)**：
- pathql-rs 内全 build_sql 调用点更新；`cargo test -p pathql-rs --features "json5 validate sqlite"` 编译失败（drivers 仍在但与新 trait 不兼容；S2 后才通）。本 stage **暂不**强求测试绿
- 单独单测：`SqlExecutor` trait 接口 / `ClosureExecutor` 闭包桥 / `SqlDialect` 各 variant build_sql placeholder snapshot

**Commit message**：
```
wip(phase6d/S1): pathql-rs SqlExecutor → trait + dialect + executor required

Replaces `pub type SqlExecutor = Arc<dyn Fn>` with `pub trait SqlExecutor`
exposing dialect() + execute(). Adds SqlDialect enum (Sqlite/Postgres/Mysql)
and ClosureExecutor helper for tests / simple backends.

ProviderRuntime::new now requires Arc<dyn SqlExecutor>; removed
new_with_executor + Option storage + EngineError::ExecutorMissing.

build_sql signature gains dialect parameter; placeholder rendering switches
on dialect (Sqlite/Mysql=`?`, Postgres=`$N`).

Compile state: BROKEN
- core/src/providers/sql_executor.rs still uses Arc<Fn> form (S4)
- core/src/storage/gallery.rs build_sql calls missing dialect arg (S3)
- pathql-rs drivers::sqlite still depends on rusqlite (S2)

Files: pathql-rs/src/provider/{mod,runtime,dsl_provider}.rs,
       pathql-rs/src/compose/{build,render}.rs
```

---

### S2. pathql-rs：删除 drivers/ + sqlite feature + rusqlite dep

```bash
# 仓库内执行
git rm -r src-tauri/pathql-rs/src/drivers/
```

修改 [`pathql-rs/src/lib.rs`](../../src-tauri/pathql-rs/src/lib.rs)：删除 `pub mod drivers;`。

修改 [`pathql-rs/Cargo.toml`](../../src-tauri/pathql-rs/Cargo.toml)：

```toml
[dependencies]
# rusqlite = { workspace = true, optional = true }   ← 删除

[features]
default = []
json5 = ["dep:json5"]
validate = ["dep:regex-automata", "dep:sqlparser"]
# sqlite = ["dep:rusqlite"]   ← 删除
```

修改 [`pathql-rs/src/template/eval.rs:14`](../../src-tauri/pathql-rs/src/template/eval.rs#L14) 的过时注释：

```rust
- /// pathql-rs 只产生它; 具体 DB 驱动转换在 `drivers::sqlite` 等 feature 下。
+ /// pathql-rs 只产生它; 具体 DB 驱动转换由消费者自管 (6d 起 pathql-rs 不附驱动桥)。
```

修改 [`pathql-rs/README.md`](../../src-tauri/pathql-rs/README.md) feature 表删除 `sqlite` 行；如有"如何接 rusqlite"段落改为"消费者自实现 SqlExecutor + 自管类型转换"指南。

⚠️ pathql-rs 自带集成测试也要改（**本子任务最大工作量**）：
- `tests/build_real_chain.rs` 删除 `use pathql_rs::drivers::sqlite::params_for` + 内联 `params_for` 函数（自包含测试用，不再 reexport）
- `tests/dsl_dynamic_sqlite.rs` 同上
- `tests/dsl_full_chain_sqlite.rs` 同上
- `tests/runtime_real_sqlite.rs` 同上

每个测试文件加一个本地辅助：

```rust
// tests/<name>.rs 顶部
fn local_params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    values.iter().map(|v| match v {
        TemplateValue::Null => rusqlite::types::Value::Null,
        TemplateValue::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        TemplateValue::Int(i) => rusqlite::types::Value::Integer(*i),
        TemplateValue::Real(r) => rusqlite::types::Value::Real(*r),
        TemplateValue::Text(s) => rusqlite::types::Value::Text(s.clone()),
        TemplateValue::Json(v) => rusqlite::types::Value::Text(v.to_string()),
    }).collect()
}
```

Cargo.toml `[dev-dependencies]` 加 `rusqlite = { workspace = true }`（dev only，不入主依赖图）：

```toml
[dev-dependencies]
serde_json = { workspace = true }
rusqlite = { workspace = true }   # 仅集成测试用; 主代码已无 rusqlite 引用
```

**Test (S2)**：
- `cargo build -p pathql-rs` 干净（无 rusqlite dep；纯 dialect-agnostic）
- `cargo build -p pathql-rs --features "json5 validate"` 干净
- 集成测试用 `--features "json5 validate"` + dev-dep rusqlite 跑通；S5 阶段完整跑

**Commit message**：
```
chore(phase6d/S2): remove pathql-rs::drivers + sqlite feature + rusqlite dep

Deletes src/drivers/ entirely (drivers::sqlite::params_for / to_rusqlite).
The bridge belongs in client crates (core moves it to storage/template_bridge
in S3); pathql-rs is now fully dialect-agnostic with zero driver deps.

Cargo.toml: drops `sqlite` feature + `rusqlite` optional dep; rusqlite stays
under [dev-dependencies] for integration tests that still need real sqlite.

Tests inline a local params_for helper per file (4 files).

Compile state: build CLEAN for pathql-rs main; tests still BROKEN until
S5 final.

Files: pathql-rs/src/{lib.rs, template/eval.rs}, pathql-rs/Cargo.toml,
       pathql-rs/README.md, pathql-rs/tests/{build_real_chain,
       dsl_dynamic_sqlite, dsl_full_chain_sqlite, runtime_real_sqlite}.rs
```

---

### S3. core：类型桥下沉 + storage/gallery.rs 6 处调用点改造

#### S3a. 新建 `core/src/storage/template_bridge.rs`

完整内容见决策 6。

[`core/src/storage/mod.rs`](../../src-tauri/core/src/storage/mod.rs) 加：

```rust
pub(crate) mod template_bridge;
```

⚠️ 不 `pub use` —— 仅 `crate::storage::template_bridge::template_params_for(...)` 路径访问。

#### S3b. 替换 storage/gallery.rs 6 处 import

```bash
grep -n "use pathql_rs::drivers::sqlite::params_for;" \
  src-tauri/core/src/storage/gallery.rs
```

每处替换：

```rust
- use pathql_rs::drivers::sqlite::params_for;
+ use crate::storage::template_bridge::template_params_for as params_for;
```

`as params_for` 别名让原内联调用 `params_for(&inner_values)` 不动；如偏好显式名替换全 6 处 `params_for` → `template_params_for`。

#### S3c. build_sql 调用加 dialect

grep `build_sql(&` 在 storage/gallery.rs 全部命中（应该 3 处），改为：

```rust
- let (sql, values) = q.build_sql(&ctx).map_err(...)?;
+ let (sql, values) = q.build_sql(&ctx, pathql_rs::SqlDialect::Sqlite).map_err(...)?;
```

⚠️ Storage 层硬编码 `SqlDialect::Sqlite` 是 6d 期接受的简化；多方言 Storage 是后期工作（核心阻力是 ImageInfo 等 typed 结构与 rusqlite 紧耦合）。

**Test (S3)**：
- `cargo build -p kabegame-core` 仍 BROKEN（sql_executor.rs 还在 Arc<Fn> 形态 + drivers 路径已 410；S4 才通）
- 本 commit 不强求测试

**Commit message**：
```
wip(phase6d/S3): core type bridge moves to storage/template_bridge

New private module core/src/storage/template_bridge.rs hosts the 6-line
template_to_rusqlite / template_params_for helpers (formerly in
pathql_rs::drivers::sqlite, deleted in S2).

storage/gallery.rs: 6 imports replaced; 3 build_sql calls add
SqlDialect::Sqlite arg.

Compile state: BROKEN
- core/src/providers/sql_executor.rs still on old Arc<Fn> SqlExecutor (S4)

Files: core/src/storage/{mod.rs (mod template_bridge), template_bridge.rs,
       gallery.rs}
```

---

### S4. core：sql_executor.rs 改 struct + impl + init.rs 接 Arc<dyn SqlExecutor>

#### S4a. 重写 `core/src/providers/sql_executor.rs`

```rust
//! pathql-rs SqlExecutor 的 core 实现:
//! 包装 Storage 共享的 rusqlite Connection, 6d 起用 trait 形态 (替代旧 Arc<Fn>)。
//!
//! 调用约定: 关闭 Storage 全局锁后再调用 `execute()` — 内部只 lock 本结构持有的
//! `Arc<Mutex<Connection>>` 副本, 不回 Storage::global() 路径, 避免重入死锁。

use std::sync::{Arc, Mutex};

use pathql_rs::provider::{EngineError, SqlDialect, SqlExecutor};
use pathql_rs::template::eval::TemplateValue;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

use crate::storage::template_bridge::template_params_for;

pub struct KabegameSqlExecutor {
    db: Arc<Mutex<Connection>>,
}

impl KabegameSqlExecutor {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self { db }
    }
}

impl SqlExecutor for KabegameSqlExecutor {
    fn dialect(&self) -> SqlDialect {
        SqlDialect::Sqlite
    }

    fn execute(
        &self,
        sql: &str,
        params: &[TemplateValue],
    ) -> Result<Vec<JsonValue>, EngineError> {
        let conn = self.db.lock().map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("storage mutex poisoned: {e}"),
            )
        })?;
        let mut stmt = conn.prepare(sql).map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("prepare failed: {e}"),
            )
        })?;
        let rusq_params = template_params_for(params);
        let col_names: Vec<String> = stmt
            .column_names()
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                let mut obj = Map::with_capacity(col_names.len());
                for (i, name) in col_names.iter().enumerate() {
                    let v = match row.get_ref_unwrap(i) {
                        rusqlite::types::ValueRef::Null => JsonValue::Null,
                        rusqlite::types::ValueRef::Integer(n) => JsonValue::from(n),
                        rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
                            .map(JsonValue::Number)
                            .unwrap_or(JsonValue::Null),
                        rusqlite::types::ValueRef::Text(t) => {
                            JsonValue::String(String::from_utf8_lossy(t).into_owned())
                        }
                        rusqlite::types::ValueRef::Blob(_) => JsonValue::Null,
                    };
                    obj.insert(name.clone(), v);
                }
                Ok(JsonValue::Object(obj))
            })
            .map_err(|e| {
                EngineError::FactoryFailed(
                    "core".into(),
                    "sql_executor".into(),
                    format!("query_map failed: {e}"),
                )
            })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
            EngineError::FactoryFailed(
                "core".into(),
                "sql_executor".into(),
                format!("collect rows failed: {e}"),
            )
        })
    }
}

// 删除原 `pub fn make_sql_executor(db) -> SqlExecutor` 函数 —— 调用方直接构造 struct
```

#### S4b. core/init.rs 入口改造

[`core/src/providers/init.rs`](../../src-tauri/core/src/providers/init.rs):

```rust
- use crate::providers::sql_executor::make_sql_executor;
+ use crate::providers::sql_executor::KabegameSqlExecutor;

// 在 provider_runtime 内:
- let executor = make_sql_executor(db.clone());
- ProviderRuntime::new_with_executor(registry, root, Some(executor))
+ let executor: Arc<dyn pathql_rs::provider::SqlExecutor> =
+     Arc::new(KabegameSqlExecutor::new(db.clone()));
+ ProviderRuntime::new(registry, root, executor)
```

#### S4c. 其他调用点

grep core 内 `make_sql_executor` 引用全部清掉。

**Test (S4)**：
- `cargo build -p kabegame-core` 干净（恢复编译）
- core 测试套若有 mock executor 用 Arc<Fn> 闭包形态 → 改用 `pathql_rs::ClosureExecutor::new(SqlDialect::Sqlite, |sql, params| ...)`

**Commit message**：
```
feat(phase6d/S4): core SqlExecutor switches to struct+trait + init wired

Rewrites core/src/providers/sql_executor.rs:
- Removes `make_sql_executor(db) -> Arc<Fn>` factory
- Adds `KabegameSqlExecutor` struct holding Arc<Mutex<Connection>>
- impl pathql_rs::SqlExecutor with dialect=Sqlite + execute() body unchanged

core/src/providers/init.rs: provider_runtime() now constructs
KabegameSqlExecutor and passes Arc<dyn SqlExecutor> to ProviderRuntime::new
(no more Option / new_with_executor).

Compile state: build CLEAN for kabegame-core; tests adjusted (S5).

Files: core/src/providers/{sql_executor.rs (rewritten), init.rs}
```

---

### S5. 测试套件修整 + 全套验证

#### S5a. pathql-rs 测试改造

- 4 个集成测试文件（`build_real_chain` / `dsl_dynamic_sqlite` / `dsl_full_chain_sqlite` / `runtime_real_sqlite`）：每个文件顶部加 `local_params_for` helper（S2 已规划）
- 4 个集成测试中所有 `runtime.new_with_executor(..., Some(exec))` → `runtime.new(..., exec)`；测试用 `ClosureExecutor::new(SqlDialect::Sqlite, |...| ...)` 构造 mock executor
- 单测：`provider/mod.rs` / `runtime.rs` 内 `EngineError::ExecutorMissing` 相关测试删除
- 新增单测（S1 工作量内但落 S5 跑）：
  - `closure_executor_dialect_sqlite_returns_sqlite`
  - `closure_executor_execute_calls_inner_fn`
  - `build_sql_postgres_uses_dollar_placeholder`
  - `build_sql_sqlite_uses_question_placeholder`
  - `build_sql_mysql_uses_question_placeholder`

#### S5b. core 测试改造

- core 内若有任何 `make_sql_executor(...)` 调用 → 改 `Arc::new(KabegameSqlExecutor::new(...))`
- IPC / Tauri command 测试不动（black-box 调 `provider_runtime()`）

#### S5c. 全套跑通

```bash
cargo build -p pathql-rs                                          # 主代码无 rusqlite
cargo build -p pathql-rs --features "json5 validate"              # 功能 feature
cargo test  -p pathql-rs --features "json5 validate"              # 单测
cargo test  -p pathql-rs --features "json5 validate" --test build_real_chain
cargo test  -p pathql-rs --features "json5 validate" --test dsl_dynamic_sqlite
cargo test  -p pathql-rs --features "json5 validate" --test dsl_full_chain_sqlite
cargo test  -p pathql-rs --features "json5 validate" --test runtime_real_sqlite
cargo build -p kabegame-core
cargo test  -p kabegame-core
bun check -c main --skip vue
```

#### S5d. 手测

```bash
bun dev -c main --data prod
# 浏览 /gallery/all/x100x/1/ → 列图正常
# 浏览 /vd/i18n-zh_CN/ → 列子目录
# 浏览 /gallery/all/x100x/3/ → 翻页正常 (动态 SQL via executor 仍跑)
```

⚠️ 重点验证：DSL 动态 list (page_size_provider 的 SQL list) 仍走通——因为 executor 路径是 6c 引入的核心路径，6d 只改了 trait 形态不该影响行为。

**Commit message**：
```
test(phase6d/S5): finalize 6d — all tests green, behavior unchanged

Test sweep:
- pathql-rs integration tests inline local_params_for (4 files)
- mock executors switched to ClosureExecutor::new(SqlDialect::Sqlite, ...)
- runtime constructions: new(...) replacing new_with_executor(..., Some)
- removed ExecutorMissing-related tests

Verifies:
- pathql-rs main builds without rusqlite (drivers/ + sqlite feature gone)
- pathql-rs all features green
- core builds + tests green
- bun check passes
- manual: /gallery/all/x100x/{1,3}/ + /vd/i18n-zh_CN/ paths render correctly

Phase 6d complete.
```

---

## 完成标准

- [ ] `cargo build -p pathql-rs` 干净（**无 rusqlite dep**）
- [ ] `cargo build -p pathql-rs --features "json5 validate"` 干净
- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿（含 4 个集成测试改造后）
- [ ] `cargo build -p kabegame-core` warning 清零
- [ ] `cargo test -p kabegame-core` 全绿（行为零回归）
- [ ] `bun check -c main --skip vue` 通过
- [ ] 全工程 `pathql_rs::drivers` 引用 0
- [ ] 全工程 `EngineError::ExecutorMissing` / `Option<SqlExecutor>` / `new_with_executor` / `make_sql_executor` 引用 0
- [ ] `pathql_rs::SqlExecutor` 是 trait（非 type alias）
- [ ] `pathql_rs::SqlDialect` enum 存在 + `executor.dialect()` 在 build_sql 渲染期被读取
- [ ] `pathql_rs::ClosureExecutor` 助手可用（测试代码已切到此形态）
- [ ] `core/src/storage/template_bridge.rs` 存在 + `pub(crate)` 私有
- [ ] 手测 dev server 浏览主路径行为不变（DSL 动态 list / 翻页 / VD i18n 都通）

## 风险点

1. **测试改造工作量被低估**：4 个集成测试 + 若干单测都在用 `params_for` 和 `Arc<Fn>` 闭包形态；S5 是 6d 最大工作量，单 commit 容易膨胀。**建议**：S5 内部按文件再拆 commit（一文件一 commit）但消息保持 `test(phase6d/S5)` 前缀
2. **drivers 删除是**不可逆**的**：第三方如果有自己的 lib 接 `pathql_rs::drivers::sqlite::params_for`（虽然目前应该 0 用户），删后无回退路径。**缓解**：6d 是 atomic 改造、文档明示、changelog 列出
3. **build_sql dialect 参数的扩散面**：grep 显示 build.rs 测试模块内有 ~10 处 `q.build_sql(&empty_ctx())` 调用要加 dialect 参数。每处加 `SqlDialect::Sqlite` 是一次性工作，但漏改一处编译会过不了
4. **`Postgres` placeholder 的累积位移**：build_sql 渲染期 push placeholder 时 `params.len() + 1` 给 Postgres 用 —— 但 placeholder 出现在多个嵌套渲染（render_template_sql / OFFSET / LIMIT / WHERE 等），位移计数必须由 build_sql 统一管理而非 render 内部局部计数。S1d 实现要点：把 placeholder push 集中到 `params.push() + sql.push_str(placeholder)` 的封装函数
5. **Sqlite executor 的方言契约误用**：core 端 `KabegameSqlExecutor::dialect()` 硬返 Sqlite；如果 core DB 改 Postgres / Mysql，**dialect() 也得改** —— 这是 executor 实现者的责任，6d 仅在 core 文档注释明示
6. **`KabegameSqlExecutor` 的 db 字段**：与 6c 旧 `make_sql_executor` 接的 `Arc<Mutex<Connection>>` 形态完全一致；构造期由 init.rs 取 `Storage::global().db.clone()`（或类似）。如 6c 改了这个生命周期模型（如 db 改 thread-local / pooled），需要相应调整
7. **删除 ExecutorMissing 后** `EngineError` 的 enum 变化是 breaking，但 EngineError 是 pathql-rs internal，前端 / Tauri command 看不见 → 影响仅限 core / pathql-rs 内部错误匹配代码

---

## 完成 6d 后的下一步

进入 **Phase 7+** 的工作集，6d 已为后续设计奠基：

- **sync/async feature 切换 trait 签名**：trait 形态已就位，加 `#[cfg(feature = "async")]` 分支 + 引入 `async-trait` 或 `maybe-async` crate；`ProviderRuntime::resolve / list / meta` 全改 `async fn`；DslProvider 内部 `.await` 与 sync 模式编译期切换
- **`sqlx_executor` feature**：内置 `SqlxExecutor` 持 `sqlx::AnyPool`；用户传 url 或 pool；自动 dialect 推断
- **多方言完整支持**：build_sql 的 Postgres / Mysql 路径完整测试覆盖；标识符引用 / DEFAULT 函数等差异
- **dangling DSL provider 补全**：[Phase 7] 写 17+ 个 .json5（gallery_albums_router / gallery_dates_router / vd_albums_provider 等）
- **typed-meta wire 验证**：S5bis-c 已建测试 baseline，Phase 7 的 typed meta DSL 实施时复用此测试结构
- **per-child total 计算**：Phase 7 决定是否给 Dir entry 加 total（每个 child 实例化下层 + count 是昂贵操作；可能改为 lazy / 只对 list 顶层算）
- **非 SQL executor 抽象**：Phase 7 接 VD `按画册 / 按插件` 等非 SQL 数据源时引入 `ResourceExecutor` 或主机回调通道（与 SqlExecutor 并列）
