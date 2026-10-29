# 数据库迁移与可恢复回填

本文描述 Kabegame 数据库的两类迁移（同步 schema 迁移 / 可恢复的异步回填作业）、它们之间的依赖声明，
以及配套的三段式启动与前端启动页（Init app）。

## 涉及文件

| 层 | 文件 | 作用 |
|---|---|---|
| core | `src-tauri/kabegame-core/src/storage/migrations/mod.rs` | `MIGRATIONS` 注册表、`Migration.min_backfill_version`、`run_pending` 两阶段、`StartupProgress`、`BACKFILL_JOBS_DDL` |
| core | `src-tauri/kabegame-core/src/storage/migrations/backfill.rs` | `Backfill` / `BatchOutcome` / `BackfillCtx`、`BACKFILLS` 注册表、`enqueue_introduced_at`、`pending_jobs`、`run_to_completion`，以及框架测试 |
| core | `src-tauri/kabegame-core/src/storage/migrations/backfills/` | 作业实现目录（发布态为空） |
| core | `src-tauri/kabegame-core/src/storage/migrations/v048_backfill_jobs.rs` | 建 `backfill_jobs` 表（`init::create_all_tables` 共用同一 DDL） |
| core | `src-tauri/kabegame-core/src/storage/backfill_service.rs` | `BackfillService`：后台按序跑剩余作业，忙碌快照 + `backfill-finished` |
| core | `src-tauri/kabegame-core/src/storage/startup_state.rs` | `StartupPhase` watch 单例（不依赖 Tauri / `GlobalEmitter` / `Storage::global()`） |
| core | `src-tauri/kabegame-core/src/commands/busy_tasks.rs` | `BusyTasksSnapshot.backfills` |
| app | `src-tauri/kabegame/src/core_init.rs` | `init_fast_globals` / `init_heavy_globals` |
| app | `src-tauri/kabegame/src/lib.rs` | `init_pre` → 线程内 heavy → 主线程 `init_post` → `start_pending` → `Ready`；`startup-progress` 转发 |
| app | `src-tauri/kabegame/src/commands/misc.rs` | `get_startup_state` 命令 |
| app | `src-tauri/kabegame/src/ipc/handlers/mod.rs` | IPC `status` 的 `backfillPending` |
| 前端 | `apps/kabegame/src/bootstrap/initScreen.ts`、`views/InitScreen.vue` | 启动页 mount / unmount |
| 前端 | `apps/kabegame/src/bootstrap/app.ts` | 非 web 先 `runInitScreen()` 再挂主界面 |
| 前端 | `stores/backfill.ts`、`services/backfill.ts`、`components/busy/BusyBackfillCard.vue`、`utils/backfillName.ts` | 后台回填忙碌卡片与失败 toast |

## 两类迁移

**schema 迁移**保持原状：按 `PRAGMA user_version` 顺序执行，改结构、短、必须在进入界面前完成。

**回填作业**是「按现有列补算数据」的长作业，不再写成迁移 `up` 里的循环，而是注册表里的 `Backfill`：

```rust
pub struct Backfill {
    pub id: &'static str,              // 全局唯一，也是 backfill_jobs.id
    pub introduced_at: u32,            // 登记它的迁移版本
    pub platforms: fn() -> bool,       // 平台门控
    pub batch_size: usize,
    pub count_remaining: fn(&Connection) -> Result<usize, String>,           // 登记时的进度分母
    pub run_batch: fn(&BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String>,
}
```

作业由某个 schema 迁移在跨过其版本时**登记**进 `backfill_jobs`（`INSERT OR IGNORE`，`total` 取当时的
`count_remaining`）。**新增回填不需要真的改 schema**：写一个 `up` 为空的迁移专门用来登记即可。作业代码是随应用
维护的活代码，不是冻结 SQL。**全新安装**走 `create_all_tables` 直接是最新 schema，不登记任何作业。

`backfill_jobs`：

```sql
CREATE TABLE IF NOT EXISTS backfill_jobs (
    id            TEXT    PRIMARY KEY,
    introduced_at INTEGER NOT NULL,
    cursor        INTEGER NOT NULL DEFAULT 0,   -- 已处理到的 rowid
    processed     INTEGER NOT NULL DEFAULT 0,
    total         INTEGER,
    done          INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    updated_at    INTEGER NOT NULL
);
```

## 执行模型

