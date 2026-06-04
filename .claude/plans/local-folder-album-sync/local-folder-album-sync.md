# 本地文件夹同步画册（local_folder album） — 根计划

> Phase 1~6：macOS-only 落地（创建 / 同步 / UI / 只读约束 / 手动刷新）。
> Phase 7：跨平台实时监听（macOS / Windows / Linux），独立可选开关。
> 每个 Phase 设计为可独立完成的提交单元：前一个 Phase 完成后，分支应可编译、可运行、可暂停，再开下一个 Phase。

参考实现：[test/native-auto-import/src/main.rs](../../test/native-auto-import/src/main.rs)
（其中 mdfind / NSMetadataQuery / watch 模式属于"原生发现 + 实时监听"，本计划**暂不引入**，只复用其中"directory scan + (size, mtime) 指纹 + stable 过滤"的最小子集做"按需同步"。Spotlight/FSEvents 留待 Phase 7 以后。）

---

## 设计概览（共享前置知识）

### 数据模型

`albums` 表新增列：

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | TEXT NOT NULL DEFAULT `'normal'` | `'normal'` | `'normal'` \| `'local_folder'`（未来可加 `'smart'` 等） |
| `sync_folder` | TEXT NULL | NULL | 当 `type='local_folder'` 时为绝对路径；其它类型为 NULL |
| `folder_status` | TEXT NULL | NULL | JSON 字符串：`{"state":"ok"\|"missing"\|"denied"\|"not_a_dir"\|"io_error", "message":"...", "checked_at": <unix_secs>}` |

约束：`type='local_folder' ⇔ sync_folder IS NOT NULL`，由 Rust 层保证（不加 CHECK，避免遗留数据卡死）。

### 关键不变量

1. **只读**：`type='local_folder'` 的画册及其后代 local_folder 子画册（递归创建产生），均不可执行 `add_images_to_album` / `remove_images_from_album` / `set_album_images_order` / `add_task_images_to_album` 等"修改图片集合"的操作；可以 `rename_album` / `move_album` / 编辑 metadata。
2. **一对一**：一个 local_folder album 只对应一个**非递归**文件夹（递归是创建期的展开，不是同步语义）。
3. **同步事件化**：所有同步副作用通过既有 `images-change` / `album-images-change` 事件发布，前端被动刷新。
4. **不阻塞启动**：启动期同步走 `tauri::async_runtime::spawn`，不进入 setup() 关键路径。

### 同步算法（单画册，非递归）

```
sync_album(album):
  1. fs::metadata(sync_folder)
     - 不存在 → 写 folder_status={missing}, 发 album-images-change(meta), return
     - 不是目录 → not_a_dir
     - 权限不足 → denied（macOS 上识别 EPERM）
     - 其它 IO → io_error
  2. fs::read_dir 非递归收集子项：
     - 过滤：file_type().is_file() == true
     - 过滤：kabegame_core::image_type::is_image_or_video_by_path
     - 收集 (path, size, mtime)
  3. 查询 DB 中该 album 现有 image_ids 及其 (local_path, size, modified_or_crawled_at)
  4. 三方 diff：
     a. fs only          → 新增 → 走 local_import 单文件路径（不创建 task），加入 album
     b. db only          → 删除（仅 album_images，可选 hard-delete images：见决策 D1）
     c. 两边都有
        - 文件 mtime > 入库时间 阈值（>= 1s）→ 计算 sha256，与 images.hash 比对
          - 不一致 → 先 delete_images_with_events（仅本图片），再重新 import
          - 一致 → 跳过
        - 否则跳过
  5. 写 folder_status={ok, checked_at=now}
  6. 由 image_events.* 自动发 images-change / album-images-change
```

**决策 D1（待与用户确认，第一版默认）**：DB-only 的图片（用户从文件系统删除了文件）→ 在 album_images 移除并 hard-delete images（包括缩略图），因为这些图片"原始来源就是本地文件夹"。先实现 hard-delete，留 TODO 注释，便于后续改成 soft-delete。

### 模块布局（新建文件）

```
src-tauri/kabegame-core/src/local_folder/
  mod.rs              // 公开入口：sync_album, sync_all_local_folder_albums, sync_albums_by_ids
  scan.rs             // 非递归目录扫描 + (size, mtime) 指纹 + stable_for 过滤（裁剪自 probe）
  sync.rs             // diff/apply 算法
  status.rs           // FolderStatus 枚举与序列化
```

