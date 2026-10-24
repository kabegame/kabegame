# 过滤走查 Phase E：画册事件协议对齐

> 场景清单见 [zoucha.md](zoucha.md)「画册成员事件发送场景清单」（M1–M25、MN1–MN8、MQ1–MQ13）。
> 本阶段只改协议与机械适配，前端按新事件收紧刷新放在 [phaseF.md](phaseF.md)。与 phaseC / phaseD 无关。

### 总体设计思路

Phase A 把图片事件对齐成了三种形态：表里真正插入的行发 `images-added { seq, images }`（带完整行），真正删除发
`images-deleted { seq, imageIds }`，字段变化按 id 合成补丁，一张图发 `image-changed { seq, patch }`，多张发
`images-change { seq, patches }`。画册方面有两张表，事件还没对齐：

- **`albums` 表**：`album-added` 带完整行但一次一条、没有 seq；`album-changed` 是 `{ albumId, changes }` 增量，
  批量场景（本地文件夹改链、类型转换、同步模式规整）逐条发；`album-deleted` 只发被删子树的根、没有 seq。
  另外，各处 `album-changed` 带不带 `ancestorPath` 全看调用方，前端要么读事件里的路径，要么按通配刷新，没有利用自己手里的路径。
- **`album_images` 表**：所有变化都挤在 `album-images-change` 里，靠七种 reason 区分，其中好几种其实不对应这张表的增删。
  - `hide` / `unhide` 发给隐藏图片所在的其它画册，这些画册的成员行一行都没变；
  - 删画册时，补发一条 `imageIds` 为空的 `order` 代替「成员全没了」，而且这时画册已删，路径查不到。

本阶段让两张表都按「增 / 删 / 改」对齐图片事件：

- **`albums` 表**：
  - `albums-added { seq, albums }` 带完整行；
  - `albums-deleted { seq, albums: [{ id, ancestorPath }] }` 只带被删的根（用户删的那几个，不展开子树）及其路径；
  - 移动单独发 `album-moved { seq, id, oldAncestorPath, newAncestorPath }`，只带被移动的根；
  - 其余字段变化改成 `{ id, ...字段绝对值 }` 补丁，按画册数分流成 `album-changed` / `albums-change`。补丁里**不会出现**
    `parentId` 和 `ancestorPath`，前端处理补丁时不用考虑位置变化。
- **`album_images` 表**：
  - `album-images-added` 与 `album-images-deleted` 只对真实插入和删除的成员行发；
  - `album-images-change` 只对改列（排序）发。
  - 去掉 `reason`，不再发 `hide` / `unhide`，也不再按「图片是否已隐藏」拆两条。

隐藏和收藏不需要专门的事件，它们就是两个系统画册的成员增删。隐藏会改变图片在所有画册里的可见性，但事件**不带**
图片所在的其它画册，也不带图片行，观察方按自己的 hide 开关处理：开了 hide 的视图收到隐藏画册的 added / deleted
就重新查询；没开的视图结果集不变，只按 `imageIds` 给手里的图打 `isHidden` 补丁。这样后端不必为隐藏多收集成员或多读图片，
前端也不用维护「这张图还在哪些画册里」的判断。删图同样会给隐藏画册发 deleted，用 `imagesDeleted: true` 和取消隐藏区分开。

关键决策：

- **移动单独成事件，带新旧两条路径**：位置变化只经 `album-moved` 送达，补丁只发其它真正变化的字段，不为定位补路径。
  `ancestorPath` 形如 `/根/…/自身/`，含每一级祖先的 id，所以有了新旧两条路径，前端可以算出全部影响：
  - 新旧父目录各是哪一个；
  - 哪些观察方在旧子树或新子树下（前缀比较，不要求被移动的画册已加载）；
  - 已加载子孙的路径怎么改写（把 `oldAncestorPath` 前缀换成 `newAncestorPath`）。
  只带根就够，子孙的新路径都由根的前缀替换得到。
