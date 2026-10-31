# `images.type` 规范化保证 + 索引：去掉查询里的类型转换

## 总体设计思路

v023 已经把 `images.type` 统一成格式键（`image/jpg`、`video/mp4`、`x-wpe/web`……），写入口 `Storage::add_image` 也会先经
`normalize_stored_media_type` 规范化。但查询层仍然按「值可能为空、大小写不一、可能没有斜杠」来防御：媒体类型相关的 provider
每一处都包着 `LOWER(COALESCE(images.type, ''))`，格式过滤还要按「有没有斜杠」分支。两份真实库里不合规的行都是 0：开发库 v48
共 5302 行，本机正式库 v46 共 64151 行。这些转换防的是一个现实中不存在的情况，只是这个保证从来没有被写成明确的约定，所以没人敢删。

本计划把「`type` 一定非空、已转小写并去掉首尾空白、形如 `主类/子类` 且两段都非空」定为 `images.type` 的不变量，**由 Rust 层保证**，
然后把查询改成直接读列，并给 `type` 建一个普通索引，供高选择性的等值查询使用（第一个用户是 B 段计划网页壁纸访问表的
`list_wpe_web_rows`）。保证分两步：
- 迁移 v049 一次性修正历史残留（预期 0 行），并建索引。迁移里的修正规则自包含，不读运行时格式表，与 v023 的写法一致。
- 之后所有写入都经 `add_image`。`normalize_stored_media_type` 改为直接返回 `String`，对任何输入都给出合规值：格式表外的值也按同一条规则兜底。
  测试逐条比对它与迁移修正规则的结果，防止两份规则漂移。

数据库不加触发器、`CHECK`，也不重建表，schema 里不放规则；新写入 `type` 的路径必须经这个函数，这条写进 AGENTS 与 RULES。

另一个关键决策是**过滤条件刻意保持「规划器用不上 `idx_images_type`」的形态**。`type` 只有十几种取值，本库也不跑 `ANALYZE`。
实测裸写 `type = 'image/jpg' ORDER BY crawled_at DESC LIMIT 100` 时，规划器会改走 type 索引，取出全部匹配行再整体排序，耗时 15 ms；
加 `+` 禁用索引后，沿 `idx_crawled_at` 取到 100 行就停，只要 1 ms。所以分类过滤继续包在 `CASE ${kind}` 里，格式过滤是 `SUBSTR`
表达式，两者天然用不上这个索引，画廊分页的执行计划保持不变。索引只服务 `x-wpe/web` 这类高选择性的等值查询，这条约束也写进 RULES。

语义不变：`x-wpe/video` 在媒体类型过滤里仍归「图片」，与现状和前端 `isVideoMediaType` 一致；格式列举仍按斜杠后的子类分组。
用户看不到任何变化。收益是查询更简单，全表计数时每行少做几次函数调用（实测分类计数从 24 ms 降到 15 ms，格式过滤从 20 ms 降到 14 ms，
CPU 时间约减半），外加一个可用的 type 索引。

---

## 现状锚点

**a. 列定义与写入口**（`kabegame-core/src/storage/migrations/init.rs:87`、`storage/images.rs:950`、`media/image_type.rs:421`）
```sql
-- init.rs —— 现状：可空，默认值是 v023 之前的遗留值 'image'（不是格式键）；升级库同样如此
type                  TEXT    DEFAULT 'image',
```
```rust
// images.rs —— 现状：唯一的生产插入口，插入前规范化
pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
    image.media_type =
        crate::media::image_type::normalize_stored_media_type(image.media_type.take());
    /* INSERT INTO images (… type …) VALUES (… ?10 …) */
}

// image_type.rs —— 现状：返回 Option 但总是 Some；格式表外的值原样转小写保留，可能没有斜杠（如 "gif"）
pub fn normalize_stored_media_type(media_type: Option<String>) -> Option<String> {
    let raw = media_type.unwrap_or_default();
    let s = raw.trim();
    if s.is_empty() { return Some(default_image_format().to_string()); }
    let lower = s.to_lowercase();
    if lower == "image" { return Some(default_image_format().to_string()); }
    if lower == "video" { return Some(default_video_format().to_string()); }
    Some(media_format(&lower).map(|format| format.key.to_string()).unwrap_or(lower))
}

// providers/query.rs:603 —— 现状：读 PathQL 行时也过一遍（另一个调用方）
media_type: crate::media::image_type::normalize_stored_media_type(s("type")),
```
> 现状：生产代码里没有任何 `UPDATE images SET type`。除测试夹具外，`add_image` 是唯一会写这一列的地方。