存储改动：`src-tauri/kabegame-core/src/storage/albums.rs` 扩展 `Album` 结构、`add_album`、新增 `add_local_folder_album` / `list_local_folder_albums` / `update_album_folder_status`。

前端：`apps/kabegame/src/views/Albums.vue` 创建弹窗增字段；`AlbumCard.vue` 适配；`stores/albums.ts` 增字段；新增 IPC `sync_local_folder_album`、`sync_local_folder_albums` 命令。

---

## Phase 1 — Schema 扩展与基础读写

**独立产出**：DB 多了三列，Rust 与前端的 Album 结构带新字段，但暂无任何同步逻辑。普通画册创建/列表完全不受影响。

### 任务

1. 新增迁移 [src-tauri/kabegame-core/src/storage/migrations/v013_album_type_and_sync.rs](../../src-tauri/kabegame-core/src/storage/migrations/v013_album_type_and_sync.rs)：
   - `ALTER TABLE albums ADD COLUMN type TEXT NOT NULL DEFAULT 'normal';`
   - `ALTER TABLE albums ADD COLUMN sync_folder TEXT;`
   - `ALTER TABLE albums ADD COLUMN folder_status TEXT;`
   - 不需要回填，已有数据全部 type='normal'。
2. 在 [migrations/mod.rs](../../src-tauri/kabegame-core/src/storage/migrations/mod.rs) 注册并 `LATEST_VERSION = 13`。
3. 同步 [migrations/init.rs](../../src-tauri/kabegame-core/src/storage/migrations/init.rs) 的 `CREATE TABLE albums` DDL（三列追加）。
4. 修改 [storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs)：
   - `Album` 结构追加 `pub r#type: String, pub sync_folder: Option<String>, pub folder_status: Option<String>`（保持 camelCase 序列化：`type`、`syncFolder`、`folderStatus`）。
   - `album_from_storage_row` 读出 6 列。
   - 所有 `SELECT id, name, created_at, parent_id` 查询改为 `SELECT id, name, created_at, parent_id, type, sync_folder, folder_status`（grep 全部命中点统一改）。
   - 现有 `add_album` 保持签名不变，写入时 `type='normal'`。
