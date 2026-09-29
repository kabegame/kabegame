# 前端数据变更聚合（eventWorker）与视图写操作规定

> 分期：**第一期只做 `images-change`**，以及 ImageGrid 自身的删除与收藏。`album-images-change` 与
> `album-added/changed/deleted` 牵涉 albums store（缓存失效、画册计数、树），风险更大，整体放到第二期
> （见文末「第二期（暂缓）」）。第一期不改 `stores/albums.ts`。

## 总体设计思路

ImageGrid 是用户的核心交互区，允许为它倾斜资源、做全量拉取。基于这一点，把 ImageGrid 的数据更新
拆成性质不同的两条通道，并让后端事件退回到「便宜、完整地告诉前端哪张表变了」。

**主动通道——用户在当前视图里发起的、会影响结果集的操作。** 写命令**携带当前视图查询**
`{ rows, count }`：后端写入并发出事件后，在同一次调用里按该查询读出最新视图，随结果返回；前端拿到后立刻
替换列表，不经过防抖。用户看到的是「操作完成即画面更新」，只需一次 IPC 往返。第一期只覆盖 images 表上的
操作（删除图片），画册类操作（隐藏/取消隐藏、加入/移出画册、上划移除）经 albums store 调用，放到第二期。

**被动通道——其他来源的变化**（下载、文件夹同步、整理、其他窗口、MCP）。前端新增全局单例
`dataChangeHub`，第一期只监听一次 `images-change`。每个订阅者按各自的时间窗把事件合并成一个
`ChangeBatch`（各字段取并集，仿 Rust 侧 `fs_listener` 的 `FsBatch.merge`），不再像现在的节流那样只保留
最后一次 payload；订阅者回调串行执行，上一次没跑完时新批次先暂存，跑完再补跑一次。其上的 `liveQuery`
以 `{ rows, count }` 为 key 接受注册：收到相关批次后并行拉取行数据与总数、丢弃过期结果，再把
`{ rows, total }` 推给注册者；相同 key 的多个注册者只拉一次。hub 的设计按「事件种类可扩展」来写，第二期
接入 `album-images-change` 等只需加 source，不改接口。

**两条通道靠单调递增的变更序号 `seq` 协调。** 后端 emitter 维护一个全局计数器，每发一次
`images-change` 或 `album-images-change` 就加一；第一期只把 `seq` 写进 `images-change` 的 payload
（`album-images-change` 的 payload 暂不动，避免触碰 store 的消费逻辑）。每次读视图时**先取当前 `seq`，
再执行 SQL**，结果带上这个 `seq`。因为写入总是先提交、后发事件，序号不超过 N 的事件对应的写入一定在读之前
已提交，读到的视图必然包含它；读完之后才发出的事件序号一定大于 N，会被当作新变化再拉一次——最坏多拉一次，
但不会漏。前端 `liveQuery` 记录「当前视图已反映到哪个 `seq`」，由此：
- 用户自己操作的回声事件已被返回的快照覆盖，hub 收到时直接跳过，不重复拉取；
- 操作前就发出的拉取若晚于操作结果返回，`seq` 更小，直接丢弃，不会把新列表覆盖回旧的。

`album-images-change` 虽然第一期不进 hub，计数器仍要随它递增：否则一次只产生 album 事件的操作（如隐藏）
前后，读到的 `seq` 相同，旧的在途拉取就无法被识别为过期。第一期 ImageGrid 对 `album-images-change` 仍用原
composable 做过滤和节流，但刷新动作改为调用 `liveQuery.refetch()`，从而也受 `seq` 守卫。

**收藏直接 patch。** 收藏只改 `favorite` 字段，不改变绝大多数视图的结果集，所以不携带视图查询：ImageGrid
自己发起的收藏在命令返回后就地改星标。别处来的收藏事件（`album-images-change` 的 FAVORITE）第一期沿用
gallery adapter 现有的就地 patch，第二期再并入 hub。唯一会因收藏改变结果集的是**收藏画册视图**：该视图不
提供右键「收藏/取消收藏」，只保留「从画册移除」。

