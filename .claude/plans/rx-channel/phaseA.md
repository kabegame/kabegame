# kbEvents Phase A：ImageGrid 行与总数迁到 rxjs 事件源 + pathql 数据源

状态：已完成（2026-10-21）。`dataChangeHub` / `liveQuery` 迁移期保留，其它页面在后续阶段跟上。

### 总体设计思路

旧的 `dataChangeHub` 把所有事件合并成一个大而全的 `ChangeBatch`（图片、画册、任务、运行配置等字段都在一个结构里），
每个订阅者用 `filter(batch)` 从中挑自己关心的字段；后端写命令则携带 `view` 路径、在写库前 `GlobalEmitter::hold()`
压住事件、读完行快照随响应返回，前端直接把返回值写进列表。这让中心必须认识每一种事件，也把「视图」这个前端概念塞进了后端写命令。

Phase A 把它拆成**三层、两种 observable**：

1. **事件源**（`kbEvent$`）：每个后端事件名一个共享 observable，底层就是现有的 `listen`（Tauri 事件或 Web SSE），
   只取出 payload 的 `seq`，对内容无感。消费方用 `on(event, relevant)` 声明「一种事件 + 相关性判断」，
   多条触发再由 `triggerSeq$` 合成一条「相关变更 seq」流。
2. **pathql 请求服务**（`requestPathql`，单例）：按 `kind + path` 维护最新 `seq` 与在途读取。它有两种触发通道——
   事件通道（可合并在途读取，按 `minSeq` 跳过或补读）与请求通道（首次加载、翻页、手动刷新、写后补读，总是新开读取）。
   请求本身不把结果交还给调用方去写。
3. **数据源**（`pathqlData$`）：每个路径的 rows / count 快照流，`seq` 不倒退。两种通道的结果都只从这里落地，
   消费方订阅它拿最新数据。它和事件源是两种不同的 observable：事件源是「发生了什么」，数据源是「现在是什么」。

`useLivePathql` 把三层装配成 Vue 组合式：key 变化时切换订阅的数据源（旧路径的迟到结果与 loading 自动丢弃），
事件经 `batchWindow` 防抖（空闲首个立即发、窗口内合并到窗口结束），写操作期间用 `hold()` 暂存事件通道。

关键决策：

- **写命令不再返回快照，事件照常广播**。主应用前端以外还有后台任务、MCP、CLI、Web 多窗口靠事件同步，
  不能为「前端少读一次」去区分是否发事件。写完后前端立即经请求通道补读，结果依然从数据源落地；本次写产生的事件
  `seq` 不大于补读快照的 `seq`，到达时被跳过，因此无论事件先于还是晚于响应到达，都只读一次。
- **一致性靠后端的全局 `seq` 而不是客户端请求计数**。`pathql_view` / `pathql_count` 先读 `seq` 再查询，
  快照 `seq = S` 表示 `seq ≤ S` 的事件都已包含。客户端计数（「只认最新一次请求」）在持续下载时会让每个结果都被
  下一次请求作废，列表永远不更新；它只适合用户意图类请求（Phase D）。
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
  read: pathqlView,
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
    > 说明：尾批发出后重新开窗（与 rxjs `throttleTime` 一致），持续下载时约每 `waitMs` 一次，比旧 hub 少一半请求。
  - `on(event, relevant)` / `triggerSeq$(triggers)` / `albumChangeKinds(payload)` 与类型表 `KbEventMap`。
```ts
export function kbEvent$<T = unknown>(name: string): Observable<KbEvent<T>>; // { name, seq, payload }，seq 缺失为 0
export function on<K extends keyof KbEventMap>(event: K, relevant?: (p: KbEventMap[K]) => boolean): EventTrigger;
export function triggerSeq$(triggers: readonly EventTrigger[]): Observable<number>;
```

### 点 2 — pathql 请求服务与数据源（`services/kbEvents/pathqlSource.ts`）
- **新增**
  - `requestPathql(kind, path, { minSeq, join })`：两种通道共用的唯一请求入口；返回的 promise 在结果发布后 resolve，只用于等待与接错误。
  - `pathqlData$(kind, path)`：rows / count 数据源，`ReplaySubject(1)`，只发 `seq` 不倒退的快照。
  - `pathqlLoading$(kind, path)`：该路径是否有在途读取。
    > 说明：条目在无订阅者且无在途读取时回收，避免把已离开路径的旧数据重放给后来者。
