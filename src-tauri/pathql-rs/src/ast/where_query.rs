//! `WhereQuery` — WHERE 谓词的递归树形态。
//!
//! 三种形态, JSON5 里靠**形状**判别, 无标签:
//!
//! | 写法 | 形态 | 语义 |
//! |---|---|---|
//! | `"a = 1"` | `Is` | 原子谓词; 内部可含 `and` / `or` / `not`, 引擎不解析, 只在坍缩时加括号 |
//! | `["a = 1", "b = 2"]` | `Any` | 成员之间 **OR** |
//! | `{ not: <WhereQuery> }` | `Not` | 整棵取非 |
//!
//! 树上刻意**没有 AND 节点**: AND 由路径折叠(各 contrib 天然 AND)与原子内部的
//! `and` 承担; 需要时也可用 De Morgan(`{not: [{not: a}, {not: b}]}`)表达。
//!
//! 树只活在 fold 期 —— [`WhereQuery::collapse`] 把它坍缩成**一条**普通 SQL 模板
//! 字符串后 push 进 `ProviderQuery.wheres`, 渲染层完全不知道树存在。

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

use crate::ast::expr::SqlExpr;

#[derive(Debug, Clone, PartialEq)]
pub enum WhereQuery {
    /// 原子谓词; 引擎不解析内部结构。
    Is(SqlExpr),
    /// 成员之间用 OR 连接。
    Any(Vec<WhereQuery>),
    /// 整棵取非。
    Not(Box<WhereQuery>),
}

impl WhereQuery {
    /// 作为**操作数**的坍缩形态: 恒带外层括号, 可安全嵌进 OR / NOT。
    /// 空 `Any`(或全空子树)返回 `None` —— 无谓词可言, 调用方直接跳过。
    fn collapse_operand(&self) -> Option<String> {
        match self {
            WhereQuery::Is(e) => Some(format!("({})", e.0)),
            WhereQuery::Any(items) => {
                let parts: Vec<String> = items.iter().filter_map(|i| i.collapse_operand()).collect();
                if parts.is_empty() {
                    return None;
                }
                Some(format!("({})", parts.join(" OR ")))
            }
            WhereQuery::Not(inner) => inner.collapse_operand().map(|s| format!("(NOT {})", s)),
        }
    }

    /// 坍缩成一条可直接 push 进 `ProviderQuery.wheres` 的谓词。
    ///
    /// 顶层 `Is` **不加括号** —— build 期本就给每条 where 包一层括号, 再加会让
    /// `where_clear` 的 substring 匹配和既有 SQL 快照全部漂移。
    pub fn collapse(&self) -> Option<SqlExpr> {
        match self {
            WhereQuery::Is(e) => Some(e.clone()),
            WhereQuery::Any(items) => {
                let parts: Vec<String> = items.iter().filter_map(|i| i.collapse_operand()).collect();
                if parts.is_empty() {
                    return None;
                }
                Some(SqlExpr(parts.join(" OR ")))
            }
            WhereQuery::Not(inner) => inner
                .collapse_operand()
                .map(|s| SqlExpr(format!("NOT {}", s))),
        }
    }

    /// 深度优先遍历每个原子, 附带用于报错的字段路径(如 `query.where[0].not`)。
    pub fn for_each_expr(&self, base: &str, f: &mut impl FnMut(&SqlExpr, &str)) {
        match self {
            WhereQuery::Is(e) => f(e, base),
            WhereQuery::Any(items) => {
                for (i, item) in items.iter().enumerate() {
                    item.for_each_expr(&format!("{}[{}]", base, i), f);
                }
            }
            WhereQuery::Not(inner) => inner.for_each_expr(&format!("{}.not", base), f),
        }
    }

    /// 就地改写每个原子(dsl_provider 的 `${properties.X}` intern 用)。
    pub fn map_exprs_mut(&mut self, f: &mut impl FnMut(&mut SqlExpr)) {
        match self {
            WhereQuery::Is(e) => f(e),
            WhereQuery::Any(items) => {
                for item in items.iter_mut() {
                    item.map_exprs_mut(f);
                }
            }
            WhereQuery::Not(inner) => inner.map_exprs_mut(f),
        }
    }
}

impl From<SqlExpr> for WhereQuery {
    fn from(value: SqlExpr) -> Self {
        WhereQuery::Is(value)
    }
}

impl From<&str> for WhereQuery {
    fn from(value: &str) -> Self {
        WhereQuery::Is(SqlExpr(value.to_string()))
    }
}