**后端 `images-change` 瘦身与补漏。** 既然 ImageGrid 不再用 `imageIds` 与当前页求交集，`images-change`
里仅为填 payload 而产生额外查询的字段一律去掉（删图前逐张查 plugin/surf、删除任务前收集全部 image id、
设壁纸/MCP 改名前为拿 `plugin_id` 做的 `find_image_by_id`）；本来就在手边、不花钱的字段照留。同时补上
2 处「写了 images 表却不发事件」的路径（删除畅游记录、整理重建缩略图）。

**判定原则是宁可多拉。** adapter 只用免费维度（taskIds、surfRecordIds）做粗过滤；某个事件没带某维度，
该批在这个维度上视为「命中全部」。

**这条规定写进架构约束**：凡在 ImageGrid 里发起、可能影响视图结果集的写操作，必须经
`ctx.mutate(view => ...)` 调用带 `view` 参数的命令；只改展示字段的操作（目前只有收藏）走 `ctx.patch`；
禁止依赖事件回刷用户自己的操作。第一期落地删除；画册类操作在第二期迁入，迁入前作为已知例外记录在规则里。

**范围**：第一期迁移 ImageGrid 对 `images-change` 的处理。Surf.vue、GalleryToolbar、树刷新枢纽
（`useTreeRefreshHub`）、albums store 暂时沿用原监听——它们依赖的 `images-change` 字段在本次删除后要么仍在，
要么已有兜底分支（如 Surf.vue 在 `surfRecordIds` 为空时 `refreshAll`），行为不变。

---

## 现状锚点

### 事件清单（与三张表相关的 5 种；第一期只动第一行）

| 表 | 事件 | Payload | reason |
|---|---|---|---|
| `images` | `images-change` | `reason`, `imageIds`, 可选 `taskIds`/`surfRecordIds`/`pluginIds` | `add`/`delete`/`change`/`rename`/`metadata-migrate` |
| `album_images` | `album-images-change` | `reason`, `albumIds`, `imageIds`, `directCounts` | `add`/`delete` |
| `albums` | `album-added` | 完整画册行 | — |
| `albums` | `album-changed` | `albumId` + `changes`（增量字段） | — |
| `albums` | `album-deleted` | `albumId` | — |

定义见 `src-tauri/kabegame-core/src/ipc/events.rs:265-334`，发送入口见 `src-tauri/kabegame-core/src/emitter.rs:237-409`。

**`images-change` 发送点**

| reason | 场景 | 位置 | 附带信息 |
|---|---|---|---|
| `add` | 下载新图入库（每张一次） | `crawler/downloader/mod.rs:1458` | task/surf/plugin（免费） |
| `add` | 本地文件新入库 | `local_folder/import.rs:132` | plugin |
| `delete` | `delete_images_with_events`（删除/移除/批量命令、隐藏清理、整理清缺失、文件夹同步清缺失） | `storage/image_events.rs:41` | 四项（plugin/surf 需额外查询） |
| `change` | 删除任务 / 清空已完成任务 | `commands/task.rs:139`、`:287` | task/plugin（需额外查询） |
| `change` | 去重命中后重绑 metadata | `crawler/downloader/mod.rs:97` | 四项（免费） |
| `change` | 设为壁纸（`last_set_wallpaper_at`） | `kabegame/src/commands/wallpaper.rs:93`、`ipc/handlers/settings.rs:338`、`wallpaper/rotator.rs:598`、`:884` | plugin（settings.rs 需额外查询） |
| `rename` | MCP 改 `display_name` | `kabegame/src/mcp_server.rs:1187` | plugin（需额外查询） |
| `metadata-migrate` | 插件 metadata 迁移 | `plugin/metadata_migration.rs:55` | plugin，`imageIds` 为空 |

`album-images-change` 与 albums 事件的发送点、静默写清单见「第二期（暂缓）」。

