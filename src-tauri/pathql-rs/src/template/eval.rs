//! 模板求值器: 给定 TemplateAst 与 TemplateContext, 求值各 VarRef → TemplateValue。
//!
//! 不处理 inline-replace 形态 (`${ref:X}` / `${composed}`); 那些在
//! [`crate::compose::render`] 直接走字符串替换路径。

use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

use crate::template::parse::VarRef;

/// bind 参数的中性表达, dialect-agnostic。
///
/// pathql-rs 只产生它; 具体 DB 驱动转换由消费者自管 (6d 起 pathql-rs 不附驱动桥)。
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateValue {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Text(String),
    /// 嵌套 JSON 对象 / 数组 (来自 data_var 取整行 / child_var.meta 取整对象)。
    /// 大多数适配器把它序列化为字符串。
    Json(JsonValue),
}

impl TemplateValue {
    /// JSON value → TemplateValue (data_var/child_var 取列时用)。
    pub fn from_json(v: &JsonValue) -> Self {
        match v {
            JsonValue::Null => Self::Null,
            JsonValue::Bool(b) => Self::Bool(*b),
            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Self::Int(i)
                } else if let Some(f) = n.as_f64() {
                    Self::Real(f)
                } else {
                    Self::Null
                }
            }
            JsonValue::String(s) => Self::Text(s.clone()),
            other => Self::Json(other.clone()),
        }
    }
}

/// 渲染期上下文。每次 render 调用现造一个; builder 设置子集。
/// TODO: 以后做成可任意扩展型
#[derive(Debug, Default, Clone)]
pub struct TemplateContext {
    /// `${properties.<name>}` → TemplateValue
    pub properties: HashMap<String, TemplateValue>,
    /// `${global.<name>}` → runtime-frozen host globals.
    /// Arc-shared: 渲染期上下文是 cheap-cloneable; globals 由 ProviderRuntime 在
    /// 启动期一次性写入并冻结, 所有 evaluator / TemplateContext 共享同一份不可变副本。
    pub globals: Arc<HashMap<String, TemplateValue>>,
    /// `${capture[N]}` → 字符串 (N 从 1 开始; 0 = 全匹配)
    pub capture: Vec<String>,
    /// `${<data_var>.<col>}`: data_var 名 → row JSON
    pub data_var: Option<(String, JsonValue)>,
    /// `${<child_var>.<field>}`: child_var 名 → ChildEntry JSON 表示
    pub child_var: Option<(String, JsonValue)>,
    /// `${composed}` → 上游已渲染的 (sql, params); 由 Phase 6 runtime 填入
    pub composed: Option<(String, Vec<TemplateValue>)>,
}

impl TemplateContext {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_properties(mut self, p: HashMap<String, TemplateValue>) -> Self {
        self.properties = p;
        self
    }
    pub fn with_globals(mut self, g: Arc<HashMap<String, TemplateValue>>) -> Self {
        self.globals = g;
        self
    }
    pub fn with_capture(mut self, c: Vec<String>) -> Self {
        self.capture = c;
        self
    }
    pub fn with_data_var(mut self, name: impl Into<String>, json: JsonValue) -> Self {
        self.data_var = Some((name.into(), json));
        self
    }
    pub fn with_child_var(mut self, name: impl Into<String>, json: JsonValue) -> Self {
        self.child_var = Some((name.into(), json));
        self
    }
    pub fn with_composed(mut self, sql: String, params: Vec<TemplateValue>) -> Self {
        self.composed = Some((sql, params));
        self
    }
}

#[derive(Debug, Error, Clone, PartialEq)]
pub enum EvalError {
    #[error("unknown namespace `{0}` in ${{...}}")]
    UnknownNamespace(String),
    #[error("namespace `{0}` access path empty (need .field or [N])")]
    BareNotAllowed(String),
    #[error("property `{0}` not bound in context")]
    UnboundProperty(String),
    #[error("global `{0}` not bound in context")]
    UnboundGlobal(String),
    #[error("capture[{0}] out of bounds (have {1} groups)")]
    CaptureOutOfBounds(usize, usize),
    #[error("path field `{0}` not found")]
    PathFieldMissing(String),
    #[error("method `${{{0}:...}}` / bare `${{composed}}` handled in render layer, not evaluator")]
    MethodNotForEvaluator(String),
}

