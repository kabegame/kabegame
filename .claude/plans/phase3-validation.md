# Phase 3 详细计划 — 加载期语义校验（pathql-rs `validate` feature）

## Context

承接 Phase 1（AST + Loader + Registry）与 Phase 2（json5 适配器）。所有 .json5 文件可加载并注册成功，
但 schema 通不过的反样本不一定都被 serde 拒绝——schema 之外的语义合约（RULES.md §10）尚未实现。

Phase 3 的目标：实现 RULES.md §10 全部校验项，作为 `pathql-rs` 的 `validate` feature。
失败时返回 `Result<(), Vec<ValidateError>>`，由消费者（Phase 6 的 core）在加载完所有 provider 后触发，
失败 panic 启动并打印全部错误。

**职责分配**：
- pathql-rs 提供 `validate(&ProviderRegistry) -> Result<(), Vec<ValidateError>>` 入口
- 消费者负责调用时机（startup-once）与错误处理（panic / log）
- pathql-rs **不**校验 "name 字段等于文件名"——它看不到文件名（include_dir 字节流不带逻辑名）；这条转为消费者侧职责（core 在 include_dir 遍历时配 `entry.path().file_stem()` vs `def.name` 自检）

约束：
- 全新 deps（sqlparser / regex / regex-automata）**仅**在 `validate` feature 下编译
- `template` 模块（`${...}` 解析器）**不**走 feature 门——它无外部 dep，永久编译；后续 Phase 5 的 evaluator 也复用这个 parser
- 9 个真实 provider 文件必须通过 validate

---

## RULES.md §10 校验项清点（实现目标）

| # | 类别 | 校验项 | 落地子任务 |
|---|---|---|---|
| 1 | 命名 | `<namespace>.<name>` 全局唯一 | S3（registry 已强制） |
| 2 | 命名 | `namespace` / `name` 符合 pattern | S4 |
| 3 | ContribQuery | `${ref:X}` 都能在同 query 的 `join.as` / `fields.as` 找到定义 | S4 |
| 4 | ContribQuery | `as: "${ref:...}"` 不与 `in_need: true` 同时出现 | S4 |
| 5 | ContribQuery | `from` 内含 JOIN 关键字 → warn | S4 |
| 6 | DynamicListEntry | key / properties 中 `${X.Y}` 的 X 等于 `child_var` 或 `data_var` | S4 |
| 7 | DynamicListEntry | SQL 模式不出现 `${data_var.provider}` | S4 |
| 8 | DynamicListEntry | `child_var` / `data_var` 不是保留标识符 | S4 |
| 9 | PathExpr | 起始 `./`、不含 `..` 段 | S4 |
| 10 | SqlExpr | sqlparser SQLite 方言；多语句 / DDL 拒绝 | S5 |
| 11 | SqlExpr | from / join.table 字面表名在白名单（子查询豁免） | S5（接受表白名单注入） |
| 12 | Resolve | 每条 key 编译为合法正则 | S6 |
| 13 | Resolve | 正则 vs 静态 list key 字面 → 任一匹配拒绝 | S6 |
| 14 | Resolve | 正则 vs 正则 → regex-automata 交集为空 | S6 |
| 15 | Resolve | `${capture[N]}` 的 N ≤ 捕获组数 | S6 |
| 16 | Cross-provider | `ProviderInvocation.provider` 在 registry 命名空间链能解析 | S7 |
| 17 | Meta | 字符串视为 SQL 时校验单 SELECT；视为模板时 scope 校验 | 走 S5 (SQL) + S2 (template scope) 联动 |
| 18 | Meta | 对象/数组递归 scope 校验 | S2/S4 联动 |

---

## 锁定的设计选择

