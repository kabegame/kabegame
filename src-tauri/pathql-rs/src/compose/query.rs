use super::aliases::{AliasTable, ResolvedAlias};
use super::fold::FoldError;
use super::order::OrderState;
use crate::ast::{JoinKind, NumberOrTemplate, OrderDirection, SqlExpr};
use crate::template::eval::TemplateValue;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct FieldFrag {
    pub sql: SqlExpr,
    pub alias: Option<ResolvedAlias>,
    /// 标记此项是否携带 in_need 语义（信息保留, 用于 fold 后续诊断; 实际去重在 fold 时已完成）。
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

/// fold 累积的结构化中间表示。SQL 渲染（含模板求值与 bind params）留给 Phase 5。
#[derive(Debug, Clone, Default)]
pub struct ProviderQuery {
    /// FROM 子句; cascading-replace。
    pub from: Option<SqlExpr>,
    /// SELECT 字段累积; 按 alias 字面去重。
    pub fields: Vec<FieldFrag>,
    /// JOIN 累积; 按 alias 字面去重。
    pub joins: Vec<JoinFrag>,
    /// WHERE 谓词累积; 渲染时用 AND 串接。
    pub wheres: Vec<SqlExpr>,
    /// ORDER BY 累积。
    pub order: OrderState,
    /// OFFSET 累加项; 渲染时用 + 串接。
    pub offset_terms: Vec<NumberOrTemplate>,
    /// LIMIT; last-wins。
    pub limit: Option<NumberOrTemplate>,
    /// `${ref:X}` → 字面别名映射（fold 期分配的 _aN）。
    pub aliases: AliasTable,
    /// raw-bind API 内部生成的 properties（`__pq_raw_N`）；build_sql 时合并到 ctx.properties。
    pub adhoc_properties: HashMap<String, TemplateValue>,
    pub(crate) adhoc_counter: u32,
}

impl ProviderQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// 路径上是否已有同字面 field alias。
    pub(crate) fn has_field_alias(&self, name: &str) -> bool {
        self.fields
            .iter()
            .any(|f| f.alias.as_ref().and_then(|a| a.as_literal()) == Some(name))
    }

    /// 路径上是否已有同字面 join alias。
    pub(crate) fn has_join_alias(&self, name: &str) -> bool {
        self.joins
            .iter()
            .any(|j| j.alias.as_literal() == Some(name))
    }

    // ============================================================================
    // raw-bind API: 给 Rust 端 hardcoded provider 用的便利构造器。
    // 内部把 SQL 中的 `?` 替换为 `${properties.__pq_raw_N}`, params 注册进
    // adhoc_properties; build_sql 把 adhoc 合并到 ctx 后做正常渲染。
    // ============================================================================

    /// 把 `sql` 里的 `?` 占位逐个替换为 `${properties.__pq_raw_N}`,
    /// 同时把对应 param 注册进 adhoc_properties。
    /// `?` 数量必须等于 `params.len()`，否则 panic。
    fn intern_raw(&mut self, sql: &str, params: &[TemplateValue]) -> SqlExpr {
        let q_count = sql.bytes().filter(|b| *b == b'?').count();
        assert_eq!(
            q_count,
            params.len(),
            "intern_raw: `?` count {} != params.len() {} (sql=`{}`)",
            q_count,
            params.len(),
            sql
        );
        let mut out = String::with_capacity(sql.len() + params.len() * 16);
        let mut i = 0;
        let bytes = sql.as_bytes();
        let mut param_idx = 0;
        while i < bytes.len() {
            if bytes[i] == b'?' {
                let key = format!("__pq_raw_{}", self.adhoc_counter);
                self.adhoc_counter += 1;
                self.adhoc_properties
                    .insert(key.clone(), params[param_idx].clone());
                param_idx += 1;
                out.push_str("${properties.");
                out.push_str(&key);
                out.push('}');
                i += 1;
            } else {
                let ch_end = next_char_boundary(sql, i);
                out.push_str(&sql[i..ch_end]);
                i = ch_end;
            }
        }
        SqlExpr(out)
    }

    /// 追加一条 WHERE 谓词；`?` 占位用 params 填。
    pub fn with_where_raw(mut self, sql: &str, params: &[TemplateValue]) -> Self {
        let interned = self.intern_raw(sql, params);
        self.wheres.push(interned);
        self
    }

    /// 追加一条 JOIN；on 内部 `?` 占位用 params 填。
    /// alias 字面冲突按 fold 同样规则报错。
    pub fn with_join_raw(
        mut self,
        kind: JoinKind,
        table: &str,
        alias: &str,
        on: Option<&str>,
        params: &[TemplateValue],
    ) -> Result<Self, FoldError> {
        if self.has_join_alias(alias) {
            return Err(FoldError::AliasCollision(alias.to_string()));
        }
        // table 不接受 `?` 占位（避免在 SQL 表名位置参数化）；params 全部用于 on
        let table_expr = SqlExpr(table.to_string());
        let on_expr = on.map(|o| self.intern_raw(o, params));
        self.joins.push(JoinFrag {
            kind,
            table: table_expr,
            alias: ResolvedAlias::Literal(alias.to_string()),
            on: on_expr,
            in_need: false,
        });
        Ok(self)
    }

    /// 追加一项 ORDER BY 字段；同名 field 后声明覆盖前 (fold upsert 语义)。
    pub fn with_order_raw(mut self, expr: &str, dir: OrderDirection) -> Self {
        self.order.upsert(expr.to_string(), dir);
        self
    }

    /// 把 ORDER BY 项**插到最前**，绕开 upsert 的"位置保留"语义。
    /// 用于上层 provider 想覆盖下游默认排序。
    pub fn prepend_order_raw(mut self, expr: &str, dir: OrderDirection) -> Self {
        // 先移除已有同名 entry
        self.order.entries.retain(|(f, _)| f != expr);
        self.order.entries.insert(0, (expr.to_string(), dir));
        self
    }

    /// 追加一项 SELECT 字段；可选 alias；`?` 占位用 params 填。
    pub fn with_field_raw(
        mut self,
        sql: &str,
        alias: Option<&str>,
        params: &[TemplateValue],
    ) -> Self {
        let interned = self.intern_raw(sql, params);
        self.fields.push(FieldFrag {
            sql: interned,
            alias: alias.map(|a| ResolvedAlias::Literal(a.to_string())),
            in_need: false,
        });
        self
    }
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_empty() {
        let q = ProviderQuery::new();
        assert!(q.from.is_none());
        assert!(q.fields.is_empty());
        assert!(q.joins.is_empty());
        assert!(q.wheres.is_empty());
        assert!(q.order.entries.is_empty());
        assert!(q.order.global.is_none());
        assert!(q.offset_terms.is_empty());
        assert!(q.limit.is_none());
        assert_eq!(q.aliases.counter, 0);
    }

    #[test]
    fn has_field_alias_finds_literal() {
        let mut q = ProviderQuery::new();
        q.fields.push(FieldFrag {
            sql: SqlExpr("x".into()),
            alias: Some(ResolvedAlias::Literal("ax".into())),
            in_need: false,
        });
        assert!(q.has_field_alias("ax"));
        assert!(!q.has_field_alias("ay"));
    }

    #[test]
    fn has_field_alias_skips_unresolved() {
        let mut q = ProviderQuery::new();
        q.fields.push(FieldFrag {
            sql: SqlExpr("x".into()),
            alias: Some(ResolvedAlias::UnresolvedRef("foo".into())),
            in_need: false,
        });
        // unresolved should not count as literal alias
        assert!(!q.has_field_alias("foo"));
    }

    #[test]
    fn has_join_alias_finds_literal() {
        let mut q = ProviderQuery::new();
        q.joins.push(JoinFrag {
            kind: JoinKind::Inner,
            table: SqlExpr("t".into()),
            alias: ResolvedAlias::Literal("ai".into()),
            on: None,
            in_need: false,
        });
        assert!(q.has_join_alias("ai"));
        assert!(!q.has_join_alias("aj"));
    }

    // ===== raw-bind API =====

    #[test]
    fn with_where_raw_simple() {
        let q = ProviderQuery::new()
            .with_where_raw("x = ?", &[TemplateValue::Int(7)]);
        assert_eq!(q.wheres.len(), 1);
        assert_eq!(q.wheres[0].0, "x = ${properties.__pq_raw_0}");
        assert_eq!(
            q.adhoc_properties.get("__pq_raw_0"),
            Some(&TemplateValue::Int(7))
        );
        assert_eq!(q.adhoc_counter, 1);
    }

    #[test]
    fn with_where_raw_multi_params() {
        let q = ProviderQuery::new().with_where_raw(
            "a = ? AND b > ?",
            &[TemplateValue::Int(1), TemplateValue::Int(2)],
        );
        assert_eq!(
            q.wheres[0].0,
            "a = ${properties.__pq_raw_0} AND b > ${properties.__pq_raw_1}"
        );
        assert_eq!(q.adhoc_counter, 2);
    }

    #[test]
    #[should_panic(expected = "intern_raw: `?` count")]
    fn with_where_raw_count_mismatch_panics() {
        let _ = ProviderQuery::new().with_where_raw("a = ? AND b = ?", &[TemplateValue::Int(1)]);
    }

    #[test]
    fn with_join_raw_simple() {
        let q = ProviderQuery::new()
            .with_join_raw(
                JoinKind::Inner,
                "album_images",
                "ai",
                Some("ai.image_id = images.id"),
                &[],
            )
            .unwrap();
        assert_eq!(q.joins.len(), 1);
        assert_eq!(q.joins[0].alias.as_literal(), Some("ai"));
        assert_eq!(q.joins[0].kind, JoinKind::Inner);
    }

    #[test]
    fn with_join_raw_with_param_in_on() {
        let q = ProviderQuery::new()
            .with_join_raw(
                JoinKind::Left,
                "tags",
                "t",
                Some("t.image_id = images.id AND t.kind = ?"),
                &[TemplateValue::Text("primary".into())],
            )
            .unwrap();
        let on = q.joins[0].on.as_ref().unwrap();
        assert!(on.0.contains("${properties.__pq_raw_0}"));
        assert_eq!(
            q.adhoc_properties.get("__pq_raw_0"),
            Some(&TemplateValue::Text("primary".into()))
        );
    }

    #[test]
    fn with_join_raw_dedup_collision() {
        let q = ProviderQuery::new()
            .with_join_raw(JoinKind::Inner, "t1", "x", None, &[])
            .unwrap();
        let r = q.with_join_raw(JoinKind::Inner, "t2", "x", None, &[]);
        assert!(matches!(r, Err(FoldError::AliasCollision(_))));
    }

    #[test]
    fn with_order_raw_simple() {
        let q = ProviderQuery::new().with_order_raw("title", OrderDirection::Asc);
        assert_eq!(q.order.entries, vec![("title".into(), OrderDirection::Asc)]);
    }

    #[test]
    fn with_order_raw_overwrites_same_field() {
        let q = ProviderQuery::new()
            .with_order_raw("title", OrderDirection::Asc)
            .with_order_raw("title", OrderDirection::Desc);
        assert_eq!(q.order.entries.len(), 1);
        assert_eq!(q.order.entries[0].1, OrderDirection::Desc);
    }

    #[test]
    fn prepend_order_raw_inserts_at_head() {
        let q = ProviderQuery::new()
            .with_order_raw("a", OrderDirection::Asc)
            .with_order_raw("b", OrderDirection::Desc)
            .prepend_order_raw("z", OrderDirection::Asc);
        assert_eq!(q.order.entries.len(), 3);
        assert_eq!(q.order.entries[0].0, "z");
        assert_eq!(q.order.entries[1].0, "a");
        assert_eq!(q.order.entries[2].0, "b");
    }

    #[test]
    fn prepend_order_raw_replaces_existing() {
        let q = ProviderQuery::new()
            .with_order_raw("a", OrderDirection::Asc)
            .with_order_raw("b", OrderDirection::Desc)
            .prepend_order_raw("a", OrderDirection::Desc);
        assert_eq!(q.order.entries.len(), 2);
        assert_eq!(q.order.entries[0], ("a".into(), OrderDirection::Desc));
        assert_eq!(q.order.entries[1], ("b".into(), OrderDirection::Desc));
    }

    #[test]
    fn with_field_raw_no_alias() {
        let q = ProviderQuery::new().with_field_raw("images.id", None, &[]);
        assert_eq!(q.fields.len(), 1);
        assert!(q.fields[0].alias.is_none());
    }

    #[test]
    fn with_field_raw_with_alias_and_param() {
        let q = ProviderQuery::new().with_field_raw(
            "images.id + ?",
            Some("y"),
            &[TemplateValue::Int(10)],
        );
        assert!(q.fields[0].sql.0.contains("${properties.__pq_raw_0}"));
        assert_eq!(q.fields[0].alias.as_ref().unwrap().as_literal(), Some("y"));
    }
}
