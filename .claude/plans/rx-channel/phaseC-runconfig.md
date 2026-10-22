# Phase C3：运行配置进统一模型，删除 `view` / `hold` / `pathql_view`

范围：自动配置页的运行配置列表、页头失败数、配置详情弹窗、任务列表的配置名这四处运行配置事件消费方，
以及运行配置写命令的 `view` / `hold()`、`pathql_view`。`pathql_count` 保留（任务列表 `fetchTaskTotal` 还在用，
任务列表观察方化另排）。`dataChangeHub` 其它通道、`publishLocal` 的画册用法、`liveQuery.ts` 留给 Phase E。
分两步：步骤 1 前端改成观察方（后端不动，前端不再传 `view`）；步骤 2 删后端与 hub 的旧通路。**每步独立可编译、可验收。**

### 总体设计思路

运行配置列表现在是 Phase A 之前那套模型的最后一个使用者：写命令带上前端当前累计窗口的 `view`，
后端持有 `GlobalEmitter::hold()` 写库、读出窗口快照、析构时才放行事件；前端 `holdRunConfigEvents` 缓冲写入期间到达的配置事件，
快照落地后再按 `seq` 跳过已覆盖的，`publishLocal` 把本地写结果立即投递给其它订阅方。
任务事件则由 `usePagedRunConfigs` 手工维护：记 `taskId → configId`，逐条 `fetchRunConfig`，本地排序插入。
本计划把它改成与 ImageGrid 相同的形态：列表是 `pathql_all` 上一个 key 的观察方，只看数据不发请求；
刷新只有核心事件窗口与用户操作（路径变化、加载更多）两条通路；写命令只是命令，不带 `view`、不返回快照、照常广播事件。

列表的 key 是一组同快照查询：`[fetch 累计窗口行, count 总数]`。行和总数在同一读快照里，
"还有更多"不会因为两次读取之间的写入而判断错。加载更多扩大窗口，换成新 key，行和总数一起重读——计数很便宜，
换来的是只有一个 key、一个刷新窗口。写后不主动请求：写命令自己发的 `auto-config-change` 在核心空闲时首票立即刷新，
延迟只是一次事件往返；写操作的发起方（自动配置页、详情弹窗、收集弹窗"保存为配置"）都不需要知道列表的 key，
`registerRunConfigView` 这种登记表随之消失。

任务事件分成两类。新增张数、失败数、错误、结束时间只影响卡片展示，按 `TaskChanged.diff` 直接补到 `lastTask.id` 匹配的行上，不发请求；
新增带 `runConfigId` 的任务、任何任务状态变化、删除任务会改变"最近一次运行"是谁或"最近结果"取值，
影响 `last` 过滤与 `last` / `result` 排序，作为刷新信号交给核心窗口重读。`taskConfigIds` 表和逐条 `fetchRunConfig` 都不再需要。

其它三处运行配置事件消费方一并迁走，之后 `dataChangeHub` 的配置通道（`auto-config-change` 来源、
`holdRunConfigEvents`、`localConfigSeqs`、`RunConfigChange`、`subscribeRunConfigEvents`）没有使用方，步骤 2 删除：
页头失败数观察 `run_configs://last` 的 list 计数；详情弹窗观察 `run_configs://id_<id>` 的 rows；
任务列表只需要知道配置改名或删除，直接订阅 `kbEvent$("auto-config-change")`，列表本身的分页方式不变。

后端随后去掉写命令的 `view` 参数与 `hold()`。`hold()` 只有这四个写命令在用，`EventHold` 与暂存队列一并删除，
`dispatch_view_event` 退化为直接广播。写命令返回保存后的行（删除返回 `null`），不再包 `{ configId, reason, config, seq, view }`，
IPC 适配层也不用再取 `config`。事件 payload 里的 `seq` 保留：画册的 `publishLocal` 去重仍靠它，Phase E 再清。

关键决策（2026-10-22 已确认）：
- 任务事件：展示字段补丁与刷新信号分开。
- 写后不主动请求，靠事件刷新。
- 四处消费方全部迁走，删除 hub 的配置通道。
- `pathql_count` 暂时保留，只删 `pathql_view`。

### 现状锚点

**a. 列表分页**（`composables/usePagedRunConfigs.ts`）
```ts
const rowsQuery = useLiveQuery<RowsSnapshot>({
  // 现状：累计窗口 x{page*40}x/1，读 pathql_view（带后端 seq）
  key: () => (active.value ? `run_configs://${options.basePath()}x${page.value * RUN_CONFIG_PAGE_SIZE}x/1` : null),
  read: pathqlView,
  waitMs: 200,
  relevant: (batch) => batch.runConfigs.size > 0,
  onResult: (snapshot) => { items.value = snapshot.rows.map(normalizeRunConfigRow).filter(...); hasMore.value = ...; },
});
const totalQuery = useLiveQuery<TotalSnapshot>({ key: () => `run_configs://${options.countPath()}`, read: pathqlCount, ... });
// 现状：登记给写服务，写命令带上这个 key 当 view，返回的快照由 apply 直接落地
const unregisterView = registerRunConfigView({ key: rowsQuery.key, apply: rowsQuery.apply });

// 现状：任务事件手工维护——记 taskId → configId，TaskAdded 不在列表里就 fetchRunConfig 整行再 matches 判定，
// TaskChanged 合并 diff 后 upsert 并重新排序，TaskDeleted 再 fetchRunConfig
const taskConfigIds = new Map<string, string>();
async function applyTaskEvent(event: TaskEvent, activeGeneration: number) { /* ~50 行 */ }
```
返回 `{ items, total, loading, showLoading, hasMore, start, loadMore, stop }`，`options` 里有 `matches` / `sort`（只给本地 upsert 用）。

**b. 写服务**（`services/runConfigWrites.ts`）
```ts
export async function writeRunConfig(method, params) {
  const target = [...views].reverse().find((view) => view.key());
  const view = target?.key() ?? null;
  const release = holdRunConfigEvents(); // 现状：缓冲写入期间到达的配置事件
  try {
    const result = await invoke<WriteResult>(method, { ...params, view });
    if (result.view && view && target && views.has(target) && target.key() === view) await target.apply(result.view);
    const batch = emptyBatch(result.seq);
    batch.runConfigs.set(result.configId, { reason: result.reason, config: result.config });
    publishLocal(batch); // 现状：本地写结果立即投递给 subscribeRunConfigEvents 的订阅方
    return result.config;
  } finally {
    release();
  }
}
```

**c. 其它配置事件消费方**（都经 `subscribeRunConfigEvents` → `dataChangeHub`）
```ts
// views/AutoConfigs.vue — 页头失败数：配置或任务事件后 200ms 重读一次
async function refreshFailedTotal() {
  failedTotal.value = (await fetchRunConfigFacet("last", emptyQuery)).failed ?? 0;
}
const unsubscribeFailureConfig = subscribeRunConfigEvents(scheduleFailedRefresh);
const unsubscribeFailureTasks = subscribeTaskEvents(scheduleFailedRefresh);

