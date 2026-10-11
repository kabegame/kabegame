use serde::{Deserialize, Serialize};

use super::expr::SqlExpr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderGlobalOp {
    Revert,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderItem {
    pub sql: SqlExpr,
    #[serde(default)]
    pub prepend: bool,
    pub order: OrderDirection,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderGlobal {
    pub all: OrderGlobalOp,
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
    fn array_item_defaults_prepend() {
        let v: OrderForm =
            serde_json::from_str(r#"[{"sql":"created_at","order":"desc"}]"#).unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].sql, SqlExpr("created_at".into()));
                assert_eq!(items[0].order, OrderDirection::Desc);
                assert!(!items[0].prepend);
            }
            _ => panic!("expected Array"),
        }
    }

    #[test]
    fn array_item_accepts_prepend() {
        let v: OrderForm =
            serde_json::from_str(r#"[{"sql":"ai.\"order\"","order":"asc","prepend":true}]"#)
                .unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items[0].sql, SqlExpr("ai.\"order\"".into()));
                assert_eq!(items[0].order, OrderDirection::Asc);
                assert!(items[0].prepend);
            }
            _ => panic!("expected Array"),
        }
    }

    #[test]
    fn global_form() {
        let v: OrderForm = serde_json::from_str(r#"{"all":"revert"}"#).unwrap();
        match v {
            OrderForm::Global(g) => assert_eq!(g.all, OrderGlobalOp::Revert),
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
    fn item_revert_and_clear_are_rejected() {
        let revert: Result<OrderForm, _> =
            serde_json::from_str(r#"[{"sql":"a","order":"revert"}]"#);
        let clear: Result<OrderForm, _> =
            serde_json::from_str(r#"[{"sql":"a","order":"asc","clear":"all"}]"#);
        assert!(revert.is_err());
        assert!(clear.is_err());
    }

    #[test]
    fn global_clear_is_accepted_but_directions_are_rejected() {
        let clear: OrderForm = serde_json::from_str(r#"{"all":"clear"}"#).unwrap();
        assert!(matches!(
            clear,
            OrderForm::Global(OrderGlobal {
                all: OrderGlobalOp::Clear
            })
        ));
        for direction in ["asc", "desc"] {
            let value = format!(r#"{{"all":"{direction}"}}"#);
            assert!(serde_json::from_str::<OrderForm>(&value).is_err());
        }
    }

    #[test]
    fn round_trip_preserves_struct_items() {
        let v: OrderForm = serde_json::from_str(
            r#"[{"sql":"a","order":"asc"},{"sql":"b","order":"desc","prepend":true}]"#,
        )
        .unwrap();
        let j = serde_json::to_string(&v).unwrap();
        let back: OrderForm = serde_json::from_str(&j).unwrap();
        assert_eq!(v, back);
    }
}
