# Phase 4 — 后端：状态归属后端 + 下载到临时目录 + 进度/错误事件

> 根计划：[desktop-auto-update.md](./desktop-auto-update.md) ｜ 前置：[P1](./desktop-auto-update-phase1.md) [P2](./desktop-auto-update-phase2.md) [P3](./desktop-auto-update-phase3.md)
> 本 Phase 起**架构转向**：更新状态机从前端搬到**后端权威**，前端退化为「镜像」——启动时请求一次快照、之后靠事件被动刷新，**与 `OrganizeService` 完全同构**。

## 0. 为什么转向后端（动机）

Phase 2 把状态机放前端，暴露一个硬伤：**下载途中用户刷新页面 → 纯前端状态全丢**（下载进度、downloading 状态、最近错误都没了）。下载是长流程，必须存在进程级、跨 webview 刷新存活的地方 → **后端**。

参照 [`OrganizeService`](../../src-tauri/kabegame-core/src/storage/organize.rs)：
- 全局单例（`OnceLock<Arc<…>>`）持有 `Mutex<RunState>`；
- `get_organize_run_state` 命令给前端启动期 hydrate；
- 进度/完成走 `GlobalEmitter` 事件，前端 `listen` 被动更新；
- **状态不持久化**：进程重启即默认空态（符合"启动一定 latest"）。

## 1. 本 Phase 范围

- ✅ 后端 `UpdaterService` 全局单例：**状态机（从前端迁移）+ checking/downloading 全局共享 + 最近下载错误**。
- ✅ `download_update`：流式下载到临时目录（不校验 checksum/签名），发进度事件；成功→restartable，失败→记错误+发错误事件。
- ✅ **下载中不可检查更新**（`check_for_updates` 在 downloading 阶段 no-op）。
- ✅ 后端**启动期首检 + 24h 周期检查**（调度也搬到后端；下载中跳过）。
- ✅ 三个事件：`updater-state-change` / `update-download-progress` / `update-download-error`。
- ✅ 前端重构：store 变镜像、service 变 hydrate+监听、**删除前端 24h 调度**、错误走 `kameMessage`。
- ⏳ **下载进度弹窗 UI / 「准备好，重启吗」/ 在弹窗内展示错误** → Phase 5。
- ⏳ 安装/重启 → Phase 6。

## 2. 后端 `UpdaterService`（`src-tauri/kabegame/src/updater/`）

> 仍放 GUI crate（下载/安装依赖 AppHandle、临时目录、重启），不进 core。

### 2.1 状态快照（serde camelCase，对前端暴露）

> 命名对齐用户 FSM 图（2026-06-03）：`unchecked`（瞬时锚点）/ `checking` / `checked`（=旧 latest）/ `updateAvailable`（=旧 updateDetected）/ `downloading` / `restartable`。
> **`checking` 与 `downloading` 是「独占、不可重入」的过程态**：各自只有 `success` / `fail` 两个出口（`downloading` 另可 `cancel`）；处于这两态时**拒绝**再发起 check 或 download（见 §3 守卫）。

```rust
#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum UpdaterPhase {
    Unchecked,        // 瞬时锚点：进入即自动 run_check，不驻留
    Checking,         // 独占过程态：出口 success/fail
    Checked,          // 已检查、无新版（resting）
    UpdateAvailable,  // 有新版（resting；下载失败也回到这里 + lastDownloadError）
    Downloading,      // 独占过程态：出口 success/fail/cancel
    Restartable,      // 已就绪（resting）
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    pub phase: UpdaterPhase,       // checking 即"正在检查"；不再单独用 bool
    pub current_version: String,
    pub platform: String,
    pub mode: String,
    pub arch: String,
    pub downloadable: bool,
    pub releases: Vec<ReleaseInfo>,
    pub downloaded_tag: Option<String>,   // restartable：已下载那一版（带 v）
    pub download_tag: Option<String>,     // downloading：正在下的那一版
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub last_download_error: Option<String>, // 最近一次下载错误（刷新后仍在）
}
```