### a. 删图时仅为 payload 做的额外查询（`storage/image_events.rs:22-51`）
```rust
let album_ids = storage.collect_album_ids_for_images(image_ids)?;             // 现状：发 album-images-change 需要
let task_ids = storage.collect_task_ids_for_images(image_ids)?;               // 现状：任务计数刷新需要
let plugin_ids = storage.collect_plugin_ids_for_images(image_ids)?;           // 现状：逐张 find_image_by_id，只为 payload
let surf_record_ids = storage.collect_surf_record_ids_for_images(image_ids)?; // 现状：逐张查询，只为 payload
```

### b. 删除任务前收集全部 image id 与 plugin（`commands/task.rs:128-148`、`:266-292`）
```rust
let image_ids = Storage::get_task_image_ids(&task_id)?;                  // 现状：只为 payload
let plugin_ids = storage.get_task(&task_id)?.map(|t| vec![t.plugin_id]); // 现状：只为 payload
storage.delete_task(&task_id)?;                                          // 现状：并不修改 images 表
```

### c. 写了 images 表却不发 `images-change`
```rust
// storage/surf_records.rs:405 delete_surf_record —— 现状：UPDATE images SET surf_record_id = NULL，只发 surf 事件
// storage/organize.rs:715/726/750/837/847 —— 现状：replace_image_{thumbnail,compatible}_path，只发 organize-*
```

### d. ImageGrid 的事件刷新（`apps/kabegame/src/components/ImageGrid.vue:490-518`）
```ts
useImagesChangeRefresh({ enabled: ref(true), waitMs, filter, onRefresh });  // 现状：每实例一个 listen
useAlbumImagesChangeRefresh({ ... });                                       // 现状：同上
// 节流 useTrailingThrottleFn 窗口内只保留最后一次参数 → 前面 payload 的 imageIds 丢失
// refreshPage() 内部串行调 loadImages + loadTotalImagesCount，无过期保护，后发先到会被旧结果覆盖
```

### e. 删除只调命令，列表全靠事件回刷
```ts
// composables/useImageOperations.ts:267（gallery/task/surf 的 remove 缺省确认走这里，ImageGrid.vue:728）
await invoke("batch_delete_images", { imageIds });   // 现状：不带视图，等 images-change 防抖回刷
// components/imageGrid/adapters/album.ts:56（deleteFile.confirm）
await invoke("batch_delete_images", { imageIds, ... });
```

### f. 收藏逐张调用，星标靠事件就地 patch（`useImageOperations.ts:310-345`、`adapters/gallery.ts:71-94`）
```ts
await Promise.allSettled(toChange.map((img) =>
  invoke("toggle_image_favorite", { imageId: img.id, favorite: desiredFavorite })));
// 现状：gallery adapter 的 albumImagesChange.onRefresh 用「最后一次」payload 的 imageIds patch 星标
```

### g. 读视图没有序号（`kabegame-core/src/commands/image.rs:30`）
```rust
pub async fn pathql_fetch(path: String) -> Result<Value, String> { ... query_fetch(&path) ... } // 现状：只返回 rows
// 总数另走 pathql_entry(countPath).total（apps/kabegame/src/composables/usePagedGallery.ts:63）
```

### h. `images-change` 字段的前端消费方
| 字段 | 消费方 | 本次删除后 |
|---|---|---|
| `pluginIds` | `galleryFilterTree/facetTreeSource.ts:287`、`GalleryQueryBar.vue:1018` | delete 等路径不再带 → 视为未知、全量刷新插件节点（已有分支） |
| `surfRecordIds` | `adapters/surf.ts:35`、`views/Surf.vue:656` | delete 不再带 → surf adapter 改用 `wildcard.surf`；Surf.vue 走 `refreshAll` 兜底 |
| `taskIds` | `adapters/task.ts:40` | 保留（免费） |
| `imageIds` | gallery/album/task adapter 求交集 | 保留字段；ImageGrid 不再用它判定 |

---

## 点 1 — 后端：删掉 `images-change` 里有开销的 payload

