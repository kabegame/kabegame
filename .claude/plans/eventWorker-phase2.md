# 第二期：画册成员变更迁入主动 / 被动双通道

> 第一期（`images-change` → `dataChangeHub` / `liveQuery`，删除走 `ctx.mutate`）已落地，见
> [eventWorker.md](eventWorker.md)。实测删除已足够快，但隐藏/取消隐藏仍明显慢。本期把
> `album-images-change` 与画册写操作迁入同一套机制，并改造 albums store 的计数维护。

## 总体设计思路

第一期之后，删除的路径是「命令写库 → 同一次 IPC 返回新视图 → 立即替换列表」，而隐藏走的仍是旧路径：
`albumStore.addImagesToAlbum` 写库后什么都不返回，ImageGrid 要等 `album-images-change` 事件到达、经过
节流，再发起 `pathql_view`。更糟的是，这一个事件会同时触发一串查询：albums store 发现隐藏画册变了，
就对**全部画册**逐个发 `pathql_entry` 重算「排除隐藏」的直接计数（每个画册一次 IPC、一次 COUNT）；
画廊工具栏重算总数；过滤树刷新计数；后端在发事件前还同步跑了一次 `count_at` 填 `directCounts`。
而 `Storage` 只有一把 `Arc<Mutex<Connection>>`，这些查询与网格自己的 `pathql_view` 在同一把锁上排队——
网格的两次查询（行、总数）各拿一次锁，中间很容易被几十上百个计数查询插队。

本期做三件事，形态与第一期一致：

**主动通道覆盖画册写操作。** `add_images_to_album` / `remove_images_from_album` /
`add_task_images_to_album` 接受可选 `view`，写完返回 `ViewSnapshot`；albums store 的三个写函数透传
`view` 并把快照原样返回；ImageGrid 的隐藏/取消隐藏、移出画册、上划移除、加入画册（含
`AddToAlbumDialog`）一律经 `ctx.mutate`。为了让快照不被事件引发的查询插队，后端引入
**「先快照、后广播」**：带 `view` 的写命令在写库前拿一个 `EventHold` 守卫，期间
`images-change` / `album-images-change` 照常分配 `seq` 但暂存不广播，快照读完、守卫析构时按顺序放行。
`seq` 仍在 emit 调用时分配，所以快照的 `seq` 一定不小于自身事件的 `seq`，前端照旧跳过回声；守卫在
`Drop` 中放行，出错路径也不会丢事件。第一期的 `batch_delete_images` 一并套上守卫。

**被动通道收编 `album-images-change`。** 事件 payload 加 `seq`、删掉 `directCounts`，成为 hub 的第二个
source；`ChangeBatch` 增加画册维度（`albumIds`、成员变更 reason、按到达顺序的收藏操作、画册结构字段）。
`album-changed` 只取结构字段（`parentId` / `labelKey` / `albumType`）作为第三个 source，服务于标签搜索
结果随标签树变化；`folderStatus` / `syncMode` / `name` 这类高频或无关字段在 source 入口丢弃。ImageGrid
删掉 `useAlbumImagesChangeRefresh`，adapter 只剩一个 `changes.relevant(batch)`；收藏星标由独立的 hub
订阅按 `favoriteOps` 就地 patch，替代 gallery adapter 里的旧逻辑。

**计数靠算，视图靠拉。** `album_images` 的变更只有增和删两种，所以画册的直接计数完全可以由增量推出，
不必重新 COUNT；但画册**视图**（网格）不能按增量去 patch 列表——用户可能叠了过滤、排序和分页，一张图
加入或移出后落在哪一页、是否满足过滤都得由查询决定，所以视图一律走主动快照或被动重拉（点 3、点 7）。
计数要能「算」，前提是事件本身精确。现在前端按 ±imageIds 估算（`adjustAlbumDirectCounts`），它错在两处：
① 重复加入已在画册里的图、移出本不在画册里的图，也被计为增减；② 删图事件把全部画册 id 和全部图片 id
平铺在一起，推不出每个画册各少了几张。「排除隐藏」计数还有第三个难点：隐藏或取消隐藏一张图，会改变
**所有包含它的画册**的这项计数，而前端不知道成员关系，所以现在只好把全部画册都重算一遍。

解法是**把判断全部收到后端，事件按画册拆开，前端只查表**。存储层的增删返回**实际变更**的图片 id；
每条 `album-images-change` 只描述一个画册，`imageIds` 就是这个画册里实际变更的图，reason 决定它影响哪套
计数——前端 store 对任何事件都套同一张固定的表，不看隐藏画册、不看图片状态：

| reason | 直接计数 `all` | 排除隐藏计数 `visible` | 后端何时发 |
| --- | --- | --- | --- |
| `add` | +n | +n | 加入画册的图当前未隐藏 |
| `add-hidden` | +n | — | 加入画册的图当前已隐藏（含加入 HIDDEN 本身） |
| `delete` | −n | −n | 移出 / 删除的图原先未隐藏 |
| `delete-hidden` | −n | — | 移出 / 删除的图原先已隐藏（含移出 HIDDEN 本身） |
| `hide` | — | −n | 隐藏时，**其他**包含这些图的画册 |
| `unhide` | — | +n | 取消隐藏时，其他包含这些图的画册 |
| `order` | — | — | 画册内排序 |

