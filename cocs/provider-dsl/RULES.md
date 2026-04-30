# Provider DSL — 加载期与运行期规则

本文档定义 Provider DSL（v0.7）**schema 之外**的语义合约。
[`schema.json5`](../../src-tauri/core/src/providers/schema.json5) 校验语法；本文档校验语义。
两者并列：schema 拒绝的，引擎也拒绝；schema 通过的，本文档列出的规则仍可能拒绝。

---

## 7b-S1c/S1d implementation notes

- Templates may read runtime-frozen globals via `${global.<key>}`. Hosts inject these at
  `ProviderRuntime` construction time; pathql treats them like bind parameters in SQL templates.
- `fields[]` accepts either full object form `{ "sql": "...", "as": "...", "in_need": true }`
  or shorthand string form `"images.url"`, equivalent to `{ "sql": "images.url" }`.
- When a query has no selected fields, SQL rendering emits `SELECT <from>.*` if `from` is a
  simple ASCII identifier; otherwise it falls back to `SELECT *`.

## Phase 7c completion note

Kabegame core built-in providers are fully DSL-backed as of Phase 7c. The former
`providers/programmatic/` module and `register_all_hardcoded` bootstrap path have been removed;
`dsl_loader::DSL_FILES` is now the source of truth for the root, gallery, shared pagination/sort,
and VD provider tree. The v0.7 engine features used by the migrated providers include globals,
field shorthand, path-only fetch/count, delegate symmetry, instance-static keys, typed JSON meta
bridges, host SQL functions, and `where_clear`.


## 1. 文件与位置

- 后缀：`.json5`（推荐 `.provider.json5` 后缀以便 IDE 区分）
- 顶层 `$schema` 字段建议指向 `./schema.json5` 相对路径，启用 IDE 补全
- 位置约定：`src-tauri/core/src/providers/<scope>/<name>.json5`
  - `<scope>` 为 `root` / `shared` / `gallery` / `vd` 之一
  - 文件 `name` 字段必须等于文件名（不含后缀），便于反查
- `__` 前缀路径段为**约定上的私有路径**（非引擎强制），不期望被外部 list 暴露

### 1.1 命名空间（Java 包风格）

- 顶层 `namespace` 字段，点分式：`kabegame` / `kabegame.plugin` / `pixiv` / `bilibili` 等
- 全局名 = `<namespace>.<name>`
- 同 namespace 内 provider 互相引用用 simple name；跨 namespace 用绝对名 `a.b.c.name`
- **解析规则**：当前 namespace → 父 namespace → ... → root，逐级查找
  - 例：`kabegame.plugin.foo` 调用 `bar` 时，依次查 `kabegame.plugin.bar` → `kabegame.bar` → `bar`
- 现有内置 provider 全部位于 `kabegame` 下；第三方插件应自行选 namespace（推荐用插件 id）

---

## 2. 路径折叠语义

resolve 一条路径 `/<seg₁>/<seg₂>/.../<segₙ>` 时引擎执行：

```text
composed  = ImageQuery::new()
provider  = root_provider
composed  = provider.query.apply(composed)              // 根贡献

for seg in segments:
    child = provider.resolve(seg, composed)             // 字面 / 正则 / dyn fallback
    composed = child.query.apply(composed)              // 折叠
    provider = child

return ResolvedNode { provider, composed }
```

- LRU 缓存键：normalize 后的 `path`，值：`(Arc<dyn Provider>, ImageQuery)`
- 命中前缀直接复用，未命中部分增量 resolve
- **路径段大小写敏感**：`/By-Album` ≠ `/by-album`。i18n 翻译文本 / 插件 ID 等都按字面字节匹配，避免大小写折叠造成的二义性

---

## 3. ContribQuery 各字段累积规则

每个 provider 的 `query` 在路径上贡献片段。引擎按字段类型不同处理：

| 字段 | 累积语义 |
|---|---|
| `from` | **cascading-replace** — 一次声明覆盖整个 FROM 子句，影响下游所有未重声明节点 |
| `join[]` | **additive with as-dedup** — 累积到 FROM 之后，按 `as` 去重 / 共享 |
| `where` | **additive AND** — 路径上各 provider 的 where 字符串用 AND 拼接成最终 WHERE |
| `fields[]` | **additive with as-dedup** — 累积到 SELECT 列表，按 `as` 去重 / 共享 |
| `order` | **见 §3.4** — 数组项位置定优先级；或全局 `{all: ...}` 指令 |
| `offset` | **additive `+`** — 多次声明按路径顺序串接为 `(o₁) + (o₂) + ...`，实现嵌套分页 |
| `limit` | **last-wins** — 一般仅终端 provider 设置 |

### 3.1 from（cascading-replace）

- 任意 SQL 片段。**虽然语法上可以写 JOIN**（如 `images INNER JOIN album_images ai ON ...`），
  但**强烈不推荐**：query builder 在拼装 SQL 时仅按 `join[]` 数组判断 JOIN 的存在性与共享，
  不会解析 `from` 内嵌 JOIN —— 导致下游 `in_need` 共享、`order` 跨表引用等机制对 from 内 JOIN 失效。
  **所有 JOIN 应通过 `join[]` 声明**。
