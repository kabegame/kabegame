# 壁纸色盘与按颜色排序

每张壁纸在入库时算一份**色盘**（palette）：最多 5 个代表色，各带面积占比。色盘做两件事：
在图片详情的「基本信息」里画成一条色带；作为「按颜色排序」的依据。按颜色排序有两条路：
常用颜色（**色桶**）的距离预先存表、排序走索引；其它任意颜色在查询时现算。

1. 色盘只在入库时算一次（存量图由回填作业补一次），之后不随缩略图、封面、用户属性的变化重算。
2. 关系表不变量：**每张图对每个色桶恒有一行**。没有色盘的图距离是 65536，排在最后而不是消失。
3. 两条排序路用同一个距离函数，对同一个颜色给出同一个顺序；**用哪一条由调用方选**，后端不替它判断。
4. 基本色桶的 rgb 发版后不宜再改：改它等于换色桶，要迁移重算这些色桶的全部关系行。

设计依据与分期记录见 `.claude/plans/color-plate/`（个别细节实现时改了，以本文与代码为准）。

## 色盘是什么

类型在 `kabegame_core::media::palette`：`Palette(Vec<PaletteColor>)`，非空、按占比降序；
`PaletteColor { rgb: u32 /* 0xRRGGBB */, percent: u8 /* 1..=100 */ }`。

存储与传输都是同一份 JSON 文本 `[[rgb, 百分比], …]`，例如 `[[16711680,62],[16777215,33]]`：

- 数据库列 `images.palette TEXT`，`NULL` = 没有色盘；
- `ImageInfo.palette: Option<String>`（`#[serde(default)]`），事件与列表行里是 `palette` 字段；
- 认识这个格式的只有三处：`Palette::to_json` / `Palette::from_json` 与前端 `utils/palette.ts` 的 `parsePalette`。
  `from_json` 对格式不对、空数组、rgb 超出 24 位、百分比不在 1..=100 的输入返回 `None`（整份作废）。

百分比按**全部**聚合点的总权重算、四舍五入、至少为 1，被截掉的尾部不再分摊，所以各项之和不一定是 100。
色盘不是原图的精确颜色，只是「这张图大体是什么颜色」。

## 提取：四步

入口 `palette_from_frames`（多帧）/ 内部 `palette_from_cells`：`select_top(remerge(merge_cells(cells)))`。
每步一个函数，各有单测（`media/palette/tests.rs`）。

| 步骤 | 函数 | 做什么 |
|---|---|---|
| 1 采样 | `sample_cells` | 一帧切成 16×16 个区域，每个区域在线性光下按 alpha 加权取平均，转成 OKLab；平均 alpha 低于 0.1 的区域丢弃 |
| 2 聚合 | `merge_cells` | 取全部区域色的包围盒中心；按到中心的色差升序扫，遇到还没被取走的点就以它为种子，收走合并半径内的全部点，聚合点的颜色取这些成员的加权平均 |
| 3 再并 | `remerge` | 反复把平均色相距最近、且不到合并半径的两个聚合点按权重并成一个，直到没有这样的一对 |
| 4 选取 | `select_top` | 按占比降序（并列按 rgb 升序），累计超过 95% 或取满 5 个即停，转回 sRGB 整数与百分比 |

多帧来源（视频、GIF）把各帧的区域色合在一起（8 帧至多 2048 个点），聚合一次、再并一次、选取一次。
全程确定：排序的并列按输入下标，同一输入两次结果相同。

各步的理由：

- **采样不另外缩图**。区域平均直接在拿到的尺寸上做，与「先盒式缩到 512×512 再每 32×32 平均」等价；图不到 512
  时也不放大。图片本来就从缩略图算（独立缩略图最长边 512；不超过 512 KB 的小文件直接拿原图当缩略图，尺寸可能更大，
  照样按区域平均），视频抽帧时把帧等比缩到最长边 512 以内。
- **不用 k-means**。k-means 要先定 k，纯色图也会被硬拆成 5 个几乎相同的颜色。这里个数由画面决定：色差低的画面
  只收成一两个聚合点，纯色图得到 1 个颜色 100%。
- **中心取包围盒中心**（OKLab 各通道最小值与最大值的中点），整个过程不变，所以聚合等价于「按到中心的距离排一次序，
  顺序扫一遍」。不取最小包围球的球心：聚合只用到「离中心多远」这个顺序，两种中心排出来几乎一样，包围盒中心一遍扫描
  就能得到。
- **种子只用来圈定成员，代表色是成员的平均**。种子是这团颜色里离中心最近的点、偏在色团朝向中心的一侧，直接拿它当颜色
  会让代表色朝整张图的平均色偏；取平均就落回色团中间。
- **再并一遍**。只做第 2 步时，比合并半径宽的色团会被拆成几个平均色几乎一样的聚合点（蓝天出 3–5 个蓝），占掉色盘的
  名额、把小面积的点缀色挤掉。数据见下文「调参对比」。并是连锁的，所以并完之后一个代表色可能盖住比两倍半径更宽的
  一段颜色——这是「淡色粉彩图只剩 1 色」的来源，见「已知的局限」。
- **聚合、再并与距离用同一把尺**（`color_diff`，明度差折半）：「多近算同一个颜色」和「离色桶多远」是一回事。

## 各类型从哪里算

`source_for_row(media_type, local_path, thumbnail_path, compatible_path, scheme_color)` 是「什么类型从哪里算」的
唯一一处，只看类型与路径文本、不读盘；入库的三个入口与回填作业都经 `compute_for_row`（`source_for_row` +
在阻塞线程里 `compute`）。

