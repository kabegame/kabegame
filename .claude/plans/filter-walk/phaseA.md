# 过滤走查 Phase A：图片事件协议拆成增 / 删 / 补丁

> 场景清单见 [zoucha.md](zoucha.md)（S1–S22）。后续：
> [phaseB.md](phaseB.md) 前端按事件内容收紧刷新、[phaseC.md](phaseC.md) 整理改游标双层循环、
> [phaseD.md](phaseD.md) 插件 metadata 迁移改游标双层循环。

### 总体设计思路

现在的 `images-change` 一个事件承担三种语义：`reason=add` 是新图入库，`reason=delete` 是删行，
`reason=change` 是字段变化；而字段变化又总是和 `image-changed` 成对发送。本阶段只做**协议拆分**：把事件按
「表里真正发生了什么」拆成四个，让每个事件自带足够信息；前端各消费方机械迁移到新事件，**刷新行为与现在基本等价**，
按内容收紧留给 Phase B。

拆分后的四个事件：`images-added` 表示图片行真正插入，带新图的 `ImageInfo` 列表（Phase B 据此判断新图会不会
落进视图，任务 / 畅游视图直接看行里的 `taskId` / `surfRecordId`）；`images-deleted` 表示图片行真正删除，只带 id；
字段变化统一成「按图片的补丁」`{ id, ...字段 }`，一次只改一张图发 `image-changed`，改多张发 `images-change`
（补丁列表），二者形状一致，区分只看**属性发生变化的图片数量**，由后端一个发送函数按数量分流。插件 metadata 与
原生元数据都按普通属性处理，补丁里带新的 `metadataId` / `imageMetadataId`，不带旧 id。`reason` 随拆分整体移除。

两类不属于 images 表的信号同时移走。`isHidden` 来自隐藏画册的成员关系，后端不再为它发图片补丁，前端从
`album-images-change`（隐藏画册的 `add-hidden` / `delete-hidden`）推导补丁；本阶段各视图对隐藏画册成员变化照旧刷新，
「只在 hide 开启时刷新、开启时不打补丁」留给 Phase B。删除任务不改 images 表，去掉它附带的空 change，任务详情页
发现任务被删后自己返回或回到画廊。

整理与 metadata 迁移在本阶段只换发送函数（批量补丁走 `emit_image_patches`），循环结构不动，分别在 Phase C / D 重构。

### 现状锚点

**a. 事件定义**（`src-tauri/kabegame-core/src/ipc/events.rs:231`）
```rust
/// `images` 表增删改（reason: `add` | `delete` | `change`）
ImagesChange {
    seq: u64,
    reason: String,                       // 现状：一个事件三种语义
    image_ids: Vec<String>,
    task_ids: Option<Vec<String>>,
    surf_record_ids: Option<Vec<String>>,
    plugin_ids: Option<Vec<String>>,      // 现状：前后端都没人读；畅游导入时还填成 host
},

/// `ImageInfo` 字段增量更新；`diff` 是 camelCase 绝对值快照。
ImageChanged { seq: u64, patches: Vec<ImagePatch> }, // 现状：ImagePatch { image_ids, diff }，一组图共享一份 diff
```

**b. 字段变化成对发送**（`storage/image_events.rs:138`）
```rust
pub fn emit_native_metadata_attached(image_id: &str, metadata_id: i64) {
    if let Some(emitter) = GlobalEmitter::try_global() {
        let changed = vec![image_id.to_string()];
        emitter.emit_image_changed_uniform(&changed, json!({ "imageMetadataId": metadata_id }));
        emitter.emit_images_change("change", &changed, None, None, None); // 现状：补发粗信号
    }
}

fn emit_image_hidden_changed(changed: &[String], is_hidden: bool) {
    if let Some(emitter) = GlobalEmitter::try_global() {
        // 现状：isHidden 由隐藏画册成员推导，images 行没变，仍发两种图片事件
        emitter.emit_image_changed_uniform(changed, json!({ "isHidden": is_hidden }));
        emitter.emit_images_change("change", changed, None, None, None);
    }
}
```