隐藏一批图于是变成：`add-hidden(HIDDEN, C)`，加上对每个包含它们的画册 A 发 `hide(A, C∩A)`，再发一条
`images-change("change", C)`。三类事件分工不同：隐藏是用户的主动动作，**发起操作的网格**靠 `ctx.mutate`
拿到命令返回的快照立即更新，事件对它只是回声（`seq` 不大于已应用快照，被跳过）；`album-images-change`
是画册计数的**唯一来源**，一条都不能少；`images-change` 只是**兜底**，让其他视图（keep-alive 的另一个
网格、工具栏总数、过滤树计数）按第一期已有的 `images-change` 规则重拉。这样前端 adapter 不再需要
「命中 HIDDEN 就刷新」的特判，画廊工具栏、过滤树里专门盯隐藏画册的 `album-images-change` 监听也可以删掉。后端做这些判断只需要对实际变更的图片 id 做**一次**
`album_images` 成员查询（按 `image_id` 走索引）：隐藏状态（有没有 HIDDEN 行）和「包含它的画册」都从这一次
结果里得到；删图原本就在删除前查过所属画册，把 `album_id` 列表换成成员对即可，不增加查询。这一次索引
查询替代的是原来 emit 路径里对每个画册的 `count_at`，以及前端对全部画册的逐个重算。

计数的应用同样分主动与被动两路。**主动**：画册写命令（加入 / 移出 / 隐藏 / 取消隐藏 / 删图）把自己
发出的那几条 `album-images-change` payload 原样放进返回值 `albumChanges`，store 的写函数拿到返回就
立即应用——受影响画册的计数与缓存失效和新视图在同一时刻落地，不等事件。**被动**：其他来源（下载、同步、
MCP、另一个窗口）的变更照旧经事件到达。两路调用**同一个**应用函数，按 payload 的 `seq` 去重：一条变更
无论先到的是命令返回还是事件，只应用一次（`EventHold` 在命令返回前就放行，所以事件完全可能先到，
去重必须是对称的）。前端对 payload 的处理只有查表加减，两路没有任何分支差异。

store 在直接监听里**同步**按表加减，不经防抖也不查库，隐藏后画册树和清理按钮的数字立即跟上。全量
COUNT 只剩 `loadAlbums` 初始化一处，改用批量命令 `get_album_direct_counts`（一次 IPC、一个 blocking
任务），并返回读取时的 `seq`，让 store 丢弃加载期间已计入快照的事件，避免重复加减。为保证每条事件都按表
分类，`emit_album_images_change` 收为 `image_events.rs` 内部函数，所有发送点改走两个入口
`emit_membership_added` / `emit_membership_removed`，由入口统一查成员、拆画册、定 reason。缓存失效（删除
`albumImages` / `albumPreviews` 的键）照旧即时执行。

关键取舍：画册结构事件（`album-added/changed/deleted`）在 store 里仍是直接监听、同步本地 patch——它们
不查库，移进 hub 只会给画册树 UI 加上防抖延迟；hub 只为网格额外登记 `album-changed` 的结构字段。
`EventHold` 只作用于会触发视图查询的两类事件，任务进度等其他事件不受影响。

## 现状锚点

**a. 隐藏/取消隐藏**（`apps/kabegame/src/components/ImageGrid.vue:877`）
```ts
case "addToHidden": {
  if (await guardDesktopOnly("hideImage", { needSuper: true })) break;
  const ids = imagesToProcess.map((img) => img.id);
  const isUnhide = !!image.isHidden || (adapter.forceUnhide?.() ?? false);
  try {
    if (isUnhide) {
      await albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids);   // 现状：不带视图，等事件回刷
      ...
    } else {
      await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids);
```
上划移除（`useImageOperations.ts:290` 的 `handleBatchHideImages`、`adapters/album.ts:177` 的 `swipeRemove`）、
移出画册（`adapters/album.ts:158`）同样只调 store、不带视图。

**b. store 写函数**（`apps/kabegame/src/stores/albums.ts:708`）
```ts
const addImagesToAlbum = async (albumId: string, imageIds: string[]) => {
  await initEventListeners();
  try {
    await invoke<{ added: number; attempted: number; canAdd: number; currentCount: number }>(
      "add_images_to_album", { albumId, imageIds });   // 现状：返回值被丢弃
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
  } ...
};
const removeImagesFromAlbum = async (albumId: string, imageIds: string[]) => {
  ...
  const removed = await invoke<number>("remove_images_from_album", { albumId, imageIds });  // 现状：返回裸数字
```

**c. store 的 `album-images-change` 监听**（`stores/albums.ts:460`）
```ts
if (p.directCounts && Object.keys(p.directCounts).length > 0) {
  patchAlbumDirectCounts(p.directCounts, false);          // 现状：用后端 emit 时算好的计数
} else {
  ...
  if (p.reason === "add") adjustAlbumDirectCounts(ids, uniqueImageCount, false);   // 现状：按 ±imageIds 估算
  else if (p.reason === "delete") adjustAlbumDirectCounts(ids, -uniqueImageCount, false);
}
const hiddenCountIds =
  ids.length === 0 || ids.includes(HIDDEN_ALBUM_ID)
    ? albums.value.map((album) => album.id)              // 现状：隐藏画册一变就重算全部画册
    : ids;
await refreshAlbumDirectCounts(true, hiddenCountIds);   // 现状：每个事件立即执行，不节流
```

