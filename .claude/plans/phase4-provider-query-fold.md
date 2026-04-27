# Phase 4 详细计划 — `ProviderQuery` 类型 + ContribQuery 结构化折叠

## Context

承接 Phase 1（AST + Registry）、Phase 2（json5 适配器）、Phase 3（语义校验 + 模板解析器）。
现在 9 个真实 .json5 文件都能加载 + 校验通过；模板字符串能解析为 AST。

Phase 4 的目标：定义 **`ProviderQuery`** 类型（决策 1 锁定的 ImageQuery 替代品），实现
RULES.md §3 的全部**结构化**累积语义。本期产出的是 **结构化中间表示**（IR）——
**不**生成 SQL 字符串、**不**做模板求值。所有 `${properties.X}` / `${capture[N]}` / `${ref:my_id}`
等模板都按字面 `String` 累积保留；最终 SQL 渲染（含求值与 bind params）留给 Phase 5。

约束：
- pathql-rs 仍**未**被 core 引用
- 本期**无**新外部依赖（rusqlite 留到 Phase 5）
- 测试是 **结构化 snapshot**——比对 ProviderQuery 字段值，不比对 SQL 字符串
- `validate` / `json5` feature 开关与本期无关；新增 `compose` feature 控制本模块编译

---

## 锁定的设计选择

1. **Feature 名 `compose`**：默认关闭，按需启用。本期开启后**不**新增外部 dep（仅条件编译开关）。
2. **结构化 IR 而非字符串**：`ProviderQuery` 字段保留 AST 引用 / `String`（含未求值 `${...}` 模板），不做提前求值。`with_join("...", &[...])` 这种"硬编码迁移友好" API 推迟到 Phase 5（届时 ProviderQuery 已能消费 bind params）。
3. **`${ref:X}` 别名分配在 fold 期完成**：fold 见 `as: ${ref:my_id}` 时立即分配字面别名（如 `_a0`）并写入 `ref_aliases` 表；`sql` / `on` / `where` 中的 `${ref:my_id}` 引用**不**替换字面（仍存原文），SQL 渲染（Phase 5）才把 `${ref:my_id}` 翻译为分配的字面。
4. **OrderState 用 `Vec<(String, OrderDirection)>` 自维护保序**：与 Phase 1 OrderArrayItem 同构。`{all}` 全局 modifier 单独存为字段（可与字段 vec 共存：先应用字段顺序，再应用全局 modifier 翻转/统一方向）。
5. **`from` 是 SqlExpr 字符串**：cascading-replace 直接覆盖；不解析。
6. **`offset` 累加表**：`Vec<NumberOrTemplate>`；空表表示无 offset；非空时 SQL 渲染拼 `(o1) + (o2) + ...`。
7. **`limit` 单值**：`Option<NumberOrTemplate>`；最末一次 fold 覆盖前。
8. **`from` 内 JOIN 防御性 warn 已在 Phase 3 完成**——Phase 4 不重复，fold 见到 `from` 直接接受。
9. **错误模型**：`FoldError` enum，含 `RefAliasWithInNeed` / `AliasCollision` / `ReservedRefIdent` 等结构化错误。fold 错误立即返回（fail-fast）；不像 validate 那样 batch 收集。

---

## 测试节奏

**每完成一个子任务就立即跑一次 `cargo test -p pathql-rs --features compose`**——不要积攒。

---

## ProviderQuery 字段总览

