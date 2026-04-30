# Provider DSL 引擎 Rust 实现 — 分期计划

## Context

DSL 规范（[`cocs/provider-dsl/RULES.md`](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) + [`schema.json5`](d:/Codes/kabegame/src-tauri/core/src/providers/schema.json5) + [`VD_INTEGRATION.md`](d:/Codes/kabegame/cocs/provider-dsl/VD_INTEGRATION.md)）已稳定，但 Rust 侧 **完全未实现**——9 个 provider 文件（1 `.json` + 8 `.json5`）存在却无人加载，所有运行期 provider 仍是 [`provider.rs`](d:/Codes/kabegame/src-tauri/core/src/providers/provider.rs) 中 hardcoded 的 trait impl（GalleryRoot/VdRoot/QueryPage 等 15+ 个）。

**目标**：增量构建一个解释器式 DSL 引擎，让 `.json5` 文件能被加载并实例化为 `Provider` trait 实现接入现有 [`ProviderRuntime`](d:/Codes/kabegame/src-tauri/core/src/providers/runtime.rs)；硬编码 provider 在后续迭代中**逐个迁移到 DSL** 直到全部替换。

**约束**：
- 每期 `cargo test -p kabegame-core` 必须独立通过；不引入跨期编译依赖
- 不修改 RULES.md / schema.json5（除发现规范遗漏需用户决策时）
- 没有"权宜兼容"路径——任何看起来像 ImageQuery 包装、降级、桥的代码都不写

## 关键设计决策（已锁定）

### 决策 1：ImageQuery 全量替换为 ProviderQuery（一次性切换）

不做 "ComposedQuery 包装 ImageQuery" 路线。新类型 **`ProviderQuery`** 是 DSL 的查询累积单元，
直接持有 RULES.md §3 的全部字段（`from / fields / joins / where / order / offset_terms / limit / ref_aliases`），
也是 SQL 拼装的最终输出。最终目标：**移除 ImageQuery**，让动态加载的 ProviderQuery 直接产出 ImageInfo 所需的全部字段。

落地路径：
- Phase 4 定义 `ProviderQuery`，自带 `build_sql()` 与 SQL 执行能力
- 修改 `Provider` trait：`fn apply_query(current: ProviderQuery) -> ProviderQuery`（直接替换签名，不留 ImageQuery 重载）
- 现有 15+ 硬编码 trait impl 逐个改造为消费 ProviderQuery；其内部 `with_join` / `with_where` 等调用映射到 ProviderQuery 等价 API
- [`Storage::get_images_count_by_query`](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L655) / [`get_images_info_range_by_query`](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L678) 改签名接 ProviderQuery；它们内部用 `ProviderQuery::build_sql()` 拼装 SQL，不再自己拼 from/limit/offset
- 切换完成后删除 [`ImageQuery`](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L11-L25) 类型

### 决策 2：AST 加载器独立于 core，走适配器模式

DSL 加载层不在 `kabegame-core` 内。新建独立 crate **`pathql-rs`**（建议路径 `src-tauri/pathql-rs/`），
导出：
- AST 类型（schema 对应的全部 Rust 结构）
- `Loader` trait（输入 = 抽象源；输出 = `Result<ProviderRegistry, LoadError>`）
- json5 适配器（实现 `Loader`，作为 feature `json5` 的默认实现）

`kabegame-core` 依赖该 crate + 启用 `json5` feature。未来增加 yaml / toml / 二进制 cache 适配器只需新增模块或 feature，
core 不变。**不在 core 里直接写 json5 反序列化代码。**

### 决策 3：DslProvider 实现 `Provider` trait，与硬编码 provider 共存

`DslProvider { def: Arc<DslProviderDef>, properties: HashMap<...>, registry: Arc<ProviderRegistry> }`
持有解析后 AST 与实例化属性，`apply_query / list_children / get_child / get_meta / get_note` 全靠解释 AST 完成。
ProviderRuntime 不感知一个 provider 是 DSL 还是硬编码——共用 trait 抽象。

### 决策 4：ChildEntry.meta 加 `Json(serde_json::Value)` 变体

[`ProviderMeta`](d:/Codes/kabegame/src-tauri/core/src/providers/provider.rs#L27-L33) 现为 typed enum（Album/SurfRecord/Task/Plugin/RunConfig）。
新增 `Json(serde_json::Value)` 变体承载 DSL untyped meta；前端序列化保持向后兼容（已有 typed 变体走原 schema，新 variant 直接展开 JSON）。

### 决策 5：新依赖

加在 `pathql-rs` crate（不在 core）：`json5`、`sqlparser`、`regex-automata`、`regex`、`serde`、`serde_json`。
core 仅新增对 `pathql-rs` 的 path dependency。

---

## 分期实现

### Phase 1 — `pathql-rs` Crate 脚手架 + AST + Loader trait

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase1-dsl-ast-loader.md](d:/Codes/kabegame/.claude/plans/phase1-dsl-ast-loader.md)

**目标**：建立独立 crate `pathql-rs`（**不再叫 `pathql-rs`**）；定义 schema 对应的全部 Rust AST 类型；定义抽象 `Loader` trait + `ProviderRegistry`。**不实现任何适配器**——本期只搭骨架与抽象，json5 仅在 `Cargo.toml` 声明 feature 占位。

**新 crate**：`src-tauri/pathql-rs/`
- `Cargo.toml`：`serde` / `serde_json` / `thiserror`；声明 `[features] json5 = []`（实现见 Phase 2）
- 加入根 [`Cargo.toml`](d:/Codes/kabegame/Cargo.toml) workspace members

**核心模块**：
- `src/ast/` — 子模块 `names` / `expr` / `property` / `query_atoms` / `order` / `query` / `invocation` / `list` / `resolve` / `provider_def`，覆盖 schema 全部 discriminated union
- `src/loader.rs` — `trait Loader { fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError>; }`，`Source { Path, Bytes, Str }`，`LoadError` 含 path/line/col
- `src/registry.rs` — `ProviderRegistry`，含 Java 包风格父链查找的 `resolve(current_ns, ref) -> Option<Arc<ProviderDef>>`

**关键设计要点**（详见详细计划）：
- `PropertyDecl` 提取 `optional` 到外层公共结构，`default` / `min` / `max` / `pattern` 等类型特定字段在内层 `PropertySpec` 枚举里（`#[serde(flatten)]`）
- `OrderArrayItem` 用 `Vec<(String, OrderDirection)>` 自维护保序（**允许多键**）
- `List` 手写 `Deserialize` visitor，按 key 是否含 `${ident.field}` 分流静态 / 动态
- `Resolve` 是 transparent newtype 包 `HashMap<String, ProviderInvocation>`（**无 `entries` 包装**）
- 所有 `TemplateExpr` / `SqlExpr` / `PathExpr` 都是 transparent newtype；解析与校验留给后续 phase
- 测试用 `serde_json::from_str` 喂手工 strict-JSON fixture（去注释 / trailing comma 后的 .json5 等价物）