### 2.2 内部结构（不全序列化）
```rust
pub struct UpdaterService {
    state: Mutex<UpdaterState>,
    downloaded_path: Mutex<Option<PathBuf>>, // 供 Phase 6 安装读取，不暴露前端
    pre_check_phase: Mutex<UpdaterPhase>,     // 进入 checking 前的 resting phase，供 fail 回退 / restartable 保留
    download_cancel: Mutex<Option<Arc<AtomicBool>>>, // downloading 的 cancel 信号（仿 OrganizeService.cancel_flag）
}
static GLOBAL: OnceLock<Arc<UpdaterService>> = OnceLock::new();
// init_global / global()，与 OrganizeService 同构
```

### 2.3 独占性与不可重入（核心约束，用户 2026-06-03）
- **`checking` / `downloading` 互斥且不可重入**：当 `phase ∈ {Checking, Downloading}` 时，`run_check` 与 `download_update` 一律**早退**（no-op / Err），不打断进行中的过程。
- 两个过程态各自**只有固定出口**：
  - `Checking` → **success** 或 **fail**（无其它出口）。
  - `Downloading` → **success** 或 **fail** 或 **cancel**（用户允许加 cancel）。
- resting phase（可发起新过程的稳态）只有：`Checked` / `UpdateAvailable` / `Restartable`（`Unchecked` 是瞬时锚点，进入即转 `Checking`）。

### 2.4 `run_check`（替代旧 `apply_check`；checking 过程态）
```
run_check(self):
  # 守卫：独占、不可重入
  if phase in {Checking, Downloading}: return            # 下载/检查中不重入
  pre_check_phase = phase                                  # 记住 resting phase
  phase = Checking; emit_state()                          # 进入过程态
  match fetch + compute_missed (P1 逻辑):
    Err(_) =>                                             # ── fail 出口 ──
       phase = pre_check_phase; emit_state()              # 回退到原 resting，状态不丢
       # 检查错误：吞掉+log；手动检查由命令返回值/toast 体现（不写 lastDownloadError）
    Ok(result) =>                                         # ── success 出口 ──
       回填 current/platform/mode/arch/downloadable/releases
       if pre_check_phase == Restartable:                # restartable 保留逻辑（D4/规则5，按用户修正）
         remoteLatest = result.hasUpdate ? norm(releases[0].tag) : norm(current)
         if remoteLatest == norm(downloadedTag): phase = Restartable          # 已下载仍是最新 → 保留
         elif remoteLatest == norm(current):     phase = Restartable          # 远端回退=运行版本(D4) → 保留
         else: phase = UpdateAvailable; downloadedTag = None                  # 出现更新版本 → 降级 + 弃旧临时包(TODO 清理)
       else:
         phase = result.hasUpdate ? UpdateAvailable : Checked
       emit_state()
```
`norm` 复用 [P1](./desktop-auto-update-phase1.md) 的 `norm_tag`（剥 `v`）。

### 2.5 广播
```rust
fn emit_state(&self) {
    let snap = self.state.lock().unwrap().clone();
    GlobalEmitter::global().emit("updater-state-change", serde_json::to_value(&snap).unwrap());
}
```
（`GlobalEmitter::emit` → `DaemonEvent::Generic` → `app.emit("updater-state-change", …)`，见 [startup.rs:348](../../src-tauri/kabegame/src/startup.rs)。）

## 3. 命令（`commands/updater.rs`）

