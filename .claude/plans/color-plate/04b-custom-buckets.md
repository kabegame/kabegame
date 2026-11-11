# 04b 自定义色桶：把颜色保存成色桶

## 总体设计思路

用户觉得某个颜色常用，可以把它保存成色桶：之后按它排序走关系表、不用现算。色桶的写操作只有两个——保存一个颜色、删除一个自己存的颜色——都是共享命令层里的普通命令（core `commands/color_bucket.rs`），Tauri 与 Web JSON-RPC 各登记一个薄入口，不加 CLI / IPC 变体（没有使用场景）。读不走命令，前端观察 `color_buckets://`（[03-pathql.md](03-pathql.md)）。

保存色桶要维持「每张图对每个色桶恒有一行」，所以色桶行与它对全库图片的距离在**同一个事务**里写。距离用一条 `INSERT … SELECT kb_palette_distance(palette, ?)` 补齐——就是现算排序用的那个宿主函数（[04-arbitrary-color.md](04-arbitrary-color.md)），所以存表的距离与现算的距离逐行相同，没有色盘的图得到 65536。事务期间持有写连接的锁，入库等写操作排队等它结束；读连接（WAL）不受影响。6.5 万张图约 0.2 秒，100 万张约 5 秒——这是一个少见的用户操作，直接让命令等到提交再返回，不引入作业、进度与取消。

删色桶是色桶行加它的关系行一起删（显式删除，外键级联兜底）。基本色桶（`key` 非空）不能删。

写入提交后发一个事件 `color-buckets-change { seq }`，不带内容：色桶表很小，观察方收到就重读整张表。

**只有这两个命令会改色桶表。** 把视图存成收藏视图、设成轮播路径都只是存路径，不调这里的任何东西。

色桶被删后，仍指着它的 `by-color_0x…` 路径还能解析，但连接为空、结果是空集。前端的处理是在色桶列表变化时把自己正在看的排序换成 `by-any-color_0x…`（同一个颜色、同样的顺序，只是变成现算，见 [05-frontend.md](05-frontend.md) 点 6）；收藏视图里存着旧路径的，应用时经同一段校正。后端唯一持有路径的地方是轮播设置：它若正按被删的色桶排序，下一次切换时 `count == 0`，按现有规则本轮跳过、不关闭轮播，删色桶命令不去改设置——用户在设置页会看到轮播来源是空的，重新选一次即可。

## 现状锚点

**a. 共享命令与两个入口**

```rust
// kabegame-core/src/commands/image.rs —— 业务实现
pub async fn get_image_native_metadata(image_id: String) -> Result<Value, String> { ... }

// kabegame/src/commands/image.rs:49 —— Tauri 薄入口
pub async fn get_image_native_metadata(image_id: String) -> Result<Value, String> {
    commands::image::get_image_native_metadata(image_id).await
}

// kabegame/src/lib.rs:653 —— generate_handler! 登记（主窗口免 ACL，只需登记）
            get_image_native_metadata,

// kabegame/src/web/dispatch.rs:353 —— Web JSON-RPC 注册表
        "get_image_native_metadata",
        ...
                    kabegame_core::commands::image::get_image_native_metadata(args.image_id)
```

**b. 事件定义**（`ipc/events.rs`）

```rust
pub enum AppEventKind {
    ...
    AlbumsAdded,
    AlbumsDeleted,
    AutoConfigChange,
    ...
}
// as_str / from_str 两张对照表各一行："albums-added" ⇄ AppEventKind::AlbumsAdded
...
pub enum AppEvent {
    /// 新建画册完整行。
    AlbumsAdded {
        seq: u64,
        albums: Vec<Album>,
    },
    ...
}
// 文件尾的 AppEvent → AppEventKind 映射同样逐个列出
```

**c. 发事件**（`emitter.rs:435`）

```rust
pub fn emit_albums_added(&self, albums: &[crate::storage::Album]) {
    if !albums.is_empty() {
        dispatch_view_event(Arc::new(AppEvent::AlbumsAdded {
            seq: next_change_seq(),
            albums: albums.to_vec(),
        }));
    }
}
```

---

## 点 1 — 存储层（新文件 `storage/color_buckets.rs`）

- **新增**