1. **Feature 名 `validate`**：默认关闭，按需启用。pulls in `regex` / `regex-automata` / `sqlparser`。
2. **Template parser 永久在线（无 feature gate）**：模块 `src/template/parse.rs`，0 外部 dep；scope 校验函数（`validate_scope`）也在此模块。Phase 5 的 evaluator 在 `compose` feature 下另写。
3. **错误类型 `ValidateError`**：含 provider 全限定名、字段路径（如 `query.fields[2].as`）、原因 enum。批量返回 `Vec<ValidateError>`，不 short-circuit。
4. **白名单表名注入**：`fn validate(registry, &ValidateConfig)`，`ValidateConfig { table_whitelist: HashSet<String> }`。pathql-rs 不硬编码（不知道 kabegame 的表名）；调用方（core）传入；测试默认空集，所有字面表名都拒绝（除子查询）；可放宽为 `None` 表示跳过白名单检查（默认）。
5. **SQL 占位符策略**：sqlparser 不认 `${...}`；validate 时把 `${...}` token 替换为 `:p0`、`:p1` 等冒号占位，sqlparser 的 SQLite 方言能解析这种命名 bind param；解析后丢弃 AST，只看是否成功 + 是否单语句 + 是否 DDL。
6. **Reserved identifiers**：`properties` / `capture` / `composed` / `ref` / `out` / `_`（RULES §8）；定义为常量数组在 `validate/reserved.rs`。
7. **测试组织**：每个 validator 函数自带单测（小 fixture）；S8 整体 `validate(&Registry)` 入口测试用大 fixture 覆盖多种错误并断言错误数量与类型；S9 真 9 个 provider 通过。

---

## 测试节奏

**每完成一个子任务就立即跑一次 `cargo test -p pathql-rs --features validate`**——不要积攒。

---

## 子任务拆解

### S1. 启用 `validate` feature 与依赖

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

[features]
default = []
json5 = ["dep:json5"]
validate = ["dep:regex", "dep:regex-automata", "dep:sqlparser"]
```

如根 [`Cargo.toml`](../../Cargo.toml) 缺这些 deps，加进 `[workspace.dependencies]` 并改 pathql-rs 用 `{ workspace = true, optional = true }`。

**测试要点**：feature 开关编译。

**Test**：
- `cargo check -p pathql-rs` —— 默认 feature 关，通过
- `cargo check -p pathql-rs --features validate` —— validate feature 开但模块未实现，通过（dep unused 是 warning 不是 error）
- `cargo check -p pathql-rs --features "json5 validate"` —— 双 feature 并存，通过

---

### S2. 模板解析器（`src/template/parse.rs`，永久在线）

`${...}` 表达式解析器。**不做求值**，只产出结构化 AST 供 validate / Phase 5 evaluator 复用。

```rust
//! 模板表达式解析器: ${...} 语法分析。0 外部 dep, 永久编译。

use std::fmt;
use thiserror::Error;

/// 解析后的模板：可能是纯字面或字面+变量片段交错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateAst {
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Var(VarRef),
}

/// `${...}` 内的引用形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarRef {
    /// `${ns}` — 裸命名空间访问（如 `${composed}`）
    Bare { ns: String },
    /// `${ns.path.to.field}` — 点访问
    Path { ns: String, path: Vec<String> },
    /// `${ns[N]}` — 索引访问（仅 capture）
    Index { ns: String, index: usize },
    /// `${method:arg}` — 方法标记
    Method { name: String, arg: String },
}

#[derive(Debug, Error)]
pub enum ParseError {
    #[error("unclosed ${{...}} starting at offset {0}")]
    Unclosed(usize),
    #[error("nested ${{${{...}}}} not allowed at offset {0}")]
    Nested(usize),
    #[error("empty ${{}} at offset {0}")]
    Empty(usize),
    #[error("invalid syntax in ${{...}} at offset {offset}: {msg}")]
    Invalid { offset: usize, msg: String },
}

pub fn parse(input: &str) -> Result<TemplateAst, ParseError> {
    // 状态机扫描:
    // - 遇到 `${`: 进入变量模式; 找到匹配的 `}` (拒绝嵌套 `${`)
    // - 否则: 累积到当前 Text segment
    // 变量内部按形态分流:
    //   - 含 `:` → Method
    //   - 含 `[` → Index
    //   - 含 `.` → Path
    //   - 否则 → Bare
    todo!()
}

/// 校验模板表达式中所有 VarRef 的命名空间在 `allowed` 里。
pub fn validate_scope(
    ast: &TemplateAst,
    allowed_ns: &[&str],
    allowed_methods: &[&str],
) -> Result<(), ScopeError> {
    todo!()
}

#[derive(Debug, Error)]
pub enum ScopeError {
    #[error("variable `${{{0}}}` not allowed in this context (allowed: {1:?})")]
    UnknownNamespace(String, Vec<String>),
    #[error("method `${{{0}:...}}` not allowed in this context (allowed: {1:?})")]
    UnknownMethod(String, Vec<String>),
}
```

**新建** `src/template/mod.rs`：

```rust
pub mod parse;
pub use parse::{TemplateAst, Segment, VarRef, ParseError, parse, validate_scope, ScopeError};
```

更新 `src/lib.rs` 加 `pub mod template;`。

**测试要点**（`template/parse.rs` 内 `#[cfg(test)]`）：

