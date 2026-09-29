# 事件聚合第三期：画册按需查询，拆掉全量 albums store

> 前置：第一期（`images-change` 经 `dataChangeHub` / `liveQuery`）与第二期（`album-images-change` 按画册拆分、
> 带 `seq`、写命令返回 `albumChanges`、`EventHold`）已落地。背景见 [eventWorker.md](eventWorker.md)、
> [eventWorker-phase2.md](eventWorker-phase2.md)。

## 总体设计思路

第二期之后，前端仍然在 `stores/albums.ts` 里常驻**全部画册**的扁平列表和两套计数，并在每条事件上维护它们：
`album-added` 把新画册插进响应式数组、整棵重建两套计数树；`album-images-change` 按表加减后也整棵重算。
画册树 `AlbumTreePanel` 再对全量列表拼一个签名串，签名一变就整树 `reload`。标签迁移时（danbooru 1000 张图、
general 下 700+ 个标签），每秒几百条事件、每条都触发 O(画册数) 的重算和重渲染，帧率掉到 2。根子在于：
前端持有了它并不需要的全量状态，于是每条变更都要付全量的维护成本。

本期把画册数据改成**按需查询**，与第一期的网格同构：谁在显示，谁注册查询；不显示的东西不占内存、不付代价。
一个**展开的画册目录**就是一个 pathql 查询需求——「这个目录的直接子画册 + 每个子画册的计数」，注册进
`dataChangeHub`，相关批次到来时经 500ms 防抖重拉；折叠的目录不注册，迁移期间 general 只要不展开，就一条
都不刷新。树基座 `useTreeModel` 本来就是 VSCode 式异步懒加载（`getChildren` 可返回 Promise、有
`refreshChildren(key)`），画廊过滤树已这么用，画册树只是没用上。

**计数由调用侧组合 pathql 路径得到，kabegame-core 不内建任何计数口径。** 子画册计数那段逻辑（标签目录 =
直接子画册数；标签叶子 = 直接成员数；普通画册 = 自身与全部子孙直接成员之和）是业务规则，不是框架能力。它由
调用侧用 pathql 已有的原语拼出来：`pathql_list(目录路径, with_count)` 为每个子项附带「子路径的行数」，子路径
落在 `images://gallery/…` 下就是图片数，落在 `albums://…` 下就是子画册数；普通画册的子树和则是一条新的画廊
路由 `album-tree/<id>` 的 entry 总数。这样做的关键收益是**全局过滤器天然生效**：「排除隐藏」只是给路径加
`hide/` 前缀，以后新增任何全局过滤器也只是再加一个前缀，计数与列表始终同源、同口径，后端无需为每种口径
新增列或视图。（曾考虑把三条规则写成 SQL 视图 `album_stats`，被否决：它把「排除隐藏」固化成一列，每多一种
全局过滤就要改视图，而且要在 SQL 里重写一遍画廊的过滤语义。）

**前端不再持有全量 store。** `stores/albums.ts` 拆成无状态的 `services/albums.ts`：类型、常量、行归一化、
写命令、查询函数。需要画册数据的地方各自按需取：
- 画册树、画册页子画册：目录查询（常驻、随事件刷新）；
- 画册页选中画册、面包屑、统计、封面：单画册查询（常驻、随事件刷新）；
- 各对话框里的画册选择器：与侧边栏同一套目录查询 + 后端搜索，下拉 / 弹层打开期间常驻，关闭即释放；
- 隐藏画册计数、图片所属标签、忙碌卡片跳转：各自的单点查询。

关键取舍一：**选择器与侧边栏同构，而不是取全量快照。** 现在的 `AlbumPickerField`（core 包）在桌面是吃整棵树的
`el-tree-select`，在安卓是把整棵树拍平的滚轮 / 磨玻璃列表——两种形态都要求先拿到全部画册。拆掉 store 之后，
与其为选择器单独取一份全量快照（1.3 万个画册时不带计数也要整表传输、整树渲染，带计数更是约 5s），不如让
选择器直接复用侧边栏的做法：从 `AlbumTreePanel` 抽出共用的**画册树视图 `AlbumTreeView`**（按目录懒加载、每页
100 个 + 加载更多、后端搜索模式、订阅 hub），侧边栏在它外面加标题菜单与拖放，选择器在它外面加触发框与
下拉层。桌面是点击触发框弹出的下拉面板（顶部搜索框 + 树），安卓是全高底部弹层，里面同样是可逐级展开的树
和搜索框——不再拍平。计数随之保留，口径与侧边栏一致。各调用方原先用 `getAlbumTreeExcluding` 表达的裁剪规则
（只看标签目录、排除本地文件夹 / 标签森林、排除某画册及其子孙等）改为声明式的 `scope` 传给视图：按画册
类型的过滤下沉到 DSL 的 `kind_` 过滤段（点 2），保证分页不会因前端过滤变得稀疏；排除少量指定 id 与其子孙
由视图按 `ancestorPath` 在前端隐藏行。

关键取舍二：**相关性判断靠事件里的 `ancestorPath`。** 前端不再有全量列表，就无从知道一条
`album-images-change` 的画册在树上哪里。所以后端给画册类事件都带上该画册的 `ancestorPath`
（`album-added` 已带），一个目录 D 是否受影响只需判断批次里某条路径以 D 的路径为前缀——计数影响的是该画册
及其全部祖先，结构变化影响的是它的父目录（以及标签目录的子画册数，所以也是祖先链）。

