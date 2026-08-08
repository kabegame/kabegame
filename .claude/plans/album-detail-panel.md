# 计划 C — 画册页右侧详情面板（设计稿 1b 第三栏）

## 实施状态：已落地 ✅（2026-08-08）

七个点全部实现，`vue-tsc` 0 error，并已在跑起来的 app 里经 CDP 实测（三栏几何、封面、
面包屑祖先链、统计卡、精简按钮、「⋯」复用右键菜单、双击开合）。

**与计划的偏差（3 处）**

1. **封面数据源换了，并且改回了历史上就在用的那条路**。计划写的
   `albumStore.loadAlbumPreview` → `invoke("get_album_preview")` **实测是坏的**：后端
   `album_preview_at`（`kabegame-core/src/providers/query.rs`）拼的路径
   `images://gallery/album/<id>/order/...` 里的 `order` 段在现行 DSL 里已不存在，调用直接抛
   `path not found: images://gallery/album/<id>/order`。
   查 git 历史印证了这点：画册卡片时代（`5f2fda11 fix: album preview` 之前就已如此）
   `Albums.vue` 的 `loadAlbumPreviewFromProvider()` 内部就是
   `loadAlbumMediaPreview(node, limit)`，**从来没走过那条 Tauri 命令**。所以现在也用
   `loadAlbumMediaPreview`（`utils/albumMediaTree.ts`，纯 pathql
   `gallery/album/<id>/sort/by-album-order/x1x/1`，自身没图时递归到子画册补齐），
   与子画册卡片预览同源。
   **遗留**：`get_album_preview` 这条 Tauri 命令是死代码且是坏的，本轮没动（属后端改动）。

   渲染侧同理参考了 AlbumCard：封面用 **`ImageContent` 而不是 `ImageItem`**，并显式
   `fit="cover"`（两者都默认 `contain`，横图会留上下灰边）。AlbumCard 当年为了压掉
   `ImageItem` 的边框/阴影/hover outline 写了一串 `:deep` 中和规则——静态封面不需要
   `ImageItem` 的选中/右键/视频控件那一整套，直接用底层的 `ImageContent` 就没有这些要中和的东西。
2. **新增「双击树行开合详情面板」**（实施中用户追加的需求）。为此给树基座补了一条
   `row-dblclick` 事件链：`KbTreeRow`（`@dblclick` → emit，与 click 同样受 `disabled` 门禁）
   → `KbTreePanel`（普通行与 sticky 行都转发）→ `AlbumTreePanel`（emit `dblclick(albumId)`）
   → `Albums.vue` `onTreeDblclick`（选中该画册 + `toggleDetailPanel()`）。
3. **`AlbumDetail.vue` 的「新建子画册」补了父级参数**。原 `openCreateSubAlbumDialog()` 硬编码建
   在当前画册下；新 action 要能对**子画册**建孙画册，故加 `createSubAlbumParentId` ref，
   `openCreateSubAlbumDialog(parentId?)` 默认仍是当前画册（既有调用点行为不变）。
   同理 `openVirtualDriveAlbumFolder` 抽出了收 id 的 `openVirtualDriveForAlbum(id)`。

**未验证**：紧凑模式（rtl 抽屉 + Android 返回键）——桌面端 `isCompact` 恒 false，
需在 Android 或 web 窄窗口下验。`openVirtualDrive` action 在本机因虚拟盘设置未开启而不可见
（门禁按预期生效），未实测点击效果。

## Context

计划 B 已把画册页做成两栏：左侧 `AlbumTreePanel`（248px，可拖宽/紧凑抽屉）+ 中栏
`ImageGrid`。设计稿 `exports/kabegame-albums-1b.html` 的第三栏（288px「画册信息」面板）还没做，
于是当前选中画册的元信息（封面、创建时间、类型、同步路径、轮播状态、图片/子画册计数）**在页面上完全不可见**，
而重命名 / 移动 / 新建子画册 / 删除 / 打开虚拟盘这些操作**只能通过树节点右键**触发——设计稿 ③ 指出的正是
「操作发现性」问题。本轮补上第三栏，并顺带把中栏顶部的祖先面包屑补回来（计划 B 下线整页跳转后，
用户失去了「我在树的哪一层」的文字线索；面包屑逻辑在 `AlbumDetail.vue` 里现成）。