| 测试名 | 输入 | 期望 |
|---|---|---|
| `pure_text` | `"hello world"` | 1 个 Text segment |
| `single_bare` | `"${composed}"` | 1 个 Var(Bare{ns:"composed"}) |
| `single_path` | `"${properties.album_id}"` | Path{ns:"properties", path:["album_id"]} |
| `nested_path` | `"${plugin.meta.info.name}"` | Path{ns:"plugin", path:["meta","info","name"]} |
| `index` | `"${capture[1]}"` | Index{ns:"capture", index:1} |
| `method` | `"${ref:my_id}"` | Method{name:"ref", arg:"my_id"} |
| `mixed` | `"${a.b}-${c}"` | 4 segments: Var, Text("-"), Var |
| `escape_lit` | `"${a.b}suffix${c}"` | 含 Text("suffix") |
| `unclosed` | `"${a"` | `Err(Unclosed)` |
| `nested_disallowed` | `"${${x}.y}"` | `Err(Nested)` |
| `empty_braces` | `"${}"` | `Err(Empty)` |
| `bad_index` | `"${capture[abc]}"` | `Err(Invalid)` |
| `scope_ok` | `parse("${properties.x}")`, allowed=`["properties"]` | `Ok` |
| `scope_unknown_ns` | 同上, allowed=`["composed"]` | `Err(UnknownNamespace)` |
| `scope_method_ok` | `parse("${ref:x}")`, allowed_methods=`["ref"]` | `Ok` |
| `scope_method_bad` | 同上, allowed_methods=`[]` | `Err(UnknownMethod)` |

**Test**：`cargo test -p pathql-rs template`。

---

### S3. 错误类型 + Validator 入口骨架（`validate/mod.rs` + `validate/error.rs`）

新建 `src/validate/mod.rs`：

```rust
//! 加载期语义校验。RULES.md §10。
//!
//! 入口: `validate(registry, &cfg)`。失败返回 Vec<ValidateError> (不 short-circuit).

#[cfg(feature = "validate")]
pub mod error;

#[cfg(feature = "validate")]
pub mod config;

#[cfg(feature = "validate")]
pub use error::{ValidateError, ValidateErrorKind};

#[cfg(feature = "validate")]
pub use config::ValidateConfig;

#[cfg(feature = "validate")]
pub fn validate(
    registry: &crate::ProviderRegistry,
    cfg: &ValidateConfig,
) -> Result<(), Vec<ValidateError>> {
    let mut errors = Vec::new();
    // S4 / S5 / S6 / S7 / S8 各自的 validator 在这里依次调用并 push 进 errors
    // 暂时只调 S4 的简单校验 (本步留为 stub)
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}
```

新建 `src/validate/error.rs`：

```rust
use thiserror::Error;
use crate::ast::{Namespace, SimpleName};

#[derive(Debug, Error)]
#[error("{provider}: {field}: {kind}")]
pub struct ValidateError {
    pub provider: String,           // "kabegame.gallery_route"
    pub field: String,              // "query.fields[2].as"
    pub kind: ValidateErrorKind,
}

#[derive(Debug, Error)]
pub enum ValidateErrorKind {
    #[error("invalid pattern: {0}")]
    InvalidPattern(String),
    #[error("template parse error: {0}")]
    TemplateParse(#[from] crate::template::ParseError),
    #[error("template scope error: {0}")]
    TemplateScope(#[from] crate::template::ScopeError),
    #[error("undefined ${{ref:{0}}} - no matching as in same query")]
    UndefinedRef(String),
    #[error("`as: ${{ref:...}}` cannot coexist with `in_need: true`")]
    RefAliasWithInNeed,
    #[error("`from` clause should not contain JOIN keyword (use `join[]` instead)")]
    FromContainsJoin,
    #[error("dynamic list entry: ${{X.Y}} prefix `{0}` does not match {1}_var `{2}`")]
    DynamicVarMismatch(String, &'static str, String),
    #[error("dynamic SQL list entry cannot reference ${{data_var.provider}}")]
    DynamicSqlProviderRef,
    #[error("reserved identifier `{0}` cannot be used as binding")]
    ReservedIdent(String),
    #[error("path expression must start with `./` and not contain `..`")]
    InvalidPathExpr,
    #[error("invalid namespace pattern: {0}")]
    InvalidNamespace(String),
    #[error("invalid name pattern: {0}")]
    InvalidName(String),
    #[error("SQL parse error: {0}")]
    SqlParseError(String),
    #[error("multiple SQL statements not allowed")]
    SqlMultipleStatements,
    #[error("DDL not allowed: {0}")]
    SqlDdlNotAllowed(String),
    #[error("table `{0}` not in whitelist")]
    TableNotWhitelisted(String),
    #[error("regex compile error: {0}")]
    RegexCompileError(String),
    #[error("regex `{0}` matches static list key `{1}`")]
    RegexMatchesStatic(String, String),
    #[error("regex `{0}` and regex `{1}` overlap")]
    RegexIntersection(String, String),
    #[error("${{capture[{idx}]}} out of bounds (regex has {groups} group(s))")]
    CaptureIndexOutOfBounds { idx: usize, groups: usize },
    #[error("provider reference `{0}` not found in registry (current_ns: {1})")]
    UnresolvedProviderRef(String, String),
}
```

