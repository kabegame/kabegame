# 自动运行配置与定时运行 — 分步实施计划

> 基于 `AUTO_TASKS_PDD.md` 产品需求，结合现有代码库拆解的工程落地计划。

---

## 总览

| 阶段 | 名称 | 核心目标 | 主要涉及层 |
|------|------|----------|-----------|
| **Phase 1** | 数据层扩展 | `run_configs` 表加定时字段；`tasks` 表加 `run_config_id` + `trigger_source` | Rust storage / Prisma 文档 / 前端类型 |
| **Phase 2** | Rust 后端调度引擎 | 进程内定时触发器（三种模式）+ 持久化 + 漏跑检测 | Rust core |
| **Phase 3** | 前端「自动运行配置」Tab | 新路由 + 列表/编辑页 + 定时区块 + CRUD/复制/手动执行 | Vue / Pinia / Router |
| **Phase 4** | CrawlerDialog 改造 | 不编辑配置；选择已有配置 → 手动执行；入口跳转 Tab | Vue |
| **Phase 5** | 任务抽屉改造 | 闹钟图标（仅定时触发）；点击闹钟 → 跳配置编辑定时区块 | Vue |
| **Phase 6** | 启动漏跑弹窗 | 启动时扫描漏跑 → 模态确认 → 立即执行 / 暂不处理 | Rust + Vue |
| **Phase 7** | i18n & 文案 & 无障碍 | 五种语言 key；aria-label；文案润色 | i18n JSON |
| **Phase 8** | 集成测试 & 验收 | 逐条验收 PDD §8 标准 | 全栈 |

---

## Phase 1：数据层扩展

### 1.1 `run_configs` 表新增定时字段

在 `src-tauri/core/src/storage/mod.rs` 中以 `ALTER TABLE ... ADD COLUMN` 迁移方式（项目既有模式）追加以下列：

| 列名 | 类型 | 说明 |
|------|------|------|
| `schedule_enabled` | `INTEGER NOT NULL DEFAULT 0` | 定时总开关（0=关, 1=开） |
| `schedule_mode` | `TEXT` | 模式：`interval` / `daily` / `delay_once`；NULL=未设置 |
| `schedule_interval_secs` | `INTEGER` | 模式一「循环周期」：间隔秒数 |
| `schedule_daily_hour` | `INTEGER` | 模式二「每日」：时（`-1`=每时，`0-23`=某时）；NULL=未设置 |
| `schedule_daily_minute` | `INTEGER` | 模式二「每日」：分（`0-59`）；NULL=未设置 |
| `schedule_delay_secs` | `INTEGER` | 模式三「延迟运行」：延迟秒数 |
| `schedule_planned_at` | `INTEGER` | 模式三持久化的**计划执行绝对时刻**（Unix 秒）；用于重启恢复 |
| `schedule_last_run_at` | `INTEGER` | 最后一次**定时触发**运行完成的时间戳（仅 Scheduled 来源写入） |

### 1.2 `tasks` 表新增关联字段

| 列名 | 类型 | 说明 |
|------|------|------|
| `run_config_id` | `TEXT` | 关联的运行配置 ID（可 NULL，向后兼容） |
| `trigger_source` | `TEXT NOT NULL DEFAULT 'manual'` | `manual`=手动 / `scheduled`=定时触发 |

迁移方式同上：`ALTER TABLE tasks ADD COLUMN ...`，既有行自动获得默认值。

### 1.3 Rust `RunConfig` 结构体更新

文件：`src-tauri/core/src/storage/run_configs.rs`

```rust
pub struct RunConfig {
    // ...existing fields...
    pub schedule_enabled: bool,
    pub schedule_mode: Option<String>,         // "interval" | "daily" | "delay_once"
    pub schedule_interval_secs: Option<i64>,
    pub schedule_daily_hour: Option<i32>,       // -1 = 每时
    pub schedule_daily_minute: Option<i32>,
    pub schedule_delay_secs: Option<i64>,
    pub schedule_planned_at: Option<i64>,       // Unix 秒
    pub schedule_last_run_at: Option<i64>,      // Unix 秒
}
```

同步更新 `add_run_config` / `get_run_configs` / `update_run_config` 的 SQL 语句与字段映射。