**b. 查询里的防御式转换**（`kabegame-core/src/providers/dsl/images/…`）
```json5
// gallery/gallery_route.json5:94、vd/vd_root_router.json5:25 —— 现状：投影兜底 NULL
{ "sql": "COALESCE(images.type, 'image')", "as": "type", "in_need": true }

// gallery/media_type/gallery_media_type_provider.json5:10、gallery/album/gallery_album_media_type_provider.json5:8
// —— 现状：分类过滤，同一个判断写两遍（含历史值 'video'）
"where": "CASE ${properties.kind} WHEN 'video' THEN (LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%') ELSE NOT (LOWER(COALESCE(images.type, '')) = 'video' OR LOWER(COALESCE(images.type, '')) LIKE 'video/%') END"

// gallery_media_type_provider.json5:16 —— 现状：格式列举，先过滤掉没有斜杠的行，再丢掉空格式
"sql": "SELECT format, cnt AS count FROM (SELECT LOWER(SUBSTR(COALESCE(sub.type, ''), INSTR(COALESCE(sub.type, ''), '/') + 1)) AS format, COUNT(*) AS cnt FROM (${composed}) AS sub WHERE LOWER(COALESCE(sub.type, '')) LIKE '%/%' GROUP BY format) WHERE format != '' AND cnt > 0 ORDER BY format ASC"

// gallery/media_type/gallery_media_format_provider.json5:8 —— 现状：格式过滤按「有没有斜杠」分支
"where": "LOWER(CASE WHEN INSTR(COALESCE(images.type, ''), '/') > 0 THEN SUBSTR(COALESCE(images.type, ''), INSTR(COALESCE(images.type, ''), '/') + 1) ELSE COALESCE(images.type, '') END) = ${properties.format}"
```
```yaml
# gallery/media_type/gallery_media_type_router.yaml:19 —— 现状：分类列举的 kind 判定（与上面的 WHERE 同源）
CASE
  WHEN LOWER(COALESCE(sub.type, '')) = 'video' OR LOWER(COALESCE(sub.type, '')) LIKE 'video/%'
    THEN 'video'
  ELSE 'image'
END AS kind,
```

**c. 测试夹具**
```sql
-- tests/dsl_e2e.rs:225、tests/zz_scratch_albums.rs:214、src/providers/query.rs:650 —— 现状：自建 images 表，默认值同样是 'image'
type TEXT DEFAULT 'image',
```
```rust
// storage/albums.rs:2150 等 6 处、plugin/metadata_migration.rs:721 —— 现状：用真实 schema，插入时省略 type（得到 'image'），
// 这些测试都不涉及媒体类型查询
"INSERT INTO images (id, local_path, crawled_at) VALUES (1, '/tmp/label.jpg', 1)"

// tests/dsl_e2e.rs:2776 —— 现状：断言文案以投影里的 COALESCE 为前提
"{path} decoded with media_type = {:?}; the COALESCE default was lost"
```

**d. 实测依据**（本机正式库的只读副本，64151 行，macOS，热缓存）