新建 `src/validate/config.rs`：

```rust
use std::collections::HashSet;

/// 校验配置。调用方按需注入。
#[derive(Debug, Clone, Default)]
pub struct ValidateConfig {
    /// 表名白名单。`None` = 跳过白名单检查（开发期默认）。
    /// 生产环境调用方应注入完整集合。
    pub table_whitelist: Option<HashSet<String>>,
    /// 保留标识符。默认走 RULES §8。
    pub reserved_idents: HashSet<&'static str>,
}

impl ValidateConfig {
    pub fn with_default_reserved() -> Self {
        let reserved = ["properties", "capture", "composed", "ref", "out", "_"]
            .into_iter()
            .collect();
        Self {
            table_whitelist: None,
            reserved_idents: reserved,
        }
    }
}
```

更新 `src/lib.rs` 加 `pub mod validate;` + 条件 re-export。

**测试要点**：入口骨架编译；空 registry → `Ok(())`。

**Test**：`cargo test -p pathql-rs --features validate validate::`。

---

### S4. 简单 per-provider 校验（`validate/simple.rs`）

不需要 sqlparser / regex 的检查项：

- **2** namespace / name pattern：`^[a-z][a-z0-9_]*$` simple name；`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` namespace
- **3** ContribQuery `${ref:X}` 引用：扫描 join.on / where / fields.sql / fields.as / join.as 中所有 ref，检查 ident 在同一 query 的 join.as / fields.as 字面别名表中
- **4** `as: ${ref:...}` 不与 `in_need: true` 共存
- **5** ContribQuery from 含 JOIN：简单 `to_uppercase().contains(" JOIN ")` 检查；触发 warn（用 `ValidateErrorKind::FromContainsJoin`，但调用方可按 kind 分级）
- **6** DynamicListEntry：扫 key / properties 模板，找出所有 `${X.Y}` 的 X，断言 == child_var/data_var
- **7** DynamicListEntry SQL：扫 key / properties / sql 中是否含 `${data_var.provider}` 形态，禁止
- **8** Reserved identifier：child_var / data_var ∈ reserved_idents → 拒绝
- **9** PathExpr 结构：`starts_with("./") && !contains("/../") && !contains("..")` 

模块入口：

```rust
pub fn validate_simple(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter() {
        validate_names(ns, name, def, errors);
        validate_query_refs(ns, name, def, errors);
        validate_dynamic_entries(ns, name, def, cfg, errors);
        validate_path_exprs(ns, name, def, errors);
    }
}
```

每个子函数独立模块文件（`validate/names.rs` / `validate/query_refs.rs` / `validate/dynamic.rs` / `validate/paths.rs`）。

**测试要点**（每个子模块独立测）：