**d. 计数逐画册一次 IPC**（`apps/kabegame/src/utils/albumMediaTree.ts:78`）
```ts
export async function fetchAlbumDirectCounts(albumIds: Iterable<string>, hide: boolean) {
  const uniqueIds = Array.from(new Set(Array.from(albumIds).filter(Boolean)));
  const pairs = await Promise.all(
    uniqueIds.map(async (id) => [id, await fetchAlbumDirectCount(buildGalleryAlbumPath(id, hide))] as const),
  );   // 现状：N 个画册 = N 次 pathql_entry
```
`loadAlbums`（`stores/albums.ts:498`）对 hide=false / true 各调一次，即 2N 次。

**e. 后端 emit 路径同步计数**（`src-tauri/kabegame-core/src/emitter.rs`）
```rust
pub fn emit_album_images_change(&self, reason: &str, album_ids: &[String], image_ids: &[String]) {
    CHANGE_SEQ.fetch_add(1, Ordering::SeqCst);             // 现状：只递增，payload 不带 seq
    let direct_counts = album_direct_counts(album_ids);    // 现状：对每个画册跑一次 count_at，写命令返回前完成
    let event = std::sync::Arc::new(DaemonEvent::AlbumImagesChange {
        reason: reason.to_string(), album_ids: album_ids.to_vec(),
        image_ids: image_ids.to_vec(), direct_counts,
    });
    EventBroadcaster::global().broadcast(event);            // 现状：立即广播
}
```

**f. 单连接**（`src-tauri/kabegame-core/src/storage/mod.rs:49`）
```rust
pub(crate) db: Arc<Mutex<Connection>>,   // 现状：所有读写串行
```

**g. 画册写命令**（`src-tauri/kabegame-core/src/commands/album.rs:127`）
```rust
pub fn add_images_to_album(album_id: String, image_ids: Vec<String>) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;   // 现状：内部立即 emit
    ...
    serde_json::to_value(r).map_err(|e| e.to_string())               // 现状：AddToAlbumResult，无视图
}
pub fn update_album_images_order(album_id: String, image_orders: Vec<(String, i64)>) -> Result<Value, String> {
    Storage::global().update_album_images_order(&album_id, &image_orders)?;
    Ok(Value::Null)                                                   // 现状：不发任何事件
}
```

**h. ImageGrid 的第二条监听**（`ImageGrid.vue:560`）
```ts
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: GRID_REFRESH_WAIT_MS,
  filter: (p) => adapter.albumImagesChange?.filter
      ? adapter.albumImagesChange.filter(p, refreshCtx)
      : (p.albumIds ?? []).includes(HIDDEN_ALBUM_ID),
  onRefresh: async (p) => {
    if (adapter.albumImagesChange?.onRefresh) await adapter.albumImagesChange.onRefresh(p, refreshCtx);
    else await refreshPage();   // 现状：显式 refetch，不合并在途请求（payload 无 seq）
  },
});
```
gallery adapter 的 `albumImagesChange.onRefresh`（`adapters/gallery.ts:65`）对收藏就地 patch 星标、对
HIDDEN / no-album 调 `ctx.refreshPage()`。

**i. 其他放大查询的点**
```ts
// components/albums/AlbumTreePanel.vue:369 —— 现状：每 10s 兜底全量重算两套计数（2N 次 IPC）
const refreshCounts = () => {
  void albumStore.refreshAlbumDirectCounts(false);
  void albumStore.refreshAlbumDirectCounts(true);
};
useAlbumImagesChangeRefresh({ enabled: refreshEnabled, waitMs: 10000, onRefresh: refreshCounts });

// components/AddToAlbumDialog.vue:94 —— 现状：每次打开都 loadAlbums（全量画册 + 2N 次计数）
watch(() => props.open, async (v) => { if (v) { await albumStore.loadAlbums(); } ... });
// AddToAlbumDialog.vue:200 —— 现状：先拉目标画册全部图片 id 做前端去重
const existingIds = await albumStore.getAlbumImageIds(albumId);

// adapters/album.ts —— 现状：加入画册后再 loadAlbums 一次
onAddedToAlbum: async () => { await albumStore.loadAlbums(); },
```

## 点 1 — 后端：事件延迟广播 `EventHold`（`emitter.rs`）

- **新增** 计数守卫，只拦 `ImagesChange` / `AlbumImagesChange` 两类事件
```rust
#[cfg(feature = "ipc-server")]
static HELD: Mutex<(usize, Vec<Arc<DaemonEvent>>)> = Mutex::new((0, Vec::new()));   // 新增：(深度, 暂存队列)

/// 新增：持有期间 images-change / album-images-change 照常分配 seq，但暂存到析构时按序广播。
pub struct EventHold(());

impl GlobalEmitter {
    pub fn hold(&self) -> EventHold { /* 深度 +1 */ }
}
impl Drop for EventHold {
    fn drop(&mut self) { /* 深度 -1；归零时在锁内按序 broadcast 并清空队列 */ }
}

/// 新增：两类视图事件的统一出口；深度 > 0 时入队，否则直接广播（锁内完成，保证与放行队列的相对顺序）
fn dispatch_view_event(event: Arc<DaemonEvent>) { ... }
```
  > 说明：守卫是全局计数而不是线程局部，才能跨 `await`（`batch_delete_images` 是 async）。持有时间只有
  > 一次快照查询，期间别处（如下载）的同类事件也会被推迟到放行时，顺序不变。
- **修改** `emit_images_change` / `emit_album_images_change` 的 `EventBroadcaster::global().broadcast(event)`
  改为 `dispatch_view_event(event)`。