| 命令 | 行为 |
|---|---|
| `get_updater_state() -> UpdaterState` | 返回当前快照（前端启动 hydrate，**与 `get_organize_run_state` 对位**）。 |
| `check_for_updates() -> UpdaterState` | **守卫**：`phase ∈ {Checking, Downloading}` → 直接返回当前快照（不重入、不打断）。否则 `run_check()`（§2.4）→ 返回快照。 |
| `download_update(tag, assetUrl, assetName) -> ()` | **守卫**：仅当 `phase == UpdateAvailable` 才允许；`phase ∈ {Checking, Downloading}` → `Err("busy")`。见 §4。 |
| `cancel_download() -> bool` | 仅 `phase == Downloading` 有效：置 cancel 信号；下载循环检测到后走 cancel 出口回 `UpdateAvailable`。返回是否真的取消了。 |

> `check_for_updates` 返回类型由 P1 的 `UpdateCheckResult` 改为 `UpdaterState`（手动检查 Phase 7 可读返回 + toast）。
> 三个命令共同保证：**checking / downloading 期间不可发起 check 或 download**（独占、不可重入）。

## 4. `download_update`（`updater/download.rs`）

```
download_update(app, tag, asset_url, asset_name):
  1. 守卫（独占、不可重入）：
       phase != UpdateAvailable → Err("busy")     # 只能从 UpdateAvailable 进入；Checking/Downloading 一律拒绝
  2. 进入下载态（原子）：
       last_download_error = None                  # 下载开始时清错误
       cancel = Arc::new(AtomicBool::new(false)); download_cancel = Some(cancel.clone())
       phase = Downloading; download_tag = Some(tag)
       downloaded_bytes = 0; total_bytes = None
       emit_state()                                # 广播 downloading
  3. 临时落点：见决策 D2（倾向 tauri-plugin-pathes 新增 update_cache_dir()；
     回退 std::env::temp_dir()）。文件名用 asset_name。
  4. reqwest stream（复用 P1 client + 代理）：
       每 chunk 先检查 cancel.load() == true → 走 cancel 出口（见 7）
       逐 chunk 累加 downloaded_bytes，记录 total_bytes(Content-Length)
       throttle（每 ~200ms 或每 N chunk）emit("update-download-progress",
         { tag, downloadedBytes, totalBytes, percent })
       # 进度事件轻量、高频，不带整快照
  5. success 出口：
       downloaded_path = Some(path); downloaded_tag = Some(tag)
       phase = Restartable; download_tag = None; download_cancel = None
       emit_state()
  6. fail 出口（网络/IO）：
       清理半成品文件
       last_download_error = Some(msg)
       phase = UpdateAvailable; download_tag = None; download_cancel = None
       emit_state()
       emit("update-download-error", { message: msg })   # 触发 kameMessage
       Err(msg)
  7. cancel 出口（cancel 信号置位）：
       清理半成品文件
       phase = UpdateAvailable; download_tag = None; download_cancel = None
       last_download_error = None                  # 取消不是错误，不写 error
       emit_state()
       Ok(())
```
- **三出口**：success → Restartable；fail → UpdateAvailable + error；cancel → UpdateAvailable（无 error）。下载途中**不接受**任何 check / 重复 download。
- **不校验 checksum/签名**（符合根计划当前版本）。

## 5. 后端启动调度（搬离前端）

`lib.rs` setup 内 `tauri::async_runtime::spawn`（不阻塞启动；仅桌面非 android）：
```rust
spawn(async {
    // 首检
    UpdaterService::global().run_check().await;       // = check_for_updates 的内部实现
    // 24h 周期
    let mut tick = interval(Duration::from_secs(24*3600));
    loop {
        tick.tick().await;
        UpdaterService::global().run_check().await;   // run_check 内部自带 downloading/checking 守卫
    }
});
```
- 前端**不再**调度（删 Phase 2 的 `startSchedule`/`stopSchedule`/`setInterval`）。
- `run_check` 内置守卫：`phase ∈ {Checking, Downloading}` 直接 return（不重入、不打断下载）。

## 6. 前端重构（store/service 变镜像）

