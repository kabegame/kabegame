# 03 PathQL：按颜色排序与色桶列表

## 总体设计思路

查询侧加三样东西。一是画廊列表字段多一个 `palette`（点 0）。二是画廊排序路由下的两个参数化排序段，写法与 `random-<seed>` 平行，各是 `gallery_sort_router` 的 `resolve` 里的一条正则：`by-color_0x<rrggbb>` 交给色桶 provider（预计算，本文档），`by-any-color_0x<rrggbb>` 交给现算 provider（[04-arbitrary-color.md](04-arbitrary-color.md)）。两个段互不知道对方，用哪个由调用方决定；路由不做「这个颜色是不是色桶」的判断。

色桶段的 `gallery_sort_by_color_provider` 贡献一条 INNER JOIN（关系表里该色桶的那一片）与两项排序（`distance`、`image_id`）。因为每张图对每个色桶恒有一行，INNER JOIN 不丢行；排序键与索引 `(bucket_rgb, distance, image_id)` 完全一致，规划器由关系表驱动、沿索引读到一页就停。路径里的十六进制是绑定参数（字符串），用一个不相关的标量子查询在 `color_buckets` 里换成 rgb 整数，不需要宿主函数；色桶不存在时子查询为 NULL，连接为空，结果是空集而不是报错——`by-color_0x…` 只对色桶有意义，对不是色桶的颜色调用方应当用 `by-any-color_0x…`。

三是一个新 scheme `color_buckets://`，把色桶表按显示顺序读出来，给前端的色桶面板当数据源，也是前端判断「用哪个排序段」的依据。它只有一个根 provider。不在排序路由里做动态 list：色桶集合不随上文过滤变化，前端也不是靠列举排序段来拿色桶的；MCP 侧在排序路由的 `note` 里写明格式并指向 `color_buckets://`。

画廊的行分页形态 `filter/…/sort/by-color_0x…/_kb_x100x/1/~~/rank/~~p/lookup/gallery` 不用改（现算段同理）：排序 provider 的 JOIN 与排序都在内层，内层照旧只投影 `images.id`，中层打序号，外层回表。`~~/rank/~~/id_<id>` 的定位、轮播按当前壁纸定起点同理直接可用。

## 现状锚点

**a. 排序路由**（`providers/dsl/images/gallery/sort/gallery_sort_router.json5`）

```json5
{
    "namespace": "kabegame",
    "name": "gallery_sort_router",
    "note": "Sort keys: by-id | by-time | by-size | by-name | by-aspect | by-set-time | by-album-order | random-<seed>. ...",
    "query": {
        "delegate": { "provider": "kb_co_provider" }      // 现状：进排序段先清空上游排序
    },
    "list": {
        "by-id": { "provider": "gallery_sort_by_id_provider" },
        ...
    },
    "resolve": {
        "random-([0-9]{1,18})": {                          // 现状：唯一的参数化排序段
            "provider": "gallery_sort_by_random_provider",
            "properties": { "seed": "${capture[1]}" }
        }
    }
}
```

**b. 排序 provider 的形态**（`gallery_sort_by_random_provider.json5`）

```json5
{
    "namespace": "kabegame",
    "name": "gallery_sort_by_random_provider",
    "properties": { "seed": { "type": "string", "optional": false } },
    "query": {
        "order": [
            { "sql": "kb_rand(${properties.seed}, images.id)", "order": "asc" },
            { "sql": "images.id", "order": "asc" }         // 现状：各排序以 images.id 收尾保证全序
        ]
    },
    ...
}
```

**c. schema 登记**（`providers/init.rs:90`）

```rust
.register_schema("images", "images", "kabegame", "images_root_provider")
.register_schema("albums", "albums", "kabegame", "albums_root_provider")
.register_schema("tasks", "tasks", "kabegame", "tasks_root_provider")
...
```

---

## 点 0 — 列表字段加 `palette`（`gallery_route.json5`、`image_basic_provider.json5`）

- **修改**
  - 画廊列表字段（`gallery_route` 现有 21 个）末尾加一项；裸 id 预览用的 `image_basic_provider` 同样加，否则从深链接打开的预览没有色块。

```json5
            {
                "sql": "images.palette",      // 新增：色盘 JSON 文本，没有为 NULL
                "as": "palette",
                "in_need": true
            }
```

  > 值是文本，不在 SQL 里拆；前端解析（[05-frontend.md](05-frontend.md) 点 8）。它只在外层回表时取（`lookup/gallery` → `gallery_route`），内层窄查询仍只有 `id`，不影响排序与分页的开销。
  > 虚拟盘的字段表（`vd_root_router`）不加。改完跑 `deno task pathql:generate`。

## 点 1 — 排序 provider（新文件 `sort/gallery_sort_by_color_provider.json5`）

- **新增**

```json5
{
    "namespace": "kabegame",
    "name": "gallery_sort_by_color_provider",
    "properties": {
        "hex": { "type": "string", "optional": false }      // 六位小写十六进制，不带 0x
    },
    "query": {
        "join": [{
            "kind": "INNER",
            "table": "image_color_distances",
            "as": "cd",
            // 标量子查询不相关，只算一次；色桶不存在 → NULL → 空集
            "on": "cd.image_id = images.id AND cd.bucket_rgb = (SELECT b.rgb FROM color_buckets AS b WHERE printf('%06x', b.rgb) = ${properties.hex})"
        }],
        "order": [
            { "sql": "cd.distance", "order": "asc" },
            // 收尾用 cd.image_id 而不是 images.id：值相同（连接条件），但这样排序键逐列等于索引列，
            // 规划器不必推等价关系就能省掉排序
            { "sql": "cd.image_id", "order": "asc" }
        ]
    },
    "note": "Sort by precomputed distance to a color bucket: .../sort/by-color_0xff0000/_kb_x100x/1. Closest first; images without a palette come last. Only colors listed in color_buckets:// work here (rgb as 6 lowercase hex digits); any other color yields an empty result - use sort/by-any-color_0x<rrggbb> for those. Append /_kb_desc for farthest first."
}
```

  > `join.table` 的字面表名要过引擎白名单（`pathql-rs/src/validate/config.rs` 的校验配置）：把 `image_color_distances` 加进宿主登记的表名单，位置在现有 `album_images` 的登记处旁边。`color_buckets` 只出现在子查询里，不需要。
  > `on` 里的 `${properties.hex}` 走绑定参数（RULES §7.1）。现有 provider 的模板都在 `where` / `order.sql` / `list.sql` 里，`join.on` 带属性模板没有先例，P3 第一步先用一条 e2e 确认能渲染；若不支持，把色桶条件挪到 `where`（`cd.bucket_rgb = (…)`），语义与执行计划相同。