**c. 新图入库**（`crawler/downloader/mod.rs:1480`，原生元数据已改为一图一行、持久化不再发事件）
```rust
let inserted = match Storage::global().add_image(image_info) {
    Ok(inserted) => {
        persist_native_metadata_best_effort(&inserted, bytes).await; // 现状：已不发事件
        ...
        // 现状：手上有完整的 inserted，事件里只带 id 与归属列表
        GlobalEmitter::global().emit_images_change(
            "add", &ids,
            task_opt.as_ref().map(|v| v.as_slice()),
            surf_opt.as_ref().map(|v| v.as_slice()),
            Some(&[plugin_id.to_string()]),
        );
```
本地导入（`local_folder/import.rs:119`）同样有 `let inserted = storage.add_image(image)?;`。

**d. 删除**（`storage/image_events.rs:297`）
```rust
pub fn begin_delete_images_with_events(image_ids: &[String], delete_files: bool) -> Result<PendingImageDelete, String> {
    let task_ids = storage.collect_task_ids_for_images(image_ids)?; // 现状：既用于任务计数事件，也塞进 images-change
    ...
    GlobalEmitter::global().emit_images_change("delete", image_ids, Some(&task_ids), None, None);
```

**e. 删除任务**（`commands/task.rs:503`、`:736`）
```rust
pub fn delete_task(task_id: String) -> Result<Value, String> {
    storage.delete_task(&task_id)?;                 // 只删 tasks / task_logs / task_failed_images，不动 images
    GlobalEmitter::global().emit_task_deleted(&task_id);
    // 现状：额外发一条 imageIds 为空的 change，只为让任务网格与虚拟盘任务目录刷新
    GlobalEmitter::global().emit_images_change("change", &[], Some(&[task_id]), None, None);
```

**f. 前端补丁流**（`apps/kabegame/src/services/kbEvents/imagePatches.ts`）
```ts
export function imagePatches$(waitMs: number): Observable<ImagePatchBatch> {
  return merge(
    // 现状：只听 image-changed；isHidden 也从这里来
    kbEvent$<ImageChangedPayload>("image-changed").pipe(batchWindow(waitMs, reduceImageChanged)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
  );
}
```

**g. 前端过滤器**（`components/imageGrid/adapters/*.ts`）
```ts
// 画廊：后端恒带 reason，等于任何 images-change 都刷新
on("images-change", (payload) => !!payload.reason),
// 任务 / 畅游：按 taskIds / surfRecordIds
on("images-change", (payload) => !!tid && !!payload.reason && (!Array.isArray(payload.taskIds) || payload.taskIds.includes(tid))),
// 画册：全库任何图片事件都刷新
on("images-change", (payload) => !!params.albumId() && !!payload.reason),
```

**h. 任务详情页**（`views/TaskDetail.vue:238`）
```ts
usePathqlLooker({
  kind: "rows",
  key: () => taskKey.value,
  refreshOn: [on("tasks-change", (payload) => /* TaskDeleted 且是本任务 */)],
  onResult: ({ rows }) => {
    task.value = normalizeTaskRow(rows[0]); // 现状：被删后只是变成空，页面停在原地
  },
});
```

### 场景归属（对应 zoucha.md）

| 场景 | 本阶段发什么 |
|---|---|
| S1 下载新图、S4 本地文件夹导入 | `images-added { images: [ImageInfo] }`（原生元数据持久化之后发，一次） |
| S3 去重重绑 | 补丁 `{ id, metadataId, pluginId?, postUrl? }` → `image-changed` |
| S5 本地文件内容变化重导入 | `images-deleted` + `images-added` |
| S6–S9 删除出口 | `images-deleted { imageIds }` |
| S10 整理补字段 | 整批补丁走 `emit_image_patches`（Phase C 改逐张） |
| S11 查看时挂原生元数据 | `{ id, imageMetadataId }` → `image-changed` |
| S12 插件 metadata 迁移 | 整轮末尾按图展开成 `{ id, metadataId }` 走 `emit_image_patches`（Phase D 改逐行） |
| S13 删畅游记录 | `{ id, surfRecordId: null }`，按张数分流；0 张不发 |
| S14 / S15 删任务、清已完成任务 | 不发图片事件 |
| S16 改名、S17–S20 设壁纸时间 | `image-changed` |
| S21 / S22 隐藏、取消隐藏 | 只发 `album-images-change` |