// components/scheduler/AutoConfigDialog.vue — 详情：一次 fetchRunConfig，事件里有本地 config 就直接用
unsubscribeConfig = subscribeRunConfigEvents((event) => {
  if (event.configId !== id) return;
  if (event.reason === "configdelete") { config.value = null; configLoading.value = false; }
  else if (event.config) config.value = event.config;
  else void loadExistingConfig();
});

// composables/usePagedTaskList.ts — 任务行上的配置名：configchange 时取 event.config 或 fetchRunConfig
unsubscribeConfigs = subscribeRunConfigEvents((event) => { ... applyConfigEvent(event, activeGeneration) });
```

**d. 后端写命令**（`kabegame-core/src/commands/task.rs`，add / update / delete / copy 同形）
```rust
pub async fn add_run_config(config: Value, view: Option<String>) -> Result<Value, String> {
    let _hold = GlobalEmitter::global().hold(); // 现状：析构前事件只分配序号、暂存不广播
    ...
    let seq = GlobalEmitter::global().emit_auto_config_change("configadd", &config_id);
    let saved = query_fetch(&format!("run_configs://id_{config_id}"))?.into_iter().next().unwrap_or(Value::Null);
    run_config_write_result(config_id, "configadd", seq, saved, view).await // 现状：{configId, reason, config, seq, view}
}
```
IPC handler（`kabegame/src/ipc/handlers/storage/run_configs.rs`）用 `run_config_response` 从结果里取 `config` 返回旧单行；
IPC 请求本身不带 `view`，CLI 不受影响。`pathql_view`（`commands/view.rs` 的 `snapshot_rows`）只剩 `usePagedRunConfigs` 一个使用方。

---

## 步骤 1 — 前端改成观察方（后端不动）

### 点 1.1 — 事件表（`services/kbEvents/events.ts`、`services/tasks.ts`）
- **新增**
  - `KbEventMap` 增加 `"auto-config-change"` 与 `"tasks-change"`。
```ts
export type AutoConfigChangePayload = {
  seq?: number;
  reason?: "configadd" | "configchange" | "configdelete";
  configId?: string;
};

export interface KbEventMap {
  // ...已有
  "auto-config-change": AutoConfigChangePayload; // 新增
  "tasks-change": unknown; // 新增：原始 payload，由 normalizeTaskEvent 解析
}
```
- **修改**
  - `services/tasks.ts` 的 `normalizeTaskEvent` 改为导出，供过滤器与补丁复用。

### 点 1.2 — 列表（`composables/usePagedRunConfigs.ts`）
- **修改**
  - 行与总数改为一个 `usePathqlLookAll` 观察方：`[{ kind: "fetch", path: 累计窗口 }, { kind: "count", path: 计数路径 }]`。
  - `page` 只在用户操作时变化：`start()` 置 1 并请求；`loadMore()` 置为"已落地页 + 1"并请求。
    > 说明：以已落地页为基准，加载更多失败后再点一次仍是同一个 key，重新请求即可，不需要回退页码。
  - 任务事件：展示字段补丁 + 刷新信号（见下）。
- **删除**
  - `useLiveQuery` 两个查询、`registerRunConfigView`、`countTimer` / `scheduleCountRefresh`、`upsert` / `remove`、
    `taskConfigIds`、`refetchInto`、`applyTaskEvent`、启动期 `taskBuffer`、`generation`。
  - `options.matches` / `options.sort`（只给本地 upsert 用），`AutoConfigs.vue` 的 `matches` 函数随之删除。
```ts
export function usePagedRunConfigs(options: { basePath: () => string; countPath: () => string }) {
  const items = shallowRef<RunConfig[]>([]);
  const total = ref(0);
  const active = ref(false);
  const page = ref(1);
  let landedPage = 0; // 新增：最后落地数据对应的页数
  const { showLoading, startLoading, finishLoading } = useLoadingDelay();

  const queries = () =>
    active.value
      ? ([
          { kind: "fetch", path: `run_configs://${options.basePath()}x${page.value * RUN_CONFIG_PAGE_SIZE}x/1` },
          { kind: "count", path: `run_configs://${options.countPath().replace(/\/$/, "")}` },
        ] as const)
      : null;

  const looker = usePathqlLookAll({
    queries,
    refreshOn: [
      on("auto-config-change"),
      on("tasks-change", isRunConfigTaskSignal), // 新增：见下
    ],
    onResult: ([rows, count]) => {
      items.value = rows.map(normalizeRunConfigRow).filter((c): c is RunConfig => c !== null);
      total.value = count;
      landedPage = page.value;
    },
  });
  const hasMore = computed(() => items.value.length >= landedPage * RUN_CONFIG_PAGE_SIZE && items.value.length < total.value);
  watch(looker.loading, (value) => (value ? startLoading() : finishLoading()));

  function request() {
    const key = looker.key();
    if (key) pathqlRequest$.next(["all", key]);
  }
  function start() {
    active.value = true;
    page.value = 1;
    landedPage = 0;
    items.value = []; // 换筛选 / 排序时清空并显示加载态，与现状一致
    total.value = 0;
    request();
  }
  function loadMore() {
    if (looker.loading.value || !hasMore.value) return;
    page.value = landedPage + 1;
    request();
  }
  // 展示字段补丁：只改已在手的行，不发请求
  const patches = kbEvent$("tasks-change").subscribe(({ payload }) => {
    const event = normalizeTaskEvent(payload);
    if (event?.type !== "TaskChanged") return;
    const index = items.value.findIndex((config) => config.lastTask?.id === event.taskId);
    if (index === -1) return;
    const current = items.value[index];
    const lastTask = { ...current.lastTask!, ...pickLastTaskFields(event.diff) };
    items.value = items.value.with(index, { ...current, lastTask, lastResult: lastResultOf(lastTask) });
  });
  ...
  return { items, total, loading: looker.loading, showLoading, hasMore, start, loadMore, stop };
}