用户已定的四个取舍：
1. 右栏 **可拖宽 + 可收起 + 紧凑模式转抽屉**（与左树、与 `ImagePreviewDialog` 右栏同款）。
2. 面板按钮**精简**：只留轮播 / 重命名 / 新建子画册，其余收进标题栏「⋯」——且「⋯」直接复用现有右键菜单那套 action 定义。
3. 封面**要**，用现成的 `get_album_preview`。
4. 面包屑**做**，复用 `AlbumDetail.vue` 的实现。

---

## 总体设计思路

**几何**：三栏仍然只有一个滚动容器。计划 B 已经把左树做成 core `ImageGrid` 的 `#aside`
（sticky 钉在页头下缘、偏移与高度由宿主经 CSS 变量给），右栏是它的**镜像**——因此不新建页面级
flex 容器，而是给 core `ImageGrid` 补一个对称的 `#aside-right` slot：`has-aside` 的判定从
「有左 slot」放宽为「有任一侧 slot」，body 行变成 `aside | main | aside-right`，已有的
`.image-grid-aside { position: sticky }` 规则同时覆盖两侧，宿主侧一个 `KbResizable side="left"`
就能接上（`ImagePreviewDialog` 已有右栏先例）。这样页头仍然全宽 sticky 在三栏之上，与设计稿一致。

**状态归属**：右栏是纯展示 + 派发组件。它的数据源是 Albums.vue 已有的**唯一选中真源**
`albumIdPath → selectedAlbumId → selectedAlbum`，不引入第二份选中态；宽度与开合两个 UI 偏好走
`useLocalStorage`（与 `kabegame-albums-tree-width` 同款，不进 settings 后端）。面板自身只
`emit("command", cmd)` 与 `emit("more", MouseEvent)`，所有副作用留在 Albums.vue。

**操作的单一定义**：不给面板另写一套操作。`createAlbumActions()` 是画册操作的唯一定义处，本轮给它
补 3 条现在缺失的（`createSubAlbum` / `openVirtualDrive` / `stopWallpaperRotation`），并给
`AlbumActionContext` 加一个 `albumDriveEnabled` 门禁字段。面板标题栏的「⋯」不自己渲染菜单，而是把
click 的 `MouseEvent` 抛给宿主去 `albumMenu.show(selectedAlbum, event)`——**和右键菜单同一个
`ActionRenderer` 实例、同一份 actions、同一个 command handler**，桌面自动是 ContextMenu、紧凑自动是
ActionSheet。面板上那三个平铺按钮同样只是 `runAlbumCommand(cmd, album)` 的快捷入口，不重复实现逻辑。

**命令入口参数化**：现在 `handleAlbumMenuCommand` 隐式绑定右键目标（`albumMenuContext.value.target`）。
面板按钮作用于**选中画册**而非右键目标，所以把它改成 `runAlbumCommand(command, album)` 显式收画册参数
（右键路径传 `albumMenuContext.value.target`，面板路径传 `selectedAlbum`）。这是本轮唯一的既有逻辑重构，
不动任何一条分支的行为。

**扩 action 的连带成本（明确承担）**：`createAlbumActions()` 还被 `AlbumDetail.vue` 的子画册右键菜单消费，
所以那 3 条新 action 也会出现在那里。相应地要给 `AlbumDetail.vue` 补 `albumDriveEnabled` 上下文字段和
3 个命令分支——其中两个（打开虚拟盘、新建子画册）在该文件里**本来就有实现**，接上去即可。这是选「复用同一份
action 定义」必然带的成本，好过第三份复制。

---

## 现状锚点

**a. core `ImageGrid` 只有左 aside**（`packages/kabegame-core/src/components/image/ImageGrid.vue:1-21`）

```vue
<div ref="containerEl" class="image-grid-container" :class="[
    { 'has-aside': !!$slots.aside },      // 现状：只看左 slot
    ...]">
  <slot name="header" />
  <div class="image-grid-body">
    <aside v-if="$slots.aside" class="image-grid-aside">   <!-- 现状：只有一侧 -->
      <slot name="aside" />
    </aside>
    <div class="image-grid-main">
      <slot name="before-grid" />
```

sticky 规则（同文件 `:1470-1483`）已经是按类选的，天然覆盖两侧：

```scss
&.scrolls-whole-container {
  .image-grid-aside { position: sticky; top: var(--kb-image-grid-aside-top, 0px);
                      height: var(--kb-image-grid-aside-height, auto); }
  .image-grid-main { display: block; }
}
```

