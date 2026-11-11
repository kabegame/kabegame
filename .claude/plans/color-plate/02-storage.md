# 02 存储：色桶、关系表、距离、入库与回填

## 总体设计思路

数据库多一列两表：`images.palette`（色盘 JSON，NULL 表示没有）、`color_buckets`（色桶，主键是 rgb）、`image_color_distances`（图片 × 色桶 → 距离）。全部由迁移 v052 建出；全新安装走 `create_all_tables`，两处共用同一段 DDL 与同一份基本色桶种子。

关系表的不变量是「每张图对每个色桶恒有一行」。v052 在建表后同步给全部存量图铺一行 65536（先按主键顺序批量插入、再建二级索引，6.5 万张约 1 秒）；之后由回填作业 `image_palette` 在后台分批算色盘、把 65536 改写成真实距离。色盘同时是图片的一个展示字段（详情的「基本信息」要画色块），所以它进 `ImageInfo`：`palette: Option<String>`，值就是列里的 JSON 文本，和列表查询读出来的形态一致。新图由 `Storage::add_image` 负责：它从 `image.palette` 取色盘，在同一个事务里写图片行（含 `palette` 列）与它对当前全部色桶的距离，所以 `images-added` 发出时关系行一定已经在了，事件里的行也带着色盘。`add_image` 的签名不变；`ImageInfo` 的构造处都是逐字段写的结构体字面量，三个生产入口（下载后处理、WPE 入库、文件夹同步）不填 `palette` 就编译不过，不会漏。

距离是 `media::palette` 里的纯函数 `distance_to(色盘, 色桶 rgb)`：色盘各颜色到色桶颜色的色差按占比加权平均，线性映射到 0–65535；没有色盘时是 65536。入库与回填直接调它；现算排序（[04-arbitrary-color.md](04-arbitrary-color.md)）与保存色桶（[04b-custom-buckets.md](04b-custom-buckets.md)）经宿主 SQL 函数 `kb_palette_distance` 调它。

删图时关系行与成员行一样处理：显式 `DELETE` 加外键 `ON DELETE CASCADE` 兜底。

## 现状锚点

**a. 迁移登记**（`storage/migrations/mod.rs:91` 与表尾）

```rust
struct Migration {
    version: u32,
    name: &'static str,
    up: MigrationFn,
    /// 执行本迁移前，`introduced_at ≤ 该值` 的全部回填必须已完成（见模块文档）。
    min_backfill_version: Option<u32>,
}
...
    Migration {
        version: 51,                      // 现状：最后一个迁移
        name: "wpe_dir_hash",
        up: v051_wpe_dir_hash::up,
        min_backfill_version: None,
    },
];

pub const LATEST_VERSION: u32 = 51;
```

**b. 回填注册表**（`storage/migrations/backfill.rs:188`）

```rust
const BACKFILLS: &[Backfill] = &[super::backfills::wpe_dir_hash::JOB];   // 现状：只有一个作业
```

**c. 写图片行**（`storage/images.rs:972`）

```rust
// 现状：只收 ImageInfo；一条 INSERT，不开事务，没有色盘与距离。
pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
    let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

    image.media_type = Some(crate::media::image_type::normalize_stored_media_type(
        image.media_type.take(),
    ));
    ...
    conn.execute(
        "INSERT INTO images (url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id, thumbnail_path, hash, type, width, height, display_name, size, compatible_path, post_url)
         VALUES (?1, ?2, ?3, (SELECT id FROM tasks WHERE id = ?4), ?5, ?6, (SELECT id FROM metadata WHERE id = ?7), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![...],
    )
```

**c2. `ImageInfo`**（`storage/images.rs:15`）

```rust
// 现状：没有色盘字段。序列化成 camelCase 发给前端，也能从 snake_case 的查询行反序列化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ImageInfo {
    #[serde(deserialize_with = "deserialize_stringish")]
    pub id: String,
    pub url: Option<String>,
    ...
}
```

**d. 三个生产入口**

```rust
// crawler/downloader/mod.rs:1620 —— 下载 / 本地导入后处理；此前已生成缩略图与兼容副本
let inserted = match Storage::global().add_image(image_info) {
    Ok(mut inserted) => {
        drop(occupied.take());
        ...
        inserted.image_metadata_id = persist_native_metadata_best_effort(&inserted, bytes).await;
        GlobalEmitter::global().emit_images_added(std::slice::from_ref(&inserted));

// crawler/wpe_import.rs:472 —— WPE 壁纸目录入库（insert_wpe_row）
let inserted = match storage.add_image(image) {

// local_folder/import.rs:120 —— 文件夹同步
let storage = Storage::global();
let inserted = storage.add_image(image)?;
```

