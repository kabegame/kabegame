# 图片标签（标签画册）— 设计与分 Phase 实施计划

> 依据 [prd.md](prd.md)（已确认）。本文替换此前的「`image_labels` 表 + `images.labels` 引用串」草案，
> 该草案整体作废。

## 总体设计思路

**标签就是一种画册**。不新建标签表，也不在 `images` 上加列：`albums` 表新增类型 `type = 'label'`，
再加两列——`label_key`（标签 key）与 `label_path`（从标签森林根到自身的 key 链，派生列）。图片与标签的关系就是现成的 `album_images` 行。于是「加入画册 / 从画册移除 /
删除画册 / 移动画册 / 壁纸轮播 / 虚拟磁盘 / MCP / 计数 / 事件刷新」这些已有链路**原样复用**，
标签的 key、名称、目录也都能改，不影响任何图片行。PRD 要求的「图片上显示直接打上的标签」「同时在
上级和子级就显示两个」也自然成立——预览弹窗查的就是这张图片的 `album_images` 行。

**标签画册的查询与计数口径完全照搬文件夹画册**：中栏内容只含直接成员（`album/<id>` 的
`ai.album_id = <id>` 不改），子标签以子画册出现；树与详情面板的计数沿用前端 `buildAlbumMediaNodes` 的逐级加总
（同一张图同时在上级与子级会算两次，与「图片上显示两个标签」的立场一致）。因此查询层、计数、壁纸轮播、
MCP、「从画册移除」、删除画册都**零改动**；想看整个目录下的图片走「包含子标签」搜索。标签画册与普通画册的
差别只剩三处约束：属于独立的标签森林（不与普通 / 文件夹画册互相嵌套）、有 key、同级 key 唯一。

插件侧的标签用「目录 + key」寻址：`category` 缺省为插件 id，按 `/` 切段后每段都是一个上级标签画册的 key。
`ensure_label_path` 沿树逐级按 key 查找、缺失则创建（名称默认等于 key），最后在叶子上挂图片——只挂叶子，
上级由目录隐含（PRD 2）。插件给的名称**只在创建时使用**，已存在的标签画册永远不改名——用户改过的名称
自然不会被覆盖，也就不需要额外的「用户改过名」标志。
创建时名称撞了同级已有画册（画册名同级唯一的约束对标签同样生效），自动退化为 `名称 (key)`，再撞就用 key
加序号；插件创建永不因撞名失败。

标签来源有三条，都汇到同一个 `ensure_label_path` + `add_images_to_album`：
- **下载新图片**：`Kabegame.downloadImage` 新增 `labels` 选项，入口只做**校验**、不建画册（下载可能失败），
  标签随下载请求搬运，**入库成功那一刻**才建画册并挂图；失败记录表持久化标签 JSON，重试不丢。
- **去重命中**：给已有图片补标签，受现有「去重时更新元数据」开关控制（PRD 3.4）。
- **历史图片**：迁移脚本新增导出 `provideLabels(input)`，在 `migrate` 成功后拿它的返回值调用，得到的标签挂到
  引用该 metadata 行的所有图片上；同时把迁移门控改成「失败也盖版本」。

**按标签搜索**是新的搜索模式 `search/label/<q>`（精确）与 `search/label-tree/<q>`（包含子标签，对应搜索框下
的勾选），`q` 为逗号分隔的 token，token 之间做「且」。含 `/` 的 token 按 `label_path` 匹配，否则按 `label_key`
匹配；比较不区分大小写。逗号列表的拆分由新注册的宿主 SQL 函数 `kb_label_tokens(q)` 完成（返回 JSON 数组，
避免用户输入里的引号把手拼 JSON 搞坏），SQL 用「不存在未命中的 token」做关系除法。

**前端**尽量不加新界面：画册树加一个「标签」分区（与「本地文件夹」分区同构）；新建画册对话框加类型选择，
选「标签」时多一个 key 输入框；画册右键菜单加「修改 key」。预览弹窗在 core 包里，拿不到应用侧的
`albumStore` 与路由，所以 `ImagePreviewDialog` / `ImageGrid` 开一个信息区 slot，由 app 渲染新组件
`ImageLabelsPanel`（列出、删除、添加 / 当场创建、复制、点击跳转）。所有标签画册数据都来自已全量加载的
`albumStore.albums`，面板只需额外查一次「这张图片属于哪些画册」。