**b. Albums.vue 的左栏接法与选中真源**（`apps/kabegame/src/views/Albums.vue:30-44`、`:285-315`）

```vue
<template v-if="!isCompact" #aside>
  <KbResizable side="right" class="albums-tree-pane" v-model="treeWidth" :default-size="TREE_DEFAULT_WIDTH">
    <AlbumTreePanel :selected-id="selectedAlbumId" @select="onTreeSelect" ... />
  </KbResizable>
</template>
```
```ts
const selectedAlbumId = computed(() => lastAlbumIdOf(albumIdPath.value));      // 现状：唯一选中真源
const selectedAlbum  = computed<Album | null>(() => albums.value.find(a => a.id === selectedAlbumId.value) ?? null);
```

**c. 命令入口隐式绑右键目标**（`apps/kabegame/src/views/Albums.vue:636-651`）

```ts
const handleAlbumMenuCommand = async (command: "browse" | "delete" | ...) => {
  const context = albumMenuContext.value;
  const album = context.target;        // 现状：只能作用于右键目标
  if (!album) return;
  const { id, name } = album;
  albumMenu.hide();
```

**d. action 定义与上下文**（`apps/kabegame/src/actions/albumActions.ts:14-20`）

```ts
export interface AlbumActionContext extends ActionContext<Album> {
  currentRotationAlbumId: string | null;
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
  isLocalFolder: boolean;              // 现状：没有虚拟盘门禁字段
}
```
现有 7 条 action：`browse / syncNow(3 子项) / openLocalFolder / setWallpaperRotation / rename / moveTo / delete`
（`:26-119`）。**没有**新建子画册、打开虚拟盘、停止轮播。

**e. 封面 API 现成但闲置**（`apps/kabegame/src/stores/albums.ts:623-632`）

```ts
const loadAlbumPreview = async (albumId: string, limit = 6) =>
  invoke<ImageInfo[]>("get_album_preview", { albumId, limit });   // 现状：后端已递归到子画册补图，前端零调用点
```

**f. 计数与轮播判定**（`apps/kabegame/src/stores/albums.ts:54-58`、`AlbumTreePanel.vue:223-228`）

```ts
export interface AlbumStats { directImageCount: number; imageCount: number; subAlbumCount: number; }
// 注意：subAlbumCount 是整棵子树的画册数，不是直接子级数
```
```ts
return !!settingsStore.values.wallpaperRotationEnabled
    && settingsStore.values.wallpaperRotationAlbumId === node.id;
```

**g. 面包屑现成实现**（`apps/kabegame/src/views/AlbumDetail.vue:404-419` 逻辑 + `:97-116` 模板 + `:1261-1293` 样式）

```ts
const albumAncestorCrumbs = computed((): { id: string; name: string }[] => {
  ... while (cur.parentId) { const p = map.get(cur.parentId); up.push({ id: p.id, name: p.name }); cur = p; }
  up.reverse(); return up;              // 现状：根→直接父级，不含当前画册
});
```

---

## 点 1 — core `ImageGrid` 补对称的右栏 slot（`packages/kabegame-core/src/components/image/ImageGrid.vue`）

- **修改**
  - `has-aside` 判定放宽为任一侧存在。
  - `.image-grid-main` 之后补一个 `<aside class="image-grid-aside image-grid-aside--end">`。
    > 说明：sticky/flex 规则按 `.image-grid-aside` 选择，新列自动继承，无需新 CSS 分支。

```vue
<div ref="containerEl" class="image-grid-container" :class="[
    { 'has-aside': !!$slots.aside || !!$slots['aside-right'] },   // 修改
    ...]">
  <div class="image-grid-body">
    <aside v-if="$slots.aside" class="image-grid-aside"><slot name="aside" /></aside>
    <div class="image-grid-main"> ... </div>
    <!-- 新增：右侧列（画册信息面板），与左列共享 sticky 契约 -->
    <aside v-if="$slots['aside-right']" class="image-grid-aside image-grid-aside--end">
      <slot name="aside-right" />
    </aside>
  </div>
```

- **修改**（`apps/kabegame/src/components/ImageGrid.vue:20-22` 旁）
  - 按需透传新 slot（**必须带 `v-if`**，无条件声明会让 core 误判而切多栏布局——文件里已有这条注释）。

