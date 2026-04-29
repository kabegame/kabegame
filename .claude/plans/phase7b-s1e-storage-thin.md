# Phase 7b-S1e — pathql Runtime 提供 `fetch(path)` / `count(path)` 服务，core 零 SQL

## Context

[storage/gallery.rs](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs) 三个 `*_by_query` 方法当前承担多重职责：

1. 接收 `&ProviderQuery + &TemplateContext`（要求调用方手动维护 composed + ctx）
2. 拼业务 outer SQL（fav_ai/hid_ai LEFT JOIN + is_favorite/is_hidden CASE，已在 gallery_route 重复声明）
3. 拼通用 outer SQL（`SELECT COUNT(*) FROM (<inner>) sub`）
4. 自管 `conn.lock()` + `conn.prepare()` + `query_map`
5. 按列索引 `row.get(N)` 映射 ImageInfo

**根本问题**：调用方接触 `ProviderQuery` 这个抽象就有诱因绕过 path —— rotator 已经犯过一次（手搓 `ProviderQuery::new()` + `with_where_raw`）。

**正确分层**：

- **path 是唯一公开抽象** —— 调用方表达"我要哪部分数据"只有 path 一个手柄
- pathql Runtime 提供 path-based 数据服务：`fetch(path) -> Vec<JsonValue>` / `count(path) -> usize`
- 内部链路（path → resolve → composed → build_sql → executor.execute）对调用方完全不可见
- core / app-main 任何位置都不再持有 `ProviderQuery` 或 `TemplateContext`

**核心目标**：

```rust
// 唯一公开形态
impl ProviderRuntime {
    pub fn fetch(&self, path: &str) -> Result<Vec<serde_json::Value>, EngineError>;
    pub fn count(&self, path: &str) -> Result<usize, EngineError>;
}
```

storage 三个 `*_by_query` 方法**整体删除**。core 新增 path-based 公开 API：

```rust
// core/src/providers/query.rs
pub fn images_at(path: &str) -> Result<Vec<ImageInfo>, String>;  // fetch + JSON→ImageInfo
pub fn count_at(path: &str) -> Result<usize, String>;            // 直接转 count
```

**长期方向**（本期不全做）：所有 core 模块（albums / tasks / surf_records / etc.）都走 path → fetch/count → typed mapper 模式。本期落 gallery 图片查询路径 + pathql 服务设施；其他业务表后续专题迁。

## 关键设计点

**1. pathql Runtime 实现**

```rust
// pathql-rs/src/provider/runtime.rs

impl ProviderRuntime {
    /// 内部辅助: 构造含 globals 的 TemplateContext。
    fn template_context(&self) -> TemplateContext {
        let mut ctx = TemplateContext::default();
        ctx.globals = self.globals.as_ref().clone();
        ctx
    }

    pub fn fetch(&self, path: &str) -> Result<Vec<serde_json::Value>, EngineError> {
        let node = self.resolve(path)?;
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (sql, values) = node.composed
            .build_sql(&ctx, dialect)
            .map_err(|e| EngineError::FactoryFailed(
                "<runtime>".into(), "fetch".into(), e.to_string()))?;
        self.executor.execute(&sql, &values)
    }

    pub fn count(&self, path: &str) -> Result<usize, EngineError> {
        let node = self.resolve(path)?;
        let ctx = self.template_context();
        let dialect = self.executor.dialect();
        let (inner_sql, values) = node.composed
            .build_sql(&ctx, dialect)
            .map_err(|e| EngineError::FactoryFailed(
                "<runtime>".into(), "count".into(), e.to_string()))?;
        // count wrapper 是 SQL 通用 pattern (不引用业务表), 由 pathql 拼
        let sql = format!("SELECT COUNT(*) AS n FROM ({}) AS pq_sub", inner_sql);
        let rows = self.executor.execute(&sql, &values)?;
        let n = rows.first()
            .and_then(|r| r.get("n"))
            .and_then(|v| v.as_u64())
            .ok_or_else(|| EngineError::FactoryFailed(
                "<runtime>".into(), "count".into(),
                "COUNT(*) returned no row or non-integer".into()))?;
        Ok(n as usize)
    }
}
```

