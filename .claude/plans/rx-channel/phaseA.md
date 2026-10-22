# kbEvents Phase A：ImageGrid 行与总数迁到 rxjs 事件源 + pathql 数据源

状态：已完成（2026-10-21）。`dataChangeHub` / `liveQuery` 迁移期保留，其它页面在后续阶段跟上。

> 修订（同日）：
> 1. 初版让一致性依赖后端快照 `seq`（`pathql_view` / `pathql_count` 返回 `{ rows|total, seq }`），
>    并在写操作期间暂存事件、按 `seq` 跳过本次写的回声。已改为下文的请求序列模型：行用 `pathql_fetch`、
>    总数用 `pathql_count`（只取 `total`），序号由前端请求服务分配，不再区分操作是否写入，也不再有 `hold`。
> 2. 第二版的订阅方（`useLivePathql`）自己防抖、自己发请求，是 queryer。已改为观察方模型：订阅方只是某个 key
>    的 looker，只看数据、注册过滤器；事件窗口（统一 500ms）与请求都由 pathql 核心处理，同一 key 的过滤器
>    任一同意就在该窗口刷新一次，并更新所有观察方看到的数据。

### 总体设计思路

旧的 `dataChangeHub` 把所有事件合并成一个大而全的 `ChangeBatch`（图片、画册、任务、运行配置等字段都在一个结构里），
每个订阅者用 `filter(batch)` 从中挑自己关心的字段；后端写命令则携带 `view` 路径、在写库前 `GlobalEmitter::hold()`
压住事件、读完行快照随响应返回，前端直接把返回值写进列表。这让中心必须认识每一种事件，也把「视图」这个前端概念塞进了后端写命令。

Phase A 把异步问题建模成两类触发 + 一个请求序列：

- **任何时候都有事件**，事件防抖之后可能请求刷新；
- **任何时候用户都可能操作**，不防抖、直接请求刷新；
- 前端不关心操作是否写入，只管**请求序列与请求状态**；所有使用方都只想要最新的数据。

落到代码是**三层、两种 observable**：

1. **事件源**（`kbEvent$`）：每个后端事件名一个共享 observable，底层就是现有的 `listen`（Tauri 事件或 Web SSE），
   对内容无感。消费方用 `on(event, relevant)` 声明「一种事件 + 相关性判断」，多条触发由 `triggers$` 合成一条刷新信号流。
2. **pathql 核心**（单例）：按 `kind + key` 维护请求序列、数据状态与观察方注册。请求（`requestPathql`）每次序号 +1，
   可与在途请求并行；返回时序号大于当前数据状态的就更新，更小的静默丢弃：

   ```
   无数据 → 请求1 返回 → 更新
   请求2 未返回时请求3 也发出 → 2 先返回：更新（最近返回的请求）→ 3 返回：序号更大，更新
   接连发出 A、B → B 先返回：更新 → A 返回：序号更小，静默丢弃
   ```

   请求本身不把结果交还给调用方去写。事件刷新也由核心处理：每个 key 一个统一的 500ms 窗口
   （`PATHQL_REFRESH_WAIT_MS`，经 `batchWindow`：空闲首票立即刷新，窗口内的票合并到窗口结束再刷新一次）。
3. **观察方**（`lookPathql` / `usePathqlLooker`）：某个 key 的 looker，只看该 key 的数据状态（始终表示
   「最近发出且已返回」的那次请求）、在途状态与事件刷新失败，不发请求、不带防抖时间。注册时带上自己的过滤器
   （`refreshOn`），同一 key 所有观察方的过滤器向核心的同一个窗口投票，任一同意就刷新一次，结果推给全部观察方。
   数据流和事件源是两种不同的 observable：事件源是「发生了什么」，数据流是「现在是什么」。

用户操作（首次加载、翻页、手动刷新、写操作完成后）由发起方直接调 `requestPathql`，不经窗口；结果同样只经观察方落地。

关键决策：

- **写命令不再返回快照，事件照常广播**。主应用前端以外还有后台任务、MCP、CLI、Web 多窗口靠事件同步，
  不能为「前端少读一次」去区分是否发事件。写完后前端把它当成一次用户操作直接请求；随后到达的本次写的事件
  再经防抖触发一次请求——允许多读，两次请求按序号落地，结果一致。