| 类型 | 来源（`PaletteSource`） |
|---|---|
| `image/gif` | `Animated`：原文件抽帧（缩略图只有第一帧）；没有原文件路径时退到缩略图 |
| 其它图片 | `Still`：缩略图；缩略图为空时用原图 |
| `video/*` | `Video`：原视频均匀抽帧（预览只有前 2.5 秒）；解不了时退到预览文件 |
| `x-wpe/video` | `Video`：`compatible_path`（入口视频或兼容副本）抽帧，退到预览图；没有 `compatible_path` 时直接用预览图 |
| `x-wpe/web`、`x-wpe/scene` | `Fixed`：`project.json` 的 `schemecolor`（一个颜色 100%）；没有则预览图（`thumbnail_path`，GIF 抽帧）；再没有则没有色盘 |

- **静态图**：`image` crate 解码，解不了的（HEIC 等）退到 `decode_image_via_ffmpeg`，顺序与缩略图生成一致。
  动画 WebP / APNG 按静态图处理（取第一帧）。
- **GIF**（`sample_gif_cells`）：帧数事先不知道，边解边按步长留帧，留满 16 帧就丢一半、步长翻倍，最后从留下的里
  均匀取 8 帧；最多解 240 帧。留的是每帧的区域色而不是整帧画面，内存与帧的尺寸无关。类型写的是 GIF、内容不是时
  按静态图再试一次。
- **视频**（`media::decode::sample_video_frames`）：第 i 个时间点在时长的 `(i + 0.5) / 8` 处，seek 到它之前最近的
  关键帧、解出第一帧；只解关键帧附近的一帧，不逐帧解码。seek 或解码失败的点跳过，相邻的点落在同一帧上时只留一份；
  时长未知或所有点都没解出来时，只返回从头解出的第一帧。预览文件按扩展名当视频、GIF 或静态图（Android 的视频预览
  是 GIF）。
- **WPE 网页 / 场景**：`wpe::properties::scheme_color_from_raw` 取 `general.properties.schemecolor.value`
  （`"r g b"`，0–1 浮点）——**作者值**，不跟用户在属性面板里改的值走（用户值在 metadata 顶层的 `userProperties`）。
  `wpe::properties` 不随 `wpe` feature 门控，回填在所有构建里对同一行算出同一个色盘。
- **Android**：原文件是 `content://` 时，`compute_for_row` 先经 `ContentIoProvider.open_fd` 换成 `/proc/self/fd/N`
  再读，fd 在阻塞任务里持有到解码结束；拿不到 fd 时视频由 `compute` 自己退到预览文件，图片改读缩略图文件。
  **这条分支未经交叉编译验证。**

任何一步失败（文件读不了、解码失败、全透明）都返回 `None` 并 `debug!` 记原因，由存储层记成「没有色盘」，不阻断入库。

## 常量

全部在 `media/palette.rs` 文件头。

| 常量 | 值 | 含义与依据 |
|---|---|---|
| `SAMPLE_SIZE` | 512 | 视频抽帧的画面缩到最长边不超过它（4K 视频 8 帧的原尺寸 RGB 约 200 MB）；与独立缩略图的最长边（`IMAGE_THUMBNAIL_MAX_DIM`）同值。图片不再另外缩 |
| `GRID` | 16 | 每边 16 个区域，共 256 个采样；512 的图上每格 32×32 像素 |
| `MERGE_RADIUS` | 0.06 | 合并半径（`color_diff` 的单位），聚合与再并共用。调参时维持原值，见「调参对比」 |
| `MAX_COLORS` | 5 | 色盘最多几个颜色 |
| `COVERAGE` | 0.95 | 累计占比超过它就不再取 |
| `FRAME_SAMPLES` | 8 | 视频 / GIF 抽几帧 |
| `MIN_CELL_ALPHA` | 0.1 | 区域的平均 alpha 低于它时不参与（透明底上的图标只算图标的颜色） |
| `LIGHTNESS_WEIGHT` | 0.5 | 色差里明度差的权重。不折半时白色图比深绿色图更「接近」纯绿，见下节算例 |
| `DISTANCE_FULL_SCALE` | 0.65 | 映射到 65535 的色差。`color_diff` 在 sRGB 色域内的最大值约 0.62（纯绿对品红） |
| `NO_PALETTE_DISTANCE` | 65536 | 没有色盘的图到任何颜色的距离 |
| `GIF_MAX_DECODED_FRAMES` | 240 | GIF 最多解多少帧 |

## 距离

```text
color_diff(x, y)       = sqrt( (0.5·ΔL)² + Δa² + Δb² )                    OKLab，明度差折半
distance_to(色盘, 参考色) = round( Σ(占比ᵢ · color_diff(颜色ᵢ, 参考色)) / Σ占比ᵢ / 0.65 · 65535 )，夹到 0..=65535
没有色盘                 = 65536
```

语义是**加权平均色差**（不是覆盖度）：色盘各颜色到参考色的色差按占比加权平均，越小越接近。参考色可以是任何
颜色，不限于色桶。`distance_to(palette, rgb)` 只是把 rgb 换成 OKLab 再调 `distance_to_lab`；宿主 SQL 函数缓存
换算好的参考色后直接调后者，两处是同一段代码。

算例（单测 `distance_to` 的用例，允许 ±1）：

| 色盘 | 参考色 | 加权平均色差 | 距离 |
|---|---|---|---|
| 红 100% | 红 `ff0000` | 0 | 0 |
| 红 30%、白 70% | 红 `ff0000` | 0.7 × 0.318 = 0.222 | 22430 |
| 红 30%、白 70% | 白 `ffffff` | 0.3 × 0.318 = 0.095 | 9613 |
| 深绿 `5a7d4a` 100% | 纯绿 `00ff00` | 0.263 | 26525 |
| 白 100% | 纯绿 `00ff00` | 0.302 | 30478 |

最后两行是明度折半的依据：不折半时白 0.324、深绿 0.380，白色图反而排在深绿色图前面（纯绿的明度有 0.87，和白很近）。
做法参照 CMC 2:1 / CIE94 纺织，让色相与彩度占主导。

