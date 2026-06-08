# 桌面端应用自动更新（GitHub Release）— 根计划

> 仅桌面（Windows / macOS / Linux）。Android / iOS / Web 全程 **noop**（Web 因 GitHub 不发布对应包，根本不检查更新）。
> 更新源：GitHub Release（仓库 `kabegame/kabegame`）。版本比较**只比较 tag 字符串是否相同**，不做 semver 大小比较——tag 不同即视为"有更新"。
>
> **架构（自 Phase 4 起修订）**：**状态机 + 调度 + 下载全部归后端（Rust）权威**，前端只是「镜像」——启动时 `get_updater_state` 拉一次快照、之后靠 `updater-state-change` 等事件被动刷新，**与 `OrganizeService` 完全同构**。
> （Phase 2 曾把状态机放前端，但"下载途中刷新页面 → 纯前端状态全丢"暴露了硬伤，故 Phase 4 整体搬到后端。Phase 2/3 的前端实现被 Phase 4 取代/降级为镜像，详见各 Phase 文档。）
> **不缓存**：后端状态为进程内存态、不落盘，进程重启即回「最新版」——仍满足"启动一定从 latest 开始"。
>
> 每个 Phase 设计为可独立完成的提交单元：前一个 Phase 完成后分支应可编译、可运行、可暂停，再开下一个 Phase。
> 本文件是**根计划**，后续会细化拆分为 `desktop-auto-update-phaseN.md`。

---

## 设计概览（共享前置知识）

### 六个 phase（**后端权威内存态**，前端镜像；不持久化）— 对齐用户 FSM 图（2026-06-03）

```
  boot / 24h / 手动检查
        │ (锚点，进入即自动 check)
        ▼
   unchecked ───▶ checking ──success(no new)──▶ checked
   (瞬时)         (独占过程)                      (最新)
                    │ │└─────fail─────▶ 回到进入前的 resting phase
                    │ └─success(found new)──▶ updateAvailable ◀── 24h/手动 ──┐
                    │                              │  ▲  ▲                    │
                    │                       download│  │  │fail/cancel        │
                    │                              ▼  │  │                    │
                    │                          downloading ──success──▶ restartable
                    │                          (独占过程)                  │
                    └──── 24h/手动检查（任一 resting phase 都可触发）────────┘
```

- **`unchecked`（瞬时锚点）**：`boot`/24h/手动检查到达此点即**自动 `run_check`**，不驻留。前端几乎只看到 `checking` 及其结果。
- **`checking`（检查中·独占过程态）**：只有 **success / fail** 两个出口。`success` → `checked`（no new）或 `updateAvailable`（found new）；`fail` → **回到进入前的 resting phase**（状态不丢）。
- **`checked`（最新版）**：resting。侧栏「Kabegame」下方**不显示**按钮。
- **`updateAvailable`（有更新）**：resting。侧栏显示 **NEW** 按钮，点击打开「更新弹窗」。**下载失败/取消也回到这里**（失败时带 `lastDownloadError`）。
- **`downloading`（下载中·独占过程态）**：只有 **success / fail / cancel** 三个出口。`success` → `restartable`；`fail` → `updateAvailable` + `lastDownloadError`；`cancel` → `updateAvailable`（无 error）。
- **`restartable`（可重启更新）**：resting。侧栏按钮变 **「重启更新」**，点击弹「要重启更新吗？」。

> **独占 / 不可重入（用户 2026-06-03 强调）**：`checking` 与 `downloading` 互斥且不可重入——处于其一时，**拒绝**任何 `check` 或 `download`（既不重入、也不打断进行中的过程）。resting phase（可发起新过程的稳态）只有 `checked` / `updateAvailable` / `restartable`。

- **下载错误**：后端记 `lastDownloadError`（**下载开始时清空**），随快照广播 + 单发 `update-download-error` 事件；前端在下载弹窗展示 + `kameMessage` 播报。**取消不算错误**，不写 error。
- **状态不缓存**：后端进程内存态、不落盘；进程重启即回 `unchecked`→`checking`。**但 webview 刷新不丢状态**（重新 `get_updater_state` hydrate）。

### 状态机关键规则（含用户 2026-06-02 / 06-03 澄清）