```rust
pub struct ProviderQuery {
    /// FROM 子句; cascading-replace.
    pub from: Option<SqlExpr>,

    /// SELECT 字段累积; 按 alias 去重。
    pub fields: Vec<FieldFrag>,

    /// JOIN 累积; 按 alias 去重。
    pub joins: Vec<JoinFrag>,

    /// WHERE 谓词累积; 渲染时用 AND 串接。
    pub wheres: Vec<SqlExpr>,

    /// ORDER BY 累积。
    pub order: OrderState,

    /// OFFSET 累加项; 渲染时用 + 串接。
    pub offset_terms: Vec<NumberOrTemplate>,

    /// LIMIT; last-wins。
    pub limit: Option<NumberOrTemplate>,

    /// ${ref:my_id} → 字面别名映射。
    pub ref_aliases: HashMap<String, AllocatedAlias>,

    /// 内部计数器: 下一个自动分配别名的序号。
    pub(crate) alias_counter: u32,
}

pub struct FieldFrag {
    pub sql: SqlExpr,
    pub alias: Option<ResolvedAlias>,
    /// 标记此项是否携带 in_need 语义 (信息保留, 用于 fold 后续诊断; 实际去重在 fold 时已完成)
    pub in_need: bool,
}

pub struct JoinFrag {
    pub kind: JoinKind,
    pub table: SqlExpr,
    pub alias: ResolvedAlias,
    pub on: Option<SqlExpr>,
    pub in_need: bool,
}

/// 别名要么是字面 (用户写死或在 fold 期分配的), 要么是未解析 ref (理论上不该出现, fold 期都会变成字面)。
pub enum ResolvedAlias {
    Literal(String),
    /// 仅作为内部状态; fold 完成后所有 ResolvedAlias 都应为 Literal
    UnresolvedRef(String),
}

pub struct AllocatedAlias {
    /// 对外字面名, 如 "_a0"
    pub literal: String,
}

pub struct OrderState {
    /// 字段 -> 方向, 保留路径累积顺序。
    pub entries: Vec<(String, OrderDirection)>,
    /// 全局 modifier (来自最近一次 OrderForm::Global)。多次声明 last-wins。
    pub global: Option<OrderDirection>,
}
```

---

## 子任务拆解

### S1. 启用 `compose` feature + 模块脚手架

修改 `src-tauri/pathql-rs/Cargo.toml`：

```toml
[features]
default = []
json5 = ["dep:json5"]
validate = ["dep:regex", "dep:regex-automata", "dep:sqlparser"]
compose = []
```

新建 `src-tauri/pathql-rs/src/compose/mod.rs`：

```rust
//! ProviderQuery 结构化中间表示 + ContribQuery 累积。
//!
//! 本模块只做结构化累积; SQL 渲染 + 模板求值在 Phase 5 (compose/build.rs)。

#![cfg(feature = "compose")]

pub mod aliases;
pub mod order;
pub mod query;
pub mod fold;

pub use aliases::{AllocatedAlias, ResolvedAlias};
pub use order::OrderState;
pub use query::{ProviderQuery, FieldFrag, JoinFrag};
pub use fold::{fold_contrib, FoldError};
```

新建空占位文件 `aliases.rs` / `order.rs` / `query.rs` / `fold.rs`（各只 `// placeholder; populated in S2-S7`）。

更新 `src/lib.rs` 加 `pub mod compose;` + 条件 re-export。

**测试要点**：feature 开关 + 模块编译。

**Test**：
- `cargo check -p pathql-rs` —— 默认关，通过
- `cargo check -p pathql-rs --features compose` —— 通过（空模块）
- `cargo test -p pathql-rs --features compose` —— Phase 1-3 单测全绿（feature 隔离）

---

### S2. ProviderQuery struct + 基础 API（`compose/query.rs` + `compose/aliases.rs` + `compose/order.rs`）

实现三个文件的实际定义（按上述 "ProviderQuery 字段总览" 设计）：

**`aliases.rs`**：