### 1.4 Rust `TaskInfo` 结构体更新

文件：`src-tauri/core/src/storage/tasks.rs`

```rust
pub struct TaskInfo {
    // ...existing fields...
    pub run_config_id: Option<String>,
    pub trigger_source: String, // "manual" | "scheduled"
}
```

同步更新 `create_task` / `get_task` / `get_tasks_page` 等 SQL。

### 1.5 前端 TypeScript 类型更新

文件：`packages/core/src/stores/crawler.ts`

```typescript
export interface RunConfig {
  // ...existing fields...
  scheduleEnabled: boolean;
  scheduleMode?: "interval" | "daily" | "delay_once";
  scheduleIntervalSecs?: number;
  scheduleDailyHour?: number;      // -1 = 每时
  scheduleDailyMinute?: number;
  scheduleDelaySecs?: number;
  schedulePlannedAt?: number;
  scheduleLastRunAt?: number;
}

export interface CrawlTask {
  // ...existing fields...
  runConfigId?: string;
  triggerSource: "manual" | "scheduled";
}
```

### 1.6 Prisma 文档更新

文件：`schema.prisma` — 同步新增字段文档，保持与实际 SQLite 一致。

### 1.7 Tauri 命令更新

文件：`src-tauri/app-main/src/commands/task.rs`

- `add_run_config` / `update_run_config`：入参接受新的 schedule 字段。
- `get_run_configs`：返回包含 schedule 字段的完整数据。
- `add_task`（创建爬虫任务）：新增可选参数 `run_config_id: Option<String>` 与 `trigger_source: Option<String>`。
- 新增命令 `copy_run_config`：复制配置（新 id，定时字段按策略处理——建议复制时**关闭**定时总开关）。

**完成标志**：`bun check` 无新增 lint 错误；数据库能正常打开并兼容旧数据。

### 遗留问题：
- 右键任务导出运行配置如何处理

---

## Phase 2：Rust 后端调度引擎

### 2.1 新模块 `src-tauri/core/src/scheduler/`

创建 `mod.rs`，职责：

1. **启动时加载**所有 `schedule_enabled = true` 的 `RunConfig`。
2. 按模式计算**下次触发时间**（`next_fire_at`）。
3. 用 `tokio` 定时器（`tokio::time::sleep_until` 或 `tokio::time::interval`）等待触发。
4. 触发时通过既有 `TaskScheduler`（`src-tauri/core/src/crawler/scheduler.rs`）创建并运行爬虫任务，`trigger_source = "scheduled"`。
5. 运行完成后回写 `schedule_last_run_at`；若为 `delay_once` 则关闭定时。

### 2.2 三种模式触发逻辑

#### 模式一：循环周期（`interval`）

```
next_fire_at = max(schedule_last_run_at + schedule_interval_secs, now)
```

- 首次（无 `schedule_last_run_at`）：以配置保存时刻 + interval 为首触发。
- 运行完成后回写 `schedule_last_run_at = now()`。

#### 模式二：固定周期（`daily`）

- 根据 `schedule_daily_hour`（`-1` = 每时 0-23, 其他 = 指定时）与 `schedule_daily_minute`（NULL → 0）展开当天所有时间槽。
- 找出**下一个**尚未到达的槽位作为 `next_fire_at`。
- 若当天所有槽位已过，则取明天首个槽位。

#### 模式三：延迟运行（`delay_once`）

- `next_fire_at = schedule_planned_at`（绝对时刻，保存时写入 `now + schedule_delay_secs`）。
- 到点执行一次后：`schedule_enabled = false`，清空 `schedule_planned_at`。

### 2.3 配置变更时的调度更新

当前端保存/更新 `RunConfig` 的 schedule 字段后：

- Rust 命令层调用 `Scheduler::reload_config(config_id)`。
- Scheduler 取消该 config 的旧定时器，按新参数重新计算 `next_fire_at` 并注册。
- 删除配置时调用 `Scheduler::remove_config(config_id)`。

### 2.4 全局单例与生命周期

- `Scheduler` 为全局 `OnceLock`（与 `Storage` / `TaskScheduler` 风格一致）。
- Tauri plugin `init()` 阶段调用 `Scheduler::start()`，在 `tokio::spawn` 中运行事件循环。
- 应用退出时 Scheduler 自然随进程结束。

