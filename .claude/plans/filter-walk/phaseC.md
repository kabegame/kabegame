# 过滤走查 Phase C：整理改为游标双层循环 + 内存去重

> 依赖 [phaseA.md](phaseA.md) 的 `emit_image_patches` / `images-deleted`。

### 总体设计思路

整理现在先扫一批（重操作 10 行，否则 100 行），把待办分进删除、缩略图、兼容副本、原生元数据几个列表，再逐列表执行，
最后整批发一次补丁、涨一次进度；去重每批还要按哈希查一次整张表的胜者。本阶段改成同一种形状：**外层按 id 游标每次查
10000 行，内层对每一张图完整处理一次**——判删除（命中就删）、否则依次补缩略图、兼容副本、原生元数据，把这张图补上的字段
合成一条补丁发出，然后进度加一，前端照旧轮询进度快照。不再有中间列表，取消时也没有「先把攒着的补丁发掉」的分支。

去重改在内存里完成：整轮扫描维护「哈希 → 当前保留的 id」。扫描是 id 升序，所以保旧就是每个哈希第一次出现的行保留、
后面同哈希的删掉；保新是后到的顶替先到的，先到的若在区间内就删掉它。区间之前的行只登记不删，扫到区间末尾即停止。

### 现状锚点

**a. 先分列表再逐列表执行**（`storage/organize.rs:520`）
```rust
// 现状：重操作时一批只取 10 行，否则 100 行
let batch_size = if options.regen_thumbnails || options.regen_compatible || options.backfill_native_metadata { 10 } else { 100 };
loop {
    let batch = storage.get_organize_batch_after(last_id, batch_size)?;
    // 现状：每批按哈希查整张表的胜者 id
    let winner_ids = if options.dedupe { storage.get_hash_winner_ids(&hashes, options.dedupe_keep_new)? } else { HashMap::new() };
    let mut remove_ids: Vec<String> = Vec::new();
    let mut refresh_list: Vec<ThumbnailRefreshAction> = Vec::new();
    let mut changed_image_patches: Vec<ImageFieldPatch> = Vec::new();
    let mut should_remove: HashSet<i64> = HashSet::new();
    let mut native_metadata_list: Vec<(i64, String, String)> = Vec::new();
    let mut compat_list: Vec<(i64, String, String)> = Vec::new();
    for row in &batch { /* 只把待办分进各列表 */ }

    if !remove_ids.is_empty() { delete_images_with_events(&remove_ids, false) ... }
    for action in refresh_list {
        if cancel.load(Ordering::Relaxed) {
            emit_organize_images_change(&mut changed_image_patches); // 现状：每个列表循环都有这段取消分支
            emit_organize_finished(..., true, None);
            return Ok(());
        }
        ...
    }
    for (id, local_path, previous) in compat_list { /* 同样的取消分支 */ }
    for (id, local_path, format_key) in native_metadata_list { /* 同样的取消分支 */ }

    emit_organize_images_change(&mut changed_image_patches); // 现状：整批一次补丁
    push_organize_progress(total, &options, row_index, ...);  // 现状：整批结束才涨进度
}
```

**b. 胜者查询**（`storage/organize.rs:114`）
```rust
/// 一条聚合查询完成整批比对，避免逐图查表。IN 占位符按 `hashes` 长度动态拼接（整理批次 ≤100，占位符数量安全）
pub fn get_hash_winner_ids(&self, hashes: &[String], keep_new: bool) -> Result<HashMap<String, i64>, String>
// SELECT hash, MAX(id)/MIN(id) FROM images WHERE hash != '' AND hash IN (?, ?, …) GROUP BY hash
```

### 点 1 — 内存去重（`storage/organize.rs`）

