# Phase 6e 详细计划 — `delegate` 路径形态改 ProviderCall（path-unaware provider）

## Context

承接 **Phase 6d 实际完成态**（另一 AI 已完成；executor trait 化 + drivers 删除 + ProviderRuntime executor 强制注入 + dialect 标注 + build_sql dialect 参数 + core template_bridge 下沉）。

### Phase 6e 起因

DSL 当前 `delegate` 字段（在三个位置出现）以**路径**形态写：

```jsonc
// gallery_all_router.json5
"query": { "delegate": "./x100x/1/" }

// gallery_page_router.json5
"query": { "delegate": "./__provider" }

// gallery_paginate_router.json5
"list": {
  "${out.meta.page_num}": {
    "delegate": "./__provider",
    "child_var": "out",
    ...
  }
}
```

这违反 provider 设计原则：**provider 应路径无感**。它只关心"我是谁、我怎么贡献"，不应感知"我在路径树的哪个位置"。把另一个 provider 的引用写成路径，让 provider 作者绑死到父级 segment 命名（一旦上层重命名 segment，下层 delegate 就要改）；引擎也被迫做相对路径解析、绝对路径区分、`current_path` 注入、递归守卫等一连串复杂处理（详见 6c → 6d 之间关于 `resolve_with_initial` 的反复讨论）。

### Phase 6e 目标

把 `delegate` 字段从 `PathExpr` 改为 **`ProviderCall`** 对象 `{ provider: ProviderName, properties: {...} }` —— provider 直接通过 name + properties 引用，不再混路径概念。

```jsonc
// 6e 起 (示意):
"query": {
  "delegate": {
    "provider": "query_page_provider",
    "properties": { "page_size": 100, "page_num": 1 }
  }
}
```

完成后：

1. AST 中所有 `delegate: PathExpr` 字段 → `delegate: ProviderCall`
2. `ProviderInvocation::ByDelegate` variant 整个删除（合并到 `ByName` —— 形态本来就是 `{provider, properties, meta}`）
3. `DslProvider::resolve_delegate` 整个删除（无路径要解析）
4. `ProviderRuntime::resolve_with_initial` 整个删除（无 caller 后死代码）—— 顺便修了 6c 引入的"绕过 LRU"问题
5. validate 加 delegate 环检测（A.delegate→B, B.delegate→A 之类）
6. `__provider` 私有 resolve 间接消失（gallery_page_router / gallery_paginate_router 不再需要这层桥）

### 约束

- 改造 atomic：AST + 3 个 .json5 + DslProvider impl 必须一次切换（中间状态 pathql-rs 集成测试编译破）
- core 端**无任何代码改动**——纯 DSL 数据 + pathql-rs 内部
- 行为零回归：9 个 DSL provider 的解释行为应等价（gallery_all 默认走 100/page 第 1 页等）

---

## DSL 中 `delegate` 字段的三处位置（消歧）

DSL 里 `delegate` 这个**字段名**实际在**三个不同位置**出现，对应**三个不同的 AST 类型**——读本计划时容易混淆，先建立映射：

| 位置 | AST 类型 | 字段路径 | 真 corpus 命中 | 6e 改造 |
|---|---|---|---|---|
| **a** | `Query::Delegate` | `<provider>.query.delegate` | ✅ 2 处（`gallery_all_router` / `gallery_page_router`）| 字段类型 PathExpr → ProviderCall |
| **b** | `DynamicDelegateEntry` | `<provider>.list[<动态 key>].delegate`（key 含 `${X.Y}`）| ✅ 1 处（`gallery_paginate_router`）| 字段类型 PathExpr → ProviderCall |
| **c** | `ProviderInvocation::ByDelegate` | `<provider>.resolve[<key>]` 或 `<provider>.list[<静态 key>]` 直接是 `{delegate: "..."}` 形态 | ❌ 0 命中 | **整个 variant 删除** |

### 三类的语义对比

**a 类（Query::Delegate）**——委托另一 provider 的**贡献**（apply_query 转发）：

```jsonc
// gallery_all_router.json5 当前 (即将改):
"query": { "delegate": "./x100x/1/" }

// 6e 后:
"query": {
    "delegate": {
        "provider": "query_page_provider",
        "properties": { "page_size": 100, "page_num": 1 }
    }
}
```

**b 类（DynamicDelegateEntry）**——动态 list 的**数据源**（调目标的 list_children 拿 children 序列）：

```jsonc
// gallery_paginate_router.json5 当前 (即将改):
"list": {
    "${out.meta.page_num}": {
        "delegate": "./__provider",          // ← b 类 delegate (数据源)
        "child_var": "out",
        "provider": "gallery_page_router",   // ← list 输出层 ChildEntry.provider (跟 delegate 不是一回事)
        "properties": { ... }
    }
}

// 6e 后:
"list": {
    "${out.meta.page_num}": {
        "delegate": {
            "provider": "page_size_provider",
            "properties": { "page_size": "${properties.page_size}" }
        },
        "child_var": "out",
        "provider": "gallery_page_router",
        "properties": { ... }
    }
}
```

