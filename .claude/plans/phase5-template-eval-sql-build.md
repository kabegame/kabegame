# Phase 5 详细计划 — 模板求值器 + ProviderQuery → SQL 渲染（dialect-agnostic）

## Context

承接 Phase 1-4：AST + 加载器 + 校验 + 模板**解析器**（Phase 3，永久编译）+ ProviderQuery 结构化折叠（Phase 4）。

Phase 5 的目标：
1. 实现 RULES.md §6 的 `${...}` **求值器**（复用 Phase 3 的 parser）
2. 把 Phase 4 产出的 `ProviderQuery` IR 渲染为可执行的 **SQL 字符串 + bind 参数序列**
3. 提供 **`sqlite` feature 适配器**，把 bind 参数序列转给 rusqlite 使用

**架构重点（决策 3）**：`pathql-rs` 核心保持 **dialect-agnostic**——`build_sql` 输出 `(String, Vec<TemplateValue>)`，
其中 `TemplateValue` 是本 crate 自定义枚举；**不**直接依赖 rusqlite。SQL 驱动桥接走单独的 `sqlite` feature
适配器（`adapters/sqlite.rs`），与 `json5` 适配器同构，按需启用。

约束：
- `compose` feature 只引入 ProviderQuery + fold + render，**不**碰任何 DB 驱动 crate
- `sqlite` feature 引入 rusqlite + 适配器
- 仍**不**让 core 引用 pathql-rs（推迟到 Phase 6）

---

## 锁定的设计选择

1. **TemplateValue 是 bind 参数的中性表达**：在 `template/eval.rs` 定义 `pub enum TemplateValue { Null, Bool(bool), Int(i64), Real(f64), Text(String), Json(serde_json::Value) }`。它是模板求值的运行期产物，也是 `build_sql` 输出的 bind 参数序列元素类型。pathql-rs 只产生它；不替任何 DB 驱动转换。
2. **bind param 顺序**：渲染过程按文本扫描顺序遇到 `${...}` 时立即 push 值；最终 SQL 字符串与 params vec 同序。
3. **inline vs bind 区分**：
   - **inline 替换**（无 bind 占位）：`${ref:X}` → 字面别名 `_aN`；`${composed}` → 子查询 `(SELECT ...)`
   - **bind 占位**：`${properties.X}` / `${capture[N]}` / `${data_var.col}` / `${child_var.field}` → 替换为 `?` + push `TemplateValue` 到 params
4. **`${composed}` 由调用方注入**：通过 `TemplateContext.composed: Option<(String, Vec<TemplateValue>)>` 由 Phase 6 runtime 填入（动态 list SQL 渲染时）；渲染期检测 ${composed} 出现而 ctx.composed 为 None → 报错。
5. **TemplateContext 是单次渲染本地**：每次 `render_template_sql` 调用现造一个；用 builder 设置子集。
6. **SQL 风格定位**：产出标准 ANSI SQL `?` 占位的 SELECT。`compose` feature 无 DB 驱动依赖；具体适配器 feature（sqlite / postgres / mysql）单独引入对应驱动并提供 `TemplateValue → DriverValue` 转换。
7. **OrderState 渲染**：先用全局 modifier 翻转 / 强制方向，再拼 `ORDER BY a ASC, b DESC`；entries 为空则不输出。
8. **OFFSET 累加**：多个 offset_terms 用 `+` 串接；空表不输出。
9. **LIMIT** last-wins：渲染最末一次的 NumberOrTemplate；缺省不输出。
10. **fail-fast 错误模型**：与 Phase 4 fold 一致；render 期任何模板求值 / 类型转换 / 缺失上下文都立即返回 `RenderError`。

---

## Phase 4 待补丁（在 Phase 5 实施前确认）

Phase 4 的 fold_order 需要解析 `Revert` 方向：
- `OrderDirection::Asc` / `Desc` 直接覆盖
- `OrderDirection::Revert` 翻转该字段在 entries 中的现有方向；如不存在，按默认 `Asc` 新增

如未在 Phase 4 处理，需先补——Phase 5 渲染逻辑假设 entries 中**不含** `Revert`，只有 Asc/Desc。

---

## 测试节奏

**每完成一个子任务就立即跑一次 `cargo test -p pathql-rs --features compose`**（必要时加 `sqlite` feature）——不要积攒。

---

## 子任务拆解

### S1. feature 结构（`compose` 无新 dep；`sqlite` feature 新增 rusqlite 适配器）

修改 `src-tauri/pathql-rs/Cargo.toml`：

