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

## 疑点（留给用户判断）

- **Q1 单图 / 批量边界不稳定**：
  - S2 / S11 只挂一张图，但按哈希共享会连带同哈希的 0..N 张；S11 从用户视角是「看一张图」。
  - S21 / S22 是批量命令，但上下文菜单隐藏单张最常见；S3 / S16–S20 恒为单张；S10 / S12 / S13 恒为批量。
  - 是按「调用签名能否多张」归类（本文做法），还是按「这次实际几张」在运行时选事件？
- **Q2 `delete_task` / `clear_finished_tasks` 的空 `imageIds` change 给谁用**：images 表没变。现在的实际受众是任务详情网格（`task.ts:34-38` 的 `taskIds` 过滤）和 Windows 虚拟盘任务目录（`vd_listener.rs:42-49`）。另外 gallery / album / facet / 预览因 `!!reason` 也会跟着刷新。改为 `tasks-change` 驱动，还是保留某种 images 级信号？
- **Q3 删除畅游记录在 0 张图时也发空 `imageIds` 的 change**（`surf_records.rs:519` 无空保护）：S13 是否要和 Q2 一起处理？
- **Q4「补丁里带上新的 id」指哪个 id**：有两个元数据外键——`metadataId`（插件 metadata，S3 / S12，行按 id 不可变，内容一变 id 必变）与 `imageMetadataId`（原生元数据，S2 / S10 / S11，按哈希共享）。两者现在都已作为补丁字段带新值；是否还需要别的（如旧 id，用于前端清旧缓存）？
- **Q5 `images-added` 的载荷粒度**：只给 id，还是带每张图的 `taskId` / `surfRecordId` / `pluginId` / `crawledAt` / `mediaType`？任务网格、畅游网格和虚拟盘都依赖 task / surf 维度。另外畅游导入时 `pluginIds=[host]` 而库里 `plugin_id` 为 NULL（S1 备注），是否顺带纠正。
- **Q6 `images-deleted` 的 id 来源**：现在发的是**请求的** id（`image_events.rs:313`），不是实际删除的；也不带 `surfRecordIds` / `pluginIds`。是否改为实际删除结果、是否补齐维度。
- **Q7 本地文件夹哈希变化重导入（S5）**：语义上是「同一文件内容变了」，实现上是删旧行 + 插新行（新 id）。按目标语义它就是 deleted + added；前端预览/选择会丢失旧 id，这是否可接受。
- **Q8 S1 的事件顺序**：同哈希旧图的原生元数据补丁（S2）先于新图 add 发出；新图自己的 `imageMetadataId` 没有任何补丁（N4）；画册成员事件晚于 add。新 `images-added` 是否要把新图的字段一次带全。
- **Q9 隐藏是否算 images 字段变化（S21 / S22）**：`isHidden` 来自 `album_images`，images 行未变；`album-images-change` 已有 `add-hidden` / `hide` / `unhide` / `delete-hidden`。改语义后是否继续发 `images-change` 批量补丁，还是只留 `album-images-change` 并由前端推出 `isHidden`（类似收藏 N6 的做法）？
- **Q10 单图 `image-changed` 不再补发 `images-change` 后的重查缺口**：`displayName`（S16）、`lastSetWallpaperAt`（S17–S20）、`metadataId`（S3，影响插件 metadata 搜索）、`surfRecordId`（S13）、`imageMetadataId`（S2 / S11，影响 `search/native-metadata`）都可能影响排序或过滤结果集。现在靠成对的 `images-change` 让网格对账；改后单图变化要由前端自己按字段判断是否重查，还是这些场景仍走批量 `images-change`？
- **Q11 S12 的载荷体量**：插件 metadata 迁移可能一次改该插件全部图片，现在 `image-changed` 按 metadataId 分组压缩，`images-change` 带全量 `imageIds`。改成「每张图一条补丁」后体量可能很大，是否需要保留分组形式或分批发送。
- **Q12 S10 整理在取消时的补发**（`organize.rs:712/786/898`）与每批末尾（`:979`）各发一次，一次整理会发多条批量事件；是否需要合并。
- **Q13 Web SSE 不做 CDN 路径改写**：补丁里的 `thumbnailPath` / `compatiblePath` 在 Web release 下是服务器本地路径（现状已如此，新载荷会延续）。
- **Q14 `pluginIds` 去留**：后端多处费力组装（S1 / S3 / S4 / S12 / S18–S20），但前端与后端均无消费者。
- **Q15 虚拟盘监听只在 Windows 启用**（`core_init.rs:113`）：macOS / Linux 的 FUSE 挂载没有对应的事件监听。改语义时是否一并考虑。