```rust
use std::collections::HashMap;
use crate::ast::AliasName;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllocatedAlias {
    pub literal: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedAlias {
    Literal(String),
    UnresolvedRef(String),
}

impl ResolvedAlias {
    pub fn from_alias_name(a: &AliasName) -> Self {
        // 解析 AliasName: 如果是 ${ref:X} 形态 → UnresolvedRef("X"); 否则 Literal
        let s = &a.0;
        if let Some(inner) = s.strip_prefix("${ref:").and_then(|s| s.strip_suffix("}")) {
            ResolvedAlias::UnresolvedRef(inner.to_string())
        } else {
            ResolvedAlias::Literal(s.clone())
        }
    }
    pub fn as_literal(&self) -> Option<&str> {
        match self {
            ResolvedAlias::Literal(s) => Some(s),
            _ => None,
        }
    }
}

/// 别名分配表（保留路径累积时已分配的所有 ref → 字面映射）。
#[derive(Debug, Clone, Default)]
pub struct AliasTable {
    pub map: HashMap<String, AllocatedAlias>,  // ref ident → allocated
    pub counter: u32,
}

impl AliasTable {
    pub fn allocate(&mut self, ref_ident: &str) -> &AllocatedAlias {
        if !self.map.contains_key(ref_ident) {
            let literal = format!("_a{}", self.counter);
            self.counter += 1;
            self.map.insert(ref_ident.to_string(), AllocatedAlias { literal });
        }
        self.map.get(ref_ident).unwrap()
    }
    pub fn lookup(&self, ref_ident: &str) -> Option<&AllocatedAlias> {
        self.map.get(ref_ident)
    }
}
```

**`order.rs`**：

```rust
use crate::ast::OrderDirection;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrderState {
    pub entries: Vec<(String, OrderDirection)>,
    pub global: Option<OrderDirection>,
}
```

**`query.rs`**：

```rust
use crate::ast::{SqlExpr, JoinKind, NumberOrTemplate};
use super::{aliases::*, order::OrderState};

#[derive(Debug, Clone, PartialEq)]
pub struct FieldFrag {
    pub sql: SqlExpr,
    pub alias: Option<ResolvedAlias>,
    pub in_need: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JoinFrag {
    pub kind: JoinKind,
    pub table: SqlExpr,
    pub alias: ResolvedAlias,
    pub on: Option<SqlExpr>,
    pub in_need: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderQuery {
    pub from: Option<SqlExpr>,
    pub fields: Vec<FieldFrag>,
    pub joins: Vec<JoinFrag>,
    pub wheres: Vec<SqlExpr>,
    pub order: OrderState,
    pub offset_terms: Vec<NumberOrTemplate>,
    pub limit: Option<NumberOrTemplate>,
    pub aliases: AliasTable,
}

impl ProviderQuery {
    pub fn new() -> Self { Self::default() }

    /// 检查路径上是否已有同名 alias（字面）。
    pub(crate) fn has_field_alias(&self, name: &str) -> bool {
        self.fields.iter().any(|f| f.alias.as_ref().and_then(|a| a.as_literal()) == Some(name))
    }
    pub(crate) fn has_join_alias(&self, name: &str) -> bool {
        self.joins.iter().any(|j| j.alias.as_literal() == Some(name))
    }
}
```

**测试要点**：纯数据结构，构造 `ProviderQuery::new()` 默认值字段全空；`AliasTable::allocate("x")` → "_a0"，再次 allocate 同 ident → 同字面。

**Test**：`cargo test -p pathql-rs --features compose compose::aliases compose::order compose::query`。

---

### S3. fold 入口骨架 + `from` cascading-replace（`compose/fold.rs`）

```rust
use thiserror::Error;
use crate::ast::ContribQuery;
use super::ProviderQuery;

#[derive(Debug, Error)]
pub enum FoldError {
    #[error("alias `{0}` already used in path; in_need not set on conflicting contrib")]
    AliasCollision(String),
    #[error("`as: ${{ref:{0}}}` cannot coexist with `in_need: true`")]
    RefAliasWithInNeed(String),
    #[error("reserved identifier `{0}` used as ref ident")]
    ReservedRefIdent(String),
    // ... 后续子任务追加
}

pub fn fold_contrib(state: &mut ProviderQuery, q: &ContribQuery) -> Result<(), FoldError> {
    // S3: from
    if let Some(new_from) = &q.from {
        state.from = Some(new_from.clone());
    }
    // S4-S7 分别追加 fields / joins / where / order / offset / limit
    Ok(())
}
```

