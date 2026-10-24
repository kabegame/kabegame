# 过滤走查 Phase A：图片事件发送场景清单

> 只读调研产物。所有 `file:line` 以 2026-10-23 工作区为准（`src-tauri/` 下路径省略 `src-tauri/` 前缀以外的部分时，均从仓库根写全）。
> 本文只陈述代码现状与机械归类，不做取舍；需要拍板的点集中在文末「疑点」。

## 目标语义（用户已定）

1. `images-change` 改成「后端版本的 image-changed 聚合」：载荷是**按图片的补丁列表**，例如
   `[{ id: 323, thumbnailPath: "xxx" }, { id: 324, thumbnailPath: "xxx" }]`，前端看这一批变了哪些字段来决定是否刷新。
   若变的是元数据（例如 `metadataId`），补丁里带上新的 id。逐步去掉 `reason`。
2. `image-changed` 只表示**单张图片**某些字段变化，**不再补发** `images-change`。
3. 新增 `images-added`、`images-deleted`：表示图片在 `images` 表里真正的增删。

## 现状速览

- 发送函数在 `src-tauri/kabegame-core/src/emitter.rs`：
  - `emit_image_changed(patches: Vec<ImagePatch>)`（`emitter.rs:224`），`ImagePatch { image_ids, diff }`（`ipc/events.rs:175`）——一组图共享一份 `diff`。
  - `emit_image_changed_uniform(image_ids, diff)`（`emitter.rs:234`），空 `image_ids` 直接 return。
  - `emit_images_change(reason, image_ids, task_ids, surf_record_ids, plugin_ids)`（`emitter.rs:245`），**没有空列表保护**，`imageIds` 为空也照发；三个可选列表为空时序列化省略。
  - 两者共用 `next_change_seq()`，经 `dispatch_view_event` → `EventBroadcaster`。非 `ipc-server` 构建全部为空实现（`emitter.rs:547-559`）。
- `AppEvent::ImagesChange { seq, reason, imageIds, taskIds?, surfRecordIds?, pluginIds? }`（`ipc/events.rs:231-243`）；`AppEvent::ImageChanged { seq, patches }`（`ipc/events.rs:246`）。
- `reason="add"` 只有 2 个发送点（S1、S4），`reason="delete"` 只有 1 个（`image_events.rs:313`，被 S6–S9 共用），其余全部是 `"change"`。

---

## 场景表

> 「建议归属」只按「真正增删 → `images-added` / `images-deleted`；一次调用可能多张的字段变化 → `images-change`（批量补丁）；一次调用恒为单张的字段变化 → `image-changed`；`images` 表没变 → 不发」机械归类。

| 编号 | 场景 | 位置 | 改了 images 哪些列 / 增删行 | 现在发什么 | 单张/批量 | 建议归属 | 备注 |
|---|---|---|---|---|---|---|---|
| S1 | 下载器新图入库（含插件下载、`local-import` 内建插件、畅游导入） | `kabegame-core/src/crawler/downloader/mod.rs:1502`（`add_image`）、`:1511`（发事件）；入口 `queue.rs:1112/1162/1251`、`crawler/local_import.rs:142/225`、`kabegame/src/commands/surf_session.rs:140` | INSERT 一行（`storage/images.rs:964`，`add_image` 定义于 `:950`） | `images-change` reason=`add`，`imageIds=[新id]`，`taskIds=[task]?`，`surfRecordIds=[record]?`，`pluginIds=[plugin_id]` | 单张 | `images-added` | 畅游导入时 `plugin_id` 形参是 `ctx.host`（`surf_session.rs:149`），行里 `plugin_id` 却写 NULL（`mod.rs:1475-1479`），所以事件 `pluginIds=[host]` 与库不一致。原生元数据挂载在 add 事件之前（见 S2），画册成员事件在 add 之后。 |
| S2 | 下载器新图入库后，按哈希把原生元数据共享到同哈希旧图 | `crawler/downloader/mod.rs:887-893`、`:938-942` → `storage/image_events.rs:145-165` | UPDATE `image_metadata_id`（`storage/images.rs:760`，`WHERE hash = ?`，含新图本身） | `image-changed` 补丁 `{imageMetadataId}`（共享一份 diff）+ `images-change` reason=`change`，只带 `imageIds`（排除新图 id） | 批量（同哈希的 0..N 张旧图） | `images-change`（批量补丁） | 新图自身的 `image_metadata_id` 也被这条 UPDATE 改了，但被 `skip_image_id` 排除，依赖随后的 add 事件。 |
| S3 | 下载去重命中，重绑旧图的 metadata / plugin / postUrl | `crawler/downloader/mod.rs:41-118`（`rebind_deduped_metadata`，写库 `:78`，发事件 `:106/:110`）；调用 `mod.rs:1046`、`queue.rs:1070` | UPDATE `metadata_id`、`plugin_id`（COALESCE）、`post_url`（COALESCE）（`storage/images.rs:672`，`rebind_image_metadata` 定义于 `:653`） | `image-changed` 补丁 `{metadataId, pluginId?, postUrl?}` + `images-change` reason=`change`，`imageIds=[旧图]`、`taskIds=[旧图 task]?`、`surfRecordIds=[旧图 record]?`、`pluginIds=[旧 plugin, 新 plugin]?` | 单张 | `image-changed` | 受设置 `dedup_update_metadata` 门控。`taskIds` / `surfRecordIds` 取旧图自身的值，不是本次下载的任务。 |
| S4 | 本地文件夹同步导入新文件 | `kabegame-core/src/local_folder/import.rs:119`（`add_image`）、`:133`（发事件）；调用 `local_folder/sync.rs:320`、`:337` | INSERT 一行 | `images-change` reason=`add`，`imageIds=[新id]`，`pluginIds=[LOCAL_FOLDER_PLUGIN_ID]`，无 task / surf | 单张 | `images-added` | 本路径不做原生元数据。画册成员事件在 add 之后（`import.rs:134-136`）。 |
| S5 | 本地文件夹同步：已有文件哈希变化 → 删旧行再重导入 | `local_folder/sync.rs:314`（删）、`:320`（重导入） | DELETE 旧行 + INSERT 新行（新 id） | 先 `images-change` reason=`delete`（经 `image_events.rs:313`），再 reason=`add`（经 `import.rs:133`） | 单张 | `images-deleted` + `images-added` | 新行沿用旧 `display_name`、复制出的新 `metadata_id`、画册内 `order`（`sync.rs:306-329`），但 id 变了。 |
| S6 | 用户删除 / 移除图片（单张与批量命令） | `kabegame-core/src/commands/image.rs:183-206` → `storage/image_events.rs:297-313`（`begin_delete_images_with_events`）；入口 `kabegame/src/commands/image.rs:80-96`、`kabegame/src/ipc/handlers/storage/images.rs:49-72`、`kabegame/src/web/dispatch.rs:1058/1078` | DELETE 行（`storage/images.rs:1299` 于 `batch_delete_images`(:1213)；`:1406` 于 `batch_remove_images`(:1324)） | `images-change` reason=`delete`，`imageIds=传入的 ids`，`taskIds=删前收集的任务`；无 surf / plugin | 批量 | `images-deleted` | `imageIds` 是**请求的** id，不是实际删掉的 id。随后另发按画册拆分的 `album-images-change`（`ImagesDeleted` 上下文，不发 `isHidden` 补丁）。 |
| S7 | 整理：去重 / 清除失效 / 清除不识别格式 | `kabegame-core/src/storage/organize.rs:683-686`（`run_organize` 内） | DELETE 行（同 S6，`delete_files=false`） | 同 S6 | 批量（整理批次） | `images-deleted` | `delete_source_files` 时另行 purge（`organize.rs:698-706`），与事件无关。 |
| S8 | 清空隐藏画册（隐藏图片清理服务） | `kabegame-core/src/storage/hidden_cleanup.rs:191`（`run_hidden_cleanup` 内） | DELETE 行（`delete_files=true`） | 同 S6 | 批量（`CLEANUP_BATCH_SIZE` 一批） | `images-deleted` | |
| S9 | 本地文件夹同步：源文件已消失 → 删行 | `local_folder/sync.rs:368`（全量 `finalize`）、`:638`（diff `run_diff`） | DELETE 行（`delete_files=false`） | 同 S6 | 批量 | `images-deleted` | 文件仍在但不再属于该目录的走 `remove_images_from_album`（`sync.rs:357-365`），只发 `album-images-change`，不动 images 行。 |
| S10 | 整理：补缩略图 / 补兼容格式 / 补原生元数据 | `storage/organize.rs:390-402`（`emit_organize_images_change`）；发送时机 `:712`/`:786`/`:898`（取消）、`:979`（每批结束）；补丁来源 `:724-728`、`:739-743`、`:767-773`、`:859-868`、`:873-883`、`:915`、`:964` | UPDATE `thumbnail_path`（`images.rs:1485`）、`compatible_path`（`images.rs:1509`）、`image_metadata_id`（`images.rs:760` / `:823`） | `image-changed` 多个 `ImagePatch`（每张图一条：`{thumbnailPath}` / `{compatiblePath}` / `{imageMetadataId}`）+ `images-change` reason=`change`，`imageIds` 去重排序后的全部 id | 批量（每个整理批次一次） | `images-change`（批量补丁） | 原生元数据按哈希共享时，一张代表图会连带改同哈希的多张（`native_metadata_image_patch` 用 `attached.changed_image_ids`）。 |
| S11 | 查看详情时懒解析 / 挂载原生元数据 | `kabegame-core/src/commands/image.rs:114-116`、`:133-139`（`get_image_native_metadata`，定义于 `:91`）→ `image_events.rs:145-165` | UPDATE `image_metadata_id`（非空 hash 走 `images.rs:760` 全哈希回填；空 hash 走 `:823` 单行） | `image-changed` `{imageMetadataId}` + `images-change` reason=`change`，只带 `imageIds` | 1..N（同哈希共享时批量） | `images-change`（批量补丁） | 用户只点了一张，但同哈希的图会一起改。 |
| S12 | 插件 metadata 迁移（插件升级后批量改写 metadata） | `kabegame-core/src/plugin/metadata_migration.rs:243-253`（`run_metadata_migrations_for_plugin`，定义于 `:196`）；补丁组装 `:482-498` | UPDATE `metadata_id`（`storage/images.rs:302`，`repoint_metadata_rows`(:291)，由 `writeback_migrated_metadata_batch`(:520) 与 `dedup_migrated_metadata`(:579) 调用） | `image-changed` 按最终 `metadataId` 分组的 `ImagePatch`（`{metadataId}`）+ `images-change` reason=`change`，`imageIds`=所有被改指的图、`pluginIds=[插件]` | 批量（可能是该插件全部图片） | `images-change`（批量补丁） | metadata 行按 id 不可变：内容一变就换新 id，前端 `useImageMetadataCache` 以 `m${metadataId}` 为键，所以「新 id」即可失效缓存。整轮只在末尾发一次。 |
| S13 | 删除畅游记录 → 关联图片 `surf_record_id` 置空 | `kabegame-core/src/storage/surf_records.rs:486-527`（`delete_surf_record`，写库 `:509`，发事件 `:517-526`）；入口 `commands/surf.rs:69-76` | UPDATE `surf_record_id = NULL` | `image-changed` `{surfRecordId: null}`（共享一份 diff）+ `images-change` reason=`change`，`imageIds`、`surfRecordIds=[被删记录]` | 批量（该记录下全部图） | `images-change`（批量补丁） | 记录下 0 张图时 `image-changed` 被吞，但 `images-change` 仍以空 `imageIds` 发出。 |
| S14 | 删除单个任务 | `kabegame-core/src/commands/task.rs:503-508`（`delete_task`）；Tauri 入口 `kabegame/src/commands/task.rs:146` | **不动 images 表**（`storage/tasks.rs:522-` 只删 `task_logs` / `task_failed_images` / `tasks`，`images.task_id` 留成悬空值） | `images-change` reason=`change`，`imageIds=[]`，`taskIds=[task]` | — | 不发（images 层面） | 实际用途是让任务视图 / 虚拟盘任务目录失效，见疑点 Q2。 |
| S15 | 清除已完成任务 | `kabegame-core/src/commands/task.rs:736-747`（`clear_finished_tasks`）；Tauri 入口 `kabegame/src/commands/task.rs:81` | 不动 images 表（`storage/tasks.rs:634-`） | `images-change` reason=`change`，`imageIds=[]`，`taskIds=[被清的任务…]`（列表非空才发） | — | 不发（images 层面） | 同 S14。 |
| S16 | MCP 工具 `rename_image` 改可见名 | `kabegame/src/mcp_server.rs:1211-1236`（写库 `:1219`，发事件 `:1221`/`:1225`） | UPDATE `display_name`（`storage/images.rs:1569`，`update_image_display_name`(:1562)） | `image-changed` `{displayName}` + `images-change` reason=`change`，只带 `imageIds` | 单张 | `image-changed` | 这是 `update_image_display_name` 唯一的调用方。 |
| S17 | IPC 设置「当前壁纸 id」（同时记设壁纸时间） | `kabegame/src/ipc/handlers/settings.rs:327-349`（写库 `:337`，发事件 `:340`/`:344`）；IPC 分发 `:106-107` | UPDATE `last_set_wallpaper_at`（`storage/images.rs:1555`，`update_image_last_set_wallpaper_at`(:1548)） | `image-changed` `{lastSetWallpaperAt}` + `images-change` reason=`change`，只带 `imageIds`（无 plugin） | 单张 | `image-changed` | |
| S18 | 轮播定时换壁纸 | `kabegame/src/wallpaper/rotator.rs:589-614`（`spawn_task` 内，写库 `:596`，发事件 `:599`/`:604`/`:613`） | UPDATE `last_set_wallpaper_at` | `image-changed` `{lastSetWallpaperAt}` + `images-change` reason=`change`，`imageIds`，有插件时 `pluginIds=[plugin]` | 单张 | `image-changed` | |
| S19 | 手动「下一张」轮换 | `kabegame/src/wallpaper/rotator.rs:883-908`（`rotate`，定义于 `:757`；写库 `:891`，发事件 `:894`/`:899`/`:907`） | UPDATE `last_set_wallpaper_at` | 同 S18 | 单张 | `image-changed` | |
| S20 | 按图片设壁纸（Tauri 命令） | `kabegame/src/commands/wallpaper.rs:88-107`（`set_wallpaper_by_image_id`，定义于 `:41`；写库 `:92`，发事件 `:96`/`:98`/`:106`） | UPDATE `last_set_wallpaper_at` | 同 S18 | 单张 | `image-changed` | |
| S21 | 隐藏：加入隐藏画册 | `storage/image_events.rs:185-201`（`emit_membership_added` 的 HIDDEN 分支 → `emit_image_hidden_changed`(:167-172)）；调用方 `commands/album.rs:135`（`add_images_to_album`）、`:153`（`add_task_images_to_album`）、`kabegame/src/mcp_server.rs:1198`（MCP `add_images_to_album`）；理论上还有下载输出画册 `crawler/downloader/mod.rs:1040/1213/1523`、`queue.rs:1063` | **不动 images 表**（`isHidden` 是 `album_images` 推导字段，`storage/images.rs:45`） | `album-images-change`（add-hidden / hide）+ `image-changed` `{isHidden: true}` + `images-change` reason=`change`，只带 `imageIds` | 批量 | `images-change`（批量补丁）——但严格说 images 行没变，见 Q10 | 上下文菜单隐藏单张时也走这条批量路径。 |
| S22 | 取消隐藏：移出隐藏画册 | `storage/image_events.rs:230-251`（`emit_membership_removed` 在 `AlbumMutation` + HIDDEN 时）；调用方 `commands/album.rs:164`（`remove_images_from_album`） | 不动 images 表 | `album-images-change`（delete-hidden / unhide）+ `image-changed` `{isHidden: false}` + `images-change` reason=`change` | 批量 | 同 S21 | 整行删除（S6–S9）走 `ImagesDeleted` 上下文，不发 `isHidden`。 |

