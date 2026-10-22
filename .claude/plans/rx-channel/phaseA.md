# kbEvents Phase A：ImageGrid 行与总数迁到 rxjs 事件源 + pathql 数据源

状态：已完成（2026-10-21）。`dataChangeHub` / `liveQuery` 迁移期保留，其它页面在后续阶段跟上。

> 修订（同日）：
> 1. 初版让一致性依赖后端快照 `seq`（`pathql_view` / `pathql_count` 返回 `{ rows|total, seq }`），
>    并在写操作期间暂存事件、按 `seq` 跳过本次写的回声。已改为下文的请求序列模型：行用 `pathql_fetch`、
>    总数用 `pathql_count`（只取 `total`），序号由前端请求服务分配，不再区分操作是否写入，也不再有 `hold`。
> 2. 第二版的订阅方（`useLivePathql`）自己防抖、自己发请求，是 queryer。已改为观察方模型：订阅方只是某个 key
>    的 looker，只看数据、注册过滤器；事件窗口（统一 500ms）与请求都由 pathql 核心处理，同一 key 的过滤器
>    任一同意就在该窗口刷新一次，并更新所有观察方看到的数据。
> 3. 第三版的 `requestPathql` 让调用方原地 await、接自己那次请求的错误，首次加载也散在 `usePagedGallery` 的路径 watch、
>    激活 watch、`onActivated` 等处隐式发起。已改为 `pathqlRequest$.next([kind, key])` 即发即返回，主动请求只有
>    事件窗口与用户操作两条通路；每个 key 维护 pending 窗口（累计确认），观察方看到最后可得的数据与最新请求的
>    loading / error，调用方不再按某次请求接结果或错误。

> 4. 修订（2026-10-22）：新增宿主 `pathql_all`，在 `spawn_blocking` 线程钉住只读连接并开启读事务，整批 SQL
>    共用同一个 WAL 快照；按序返回、任一失败整批失败。前端 `kind: "all"` 以规范化查询数组 JSON 为 key，
>    `useLookAll` 复用核心 pending / 事件窗口；删除核心 `total` kind。ImageGrid 同批读分子及 adapter 可选分母，
>    provide `{ total, unfilteredTotal }`，工具栏只注入，删除独立分母观察方及前端配对逻辑。
>    验证：vue-tsc、桌面 cargo check 通过；Vitest 40 文件 / 321 项，Rust providers 单测 17 项通过；当前无 dev / CDP，未真机。

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
2. **pathql 核心**（单例）：按 `kind + key` 维护请求序列、数据与观察方注册。唯一入口 `pathqlRequest$.next([kind, key])`
   即发即返回，不交还结果。每次序号 +1、可与在途请求并行；pending 窗口是 `(acked, requested]`，像 TCP 累计确认：
   任一请求返回就确认并取消它之前的全部 pending，序号不大于已确认的返回静默丢弃：

   ```
   无数据 → 请求1 返回 → 更新
   1、2、3 在途 → 2 先返回：更新并取消 1，最新请求 3 仍 loading → 1 返回：丢弃 → 3 返回：更新，loading 结束
   1、2 在途 → 1 成功：数据是 1 → 2 失败：状态 {seq 2, error}，数据仍是 1
   ```

   事件刷新也由核心处理：每个 key 一个统一的 500ms 窗口（`PATHQL_REFRESH_WAIT_MS`，经 `batchWindow`：
   空闲首票立即刷新，窗口内的票合并到窗口结束再刷新一次），窗口触发时同样只 next。
3. **观察方**（`lookPathql` / `usePathqlLooker`）：某个 key 的 looker，只看两样东西——`data`（最后可得的数据）与
   `status`（最新请求的 `{ seq, loading, error }`，二者序号相同，可以领先于数据的序号）。looker 一直期待最新数据，
   不关心请求何时由谁发出，因此也定位不到某次具体请求的错误，只看到最新请求的。不发请求、不带防抖时间；
   注册时带上自己的过滤器（`refreshOn`），同一 key 所有观察方的过滤器向核心的同一个窗口投票，任一同意就刷新一次。
   数据流和事件源是两种不同的 observable：事件源是「发生了什么」，数据流是「现在是什么」。

主动请求只有两条通路：核心的事件窗口，与发起方的用户操作（路径变化即导航 / 翻页 / 换筛选 / 激活、手动刷新、
写操作完成后、预览定位重取本页），都只 next；结果与错误只经观察方落地。

关键决策：

- **写命令不再返回快照，事件照常广播**。主应用前端以外还有后台任务、MCP、CLI、Web 多窗口靠事件同步，
  不能为「前端少读一次」去区分是否发事件。写完后前端把它当成一次用户操作直接请求；随后到达的本次写的事件
  再经防抖触发一次请求——允许多读，两次请求按序号落地，结果一致。
- **序号由前端请求服务分配，与后端事件 `seq` 无关**。应用规则是「大于当前数据状态的序号」，而不是「只认最后发出的那次」：
  后者在持续下载、单次读取超过防抖窗口时会让每个结果都被下一次请求作废，列表永远不更新。