**量程为什么是 0–65535 而不是 0–255**：真实图片的距离集中在满量程中间的一小段。按 0–255 存时，约 3.5 万张图在每个
色桶里只有一百多个不同的值，最大的并列组上千张，连续十几页只按 id 排；按 0–65535 存有一万多个不同的值，最大并列组
17–20 张（剩下的是色盘完全相同的图）。数据见「调参对比」。

**65536 的含义**：有色盘的图取 0..=65535，65536 比最大值大 1，专门留给「没有色盘」，所以这些图在任何颜色下都排在
最后（`_kb_desc` 时排在最前）。它放不进 `u16`，所以 Rust 侧是 `u32`、列是 `INTEGER`。迁移里铺行的 SQL 写的是字面量
65536，有单测核对它等于 `NO_PALETTE_DISTANCE`。

## 存储：色桶表与关系表

DDL 在 `storage/migrations/mod.rs`（`COLOR_TABLES_DDL`、`COLOR_DISTANCE_INDEX_DDL`），迁移 v052 与全新安装的
`init::create_all_tables` 共用同一段 DDL 与同一份种子 `seed_builtin_color_buckets`。

```sql
CREATE TABLE color_buckets (
    rgb        INTEGER PRIMARY KEY,          -- 0xRRGGBB
    key        TEXT UNIQUE,                  -- 基本色桶的名称键（red…）；用户保存的色桶为 NULL
    position   INTEGER NOT NULL,             -- 显示顺序
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE image_color_distances (
    image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    bucket_rgb INTEGER NOT NULL REFERENCES color_buckets(rgb) ON DELETE CASCADE,
    distance   INTEGER NOT NULL,             -- 0..=65535；65536 = 没有色盘
    PRIMARY KEY (image_id, bucket_rgb)
) WITHOUT ROWID;
CREATE INDEX idx_image_color_distances_bucket ON image_color_distances(bucket_rgb, distance, image_id);
```

- **色桶主键直接用 rgb**，不另设自增 id：路径里的 `0x<rrggbb>`、关系表的 `bucket_rgb`、前端的色块是同一个值。
- **基本色桶 12 个**（`BUILTIN_COLOR_BUCKETS`，数组下标即 `position`）：红 `ff0000`、橙 `ff8000`、黄 `e6c200`、
  绿 `2e9e3f`、青 `1fb5b5`、蓝 `0000ff`、紫 `8000ff`、粉 `ff80c0`、棕 `804000`、黑 `000000`、白 `ffffff`、灰 `808080`。
  黄、绿、青不取纯色，理由与数据见「调参对比」。`key` 非空的行不能删。
- **用户保存的色桶**：`key` 为 NULL，最多 24 个（`MAX_CUSTOM_COLOR_BUCKETS`，前端 `services/colorBuckets.ts` 有一份
  同值常量，只用来提前置灰按钮），没有名字，界面上显示色块与 `#rrggbb`。上限的原因是每个色桶在关系表里每张图占一行。
- **空间**：每张图每个色桶一行。计划阶段按编码规则估算 12 个色桶时每张图约 260 字节，未实测。

### 不变量：每张图对每个色桶恒有一行

按色桶排序是 INNER JOIN 关系表（见下节），靠这条不变量才不丢行、不改总数；预览定位（`~~/rank`）、轮播按当前壁纸
定起点这些建立在「排序不丢行」之上的机制因此不用特判。它由三处写入维持：

| 写入 | 位置 | 做法 |
|---|---|---|
| 存量图 | 迁移 `v052_image_palette::up` | 建表、种子之后 `INSERT OR IGNORE … SELECT i.id, b.rgb, 65536 FROM images i CROSS JOIN color_buckets b ORDER BY i.id, b.rgb`，全部铺成 65536 |
| 新图 | `Storage::add_image` | 同一个事务里写图片行（含 `palette` 列）与 `write_color_distances`（现读色桶列表，逐个 `INSERT OR REPLACE`） |
| 新色桶 | `storage::color_buckets::add_color_bucket_in` | 同一个 `BEGIN IMMEDIATE` 事务里写色桶行与 `INSERT INTO image_color_distances SELECT id, ?, kb_palette_distance(palette, ?) FROM images ORDER BY id` |

后两处靠写连接的同一把锁（`Storage.db`）互斥，且各自在事务里现读对方的表，所以不会出现「色桶刚存、这张图漏一行」
或反过来。`write_color_distances` 的调用方必须保证它与图片行（或 `palette` 列）的写入在同一个事务里；回填作业在
`ctx.commit` 的事务里调用它。

`add_image` 的签名没有因此变化：色盘由调用方算好放进 `ImageInfo.palette`。`ImageInfo` 的构造处都是逐字段写的结构体
字面量，新的入库入口不填 `palette` 编译不过；但**填 `None` 能编译**，那样新图永远没有色盘（回填作业只在升级时跑一次）。
所以新增入库入口必须调 `compute_for_row`。`add_image` 只认能解析的色盘并写回规范形态，解析不了的当作没有。
生产代码里写图片行的只有 `add_image` 这一处，调用它的入口是三个：下载后处理（`crawler/downloader/mod.rs`）、
WPE 入库（`crawler/wpe_import.rs`）、文件夹同步（`local_folder/import.rs`）。

### 删图与删色桶

- 删图：`storage/images.rs` 的两个删除入口在删成员行的同一处显式
  `DELETE FROM image_color_distances WHERE image_id = ?`，外键 `ON DELETE CASCADE` 只是兜底（写连接开着
  `PRAGMA foreign_keys = ON`）。
- 删色桶（`delete_color_bucket_in`）：同一个事务里先显式删这个色桶的全部关系行（走
  `idx_image_color_distances_bucket` 取它的一片），再删色桶行。基本色桶返回 `color-bucket:builtin`，不存在返回
  `color-bucket:not-found`。

## 迁移与回填