- **修改** 非 `ipc-server` 分支提供空实现的 `hold()`，签名一致。

## 点 2 — 后端：`album-images-change` 按画册拆分、按表定 reason、加 `seq`、删 `directCounts`、补漏

- **修改** 存储层增删返回实际变更的 id（`storage/albums.rs`）
```rust
pub fn add_images_to_album(&self, album_id: &str, image_ids: &[String]) -> Result<AddToAlbumResult, String>;
// 修改：AddToAlbumResult 增加 inserted_ids: Vec<String>（INSERT OR IGNORE 后按 changes() 判定真正插入的）
pub fn remove_images_from_album(&self, album_id: &str, image_ids: &[String]) -> Result<Vec<String>, String>;
// 修改：原返回 usize，改为真正删除的 id（调用方取 len() 即原来的 removed）
pub fn toggle_image_favorite(&self, image_id: &str, favorite: bool) -> Result<bool, String>;
// 修改：返回成员关系是否真的变化（重复收藏 / 重复取消时为 false，不产生增量）
```
- **新增** 成员查询（`storage/albums.rs`），替代 `collect_album_ids_for_images`
```rust
/// 一次按 image_id 走索引的查询，返回 (album_id, image_id) 成员对。实施时确认 album_images(image_id) 有索引。
pub fn collect_album_memberships(&self, image_ids: &[String]) -> Result<Vec<(String, String)>, String>;
```
- **新增** 两个统一发送入口（`storage/image_events.rs`），按「总体设计思路」里的表拆事件
```rust
/// 与事件 payload 同构，命令把它原样返回给前端（主动通道）。
#[derive(Serialize, Clone)]
pub struct AlbumImagesChangePayload { pub seq: u64, pub reason: String, pub album_ids: Vec<String>, pub image_ids: Vec<String> }

/// 图片 changed（实际新增的成员）加入了画册 album_id 之后调用；返回本次发出的全部 payload。
pub fn emit_membership_added(album_id: &str, changed: &[String]) -> Result<Vec<AlbumImagesChangePayload>, String> {
    let mut out = Vec::new();
    if changed.is_empty() { return Ok(out); }
    let pairs = Storage::global().collect_album_memberships(changed)?;   // 唯一一次查询（写后状态）
    let hidden: HashSet<&str> = /* pairs 中 album_id == HIDDEN 的 image_id */;
    if album_id == HIDDEN_ALBUM_ID {
        out.extend(emit("add-hidden", HIDDEN, changed));
        for (a, ids) in /* pairs 按 album 分组，排除 HIDDEN */ { out.extend(emit("hide", a, ids)); }
        GlobalEmitter::global().emit_images_change("change", changed, None, None, None);   // 兜底：其他视图重拉
    } else {
        let (h, v) = /* changed 按 hidden 拆分 */;
        out.extend(emit("add", album_id, v));
        out.extend(emit("add-hidden", album_id, h));   // 空则不发，返回 None
    }
    Ok(out)
}

/// 图片 changed（实际移除的成员）移出画册 album_id 之后调用；pairs 由调用方在写库前查好
/// （移出 HIDDEN 时写后已查不到隐藏状态，所以用写前状态）。返回值同上。
pub fn emit_membership_removed(album_id: &str, changed: &[String], pairs_before: &[(String, String)])
    -> Vec<AlbumImagesChangePayload>;
//   album_id == HIDDEN：delete-hidden(HIDDEN)；其他包含它们的画册 A 发 unhide(A)；images-change("change")
//   否则：按写前隐藏状态拆成 delete / delete-hidden

/// 内部：分配 seq、广播单画册事件，并把同一份 payload 返回；空 ids 不发、返回 None。
/// 取代原 pub 的 emit_album_images_change。
fn emit(reason: &str, album_id: &str, image_ids: &[String]) -> Option<AlbumImagesChangePayload>;
```
  > 说明：隐藏一批图 = HIDDEN 一条 + 每个相关画册一条 + 一条 `images-change`，事件数随「相关画册数」线性
  > 增长，都是纯内存广播，hub 会合并成一个批次。HIDDEN 自身、FAVORITE 在「排除隐藏」路径下的计数口径以
  > DSL 的 HideGate 实际语义为准，实施时用 `images://gallery/hide/album/<id>` 的 COUNT 对照核对一次，
  > 必要时调整表中 `add-hidden` 对 HIDDEN 的归类。
- **修改** `image_events.rs` 现有四个出口改用入口，并把入口返回的 payload 列表向上返回（`AddToAlbumResult`
  增加 `album_changes`，`remove` / `delete_images_with_events` 返回值同理）：`add_images_to_album_with_event`（用 `inserted_ids`）、
  `remove_images_from_album_with_event`（写前查 pairs）、`toggle_image_favorite_with_event`（仅在成员真的变化
  时发，走 FAVORITE 的 added / removed）、`delete_images_with_events`（删除前的 `collect_album_ids_for_images`
  换成 `collect_album_memberships`，删后对每个画册按写前隐藏状态发 `delete` / `delete-hidden`）。
- **修改** 其余直接调用 `emit_album_images_change` 的发送点（下载进画册 4 处、下载挂标签、本地导入 2 处、
  文件夹同步 2 处、迁移挂标签、MCP，清单见 [eventWorker.md](eventWorker.md) 第二期现状）逐个改走入口，
  并确保传入的是实际变更的 id。`emit_album_images_change` 降为 `image_events.rs` 私有，编译器保证不再有
  绕过分类的发送点。
