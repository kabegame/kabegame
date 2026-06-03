# Phase 2 — 前端：更新服务 + 状态机 + 启动/24h 调度

> 根计划：[desktop-auto-update.md](./desktop-auto-update.md) ｜ 前置：[Phase 1](./desktop-auto-update-phase1.md)（后端 `check_for_updates` 已落地）
> 本 Phase 只做**前端状态层与调度**：store（状态机）+ service（invoke 封装 + 24h 调度）+ App.vue 启动接线。
> **不做**任何可见 UI（NEW 按钮 / 弹窗 / 进度条 / Settings 按钮都在后续 Phase）。
> 验收靠 DevTools 观察 store 状态，不写测试用例。

---

## 1. 职责划分（呼应"接口放后端、服务放前端"）

- **store `stores/updater.ts`**：纯状态 + 状态机迁移逻辑（`applyCheckResult` / `setRestartable` / `reset`）。不发网络请求。
- **service `services/updater.ts`**：编排——平台门禁、调 `invoke('check_for_updates')`、写 store、24h 定时调度。
- **App.vue**：启动时触发首检 + 启动调度；卸载时停调度。

## 2. 类型（与后端 serde camelCase 对齐）

定义在 `stores/updater.ts` 顶部并导出（前端唯一真源，对应 Phase 1 的 `ReleaseInfo` / `UpdateCheckResult`）：

```ts
export interface ReleaseInfo {
  tag: string;            // 带 v 前缀，如 v4.1.1
  name: string;
  body: string;           // changelog markdown 原文（Phase 3 用 marked 渲染）
  htmlUrl: string;
  publishedAt: string;
  assetUrl: string | null;
  assetName: string | null;
}

export interface UpdateCheckResult {
  currentVersion: string; // 无 v 前缀
  platform: string;       // windows | macos | linux
  mode: string;           // standard | light
  arch: string;
  hasUpdate: boolean;
  downloadable: boolean;
  releases: ReleaseInfo[];// 最新在前，≤5
}

export type UpdaterState = 'latest' | 'updateDetected' | 'restartable';
```

## 3. store `stores/updater.ts`

### 状态（全部内存态，**不持久化**——刷新/重启即回 `latest`）
```ts
state: UpdaterState         // 默认 'latest'
releases: ReleaseInfo[]     // 当前展示的错过版本
currentVersion: string      // 最近一次检查回填
platform / mode / arch: string
downloadable: boolean       // 最新版是否有当前平台 asset
downloadedTag: string | null// restartable 下"已下载的那一版"tag（带 v）
checking: boolean           // 检查进行中（Settings 转圈用）
lastCheckedAt: number | null// 仅 UI 提示，不持久化
// downloadProgress: 留给 Phase 5，本期不加
```

### computed
- `hasUpdate` = `state !== 'latest'`
- `latestRelease` = `releases[0] ?? null`
- `isRestartable` = `state === 'restartable'`

### actions

**`applyCheckResult(result)`** —— 状态机核心（实现根计划 §"状态机关键规则"）：
```ts
function applyCheckResult(result: UpdateCheckResult) {
  // 回填环境信息（每次都更新）
  currentVersion = result.currentVersion;
  platform = result.platform; mode = result.mode; arch = result.arch;
  downloadable = result.downloadable;
  lastCheckedAt = Date.now();

  const norm = (t: string) => (t.startsWith('v') ? t.slice(1) : t);

  if (state === 'restartable') {
    // restartable 下 24h 检查照常运行；判断已下载包是否仍是远端最新
    const remoteLatest = result.hasUpdate ? norm(result.releases[0].tag) : norm(currentVersion);
    const downloaded = downloadedTag ? norm(downloadedTag) : '';
    if (remoteLatest === downloaded) {
      // 已下载的仍是最新 → 保持 restartable，仅刷新列表展示
      releases = result.releases;
      return;
    }
    if (remoteLatest === norm(currentVersion)) {
      // 远端回退到=当前运行版本（D4）→ 已下载的新包仍有效，保持 restartable
      return;
    }
    // 出现了比"已下载"更新的版本 → 已下载临时包作废，回到 updateDetected
    // TODO(Phase 4/5): 通知后端清理旧临时文件
    state = 'updateDetected';
    releases = result.releases;
    downloadedTag = null;
    return;
  }

  // latest / updateDetected
  if (result.hasUpdate) {
    state = 'updateDetected';
    releases = result.releases;
  } else {
    state = 'latest';
    releases = [];
  }
}
```

**`setRestartable(tag)`**（Phase 5 下载完成后调用）：`state='restartable'; downloadedTag = tag;`
**`reset()`**：`state='latest'; releases=[]; downloadedTag=null;`（兜底/调试）
**`setChecking(v)`**：`checking = v;`

