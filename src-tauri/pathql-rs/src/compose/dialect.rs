//! 渲染期的方言差异。
//!
//! 各项差异的落点：
//! - 占位符（`?` / `$N`）：[`crate::compose::render::placeholder_for`]；
//! - 标识符引号（`"x"` / `` `x` ``）：`build.rs` 的 `render_alias_identifier`；
//! - 子查询边界（`~~`）的落法：本文件的 [`NestStyle`]。

use crate::provider::SqlDialect;

/// 子查询边界在各方言下的落法。
///
/// 边界一律渲染成 CTE：`WITH pq_nest_1 AS … (<内层>) SELECT … FROM pq_nest_1 AS <alias> …`。
/// 派生表 `FROM (<内层>) AS <alias>` 会被 SQLite 当 co-routine 放进内层循环，
/// 每一行外层都重跑一遍分页子查询；CTE 物化后内层只算一次。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NestStyle {
    /// `AS MATERIALIZED (…)`：强制只算一次、存成临时表。
    /// SQLite ≥ 3.35；Postgres ≥ 12（不写关键字时会把只引用一次的 CTE 内联回去）。
    MaterializedCte,
    /// `AS (…)`：MySQL 没有 MATERIALIZED 关键字；带 LIMIT 的 CTE 本来就不会被合并进外层。
    Cte,
}

impl NestStyle {
    /// `AS` 与左括号之间的关键字（含尾随空格）。
    pub(crate) fn keyword(self) -> &'static str {
        match self {
            NestStyle::MaterializedCte => "MATERIALIZED ",
            NestStyle::Cte => "",
        }
    }
}

impl SqlDialect {
    pub(crate) fn nest_style(self) -> NestStyle {
        match self {
            SqlDialect::Sqlite | SqlDialect::Postgres => NestStyle::MaterializedCte,
            SqlDialect::Mysql => NestStyle::Cte,
        }
    }
}

/// 第 `depth` 层（从 1 起）子查询边界的 CTE 名。
///
/// 不用表名：外层还要 `JOIN albums AS tree` 引用真实表，同名 CTE 会把它遮住；
/// 按深度编号保证多层嵌套时互不遮挡。
pub(crate) fn nest_cte_name(depth: usize) -> String {
    format!("pq_nest_{depth}")
}