**测试要点**：
- `fold_from_first_time`：空 ProviderQuery + `q.from = "images"` → state.from = Some("images")
- `fold_from_cascading_replace`：先 fold "images"，再 fold "vd_images" → state.from = Some("vd_images")
- `fold_from_none_keeps_existing`：先 fold "images"，再 fold ContribQuery (from=None) → state.from = Some("images")

**Test**：`cargo test -p pathql-rs --features compose compose::fold::tests::from_`。

---

### S4. fold `fields[]` 累积 + `as + in_need` + ref 自动分配

实现 `fold_fields(state, q.fields)`：

逻辑：
1. 遍历 q.fields 每个 `Field { sql, as: AliasName?, in_need }`
2. 解析 alias：
   - 缺省 → ResolvedAlias = None（投影列不要求别名，如 `images.*`）
   - `Literal("foo")` → ResolvedAlias::Literal("foo")
   - `${ref:my_id}` → 立即调 `state.aliases.allocate("my_id")` → ResolvedAlias::Literal("_aN")；同时校验 in_need 不为 true（`RefAliasWithInNeed`）
3. 重名检查：如已存在同字面 alias：
   - 若新项 `in_need == true` → 跳过累积（共享）
   - 否则 → `AliasCollision`
4. 不冲突 → push 到 `state.fields`

```rust
fn fold_fields(state: &mut ProviderQuery, fields: &Option<Vec<Field>>) -> Result<(), FoldError> {
    let Some(fields) = fields else { return Ok(()) };
    for f in fields {
        let alias = match &f.alias {
            None => None,
            Some(name) => {
                let resolved = ResolvedAlias::from_alias_name(name);
                let resolved = match resolved {
                    ResolvedAlias::UnresolvedRef(ident) => {
                        if f.in_need == Some(true) {
                            return Err(FoldError::RefAliasWithInNeed(ident));
                        }
                        // TODO: reserved ident 检查可在 Phase 3 已做; fold 期防御性 re-check
                        let allocated = state.aliases.allocate(&ident).literal.clone();
                        ResolvedAlias::Literal(allocated)
                    }
                    other => other,
                };
                if let Some(lit) = resolved.as_literal() {
                    if state.has_field_alias(lit) {
                        if f.in_need == Some(true) {
                            continue;  // 跳过, 共享上游
                        }
                        return Err(FoldError::AliasCollision(lit.to_string()));
                    }
                }
                Some(resolved)
            }
        };
        state.fields.push(FieldFrag {
            sql: f.sql.clone(),
            alias,
            in_need: f.in_need.unwrap_or(false),
        });
    }
    Ok(())
}
```

**测试要点**：
- `fold_field_literal_alias`：fold `{sql: "x", as: "ax"}` + `{sql: "y", as: "ay"}` → 2 项
- `fold_field_collision_no_in_need`：两个都 alias `ax` → `AliasCollision`
- `fold_field_collision_in_need_skips`：第一项 `ax` 无 in_need，第二项 `ax, in_need: true` → 第二项跳过，state.fields.len() = 1
- `fold_field_no_alias`：`{sql: "images.*"}` 无 alias → push，alias = None
- `fold_field_ref_allocates`：`{sql: "x", as: "${ref:my}"}` → state.aliases.map["my"] = AllocatedAlias{"_a0"}; FieldFrag.alias = Literal("_a0")
- `fold_field_ref_with_in_need_rejected`：`{sql: "x", as: "${ref:my}", in_need: true}` → `RefAliasWithInNeed`
- `fold_field_ref_reuse`：先 fold ref:my，再 fold ref:my → 共用 _a0（注意：第二次会触发 collision；按 RULES，ref 自动分配本来就唯一，不会重复出现"两个 ref:my as 同字段"——但若用户手写两次，第二次的字面别名 _a0 会撞，按 collision 报错）