### 2.5 `addTask` 链路扩展

现有 `addTask`（前端 → Tauri 命令 → `TaskScheduler`）需支持：
- 传入 `run_config_id` 和 `trigger_source`。
- 写入 `tasks` 表对应列。
- Scheduler 触发时内部调用同一链路，`trigger_source = "scheduled"`。

**完成标志**：单元测试覆盖三种模式的 `next_fire_at` 计算；手动验证定时触发能正常创建任务。

---

## Phase 3：前端「自动运行配置」Tab

### 3.1 路由注册

文件：`apps/main/src/router/index.ts`

```typescript
{
  path: "/auto-configs",
  name: "AutoConfigs",
  component: AutoConfigs,
  meta: { title: "route.autoConfigs" },
},
{
  path: "/auto-configs/:id/edit",
  name: "AutoConfigEdit",
  component: AutoConfigEdit,
  meta: { title: "route.autoConfigEdit" },
},
```

### 3.2 导航入口

- 侧边栏 / 底部 Tab 新增「自动运行配置」条目（图标建议：闹钟或日历 + 播放）。
- Android 底部导航增加该 Tab。

### 3.3 列表页 `AutoConfigs.vue`

新建 `apps/main/src/views/AutoConfigs.vue`：

- 从 `crawlerStore.runConfigs` 渲染列表。
- 每项显示：**配置名称**、**关联插件名**、**定时摘要**（人类可读，如「每 6 小时」「每天 08:30」「30 分钟后一次」）、**启用状态**（开关 chip）、**上次自动运行时间**。
- 列表操作：
  - **新建**：跳转编辑页（空表单）。
  - **编辑**：跳转编辑页。
  - **删除**：确认后调用 `crawlerStore.deleteRunConfig`。
  - **复制**：调用 `copy_run_config` 命令。
  - **立即运行**（手动执行一次）：调用 `crawlerStore.addTask`（`trigger_source = "manual"`），显示 toast。
- 可选：顶部筛选「仅已启用定时」。

### 3.4 编辑页 `AutoConfigEdit.vue`

新建 `apps/main/src/views/AutoConfigEdit.vue`（或用抽屉/Dialog，按平台选择）：

**区块一：基本信息**
- 配置名称、描述。

**区块二：插件与参数**
- 插件选择（复用现有插件选择器）。
- URL / 变量表单 / 输出目录 / HTTP Headers（复用 `CrawlerDialog` 中的表单组件，考虑抽取为独立组件）。

**区块三：定时运行**（核心新增）
- **总开关**（`el-switch`）：`scheduleEnabled`。
- **模式选择**（`el-radio-group`）：循环周期 / 每日固定 / 延迟运行。
- 切换模式时，清空其他模式的专有字段（可加轻量确认）。
- **模式一表单**：数值 + 单位（分钟/小时/天）。
- **模式二表单**：时选择（每时/指定时刻/不指定）+ 分选择（0-59/不指定）。
- **模式三表单**：延迟数值 + 单位（分钟/小时）。
- **实时预览摘要**：一行文字描述触发规则。
- **保存**：调用 `crawlerStore.updateRunConfig` 或 `addRunConfig`；若定时已启用，toast 提示「应用需保持运行」。

### 3.5 倒计时进度条（PDD §6.3）

新建 `packages/core/src/composables/useScheduleProgress.ts`：

**核心 composable：`useScheduleProgress(config: Ref<RunConfig>)`**

返回响应式对象 `{ percent, remaining, total, active }`：

```typescript
interface ScheduleProgress {
  percent: number;    // 0–1，进度条填充比例
  remaining: number;  // 剩余秒数
  total: number;      // 进度条总量（秒）
  active: boolean;    // 是否应显示进度条
}
```

**总量计算逻辑**

```typescript
function getScheduleTotal(config: RunConfig): number {
  switch (config.scheduleMode) {
    case "interval":
      return config.scheduleIntervalSecs ?? 0;
    case "delay_once":
      return config.scheduleDelaySecs ?? 0;
    case "daily":
      return config.scheduleDailyHour === -1 ? 3600 : 86400;
    default:
      return 0;
  }
}
```

