//! DSL provider 实例。**不持 registry / runtime 字段**——所有外部状态由 ctx 注入。

use super::{ChildEntry, EngineError, Provider, ProviderContext};
use crate::ast::{
    DelegateProviderField, DynamicDelegateEntry, DynamicListEntry, DynamicSqlEntry, ListEntry,
    Namespace, ProviderDef, ProviderInvocation, Query, TemplateValue as AstTemplateValue,
};
use crate::compose::{
    fold_contrib, render_template_to_string, render_to_owned, AliasTable, ProviderQuery,
    RenderError,
};
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

    /// 构造基础 TemplateContext (含 properties + 可选 captures)。
    fn base_template_context(&self, captures: &[String]) -> TemplateContext {
        let mut tctx = TemplateContext::default();
        tctx.properties = self.properties.clone();
        tctx.capture = captures.to_vec();
        tctx
    }

    /// 求值一组 properties (`HashMap<String, AstTemplateValue>`) 在当前作用域。
    fn eval_properties(
        &self,
        raw: &Option<HashMap<String, AstTemplateValue>>,
        captures: &[String],
    ) -> Result<HashMap<String, TemplateValue>, EngineError> {
        let tctx = self.base_template_context(captures);
        self.eval_properties_in_ctx(raw, &tctx)
    }

    /// 求值 properties 复用 caller 给出的 TemplateContext (可含 data_var / child_var)。
    fn eval_properties_in_ctx(
        &self,
        raw: &Option<HashMap<String, AstTemplateValue>>,
        tctx: &TemplateContext,
    ) -> Result<HashMap<String, TemplateValue>, EngineError> {
        let Some(raw) = raw else {
            return Ok(HashMap::new());
        };
        let mut out = HashMap::with_capacity(raw.len());
        for (k, v) in raw {
            let value = match v {
                AstTemplateValue::String(s) => {
                    if !s.contains("${") {
                        TemplateValue::Text(s.clone())
                    } else {
                        // 字符串字面 → 求值后转 TemplateValue
                        let rendered = render_template_to_string(s, tctx)?;
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

    /// 解析 delegate 路径: 绝对路径 (`/...`) 走 runtime; 相对路径 (`./...`) 从 self 起逐段
    /// resolve + apply_query。返回 (provider, 累积 composed)。
    fn resolve_delegate(
        &self,
        path: &str,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<(Arc<dyn Provider>, ProviderQuery), EngineError> {
        if !path.starts_with("./") {
            // 绝对路径走 runtime (含 longest-prefix cache)
            let node = ctx
                .runtime
                .resolve_with_initial(path, Some(composed.clone()))?;
            return Ok((node.provider, node.composed));
        }
        // 相对路径: 跳过 "./" 前缀, 从 self 起逐段 resolve
        let stripped = &path[2..];
        let mut iter = stripped.split('/').filter(|s| !s.is_empty());
        let first = iter
            .next()
            .ok_or_else(|| EngineError::PathNotFound(path.into()))?;
        let mut current = self
            .resolve(first, composed, ctx)
            .ok_or_else(|| EngineError::PathNotFound(format!("./{}", first)))?;
        let mut current_composed = current.apply_query(composed.clone(), ctx);
        let mut so_far = format!("./{}", first);
        for seg in iter {
            so_far.push('/');
            so_far.push_str(seg);
            let next = current
                .resolve(seg, &current_composed, ctx)
                .ok_or_else(|| EngineError::PathNotFound(so_far.clone()))?;
            current_composed = next.apply_query(current_composed, ctx);
            current = next;
        }
        Ok((current, current_composed))
    }

    /// 渲染 meta 值: 字符串走 template; object/array 递归; 标量原样。
    fn eval_meta(
        &self,
        meta: &Option<serde_json::Value>,
        captures: &[String],
    ) -> Result<Option<serde_json::Value>, EngineError> {
        let tctx = self.base_template_context(captures);
        self.eval_meta_in_ctx(meta, &tctx)
    }

    /// 在 caller 给定的 TemplateContext 下求值 meta (用于 dynamic 项, 可含 data_var / child_var)。
    fn eval_meta_in_ctx(
        &self,
        meta: &Option<serde_json::Value>,
        tctx: &TemplateContext,
    ) -> Result<Option<serde_json::Value>, EngineError> {
        let Some(m) = meta else { return Ok(None) };
        Ok(Some(walk_meta_value(m, tctx)?))
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
                let (provider, _) = self.resolve_delegate(&b.delegate.0, composed, ctx)?;
                Ok(Some(provider))
            }
            ProviderInvocation::Empty(_) => {
                Ok(Some(Arc::new(EmptyDslProvider) as Arc<dyn Provider>))
            }
        }
    }

    /// 动态 SQL list 项: 渲染 SQL → executor 执行 → 每行 row 注入为 data_var, 渲染 key/meta/properties。
    fn list_dynamic_sql(
        &self,
        key_template: &str,
        entry: &DynamicSqlEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let executor = ctx
            .runtime
            .executor()
            .ok_or(EngineError::ExecutorMissing)?
            .clone();

        // 渲染 SQL: properties 作用域 + 父 composed 内联 (供 ${composed} 子查询)。
        let aliases = AliasTable::new();
        let mut prop_ctx = self.base_template_context(&[]);
        if let Ok(composed_rendered) = composed.build_sql(&prop_ctx) {
            prop_ctx.composed = Some(composed_rendered);
        }
        let (sql, params) = render_to_owned(&entry.sql.0, &prop_ctx, &aliases)?;

        let rows = executor(&sql, &params)?;

        let data_var_name = entry.data_var.0.clone();
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let mut row_ctx = self.base_template_context(&[]);
            row_ctx.data_var = Some((data_var_name.clone(), row.clone()));

            let name = render_template_to_string(key_template, &row_ctx)?;

            let provider: Option<Arc<dyn Provider>> = match &entry.provider {
                Some(prov_name) => {
                    let props = self.eval_properties_in_ctx(&entry.properties, &row_ctx)?;
                    ctx.registry
                        .instantiate(&self.current_namespace(), prov_name, &props, ctx)
                }
                None => None,
            };

            let meta = self.eval_meta_in_ctx(&entry.meta, &row_ctx)?;
            out.push(ChildEntry {
                name,
                provider,
                meta,
            });
        }
        Ok(out)
    }

    /// 动态 Delegate list 项: 解析 delegate 路径 → 列举其子节点 → 每个子节点 child_var 注入,
    /// 渲染 key/meta/properties。`provider` 字段决定输出 ChildEntry.provider:
    /// - `None` 或 `ChildRef("${child_var.provider}")` → 透传 target child.provider
    /// - `Name(prov)` → 用 provider name 实例化
    fn list_dynamic_delegate(
        &self,
        key_template: &str,
        entry: &DynamicDelegateEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let (target_provider, target_composed) =
            self.resolve_delegate(&entry.delegate.0, composed, ctx)?;
        let target_children = target_provider.list(&target_composed, ctx)?;

        let child_var_name = entry.child_var.0.clone();
        let mut out = Vec::with_capacity(target_children.len());
        for child in target_children {
            let child_json = serde_json::json!({
                "name": child.name,
                "meta": child.meta.clone().unwrap_or(serde_json::Value::Null),
            });
            let mut tctx = self.base_template_context(&[]);
            tctx.child_var = Some((child_var_name.clone(), child_json));

            let name = render_template_to_string(key_template, &tctx)?;

            let provider: Option<Arc<dyn Provider>> = match &entry.provider {
                None => child.provider.clone(),
                Some(DelegateProviderField::ChildRef(_)) => child.provider.clone(),
                Some(DelegateProviderField::Name(prov_name)) => {
                    let props = self.eval_properties_in_ctx(&entry.properties, &tctx)?;
                    ctx.registry
                        .instantiate(&self.current_namespace(), prov_name, &props, ctx)
                }
            };
            let meta = self.eval_meta_in_ctx(&entry.meta, &tctx)?;
            out.push(ChildEntry {
                name,
                provider,
                meta,
            });
        }
        Ok(out)
    }

    /// 反查: 给定 name, 找到哪个 dynamic 项的 key 模板渲染后等于 name, 然后实例化对应 provider。
    /// 返回 `Ok(None)` 表示该 dynamic 项不命中; `Ok(Some(p))` 命中。
    fn reverse_lookup_dynamic(
        &self,
        name: &str,
        key_template: &str,
        entry: &DynamicListEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<Arc<dyn Provider>>, EngineError> {
        match entry {
            DynamicListEntry::Sql(sql_entry) => {
                let executor = ctx
                    .runtime
                    .executor()
                    .ok_or(EngineError::ExecutorMissing)?
                    .clone();
                let aliases = AliasTable::new();
                let mut prop_ctx = self.base_template_context(&[]);
                if let Ok(composed_rendered) = composed.build_sql(&prop_ctx) {
                    prop_ctx.composed = Some(composed_rendered);
                }
                let (sql, params) = render_to_owned(&sql_entry.sql.0, &prop_ctx, &aliases)?;
                let rows = executor(&sql, &params)?;

                let data_var_name = sql_entry.data_var.0.clone();
                for row in rows {
                    let mut row_ctx = self.base_template_context(&[]);
                    row_ctx.data_var = Some((data_var_name.clone(), row.clone()));
                    let rendered = render_template_to_string(key_template, &row_ctx)?;
                    if rendered == name {
                        let provider: Option<Arc<dyn Provider>> = match &sql_entry.provider {
                            Some(prov_name) => {
                                let props =
                                    self.eval_properties_in_ctx(&sql_entry.properties, &row_ctx)?;
                                ctx.registry.instantiate(
                                    &self.current_namespace(),
                                    prov_name,
                                    &props,
                                    ctx,
                                )
                            }
                            None => None,
                        };
                        return Ok(provider);
                    }
                }
                Ok(None)
            }
            DynamicListEntry::Delegate(del_entry) => {
                let (target_provider, target_composed) =
                    self.resolve_delegate(&del_entry.delegate.0, composed, ctx)?;
                let target_children = target_provider.list(&target_composed, ctx)?;

                let child_var_name = del_entry.child_var.0.clone();
                for child in target_children {
                    let child_json = serde_json::json!({
                        "name": child.name,
                        "meta": child.meta.clone().unwrap_or(serde_json::Value::Null),
                    });
                    let mut tctx = self.base_template_context(&[]);
                    tctx.child_var = Some((child_var_name.clone(), child_json));
                    let rendered = render_template_to_string(key_template, &tctx)?;
                    if rendered == name {
                        let provider: Option<Arc<dyn Provider>> = match &del_entry.provider {
                            None => child.provider.clone(),
                            Some(DelegateProviderField::ChildRef(_)) => child.provider.clone(),
                            Some(DelegateProviderField::Name(prov_name)) => {
                                let props =
                                    self.eval_properties_in_ctx(&del_entry.properties, &tctx)?;
                                ctx.registry.instantiate(
                                    &self.current_namespace(),
                                    prov_name,
                                    &props,
                                    ctx,
                                )
                            }
                        };
                        return Ok(provider);
                    }
                }
                Ok(None)
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
                self.resolve_delegate(&d.delegate.0, &current, ctx)
                    .map(|(_, composed)| composed)
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
                ListEntry::Dynamic(DynamicListEntry::Sql(e)) => {
                    let mut children = self.list_dynamic_sql(key, e, composed, ctx)?;
                    out.append(&mut children);
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                    let mut children = self.list_dynamic_delegate(key, e, composed, ctx)?;
                    out.append(&mut children);
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
            // 3. 动态反查 (§5.2 第三步): 找哪个 dynamic 项渲染出 == name 的 key, 实例化对应 provider
            for (key_template, entry) in &list.entries {
                if let ListEntry::Dynamic(dyn_entry) = entry {
                    if let Ok(Some(p)) =
                        self.reverse_lookup_dynamic(name, key_template, dyn_entry, composed, ctx)
                    {
                        return Some(p);
                    }
                }
            }
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