- **序号由前端请求服务分配，与后端事件 `seq` 无关**。应用规则是「大于当前数据状态的序号」，而不是「只认最后发出的那次」：
  后者在持续下载、单次读取超过防抖窗口时会让每个结果都被下一次请求作废，列表永远不更新。
- **订阅方只看不查**。窗口与请求集中在核心：同一 key 被多个组件观察时只有一个窗口、一份请求序列，
  不会因为订阅方各自防抖而重复请求；观察方也就不需要各自的防抖时间。
- **每条触发只对一种事件**，中心不认识事件内容；类型表 `KbEventMap` 只是给 `on()` 用的类型门面。

### 现状锚点（Phase A 之前）

**a. hub 的大一统批次**（`services/dataChangeHub.ts`）
```ts
export interface ChangeBatch {
  runConfigs: Map<string, RunConfigChange>;
  images: Set<string>;          // images-change 的 reason
  imageIds: Set<string>;
  imagePatches: Map<string, Partial<ImageInfo>>;
  taskIds: Set<string>;
  // ……画册、收藏、结构、路径、wildcard 等十余个字段，所有事件共用一个结构
  maxSeq: number;
}
```

**b. ImageGrid 的 live 查询按批次字段过滤**（`components/ImageGrid.vue`）
```ts
const rowsQuery = useLiveQuery<RowsSnapshot>({
  key: currentRowsPath,
  read: pathqlView,                                                 // 现状：后端返回 { rows, seq }
  waitMs: GRID_REFRESH_WAIT_MS,
  relevant: (batch) => adapter.changes?.relevant?.(batch) ?? true, // 现状：跨事件类型的大批次
  onResult: applyRows,
});
```

**c. 写操作携带 view，直接应用返回快照**（`components/ImageGrid.vue`）
```ts
const mutate = async (op) => {
  const view = rowsQuery.key();
  const result = await op(view);                       // 现状：把行路径传给后端
  if (result.view && view === rowsQuery.key()) await rowsQuery.apply(result.view); // 现状：直接写入
  return result;
};
```

**d. 后端写命令压事件、读快照**（`kabegame-core/src/commands/album.rs`）
```rust
pub async fn add_images_to_album(album_id: String, image_ids: Vec<String>, view: Option<String>) -> Result<Value, String> {
    let _hold = view.as_ref().map(|_| GlobalEmitter::global().hold()); // 现状：写期间压住事件
    // ……写库、发事件
    if let Some(path) = view {
        out["view"] = serde_json::to_value(snapshot_rows(path).await?)?; // 现状：随响应返回行快照
    }
    Ok(out)
}
```

### 点 1 — 事件源与防抖算子（`services/kbEvents/eventSource.ts`、`batchWindow.ts`、`events.ts`）
- **新增**
  - `kbEvent$(name)`：同名事件只 `listen` 一次、`share()` 给所有订阅者，最后一个退订后释放监听。
  - `batchWindow(waitMs, reduce)`：空闲时首个事件立即成批；窗口内的事件攒成一串，窗口结束时 `reduce` 成消费方自己的批次类型。
    > 说明：尾批发出后重新开窗（与 rxjs `throttleTime` 一致），持续下载时约每 `waitMs` 一次请求。
  - `on(event, relevant)` / `triggers$(triggers)` / `albumChangeKinds(payload)` 与类型表 `KbEventMap`。
```ts
export function kbEvent$<T = unknown>(name: string): Observable<KbEvent<T>>; // { name, seq, payload }
export function on<K extends keyof KbEventMap>(event: K, relevant?: (p: KbEventMap[K]) => boolean): EventTrigger;
export function triggers$(triggers: readonly EventTrigger[]): Observable<KbEvent>; // 只作刷新信号
```

### 点 2 — pathql 核心（`services/kbEvents/pathqlSource.ts`）
- **新增**
  - `requestPathql(kind, key)`：唯一请求入口。`rows` 读 `pathql_fetch`，`total` 读 `pathql_count` 的 `total`；
    返回的 promise 在结果处理完后 resolve，只用于等待与接错误。用户操作直接调用。
  - `lookPathql(kind, key, refreshOn)`：订阅期间注册一个观察方，发出 `data` / `loading` / `error` 三种信号；
    `refreshOn` 订阅期间向该 key 的刷新窗口投票。
  - 每个 key 一个刷新窗口（`votes$.pipe(batchWindow(PATHQL_REFRESH_WAIT_MS))`），窗口触发时由核心调用 `requestPathql`，
    失败经 `error` 信号推给观察方。
    > 说明：条目在无观察方且无在途请求时回收（同时停掉窗口），避免把已离开路径的旧数据重放给后来者。