- **修改** `delete_images_with_events`（`storage/image_events.rs`）
```rust
let album_ids = storage.collect_album_ids_for_images(image_ids)?;
let task_ids = storage.collect_task_ids_for_images(image_ids)?;
// 删除：collect_plugin_ids_for_images / collect_surf_record_ids_for_images 两次调用
...
GlobalEmitter::global().emit_images_change("delete", image_ids, Some(&task_ids), None, None); // 修改：surf/plugin 传 None
```
- **删除** `Storage::collect_plugin_ids_for_images`、`Storage::collect_surf_record_ids_for_images`
  （`storage/images.rs:871`、`:890`）。
  > 说明：已确认无其他调用方。
- **修改** `delete_task` / `clear_finished_tasks`（`commands/task.rs`）
```rust
storage.delete_task(&task_id)?;
GlobalEmitter::global().emit_task_deleted(&task_id);
// 修改：不再收集 image_ids / plugin_ids；按任务维度失效，imageIds 为空
GlobalEmitter::global().emit_images_change("change", &[], Some(&[task_id]), None, None);
```
  > 说明：删除任务不改 images 表，但任务详情、过滤树任务节点要靠它失效，所以保留事件、只去 payload。
- **修改** `ipc/handlers/settings.rs:338`（设当前壁纸）、`mcp_server.rs:1187`（改名）：去掉为拿 plugin_id 的
  `find_image_by_id`，`plugin_ids` 传 `None`。
  > 说明：`wallpaper.rs`、`rotator.rs` 的 plugin_id 本就在手边，保持不动。

## 点 2 — 后端：补上漏发的 `images-change`

- **修改** `delete_surf_record`（`storage/surf_records.rs:405`）
```rust
GlobalEmitter::global().emit_surf_record_deleted(id);
GlobalEmitter::global().emit_images_change("change", &[], None, Some(&[id.to_string()]), None); // 新增
```
- **修改** organize（`storage/organize.rs`）：处理过程中收集缩略图/兼容路径被改写的 id，每处理完一批发一次
  `images-change("change", ids)`，不逐张发。

## 点 3 — 后端：变更序号与视图快照

- **新增** emitter 全局序号
```rust
static CHANGE_SEQ: AtomicU64 = AtomicU64::new(0);
pub fn current_change_seq() -> u64 { CHANGE_SEQ.load(Ordering::SeqCst) }

// emit_images_change：
let seq = CHANGE_SEQ.fetch_add(1, Ordering::SeqCst) + 1; // 新增，写入 DaemonEvent::ImagesChange.seq
// emit_album_images_change：
CHANGE_SEQ.fetch_add(1, Ordering::SeqCst);               // 新增，只递增、不写 payload（理由见总体设计思路）
```
  > 说明：no-op emitter（CLI）恒返回 0，不影响。
- **新增** 共享视图快照 `kabegame-core/src/commands/view.rs`
```rust
#[derive(Deserialize)] pub struct ViewQuery { pub rows: String, pub count: String }
#[derive(Serialize)]   pub struct ViewSnapshot { pub rows: Value, pub total: usize, pub seq: u64 }

pub async fn snapshot_view(q: ViewQuery) -> Result<ViewSnapshot, String> {
    let seq = current_change_seq();   // 必须先取序号、再读数据
    // spawn_blocking：query_fetch(rows) + query_entry(count).total
}
pub async fn pathql_view(q: ViewQuery) -> Result<ViewSnapshot, String>; // 新增命令：liveQuery 与首次加载/翻页使用
```
- **修改** `batch_delete_images`、`batch_remove_images`：增加可选参数 `view: Option<ViewQuery>`，传了则返回值带
  `view: ViewSnapshot`；不传时行为与现在一致（CLI、MCP 不受影响）
```rust
pub async fn batch_delete_images(image_ids: Vec<String>, view: Option<ViewQuery>) -> Result<Value, String> {
    delete_images_with_events(&image_ids, true).await?;                                // 先写入、发事件
    let view = match view { Some(q) => Some(snapshot_view(q).await?), None => None }; // 再读快照
    Ok(json!({ "view": view }))
}
```
  > 说明：三层同步修改——core 实现、Tauri 薄包装（`kabegame/src/commands/*`）、`web::dispatch`；web 模式对快照
  > rows 同样施加 `rewrite_image_value`。新命令 `pathql_view` 需补 Tauri 注册、`permissions/*.toml` 白名单与
  > web dispatch 条目。命令名不变、只加可选参数，已有调用方不用改。