**Test**：`cargo test -p pathql-rs --features compose compose::fold::tests::fields_`。

---

### S5. fold `join[]` 累积（同 S4 同构逻辑）

`Join` 强制有 `as`，所以与 fields 略不同：alias 必有；其余共享逻辑。

```rust
fn fold_joins(state: &mut ProviderQuery, joins: &Option<Vec<Join>>) -> Result<(), FoldError> {
    let Some(joins) = joins else { return Ok(()) };
    for j in joins {
        let resolved = ResolvedAlias::from_alias_name(&j.alias);
        let resolved = match resolved {
            ResolvedAlias::UnresolvedRef(ident) => {
                if j.in_need == Some(true) {
                    return Err(FoldError::RefAliasWithInNeed(ident));
                }
                let lit = state.aliases.allocate(&ident).literal.clone();
                ResolvedAlias::Literal(lit)
            }
            other => other,
        };
        let lit = resolved.as_literal().expect("Join.as is required");
        if state.has_join_alias(lit) {
            if j.in_need == Some(true) { continue; }
            return Err(FoldError::AliasCollision(lit.to_string()));
        }
        state.joins.push(JoinFrag {
            kind: j.kind.unwrap_or(JoinKind::Inner),
            table: j.table.clone(),
            alias: resolved,
            on: j.on.clone(),
            in_need: j.in_need.unwrap_or(false),
        });
    }
    Ok(())
}
```

**测试要点**：与 fields 同构，加 1-2 个 join 特有：
- `fold_join_kind_default`：缺省 kind → INNER
- `fold_join_kind_left`：`kind: "LEFT"` → JoinFrag.kind = Left
- `fold_join_with_on`：with `on` 字段 → 保留

**Test**：`cargo test -p pathql-rs --features compose compose::fold::tests::joins_`。

---

### S6. fold `where` 累积 + `order` + `offset` + `limit`

**`where` additive**：

```rust
fn fold_where(state: &mut ProviderQuery, w: &Option<SqlExpr>) {
    if let Some(expr) = w {
        state.wheres.push(expr.clone());
    }
}
```

**`order` 双形态**：

```rust
fn fold_order(state: &mut ProviderQuery, order: &Option<OrderForm>) {
    let Some(form) = order else { return };
    match form {
        OrderForm::Array(items) => {
            for item in items {
                for (field, dir) in &item.0 {
                    // 同名 field 后声明覆盖前声明 (RULES §3.4)
                    if let Some(slot) = state.order.entries.iter_mut().find(|(f, _)| f == field) {
                        slot.1 = *dir;
                    } else {
                        state.order.entries.push((field.clone(), *dir));
                    }
                }
            }
        }
        OrderForm::Global(g) => {
            // last-wins (路径上多次声明全局 modifier 取末次)
            state.order.global = Some(g.all);
        }
    }
}
```

注意：`{all: revert}` 的语义在 SQL 渲染时才生效（"翻转上游所有方向"）。fold 期只记录 modifier，不立即对 entries 应用，因为 entries 还可能被下游补充。

**`offset` additive**：

```rust
fn fold_offset(state: &mut ProviderQuery, o: &Option<NumberOrTemplate>) {
    if let Some(v) = o {
        state.offset_terms.push(v.clone());
    }
}
```

**`limit` last-wins**：

```rust
fn fold_limit(state: &mut ProviderQuery, l: &Option<NumberOrTemplate>) {
    if let Some(v) = l {
        state.limit = Some(v.clone());
    }
}
```

完善 `fold_contrib` 把 S3-S6 全部串起来。

**测试要点**：
- where：连续 fold 三个 ContribQuery，每个含 `where`，最终 `state.wheres.len() == 3`
- order array 单字段：fold `[{title: asc}]` → entries = [(title, Asc)]
- order array 多字段：fold `[{a: asc}, {b: desc}]` → entries 顺序 [(a,Asc),(b,Desc)]
- order array overwrite：先 fold `[{a: asc}]`，再 fold `[{a: desc}]` → entries = [(a, Desc)]，长度 1
- order global：fold `{all: revert}` → state.order.global = Some(Revert)；entries 不动
- order mixed across folds：先 array 再 global，再 array → entries 累积，global 覆盖
- offset 三次 fold 累加：state.offset_terms.len() == 3
- limit last-wins：第一次 fold limit=10，第二次 limit=20 → state.limit = Some(20)