| 查询 | 现状 | 改写后 / 加索引后 |
| --- | --- | --- |
| 不合规行（两份库） | 0 / 0 | — |
| 分类过滤计数（CASE + video） | 24 ms | 15 ms |
| 格式过滤计数（= `webp`） | 20 ms | 14 ms |
| `type = 'x-wpe/web'` | 全表扫描 | `SEARCH images USING INDEX idx_images_type (type=?)` |
| CASE 包裹的分类过滤 + `ORDER BY crawled_at DESC LIMIT 100` | `idx_crawled_at` | 仍是 `idx_crawled_at`（不受新索引影响） |
| 裸 `type = 'image/jpg'` + `ORDER BY crawled_at DESC LIMIT 100` | — | 选 `idx_images_type` + 临时 B 树排序，15 ms；写 `+type` 为 1 ms |
| 迁移：首次全表扫描（冷缓存） | — | 约 0.8 s（主要是读库页）；之后建索引 18 ms |

---

## 点 1 — 迁移 v049：一次性修正残留 + 索引（`storage/migrations/v049_images_type_normalized.rs`）

- **新增** 迁移模块（编号以实施时的最新迁移为准，B 段计划和其它分支也可能在加迁移）
```rust
//! `images.type` 一次性规范化 + 普通索引。
//!
//! 不变量：type 非空，等于 lower(trim(type))，形如「主类/子类」且两段都非空（如 `image/jpg`、`x-wpe/web`）。
//! 本迁移只修正历史残留（v023 之后预期 0 行）；之后由 Rust 写入口保证（`normalize_stored_media_type`），
//! 数据库不放触发器或约束。规则自包含，不读运行时格式表（同 v023），所以不做别名归并（`image/jpeg` 本身合规，保持原样）。
//!
//! 索引注意：type 只有十几种取值，本库不跑 ANALYZE。按 type 过滤再 `ORDER BY … LIMIT` 的查询若写成可走索引的形态，
//! 规划器会选本索引再整体排序（实测 6.4 万行 15 ms，对比沿排序索引 1 ms）。见 `cocs/provider-dsl/RULES.md`。

use rusqlite::Connection;

/// 把列 `type` 规范成合规值；与 `normalize_stored_media_type` 对格式表外输入的兜底规则相同（有测试比对）。
pub(crate) const NORMALIZED_TYPE_SQL: &str = "CASE
    WHEN lower(trim(COALESCE(type, ''))) IN ('', 'image') THEN 'image/jpg'
    WHEN lower(trim(type)) = 'video' THEN 'video/mp4'
    WHEN instr(lower(trim(type)), '/') = 0 THEN 'image/' || lower(trim(type))
    WHEN instr(lower(trim(type)), '/') = 1 OR substr(lower(trim(type)), -1) = '/' THEN 'image/jpg'
    ELSE lower(trim(type))
  END";

/// `type` 不满足不变量。
const VIOLATES_SQL: &str =
    "type IS NULL OR type <> lower(trim(type)) OR instr(type, '/') <= 1 OR substr(type, -1) = '/'";

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN").map_err(|e| format!("v049 begin: {e}"))?;
    let result = (|| {
        // 先建索引：建索引本来就要读一遍表，冷启动的 IO 只付这一次，下面的修正扫描就落在缓存里
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_images_type ON images(type);")
            .map_err(|e| format!("v049 create index: {e}"))?;
        let fixed = conn
            .execute(&format!("UPDATE images SET type = {NORMALIZED_TYPE_SQL} WHERE {VIOLATES_SQL}"), [])
            .map_err(|e| format!("v049 normalize images.type: {e}"))?;
        if fixed > 0 {
            tracing::info!("v049: 修正 {fixed} 行 images.type");
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| format!("v049 commit: {e}")),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
```
- **修改** `migrations/mod.rs`
```rust
mod v049_images_type_normalized;   // 新增
// MIGRATIONS 末尾新增：
Migration {
    version: 49,
    name: "images_type_normalized",
    up: v049_images_type_normalized::up,
    min_backfill_version: None,   // 发布态没有回填作业，也没有作业读写 images.type
},
pub const LATEST_VERSION: u32 = 49;   // 修改：48 → 49
```
- **修改** `migrations/init.rs::create_all_tables`：在 `images` 的索引列表里加一行（同 v036 的写法，注释注明来源）。
```sql
CREATE INDEX idx_images_type ON images(type);   -- 新增：同 v049；按 type 过滤的分页查询不要写成可走本索引的形态
```
  - 列定义 `type TEXT DEFAULT 'image'` **保持不变**：改默认值要重建表，而且新库和升级库应当一致。生产写入都经 `add_image`，
    不会用到这个默认值。旁边加注释说明「遗留默认值，不满足不变量，写入必须显式给出规范化后的 type」。