- **v052**（`storage/migrations/v052_image_palette.rs`）：一个 `IMMEDIATE` 事务里依次加列 `images.palette`、建两表、
  写基本色桶、给存量图铺 65536、建排序索引。索引放在铺行之后建：`WITHOUT ROWID` 表按主键顺序追加最快，此时还没有
  二级索引。各步幂等（列存在则跳过、`IF NOT EXISTS`、`INSERT OR IGNORE`），重跑不会覆盖已经算出来的距离。
  `min_backfill_version` 为 `None`。全新安装没有存量图：不铺行，也不登记回填。
- **回填作业 `image_palette`**（`backfills/image_palette.rs`，`introduced_at: 52`，每批 32 行，`platforms: || true`）：
  只处理 `palette IS NULL` 的行（候选 `id > 游标 AND palette IS NULL`，v052 之后入库的图已经带着色盘）。取一批候选
  （网页 / 场景壁纸另读 metadata 里的 `project.json` 原文取 `schemecolor`）→ 不持有连接逐行 `compute_for_row` →
  `ctx.commit` 里逐行 `UPDATE images SET palette = ? WHERE id = ? AND local_path = ?`（读盘期间行被删或改指别处时
  不写），改到行了才 `write_color_distances`，并带一条 `{ id, palette }` 字段补丁。
- 算不出色盘的行（文件不在、格式解不了）保持 `NULL`、距离保持 65536，**不重试**；以后文件回来了也不会自动补。
- 回填期间：没算到的图排在最后、基本信息里没有色带；每批的补丁经 `BackfillService` → `emit_image_patches` 合成
  `images-change`，前端按字段依赖表处理（见「前端」）。忙碌卡片的副标题是 i18n `header.backfill.image_palette`
  （「计算壁纸的代表色」）。

框架本身（游标、崩溃续跑、CLI 不跑后台阶段）见 [../storage/DB_MIGRATIONS_AND_BACKFILLS.md](../storage/DB_MIGRATIONS_AND_BACKFILLS.md)。

## 查询：两个排序段

两个段都是 `gallery_sort_router` 的 `resolve` 里的正则，写法与 `random-<seed>` 平行。只认 `0x` + 六位**小写**
十六进制，大写、位数不对的段不解析（path not found）。`_kb_desc` 照常翻转（最远的在前）。

| | `sort/by-color_0x<rrggbb>` | `sort/by-any-color_0x<rrggbb>` |
|---|---|---|
| provider | `gallery_sort_by_color_provider` | `gallery_sort_by_color_computed_provider` |
| 适用 | 只认色桶（`color_buckets://` 里的颜色） | 任何颜色（含恰好是色桶的颜色，结果一样、只是慢） |
| SQL 形态 | `INNER JOIN image_color_distances AS cd ON cd.image_id = images.id AND cd.bucket_rgb = (SELECT b.rgb FROM color_buckets AS b WHERE printf('0x%06x', b.rgb) = ?)`，`ORDER BY cd.distance, cd.image_id` | `ORDER BY kb_palette_distance(images.palette, ?), images.id`，不连表 |
| 代价 | 由关系表驱动、沿 `idx_image_color_distances_bucket` 读到一页就停，不排序 | 对全部候选行求值再整体排序，和 `random-<seed>` 同一类 |
| 不是色桶的颜色 | 标量子查询为 NULL → 连接为空 → **空集**（不报错，也不会自动退到现算） | 照常 |
| 没有色盘的图 | 关系行是 65536，排在最后 | 函数返回 65536，排在最后 |
| 持久状态 | 色桶行 + 每张图一行距离 | 无 |

几条实现细节：

- 色桶段的排序以 `cd.image_id` 收尾而不是 `images.id`：值相同（连接条件），但这样排序键逐列等于索引列，规划器不必
  推等价关系就能省掉排序。色桶条件写在 `on` 里，标量子查询不相关、整条查询只算一次。
- 色桶段的 JOIN 与排序都在画廊行分页的内层（`filter/…/sort/by-color_0x…/_kb_x100x/1/~~/rank/~~p/lookup/gallery`），
  外层不重放排序段，所以和 `by-album-order` 一样可以引用内层 JOIN 别名（[../provider-dsl/RULES.md](../provider-dsl/RULES.md) §2.1）。
- 执行计划有 e2e 固定（`tests/dsl_e2e.rs` 的 `gallery_sort_by_color_plan_uses_bucket_index`、
  `gallery_sort_by_color_plan_under_hide_uses_bucket_index`，4000 张图、已 `ANALYZE`）：无过滤、叠 `media-type/image`、
  带 `hide/` 前缀与 `_kb_desc` 时都用到 `idx_image_color_distances_bucket` 且没有临时排序。这是「预计算存表」成立的
  前提，改 provider 或索引后要重跑。过滤很窄时（某个只有几十张图的画册）规划器可能改由 `images` 驱动再做一次小排序，
  测试没有固定这种情况。
- 宿主函数 `kb_palette_distance(palette, hex)`（`storage/dsl_funcs.rs`）是 `distance_to_lab` 的 SQL 外壳：`palette`
  为 NULL、不是文本或解析不了时返回 65536；`hex` 是六位十六进制文本，可带 `0x` 前缀，不合法时报错；参考色用
  auxdata 缓存，不逐行重算；`SQLITE_DETERMINISTIC`，不访问数据库连接。入库、回填写进关系表的距离是同一段代码，
  所以两个段同序——e2e 里逐项比对过 id 序列（含并列组与没有色盘的图），前端在两个段之间切换时画面不跳靠的也是这一条。

### 「用哪个段由调用方选」

`by-color_0x…` 只认色桶，`by-any-color_0x…` 认任何颜色；路由与两个 provider 互不知道对方，后端不判断某个颜色该走
哪条路。原因是两条路的代价差很多，由调用方显式选；两个 provider 也因此各自很简单。

- 前端在一个函数里判断：`colorSortFor(hex, bucketHexes, desc)`——颜色在色桶列表里给 `by-color`，否则给
  `by-any-color`；色桶列表变化时再校正一次（见「前端」）。