```ts
// 事件通道：数据源已覆盖 minSeq 则跳过；合并到的在途读取早于 minSeq 则再读一次
await requestPathql("rows", path, { minSeq: seq, join: true });
// 请求通道：总是新开读取（首次加载 / 翻页 / 手动刷新 / 写后补读）
await requestPathql("rows", path);
```

### 点 3 — 组合式 `useLivePathql`（`services/kbEvents/useLivePathql.ts`）
- **新增**
  - 订阅当前 key 的数据源与 loading（`switchMap`），结果交给 `onResult`；
  - 事件通道：`changes` 经 `batchWindow` 合并为最大 `seq`，`seq ≤ appliedSeq` 不请求，key 为 null 时标脏、重新激活补读；
  - `refetch()`（请求通道，错误抛给调用方）、`hold()`（写期间暂存事件通道，释放时已覆盖的序号跳过）、`autoFetch`（总数用）。
```ts
const rowsQuery = useLivePathql({
  kind: "rows",
  key: currentRowsPath,
  changes: relevantChanges$,      // triggerSeq$(adapter.refreshOn)
  waitMs: GRID_REFRESH_WAIT_MS,
  onResult: applyRows,
  onError: (error) => void adapter.onLoadError?.(error, rawViewPath()),
});
```

### 点 4 — ImageGrid 与 adapter（`components/ImageGrid.vue`、`components/imageGrid/`）
- **修改**
  - 行与总数改用 `useLivePathql`，共用一条 `triggerSeq$(adapter.refreshOn)`；总数逻辑保持不变（仍服务分页与各页副标题）。
  - `mutate` 改为「暂存事件 → 写 → 请求通道补读行与总数 → 放行」，签名从 `(op: (view) => …)` 变为 `(op: () => …)`。
  - `GridAdapter.changes.relevant(batch)` 改为 `refreshOn: EventTrigger[]`，每条一种事件。
```ts
const mutate: GridRefreshContext["mutate"] = async (op) => {
  const releaseRows = rowsQuery.hold();   // 新增：写期间暂存事件通道
  const releaseTotal = totalQuery.hold();
  try {
    const result = await op();            // 修改：不再传 view
    await Promise.all([                   // 新增：写后立即补读，结果仍从数据源落地
      rowsQuery.refetch().catch((error) => adapter.onLoadError?.(error, rawViewPath())),
      totalQuery.refetch().catch(handleCountError),
    ]);
    return result;
  } finally {
    releaseRows();
    releaseTotal();
  }
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
  - `album-added` / `album-deleted` 不带 `seq`，旧 liveQuery 实际也跳过，不列入。
- **删除**
  - ImageGrid 中 `useLiveQuery` 与 `rowsQuery.apply` 的使用、mutate 内的 DEBUG-PERF 埋点。

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
  - `kbEvents.test.ts`：防抖窗口、事件共享监听、`seq` 不倒退、合并在途 + `minSeq` 补读、写期间暂存与放行跳过、未激活标脏补读、换路径不受旧读取影响。
- **修改**
  - `ImageGrid.previewFollowPage.test.ts` 的 mock 改到 `@/services/kbEvents`。
  - `.cursor/rules/view-mutation.mdc`、`AGENTS.md`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/README.md`、`versions/latest/{regression,changelog}.md`。

### 验证

- vue-tsc + cargo check 0 error；前端 Vitest 39 个文件、305 项通过。
- dev 真机 + debug ingest（临时插桩已删除）：
  - 画廊右键隐藏：400ms 内列表与总数更新（3988 → 3987），rows / total 各读 1 次；事件晚于响应到达，按 `seq` 跳过。
  - 收藏画册右键移除：事件早于响应到达，写期间暂存，放行时已覆盖，rows / total 各读 1 次。
  - 直接调命令模拟外部写入：防抖首发立即请求，画廊与画册视图各自只对相关事件刷新。
- 未真机：永久删除、上划移除、加入画册对话框、后台下载节奏、「无画册」视图、Web SSE、Android（见回归文档）。

### 已知边界