## 点 2 — Rust 层保证：写入口总给出合规值（`media/image_type.rs`、`storage/images.rs`）

- **修改** `normalize_stored_media_type` 改为返回 `String`。格式表里查不到时，按与 v049 相同的规则兜底，返回值对任何输入都满足不变量。
```rust
/// `images.type` 的唯一规范化入口：返回值一定非空、小写、形如「主类/子类」且两段都非空。
/// 所有写入 `images.type` 的路径都必须经过它（查询层据此直接读列，不再包 LOWER / COALESCE）。
pub fn normalize_stored_media_type(media_type: Option<String>) -> String {   // 修改：Option<String> → String
    let raw = media_type.unwrap_or_default();
    let lower = raw.trim().to_lowercase();
    if lower.is_empty() || lower == "image" {
        return default_image_format().to_string();
    }
    if lower == "video" {
        return default_video_format().to_string();
    }
    if let Some(format) = media_format(&lower) {
        return format.key.to_string();
    }
    // 修改：格式表外的值按 v049 的同一条规则兜底
    match lower.find('/') {
        None => format!("image/{lower}"),
        Some(0) => default_image_format().to_string(),
        Some(_) if lower.ends_with('/') => default_image_format().to_string(),
        Some(_) => lower,
    }
}

/// 新增：是否满足 `images.type` 的不变量（测试与断言用）。
pub fn is_stored_media_type(value: &str) -> bool {
    value == value.trim().to_lowercase()
        && value.find('/').is_some_and(|slash| slash > 0 && slash + 1 < value.len())
}
```
- **修改** 两个调用方随签名调整
```rust
// storage/images.rs::add_image
image.media_type = Some(crate::media::image_type::normalize_stored_media_type(image.media_type.take()));   // 修改
// 新增：写入口的不变量，debug 构建下兜住以后改坏规范化函数的情况
debug_assert!(image.media_type.as_deref().is_some_and(crate::media::image_type::is_stored_media_type));

// providers/query.rs:603（读 PathQL 行）
media_type: Some(crate::media::image_type::normalize_stored_media_type(s("type"))),   // 修改：行为不变
```
- **修改** 单测（`image_type.rs`）：
  - 表驱动用例：`None`、`""`、`" IMAGE "`、`"Video"`、`"gif"`、`"/webp"`、`"image/"`、`"x-wpe/web"`、`"image/jpeg"`、`"text/plain"`。
    每个输出都满足 `is_stored_media_type`；现有三条断言改成比较 `String`。
  - 规则比对：对格式表外的 ASCII 输入，在内存库里执行 `v049::NORMALIZED_TYPE_SQL`，断言与 Rust 结果逐一相同。
    这样迁移修正出的值和以后 Rust 写入的值是同一种形态。

## 点 3 — 查询改写（`providers/dsl/images/…`）