1. **启动时**：**后端** spawn 任务 `run_check` 一次（不是前端调度）。`IS_WEB` / `IS_ANDROID` 目标根本不编译该后端模块。
2. **周期检查**：**后端** 每 24h 一次（tokio interval）。`checking` / `downloading` 期间**跳过本轮**（不重入、不打断）。前端**不再** `setInterval`。
3. **手动检查**：Settings 页「检查更新」按钮 → `invoke('check_for_updates')`；`busy`（checking/downloading）时后端 no-op 返回当前快照。
4. **Linux 特例（Phase 3 修正）**：Linux **也弹更新弹窗、也显示 changelog**，只是不能下载——弹窗主操作为「打开发布页」（`openUrl(htmlUrl)`），且无 `downloading`/`restartable`。
5. **restartable 下重检（按用户 2026-06-03 修正，覆盖 FSM 图该处画法）**：restartable 下 24h/手动检查照常运行（瞬时经 `checking`），`success` 后：
   - 远端 `latest.tag == downloadedTag`（已下载仍是最新）→ **保持 restartable**；
   - 远端 `latest.tag == 当前运行版本`（远端回退）→ **保持 restartable**（D4）；
   - 仅当出现 **比已下载更新** 的版本 → 降级 `updateAvailable` + 清 `downloadedTag`（弃旧临时包，TODO 清理）。
   - `fail` → 回 restartable。**不像 FSM 图那样无条件降级**。
   - 实现细节：进入 `checking` 时记 `pre_check_phase`；UI 靠 `canShowRestart`(含 `downloadedTag!=null`) 让「重启更新」按钮在瞬时 checking 中不闪走。

### 版本与平台/构建判定（后端权威）

- **当前版本**：后端 `env!("CARGO_PKG_VERSION")`（与前端 `APP_VERSION` 一致，但以后端为准）。
- **平台**：后端 `cfg!(target_os = "...")` → `windows` / `macos` / `linux`。
- **构建模式（standard / light）**：后端 Cargo feature（`#[cfg(feature = "light")]` ⇒ light，否则 standard）。前端另有 `IS_LIGHT_MODE` 仅用于 UI 兜底，**资产选择以后端为准**。
- **架构**：`cfg!(target_arch = "...")`（x86_64 → `x64`，aarch64 → `aarch64`），用于匹配 asset 名。

### GitHub Release 资产命名（来自 README，asset 匹配依据）

| OS | Standard | Light |
|----|----------|-------|
| Windows | `Kabegame-standard_<ver>_x64-setup.exe` | `Kabegame-light_<ver>_x64-setup.exe` |
| macOS | `Kabegame-standard_<ver>_aarch64.dmg` | `Kabegame-light_<ver>_aarch64.dmg` |
| Linux | `Kabegame-standard_<ver>_amd64.deb` | `Kabegame-light_<ver>_amd64.deb`（Linux 不走下载，仅跳转） |

- **匹配规则**：在目标 release 的 `assets[]` 中，选 name 同时包含「模式 token（`-standard_`/`-light_`）」与「平台 token（win: `-setup.exe`；mac: `.dmg` 且含 `aarch64`）」的资产。匹配不到 → 返回"该平台无可用包"，前端降级为「打开 GitHub 发布页」。

### GitHub API

- 列表：`GET https://api.github.com/repos/kabegame/kabegame/releases`（默认按时间倒序，最新在前）。
- 必带请求头：`User-Agent: kabegame-updater`、`Accept: application/vnd.github+json`。
- 取字段：`tag_name`、`name`、`body`(changelog markdown)、`html_url`、`published_at`、`assets[].name`、`assets[].browser_download_url`。
- **错过版本计算**：从列表头部（最新）向下，收集 `tag_name != 当前版本` 的 release，直到遇到当前版本 tag 为止（或列表结束）。**最多保留 5 个**（取最新的 5 个）。
- 不缓存、不依赖 `/releases/latest` 单独接口（列表头即 latest）。
- 网络失败：吞掉错误 + log，保持当前状态（手动检查时给 toast）。

### 模块布局（新建文件）