- 子节点重声明 `from` → 完全覆盖上游
- 若没有任何节点声明，引擎使用默认 `images`

### 3.2 join / fields 的 `as + in_need` 共享机制

- `as: 'ab'` → 字面别名；路径上同名 `as` 已存在则**报错**（默认 `in_need = false`）
- `as: 'ab', in_need: true` → 同名已存在则**放弃本贡献**，跳过累积
  - 用途：跨 provider 共享同一 join。约定共同 `as` 名，所有需要它的 provider 都用 `in_need: true` 贡献
- `as: '${ref:my_id}'` → 引擎自动分配唯一别名
  - 同 ContribQuery 内其他位置（join.on / where / fields.sql）用 `${ref:my_id}` 引用
  - 不与 `in_need` 同时使用（auto-allocated 必然唯一，`in_need` 无意义 → 加载期拒绝）

### 3.3 where（additive AND）

- 单字符串表达式，可为任意 SQL 谓词组合（`a > 1 AND b < 100`）
- 路径上各 provider 的 where 用 AND 串：`WHERE (where₁) AND (where₂) AND ...`
- 字符串内 `${properties.X}` 等模板由引擎转 bind param，不做字符串拼接（见 §7.1）

### 3.4 order（两种顶层形态）

`order` 字段顶层为 **二选一**：

**形态 A — 数组（位置定优先级）**：

```json5
"order": [
    { "created_at":  "desc" },
    { "title":       "asc"  },
    { "priority":    "revert" }   // 翻转该字段在上游已声明的方向
]
```

- 数组每项是对象 `{ <field>: 'asc' | 'desc' | 'revert', ... }`，**允许多键**
  - 多键场景：单个对象可同时声明多个字段排序，键间共享同一 array index 优先级
  - 推荐写法仍是单键 / 单字段一行（语义清晰），但多键不报错
- 路径累积语义：
  - **低 index 优先**（先声明的字段排在 ORDER BY 链的前面）
  - 同一 array index 内多键时，键之间的优先级由 JSON 对象的声明顺序决定（多数序列化器保留插入序）
  - 同名 field 在路径上重复声明 → **后声明覆盖前声明，不报错**
  - 项内 `revert` 表示翻转*该字段在上游*已声明的方向；上游未声明则视为新增
- **数组形态下** `{all: ...}` 不再生效（仅形态 B 支持全局指令）

**形态 B — 全局指令**：

```json5
"order": { "all": "revert" }
```

- 单对象 `{all: 'revert' | 'asc' | 'desc'}`
  - `revert` → 翻转上游所有 ASC↔DESC（对应 Rust SortProvider.to_desc）
  - `asc` / `desc` → 强制将上游所有字段统一为该方向
- 应用时机：插入累积链顶（影响下游所有节点的方向解释）
- 一般用于「分页 / 视图反向」之类的语义节点

形态 A 与 B 不可在同一 provider 同一 query 内同时出现（schema oneOf 强制）。

### 3.5 offset / limit

- **offset：additive `+`** —— 数字或模板字符串
  - 多个 provider 在路径上各自声明 offset，引擎按路径顺序串接：
    `OFFSET (o₁) + (o₂) + ... + (oₙ)`
  - 用途：嵌套分页（如 `/page-2/inner-page-3` 自然累加偏移）
  - 任一项为字面数字时引擎可在加载期常量折叠
- **limit：last-wins** —— 路径上多次声明取**最末一次**
  - 一般仅终端 provider（如分页节点）声明
  - `limit: 0` 走 SQL 自然语义（空集），不特殊化

---

## 4. List 语义

### 4.1 静态项（StaticListEntry）

key 形态分两类（7b 起）：

- **静态字面**：不含 `${...}`，加载期已是字面。
- **instance-static**：含 `${properties.X}`（且**不含** `${data_var.X}` / `${child_var.X}`）。引擎在 DslProvider 实例化时按 `self.properties` 渲染 key 模板得到字面，调 `list` / `resolve` 时按渲染后的字面比较。

两类 key 的值均为 `ProviderInvocation` 二态之一（**list 静态项不允许 ByDelegate**；它仅在 Resolve 表里有意义）：

- `InvokeByName`：`{provider: <name>, properties?, meta?}` — 显式构造命名 provider
- `EmptyInvocation`：`{meta?}` — 占位，路径仍可被识别但本节点无 list/resolve 服务（缓存策略见 §4.4）

**meta 字段语义**（二态共用，可选；详见 §4.5）：

```json5
{
    "provider": "gallery_album_router",
    "properties": { "album_id": "${capture[1]}" },
    "meta": "select * from albums where albums.id = ${capture[1]}"
}
```

可访问的模板变量：`${properties.X}` + `${capture[N]}`（仅 resolve 项内）。

### 4.2 动态 SQL 项（DynamicListEntry_Sql）

```json5
"${row.display_name}": {
    "sql": "SELECT id, display_name FROM plugins",
    "data_var": "row",
    "provider": "gallery_plugin_provider",
    "properties": { "plugin_id": "${row.id}" }
}
```

**加载期约束**：