## 点 4 — 前端：`services/dataChangeHub.ts`

- **新增** 全局单例：第一期只监听 `images-change`，按订阅者时间窗合并批次，回调串行
```ts
export interface ChangeBatch {
  images: Set<string>;        // images-change 的 reason 集合
  imageIds: Set<string>;
  taskIds: Set<string>;
  surfRecordIds: Set<string>;
  pluginIds: Set<string>;
  /** 本批中某个事件未带该维度 → 该维度无法排除，视为命中全部 */
  wildcard: { task: boolean; surf: boolean; plugin: boolean };
  /** 批次内最大 seq */
  maxSeq: number;
}
export function subscribeChanges(opts: {
  waitMs: number;
  filter?: (batch: ChangeBatch) => boolean;  // 在合并后的整批上判断一次
  onBatch: (batch: ChangeBatch) => Promise<void> | void;
}): () => void;
```
  > 说明：节流沿用「首次立即 + 尾触发」语义，但窗口内是合并而非覆盖；回调执行中到达的批次暂存，跑完后补跑。
  > 事件源写成可登记的 source 表，第二期加 `album-images-change` 时只扩 `ChangeBatch` 字段与 source，不改接口。
  > 不用真正的 Web Worker：`listen`/`invoke` 的 IPC 桥挂在 window 主线程，Worker 里拿不到；重活在 Rust 的 SQL，
  > 放进 Worker 不省 CPU，反而要把最多 1000 行结构化克隆一遍。

## 点 5 — 前端：`services/liveQuery.ts`

- **新增** 基于 hub 的查询注册
```ts
export function useLiveQuery(opts: {
  key: () => ViewQuery | null;               // 响应式；null = 暂停（不活跃），期间相关批次只标脏，恢复时补拉
  waitMs: number;
  relevant: (batch: ChangeBatch) => boolean;
  onResult: (snap: ViewSnapshot) => void | Promise<void>;
  onError?: (e: unknown) => void;
}): {
  /** 立即拉取（受 seq 守卫）；第一期 album-images-change 的刷新也走这里 */
  refetch: () => Promise<void>;
  /** 主动通道：直接应用写命令返回的快照（seq < appliedSeq 丢弃） */
  apply: (snap: ViewSnapshot) => Promise<void>;
  /** 当前视图查询，供写操作携带 */
  view: () => ViewQuery | null;
};
// 内部维护 appliedSeq：被动批次 maxSeq <= appliedSeq → 跳过；任何结果 seq < appliedSeq → 丢弃。
// key 变化（翻页、切过滤）仍由 usePagedGallery 驱动加载，liveQuery 只切换订阅、不主动拉。
```
- **修改** 首次加载与翻页：`loadImages` + `loadTotalImagesCount` 合并为一次 `pathql_view`，其 `seq` 作为
  `appliedSeq` 初值。

## 点 6 — ImageGrid：`ctx.mutate` / `ctx.patch`

- **修改** `GridRefreshContext`（`components/imageGrid/types.ts`）
```ts
/** 影响结果集的写操作唯一入口：携带当前视图，返回快照后立即应用（无防抖） */
mutate: <T extends { view?: ViewSnapshot | null }>(op: (view: ViewQuery | null) => Promise<T>) => Promise<T>;
/** 只改展示字段的就地更新（目前仅收藏） */
patch: (ids: Iterable<string>, fields: Partial<ImageInfo>) => void;
```
  > 说明：`mutate` / 被动拉取应用快照后，复用原 `refreshPage` 的后处理——对比删除项、恢复滚动、清理选中与
  > 当前壁纸、页码越界回退。`refreshPage` 降级为内部函数，`ctx.refreshPage` 改为调用 `liveQuery.refetch()`。