**e. 删图**（`storage/images.rs:1149` 与 `:1260`，两处形态相同）

```rust
tx.execute("DELETE FROM images WHERE id = ?1", params![id])
    .map_err(|e| format!("Failed to delete image: {}", e))?;
...
// 现状：成员行显式删除，外键只是兜底（v046）
let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
```

---

## 点 1 — 距离算法（`media/palette.rs`）

- **新增**
  - `distance_to`、`NO_PALETTE_DISTANCE`。

```rust
/// 没有色盘的图到任何色桶的距离。有色盘的图取 0..=65535，这个值比最大值大 1，
/// 所以类型是 u32（放不进 u16）、列是 INTEGER。
pub const NO_PALETTE_DISTANCE: u32 = 65536;
/// 映射到 65535 的色差。`color_diff` 在 sRGB 色域内的最大值约 0.62（纯绿对品红）。
const DISTANCE_FULL_SCALE: f32 = 0.65;

/// 色盘到参考色的距离，0..=65535，越小越接近；没有色盘为 65536。
pub fn distance_to(palette: Option<&Palette>, bucket_rgb: u32) -> u32 {
    let Some(palette) = palette else { return NO_PALETTE_DISTANCE };
    let bucket = srgb_to_oklab(bucket_rgb);
    let total: f32 = palette.0.iter().map(|c| c.percent as f32).sum();
    let mean = palette.0.iter()
        .map(|c| c.percent as f32 * color_diff(srgb_to_oklab(c.rgb), bucket))
        .sum::<f32>() / total;
    ((mean / DISTANCE_FULL_SCALE) * 65535.0).round().clamp(0.0, 65535.0) as u32
}
```

算例（`LIGHTNESS_WEIGHT = 0.5`；参考色可以是任何颜色，不限于色桶）：

| 色盘 | 参考色 | 加权平均色差 | 距离 |
|---|---|---|---|
| 红 100% | 红 `ff0000` | 0 | 0 |
| 红 30%、白 70% | 红 `ff0000` | 0.7 × 0.318 = 0.222 | 22430 |
| 红 30%、白 70% | 白 `ffffff` | 0.3 × 0.318 = 0.095 | 9613 |
| 深绿 `5a7d4a` 100% | 纯绿 `00ff00` | 0.263 | 26525 |
| 白 100% | 纯绿 `00ff00` | 0.302 | 30478 |

（最后两行是明度折半的依据：不折半时白 0.324、深绿 0.380，白色图反而排在深绿色图前面。）

**为什么是 0–65535 而不是 0–255**：真实图片的距离集中在满量程中间的一小段，按 0–255 存时 3.5 万张图在每个色桶里只有一百多个不同的值，最大的并列组上千张，连续十几页只按 id 排；按 0–65535 存有一万多个不同的值，最大并列组约 17 张（剩下的是色盘完全相同的图）。代价是关系表每行在表与索引里各多约 1 字节。

## 点 2 — 迁移 v052（新文件 `storage/migrations/v052_image_palette.rs`）

- **新增**
  - `COLOR_TABLES_DDL` 与 `BUILTIN_COLOR_BUCKETS`（放 `migrations/mod.rs`，与 `BACKFILL_JOBS_DDL` 同样由迁移和 `create_all_tables` 共用）。
  - `up`：加列 → 建表 → 种子 → 铺 65536 → 建索引。各步幂等（列存在则跳过、`IF NOT EXISTS`、`INSERT OR IGNORE`）。

```rust
// migrations/mod.rs
pub(crate) const COLOR_TABLES_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS color_buckets (
    rgb        INTEGER PRIMARY KEY,          -- 0xRRGGBB
    key        TEXT UNIQUE,                  -- 基本色桶的名称键（red…）；用户保存的色桶为 NULL
    position   INTEGER NOT NULL,             -- 显示顺序
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS image_color_distances (
    image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    bucket_rgb INTEGER NOT NULL REFERENCES color_buckets(rgb) ON DELETE CASCADE,
    distance   INTEGER NOT NULL,             -- 0..=65535；65536 = 没有色盘
    PRIMARY KEY (image_id, bucket_rgb)
) WITHOUT ROWID;
"#;

/// 排序用的索引：按色桶取一片，片内 (distance, image_id) 即排序键。迁移里放在铺行之后建。
pub(crate) const COLOR_DISTANCE_INDEX_DDL: &str =
    "CREATE INDEX IF NOT EXISTS idx_image_color_distances_bucket
        ON image_color_distances(bucket_rgb, distance, image_id);";

pub(crate) const BUILTIN_COLOR_BUCKETS: [(&str, u32); 12] = [
    // 黄、绿、青不取纯色：纯色和白一样亮，白图会排到这三个桶的前列（见 README「已定事项」）
    ("red", 0xff0000), ("orange", 0xff8000), ("yellow", 0xe6c200), ("green", 0x2e9e3f),
    ("cyan", 0x1fb5b5), ("blue", 0x0000ff), ("purple", 0x8000ff), ("pink", 0xff80c0),
    ("brown", 0x804000), ("black", 0x000000), ("white", 0xffffff), ("gray", 0x808080),
];
```