```rust
/// 用户保存的色桶的上限。每个色桶在关系表里每张图占一行。
pub const MAX_CUSTOM_COLOR_BUCKETS: usize = 24;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorBucket {
    pub rgb: u32,
    /// 基本色桶的名称键；用户保存的为 None。
    pub key: Option<String>,
    pub position: i64,
}

impl Storage {
    /// 把一个颜色保存成色桶，并在同一个事务里写它对全部图片的距离。
    /// 错误码：`color-bucket:invalid`（rgb > 0xffffff）、`color-bucket:exists`、`color-bucket:limit`。
    pub fn add_color_bucket(&self, rgb: u32) -> Result<ColorBucket, String> {
        // 锁 self.db → BEGIN IMMEDIATE
        // 1. 校验：范围、是否已存在、用户色桶数量（key IS NULL 的行数）
        // 2. INSERT INTO color_buckets (rgb, key, position, created_at)
        //    VALUES (?1, NULL, (SELECT COALESCE(MAX(position), -1) + 1 FROM color_buckets), ?now)
        // 3. INSERT INTO image_color_distances (image_id, bucket_rgb, distance)
        //    SELECT id, ?1, kb_palette_distance(palette, ?hex) FROM images ORDER BY id
        //    （写连接上已登记宿主函数；按 id 升序，二级索引上是同一片内追加）
        // 4. COMMIT
    }

    /// 删一个用户保存的色桶及其关系行。基本色桶返回 `color-bucket:builtin`，不存在返回 `color-bucket:not-found`。
    pub fn delete_color_bucket(&self, rgb: u32) -> Result<(), String> {
        // 同一个事务：
        // DELETE FROM image_color_distances WHERE bucket_rgb = ?1;   -- 显式删除，外键只是兜底
        // DELETE FROM color_buckets WHERE rgb = ?1 AND key IS NULL;
    }
}
```

## 点 2 — 事件（`ipc/events.rs`、`emitter.rs`）

- **新增**
  - `AppEventKind::ColorBucketsChange` ⇄ `"color-buckets-change"`（`as_str`、`from_str`、文件尾的映射各补一行）。
  - `AppEvent::ColorBucketsChange { seq: u64 }`。
  - `GlobalEmitter::emit_color_buckets_change()`，照 `emit_albums_added` 走 `dispatch_view_event`。

```rust
/// 色桶表有增删；不带内容，观察方重读 color_buckets://。
ColorBucketsChange {
    seq: u64,
},
```

  > 这个事件只有主窗口监听（主窗口免 ACL）；畅游、爬虫、网页壁纸的 `allow-listen` 作用域不加它。

## 点 3 — 命令（新文件 `kabegame-core/src/commands/color_bucket.rs`）

- **新增**

```rust
/// 把颜色保存成色桶。全库距离补算在阻塞线程里做，提交后发事件。
pub async fn add_color_bucket(rgb: u32) -> Result<ColorBucket, String> {
    let bucket = tokio::task::spawn_blocking(move || Storage::global().add_color_bucket(rgb))
        .await
        .map_err(|e| format!("add_color_bucket join error: {e}"))??;
    GlobalEmitter::global().emit_color_buckets_change();
    Ok(bucket)
}

pub async fn delete_color_bucket(rgb: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || Storage::global().delete_color_bucket(rgb))
        .await
        .map_err(|e| format!("delete_color_bucket join error: {e}"))??;
    GlobalEmitter::global().emit_color_buckets_change();
    Ok(())
}
```

- **修改**
  - `kabegame/src/commands/`：加两个 `#[tauri::command]` 薄入口，登记进 `lib.rs` 的 `generate_handler!`。
  - `kabegame/src/web/dispatch.rs`：登记同名两个方法（归到现有图库写命令所在的权限档，实现时对照 `add_images_to_album` 一类写命令的登记方式）。

## 点 4 — 测试（`storage/color_buckets.rs` 的单测）

- **新增**
  - 保存色桶后每张图恰好多一行；有色盘的图距离等于 `distance_to`，没有色盘的图是 65536。
  - 重复的 rgb、超过上限、`rgb > 0xffffff` 各自的错误码；失败时色桶表与关系表都不变（事务回滚）。
  - 删用户色桶：关系行清空、色桶行消失；删基本色桶被拒且不动数据。
  - 保存色桶之后入库的新图对新色桶也有一行（`add_image` 现读色桶列表）。
  - e2e：一个颜色保存成色桶前后，`sort/by-any-color_0x<hex>` 与保存后的 `sort/by-color_0x<hex>` 排出的 id 序列相同；删除后 `sort/by-color_0x<hex>` 为空、`by-any-color` 不变。