```toml
[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
json5 = { version = "0.4", optional = true }
regex = { version = "1", optional = true }
regex-automata = { version = "0.4", optional = true }
sqlparser = { version = "0.51", optional = true }
rusqlite = { workspace = true, optional = true }

[features]
default = []
json5 = ["dep:json5"]
validate = ["dep:regex", "dep:regex-automata", "dep:sqlparser"]
compose = []
sqlite = ["compose", "dep:rusqlite"]
```

**关键差异**：与之前草案不同，`compose` 不再引入 rusqlite；`sqlite` feature 单独引入。

如根 [`Cargo.toml`](../../Cargo.toml) 没有 `rusqlite` workspace dep，从 [`core/Cargo.toml`](../../src-tauri/core/Cargo.toml) 找版本（当前 `rusqlite = "0.31"`）加进 `[workspace.dependencies]`。

**测试要点**：feature 编译。

**Test**：
- `cargo check -p pathql-rs --features compose` —— 通过（无 rusqlite）
- `cargo check -p pathql-rs --features sqlite` —— 通过（引入 rusqlite，但适配器模块尚未实现）
- `cargo check -p pathql-rs --features "json5 compose validate sqlite"` —— 全 feature 并存

---

### S2. TemplateValue + TemplateContext + 求值器（`template/eval.rs`，永久编译需要 compose 时启用）

放在 `template/eval.rs`，与 Phase 3 的 parser 同模块树。**TemplateValue 不暴露任何 DB 驱动相关方法**——仅作为中性数据类型。

```rust
//! 模板求值器: 给定 TemplateAst 与 TemplateContext, 求值各 VarRef → TemplateValue。

#![cfg(feature = "compose")]

use std::collections::HashMap;
use thiserror::Error;
use serde_json::Value as JsonValue;

use crate::template::parse::{TemplateAst, Segment, VarRef};

/// bind 参数的中性表达, dialect-agnostic。具体 DB 驱动转换在 adapters/* feature 下。
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateValue {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Text(String),
    /// 嵌套 JSON 对象 / 数组 (来自 data_var 取整行 / child_var.meta 取整对象)。
    /// 大多数适配器把它序列化为字符串。
    Json(JsonValue),
}

impl TemplateValue {
    /// JSON value → TemplateValue (data_var/child_var 取列时用)。
    pub fn from_json(v: &JsonValue) -> Self {
        match v {
            JsonValue::Null => Self::Null,
            JsonValue::Bool(b) => Self::Bool(*b),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() { Self::Int(i) }
                else if let Some(f) = n.as_f64() { Self::Real(f) }
                else { Self::Null }
            }
            JsonValue::String(s) => Self::Text(s.clone()),
            other => Self::Json(other.clone()),
        }
    }
}

/// 渲染期上下文。每次 render 调用现造一个; builder 设置子集。
#[derive(Debug, Default, Clone)]
pub struct TemplateContext {
    /// `${properties.<name>}` → TemplateValue
    pub properties: HashMap<String, TemplateValue>,
    /// `${capture[N]}` → 字符串 (N 从 1 开始; 0 = 全匹配)
    pub capture: Vec<String>,
    /// `${<data_var>.<col>}`: data_var 名 → row JSON
    pub data_var: Option<(String, JsonValue)>,
    /// `${<child_var>.<field>}`: child_var 名 → ChildEntry JSON 表示
    pub child_var: Option<(String, JsonValue)>,
    /// `${composed}` → 上游已渲染的 (sql, params); 由 Phase 6 runtime 填入
    pub composed: Option<(String, Vec<TemplateValue>)>,
}

impl TemplateContext {
    pub fn with_properties(mut self, p: HashMap<String, TemplateValue>) -> Self {
        self.properties = p;
        self
    }
    // 其他 with_* builder 视需要补
}

#[derive(Debug, Error)]
pub enum EvalError {
    #[error("unknown namespace `{0}` in ${{...}}")]
    UnknownNamespace(String),
    #[error("namespace `{0}` access path empty (need .field or [N])")]
    BareNotAllowed(String),
    #[error("property `{0}` not bound in context")]
    UnboundProperty(String),
    #[error("capture[{0}] out of bounds (have {1} groups)")]
    CaptureOutOfBounds(usize, usize),
    #[error("data_var `{0}` not bound in context")]
    DataVarNotBound(String),
    #[error("child_var `{0}` not bound in context")]
    ChildVarNotBound(String),
    #[error("composed not provided in this context (use TemplateContext::composed)")]
    ComposedNotProvided,
    #[error("path field `{0}` not found")]
    PathFieldMissing(String),
    #[error("method `{0}` not implemented in evaluator (ref/composed handled in render layer)")]
    MethodNotForEvaluator(String),
}

/// 求值单个 VarRef → TemplateValue。**不**处理 inline-replace 形态 (ref / composed);
/// 那些在 render_template_sql 里直接走字符串替换路径。
pub fn evaluate_var(var: &VarRef, ctx: &TemplateContext) -> Result<TemplateValue, EvalError> {
    match var {
        VarRef::Bare { ns } if ns == "composed" => Err(EvalError::MethodNotForEvaluator("composed".into())),
        VarRef::Bare { ns } => Err(EvalError::BareNotAllowed(ns.clone())),
        VarRef::Path { ns, path } if ns == "properties" => {
            let key = path.join(".");
            ctx.properties.get(&key).cloned().ok_or(EvalError::UnboundProperty(key))
        }
        VarRef::Path { ns, path } => {
            if let Some((n, json)) = &ctx.data_var {
                if n == ns {
                    return resolve_path(json, path).map(|v| TemplateValue::from_json(&v));
                }
            }
            if let Some((n, json)) = &ctx.child_var {
                if n == ns {
                    return resolve_path(json, path).map(|v| TemplateValue::from_json(&v));
                }
            }
            Err(EvalError::UnknownNamespace(ns.clone()))
        }
        VarRef::Index { ns, index } => {
            if ns != "capture" { return Err(EvalError::UnknownNamespace(ns.clone())); }
            ctx.capture.get(*index)
                .map(|s| TemplateValue::Text(s.clone()))
                .ok_or(EvalError::CaptureOutOfBounds(*index, ctx.capture.len()))
        }
        VarRef::Method { name, .. } => Err(EvalError::MethodNotForEvaluator(name.clone())),
    }
}

fn resolve_path(start: &JsonValue, path: &[String]) -> Result<JsonValue, EvalError> {
    let mut cur = start.clone();
    for seg in path {
        cur = cur.get(seg).cloned().ok_or(EvalError::PathFieldMissing(seg.clone()))?;
    }
    Ok(cur)
}
```

