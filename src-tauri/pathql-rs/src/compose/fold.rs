use thiserror::Error;

use super::aliases::ResolvedAlias;
use super::query::{FieldFrag, JoinFrag, ProviderQuery};
use crate::ast::{ContribQuery, Field, Join, JoinKind, NumberOrTemplate, OrderForm, SqlExpr};

#[derive(Debug, Error, Clone, PartialEq)]
pub enum FoldError {
    #[error("alias `{0}` already used in path; in_need not set on conflicting contrib")]
    AliasCollision(String),
    #[error("`as: ${{ref:{0}}}` cannot coexist with `in_need: true`")]
    RefAliasWithInNeed(String),
}

/// 把一份 ContribQuery 累积到 ProviderQuery 中。
pub fn fold_contrib(state: &mut ProviderQuery, q: &ContribQuery) -> Result<(), FoldError> {
    fold_from(state, &q.from);
    fold_fields(state, &q.fields)?;
    fold_joins(state, &q.join)?;
    fold_where_clear(state, &q.where_clear);
    fold_where(state, &q.where_);
    fold_order_clear(state, &q.order_clear);
    fold_order(state, &q.order);
    fold_offset(state, &q.offset);
    fold_limit(state, &q.limit);
    Ok(())
}

fn fold_where_clear(state: &mut ProviderQuery, patterns: &Option<Vec<SqlExpr>>) {
    let Some(patterns) = patterns else { return };
    if patterns.is_empty() {
        return;
    }
    state
        .wheres
        .retain(|w| !patterns.iter().any(|p| w.0.contains(&p.0)));
}

fn fold_from(state: &mut ProviderQuery, from: &Option<SqlExpr>) {
    if let Some(new_from) = from {
        state.from = Some(new_from.clone());
    }
}

fn fold_fields(state: &mut ProviderQuery, fields: &Option<Vec<Field>>) -> Result<(), FoldError> {
    let Some(fields) = fields else {
        return Ok(());
    };
    for f in fields {
        let in_need = f.in_need.unwrap_or(false);
        let resolved_alias: Option<ResolvedAlias> = match &f.alias {
            None => None,
            Some(name) => {
                let resolved = ResolvedAlias::from_alias_name(name);
                let resolved = match resolved {
                    ResolvedAlias::UnresolvedRef(ident) => {
                        if in_need {
                            return Err(FoldError::RefAliasWithInNeed(ident));
                        }
                        let lit = state.aliases.allocate(&ident).literal.clone();
                        ResolvedAlias::Literal(lit)
                    }
                    other => other,
                };
                Some(resolved)
            }
        };
        // collision detection on literal aliases
        if let Some(alias) = &resolved_alias {
            if let Some(lit) = alias.as_literal() {
                if state.has_field_alias(lit) {
                    if in_need {
                        continue; // share upstream; skip accumulation
                    }
                    return Err(FoldError::AliasCollision(lit.to_string()));
                }
            }
        }
        state.fields.push(FieldFrag {
            sql: f.sql.clone(),
            alias: resolved_alias,
            in_need,
        });
    }
    Ok(())
}

fn fold_joins(state: &mut ProviderQuery, joins: &Option<Vec<Join>>) -> Result<(), FoldError> {
    let Some(joins) = joins else {
        return Ok(());
    };
    for j in joins {
        let in_need = j.in_need.unwrap_or(false);
        let resolved = ResolvedAlias::from_alias_name(&j.alias);
        let resolved = match resolved {
            ResolvedAlias::UnresolvedRef(ident) => {
                if in_need {
                    return Err(FoldError::RefAliasWithInNeed(ident));
                }
                let lit = state.aliases.allocate(&ident).literal.clone();
                ResolvedAlias::Literal(lit)
            }
            other => other,
        };
        let lit = resolved
            .as_literal()
            .expect("Join alias is required and must resolve to a literal after fold");
        if state.has_join_alias(lit) {
            if in_need {
                continue;
            }
            return Err(FoldError::AliasCollision(lit.to_string()));
        }
        state.joins.push(JoinFrag {
            kind: j.kind.unwrap_or(JoinKind::Inner),
            table: j.table.clone(),
            alias: resolved,
            on: j.on.clone(),
            in_need,
        });
    }
    Ok(())
}

