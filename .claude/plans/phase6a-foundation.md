# Phase 6a 详细计划 — pathql-rs Provider 体系内核

## 重大架构调整（在 6a 启动前已锁定）

**Provider 体系移到 pathql-rs**——Provider trait、ChildEntry、ProviderRegistry 的编程注册接口、
ProviderRuntime 全部在 pathql-rs 内。core 退化为"业务领域类型 + Backend 实例化 + 终端集成"。

锁定的 spec（已写入 [RULES.md](../../cocs/provider-dsl/RULES.md) §12）：

- **§12.1 ChildEntry**：`{ name, provider?, meta? }` —— **无 `total` 字段**（数据库结果由 §12.5 单独接口提供）
- **§12.2 Provider 抽象操作**：`apply_query / list / resolve / get_note`，命名严格对齐 DSL 顶层字段
- **§12.3 ProviderRegistry 混合注册**：DSL ProviderDef + 编程 factory 共住一仓库；编程注册用 `register_provider(ns, name, factory)`，**factory 接受 properties 构造 provider 实例**
- **§12.4 延迟解析**：DSL 加载 + validate **不**强制 ProviderInvocation.provider 引用解析；运行期才查 registry，未命中 = path-not-found（cross-ref 检查变为可选 strict 模式）
- **§12.5 SQL 执行能力分级注入**：drivers/* 默认只做方言适配（bind 类型转换、占位符风格），**不**包 connection；query feature 才引入 sqlx 完整执行栈
- **`note:` 支持模板插值**（§6.2 / §12.2）

**额外简化（6a 起步先做）**：
- **删除 `compose` feature**：现有 compose feature 实际上 0 外部 dep（只是把 ProviderQuery / fold / build_sql / template eval 这些纯 Rust 代码 cfg-gate）；feature 只增使用方心智负担。Phase 6a 起所有上述模块**默认编译**。剩余 feature 仅 `json5` / `validate` / `sqlite`（将来加 `query` 启 sqlx）。
- **ctx-passing 替代 Weak<Runtime>**：Provider trait 方法都接受 `&ProviderContext` 参数；ctx 含 `Arc<ProviderRegistry> + Arc<ProviderRuntime>`，由 runtime 在每次入口调用时构造，方法返回后 drop。**所有 Provider 实现（DSL / 编程 / 路由壳）都不持 runtime / registry 字段**，状态最小化、无循环引用。runtime 内部持 `Weak<Self>` 供 ctx 构造时 upgrade。

---

## Context

承接 Phase 5 完成态：pathql-rs 含 AST + Loader + Registry + Validate + ProviderQuery + fold + build_sql + sqlite 方言适配。
adapters 已拆为 `loaders/` + `drivers/`。351 测试全过。

Phase 6a 目标：**pathql-rs 内**新增 Provider 体系内核——Provider trait、ChildEntry、ProviderRuntime、
扩展 ProviderRegistry 支持编程 factory 注册 + 延迟解析。**DslProvider 仅做静态部分**（apply_query 折叠 + 静态 list + regex resolve）；动态 list SQL 项 / meta SQL 求值依赖执行能力，留给 6b/6c。

**6a 测试策略**：**只用编程 provider**（`register_provider` 注册 factory），**不**测 DSL provider 端到端。
这样能在没有 SQL 执行栈的前提下验证 ProviderRuntime 的路径解析逻辑、缓存、命名空间链查找、回调机制。

约束：
- 本期**全部**改动在 pathql-rs 内；core 完全不动
- 不引入新外部 dep（不引 sqlx，不引 lru crate—— pathql-rs 已经能用 `std` 或现有依赖搞定）
- Provider trait + Runtime 都在 `compose` feature 下编译（依赖 ProviderQuery）
- 每个子任务后立即 `cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿

---

## 锁定的设计选择

1. **删除 `compose` feature**（重大调整）：现有 `compose` feature 实际上 0 外部 dep（compose / template / provider 模块只用 serde / serde_json / thiserror，已是基础依赖）；feature 只是徒增使用方心智负担。**6a 起步就把 compose feature 删掉**，所有 ProviderQuery / fold / build_sql / template eval / Provider trait / Runtime / DslProvider 全部**默认编译**。剩下的 feature 只有 `json5` / `validate` / `sqlite`（后者将来加 `query` 启 sqlx）。
2. **Provider trait + Runtime 默认可用**：`register_provider` 无需任何 feature 开关；任何 pathql-rs 用户拿到 crate 就能用
3. **新模块路径**：在 pathql-rs 顶层新建 `provider/` 模块（与 ast/compose/template/loaders/drivers 平级；**无** feature gate）
   - `provider/mod.rs` —— `Provider` trait + `ChildEntry` + `EngineError` 直接定义在 mod.rs（不另起 trait_def.rs；类型不多，单文件清爽）
   - `provider/dsl_provider.rs` —— `DslProvider` impl Provider
   - `provider/runtime.rs` —— `ProviderRuntime` 路径解析 + 缓存
3. **Registry 扩展不引新模块**：在现有 `registry.rs` 内加 `RegistryEntry` enum（`Dsl(...)` / `Programmatic(...)`）+ 新方法 `register_provider(ns, name, factory)`；保持 namespace 链查找逻辑统一
4. **Provider trait 签名（ctx-passing）**：

```rust
pub struct ProviderContext {
    pub registry: Arc<ProviderRegistry>,
    pub runtime: Arc<ProviderRuntime>,
}

pub trait Provider: Send + Sync {
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery { current }
    fn list(&self, composed: &ProviderQuery, ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError>;
    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>>;
    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> { None }
    fn is_empty(&self) -> bool { false }
}
```

`ctx.runtime` 是 `Arc<ProviderRuntime>`（**不是 Weak**）——由 runtime 内部持有的 `Weak<Self>` 在 resolve 入口 upgrade 后塞入；ctx 在调用栈生命周期内持 Arc，方法返回后 drop，**不形成循环**。

Provider 实现**不持 runtime / registry 字段**：所有需要它们的地方都从 ctx 取。这让 DslProvider 与编程 router 都极简（基本只持自己的 def / properties / config）。

5. **ChildEntry 结构**：

```rust
pub struct ChildEntry {
    pub name: String,
    pub provider: Option<Arc<dyn Provider>>,
    pub meta: Option<serde_json::Value>,
}
```

6. **EngineError**：新枚举，含 PathNotFound / ProviderNotFound / FoldError / RenderError 等运行期错误形态
7. **factory 签名（极简版）**：`Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError> + Send + Sync + 'static`
   - 接受实例化属性表（路径折叠时 ProviderInvocation.properties 求值后传入）
   - 返回构造好的 Provider；因为 properties 可能不完整 / 类型不对，允许 factory 失败
   - **不带 ctx 参数**——因为 Provider 实例不持 runtime / registry，构造时也不需要它们
8. **ProviderRuntime 路径解析算法（longest-prefix cache lookup）**：
   - normalize 路径：percent-decode；**不**做 lowercase 折叠（§2 大小写敏感）
   - 缓存键 = normalized 完整路径前缀串（如 `/a` / `/a/b` / `/a/b/c`）；值 = `(Arc<dyn Provider>, ProviderQuery)`
   - **lookup 阶段**：从最长前缀（完整路径本身）开始向短回退，逐段试缓存。第一次命中即为 longest cached prefix；从该点续 fold。
     - 命中 prefix_len == segments.len()：完整路径已缓存，直接返回
     - 命中 prefix_len < segments.len()：从该前缀的 (provider, composed) 起，继续 resolve 剩余段
     - 全 miss（含根）：cold start，从 root.apply_query(empty) 起 fold 全程
   - **写入阶段**：fold 过程中每段成功 apply_query 后写入对应前缀路径的缓存（命中 ByName/ByDelegate；命中 EmptyInvocation 跳过；fold 失败不写）
   - **性能优势**：典型路径共享前缀（`/gallery/all/x100x/1` vs `/gallery/all/x100x/2` 共享 `/gallery/all/x100x`）；longest-prefix 命中省下重复 apply_query 工作；最坏情况（无共享）退化为 cold start
   - LRU 实现：`std::collections::HashMap`（6a 简化版，无大小限制）；后期可换正经 LRU 不影响接口
   - EmptyInvocation 识别：Provider trait 加 `fn is_empty(&self) -> bool { false }`；编程 provider 默认 false；DSL 的 EmptyInvocation 占位 override 为 true；runtime 见 true 时跳过缓存写入
   - fail-fast init：构造 ProviderRuntime 时若 root provider 在 registry 中不存在 → Err
9. **DslProvider 在 6a 的范围**：
   - apply_query: 完整支持（Contrib fold + Delegate 通过 runtime 重定向）
   - list: 仅静态项；动态 SQL / 动态 delegate 留 placeholder（返回空 vec 并打 log warning）
   - resolve: regex resolve + 静态 list 字面；动态反查留 placeholder
   - get_note: 用 template 渲染 note 字段（无求值上下文需求时直返字面）

---

## 测试节奏

每子任务后：`cargo test -p pathql-rs --features "json5 validate sqlite"` 全套跑一遍；351 + 新增测试 全绿才进下一步。

---

## 子任务拆解

### Spre. 删除 `compose` feature gate（最先做，让后续 S0–S6 基于干净状态）

修改 `pathql-rs/Cargo.toml`：

```toml
[features]
default = []
json5 = ["dep:json5"]
validate = ["dep:regex", "dep:regex-automata", "dep:sqlparser"]
# compose = []      ← 删除
sqlite = ["dep:rusqlite"]   ← 不再依赖 compose
```

删除以下文件中的 `#![cfg(feature = "compose")]` 行：
- `src/compose/mod.rs`
- `src/compose/build.rs`
- `src/compose/render.rs`
- `src/template/eval.rs`
- 其他 compose 子模块（aliases / fold / order / query 现有 cfg gate 都删）

修改 `lib.rs`：去掉 `#[cfg(feature = "compose")]` 把 provider 模块声明无条件；compose 模块也无条件 `pub mod compose;`。

修改 `tests/build_real_chain.rs`：去掉 `#![cfg(all(feature = "json5", feature = "compose", feature = "sqlite"))]` 中的 `compose`（保留 json5 + sqlite）。

drivers/sqlite.rs 中如果有 cfg(feature = "compose") 引用 TemplateValue 的，删掉 cfg 条件。

**验证**：

```bash
cargo test -p pathql-rs                        # 默认 feature = []
cargo test -p pathql-rs --features json5
cargo test -p pathql-rs --features validate
cargo test -p pathql-rs --features sqlite
cargo test -p pathql-rs --features "json5 validate sqlite"
```

全部全绿；现 351 测试一条不少。

**Test**：上述五条命令各跑一次。

---

### S0. ProviderQuery raw-bind API（在 `compose/query.rs` + `compose/build.rs`）

修改 `compose/query.rs` 给 `ProviderQuery` 加：

```rust
pub struct ProviderQuery {
    // ... 现有字段
    pub adhoc_properties: HashMap<String, TemplateValue>,
    pub(crate) adhoc_counter: u32,
}

impl ProviderQuery {
    fn intern_raw(&mut self, sql: &str, params: &[TemplateValue]) -> SqlExpr {
        // 把 ? 替换为 ${properties.__pq_raw_N}, params 注册进 adhoc_properties
        // 实现细节见前期 6a 草案 (代码骨架不变)
    }

    pub fn with_where_raw(self, sql: &str, params: &[TemplateValue]) -> Self;
    pub fn with_join_raw(self, kind: JoinKind, table: &str, alias: &str, on: Option<&str>, params: &[TemplateValue]) -> Result<Self, FoldError>;
    pub fn with_order_raw(self, expr: &str, dir: OrderDirection) -> Self;
    pub fn prepend_order_raw(self, expr: &str, dir: OrderDirection) -> Self;
    pub fn with_field_raw(self, sql: &str, alias: Option<&str>, params: &[TemplateValue]) -> Self;
}
```

修改 `compose/build.rs::build_sql`：构造 effective TemplateContext 时合并 adhoc_properties 到 ctx.properties（adhoc 覆盖优先）。

**为什么 6a 需要这个**：6b 期间硬编码 provider 全部迁移到 ProviderQuery 时要用；先在 6a 做完，6b 才能一气切。本期 raw API 自身也作为 6a S6 测试中编程 provider 实例的常用工具。

**测试要点**（compose/query.rs + compose/build.rs 内 `#[cfg(test)]`）：
- `with_where_raw_simple` / `with_where_raw_multi_params` / `with_where_raw_count_mismatch_panic`
- `with_join_raw_simple` / `with_join_raw_dedup` / `with_join_raw_with_table_subquery_param`
- `with_order_raw_simple` / `with_order_raw_overwrite` / `prepend_order_raw_inserts_at_head`
- `with_field_raw_no_alias` / `with_field_raw_with_alias`
- `build_sql_merges_adhoc_into_ctx` / `build_sql_adhoc_overrides_ctx`

**Test**：现 351 + ~14 = ~365 全绿。

---

### S1. provider 模块根 + ChildEntry + Provider trait + EngineError（`provider/mod.rs`）

类型定义都直接在 `provider/mod.rs`，不另起 `trait_def.rs`——本期类型不多，单文件清爽。子模块（`dsl_provider` / `runtime`）后续子任务才填。

新建 `pathql-rs/src/provider/mod.rs`：

```rust
//! pathql Provider 体系内核 (RULES §12)。
//!
//! 本 mod 含 Provider trait + ChildEntry + EngineError 定义。
//! - DslProvider 在 dsl_provider 子模块
//! - ProviderRuntime 在 runtime 子模块

pub mod dsl_provider;
pub mod runtime;

pub use dsl_provider::DslProvider;
pub use runtime::{ProviderRuntime, ResolvedNode};

use std::sync::Arc;
use thiserror::Error;
use crate::compose::{ProviderQuery, FoldError, RenderError, BuildError};
use crate::ProviderRegistry;

/// 调用 Provider 方法时由 runtime 在入口构造并向下传递。
/// 同一 ctx 在路径解析的整个 fold loop 中复用; 方法返回后 drop。
pub struct ProviderContext {
    pub registry: Arc<ProviderRegistry>,
    pub runtime: Arc<ProviderRuntime>,  // 由 runtime 的 Weak<Self> 在入口 upgrade 而来
}

#[derive(Debug, Clone)]
pub struct ChildEntry {
    pub name: String,
    pub provider: Option<Arc<dyn Provider>>,
    pub meta: Option<serde_json::Value>,
}

pub trait Provider: Send + Sync {
    /// 折叠 ProviderQuery。
    /// DelegateQuery 通过 ctx.runtime 重定向; ContribQuery 走 fold_contrib。
    fn apply_query(&self, current: ProviderQuery, _ctx: &ProviderContext) -> ProviderQuery {
        current
    }

    /// 枚举所有可见子节点。
    fn list(&self, composed: &ProviderQuery, ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError>;

    /// 给定段名定位单个子 provider。语义按 §5.2 (regex resolve → 静态 list 字面 → 动态反查)。
    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>>;

    /// 自描述文本 (§12.2; note: 字段, 支持 ${properties.X} 等模板)。
    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> {
        None
    }

    /// EmptyInvocation 占位识别 (§12.3 + §4.4 缓存契约)。
    /// runtime 见 true 时跳过缓存写入。
    fn is_empty(&self) -> bool {
        false
    }
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("path not found: `{0}`")]
    PathNotFound(String),
    #[error("provider `{0}.{1}` not registered")]
    ProviderNotRegistered(String, String),
    #[error("fold error: {0}")]
    Fold(#[from] FoldError),
    #[error("render error: {0}")]
    Render(#[from] RenderError),
    #[error("build error: {0}")]
    Build(#[from] BuildError),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("factory failed for `{0}.{1}`: {2}")]
    FactoryFailed(String, String, String),
}
```

更新 `lib.rs`：

```rust
pub mod ast;
pub mod compose;
pub mod drivers;
pub mod loader;
pub mod loaders;
pub mod provider;
pub mod registry;
pub mod template;

#[cfg(feature = "validate")]
pub mod validate;

pub use ast::*;
pub use loader::{LoadError, Loader, Source};
pub use provider::{ChildEntry, EngineError, Provider, ProviderContext, ProviderRuntime};
pub use registry::{ProviderRegistry, RegistryError};

#[cfg(feature = "json5")]
pub use loaders::Json5Loader;
```

**测试要点**：纯类型定义；
- 一个 `mock` impl Provider 的 unit 测试（在 `provider/mod.rs` 内 `#[cfg(test)]` 块）确认 trait 方法签名（含 ctx 参数）能编译并工作；mock 不用 ctx 字段，仅以 `_ctx` 命名占位
- `ChildEntry { ... }` 构造 + Clone + Debug 一例
- `EngineError` 各 variant Display 检查
- `ProviderContext` 构造一例（仅类型层，不需真 runtime）

**Test**：`cargo test -p pathql-rs provider::tests`（mod.rs 内的 #[cfg(test)] mod；默认 feature 即可）。

---

### S2. ProviderRegistry 扩展支持编程注册（`registry.rs`）

修改 `registry.rs`：

```rust
use std::sync::Arc;
use std::collections::HashMap;
use crate::ast::{Namespace, ProviderName, SimpleName, ProviderDef};
use crate::template::eval::TemplateValue;
use crate::provider::{Provider, EngineError, ProviderContext, DslProvider};

/// 工厂回调: 接受实例化属性表, 构造 Provider 实例。
/// **不带 ctx 参数**——provider 实例不持 runtime/registry 字段, 构造时无需它们;
/// 方法调用时由 runtime 通过 ctx 注入。
pub type ProviderFactory = Arc<
    dyn Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError>
        + Send
        + Sync
        + 'static
>;

pub enum RegistryEntry {
    Dsl(Arc<ProviderDef>),
    Programmatic(ProviderFactory),
}

#[derive(Debug, Default)]
pub struct ProviderRegistry {
    defs: HashMap<(Namespace, SimpleName), RegistryEntry>,
}

impl ProviderRegistry {
    pub fn new() -> Self { Self::default() }

    /// 注册 DSL provider def。
    pub fn register(&mut self, def: ProviderDef) -> Result<(), RegistryError> {
        let ns = def.namespace.clone().unwrap_or_else(|| Namespace(String::new()));
        let key = (ns.clone(), def.name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(key.0, key.1));
        }
        self.defs.insert(key, RegistryEntry::Dsl(Arc::new(def)));
        Ok(())
    }

    /// 注册编程 provider (RULES §12.3): factory 接收 properties, 返回 Provider 实例。
    pub fn register_provider<F>(&mut self, namespace: Namespace, name: SimpleName, factory: F) -> Result<(), RegistryError>
    where F: Fn(&HashMap<String, TemplateValue>) -> Result<Arc<dyn Provider>, EngineError> + Send + Sync + 'static
    {
        let key = (namespace.clone(), name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(namespace, name));
        }
        self.defs.insert(key, RegistryEntry::Programmatic(Arc::new(factory)));
        Ok(())
    }

    /// Java 包风格父链查找。
    pub fn lookup(&self, current_ns: &Namespace, reference: &ProviderName) -> Option<&RegistryEntry> {
        let (ref_ns, simple) = reference.split();
        if let Some(abs_ns) = ref_ns {
            return self.defs.get(&(abs_ns, simple));
        }
        let mut ns_opt = Some(current_ns.clone());
        while let Some(ns) = ns_opt {
            if let Some(found) = self.defs.get(&(ns.clone(), simple.clone())) {
                return Some(found);
            }
            ns_opt = ns.parent();
        }
        self.defs.get(&(Namespace(String::new()), simple))
    }

    /// **统一的 provider 实例化入口** (供 runtime / 其他 provider 在 resolve 时用)。
    /// 命中 DSL 项 → 构造 DslProvider; 命中 Programmatic 项 → 调 factory。
    /// `_ctx` 当前签名占位但暂未使用——保留供将来 DSL 实例化期需要 runtime 时扩展。
    pub fn instantiate(
        &self,
        current_ns: &Namespace,
        reference: &ProviderName,
        properties: &HashMap<String, TemplateValue>,
        _ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        match self.lookup(current_ns, reference)? {
            RegistryEntry::Programmatic(factory) => factory(properties).ok(),
            RegistryEntry::Dsl(def) => Some(Arc::new(DslProvider {
                def: def.clone(),
                properties: properties.clone(),
            })),
        }
    }

    /// 历史 API: 返回 DSL ProviderDef Arc (向后兼容; programmatic 项返回 None)
    pub fn resolve(&self, current_ns: &Namespace, reference: &ProviderName) -> Option<Arc<ProviderDef>> {
        match self.lookup(current_ns, reference)? {
            RegistryEntry::Dsl(def) => Some(def.clone()),
            RegistryEntry::Programmatic(_) => None,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&(Namespace, SimpleName), &RegistryEntry)> {
        self.defs.iter()
    }

    pub fn len(&self) -> usize { self.defs.len() }
    pub fn is_empty(&self) -> bool { self.defs.is_empty() }
}
```

⚠️ 旧版 `iter()` 返回的是 `&Arc<ProviderDef>`，现在改 `&RegistryEntry`。**会破坏调用 iter 的代码**——主要是 `validate` 模块。要在本步同时改 validate 让它处理 RegistryEntry 两态：DSL 项跑校验逻辑；Programmatic 项**跳过**（编程 provider 由终端自负责正确性，不在 spec 校验范围）。

**测试要点**（`registry.rs` 内 `#[cfg(test)]`）：
- `register_provider_simple`：编程注册一个 dummy factory，`lookup(ns, name)` 返回 Programmatic
- `register_provider_duplicate_with_dsl`：先 register DSL 再 register_provider 同名 → Duplicate
- `register_provider_duplicate_with_programmatic`：先 register_provider 再 register_provider 同名 → Duplicate
- `register_provider_namespace_chain`：current_ns=`a.b.c`，ref=`foo`，注册 `a.foo` 编程项 → 命中
- `iter_yields_both_kinds`：注册 1 DSL + 1 programmatic → iter 顺序无关，count=2，两态都出现
- `resolve_old_api_returns_none_for_programmatic`：编程项不能从老 `resolve` 拿到 ProviderDef

**validate 模块更新**：
- 在每个遍历 registry 的 validator (cross_ref, names, query_refs, etc.) 中，仅对 `RegistryEntry::Dsl` 走原校验逻辑；遇 Programmatic 跳过（不 panic 不 warn）
- cross_ref 已默认 off（策略 §12.4），开启时跳过 programmatic 引用是正确行为（编程项不要求 DSL 引用约束）

**Test**：`cargo test -p pathql-rs --features validate`；现有 validate 测试 0 回归 + 新增 ~6 registry 测试。

---

### S3. DslProvider 静态部分（`provider/dsl_provider.rs`）

```rust
use std::collections::HashMap;
use std::sync::Arc;
use crate::ast::{ProviderDef, Query, ListEntry, ProviderInvocation};
use crate::compose::{fold_contrib, ProviderQuery};
use crate::template::eval::TemplateValue;
use super::{ChildEntry, EngineError, Provider, ProviderContext};

/// DSL provider 实例。**不持 registry / runtime 字段**——所有外部状态由 ctx 注入。
pub struct DslProvider {
    pub def: Arc<ProviderDef>,
    pub properties: HashMap<String, TemplateValue>,
}

impl Provider for DslProvider {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery {
        match &self.def.query {
            None => current,
            Some(Query::Contrib(q)) => {
                let mut state = current;
                if let Err(_e) = fold_contrib(&mut state, q) {
                    // log error; 返回原 state 不 panic
                }
                state
            }
            Some(Query::Delegate(d)) => {
                ctx.runtime
                    .resolve_with_initial(&d.delegate.0, Some(current.clone()))
                    .map(|node| node.composed)
                    .unwrap_or(current)
            }
        }
    }

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
                ListEntry::Dynamic(_) => {
                    // 6a 范围: 动态 list 项需要 SQL 执行能力, 推迟到 6c (含 executor 注入)
                    // 这里返回 placeholder; 不报错 (避免空 list 被当成错误)
                    log::warn!("DslProvider {:?}: dynamic list entries deferred to 6c+", self.def.name);
                }
            }
        }
        Ok(out)
    }

    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        // 1. resolve.entries (regex)
        if let Some(resolve) = &self.def.resolve {
            for (pattern, invocation) in &resolve.0 {
                if let Ok(re) = regex::Regex::new(pattern) {
                    if let Some(captures) = re.captures(name) {
                        return self.instantiate_invocation(invocation, &captures, composed, ctx);
                    }
                }
            }
        }
        // 2. 静态 list 字面
        if let Some(list) = &self.def.list {
            for (key, entry) in &list.entries {
                if key == name {
                    if let ListEntry::Static(inv) = entry {
                        return self.instantiate_invocation_no_capture(inv, composed, ctx);
                    }
                }
            }
            // 3. 动态反查推迟到 6c
        }
        None
    }

    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> {
        // note 字段含 ${properties.X} 时用 render 渲染 (调 6a S0 的 render_template_to_string)
        // 简化版: 字面字符串直返; 含 ${ 时调 render
        let raw = self.def.note.as_ref()?;
        if !raw.contains("${") {
            return Some(raw.clone());
        }
        // 用 render_template_to_string 渲染 (本地 ctx 用 self.properties)
        let mut tctx = crate::template::eval::TemplateContext::default();
        tctx.properties = self.properties.clone();
        // ... render_template_to_string(raw, &tctx)
        // 返回渲染后字符串
        todo!() // 实现期补
    }
}

impl DslProvider {
    fn instantiate_invocation(&self, _inv: &ProviderInvocation, _captures: &regex::Captures, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        todo!() // 6a 实现: 命名 provider 通过 ctx.registry.instantiate 实例化; delegate 通过 ctx.runtime 解析
    }

    fn instantiate_invocation_no_capture(&self, _inv: &ProviderInvocation, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        todo!()
    }

    fn materialize_static(&self, _key: &str, _inv: &ProviderInvocation, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Result<Option<ChildEntry>, EngineError> {
        // ProviderInvocation 三态实例化, 构造 ChildEntry
        // 注意: meta 字段执行需要 SQL 执行能力, 6a 简化为只支持非 SQL meta (string template / object 形态)
        todo!()
    }
}

/// EmptyInvocation 占位 provider, runtime 见 is_empty() == true 时跳过缓存。
pub struct EmptyDslProvider;

impl Provider for EmptyDslProvider {
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> { Ok(Vec::new()) }
    fn resolve(&self, _: &str, _: &ProviderQuery, _: &ProviderContext) -> Option<Arc<dyn Provider>> { None }
    fn is_empty(&self) -> bool { true }
}
```

⚠️ 6a S3 写出 DslProvider 的**结构**和**静态部分功能**；动态 list / 动态反查 / SQL meta 求值留 placeholder。
DslProvider 的 instantiate_invocation 等需要 ProviderRegistry 支持——同样 6a 范围只做命名 provider（DSL 项 + Programmatic 项混合查找），delegate 路径走 runtime。

**测试要点**：
- `dsl_provider_apply_contrib`：构造 DslProvider 持简单 ContribQuery，apply_query → fold 正确
- `dsl_provider_apply_delegate_via_runtime`：mock runtime（用一个 trait helper）→ Delegate 走 resolve_with_initial
- `dsl_provider_list_static_only`：def 含静态 list 3 项 → 返回 3 个 ChildEntry
- `dsl_provider_list_dynamic_warns_returns_empty_for_now`：def 含动态项 → 返回空 vec + log warning
- `dsl_provider_resolve_regex_match`：def 有 `resolve = {"^x([0-9]+)$": ByName("foo", {n: "${capture[1]}"})}`，name="x100" → 命中
- `dsl_provider_resolve_static_match`：static list 字面命中
- `dsl_provider_resolve_all_miss`：三种都未命中 → None
- `dsl_provider_get_note_literal` / `dsl_provider_get_note_interpolated`：note 含 ${properties.X} → 渲染后返回
- `empty_provider_is_empty_true`：EmptyDslProvider.is_empty() == true

**Test**：`cargo test -p pathql-rs provider::dsl_provider`（默认 feature）。

---

### S4. ProviderRuntime 路径解析（`provider/runtime.rs`，含 longest-prefix cache lookup）

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use crate::compose::ProviderQuery;
use std::sync::Weak;
use crate::ProviderRegistry;
use super::{ChildEntry, EngineError, Provider, ProviderContext};

pub struct ResolvedNode {
    pub provider: Arc<dyn Provider>,
    pub composed: ProviderQuery,
}

#[derive(Clone)]
struct CachedNode {
    provider: Arc<dyn Provider>,
    composed: ProviderQuery,
}

pub struct ProviderRuntime {
    registry: Arc<ProviderRegistry>,
    root: Arc<dyn Provider>,
    /// Weak self 用于 ctx 构造时 upgrade; ctx 持 Arc 在调用栈期间存活, 方法返回后 drop。
    weak_self: Weak<Self>,
    /// 缓存: 路径前缀 (如 "/a", "/a/b", "/a/b/c") → CachedNode。
    /// 路径段串接 normalized 后作 key。
    /// 6a 用 HashMap; 后期可换 lru crate。容量目前不限制。
    cache: Mutex<HashMap<String, CachedNode>>,
}

impl ProviderRuntime {
    /// 构造 runtime; 用 Arc::new_cyclic 让自身持 Weak<Self> 供 ctx 构造时 upgrade。
    pub fn new(registry: Arc<ProviderRegistry>, root: Arc<dyn Provider>) -> Arc<Self> {
        Arc::new_cyclic(|weak| Self {
            registry,
            root,
            weak_self: weak.clone(),
            cache: Mutex::new(HashMap::new()),
        })
    }

    /// 在 resolve / list / note 入口构造 ctx。ctx 持 Arc<Self>, 不形成长期循环引用。
    fn make_ctx(&self) -> ProviderContext {
        ProviderContext {
            registry: self.registry.clone(),
            runtime: self.weak_self.upgrade()
                .expect("ProviderRuntime weak_self upgrade failed (runtime dropped during call?)"),
        }
    }

    /// 顶层路径解析 (§12.5)。
    pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
        self.resolve_with_initial(path, None)
    }

    /// 指定可选起点 ProviderQuery 的解析。
    /// - `initial = None` 走标准路径 (含 longest-prefix cache lookup)
    /// - `initial = Some(state)` 跳过缓存, 从给定 state cold-start fold (DslProvider DelegateQuery 用)
    pub fn resolve_with_initial(
        &self,
        path: &str,
        initial: Option<ProviderQuery>,
    ) -> Result<ResolvedNode, EngineError> {
        let segments = self.normalize_path(path);
        let ctx = self.make_ctx();

        // === Longest-prefix cache lookup ===
        // 仅 initial == None 时启用; 否则强制 cold start (调用方明确要从给定 state 起)
        let (start_idx, mut current, mut composed) = if initial.is_none() {
            self.find_longest_cached_prefix(&segments, &ctx)
        } else {
            let q = initial.unwrap();
            let q = self.root.apply_query(q, &ctx);
            (0, self.root.clone(), q)
        };

        // === 早退: 完整路径已缓存 ===
        if start_idx == segments.len() {
            return Ok(ResolvedNode { provider: current, composed });
        }

        // === Resume / cold-start: 从 start_idx 续 fold 剩余段 ===
        let mut path_so_far = build_path_key(&segments[..start_idx]);
        for seg in &segments[start_idx..] {
            path_so_far.push('/');
            path_so_far.push_str(seg);
            let next = current.resolve(seg, &composed, &ctx)
                .ok_or_else(|| EngineError::PathNotFound(path_so_far.clone()))?;
            composed = next.apply_query(composed, &ctx);
            current = next;
            // 缓存策略 (§4.4): 命中非 Empty → 写入; Empty → 跳过 (recompute 成本低)
            if !current.is_empty() {
                self.cache.lock().unwrap().insert(
                    path_so_far.clone(),
                    CachedNode { provider: current.clone(), composed: composed.clone() },
                );
            }
        }

        Ok(ResolvedNode { provider: current, composed })
    }

    /// 从最长前缀向短回退, 找到第一个缓存命中点。
    /// 返回 (起点 segment 索引, 起点 provider, 起点 composed)。
    /// - prefix_len=N (== segments.len()) → 完整路径已缓存
    /// - prefix_len=K (0<K<N) → 命中 /seg₁/.../segₖ 缓存, 续 fold segₖ₊₁..
    /// - prefix_len=0 → 全 miss, cold start (从 root 起 fold)
    fn find_longest_cached_prefix(&self, segments: &[String], ctx: &ProviderContext) -> (usize, Arc<dyn Provider>, ProviderQuery) {
        let cache = self.cache.lock().unwrap();
        // 从最长前缀向短试; 命中即 break
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

    /// 顶层 list 入口 (§12.5)。
    pub fn list(&self, path: &str) -> Result<Vec<ChildEntry>, EngineError> {
        let node = self.resolve(path)?;
        node.provider.list(&node.composed, &self.make_ctx())
    }

    /// 顶层 get_note 入口 (§12.2)。
    pub fn note(&self, path: &str) -> Result<Option<String>, EngineError> {
        let node = self.resolve(path)?;
        Ok(node.provider.get_note(&node.composed, &self.make_ctx()))
    }

    /// 路径段 normalize: percent-decode, 不做 lowercase 折叠 (§2)。
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

    pub fn registry(&self) -> &ProviderRegistry {
        &self.registry
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
```

需新增依赖 `percent-encoding`（轻量 crate）：

```toml
[dependencies]
percent-encoding = { workspace = true }
```

如 workspace 没有，加进根 Cargo.toml：`percent-encoding = "2"`。

**测试要点**（`provider/runtime.rs` 内 `#[cfg(test)]` + `tests/programmatic_runtime.rs` 集成）：

构造一个最小 mock setup：
- `LiteralProvider` impl Provider —— 直接持 `Vec<ChildEntry>` + `from_table` 字符串；apply_query 设 from；list 返回 children；resolve 字面查 children
- 用 `register_provider` 注册 root + 3 层嵌套 provider；factory 接受 properties 但不用

| 测试名 | 行为 | 期望 |
|---|---|---|
| `runtime_resolves_root` | `resolve("/")` | 返回 root provider |
| `runtime_resolves_one_level` | `resolve("/a")` | 命中 root → resolve("a") → child provider |
| `runtime_resolves_three_levels` | `resolve("/a/b/c")` | composed.from = "leaf_table" |
| `runtime_path_not_found` | `resolve("/a/missing")` | `EngineError::PathNotFound("/a/missing")` |
| `runtime_caches_hits` | `resolve("/a/b")` 两次 | 第二次命中缓存（cache_size > 0；构造时 mock counter 验证） |
| `runtime_does_not_cache_miss` | resolve 失败路径 | cache_size 不变 |
| `runtime_does_not_cache_empty_invocation` | 用 `EmptyDslProvider` 链路 | 该段不进 cache |
| `runtime_case_sensitive` | `/a/B` vs `/a/b`，B 未注册 | B 路径 PathNotFound（大小写不折叠） |
| `runtime_list_works` | `runtime.list("/a")` | 返回 a 的 children |
| `runtime_note_works` | `runtime.note("/a")` | 返回 a 的 note |
| `runtime_resolve_with_initial_for_delegate` | DslProvider DelegateQuery 重定向场景 | `resolve_with_initial(target, Some(parent_composed))` 把 parent_composed 当起点 fold |

**Longest-prefix cache lookup 专项测试**（用 mock provider 内置调用计数器验证 apply_query 调用次数）：

| 测试名 | 场景 | 期望 |
|---|---|---|
| `longest_prefix_full_path_hit_zero_apply` | resolve `/a/b/c` 两次 | 第二次 apply_query 调用次数 = 0（完整路径直返） |
| `longest_prefix_partial_hit_resumes` | 先 resolve `/a/b` 写入缓存; 再 resolve `/a/b/c` | 第二次仅 apply_query 1 次（c 段, b 之前的工作复用缓存） |
| `longest_prefix_finds_longest_not_first` | 先 resolve `/a` 与 `/a/b` (写入两段缓存); 再 resolve `/a/b/c` | 命中 `/a/b` (longer) 而非 `/a`; 仅 apply_query 1 次 |
| `longest_prefix_cold_start_when_no_cache` | 全新 runtime resolve `/a/b/c` | apply_query 调用 4 次（root + a + b + c） |
| `longest_prefix_sibling_paths_share_root` | resolve `/a/b/c1` 后 resolve `/a/b/c2` | 第二次仅 apply_query 1 次（c2 段, /a/b 前缀复用） |
| `longest_prefix_cache_invalidates_after_clear` | resolve `/a/b` 命中后 `clear_cache` 再 resolve `/a/b` | 第二次 apply_query 调用次数 = cold start 数 |

**Test**：`cargo test -p pathql-rs provider::runtime`（默认 feature）。

---

### S5. DslProvider materialize / instantiate helpers 收尾（`provider/dsl_provider.rs`）

S3 留了 `materialize_static` / `instantiate_invocation` 等的 todo。本步把它们填完。

`materialize_static`：处理 ProviderInvocation 三态：
- InvokeByName → 查 registry，命中 DSL 项构造新 DslProvider；命中 Programmatic 项调 factory 传 properties；
- InvokeByDelegate → 通过 runtime resolve(delegate path) 取末端 provider；
- Empty → 用 `Arc::new(EmptyDslProvider)`

注意 properties 求值：
- 有 capture context 时用之，无则空
- 用 render_to_owned 把每个 properties 字符串渲染（含 ${properties.X} 等）
- 6a 因为 DB 执行能力还没接上，meta 字段做最小处理：
  - 字符串纯模板 → render 后包成 `Some(JsonValue::String(rendered))`
  - 对象 / 数组 → 递归 render 内嵌字符串字段
  - **SQL 字符串 → 6a 返回 None + log warning**（不执行）

`instantiate_invocation`：
- ByName(name, props) → registry.lookup → 实例化（同 materialize_static 内部逻辑，properties 渲染时用 captures）
- ByDelegate(path) → runtime.resolve_with_initial(path, current_composed) → node.provider
- Empty → `Arc::new(EmptyDslProvider)`

`get_note` 收尾：用 render_to_owned 渲染 note 字段（先 render 把 ${properties.X} 替换为 ?，立即从 properties 读值替换文本）。

⚠️ 注意：note 的 render 要能产纯字符串，不带 `?` 占位（meta 等也类似）——这与 SQL 渲染不同，是另一种"纯字符串模板渲染"。可以加一个新 helper `render_template_to_string(template, ctx) -> Result<String, RenderError>` 在 compose/render.rs，专做字符串拼装（遇变量直接 `match value` 转字符串）。

**测试要点**：
- `materialize_static_byname_dsl_target` / `materialize_static_byname_programmatic_target`
- `materialize_static_bydelegate` (mock runtime)
- `materialize_static_empty`
- `materialize_static_meta_string_template`：meta = `"id: ${properties.x}"` → meta = JsonValue::String("id: 42")
- `materialize_static_meta_object_template`：meta = `{k: "${properties.v}"}` → 递归渲染
- `materialize_static_meta_sql_warns_returns_none`
- `dsl_provider_get_note_interpolated`：完整链路（render_template_to_string）
- `instantiate_invocation_with_captures`：正则 resolve 后 properties 用 capture 求值

**Test**：`cargo test -p pathql-rs provider::dsl_provider`（默认 feature）。

---

### S6. 端到端集成测试 — 编程注册 + 路径解析（`tests/programmatic_runtime.rs`）

新建 `pathql-rs/tests/programmatic_runtime.rs`：

```rust
//! Phase 6a 端到端: 完全用 register_provider 编程注册测试 ProviderRuntime,
//! 不涉及 DSL 加载, 不涉及 SQL 执行。验证 runtime 路径解析、命名空间链查找、
//! 缓存策略、resolve 三步顺序的核心逻辑。
//!
//! 默认 feature 编译 (无需 json5/validate/sqlite)。

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{Namespace, SimpleName};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{ChildEntry, EngineError, Provider, ProviderContext, ProviderRuntime};
use pathql_rs::template::eval::TemplateValue;
use pathql_rs::ProviderRegistry;
use pathql_rs::ast::SqlExpr;

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
    fn list(&self, _: &ProviderQuery, _ctx: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(self.children.iter().map(|(name, p)| ChildEntry {
            name: name.clone(),
            provider: Some(p.clone()),
            meta: None,
        }).collect())
    }
    fn resolve(&self, name: &str, _: &ProviderQuery, _ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        self.children.iter().find(|(n, _)| n == name).map(|(_, p)| p.clone())
    }
    fn get_note(&self, _: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> {
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
        children: vec![("c".into(), leaf.clone())],
        note: None,
    });
    let root = Arc::new(StaticProvider {
        from_table: Some("root_table".into()),
        children: vec![("b".into(), mid.clone())],
        note: Some("root provider".into()),
    });

    let mut registry = ProviderRegistry::new();
    let root_clone = root.clone();
    registry.register_provider(
        Namespace("test".into()),
        SimpleName("root".into()),
        move |_props| Ok(root_clone.clone() as Arc<dyn Provider>),
    ).unwrap();

    let runtime = ProviderRuntime::new(Arc::new(registry), root);
    
    let resolved = runtime.resolve("/b/c").unwrap();
    assert_eq!(resolved.composed.from.unwrap().0, "leaf_table");
    assert_eq!(runtime.cache_size(), 2);  // /b 与 /b/c
    
    // 第二次命中缓存
    let _ = runtime.resolve("/b/c").unwrap();
    assert_eq!(runtime.cache_size(), 2);  // 不增
    
    // list
    let children = runtime.list("/b").unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].name, "c");
    
    // note
    let note = runtime.note("/").unwrap();
    assert_eq!(note, Some("root provider".into()));
}

#[test]
fn path_not_found() {
    let root: Arc<dyn Provider> = Arc::new(StaticProvider {
        from_table: None,
        children: vec![],
        note: None,
    });
    let mut registry = ProviderRegistry::new();
    let root_clone = root.clone();
    registry.register_provider(
        Namespace("test".into()),
        SimpleName("root".into()),
        move |_| Ok(root_clone.clone()),
    ).unwrap();
    
    let runtime = ProviderRuntime::new(Arc::new(registry), root);
    let err = runtime.resolve("/missing").unwrap_err();
    assert!(matches!(err, EngineError::PathNotFound(_)));
}

#[test]
fn case_sensitive_paths() {
    // 注册 "Hello" 子节点，访问 "/hello" 应失败
    // ... (类似上面结构)
}

// 更多: factory 用 properties 构造 不同实例; programmatic provider + DSL provider 混合 registry; 等
```

**测试目标**：
- 验证 ProviderRuntime 在**纯编程注册**场景下功能正常（路径解析、缓存、case-sensitivity、错误返回）
- 不涉及任何 SQL 执行；不涉及 DSL 加载
- 这是**核心架构验证**——证明 provider 体系的内核独立工作

**Test**：`cargo test -p pathql-rs --test programmatic_runtime`（默认 feature 即可，无需任何 feature 开关）。

---

### S7. 真实 sqlite 端到端测试 — 编程注册 + 路径解析 + SQL 执行（`tests/runtime_real_sqlite.rs`）

S6 验证了路径解析的纯结构化逻辑；S7 在此基础上**接通真 SQL 执行栈**，验证完整链路 fold → build_sql → rusqlite 执行 → 结果集是否符合 ProviderQuery 累积语义。

新建 `pathql-rs/tests/runtime_real_sqlite.rs`：

```rust
//! Phase 6a 真实 sqlite 端到端: programmatic provider + ProviderRuntime + 真 in-memory sqlite。
//! 验证: 路径解析 → ProviderQuery 累积 → build_sql → params_for → rusqlite 执行 → 结果集。
//!
//! 不接 DSL, 不接 SqlExecutor 注入 (那是 6c S0d)。本期 sqlite 直接由测试代码持有 + 在 build_sql 后手动执行。

#![cfg(feature = "sqlite")]

use std::collections::HashMap;
use std::sync::Arc;

use pathql_rs::ast::{JoinKind, Namespace, OrderDirection, SimpleName, SqlExpr};
use pathql_rs::compose::ProviderQuery;
use pathql_rs::drivers::sqlite::params_for;
use pathql_rs::provider::{ChildEntry, EngineError, Provider, ProviderContext, ProviderRuntime};
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
    ).unwrap();
    conn
}

/// 模拟 root: 设置 from = images, 路由到 albums / plugins
struct GalleryRoot;
impl Provider for GalleryRoot {
    fn apply_query(&self, mut q: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
        q.from = Some(SqlExpr("images".into()));
        q
    }
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(vec![
            ChildEntry { name: "albums".into(), provider: None, meta: None },
            ChildEntry { name: "plugins".into(), provider: None, meta: None },
        ])
    }
    fn resolve(&self, name: &str, _: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        let target = match name {
            "albums" => "albums_router",
            "plugins" => "plugins_router",
            _ => return None,
        };
        ctx.registry.instantiate(
            &Namespace("test".into()),
            &pathql_rs::ast::ProviderName(target.into()),
            &HashMap::new(),
            ctx,
        )
    }
}

/// AlbumsRouter: resolve album_id → AlbumProvider with where filter
struct AlbumsRouter;
impl Provider for AlbumsRouter {
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())  // 占位; 真用动态 list
    }
    fn resolve(&self, name: &str, _: &ProviderQuery, ctx: &ProviderContext) -> Option<Arc<dyn Provider>> {
        let mut props = HashMap::new();
        props.insert("album_id".into(), TemplateValue::Text(name.to_string()));
        ctx.registry.instantiate(
            &Namespace("test".into()),
            &pathql_rs::ast::ProviderName("album_provider".into()),
            &props,
            ctx,
        )
    }
}

/// AlbumProvider: 持 album_id, 加 INNER JOIN album_images + WHERE album_id = ?
struct AlbumProvider { album_id: String }
impl Provider for AlbumProvider {
    fn apply_query(&self, current: ProviderQuery, _: &ProviderContext) -> ProviderQuery {
        current
            .with_join_raw(JoinKind::Inner, "album_images", "ai", Some("ai.image_id = images.id"), &[])
            .expect("alias")
            .with_where_raw("ai.album_id = ?", &[TemplateValue::Text(self.album_id.clone())])
    }
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> { Ok(Vec::new()) }
    fn resolve(&self, _: &str, _: &ProviderQuery, _: &ProviderContext) -> Option<Arc<dyn Provider>> { None }
}

fn execute_query(conn: &Connection, q: &ProviderQuery) -> Vec<i64> {
    let (sql, values) = q.build_sql(&TemplateContext::default()).unwrap();
    let params = params_for(&values);
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| r.get::<_, i64>(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn path_album_a_returns_three_image_ids() {
    let conn = fixture_db();

    let mut registry = ProviderRegistry::new();
    let root_clone = Arc::new(GalleryRoot) as Arc<dyn Provider>;
    let root_clone_for_factory = root_clone.clone();
    registry.register_provider(
        Namespace("test".into()),
        SimpleName("root".into()),
        move |_| Ok(root_clone_for_factory.clone()),
    ).unwrap();
    registry.register_provider(
        Namespace("test".into()),
        SimpleName("albums_router".into()),
        |_| Ok(Arc::new(AlbumsRouter) as Arc<dyn Provider>),
    ).unwrap();
    registry.register_provider(
        Namespace("test".into()),
        SimpleName("album_provider".into()),
        |props| {
            let id = match props.get("album_id") {
                Some(TemplateValue::Text(s)) => s.clone(),
                _ => return Err(EngineError::FactoryFailed("test".into(), "album_provider".into(), "missing album_id".into())),
            };
            Ok(Arc::new(AlbumProvider { album_id: id }) as Arc<dyn Provider>)
        },
    ).unwrap();

    let runtime = ProviderRuntime::new(Arc::new(registry), root_clone);

    // 路径 /albums/A → ProviderQuery + 执行 SQL
    let resolved = runtime.resolve("/albums/A").unwrap();
    let ids = execute_query(&conn, &resolved.composed);
    
    // 期望: album A 有 3 张图
    let mut sorted = ids;
    sorted.sort();
    assert_eq!(sorted, vec![1, 2, 3]);
}

#[test]
fn path_album_b_returns_two_image_ids() {
    /* 类似上面, /albums/B → [4, 5] */
}