impl Serialize for WhereQuery {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            WhereQuery::Is(e) => serializer.serialize_str(&e.0),
            WhereQuery::Any(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            WhereQuery::Not(inner) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("not", inner.as_ref())?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for WhereQuery {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(WhereQueryVisitor)
    }
}

struct WhereQueryVisitor;

impl<'de> Visitor<'de> for WhereQueryVisitor {
    type Value = WhereQuery;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a SQL predicate string, an array of WhereQuery (OR), or `{not: <WhereQuery>}`")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(WhereQuery::Is(SqlExpr(v.to_string())))
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(WhereQuery::Is(SqlExpr(v)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<WhereQuery>()? {
            items.push(item);
        }
        if items.is_empty() {
            // 空 OR 无意义, 且多半是生成逻辑的 bug; 让它在加载期就炸而不是静默丢谓词。
            return Err(de::Error::custom(
                "`where` OR array must not be empty; remove the field instead of writing `[]`",
            ));
        }
        Ok(WhereQuery::Any(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut inner: Option<WhereQuery> = None;
        while let Some(key) = map.next_key::<String>()? {
            if key != "not" {
                return Err(de::Error::custom(format!(
                    "unknown key `{}` in `where` object form; only `not` is allowed",
                    key
                )));
            }
            if inner.is_some() {
                return Err(de::Error::duplicate_field("not"));
            }
            inner = Some(map.next_value::<WhereQuery>()?);
        }
        let inner = inner.ok_or_else(|| de::Error::missing_field("not"))?;
        Ok(WhereQuery::Not(Box::new(inner)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> WhereQuery {
        serde_json::from_str(s).unwrap()
    }

    // ===== 形态判别 =====

    #[test]
    fn string_is_atom() {
        assert_eq!(parse(r#""a = 1""#), WhereQuery::Is(SqlExpr("a = 1".into())));
    }

    #[test]
    fn array_is_any() {
        assert_eq!(
            parse(r#"["a = 1", "b = 2"]"#),
            WhereQuery::Any(vec!["a = 1".into(), "b = 2".into()])
        );
    }

    #[test]
    fn object_not_is_negation() {
        assert_eq!(
            parse(r#"{"not": "a = 1"}"#),
            WhereQuery::Not(Box::new("a = 1".into()))
        );
    }

    #[test]
    fn nested_tree() {
        let q = parse(r#"["a = 1", {"not": ["b = 2", "c = 3"]}]"#);
        assert_eq!(
            q,
            WhereQuery::Any(vec![
                "a = 1".into(),
                WhereQuery::Not(Box::new(WhereQuery::Any(vec![
                    "b = 2".into(),
                    "c = 3".into()
                ])))
            ])
        );
    }

    #[test]
    fn empty_array_rejected() {
        let err = serde_json::from_str::<WhereQuery>("[]").unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn nested_empty_array_rejected() {
        let err = serde_json::from_str::<WhereQuery>(r#"{"not": []}"#).unwrap_err();
        assert!(err.to_string().contains("must not be empty"));
    }

    #[test]
    fn unknown_object_key_rejected() {
        let err = serde_json::from_str::<WhereQuery>(r#"{"and": "a = 1"}"#).unwrap_err();
        assert!(err.to_string().contains("unknown key `and`"));
    }

    #[test]
    fn roundtrip_serialize() {
        let src = r#"["a = 1",{"not":["b = 2","c = 3"]}]"#;
        let q = parse(src);
        assert_eq!(serde_json::to_string(&q).unwrap(), src);
    }

    // ===== 坍缩 =====

    #[test]
    fn collapse_atom_keeps_bare_form() {
        // 顶层 Is 不加括号: build 期已经包一层, where_clear 也按原串匹配。
        let q: WhereQuery = "ai.album_id = 'A'".into();
        assert_eq!(q.collapse().unwrap().0, "ai.album_id = 'A'");
    }

    #[test]
    fn collapse_any_joins_with_or() {
        let q = parse(r#"["a = 1", "b = 2"]"#);
        assert_eq!(q.collapse().unwrap().0, "(a = 1) OR (b = 2)");
    }

    #[test]
    fn collapse_any_single_member_degenerates() {
        let q = parse(r#"["a = 1"]"#);
        assert_eq!(q.collapse().unwrap().0, "(a = 1)");
    }

    #[test]
    fn collapse_not_wraps_operand() {
        let q = parse(r#"{"not": "a = 1"}"#);
        assert_eq!(q.collapse().unwrap().0, "NOT (a = 1)");
    }

    #[test]
    fn collapse_nested_tree_parenthesized() {
        let q = parse(r#"["a = 1", {"not": ["b = 2", "c = 3"]}]"#);
        assert_eq!(
            q.collapse().unwrap().0,
            "(a = 1) OR (NOT ((b = 2) OR (c = 3)))"
        );
    }

    #[test]
    fn collapse_preserves_template_placeholders() {
        let q = parse(r#"["x = ${properties.a}", "y = ${capture[1]}"]"#);
        assert_eq!(
            q.collapse().unwrap().0,
            "(x = ${properties.a}) OR (y = ${capture[1]})"
        );
    }

    // ===== 遍历 / 改写 =====

    #[test]
    fn for_each_expr_visits_all_atoms_with_paths() {
        let q = parse(r#"["a", {"not": ["b", "c"]}]"#);
        let mut seen = Vec::new();
        q.for_each_expr("query.where", &mut |e, path| {
            seen.push((path.to_string(), e.0.clone()));
        });
        assert_eq!(
            seen,
            vec![
                ("query.where[0]".to_string(), "a".to_string()),
                ("query.where[1].not[0]".to_string(), "b".to_string()),
                ("query.where[1].not[1]".to_string(), "c".to_string()),
            ]
        );
    }

    #[test]
    fn map_exprs_mut_rewrites_every_atom() {
        let mut q = parse(r#"["a", {"not": "b"}]"#);
        q.map_exprs_mut(&mut |e| e.0 = format!("<{}>", e.0));
        assert_eq!(q.collapse().unwrap().0, "(<a>) OR (NOT (<b>))");
    }
}