- key 中所有 `${X.Y}` 的 X **必须等于** `data_var`
- `properties` 值中所有 `${X.Y}` 的 X 同上
- SQL 模式不支持 `${data_var.provider}` 引用（无意义）
- 通常 SQL 内部用 `${composed}` 把上游累积查询作为子查询嵌入

可访问的模板变量：`${properties.X}` + `${<data_var>.<col>(.<sub>)*}` + `${composed}`（仅 sql 字段内）。

**meta 字段（详见 §4.5）**可为：
- SQL 字符串（按行执行，可访问 `${data_var.col}`）
- `${data_var}`（透传整行 SQL 结果作为 meta，让上游 delegate 拿到）
- 含 `${...}` 模板的对象 / 标量字面

### 4.3 动态 delegate 项（DynamicListEntry_Delegate）

```json5
"${plugin.name}": {
    "delegate": { "provider": "plugin_source_provider" },   // 6e: ProviderCall, 不是路径
    "child_var": "plugin",
    "provider": "${plugin.provider}",
    "properties": { "plugin_id": "${plugin.meta.id}" }
}
```

**加载期约束**：

- key / properties 中所有 `${X.Y}` 的 X **必须等于** `child_var`
- `delegate` 字段（6e 起）：`ProviderCall { provider: <name>, properties? }` — **不是路径**。引擎按当前 namespace 链解析目标 provider name + 用 properties 实例化, 然后调它的 list_children 拿 children 序列。
- 容器层 `provider` 字段三态：
  - 缺省 → 不挂 provider（路由壳常见）
  - 字面字符串 → 显式构造命名 provider
  - `${child_var.provider}` → 透传 delegate 返回的 child.provider 整体对象
- delegate 数据源每个 ChildEntry `{name, provider?, meta?}` 通过 `${child_var.X}` 引用：
  - `${child_var.name}` → child.name (string)
  - `${child_var.provider}` → child.provider (整体对象，仅 entry.provider 字段位置合法)
  - `${child_var.meta.<X>(.<sub>)*}` → child.meta.X (untyped JSON)

**meta 字段（详见 §4.5）**可为：
- SQL 字符串（每个 child 各执行一次，可访问 `${child_var.X}`）
- `${child_var.meta}`（透传上游 meta；最常用模式）
- 含 `${...}` 模板的对象 / 标量字面

### 4.4 缓存契约

引擎只缓存**命中的路径**——命中即"该路径解析出了真实可服务的 provider 状态"：

| 解析结果 | 是否缓存 |
|---|---|
| 静态 list key 字面命中 → `InvokeByName` | ✅ 缓存 |
| 动态 list 命中（SQL 行 / delegate child 匹配） | ✅ 缓存 |
| `resolve` 正则命中 → `InvokeByName` | ✅ 缓存 |
| 任意命中 → `EmptyInvocation`（路径合法但无 list 服务） | ❌ **不缓存**（解析本身已是 O(1)，无需占用 LRU 槽位） |
| 路径段未命中（list / resolve / 动态全 miss） | ❌ 不缓存（直接返回 404 / 不存在） |

**缓存键**：normalize 后的完整路径（大小写敏感）；
**缓存值**：`(Arc<dyn Provider>, ImageQuery)`。

**失效**：由数据变更事件（`images-change` / `album-images-change` / 插件装卸 等）显式清空相关前缀；
不靠 TTL。前端不直接感知 LRU 状态，靠事件订阅触发刷新。

### 4.5 meta 字段统一语义

`meta` 字段（出现在 InvokeByName / EmptyInvocation /
DynamicListEntry_Sql / DynamicListEntry_Delegate）的目标：**最终产出可序列化为 JSON 的值**填充 ChildEntry.meta。

引擎按 meta 的 **JSON 类型** 决定行为：

| meta 类型 | 行为 |
|---|---|
| **字符串**，且仅含 `${...}` 模板（无 SQL 关键字） | 模板插值，结果作为 meta |
| **字符串**，其余 | 视为单行 `SELECT ...`；引擎执行后取首行结果（`Row`/JSON 对象）作为 meta |
| **对象** `{ k: v, ... }` | 递归对每个 v 做模板插值；最终对象作为 meta |
| **数组** `[...]` | 同上 |
| **数字 / 布尔 / null** | 直接作为 meta |

**模板上下文**与所在位置一致：

- 静态项 / Resolve 项：`${properties.X}` + `${capture[N]}`
- 动态 SQL 项：`${properties.X}` + `${<data_var>.<col>(.<sub>)*}`（每行各执行一次插值）
- 动态 delegate 项：`${properties.X}` + `${<child_var>.X}`（每个 child 各执行一次）

**典型用例**：

```json5
// 1. 静态 SQL 投影
"meta": "select count(*) as total from albums where id = ${capture[1]}"

// 2. 静态对象（无需 DB）
"meta": { "id": "${properties.album_id}", "kind": "album" }

// 3. 动态 SQL 项透传整行
"meta": "${data_var}"

// 4. 动态 delegate 项透传上层 meta
"meta": "${child_var.meta}"

// 5. 动态 delegate 项做结构包装
"meta": {
    "name": "${child_var.name}",
    "raw":  "${child_var.meta}"
}
```