fn fold_where(state: &mut ProviderQuery, w: &Option<SqlExpr>) {
    if let Some(expr) = w {
        state.wheres.push(expr.clone());
    }
}

fn fold_order_clear(state: &mut ProviderQuery, patterns: &Option<Vec<SqlExpr>>) {
    let Some(patterns) = patterns else { return };
    if patterns.is_empty() {
        return;
    }
    state.order.entries.retain(|(field, _)| {
        !patterns
            .iter()
            .any(|needle| !needle.0.is_empty() && field.contains(&needle.0))
    });
}

fn fold_order(state: &mut ProviderQuery, order: &Option<OrderForm>) {
    let Some(form) = order else {
        return;
    };
    match form {
        OrderForm::Array(items) => {
            for item in items {
                for (field, dir) in &item.0 {
                    state.order.upsert(field.clone(), *dir);
                }
            }
        }
        OrderForm::Global(g) => {
            // last-wins
            state.order.global = Some(g.all);
        }
    }
}

fn fold_offset(state: &mut ProviderQuery, o: &Option<NumberOrTemplate>) {
    if let Some(v) = o {
        state.offset_terms.push(v.clone());
    }
}

fn fold_limit(state: &mut ProviderQuery, l: &Option<NumberOrTemplate>) {
    if let Some(v) = l {
        state.limit = Some(v.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        AliasName, ContribQuery, Field, Join, JoinKind, NumberOrTemplate, OrderArrayItem,
        OrderDirection, OrderForm, OrderGlobal, SqlExpr,
    };

    fn empty_q() -> ContribQuery {
        ContribQuery::default()
    }

    // ===== from =====

    #[test]
    fn from_first_time() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.from = Some(SqlExpr("images".into()));
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.from, Some(SqlExpr("images".into())));
    }

    #[test]
    fn from_cascading_replace() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.from = Some(SqlExpr("images".into()));
        let mut q2 = empty_q();
        q2.from = Some(SqlExpr("vd_images".into()));
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.from, Some(SqlExpr("vd_images".into())));
    }

    #[test]
    fn from_none_keeps_existing() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.from = Some(SqlExpr("images".into()));
        let q2 = empty_q();
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.from, Some(SqlExpr("images".into())));
    }

    // ===== fields =====

    fn field(sql: &str, alias: Option<&str>, in_need: Option<bool>) -> Field {
        Field {
            sql: SqlExpr(sql.into()),
            alias: alias.map(|a| AliasName(a.into())),
            in_need,
        }
    }

    #[test]
    fn fields_literal_alias() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![
            field("x", Some("ax"), None),
            field("y", Some("ay"), None),
        ]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.fields.len(), 2);
        assert_eq!(s.fields[0].alias, Some(ResolvedAlias::Literal("ax".into())));
        assert_eq!(s.fields[1].alias, Some(ResolvedAlias::Literal("ay".into())));
    }

    #[test]
    fn fields_no_alias_pushed_as_none() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![field("images.*", None, None)]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.fields.len(), 1);
        assert!(s.fields[0].alias.is_none());
    }

    #[test]
    fn fields_collision_no_in_need_errors() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![
            field("x", Some("ax"), None),
            field("y", Some("ax"), None), // collision
        ]);
        let err = fold_contrib(&mut s, &q).unwrap_err();
        assert!(matches!(err, FoldError::AliasCollision(_)));
    }

    #[test]
    fn fields_collision_in_need_skips() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.fields = Some(vec![field("x", Some("ax"), None)]);
        fold_contrib(&mut s, &q1).unwrap();

        let mut q2 = empty_q();
        q2.fields = Some(vec![field("y", Some("ax"), Some(true))]);
        fold_contrib(&mut s, &q2).unwrap();

        // second was skipped (shared upstream)
        assert_eq!(s.fields.len(), 1);
        assert_eq!(s.fields[0].sql, SqlExpr("x".into()));
    }

    #[test]
    fn fields_ref_allocates_alias() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![field("x", Some("${ref:my_id}"), None)]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.fields.len(), 1);
        assert_eq!(
            s.fields[0].alias,
            Some(ResolvedAlias::Literal("_a0".into()))
        );
        assert_eq!(s.aliases.lookup("my_id").unwrap().literal, "_a0");
    }

    #[test]
    fn fields_ref_with_in_need_rejected() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![field("x", Some("${ref:my_id}"), Some(true))]);
        let err = fold_contrib(&mut s, &q).unwrap_err();
        assert_eq!(err, FoldError::RefAliasWithInNeed("my_id".into()));
    }

    // ===== joins =====

    fn join(table: &str, alias: &str, on: Option<&str>) -> Join {
        Join {
            kind: None,
            table: SqlExpr(table.into()),
            alias: AliasName(alias.into()),
            on: on.map(|s| SqlExpr(s.into())),
            in_need: None,
        }
    }

    #[test]
    fn joins_kind_default_inner() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.join = Some(vec![join("t", "ai", None)]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.joins[0].kind, JoinKind::Inner);
    }

    #[test]
    fn joins_kind_left_preserved() {
        let mut s = ProviderQuery::new();
        let mut j = join("t", "ai", None);
        j.kind = Some(JoinKind::Left);
        let mut q = empty_q();
        q.join = Some(vec![j]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.joins[0].kind, JoinKind::Left);
    }

    #[test]
    fn joins_with_on_preserved() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.join = Some(vec![join(
            "album_images",
            "ai",
            Some("ai.image_id = images.id"),
        )]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(
            s.joins[0].on,
            Some(SqlExpr("ai.image_id = images.id".into()))
        );
    }

    #[test]
    fn joins_collision_errors() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.join = Some(vec![join("t1", "ai", None), join("t2", "ai", None)]);
        let err = fold_contrib(&mut s, &q).unwrap_err();
        assert!(matches!(err, FoldError::AliasCollision(_)));
    }

    #[test]
    fn joins_collision_in_need_skips() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.join = Some(vec![join("t1", "ai", None)]);
        fold_contrib(&mut s, &q1).unwrap();

        let mut j = join("t2", "ai", None);
        j.in_need = Some(true);
        let mut q2 = empty_q();
        q2.join = Some(vec![j]);
        fold_contrib(&mut s, &q2).unwrap();

        // skipped
        assert_eq!(s.joins.len(), 1);
        assert_eq!(s.joins[0].table, SqlExpr("t1".into()));
    }

    #[test]
    fn joins_ref_with_in_need_rejected() {
        let mut s = ProviderQuery::new();
        let mut j = join("t", "${ref:t1}", None);
        j.in_need = Some(true);
        let mut q = empty_q();
        q.join = Some(vec![j]);
        let err = fold_contrib(&mut s, &q).unwrap_err();
        assert_eq!(err, FoldError::RefAliasWithInNeed("t1".into()));
    }

    // ===== where =====

    #[test]
    fn where_three_folds_accumulate() {
        let mut s = ProviderQuery::new();
        for w in &["a > 0", "b < 10", "c IS NOT NULL"] {
            let mut q = empty_q();
            q.where_ = Some(SqlExpr((*w).into()));
            fold_contrib(&mut s, &q).unwrap();
        }
        assert_eq!(s.wheres.len(), 3);
    }

    // ===== order =====

    fn order_arr(items: Vec<Vec<(&str, OrderDirection)>>) -> OrderForm {
        OrderForm::Array(
            items
                .into_iter()
                .map(|inner| {
                    OrderArrayItem(inner.into_iter().map(|(f, d)| (f.into(), d)).collect())
                })
                .collect(),
        )
    }

    #[test]
    fn order_array_single_field() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.order = Some(order_arr(vec![vec![("title", OrderDirection::Asc)]]));
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.order.entries, vec![("title".into(), OrderDirection::Asc)]);
    }

    #[test]
    fn order_array_multi_fields_order_preserved() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.order = Some(order_arr(vec![
            vec![("a", OrderDirection::Asc)],
            vec![("b", OrderDirection::Desc)],
        ]));
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.order.entries[0], ("a".into(), OrderDirection::Asc));
        assert_eq!(s.order.entries[1], ("b".into(), OrderDirection::Desc));
    }

    #[test]
    fn order_array_overwrite_keeps_position() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.order = Some(order_arr(vec![vec![("a", OrderDirection::Asc)]]));
        let mut q2 = empty_q();
        q2.order = Some(order_arr(vec![vec![("a", OrderDirection::Desc)]]));
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.order.entries.len(), 1);
        assert_eq!(s.order.entries[0], ("a".into(), OrderDirection::Desc));
    }

    #[test]
    fn order_global_last_wins() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.order = Some(OrderForm::Global(OrderGlobal {
            all: OrderDirection::Revert,
        }));
        let mut q2 = empty_q();
        q2.order = Some(OrderForm::Global(OrderGlobal {
            all: OrderDirection::Asc,
        }));
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.order.global, Some(OrderDirection::Asc));
        assert!(s.order.entries.is_empty());
    }

    #[test]
    fn order_mixed_array_then_global_then_array() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.order = Some(order_arr(vec![vec![("a", OrderDirection::Asc)]]));
        let mut q2 = empty_q();
        q2.order = Some(OrderForm::Global(OrderGlobal {
            all: OrderDirection::Revert,
        }));
        let mut q3 = empty_q();
        q3.order = Some(order_arr(vec![vec![("b", OrderDirection::Desc)]]));
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        fold_contrib(&mut s, &q3).unwrap();
        assert_eq!(s.order.entries.len(), 2);
        assert_eq!(s.order.global, Some(OrderDirection::Revert));
    }

    // ===== offset =====

    #[test]
    fn offset_three_folds_accumulate() {
        let mut s = ProviderQuery::new();
        for v in &[1.0_f64, 2.0, 3.0] {
            let mut q = empty_q();
            q.offset = Some(NumberOrTemplate::Number(*v));
            fold_contrib(&mut s, &q).unwrap();
        }
        assert_eq!(s.offset_terms.len(), 3);
    }

    // ===== limit =====

    #[test]
    fn limit_last_wins() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.limit = Some(NumberOrTemplate::Number(10.0));
        let mut q2 = empty_q();
        q2.limit = Some(NumberOrTemplate::Number(20.0));
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.limit, Some(NumberOrTemplate::Number(20.0)));
    }

    #[test]
    fn limit_none_keeps_existing() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.limit = Some(NumberOrTemplate::Number(10.0));
        let q2 = empty_q();
        fold_contrib(&mut s, &q1).unwrap();
        fold_contrib(&mut s, &q2).unwrap();
        assert_eq!(s.limit, Some(NumberOrTemplate::Number(10.0)));
    }

    // ===== ${ref:X} cross-fold =====

    #[test]
    fn ref_alias_shared_across_folds() {
        let mut s = ProviderQuery::new();
        // A: contributes join with as: ${ref:t1}
        let mut q1 = empty_q();
        q1.join = Some(vec![join("album_images", "${ref:t1}", None)]);
        fold_contrib(&mut s, &q1).unwrap();

        // B: references ${ref:t1} in where (str preserved as-is)
        let mut q2 = empty_q();
        q2.where_ = Some(SqlExpr("${ref:t1}.image_id = images.id".into()));
        fold_contrib(&mut s, &q2).unwrap();

        assert_eq!(s.aliases.lookup("t1").unwrap().literal, "_a0");
        assert_eq!(s.joins[0].alias, ResolvedAlias::Literal("_a0".into()));
        // raw template preserved (Phase 5 will substitute)
        assert!(s.wheres[0].0.contains("${ref:t1}"));
    }

    #[test]
    fn ref_alias_two_idents_distinct() {
        let mut s = ProviderQuery::new();
        let mut q = empty_q();
        q.fields = Some(vec![
            field("a", Some("${ref:t1}"), None),
            field("b", Some("${ref:t2}"), None),
        ]);
        fold_contrib(&mut s, &q).unwrap();
        assert_eq!(s.aliases.lookup("t1").unwrap().literal, "_a0");
        assert_eq!(s.aliases.lookup("t2").unwrap().literal, "_a1");
    }

    #[test]
    fn ref_alias_second_use_collides() {
        // RULES §10 rule 4 forbids `${ref:X}` + `in_need: true`. So a second
        // provider re-declaring `${ref:t1}` (without in_need) must collide on
        // the already-allocated literal alias `_a0`.
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.join = Some(vec![join("t", "${ref:t1}", None)]);
        fold_contrib(&mut s, &q1).unwrap();

        let mut q2 = empty_q();
        q2.join = Some(vec![join("t_other", "${ref:t1}", None)]);
        let err = fold_contrib(&mut s, &q2).unwrap_err();
        assert!(matches!(err, FoldError::AliasCollision(_)));
    }

    #[test]
    fn ref_with_in_need_always_rejected() {
        // RULES §10 rule 4: `as: ${ref:...}` + `in_need: true` is invalid.
        let mut s = ProviderQuery::new();
        let mut j = join("t", "${ref:t1}", None);
        j.in_need = Some(true);
        let mut q = empty_q();
        q.join = Some(vec![j]);
        let err = fold_contrib(&mut s, &q).unwrap_err();
        assert_eq!(err, FoldError::RefAliasWithInNeed("t1".into()));
    }

    // ===== where_clear =====

    #[test]
    fn where_clear_drops_existing_matching_where() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.where_ = Some(SqlExpr("ai.album_id = 'A'".into()));
        fold_contrib(&mut s, &q1).unwrap();
        assert_eq!(s.wheres.len(), 1);

        let mut q2 = empty_q();
        q2.where_clear = Some(vec![SqlExpr("ai.album_id".into())]);
        fold_contrib(&mut s, &q2).unwrap();
        assert!(
            s.wheres.is_empty(),
            "where_clear should drop matching WHERE"
        );
    }

    #[test]
    fn where_clear_then_new_where_in_same_contrib() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.where_ = Some(SqlExpr("ai.album_id = 'A'".into()));
        fold_contrib(&mut s, &q1).unwrap();

        let mut q2 = empty_q();
        q2.where_clear = Some(vec![SqlExpr("ai.album_id".into())]);
        q2.where_ = Some(SqlExpr("ai.album_id = 'B'".into()));
        fold_contrib(&mut s, &q2).unwrap();
        // 父 WHERE 被剥, 新 WHERE 写入
        assert_eq!(s.wheres.len(), 1);
        assert_eq!(s.wheres[0].0, "ai.album_id = 'B'");
    }

    #[test]
    fn where_clear_keeps_non_matching() {
        let mut s = ProviderQuery::new();
        let mut q1 = empty_q();
        q1.where_ = Some(SqlExpr("images.plugin_id = 'pixiv'".into()));
        fold_contrib(&mut s, &q1).unwrap();
        let mut q2 = empty_q();
        q2.where_ = Some(SqlExpr("ai.album_id = 'A'".into()));
        fold_contrib(&mut s, &q2).unwrap();
        let mut q3 = empty_q();
        q3.where_clear = Some(vec![SqlExpr("ai.album_id".into())]);
        fold_contrib(&mut s, &q3).unwrap();
        assert_eq!(s.wheres.len(), 1);
        assert_eq!(s.wheres[0].0, "images.plugin_id = 'pixiv'");
    }
}
