use serde::{Deserialize, Serialize};

use super::expr::SqlExpr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderDirection {
    Asc,
    Desc,
    Revert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClearMode {
    All,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderItem {
    pub sql: SqlExpr,
    #[serde(default)]
    pub prepend: bool,
    pub order: OrderDirection,
    #[serde(default)]
    pub clear: Option<ClearMode>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderGlobal {
    pub all: OrderDirection,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum OrderForm {
    Array(Vec<OrderItem>),
    Global(OrderGlobal),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_item_defaults_prepend_and_clear() {
        let v: OrderForm =
            serde_json::from_str(r#"[{"sql":"created_at","order":"desc"}]"#).unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].sql, SqlExpr("created_at".into()));
                assert_eq!(items[0].order, OrderDirection::Desc);
                assert!(!items[0].prepend);
                assert_eq!(items[0].clear, None);
            }
            _ => panic!("expected Array"),
        }
    }

    #[test]
    fn array_item_accepts_prepend_and_clear_all() {
        let v: OrderForm = serde_json::from_str(
            r#"[{"sql":"ai.\"order\"","order":"asc","prepend":true,"clear":"all"}]"#,
        )
        .unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items[0].sql, SqlExpr("ai.\"order\"".into()));
                assert_eq!(items[0].order, OrderDirection::Asc);
                assert!(items[0].prepend);
                assert_eq!(items[0].clear, Some(ClearMode::All));
            }
            _ => panic!("expected Array"),
        }
    }

    #[test]
    fn global_form() {
        let v: OrderForm = serde_json::from_str(r#"{"all":"revert"}"#).unwrap();
        match v {
            OrderForm::Global(g) => assert_eq!(g.all, OrderDirection::Revert),
            _ => panic!("expected Global"),
        }
    }

    #[test]
    fn unknown_field_rejected() {
        let r: Result<OrderForm, _> =
            serde_json::from_str(r#"[{"sql":"a","order":"asc","extra":1}]"#);
        assert!(r.is_err());
    }

    #[test]
    fn missing_order_rejected() {
        let r: Result<OrderForm, _> = serde_json::from_str(r#"[{"sql":"a"}]"#);
        assert!(r.is_err());
    }

    #[test]
    fn unknown_direction_rejected() {
        let r: Result<OrderForm, _> = serde_json::from_str(r#"[{"sql":"a","order":"random"}]"#);
        assert!(r.is_err());
    }

    #[test]
    fn round_trip_preserves_struct_items() {
        let v: OrderForm = serde_json::from_str(
            r#"[{"sql":"a","order":"asc"},{"sql":"b","order":"revert","prepend":true}]"#,
        )
        .unwrap();
        let j = serde_json::to_string(&v).unwrap();
        let back: OrderForm = serde_json::from_str(&j).unwrap();
        assert_eq!(v, back);
    }
}
