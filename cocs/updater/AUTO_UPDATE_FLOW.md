# 桌面端应用自动更新（GitHub Release）

> 主题：桌面端（Windows / macOS / Linux）通过 GitHub Release 做应用自动更新的全链路。
> **状态机 + 调度 + 下载 + 安装全部归后端权威**，前端只是「镜像」（启动 hydrate 一次 + 事件被动刷新），与 `OrganizeService` 同构。
> Android / iOS / Web **不编译**该后端模块、前端服务全程 noop（Web 因 GitHub 不发布对应包）。
> 设计与分期落地详见 [.claude/plans/desktop-auto-update.md](../../.claude/plans/desktop-auto-update.md) 及 `desktop-auto-update-phase{1..4}.md`。

## 更新源与版本判定

- 列表：`GET https://api.github.com/repos/kabegame/kabegame/releases`（默认按时间倒序，最新在前）。必带 `User-Agent: kabegame-updater` 头（缺失 403）。
- **版本比较只比 tag 字符串是否相同**，不做 semver 大小比较——tag 不同即「有更新」。
- **`v` 前缀归一化**：GitHub tag 形如 `v4.1.1`，`CARGO_PKG_VERSION` 为 `4.1.1`；比较前两边都剥前导 `v`（`norm_tag`）。展示与下载 URL 仍用原始带 `v` 的 tag。
- **错过版本**：从最新向下收集 `tag != 当前版本` 的 release，遇当前版本即停，跳过 draft，**最多 5 个**。
- **平台 / 模式 / 架构（后端权威）**：`cfg!(target_os)`、Cargo feature（`light` ⇒ light 否则 standard）、`std::env::consts::ARCH`（x86_64→`x64`、aarch64→`aarch64`）。
- **asset 匹配**：name 同时含模式 token（`-standard_` / `-light_`）与平台 token（win `…x64-setup.exe`、mac `…aarch64.dmg`、linux `…amd64.deb`）。匹配不到则 `downloadable=false`，前端降级「打开发布页」。

## 状态机（6 phase，后端 `UpdaterPhase`）

```
boot/24h/手动 → unchecked(瞬时,自动 run_check) → checking ──success(no new)──▶ checked
                                                   │  └─success(found new)─▶ updateAvailable ◀─┐
                                                   └─fail─▶ 回到进入前的 resting phase           │
   updateAvailable ──download──▶ downloading ──success──▶ restartable                          │
                       ▲           │  └─fail──▶ updateAvailable(+lastDownloadError)             │
                       └──cancel───┘                                                            │
   任一 resting phase（checked/updateAvailable/restartable）── 24h/手动检查 ──────────────────────┘
```

- **`unchecked`**：瞬时锚点，进入即自动 `run_check`，不驻留。
- **`checking` / `downloading` 独占、不可重入**：处于其一时，任何 check / download 一律被拒（既不重入也不打断）。各自只有 **success / fail** 出口（download 另有 **cancel**）。resting phase 只有 `checked` / `updateAvailable` / `restartable`。
- **restartable 下重检保留**：24h/手动检查照常运行（瞬时经 checking）；若远端 latest == 已下载 tag 或 == 当前运行版本则**保持 restartable**，仅当出现**更新版本**才降级 `updateAvailable` 并弃旧临时包。
- **下载错误**：`lastDownloadError` 在下载**开始时清空**；失败时随快照广播 + 单发 `update-download-error` 事件，前端 `kameMessage` 播报。**取消不算错误**。
- **不缓存**：后端内存态、不落盘，进程重启回 `unchecked`；但 **webview 刷新不丢状态**（重新 `get_updater_state` hydrate，下载进度延续）。
- **Linux 特例**：弹更新弹窗、显示 changelog，但**不能下载**——主操作为「打开发布页」，无 `downloading`/`restartable`。

## 事件（`GlobalEmitter::emit` → `DaemonEvent::Generic` → `app.emit`）

| 事件名 | 载荷 | 说明 |
|---|---|---|
| `updater-state-change` | 完整 `UpdaterState` 快照 | phase/error 变更时发；前端 `applyState` 整体替换镜像 |
| `update-download-progress` | `{ tag, downloadedBytes, totalBytes, percent }` | 高频、节流（~200ms），不带整快照 |
| `update-download-error` | `{ message }` | 触发前端 `kameMessage.error` + 弹窗错误行 |

## 命令（`commands/updater.rs`）

| 命令 | 行为 |
|---|---|
| `get_updater_state` | 返回当前快照（前端启动 hydrate，对位 `get_organize_run_state`） |
| `check_for_updates` | `run_check()`；`checking`/`downloading` 期间 no-op，返回当前快照 |
| `download_update(tag, assetUrl, assetName)` | 仅可从 `updateAvailable` 进入；其它 phase → `Err("busy")` |
| `cancel_download` | 仅 `downloading` 有效；置 cancel 信号 |
| `apply_update_and_restart` | 读 `UpdaterService` 内部 `downloaded_path`，按平台安装并重启 |