**约束**：
- meta 为字符串模式时，引擎采用启发式判别（含 `select`/`from` 关键字 → SQL；纯 `${...}` 表达式 → 模板）。
  设计者应避免 SQL 与模板字面冲突；若需强制为 SQL，写出完整 SELECT。
- 对象 / 数组形态下，模板插值结果应保持 JSON 可序列化（避免插入 SQL 子查询字符串）。

---

## 5. Resolve 语义

`Resolve` 结构 = `{ <regex>: ProviderInvocation, ... }`（直接 key-value，无 `entries` 包装）。

### 5.1 全部按正则匹配

- `resolve` 内所有 key **一律按正则编译**——纯字面量是空元字符的合法子集，自动兼容
- 正则捕获组用 `${capture[<N>]}` 引用（N≥1；0 = 全匹配）
- 这条决策放弃了"靠元字符判别字面 vs 正则"的区分尝试（语义不可靠）

### 5.2 运行期解析顺序

引擎按以下顺序逐级查找一个路径段名 `seg`：

1. **正则 resolve**：依次尝试 `resolve` 内每条正则；命中即构造对应 ProviderInvocation
2. **静态 list key 字面量**：在 list 中查 key 是否字面等于 `seg`；命中即构造
3. **动态 list 反查**（默认开启，无需配置）：
   - 跑 list 中所有 DynamicListEntry 的 SQL / delegate 数据源
   - 按 key 模板（`${data_var.<col>}` / `${child_var.name}`）反查匹配的行 / child
   - 命中即构造，**结果同样进 LRU 缓存**（与 §4.4 一致）
4. 全部失败 → 该子节点不存在（404，不缓存）

### 5.3 加载期检查 (7b 起简化)

引擎在加载每个 provider 时执行：

- **静态 list 内部**：list key 不能重复（JSON 对象天然约束 + schema 检查）
- **resolve 正则编译**：每条 pattern 编译失败 → 拒绝（含 instance-static `${properties.X}` 形态的 pattern 加载期跳过编译, 实例化期再编译）
- **${capture[N]} 越界**：invocation properties / meta 中 N 必须 ≤ 当前 regex captures 数

**7b 起删除的检查**（false positive 比例过高）：
- ~~regex 与静态 list key 字面碰撞~~ — `.*` 转发模式 + 任意静态项是合法的（runtime 解析顺序 list → regex → 反查保证作者意图）
- ~~regex 与 regex 交集 (NFA intersection)~~ — `${properties.X}` instance-static pattern 实例化前未知 + 含字符类的 regex 在 NFA 实测误判

多模式重叠由作者按 schema 出现顺序覆写决定；引擎不再插手。

### 5.4 Delegate 对称转发 (7b 起补全)

DSL 三处 `delegate` 字段对应同一原则：**把当前上下文的操作转发给 target**。每处 payload 均为 `ProviderCall { provider, properties? }`，永远 path-unaware。

| 字段位置                      | 容器 AST                       | 转发的操作                              |
|---|---|---|
| `query.delegate`              | `Query::Delegate`              | `target.apply_query(current, ctx)`      |
| `list[<动态>].delegate`       | `DynamicListEntry::Delegate`   | `target.list(composed, ctx)` 取 children |
| `resolve[<regex>].delegate`   | `ProviderInvocation::ByDelegate` | `target.resolve(name, composed, ctx)` 转发 |

**注**：`ProviderInvocation::ByDelegate` 仅在 Resolve 表里有意义（list 静态项不允许）。原 6e 删除该 variant 是错误判断（结构上 ByDelegate 与 ByName payload 同形，但**操作语义不同** — ByName 的 X 直接是结果，ByDelegate 的 X.resolve(name) 才是结果）；7b 修正补回。

**典型应用**（gallery_hide_router 模式）：
```jsonc
"resolve": {
    ".*": { "delegate": { "provider": "gallery_route" } }
}
```
含义：本节点不自己解决任何 segment，把 name 转给 `gallery_route.resolve(name, ...)`。本节点的 contrib（如 hide WHERE）随 apply_query 自然累积。

---

## 6. 模板变量 `${...}` 语义

### 6.1 总体语法

DSL 内所有 `${...}` 表达式都是 **从某个上下文命名空间取值** 的引用，最终求值为字符串（或对象/数组，
依语义场景由引擎解释）。三种语法形态：

| 语法 | 含义 | 求值结果 |
|---|---|---|
| `${<ns>}` | 取整个命名空间对象 | JSON 值（对象 / 标量） |
| `${<ns>.<path>(.<sub>)*}` | 在命名空间内做点访问 / 索引 | JSON 值（标量或子对象） |
| `${<ns>[<N>]}` | 索引访问（仅 capture） | 字符串（捕获组） |
| `${<method>:<arg>}` | **方法标记** —— 调命名空间方法，返回字符串 | 字符串 |

**未来可扩展**：运行时可以注册新的命名空间（暴露配置 / 系统状态）或新的方法（如 `${env:VAR}` 之类）。
现阶段已用的命名空间 / 方法如下表。

### 6.2 当前可用命名空间