作业按批推进。作业拿到的不是裸 `&Connection`，而是 `BackfillCtx`：

- `with_conn(|conn| …)`：按需短暂取连接（后台阶段锁 `storage.db`，闭包返回即释放），不开事务。
- `block_on(fut)`：在同步作业里跑异步（转码等），调用期间不持有连接。阻塞阶段在作用域线程里临时建
  current_thread runtime（调用方可能已在 runtime 里，如 CLI 的 `#[tokio::main]`、web 的 `block_on`）；
  后台阶段用 tokio `Handle`（与整理服务一致）。
- `commit(|conn| -> BatchOutcome)`：在一个 `BEGIN IMMEDIATE … COMMIT` 里执行本批写入，并在**同一事务**内把
  `cursor` / `processed`（以及 `next_cursor = None` 时的 `done = 1`）写回 `backfill_jobs`。每批至多一次；
  本批没有写入时由 `run_to_completion` 只提交进度。

由此：崩溃后从游标续跑、已提交的批不重做；批间释放写锁，用户写入可以穿插；重 IO 作业可以「取一批候选 →
释放锁做转码 → 再取锁提交」，而不是抱着写锁转码。提交失败时作业应自行清理本批产生的派生文件。

`run_batch` 返回 Err 视为基础设施错误：`attempts += 1`、记 `last_error`，进度停在最后一次提交，下次启动重试。
游标未推进（`next_cursor == Some(cursor)`）也按错误处理，防止死循环。逐行可恢复的问题（文件缺失、探测失败）
应在作业内跳过并记日志，不要返回 Err。

## 依赖：`min_backfill_version`

`Migration.min_backfill_version: Option<u32>` 表示「`introduced_at ≤ 该值` 的全部回填必须已完成，我才能执行」。
`run_pending` 的流程：

1. 按序走待执行的 schema 迁移；
2. 遇到带 `min_backfill_version` 的迁移，先**同步排干**它要求的未完成作业（阻塞集），进度经 `StartupProgress`
   上报给启动页；当前平台跑不了的被要求作业直接标记 `done = 1`（`last_error = 'skipped: …'`）——依赖它的迁移
   即将改动它读写的列，它之后不能再运行；
3. 执行迁移，**登记**它引入的作业，再推进 `user_version`（登记失败时下次启动重跑该迁移，迁移幂等、登记幂等）；
4. 全部跑完后 `user_version == LATEST`，剩余未完成作业交给 `BackfillService` 在后台按 `introduced_at, id` 顺序逐个跑。

**不变量**：回填只读写它引入时就已存在的列；之后任何想改动这些列的 schema 迁移必须用 `min_backfill_version`
先排干它（排干后它不再运行）。阻塞集只含被显式要求的作业，不是「所有更老的」，跨多版本升级不会无谓等待。

**调试**：`KABEGAME_BACKFILL_SYNC_THROUGH=<version>` 把阻塞集扩大到 `introduced_at ≤ version`（已是最新版本时
也会排干），用来真机验证阻塞 UI，不必给用户发一个假依赖。

## 平台门控

`platforms()` 在 `pending_jobs` 过滤时生效（阻塞与后台两阶段一致）。被门控跳过的作业保持 pending、不计 attempts，
等到能跑的平台再跑（例外见上：被依赖时标记跳过）。

## 进程边界

- **主程序（桌面 / Android）**：阻塞阶段在 `Storage::new()` 里（重型初始化线程），后台阶段由 `BackfillService`。
- **CLI 本地模式**：共用 `Storage::new()`，只跑阻塞阶段然后执行命令、退出；不启动后台服务，未完成作业留给下次主程序。
  `init_global_read_only`（`pathql query`）只看 `user_version`，不受影响。
- **web 服务进程**：监听前顺序初始化完，随后照常启动后台服务。

## 后台服务与忙碌卡片

`BackfillService::start_pending(storage)`（须在 tokio 上下文调用，进程内只启动一次）读一次待办列表，把全部作业放进
内存状态（排队中的 `running = false`），在 blocking 线程池里逐个 `run_to_completion`：

- 每个作业开始时 `emit_busy_tasks_change("backfill")` 唤醒前端快照轮询（遵循 `cocs/ui/BUSY_TASKS_POLLING.md`：
  进度只更新内存状态，不发高频事件）；