- **修改** `DaemonEvent::AlbumImagesChange`（`ipc/events.rs:279`）
```rust
AlbumImagesChange {
    seq: u64,                    // 新增
    reason: String,              // 修改：add | add-hidden | delete | delete-hidden | hide | unhide | order
    #[serde(rename = "albumIds")]
    album_ids: Vec<String>,      // 修改：恒为单个画册（保留数组形状，兼容现有消费方）
    #[serde(rename = "imageIds")]
    image_ids: Vec<String>,      // 修改：该画册中实际变更的 id；为空不发（order 除外）
    // 删除：direct_counts
},
```
- **删除** `emitter.rs` 的 `album_direct_counts` 及其 `HashMap` 引用。
- **修改** `storage/albums.rs` 的 `delete_album`：递归删除后对子树每个画册补发 `album-images-change("order", [id], [])`。
  > 说明：子树的 `album_images` 被级联删除，但此前只发了根的 `album-deleted`；no-album 过滤的画廊据此刷新。
  > 用 `order`（不改计数）是因为被删画册的计数由 store 的 `album-deleted` 整体移除，被删成员也不影响其他
  > 画册的计数。实施时若觉得语义别扭，可新增 reason `purge`，计数规则同 `order`。
- **修改** `commands/album.rs` 的 `update_album_images_order`：写库后发
  `album-images-change("order", [album_id], 被排序的 image ids)`——排序不改计数，但画册视图要重拉。
  > 说明：实施时先核对调用方；若是网格内拖拽排序，则同点 3 一样带 `view`。
- **修改** 前端 `AlbumImagesChangePayload`（`composables/useAlbumImagesChangeRefresh.ts`）：加 `seq: number`，
  `reason` 联合类型补全上表七种，删 `directCounts`。

## 点 3 — 后端：画册写命令带 `view`（core / Tauri / web 三层）

- **修改** `kabegame-core/src/commands/album.rs`
```rust
pub async fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
    view: Option<ViewQuery>,                                 // 新增
) -> Result<Value, String> {
    let _hold = view.as_ref().map(|_| GlobalEmitter::global().hold());   // 新增：先快照、后广播
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    let mut out = serde_json::to_value(r).map_err(|e| e.to_string())?;
    if let Some(q) = view {                                  // 新增：在守卫析构前读快照
        out["view"] = serde_json::to_value(snapshot_view(q).await?).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

pub async fn remove_images_from_album(album_id: String, image_ids: Vec<String>, view: Option<ViewQuery>)
    -> Result<Value, String>;   // 修改：返回统一为 { removed, albumChanges, view? }（原为裸数字）
pub async fn add_task_images_to_album(task_id: String, album_id: String, view: Option<ViewQuery>)
    -> Result<Value, String>;   // 修改：AddToAlbumResult 上追加可选 view
```
  > 说明：三个函数改为 async（快照是 async）。返回值**始终**带 `albumChanges`（与是否带 `view` 无关，
  > 它只是已经发出的事件的副本，没有额外查询）：`add` / `addTask` 来自 `AddToAlbumResult.album_changes`，
  > 序列化为 `albumChanges`。`remove` 的返回形状变化只影响前端 store 一处调用；MCP 直接调 storage，不经此函数。
- **修改** `commands/image.rs` 的 `batch_delete_images` / `batch_remove_images`：带 `view` 时同样先拿守卫；
  返回值加 `albumChanges`（来自 `delete_images_with_events`），前端删除后画册计数同样立即更新。
- **修改** Tauri 薄包装（`kabegame/src/commands/album.rs`）三个命令加 `view: Option<ViewQuery>`，改 async。
- **修改** web dispatch（`kabegame/src/web/dispatch.rs:1277/1300/1323`）三个 handler 的 `Args` 加
  `view`，返回后对 `/view/rows` 施加 `rewrite_image_value`（同第一期删除命令）。

## 点 4 — 后端：批量计数命令 `get_album_direct_counts`（只用于初始化与兜底）

- **新增** `kabegame-core/src/commands/album.rs`
```rust
#[derive(Serialize)]
pub struct AlbumCountsSnapshot {
    pub all: HashMap<String, usize>,       // 直接计数
    pub visible: HashMap<String, usize>,   // 排除隐藏的直接计数
    pub seq: u64,                          // 读取前取的变更序号，规则同 ViewSnapshot
}

/// 一次 IPC、一个 blocking 任务内算完多个画册的两套直接计数。
pub async fn get_album_direct_counts(album_ids: Vec<String>) -> Result<AlbumCountsSnapshot, String> {
    let seq = current_change_seq();        // 先取 seq 再读
    tokio::task::spawn_blocking(move || {
        // 逐个 count_at，路径与前端 buildGalleryAlbumPath + withGalleryPrefix 一致：
        //   all → images://gallery/album/{id}；visible → images://gallery/hide/album/{id}
        ...
    }).await.map_err(|e| e.to_string())?
}
```
  > 说明：调用方只有 `loadAlbums` 初始化（原来 2N 次 `pathql_entry`，现在 1 次 IPC）和手动刷新；正常的
  > 增删走点 2 的分类事件，不再 COUNT。仍按画册逐个走 DSL 的
  > COUNT，是为了让隐藏语义只由 HideGate 定义，不在这里手写 GROUP BY 另起一套。实施时以前端现有路径为准
  > 核对 hide 前缀的位置。
