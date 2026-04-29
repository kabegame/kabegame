# Phase 7b 详细计划 — `resolve.delegate` 对称化补全 + Gallery 滤镜 17 个 provider 大迁移

## Context

承接 **Phase 7a 完成态**：
- `vd_en_US_root_router.json5` 解 dangling
- `Storage::open` 注册 `get_plugin(plugin_id [, locale]) -> JSON_TEXT`
- pilot 迁移：`sort_provider`（Contrib）+ `gallery_search_router`（router 壳）
- `parity_helper` 测试框架就位

### Phase 7b 起因 + 双目标

**目标 1**：补回 6e 误删的 `ProviderInvocation::ByDelegate` 形态——但**语义重新设计**为 path-unaware + 对称。

6e 把 `ByDelegate` 整 variant 删掉，论证是"PathExpr → ProviderCall 后形态重合于 ByName"；这个论证只看了**结构**没看**操作语义**：

| 形态 | 操作 | 结果 |
|---|---|---|
| `ByName({X})` | 构造 X | X 自己是 resolve 结果 |
| `ByDelegate({X})` | 构造 X，**调 X.resolve(name)** | X 给出的内层 provider 是 resolve 结果 |

观察：DSL 三处 `delegate` 字段是**对称的**——

```
query.delegate    → target.apply_query
list[].delegate   → target.list
resolve[].delegate → target.resolve   ← 6e 误删, 7b 补回
```

每个 delegate 都"调用其上下文对应的操作并转发"。这套对称设计让 6e 的"path-unaware"原则保留，同时把"通过中介找内层 provider"的能力还回来。

**目标 2**：迁移 17 个 gallery 滤镜 programmatic provider 到 DSL。其中 [`gallery_hide_router`](../../src-tauri/core/src/providers/programmatic/gallery_filters.rs) 的实现就是经典的 "resolve.delegate" 模式（"name 转给 gallery_route.resolve(name)"），是新特性的天然 pilot。

### 约束

- `ByDelegate` 复活只在 `Resolve` 表项 / 静态 list 项里（`ProviderInvocation` 形态）；不影响 `query.delegate` / `list[动态].delegate`（它们已经是各自的 ProviderCall 形态）
- 17 个 gallery 滤镜迁移走 7a 的 parity_helper 验证；每个 provider 一个 commit
- `programmatic/gallery_filters.rs` 等文件不删（推 7d 整体清退 programmatic 模块）；只注释相应 register 调用 + 跳过

---

## 锁定的设计选择

### 决策 1：恢复 `ProviderInvocation::ByDelegate` variant，payload 用 ProviderCall

```rust
// pathql-rs/src/ast/invocation.rs

pub struct InvokeByDelegate {
    pub delegate: ProviderCall,           // {provider, properties}
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

pub enum ProviderInvocation {
    ByName(InvokeByName),
    ByDelegate(InvokeByDelegate),         // 7b 补回
    Empty(EmptyInvocation),
}
```

**与 6e 之前的旧 ByDelegate 区别**：payload 从 `PathExpr`（路径字符串）改 `ProviderCall`（provider 名 + properties）。Provider 仍 path-unaware。

### 决策 2：`ByDelegate` 在 Resolve 表里的运行期语义

```rust
// DslProvider::resolve(name, composed, ctx) 内部，匹配到正则后:
ProviderInvocation::ByDelegate(b) => {
    // 1. 实例化 target
    let target = ctx.registry.instantiate(
        &self.current_namespace(),
        &b.delegate.provider,
        &eval_properties(&b.delegate.properties, captures)?,
        ctx,
    )?;
    // 2. apply_query 让 target 的 contrib 进入 composed (与路径自然下走一致)
    let next_composed = target.apply_query(composed.clone(), ctx);
    // 3. 调 target.resolve(name, ...) 取内层 provider —— 这是 ByDelegate 的核心
    target.resolve(name, &next_composed, ctx)
}
```

**关键**：`name` 是当前正则匹配的 segment 字面值（不是 capture 组）。target.resolve 自己再决定怎么处理这个 name——可能命中其 list、可能匹配其 resolve regex、可能动态反查、或返回 None。**这就是"调用 resolve 转发"**。

### 决策 3：`ByDelegate` 不在静态 list 项里支持

`list` 表的静态项（key 不含 `${X.Y}`）传统上是"挂一个 provider 在这个 segment"。如果允许 ByDelegate，语义会很怪——list 项需要返回 ChildEntry，ChildEntry.provider 是直接构造还是调 target.resolve(key)？

**简化**：静态 list 项**只允许 ByName / Empty**，不允许 ByDelegate（schema 层强制）。ByDelegate 只在 Resolve 表里有意义。

### 决策 4：schema.json5 反映新形态

```jsonc
"InvokeByDelegate": {
    "type": "object",
    "additionalProperties": false,
    "required": ["delegate"],
    "not": { "required": ["provider"] },
    "properties": {
        "delegate": { "$ref": "#/definitions/ProviderCall" },
        "meta": { "$ref": "#/definitions/MetaValue" }
    }
},

"ProviderInvocation": {
    "oneOf": [
        { "$ref": "#/definitions/InvokeByName" },
        { "$ref": "#/definitions/InvokeByDelegate" },
        { "$ref": "#/definitions/EmptyInvocation" }
    ]
}
```

但 `Resolve` 表 vs `List 静态项` 的 schema 区分（决策 3）—— 写 `oneOf` 限制：`Resolve` 接受三态、`List 静态项` 只接 ByName + Empty。

实施时 schema 用 conditional types 表达。Rust AST 层可用同一 enum，运行期校验"静态 list 项不允许 ByDelegate"。

### 决策 5：validate 阶段加"resolve.delegate target 必须支持 resolve"检查