关键决策：
- **不新建标签表**：标签与画册共享树、成员、事件、计数，建表只会得到两份需要同步的状态。
- **`label_path` 存派生列而不是查询时递归**：搜索里的完整路径 token 要按 key 链点查；维护时机与
  `ancestor_path` 相同（新增 / 移动 / 改 key 后全量重建），直接并进 `rebuild_album_ancestor_paths`。
- **key 与目录段同一字符集** `[a-zA-Z0-9_-]`、单个不超过 64 字节；**同级 key 唯一且不区分大小写**
  （部分唯一索引 `WHERE type = 'label'`），避免出现只差大小写、搜索时却一起命中的两个标签。目录总长不限。
- **插件 id 收紧为同一字符集**（去掉 `.`），保证「缺省目录 = 插件 id」一定合法。

范围外：VD 里标签画册的目录仍按画册原语义显示「直接成员 + 子目录」（`vd_album_entry_provider` 不改），
子标签以子目录呈现，信息不丢；搜索框联想（PRD 已关闭）。

---

## 现状锚点

**a. `albums` 表与名称唯一索引**（`src-tauri/kabegame-core/src/storage/migrations/init.rs:94`）
```sql
CREATE TABLE albums (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    parent_id     TEXT    REFERENCES albums(id) ON DELETE CASCADE,
    type          TEXT    NOT NULL DEFAULT 'normal',   -- 现状：'normal' | 'local_folder'
    sync_folder   TEXT,
    folder_status TEXT,
    ancestor_path TEXT    NOT NULL DEFAULT '',          -- 现状：id 链 '/root/.../self/'
    sync_mode     TEXT    NOT NULL DEFAULT 'none'
);
CREATE UNIQUE INDEX idx_albums_name_scoped
    ON albums(COALESCE(parent_id, ''), LOWER(name));    -- 现状：同级名称唯一（所有类型）
CREATE TABLE album_images (
    album_id TEXT    NOT NULL,
    image_id INTEGER NOT NULL,
    "order"  INTEGER,
    PRIMARY KEY (album_id, image_id)                    -- 现状：rowid 表
);
```

**b. 画册详情查询只看直接成员**（`providers/dsl/images/gallery/albums/gallery_album_provider.json5`）
```json5
"query": {
    "where": "ai.album_id = ${properties.album_id}"   // 现状：ai 由上游 gallery_albums_router INNER JOIN
},
```
计数同样走这条路径：前端 `fetchAlbumDirectCounts` 取 `pathqlEntry("album/<id>").total`
（`apps/kabegame/src/utils/albumMediaTree.ts`）；轮播 `images://gallery/hide/album/{}/…`（`wallpaper/rotator.rs:71`）、
MCP、`album_preview_at` 也都拼这条路径。

**c. 画册存储的类型守卫**（`src-tauri/kabegame-core/src/storage/albums.rs`）
```rust
pub fn add_album(&self, name: &str, parent_id: Option<&str>) -> Result<Album, String> {
    // 现状：只拒绝父级为 local_folder；INSERT 固定 type = 'normal'
}
pub fn move_album(&self, album_id: &str, new_parent_id: Option<&str>) -> Result<(), String> {
    // 现状：拒绝移动 local_folder、拒绝移入 local_folder / 收藏 / 隐藏；最后 rebuild_album_ancestor_paths
}
pub fn remove_images_from_album(&self, album_id: &str, image_ids: &[String]) -> Result<usize, String> {
    // 现状：DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2（只删直接成员）
}
pub fn delete_album(&self, album_id: &str) -> Result<(), String> {
    // 现状：递归 CTE 删整棵子树的 album_images，再 DELETE albums（parent_id ON DELETE CASCADE）
}
pub(crate) fn rebuild_album_ancestor_paths(conn: &Connection) -> Result<(), String> {
    // 现状：递归 CTE 全量重算 ancestor_path
}
```

**d. 搜索路由枚举五种模式**（`providers/dsl/images/gallery/gallery_search_router.json5`）
```json5
"list": {
    "display-name": { "provider": "gallery_search_display_name_router" },
    "metadata": { "provider": "gallery_search_metadata_router" },
    "native-metadata": { "provider": "gallery_search_native_metadata_router" },
    "local-path": { "provider": "gallery_search_local_path_router" },
    "url": { "provider": "gallery_search_url_router" }   // 现状：无 label
}
```
前端 `GallerySearchPathMode` / `GALLERY_SEARCH_MODES`（`apps/kabegame/src/utils/galleryQuery.ts:55`）与之一一对应；
「任意」模式把全部模式展开成 `~any/…/~or/…/~end`。