/** 会改变"最近一次运行"是谁或其结果的任务事件：新增带配置的任务、状态变化、删除。 */
function isRunConfigTaskSignal(payload: unknown): boolean {
  const event = normalizeTaskEvent(payload);
  if (!event) return false;
  if (event.type === "TaskAdded") return !!normalizeTaskRow(event.task)?.runConfigId;
  if (event.type === "TaskDeleted") return true;
  return event.diff.status != null;
}
```
  > 说明：`pickLastTaskFields` 只取 `RunConfigLastTask` 已有的字段（`status` / `endTime` / `successCount` / `failedCount` / `error`），
  > 进度等其它 diff 字段不进行。按实际签名实现，不要照抄伪代码；`loading` / `showLoading` 的对外语义保持不变。
  - `AutoConfigs.vue`：`watch(runConfigViewPath(mine), start)` 与 `onMounted(start)` 保持；`LoadMoreButton` 用法不变。

### 点 1.3 — 页头失败数（`views/AutoConfigs.vue`）
- **修改**
  - `failedTotal` 改为观察 `[{ kind: "list", path: "run_configs://last", withCount: false }]`，从 `meta.count` 取 `failed`。
    `refreshOn` 与列表相同（同一个 `isRunConfigTaskSignal`）；挂载时请求一次。
- **删除**
  - `refreshFailedTotal` / `scheduleFailedRefresh` / `failedTimer`、两个 `subscribe*` 及其 `onScopeDispose`。
  - 下拉框打开时的 `loadFacet` 保持一次性读取，不改。
```ts
const failedLooker = usePathqlLookAll({
  queries: () => [{ kind: "list", path: `run_configs://${runConfigFilterPath(emptyQuery)}last` }] as const,
  refreshOn: [on("auto-config-change"), on("tasks-change", isRunConfigTaskSignal)],
  onResult: ([entries]) => {
    failedTotal.value = Number((entries.find((e) => e.name === "failed")?.meta as { count?: number } | null)?.count ?? 0);
  },
});
onMounted(() => { const key = failedLooker.key(); if (key) pathqlRequest$.next(["all", key]); });
```
  > 说明：路径与 `fetchRunConfigFacet("last", emptyQuery)` 保持一致；`isRunConfigTaskSignal` 放到 `services/runConfigs.ts` 导出，列表与失败数共用。

### 点 1.4 — 详情弹窗（`components/scheduler/AutoConfigDialog.vue`）
- **修改**
  - 打开查看 / 编辑已有配置时观察 rows key `run_configs://id_<id>`，`refreshOn: on("auto-config-change", p => p.configId === id)`；
    key 变化（打开、换配置）时请求一次。结果 `rows[0]` 规整后赋给 `config`，空数组即已删除（`config = null`）。
  - `configLoading` = 当前 key 尚无落地数据且 `loading`。
- **删除**
  - `loadExistingConfig`、`configGeneration`、`unsubscribeConfig` 及其 watch 内的订阅逻辑。
