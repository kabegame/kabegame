//! SQLite (rusqlite) 驱动适配器。
//!
//! 把 dialect-agnostic 的 `Vec<TemplateValue>` 桥接到 `Vec<rusqlite::types::Value>`,
//! 让消费者能直接喂给 `stmt.execute(rusqlite::params_from_iter(...))`。

use crate::template::eval::TemplateValue;
use rusqlite::types::Value;

/// 单值转换。
pub fn to_rusqlite(v: &TemplateValue) -> Value {
    match v {
        TemplateValue::Null => Value::Null,
        TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        TemplateValue::Int(i) => Value::Integer(*i),
        TemplateValue::Real(r) => Value::Real(*r),
        TemplateValue::Text(s) => Value::Text(s.clone()),
        TemplateValue::Json(v) => Value::Text(v.to_string()),
    }
}

/// 批量转换便利函数。
pub fn params_for(values: &[TemplateValue]) -> Vec<Value> {
    values.iter().map(to_rusqlite).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_to_null() {
        assert!(matches!(to_rusqlite(&TemplateValue::Null), Value::Null));
    }

    #[test]
    fn bool_true_to_int_1() {
        assert!(matches!(
            to_rusqlite(&TemplateValue::Bool(true)),
            Value::Integer(1)
        ));
    }

    #[test]
    fn bool_false_to_int_0() {
        assert!(matches!(
            to_rusqlite(&TemplateValue::Bool(false)),
            Value::Integer(0)
        ));
    }

    #[test]
    fn int_to_integer() {
        assert!(matches!(
            to_rusqlite(&TemplateValue::Int(42)),
            Value::Integer(42)
        ));
    }

    #[test]
    fn real_to_real() {
        match to_rusqlite(&TemplateValue::Real(3.14)) {
            Value::Real(r) => assert!((r - 3.14).abs() < f64::EPSILON),
            other => panic!("expected Real, got {:?}", other),
        }
    }

    #[test]
    fn text_to_text() {
        match to_rusqlite(&TemplateValue::Text("hello".into())) {
            Value::Text(s) => assert_eq!(s, "hello"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn json_to_text_serialized() {
        match to_rusqlite(&TemplateValue::Json(json!({"k":"v"}))) {
            Value::Text(s) => assert_eq!(s, "{\"k\":\"v\"}"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn json_array_serialized() {
        match to_rusqlite(&TemplateValue::Json(json!([1, 2, 3]))) {
            Value::Text(s) => assert_eq!(s, "[1,2,3]"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn params_for_batch_preserves_order() {
        let inputs = vec![
            TemplateValue::Int(1),
            TemplateValue::Text("a".into()),
            TemplateValue::Bool(true),
        ];
        let out = params_for(&inputs);
        assert_eq!(out.len(), 3);
        assert!(matches!(out[0], Value::Integer(1)));
        assert!(matches!(out[1], Value::Text(ref s) if s == "a"));
        assert!(matches!(out[2], Value::Integer(1)));
    }

    #[test]
    fn params_for_empty() {
        let out = params_for(&[]);
        assert!(out.is_empty());
    }
}