#[test]
fn longest_prefix_cache_skips_repeated_apply_query() {
    /* 跑 /albums/A 两次, 第二次 build_sql 应当从缓存复用 composed */
}

#[test]
fn path_not_found_returns_error_no_cache_pollution() {
    /* /albums/Z → PathNotFound; cache size 不变 */
}
```

**测试目标**：
- 真 sqlite 跑出来的结果集与 ProviderQuery 累积语义一致
- raw API（with_join_raw / with_where_raw）正确转 bind param
- params_for 转换正确
- longest-prefix 缓存在真 SQL 场景下保持正确（不出现脏 composed）

**Test**：`cargo test -p pathql-rs --features sqlite --test runtime_real_sqlite`。

---

## 完成标准

- [ ] `cargo test -p pathql-rs` 全绿（默认 feature；含本期新增 ~40 结构化测试 + S7 真 sqlite 端到端测试）
- [ ] `cargo test -p pathql-rs --features sqlite --test runtime_real_sqlite` 全绿（S7 新增；4 个 case：path_album_a / path_album_b / longest_prefix_cache / path_not_found）
- [ ] `cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿（约 351 + 44 ≈ 395 测试）
- [ ] `cargo build -p pathql-rs` warning 清零（默认 feature） 
- [ ] core **完全未改动**（确认 grep `pathql_rs` / `pathql-rs` 在 src-tauri/core/ 仍为 0）
- [ ] pathql-rs 暴露的核心新 API：
  - `ChildEntry / Provider / EngineError / ProviderRuntime`
  - `ProviderRegistry::register_provider`
  - `ProviderQuery::with_*_raw` 一组
