# 画册页第一步：左侧画册树侧栏 + 页内三栏骨架 + 文件夹画册新规则

> **实施状态（2026-08-07）**：全部落地。后端点 1–6 由 codex 实施（v029/rechain/守卫/sync/i18n，单测 v029 5/5、rechain 8/8、local_folder 19/19、albums 5/5 全过；额外偏离：重挂时名称与 parent_id 同一条 UPDATE 原子写、删除了未再使用的 `SyncDirCtx.album_name`、v028 测试断言改 `LATEST_VERSION`）。前端点 7 与 10a/10b 及 `AlbumTreePanel.vue`/`useAlbumIdPathState.ts` 由 sonnet 实施（其中 pathRoute 增加了 `queryBuild` 钩子、albumDetailRoute 的 state 移除 albumId 字段改由 albumIdPath 派生、AlbumDetail 的 initAlbum 增加 isAlbumSwitch 参数区分深链与换画册）；Albums.vue 三栏重写、header 三件套（HeaderFeatureId.AlbumTree）、紧凑抽屉、i18n ×5 由主会话完成（额外偏离：树右键改名走 ElMessageBox.prompt、trackAlbumEnter source 改为 "tree" | "context_menu"、轮播图标用 Monitor）。vue-tsc 与 cargo check 0 error。UI 运行时验证（三栏/拖宽/DnD/深链/抽屉/迁移实库）待用户跑 app。
>
> **后续调整（2026-08-07/08，用户指示「用 slot 把画册列表放在 ImageGrid 左侧」+「和 Gallery 一样」）**：三栏骨架从「Albums.vue 里 KbResizable 与 ImageGrid 平级」改为 **slot 内嵌**——core `ImageGrid.vue` 新增 `#aside`（左列）slot：无 aside 时新包装层 `image-grid-body`/`image-grid-main` 为 `display: contents`（既有页面布局零变化）；有 aside 时 body 行 = aside 列 + 中栏，`scrollWholeContainer` 的滚动容器从外层容器切到中栏 `image-grid-main`（`scrollEl` 按 `asideEl` 存在性解析，before-grid 的 sticky 上下文随之落中栏）。app 包装层按需透传 header/aside（无条件声明会误触发多栏布局）。**最终形态（用户拍板「侧边栏也用 sticky、排在 header 下面」）**：单滚动容器（外层容器，与 Gallery 同一套 sticky 体系），core 提供 `#header`（滚动流内全宽区，必须是容器直接子元素——包短容器会让 sticky 失去移动空间）与 `#aside`（body 行左列，`scrolls-whole-container` 下自身 `position: sticky`，偏移/高度由宿主经 `--kb-image-grid-aside-top/height` 变量给定）。Albums.vue：AlbumsPageHeader 进 `#header`（sticky top:0 全宽钉顶）；树列进 `#aside` 排在页头之下（sticky top:64、高 calc(100vh−84px)）；`#before-grid` = GalleryQueryBar（hug-top，滚走）→ GalleryBigPaginator（sticky top:64）→ 图片流；图片滚到页头下方。`scrollEl` 不再按 aside 切换（曾有的「中栏接管滚动」机制已回退删除）。顺带修了 core `stepSmoothWheel` 的量化不收敛 bug（lerp 步长被设备像素量化吃掉 → rAF 永动并把外部滚动拽回目标；终止条件加「读回无进展即结束」护栏）。树面板：空分区连同分隔线/标题隐藏（useTreeModel 由仅过滤时改为恒定）、系统区与普通树间补分隔线、行区左右内缩 8px 成圆角胶囊高亮（sticky 行同步 inset）。

> 配套关系：本计划（计划 B）消费 [tree-panel-refactor.md](tree-panel-refactor.md)（计划 A，**已实施**）产出的树基座 `apps/kabegame/src/components/tree/`。设计稿：仓库根 `画册浏览页面布局优化.zip`（kabegame-albums-1b，三栏：左画册树 248px / 中图片流 / 右详情 288px）。本步只做左树 + 页内骨架；右栏详情面板、galleryFilterTree 相关不在本计划。
>
> 用户已拍板：页内三栏骨架（AlbumCard 网格与三张预览图本步下线）；宽度拖拽 + 节点拖拽都要（行 nowrap）；存量迁移=串联重挂+普通提顶层；同步子画册改纯目录名；紧凑模式左树收抽屉；默认选中=localStorage 记忆回落收藏、URL 深链优先。
>
> 注意：计划 A 明确「gallery 过滤树的计数不做右对齐」只约束旧树；**画册树是新 UI，按设计稿计数贴行右缘**（名称与计数之间 flex-1 spacer），两者不矛盾。

## 总体设计思路

**页面形态**：Albums.vue 从「卡片网格 + 跳转详情页」改为「常驻左树 + 页内切换中栏」的工作台。左栏 = `KbResizable`（宽度 localStorage 持久化，照 PluginDetailContent 的 flex 父级 + flex-none 模式）包新组件 `AlbumTreePanel`；中栏复用 AlbumDetail 图片分支的「ImageGrid(surface=album) + GalleryQueryBar + GalleryBigPaginator」。可行性根基是 `createAlbumDetailSurface` 的 `isActive`（`surfaces/album.ts:52-57`）对非 AlbumDetail 路由宽容——`route.params.albumId` 为空时只要求 `albumId()` 回调与 albumName 非空，同一 surface 在 `/albums` 上即可工作，数据路径、事件刷新、右键菜单全部免费获得。AlbumCard 网格与预览机器（albumPreviewImages/prefetch/隐藏 FAB）从 Albums.vue 整体下线（AlbumCard 组件文件保留，AlbumDetail 子画册 tab 仍用）。

**选中状态与路由**（按用户修订的设计）：`path` 与「当前画册」**职责分离**——`path`（settingKey `album-detail-path`）只存**图片集合的查询路径**（query/sort/page…），**去掉 `album/<id>` 前缀**避免与选中态不一致，查询时（computedPath / contextPrefix 等 pathql 出口）自动拼回 `album/<albumId>` 前缀；当前访问的画册另存为新设置键 **`albumIdPath`**，内容是**祖先 id 链**（与 `albums.ancestor_path` 同构，`/root-id/.../self-id/`，当前 albumId = 链末段）——存链而非单 id，删除回落可沿链上溯最近存活祖先、树的展开链恢复零查询。