```ts
const configKey = computed(() =>
  dialogStore.visible && !dialogStore.isCreate && dialogStore.configId
    ? `run_configs://id_${encodeSeg(dialogStore.configId)}`
    : null,
);
const configLooker = usePathqlLooker({
  kind: "rows",
  key: () => configKey.value,
  refreshOn: [on("auto-config-change", (p) => p.configId === dialogStore.configId)],
  onResult: ({ rows }) => { config.value = normalizeRunConfigRow(rows[0]) ?? null; landedKey.value = configKey.value; },
});
watch(configKey, (key) => { config.value = null; landedKey.value = null; if (key) pathqlRequest$.next(["rows", key]); }, { immediate: true });
const configLoading = computed(() => !!configKey.value && landedKey.value !== configKey.value);
```
  > 说明：`fetchRunConfig` 的 id 编码规则照搬；详情弹窗原来不听任务事件，这里也不加。

### 点 1.5 — 任务列表的配置名（`composables/usePagedTaskList.ts`）
- **修改**
  - `subscribeRunConfigEvents` 换成 `kbEvent$("auto-config-change")` 订阅，启动期缓冲与 `applyConfigEvent` 逻辑保持；
    `configchange` 一律 `fetchRunConfig(configId)`（不再有本地 `event.config`）。
  - 列表分页、`fetchTaskTotal`（`pathql_count`）不改。

### 点 1.6 — 写服务（`services/runConfigWrites.ts`）
- **修改**
  - `writeRunConfig` 只调命令、返回 `config`；暂时仍按后端现有返回形态取 `result.config`（后端步骤 2 才改）。
- **删除**
  - `views` / `registerRunConfigView` / `ViewTarget`、`view` 参数、`holdRunConfigEvents` / `publishLocal` / `emptyBatch` 调用。
```ts
export async function writeRunConfig(method: RunConfigWriteMethod, params: Record<string, unknown>) {
  const result = await invoke<{ config: Record<string, unknown> | null }>(method, params);
  return result.config; // 步骤 2 后端改为直接返回行，这里改成 return invoke(...)
}
```

### 点 1.7 — 测试
- `runConfigWrites.test.ts` 里的列表用例迁到 `composables/usePagedRunConfigs.test.ts`，按观察方改测（参照 `useAlbumQuery.test.ts` 的 mock 方式）：
  - `start` 请求一次 `all` key，结果落地 items / total / hasMore；换路径换 key 并清空。
  - `loadMore` 换成更大窗口的 key 并请求；失败后再点仍是同一个 key、再次请求。
  - `auto-config-change` 与三种任务信号触发刷新；只有进度 / 张数变化的 `TaskChanged` 不刷新，只补丁对应行。
- `runConfigWrites.test.ts` 只留写命令参数不再带 `view`。
- `AutoConfigDialog`、`usePagedTaskList` 有现成测试的同步改；没有就不强求新建，在记录里说明。

---

## 步骤 2 — 删除旧通路

### 点 2.1 — 写命令（`kabegame-core/src/commands/task.rs`、Tauri / web / IPC 入口）
- **修改**
  - `add/update/delete/copy_run_config` 去掉 `view` 参数与 `let _hold = ...hold()`，返回保存后的行（删除返回 `Value::Null`）；
    导入态差异 `emit_recommended_diff` 的顺序不变（写库后、配置事件前）。
  - Tauri 命令（`kabegame/src/commands/task.rs`）、web dispatch 同步去掉 `view`；IPC handler 删掉 `run_config_response`，直接 `ok_with_data(result)`。
  - 前端 `writeRunConfig` 改为直接返回 `invoke` 结果。
- **删除**
  - `run_config_write_result`（`emit_auto_config_change` 返回的 `seq` 不再使用，函数签名可保留）。
```rust
pub async fn add_run_config(config: Value) -> Result<Value, String> {
    // 删除：let _hold = GlobalEmitter::global().hold();
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    let before = recommended_diff_scope(vec![run_config.plugin_id.clone()])?;
    Storage::global().add_run_config(run_config)?;
    emit_recommended_diff(before);
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &config_id);
    Ok(query_fetch(&format!("run_configs://id_{config_id}"))?.into_iter().next().unwrap_or(Value::Null)) // 修改
}
```

### 点 2.2 — `hold()`（`kabegame-core/src/emitter.rs`）
- **删除**
  - `EventHold` 两个 `Drop` 实现、`HELD_VIEW_EVENTS`、两处 `GlobalEmitter::hold`。
- **修改**
  - `dispatch_view_event` 直接 `EventBroadcaster::global().broadcast(event)`；若只剩一行，可内联到调用处或保留名字，按周边风格决定。
  - `next_change_seq` / `current_change_seq` 保留（事件 `seq` 与 `pathql_count` 仍在用）。

### 点 2.3 — `pathql_view`
- **删除**
  - core `commands/view.rs` 的 `RowsSnapshot` / `snapshot_rows` / `pathql_view`；Tauri 命令与 `lib.rs` 注册、`permissions/main.toml`、web dispatch。
  - 前端 `services/pathql.ts` 的 `pathqlView`、`ImageGrid.previewFollowPage.test.ts` 里的 mock。
  - `liveQuery.ts` 的 `RowsSnapshot` 类型若已无引用一并删，`useLiveQuery` 本身留给 Phase E。

### 点 2.4 — `dataChangeHub` 配置通道（`services/dataChangeHub.ts`、`services/runConfigs.ts`）
- **删除**
  - `RunConfigChange`、`ChangeBatch.runConfigs`（含 `mergeBatch` / `emptyBatch` / `albums.ts` 构造处）、`auto-config-change` 来源、
    `configWriteDepth` / `heldConfigBatches` / `localConfigSeqs` / `coveredConfigBatch` / `holdRunConfigEvents`，`publishLocal` 里的配置分支。
  - `runConfigs.ts` 的 `subscribeRunConfigEvents` 与 `RunConfigEvent`。
  - `fetchRunConfigPage` / `fetchRunConfigTotal` 若无调用方一并删（`fetchRunConfigTotal` 是 `pathql_count` 在配置侧唯一用法）。
  - `dataChangeHub.ts` 里遗留的 `// DEBUG-PERF` 插桩（`perf` 函数、`sendDebugEvent` import 与 `hub_event` 上报）一并删除（2026-10-22 用户确认）。

### 点 2.5 — 文档与回归
- `AGENTS.md`「运行配置写操作」重写为观察方模型；「插件变更事件与推荐导入态」里"经既有 `hold()` 与配置事件同批放行"改为"写库提交后发出"。
- `.cursor/rules/view-mutation.mdc`、`.cursor/rules/plugin-resources.mdc`、`cocs/downloader-tasks/TASK_DRAWER_LOAD.md`、
  `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/plugins/PLUGIN_STORE_CACHE.md`、`cocs/README.md` 中 `pathql_view` / `hold` / 写命令 `view` 的表述同步。
- `phaseA.md`「Phase C — 运行配置」一条标为已完成。
- `versions/latest/regression.md` 新增一节、`changelog.md` 一到几行。

### 已知边界
- 补丁与刷新竞态：补丁打上后，若一个更早发出的窗口刷新随后落地，张数可能短暂回退到旧值，下一次补丁或刷新即恢复。按模型接受。
- 任意任务的状态变化都会刷新配置窗口（含不属于任何配置的手动任务），每个任务一生约三次，按 500ms 窗口合并。
- 写后刷新依赖本次写的 `auto-config-change` 到达；事件丢失时只能等下一次事件或用户换路径。
- 筛选下拉的分面计数仍是打开时一次性读取，不随事件刷新（与现状一致）。

---

## 步骤 1 实施记录

2026-10-22：完成点 1.1–1.7，仅迁移前端观察方。列表的累计行窗口与总数由同一个 `all` key 落地，用户操作只发请求，配置与任务刷新信号统一交给核心事件窗口；任务展示字段直接补丁已在手的行。后端和步骤 2 的旧通路定义保留。

### 点 1 — 事件与四处消费方

- **新增**
  - `apps/kabegame/src/services/kbEvents/events.ts`：`AutoConfigChangePayload`、`auto-config-change`、`tasks-change`；`services/kbEvents/index.ts` 同步导出 payload 类型。
  - `apps/kabegame/src/services/runConfigs.ts`：共享 `isRunConfigTaskSignal`，识别带运行配置的任务新增、任意任务状态变化和任务删除。
- **修改**
  - `apps/kabegame/src/services/tasks.ts`：导出 `normalizeTaskEvent`，复用现有 camel/snake 字段规整逻辑。
  - `apps/kabegame/src/composables/usePagedRunConfigs.ts`：使用一个 `usePathqlLookAll`，`start` / `loadMore` 请求累计行与计数；加载更多以已落地页加一为目标，失败后重试同 key；只向 `lastTask.id` 匹配的行补丁允许字段。
  - `apps/kabegame/src/views/AutoConfigs.vue`：页头观察 `run_configs://last` 的 list，`withCount: false`；挂载请求一次，筛选下拉 `loadFacet` 保持一次性读取，模板用法保持不变。
  - `apps/kabegame/src/components/scheduler/AutoConfigDialog.vue`：观察编码后的 `run_configs://id_<id>` rows key；换 key 清空旧配置并请求一次，空结果视为已删除。查看态与编辑态继续读取 `config`，首次编辑初始化等待当前 key 落地。
  - `apps/kabegame/src/composables/usePagedTaskList.ts`：配置名直接订阅 `kbEvent$("auto-config-change")`，保留启动缓冲；改名一律 `fetchRunConfig`，删除清空关联配置名。任务分页与 `fetchTaskTotal` 未改。