### 点 1 — 事件定义（`kabegame-core/src/ipc/events.rs`）

- **新增**
  - `ImageFieldPatch`：一张图的字段绝对值，序列化成 `{ "id": "323", "thumbnailPath": "..." }`。
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageFieldPatch {
    pub id: String,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>, // camelCase 字段名 → 绝对值
}
```
  - `AppEvent::ImagesAdded`、`AppEvent::ImagesDeleted`，并在 `AppEventKind`、事件名映射、名字解析、
    `kind()`、全量订阅清单五处登记（`images-added` / `images-deleted`）。
```rust
/// 图片行真正插入：带完整行
ImagesAdded {
    seq: u64,
    images: Vec<ImageInfo>, // 与 pathql 行同一套 camelCase 字段
},
/// 图片行真正删除：只带 id
ImagesDeleted {
    seq: u64,
    #[serde(rename = "imageIds")]
    image_ids: Vec<String>,
},
```
- **修改**
```rust
/// 多张图的字段变化（每张图一条补丁）
ImagesChange {
    seq: u64,
    patches: Vec<ImageFieldPatch>, // 修改：替代 reason / imageIds / taskIds / surfRecordIds / pluginIds
},
/// 单张图的字段变化
ImageChanged {
    seq: u64,
    patch: ImageFieldPatch,        // 修改：原为 patches: Vec<ImagePatch>
},
```
- **删除**
  - `ImagePatch { image_ids, diff }`。

### 点 2 — 发送函数（`kabegame-core/src/emitter.rs`）

- **新增**
```rust
/// 字段变化的唯一出口：先按 id 合并、丢掉没有字段的补丁，再按图片数量分流——1 张发 image-changed，多张发 images-change；空列表不发
pub fn emit_image_patches(&self, patches: Vec<ImageFieldPatch>) {
    let patches = merge_patches_by_id(patches);
    match patches.len() {
        0 => {}
        1 => dispatch_view_event(Arc::new(AppEvent::ImageChanged { seq: next_change_seq(), patch: patches.into_iter().next().unwrap() })),
        _ => dispatch_view_event(Arc::new(AppEvent::ImagesChange { seq: next_change_seq(), patches })),
    }
}

/// 一组图同一份字段：展开成逐图补丁后走 emit_image_patches
pub fn emit_image_fields(&self, image_ids: &[String], fields: serde_json::Value);