两个键的后端策略：
- 当前画册：**不新增双后端机制**（用户明确），手写**两个独立设置项**——`albumIdPath`（query backend，深链入口）+ `albumIdPathLocal`（localStorage backend，记忆）。「读优先 query、写两者同步写」由消费侧的小 composable 实现（见点 10a），settings 机制零改动。
- `album-detail-path`：照 `gallery-path` 的现成模式**平台分化**——web = query（`?path=`），桌面/Android = localStorage（`frontendLocal`）。`pathRoute` 工厂经 `useSettingKeyState` 读写、对后端无感，store 零适配。

`/albums/:albumId`（AlbumDetail）路由保留兼容深链，但 `album-detail-path` 形态变化（无前缀）使 **AlbumDetail.vue 需要最小适配**（不再从 path 提取 albumId；albumId 一律来自 `route.params.albumId` 并回写 `albumIdPath`），不再承诺零改动。

**树基座消费**（基座 API 已定型，宿主自建模型）：`AlbumTreePanel` 调 `useTreeModel` 建三分区模型（系统画册区：收藏+垃圾桶恒平铺 / 普通画册树 / 「本地文件夹」小节：文件夹画册森林），数据全部是 `useAlbumStore` 的 computed 投影——store 的 `initEventListeners` 已对 `album-added/changed/deleted` 增量 patch，**树结构变化不用面板自己监听**（watch 投影数组 → `model.reload()` 按 key diff 保展开态）。计数（右对齐列）读 `albumStore` 的直接计数；**刷新事件参数化**：`refreshEvent` prop（`"album-images-change"`（默认）| `"images-change"`）决定 `useTreeRefreshHub` 的 sources / 或直接二选一 composable，兜底重拉计数。行装饰：轮播中图标（settings `wallpaperRotationAlbumId` 命中且 enabled）、folder_status 红点。DnD：面板只实现 `TreeDndController`（合法性 = 移动弹窗排除集 + 新类型规则；提交 = `albumStore.moveAlbum`），手势/浮影/悬停展开全在基座；落点只用 `inside`（树按 createdAt 排序、不支持手动排序，before/after 无意义），`target=null`（分区空白）= 移到顶层。

**后端新规则的承重决策**：文件夹画册的父子关系从「创建时人工指定」改为「由磁盘路径唯一决定」。核心是 `rechain_local_folder_albums`：**幂等全量重算**——对每个文件夹画册按 canonicalize（失败词法兜底）后的 sync_folder 求「最近祖先文件夹画册」重挂 parent_id。选全量而非增量的理由与 `rebuild_album_ancestor_paths` 相同（百~千级，全量换掉双向重挂的所有边界分支：导入新画册可能同时改变已有画册的父级，例 /A、/E 已成链 /A/E，再导 /C → /A/C/E）。add_local_folder_album、递归同步建出新子画册后、DB 迁移三处共用同一语义。守卫落在 storage 层（web dispatch 与 tauri command 是同一实现层的两个镜像，一处覆盖全部入口；命令签名不动 → dispatch.rs 与 ACL 零改动）。

**迁移顺序与撞名消解**（v029）：先提根普通画册 → 再重挂文件夹画册 → 最后剥名称前缀 → rebuild ancestor_path。顺序理由：改名的 CI 撞名检查必须对**最终**兄弟集合做，结构先落定、名称后收拾。迁移期磁盘可能离线（外接盘），迁移内「最近祖先」用**词法路径匹配**（`Path::starts_with` 组件边界，避免 /A/BC 误判 /A/B 后代），不 canonicalize；运行时 rechain 则 canon 优先、词法兜底（与 sync 的 existing map 键一致）。撞名统一 `name (2)`、`name (3)` 递增探测（CI 比较），保证迁移必然成功不回滚。

## 现状锚点

（除标注外均已在当前工作区亲自核对。）

**a. `add_album` 父级只查存在性**（`src-tauri/kabegame-core/src/storage/albums.rs:226-244`）

```rust
pub fn add_album(&self, name: &str, parent_id: Option<&str>) -> Result<Album, String> {
    let name_trimmed = validate_album_name(name)?;
    let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(pid) = parent_id {
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM albums WHERE id = ?1)", params![pid], |row| row.get(0))
            .map_err(|e| format!("Failed to verify parent album: {}", e))?;
        if !exists {
            return Err("父画册不存在".to_string());   // 现状：只查存在性，不查 type
        }
    }
    Self::ensure_album_name_unique_ci(&conn, name_trimmed, parent_id, None)?;
```

**b. `move_album` 只挡系统画册/环/重名**（`storage/albums.rs:917-977`）

```rust
pub fn move_album(&self, album_id: &str, new_parent_id: Option<&str>) -> Result<(), String> {
    if album_id == FAVORITE_ALBUM_ID || album_id == HIDDEN_ALBUM_ID { return Err("不能移动系统默认画册".to_string()); }
    if new_parent_id == Some(FAVORITE_ALBUM_ID) { /* ... */ }
    if new_parent_id == Some(HIDDEN_ALBUM_ID) { /* ... */ }
    if let Some(pid) = new_parent_id {
        // 现状：自身/存在性/递归 CTE 环检测；没有 local_folder 类型守卫
    }
    let album = self.get_album_by_id(album_id)?.ok_or_else(|| "画册不存在".to_string())?;  // :952，源画册在此才读
    // UPDATE parent_id → rebuild_album_ancestor_paths → emit album-changed { parentId }
```

**c. 同步命名与递归收尾**（`src-tauri/kabegame-core/src/local_folder/sync.rs:26,353,584-594`）