- **删除同样带路径**：`albums-deleted` 给每个被删的根带上它的 `ancestorPath`，与移动对称。有了路径，前端不需要被删的画册
  已经加载，按前缀就能算出：
  - 被删的是不是我或我的祖先（被删路径是我路径的前缀）；
  - 是不是我的子孙（被删路径以我的路径开头）；
  - 画册树哪些目录与祖先计数受影响。
  这个路径在 `delete_album` 删除前读出的根画册行里就有，不加查询。
- **删画册只带根，不再补发成员事件**：子孙的路径都以根路径开头，前端按前缀就能认出整棵子树，展开子树不增加信息。
  「这些画册的成员全没了」由 `albums-deleted` 表达。成员 id 要多查一次整棵子树，可能很大，所以不填。
- **凡是会改变位置或计数的事件都带路径，只有补丁不带**：新增、删除、移动、成员事件都可能发生在没加载的画册上，却会改变
  已显示祖先的计数，所以都带 `ancestorPath`。成员事件随下载高频发生，涉及的画册常常是深层的标签叶子，带上路径尤其重要。
  补丁改的名称和行字段只显示在已加载的行上，前端用持有路径定位就够了。
- **成员事件只带单个 `albumId`**：后端本来就按画册拆分，去掉恒为单元素的 `albumIds` 数组。

### 现状锚点

**a. 画册表事件**（`kabegame-core/src/emitter.rs:386-422`）
```rust
// 现状：一次一个画册，没有 seq，没有批量
pub fn emit_album_added(&self, album: &crate::storage::Album) { /* AppEvent::AlbumAdded { id, name, createdAt, parentId, albumType, … } */ }
// 现状：{ seq, albumId, changes }，changes 是增量 JSON，有没有 ancestorPath 由调用方决定
pub fn emit_album_changed(&self, album_id: &str, changes: serde_json::Value) { /* … */ }
// 现状：只发被删的根，没有 seq
pub fn emit_album_deleted(&self, album: &crate::storage::Album) { /* AppEvent::AlbumDeleted { albumId, parentId, ancestorPath } */ }
```

**b. 带不带路径全看调用方的 album-changed**（改后统一只发变化字段，不再补路径）
```rust
// local_folder/sync.rs:73、local_folder/fs_listener/mod.rs:389 —— 现状：同步期间频繁发，没有 ancestorPath
GlobalEmitter::global().emit_album_changed(album_id, json!({ "folderStatus": status_json }));
// storage/albums.rs:964 —— 现状：收藏画册改名（语言切换），没有 ancestorPath
emitter.emit_album_changed(FAVORITE_ALBUM_ID, json!({ "name": name_trimmed }));
// storage/albums.rs:1704-1720 —— 现状：本地文件夹转普通画册，逐条发，没有 ancestorPath
for id in &converted_ids { emitter.emit_album_changed(id, json!({ "albumType": "normal", "syncFolder": null, "folderStatus": null, "syncMode": "none" })); }
// storage/albums.rs:1830-1837 —— 现状：改链改了 parentId，却没有 ancestorPath / oldAncestorPath，前端只能通配
emitter.emit_album_changed(&change.id, json!({ "parentId": change.parent_id, "name": name }));
```

**c. 删除画册**（`storage/albums.rs:866-897`）
```rust
let subtree_ids = self.collect_subtree_album_ids_bfs(album_id)?; // 现状：BFS 拿到了各子画册的 ancestor_path，只留下了 id
// … 一条递归 CTE 删光子树成员，DELETE albums（子画册 ON DELETE CASCADE）
emitter.emit_album_deleted(&deleted_album);                     // 现状：只发根
for id in subtree_ids {
    emit_album_images_order_changed(&id, &[]);                  // 现状：空 order 代替「成员全没了」；画册已删，ancestorPath 退回 "/<id>/"
}
```

**d. 成员事件**（`storage/image_events.rs:65-241`）
```rust
// 现状：一个函数发七种 reason；albumIds 恒为单元素
fn emit_album_images_change(reason: &str, album_id: &str, image_ids: &[String], ancestor_paths: &HashMap<String, String>)
    -> Option<AlbumImagesChangePayload>;
// 加入隐藏画册：HIDDEN 发 add-hidden，图片所在的每个其它画册（含收藏）各发 hide —— 后者的成员行没变
// 加入普通画册：按写后是否在 HIDDEN 拆成 add / add-hidden 两条
// 移出隐藏画册（AlbumMutation）：HIDDEN 发 delete-hidden，其它每个画册各发 unhide
// 整行删图（ImagesDeleted）：每个原属画册发 delete / delete-hidden，HIDDEN 也是 delete-hidden —— 与取消隐藏分不开
```