**已消耗量计算逻辑**

```typescript
function getScheduleElapsed(config: RunConfig, nowSecs: number): number {
  switch (config.scheduleMode) {
    case "interval": {
      const anchor = config.scheduleLastRunAt ?? config.createdAt;
      return nowSecs - anchor;
    }
    case "delay_once": {
      const startAt = (config.schedulePlannedAt ?? 0)
                    - (config.scheduleDelaySecs ?? 0);
      return nowSecs - startAt;
    }
    case "daily": {
      // 需根据 scheduleDailyHour / scheduleDailyMinute
      // 计算「上一个触发槽位时刻」
      const prevSlot = computePrevDailySlot(config, nowSecs);
      return nowSecs - prevSlot;
    }
    default:
      return 0;
  }
}
```

**定时器驱动**

- composable 内部 `onMounted` 启动 `setInterval(1000)`，每秒更新 `nowSecs = Date.now() / 1000`。
- `onUnmounted` 清除定时器。
- `percent = Math.min(elapsed / total, 1)`；`remaining = Math.max(total - elapsed, 0)`。

**配置变更重置**

- `watch(() => [config.scheduleMode, config.scheduleIntervalSecs, config.scheduleDailyHour, config.scheduleDailyMinute, config.scheduleDelaySecs, config.schedulePlannedAt], ...)`
- 当上述字段变化时，total 自动重算；elapsed 基于新的锚点（`createdAt` / `schedulePlannedAt`）重新计算，等效于归零。

**列表项组件集成**

新建 `packages/core/src/components/scheduler/ScheduleProgressBar.vue`：

- Props：`config: RunConfig`。
- 内部调用 `useScheduleProgress(toRef(props, 'config'))`。
- 渲染 `el-progress`（或自定义进度条）+ 剩余时间文字（如「还剩 2h 15m」）。
- `active = false` 时不渲染（`v-if`）。
- `aria-label`：「距下次运行还剩 {remaining} 」。

在 `AutoConfigs.vue` 列表的每个配置卡片中嵌入 `<ScheduleProgressBar :config="item" />`。

### 3.6 Store 扩展

文件：`packages/core/src/stores/crawler.ts`

- `addRunConfig` / `updateRunConfig`：支持 schedule 字段。
- 新增 `copyRunConfig(configId: string)`。
- 新增 `runConfigById(id: string): RunConfig | undefined` 计算属性。
- 新增 `runFromConfig(configId: string)`：用指定配置的参数立即创建任务（`trigger_source = "manual"`）。

### 3.7 组件复用与拆分

从 `CrawlerDialog.vue` 中抽取以下可复用部分为独立组件（放 `packages/core/src/components/crawler/`）：

- `PluginVarsForm.vue`：插件变量表单。
- `OutputDirSelect.vue`：输出目录选择。
- `HttpHeadersEditor.vue`：HTTP Headers 编辑。
- `OutputAlbumSelect.vue`：输出画册选择。

这样 `AutoConfigEdit` 和 `CrawlerDialog` 都可引用。

**完成标志**：可在新 Tab 中完成配置的 CRUD、复制；保存后 Scheduler 能正确注册定时。

---

## Phase 4：CrawlerDialog 改造

### 4.1 移除编辑能力，改为「选择配置」

文件：`apps/main/src/components/CrawlerDialog.vue`

**改造方向**：

1. 对话框打开时，从 `crawlerStore.runConfigs` 加载已保存的自动运行配置列表。
2. 用户在列表中**选择一条**配置。
3. 点击「开始收集」→ 调用 `crawlerStore.runFromConfig(selectedConfigId)`（`trigger_source = "manual"`）。
4. **不**再在对话框内展示/编辑插件变量、Headers 等表单。
5. 新增入口按钮：「管理自动运行配置」→ `router.push("/auto-configs")`。
6. 若无可用配置：显示空状态引导文案 + 「去新建」按钮 → 跳转 Tab。

### 4.2 兼容性

- 保留 `crawlerDrawerStore.setLastRunConfig` 的快照逻辑，记住上次选择的 `runConfigId`，下次打开默认选中。
- Android `App.vue` 中 `CrawlerDialog` 的挂载方式不变，仅内部内容更换。