注意：b 类**容器**有两个 `provider` 概念——
- `delegate.provider`（数据源 provider，新形态）
- `provider`（list 输出层每个 ChildEntry 挂的 provider）

它们是不同 provider，不要混淆。

**c 类（ProviderInvocation::ByDelegate）**——resolve 表项 / list 静态项里整个 invocation 对象的"按路径形态"——**0 命中**：

```jsonc
// 假想的 c 类用法 (现实没人这么写):
"resolve": {
    "fallback": {
        "delegate": "./fallback_provider"   // ← c 类 (即 ProviderInvocation::ByDelegate)
    }
}
// 或:
"list": {
    "alias": {
        "delegate": "./real_provider"
    }
}
```

c 类的语义本来想表达"resolve 这个名字时实例化目标路径终点的 provider"——和 a/b 类完全不同的场景。

### 为什么 c 类可以**整个 variant 删除**

如果 c 类也按 a/b 同样套路改 ProviderCall 形态：

```jsonc
"resolve": {
    "fallback": {
        "delegate": { "provider": "fallback_provider", "properties": { ... } }
    }
}
```

这和现有的 `ByName` 形态：

```jsonc
"resolve": {
    "fallback": {
        "provider": "fallback_provider",
        "properties": { ... }
    }
}
```

**完全等价**——两个 variant 在 ProviderCall 化后语义重合，保留两个就是冗余 + 增加 schema 歧义（"delegate vs provider 哪种写法对"）。所以 6e **删除 `ProviderInvocation::ByDelegate` variant**，只剩 `ByName + Empty` 二态。

### 为什么 a 和 b 不能合并到 ByName

a 和 b 的 `delegate` 字段在它们各自的容器里（`DelegateQuery` / `DynamicDelegateEntry`）有**特定结构语义**：

- a 类的容器 `DelegateQuery` 与 `ContribQuery` 在 `Query` enum 中互斥（`{delegate}` ⊕ `{from, fields, ...}`）
- b 类的容器 `DynamicDelegateEntry` 与 `DynamicSqlEntry` 在 `DynamicListEntry` enum 中互斥（`{delegate, child_var}` ⊕ `{sql, data_var}`）

它们**不是 ProviderInvocation**——只是用了同名字段引用 provider。所以 a/b 类的字段类型变更（PathExpr → ProviderCall）保留容器不动；与 c 类 variant 删除是两件事。

---

## 锁定的设计选择

### 决策 1：新增 `ProviderCall` AST 类型

```rust
// pathql-rs/src/ast/invocation.rs (或新建 provider_call.rs)

/// 引用另一个 provider, 同 namespace 链解析; 不含 meta 字段 (delegate 目标自身无 meta 概念)。
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCall {
    pub provider: ProviderName,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
}
```

`ProviderCall` 是 `InvokeByName` 的"瘦版"——省掉 `meta` 字段（meta 属于 list entry / static entry 的 ChildEntry 输出层，不属于 delegate 目标）。也可以**复用 `InvokeByName`**（多带一个 `meta: None`），看代码量取舍——见决策 4。

### 决策 2：删除 `ProviderInvocation::ByDelegate` variant

`ProviderInvocation` 现有三态 `ByName / ByDelegate / Empty` 简化为两态 `ByName / Empty`。

```rust
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ProviderInvocation {
    ByName(InvokeByName),
    Empty(EmptyInvocation),
}
```

实测：`ByDelegate` 在 9 个真 .json5 里 **0 命中**（grep 确认）；只在 AST 单测里有 fixture 引用；删除不破坏现实 corpus。

### 决策 3：`Query::Delegate` 与 `DynamicDelegateEntry.delegate` 改 `ProviderCall`

```rust
// query.rs
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DelegateQuery {
    pub delegate: ProviderCall,   // 6e: was PathExpr
}

// list.rs
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicDelegateEntry {
    pub delegate: ProviderCall,   // 6e: was PathExpr
    pub child_var: Identifier,
    #[serde(default)]
    pub provider: Option<DelegateProviderField>,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)]
    pub meta: Option<MetaValue>,
}
```

注：`DynamicDelegateEntry` 现有 `provider` / `properties` / `meta` 三个字段语义不变（控制 list 输出的 ChildEntry 形态）；改的只有 `delegate` 字段语义——从"列举此路径下的 children"变"实例化此 provider 后调它的 list_children"。

### 决策 4：`InvokeByName` 与 `ProviderCall` 的关系

两种处理方式：

- **A. 两个独立类型**：`ProviderCall { provider, properties }`（无 meta，给 delegate 用）+ `InvokeByName { provider, properties, meta }`（有 meta，给 list / resolve 静态项用）
- **B. 复用 `InvokeByName`，`meta` 字段在 delegate 上下文下被静默忽略**：DSL 写 `meta` 也不报错，但 DslProvider 不读取

**选 A**（两个独立类型）—— 类型表达更精确，编译期防止误用；schema 上 delegate 不允许 `meta` 字段（用 `additionalProperties: false`）。代价是多一个 struct + Deserialize 派生，~10 行代码。