## 下载 / 安装 / 重启平台差异

- **下载**：流式写入 `AppPaths.temp_dir/updates/<assetName>`，不校验 checksum / 签名。
- **macOS**：用系统 `open` 打开下载好的 dmg 镜像（用户在弹窗里把 `.app` 拖入 Applications）→ 打开成功即 `app.exit(0)`。**不**自动替换 bundle、不挂载脚本。
- **Windows**：直接运行下载好的 `setup.exe`（支持原地升级）→ `app.exit(0)`。
- **Linux**：不支持重启更新（`apply` 返回 `Err`），UI 也不会进入 restartable。

## 涉及文件

**后端（仅 `#[cfg(all(not(feature="web"), not(target_os="android")))]`）**
- [src-tauri/kabegame/src/updater/mod.rs](../../src-tauri/kabegame/src/updater/mod.rs)：模块入口 + `ReleaseInfo`/`UpdateCheckResult` + 平台/模式/架构/`norm_tag`/`check_updates`。
- [src-tauri/kabegame/src/updater/github.rs](../../src-tauri/kabegame/src/updater/github.rs)：`fetch_releases` + `compute_missed`（≤5、跳过 draft）。
- [src-tauri/kabegame/src/updater/asset.rs](../../src-tauri/kabegame/src/updater/asset.rs)：`match_asset`。
- [src-tauri/kabegame/src/updater/service.rs](../../src-tauri/kabegame/src/updater/service.rs)：`UpdaterService` 单例 + `UpdaterState`/`UpdaterPhase` + `run_check` + 下载生命周期 setter + `emit_state` + `spawn_schedule`（首检 + 24h）。
- [src-tauri/kabegame/src/updater/download.rs](../../src-tauri/kabegame/src/updater/download.rs)：流式下载 + 进度事件 + 取消 + 三出口。
- [src-tauri/kabegame/src/updater/install.rs](../../src-tauri/kabegame/src/updater/install.rs)：平台安装 + 重启。
- [src-tauri/kabegame/src/commands/updater.rs](../../src-tauri/kabegame/src/commands/updater.rs)：5 个 `#[tauri::command]`。
- [src-tauri/kabegame/src/lib.rs](../../src-tauri/kabegame/src/lib.rs)：`UpdaterService::init_global` + `spawn_schedule` + handler 注册。

**前端（镜像）**
- [apps/kabegame/src/stores/updater.ts](../../apps/kabegame/src/stores/updater.ts)：镜像 store（`applyState`/`applyProgress`/`setDownloadError` + computed）。
- [apps/kabegame/src/services/updater.ts](../../apps/kabegame/src/services/updater.ts)：`init()` hydrate + 监听三事件；`checkNow`/`downloadAndStage`/`cancelDownload`/`applyUpdateAndRestart`；无调度。
- [apps/kabegame/src/components/updater/UpdateButton.vue](../../apps/kabegame/src/components/updater/UpdateButton.vue)：侧栏 NEW / 重启更新 + 折叠小圆点。
- [apps/kabegame/src/components/updater/UpdateDialog.vue](../../apps/kabegame/src/components/updater/UpdateDialog.vue)：横向 tabs changelog（`renderBasicMarkdown` + DOMPurify）+ GitHub 链接 + 下载/打开发布页 + 错误行。
- [apps/kabegame/src/components/updater/DownloadProgressDialog.vue](../../apps/kabegame/src/components/updater/DownloadProgressDialog.vue)：进度条 + 取消 + 重启提示（刷新存活）。
- [apps/kabegame/src/header/comps/CheckUpdateControl.vue](../../apps/kabegame/src/header/comps/CheckUpdateControl.vue)：Settings 右上角「检查更新」header 按钮（转圈 + toast）。
- [packages/core/src/utils/renderMarkdown.ts](../../packages/core/src/utils/renderMarkdown.ts)：`renderBasicMarkdown`（非 GFM + 净化，不跑脚本）。
- 挂载点：[apps/kabegame/src/App.vue](../../apps/kabegame/src/App.vue)（侧栏 `UpdateButton`、全局唯一 `UpdateDialog`/`DownloadProgressDialog`、`updaterService.init/dispose`）。
- i18n：`packages/i18n/src/locales/<locale>/updater.json`（5 语言）。

## 适用场景

- 新增 / 调整更新流程、状态机、事件；排查「下载途中刷新丢状态」「下载中仍能触发检查」「restartable 被误降级」等问题。
- 调整 GitHub asset 命名匹配、平台安装方式；排查 macOS/Windows 安装重启失败、Linux 误进入下载路径。
- 排查 NEW / 重启按钮不出现、更新弹窗 changelog 渲染、检查更新按钮转圈与 toast。
</content>