更新 `template/mod.rs` 加 `#[cfg(feature = "compose")] pub mod eval;`。

**测试要点**（`template/eval.rs` 内 `#[cfg(test)]`）：

| 测试名 | 输入 | ctx | 期望 |
|---|---|---|---|
| `properties_text` | `parse("${properties.x}")` | properties={"x": Text("hello")} | Text("hello") |
| `properties_int` | `parse("${properties.size}")` | properties={"size": Int(100)} | Int(100) |
| `properties_unbound` | `parse("${properties.missing}")` | empty | UnboundProperty |
| `capture_index` | `parse("${capture[1]}")` | capture=vec!["full","first"] | Text("first") |
| `capture_oob` | `parse("${capture[5]}")` | capture has 2 | CaptureOutOfBounds |
| `data_var_col` | `parse("${row.id}")` | data_var=("row", json!({"id": 42})) | Int(42) |
| `data_var_nested` | `parse("${row.info.name}")` | data_var=("row", json!({"info":{"name":"x"}})) | Text("x") |
| `child_var_meta` | `parse("${plugin.meta.foo}")` | child_var=("plugin", json!({"meta":{"foo":"bar"}})) | Text("bar") |
| `unknown_ns` | `parse("${nope.x}")` | empty | UnknownNamespace |
| `composed_in_eval` | `parse("${composed}")` | composed=Some(...) | MethodNotForEvaluator |
| `ref_in_eval` | `parse("${ref:my_id}")` | empty | MethodNotForEvaluator |
| `from_json_int` | `from_json(&json!(42))` | n/a | Int(42) |
| `from_json_obj_keeps_json` | `from_json(&json!({"k":"v"}))` | n/a | Json(...) |

**Test**：`cargo test -p pathql-rs --features compose template::eval`。

---

### S3. `render_template_sql` 通用渲染器（`compose/render.rs`）

把 SqlExpr / TemplateExpr / 任意带 `${...}` 字符串渲染为 SQL string + `Vec<TemplateValue>` bind 参数。
处理 inline 替换（ref / composed）+ bind 替换（其余）。