### 决策 5：DslProvider apply_query / list_dynamic_delegate 改造

```rust
// apply_query (6e):
Some(Query::Delegate(call)) => {
    let props = self.eval_properties_call(&call, &[])?;
    let target = ctx.registry
        .instantiate(&self.current_namespace(), &call.provider, &props, ctx)
        .ok_or_else(|| EngineError::ProviderNotRegistered(
            self.current_namespace().0.clone(),
            call.provider.0.clone(),
        ))?;
    target.apply_query(current, ctx)
}
```

target.apply_query 自己处理自己的 fold（含可能的嵌套 Delegate）；递归在 trait 派发层自然展开，无需 runtime 介入。

```rust
// list_dynamic_delegate (6e):
fn list_dynamic_delegate(
    &self,
    key_template: &str,
    entry: &DynamicDelegateEntry,
    composed: &ProviderQuery,
    ctx: &ProviderContext,
) -> Result<Vec<ChildEntry>, EngineError> {
    // 实例化 delegate 目标 + apply_query 算出 target_composed
    let call_props = self.eval_properties_call(&entry.delegate, &[])?;
    let target_provider = ctx.registry
        .instantiate(&self.current_namespace(), &entry.delegate.provider, &call_props, ctx)
        .ok_or_else(|| EngineError::ProviderNotRegistered(...))?;
    let target_composed = target_provider.apply_query(composed.clone(), ctx);
    
    // 调 target.list 拿 children
    let target_children = target_provider.list(&target_composed, ctx)?;
    
    // 余下 child_var 注入 + 渲染逻辑保持不变
    // ...
}
```

`resolve_delegate` 函数整个删除——它做的事被两个调用点（apply_query 的 Delegate 分支、list_dynamic_delegate）内联消化。

### 决策 6：`ProviderInvocation::ByDelegate` 调用点删除

`instantiate_invocation` 现在的 ByDelegate 分支：

```rust
ProviderInvocation::ByDelegate(b) => {
    let props = self.eval_properties(&b.properties, captures)?;
    let _ = props;
    let (provider, _) = self.resolve_delegate(&b.delegate.0, composed, ctx)?;
    Ok(Some(provider))
}
```

整个分支删除（variant 不存在了）；现实 .json5 corpus 没有命中此路径，删除安全。

### 决策 7：`ProviderRuntime::resolve_with_initial` 删除

唯一 caller 是 `DslProvider::resolve_delegate`（决策 5 中删除）。`resolve_with_initial` 变死代码，整个删除；`resolve()` 内联前者 body（去掉 `Some(initial)` 分支与 `initial_provided` 缓存跳过逻辑）。

这条**顺便修了 6c 引入的"绕过 LRU"问题**——但语义层不再需要，因为没人传 `Some(_)` 了。

### 决策 8：validate 加 delegate 环检测

新增 [`pathql-rs/src/validate/cycle.rs`](../../src-tauri/pathql-rs/src/validate/cycle.rs)：

```rust
//! Delegate 环检测: 从每个 ProviderDef 出发, DFS 跟踪 delegate 边
//! (Query::Delegate + DynamicDelegateEntry); 命中 back-edge 报 DelegateCycle。

pub(super) fn check_delegate_cycles(
    registry: &ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for def in registry.iter() {
        let mut visited = HashSet::new();
        let mut stack = HashSet::new();
        if let Some(cycle) = dfs_delegate(def, registry, &mut visited, &mut stack) {
            errors.push(ValidateError {
                kind: ValidateErrorKind::DelegateCycle(cycle),
                ..
            });
        }
    }
}

fn dfs_delegate(
    def: &ProviderDef,
    registry: &ProviderRegistry,
    visited: &mut HashSet<String>,
    stack: &mut HashSet<String>,
) -> Option<Vec<String>> {
    let key = format!("{}.{}", def.namespace.as_deref().unwrap_or(""), def.name.0);
    if stack.contains(&key) {
        return Some(vec![key]); // 报告环包含的 provider 名
    }
    if visited.contains(&key) { return None; }
    visited.insert(key.clone());
    stack.insert(key.clone());
    
    // 收集 def.query.delegate + def.list.entries[].dynamic.delegate 的 ProviderCall 目标
    let mut targets = Vec::new();
    if let Some(Query::Delegate(call)) = &def.query {
        targets.push(&call.provider);
    }
    if let Some(list) = &def.list {
        for (_, entry) in &list.entries {
            if let ListEntry::Dynamic(DynamicListEntry::Delegate(d)) = entry {
                targets.push(&d.delegate.provider);
            }
        }
    }
    
    for target_name in targets {
        if let Some(target_def) = registry.lookup_by_name(target_name, def.namespace.as_ref()) {
            if let Some(mut cycle) = dfs_delegate(target_def, registry, visited, stack) {
                cycle.push(key.clone());
                return Some(cycle);
            }
        }
    }
    
    stack.remove(&key);
    None
}
```

新 `ValidateErrorKind` variant：

```rust
pub enum ValidateErrorKind {
    // ... 原有
    DelegateCycle(Vec<String>),  // 环上 provider 全名链 (e.g. ["kabegame.A", "kabegame.B", "kabegame.A"])
}
```