| 子模块 | 测试名 | 输入 (synthetic ProviderDef) | 期望 |
|---|---|---|---|
| names | `valid_simple_name` | name = "foo_bar" | OK |
| names | `bad_capital` | name = "FooBar" | InvalidName |
| names | `valid_namespace` | ns = "kabegame.plugin.x" | OK |
| names | `bad_namespace_dotstart` | ns = ".kabegame" | InvalidNamespace |
| query_refs | `ref_resolves` | join.on = "${ref:t1}", join.as = "${ref:t1}" | OK |
| query_refs | `ref_undefined` | join.on = "${ref:nope}" | UndefinedRef |
| query_refs | `ref_with_in_need` | as = "${ref:t}", in_need = true | RefAliasWithInNeed |
| query_refs | `from_with_join` | from = "images JOIN album_images ai" | FromContainsJoin |
| dynamic | `var_match_data` | key = "${row.id}", data_var = "row" | OK |
| dynamic | `var_mismatch` | key = "${out.id}", data_var = "row" | DynamicVarMismatch |
| dynamic | `sql_provider_ref` | properties = {x: "${row.provider}"} | DynamicSqlProviderRef |
| dynamic | `reserved_data_var` | data_var = "ref" | ReservedIdent |
| paths | `valid_path` | "./foo/bar" | OK |
| paths | `parent_segment` | "./../foo" | InvalidPathExpr |
| paths | `absolute_path` | "/foo" | InvalidPathExpr |

**Test**：`cargo test -p pathql-rs --features validate validate::names validate::query_refs validate::dynamic validate::paths`。

---

### S5. SQL 校验（`validate/sql.rs`）

`sqlparser` v0.51，`SQLiteDialect`。流程：

1. 把 SqlExpr 中的 `${...}` token 替换为 `:p0`、`:p1`（顺序编号）；记录原 ${...} 不参与解析
2. `Parser::parse_sql(&dialect, &replaced)` → `Vec<Statement>`
3. 检查：
   - len > 1 → SqlMultipleStatements
   - 任一 Statement 是 DDL（CREATE / DROP / ALTER / TRUNCATE / RENAME / GRANT 等）→ SqlDdlNotAllowed
   - 收集所有 table reference name；非子查询的字面表名查 `cfg.table_whitelist`（若 `Some`）

```rust
pub fn validate_sql_exprs(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter() {
        // 遍历 def 内所有 SqlExpr 出现位置: query.from / query.fields[].sql /
        // query.join[].table / query.join[].on / query.where_ / list 动态项的 sql / meta string
        // 每处调 validate_one_sql(...)
    }
}

fn validate_one_sql(
    sql: &SqlExpr,
    field_path: &str,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    let stripped = replace_template_with_placeholder(&sql.0);
    use sqlparser::dialect::SQLiteDialect;
    use sqlparser::parser::Parser;
    let dialect = SQLiteDialect {};
    match Parser::parse_sql(&dialect, &stripped) {
        Err(e) => errors.push(SqlParseError(e.to_string())),
        Ok(stmts) if stmts.len() > 1 => errors.push(SqlMultipleStatements),
        Ok(stmts) => {
            for s in &stmts {
                if is_ddl(s) {
                    errors.push(SqlDdlNotAllowed(...));
                }
                if let Some(wl) = &cfg.table_whitelist {
                    for t in extract_literal_tables(s) {
                        if !wl.contains(&t) {
                            errors.push(TableNotWhitelisted(t));
                        }
                    }
                }
            }
        }
    }
}
```

`extract_literal_tables` 走 sqlparser AST，找 `TableFactor::Table { name, .. }` 节点（非 `TableFactor::Derived`/`TableFactor::NestedJoin` 子查询）。

**测试要点**：

| 测试名 | 输入 SQL | 期望 |
|---|---|---|
| `select_simple` | `"SELECT 1"` | OK |
| `select_with_template` | `"SELECT * FROM images WHERE id = ${properties.id}"` | OK（template 替换为 `:p0`） |
| `multi_stmt` | `"SELECT 1; SELECT 2"` | SqlMultipleStatements |
| `ddl_create` | `"CREATE TABLE t (x INT)"` | SqlDdlNotAllowed |
| `ddl_drop` | `"DROP TABLE images"` | SqlDdlNotAllowed |
| `injection_comment` | `"SELECT 1; -- comment"` | SqlMultipleStatements 或 ParseError |
| `bad_syntax` | `"SELECT FROM"` | SqlParseError |
| `whitelist_pass` | `"SELECT * FROM images"`, wl={"images"} | OK |
| `whitelist_fail` | 同上, wl={"tasks"} | TableNotWhitelisted |
| `whitelist_subquery_exempt` | `"SELECT * FROM (SELECT id FROM images) sub"` 当 `sub` 是 derived 子查询 | OK（白名单只查字面，不递归） |
| `whitelist_none_skips` | wl=None | 任意表名 OK |

**Test**：`cargo test -p pathql-rs --features validate validate::sql`。