```
fn check_resolve_delegate(...) {
    for each ProviderInvocation::ByDelegate in resolve table:
        target = lookup(b.delegate.provider)
        if target is DSL ProviderDef:
            // 检查 target 的 resolve 表 / list 至少一项不是空——target 总能用 resolve 做点事
            if target.resolve.is_none() && target.list.is_none() {
                error("resolve.delegate target must have non-empty resolve/list table")
            }
        // 注: programmatic 项只在 cross_ref 关闭时跳过——它们的 fn resolve 行为
        //    不可静态推断, 加载期允许 trust.
}
```

可选；推迟到 validate cycle check 一起增强。

### 决策 6：`gallery_all_desc_router.json5` 用新特性简化

旧版（Phase 7a 调试期手写）：

```jsonc
{
    "name": "gallery_all_desc_router",
    "query": { "order": { "all": "revert" } },
    "resolve": {
        "x([1-9][0-9]*)x": { "provider": "gallery_paginate_router", "properties": {...} },
        "([1-9][0-9]*)": { "provider": "gallery_page_router", "properties": {...} }
    }
}
```

7b 后简化为：

```jsonc
{
    "name": "gallery_all_desc_router",
    "query": { "order": { "all": "revert" } },
    "resolve": {
        ".*": { "delegate": { "provider": "gallery_all_router" } }
    }
}
```

含义：任何 segment 我都不自己解决——把 name 转给 `gallery_all_router.resolve(name, ...)`。沿途 gallery_all_router 的 `query.order: asc` 会贡献到 composed（被 desc_router 的 `revert` 翻转）。`gallery_all_router` 的 resolve regex（xNx + 裸数字）继续工作。

**收益**：删掉 desc_router 里复制粘贴的 6 行 resolve regex；语义对称简洁；将来 gallery_all_router 的 resolve 表更新自动反映到 desc 路径。

---

## Commit checkpoint 策略

```
┌────────────────────────────────────────────────────────────┐
│ Stage A — 引擎基础设施 (3 件互相独立的扩展)                  │
│   S1a 删除 validate 里的 regex 碰撞检测 (与 .* 转发 +       │
│       template-keyed list 模式根本冲突, false positive)     │
│   S1b 支持 list / resolve key 用 ${properties.X} 模板形态   │
│       (key 是 instance-static, 编译期未定; 不是 data_var/   │
│       child_var dynamic)                                    │
│   S2  AST: InvokeByDelegate variant 复活 + ProviderCall    │
│       payload + List 静态项拒绝 ByDelegate (运行期检查)     │
│   S3  DslProvider::resolve impl: ByDelegate 分支调          │
│       target.resolve(name, ...); schema.json5 + RULES.md    │
│       同步; validate cross_ref + cycle 覆盖 ByDelegate      │
├────────────────────────────────────────────────────────────┤
│ Stage B — pilot: gallery_hide_router 迁移 (新特性原型机)    │
│   S4  gallery_hide_router.json5 — 验证 resolve.delegate    │
│       走通; 简化 gallery_all_desc_router 用新形态           │
├────────────────────────────────────────────────────────────┤
│ Stage C — 17 个 gallery 滤镜大迁移                          │
│   S5  albums + album_entry                                 │
│   S6  plugins + plugin_entry (用 7a get_plugin)            │
│   S7  tasks + task_entry                                   │
│   S8  surfs + surf_entry                                   │
│   S9  media_type + media_type_entry                        │
│   S10 wallpaper_order                                      │
│   S11 date_range + date_range_entry                        │
│   S12 search_display_name 三件套 (7a pilot 收尾)            │
├────────────────────────────────────────────────────────────┤
│ Stage D — 收尾                                              │
│   S13 跑 parity_helper 全套; bun check; 手测; memory 更新   │
└────────────────────────────────────────────────────────────┘
```

每个迁移 commit 必须：
1. 加 .json5 文件
2. 把文件加进 `dsl_loader.rs::DSL_FILES` 数组（Phase 7-overview 设计原则 3）
3. 注释掉 `programmatic/mod.rs` 对应 `register(...)` 调用
4. 加 parity case 测试（programmatic vs DSL 对比）
5. 行为零回归手测

---

## 子任务拆解

### S1a. 删除 validate 里的 regex 碰撞检测

**问题**：validate 当前对 Resolve 表项跑两层碰撞检查（详见 [`pathql-rs/src/validate/`](../../src-tauri/pathql-rs/src/validate/)）：

1. **regex 字面 vs list 静态 key 字面**：任一 regex 能匹配某个 list key → 拒绝
2. **regex vs regex 交集**：用 regex_automata 求 NFA intersection，非空 → 拒绝

7b 引入两类**正常合法**的模式让这些检查全是 false positive：

| 合法模式 | 触发碰撞检查 | 实际是否冲突 |
|---|---|---|
| `resolve: { ".*": { delegate: gallery_route } }` + `list: { "desc": ... }` | "desc" 被 `.*` 匹配 → 拒绝 | **不是**：runtime 解析顺序是 list 静态 → resolve regex → 动态反查；`.*` 只对 list 没命中的 segment 生效 |
| `list: { "${properties.lang}": ... }` + `list: { "java": ... }` | template-keyed key 实际值取决于 properties，validate 期未知 | **可能**也可能不（取决于实例化时 properties.lang），validate 决定不了 |
| `resolve: { "x([1-9][0-9]*)x": ... }` + `resolve: { "([1-9][0-9]*)": ... }` | regex_automata 可能误判（含字符类的 regex 求交集出错） | **不是**：disjoint（一个必须 `x` 前缀） |

**修复**：**完全移除碰撞检查**。Runtime 的解析顺序是稳定 deterministic 的（list 静态 → resolve regex → 动态反查；多个 regex 按 schema 出现顺序）；冲突由作者自负责任，validate 不再插手。