```rust
//! SQL 模板渲染: 字符串扫描 + 求值 + bind/inline 替换。

#![cfg(feature = "compose")]

use thiserror::Error;

use crate::compose::aliases::AliasTable;
use crate::template::{
    parse::{parse, Segment, VarRef, ParseError},
    eval::{evaluate_var, TemplateContext, EvalError, TemplateValue},
};

#[derive(Debug, Error)]
pub enum RenderError {
    #[error("template parse error: {0}")]
    Parse(#[from] ParseError),
    #[error("template eval error: {0}")]
    Eval(#[from] EvalError),
    #[error("${{ref:{0}}} not found in alias table; was it allocated during fold?")]
    UnknownRef(String),
    #[error("${{composed}} requires TemplateContext::composed to be set")]
    MissingComposed,
}

/// 渲染模板字符串到 (sql, params)。bind 占位用 `?`。
pub fn render_template_sql(
    template: &str,
    ctx: &TemplateContext,
    aliases: &AliasTable,
    out_sql: &mut String,
    out_params: &mut Vec<TemplateValue>,
) -> Result<(), RenderError> {
    let ast = parse(template)?;
    for seg in &ast.segments {
        match seg {
            Segment::Text(s) => out_sql.push_str(s),
            Segment::Var(VarRef::Method { name, arg }) if name == "ref" => {
                let allocated = aliases.lookup(arg).ok_or(RenderError::UnknownRef(arg.clone()))?;
                out_sql.push_str(&allocated.literal);
            }
            Segment::Var(VarRef::Bare { ns }) if ns == "composed" => {
                let (sub_sql, sub_params) = ctx.composed.as_ref()
                    .ok_or(RenderError::MissingComposed)?;
                out_sql.push('(');
                out_sql.push_str(sub_sql);
                out_sql.push(')');
                // 直接合并子层 params (TemplateValue 同型, 无需转换)
                for p in sub_params {
                    out_params.push(p.clone());
                }
            }
            Segment::Var(other) => {
                let value = evaluate_var(other, ctx)?;
                out_sql.push('?');
                out_params.push(value);
            }
        }
    }
    Ok(())
}

/// 便利函数: 直接得到 (sql, params)。
pub fn render_to_owned(
    template: &str,
    ctx: &TemplateContext,
    aliases: &AliasTable,
) -> Result<(String, Vec<TemplateValue>), RenderError> {
    let mut sql = String::new();
    let mut params = Vec::new();
    render_template_sql(template, ctx, aliases, &mut sql, &mut params)?;
    Ok((sql, params))
}
```

**测试要点**：

| 测试名 | template | ctx / aliases | 期望 |
|---|---|---|---|
| `pure_literal` | `"SELECT 1"` | empty | sql="SELECT 1", params=[] |
| `single_property` | `"id = ${properties.x}"` | properties={"x": Int(42)} | sql="id = ?", params=[Int(42)] |
| `multi_property` | `"a = ${properties.x} AND b = ${properties.y}"` | x=10,y=20 | "a = ? AND b = ?", [10,20] |
| `ref_inline` | `"${ref:t}.id = ${ref:t}.x"` | aliases["t"]={"_a0"} | "_a0.id = _a0.x", [] |
| `ref_unknown` | `"${ref:nope}"` | empty aliases | UnknownRef |
| `composed_inline` | `"FROM (${composed}) sub"` | composed=Some(("SELECT 1",vec![])) | "FROM (SELECT 1) sub", [] |
| `composed_with_subparams` | `"FROM (${composed})"` | composed=("WHERE x = ?", vec![Int(7)]) | params=[Int(7)] |
| `composed_missing` | `"${composed}"` | composed=None | MissingComposed |
| `mixed` | `"${ref:t}.id = ${properties.id} AND ${capture[1]}"` | 各全 | 1 inline + 2 binds, params 顺序对 |

**Test**：`cargo test -p pathql-rs --features compose compose::render`。

---

### S4. ProviderQuery::build_sql 骨架 + SELECT + FROM + JOIN（`compose/build.rs`）