---

## 各场景现状代码

### S1 下载器新图入库
```rust
// kabegame-core/src/crawler/downloader/mod.rs:1502-1517
let inserted = match Storage::global().add_image(image_info) {
    Ok(inserted) => {
        let image_id = inserted.id.clone();
        persist_native_metadata_best_effort(&inserted, bytes).await; // 现状：先给同哈希旧图发 S2
        let ids = vec![image_id.clone()];
        GlobalEmitter::global().emit_images_change(
            "add",                                      // 现状：唯一的下载新增信号
            &ids,
            task_opt.as_ref().map(|v| v.as_slice()),
            surf_opt.as_ref().map(|v| v.as_slice()),
            Some(&[plugin_id.to_string()]),             // 现状：畅游时这里是 host
        );
```

### S2 下载链路的原生元数据共享
```rust
// kabegame-core/src/crawler/downloader/mod.rs:887-893
Ok(Some(attached)) => {
    crate::storage::image_events::emit_native_metadata_attached(
        &attached,
        // 现状：新图自己被排除，靠随后的 add 事件
        Some(image.id.as_str()),
    );
// kabegame-core/src/storage/image_events.rs:158-164
    emitter.emit_image_changed_uniform(&changed, json!({ "imageMetadataId": attached.metadata_id }));
    emitter.emit_images_change("change", &changed, None, None, None); // 现状：成对补发
```

### S3 去重重绑
```rust
// kabegame-core/src/crawler/downloader/mod.rs:106-116
GlobalEmitter::global().emit_image_changed_uniform(
    std::slice::from_ref(&existing.id),
    serde_json::Value::Object(diff),            // 现状：{metadataId, pluginId?, postUrl?}
);
GlobalEmitter::global().emit_images_change(
    "change",
    std::slice::from_ref(&existing.id),
    existing.task_id.as_ref().map(std::slice::from_ref),        // 现状：旧图自己的任务
    existing.surf_record_id.as_ref().map(std::slice::from_ref),
    (!plugin_ids.is_empty()).then_some(plugin_ids.as_slice()),  // 现状：旧+新插件
);
```

### S4 本地文件夹导入
```rust
// kabegame-core/src/local_folder/import.rs:131-133
let image_ids = vec![image_id.clone()];
let plugin_ids = vec![LOCAL_FOLDER_PLUGIN_ID.to_string()];
GlobalEmitter::global().emit_images_change("add", &image_ids, None, None, Some(&plugin_ids)); // 现状：无 task/surf
```

### S5 本地文件夹哈希变化重导入
```rust
// kabegame-core/src/local_folder/sync.rs:314-329
delete_images_with_events(std::slice::from_ref(&existing.id), false)
    .await?;                                     // 现状：发 delete
...
import_local_file(path, Some(&self.album_id), file.size.unwrap_or(0),
    Some(CarryFromOld { display_name: existing.display_name, metadata_id, order }),
).await?;                                        // 现状：发 add，新 id
```

### S6–S9 统一删除出口
```rust
// kabegame-core/src/storage/image_events.rs:302-313
let (pairs_before, ancestor_paths) = storage.collect_album_memberships_with_paths(image_ids)?;
let task_ids = storage.collect_task_ids_for_images(image_ids)?;
let paths = if delete_files { storage.batch_delete_images(image_ids)? }
            else { storage.batch_remove_images(image_ids)?; Vec::new() };
for tid in &task_ids { emit_task_image_counts_full(tid); }
// 现状：imageIds 是请求的 id；只带 taskIds
GlobalEmitter::global().emit_images_change("delete", image_ids, Some(&task_ids), None, None);
```
```rust
// S7 kabegame-core/src/storage/organize.rs:683-686
handle.block_on(crate::storage::image_events::delete_images_with_events(&remove_ids, false))?;
// S8 kabegame-core/src/storage/hidden_cleanup.rs:191
let purge = handle.block_on(delete_images_with_events(&batch, true))?;
// S9 kabegame-core/src/local_folder/sync.rs:368 / :638
delete_images_with_events(&missing, false).await?;
if let Err(err) = delete_images_with_events(&missing_ids, false).await { ... }
```

### S10 整理补字段
```rust
// kabegame-core/src/storage/organize.rs:390-402
fn emit_organize_images_change(image_patches: &mut Vec<ImagePatch>) {
    if image_patches.is_empty() { return; }
    let mut image_ids = image_patches.iter().flat_map(|p| p.image_ids.iter().cloned()).collect::<Vec<_>>();
    image_ids.sort();
    image_ids.dedup();
    GlobalEmitter::global().emit_image_changed(std::mem::take(image_patches)); // 现状：每图一条 patch
    GlobalEmitter::global().emit_images_change("change", &image_ids, None, None, None); // 现状：成对补发
}
// organize.rs:724-728（补缩略图之一）
storage.replace_image_thumbnail_path(&id.to_string(), &local_path)?;
changed_image_patches.push(ImagePatch {
    image_ids: vec![id.to_string()],
    diff: serde_json::json!({ "thumbnailPath": local_path }),
});
```

### S11 查看时懒挂原生元数据
```rust
// kabegame-core/src/commands/image.rs:113-116
let shared =
    storage.ensure_native_metadata_for_image(&image_id, &row.hash, expected_version, None)?;
if let Some(attached) = &shared {
    emit_native_metadata_attached(attached, None); // 现状：可能连带同哈希多张
}
```

### S12 插件 metadata 迁移
```rust
// kabegame-core/src/plugin/metadata_migration.rs:243-252
if changed {
    let plugin_ids = vec![plugin.id.clone()];
    let image_ids = image_patches.iter().flat_map(|patch| patch.image_ids.iter().cloned()).collect::<Vec<_>>();
    emitter.emit_image_changed(image_patches);   // 现状：按最终 metadataId 分组
    emitter.emit_images_change("change", &image_ids, None, None, Some(&plugin_ids));
}
```

### S13 删除畅游记录
```rust
// kabegame-core/src/storage/surf_records.rs:516-526
GlobalEmitter::global().emit_surf_record_deleted(id);
GlobalEmitter::global()
    .emit_image_changed_uniform(&image_ids, json!({ "surfRecordId": null }));
GlobalEmitter::global().emit_images_change(
    "change",
    &image_ids,                    // 现状：可能为空，仍然发
    None,
    Some(&[id.to_string()]),
    None,
);
```

### S14 / S15 删除任务、清除已完成任务
```rust
// kabegame-core/src/commands/task.rs:503-508
pub fn delete_task(task_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    storage.delete_task(&task_id)?;                 // 现状：不动 images 表
    GlobalEmitter::global().emit_task_deleted(&task_id);
    GlobalEmitter::global().emit_images_change("change", &[], Some(&[task_id]), None, None); // 现状：空 imageIds
// kabegame-core/src/commands/task.rs:743-745
    if !task_ids.is_empty() {
        GlobalEmitter::global().emit_images_change("change", &[], Some(&task_ids), None, None);
    }
```

### S16 MCP 改名
```rust
// kabegame/src/mcp_server.rs:1218-1231
Storage::global()
    .update_image_display_name(&args.image_id, &args.display_name)
    .map_err(|e| McpError::internal_error(e, None))?;
GlobalEmitter::global().emit_image_changed_uniform(
    std::slice::from_ref(&args.image_id),
    json!({ "displayName": args.display_name }),
);
GlobalEmitter::global().emit_images_change("change", &[args.image_id.clone()], None, None, None); // 现状：成对补发
```

### S17–S20 设壁纸记时间
```rust
// kabegame/src/ipc/handlers/settings.rs:336-345（S17）
if Storage::global().update_image_last_set_wallpaper_at(&ids[0], now).is_ok() {
    GlobalEmitter::global().emit_image_changed_uniform(&ids, serde_json::json!({ "lastSetWallpaperAt": now }));
    GlobalEmitter::global().emit_images_change("change", &ids, None, None, None); // 现状：不带 plugin
}
// kabegame/src/wallpaper/rotator.rs:595-614（S18，S19 的 :890-908 与 S20 的 commands/wallpaper.rs:91-107 同形）
if Storage::global().update_image_last_set_wallpaper_at(&ids[0], now_ts).is_ok() {
    GlobalEmitter::global().emit_image_changed_uniform(&ids, serde_json::json!({ "lastSetWallpaperAt": now_ts }));
    if let Some(plugin_id) = selected_image.plugin_id.clone() {
        GlobalEmitter::global().emit_images_change("change", &ids, None, None, Some(&[plugin_id])); // 现状：带 plugin
    } else {
        GlobalEmitter::global().emit_images_change("change", &ids, None, None, None);
    }
}
```