**后端**（仅 GUI app crate，CLI/core 不需要；状态/下载/安装/重启依赖 `AppHandle`）—— **状态机 + 调度 + 下载 + 安装全在这里**：
```
src-tauri/kabegame/src/updater/
  mod.rs        // 公开入口 + ReleaseInfo/UpdateCheckResult 数据结构
  github.rs     // 拉取 + 解析 releases，计算 missed releases（capped 5）
  asset.rs      // 按 平台 + 模式 + 架构 匹配 asset 名
  service.rs    // ★UpdaterService 全局单例：UpdaterState 状态机 + checking/downloading 全局态
                //   + lastDownloadError + 启动 spawn 首检&24h + emit_state 广播（仿 OrganizeService）
  download.rs   // 流式下载到临时目录，发 update-download-progress / update-download-error
  install.rs    // 平台安装：macos 替换 .app / windows 跑 setup.exe + 退出
src-tauri/kabegame/src/commands/updater.rs  // get_updater_state / check_for_updates / download_update / apply_update_and_restart
```
- 仅在 `#[cfg(all(not(feature = "web"), not(target_os = "android")))]` 下编译；命令在 `lib.rs` 的 `generate_handler!` 注册；`UpdaterService::init_global` 在 setup 早段。
- **不**进 kabegame-core（保持 core 与 GUI/安装逻辑解耦）。
- 事件（`GlobalEmitter::emit` → `DaemonEvent::Generic` → `app.emit`）：
  - `updater-state-change`：整份 `UpdaterState` 快照（phase/checking/error 变更时发）。
  - `update-download-progress`：`{ tag, downloadedBytes, totalBytes, percent }`（高频、节流、不带整快照）。
  - `update-download-error`：`{ message }`（前端 `kameMessage` 播报 + 弹窗展示）。

**前端（镜像，不含状态机）**：
```
apps/kabegame/src/stores/updater.ts          // Pinia 镜像：applyState(快照) / applyProgress / setDownloadError
apps/kabegame/src/services/updater.ts         // init(): get_updater_state hydrate + listen 三事件；checkNow()/downloadAndStage()；无调度
apps/kabegame/src/components/updater/
  UpdateButton.vue            // 侧栏 NEW / 重启更新 按钮（挂到 App.vue sidebar-header）
  UpdateDialog.vue            // 横向 tabs + marked changelog + GitHub 链接 + 下载/打开发布页 + 错误展示
  DownloadProgressDialog.vue  // el-progress 进度条弹窗（绑 store 进度）
```
- changelog 渲染：`@kabegame/core/utils/renderBasicMarkdown`（marked 非 GFM + DOMPurify 净化 = **不跑脚本**），anchor 点击走 `openUrl`。
- 所有弹窗用 `useModalBack`（桌面 noop，遵守 CLAUDE.md 约定）。
- 前端**启动只做一次** `get_updater_state` hydrate + 订阅事件（**与 organize 完全一致**），**不再 `setInterval`**。

---

## Phase 1 — 后端：GitHub release 查询接口

**独立产出**：后端可被前端调用，返回当前版本、平台/模式、错过版本列表（≤5）、该平台是否有可下载 asset。无任何前端 UI。

### 任务
1. 新建 `src-tauri/kabegame/src/updater/{mod.rs,github.rs,asset.rs}`，在 `lib.rs` 加 `mod updater;`（`#[cfg(desktop tauri 栈)]`）。
2. `mod.rs` 定义数据结构（serde camelCase）：
   - `ReleaseInfo { tag: String, name: String, body: String, htmlUrl: String, publishedAt: String, assetUrl: Option<String>, assetName: Option<String> }`
   - `UpdateCheckResult { currentVersion: String, platform: String, mode: String, hasUpdate: bool, downloadable: bool, releases: Vec<ReleaseInfo> }`
3. `github.rs`：`async fn fetch_releases() -> Result<Vec<RawRelease>, String>`（reqwest + UA 头），`fn compute_missed(current, raw) -> Vec<ReleaseInfo>`（截到当前 tag、capped 5、附 asset 匹配结果）。
4. `asset.rs`：`fn match_asset(assets, platform, mode, arch) -> Option<(name,url)>`。
5. `commands/updater.rs`：`#[tauri::command] async fn check_for_updates() -> Result<UpdateCheckResult, String>`，在 `generate_handler!` 注册。

### 验收
- `cargo check -p kabegame`（standard 与 light 两套 feature）通过。
- DevTools 手动 `invoke('check_for_updates')` 返回结构正确：旧版本 → `hasUpdate=true` 且 releases 非空；当前为最新 → `hasUpdate=false`。

---

## Phase 2 — 前端：更新服务 + 状态机 + 启动/24h 调度

> ⚠️ **本 Phase 自 Phase 4 起被取代**：前端状态机与 24h 调度搬到后端（见 [phase4](./desktop-auto-update-phase4.md)）。Phase 2 落地的 `applyCheckResult`/`startSchedule` 在 Phase 4 被 `applyState`(镜像) + 后端调度替换。以下为历史记录。

**独立产出**：前端有 `updater` store 与 service，启动与每 24h 自动调用 `check_for_updates`，正确切换 `latest`/`updateDetected`，但还没有任何可见按钮/弹窗。