> 写法：沿用仓库 setup-store 风格（`defineStore('updater', () => { ... return {...} })`，`ref` + `computed`，见 `stores/failedImages.ts`）。

## 4. service `services/updater.ts`

```ts
import { invoke } from "@/api/rpc";
import { IS_WEB, IS_ANDROID } from "@kabegame/core/env";
import { useUpdaterStore, type UpdateCheckResult } from "@/stores/updater";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
let timer: ReturnType<typeof setInterval> | null = null;

/** 桌面以外（web / android）全程 noop：后端命令在这些目标根本未注册。 */
function disabled(): boolean { return IS_WEB || IS_ANDROID; }

/** 触发一次检查；吞错（手动检查的 toast 由调用方 Phase 7 处理）。返回是否成功。 */
export async function checkNow(): Promise<boolean> {
  if (disabled()) return false;
  const store = useUpdaterStore();
  store.setChecking(true);
  try {
    const result = await invoke<UpdateCheckResult>("check_for_updates");
    store.applyCheckResult(result);
    return true;
  } catch (e) {
    console.warn("[updater] check_for_updates failed:", e);
    return false;
  } finally {
    store.setChecking(false);
  }
}

/** 启动 24h 周期检查（所有状态都跑，包括 restartable）。幂等。 */
export function startSchedule(): void {
  if (disabled() || timer) return;
  timer = setInterval(() => { void checkNow(); }, CHECK_INTERVAL_MS);
}

export function stopSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
```

- **restartable 下不停**：调度无条件跑，`applyCheckResult` 内部处理 restartable 的回退判定，service 无需特判。
- **不做休眠补偿**：24h `setInterval` 足够（spec 未要求 sleep-aware）；如未来要精确，可参考 `useMissedRunsWatch`，本期不引入。

## 5. App.vue 接线

`onMounted` 内（`settingsStore.ensureLoaded()` 之后、不阻塞主流程；service 已自带平台门禁，无需在此再判 IS_WEB）：
```ts
import * as updaterService from "@/services/updater";
// ...
void updaterService.checkNow();      // 首检：失败不影响启动
updaterService.startSchedule();      // 启动 24h 调度
```
`onUnmounted`：
```ts
updaterService.stopSchedule();
```

> 放在 `emit('app-ready')` 之前或之后均可；建议靠后，避免与首屏加载抢网络。

## 6. 验收（DevTools 观察）

1. **桌面（dev 版本通常旧于 GitHub latest）**：启动后
   ```js
   const s = window.__PINIA__ ? null : null; // 用 Vue Devtools 或：
   // 在组件内 useUpdaterStore() 取 state
   ```
   预期 `state==='updateDetected'`、`releases` 最新在前且 ≤5、macOS/Windows 下 `downloadable===true`。
2. **当前即最新**：手动把 store.currentVersion 与 release 对齐场景 → `state==='latest'`、`releases===[]`。
3. **restartable 回退逻辑**：DevTools 里
   ```js
   const u = useUpdaterStore();
   u.setRestartable('v4.1.0');
   u.applyCheckResult({ ...mock, hasUpdate:true, releases:[{tag:'v4.1.1',...}] });
   // 期望 state 回到 'updateDetected'，downloadedTag=null
   u.setRestartable('v4.1.1');
   u.applyCheckResult({ ...mock, hasUpdate:true, releases:[{tag:'v4.1.1',...}] });
   // 期望 保持 'restartable'
   ```
4. **Web / Android**：Network 面板无 `check_for_updates`；`checkNow()` 立即返回 false。

## 7. 文件改动清单

- **新增**：
  - `apps/kabegame/src/stores/updater.ts`（类型 + 状态机）
  - `apps/kabegame/src/services/updater.ts`（invoke 封装 + 24h 调度）
- **修改**：
  - `apps/kabegame/src/App.vue`（onMounted 首检 + startSchedule；onUnmounted stopSchedule）

## 8. 验证命令

- `bun check -c kabegame --skip cargo`（vue-tsc 类型检查通过）。
- 不需要 cargo（Phase 1 已完成后端）。

## 9. 注意 / 风险

- **dev 模式会显示"更新"**：dev 的 `CARGO_PKG_VERSION` 若旧于 GitHub latest，启动即 updateDetected——属预期，Phase 3 UI 上线后才可见。
- **store 单例**：service 内 `useUpdaterStore()` 必须在 Pinia 已 install 后调用（App.vue onMounted 阶段已满足）。
- **状态不缓存**：不写 localStorage / setting，保证"启动一定 latest"。
- **类型同源**：若后端 `UpdateCheckResult` 字段调整，需同步本文件 §2 类型（暂手工保持一致）。
</content>
