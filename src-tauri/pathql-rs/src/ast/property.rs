use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct PropertyDecl {
    #[serde(default)]
    pub optional: Option<bool>,
    #[serde(flatten)]
    pub spec: PropertySpec,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropertySpec {
    Number {
        #[serde(default)]
        default: Option<f64>,
        #[serde(default)]
        min: Option<f64>,
        #[serde(default)]
        max: Option<f64>,
    },
    String {
        #[serde(default)]
        default: Option<String>,
        #[serde(default)]
        pattern: Option<String>,
    },
    Boolean {
        #[serde(default)]
        default: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TemplateValue {
    String(String),
    Number(f64),
    Boolean(bool),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn property_decl_number_full() {
        let v: PropertyDecl =
            serde_json::from_str(r#"{"type":"number","default":1,"optional":false}"#).unwrap();
        assert_eq!(v.optional, Some(false));
        match v.spec {
            PropertySpec::Number { default, min, max } => {
                assert_eq!(default, Some(1.0));
                assert_eq!(min, None);
                assert_eq!(max, None);
            }
            _ => panic!("expected Number variant"),
        }
    }

    #[test]
    fn property_decl_string_pattern() {
        let v: PropertyDecl =
            serde_json::from_str(r#"{"type":"string","pattern":"^foo"}"#).unwrap();
        assert_eq!(v.optional, None);
        match v.spec {
            PropertySpec::String { default, pattern } => {
                assert_eq!(default, None);
                assert_eq!(pattern, Some("^foo".to_string()));
            }
            _ => panic!("expected String variant"),
        }
    }

    #[test]
    fn property_decl_boolean() {
        let v: PropertyDecl = serde_json::from_str(r#"{"type":"boolean","default":true}"#).unwrap();
        match v.spec {
            PropertySpec::Boolean { default } => assert_eq!(default, Some(true)),
            _ => panic!("expected Boolean variant"),
        }
    }

    #[test]
    fn property_decl_unknown_variant_rejected() {
        let r: Result<PropertyDecl, _> = serde_json::from_str(r#"{"type":"datetime"}"#);
        assert!(r.is_err());
    }

    #[test]
    fn property_decl_missing_type_rejected() {
        let r: Result<PropertyDecl, _> = serde_json::from_str(r#"{"optional":true}"#);
        assert!(r.is_err());
    }

    #[test]
    fn property_decl_roundtrip() {
        let v: PropertyDecl =
            serde_json::from_str(r#"{"type":"number","default":1,"optional":false}"#).unwrap();
        let j = serde_json::to_string(&v).unwrap();
        let back: PropertyDecl = serde_json::from_str(&j).unwrap();
        assert_eq!(v, back);
    }

    #[test]
    fn template_value_string() {
        let v: TemplateValue = serde_json::from_str(r#""hello""#).unwrap();
        assert_eq!(v, TemplateValue::String("hello".to_string()));
    }

    #[test]
    fn template_value_number() {
        let v: TemplateValue = serde_json::from_str("42").unwrap();
        assert_eq!(v, TemplateValue::Number(42.0));
    }

    #[test]
    fn template_value_boolean() {
        let v: TemplateValue = serde_json::from_str("true").unwrap();
        assert_eq!(v, TemplateValue::Boolean(true));
    }
}