### S21 / S22 隐藏 / 取消隐藏
```rust
// kabegame-core/src/storage/image_events.rs:167-172
fn emit_image_hidden_changed(changed: &[String], is_hidden: bool) {
    if let Some(emitter) = GlobalEmitter::try_global() {
        emitter.emit_image_changed_uniform(changed, json!({ "isHidden": is_hidden }));
        emitter.emit_images_change("change", changed, None, None, None); // 现状：成对补发
    }
}
// image_events.rs:201（加入 HIDDEN）/ :251（AlbumMutation 下移出 HIDDEN）
emit_image_hidden_changed(changed, true);
emit_image_hidden_changed(changed, false);
```

---

## 改了 images 行却没发 images-* 事件的路径

| 编号 | 位置 | 改了什么 | 现状 | 备注 |
|---|---|---|---|---|
| N1 | `kabegame-core/src/wallpaper_compat.rs:49`（`resolve_native_wallpaper_path`(:20)，经 `ensure_native_wallpaper_path`(:7) 被 `kabegame/src/wallpaper/manager/native.rs:393/704/761` 调用）→ `storage/images.rs:1541` | UPDATE `wallpaper_compatible_path` | 不发任何事件 | 该列不在 `ImageInfo` 里，前端看不到，也不参与 provider 过滤/排序（`rg` 前端无引用）。 |
| N2 | `storage/images.rs:1455-1467` `update_image_thumbnail_path` | UPDATE `thumbnail_path` | 不发 | **无调用方**（死代码）；整理用的是 `replace_image_thumbnail_path`(:1469)，事件由 S10 负责。 |
| N3 | `storage/images.rs:1032` `delete_image`、`:1124` `remove_image`（DELETE 于 `:1096` / `:1185`） | DELETE 行 | 不发 | **无调用方**（死代码）；所有删除都经 `batch_delete_images` / `batch_remove_images` + S6 出口。 |
| N4 | S2 中新图自身：`storage/images.rs:760` 的 `WHERE hash = ?` 也改了新图的 `image_metadata_id` | UPDATE `image_metadata_id` | 被 `skip_image_id` 排除（`crawler/downloader/mod.rs:891/941`） | 依赖随后 S1 的 add；add 载荷不带字段，前端会重拉。 |
| N5 | 下载去重命中后的加画册 / 挂标签（`crawler/downloader/mod.rs:1033-1047`、`:1207-1222`；`queue.rs:1055-1081`）；本地文件夹已存在文件链回画册（`local_folder/sync.rs:293-300`、`import.rs:40-50`） | 只改 `album_images` | 只发 `album-images-change`（非 HIDDEN 画册时无 `isHidden` 补丁） | 不在本次范围，列出供核对。 |
| N6 | 收藏切换 `storage/image_events.rs:372-393`（`toggle_image_favorite_with_event`） | 只改 `album_images`（收藏画册） | 只发 `album-images-change`；前端 `imagePatches.ts:27-40` 由它推出 `favorite` 补丁 | `ImageInfo.favorite` 变化不经 images-* 事件。 |
| N7 | S14 / S15 删除任务 | 不改 images，`images.task_id` 变成悬空值 | 反而发了 `images-change` | 列在这里便于对照：有事件但没改行。 |

（另：`add_image` 里 `UPDATE tasks SET success_count`、删除里的 `UPDATE tasks SET deleted_count`、`gc_metadata` / `gc_image_metadata` 改的是别的表，不计入。`storage/albums.rs`、`providers/query.rs`、`plugin/metadata_migration.rs`、`local_folder/tests.rs` 中命中的 `INSERT INTO images` / `UPDATE images` 均位于 `#[cfg(test)]` 块内。虚拟盘写操作全部拒绝（`virtual_driver/semantics.rs:370-403`），CLI 源码无 images 写入。）

---

## 订阅方

### 后端

| 订阅方 | 位置 | 现在用了什么 | 改语义后要注意 |
|---|---|---|---|
| 事件种类注册 | `kabegame-core/src/ipc/events.rs:66-89`（`app_event_kinds!` 列表，决定 `AppEventKind::ALL`）、`:110-111`（`as_event_name`）、`:140-141`（`from_event_name`）、`:231-246`（枚举体）、`:472-473`（`kind()`） | — | 新增 `images-added` / `images-deleted` 必须在这五处同时登记，否则 `ALL` 订阅（事件循环、SSE、IPC）收不到。 |
| 虚拟盘监听（仅 Windows） | `kabegame/src/vd_listener.rs:42-51`；由 `kabegame/src/core_init.rs:113-119` 在 `#[cfg(target_os = "windows")]` 下启动 | 只读 `ImagesChange.task_ids`：逐个 `notify_task_dir_changed`；任何 `ImagesChange`（不管 reason、不管 imageIds）都 `notify_gallery_tree_changed` | ① 现在设壁纸、改名、补缩略图等纯字段变化也会触发整棵画廊树失效；② 任务目录失效依赖 `taskIds`——S1 add、S6–S9 delete、S14/S15 删任务都靠它。新增 `images-added` / `images-deleted` 后要订阅它们并保留 `taskIds`；S14/S15 若不再发 images 事件，需改订 `TasksChange`（现在订阅了但 match 的是 `TaskAdded/TaskDeleted`，`:66-68`）。③ `image-changed` 若不再补发 `images-change`，单图 `displayName` 改动不会再让 VD 刷新。 |
| 统一事件循环 → Tauri 前端 / SSE | `kabegame/src/startup.rs:421-458`（`subscribe_filtered_stream(&AppEventKind::ALL)`；SSE `:437-444`，Tauri `app.emit(kind.as_event_name(), 全量 payload)` `:449-458`） | 透传，整份 serde 序列化 | 自动跟随新种类与新载荷形状；无字段依赖。 |
| Web SSE | `kabegame/src/web/server.rs:41-64` | 透传事件名 + JSON 字符串 | Web release 的 CDN 路径改写只作用于 RPC 结果（`kabegame/src/web/dispatch.rs:126/190/235` 调 `image_rewrite::rewrite_image_value`），**SSE 事件里的 `thumbnailPath` / `compatiblePath` 不改写**——现在 S10 的 `image-changed` 就有这个问题，改成批量补丁后同样存在。 |
| app IPC 订阅（外部集成 / CLI） | `kabegame-core/src/ipc/server/subscription_manager.rs:42-`（按 kind 转发） | 透传 | CLI 只订 `TaskLog` / `TasksChange`（`kabegame-cli/src/backend.rs:205-206`）；`kabegame-cli/src/main.rs:1137` 的注释说明已不再用 `images-change(add)` 计数。无其它后端消费者。 |
| 后端单测 | `kabegame-core/src/storage/image_events.rs:419-467`（`hidden_field_change_emits_patch_before_view_invalidation`） | 断言隐藏同时发 `image-changed` + `images-change(change)` 且 seq 先后 | 语义改后此测试需重写。 |

（`cocs/provider-dsl/RULES.md:568` 写「由 `images-change` 等事件显式清空相关前缀」，但后端代码里除上表外没有订阅 `ImagesChange` 的地方，provider 缓存失效走的是 `invalidate_images_total_cache` 等直接调用。）

### 前端（`apps/kabegame/src`）

载荷类型 `services/kbEvents/events.ts:7-25`：`ImagesChangePayload { seq, reason?, imageIds?, taskIds?, surfRecordIds?, pluginIds? }`、`ImageChangedPayload { seq, patches: { imageIds, diff }[] }`。