- **删除**
  - 列表的两个 `useLiveQuery`、本地插入排序、任务归属表、启动任务缓冲、generation 与计数定时器；删除 `options.matches` / `options.sort` 和页面 `matches`。
  - 页头失败数的定时重读与两个旧事件订阅；详情弹窗的重复读取函数、generation 与旧配置订阅。

### 点 2 — 写服务与测试

- **新增**
  - `apps/kabegame/src/composables/usePagedRunConfigs.test.ts`：覆盖首次单次 all 请求与行/总数/hasMore 落地、换路径清空及旧响应隔离、累计窗口扩大、失败后同 key 重试、配置事件与三种任务信号、展示补丁、延迟加载态与 stop。
- **修改**
  - `apps/kabegame/src/services/runConfigWrites.ts`：只传业务参数，继续从后端当前返回对象取 `config`；`stores/crawler.ts` 四个写入口保持原样。
  - `apps/kabegame/src/services/runConfigWrites.test.ts`：改为四种写命令的参数与 config/null 返回断言，不再测旧视图和 hub 行为。
- **删除**
  - `registerRunConfigView`、视图登记表与相关类型，以及写服务对 `holdRunConfigEvents` / `publishLocal` / `emptyBatch` 的调用。

### 与伪代码的差异及原因

- 使用实际页大小 `RUN_CONFIG_PAGE_SIZE = 20`，不采用现状锚点里示意的 40。
- `usePathqlLooker` 实际不返回 key，详情弹窗持有 `configKey`；重置 watcher 先于观察方注册，避免重放数据后又被清空。`configLoading` 按当前 key 是否已有落地数据判断，后台刷新已有配置时不切换缺失提示。
- 详情弹窗原编辑初始化会再次调用 `loadExistingConfig`；现将 `configLoading` 纳入初始化 watcher，落地后填表，避免额外读取。
- 列表的 `landedPage` 使用 ref，保证 `hasMore` 随清空与落地同步计算；加载态 watcher 使用 `flush: "sync"`，保持同步并发守卫和延迟展示语义。
- 失败分面路径显式使用 `runConfigFilterPath(emptyQuery, "last")`，与 `fetchRunConfigFacet("last", emptyQuery)` 的路径构造完全一致。
- 没有 `AutoConfigDialog` 或 `usePagedTaskList` 的现成测试，本步骤未强求新建；未进行真实应用界面操作。

### 验证结果

- 从 `apps/kabegame` 执行 `../../.claude/skills/check-kabegame/driver.sh --skip cargo`，驱动实际在该目录运行 `deno task vue-tsc`（由 Node 执行 vue-tsc）：**退出码 0，vue-tsc 0 个 error，耗时 17 秒**。完整日志：`.kabegame/debug/check/check-20261022-232146.log`。Cargo 已跳过。
- 在 `apps/kabegame` 执行 `deno task test`（全量 `vitest run`）：**退出码 0，Test Files 46 passed (46)，Tests 401 passed (401)，Duration 12.39s**。
- 已使用根配置对全部改动的 Vue/TS 文件运行 Prettier，针对这 11 个文件的 `prettier --check` 全部通过；`git diff --check` 通过。
- 补充执行全仓 `deno task format:check`：退出码 1，8 个未修改文件存在既有格式问题（`KbIntegerInput.vue`、`ImageDetailDialog.vue`、`PluginVarsForm.vue`、`TaskDrawerContent.vue`、`pluginVarForm.test.ts`、`pluginVarForm.ts`、`pluginVarWhen.ts`、`Settings.vue`），本次改动文件无格式告警。未扩大修改范围；完整日志：`.kabegame/debug/check/phaseC-step1-format.log`。
- 全仓前端源码搜索：`registerRunConfigView` 无定义或调用；`usePagedRunConfigs` 无 `useLiveQuery`；非测试源码中的 `pathqlView`、`subscribeRunConfigEvents` 仅剩定义，无调用方。
- 已核对事件入口：`kbEvent$` 按传入事件名调用 `@/api.listen`，该入口分别转到 Tauri `listen` 与 Web SSE `listen`；两种新事件名均无额外白名单限制。新列表测试通过该 `listen` 入口投递事件并验证核心刷新。
- 未修改 Rust、`third/` 或任何子模块；原有子模块脏状态保留。`pathql_view`、`hold()`、hub 配置通道和 `subscribeRunConfigEvents` 定义仍在；未提交 git，未写回归文档或 changelog。

---

## 步骤 2 实施记录

2026-10-22：完成点 2.1–2.5，保留步骤 1 的观察方实现。配置写命令现在只返回保存后的单行/null，写库后的推荐导入态事件与配置事件直接广播；列表、失败数和详情通过各自的观察 key 刷新。删除旧快照与 hub 配置通道后，画册本地发布和任务总数读取继续工作。

### 点 1 — 写命令与事件发送器

- **修改**
  - `src-tauri/kabegame-core/src/commands/task.rs`：四个写命令去掉 view 参数，add/update/copy 直接返回原有 PathQL 保存行，delete 返回 `Value::Null`；`emit_recommended_diff` 仍在成功写库后、配置事件前执行。
  - `src-tauri/kabegame/src/commands/task.rs`、`src-tauri/kabegame/src/web/dispatch.rs`：同步四个命令签名与参数。
  - `src-tauri/kabegame/src/ipc/handlers/storage/run_configs.rs`：新增/更新直接用 `IpcResponse::ok_with_data` 返回 core 结果；删除继续 `IpcResponse::ok("deleted")`，保持原 IPC 响应。
  - `apps/kabegame/src/services/runConfigWrites.ts` 及其测试：直接返回 invoke 的配置行/null，不再从外层对象取 config。
  - `src-tauri/kabegame-core/src/emitter.rs`：保留 `dispatch_view_event` 名称，函数体直接广播；保留变更序号分配与读取。
- **删除**
  - core 写结果包装函数、四个命令的事件暂存调用、`EventHold` 及两套 Drop/hold 实现、暂存队列。
  - IPC 的返回包装适配函数。