### 6.1 `stores/updater.ts`（改为镜像）
- 字段对齐后端快照：`phase`（`'unchecked'|'checking'|'checked'|'updateAvailable'|'downloading'|'restartable'`，**替代旧 `state`**，并废弃旧 `checking: bool`）、`releases`、`downloadable`、`downloadedTag`、`downloadTag`、`downloadedBytes`、`totalBytes`、`lastDownloadError`、`currentVersion` 等。
- **删除** `applyCheckResult` 的状态机逻辑（迁到后端）。新增：
  - `applyState(snap: UpdaterState)`：整体替换镜像（hydrate / `updater-state-change` 都走它）。
  - `applyProgress({tag, downloadedBytes, totalBytes})`：仅更新进度三字段（高频事件，不替换整快照）。
  - `setDownloadError(msg)` / 由 `applyState` 同步（错误已在快照里）。
- computed：
  - `hasUpdate = phase === 'updateAvailable'`
  - `isChecking = phase === 'checking'`、`isDownloading = phase === 'downloading'`
  - **`canShowRestart = phase === 'restartable' || downloadedTag != null`**（restartable 期间若被瞬时 `checking` 覆盖，靠 downloadedTag 让「重启更新」按钮不闪走）
  - `downloadPercent`
  - `busy = phase === 'checking' || phase === 'downloading'`（UI 禁用「检查更新」/「下载」入口）
- **Phase 3 改名同步**：`UpdateButton`/`UpdateDialog` 里旧 `store.state==='updateDetected'`→`store.hasUpdate`、`'restartable'`→`store.canShowRestart`、`'latest'` 不再用。
- `UpdaterState`/`ReleaseInfo` TS 类型同步新 `phase` 枚举 + 进度/错误字段。

### 6.2 `services/updater.ts`（改为 hydrate + 监听）
```ts
export async function init() {                 // App.vue onMounted 调一次（桌面）
  if (disabled()) return;
  const store = useUpdaterStore();
  // 1) 启动 hydrate（与 organize 一致）
  try { store.applyState(await invoke("get_updater_state")); } catch {}
  // 2) 订阅事件
  unlistenState = await listen("updater-state-change", e => store.applyState(e.payload));
  unlistenProgress = await listen("update-download-progress", e => store.applyProgress(e.payload));
  unlistenError = await listen("update-download-error", e => {
    const msg = (e.payload as any)?.message ?? "";
    store.setDownloadError(msg);
    kameMessage.error(msg);                    // 龟酱播报错误
  });
}
export function dispose() { unlistenState?.(); unlistenProgress?.(); unlistenError?.(); }

export async function checkNow(): Promise<boolean> { /* 手动触发：invoke('check_for_updates'); 镜像由事件/返回值刷新；busy 时后端 no-op */ }
export async function downloadAndStage(r: ReleaseInfo) { await invoke("download_update", { tag: r.tag, assetUrl: r.assetUrl, assetName: r.assetName }); }
export async function cancelDownload() { await invoke("cancel_download"); }
```
- **删除** `startSchedule`/`stopSchedule`（调度在后端）。
- `checkNow` 仅供 Settings 手动按钮（Phase 7）；启动首检由后端负责。
- UI 入口在 `store.busy` 时禁用「检查更新」「下载」（前端兜底；后端守卫为最终防线）。

### 6.3 `App.vue`
- `onMounted`：把 Phase 2 的 `checkNow()+startSchedule()` 替换为 `updaterService.init()`。
- `onUnmounted`：`updaterService.dispose()`（替代 `stopSchedule`）。

### 6.4 kameMessage
- 仅在 `update-download-error` 事件回调里 `kameMessage.error(msg)`（一次性播报）；弹窗内展示 `store.lastDownloadError` 留 Phase 5。

## 7. 验收