```vue
<template v-if="$slots['aside-right']" #aside-right>
  <slot name="aside-right" />
</template>
```

## 点 2 — 新组件 `AlbumDetailPanel.vue`（`apps/kabegame/src/components/albums/AlbumDetailPanel.vue`）

- **新增**：纯展示 + 派发，无副作用。

  - props：`album: Album | null`、`isHidden: boolean`、`stats: { imageCount: number; subAlbumCount: number }`、
    `isRotating: boolean`、`canCreateSubAlbum: boolean`、`canRename: boolean`。
  - emits：`close`、`more: [MouseEvent]`、`command: [AlbumPanelCommand]`
    （`"setWallpaperRotation" | "stopWallpaperRotation" | "rename" | "createSubAlbum" | "syncNow"`）。
  - 结构（自上而下，视觉照抄设计稿 + 复用 `AlbumTreePanel` 标题栏样式）：
    1. **标题栏**：`t("albums.detailPanelTitle")` + flex-1 + 「⋯」按钮（`MoreFilled`，`@click="emit('more', $event)"`，
       隐藏画册时不渲染）+ 关闭「✕」（`Close`）。按钮样式复用 `AlbumTreePanel.vue:345-365` 的 `.album-tree-menu-btn` 同款。
    2. **封面**：150px 高、radius 12。`<ImageContent :image="cover" prefer="thumbnail" fit="cover" />`
       （`@kabegame/core/components/image/ImageContent.vue`）。无图时占位（沿用 `/album-empty.png`）。
    3. **标题块**：画册名（16px bold，隐藏画册显示 `t("albums.hiddenAlbumName")`）；副行
       `t("albums.createdAtPrefix")` + 类型（手动画册 / 本地文件夹）；`local_folder` 追加 `syncFolder`
       路径（单行 truncate + `title`），`folderStatus` 异常时红点 + `t("albums.treeFolderStatusTooltip")`。
    4. **轮播胶囊**：`isRotating` 时显示渐变 badge（`Monitor` 图标 + `t("albums.detailRotatingBadge")`）。
    5. **统计卡 ×2**：图片 = `stats.imageCount`（含子孙，同树上的计数口径）/ 子画册 = `stats.subAlbumCount`。
    6. **按钮区（精简）**：主按钮 = 开始/停止桌面轮播（渐变，按 `isRotating` 切文案与 command）；
       次按钮 2 列 = 重命名 / 新建子画册（`local_folder` 时第二格换成「立即同步」，因为其子册由磁盘决定）。
  - `album === null` 时渲染空态提示 `t("albums.detailPanelEmpty")`。

> 不在面板内做：移动到… / 打开虚拟盘 / 打开本地文件夹 / 递归同步 / 删除 —— 全部走「⋯」。

## 点 3 — 扩 action 定义（`apps/kabegame/src/actions/albumActions.ts`）

- **修改**
  - `AlbumActionContext` 增加 `albumDriveEnabled: boolean`。

```ts
export interface AlbumActionContext extends ActionContext<Album> {
  ...
  isLocalFolder: boolean;
  albumDriveEnabled: boolean;   // 新增：虚拟盘门禁（宿主已各自算好，见 Albums.vue:375 / AlbumDetail.vue:349）
}
```

- **新增** 3 条 action（图标从 `@kabegame/element-plus-icons` 取 `FolderAdd` / `Monitor` / `VideoPause` 一类现有图标）
  - `createSubAlbum`（`command: "createSubAlbum"`）：`visible = !isHidden && !isLocalFolder`
    （隐藏画册与本地文件夹画册不能手建子册；收藏画册**允许**，与 `AlbumDetailPageHeader` 的屏蔽规则一致的部分另见下注）。
    > 注：`AlbumDetailPageHeader.vue:129-143` 对收藏画册也屏蔽了 CreateAlbum；本 action 沿用该口径，
    > 即 `visible = target.id !== favoriteAlbumId && !isHidden && !isLocalFolder`。
  - `openVirtualDrive`（`command: "openVirtualDrive"`）：`visible = albumDriveEnabled && !isHidden`。
  - `stopWallpaperRotation`（`command: "stopWallpaperRotation"`）：
    `visible = wallpaperRotationEnabled && currentRotationAlbumId === target.id`，
    并把既有 `setWallpaperRotation` 的 `visible` 补上「当前不是轮播画册」以免两条并存。
    > 说明：`setWallpaperRotation` 现有的 `suffix`「（已设置）」随之失去意义，删掉 suffix 分支。