**完成标准**：`cargo test -p pathql-rs` 全绿（约 30-40 条单测）；core 暂不引用此 crate。

---

### Phase 2 — json5 适配器

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase2-json5-adapter.md](d:/Codes/kabegame/.claude/plans/phase2-json5-adapter.md)

**目标**：在 `pathql-rs` 内实现 `Json5Loader`（feature `json5` 下编译），让真 `.json5` 文件（含注释、trailing comma、单引号）能被反序列化为 `ProviderDef`。

**关键边界**——本期 **不做** 目录扫描 / 文件发现：
- ❌ 不实现 `discover_dir`
- ❌ 不引入 `walkdir` 依赖
- ❌ pathql-rs 内零文件系统遍历代码

理由：实际加载策略由消费者（`kabegame-core`）决定。**Phase 6 中 core 会用 `include_dir!()` 宏在编译期把 `src-tauri/core/src/providers/` 嵌入二进制，运行期遍历 embedded entries 把每份字节喂给 `Json5Loader::load(Source::Bytes)` → `Registry::register`**。pathql-rs 只暴露其中两个原语（Loader + Registry），不参与 IO 编排。

**新依赖（仅在 pathql-rs，feature gated）**：`json5 = "0.4"`

**新文件**：
- `src-tauri/pathql-rs/src/adapters/mod.rs` — 模块根 + feature gate
- `src-tauri/pathql-rs/src/adapters/json5.rs` — `Json5Loader` unit struct，实现 `Loader`，处理 `Source` 三态（Bytes 是核心路径，Path 是开发便利）
- `src-tauri/pathql-rs/tests/load_real_providers.rs` — 集成测试，硬编码 9 个文件清单（**不递归扫描**），逐个 `Source::Path` 喂入 + `register`，模拟 Phase 6 的 include_dir 流程

**关键测试**：
- `Json5Loader` 单测：合法 .json5 / 注释 / trailing comma / 单引号 / 语法错（含行列号）/ utf-8 错 / 缺字段 / IO 错 / trait object
- 集成测试：9 个真 .json5 文件全部加载并注册；`Source::Bytes` 路径独立验证

**完成标准**：
- `cargo test -p pathql-rs` 全绿（不开 feature；Phase 1 单测）
- `cargo test -p pathql-rs --features json5` 全绿（Phase 1 + Phase 2 总约 45-55 条）
- 9 个 provider 文件全部成功 register
- core 仍未引用 pathql-rs

---

### Phase 3 — 加载期语义校验（pathql-rs `validate` feature）

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase3-validation.md](d:/Codes/kabegame/.claude/plans/phase3-validation.md)

**目标**：在 `pathql-rs` 内实现 RULES.md §10 全部校验，作为 `validate` feature。失败返回 `Vec<ValidateError>`，由消费者（Phase 6 的 core）在 startup-once 调用，失败则 panic 启动并打印全部错误。

**新依赖（feature gated）**：`regex` / `regex-automata` / `sqlparser`（仅 `validate` feature 下编译）

**附带成果**：`src/template/parse.rs` 模板解析器（永久编译，无 feature gate；不含求值器）—— 给 validate 做 scope 校验用，Phase 5 的求值器复用同一 parser。

**职责分配**：
- pathql-rs 提供 `validate(&ProviderRegistry, &ValidateConfig) -> Result<(), Vec<ValidateError>>`
- 消费者（core）传入 `ValidateConfig { table_whitelist }` 注入业务表白名单
- pathql-rs **不**校验 "name 字段等于文件名"——它看不到文件名（include_dir 字节流不带逻辑名）；这条转为消费者 / core 在 include_dir 遍历时配 `entry.path().file_stem()` vs `def.name` 自检

**校验类别**（详见详细计划）：
- 命名 & PathExpr 结构（无外部 dep）
- ContribQuery `${ref:X}` 解析、`as: ${ref:...}` 与 `in_need` 互斥、`from` JOIN warn
- DynamicListEntry 模板 scope（X = child_var/data_var）+ 保留标识符
- Resolve 正则编译 + vs 静态字面碰撞 + vs 正则交集（regex-automata）+ `${capture[N]}` 边界
- SqlExpr：sqlparser SQLite 方言 + `${...}` → `:p0` 占位预处理 + 多语句 / DDL 拒绝 + 表白名单
- 跨 provider 引用通过 registry 命名空间链解析
- Meta 字段（字符串=SQL/模板启发式 → 走 SQL/scope 校验；对象/数组递归）

**完成标准**：
- 9 个真 .json5 文件通过 validate（0 错误）
- 18 条 bad fixture 各命中预期 `ValidateErrorKind`
- `cargo test -p pathql-rs --features "json5 validate"` 全绿

---

### Phase 4 — `ProviderQuery` 类型 + ContribQuery 结构化折叠

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase4-provider-query-fold.md](d:/Codes/kabegame/.claude/plans/phase4-provider-query-fold.md)

**目标**：定义 `ProviderQuery` 替换 ImageQuery；实现 RULES.md §3 全部**结构化**累积语义。本期**不**做 SQL 字符串生成 / 模板求值；产出的 `ProviderQuery` 是结构化中间表示（IR），下一期才渲染为 SQL。

**位置选择**：ProviderQuery 在 `pathql_rs::compose` 模块（feature `compose`）；core 后续迁移会引用此类型。

**新文件（在 pathql-rs，feature `compose`）**：
- `src/compose/mod.rs` / `src/compose/query.rs` —— `ProviderQuery` struct + builder API
- `src/compose/fold.rs` —— `fn fold_contrib(state: &mut ProviderQuery, q: &ContribQuery) -> Result<(), FoldError>` 实现六条累积规则
- `src/compose/order.rs` —— OrderState（维护字段方向 vec + 全局 modifier）
- `src/compose/aliases.rs` —— `${ref:X}` 别名分配表

**新依赖**：本期**无新外部 dep**——纯结构化 Rust 代码；rusqlite 类型留到 Phase 5 SQL 渲染时引入。

**累积规则**（RULES §3）：
- `from` cascading-replace
- `fields[]` / `join[]` additive，按 `as` 去重共享，支持 `in_need` 跳过 + `${ref:X}` 自动分配
- `where` additive AND
- `order` 数组形态位置定优先级 + 全局 `{all}` modifier
- `offset` additive `+`
- `limit` last-wins