- **新增** Tauri 命令注册（`lib.rs`）、`permissions/main.toml` 白名单、web dispatch（`requires_super: false`）。

## 点 5 — 前端 hub：收编 `album-images-change` 与画册结构变更（`services/dataChangeHub.ts`）

- **修改** `ChangeBatch`
```ts
export interface ChangeBatch {
  images: Set<string>;            // images-change 的 reason
  imageIds: Set<string>;
  taskIds: Set<string>;
  surfRecordIds: Set<string>;
  pluginIds: Set<string>;
  albumImages: Set<string>;       // 新增：album-images-change 的 reason（点 2 表中七种）
  albumIds: Set<string>;          // 新增：album-images-change 涉及的画册
  albumImageIds: Set<string>;     // 新增：album-images-change 的 imageIds（与 images-change 的分开）
  favoriteOps: { imageIds: string[]; favorite: boolean }[];   // 新增：FAVORITE 的增删，按到达顺序
  albumStructure: Set<string>;    // 新增：album-changed 中出现的结构字段（parentId/labelKey/albumType）
  wildcard: { task: boolean; surf: boolean; plugin: boolean };   // 不变：只由 images-change 置位
  maxSeq: number;
}
```
  > 说明：纯画册批次不会让任务/畅游详情误判命中；`album-images-change` 恒为单画册，不需要 album 维度的 wildcard。
- **新增** source `album-images-change`（带 `seq`）与 `album-changed`（只保留结构字段，其余字段的事件在
  source 入口丢弃，不产生批次）。
- **修改** `DaemonEvent::AlbumChanged` 发送点（`emit_album_changed`）同样分配 `seq` 并写入 payload，使
  hub 的所有批次都带 `seq`，`liveQuery` 的回声跳过规则无需特判。
- **不改** `subscribeChanges` 的「首次立即 + 尾触发」语义：计数已改为同步应用增量，store 不再订阅 hub。

## 点 6 — 前端：albums store（`stores/albums.ts`）

- **修改** 写函数透传视图并返回快照
```ts
const addImagesToAlbum = async (
  albumId: string, imageIds: string[], opts?: { view?: ViewQuery | null },   // 新增 opts
) => {
  await initEventListeners();
  const result = await invoke<AddToAlbumResult & { albumChanges: AlbumImagesChangePayload[]; view?: ViewSnapshot | null }>(
    "add_images_to_album", { albumId, imageIds, view: opts?.view ?? null });
  result.albumChanges.forEach(applyAlbumImagesChange);   // 新增：主动通道，立即更新计数与缓存，不等事件
  return result;                                   // 修改：原为 void
};
const removeImagesFromAlbum = async (albumId, imageIds, opts?: { view?: ViewQuery | null }) =>
  /* 返回 { removed, albumChanges, view? }，同样先 apply；空 imageIds 仍早退为 { removed: 0, albumChanges: [] } */;
const addTaskImagesToAlbum = async (taskId, albumId, opts?: { view?: ViewQuery | null }) => /* 同上 */;
```
  > 说明：返回值带 `view`，满足 `ctx.mutate` 的 `T extends { view?: ViewSnapshot | null }`。`ctx.mutate`
  > 在 store 写函数返回后才应用视图快照，所以画册计数总是与网格同时或更早更新。原来写函数里手写的
  > `delete albumImages[albumId]` 由 `applyAlbumImagesChange` 统一负责（它还会覆盖到隐藏时受影响的其他画册）。
  > 现有调用方读 `removed` 数字的，改读 `.removed`。
- **新增** 删除图片的调用方（`useImageOperations.handleBatchDeleteImages`、`adapters/album.ts` 的
  `deleteFile.confirm`）拿到 `batch_delete_images` 的返回后调用 `albumStore.applyAlbumImagesChanges(result.albumChanges)`。
- **修改** 直接监听里的 `album-images-change` 回调：缓存失效照旧，计数改为按 reason 查表同步加减
```ts
/** 新增：点 2 的计数表。前端不做任何判断，只查表。 */
const COUNT_RULES: Record<string, { all: number; visible: number }> = {
  add: { all: 1, visible: 1 },
  "add-hidden": { all: 1, visible: 0 },
  delete: { all: -1, visible: -1 },
  "delete-hidden": { all: -1, visible: 0 },
  hide: { all: 0, visible: -1 },
  unhide: { all: 0, visible: 1 },
  order: { all: 0, visible: 0 },
};

let countsSeq = 0;                                  // 新增：最近一次全量计数快照的 seq
let loadingCounts: AlbumImagesChangePayload[] | null = null;   // 新增：全量加载期间到达的变更暂存
const appliedSeqs = new BoundedSet<number>(4096);   // 新增：已应用的 seq（命令返回与事件两路共用，保留最近 4096 个）

/** 新增：唯一的应用入口，命令返回（主动）与事件监听（被动）都调它。 */
const applyAlbumImagesChange = (p: AlbumImagesChangePayload) => {
  if (appliedSeqs.has(p.seq)) return;               // 另一路已应用过这一条
  appliedSeqs.add(p.seq);
  const id = p.albumIds[0];
  if (id) {                                         // 缓存失效（原监听逻辑，现在两路共用）
    delete albumImages.value[id];
    delete albumPreviews.value[id];
  }
  if (loadingCounts) { loadingCounts.push(p); return; }
  if (p.seq <= countsSeq) return;                   // 已计入全量快照，跳过，避免重复加减
  const rule = COUNT_RULES[p.reason];
  if (!rule || !id || !(id in albumDirectCounts.value)) return;   // 未知 reason / 已删画册 / label_dir 忽略
  const n = p.imageIds.length;
  if (rule.all) albumDirectCounts.value[id] = Math.max(0, albumDirectCounts.value[id] + rule.all * n);
  if (rule.visible) {
    albumHiddenDirectCounts.value[id] = Math.max(0, (albumHiddenDirectCounts.value[id] ?? 0) + rule.visible * n);
  }
  scheduleRecompute();                              // 新增：同一 tick 内多条只重算一次聚合计数（queueMicrotask）
};
const applyAlbumImagesChanges = (list: AlbumImagesChangePayload[]) => list.forEach(applyAlbumImagesChange);

// listen("album-images-change", (e) => applyAlbumImagesChange(e.payload))   // 修改：取代 directCounts / 估算 / 全量重算
```
  > 说明：同步执行、不查库。一条变更最多经两路各到一次（命令返回、事件），先到者生效、后到者被
  > `appliedSeqs` 挡掉；两路到达间隔是毫秒级，4096 的窗口足够。`BoundedSet` 为按插入顺序淘汰的小工具
  > （`Set` + 超限删首个），就近放在 `utils/`。一次隐藏会带来「相关画册数」条变更，所以聚合计数（子树求和）
  > 用 microtask 合并成一次重算。`Math.max(0, …)` 只是防御，变更精确时不应触发。