**Test**：`cargo test -p pathql-rs --features compose compose::fold::tests::where_ compose::fold::tests::order_ compose::fold::tests::offset_ compose::fold::tests::limit_`。

---

### S7. ${ref:X} 跨 fold 别名重用 + 完整 fold_contrib 集成

到 S6 fold_contrib 已串好。本步加端到端覆盖：跨多次 fold 复用同一 ref ident → 生成一致的 _aN 别名。

```rust
#[test]
fn fold_ref_alias_shared_across_folds() {
    let mut state = ProviderQuery::new();
    // Provider A: 贡献 join with as: ${ref:t1}
    let q1 = ContribQuery {
        join: Some(vec![Join {
            kind: None,
            table: SqlExpr("album_images".into()),
            alias: AliasName("${ref:t1}".into()),
            on: None,
            in_need: None,
        }]),
        ..Default::default()
    };
    fold_contrib(&mut state, &q1).unwrap();

    // Provider B: 引用 ${ref:t1} 在 where 中
    let q2 = ContribQuery {
        where_: Some(SqlExpr("${ref:t1}.image_id = images.id".into())),
        ..Default::default()
    };
    fold_contrib(&mut state, &q2).unwrap();

    // 校验:
    // - state.aliases.map["t1"].literal == "_a0"
    // - state.joins[0].alias == ResolvedAlias::Literal("_a0")
    // - state.wheres[0] 仍含 "${ref:t1}" 字面 (Phase 5 才替换)
    assert_eq!(state.aliases.map.get("t1").unwrap().literal, "_a0");
    assert!(matches!(&state.joins[0].alias, ResolvedAlias::Literal(s) if s == "_a0"));
    assert!(state.wheres[0].0.contains("${ref:t1}"));
}
```

另一组：
- `fold_ref_alias_two_idents_distinct`：两个不同 ident → _a0 / _a1
- `fold_ref_alias_chain_third_provider`：三个 provider 都贡献用 ${ref:t1}，第二个 in_need=true → 跳过；第三个不带 in_need → 第三个也命中已分配的 _a0，但作为 join.as 撞 → AliasCollision（除非也带 in_need）

**测试要点**：上述 3-4 个端到端 fold 链路。

**Test**：`cargo test -p pathql-rs --features compose compose::fold::tests::ref_`。

---

### S8. 真路径链 fold 集成测试（`tests/fold_real_chain.rs`）

模拟 Phase 6 中实际 resolve 路径会触发的 fold 链：从 root_provider → gallery_route →
gallery_all_router → gallery_paginate_router → gallery_page_router → query_page_provider 一路 fold，
对结果 ProviderQuery snapshot 校验。

```rust
#![cfg(all(feature = "json5", feature = "compose"))]

use pathql_rs::{
    ast::ContribQuery,
    compose::{fold_contrib, ProviderQuery},
    Json5Loader, Loader, ProviderRegistry, Source,
};
use std::path::PathBuf;

fn registry() -> ProviderRegistry {
    // 复用 Phase 2 的 build_full_registry; 简化: 直接读 8 个文件
    // (具体清单见 tests/load_real_providers.rs)
    todo!()
}

#[test]
fn fold_gallery_page_chain() {
    let r = registry();
    let mut state = ProviderQuery::new();

    // gallery_route.query: { from: "images", limit: 0 }
    let gr = r.resolve(&"kabegame".into(), &"gallery_route".into()).unwrap();
    if let Some(crate::ast::Query::Contrib(q)) = &gr.query {
        fold_contrib(&mut state, q).unwrap();
    }

    // ... 依次 fold gallery_all_router (Delegate, 不直接 fold ContribQuery)
    // gallery_paginate_router.query: { limit: 0 }
    // gallery_page_router.query: { delegate: "./__provider" }
    // query_page_provider.query: { offset: "${properties.page_size} * (...)", limit: "${...}" }

    // 最终 snapshot:
    assert_eq!(state.from.unwrap().0, "images");
    assert_eq!(state.limit.as_ref().unwrap(), &/* expected last-wins */ ...);
    assert_eq!(state.offset_terms.len(), 1);
    // ...
}
```