- **新增**
  - `src-tauri/kabegame-core/tests/run_config_commands.rs`：独立测试进程、临时数据库，仅初始化必要单例，不启动爬虫、应用窗口或调度循环；实际执行新增、更新、复制、删除，验证单行字段、无包装字段、删除返回 null 与存储结果。
  - core 单元测试改为验证无完整运行时也能拒绝非法配置；IPC 返回形态测试同步为直接返回。

### 点 2 — 查询与 hub 清理

- **修改**
  - `src-tauri/kabegame-core/src/commands/view.rs`、`src-tauri/kabegame/src/commands/image.rs`、`src-tauri/kabegame/src/lib.rs`、`src-tauri/kabegame/permissions/main.toml`、Web dispatch、`apps/kabegame/src/services/pathql.ts`：删除旧行快照命令的实现、暴露入口、权限与前端包装，保留计数命令全链路。
  - `apps/kabegame/src/services/dataChangeHub.ts`：去掉配置批次字段、合并分支、事件来源、缓冲与序号覆盖逻辑，以及所有 DEBUG-PERF 插桩；其它通道和画册 `publishLocal` 去重保留。
  - `apps/kabegame/src/services/albums.ts`、`apps/kabegame/src/services/liveQuery.loading.test.ts`：同步批次构造。
  - `apps/kabegame/src/components/ImageGrid.previewFollowPage.test.ts`：删除失效的查询 mock。
- **删除**
  - `apps/kabegame/src/services/runConfigs.ts` 的旧订阅、事件类型与无调用方的分页/总数读取函数。
- **说明**
  - `liveQuery.ts` 的 TypeScript 行快照类型仍被其 metrics 与现存 loading 测试引用，按“只删已无引用类型”的约束保留；Rust 同名类型已删除。`useLiveQuery` 留到 Phase E。
  - `albums.test.ts`、`useAlbumQuery.test.ts` 没有依赖已删除的配置批次字段或旧命令 mock，无需改动，已包含在全量 Vitest 中。

### 点 3 — 文档与回归

- **修改**
  - `AGENTS.md`、`.cursor/rules/view-mutation.mdc`、`.cursor/rules/plugin-resources.mdc`：运行配置统一为观察方与直接命令返回，推荐导入态写库后发出；规则相互一致。
  - `cocs/downloader-tasks/TASK_DRAWER_LOAD.md`、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`、`cocs/plugins/PLUGIN_STORE_CACHE.md`、`cocs/README.md`：更新累计窗口/总数同批观察、任务补丁与刷新信号、配置写入与事件顺序。
  - `.claude/plans/rx-channel/phaseA.md`：运行配置条目标记完成，更新旧后端查询删除的已知边界。
  - `versions/latest/regression.md`：新增统一观察方回归节，覆盖用户列出的全部路径，case 均未勾选；旧主动同步测试明确标为历史验证记录，避免沿用旧验收结论。
  - `versions/latest/changelog.md`：用户侧说明改为事件更新列表与总数，开发侧补充旧通路删除。

### 写命令调用方清单

全仓按四个函数名搜索并逐个核对，未修改子模块：

| 位置 | 调用关系与确认结果 |
| --- | --- |
| core `commands/task.rs` | 四个公开写命令调用同名 Storage 方法；Storage 的同步签名与相关 storage 测试不变 |
| Tauri `commands/task.rs` | add/update 只传 config，delete/copy 只传 config_id；`lib.rs` 的四个注册保留 |
| Web `dispatch.rs` | 四个 JSON-RPC 入口去掉可选 view 字段，直接转发 core 单行/null |
| app IPC `handlers/storage/run_configs.rs` | add/update/delete 三个入口改用新 core 签名；已有 IPC 没有 copy 入口，本次不新增 |
| app IPC `handlers/storage/mod.rs` | 原请求枚举路由不变；core `ipc/client/client.rs` 的 storage_add/update/delete_run_config 请求与解析不变 |
| 前端 `stores/crawler.ts` → `services/runConfigWrites.ts` | 四个入口业务参数与规整逻辑不变，写服务直接返回单行/null；四种方法均有 Vitest 断言 |
| core 测试 | 原包装函数测试替换；新增独立集成测试实际调用四个命令；storage/run_configs.rs 与 storage/albums.rs 的同名同步 Storage 调用无需修改 |
| MCP `mcp_server.rs` / `mcp_capabilities.rs` | 没有这四个写函数的直接调用，也没有旧返回对象的解包；MCP 相关测试通过 |
| CLI `src-tauri/kabegame-cli/src/{main,backend}.rs` | 没有这四个 core 写函数的直接调用；IPC 客户端协议载荷未改，CLI check 通过 |

`IPC_PROTOCOL_VERSION` 保持 3。

### 验证结果

Cargo 依次运行，FFmpeg 环境固定为：

```sh
FFMPEG_PKG_CONFIG_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/FFmpeg-build/install/lib/pkgconfig
FFMPEG_LINK_MODE=static
```

| 实际执行 | 结果 |
| --- | --- |
| `.claude/skills/test-kabegame/driver.sh kabegame-core --lib run_config`（实际 cargo test -p kabegame-core --lib run_config） | 退出码 0，7 passed / 0 failed |
| 同驱动 `kabegame-core --lib recommended` | 退出码 0，6 passed / 0 failed，包含四个 commands 的 recommended_diff 测试与两个插件相关测试 |
| 同驱动 `kabegame-core --lib emitter` | 退出码 0，0 个匹配测试，不作为运行时覆盖结论；有/无 ipc-server 两套实现由检查覆盖 |
| 同驱动 `kabegame-core --lib view` | 退出码 0，5 passed / 0 failed |
| 同驱动 `kabegame-core --test run_config_commands` | 退出码 0，1 passed / 0 failed，四个真实写命令返回载荷验证通过 |
| `DYLD_FRAMEWORK_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/cef-build target/debug/deps/kabegame-f5da4861d2c364ad ipc` | 退出码 0，1 passed / 0 failed |
| 同一测试二进制与同一 DYLD_FRAMEWORK_PATH，过滤 `mcp` | 退出码 0，11 passed / 0 failed |
| `.claude/skills/check-kabegame/driver.sh`（standard） | 退出码 0，vue-tsc 0 error、cargo 0 error，29 秒；实际在 apps/kabegame 运行 Node 版 vue-tsc |
| `cargo check -p kabegame --no-default-features --features web` | 退出码 0，12.55 秒 |
| `cargo check -p kabegame-cli` | 退出码 0，6.63 秒 |
| 在 `apps/kabegame` 执行 `deno task test`（全量 vitest run） | 退出码 0，46 files passed / 401 tests passed，10.05 秒 |
| 改过的 9 个 Rust 文件逐一 rustfmt（edition 2021、skip_children=true）及 --check | 通过；未对 crate 跑 cargo fmt，plugin/v8/ops.rs 无改动 |
| 本步骤 8 个 Vue/TS 文件的 prettier --check、git diff --check | 通过 |
| 全仓 `deno task format:check` | 退出码 1；仍是步骤 1 已记录的 8 个未修改文件的既有格式问题，本步骤文件无告警 |

应用 IPC/MCP 的驱动初跑已编译成功，但经驱动的 shell/子进程启动时未保留 DYLD_FRAMEWORK_PATH，测试在加载 CEF framework 时退出 101；随后把该变量直接设在测试二进制环境中重跑，两组均通过。未修改运行库或构建路径来绕过。

日志在 `.kabegame/debug/check/phaseC-step2-*.log`；顺序检查的状态在 `phaseC-step2-results.json`（保留初跑失败记录）。standard 完整驱动日志为 `check-20261022-233011.log`；最终 IPC/MCP 结果分别在 `phaseC-step2-ipc-binary.log`、`phaseC-step2-mcp-binary.log`。

### 收尾与边界

- 当前源码、规则与非历史文档中的指定旧符号搜索均为 0 匹配；Rust 行快照类型与 hub 内 DEBUG-PERF 搜索为 0。旧计划现状锚点与实施记录保留历史文字。
- `pathql_count` / `snapshot_total` / `TotalSnapshot`、变更序号、画册本地发布和 `useLiveQuery` 保留，步骤 1 的观察方未回退。
- 未修改 Provider DSL 或生成型 PathQL 客户端，前端 `services/pathql.ts` 只删除旧命令包装，因此不触发 `pathql:generate`。
- 未操作真实应用界面，新回归 case 均待验收；事件丢失与补丁/较早快照的短暂回退仍是计划已接受的边界。
- 未提交 git，未修改 third/ 或任何子模块，保留任务开始时原有的子模块脏状态。

### 步骤 1–2 复核与真机验收（2026-10-22，macOS CEF dev）

复核：列表为单个 `all` key（累计窗口行 + count），加载更多以已落地页为基准；任务事件补丁只改 `lastTask` 已有字段，刷新信号为新增带配置的任务 / 状态变化 / 删除；
详情弹窗先同步清空再换 key，编辑态等首读落地后填表。后端 `hold()`、`EventHold`、`pathql_view` 全链路已删，写命令直接返回行；IPC handler 顺带修正了乱码头注释。
`liveQuery.ts` 仍有 `DEBUG-PERF` 插桩，随 Phase E 删除整个文件。

真机（debug ingest 只记 `run_configs://` 请求，已删除插桩）：

