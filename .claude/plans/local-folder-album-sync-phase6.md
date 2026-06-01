# Phase 6 — 手动刷新触发 + 可见画册同步

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：[Phase 1](./local-folder-album-sync-phase1.md)（Album.type / syncFolder / folderStatus）、[Phase 2](./local-folder-album-sync-phase2.md)（sync_album）、[Phase 3](./local-folder-album-sync-phase3.md)（`sync_local_folder_album` / `sync_local_folder_albums` 命令 + per-album try_lock）、[Phase 4](./local-folder-album-sync-phase4.md)（创建弹窗）、[Phase 5](./local-folder-album-sync-phase5.md)（卡片视觉 + 只读守卫 + `localFolderAlbumIds` / `isLocalFolderAlbum` store getter）已实现并合并。
> 范围：把用户主动的"刷新"动作连到 sync 命令上；在画册右键 / 操作菜单加「立即同步」入口。
> 完成后：在 Finder 改动文件夹（增 / 删 / 改）后，回 Kabegame 下拉刷新或点列表页右键「立即同步」即可看到画册图片更新。

---

## 关键设计点

### 1. 触发位置（三处入口）

| 入口 | 行为 |
|---|---|
| `Albums.vue` 的 `handleRefresh`（页面下拉刷新 + Header 刷新按钮） | 在现有逻辑（loadAlbums / 清缓存 / 重拉预览）完成后，若有 local_folder 画册：**ElMessage.warning** 告知"文件夹内容将陆续同步..." → **await** `sync_local_folder_albums(ids)` → **ElMessage.success** "同步完成 +X/-Y/~Z"。无 local_folder 画册时维持原即时 success。 |
| `AlbumDetail.vue` 的 `handleRefresh`（详情页下拉刷新 + Header 刷新按钮） | 同上：收集当前 album（若 local_folder）+ 直接 local_folder 子画册的 id；非空时 warn → await batch sync → success。 |
| 右键 / Action 菜单的「立即同步」 | 仅当 `target.type === 'local_folder'` 时显示；点击 invoke `sync_local_folder_album(id)`，**await** 后用 ElMessage 给反馈（success / 跳过 / 警告 / 错误）。 |

### 2. 为什么改成 await + 双 toast（替代原 fire-and-forget 方案）

**用户决策**：刷新涉及本地文件夹画册时，给用户**明确的进度感**——先 warn 提示"内容将陆续同步"，sync 完成后再 success。理由：
- sync 含磁盘扫描 + 可能的 hash 计算，可达数秒；用户**需要知道**这段时间内还在做事，否则可能误以为"刷新没反应"。
- Phase 2 的 sync 内部走 `images-change` / `album-images-change` 事件，**陆续**驱动 UI 更新——warn 文案中的"陆续同步"准确描述这一过程。
- await 期间 spinner（isRefreshing）保持，与 toast 文案一致；用户主动结束 await（关闭页面）也安全——Phase 3 的 try_lock 让后到请求自然跳过，不会重复 sync。

**对比 Phase 3 try_lock 语义**：
- 同 album 短时间内多次点击刷新：第一次 warn → await(真正 sync)；用户点第二次 → warn → await（后端立刻返回 `skippedInFlight=true`）→ success "同步进行中（已跳过）"。不会排队也不会数据竞争。
- 不同 album / 不同页面入口：各自独立 await，互不阻塞。

**对比无 local_folder 画册场景**：
- 普通刷新路径不变：现有逻辑 → ElMessage.success("刷新成功")。
- 仅当 `ids.length > 0` 时进入 warn + await + success 三段式分支。

**统一原则**：所有 UI 入口都 await 并给 toast 反馈；不再有 fire-and-forget。

### 3. "可见画册" 的范围

用户原话：「对当前页面可见的本地文件夹画册发送命令做同步处理」。第一版采用**最简语义**：
- Albums.vue：`displayedAlbumRoots.value` 中 `type === 'local_folder'` 的全部 id（即根列表里所有本地文件夹画册，不依赖 IntersectionObserver 的真实视口）。
- AlbumDetail.vue：当前 album（若 local_folder）+ 子画册标签页显示的直接子画册（若任何子是 local_folder）。

