use crate::ast::invocation::ProviderInvocation;
use indexmap::IndexMap;
use serde::{de, Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolveEntry {
    #[serde(flatten)]
    pub invocation: ProviderInvocation,
    #[serde(default)]
    pub alias: Option<String>,
}

impl<'de> Deserialize<'de> for ResolveEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut fields = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let alias = fields
            .remove("alias")
            .map(Option::<String>::deserialize)
            .transpose()
            .map_err(de::Error::custom)?
            .flatten();
        let invocation = ProviderInvocation::deserialize(serde_json::Value::Object(fields))
            .map_err(de::Error::custom)?;
        Ok(Self { invocation, alias })
    }
}

impl From<ProviderInvocation> for ResolveEntry {
    fn from(invocation: ProviderInvocation) -> Self {
        Self {
            invocation,
            alias: None,
        }
    }
}

/// resolve 表。IndexMap 保住 json5 文档里的声明顺序——匹配按声明顺序逐条尝试，
/// 首个命中生效。宽泛的兜底正则（如维度值捕获）必须放在保留段条目之后。
#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Resolve(pub IndexMap<String, ResolveEntry>);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::names::ProviderName;

    #[test]
    fn single_regex_by_name() {
        let v: Resolve = serde_json::from_str(r#"{"^x([0-9]+)$":{"provider":"foo"}}"#).unwrap();
        assert_eq!(v.0.len(), 1);
        let entry = v.0.get("^x([0-9]+)$").unwrap();
        match &entry.invocation {
            ProviderInvocation::ByName(b) => assert_eq!(b.provider, ProviderName("foo".into())),
            _ => panic!("expected ByName"),
        }
        assert_eq!(entry.alias, None);
    }

    #[test]
    fn single_regex_with_alias() {
        let v: Resolve =
            serde_json::from_str(r#"{"^x([0-9]+)$":{"provider":"foo","alias":"page_size"}}"#)
                .unwrap();
        let entry = v.0.get("^x([0-9]+)$").unwrap();
        assert_eq!(entry.alias.as_deref(), Some("page_size"));
        assert!(matches!(entry.invocation, ProviderInvocation::ByName(_)));
    }

    #[test]
    fn alias_preserves_delegate_discrimination() {
        let v: Resolve =
            serde_json::from_str(r#"{".*":{"delegate":{"provider":"foo"},"alias":"fallback"}}"#)
                .unwrap();
        let entry = v.0.get(".*").unwrap();
        assert_eq!(entry.alias.as_deref(), Some("fallback"));
        assert!(matches!(
            entry.invocation,
            ProviderInvocation::ByDelegate(_)
        ));
    }

    #[test]
    fn alias_does_not_relax_unknown_field_rejection() {
        let result: Result<Resolve, _> =
            serde_json::from_str(r#"{"x":{"provider":"foo","alias":"entry","unknown":true}}"#);
        assert!(result.is_err());
    }

    #[test]
    fn multi_regex() {
        let v: Resolve =
            serde_json::from_str(r#"{"a":{"provider":"x"},"^b.*$":{"provider":"y"}}"#).unwrap();
        assert_eq!(v.0.len(), 2);
    }

    #[test]
    fn empty_object() {
        let v: Resolve = serde_json::from_str(r#"{}"#).unwrap();
        assert!(v.0.is_empty());
    }

    #[test]
    fn delegate_string_no_longer_accepted() {
        // 6e: ProviderInvocation::ByDelegate variant deleted. `{"delegate": "..."}`
        // is no longer a valid invocation form (zero hits in real .json5 corpus).
        let r: Result<Resolve, _> = serde_json::from_str(r#"{"k":{"delegate":"./x"}}"#);
        assert!(r.is_err());
    }

    #[test]
    fn empty_value() {
        let v: Resolve = serde_json::from_str(r#"{"k":{}}"#).unwrap();
        let entry = v.0.get("k").unwrap();
        assert!(matches!(entry.invocation, ProviderInvocation::Empty(_)));
        assert_eq!(entry.alias, None);
    }
}
