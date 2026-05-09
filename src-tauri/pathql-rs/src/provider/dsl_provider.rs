//! DSL provider 实例。**不持 registry / runtime 字段**——所有外部状态由 ctx 注入。

use super::{
    ChildEntry, DelegateTransform, EngineError, ListRef, Provider, ProviderContext, ResolveRef,
};
use crate::ast::{
    DelegateProviderField, DynamicDelegateEntry, DynamicListEntry, DynamicSqlEntry, ListEntry,
    Namespace, ProviderCall, ProviderDef, ProviderInvocation, Query,
    TemplateValue as AstTemplateValue,
};
use crate::compose::{
    fold_contrib, render_template_to_string, render_to_owned, AliasTable, ProviderQuery,
    RenderError,
};
use crate::template::{evaluate_var, parse, Segment, TemplateContext, TemplateValue, VarRef};
use std::collections::HashMap;
use std::sync::Arc;

/// DSL provider 实例。
pub struct DslProvider {
    pub def: Arc<ProviderDef>,
    pub properties: HashMap<String, TemplateValue>,
}

impl DslProvider {
    fn render_provider_name(
        &self,
        provider: &crate::ast::ProviderName,
        captures: &[String],
        ctx: &ProviderContext,
    ) -> Result<crate::ast::ProviderName, EngineError> {
        if !provider.0.contains("${") {
            return Ok(provider.clone());
        }
        let tctx = self.base_template_context(ctx, captures);
        let rendered = render_template_to_string(&provider.0, &tctx)?;
        Ok(crate::ast::ProviderName(rendered))
    }
    /// 自身 namespace (用于 instantiate 时的当前命名空间)。
    fn current_namespace(&self) -> Namespace {
        self.def
            .namespace
            .clone()
            .unwrap_or_else(|| Namespace(String::new()))
    }

    /// 构造基础 TemplateContext (含 properties + 可选 captures)。
    fn base_template_context(&self, ctx: &ProviderContext, captures: &[String]) -> TemplateContext {
        let mut tctx = TemplateContext::default();
        tctx.properties = self.properties.clone();
        tctx.globals = ctx.runtime.globals().clone();
        tctx.capture = captures.to_vec();
        tctx
    }

    /// 求值一组 properties (`HashMap<String, AstTemplateValue>`) 在当前作用域。
    fn eval_properties(
        &self,
        raw: &Option<HashMap<String, AstTemplateValue>>,
        captures: &[String],
        ctx: &ProviderContext,
    ) -> Result<HashMap<String, TemplateValue>, EngineError> {
        let tctx = self.base_template_context(ctx, captures);
        self.eval_properties_in_ctx(raw, &tctx)
    }

    /// 求值 properties 复用 caller 给出的 TemplateContext (可含 data_var / child_var)。
    fn eval_properties_in_ctx(
        &self,
        raw: &Option<HashMap<String, AstTemplateValue>>,
        tctx: &TemplateContext,
    ) -> Result<HashMap<String, TemplateValue>, EngineError> {
        eval_properties_in_ctx(raw, tctx)
    }