**完成标志**：开始收集对话框不再编辑配置；可选择配置 → 手动执行；有入口跳转 Tab。

---

## Phase 5：任务抽屉改造

### 5.1 闹钟图标

文件：`packages/core/src/components/task/TaskDrawerContent.vue`

- 判断 `task.triggerSource === "scheduled"`：在任务项标题前渲染**闹钟图标**（`el-icon` / SVG）。
- `aria-label`：「由定时运行触发，配置：{configName}」。
- **手动**执行的任务（包含 Tab「立即运行」和对话框选配置开始）：**不**显示闹钟。

### 5.2 闹钟点击跳转

- **仅点击闹钟图标**时：
  1. 获取 `task.runConfigId`。
  2. `router.push({ name: "AutoConfigEdit", params: { id: runConfigId }, query: { focus: "schedule" } })`。
  3. 编辑页接收 `query.focus === "schedule"` → 自动滚动到「定时运行」区块。
- 点击任务行其余区域：保持原行为（查看运行详情 / 跳转 `/tasks/:id`）。
- 若关联配置已删除：toast 提示「关联的配置已不存在」。

### 5.3 任务项展示 `runConfigId` 信息

- 可选：在任务项副标题或 tooltip 显示关联的配置名称（从 `crawlerStore.runConfigs` 查找）。

**完成标志**：定时触发的任务显示闹钟；手动任务无闹钟；点闹钟可跳转配置编辑并聚焦定时区块。

---

## Phase 6：启动漏跑弹窗

### 6.1 Rust 侧漏跑检测

文件：新建 `src-tauri/core/src/scheduler/missed_runs.rs`

在 Scheduler 启动时（`Scheduler::start()`）执行：

1. 遍历所有 `schedule_enabled = true` 的 `RunConfig`。
2. 按模式判断漏跑：
   - **delay_once**：`now >= schedule_planned_at` 且未执行。
   - **interval**：`schedule_last_run_at + schedule_interval_secs < now`（至少错过一轮）。
   - **daily**：在离线期间错过的槽位；合并为「错过 N 次，最近一次应在 HH:MM」。
3. 收集漏跑项列表，通过 Tauri event 发送到前端：`emit("schedule-missed-runs", missedItems)`。

### 6.2 前端弹窗

文件：新建 `packages/core/src/components/scheduler/MissedRunsDialog.vue`

- 监听 `schedule-missed-runs` 事件。
- 收到非空列表时弹出模态对话框（`el-dialog`）。
- 内容：说明「因应用当时未运行，以下自动运行未在计划时刻执行」+ 配置列表。
- 主按钮「立即执行」→ 对每条漏跑项调用 `crawlerStore.runFromConfig(configId)`（`trigger_source = "manual"`）；执行后更新持久化状态（清除已触发的 delay_once、避免重复提示）。
- 次按钮「暂不处理」→ 关闭弹窗；恢复后续定时调度。
- Android：使用 `useModalBack` 注册模态返回栈。

### 6.3 Scheduler 侧补跑后处理

- **立即执行**完成后：
  - `delay_once`：`schedule_enabled = false`，清空 `schedule_planned_at`。
  - `interval`：更新 `schedule_last_run_at = now()`，重新计算下一周期。
  - `daily`：从当前时刻起恢复后续槽位。
- **暂不处理**：仅恢复后续定时节奏，不记为已完成。

**完成标志**：模拟离线后启动，能正确弹出漏跑弹窗；两个按钮行为符合 PDD §5.4。

---

## Phase 7：i18n & 文案 & 无障碍

### 7.1 新增 i18n 命名空间

在 `packages/i18n/src/locales/` 下各语言新建 `autoConfig.json`（或合并到 `tasks.json`），包含：

