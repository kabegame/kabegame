//! DSL provider 实例。**不持 registry / runtime 字段**——所有外部状态由 ctx 注入。

use super::{ChildEntry, EngineError, Provider, ProviderContext};
use crate::ast::{
    ListEntry, Namespace, ProviderDef, ProviderInvocation, Query,
    TemplateValue as AstTemplateValue,
};
use crate::compose::{fold_contrib, render_template_to_string, ProviderQuery, RenderError};
use crate::template::eval::{TemplateContext, TemplateValue};
use std::collections::HashMap;
use std::sync::Arc;

/// DSL provider 实例。
pub struct DslProvider {
    pub def: Arc<ProviderDef>,
    pub properties: HashMap<String, TemplateValue>,
}

impl DslProvider {
    /// 自身 namespace (用于 instantiate 时的当前命名空间)。
    fn current_namespace(&self) -> Namespace {
        self.def
            .namespace
            .clone()
            .unwrap_or_else(|| Namespace(String::new()))
    }

    /// 求值一组 properties (`HashMap<String, AstTemplateValue>`) 在当前作用域。
    fn eval_properties(
        &self,
        raw: &Option<HashMap<String, AstTemplateValue>>,
        captures: &[String],
    ) -> Result<HashMap<String, TemplateValue>, EngineError> {
        let Some(raw) = raw else {
            return Ok(HashMap::new());
        };
        let mut out = HashMap::with_capacity(raw.len());
        let mut tctx = TemplateContext::default();
        tctx.properties = self.properties.clone();
        tctx.capture = captures.to_vec();
        for (k, v) in raw {
            let value = match v {
                AstTemplateValue::String(s) => {
                    if !s.contains("${") {
                        TemplateValue::Text(s.clone())
                    } else {
                        // 字符串字面 → 求值后转 TemplateValue
                        let rendered = render_template_to_string(s, &tctx)?;
                        // 尝试 int / real 解析；否则保留 Text
                        if let Ok(i) = rendered.parse::<i64>() {
                            TemplateValue::Int(i)
                        } else if let Ok(f) = rendered.parse::<f64>() {
                            TemplateValue::Real(f)
                        } else {
                            TemplateValue::Text(rendered)
                        }
                    }
                }
                AstTemplateValue::Number(n) => {
                    if n.fract() == 0.0 {
                        TemplateValue::Int(*n as i64)
                    } else {
                        TemplateValue::Real(*n)
                    }
                }
                AstTemplateValue::Boolean(b) => TemplateValue::Bool(*b),
            };
            out.insert(k.clone(), value);
        }
        Ok(out)
    }

    /// 渲染 meta 值: 字符串走 template; object/array 递归; 标量原样。
    fn eval_meta(
        &self,
        meta: &Option<serde_json::Value>,
        captures: &[String],
    ) -> Result<Option<serde_json::Value>, EngineError> {
        let Some(m) = meta else { return Ok(None) };
        let mut tctx = TemplateContext::default();
        tctx.properties = self.properties.clone();
        tctx.capture = captures.to_vec();
        Ok(Some(walk_meta_value(m, &tctx)?))
    }