| 变量 | 合法位置 | 含义 |
|---|---|---|
| `${properties.<name>}` | 任何 TemplateExpr / SqlExpr / `ProviderCall.properties` 值 / `note:` 字段 | 当前 provider 实例化属性值 |
| `${capture[<N>]}` | 仅 Resolve regex 项内 | 正则捕获组（N≥0；0=全匹配） |
| `${<child_var>(.<field>)*}` | 仅 DynamicListEntry_Delegate 内 | 由 child_var 绑定的 ChildEntry：`.name` / `.provider` / `.meta.X` |
| `${<data_var>(.<col>)*}` | 仅 DynamicListEntry_Sql 内 | 由 data_var 绑定的 SQL 行：列值或子对象（如 `info` 列是 JSON） |
| `${composed}` | 仅 SqlExpr（where / fields.sql / 动态 list sql） | 上游累积 SQL 子查询 |

### 6.3 当前可用方法

| 方法 | 合法位置 | 含义 |
|---|---|---|
| `${ref:<ident>}` | 同 ContribQuery 内的 join.on / where / fields.sql / join.as / fields.as | 引擎自动分配的别名占位符 |

### 6.4 约束

- 模板变量 **不可嵌套**（`${${X}.Y}` 非法）
- 命名空间名 / 方法名不可与 §8 保留标识符冲突
- 方法标记的参数（`:` 之后）目前只允许单个 ident；未来扩展可放宽

---

## 7. 安全契约

### 7.1 SQL 安全

- 所有 `SqlExpr` 在加载期通过 `sqlparser-rs` 校验
- 拒绝：
  - 多语句（包含 `;` 后跟非空白）
  - DDL（CREATE / DROP / ALTER / TRUNCATE）
  - 明显注入模式（如 `'; --` 等）
- `${composed}` 由引擎构造，可信任直接嵌入子查询
- `${properties.X}` 等模板值在最终拼接 SQL 时**走 bind param**，不做字符串拼接
- `from` / `join.table` 字面量表名必须在引擎白名单；`(SELECT ...)` 子查询形式豁免

### 7.2 路径安全

- 6e 起 delegate 字段不再是 PathExpr — provider 引用走 ProviderCall (name + properties), 引擎按 namespace 链解析
- 所有路径段在 resolve 前 percent-decode（兼容前端 `encodeURIComponent`）
- 加载期 cross_ref 校验所有 ProviderCall.provider 必须存在; cycle 检测捕获 delegate 自指 / 多节点环

### 7.3 第三方插件信任边界

来自 `.kgpg` 插件包的 DSL 文件视同**半信任来源**：

- 加载期严格执行所有上述校验
- 提供的 SQL 片段经 sqlparser 后才接受
- 路径只能向下；不能引用其他插件的私有 provider
- 失败立即拒绝整个插件包加载

---

## 8. 保留标识符

以下 ident **不能**用作 `child_var` / `data_var` / `RefAlias` 内部 ident / 用户自定 properties 名 / 命名空间名 / 方法名：

| 保留 | 原因 |
|---|---|
| `properties` | 全局属性命名空间 |
| `capture` | Regex 捕获组命名空间 |
| `composed` | SQL 上游累积命名空间 |
| `ref` | 引擎别名分配方法 |
| `out` | 历史保留（v0.4 旧语义） |
| `_` | 占位惯例 |

加载期检测；冲突立即拒绝。

---

## 9. 错误处理

| 阶段 | 错误类型 | 处理 |
|---|---|---|
| Schema 校验失败 | 语法错误 | 加载期拒绝；启动 panic + 打印失败文件路径 |
| 跨字段约束失败（本文档 §3 / §4 / §5 / §6） | 语义错误 | 同上 |
| ProviderName 重名 | 唯一性错误 | 同上 |
| Resolve 规则交集 | 多匹配 | 同上 |
| 运行期 resolve 失败 | 路径不存在 | 返回 `Result<_, String>` 给 IPC，前端显示 toast |
| 运行期 SQL 失败 | DB 错误 | 同上 |
| LRU 容量满 | 正常淘汰 | 不可见 |

---

## 10. 加载期校验清单（实现引擎时逐项执行）

引擎 loader 在解析每个 *.json5 后必须依次检查：

- [ ] schema.json5 校验通过
- [ ] `name` 字段等于文件名（不含后缀）
- [ ] `<namespace>.<name>` 全局唯一
- [ ] `namespace` 符合 `[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*` 模式
- [ ] ContribQuery 内：
  - [ ] `order` 形态 A（数组）与形态 B（`{all}`）二选一
  - [ ] 形态 A 数组项每个键值的 value ∈ {asc, desc, revert}（键不限数量）
  - [ ] `${ref:<X>}` 引用都能在同 ContribQuery 的 `join.as` / `fields.as` 找到定义
  - [ ] `as: "${ref:...}"` 不与 `in_need: true` 同时出现
  - [ ] 所有 SqlExpr 经 sqlparser 校验
  - [ ] 所有字面 `from.table` / `join.table` 在白名单（子查询豁免）
  - [ ] `from` 内**不含 JOIN 关键字**（防御性提示，不强制拒绝）
- [ ] DynamicListEntry 内：
  - [ ] key / properties 中 `${X.Y}` 的 X 等于 `child_var` 或 `data_var`
  - [ ] SQL 模式不出现 `${data_var.provider}`（无意义）
  - [ ] `child_var` / `data_var` 不是保留标识符