```rust
#![cfg(feature = "compose")]

use thiserror::Error;
use crate::ast::{JoinKind, OrderDirection, NumberOrTemplate};
use crate::compose::{ProviderQuery, FieldFrag, JoinFrag, aliases::AliasTable};
use crate::compose::render::{render_template_sql, RenderError};
use crate::template::eval::{TemplateContext, TemplateValue};

#[derive(Debug, Error)]
pub enum BuildError {
    #[error("render error: {0}")]
    Render(#[from] RenderError),
    #[error("no FROM clause; ProviderQuery requires from to be set by some provider in path")]
    MissingFrom,
}

impl ProviderQuery {
    pub fn build_sql(&self, ctx: &TemplateContext) -> Result<(String, Vec<TemplateValue>), BuildError> {
        let mut sql = String::new();
        let mut params = Vec::new();

        // SELECT
        sql.push_str("SELECT ");
        self.render_select(&mut sql, &mut params, ctx)?;

        // FROM
        sql.push_str(" FROM ");
        let from = self.from.as_ref().ok_or(BuildError::MissingFrom)?;
        render_template_sql(&from.0, ctx, &self.aliases, &mut sql, &mut params)?;

        // JOIN
        for j in &self.joins {
            self.render_one_join(j, &mut sql, &mut params, ctx)?;
        }

        // S5/S6/S7 追加 WHERE / ORDER BY / OFFSET LIMIT
        Ok((sql, params))
    }

    fn render_select(&self, sql: &mut String, params: &mut Vec<TemplateValue>, ctx: &TemplateContext) -> Result<(), BuildError> {
        if self.fields.is_empty() {
            sql.push('*');
            return Ok(());
        }
        for (i, f) in self.fields.iter().enumerate() {
            if i > 0 { sql.push_str(", "); }
            render_template_sql(&f.sql.0, ctx, &self.aliases, sql, params)?;
            if let Some(alias) = &f.alias {
                if let Some(lit) = alias.as_literal() {
                    sql.push_str(" AS ");
                    sql.push_str(lit);
                }
            }
        }
        Ok(())
    }

    fn render_one_join(&self, j: &JoinFrag, sql: &mut String, params: &mut Vec<TemplateValue>, ctx: &TemplateContext) -> Result<(), BuildError> {
        let kw = match j.kind {
            JoinKind::Inner => " INNER JOIN ",
            JoinKind::Left  => " LEFT JOIN ",
            JoinKind::Right => " RIGHT JOIN ",
            JoinKind::Full  => " FULL JOIN ",
        };
        sql.push_str(kw);
        render_template_sql(&j.table.0, ctx, &self.aliases, sql, params)?;
        if let Some(lit) = j.alias.as_literal() {
            sql.push_str(" AS ");
            sql.push_str(lit);
        }
        if let Some(on) = &j.on {
            sql.push_str(" ON ");
            render_template_sql(&on.0, ctx, &self.aliases, sql, params)?;
        }
        Ok(())
    }
}
```

**测试要点**：

- `select_star_when_no_fields`：fields 空 → "SELECT *"
- `select_one_field_no_alias`：sql="images.id", alias=None → "SELECT images.id"
- `select_field_with_alias`：alias=Literal("img_id") → "SELECT images.id AS img_id"
- `select_with_template_param`：sql="images.id + ${properties.x}", alias=Some("y"), properties={"x":Int(1)} → "SELECT images.id + ? AS y", params=[Int(1)]
- `from_simple`：from="images" → "FROM images"
- `from_missing`：from=None → MissingFrom
- `join_inner_default`：JoinKind::Inner + table="album_images" + alias="ai" + on="ai.image_id = images.id" → " INNER JOIN album_images AS ai ON ai.image_id = images.id"
- `join_left_with_template`：JoinKind::Left + on 含 ${properties.X} → 替换为 ?

**Test**：`cargo test -p pathql-rs --features compose compose::build::tests::select_ compose::build::tests::from_ compose::build::tests::join_`。

---

### S5. WHERE 渲染（AND 拼接）

接续 S4 在 `build_sql` 后补：

```rust
// WHERE
if !self.wheres.is_empty() {
    sql.push_str(" WHERE ");
    for (i, w) in self.wheres.iter().enumerate() {
        if i > 0 { sql.push_str(" AND "); }
        sql.push('(');
        render_template_sql(&w.0, ctx, &self.aliases, &mut sql, &mut params)?;
        sql.push(')');
    }
}
```

**测试要点**：
- `where_none`：wheres 空 → 不输出 WHERE
- `where_single`：wheres=["x > 1"] → " WHERE (x > 1)"
- `where_multi_and`：wheres=["a > 1", "b < 2"] → " WHERE (a > 1) AND (b < 2)"
- `where_with_template`：wheres=["images.id = ${properties.id}"], properties={"id":Int(7)} → " WHERE (images.id = ?)", params=[Int(7)]

**Test**：`cargo test -p pathql-rs --features compose compose::build::tests::where_`。

---

### S6. ORDER BY 渲染（含全局 modifier 应用）

