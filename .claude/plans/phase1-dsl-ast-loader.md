# Phase 1 详细计划 — `pathql-rs` Crate 脚手架 + AST + Loader trait

## Context

承接高阶计划 `C:\Users\Lenovo\.claude\plans\purring-discovering-shell.md` 的 Phase 1。
本期目标：建立独立的 `pathql-rs` crate（与 `kabegame-core` 解耦），定义 schema 对应的全部 Rust AST 类型，
定义抽象 `Loader` trait 与 `ProviderRegistry`。**适配器（如 json5）仅声明 feature 开关，不在本期实现**——
真正的 json5 反序列化逻辑放到 Phase 2。

工作区现状（已确认）：
- 根 [`Cargo.toml`](../../Cargo.toml) 是 workspace（resolver = "2"），现有 4 个 src-tauri 成员 + 7 个 tauri plugin
- workspace deps 已含 `serde`、`serde_json`、`tokio` 等可复用
- 新 crate 目录：`src-tauri/pathql-rs/`，作为 workspace 第 5 个 src-tauri 成员

参考的实际 .json5 文件结构（驱动 AST 类型设计）：
- 根 [`root_provider.json`](../../src-tauri/core/src/providers/root_provider.json) —— 仅 list
- [`gallery_route.json5`](../../src-tauri/core/src/providers/gallery/gallery_route.json5) —— query + list
- [`gallery_all_router.json5`](../../src-tauri/core/src/providers/gallery/gallery_all_router.json5) —— DelegateQuery + list + resolve + note
- [`gallery_paginate_router.json5`](../../src-tauri/core/src/providers/gallery/gallery_paginate_router.json5) —— properties + list（DynamicDelegate）+ resolve
- [`page_size_provider.json5`](../../src-tauri/core/src/providers/shared/page_size_provider.json5) —— properties + list（DynamicSql, 无 provider 字段）
- [`vd_root_router.json5`](../../src-tauri/core/src/providers/vd/vd_root_router.json5) + [`vd_zh_CN_root_router.json5`](../../src-tauri/core/src/providers/vd/vd_zh_CN_root_router.json5) —— 仅 list（i18n 路由层）

---

## 锁定的设计选择

1. **crate 命名**：`pathql-rs`（package 名同名，目录 `src-tauri/pathql-rs/`）
2. **AST 序列化**：所有 AST 类型实现 `serde::Deserialize` + `serde::Serialize`
3. **不绑定 json5**：Phase 1 `Cargo.toml` 声明 `json5` feature，但模块/依赖均不引入；测试用 `serde_json::from_str` 喂手写严格 JSON
4. **未解析就保留**：`TemplateExpr` / `SqlExpr` / `PathExpr` 都做成 newtype `(pub String)`；解析与校验留给后续 phase
5. **MetaValue = `serde_json::Value`**：schema 已定义为任意 JSON
6. **字段命名严格对齐 schema**：`where`、`as`、`type`、`in_need`、`$schema` 等用 `#[serde(rename = "...")]`
7. **路径段大小写敏感**（RULES §2）：所有 newtype 不做 lowercase 折叠
8. **List 静态/动态分流**：手写 `Deserialize` visitor，按 key 是否含 `${ident.field}` 模式判别 variant
9. **Loader trait 同步签名**：本期文件 IO 走同步；如未来需要异步可加 `LoaderAsync` 平行接口

---

## 测试节奏（重要）

**每完成一个子任务就立即 `cargo test -p pathql-rs` 一次**——不要把测试积攒到最后批量跑。
每个子任务自带「测试要点」小节，列出本步骤需要新增的单测；写完代码就把对应单测加上并跑通再进入下一步。

---

## 子任务拆解

### S1. Workspace + Crate 脚手架

**修改** [`Cargo.toml`](../../Cargo.toml) workspace 成员：

```toml
[workspace]
members = [
  "src-tauri/core",
  "src-tauri/kabegame-i18n",
  "src-tauri/pathql-rs",     # 新增
  "src-tauri/app-main",
  ...
]
```

加 workspace 级依赖：

```toml
[workspace.dependencies]
pathql-rs = { path = "./src-tauri/pathql-rs", default-features = false }
thiserror = "1.0"
```

**新建** `src-tauri/pathql-rs/Cargo.toml`：