### 任务
1. `stores/updater.ts`：state = `'latest' | 'updateDetected' | 'restartable'`、`releases: ReleaseInfo[]`、`downloadedTag: string | null`、`downloadProgress`、`checking: boolean`。actions：`applyCheckResult(result)`（按状态机规则切换，含 restartable 下的回退判定）、`setRestartable(tag)`、`reset()`。
2. `services/updater.ts`：`checkNow()`（调 invoke + 写 store，吞错）、`startSchedule()`（24h `setInterval`，所有状态都跑）、`stopSchedule()`。**平台门禁**：`IS_WEB || IS_ANDROID` → 全部 noop。
3. `App.vue onMounted`：桌面端 `await updaterService.checkNow(); updaterService.startSchedule();`（放在非阻塞位置，失败不影响启动）；`onUnmounted` 调 `stopSchedule`。
4. 实现状态机规则 §「状态机关键规则」全部分支（尤其 restartable 下 24h 检查的回退）。

### 验收
- 桌面：启动后 store 状态随后端结果切换；mock 一个旧 `currentVersion` → 进入 `updateDetected`。
- Web / Android：service 全 noop，无任何网络请求。

---

## Phase 3 — 前端：侧栏 NEW / 重启按钮 + 更新弹窗（tabs + marked）

> ⚠️ **修正**：Linux 改为**也弹弹窗显示 changelog**（仅主操作变「打开发布页」），不再"直接跳转"。详见 [phase3](./desktop-auto-update-phase3.md)。store 字段 `state` 自 Phase 4 改名 `phase`（引用处随之更新）。

**独立产出**：侧栏出现 NEW（updateDetected）/「重启更新」（restartable）按钮；点 NEW 打开横向 tabs 更新弹窗，marked 渲染各版本 changelog，每版本带 GitHub 链接与下载/打开发布页按钮。

### 任务
1. `components/updater/UpdateButton.vue`：根据 store.state 渲染 NEW（pulse 动画小徽标）或「重启更新」；挂到 `App.vue` 的 `.sidebar-title-section`（`<h1>Kabegame</h1>` 下方）。折叠侧栏时仅显示小圆点。
2. 点击行为：
   - `updateDetected` + 非 Linux → 打开 `UpdateDialog`。
   - `updateDetected` + Linux → `openUrl(KABEGAME_RELEASES_LATEST)`。
   - `restartable` → 弹「要重启更新吗？」确认框（Phase 6 接安装命令；Phase 3 先占位 confirm）。
3. `components/updater/UpdateDialog.vue`：
   - `el-tabs` 横向，每个 release 一个 tab（tab 名用 `tag`/`name`）。
   - 内容：marked + DOMPurify 渲染 `body`（复用 PluginDocRenderer 模式，不 GitHub flavored、不跑脚本）。
   - 每个 tab 顶部一个「在 GitHub 查看」链接（`htmlUrl`，`openUrl`）。
   - 底部「下载」按钮（Phase 4/5 接下载；Phase 3 先 disabled 或占位）。`downloadable=false` 时显示「打开发布页」替代。
   - `useModalBack(visible)`。
4. i18n key：`updater.new`、`updater.restartUpdate`、`updater.dialogTitle`、`updater.viewOnGithub`、`updater.download`、`updater.restartConfirm` 等（zh + en 起步）。

### 验收
- updateDetected：侧栏出现 NEW；点开弹窗见多 tab、changelog 正确渲染、GitHub 链接可跳转。
- Linux：点 NEW 直接打开发布页，无弹窗。
- restartable：按钮变「重启更新」。

---

## Phase 4 — 后端：状态归属后端 + 下载 + 进度/错误事件（**架构转向**）

> 详见 [desktop-auto-update-phase4.md](./desktop-auto-update-phase4.md)。

**独立产出**：`UpdaterService` 全局单例持有权威状态机（含 `checking`/`downloading` 全局态、`lastDownloadError`）；后端负责启动首检 + 24h 调度；`download_update` 流式下载到临时目录并发 `update-download-progress`，成功→restartable、失败→记错误+发 `update-download-error`；**下载中拒绝再检查**。前端 store/service 降级为镜像（`get_updater_state` hydrate + 监听三事件，删除前端调度），错误经 `kameMessage` 播报。

**核心验收**：下载途中**刷新页面**，重新 hydrate 仍为 downloading 且进度延续（验证状态后端化的意义）。