**e. 画册树三分区**（`apps/kabegame/src/components/albums/AlbumTreePanel.vue:186`）
```ts
sections: () => [
  { id: "system", roots: () => systemRoots.value },
  { id: "normal", separatorBefore: true, roots: () => normalTreeRoots.value },   // 现状：排除 local_folder
  { id: "local-folders", header: true, separatorBefore: true, roots: () => localFolderRoots.value },
],
// DnD：onDragOver 拒绝拖入 local_folder / 收藏 / 隐藏 / 自身子孙
```
树的计数用 `albumStore.getAlbumCounts(hide)`，即 `buildAlbumMediaNodes` 的 `aggregateTotal = direct + Σchildren`。

**f. 预览弹窗在 core 包，信息区只有两个面板**（`packages/kabegame-core/src/components/common/ImagePreviewDialog.vue:66`）
```vue
<ImageBasicInfoPanel :image="previewImage" :plugins="plugins" fill-when-expanded
  @open-task="emit('open-task', $event)" ... />
<ImageNativeMetadataPanel v-if="isNativeMetadataEligible(previewImage?.type)" :image="previewImage" ... />
<!-- 现状：没有可供 app 注入内容的 slot；ImageGrid.vue:97 渲染本组件 -->
```

**g. 下载选项、迁移 runner、插件 id 校验**
```rust
// plugin/v8/ops.rs:678 —— 现状：只解析 name / url / metadata_id / metadata
fn parse_download_opts(opts: Option<JsonValue>, run: &Task)
    -> Result<(Option<String>, Option<i64>, Option<String>), JsErrorBox>;
// plugin/metadata_migration.rs:24 —— 现状：装载失败整体报错；行失败不盖版本、下次重试；只认 migrate 导出
// app_paths.rs:243 —— 现状：允许 ASCII 字母数字 . _ -；只在拼插件私有目录时调用
pub fn validate_plugin_id(plugin_id: &str) -> Result<(), String>;
```
WebView 侧 `crawl_download_image`（`src-tauri/kabegame/src/commands/crawler.rs:1211`）与 `bootstrap.js` 的
`downloadImage` / `__kb_media_submit__` 两处 invoke 手写参数；去重命中走 `rebind_deduped_metadata`，
已受 `Settings::get_dedup_update_metadata()` 控制（`crawler/downloader/mod.rs:39`）。

---

## Phase 1 — 数据层

### 点 1.1 — 迁移 `v031_label_albums`
- **新增** `storage/migrations/v031_label_albums.rs`，`mod.rs` 注册，`LATEST_VERSION = 31`；`init.rs` 同步 DDL。
```rust
pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(r#"
ALTER TABLE albums ADD COLUMN label_key   TEXT;                        -- 仅 type='label' 非空
ALTER TABLE albums ADD COLUMN label_path  TEXT;                        -- 派生：'pixiv/character/hatsune'
-- 同级 key 唯一（不区分大小写），只约束标签画册
CREATE UNIQUE INDEX idx_albums_label_key
    ON albums(COALESCE(parent_id, ''), LOWER(label_key)) WHERE type = 'label';
CREATE INDEX idx_albums_label_path ON albums(LOWER(label_path)) WHERE type = 'label';
-- 下载失败重试需要还原标签
ALTER TABLE task_failed_images ADD COLUMN labels TEXT;                 -- JSON 数组（已校验的 LabelSpec）
"#).map_err(|e| format!("v031 label_albums: {e}"))
}
```
  > 说明：`idx_albums_name_scoped` 不动，标签画册的名称同样同级唯一，VD 目录名不会撞。

### 点 1.2 — `Album` 模型与 `label_path` 重建
- **修改** `Album`（`storage/albums.rs:26`）增加 `label_key: Option<String>`、`label_path: Option<String>`；`album_from_storage_row` 与所有 `SELECT … FROM albums` 列清单同步
  （`get_album_by_id`、`list_all_albums` 等）；`kind` 注释补 `"label"`。