**e. 不发成员事件的写入口**（zoucha.md MN1–MN5）
```rust
// kabegame/src/ipc/handlers/storage/albums.rs:71-121 —— 现状：直接调 Storage，不发事件、不校验可写
StorageAddImagesToAlbum / StorageRemoveImagesFromAlbum / StorageUpdateAlbumImagesOrder
// kabegame/src/mcp_server.rs:1117-1148、:1186-1195 —— 现状：改序不发事件
```

**f. 前端事件类型**（`apps/kabegame/src/services/kbEvents/events.ts:16-56`）
```ts
export type AlbumImagesChangePayload = {
  seq: number;
  reason: "add" | "add-hidden" | "delete" | "delete-hidden" | "hide" | "unhide" | "order";
  albumIds: string[];
  imageIds: string[];
  ancestorPath: string;
};
export type AlbumChangedPayload = { seq?: number; albumId?: string; changes?: Record<string, unknown> };
"album-added": { id?: string; ancestorPath?: string };
"album-deleted": { albumId?: string; ancestorPath?: string };
```

### 点 1 — `albums` 表事件（`ipc/events.rs`、`emitter.rs`、`storage/albums.rs`、`local_folder/*`）

- **新增**
```rust
// ipc/events.rs
AlbumsAdded { seq: u64, albums: Vec<Album> },
AlbumsDeleted { seq: u64, albums: Vec<DeletedAlbum> },          // 只含被删的根；DeletedAlbum { id, ancestorPath }
AlbumMoved { seq: u64, id: String, old_ancestor_path: String, new_ancestor_path: String }, // 只含被移动的根
AlbumChanged { seq: u64, patch: AlbumFieldPatch },              // 修改：原 { albumId, changes }
AlbumsChange { seq: u64, patches: Vec<AlbumFieldPatch> },
```
```rust
// emitter.rs
/// 画册字段绝对值，只含真正变化的字段；永远不含 parentId / ancestorPath（位置变化走 album-moved）
pub struct AlbumFieldPatch { pub id: String, pub fields: serde_json::Map<String, serde_json::Value> }

pub fn emit_albums_added(&self, albums: &[Album]);
pub fn emit_albums_deleted(&self, albums: &[DeletedAlbum]);
pub fn emit_album_moved(&self, id: &str, old_ancestor_path: &str, new_ancestor_path: &str);
/// 同 emit_image_patches：按 id 合并、空补丁不发、按画册数分流 album-changed / albums-change
pub fn emit_album_patches(&self, patches: Vec<AlbumFieldPatch>);
```
- **修改**
  - **新增入口**：
    - `add_album`、`add_label_album`：`emit_albums_added(&[album])`。
    - `apply_label_assignments`（`:792-796`）与 `add_local_folder_albums_tx`（`:1932-1936`）：把本次新建的画册合成一条 `albums-added`。
  - **删除**：`delete_album` 发 `albums-deleted { albums: [{ id, ancestorPath }] }`，路径取删除前读出的 `deleted_album`。
  - **移动**：凡是改变 `parent_id` 的写入都发 `album-moved`，不再发带 `parentId` 的补丁。
    - `move_album`（`:1990-2090`）：现在已经读了新旧路径，改成 `emit_album_moved(album_id, &old, &new)`。
    - `rechain_local_folder_albums`（`:1731-1840`）：每个改了父级的画册各发一条 `album-moved`。旧路径取自改链前的行，
      新路径取自事务里已经重算的值，不新增查询。同时改了名的，另发 `{ id, name }` 补丁。
      如果一次改链里同时移动了祖先和它的子孙，按祖先在前的顺序发，子孙的 `oldAncestorPath` 取祖先移动之后的路径，
      保证前端按顺序改写前缀时每一步都能对上。
    - `convert_local_folder_album_to_normal`（`:1600-1729`）里被提升到顶层的画册（`lifted`）同样发 `album-moved`。
  - **其余字段变化**：改名、改 labelKey、改同步模式、改 folderStatus、类型转换、收藏画册改名一律走 `emit_album_patches`，
    补丁只含变化的字段，不为定位附带 `ancestorPath`。类型转换、同步模式规整这两种批量场景，一次调用只发一条 `albums-change`。