| 操作 | 列表 key | 失败数 key | 详情 key | 结果 |
| --- | --- | --- | --- | --- |
| 进入自动配置页 | 1 | 1 | — | 5 张卡片，总数 5，无更多 |
| 复制配置 | 1 | 1 | — | 返回规整单行，总数 6 |
| 打开详情 | — | — | 1 | |
| 详情开着时改名 | 1 | 1 | 1 | 卡片与弹窗都显示新名 |
| dry-run 运行配置 | 3 | 3 | — | 新增立即 1 次、窗口合并状态变化 1 次、完成 1 次；卡片成功 +0 |
| 删除该任务 | 1 | 1 | — | 卡片回到未运行 |
| 删除配置 | 1 | 1 | — | 总数 5，卡片消失 |

测试配置与任务均已删除。未测：超过 20 条的加载更多与失败重试、换筛选排序、运行中张数补丁（dry-run 张数为 0）、失败数实际变化、
弹窗内编辑保存、任务列表配置名、推荐导入态、CLI / IPC 实际调用、Web SSE、Android。

### 补测（代理，2026-10-22）

环境：macOS CEF dev（用户已在跑 `deno task dev -c kabegame`，未重启）；UI 经 kabegame-chromium 驱动，pinia store 与 `AutoConfigs` 组件 setupState 直接调用。
请求计数：在 `kbEvents/pathqlSource.ts` 的 `pathqlRequest$.subscribe` 里临时上报 `run_configs://` key（`.kabegame/debug/debug-c3.ndjson`，按 `ts` 排序），同处另加了一个 `__c3FailMatch` 失败注入；
推荐行请求改为在页面订阅同一模块实例（带 `?t=` 的 URL）的 `pathqlRequest$`。插桩已 `git checkout` 还原（该文件开始时无改动），`rg -n "DEBUG-c3" apps src-tauri` 为空。
测试前配置 5 条、任务 217 条；结束后 id 集合与开始时完全一致，用户原有 5 条配置未修改。测试配置一律 `isDryRun: true`，没有跑任何真实下载。