- **请求即发即返回，状态只看最新**。调用方 await 某次请求、接它的错误，会让「谁发的请求」渗进消费逻辑；
  并行请求下单次请求的成败也不代表最终数据状态。所以请求只是一条触发通道，消费统一经观察方。
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
  - `pathqlRequest$`：唯一请求入口（`Subject<[kind, path]>`）。`rows` 读 `pathql_fetch`，`total` 读 `pathql_count` 的 `total`。
  - `lookPathql(kind, key, refreshOn)`：订阅期间注册一个观察方，发出 `data` / `status` 两种信号；
    `refreshOn` 订阅期间向该 key 的刷新窗口投票。
  - 每个 key 一个刷新窗口（`votes$.pipe(batchWindow(PATHQL_REFRESH_WAIT_MS))`），窗口触发时 `pathqlRequest$.next`。
    > 说明：条目在无观察方且无在途请求时回收（同时停掉窗口），避免把已离开路径的旧数据重放给后来者。
```ts
export const pathqlRequest$ = new Subject<PathqlRequest>();

function settle<S>(entry: Entry<S>, seq: number, result: { snapshot: S } | { error: unknown }) {
  if (seq <= entry.acked) return;                // 已被更晚的返回取消
  entry.acked = seq;                             // 确认并取消之前的全部 pending
  if ("snapshot" in result) entry.data$.next(result.snapshot);
  if (seq === entry.requested) {                 // loading / error 只属于最新请求
    entry.status$.next({ seq, loading: false, error: "error" in result ? result.error : null });
  }
}

pathqlRequest$.subscribe(([kind, path]) => {
  const entry = acquire(kind, path);
  const seq = ++entry.requested;                 // 请求序号，前端分配
  entry.status$.next({ seq, loading: true, error: null });
  void readers[kind](path, seq)
    .then((snapshot) => settle(entry, seq, { snapshot }), (error) => settle(entry, seq, { error }))
    .finally(() => release(kind, path, entry));
});
```

### 点 3 — 组合式观察方 `usePathqlLooker`（`services/kbEvents/usePathqlLooker.ts`）
- **新增**
  - key 变化时 `switchMap` 注销旧 key、注册新 key（旧路径的迟到结果与 loading 不影响新路径），key 为 null 时不注册；
  - 返回 `loading` / `error`（最新请求的）；数据交给 `onResult`，最新请求失败交给 `onError`；不带防抖时间、不发请求。
```ts
const rowsLooker = usePathqlLooker({
  kind: "rows",
  key: currentRowsPath,
  refreshOn: adapter.refreshOn,   // 过滤器注册到核心
  onResult: applyRows,
  onError: (error) => void adapter.onLoadError?.(error, rawViewPath()),
});
// 用户操作：next 即返回
const requestRows = () => {
  const key = currentRowsPath();
  if (key) pathqlRequest$.next(["rows", key]);
};
// 路径变化（导航、翻页、换筛选、激活）也是用户操作；总数同理按计数路径
watch(currentRowsPath, (key) => { if (key) pathqlRequest$.next(["rows", key]); }, { immediate: true });
```

### 点 4 — ImageGrid 与 adapter（`components/ImageGrid.vue`、`components/imageGrid/`）
- **修改**
  - 行与总数各注册一个观察方，共用 `adapter.refreshOn` 作为过滤器；行路径与计数路径各一个 watch，key 一变就请求，
    翻页不改计数路径就不重读（总数逻辑保持不变，仍服务分页与各页副标题）。首次加载不再散在 `usePagedGallery`
    的路径 watch、激活 watch 与 `onActivated` 里，`usePagedGallery` 只管页码、`rowsPath` 与预览边界。
  - 加载遮罩只在「当前路径还没有数据且最新请求在途」时显示；首次加载与事件刷新失败都经观察方 `onError` 交给 adapter。
  - `mutate` 改为「操作 → 请求行与总数（不等待）」，签名从 `(op: (view) => …)` 变为 `(op: () => …)`。
  - `refresh()` 不再返回 promise：Gallery 的刷新态随暴露的 `loading` 收起，TaskDetail 只等失败图片列表。
    `GridRefreshContext` 去掉无人使用的 `refreshPage` / `loadTotalImagesCount`。
  - `GridAdapter.changes.relevant(batch)` 改为 `refreshOn: EventTrigger[]`，每条一种事件。
```ts
const mutate: GridRefreshContext["mutate"] = async (op) => {
  const result = await op();            // 修改：不再传 view
  requestRows();                        // 新增：作为用户操作请求，不等待，结果仍从数据源落地
  requestTotal();
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
  - `kbEvents.test.ts`：防抖窗口、事件共享监听；pending 窗口按上文时序逐步断言（累计确认、更早结果丢弃）、
    loading / error 只属于最新请求且数据可落后于状态、总数取 `total` 且序号由前端分配、新订阅者拿到最后数据与最新状态、
    无观察方的路径返回后回收；事件防抖只在开头与结尾各请求一次、用户操作在防抖窗口内也立即请求、事件与用户请求并行时晚发出者优先、
    未激活标脏后请求、换路径不受旧请求影响。
- **修改**
  - `ImageGrid.previewFollowPage.test.ts` 的 mock 改到 `@/services/kbEvents`。
  - `.cursor/rules/view-mutation.mdc`、`AGENTS.md`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/README.md`、`versions/latest/{regression,changelog}.md`。