| Key | zh 示例 |
|-----|---------|
| `autoConfig.tabTitle` | 自动运行配置 |
| `autoConfig.create` | 新建配置 |
| `autoConfig.edit` | 编辑配置 |
| `autoConfig.copy` | 复制配置 |
| `autoConfig.delete` | 删除配置 |
| `autoConfig.runNow` | 立即运行 |
| `autoConfig.schedule` | 定时运行 |
| `autoConfig.scheduleEnabled` | 启用定时 |
| `autoConfig.modeInterval` | 循环周期 |
| `autoConfig.modeDaily` | 固定周期（每日） |
| `autoConfig.modeDelayOnce` | 延迟运行（一次） |
| `autoConfig.intervalSummary` | 每 {n} {unit} 运行一次 |
| `autoConfig.dailySummary` | 每天 {time} 运行 |
| `autoConfig.delaySummary` | {n} {unit} 后运行一次 |
| `autoConfig.keepRunningHint` | 应用需保持运行，定时才会在计划时刻执行 |
| `autoConfig.noConfigs` | 暂无自动运行配置，去新建一个吧 |
| `autoConfig.missedRuns.title` | 检测到未执行的定时任务 |
| `autoConfig.missedRuns.desc` | 因应用当时未运行，以下自动运行未在计划时刻执行 |
| `autoConfig.missedRuns.runNow` | 立即执行 |
| `autoConfig.missedRuns.dismiss` | 暂不处理 |
| `autoConfig.configDeleted` | 关联的配置已不存在 |
| `autoConfig.scheduledBadge` | 由定时运行触发 |
| `autoConfig.progress.remaining` | 还剩 {time} |
| `autoConfig.progress.ariaLabel` | 距下次运行还剩 {time} |

五种语言（zh / en / zhtw / ja / ko）各一份。

### 7.2 无障碍

- 闹钟图标：`aria-label` = `autoConfig.scheduledBadge` + 配置名。
- 漏跑弹窗按钮：`aria-label` 明确含义。
- 模式说明：「每时」「某时」加简短释义 tooltip。
- 「延迟运行」标注「只执行一次」。

### 7.3 路由标题

`route.autoConfigs` / `route.autoConfigEdit` 加入各语言的 `route.json`。

**完成标志**：所有新增 UI 文案均有 i18n key，五种语言覆盖。

---

## Phase 8：集成测试 & 验收

逐条对照 PDD §8 验收标准：

- [ ] 定时字段挂在运行配置上，无独立定时任务实体。
- [ ] 同一配置仅能保存一种定时模式；切换模式后旧模式参数清空。
- [ ] 三种模式行为符合 PDD §4（含延迟仅一次及执行后状态处理）。
- [ ] 新建并保存定时后，默认总开关为开。
- [ ] 产品含「自动运行配置」Tab；CRUD + 复制 + 立即运行（手动）。
- [ ] 开始收集对话框不编辑配置；提供跳转 Tab 入口；可选配置并开始 = 手动执行。
- [ ] 任务抽屉仅点击闹钟进入 Tab 内该配置编辑并定位定时区块。
- [ ] 仅定时触发的运行显示闹钟；手动执行不显示闹钟。
- [ ] 固定周期（每日）组合与 PDD §4.2 表一致。
- [ ] 延迟一次持久化计划执行绝对时刻；重启后恢复或识别漏跑。
- [ ] 间隔在定时触发执行完成后更新最后运行时间；手动不篡改。
- [ ] 「自动运行配置」列表中已启用定时的配置显示倒计时进度条，总量与模式对应（PDD §6.3）；前端每秒刷新。
- [ ] 配置变更后进度条归零并更新总量；关闭定时后进度条隐藏。
- [ ] 启动漏跑弹窗行为符合 PDD §5.4 / §6.5。

### 测试要点

| 场景 | 验证 |
|------|------|
| 新建配置 + 循环 6h | Scheduler 注册；6h 后自动创建任务；任务 `trigger_source = scheduled` |
| 每日 08:30 | 到 08:30 触发；跨天正确 |
| 延迟 30min | 30min 后触发一次；之后 `schedule_enabled = false` |
| 应用关闭 > 间隔 → 重启 | 弹漏跑弹窗；立即执行产生 manual 任务 |
| 手动「立即运行」 | 不更新 `schedule_last_run_at`；任务无闹钟 |
| 删除配置 | Scheduler 移除定时器；关联任务闹钟提示「配置已不存在」 |
| 复制配置 | 新配置定时默认关闭 |
| CrawlerDialog 选配置开始 | 等价手动执行；无闹钟 |
| 循环 6h 进度条 | 3h 后显示 50%；剩余时间文字正确 |
| 修改间隔 6h → 12h 保存 | 进度条归零；总量变为 12h |
| 每日（每时 :30） | 进度条总量 1h；每小时 :30 归零重新填充 |
| 关闭定时总开关 | 进度条隐藏 |