```rust
fn render_order(&self, sql: &mut String) {
    let entries = &self.order.entries;
    if entries.is_empty() { return; }
    sql.push_str(" ORDER BY ");
    for (i, (field, dir)) in entries.iter().enumerate() {
        if i > 0 { sql.push_str(", "); }
        sql.push_str(field);
        let effective = self.apply_global_modifier(*dir);
        sql.push_str(match effective {
            OrderDirection::Asc => " ASC",
            OrderDirection::Desc => " DESC",
            OrderDirection::Revert => unreachable!("revert resolved during fold"),
        });
    }
}

fn apply_global_modifier(&self, base: OrderDirection) -> OrderDirection {
    match (self.order.global, base) {
        (None, b) => b,
        (Some(OrderDirection::Asc), _) => OrderDirection::Asc,
        (Some(OrderDirection::Desc), _) => OrderDirection::Desc,
        (Some(OrderDirection::Revert), OrderDirection::Asc) => OrderDirection::Desc,
        (Some(OrderDirection::Revert), OrderDirection::Desc) => OrderDirection::Asc,
        (Some(OrderDirection::Revert), OrderDirection::Revert) => unreachable!(),
    }
}
```

**测试要点**：
- `order_empty`：entries=[], global=None → 不输出
- `order_global_revert_no_entries`：entries=[], global=Some(Revert) → 仍不输出
- `order_array_only`：entries=[(a,Asc),(b,Desc)] → " ORDER BY a ASC, b DESC"
- `order_global_revert_flips`：entries=[(a,Asc)], global=Revert → " ORDER BY a DESC"
- `order_global_asc_forces`：entries=[(a,Desc),(b,Asc)], global=Asc → " ORDER BY a ASC, b ASC"
- `order_global_desc_forces`：同上 global=Desc → " ORDER BY a DESC, b DESC"

**Test**：`cargo test -p pathql-rs --features compose compose::build::tests::order_`。

---

### S7. OFFSET / LIMIT 渲染

```rust
fn render_pagination(&self, sql: &mut String, params: &mut Vec<TemplateValue>, ctx: &TemplateContext) -> Result<(), BuildError> {
    if !self.offset_terms.is_empty() {
        sql.push_str(" OFFSET ");
        for (i, term) in self.offset_terms.iter().enumerate() {
            if i > 0 { sql.push_str(" + "); }
            sql.push('(');
            self.render_number_or_template(term, sql, params, ctx)?;
            sql.push(')');
        }
    }
    if let Some(limit) = &self.limit {
        sql.push_str(" LIMIT ");
        self.render_number_or_template(limit, sql, params, ctx)?;
    }
    Ok(())
}

fn render_number_or_template(&self, t: &NumberOrTemplate, sql: &mut String, params: &mut Vec<TemplateValue>, ctx: &TemplateContext) -> Result<(), BuildError> {
    match t {
        NumberOrTemplate::Number(n) => {
            // 字面数字直接打印, 提升 SQL 可读性 + plan cache 友好
            if n.fract() == 0.0 {
                sql.push_str(&(*n as i64).to_string());
            } else {
                sql.push_str(&n.to_string());
            }
        }
        NumberOrTemplate::Template(t) => {
            render_template_sql(&t.0, ctx, &self.aliases, sql, params)?;
        }
    }
    Ok(())
}
```

**测试要点**：
- `pagination_none`：offset_terms=[], limit=None → 不输出
- `limit_only_number`：limit=Number(100) → " LIMIT 100"
- `limit_only_template`：limit=Template("${properties.lim}"), properties={"lim":Int(50)} → " LIMIT ?", params=[Int(50)]
- `offset_single_number`：offset_terms=[Number(0)] → " OFFSET (0)"
- `offset_two_terms`：offset_terms=[Number(0), Template("${properties.x}")] → " OFFSET (0) + (?)"
- `offset_three_terms`：3 项 → " OFFSET (a) + (b) + (c)"
- `both_offset_limit`：典型场景 → " OFFSET (X) LIMIT Y"

**Test**：`cargo test -p pathql-rs --features compose compose::build::tests::pagination_`。

---

### S8. ${composed} 子查询嵌入端到端测试

构造一个完整 ProviderQuery（含 from / fields / where），先 build_sql 拿 (sub_sql, sub_params)；
再用一个外层模板 `"SELECT * FROM (${composed}) AS sub WHERE sub.x = ${properties.y}"` 跑 render_template_sql：

```rust
#[test]
fn composed_subquery_merges_params() {
    let mut inner = ProviderQuery::new();
    inner.from = Some(SqlExpr("images".into()));
    inner.wheres.push(SqlExpr("images.album_id = ${properties.aid}".into()));
    let inner_ctx = TemplateContext::default()
        .with_properties([("aid".to_string(), TemplateValue::Int(42))].into_iter().collect());
    let (sub_sql, sub_params) = inner.build_sql(&inner_ctx).unwrap();
    
    // 外层场景: 动态 list SQL 引用 ${composed}
    let outer_ctx = TemplateContext {
        composed: Some((sub_sql, sub_params)),
        properties: [("y".to_string(), TemplateValue::Int(5))].into_iter().collect(),
        ..Default::default()
    };
    let (outer_sql, outer_params) = render_to_owned(
        "SELECT * FROM (${composed}) AS sub WHERE sub.x = ${properties.y}",
        &outer_ctx,
        &AliasTable::default(),
    ).unwrap();

    // 断言:
    assert!(outer_sql.contains("(SELECT * FROM images WHERE (images.album_id = ?))"));
    assert!(outer_sql.contains("AS sub WHERE sub.x = ?"));
    assert_eq!(outer_params.len(), 2);  // 内层 aid + 外层 y
    assert_eq!(outer_params[0], TemplateValue::Int(42));
    assert_eq!(outer_params[1], TemplateValue::Int(5));
}
```