- **修改** `rebuild_album_ancestor_paths`：同一个递归 CTE 顺带算 `label_path`。
```sql
WITH RECURSIVE tree(id, path, lpath) AS (
    SELECT id, '/' || id || '/', CASE WHEN type = 'label' THEN label_key END
      FROM albums WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, tree.path || a.id || '/',
           CASE WHEN a.type = 'label' THEN tree.lpath || '/' || a.label_key END   -- 新增
      FROM albums a JOIN tree ON a.parent_id = tree.id
)
UPDATE albums SET ancestor_path = tree.path, label_path = tree.lpath             -- 修改
  FROM tree WHERE albums.id = tree.id
```

### 点 1.3 — 标识符校验（单一来源）
- **新增** `storage/labels.rs`
```rust
pub const LABEL_KEY_MAX_BYTES: usize = 64;

/// [a-zA-Z0-9_-]+ 且不超过 64 字节。标签 key、目录每段、插件 id 共用。
pub fn is_label_ident(s: &str) -> bool;

/// 插件 / 迁移脚本传入的原始标签。
#[derive(Debug, Clone, Deserialize)]
pub struct LabelInput { pub key: Option<String>, pub category: Option<String>, pub name: Option<String> }

/// 校验后的标签：segments = 目录各段（缺省为 [plugin_id]）；name 为 None 表示「未提供」。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelSpec { pub segments: Vec<String>, pub key: String, pub name: Option<String> }

/// 不修正、只拒绝：key 缺失 / 不合规；category 有空段或任一段不合规 → Err(原因)。
/// name trim 后为空视为未提供。
pub fn validate_label(input: &LabelInput, plugin_id: &str) -> Result<LabelSpec, String>;
/// 批量：合规项按 (segments, key) 不区分大小写去重保序；不合规项返回 (下标, 原因) 供调用方记日志。
pub fn validate_labels(inputs: &[LabelInput], plugin_id: &str) -> (Vec<LabelSpec>, Vec<(usize, String)>);
```
- **修改** `app_paths.rs::validate_plugin_id` 改用 `is_label_ident`（去掉 `.`；`.`/`..` 分支随之删除），
  测试用例 `Plugin-1_test.example`、`0.1.2` 移到非法组。
- **修改** 插件 id 的入口校验：`plugin/mod.rs` 从 `.kgpg` 文件名取 stem 的两处（`:2040` 附近与 `:3270`）取到后立即
  `validate_plugin_id`，不合规给出可读错误并跳过；CLI `plugin pack` 与 `src-crawler-plugins` 打包脚本同样校验。
  > 说明：现有 22 个插件与内建 `local-import`、`webpage` 均合规。

### 点 1.4 — 单测
- **新增** v031 在旧 schema 上执行；`label_path` 在新增 / 移动 / 改 key 后正确；`validate_label` 各拒绝分支
  （key 缺失、含 `.`/`/`/空格/中文、65 字节；category `a//b`、`/a`、`a/`）与缺省目录；`validate_plugin_id` 拒绝 `.`。

---

## Phase 2 — 标签画册存储 API 与命令

### 点 2.1 — 创建、改 key、改名
- **新增** `Storage::add_label_album(key, name: Option<&str>, parent_id: Option<&str>) -> Result<Album, String>`
```rust
// 父级只能为 None（标签分区顶层）或 type='label'；key 过 is_label_ident；同级 key 唯一（CI）；
// name 缺省 = key，走 ensure_album_name_unique_ci（同级名称唯一，与普通画册一致）；
// INSERT type='label', label_key, label_path = 父 label_path + '/' + key
// → emit_album_added
```
- **新增** `Storage::set_label_key(album_id, new_key)`：仅 `type='label'`；校验 + 同级唯一；
  `UPDATE albums SET label_key`，`rebuild_album_ancestor_paths`（子孙 `label_path` 随之改变），
  `emit_album_changed(id, {"labelKey": …})`。
- **不变** `rename_album`：标签画册改名与普通画册完全相同。
- **修改** `add_album`：拒绝父级为 `type='label'`（普通画册不能进标签森林）。

### 点 2.2 — 移动与移出
- **修改** `move_album`：标签画册只能移到 `None` 或标签画册下，非标签画册不能移到标签画册下；
  标签画册移动时额外校验新父级下 key 不冲突（名称唯一校验已有）。
