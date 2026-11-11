# 04 任意颜色的现算排序

## 总体设计思路

没存成色桶的颜色不预存距离。用户在取色面板里点了某个颜色、选「按这个颜色排序」，前端发现它不在色桶列表里，就用另一个排序段 `sort/by-any-color_0x<rrggbb>`。这个段有自己的 provider：不连关系表，直接按一个宿主 SQL 函数排序：

```sql
ORDER BY kb_palette_distance(images.palette, ?hex), images.id
```

后端不判断某个颜色该走哪条路：`by-color_0x…` 只认色桶，`by-any-color_0x…` 认任何颜色（包括恰好是色桶的颜色，结果一样、只是慢），选择权在调用方。

`kb_palette_distance` 只是 `media::palette::distance_to` 的 SQL 外壳：把 `palette` 列的 JSON 文本解析成色盘，算它到参考色的距离；列为 NULL 或解析不了时返回 65536。入库与回填写进关系表的距离也是 `distance_to` 算的，所以同一个颜色走现算和走预计算得到的顺序相同——这一点有测试固定。

这条路和随机排序是同一种形态（按宿主函数的值排序、以 `images.id` 收尾），代价也同类：要对全部候选行求值再整体排序。画廊行分页的内层只投影 `id`、中层打序号、外层回表，所以送进排序器的行很窄；函数本身每行要解析一小段 JSON、做至多 5 次 OKLab 换算。估计 6.5 万行一页在几十毫秒，百万行约一秒量级，P3 用实际库测过后把数字写进文档。它慢是设计上接受的：任意颜色是偶尔点一下的操作，常用的颜色有基本色桶。

这条路不落任何持久状态。收藏视图存的是查询体（路径文本），按现算颜色排序的视图存下来就是 `by-any-color_0x…`，不会替用户生成色桶，应用时照样现算；轮播路径同理。想让它变快，由用户把这个颜色保存成色桶（[04b-custom-buckets.md](04b-custom-buckets.md)），那之后前端改用 `by-color_0x…`。

## 现状锚点

**a. 宿主 SQL 函数的登记**（`storage/dsl_funcs.rs:61`、`:115`）

```rust
/// 在给定 connection 上注册所有 DSL 主机 SQL 函数。
/// connection-scoped — 写连接和读池中的每条连接都要独立注册。
pub(crate) fn register_dsl_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    register_kb_rand(conn)?;
    register_get_plugin(conn)?;
    register_crawled_at_seconds(conn)?;
    register_vd_display_name(conn)?;
    register_name_language_functions(conn)?;
    register_is_search_dummy_url(conn)?;
    Ok(())
}

fn register_kb_rand(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "kb_rand",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> { ... },
    )
}
```

**b. 按宿主函数排序的 provider**（`sort/gallery_sort_by_random_provider.json5`）

```json5
{
    "namespace": "kabegame",
    "name": "gallery_sort_by_random_provider",
    "properties": { "seed": { "type": "string", "optional": false } },
    "query": {
        "order": [
            { "sql": "kb_rand(${properties.seed}, images.id)", "order": "asc" },   // 模板值是绑定参数
            { "sql": "images.id", "order": "asc" }
        ]
    },
    ...
}
```

---

## 点 1 — 宿主函数 `kb_palette_distance`（`storage/dsl_funcs.rs`）

- **新增**
  - `register_kb_palette_distance`，登记进 `register_dsl_functions`（写连接、读池、CLI 的只读连接都经这个入口，自动带上）。