`fetch` 完全不写 SQL；`count` 写 1 行通用 wrapper（只引子查询别名 `pq_sub`，不引业务表）—— 关键是 SQL 拼装从 core 搬到 pathql。

**2. core 端没人持 ProviderQuery / TemplateContext**

迁移完毕后 grep 兜底：
- `grep -rn "ProviderQuery\|TemplateContext" src-tauri/core/src/storage/` → 0 条（storage 不再接触这些类型）
- `grep -rn "ProviderQuery\|TemplateContext" src-tauri/app-main/` → 0 条（app-main 也不接触）

唯一保留的位置：[providers/programmatic/](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic) —— programmatic provider 实现 `apply_query / list / resolve` trait 方法时本就是 pathql 内部抽象，必须接触 `ProviderQuery`。这部分是 pathql provider 实现层，不算 core 调用方。

**3. `PageSizeProvider` / `QueryPageProvider` / `count_for` 是死代码**

[programmatic/mod.rs:29-35](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/mod.rs#L29) 自 6c 起注释掉了两个 register 调用（注释明示"由 DSL (shared/*.json5) 接管"）—— [programmatic/shared.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/shared.rs) 中的 `PageSizeProvider` / `QueryPageProvider` struct 已无注册入口，runtime 不会构造。

[helpers.rs::count_for](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/helpers.rs#L133) 的唯一调用方是 [shared.rs:63](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/shared.rs#L63) `PageSizeProvider::list`，三件死代码连坐。

**本期一并删除**（无需迁移 / 改造）：
- `programmatic/shared.rs` 删 `PageSizeProvider` 整体（list/resolve/from_props impl + struct）
- 同文件删 `QueryPageProvider` 整体
- `programmatic/helpers.rs` 删 `count_for` 函数 + 顶部不再使用的 imports
- `programmatic/mod.rs:29-35` 删除 6c 注释掉的 register 调用代码块

清理后 storage 删除任务对内部 helper 没有牵连，count 服务唯一形态就是 path-based 的 `Runtime::count(path)`。

**4. 移除 gallery_route `limit: 0`，count 走实数**

[gallery_route.json5:11](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5#L11) 当前 `"limit": 0` 是历史"抑制根路径列图"的 hack。但它让 `count(path)` 也归零（`SELECT COUNT(*) FROM (SELECT ... LIMIT 0)` 永远 0）→ 总数失真。

**删除 `limit: 0`**。代价：

- `images_at("/gallery/")` 不再返回空 —— 走默认 SQL（无 limit）会返回**全部**图片（百万级）。**调用方责任**：不要从根路径调 `images_at`；这种 path 是用来 list 子节点的，不是用来取图片的。
- `count_at("/gallery/")` 返回真实总数 ✓
- `fetch_images_for(composed)` 在 [providers/query.rs](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) 当前判断 `composed.limit == Some(0)` 走空集 —— 该判断**删除**。如果需要保留"无 limit 时返回最后一页"启发式，按 caller 决定（IPC `execute_provider_query_typed` Listing mode 走原"无 limit → last page 100"分支，因为 frontend 期望 root 路径默认显示一页图，但这是 IPC 业务语义，不是 fetch/count 引擎语义）。

**5. `execute_provider_query_typed` 内部调用切换**

[providers/query.rs](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) 当前在 listing / entry mode 里调 `Storage::get_images_count_by_query(composed, ctx)` —— 它有 `rt_path`，直接换成 `rt.count(rt_path)`。`fetch_images_for(composed, ctx)` 改用 `images_at(rt_path)`（注意避免循环递归 —— `images_at` 内部走 `rt.fetch(path)`，不调 `execute_provider_query_typed`）。

`fetch_images_for` 保留"无 limit → 最后一页 100"启发式分支（不再 dead code 了 —— 删 limit=0 后 /gallery/ 等根路径走该分支显示最近 100 张，符合前端预期）。

```rust
pub fn images_at(path: &str) -> Result<Vec<ImageInfo>, String> {
    let rows = provider_runtime().fetch(path).map_err(|e| e.to_string())?;
    rows.iter().map(json_row_to_image_info).collect()
}
pub fn count_at(path: &str) -> Result<usize, String> {
    provider_runtime().count(path).map_err(|e| e.to_string())
}
```

`images_at` 是无脑的 fetch + 映射；`fetch_images_for`（IPC 层）保留 "last page 100" 业务启发式。两者职责分明：`images_at` 是引擎服务，`fetch_images_for` 是业务包装。

**6. fields alias 列名映射契约**

gallery_route 17 fields 的 alias 名 → ImageInfo 字段。json_row_to_image_info 按列名读：

```rust
fn json_row_to_image_info(row: &serde_json::Value) -> Result<ImageInfo, String> {
    let obj = row.as_object().ok_or("row not JSON object")?;
    let s = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(String::from);
    let i = |k: &str| obj.get(k).and_then(|v| v.as_i64());
    Ok(ImageInfo {
        id: s("id").ok_or("id missing")?,
        url: s("url"),
        local_path: s("local_path").ok_or("local_path missing")?,
        plugin_id: s("plugin_id").ok_or("plugin_id missing")?,
        task_id: s("task_id").ok_or("task_id missing")?,
        surf_record_id: None,
        crawled_at: i("crawled_at").ok_or("crawled_at missing")? as u64,
        metadata: None,
        metadata_id: i("metadata_id"),
        thumbnail_path: s("thumbnail_path").unwrap_or_default(),
        hash: s("hash"),
        favorite: i("is_favorite").unwrap_or(0) != 0,
        is_hidden: i("is_hidden").unwrap_or(0) != 0,
        local_exists: true,
        width: i("width").map(|v| v as u32),
        height: i("height").map(|v| v as u32),
        display_name: s("display_name"),
        media_type: crate::image_type::normalize_stored_media_type(s("media_type")),
        last_set_wallpaper_at: i("last_set_wallpaper_at")
            .filter(|&t| t >= 0).map(|t| t as u64),
        size: i("size").map(|v| v as u64),
    })
}
```

DSL alias 名硬契约：`id` / `url` / `local_path` / `plugin_id` / `task_id` / `crawled_at` / `metadata_id` / `thumbnail_path` / `hash` / `is_favorite` / `is_hidden` / `width` / `height` / `display_name` / `media_type` / `last_set_wallpaper_at` / `size`。当前 gallery_route 全部对得上。

**7. fs_entries 删除**

`get_images_fs_entries_by_query` 当前 outer wrapper 只投影 4 列。删该 method —— FUSE 改用 `images_at(path)` 拿 ImageInfo 投影 4 字段。多读 13 列开销 < FUSE readdir 一次的固定成本。

**8. rotator 重构（两个模式分别处理）**

S1d-b 删 storage `images.*` 兜底后，rotator 的 raw ProviderQuery 没有 fields 贡献 → 缺 fav_ai/hid_ai JOIN + is_favorite/is_hidden 列 → mapper 失败。本期一并把 rotator 切到 path-only API。

**模式 A — 随机模式（无新 provider）**

**画廊**：list `/gallery/all/x100x/` 拿所有页码 → 随机选一页 → `images_at(&format!("/gallery/all/x100x/{}", page))` 拿 100 张 → 过滤"可作壁纸的图片"（图片类型 / 文件存在等）→ 命中第一张返回。**找不到就换下一页**（在剩余页中随机抽）；**所有页都试完仍找不到 → 退出轮播**。

**画册**：相同逻辑挂在 `/gallery/album/{albumId}/x100x/` 下。如果该 album 所有页都找不到可用图片 → 回退到画廊随机模式；画廊也找不到 → 退出轮播。

```rust
// 伪代码 (rotator.rs)
fn load_random_image_for_wallpaper(source: &RotationSource) -> Result<Option<ImageInfo>, String> {
    let rt = provider_runtime();
    let base_path = match source {
        RotationSource::Album(id) => format!("/gallery/album/{}/x100x", id),
        RotationSource::Gallery => "/gallery/all/x100x".into(),
    };
    let mut pages: Vec<String> = rt.list(&base_path)?
        .into_iter().filter(|c| c.name.parse::<usize>().is_ok())
        .map(|c| c.name).collect();
    while !pages.is_empty() {
        let idx = random_index(pages.len());
        let page = pages.swap_remove(idx);  // 不重复抽
        let images = images_at(&format!("{}/{}", base_path, page))?;
        if let Some(img) = images.into_iter().find(|i| is_wallpaper_suitable(i, mode)) {
            return Ok(Some(img));
        }
    }
    // 该 source 全部页都没找到
    Ok(None)
}

// 调用方:
match load_random_image_for_wallpaper(&source)? {
    Some(img) => use_it(img),
    None => match source {
        RotationSource::Album(_) => load_random_image_for_wallpaper(&RotationSource::Gallery)? // 回退
            .ok_or_else(|| stop_rotation())?,
        RotationSource::Gallery => stop_rotation(),
    }
}
```

**模式 B — 顺序模式（需要新 provider）**

需要 path 表达"crawled_at > {time} 取 100 张"和"album_images.order > {order} 取 100 张"。

新路径约定：

| 路径 | 语义 |
|---|---|
| `/gallery/bigger_crawler_time/{time}/l100l` | WHERE `images.crawled_at > {time}` ORDER BY crawled_at ASC LIMIT 100 |
| `/gallery/album/{albumId}/bigger_order/{order}/l100l` | 在 album 下 WHERE `album_images.order > {order}` ORDER BY album_images.order ASC LIMIT 100 |

`l<N>l` 是新的限制段约定：纯 LIMIT N，无 offset、无分页（区别于 `x<N>x` 的 page_size 形态）。

**新 provider 清单（全 DSL，避免 programmatic 债）**：5 个 .json5 文件，gallery 和 album 各用 2 个 + 共享 1 个 `limit_leaf_provider`。

| DSL 文件 | 职责 |
|---|---|
| [dsl/gallery/gallery_bigger_crawler_time_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_bigger_crawler_time_router.json5) | `resolve: { "(.+)": { provider: "gallery_bigger_crawler_time_filter", properties: { time: "${capture[1]}" } } }` |
| [dsl/gallery/gallery_bigger_crawler_time_filter.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_bigger_crawler_time_filter.json5) | `properties: { time: { type: string } }`；`query: { where: "images.crawled_at > ${properties.time}", order: [{images.crawled_at: asc}] }`；`resolve: { "l([0-9]+)l": { provider: "limit_leaf_provider", properties: { limit: "${capture[1]}" } } }` |
| [dsl/gallery/album/gallery_album_bigger_order_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/album/gallery_album_bigger_order_router.json5) | `resolve: { "(.+)": { provider: "gallery_album_bigger_order_filter", properties: { order: "${capture[1]}" } } }` |
| [dsl/gallery/album/gallery_album_bigger_order_filter.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/album/gallery_album_bigger_order_filter.json5) | `properties: { order: { type: string } }`；`query: { where: "album_images.order > ${properties.order}", order: [{album_images.order: asc}] }`；`resolve: { "l([0-9]+)l": { ... } }` |
| [dsl/shared/limit_leaf_provider.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/shared/limit_leaf_provider.json5) | `properties: { limit: { type: number } }`；`query: { limit: "${properties.limit}" }`；list/resolve 不写（叶子）|

`limit_leaf_provider` 通用，3 处都用。

**挂载点**：

- `gallery_route.list` 加 `"bigger_crawler_time": { "provider": "gallery_bigger_crawler_time_router" }` —— 纯 DSL 改动
- `gallery_album_router` **当前是 programmatic**（[programmatic/gallery_albums.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_albums.rs)），要让 `bigger_order` 段挂在 `/gallery/album/{albumId}/` 下，**两选一**：
  - **(a) 改 programmatic 加一条 resolve case**：[gallery_albums.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_albums.rs) 的 `GalleryAlbumProvider::resolve` 加 `"bigger_order"` 分支调 `instantiate_named("gallery_album_bigger_order_router", ctx)`。3 行 Rust，零 programmatic 新增 provider
  - **(b) 等 Phase 7b albums 迁完 DSL 后再加挂载** —— 本期顺序模式 album 不可用
  - **推荐 (a)**：programmatic 那 3 行调用 DSL provider 是合规过渡形态；albums 完整 DSL 迁完后 ([Phase 7b S6/S7](d:/Codes/kabegame/.claude/plans/phase7b-gallery-filters.md))，gallery_album_router DSL 自然在 list 加 `"bigger_order"` 静态项替代该 3 行

**rotator 顺序模式逻辑**：

```rust
fn load_next_sequential(source: &RotationSource, current: Option<&CurrentMarker>) -> Result<Option<ImageInfo>, String> {
    let path = match (source, current) {
        (RotationSource::Album(id), Some(CurrentMarker::Order(o))) =>
            format!("/gallery/album/{}/bigger_order/{}/l100l", id, o),
        (RotationSource::Album(id), None) =>
            format!("/gallery/album/{}/bigger_order/0/l100l", id),  // 从头开始
        (RotationSource::Gallery, Some(CurrentMarker::Time(t))) =>
            format!("/gallery/bigger_crawler_time/{}/l100l", t),
        (RotationSource::Gallery, None) =>
            "/gallery/bigger_crawler_time/0/l100l".into(),
    };
    let mut last_marker: Option<CurrentMarker> = current.cloned();
    loop {
        let path_now = match &last_marker { /* 拼新 path */ };
        let images = images_at(&path_now)?;
        if images.is_empty() { return Ok(None); }  // 后面没有了
        for img in &images {
            if is_wallpaper_suitable(img, mode) {
                return Ok(Some(img.clone()));
            }
        }
        // 这 100 张都不可用,推进到最后一张的 marker 继续
        last_marker = Some(extract_marker(images.last().unwrap()));
    }
}

// 调用方:
match load_next_sequential(&source, current)? {
    Some(img) => use_it(img),
    None => match source {
        RotationSource::Album(_) => load_next_sequential(&RotationSource::Gallery, current_gallery)?
            .ok_or_else(|| stop_rotation())?,
        RotationSource::Gallery => stop_rotation(),
    }
}
```

`CurrentMarker` 区分 album 模式（用 album_images.order）和画廊模式（用 crawled_at）。需要 `ImageInfo` 加 `album_order: Option<i64>` 字段（仅在 album 路径下被填）；或者在 rotator 顶层自己跟踪 current_id → 查 album_images.order。**用前者更省**：让 album DSL 路径 fields 加上 `album_images.order AS album_order`。

**`/gallery/album/{albumId}` 当前是 programmatic** ([programmatic/gallery_albums.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_albums.rs))，新加 `bigger_order` 路径需要在该 programmatic 模块加分支或 wait Phase 7b albums 迁 DSL。本期暂以 programmatic 实现；Phase 7b albums 迁 DSL 时一并合并。

## 子任务

### S1 — pathql Runtime 加 `fetch(path)` / `count(path)`（一次 commit）

| 文件 | 改动 |
|---|---|
| [pathql-rs/src/provider/runtime.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/runtime.rs) | 新增 `pub fn fetch(&self, path: &str) -> Result<Vec<JsonValue>, EngineError>`、`pub fn count(&self, path: &str) -> Result<usize, EngineError>`、私有 `fn template_context(&self) -> TemplateContext` |
| [pathql-rs/src/provider/runtime.rs](d:/Codes/kabegame/src-tauri/pathql-rs/src/provider/runtime.rs) test 模块 | 加 unit test：(a) `fetch_resolves_path_then_executes`，(b) `count_wraps_with_count_star`，(c) `fetch_returns_empty_on_limit_zero` |

**测试**：`cargo test -p pathql-rs --features "json5 validate"` 全绿（含新 3 case）。

### S2 — 删除死代码（PageSizeProvider / QueryPageProvider / count_for）（一次 commit）

| 文件 | 改动 |
|---|---|
| [programmatic/shared.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/shared.rs) | 删 `PageSizeProvider` 整体（struct + impl Provider + impl PageSizeProvider）+ `QueryPageProvider` 整体 |
| [programmatic/helpers.rs:130-137](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/helpers.rs#L130) `count_for` | 删除函数 |
| [programmatic/mod.rs:29-35](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/mod.rs#L29) | 删除 6c 注释掉的 register 调用代码块 |
| imports 清理 | 三个文件顶部清理不再使用的 imports |

完成后 storage 公开方法仍存在（callers 还在用），下一阶段 S3-S5 再切。

### S3 — `images_at(path)` / `count_at(path)` 公开 API（一次 commit）

| 文件 | 改动 |
|---|---|
| [providers/query.rs](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) | 新加 `pub fn images_at(path: &str) -> Result<Vec<ImageInfo>, String>`（内部 `provider_runtime().fetch(path)?` + `iter().map(json_row_to_image_info).collect()`）；`pub fn count_at(path: &str) -> Result<usize, String>`（`provider_runtime().count(path).map_err(...)`）；私有 `fn json_row_to_image_info(row) -> Result<ImageInfo>` 按列名读 17 字段 |
| [providers/query.rs](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) `execute_provider_query_typed` | 内部 `Storage::get_images_count_by_query(composed, ctx)` 全部替换为 `rt.count(&rt_path)`；`fetch_images_for(composed, ctx)` 替换为 `rt.fetch(&rt_path)?` + `iter().map(json_row_to_image_info).collect()`；删除 `fetch_images_for` 函数本身 + 它依赖的"无 limit → 最后一页"dead code 分支 |
| [providers/mod.rs](d:/Codes/kabegame/src-tauri/core/src/providers/mod.rs) | re-export `images_at` / `count_at` |

### S4 — rotator 重构（拆 2 个子 commit）

#### S4-a — 随机模式（一次 commit，无新 provider）

| 文件 | 改动 |
|---|---|
| [wallpaper/rotator.rs](d:/Codes/kabegame/src-tauri/app-main/src/wallpaper/rotator.rs) imports | 保留 `images_at` + `provider_runtime`；删除 `pathql_rs::ast::*` / `compose::ProviderQuery` / `template::eval::TemplateValue` 等手搓 query 的 import |
| 新加 `load_random_image_for_wallpaper(source) -> Result<Option<ImageInfo>>` | 详细逻辑见关键设计点 §8 模式 A 伪代码：拿 base_path → list pages → 不重复抽页 → fetch + 过滤 → 找到 Some(img) 或 None |
| 新加 `is_wallpaper_suitable(img, mode) -> bool` | 集中可用图片判定（图片类型 / 文件存在 / 格式兼容 wallpaper_mode 等）—— 替代当前散落的过滤逻辑 |
| `load_images_for_source` 调用方 | 随机模式分支改用 `load_random_image_for_wallpaper(&source)`，None 时按规则回退（album → gallery → stop_rotation） |

#### S4-b — 顺序模式：5 个新 DSL provider + bigger_crawler_time / bigger_order 路径（一次 commit）

| 文件 | 改动 |
|---|---|
| [dsl/gallery/gallery_bigger_crawler_time_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_bigger_crawler_time_router.json5) 新建 | resolve `(.+)` → `gallery_bigger_crawler_time_filter` properties.time |
| [dsl/gallery/gallery_bigger_crawler_time_filter.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_bigger_crawler_time_filter.json5) 新建 | properties.time + query (WHERE / ORDER) + resolve `l([0-9]+)l` → `limit_leaf_provider` properties.limit |
| [dsl/gallery/album/gallery_album_bigger_order_router.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/album/gallery_album_bigger_order_router.json5) 新建 | resolve `(.+)` → `gallery_album_bigger_order_filter` properties.order |
| [dsl/gallery/album/gallery_album_bigger_order_filter.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/album/gallery_album_bigger_order_filter.json5) 新建 | properties.order + query (WHERE / ORDER) + resolve `l([0-9]+)l` → `limit_leaf_provider` |
| [dsl/shared/limit_leaf_provider.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/shared/limit_leaf_provider.json5) 新建 | properties.limit + query.limit `${properties.limit}`，叶子 |
| [providers/dsl_loader.rs](d:/Codes/kabegame/src-tauri/core/src/providers/dsl_loader.rs) DSL_FILES manifest | 加 5 条新文件路径（dsl_loader 用 explicit manifest）|
| [providers/dsl/gallery/gallery_route.json5](d:/Codes/kabegame/src-tauri/core/src/providers/dsl/gallery/gallery_route.json5) list | 加 `"bigger_crawler_time": { "provider": "gallery_bigger_crawler_time_router" }` |
| [providers/programmatic/gallery_albums.rs](d:/Codes/kabegame/src-tauri/core/src/providers/programmatic/gallery_albums.rs) | `GalleryAlbumProvider::resolve` 加 `"bigger_order"` 分支：`instantiate_named("gallery_album_bigger_order_router", ctx)`（3 行 Rust，过渡到 albums DSL 迁完时移除）|
| ImageInfo / album fields | 加 `album_order: Option<i64>` 字段；programmatic gallery_album_router 的 apply_query 加 fields `album_images.order AS album_order` 贡献 —— 让 album 路径 row 含 album_order 列；rotator 顺序模式从中读 marker |
| [wallpaper/rotator.rs](d:/Codes/kabegame/src-tauri/app-main/src/wallpaper/rotator.rs) | 新加 `CurrentMarker` 枚举（Time(i64) / Order(i64)）+ `load_next_sequential(source, current_marker)` 函数；`load_images_for_source` sequential 分支改用之；保留 `align_sequential_index_from_current` 等已有逻辑 |
| 删除老函数 | `next_sequential_gallery_images` / `random_gallery_page_images` / `make_q` 闭包全删 |

**注意**：[dsl_loader.rs](d:/Codes/kabegame/src-tauri/core/src/providers/dsl_loader.rs) 是 explicit manifest（不递归扫描 `include_dir`）—— 新增 5 个 .json5 必须同步加到 `DSL_FILES` 常量 + 测试 fixture（`pathql-rs/tests/load_real_providers.rs` / `validate_real.rs` 等）的硬编码清单。

### S5 — mcp_server 切换 + 删除 deprecated stub（一次 commit）

| 文件 | 改动 |
|---|---|
| [mcp_server.rs:566 / 591](d:/Codes/kabegame/src-tauri/app-main/src/mcp_server.rs#L566) | 改用 `images_at(&path_for_runtime)` / `count_at(&path_for_runtime)` |
| [ipc/handlers/storage/images.rs](d:/Codes/kabegame/src-tauri/app-main/src/ipc/handlers/storage/images.rs) | 删除整文件 |
| [ipc/handlers/storage/mod.rs:91-93](d:/Codes/kabegame/src-tauri/app-main/src/ipc/handlers/storage/mod.rs#L91) | 删除 `IpcRequest::StorageGetImagesCountByQuery` 分支；同步删 IpcRequest enum + ipc client 的 [storage_get_images_count_by_query](d:/Codes/kabegame/src-tauri/core/src/ipc/client/client.rs#L360)（grep 找全）|

### S6 — Storage 方法删除（一次 commit，最后做让 trunk 始终绿）

S3-S5 让所有调用方都迁完后才删 storage 方法，trunk 全程编译干净。

| 文件 | 改动 |
|---|---|
| [storage/gallery.rs](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs) | 删除 `get_images_count_by_query` / `get_images_info_range_by_query` / `get_images_fs_entries_by_query` / `GalleryImageFsEntry`（如只它用）|
| [storage/gallery.rs](d:/Codes/kabegame/src-tauri/core/src/storage/gallery.rs) imports | 清理 `pathql_rs::compose::ProviderQuery` / `TemplateContext` / `template_bridge` 等死 import |

### S7 — 验证

1. `cargo check -p kabegame-core -p kabegame` 全绿
2. `cargo test -p pathql-rs --features "json5 validate"` 全绿（含 S1 新 3 case）
3. `bun dev -c main --data prod`：
   - `/gallery/all/`、`/gallery/all/1/`、`/gallery/all/x100x/1/`、`/gallery/hide/all/1/`、`/vd/i18n-zh_CN/` 行为不变
   - 壁纸轮播切换正常按 id 顺序取下一张
4. grep 兜底：
   - `grep -rn "get_images_.*_by_query" src-tauri/` → 0 条
   - `grep -rn "ProviderQuery\|TemplateContext" src-tauri/core/src/storage/` → 0 条（storage 不接触 pathql 类型）
   - `grep -rn "ProviderQuery\|TemplateContext" src-tauri/app-main/` → 0 条（app-main 全走 path）
   - `grep -rn "rusqlite\|FROM (\|LEFT JOIN album_images\|SELECT COUNT" src-tauri/core/src/storage/gallery.rs` → 0 条（除 schema/migration 类）

## 长期方向（本期不做）

本期把 fetch / count path-based 服务搭好，但只迁 gallery 图片查询路径。后续专题：

- `Storage::get_albums` / `get_tasks` / `get_surf_records` / 等子模块改造：每张表声明对应 DSL provider（如 `albums_query_provider` 提供与 `Album` typed struct 对齐的 fields），调用方走 path → fetch / count → typed mapper。最终 storage 子模块全部退化为 typed mapper
- migrations 仍写 SQL（DDL）—— DDL 不进 pathql 抽象，由 storage::migrations 管
- 写操作（INSERT / UPDATE / DELETE）—— pathql 当前只服务 SELECT。写操作的抽象（如果做）是更远话题

## 风险

- **runtime.fetch / count 内的循环依赖**：core storage 删除后，调用方在 providers / mcp_server / rotator，不再有 storage 反向依赖问题
- **JSON → ImageInfo 的类型边界**：rusqlite INTEGER → JSON Number → `as_i64`；image 字段不会到 i64::MAX 量级。Optional 字段需检查 JSON null vs 缺失 key 的统一语义
- **gallery_route fields alias 名硬契约**：DSL 改 alias 时 [providers/query.rs::json_row_to_image_info](d:/Codes/kabegame/src-tauri/core/src/providers/query.rs) 跟着改。靠 S3 加双向注释 + 主路径手测兜底
- **rotator 双层 router 60 行 Rust**：可接受
- **`pq_sub` 别名硬编码**：与 user-defined 别名重名概率近 0
- **S2 推迟到 S6 做的代价**：S3-S5 期间 storage 三个方法仍存在但无人调（warning unused）。S6 删除时所有 import 清干净。trunk 全程绿

## 子任务执行顺序

S1（pathql 加 fetch/count）→ S2（删死代码 PageSize/QueryPage/count_for）→ S3（新公开 API images_at/count_at）→ S4-a（rotator 随机模式路径化）→ S4-b（rotator 顺序模式 + 5 个新 provider）→ S5（mcp + 删 stub）→ S6（删 storage 方法 + imports 清理）→ S7（验证）

每步独立 commit，trunk 全程可编译。