5. 前端 [stores/albums.ts](../../apps/kabegame/src/stores/albums.ts) `Album` 接口加 `type: 'normal' | 'local_folder'`, `syncFolder: string | null`, `folderStatus: FolderStatus | null`；`normalizeAlbumRow` 兼容 snake/camel。
6. 同步检查所有 provider DSL 中 `SELECT ... FROM albums` 的字段列表（[providers/dsl/albums/*.json5](../../src-tauri/kabegame-core/src/providers/dsl/albums/) 与 [providers/dsl/images/vd/album/*](../../src-tauri/kabegame-core/src/providers/dsl/images/vd/album/)），扩展返回字段。

### 验收

- `bun check -c kabegame --skip cargo` 通过；`cargo check -p kabegame-core` 通过。
- 启动旧库 → 升级到 v13 后，所有现有画册 `type='normal'`，行为完全一致。
- 启动全新库 → albums 表 6 列齐备。

---

## Phase 2 — 同步算法核心（纯函数 + 单元可测）

**独立产出**：可以在 Rust 单测里跑一遍"给定文件夹 + 给定 album_id"完成一次同步，但还没有 IPC 暴露。

### 任务

1. 新建模块树 `src-tauri/kabegame-core/src/local_folder/{mod.rs,scan.rs,sync.rs,status.rs}`，在 [lib.rs](../../src-tauri/kabegame-core/src/lib.rs) 加 `pub mod local_folder;`。
2. `status.rs`：定义 `FolderStatus` 枚举（`Ok`, `Missing`, `Denied`, `NotADir`, `IoError(String)`）与 `to_json_string`、`checked_at`。
3. `scan.rs`：
   - `fn scan_dir(path: &Path) -> Result<Vec<LocalFile>, FolderStatus>`，其中 `LocalFile { path, size, mtime_unix_ms }`。
   - **非递归**，过滤 `is_image_or_video_by_path`，过滤非普通文件，遇 EPERM 映射 Denied，遇 NotFound 映射 Missing。
   - 复用 [test/native-auto-import/src/main.rs](../../test/native-auto-import/src/main.rs) 的 stable_for 思路：mtime 距 now < `STABLE_FOR_MS`（默认 3s）的文件**跳过**（仍在写入），下次扫描再纳入。
4. `sync.rs`：
   - `fn diff(fs: &[LocalFile], db: &[DbImageRow]) -> Plan { adds, deletes, reimports }`。
   - `reimports` 触发条件：`local_path` 匹配 且 `mtime_unix_ms > crawled_at*1000 + 1000` 且 `sha256(file) != db_row.hash`。
   - sha256 流式计算（复用 downloader 现有 hash 工具，若已有；否则新增 `crate::utils::hash::sha256_file`）。
5. `sync.rs`：
   - `pub async fn sync_album(album_id: &str) -> Result<SyncReport, String>`：
     - 查 album（必须 type='local_folder'），取 sync_folder。
     - 调 scan_dir → 失败时写 folder_status，返回 Ok(SyncReport::skipped(status))。
     - 查 DB 现有：`SELECT i.id, i.local_path, i.size, i.crawled_at, i.hash FROM images i JOIN album_images ai ON ai.image_id=i.id WHERE ai.album_id=?`。
     - 算 diff → 顺序执行 deletes → reimports（delete + add）→ adds。
     - delete：`image_events::delete_images_with_events(&ids, true)`。
     - add：调用 Phase 4 的单文件 import 路径（Phase 2 先用占位 `todo!()` 或直接调用 `crawler::local_import` 中可复用的 import_single_file，**抽出**而非新写）。
     - 更新 folder_status='ok'。
6. 在 [crawler/local_import.rs](../../src-tauri/kabegame-core/src/crawler/local_import.rs) 抽出"导入单个本地文件路径到指定 album，不创建 task"的内部函数（命名建议 `import_single_local_file_into_album`）；不破坏现有 `run_builtin_local_import` 的 task 流程。

### 验收

- `cargo check -p kabegame-core` 通过。
- 加一个 `#[cfg(test)] mod tests` 用 `tempfile` 在 tmp 目录里跑一遍 add/delete/reimport 三条路径。
- 不影响现有任意命令。

---

## Phase 3 — 启动期同步 + IPC 命令

**独立产出**：后端可被前端调用做同步；启动时自动扫描所有 local_folder album。

### 任务

1. 在 [storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) 新增：
   - `pub fn list_local_folder_albums(&self) -> Result<Vec<Album>, String>`
   - `pub fn update_album_folder_status(&self, album_id: &str, status_json: Option<&str>) -> Result<(), String>`
2. 在 [commands/album.rs](../../src-tauri/kabegame-core/src/commands/album.rs) 新增并在 [lib.rs](../../src-tauri/kabegame/src/lib.rs) `tauri::generate_handler!` 注册：
   - `#[tauri::command] sync_local_folder_album(album_id: String) -> Result<SyncReport, String>`
   - `#[tauri::command] sync_local_folder_albums(album_ids: Vec<String>) -> Result<Vec<SyncReport>, String>`
3. 启动期任务（在 `lib.rs::run()` setup 内部、`tauri::async_runtime::spawn` 之中，**不 await**）：
   ```rust
   tauri::async_runtime::spawn(async {
     match Storage::global().list_local_folder_albums() {
       Ok(albums) => for a in albums {
         let _ = kabegame_core::local_folder::sync_album(&a.id).await;
       }
       Err(e) => log::warn!("list local folder albums failed: {e}"),
     }
   });
   ```
4. 同步函数内部确保串行执行单画册，但跨画册可以并发（先串行，后续优化）；每个画册 sync 出错只 log + 写 folder_status，**不向上传播 panic**。
5. 同步检查 web 模式 [src-tauri/kabegame/src/web/dispatch.rs](../../src-tauri/kabegame/src/web/dispatch.rs) 是否也需要暴露新命令（依用户使用场景，第一版可不接入 web）。

### 验收

- 手工 INSERT 一条 `type='local_folder', sync_folder='/tmp/xxx'` 的 album，重启 app → 看到 album 拉到该目录下图片；命令调用同步成功，事件触发前端刷新（用 DevTools 监听 `album-images-change` 验证）。

---

## Phase 4 — 创建弹窗 + 递归创建逻辑

**独立产出**：用户能在 UI 里勾选"本地文件夹画册"、选择路径、决定是否递归创建，完成后看到画册结构。

### 任务

1. 后端新增 [storage/albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs)：
   - `pub fn add_local_folder_album(&self, name, parent_id, sync_folder) -> Result<Album, String>`：写入 `type='local_folder'`，初始 `folder_status=NULL`。校验路径非空、非根 `/`。
2. 后端新增 IPC：
   - `add_local_folder_album(name, parent_id, sync_folder, recursive: bool) -> Result<Vec<Album>, String>`
   - 当 `recursive=true`：
     - 同步遍历 `sync_folder` 的所有子目录（递归），收集 `(relative_path, abs_path)`。
     - 顶层创建一个 `name` 的 local_folder album 指向 `sync_folder`。
     - 每个子目录创建一个 local_folder album：
       - 名称：`"<userName>-<seg1>-<seg2>-...-<segN>"`（按用户示例：Pictures/person/girl + name="图片" → "图片-person"、"图片-person-girl"）。
       - parent_id：父目录对应 album 的 id（用 HashMap<PathBuf, AlbumId> 跟踪）。
       - sync_folder：子目录的绝对路径。
     - 失败时**整体回滚**（事务包裹所有 album insert）。
     - 返回所有创建的 Album（顶层 + 子），让前端一次性更新 store。
   - 当 `recursive=false`：只创建顶层一个。
   - 创建后 spawn 异步首轮 sync（不阻塞返回）。
3. 前端 [Albums.vue](../../apps/kabegame/src/views/Albums.vue) 创建弹窗：
   - 新增 `el-checkbox v-model="isLocalFolder"`：「本地文件夹画册」。
   - 勾选后展开：
     - `el-button` 调 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })` 选目录（或 picker plugin）；显示已选 `sync_folder`。
     - `el-checkbox v-model="recursive"`：「递归创建子文件夹画册」。
   - 创建按钮：
     - 未勾选 → `albumStore.createAlbum(name)`（原路径）。
     - 勾选 → 新 store 方法 `albumStore.createLocalFolderAlbum(name, syncFolder, recursive)`，调用新 IPC。
4. [stores/albums.ts](../../apps/kabegame/src/stores/albums.ts) 加 `createLocalFolderAlbum` 方法 + 处理返回的多 album 数组写回 `albums.value`。

### 验收

- 弹窗 UI 完成；勾选展开 + 选路径正常；
- 非递归：创建 1 个画册，刷新页面同步生效。
- 递归：例 `~/Pictures/person/girl` + 名称"图片"+ 递归 → 创建 3 个画册（"图片"/"图片-person"/"图片-person-girl"），层级 parent_id 正确。

---

## Phase 5 — 卡片视觉 + 只读约束

**独立产出**：UI 视觉区分 local_folder 画册；底层写操作对 local_folder 拒绝。

### 任务

1. [AlbumCard.vue](../../apps/kabegame/src/components/albums/AlbumCard.vue)：
   - `computed isLocalFolder = album.type === 'local_folder'`。
   - 标题样式：`isLocalFolder` 时给 `.title` 加 class，背景紫色渐变（建议 `linear-gradient(135deg, #a78bfa, #7c3aed)` + `-webkit-background-clip: text; color: transparent;`），保持字号一致。
   - meta 行：`isLocalFolder` 时**隐藏** `createdAtPrefix` 那条 `<span>`，**显示**新 `<span>` 内容为 `{{ album.syncFolder }}`（路径过长用 CSS `text-overflow: ellipsis` + `title` 属性悬浮显示完整）。
   - 若 `folderStatus.state !== 'ok'` 显示一个小红点 + tooltip 提示状态原因。
2. i18n 加 key：`albums.localFolder.title`、`albums.localFolder.recursive`、`albums.localFolder.choosePath`、`albums.localFolder.statusMissing` 等（覆盖至少 zh、en）。
3. 后端只读约束 — 在以下入口加 helper `ensure_album_is_writable(album_id)` 早返回错误：
   - `storage/image_events.rs`：`add_images_to_album_with_event`、`remove_images_from_album_with_event`、收藏切换、设置 order。
   - `storage/albums.rs`：任何"修改 album_images 集合"的方法（grep `album_images` 全部点）。
   - 不阻断的：`rename_album`、`move_album`、删除整个 album（同时清理 sync 记录无副作用）。
4. 前端 UX 兜底（不依赖后端报错）：
   - AlbumDetail.vue 工具栏：detect `currentAlbum.type === 'local_folder'` → 隐藏/禁用「添加图片」「从图片移除」「拖入导入」「重排」入口；保留「重命名」「编辑元数据」。
   - 右键菜单同步处理。
   - 拖拽到 AlbumCard：拒绝并 toast 提示。
5. 删除 local_folder album 行为：默认**只删 album 与 album_images 关系，不删 images 本体**（即用户对外仍能在画廊看到这些图片）。在删除前 confirm 弹窗里说明。

### 验收

- 视觉：本地文件夹画册标题紫色渐变、副信息显示路径而非时间。
- 写操作：调用 add_images_to_album 等返回错误；UI 入口已隐藏。
- 状态异常时小红点 + tooltip。

---

## Phase 6 — 手动刷新触发 + 可见画册同步

**独立产出**：用户在 Albums/AlbumDetail 页下拉刷新时，可见的 local_folder 画册被同步。

### 任务

1. 在 [Albums.vue](../../apps/kabegame/src/views/Albums.vue) `handleRefresh`：
   - 现有刷新调用之后，收集 `displayedAlbumRoots` 中 `type==='local_folder'` 的 id 列表（连同其在 store 中的递归子 local_folder 子画册——可选；第一版只刷新可见的顶层节点）。
   - `await invoke('sync_local_folder_albums', { albumIds })`，错误吞下 + console.warn（不阻断刷新）。
   - 完成事件天然触发 store 重拉。
2. 在 [AlbumDetail.vue](../../apps/kabegame/src/views/AlbumDetail.vue) 的 `handleRefresh` 中：
   - 若当前 album 是 local_folder → `invoke('sync_local_folder_album', { albumId })`。
3. 右键菜单 / 卡片操作菜单为 local_folder album 增加「立即同步」入口，调用同上命令。

### 验收

- 在 Finder 改动文件夹（增/删/改）后下拉刷新，看到画册图片同步更新。

---

## Phase 7 — 跨平台实时文件夹监听（详见 [phase7](./local-folder-album-sync-phase7.md)）

**独立产出**：Albums 页 settings drawer 新增「实时同步文件夹」开关（默认关）；开启后后台 task 用平台原生 API 监听所有 local_folder album 的源目录，文件变化时自动调用 Phase 3 的 `sync_album`。

### 关键设计

- **开关**：新 app 设置 `realtimeFolderSync: Bool = false`（opt-in），注册到 `pages: ["albums"]`。
- **平台**：macOS / Windows / Linux 各自原生实现；Android / iOS noop。
  - macOS：`FSEventStreamCreate` + 在回调过滤 `path.parent() == watched`（FSEvents 总是递归）。
  - Windows：`ReadDirectoryChangesW` per album，`bWatchSubtree = FALSE`。
  - Linux：单个 inotify fd + 多个 `inotify_add_watch`，mask 含 CREATE/DELETE/MOVED_*/CLOSE_WRITE/ATTRIB。
- **零新依赖**：仅用项目已有 `windows-sys` / `core-foundation`（macOS target dep）/ `libc`；**不**引入 `notify`、`inotify-sys`、`fsevent-stream`。
- **新 provider URI**：`albums://byType/{type}` — 通过扩展 `albums_root_provider.json5` 的 resolve 表 + 新建 `albums_by_type_provider.json5` 实现，供前端 / 跨模块按类型查 album。
- **架构**：一个 `WatcherManager` async task 维护 `HashMap<album_id, PathBuf>` desired set；接收 `Reconcile / Event / Shutdown` 三类消息；event → 1500ms per-album 防抖窗口 → `sync_album(id)`（仍走 Phase 3 try_lock）。
- **albums 变化触发 reconcile**：manager 直接订阅后端 `EventBroadcaster` 的 typed 事件 `AlbumAdded/AlbumChanged/AlbumDeleted`（与 [startup.rs `start_event_loop`](src-tauri/kabegame/src/startup.rs) 共用同一条总线）自动 reconcile。**不**散插 `bump_reconcile()`、**不**改 `commands_core/album.rs`——storage 层创建/删除/改名/移动后已发这三个事件。
- **生命周期**：启动期读设置；开关切换 → 启停 manager；进程退出靠 OS 回收 fd（不写显式 hook）。

---

## 已确认的设计决策（用户 2026-05-22 确认）

1. **DB-only 图片处理**：用户删了本地文件 → **hard-delete** `images`（含缩略图，走 `delete_images_with_events(.., true)`）。
2. **递归创建命名分隔符**：写死 `-`，不开放配置。
3. **稳定窗口**：`STABLE_FOR_MS = 3000`，写死，不开放配置。
4. **删除整个 local_folder album**：仅删 album 与 album_images 关系，**不删** images 本体（磁盘文件归用户所有，画册只是同步视图）。
5. **多个 local_folder album 指向同一路径**：**允许**；同步互不干扰；用户自负责重复展示。
6. **平台范围**：Phase 1~6 **仅 macOS**（其它平台同步入口返回 `Err("local folder sync is macOS-only in this build")`，UI 入口在非 macOS 隐藏）。Phase 7 把范围**扩展**到 macOS / Windows / Linux（实时监听），Android / iOS 保持 noop。
7. **Phase 7 实时监听**：默认 OFF（opt-in）；零新 crate 依赖（仅用已有 `windows-sys` / `core-foundation` / `libc`）；macOS FSEvents 在回调过滤实现非递归语义，Windows / Linux 平台原生支持非递归。详见 [phase7](./local-folder-album-sync-phase7.md)。

---

## 文件改动清单（按 Phase 汇总，供 Code Review 用）

- 新增：
  - `src-tauri/kabegame-core/src/storage/migrations/v013_album_type_and_sync.rs` (P1)
  - `src-tauri/kabegame-core/src/local_folder/{mod,scan,sync,status}.rs` (P2)
  - `src-tauri/kabegame-core/src/local_folder/watch/{mod,macos,windows,linux,noop}.rs` (P7)
  - `src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_type_provider.json5` (P7)
  - `apps/kabegame/src/components/settings/items/RealtimeFolderSyncSetting.vue` (P7)
  - 前端 i18n 文件新增 key (P5, P7)
- 修改：
  - `src-tauri/kabegame-core/src/storage/migrations/{mod,init}.rs` (P1)
  - `src-tauri/kabegame-core/src/storage/albums.rs` (P1, P3, P4, P5)
  - `src-tauri/kabegame-core/src/storage/image_events.rs` (P5)
  - `src-tauri/kabegame-core/src/lib.rs` (P2 加 mod)
  - `src-tauri/kabegame-core/src/crawler/local_import.rs` (P2 抽函数)
  - `src-tauri/kabegame-core/src/providers/dsl/albums/*.json5` (P1 扩字段, P7 加 byType 路由)
  - `src-tauri/kabegame-core/src/local_folder/mod.rs` (P7 加 `pub mod watch;`)
  - `src-tauri/kabegame-core/src/settings.rs` (P7 加 `SettingKey::RealtimeFolderSync`)
  - `src-tauri/kabegame-core/Cargo.toml` (P7 加 `core-foundation` macOS target dep + `windows-sys` features)
  - `src-tauri/kabegame/src/commands/album.rs` (P3, P4)
  - `src-tauri/kabegame/src/commands/settings.rs` (P7 加 `set_realtime_folder_sync`)
  - `src-tauri/kabegame/src/lib.rs` (P3 启动 spawn + handler 注册, P7 同上)
  - `apps/kabegame/src/stores/albums.ts` (P1, P4)
  - `apps/kabegame/src/views/Albums.vue` (P4, P6)
  - `apps/kabegame/src/views/AlbumDetail.vue` (P5, P6)
  - `apps/kabegame/src/components/albums/AlbumCard.vue` (P5)
  - `apps/kabegame/src/settings/quickSettingsRegistry.ts` (P7 注册到 pages=["albums"])
  - `packages/core/src/stores/settings.ts` (P7 加 `realtimeFolderSync` 到 AppSettings + SETTING_KEY_MAP)