**关键测试**：
- 单 fold：每条累积规则一个 fixture
- 多 fold：模拟 `gallery_route → gallery_all_router → ...` 路径链；snapshot 最终 ProviderQuery 状态
- `${ref:X}` 自动分配：跨 provider 同 ident 解析为同一 alias
- `as + in_need` 重名：前者无 in_need → 报错；后者 in_need=true → 跳过

**完成标准**：`cargo test -p pathql-rs --features compose` 全绿；ProviderQuery 结构化输出与人工预期一致。**不涉及 SQL 字符串**。

---

### Phase 5 — 模板求值器 + ProviderQuery → SQL 渲染

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase5-template-eval-sql-build.md](d:/Codes/kabegame/.claude/plans/phase5-template-eval-sql-build.md)

**目标**：实现 RULES.md §6 的 `${...}` 求值器（复用 Phase 3 的 parser），并把 Phase 4 的 ProviderQuery 渲染为可执行 SQL 字符串 + bind params。**核心 dialect-agnostic**：`build_sql` 输出 `(String, Vec<TemplateValue>)`，pathql-rs 的 `compose` feature **不**依赖任何 DB 驱动。SQL 驱动桥接走单独的 `sqlite` feature 适配器（决策 3，参见架构记忆）。

**新文件（在 pathql-rs）**：
- `src/template/eval.rs` —— `struct TemplateContext { properties, capture, data_var, child_var, composed }`，`enum TemplateValue { Null, Bool, Int, Real, Text, Json }`，`fn evaluate_var(var, ctx) -> Result<TemplateValue, EvalError>`
- `src/compose/render.rs` —— `fn render_template_sql(template, ctx, aliases, sql_buf, params_buf) -> Result<(), RenderError>` 通用 SQL 模板渲染器；处理 inline (`${ref:X}` / `${composed}`) + bind (`${properties.X}` 等) 替换
- `src/compose/build.rs` —— `impl ProviderQuery { fn build_sql(&self, ctx: &TemplateContext) -> Result<(String, Vec<TemplateValue>), BuildError> }`
- `src/adapters/sqlite.rs` —— **新 feature `sqlite`**；`fn to_rusqlite(&TemplateValue) -> rusqlite::types::Value` + `fn params_for(&[TemplateValue]) -> Vec<...>` 一对一映射

**新 feature**：
- `compose = []` —— 0 新外部 dep；产出 `(String, Vec<TemplateValue>)` 即 ANSI `?` 占位 SQL + 中性参数序列
- `sqlite = ["compose", "dep:rusqlite"]` —— 启用 `adapters::sqlite` 模块；引入 rusqlite

**关键实现点**：
- 模板求值：VarRef 各形态从 TemplateContext 取值；返回 `TemplateValue`
- bind 占位：`${properties.X}` / `${capture[N]}` / `${data_var.X}` / `${child_var.X}` 替换为 `?` + push 到 params vec
- inline 替换：`${ref:my_id}` 替换为 fold 期分配的字面别名 `_aN`；`${composed}` 替换为 `(子 SELECT)` 并合并子层 params
- order 渲染：先解 array entries，再用全局 modifier 翻转 / 强制方向（revert/asc/desc）
- offset 累加：`(o1) + (o2) + ...`；字面数字直接打印
- limit last-wins：渲染最末一次的 NumberOrTemplate

**测试**：
- 模板求值单测（约 13 case，覆盖 properties/capture/data_var/child_var + 错误路径）
- 渲染器 render_template_sql 单测（mixed inline+bind，约 9 case）
- ProviderQuery → SQL snapshot：选真实路径 fold + build，对比期望 SQL 字符串 + bind params
- `${composed}` 子查询嵌入：动态 list sql 模式
- sqlite 适配器单测：6 种 TemplateValue 转 rusqlite Value
- 集成测试：fold 真路径 → build_sql → 通过 sqlite 适配器在 in-memory SQLite 上执行

**完成标准**：
- `cargo test -p pathql-rs --features compose` 全绿（**无 rusqlite 依赖**）
- `cargo test -p pathql-rs --features sqlite` 全绿（含适配器）
- `cargo build -p pathql-rs --features compose` 产物**不含** rusqlite 库；`cargo build -p pathql-rs --features sqlite` 产物含 rusqlite
- core 仍未引用 pathql-rs

---

### Phase 6 — core 集成（细分为 6a / 6b / 6c / 6d / 6e 五个子期）

Phase 6 改动面广。**重大架构调整**（已对齐 [RULES.md §12](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) Provider 体系抽象接口规范）：

- Provider trait + ChildEntry + ProviderRuntime + ProviderRegistry 编程注册接口**全在 pathql-rs**（不在 core）
- ChildEntry 结构 `{ name, provider?, meta? }`——**无 `total` 字段**
- Provider trait 方法命名严格对齐 DSL 字段：`apply_query / list / resolve / get_note`
- **ctx-passing 设计**：Provider 方法都收 `&ProviderContext`；ctx 含 `Arc<Registry> + Arc<Runtime>`；Provider 实现**不持** registry/runtime 字段，状态最小化、无循环引用
- ProviderRegistry 支持 DSL + 编程混合注册；`register_provider(ns, name, factory)` factory 签名仅 `Fn(&props) -> Result<Provider>`
- DSL 加载允许未解析引用（cross_ref 默认 off）；运行期 lookup
- `compose` feature 已删除；剩余 feature 仅 `json5` / `validate` / `sqlite`

#### Phase 6a — pathql-rs Provider 体系内核（pathql-rs 内部）

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase6a-foundation.md](d:/Codes/kabegame/.claude/plans/phase6a-foundation.md)

**目标**：在 **pathql-rs 内**新增 Provider 体系内核——Provider trait + ChildEntry + ProviderRuntime（含 longest-prefix 缓存）+ ProviderRegistry 编程注册 + DslProvider 静态部分。core 完全未动。

**子任务**：
- **Spre** 删除 `compose` feature gate（让 ProviderQuery / fold / build_sql 默认编译）
- **S0** pathql-rs ProviderQuery raw-bind API（`with_where_raw / with_join_raw / with_order_raw / with_field_raw`）—— Phase 4 遗漏此 API，本期补回
- **S1** `provider/mod.rs` ChildEntry + Provider trait（含 ctx 参数）+ EngineError + ProviderContext
- **S2** Registry 加 `RegistryEntry::Programmatic(factory)` + `register_provider(ns, name, factory)` + `instantiate(...)` helper；validate 模块跳过 Programmatic 项
- **S3** DslProvider 静态部分（apply_query 完整 + list 仅静态项 + resolve 仅 regex+静态字面 + get_note 模板渲染）
- **S4** ProviderRuntime（含 longest-prefix cache lookup + 大小写敏感 + Weak<Self> 用于 ctx 构造）
- **S5** DslProvider materialize / instantiate helpers 收尾（meta 字段非 SQL 形态支持）
- **S6** 集成测试 `tests/programmatic_runtime.rs`：完全用 register_provider 验证 runtime（不接 DSL，不接 SQL 执行）
- **S7** 真实 sqlite 端到端 `tests/runtime_real_sqlite.rs`：programmatic provider + 真 in-memory sqlite + 完整 fold→build_sql→params_for→rusqlite 执行链