**目录分页与后端搜索。** 按需查询之后，单个目录仍可能很大（general 下几百上千个标签），所以目录子项按
**每页 100 个**加载，末尾一行「加载更多」，点击追加下一页。分页落在专门的「分页列举节点」上
（`…/subpage_<页>`，其 `list.sql` 带 `LIMIT 100 OFFSET …`），对它 `pathql_list(with_count)` 就只为这一页的 100 个
子项计数。是否还有更多由父行在上一级列举时得到的子画册数与已加载数比较得出。事件驱动的刷新逐页重拉已加载
的各页，保持用户已翻到的位置。普通画册的子树和要逐个再取一次 entry，不便分页，但普通画册数量少，接受。
树的过滤框不再在前端对已加载节点做字符串匹配——那只能搜到展开过的部分——而是切换成**搜索模式**：防抖后
走后端 pathql 搜索（名称 / 标签 key / 标签路径，LIKE 转义沿用画廊搜索的写法），结果同样 100 个一页、可加载
更多，以扁平列表展示并附上所在路径；点击结果即选中该画册并退出搜索。

关键取舍三：**用户自己的写操作立即刷新。** 写命令已返回 `albumChanges`（第二期）；`services/albums` 的写函数
把它们作为「本地批次」即时推进 hub（不经防抖），目录查询立刻重拉；事件随后到达时按 `seq` 去重。与网格的
`ctx.mutate` 同一思路。

## 现状锚点

**a. store 对 `album-added` 的每条事件都做全量工作**（`apps/kabegame/src/stores/albums.ts:447`）
```ts
const applyAlbumAddedPayload = (p: Record<string, unknown>) => {
  const row = normalizeAlbumRow({ ...p, type: p.albumType ?? "normal" });
  if (!row.id) return;
  if (albums.value.some((a) => a.id === row.id)) return;   // 现状：线性查重
  albums.value.unshift(row);                                // 现状：响应式数组变更 → albumTree 等 computed 全量重建
  albumDirectCounts.value[row.id] = 0;
  albumHiddenDirectCounts.value[row.id] = 0;
  recomputeAllAlbumCounts();                                // 现状：两套计数树整棵重建
};
```

**b. 聚合计数口径只在前端**（`apps/kabegame/src/utils/albumMediaTree.ts:55`）
```ts
aggregateTotal:
  album.type === "label_dir"
    ? children.length                    // 现状：标签目录 = 直接子画册数
    : album.type === "label"
      ? directTotal                      // 现状：标签叶子 = 直接成员数
      : directTotal + children.reduce((sum, child) => sum + child.aggregateTotal, 0),  // 现状：子树求和，不去重
```

**c. 画册树对全量列表做签名、整树 reload**（`components/albums/AlbumTreePanel.vue:232`）
```ts
watch(
  () => albumStore.albums.map((a) => `${a.id}:${a.parentId}:${a.name}:...`).join("|"),  // 现状：每次变更 O(N) 拼串
  async () => { await model.reload(); ensureSelectedExpanded(); },                       // 现状：整树重载
);
const dataSource: TreeDataSource<AlbumTreeNode> = {
  getKey: (n) => n.id,
  hasChildren: (n) => n.children.length > 0,
  getChildren: (n) => n.children,        // 现状：同步读 store 建好的整树，没用上基座的异步懒加载
};
```

**d. 树基座本就支持异步懒加载**（`components/tree/types.ts`）
```ts
export interface TreeDataSource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  getChildren(element: T): T[] | Promise<T[]>;   // 现状：可异步；useTreeModel 另有 refreshChildren(key) / reload()
}
```

**e. 选择器吃整树 + 全量计数**（`packages/kabegame-core/src/components/album/AlbumPickerField.vue:46`）
```ts
defineProps<{
  modelValue: string | null;
  albumTree: AlbumTreeNode[];               // 现状：调用方用 albumStore.getAlbumTreeExcluding(...) 从 store 裁剪
  albumCounts: Record<string, number>;      // 现状：store 的聚合计数
  /* ... */
}>()
```

**f. 画册事件没有位置信息**（`src-tauri/kabegame-core/src/emitter.rs:461`、`storage/image_events.rs`）
```rust
pub fn emit_album_deleted(&self, album_id: &str) {
    let event = Arc::new(DaemonEvent::AlbumDeleted { album_id: album_id.to_string() });  // 现状：只有 id
    /* ... */
}
// AlbumImagesChangePayload { seq, reason, album_ids, image_ids }                      // 现状：无 ancestorPath
```

**g. store 的使用方**（按成员统计）
```
App.vue                         loadAlbums
Albums.vue                      albums（选中/面包屑/存活/本地文件夹去重）、getAlbumStats、getAlbumCounts、
                                getAlbumDirectCounts（封面）、getAlbumTreeExcluding×4、getDescendantIds×2、
                                isLocalFolderAlbum×2、albumImages、loadAlbums×4、create*/rename/move/delete/setLabelKey
AlbumTreePanel.vue              albums×7、getAlbumCounts、getAlbumTreeExcluding、getDescendantIds、labelForestAlbums、moveAlbum
AddToAlbumDialog / CrawlerDialog / LocalImportDialog / WebpageCollectDialog
                                albumCounts、getAlbumTreeExcluding×2、createAlbum、loadAlbums / ensureAlbumsLoaded
WallpaperRotationTargetSetting  albumTree、albumCounts、loadAlbums
ImageLabelsPanel.vue            albums、labelAlbums、getAlbumCounts、getAlbumTreeExcluding、getImageAlbumIds、
                                createLabelAlbum、add/removeImagesToAlbum
ImageGrid.vue                   albums + getImageAlbumIds（复制标签）、add/removeImagesToAlbum（隐藏）
HiddenCleanupControl.vue        albumDirectCounts[HIDDEN]
BusyFolderSyncCard.vue          albums.find（取 ancestorPath 跳转）
useImageOperations / useAlbumOperations   albums、createAlbum、addImagesToAlbum、loadAlbums
adapters/album.ts               removeImagesFromAlbum、applyAlbumImagesChanges
仅取常量/类型                   albumActions、AlbumDetailPanel、AlbumContextMenu、albumDetailRoute、dataChangeHub、
                                dragFileImport、imageLabels(.test)、albumMediaTree
```

## 点 1 — 后端：修正嵌套画册路径的条件叠加、补 `parent_id` 索引（**已完成**，随「带计数列举提速」一起落地）