| 文件 | 订阅 | 用到的字段 | 改语义后要注意 |
|---|---|---|---|
| `services/kbEvents/imagePatches.ts:18-24, 47-51` | `image-changed` | `patches[].imageIds`、`patches[].diff`（合并成 `imageId → 字段`） | 唯一的补丁消费入口；新 `images-change` 的「按图片补丁列表」形状不同（`{id, ...字段}`），若也要就地打补丁需在这里新增一条流。 |
| `components/ImageGrid.vue:545`（`patchMany`，`:510-527`） | 经 `imagePatches$` | 同上 | 只打补丁不发请求。 |
| `components/common/ImagePreviewDialog.vue:870-875` | 经 `imagePatches$` | 同上 | — |
| `components/common/ImagePreviewDialog.vue:881` | `images-change` | `reason`（有就命中）、`imageIds.includes(当前 id)` | 现在因为每条都带 reason，**任何** images-change 都会重拉预览。去 reason 后只剩 `imageIds` 判断，且要能处理新载荷形状；删除需改订 `images-deleted`。 |
| `components/imageGrid/adapters/gallery.ts:47` | `images-change` | 只看 `!!reason` | 现在等价于「任何 images-change 都刷新」。去 reason 后谓词恒假，必须改写；新增/删除要改订 `images-added` / `images-deleted`；单图 `image-changed` 不再补发后，改名/设壁纸时间等若影响当前排序或过滤将不再触发重查。 |
| `components/imageGrid/adapters/album.ts:85` | `images-change` | `!!albumId && !!reason` | 同 gallery。 |
| `components/imageGrid/adapters/task.ts:34-38` | `images-change` | `reason`、`taskIds`（缺失按命中） | 依赖 `taskIds`：S1 add、S6–S9 delete（删前收集）、S3（旧图 task）、S14/S15（空 imageIds）。新事件需保留 task 维度。 |
| `components/imageGrid/adapters/surf.ts:32-37` | `images-change` | `reason`、`surfRecordIds`（缺失按命中） | 依赖 `surfRecordIds`：S1、S3、S13；S6 删除不带它 → 现按「缺失即命中」刷新。 |
| `composables/useSurfImageCounts.ts:31-34` | `images-change` | `reason`、`surfRecordIds` | 同 surf adapter。 |
| `components/galleryFilterTree/facetTreeSource.ts:359` | `images-change` | 只看 `!!reason`（`deltaMode` 时不订） | 同 gallery。 |
| 其它 | — | `pluginIds` **前端无任何消费者**（`rg pluginIds` 只命中类型定义与无关组件） | 后端发 `pluginIds` 目前只是载荷冗余。 |
| 测试 | `services/kbEvents/kbEvents.test.ts`（多处 `reason`）、`components/galleryFilterTree/facetTreeSource.test.ts:104-105`、`components/tree/useTreeModel.test.ts:109`、`composables/useSurfImageCounts.test.ts:54`、`composables/useAlbumQuery.test.ts:221`、`header/comps/HiddenCleanupControl.test.ts:45`、`composables/useNativeMetadataState.test.ts:49` | 构造 `reason` 载荷 | 随语义一起改。 |
| 文档 | `.cursor/rules/view-mutation.mdc`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`、`cocs/downloader-tasks/DOWNLOADER_FLOW.md`、`cocs/crawler/METADATA_MIGRATION.md`、`apps/docs/src/content/docs/reference/mcp.md:391`、`apps/docs/src/content/docs/dev/v8-api.mdx:272` | 描述了「image-changed + images-change 成对」 | 需同步。 |

---
---

# 画册成员事件发送场景清单（album-images-change 走查）

> 只读调研产物。所有 `file:line` 以 2026-10-24 工作区为准；`kabegame-core/…`、`kabegame/…` 均指 `src-tauri/` 下的 crate，前端路径相对 `apps/kabegame/src/`。
> 写法同上文 Phase A：只陈述代码现状与机械归类，取舍集中在本章末尾「疑点 MQ」。

## 目标语义（用户已定）

按 `album_images` 表的三个维度拆分画册成员事件：

1. 真正 INSERT 了 `album_images` 行 → `album-images-added`；
2. 真正 DELETE 了 `album_images` 行 → `album-images-deleted`；
3. 行没增删、只改列（目前只有 `order`）→ `album-images-change`。

隐藏画册（`HIDDEN_ALBUM_ID`）、收藏画册（`FAVORITE_ALBUM_ID`）是普通的 `album_images` 行，归类口径与其它画册相同。

## 现状速览

- 唯一的发送函数是 `kabegame-core/src/storage/image_events.rs:65-100` 的私有 `emit_album_images_change(reason, album_id, image_ids, ancestor_paths)`：
  - `image_ids` 为空且 `reason != "order"` 时不发（`:71`）；`debug_assert` 限定七种 reason（`:74-77`）。
  - payload `AlbumImagesChangePayload { seq, reason, albumIds: [album_id], imageIds, ancestorPath }`（`:18-26`），**恒为单画册**；`ancestorPath` 取自调用方传入的 map，缺失时退回 `"/<album_id>/"`（`:86-89`）。
  - `seq` 来自 `next_change_seq()`（与图片事件共用一个计数器，`emitter.rs:35`）。
  - 经 `dispatch_view_event` → `EventBroadcaster` 广播 `AppEvent::AlbumImagesChange`（`:91-98`；枚举 `ipc/events.rs:257-266`，事件名注册 `:80/:117/:149/:484`）。
  - 返回 `Some(payload)` 给调用方，用于命令返回值里的 `albumChanges`（`commands/album.rs:169`、`commands/image.rs:170/177`）；前端类型保留了 `albumChanges`（`services/albums.ts:53/58`），但规则写明不再消费（`.cursor/rules/view-mutation.mdc`）。
- 四个公开入口（都在 `image_events.rs`）：
  - `emit_membership_added(album_id, changed)`（`:152-192`）：写库**后**调用 `collect_album_memberships_with_paths(changed)`（`:159-160`，一条按 `image_id` 的查询，`storage/albums.rs:329-365`）拿到写后成员对与各画册 `ancestor_path`。目标是 HIDDEN 时：HIDDEN 发 `add-hidden`，图片所在的**每个其它画册（含收藏画册）**各发 `hide`（`:162-177`）；否则按「图片写后是否在 HIDDEN」拆成 `add` / `add-hidden`（`:178-190`）。
  - `emit_membership_removed(album_id, changed, pairs_before, ancestor_paths, context)`（`:195-241`）：`pairs_before` 由调用方在写库前收集。`AlbumMutation` 且目标是 HIDDEN 时：HIDDEN 发 `delete-hidden`，其它每个画册各发 `unhide`（`:206-226`）；其余情况按删前隐藏状态拆成 `delete` / `delete-hidden`（`:227-239`）。`ImagesDeleted` 上下文从不发 `unhide`，HIDDEN 自己也落入 `delete-hidden`。
  - `emit_album_images_order_changed(album_id, image_ids)`（`:244-257`）：现查 `get_album_by_id` 取 `ancestor_path`，发 `order`。
  - `toggle_image_favorite_with_event`（`:347-368`）：收藏走 `emit_membership_added(FAVORITE)`，取消收藏走 `emit_membership_removed(FAVORITE, AlbumMutation)`。
- 非 `ipc-server` 构建：`next_change_seq()` 恒为 0（`emitter.rs:46`），`try_global()` 恒为 `Some`（`emitter.rs:510`），`emit_album_images_change` 仍组装并返回 payload，只是不广播。`apply_label_assignments` 在非 `ipc-server` 下直接跳过 `emit_membership_added`（`storage/albums.rs:804-810`），避免那次成员查询。实际上 `kabegame` 与 `kabegame-cli` 都启用了 `ipc-server`（`kabegame/Cargo.toml:43/52`、`kabegame-cli/Cargo.toml:17`），非 ipc-server 只在 core 单独编译 / 单测时出现。
- `album_images` 表没有外键与触发器（`storage/migrations/init.rs:141-149`，`rg "create trigger"` 无结果），删图片、删画册时的成员行全靠代码显式 DELETE。
- 七种 reason 的发送点分布：`add` / `add-hidden` 只出自 `emit_membership_added`；`delete` / `delete-hidden` 只出自 `emit_membership_removed`；`hide` 只出自 `:173`；`unhide` 只出自 `:222`；`order` 只出自 `:254`（被 M9、M25 共用）。

---

## 场景表

> 「建议归属」按「`album_images` 真正 INSERT → `album-images-added`；真正 DELETE → `album-images-deleted`；只改列 → `album-images-change`；本画册行没变 → 不发」机械归类。`hide` / `unhide` 的去向单独在下一节说明。

| 编号 | 场景 | 位置 | 对 album_images 做了什么 | 现在发什么 | 单张/批量 | 建议归属 | 备注 |
|---|---|---|---|---|---|---|---|
| M1 | 用户把图片加入普通 / 标签叶子画册 | `kabegame-core/src/commands/album.rs:130-139` → `storage/image_events.rs:317-325` → `storage/albums.rs:1017-1083`（INSERT OR IGNORE 于 `:1060`）；入口 Tauri `kabegame/src/commands/album.rs:61`、Web `kabegame/src/web/dispatch.rs:1259` | 逐张 INSERT 目标画册行，`order` 接在当前最大值后（`:1048-1061`）；只把 `n>0` 的 id 记入 `inserted_ids`（`:1062-1066`） | 目标画册：可见图 `add`、已隐藏图 `add-hidden`（各一条，空则不发） | 批量 | `album-images-added` | 标签目录（`label_dir`）直接报错（`:1036-1038`）。 |
| M2 | 任务全部图片加入画册 | `commands/album.rs:141-157`（取图 `:143`，`add_images_to_album_with_event` 于 `:153`）；入口 Tauri `commands/album.rs:69`、Web `dispatch.rs:1283` | 同 M1 | 同 M1 | 批量（整个任务） | `album-images-added` | |
| M3 | 隐藏：加入隐藏画册 | 同 M1 入口，目标为 HIDDEN（前端 `composables/useImageOperations.ts:249`）→ `image_events.rs:162-177` | **只 INSERT HIDDEN 行**；其它画册的行不变 | HIDDEN：`add-hidden`；图片所在的每个其它画册（含收藏画册）：`hide`（按画册拆分，`imageIds` 只含属于该画册的） | 批量 | HIDDEN → `album-images-added`；`hide` → 本画册行没变，不发（信息并入 HIDDEN 事件，见下节） | 前端 `isHidden` 补丁只看 HIDDEN 的 `add-hidden`（`services/kbEvents/imagePatches.ts:28-36`）。 |
| M4 | MCP `add_images_to_album`（可附带 `image_orders`） | `kabegame/src/mcp_server.rs:1165-1209`（写库 `:1183-1185`，改序 `:1186-1195`，发事件 `:1197-1203`） | INSERT（同 M1，直接调 Storage，不经 `add_images_to_album_with_event`）；可选 UPDATE `order` | 同 M1；目标为 HIDDEN 时同 M3 | 批量 | `album-images-added` | `image_orders` 里**原本就在画册中**的 id 只 UPDATE `order`、不发 `order`（列入 MN5）。 |
| M5 | 收藏 | `storage/image_events.rs:347-357` → `storage/images.rs:1328-1336`；入口 Tauri `kabegame/src/commands/image.rs:100`、Web `dispatch.rs:912`、IPC `kabegame/src/ipc/handlers/storage/images.rs:77-78`（均经 `commands/image.rs:133-142` 或直接调 `toggle_image_favorite_with_event`） | INSERT OR IGNORE 收藏画册行，`order` = 当前 Unix 秒（`images.rs:1334`） | 收藏画册：图片未隐藏发 `add`，已隐藏发 `add-hidden` | 单张（前端批量收藏是逐张调用，`useImageOperations.ts:274-281`） | `album-images-added` | 重复收藏 INSERT 0 行时不发（`image_events.rs:352-354`）。 |
| M6 | 取消收藏 | `image_events.rs:348-366` → `images.rs:1337-1341` | DELETE 收藏画册行 | 收藏画册：`delete` / `delete-hidden`（`pairs_before` 只在取消收藏时收集，`:348-351`） | 单张 | `album-images-deleted` | |
| M7 | 用户从普通画册移除（含画册页上划移除） | `commands/album.rs:159-171` → `image_events.rs:328-344` → `storage/albums.rs:1090-1116`（DELETE 于 `:1104`）；入口 Tauri `commands/album.rs:75`、Web `dispatch.rs:1307` | 逐张 DELETE 目标画册行，只记 `changed>0` 的 id | 目标画册：`delete` / `delete-hidden`（按删前隐藏状态） | 批量 | `album-images-deleted` | `pairs_before` 在写前收集（`image_events.rs:333-334`）。 |
| M8 | 取消隐藏：移出隐藏画册 | 同 M7 入口，目标为 HIDDEN → `image_events.rs:206-226` | **只 DELETE HIDDEN 行** | HIDDEN：`delete-hidden`；图片所在的每个其它画册（含收藏）：`unhide` | 批量 | HIDDEN → `album-images-deleted`；`unhide` → 不发（并入 HIDDEN 事件） | `unhide` 的成员与祖先路径来自写前的 `pairs_before` / `ancestor_paths`，无额外查询。 |
| M9 | 画册内拖动排序 | `commands/album.rs:173-184` → `storage/albums.rs:1207-1227`（UPDATE 于 `:1219`），发事件 `image_events.rs:244-257`；入口 Tauri `kabegame/src/commands/album.rs:89`、Web `dispatch.rs:1331` | UPDATE `order` | 目标画册：`order`，`imageIds` = **请求里的全部 id**（`commands/album.rs:178-182`，不管 UPDATE 是否命中） | 批量 | `album-images-change` | 唯一一个真正的「只改列」场景。 |
| M10 | 下载新图入库后加入输出画册 | `kabegame-core/src/crawler/downloader/mod.rs:1476-1485`（`add_images_to_album_silent` + `emit_membership_added` 于 `:1481`） | INSERT 输出画册行 | 输出画册：`add`（新图不可能已隐藏） | 单张 | `album-images-added` | 在 `images-added`（`:1474`）之后发。后端不校验输出画册是否为 HIDDEN（前端选择器排除了它：`components/crawler/CrawlerTaskForm.vue:21`、`scheduler/AutoConfigDialog.vue:76`、`LocalImportDialog.vue:17`、`WebpageCollectDialog.vue:37`）；若为 HIDDEN 会走 M3 分支。 |
| M11 | 下载哈希去重命中，旧图加入输出画册 | `crawler/downloader/mod.rs:999-1009`（发事件 `:1005`） | INSERT（若旧图尚不在该画册） | 输出画册：`add` / `add-hidden`（旧图可能已隐藏） | 单张 | `album-images-added` | |
| M12 | 下载路径去重命中，旧图加入输出画册 | `crawler/downloader/mod.rs:1171-1182`（`:1178`） | 同 M11 | 同 M11 | 单张 | `album-images-added` | |
| M13 | 队列 URL 去重命中，旧图加入输出画册 | `crawler/downloader/queue.rs:1055-1068`（`:1063`） | 同 M11 | 同 M11 | 单张 | `album-images-added` | |
| M14 | 下载给图片挂插件标签（新图与三种去重命中） | `crawler/downloader/mod.rs:104-146`（`apply_download_labels`）→ `storage/albums.rs:649-657` → `apply_label_assignments`（`:667-813`；INSERT…SELECT…RETURNING 于 `:765-773`，发事件 `:798-812`）；调用 `mod.rs:1012/1187/1487`、`queue.rs:1077` | 一条 SQL 把「叶子 × 图片」INSERT OR IGNORE，`RETURNING` 带回真正新增的行 | 先给新建的标签画册发 `album-added`（`:792-796`），再按叶子逐个 `emit_membership_added` → `add` / `add-hidden` | 单张图 × 多个叶子（每叶子一条） | `album-images-added` | 去重命中时受 `dedup_update_metadata` 门控（`mod.rs:148-`）。`emit_membership_added` 在事务提交后执行，内部再查一次成员（每叶子一次 `collect_album_memberships_with_paths`）。 |
| M15 | 插件 metadata 迁移挂标签 | `kabegame-core/src/plugin/metadata_migration.rs:456` → 同 M14 的 `apply_label_assignments` | 同 M14 | 同 M14（按叶子发，`imageIds` 可能很多） | 批量（一批迁移行涉及的全部图片） | `album-images-added` | `self.touched`（`:465-466`）收集了画册 id 但 `run_metadata_migrations_for_plugin` 丢弃不用（`:225`）。 |
| M16 | 本地文件夹同步：路径已入库的文件链回同步画册 | `kabegame-core/src/local_folder/sync.rs:293-301` | INSERT（silent） | 同步画册：`add` / `add-hidden` | 单张 | `album-images-added` | |
| M17 | 本地文件夹导入新文件并加入画册 | `local_folder/import.rs:121-136`（`add_images_to_album` `:123`，携带旧序时 UPDATE `order` `:124-126`，发事件 `:135`） | INSERT；重导入（M24）时紧接着 UPDATE `order` | `images-added` 之后发 `add` | 单张 | `album-images-added` | UPDATE `order` 发生在事件之前，属于新行的最终状态，由 added 一并覆盖。 |
| M18 | 本地文件夹导入：路径已入库，链回画册 | `local_folder/import.rs:40-50` | INSERT（silent），携带旧序时 UPDATE `order` | `added>0` 时发 `add` / `add-hidden` | 单张 | `album-images-added` | `added==0` 但携带旧序时只 UPDATE 不发（MN6，调用方注释说明重导入已先删旧行，理论上不会出现）。 |
| M19 | 本地文件夹同步：文件仍在但不再属于该目录 → 移出同步画册 | `local_folder/sync.rs:355-366` | DELETE 同步画册行 | 同步画册：`delete` / `delete-hidden`（`AlbumMutation`） | 批量 | `album-images-deleted` | 同步画册不可能是 HIDDEN，不会产生 `unhide`。 |
| M20 | 用户删除 / 移除图片（单张与批量） | `kabegame-core/src/commands/image.rs:154-177` → `storage/image_events.rs:272-304`（`begin_delete_images_with_events`）；DELETE `album_images WHERE image_id = ?` 于 `storage/images.rs:1191`（`batch_delete_images`）/`:1302`（`batch_remove_images`）；入口 Tauri `kabegame/src/commands/image.rs:80-96`、IPC `ipc/handlers/storage/images.rs:49-72`、Web `dispatch.rs:1038/1058/1078/1098` | 随图片行一起 DELETE 该图的**全部**成员行 | 先 `images-deleted`（`image_events.rs:288`），再按删前成员逐画册 `delete` / `delete-hidden`（`ImagesDeleted`，`:290-299`）；HIDDEN 发 `delete-hidden`、收藏画册按隐藏状态发 `delete` / `delete-hidden` | 批量 | `album-images-deleted`（每个原属画册一条） | 与 M8 的 HIDDEN 事件同为 `delete-hidden`，**仅凭 HIDDEN 这一条分不出是取消隐藏还是删图**（M8 会另发 `unhide`，M20 不会）。 |
| M21 | 整理：去重 / 清除失效 / 清除不识别格式 | `kabegame-core/src/storage/organize.rs:663-667` | 同 M20（`delete_files=false`） | 同 M20 | 批量 | `album-images-deleted` | |
| M22 | 清空隐藏画册 | `kabegame-core/src/storage/hidden_cleanup.rs:174-191` | 同 M20（`delete_files=true`），每批 `CLEANUP_BATCH_SIZE` | 同 M20；每批的 HIDDEN `delete-hidden` 驱动页头隐藏计数 | 批量 | `album-images-deleted` | 这批图全部在 HIDDEN，其它画册收到的都是 `delete-hidden`。 |
| M23 | 本地文件夹同步：源文件已消失 → 删行 | `local_folder/sync.rs:368`（全量）、`:638`（diff） | 同 M20 | 同 M20 | 批量 | `album-images-deleted` | |
| M24 | 本地文件夹同步：已有文件哈希变化 → 删旧行再重导入 | `local_folder/sync.rs:306-329` | 旧图全部成员行 DELETE；新图只 INSERT 同步画册一行（沿用旧 `order`） | 先 M20 的整套删除事件，再 M17 的 `add` | 单张 | `album-images-deleted` + `album-images-added` | 旧图在其它画册里的成员关系丢失（id 变了，见 Phase A 的 Q7）。 |
| M25 | 删除画册（含整棵子树） | `kabegame-core/src/storage/albums.rs:858-899`（DELETE 成员 `:868-876`，删画册 `:888`，发事件 `:890-897`）；入口 `commands/album.rs:44-54`（Tauri `kabegame/src/commands/album.rs:37`、Web `dispatch.rs:893`）、IPC `ipc/handlers/storage/albums.rs:48-54` | 一条递归 CTE DELETE 子树内所有画册的全部成员行；子画册行靠 `parent_id ON DELETE CASCADE` 删除（`init.rs:118`） | `album-deleted`（只发被删的根，`:891`），再给子树**每个**画册（BFS，含根，`:1160-1172`）发一条 `imageIds` 为空的 `order`（`:892-894`） | 批量（子树全部成员） | `album-images-deleted`（`imageIds` 未知，需约定「空 = 通配」或另行收集，见 MQ7） | `order` 在画册删除后才查 `get_album_by_id`，必然查不到，`ancestorPath` 全部退回 `"/<id>/"`（`image_events.rs:248-253` + `:86-89`），对嵌套子画册是错的路径。BFS 时 `get_albums` 已经拿到每个子画册的 `ancestor_path`（`albums.rs:1166`），只是没保留。 |

**合计**：发事件的场景 25 个。按建议归属：`album-images-added` 14 个（M1–M5、M10–M18），`album-images-deleted` 9 个（M6–M8、M19–M23、M25），`album-images-change` 1 个（M9），M24 为 deleted + added 组合。另有 `hide`（M3、M4 的 HIDDEN 分支）与 `unhide`（M8）两类派生事件按机械归类不再发。

---

## hide / unhide、add-hidden / delete-hidden、order 在新分类下的去向

### 1. `hide` / `unhide`：本画册行没变，按机械归类不发

`hide` / `unhide` 发给「图片所在的其它画册」，这些画册的 `album_images` 行一行都没变；真正变的只有 HIDDEN 的一行。现在它们承担了两个职责：

- **告诉观察方「哪些画册的 `hide/` 计数变了」**：图片在哪些画册、这些画册的 `ancestorPath`。
- **画册页（hide 开启）据此刷新**：`components/imageGrid/adapters/album.ts:89` 对本画册任何成员事件都刷新；画册树 extra（`components/albums/AlbumTreeView.vue:180-201`）按 `ancestorPath` 刷新带 `hide/` 前缀的计数。

这些信息后端在发 HIDDEN 事件时**已经在手**：

- 加入 HIDDEN：`emit_membership_added` 写后查到的 `pairs` 与 `ancestor_paths`（`image_events.rs:159-160`）；
- 移出 HIDDEN：调用方写前收集的 `pairs_before` 与 `ancestor_paths`（`image_events.rs:333-334`）。

所以「由隐藏画册自身的 added / deleted 代替」不需要新增 SQL：在 HIDDEN 的 added / deleted 上附带图片所属的其它画册即可（例如 `memberships: [{ albumId, ancestorPath, imageIds }]`，形状待定，见 MQ1）。观察方由「本画册收到 hide 事件」改成「HIDDEN 事件的成员表里有本画册 / 本目录的后代」。

谁在依赖 `hide` / `unhide`（改掉后要改写）：

| 依赖方 | 位置 | 现在怎么用 | 改成 |
|---|---|---|---|
| 画册页网格 | `adapters/album.ts:88-89` | 本画册任何 reason 都刷新（hide 关也刷新） | hide 开：HIDDEN 事件成员表含本画册才刷新；hide 关：不刷新，只由 `imagePatches$` 打灰 |
| 画册树 extra | `AlbumTreeView.vue:180-201`（成员事件在 `:200`） | 按事件 `ancestorPath` 刷新，不看 reason、不看前缀 | 带 `hide/` 前缀时用 HIDDEN 事件成员表里的各 `ancestorPath` 判断；不带前缀时 HIDDEN 事件只影响系统区 |
| 画册页头计数 | `composables/useAlbumQuery.ts:59-65` | `albumIds` 含本画册或 `ancestorPath` 在子树下就刷新（计数路径 `images://gallery/album-tree/<id>`，`services/albums.ts:211-218`，**不带 `hide/`**） | 计数与隐藏无关，`hide` / `unhide` 消失后自然不再误刷 |
| 标签面板 | `components/image/ImageLabelsPanel.vue:167` | `imageIds` 含当前图就重读标签 | 消失后不再因隐藏而重读 |
| 预览弹窗 | `components/common/ImagePreviewDialog.vue:883` | `imageIds` 含当前图就重解析 | HIDDEN 事件本身也含该 id，行为不变 |
| 虚拟盘（Windows） | `kabegame/src/vd_listener.rs:60-67` | 对每个 `albumIds` 调 `notify_album_dir_changed` | 虚拟盘每个目录都把隐藏图标成隐藏文件（`virtual_driver/semantics.rs:229/248/346`），隐藏变化确实会改画册目录内容；需改成遍历 HIDDEN 事件成员表 |
| 后端单测 | `storage/image_events.rs:375-392`、`:496-518` | 断言拆分与 reason | 重写 |

