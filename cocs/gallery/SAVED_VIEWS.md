# 收藏视图（Saved Views）

查询行（`GalleryQueryBar`）右端的 ⋯ 视图菜单只有两样东西：「用当前视图轮播壁纸」（仅桌面），以及它下面的「收藏的视图」。原来这里的 chip 显隐开关已删除：工具条上的 chip 始终显示，8 个 `galleryChip*` 设置作废，由本地迁移清键。

「收藏的视图」让用户把常用的「过滤 + 排序」组合存下来，点一下就切回去。画廊、画册详情、任务详情、畅游详情共用这一套。

## 数据模型

纯前端，存在 Dexie 库 `kbg-saved-views` 的 `views` 表（`apps/kabegame/src/services/savedViews.ts`），所有平台都用（不是缓存，不像 metadata 缓存那样只在 web 落库）。数据随 CEF / WebView 的 profile 走，和 localStorage 里的前端偏好同样耐久：清掉 profile 就会丢。

```ts
interface SavedView {
  id?: number;
  source: "gallery" | "album" | "task" | "surf"; // = ImageGrid adapter 的 id
  path: string;        // 查询体
  name: string | null; // null = 用 path 作名字
  createdAt: number;
  lastUsedAt: number;
}
// 索引：++id, &[source+path], source
```

- **查询体**：`savedViewBody(query, sort)` = `buildComposablePath({ query, sort, omitRandomSeed: true })`。只有过滤与排序，不带 `album/<id>` / `task/<id>` / `surf/<host>` 根前缀，也不带 `hide/`、`no-album` 与分页尾。所以**同一来源的收藏在所有画册 / 任务 / 站点通用**：在 A 画册存的视图，B 画册里也能用。
- **随机排序**：存成不带种子的 `sort/random`（`omitRandomSeed`），同一视图两次构建结果相同；应用时由 `parseSavedViewBody` 现生成种子，每次应用都是一次新洗牌。
- **名字**：`name` 为空时显示 `path`。「不命名就用路径作名字」不另存一份，用当前视图更新后名字跟着新路径变。
- **唯一性**（同一来源内）：
  - `path` 唯一，由 `&[source+path]` 索引保证；
  - 显示名唯一：不分大小写，路径默认名与用户起的名字放在一起比，也不能把名字起成别的收藏的路径。由写入事务里的 `findNameConflict` 保证，界面上先用快照判一遍并实时标红。
- 纯函数在 `apps/kabegame/src/utils/savedViews.ts`（有单测），Dexie 层只做读写与事务内查重。

## 来源

ImageGrid 把视图上下文注入给插槽里的查询行（`components/imageGrid/gridViewPath.ts` 的 `gridViewKey`）：

```ts
interface GridViewContext {
  path: Readonly<Ref<string>>;                 // 当前视图路径（用当前视图轮播）
  source: GridAdapterId;                       // 收藏视图的来源
  pathFor: (patch: GalleryQueryPatch) => string; // route store 的 computePath，不导航
}
```

各页不用传任何 props。查询行不在 ImageGrid 插槽里时，没有收藏区。web 也有收藏区；轮播动作只在桌面端有。

## 排序与「使用」

- ⋯ 面板打开（`KbFilterDropdown` 的 `open`）时读一次本来源全部行，按 `lastUsedAt` 降序排好，作为本次打开的快照。**打开期间顺序冻结**，也不监听库。
- 点一行**只是应用**：查询行发 `navigate({ query, sort }, { push: true })`，记下「本次最后应用的 id」，不改顺序、不收起面板。打开期间来回切多次都不写库。
- 面板收起（`close`）或组件卸载时，只给本次最后应用的那条写 `lastUsedAt = now`。下次打开时它排到最前。
- 新收藏的 `lastUsedAt` = 收藏时间，插到快照最前。编辑（改名 / 更新）不算使用。

## 界面

- **标题行**：「收藏的视图」，右侧显示「来源说明 · 条数」（画廊 / 所有画册共用 / 所有任务共用 / 所有站点共用）。
- **新增**：
  - 点「+ 收藏当前视图」，在原处展开命名输入框。placeholder 就是当前查询体；Enter 保存，Esc 取消，Esc 不会冒泡关掉面板。
  - 当前视图已收藏时，这一行换成「当前视图已收藏为「X」」，点它让那一行闪一下。
- **行**：
  - 显示名字；没起名的行用等宽小字显示路径，悬停 title 也是路径。
  - 当前视图那一行左侧有粉色竖条。
  - 轮播来源那一行有 ↻：轮播开着，且 `viewRotationPath(pathFor(...))` 与任一活跃壁纸目标的轮播路径（`useActiveWallpaperRotationPaths()`，见 [壁纸轮播](../wallpaper/ROTATION_PATHQL.md)）相同即是。随机排序的行跳过，因为种子不可比。
  - 编辑、× 两个按钮悬停才出现；紧凑档常显，正在编辑或确认的那一行也常显。