- **修改** `GridAdapter`：`imagesChange` 改为
```ts
imagesChange?: { relevant?: (batch: ChangeBatch) => boolean };   // 删除 waitMs：防抖统一 500ms
// albumImagesChange 保持现有 GridEventRefreshConfig 不变（第二期再合并），但 waitMs 同样统一为 500ms
```
- **修改** 防抖时长统一为 **500ms**：`services/liveQuery.ts` 导出 `GRID_REFRESH_WAIT_MS = 500`，ImageGrid 的
  `images-change`（liveQuery）与 `album-images-change` 监听都用它；删除各 adapter 里的 `waitMs`（现状 gallery 100、
  album/task 1000、surf 500），以及 ImageGrid 里 `?? 1000` / `?? 500` 的缺省值。
  > 说明：先统一成一个值，后续按实测再调；用户操作走 `ctx.mutate` 不经防抖，不受此值影响。
  各 adapter 的 `imagesChange.relevant`：gallery 始终；album 始终；task 命中 taskId 或 `wildcard.task`；surf 命中
  recordId 或 `wildcard.surf`。
  > 说明：删掉各 adapter 里 `imageIds` 与当前页求交集的逻辑；album adapter 的 `onRefresh` 中
  > `delete albumStore.albumImages[id]` 保留（属 store，第二期处理）。
- **修改** ImageGrid 的 `album-images-change` 监听：保留 `useAlbumImagesChangeRefresh` 与 adapter 的过滤/节流，
  缺省刷新动作由 `refreshPage()` 改为 `liveQuery.refetch()`，使其结果受 `seq` 守卫。
- **修改** 删除改走 `ctx.mutate`
  - `composables/useImageOperations.ts` 的 `handleBatchDeleteImages`（gallery/task/surf 的 remove 缺省确认）：
    接收 `mutate`，调用 `batch_delete_images` 时带 `view`；
  - `adapters/album.ts` 的 `deleteFile.confirm`：同上。
- **修改** 收藏：`toggleFavoriteForImages` 成功后 `ctx.patch(succeeded, { favorite })`。别处来的收藏仍由 gallery
  adapter 现有的 `albumImagesChange.onRefresh` patch（不动）。
- **修改** 收藏画册视图：album adapter 在 `albumId === FAVORITE_ALBUM_ID` 时 `actionsOptions().hide` 加
  `"favorite"`，只保留 remove。
  > 说明：预览工具栏是否共用这套 actions，实现时核对；共用则同样生效。
- **删除** ImageGrid 对 `useImagesChangeRefresh` 的使用（composable 本身保留给 Surf.vue、GalleryToolbar 等）。

## 点 7 — 文档与规则

- **修改** `composables/useImagesChangeRefresh.ts` 的 `ImagesChangePayload`：加 `seq`。
- **新增** `.cursor/rules/view-mutation.mdc`：影响视图的写操作必须走 `ctx.mutate` + 带 `view` 的命令；只改字段的
  走 `ctx.patch`；禁止依赖事件回刷用户自己的操作；新增写命令若可能影响 ImageGrid 视图，必须支持可选 `view`。
  已知例外：隐藏/取消隐藏、加入/移出画册、上划移除，待第二期迁入。
- **修改** `AGENTS.md`「关键架构规则」：同步一条摘要。
- **修改** `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`：双通道、`seq` 协议、`images-change` payload
  调整、hub/liveQuery 架构；同步 `cocs/README.md` 索引描述。
- **新增** `versions/<当前版本>/regression.md` 回归条目：
  - 下载进行中画廊实时出现新图；
  - 删除（画廊/任务/畅游/画册删文件）后画面立即更新，不闪回旧列表；
  - 下载进行中执行删除，结果不被防抖回刷覆盖；
  - 隐藏/取消隐藏、从画册移除后列表仍能正确刷新（走旧通道 + `refetch`）；
  - 删除畅游记录后相关视图刷新；
  - 整理重建缩略图后网格显示新缩略图；
  - 收藏：本窗口星标即时变化；其他入口收藏后本窗口同步；收藏画册右键不出现「收藏」；
  - 任务详情 / 畅游详情只在相关事件时刷新；删除任务后任务相关视图刷新；
  - 最后一页删空后页码回退。