### 2. `add-hidden` / `delete-hidden`：在普通画册上是「这批图当前是否已隐藏」的标记

- **HIDDEN 自己的事件**恒为 `add-hidden` / `delete-hidden`（`image_events.rs:164/208`，以及 `ImagesDeleted` 下 `split_by_hidden` 必然全归隐藏），这时 reason 和 `albumIds` 携带的信息重复，拆成 added / deleted 后可以直接丢掉 `-hidden` 后缀。
- **普通画册 / 收藏画册上的 `add-hidden` / `delete-hidden`** 表示「加入 / 移出的这几张图本来就是隐藏的」，这是 album_images 之外的派生信息。现在的依赖方：

| 依赖方 | 位置 | 依赖什么 |
|---|---|---|
| `reduceHiddenChanges` | `services/kbEvents/imagePatches.ts:28-36` | 只看 HIDDEN 的 `add-hidden`→`isHidden: true`、`delete-hidden`→`false`。改成 HIDDEN 的 added / deleted 即可，**不依赖普通画册上的拆分** |
| `reduceFavoriteChanges` | `imagePatches.ts:39-52` | `add`/`add-hidden` 都映射成 `favorite: true`，`delete`/`delete-hidden` 都映射成 `false`。**不依赖拆分** |
| phaseE 计划的 `membershipAffects` | `.claude/plans/filter-walk/phaseE.md` 点 1 | 用拆分让带 `hide/` 的路径跳过「已隐藏图的增删」（例：hide 开的画册页把一张已隐藏的图加进来，网格 0 次） |
| 前端测试 | `services/kbEvents/kbEvents.test.ts:141-201`、`components/imageGrid/adapters/imageEvents.test.ts:94` | 构造 reason |
| 后端测试 | `image_events.rs:375-392`、`:503/:517` | 断言拆分 |

结论：**现有代码不依赖普通画册上的拆分**，只有 phaseE 计划里的优化用到它。拆分不需要额外 SQL（写后 / 写前成员对里就有 HIDDEN 行，`image_events.rs:113-128`）。保留的方式有两种：继续一条事件拆成两条（added 与「added 且已隐藏」），或在一条 added / deleted 里附带 `hiddenImageIds` 子集。见 MQ2。

### 3. `order`：M9 归 `album-images-change`；M25 的空 `order` 其实是成员删除

M9 是唯一真正的「只改列」，直接归 `album-images-change`。依赖方：画册页网格（任何事件都刷新，`album.ts:89`）、虚拟盘画册目录（`vd_listener.rs:60-67`）、标签面板（`imageIds` 含当前图）、预览弹窗（同上）；phaseE 计划只在 `by-album-order` 排序下刷新。

M25 删画册补发的空 `order` 用途：`delete_album` 一条 SQL 删光子树全部成员行（`albums.rs:868-876`），但不为每个成员发 `delete`，而 `album-deleted` 只给被删的根发一次（`:891`）。空 `order` 是「这个画册的成员全没了」的替代信号，靠的是各观察方「空 `imageIds` 当通配」或「只看 `albumIds`」：