```rust
const NAME_SEPARATOR: &str = "-";                    // sync.rs:26
// on_enter_dir（:349-356）新子目录：
    let name = format!("{}{}{}", parent.album_name, NAME_SEPARATOR, enter.name);  // 现状：拼父名前缀
    let entry = build_entries_non_recursive(&name, dir_path, Some(&parent.album_id));
// 递归收尾（:584-593）：
    if recursive {
        let visited: HashSet<String> = hook.visited.iter().cloned().collect();
        report.synced_albums = visited.len();
        for id in storage.list_subtree_album_ids(album_id)? {
            if !visited.contains(&id) {
                persist_status(&id, &FolderStatus::now_missing());  // 现状：不过滤 type，
                report.failed += 1;                                  // 普通子画册会被误标 missing
            }
        }
    }
```
> 同步的 `existing` map 是**全局** canon(sync_folder)→Album（`:516-529`，`list_local_folder_albums()` 全量），撞已有画册按路径复用但**不重挂**（`:340-347`）。

**d. `add_local_folder_album` 接受任意父级**（`src-tauri/kabegame-core/src/commands/album.rs:99-200`）

```rust
pub async fn add_local_folder_album(
    name: String,
    parent_id: Option<String>,     // 现状：调用方可任意指定父级（含普通画册）
    sync_folder: String,
    recursive: bool,
) -> Result<Value, String> {
    ...
    if matches!(parent_id.as_deref(), Some(HIDDEN_ALBUM_ID) | Some(FAVORITE_ALBUM_ID)) {
        return Err(t!("albums.localFolderErrors.parentReadonly").to_string());   // 唯一的父级限制
    }
    ...绝对路径/根目录/目录性/VD 挂载点 forbidden_roots/duplicateSyncFolder 校验...
    // 只建**根画册**；子画册与文件由后台同步（递归/非递归）经扫描钩子按需产生。
    let root_entry = build_entries_non_recursive(name, sync_folder, parent_id.as_deref());
    let created = Storage::global().add_local_folder_albums_tx(std::slice::from_ref(&root_entry))?;
    tokio::spawn(async move { let _ = crate::local_folder::sync_album(&root_id, options).await; });
```

**e. 迁移注册模式**（`storage/migrations/mod.rs:160-171`；v028 为「BEGIN IMMEDIATE + 失败 ROLLBACK + 内联递归 CTE + 同文件单测（裸建表 + PRAGMA user_version）」的范本）

```rust
    Migration { version: 28, name: "album_ancestor_path", up: v028_album_ancestor_path::up },
];
pub const LATEST_VERSION: u32 = 28;   // 现状最新 v028
```
> 可复用件：`ensure_album_name_unique_ci`（:655，CI 撞名预检的最终裁判）、`rebuild_album_ancestor_paths`（:700，全表递归 CTE）、`find_child_album_by_name_ci`（:869）、`add_local_folder_albums_tx`（:778，批量建 + rebuild + emit album-added）、`list_local_folder_albums`（:763）。

**f. `AlbumTreeNode` 缺类型字段**（`packages/kabegame-core/src/types/album.ts:1-8`；`utils/albumTree.ts` 的 `buildAlbumTreeFromFlat` 以 `{ ...a, children: [] }` 展开建树，字段可自动透传）

```ts
export interface AlbumTreeNode {
  id: string; name: string; parentId: string | null; createdAt: number;
  children: AlbumTreeNode[];    // 现状：无 type / syncFolder / folderStatus
}
```

**g. Albums.vue 关键区**（`apps/kabegame/src/views/Albums.vue`，1009 行）

```
:2   .albums-page  v-pull-to-refresh + v-drag-file="dropZone"（拖入文件夹建同步画册，保留）
:8   AlbumsPageHeader @create-album="createDialog.open()"
:14-24  AlbumCard 网格（displayedAlbumRoots + albumPreviewImages + albumCardRefs）→ 本步下线
:38-97  新建画册 el-dialog（名称 + AlbumPickerField(createAlbumParentTree) + 同步文件夹 + 递归）→ 保留
:100-116 移动画册 el-dialog（moveAlbumTree）→ 保留（DnD 兜底）
:123-126 hidden-album-fab（openHiddenAlbum → push /albums/HIDDEN_ALBUM_ID）→ 下线（垃圾桶进树）
:241-246 moveAlbumTree = getAlbumTreeExcluding([自身+后代+FAVORITE+HIDDEN])   ← DnD 合法性同源
:325-360 displayedAlbumRoots/Nodes/Stats + createAlbumParentTree
:399-465 预览机器（albumPreviewImages/refreshAlbumPreview/useAlbumImagesChangeRefresh(waitMs:1000)）→ 下线
```

**h. 选中路由的既有机制**（`apps/kabegame/src/stores/albumDetailRoute.ts` + `views/AlbumDetail.vue:985-1013`）

```ts
// albumDetailRoute.ts：settingKey "album-detail-path"（现状：全平台 query backend，镜像 ?path=）
// parse: extractRootIdAndBody(path, "album") → { albumId, query, sort, page, pageSize }   // 现状：albumId 在 path 里
// build: buildComposablePath({ rootPrefix: `album/${state.albumId}`, ... })               // 现状：拼 album 前缀
// AlbumDetail 的初始化范式（改造点：不再从 path 提取/比对 albumId）：
const innerPath = qp.startsWith("hide/") ? qp.slice("hide/".length) : qp;
if (innerPath.startsWith(`album/${newAlbumId}/`)) {
  albumDetailRouteStore.syncFromUrl(qp);           // 深链采纳（保住过滤与页码）
} else {
  await albumDetailRouteStore.navigate({ albumId: newAlbumId, query: [], sort: { field: "by-album-order", desc: false }, page: 1 });
}
```

**h2. settings 后端机制现状**（`packages/kabegame-core/src/stores/settingsDescriptors.ts:224-273`、`stores/settings.ts`）