- MCP / CLI 手写路径的调用方看排序路由与两个 provider 的 `note`，先读 `color_buckets://`。
- **收藏视图、轮播路径存的都是路径文本**：按现算颜色排序的视图存下来还是 `by-any-color_0x…`，不会替用户生成色桶。
  只有 `add_color_bucket` / `delete_color_bucket` 两个命令会改色桶表。

### 属性名是 `color`、值带 `0x`：模板属性会被数字化

两个 provider 的属性叫 `color`，值是路径段里 `by-color_` / `by-any-color_` 之后的原样（`0xff0000`），正则的捕获组
带着 `0x`。计划里原来是属性 `hex`、值不带前缀，实现时改了：引擎在求值 `ProviderCall.properties` 时会把**看起来像
数字**的模板结果转成数字（`pathql-rs` 的 `eval_properties_in_ctx`：先试 `i64`，再试 `f64`，都不行才是文本）。

| 裸十六进制 | 被转成 | 后果 |
|---|---|---|
| `000000`（黑） | 整数 0 | 色桶段里 `printf(...) = ?` 是文本比整数，不相等 → 空集；现算段里宿主函数拿到非文本参数 → 报错 |
| `804000`（棕）、`808080`（灰）、`123456` | 整数（前导零丢失的同理） | 同上 |
| `1e1000`、`123e45` | 浮点 | 同上 |

带 `0x` 前缀的串不会被当成数字。e2e `color_sort_segments_bind_numeric_looking_hex_as_text` 固定了这一点。通用的
规避写法见 [../provider-dsl/RULES.md](../provider-dsl/RULES.md) §6.5。

### 性能

2026-11，dev 库 5475 张图、**未优化构建**下实测一页的耗时：

| 排序 | 一页 |
|---|---|
| 色桶（`by-color`） | 1–2 毫秒 |
| 现算（`by-any-color`） | 11–12 毫秒 |
| 随机（`random-<seed>`，对照） | 1–2 毫秒 |

真实大库 + 正式构建的数字还没有。现算段随候选行数线性增长（每行解析一小段 JSON、做至多 5 次 OKLab 换算，再整体
排序），图库很大时会慢是设计上接受的：任意颜色是偶尔点一下的操作，常用的颜色存成色桶。

### `color_buckets://`

新 scheme，只有一个根 provider `color_buckets_root_provider`（`providers/init.rs` 登记）：整张表按
`position, rgb` 升序读出，行字段 `rgb`（整数）、`key`、`position`。它是前端色桶面板的数据源，也是「用哪个排序段」
的依据。生成的 TS 客户端键是 `pql.color_buckets`。

MCP 读它时每行多一个派生字段 `hex`（六位小写十六进制，`mcp_server.rs` 的 `color_bucket_rows_to_value`），调用方不必
自己把整数换算成排序段要的写法；前端读到的行没有这个字段，自己从 `rgb` 转。读能力是 `color_buckets.read.list`，
没有写工具，见 [../mcp/MCP_SERVER.md](../mcp/MCP_SERVER.md)。

## 列表字段 `palette`

`gallery_route` 的列表字段末尾加了 `images.palette AS palette`（现在共 22 个字段），裸 id 预览与原始行用的
`image_basic_provider` 同样加了（它的列必须是 `gallery_route` 字段的子集）。值是文本，不在 SQL 里拆。它只在外层
回表时取，内层窄查询仍只有 `id`，不影响排序与分页的开销。虚拟盘的字段表不加。

不另开按 id 读色盘的请求：基本信息面板的数据本来就全部来自列表行。存储层里那些自己拼 SELECT 组装 `ImageInfo` 的
查询（按路径 / 哈希查找等）没有都加这一列，读不到就是 `None`；给前端的行来自 PathQL 列表字段或 `add_image` 的返回值，
两条路都带色盘。

## 保存 / 删除色桶

共享命令在 core `commands/color_bucket.rs`，Tauri（`kabegame/src/commands/color_bucket.rs`，登记进
`generate_handler!`，主窗口免 ACL）与 Web JSON-RPC（`web/dispatch.rs`，两个方法都 `requires_super: true`）各一个
薄入口；没有 CLI / IPC 变体。读不走命令。

| 命令 | 参数 | 返回 | 错误码（错误文本以它开头） |
|---|---|---|---|
| `add_color_bucket` | `rgb: u32` | `ColorBucket { rgb, key, position }` | `color-bucket:invalid`（rgb > 0xffffff）、`color-bucket:exists`（含基本色桶）、`color-bucket:limit` |
| `delete_color_bucket` | `rgb: u32` | 无 | `color-bucket:builtin`、`color-bucket:not-found` |

- 保存是一个同步事务：色桶行与全库距离一起提交，命令在阻塞线程里等到提交才返回，不引入作业、进度与取消。事务期间
  持有写连接的锁，入库等写操作排队等它结束；读连接（WAL）不受影响。耗时与行数写一条 `info!` 日志。失败时两张表都
  不变。
- 提交后发 `color-buckets-change { seq }`（`AppEvent::ColorBucketsChange`，默认订阅的事件），不带内容：色桶表很小，
  观察方收到就重读整张表。
- 色桶被删后，仍指着它的 `by-color_0x…` 路径还能解析，但结果是空集。前端把自己正在看的排序换成现算段；后端唯一
  持有路径的地方是轮播设置，见「已知的局限」。

## 前端

### 排序类型与选段

`utils/galleryPath.ts`：`GallerySortField` 多了 `"by-color"` 与 `"by-any-color"`，`GallerySort` 多了
`color?: string`（六位小写十六进制，**不带前缀**；`0x` 只在路径段里出现）。字段值与路径段一一对应：
构造 `sort/${field}_0x${color}`，解析 `/^(by-color|by-any-color)_0x([0-9a-f]{6})$/`；不带颜色的裸段、颜色写法不对
都回落默认排序。

- `isColorSortField(field)`：两个字段在界面上是同一个维度「颜色」，标签、图标相同。各页的 `sortFeatures` 里只列
  `"by-color"` 一项（画廊、画册、任务详情、畅游图片四处），它同时代表两个字段；下拉用 `sortFieldModel` 把两个字段
  都点亮到这一行。