---

## Phase 5 — 前端：下载进度弹窗 + 错误展示 + 「准备好，要重启吗？」

**独立产出**：更新弹窗点「下载」→ `downloadAndStage` 触发后端下载 → 进度条弹窗（绑后端进度事件）→ 后端置 restartable 后前端镜像收到 `updater-state-change`，弹「新版本已就绪，是否重启？」；下载失败在弹窗内展示 `lastDownloadError`。

### 任务
1. `components/updater/DownloadProgressDialog.vue`：`el-progress` 绑 `store.downloadPercent`；进度来自后端 `update-download-progress`（service 已在 Phase 4 订阅并写入 store）；`useModalBack`。
2. `UpdateDialog`：把 Phase 3 的占位 `onDownload` 接到 `updaterService.downloadAndStage(release)`；展示 `store.lastDownloadError`（红色提示行）。
3. 进入 restartable（由后端事件驱动，**前端不再 setRestartable**）：watch `store.phase==='restartable'` → 关进度弹窗 + 弹「是否立即重启更新？」（确定走 Phase 6）。
4. 下载失败：进度弹窗显示错误 + 已有 `kameMessage` 播报（Phase 4）；phase 由后端回到 updateDetected。

### 验收
- 点下载 → 进度条走动 → 后端置 restartable → 前端弹"是否重启"、按钮变「重启更新」。
- 断网下载 → 进度弹窗红字错误 + 龟酱播报 + phase 回 updateDetected。

---

## Phase 6 — 后端：安装 + 重启（平台分流）

**独立产出**：restartable 下点「重启更新」确认后真正执行平台安装。

### 任务
1. `install.rs`：
   - **macOS（2026-06-03 简化）**：用系统 `open` 打开下载好的 dmg 镜像；打开成功即 `app.exit(0)`。用户在弹出的窗口里把 `.app` 拖入 Applications（标准 macOS 安装流程）。**不**自动挂载/替换 bundle/写退出脚本。
   - **Windows**：`std::process::Command` 启动下载好的 `setup.exe`（README 注明安装器支持原地升级），随后 `app.exit(0)` / `std::process::exit(0)`。
   - **Linux**：不实现（不应进入 restartable；防御性返回 `Err`）。
2. `commands/updater.rs`：`#[tauri::command] async fn apply_update_and_restart(app) -> Result<(), String>`，读 `UpdaterService` 内部记录的 `downloaded_path` + `downloadedTag`（Phase 4 存），按 `cfg!(target_os)` 分流，注册 handler。
3. 前端 `UpdateButton` 的「重启更新」确认框 → `invoke('apply_update_and_restart')`（替换 Phase 3 的占位 TODO）。

### 验收
- macOS：确认后系统打开 dmg 镜像、本进程退出；用户拖入 Applications 完成替换。
- Windows：确认后 setup.exe 启动、旧进程退出，安装完成后为新版本。
- Linux：命令返回错误且 UI 不会走到这里（无 restartable）。

---

## Phase 7 — Settings 页「检查更新」header 按钮（带转圈）

**独立产出**：Settings 右上角多一个「检查更新」header 按钮，点击手动触发一次检查，检查中转圈。

### 任务
1. `stores/header.ts` 加 `HeaderFeatureId.CheckUpdate`。
2. `headerFeatures.ts` 注册（icon：`Refresh`/`Upload`/自定义；label `header.checkUpdate`）。检查中态用自定义 comp 或在 Settings 处理 loading。
3. `views/Settings.vue`：`settingsShowIds` 在桌面（`!IS_WEB && !IS_ANDROID`）追加 `HeaderFeatureId.CheckUpdate`；`handleSettingsAction` 处理 → `updaterService.checkNow()`；转圈绑 `store.checking`（后端置位并广播，前端镜像）；完成 toast（"已是最新" / "发现新版本"）。**下载中按钮禁用/或后端 no-op**（下载中不可检查）。
4. i18n：`header.checkUpdate`、`updater.alreadyLatest`、`updater.foundUpdate`。

### 验收
- 桌面 Settings 右上角出现按钮；点击转圈（`store.checking` 来自后端）；结果 toast 正确。
- 下载中点击不打断下载。
- Web / Android：不显示该按钮。

---

## 待确认的设计决策（D-series）