| 项 | 操作 | 请求次数 | 结果 |
| --- | --- | --- | --- |
| 1 超过 20 条加载更多 | 连续 `addRunConfig` 41 条（总数 46） | 列表 2、失败数 2（41 次写合并） | 首屏 `x20x/1` 20 行、总数 46、hasMore=true |
| | `loadMore` ×3 | `x40x/1` 1、`x60x/1` 1、第三次 0 | 40→46 行，第二次后 hasMore=false；行与总数在同一 `onResult` 落地；UI 按钮点击同样有效 |
| | 第三页后新增 1 条、删除 1 条 | 每次列表 1、失败数 1 | 刷新的是 `x60x/1`，47→46 |
| 2 失败重试 | 注入 `x40x` 下一次读取失败后 `loadMore`，再点两次 | `x40x` 失败 1、`x40x` 重试 1、`x60x` 1 | 首屏 20 行/总数保留，重试同 key 成功到 40，再到 46 |
| 3 换筛选与排序 | state enabled/paused、last never/failed、plugin×2、mode×4、清空；6 种排序×2 方向；组合筛选 | 每次换路径恰好 1；路径不变 0 | 每次同步清空为 0 行；落地行序与直接 `pathql_fetch` 一致、总数一致；2ms 内连切两个筛选最终是后者结果 |
| 4 新增与导入 | `addRunConfig`；推荐 tab 经页面 `importPreset` 导入 anime-pictures/blue-archive；复制；改副本名；改副本 userConfig；删原件；删副本 | 配置写各触发列表 1、失败数 1；recommended 行：导入 1、删原件 1、其它 0 | 写命令返回规整单行、无包装；导入后卡片「가져옴」；删除最后一个匹配配置后恢复未导入 |
| 5 定时开关移入移出 | `enabled` 下关/开（4→3→4），`paused` 下关/开（42→43→42） | 每次列表 1、失败数 1 | 行与总数正确 |
| 6 失败数 | aibooru tags 模式填 5 个标签（插件同步抛 tooManyTags）制造 dry-run 失败；随后跑一次成功 dry-run；删成功任务；删配置 | 新增任务立即 1 次，状态变化 500ms 窗口合并 1 次；删任务 1 次 | 0→1→0（成功覆盖）→1（删最近任务回退到失败）→0（删配置）；页头「최근 실패 1개」 |
| 7 详情弹窗 | `openExisting(id,"edit")`，5ms 采样；改名称/描述后 `handleSave` | 详情 key 首读 1、保存后事件 1 | 首读期间 showMissing 始终 false、`.acd-missing` 未出现；保存后回查看态显示新内容 |
| | 弹窗开着时 store 删除 | 详情 1 | 显示「관련 실행 설정을 찾을 수 없습니다」 |
| | A→B 快速切换，再手动请求 A 的 key、改名 A | A 1、B 1、A 手动 1，之后 0 | 弹窗始终显示 B |
| 8 任务列表配置名 | 任务抽屉（`TaskDrawer` 用 `usePagedTaskList`）；配置关联 dry-run 任务后改名、删配置；另测 `start()` 后立即改名；`scheduled` 触发源任务看图标 title | — | 改名后行与 title 为新名；删除后 runConfigName=null，title 回退为配置 id；`start()` 后改名结果正确但无法确认走的是启动缓冲 |
| 9 运行中张数补丁 | 真实下载不跑；用 `plugin:event\|emit` 向 `tasks-change` 发合成 TaskChanged | 0 | 仅 progress：不改行；`successCount:7, failedCount:2`：立即补到 lastTask |
| 10 CLI / app IPC | dev CLI `--help` 无运行配置命令；临时 Python CBOR 客户端（scratchpad，未入库）直连 `kabegame-dev.sock` | 列表与失败数每次写各 1 | status：ipcProtocol=3；add→message added + 25 字段原始行；update→updated + 新名；delete→deleted + data null；均无 configId/reason/config/seq/view |

发现的问题（均未修改代码）：

1. **加载更多失败没有任何反馈**（低）。`apps/kabegame/src/composables/usePagedRunConfigs.ts:21` 的 `usePathqlLookAll` 没有传 `onError`，失败后只是 loading 结束、按钮仍在，用户看不到错误。
   复现：让 `x40x` 读取失败后点「+더 보기」。
2. **失败后会被事件悄悄扩窗**（低，代码分析，未实测）。`loadMore` 先把 `page` 设为 `landedPage + 1`（`usePagedRunConfigs.ts:61`），失败后观察的 key 仍是更大的窗口；
   这时任何 `auto-config-change` 或任务信号都会刷新这个 key，成功后列表直接变成 40 行。用户没有再点按钮，列表也会变长。
   结果仍然正确，与"失败后重试同 key"的设计一致，但"加载更多只来自用户操作"在这里不成立。
3. **写命令返回行与首轮刷新可能缺 `schedulePlannedAt`**（低，既有问题）。
   - 开定时后，`update_run_config` 返回的行里 `schedulePlannedAt` 为 null，紧接着直接读才有值。
   - 原因是 `Scheduler::reload_config` 只 `notify`（`src-tauri/kabegame-core/src/scheduler/mod.rs:45`），调度循环随后写 `schedule_planned_at`（同文件 `:86`），而这次写不发 `auto-config-change`。
   - 本轮列表事件刷新读到了正确值；但如果刷新先于调度循环落地，卡片「下次运行」要等下一个事件才会补上。
   - 详情弹窗保存时，`config.value = updateRunConfig(...)` 也会先显示空的下次运行时间，随后由事件刷新覆盖。
   - 旧实现同样在命令内读行，不是本次引入的。
4. **「플러그인 추천 (N)」在「내 구성」tab 显示 (0)**（低，既有问题，非本次 diff）。`useRecommendedPresets` 只在推荐 tab 启用（`apps/kabegame/src/views/AutoConfigs.vue:406`），tab 标签计数（`:331`）在 mine tab 下为 0。

未测及原因：
- 真实下载运行中的张数补丁：按约束不跑真实下载，只做了合成事件。
- 不属于配置的手动任务状态变化：只是多一次刷新，未专门测。
- 任务列表启动缓冲的确定性覆盖：首屏读取太快，无法稳定让事件落在读取期间。配置详情里的关联任务列表 `AutoConfigRelatedTasks` 未实测。
- Web SSE、Android：本轮只连桌面 CEF dev。

### 补测问题修复（2026-10-23）

- 问题 1（加载失败无提示）：`usePagedRunConfigs` 增加 `onError` 选项透传给观察方，`AutoConfigs.vue` 弹 `common.refreshFailed`。
- 问题 3（下次运行时间缺事件）：`scheduler_loop` 在 `schedule_planned_at` 为空时补算并写入后，成功则补发 `configchange`；其它三处写入（触发后、漏跑立即运行、漏跑忽略）原本已发。
  真机：开启每日定时后该配置收到写命令与调度循环各一条 `configchange`，库中 planned_at 已写入。
- 问题 4（推荐标签 (0)）：非推荐 tab 时计数取插件 store 声明的 `kbRecommendedConfigs` 数量（随插件事件更新、不发请求），推荐 tab 内仍用实际条目数。
  `plugin://` 是程序化 provider、没有 total，观察 count 需要给 provider 加计数且每插件仍读一次文件，与打开推荐 tab 开销相同，故不采用。真机两处均为 45。
- 问题 2（失败后事件扩大窗口）：按用户确认不改。
- 验证：vue-tsc 0 error；Vitest 46 文件 / 401 项通过；`cargo check -p kabegame-core` 通过（3 条既有警告不在本次文件）。