注意：`Query::Delegate` 形态不是 ContribQuery，fold_contrib 不接受 DelegateQuery；这种节点在 fold 链中是路径重定向。Phase 6 的 DslProvider 处理 delegate 时会跳到目标路径再 fold；本测试为简化，只取 ContribQuery 节点的 .query 累积。

**测试要点**：snapshot 真路径累积结果，确认 fold 在多 provider 串接下正确。

**Test**：`cargo test -p pathql-rs --features "json5 compose" --test fold_real_chain`。

---

## 完成标准

- [ ] `cargo test -p pathql-rs` 全绿（Phase 1）
- [ ] `cargo test -p pathql-rs --features json5` 全绿（Phase 1+2）
- [ ] `cargo test -p pathql-rs --features validate` 全绿（Phase 1+3）
- [ ] `cargo test -p pathql-rs --features compose` 全绿（Phase 1+4）
- [ ] `cargo test -p pathql-rs --features "json5 validate compose"` 全绿（全部）
- [ ] `cargo build -p pathql-rs --features compose` warning 清零
- [ ] core 仍未引用 pathql-rs

## 风险点

1. **fold 期 ref 分配 vs sql 字符串中的 `${ref:X}`**：本期 sql 字段保留原文 `${ref:X}`，Phase 5 渲染时替换为字面 `_aN`。如果调用方在 fold 期就期望看到字面，会被坑。文档明示：fold 后 sql / on / where 字符串仍含未替换 ref。
2. **`{all: revert}` last-wins vs additive**：当前定义 last-wins。RULES.md §3.4 没明文说，但语义上"全局 modifier 多次声明"应该是后者覆盖前者，与 limit 同。如有歧义，Phase 5 渲染时再决定如何应用。
3. **Order entries 同名覆盖语义**：fold 时同名 field 后声明覆盖前；entries 顺序由首次声明决定（不重排到末尾）。这与 RULES §3.4 的"低 index 优先"一致——但要确认覆盖语义不破坏首次声明的位置。
4. **AliasTable.counter 的可重现性**：测试断言 `_a0` / `_a1` 等具体字面；如果 fold 顺序改变（HashMap 遍历），counter 序号会变。当前 fold 是顺序遍历 ContribQuery 字段（fields → joins → where → order → offset → limit），结果是稳定的。如果 ContribQuery 字段顺序需要重排，要重新跑测试。
5. **`from` 内含 JOIN 的处理**：Phase 3 已 warn；fold 直接接受字符串。如果实际有 from 内嵌 JOIN，Phase 5 SQL 渲染会简单透传，可能产生 SQL 但与 join[] 数组共享别名机制脱节。约定不出现这种用法即可。
6. **DelegateQuery 在 fold 链中的处理**：fold_contrib 不接受 DelegateQuery（编译期已强制只接 ContribQuery）。Phase 6 DslProvider 见 DelegateQuery 时**不调** fold_contrib，而是 ProviderRuntime resolve 跳到目标路径再继续。本期不必管。

## 完成 Phase 4 后的下一步

Phase 5 加 `template/eval.rs` 模板求值器 + `compose/build.rs` SQL 渲染。届时引入 `rusqlite` 依赖产 bind params；`${ref:X}` 替换为字面；`${composed}` 子查询嵌入；OrderState 转 `ORDER BY` 子句；offset_terms 串接 `+`。