不引入"viewport-visible"细粒度跟踪——既复杂又对用户感知差异小（启动期同步已覆盖全量；手动刷新只是补差）。

### 4. 跨平台 / Web 模式

- 非 macOS：Albums.vue / AlbumDetail.vue 的 sync trigger 用 `IS_MACOS` 守卫直接 skip——避免不必要的 Tauri invoke + 后端返回 `Err("local folder sync is macOS-only in this build")`。
- 右键菜单「立即同步」项的 visible 也用 `IS_MACOS && target.type === 'local_folder'` 双条件——在非 macOS 上即便有遗留 local_folder album 也不显示该选项。
- Phase 4 的弹窗复选框已经用 IS_MACOS 隐藏，所以非 mac 上**无法**新建 local_folder album。但旧库迁移 / 跨平台用户携带数据库的情况要兜底。

### 5. 错误处理

- **刷新批量 sync**（await 模式）：
  - 批量 RPC 内部不会 reject（Phase 3 已包成 `Vec<{ ok, err }>`）；前端聚合每条结果：
    - 全部 `ok.status.state === 'ok'` → ElMessage.success（合计计数 + 跳过的 album 数）。
    - 任一条 `err != null` → ElMessage.error（列出失败画册名 + 第一条错误，详情入 console）。
    - 部分 `ok.status.state !== 'ok'`（路径 missing / denied 等）→ ElMessage.warning 提示哪几个画册的路径有问题。
- **右键单次 sync**：
  - `skippedInFlight: true` → ElMessage.info "同步进行中…"。
  - `status.state !== 'ok'` → ElMessage.warning（路径相关提示）。
  - 异常 throw → ElMessage.error。
  - 正常完成 → ElMessage.success "已同步 +X/-Y/~Z"。
- **共通**：所有路径都吞 invoke 层面的 reject 不让 unhandled promise rejection 冒到控制台红字。

---

## 涉及文件清单

### 新增

- 无新文件。

### 修改

#### 前端

- [apps/kabegame/src/api/syncLocalFolder.ts](../../apps/kabegame/src/api/syncLocalFolder.ts) **新建**：薄包装 `syncLocalFolderAlbum(id)` / `syncLocalFolderAlbums(ids)` invoke，加 `SyncReport` 类型定义和 IS_MACOS 守卫，避免在 view 文件里重复处理类型。
- [apps/kabegame/src/views/Albums.vue](../../apps/kabegame/src/views/Albums.vue) — `handleRefresh` 末尾追加 sync trigger；`handleAlbumMenuCommand` 加 `"syncNow"` 分支。
- [apps/kabegame/src/views/AlbumDetail.vue](../../apps/kabegame/src/views/AlbumDetail.vue) — `handleRefresh` 末尾追加 sync trigger；`handleChildAlbumMenuCommand` 同样加 `"syncNow"` 分支。
- [apps/kabegame/src/actions/albumActions.ts](../../apps/kabegame/src/actions/albumActions.ts) — `AlbumActionContext` 加 `isLocalFolder: boolean`；新增 `"syncNow"` action 项。
- [packages/i18n/src/locales/{en,zh,ja,ko,zhtw}/albums.json](../../packages/i18n/src/locales/) — 新增 `contextMenu.syncNow` / `localFolder.syncNow*` 几个 key（en + zh 必加，其它复制 en 留 TODO）。

> 注：Phase 5 已在 `AlbumActionContext` 上**没有**加 `isLocalFolder`（标记为可选 / 不强制），Phase 6 把它**正式加上**——成为 syncNow visibility 的判定依据。

### 不修改

- 后端任何文件——Phase 3 的命令完整可用。
- AlbumCard / AddToAlbumDialog 等 Phase 5 已经处理过的视觉与排除逻辑。
- Phase 4 的创建弹窗。

---

## 步骤

### 1. 新建 `api/syncLocalFolder.ts`

