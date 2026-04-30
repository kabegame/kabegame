use crate::ast::{expr::*, invocation::ProviderCall, order::OrderForm, query_atoms::*};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DelegateQuery {
    pub delegate: ProviderCall,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContribQuery {
    #[serde(default)]
    pub fields: Option<Vec<Field>>,
    #[serde(default)]
    pub from: Option<SqlExpr>,
    #[serde(default)]
    pub join: Option<Vec<Join>>,
    #[serde(default, rename = "where")]
    pub where_: Option<SqlExpr>,
    /// 7c: 折叠期 substring 移除已有 WHERE 子句; 在新 `where` 写入前生效。
    /// 用例: VD `vd_sub_album_gate_provider` 进入子画册 gate 时, 剥除父
    /// `ai.album_id = ?` WHERE, 让下游 entry 写入新 album_id 不形成
    /// 永远空的 `A AND B`。
    #[serde(default)]
    pub where_clear: Option<Vec<SqlExpr>>,
    #[serde(default)]
    pub order: Option<OrderForm>,
    #[serde(default)]
    pub offset: Option<NumberOrTemplate>,
    #[serde(default)]
    pub limit: Option<NumberOrTemplate>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Query {
    Delegate(DelegateQuery),
    Contrib(ContribQuery),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegate_form() {
        let v: Query = serde_json::from_str(r#"{"delegate":{"provider":"foo"}}"#).unwrap();
        match v {
            Query::Delegate(d) => {
                assert_eq!(d.delegate.provider, crate::ast::ProviderName("foo".into()));
                assert!(d.delegate.properties.is_none());
            }
            _ => panic!("expected Delegate"),
        }
    }

    #[test]
    fn delegate_form_with_properties() {
        let v: Query = serde_json::from_str(
            r#"{"delegate":{"provider":"foo","properties":{"page_size":100}}}"#,
        )
        .unwrap();
        match v {
            Query::Delegate(d) => {
                assert!(d.delegate.properties.is_some());
            }
            _ => panic!("expected Delegate"),
        }
    }

    #[test]
    fn contrib_limit_zero() {
        let v: Query = serde_json::from_str(r#"{"limit":0}"#).unwrap();
        match v {
            Query::Contrib(c) => {
                assert_eq!(c.limit, Some(NumberOrTemplate::Number(0.0)));
                assert_eq!(c.from, None);
            }
            _ => panic!("expected Contrib"),
        }
    }

    #[test]
    fn contrib_from_and_limit() {
        let v: Query = serde_json::from_str(r#"{"from":"images","limit":0}"#).unwrap();
        match v {
            Query::Contrib(c) => {
                assert_eq!(c.from, Some(SqlExpr("images".into())));
                assert_eq!(c.limit, Some(NumberOrTemplate::Number(0.0)));
            }
            _ => panic!("expected Contrib"),
        }
    }

    #[test]
    fn delegate_with_extra_field_rejected() {
        let r: Result<Query, _> =
            serde_json::from_str(r#"{"delegate":{"provider":"foo"},"limit":0}"#);
        assert!(r.is_err());
    }

    #[test]
    fn empty_object_is_default_contrib() {
        let v: Query = serde_json::from_str(r#"{}"#).unwrap();
        match v {
            Query::Contrib(c) => assert_eq!(c, ContribQuery::default()),
            _ => panic!("expected Contrib"),
        }
    }

    #[test]
    fn where_rename() {
        let v: Query = serde_json::from_str(r#"{"where":"x>0"}"#).unwrap();
        match v {
            Query::Contrib(c) => assert_eq!(c.where_, Some(SqlExpr("x>0".into()))),
            _ => panic!("expected Contrib"),
        }
    }

    #[test]
    fn contrib_offset_template() {
        let v: Query =
            serde_json::from_str(r#"{"offset":"${properties.page_size} * (${properties.page_num} - 1)","limit":"${properties.page_size}"}"#)
                .unwrap();
        match v {
            Query::Contrib(c) => {
                assert!(matches!(c.offset, Some(NumberOrTemplate::Template(_))));
                assert!(matches!(c.limit, Some(NumberOrTemplate::Template(_))));
            }
            _ => panic!("expected Contrib"),
        }
    }

    #[test]
    fn contrib_unknown_field_rejected() {
        let r: Result<Query, _> = serde_json::from_str(r#"{"limit":0,"frob":1}"#);
        assert!(r.is_err());
    }
}