环检测仅在 `cross_ref` 启用时跑（默认 off；core 启用 cross_ref + cycle 防冷启动 panic）。

---

## Commit checkpoint 策略

6e 是个**小型语义改造**，但 AST 改 → 强制 .json5 + 实现 + 校验同步切换。建议 4 个 checkpoint：

```
┌────────────────────────────────────────────────────────────┐
│ Stage A (atomic flip)                                      │
│   S1  AST: ProviderCall + 删 ByDelegate variant +          │
│       Query::Delegate / DynamicDelegateEntry 字段类型变更 │
│       + 9 个 .json5 (3 个文件) 同步迁移 + DslProvider 改造 │
│       + ProviderRuntime::resolve_with_initial 删除          │
│       一次性 commit (中间状态 pathql-rs 测试 broken)        │
├────────────────────────────────────────────────────────────┤
│ Stage B (compile-clean)                                    │
│   S2  schema.json5 同步 (描述层, 不影响编译)                │
│   S3  validate: cross_ref + dynamic + 新增 cycle 检测       │
│   S4  RULES.md 修订 + 全套验证 (cargo test + bun check +    │
│       手测 dev server 主路径不回归)                         │
└────────────────────────────────────────────────────────────┘
```

S1 是大原子 commit；S2-S4 是小后续 commit。

---

## 子任务拆解

### S1. AST 形态切换 + 9 .json5 迁移 + DslProvider 改造（atomic flip）

#### S1a. AST：新增 `ProviderCall` + 删 `ByDelegate`

新建或修改 [`pathql-rs/src/ast/invocation.rs`](../../src-tauri/pathql-rs/src/ast/invocation.rs):

```rust
// 新增:
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCall {
    pub provider: ProviderName,
    #[serde(default)]
    pub properties: Option<HashMap<String, TemplateValue>>,
}

// 删除:
- pub struct InvokeByDelegate { ... }

// 改:
pub enum ProviderInvocation {
    ByName(InvokeByName),
-   ByDelegate(InvokeByDelegate),
    Empty(EmptyInvocation),
}
```

修改 [`query.rs`](../../src-tauri/pathql-rs/src/ast/query.rs):

```rust
pub struct DelegateQuery {
-   pub delegate: PathExpr,
+   pub delegate: ProviderCall,
}
```

修改 [`list.rs`](../../src-tauri/pathql-rs/src/ast/list.rs):

```rust
pub struct DynamicDelegateEntry {
-   pub delegate: PathExpr,
+   pub delegate: ProviderCall,
    pub child_var: Identifier,
    // ... 其余字段不变
}
```

#### S1b. AST 测试 fixture 全量更新

`invocation.rs` 测试模块：
- 删除 `by_delegate_simple` / `provider_and_delegate_rejected` 等针对 ByDelegate 的测试
- 新增 `provider_call_simple` / `provider_call_with_properties` 等

`list.rs` 测试模块：
- `dynamic_delegate_entry`: payload 改 `{"${out.name}":{"delegate":{"provider":"foo"},"child_var":"out"}}`
- `mixed_static_and_dynamic_preserves_order`: 同步更新
- `dynamic_with_provider_child_ref`: 同步

`query.rs` 测试模块：
- `delegate_form`: payload 改 `{"delegate":{"provider":"foo"}}`
- `delegate_with_extra_field_rejected`: payload 改 `{"delegate":{"provider":"foo"},"limit":0}`

`resolve.rs` 测试 `by_delegate_value` 删除（或改为 ByName 形态）。

#### S1c. 9 个 .json5 文件迁移

**`dsl/gallery/gallery_all_router.json5`**：

```diff
- "query": { "delegate": "./x100x/1/" },
+ "query": {
+     "delegate": {
+         "provider": "query_page_provider",
+         "properties": { "page_size": 100, "page_num": 1 }
+     }
+ },
```

`resolve` 表的 `x([1-9][0-9]*)x` 项保持不变（已是 ByName 形态，不受影响）。

**`dsl/gallery/gallery_page_router.json5`**：

```diff
  "query": {
-     "delegate": "./__provider"
+     "delegate": {
+         "provider": "query_page_provider",
+         "properties": {
+             "page_size": "${properties.page_size}",
+             "page_num":  "${properties.page_num}"
+         }
+     }
  },

- "resolve": {
-     "__provider": {
-         "provider": "query_page_provider",
-         "properties": { ... }
-     }
- }
```

整个 `resolve.__provider` 私有间接被消除——delegate 直接命中 query_page_provider，不需要中间桥。

**`dsl/gallery/gallery_paginate_router.json5`**：

```diff
  "list": {
      "${out.meta.page_num}": {
-         "delegate": "./__provider",
+         "delegate": {
+             "provider": "page_size_provider",
+             "properties": { "page_size": "${properties.page_size}" }
+         },
          "child_var": "out",
          "provider": "gallery_page_router",
          "properties": {
              "page_size": "${properties.page_size}",
              "page_num":  "${out.meta.page_num}"
          }
      }
  },

- "resolve": {
-     "__provider": {
-         "provider": "page_size_provider",
-         "properties": { "page_size": "${properties.page_size}" }
-     }
- }
```