| 依赖方 | 位置 | 靠它做什么 |
|---|---|---|
| 画廊（no-album） | `adapters/gallery.ts:52` | 被删画册的成员可能变成「无画册」，需重读（gallery 不听 `album-deleted`） |
| 标签面板 | `ImageLabelsPanel.vue:167` | `!imageIds.length` → 重读。删一个标签目录时，目录下的标签叶子不会各自收到 `album-deleted`，只能靠每个子画册一条空 `order`（`:168-169` 的 `album-deleted` 只匹配已挂标签的 id） |
| 画册树 extra（分区根） | `AlbumTreeView.vue:180-201`（成员事件在 `:200`） | 分区根 `path()` 为 null，任何事件都重读计数 |
| 页头计数 | `useAlbumQuery.ts:59-65` | 当前画册自身被删时 `albumIds` 命中（随后详情读空回落）；子孙被删由 `album-deleted` 负责，空 `order` 的错误 `ancestorPath` 匹配不到 |
| 画册页网格 | `album.ts:89` | 当前画册被删时命中 |
| 侧栏 | `galleryFilterTree/facetTreeSource.ts:402` | 画册敏感上下文下任何成员事件都重读 |
| 虚拟盘 | `vd_listener.rs:60-67` | 逐个通知子树画册目录 |

按机械归类 M25 是 DELETE → `album-images-deleted`。`imageIds` 若要填实需在删除前多查一次子树成员（可能很大），若不填则要约定「deleted 的空 `imageIds` = 该画册全部成员（通配）」。`ancestorPath` 可以零成本修正为真实路径（BFS 已拿到）。见 MQ7。

---

## 各场景现状代码

### M1 / M2 / M4 / M10–M18 加入画册：统一经 `emit_membership_added`
```rust
// kabegame-core/src/storage/image_events.rs:152-191
pub fn emit_membership_added(album_id: &str, changed: &[String]) -> Result<Vec<AlbumImagesChangePayload>, String> {
    if changed.is_empty() { return Ok(Vec::new()); }
    // 现状：写后再查一次成员对（一条按 image_id 的查询），用于判断是否已隐藏、取祖先路径
    let (pairs, ancestor_paths) = Storage::global().collect_album_memberships_with_paths(changed)?;
    let mut out = Vec::new();
    if album_id == HIDDEN_ALBUM_ID {
        // 现状（M3）：HIDDEN 发 add-hidden……
        if let Some(payload) = emit_album_images_change("add-hidden", album_id, changed, &ancestor_paths) { out.push(payload); }
        for (affected_album, ids) in grouped_memberships(&pairs) {
            if affected_album == HIDDEN_ALBUM_ID { continue; }
            // ……图片所在的每个其它画册（含收藏画册）各发一条 hide；这些画册的行没变
            if let Some(payload) = emit_album_images_change("hide", &affected_album, &ids, &ancestor_paths) { out.push(payload); }
        }
    } else {
        // 现状：按「写后是否在 HIDDEN」拆成 add / add-hidden 两条
        let (hidden_ids, visible_ids) = split_by_hidden(changed, &pairs);
        if let Some(payload) = emit_album_images_change("add", album_id, &visible_ids, &ancestor_paths) { out.push(payload); }
        if let Some(payload) = emit_album_images_change("add-hidden", album_id, &hidden_ids, &ancestor_paths) { out.push(payload); }
    }
    Ok(out)
}
```
```rust
// kabegame-core/src/crawler/downloader/mod.rs:1476-1485（M10；M11 :999-1009、M12 :1171-1182、M13 queue.rs:1055-1068 同形）
if let Some(album_id) = output_album_id {
    if !album_id.trim().is_empty() {
        let added = Storage::global().add_images_to_album_silent(album_id, &[image_id.clone()]);
        if added > 0 {
            // 现状：不校验 album_id 是否为 HIDDEN；失败只打日志
            if let Err(error) = emit_membership_added(album_id, &ids) { eprintln!("[album-event] 发射下载成员事件失败: {error}"); }
        }
    }
}
```

### M5 / M6 收藏
```rust
// kabegame-core/src/storage/image_events.rs:347-367
pub fn toggle_image_favorite_with_event(image_id: &str, favorite: bool) -> Result<(), String> {
    // 现状：只在取消收藏时收集写前成员，用于 delete / delete-hidden 拆分
    let (pairs_before, ancestor_paths) = (!favorite)
        .then(|| Storage::global().collect_album_memberships_with_paths(&[image_id.to_string()]))
        .transpose()?.unwrap_or_default();
    if !Storage::global().toggle_image_favorite(image_id, favorite)? { return Ok(()); } // 现状：没变就不发
    let changed = vec![image_id.to_string()];
    if favorite { emit_membership_added(FAVORITE_ALBUM_ID, &changed)?; }        // 现状：add / add-hidden
    else { emit_membership_removed(FAVORITE_ALBUM_ID, &changed, &pairs_before, &ancestor_paths,
                                   MembershipRemovalContext::AlbumMutation); } // 现状：delete / delete-hidden
    Ok(())
}
```

### M7 / M8 / M19 移出画册与 M20–M23 删图：统一经 `emit_membership_removed`
```rust
// kabegame-core/src/storage/image_events.rs:206-239
if context == MembershipRemovalContext::AlbumMutation && album_id == HIDDEN_ALBUM_ID {
    // 现状（M8）：HIDDEN 发 delete-hidden，其它每个画册各发 unhide（成员取自写前 pairs_before）
    emit_album_images_change("delete-hidden", album_id, changed, ancestor_paths);
    for (affected_album, ids) in grouped_memberships(pairs_before) { /* … */ emit_album_images_change("unhide", &affected_album, &affected, ancestor_paths); }
} else {
    // 现状（M6 / M7 / M19 / M20–M23）：按删前隐藏状态拆成 delete / delete-hidden；
    // ImagesDeleted 下 HIDDEN 自身也走这里，同样得到 delete-hidden
    let (hidden_ids, visible_ids) = split_by_hidden(changed, pairs_before);
    emit_album_images_change("delete", album_id, &visible_ids, ancestor_paths);
    emit_album_images_change("delete-hidden", album_id, &hidden_ids, ancestor_paths);
}
```
```rust
// kabegame-core/src/storage/image_events.rs:277-299（M20–M23 的统一出口）
let (pairs_before, ancestor_paths) = storage.collect_album_memberships_with_paths(image_ids)?; // 现状：删前收集全部成员
// … batch_delete_images / batch_remove_images 内逐张 DELETE FROM album_images WHERE image_id = ?（images.rs:1191 / :1302）
GlobalEmitter::global().emit_images_deleted(image_ids);       // 现状：先发图片删除
for (album_id, changed) in grouped_memberships(&pairs_before) {
    album_changes.extend(emit_membership_removed(&album_id, &changed, &pairs_before, &ancestor_paths,
        MembershipRemovalContext::ImagesDeleted));             // 现状：再逐画册发 delete / delete-hidden，不发 unhide
}
```

### M9 排序
```rust
// kabegame-core/src/commands/album.rs:173-183
pub fn update_album_images_order(album_id: String, image_orders: Vec<(String, i64)>) -> Result<Value, String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)?; // 现状：逐条 UPDATE "order"
    let image_ids: Vec<String> = image_orders.into_iter().map(|(image_id, _)| image_id).collect();
    emit_album_images_order_changed(&album_id, &image_ids);                  // 现状：带请求里的全部 id
    Ok(Value::Null)
}
```

### M14 / M15 挂标签
```rust
// kabegame-core/src/storage/albums.rs:792-811
if let Some(emitter) = GlobalEmitter::try_global() {
    for album in &created { emitter.emit_album_added(album); }  // 现状：新建标签画册先发 album-added
}
for leaf_id in leaf_ids.into_iter().flatten() {
    let Some(image_ids) = inserted.get(&leaf_id) else { continue; }; // 现状：只对 RETURNING 带回的真实新增发
    // …
    #[cfg(feature = "ipc-server")]
    if GlobalEmitter::try_global().is_some() {
        emit_membership_added(&leaf_id, image_ids)?;           // 现状：每叶子一条，内部再查一次成员；事务已提交，Err 只会让调用方打日志
    }
}
```

### M25 删除画册
```rust
// kabegame-core/src/storage/albums.rs:866-897
let subtree_ids = self.collect_subtree_album_ids_bfs(album_id)?;   // 现状：BFS 只留 id，丢掉了各子画册的 ancestor_path
conn.execute("WITH RECURSIVE sub(id) AS (…) DELETE FROM album_images WHERE album_id IN (SELECT id FROM sub)", …)?; // 现状：一次删光子树成员
// … UPDATE run_configs …；DELETE FROM albums（子画册经 parent_id ON DELETE CASCADE）
if let Some(emitter) = GlobalEmitter::try_global() {
    emitter.emit_album_deleted(&deleted_album);                     // 现状：只发根
    for id in subtree_ids {
        emit_album_images_order_changed(&id, &[]);                  // 现状：空 order 当「成员全没了」；此时画册已删，ancestorPath 退回 "/<id>/"
    }
}
```

---

## 改了 album_images 却没发成员事件的路径

| 编号 | 位置 | 改了什么 | 现状 | 建议归属 / 备注 |
|---|---|---|---|---|
| MN1 | `kabegame/src/ipc/handlers/storage/albums.rs:71-79`（IPC `StorageAddImagesToAlbum`，分发 `ipc/handlers/storage/mod.rs:50-53`） | INSERT | 直接调 `Storage::add_images_to_album`，**不发事件、不做 `ensure_album_is_writable`** | `album-images-added`。仓库内无调用方（`ipc/client/client.rs:234` 定义未被使用），对外部 IPC 集成开放。 |
| MN2 | 同文件 `:81-90`（`StorageRemoveImagesFromAlbum`） | DELETE | 不发、不校验可写 | `album-images-deleted`；无仓库内调用方（`client.rs:246`）。 |
| MN3 | 同文件 `:112-121`（`StorageUpdateAlbumImagesOrder`） | UPDATE `order` | 不发 | `album-images-change`；无仓库内调用方（`client.rs:276`）。 |
| MN4 | `kabegame/src/mcp_server.rs:1117-1148`（MCP `set_album_images_order`） | UPDATE `order` | 不发 | `album-images-change`。工具说明里写「打开画册切到加入顺序」，但已打开的画册页不会自动刷新。 |
| MN5 | `mcp_server.rs:1186-1195`（MCP `add_images_to_album` 的 `image_orders`） | UPDATE `order`（对原本就在画册里的 id） | 只对新插入的 id 发 `add`，改序部分不发 | `album-images-change`。 |
| MN6 | `local_folder/import.rs:44-46` | `added==0` 时仍 UPDATE `order` | 不发 | `album-images-change`；按调用方注释理论上不出现。 |
| MN7 | `storage/migrations/v015_unique_local_path_and_sync_folder.rs:17-35` | 启动迁移时 DELETE / INSERT OR IGNORE | 不发（启动期） | 不发。 |
| MN8 | `storage/images.rs:982`（`delete_image`）、`:1076`（`remove_image`） | DELETE | 不发 | 死代码（同上文 N3）。 |

（另：IPC `StorageDeleteAlbum`（`ipc/handlers/storage/albums.rs:48-54`）直接调 `Storage::delete_album`，事件照发，但跳过了 core 命令里的轮播画册清空与虚拟盘 `bump_albums`（`commands/album.rs:46-53`），与成员事件无关，记录备查。`storage/albums.rs:2733`、`tests/*.rs`、`local_folder/tests.rs` 中的写入均为测试。）

---

## 订阅方

### 后端与外部集成