```ts
// gallery-path 的平台分化（album-detail-path 照此改造）：
if (!IS_WEB) {
  localEntries.push(frontendLocal("gallery-path", ""));   // 桌面/Android = localStorage
}
...
const queryEntries = [
  query("task-detail-path", "path"),
  query("surf-images-path", "path"),
  query("album-detail-path", "path"),    // 现状：全平台 query
];
if (IS_WEB) {
  queryEntries.push(query("gallery-path", "path"));       // web = query
}
```
> `settings.ts` 的 descriptor.backend 是单值（"tauri" | "localStorage" | "query" | "readonly"），初始化/watch/save 各 backend 一条路径（:230-262, :428-460）——**保持不动**（用户明确不新增双后端形态）；「优先 query 读、双写」由两个独立键 + 消费侧 composable 手写（点 10a）。`pathRoute.ts:105` 经 `useSettingKeyState(config.settingKey)` 读写，对 backend 无感。
> `albums.ancestor_path`（`storage/migrations/init.rs:102`）：`/root-id/.../self-id/` 格式的祖先 id 链，`albums://all` 已随行返回（Album serde → `ancestorPath`）——`albumIdPath` 的内容与之同构，前端可直接取存量字段（实施时核实 `stores/albums.ts` 的 Album 接口是否已带该字段，缺则补）。

**i. surface 跨路由可复用**（`apps/kabegame/src/components/imageGrid/surfaces/album.ts:52-57`）

```ts
isActive: () => {
  const cur = router.currentRoute.value;
  const routeAlbumId = typeof cur.params.albumId === "string" ? cur.params.albumId : "";
  const id = params.albumId();
  // /albums 上 routeAlbumId==""，条件退化为「有选中 id 且有名字」
  return !!id && (!routeAlbumId || routeAlbumId === id) && !!params.albumName();
},
```
> surface 自带 `imagesChange`/`albumImagesChange` 刷新（waitMs 1000）、`isLocalFolder` 只读拦截、`forceUnhide`（隐藏画册页）——中栏免费获得。

**j. 树基座实际 API**（计划 A 已落地，`apps/kabegame/src/components/tree/`）：宿主自建 `useTreeModel({ dataSource, sections, defaultExpanded, filterText, isRowHidden, onChildrenLoaded })` → `<KbTreePanel :model :dnd :row-state :row-click-toggles :get-row-label>` + `#row`/`#section-header` slot + `row-click`/`row-contextmenu` emit；`TreeSection{id, header?, separatorBefore?, roots}`；`TreeDndController{canDrag, getDragLabel?, onDragOver(source,target,sector)→boolean|{accept,position,autoExpand}, drop(source,target,position)}`（pointer 状态机在基座）；`useTreeRefreshHub({sources, enabled?}).register({waitMs,when,filter,onRefresh})`；sticky overlay 背景经 `--kb-tree-sticky-bg`/`--kb-tree-sticky-backdrop` 由宿主注入；行高恒 32px。**注意**：sections 数据变化需宿主 watch 后调 `model.reload()`（key diff 保展开态）。

**k. 侧栏宽度拖拽范本**（`packages/kabegame-core/src/components/plugin/PluginDetailContent.vue:235-243`）：`useLocalStorage("kabegame-plugin-detail-menu-width", DEFAULT, { mergeDefaults: true })` + KbResizable 契约（父 flex、自身 flex-none + `--kb-resizable-min/max` + `flex-basis: var(--kb-resizable-clamped)`；勿用 grid auto 列）。

**l. 后端 i18n 现状**（`src-tauri/kabegame-i18n/locales/zh.yml`，五语言 zh/en/ja/ko/zhtw）：`albums.errors.{nameExists,parentNotFound}` + `albums.localFolderErrors.*`（含 parentReadonly——参数废弃后删除其调用点）。

**m. 轮播状态**：settings key `wallpaperRotationEnabled` / `wallpaperRotationAlbumId`（`packages/kabegame-core/src/stores/settings.ts:33-34`，`useSettingKeyState` 读写）；现无「轮播中」badge——树上的轮播图标是新增展示。

## 分点实施方案 · 后端

### 点 1 — DB 迁移 v029：串联重挂 + 提根 + 剥前缀（`storage/migrations/`）

- **新增** `v029_local_folder_rechain.rs`：`pub fn up(conn: &Connection) -> Result<(), String>`，照 v028 的「BEGIN IMMEDIATE + 失败 ROLLBACK + 自包含（内联 CTE，不调 Storage 方法）」模式，四阶段：

```rust
// 阶段 1（提根）：type='normal' 且父级是 local_folder → parent_id=NULL（只动顶层违规者，普通子树整棵跟随）
//   顶层撞名 → resolve_name_ci(conn, None, name)："name (2)"/"name (3)"… CI 递增探测
// 阶段 2（串联重挂）：所有 local_folder 按「最近祖先」重算 parent_id
//   词法归一（去尾分隔符），比较用 Path::starts_with（组件边界）；迁移期不 canonicalize（磁盘可能离线）
//   最近祖先 = 其它文件夹画册中 sync_folder 是本画册真前缀且组件数最多者；换父时新父下撞名同样后缀消解
// 阶段 3（剥前缀）：结构落定后，local_folder 且父为 local_folder 的画册：
//   候选新名 = sync_folder 最后一个路径组件；仅当 ①当前名≠目录名 ②当前名 CI 以 "-{目录名}" 结尾
//   ③目录名与最终同父兄弟 CI 不撞 时改名；撞名保持旧名（剥前缀只是美化，失败无害）
// 阶段 4：内联 v028 同款递归 CTE 全表 rebuild ancestor_path
```

- **修改** `mod.rs`：`mod v029_local_folder_rechain;` + `MIGRATIONS` 追加 v29 + `LATEST_VERSION = 29`（本迁移只改数据不改 schema，`init.rs` 不动）。
- 单测（同文件，裸建表 + `PRAGMA user_version = 28`）：①提根 + 顶层撞名 `name (2)` ②旧数据 A、E 平行/误挂 → 迁移后 /A/E；含 C → /A/C/E ③`A-B` 剥成 `B`；剥后撞兄弟 → 保持 ④幂等（再跑一遍零 UPDATE）⑤ancestor_path 无 orphan。

