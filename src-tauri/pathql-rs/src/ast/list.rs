use crate::ast::{
    expr::*,
    invocation::{ProviderCall, ProviderInvocation},
    names::*,
    property::TemplateValue,
    MetaValue,
};
use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer, Serialize, Serializer,
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

#[derive(Debug, Clone, PartialEq)]
pub enum DelegateProviderField {
    /// `${child_var.provider}` 字面值。
    ChildRef(String),
    Name(ProviderName),
}

impl<'de> Deserialize<'de> for DelegateProviderField {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        if is_child_provider_ref(&s) {
            Ok(Self::ChildRef(s))
        } else {
            Ok(Self::Name(ProviderName(s)))
        }
    }
}

impl Serialize for DelegateProviderField {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ChildRef(s) => serializer.serialize_str(s),
            Self::Name(name) => serializer.serialize_str(&name.0),
        }
    }
}

fn is_child_provider_ref(s: &str) -> bool {
    let Some(inner) = s.strip_prefix("${").and_then(|s| s.strip_suffix('}')) else {
        return false;
    };
    let Some((ident, field)) = inner.split_once('.') else {
        return false;
    };
    field == "provider"
        && !ident.is_empty()
        && ident
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_lowercase() || (i > 0 && c.is_ascii_digit()))
        && !ident.chars().next().is_some_and(|c| c.is_ascii_digit())
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
                    let entry = if key_uses_dynamic_var(&key) {
                        ListEntry::Dynamic(serde_json::from_value(value).map_err(|e| {
                            de::Error::custom(format!("dynamic entry `{}`: {}", key, e))
                        })?)
                    } else {
                        // Static 或 InstanceStatic (含 ${properties.X}); 二者 value 类型相同
                        // (ProviderInvocation), DslProvider list/resolve 期再做 key 模板渲染。
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

/// 判断 list key 是否需要 per-row / per-child 动态渲染。
///
/// **返回 true (Dynamic, 走 ListEntry::Dynamic)** 仅当 key 中包含至少一个
/// 非保留 namespace 的路径变量 (`${X.Y}` 且 X 既不是 `properties` 也不是 `capture`)。
/// 这样的 key 形态约束 X 必须等于 SQL 行 data_var 或 delegate child_var 之一。
///
/// **返回 false (Static / InstanceStatic, 走 ListEntry::Static)** 当 key 是:
/// - 纯字面量 (无 `${...}`)
/// - 仅含 `${X}` (无点号; 当字面字符串处理)
/// - 仅含 `${properties.X}` / `${capture[N]}` 等 instance-static 引用
///
/// 后者称为 "instance-static" — DSL 加载期 key 字面值未定 (取决于实例化时的
/// properties), 但与 dynamic per-row 模式语义不同, 仍走静态 ListEntry::Static
/// (value 是 ProviderInvocation), 实际 key 字面在 DslProvider list/resolve
/// 调用时按 self.properties 渲染。
pub(crate) fn key_uses_dynamic_var(key: &str) -> bool {
    use crate::template::{parse, Segment, VarRef};
    let Ok(ast) = parse(key) else {
        return false;
    };
    for seg in ast.segments {
        if let Segment::Var(v) = seg {
            let ns_opt = match &v {
                VarRef::Bare { ns } => Some(ns.as_str()),
                VarRef::Path { ns, .. } => Some(ns.as_str()),
                VarRef::Index { ns, .. } => Some(ns.as_str()),
                VarRef::Method { .. } => None,
            };
            if let Some(ns) = ns_opt {
                // 非保留 ns + 含路径段 → dynamic
                let is_reserved = matches!(ns, "properties" | "capture" | "composed" | "_");
                let has_path = matches!(&v, VarRef::Path { path, .. } if !path.is_empty());
                if !is_reserved && has_path {
                    return true;
                }
            }
        }
    }
    false
}

/// 旧名兼容 alias (内部模块仍可能引用).
#[allow(dead_code)]
pub(crate) fn key_is_dynamic(key: &str) -> bool {
    key_uses_dynamic_var(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_uses_dynamic_var_cases() {
        // 静态字面
        assert!(!key_uses_dynamic_var("a"));
        assert!(!key_uses_dynamic_var("plain text"));
        assert!(!key_uses_dynamic_var("${x}")); // 无路径段, 当字面
        assert!(!key_uses_dynamic_var("${a}-${b}"));

        // 7b: instance-static (${properties.X}) 不算 dynamic
        assert!(!key_uses_dynamic_var("${properties.lang}"));
        assert!(!key_uses_dynamic_var("prefix-${properties.x}-suffix"));
        assert!(!key_uses_dynamic_var("${properties.a}-${properties.b}"));
        assert!(!key_uses_dynamic_var("${capture[1]}_x"));

        // dynamic (data_var / child_var)
        assert!(key_uses_dynamic_var("${x.y}"));
        assert!(key_uses_dynamic_var("prefix-${x.y}-suffix"));
        assert!(key_uses_dynamic_var("${a.b}-${c.d}"));
        assert!(key_uses_dynamic_var("${row.id}"));
        assert!(key_uses_dynamic_var("${child.meta.foo}"));

        // 混: properties + data_var → 仍 dynamic (因含 data_var)
        assert!(key_uses_dynamic_var("${properties.x}-${row.id}"));
    }

    #[test]
    fn instance_static_key_routes_to_static_entry() {
        // ${properties.X} 形态 key 仍归 ListEntry::Static (value=ProviderInvocation)
        let v: List =
            serde_json::from_str(r#"{"${properties.lang}":{"provider":"target"}}"#).unwrap();
        assert_eq!(v.entries.len(), 1);
        match &v.entries[0].1 {
            ListEntry::Static(ProviderInvocation::ByName(b)) => {
                assert_eq!(b.provider, ProviderName("target".into()));
            }
            _ => panic!("expected ListEntry::Static (instance-static keys go through Static)"),
        }
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
        let v: List =
            serde_json::from_str(r#"{"${row.id}":{"sql":"select 1","data_var":"row"}}"#).unwrap();
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
        let r: Result<List, _> = serde_json::from_str(r#"{"${row.id}":{"sql":"select 1"}}"#);
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
                assert!(matches!(e.provider, Some(DelegateProviderField::Name(_))));
                assert_eq!(
                    e.delegate.provider,
                    ProviderName("page_size_provider".into())
                );
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
