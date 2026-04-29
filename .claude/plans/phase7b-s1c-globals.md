# Phase 7b-S1c — `${global.X}` 全局变量 + 三处 property 迁移

## Context

实测 `/gallery/hide/all/1` PathNotFound 时溯源到：[gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) 的 JOIN ON 用 `${properties.fav_ai_id}` / `${properties.hidden_ai_id}`，[gallery_hide_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_hide_router.json5) 用 `${properties.hidden_album_id}`，全部带 `default` 字面值。但 [registry.rs:141-144](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs#L141) 实例化 `RegistryEntry::Dsl` 时直接 `properties: properties.clone()` —— caller 没传的 key 一律为空，**`default` 完全没生效**，渲染期 `UnboundProperty` → `composed.build_sql` 返 Err → page_size_provider SQL `${composed}` 无值 → reverse-lookup ERROR → "1" 无 provider 服务。

但这三个 key **没有任何调用点会动态传入**（gallery_route 由 root_provider 静态 list "gallery" 构造，gallery_hide_router 由 gallery_route 静态 list "hide" 构造，都不带 properties）—— 它们本质是**运行期常量**：`HIDDEN_ALBUM_ID` / `FAVORITE_ALBUM_ID` 这种 `core::storage::*` 编译期常量。把它们写成 `properties + default` 是错误抽象；应该走 `${global.X}` 在启动期由 host 注入。

**目标**：
1. pathql-rs 加 `${global.X}` 模板变量（渲染语义同 `${properties.X}` 走 bind-param，作用域同 `${composed}` 全场景可用）
2. core 启动期把 `hidden_album_id` / `favorite_album_id` 注入 ProviderRuntime
3. gallery_route + gallery_hide_router 的 3 处 property 声明删除，模板改 `${global.X}`
4. **修** registry.instantiate 的 property default-fill bug —— 让 `default` 字段真正生效，不让 DSL 写错抽象时再被一次坑

## 关键设计点

**1. Global 是 runtime-frozen，不是 mutable session state**

ProviderRuntime 构造时一次性接收 `globals: HashMap<String, TemplateValue>`，之后只读。理由：
- 简化并发模型（无 RwLock）
- 当前用例（HIDDEN_ALBUM_ID / FAVORITE_ALBUM_ID）就是编译期常量
- 未来要 mutable 再加 setter 不破坏现有 API

**2. 渲染语义对齐 `${properties.X}`**

[render.rs:44-122](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/render.rs#L44) 的 `Segment::Var(other) =>` 分支已经把所有"非 ref / 非 composed"的 VarRef 走 bind-param 路径。`${global.X}` 落到这个分支，**0 修改**渲染层。同理 [parse.rs:109-173](d:/Codes/kabegame/src-tauri/pathql-rs/src/template/parse.rs#L109) parser 不按 ns 字符串 dispatch，`global` 自然解析为 `VarRef::Path { ns: "global", path: [...] }`。

**3. validate 层只允许 namespace，不校验 key 存在**

`${global.fav_ai_id}` 在加载期校验只验证"global 是合法 namespace"，不验证 fav_ai_id 是否已注册。理由：
- core 注册 globals 在启动期 validate 之后（init.rs 链路）
- 缺 key 在 eval 期报 `UnboundGlobal(key)`，错误信息已足够定位

**4. 不动 ProviderContext**

[provider/mod.rs:85-91](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/mod.rs#L85) `ProviderContext { registry, runtime }` 已经持 `Arc<ProviderRuntime>`。`base_template_context` 只需在构造 TemplateContext 时拿 `ctx.runtime.globals().clone()` 填进去，不加新字段。

## 子任务

### S1c-a — pathql-rs engine 扩展（一次 commit）

| 文件 | 改动 |
|---|---|
| [template/eval.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/template/eval.rs) `TemplateContext` (行 50-62) | 加 `pub globals: HashMap<String, TemplateValue>` 字段 |
| [template/eval.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/template/eval.rs) `evaluate_var` (行 112-149) | `VarRef::Path { ns, path }` 分支加 `ns == "global"` 入口（在 properties / data_var / child_var 之后；返 `UnboundGlobal` 错误） |
| [template/eval.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/template/eval.rs) `EvalError` enum | 加 `UnboundGlobal(String)` variant |
| [template/eval.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/template/eval.rs) test 模块 | 加 `${global.X}` 命中 / 未命中 / 与 properties 同 key 不冲突 3 个 case |
| [provider/runtime.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/runtime.rs) `ProviderRuntime` 结构 (行 38-46) | 加 `globals: Arc<HashMap<String, TemplateValue>>` 字段 |
| [provider/runtime.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/runtime.rs) `new(...)` (行 48-60) | 签名加 `globals: HashMap<...>` 第 4 参数；6d 起 executor 必填，本期 globals 同步必填（空 map 也得显式传） |
| [provider/runtime.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/runtime.rs) | 加 `pub fn globals(&self) -> &HashMap<String, TemplateValue>` getter |
| [provider/dsl_provider.rs:32-38](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/dsl_provider.rs#L32) `base_template_context` | 构造 TemplateContext 时填 `tctx.globals = ctx.runtime.globals().clone()`。当前签名是 `&self, captures` 不收 ctx —— 改成 `&self, ctx: &ProviderContext, captures: &[String]`，跟改 14 处调用 |
| [validate/meta_check.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/validate/meta_check.rs) (行 30 / 36-42 / 46-52 / 75) | `allowed_ns` 数组加 `"global"` |
| [validate/dynamic.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/validate/dynamic.rs) | grep `allowed_ns` 找全 scope 校验站点，全部加 `"global"` |
| pathql-rs `ProviderRuntime::new(...)` 现有调用点 | 测试 + integration tests + core init 全部跟改第 4 参数（默认 `HashMap::new()`） |

**测试**：
- `cargo test -p pathql-rs --features "json5 validate"` 全绿
- 新加 unit test：`${global.X}` 渲染产生 bind-param + validate scope 通过 + 与 properties 共存（不同 key）

### S1c-b — core 注入 + DSL 迁移（一次 commit）

| 文件 | 改动 |
|---|---|
| [core/src/providers/init.rs](d:/Codes/kabegame/src-tauri/core/src/providers/init.rs) `init_runtime` (行 27-45) | 构造 `globals` HashMap：`hidden_album_id` ← `crate::storage::HIDDEN_ALBUM_ID`；`favorite_album_id` ← `crate::storage::FAVORITE_ALBUM_ID`（统一命名用 `album_id` 后缀，弃 `ai_id` 含糊缩写）；传给 `ProviderRuntime::new(reg, root, exec, globals)` |
| [dsl/gallery/gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) (行 5-17) | 删除 `properties` 块（fav_ai_id / hidden_ai_id 两条） |
| [dsl/gallery/gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) JOIN ON | `${properties.fav_ai_id}` → `${global.favorite_album_id}`；`${properties.hidden_ai_id}` → `${global.hidden_album_id}` |
| [dsl/gallery/gallery_hide_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_hide_router.json5) | 删除 `properties.hidden_album_id` 块；删除 `query.fields`（is_hidden CASE）+ `query.join`（hid_ai in_need）整体 —— gallery_route 已提供，hide_router 留下也是死代码 |
| [dsl/gallery/gallery_hide_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_hide_router.json5) `query.where` | `"not is_hidden"` → `"hid_ai.image_id IS NULL"` —— SQLite 不让 WHERE 引用 SELECT 别名；直接用父级 JOIN 的表列，语义等价（parent 的 LEFT JOIN 没匹配上 = 该图没被隐藏） |
| 净结果 | gallery_hide_router 只剩 `query.where`（一行 SQL）+ `resolve."." 转发`，体积比迁移前小一半 |

**已知遗留（不在本期处理）**：暂无 —— hide WHERE 已并入 S1c-b 顺手修。

### S1c-c — registry property default-fill 修复（一次 commit）

[registry.rs:141-144](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs#L141) 当前 `RegistryEntry::Dsl` 分支直接 `properties: properties.clone()` —— DSL 声明的 `default` 完全没生效。

**修法**：构造 DslProvider 前用 `def.properties` 的 default 填充 caller 没传的 key。

| 文件 | 改动 |
|---|---|
| [registry.rs:107-146](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs#L107) `instantiate` Dsl 分支 | 新增本地 helper `fill_defaults(def_props: &Option<HashMap<String, PropertyDecl>>, caller: &HashMap<String, TemplateValue>) -> HashMap<String, TemplateValue>`：先扫 def_props，每个声明的 key 若有 default 则填入；再用 caller 的 entries 覆盖（caller 优先）。返回的 map 作为 DslProvider.properties |
| [registry.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs) imports | 加 `use crate::ast::property::{PropertyDecl, PropertySpec}` |
| 默认值类型转换 | `PropertySpec::Number { default: Some(f64) }` → 整数走 `TemplateValue::Int`，否则 `TemplateValue::Real`；`String { default: Some(s) }` → `TemplateValue::Text`；`Boolean { default: Some(b) }` → `TemplateValue::Bool`；`default: None` 跳过（caller 没传 + 无 default → 不填，eval 期 `UnboundProperty` 自然报错） |
| [registry.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs) test 模块 | 加 3 个 case：(a) caller 不传，default 生效；(b) caller 传值，覆盖 default；(c) 无 default + caller 不传 → DslProvider.properties 该 key 缺失（用模板时 eval 期报 UnboundProperty） |

**与 S1c-b 的关系**：S1c-b 删 3 处 property 后，default-fill 在当前 .json5 里没有触发用例。但 page_size_provider 仍声明 `page_size: { default: 1 }`，本期之后 caller 不传时也会得到 1（合规行为，不破坏现有测试 —— 现有测试都通过 properties 传 page_size，default 路径只是被正确激活但行为不变）。

### 子任务执行顺序

1. S1c-a engine 扩展（globals 字段 / VarRef 分支 / Runtime 构造 / scope 校验）
2. S1c-c default-fill 修复（独立改动，不依赖 a/b）
3. S1c-b core 注入 + DSL 迁移（依赖 S1c-a，不依赖 S1c-c —— 但 c 先做后顺序更稳：万一漏迁某个 property 引用，default-fill 兜底不挂）

也可顺序 a → b → c（先把核心功能跑通，default-fill 作为兜底补一刀）。两种顺序的最终状态一致，由实现者选。

## 验证

1. `cargo test -p pathql-rs --features "json5 validate"` 全绿
2. `cargo check -p kabegame-core` 干净
3. `bun dev -c main --data prod`，浏览：
   - `/gallery/all/` → 默认页有图（is_hidden / is_favorite 列正常）
   - `/gallery/all/1/` → 反查 page_size_provider 命中 "1"，不再 PathNotFound
   - `/gallery/all/x100x/1/` → 既有 regex 路径继续工作
   - `/gallery/hide/all/1/` → hide WHERE 生效（隐藏图被过滤），列表正常显示非隐藏图
4. 调试日志（`PATHQL_DEBUG`）确认 `${global.hidden_album_id}` 在渲染期被正确替换为 bind 参数，效果 SQL 形如 `... AND hid_ai.album_id = ?` + params 含 `"00000000-0000-0000-0000-000000000000"`

## 风险

- **`base_template_context` 签名改加 `&ProviderContext`**：14 处调用链需要跟改（含 `eval_properties` / `render_key_template` / `eval_meta` 内部链）。机械改动但散点多。
- **多套 `ProviderRuntime::new` 调用点**：pathql-rs 内 + core init + 测试 fixture，全部 grep 找全跟改第 4 参数。