### 点 2 — `Storage::rechain_local_folder_albums`（`storage/albums.rs`）

- **新增** 幂等运行时串联（与迁移阶段 2 同语义，两点差异：canon 优先词法兜底——与 `sync.rs:520-523` existing map 键一致；事务内 UPDATE + 撞名后缀 + `rebuild_album_ancestor_paths`，提交后逐个 `emit_album_changed(id, json!({"parentId": ..[, "name": ..]}))`——前端 store 的 `applyAlbumChangedPayload` 已能就地 patch，树自动重排）。返回 changed ids。
- **新增** 私有 helper `resolve_scoped_name_ci(conn, parent_id, base, exclude_id) -> String`：`base`、`base (2)`… 逐个过 `ensure_album_name_unique_ci` 同款查询直到不撞（迁移文件内为自包含内联一份）。
- 单测：串联/重挂到新导入的中间画册（tempdir 真目录或词法兜底分支）/连续两次调用第二次返回空。

### 点 3 — 类型守卫（`storage/albums.rs`）

- **修改** `add_album`（:231-242）：父级存在性检查升级为「存在且非 local_folder」——`SELECT type` + `None → 父画册不存在`、`Some("local_folder") → t!("albums.errors.parentIsLocalFolder")`。
- **修改** `move_album`：把 :952 的 `get_album_by_id` 提前到开头（不重复查询），加两条守卫：源 `kind=="local_folder"` → `t!("albums.errors.cannotMoveLocalFolder")`（位置由路径串联唯一决定）；目标父 `type=='local_folder'` → `t!("albums.errors.cannotMoveIntoLocalFolder")`（成员只能经同步产生）。
- `ensure_album_is_writable`（:100-114）保持只管图片增删，不动。

### 点 4 — `add_local_folder_album` 废弃 parent_id + 导入即串联（`commands/album.rs`）

- **修改**：签名不变（web/dispatch.rs、ACL、前端 invoke 零改动），实现内 `parent_id` 语义废弃——`Some(_)` 打 deprecation log；`build_entries_non_recursive(name, sync_folder, None)` 恒 None；创建后、spawn 同步前调 `rechain_local_folder_albums()`。
- **删除** :116-120 的 `parentReadonly` 检查（参数废弃后死代码）。
- 连带效应（记录在案）：AlbumDetail 往画册里拖文件夹（`dragFileImport.ts` 传 parentId）今后建出的是顶层/串联画册——与新规则一致，不改 AlbumDetail。

### 点 5 — 同步命名纯目录名 + 收尾过滤 + 同步后 rechain（`local_folder/sync.rs`）

- **修改** `on_enter_dir`（:353）：`let name = enter.name.clone();`（同父兄弟目录磁盘天然不重名；大小写敏感文件系统的 CI 撞名 → 先 `find_child_album_by_name_ci` 预检，撞则 `resolve_scoped_name_ci` 后缀，**不解析错误字符串**）。
- **删除** `NAME_SEPARATOR`（:26，唯一使用点已改）。
- **修改** 递归收尾（:584-593）：标 missing 前查 `get_album_by_id` 过滤 `kind != "local_folder"`（防御历史遗留/迁移间隙的普通子画册）。
- **修改** 递归收尾后：`if hook.created_albums > 0 { let _ = storage.rechain_local_folder_albums(); }`（同步建出中间目录画册时，外部深层画册就近重挂——与导入串联同规则）。
- 测试（`local_folder/tests.rs`）：子画册纯目录名；子树内普通画册不再被标 missing；递归同步后外部深层画册被收编重挂。

### 点 6 — 后端 i18n（`src-tauri/kabegame-i18n/locales/{zh,en,ja,ko,zhtw}.yml`）

- **新增** `albums.errors` 三键（zh 措辞，其余语言同步翻译）：

```yaml
parentIsLocalFolder: 本地文件夹画册的内容由文件夹同步管理，不能在其下手动创建子画册
cannotMoveLocalFolder: 本地文件夹画册的位置由其磁盘路径决定，不能手动移动
cannotMoveIntoLocalFolder: 不能将画册移动到本地文件夹画册下
```

## 分点实施方案 · 前端

### 点 7 — 类型扩展与选择树排除

- **修改** `packages/kabegame-core/src/types/album.ts`：`AlbumTreeNode` 增 `type?: "normal" | "local_folder"`、`syncFolder?: string | null`、`folderStatus?: string | null`（folder_status 为 JSON 字符串，红点判定解析 `state`）。
- **修改** `packages/kabegame-core/src/utils/albumTree.ts`：`AlbumFlatRow` 同扩（`buildAlbumTreeFromFlat` 展开透传，函数体零改动）。
- **修改** `apps/kabegame/src/stores/albums.ts`：`getAlbumTreeExcluding(excludeIds, opts?: { excludeLocalFolder?: boolean })`。
- **修改** `views/Albums.vue`：`createAlbumParentTree` 与 `moveAlbumTree` 传 `{ excludeLocalFolder: true }`（新规则：不能建/移入文件夹画册下；文件夹画册排除后其子树整体消失，正确）。
- **修改** `apps/kabegame/src/actions/albumActions.ts`：`moveTo` 对 `isLocalFolder` 上下文隐藏（`AlbumActionContext` 已有该字段）；后端守卫兜底。
- `AlbumPickerField.vue` 零改动（吃已过滤的树）。

### 点 8 — `AlbumTreePanel.vue`（新增，`apps/kabegame/src/components/albums/`）