类型一致（`TemplateContext.composed: Option<(String, Vec<TemplateValue>)>`），无需任何驱动转换。

**测试要点**：上述端到端 + 嵌套 `${composed}` 内层再含 ${composed} 暂不支持的负面测试。

**Test**：`cargo test -p pathql-rs --features compose compose::build::tests::composed_`。

---

### S9. `sqlite` feature 适配器（`adapters/sqlite.rs`）

新建 `src/adapters/sqlite.rs`（feature `sqlite` 下编译）：

```rust
//! SQLite (rusqlite) 驱动适配器。
//!
//! 把 dialect-agnostic 的 `Vec<TemplateValue>` 桥接到 `Vec<rusqlite::types::Value>`,
//! 让 core 能直接喂给 `stmt.execute(rusqlite::params_from_iter(...))`。

#![cfg(feature = "sqlite")]

use rusqlite::types::Value;
use crate::template::eval::TemplateValue;

/// 单值转换。
pub fn to_rusqlite(v: &TemplateValue) -> Value {
    match v {
        TemplateValue::Null => Value::Null,
        TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        TemplateValue::Int(i) => Value::Integer(*i),
        TemplateValue::Real(r) => Value::Real(*r),
        TemplateValue::Text(s) => Value::Text(s.clone()),
        TemplateValue::Json(v) => Value::Text(v.to_string()),
    }
}

/// 批量转换便利函数。
pub fn params_for(values: &[TemplateValue]) -> Vec<Value> {
    values.iter().map(to_rusqlite).collect()
}
```

更新 `src/adapters/mod.rs`：

```rust
#[cfg(feature = "json5")]
pub mod json5;
#[cfg(feature = "json5")]
pub use json5::Json5Loader;

#[cfg(feature = "sqlite")]
pub mod sqlite;
```

更新 `src/lib.rs`：

```rust
#[cfg(feature = "sqlite")]
pub use adapters::sqlite as sqlite_adapter;  // 或直接 `pub mod sqlite_adapter;`
```

**测试要点**（`adapters/sqlite.rs` 内 `#[cfg(test)]`）：

| 测试名 | 输入 | 期望 rusqlite Value |
|---|---|---|
| `null_to_null` | TemplateValue::Null | Value::Null |
| `bool_true_to_int_1` | Bool(true) | Integer(1) |
| `bool_false_to_int_0` | Bool(false) | Integer(0) |
| `int_to_int` | Int(42) | Integer(42) |
| `real_to_real` | Real(3.14) | Real(3.14) |
| `text_to_text` | Text("hello") | Text("hello") |
| `json_to_text_serialized` | Json(json!({"k":"v"})) | Text("{\"k\":\"v\"}") |
| `params_for_batch` | vec![Int(1), Text("a")] | [Integer(1), Text("a")] |

**Test**：`cargo test -p pathql-rs --features sqlite adapters::sqlite`。

---

### S10. 真路径链 fold + build_sql 集成测试 + sqlite 执行（`tests/build_real_chain.rs`）

承接 Phase 4 的 `tests/fold_real_chain.rs`：fold 完一条路径链得 ProviderQuery；build_sql 渲染并对 SQL 字符串与 params 做 snapshot 断言；最后通过 sqlite 适配器在 in-memory SQLite 上执行验证。