- **新增**
```rust
/// 按 id 升序扫描时的去重表：每个哈希只记当前保留的那张图
#[derive(Default)]
struct DedupeIndex {
    kept: HashMap<String, (i64, bool)>, // 哈希 → (保留的 id, 该行是否在整理区间内)
}

enum DedupeVerdict {
    Keep,
    /// 删除本行（保旧：前面已有同哈希）
    RemoveSelf,
    /// 删除之前保留的那张（保新：本行更新），本行接替成为保留者
    RemovePrevious(i64),
}

impl DedupeIndex {
    /// 区间外的行也要登记（它们同样参与「谁保留」），但只有区间内的行会被删
    fn observe(&mut self, row: &OrganizeScanRow, in_range: bool, keep_new: bool) -> DedupeVerdict {
        if row.hash.is_empty() {
            return DedupeVerdict::Keep;
        }
        match self.kept.get_mut(&row.hash) {
            None => {
                self.kept.insert(row.hash.clone(), (row.id, in_range));
                DedupeVerdict::Keep
            }
            Some(_) if !in_range => DedupeVerdict::Keep, // 区间外的行不删，也不顶替保留者
            Some(_) if !keep_new => DedupeVerdict::RemoveSelf,
            Some(entry) => {
                let (previous, previous_in_range) = *entry;
                *entry = (row.id, true);
                if previous_in_range { DedupeVerdict::RemovePrevious(previous) } else { DedupeVerdict::Keep }
            }
        }
    }
}
```
    > 说明：内存只存哈希和 id，十万张图约十几 MB。
- **删除**
  - `Storage::get_hash_winner_ids`。

### 点 2 — 单张处理（`storage/organize.rs`）

- **新增**
  - `ORGANIZE_SCAN_BATCH = 10_000`；`OrganizeProgress { processed, removed, regenerated, backfilled }`，
    `update_run_state_progress` 改收这个结构。
  - `organize_one` 与 `remove_image`。
```rust
/// 单张图：命中删除条件就删掉并返回；否则依次补缩略图、兼容副本、原生元数据，把本图补上的字段合成一条补丁发出
fn organize_one(
    handle: &tokio::runtime::Handle,
    storage: &Storage,
    options: &OrganizeOptions,
    row: &OrganizeScanRow,
    dedupe: DedupeVerdict,
    progress: &mut OrganizeProgress,
    current_wallpaper_id: &mut Option<String>,
) -> Result<(), String> {
    if let DedupeVerdict::RemovePrevious(previous_id) = dedupe {
        // 保新：之前保留的同哈希图已处理过，这里补删它（只知道 id，源文件路径按 id 现查）
        remove_image(handle, storage, options, previous_id, None, progress, current_wallpaper_id)?;
    }
    if matches!(dedupe, DedupeVerdict::RemoveSelf) || should_remove(row, options) { // 去重 / 文件不存在 / 格式不识别
        remove_image(handle, storage, options, row.id, Some(&row.local_path), progress, current_wallpaper_id)?;
        return Ok(());
    }
    let mut fields = serde_json::Map::new();
    if options.regen_thumbnails {
        if let Some(path) = refresh_thumbnail(handle, storage, row)? {   // 由原 refresh_list 循环体提出
            fields.insert("thumbnailPath".into(), json!(path));
            progress.regenerated += 1;
        }
    }
    #[cfg(not(target_os = "android"))]
    if options.regen_compatible {
        if let Some(outcome) = refresh_compatible(handle, storage, row)? { // 由原 compat_list 循环体提出
            fields.insert("compatiblePath".into(), json!(outcome.path));
            progress.regenerated += usize::from(outcome.generated);
        }
    }
    if options.backfill_native_metadata {
        if let Some(metadata_id) = backfill_native_metadata(handle, storage, row)? { // 由原 native_metadata_list 循环体提出
            fields.insert("imageMetadataId".into(), json!(metadata_id));
            progress.backfilled += 1;
        }
    }
    GlobalEmitter::global().emit_image_patches(vec![ImageFieldPatch { id: row.id.to_string(), fields }]); // 没补上任何字段时不发
    Ok(())
}

/// 删除一张图：发 images-deleted、清当前壁纸、按选项删源文件、计数
fn remove_image(handle, storage, options, id: i64, local_path: Option<&str>, progress, current_wallpaper_id) -> Result<(), String> {
    let id = id.to_string();
    let local_path = match local_path {
        Some(path) => path.trim().to_string(),
        None if options.delete_source_files => storage.get_image_local_path(&id)?.unwrap_or_default(),
        None => String::new(),
    };
    handle.block_on(delete_images_with_events(std::slice::from_ref(&id), false))?;
    if current_wallpaper_id.as_deref() == Some(id.as_str()) {
        let _ = Settings::global().set_current_wallpaper_image_id(None);
        *current_wallpaper_id = None;
    }
    if options.delete_source_files && !local_path.is_empty() {
        handle.block_on(purge_source_files(&[local_path]));
    }
    progress.removed += 1;
    Ok(())
}
```
- **修改**
  - `should_remove(row, options)` 只剩文件不存在、格式不识别两条判断。