同样消除 `__provider` 桥。

#### S1d. DslProvider 改造

修改 [`dsl_provider.rs`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs):

```rust
// 删除整个 fn resolve_delegate(...) { ... }

// 修改 apply_query Query::Delegate 分支:
Some(Query::Delegate(call)) => {
    let props = self.eval_properties_call(call, &[]).unwrap_or_default();
    let target = ctx.registry
        .instantiate(&self.current_namespace(), &call.provider, &props, ctx);
    match target {
        Some(t) => t.apply_query(current, ctx),
        None => current,  // 目标 provider 未注册 → 静默退回 (validate 期 cross_ref 应已捕获)
    }
}

// 修改 list_dynamic_delegate:
fn list_dynamic_delegate(
    &self,
    key_template: &str,
    entry: &DynamicDelegateEntry,
    composed: &ProviderQuery,
    ctx: &ProviderContext,
) -> Result<Vec<ChildEntry>, EngineError> {
    let call_props = self.eval_properties_call(&entry.delegate, &[])?;
    let target = ctx.registry
        .instantiate(&self.current_namespace(), &entry.delegate.provider, &call_props, ctx)
        .ok_or_else(|| EngineError::ProviderNotRegistered(
            self.current_namespace().0.clone(),
            entry.delegate.provider.0.clone(),
        ))?;
    let target_composed = target.apply_query(composed.clone(), ctx);
    let target_children = target.list(&target_composed, ctx)?;
    
    // 后续 child_var 注入 + key/properties/meta 渲染逻辑保持不变
    // ...
}

// 修改 instantiate_invocation: ByDelegate 分支整个删除
ProviderInvocation::ByName(b) => { ... }
- ProviderInvocation::ByDelegate(b) => { ... }
ProviderInvocation::Empty(_) => { ... }
```

新 helper：

```rust
fn eval_properties_call(
    &self,
    call: &ProviderCall,
    captures: &[String],
) -> Result<HashMap<String, TemplateValue>, EngineError> {
    self.eval_properties(&call.properties, captures)
}
```

或直接调原 `eval_properties` 传 `&call.properties` —— 看代码风格。

#### S1e. `ProviderRuntime::resolve_with_initial` 删除

[`runtime.rs`](../../src-tauri/pathql-rs/src/provider/runtime.rs):

```rust
- pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
-     self.resolve_with_initial(path, None)
- }
- pub fn resolve_with_initial(
-     &self,
-     path: &str,
-     initial: Option<ProviderQuery>,
- ) -> Result<ResolvedNode, EngineError> {
-     // ... 原 body 含 Some(q) cold-start 分支
- }

+ pub fn resolve(&self, path: &str) -> Result<ResolvedNode, EngineError> {
+     let segments = self.normalize_path(path);
+     let ctx = self.make_ctx();
+     
+     let (start_idx, mut current, mut composed) =
+         self.find_longest_cached_prefix(&segments, &ctx);
+     
+     if start_idx == segments.len() {
+         return Ok(ResolvedNode { provider: current, composed });
+     }
+     
+     let mut path_so_far = build_path_key(&segments[..start_idx]);
+     for seg in &segments[start_idx..] {
+         path_so_far.push('/');
+         path_so_far.push_str(seg);
+         let next = current
+             .resolve(seg, &composed, &ctx)
+             .ok_or_else(|| EngineError::PathNotFound(path_so_far.clone()))?;
+         composed = next.apply_query(composed, &ctx);
+         current = next;
+         if !current.is_empty() {
+             self.cache.lock().unwrap().insert(
+                 path_so_far.clone(),
+                 CachedNode {
+                     provider: current.clone(),
+                     composed: composed.clone(),
+                 },
+             );
+         }
+     }
+     
+     Ok(ResolvedNode { provider: current, composed })
+ }
```

`initial_provided` 标志、`Some(q)` 分支、对应注释一并删除。

#### S1f. DslProvider / pathql-rs 测试更新

- `dsl_provider.rs` 测试：所有 fixture 中 `Query::Delegate(...)` / `DynamicDelegateEntry { delegate: PathExpr(...) }` 改 `ProviderCall` 形态
- `tests/dsl_dynamic_sqlite.rs` / `tests/dsl_full_chain_sqlite.rs`：DSL fixture 同步迁移
- `tests/load_real_providers.rs`：3 个真 .json5 已 S1c 迁移；测试自动消化（仅断言"加载成功"）

**Test (S1)**：
- `cargo test -p pathql-rs --features "json5 validate"` 全绿
- 端到端集成测试全绿
- 9 个真 .json5 加载成功，3 个迁移过的文件被新 AST 接受