> 已落地（2026-09-29）：`gallery_album_provider` 加 `where_clear: ["ai.album_id ="]`；迁移 v032 与 `init.rs` 建
> `idx_albums_parent`；另外 pathql-rs 新增 `ChildEntry.total` 与 `ProviderRuntime::list_with_count`（计数复用子项
> 已实例化的 provider 叠加父 composed，不再逐个 resolve 子路径），`query_list(with_count)` 改用它；执行器改
> `prepare_cached`。测试：pathql-rs `list_with_count_matches_count_of_child_path`、v032 查询计划断言、dsl_e2e。
> 实测（release CLI，开发库副本，general 4675 个子项带计数）：`gallery/album/<general>` 1.93s（且计数全为 0）
> → 0.14s；`gallery/hide/album/…` 同上；`albums://by_sub_tree/…/general` >60s（按名称寻址时每个子项 resolve
> 都重跑父列举 SQL，O(N²)）→ 0.05s。按每页 100 项折算，两次列举合计约 4ms。以下为原计划内容，保留备查。

- **修改** `dsl/images/gallery/albums/gallery_album_provider.json5` 的 `query` 增加 `where_clear`，进入子画册时
  清掉父画册的 `ai.album_id = …` 条件。
```json5
"query": {
    "where_clear": ["ai.album_id"],                 // 新增：写法以 RULES.md 的 where_clear 匹配规则为准，实施时核对
    "where": "ai.album_id = ${properties.album_id}"
},
```
  > 说明（实测，开发库副本）：现状 `pathql query images://gallery/album/<general> --list --with-count` 的 4675 个
  > 子项计数全为 0——子路径 `gallery/album/<general>/<子id>` 叠加成 `ai.album_id = general AND ai.album_id = 子`，
  > 恒为空。`albums_by_sub_tree_provider` 已为同样的问题写了 `where_clear`，这里补齐。修正后同样影响「按画册
  > 路径逐级进入看图」，是正确的行为。补 dsl_e2e 用例：嵌套路径的行数等于子画册单层路径的行数。
- **新增** 迁移 `v032_album_parent_index.rs`（编号按 `storage/migrations/` 顺延）：
  `CREATE INDEX IF NOT EXISTS idx_albums_parent ON albums(parent_id)`。
  > 说明：现有 `idx_albums_name_scoped` 建在表达式 `COALESCE(parent_id, '')` 上，`parent_id = ?` 用不上，
  > 目录列举与子画册计数都会全表扫描（实测：13119 个画册时按 `parent_id` 计子项数，首页 100 行 0.34s → 加索引后 0.00s）。

## 点 2 — 后端：画册查询的 DSL 原语

全部是普通 provider / 路由，不新增命令、视图或计数列；前缀（`hide/` 等）对图片计数自然生效。

- **新增** 分页列举节点 `subpage_<页>`，两个命名空间各一个：
  - `images://gallery/[<前缀>/]album/<目录id>/subpage_<n>`、`images://gallery/[<前缀>/]albums/subpage_<分区>_<n>`
    （分区：`normal` / `label` / `local_folder`）：`list.sql` 为该目录（或该分区根级）的子画册，按名称排序、
    `albums.id` 兜底，`LIMIT 100 OFFSET (${n} - 1) * 100`；每项 `provider` 为 `gallery_album_provider`（带点 1 的
    `where_clear`）。对它 `with_count` → 每个子画册的**直接图片数**（带前缀口径）。
  - `albums://children_<目录id>/subpage_<n>`、`albums://root_<分区>/subpage_<n>`：同样的行，子项 provider 为
    `albums_by_sub_tree_provider` 风格（清掉父条件、按 `parent_id` 过滤）。对它 `with_count` → 每个子画册的
    **直接子画册数**。
  > 说明：`list` 本身不接 `x100x/N` 分页段（分页段作用在 fetch 的 query 上），所以分页做在列举节点的
  > `list.sql` 里；`LIMIT` / `OFFSET` 用 `${properties.*}` 走 bind param（`RULES.md` §7.1）。
- **新增** 子树图片路由 `images://gallery/[<前缀>/]album-tree/<id>`（`dsl/images/gallery/album/`）：成员所属画册在
  该画册子树内（`ancestor_path` 前缀匹配）。普通画册的「自身 + 子孙之和」= 它的 entry 总数；画册页封面也用它
  （`…/album-tree/<id>/x1x/1` 取 1 张，自身无图时自然取到子孙的图）。
  > 说明：`INNER JOIN album_images` 按成员行计数，同图挂两个子画册计两次，与现状口径一致；实施时用
  > dsl_e2e 断言这一点。
- **新增** `albums://subtree_<id>`：`ancestor_path` 以该画册路径为前缀且不含自身的画册；entry 总数即子孙画册数
  （画册页右栏统计、「转为普通画册」确认文案）。
- **新增** `albums://ancestors_<id>`：该画册全部祖先，按深度升序（面包屑）。
- **新增** `albums://of_image_<imageId>`：图片直接所属的全部画册行（取代 `get_image_album_ids` + 前端按 id 查 store）。
- **新增** 画册类型过滤段 `kind_<类型>[,<类型>]`（如 `kind_label_dir`、`kind_normal,label_dir`），可插在上述目录列举、
  分区根列举与搜索节点的 `subpage_` 之前，两个命名空间都支持：`list.sql` 追加 `type IN (...)`，并让子项 provider
  继承同一过滤（`albums://` 侧因此 `with_count` 得到的子画册数也只数该类型——选择器「只看标签目录」时，展开
  箭头与「加载更多」都按过滤后的数量判断）。
  > 说明：选择器按类型裁剪若放在前端，一页 100 个里可能只剩几个甚至为空；过滤必须在分页之前。类型值用
  > 白名单正则（`normal|label|label_dir|local_folder`）匹配，经 bind param 进入 SQL。