```
Props:  selectedId: string | null
        refreshEvent?: "album-images-change" | "images-change"   // 默认 "album-images-change"（用户点名的参数化）
Emits:  select(albumId)、create-album(parentId | null)、contextmenu(album, ev)
结构:   面板标题行（albums.treePanelTitle + 三点下拉：仅「添加画册」，父级=当前选中且为普通非系统画册时取其 id，否则 null）
        过滤输入框（el-input → useTreeModel filterText，纯内存名称过滤）
        KbTreePanel（宿主自建 useTreeModel，三分区）
数据源（全部 computed 自 useAlbumStore；watch 投影 → model.reload() 保展开态）:
        系统区  roots = [收藏行, 垃圾桶行]（垃圾桶=HIDDEN_ALBUM_ID，显示名 t('albums.hiddenAlbumName')/垃圾桶图标；两行无 children）
        普通树  roots = getAlbumTreeExcluding([FAVORITE, HIDDEN], { excludeLocalFolder: true })
        文件夹区 {separatorBefore, header:'本地文件夹'} roots = buildAlbumTreeFromFlat(albums.filter(type==='local_folder'))
                 （迁移后文件夹画册父要么文件夹画册要么 null，天然自成森林）
行模板（#row）: 文件夹图标（文件夹画册用 openFolder 风格紫色）+ 名称(min-w-0 ellipsis) + flex-1 spacer
        + 轮播中图标(wallpaperRotationAlbumId===id && enabled) + folder_status 红点(state!=='ok', tooltip)
        + 直接计数（贴行右缘——画册树新 UI 按设计稿右对齐）
计数:   albumStore 直接计数（getAlbumStats/albumDirectCounts 口径，收藏/垃圾桶两行同列）
刷新:   refreshEvent prop 二选一（useAlbumImagesChangeRefresh / useImagesChangeRefresh，waitMs 1000）
        兜底重拉计数（store 对 album-images-change 已按 directCounts 增量 patch，此监听兜 images-change 型删除等）
defaultExpanded: 选中画册的祖先链展开
rowState: active = id === selectedId
```

**DnD 控制器**（复用移动弹窗排除集 `Albums.vue:241-246` + 新类型规则）：

```ts
const dnd: TreeDndController<AlbumTreeNode> = {
  canDrag: (n) => n.id !== FAVORITE_ALBUM_ID && n.id !== HIDDEN_ALBUM_ID && n.type !== "local_folder",
  getDragLabel: (n) => n.name,
  onDragOver: (src, target) => {
    if (target == null) return { accept: src.parentId != null, position: "inside" };  // 空白=移到顶层
    if (target.id === src.id || target.id === src.parentId) return false;
    if (target.id === FAVORITE_ALBUM_ID || target.id === HIDDEN_ALBUM_ID) return false;
    if (target.type === "local_folder") return false;               // 任何画册不可落入文件夹画册
    if (albumStore.getDescendantIds(src.id).includes(target.id)) return false;  // 不可落入后代
    return { accept: true, position: "inside", autoExpand: true };  // 只支持 inside（无手动排序）
  },
  drop: async (src, target) => {
    try { await albumStore.moveAlbum(src.id, target?.id ?? null); }
    catch (e) { ElMessage.error(...); }                              // 后端守卫文案原样透出
  },
};
```

### 点 9 — Albums.vue 三栏骨架

- **修改** 模板重写：

```html
<div class="albums-page flex h-full overflow-hidden" v-drag-file="dropZone">
  <KbResizable v-if="!isCompact" side="right" tag="aside"
      class="albums-tree-pane flex-none" v-model="treeWidth" :default-size="248">
    <AlbumTreePanel :selected-id="selectedAlbumId"
        @select="selectAlbum" @create-album="openCreateDialogWithParent" @contextmenu="openAlbumContextMenu" />
  </KbResizable>
  <section class="albums-content flex-1 min-w-0 flex flex-col">
    <ImageGrid ref="albumViewRef" :surface="surface" enable-virtual-scroll scroll-whole-container ...>
      <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
        <AlbumsPageHeader ... />          <!-- 复用现壳；标题区演进留后续 -->
        <GalleryQueryBar :query="albumDetailRouteStore.query" ... @navigate="onQueryNavigate" />
        <GalleryBigPaginator ... />
      </template>
    </ImageGrid>
  </section>
  <el-drawer v-if="isCompact" ...><AlbumTreePanel .../></el-drawer>   <!-- 点 11 -->
  <!-- 保留：创建弹窗、移动弹窗（DnD 兜底）、ActionRenderer 右键菜单 -->
</div>
```

- script：`treeWidth = useLocalStorage("kabegame-albums-tree-width", 248, { mergeDefaults: true })`；`surface = createAlbumDetailSurface({ albumId: () => selectedAlbumId.value, albumName: () => selectedAlbumName.value, isLocalFolder, analytics })`；中栏查询栏/分页接线照抄 AlbumDetail 图片分支（`AlbumDetail.vue:69-143`）。
- 样式（KbResizable 契约）：`.albums-tree-pane { --kb-resizable-min: 200px; --kb-resizable-max: min(420px, 40vw); flex: 0 0 var(--kb-resizable-clamped); border-right: 1px solid var(--anime-border); }`。
- **删除**：AlbumCard 网格 + `albumCardRefs`/`albumsListKey`；预览机器全套（`albumPreviewImages`/`albumIsLoading*`/`prefetch*`/`refreshAlbumPreview*`/`clearAlbumPreviewCache`/`loadAlbumPreviewFromProvider`/`displayedAlbumNodes`/`displayedAlbumNodeById` 及 :431-451 的 `useAlbumImagesChangeRefresh` 块）；隐藏画册 FAB；`openAlbum` 的 `router.push` 改页内 `selectAlbum(id)`（右键「浏览」同理）；卡片内联改名随卡片下线（rename 改走 `ElMessageBox.prompt`，AlbumDetail 已有同款）。
- **保留**：创建弹窗（父级树已排除文件夹画册；三点菜单的 create-album 事件预填父级后打开同一弹窗）、移动弹窗、`v-drag-file` dropZone、`handleAlbumMenuCommand` 全部命令分支、AlbumCard.vue 组件文件。

### 点 10 — 选中状态：`albumIdPath`（祖先链）+ `path` 去前缀（用户修订的设计）

**10a — settings 层：两个独立设置项（不新增双后端机制，用户明确）**（`packages/kabegame-core/src/stores/`）