    /// 实例化一个 ProviderInvocation 为 Provider 实例。
    fn instantiate_invocation(
        &self,
        invocation: &ProviderInvocation,
        captures: &[String],
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<Arc<dyn Provider>>, EngineError> {
        match invocation {
            ProviderInvocation::ByName(b) => {
                let props = self.eval_properties(&b.properties, captures)?;
                Ok(ctx
                    .registry
                    .instantiate(&self.current_namespace(), &b.provider, &props, ctx))
            }
            ProviderInvocation::ByDelegate(b) => {
                let props = self.eval_properties(&b.properties, captures)?;
                let _ = props; // ByDelegate 仅借用路径解析; properties 用于 compose 阶段，本期不传给 runtime
                let node = ctx
                    .runtime
                    .resolve_with_initial(&b.delegate.0, Some(composed.clone()))?;
                Ok(Some(node.provider))
            }
            ProviderInvocation::Empty(_) => {
                Ok(Some(Arc::new(EmptyDslProvider) as Arc<dyn Provider>))
            }
        }
    }

    /// 把 ProviderInvocation 包成 ChildEntry (静态 list 项用)。
    fn materialize_static(
        &self,
        key: &str,
        inv: &ProviderInvocation,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<ChildEntry>, EngineError> {
        // 静态项无 capture; meta 在 self.properties 作用域下渲染
        let provider = self.instantiate_invocation(inv, &[], composed, ctx)?;
        let meta = match inv {
            ProviderInvocation::ByName(b) => self.eval_meta(&b.meta, &[])?,
            ProviderInvocation::ByDelegate(b) => self.eval_meta(&b.meta, &[])?,
            ProviderInvocation::Empty(b) => self.eval_meta(&b.meta, &[])?,
        };
        Ok(Some(ChildEntry {
            name: key.to_string(),
            provider,
            meta,
        }))
    }
}

impl Provider for DslProvider {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery {
        match &self.def.query {
            None => current,
            Some(Query::Contrib(q)) => {
                let mut state = current;
                // fold 失败时静默返回原 state (apply_query 没有 Result 通道)
                let _ = fold_contrib(&mut state, q);
                state
            }
            Some(Query::Delegate(d)) => {
                ctx.runtime
                    .resolve_with_initial(&d.delegate.0, Some(current.clone()))
                    .map(|node| node.composed)
                    .unwrap_or(current)
            }
        }
    }

    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let Some(list) = &self.def.list else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for (key, entry) in &list.entries {
            match entry {
                ListEntry::Static(invocation) => {
                    if let Some(child) = self.materialize_static(key, invocation, composed, ctx)? {
                        out.push(child);
                    }
                }
                ListEntry::Dynamic(_) => {
                    // 6a: 动态 list 项需要 SQL 执行能力, 留 6c 实现 (静默跳过)。
                }
            }
        }
        Ok(out)
    }

    fn resolve(
        &self,
        name: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        // 1. resolve.entries (regex)
        if let Some(resolve) = &self.def.resolve {
            for (pattern, invocation) in &resolve.0 {
                let anchored = format!("^(?:{})$", pattern);
                let re = match regex::Regex::new(&anchored) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(captures) = re.captures(name) {
                    let cap_vec: Vec<String> = captures
                        .iter()
                        .map(|m| m.map(|x| x.as_str().to_string()).unwrap_or_default())
                        .collect();
                    return self
                        .instantiate_invocation(invocation, &cap_vec, composed, ctx)
                        .ok()
                        .flatten();
                }
            }
        }
        // 2. 静态 list 字面
        if let Some(list) = &self.def.list {
            for (key, entry) in &list.entries {
                if key == name {
                    if let ListEntry::Static(inv) = entry {
                        return self
                            .instantiate_invocation(inv, &[], composed, ctx)
                            .ok()
                            .flatten();
                    }
                }
            }
            // 3. 动态反查留 6c
        }
        None
    }

    fn get_note(&self, _composed: &ProviderQuery, _ctx: &ProviderContext) -> Option<String> {
        let raw = self.def.note.as_ref()?;
        if !raw.contains("${") {
            return Some(raw.clone());
        }
        let mut tctx = TemplateContext::default();
        tctx.properties = self.properties.clone();
        // 渲染失败时回落到原文 (note 是诊断字段，不应阻断 list)
        Some(render_template_to_string(raw, &tctx).unwrap_or_else(|_| raw.clone()))
    }
}

fn walk_meta_value(
    v: &serde_json::Value,
    tctx: &TemplateContext,
) -> Result<serde_json::Value, RenderError> {
    use serde_json::Value as J;
    match v {
        J::String(s) if s.contains("${") => {
            let rendered = render_template_to_string(s, tctx)?;
            Ok(J::String(rendered))
        }
        J::String(s) => Ok(J::String(s.clone())),
        J::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, child) in map {
                out.insert(k.clone(), walk_meta_value(child, tctx)?);
            }
            Ok(J::Object(out))
        }
        J::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for child in arr {
                out.push(walk_meta_value(child, tctx)?);
            }
            Ok(J::Array(out))
        }
        other => Ok(other.clone()),
    }
}

/// EmptyInvocation 占位 provider; runtime 见 is_empty() == true 时跳过缓存。
pub struct EmptyDslProvider;

impl Provider for EmptyDslProvider {
    fn list(
        &self,
        _: &ProviderQuery,
        _: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        Ok(Vec::new())
    }
    fn resolve(
        &self,
        _: &str,
        _: &ProviderQuery,
        _: &ProviderContext,
    ) -> Option<Arc<dyn Provider>> {
        None
    }
    fn is_empty(&self) -> bool {
        true
    }
}