```toml
[package]
name = "pathql-rs"
edition = { workspace = true }
version = { workspace = true }
description = "Path-folding query DSL — AST + Loader 抽象（格式无关）"

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }

[features]
default = []
# 适配器 feature 占位；实现见 Phase 2
json5 = []

[dev-dependencies]
serde_json = { workspace = true }
```

**新建** 空 `src-tauri/pathql-rs/src/lib.rs`：

```rust
pub mod ast;
pub mod loader;
pub mod registry;

pub use ast::*;
pub use loader::{Loader, LoadError, Source};
pub use registry::{ProviderRegistry, RegistryError};
```

**新建** 三个空模块占位文件（避免 lib.rs 编译失败）：
- `src-tauri/pathql-rs/src/ast/mod.rs` — 暂时只 `// placeholder; populated in S12`
- `src-tauri/pathql-rs/src/loader.rs` — 暂时只 `// placeholder; populated in S13`
- `src-tauri/pathql-rs/src/registry.rs` — 暂时只 `// placeholder; populated in S14`

**测试要点**：无；本步只确认编译通过。

**Test**：`cargo check -p pathql-rs` —— 空 crate 通过。

---

### S2. 名称类型（`ast/names.rs`）

`SimpleName` / `Namespace` / `ProviderName` / `Identifier` 四个 newtype。`Namespace` 提供 `parent()` 方法供 registry 链式查找用。`ProviderName` 提供 `is_absolute()` / `split()` 拆分。

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SimpleName(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Namespace(pub String);

impl Namespace {
    pub fn parent(&self) -> Option<Namespace> {
        self.0.rfind('.').map(|i| Namespace(self.0[..i].to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ProviderName(pub String);

impl ProviderName {
    pub fn is_absolute(&self) -> bool { self.0.contains('.') }
    pub fn split(&self) -> (Option<Namespace>, SimpleName) {
        match self.0.rfind('.') {
            Some(i) => (Some(Namespace(self.0[..i].to_string())),
                        SimpleName(self.0[i+1..].to_string())),
            None    => (None, SimpleName(self.0.clone())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Identifier(pub String);
```

更新 `ast/mod.rs` 加 `pub mod names; pub use names::*;`

**测试要点**（`ast/names.rs` 内 `#[cfg(test)]`）：
- `Namespace::parent()`：`kabegame.plugin.foo.parent() == Some("kabegame.plugin")`；`kabegame.parent() == None`
- `ProviderName::split()`：绝对名 `kabegame.foo` → `(Some("kabegame"), "foo")`；简单名 `bar` → `(None, "bar")`
- `ProviderName::is_absolute()`：含点 / 不含点
- 序列化 round-trip：`SimpleName("foo")` ↔ `"foo"`（transparent）

**Test**：`cargo test -p pathql-rs ast::names`。

---

### S3. 表达式 newtype（`ast/expr.rs`）

`TemplateExpr` / `SqlExpr` / `PathExpr` 三个 transparent newtype + `NumberOrTemplate` untagged 双态。

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct TemplateExpr(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SqlExpr(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct PathExpr(pub String);

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum NumberOrTemplate {
    Number(f64),
    Template(TemplateExpr),
}
```

**测试要点**：
- `NumberOrTemplate` 反序列化：`1` → `Number(1.0)`；`"${properties.x}"` → `Template(...)`
- 三个 transparent newtype 直接接 JSON 字符串

**Test**：`cargo test -p pathql-rs ast::expr`。

---

### S4. PropertyDecl + TemplateValue（`ast/property.rs`）

`PropertyDecl` 提取公共字段（`optional`）到外层结构，类型特定字段（`default` / `min` / `max` / `pattern`）在内层 `PropertySpec` 枚举里。`default` 类型随 `type` 变化（f64/String/bool），无法上提。`#[serde(flatten)]` 把 `type` 与变体字段一起作为顶层字段反序列化。

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PropertyDecl {
    #[serde(default)]
    pub optional: Option<bool>,
    #[serde(flatten)]
    pub spec: PropertySpec,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PropertySpec {
    Number {
        #[serde(default)] default: Option<f64>,
        #[serde(default)] min: Option<f64>,
        #[serde(default)] max: Option<f64>,
    },
    String {
        #[serde(default)] default: Option<String>,
        #[serde(default)] pattern: Option<String>,
    },
    Boolean {
        #[serde(default)] default: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TemplateValue {
    String(String),
    Number(f64),
    Boolean(bool),
}
```

**测试要点**：
- `{"type":"number","default":1,"optional":false}` → `PropertyDecl { optional: Some(false), spec: PropertySpec::Number { default: Some(1.0), .. } }`（验证 flatten 把 `optional` 收到外层、`type`/`default` 进 spec）
- `{"type":"string","pattern":"^foo"}` → `PropertyDecl { optional: None, spec: PropertySpec::String { pattern: Some(...), default: None } }`
- `{"type":"boolean","default":true}` → `Boolean { default: Some(true) }`
- `{"type":"datetime"}` → 反序列化失败（unknown variant）
- `{"optional":true}` → 反序列化失败（缺 `type` 字段）
- 序列化 round-trip：`PropertyDecl` → JSON → `PropertyDecl` 字段不丢失
- `TemplateValue` 三种字面：字符串 / 数字 / 布尔

**Test**：`cargo test -p pathql-rs ast::property`。

---

### S5. AliasName / Field / Join（`ast/query_atoms.rs`）

```rust
use serde::{Deserialize, Serialize};
use crate::ast::expr::SqlExpr;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(transparent)]
pub struct AliasName(pub String);

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub sql: SqlExpr,
    #[serde(default, rename = "as")]
    pub alias: Option<AliasName>,
    #[serde(default)]
    pub in_need: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum JoinKind { Inner, Left, Right, Full }

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Join {
    #[serde(default)]
    pub kind: Option<JoinKind>,
    pub table: SqlExpr,
    #[serde(rename = "as")]
    pub alias: AliasName,
    #[serde(default)]
    pub on: Option<SqlExpr>,
    #[serde(default)]
    pub in_need: Option<bool>,
}
```

**测试要点**：
- `Field` 含 `as` rename：`{"sql":"images.id","as":"img_id"}` → `Field { alias: Some("img_id"), .. }`
- `Field` 拒绝 unknown field
- `Join` `kind` 缺省 / 大写 enum：`{"table":"x","as":"y","kind":"LEFT"}` → `Join { kind: Some(Left), .. }`

**Test**：`cargo test -p pathql-rs ast::query_atoms`。

---

### S6. OrderForm（`ast/order.rs`）

数组形态 ⊕ 全局 `{all}` 形态，untagged。数组每项**允许多键**（RULES.md §3.4），不做 len 限制。多键场景下键间优先级按声明顺序——`HashMap` 不保证插入序，需要保序结构。`IndexMap` 不在当前 workspace deps 里；用 `Vec<(String, OrderDirection)>` 自维护，简单也明确。

```rust
use serde::{Deserialize, Serialize, de::{self, MapAccess, Visitor}, Deserializer};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderDirection { Asc, Desc, Revert }

/// 单个数组项；多键场景按声明顺序保留 (field, direction) 对。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OrderArrayItem(pub Vec<(String, OrderDirection)>);

impl<'de> Deserialize<'de> for OrderArrayItem {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderArrayItem;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an OrderArrayItem object {<field>: 'asc'|'desc'|'revert', ...}")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<OrderArrayItem, M::Error> {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, OrderDirection>()? {
                    entries.push((k, v));
                }
                if entries.is_empty() {
                    return Err(de::Error::custom("OrderArrayItem must contain at least one field"));
                }
                Ok(OrderArrayItem(entries))
            }
        }
        de.deserialize_map(V)
    }
}

impl Serialize for OrderArrayItem {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = ser.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrderGlobal {
    pub all: OrderDirection,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum OrderForm {
    Array(Vec<OrderArrayItem>),
    Global(OrderGlobal),
}
```

**测试要点**：
- 数组单键：`[{"created_at":"desc"},{"title":"asc"}]` → 2 个 item，每 item len=1
- 数组多键：`[{"a":"asc","b":"desc"}]` → 1 个 item，len=2，**保留声明顺序**（断言 `entries[0].0 == "a"`）
- 全局形态：`{"all":"revert"}` → `OrderForm::Global { all: Revert }`
- 空对象：`[{}]` → 反序列化失败
- 未知方向：`[{"a":"random"}]` → 反序列化失败
- round-trip 多键：序列化后再反序列化，顺序不变

**Test**：`cargo test -p pathql-rs ast::order`。

---

### S7. Query（`ast/query.rs`）

DelegateQuery ⊕ ContribQuery，untagged。两者都 `deny_unknown_fields` 互斥。

```rust
use serde::{Deserialize, Serialize};
use crate::ast::{expr::*, query_atoms::*, order::OrderForm};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DelegateQuery {
    pub delegate: PathExpr,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ContribQuery {
    #[serde(default)] pub fields: Option<Vec<Field>>,
    #[serde(default)] pub from: Option<SqlExpr>,
    #[serde(default)] pub join: Option<Vec<Join>>,
    #[serde(default, rename = "where")] pub where_: Option<SqlExpr>,
    #[serde(default)] pub order: Option<OrderForm>,
    #[serde(default)] pub offset: Option<NumberOrTemplate>,
    #[serde(default)] pub limit: Option<NumberOrTemplate>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Query {
    Delegate(DelegateQuery),
    Contrib(ContribQuery),
}
```

untagged 顺序敏感：`Delegate` 在前。`deny_unknown_fields` 防止 ContribQuery 吃掉 `delegate`。

**测试要点**：
- `{"delegate":"./foo"}` → `Query::Delegate`
- `{"limit":0}` → `Query::Contrib { limit: Some(Number(0.0)), .. }`
- `{"from":"images","limit":0}` → `Query::Contrib`（多字段）
- `{"delegate":"./foo","limit":0}` → 反序列化失败（两 variant 都 deny unknown）
- 空对象 `{}` → `Query::Contrib(默认值)`
- `where` rename 验证：`{"where":"x>0"}` → `where_ = Some("x>0")`

**Test**：`cargo test -p pathql-rs ast::query`。

---

### S8. ProviderInvocation（`ast/invocation.rs`）

ByName ⊕ ByDelegate ⊕ Empty，untagged。

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::ast::{expr::*, names::*, property::TemplateValue, MetaValue};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByName {
    pub provider: ProviderName,
    #[serde(default)] pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)] pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeByDelegate {
    pub delegate: PathExpr,
    #[serde(default)] pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)] pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyInvocation {
    #[serde(default)] pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ProviderInvocation {
    ByName(InvokeByName),
    ByDelegate(InvokeByDelegate),
    Empty(EmptyInvocation),
}
```

**测试要点**：
- `{"provider":"foo"}` → `ByName`
- `{"delegate":"./bar"}` → `ByDelegate`
- `{}` → `Empty`
- `{"meta":{"k":"v"}}` → `Empty { meta: Some(...) }`
- `{"provider":"foo","delegate":"./bar"}` → 反序列化失败
- `{"provider":"foo","properties":{"a":"b"}}` → `ByName { properties: Some(...) }`

**Test**：`cargo test -p pathql-rs ast::invocation`。

---

### S9. List & ListEntry（`ast/list.rs`）

最复杂的一部分：手写 `Deserialize` visitor，按 key 模式分流。

```rust
use serde::{Deserialize, Serialize, de::{self, MapAccess, Visitor}};
use serde::Deserializer;
use std::collections::HashMap;
use std::fmt;
use crate::ast::{
    expr::*, names::*, property::TemplateValue, invocation::ProviderInvocation, MetaValue,
};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicSqlEntry {
    pub sql: SqlExpr,
    pub data_var: Identifier,
    #[serde(default)] pub provider: Option<ProviderName>,
    #[serde(default)] pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)] pub meta: Option<MetaValue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum DelegateProviderField {
    /// `${child_var.provider}` 字面值——Phase 1 不解析含义
    ChildRef(String),
    Name(ProviderName),
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicDelegateEntry {
    pub delegate: PathExpr,
    pub child_var: Identifier,
    #[serde(default)] pub provider: Option<DelegateProviderField>,
    #[serde(default)] pub properties: Option<HashMap<String, TemplateValue>>,
    #[serde(default)] pub meta: Option<MetaValue>,
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
    pub entries: Vec<(String, ListEntry)>,  // 保留声明顺序
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
                    let entry = if key_is_dynamic(&key) {
                        ListEntry::Dynamic(
                            serde_json::from_value(value)
                                .map_err(|e| de::Error::custom(format!("dynamic entry `{}`: {}", key, e)))?
                        )
                    } else {
                        ListEntry::Static(
                            serde_json::from_value(value)
                                .map_err(|e| de::Error::custom(format!("static entry `{}`: {}", key, e)))?
                        )
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

/// key 含 `${<ident>.<field>...}` → dynamic
fn key_is_dynamic(key: &str) -> bool {
    let bytes = key.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'$' && bytes[i+1] == b'{' {
            if let Some(end) = key[i+2..].find('}') {
                let inner = &key[i+2..i+2+end];
                if inner.contains('.') { return true; }
                i += 2 + end + 1;
                continue;
            }
        }
        i += 1;
    }
    false
}
```

**测试要点**：
- `{"a":{"provider":"x"},"b":{"delegate":"./y"}}` → 2 个 Static
- `{"${row.id}":{"sql":"select 1","data_var":"row"}}` → 1 个 Dynamic::Sql
- `{"${out.name}":{"delegate":"./z","child_var":"out"}}` → 1 个 Dynamic::Delegate
- 静态 + 动态混合：5 项 list 含 3 静态 + 2 动态，顺序保留
- `key_is_dynamic` 单测：`a` / `${x}` (无点) / `${x.y}` / `prefix-${x.y}-suffix` / `${a.b}-${c.d}`
- 错误信息含 key 名：构造一个带语法错误的动态项，断言错误消息含 key 字符串

**Test**：`cargo test -p pathql-rs ast::list`。

---

### S10. Resolve（`ast/resolve.rs`）

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::ast::invocation::ProviderInvocation;

#[derive(Debug, Clone, PartialEq, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resolve {
    pub entries: HashMap<String, ProviderInvocation>,
}
```

注意：RULES.md 已去掉 `inherit_dyn_list`，**不要重新引入**。

**测试要点**：
- `{"entries":{"^x([0-9]+)$":{"provider":"foo"}}}` → `Resolve` 含 1 项 ByName
- 缺 entries：`{}` → 反序列化失败（字段必需）
- 含 unknown：`{"entries":{},"inherit_dyn_list":true}` → 反序列化失败

**Test**：`cargo test -p pathql-rs ast::resolve`。

---

### S11. ProviderDef（`ast/provider_def.rs`）

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::ast::{
    names::*, property::PropertyDecl, query::Query, list::List, resolve::Resolve,
};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDef {
    /// schema 锚点字段；忽略
    #[serde(default, rename = "$schema")]
    pub schema: Option<String>,
    #[serde(default)]
    pub namespace: Option<Namespace>,
    pub name: SimpleName,
    #[serde(default)]
    pub properties: Option<HashMap<String, PropertyDecl>>,
    #[serde(default)]
    pub query: Option<Query>,
    #[serde(default)]
    pub list: Option<List>,
    #[serde(default)]
    pub resolve: Option<Resolve>,
    #[serde(default)]
    pub note: Option<String>,
}
```

**测试要点**：
- 最小定义：`{"name":"foo"}` → `ProviderDef { name: "foo", ... 全 None }`
- 含 `$schema`：`{"$schema":"./schema.json5","name":"foo"}` → `schema: Some("./schema.json5")`
- 缺 name：`{}` → 反序列化失败
- 含 unknown：`{"name":"foo","unknown":1}` → 反序列化失败

**Test**：`cargo test -p pathql-rs ast::provider_def`。

---

### S12. AST 模块根 + 8 文件 fixture round-trip（`ast/mod.rs` + tests/）

**完善** `ast/mod.rs`：

```rust
pub mod names;
pub mod expr;
pub mod property;
pub mod query_atoms;
pub mod order;
pub mod query;
pub mod invocation;
pub mod list;
pub mod resolve;
pub mod provider_def;

pub use names::*;
pub use expr::*;
pub use property::*;
pub use query_atoms::*;
pub use order::*;
pub use query::*;
pub use invocation::*;
pub use list::*;
pub use resolve::*;
pub use provider_def::ProviderDef;

pub type MetaValue = serde_json::Value;
```

**新建** fixture 目录 `src-tauri/pathql-rs/tests/fixtures/`，把 8 个现有 .json5 手工预处理为严格 JSON：
- 去掉所有 `// 注释` 与 `/* */` 块
- 去掉 trailing comma
- 单引号字符串转双引号（如有）

逐个文件命名：
- `root_provider.json`（已是 strict JSON，直接复制）
- `gallery_route.json`
- `gallery_all_router.json`
- `gallery_paginate_router.json`
- `gallery_page_router.json`
- `page_size_provider.json`
- `query_page_provider.json`
- `vd_root_router.json`
- `vd_zh_CN_root_router.json`

**新建** `src-tauri/pathql-rs/tests/fixtures.rs`：

```rust
use pathql_rs::ProviderDef;

fn parse(name: &str) -> ProviderDef {
    let path = format!("tests/fixtures/{}.json", name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {}", path));
    serde_json::from_str::<ProviderDef>(&text)
        .unwrap_or_else(|e| panic!("parse {}: {}", path, e))
}

#[test]
fn root_provider_parses() {
    let d = parse("root_provider");
    assert_eq!(d.name.0, "root_provider");
    let list = d.list.expect("list missing");
    assert_eq!(list.entries.len(), 2);
}

#[test]
fn gallery_route_parses() {
    let d = parse("gallery_route");
    assert_eq!(d.name.0, "gallery_route");
    assert!(matches!(d.query, Some(pathql_rs::Query::Contrib(_))));
}

#[test]
fn gallery_all_router_parses() {
    let d = parse("gallery_all_router");
    assert!(matches!(d.query, Some(pathql_rs::Query::Delegate(_))));
    assert!(d.resolve.is_some());
}

// ... 其余 fixture 各一个测试断言 1-2 个关键字段
```

**测试要点**：
- 每个 fixture 至少一个测试断言 namespace / name / 关键 union 形态
- round-trip：再加一个测试做 `serde_json::to_string` → `from_str`，断言 PartialEq

**Test**：`cargo test -p pathql-rs --test fixtures`（独立 integration test 二进制）。

---

### S13. Loader trait（`loader.rs`）

```rust
use std::path::PathBuf;
use thiserror::Error;
use crate::ast::ProviderDef;

#[derive(Debug, Clone)]
pub enum Source<'a> {
    Path(&'a std::path::Path),
    Bytes(&'a [u8]),
    Str(&'a str),
}

#[derive(Debug, Error)]
pub enum LoadError {
    #[error("syntax error in {path:?}: {msg}")]
    Syntax {
        path: Option<PathBuf>,
        line: Option<u32>,
        col: Option<u32>,
        msg: String,
    },
    #[error("io error reading {path}: {source}")]
    Io { path: PathBuf, #[source] source: std::io::Error },
    #[error("missing required field `{field}` in {path:?}")]
    MissingField { path: Option<PathBuf>, field: String },
    #[error("type error in {path:?}: {msg}")]
    Type { path: Option<PathBuf>, msg: String },
}

pub trait Loader {
    fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError>;
}
```

本期不实现任何 Loader，只定义接口。

**测试要点**：
- 写一个测试用 mock Loader（返回 `Err(MissingField {..})`）确认 trait 对象可装箱：
  ```rust
  struct MockLoader;
  impl Loader for MockLoader {
      fn load(&self, _: Source<'_>) -> Result<ProviderDef, LoadError> {
          Err(LoadError::MissingField { path: None, field: "name".into() })
      }
  }
  
  #[test]
  fn loader_trait_object_works() {
      let l: Box<dyn Loader> = Box::new(MockLoader);
      let r = l.load(Source::Str("{}"));
      assert!(matches!(r, Err(LoadError::MissingField { .. })));
  }
  ```
- `LoadError::Syntax` 的 `Display` 含 path / msg

**Test**：`cargo test -p pathql-rs loader`。

---

### S14. ProviderRegistry（`registry.rs`）

```rust
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use crate::ast::{Namespace, ProviderName, SimpleName, ProviderDef};

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("duplicate provider: {0:?}.{1:?}")]
    Duplicate(Namespace, SimpleName),
}

#[derive(Debug, Default)]
pub struct ProviderRegistry {
    defs: HashMap<(Namespace, SimpleName), Arc<ProviderDef>>,
}

impl ProviderRegistry {
    pub fn new() -> Self { Self::default() }

    pub fn register(&mut self, def: ProviderDef) -> Result<(), RegistryError> {
        let ns = def.namespace.clone().unwrap_or_else(|| Namespace(String::new()));
        let key = (ns.clone(), def.name.clone());
        if self.defs.contains_key(&key) {
            return Err(RegistryError::Duplicate(key.0, key.1));
        }
        self.defs.insert(key, Arc::new(def));
        Ok(())
    }

    /// Java-package-style fallback: current → parent → ... → root（空 namespace）
    pub fn resolve(&self, current_ns: &Namespace, reference: &ProviderName) -> Option<Arc<ProviderDef>> {
        let (ref_ns, simple) = reference.split();
        if let Some(abs_ns) = ref_ns {
            return self.defs.get(&(abs_ns, simple)).cloned();
        }
        let mut ns_opt = Some(current_ns.clone());
        while let Some(ns) = ns_opt {
            if let Some(found) = self.defs.get(&(ns.clone(), simple.clone())) {
                return Some(found.clone());
            }
            ns_opt = ns.parent();
        }
        self.defs.get(&(Namespace(String::new()), simple)).cloned()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&(Namespace, SimpleName), &Arc<ProviderDef>)> {
        self.defs.iter()
    }

    pub fn len(&self) -> usize { self.defs.len() }
    pub fn is_empty(&self) -> bool { self.defs.is_empty() }
}
```

**测试要点**（`registry.rs` 内 `#[cfg(test)]`）：
- `register_one`：注册 1 个，`len() == 1`
- `register_duplicate`：同 (ns, name) 注册两次 → `RegistryError::Duplicate`
- `resolve_simple_same_ns`：current=`kabegame`, ref=`foo`，注册 `kabegame.foo` → 命中
- `resolve_simple_parent_fallback`：current=`kabegame.plugin.x`, ref=`bar`，仅注册 `kabegame.bar` → 命中（验证父链）
- `resolve_absolute`：current=`a`, ref=`b.c.d`，注册 `b.c.d` → 命中
- `resolve_root_fallback`：current=`kabegame.plugin`, ref=`util`，仅注册 root（空 namespace）下 `util` → 命中
- `resolve_miss`：未注册 → None

**Test**：`cargo test -p pathql-rs registry`。

---

### S15. Phase 1 收尾测试

把所有上面的单测加和后跑一次完整：

```bash
cargo test -p pathql-rs
```

期望：约 30-40 条测试全绿；warning 清零（`cargo build -p pathql-rs --message-format=short`）。

确认 `kabegame-core` 没有引入 `pathql-rs` 依赖（grep core/Cargo.toml）；Phase 1 隔离完成。

---

## 完成标准

- [ ] `cargo check -p pathql-rs` 通过
- [ ] `cargo test -p pathql-rs` 全绿（约 30-40 条单测）
- [ ] 9 个现有 `.json5` 文件的 strict-JSON 等价物全部能反序列化为 `ProviderDef` 而不报错
- [ ] `kabegame-core` 暂未引用 `pathql-rs`
- [ ] 代码无 `unwrap()` / `expect()` 在非测试路径
- [ ] `json5` feature 已声明但未实现（占位）

## 风险点

1. **untagged 顺序敏感**：`Query` / `ProviderInvocation` / `OrderForm` / `DelegateProviderField` 都用 untagged，serde 按声明顺序尝试。要写反样本验证（混合字段被拒）。
2. **`#[serde(deny_unknown_fields)]` 与 `#[serde(default)]` 互动**：当所有字段都是 `Option<T>` + `default` 时，空对象 `{}` 也能反序列化。`Query::Contrib` 接受 `{}` 不会与 `Empty` 混淆——因为 Query 与 ProviderInvocation 是两套独立 union，分别在不同字段位置使用。
3. **List 自定义 Deserialize 错误信息**：手写 visitor 出错时把 key 名带进 `de::Error::custom`，便于排查。
4. **Pattern 校验延后**：Phase 1 的 newtype 接受任意串，避免提前耦合；Phase 3 才做严格 pattern 校验。
5. **`$schema` 字段**：现有文件都有 `"$schema": "../schema.json5"`；`ProviderDef` 用 `#[serde(rename = "$schema")]` 接收并 default + ignore。
6. **fixture 预处理**：手工去 json5 注释/trailing comma 是临时方案；Phase 2 加 json5 适配器后改为直读真文件。

## 完成 Phase 1 后的下一步

Phase 2 实现 `json5` feature：在 `pathql-rs` 内加 `adapters/json5.rs`，实现 `Json5Loader` impl Loader；新增 `discover_dir` 扫描目录批量加载；fixtures 切回真 .json5 文件。