- **修改** `settings.ts`：`AppSettings` 增两个键——`albumIdPath: string`（祖先 id 链，`/root/.../self/`，空串=未选）与 `albumIdPathLocal: string`（同格式的本地记忆）。**settings 机制（初始化/watch/save）零改动**。
- **修改** `settingsDescriptors.ts`：
  - `query("albumIdPath", "album")`（query 参数名建议 `album`，短且不与 `path` 冲突；实施可调）；
  - `frontendLocal("albumIdPathLocal", "")`；
  - `album-detail-path` 照 `gallery-path` 平台分化：`if (!IS_WEB) frontendLocal("album-detail-path", "")`，query 注册移入 `IS_WEB` 分支。
- **新增** 消费侧小 composable（如 `apps/kabegame/src/composables/useAlbumIdPathState.ts`）承载「优先 query 读、双写」：

```ts
export function useAlbumIdPathState() {
  const settings = useSettingsStore();
  /** 读：query 非空优先（深链），否则 localStorage 记忆。 */
  const albumIdPath = computed(() =>
    (settings.values.albumIdPath || settings.values.albumIdPathLocal || "") as string);
  /** 写：两者同步写。 */
  const set = async (chain: string) => {
    await Promise.all([
      settings.save("albumIdPath", chain),        // query（web 深链可见；replace history）
      settings.save("albumIdPathLocal", chain),   // localStorage 记忆
    ]);
  };
  return { albumIdPath, set };
}
```
- `pathRoute.ts` 的 settingKey union 不含这两个键（非 path-route key，独立设置项）。

**10b — `albumDetailRoute.ts`：path 去 `album/<id>` 前缀**

- **修改** parse：不再 `extractRootIdAndBody`——存储 path 即查询体（`parseComposablePath(path, [], "by-album-order")`）；state 的 `albumId` 字段改由 `albumIdPath` 派生（链末段），或从 state 移除、由 store 暴露 computed（实施时取改动面小者）。
- **修改** build：不再拼 `rootPrefix: album/<id>`——**存储/URL 形态无前缀**；**查询出口保持带前缀语义**：`computedPath`/`buildContext`/`contextPathFor` 等 pathql 出口拼 `album/${albumId}`（hide/ 全局前缀仍由工厂处理，位于最前：`hide/album/<id>/...`）。surface 消费的是查询出口，`validatePath`/`rootPathFallback`（`surfaces/album.ts`）以 `album/` 前缀校验的逻辑理论不受影响——实施时核验其输入源确为查询出口。
- **修改** `views/AlbumDetail.vue`（最小适配，移出零改动名单）：initAlbum 不再从 `?path=` 提取/比对 albumId（path 无 id）；albumId 一律来自 `route.params.albumId`，进入时经 `useAlbumIdPathState().set(ancestorPathOf(id))` 回写双键；`syncFromUrl(qp)` 直接采纳查询体。

**10c — Albums.vue 选中逻辑（大幅简化：优先级由 settings 双后端天然实现）**

```ts
const { albumIdPath, set: setAlbumIdPath } = useAlbumIdPathState();   // 点 10a 的 composable：query 优先读、双写
const selectedAlbumId = computed(() => lastSegmentOf(albumIdPath.value));  // 链末段
const selectAlbum = (id: string) => {
  void setAlbumIdPath(ancestorPathOf(id));   // store 的 Album.ancestorPath（HIDDEN 用 `/id/`）
  void albumDetailRouteStore.navigate({ query: [], sort: { field: "by-album-order", desc: false }, page: 1 });
};
onMounted(async () => {
  await albumStore.loadAlbums();
  // 「query 优先、localStorage 兜底」在 composable 读取端完成；此处只校验存活 + 最终回落收藏
  const id = selectedAlbumId.value;
  if (!id || !albumExists(id)) selectAlbum(FAVORITE_ALBUM_ID);
});
// 选中画册被删（事件驱动）→ 沿祖先链上溯最近存活者，无则收藏
watch(() => albumExists(selectedAlbumId.value),
  (ok) => {
    if (ok || albumStore.loading) return;
    const chain = segmentsOf(albumIdPath.value);   // [root..self]
    const fallback = [...chain].reverse().find((cid) => albumExists(cid));
    selectAlbum(fallback ?? FAVORITE_ALBUM_ID);
  });
```
> `albumExists(id)` = `id === HIDDEN_ALBUM_ID || albums.some(a => a.id === id)`。树的 `defaultExpanded` 直接用链（选中祖先链展开，零查询）。

### 点 11 — 紧凑/Android：左树收抽屉

- **修改** `packages/kabegame-core/src/stores/header.ts`：`HeaderFeatureId` 增 `AlbumTree = "albumTree"`。
- **修改** `apps/kabegame/src/header/headerFeatures.ts`：注册 feature（树形图标，label `header.albumTree`）。
- **修改** `components/header/AlbumsPageHeader.vue`：compact `showIds` 前插 `AlbumTree`，转发新 emit `open-tree`。
- **新增**（Albums.vue）：`const treeDrawer = useModal()`（useModal 已接 modalStack → Android 返回键；若裸用 el-drawer 则必须 `useModalBack`）；`direction="ltr" size="min(80vw, 320px)"`；`@select` 后关抽屉。桌面/紧凑同一 AlbumTreePanel props/事件面，`v-if` 互斥挂载。

### 点 12 — 前端 i18n（`packages/kabegame-i18n/src/locales/{zh,en,ja,ko,zhtw}/albums.json` + `header.json`）

```jsonc
// albums.json（zh；五语言齐补）
"treePanelTitle": "画册", "treeFilterPlaceholder": "过滤画册", "treeSectionLocalFolders": "本地文件夹",
"treeTrash": "垃圾桶", "treeRotationTooltip": "壁纸轮播中", "treeFolderStatusTooltip": "文件夹状态异常：{state}",
"treeAddAlbum": "添加画册", "moveSuccess": "已移动", "moveFailed": "移动失败"
// header.json
"albumTree": "画册树"
```
> 复用现有键：`albums.hiddenAlbumName/newAlbum/...`（实现时核对现有键名，缺的才补）。

## 风险与验证