pub fn emit_images_added(&self, images: &[ImageInfo]);   // 空列表不发
pub fn emit_images_deleted(&self, image_ids: &[String]); // 空列表不发
```
- **删除**
  - `emit_images_change(reason, ...)`、`emit_image_changed(Vec<ImagePatch>)`、`emit_image_changed_uniform`，
    以及非 `ipc-server` 构建的同名空实现（换成新函数的空实现）。

### 点 3 — 各发送点改写

- **修改**
  - S1 下载器（`crawler/downloader/mod.rs:1489`）：`persist_native_metadata_best_effort` 改为返回挂上的 metadata id，
    写回 `inserted.image_metadata_id` 后发 `emit_images_added(std::slice::from_ref(&inserted))`。
  - S4 本地导入（`local_folder/import.rs:133`）：`emit_images_added(std::slice::from_ref(&inserted))`。
  - S3 去重重绑（`crawler/downloader/mod.rs:106`）：一条补丁交给 `emit_image_patches`，删掉成对的 `emit_images_change`。
  - S6–S9 删除出口（`storage/image_events.rs:313`）：`emit_images_deleted(image_ids)`。
    > 说明：带传入的 id 即可，不存在的 id 不会命中任何视图。`collect_task_ids_for_images` 仍保留给任务计数事件。
  - S10 整理（`storage/organize.rs:390`）：`changed_image_patches` 改为 `Vec<ImageFieldPatch>`，
    `emit_organize_images_change` 只调 `emit_image_patches`。
  - S11 原生元数据：`emit_image_fields(&[image_id], json!({ "imageMetadataId": metadata_id }))`。
  - S12 metadata 迁移（`plugin/metadata_migration.rs:243`、`MigrationRun::finish`）：`final_metadata` 直接展开成
    `{ id, metadataId }`，交给 `emit_image_patches`。
  - S13 删畅游记录（`storage/surf_records.rs:517`）：`emit_image_fields(&image_ids, json!({ "surfRecordId": null }))`。
  - S16 MCP 改名、S17–S20 设壁纸：`emit_image_fields(&ids, ...)`（`kabegame/src/mcp_server.rs:1221`、
    `ipc/handlers/settings.rs:340`、`wallpaper/rotator.rs:599`、`:894`、`commands/wallpaper.rs:96`）。
- **删除**
  - `emit_image_hidden_changed` 及其调用；测试 `hidden_field_change_emits_patch_before_view_invalidation` 改为断言只发 `album-images-change`。
  - S14 / S15 的空 change（`commands/task.rs:507`、`:744`）。

### 点 4 — 后端订阅方

- **修改**
  - `kabegame/src/vd_listener.rs`（仅 Windows 启用）：
```rust
let event_kinds = vec![
    AppEventKind::AlbumAdded, AppEventKind::AlbumChanged, AppEventKind::AlbumDeleted,
    AppEventKind::ImagesAdded,      // 新增
    AppEventKind::ImagesDeleted,    // 新增
    AppEventKind::ImagesChange,
    AppEventKind::ImageChanged,     // 新增：改名会改变虚拟盘里的文件名
    AppEventKind::AlbumImagesChange, AppEventKind::TasksChange,
];
match &*event {
    AppEvent::ImagesAdded { images, .. } => {
        for tid in images.iter().filter_map(|image| image.task_id.as_deref()) { // 修改：归属从行里取
            vd_service.notify_task_dir_changed(tid);
        }
        vd_service.notify_gallery_tree_changed();
    }
    // 删除不带任务归属：只刷新画廊树
    AppEvent::ImagesDeleted { .. } | AppEvent::ImagesChange { .. } | AppEvent::ImageChanged { .. } => {
        vd_service.notify_gallery_tree_changed();
    }
    AppEvent::TaskDeleted { .. } => vd_service.bump_tasks(), // 现状已有
    ...
}
```
  - `kabegame-cli/src/main.rs:1137` 注释里的 `images-change(add)` 改成 `images-added`。

### 点 5 — 前端事件类型与补丁流（`services/kbEvents/`）

- **修改**
  - `events.ts` 的 `KbEventMap`：
```ts
export type ImageFieldPatch = { id: string } & Partial<ImageInfo>;

export interface KbEventMap {
  ...
  "images-added": { seq: number; images: ImageInfo[] };          // 新增
  "images-deleted": { seq: number; imageIds: string[] };         // 新增
  "images-change": { seq: number; patches: ImageFieldPatch[] };  // 修改
  "image-changed": { seq: number; patch: ImageFieldPatch };       // 修改：单图
}
```
  - `imagePatches.ts`：同时听两种补丁事件，隐藏补丁从隐藏画册成员事件推导。
```ts
/** 一串补丁事件 → imageId → 合并后的字段；同一 id 后到的字段覆盖先到的 */
export function reducePatches(events: readonly KbEvent<ImagePatchPayload>[]): ImagePatchBatch | null;

/** 隐藏画册成员增删 → isHidden 补丁：add-hidden → true，delete-hidden → false */
export function reduceHiddenChanges(events: readonly KbEvent<AlbumImagesChangePayload>[]): ImagePatchBatch | null;

