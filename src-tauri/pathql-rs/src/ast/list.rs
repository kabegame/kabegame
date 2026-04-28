use crate::ast::{
    expr::*, invocation::{ProviderCall, ProviderInvocation}, names::*, property::TemplateValue,
    MetaValue,
};
use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicSqlEntry {
    pub sql: SqlExpr,
    pub data_var: Identifier,
    #[serde(default)]
    pub provider: Option<ProviderName>,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DelegateProviderField {
    /// `${child_var.provider}` 字面值——Phase 1 不解析含义
    ChildRef(String),
    Name(ProviderName),
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicDelegateEntry {
    /// 6e: 数据源 provider 引用 (ProviderCall); 实例化后调它的 list_children 拿 children 序列。
    pub delegate: ProviderCall,
    pub child_var: Identifier,
    #[serde(default)]
    pub provider: Option<DelegateProviderField>,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DynamicListEntry {
    Sql(DynamicSqlEntry),
    Delegate(DynamicDelegateEntry),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ListEntry {
    Static(ProviderInvocation),
    Dynamic(DynamicListEntry),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct List {
    pub entries: Vec<(String, ListEntry)>,
}

impl<'de> Deserialize<'de> for List {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = List;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a List object with static or dynamic entries")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<List, M::Error> {
                let mut entries = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    let value: serde_json::Value = map.next_value()?;
                    let entry = if key_is_dynamic(&key) {
                        ListEntry::Dynamic(serde_json::from_value(value).map_err(|e| {
                            de::Error::custom(format!("dynamic entry `{}`: {}", key, e))
                        })?)
                    } else {
                        ListEntry::Static(serde_json::from_value(value).map_err(|e| {
                            de::Error::custom(format!("static entry `{}`: {}", key, e))
                        })?)
                    };
                    entries.push((key, entry));
                }
                Ok(List { entries })
            }
        }
        de.deserialize_map(V)
    }
}

impl Serialize for List {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = ser.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            match v {
                ListEntry::Static(s) => m.serialize_entry(k, s)?,
                ListEntry::Dynamic(d) => m.serialize_entry(k, d)?,
            }
        }
        m.end()
    }
}

/// key 含 `${<ident>.<field>...}` → dynamic
pub(crate) fn key_is_dynamic(key: &str) -> bool {
    let bytes = key.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(end) = key[i + 2..].find('}') {
                let inner = &key[i + 2..i + 2 + end];
                if inner.contains('.') {
                    return true;
                }
                i += 2 + end + 1;
                continue;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_dynamic_cases() {
        assert!(!key_is_dynamic("a"));
        assert!(!key_is_dynamic("${x}"));
        assert!(key_is_dynamic("${x.y}"));
        assert!(key_is_dynamic("prefix-${x.y}-suffix"));
        assert!(key_is_dynamic("${a.b}-${c.d}"));
        assert!(!key_is_dynamic("${a}-${b}"));
        assert!(!key_is_dynamic("plain text"));
    }

    #[test]
    fn two_static_entries() {
        // 6e: 静态项均为 ByName / Empty (ByDelegate variant 已删除)
        let v: List =
            serde_json::from_str(r#"{"a":{"provider":"x"},"b":{"provider":"y"}}"#).unwrap();
        assert_eq!(v.entries.len(), 2);
        assert!(matches!(v.entries[0].1, ListEntry::Static(_)));
        assert!(matches!(v.entries[1].1, ListEntry::Static(_)));
    }

    #[test]
    fn dynamic_sql_entry() {
        let v: List = serde_json::from_str(
            r#"{"${row.id}":{"sql":"select 1","data_var":"row"}}"#,
        )
        .unwrap();
        assert_eq!(v.entries.len(), 1);
        match &v.entries[0].1 {
            ListEntry::Dynamic(DynamicListEntry::Sql(e)) => {
                assert_eq!(e.sql, SqlExpr("select 1".into()));
                assert_eq!(e.data_var, Identifier("row".into()));
            }
            _ => panic!("expected Dynamic Sql"),
        }
    }

    #[test]
    fn dynamic_delegate_entry() {
        let v: List = serde_json::from_str(
            r#"{"${out.name}":{"delegate":{"provider":"z"},"child_var":"out"}}"#,
        )
        .unwrap();
        assert_eq!(v.entries.len(), 1);
        match &v.entries[0].1 {
            ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                assert_eq!(e.delegate.provider, ProviderName("z".into()));
                assert_eq!(e.child_var, Identifier("out".into()));
            }
            _ => panic!("expected Dynamic Delegate"),
        }
    }

    #[test]
    fn mixed_static_and_dynamic_preserves_order() {
        let v: List = serde_json::from_str(
            r#"{
                "a": { "provider": "x" },
                "${row.id}": { "sql": "s1", "data_var": "row" },
                "b": { "provider": "y" },
                "${out.name}": { "delegate": {"provider":"z"}, "child_var": "out" },
                "c": {}
            }"#,
        )
        .unwrap();
        assert_eq!(v.entries.len(), 5);
        assert_eq!(v.entries[0].0, "a");
        assert_eq!(v.entries[1].0, "${row.id}");
        assert_eq!(v.entries[2].0, "b");
        assert_eq!(v.entries[3].0, "${out.name}");
        assert_eq!(v.entries[4].0, "c");
        assert!(matches!(v.entries[0].1, ListEntry::Static(_)));
        assert!(matches!(v.entries[1].1, ListEntry::Dynamic(_)));
        assert!(matches!(v.entries[2].1, ListEntry::Static(_)));
        assert!(matches!(v.entries[3].1, ListEntry::Dynamic(_)));
        assert!(matches!(v.entries[4].1, ListEntry::Static(_)));
    }

    #[test]
    fn error_message_contains_key_name() {
        // Dynamic entry with bad payload (missing data_var)
        let r: Result<List, _> = serde_json::from_str(
            r#"{"${row.id}":{"sql":"select 1"}}"#,
        );
        let err = r.expect_err("should fail");
        let msg = err.to_string();
        assert!(
            msg.contains("${row.id}"),
            "error message should contain key, got: {}",
            msg
        );
    }

    #[test]
    fn dynamic_with_provider_child_ref() {
        let v: List = serde_json::from_str(
            r#"{"${out.meta.page_num}":{"delegate":{"provider":"page_size_provider"},"child_var":"out","provider":"gallery_page_router"}}"#,
        )
        .unwrap();
        assert_eq!(v.entries.len(), 1);
        match &v.entries[0].1 {
            ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                assert!(e.provider.is_some());
                assert_eq!(e.delegate.provider, ProviderName("page_size_provider".into()));
            }
            _ => panic!("expected Dynamic Delegate"),
        }
    }

    #[test]
    fn round_trip_static_dynamic_mix() {
        let raw = r#"{"a":{"provider":"x"},"${row.id}":{"sql":"select 1","data_var":"row"}}"#;
        let v: List = serde_json::from_str(raw).unwrap();
        let j = serde_json::to_string(&v).unwrap();
        let back: List = serde_json::from_str(&j).unwrap();
        assert_eq!(v, back);
    }
}
