# Phase 5 — 卡片视觉 + 只读约束

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：[Phase 1](./local-folder-album-sync-phase1.md)（Album 带 `kind` / `syncFolder` / `folderStatus`）、[Phase 2](./local-folder-album-sync-phase2.md)（sync 写入路径，包含 `import.rs`、`sync.rs` 内部对 `add_image` / `add_images_to_album` / `update_album_images_order` 的调用）、[Phase 3](./local-folder-album-sync-phase3.md)（sync 命令注册）、[Phase 4](./local-folder-album-sync-phase4.md)（创建弹窗与 `add_local_folder_album` 命令）已实现并合并。
> 范围：
> 1. AlbumCard 视觉区分（紫色渐变标题 + 路径替换创建时间 + folderStatus 指示器）。
> 2. 后端写操作守卫——拦截用户面入口（命令层），让 sync **内部**写入仍能直达 Storage。
> 3. 前端 UX 兜底——隐藏 / 禁用 local_folder album 下的"添加图片 / 从画册移除 / 拖入导入"入口。
> 4. 删除流程在 confirm 弹窗里增提示：删 album 不删本地文件、不删 images 本体。
> 5. i18n 新增 key。
>
> **不**做的事（重要不变量）：
> - **不**改 `rename_album` / `move_album` / `add_album`——画册之间的位置关系（重命名、移动、在 local_folder album 下创建子画册）完全自由。**每个 local_folder album 只表示自己对应的非递归目录，对画册树位置无感知**。
> - **不**隐藏 `create-sub-album` 按钮——用户可在 local_folder album 下手动创建普通子画册（普通子画册自身可写，互不干扰）。
> - **不**阻断 `update_album_images_order`——[Phase 4 决策点 6](./local-folder-album-sync-phase4.md#已确认的设计点)：用户可手动调整 local_folder album 的图片顺序，reimport 已通过 carry.order 保留。
> - **不**修改 sync 内部 `import_local_file` 与 `update_album_images_order` 调用路径——只在**命令层**加守卫，不动 Storage 直接 API。

---

## 关键设计点

### 1. 守卫安放位置：命令层而不是 Storage 层

候选放置点对比：

| 位置 | 优点 | 缺点 | 选 ❓ |
|---|---|---|---|
| `Storage::add_images_to_album` / `update_album_images_order` | 一处守卫覆盖一切调用 | 会拦住 sync 内部的 `import.rs`→`storage.add_images_to_album` 和 `update_album_images_order`；需要给 sync 路径开特殊豁免 | ❌ |
| `storage::image_events::add_images_to_album_with_event` 等"with_event" 包装 | 半层之间，覆盖大部分用户路径 | sync 用的也是 `storage.add_image` + `storage.add_images_to_album`（不走 with_event）、`update_album_images_order`——豁免天然成立 | ✅ 用作 Storage 入口的保险 |
| `commands_core::album::add_images_to_album` / `_task_images_to_album` / `remove_images_from_album` / `update_album_images_order` | 离用户最近，与 MCP / Web RPC / Tauri 三种入口共享 | 需要每个命令逐一加 guard | ✅ **主**守卫位置 |
| `mcp_server.rs` / `web/dispatch.rs` 各自层 | 同上 | 三处重复代码 | ❌ |

**取舍**：在 `commands_core` 加守卫，**额外**在 `image_events.rs` 的 `add_images_to_album_with_event` / `remove_images_from_album_with_event` / `toggle_image_favorite_with_event` 也加同一守卫做保险——这三个 `*_with_event` 函数是 GUI 路径必经，sync 内部**不走**它们（sync 直接 `Storage::add_images_to_album` + `emit_album_images_change`，看 [import.rs](../../src-tauri/kabegame-core/src/local_folder/import.rs)），所以守卫不会自伤。

> **为什么不在 Storage 层**：sync 路径里 `storage.add_image` / `storage.add_images_to_album` / `storage.update_album_images_order` 三个调用都需要 hit 同一个 local_folder album。如果在 Storage 层加 readonly guard，得加 thread-local / explicit bypass 参数，复杂且容易漏。命令层守卫更直接。

### 2. 守卫函数的位置与签名

新增 `kabegame_core::storage::albums::ensure_album_is_writable(album_id) -> Result<(), String>`：
- 读 `albums.kind`；若 `'local_folder'` 返回 `Err("album {id} is read-only (local_folder sync)")`。
- 不存在的 album id 不报错（让原本的 "album not found" 错误从下游冒上来；避免双层错误信息混乱）。
- 系统 album（FAVORITE / HIDDEN）始终返回 Ok（它们 `kind='normal'`）。

### 3. AlbumCard 视觉

参考 [AlbumCard.vue:30-37](../../apps/kabegame/src/components/albums/AlbumCard.vue#L30) 当前 meta 行：

```html
<div class="meta">
  <span>{{ $t('albums.albumCount', { count }) }}</span>
  <span v-if="album.createdAt">{{ $t('albums.createdAtPrefix', { date: formatDate(album.createdAt) }) }}</span>
</div>
```

改造：
- `isLocalFolder` 时 `<span v-if="album.createdAt">` 替换为 `<span class="sync-path" :title="album.syncFolder">{{ formatPathForCard(album.syncFolder) }}</span>`。
- 紫色渐变只作用于 `.title`，**不**改变背景色（卡片整体保持原渐变 `linear-gradient(135deg, #fef7ff, #f0f7ff)`）。
- `folderStatus.state !== 'ok'` 时在标题左侧加一个 8px 红点；用 `<el-tooltip>` 包住显示 state 与 message。

### 4. AlbumDetail "图片"工具栏的隐藏项

进入 `type='local_folder'` 的画册详情页时：
- 图片右键菜单 / Android selection action：**隐藏** `remove`（这是"从本画册移除"，写 local_folder）。
- **保留**：`favorite`（写收藏画册，不写本画册）、`addToAlbum`（把图片**加入到另一个画册**，本画册不变动）、`detail` / `copy` / `download` / `open` / `wallpaper` / `share` / `exportToWE`。
- 实际隐藏项只有 `remove`。
- 顶部 PageHeader 的 `create-sub-album` 按钮：**保留**——画册树位置自由可控；用户在 local_folder album 下手动创建普通子画册是合法操作（子画册是普通画册，与父的 sync 语义无关）。

### 5. AddToAlbumDialog 目标列表

[AddToAlbumDialog.vue:62](../../apps/kabegame/src/components/AddToAlbumDialog.vue#L62) 通过 `excludeAlbumIds` 排除目标。本 Phase 让 store 提供 `localFolderAlbumIds` getter，AddToAlbumDialog 把它们一律加入 exclude 列表（向 local_folder album 添加图片是写操作，被后端拒绝；前端先排除避免用户看到无效目标）。

### 6. 拖拽到 AlbumCard

通过 grep 已确认：[FileDropOverlay](../../apps/kabegame/src/components/FileDropOverlay.vue) 是**全局**拖入（App.vue 顶层挂载），不针对单个 AlbumCard。即"拖一组本地文件到画册卡片上自动入到该画册"目前**不存在**这个 UX，所以本 Phase **无需**给 AlbumCard 加拒绝逻辑——它原本就不接受 drop。
- 仅在根计划里残留这一行需求；本 Phase 在文档与代码 grep 验证后撤销该任务（写入"不做的事"）。

### 7. 删除流程

- 当前删除任何画册都走 `albumStore.deleteAlbum`；后端 `delete_album` 已经只删 album + album_images 关系，不删 images（[albums.rs:280](../../src-tauri/kabegame-core/src/storage/albums.rs#L280)）——这正是用户要的"不删 images 本体"。
- 唯一改动：confirm 文案——`isLocalFolder` 时使用一条专门提示，说明"本地文件不会被删除"。

---

## 涉及文件清单

### 新增

- 无新文件。

### 修改

#### 后端

- [src-tauri/kabegame-core/src/storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs)
  - 新增 `pub fn ensure_album_is_writable(&self, album_id: &str) -> Result<(), String>`
  - 删除 album 时已经天然不删 images（保持不变）；不修改 `delete_album`
- [src-tauri/kabegame-core/src/storage/image_events.rs](../../src-tauri/kabegame-core/src/storage/image_events.rs)
  - `add_images_to_album_with_event` / `remove_images_from_album_with_event` / `toggle_image_favorite_with_event`（仅当 target album 是收藏画册时——但收藏画册 kind=normal，guard 一律通过；仍写一行 guard 做习惯）：开头 `Storage::global().ensure_album_is_writable(album_id)?;`
- [src-tauri/kabegame/src/commands_core/album.rs](../../src-tauri/kabegame/src/commands_core/album.rs)
  - `add_images_to_album` / `add_task_images_to_album` / `remove_images_from_album` / `update_album_images_order` 入口先调 `ensure_album_is_writable`
  - **例外**：`update_album_images_order` **不调** guard——用户要保留手动重排能力。命令层不拦，仅依赖 store 写守卫 + 反向 carry.order 保住语义。

#### 前端

- [apps/kabegame/src/stores/albums.ts](../../apps/kabegame/src/stores/albums.ts)
  - 新增 computed `localFolderAlbumIds`（getter）
  - 新增辅助 `isLocalFolderAlbum(albumId: string): boolean`
- [apps/kabegame/src/components/albums/AlbumCard.vue](../../apps/kabegame/src/components/albums/AlbumCard.vue)
  - meta 行替换；标题渐变；状态红点
- [apps/kabegame/src/views/AlbumDetail.vue](../../apps/kabegame/src/views/AlbumDetail.vue)
  - 图片菜单 / Android selection 过滤 `remove`
  - 删除 confirm 文案分支
- [apps/kabegame/src/components/AddToAlbumDialog.vue](../../apps/kabegame/src/components/AddToAlbumDialog.vue)
  - `getAlbumTreeExcluding` 调用追加 `albumStore.localFolderAlbumIds`
- [apps/kabegame/src/actions/albumActions.ts](../../apps/kabegame/src/actions/albumActions.ts)
  - `AlbumActionContext` 增 `isLocalFolder: boolean`
  - `setWallpaperRotation` 保留（local_folder 也能做壁纸轮播）；`delete` / `rename` / `moveTo` 保留；可视化无变化（视觉差异在卡片，菜单一致）

#### i18n（最少 zh / en；其它 ja / ko / zhtw 同名 key 留 TODO 不阻断）

- [packages/i18n/src/locales/{en,zh,ja,ko,zhtw}/albums.json](../../packages/i18n/src/locales/)
  - `localFolder.syncPathLabel`（备用，目前 syncFolder 直显路径，可不用）
  - `localFolder.statusOk` / `statusMissing` / `statusDenied` / `statusNotADir` / `statusIoError`
  - `localFolder.readOnlyHint`（用于 Storage / 命令层错误返回的 i18n——但后端目前直接返回中文/英文字符串，前端不做翻译；此 key 暂仅前端 toast 时用）
  - `albums.deleteLocalFolderAlbumConfirm`：例如 `"删除本地文件夹画册 {name}？\n该操作只会移除画册本身和它与图片的关联，磁盘上的本地文件不会被删除。"`

### 不修改

- `add_album` 路径（普通画册）——包括在 local_folder album 下创建普通子画册。
- `rename_album` / `move_album`——画册树关系自由。
- `update_album_images_order` 的命令层（保留可写）。
- `AlbumDetailPageHeader.vue`——不加 `isLocalFolder` prop，不动 `create-sub-album` 按钮可见性。
- Sync 内部任何文件（`import.rs` / `sync.rs` / `diff.rs` 等）。
- `delete_album` 后端实现。
- AlbumCard 的拖拽逻辑（不存在拖拽到卡片的 UX）。

---

## 步骤

### 1. 后端 `ensure_album_is_writable`

[storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) 在 `album_exists` 函数之后追加：

```rust
impl Storage {
    /// 守卫：若 album 是 `local_folder` 类型，则视为只读，返回 Err；
    /// 其它情况（包括不存在）返回 Ok 让下游报错。
    ///
    /// 用于命令层入口（`commands_core::album::*`）以及 `image_events::*_with_event`
    /// 包装函数。sync 内部走 `Storage::add_image` + `add_images_to_album` 等**不带 event 包装**
    /// 的直插路径，**不会**触发本守卫——这是设计取舍：sync 是"权威同步源"，必须能直写。
    pub fn ensure_album_is_writable(&self, album_id: &str) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let kind: Option<String> = conn
            .query_row(
                "SELECT type FROM albums WHERE id = ?1",
                rusqlite::params![album_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("query album kind: {e}"))?;
        match kind.as_deref() {
            Some("local_folder") => Err(format!(
                "album {album_id} is read-only (local_folder sync)"
            )),
            _ => Ok(()),
        }
    }
}
```

### 2. `image_events.rs` 加守卫

```rust
pub fn add_images_to_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<AddToAlbumResult, String> {
    Storage::global().ensure_album_is_writable(album_id)?;
    let r = Storage::global().add_images_to_album(album_id, image_ids)?;
    // ...
}

pub fn remove_images_from_album_with_event(
    album_id: &str,
    image_ids: &[String],
) -> Result<usize, String> {
    Storage::global().ensure_album_is_writable(album_id)?;
    let removed = Storage::global().remove_images_from_album(album_id, image_ids)?;
    // ...
}
```

`toggle_image_favorite_with_event` 不需要——它写的是收藏画册（kind=normal），不可能被命中。

### 3. `commands_core/album.rs` 加守卫

参考 [commands_core/album.rs:62-105](../../src-tauri/kabegame/src/commands_core/album.rs#L62)。在 4 个写命令开头追加（**不**包括 `update_album_images_order`）：

```rust
pub async fn add_images_to_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    let r = add_images_to_album_with_event(&album_id, &image_ids)?;
    // ...
}

pub async fn add_task_images_to_album(task_id: String, album_id: String) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    // ...
}

pub async fn remove_images_from_album(
    album_id: String,
    image_ids: Vec<String>,
) -> Result<Value, String> {
    Storage::global().ensure_album_is_writable(&album_id)?;
    // ...
}
```

> **取舍**：命令层与 `image_events.rs` 都加 guard 是有意冗余——sync 不经命令层，但用户可能通过 MCP / Web 直接调 `image_events` 包装；双层兜底确保不会漏。性能不敏感（每次写都多一次 SQL 单行查询）。

### 4. MCP 入口

[mcp_server.rs:520](../../src-tauri/kabegame/src/mcp_server.rs#L520) `add_images_to_album` 直接调用 `Storage::add_images_to_album`（不经 commands_core）。**追加** guard：

```rust
"add_images_to_album" => {
    // ...args 解析...
    Storage::global().ensure_album_is_writable(&args.album_id)?;
    storage
        .add_images_to_album(&args.album_id, &args.image_ids)?;
    // ...
}
```

同样核对 [mcp_server.rs:591](../../src-tauri/kabegame/src/mcp_server.rs#L591) `update_album_images_order` —— **不**加守卫，保留可写。

### 5. AlbumCard 视觉

[AlbumCard.vue](../../apps/kabegame/src/components/albums/AlbumCard.vue) 修改：

#### 5.1 模板替换

```vue
<div class="title-wrapper">
  <el-input v-if="isRenaming" ... />
  <div v-else class="title" :class="{ 'title-local-folder': isLocalFolder }" @click.stop @dblclick="handleStartRename">
    <el-tooltip
      v-if="isLocalFolder && folderStatusBad"
      :content="folderStatusTooltip"
      placement="top"
    >
      <span class="status-dot" />
    </el-tooltip>
    {{ album.name }}
  </div>
</div>
<div class="meta">
  <span>{{ $t('albums.albumCount', { count }) }}</span>
  <span
    v-if="isLocalFolder && album.syncFolder"
    class="sync-path"
    :title="album.syncFolder"
  >
    · {{ formatPathForCard(album.syncFolder) }}
  </span>
  <span v-else-if="album.createdAt">
    {{ $t('albums.createdAtPrefix', { date: formatDate(album.createdAt) }) }}
  </span>
</div>
```

#### 5.2 script 追加

```ts
import { ElTooltip } from "element-plus";
import { useI18n } from "@kabegame/i18n";

const isLocalFolder = computed(() => props.album.type === "local_folder");

const folderStatusBad = computed(() => {
  const s = props.album.folderStatus;
  return !!s && s.state !== "ok";
});

const folderStatusTooltip = computed(() => {
  const s = props.album.folderStatus;
  if (!s) return "";
  switch (s.state) {
    case "missing":   return t("albums.localFolder.statusMissing");
    case "denied":    return t("albums.localFolder.statusDenied", { message: s.message ?? "" });
    case "not_a_dir": return t("albums.localFolder.statusNotADir");
    case "io_error":  return t("albums.localFolder.statusIoError", { message: s.message ?? "" });
    default:          return "";
  }
});

const formatPathForCard = (p: string): string => {
  // 卡片宽度有限：取末尾两段；首尾用 ~ 表示 HOME。
  // 完整路径已在 :title 上 hover 展示。
  if (!p) return "";
  const home = (window as any).__USER_HOME__ as string | undefined; // 见步骤 5.3
  let display = p;
  if (home && p.startsWith(home)) {
    display = "~" + p.slice(home.length);
  }
  const parts = display.split("/").filter(Boolean);
  if (parts.length <= 2) return display;
  return ".../" + parts.slice(-2).join("/");
};
```

#### 5.3 HOME 路径（可选优化，不做也不阻断）

`formatPathForCard` 想把 `/Users/foo/Pictures/x` 显示成 `~/Pictures/x`。Tauri 侧 `tauri-plugin-pathes` 已经有 `AppPaths` 暴露 home 路径。第一版可以直接**不做** HOME 替换（显示完整路径裁两段），把 `formatPathForCard` 简化为：

```ts
const formatPathForCard = (p: string): string => {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
};
```

#### 5.4 样式追加（替换 [AlbumCard.vue:474-484](../../apps/kabegame/src/components/albums/AlbumCard.vue#L474) `.title` 区块的下方）

```scss
.title {
  /* ... 原有规则 ... */
  display: inline-flex;
  align-items: center;
  gap: 6px;

  &.title-local-folder {
    background: linear-gradient(135deg, #a78bfa, #7c3aed);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    /* text-shadow 在透明文字上无效，主动清空避免 fallback 失真 */
    text-shadow: none;
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  flex-shrink: 0;
  /* 一点呼吸感 */
  box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6);
  animation: status-dot-pulse 1.8s ease-out infinite;
}

@keyframes status-dot-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
  70%  { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0);  }
  100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);    }
}

.sync-path {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: rgba(124, 58, 237, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 75%;
  display: inline-block;
  vertical-align: bottom;
}
```

### 6. Store: `localFolderAlbumIds` + `isLocalFolderAlbum`

[stores/albums.ts](../../apps/kabegame/src/stores/albums.ts) 在 `getDescendantIds` 之后追加：

```ts
const localFolderAlbumIds = computed<string[]>(() =>
  albums.value.filter((a) => a.type === "local_folder").map((a) => a.id),
);

const isLocalFolderAlbum = (albumId: string | null | undefined): boolean => {
  if (!albumId) return false;
  return albums.value.some((a) => a.id === albumId && a.type === "local_folder");
};
```

在 store return 块加 `localFolderAlbumIds, isLocalFolderAlbum,`。

### 7. AlbumDetail.vue

#### 7.1 currentAlbum 已有 → 派生 `isLocalFolderDetail`

[AlbumDetail.vue:641](../../apps/kabegame/src/views/AlbumDetail.vue#L641) 附近已有 `currentAlbumId`。追加：

```ts
const isLocalFolderDetail = computed(() =>
  albumStore.isLocalFolderAlbum(albumId.value),
);
```

#### 7.2 隐藏 `remove` 操作

`handleImageMenuCommand` 的 `case "remove"` 分支早返：

```ts
case "remove": {
  if (isLocalFolderDetail.value) {
    ElMessage.info(t("albums.localFolder.readOnlyHint"));
    break;
  }
  // ...原逻辑...
}
```

并在 `buildSelectionActions` 内动态过滤：

```ts
const baseActions: SelectionAction[] = selectedCount === 1
  ? [
      { key: "favorite", label: ..., icon: ..., command: "favorite" },
      { key: "addToAlbum", label: t("contextMenu.addToAlbum"), icon: FolderAdd, command: "addToAlbum" },
      { key: "remove", label: t("gallery.removeFromAlbum"), icon: Delete, command: "remove" },
    ]
  : [/* ... */];
return isLocalFolderDetail.value
  ? baseActions.filter((a) => a.key !== "remove")
  : baseActions;
```

同样在 `createImageActions` 调用处（如有）传 `excludeCommands: isLocalFolderDetail.value ? ["remove"] : []`（如 `imageActions.ts` 暴露该机制；否则在 `handleImageMenuCommand` 早返已足够，菜单项点击但被 toast 拦回也可接受——第一版用早返即可，不动 actions 列表）。

> **取舍**：菜单项**保留显示**但点击拦截会有"为什么没反应"的体验摩擦。第一版方案 = "selection bar 过滤 + handleImageMenuCommand 早返"——右键菜单仍显示 remove 但点击不生效。若要彻底隐藏右键菜单中的 `remove`，需要 createImageActions 接受 hide list；列入 Phase 5+ 改进，不阻断本 Phase。

#### 7.3 删除 confirm 文案分支

[AlbumDetail.vue:583](../../apps/kabegame/src/views/AlbumDetail.vue#L583) 当前：

```ts
t("albums.deleteAlbumConfirm", { name }),
```

改为：

```ts
isLocalFolderDetail.value
  ? t("albums.deleteLocalFolderAlbumConfirm", { name })
  : t("albums.deleteAlbumConfirm", { name }),
```

同样在 [AlbumDetail.vue:1637 `handleDeleteAlbum`](../../apps/kabegame/src/views/AlbumDetail.vue#L1637) 内的 confirm 文案做同样替换（grep 两处都改）。

[Albums.vue:740](../../apps/kabegame/src/views/Albums.vue#L740) 的列表页删除入口同样改：先判断 `albumStore.isLocalFolderAlbum(id)` 然后选择文案。

### 8. AddToAlbumDialog.vue

[AddToAlbumDialog.vue:62](../../apps/kabegame/src/components/AddToAlbumDialog.vue#L62)：

```ts
albumStore.getAlbumTreeExcluding([
  HIDDEN_ALBUM_ID,
  ...albumStore.localFolderAlbumIds,
  ...(props.excludeAlbumIds ?? []),
]),
```

`watch` 数组依赖追加 `albumStore.localFolderAlbumIds`（如已是 `albums.value` 依赖会自动反应；若是显式 watch list，加进去）。

### 9. i18n keys

在 [packages/i18n/src/locales/{en,zh,ja,ko,zhtw}/albums.json](../../packages/i18n/src/locales/) 各自的 `localFolder` 子对象（Phase 4 已建过 `localFolder.create` 等）追加：

```jsonc
// zh
{
  "localFolder": {
    /* Phase 4 已有：create, choosePath, noPathSelected, recursive, recursiveHint, recursiveLimits, skipNotice */
    "statusMissing":  "本地路径不存在或已被移动",
    "statusDenied":   "无权访问本地路径：{message}",
    "statusNotADir":  "本地路径不是目录",
    "statusIoError":  "读取本地路径时出错：{message}",
    "readOnlyHint":   "本地文件夹同步画册不可手动增删图片"
  },
  "deleteLocalFolderAlbumConfirm":
    "删除本地文件夹画册「{name}」？\n该操作仅会删除画册和它与图片的关联，磁盘上的本地文件不会被删除。"
}

// en
{
  "localFolder": {
    "statusMissing":  "Local folder does not exist or was moved",
    "statusDenied":   "Permission denied accessing local folder: {message}",
    "statusNotADir":  "Local path is not a directory",
    "statusIoError":  "Error reading local folder: {message}",
    "readOnlyHint":   "Local folder sync albums cannot be edited manually"
  },
  "deleteLocalFolderAlbumConfirm":
    "Delete local folder album \"{name}\"?\nOnly the album and its image associations will be removed. Files on disk will NOT be deleted."
}
```

`ja` / `ko` / `zhtw` 用 en 文案复制，标注 TODO 让翻译协作补；不阻断本 Phase。

### 10. albumActions.ts（不强制）

[albumActions.ts:11](../../apps/kabegame/src/actions/albumActions.ts#L11) 的 `AlbumActionContext` 可选加 `isLocalFolder?: boolean`，目前菜单项全部对 local_folder 保留意义（rename/move/delete/browse/setWallpaperRotation 都可用），所以**本 Phase 不改 albumActions 内容**。仅在文档里记一句"未来若要给 local_folder 增加'立即同步'菜单项再加 ctx 字段"。

---

## 验收清单

1. **类型检查**：
   - `bun check -c kabegame` 通过。
   - `cargo check -p kabegame-core`、`cargo check -p kabegame` 通过。

2. **守卫行为**（macOS，启动 dev）：
   - 准备一个 type='local_folder' album（Phase 4 创建流程）。
   - DevTools 直接 invoke `add_images_to_album` 把任意 image_id 加到该 album → 返回 `Err(...read-only (local_folder sync))`。
   - 同 invoke `remove_images_from_album` → 同上拒绝。
   - invoke `add_task_images_to_album` → 同上拒绝。
   - invoke `update_album_images_order`（手动设置 order）→ **成功**（这是有意保留的）。
   - 普通画册（kind=normal）四个命令都正常工作。
   - sync 触发后内部的 `Storage::add_images_to_album` 直插依然成功（看 console 同步日志 + DB 数据）——证明 guard 没有自伤 sync 路径。

3. **画册树关系自由**（关键不变量验证）：
   - 在 local_folder album 详情页点「创建子画册」→ 弹窗正常出现，可以创建普通子画册（kind=normal）成功；该子画册可写、可加图片。
   - 在 Albums 列表右键 local_folder album → 选「移动到」→ 可移到任意 parent（包括另一个 local_folder album 下）；移动后画册树结构正确。
   - 重命名 local_folder album → 正常生效；不影响 `sync_folder` 字段。

4. **AlbumCard 视觉**：
   - 普通画册：标题深色，meta 显示 `· Created 2026-05-01`。
   - local_folder album：标题紫色渐变，meta 显示 `· .../Pictures/xx`（或全路径，悬浮 title 展开）。
   - sync_folder 不存在时（手动 mv 走目录后 invoke sync_local_folder_album）：folderStatus 写入 missing，卡片左侧出现脉动红点，hover 提示"本地路径不存在或已被移动"。

4. **AddToAlbumDialog**：
   - 选中任意图片 → "添加到画册"对话框 → 树形选择器中**看不到** local_folder 画册（递归子也都不见）。

5. **AlbumDetail 行为**：
   - 进入 local_folder album → PageHeader 不显示「创建子画册」按钮。
   - 长按选中一张图片 → 底部 selection bar 显示 `收藏` / `添加到画册`，**不**显示「从画册移除」。
   - 桌面右键单击图片 → 菜单仍显示「从画册移除」（第一版接受这点摩擦），点击后弹出 toast `"本地文件夹同步画册不可手动增删图片"` 并不执行。
   - 删除按钮 → confirm 文案变为「磁盘上的本地文件不会被删除」分支。

6. **Albums 列表行为**：
   - 列表页右键 local_folder album → "删除"菜单仍可见；点击后 confirm 用 local_folder 文案。

7. **回归**：
   - 普通画册的所有添加 / 移除 / 重排 / 收藏 / 删除流程不变。
   - `images-change` / `album-images-change` 事件路径未受影响。
   - Phase 1-4 的单测仍通过；新增 cargo 单测可选：直接在 `commands_core/album.rs` 加一个 `#[tokio::test]` 验证四个写命令对 local_folder album 返回 Err（需要 storage 注入 / global，留 TODO；手工冒烟优先）。

---

## 不做的事（明确边界）

- **不**给 `rename_album` / `move_album` / `update_album_images_order` 加守卫——三者对 local_folder album 开放。
- **不**改 sync 内部的写入路径（`import.rs` / `sync.rs`）。
- **不**改右键菜单 `imageActions.ts` 的过滤入参（接受第一版菜单仍显示但点击拦截的 UX 摩擦）。
- **不**给 AlbumCard 加拖拽拒绝（不存在拖入卡片的 UX；FileDropOverlay 是全局，不针对某个卡片）。
- **不**做 HOME 路径 `~/` 替换（按用户后续反馈再加）。
- **不**接入手动刷新触发 sync（Phase 6）。
- **不**实现实时监听（Phase 7）。
- **不**翻译 `ja` / `ko` / `zhtw` 的新 key（用 en 占位 + TODO）。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| sync 内部某条路径**意外**走了 `add_images_to_album_with_event` 包装，被 guard 自伤 | sync 报 `read-only`，启动期日志中能看到 | 单测：在 Phase 2 tests.rs 上加 `assert sync_album succeeds for local_folder album` 的回归（应已有）。Phase 5 实施时 grep `add_images_to_album_with_event\|remove_images_from_album_with_event` 在 `kabegame_core/src/local_folder/` 应**零命中** |
| 守卫漏掉某个 MCP / Web RPC 命令 | 用户能从该渠道写 local_folder album | grep 自检：`add_images_to_album` / `remove_images_from_album` / `add_task_images_to_album` 在 [src-tauri/kabegame/src](../../src-tauri/kabegame/src) 三个入口（lib.rs handler / mcp_server.rs / web/dispatch.rs）都被 guard 覆盖（commands_core 共享）；MCP 例外直接调 Storage，本 Phase 显式补上 |
| `ensure_album_is_writable` 每次写都查一次 SQL | 性能 | 单行 PK 查询无可观开销；album 数 < 数千，无需 caching |
| `title-local-folder` 紫色渐变在浅色卡片背景上对比度不足 | 视觉可读性 | `linear-gradient(135deg, #a78bfa, #7c3aed)` 在 `#fef7ff~#f0f7ff` 浅紫卡上对比度 > 4:1（手工肉眼检查）；如果用户反馈不清，可加 `font-weight: 800` 或外阴影深一点。第一版用上面方案 |
| `folderStatusTooltip` 在 `state==='ok'` 时不渲染 dot，但状态从 missing 变回 ok 时缓存未刷新 | 用户看到僵尸红点 | folderStatus 是 Album 字段；emit_album_changed 后 store 更新 album 引用→computed 自动重算。但需要确认 Phase 2/3 是否实际派发 `album-changed` 事件——若仅靠 `album-images-change`，UI 不会重读 albums。**实施时核对** [emitter.rs](../../src-tauri/kabegame-core/src/emitter.rs) 与 store 的事件订阅；如未对接，Phase 5 末尾加一行让 store 在 `album-changed` 中 reload 单个 album |
| 用户右键 `remove` 仍点击触发 toast，体验摩擦 | 非阻断，但讨厌 | 接受第一版；下次迭代允许 createImageActions 接 hide list |
| ja / ko / zhtw 未翻译 | 这三种语言下显示英文 | 标注 TODO；不阻断本 Phase 合并 |
| `albumStore.localFolderAlbumIds` 在 albums 大量变化时频繁重算 | 性能可接受 | computed 已经依赖 albums.value；只在 album 增删改时重算。无需 memoization |
| 删除 local_folder album 后该 album 下 reimport 引用的 images 残留 | 数据残留 | 已确认行为：磁盘文件归用户所有，images 行用 hard-delete?——不，根计划决策 4：删 album 时**不**删 images 本体。images 行残留在画廊中可被用户独立删除 |

---

## 关键 grep 自检

完成后跑：

```bash
# 命令层 guard 覆盖 4 处
rg -n "ensure_album_is_writable" src-tauri

# image_events 内 2 处
rg -n "ensure_album_is_writable" src-tauri/kabegame-core/src/storage/image_events.rs

# sync 路径 0 命中（确保不自伤）
rg -n "add_images_to_album_with_event|remove_images_from_album_with_event" src-tauri/kabegame-core/src/local_folder

# 前端 isLocalFolder / localFolderAlbumIds 引用收口
rg -n "isLocalFolder|localFolderAlbumIds|isLocalFolderAlbum" apps/kabegame/src

# i18n 5 处文件都加了新 key
rg -n "deleteLocalFolderAlbumConfirm" packages/i18n/src/locales
```

---

## 关键参考定位

- [`Storage::ensure_album_exists` 风格](../../src-tauri/kabegame-core/src/storage/albums.rs#L73) — 同款 SQL 查询模板。
- [`commands_core/album::add_images_to_album`](../../src-tauri/kabegame/src/commands_core/album.rs#L62) — 守卫插入点。
- [`mcp_server.rs::add_images_to_album` 分支](../../src-tauri/kabegame/src/mcp_server.rs#L615) — 直接调 Storage，必须单独补。
- [`AlbumCard.vue` meta 行](../../apps/kabegame/src/components/albums/AlbumCard.vue#L30) — 视觉改造主体。
- [`AddToAlbumDialog.vue::getAlbumTreeExcluding`](../../apps/kabegame/src/components/AddToAlbumDialog.vue#L62) — 排除列表追加点。
- [`AlbumDetail.vue::handleImageMenuCommand "remove"`](../../apps/kabegame/src/views/AlbumDetail.vue#L1118) — 早返插入点。
- [`AlbumDetail.vue` delete confirm](../../apps/kabegame/src/views/AlbumDetail.vue#L583) — 文案分支。
- [`Albums.vue` delete confirm](../../apps/kabegame/src/views/Albums.vue#L740) — 同上。