---

### S6. Resolve 校验（`validate/resolve_check.rs`）

依赖 `regex`（编译）+ `regex-automata`（交集）。

1. 编译每条 `resolve` key 为 `regex::Regex`，失败 → `RegexCompileError`
2. 对每条正则，扫 list 静态 key 字面，断言无字面匹配 → `RegexMatchesStatic`
3. 对任意两条正则用 regex-automata 求交集 NFA，若交集语言非空 → `RegexIntersection`
4. 解析 resolve value 内的 `${capture[N]}`（重用 S2 的 template parser），断言 N ≤ 编译后正则的捕获组数（`Regex::captures_len() - 1`，0 是全匹配位）

```rust
pub fn validate_resolve(
    registry: &ProviderRegistry,
    errors: &mut Vec<ValidateError>,
) {
    for ((_ns, _name), def) in registry.iter() {
        let Some(resolve) = &def.resolve else { continue };
        let Some(list) = &def.list else { /* still validate intra-resolve */ ... };
        // 1) compile each
        // 2) regex vs static literal
        // 3) regex vs regex (pairwise intersection)
        // 4) capture[N] bounds
    }
}
```

regex-automata 交集：
```rust
use regex_automata::{nfa::thompson::NFA, hybrid::dfa::DFA};
let nfa_a = NFA::compile(pattern_a)?;
let nfa_b = NFA::compile(pattern_b)?;
// 交集 = product NFA / DFA; 测试是否接受任意串
// regex-automata 0.4 API 需 spike 一下确认; 退路: 转换为 DFA 用 product construction 检查可达接受态
```

⚠️ **风险点**：regex-automata v0.4 没有现成的 "判断两个正则的交集是否非空" API；需要 spike 实际怎么写。退路方案：用 `regex::Regex::find` 互测——`re_a.find(re_b_sample) || re_b.find(re_a_sample)`，但 sample 需要自己生成；不可靠。**建议在 S6 开始前 spike 30 分钟确认 API 形态**，必要时退化为 "暴力枚举 list/resolve 静态字面 + 用 regex 互测" 的近似方案，并在文档注明已知漏检。

**测试要点**：

| 测试名 | 输入 | 期望 |
|---|---|---|
| `valid_resolve` | `{"^x([0-9]+)$": ByName("foo")}` | OK |
| `invalid_regex` | `{"[unclosed": ...}` | RegexCompileError |
| `regex_matches_static` | resolve `{"x([0-9]+)x": ...}` + list `{"x100x": ...}` | RegexMatchesStatic |
| `regex_pair_overlap` | `{"a.*": ..., "ab.*": ...}` | RegexIntersection |
| `capture_in_bounds` | `{"^(.+)$": properties = {x: "${capture[1]}"}}` | OK |
| `capture_out_of_bounds` | 同上 + `${capture[5]}` | CaptureIndexOutOfBounds{idx:5,groups:1} |

**Test**：`cargo test -p pathql-rs --features validate validate::resolve_check`。

---

### S7. 跨 provider 引用校验（`validate/cross_ref.rs`）

简单实现：遍历所有 `ProviderInvocation::ByName` 出现位置（list 静态项 / list 动态 sql 模式 / resolve 项 / DynamicDelegate 命名 provider），调 `registry.resolve(current_ns, ref)` 命中即过，否则 `UnresolvedProviderRef`。

`InvokeByDelegate` 路径不查 registry（它是路径表达式，由运行期 resolve；但路径段第一段对应的目标 provider 至少要存在——这条转为 Phase 6 runtime 责任，validate 不强校验）。

`${child_var.provider}` 透传形态不查（运行期 child 决定）。

```rust
pub fn validate_cross_refs(
    registry: &ProviderRegistry,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, _name), def) in registry.iter() {
        // 收集所有 ByName 引用 + DynamicSqlEntry.provider + DynamicDelegateEntry.provider (Name variant)
        for r in collect_refs(def) {
            if registry.resolve(ns, &r.name).is_none() {
                errors.push(UnresolvedProviderRef(r.name.0, ns.0.clone()));
            }
        }
    }
}
```

**测试要点**：
- `resolve_hits_same_ns`：注册 `kabegame.foo` + `kabegame.bar` 引用 `foo` → OK
- `resolve_hits_parent`：注册 `kabegame.foo` + `kabegame.plugin.x` 引用 `foo` → OK
- `unresolved`：引用 `nonexistent` → `UnresolvedProviderRef`
- `delegate_path_skipped`：`InvokeByDelegate { delegate: "./not/here" }` → 不报错（运行期负责）