```rust
// v052_image_palette.rs
pub fn up(conn: &Connection) -> Result<(), String> {
    // 1. images.palette（pragma_table_xinfo 判断是否已存在，同 v036）
    //    ALTER TABLE images ADD COLUMN palette TEXT;
    // 2. COLOR_TABLES_DDL
    // 3. 种子：INSERT OR IGNORE INTO color_buckets (rgb, key, position) —— position 取数组下标
    // 4. 存量图铺满 65536。按主键顺序插入（WITHOUT ROWID 表顺序追加最快），此时还没有二级索引：
    //    INSERT OR IGNORE INTO image_color_distances (image_id, bucket_rgb, distance)
    //    SELECT i.id, b.rgb, 65536 FROM images AS i CROSS JOIN color_buckets AS b
    //     ORDER BY i.id, b.rgb;
    // 5. COLOR_DISTANCE_INDEX_DDL
}
```

- **修改**
  - `MIGRATIONS` 追加 `Migration { version: 52, name: "image_palette", up: v052_image_palette::up, min_backfill_version: None }`，`LATEST_VERSION = 52`。
  - `init::create_all_tables`：`images` 建表语句加 `palette TEXT`，末尾执行 `COLOR_TABLES_DDL`、`COLOR_DISTANCE_INDEX_DDL` 与同一份种子（全新安装没有存量图，不铺行、不登记回填）。

## 点 3 — `ImageInfo.palette` 与 `add_image`（`storage/images.rs`）

- **修改**
  - `ImageInfo` 加字段 `palette`；`add_image` 签名不变，INSERT 多写 `palette` 列，包进事务并写距离行。
    > 色桶列表在事务里现读，与保存色桶的事务互斥（同一把 `self.db` 锁），不会出现「色桶刚存、这张图漏一行」。
    > 字段带 `#[serde(default)]`：存储层里那些自己拼 SELECT 组装 `ImageInfo` 的查询（按路径 / 哈希查找等）不必都加这一列，读不到就是 `None`。要给前端的行都来自 PathQL 列表字段（[03-pathql.md](03-pathql.md) 点 0）或 `add_image` 的返回值，两条路都带色盘。

```rust
pub struct ImageInfo {
    ...
    /// 色盘：`[[rgb, 百分比], …]` 的 JSON 文本（列里的原样）；没有色盘为 None。
    #[serde(default)]
    pub palette: Option<String>,                                 // 新增
}

pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
    let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let tx = conn.unchecked_transaction().map_err(...)?;        // 新增：图片行与距离行同一个事务
    ...
    // 新增：只认能解析的色盘，写回规范形态；解析不了的当作没有
    let palette = image.palette.as_deref().and_then(Palette::from_json);
    image.palette = palette.as_ref().map(Palette::to_json);
    tx.execute(
        "INSERT INTO images (url, local_path, …, post_url, palette)        -- 修改：多一列
         VALUES (?1, …, ?16, ?17)",
        params![..., image.palette],
    )?;
    let id = tx.last_insert_rowid();
    write_color_distances(&tx, id, palette.as_ref())?;           // 新增
    tx.commit()?;
    ...
}

/// 写（或重写）一张图对全部色桶的距离。入库与回填共用。
pub(crate) fn write_color_distances(
    conn: &Connection,
    image_id: i64,
    palette: Option<&Palette>,
) -> Result<(), String> {
    // SELECT rgb FROM color_buckets
    // 逐个：INSERT OR REPLACE INTO image_color_distances (image_id, bucket_rgb, distance)
    //       VALUES (?1, ?2, distance_to(palette, rgb))
}
```

- 测试里构造 `ImageInfo` 的地方（`local_folder/tests.rs`、`wpe_import.rs`、`image_events.rs`、`kabegame/src/http_server.rs` 等）一律补 `palette: None`。

## 点 4 — 三个入口算色盘

- **新增**
  - `media::palette::compute_for_row(...) -> Option<Palette>`（async）：`source_for_row` + `spawn_blocking(compute)`，任务异常记日志并返回 `None`。三处都调它。