- `App.vue` 的 `<keep-alive>` 被注释，切页即重新挂载，「标脏后重新激活补读」当前在桌面不可达，仅单测覆盖。
- `ctx.patch` 与字段补丁（`image-changed`、收藏 `favoriteOps`）仍经 `dataChangeHub`。
- `services/liveQuery.ts` 仍承载 `RowsSnapshot` / `TotalSnapshot` 类型与 `GRID_REFRESH_WAIT_MS`，被 `kbEvents` 引用。

---

## 接下来的计划

按「模式」推进，每个阶段迁完一类消费方并删掉它在 `dataChangeHub` 上的订阅；全部迁完后删除 hub 与旧实现。

### Phase B — 字段补丁流（不发请求）
- **对象**：ImageGrid 的 `patchMany` 订阅、`ImagePreviewDialog` 对当前 id 的补丁。
- **做法**：`kbEvent$("image-changed")` 与收藏相关的 `kbEvent$("album-images-change")` 各自经 `batchWindow` 合并成
  `Map<imageId, Partial<ImageInfo>>`（收藏按到达顺序取最后一次），再同步打到列表与预览对象。
  可加一道「补丁 `seq ≤` 行快照已应用 `seq` 时跳过」——快照已包含该字段。
- **完成标志**：ImageGrid 不再 import `dataChangeHub`。

### Phase C — 其余实时快照消费方（模式 A）
- **pathql 计数类**：`GalleryToolbar` 的分子 / 分母（改用 `useLivePathql` 的 total，与 ImageGrid 同路径时共享数据源，顺带去掉 `useImagesChangeRefresh`）、
  `GalleryFilterControl.loadFilterCounts`（现在没有过期保护，并发时会交错写入）、`HiddenCleanupControl`、Surf 页计数。
- **树 / 列举类**：`GalleryFacetTreeInner` 侧栏、`AlbumTreeView` / `useAlbumQuery`（按 `ancestorPath` 相关性）。
  它们读的是 `listProviderDirs` / `albums://` 分页而非单一 rows/count，需要给请求服务加一种「列举」kind，或让组件在事件通道触发后自行分页重读。
- **运行配置**：`usePagedRunConfigs` / `runConfigs.ts` / `runConfigWrites.ts` 仍是「写命令带 `view` + 后端 `hold` + 返回快照 + 前端 `holdRunConfigEvents`」。
  改成与 ImageGrid 相同的「写后经请求通道补读」，后端 `add/update/delete/copy_run_config` 去掉 `view` 与 `hold()`；
  推荐导入态单独作为一个数据源（它不是 pathql）。完成后 `GlobalEmitter::hold()` / `EventHold` 不再有调用方，可一并删除。

### Phase D — 用户意图类请求（`switchMap`，只认最新一次）
- **对象**：ImageGrid 预览定位（`locatePreviewedImage` + `pendingPreviewLocate` + 多个 watch 拼成的状态机）、`ImagePreviewDialog` 的 `resolveToken`。
- **做法**：意图流 `switchMap` 到 `rank → 跳页 → 等 rowsQuery 数据源里出现满足条件的快照（filter + take(1)）`，
  用户切图 / 换视图 / 关跟页即取消。这类触发来自用户而非事件流，客户端「只认最新」在这里是对的。

### Phase E — 纯失效与收尾
- `galleryFilterTree/context.ts` 的 `pureListCache` 失效直接 `subscribe` 事件源即可。
- `ImageLabelsPanel` 的被动刷新改为 `kbEvent$` 订阅（保留「预览内不替换底层列表」的例外语义）。
- **本地发布**：画册写命令返回的 `albumChanges` 目前经 `publishLocal` 立即投递给画册树等。迁完后决定：
  给 `kbEvent$` 加「本地注入 + 同 `(事件名, seq)` 去重」，或由写服务直接对受影响路径发请求通道。
- 删除 `dataChangeHub.ts`、`liveQuery.ts`（类型与常量迁入 `kbEvents`）、`useImagesChangeRefresh.ts`、`useAlbumImagesChangeRefresh.ts` 中的监听部分，
  同步更新 `.cursor/rules/view-mutation.mdc`、`AGENTS.md` 与 cocs 文档。

### 待定事项
- 是否恢复 `<keep-alive>`：恢复后 Phase A 的「隐藏期标脏补读」才会在真机生效，需要补一轮回归。
- 计数数据源跨组件共享时，是否需要在无订阅者后保留一小段 LRU（目前即刻回收，换回旧路径一定重读）。