- **明确** 分区自带的类型过滤，与现状 `AlbumTreePanel` 的分区语义一致（本地文件夹画册可以挂在普通画册下，现状
  把它们从普通树里剔除，统一放进「本地文件夹」分区做根）：
  - `normal` 分区：根为 `parent_id IS NULL AND type = 'normal'`（不含收藏 / 隐藏），向下列举隐含 `kind_normal`；
  - `label` 分区：根为 `parent_id IS NULL AND type IN ('label', 'label_dir')`，向下隐含 `kind_label,label_dir`；
  - `local_folder` 分区：根为「`type = 'local_folder'` 且父级为空或父级不是本地文件夹」，向下隐含 `kind_local_folder`；
  - `system` 分区：收藏、隐藏两行，前端按固定 id 取，不分页。
  调用方显式给出的 `kinds` 与分区隐含过滤取交集。子画册数（`childCount`）同样只数过滤后的子项。
- **新增** 搜索：`images://gallery/[<前缀>/]albums/search/<关键字>/subpage_<n>` 与 `albums://search/<关键字>/subpage_<n>`，
  `list.sql` 匹配名称 / 标签 key / 标签路径（LIKE 转义照抄 `gallery_search_display_name_query_provider.json5`），
  名称完全匹配优先、其次前缀匹配、再按名称；另带 `parent_path_names`（祖先名称按深度拼接，只对当前页计算）。
  计数方式与目录列举相同。
- **修改** 实施后运行 `deno task pathql:generate` 重新生成 `@kabegame/pathql-client`。

## 点 3 — 后端：画册类事件带 `ancestorPath`

- **修改** `DaemonEvent::AlbumImagesChange` 增加 `#[serde(rename = "ancestorPath")] ancestor_path: String`；
  `image_events.rs` 的私有 `emit_album_images_change` 发送前取该画册的 `ancestor_path`。
  > 说明：`emit_membership_added/removed` 已有成员查询，实施时在同一次加锁里把涉及画册的 `ancestor_path`
  > 一并取出（`SELECT id, ancestor_path FROM albums WHERE id IN (...)`），不为每条事件单独查。
- **修改** `DaemonEvent::AlbumDeleted` 增加 `parent_id` 与 `ancestor_path`（删除前取）；`emit_album_deleted`
  改收 `&Album`。
- **修改** `move_album` 发出的 `album-changed` 的 `changes` 同时带新的 `ancestorPath` 与 `oldAncestorPath`。
  > 说明：移动同时影响旧父链与新父链的计数与结构，两条路径都要让前端知道。
- **修改** `AlbumImagesChangePayload`（Rust 与前端两份）增加 `ancestorPath`；写命令返回的 `albumChanges`
  自然带上。

## 点 4 — 前端 hub：画册维度改为路径集合（`services/dataChangeHub.ts`）

- **修改** `ChangeBatch`
```ts
export interface ChangeBatch {
  /* images 维度不变 */
  albumImages: Set<string>;
  albumIds: Set<string>;
  albumImageIds: Set<string>;
  favoriteOps: { imageIds: string[]; favorite: boolean }[];
  albumStructure: Set<string>;
  /** 新增：本批所有画册变更（成员与结构）涉及画册的 ancestorPath；目录查询按前缀判断相关性 */
  albumPaths: Set<string>;
  /** 新增：本批有无法定位的结构变更（如缺 ancestorPath 的旧 payload），相关目录一律视为命中 */
  albumPathsWildcard: boolean;
  maxSeq: number;
}
```
- **新增** source `album-added`（取 `ancestorPath`）、`album-deleted`（取 `ancestorPath`）；`album-changed`
  source 除结构字段外取 `ancestorPath` / `oldAncestorPath`（`name` 变化也计入：树要显示新名字）。
- **新增** `publishLocal(batch: ChangeBatch)`：本地写命令返回的 `albumChanges` 转成批次后立即投递给所有
  订阅者，**绕过防抖窗口**；hub 记录已投递的 `seq`（`BoundedSet`，从 store 挪来），事件到达时同 `seq` 丢弃。
- **新增** 导出纯函数 `affectsAlbumDir(batch, dirAncestorPath: string | null): boolean`：
  `dirAncestorPath === null`（根）时任一画册变更都命中；否则 `albumPaths` 中存在以其为前缀且不等于它的路径，
  或 `albumPathsWildcard`。
  > 说明：计数变化影响「该画册及全部祖先」，结构变化影响「父目录及其祖先（标签目录的子画册数）」，
  > 两者都归结为「祖先链上的目录」，前缀判断即可覆盖。

## 点 5 — 前端：无状态 `services/albums.ts`，删除 `stores/albums.ts`