### 点 3 — 双层循环（`storage/organize.rs` `run_organize`）

- **修改**
```rust
fn run_organize(handle, storage, options, cancel) -> Result<(), String> {
    let mut progress = OrganizeProgress::default();
    let mut row_index = 0;
    let mut last_id = 0;
    let mut current_wallpaper_id = Settings::global().get_current_wallpaper_image_id();
    let mut dedupe = DedupeIndex::default();                                      // 新增：整轮共用的内存去重表
    'scan: loop {
        let batch = storage.get_organize_batch_after(last_id, ORGANIZE_SCAN_BATCH)?; // 外层：id 游标，一次 10000 行
        if batch.is_empty() {
            break;
        }
        for row in &batch {                                                         // 内层：逐张完整处理
            if cancel.load(Ordering::Relaxed) {
                emit_organize_finished(progress, true, None); // 修改：没有攒着的补丁要先发
                return Ok(());
            }
            last_id = row.id;
            let position = organize_range_position(row_index, options.offset, options.limit);
            if position == RangePosition::After {
                break 'scan;
            }
            row_index += 1;
            let verdict = if options.dedupe {
                dedupe.observe(row, position == RangePosition::Inside, options.dedupe_keep_new) // 区间前的行只登记
            } else {
                DedupeVerdict::Keep
            };
            if position == RangePosition::Before {
                continue;
            }
            organize_one(handle, &storage, &options, row, verdict, &mut progress, &mut current_wallpaper_id)?;
            progress.processed = row_index;
            OrganizeService::global().update_run_state_progress(&progress); // 修改：每张图涨一次，前端照旧轮询快照
        }
    }
    emit_organize_finished(progress, false, None);
    Ok(())
}
```
- **删除**
  - `batch_size` 的 10 / 100 切换；`remove_ids`、`refresh_list`、`compat_list`、`native_metadata_list`、`should_remove` 集合、
    `changed_image_patches` 与 `emit_organize_images_change`；三个列表循环里的取消分支；`organize_range_upper_bound` /
    `row_in_organize_range` 合并为 `organize_range_position`。

### 点 4 — 测试、文档

- **测试**：`DedupeIndex` 保旧 / 保新、跨 10000 行批次、区间前的行只登记不删、空哈希不参与；逐张处理（删除 / 补字段各发一次、
  没补上字段不发、取消后不再发、区间上下界）；现有缩略图判断用例迁到 `refresh_thumbnail`。
- **文档**：`cocs/downloader-tasks/DOWNLOADER_FLOW.md`（整理与事件）、`versions/latest/regression.md`、`changelog.md`。

### 验证

| 场景 | 预期 |
|---|---|
| 补缩略图 | 每张一条 `image-changed { thumbnailPath }`，进度逐张增长 |
| 同时补缩略图和兼容副本 | 同一张图一条补丁含两个字段 |
| 去重保旧 / 保新 | 删掉的是更新 / 更旧的副本，每张一条 `images-deleted` |
| 区间整理 + 去重 | 区间外的图都不被删 |
| 中途取消 | 取消前已处理的图都已发事件，之后不再发 |
| 删除当前壁纸 | 壁纸设置被清空 |

### 已知边界

- **区间去重的口径变化**：原胜者查询看整张表，保新时区间内的图会因为区间后面有更新副本而被删。现在只扫到区间末尾：保旧口径不变；
  保新时区间后面的新副本不会让区间内的图被删，区间前更旧的副本也不会被删（区间外的行一律不动）。
- **保新会补删已处理过的图**：同哈希的旧图先被扫到、可能已补过缩略图，扫到新图时才删掉它，前面的补图白做。
- **逐张删除更慢**：删除从「一批一次」变成「一张一次」，大库去重总耗时变长；若不可接受，可在内层攒满 N 张再删（会重新引入一个中间列表）。
- **整理期间新入库的图**：id 更大，游标照样会扫到并参与去重。