**完成标准**：`cargo test -p pathql-rs --features "json5 validate sqlite"` 全绿（约 391 + S7 4 = 395 测试）；core 完全未动。

---

#### Phase 6b — core 接入 pathql-rs + ImageQuery 全量切换

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase6b-imagequery-flip.md](d:/Codes/kabegame/.claude/plans/phase6b-imagequery-flip.md)

**目标**：core 端旧 Provider 体系全部废弃——通过 `register_provider` 把 33 处硬编码 provider 注册到 pathql-rs Registry；core ProviderRuntime 替换为 pathql-rs 版本；删除 `ImageQuery` / `SqlFragment`。**6b 不接 DSL**（feature 集仅 `["sqlite"]`），用编程注册验证 runtime。

⚠️ **本期 core 中间状态会编译失败**——专用本地分支；S2 后单调向 broken / S6/S7 后逐步回到 clean。**每个子任务即一次 commit checkpoint**（即使不可编译，commit message 必须明示已覆盖范围 + 剩余 broken 范围）；详细 commit 模板见 [phase6b-imagequery-flip.md](d:/Codes/kabegame/.claude/plans/phase6b-imagequery-flip.md) 各 §S* "Checkpoint state / Commit message" 块。

**子任务（commit checkpoint 边界）**：

阶段 0（compile-clean）：
- **S1** core/Cargo.toml 加 `pathql-rs = { features = ["sqlite"] }`（编译通过；纯 dep）