- **新增** `services/albums.ts`
```ts
export const HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000";   // 自 stores/albums 迁入
export const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";
export type { Album } from ...;                                            // 类型 + normalizeAlbumRow 迁入
export interface AlbumNode extends Album {
  /** 界面显示的计数：由调用侧按类型从列举结果组合（见下） */
  count: number;
  /** 直接子画册数：来自 albums:// 列举的 with_count，用于展开箭头与「加载更多」 */
  childCount: number;
}
export const ALBUM_PAGE_SIZE = 100;
export type AlbumRootSection = "normal" | "label" | "local_folder";
/** 当前全局前缀（"" 或 "hide/"，以后的全局过滤器同样拼在这里）；来自全局路由状态 */
export type GalleryPrefix = string;

/**
 * 目录（或分区根）的一页子画册 + 计数。一页固定两次 pathql_list(with_count)，普通画册再各补一次 entry：
 *   A = list(images://gallery/<prefix>album/<dir>/subpage_<n>, true)   → 每项直接图片数
 *   B = list(albums://children_<dir>/subpage_<n>, true)                → 每项直接子画册数
 *   count = label_dir ? B : label ? A : entry(images://gallery/<prefix>album-tree/<id>).total
 * 两次列举并行发出；普通画册的 entry 只对 type=normal / local_folder 的子项发。
 */
export function fetchAlbumPage(
  target: { parentId: string } | { section: AlbumRootSection },
  page: number,
  prefix: GalleryPrefix,
  kinds?: AlbumKind[],                           // 新增：对应 DSL 的 kind_ 过滤段；缺省不过滤
): Promise<AlbumNode[]>;
export function searchAlbums(query: string, page: number, prefix: GalleryPrefix, kinds?: AlbumKind[]): Promise<AlbumSearchNode[]>;
export function fetchAlbum(id: string): Promise<Album | null>;                  // albums://id_<id>
export function fetchAlbumCount(album: Album, prefix: GalleryPrefix): Promise<number>;   // 同上面的组合规则，单个画册
export function fetchDescendantCount(id: string): Promise<number>;              // entry(albums://subtree_<id>)
export function fetchAlbumAncestors(id: string): Promise<Album[]>;              // albums://ancestors_<id>
export function fetchImageAlbums(imageId: string): Promise<Album[]>;            // albums://of_image_<id>
export function fetchLocalFolderAlbums(): Promise<Album[]>;                     // albums://byType/local_folder（已有路由；新建本地文件夹画册时查重）
// 写命令：签名与原 store 一致，返回值不变；成功后 publishLocal(albumChanges → 批次)
export async function addImagesToAlbum(albumId, imageIds, opts?): Promise<AddToAlbumResult>;
export async function removeImagesFromAlbum(albumId, imageIds, opts?): Promise<RemoveFromAlbumResult>;
export async function addTaskImagesToAlbum(taskId, albumId, opts?): Promise<AddToAlbumResult>;
export async function createAlbum / createLabelAlbum / createLocalFolderAlbum / renameAlbum / moveAlbum /
  deleteAlbum / setLabelKey (...);   // 结构类写命令成功后 publishLocal 一个只含 albumPaths 的批次
```
- **删除** `stores/albums.ts` 整个文件：全量列表、两套直接计数、两套聚合计数与统计、`COUNT_RULES`、
  `appliedSeqs`、`loadingCounts`、`albumImages` / `albumPreviews` 缓存、`loadAlbums` / `ensureAlbumsLoaded`、
  `get_album_direct_counts` 的调用。
- **删除** 后端命令 `get_album_direct_counts`（第二期新增，三处接线一并删），及 `utils/albumMediaTree.ts`
  中 `buildAlbumMediaNodes` / `fetchAlbumDirectCount(s)` / `loadAlbumMediaPreview` 的全量树递归（计数改为点 2 的
  组合查询，封面改走 `album-tree` 路由）。
- **修改** 仅取常量 / 类型的文件改从 `@/services/albums` 导入（albumActions、AlbumDetailPanel、AlbumContextMenu、
  albumDetailRoute、dataChangeHub、dragFileImport、imageLabels 及其测试、WebpageCollectDialog.test）。
- **删除** `App.vue` 启动时的 `loadAlbums()`。

## 点 5.5 — 树基座：分页子项与「加载更多」行（`components/tree/`）

- **修改** `TreeDataSource` 增加可选的分页接口；未实现它的数据源（画廊过滤树）行为不变
```ts
export interface TreeDataSource<T> {
  getKey(element: T): string;
  hasChildren(element: T): boolean;
  getChildren(element: T): T[] | Promise<T[]>;
  /** 新增（可选）：按页取子项（页号从 1 开始）。实现后基座改用它加载，并按 totalChildren 决定是否显示「加载更多」。 */
  getChildrenPage?(element: T, page: number): Promise<T[]>;
  /** 新增（可选）：该元素的子项总数（画册为上一级列举时得到的 childCount）。 */
  totalChildren?(element: T): number;
  /** 新增（可选）：分区根同样分页；本页不满 pageSize 即无更多。 */
  getRootsPage?(sectionId: string, page: number): Promise<T[]>;
  pageSize?: number;   // 缺省 100
}
```
- **修改** `TreeRow` 增加 `{ kind: "load-more"; key: string; parentKey: string | null; sectionId: string }`；
  `TreeNodeHandle` 增加 `hasMore: boolean`；`KbTreePanel` 渲染该行（文案「加载更多」，点击调用 `model.loadMore`，
  加载中显示 loading），`KbTreeRow` 的 DnD / sticky 跳过该行。
- **新增** `useTreeModel` 的 `loadMore(parentKey | { sectionId })`：取下一页追加（按 key 去重，防止翻页间插入导致重复）；
  `refreshChildren(key)` 在分页数据源下逐页重拉已加载的各页（第 1 页到已加载的末页），保持展开态与已翻到的位置；新增只读 `loadedHandles()` 供消费方遍历已加载节点。
- **不改** 基座现有的前端过滤（`filterText` / `getFilterLabel`），画廊过滤树继续使用；画册树不再传这两个选项。

## 点 6 — 画册树：目录即查询（新 `components/albums/AlbumTreeView.vue`，`AlbumTreePanel.vue` 改为包装）

- **新增** `AlbumTreeView.vue`：本点下面描述的数据源、搜索模式、hub 订阅、计数显示全部放在这里，侧边栏与
  选择器（点 8）共用。对外接口：
```ts
defineProps<{
  selectedId: string | null;
  /** 裁剪规则（取代各调用方的 getAlbumTreeExcluding） */
  scope?: {
    sections?: Array<"system" | AlbumRootSection>;   // 显示哪些分区，缺省全部
    kinds?: AlbumKind[];                              // 只列这些类型 → 传给 DSL 的 kind_ 段（点 2）
    excludeIds?: string[];                            // 隐藏这些画册
    excludeSubtreeOf?: string[];                      // 隐藏这些画册及其全部子孙（按 ancestorPath 判断）
  };
  /** 行是否可选：不可选的行置灰但仍可展开（原 AlbumPickerField 的 isSelectable 语义） */
  isSelectable?: (node: AlbumNode) => boolean;
  /** 置于分区之前的静态行（如轮播设置的「全部画廊」），以及末尾「新建画册」行 */
  prependOptions?: { value: string; label: string; desc?: string }[];
  allowCreate?: boolean;
  /** 侧边栏传入拖放控制器与右键；选择器不传 */
  dnd?: TreeDndController<AlbumNode>;
  searchText: string;                                 // 由宿主持有输入框，视图只负责按它切换搜索模式
}>();
defineEmits<{ select: [id: string]; contextmenu: [album: Album, event: MouseEvent]; dblclick: [id: string] }>();
```
  > 说明：`prependOptions` 与 `allowCreate` 的值（`""`、`"__create_new__"`）沿用原组件约定，调用方的
  > 处理逻辑不用改。