#### S1a 修改清单

[`pathql-rs/src/validate/`](../../src-tauri/pathql-rs/src/validate/) 找当前实现碰撞检查的文件（可能是 `cross_resolve.rs` / `dynamic.rs` / 在 `mod.rs` 里集成）：

```bash
grep -rn "regex.*intersect\|RegexCollision\|collide\|key_collision" pathql-rs/src/validate/
```

把对应函数 + ValidateErrorKind variant + 测试 fixture 一并删除。`Cargo.toml` 如果只为这个特性引入 `regex-automata`，可以一并去依赖（其他 validate 模块如不依赖则删；如有依赖保留）。

#### S1a 配套 schema.json5 修改

[`core/src/providers/dsl/schema.json5`](../../src-tauri/core/src/providers/dsl/schema.json5):

- `Resolve` 描述中删除"加载期碰撞检查"段落（详细描述了 regex vs 静态 / regex vs regex 的拒绝规则——7b 后这些不再适用）
- 改为说明"运行期解析顺序: static list → instance-static list → resolve regex → 动态反查; 多模式重叠由作者按 schema 出现顺序覆写决定"
- 加 example/note 提示 `.*` 转发模式合法（用 `resolve.delegate` 对称语义节示例）

**Test (S1a)**:
- `cargo test -p pathql-rs --features "json5 validate"` 全绿
- 删除原有的"碰撞应被检出"测试
- 加新测试：含 `.*` 转发 + 静态 list 的 fixture **应通过**（不再报错）

**Commit message**:
```
chore(phase7b/S1a): remove regex collision detection from validate

Two newly-blessed DSL patterns expose the static collision check as
fundamentally false-positive:

1. ".*" → delegate forwarding (e.g., gallery_hide_router forwarding all
   segments to gallery_route): the wildcard intentionally catches anything
   not matched by static list keys. Runtime resolves via static-list →
   regex-resolve → dynamic-reverse-lookup, so the wildcard only fires for
   non-static segments. The check flagged this as collision; runtime
   ordering renders the warning meaningless.

2. ${properties.X} template-keyed list/resolve entries: the actual key
   string is determined at instantiation time from instance properties.
   Validate runs at load time without instance properties, so it cannot
   decide whether ${properties.lang}="java" collides with a sibling
   "java" static key. Static analysis is fundamentally unable to handle
   this.

Removes:
- regex-vs-static-literal collision check
- regex-vs-regex NFA intersection check
- corresponding ValidateErrorKind variants
- test fixtures asserting collision detection

Author responsibility: writing two patterns that match the same segment
is allowed; runtime ordering decides who wins. Document this in
RULES.md §X (resolution priority).

Files: pathql-rs/src/validate/{...}.rs (specific files TBD by grep at
       implementation time)
```

---

### S1b. 支持 `${properties.X}` 模板形态的 list / resolve key

**问题**：当前 [`pathql-rs/src/ast/list.rs`](../../src-tauri/pathql-rs/src/ast/list.rs) 的 `key_is_dynamic` 把任何 `${X.Y}`（含点号）形态都判为 **dynamic** —— 路由到 `DynamicListEntry`（要求 sql / delegate + child_var/data_var）。

但 `${properties.lang}` 这种形态实际是 **instance-static**：编译期未知，instance 期一旦 properties 注入就成定值。它的语义是"该 list 项的字面 key 由 properties 决定"——值仍是 `ProviderInvocation`（不是 SQL/delegate 数据源）。

**形态分类（修订）**：

| Key 形态 | 分类 | Value 类型 | 何时定 key 字面值 |
|---|---|---|---|
| `"plain"` (无 `${...}`) | 静态 | `ProviderInvocation` | DSL 加载期 |
| `"${X}"` (无点号) | 静态 | `ProviderInvocation` | DSL 加载期（特殊字符 `${X}` 当 literal）|
| **`"${properties.X}"`** | **instance-static**（新分类） | **`ProviderInvocation`** | **Instance 实例化期** |
| `"${data_var.X}"` / `"${child_var.X}"` | 动态 | `DynamicListEntry` | 运行期每行 |

#### S1b 修改清单

##### list.rs::key_is_dynamic 重构

```rust
pub(crate) enum ListKeyKind {
    Static,            // "plain" / "${X}" — literal
    InstanceStatic,    // "${properties.X}" — resolved at instance time
    Dynamic,           // "${data_var.X}" / "${child_var.X}" — per-row
}

pub(crate) fn classify_list_key(key: &str) -> ListKeyKind {
    // 解析模板; 遍历 var refs:
    // - 任一 var 是 properties.X → InstanceStatic (除非也有 data_var/child_var)
    // - 任一 var 是 data_var.X / child_var.X → Dynamic (优先级最高, 因为需要每行渲染)
    // - 否则 → Static
    ...
}
```

`ListEntry` enum 加 `InstanceStatic` variant（payload 与 Static 相同 = `ProviderInvocation`）：

```rust
pub enum ListEntry {
    Static(ProviderInvocation),
    InstanceStatic(ProviderInvocation),    // 新: key 含 ${properties.X}, value 同 Static
    Dynamic(DynamicListEntry),
}
```

或者更简洁：合并 Static + InstanceStatic（同 payload），用 key 模板渲染期决定字面：

```rust
// 简化方案: ListEntry 只两态; list() / resolve() 实现时
// 渲染 key 模板 (可能含 ${properties.X}) 后再比较或输出
pub enum ListEntry {
    Static(ProviderInvocation),  // key 在解析期已 literal 或 instance 期可渲染
    Dynamic(DynamicListEntry),
}
```

后者更优——payload 类型不动，渲染逻辑在 list/resolve 实现里加 `render_key_template(key, &self.properties)` 一步。

