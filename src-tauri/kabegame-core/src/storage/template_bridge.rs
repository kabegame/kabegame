//! TemplateValue → rusqlite::Value 桥接 (6d 起 core 私有, pathql-rs 已删此功能)。
//!
//! Storage 层把 pathql-rs build_sql 产出的 `Vec<TemplateValue>` 喂给 rusqlite
//! 的 `params_from_iter`; 这里只做 1-to-1 类型映射, 无 driver 状态。
//!
//! 仅 `pub(crate)`: 仅供 storage 与 providers::sql_executor 内部使用, 不对外暴露。

use pathql_rs::template::eval::TemplateValue;
use rusqlite::types::Value;

pub(crate) fn template_to_rusqlite(v: &TemplateValue) -> Value {
    match v {
        TemplateValue::Null => Value::Null,
        TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        TemplateValue::Int(i) => Value::Integer(*i),
        TemplateValue::Real(r) => Value::Real(*r),
        TemplateValue::Text(s) => Value::Text(s.clone()),
        TemplateValue::Json(v) => Value::Text(v.to_string()),
    }
}

pub(crate) fn template_params_for(values: &[TemplateValue]) -> Vec<Value> {
    values.iter().map(template_to_rusqlite).collect()
}