```rust
let src_is_label = album.kind == "label";
let parent_is_label = parent.as_ref().is_some_and(|p| p.kind == "label");
if new_parent_id.is_some() && src_is_label != parent_is_label {
    return Err(t!("albums.errors.labelForestIsolated").to_string());   // 新增
}
```
- **不变** `remove_images_from_album`：标签画册只显示直接成员，「从画册移除」与预览面板删除单个标签都是删一条直接
  关联，删掉 `character` 不会影响同一张图上的 `hatsune`。
- **不变** `delete_album`：本就递归删除子树成员并级联删除子画册，满足 PRD「子级全部删除」。

### 点 2.3 — 插件标签寻址
- **新增** `Storage::ensure_label_path(spec: &LabelSpec) -> Result<EnsuredLabel { album_id, created: Vec<Album> }, String>`
```rust
// 在一个事务里：
// parent = None
// for seg in spec.segments:        // 中间层
//     parent = find_label_child_ci(parent, seg) 或 insert(key=seg, name=seg)
// leaf = find_label_child_ci(parent, spec.key)
//     存在：直接复用，名称永不改动（spec.name 只在创建时使用）
//     不存在：insert(key, name = spec.name.unwrap_or(key))
// insert 的名称撞同级 → 依次尝试 `name (key)`、`key`；再撞 → `key (2)`、`key (3)`…
// 新建行的 label_path / ancestor_path 直接由父级拼出，不需要全量重建
// 返回叶子 id 与新建画册列表（调用方 commit 后逐个 emit_album_added）
```
- **新增** `Storage::apply_labels_to_images(specs: &[LabelSpec], image_ids: &[String]) -> Result<Vec<String>, String>`：
  对每个 spec `ensure_label_path` 后 `add_images_to_album`，返回受影响的叶子 album id（供发事件）。

### 点 2.4 — 命令接线
- **新增** 命令 `add_label_album`、`set_label_key`、`get_image_album_ids(image_id)`
  （后者返回该图片的全部画册 id，前端据 `albumStore` 过滤出标签），按现有 `rename_album` 的同一组位置接线：
  `kabegame-core/src/commands/album.rs`、`kabegame/src/commands/album.rs`、`kabegame/src/lib.rs`（注册）、
  `permissions/main.toml`（ACL 白名单）、`kabegame/src/web/dispatch.rs`、`ipc/handlers/storage/albums.rs` +
  `ipc/client/client.rs`（CLI/IPC）。
- **新增** i18n 错误：`albums.errors.labelForestIsolated`、`labelKeyInvalid`、`labelKeyExists`（5 种语言）。

### 点 2.5 — 单测
- **新增** 创建 / 改 key；跨森林移动被拒；
  `ensure_label_path` 建出中间层、复用已有且不改名、撞名退化；删除标签画册连子树。

---

## Phase 3 — 查询（PathQL）

### 点 3.1 — 画册内容与计数：不改
- **不变** `gallery_album_provider` 的 `where`、前端 `fetchAlbumDirectCounts` / `buildAlbumMediaNodes`：
  标签画册与文件夹画册同口径（内容 = 直接成员，计数 = 逐级加总）。

### 点 3.2 — 画册行字段
- **修改** `albums_root_provider.json5` 的 `fields` 增加 `label_key`、`label_path`；
  `gallery_album_provider` / `gallery_albums_router` 的 `list` meta 同步补 `labelKey`（树与 MCP 可见）。
- **不变** `albums_by_type_router` 的正则 `([a-z_]+)` 已能匹配 `label`。

### 点 3.3 — 标签搜索
- **新增** 宿主 SQL 函数 `kb_label_tokens(q) -> TEXT`（`storage/dsl_funcs.rs`，`DETERMINISTIC | INNOCUOUS`）：
  按 `,` 切分、trim、丢空项、转小写，返回 JSON 数组字符串。
- **修改** `gallery_search_router.json5` 的 `list` 增加 `"label"` 与 `"label-tree"`。
- **新增** `search/gallery_search_label_router.json5`、`gallery_search_label_tree_router.json5`（照 metadata 的
  router 形态，`(.+)` → query provider），以及共用的 `gallery_search_label_query_provider.json5`
  （`properties: { query, tree: "0" | "1" }`）：