```rust
/// `kb_palette_distance(palette, hex)` → INTEGER
/// palette：`images.palette` 的 JSON 文本；hex：六位十六进制（不带前缀）。
/// 返回 `distance_to` 的结果 0..=65535；palette 为 NULL 或解析不了时返回 65536。
/// hex 不合法时报错（路由的正则已保证合法，报错只会出现在手写 SQL 里）。
fn register_kb_palette_distance(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "kb_palette_distance",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            // 返回值用 i64::from(..) 包 distance_to_lab 与 NO_PALETTE_DISTANCE，不写字面量
            // 第二个参数整条查询里不变：用 auxdata 缓存解析并换算好的参考色（Oklab），不逐行重算
            // 第一个参数用 get_raw：NULL 直接返回 65536，不能用 ctx.get::<String>（遇 NULL 报错）
            ...
        },
    )
}
```

  > 为了让缓存的参考色能直接用，`media::palette` 把 `distance_to` 拆出一个吃 `Oklab` 的内层 `distance_to_lab(palette, bucket: Oklab)`，`distance_to(palette, rgb)` 调它。两处算的是同一段代码。
  > 约束照旧：宿主函数不访问数据库连接（`dsl_funcs.rs` 文件头的说明），这个函数只做纯计算。

- **修改**
  - `cocs/provider-dsl/RULES.md` §11.1 的「当前注册」清单加这一条。

## 点 2 — 现算排序 provider（新文件 `sort/gallery_sort_by_color_computed_provider.json5`）

- **新增**

```json5
{
    "namespace": "kabegame",
    "name": "gallery_sort_by_color_computed_provider",
    "properties": {
        "hex": { "type": "string", "optional": false }
    },
    "query": {
        "order": [
            { "sql": "kb_palette_distance(images.palette, ${properties.hex})", "order": "asc" },
            { "sql": "images.id", "order": "asc" }
        ]
    },
    "note": "Sort by distance to an arbitrary color, computed per row at query time (same cost class as random-<seed>): .../sort/by-any-color_0x3a7bd5/_kb_x100x/1. Works for any 6-digit lowercase hex color; images without a palette come last. For colors listed in color_buckets:// prefer sort/by-color_0x<rrggbb>, which is precomputed and much faster on large libraries. Append /_kb_desc for farthest first."
}
```

  > 排序路由里对应的 resolve 条目见 [03-pathql.md](03-pathql.md) 点 2。它只贡献排序，不连表，所以可以和任何过滤组合，也不受「每图每桶一行」不变量的影响。

## 点 3 — 测试

- **新增**（`dsl_funcs.rs` 单测）
  - `kb_palette_distance` 对一份已知色盘返回与 `distance_to` 相同的值；`palette` 为 NULL、空串、坏 JSON 时返回 65536；hex 不是六位十六进制时报错。
- **新增**（`providers` e2e）
  - `gallery_sort_by_arbitrary_color_orders_by_distance`：三张色盘已知的图，`sort/by-any-color_0x3a7bd5` 的顺序等于按 `distance_to` 手算的顺序；没有色盘的图在最后；总数不变。
  - `gallery_sort_computed_matches_precomputed`：对一个色桶颜色，`sort/by-any-color_0xff0000` 与 `sort/by-color_0xff0000` 排出的 id 序列完全相同（含并列组与没有色盘的图）。
    > 这条同时防两件事：两条路算法漂移；回填或入库写错了关系行。前端在两个段之间切换（色桶被删、颜色被存成色桶）时画面不跳，靠的也是这一条。
  - `gallery_sort_by_any_color_rejects_bad_hex`：`by-any-color_0xFF0000`（大写）、五位、七位都不解析。
  - `gallery_rank_locates_image_under_computed_color_sort`：`~~/rank/~~/id_<id>` 的序号与分页一致。
- **实测**（P3，prod 构建、真实库）
  - 记下任意颜色排序第 1 页与深页的耗时，对比随机排序与色桶排序，写进 `versions/latest/regression.md` 与 `cocs/gallery/COLOR_PALETTE.md`。若明显慢于随机排序，先看参考色缓存是否生效，再考虑把 `palette` 列换成更省解析的紧凑文本（列的格式只有 `Palette::to_json` / `from_json` 与前端 `parsePalette` 三处认识）。