##### DslProvider::list / resolve 实现修改

```rust
// list 实现 (生成 ChildEntry):
for (key_template, entry) in &list.entries {
    if let ListEntry::Static(inv) = entry {
        // 渲染 key 模板 (instance-static 形态会在此被替换); 静态形态返回原字符串
        let rendered_key = self.render_key_with_properties(key_template)?;
        // ... 用 rendered_key 作为 ChildEntry.name
    }
}

// resolve 实现 (匹配 segment):
for (key_template, entry) in &list.entries {
    if let ListEntry::Static(inv) = entry {
        let rendered_key = self.render_key_with_properties(key_template)?;
        if rendered_key == name {
            // ... 实例化 inv 并返回
        }
    }
}
```

`render_key_with_properties` 用 `render_template_to_string` + `TemplateContext { properties: self.properties.clone(), ... }`。模板含 `${data_var.X}` 等会报错（key 是 instance-static，不允许 dynamic var）；这层校验在加载期 / 静态分类期已经过滤。

##### Resolve 表同样支持

`Resolve` 表项的 key 是 regex 字符串。允许 `"${properties.X}_pattern"` 形态：渲染后再当 regex 编译。语义类似 list。

修改 [`dsl_provider.rs::resolve`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs) 内：

```rust
for (pattern_template, invocation) in &resolve.0 {
    let pattern = self.render_key_with_properties(pattern_template)?;
    let anchored = format!("^(?:{})$", pattern);
    let re = ...;
    // ...
}
```

⚠️ 性能：每次 resolve 都重新渲染 + 编译 regex。Instance-static pattern 实际编译结果 stable（properties 不变），可加 LRU。本期接受性能损失，Phase 8 性能调优期再加缓存。

##### 校验：load 期 key 模板的 `${X.Y}` 形态合法性

加载期解析每个 list / resolve key 的模板 var refs；只允许 `${properties.X}`（instance-static）或纯字面（static）；如出现 `${data_var.X}` / `${child_var.X}` —— 仅 Dynamic 项允许；如 list/resolve 表项的 key 中出现 → 报错。

#### S1b 配套 schema.json5 修改

[`core/src/providers/dsl/schema.json5`](../../src-tauri/core/src/providers/dsl/schema.json5):

- `List` 描述: 新增"3 类 key 形态"小节明示 `static / instance-static (${properties.X}) / dynamic (${data_var.X} / ${child_var.X})`; instance-static 的 value 类型与 static 同 (`ProviderInvocation`)
- 加 jsonc 示例:
  ```jsonc
  "list": {
      "albums":            { "provider": "X" },                  // static
      "${properties.lang}": { "provider": "Y" },                  // instance-static
      "${row.id}":         { "sql": "SELECT id FROM t", ... }    // dynamic
  }
  ```
- `Resolve` 描述: 类似 — pattern 字符串可含 `${properties.X}` 模板（实例化期渲染后再当 regex 编译）；不允许 `${data_var.X}` / `${child_var.X}`（resolve 表是 instance-scoped, 没 row/child 上下文）
- `DynamicListEntry_Sql` / `DynamicListEntry_Delegate` 描述加一行: "key 必须含 `${data_var.X}` 或 `${child_var.X}` 至少一个 var ref; 否则归 Static / InstanceStatic 分类"

**Test (S1b)**:
- 单测 `classify_list_key`: 各种形态分类正确
- 集成测试 `tests/instance_static_key.rs`: 加载一个 def 含 `"list": { "${properties.lang}": {...} }`; 实例化 properties.lang="java"; 调 list() 返回 ChildEntry name="java"; 调 resolve("java") 命中
- 反向：`"list": { "${data_var.x}": {...} }` 应路由 Dynamic → 走 sql/delegate 分支（既有逻辑）
- schema validate 期: load `"list": { "${data_var.X}": {provider: "X"} }` 应被路由 Dynamic 但 invocation 是 ProviderInvocation → 路由不匹配 → 报错

**Commit message**:
```
feat(phase7b/S1b): instance-static key templates in list / resolve

Adds support for ${properties.X} in list/resolve table keys. The key
literal is resolved at instance time from self.properties:

  "list": {
    "${properties.lang}": { "provider": "X" }
  }

When the DslProvider is instantiated with properties.lang="java", the
list yields a single ChildEntry with name="java" and resolve("java")
matches it. With properties.lang="rust", same key template yields
"rust" instead.

Distinct from dynamic list entries (${data_var.X} / ${child_var.X})
which produce one child per SQL row / target list child. Instance-static
keys produce one literal key per instance.

key_is_dynamic refactored to classify_list_key returning
{Static, Dynamic}; instance-static is rendered to literal at list/resolve
call time using render_template_to_string with self.properties as ctx.

Load-time check: keys can reference ${properties.X} only; ${data_var.X}
/ ${child_var.X} in static-key templates → error (those belong in
dynamic entries).

Files: pathql-rs/src/ast/list.rs, pathql-rs/src/provider/dsl_provider.rs
       (+ tests)
```

---

### S1. AST: 恢复 `InvokeByDelegate` variant

修改 [`pathql-rs/src/ast/invocation.rs`](../../src-tauri/pathql-rs/src/ast/invocation.rs):

```rust
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByDelegate {
    pub delegate: ProviderCall,    // 6e 后形态: {provider, properties}
    #[serde(default)]
    pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ProviderInvocation {
    ByName(InvokeByName),
    ByDelegate(InvokeByDelegate),
    Empty(EmptyInvocation),
}
```

⚠️ 注：`ProviderCall` 已在 6e 定义，复用不需新建。

#### S1a. 单测覆盖

新增 `invocation.rs` 测试：

