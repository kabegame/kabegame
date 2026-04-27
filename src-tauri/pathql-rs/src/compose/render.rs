//! SQL 模板渲染: 字符串扫描 + 求值 + bind/inline 替换。
//!
//! - **inline 替换** (无 bind 占位): `${ref:X}` → 字面别名 `_aN`,
//!   `${composed}` → `(<上游 sql>)` 字面注入 (合并上游 params)
//! - **bind 占位**: `${properties.X}` / `${capture[N]}` / `${data_var.col}` /
//!   `${child_var.field}` → 替换为 `?` + push `TemplateValue` 到 params

#![cfg(feature = "compose")]

use thiserror::Error;

use crate::compose::aliases::AliasTable;
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
}

/// 渲染模板字符串到 (sql, params)。bind 占位用 `?`。
/// 结果追加到 `out_sql` / `out_params` (供 SQL 渲染分段调用)。
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
                out_sql.push('?');
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
) -> Result<(String, Vec<TemplateValue>), RenderError> {
    let mut sql = String::new();
    let mut params = Vec::new();
    render_template_sql(template, ctx, aliases, &mut sql, &mut params)?;
    Ok((sql, params))
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
        let (sql, params) =
            render_to_owned("SELECT 1", &empty_ctx(), &AliasTable::default()).unwrap();
        assert_eq!(sql, "SELECT 1");
        assert!(params.is_empty());
    }

    #[test]
    fn single_property() {
        let ctx = ctx_with_props(&[("x", TemplateValue::Int(42))]);
        let (sql, params) =
            render_to_owned("id = ${properties.x}", &ctx, &AliasTable::default()).unwrap();
        assert_eq!(sql, "id = ?");
        assert_eq!(params, vec![TemplateValue::Int(42)]);
    }

    #[test]
    fn multi_property() {
        let ctx = ctx_with_props(&[
            ("x", TemplateValue::Int(10)),
            ("y", TemplateValue::Int(20)),
        ]);
        let (sql, params) = render_to_owned(
            "a = ${properties.x} AND b = ${properties.y}",
            &ctx,
            &AliasTable::default(),
        )
        .unwrap();
        assert_eq!(sql, "a = ? AND b = ?");
        assert_eq!(params, vec![TemplateValue::Int(10), TemplateValue::Int(20)]);
    }

    #[test]
    fn ref_inline() {
        let mut aliases = AliasTable::default();
        aliases.allocate("t");
        let (sql, params) =
            render_to_owned("${ref:t}.id = ${ref:t}.x", &empty_ctx(), &aliases).unwrap();
        assert_eq!(sql, "_a0.id = _a0.x");
        assert!(params.is_empty());
    }

    #[test]
    fn ref_unknown_errors() {
        let err = render_to_owned("${ref:nope}", &empty_ctx(), &AliasTable::default()).unwrap_err();
        assert!(matches!(err, RenderError::UnknownRef(_)));
    }

    #[test]
    fn composed_inline() {
        let ctx = TemplateContext::default().with_composed("SELECT 1".into(), vec![]);
        let (sql, params) =
            render_to_owned("FROM (${composed}) sub", &ctx, &AliasTable::default()).unwrap();
        assert_eq!(sql, "FROM ((SELECT 1)) sub");
        assert!(params.is_empty());
    }

    #[test]
    fn composed_with_subparams_merges() {
        let ctx = TemplateContext::default()
            .with_composed("WHERE x = ?".into(), vec![TemplateValue::Int(7)]);
        let (sql, params) =
            render_to_owned("FROM (${composed})", &ctx, &AliasTable::default()).unwrap();
        assert_eq!(sql, "FROM ((WHERE x = ?))");
        assert_eq!(params, vec![TemplateValue::Int(7)]);
    }

    #[test]
    fn composed_missing() {
        let err = render_to_owned("${composed}", &empty_ctx(), &AliasTable::default()).unwrap_err();
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
        let err = render_to_owned("${unclosed", &empty_ctx(), &AliasTable::default()).unwrap_err();
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
            &mut sql,
            &mut params,
        )
        .unwrap();
        assert_eq!(sql, "prefix ?");
        assert_eq!(params, vec![TemplateValue::Int(1), TemplateValue::Int(2)]);
    }
}