```ts
// apps/kabegame/src/api/syncLocalFolder.ts
import { invoke } from "@/api/rpc";
import { IS_MACOS } from "@kabegame/core/env";

export type FolderStatusState =
  | "ok"
  | "missing"
  | "denied"
  | "not_a_dir"
  | "io_error";

export interface FolderStatusPayload {
  state: FolderStatusState;
  checkedAt: number;
  message?: string;
}

export interface SyncReport {
  albumId: string;
  status: FolderStatusPayload | null;
  added: number;
  deleted: number;
  reimported: number;
  skippedUnstable: number;
  skippedInFlight: boolean;
}

export interface BatchSyncItem {
  albumId: string;
  ok: SyncReport | null;
  err: string | null;
}

/**
 * 同步单个 local_folder album。
 * 非 macOS 直接返回 null（不会抛错，调用方按 null 跳过即可）。
 */
export async function syncLocalFolderAlbum(
  albumId: string,
): Promise<SyncReport | null> {
  if (!IS_MACOS) return null;
  try {
    return await invoke<SyncReport>("sync_local_folder_album", { albumId });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_album failed", albumId, e);
    throw e;
  }
}

/**
 * 批量同步多个 local_folder album。空数组直接返回 []，不发 invoke。
 * 非 macOS 直接返回 []。
 * 后端命令本身返回 `Vec<{ albumId, ok, err }>`，不会因单个 album 失败而 reject。
 * 唯一会 reject 的场景是 invoke 层（Tauri ACL / 通信故障）——此时降级为单条 err 数组。
 */
export async function syncLocalFolderAlbums(
  albumIds: string[],
): Promise<BatchSyncItem[]> {
  if (!IS_MACOS) return [];
  if (albumIds.length === 0) return [];
  try {
    return await invoke<BatchSyncItem[]>("sync_local_folder_albums", { albumIds });
  } catch (e) {
    console.warn("[local_folder] sync_local_folder_albums invoke failed", albumIds, e);
    const msg = typeof e === "string" ? e : (e as Error)?.message ?? String(e);
    return albumIds.map((id) => ({ albumId: id, ok: null, err: msg }));
  }
}
```

> **取舍**：单 album 调用抛错让调用方决定 UI 反馈；批量调用吞错降级为 `[]`——刷新场景里批量错误不该污染 spinner 收起后的"刷新成功"提示。

### 2. Albums.vue 改造

#### 2.1 import

```ts
import { syncLocalFolderAlbum, syncLocalFolderAlbums } from "@/api/syncLocalFolder";
import { IS_MACOS } from "@kabegame/core/env";
import type { BatchSyncItem } from "@/api/syncLocalFolder";
```

#### 2.2 `handleRefresh` 改为分支：local_folder 走 warn → await → success