```json5
"where": "NOT EXISTS (SELECT 1 FROM json_each(kb_label_tokens(${properties.query})) tok WHERE NOT EXISTS (SELECT 1 FROM album_images lai JOIN albums la ON la.id = lai.album_id AND la.type = 'label' JOIN albums lm ON lm.type = 'label' AND (CASE WHEN instr(tok.value, '/') > 0 THEN LOWER(lm.label_path) ELSE LOWER(lm.label_key) END) = tok.value WHERE lai.image_id = images.id AND (la.id = lm.id OR (${properties.tree} = '1' AND instr(la.ancestor_path, '/' || lm.id || '/') > 0))))"
```
  > 说明：外层「不存在未命中的 token」= 所有 token 都命中（且）。`resolve ".*"` 委派回 `gallery_route`，
  > 与其它搜索一样可继续接过滤与分页。实现时先确认 DSL 的 sqlparser 接受 `json_each` 表值函数与多层相关
  > 子查询；不接受则把整段判定收进宿主 SQL 函数 `kb_image_has_labels(image_id, q, tree)`。
- **修改** `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` 提到的三个 detail provider（画册 / 任务 / 畅游详情）
  的 resolve 若枚举了搜索模式，同步加入两种新模式。

### 点 3.4 — 单测（`providers` 测试或 `tests/dsl_e2e.rs`）
- **新增** `label` 与 `label-tree` 的且语义、完整路径 token、
  大小写不敏感、输入含 `"` 不报错。

---

## Phase 4 — 插件入口

### 点 4.1 — 下载选项 `labels`
- **修改** `parse_download_opts` 返回具名结构 `DownloadOpts { name, metadata_id, post_url, labels: Vec<LabelSpec> }`；
  `labels` 非数组 → 参数错误；元素经 `validate_labels(.., &plugin_id)`，不合规项写任务日志警告后丢弃。
- **修改** `crawl_download_image` 增加 `labels: Option<Value>`，同样校验；`bootstrap.js` 的 `downloadImage` 与
  `__kb_media_submit__` 两处 invoke 增加 `labels: o.labels ?? undefined`（漏改后者会让 blob/data/MSE 下载静默丢标签）。
- **修改** `DownloadRequest` / `ActiveDownloadInfo`（`#[serde(skip)]`）/ `DownloadQueue::download_image` 增加
  `labels: Vec<LabelSpec>`；`add_task_failed_image` / `upsert_failed_image_on_failure` 写 `task_failed_images.labels`，
  重试时反序列化还原。

### 点 4.2 — 入库时挂标签
- **修改** `postprocess_downloaded_image` 增加 `labels: &[LabelSpec]`：
  - 新图入库成功后 `apply_labels_to_images(labels, &[new_id])`；
  - 去重命中：`Settings::get_dedup_update_metadata()` 为真时对已有图片 `apply_labels_to_images`
    （与 `rebind_deduped_metadata` 并列，含 `queue.rs:1001` 那处）；
  - 新建的标签画册逐个 `emit_album_added`，成员变化发 `album-images-change`。
- **修改** `settings.dedupUpdateMetadataDesc`（5 种语言）补「并补充插件提供的标签」。

### 点 4.3 — 迁移 runner：`provideLabels` + 失败也盖版本
- **修改** `MigrationEngine::load_script` 返回 `{ migrate: Option<Fn>, provide_labels: Option<Fn> }`，两者都缺才算
  装载失败；缺 `migrate` 视为恒等。**新增** `call_provide_labels(f, input) -> Result<Vec<LabelInput>, String>`
  （允许 async，返回值须为数组）。
- **修改** `run_metadata_migrations_for_plugin`：
```rust
let exports = engine.load_script(&script).await.map_err(log).ok();   // 修改：装载失败不再整体返回
for (row_id, data, _) in rows {
    let migrated = /* migrate 成功 → Some；失败或装载失败 → None；无 migrate 导出 → Some(data) */;
    if let (Some(json), Some(f)) = (&migrated, provide_labels_fn) {
        let (specs, rejected) = validate_labels(&call_provide_labels(f, json.clone()).await.unwrap_or_log(), &plugin_id);
        // 先挂标签（此时 images.metadata_id 仍指向 row_id，合并重定向前拿得到全部引用图片）
        let ids = Storage::global().image_ids_by_metadata(row_id)?;          // 新增
        touched_albums.extend(Storage::global().apply_labels_to_images(&specs, &ids)?);
    }
    // 无论成败都盖版本（新增语义）：失败时写回原 data
    changed |= Storage::global().writeback_migrated_metadata_row(
        row_id, &plugin_id, target, migrated.as_deref().unwrap_or(&data))?;
}
// 结束后：新建画册 emit_album_added；touched_albums 非空发一次 album-images-change；
// 原有 images-change(reason="metadata-migrate") 不变
```
- **修改** `cocs/crawler/METADATA_MIGRATION.md`：`provideLabels` 契约、失败也盖版本、排查要点改写。