```ts
export async function requestPathql(kind: PathqlKind, path: string): Promise<void> {
  const entry = acquire(kind, path);
  const seq = ++entry.requested;                 // 请求序号，前端分配
  // ……pending + 1
  const snapshot = await readers[kind](path, seq);
  if (seq > entry.applied) {                     // 更大的序号更新数据状态
    entry.applied = seq;
    entry.data$.next(snapshot);
  }                                              // 更小的静默丢弃
  // ……pending - 1、release
}
```

### 点 3 — 组合式观察方 `usePathqlLooker`（`services/kbEvents/usePathqlLooker.ts`）
- **新增**
  - key 变化时 `switchMap` 注销旧 key、注册新 key（旧路径的迟到结果与 loading 不影响新路径），key 为 null 时不注册；
  - 只返回 `loading`；数据交给 `onResult`，事件刷新失败交给 `onError`；不带防抖时间、不发请求。
```ts
const rowsLooker = usePathqlLooker({
  kind: "rows",
  key: currentRowsPath,
  refreshOn: adapter.refreshOn,   // 过滤器注册到核心
  onResult: applyRows,
  onError: (error) => void adapter.onLoadError?.(error, rawViewPath()),
});
// 用户操作：发起方直接请求
const requestRows = async () => {
  const key = currentRowsPath();
  if (key) await requestPathql("rows", key);
};
```

### 点 4 — ImageGrid 与 adapter（`components/ImageGrid.vue`、`components/imageGrid/`）
- **修改**
  - 行与总数各注册一个观察方，共用 `adapter.refreshOn` 作为过滤器；总数在计数路径变化时由 ImageGrid 自己请求，
    翻页不改计数路径就不重读（总数逻辑保持不变，仍服务分页与各页副标题）。
  - `mutate` 改为「操作 → 直接请求行与总数」，签名从 `(op: (view) => …)` 变为 `(op: () => …)`。
  - `GridAdapter.changes.relevant(batch)` 改为 `refreshOn: EventTrigger[]`，每条一种事件。
```ts
const mutate: GridRefreshContext["mutate"] = async (op) => {
  const result = await op();            // 修改：不再传 view
  await Promise.all([                   // 新增：作为用户操作直接请求，结果仍从数据源落地
    requestRows().catch((error) => adapter.onLoadError?.(error, rawViewPath())),
    requestTotal().catch(handleCountError),
  ]);
  return result;
};
```
```ts
// adapters/album.ts
refreshOn: [
  on("images-change", (p) => !!params.albumId() && !!p.reason),
  on("album-images-change", (p) => (p.albumIds ?? []).includes(params.albumId())),
  on("album-changed", (p) => p.albumId === params.albumId() && (albumChangeKinds(p).structure || albumChangeKinds(p).row)),
],
```
  - gallery：带 reason 的 `images-change`；「无画册」视图下的 `album-images-change`；改结构字段（「无画册」下也含行字段）的 `album-changed`。
  - task / surf：`images-change` 按 `taskIds` / `surfRecordIds` 命中或缺维度。
  - `album-added` / `album-deleted` 旧 liveQuery 实际被跳过（无 `seq`），暂不列入，保持原行为。
- **删除**
  - ImageGrid 中 `useLiveQuery`、`pathqlView` 与 `rowsQuery.apply` 的使用、mutate 内的 DEBUG-PERF 埋点。

### 点 5 — 写命令去掉 view（core / Tauri / web dispatch，及前端调用方）
- **修改**
  - `batch_delete_images`、`batch_remove_images`、`add_images_to_album`、`add_task_images_to_album`、`remove_images_from_album`
    去掉 `view` 参数、`hold()` 与返回快照；web dispatch 去掉 `/view/rows` 改写。
  - 前端 `services/albums.ts` 三个函数去掉 `opts.view`，结果类型去掉 `view`；`useImageOperations`、`AddToAlbumDialog`、album adapter 改为 `mutate(() => …)`。