- **修改** `loadAlbums`：计数改为一次 `get_album_direct_counts`，加载前置 `loadingCounts = []`，拿到快照后
  `countsSeq = snap.seq`，整体替换两套计数，置 `loadingCounts = null`，再逐条重放暂存的变更（`seq <= countsSeq`
  的自动跳过；重放时绕过 `appliedSeqs` 检查，因为它们入队时已登记）。
- **修改** `refreshAlbumDirectCounts(albumIds?)` 改用 `get_album_direct_counts`，只 patch 请求的画册，仅保留给
  手动刷新。`utils/albumMediaTree.ts` 的逐画册 `fetchAlbumDirectCounts` 随之删除（核对其他调用方）。
- **删除** `adjustAlbumDirectCounts`，以及回调里读取 `directCounts`、按 ±imageIds 估算、隐藏画册一变就
  `refreshAlbumDirectCounts(true, 全部画册)` 的代码。
- **不改** 画册**视图**不做增量 patch：`albumImages` 缓存与网格一律失效后重拉（过滤、排序、分页决定了一张图
  是否出现、出现在哪一页）。
- **新增** `ensureAlbumsLoaded()`：`albums` 为空才 `loadAlbums()`，供对话框类调用方使用。

## 点 7 — ImageGrid：画册写操作走 `ctx.mutate`，事件监听合一

- **修改** `addToHidden`（`ImageGrid.vue:877`）
```ts
await refreshCtx.mutate((view) =>
  isUnhide
    ? albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids, { view })   // 修改：带视图
    : albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids, { view }),
);
```
- **修改** 同样改走 `ctx.mutate` 的还有：`useImageOperations.ts` 的 `handleBatchHideImages`；
  `adapters/album.ts` 的 `remove.confirm` 与 `swipeRemove`（已接收 `ctx`）；`useImageOperations.ts:412`
  新建画册并加入、`composables/useAlbumOperations.ts` 的两处加入——实施时核对调用上下文，在 ImageGrid 内的
  接 `mutate`，不在的保持原样。
- **修改** `AddToAlbumDialog.vue` 增加可选 prop `mutate`（类型 `GridRefreshContext["mutate"]`），内部写入改为
  `(props.mutate ?? ((op) => op(null)))((view) => albumStore.addImagesToAlbum(albumId, ids, { view }))`；
  ImageGrid 传 `:mutate="mutate"`，其他使用处不传，行为不变。
- **修改** `GridAdapter`（`components/imageGrid/types.ts`）
```ts
changes?: { relevant?: (batch: ChangeBatch) => boolean };   // 修改：取代 imagesChange + albumImagesChange
// 删除：albumImagesChange、GridEventRefreshConfig
```
  各 adapter 的 `relevant`——隐藏 / 取消隐藏由后端附带的 `images-change` 兜底，adapter 里不再出现 HIDDEN：
  - gallery：`images.size > 0 || (effectiveNoAlbum && albumIds.size > 0) || albumStructure.size > 0`
    > 说明：纯收藏批次不重拉，只由下面的星标订阅 patch——与旧逻辑一致；no-album 过滤下任何成员变化都影响结果。
  - album(id)：`images.size > 0 || albumIds.has(id)`
  - task(tid)：`images.size > 0 && (wildcard.task || taskIds.has(tid))`
  - surf(rid)：同 task，换成 `surfRecordIds` / `wildcard.surf`
  > 说明：隐藏发出的兜底 `images-change` 不带 `taskIds`，任务 / 畅游详情按 wildcard 视为命中——正是需要的，
  > 因为隐藏会改变它们的可见结果。
- **新增** ImageGrid 内一条独立的 hub 订阅：`filter: b => b.favoriteOps.length > 0`，`waitMs` 同网格，按顺序对
  当前页 `patch(op.imageIds, { favorite: op.favorite })`。
  > 说明：与视图重拉分开，收藏批次无论是否「相关」都要更新星标；自身操作的回声重复 patch 同值，无害。
