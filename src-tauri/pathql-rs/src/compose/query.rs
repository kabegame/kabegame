use super::aliases::{AliasTable, ResolvedAlias};
use super::order::OrderState;
use crate::ast::{JoinKind, NumberOrTemplate, SqlExpr};

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
}
