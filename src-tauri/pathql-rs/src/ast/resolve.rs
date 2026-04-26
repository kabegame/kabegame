use crate::ast::invocation::ProviderInvocation;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Resolve(pub HashMap<String, ProviderInvocation>);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::names::ProviderName;

    #[test]
    fn single_regex_by_name() {
        let v: Resolve =
            serde_json::from_str(r#"{"^x([0-9]+)$":{"provider":"foo"}}"#).unwrap();
        assert_eq!(v.0.len(), 1);
        let entry = v.0.get("^x([0-9]+)$").unwrap();
        match entry {
            ProviderInvocation::ByName(b) => assert_eq!(b.provider, ProviderName("foo".into())),
            _ => panic!("expected ByName"),
        }
    }

    #[test]
    fn multi_regex() {
        let v: Resolve = serde_json::from_str(
            r#"{"a":{"provider":"x"},"^b.*$":{"provider":"y"}}"#,
        )
        .unwrap();
        assert_eq!(v.0.len(), 2);
    }

    #[test]
    fn empty_object() {
        let v: Resolve = serde_json::from_str(r#"{}"#).unwrap();
        assert!(v.0.is_empty());
    }

    #[test]
    fn by_delegate_value() {
        let v: Resolve = serde_json::from_str(r#"{"k":{"delegate":"./x"}}"#).unwrap();
        assert!(matches!(
            v.0.get("k"),
            Some(ProviderInvocation::ByDelegate(_))
        ));
    }

    #[test]
    fn empty_value() {
        let v: Resolve = serde_json::from_str(r#"{"k":{}}"#).unwrap();
        assert!(matches!(v.0.get("k"), Some(ProviderInvocation::Empty(_))));
    }
}