export function imagePatches$(waitMs: number): Observable<ImagePatchBatch> {
  return merge(
    merge(kbEvent$("image-changed"), kbEvent$("images-change")).pipe(batchWindow(waitMs, reducePatches)), // 修改
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceFavoriteChanges)),
    kbEvent$<AlbumImagesChangePayload>("album-images-change").pipe(batchWindow(waitMs, reduceHiddenChanges)), // 新增
  );
}
```
  - `isHiddenAlbumChange(payload)`：`albumIds` 含 `HIDDEN_ALBUM_ID` 的成员事件，供各消费方保持「隐藏 / 取消隐藏即刷新」。

### 点 6 — 前端消费方机械迁移（行为等价）

- **修改**
  - 四个 adapter 的 `refreshOn`：原 `images-change` 一条拆成四条，条件等价于现在。
```ts
// 画廊 / 画册：任何图片事件都刷新（与现在相同）
on("images-added"), on("images-deleted"), on("images-change"), on("image-changed"),
on("album-images-change", isHiddenAlbumChange), // 原来经 isHidden 的 change 触发
// 任务：新增看行里的 taskId；删除 / 补丁照常刷新（删除事件不再带 taskIds）
on("images-added", (p) => p.images.some((image) => image.taskId === tid())),
on("images-deleted"), on("images-change"), on("image-changed"),
on("album-images-change", isHiddenAlbumChange),
// 畅游：同上，看 surfRecordId
on("images-added", (p) => p.images.some((image) => image.surfRecordId === rid())),
...
```
  - `ImagePreviewDialog.vue`：`images-deleted` 含当前 id、`images-change` / `image-changed` 任一事件照旧重解析。
  - `facetTreeSource.ts`、`useSurfImageCounts.ts`、`HiddenCleanupControl.vue` 等其它订阅 `images-change` 的地方同样拆成四条。
  - `views/TaskDetail.vue`：任务行读回为空（被删）时离开页面。
```ts
onResult: ({ rows }) => {
  task.value = normalizeTaskRow(rows[0]);
  // 新增：任务被删——有历史就返回，否则回画廊
  if (!rows[0] && taskId.value) void (window.history.length > 1 ? router.back() : router.replace("/gallery"));
},
```
  - `types/image.ts`、`ImageGrid.vue` 注释同步。

### 点 7 — 测试、文档

- **测试**
  - Rust：`emit_image_patches` 分流（0 / 1 / 多张、同 id 合并、空字段丢弃）；`images-added` 序列化带完整 `ImageInfo`；
    删除只发 `images-deleted { imageIds }`；隐藏增删只发 `album-images-change`；删任务不发图片事件；新事件种类出现在全量订阅里。
  - 前端：`reducePatches` 吃两种事件、`reduceHiddenChanges`；更新 `kbEvents.test.ts`、`useSurfImageCounts.test.ts`、
    `facetTreeSource.test.ts`、`HiddenCleanupControl.test.ts` 等依赖旧载荷的用例；TaskDetail 被删离开。
- **文档**
  - `cocs/downloader-tasks/DOWNLOADER_FLOW.md`（事件一节）、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、
    `cocs/README.md`、`.cursor/rules/view-mutation.mdc`、`AGENTS.md`「ImageGrid 视图写操作」、
    `versions/latest/regression.md`、`changelog.md`。

### 验证

| 场景 | 预期事件 | 预期前端 |
|---|---|---|
| 下载一张新图 | `images-added`（行带 taskId、imageMetadataId） | 画廊、对应任务页刷新 |
| 删除图片 | `images-deleted { imageIds }` | 与现在一致 |
| 整理补缩略图 | `images-change { patches }` | 缩略图就地更新，视图照常刷新 |
| 壁纸轮播 / MCP 改名 / 查看详情挂原生元数据 | `image-changed { patch }` | 字段就地更新，视图照常刷新 |
| 隐藏 / 取消隐藏 | 只有 `album-images-change` | 图变灰 / 恢复，视图照常刷新 |
| 删除当前打开的任务 | `TaskDeleted`，无图片事件 | 任务详情页返回或回画廊 |
| Windows 虚拟盘浏览时下载 / 删除 | 新事件 | 画廊树刷新 |

### 已知边界

- **刷新次数本阶段不减少**：只改协议，收紧在 Phase B。
- **删除不再带任务归属**：任务视图对任何删除都刷新（现在是按 taskIds），Phase B 改为按包含判断；Windows 虚拟盘正在浏览的任务目录不会因删除立即更新。
- **metadata 迁移载荷**：整轮一次展开成逐图补丁，全量迁移时单条事件可能上万项，Phase D 改为逐行发送。
