//! SQL 模板渲染: 字符串扫描 + 求值 + bind/inline 替换。
//!
//! - **inline 替换** (无 bind 占位): `${ref:X}` → 字面别名 `_aN`,
//!   `${composed}` → `(<上游 sql>)` 字面注入 (合并上游 params)
//! - **bind 占位**: `${properties.X}` / `${capture[N]}` / `${data_var.col}` /
//!   `${child_var.field}` → 替换为 `?` + push `TemplateValue` 到 params

use thiserror::Error;

use crate::compose::aliases::AliasTable;
use crate::provider::SqlDialect;
use crate::template::{
    eval::{evaluate_var, EvalError, TemplateContext, TemplateValue},
    parse::{parse, ParseError, Segment, VarRef},
};

#[derive(Debug, Error)]
pub enum RenderError {
    #[error("template parse error: {0}")]
    Parse(#[from] ParseError),
    #[error("template eval error: {0}")]
    Eval(#[from] EvalError),
    #[error("`${{ref:{0}}}` not found in alias table; was it allocated during fold?")]
    UnknownRef(String),
    #[error("`${{composed}}` requires TemplateContext::composed to be set")]
    MissingComposed,
    /// Meta `{"$json": "<template>"}` 渲染后无法 parse 成 JSON。
    #[error("meta `$json` directive: rendered text is not valid JSON: {0}")]
    MetaJsonParse(String),
}

/// 给定方言 + 当前 params 已 push 的数量, 返回此次 push 的占位符字符串。
/// - Sqlite / Mysql → `?`
/// - Postgres → `$N` (1-based, N = pushed_count + 1)
///
/// 由 build_sql 统一管理 (out_params.len() 即累积位移); 单 render_template_sql 调用内
/// 顺序追加, 所以局部 += 1 等价全局位移。
pub fn placeholder_for(dialect: SqlDialect, pushed_count: usize) -> String {
    match dialect {
        SqlDialect::Sqlite | SqlDialect::Mysql => "?".to_string(),
        SqlDialect::Postgres => format!("${}", pushed_count + 1),
    }
}

/// 渲染模板字符串到 (sql, params)。bind 占位由方言决定 (`?` 或 `$N`)。
/// 结果追加到 `out_sql` / `out_params` (供 SQL 渲染分段调用)。
pub fn render_template_sql(
    template: &str,
    ctx: &TemplateContext,
    aliases: &AliasTable,
    dialect: SqlDialect,
    out_sql: &mut String,
    out_params: &mut Vec<TemplateValue>,
) -> Result<(), RenderError> {
    let ast = parse(template)?;
    for seg in &ast.segments {
        match seg {
            Segment::Text(s) => out_sql.push_str(s),
            Segment::Var(VarRef::Method { name, arg }) if name == "ref" => {
                let allocated = aliases
                    .lookup(arg)
                    .ok_or_else(|| RenderError::UnknownRef(arg.clone()))?;
                out_sql.push_str(&allocated.literal);
            }
            Segment::Var(VarRef::Bare { ns }) if ns == "composed" => {
                let (sub_sql, sub_params) =
                    ctx.composed.as_ref().ok_or(RenderError::MissingComposed)?;
                out_sql.push('(');
                out_sql.push_str(sub_sql);
                out_sql.push(')');
                for p in sub_params {
                    out_params.push(p.clone());
                }
            }
            Segment::Var(other) => {
                let value = evaluate_var(other, ctx)?;
                out_sql.push_str(&placeholder_for(dialect, out_params.len()));
                out_params.push(value);
            }
        }
    }
    Ok(())
}

/// 便利: 直接得到 (sql, params)。
pub fn render_to_owned(
    template: &str,
    ctx: &TemplateContext,
    aliases: &AliasTable,
    dialect: SqlDialect,
) -> Result<(String, Vec<TemplateValue>), RenderError> {
    let mut sql = String::new();
    let mut params = Vec::new();
    render_template_sql(template, ctx, aliases, dialect, &mut sql, &mut params)?;
    Ok((sql, params))
}

/// 渲染模板为纯字符串 (无 SQL `?` 占位; 把 TemplateValue 转为字面字符串拼接)。
/// 用于 key 模板、note 模板、object 形态 meta 模板等"纯字符串拼装"场景。
///
/// `${ref:X}` / `${composed}` 在此模式下视作错误 (idents/SQL 子查询不该出现在
/// 纯字符串模板里)。
pub fn render_template_to_string(
    template: &str,
    ctx: &TemplateContext,
) -> Result<String, RenderError> {
    use crate::template::parse::{parse, Segment, VarRef};
    let ast = parse(template)?;
    let mut out = String::new();
    for seg in &ast.segments {
        match seg {
            Segment::Text(t) => out.push_str(t),
            Segment::Var(VarRef::Method { name, arg }) if name == "ref" => {
                return Err(RenderError::UnknownRef(arg.clone()));
            }
            Segment::Var(VarRef::Bare { ns }) if ns == "composed" => {
                return Err(RenderError::MissingComposed);
            }
            Segment::Var(other) => {
                let v = crate::template::eval::evaluate_var(other, ctx)?;
                out.push_str(&template_value_to_string(&v));
            }
        }
    }
    Ok(out)
}

fn template_value_to_string(v: &TemplateValue) -> String {
    match v {
        TemplateValue::Null => String::new(),
        TemplateValue::Bool(b) => b.to_string(),
        TemplateValue::Int(i) => i.to_string(),
        TemplateValue::Real(r) => r.to_string(),
        TemplateValue::Text(s) => s.clone(),
        TemplateValue::Json(j) => j.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn empty_ctx() -> TemplateContext {
        TemplateContext::default()
    }

    fn ctx_with_props(pairs: &[(&str, TemplateValue)]) -> TemplateContext {
        let mut p = HashMap::new();
        for (k, v) in pairs {
            p.insert((*k).into(), v.clone());
        }
        TemplateContext::default().with_properties(p)
    }

    #[test]
    fn pure_literal() {
        let (sql, params) = render_to_owned(
            "SELECT 1",
            &empty_ctx(),
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "SELECT 1");
        assert!(params.is_empty());
    }

    #[test]
    fn single_property() {
        let ctx = ctx_with_props(&[("x", TemplateValue::Int(42))]);
        let (sql, params) = render_to_owned(
            "id = ${properties.x}",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "id = ?");
        assert_eq!(params, vec![TemplateValue::Int(42)]);
    }

    #[test]
    fn multi_property() {
        let ctx = ctx_with_props(&[("x", TemplateValue::Int(10)), ("y", TemplateValue::Int(20))]);
        let (sql, params) = render_to_owned(
            "a = ${properties.x} AND b = ${properties.y}",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "a = ? AND b = ?");
        assert_eq!(params, vec![TemplateValue::Int(10), TemplateValue::Int(20)]);
    }

    #[test]
    fn ref_inline() {
        let mut aliases = AliasTable::default();
        aliases.allocate("t");
        let (sql, params) = render_to_owned(
            "${ref:t}.id = ${ref:t}.x",
            &empty_ctx(),
            &aliases,
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "_a0.id = _a0.x");
        assert!(params.is_empty());
    }

    #[test]
    fn ref_unknown_errors() {
        let err = render_to_owned(
            "${ref:nope}",
            &empty_ctx(),
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap_err();
        assert!(matches!(err, RenderError::UnknownRef(_)));
    }

    #[test]
    fn composed_inline() {
        let ctx = TemplateContext::default().with_composed("SELECT 1".into(), vec![]);
        let (sql, params) = render_to_owned(
            "FROM (${composed}) sub",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "FROM ((SELECT 1)) sub");
        assert!(params.is_empty());
    }

    #[test]
    fn composed_with_subparams_merges() {
        let ctx = TemplateContext::default()
            .with_composed("WHERE x = ?".into(), vec![TemplateValue::Int(7)]);
        let (sql, params) = render_to_owned(
            "FROM (${composed})",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "FROM ((WHERE x = ?))");
        assert_eq!(params, vec![TemplateValue::Int(7)]);
    }

    #[test]
    fn composed_missing() {
        let err = render_to_owned(
            "${composed}",
            &empty_ctx(),
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap_err();
        assert!(matches!(err, RenderError::MissingComposed));
    }

    #[test]
    fn mixed_inline_and_bind_keeps_param_order() {
        let mut aliases = AliasTable::default();
        aliases.allocate("t");
        let ctx = TemplateContext::default()
            .with_properties(
                [("id".to_string(), TemplateValue::Int(99))]
                    .into_iter()
                    .collect(),
            )
            .with_capture(vec!["whole".into(), "first_grp".into()]);
        let (sql, params) = render_to_owned(
            "${ref:t}.id = ${properties.id} AND ${ref:t}.cap = ${capture[1]}",
            &ctx,
            &aliases,
            SqlDialect::Sqlite,
        )
        .unwrap();
        assert_eq!(sql, "_a0.id = ? AND _a0.cap = ?");
        assert_eq!(
            params,
            vec![
                TemplateValue::Int(99),
                TemplateValue::Text("first_grp".into())
            ]
        );
    }

    #[test]
    fn parse_error_propagates() {
        let err = render_to_owned(
            "${unclosed",
            &empty_ctx(),
            &AliasTable::default(),
            SqlDialect::Sqlite,
        )
        .unwrap_err();
        assert!(matches!(err, RenderError::Parse(_)));
    }

    #[test]
    fn appends_to_existing_buffer() {
        let mut sql = String::from("prefix ");
        let mut params = vec![TemplateValue::Int(1)];
        render_template_sql(
            "${properties.x}",
            &ctx_with_props(&[("x", TemplateValue::Int(2))]),
            &AliasTable::default(),
            SqlDialect::Sqlite,
            &mut sql,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "prefix ?");
        assert_eq!(params, vec![TemplateValue::Int(1), TemplateValue::Int(2)]);
    }

    // ===== render_template_to_string =====

    #[test]
    fn to_string_pure_text() {
        let s = render_template_to_string("hello", &empty_ctx()).unwrap();
        assert_eq!(s, "hello");
    }

    #[test]
    fn to_string_property_int() {
        let ctx = ctx_with_props(&[("page", TemplateValue::Int(42))]);
        let s = render_template_to_string("page=${properties.page}", &ctx).unwrap();
        assert_eq!(s, "page=42");
    }

    #[test]
    fn to_string_property_text() {
        let ctx = ctx_with_props(&[("name", TemplateValue::Text("foo".into()))]);
        let s = render_template_to_string("hi ${properties.name}!", &ctx).unwrap();
        assert_eq!(s, "hi foo!");
    }

    #[test]
    fn to_string_capture() {
        let ctx = TemplateContext::default().with_capture(vec!["full".into(), "100".into()]);
        let s = render_template_to_string("size=${capture[1]}", &ctx).unwrap();
        assert_eq!(s, "size=100");
    }

    #[test]
    fn to_string_ref_method_errors() {
        let r = render_template_to_string("${ref:t}.id", &empty_ctx());
        assert!(matches!(r, Err(RenderError::UnknownRef(_))));
    }

    #[test]
    fn to_string_composed_errors() {
        let r = render_template_to_string("${composed}", &empty_ctx());
        assert!(matches!(r, Err(RenderError::MissingComposed)));
    }

    // ===== dialect-aware placeholders =====

    #[test]
    fn placeholder_sqlite_question_mark() {
        assert_eq!(placeholder_for(SqlDialect::Sqlite, 0), "?");
        assert_eq!(placeholder_for(SqlDialect::Sqlite, 5), "?");
    }

    #[test]
    fn placeholder_mysql_question_mark() {
        assert_eq!(placeholder_for(SqlDialect::Mysql, 0), "?");
        assert_eq!(placeholder_for(SqlDialect::Mysql, 5), "?");
    }

    #[test]
    fn placeholder_postgres_dollar_sequence() {
        assert_eq!(placeholder_for(SqlDialect::Postgres, 0), "$1");
        assert_eq!(placeholder_for(SqlDialect::Postgres, 1), "$2");
        assert_eq!(placeholder_for(SqlDialect::Postgres, 9), "$10");
    }

    #[test]
    fn render_postgres_uses_dollar_n() {
        let ctx = ctx_with_props(&[("x", TemplateValue::Int(10)), ("y", TemplateValue::Int(20))]);
        let (sql, params) = render_to_owned(
            "a = ${properties.x} AND b = ${properties.y}",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Postgres,
        )
        .unwrap();
        assert_eq!(sql, "a = $1 AND b = $2");
        assert_eq!(params, vec![TemplateValue::Int(10), TemplateValue::Int(20)]);
    }

    #[test]
    fn render_mysql_uses_question_mark() {
        let ctx = ctx_with_props(&[("x", TemplateValue::Int(7))]);
        let (sql, _) = render_to_owned(
            "id = ${properties.x}",
            &ctx,
            &AliasTable::default(),
            SqlDialect::Mysql,
        )
        .unwrap();
        assert_eq!(sql, "id = ?");
    }
}