- **修改** `AlbumTreePanel.vue` 只保留标题栏菜单、搜索输入框、拖放控制器与右键转发，树本身换成
  `<AlbumTreeView :selected-id :dnd :search-text @select @contextmenu @dblclick />`。

以下为 `AlbumTreeView` 的实现要点：

- **修改** 数据源改为异步目录查询
```ts
const dataSource: TreeDataSource<AlbumTreeNode> = {
  getKey: (n) => n.id,
  hasChildren: (n) => n.childCount > 0,                    // 修改：来自上一级列举，不再看已建好的 children
  getChildren: (n) => fetchAlbumPage({ parentId: n.id }, 1, prefix()).then(toNodes),
  getChildrenPage: (n, page) => fetchAlbumPage({ parentId: n.id }, page, prefix()).then(toNodes),   // 新增
  totalChildren: (n) => n.childCount,
  getRootsPage: (sectionId, page) => /* system 分区取收藏 + 隐藏两行；其余 fetchAlbumPage({ section }, page, prefix()) */,
  pageSize: ALBUM_PAGE_SIZE,
};
// prefix() = 全局 hide 开关对应的前缀；开关切换时 model.reload()（计数口径变了）。
// 隐藏画册自身固定用无前缀路径计数（hide 口径下它恒为 0，沿用现状「显示真实数量」的语义）。
```
- **修改** 过滤框改为**后端搜索模式**
```ts
const searchText = ref("");                                 // 原 filterText，不再传给 useTreeModel
const searchMode = computed(() => searchText.value.trim().length > 0);
const searchRows = shallowRef<AlbumSearchRow[]>([]);
const searchPage = ref(1);
const searchHasMore = ref(false);
// 输入防抖 300ms → searchAlbums(q, 1)；「加载更多」→ searchAlbums(q, page + 1) 追加（按 id 去重）；
// 过期响应按请求序号丢弃（输入变化快于返回时）
```
  搜索模式下 `KbTreePanel` 让位给扁平结果列表：每行图标 + 名称 + 灰字所在路径（标签森林用 `labelPath`，
  其他用 `parentPathNames`）+ 计数；末尾同样有「加载更多」。点击结果：`emit("select", id)` 并清空搜索框，
  回到树模式后按选中画册的 `ancestorPath` 展开祖先链（祖先链上各级首页之外的节点，由 `ensureSelectedExpanded`
  逐级 `loadMore` 直到出现目标，最多追加到其所在页）。右键行为与树行一致。
  > 说明：结果以扁平列表而不是「保留祖先的过滤树」展示，因为后者需要把每个命中的整条祖先链都拉进树，
  > 命中多时退化成全量加载。搜索模式期间订阅 hub，结构类批次（新建 / 改名 / 删除）到来时重拉已加载的页。
- **新增** hub 订阅（`waitMs: GRID_REFRESH_WAIT_MS`）：
```ts
onBatch: async (batch) => {
  if (affectsAlbumDir(batch, null)) await model.reloadRoots();   // 根：各分区重拉已加载的整段，按 key diff 保展开态
  for (const handle of model.loadedHandles()) {                                    // 新增：基座导出已加载节点
    if (affectsAlbumDir(batch, handle.element.ancestorPath)) await model.refreshChildren(handle.key);
  }
},
```
  > 说明：只有已展开（已加载子项）的目录会被检查和重拉；折叠目录零开销。`refreshChildren` 替换该目录的
  > 子节点元素，计数随之更新，不需要单独的计数状态。若 `useTreeModel` 尚无遍历已加载节点的接口，新增
  > `loadedHandles()`（只读，按现有 `refreshLoadedBranches` 的遍历方式实现）。
- **修改** 计数显示：`countOf(node)` 直接读 `node.count`（口径已由列举时的前缀决定）。
- **修改** 选中祖先展开：`selectedAncestorIds` 由选中画册的 `ancestorPath` 解析（点 7 的单画册查询提供），
  不再查 store。
- **修改** DnD 的「目标是否为源的子孙」改为判断 `target.ancestorPath` 是否包含 `/<src.id>/`。
- **删除** 对全量列表拼签名串并整树 `reload` 的 `watch`；删除 `buildAlbumTreeFromFlat` 在本组件的使用。

## 点 7 — 画册页（`views/Albums.vue`）

- **新增** composable `useAlbumQuery(id: Ref<string | null>)`：返回 `{ album, ancestors, count, descendantCount, refresh }`，
  内部 `fetchAlbum` + `fetchAlbumAncestors` + `fetchAlbumCount`（无前缀，右栏显示全量）+ `fetchDescendantCount`，订阅 hub——`affectsAlbumDir(batch, album.ancestorPath 的父路径)`
  或批次的 `albumIds` 含该 id 时重拉。
  > 说明：一个 composable 同时覆盖选中画册名、类型（`isLocalFolder`）、面包屑、统计（`count` /
  > `descendantCount`）、存活校验（`album === null` 即已删除，沿祖先链回落的逻辑改用 `ancestors`）。
- **修改** 右栏统计 `selectedAlbumStats` 读 `count` 与 `descendantCount`；`convertToNormal`
  的子孙数同样读 `descendantCount`；右键菜单 `albumImageCount` 读被右键行（树节点元素已带计数）。