### 点 4.4 — 类型声明（`packages/kabegame-types` 子模块 + SDK）
- **修改** `lib.kabegame.d.ts`：新增 `KabegameLabelInput`，`KabegameDownloadImageOptions` 增加 `labels`。
```ts
/**
 * App-level image label, shown as a label album in Kabegame.
 * - `key`: required, `[a-zA-Z0-9_-]`, at most 64 bytes.
 * - `category`: `/`-separated parent keys (same charset each); defaults to the plugin id.
 * - `name`: display name, used only when the label is created; defaults to `key`.
 *   Existing labels are never renamed by plugins.
 * Invalid labels are skipped with a warning, never auto-corrected. Labels are only ever added.
 */
interface KabegameLabelInput { key: string; category?: string | null; name?: string | null; }
interface KabegameDownloadImageOptions {
  ...
  /** Labels attached to the image; on a dedup hit, applied only if "update metadata on dedup" is on. */
  labels?: KabegameLabelInput[] | null;   // 新增
}
```
- **新增** `lib.migrate.d.ts` 并在 `index.d.ts` 引用：
```ts
/** `export function migrate(input)`: metadata JSON string in/out; idempotent. Optional (identity if absent). */
type KabegameMigrateFn = (input: string) => string | Promise<string>;
/** `export function provideLabels(input)`: called with migrate's output when it succeeded. */
type KabegameProvideLabelsFn = (input: string) => KabegameLabelInput[] | Promise<KabegameLabelInput[]>;
```
- **修改** `packages/kabegame-plugin-sdk/src/types.ts` 下载选项同步 `labels`，`test-d/smoke.ts` 补用例。
  > 说明：两个子模块分别提交，主仓更新 gitlink。

### 点 4.5 — 单测
- **新增** `parse_download_opts` 的 labels（缺省目录、拒绝项不影响下载、非数组报错）；去重命中受开关控制；
  失败重试还原标签；迁移：`provideLabels` 同步/async、只有 `provideLabels`、`migrate` 抛错时不调用
  `provideLabels` 但仍盖版本、装载失败全部盖版本。

---

## Phase 5 — 前端

### 点 5.1 — 数据与 store（`apps/kabegame/src/stores/albums.ts`）
- **修改** `AlbumKind = "normal" | "local_folder" | "label"`；`Album` 增加 `labelKey`、`labelPath`，
  `albumFromProviderRow` 同步；`album-changed` 事件的增量 patch 处理 `labelKey`（改 key 会改变子孙 `labelPath`，
  直接重拉该子树）。
- **新增** `createLabelAlbum(key, name?, parentId?)`、`setLabelKey(id, key)`；
  **修改** `getAlbumTreeExcluding` 增加 `excludeLabel` 选项。
- **新增** `apps/kabegame/src/utils/labelKey.ts`：`isLabelKey(s)`（与 Rust `is_label_ident` 同规则，给输入框即时校验）。

### 点 5.2 — 画册树与画册页
- **修改** `AlbumTreePanel.vue`：新增 `labels` 分区（header「标签」），`normalTreeRoots` 排除标签；图标 / 颜色区分；
  `onDragOver` 只允许同森林移动（标签 ↔ 标签，或拖到标签分区空白 = 顶层）；标签分区标题菜单「新建标签」。
- **修改** `Albums.vue` 新建对话框：类型选择（普通 / 标签 / 本地文件夹，替换现在的本地文件夹勾选框），选「标签」时
  显示 key 输入（即时校验）与可选名称，父级选择器只列标签森林。
- **修改** `albumActions`：标签画册的右键菜单增加「修改 key」（`ElMessageBox.prompt` + 即时校验）；
  「重命名」「删除」「移动」沿用。`AlbumDetailPanel` 显示 key。