**Test**：`cargo test -p pathql-rs --features validate validate::cross_ref`。

---

### S8. Meta 字段校验（`validate/meta_check.rs`）

`MetaValue` (= `serde_json::Value`) 递归校验：

- **String**：启发式判断 SQL vs 模板
  - 含 SQL 关键字（SELECT / FROM / UPDATE 等，case-insensitive）→ 走 SQL validator（S5）
  - 仅含 `${...}` + 标点 → 走 template scope validator（S2）
  - 都不像 → 当作普通字符串字面，无校验（也不报错——`meta: "anything"` 合法）
- **Object / Array**：递归对每个 value 重复上述逻辑
- **Number / Bool / Null**：跳过

```rust
pub fn validate_meta(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter() {
        // 收集所有 meta 出现位置: list 静态 / 动态 / resolve 项的 meta 字段
        for (location, meta) in collect_metas(def) {
            walk_meta(meta, &location, cfg, errors);
        }
    }
}

fn walk_meta(
    v: &serde_json::Value,
    field_path: &str,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    match v {
        serde_json::Value::String(s) => {
            if looks_like_sql(s) {
                validate_one_sql(&SqlExpr(s.clone()), field_path, cfg, errors);
            } else if s.contains("${") {
                match crate::template::parse(s) {
                    Ok(ast) => {
                        // scope check 由 collect_metas 提供的 "可用 namespace" 决定
                        // 静态项 meta: properties + capture
                        // 动态 sql meta: properties + data_var
                        // 动态 delegate meta: properties + child_var
                    }
                    Err(e) => errors.push(... TemplateParse(e) ...),
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (k, child) in map {
                walk_meta(child, &format!("{}.{}", field_path, k), cfg, errors);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, child) in arr.iter().enumerate() {
                walk_meta(child, &format!("{}[{}]", field_path, i), cfg, errors);
            }
        }
        _ => {} // numbers / bool / null skip
    }
}

fn looks_like_sql(s: &str) -> bool {
    let upper = s.to_uppercase();
    ["SELECT ", " FROM ", " WHERE ", "UPDATE ", "INSERT ", "DELETE "]
        .iter()
        .any(|kw| upper.contains(kw))
}
```

**测试要点**：
- `meta_sql_string`：`"SELECT * FROM albums WHERE id = ${capture[1]}"` → 走 SQL validator
- `meta_template_only`：`"${child_var.meta}"` → 走 scope validator
- `meta_object_recurse`：`{"id": "${properties.id}", "k": "v"}` → 内部模板做 scope
- `meta_array_recurse`：`["${a.b}", "literal"]` → 第一项做 scope
- `meta_scalar_skip`：`{"count": 42}` → 跳过
- `meta_bad_sql`：`"DROP TABLE x"` → SqlDdlNotAllowed
- `meta_bad_scope`：`"${unknown_ns.x}"` 在静态 resolve 项里 → TemplateScope error

**Test**：`cargo test -p pathql-rs --features validate validate::meta_check`。

---

### S9. validate 入口装配 + 真 9 文件通过 + 综合 bad fixture

完善 `validate/mod.rs::validate`：

```rust
pub fn validate(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
) -> Result<(), Vec<ValidateError>> {
    let mut errors = Vec::new();
    simple::validate_simple(registry, cfg, &mut errors);
    sql::validate_sql_exprs(registry, cfg, &mut errors);
    resolve_check::validate_resolve(registry, &mut errors);
    cross_ref::validate_cross_refs(registry, &mut errors);
    meta_check::validate_meta(registry, cfg, &mut errors);
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
```

新建集成测试 `tests/validate_real.rs`：

```rust
#![cfg(all(feature = "json5", feature = "validate"))]

#[test]
fn all_real_providers_validate_clean() {
    let registry = build_full_registry();  // 复用 Phase 2 的辅助
    let cfg = ValidateConfig::with_default_reserved();  // 默认 table_whitelist = None
    pathql_rs::validate::validate(&registry, &cfg)
        .unwrap_or_else(|errs| {
            for e in &errs { eprintln!("  {}", e); }
            panic!("expected clean validate, got {} errors", errs.len());
        });
}
```

新建 `tests/validate_bad_fixtures.rs`：18 条 bad fixture（每条对应 RULES §10 一类错），构造小 ProviderDef → register → validate → 断言对应错误 kind 出现：