```rust
#[test]
fn by_delegate_with_provider_call() {
    let v: ProviderInvocation = serde_json::from_str(
        r#"{"delegate":{"provider":"foo","properties":{"k":"v"}}}"#
    ).unwrap();
    match v {
        ProviderInvocation::ByDelegate(b) => {
            assert_eq!(b.delegate.provider, ProviderName("foo".into()));
            assert!(b.delegate.properties.is_some());
        }
        _ => panic!("expected ByDelegate"),
    }
}

#[test]
fn by_name_and_by_delegate_disambiguated() {
    // {provider:"X"} → ByName
    let v: ProviderInvocation = serde_json::from_str(r#"{"provider":"X"}"#).unwrap();
    assert!(matches!(v, ProviderInvocation::ByName(_)));
    // {delegate:{provider:"X"}} → ByDelegate
    let v: ProviderInvocation = serde_json::from_str(r#"{"delegate":{"provider":"X"}}"#).unwrap();
    assert!(matches!(v, ProviderInvocation::ByDelegate(_)));
}

#[test]
fn provider_and_delegate_rejected() {
    let r: Result<ProviderInvocation, _> = serde_json::from_str(
        r#"{"provider":"foo","delegate":{"provider":"bar"}}"#
    );
    assert!(r.is_err());
}
```

#### S1b. List 静态项限制（决策 3）

[`pathql-rs/src/ast/list.rs`](../../src-tauri/pathql-rs/src/ast/list.rs) `ListEntry::Static` 当前接受 `ProviderInvocation`。改造为只接受 ByName / Empty 子集：

选项 A：新建 `StaticListInvocation`（仅 ByName/Empty）；
选项 B：保持当前 enum，运行期 fold/validate 拒绝 ByDelegate。

推荐 **B**——schema 层用 description warn，运行期 DslProvider 内部遇到 list 静态项的 ByDelegate 时 panic / 返回错误。简化 AST。

```rust
// dsl_provider.rs::list (静态项分支):
ListEntry::Static(invocation) => {
    if matches!(invocation, ProviderInvocation::ByDelegate(_)) {
        return Err(EngineError::SchemaViolation(
            "static list entry cannot use ByDelegate; only resolve table supports it".into()
        ));
    }
    // ...
}
```

**Test (S1)**: `cargo test -p pathql-rs --features json5` 全绿 + 新增单测通过。

**Commit message**:
```
feat(phase7b/S1): restore ProviderInvocation::ByDelegate (path-unaware)

6e deleted the ByDelegate variant arguing the post-PathExpr-→-ProviderCall
shape coincided with ByName. That argument was wrong: the structures match
but the *operations* differ:
  - ByName({X}): instantiate X; X is the resolve result
  - ByDelegate({X}): instantiate X; call X.resolve(name); X's inner
    provider is the result.

This restores the variant with ProviderCall payload (path-unaware design
preserved). Schema disambiguation: {provider} → ByName, {delegate} →
ByDelegate, mutually exclusive.

Static list entries reject ByDelegate at runtime (only resolve table
supports it; static list "place a provider here" semantic doesn't compose
with delegate).

Files: pathql-rs/src/ast/invocation.rs (+ tests)
```

---

### S2. DslProvider::resolve 实现 ByDelegate 分支

修改 [`pathql-rs/src/provider/dsl_provider.rs`](../../src-tauri/pathql-rs/src/provider/dsl_provider.rs) 的 `instantiate_invocation` + resolve 分支：

```rust
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
            // 7b: 实例化 target, 调 target.apply_query 累积 contrib, 然后调 target.resolve(name)
            //     转发解析责任。注意: name 由 caller 传入(在 resolve 主循环里, name 是 segment 字面值)
            //     —— 这里的 instantiate_invocation 不直接拿到 name. 需要分流: caller 处理.
            unreachable!("ByDelegate is handled inline in resolve(), not via instantiate_invocation");
        }
        ProviderInvocation::Empty(_) => {
            Ok(Some(Arc::new(EmptyDslProvider) as Arc<dyn Provider>))
        }
    }
}

// DslProvider::resolve(name, composed, ctx) 内部 — 调整正则匹配分支:
if let Some(captures) = re.captures(name) {
    let cap_vec: Vec<String> = captures.iter()
        .map(|m| m.map(|x| x.as_str().to_string()).unwrap_or_default())
        .collect();
    return match invocation {
        ProviderInvocation::ByName(_) | ProviderInvocation::Empty(_) => {
            self.instantiate_invocation(invocation, &cap_vec, composed, ctx).ok().flatten()
        }
        ProviderInvocation::ByDelegate(b) => {
            // 7b: 转发 resolve 给 target
            let props = self.eval_properties(&b.delegate.properties, &cap_vec).ok()?;
            let target = ctx.registry.instantiate(
                &self.current_namespace(),
                &b.delegate.provider,
                &props,
                ctx,
            )?;
            // apply_query 累积上游 (target 的 contrib 也要算入)
            let next_composed = target.apply_query(composed.clone(), ctx);
            // 调 target.resolve 转发
            target.resolve(name, &next_composed, ctx)
        }
    };
}
```

**Test (S2)**: 单测 `pathql-rs/src/provider/dsl_provider.rs`:

```rust
#[test]
fn resolve_delegate_forwards_to_target_resolve() {
    // 构造: 父 def 含 resolve { ".*": delegate { provider: "child" } }
    // child 是 DslProvider 含 resolve { "foo": { provider: "leaf" } }
    // 调 父.resolve("foo") → 期望返回 leaf
}

#[test]
fn resolve_delegate_target_apply_query_contributes_to_composed() {
    // 构造: child def 有 query.order; resolve 父子链;
    // 期望: 父.resolve(...).composed 含 child 的 contrib
}

#[test]
fn resolve_delegate_target_resolve_returns_none() {
    // 构造: child 不接受任何 name; 父 resolve 返回 None (转发结果是 None)
}
```