### 验证

- vue-tsc 0 error（初版另跑过 cargo check 0 error）；前端 Vitest 39 个文件、313 项通过。核心窗口用例：
  同一 key 多观察方各带过滤器、任一同意即刷新一次并推给全部观察方；统一 500ms 窗口合并多票；观察方全部退订后不再刷新；
  事件刷新失败推给观察方。观察方用例：不发请求、key 为 null 不注册、换 key 后旧结果与旧过滤器不影响新 key。
- dev 真机 + debug ingest（临时插桩已删除）：
  - 画廊右键隐藏首图 8164（按 id 校验，不看「首张 + 总数」，避免后台收集期间数据变化造成误判）：8164 离开网格、
    `is_hidden=1`，总数 4069 → 4068。rows / total 各请求两次：mutate 的用户请求（序号 2）与约 13ms 后本次写的事件
    经核心窗口的请求（序号 3，空闲首票立即发出），按序号依次落地。
  - 直接调 `remove_images_from_album` 模拟外部取消隐藏：8164 回到首位、`is_hidden=0`、总数回到 4069，
    只由核心窗口刷新，rows / total 各请求 1 次（序号 4）；画廊与画册视图各自只对相关事件刷新。
  - 停在画册页时隐藏 / 取消隐藏 8164 再切回画廊：重新挂载即读到最新行与总数，各请求 1 次。
  - `pathqlRequest$` 改造后（视频筛选视图 103 / 4057）：整页重载首次加载与手动刷新 rows / total 各 1 次，
    观察方先于请求注册；隐藏 8158 时 mutate 请求（序号 2）与事件窗口请求（序号 3）几乎同时发出，3 先返回落地并确认，
    2 随后返回被丢弃；离开期间取消隐藏再切回即为最新。
    注意：改 kbEvents 源码后的 HMR 会让 `@/router` 重建出未挂到 app 的实例，gallery adapter 的 `isActive` 恒为 false，
    切回画廊为空；整页重载即恢复，真机测试前先重载。
- 未真机：永久删除、上划移除、加入画册对话框、后台下载节奏、「无画册」视图、Web SSE、Android（见回归文档）。

### 已知边界

- 写操作每次会多一次请求（用户请求 + 本次写的事件经防抖再请求），按模型接受。
- 同一 key 被多个组件观察时共用核心的一个窗口，事件只刷新一次；但用户请求不合并在途请求，
  多个组件各自按路径变化请求同一 key 时会各读一次。
- 更早请求的失败只确认、不进状态；若最新请求成功，这次失败对任何观察方都不可见，按模型接受。
- 调用方无法知道「我这次刷新」成功与否：TaskDetail 的「刷新成功」提示只对应失败图片列表，网格失败经 adapter 提示。
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
- **核心工具：动态 key 观察**（已完成）：`usePathqlLookMany({ kind, keys, refreshOn, onResult(key, s), onError(key, e) })`，
  key 列表增删时逐个注册 / 退订观察方，每个 key 独立的数据源与刷新窗口，加入新 key 不影响已有 key；`refreshOn` 可按 key 给出过滤器；
  返回按 key 的 `loading(key)` / `error(key)` 与 `anyLoading`。同样只看不查：新加入的 key 由调用方请求（展开是用户操作），
  已有数据的 key 加入即拿到最后可得的数据。供懒加载分支（时间菜单年 / 月 / 日、画册树目录页）与按站点的畅游计数使用。
- **pathql 计数类**：~~`GalleryToolbar` 的分子 / 分母~~（已完成：分子注入 ImageGrid provide 的 `gridTotalKey`，
  分子分母由 ImageGrid 通过 `useLookAll` 同批 `pathql_all` 读取，工具栏只注入 `{ total, unfilteredTotal }`，去掉了 `useImagesChangeRefresh`）、
  ~~`GalleryFilterControl.loadFilterCounts`~~（已删除：该头部控件自 `5cf762b4` 查询栏改为 chip 后不再挂载，连同 `GalleryTimeFilterSubmenu` 与时间菜单树函数删除）、~~`HiddenCleanupControl`~~（已完成：`useLookAll` 观察隐藏画册 count，setup 请求一次）、~~Surf 页计数~~（已完成：组件作用域 `useSurfImageCounts` 按记录与 hide 观察动态 `all` key，新 key 自动请求，离开即退订，删除 pinia 计数 store）。
- **树 / 列举类**：`GalleryFacetTreeInner` 侧栏、`AlbumTreeView` / ~~`useAlbumQuery`~~（已完成：详情 / 祖先 / 子树数为 key A，按落地画册类型生成图片计数 key B；按自身 `ancestorPath` 判定事件相关性，composable 等待 A 与变化后的 B，失败 / 切换 / 卸载均释放等待）。
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
