# 过滤走查 Phase D：插件 metadata 迁移改为游标双层循环

> 依赖 [phaseA.md](phaseA.md) 的 `emit_image_patches`。与 [phaseC.md](phaseC.md) 同一种形状。

### 总体设计思路

迁移现在把低于目标版本的 metadata 行（含 data 全文）一次全部读进内存，逐行跑 V8，攒 512 行写一次库，写完才给这 512 行涨进度；
所有改指记在 `MigrationRun` 里，整轮结束再一次发出全部图片补丁。本阶段改成：**外层按 id 游标每次查 10000 个 metadata 行，
内层对每一行完整执行一次**——跑 `migrate` / `provideLabels` / `provideSearchTextList`、按旧 id 给图片挂标签、写回，写回后立即把
改指到新行的图片发补丁 `{ id, metadataId }`（按张数分流），然后进度加一，前端照旧轮询进度快照。

唯一保留的累积状态是本轮新建的 metadata 行 id（`new_ids`），供结尾去重：去重只能合并本轮新建的行，若改用「id 大于起点」圈定候选，
可能把并发下载刚插入、图片还没引用的同插件同版本行合并删掉。去重的改指结果同样立即发补丁。

### 现状锚点

**a. 全量读入**（`plugin/metadata_migration.rs:196`）
```rust
// 现状：低于目标版本的行一次全部读进内存（含 data 全文）
let rows = Storage::global().metadata_rows_below_plugin_version(&plugin.id, target)?;
let run_guard = service.begin(&plugin.id, rows.len());
```

**b. 攒批写、整轮末尾发事件**（`plugin/metadata_migration.rs:270`）
```rust
let mut run = MigrationRun::default();
let mut batch = Vec::with_capacity(MIGRATION_BATCH); // 现状：攒 512 行写一次库
for (row_id, data, row_version) in rows {
    /* V8：migrate / provideLabels / provideSearchTextList */
    batch.push(PendingRow { ... });
    if batch.len() >= MIGRATION_BATCH {
        run.flush(storage, plugin_id, target, &mut batch, &mut on_row_done)?; // 写库后才给这 512 行涨进度
    }
}
...
let deduped = storage.dedup_migrated_metadata(plugin_id, target, &run.new_ids);
// 现状：MigrationRun 累积全部改指（final_metadata），整轮结束一次发出（Phase A 后为逐图补丁的大列表）
```

### 点 1 — 游标查询（`storage/images.rs`）

- **新增**
  - `metadata_rows_below_plugin_version_after(plugin_id, target, after_id, limit)`：现有查询加 `AND id > ?3 … LIMIT ?4`。
    > 说明：写回会插入目标版本的新行（id 更大），但新行 `plugin_version = target`，不会被游标再次选中。
  - `count_metadata_rows_below_plugin_version(plugin_id, target)`：`COUNT(*)`，给 `MetadataMigrationService::begin` 的 total。
- **删除**
  - `metadata_rows_below_plugin_version`。

### 点 2 — 单行迁移（`plugin/metadata_migration.rs`）

- **新增**
```rust
/// 单个 metadata 行：先按旧 id 给图片挂标签，再写回并把改指到新行的图片立即发补丁
async fn migrate_one(
    engine: &mut MigrationEngine,
    exports: Option<&MigrationExports>,
    storage: &Storage,
    plugin_id: &str,
    target: u32,
    (row_id, data, row_version): (i64, String, u32),
) -> Result<Vec<i64>, String> {
    let computed = compute_row(engine, exports, plugin_id, row_id, &data, row_version).await?; // 原循环体里的三段 V8 调用
    apply_labels(storage, plugin_id, row_id, &computed.labels);
    if !computed.write {
        return Ok(Vec::new());
    }
    let written = storage.writeback_migrated_metadata_batch(plugin_id, target, std::slice::from_ref(&computed.row))?;
    emit_metadata_patches(&written.repointed); // { id, metadataId }，按张数分流
    Ok(written.new_ids)
}
```

### 点 3 — 双层循环（`plugin/metadata_migration.rs`）

- **修改**
```rust
async fn run_metadata_migrations(storage, plugin_id, target, script, mut on_row_done: impl FnMut()) -> Result<bool, String> {
    let mut engine = MigrationEngine::new();
    let exports = /* 装载脚本，失败时仍逐行盖版本（现状语义） */;
    let mut new_ids = Vec::new(); // 本轮新建的 metadata 行，供结尾去重
    let mut last_id = 0;
    let migrated: Result<(), String> = async {
        loop {
            let rows = storage.metadata_rows_below_plugin_version_after(plugin_id, target, last_id, MIGRATION_SCAN_BATCH)?; // 外层
            if rows.is_empty() {
                break;
            }
            for row in rows {                                                                                          // 内层
                last_id = row.0;
                new_ids.extend(migrate_one(&mut engine, exports.as_ref(), storage, plugin_id, target, row).await?);
                on_row_done(); // 修改：每行涨一次进度
            }
        }
        Ok(())
    }
    .await;
    // 已写入的行即便后续失败也要去重（现状语义）；改指结果同样立即发补丁
    let deduped = storage.dedup_migrated_metadata(plugin_id, target, &new_ids)?;
    emit_metadata_patches(&deduped);
    migrated?;
    Ok(!new_ids.is_empty())
}
```
  - `run_metadata_migrations_for_plugin`：total 改用 `COUNT(*)`；删掉末尾整轮一次的补丁发送。
- **删除**
  - `MIGRATION_BATCH`、`PendingRow`、`MigrationRun`（`flush` / `finish` / `final_metadata` / `touched`）；
    `apply_labels` 改为单行版本的普通函数。

### 点 4 — 测试、文档

- **测试**：游标跨批不重复不遗漏；逐行发补丁（1 张 `image-changed`、多张 `images-change`）；脚本装载失败仍逐行盖版本；
  结尾去重只合并本轮新行并发补丁；中途失败已写入的行仍去重。
- **文档**：`cocs/crawler/METADATA_MIGRATION.md`（游标与逐行写回、事件粒度）、`cocs/README.md` 对应条目、
  `versions/latest/regression.md`、`changelog.md`。

### 验证

| 场景 | 预期 |
|---|---|
| 升级带迁移脚本的插件 | 忙碌卡片进度逐行增长；每行一条补丁事件 |
| 迁移后打开详情 | metadata 缓存按新 `metadataId` 失效，显示新内容 |
| 迁移产生内容相同的行 | 结尾去重合并，改指的图片再收到一条补丁 |
| 迁移进行中下载同插件新图 | 新图的 metadata 行不被去重删除 |

### 已知边界

- **逐行写回更慢**：写回从「512 行一个事务」变成「一行一个事务」，全量迁移总耗时变长；若不可接受，可攒 N 行一个事务、事件仍在提交后逐行发出。
- **去重仍在结尾**：去重前同内容的行会短暂各自存在，图片补丁里会先后出现两个 `metadataId`。
