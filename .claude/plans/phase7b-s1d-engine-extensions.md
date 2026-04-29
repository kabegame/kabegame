# Phase 7b-S1d — Field 字符串简写 + 默认 SELECT 兜底 + RULES 同步

## Context

S1c 把 `${global.X}` 引擎扩展 + 三处 property 迁移落地后，引擎层还有两条之前提到的扩展未做：

1. **Field 字符串简写**：当前 [gallery_route.json5:19-52](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5#L19) 17 个 fields 全是 `{ "sql": "images.url" }` 这种繁琐对象形态。无 alias / 不参与共享的纯 SQL 列应该允许写裸字符串 `"images.url"`。
2. **默认 SELECT 兜底归 pathql 管**：[storage/gallery.rs:281-283 + 405-407](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L281) 两处 `if q.fields.is_empty() { q.with_field_raw("images.*", ...) }` 是历史 workaround —— 该逻辑应该在 pathql 层（`<from>.*` 当 from 是简单标识符），storage 不应该越权改 ProviderQuery。

S1c + S1d 完成后，三个引擎扩展（globals / field 简写 / 默认 `<from>.*`）全部落地，再统一写进 [RULES.md](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) + [schema.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/schema.json5)。

**目标**：
1. pathql `Field` AST 加字符串简写（`#[serde(untagged)]` 二态：纯字符串 ↔ 完整对象）
2. pathql `compose/build.rs` 默认 SELECT：fields 为空时输出 `<from>.*`（from 是单个 identifier 时）；否则回退 `*`
3. 删除 storage/gallery.rs 两处 `images.*` 注入 hack
4. RULES.md + schema.json5 同步：globals 新 namespace、field 简写形态、默认 SELECT 行为

## 关键设计点

**1. Field 简写无 alias / 无 in_need**

字符串形态等价于 `{sql: <s>}`：
- `alias = None`
- `in_need = None`

要带 alias / 共享 / 内嵌模板的，仍写完整对象。

**2. 默认 SELECT 兜底语义**

[compose/build.rs:77-80](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/build.rs#L77) 当前空 fields → `SELECT *`。改为：
- `from` 是单 identifier（无空格、无 SQL 关键字、纯 `[A-Za-z_][A-Za-z0-9_]*`）→ `SELECT <from>.*`
- 其他形态（CTE / 子查询 / 多表 / 含模板未渲染）→ 回退 `SELECT *`

判定逻辑：拿渲染后的 from 字符串做 ASCII identifier regex 匹配（`^[A-Za-z_][A-Za-z0-9_]*$`），命中就 `<from>.*`，否则 `*`。

**3. JoinDecl 简写不做**

Join 最小元素是 `table + as`（两个独立字段），字符串简写需要解析 `"album_images AS ai"` —— 增加 SQL 解析负担、错误信息差，收益不大。本期不做。

**4. RULES.md / schema.json5 一并更新（globals 也补上）**

S1c 落地时如果还没补 RULES（看实际实现是否已加）—— 这次一起补完整：
- §3.2 join/fields 共享：补字符串简写形态
- §3 字段表 / §3.1 from：补 "fields 为空 → SELECT `<from>.*`" 默认行为
- §6 模板命名空间表：补 `${global.X}` 行
- §10 校验：补 `${global.X}` 在 scope check 里的位置

## 子任务

### S1d-a — Field 字符串简写（一次 commit）

| 文件 | 改动 |
|---|---|
| [ast/query_atoms.rs:8-16](d:/Codes/kabegame/src-tauri/pathql-rs/src/ast/query_atoms.rs#L8) `Field` | 改造：`Field` 重命名为 `FieldDeclFull`（私有）；新建 `pub enum FieldDecl { Inline(SqlExpr), Full(FieldDeclFull) }` 加 `#[serde(untagged)]`；`From<FieldDecl> for normalized form` 或在 fold/build 处统一展开 |
| 替代方案 | 保留 `Field` 名，加 visitor `Deserialize<'de>`：visitor.visit_string → `Field { sql: SqlExpr(s), alias: None, in_need: None }`；visitor.visit_map → 现有对象解析。**推荐这个方案**，对下游使用方零破坏 |
| [ast/query_atoms.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/ast/query_atoms.rs) test 模块 | 加 3 case：(a) `"images.url"` 字面字符串；(b) 完整对象保留行为；(c) trailing JSON 错误信息 |
| [validate/cross_ref.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/validate/cross_ref.rs) + [validate/sql_check.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/validate/sql_check.rs) | 字段遍历用 `field.sql` —— 简写形态展开后字段名一致，零改动确认 |
| [compose/fold.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/fold.rs) | 同上确认零改动；in_need 共享按 alias.is_some() 判断，简写形态 alias=None 就是新增（不参与去重）—— 行为符合预期 |
| [dsl/gallery/gallery_route.json5:19-52](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5#L19) | 把 14 个无 alias 的 `{ "sql": "images.xxx" }` 缩成 `"images.xxx"`；保留 4 个有 alias 的（id / thumbnail_path / is_favorite / is_hidden / media_type）|

**测试**：
- `cargo test -p pathql-rs --features "json5 validate"` 全绿
- `bun check -c main` 干净
- 启动 dev server 确认 gallery_route 能正常加载并产出图片列表

### S1d-b — 默认 SELECT `<from>.*`（一次 commit）

| 文件 | 改动 |
|---|---|
| [compose/build.rs:77-80](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/build.rs#L77) | 把 `if self.fields.is_empty() { sql.push_str("*"); }` 改为：渲染好 `from_sql` 字符串后判断 —— 命中 ASCII identifier regex 就拼 `<from>.*`，否则 `*`。注意 from 此时已经过模板渲染（如果有 `${...}`）|
| [compose/build.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/compose/build.rs) test (行 255-320) | `select_star_when_no_fields`（行 258-261）改为 `SELECT images.* FROM images`；新增 case `select_star_when_from_complex` 验证子查询 from 仍走 `*` |
| [storage/gallery.rs:281-283](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L281) | 删除 3 行 hack |
| [storage/gallery.rs:404-407](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs#L404) | 删除 3 行 hack |
| [storage/gallery.rs](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs) 上方注释 | 注释 `// 强制 SELECT images.*` 一并删掉，避免误导 |

**测试**：
- pathql-rs build.rs 单测全绿
- `bun dev` 浏览 `/gallery/all/`、`/gallery/all/x100x/1/`、`/gallery/hide/all/1/` 列表正常（gallery_route 仍声明 17 fields，storage hack 删除后行为不变）
- 手测一个空 fields 场景（如临时构造一个 ProviderQuery 注入测试 fixture）确认默认 `<from>.*` 行为正确

### S1d-c — RULES.md + schema.json5 同步（一次 commit）

把 S1c（globals）+ S1d-a（field 简写）+ S1d-b（默认 SELECT）三个引擎扩展统一写入文档。

**[RULES.md](d:/Codes/kabegame/cocs/provider-dsl/RULES.md) 修订**：

| 章节 | 改动 |
|---|---|
| §3 字段表 | `fields[]` 行注脚补："为空时引擎默认 `SELECT <from>.*`（from 是单 identifier）或 `SELECT *`（其他）" |
| §3.1 from | 末尾段补："from 简单标识符场景下，空 fields 等价于 `<from>.*`，避免 JOIN 列歧义。" |
| §3.2 join / fields 共享 | 头部加："`fields[]` 项支持 **简写字符串形态**：纯字符串 `"images.url"` 等价于 `{ "sql": "images.url" }`（无 alias、不参与 in_need 共享）。需带 alias / 共享 / 模板的仍写完整对象。" |
| §6 模板命名空间表 | 加一行：`${global.<key>}` — runtime-frozen globals（host 启动期注入），bind-param 渲染，所有 SQL/key/meta 模板可用 |
| §10 加载期校验 | "scope 校验允许 ns" 列表加 `global` |

**[schema.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/schema.json5) 修订**：

| 定义 | 改动 |
|---|---|
| `FieldDecl` / 类似 | 改为 `oneOf: [{ type: "string" }, { type: "object", properties: {...原有...} }]`，描述补 "字符串简写等价 `{sql: <s>}`" |
| 顶层模板变量说明（如有） | 列举 `${properties.X}` / `${capture[N]}` / `${data_var.X}` / `${child_var.X}` / `${composed}` / `${ref:X}` / **`${global.X}`** |
| `from` 描述 | 补 "若全路径未声明 fields，引擎默认 `SELECT <from>.*`（单 identifier）或 `SELECT *`" |

**测试**：
- 校验 schema：用 VSCode JSON5 schema 验证 9 个 .json5 仍合法
- `cargo test -p pathql-rs --features "json5 validate"` 全绿（schema 改动通常不影响 pathql 单测，但跑一遍兜底）
- 文档自检：通读 RULES.md，确认与实现行为一致

## 子任务执行顺序

S1d-a → S1d-b → S1d-c。简写在前（让 .json5 提早瘦身、便于 b 测试时 fixture 简洁），默认 SELECT 在中（删 storage hack 不依赖 a），文档收尾。

## 验证（汇总）

1. `cargo test -p pathql-rs --features "json5 validate"` 全绿
2. `cargo check -p kabegame-core` 干净
3. `bun check -c main` 干净
4. `bun dev -c main --data prod`，浏览：
   - `/gallery/all/` → 默认页有图，列宽正常
   - `/gallery/all/1/` / `/gallery/all/x100x/1/` → 翻页正常
   - `/gallery/hide/all/1/` → hide WHERE 生效
   - `/vd/i18n-zh_CN/` → VD 路径不回归
5. 文件视觉对比：[gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) 的 fields 节从 ~34 行缩到 ~20 行
6. `grep -rn "with_field_raw.*images\.\*\|fields\.is_empty" src-tauri/core/src/storage/` 应返回 0 条

## 风险

- **Field 字符串简写的 visitor 实现**：手写 `Deserialize<'de>` visitor 比 `#[serde(untagged)]` 更稳（错误信息更好），但代码量稍大。优先 visitor 路线 —— `untagged` 在格式错误时给出 "data did not match any variant" 这种含糊错误。
- **默认 `<from>.*` 改变现有行为**：现有空-fields 测试 / fixture 都假设 `SELECT *`。Grep `SELECT \*` 在 pathql-rs/tests + src 找全部断言点跟改。
- **storage hack 删除后的 fields 假设**：所有走 `get_images_*_by_query` 的代码路径目前都依赖 gallery_route 显式声明 17 fields。如果未来某 provider 链不走 gallery_route（如新加的虚盘路径），需要自己声明 fields 或继承 `<from>.*` 默认 —— 由 RULES §3.1 注脚明确这一契约。