- `colorSortFor(hex, bucketHexes, desc)`：用色桶段还是现算段**只在这里判断**。

### 色桶列表与校正（`GalleryQueryBar.vue`）

`useColorBuckets(enabled)`（`composables/useColorBuckets.ts`）是 `color_buckets://` 的 rows 观察方，
`refreshOn: [on("color-buckets-change")]`，读取失败保留已有列表。`enabled` 为 false 时不观察、不请求（本页不开放颜色
排序、当前也不是颜色排序时不读这张表）。`loaded` 表示列表至少成功读到过一次——在此之前不能据它判断「某个颜色不是
色桶」。

校正是一个 `watch([bucketHexes, colorBucketsLoaded, sort], …, { immediate: true })`：色桶列表已读到、当前是颜色
排序时，用 `colorSortFor` 算出该用的字段，与当前不同就以 `{ push: false }` 导航过去。

| 情形 | 当前段 | 校正为 |
|---|---|---|
| 正按某个用户色桶排序，色桶被删（本页或别的页面删的） | `by-color` | `by-any-color`（否则结果是空集） |
| 正按某个现算颜色排序，用户把它保存成了色桶 | `by-any-color` | `by-color` |
| 应用收藏视图 / 打开链接，里面的段与现在的色桶列表对不上 | 任一 | 对应的另一个 |

校正只改当前页面的路径，不回写收藏视图；两个段同序，画面不跳。色桶列表还没读到时不动（过期的 `by-color` 段会先
显示空结果，列表到了再换）。「保存为色桶」后立刻选中时事件可能还没把列表刷回来，`onSortColorSelect` 会先给出现算段，
同样由这段校正换成色桶段。

### 色桶面板（`ColorBucketPanel.vue`）

排序下拉里「颜色」一行不直接选中，而是在下拉面板里就地展开色桶面板（`KbFilterDropdown` 选项的 `expandable` +
`option-panel` 插槽，见 [../ui/COMPONENT_LIBRARY.md](../ui/COMPONENT_LIBRARY.md)）。就地展开而不是侧向弹二级浮层，
是因为同一个下拉在窄屏（安卓）上是居中对话框，侧向浮层放不下。`onSortFieldCommand` 对颜色字段直接返回：颜色排序
必须带颜色，只从面板进。

面板只报「用户要按哪个颜色排序」（`emit("select", hex)`），不关心用哪个段：

- 色块依次是基本色桶、用户保存的色桶（`color_buckets://` 的顺序）、末尾一个「其它颜色」。当前排序的颜色不在色桶里
  时，「其它颜色」显示成那个颜色并带选中描边，否则是带「＋」的空块。
- 点「其它颜色」打开内嵌的 `ElColorPickerPanel`（不带透明度，初值为当前排序的颜色）。「按这个颜色排序」直接选中；
  「保存为色桶」调 `addColorBucket` 后选中，期间按钮转圈、两个按钮都禁用。取到的颜色已经是色桶、或用户色桶到上限
  时保存按钮置灰并换提示文案；后端返回 `exists`（别处刚存了）时照常选中。
- 用户保存的色块右上角有删除角标（悬停出现；紧凑布局没有悬停，常显），`ElPopconfirm` 确认后调
  `deleteColorBucket`（`not-found` 当作成功）。确认框 teleport 到 body，挂 `COLOR_BUCKET_LAYER_CLASS`，排序下拉的
  `clickOutsideIgnore` 认它，点确认框不会关掉下拉；它另接了 `useModalBack`。
- 写完不主动刷新任何 key，等 `color-buckets-change`（`services/colorBuckets.ts`）。

chip 的 tooltip 在颜色排序时是「颜色 · 红」或「颜色 · #32fe98」（`colorLabel`：基本色桶用名字，其它用 `#rrggbb`）。

### 基本信息里的色带（`ImageBasicInfoPanel.vue`）

媒体属性 chip 行下面一条按占比分段的色带：各段 `flex-grow` 取百分比、带最小宽度，段间 1px 间隔，整条一圈细边框
（白色、黑色段不会融进面板背景）；每段 `title` 带 `#rrggbb · 62%`。没有色盘时整条不渲染、不占位。

**点一段 = 当前页面按这个颜色排序。** 每段是一颗按钮，点了发 `open-color-sort(hex)`，沿 `open-gallery-filter` 的同一条链路上传到 `ImageGrid`（`ImageDetailDialog` / `ImagePreviewDialog` → `ImageGridCore` → `ImageGrid.handleOpenColorSort`）。处理方式与过滤跳转不同：

- 只换排序：`adapter.routeStore.navigate({ sort: { field: "by-any-color", desc: false, color: hex } }, { push: true })`，查询与页面上下文原样保留，**不跳画廊**（四个网格页都有颜色排序，用户是想在眼前这批图里找相近的颜色）。过滤跳转则会换掉查询，不在画廊时跳去画廊。
- 直接给现算段：色盘的颜色是聚合出的平均色，几乎不会恰好是色桶，所以网格不为此去读色桶表；万一恰好是色桶，查询行的排序段校正会把它换成预计算段。
- 导航落定后再关详情与预览，理由同过滤跳转（避免 `pvwimgid` 的写入与 push 竞争）。
- `GridRouteStore.navigate` 的补丁类型因此是 `Pick<GalleryQueryPatch, "sort">`：网格自己只做空补丁与只换排序两种导航。
面板不发请求、不观察任何 key，`parsePalette(image.palette)` 直接读图片行；预览侧栏与详情弹窗是同一个组件。

### 回填补丁与字段依赖表

`services/kbEvents/imageViewRelevance.ts` 的 `FIELD_DEPS` 登记了 `palette: (v) => isColorSortField(v.sort.field)`。
表外字段一律保守刷新——不登记的话，回填期间所有网格都会跟着每一批（32 行）刷新。登记后：

