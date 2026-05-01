use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct TemplateExpr(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SqlExpr(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PathExpr(pub String);

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum NumberOrTemplate {
    Number(f64),
    Template(TemplateExpr),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_or_template_number() {
        let v: NumberOrTemplate = serde_json::from_str("1").unwrap();
        assert_eq!(v, NumberOrTemplate::Number(1.0));
    }

    #[test]
    fn number_or_template_float() {
        let v: NumberOrTemplate = serde_json::from_str("3.5").unwrap();
        assert_eq!(v, NumberOrTemplate::Number(3.5));
    }

    #[test]
    fn number_or_template_template() {
        let v: NumberOrTemplate = serde_json::from_str("\"${properties.x}\"").unwrap();
        assert_eq!(
            v,
            NumberOrTemplate::Template(TemplateExpr("${properties.x}".to_string()))
        );
    }

    #[test]
    fn template_expr_string() {
        let v: TemplateExpr = serde_json::from_str("\"foo${bar}\"").unwrap();
        assert_eq!(v, TemplateExpr("foo${bar}".to_string()));
    }

    #[test]
    fn sql_expr_string() {
        let v: SqlExpr = serde_json::from_str("\"SELECT 1\"").unwrap();
        assert_eq!(v, SqlExpr("SELECT 1".to_string()));
    }

    #[test]
    fn path_expr_string() {
        let v: PathExpr = serde_json::from_str("\"./foo\"").unwrap();
        assert_eq!(v, PathExpr("./foo".to_string()));
    }

    #[test]
    fn number_or_template_roundtrip_template() {
        let v = NumberOrTemplate::Template(TemplateExpr("${a}".into()));
        let j = serde_json::to_string(&v).unwrap();
        let back: NumberOrTemplate = serde_json::from_str(&j).unwrap();
        assert_eq!(back, v);
    }
}