```rust
pub async fn add_images_to_album(album_id: String, image_ids: Vec<String>) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?; // 事件照常广播
    #[cfg(feature = "virtual-driver")]
    VirtualDriveService::global().notify_album_dir_changed(&album_id);
    serde_json::to_value(r).map_err(|e| e.to_string())             // 删除：view 快照
}
```

### 点 6 — 依赖、测试与文档
- **新增**
  - `rxjs@^7.8.2`（`apps/kabegame/package.json`；`concurrently` 仍用其嵌套的 6.6.7）。
  - `kbEvents.test.ts`：防抖窗口、事件共享监听；请求序列按上文时序逐步断言（含 A/B 乱序丢弃）、总数取 `total` 且序号由前端分配、
    新订阅者拿到当前数据；事件防抖只在开头与结尾各请求一次、用户操作在防抖窗口内也立即请求、事件与用户请求并行时晚发出者优先、
    未激活标脏后请求、换路径不受旧请求影响。
- **修改**
  - `ImageGrid.previewFollowPage.test.ts` 的 mock 改到 `@/services/kbEvents`。
  - `.cursor/rules/view-mutation.mdc`、`AGENTS.md`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/README.md`、`versions/latest/{regression,changelog}.md`。

### 验证

- vue-tsc 0 error（初版另跑过 cargo check 0 error）；前端 Vitest 39 个文件、310 项通过。核心窗口用例：
  同一 key 多观察方各带过滤器、任一同意即刷新一次并推给全部观察方；统一 500ms 窗口合并多票；观察方全部退订后不再刷新；
  事件刷新失败推给观察方。观察方用例：不发请求、key 为 null 不注册、换 key 后旧结果与旧过滤器不影响新 key。
- dev 真机 + debug ingest（临时插桩已删除）：
  - 画廊右键隐藏首图 8164（按 id 校验，不看「首张 + 总数」，避免后台收集期间数据变化造成误判）：8164 离开网格、
    `is_hidden=1`，总数 4069 → 4068。rows / total 各请求两次：mutate 的用户请求（序号 2）与约 13ms 后本次写的事件
    经核心窗口的请求（序号 3，空闲首票立即发出），按序号依次落地。
  - 直接调 `remove_images_from_album` 模拟外部取消隐藏：8164 回到首位、`is_hidden=0`、总数回到 4069，
    只由核心窗口刷新，rows / total 各请求 1 次（序号 4）；画廊与画册视图各自只对相关事件刷新。
  - 停在画册页时隐藏 / 取消隐藏 8164 再切回画廊：重新挂载即读到最新行与总数，各请求 1 次。
    注意：改 kbEvents 源码后的 HMR 会让 `@/router` 重建出未挂到 app 的实例，gallery adapter 的 `isActive` 恒为 false，
    切回画廊为空；整页重载即恢复，真机测试前先重载。
- 未真机：永久删除、上划移除、加入画册对话框、后台下载节奏、「无画册」视图、Web SSE、Android（见回归文档）。

### 已知边界

- 写操作每次会多一次请求（用户请求 + 本次写的事件经防抖再请求），按模型接受。
- 同一 key 被多个组件观察时共用核心的一个窗口，事件只刷新一次；但用户请求不合并在途请求。
- `App.vue` 的 `<keep-alive>` 被注释，切页即重新挂载，「标脏后重新激活请求」当前在桌面不可达，仅单测覆盖。
- `ctx.patch` 与字段补丁（`image-changed`、收藏 `favoriteOps`）仍经 `dataChangeHub`。
- 后端 `pathql_view` 不再被 ImageGrid 使用，但运行配置仍在用，Phase C 迁完后删除。

---

## 接下来的计划

按「模式」推进，每个阶段迁完一类消费方并删掉它在 `dataChangeHub` 上的订阅；全部迁完后删除 hub 与旧实现。

### Phase B — 字段补丁流（不发请求）— 已完成（2026-10-21）
- **新增** `services/kbEvents/imagePatches.ts`：`imagePatches$(waitMs)` 把 `kbEvent$("image-changed")` 与
  `kbEvent$("album-images-change")` 各自经 `batchWindow` 合并成 `Map<imageId, Partial<ImageInfo>>`
  （`reduceImageChanged`：同 id 后到字段覆盖；`reduceFavoriteChanges`：只看收藏画册，按到达顺序取最后一次），再 `merge`。
  两者字段不重叠（后端 `image-changed` 从不带 `favorite`），两条流之间无需排序。`GRID_REFRESH_WAIT_MS` 迁入 `kbEvents/constants.ts`，`liveQuery` 改为转出。
- **修改** ImageGrid：`subscribeChanges` → `imagePatches$(GRID_REFRESH_WAIT_MS).subscribe(patchMany)`，不再 import `dataChangeHub` / `liveQuery`。
- **修改** `ImagePreviewDialog`（裸 id 模式）：补丁走 `imagePatches$(300)`；粗信号重读改为
  `triggers$([on("images-change", 带 reason 或含本 id), on("album-images-change", 含本 id)])` + `batchWindow`，`resolveToken` 留给 Phase D。
- **行为差异**：画册写命令经 `publishLocal` 本地投递的收藏补丁不再即时到达这两处，改为等后端事件（照常广播）；
  UI 自身的收藏切换仍走 `ctx.patch` 立即生效。
- **验证**：vue-tsc 0 error，Vitest 39 文件 / 308 项；dev 真机直接调命令验证收藏补丁与 `image-changed` 窗口合并（见回归文档）。

### Phase C — 其余实时数据消费方
- **pathql 计数类**：`GalleryToolbar` 的分子 / 分母（注册为计数路径的观察方，与 ImageGrid 同路径时共享同一窗口与数据，顺带去掉 `useImagesChangeRefresh`）、
  `GalleryFilterControl.loadFilterCounts`（现在没有过期保护，并发时会交错写入）、`HiddenCleanupControl`、Surf 页计数。
- **树 / 列举类**：`GalleryFacetTreeInner` 侧栏、`AlbumTreeView` / `useAlbumQuery`（按 `ancestorPath` 相关性）。
  它们读的是 `listProviderDirs` / `albums://` 分页而非单一 rows/count，需要给请求服务加一种「列举」kind，或让组件在事件触发后自行分页重读。