/// 求值单个 VarRef → TemplateValue。
///
/// **不**处理 inline-replace 形态 (ref / composed); 那些由
/// [`crate::compose::render::render_template_sql`] 直接做字符串替换。
pub fn evaluate_var(var: &VarRef, ctx: &TemplateContext) -> Result<TemplateValue, EvalError> {
    match var {
        VarRef::Bare { ns } if ns == "composed" => {
            Err(EvalError::MethodNotForEvaluator("composed".into()))
        }
        VarRef::Bare { ns } => Err(EvalError::BareNotAllowed(ns.clone())),
        VarRef::Path { ns, path } if ns == "properties" => {
            let key = path.join(".");
            ctx.properties
                .get(&key)
                .cloned()
                .ok_or(EvalError::UnboundProperty(key))
        }
        VarRef::Path { ns, path } if ns == "global" => {
            let key = path.join(".");
            ctx.globals
                .get(&key)
                .cloned()
                .ok_or(EvalError::UnboundGlobal(key))
        }
        VarRef::Path { ns, path } => {
            if let Some((n, json)) = &ctx.data_var {
                if n == ns {
                    return resolve_path(json, path).map(|v| TemplateValue::from_json(&v));
                }
            }
            if let Some((n, json)) = &ctx.child_var {
                if n == ns {
                    return resolve_path(json, path).map(|v| TemplateValue::from_json(&v));
                }
            }
            Err(EvalError::UnknownNamespace(ns.clone()))
        }
        VarRef::Index { ns, index } => {
            if ns != "capture" {
                return Err(EvalError::UnknownNamespace(ns.clone()));
            }
            ctx.capture
                .get(*index)
                .map(|s| TemplateValue::Text(s.clone()))
                .ok_or(EvalError::CaptureOutOfBounds(*index, ctx.capture.len()))
        }
        VarRef::Method { name, .. } => Err(EvalError::MethodNotForEvaluator(name.clone())),
    }
}