| 订阅方 | 位置 | 读了什么 | 刷新条件 / 改语义后注意 |
|---|---|---|---|
| 事件种类注册 | `kabegame-core/src/ipc/events.rs:68-89`（`app_event_kinds!`）、`:117`、`:149`、`:257-266`、`:484` | — | 新增三种事件需在这五处登记，否则 `ALL` 订阅（事件循环、SSE、IPC）收不到。 |
| 虚拟盘监听（仅 Windows，`core_init.rs:113-119` 启动） | `kabegame/src/vd_listener.rs:31`、`:60-67` | 只读 `album_ids` | 对每个画册 `notify_album_dir_changed`，再 `notify_gallery_tree_changed`；不看 reason / imageIds。改名后要订三种新事件；`hide` / `unhide` 去掉后需从 HIDDEN 事件的成员表取画册（隐藏图在虚拟盘里是隐藏属性文件）。 |
| 事件循环 → Tauri / SSE | `kabegame/src/startup.rs:431-458` | 整份透传 | 自动跟随新种类。 |
| app IPC 订阅 | `kabegame-core/src/ipc/server/subscription_manager.rs:42-` | 按 kind 透传 | CLI 不订（`kabegame-cli/src/backend.rs:205-206`）。 |
| VS Code 扩展（外部仓库） | `/Users/didi/Code/vscode-kabegame-background-cover/src/KabegameIpcClient.ts:69-77`、`:339-342` | 按事件名 `album-images-change` 订阅，不读字段，收到即 `_onImagesChange.fire()` | 改名后收不到 added / deleted（同理它也还订着旧的 `images-change`，没订 Phase A 新增的 `images-added` / `images-deleted`）。 |
| 命令返回值 `albumChanges` | `commands/album.rs:150/169`、`commands/image.rs:170/177`、`AddToAlbumResult`（`storage/albums.rs:76-84`） | payload 副本 | 前端不消费（`services/albums.ts:53/58` 只留类型）；payload 改形时一并调整或删除。 |
| 后端单测 | `storage/image_events.rs:375-392`、`:496-518` | reason | 重写。 |

### 前端（`apps/kabegame/src`）

载荷类型 `services/kbEvents/events.ts:16-23`；`isHiddenAlbumChange` 只看 `albumIds` 含 HIDDEN（`events.ts:114-116`）。

| 文件 | 订阅 | 读了哪些字段 | 刷新 / 补丁条件 |
|---|---|---|---|
| `services/kbEvents/imagePatches.ts:28-36`（`reduceHiddenChanges`） | `album-images-change`，经 `imagePatches$` 且 `patchHidden()` 为真（`:61-64`） | `albumIds`、`reason`、`imageIds` | HIDDEN 的 `add-hidden` → `isHidden: true`，`delete-hidden` → `false`；只补丁、不请求。M20 删图时也会给已删的图打 `false`（无害）。 |
| `imagePatches.ts:39-52`（`reduceFavoriteChanges`） | 同上（不受 `patchHidden` 门控，`:60`） | 同上 | 收藏画册的 `add` / `add-hidden` → `favorite: true`，`delete` / `delete-hidden` → `false`。 |
| `components/ImageGrid.vue:555-558` | `imagePatches$(…, { patchHidden: () => !adapter.viewState().hide })` | 补丁 | hide 关才打 `isHidden`；hide 开靠成员事件刷新剔除。 |
| `components/common/ImagePreviewDialog.vue:870-875` | `imagePatches$(…, { patchHidden: () => true })` | 补丁 | 预览对象始终打补丁。 |
| `ImagePreviewDialog.vue:883` | `album-images-change` | `imageIds` | 含当前 id 就重解析（注释：收藏 / 隐藏会影响 `isHidden`，补丁之外仍要重拉，`:882`）。 |
| `services/kbEvents/imageViewRelevance.ts:140-142`（`hiddenTrigger`） | `album-images-change` | `albumIds` | `view().hide && 含 HIDDEN`；被 `adapters/gallery.ts:51`、`adapters/task.ts:38`、`adapters/surf.ts:36`、`galleryFilterTree/facetTreeSource.ts:401` 使用。行与总数共用（ImageGrid 把 `adapter.refreshOn` 同时给两者，`ImageGrid.vue:431-437`）。 |
| `components/imageGrid/adapters/gallery.ts:52` | `album-images-change` | 不读字段 | `routeStore.effectiveNoAlbum` 为真就刷新（不看 reason、不看画册）。 |
| `components/imageGrid/adapters/album.ts:88-89` | `album-images-change` | `albumIds` | 含当前画册就刷新行与总数，不看 reason（hide / unhide / order / add-hidden 都会触发）。 |
| `components/imageGrid/adapters/task.ts`、`surf.ts` | 只有 `hiddenTrigger` | — | **不听普通成员事件**；但任务 / 畅游路由同样会叠加全局 no-album（`stores/taskDetailRoute.ts:60-66`、`stores/surfImagesRoute.ts:53-56`，`effectiveNoAlbum` 见 `stores/pathRoute.ts:237/363`），no-album 下加入画册 / 收藏不会刷新——现状缺口，见 MQ9。 |
| `composables/useAlbumQuery.ts:59-65` | `album-images-change` | `albumIds`、`ancestorPath` | 含当前画册，或事件 `ancestorPath` 以当前画册路径开头（子孙）就重读计数（`album-tree/<id>`，不带 `hide/`；标签目录时计数路径是 `albums://parent/<id>`，与成员无关也会被触发，`services/albums.ts:211-218`）。 |
| `components/albums/AlbumTreeView.vue:180-201` | `album-images-change`（只给 extra） | `ancestorPath` | `albumEventAffectsDir`：分区根 `path()` 为 null，任何事件都重读该分区本页计数；子目录只匹配严格后代。系统区计数路径 HIDDEN 不带前缀、收藏带 `prefix`（`:160-165`）；普通分区 `~~/images[/hide]`（`services/albums.ts:174-179`）。 |
| `components/galleryFilterTree/facetTreeSource.ts:402` | `album-images-change` | 不读字段 | `hasAlbumSensitiveContext()`（上下文路径含 `album` / `album-tree` / `no-album` / `hide`，`:120-123`）就刷新；`deltaMode` 时不订（`:396`）。 |
| `components/image/ImageLabelsPanel.vue:167` | `album-images-change` | `imageIds` | 空 `imageIds`（M25 的空 `order`）或含当前图就重读标签；不看画册类型，收藏 / 隐藏也会触发。 |
| `header/comps/HiddenCleanupControl.vue:34` | `album-images-change` | `albumIds` | 含 HIDDEN 就重读隐藏画册直接图片数。 |
| `composables/useSurfImageCounts.ts:40` | `album-images-change` | `albumIds` | 全局 hide 开且含 HIDDEN 就重读各站点计数。 |
| `composables/useImageOperations.ts:264-290` | 不订阅 | — | 收藏成功后本地 `ctx.patch(favorite)`；隐藏走 `ctx.mutate`（`:249`）。 |
| 测试 | `services/kbEvents/kbEvents.test.ts`、`components/imageGrid/adapters/imageEvents.test.ts`、`components/galleryFilterTree/facetTreeSource.test.ts`、`header/comps/HiddenCleanupControl.test.ts`、`components/common/ImagePreviewDialog.events.test.ts`、`components/tree/useTreeModel.test.ts`、`composables/useSurfImageCounts.test.ts`、`composables/useAlbumQuery.test.ts` | 构造 reason / 事件名 | 随语义一起改。 |
| 文档 | `AGENTS.md`、`.cursor/rules/view-mutation.mdc`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`（「七种 reason」）、`cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`、`cocs/downloader-tasks/DOWNLOADER_FLOW.md`、`cocs/crawler/METADATA_MIGRATION.md`、`cocs/provider-dsl/RULES.md`、`apps/docs/src/content/docs/reference/mcp.md:374` | 事件名 / reason | 需同步。 |

---

## 任务二：画廊对收藏 / 隐藏的过滤能收紧到什么程度

### A. 收藏：哪些视图依赖收藏

收藏只出现在三处查询里：

- 收藏画册本身：`images://gallery/[hide/]album/<FAV>` 与 `album-tree/<FAV>`（成员关系就是收藏）。
- 无画册过滤：`kabegame-core/src/providers/dsl/images/gallery/gallery_no_album_router.json5:7`
  `is_favorite or NOT EXISTS (SELECT 1 FROM album_images nai WHERE nai.image_id = images.id AND nai.album_id <> hidden)`。
  收藏会直接改变结果集：收藏一张已在普通画册里的图会让它**进入**无画册；取消收藏一张在普通画册里的图会让它**离开**；不在任何其它画册的「散图」收藏与否都在结果里。
- `is_favorite` 字段本身（`gallery_route.json5:61-63`、`vd/vd_root_router.json5:19`）只是展示列，不参与过滤或排序（排序字段 `utils/galleryPath.ts:47` 没有收藏；`GalleryQuery` 也没有收藏原子，`utils/galleryQuery.ts:53-70`）。

逐个观察方：

| 观察方 | 依赖收藏？ | 现状 | 新分类下（收藏 = 收藏画册的 added / deleted） |
|---|---|---|---|
| 画廊（不开 no-album、不用标签搜索） | 否 | 只补丁（`gallery.ts:52` 门控在 no-album）✓ | 只补丁，不变 |
| 画廊 no-album | **是** | 任何成员事件都刷新 | 必须刷新；若收藏事件附带图片的其它成员（写前 / 写后成员对已在手，`image_events.rs:159-160`、`:348-351`），可以判断：图片有其它非隐藏画册时才会进出无画册，散图收藏只需补丁。见 MQ5 |
| 画册页（非收藏画册） | 否 | 只补丁（`album.ts:89` 只认本画册）✓ | 不变 |
| 收藏画册页 | **是**（数据源） | 刷新 | 必须刷新（本画册 added / deleted） |
| 任务 / 畅游网格 | 只在 no-album 下 | 只补丁（但 no-album 缺口，见 MQ9） | 只补丁；no-album 下应同画廊 no-album |
| 画册页头计数 | 只在当前画册是收藏画册时 | `albumIds` 命中才刷新 ✓ | 不变 |
| 画册树 extra | 只有系统区（收藏计数） | 分区根对任何成员事件都刷新，所以收藏会重读 normal / label / local_folder 每个分区（phaseE 点 4 处理） | 只有系统区刷新 |
| 侧栏 `facetTreeSource` | 上下文是 `album/<FAV>`、`album-tree/<FAV>` 或 `no-album` 时 | `album` / `album-tree` / `no-album` / `hide` 任一出现就刷新 | 可按上下文里的画册 id 收紧：上下文画册不是收藏、且没有 no-album 时只补丁（仅 `hide` 时同理） |
| 预览弹窗 | 否（补丁已覆盖 `favorite`） | 含当前 id 就重解析（`ImagePreviewDialog.vue:883`） | 可只补丁，见 MQ6 |
| 标签面板 | 否 | 含当前 id 就重读标签 | 可按 `albumIds` 排除收藏 / 隐藏两个常量 id，见 MQ6 |
| 虚拟盘 | 是（收藏目录） | 通知收藏目录 | 不变 |

结论：「收藏在画廊不发请求、只打补丁」**现状已基本做到**（画廊、非收藏画册页、任务 / 畅游都已只补丁，`imagePatches.ts:39-52` 负责 `favorite`）。剩下必须刷新的只有收藏画册页、no-album 视图、系统区计数和以收藏 / no-album 为上下文的侧栏；可再收紧的是预览、标签面板、侧栏和画册树分区根。

### B. 隐藏（hide 开启的视图）

#### B1. 图片加入隐藏画册（HIDDEN 的 added）：行只在命中已持有行时刷新

- **行**：hide 开时被隐藏的图只可能从当前结果集里消失。不在当前持有行里，当前页的行就不会变（页外的图消失会让后续页前移，但当前页的行组成不变——这与 `deletedTrigger(heldIds)` 的已有口径一致，`imageViewRelevance.ts:128-138`、`ImageGrid.vue:430-431`）。可行做法与删除相同：把 `hiddenTrigger` 从 adapter 的 `refreshOn` 里拿出，由 ImageGrid 为行追加「HIDDEN added 且命中持有行」、为总数追加另一条（见下）。不需要 ImageInfo，也不需要后端改动。
- **总数**：页外的图被隐藏同样会改变总数，前端不知道它是否匹配当前查询。可选方案：