```rust
// storage/albums.rs —— 删除画册
let subtree_ids = self.collect_subtree_album_ids_bfs(album_id)?; // 不变：只用于删除，不再用于发事件
// … 删除逻辑不变
if let Some(emitter) = GlobalEmitter::try_global() {
    emitter.emit_albums_deleted(&[DeletedAlbum {                 // 修改：只带被删的根及其路径
        id: deleted_album.id.clone(),
        ancestor_path: deleted_album.ancestor_path.clone(),
    }]);
    // 删除：逐个子画册补发空 order
}
```
- **删除**
  - `emit_album_added`、`emit_album_changed`、`emit_album_deleted`；`AppEvent::AlbumAdded` / `AlbumDeleted`。

### 点 2 — `album_images` 表事件（`ipc/events.rs`、`storage/image_events.rs`、`storage/images.rs`）

- **新增**
```rust
// ipc/events.rs —— 三种事件共用一个载荷，事件名区分增 / 删 / 改
AlbumImagesAdded { seq: u64, #[serde(flatten)] body: AlbumImagesPayload },
AlbumImagesDeleted { seq: u64, #[serde(flatten)] body: AlbumImagesPayload },
AlbumImagesChange { seq: u64, #[serde(flatten)] body: AlbumImagesPayload },   // 修改：只剩排序

pub struct AlbumImagesPayload {
    pub album_id: String,
    pub ancestor_path: String,
    pub image_ids: Vec<String>,
    /// 整行删图造成的成员删除；隐藏画册的这类删除不是取消隐藏
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub images_deleted: bool,
}
```
- **修改**
```rust
// storage/image_events.rs
pub fn emit_membership_added(album_id: &str, changed: &[String]) -> Result<(), String> {
    if changed.is_empty() { return Ok(()); }
    // 修改：只取本画册的路径（主键查一次），不再为拆分收集图片的全部成员；不给其它画册发 hide
    emit_album_images("added", membership_payload(album_id, changed, album_ancestor_path(album_id)));
    Ok(())
}

/// 移出画册（含取消隐藏）；修改：去掉 pairs_before / ancestor_paths / context 参数，不再发 unhide
pub fn emit_membership_removed(album_id: &str, changed: &[String]) {
    if changed.is_empty() { return; }
    emit_album_images("deleted", membership_payload(album_id, changed, album_ancestor_path(album_id)));
}

// begin_delete_images_with_events：按删前成员逐画册发 deleted，复用删前已收集的路径，带 imagesDeleted: true

/// 排序：只带 UPDATE 实际命中的 id（修改：原为请求里的全部 id）
pub fn emit_album_images_order_changed(album_id: &str, image_ids: &[String]);
```
  - `toggle_image_favorite_with_event`、`remove_images_from_album_with_event`、本地文件夹同步移出不再预先收集写前成员。
  - `delete_album` 不再调 `emit_album_images_order_changed`（见点 1）。
- **删除**
  - `reason`、`split_by_hidden`、`hidden_image_ids` 与七种 reason 的拆分；`hide` / `unhide` 两条派生事件；`MembershipRemovalContext`。
  - 命令返回值里的 `albumChanges`（`commands/album.rs:150/169`、`commands/image.rs:170/177`、`AddToAlbumResult.album_changes`），前端不消费。

### 点 3 — 补齐不发事件的写入口（MN1–MN5）

- **修改**
  - IPC 的 `StorageAddImagesToAlbum` / `StorageRemoveImagesFromAlbum` / `StorageUpdateAlbumImagesOrder`（`ipc/handlers/storage/albums.rs:71-121`）
    改为调 core 命令（`commands/album.rs`），这样会校验画册可写，并照常发事件。
  - MCP `set_album_images_order` 与 `add_images_to_album` 的 `image_orders` 改序后，各发一条 `album-images-change`。
  - IPC `StorageDeleteAlbum` 改走 `commands::album::delete_album`，补上轮播画册清空和虚拟盘 `bump_albums`。

