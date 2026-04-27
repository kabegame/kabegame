use crate::ast::{expr::*, names::*, property::TemplateValue, MetaValue};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByName {
    pub provider: ProviderName,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByDelegate {
    pub delegate: PathExpr,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyInvocation {
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ProviderInvocation {
    ByName(InvokeByName),
    ByDelegate(InvokeByDelegate),
    Empty(EmptyInvocation),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_name_simple() {
        let v: ProviderInvocation = serde_json::from_str(r#"{"provider":"foo"}"#).unwrap();
        match v {
            ProviderInvocation::ByName(b) => {
                assert_eq!(b.provider, ProviderName("foo".into()));
                assert_eq!(b.properties, None);
                assert_eq!(b.meta, None);
            }
            _ => panic!("expected ByName"),
        }
    }

    #[test]
    fn by_delegate_simple() {
        let v: ProviderInvocation = serde_json::from_str(r#"{"delegate":"./bar"}"#).unwrap();
        assert!(matches!(v, ProviderInvocation::ByDelegate(_)));
    }

    #[test]
    fn empty() {
        let v: ProviderInvocation = serde_json::from_str(r#"{}"#).unwrap();
        match v {
            ProviderInvocation::Empty(e) => assert_eq!(e.meta, None),
            _ => panic!("expected Empty"),
        }
    }

    #[test]
    fn empty_with_meta() {
        let v: ProviderInvocation = serde_json::from_str(r#"{"meta":{"k":"v"}}"#).unwrap();
        match v {
            ProviderInvocation::Empty(e) => assert!(e.meta.is_some()),
            _ => panic!("expected Empty"),
        }
    }

    #[test]
    fn provider_and_delegate_rejected() {
        let r: Result<ProviderInvocation, _> =
            serde_json::from_str(r#"{"provider":"foo","delegate":"./bar"}"#);
        assert!(r.is_err());
    }

    #[test]
    fn by_name_with_properties() {
        let v: ProviderInvocation =
            serde_json::from_str(r#"{"provider":"foo","properties":{"a":"b"}}"#).unwrap();
        match v {
            ProviderInvocation::ByName(b) => {
                let props = b.properties.unwrap();
                assert_eq!(
                    props.get("a"),
                    Some(&TemplateValue::String("b".into()))
                );
            }
            _ => panic!("expected ByName"),
        }
    }

    #[test]
    fn by_name_with_template_property() {
        let v: ProviderInvocation = serde_json::from_str(
            r#"{"provider":"foo","properties":{"page_size":"${capture[1]}"}}"#,
        )
        .unwrap();
        if let ProviderInvocation::ByName(b) = v {
            let props = b.properties.unwrap();
            assert_eq!(
                props.get("page_size"),
                Some(&TemplateValue::String("${capture[1]}".into()))
            );
        } else {
            panic!("expected ByName");
        }
    }
}