**Commit message**:
```
feat(phase7b/S2): DslProvider.resolve forwards via ByDelegate

When a Resolve regex matches and the entry is ProviderInvocation::ByDelegate,
DslProvider now:
  1. Instantiates target via registry.instantiate
  2. Applies target.apply_query (so target's contrib accumulates)
  3. Forwards by calling target.resolve(name, &next_composed, ctx)

The forwarded `name` is the original segment that matched the regex —
target gets to make its own resolve decision (its list / regex / dynamic
reverse-lookup chain).

Test coverage: 3 unit tests for forward / contrib accumulation / target
returns None (forwarded None propagates).

Files: pathql-rs/src/provider/dsl_provider.rs (+ tests)
```

---

### S3. schema.json5 + RULES.md 同步 + validate 检查

#### S3a. schema.json5 — ByDelegate 复活 + 对称 delegate 描述

[`core/src/providers/dsl/schema.json5`](../../src-tauri/core/src/providers/dsl/schema.json5):

**1. 恢复 `InvokeByDelegate` 定义（6e 删除时同时去掉了）+ 加进 `ProviderInvocation.oneOf`**：

```jsonc
"InvokeByDelegate": {
    "type": "object",
    "additionalProperties": false,
    "required": ["delegate"],
    "not": { "required": ["provider"] },
    "properties": {
        "delegate": {
            "$ref": "#/definitions/ProviderCall",
            "description": "[操作转发 — 对称语义] 实例化 ProviderCall.provider; 在其上调用此上下文对应方法 (resolve 表里 → target.resolve(name)). 与 query.delegate / list[].delegate 形成三处对称"
        },
        "meta": { "$ref": "#/definitions/MetaValue" }
    }
},

"ProviderInvocation": {
    "oneOf": [
        { "$ref": "#/definitions/InvokeByName" },
        { "$ref": "#/definitions/InvokeByDelegate" },
        { "$ref": "#/definitions/EmptyInvocation" }
    ],
    "description": "三态: ByName(provider 是结果) / ByDelegate(target.resolve(name) 给出的内层 provider 是结果) / Empty (占位). Resolve 表接受三态; List 静态项只接 ByName / Empty (ByDelegate 在 list 上无意义)"
}
```

**2. `DelegateQuery.delegate` 与 `DynamicListEntry_Delegate.delegate` 描述统一对齐对称语义** —— 当前两者已在 6e 改为 ProviderCall，但描述需补"对称"措辞：

```jsonc
"DelegateQuery": {
    ...
    "properties": {
        "delegate": {
            "$ref": "#/definitions/ProviderCall",
            "description": "[操作转发 — 对称语义] 实例化目标 + 调 target.apply_query(current, ctx); 把目标的 contrib 借为本 provider 的 contrib"
        }
    }
},

"DynamicListEntry_Delegate": {
    ...
    "properties": {
        "delegate": {
            "$ref": "#/definitions/ProviderCall",
            "description": "[操作转发 — 对称语义] 数据源 provider; 实例化后调 target.list(composed, ctx) 拿 children, 每个 child 通过 child_var 暴露给本 list 项的 key/properties/meta"
        },
        ...
    }
}
```

**3. schema 顶部加"delegate 对称语义"总览段落**，集中说明三处 delegate 的对称表（参见 RULES.md §X.delegate 对称转发）。

#### S3b. RULES.md 修订

[`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md) §3 / §5 / §11 增加 "delegate 对称语义" 章节：

```
## §X delegate 对称转发

DSL 三处 `delegate` 字段对应**同一原则**: "把对应上下文的操作转发给 target":

| 字段位置                  | 转发的操作                          |
|---|---|
| `query.delegate`          | target.apply_query(current, ctx)    |
| `list[].delegate` (动态项) | target.list(composed, ctx)          |
| `resolve[].delegate`      | target.resolve(name, composed, ctx) |

每处 delegate 的 payload 都是 ProviderCall ({provider, properties}) — 永远 path-unaware。
```

#### S3c. validate cross_ref 覆盖

`pathql-rs/src/validate/cross_ref.rs` `collect_provider_refs` 已在 6e 收集 `Query::Delegate.provider` + `DynamicDelegateEntry.delegate.provider`；7b 加：

```rust
if let Some(resolve) = &def.resolve {
    for (_, invocation) in &resolve.0 {
        if let ProviderInvocation::ByDelegate(b) = invocation {
            refs.push((..., b.delegate.provider.clone()));
        }
    }
}
```

cycle 检测同样把 ByDelegate 的目标加入 delegate 邻接图。

**Test (S3)**: `cargo test -p pathql-rs --features "json5 validate"` 全绿（含 cycle / cross_ref 新 fixture）。

**Commit message**:
```
docs+chore(phase7b/S3): schema.json5 + RULES + validate for ByDelegate

- schema.json5: InvokeByDelegate definition with ProviderCall payload
- RULES.md: new "delegate 对称转发" section documenting the symmetric
  semantic across query / list / resolve
- validate/cross_ref: collects ByDelegate.delegate.provider as outgoing ref
- validate/cycle: ByDelegate edges enter the delegate cycle graph
- Bad fixture: A.resolve[".*"] delegate→B, B.resolve[".*"] delegate→A
  → DelegateCycle detected
```

---

### S4. pilot: `gallery_hide_router` 迁移 + `gallery_all_desc_router` 简化

#### S4a. `gallery_hide_router.json5` 新建

参照 [`programmatic/gallery_filters.rs::GalleryHideRouter`](../../src-tauri/core/src/providers/programmatic/gallery_filters.rs):

```jsonc
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "gallery_hide_router",
    "query": {
        "where": "/*HIDE*/ NOT EXISTS (SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ?)"
        // 注: 原 programmatic 用 with_where_raw 直接 push; DSL 用 SQL 字符串 + 后续 fold_contrib 把 limit:None
        // 表达不出来 — 留个 TODO. 当前 hide 功能 limit 通过 child router 重写, 不阻塞.
    },
    "list": {
        // hide 模式下, list 复用 gallery_route 整套 (用户可在 hide 视角下浏览所有 gallery 顶级维度)
        // 通过 resolve.delegate 把任意 segment 转给 gallery_route.resolve
    },
    "resolve": {
        ".*": { "delegate": { "provider": "gallery_route" } }
    }
}
```

⚠️ 注：原 `with_where_raw` 还带 bind 参数（`HIDDEN_ALBUM_ID`）；DSL 表达需要 `${properties.X}` 形式 + 上层传 properties。简化方案是把 album_id 写进 SQL 字面（不安全但 short-term）。或定义一个 `hidden_album_id` properties + 上层固定传值。**建议**：定义为 contributor SQL 模板，properties 由 root_provider 启动期注入：

```jsonc
"query": {
    "where": "/*HIDE*/ NOT EXISTS (SELECT 1 FROM album_images WHERE image_id = images.id AND album_id = ${properties.hidden_album_id})"
},
"properties": {
    "hidden_album_id": { "type": "string", "default": "...", "optional": false }
}
```

或者把 `hidden_album_id` 作为 `root_provider` 全局 properties 通过链下传（更复杂）。

**简化决策**：本期允许 SQL 字面常量（HIDDEN_ALBUM_ID 是不变常量）；schema validate 期把它当字符串 OK。

#### S4b. `gallery_all_desc_router.json5` 简化

参考决策 6 重写——从 6 行 resolve regex 缩成 1 行 `.* → delegate gallery_all_router`。

#### S4c. `dsl_loader.rs` 加文件 + 注释 register

```diff
 pub const DSL_FILES: &[&str] = &[
     ...
     "gallery/gallery_all_desc_router.json5",
+    "gallery/gallery_hide_router.json5",
     ...
 ];
