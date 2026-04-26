# Provider DSL — 加载期与运行期规则

本文档定义 Provider DSL（v0.7）**schema 之外**的语义合约。
[`schema.json5`](../../src-tauri/core/src/providers/schema.json5) 校验语法；本文档校验语义。
两者并列：schema 拒绝的，引擎也拒绝；schema 通过的，本文档列出的规则仍可能拒绝。

---

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

key 不含 `${...}`。值为 `ProviderInvocation` 三态之一：

- `InvokeByName`：`{provider: <name>, properties?, meta?}` — 显式构造命名 provider
- `InvokeByDelegate`：`{delegate: <path>, properties?, meta?}` — 实例化目标路径终点 provider
- `EmptyInvocation`：`{meta?}` — 占位，路径仍可被识别但本节点无 list/resolve 服务（缓存策略见 §4.4）

**meta 字段语义**（三态共用，可选；详见 §4.5）：

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
    "delegate": "./__plugin_source",
    "child_var": "plugin",
    "provider": "${plugin.provider}",
    "properties": { "plugin_id": "${plugin.meta.id}" }
}
```

**加载期约束**：

- key / properties 中所有 `${X.Y}` 的 X **必须等于** `child_var`
- `provider` 字段三态：
  - 缺省 → 不挂 provider（路由壳常见）
  - 字面字符串 → 显式构造命名 provider
  - `${child_var.provider}` → 透传 delegate 返回的 child.provider 整体对象
- delegate 路径返回的每个 ChildEntry `{name, provider?, meta?}` 通过 `${child_var.X}` 引用：
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
| 静态 list key 字面命中 → `InvokeByName` / `InvokeByDelegate` | ✅ 缓存 |
| 动态 list 命中（SQL 行 / delegate child 匹配） | ✅ 缓存 |
| `resolve` 正则命中 → `InvokeByName` / `InvokeByDelegate` | ✅ 缓存 |
| 任意命中 → `EmptyInvocation`（路径合法但无 list 服务） | ❌ **不缓存**（解析本身已是 O(1)，无需占用 LRU 槽位） |
| 路径段未命中（list / resolve / 动态全 miss） | ❌ 不缓存（直接返回 404 / 不存在） |

**缓存键**：normalize 后的完整路径（大小写敏感）；
**缓存值**：`(Arc<dyn Provider>, ImageQuery)`。

**失效**：由数据变更事件（`images-change` / `album-images-change` / 插件装卸 等）显式清空相关前缀；
不靠 TTL。前端不直接感知 LRU 状态，靠事件订阅触发刷新。

### 4.5 meta 字段统一语义

`meta` 字段（出现在 InvokeByName / InvokeByDelegate / EmptyInvocation /
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

### 5.3 加载期碰撞检查（防御性，非正确性必需）

引擎在加载每个 provider 时执行：

- **静态 list 内部**：list key 不能重复（JSON 对象天然约束 + schema 检查）
- **resolve 正则 vs 静态 list key**：每条正则去匹配每个静态 list key 字面，**任一匹配 → 拒绝**
  - 错误示例：`list: { "x100x": ... }` 同时 `resolve: { "x([0-9]+)x": ... }` —— 正则覆盖了静态字面，二义性
- **正则 vs 正则**：用 `regex_automata` 求两条正则的交集 NFA；**非空 → 拒绝**
- **动态 list 不参与碰撞检查**（性能 / 实用性权衡）：
  - 动态项 key 模板的取值集合在加载期未知（依赖运行时 SQL 结果）
  - 即便运行期实际产生碰撞，引擎只是按 §5.2 的顺序简单覆写本路径段的 LRU 槽位
  - 这种碰撞**不是正确性故障**，但**可能产生不可预见的 bug**（哪个 entry 优先取决于 §5.2 的顺序，对设计者不直观）
- 所有拒绝错误必须打印**触发文件 + 具体冲突项 + 冲突原因**

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
| `${properties.<name>}` | 任何 TemplateExpr / SqlExpr / PathExpr | 当前 provider 实例化属性值 |
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

- PathExpr 加载期校验：起始 `./`、不含 `..` 段（运行期防御性二次检查）
- 所有路径段在 resolve 前 percent-decode（兼容前端 `encodeURIComponent`）
- 不允许跨 root 引用（v0.7 不支持绝对路径）

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
- [ ] ProviderInvocation.provider 引用解析成功：
  - [ ] 按当前 namespace → 父 namespace → root 顺序查到目标 provider
  - [ ] 简单名 / 绝对名 'a.b.c.name' 均可
- [ ] PathExpr 内：
  - [ ] 不含 `..` 段
  - [ ] 起始 `./`

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

---

## 12. 引用

- 语法 schema：[../../src-tauri/core/src/providers/schema.json5](../../src-tauri/core/src/providers/schema.json5)
- VD 消费者实现：[VD_INTEGRATION.md](./VD_INTEGRATION.md)
- Rust trait 实现：[../../src-tauri/core/src/providers/provider.rs](../../src-tauri/core/src/providers/provider.rs)
- Runtime LRU：[../../src-tauri/core/src/providers/runtime.rs](../../src-tauri/core/src/providers/runtime.rs)
- 旧文档（迁移前 ImageQuery 系统）：[../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