    /// 渲染 meta 值: 字符串走 template; object/array 递归; 标量原样。
    /// RULES §4.5: 字符串 meta 启发式判别 — 渲染后若以 `select` 开头 + 含 ` from ` 则视为 SQL 执行,
    /// 取首行结果作为 meta 对象；否则走普通模板渲染 (返回字符串)。
    fn eval_meta(
        &self,
        meta: &Option<serde_json::Value>,
        captures: &[String],
        ctx: &ProviderContext,
    ) -> Result<Option<serde_json::Value>, EngineError> {
        let tctx = self.base_template_context(ctx, captures);
        let dbg = crate::provider::runtime::dbg_enabled();
        // SQL meta 执行路径: 仅对含 `${...}` 的字符串 meta 尝试
        if let Some(serde_json::Value::String(s)) = meta {
            if s.contains("${") {
                match render_template_to_string(s, &tctx) {
                    Ok(rendered) => {
                        let lower = rendered.trim_start().to_ascii_lowercase();
                        if lower.starts_with("select") && lower.contains(" from ") {
                            if dbg {
                                eprintln!(
                                    "[pathql] eval_meta SQL provider={}::{} sql={:?}",
                                    self.def
                                        .namespace
                                        .as_ref()
                                        .map(|n| n.0.as_str())
                                        .unwrap_or(""),
                                    self.def.name.0,
                                    rendered
                                );
                            }
                            match ctx.runtime.executor().execute(&rendered, &[]) {
                                Ok(rows) => {
                                    let result = rows.into_iter().next();
                                    if dbg {
                                        eprintln!("[pathql] eval_meta SQL result={:?}", result);
                                    }
                                    return Ok(result);
                                }
                                Err(e) => {
                                    if dbg {
                                        eprintln!("[pathql] eval_meta SQL error: {}", e);
                                    }
                                    // SQL 执行失败时回落到模板渲染
                                }
                            }
                        }
                    }
                    Err(_) => {} // 渲染失败时回落到 eval_meta_in_ctx
                }
            }
        }
        self.eval_meta_in_ctx(meta, &tctx)
    }

    /// 在 caller 给定的 TemplateContext 下求值 meta (用于 dynamic 项, 可含 data_var / child_var)。
    fn eval_meta_in_ctx(
        &self,
        meta: &Option<serde_json::Value>,
        tctx: &TemplateContext,
    ) -> Result<Option<serde_json::Value>, EngineError> {
        eval_meta_in_ctx(meta, tctx)
    }