---

## 文件变更汇总

### Rust（后端）

| 文件 | 变更类型 |
|------|----------|
| `src-tauri/core/src/storage/mod.rs` | 修改：新增迁移 ALTER TABLE 语句 |
| `src-tauri/core/src/storage/run_configs.rs` | 修改：RunConfig 结构体 + CRUD SQL |
| `src-tauri/core/src/storage/tasks.rs` | 修改：TaskInfo 结构体 + SQL |
| `src-tauri/core/src/scheduler/mod.rs` | **新建**：调度引擎主模块 |
| `src-tauri/core/src/scheduler/missed_runs.rs` | **新建**：漏跑检测逻辑 |
| `src-tauri/core/src/lib.rs` | 修改：pub mod scheduler |
| `src-tauri/app-main/src/commands/task.rs` | 修改：命令参数扩展 + copy_run_config |
| `src-tauri/app-main/src/lib.rs` | 修改：注册新命令 + Scheduler 初始化 |

### 前端（Vue / TS）

| 文件 | 变更类型 |
|------|----------|
| `packages/core/src/stores/crawler.ts` | 修改：类型 + store 方法扩展 |
| `apps/main/src/router/index.ts` | 修改：新增路由 |
| `apps/main/src/views/AutoConfigs.vue` | **新建**：列表页 |
| `apps/main/src/views/AutoConfigEdit.vue` | **新建**：编辑页 |
| `packages/core/src/components/crawler/PluginVarsForm.vue` | **新建**：从 CrawlerDialog 抽取 |
| `packages/core/src/components/crawler/HttpHeadersEditor.vue` | **新建**：从 CrawlerDialog 抽取 |
| `packages/core/src/components/scheduler/MissedRunsDialog.vue` | **新建**：漏跑弹窗 |
| `packages/core/src/components/scheduler/ScheduleForm.vue` | **新建**：定时设置表单 |
| `packages/core/src/components/scheduler/ScheduleSummary.vue` | **新建**：定时摘要显示 |
| `packages/core/src/components/scheduler/ScheduleProgressBar.vue` | **新建**：倒计时进度条组件 |
| `packages/core/src/composables/useScheduleProgress.ts` | **新建**：进度条计算 composable |
| `apps/main/src/components/CrawlerDialog.vue` | 修改：改为选择配置模式 |
| `packages/core/src/components/task/TaskDrawerContent.vue` | 修改：闹钟图标 + 点击跳转 |
| `apps/main/src/App.vue` | 修改：挂载 MissedRunsDialog |

### i18n

| 文件 | 变更类型 |
|------|----------|
| `packages/i18n/src/locales/{zh,en,zhtw,ja,ko}/autoConfig.json` | **新建**：×5 |
| `packages/i18n/src/locales/{zh,en,zhtw,ja,ko}/index.ts` | 修改：导入 autoConfig |
| `packages/i18n/src/locales/{zh,en,zhtw,ja,ko}/route.json` | 修改：新增路由标题 |

### 文档

| 文件 | 变更类型 |
|------|----------|
| `schema.prisma` | 修改：RunConfig + Task 新字段文档 |

---

## 建议执行顺序

```
Phase 1 (数据层)
    ↓
Phase 2 (调度引擎) ──→ Phase 6 (漏跑弹窗)
    ↓                         ↓
Phase 3 (Tab UI) ←──────────────┘
    ↓
Phase 4 (CrawlerDialog 改造)
    ↓
Phase 5 (任务抽屉改造)
    ↓
Phase 7 (i18n) — 可与 Phase 3-6 并行
    ↓
Phase 8 (集成验收)
```

> Phase 1 是所有阶段的基础；Phase 2 和 Phase 3 可部分并行（调度引擎与 UI 分属后端/前端）；Phase 7 的 i18n key 应在各 Phase UI 开发时同步填充，最后统一审校。