- **核对** 文件拖入：`Albums.vue` 的 `plan()` 对标签画册与普通画册同样放行（导入到当前画册即打标签），预期无需改动。

### 点 5.3 — 预览弹窗标签面板
- **修改** core `ImagePreviewDialog.vue`：信息区（桌面左抽屉与紧凑布局的信息区）新增具名 slot
  `#info-extra="{ image }"`；`ImageGrid.vue` 透传同名 slot。
- **新增** app 组件 `apps/kabegame/src/components/image/ImageLabelsPanel.vue`（经 slot 渲染）：
  - 数据：`get_image_album_ids(image.id)` → 按 `albumStore.albums` 过滤 `type === "label"`，显示名称，
    tooltip 显示 `labelPath`；监听 `album-images-change` / `album-added|changed|deleted` 刷新。
  - 删除：`removeImagesFromAlbum(labelId, [imageId])`（直接关联，与画册视图的「从画册移除」同一函数）。
  - 添加：下拉选择已有标签（本地按名称 / key 过滤 `albumStore` 中的标签画册）→ `addImagesToAlbum`；
    「新建标签」→ 复用新建标签的小表单（key / 名称 / 父级）→ `createLabelAlbum` 后加入。
  - 复制：按钮把标签 key 用 `", "` 连接写入剪贴板。
  - 点击标签：跳到画册页并选中该标签画册（复用树 / `albumIdPath` 的导航入口）。
  - Android 模态层：内部弹层调用 `useModalBack`。
- **修改** 图片右键菜单（app 侧 image actions）新增「复制标签」，无标签时禁用。

### 点 5.4 — 标签搜索
- **修改** `galleryQuery.ts`：`GallerySearchPathMode` 增加 `"label" | "label-tree"`；UI 层把两者合并成一个
  「标签」tab + `includeChildren` 勾选（`GallerySearchTerm` 增加该字段，序列化时二选一）；「任意」模式**不**展开
  标签模式（输入语法不同）；`GALLERY_SEARCH_MODES` 与 `GALLERY_SEARCH_MODES_BASIC` 都加入。
- **修改** `GalleryQueryBar.vue`：标签 tab 下方显示「包含子标签」勾选；placeholder 提示英文逗号分隔。
- **修改** `galleryQuery.test.ts` / `GalleryQueryBar.test.ts`：序列化往返、勾选切换、与其它维度组合。

### 点 5.5 — i18n
- **新增** 5 种语言：标签分区标题、新建类型、key 输入与校验提示、修改 key、标签面板（添加 / 新建 / 复制 / 空态）、
  搜索 tab 与勾选、错误文案；`dedupUpdateMetadataDesc` 更新。

---

## Phase 6 — 文档、样例、回归、验证

- **修改** 一个样例插件（建议 `anime-pictures`，metadata 已有 `tagGroups`）：下载时传 `labels`，迁移脚本加
  `provideLabels`，升插件版本。
- **新增** `cocs/gallery/LABEL_ALBUMS.md`（数据模型、与文件夹画册同口径的内容与计数、`label_path` 维护、插件寻址与撞名退化、
  搜索 SQL、前端入口）并登记到 `cocs/README.md`；**修改** `METADATA_MIGRATION.md`、`DOWNLOADER_FLOW.md`（标签在
  入库时挂载、失败记录持久化）、`FILE_DROP_ZONES.md`（标签画册可拖入）、`docs/PLUGIN_FORMAT.md` / `apps/docs`。
- **新增** `versions/v4.4.1/regression.md` 回归项：新建 / 改 key / 改名 / 移动 / 删除标签画册；跨森林拖动被拒；
  标签画册只显示直接成员、计数逐级加总；预览里增删 / 新建 / 复制 / 跳转，删上级不影响子级；
  标签搜索（且、包含子标签、完整路径）；插件下载带标签、去重命中受开关控制、已有标签的名称不被插件改动；
  插件升级后历史图片补标签、失败也盖版本；含 `.` 的插件 id 被拒绝；壁纸轮播使用标签画册。
- **验证**：`check-kabegame` skill（`--skip vue` / `--skip cargo`）；`test-kabegame` skill 按名过滤
  （`albums`、`labels`、`metadata_migration`、`v031`、DSL e2e）；前端 `deno task test -c kabegame --skip cargo`；
  UI 用 `kabegame-chromium` skill 在真实 app 里核对树分区、对话框、预览面板与搜索。
