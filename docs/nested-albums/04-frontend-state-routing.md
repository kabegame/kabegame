# 前端 Pinia、路由与 URL

## Pinia：`apps/main/src/stores/albums.ts`

- `Album` 类型需增加 **`parentId`**（及树结构所需字段，见 [01-data-model-and-migrations.md](./01-data-model-and-migrations.md)）。
- `loadAlbums` / `createAlbum` / 事件监听：列表按 **父级 id** 拉取一层子节点；根级用「空父」语义（与 [02-storage-api.md](./02-storage-api.md) 一致）。
- 与 Element Plus 等：子画册区可用 **网格 / 列表**；若将来做整树管理视图，再考虑树形表格与懒加载。

---

## 画册详情页 `AlbumDetail` 布局与 **双 Provider**

从 **画册列表** 进入 **画册详情** 后，单页分为上下两块（与 [00-product-decisions.md](./00-product-decisions.md) §2 一致）：

| 区域 | 内容 | 折叠 |
|------|------|------|
| **上** | **子画册**（当前画册的直接子节点，一层） | 可折叠 |
| **下** | **图片网格**（仅本层直接关联的图片，不含子孙画册内图片） | 可折叠 |

**路径语义与列表内容（权威）**

| 路径段 | Provider 列什么 |
|--------|------------------|
| **`tree` 之下**（含 `album/…/tree/<childId>/…` 链） | **只列子画册**，**不列图片**。 |
| **其它段之下**（如直接接 `desc`、`album-order`、`wallpaper-order`、`image-only` 等，无未闭合的「仅 tree」浏览） | **只列本画册内容**（本层图片等），**不通过该 browse 列子画册**。 |

因此 **`AlbumDetail` 必须同时挂接两个 browse provider**（或等价的两条数据源），才能同时渲染 **子画册区** 与 **下方图片网格**：

1. **子画册**：使用落在 **`tree` 语义下**的路径（例如当前上下文对应的 `album/<id>/tree/…` 终点停在「待展开子册」的那一册），由 **tree 专用** provider / 解析分支**只返回子画册列表**。  
2. **网格**：使用 **非 tree 图片浏览**路径（如 `album/<albumId>/desc/1` 等），由 **画册内容** provider **只返回本层图片**，与现有 gallery browse 一致（见 [05-gallery-imagequery.md](./05-gallery-imagequery.md)）。

二者共享同一 **当前画册 id**（及路由 `/albums/:id`），但 **browse 字符串**按上表拆分职责，**不可**指望单一路径同时返回子册 + 图片。同屏展示时：**上半区**用带 **`tree` 链**的路径只拉子册；**下半区**用 **`album/<当前id>/desc/…`**（或其它图片段）只拉图，两路可并行、前缀不必相同，以 **`/albums/:id`** 与解析出的当前册 id 对齐。

**交互建议**

- 两块均支持折叠/展开；折叠状态可写入 **localStorage**（按画册 id 或全局键）。

**数据（实现侧）**

- 子画册区：除 Storage `get_albums(parent_id)` 外，若 browse 层已统一为 provider，则与 **tree 路径**对齐的那条 provider 必须**仅枚举子画册**。  
- 网格：**非 tree** 的 browse 路径，**仅本层图**。

---

## Vue Router（页面级）

- 列表：`/albums` → `Albums`。
- 详情：`/albums/:id` → `AlbumDetail`，**`:id` 表示当前正在浏览的画册节点**（含根画册与任意深度的子画册）。
- **进入子画册**：跳转到**子画册自己的 id**，即 `router.push({ name: 'AlbumDetail', params: { id: childAlbumId } })`。因画册主键全局唯一，**仅一个 id 即可唯一定位节点**，无需在路由里重复写父链。

面包屑（根 → … → 当前）由前端根据 **`parentId` 链** 或专用 API **向上解析**得到，不必全部塞进 `path` 参数。

---

## `albumDetailRoute` 与 **Tree 路径**（browse 字符串）

现状（实现参考 `apps/main/src/stores/albumDetailRoute.ts`、`apps/main/src/utils/albumPath.ts`）：

- 详情内 **筛选 / 排序 / 分页** 同步在 **browse provider 路径**上，形如 `album/<albumId>/…`（含 `desc`、`album-order`、`wallpaper-order`、`image-only` 等段，以现有 `buildAlbumBrowsePath` / `parseAlbumBrowsePath` 为准）。