- **修改**
  - **下载后处理**（`crawler/downloader/mod.rs`，`add_image` 之前、缩略图与兼容副本都已定下之后）：

```rust
// 新增：尽力而为，失败不阻断入库
let palette = crate::media::palette::compute_for_row(
    &inferred_mime, &local_path, &thumbnail_path_str, compatible_path_str.as_deref(), None,
).await;

let image_info = ImageInfo {
    ...
    post_url: post_url.map(|s| s.to_string()),
    palette: palette.as_ref().map(Palette::to_json),            // 新增
};
let inserted = match Storage::global().add_image(image_info) {   // 不变
```

  - **WPE 入库**（`crawler/wpe_import.rs` 的 `insert_wpe_row`）：视频传 `compatible_path`；网页 / 场景传 `scheme_color_from_raw(&project.raw)`，没有时 `source_for_row` 自己落到预览图。
  - **文件夹同步**（`local_folder/import.rs`）：与下载后处理同样调用（这条路径的 WPE 子目录走的是 `ingest_wpe_dir`，不在这里）。

  > 下载后处理里缩略图是刚编码出来的 JPEG，这里又解一次（约 3 ms）。想省掉可以让 `generate_thumbnail` 顺手把解码后的图交出来，但那要改它的返回值与四个调用方，这一版不做。

## 点 5 — 删图清关系行（`storage/images.rs` 两处）

- **修改**
  - 在两处 `DELETE FROM album_images WHERE image_id = ?1` 旁各加一行：

```rust
let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
let _ = tx.execute("DELETE FROM image_color_distances WHERE image_id = ?1", params![id]);   // 新增
```

  > 其它整批删图片行的地方（实现时 `grep "DELETE FROM images"` 过一遍：整理、清理隐藏画册、按任务删等）由外键级联清掉；写连接开着 `PRAGMA foreign_keys = ON`（`storage/mod.rs:59`）。迁移单测里验证级联生效。

## 点 6 — 回填作业 `image_palette`（新文件 `storage/migrations/backfills/image_palette.rs`）

- **新增**
  - 作业定义与 `run_batch`，登记进 `BACKFILLS`（`backfill.rs:188`）。结构照搬 `wpe_dir_hash`：取一批候选 → 不持连接读盘计算 → `ctx.commit` 写回。

```rust
pub(crate) const JOB: Backfill = Backfill {
    id: "image_palette",
    introduced_at: 52,
    platforms: || true,          // 图片用 image crate，视频用 FFmpeg（除 iOS 外都有）
    batch_size: 32,              // 一批约 0.2–0.5 秒，批间释放写锁
    count_remaining,             // SELECT COUNT(*) FROM images
    run_batch,
};

fn run_batch(ctx: &BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String> {
    // 1. with_conn：SELECT id, type, local_path, thumbnail_path, compatible_path, metadata_id
    //               FROM images WHERE id > ?cursor ORDER BY id LIMIT ?limit
    //    x-wpe/web、x-wpe/scene 的行另读 metadata.data（project.json 原文）取 schemecolor；
    //    没编 wpe feature 的平台不读，直接走预览图
    // 2. 不持连接：逐行 source_for_row → compute（文件缺失、解码失败 → None）
    // 3. ctx.commit：逐行
    //      UPDATE images SET palette = ?1 WHERE id = ?2 AND local_path = ?3
    //      改到行了才 write_color_distances(conn, id, palette)
    //    （带 local_path：读盘期间行被删或改指时不写，同 wpe_dir_hash）
    // 4. patches：算出色盘且改到行的图各一条 { id, palette: <JSON 文本> }；没算出来的不发
    //    （后台阶段由 BackfillService 经 emit_image_patches 推给前端，阻塞阶段丢弃）
}
```

  > 补丁让已打开的详情补上色块，也让按颜色排序的视图知道顺序变了（前端依赖表见 [05-frontend.md](05-frontend.md) 点 7）。一批最多 32 条，合成一个 `images-change`。

  > 回填只读写 v052 引入的列与表，符合「回填只碰引入时就存在的列」。批内顺序计算即可；6.5 万张图（缩略图解码约 5 ms / 张）约 6–10 分钟后台跑完，期间忙碌卡片照常显示进度。之后若嫌慢，批内用 `std::thread::scope` 按核数分片，不改作业接口。
  > 这次回填没算出色盘的行（文件不在、格式解不了）保持 NULL、距离保持 65536，不重试；以后文件回来了也不会自动补。需要时再给「整理」加一个重算选项，这一版不做。