- 每批有图片字段补丁则 `emit_image_patches`（前端 `images-change` 补丁窗口合并）；
- 作业结束（成功或失败）从状态移除并发 `backfill-finished { id, processed, total, error }`；失败不阻塞后续作业。

前端 `get_busy_tasks_snapshot().backfills` → `useBackfillStore`，`BusyBackfillCard` 标题固定「更新数据库」，
副标题取 i18n `header.backfill.<id>`、缺省回落 id；排队中的作业显示「排队中」。`backfill-finished` 带 error 时 toast。
IPC `status` 附带 `backfillPending`（只增字段，不升 `IPC_PROTOCOL_VERSION`）。

## 三段式启动与启动页

```
setup (主线程)
 └─ init_pre：init_fast_globals（Settings / i18n / 事件广播）→ 事件循环与转发
              → startup-progress 转发 → 非 --minimized 时 create_main_window → CEF relaunch 处理器
 └─ spawn "kabegame-init" 线程，setup 立即返回
      ├─ init_heavy_globals：PluginManager → Storage（迁移 + 阻塞回填）→ 调度器 → 各 Service
      ├─ run_on_main_thread_sync(init_post)：托盘、壁纸控制器、下载 worker、IPC / Web 服务、插件缓存 …
      ├─ BackfillService::start_pending
      └─ startup_state = Ready（任一步 Err → Failed{message}）
```

- `startup_state` 是 core 里的 `tokio::sync::watch` 单例，进入 `Ready` / `Failed` 后不再变化。app 层把它转成
  `startup-progress` 事件，并提供 `get_startup_state` 命令（只读快照，不碰 `Storage::global()`）。
- 前端 `bootstrap/app.ts` 在样式与平台 class 处理之后，非 web 先 `runInitScreen()`：挂一个最小 Vue app
  （根组件 `InitScreen.vue`，只注册 `ElProgress`），**先监听 `startup-progress` 再取 `get_startup_state`**（避免中间
  到达的 ready 丢失）；收到 `ready` 后 `unmount()`，再按原方式创建并挂载主界面。主界面所有 store 在 mount 时的
  invoke 因而都发生在全局单例就绪之后，主界面代码不需要任何门控。
- 启动页**不** `app.use(i18n)`：vue-i18n 在 `app.unmount` 时会 dispose 全局 composer 的 effect scope，共用同一个
  i18n 实例的主界面会因此失去语言响应性。启动页直接用 `i18n.global.t`，语言由 `get_language` 设定。
- 不用模块顶层 await：构建 target（es2021 / safari13）不支持，改为 `runInitScreen().then(mountMainApp)`。
- `Failed`：启动页显示错误与「退出」按钮（`exit_app`，全局单例未就绪时也安全）；没有主窗口（`--minimized`）时
  回落原生错误对话框。`init_pre` 本身失败仍走 setup 里的致命错误对话框。
- Android 共用同一个 bootstrap：主 webview 若在 setup 返回前已创建就能看到进度，否则启动页一闪而过；
  web 服务端在监听前已初始化完，`IS_WEB` 直接跳过启动页。

## 新增一个回填的步骤

1. 在 `migrations/backfills/` 写作业模块，导出 `pub(crate) const JOB: Backfill`；候选查询带「仍需处理」条件，
   写入经 `ctx.commit`，有派生文件时提交失败要清理。
2. 在 `backfill.rs` 的 `BACKFILLS` 登记；`introduced_at` 指向一个迁移（可以新写一个 `up` 为空的迁移）。
3. 若后续迁移要改动它读写的列，给那个迁移声明 `min_backfill_version`。
4. 补 i18n `header.backfill.<id>`（五种语言）。
5. 注册表测试会检查：`introduced_at` 对应某个迁移且 ≥ 48、`min_backfill_version < version`、id 唯一。

## 历史验证

框架落地时用两个临时作业做过 dev 真机验证（之后已删除，`BACKFILLS` 发布态为空）：
`metadata_search_terms_rebuild`（v048 登记，为无映射的 metadata 按默认规则重建 `metadata_search_terms`；
已知取舍：插件曾用 `searchTexts` 自定义过的行会按默认规则重建，下次插件升级的 `provideSearchTextList` 再覆盖）
与 `image_compatible_path`（v049 空迁移登记，非 Android，复用整理的逐行兼容副本生成；每批遇到第一个真正生成的
副本就提交，强杀时最多留下一个未落库的副本文件）。`wallpaper_compatible_path` 是惰性生成的，不做回填。