- [ ] Resolve 内：
  - [ ] 每条 `resolve` key 编译为合法正则
  - [ ] 每条 `resolve` 正则 vs 任一 list 静态 key 字面 → 无匹配
  - [ ] 任意两条 `resolve` 正则用 `regex_automata` 求交集 → 空集
  - [ ] 正则项内 `${capture[N]}` 的 N 不超出捕获组数
- [ ] meta 字段（详见 §4.5）：
  - [ ] 字符串模式：判别为 SQL 时仅单条 SELECT；多语句 / DDL 拒绝
  - [ ] 对象 / 数组模式：递归校验内部模板变量作用域合法
- [ ] ProviderInvocation.provider / ProviderCall.provider 引用解析（**可选，默认 off**——见 §13.4）：
  - 严格模式开启时按当前 namespace → 父 namespace → root 顺序查到目标 provider
  - 默认模式：未解析的引用允许在加载期通过；运行期才查 registry，未命中返回 path-not-found 而不是启动失败
  - 简单名 / 绝对名 `a.b.c.name` 均可
- [ ] **delegate 环检测**（6e 起；cross_ref 启用时）：
  - 收集 `Query::Delegate.delegate.provider` + `DynamicDelegateEntry.delegate.provider` 全图边
  - DFS 命中 back-edge → 报 `DelegateCycle(chain)` 错误
  - 自指环 (A→A) 与多节点环 (A→B→A) 都会被捕获

---

## 11. 主机协调模式（host-mediated patterns）

DSL 内核只处理 **SQL 可读 + 路径折叠** 两类信息。某些数据**不属于这两类**，
应由宿主（Tauri 命令层 / 前端 / 主机注册的 SQL 函数）协调。这是引擎留给上层的扩展面。

**典型情况与处理原则**：

| 情况 | 数据特征 | 协调方式 |
|---|---|---|
| i18n 翻译文本作路径段 | 不在 DB；切语言要切路径 | 主机层在路径前缀拼 `i18n-<locale>` 段，引擎走专用 router 子树 |
| 插件 / 用户偏好 / 配置 | 不在 DB 列；运行时可变 | 主机注册 SQL 函数桥接（如 `get_plugin(plugin_id) → JSON`） |
| 显示名 vs 标识符 | DB 只有 ID；显示名要查 i18n 字典 | DSL 持有 ID（路径段名 = ID）；前端渲染时查表翻译 |

**通用判别**：

- 数据是 SQL 可读的（DB 列、JOIN 投影、子查询） → DSL 直接处理
- 数据是 ID 类标识符（plugin_id、album_id、task_id） → DSL 持有 ID，前端做显示
- 数据是配置 / 偏好 / locale / 环境变量 → 主机层决定路径前缀，或注册 SQL 函数桥接

具体落地（VD 路径树、插件 router 设计、`get_plugin` SQL 桥）见
[VD_INTEGRATION.md](./VD_INTEGRATION.md)。VD 是引擎的消费者，与内核规则解耦——本节只列出原则，
具体实现示例不进入 RULES.md。

### 11.1 主机 SQL 函数（host scalar functions）

引擎本身**不内置**任何主机函数；消费者（如 kabegame-core）通过 SqlExecutor 持有的 connection
注册 sqlite 标量函数（`Connection::create_scalar_function`），DSL 文件里直接用函数名 + sqlite
JSON1 函数（`json_extract` 等）拆解返回值。

**命名约定**：`get_<entity>(id [, locale]) -> JSON_TEXT`

- 返回单 JSON 字符串而非多列 — 标量函数语言侧限制；JSON1 函数拆字段；扩展字段不破坏调用方
- locale 缺省走 host 侧全局当前 locale（kabegame: `kabegame_i18n::current_vd_locale()`）
- 实体不存在 → 返回 SQL JSON `"null"`（DSL 侧用 `IFNULL(json_extract(..., '$.field'), '')` 兜底）
- 标记 `SQLITE_DETERMINISTIC` — sqlite 同 query 内同参数缓存

**当前注册（kabegame）**：

```text
get_plugin(plugin_id [, locale]) -> JSON_TEXT
  返回 {"id","name","description","baseUrl"};
  name / description 按 locale 解析（exact > prefix split _ > "default" > "en" > "")。
get_album(album_id) -> JSON_TEXT
get_task(task_id) -> JSON_TEXT
get_surf_record(record_id) -> JSON_TEXT
  返回 {"kind": <typed-kind>, "data": <entity>} 形态, 供 DSL `$json` meta directive 注入。

crawled_at_seconds(timestamp) -> INTEGER
  将秒 / 毫秒混合的 crawled_at 规整为 unix seconds, 供日期 router 与 date_range 复用。

vd_display_name(canonical) -> TEXT
  读取当前 VD locale, 把 canonical 段名映射为本地化路径显示名。
```

**DSL 调用模式**：

```sql
SELECT
    plugin_id,
    json_extract(get_plugin(plugin_id, '${properties.locale}'), '$.name') AS plugin_name,
    json_extract(get_plugin(plugin_id, '${properties.locale}'), '$.description') AS plugin_desc
FROM plugins
```

