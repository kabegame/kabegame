use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderDirection {
    Asc,
    Desc,
    Revert,
}

/// 单个数组项；多键场景按声明顺序保留 (field, direction) 对。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OrderArrayItem(pub Vec<(String, OrderDirection)>);

impl<'de> Deserialize<'de> for OrderArrayItem {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderArrayItem;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an OrderArrayItem object {<field>: 'asc'|'desc'|'revert', ...}")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<OrderArrayItem, M::Error> {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, OrderDirection>()? {
                    entries.push((k, v));
                }
                if entries.is_empty() {
                    return Err(de::Error::custom(
                        "OrderArrayItem must contain at least one field",
                    ));
                }
                Ok(OrderArrayItem(entries))
            }
        }
        de.deserialize_map(V)
    }
}

impl Serialize for OrderArrayItem {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = ser.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderGlobal {
    pub all: OrderDirection,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum OrderForm {
    Array(Vec<OrderArrayItem>),
    Global(OrderGlobal),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_single_key() {
        let v: OrderForm =
            serde_json::from_str(r#"[{"created_at":"desc"},{"title":"asc"}]"#).unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].0.len(), 1);
                assert_eq!(items[0].0[0].0, "created_at");
                assert_eq!(items[0].0[0].1, OrderDirection::Desc);
                assert_eq!(items[1].0[0].0, "title");
                assert_eq!(items[1].0[0].1, OrderDirection::Asc);
            }
            _ => panic!("expected Array"),
        }
    }

    #[test]
    fn array_multi_key_preserves_order() {
        let v: OrderForm = serde_json::from_str(r#"[{"a":"asc","b":"desc"}]"#).unwrap();
        match v {
            OrderForm::Array(items) => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].0.len(), 2);
                assert_eq!(items[0].0[0].0, "a");
                assert_eq!(items[0].0[0].1, OrderDirection::Asc);
                assert_eq!(items[0].0[1].0, "b");
                assert_eq!(items[0].0[1].1, OrderDirection::Desc);
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
    fn empty_object_in_array_rejected() {
        let r: Result<OrderForm, _> = serde_json::from_str(r#"[{}]"#);
        assert!(r.is_err());
    }

    #[test]
    fn unknown_direction_rejected() {
        let r: Result<OrderForm, _> = serde_json::from_str(r#"[{"a":"random"}]"#);
        assert!(r.is_err());
    }

    #[test]
    fn multi_key_round_trip_preserves_order() {
        let v: OrderForm =
            serde_json::from_str(r#"[{"a":"asc","b":"desc","c":"revert"}]"#).unwrap();
        let j = serde_json::to_string(&v).unwrap();
        let back: OrderForm = serde_json::from_str(&j).unwrap();
        assert_eq!(v, back);
        match back {
            OrderForm::Array(items) => {
                assert_eq!(items[0].0[0].0, "a");
                assert_eq!(items[0].0[1].0, "b");
                assert_eq!(items[0].0[2].0, "c");
            }
            _ => panic!("expected Array"),
        }
    }
}
