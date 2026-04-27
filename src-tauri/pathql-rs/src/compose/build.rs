//! ProviderQuery → SQL 渲染。dialect-agnostic; 占位符 `?`。
//!
//! 渲染顺序：SELECT → FROM → JOIN → WHERE → ORDER BY → OFFSET → LIMIT。
//! bind params 按文本扫描顺序 push。

use thiserror::Error;

use crate::ast::{JoinKind, NumberOrTemplate, OrderDirection};
use crate::compose::query::{JoinFrag, ProviderQuery};
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
    pub fn build_sql(
        &self,
        ctx: &TemplateContext,
    ) -> Result<(String, Vec<TemplateValue>), BuildError> {
        // 合并 adhoc_properties 进 effective ctx (adhoc 覆盖优先)
        let effective_ctx;
        let ctx_ref: &TemplateContext = if self.adhoc_properties.is_empty() {
            ctx
        } else {
            let mut merged = ctx.clone();
            for (k, v) in &self.adhoc_properties {
                merged.properties.insert(k.clone(), v.clone());
            }
            effective_ctx = merged;
            &effective_ctx
        };

        let mut sql = String::new();
        let mut params = Vec::new();

        // SELECT
        sql.push_str("SELECT ");
        self.render_select(&mut sql, &mut params, ctx_ref)?;

        // FROM
        sql.push_str(" FROM ");
        let from = self.from.as_ref().ok_or(BuildError::MissingFrom)?;
        render_template_sql(&from.0, ctx_ref, &self.aliases, &mut sql, &mut params)?;

        // JOIN
        for j in &self.joins {
            self.render_one_join(j, &mut sql, &mut params, ctx_ref)?;
        }

        // WHERE
        self.render_where(&mut sql, &mut params, ctx_ref)?;

        // ORDER BY
        self.render_order(&mut sql);

        // OFFSET / LIMIT
        self.render_pagination(&mut sql, &mut params, ctx_ref)?;

        Ok((sql, params))
    }

    fn render_select(
        &self,
        sql: &mut String,
        params: &mut Vec<TemplateValue>,
        ctx: &TemplateContext,
    ) -> Result<(), BuildError> {
        if self.fields.is_empty() {
            sql.push('*');
            return Ok(());
        }
        for (i, f) in self.fields.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
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

    fn render_one_join(
        &self,
        j: &JoinFrag,
        sql: &mut String,
        params: &mut Vec<TemplateValue>,
        ctx: &TemplateContext,
    ) -> Result<(), BuildError> {
        let kw = match j.kind {
            JoinKind::Inner => " INNER JOIN ",
            JoinKind::Left => " LEFT JOIN ",
            JoinKind::Right => " RIGHT JOIN ",
            JoinKind::Full => " FULL JOIN ",
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

    fn render_where(
        &self,
        sql: &mut String,
        params: &mut Vec<TemplateValue>,
        ctx: &TemplateContext,
    ) -> Result<(), BuildError> {
        if self.wheres.is_empty() {
            return Ok(());
        }
        sql.push_str(" WHERE ");
        for (i, w) in self.wheres.iter().enumerate() {
            if i > 0 {
                sql.push_str(" AND ");
            }
            sql.push('(');
            render_template_sql(&w.0, ctx, &self.aliases, sql, params)?;
            sql.push(')');
        }
        Ok(())
    }

    fn render_order(&self, sql: &mut String) {
        let entries = &self.order.entries;
        if entries.is_empty() {
            return;
        }
        sql.push_str(" ORDER BY ");
        for (i, (field, dir)) in entries.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(field);
            let effective = self.apply_global_modifier(*dir);
            sql.push_str(match effective {
                OrderDirection::Asc => " ASC",
                OrderDirection::Desc => " DESC",
                OrderDirection::Revert => unreachable!(
                    "Revert should be resolved during fold (see OrderState::upsert)"
                ),
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

    fn render_pagination(
        &self,
        sql: &mut String,
        params: &mut Vec<TemplateValue>,
        ctx: &TemplateContext,
    ) -> Result<(), BuildError> {
        // ORDER BY OFFSET LIMIT (SQLite syntax: OFFSET follows LIMIT in standard, but
        // we emit LIMIT then OFFSET for SQLite compatibility — both orders work).
        if let Some(limit) = &self.limit {
            sql.push_str(" LIMIT ");
            self.render_number_or_template(limit, sql, params, ctx)?;
        }
        if !self.offset_terms.is_empty() {
            sql.push_str(" OFFSET ");
            for (i, term) in self.offset_terms.iter().enumerate() {
                if i > 0 {
                    sql.push_str(" + ");
                }
                sql.push('(');
                self.render_number_or_template(term, sql, params, ctx)?;
                sql.push(')');
            }
        }
        Ok(())
    }

    fn render_number_or_template(
        &self,
        t: &NumberOrTemplate,
        sql: &mut String,
        params: &mut Vec<TemplateValue>,
        ctx: &TemplateContext,
    ) -> Result<(), BuildError> {
        match t {
            NumberOrTemplate::Number(n) => {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{NumberOrTemplate, OrderDirection, SqlExpr, TemplateExpr};
    use crate::compose::aliases::{AliasTable, ResolvedAlias};
    use crate::compose::query::{FieldFrag, JoinFrag, ProviderQuery};
    use std::collections::HashMap;

    fn empty_ctx() -> TemplateContext {
        TemplateContext::default()
    }

    fn props(pairs: &[(&str, TemplateValue)]) -> TemplateContext {
        let mut p = HashMap::new();
        for (k, v) in pairs {
            p.insert((*k).into(), v.clone());
        }
        TemplateContext::default().with_properties(p)
    }

    fn q_with_from(from: &str) -> ProviderQuery {
        let mut q = ProviderQuery::new();
        q.from = Some(SqlExpr(from.into()));
        q
    }

    // ----- SELECT -----

    #[test]
    fn select_star_when_no_fields() {
        let q = q_with_from("images");
        let (sql, params) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT * FROM images");
        assert!(params.is_empty());
    }

    #[test]
    fn select_one_field_no_alias() {
        let mut q = q_with_from("images");
        q.fields.push(FieldFrag {
            sql: SqlExpr("images.id".into()),
            alias: None,
            in_need: false,
        });
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT images.id FROM images");
    }

    #[test]
    fn select_field_with_alias() {
        let mut q = q_with_from("images");
        q.fields.push(FieldFrag {
            sql: SqlExpr("images.id".into()),
            alias: Some(ResolvedAlias::Literal("img_id".into())),
            in_need: false,
        });
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT images.id AS img_id FROM images");
    }

    #[test]
    fn select_with_template_param_and_alias() {
        let mut q = q_with_from("images");
        q.fields.push(FieldFrag {
            sql: SqlExpr("images.id + ${properties.x}".into()),
            alias: Some(ResolvedAlias::Literal("y".into())),
            in_need: false,
        });
        let ctx = props(&[("x", TemplateValue::Int(1))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert_eq!(sql, "SELECT images.id + ? AS y FROM images");
        assert_eq!(params, vec![TemplateValue::Int(1)]);
    }

    #[test]
    fn select_two_fields_comma_joined() {
        let mut q = q_with_from("images");
        q.fields.push(FieldFrag {
            sql: SqlExpr("a".into()),
            alias: None,
            in_need: false,
        });
        q.fields.push(FieldFrag {
            sql: SqlExpr("b".into()),
            alias: Some(ResolvedAlias::Literal("ab".into())),
            in_need: false,
        });
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT a, b AS ab FROM images");
    }

    // ----- FROM -----

    #[test]
    fn from_simple() {
        let q = q_with_from("images");
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" FROM images"));
    }

    #[test]
    fn from_missing_errors() {
        let q = ProviderQuery::new();
        let err = q.build_sql(&empty_ctx()).unwrap_err();
        assert!(matches!(err, BuildError::MissingFrom));
    }

    // ----- JOIN -----

    fn join_frag(kind: JoinKind, table: &str, alias: &str, on: Option<&str>) -> JoinFrag {
        JoinFrag {
            kind,
            table: SqlExpr(table.into()),
            alias: ResolvedAlias::Literal(alias.into()),
            on: on.map(|s| SqlExpr(s.into())),
            in_need: false,
        }
    }

    #[test]
    fn join_inner_default() {
        let mut q = q_with_from("images");
        q.joins.push(join_frag(
            JoinKind::Inner,
            "album_images",
            "ai",
            Some("ai.image_id = images.id"),
        ));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM images INNER JOIN album_images AS ai ON ai.image_id = images.id"
        );
    }

    #[test]
    fn join_left_with_template_on() {
        let mut q = q_with_from("images");
        q.joins.push(join_frag(
            JoinKind::Left,
            "tags",
            "t",
            Some("t.id = images.tag_id AND t.kind = ${properties.kind}"),
        ));
        let ctx = props(&[("kind", TemplateValue::Text("primary".into()))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert!(sql.contains(" LEFT JOIN tags AS t ON t.id = images.tag_id AND t.kind = ?"));
        assert_eq!(params, vec![TemplateValue::Text("primary".into())]);
    }

    #[test]
    fn join_no_on() {
        let mut q = q_with_from("images");
        q.joins
            .push(join_frag(JoinKind::Inner, "albums", "a", None));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.contains("INNER JOIN albums AS a"));
        assert!(!sql.contains(" ON "));
    }

    // ----- WHERE -----

    #[test]
    fn where_none() {
        let q = q_with_from("images");
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(!sql.contains(" WHERE "));
    }

    #[test]
    fn where_single() {
        let mut q = q_with_from("images");
        q.wheres.push(SqlExpr("x > 1".into()));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" WHERE (x > 1)"));
    }

    #[test]
    fn where_multi_and() {
        let mut q = q_with_from("images");
        q.wheres.push(SqlExpr("a > 1".into()));
        q.wheres.push(SqlExpr("b < 2".into()));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" WHERE (a > 1) AND (b < 2)"));
    }

    #[test]
    fn where_with_template_param() {
        let mut q = q_with_from("images");
        q.wheres
            .push(SqlExpr("images.id = ${properties.id}".into()));
        let ctx = props(&[("id", TemplateValue::Int(7))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert!(sql.contains(" WHERE (images.id = ?)"));
        assert_eq!(params, vec![TemplateValue::Int(7)]);
    }

    // ----- ORDER BY -----

    #[test]
    fn order_empty_no_clause() {
        let q = q_with_from("images");
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(!sql.contains(" ORDER BY "));
    }

    #[test]
    fn order_global_revert_no_entries() {
        let mut q = q_with_from("images");
        q.order.global = Some(OrderDirection::Revert);
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(!sql.contains(" ORDER BY "));
    }

    #[test]
    fn order_array_only() {
        let mut q = q_with_from("images");
        q.order.entries.push(("a".into(), OrderDirection::Asc));
        q.order.entries.push(("b".into(), OrderDirection::Desc));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" ORDER BY a ASC, b DESC"));
    }

    #[test]
    fn order_global_revert_flips() {
        let mut q = q_with_from("images");
        q.order.entries.push(("a".into(), OrderDirection::Asc));
        q.order.global = Some(OrderDirection::Revert);
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" ORDER BY a DESC"));
    }

    #[test]
    fn order_global_asc_forces_all() {
        let mut q = q_with_from("images");
        q.order.entries.push(("a".into(), OrderDirection::Desc));
        q.order.entries.push(("b".into(), OrderDirection::Asc));
        q.order.global = Some(OrderDirection::Asc);
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" ORDER BY a ASC, b ASC"));
    }

    #[test]
    fn order_global_desc_forces_all() {
        let mut q = q_with_from("images");
        q.order.entries.push(("a".into(), OrderDirection::Desc));
        q.order.entries.push(("b".into(), OrderDirection::Asc));
        q.order.global = Some(OrderDirection::Desc);
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" ORDER BY a DESC, b DESC"));
    }

    // ----- LIMIT / OFFSET -----

    #[test]
    fn pagination_none() {
        let q = q_with_from("images");
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(!sql.contains(" LIMIT "));
        assert!(!sql.contains(" OFFSET "));
    }

    #[test]
    fn limit_only_number() {
        let mut q = q_with_from("images");
        q.limit = Some(NumberOrTemplate::Number(100.0));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" LIMIT 100"));
    }

    #[test]
    fn limit_only_template() {
        let mut q = q_with_from("images");
        q.limit = Some(NumberOrTemplate::Template(TemplateExpr(
            "${properties.lim}".into(),
        )));
        let ctx = props(&[("lim", TemplateValue::Int(50))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert!(sql.ends_with(" LIMIT ?"));
        assert_eq!(params, vec![TemplateValue::Int(50)]);
    }

    #[test]
    fn offset_single_number() {
        let mut q = q_with_from("images");
        q.offset_terms.push(NumberOrTemplate::Number(0.0));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" OFFSET (0)"));
    }

    #[test]
    fn offset_two_terms_concat() {
        let mut q = q_with_from("images");
        q.offset_terms.push(NumberOrTemplate::Number(0.0));
        q.offset_terms.push(NumberOrTemplate::Template(TemplateExpr(
            "${properties.x}".into(),
        )));
        let ctx = props(&[("x", TemplateValue::Int(7))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert!(sql.ends_with(" OFFSET (0) + (?)"));
        assert_eq!(params, vec![TemplateValue::Int(7)]);
    }

    #[test]
    fn offset_three_terms_concat() {
        let mut q = q_with_from("images");
        q.offset_terms.push(NumberOrTemplate::Number(1.0));
        q.offset_terms.push(NumberOrTemplate::Number(2.0));
        q.offset_terms.push(NumberOrTemplate::Number(3.0));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" OFFSET (1) + (2) + (3)"));
    }

    #[test]
    fn both_offset_and_limit() {
        let mut q = q_with_from("images");
        q.offset_terms.push(NumberOrTemplate::Number(20.0));
        q.limit = Some(NumberOrTemplate::Number(10.0));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.ends_with(" LIMIT 10 OFFSET (20)"));
    }

    // ----- ref allocation lookup at render time -----

    #[test]
    fn render_uses_alias_table_for_refs() {
        let mut q = q_with_from("images");
        // simulate fold having allocated _a0 for ref ident "ai"
        q.aliases.allocate("ai");
        // join contributed via ${ref:ai}
        q.joins.push(JoinFrag {
            kind: JoinKind::Inner,
            table: SqlExpr("album_images".into()),
            alias: ResolvedAlias::Literal("_a0".into()),
            on: Some(SqlExpr(
                "${ref:ai}.image_id = images.id".into(),
            )),
            in_need: false,
        });
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.contains("INNER JOIN album_images AS _a0 ON _a0.image_id = images.id"));
    }

    // ----- order: full pipeline test of clause sequencing -----

    // ----- ${composed} subquery embed end-to-end -----

    #[test]
    fn composed_subquery_merges_params() {
        // Inner: SELECT * FROM images WHERE (images.album_id = ?)
        let mut inner = ProviderQuery::new();
        inner.from = Some(SqlExpr("images".into()));
        inner
            .wheres
            .push(SqlExpr("images.album_id = ${properties.aid}".into()));
        let inner_ctx = props(&[("aid", TemplateValue::Int(42))]);
        let (sub_sql, sub_params) = inner.build_sql(&inner_ctx).unwrap();
        assert_eq!(
            sub_sql,
            "SELECT * FROM images WHERE (images.album_id = ?)"
        );
        assert_eq!(sub_params, vec![TemplateValue::Int(42)]);

        // Outer: dynamic-list SQL using ${composed} as subquery source
        let outer_ctx = TemplateContext::default()
            .with_composed(sub_sql, sub_params)
            .with_properties(
                [("y".to_string(), TemplateValue::Int(5))]
                    .into_iter()
                    .collect(),
            );
        let (outer_sql, outer_params) = crate::compose::render::render_to_owned(
            "SELECT * FROM (${composed}) AS sub WHERE sub.x = ${properties.y}",
            &outer_ctx,
            &AliasTable::default(),
        )
        .unwrap();

        assert_eq!(
            outer_sql,
            "SELECT * FROM ((SELECT * FROM images WHERE (images.album_id = ?))) AS sub WHERE sub.x = ?"
        );
        assert_eq!(outer_params.len(), 2);
        assert_eq!(outer_params[0], TemplateValue::Int(42));
        assert_eq!(outer_params[1], TemplateValue::Int(5));
    }

    #[test]
    fn composed_in_outer_query_from_clause() {
        // Outer is a ProviderQuery whose `from` references ${composed}
        // (mirrors page_size_provider's dynamic SQL: FROM (${composed}) AS composed_result)
        let mut outer = ProviderQuery::new();
        outer.from = Some(SqlExpr("(${composed}) AS sub".into()));
        outer
            .wheres
            .push(SqlExpr("sub.id > ${properties.threshold}".into()));

        let inner_sql = "SELECT id FROM images WHERE images.kind = ?";
        let inner_params = vec![TemplateValue::Text("primary".into())];
        let outer_ctx = TemplateContext::default()
            .with_composed(inner_sql.into(), inner_params)
            .with_properties(
                [("threshold".to_string(), TemplateValue::Int(100))]
                    .into_iter()
                    .collect(),
            );

        let (sql, params) = outer.build_sql(&outer_ctx).unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM ((SELECT id FROM images WHERE images.kind = ?)) AS sub WHERE (sub.id > ?)"
        );
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], TemplateValue::Text("primary".into()));
        assert_eq!(params[1], TemplateValue::Int(100));
    }

    #[test]
    fn full_clause_order_select_from_join_where_order_limit_offset() {
        let mut q = q_with_from("images");
        q.fields.push(FieldFrag {
            sql: SqlExpr("images.id".into()),
            alias: None,
            in_need: false,
        });
        q.joins.push(join_frag(
            JoinKind::Inner,
            "album_images",
            "ai",
            Some("ai.image_id = images.id"),
        ));
        q.wheres.push(SqlExpr("ai.album_id = 1".into()));
        q.order.entries.push(("images.id".into(), OrderDirection::Desc));
        q.limit = Some(NumberOrTemplate::Number(10.0));
        q.offset_terms.push(NumberOrTemplate::Number(20.0));
        let (sql, _) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(
            sql,
            "SELECT images.id FROM images INNER JOIN album_images AS ai ON ai.image_id = images.id WHERE (ai.album_id = 1) ORDER BY images.id DESC LIMIT 10 OFFSET (20)"
        );
    }

    // ----- raw-bind API merging with build_sql ctx -----

    #[test]
    fn build_sql_merges_adhoc_into_ctx() {
        let q = ProviderQuery::new()
            .with_where_raw("x = ?", &[TemplateValue::Int(7)]);
        let mut q = q;
        q.from = Some(SqlExpr("images".into()));
        let (sql, params) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT * FROM images WHERE (x = ?)");
        assert_eq!(params, vec![TemplateValue::Int(7)]);
    }

    #[test]
    fn build_sql_adhoc_overrides_ctx() {
        // ctx has property "x" = 1, but adhoc has "__pq_raw_0" = 99
        // they don't conflict; this verifies adhoc is added without disturbing ctx
        let q = ProviderQuery::new().with_where_raw("a = ?", &[TemplateValue::Int(99)]);
        let mut q = q;
        q.from = Some(SqlExpr("t".into()));
        let ctx = props(&[("x", TemplateValue::Int(1))]);
        let (sql, params) = q.build_sql(&ctx).unwrap();
        assert!(sql.contains("WHERE (a = ?)"));
        assert_eq!(params, vec![TemplateValue::Int(99)]);
    }

    #[test]
    fn build_sql_raw_join_with_param() {
        let mut q = ProviderQuery::new()
            .with_join_raw(
                JoinKind::Inner,
                "tags",
                "t",
                Some("t.image_id = images.id AND t.name = ?"),
                &[TemplateValue::Text("foo".into())],
            )
            .unwrap();
        q.from = Some(SqlExpr("images".into()));
        let (sql, params) = q.build_sql(&empty_ctx()).unwrap();
        assert!(sql.contains("INNER JOIN tags AS t ON t.image_id = images.id AND t.name = ?"));
        assert_eq!(params, vec![TemplateValue::Text("foo".into())]);
    }

    #[test]
    fn build_sql_raw_field_with_alias_and_param() {
        let mut q = ProviderQuery::new().with_field_raw(
            "images.id + ?",
            Some("y"),
            &[TemplateValue::Int(10)],
        );
        q.from = Some(SqlExpr("images".into()));
        let (sql, params) = q.build_sql(&empty_ctx()).unwrap();
        assert_eq!(sql, "SELECT images.id + ? AS y FROM images");
        assert_eq!(params, vec![TemplateValue::Int(10)]);
    }
}