```

```diff
 // programmatic/mod.rs
-register(reg, "gallery_hide_router", |_| {
-    Ok(Arc::new(gallery_filters::GalleryHideRouter) as Arc<dyn Provider>)
-})?;
+// 7b: gallery_hide_router 已迁移到 DSL (dsl/gallery/gallery_hide_router.json5)
+// register(reg, "gallery_hide_router", |_| { ... })?;
```

#### S4d. parity 测试

`core/tests/parity.rs` 加 case：

```rust
#[test]
fn gallery_hide_router_parity() {
    // programmatic: GalleryHideRouter
    // dsl: gallery_hide_router.json5
    // 测 path /gallery/hide / /gallery/hide/all/x100x/1 / /gallery/hide/desc/2
    // 比较 build_sql 等价
}
```

**Test (S4)**:
- `cargo test -p kabegame-core` 全绿
- 手测 `bun dev`: `/gallery/hide/all/desc/1`、`/gallery/hide/all/x500x/2/`、`/gallery/hide/plugin/<id>/...` 行为不回归
- 简化版 `gallery_all_desc_router` 路径仍工作

**Commit message**:
```
feat(phase7b/S4): migrate gallery_hide_router; simplify gallery_all_desc_router

First production use of resolve.delegate. Both .json5 files now use
".*": { "delegate": { "provider": "..." } } pattern to forward all
segment resolution to a parent provider (gallery_route / gallery_all_router):

- gallery_hide_router: contrib hide-WHERE; delegates ALL navigation to
  gallery_route (mirrors programmatic GalleryHideRouter.resolve which
  did `gallery_route.resolve(name)`)
- gallery_all_desc_router: contrib order-revert; delegates segment
  resolution to gallery_all_router (collapses the duplicated xNx +
  bare-digit regex table from 6 lines to 1)

