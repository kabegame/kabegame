use crate::ast::{
    list::List, names::*, property::PropertyDecl, query::Query, resolve::Resolve,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDef {
    /// schema 锚点字段；忽略
    #[serde(default, rename = "$schema")]
    pub schema: Option<String>,
    #[serde(default)]
    pub namespace: Option<Namespace>,
    pub name: SimpleName,
    #[serde(default)]
    pub properties: Option<HashMap<String, PropertyDecl>>,
    #[serde(default)]
    pub query: Option<Query>,
    #[serde(default)]
    pub list: Option<List>,
    #[serde(default)]
    pub resolve: Option<Resolve>,
    #[serde(default)]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_def() {
        let v: ProviderDef = serde_json::from_str(r#"{"name":"foo"}"#).unwrap();
        assert_eq!(v.name, SimpleName("foo".into()));
        assert_eq!(v.namespace, None);
        assert!(v.properties.is_none());
        assert!(v.query.is_none());
        assert!(v.list.is_none());
        assert!(v.resolve.is_none());
        assert!(v.note.is_none());
        assert!(v.schema.is_none());
    }

    #[test]
    fn with_schema_anchor() {
        let v: ProviderDef =
            serde_json::from_str(r#"{"$schema":"./schema.json5","name":"foo"}"#).unwrap();
        assert_eq!(v.schema, Some("./schema.json5".into()));
        assert_eq!(v.name, SimpleName("foo".into()));
    }

    #[test]
    fn missing_name_rejected() {
        let r: Result<ProviderDef, _> = serde_json::from_str(r#"{}"#);
        assert!(r.is_err());
    }

    #[test]
    fn unknown_field_rejected() {
        let r: Result<ProviderDef, _> =
            serde_json::from_str(r#"{"name":"foo","unknown":1}"#);
        assert!(r.is_err());
    }

    #[test]
    fn with_namespace() {
        let v: ProviderDef = serde_json::from_str(
            r#"{"namespace":"kabegame","name":"foo"}"#,
        )
        .unwrap();
        assert_eq!(v.namespace, Some(Namespace("kabegame".into())));
    }
}