- [ ] DslProvider 静态部分功能完整（apply_query / 静态 list / regex+静态 resolve / get_note）；动态部分有 placeholder
- [ ] 编程 provider 通过 ProviderRuntime 完整路径解析 + 缓存 + 错误处理验证

## 风险点

1. **registry.rs 改动破坏 validate 模块**：iter() 类型变了；本期同步在 validate 各 validator 加 `RegistryEntry::Programmatic` 跳过分支。要 grep `registry.iter` / `registry.defs` 确认全部点改到。
2. **DslProvider 持 `Weak<ProviderRuntime>` 的初始化时序**：ProviderRuntime::new 用 `Arc::new_cyclic`；root provider 在 cyclic closure 内构造时拿 weak。但本期 6a 测试用编程 provider 起步，编程 provider 不需要 weak runtime 引用——只 DSL provider 需要。本期 DslProvider 的 weak 字段先空着；运行测试时若实际触发 Delegate query 会 weak.upgrade() 失败 → log warning + 返回原 composed（已设计）。等 6c DSL 接管 runtime 时再正式接入 weak。
3. **note 渲染需要新 helper**：`render_template_to_string` 与 `render_template_sql` 不同——前者纯字符串拼装，后者产 SQL with `?` placeholders。本期在 compose/render.rs 加 helper（与 render_template_sql 并列）；用法是把 var 求值后的 TemplateValue → String 直接拼。
4. **percent-encoding crate 引入**：轻量但是新 dep。如想避免，可以手写最简 percent decode（10 行）。建议直接引 percent-encoding 节省时间。
5. **lru 缓存暂用 HashMap**：6a 简化版无大小限制；后期换 lru 时改 cache 字段类型即可，不影响接口。
6. **EmptyDslProvider 占位**：暴露给外部时是 `Arc<dyn Provider>`，调用方可能问"这是什么 provider"。建议用 trait method `is_empty()` 标记（已加），调用方按需检测。
7. **factory 失败传播**：register_provider 的 factory 可能在运行期调用时失败（properties 类型不对、外部资源不可用）。本期 EngineError::FactoryFailed 表达；调用方按需处理。

## 完成 6a 后的下一步

进入 **Phase 6b**（重新规划版）：
- core 加 pathql-rs 依赖 + ProviderMeta::Json + DSL 加载入口
- ImageQuery → ProviderQuery 全切换 + 33 处硬编码 apply_query 迁移到 ProviderQuery 接口（用 raw API）
- core 现有 ProviderRuntime / Provider trait 删除（被 pathql-rs 中的版本替代）
- 但**仍不**让 DSL 接管运行期；core 用编程 register_provider 把硬编码 provider 注册进 pathql-rs Registry，让 pathql-rs ProviderRuntime 管理路径解析

Phase 6c（再下一步）：DSL 加载启用 + 动态 list 实现（外部 executor 注入或 query feature）+ 缓存 / dangling provider 处理。