**Commit message**：
```
refactor(phase6e/S1): delegate is ProviderCall, not PathExpr

DSL `delegate` field at three sites (Query::Delegate /
ProviderInvocation::ByDelegate / DynamicDelegateEntry.delegate) used to
hold PathExpr. This forced provider authors to encode references to
other providers as parent-relative paths, breaking the path-unaware
provider design principle: providers should know "what I am and what I
contribute", never "where I sit in the path tree".

Atomic switch:
- AST: new ProviderCall { provider: ProviderName, properties? }; deletes
  InvokeByDelegate variant; Query::Delegate.delegate and
  DynamicDelegateEntry.delegate now ProviderCall
- 3 .json5 files migrated:
  - gallery_all_router: query.delegate → query_page_provider {100, 1}
  - gallery_page_router: collapses __provider indirection; delegate
    directly references query_page_provider with template properties
  - gallery_paginate_router: list dynamic delegate references
    page_size_provider directly; __provider private resolve eliminated
- DslProvider: resolve_delegate() removed; apply_query/list_dynamic_
  delegate now construct target via registry.instantiate +
  call target.apply_query / target.list directly
- ProviderRuntime::resolve_with_initial removed (sole caller was
  resolve_delegate; now dead code). Fixes cache-bypass bug from 6c.
- ProviderInvocation::ByDelegate variant deleted (zero hits in real
  .json5 corpus; only AST tests referenced it).

Compile state: pathql-rs main + tests CLEAN; core unchanged
(no public API on this surface; DSL files are core's own data).

Files: pathql-rs/src/ast/{invocation, query, list}.rs (+ tests),
       pathql-rs/src/provider/{dsl_provider, runtime}.rs (+ tests),
       core/src/providers/dsl/gallery/{gallery_all_router,
       gallery_page_router, gallery_paginate_router}.json5
```

---

### S2. schema.json5 同步

修改 [`core/src/providers/dsl/schema.json5`](../../src-tauri/core/src/providers/dsl/schema.json5)：

#### S2a. `DelegateQuery` 定义

```diff
  "DelegateQuery": {
      "type": "object",
      "additionalProperties": false,
      "required": ["delegate"],
      "properties": {
-         "delegate": { "$ref": "#/definitions/PathExpr" }
+         "delegate": { "$ref": "#/definitions/ProviderCall" }
      },
-     "description": "路径重定向 — 行为完全转发到目标路径"
+     "description": "委托另一个 provider 的贡献 — 实例化目标 provider 后调它的 apply_query"
  },
```

#### S2b. `DynamicListEntry_Delegate` 定义

```diff
  "DynamicListEntry_Delegate": {
      ...
      "properties": {
          "delegate": {
-             "$ref": "#/definitions/PathExpr",
-             "description": "数据源路径; 调目标的 list_children, 每个 child = 一项..."
+             "$ref": "#/definitions/ProviderCall",
+             "description": "数据源 provider; 实例化后调它的 list_children, 每个 child = 一项..."
          },
          ...
      }
  },
```

#### S2c. `ProviderInvocation` 定义

```diff
  "ProviderInvocation": {
      "oneOf": [
          { "$ref": "#/definitions/InvokeByName" },
-         { "$ref": "#/definitions/InvokeByDelegate" },
          { "$ref": "#/definitions/EmptyInvocation" }
      ],
-     "description": "三态: InvokeByName ⊕ InvokeByDelegate ⊕ Empty(占位)..."
+     "description": "二态: InvokeByName ⊕ Empty(占位)..."
  },

- "InvokeByDelegate": { ... },   ← 整个定义删除
```

#### S2d. 新增 `ProviderCall` 定义

```jsonc
"ProviderCall": {
    "type": "object",
    "additionalProperties": false,
    "required": ["provider"],
    "properties": {
        "provider": { "$ref": "#/definitions/ProviderName" },
        "properties": {
            "type": "object",
            "additionalProperties": { "$ref": "#/definitions/TemplateValue" }
        }
    },
    "description": "对另一个 provider 的引用 (含 properties); 用于 query.delegate / DynamicListEntry_Delegate.delegate"
}
```

**Test (S2)**：纯描述层，不影响编译；`cargo test -p pathql-rs --features json5` 仍全绿（schema 不在 Rust 代码路径上）。

**Commit message**：
```
chore(phase6e/S2): align schema.json5 with ProviderCall AST

Updates DelegateQuery.delegate and DynamicListEntry_Delegate.delegate to
reference new ProviderCall definition; deletes InvokeByDelegate type and
its entry in ProviderInvocation.oneOf.

Pure descriptive change — schema.json5 is documentation for editors;
no Rust code path consumes it directly.
```

---

### S3. validate 改造 + 新增 cycle 检测

#### S3a. `dynamic.rs` 中的 delegate 模板 scope 校验

修改 [`pathql-rs/src/validate/dynamic.rs`](../../src-tauri/pathql-rs/src/validate/dynamic.rs)：原校验是把 `delegate` 字符串当模板检查 `${child_var.X}` scope；6e 起 delegate 是 ProviderCall（非模板字符串），相关校验改为：

- 校验 `ProviderCall.provider` 是已知 provider 名（cross_ref 启用时）
- 校验 `ProviderCall.properties` 各值的模板 scope（child_var / data_var 等）
- 删除"delegate as path scope"分支

#### S3b. `cross_ref.rs` 收集 delegate 引用