**风险**
- R1 「优先 query 读、双写」在消费侧手写：query 清空（用户手删参数/路由切换丢 query）时回退 localStorage 的语义、query adapter 注入前的早期读取次序需单独过一遍（集中在 `useAlbumIdPathState` 一处，可控）；`album-detail-path` 换 localStorage 后桌面端 /albums 与 /albums/:id 共享同一份存储 path（不再随 history 隔离）——两页进入时都会重置/采纳查询，需实测切换不串台（深链→列表→详情→返回）。
- R2 surface 在 /albums 上首次激活时序：`albumName` 就绪才翻 isActive（本页用 computed 自 store，确保 loadAlbums 完成前不 navigate）；`albumDetailRoute` 改形后 `computedPath` 的查询出口必须始终带 `album/<id>` 前缀，`validatePath`/`rootPathFallback` 的输入源需核验。
- R3 迁移撞名/幂等/离线盘：点 1 单测全覆盖；真实库先备份 `.kabegame/debug` 数据再手工验证。
- R4 DnD 首个真实消费者：基座 pointer 手势在 CEF 的实测（拖移、非法落点拒绝、Escape 取消、拖出窗口 pointercancel、外部文件拖入 v-drag-file 回归——pointer 与 OS drag 会话理论无冲突，仍需实测一次）。
- R5 紧凑模式没有设计稿：抽屉交互自定，Android 返回键必须走 modalStack。

**验证**
- `check-kabegame`：前端迭代用 `--skip vue`/`--skip cargo` 分侧快查，收尾全量。
- `test-kabegame`：`kabegame-core --lib migrations`（v029）、`kabegame-core --lib albums`（rechain/守卫）、`kabegame-core local_folder`（命名/收尾/收编）；全量套件有 ~20 个既有失败，按名过滤。
- UI（用户跑 dev + kabegame-chromium）：三栏骨架截图；拖宽刷新后保持；选收藏/垃圾桶/普通/文件夹画册各一张（计数右对齐、轮播图标、红点）；过滤框收窄；深链恢复（web：`?album=<祖先链>` + `?path=<查询体>`；桌面：localStorage path + query albumIdPath 双源）刷新后选中与查询都在；清 localStorage 落收藏；两页切换不串台（列表↔详情往返，path 查询体各自重置/采纳）；树内拖拽移动 + 非法落点（后代/系统/文件夹画册）拒绝 + 移动弹窗兜底文案；新建画册父级树无文件夹画册；紧凑抽屉 + Android 返回键；从 Finder 拖文件夹进页（v-drag-file 回归）。
- 后端行为：导入 /A、/E、/C 顺序验证 /A/C/E 串联；递归同步验证纯目录名与收编；对着旧库跑 v029 后抽查（提根/串联/剥前缀/ancestor_path）。

## 文件清单

**后端（src-tauri/kabegame-core/）**
- `src/storage/migrations/v029_local_folder_rechain.rs` — 新增（迁移 + 单测）
- `src/storage/migrations/mod.rs` — 修改（注册 v29、LATEST_VERSION=29）
- `src/storage/albums.rs` — 修改（守卫 ×2、rechain、resolve_scoped_name_ci、单测）
- `src/commands/album.rs` — 修改（parent_id 废弃、创建后 rechain、删 parentReadonly）
- `src/local_folder/sync.rs` — 修改（纯目录名+预检撞名、收尾过滤、递归后 rechain、删 NAME_SEPARATOR）
- `src/local_folder/tests.rs` — 修改（新用例）

**后端 i18n**：`src-tauri/kabegame-i18n/locales/{zh,en,ja,ko,zhtw}.yml` — 修改（albums.errors 三键）

**前端 packages**
- `packages/kabegame-core/src/types/album.ts`、`src/utils/albumTree.ts` — 修改（类型扩展）
- `packages/kabegame-core/src/stores/settings.ts` — 修改（仅 AppSettings 增 albumIdPath / albumIdPathLocal 两键；机制零改动）
- `packages/kabegame-core/src/stores/settingsDescriptors.ts` — 修改（query("albumIdPath","album") + frontendLocal("albumIdPathLocal") + album-detail-path 平台分化）
- `packages/kabegame-core/src/stores/header.ts` — 修改（HeaderFeatureId.AlbumTree）
- `packages/kabegame-i18n/src/locales/{zh,en,ja,ko,zhtw}/{albums,header}.json` — 修改（新键 ×5）

**前端 apps/kabegame**
- `src/components/albums/AlbumTreePanel.vue` — 新增（三分区模型 + 行模板 + DnD 控制器 + refreshEvent 参数 + 过滤 + 三点菜单）
- `src/composables/useAlbumIdPathState.ts` — 新增（albumIdPath 双键「query 优先读、双写」的唯一承载点）
- `src/views/Albums.vue` — 修改（三栏骨架、albumIdPath 选中逻辑、抽屉、卡片/预览机器/FAB 下线）
- `src/stores/albumDetailRoute.ts` — 修改（path 去 album 前缀；albumId 由 albumIdPath 派生；查询出口拼前缀）
- `src/views/AlbumDetail.vue` — 修改（**最小适配**：albumId 一律取 route.params 并回写 albumIdPath；不再从 path 提取 id）
- `src/stores/albums.ts` — 修改（getAlbumTreeExcluding 选项；Album 接口核实/补 ancestorPath）
- `src/actions/albumActions.ts` — 修改（moveTo 对 local_folder 隐藏）
- `src/components/header/AlbumsPageHeader.vue`、`src/header/headerFeatures.ts` — 修改（抽屉入口）
- `src/stores/pathRoute.ts` — 视需要修改（若查询出口/存储形态分离需要工厂 hook；优先在 albumDetailRoute 的 config 内解决）

**零改动（明确声明）**：`AlbumCard.vue`（文件保留）、`web/dispatch.rs`（签名未变）、tauri ACL、`router/index.ts`、`useImagesChangeRefresh.ts`/`useAlbumImagesChangeRefresh.ts` 本体、树基座 `components/tree/*`（若消费中发现基座缺口，改动记回 tree-panel-refactor.md）。