阶段 1（compile-FAIL begins）：
- **S2** core 旧 `ProviderMeta` enum 废弃 + provider.rs reexport pathql-rs 类型 + `wrap_typed_meta_json` helper 保前端 wire format 兼容（**首破点**：trait signature 切换 → 22 个 provider 全失配）
- **S3** Storage `get_images_*_by_query` 改 ProviderQuery；外部 offset/limit 参数删除；`params_for` 喂 rusqlite
- **S4a** gallery/* 6 文件迁移到 ctx-passing Provider trait（`gallery/{album,all,date,date_range,hide,search}.rs`）
- **S4b** shared/* 10 文件迁移（`shared/{album,date/*,hide,media_type,plugin,search,sort,surf,task}.rs`；`shared/sort.rs` `to_desc()` → `current.order.global = Some(OrderDirection::Revert)`）
- **S4c** vd/* 4 文件迁移（22 个 provider 全部对齐新 trait）
- **S5** `core/src/providers/programmatic.rs`：33 个 register_xxx 函数 + `register_all_hardcoded` aggregator；factory 闭包 `Fn(&props) -> Result<Provider>` 不收 ctx
- **S6** core ProviderRuntime swap：删旧 `runtime.rs`；新 `init.rs` 用 OnceLock + `ProviderRuntime::new(registry, root)`；root 通过 `registry.lookup + factory.call` 直接构造（**S6 末理论上 build clean**，但旧 ImageQuery 类型仍存活、`#[cfg(test)]` 仍破）

阶段 2（compile-clean 恢复）：
- **S7** 删除 `ImageQuery` / `SqlFragment` + 全工程 cleanup（build clean；test 仍破）
- **S8** 测试套件修整 + cargo test + bun check + 手测 dev server（最终 clean checkpoint，唯一可合并 trunk 的状态）

**完成标准**：`cargo test -p kabegame-core` 全绿；全工程 grep `ImageQuery` / `SqlFragment` 0 引用；行为零回归；DSL 仍未启用。

---

#### Phase 6c — DSL 加载启用 + DslProvider 收尾 + SqlExecutor 注入

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase6c-dsl-runtime-boot.md](d:/Codes/kabegame/.claude/plans/phase6c-dsl-runtime-boot.md)

**目标**：完成 DSL 路径——pathql-rs DslProvider 动态部分（dynamic SQL list / dynamic delegate / 动态反查）+ `SqlExecutor` 抽象注入；core 启用 `json5` + `validate` feature；把 9 个 .json5 集中到 `core/src/providers/dsl/` 后用 `include_dir!()` 嵌入加载 + validate；root 切换为 DSL 的 `kabegame.root_provider`；IPC 层暴露当前节点 meta（不再硬编码 None）。9 个 DSL-covered 的 programmatic 注册跳过；其余 30 个 hardcoded 仍走编程；DSL 与 programmatic 共存。

**6a/6b 实测校正**：apply_query Query::Delegate / get_note 模板插值 / EngineError::ExecutorMissing / wrap_typed_meta_json / runtime.note 均已就绪；programmatic register 实测 39 项（非计划描述的 33）；`include_dir` 未在 workspace deps，6c S1 必须真正添加。

**子任务**：
- **S0** pathql-rs：`SqlExecutor = Arc<dyn Fn(&str, &[TemplateValue]) -> Result<Vec<JsonValue>, EngineError>>` 抽象 + `ProviderRuntime::new_with_executor` + DslProvider 完整动态 list（dynamic SQL via executor / dynamic delegate via runtime.resolve）+ 动态反查；新 helper `render_template_to_string`（注：`EngineError::ExecutorMissing` 已就绪不重做）
- **S0d** pathql-rs `tests/dsl_dynamic_sqlite.rs`：DSL 动态 list (SQL 数据源) + SqlExecutor 包 rusqlite + 真 in-memory sqlite 端到端
- **S1pre** 把 9 个 .json5 + schema.json5 + root_provider.json **`git mv` 到 `core/src/providers/dsl/`** 子目录；`pathql-rs/tests/load_real_providers.rs` 路径常量同步更新；让 include_dir 范围最小化、不混入业务 .rs 源码
- **S1** core/Cargo.toml feature 集升级 `["json5", "validate", "sqlite"]` + 根 Cargo.toml 加 `include_dir = "0.7"` workspace dep（实测当前**未加**）
- **S2** core SqlExecutor 实现（`core/src/providers/sql_executor.rs` 包 rusqlite + row → JsonValue；含锁重入约束注释）
- **S3** core DSL loader 模块（`include_dir!("$CARGO_MANIFEST_DIR/src/providers/dsl")` 嵌入 + Json5Loader.load + validate；fail-fast）
- **S4** `register_all_hardcoded` 跳过 9 个 DSL-covered 名字：S4a 先 grep 核对 9 名字均在当前 39 处 register 内；S4b 注释跳过相应调用（**39 - 9 = 30** 项 programmatic，非原计划写的 24）
- **S5** core init.rs 改造：先 register hardcoded → 再 load DSL → 注入 SqlExecutor → root 通过 registry.lookup + DslProvider 直接构造
- **S5bis** **新增**：IPC 层暴露当前节点 meta —— S5bis-a `runtime.meta(path)` API（走父 list 找名字）；S5bis-b `query.rs` 替换 `meta: None` 为 `rt.meta(&rt_path)`；S5bis-c `tests/dsl_typed_meta_wire.rs` 验证 `{kind, data}` wire format 兼容（Phase 7 预防）
- **S6** pathql-rs `tests/dsl_full_chain_sqlite.rs`：加载 9 个真 .json5 + mock programmatic provider 模拟 30 个硬编码项 + 真 in-memory sqlite 全链端到端（**端到端测试都在 pathql-rs 内**，core 不写集成测试；`runtime.cache_size()` 测试访问器未必 public，缺则本期顺手加 #[cfg(any(test, feature = "test-internals"))]）
- **S6b** core 验证：cargo test + bun check + 手测 dev server 浏览主路径不回归
- **S7** 前端 ProviderMeta wire format 验证（9 个 .json5 当前无 meta 字段，预期不冲击前端；S5bis-c inline DSL 测试已为 Phase 7 typed meta 预先验证 wire 路径）

**完成标准**：9 个 DSL provider 真正被 ProviderRuntime 解释执行；动态 list SQL 通过 SqlExecutor 跑通；`runtime.meta(path)` API 实现 + IPC 不再硬编码 None；pathql-rs 内全链 sqlite + dynamic list sqlite + typed-meta wire 三组测试全过；`runtime.resolve("/gallery/all/x100x/1/")` 走 DSL 链；二进制不含 .rs 业务源码（include_dir 范围限定 dsl/）。dangling provider（如 `vd_en_US_root_router` / `gallery_albums_router` 的 DSL 版本）仍未补——Phase 7 处理；per-child total = None 与 Phase 7 非 SQL executor 抽象都列入 Phase 7 起点。

---

#### Phase 6d — Executor trait 化 + 强制注入 + drivers 模块清退

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase6d-executor-cleanup.md](d:/Codes/kabegame/.claude/plans/phase6d-executor-cleanup.md)

**目标**：收尾 6c 没动的 executor 设计 + 消除 pathql-rs 对 rusqlite 的暴露。`SqlExecutor` 从 type alias `Arc<Fn>` 改 trait（带 `dialect()` 方法）；`ProviderRuntime` executor 必填（删除 Option / `EngineError::ExecutorMissing` / `new_with_executor`）；删除 `pathql_rs::drivers::sqlite` 模块整个目录 + `sqlite` feature + `rusqlite` 主依赖；类型桥下沉到 core `storage/template_bridge.rs`（`pub(crate)` 私有）；`build_sql` 加 dialect 参数（6d 仅完整支持 Sqlite，Postgres / Mysql 占位）。

**承接 6c 实测**：6c 实际未实现 executor 强制 / dialect / sync-async 切换 / drivers 删除等设计；这些都推到 6d。

**子任务（commit checkpoint 边界）**：

阶段 A（compile-FAIL，pathql-rs 内部翻转）：
- **S1** pathql-rs `SqlExecutor` 改 trait（含 `dialect()`）+ `ClosureExecutor` helper + `SqlDialect` enum + `build_sql(ctx, dialect)` + `EngineError::ExecutorMissing` 删除 + Runtime executor 强制（删 `new_with_executor` / `Option`）

阶段 B（compile-FAIL persist，drivers 删 + bridge 下沉）：
- **S2** pathql-rs 删 `drivers/` 目录 + `sqlite` feature + 主依赖 `rusqlite`；rusqlite 移到 `[dev-dependencies]`；4 个集成测试文件内联 `local_params_for` helper 替代被删的 `pathql_rs::drivers::sqlite::params_for`
- **S3** core 新建 `storage/template_bridge.rs`（`pub(crate)` 6 行 helper）+ `storage/gallery.rs` 6 处 import 替换 + 3 处 `build_sql` 加 `SqlDialect::Sqlite` 参数
- **S4** core `sql_executor.rs` 重写：删除 `make_sql_executor(db) -> Arc<Fn>` factory，改 `KabegameSqlExecutor` struct + `impl pathql_rs::SqlExecutor`；`init.rs` 用 `Arc<dyn SqlExecutor>` 调 `ProviderRuntime::new`

阶段 C（compile-clean 恢复）：
- **S5** 测试套件修整 + 全套验证：4 个集成测试 `runtime.new_with_executor` → `new`，mock executor 切 `ClosureExecutor::new(SqlDialect::Sqlite, ...)`；运行 `cargo test -p pathql-rs / -p kabegame-core` + `bun check` + 手测 dev server `/gallery/all/x100x/{1,3}/` + `/vd/i18n-zh_CN/` 行为不变

**完成标准**：`pathql_rs::drivers` 引用 0；`Option<SqlExecutor>` / `make_sql_executor` / `EngineError::ExecutorMissing` / `new_with_executor` 引用 0；`pathql_rs::SqlExecutor` 是 trait，`pathql_rs::SqlDialect` enum 存在；`pathql-rs` 主代码无 rusqlite 依赖（仅 dev-dep）；core 行为零回归；DSL 动态 list / 翻页 / VD i18n 主路径手测通过。

**完成 6d 后的下一步（Phase 6e）**：delegate 形态从 PathExpr 改 ProviderCall，把 path-aware 设计错误连根拔起；顺手清理 `resolve_with_initial` 死代码 + `__provider` 私有 resolve 间接桥。

---

#### Phase 6e — `delegate` 路径形态改 ProviderCall（path-unaware provider）

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase6e-delegate-provider-call.md](d:/Codes/kabegame/.claude/plans/phase6e-delegate-provider-call.md)

**目标**：DSL 中 `delegate` 字段（在三处出现）从 `PathExpr` 改 `ProviderCall { provider, properties }`。Provider 设计原则是 **path-unaware**——provider 只关心"我是谁、我怎么贡献"，不应感知"我在路径树的哪个位置"。把另一个 provider 的引用写成路径让作者绑死到父级 segment 命名 + 让引擎做相对/绝对路径解析 + current_path 注入 + 递归守卫等一连串复杂处理；改 ProviderCall 后这些复杂性全部消失。

**子任务（commit checkpoint 边界）**：

阶段 A（atomic flip）：
- **S1** AST `ProviderCall` 类型新增 + `ProviderInvocation::ByDelegate` variant 删除 + `Query::Delegate.delegate` / `DynamicDelegateEntry.delegate` 类型变更（PathExpr → ProviderCall）+ 3 个 .json5 文件迁移（`gallery_all_router` / `gallery_page_router` / `gallery_paginate_router`）+ `__provider` 私有 resolve 间接桥消除 + `DslProvider::resolve_delegate` 删除（apply_query / list_dynamic_delegate 改用 `registry.instantiate` + `target.apply_query`）+ `ProviderRuntime::resolve_with_initial` 删除（无 caller 后死代码，顺便修了 6c 引入的"绕过 LRU"问题）—— 一次性 atomic commit

阶段 B（compile-clean 后续）：
- **S2** schema.json5 同步：`InvokeByDelegate` 定义删除 + 新增 `ProviderCall` 定义 + `DelegateQuery` / `DynamicListEntry_Delegate` 引用更新（纯描述层，不影响编译）
- **S3** validate 改造：`dynamic.rs` delegate scope 校验改 `ProviderCall.properties` 模板检查；`cross_ref.rs` 收集 delegate 出边；**新增** `cycle.rs` delegate 环检测（DFS over delegate 图，命中报 `ValidateErrorKind::DelegateCycle(chain)`）
- **S4** RULES.md 修订（§3/§6/§7/§10/§12 反映新 ProviderCall 语义）+ memory `project_dsl_architecture.md` 加决策 4 + `cargo test` + `bun check` + 手测 dev server `/gallery/all/`、`/gallery/all/x100x/{1,2}/`、`/vd/i18n-zh_CN/` 行为不变

**完成标准**：`ProviderInvocation::ByDelegate` / `InvokeByDelegate` / `resolve_delegate` / `resolve_with_initial` 引用 0；3 个迁移过的 .json5 用新 ProviderCall 形态 + `__provider` 残留 0；validate cycle 检测覆盖自指 / 双节点环；schema.json5 / RULES.md 同步；行为零回归。

**完成 6e 后的下一步（Phase 7+）**：dangling DSL provider 补全 + sync/async feature 切换 + 内置 sqlx_executor feature + 多方言完整支持 + 非 SQL executor 抽象（ResourceExecutor）。

---

### Phase 7 — DSL 全量迁移 + 主机 SQL 函数 + Parity 测试（细分为 7a / 7b / 7c / 7d）

**总览**：[d:/Codes/kabegame/.claude/plans/phase7-overview.md](d:/Codes/kabegame/.claude/plans/phase7-overview.md)

**总目标**：把仍在 programmatic 的 ~28 个 provider 全部迁到 DSL；删除 `programmatic/` 模块；建立主机 SQL 函数注册框架（让 DSL 能访问 plugin manifest 等非 SQL 数据源）；建立 parity 测试套保证迁移行为零回归。

#### Phase 7a — 基础设施 + i18n_en_US 补全 + pilot 迁移

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase7a-foundation.md](d:/Codes/kabegame/.claude/plans/phase7a-foundation.md)

**目标**：1) 补 `vd_en_US_root_router.json5` 解 dangling；2) core 主机 SQL 函数框架 `Storage::open` 期通过 `Connection::create_scalar_function` 注册标量函数；3) `get_plugin(plugin_id [, locale]) -> JSON_TEXT` 返回 `{id, name, description, baseUrl}` i18n 解析后的基础元数据；4) 2 个 pilot 迁移（`sort_provider` contrib query + `gallery_search_router` router 壳）；5) parity 测试 helper 框架，给 7b/c/d 复用。

**子任务**：
- **S1** `vd_en_US_root_router.json5`（vd_zh_CN 的英文翻译镜像；7 个英文 segment albums/plugins/tasks/surfs/media/dates/all）
- **S2** `core/src/storage/dsl_funcs.rs` 新建 + `Storage::open` 注册 + `get_plugin` 实现（含 `resolve_i18n_text` locale 解析）
- **S3** `sort_provider` DSL 迁移（单 `query.order.all=revert`；programmatic register 注释）
- **S4** `gallery_search_router` DSL 迁移（router 壳，单 list 静态项指向 programmatic display_name_router）
- **S5** parity 测试 helper（`pathql-rs/tests/parity_helper/`）+ sort + search parity 测试覆盖
- **S6** RULES.md 主机 SQL 函数章节 + memory 决策 5 + 全套验证

**完成标准**：`/vd/i18n-en_US/` 不再 PathNotFound；`get_plugin` 在 sqlite 内可调；2 pilot DSL 与 programmatic parity；helper 模板可复用。

#### Phase 7b — 引擎扩展（resolve.delegate 对称语义 + 模板 key + 校验放宽）+ Gallery 滤镜大迁移

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase7b-gallery-filters.md](d:/Codes/kabegame/.claude/plans/phase7b-gallery-filters.md)

**目标**：除迁移 17 个 gallery 滤镜外，**Stage A 补三项引擎能力**（6e 误删 / 未实现）：

1. **`ProviderInvocation::ByDelegate` variant 复活**（payload 用 6e 引入的 ProviderCall，path-unaware）。`resolve` 表项的 `{delegate: {provider, properties}}` 形态调 `target.resolve(name, ...)`；与 `query.delegate → target.apply_query` / `list[].delegate → target.list` 对称
2. **`${properties.X}` 模板形态的 list / resolve key**（instance-static：key 字面值在 instance 实例化期定）
3. **删除 validate 的 regex 碰撞检测**（`.*` 转发模式 + instance-static key 让原检查全 false positive）

迁移内容：17 个 gallery 滤镜（albums/album_entry / plugins/plugin_entry（用 7a get_plugin）/ tasks/task_entry / surfs/surf_entry / media_type/media_type_entry / hide / search 三件套 / wallpaper_order / date_range/date_range_entry）。`gallery_hide_router` 是 `resolve.delegate` 的 pilot（其原 programmatic 实现就是 "name 转发给 gallery_route.resolve"）；`gallery_all_desc_router` 用新特性从 6 行 resolve regex 缩成 1 行 `.*` 转发。每迁移走 7a parity helper 验证。

**7b 收尾两条增量子任务**（Stage A 之后插入；为大迁移 Stage C 提供更干净的语法 + 规范）：

- **S1c — `${global.X}` 全局变量 + 三处 property 迁移**：详细计划 [phase7b-s1c-globals.md](d:/Codes/kabegame/.claude/plans/phase7b-s1c-globals.md)。pathql-rs 加 `${global.X}` 模板 namespace（runtime-frozen，注入即只读）；core init 注入 `hidden_album_id` / `favorite_album_id`；删除 gallery_route + gallery_hide_router 三处 `properties.*_id` 声明（本质是常量错配为 properties），改 `${global.X}`；顺手修 [registry.rs:141](d:/Codes/kabegame/src-tauri/pathql-rs/src/registry.rs#L141) 的 property `default` 不生效 bug + gallery_hide_router 的 SELECT 别名 WHERE bug（`not is_hidden` → `hid_ai.image_id IS NULL`）。
- **S1d — Field 字符串简写 + 默认 SELECT 兜底 + RULES/schema 同步**：详细计划 [phase7b-s1d-engine-extensions.md](d:/Codes/kabegame/.claude/plans/phase7b-s1d-engine-extensions.md)。`Field` AST 加自定义 `Deserialize` visitor 支持纯字符串简写（gallery_route 14 个无 alias 字段缩成裸 SQL 串）；[compose/build.rs:77](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/build.rs#L77) 空 fields 默认从 `SELECT *` 改为 `SELECT <from>.*`（from 是单 identifier 时），同时删除 [storage/gallery.rs:281, 405](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L281) 两处历史 `images.*` 注入 hack；[RULES.md](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) §3 / §6 / §10 + [schema.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/schema.json5) 同步三个引擎扩展（globals namespace + Field 简写形态 + 默认 SELECT 行为）。
- **S1e — pathql Runtime `fetch(path)` / `count(path)` 服务，core 零 SQL 零 ProviderQuery**：详细计划 [phase7b-s1e-storage-thin.md](d:/Codes/kabegame/.claude/plans/phase7b-s1e-storage-thin.md)。pathql Runtime 新增两个**仅以 path 为参数**的数据服务：`fetch(path) -> Vec<JsonValue>`（内部 resolve + build_sql + executor.execute）、`count(path) -> usize`（resolve + build_sql + 拼 `SELECT COUNT(*) FROM (<inner>) AS pq_sub` + executor.execute）—— 调用方表达"要哪部分数据"只有 path 一个手柄，再无 ProviderQuery / TemplateContext 接触面。删除 [gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) 的 `"limit": 0` —— 该 hack 让 `count_at("/gallery/")` 等根路径 count 永远归零；删后 count 走实数，调用方负责不从根路径直接 fetch 图片（业务约定）；Storage `get_images_{count,info_range,fs_entries}_by_query` **整体删除**；删除死代码 `programmatic::shared::PageSizeProvider` / `QueryPageProvider` / `helpers::count_for`（自 6c 起注册被注释 + 唯一 caller 同死）；core [providers/query.rs](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) 新增 `images_at(path) -> Vec<ImageInfo>`（fetch + JSON 列名映射）/ `count_at(path) -> usize`（直接转 count）作为公开 API；rotator 重构两个模式：(1) **随机模式**（无新 provider）—— `runtime.list("/gallery/all/x100x")` 拿所有页码 → 不重复抽页 → `images_at(...)` 取该页 100 张 → 过滤可作壁纸的图片；album 同模式但根在 `/gallery/album/{id}/x100x`，找不到回退 gallery，再找不到退出轮播；(2) **顺序模式**（5 个新 programmatic provider）—— 新路径约定 `/gallery/bigger_crawler_time/{time}/l100l`（WHERE crawled_at > time，ORDER ASC，LIMIT 100）和 `/gallery/album/{albumId}/bigger_order/{order}/l100l`（WHERE album_images.order > order）；rotator 不停推进 marker 直到找到第一张可用图，album 找不到回退 gallery，再找不到退出轮播；`l<N>l` 是新限制段约定（纯 LIMIT N，区别于 `x<N>x` 的 page_size 形态）；mcp_server 切到新 API；删除已废弃 ipc stub。**字段集 = 路径决定**：path 走的 provider 链声明哪些 fields，`fetch(path)` 就返回哪些列。`images_at(path)` 是面向 gallery 路径（gallery_route 17 fields → 完整 ImageInfo）的 typed mapper；VD 后续迁移时（Phase 7d），`vd_root_router` / 其下游可声明**轻量字段子集**（如 id + local_path + display_name + size + crawled_at，FUSE readdir 用），对应一个独立的 `vd_entries_at(path)` typed mapper —— **不同消费者用各自路径表达字段需求，不复用 ImageInfo 的全字段开销**。完成后 grep 兜底：`ProviderQuery` / `TemplateContext` 在 storage / app-main 全 0；`get_images_*_by_query` 全 0；core/storage/gallery.rs 内 `rusqlite` / `LEFT JOIN album_images` / `SELECT COUNT` 全 0。**长期方向**（本期不做）：albums / tasks / surf_records / vd 等 storage 子模块走相同模式迁到 pathql 服务（每个业务表对应自己的 DSL provider 声明字段），最终 core 内 SQL 字符串总数 → 0。

#### Phase 7c — DSL 全量迁移完结篇

**详细计划**：[d:/Codes/kabegame/.claude/plans/phase7c-finalize.md](d:/Codes/kabegame/.claude/plans/phase7c-finalize.md)

**目标**：本期完成全部剩余迁移，整个 Phase 7 完结。涵盖 26 个 provider + 模块删除 + E2E 测试：

- **Stage A — Gallery filters (13 provider)**：S1 albums router/entry · S2 plugins router/entry（用 `get_plugin` host SQL 函数）· S3 tasks · S4 surfs · S5 media_type + wallpaper_order · S6 search display_name + date_range
- **Stage B — Gallery dates (4 provider)**：S7-a 引入 host SQL 函数 `crawled_at_seconds(int) -> int` 抽掉 4 处重复的 `CASE WHEN crawled_at > 253402300799 THEN .../1000 ELSE ...END`；S7-b 4 层日期下钻 DSL（dates_router / year / month / day），动态 list SQL 聚合（`SELECT DISTINCT strftime('%Y', crawled_at_seconds(images.crawled_at), 'unixepoch') AS year FROM (${composed}) AS sub`）+ 子层 properties 传递
- **Stage C — VD (9 provider)**：S8 vd_all + albums + album_entry + sub_album_gate · S9 vd_plugins（用 get_plugin + locale 传递）+ tasks + surfs + media_type · S10 vd_dates（zh_CN / en_US 各一份独立 DSL，避免 i18n 段名模板化复杂度）
- **Stage D — 删除 programmatic/ (S11)**：[providers/programmatic/](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/) 整目录（8 个 .rs 文件，2152 行）删除；`register_all_hardcoded` 函数本身删；init.rs 不再调；Tauri cleanup audit 确认 0 残留 import
- **Stage E — E2E + 文档 (S12)**：[core/tests/dsl_e2e.rs](d:/Codes/kabegame/src-tauri/core/tests/dsl_e2e.rs) 新建（fixture DB + gallery/vd 主路径 + i18n 切换 + LRU）；memory `project_dsl_architecture.md` 加"DSL 全量迁移完成"决策；RULES.md §11.1 host SQL 函数清单加 `crawled_at_seconds`；cocs/README.md provider-dsl 状态更新到"全量 DSL 化完成"

完成后：DSL .json5 文件 ≥ 35；core 内业务 SQL 字符串只剩 storage::albums/tasks/surf_records 等表的 typed query（与 provider 树无关）+ host SQL 函数；core/storage/gallery.rs 已是 typed JSON mapper（无 SQL）。

**~~Phase 7d~~ 取消**：原计划 7d 的 VD 迁移 + programmatic 删除 + E2E 测试合并到 7c 一并完成。整个 Phase 7 三个子期：7a（基础设施 + 2 pilot）→ 7b（引擎扩展 + 4 pilot：hide / search 壳 / sort / 分页 + 顺手做的 globals/Field 简写/Storage 路径化）→ 7c（剩余 26 provider 全迁 + 模块删除 + E2E）。

**Phase 7 全局完成标准**：
- 所有 gallery/vd 路径在 DSL 下行为与 programmatic 一致（parity 测试覆盖）
- `programmatic/` 模块删除（或仅剩空 stub）
- DSL .json5 ≥ 35 个文件
- 主机 SQL 函数 `get_plugin` 框架可扩展
- `cargo test -p kabegame-core --test dsl_e2e` 全绿
- `bun check -c main` 通过；手测 dev server 全路径不回归

---

## 端到端验证

实现完成后用户验证步骤：

1. `cargo test -p pathql-rs --features json5` — DSL 引擎自身单测全绿
2. `cargo test -p kabegame-core` — core 集成测试 + parity 测试全绿
3. `bun check -c main` — vue-tsc + cargo check 干净
4. `bun dev -c main --data prod` — 实际起 dev server，浏览 Gallery / VD 路径，画廊和虚盘行为不回归
5. 手测 i18n 切换：`zh_CN` ↔ `en_US`，VD 路径前缀切换正确，缓存隔离
6. 手测插件维度：装/卸某插件后，`/vd/i18n-zh_CN/按插件/` 列表更新（验证 `get_plugin` SQL 函数桥）

## 风险与缓解

- **Provider trait 签名切换的回归面**：Phase 6 一次性切到 ProviderQuery 会让 15+ 硬编码 provider 全部需要改造，单 PR 体量大。可在 Phase 6 内部按 provider 类别分批 commit（gallery / vd / shared 三组），但 trait 改签名必须一次完成（不可中间状态）。
- **`get_images_*_by_query` 接口动迁**：调用方（IPC 命令、内部业务）较多，要 grep 全找。Phase 6 子任务的开端先列出全部调用点。
- **sqlparser SQLite 方言对 `${...}` placeholder 的兼容**：先做 `${...}` → `:placeholder_N` 临时替换再 parse；Phase 3 早期一组单测验证。
- **ProviderMeta typed → 加 Json variant 的前端兼容**：[`provider.rs:27-33`](d:/Codes/kabegame/src-tauri/core/src/providers/provider.rs#L27-L33) 序列化的 wire format 要保稳；新 variant 序列化策略在 Phase 6 做 wire 测试。
- **regex-automata v0.4 NFA intersection API**：Phase 3 早期 spike 一下确认 API 形状。
- **跨 namespace 解析的全局排序**：第三方插件 namespace 加载顺序敏感；loader 必须先注册全部 def 再做 reference resolution（两遍扫描）—— Phase 1 + Phase 3 各负责其中一遍。

---

## 文件改动一览

| 路径 | 阶段 | 操作 |
|---|---|---|
| `src-tauri/Cargo.toml` workspace | 1 | 加 `pathql-rs` 成员 |
| `src-tauri/pathql-rs/Cargo.toml` | 1, 2, 3, 4, 5 | 新建 + 逐期加 dep |
| `src-tauri/pathql-rs/src/lib.rs` | 1+ | 新建 |
| `src-tauri/pathql-rs/src/ast/*.rs` | 1 | 新建 AST 类型 |
| `src-tauri/pathql-rs/src/loader.rs` | 1 | Loader trait + LoadError |
| `src-tauri/pathql-rs/src/registry.rs` | 1 | ProviderRegistry |
| `src-tauri/pathql-rs/src/adapters/{mod,json5}.rs` | 2 | json5 适配器（feature gate） |
| `src-tauri/pathql-rs/tests/load_real_providers.rs` | 2 | 集成测试 — 9 个真 .json5 加载 |
| `src-tauri/pathql-rs/src/template/parse.rs` | 3 | 模板解析器（永久编译，无 feature gate） |
| `src-tauri/pathql-rs/src/validate/*.rs` | 3 | 校验集合（feature `validate`） |
| `src-tauri/pathql-rs/src/compose/{mod,query,fold,order,aliases}.rs` | 4 | ProviderQuery + 结构化折叠（feature `compose`） |
| `src-tauri/pathql-rs/src/template/eval.rs` | 5 | 模板求值器 + TemplateValue/TemplateContext（feature `compose`） |
| `src-tauri/pathql-rs/src/compose/render.rs` | 5 | 通用 SQL 模板渲染（inline + bind 混合替换） |
| `src-tauri/pathql-rs/src/compose/build.rs` | 5 | ProviderQuery → SQL 渲染，输出 `(String, Vec<TemplateValue>)` |
| `src-tauri/pathql-rs/src/adapters/sqlite.rs` | 5 | sqlite 适配器（新 feature `sqlite`） |
| `src-tauri/pathql-rs/src/runtime/dsl_provider.rs` | 6 | DslProvider impl |
| `src-tauri/core/Cargo.toml` | 6 | 加 `pathql-rs` path dep |
| `src-tauri/core/src/providers/provider.rs` | 6 | trait 签名切 ProviderQuery + ProviderMeta::Json |
| `src-tauri/core/src/providers/{gallery,vd,shared}/*.rs` | 6 | 现有硬编码 provider 全部迁移 |
| `src-tauri/core/src/storage/gallery.rs` | 6 | 删除 ImageQuery；接口换 ProviderQuery |
| `src-tauri/core/src/storage/mod.rs` | 7 | `Connection::create_scalar_function` 注册 host SQL 函数 |
| `src-tauri/core/src/storage/dsl_funcs.rs` | 7 | 新建（`get_plugin` 等） |
| `src-tauri/core/src/providers/runtime.rs` | 6 | 缓存规则更新 + DSL 加载入口 + 大小写敏感 |
| `src-tauri/core/src/providers/{gallery,vd}/*.json5` | 7 | 补 19 个 dangling provider |
| `src-tauri/app-main/src/commands/image.rs` | 7 | 切换到 DSL root |
| `src-tauri/core/tests/dsl_e2e.rs` | 7 | E2E 集成测试 |