- **D1（asset 匹配兜底）**：匹配不到当前平台/模式的 asset 时，更新弹窗「下载」降级为「打开 GitHub 发布页」。✅ 暂定如此。
- **D2（临时目录）**：下载落点用 `std::env::temp_dir()` 还是经 `tauri-plugin-pathes` 新增 `update_cache_dir()`？倾向后者以遵守路径约定（Phase 4 落地时定夺）。**待定**。
- **D7（状态归属，2026-06-03 定）**：状态机 + 调度 + 下载全归**后端**权威，前端镜像（启动 `get_updater_state` hydrate + 监听事件），仿 `OrganizeService`。动机：下载途中刷新页面纯前端状态会丢。✅ 自 Phase 4 生效。
- **D8（下载错误，2026-06-03 定）**：后端持 `lastDownloadError`，**下载开始时清空**；失败时随快照广播 + 单发 `update-download-error` 事件；前端在下载弹窗展示 + `kameMessage` 播报。✅。
- **D9（下载中不可检查，2026-06-03 定）**：`check_for_updates`（手动/24h/启动）在 `downloading` 或 `checking` 时 no-op，不打断下载。✅。
- **D10（独占/不可重入，2026-06-03 定）**：`checking` 与 `downloading` 互斥且不可重入；各自只有 success/fail 出口（download 另有 cancel）。phase 命名对齐 FSM 图：`unchecked`(瞬时)/`checking`/`checked`/`updateAvailable`/`downloading`/`restartable`。✅。
- **D11（下载可取消，2026-06-03 定）**：`download_update` 支持 `cancel_download`（AtomicBool 信号，仿 OrganizeService.cancel）；cancel → `updateAvailable`、无 error、删半成品。✅。
- **D3（macOS 覆盖正在运行的 .app）**：用"复制到临时 + 退出后脚本替换 + 重启"，还是要求用户手动拖拽？倾向前者自动化。**实现细节留 phase6 子文档**。
- **D4（restartable 下远端回退）**：远端 latest 回退成等于"当前运行版本"时，是保持 restartable（已下载新包仍有效）还是回 latest？**暂定保持 restartable**（见状态机规则 5）。
- **D5（清理临时包）**：restartable 作废 / 安装成功后是否清理临时文件？留 TODO，倾向安装成功后清理、作废时下次启动清理。
- **D6（marked 配置）**：确认用项目现有 `marked` 默认（非 GFM）+ DOMPurify；不引入 `marked-gfm-heading-id` 等扩展。✅。

---

## 文件改动清单（按 Phase 汇总，供 Code Review 用）

- **新增（后端）**：
  - `src-tauri/kabegame/src/updater/{mod,github,asset}.rs`（P1）、`service.rs`（P4）、`download.rs`（P4）、`install.rs`（P6）
  - `src-tauri/kabegame/src/commands/updater.rs`（P1 `check_for_updates`；P4 `get_updater_state`/重写 `check_for_updates`/`download_update`；P6 `apply_update_and_restart`）
- **新增（前端）**：
  - `apps/kabegame/src/stores/updater.ts`（P2 创建；**P4 改镜像**）
  - `apps/kabegame/src/services/updater.ts`（P2 创建；**P4 改 hydrate+监听、删调度**）
  - `apps/kabegame/src/components/updater/{UpdateButton,UpdateDialog}.vue`（P3）、`DownloadProgressDialog.vue`（P5）
  - `packages/core/src/utils/renderMarkdown.ts`（P3）
  - i18n `updater` 命名空间 ×5 locale（P3）
- **修改**：
  - `src-tauri/kabegame/src/lib.rs`（P1 `mod updater;`+handler；**P4 `UpdaterService::init_global` + 启动 spawn 首检&24h + 新命令**；P6 安装命令）
  - `apps/kabegame/src/App.vue`（P2 启动调度；P3 挂 UpdateButton；**P4 改 `init()`/`dispose()`**）
  - `packages/core/src/stores/header.ts`（P7 加 `CheckUpdate`）
  - `apps/kabegame/src/header/headerFeatures.ts`（P7 注册）
  - `apps/kabegame/src/views/Settings.vue`（P7 加 header 按钮 + handler）
  - i18n（P5/P7 增量 key）
  - 若采纳 D2：`src-tauri-plugins/tauri-plugin-pathes/`（新增更新缓存目录方法，P4）

---

## 维护提醒
- 流程落地后，按 `cocs/README.md` 维护规则，在 `cocs/` 下新增一篇 `updater/AUTO_UPDATE_FLOW.md` 并补索引条目（更新源、状态机、后端权威 + 前端镜像、平台安装差异、事件名 `updater-state-change` / `update-download-progress` / `update-download-error`）。
