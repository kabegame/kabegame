use crate::ast::expr::SqlExpr;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct AliasName(pub String);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Field {
    pub sql: SqlExpr,
    #[serde(default, rename = "as")]
    pub alias: Option<AliasName>,
    #[serde(default)]
    pub in_need: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldFull {
    pub sql: SqlExpr,
    #[serde(default, rename = "as")]
    pub alias: Option<AliasName>,
    #[serde(default)]
    pub in_need: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
enum FieldRepr {
    Inline(SqlExpr),
    Full(FieldFull),
}

impl<'de> Deserialize<'de> for Field {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match FieldRepr::deserialize(deserializer)? {
            FieldRepr::Inline(sql) => Ok(Self {
                sql,
                alias: None,
                in_need: None,
            }),
            FieldRepr::Full(full) => Ok(Self {
                sql: full.sql,
                alias: full.alias,
                in_need: full.in_need,
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum JoinKind {
    Inner,
    Left,
    Right,
    Full,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Join {
    #[serde(default)]
    pub kind: Option<JoinKind>,
    pub table: SqlExpr,
    #[serde(rename = "as")]
    pub alias: AliasName,
    #[serde(default)]
    pub on: Option<SqlExpr>,
    #[serde(default)]
    pub in_need: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_with_alias() {
        let v: Field = serde_json::from_str(r#"{"sql":"images.id","as":"img_id"}"#).unwrap();
        assert_eq!(v.sql, SqlExpr("images.id".into()));
        assert_eq!(v.alias, Some(AliasName("img_id".into())));
        assert_eq!(v.in_need, None);
    }

    #[test]
    fn field_minimal() {
        let v: Field = serde_json::from_str(r#"{"sql":"x"}"#).unwrap();
        assert_eq!(v.sql, SqlExpr("x".into()));
        assert_eq!(v.alias, None);
    }

    #[test]
    fn field_inline_string() {
        let v: Field = serde_json::from_str(r#""images.url""#).unwrap();
        assert_eq!(v.sql, SqlExpr("images.url".into()));
        assert_eq!(v.alias, None);
        assert_eq!(v.in_need, None);
    }

    #[test]
    fn field_in_need() {
        let v: Field = serde_json::from_str(r#"{"sql":"x","in_need":true}"#).unwrap();
        assert_eq!(v.in_need, Some(true));
    }

    #[test]
    fn field_unknown_field_rejected() {
        let r: Result<Field, _> = serde_json::from_str(r#"{"sql":"x","unknown":1}"#);
        assert!(r.is_err());
    }

    #[test]
    fn join_kind_uppercase() {
        let v: Join = serde_json::from_str(r#"{"table":"x","as":"y","kind":"LEFT"}"#).unwrap();
        assert_eq!(v.kind, Some(JoinKind::Left));
        assert_eq!(v.table, SqlExpr("x".into()));
        assert_eq!(v.alias, AliasName("y".into()));
    }

    #[test]
    fn join_kind_omitted() {
        let v: Join = serde_json::from_str(r#"{"table":"x","as":"y"}"#).unwrap();
        assert_eq!(v.kind, None);
    }

    #[test]
    fn join_full_with_on() {
        let v: Join = serde_json::from_str(
            r#"{"table":"a","as":"b","kind":"INNER","on":"a.id = b.id","in_need":false}"#,
        )
        .unwrap();
        assert_eq!(v.kind, Some(JoinKind::Inner));
        assert_eq!(v.on, Some(SqlExpr("a.id = b.id".into())));
        assert_eq!(v.in_need, Some(false));
    }

    #[test]
    fn join_kind_lowercase_rejected() {
        let r: Result<Join, _> = serde_json::from_str(r#"{"table":"x","as":"y","kind":"left"}"#);
        assert!(r.is_err());
    }

    #[test]
    fn join_unknown_field_rejected() {
        let r: Result<Join, _> = serde_json::from_str(r#"{"table":"x","as":"y","extra":1}"#);
        assert!(r.is_err());
    }
}