- **修改** 封面：`pathqlFetch("gallery/album-tree/<id>/x1x/1")` 取 1 张，随 `count` 变化重取。
- **修改** 移动 / 新建父级的选择器换成点 8 的 `AlbumPicker`，裁剪规则改写为 `scope`：
  - 移动标签森林画册：`{ sections: ["label"], kinds: ["label_dir"], excludeSubtreeOf: [album.id] }`；
  - 移动普通画册：`{ sections: ["normal"], excludeSubtreeOf: [album.id] }`（原排除收藏 / 隐藏由不显示 system 分区达成）；
  - 新建标签 / 标签目录的父级：`{ sections: ["label"], kinds: ["label_dir"] }`；新建普通画册的父级：`{ sections: ["normal"] }`。
- **修改** 本地文件夹同步目录去重：打开新建对话框且类型为本地文件夹时 `fetchLocalFolderAlbums()` 取一次（量小）。
- **修改** `selectAlbum` 的祖先链：来自被点击的树节点元素（已带 `ancestorPath`）或 `useAlbumQuery` 的结果，
  不再查全量列表。
- **删除** `onMounted` / `onActivated` / `handleRefresh` / `convertToNormal` 里的 `loadAlbums()`；`handleRefresh`
  改为树 `reload` + 选中画册 `refresh` + 网格 `refresh`；删除清 `albumImages` 缓存的循环。

## 点 8 — 其余使用方

- **新增** 选择器 `components/albums/AlbumPicker.vue`（app 侧，取代 core 包的 `AlbumPickerField`）
```ts
defineProps<{
  modelValue: string | null;
  scope?: AlbumTreeViewScope;                // 同点 6
  isSelectable?: (node: AlbumNode) => boolean;
  prependOptions?: { value: string; label: string; desc?: string }[];
  allowCreate?: boolean;
  placeholder?: string;
  pickerTitle?: string;                      // 安卓弹层标题
  clearable?: boolean;                       // 缺省 true
  disabled?: boolean;
}>();
defineEmits<{ "update:modelValue": [value: string | null] }>();
```
  - 触发框：显示当前值的名称——`prependOptions` 命中直接用其 label；是画册 id 时 `fetchAlbum(id)` 取名（值变化时
    重取，画册被删则显示为空并保留原值，交由调用方校验）；`clearable` 时带清除按钮。
  - 桌面：点击触发框弹出下拉面板（`el-popover`，宽度跟随触发框、限高内部滚动），顶部搜索框，下面是
    `AlbumTreeView`；点可选行即回填并收起。面板打开时才挂载树，关闭即卸载（查询与 hub 订阅随之释放）。
  - 安卓：点击触发框打开全高底部弹层（标题 = `pickerTitle`），同样是搜索框 + `AlbumTreeView`，行首箭头逐级
    展开、点行选中后关闭；弹层必须 `useModalBack(visible)`，返回键先关弹层。原滚轮选择器与磨玻璃拍平列表
    （`frosted`）不再使用。
  - 下拉层 / 弹层叠放在 `el-dialog` 之上：层级沿用 `useModal` 的 z-index 分配，实施时核对在对话框内打开不被遮挡。
- **修改** 全部选择器调用方改用 `AlbumPicker`，裁剪规则改写为 `scope` / `isSelectable`：
  - AddToAlbumDialog：目标画册 `{ sections: ["system", "normal", "label"], excludeIds: [HIDDEN, ...props.excludeAlbumIds] }` +
    `isSelectable: n => n.type !== "label_dir"` + `allowCreate`；新画册父级 `{ sections: ["normal"] }`。原「排除全部本地
    文件夹画册」由不显示 `local_folder` 分区达成——各分区自带类型过滤（见点 2），普通树里本就不出现本地文件夹。
  - Crawler / LocalImport / WebpageCollect：输出画册 `{ excludeIds: [HIDDEN] }`；新画册父级 `{ sections: ["normal"] }`。
  - WallpaperRotationTargetSetting：`isSelectable: n => n.type !== "label_dir"`，保留 `prependOptions`；去掉 `frosted`。
  - ImageLabelsPanel 新建标签的父级：`{ sections: ["label"], kinds: ["label_dir"] }`。
  > 说明：以上逐条对应现状的 `getAlbumTreeExcluding(...)` 参数，实施时逐个核对原排除集，行为保持一致。
- **删除** core 包的 `components/album/AlbumPickerField.vue`、仅转发它的 `components/crawler/OutputAlbumSelect.vue`
  （已无使用方），以及 `utils/albumTree.ts` 中只为它服务的 `flattenAlbumTreeForAndroidPicker` /
  `flattenAlbumTreeForFrostedPicker`（实施时确认无其他引用；`buildAlbumTreeFromFlat` 若再无引用一并删除）。
- **修改** `ImageLabelsPanel.vue`：已挂标签用 `fetchImageAlbums(image.id)` 过滤标签叶子；「添加标签」的候选改为
  `AlbumPicker`（`{ sections: ["label"] }`，`isSelectable: n => n.type === "label"`）。现有按 `imageIds` 过滤的
  `album-images-change` 监听保留。
- **修改** `ImageGrid.vue` 复制标签：`fetchImageAlbums(image.id)` → `pickLabelAlbums`；隐藏走
  `services/albums` 的写函数（签名不变）。
- **修改** `HiddenCleanupControl.vue`：`pathqlEntry("gallery/album/<HIDDEN>")` 的总数，订阅 hub（`albumIds` 含
  HIDDEN 时重取）。
- **修改** `BusyFolderSyncCard.vue`：点击时 `fetchAlbum(albumId)` 取 `ancestorPath` 再跳转。
- **修改** `useImageOperations.ts` / `useAlbumOperations.ts`：去掉 `albums` computed 与 `loadAlbums`；需要画册名的
  地方（核对实际用途）改为单画册查询或 `AlbumPicker`；`useAlbumOperations` 第二期已确认无调用方，直接删除。