### 点 4 — 事件注册与非前端订阅方

- **修改**
  - `ipc/events.rs` 的 `app_event_kinds!` 与名称映射（`:68-166`、`:257-266`、`:484`）登记：
    `albums-added`、`albums-deleted`、`album-moved`、`album-changed`、`albums-change`、`album-images-added`、`album-images-deleted`、`album-images-change`。
  - **虚拟盘监听**（`kabegame/src/vd_listener.rs`）：
    - 画册表的五种事件 → `bump_albums()`；
    - 成员事件 → 通知 `albumId` 的目录；隐藏画册事件整体 `bump_albums()`，因为隐藏图在每个画册目录里都是隐藏文件，事件又不带它们在哪些画册。
  - **VS Code 扩展**（`/Users/didi/Code/vscode-kabegame-background-cover/src/KabegameIpcClient.ts:69-77`、`:339-345`）：
    按新事件名订阅，并补订 Phase A 的 `images-added` / `images-deleted` / `image-changed`。

### 点 5 — 前端机械适配（行为与现状等价，不做收紧）

- **修改**
  - **类型**（`events.ts`）：
```ts
export type AlbumImagesPayload = {
  seq: number;
  albumId: string;
  ancestorPath: string;
  imageIds: string[];
  imagesDeleted?: boolean; // 删图造成
};
export type AlbumFieldPatch = { id: string } & Partial<Album>;
export type AlbumMovedPayload = { seq: number; id: string; oldAncestorPath: string; newAncestorPath: string };
// KbEventMap：albums-added { seq, albums }、albums-deleted { seq, albums: { id, ancestorPath }[] }、album-moved: AlbumMovedPayload、
// album-changed { seq, patch }、albums-change { seq, patches }、album-images-added / -deleted / -change: AlbumImagesPayload
```
  - **helper**：`albumChangeKinds` 改读补丁形态。
    - 一条批量事件按画册展开：任一画册相关就算相关。
    - 新增 `albumPatches(payload)`，把单条和批量统一成数组。
    - 新增 `pathHasAlbum(ancestorPath, id)`，判断路径段里有没有某个 id，即「id 是我或我的祖先」。
    - `albumEventPaths` / `albumEventAffectsDir`：`album-moved` 返回 `[oldAncestorPath, newAncestorPath]`；
      `albums-added` / `albums-deleted` 返回各画册的 `ancestorPath`；补丁不再参与位置判断。
    - `albumChangeKinds` 的 `structure` 去掉 `parentId`（补丁里不会再有），移动一律经 `album-moved`。
  - **移动后的前缀改写**：收到 `album-moved` 时，把持有路径以 `oldAncestorPath` 开头的画册行（树节点、页头的自身与祖先链、
    标签面板的标签）改写成 `newAncestorPath` 前缀，后续用持有路径做计算才不会用错。被移动的画册自己的 `parentId`
    取 `newAncestorPath` 的倒数第二段（顶层为 null）。
  - **补丁**（`imagePatches.ts`）：
    - `reduceFavoriteChanges`：收藏画册的 added → `favorite: true`，deleted → `false`。
    - `reduceHiddenChanges`：隐藏画册的 added → `isHidden: true`，deleted 且不是 `imagesDeleted` → `false`。
  - **各订阅方换成新事件、保持现有刷新口径**：
    - 原先依赖 `hide` / `unhide` 的观察方改按 hide 开关处理隐藏画册事件：画册页网格挂 `hiddenTrigger`（hide 开刷新、关时只补丁）；
      画册树 extra 在带 `hide/` 前缀时对隐藏画册事件一律刷新；页头计数不带 `hide/`，不再响应隐藏；
    - 原先依赖空 `order` 的观察方（画廊无画册、标签面板、画册树、侧栏）改听 `albums-deleted`；
    - 原先只听 `album-added` / `album-deleted` 的观察方改听复数事件，按每个画册的 `ancestorPath` 判断，口径与现在相同。
    涉及的文件：
    `adapters/{gallery,album}.ts`、`imageViewRelevance.ts`（`hiddenTrigger`）、`useAlbumQuery.ts`、`AlbumTreeView.vue`、
    `facetTreeSource.ts`、`ImageLabelsPanel.vue`、`ImagePreviewDialog.vue`、`HiddenCleanupControl.vue`、`useSurfImageCounts.ts`。

