use crate::ast::{names::*, property::TemplateValue, MetaValue};
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

/// 7b: 恢复 ByDelegate variant — payload 是 ProviderCall (path-unaware)。
/// 仅在 `Resolve` 表项里有意义: `target.resolve(name, ...)` 转发对当前 segment 的
/// resolve 决定权给 target. 静态 list 项不允许 (运行期拒绝)。
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByDelegate {
    pub delegate: ProviderCall,
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

/// 6e: 引用另一个 provider, 同 namespace 链解析; 不含 meta 字段 (delegate 目标自身无 meta 概念)。
/// 用于 `Query::Delegate.delegate` 与 `DynamicDelegateEntry.delegate`。
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCall {
    pub provider: ProviderName,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
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

    #[test]
    fn delegate_string_payload_rejected() {
        // 6e/7b: 旧 PathExpr 形态 `{"delegate":"./bar"}` 被拒 (delegate 必须是 ProviderCall 对象)
        let r: Result<ProviderInvocation, _> =
            serde_json::from_str(r#"{"delegate":"./bar"}"#);
        assert!(r.is_err());
    }

    #[test]
    fn by_delegate_provider_call_payload() {
        // 7b: ByDelegate 复活, payload = ProviderCall {provider, properties?}
        let v: ProviderInvocation =
            serde_json::from_str(r#"{"delegate":{"provider":"foo"}}"#).unwrap();
        match v {
            ProviderInvocation::ByDelegate(b) => {
                assert_eq!(b.delegate.provider, ProviderName("foo".into()));
                assert!(b.delegate.properties.is_none());
                assert!(b.meta.is_none());
            }
            _ => panic!("expected ByDelegate"),
        }
    }

    #[test]
    fn by_delegate_with_properties_and_meta() {
        let v: ProviderInvocation = serde_json::from_str(
            r#"{"delegate":{"provider":"foo","properties":{"k":"v"}},"meta":{"hint":"x"}}"#,
        )
        .unwrap();
        match v {
            ProviderInvocation::ByDelegate(b) => {
                assert_eq!(b.delegate.provider, ProviderName("foo".into()));
                assert!(b.delegate.properties.is_some());
                assert!(b.meta.is_some());
            }
            _ => panic!("expected ByDelegate"),
        }
    }

    #[test]
    fn by_name_and_by_delegate_disambiguated() {
        // {provider:"X"} → ByName
        let v: ProviderInvocation = serde_json::from_str(r#"{"provider":"X"}"#).unwrap();
        assert!(matches!(v, ProviderInvocation::ByName(_)));
        // {delegate:{provider:"X"}} → ByDelegate
        let v: ProviderInvocation =
            serde_json::from_str(r#"{"delegate":{"provider":"X"}}"#).unwrap();
        assert!(matches!(v, ProviderInvocation::ByDelegate(_)));
    }

    #[test]
    fn provider_and_delegate_mutually_exclusive() {
        // {provider:..., delegate:...} 两个都给 → 不属于任何 variant (deny_unknown_fields)
        let r: Result<ProviderInvocation, _> = serde_json::from_str(
            r#"{"provider":"foo","delegate":{"provider":"bar"}}"#,
        );
        assert!(r.is_err());
    }

    #[test]
    fn provider_call_simple() {
        let v: ProviderCall = serde_json::from_str(r#"{"provider":"foo"}"#).unwrap();
        assert_eq!(v.provider, ProviderName("foo".into()));
        assert!(v.properties.is_none());
    }

    #[test]
    fn provider_call_with_properties() {
        let v: ProviderCall = serde_json::from_str(
            r#"{"provider":"foo","properties":{"page_size":100}}"#,
        )
        .unwrap();
        assert_eq!(v.provider, ProviderName("foo".into()));
        let p = v.properties.unwrap();
        assert!(p.contains_key("page_size"));
    }

    #[test]
    fn provider_call_rejects_meta() {
        // ProviderCall has no `meta` field — additionalProperties: false
        let r: Result<ProviderCall, _> =
            serde_json::from_str(r#"{"provider":"foo","meta":{"k":"v"}}"#);
        assert!(r.is_err());
    }

    #[test]
    fn provider_call_rejects_missing_provider() {
        let r: Result<ProviderCall, _> = serde_json::from_str(r#"{}"#);
        assert!(r.is_err());
    }
}