- **删除** ImageGrid 的 `useAlbumImagesChangeRefresh` 调用；gallery adapter 的 `albumImagesChange`
  （星标 patch 已由上一条取代）；album adapter `imagesChange.relevant` 里的 `delete albumStore.albumImages[id]`
  （store 的直接监听已负责缓存失效）；album adapter 的 `onAddedToAlbum` 中的 `loadAlbums()`。
- **修改** `liveQuery.ts`：`refetch` 注释去掉 album-images-change 的特例说明（该路径已不存在），逻辑不变。

## 点 8 — 其他消费者

- **删除** `AlbumTreePanel.vue:369` 的 10s 全量兜底重算；核对 `refreshEvent` prop 的调用方，无人使用则一并删除。
  > 说明：store 计数已按精确增量同步维护，兜底只会周期性制造 2N 次查询。
- **修改** `AddToAlbumDialog.vue`：打开时 `loadAlbums()` → `ensureAlbumsLoaded()`；删除
  `getAlbumImageIds` 前端去重，改用命令返回的 `AddToAlbumResult`（`attempted - added` 即跳过数）。
  > 说明：实施时先核对 `storage::add_images_to_album` 对已在画册中的图片确实跳过并计入 `attempted`。
- **删除** `GalleryToolbar.vue:197` 专盯 HIDDEN 的 `useAlbumImagesChangeRefresh`，以及
  `galleryFilterTree/refreshSources.ts` 里过滤 HIDDEN 的 `album-images-change` source。
  > 说明：隐藏 / 取消隐藏现在一定附带 `images-change`，两者已有的 `images-change` 监听即可覆盖；否则一次
  > 隐藏会让它们各刷新两次。实施时核对 `facetTreeSource.ts:467/479` 对 `album-images-change` 的其他用途。
- **不改** `ImageLabelsPanel.vue` 的成员监听、`HiddenCleanupControl.vue`（读 store 计数，自动跟随）。
  > 说明：`ImageLabelsPanel` 按 `imageIds` 过滤，单画册事件照常可用；有了 `EventHold`，用户操作的快照在
  > 这些监听触发前已读完，不再拖慢网格。
- **已知例外** `ImageLabelsPanel` 在预览里增删标签不走 `mutate`：预览打开时替换底层列表会让预览跳页，
  继续由被动通道 500ms 后刷新。

## 点 9 — 规则、文档、回归

- **修改** `.cursor/rules/view-mutation.mdc`：删除「隐藏/取消隐藏、加入/移出画册、上划移除」三条例外，
  保留 `ImageLabelsPanel`；新增一条「带 `view` 的写命令必须在写库前 `GlobalEmitter::hold()`，快照读完再
  放行」。
- **修改** `AGENTS.md` 的「ImageGrid 视图写操作」摘要同步上述两点。
- **修改** `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`：`album-images-change` 带 `seq` 且无
  `directCounts`、hub 的画册维度、`EventHold`、`album-images-change` 按画册拆分与七种 reason 的计数表、隐藏附带兜底 `images-change`、store 计数查表加减 + 初始化批量 COUNT；`cocs/downloader-tasks/DOWNLOADER_FLOW.md`
  中关于 `directCounts` 的描述；`cocs/README.md` 对应条目。
- **修改** `versions/latest/regression.md` 追加回归：
  - 画廊 / 画册 / 任务 / 畅游中隐藏、取消隐藏（隐藏画册内），命令返回即更新，不闪回；
  - 画册内移出、上划移除、删除文件；
  - 加入画册（右键、多选、新建画册并加入、任务一键加入），跳过数提示正确；
  - 隐藏后画册树两套计数（开/关「隐藏」）与清理隐藏按钮的数字立即正确（与关闭再打开应用后的全量计数一致）；
  - 隐藏后画册计数与网格同时更新，随后到达的事件不会再加减一次（与重启后的全量计数一致）；
  - 重复加入已在画册中的图、重复收藏，计数不变；删除同时属于多个画册的图，各画册各减正确数量；
  - 把已隐藏的图加入 / 移出普通画册、删除已隐藏的图，「排除隐藏」计数不变、直接计数正确；
  - 隐藏后切到另一个 keep-alive 视图（如任务详情），该视图已由兜底 `images-change` 刷新；
  - 下载进行中隐藏，隐藏结果不被旧的防抖拉取覆盖；
  - 删除含子画册的画册后，no-album 过滤的画廊刷新；
  - 改标签 key / 移动标签后，按标签搜索的画廊结果刷新；
  - 其他入口（预览标签面板、MCP）收藏或增删成员，当前网格星标/列表同步；
  - 打开「加入画册」对话框不再触发全量计数。

## 实施顺序

点 1 → 点 2 → 点 3 → 点 4（后端，跑 `check-kabegame --skip vue`）→
点 5 → 点 6 → 点 7 → 点 8 → 点 9（前端，跑 `check-kabegame --skip cargo`）→ 用 `kabegame-chromium` 在真实
应用里走回归清单（需用户先启动 dev；未启动则跳过并在总结中说明）。

## 不在本期

- `GalleryToolbar`、过滤树、`ImageLabelsPanel` 的 `images-change` 监听迁入 hub（本期只删它们专盯 HIDDEN 的那条）。
- 收藏命令批量化（`toggleFavoriteForImages` 仍逐张调 `toggle_image_favorite`）。
- 多读连接 / 连接池：单连接是排队的根因，但改存储层的风险与本期目标不成比例；本期只减少排队的量。