- **运行配置**：`usePagedRunConfigs` / `runConfigs.ts` / `runConfigWrites.ts` 仍是「写命令带 `view` + 后端 `hold` + 返回快照 + 前端 `holdRunConfigEvents`」。
  改成与 ImageGrid 相同的「操作后直接请求」，后端 `add/update/delete/copy_run_config` 去掉 `view` 与 `hold()`；
  推荐导入态单独作为一个数据源（它不是 pathql）。完成后 `GlobalEmitter::hold()` / `EventHold`、`pathql_view` 不再有调用方，可一并删除。

### Phase D — 用户意图类请求（`switchMap`，只认最新一次）
- **对象**：ImageGrid 预览定位（`locatePreviewedImage` + `pendingPreviewLocate` + 多个 watch 拼成的状态机）、`ImagePreviewDialog` 的 `resolveToken`。
- **做法**：意图流 `switchMap` 到 `rank → 跳页 → 等 rowsQuery 数据源里出现满足条件的数据（filter + take(1)）`，
  用户切图 / 换视图 / 关跟页即取消。这类触发来自用户而非事件流，「只认最新一次」在这里是对的。

### Phase E — 纯失效与收尾
- `galleryFilterTree/context.ts` 的 `pureListCache` 失效直接 `subscribe` 事件源即可。
- `ImageLabelsPanel` 的被动刷新改为 `kbEvent$` 订阅（保留「预览内不替换底层列表」的例外语义）。
- **本地发布**：画册写命令返回的 `albumChanges` 目前经 `publishLocal` 立即投递给画册树等。迁完后改为写服务对受影响的数据源直接请求，
  不再需要本地注入事件。
- 删除 `dataChangeHub.ts`、`liveQuery.ts`（`GRID_REFRESH_WAIT_MS` 迁入 `kbEvents`）、`useImagesChangeRefresh.ts`、`useAlbumImagesChangeRefresh.ts` 中的监听部分，
  同步更新 `.cursor/rules/view-mutation.mdc`、`AGENTS.md` 与 cocs 文档。

### 待定事项
- 是否恢复 `<keep-alive>`：恢复后「隐藏期标脏后请求」才会在真机生效，需要补一轮回归。
- 计数数据源跨组件共享时，是否需要在无订阅者后保留一小段 LRU（目前即刻回收，换回旧路径一定重读）。
- 是否让写操作完成后的用户请求与紧随其后的核心窗口请求合并（目前写后两者几乎同时各发一次）。