    /// 实例化一个 ProviderInvocation 为 Provider 实例。
    /// 实例化 ProviderInvocation 为 Provider (静态 list 项 / resolve ByName / Empty 路径用)。
    /// **不处理 ByDelegate** — ByDelegate 在 resolve() 内部 inline 处理 (需要 name 转发, 而本函数
    /// 只接 captures, 不接 name)。Caller 应在调用前已 dispatch 出 ByDelegate.
    fn instantiate_invocation(
        &self,
        invocation: &ProviderInvocation,
        captures: &[String],
        _composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<Arc<dyn Provider>>, EngineError> {
        match invocation {
            ProviderInvocation::ByName(b) => {
                let props = self.eval_properties(&b.properties, captures, ctx)?;
                let provider_name = self.render_provider_name(&b.provider, captures, ctx)?;
                Ok(ctx
                    .registry
                    .instantiate(&self.current_namespace(), &provider_name, &props, ctx))
            }
            ProviderInvocation::Empty(_) => {
                Ok(Some(Arc::new(EmptyDslProvider) as Arc<dyn Provider>))
            }
            ProviderInvocation::ByDelegate(_) => {
                // 不可达: caller (resolve / materialize_static) 在到这之前应已 dispatch ByDelegate.
                Err(EngineError::FactoryFailed(
                    self.current_namespace().0.clone(),
                    self.def.name.0.clone(),
                    "instantiate_invocation does not handle ByDelegate; must be dispatched inline by caller (resolve forward / static-list rejection)".into(),
                ))
            }
        }
    }

    /// 7b: 把 list / resolve 的 key 模板按 self.properties 渲染为 instance-static 字面量。
    /// - 不含 `${...}` 的纯字面 key 原样返回
    /// - 含 `${properties.X}` 等 instance-static 模板的 key 用 render_template_to_string 替换
    /// - 渲染失败 (引用未定义) 时返回原模板 (静默退化; 调用方按字面比较)
    fn render_key_template(&self, key_template: &str, ctx: &ProviderContext) -> String {
        if !key_template.contains("${") {
            return key_template.to_string();
        }
        let tctx = self.base_template_context(ctx, &[]);
        render_template_to_string(key_template, &tctx).unwrap_or_else(|_| key_template.to_string())
    }

    /// 实例化一个 ProviderCall (6e 起 delegate 字段使用)。返回 None 表示目标未注册。
    fn instantiate_call(
        &self,
        call: &ProviderCall,
        ctx: &ProviderContext,
    ) -> Result<Option<Arc<dyn Provider>>, EngineError> {
        let props = self.eval_properties(&call.properties, &[], ctx)?;
        let provider_name = self.render_provider_name(&call.provider, &[], ctx)?;
        Ok(ctx
            .registry
            .instantiate(&self.current_namespace(), &provider_name, &props, ctx))
    }

    /// 动态 SQL list 项: 渲染 SQL → executor 执行 → 每行 row 注入为 data_var, 渲染 key/meta/properties。
    fn list_dynamic_sql(
        &self,
        key_template: &str,
        entry: &DynamicSqlEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let executor = ctx.runtime.executor().clone();
        let dialect = executor.dialect();

        // 渲染 SQL: properties 作用域 + 父 composed 内联 (供 ${composed} 子查询)。
        let aliases = AliasTable::new();
        let mut prop_ctx = self.base_template_context(ctx, &[]);
        if let Ok(composed_rendered) = composed.build_sql(&prop_ctx, dialect) {
            prop_ctx.composed = Some(composed_rendered);
        }
        let (sql, params) = render_to_owned(&entry.sql.0, &prop_ctx, &aliases, dialect)?;

        let rows = match executor.execute(&sql, &params) {
            Ok(rows) => rows,
            Err(e) => return Err(e),
        };

        let data_var_name = entry.data_var.0.clone();
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let mut row_ctx = self.base_template_context(ctx, &[]);
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

    /// 动态 Delegate list 项: 返回延迟展开引用，由 runtime 负责折叠 target query、
    /// 展开子节点并写 child cache。
    fn list_dynamic_delegate_ref(
        &self,
        key_template: &str,
        entry: &DynamicDelegateEntry,
        ctx: &ProviderContext,
    ) -> Result<ListRef, EngineError> {
        let target = self
            .instantiate_call(&entry.delegate, ctx)?
            .ok_or_else(|| {
                EngineError::ProviderNotRegistered(
                    self.current_namespace().0.clone(),
                    entry.delegate.provider.0.clone(),
                )
            })?;

        let key_template = key_template.to_string();
        let child_var_name = entry.child_var.0.clone();
        let entry_provider = entry.provider.clone();
        let entry_properties = entry.properties.clone();
        let entry_meta = entry.meta.clone();
        let self_properties = self.properties.clone();
        let namespace = self.current_namespace();

        let expand = Arc::new(move |child: &ChildEntry, ctx: &ProviderContext| {
            let child_json = DslProvider::child_entry_json(child);
            let mut tctx = TemplateContext::default();
            tctx.properties = self_properties.clone();
            tctx.globals = ctx.runtime.globals().clone();
            tctx.child_var = Some((child_var_name.clone(), child_json));

            let name = render_template_to_string(&key_template, &tctx)?;

            let provider: Option<Arc<dyn Provider>> = match &entry_provider {
                None => None,
                Some(DelegateProviderField::ChildRef(_)) => child.provider.clone(),
                Some(DelegateProviderField::Name(prov_name)) => {
                    let props = eval_properties_in_ctx(&entry_properties, &tctx)?;
                    ctx.registry.instantiate(&namespace, prov_name, &props, ctx)
                }
            };
            let meta = eval_meta_in_ctx(&entry_meta, &tctx)?;
            Ok(Some(ChildEntry {
                name,
                provider,
                meta,
            }))
        });

        Ok(ListRef::DelegateExpand { target, expand })
    }

    fn child_entry_json(child: &ChildEntry) -> serde_json::Value {
        serde_json::json!({
            "name": child.name,
            "provider": serde_json::Value::Null,
            "meta": child.meta.clone().unwrap_or(serde_json::Value::Null),
        })
    }

    /// 把 ProviderInvocation 包成 ChildEntry。
    /// 7b: ByDelegate 由 resolve 调用点单独处理, 静态 list 项不支持转发语义。
    fn materialize_invocation_child(
        &self,
        key: &str,
        inv: &ProviderInvocation,
        captures: &[String],
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<ChildEntry>, EngineError> {
        if matches!(inv, ProviderInvocation::ByDelegate(_)) {
            return Err(EngineError::FactoryFailed(
                self.current_namespace().0.clone(),
                self.def.name.0.clone(),
                format!(
                    "static list entry `{}` cannot use ByDelegate ({{delegate:...}}); only resolve table supports forwarding",
                    key
                ),
            ));
        }
        let meta = match inv {
            ProviderInvocation::ByName(b) => {
                let provider = self.instantiate_invocation(inv, captures, composed, ctx)?;
                let Some(provider) = provider else {
                    return Ok(None);
                };
                let meta = self.eval_meta(&b.meta, captures, ctx)?;
                return Ok(Some(ChildEntry {
                    name: key.to_string(),
                    provider: Some(provider),
                    meta,
                }));
            }
            ProviderInvocation::Empty(b) => self.eval_meta(&b.meta, captures, ctx)?,
            ProviderInvocation::ByDelegate(_) => unreachable!("rejected above"),
        };
        Ok(Some(ChildEntry {
            name: key.to_string(),
            provider: Some(Arc::new(EmptyDslProvider) as Arc<dyn Provider>),
            meta,
        }))
    }

    fn materialize_static(
        &self,
        key: &str,
        inv: &ProviderInvocation,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Option<ChildEntry>, EngineError> {
        self.materialize_invocation_child(key, inv, &[], composed, ctx)
    }
}

impl Provider for DslProvider {
    fn apply_query(&self, current: ProviderQuery, ctx: &ProviderContext) -> ProviderQuery {
        match &self.def.query {
            None => current,
            Some(Query::Contrib(q)) => {
                let mut state = current;
                // 把当前 provider 的 properties 写入 adhoc_properties, 让后续 build_sql
                // 渲染 contrib 中的 ${properties.X} 模板时能取到值。
                // 注: 路径上多个 DslProvider 各自调 apply_query 时累积写入; 同名 key 后写胜
                // (符合 fold 累积语义 — 链下游 provider 的 properties 应覆盖上游)。
                for (k, v) in &self.properties {
                    state.adhoc_properties.insert(k.clone(), v.clone());
                }
                if crate::provider::runtime::dbg_enabled() {
                    eprintln!(
                        "[pathql] DslProvider({}::{}).apply_query Contrib — properties={:?} adhoc_after={:?}",
                        self.def.namespace.as_ref().map(|n| n.0.as_str()).unwrap_or(""),
                        self.def.name.0,
                        self.properties.keys().collect::<Vec<_>>(),
                        state.adhoc_properties.keys().collect::<Vec<_>>(),
                    );
                }
                // fold 失败时静默返回原 state (apply_query 没有 Result 通道)
                let _ = fold_contrib(&mut state, q);
                state
            }
            Some(Query::Delegate(d)) => {
                // 6e: delegate 是 ProviderCall — 实例化目标 + 委托其 apply_query。
                // 目标未注册时静默返回原 state (apply_query 无 Result 通道; validate cross_ref 应已捕获)。
                // 注: 不在此处写 self.properties 进 adhoc — 目标 provider 自己的 apply_query 会
                //     用它本身的 properties (来自 ProviderCall.properties 实例化结果) 写入。
                match self.instantiate_call(&d.delegate, ctx) {
                    Ok(Some(target)) => target.apply_query(current, ctx),
                    _ => current,
                }
            }
        }
    }

    fn list(
        &self,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(list) = &self.def.list else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for (key_template, entry) in &list.entries {
            match entry {
                ListEntry::Static(invocation) => {
                    // 7b: 渲染 key 模板 (instance-static 形态会被替换为字面)
                    let rendered_key = self.render_key_template(key_template, ctx);
                    if let Some(child) =
                        self.materialize_static(&rendered_key, invocation, composed, ctx)?
                    {
                        out.push(ListRef::Direct(child));
                    }
                }
                ListEntry::Dynamic(DynamicListEntry::Sql(e)) => {
                    out.extend(
                        self.list_dynamic_sql(key_template, e, composed, ctx)?
                            .into_iter()
                            .map(ListRef::Direct),
                    );
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                    out.push(self.list_dynamic_delegate_ref(key_template, e, ctx)?);
                }
            }
        }
        Ok(out)
    }

    fn resolve(&self, name: &str, composed: &ProviderQuery, ctx: &ProviderContext) -> ResolveRef {
        let dbg = crate::provider::runtime::dbg_enabled();
        if dbg {
            let static_keys: Vec<&str> = self
                .def
                .list
                .as_ref()
                .map(|l| {
                    l.entries
                        .iter()
                        .filter(|(_, e)| matches!(e, ListEntry::Static(_)))
                        .map(|(k, _)| k.as_str())
                        .collect()
                })
                .unwrap_or_default();
            let regex_keys: Vec<&str> = self
                .def
                .resolve
                .as_ref()
                .map(|r| r.0.keys().map(|k| k.as_str()).collect())
                .unwrap_or_default();
            eprintln!(
                "[pathql] DslProvider({}::{}).resolve({:?}) — static_list={:?} regex={:?}",
                self.def
                    .namespace
                    .as_ref()
                    .map(|n| n.0.as_str())
                    .unwrap_or(""),
                self.def.name.0,
                name,
                static_keys,
                regex_keys
            );
        }
        // 1. resolve.entries (regex)
        if let Some(resolve) = &self.def.resolve {
            for (pattern_template, invocation) in &resolve.0 {
                // 渲染 pattern 中的 ${properties.X} (instance-static)
                let pattern = self.render_key_template(pattern_template, ctx);
                let anchored = format!("^(?:{})$", pattern);
                let re = match regex::Regex::new(&anchored) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(captures) = re.captures(name) {
                    if dbg {
                        eprintln!(
                            "[pathql]   regex {:?} (rendered={:?}) matched",
                            pattern_template, pattern
                        );
                    }
                    let cap_vec: Vec<String> = captures
                        .iter()
                        .map(|m| m.map(|x| x.as_str().to_string()).unwrap_or_default())
                        .collect();
                    // ByDelegate 只返回路由引用；target recursion 和 child materialize
                    // 均由 runtime 通过 transform stack 延迟处理。
                    if let ProviderInvocation::ByDelegate(b) = invocation {
                        if dbg {
                            eprintln!(
                                "[pathql]   regex matched ByDelegate; returning delegate target {:?} for {:?}",
                                b.delegate.provider, name
                            );
                        }
                        let target = match self.instantiate_call(&b.delegate, ctx).ok().flatten() {
                            Some(t) => t,
                            None => return ResolveRef::Terminal(None),
                        };

                        let b_child_var = b.child_var.clone();
                        let b_meta = b.meta.clone();
                        let b_provider = b.provider.clone();
                        let b_props = b.properties.clone();
                        let name_owned = name.to_string();
                        let self_props = self.properties.clone();
                        let namespace = self.current_namespace();
                        let globals = ctx.runtime.globals().clone();
                        let cap_vec = cap_vec.clone();

                        let transform: DelegateTransform = Arc::new(move |target_child, ctx| {
                            let tc = target_child?;
                            let mut tctx = TemplateContext::default();
                            tctx.properties = self_props.clone();
                            tctx.globals = globals.clone();
                            tctx.capture = cap_vec.clone();
                            if let Some(child_var) = &b_child_var {
                                tctx.child_var =
                                    Some((child_var.0.clone(), DslProvider::child_entry_json(tc)));
                            }

                            let final_meta = eval_meta_in_ctx(&b_meta, &tctx).ok()?;
                            let final_provider = match &b_provider {
                                None => None,
                                Some(DelegateProviderField::ChildRef(_)) => tc.provider.clone(),
                                Some(DelegateProviderField::Name(provider_name)) => {
                                    let props = eval_properties_in_ctx(&b_props, &tctx).ok()?;
                                    Some(ctx.registry.instantiate(
                                        &namespace,
                                        provider_name,
                                        &props,
                                        ctx,
                                    )?)
                                }
                            };

                            Some(ChildEntry {
                                name: name_owned.clone(),
                                provider: final_provider,
                                meta: final_meta,
                            })
                        });
                        return ResolveRef::Delegate { target, transform };
                    }
                    return ResolveRef::Terminal(
                        self.materialize_invocation_child(
                            name, invocation, &cap_vec, composed, ctx,
                        )
                        .ok()
                        .flatten(),
                    );
                }
            }
        }
        // 2. 静态 list 字面 (含 instance-static; key 模板按 properties 渲染后比较)
        if let Some(list) = &self.def.list {
            for (key_template, entry) in &list.entries {
                if let ListEntry::Static(inv) = entry {
                    let rendered_key = self.render_key_template(key_template, ctx);
                    if rendered_key == name {
                        if dbg {
                            eprintln!(
                                "[pathql]   static list key {:?} (rendered={:?}) matched",
                                key_template, rendered_key
                            );
                        }
                        return ResolveRef::Terminal(
                            self.materialize_invocation_child(name, inv, &[], composed, ctx)
                                .ok()
                                .flatten(),
                        );
                    }
                }
            }
        }
        if dbg {
            eprintln!("[pathql]   ← no match, returning None");
        }
        ResolveRef::Terminal(None)
    }

    fn get_note(&self, _composed: &ProviderQuery, ctx: &ProviderContext) -> Option<String> {
        let raw = self.def.note.as_ref()?;
        if !raw.contains("${") {
            return Some(raw.clone());
        }
        let tctx = self.base_template_context(ctx, &[]);
        // 渲染失败时回落到原文 (note 是诊断字段，不应阻断 list)
        Some(render_template_to_string(raw, &tctx).unwrap_or_else(|_| raw.clone()))
    }
}

fn eval_properties_in_ctx(
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
                    let rendered = render_template_to_string(s, tctx)?;
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

fn eval_meta_in_ctx(
    meta: &Option<serde_json::Value>,
    tctx: &TemplateContext,
) -> Result<Option<serde_json::Value>, EngineError> {
    let Some(m) = meta else { return Ok(None) };
    Ok(Some(walk_meta_value(m, tctx)?))
}

fn template_value_to_json(v: TemplateValue) -> serde_json::Value {
    match v {
        TemplateValue::Null => serde_json::Value::Null,
        TemplateValue::Bool(b) => serde_json::Value::Bool(b),
        TemplateValue::Int(i) => serde_json::Value::from(i),
        TemplateValue::Real(r) => serde_json::Number::from_f64(r)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        TemplateValue::Text(s) => serde_json::Value::String(s),
        TemplateValue::Json(v) => v,
    }
}

fn pure_meta_template_value(
    template: &str,
    tctx: &TemplateContext,
) -> Result<Option<serde_json::Value>, RenderError> {
    let ast = parse(template)?;
    if ast.segments.len() != 1 {
        return Ok(None);
    }

    let Segment::Var(var) = &ast.segments[0] else {
        return Ok(None);
    };

    if matches!(var, VarRef::Method { name, .. } if name == "global") {
        return Ok(None);
    }

    if let VarRef::Bare { ns } = var {
        if let Some((name, json)) = &tctx.data_var {
            if name == ns {
                return Ok(Some(json.clone()));
            }
        }
        if let Some((name, json)) = &tctx.child_var {
            if name == ns {
                return Ok(Some(json.clone()));
            }
        }
    }

    Ok(Some(template_value_to_json(evaluate_var(var, tctx)?)))
}

fn walk_meta_value(
    v: &serde_json::Value,
    tctx: &TemplateContext,
) -> Result<serde_json::Value, RenderError> {
    use serde_json::Value as J;
    match v {
        // 7c S2: `{"$json": "<template>"}` directive — 渲染模板字符串后 parse 为 JSON 值。
        // 用例: meta 用 host SQL 函数 (`get_plugin(id)`) 返回的 JSON 文本
        // 整体注入, 无需在 DSL 里逐字段展开。directive 形态: 单键 `$json`, 值是模板字符串。
        J::Object(map) if map.len() == 1 && map.contains_key("$json") => {
            let template = map.get("$json").and_then(|v| v.as_str()).ok_or_else(|| {
                RenderError::MetaJsonParse("$json directive value must be a string template".into())
            })?;
            let rendered = render_template_to_string(template, tctx)?;
            serde_json::from_str(&rendered).map_err(|e| {
                RenderError::MetaJsonParse(format!("{} (rendered: {:?})", e, rendered))
            })
        }
        J::String(s) if s.contains("${") => {
            if let Some(value) = pure_meta_template_value(s, tctx)? {
                return Ok(value);
            }
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
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ListRef>, EngineError> {
        Ok(Vec::new())
    }
    fn is_empty(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod walk_meta_tests {
    use super::*;
    use crate::template::eval::{TemplateContext, TemplateValue};

    fn ctx_with_data(name: &str, json: serde_json::Value) -> TemplateContext {
        TemplateContext::new().with_data_var(name, json)
    }

    #[test]
    fn json_directive_parses_rendered_template_to_object() {
        let ctx = ctx_with_data(
            "out",
            serde_json::json!({
                "blob": r#"{"a":1,"b":"x"}"#
            }),
        );
        let meta = serde_json::json!({"$json": "${out.blob}"});
        let result = walk_meta_value(&meta, &ctx).unwrap();
        assert_eq!(result, serde_json::json!({"a":1,"b":"x"}));
    }

    #[test]
    fn json_directive_parses_rendered_to_null() {
        let ctx = ctx_with_data("out", serde_json::json!({"blob": "null"}));
        let meta = serde_json::json!({"$json": "${out.blob}"});
        let result = walk_meta_value(&meta, &ctx).unwrap();
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn json_directive_invalid_returns_meta_json_parse_error() {
        let ctx = ctx_with_data("out", serde_json::json!({"blob": "not json {"}));
        let meta = serde_json::json!({"$json": "${out.blob}"});
        let err = walk_meta_value(&meta, &ctx).unwrap_err();
        assert!(matches!(err, RenderError::MetaJsonParse(_)));
    }

    #[test]
    fn plain_object_meta_still_walks_children() {
        let ctx = TemplateContext::new().with_properties(
            [("k".into(), TemplateValue::Text("v".into()))]
                .into_iter()
                .collect(),
        );
        let meta = serde_json::json!({
            "kind": "x",
            "value": "${properties.k}"
        });
        let result = walk_meta_value(&meta, &ctx).unwrap();
        assert_eq!(result, serde_json::json!({"kind":"x","value":"v"}));
    }

    #[test]
    fn pure_variable_meta_preserves_json_types() {
        let ctx = ctx_with_data(
            "out",
            serde_json::json!({
                "id": "a",
                "created_at": 42,
                "parent_id": null,
                "nested": {"ok": true}
            }),
        );
        let meta = serde_json::json!({
            "kind": "album",
            "data": {
                "id": "${out.id}",
                "createdAt": "${out.created_at}",
                "parentId": "${out.parent_id}",
                "nested": "${out.nested}"
            },
            "row": "${out}"
        });
        let result = walk_meta_value(&meta, &ctx).unwrap();
        assert_eq!(
            result,
            serde_json::json!({
                "kind": "album",
                "data": {
                    "id": "a",
                    "createdAt": 42,
                    "parentId": null,
                    "nested": {"ok": true}
                },
                "row": {
                    "id": "a",
                    "created_at": 42,
                    "parent_id": null,
                    "nested": {"ok": true}
                }
            })
        );
    }

    #[test]
    fn json_directive_only_triggers_for_single_key_object() {
        // Object with $json AND another key → treated as plain object (not directive).
        let ctx = ctx_with_data("out", serde_json::json!({"blob": r#"{"a":1}"#}));
        let meta = serde_json::json!({"$json": "${out.blob}", "extra": "y"});
        let result = walk_meta_value(&meta, &ctx).unwrap();
        // The $json key value is a template string, walked as such → kept as string
        assert_eq!(
            result,
            serde_json::json!({"$json": r#"{"a":1}"#, "extra": "y"})
        );
    }
}