Programmatic GalleryHideRouter retained but register call commented;
parity test verifies behavior equivalence on /gallery/hide/* paths.

Files: src-tauri/core/src/providers/dsl/gallery/{
       gallery_hide_router.json5 (new),
       gallery_all_desc_router.json5 (simplified) },
       core/src/providers/{dsl_loader.rs (DSL_FILES update),
       programmatic/mod.rs (skip register)},
       core/tests/parity.rs (+ gallery_hide_router_parity case)
```

---

### S5-S12. 17 个 gallery 滤镜逐个迁移

**通用模板**: 每个 provider 一个 commit, 流程相同:

1. 读 [`programmatic/gallery_filters.rs`](../../src-tauri/core/src/providers/programmatic/gallery_filters.rs) / `gallery_albums.rs` / `gallery_dates.rs` 中对应 struct 的 apply_query / list / resolve
2. 翻译为 DSL .json5 (Contrib query + list 静态项 / resolve 表)
3. 加进 `dsl_loader::DSL_FILES`
4. 注释 `programmatic/mod.rs::register_all_hardcoded` 对应 register 调用
5. `core/tests/parity.rs` 加 case
6. cargo test + 手测主路径
7. commit

#### S5. albums + album_entry

- `gallery_albums_router.json5`: list 动态项（SQL 列出所有 album）+ ByDelegate 转发其余 segment 给 gallery_route?
- `gallery_album_provider.json5`: contrib WHERE on album_id (path 段是 album id)

⚠️ 难点：`gallery_album_provider` 的 album id 来自 URL 段（capture 组），需要 `${properties.album_id}` 模板把它写进 WHERE。这是 7a 已经验证的 properties 模式。

#### S6. plugins + plugin_entry（**首个用 7a get_plugin SQL 函数**）

- `gallery_plugins_router.json5`: list 动态项跑 `SELECT DISTINCT plugin_id, get_plugin(plugin_id, '${properties.locale}') AS info FROM images` 拿插件清单 + i18n 名字
- `gallery_plugin_provider.json5`: contrib WHERE `plugin_id = ${properties.plugin_id}`

#### S7. tasks + task_entry

类似 albums，按 task_id 过滤；可能需要 host 函数 `get_task(task_id) -> JSON_TEXT`（类似 get_plugin），但当前 8a/9 的需求决定。**本期可推 7a 之后再加**——先用纯 SQL JOIN tasks 表显示名。

#### S8. surfs + surf_entry

类似 tasks。

#### S9. media_type + media_type_entry

`gallery_media_type_router.json5`: list 静态项 ["image", "video"]
`gallery_media_type_provider.json5`: contrib WHERE 按 mime 类型 / 或 ext 过滤

#### S10. wallpaper_order

`gallery_wallpaper_order_router.json5`: contrib WHERE has_wallpaper_set + 复用 gallery_route 的 segment 树（类似 hide）→ 用 resolve.delegate 转发给 gallery_route

#### S11. date_range + date_range_entry

复杂——date_range 是 `start/end` 两个 segment 联合形成一个 entry。可能需要嵌套 router：date_range_router list 入口段 → date_range_entry_provider contrib WHERE BETWEEN。

#### S12. search_display_name 三件套

7a 已经 pilot `gallery_search_router`；7b S12 完成 `gallery_search_display_name_router` + `gallery_search_display_name_query_provider`。

每子任务的 commit message 模板：
```
feat(phase7b/S<N>): migrate gallery_<X>_router|provider to DSL

[brief: what the programmatic impl did, what the DSL .json5 expresses]

Programmatic struct retained; register skipped. Parity test verifies
behavior on /gallery/<X>/... paths. DSL_FILES + register_all_hardcoded
synced.
```

---

### S13. 收尾验证 + memory

`cargo test -p pathql-rs --features "json5 validate"` + `cargo test -p kabegame-core` 全绿；`bun check`；手测 dev server 全部 gallery 顶级维度路径不回归。

memory `project_dsl_architecture.md` 加决策 6:

```
**决策 6: delegate 对称语义 — 7b 补全**

DSL 三处 delegate 字段对应同一原则: "把当前上下文对应的操作转发给 target":
- query.delegate    → target.apply_query
- list[].delegate   → target.list
- resolve[].delegate → target.resolve  (7b 补全 — 6e 误删的能力)

实例化形态都是 ProviderCall (path-unaware). resolve.delegate 让 modifier
router (如 hide / desc) 不必复制粘贴上游 router 的 resolve 表 —— 一行
".*": {delegate: {provider: ...}} 转发即可.
```

---

## 完成标准

- [ ] `ProviderInvocation::ByDelegate` variant 复活；payload 是 ProviderCall
- [ ] DslProvider::resolve 在 ByDelegate 分支调 target.resolve(name) 转发
- [ ] schema.json5 / RULES.md 同步反映 delegate 对称语义
- [ ] validate cross_ref + cycle 覆盖 ByDelegate 边
- [ ] `gallery_hide_router.json5` / `gallery_all_desc_router.json5` 用 `.*` 转发模式简化
- [ ] 17 个 gallery 滤镜 programmatic provider 全部迁移；programmatic register 调用注释
- [ ] 每个迁移加 parity 测试（programmatic vs DSL build_sql + list children 等价）
- [ ] `dsl_loader::DSL_FILES` 同步增长 17 项（约 30+ DSL 文件）
- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿
- [ ] `cargo test -p kabegame-core` 全绿
- [ ] `bun check -c main --skip vue` 通过
- [ ] 手测：所有 gallery 顶级维度（all / albums / plugins / tasks / surfs / media-type / hide / search / wallpaper-order / date-range）行为不回归

## 风险点

1. **`gallery_hide_router` SQL 字面 vs 模板**：HIDDEN_ALBUM_ID 当前是 Rust 常量；DSL 要么写字面（不安全 — schema validate 期可能挂）要么作为 properties 注入。本期接受字面方案，validate 期对此 SQL 加白名单豁免

2. **path-aware 残留**：programmatic `GalleryHideRouter::resolve` 写死 `gallery_route` 名 — DSL `.*` 转发同样硬编码这个 provider 名。如果未来 hide 模式想接入不同 segment 树（如 vd），需要新文件而非动态选择。可接受

3. **resolve.delegate 的 capture 组传不到 target.resolve**：当前设计 `target.resolve(name, ...)`——name 是整 segment 字面，capture 组**丢失**。如果 target 期望 capture，无法表达。**缓解**：target 自己对 name 跑正则即可。如果未来发现需要传 capture，加 `properties` 字段把 capture 写进 ProviderCall.properties

4. **List 静态项 ByDelegate 拒绝的运行期 vs 加载期**：决策 3 选了运行期拒绝；如果加载期 schema validate 能拒，更早。schema 用 conditional `not` 表达即可——本期实施时尝试 schema 强制；不行再退到运行期

5. **17 个迁移工作量**：每个约 30-60 分钟（读 programmatic + 写 DSL + 加测试 + 验证）；总 8-15 小时。可拆给多个会话；每个 commit 独立可发布

6. **parity_helper 在 7a 是 minimal viable**：7b 大量使用时如果发现 helper 不够（比如不能比 list children 形态），增强它的工作可能要中途插入，影响节奏

---

## 完成 7b 后的下一步

进入 **Phase 7c**：Gallery 日期下钻 + shared sort 迁移。日期路径（`/gallery/date/<year>y/<month>m/<day>d/...`）是嵌套动态 list（按年/月/日 GROUP BY），是 7c 的复杂之处；resolve.delegate 在那里也很有用（年级别 router 把不匹配年的 segment 转发给上层）。
