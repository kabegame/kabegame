//! DSL provider 实例。**不持 registry / runtime 字段**——所有外部状态由 ctx 注入。

use super::{ChildEntry, EngineError, Provider, ProviderContext};
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
use std::time::Instant;

/// DSL provider 实例。
pub struct DslProvider {
    pub def: Arc<ProviderDef>,
    pub properties: HashMap<String, TemplateValue>,
}

impl DslProvider {
    fn provider_label(&self) -> String {
        format!(
            "{}::{}",
            self.def
                .namespace
                .as_ref()
                .map(|n| n.0.as_str())
                .unwrap_or(""),
            self.def.name.0
        )
    }

    fn profile_enabled(&self) -> bool {
        let Ok(filter) = std::env::var("PATHQL_PROFILE") else {
            return false;
        };
        let filter = filter.trim();
        if filter.is_empty() || matches!(filter, "0" | "false" | "off") {
            return false;
        }
        if matches!(filter, "1" | "true" | "all") {
            return true;
        }

        self.provider_label().contains(filter) || self.def.name.0.contains(filter)
    }

    fn profile_log(&self, op: &str, started: Instant, detail: impl AsRef<str>) {
        if self.profile_enabled() {
            eprintln!(
                "[pathql-profile] provider={} op={} elapsed_ms={} {}",
                self.provider_label(),
                op,
                started.elapsed().as_millis(),
                detail.as_ref()
            );
        }
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

    /// 渲染 meta 值: 字符串走 template; object/array 递归; 标量原样。
    fn eval_meta(
        &self,
        meta: &Option<serde_json::Value>,
        captures: &[String],
        ctx: &ProviderContext,
    ) -> Result<Option<serde_json::Value>, EngineError> {
        let tctx = self.base_template_context(ctx, captures);
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
                Ok(ctx
                    .registry
                    .instantiate(&self.current_namespace(), &b.provider, &props, ctx))
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
        Ok(ctx
            .registry
            .instantiate(&self.current_namespace(), &call.provider, &props, ctx))
    }

    /// 动态 SQL list 项: 渲染 SQL → executor 执行 → 每行 row 注入为 data_var, 渲染 key/meta/properties。
    fn list_dynamic_sql(
        &self,
        key_template: &str,
        entry: &DynamicSqlEntry,
        composed: &ProviderQuery,
        ctx: &ProviderContext,
    ) -> Result<Vec<ChildEntry>, EngineError> {
        let total_started = Instant::now();
        let executor = ctx.runtime.executor().clone();
        let dialect = executor.dialect();

        // 渲染 SQL: properties 作用域 + 父 composed 内联 (供 ${composed} 子查询)。
        let render_started = Instant::now();
        let aliases = AliasTable::new();
        let mut prop_ctx = self.base_template_context(ctx, &[]);
        if let Ok(composed_rendered) = composed.build_sql(&prop_ctx, dialect) {
            prop_ctx.composed = Some(composed_rendered);
        }
        let (sql, params) = render_to_owned(&entry.sql.0, &prop_ctx, &aliases, dialect)?;
        self.profile_log(
            "list.sql.render",
            render_started,
            format!("key_template={key_template:?} params={}", params.len()),
        );

        let execute_started = Instant::now();
        let rows = match executor.execute(&sql, &params) {
            Ok(rows) => {
                self.profile_log(
                    "list.sql.execute",
                    execute_started,
                    format!("rows={} sql={sql:?}", rows.len()),
                );
                rows
            }
            Err(e) => {
                self.profile_log(
                    "list.sql.execute",
                    execute_started,
                    format!("err={e:?} sql={sql:?}"),
                );
                return Err(e);
            }
        };

        let materialize_started = Instant::now();
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
        self.profile_log(
            "list.sql.materialize",
            materialize_started,
            format!("children={}", out.len()),
        );
        self.profile_log(
            "list.sql.total",
            total_started,
            format!("key_template={key_template:?} children={}", out.len()),
        );
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
        // 6e: delegate 直接是 ProviderCall — 实例化目标 + apply_query 累计上游 composed,
        //     再调它的 list 拿 children。
        let target_provider = self
            .instantiate_call(&entry.delegate, ctx)?
            .ok_or_else(|| {
                EngineError::ProviderNotRegistered(
                    self.current_namespace().0.clone(),
                    entry.delegate.provider.0.clone(),
                )
            })?;
        let target_composed = target_provider.apply_query(composed.clone(), ctx);
        let target_children = target_provider.list(&target_composed, ctx)?;

        let child_var_name = entry.child_var.0.clone();
        let mut out = Vec::with_capacity(target_children.len());
        for child in target_children {
            let child_json = serde_json::json!({
                "name": child.name,
                "meta": child.meta.clone().unwrap_or(serde_json::Value::Null),
            });
            let mut tctx = self.base_template_context(ctx, &[]);
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
                let total_started = Instant::now();
                let dbg = crate::provider::runtime::dbg_enabled();
                let executor = ctx.runtime.executor().clone();
                let dialect = executor.dialect();
                let aliases = AliasTable::new();
                let mut prop_ctx = self.base_template_context(ctx, &[]);
                match composed.build_sql(&prop_ctx, dialect) {
                    Ok(composed_rendered) => {
                        if dbg {
                            eprintln!(
                                "[pathql]   reverse dynamic SQL composed provider={}::{} sql={:?} params={:?}",
                                self.def
                                    .namespace
                                    .as_ref()
                                    .map(|n| n.0.as_str())
                                    .unwrap_or(""),
                                self.def.name.0,
                                composed_rendered.0,
                                composed_rendered.1,
                            );
                        }
                        prop_ctx.composed = Some(composed_rendered);
                    }
                    Err(e) => {
                        if dbg {
                            eprintln!(
                                "[pathql]   reverse dynamic SQL composed render ERROR provider={}::{}: {}",
                                self.def
                                    .namespace
                                    .as_ref()
                                    .map(|n| n.0.as_str())
                                    .unwrap_or(""),
                                self.def.name.0,
                                e,
                            );
                        }
                    }
                }
                let render_started = Instant::now();
                let (sql, params) =
                    render_to_owned(&sql_entry.sql.0, &prop_ctx, &aliases, dialect)?;
                self.profile_log(
                    "resolve.dynamic.sql.render",
                    render_started,
                    format!(
                        "target={name:?} key_template={key_template:?} params={}",
                        params.len()
                    ),
                );
                if dbg {
                    eprintln!(
                        "[pathql]   reverse dynamic SQL provider={}::{} key_template={:?} sql={:?} params={:?}",
                        self.def
                            .namespace
                            .as_ref()
                            .map(|n| n.0.as_str())
                            .unwrap_or(""),
                        self.def.name.0,
                        key_template,
                        sql,
                        params,
                    );
                }
                let execute_started = Instant::now();
                let rows = match executor.execute(&sql, &params) {
                    Ok(rows) => {
                        self.profile_log(
                            "resolve.dynamic.sql.execute",
                            execute_started,
                            format!("target={name:?} rows={} sql={sql:?}", rows.len()),
                        );
                        rows
                    }
                    Err(e) => {
                        self.profile_log(
                            "resolve.dynamic.sql.execute",
                            execute_started,
                            format!("target={name:?} err={e:?} sql={sql:?}"),
                        );
                        return Err(e);
                    }
                };
                if dbg {
                    eprintln!(
                        "[pathql]   reverse dynamic SQL rows provider={}::{} count={}",
                        self.def
                            .namespace
                            .as_ref()
                            .map(|n| n.0.as_str())
                            .unwrap_or(""),
                        self.def.name.0,
                        rows.len(),
                    );
                }

                let scan_started = Instant::now();
                let data_var_name = sql_entry.data_var.0.clone();
                for row in rows {
                    let mut row_ctx = self.base_template_context(ctx, &[]);
                    row_ctx.data_var = Some((data_var_name.clone(), row.clone()));
                    let rendered = render_template_to_string(key_template, &row_ctx)?;
                    if dbg {
                        eprintln!(
                            "[pathql]   reverse dynamic candidate provider={}::{} rendered={:?} target={:?} row={:?}",
                            self.def
                                .namespace
                                .as_ref()
                                .map(|n| n.0.as_str())
                                .unwrap_or(""),
                            self.def.name.0,
                            rendered,
                            name,
                            row,
                        );
                    }
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
                        self.profile_log(
                            "resolve.dynamic.sql.scan",
                            scan_started,
                            format!("target={name:?} result=hit rendered={rendered:?}"),
                        );
                        self.profile_log(
                            "resolve.dynamic.sql.total",
                            total_started,
                            format!("target={name:?} result=hit"),
                        );
                        return Ok(provider);
                    }
                }
                self.profile_log(
                    "resolve.dynamic.sql.scan",
                    scan_started,
                    format!("target={name:?} result=miss"),
                );
                self.profile_log(
                    "resolve.dynamic.sql.total",
                    total_started,
                    format!("target={name:?} result=miss"),
                );
                Ok(None)
            }
            DynamicListEntry::Delegate(del_entry) => {
                let target_provider = self
                    .instantiate_call(&del_entry.delegate, ctx)?
                    .ok_or_else(|| {
                        EngineError::ProviderNotRegistered(
                            self.current_namespace().0.clone(),
                            del_entry.delegate.provider.0.clone(),
                        )
                    })?;
                let target_composed = target_provider.apply_query(composed.clone(), ctx);
                let target_children = target_provider.list(&target_composed, ctx)?;

                let child_var_name = del_entry.child_var.0.clone();
                for child in target_children {
                    let child_json = serde_json::json!({
                        "name": child.name,
                        "meta": child.meta.clone().unwrap_or(serde_json::Value::Null),
                    });
                    let mut tctx = self.base_template_context(ctx, &[]);
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
    /// 7b: 拒绝 ByDelegate — list 静态项不支持转发语义 (只有 resolve 表里有意义)。
    fn materialize_static(
        &self,
        key: &str,
        inv: &ProviderInvocation,
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
        // 静态项无 capture; meta 在 self.properties 作用域下渲染
        let provider = self.instantiate_invocation(inv, &[], composed, ctx)?;
        let meta = match inv {
            ProviderInvocation::ByName(b) => self.eval_meta(&b.meta, &[], ctx)?,
            ProviderInvocation::Empty(b) => self.eval_meta(&b.meta, &[], ctx)?,
            ProviderInvocation::ByDelegate(_) => unreachable!("rejected above"),
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
    ) -> Result<Vec<ChildEntry>, EngineError> {
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
                        out.push(child);
                    }
                }
                ListEntry::Dynamic(DynamicListEntry::Sql(e)) => {
                    let mut children = self.list_dynamic_sql(key_template, e, composed, ctx)?;
                    out.append(&mut children);
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(e)) => {
                    let mut children =
                        self.list_dynamic_delegate(key_template, e, composed, ctx)?;
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
                // 7b: 渲染 pattern 中的 ${properties.X} (instance-static)
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
                    // 7b: ByDelegate 在此 inline 处理 — 调 target.resolve(name) 转发解析责任
                    if let ProviderInvocation::ByDelegate(b) = invocation {
                        if dbg {
                            eprintln!(
                                "[pathql]   regex matched ByDelegate; forwarding to {:?}.resolve({:?})",
                                b.delegate.provider, name
                            );
                        }
                        let target = match self.instantiate_call(&b.delegate, ctx).ok().flatten() {
                            Some(t) => t,
                            None => return None,
                        };
                        // target 的 contrib 借给本节点 (与路径自然下走对称)
                        let next_composed = target.apply_query(composed.clone(), ctx);
                        return target.resolve(name, &next_composed, ctx);
                    }
                    return self
                        .instantiate_invocation(invocation, &cap_vec, composed, ctx)
                        .ok()
                        .flatten();
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
                    match self.reverse_lookup_dynamic(name, key_template, dyn_entry, composed, ctx)
                    {
                        Ok(Some(p)) => {
                            if dbg {
                                eprintln!(
                                    "[pathql]   dynamic reverse-lookup matched (key_template={:?})",
                                    key_template
                                );
                            }
                            return Some(p);
                        }
                        Ok(None) => {
                            if dbg {
                                eprintln!(
                                    "[pathql]   dynamic reverse-lookup miss (key_template={:?})",
                                    key_template
                                );
                            }
                        }
                        Err(e) => {
                            if dbg {
                                eprintln!(
                                    "[pathql]   dynamic reverse-lookup ERROR (key_template={:?}): {}",
                                    key_template, e
                                );
                            }
                        }
                    }
                }
            }
        }
        if dbg {
            eprintln!("[pathql]   ← no match, returning None");
        }
        None
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
    fn list(&self, _: &ProviderQuery, _: &ProviderContext) -> Result<Vec<ChildEntry>, EngineError> {
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