### 点 6 — 测试、文档

- **后端测试**：
  - `image_events.rs`：加入 / 移出普通画册各发一条、隐藏 / 取消隐藏只发隐藏画册自身一条且不带成员表与图片行、
    删图带 `imagesDeleted`、不再有 `hide` / `unhide`。
  - `albums.rs`：
    - 删画册只发一条、只含根及其真实路径、没有成员事件；批量新建合成一条；
    - 移动、改链、提升到顶层都发 `album-moved`，新旧路径正确，任何补丁都不含 `parentId` / `ancestorPath`；
    - 改链同时移动祖先与子孙时祖先在前，子孙的旧路径接得上祖先移动后的路径。
- **前端测试**：`kbEvents.test.ts`、`imageEvents.test.ts`、`facetTreeSource.test.ts`、`HiddenCleanupControl.test.ts`、
  `ImagePreviewDialog.events.test.ts`、`useTreeModel.test.ts`、`useSurfImageCounts.test.ts`、`useAlbumQuery.test.ts` 换成新事件构造。
- **文档**：
  - `AGENTS.md` 的「图片事件协议」段增补画册两张表的事件，`.cursor/rules/view-mutation.mdc` 同步；
  - `cocs/gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md`：「七种 reason」段改写；
  - `cocs/downloader-tasks/DOWNLOADER_FLOW.md`、`cocs/crawler/METADATA_MIGRATION.md`、`cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`、
    `cocs/gallery/LABEL_ALBUMS.md`；`apps/docs/src/content/docs/reference/mcp.md:374`；
  - `versions/latest/regression.md`、`changelog.md`。

### 验证

| 场景 | 预期事件 |
|---|---|
| 加图到普通画册（含已隐藏的图） | 一条 `album-images-added`，`imageIds` 含全部新增 |
| 隐藏一张在 A、收藏里的图 | 隐藏画册一条 `album-images-added`，只有 `imageIds`；A、收藏不再收到事件 |
| 取消隐藏 | 隐藏画册一条 `album-images-deleted`，只有 `imageIds` |
| 删一张隐藏的图 | `images-deleted`，以及每个原属画册各一条 `album-images-deleted`，都带 `imagesDeleted: true` |
| 拖动排序 | 一条 `album-images-change`，只含实际改序的 id |
| 删带子画册的画册（含折叠分支深处没加载的） | 一条 `albums-deleted`，只含根及其路径，没有成员事件；树里根与已展开的子孙一起消失，祖先计数精确刷新 |
| 下载挂多个新标签 | 一条 `albums-added`，加上每个叶子一条 `album-images-added` |
| 本地文件夹同步 | `album-changed { patch: { id, folderStatus } }` |
| 移动画册（含折叠分支深处没加载的画册） | 一条 `album-moved`，带新旧路径；树的新旧父目录与两侧祖先计数精确刷新，已展开的子孙路径被改写 |
| 本地文件夹改链 | 每个改了父级的画册一条 `album-moved`；改名的另有 `{ id, name }` 补丁 |
| 现有页面 | 刷新行为与改动前一致（phaseF 再收紧） |
| 虚拟盘 / VS Code 扩展 | 隐藏、加图、删画册后目录与背景照常更新 |

### 已知边界

- **hide 开启的视图对隐藏一律刷新**：事件不带图片所在画册和图片行，hide 开的视图对任何隐藏 / 取消隐藏都重新查询，
  即使变化的图与当前视图无关。
- **子孙路径不逐个发**：移动画册时，子孙的 `ancestorPath` 由前端按根的新旧路径前缀改写。
- **删画册不带成员 id**：需要知道哪些图离开画册的观察方（无画册、标签搜索），只能按画册整体判断。
- **外部 IPC 集成**：事件名改了，第三方订阅方需要跟着改。仓库内已知的只有 VS Code 扩展。