- **移除**：× 弹出与任务抽屉「停止任务」同款的 `el-popconfirm`（`bottom-end`、`danger`，按钮为确认 / 取消）。受控，同一时刻只开一个，接 `useModalBack`。
- **编辑**（`SavedViewEditor`）：
  - 名称输入框：留空即用路径。
  - 「用当前视图更新」：
    - 与当前相同时置灰；
    - 当前视图已被别的收藏占用时，红字提示是哪一条；
    - 否则点了进入预览：组合切到当前视图，相对原组合新增的条件画粉底，原有而没有的列进「将移除」，再点撤销。
  - 底部只有「确定 / 取消」，确定才写库。
- **组合展示**（`SavedViewCombination` / `SavedViewQueryTree`，只读）：
  - 排序两颗；随机排序不出方向。
  - 简单 chip，另起一行「其余维度：任意」。
  - 高级条件：顶层序列与 `is` 原子内用「且」；`any` 画成框、分支之间用「或」；`not` 画成带「非」的虚线框。
  - PathQL 路径，可复制。
  - 差异对比把整棵查询摊平成「维度 + 取值」的键集合，不分位置。
  - 不复用高级查询的条件行组件：它们没有只读档，删除、取非、+ 条件都是常驻渲染的。

## 嵌套弹层与 `clickOutsideIgnore`

⋯ 面板是 `el-tooltip`，打开时用 vueuse `onClickOutside` 点外部关闭。编辑浮层（`el-popover`，`virtual-ref` 锚在行上、`left-start`）和移除确认（`el-popconfirm`）都 teleport 到 body，点它们原本算「外部」，会连带关掉面板。

做法是给 vendored 组件库补两个口子，见 `packages/kabegame-element-plus/README.md`：

- tooltip 内容组件的 `clickOutsideIgnore`（CSS 选择器数组，透传给 `onClickOutside` 的 `ignore`），`KbFilterDropdown` 透传同名 prop；
- popconfirm 可追加的 `popperClass`。

查询行给 ⋯ 面板传 `[".kb-saved-view-layer"]`，两个子层的 popper 都挂这个类（`savedViews/savedViewLayer.ts`）。

不用 `:teleported="false"`：编辑浮层锚在可滚动列表的行上，不 teleport 会被裁掉。

**紧凑档（Android）**：⋯ 面板本身是居中 `el-dialog`，没有点外部关闭。编辑改为叠加的 `el-dialog`，确认框与桌面相同，都接 `useModalBack`，返回键先关子层。

## 画廊不再恢复上次浏览路径

桌面端 `gallery-path` 原先是 `frontendLocal`（localStorage），`galleryRoute` 还自己读写另一份 `kabegame-gallery-path`，重启后会回到上次的过滤与排序。现在这两条都去掉了：

- `gallery-path` 全平台注册为 `query("gallery-path", "path")`，与任务 / 畅游详情相同；
- `galleryRoute` 的 `defaultState` 固定为空查询加默认排序（桌面 `by-id`，web 是会话内固定种子的随机）；
- `localSettingsMigrations` 删除两个旧键。

会话内从侧栏回到画廊，经 `useActiveRoute` 的 `lastGalleryRoute`（带 query 的完整地址）仍回到原视图；重启后是默认视图。常用视图改用收藏视图保存。

连带修正：`gallery-path` 走 query 后，参数名 `path` 与任务 / 畅游详情共用。所以在非画廊页点详情里的画廊过滤链接（`ImageGrid.handleOpenGalleryFilter`），改为 `router.push({ path: "/gallery", query: { path: computePath(...) } })`，不再直接写到当前页 query 上冲掉本页路径。

## 涉及文件

- `apps/kabegame/src/components/gallery/GalleryQueryBar.vue`
- `apps/kabegame/src/components/gallery/savedViews/`（`SavedViewsSection.vue`、`SavedViewEditor.vue`、`SavedViewCombination.vue`、`SavedViewQueryTree.vue`、`SavedViewPill.vue`、`savedViewPills.ts`、`savedViewLayer.ts`）
- `apps/kabegame/src/components/gallery/galleryChipIcons.ts`（查询行与组合展示共用的图标表）
- `apps/kabegame/src/utils/savedViews.ts`、`apps/kabegame/src/services/savedViews.ts`
- `apps/kabegame/src/components/imageGrid/gridViewPath.ts`、`components/ImageGrid.vue`、`components/imageGrid/types.ts`
- `apps/kabegame/src/utils/galleryPath.ts`（`omitRandomSeed`）
- `apps/kabegame/src/stores/galleryRoute.ts`、`stores/settings.ts`、`stores/settingsDescriptors.ts`、`stores/localSettingsMigrations.ts`
- `apps/docs/src/content/docs/guide/gallery.md`（用户文档「收藏视图」一节与截图 `saved-views.png`）
- `packages/kabegame-element-plus/src/components/{tooltip,kb-filter-dropdown,popconfirm}/src/*`