## 点 4 — Albums.vue 接线（`apps/kabegame/src/views/Albums.vue`）

- **新增**：右栏状态
```ts
const DETAIL_DEFAULT_WIDTH = 288;
const detailWidth = useLocalStorage("kabegame-albums-detail-width", DETAIL_DEFAULT_WIDTH, { mergeDefaults: true });
const detailOpen  = useLocalStorage("kabegame-albums-detail-open", true, { mergeDefaults: true });
const detailDrawer = useModal();                         // 紧凑模式抽屉
const albumCover = ref<ImageInfo | null>(null);          // 封面（按选中画册取 1 张）
```
  封面加载：`watch([selectedAlbumId, () => albumStore.getAlbumCounts(false)[selectedAlbumId.value]], …)`
  → `albumStore.loadAlbumPreview(id, 1)`，带 id 校验丢弃过期响应。

- **新增**：模板右栏 + 紧凑抽屉
```vue
<template v-if="!isCompact && detailOpen" #aside-right>
  <KbResizable side="left" class="albums-detail-pane" v-model="detailWidth" :default-size="DETAIL_DEFAULT_WIDTH">
    <AlbumDetailPanel v-bind="detailPanelProps" @close="detailOpen = false"
      @more="(e) => selectedAlbum && albumMenu.show(selectedAlbum, e)"
      @command="(cmd) => runAlbumCommand(cmd, selectedAlbum)" />
  </KbResizable>
</template>
```
  紧凑：`<el-drawer v-if="isCompact" direction="rtl" size="min(85vw, 340px)" :with-header="false" …>` 内放同一组件
  （四件套 `:model-value` / `:z-index` / `@update:model-value` 与左树抽屉一致）。

- **修改**：命令入口参数化
```ts
const runAlbumCommand = async (command: AlbumCommand, album: Album | null) => {   // 修改：显式收画册
  if (!album) return;
  const { id, name } = album;
  albumMenu.hide();
  ...                                    // 既有分支原样保留
  if (command === "createSubAlbum") { openCreateDialogWithParent(id); return; }             // 新增
  if (command === "openVirtualDrive") { await invoke("open_album_virtual_drive_folder", { albumId: id }); return; }  // 新增
  if (command === "stopWallpaperRotation") { await setWallpaperRotationEnabled(false); ... } // 新增
};
```
  `ActionRenderer` 的 `@command` 改为 `runAlbumCommand(cmd, albumMenuContext.value.target)`。

- **修改**：`albumMenuContext` 补 `albumDriveEnabled: albumDriveEnabled.value`。

- **新增**：中栏面包屑（`#before-grid` 内、`GalleryQueryBar` 之上）
  - 逻辑照抄 `AlbumDetail.vue:404-419` 的 `albumAncestorCrumbs`（按 `parentId` 上溯），
    但**链接改为 `@click="selectAlbum(crumb.id)"` 而非 router-link**（本页不再整页跳转），
    且不渲染指向自身的「画册」根节点。
  - 末段：当前画册名 + `· N 张 · M 个子画册`（数据同右栏统计卡）。
  - 样式照搬 `AlbumDetail.vue:1261-1293` 的 `.album-breadcrumb-wrap`。
  - `GalleryQueryBar` 的 `hug-top` 移到面包屑上（面包屑成为紧贴页头的第一行）。

- **修改**：样式
  - 新增 `.albums-detail-pane`（对称于 `.albums-tree-pane`）：
    `--kb-resizable-min: 240px; --kb-resizable-max: min(420px, 40vw); flex: 0 0 var(--kb-resizable-clamped);`
    `border-left: 1px solid var(--anime-border, …)`。
  - `has-aside .image-grid-main` 的 padding 补右侧：右栏开启时 `padding: 0 20px 12px 20px`
    （用 `:class="{ 'has-detail': !isCompact && detailOpen }"` 挂在 `.albums-grid-body` 上区分）。

## 点 5 — 头部开关（3 个文件）

- **新增** `packages/kabegame-core/src/stores/header.ts`：`AlbumInfo = "albumInfo"` 枚举项（紧挨 `AlbumTree`）。
- **新增** `apps/kabegame/src/header/headerFeatures.ts`：
  `{ id: HeaderFeatureId.AlbumInfo, label: t("header.albumInfo"), icon: InfoFilled }`。