## 实施顺序

点 1 → 点 2 → 点 3（后端，完成后跑 `check-kabegame --skip vue`）→ 点 4 → 点 5 → 点 6 → 点 7（前端，跑
`check-kabegame --skip cargo`，再用 `kabegame-chromium` 在真实 app 里走一遍回归清单）。

---

## 第二期（暂缓）

> 已展开为完整计划：[eventWorker-phase2.md](eventWorker-phase2.md)。以下为第一期时记录的现状，保留备查。

牵涉 albums store，单独评估后再做。记录已查明的现状，供届时直接使用。

### `album-images-change` 发送点
加入/移出画册（`image_events.rs:62`、`:74`）、收藏开关（`:84`）、删图连带（`:49`）、下载进指定画册 4 处
（`downloader/mod.rs:989`、`:1161`、`:1471`、`queue.rs:1011`）、下载挂标签（`downloader/mod.rs:128`）、本地导入
（`import.rs:50`、`:135`）、文件夹同步关联/解除（`sync.rs:297`、`:358`）、迁移挂标签（`metadata_migration.rs:51`）、
MCP 加入画册（`mcp_server.rs:1158`）。

### albums 事件发送点
均在 `storage/albums.rs`（folderStatus 两处除外）：`album-added`（`add_album`、`add_label_album`、
`apply_labels_to_images`、`add_local_folder_albums_tx`）；`album-changed`（`rename_album`、`set_label_key`、
`move_album`、`set_album_sync_mode`、`convert_local_folder_album_to_normal`、`rechain_local_folder_albums`、
folderStatus 于 `fs_listener/mod.rs:389` 与 `sync.rs:73`）；`album-deleted`（`delete_album`）。前端只有
`stores/albums.ts:432-450` 订阅。

### 待办
- **`directCounts` 去除**：`emit_album_images_change` 每次都对每个 album 跑一次 `count_at`
  （`emitter.rs:465`）。改为 albums store 订阅 hub、按合并后的 `albumIds` 用 `fetchAlbumDirectCounts` 回拉，
  同时删掉按 ±imageIds 估算的 `adjustAlbumDirectCounts`（重复加入时估算偏差）。
- **补漏**：
  - `delete_album`（`albums.rs:648`）递归删子树 `album_images`，只发根的 `album-deleted`，缺
    `album-images-change("delete", 子树 ids, [])`；
  - 命令层 `update_album_images_order`（`commands/album.rs:158`）不发任何事件，缺
    `album-images-change("order", [album_id], ids)`；
  - `move_album` 子树路径重算只对根发 `parentId`——前端 store 本地重算路径，无缺口；ImageGrid 需订阅画册
    结构字段（`parentId`/`labelKey`/`albumType`/`deleted`，排除高频的 `folderStatus`/`syncMode`）覆盖标签树搜索。
- **hub 扩展**：`ChangeBatch` 增加 `albumImages`（reason 集合）、`albumIds`、`albumFields`、
  `favoriteOps`（按到达顺序记录 FAVORITE 的 add/delete，供就地 patch），`album-images-change` 与 albums 事件
  payload 加 `seq`。
- **主动通道补全**：`add_images_to_album`、`remove_images_from_album`、`add_task_images_to_album` 支持可选
  `view`；albums store 的 `addImagesToAlbum`/`removeImagesFromAlbum`/`addTaskImagesToAlbum` 透传；隐藏/取消隐藏、
  加入/移出画册（含 AddToAlbumDialog）、上划移除改走 `ctx.mutate`；规则里的已知例外随之删除。
- **ImageGrid 收口**：`albumImagesChange` 并入 hub；gallery adapter 旧的星标 patch 由 `favoriteOps` 取代；
  album adapter 的 `delete albumStore.albumImages[id]` 交还 store。