- **修改** `adapters/album.ts`：写函数改从 `services/albums` 导入；删除 `applyAlbumImagesChanges` 调用
  （已由写函数内部 `publishLocal` 负责）。

## 点 9 — 规则、文档、回归

- **修改** `.cursor/rules/view-mutation.mdc` 与 `AGENTS.md` 摘要：画册数据按需查询、不设全量前端 store；
  画册计数由调用侧组合 pathql 路径得到（直接图片数 / 直接子画册数 / `album-tree` 子树数），全局过滤一律以路径前缀
  表达，不在后端内建口径；新增画册展示入口必须复用 `AlbumTreeView` / `AlbumPicker`，或走单画册查询并订阅 hub；不得重新引入全量画册列表。
- **修改** `cocs/gallery/LABEL_ALBUMS.md`（计数口径改为调用侧组合）、`cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`
  （hub 的画册路径维度、`publishLocal`）、`cocs/provider-dsl/RULES.md`（`subpage_` 分页列举节点的写法、嵌套画册路径必须 `where_clear` 的教训）、
  `cocs/README.md` 对应条目。
- **修改** `versions/latest/regression.md` 追加：
  - 标签迁移（danbooru 1000 张）期间 general 折叠：界面流畅，帧率不受影响；展开 general：每 0.5s 内刷新一次，仍可操作；
  - 展开含几百个子画册的目录：首屏 100 个，末尾「加载更多」，追加后总数与上一级显示的子画册数一致、无重复；翻到第 3 页后
    触发事件刷新，仍停留在已加载的 300 个；根级各分区超过 100 个时同样分页；
  - 树搜索：输入关键字后走后端搜索，能搜到从未展开过的深层画册与标签（按名称、标签 key、标签路径）；结果显示所在路径，
    超过 100 条可加载更多；点击结果选中画册、退出搜索并展开其祖先链；清空搜索框回到原树且展开态不丢；
    关键字含 `%`、`_`、`/` 时按字面匹配；
  - 画册树计数与原口径一致：普通画册含子孙之和、标签目录为子画册数、标签叶子为直接成员数、开关「隐藏」切换口径、隐藏画册固定显示全量；
  - 隐藏 / 取消隐藏 / 加入 / 移出后，已展开目录的计数立即更新（不等 0.5s），随后到达的事件不重复刷新；
  - 新建 / 改名 / 移动 / 删除画册后树立即更新，移动后新旧父目录计数都正确；
  - 画册页：选中画册名、面包屑、统计、封面（自身无图取子孙）、删除选中画册后回落到最近存活祖先；
  - 四个对话框、壁纸轮播设置、画册页移动 / 新建、预览标签面板的画册选择器：下拉面板里按目录展开、每页 100 个可加载更多、
    计数与侧边栏一致、搜索能找到未展开的深层画册；各处的裁剪规则与原先一致（加入画册看不到隐藏画册与本地文件夹、
    标签目录不可选；移动时看不到自身及子孙；标签只能选标签目录作父级）；「全部画廊」等前置项与「新建画册」行仍在；
  - 安卓：选择器打开全高弹层，可逐级展开、搜索、选中后关闭；返回键先关弹层再关对话框；
  - 嵌套画册路径 `gallery/album/<父>/<子>` 的图片与 `gallery/album/<子>` 一致（点 1 的修正）；
  - 预览标签面板：已挂标签、候选、增删；右键「复制标签」；
  - 清理隐藏按钮的数字随隐藏 / 清理变化；忙碌卡片点击跳转到正确画册。

## 实施顺序

点 2 → 点 3（后端（点 1 已完成），`check-kabegame --skip vue`；嵌套路径、子树计数口径、分页、搜索转义的 dsl_e2e 用例用
`test-kabegame kabegame-core --test dsl_e2e`；`deno task pathql:generate`）→ 点 4 → 点 5 → 点 5.5 → 点 6 → 点 8 的 `AlbumPicker`（点 7 要用）→ 点 7 →
点 8 其余 → 点 9（前端，`check-kabegame --skip cargo`）→
用 `kabegame-chromium` 走回归清单，并重跑 danbooru 标签迁移对比帧率；用
`kabegame-cli pathql query <路径> --list --with-count` 在数据库副本上对 general 的一页计时。

## 待核实 / 风险

- ~~`with_count` 每个子项的固定开销~~：已由 `list_with_count` + `prepare_cached` + `idx_albums_parent` 解决（见点 1
  顶部的实测），每项约 30µs，不再是瓶颈。新增的 `albums://children_<id>` 等节点仍按 id 寻址（`resolve` 用 UUID
  正则），避免按名称寻址时单独 resolve 某个子项要重跑父列举。
- 普通画册的子树和按画册逐个取 entry，普通画册多的用户库在展开目录时请求数随之增加；目前普通画册很少，接受。
- `useTreeModel` 的 `reload` 在根查询返回新数组时按 key diff 保展开态——现有注释如此描述，实施时确认对异步
  `roots` 同样成立。
- 选择器改为与侧边栏同构（点 8）后，对话框里打开下拉 / 弹层时才发查询，交互上多一次加载等待（首屏两次列举
  约 4ms，普通画册再各一次 entry）；打开期间订阅 hub，其他来源新建的画册会出现在已展开目录里。
- 安卓弹层内的树：`KbTreePanel` 目前按桌面指针交互设计（悬停、拖放），在弹层里不传 `dnd`，实施时在真机核对
  行高、展开箭头的点击面积与滚动是否顺手。
- 分页期间目录内容变化（新建画册插到已加载页之前）会让下一页偏移错位：追加时按 id 去重可防重复，但可能漏掉
  一个被挤到前页的画册；事件驱动的整段重拉会把它补回来。
- 选中深层画册时祖先链上某一级的目标不在首页：`ensureSelectedExpanded` 需要逐页追加直到目标出现，页数多时
  改为按目标在父目录中的序号直接算出所需 limit（一条 COUNT 查询），实施时视情况二选一。