## 点 2 — 排序路由加两条 resolve（`gallery_sort_router.json5`）

- **修改**

```json5
    "note": "Sort keys: by-id | by-time | by-size | by-name | by-aspect | by-set-time | by-album-order | random-<seed> | by-color_0x<rrggbb> | by-any-color_0x<rrggbb>. ... by-color_0x<rrggbb> sorts by precomputed distance to a color bucket (only colors in color_buckets://); by-any-color_0x<rrggbb> computes the distance to any color at query time (slower).",   // 修改：补一句
    ...
    "resolve": {
        "random-([0-9]{1,18})": { ... },
        "by-color_0x([0-9a-f]{6})": {                       // 新增：色桶，预计算；只认小写
            "provider": "gallery_sort_by_color_provider",
            "properties": { "hex": "${capture[1]}" }
        },
        "by-any-color_0x([0-9a-f]{6})": {                   // 新增：任意颜色，现算（provider 见 04）
            "provider": "gallery_sort_by_color_computed_provider",
            "properties": { "hex": "${capture[1]}" }
        }
    }
```

  > 两条正则的前缀不同（`by-color_0x` / `by-any-color_0x`），不会互相吞；实现时确认 resolve 的正则是整段匹配（`random-([0-9]{1,18})` 现在就依赖这一点）。

## 点 3 — `color_buckets://`（新目录 `providers/dsl/color_buckets/`）

- **新增**
  - `color_buckets_root_provider.json5`：

```json5
{
    "namespace": "kabegame",
    "name": "color_buckets_root_provider",
    "note": "Color buckets with precomputed distances, used by images://…/sort/by-color_0x<rrggbb>. Rows: rgb (integer 0xRRGGBB), key (built-in name such as red; null for buckets saved by the user), position. For a color that is not listed here use sort/by-any-color_0x<rrggbb>.",
    "query": {
        "order": [
            { "sql": "color_buckets.position", "order": "asc" },
            { "sql": "color_buckets.rgb", "order": "asc" }
        ]
    }
}
```

- **修改**
  - `providers/init.rs`：`.register_schema("color_buckets", "color_buckets", "kabegame", "color_buckets_root_provider")`。
  - 跑 `deno task pathql:generate` 重新生成 TS 客户端（`pql.colorBuckets`）。

## 点 4 — 测试（`providers` 的 e2e，与现有 `dsl_e2e.rs` 同处）

- **新增**
  - `gallery_sort_by_color_orders_by_distance`：三张图、已知距离，`filter/sort/by-color_0xff0000` 的顺序正确；`_kb_desc` 反过来；距离并列时按 id。
  - `gallery_sort_by_color_keeps_all_rows`：有一张没有色盘（65536）的图，排在最后且总数不变。
  - `gallery_sort_by_color_unknown_bucket_is_empty`：`by-color_0x123456`（不是色桶）能解析、结果为空；同一个颜色的 `by-any-color_0x123456` 返回全部行。
  - `gallery_sort_by_color_plan_uses_bucket_index`：`ANALYZE` 之后对行分页的内层 SQL 取 `EXPLAIN QUERY PLAN`，断言用到 `idx_image_color_distances_bucket` 且没有 `USE TEMP B-TREE FOR ORDER BY`；再叠一个媒体类型过滤（`_kb_fc/media-type/image`）断言同样成立。
    > 这条是这套设计成立的前提，和 v036、v049 的执行计划测试一样固化下来。
  - `gallery_rank_locates_image_under_color_sort`：`…/sort/by-color_0x…/~~/rank/~~/id_<id>` 给出的序号与分页查询一致（含并列组）。
  - `color_buckets_root_lists_in_position_order`。
  - `gallery_rows_carry_palette`：画廊行分页与裸 id 预览读出的行带 `palette`，有色盘的是 JSON 文本、没有的是 null。

## 已知的边界

- **大写十六进制不解析**（`by-color_0xFF0000` → path not found，现算段同样）。前端只产小写；MCP 的 note 写明。
- **`by-color_0x…` 对不是色桶的颜色返回空集**，不会自动退到现算。这是有意的：两条路代价差一个量级，由调用方显式选。前端在色桶列表变化时校正自己的排序段（[05-frontend.md](05-frontend.md) 点 6）；经 MCP / CLI 手写路径的调用方看 note。
- **排序与 `by-album-order` 一样依赖内层 JOIN 别名**，外层不重放排序段（RULES §2.1 已覆盖这种情况）。
- **深页**：`OFFSET` 仍要沿索引走过前面的行，与其它走索引的排序相同。
- **过滤很窄时**（如某个只有几十张图的画册 + 按颜色排序）规划器可能改由 `images` 驱动、按主键查关系行再排序，这时有一次小排序，是对的选择；执行计划测试只固定「无过滤」与「低选择性过滤」两种。