嵌套画册引入后，在**不破坏现有** `album/<albumId>/…` **解析**的前提下，用固定段 **`tree`** 表达「再进入下一层子画册」。**`tree` 在路径语法里与 `desc`、`album-order`、`wallpaper-order` 等同级**（都是具名段，不是「一串 id 挤在一个 `tree` 后面」）。

**Browse 路径形式（权威）**

1. **根段**：`album/<albumId>/` —— 起点画册 id。

2. **嵌套（交替重复）**：在 `album/<albumId>/` 之后，模式为 **`tree/<childId>/tree/<childChildId>/tree/<…>`**（与口语里的 **`childId/tree/childChildId`** 一致，只是最前还带有 `album/<albumId>/`）。  
   - **`tree` 与 `desc`、`album-order` 一样**，是路径里的**具名段**；每出现 **`/tree/<下一id>`**，表示从**当前链末端画册**再进入其**子画册**。  
   - 可重复多段，例如：`album/A/tree/B/tree/C` 表示 A → B → C，**当前册** = **最后一个 id**（须与 **`/albums/:id`** 一致）。  
   - 若未进入任何子册，则**不出现** `tree`，直接从 `album/<albumId>/` 接排序筛选段。

3. **排序 / 筛选 / 分页（与现网一致）**：`desc`、`album-order`、`wallpaper-order`、`image-only` 等，仍见 `albumPath.ts`。  
   - 这些段出现在 **嵌套链之后**，例如：  
     `album/<albumId>/tree/<c1>/tree/<c2>/desc/1`

4. **`desc` 等段之下：只列本册内容（图），不列子画册**  
   - 一旦出现 **`desc`、`album-order`** 等，**其后不得再出现 `tree` 或子画册 id**。  
   - 该 browse **只提供图片网格**（分页、排序、过滤），**不提供子画册条目**；与 [00-product-decisions.md](./00-product-decisions.md) §2 一致。  
   - 子画册**仅**由 **`tree` 路径对应的 provider** 提供；与 `desc` 等路径是**并列的第二路**挂接，见上文「双 Provider」。

**解析顺序**：先切分出 **`album/<albumId>/`**，再顺序消费 **`(tree, 画册id, tree, 画册id, …)`**，直到碰到 **`desc`、`album-order` 等**已知筛选段，再按现有规则解析尾部。

**用途**：与虚拟盘、CLI、分享链接对齐。**虚拟盘**路径 **`{画册}\子画册\{某个具体子画册}\`** 与 browse **`tree/<childId>`** 对齐（固定目录名 **`子画册`** ↔ 具名段 **`tree`**），详见 [06-virtual-drive.md](./06-virtual-drive.md)。面包屑可与 `…/id/tree/id/tree/…` 一一对应。

**状态存储**：`albumDetailRoute` 除 `albumId`、`filter`、`sort`、`page` 外，可存 **`treeSegments?: { parentId: string; childId: string }[]`** 或等价的 id 链，与 browse 字符串同步。

---

## 详情页其它约定

- **两个 `providerRootPath`（概念上）**：  
  - **Tree**：`album/<albumId>/tree/<childId>/tree/…`（止于当前册、**不接** `desc` 等图片段）—— **只驱动子画册列表**。  
  - **Grid**：`album/<albumId>/…` 且 **不含** 未与图片段衔接的纯 tree 浏览；图片段为 `desc`、`album-order` 等 —— **只驱动图片网格**。  
  子画册切换更新 **tree** 链；排序/筛选/分页只更新 **grid** 路径。
- `AlbumDetailBrowseToolbar`：只作用于 **网格** 的 browse（`desc` 等）；**不**作用于 tree provider。

---

## 小结

|  topic | 约定 |
|--------|------|
| 详情布局 | 上：子画册（可折叠）；下：图片网格（可折叠） |
| 页面路由 | `/albums/:id`，`id` = 当前画册 |
| **双 Provider** | **`tree` 路径只列子画册、不列图**；**`desc` 等路径只列本册图、不列子画册**；`AlbumDetail` **同时挂接两路** |
| Browse 嵌套 | `album/<albumId>/tree/<childId>/tree/…`（`tree` 与 `desc` 同级）；图片段接在链后，如 `…/tree/C/desc/1` |