1. **状态后端化**：DevTools `invoke('get_updater_state')` 返回完整快照；旧版本后端首检 → `phase==='updateAvailable'`；当前为最新 → `phase==='checked'`。
2. **刷新存活**：`invoke('download_update', …)` 进入 downloading 后**刷新页面** → 重新 hydrate 仍是 downloading + 进度延续（核心验收点）。
3. **不可重入（核心约束）**：
   - downloading 期间 `invoke('check_for_updates')` → 返回快照 phase 仍 downloading，未打断；
   - downloading 期间再 `invoke('download_update')` → `Err("busy")`，未起第二次下载；
   - checking 期间 `invoke('download_update')` / 再 `check_for_updates` → 均被拒/no-op。
4. **下载三出口**：
   - success → `restartable`；
   - fail（断网）→ `updateAvailable` + `lastDownloadError` + `update-download-error` 事件 + `kameMessage`；再次下载开始时 error 被清空；
   - `invoke('cancel_download')` 进行中 → 回 `updateAvailable`、无 error、半成品文件已清理。
5. **进度事件**：`update-download-progress` 持续到达，bytes 递增。
6. **restartable 保留**：restartable 下手动 `check_for_updates`，若远端 latest == 已下载 tag → 仍 `restartable`（**不**降级）；构造更新版本 → 降级 `updateAvailable`。
7. **24h 调度在后端**：前端无 `setInterval`；杀掉前端 webview 不影响后端定时。

## 8. 文件改动清单

- **新增**：
  - `src-tauri/kabegame/src/updater/service.rs`（UpdaterService 单例 + 状态机 + emit_state）
  - `src-tauri/kabegame/src/updater/download.rs`（download_update）
  - （D2 若采纳）`tauri-plugin-pathes` 新增 `update_cache_dir()`
- **修改**：
  - `src-tauri/kabegame/src/updater/mod.rs`（导出 service/download；`check_updates` 改为喂给 service）
  - `src-tauri/kabegame/src/commands/updater.rs`（`get_updater_state` / `check_for_updates` 改签名 / `download_update` / `cancel_download`）
  - `src-tauri/kabegame/src/lib.rs`（注册新命令 + 启动 spawn 首检&24h；init UpdaterService 全局单例）
  - `apps/kabegame/src/stores/updater.ts`（改镜像）
  - `apps/kabegame/src/services/updater.ts`（改 hydrate+监听，删调度）
  - `apps/kabegame/src/App.vue`（init/dispose 替换）
  - `apps/kabegame/src/components/updater/UpdateDialog.vue`（`onDownload` 接 `downloadAndStage`——可留 Phase 5，本期至少不破坏）

## 9. 注意 / 风险

- **单例初始化时机**：`UpdaterService::init_global` 必须在启动 spawn 与首个命令之前（lib.rs setup 早段），与 OrganizeService 一致。
- **事件风暴**：进度走独立轻量事件、节流；`updater-state-change` 仅在 phase/error 变化时发，不随每 chunk 发。
- **Generic 事件类型**：用 `GlobalEmitter::emit(name, payload)` 即可，无需新增 `DaemonEvent` 变体。
- **Phase 2/3 既有代码**：Phase 2 的前端状态机 + 调度被本期取代；Phase 3 的 store 字段 `state`（`latest/updateDetected/restartable`）→ `phase`（新 6 态枚举）需同步改，`UpdateButton`/`UpdateDialog` 引用处一并更新（见 §6.1 改名映射）。
- **checking 瞬时覆盖 restartable**：restartable 下重检会瞬时进入 `checking`，靠 store `canShowRestart`（含 `downloadedTag != null`）保证「重启更新」按钮不闪走；`downloadedTag` 仅在"出现更新版本"降级时清空。
- **临时文件清理**：restartable 作废 / 失败 / cancel 残留留 TODO（决策 D5），不在本期强求（cancel/fail 出口已就地删半成品）。
- **unchecked 不驻留**：boot 时 `phase=Unchecked` 后立即 `run_check()` 转 `Checking`；前端几乎只会看到 checking 及其结果。