- 按颜色排序（两个字段都算）的视图按统一的 500ms 窗口刷新；
- 其它排序的视图只把补丁打到已在手的行与预览对象上（`imagePatches$`），开着的基本信息面板自己补上色带。

新图不走补丁：`images-added` 的完整行已经带着色盘，且事件发出时关系行已经提交。

## 调参对比

2026-11，生产缩略图目录 34,937 个文件（34,632 张 jpg + 305 个视频预览）。每张图只采样一次，各变体只差聚合这一步；
到色桶的距离始终用正式度量（明度折半）。对照页工具是 `media/palette/tests.rs` 里 `#[ignore]` 的 `palette_report`
（环境变量 `KABEGAME_PALETTE_REPORT_DIR` / `_OUT` / `_LIMIT`），以后调常量时重跑：

```text
KABEGAME_PALETTE_REPORT_DIR=<图片目录> KABEGAME_PALETTE_REPORT_OUT=<输出目录> \
  .claude/skills/test-kabegame/driver.sh kabegame-core --lib palette_report -- --ignored --nocapture
```

### 聚合方式

| 变体 | 聚合用的明度权重 | 合并半径 | 聚合后再并 |
|---|---|---|---|
| 基线 | 0.5 | 0.06 | 否 |
| **A（采纳）** | 0.5 | 0.06 | 反复并最近的一对，直到没有相距不到半径的对 |
| A′ | 0.5 | 0.06 | 只并一遍、不连锁 |
| B r=0.06 / 0.08 | 1.0 | 0.06 / 0.08 | 否 |
| A+B r=0.06 / 0.08 | 1.0 | 0.06 / 0.08 | 同 A |

| 变体 | 1 色 | 5 色 | 5 色累计占比中位 | 存在两个颜色相差不到 0.06 | 1 色张数 | 抽看误并比例 |
|---|---|---|---|---|---|---|
| 基线 | 0.6% | 81.7% | 86% | 86.9% | 213 | 约 20–25% |
| **A** | 3.0% | 44.3% | 95% | 1.3% | 1,045 | 约 40% |
| A′ | 3.0% | 43.5% | 94% | 11.5% | 1,052 | 同 A |
| B r=0.06 | 0.1% | 97.1% | 62% | 99.7% | 29 | 0% |
| B r=0.08 | 0.2% | 90.7% | 78% | 99.0% | 60 | 约 10% |
| A+B r=0.06 | 0.3% | 89.7% | 82% | 98.3% | 110 | 约 12–15% |
| A+B r=0.08 | 0.9% | 69.2% | 92% | 77.3% | 315 | 约 30% |

（「抽看误并比例」是对只剩 1 色的图人工抽看、其中能看出不止一种颜色的比例。）

- 全部图的累计占比均值：基线 86.1%，A 95.4%。
- A 下新变成 1 色的 832 张，在基线色盘里最远两色的色差中位数 0.053，80% 小于 0.06；彩度最大的颜色彩度中位数只有
  0.027——几乎都是淡色粉彩插画。
- 耗时：聚合每张 0.17–0.23 毫秒，解码 + 采样每张 15.5 毫秒；A 相对基线 1.00×–1.02×。
- 各色桶前 50 张的观感：所有变体与基线相同。排序对聚合方式不敏感，因为距离是加权平均。

结论：采纳 A。基线下近九成的多色色盘里有两个几乎一样的颜色，5 个颜色只盖住 86% 的画面；A 把这个比例降到 1.3%、
覆盖升到 95%，代价是只剩 1 色的图从 0.6% 增到 3%。B（聚合改用不折半的色差）把同一种颜色的明暗变化拆开，97% 的图
取满 5 色却只盖住 62% 的画面，不采纳；A+B 同理。合并半径 0.06、明度权重 0.5、满量程 0.65 维持原值。

### 黄 / 绿 / 青色桶的颜色

在 A 的色盘上比较，只影响距离。名次占比 = 排在纯白图前面的图占全库的比例，越大说明白图越靠后。

| 桶 | 候选 | 颜色 | 纯白图名次占比 | 与其它桶的最小色差 |
|---|---|---|---|---|
| 黄 | 纯色 | `ffff00` | 5.1% | 0.171 |
| 黄 | **C1（采纳）** | `e6c200` | 39.7% | 0.137 |
| 黄 | C2 | `f5d800` | 17.6% | 0.163 |
| 黄 | C3 | `d4a800` | 69.0% | 0.112 |
| 绿 | 纯色 | `00ff00` | 13.9% | 0.171 |
| 绿 | **C1（采纳）** | `2e9e3f` | 96.2% | 0.167 |
| 绿 | C2 | `33cc33` | 57.8% | 0.170 |
| 绿 | C3 | `228b22` | 99.0% | 0.170 |
| 青 | 纯色 | `00ffff` | 6.3% | 0.162 |
| 青 | **C1（采纳）** | `1fb5b5` | 83.8% | 0.126 |
| 青 | C2 | `33cccc` | 55.4% | 0.148 |
| 青 | C3 | `008b8b` | 99.5% | 0.099 |

纯色太亮太艳，图库里真正的黄绿青离它们反而远，纯白图会排到这三个桶的前 5%–14%。目测：C1 的绿桶前 30 张是草地、
森林，黄底图没有了；青是海水的蓝绿；黄是金黄，混进几张橙底图。C3 的黄变成土黄、青变成暗青灰，不像原来的颜色了。
在意黄桶像柠檬黄的话可以单独用 C2 `f5d800`，这次没有采用。

### 距离的量程

| | 不同值个数（各桶范围） | 最大并列组（各桶范围） |
|---|---|---|
| 0–255 | 101–185 | 557–1,659 张 |
| 0–65535 | 11,524–19,972 | 17–20 张 |

