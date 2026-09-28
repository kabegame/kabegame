# 标签目录画册（label_dir）：图片只能挂在叶子标签上

## 背景

现在标签森林里只有一种类型 `label`，同一个节点既能挂图、又能有子标签。插件的 `category` 各段（如
`anime-pictures`、`anime-pictures/character`）也建成 `label`，结果「目录」和「标签」混在一起：目录上
能被手动挂图，计数口径也说不清。改造目标：

- 新增画册类型 `label_dir`（标签目录）：只能装子目录和标签，**不能挂图**；
- `label` 变成叶子：可以挂图，**不能有子画册**；
- 标签目录在树、选择器、详情里显示的数字是**其下直接子画册的数量**，不是图片数。

范围只限标签森林，普通画册与本地文件夹画册的行为不变。

## 总体设计思路

标签森林由两种类型组成：`label_dir` 是内部节点，`label` 是叶子。森林的边界从「`type = 'label'`」
扩成「`type IN ('label', 'label_dir')`」，两种类型共享 `label_key` / `label_path`、同级 key
唯一索引和改 key 能力；区别只有两条结构约束：**`label` 不能当父级**、**`label_dir` 不能有图片成员**。

约束由后端的单一入口兜底：成员写入统一经过 `Storage::add_images_to_album`（全仓库只有它和收藏开关写
`album_images`），在这里拒绝 `label_dir`，下载输出画册、拖入导入、MCP、预览面板等所有路径就都被覆盖；
父级约束收敛到 `insert_label_album` 和 `move_album`。前端的限制（选择器置灰、DnD 拒绝、菜单按类型
出项）只负责体验，不作为安全边界。

插件寻址 `ensure_label_path` 的语义变成：`category` 各段找或建 `label_dir`，叶子找或建 `label`。
如果某一段撞上已有的 `label`（或叶子撞上已有的 `label_dir`），**只跳过这一个标签并记警告**，
同一次下载的其它标签照常挂上（现在 `apply_labels_to_images` 遇错会整批中止，要一起改）。

计数：标签目录的数字在前端 `buildAlbumMediaNodes` 一处算成「直接子画册数」，树、选择器、详情面板
都读同一份 `getAlbumCounts`，不需要各处分别特判；标签目录也不再发逐画册 COUNT 查询。

迁移：v031 还没发布（整个标签功能都未提交），**直接改 v031 与 `init.rs`**，不新增 v032。已经跑过
旧 v031 的只有开发库，用一段一次性 SQL 修正（见点 9）。

## 现状锚点

**a. 森林边界只认 `label`**（`storage/migrations/v031_label_albums.rs`，`init.rs:110` 同样）
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_label_key
    ON albums(COALESCE(parent_id, ''), LOWER(label_key)) WHERE type = 'label';   -- 现状：只覆盖 label
CREATE INDEX IF NOT EXISTS idx_albums_label_path
    ON albums(LOWER(label_path)) WHERE type = 'label';