新形态下 delegate 直接是 `ProviderName` —— cross_ref 收集很直接：

```rust
fn collect_provider_refs(def: &ProviderDef, refs: &mut Vec<(SourceLoc, ProviderName)>) {
    // 原: 收集 InvokeByName.provider; 收集 PathExpr 内 ${ref:X} 自动分配
    // 6e 新增:
    if let Some(Query::Delegate(call)) = &def.query {
        refs.push((..., call.provider.clone()));
    }
    if let Some(list) = &def.list {
        for (_, entry) in &list.entries {
            if let ListEntry::Dynamic(DynamicListEntry::Delegate(d)) = entry {
                refs.push((..., d.delegate.provider.clone()));
            }
        }
    }
}
```

#### S3c. 新增 `cycle.rs` delegate 环检测

新建 [`pathql-rs/src/validate/cycle.rs`](../../src-tauri/pathql-rs/src/validate/cycle.rs)（决策 8 实现）。

新 `ValidateErrorKind::DelegateCycle(Vec<String>)`；error 链如 `["kabegame.A → kabegame.B → kabegame.A"]`。

`mod.rs` 加 `mod cycle;`，`validate(...)` 调用入口加 `cycle::check_delegate_cycles(...)`（仅 cross_ref 启用时）。

#### S3d. validate 测试

- `validate_bad_fixtures.rs` 增 fixture：A.delegate→B, B.delegate→A → 期望 DelegateCycle
- `validate_bad_fixtures.rs` 增 fixture：A.delegate→A 自指 → 期望 DelegateCycle
- 已有 fixture 中如有 `delegate: "./..."` 路径形态写法 → 改为 ProviderCall 形态

**Test (S3)**：`cargo test -p pathql-rs --features "json5 validate"` 全绿（含新 fixture）。

**Commit message**：
```
feat(phase6e/S3): validate cycle detection + cross_ref for ProviderCall

- Renames delegate-template scope check (validate/dynamic.rs) to
  delegate-properties scope check; ProviderCall.properties is the new
  template surface (delegate target itself is a name, not template)
- cross_ref (validate/cross_ref.rs) collects Query::Delegate.provider
  and DynamicDelegateEntry.delegate.provider as outgoing refs
- NEW: validate/cycle.rs — DFS over delegate graph, reports
  ValidateErrorKind::DelegateCycle(chain). Runs only when
  cfg.cross_refs_enabled (avoids cold-start panics on partial registries).
- Bad fixtures: direct self-cycle, two-node cycle, both verified.

Files: pathql-rs/src/validate/{dynamic, cross_ref, mod, cycle}.rs (+ tests)
       pathql-rs/tests/validate_bad_fixtures.rs
```

---

### S4. RULES.md 修订 + 全套验证

#### S4a. RULES.md 修订