并列是量化造成的，不是色盘只有 ≤5 个颜色造成的。剩下的 17–20 张是色盘完全相同的图（开头黑场的视频预览）。改细后每行
在表和索引里各多约 1 字节，12 个色桶下每张图约多 24 字节（约 +9%，按编码规则估算，未实测）。

## 已知的局限

- **淡色粉彩图容易只剩 1 色**。淡色在 OKLab 里挤在一起，淡粉与淡蓝的色差可以小于合并半径，固定半径分不开；再并是
  连锁的，更容易并成一个。约 3% 的图只有 1 个颜色，抽看其中约四成能看出几种淡色。
- **紫桶 `8000ff` 的前几十张偏蓝紫**。与黄绿青是同类问题（纯色太艳），调参时没有试紫的候选色。
- **视频抽帧取不满 8 帧**。抽帧只落在关键帧上：305 个原视频里 46% 取满 8 帧、10% 只取到第一帧（关键帧稀疏或短视频，
  相邻时间点落在同一帧上只留一份）。
- **轮播路径指着被删的色桶**。删色桶命令不改轮播设置；下一次切换时 `count == 0`，按现有规则本轮跳过、不关闭轮播
  （[../wallpaper/ROTATION_PATHQL.md](../wallpaper/ROTATION_PATHQL.md)），用户在设置页重新选一次来源即可。前端页面里
  的排序有校正，轮播没有。
- **色盘不重算**。换封面（WPE「设为壁纸封面」）、整理重建缩略图、文件内容被外部改写都不会更新色盘；回填没算出来的
  行也不重试。
- **深页**：色桶段的 `OFFSET` 仍要沿索引走过前面的行，与其它走索引的排序相同。
- **大写十六进制不解析**。前端只产小写；MCP 的 note 写明。
- Android 的 `content://` 分支未经交叉编译验证；真实大库 + 正式构建的排序耗时还没有数字。

## 涉及文件

| 层 | 文件 | 作用 |
|---|---|---|
| core | `src-tauri/kabegame-core/src/media/palette.rs`、`media/palette/tests.rs` | 色盘类型、四步提取、色差与距离、来源选择、`compute` / `compute_for_row`；单测与对照页工具 `palette_report` |
| core | `src-tauri/kabegame-core/src/media/decode.rs` | `sample_video_frames` |
| core | `src-tauri/kabegame-core/src/wpe/properties.rs` | `scheme_color_from_raw` |
| core | `src-tauri/kabegame-core/src/storage/migrations/mod.rs` | `COLOR_TABLES_DDL`、`COLOR_DISTANCE_INDEX_DDL`、`BUILTIN_COLOR_BUCKETS`、`seed_builtin_color_buckets` |
| core | `src-tauri/kabegame-core/src/storage/migrations/v052_image_palette.rs`、`init.rs` | 迁移与全新建库 |
| core | `src-tauri/kabegame-core/src/storage/migrations/backfills/image_palette.rs` | 回填作业 |
| core | `src-tauri/kabegame-core/src/storage/images.rs` | `ImageInfo.palette`、`add_image`、`write_color_distances`、两个删图入口 |
| core | `src-tauri/kabegame-core/src/storage/color_buckets.rs` | 保存 / 删除色桶、错误码、上限 |
| core | `src-tauri/kabegame-core/src/storage/dsl_funcs.rs` | 宿主函数 `kb_palette_distance` |
| core | `src-tauri/kabegame-core/src/providers/dsl/images/gallery/sort/` | `gallery_sort_router`、两个颜色排序 provider |
| core | `src-tauri/kabegame-core/src/providers/dsl/images/gallery/gallery_route.json5`、`images/image_basic_provider.json5` | 列表字段 `palette` |
| core | `src-tauri/kabegame-core/src/providers/dsl/color_buckets/`、`providers/init.rs` | `color_buckets://` |
| core | `src-tauri/kabegame-core/src/commands/color_bucket.rs`、`ipc/events.rs`、`emitter.rs` | 共享命令、`color-buckets-change` |
| core | `src-tauri/kabegame-core/src/crawler/downloader/mod.rs`、`crawler/wpe_import.rs`、`local_folder/import.rs` | 三个入库入口算色盘 |
| core | `src-tauri/kabegame-core/tests/dsl_e2e.rs` | 排序顺序、两段同序、执行计划、数字化属性的 e2e |
| app | `src-tauri/kabegame/src/commands/color_bucket.rs`、`lib.rs`、`web/dispatch.rs` | Tauri / Web 入口 |
| app | `src-tauri/kabegame/src/mcp_server.rs`、`mcp_capabilities.rs` | `color_buckets://` 的 MCP 资源、`hex` 派生字段、读能力 |
| 引擎 | `src-tauri/pathql-rs/src/provider/dsl_provider.rs` | `eval_properties_in_ctx`（属性数字化） |
| 前端 | `apps/kabegame/src/utils/galleryPath.ts` | 排序字段、路径构造与解析、`isColorSortField`、`colorSortFor` |
| 前端 | `apps/kabegame/src/utils/palette.ts` | `parsePalette`、`rgbToHex`、`isLightColor` |
| 前端 | `apps/kabegame/src/services/colorBuckets.ts`、`composables/useColorBuckets.ts` | 色桶行规范化、写命令与错误码、列表观察方 |
| 前端 | `apps/kabegame/src/components/gallery/ColorBucketPanel.vue`、`colorBucketLayer.ts`、`GalleryQueryBar.vue` | 色桶面板、排序下拉接线与排序段校正 |
| 前端 | `apps/kabegame/src/components/common/ImageBasicInfoPanel.vue` | 色带 |
| 前端 | `apps/kabegame/src/services/kbEvents/imageViewRelevance.ts` | 字段依赖表的 `palette` |
| 组件库 | `packages/kabegame-element-plus/src/components/kb-filter-dropdown/` | 选项的 `expandable` 与 `option-panel` 插槽 |
| 生成 | `packages/kabegame-pathql-client/index.ts` | `pql.color_buckets`；生成物、不入库，改 DSL 后跑 `deno task pathql:generate` |