| 方案 | 做法 | 额外 SQL | 代价 / 收益 |
|---|---|---|---|
| H1（最简单） | 总数对任何 HIDDEN added 都刷新；画册页总数用 HIDDEN 事件附带的成员表判断「是否本画册成员」 | 无（成员表来自写后成员对，`image_events.rs:159-160`） | 每个 500ms 窗口最多 1 次 COUNT。新加入 HIDDEN 的图在此之前一定没隐藏（只对真实 INSERT 发），所以对**无过滤画廊** `hide/all` 这次计数一定会变，并不浪费；只有带查询 / 任务 / 畅游过滤、且被隐藏的图与之无关时才是多读。 |
| H2 | HIDDEN added 也携带 `ImageInfo[]`，总数按 `imageMayMatchQuery` + 归属（taskId / surfRecordId / 成员表）判断 | 需要一次按 id 批量读图片行（同 B2 的读法） | 能省掉带过滤视图的那次 COUNT；代价是隐藏写路径多一次查询、payload 随批量隐藏线性增长（例如整个任务加入 HIDDEN），还要维护两份判断。 |
| H3 | 前端本地减总数 | — | 违反「不本地增减 total」（`view-mutation.mdc`），排除。 |

按「宁愿多请求、不搞复杂化、判断不了就刷新」，倾向 H1（行收紧、总数保守，画册页用成员表免费收紧）。从同一网格发起的隐藏本来就经 `ctx.mutate` 主动请求了行与总数（`useImageOperations.ts:249`、`ImageGrid.vue:514-518`），事件窗口随后可能再读一次，这是现有通用行为，不因本次改动变化。

#### B2. 图片移出隐藏画册（HIDDEN 的 deleted）：按视图条件判断是否会出现

前端手里没有这些图（hide 开时它们不在行里），payload 只有 id，所以现在只能一律刷新。要做到「会出现才刷新」需要两类信息：

1. **图片字段**（用于 `imageMayMatchQuery`，以及任务 / 畅游的归属判断）：`pluginId`、`type`、`crawledAt`、`size`、`width` / `height`、`taskId`、`surfRecordId`，全部是 `images` 表列。
2. **成员关系**（用于画册页「是否本画册成员」、画册树的 `hide/` 计数、no-album 判断）：写前成员对 `pairs_before` 与 `ancestor_paths`，`remove_images_from_album_with_event` 已经查过（`image_events.rs:333-334`），**零额外 SQL**。

后端能否零成本拿到图片行：**不能**。移出路径（`image_events.rs:328-344` → `storage/albums.rs:1090-1116`）只碰 `album_images`；`collect_album_memberships_with_paths`（`albums.rs:329-365`）只读 `album_images` + `albums`；现成的取行函数 `find_image_by_id`（`storage/images.rs:361-368`）一次一张，经 provider `images://gallery/by_id/<id>`，没有批量版本。可选：

| 方案 | 做法 | 额外 SQL | 说明 |
|---|---|---|---|
| U1 | HIDDEN deleted（仅 `AlbumMutation` 上下文）携带 `images: ImageInfo[]` + 成员表 | 一次新写的批量查询，例如 `SELECT … FROM images WHERE id IN (SELECT value FROM json_each(?))`（PK 探测） | 前端直接复用 `imageMayMatchQuery`（`imageViewRelevance.ts:59-90`）与 `addedTrigger` 的写法：画廊 → 匹配查询且（no-album 时）按成员表判断；任务 → `image.taskId`；畅游 → `image.surfRecordId`；画册页 → 成员表含本画册且匹配查询；画册树 `hide/` 计数 → 成员表的 `ancestorPath`；侧栏 → 按上下文查询判断（上下文无法解析时仍刷新）；`useSurfImageCounts` → `surfRecordId`。需给批量设上限，超过时省略 `images`、前端按「判断不了」刷新。 |
| U2 | 只携带成员表，不带图片行 | 无 | 画册页、画册树、no-album 判断可以收紧；画廊（有查询时）/ 任务 / 畅游 / 侧栏仍一律刷新。 |
| U3 | 不改 | 无 | 现状：hide 开的视图对任何取消隐藏都刷新。 |

不建议扩展 `collect_album_memberships_with_paths` 顺带读图片列：它被加画册、删图、取消收藏等所有路径共用（`image_events.rs:159/277/333/349`），会让所有调用方都变重。

**必须区分「取消隐藏」与「删图」**：M20–M23 删图时 HIDDEN 同样发 `delete-hidden`（新分类下同为 HIDDEN 的 deleted），图片已不存在，不应走「会不会出现」的判断。现在只能靠 M8 额外的 `unhide` 间接区分。新事件需要显式标记（例如删图上下文的 deleted 带 `imagesDeleted: true`，或删图上下文不带 `images` 且约定此时不按出现判断），见 MQ4。删图本身已有 `images-deleted` 驱动行（命中持有行）与总数刷新，HIDDEN 的 deleted 对 hide 开的视图是多余信号，只对隐藏计数（`HiddenCleanupControl.vue:34`、系统区）有用。

#### B3. hide 关闭的视图

`imagePatches$` 的 `patchHidden` 门控（`ImageGrid.vue:557`、预览恒真 `ImagePreviewDialog.vue:870`）只需把 `reduceHiddenChanges` 的判断从「HIDDEN 的 `add-hidden` / `delete-hidden`」改成「HIDDEN 的 added / deleted」，语义不变。hide 关的画册页现在会因 `hide` / `unhide` 刷新（`album.ts:89`）；`hide` / `unhide` 不再发后，这次刷新自然消失，只剩打灰补丁。

### C. 对 phaseE 计划（`.claude/plans/filter-walk/phaseE.md`）的影响

phaseE 的前提是「**不改后端事件**，所有判断都只用 payload 已有的字段（reason、…）」，核心是七种 reason 的 `membershipAffects(payload, hide)`。新分类改了后端事件，phaseE 需要排在后端拆分之后，或直接基于新事件重写。逐点：

- **点 1 `membershipAffects`**：整体改写。`add` / `delete` 分支变成 added / deleted 事件本身；`add-hidden` / `delete-hidden` 分支取决于 MQ2（保留则改成读 `hiddenImageIds` 子集，删掉则 hide 开的路径对「加入已隐藏的图」也会刷新）；`hide` / `unhide` 分支删除，改成「HIDDEN 事件的成员表」判断；`order` 分支删除（`album-images-change` 是独立事件，不再需要在成员判断里排除）；「隐藏画册本身的事件一律相关」改成 B1 / B2 的专门触发。`labelSearchTriggers` 只需把事件名换成 added / deleted。`albumChangeKinds.moved` 不受影响。
- **点 2 画册页网格**：`membershipAffects(payload, pathHidesHidden())` 拆成三条：本画册 added / deleted；本画册 `album-images-change` 且 `by-album-order`；hide 开时 HIDDEN added（行看持有、总数看成员表）/ deleted（成员表含本画册，U1 时再加查询匹配）。`deletesViaMembership` 仍然成立（M20–M23 对每个原属画册都发 deleted）。`pathHidesHidden` 的隐藏画册页赦免保留。
- **点 3 页头**：计数路径不带 `hide/`，`membershipAffects(p, false)` 简化为「自身或子孙的 added / deleted」，`hide` / `unhide` / `order` 都不会再到达，判断可删。详情部分不变。
- **点 4 画册树**：extra 的成员判断改为 added / deleted；带 `hide/` 前缀时要额外订 HIDDEN 事件并用成员表里的各 `ancestorPath` 判断目录（现在用的是事件自身的 `ancestorPath`，而 HIDDEN 的是 `/HIDDEN/`）；分区根 `inBranch` 同样要用成员表的路径。
- **点 5 画廊与侧栏**：`membershipAffects(payload, routeStore.hide)` 改成 no-album 下听 added / deleted（含收藏，MQ5 可再收紧）。phaseE 新增的 `on("album-deleted", noAlbum)` 是因为 `order` 被排除而补的；若 M25 改为发 deleted，这条可删（也可保留作冗余），见 MQ7。侧栏 `hasAlbumSensitiveContext` 去掉 `hide` 的改动仍成立。
- **点 6 测试**：「七种 reason 在 hide 开 / 关下的取值」整组测试删掉，改测新事件与成员表；验证表中「画册页 hide 开，把一张已隐藏的图加进本画册：网格 0 次」依赖 MQ2；「hide 开，隐藏本画册一张图：网格行与总数各 1 次」在 H1 下仍是各 1 次（行命中持有，总数成员表命中）。
- **已知边界「order 也会重读总数」**：`album-images-change` 独立后仍共用 adapter `refreshOn`，结论不变。
- **任务 / 畅游的 no-album 缺口（MQ9）** phaseE 没覆盖，可一并补上。

---

## 疑点（留给用户判断）

- **MQ1 HIDDEN 事件附带成员表的形状**：`memberships: [{ albumId, ancestorPath, imageIds }]`（按画册分组，与现在 `hide` / `unhide` 一一对应）还是按图片给 `albumIds`？前者便于画册树按路径判断，后者便于 no-album 判断。成员表是否包含收藏画册（现在 `hide` 会发给收藏画册）。
- **MQ2 普通画册上的「已隐藏」标记是否保留**：现有代码不依赖（`imagePatches.ts` 两个 reducer 都只看画册 id），只有 phaseE 的「hide 开时跳过已隐藏图的增删」用到。保留则以 `hiddenImageIds` 子集或拆成两条事件；删掉则 hide 开的画册页 / 画册树对这类增删多刷一次。
- **MQ3 隐藏后总数的处理**：H1（总数对任何隐藏都刷新，画册页用成员表收紧）还是 H2（隐藏也带 ImageInfo，多一次查询）。
- **MQ4 取消隐藏是否携带 ImageInfo（U1 / U2 / U3）**，以及如何区分「取消隐藏」与「删图」造成的 HIDDEN deleted；U1 的批量上限取多少（参考 MCP 分页护栏 500）。
- **MQ5 收藏事件是否也附带成员表**：可以让画廊 no-album 对「散图」收藏只补丁；同理普通画册的 added / deleted 带成员表后 no-album 也能判断「是否离开 / 进入无画册」。是否值得。
- **MQ6 预览弹窗与标签面板的收紧**：预览对收藏 / 隐藏只靠补丁、不再重解析（`ImagePreviewDialog.vue:882-883` 的注释说补丁之外仍要重拉，需确认原因是否还成立）；标签面板按 `albumIds` 排除收藏 / 隐藏。
- **MQ7 删除画册的成员删除（M25）**：改发 `album-images-deleted` 时 `imageIds` 填实（删除前多查一次子树成员，可能很大）还是约定「空 = 该画册全部成员」；`ancestorPath` 是否顺带改为 BFS 已拿到的真实路径（零成本）；子树每个画册各发一条还是合并。phaseE 的 `album-deleted` 补丁是否保留。
- **MQ8 不发事件的写入口（MN1–MN6）**：IPC 的加 / 移 / 排序三个处理器既不发事件也不校验可写（无仓库内调用方）；MCP `set_album_images_order` 与 `add_images_to_album` 的改序不发事件。是否补发，还是让 IPC 处理器改走 core 命令。
- **MQ9 任务 / 畅游视图的 no-album 缺口**：任务、畅游路由会叠加全局 no-album（`taskDetailRoute.ts:60-66`、`surfImagesRoute.ts:53-56`），但 adapter 不听任何普通成员事件（`task.ts:35-39`、`surf.ts:33-37`），加入画册 / 收藏后不刷新。`ImageViewState` 也没有 noAlbum 字段。
- **MQ10 no-album 的收藏语义**：`gallery_no_album_router.json5:4` 的 note 写「Favorite-only images are intentionally included」，但 SQL `is_favorite or NOT EXISTS(...)` 会放行**所有**收藏图（包括同时在普通画册里的）。若本意是只放行「只在收藏里」的图，收藏变化对 no-album 的影响面会不同。
- **MQ11 M9 排序事件的 `imageIds`** 是请求里的全部 id（`commands/album.rs:178-182`），不是 UPDATE 实际命中的；新 `album-images-change` 是否改为实际命中。
- **MQ12 下载输出画册为 HIDDEN**：后端不校验（`mod.rs:1476-1485`、`queue.rs:1055-1068`），只有前端选择器排除；CLI / 外部入口指定 HIDDEN 时会走 M3 分支。是否在后端拒绝。
- **MQ13 外部集成兼容**：VS Code 扩展按事件名订阅 `album-images-change`（以及旧的 `images-change`），改名后需同步更新；Phase A 新增的 `images-added` / `images-deleted` 它也还没订。