- **修改** 投影：`gallery/gallery_route.json5`、`vd/vd_root_router.json5`
```json5
{ "sql": "images.type", "as": "type", "in_need": true },   // 修改：去掉 COALESCE，type 不变量保证非空
```
- **修改** 分类过滤：`gallery/media_type/gallery_media_type_provider.json5`、`gallery/album/gallery_album_media_type_provider.json5`
```json5
// 修改：type 已小写且形如「主类/子类」，历史值 'video' 已不存在，GLOB 区分大小写正合适。
// 保持 CASE 包裹：type 取值少，写成可走索引的形态会让分页查询改走 idx_images_type 再整体排序（见 RULES）。
"where": "CASE ${properties.kind} WHEN 'video' THEN images.type GLOB 'video/*' ELSE NOT (images.type GLOB 'video/*') END"
```
- **修改** 格式列举：`gallery_media_type_provider.json5` 的 `list`
```json5
// 修改：不再过滤无斜杠行、不再丢空格式（不变量保证两段都非空）
"sql": "SELECT SUBSTR(sub.type, INSTR(sub.type, '/') + 1) AS format, COUNT(*) AS count FROM (${composed}) AS sub GROUP BY format ORDER BY format ASC",
```
- **修改** 格式过滤：`gallery/media_type/gallery_media_format_provider.json5`
```json5
// 修改：直接取斜杠后的子类；表达式本身用不上 type 索引，分页计划不变
"where": "SUBSTR(images.type, INSTR(images.type, '/') + 1) = ${properties.format}"
```
- **修改** 分类列举：`gallery/media_type/gallery_media_type_router.yaml`
```yaml
CASE WHEN sub.type GLOB 'video/*' THEN 'video' ELSE 'image' END AS kind,   # 修改：与 gallery_media_type_provider 的 WHERE 同源
```
- **不改**：`image_basic_provider.json5` 的 `images.type` 投影本来就直接读列。Rust 侧的 `is_video_like_type` 和前端 `isVideoMediaType`
  仍兼容历史值 `'video'`：它们处理的是任意来源的字符串，不只是库里的值。

## 点 4 — 测试与夹具

- **新增** v049 单测（同 v039 写法）：
  - 修正残留：把点 2 那组表驱动输入写进内存库后跑 `up`，逐一断言结果；已合规的值（`image/jpg`、`image/jpeg`、`x-wpe/web`）保持原样。
  - 幂等：`up` 连跑两次不报错，第二次修正 0 行。
  - 执行计划回归：`type = ?` 走 `idx_images_type`；CASE 包裹的分类过滤加 `ORDER BY crawled_at DESC LIMIT 100` 仍走 `idx_crawled_at`。
    这一条防止以后有人「顺手」把 CASE 拆掉。
- **修改** 自建表夹具 `tests/dsl_e2e.rs:225`、`tests/zz_scratch_albums.rs:214`、`src/providers/query.rs:650`：`type TEXT DEFAULT 'image'` 改为 `DEFAULT 'image/jpg'`。
  这些夹具用来测 provider 查询，省略 type 的行也要满足不变量。已有的显式取值（`image/jpeg`、`video/mp4`……）本来就合规，不动，避免改到断言。
- **修改** `tests/dsl_e2e.rs:2776` 的断言文案：`the COALESCE default was lost` 改成「images.type 必须非空（不变量见 v049）」。
- **不改**：用真实 schema、省略 type 插入的夹具（`albums.rs` 6 处、`metadata_migration.rs`）。它们绕过了 `add_image`，得到遗留默认值 `'image'`，
  但都不涉及媒体类型查询；按不变量，它不属于生产数据。

## 点 5 — 文档、回归与 changelog

- `cocs/provider-dsl/RULES.md`：新增一小节「低选择性列的过滤形态」。写明 `images.type` 的不变量与「由 Rust 写入口保证」，
  以及按 `type` 过滤的分页查询不能写成可走 `idx_images_type` 的形态（需要时用 `CASE` 包裹或 `+images.type`），附 15 ms 对 1 ms 的实测。
- `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md:71`：`COALESCE(images.type, 'image') = ?` 的过时描述改成现状；媒体类型列举一节同步。
- `cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`：补一条，说明 v049 的修正规则与 Rust 规范化函数之间有比对测试。
- `apps/docs/src/content/docs/reference/mcp.md:150`：「只有历史空值才回落为 `image`」已不成立，改成「`type` 总是非空的格式键」。
- `AGENTS.md`「文件类型的唯一事实来源」：补一句「`images.type` 一定是小写的 `主类/子类`，写入必须经 `normalize_stored_media_type`，
  查询直接读列，不要再包 `LOWER` / `COALESCE`；按 type 过滤的分页查询注意别走上 `idx_images_type`」。