**为什么主机函数注册位于 SqlExecutor 层而非 pathql-rs 层**：标量函数是 connection-scoped；
pathql-rs 不持 connection（dialect-agnostic 渲染层），注册责任落在持 connection 的消费者
（core/src/storage/dsl_funcs.rs 在 Storage::new 期注册）。

---

## 12. Provider 体系抽象接口

本节定义 pathql 引擎对 Provider 的抽象操作合约——任何 pathql 实现（Rust、未来其他语言）
都应当遵守的接口语义。**与具体编程语言 / DB 驱动无关**；语言绑定层负责把这些抽象操作映射到具体 trait / interface / class。

### 12.1 ChildEntry 抽象结构

```text
ChildEntry {
    name:     string                  // 路径段名 (path-encoded)
    provider: ProviderRef?            // 子 provider; null = EmptyInvocation 占位
    meta:     untyped JSON?           // 任意结构化元数据
}
```

- `name` 是该 child 在父 provider 命名空间下的标识；用作下一段路径
- `provider` 缺省 (null) 表示该路径段被识别但无下游 provider 服务（详见 §4.4 EmptyInvocation 缓存契约）
- `meta` 由 §4.5 规则求值产出；语言绑定可选地把它解释为 typed 实体（如 Album / Plugin / Task），
  但 pathql 抽象层不感知这些 typed 形态

`total` / `count` / `images_count` 等"数据库查询结果型"字段**不属于** ChildEntry——
它们由 §12.5 的查询接口单独提供。

### 12.2 Provider 抽象操作（与 DSL 字段对齐）

每个 provider（无论 DSL 加载还是编程注册）暴露四个抽象操作；命名严格对齐 DSL 顶层字段：

| 操作 | 对应 DSL 字段 | 输入 | 输出 | 语义 |
|---|---|---|---|---|
| `apply_query` | `query:` | 当前累积 ProviderQuery | 折叠后的 ProviderQuery | 把本 provider 对查询的贡献折叠入累积态（DelegateQuery 6e 起委托另一 provider 的 apply_query, 不再是路径重定向） |
| `list` | `list:` | 当前累积 ProviderQuery | 子节点 ChildEntry 列表 | 枚举所有可见子节点（静态 + 动态项数据源驱动） |
| `resolve` | `resolve:` | (段名, 当前累积 ProviderQuery) | 子 provider 引用或不存在 | 给定段名定位单个子 provider；语义按 §5.2 三步顺序（regex `resolve:` → 静态 list 字面 → 动态 list 反查） |
| `get_note` | `note:` | 当前累积 ProviderQuery（隐式可选） | 字符串或空 | 返回 provider 自描述文本；**支持 `${properties.X}` / `${capture[N]}` 等模板插值**，求值规则同 §6（实现期渲染） |

注意：`resolve` 操作**包含**了 §5.2 的全部三步逻辑（不仅仅是 DSL 的 `resolve:` 字段那一步）；
trait 命名取最贴近的 DSL 字段名。

### 12.3 ProviderRegistry 与混合注册

ProviderRegistry 是 pathql 体系的核心仓库；同一 registry 持两种来源的 provider：

```text
RegistryEntry =
  | DslProviderDef     // §1-§11 加载产物
  | ProgrammaticEntry  // 终端编程注册的 factory
```

**DSL 注册**：从 .json5 文件加载（或其他 Loader 适配器），产出 `ProviderDef` AST。
实例化时引擎根据 ProviderInvocation.properties 构造 DslProvider 解释执行。

**编程注册**：终端语言绑定层提供 `register_provider(namespace, name, factory)` 接口，
其中 `factory` 是接受**实例化属性表**并构造 Provider 实例的回调函数：

```text
factory: (properties: Map<string, TemplateValue>) → Provider
```

每次某条路径折叠到该 provider，引擎调用 factory 传入当前 ProviderInvocation 的 properties，
拿到具体 provider 实例后参与 apply_query / list / resolve / get_note。

**为什么是 factory 而非 instance**：同一编程 provider 可能在不同路径上下文下用不同 properties
（例如 `kabegame.album_filter` 用 `album_id=A` vs `album_id=B`），factory 把构造与注册解耦。
注册方决定如何根据 properties 物化 provider；这是编程绑定层的扩展点。

**混合查找**：在路径解析中遇到 `provider: "ns.name"` 引用时，引擎在 registry 按 §1.1 命名空间链
查找；命中 DSL 项 → 实例化 DslProvider；命中 Programmatic 项 → 调 factory。两者对引擎透明。

### 12.4 ProviderName 引用的延迟解析

DSL 加载期允许 ProviderInvocation.provider 引用**未注册**的 namespace.name。理由：
- 终端运行时可能动态注册新 provider（例如插件加载、用户配置）
- 终端可能分批加载 DSL（先核心后插件）
- 严格加载期解析无法表达上述场景

**默认行为**：
- DSL 加载 + validate 不检查 ProviderInvocation.provider 引用是否在 registry 中存在（即 §10 cross-ref 检查默认 off）
- 运行期路径解析到达该引用时才查 registry：
  - 命中 → 正常实例化 / 调 factory
  - 未命中 → 该路径段返回 path-not-found（404 语义）