```

**b. 路径重算**（`storage/albums.rs:1178`）
```sql
SELECT id, '/' || id || '/', CASE WHEN type = 'label' THEN label_key END   -- 现状：只给 label 算 lpath
...
CASE WHEN a.type = 'label' THEN tree.lpath || '/' || a.label_key END
```

**c. 插件寻址：目录段和叶子都建成 `label`**（`storage/albums.rs:500` 起）
```rust
for segment in &spec.segments {
    if let Some(existing) = Self::find_label_child_by_key_ci(&tx, parent_id.as_deref(), segment)? {
        parent_id = Some(existing.id);   // 现状：不看 existing 是什么类型
        continue;
    }
    let album = Self::insert_label_album(&tx, segment, &name, parent_id.as_deref())?; // 现状：建 label
    ...
}
```

**d. 批量挂标签遇错整批中止**（`storage/albums.rs:554`）
```rust
for spec in specs {
    let ensured = self.ensure_label_path(spec)?;   // 现状：一个 spec 失败，后面的全不挂
    ...
    let result = self.add_images_to_album(&ensured.album_id, image_ids)?;
}
```

**e. 成员写入无类型检查**（`storage/albums.rs:748`）
```rust
pub fn add_images_to_album(&self, album_id: &str, image_ids: &[String]) -> Result<AddToAlbumResult, String> {
    let mut conn = self.db.lock()...;
    let tx = conn.transaction()...;
    // 现状：直接 INSERT OR IGNORE，不看画册类型（local_folder 靠命令层 ensure_album_is_writable 拦）
```

**f. 前端计数**（`apps/kabegame/src/utils/albumMediaTree.ts:54`）
```ts
aggregateTotal:
  album.type === "label"
    ? directTotal          // 现状：标签只取直接成员数
    : directTotal + children.reduce((sum, child) => sum + child.aggregateTotal, 0),
```

**g. 前端森林判断散落为 `type === "label"`**：`stores/albums.ts`（`labelAlbums`、`getAlbumTreeExcluding`、
`recomputeLabelPaths`）、`AlbumTreePanel.vue`（图标、`showCount`、DnD、建子标签）、`Albums.vue`
（父级 / 移动候选树、类型切换）、`AlbumDetailPanel.vue`、`imageLabels.ts`、`ImageLabelsPanel.vue`。

**h. 选择器不能按节点禁用**（`packages/kabegame-core/src/components/album/AlbumPickerField.vue`）
```ts
const treeProps = { value: "value", label: "label", children: "children" };  // 现状：没有 disabled
```

## 点 1 — schema 与森林边界（`v031_label_albums.rs`、`init.rs`、`storage/albums.rs`）
- **修改**
  - 两个部分索引的条件改为 `type IN ('label', 'label_dir')`：`label_dir` 也参与同级 key 唯一与路径点查。
  - `rebuild_album_ancestor_paths` 的 CTE 两处 `CASE WHEN type = 'label'` 改为 `IN ('label','label_dir')`。
  - `Album.kind` 注释补上 `"label_dir"`；`label_key` / `label_path` 对两种类型都非空。
  - 新增一个小工具，替换各处 `== "label"` 的森林判断：
```rust
/// 标签森林成员：目录（label_dir）或叶子（label）。
pub(crate) fn is_label_forest_kind(kind: &str) -> bool {
    matches!(kind, "label" | "label_dir")
}
```

## 点 2 — 存储层结构约束（`storage/albums.rs`）
- **修改**
  - `ensure_label_key_unique_ci`、`find_label_child_by_key_ci`：SQL 条件改为森林两类型（同级目录与标签共用 key 空间）。
  - `insert_label_album(conn, key, name, parent_id, kind)`：新增 `kind` 参数（`"label"` / `"label_dir"`）；
    父级必须为空或 `label_dir`，父级是 `label` 时报新错误 `albums.errors.labelLeafNoChildren`，非森林报原 `labelForestIsolated`。
  - `add_label_album(key, name, parent_id, directory: bool)`：按 `directory` 建目录或标签。
  - `set_label_key`：接受两种类型。
  - `add_album`、批量创建、`convert_local_folder_album_to_normal` 的父级判断：`Some("label")` → 两种类型。
  - `move_album`：森林隔离用 `is_label_forest_kind`；被移动的是森林成员时，新父级必须为空或 `label_dir`
    （父级是 `label` → `labelLeafNoChildren`）；key 唯一检查覆盖两种类型。
  - `add_images_to_album`：事务内先查类型，`label_dir` → `albums.errors.labelDirNoImages`：
```rust
let kind: Option<String> = tx.query_row("SELECT type FROM albums WHERE id = ?1", params![album_id], |r| r.get(0)).optional()...;
if kind.as_deref() == Some("label_dir") {
    return Err(t!("albums.errors.labelDirNoImages").to_string());   // 新增：目录不能挂图
}
```
- **新增** i18n（`src-tauri/kabegame-i18n/locales/*.yml` 五种语言）：`labelLeafNoChildren`、`labelDirNoImages`、
  `labelKindConflict`（插件寻址撞类型，见点 3）。

## 点 3 — 插件寻址与批量挂标签（`storage/albums.rs`，调用方 `crawler/downloader/mod.rs`、`plugin/metadata_migration.rs`）
- **修改**
  - `ensure_label_path`：段命中已有节点时要求是 `label_dir`，否则 `labelKindConflict`；未命中建 `label_dir`。
    叶子命中已有节点时要求是 `label`，否则 `labelKindConflict`；未命中建 `label`。
  - `apply_labels_to_images` 改为逐个 spec 容错，返回被跳过的项供调用方写日志：
```rust
pub struct AppliedLabels {
    pub album_ids: Vec<String>,                 // 有新增成员的叶子
    pub skipped: Vec<(LabelSpec, String)>,      // 新增：寻址失败（撞类型等）的标签与原因
}
pub fn apply_labels_to_images(&self, specs: &[LabelSpec], image_ids: &[String]) -> Result<AppliedLabels, String>
```
  - 下载侧 `apply_download_labels`：`skipped` 逐条 `emit_task_log(task_id, "warn", ...)`；迁移侧逐条 `eprintln!`。
  - 相关单测更新（`ensure_label_path` 目录段为 `label_dir`、撞类型跳过、其余照挂）。

## 点 4 — 命令接线（与上一轮 `add_label_album` 同一组位置）
- **修改** `add_label_album` 命令增加 `directory: bool` 参数：`kabegame-core/src/commands/album.rs`、
  `kabegame/src/commands/album.rs`、`web/dispatch.rs`、IPC `ipc.rs` / `client.rs` / `handlers/storage/albums.rs`。
  不新增命令，权限表无需改。

## 点 5 — 标签搜索（`gallery_search_label_query_provider.json5`）
- **修改** token 匹配的 `lm.type = 'label'` 改为 `lm.type IN ('label','label_dir')`；成员侧 `la.type = 'label'` 不变。
  > 说明：精确模式搜目录 key 自然无结果（目录没有成员）；「包含子标签」模式搜目录 key 命中其下所有叶子的图。
- **新增** `tests/dsl_e2e.rs` 一例：按目录 key 做 label-tree 搜索命中子标签的图。

## 点 6 — 前端 store 与计数（`packages/kabegame-core/src/types/album.ts`、`apps/kabegame/src/stores/albums.ts`、`utils/albumMediaTree.ts`）
- **修改**
  - `AlbumKind` 增加 `"label_dir"`，core 导出 `isLabelForestKind(type)`，替换现状 g 里各处森林判断。
  - `normalizeAlbumRow`：两种类型都读 `labelKey` / `labelPath`；`recomputeLabelPaths` 同理。
  - `labelAlbums` 保持「只含叶子」（预览面板候选、复制 key 用）；新增 `labelForestAlbums`（树分区用）。
  - `getAlbumTreeExcluding` 选项：`excludeLabel` / `onlyLabel` 按森林判断；新增 `onlyLabelDir`（新建 / 移动时的父级候选）。
  - `fetchAlbumDirectCounts` 调用前滤掉 `label_dir`（不再为目录发 COUNT）。
  - 计数：
```ts
aggregateTotal:
  album.type === "label_dir"
    ? children.length      // 新增：标签目录显示直接子画册数
    : album.type === "label"
      ? directTotal
      : directTotal + children.reduce((sum, child) => sum + child.aggregateTotal, 0),
```

## 点 7 — 前端交互
- **修改** `AlbumTreePanel.vue`
  - 标签分区用 `labelForestAlbums`；`label_dir` 用文件夹类图标（与本地文件夹区分配色），`label` 保持 PriceTag。
  - `showCount`：去掉「有子标签且为 0 不显示」的特判，目录恒显示子画册数。
  - 标题菜单：「新建标签」「新建标签目录」两项；选中目录时建在它下面，选中叶子时建在它的父目录下。
  - DnD：森林判断改用 `isLabelForestKind`；目标是 `label` 时拒绝（叶子不能有子画册）。
  - 文件拖入（`v-drag-file`）：目标是 `label_dir` 时按「此处不支持」拒绝。
- **修改** `Albums.vue`
  - 新建对话框类型：普通 / 标签 / 标签目录 / 本地文件夹（安卓隐藏本地文件夹）；标签与标签目录共用 key + 名称输入，
    父级候选都用 `onlyLabelDir`；提交走 `createLabelAlbum({ ..., directory })`。
  - 移动候选：森林成员用 `onlyLabelDir`；右键「新建子画册」只对 `label_dir` 出现（出两项：子标签 / 子目录），叶子不出。
  - 中栏：选中 `label_dir` 时显示空态提示「标签目录不能放图片，请放到其下的标签里」，隐藏加图入口。
- **修改** `albumActions.ts`：上下文增加 `isLabelDir`，「修改 key」对两种类型都出；「新建子画册」按上条规则。
- **修改** `AlbumDetailPanel.vue`：`label_dir` 类型名「标签目录」，数量行显示「N 个子画册」。
- **修改** `ImageLabelsPanel.vue`：新建标签对话框的父级选择器用 `onlyLabelDir` 树；候选列表仍是叶子。
- **修改** `AlbumPickerField.vue` 新增 `isSelectable?: (node) => boolean`：桌面 `treeProps` 加 `disabled`，不可选节点置灰但保留层级；
  安卓两个 flatten 函数跳过不可选行（子项照常输出）。图片目标类选择器传 `n => n.type !== "label_dir"`：
  `AddToAlbumDialog`、`CrawlerDialog`、`WebpageCollectDialog`、`LocalImportDialog`、`WallpaperRotationTargetSetting`。
- **新增** i18n（`packages/kabegame-i18n` 五种语言，纯文本追加）：`kindLabelDir`、`treeAddLabelDir`、`detailLabelDir`、
  `labelDirChildCount`、`labelDirNoImagesHint` 等。

## 点 8 — 文档与回归
- **修改** `cocs/gallery/LABEL_ALBUMS.md`（两种类型、约束、寻址撞类型跳过、计数口径）、`cocs/README.md` 条目摘要、
  `cocs/downloader-tasks/DOWNLOADER_FLOW.md`「插件标签」、`cocs/ui/FILE_DROP_ZONES.md`（目录拒绝拖入）、
  `apps/docs/.../dev/v8-api.mdx`（`category` 各段会建成标签目录，与已有标签同名时该标签被跳过）。
- **修改** `versions/latest/regression.md` 标签小节补条目；`versions/latest/changelog.md` 标签条目补一句。

## 点 9 — 开发库一次性修正（不进代码）
v031 已在开发库跑过，库里是旧索引和混合节点。改完代码、重启前执行：
```sql
-- 有子画册的标签改为目录，并清掉它们的直接成员（开发库只有验收时建的 pixiv、pixiv/chara 挂了 2 张）
UPDATE albums SET type = 'label_dir'
 WHERE type = 'label' AND EXISTS (SELECT 1 FROM albums c WHERE c.parent_id = albums.id);
DELETE FROM album_images WHERE album_id IN (SELECT id FROM albums WHERE type = 'label_dir');
DROP INDEX IF EXISTS idx_albums_label_key;
DROP INDEX IF EXISTS idx_albums_label_path;
CREATE UNIQUE INDEX idx_albums_label_key ON albums(COALESCE(parent_id, ''), LOWER(label_key)) WHERE type IN ('label', 'label_dir');
CREATE INDEX idx_albums_label_path ON albums(LOWER(label_path)) WHERE type IN ('label', 'label_dir');
```
> 说明：`anime-pictures` 各分类目录此时都有子标签，会被正确转成目录。

## 不做
- 目录 ↔ 标签的类型互转（空标签转目录等）。
- 普通画册的目录化。

## 验证
1. `.claude/skills/check-kabegame/driver.sh` 全量 0 error。
2. `.claude/skills/test-kabegame/driver.sh kabegame-core --lib albums`、`--lib labels`、`--lib metadata_migration`，以及 `--test dsl_e2e`；
   新增单测：目录拒绝挂图、叶子拒绝当父级 / 移入、寻址撞类型只跳过该项、目录 key 的 tree 搜索。
3. `deno task test -c kabegame --skip cargo`（`galleryQuery` 等既有测试不回归）。
4. 执行点 9 的 SQL 后重启 dev，用 kabegame-chromium 实测：
   - 标签分区 `anime-pictures`、`anime-pictures/character` 显示为目录图标，数字为子画册数；
   - 新建标签目录 / 在目录下建标签；叶子右键无「新建子画册」，把画册拖到叶子上被拒；
   - 加入画册对话框里目录置灰；拖文件到目录被拒；预览面板新建标签时父级只能选目录；
   - 包含子标签模式下搜 `character` 命中其下所有角色标签的图。