- `versions/latest/regression.md` 新增一节；`changelog.md` 的 Internal 加一行。

---

## 行为变化（需留意）
- **用户侧无变化。** 两份真实库的不合规行为 0，过滤与列举结果逐行相同。
- **格式列举不再排除「无斜杠」和「空格式」的行。** 按不变量这类行不存在。
- **格式表外的写入值会被改写成 `主类/子类`。** 例如 `'gif'` 落库为 `image/gif`，`'/webp'` 落库为 `image/jpg`；以前是原样转小写落库。
  现有写入口传入的都是格式表里的键或 `x-wpe/*`，实际不会触发。
- **保证只在 Rust 层。** 以后若有代码绕过 `add_image` 直接写 SQL，又没有经过 `normalize_stored_media_type`，数据库不会拦。
  这种写法会让媒体类型过滤静默归错类，所以约束写进 AGENTS 与 RULES，`add_image` 里加 `debug_assert`。
- **写入多维护一个索引。**
- **升级耗时。** 本机正式库停在 v46，会依次跑 v047、v048、v049。v049 冷缓存下约 0.8 s，主要是读库页的 IO，在启动页的迁移阶段完成。

## 与其它计划的关系
- [B 段计划](/Users/didi/.claude/plans/b-frame-scoped-ipc.md) 点 6 的 `list_wpe_web_rows`（`type = ?` 绑定格式表里 `x-wpe/web` 的键）依赖本计划的 `idx_images_type`，本计划需先合入。

## 涉及文件
- `src-tauri/kabegame-core/src/storage/migrations/{mod.rs,init.rs,v049_images_type_normalized.rs}`
- `src-tauri/kabegame-core/src/media/image_type.rs`、`src-tauri/kabegame-core/src/storage/images.rs`、`src-tauri/kabegame-core/src/providers/query.rs`
- `src-tauri/kabegame-core/src/providers/dsl/images/{gallery/gallery_route.json5,vd/vd_root_router.json5,gallery/media_type/{gallery_media_type_provider.json5,gallery_media_format_provider.json5,gallery_media_type_router.yaml},gallery/album/gallery_album_media_type_provider.json5}`
- 测试：`src-tauri/kabegame-core/tests/{dsl_e2e.rs,zz_scratch_albums.rs}`
- 文档：`cocs/provider-dsl/RULES.md`、`cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`、`cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`、`apps/docs/src/content/docs/reference/mcp.md`、`AGENTS.md`、`versions/latest/{regression.md,changelog.md}`

## 实施顺序与验证
1. 先做点 1、点 2，用 test-kabegame 跑 `kabegame-core --lib migrations` 与 `image_type` 的单测。
2. 再做点 3、点 4，跑 `kabegame-core` 全量测试（含 `dsl_e2e`、`zz_scratch_albums`）；用 check-kabegame 做编译检查；只对改过的 Rust 文件跑 rustfmt。
3. 本机正式库副本：复制到草稿目录，把 dev 的数据目录临时指向它启动一次，确认三件事：
   - 迁移日志里没有「修正 N 行」，或 N 为 0；
   - `sqlite_master` 里有 `idx_images_type`；
   - 画廊媒体类型筛选（图片 / 视频 / 各格式）的计数与迁移前相同：迁移前后各用 `kabegame-cli pathql query` 读一次 `images://gallery/media-type` 的列举。
4. 开发库真机（kabegame-chromium）：
   - 画廊过滤面板的媒体类型与格式计数、筛选结果、虚拟盘「按媒体」目录，都与迁移前一致；
   - 用 `KABEGAME_SQL_DEBUG` 看一次带媒体类型过滤的画廊分页 SQL，确认执行计划仍走 `idx_crawled_at`；
   - 下载一张图、本地导入一个文件，库里的 `type` 都是格式键。