**严格模式**（可选）：
- 终端调用 validate 时显式开启 cross-ref 检查（实现层提供选项），所有 ProviderInvocation.provider 引用必须在 registry 中找到
- 适合"已知静态 + 已加载所有 DSL + 启动期校验完整性"的场景（如 CI 测试 / 生产 build）

**实现要点**：
- 编程绑定层提供两套构造入口：`register_provider` 注册编程项；DSL 加载注册 DSL 项
- registry 内部用同一查找路径（namespace 链），不区分来源
- 严格模式只是 validate 时的额外检查；不影响运行期 fallback 逻辑

### 12.5 终端查询接口

pathql 体系对终端暴露三个核心查询入口：

| 接口 | 语义 |
|---|---|
| `list(path)` | 解析路径到末端 provider，调其 `list` 抽象操作；返回 `Vec<ChildEntry>` |
| `count(path)` | 解析路径，对末端 provider 累积 ProviderQuery 包 `SELECT COUNT(*) FROM (...)` 执行；返回 `u64` |
| `query<T>(path)` | 解析路径，执行末端 build_sql 产物；按行类型化为 `T`（终端提供 row→T 映射）；返回 `Vec<T>` |

**类型化的责任分配**：
- pathql 抽象层不感知 `T`；它负责产 SQL + bind 参数 + 行迭代
- 终端通过实现"row → T"映射（具体形式视语言绑定 / DB 驱动而定）告诉引擎如何把行投影成业务实体
- 引擎不要求 T 与 ChildEntry 关联——`query<T>` 是数据查询，与子节点枚举正交

**SQL 执行能力的注入模式**（实现层选择，不进 spec）：

`list` / `count` / `query<T>` 内部需要执行 SQL（动态 list 项数据源 / meta SQL 求值 / 终端 query）。
实现可在两种模式间选择，互不冲突：

1. **外部执行模式**（无 DB 驱动 dependency）：pathql 实现暴露
   `list_with_executor(path, executor)` / `query_raw(path) → (sql, bind)` 等接口；
   终端用自己的 DB 驱动（rusqlite / sqlx-sync / 其他）执行；pathql 仅产 SQL 字符串 +
   bind 值 + 方言适配（占位符风格、参数序列化）
2. **内置执行模式**（pathql 绑定具体驱动）：pathql 实现按需引入 DB 驱动 crate（如 sqlx），
   提供完整 `list / count / query<T>` 入口（同步或异步取决于驱动）；连接 / 连接池由调用方实例化后注入到 ProviderRuntime

**Rust 实现示例**（pathql-rs）：
- `compose` feature（默认有，无 DB 驱动）：build_sql 产 (String, `Vec<TemplateValue>`)；终端自执行
- `sqlite` feature（无 `query` feature）：仅适配 SQL 方言输出——`drivers::sqlite::params_for(&[TemplateValue]) → Vec<rusqlite::Value>` 等转换；**不**包 connection / pool
- `query` feature（启用 sqlx）：完整 `runtime.list / count / query<T>` async 接口；pathql-rs 通过 sqlx pool 执行 SQL 不依赖终端

终端按需选择 feature 组合：早期 / 测试期可只开 compose + dialect 适配，自管 connection；
成熟后开 query feature 用绑定执行栈。

### 12.6 抽象层 vs 实现层分工总览

| 概念 / 操作 | 归属 | 备注 |
|---|---|---|
| ProviderDef AST / Loader trait / Registry | 抽象层（spec 定义） | 任何实现都需提供 |
| Provider 抽象操作 (apply_query/list/resolve/get_note) | 抽象层 | 命名固定，对齐 DSL |
| ChildEntry 结构 | 抽象层 | name/provider/meta 三字段 |
| ProviderQuery + 累积语义 | 抽象层 | §3 折叠规则 |
| `${...}` 模板 + 求值器 | 抽象层 | §6 |
| build_sql 输出 (sql, bind 序列) | 抽象层 | dialect-agnostic; 占位风格 / bind 类型由实现层适配 |
| SQL 方言输出适配（占位风格、bind 序列化） | 实现层 / 适配器 | 例如 Rust `drivers::sqlite::params_for`；可独立于执行能力 |
| DB 连接 / 连接池 / async 模型 / 实际执行 | 实现层 / 可选 query 能力 | 终端可选择内置（绑驱动）或外置（自管） |
| typed row 映射（FromRow 等） | 实现层 | 由 host 选择 ORM / 手写 |
| LRU 缓存 / 路径 normalize / case sensitivity | 抽象层（§2 + §4.4） | 实现层据此落地 |

---

## 13. 引用

- 语法 schema：[../../src-tauri/core/src/providers/schema.json5](../../src-tauri/core/src/providers/schema.json5)
- VD 消费者实现：[VD_INTEGRATION.md](./VD_INTEGRATION.md)
- Rust trait 实现：[../../src-tauri/core/src/providers/provider.rs](../../src-tauri/core/src/providers/provider.rs)
- Runtime LRU：[../../src-tauri/core/src/providers/runtime.rs](../../src-tauri/core/src/providers/runtime.rs)
- 旧文档（迁移前 ImageQuery 系统）：[../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