| Fixture | 期望错误 kind |
|---|---|
| `{"name":"BAD_CAPS"}` | InvalidName |
| `{"name":"foo","namespace":".bad"}` | InvalidNamespace |
| undefined ref | UndefinedRef |
| ref + in_need | RefAliasWithInNeed |
| from with JOIN | FromContainsJoin |
| dynamic var mismatch | DynamicVarMismatch |
| sql provider ref | DynamicSqlProviderRef |
| reserved data_var | ReservedIdent |
| `..` in path | InvalidPathExpr |
| multi-stmt SQL | SqlMultipleStatements |
| DDL SQL | SqlDdlNotAllowed |
| invalid regex in resolve | RegexCompileError |
| regex matches static | RegexMatchesStatic |
| regex overlap | RegexIntersection |
| capture out of bounds | CaptureIndexOutOfBounds |
| unresolved provider ref | UnresolvedProviderRef |
| meta DDL | SqlDdlNotAllowed |
| meta bad scope | TemplateScope |

**测试要点**：
- 真 9 个 provider 0 错误
- 18 条 bad fixture 各命中预期 kind

**Test**：
- `cargo test -p pathql-rs --features "json5 validate" --test validate_real`
- `cargo test -p pathql-rs --features validate --test validate_bad_fixtures`

---

## 完成标准

- [ ] `cargo test -p pathql-rs` 全绿（Phase 1 单测）
- [ ] `cargo test -p pathql-rs --features json5` 全绿（Phase 1 + 2）
- [ ] `cargo test -p pathql-rs --features validate` 全绿（Phase 1 + 3 简单 + sql + resolve + cross_ref + meta + bad fixtures）
- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿（含 `validate_real` 真 9 文件）
- [ ] `cargo build -p pathql-rs --features "json5 validate"` warning 清零
- [ ] core 仍未引用 pathql-rs

## 风险点

1. **regex-automata v0.4 交集 API**：需 spike 确认 NFA / DFA 交集判断的具体 API。如不直接支持，退路：
   - 用 `regex_syntax` parse 两条 regex 为 HIR；自己写 product 算法（高成本）
   - 退化到 "正则 a 抽样测试 b" 的启发式（漏检风险，文档注明）
   - 改用 `regex` crate 的 `is_match` 配合 RNG fuzzing（不可靠）
   建议优先方案 1（直接用 regex-automata 的 hybrid::dfa product），spike 后定。
2. **sqlparser 对 `${...}` 占位符的兼容**：替换成 `:p0` / `:p1` 后 SQLiteDialect 应当接受（SQLite 支持冒号命名 bind param），但需要测试验证；尤其在 `from` / `join.table` 这种位置（表名不能是占位符），需要更精细的替换策略——可能需要识别上下文，仅在表达式位置替换。**S5 早期 spike 一组测试**确认行为。
3. **行列号 / 字段路径精度**：`ValidateError.field` 是字符串路径如 `"query.fields[2].sql"`；构造时手工拼。后续如果错误数量大，可考虑用 `serde_path_to_error` 或类似机制自动定位。
4. **meta SQL/template 启发式**：`looks_like_sql` 简单关键字匹配可能误判（如 `"FROM the perspective of..."` 在自然语言 meta 里不应被当 SQL）。当前足够简单可用，未来可改为：明确要求 meta 字符串以 `SELECT` 开头才视为 SQL；其他全走模板模式。建议 S8 先用现行启发式，遇到误判再调。
5. **跨 namespace 解析与字典序**：`registry.resolve` 用现有 Phase 1 的父链查找；validate 第一遍后所有引用都应能解析；如有"先后顺序"问题（后注册的 def 引用先注册的）测试中要覆盖。
6. **Reserved idents 集合**：硬编码在 ValidateConfig::with_default_reserved；如果未来增加保留字（比如新方法 `${env:X}`），同步更新。

## 完成 Phase 3 后的下一步

Phase 4 实现 `ProviderQuery` 类型 + ContribQuery 折叠 + SQL 拼装（依赖 Phase 5 的 template evaluator——需要把 Phase 4/5 的依赖关系再梳理一次：折叠时是否需要求值？答案是是，但是 Phase 4 可以先做"语法折叠"，留 evaluator 占位接口，Phase 5 再插入；或者把 Phase 5 提前到 Phase 4 之前）。