- **修改** `apps/kabegame/src/components/header/AlbumsPageHeader.vue`：
  - `showIds`：紧凑 = `[AlbumTree, AlbumInfo, TaskDrawer]`；桌面 = 现有列表前插 `AlbumInfo`。
  - `handleAction` 增加 `case AlbumInfo: emit("toggle-detail")`。
  - Albums.vue 侧：桌面 `detailOpen = !detailOpen`，紧凑 `detailDrawer.open()`。

## 点 6 — AlbumDetail.vue 补齐（`apps/kabegame/src/views/AlbumDetail.vue`）

- **修改**
  - `childAlbumMenuContext`（`:432-444`）补 `albumDriveEnabled: albumDriveEnabled.value`。
  - `handleChildAlbumMenuCommand` 的 command 联合类型与分支补 3 条：
    `createSubAlbum` → 现有 `openCreateSubAlbumDialog`（需支持指定父画册 id）；
    `openVirtualDrive` → 现有 `openVirtualDriveAlbumFolder(id)`；
    `stopWallpaperRotation` → `setWallpaperRotationEnabled(false)`。
    > 说明：不改该页任何既有行为，只是让新 action 在子画册右键里也能落地。

## 点 7 — i18n（`packages/kabegame-i18n/src/locales/{zh,en,ja,ko,zhtw}/`）

- **新增** `albums.json`：`detailPanelTitle`（画册信息）、`detailPanelEmpty`、`detailRotatingBadge`（桌面轮播中）、
  `detailStartRotation`（设为桌面轮播）、`detailStopRotation`（停止桌面轮播）、`detailManualAlbum`（手动画册）、
  `detailLocalFolderAlbum`（本地文件夹）、`detailCrumbStats`（`· {images} 张 · {subAlbums} 个子画册`）。
- **新增** `header.json`：`albumInfo`（画册信息）。
- **新增** `contextMenu.json`（或既有归属文件）：`createSubAlbum`、`openVirtualDrive`、`stopWallpaperRotation`。
- **复用不新增**：`albums.createdAtPrefix`、`albums.hiddenAlbumName`、`albums.subAlbums`、`albums.imagesTab`、
  `albums.treeFolderStatusTooltip`、`common.delete`。

---

## 不在本轮范围

- 页头副标题「18 个画册 · 4,206 张」（设计稿有，当前 i18n/代码里都不存在，属另一处改动）。
- 「清空隐藏画册」入口——已在全局工具 `HiddenCleanupControl`，不搬进右栏。
- `AlbumDetail.vue` 整页的最终去留（设计稿 ② 暗示它会退役，但本轮只做兼容性补齐）。
- 画廊页复用右栏（core slot 已具备条件，但本轮不接）。

## 验证

1. `.claude/skills/check-kabegame/driver.sh --skip cargo`（本轮零 Rust 改动，vue-tsc 必须 0 error）。
2. `deno task dev -c kabegame`，桌面端逐项确认：
   - 三栏几何：页头全宽，左树/右栏同高且随滚动 sticky，中栏图片能滚到页头下方；
   - 右栏拖宽（240–420 clamp）、双击把手复位 288、刷新后宽度与开合状态保持；
   - 头部「画册信息」按钮开/关右栏；
   - 依次选中 收藏 / 普通画册 / 有子册的画册 / 本地文件夹画册 / 垃圾桶，核对封面、创建时间、类型、
     同步路径与状态红点、统计卡数字（与左树计数一致）、按钮集合的显隐；
   - 面板三按钮：设为轮播 →（badge 出现、左树 Monitor 图标同步）→ 停止轮播；重命名；新建子画册；
   - 「⋯」弹出的菜单与树上右键**完全一致**，其中 移动到… / 打开虚拟盘 / 删除 / 递归同步 均生效；
   - 面包屑：多层子画册下祖先链正确，点击祖先切换选中且中栏刷新。
3. 窄窗口（<768px）/ Android：右栏消失，头部按钮改为拉出 rtl 抽屉；Android 返回键能逐层关闭抽屉
   （`useModal` 已接 modalStack）。
4. 回归：`AlbumDetail.vue` 子画册右键菜单新增的三项可用，既有项行为不变。
5. 可选：用 `kabegame-chromium` skill 连上跑起来的 app 截图比对设计稿。