修改 [`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md):

- §3 `query.delegate` 描述：从"路径重定向"改"委托另一 provider 的贡献"；语法示例从 `"./X"` 改 `{provider, properties}`
- §3 `list[].delegate` 描述：同上
- §6 模板上下文章节：`delegate` 不再含 `${...}`；移除"delegate 路径模板"小节
- §7 解析顺序章节：删除"绝对路径 vs 相对路径"提及；delegate 是 provider name 引用
- §10 校验章节：新增 "delegate cycle detection" 条目
- §12 抽象接口章节：检查"路径"语义描述无误；provider 永远 path-unaware

#### S4b. 全套验证

```bash
cargo test -p pathql-rs --features "json5 validate"
cargo test -p kabegame-core
bun check -c main --skip vue
bun dev -c main --data prod
# 浏览 /gallery/all/x100x/1/ → 列图正常
# 浏览 /gallery/all → 应自动等价 100/page 第 1 页 (delegate 命中 query_page_provider)
# 浏览 /gallery/all/x500x/2/ → 翻页正常
# 浏览 /vd/i18n-zh_CN/ → 列子目录
```

⚠️ 重点验证：
- `/gallery/all` 路径访问：query.delegate 现在直接引用 query_page_provider；composed 应包含 page_size=100, page_num=1 的 OFFSET/LIMIT
- `/gallery/all/x100x/` 路径：list 通过 page_size_provider 跑动态 SQL 输出页号；children 形态不变
- DSL 加载期 cycle check：当前 9 个 .json5 应 0 cycle

#### S4c. memory 更新

更新 [`project_dsl_architecture.md`](C:/Users/Lenovo/.claude/projects/d--Codes-kabegame/memory/project_dsl_architecture.md) 加决策 4：

```
**决策 4：delegate 是 ProviderCall (6e 起), 不是 path**

DSL 中 delegate 字段在三处出现 (Query::Delegate / DynamicDelegateEntry.delegate)
均为 ProviderCall 对象 {provider, properties}, 不是 PathExpr。

**Why:** Provider 设计原则是 path-unaware — provider 应只关心"我是谁、我怎么贡献",
不应感知"我在路径树的哪个位置"。把另一个 provider 的引用写成路径让作者绑死到父级
segment 命名 + 让引擎做相对/绝对路径解析 + current_path 注入 + 递归守卫等一连串复杂处理.

**How to apply:**
- 6e 起 ProviderInvocation 二态: ByName + Empty (ByDelegate 删除)
- query.delegate / list dynamic delegate 直接以 ProviderName + properties 引用目标
- DslProvider.resolve_delegate 不存在; ProviderRuntime.resolve_with_initial 不存在
- validate 加 delegate 环检测 (cross_ref 启用时)
- __provider 私有 resolve 间接消失 (gallery_page_router / gallery_paginate_router 不再需要桥)
```

**Test (S4)**：手测 + memory 更新。

**Commit message**：
```
docs(phase6e/S4): update RULES.md + memory for ProviderCall delegate

- RULES.md §3, §6, §7, §10, §12 reflect new ProviderCall semantics
- Removes "path-relative" / "absolute vs relative delegate" sections;
  delegate is now a provider name reference, never a path
- Memory project_dsl_architecture: adds decision 4 (delegate = ProviderCall)

Phase 6e complete; verified via dev server browse of /gallery/all/x100x/{1,2}/
and /gallery/all (default to 100/page page 1 via delegate).
```

---

## 完成标准

- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿
- [ ] `cargo test -p kabegame-core` 全绿（行为零回归）
- [ ] `bun check -c main --skip vue` 通过
- [ ] 全工程 `ProviderInvocation::ByDelegate` / `InvokeByDelegate` / `resolve_delegate` / `resolve_with_initial` 引用 0
- [ ] 9 个真 .json5 加载 + validate 通过；3 个迁移过的文件用新 ProviderCall 形态
- [ ] `__provider` 私有 resolve 在迁移过的 .json5 中 0 残留
- [ ] validate 加 cycle 检测；自指 / 二节点环都被捕获
- [ ] schema.json5 同步：`InvokeByDelegate` 定义删除；`ProviderCall` 定义新增
- [ ] RULES.md 修订完成；§3/§6/§7/§10/§12 反映 ProviderCall 语义
- [ ] memory `project_dsl_architecture.md` 加决策 4
- [ ] 手测 dev server 浏览 `/gallery/all/`、`/gallery/all/x100x/{1,2}/`、`/vd/i18n-zh_CN/` 行为正常

## 风险点

1. **`__provider` 私有 resolve 删除的副作用**：3 个 .json5 文件中的 `resolve.__provider` 项删除后，原本可能通过 `/.../__provider/` 直接访问的路径不再存在。**实测** core 中无此用法（`__provider` 是私有间接桥），但应 grep 前端 / IPC 一遍：
   ```bash
   grep -rn "__provider" src-tauri/ apps/ packages/ 2>&1
   ```
   预期 0 命中（除 docs / .json5 内部）。

2. **validate cycle 检测开销**：每个 ProviderDef 跑一次 DFS，时间 O(V·E)；9 个 provider × 平均 1-2 个 delegate 边 = 微秒级。可接受。

3. **delegate 环的运行期表现**：若 validate 期错过（cross_ref off）or 程序化注册导致 cycle，运行期会 stack overflow（DslProvider.apply_query 无限递归）。**缓解**：core 启用 cross_ref；DslProvider.apply_query 加 depth limit 兜底（如 32 层），命中报 `EngineError::DelegateRecursion(depth)`。本期是否实现 depth limit 取决于工作量；建议**作为 6e 收尾项**加。

4. **`Query::Delegate` 无 `meta` 字段**：决策 4 用独立 `ProviderCall` 类型（无 meta），如果未来要在 delegate 上加 meta，需要扩 ProviderCall。当前 9 个 .json5 没此需求。

5. **AST `ProviderName` 是否区分命名空间**：当前 `ProviderName` 是 simple name；跨 namespace 引用如 `"other_ns.foo"` 是字符串约定。`ProviderCall` 与 `InvokeByName` 行为一致，沿用现有约定。

6. **`DelegateProviderField` 字段意义**：`DynamicDelegateEntry.provider` 控制 list 输出的 ChildEntry 形态（不是 delegate 目标）。这跟新加的 `delegate: ProviderCall.provider` 是**两个不同的 provider**——前者是输出层（每个 child 挂什么 provider），后者是输入层（数据来源 provider）。RULES.md 应明确这两者的语义区分。

---

## 完成 6e 后的下一步

进入 **Phase 7+** —— 6d/6e 已为后续设计奠基：

- **dangling DSL provider 补全**：补 17+ 个 .json5（gallery_albums_router / gallery_dates_router / vd_albums_provider 等）
- **typed-meta wire 验证**：6c S5bis-c 已建测试 baseline，Phase 7 typed meta DSL 实施时复用
- **per-child total 计算**：决定是否给 Dir entry 加 total
- **非 SQL executor 抽象**：Phase 7 接 VD `按画册 / 按插件` 等非 SQL 数据源时引入 `ResourceExecutor`
- **sync/async feature 切换 trait 签名 + 内置 sqlx_executor feature**：6d 已为这条留位置
- **多方言完整支持**：6d 已落 Sqlite，Postgres / Mysql 完整覆盖