```rust
#![cfg(all(feature = "json5", feature = "compose", feature = "sqlite"))]

use pathql_rs::adapters::sqlite::params_for;
use pathql_rs::compose::{fold_contrib, ProviderQuery};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
// ...

#[test]
fn build_gallery_page_chain_renders_executable_sql() {
    let registry = build_full_registry();
    let mut state = ProviderQuery::new();

    // fold 链 (跳过 DelegateQuery 节点; Phase 6 真实 runtime 会重定向)
    // gallery_route -> gallery_paginate_router -> query_page_provider
    // ...

    let ctx = TemplateContext::default()
        .with_properties([
            ("page_size".into(), TemplateValue::Int(100)),
            ("page_num".into(), TemplateValue::Int(1)),
        ].into_iter().collect());

    let (sql, params) = state.build_sql(&ctx).unwrap();
    
    // 1. 字符串 snapshot 断言
    assert!(sql.contains("FROM images"));
    assert!(sql.contains("LIMIT"));
    
    // 2. sqlite 执行验证 (in-memory)
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE images (id INTEGER PRIMARY KEY, title TEXT)").unwrap();
    conn.execute("INSERT INTO images (title) VALUES (?), (?)", ["a", "b"]).unwrap();
    
    let mut stmt = conn.prepare(&sql).unwrap();
    let rusqlite_params = params_for(&params);
    let rows: Vec<i64> = stmt
        .query_map(rusqlite::params_from_iter(rusqlite_params.iter()), |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    
    // 应至少返回 0+ 行 (取决于 limit/offset)
    assert!(rows.len() <= 100);
}
```

**测试要点**：选 1-2 条真实路径，校准期望 SQL，断言 build_sql 输出 + sqlite 执行 0 错。

**Test**：`cargo test -p pathql-rs --features "json5 compose sqlite" --test build_real_chain`。

---

## 完成标准

- [ ] `cargo test -p pathql-rs` 全绿（Phase 1）
- [ ] `cargo test -p pathql-rs --features json5` 全绿
- [ ] `cargo test -p pathql-rs --features validate` 全绿
- [ ] `cargo test -p pathql-rs --features compose` 全绿（**无 rusqlite**）
- [ ] `cargo test -p pathql-rs --features sqlite` 全绿（含 rusqlite 适配器）
- [ ] `cargo test -p pathql-rs --features "json5 validate compose sqlite"` 全绿（全部）
- [ ] `cargo build -p pathql-rs --features compose` warning 清零；产物**不包含** rusqlite 库
- [ ] `cargo build -p pathql-rs --features sqlite` warning 清零；产物含 rusqlite + 适配器
- [ ] core 仍未引用 pathql-rs

## 风险点

1. **TemplateContext.composed 类型固化**：本期决定为 `Option<(String, Vec<TemplateValue>)>`，与 build_sql 输出 `Vec<TemplateValue>` 对齐，无需跨类型转换。Phase 6 runtime 注入 composed 时直接传 build_sql 结果。
2. **bind param 顺序错位**：build_sql 渲染顺序 SELECT → FROM → JOIN → WHERE → ORDER → OFFSET → LIMIT；任意阶段调 render_template_sql 时同步 push params。S10 集成测试是关键回归 net。
3. **OrderDirection::Revert 在 entries 出现**：本期假设 Phase 4 fold 已解析为 Asc/Desc。若未解析则 render 期 unreachable! 触发 panic；建议改为 BuildError 或 debug_assert。
4. **Number 字面 vs Bind**：本期把字面 number（NumberOrTemplate::Number）直接打印到 SQL（而非 bind），出于可读性 + plan cache 友好。如未来发现非整数 / 浮点边界问题，改为 bind。
5. **${composed} 嵌套深度**：当前实现支持单层注入；嵌套（动态 list SQL 内的子查询又含 ${composed}）需要 Phase 6 runtime 在每层之间重新渲染 + 重新喂入 ctx.composed。Phase 5 不主动处理嵌套。
6. **sqlite 适配器只是 1 对 1 数据映射**：不做 schema 适配 / 类型推断。core 在 Phase 6 直接调 `params_for(&values)` 转给 rusqlite。不替 core 写 prepare/query 流程。
7. **`?` 占位 vs 命名占位**：本期统一用 `?` 位置占位。如果未来要加 PostgreSQL 适配器（`$1`/`$2` 占位）就需要在 build_sql 阶段做占位风格切换；可作为 build_sql 的可选参数（`PlaceholderStyle { Question, Numbered }`）日后扩展。当前 sqlite 适配器只接受 `?` 形式。

## 完成 Phase 5 后的下一步

Phase 6：把 `pathql-rs` 接入 `kabegame-core`。改 Provider trait 签名为 `fn apply_query(current: ProviderQuery) -> ProviderQuery`；现有 15+ 硬编码 provider 全部迁移；删除 ImageQuery 类型；`runtime.rs` 用 include_dir 嵌入 + 启动期遍历加载 + validate；DslProvider 实现 Provider trait（用 fold + build_sql + sqlite 适配器跑完一条路径）；缓存规则按 RULES §4.4 调整。core 启用 pathql-rs 的 feature 集：`["json5", "validate", "compose", "sqlite"]`。