[Albums.vue:484-518](../../apps/kabegame/src/views/Albums.vue#L484) 替换尾部 `ElMessage.success(t("albums.refreshSuccess"));` 一行为：

```ts
// 触发可见 local_folder 画册的同步：先 warn 告知陆续同步，await 完成后再 success。
const localFolderIdsOnPage = displayedAlbumRoots.value
  .filter((a) => a.type === "local_folder")
  .map((a) => a.id);

if (!IS_MACOS || localFolderIdsOnPage.length === 0) {
  // 普通路径：保持原即时 success（非 macOS 也走这条，避免空 results 静默）
  ElMessage.success(t("albums.refreshSuccess"));
} else {
  // 先提示用户："文件夹内容将陆续同步..."
  ElMessage.warning(t("albums.localFolder.refreshSyncProgressing"));
  // await 批量 sync（Phase 3 已包成 ok|err 结构，不会 reject）
  const results = await syncLocalFolderAlbums(localFolderIdsOnPage);
  // 聚合 toast：成功 / 部分失败 / 路径异常
  reportBatchSyncResult(results);
}
```

`reportBatchSyncResult` 是本文件局部 helper（放在 `<script setup>` 顶部 `import` 之后）：

```ts
import type { BatchSyncItem } from "@/api/syncLocalFolder";

const reportBatchSyncResult = (results: BatchSyncItem[]) => {
  if (results.length === 0) return;
  const errors = results.filter((r) => r.err != null);
  const badStatus = results.filter(
    (r) => r.ok && r.ok.status && r.ok.status.state !== "ok",
  );
  const okResults = results.filter((r) => r.ok && r.ok.status?.state === "ok");

  // 聚合数字
  let added = 0, deleted = 0, reimported = 0, skippedInFlight = 0;
  for (const r of okResults) {
    if (!r.ok) continue;
    added += r.ok.added;
    deleted += r.ok.deleted;
    reimported += r.ok.reimported;
    if (r.ok.skippedInFlight) skippedInFlight++;
  }

  if (errors.length > 0) {
    const first = errors[0];
    console.warn("[local_folder] sync errors", errors);
    ElMessage.error(
      t("albums.localFolder.refreshSyncFailedSome", {
        count: errors.length,
        firstError: first?.err ?? "",
      }),
    );
    return;
  }
  if (badStatus.length > 0) {
    console.warn("[local_folder] sync bad status", badStatus);
    ElMessage.warning(
      t("albums.localFolder.refreshSyncBadStatus", { count: badStatus.length }),
    );
    return;
  }
  ElMessage.success(
    t("albums.localFolder.refreshSyncDone", {
      added,
      deleted,
      reimported,
      skipped: skippedInFlight,
    }),
  );
};
```

> 关键：spinner（`isRefreshing.value = true ... finally { isRefreshing.value = false }`）天然 await 这段，与 toast 提示一致。

#### 2.3 `handleAlbumMenuCommand` 加 `"syncNow"`

[Albums.vue:687-715](../../apps/kabegame/src/views/Albums.vue#L687) 在 `if (command === "setWallpaperRotation")` 之前插入：

```ts
if (command === "syncNow") {
  try {
    const report = await syncLocalFolderAlbum(id);
    if (!report) return; // 非 macOS
    if (report.skippedInFlight) {
      ElMessage.info(t("albums.localFolder.syncInFlight"));
    } else if (report.status && report.status.state !== "ok") {
      ElMessage.warning(
        t(`albums.localFolder.status${pascalCase(report.status.state)}`, {
          message: report.status.message ?? "",
        }),
      );
    } else {
      ElMessage.success(
        t("albums.localFolder.syncDone", {
          added: report.added,
          deleted: report.deleted,
          reimported: report.reimported,
        }),
      );
    }
  } catch (e: any) {
    ElMessage.error(e?.message || String(e));
  }
  return;
}
```

同时把 type 签名扩展：

```ts
const handleAlbumMenuCommand = async (
  command: "browse" | "delete" | "setWallpaperRotation" | "rename" | "moveTo" | "syncNow",
) => { ... }
```

并在 `<ActionRenderer>` 的 `@command="(cmd) => handleAlbumMenuCommand(cmd as ...)"` 中同步扩展类型断言。

加一个本文件局部 helper（或新建 utils；Phase 6 内嵌即可）：

```ts
const pascalCase = (s: string) =>
  s.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase());
```

> 状态 i18n key 形如 `albums.localFolder.statusMissing` / `statusDenied` / `statusNotADir` / `statusIoError`（Phase 5 已建）。`pascalCase("not_a_dir")` → `"NotADir"`，与 Phase 5 的 key 完全对齐。

### 3. AlbumDetail.vue 改造

#### 3.1 import

```ts
import { syncLocalFolderAlbum, syncLocalFolderAlbums } from "@/api/syncLocalFolder";
import { IS_MACOS } from "@kabegame/core/env";
import type { BatchSyncItem } from "@/api/syncLocalFolder";
```

#### 3.2 `handleRefresh` 改为分支：local_folder 走 warn → await → success

[AlbumDetail.vue:967-995](../../apps/kabegame/src/views/AlbumDetail.vue#L967) 替换尾部 `ElMessage.success("刷新成功");` 为：

```ts
// 收集本页面涉及的 local_folder album id：当前 + 直接子。
const idsToSync: string[] = [];
if (albumId.value && albumStore.isLocalFolderAlbum(albumId.value)) {
  idsToSync.push(albumId.value);
}
if (albumId.value) {
  for (const a of albumStore.albums) {
    if (a.parentId === albumId.value && a.type === "local_folder") {
      idsToSync.push(a.id);
    }
  }
}

if (!IS_MACOS || idsToSync.length === 0) {
  ElMessage.success(t("albums.refreshSuccess"));
} else {
  ElMessage.warning(t("albums.localFolder.refreshSyncProgressing"));
  const results = await syncLocalFolderAlbums(idsToSync);
  reportBatchSyncResult(results);
}
```

`reportBatchSyncResult` 与 Albums.vue 步骤 2.2 的 helper **完全一致**——可以原地复制（小函数，避免提前抽公共模块）；如果用户希望复用，提到 `composables/useLocalFolderSyncFeedback.ts` 也行，**第一版不做抽离**，等 Phase 7+ 再决定。

> **取舍**：用 store 的 `albums` 过滤而不是 `childPreviewImages.value` 的 key——后者是预览渲染状态，可能因为缓存策略 lazy 加载，不一定包含所有子画册；用 `albums` 过滤是直接的真值来源。

#### 3.3 `handleChildAlbumMenuCommand` 加 `"syncNow"`

[AlbumDetail.vue:518-535](../../apps/kabegame/src/views/AlbumDetail.vue#L518) 加同样的 `"syncNow"` 分支，结构与 Albums.vue 第 2.3 步一致。Type 签名扩展：

```ts
const handleChildAlbumMenuCommand = async (
  command: "browse" | "delete" | "setWallpaperRotation" | "rename" | "moveTo" | "syncNow",
) => { ... }
```

并同步改 `<ActionRenderer @command="...">` 的类型断言。

### 4. `albumActions.ts` 加 syncNow

[actions/albumActions.ts:1-77](../../apps/kabegame/src/actions/albumActions.ts) 改造：

```ts
import { FolderOpened, Picture, Edit, Rank, Delete, Refresh } from "@element-plus/icons-vue";
import { IS_MACOS } from "@kabegame/core/env";
// ...

export interface AlbumActionContext extends ActionContext<Album> {
  currentRotationAlbumId: string | null;
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
  isLocalFolder: boolean;
}

export function createAlbumActions(): ActionItem<Album>[] {
  const t = (key: string) => i18n.global.t(key);
  return [
    {
      key: "browse",
      label: t("contextMenu.browse"),
      icon: FolderOpened,
      command: "browse",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "syncNow",
      label: t("contextMenu.syncNow"),
      icon: Refresh,
      command: "syncNow",
      visible: (ctx) =>
        IS_MACOS && (ctx as AlbumActionContext).isLocalFolder,
      dividerBefore: (ctx) =>
        (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "setWallpaperRotation",
      // ...原有...
    },
    // ...其余 rename / moveTo / delete 不变
  ];
}
```

> **位置**：syncNow 放在 `browse` 之后、`setWallpaperRotation` 之前——「立即同步」属于"获取数据"的语义，应靠近 browse。
> **dividerBefore**：仅当 browse 显示时才在 syncNow 之前画分隔，避免空菜单顶部出现孤立分隔线。

### 5. 给 albumMenuContext 补 `isLocalFolder`

#### 5.1 Albums.vue

[Albums.vue:614-625](../../apps/kabegame/src/views/Albums.vue#L614) 的 `albumMenuContext`：

```ts
const albumMenuContext = computed<AlbumActionContext>(() => {
  const album = albumMenu.context.value.target;
  return {
    target: album,
    selectedIds: new Set<string>(),
    selectedCount: 0,
    currentRotationAlbumId: currentRotationAlbumId.value,
    wallpaperRotationEnabled: wallpaperRotationEnabled.value,
    albumImageCount: album ? (displayedAlbumCounts.value[album.id] || 0) : 0,
    favoriteAlbumId: FAVORITE_ALBUM_ID,
    isLocalFolder: album?.type === "local_folder",
  };
});
```

#### 5.2 AlbumDetail.vue

同步找到 `childAlbumMenuContext`（位置 grep `childAlbumMenuContext` 在 [AlbumDetail.vue](../../apps/kabegame/src/views/AlbumDetail.vue)），追加 `isLocalFolder: childAlbumMenu.context.value.target?.type === "local_folder"`。

### 6. i18n keys

在 [packages/i18n/src/locales/zh/albums.json](../../packages/i18n/src/locales/zh/albums.json) 与 `en/albums.json` 增加（其它语言文件复制 en 行，标 TODO）：

```jsonc
// zh — albums.localFolder
{
  "localFolder": {
    // Phase 4/5 已有 keys 略
    "syncInFlight": "同步进行中…",
    "syncDone":     "已同步：新增 {added}、删除 {deleted}、更新 {reimported}",
    "refreshSyncProgressing": "本地文件夹画册内容将陆续同步，请稍候…",
    "refreshSyncDone":        "同步完成：新增 {added}、删除 {deleted}、更新 {reimported}{skipped, plural, =0 {} other { （# 个已在同步中跳过）}}",
    "refreshSyncBadStatus":   "{count} 个本地文件夹画册的路径无法访问，请检查文件夹状态",
    "refreshSyncFailedSome":  "{count} 个本地文件夹画册同步失败：{firstError}"
  }
}

// zh — contextMenu
{
  "contextMenu": {
    "syncNow": "立即同步"
  }
}

// en — albums.localFolder
{
  "localFolder": {
    "syncInFlight": "Syncing…",
    "syncDone":     "Synced: +{added} -{deleted} ~{reimported}",
    "refreshSyncProgressing": "Local folder albums are syncing in the background, please wait…",
    "refreshSyncDone":        "Sync done: +{added} -{deleted} ~{reimported}{skipped, plural, =0 {} other { (# already in flight, skipped)}}",
    "refreshSyncBadStatus":   "{count} local folder album(s) cannot access their paths; please check folder status",
    "refreshSyncFailedSome":  "{count} local folder album(s) failed to sync: {firstError}"
  }
}

// en — contextMenu
{
  "contextMenu": {
    "syncNow": "Sync now"
  }
}
```

> **复数语法**：`{skipped, plural, =0 {} other { (...) }}` 是 Vue I18n / ICU MessageFormat 标准；项目内已用此风格（grep `plural` 验证）。若 grep 失败，简化为 `{skipped > 0 ? ... : ""}` 在 view 层组合。
>
> **核对**：`contextMenu` 命名空间的位置可能在 `albums.json` 也可能在另一个文件；grep `"contextMenu":` 在 `packages/i18n/src/locales/zh/` 下找到准确文件后追加。

---

## 验收清单

1. **类型检查**：
   - `bun check -c kabegame` 通过。
   - 后端不动，无需 cargo check。

2. **Albums 页下拉刷新 / Header 刷新按钮**：
   - 准备一个 local_folder album 指向 `/tmp/lf-test`，里面已有 1 张 jpg 已同步入库。
   - Finder 在 `/tmp/lf-test` 加入第 2 张 jpg；
   - Kabegame Albums 页下拉刷新 → 立刻看到**黄色 warning** toast「本地文件夹画册内容将陆续同步，请稍候…」；
   - spinner 持续显示（isRefreshing=true），1~3 秒后 spinner 收起，**绿色 success** toast「同步完成：新增 1、删除 0、更新 0」出现；
   - 画册预览中第 2 张图同时出现（事件流陆续推动 UI 更新）。
   - 同样配置但**无** local_folder album 时下拉刷新 → 只见原有「刷新成功」绿 toast，无 warn。
   - DevTools 控制台能看到 invoke 调用并打印 SyncReport，无报错。

3. **AlbumDetail 详情页下拉刷新**：
   - 进入步骤 2 的 album，下拉刷新 → 同样 warn → await → success 三段式；列表中第 2 张图同时出现。
   - 进入一个**普通**画册（kind=normal），下拉刷新 → 直接绿 toast「刷新成功」，**不**发 sync invoke（DevTools 网络/console 验证）、**不**显示 warn。
   - 进入一个 local_folder album 的父级（kind=normal，但子画册有 local_folder）→ 下拉刷新触发 warn → await 批量 sync → success；只对 local_folder 子画册发 sync，普通子画册不发。

4. **右键 / Action 菜单「立即同步」**：
   - Albums 列表右键 local_folder album → 菜单含「立即同步」项；普通画册右键 → 不含该项。
   - 点击「立即同步」→ 异步等待，完成后 ElMessage.success 显示三项计数；并发再点一次 → 该次返回 `skippedInFlight=true`，ElMessage.info 显示「同步进行中…」。
   - 路径不存在的 album 点同步 → ElMessage.warning 显示「本地路径不存在…」。
   - 普通 album 不显示「立即同步」选项（即便强行触发也走不进 syncNow case）。

5. **非 macOS**：
   - Linux dev 上下拉刷新 Albums → 不发 sync invoke（IS_MACOS 拦在前端）；后端日志没有相关行。
   - 右键菜单不显示「立即同步」（visible 守卫双重保险）。

6. **回归**：
   - 普通画册刷新行为与本 Phase 之前完全一致（直接 success，无 warn）。
   - 没有 local_folder album 时，Albums.vue 的 sync 分支因 `localFolderIdsOnPage.length === 0` 走 else，**不**发 invoke、**不**显示 warn。
   - 刷新 spinner 持续到 sync 完成（与 warn 文案一致）；用户中途离开页面或切换路由不会导致控制台报错（component teardown 取消 await 安全）。

7. **错误路径**：
   - 把 sync_folder 改成不存在路径，再触发刷新 → warn → spinner 持续 → ElMessage.warning「X 个本地文件夹画册的路径无法访问…」（不弹 success）。
   - 故意把 lib.rs 中的 `sync_local_folder_albums` handler 暂时注释掉（构造 invoke 失败）→ ElMessage.error「X 个本地文件夹画册同步失败：command not found」。

---

## 不做的事（明确边界）

- **不**实现 viewport-visible 细粒度 tracking。第一版按"页面级"语义触发。
- **不**在 sync 期间显示画册卡片上的"正在同步"指示器（无 emit 路径回流前端，且 SyncReport 完成时事件已驱动 UI；如未来要做需要新增 `local-folder-sync-state` 事件）。
- **不**在 Albums.vue 的 sync trigger 里弹任何 toast——批量错误吞掉。
- **不**接入实时监听（Phase 7）。
- **不**改后端任何代码。
- **不**给 AlbumCard 加「立即同步」按钮——通过右键 / Action 菜单已足够，避免视觉噪声。
- **不**实现"长按卡片立即同步"或其它新增手势。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| sync 耗时长（大目录 / 慢盘）spinner 一直转 | 用户以为卡死 | warn toast 文案明确告知"陆续同步，请稍候…"；spinner 持续是预期行为。若实际超过 10s，未来可在 SyncReport 上加 progress emit（暂不做） |
| 大批量 local_folder album（>50）在刷新时一次性 await 批量 invoke | 后端串行处理可能久（几十秒） | Phase 3 的批量 RPC 内部串行；本 Phase 不前端节流。若实测体验不可接受，下一轮把"立即同步"做成 chunked + 局部进度。文档明记 |
| `IS_MACOS` 在 Web 构建中始终 false | local_folder album 在 web 完全不可同步 | `syncLocalFolderAlbums(ids)` 在非 macOS 返回 `[]`；`reportBatchSyncResult([])` 早返不弹任何 toast；上游分支条件 `idsToSync.length > 0` 仍走 warn 分支但 `[]` 结果 → 无任何 toast。**修正**：在 Albums.vue / AlbumDetail.vue 的分支条件再加一层 `IS_MACOS && idsToSync.length > 0`，非 macOS 直接走 else 分支（普通 success toast）。**实施时务必加上** |
| 右键菜单 syncNow 出现但 invoke 后端不存在（旧 binary） | 第一次点击报"command not found" | 后端 Phase 3 已注册命令；只要前后端一起升级到 Phase 3+ 即无问题。Phase 6 假设前后端版本同步 |
| `pascalCase("io_error")` → `"IoError"` 与 Phase 5 i18n key `statusIoError` 不一致 | i18n miss | Phase 5 文档写的就是 `statusIoError`（grep 确认）；`pascalCase("io_error")` 输出确为 `"IoError"`，组合为 `statusIoError` ✅ |
| `Refresh` 图标在 element-plus icon set 中已存在 | 编译错 | `@element-plus/icons-vue` 含 `Refresh`，确认。如不存在用 `RefreshRight` |
| 用户在 sync 进行中点了第二次刷新 | 第一次 await 仍在等；第二次进入 handleRefresh → loadAlbums OK → 同一批 invoke → 每个 album 立即返回 `skippedInFlight=true` → success toast 多了"X 个已在同步中跳过" | 这是 Phase 3 设计的正确行为；UX 上"重复刷新被告知正在同步"是合理反馈 |
| 用户在 sync 完成前关页面 / 切路由 | view unmount，await 仍在后台 promise 链上 | Vue 内 `await` 之后访问 `albumStore` / template 是安全的；ElMessage 不依赖组件存活；await resolve 时 ref 写入会被 GC 静默丢掉。不需要额外取消逻辑 |
| AlbumDetail 当前画册是 hidden / favorite（系统画册） | 这些是 kind=normal，不会触发 sync | isLocalFolderAlbum 守卫已天然兜底 |
| `reportBatchSyncResult` 在两个 view 中重复 | 维护负担 | 第一版接受重复（~30 行）；若 Phase 7 接入实时监听后需要更复杂 UI，再抽 `composables/useLocalFolderSyncFeedback.ts` |
| ICU plural 语法在项目 i18n 中未启用 | warn / success 文案的"X 个已跳过"部分原样显示 | grep `plural,` 在 `packages/i18n/src/locales/` 验证；如未启用，把"已跳过"信息拼接到 view 层（在 `reportBatchSyncResult` 内手工组装 message 而非依赖 i18n 复数）|

---

## 关键 grep 自检

```bash
# 前端三处入口都接上
rg -n "syncLocalFolderAlbum|syncLocalFolderAlbums" apps/kabegame/src

# albumActions 内 syncNow 存在
rg -n '"syncNow"' apps/kabegame/src

# i18n key 完整
rg -n "syncInFlight|syncDone|contextMenu.*syncNow|\"syncNow\"" packages/i18n/src/locales

# 非 macOS 守卫不被遗漏
rg -n "IS_MACOS" apps/kabegame/src/api/syncLocalFolder.ts apps/kabegame/src/actions/albumActions.ts

# AlbumActionContext 已带 isLocalFolder
rg -n "isLocalFolder" apps/kabegame/src/actions/albumActions.ts apps/kabegame/src/views/Albums.vue apps/kabegame/src/views/AlbumDetail.vue
```

---

## 关键参考定位

- [`Albums.vue::handleRefresh`](../../apps/kabegame/src/views/Albums.vue#L484) — sync trigger 插入点。
- [`Albums.vue::handleAlbumMenuCommand`](../../apps/kabegame/src/views/Albums.vue#L687) — syncNow case 插入点。
- [`Albums.vue::albumMenuContext`](../../apps/kabegame/src/views/Albums.vue#L614) — 补 `isLocalFolder` 字段。
- [`AlbumDetail.vue::handleRefresh`](../../apps/kabegame/src/views/AlbumDetail.vue#L967) — sync trigger 插入点。
- [`AlbumDetail.vue::handleChildAlbumMenuCommand`](../../apps/kabegame/src/views/AlbumDetail.vue#L518) — syncNow case 插入点。
- [`actions/albumActions.ts`](../../apps/kabegame/src/actions/albumActions.ts) — Action 列表 + context 类型扩展。
- [Phase 3 命令 SyncReport 结构体](./local-folder-album-sync-phase3.md#11-syncreport-追加序列化派生与-skipped_in_flight-字段) — 前端类型对照源。
- [`@kabegame/core/env::IS_MACOS`](../../packages/core/src/env.ts#L3) — build-time 平台标志。