fn resolve_path(start: &JsonValue, path: &[String]) -> Result<JsonValue, EvalError> {
    let mut cur = start.clone();
    for seg in path {
        cur = cur
            .get(seg)
            .cloned()
            .ok_or_else(|| EvalError::PathFieldMissing(seg.clone()))?;
    }
    Ok(cur)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::parse::parse;
    use serde_json::json;

    fn first_var(input: &str) -> VarRef {
        let ast = parse(input).unwrap();
        for seg in ast.segments {
            if let crate::template::Segment::Var(v) = seg {
                return v;
            }
        }
        panic!("no var in {}", input);
    }

    fn ctx_with_props(pairs: &[(&str, TemplateValue)]) -> TemplateContext {
        TemplateContext::new().with_properties(
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn properties_text() {
        let v = evaluate_var(
            &first_var("${properties.x}"),
            &ctx_with_props(&[("x", TemplateValue::Text("hello".into()))]),
        )
        .unwrap();
        assert_eq!(v, TemplateValue::Text("hello".into()));
    }

    #[test]
    fn properties_int() {
        let v = evaluate_var(
            &first_var("${properties.size}"),
            &ctx_with_props(&[("size", TemplateValue::Int(100))]),
        )
        .unwrap();
        assert_eq!(v, TemplateValue::Int(100));
    }

    #[test]
    fn properties_unbound() {
        let err = evaluate_var(
            &first_var("${properties.missing}"),
            &TemplateContext::default(),
        )
        .unwrap_err();
        assert_eq!(err, EvalError::UnboundProperty("missing".into()));
    }

    #[test]
    fn global_text() {
        let ctx = TemplateContext::new().with_globals(Arc::new(
            [(
                "favorite_album_id".to_string(),
                TemplateValue::Text("fav".into()),
            )]
            .into_iter()
            .collect(),
        ));
        let v = evaluate_var(&first_var("${global.favorite_album_id}"), &ctx).unwrap();
        assert_eq!(v, TemplateValue::Text("fav".into()));
    }

    #[test]
    fn global_unbound() {
        let err =
            evaluate_var(&first_var("${global.missing}"), &TemplateContext::default()).unwrap_err();
        assert_eq!(err, EvalError::UnboundGlobal("missing".into()));
    }

    #[test]
    fn global_does_not_fall_back_to_properties() {
        let ctx = ctx_with_props(&[("same", TemplateValue::Text("prop".into()))]);
        let err = evaluate_var(&first_var("${global.same}"), &ctx).unwrap_err();
        assert_eq!(err, EvalError::UnboundGlobal("same".into()));
    }

    #[test]
    fn capture_index() {
        let ctx = TemplateContext::new().with_capture(vec!["full".into(), "first".into()]);
        let v = evaluate_var(&first_var("${capture[1]}"), &ctx).unwrap();
        assert_eq!(v, TemplateValue::Text("first".into()));
    }

    #[test]
    fn capture_oob() {
        let ctx = TemplateContext::new().with_capture(vec!["a".into(), "b".into()]);
        let err = evaluate_var(&first_var("${capture[5]}"), &ctx).unwrap_err();
        assert_eq!(err, EvalError::CaptureOutOfBounds(5, 2));
    }

    #[test]
    fn data_var_col() {
        let ctx = TemplateContext::new().with_data_var("row", json!({"id": 42}));
        let v = evaluate_var(&first_var("${row.id}"), &ctx).unwrap();
        assert_eq!(v, TemplateValue::Int(42));
    }

    #[test]
    fn data_var_nested() {
        let ctx = TemplateContext::new().with_data_var("row", json!({"info":{"name":"x"}}));
        let v = evaluate_var(&first_var("${row.info.name}"), &ctx).unwrap();
        assert_eq!(v, TemplateValue::Text("x".into()));
    }

    #[test]
    fn child_var_meta() {
        let ctx = TemplateContext::new().with_child_var("plugin", json!({"meta":{"foo":"bar"}}));
        let v = evaluate_var(&first_var("${plugin.meta.foo}"), &ctx).unwrap();
        assert_eq!(v, TemplateValue::Text("bar".into()));
    }

    #[test]
    fn unknown_ns() {
        let err = evaluate_var(&first_var("${nope.x}"), &TemplateContext::default()).unwrap_err();
        assert_eq!(err, EvalError::UnknownNamespace("nope".into()));
    }

    #[test]
    fn composed_in_eval_returns_method_not_for_evaluator() {
        let err = evaluate_var(&first_var("${composed}"), &TemplateContext::default()).unwrap_err();
        assert_eq!(err, EvalError::MethodNotForEvaluator("composed".into()));
    }

    #[test]
    fn ref_in_eval_returns_method_not_for_evaluator() {
        let err =
            evaluate_var(&first_var("${ref:my_id}"), &TemplateContext::default()).unwrap_err();
        assert_eq!(err, EvalError::MethodNotForEvaluator("ref".into()));
    }

    #[test]
    fn from_json_int() {
        assert_eq!(TemplateValue::from_json(&json!(42)), TemplateValue::Int(42));
    }

    #[test]
    fn from_json_real() {
        assert_eq!(
            TemplateValue::from_json(&json!(3.14)),
            TemplateValue::Real(3.14)
        );
    }

    #[test]
    fn from_json_obj_keeps_json() {
        let v = TemplateValue::from_json(&json!({"k":"v"}));
        match v {
            TemplateValue::Json(j) => assert_eq!(j, json!({"k":"v"})),
            _ => panic!("expected Json variant"),
        }
    }

    #[test]
    fn from_json_array_keeps_json() {
        let v = TemplateValue::from_json(&json!([1, 2, 3]));
        assert!(matches!(v, TemplateValue::Json(_)));
    }

    #[test]
    fn from_json_string() {
        assert_eq!(
            TemplateValue::from_json(&json!("hello")),
            TemplateValue::Text("hello".into())
        );
    }

    #[test]
    fn from_json_null() {
        assert_eq!(TemplateValue::from_json(&json!(null)), TemplateValue::Null);
    }

    #[test]
    fn from_json_bool() {
        assert_eq!(
            TemplateValue::from_json(&json!(true)),
            TemplateValue::Bool(true)
        );
    }

    #[test]
    fn data_var_path_field_missing() {
        let ctx = TemplateContext::new().with_data_var("row", json!({"id": 1}));
        let err = evaluate_var(&first_var("${row.missing}"), &ctx).unwrap_err();
        assert!(matches!(err, EvalError::PathFieldMissing(_)));
    }

    #[test]
    fn bare_unknown_ns_not_allowed() {
        let err = evaluate_var(&first_var("${foo}"), &TemplateContext::default()).unwrap_err();
        assert_eq!(err, EvalError::BareNotAllowed("foo".into()));
    }
}
