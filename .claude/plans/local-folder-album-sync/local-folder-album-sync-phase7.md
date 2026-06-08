# Phase 7 — 实时文件夹监听（跨平台原生 watcher，可选开关）

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：[Phase 1](./local-folder-album-sync-phase1.md)（`Album.type / syncFolder / folderStatus`）、[Phase 2](./local-folder-album-sync-phase2.md)（`scan_dir` + `sync_album_inner` + `STABLE_FOR_MS`）、[Phase 3](./local-folder-album-sync-phase3.md)（`sync_album` 顶层入口 + per-album try_lock + `list_local_folder_albums`）、[Phase 4](./local-folder-album-sync-phase4.md)（创建 album 时已经 spawn 一次 sync；事件 `album-added/album-deleted/album-changed`）、[Phase 5](./local-folder-album-sync-phase5.md)（只读守卫已挡掉 add/remove image）、[Phase 6](./local-folder-album-sync-phase6.md)（手动刷新 + 立即同步）全部完成并合并。
>
> 范围：新增一个**应用级**布尔设置 `realtimeFolderSync`（默认 **关**），开启后由 Rust 后台 task 维护一组**原生**文件系统 watcher，当 local_folder album 对应的目录发生变化时，自动调用 Phase 3 的 `sync_album(id)`。
>
> 关键约束 — 用户的明确指示：
> - **不引入 `notify` crate**，全部用项目里已有的原生绑定（`windows-sys` / `core-foundation` / `libc`）。
> - **Windows + Linux 用非递归注册**（一个 album 路径 = 一个 watch handle，不进子目录）。
> - **macOS 用 FSEvents**，因为 FSEventStream 总是递归，所以**在事件回调里按路径过滤**：只接受 `event.path.parent() == watched_path` 的事件。
> - 新增 provider DSL 路径 `albums://byType/{type}`，watcher 通过它拉取当前所有 `type='local_folder'` 的 album 列表。根 provider 的 `resolve` 只写 `byType`，再交给独立的 router provider 解析 `{type}`；不要在根 `resolve` key 里写 `/`。
> - albums 变化时（创建 / 删除 / 移动 / 改 sync_folder）watcher 主动 reconcile —— **通过订阅后端 `EventBroadcaster` 的 `AlbumAdded/AlbumChanged/AlbumDeleted` typed 事件**实现，不散插 `bump_reconcile()`，不依赖前端推送。

---

## 关键设计点

### 1. 一个长 task + 平台 worker + 事件汇流

整体拓扑：

```
                          ┌─────────────────────────────────┐
  EventBroadcaster ───────┼─→ AlbumAdded/Changed/Deleted →   │
   (album typed events)   │     reconcile()                  │
                          │   WatcherManager (async task)   │
   ManagerMsg::Shutdown ──┼─→ "stop, drop platform handle"  │
                          │                                 │
                          │  desired = { album_id: path }   │
                          │  reconcile() diff & call:       │
                          │     platform.add(album_id, p)   │
                          │     platform.remove(album_id)   │
                          │                                 │
                          │  ManagerMsg::Event ←─────┐       │
                          │     per-album debounce   │       │
                          │     timer → sync_album(id)│      │
                          └──────────────────────────│───────┘
                                                     │
   ┌─────────────────┬──────────────────┬───────────┴────┐
   │ FSEventsWorker  │ ReadDirChangesW  │ InotifyWorker
   │ (macOS thread)  │ Worker (Win thr) │ (Linux thread)
   └─────────────────┴──────────────────┴─────────┘
            │             │                  │
            └─── std::sync::mpsc::Sender<WatchEvent> ── (forwarded to tokio mpsc)
```

- **WatcherManager**：唯一的 async 长 task，跑在 `tauri::async_runtime::spawn` 上。`tokio::select!` 同时驱动三路输入；维护 `HashMap<album_id, PathBuf>` 当前 desired 状态：
  - **album typed 事件**（订阅 `EventBroadcaster` 的 `AlbumAdded/Changed/Deleted`，启动也先跑一次）→ `reconcile()` 重新算 desired，调用 platform `add` / `remove`。**取代原 `bump_reconcile` 散插**（见 §4）。
  - `ManagerMsg::Event(album_id)`（来自 platform worker）→ per-album 1500ms 防抖窗口，到期后 `sync_album(id).await`。
  - `ManagerMsg::Shutdown` → 调 platform `shutdown()`，drop 自身。
- **Platform worker**：每平台一个，封装在 `PlatformWatcher` trait 后。worker 内部用 **std::thread + 阻塞系统调用**（FSEventStream 的 runloop / ReadDirectoryChangesW / inotify read），通过 `std::sync::mpsc` → 桥到 tokio 通道送给 manager。trait 只暴露 `add(album_id, path)` / `remove(album_id)` / `shutdown()`。
- **平台差异封装**：manager 完全不知道每个 worker 内部是何种 syscall；只看到 `WatchEvent { album_id, kind: Created|Deleted|Modified|Renamed }`。

### 2. App 设置 `realtimeFolderSync`

- 类型：`Bool`，默认 `false`（opt-in）。
- 位置：`SettingKey::RealtimeFolderSync`，加入 [src-tauri/kabegame-core/src/settings.rs](../../src-tauri/kabegame-core/src/settings.rs) 的 `SettingKey` 枚举与默认值表。
- 前端 AppSettings 类型同步加 `realtimeFolderSync?: boolean`。
- 在 [apps/kabegame/src/settings/quickSettingsRegistry.ts](../../apps/kabegame/src/settings/quickSettingsRegistry.ts) 注册到 **仅** `pages: ["albums"]`（与"本地文件夹画册"语义最贴合的设置抽屉位置）。
- 控件：新建 [apps/kabegame/src/components/settings/items/RealtimeFolderSyncSetting.vue](../../apps/kabegame/src/components/settings/items/RealtimeFolderSyncSetting.vue)（仿 `WallpaperRotationEnabledSetting.vue`，但简洁：el-switch + 一个 `set_realtime_folder_sync` 命令）。
- **非 macOS / Linux / Windows desktop（即 Android / Web）下**：在 registry 注册时用 `(IS_MACOS || IS_LINUX || IS_WINDOWS) && !IS_WEB` 守卫；Android 直接不显示。
- 设置的 setter 命令在保存后调 `kabegame_core::local_folder::watch::set_enabled(value).await`：true → 启动 manager，false → 关闭。

### 3. 新 provider `albums://byType/{type}`

- 用户原话：「添加 `albums://byType/{type}` 来查 local_folder albums 列表，找到需要监听的文件夹路径」。
- 实现：在 [src-tauri/kabegame-core/src/providers/dsl/albums/](../../src-tauri/kabegame-core/src/providers/dsl/albums/) 新建 `albums_by_type_router.json5` 与 `albums_by_type_provider.json5`；在 `albums_root_provider.json5` 的 `resolve` 表只添加 `byType` 路由到 router，由 router provider 内部再匹配 `([a-z_]+)`。
- watcher 通过 `crate::providers::images_at(...)` 等价的 album 拉取接口走 provider 拿数据；**不**直接调 `Storage::list_local_folder_albums()`——后者仍保留供 Phase 3 启动期同步使用，但**新代码统一走 provider**，与 [cocs/provider-dsl/VD_INTEGRATION.md](../../cocs/provider-dsl/VD_INTEGRATION.md) 推崇的"通过 provider 抽象数据访问"对齐。
- 调用方式：参考 [apps/kabegame/src/stores/albums.ts:331](../../apps/kabegame/src/stores/albums.ts#L331) 的 `pathqlFetch<AlbumRow>("albums://all")` 形式；后端 Rust 侧用 `crate::providers::albums_at("byType/local_folder")` 等价 API（具体名字按 Phase 1 之后 albums provider 的实际暴露函数名调整 — 实施时 grep `albums_at\|albums_at_path\|pub fn.*albums.*Vec` 确认）。

### 4. albums 变化触发 reconcile（订阅 EventBroadcaster，而非散插 bump）

**核心机制**：album 的增删改在 core 内**已经**发出 typed daemon 事件（不是 Generic）——

- `DaemonEvent::AlbumAdded / AlbumChanged / AlbumDeleted`（[ipc/events.rs:272-287](../../src-tauri/kabegame-core/src/ipc/events.rs#L272)），对应 `DaemonEventKind::AlbumAdded / AlbumChanged / AlbumDeleted`。
- 由 storage 在 DB 写完后发出：创建 [albums.rs:266](../../src-tauri/kabegame-core/src/storage/albums.rs#L266) / 递归子画册 [761](../../src-tauri/kabegame-core/src/storage/albums.rs#L761)、删除 [337](../../src-tauri/kabegame-core/src/storage/albums.rs#L337)、重命名 [375](../../src-tauri/kabegame-core/src/storage/albums.rs#L375)、移动 [876](../../src-tauri/kabegame-core/src/storage/albums.rs#L876)。
- 这些事件都走 `EventBroadcaster::global().broadcast(...)`，正是 [startup.rs:322 `start_event_loop`](../../src-tauri/kabegame/src/startup.rs#L322) 订阅并做后端副作用（如 `SettingChange` 改调度器并发 / 语言切换刷托盘）的同一条总线。

**因此 manager 直接订阅这条总线**，把任意 `AlbumAdded/AlbumChanged/AlbumDeleted` 当作 reconcile 触发：

- `run_manager` 用 `tokio::select!` 同时驱动：① 自身的 `ManagerMsg`（仅剩 `Event` + `Shutdown`）；② `EventBroadcaster::global().subscribe_filtered_stream(&[AlbumAdded, AlbumChanged, AlbumDeleted])` 的事件流（每条都触发 `reconcile`）；③ 平台 worker 送来的文件系统 `WatchEvent`（喂 debounce）。
- **不需要** `bump_reconcile()` 公开 API；**不改** `commands_core/album.rs`；**不改** 任何 CRUD 函数。
- 自动覆盖未来任何新增的 album 变更路径（只要它发了这三个 typed 事件）。
- 启动期：manager 启动时先 `reconcile` 一次（拿当前全量 local_folder album 建 watch），再进入 `select!` 循环。

> **取舍**：相比"散插 5 个 `bump_reconcile()`"，订阅总线是单一职责、零侵入、自包含在 core 内的设计。代价是 `run_manager` 多一路 `select!` 分支——可忽略。
> **对比 `start_event_loop`**：也可以选择在 app crate 的 `start_event_loop` 里加 `AlbumAdded/Changed/Deleted` 分支调 `watch::bump_reconcile()`（与现有 `SettingChange` 副作用同构）。但那样 ① 仍需保留 `bump_reconcile` 公开 API，② 把 core 的内部逻辑绑到 app crate 的转发循环上，③ web 模式的 `start_event_loop` 也要同步。**本计划选 manager 自订阅**（core 自包含），不走 `start_event_loop`。

### 5. 平台 watcher 语义对齐表

| 平台 | 注册方式 | 事件粒度 | 非递归实现 | 子目录事件 |
|---|---|---|---|---|
| Linux | `inotify_init1` + `inotify_add_watch(IN_CREATE\|IN_DELETE\|IN_MOVED_FROM\|IN_MOVED_TO\|IN_CLOSE_WRITE\|IN_ATTRIB)` | 文件名级 | inotify 默认非递归 ✅ | 不接收（除非显式 add_watch 子目录） |
| Windows | `ReadDirectoryChangesW` 单个目录，`bWatchSubtree = FALSE` | 文件名级 | 参数控制 ✅ | 不接收 |
| macOS | `FSEventStreamCreate` 单路径，`kFSEventStreamCreateFlagFileEvents` | 文件路径级 | **总是递归** ⚠️ | 接收 → 在回调里过滤 `path.parent() == watched_path` 后再发到 manager |

manager 不关心事件 kind 的细节（即便 platform 给的 Modified 不准，sync_album 内部还会用 hash 校验决定是否真的 reimport）；只关心"哪个 album 收到事件" → 喂给该 album 的防抖 timer。

### 6. 防抖窗口

- 收到 `WatchEvent { album_id }` 时，若该 album 已有 pending timer → 推迟到 `now + DEBOUNCE_MS`；否则启动 timer。
- `DEBOUNCE_MS = 1500`（写死，不开放配置）。
- 选 1500ms 的理由：用户复制粘贴整组图片到目录里，FS 事件常以 100~500ms 节奏到达，1500ms 足够把它们 coalesce 成一次 sync。又因 Phase 2 的 `STABLE_FOR_MS = 3000` 仍生效，sync 内部会自动跳过还在写入的文件，下次事件再触发时它已稳定 → 二次扫描入库。**因此防抖窗口可以短，不必等到 stable_for 之后**。
- 实现：`HashMap<String, tokio::task::JoinHandle<()>>`，每次到达事件 abort 旧 handle、新 spawn 一个 `sleep(DEBOUNCE_MS).await; sync_album(id).await`。

### 7. 启停语义

- **设置打开**：spawn manager；manager 启动时 ① reconcile 一次（自动 watch 当前所有 local_folder album），② **立即跑一次全量 `sync_all_local_folder_albums()`** —— 把磁盘当前状态同步进库，不等首个文件系统事件（用户在 watcher 关闭期间对文件夹做的增删改，开启时一次补齐）。两步顺序：先建 watch 再全量 sync，避免 sync 进行中错过新事件。
- **设置关闭**：发 `Shutdown` 给 manager；manager `platform.shutdown()` 后退出；所有 pending timer abort。
- **app 退出**：与"关闭"路径相同；走 `tauri::Builder::build().run()` 之后的 cleanup hook **不可靠**——直接 leak manager；OS 进程退出会释放 fd。**不**走显式 hook。
- **重启 toggle**：先 off → manager 退出后再 on → 重新 spawn 一个新 manager 实例。用 `OnceCell<Mutex<Option<ManagerHandle>>>` 保证全局只有一个 manager handle。

### 8. 错误恢复

- inotify watch fd 被 OS 杀掉（unlikely 在 desktop）→ worker 检测到 read 返回 EBADF，整体重启 worker（重新建 fd + 重新 add_watch 所有路径），manager 收到 `WorkerCrashed` 事件后调一次 reconcile。
- FSEventStream 被 kill（设备拔出）→ 单个 album 的 stream 进入 errored 状态，worker 调度 reconcile 把它从 watched set 移除；下次该 album 的 sync_folder 重新可达时不会自动恢复（用户需点立即同步）——**第一版不做自动恢复**，留 TODO。
- platform `add(path)` 失败（路径不存在 / 权限不足）→ 不 panic、不向上传播，log warning + 在 `folder_status` 写 `denied` / `missing`（**复用** Phase 2 的 `FolderStatus` 序列化），manager 跳过该 album。

---

## 涉及文件清单

### 新增

- `src-tauri/kabegame-core/src/local_folder/watch/mod.rs` — `WatchManager`、**唯一公开入口 `set_enabled(bool)`**（无 `bump_reconcile`，reconcile 由订阅 `EventBroadcaster` 触发）、`WatchEvent`、`PlatformWatcher` trait
- `src-tauri/kabegame-core/src/local_folder/watch/macos.rs` — `#[cfg(target_os = "macos")]` FSEvents 实现
- `src-tauri/kabegame-core/src/local_folder/watch/windows.rs` — `#[cfg(target_os = "windows")]` ReadDirectoryChangesW 实现
- `src-tauri/kabegame-core/src/local_folder/watch/linux.rs` — `#[cfg(target_os = "linux")]` inotify 实现
- `src-tauri/kabegame-core/src/local_folder/watch/noop.rs` — 可选空实现；当前实现也可以直接在 `mod.rs` 里对非 desktop / web cfg 提供 no-op `set_enabled`
- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_type_router.json5`
- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_type_provider.json5`
- `apps/kabegame/src/components/settings/items/RealtimeFolderSyncSetting.vue`

### 修改

- `src-tauri/kabegame-core/src/local_folder/mod.rs` — 加 `pub mod watch;`
- `src-tauri/kabegame-core/src/settings.rs` — `SettingKey::RealtimeFolderSync` + 默认值 `Bool(false)`
- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_root_provider.json5` — `resolve` 表添加 `byType` 路由到 `albums_by_type_router`
- `src-tauri/kabegame/src/commands/settings.rs`（或 [src-tauri/kabegame/src/commands_core/settings.rs](../../src-tauri/kabegame/src/commands_core/settings.rs)，按文件存在情况） — 新增 `set_realtime_folder_sync(value: bool)` 命令，保存后调 `watch::set_enabled(value).await`
- `src-tauri/kabegame/src/lib.rs` — `tauri::generate_handler!` 注册 setter；**setup 内**读取设置 → 若 true 调 `watch::set_enabled(true).await` 一次（异步 spawn 内）
- （已移除）`commands_core/album.rs` 不再需要任何改动 — reconcile 改由 manager 订阅 `EventBroadcaster` 触发
- `packages/core/src/stores/settings.ts` — `AppSettings` 加 `realtimeFolderSync?: boolean`；`SETTING_KEY_MAP` 加对应条目（参考现有 `wallpaperRotationEnabled` 写法）
- `apps/kabegame/src/settings/quickSettingsRegistry.ts` — 新增一项注册到 `pages: ["albums"]`
- `packages/i18n/src/locales/{en,zh}/settings.json` 增 4 个 key（label + desc + on / off toast）
- `src-tauri/kabegame-core/Cargo.toml` — 加 `core-foundation = "0.10"`（macOS-only target dep；项目已有 0.9 / 0.10 transitively，但需要直接 dep 才能 use）；**不**加 `notify` / `inotify` / `inotify-sys`

### 不修改

- 任何 Phase 2/3 的 sync 实现 — watcher 是 sync 的**触发器**，不动 sync 内部逻辑。
- Phase 6 的 UI 入口 — 实时同步是「立即同步」的**补充**，不是替代。
- `image_events.rs` — 事件流由 sync_album 内部驱动。
- ACL / capability — 新的 setter 命令名加入主 capability allowlist（若有显式列；通配符则无需改）。

---

## 步骤

### 1. 新增 `SettingKey::RealtimeFolderSync`

**`src-tauri/kabegame-core/src/settings.rs`**

在 `SettingKey` 枚举里追加（按现有字母 / 主题分组就近插入）：

```rust
/// 启用后，后台 task 监听所有 local_folder album 的源目录，
/// 文件变化时自动触发 sync_album。默认 false（opt-in）。
RealtimeFolderSync,
```

`default_values()` 函数追加：

```rust
SettingKey::RealtimeFolderSync => SettingValue::Bool(false),
```

如有 `SettingKey::FromString` / 字符串映射表，同步加 `"realtimeFolderSync"`。

### 2. 前端 AppSettings 类型 + SETTING_KEY_MAP

**`packages/core/src/stores/settings.ts`**

`AppSettings` 接口加：

```ts
realtimeFolderSync?: boolean;
```

`SETTING_KEY_MAP`（[settings.ts:196](../../packages/core/src/stores/settings.ts#L196) 附近）参考 `wallpaperRotationEnabled` 添加：

```ts
realtimeFolderSync: {
  key: "realtimeFolderSync",
  defaultValue: false,
  // 若现有 entries 有 setter 字段，写 "set_realtime_folder_sync"
},
```

### 3. Setter 命令

**`src-tauri/kabegame/src/commands/settings.rs`** 末尾追加（仿 `set_wallpaper_rotation_enabled` 风格）：

```rust
#[tauri::command]
pub async fn set_realtime_folder_sync(value: bool) -> Result<(), String> {
    Settings::global().set_realtime_folder_sync(value)?;
    // 启动 / 停止 watcher
    kabegame_core::local_folder::watch::set_enabled(value).await;
    Ok(())
}
```

并在 `Settings` 上加 `get_realtime_folder_sync()` / `set_realtime_folder_sync(value)` 包装（仿现有 `get/set_wallpaper_rotation_enabled`）。

**`src-tauri/kabegame/src/lib.rs`** 在 `generate_handler!` 列表追加 `set_realtime_folder_sync,`（与其他 setter 同段）。

### 4. 启动期读设置 → 决定是否启动 manager

**`src-tauri/kabegame/src/lib.rs`** 在 [init() 末尾的 startup spawn](../../src-tauri/kabegame/src/lib.rs)（Phase 3 已插入 `sync_all_local_folder_albums` 那段紧随其后）：

```rust
#[cfg(all(any(target_os = "macos", target_os = "windows", target_os = "linux"),
          not(feature = "web")))]
tauri::async_runtime::spawn(async {
    if Settings::global().get_realtime_folder_sync() {
        kabegame_core::local_folder::watch::set_enabled(true).await;
    }
});
```

> 与 Phase 3 启动 sync 段**并列**且**之后**——确保 Phase 3 的首轮 sync 先开始（不必等其完成；两者独立）。

### 5. 新 provider `albums_by_type_provider.json5`

```json5
// src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_type_provider.json5
{
    "namespace": "kabegame",
    "name": "albums_by_type_provider",
    "properties": {
        "type": { "type": "string", "default": "normal", "optional": false }
    },
    "query": {
        "where": "albums.type = ${properties.type}",
        "order": [{ "sql": "albums.created_at", "order": "asc" }]
    }
}
```

另新增 router provider：

```json5
// src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_type_router.json5
{
    "namespace": "kabegame",
    "name": "albums_by_type_router",
    "resolve": {
        "([a-z_]+)": {
            "provider": "albums_by_type_provider",
            "properties": { "type": "${capture[1]}" }
        }
    }
}
```

`albums_root_provider.json5` 的 `resolve` 只增一条根级路由，不在 key 里写 `/`：

```json5
"resolve": {
    "all": { "provider": "albums_all_provider" },
    "id_([^/]+)": {
        "provider": "albums_id_provider",
        "properties": { "album_id": "${capture[1]}" }
    },
    "byType": { "provider": "albums_by_type_router" }
}
```

> 路由正则 `[a-z_]+` 覆盖当前定义的 `normal` / `local_folder`；未来加新 type 同样匹配。
>
> 校验：完成后 `pathqlFetch("albums://byType/local_folder")` 在前端 DevTools 应能返回当前所有本地文件夹画册行（含 sync_folder / folder_status）。后端 Rust 通过 `crate::providers::*` 的 albums 入口同样可拉，详见步骤 6。

### 6. `local_folder/watch/mod.rs` — 核心 manager 框架

```rust
//! Real-time folder watcher manager. macOS / Windows / Linux only.
//! When app setting `realtimeFolderSync` is true, this module maintains a
//! background task that watches every local_folder album's sync_folder and
//! debounced-triggers `sync_album(id)` on filesystem changes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

const DEBOUNCE_MS: u64 = 1500;

#[derive(Debug, Clone)]
pub struct WatchEvent {
    pub album_id: String,
    /// 仅供日志；触发判断不依赖具体 kind。
    pub kind: &'static str,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod noop;

#[cfg(target_os = "macos")]
use macos::PlatformImpl;
#[cfg(target_os = "windows")]
use windows::PlatformImpl;
#[cfg(target_os = "linux")]
use linux::PlatformImpl;
#[cfg(any(target_os = "android", target_os = "ios"))]
use noop::PlatformImpl;

trait PlatformWatcher: Send {
    /// 注册一个非递归（语义上）的 watch。macOS 内部实现走 FSEvents 并自行过滤；
    /// Windows 走 ReadDirectoryChangesW bWatchSubtree=FALSE；Linux 走单个 inotify watch。
    fn add(&mut self, album_id: &str, path: &std::path::Path) -> Result<(), String>;
    fn remove(&mut self, album_id: &str);
    fn shutdown(&mut self);
}

enum ManagerMsg {
    /// 平台 worker 送来的文件系统事件 → 喂给 per-album debounce。
    Event(WatchEvent),
    Shutdown,
}

struct ManagerHandle {
    tx: mpsc::Sender<ManagerMsg>,
    _join: tokio::task::JoinHandle<()>,
}

static MANAGER: OnceLock<Mutex<Option<ManagerHandle>>> = OnceLock::new();

fn manager_cell() -> &'static Mutex<Option<ManagerHandle>> {
    MANAGER.get_or_init(|| Mutex::new(None))
}

/// 开关入口：true → 启动 manager（若未启动）；false → 关闭。幂等。
pub async fn set_enabled(enabled: bool) {
    let mut slot = manager_cell().lock().await;
    if enabled {
        if slot.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<ManagerMsg>(64);
        let handle_tx = tx.clone();
        let join = tauri::async_runtime::spawn(run_manager(rx, handle_tx));
        *slot = Some(ManagerHandle { tx, _join: join });
    } else if let Some(h) = slot.take() {
        let _ = h.tx.send(ManagerMsg::Shutdown).await;
        // 不 await join：manager 内部 shutdown 后会自然结束；调用方不阻塞
    }
}

// 注意：**没有** `bump_reconcile()` 公开 API。reconcile 由 manager 内部订阅
// `EventBroadcaster` 的 album typed 事件自动触发（见 §4）；唯一对外入口是 `set_enabled`。

async fn run_manager(mut rx: mpsc::Receiver<ManagerMsg>, self_tx: mpsc::Sender<ManagerMsg>) {
    use crate::ipc::events::DaemonEventKind;
    use crate::ipc::EventBroadcaster;

    let mut platform = PlatformImpl::new(self_tx.clone());
    let mut desired: HashMap<String, PathBuf> = HashMap::new();
    let mut debounce: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    // 订阅 album 增删改 typed 事件流（与 start_event_loop 共用的同一条 EventBroadcaster 总线）。
    let mut album_events = EventBroadcaster::global().subscribe_filtered_stream(&[
        DaemonEventKind::AlbumAdded,
        DaemonEventKind::AlbumChanged,
        DaemonEventKind::AlbumDeleted,
    ]);

    // 启动即跑一次 reconcile（拿当前全量 local_folder album 建 watch）
    reconcile(&mut platform, &mut desired).await;

    // 开关刚打开 / 启动期：立即做一次全量同步，把当前磁盘状态拉进来，
    // 不等下一次文件系统事件。复用 Phase 3 的批量入口（内部 per-album try_lock，
    // 与启动期 spawn 的那次同步若撞车会自然跳过，不重复跑）。
    let _ = crate::local_folder::sync_all_local_folder_albums().await;

    loop {
        tokio::select! {
            // ① 控制消息（平台 worker 的文件事件 / shutdown）
            maybe_msg = rx.recv() => {
                match maybe_msg {
                    Some(ManagerMsg::Event(ev)) => {
                        let id = ev.album_id.clone();
                        if let Some(old) = debounce.remove(&id) {
                            old.abort();
                        }
                        let handle = tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                            let _ = crate::local_folder::sync_album(&id).await;
                        });
                        debounce.insert(ev.album_id, handle);
                    }
                    Some(ManagerMsg::Shutdown) | None => {
                        for (_, h) in debounce.drain() { h.abort(); }
                        platform.shutdown();
                        break;
                    }
                }
            }
            // ② album 增删改 → reconcile（diff watch set）
            album_ev = album_events.recv() => {
                match album_ev {
                    Some(_) => reconcile(&mut platform, &mut desired).await,
                    None => { /* broadcaster 关闭：忽略，靠 ① 的 shutdown 退出 */ }
                }
            }
        }
    }
}

async fn reconcile(platform: &mut PlatformImpl, desired: &mut HashMap<String, PathBuf>) {
    let albums = match fetch_local_folder_albums_via_provider("albums://byType/local_folder").await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[local_folder.watch] list failed: {e}");
            return;
        }
    };
    let mut next: HashMap<String, PathBuf> = HashMap::new();
    for a in albums {
        if let Some(folder) = a.sync_folder.as_deref() {
            next.insert(a.id, PathBuf::from(folder));
        }
    }
    // diff: remove gone & changed-path; add new & changed-path
    let removed_ids: Vec<String> = desired
        .iter()
        .filter(|(id, p)| next.get(*id).map_or(true, |np| np != *p))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &removed_ids {
        platform.remove(id);
        desired.remove(id);
    }
    for (id, path) in &next {
        if desired.get(id).map_or(true, |op| op != path) {
            if let Err(e) = platform.add(id, path) {
                log::warn!("[local_folder.watch] add {id} {p:?} failed: {e}", p = path);
            } else {
                desired.insert(id.clone(), path.clone());
            }
        }
    }
}
```

> **取舍**：reconcile 由订阅 `EventBroadcaster` 的 album typed 事件驱动，album 变更总线丢消息几乎不可能（tokio broadcast）；即便丢一次，下次 album 变更或用户 toggle off→on 都会再 reconcile。reconcile 本身幂等（desired set 无变化时 platform.add/remove 不触发）。
> 后端 watcher 也走 `albums://byType/local_folder` provider 路径拉取列表，避免再引入第二套 local_folder album 查询口径。

### 7. `local_folder/watch/macos.rs` — FSEvents

```rust
//! macOS FSEvents implementation. FSEventStream is always recursive, so we
//! filter events whose path.parent() != watched path before forwarding.

use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::CFString;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use tokio::sync::mpsc as tokio_mpsc;

use super::{ManagerMsg, PlatformWatcher, WatchEvent};

// 直接 extern 出我们需要的 FSEvents 符号，避免引入大依赖。
// 参考：https://developer.apple.com/documentation/coreservices/file_system_events
type FSEventStreamRef = *mut c_void;
type FSEventStreamCallback = unsafe extern "C" fn(
    stream_ref: FSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: *mut c_void, // CFArray<CFString>
    event_flags: *const u32,
    event_ids: *const u64,
);

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn FSEventStreamCreate(
        allocator: *const c_void,
        callback: FSEventStreamCallback,
        context: *const c_void,
        paths_to_watch: *const c_void,
        since_when: u64,
        latency: f64,
        flags: u32,
    ) -> FSEventStreamRef;
    fn FSEventStreamScheduleWithRunLoop(stream: FSEventStreamRef, run_loop: *const c_void, run_loop_mode: *const c_void);
    fn FSEventStreamStart(stream: FSEventStreamRef) -> u8;
    fn FSEventStreamStop(stream: FSEventStreamRef);
    fn FSEventStreamInvalidate(stream: FSEventStreamRef);
    fn FSEventStreamRelease(stream: FSEventStreamRef);
}

const KFS_EVENT_STREAM_EVENT_ID_SINCE_NOW: u64 = u64::MAX;
const KFS_EVENT_STREAM_CREATE_FLAG_FILE_EVENTS: u32 = 0x10;
const KFS_EVENT_STREAM_CREATE_FLAG_NO_DEFER:    u32 = 0x02;

// 每个 album 对应一个独立的 FSEventStream + 后台 runloop 线程。
// 把"watched path"和"album_id"塞进 callback 的 info 指针。
struct StreamSlot {
    stop_tx: mpsc::Sender<()>,
    join: JoinHandle<()>,
}

pub(super) struct PlatformImpl {
    streams: HashMap<String, StreamSlot>,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
}

impl PlatformImpl {
    pub fn new(out_tx: tokio_mpsc::Sender<ManagerMsg>) -> Self {
        Self { streams: HashMap::new(), out_tx }
    }
}

struct CallbackCtx {
    album_id: String,
    watched: PathBuf,
    out_tx: tokio_mpsc::Sender<ManagerMsg>,
}

unsafe extern "C" fn fs_callback(
    _stream_ref: FSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: *mut c_void,
    _event_flags: *const u32,
    _event_ids: *const u64,
) {
    let ctx = &*(info as *const CallbackCtx);
    let cf_arr: CFArray<CFString> = TCFType::wrap_under_get_rule(event_paths as *const _);
    for i in 0..num_events {
        let cf_str = match cf_arr.get(i as isize) {
            Some(s) => s,
            None => continue,
        };
        let path_str = cf_str.to_string();
        let path = PathBuf::from(&path_str);
        // 非递归过滤：只接受 path.parent() == watched
        if path.parent().map(|p| p == ctx.watched.as_path()).unwrap_or(false) {
            let ev = WatchEvent { album_id: ctx.album_id.clone(), kind: "fs" };
            let _ = ctx.out_tx.try_send(ManagerMsg::Event(ev));
        }
    }
}

impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
        // 已存在 → 先 remove
        self.remove(album_id);
        let album_id_s = album_id.to_string();
        let watched = path.to_path_buf();
        let out_tx = self.out_tx.clone();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let join = thread::Builder::new()
            .name(format!("fsevent-{album_id_s}"))
            .spawn(move || {
                // 该线程独占一个 CFRunLoop
                let ctx = Box::leak(Box::new(CallbackCtx {
                    album_id: album_id_s,
                    watched: watched.clone(),
                    out_tx,
                }));
                let cf_path = CFString::new(&watched.to_string_lossy());
                let paths_arr = CFArray::from_CFTypes(&[cf_path]);
                let stream = unsafe {
                    FSEventStreamCreate(
                        ptr::null(),
                        fs_callback,
                        ctx as *const _ as *const c_void,
                        paths_arr.as_concrete_TypeRef() as *const _ as *const c_void,
                        KFS_EVENT_STREAM_EVENT_ID_SINCE_NOW,
                        0.5,
                        KFS_EVENT_STREAM_CREATE_FLAG_FILE_EVENTS | KFS_EVENT_STREAM_CREATE_FLAG_NO_DEFER,
                    )
                };
                if stream.is_null() {
                    log::warn!("[local_folder.watch.macos] FSEventStreamCreate returned null");
                    return;
                }
                unsafe {
                    let run_loop = CFRunLoop::get_current();
                    FSEventStreamScheduleWithRunLoop(
                        stream,
                        run_loop.as_concrete_TypeRef() as *const _ as *const c_void,
                        kCFRunLoopDefaultMode as *const _ as *const c_void,
                    );
                    if FSEventStreamStart(stream) == 0 {
                        log::warn!("[local_folder.watch.macos] FSEventStreamStart failed");
                        FSEventStreamInvalidate(stream);
                        FSEventStreamRelease(stream);
                        return;
                    }
                }
                // 半秒 tick 一次检查 stop 信号
                loop {
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(500), false);
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                }
                unsafe {
                    FSEventStreamStop(stream);
                    FSEventStreamInvalidate(stream);
                    FSEventStreamRelease(stream);
                }
                // ctx 故意 leak，避免在 callback 仍可能持有它时被 drop
            })
            .map_err(|e| format!("spawn fsevent thread: {e}"))?;
        self.streams.insert(album_id.to_string(), StreamSlot { stop_tx, join });
        Ok(())
    }

    fn remove(&mut self, album_id: &str) {
        if let Some(slot) = self.streams.remove(album_id) {
            let _ = slot.stop_tx.send(());
            let _ = slot.join.join();
        }
    }

    fn shutdown(&mut self) {
        let ids: Vec<String> = self.streams.keys().cloned().collect();
        for id in ids {
            self.remove(&id);
        }
    }
}
```

> **注意**：上面的 `CFRunLoop::run_in_mode` 签名细节、`kCFRunLoopDefaultMode` 的实际类型、`CFArray::from_CFTypes` 的可用版本，**实施时需要按 `core-foundation` crate 的真实 API 微调**——本计划展示骨架。如果项目 transitively 已有 `core-foundation 0.10`，直接把它在 `kabegame-core/Cargo.toml` 的 `[target.'cfg(target_os = "macos")'.dependencies]` 段声明为直接依赖即可，不引入新 crate。
> **注意**：fs_callback 内的 `event_paths` 在 `kFSEventStreamCreateFlagFileEvents` flag 下是 `CFArray<CFString>`（不是 C 数组），需要从 `CFArray` 取；若用更便捷的 `fsevent-stream` 高级 crate 会引入依赖——用户要求"无 deps"故直接 wrap。

### 8. `local_folder/watch/windows.rs` — ReadDirectoryChangesW

每 album 起一个 std::thread，循环：

1. `CreateFileW(path, FILE_LIST_DIRECTORY, FILE_SHARE_READ|WRITE|DELETE, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OVERLAPPED, NULL)` 拿目录 handle。
2. 准备 `OVERLAPPED` + `HANDLE` event（`CreateEventW`）。
3. 循环：
   - `ReadDirectoryChangesW(handle, buffer, BUF_SZ, FALSE /* bWatchSubtree */, FILE_NOTIFY_CHANGE_FILE_NAME|FILE_NOTIFY_CHANGE_SIZE|FILE_NOTIFY_CHANGE_LAST_WRITE|FILE_NOTIFY_CHANGE_ATTRIBUTES, NULL, &overlapped, NULL)`。
   - `WaitForMultipleObjects([event, stop_event], INFINITE)`：若 stop_event 触发则 `CancelIoEx(handle, ...)`, close, exit。
   - `GetOverlappedResult(handle, &overlapped, &bytes, FALSE)`。
   - 不**解析** `FILE_NOTIFY_INFORMATION`（不关心具体文件名），只要 `bytes > 0` 就发 `WatchEvent { album_id, kind: "win" }`。

> 写到工程里时直接用 [windows-sys 0.52](../../src-tauri/kabegame-core/Cargo.toml) 的 `Win32::Storage::FileSystem` + `Win32::System::IO` 模块；现有 `kabegame-core/Cargo.toml` 已 import `windows-sys` 但 features 列表里可能没 `Win32_Storage_FileSystem` / `Win32_System_IO`——实施时按编译错追加 features。

骨架（伪 Rust，注释里写出每行真实调用的入口名）：

```rust
#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    pub(super) struct PlatformImpl { /* HashMap<id, ThreadSlot> + out_tx */ }
    impl PlatformWatcher for PlatformImpl {
        fn add(&mut self, album_id: &str, path: &Path) -> Result<(), String> {
            // 1) CreateFileW(path_w, ...)
            // 2) CreateEventW(stop) + event_ready
            // 3) std::thread::spawn(move || loop { ReadDirectoryChangesW(... bWatchSubtree=FALSE ...); WaitForMultipleObjects; if stop break; send event })
            todo!("see plan §8")
        }
        fn remove(&mut self, album_id: &str) {
            // SetEvent(stop_handle); join thread; CloseHandle(dir); CloseHandle(events)
        }
        fn shutdown(&mut self) { /* iter remove */ }
    }
}
```

### 9. `local_folder/watch/linux.rs` — inotify via libc

不引入 `inotify` crate；直接 `libc::syscall(SYS_inotify_init1, libc::IN_CLOEXEC)`、`libc::syscall(SYS_inotify_add_watch, fd, path_cstr, mask)`、`libc::read(fd, buf, BUF_SZ)`。

策略：
- **整个 manager 共享一个 inotify fd**（不是每 album 一个），用 `HashMap<i32, String>` 把 `wd → album_id` 映射存起来。
- 后台线程 `read()` 阻塞读 fd，解析 `struct inotify_event` 数组，按 `wd` 反查 `album_id`，每条事件发 `WatchEvent`。
- `add(album_id, path)`：`inotify_add_watch`，拿 wd，写入映射。
- `remove(album_id)`：根据 album_id 反查 wd → `inotify_rm_watch`。
- `shutdown`：close fd，线程 read 返回 0/EBADF → 退出。

mask（写死，不开放配置）：
```
IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_CLOSE_WRITE | IN_ATTRIB
```

骨架（关键 syscall 参考 [test/native-auto-import/src/main.rs](../../test/native-auto-import/src/main.rs) 若其中已有 inotify 示例；没有就直接对照 `man inotify`）：

```rust
#[cfg(target_os = "linux")]
mod linux {
    use libc::{self, c_int};
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::os::unix::io::RawFd;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use super::*;

    pub(super) struct PlatformImpl {
        fd: RawFd,
        wd_to_id: Arc<Mutex<HashMap<c_int, String>>>,
        id_to_wd: HashMap<String, c_int>,
        reader: Option<JoinHandle<()>>,
        out_tx: tokio::sync::mpsc::Sender<ManagerMsg>,
    }

    impl PlatformImpl {
        pub fn new(out_tx: tokio::sync::mpsc::Sender<ManagerMsg>) -> Self {
            let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
            // 如果 fd < 0，标记 self.fd = -1，后续 add 都直接返回错误
            let map = Arc::new(Mutex::new(HashMap::<c_int, String>::new()));
            let map_for_thread = Arc::clone(&map);
            let out = out_tx.clone();
            let reader = if fd >= 0 {
                Some(std::thread::Builder::new()
                    .name("inotify-reader".into())
                    .spawn(move || reader_loop(fd, map_for_thread, out))
                    .expect("spawn inotify-reader"))
            } else {
                None
            };
            Self { fd, wd_to_id: map, id_to_wd: HashMap::new(), reader, out_tx }
        }
    }

    fn reader_loop(fd: RawFd, map: Arc<Mutex<HashMap<c_int, String>>>, out: tokio::sync::mpsc::Sender<ManagerMsg>) {
        let mut buf = [0u8; 8192];
        loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut _, buf.len()) };
            if n <= 0 {
                // EAGAIN/EWOULDBLOCK: poll/select 50ms 再试；EBADF: 退出
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EAGAIN) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
                break;
            }
            let mut off = 0usize;
            while off + std::mem::size_of::<libc::inotify_event>() <= n as usize {
                let ev: &libc::inotify_event =
                    unsafe { &*(buf.as_ptr().add(off) as *const libc::inotify_event) };
                let wd = ev.wd;
                let id = map.lock().ok().and_then(|m| m.get(&wd).cloned());
                if let Some(album_id) = id {
                    let _ = out.try_send(ManagerMsg::Event(WatchEvent { album_id, kind: "inotify" }));
                }
                off += std::mem::size_of::<libc::inotify_event>() + ev.len as usize;
            }
        }
    }

    impl PlatformWatcher for PlatformImpl {
        fn add(&mut self, album_id: &str, path: &std::path::Path) -> Result<(), String> {
            if self.fd < 0 { return Err("inotify init failed".into()); }
            self.remove(album_id);
            let cpath = CString::new(path.as_os_str().as_encoded_bytes())
                .map_err(|e| format!("path null byte: {e}"))?;
            let mask = libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM
                     | libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE | libc::IN_ATTRIB;
            let wd = unsafe { libc::inotify_add_watch(self.fd, cpath.as_ptr(), mask) };
            if wd < 0 {
                return Err(format!("inotify_add_watch: {}", std::io::Error::last_os_error()));
            }
            self.wd_to_id.lock().unwrap().insert(wd, album_id.to_string());
            self.id_to_wd.insert(album_id.to_string(), wd);
            Ok(())
        }
        fn remove(&mut self, album_id: &str) {
            if let Some(wd) = self.id_to_wd.remove(album_id) {
                unsafe { libc::inotify_rm_watch(self.fd, wd) };
                self.wd_to_id.lock().unwrap().remove(&wd);
            }
        }
        fn shutdown(&mut self) {
            if self.fd >= 0 {
                let ids: Vec<String> = self.id_to_wd.keys().cloned().collect();
                for id in ids { self.remove(&id); }
                unsafe { libc::close(self.fd); }
                self.fd = -1;
            }
            // reader_loop 会因 EBADF / read 返回 ≤ 0 而退出
        }
    }
}
```

### 10. `local_folder/watch/noop.rs` — Android / iOS

```rust
#![cfg(any(target_os = "android", target_os = "ios"))]
use super::{ManagerMsg, PlatformWatcher};
pub(super) struct PlatformImpl;
impl PlatformImpl {
    pub fn new(_tx: tokio::sync::mpsc::Sender<ManagerMsg>) -> Self { Self }
}
impl PlatformWatcher for PlatformImpl {
    fn add(&mut self, _id: &str, _p: &std::path::Path) -> Result<(), String> {
        Err("realtime watch not supported on this platform".into())
    }
    fn remove(&mut self, _id: &str) {}
    fn shutdown(&mut self) {}
}
```

> Android 的 `set_enabled(true)` 实际不会被调用（前端 registry 已隐藏）；即便走到也安全 no-op。

### 11. （已删除）album CRUD 不需要任何改动

原方案在 5 个 CRUD 函数末尾散插 `bump_reconcile()`。**改为 §4 的方案**：manager 订阅 `EventBroadcaster` 的 `AlbumAdded/AlbumChanged/AlbumDeleted` typed 事件自动 reconcile。

- storage 层 [albums.rs](../../src-tauri/kabegame-core/src/storage/albums.rs) 在创建 / 删除 / 重命名 / 移动后**已经**发这三个事件（[266](../../src-tauri/kabegame-core/src/storage/albums.rs#L266) / [761](../../src-tauri/kabegame-core/src/storage/albums.rs#L761) / [337](../../src-tauri/kabegame-core/src/storage/albums.rs#L337) / [375](../../src-tauri/kabegame-core/src/storage/albums.rs#L375) / [876](../../src-tauri/kabegame-core/src/storage/albums.rs#L876)），无需新增 emit。
- Phase 4 的 `add_local_folder_album`（递归创建）走的也是 `add_album` 同一发射路径（[761](../../src-tauri/kabegame-core/src/storage/albums.rs#L761) 是子画册递归插入的 `emit_album_added`），天然覆盖。
- rename / move 不改 sync_folder，但 reconcile 是幂等 diff（desired set 无变化时 platform.add/remove 都不触发），多 reconcile 一次开销可忽略。

> **唯一需确认**：Phase 4 实现 `add_local_folder_album` 时务必确保**每个**新建 album（顶层 + 递归子）都经过 `emit_album_added`（即复用 storage 的 `add_album` 路径，而非绕过 emitter 直接 INSERT）。否则 watcher 收不到事件、不会自动 watch 新建的文件夹画册。**在 Phase 4 计划里已是默认（走 storage 方法）**，此处记一笔交叉约束。

### 12. 前端 RealtimeFolderSyncSetting.vue

仿 [WallpaperRotationEnabledSetting.vue](../../apps/kabegame/src/components/settings/items/WallpaperRotationEnabledSetting.vue) 但简化：

```vue
<template>
  <el-switch v-model="localValue" :disabled="props.disabled || disabled"
    :loading="showDisabled" @change="handleChange" />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const props = defineProps<{ disabled?: boolean }>();
const { t } = useI18n();
const { settingValue, disabled, showDisabled, set } = useSettingKeyState("realtimeFolderSync");
const localValue = ref(false);
watch(() => settingValue.value, (v) => { localValue.value = !!v; }, { immediate: true });

const handleChange = async (value: boolean) => {
  try {
    await set(value);
    ElMessage.success(value
      ? t("settings.localFolder.realtimeOn")
      : t("settings.localFolder.realtimeOff"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e));
  }
};
</script>
```

`useSettingKeyState("realtimeFolderSync")` 内部会查 `SETTING_KEY_MAP["realtimeFolderSync"].setter` 拿到 `"set_realtime_folder_sync"` 并 invoke 之；不需要在 `.vue` 内手写 invoke。

### 13. 注册到 quickSettingsRegistry

[apps/kabegame/src/settings/quickSettingsRegistry.ts](../../apps/kabegame/src/settings/quickSettingsRegistry.ts)：在某个合适的 group（建议新增一个 `localFolderSync` group 或塞到现有"动作 / 同步"相关 group 内；若无则放 `display` group 之后新建 group）追加：

```ts
import RealtimeFolderSyncSetting from "@/components/settings/items/RealtimeFolderSyncSetting.vue";

// 在 translatedGroups 数组里某 group 的 items 末尾，或新建 group：
{
  id: "localFolderSync",
  title: t("settings.localFolder.groupTitle"),
  items: [
    ...((IS_MACOS || IS_LINUX || IS_WINDOWS) && !IS_WEB ? [{
      key: "realtimeFolderSync",
      label: t("settings.localFolder.realtimeLabel"),
      description: t("settings.localFolder.realtimeDesc"),
      comp: RealtimeFolderSyncSetting,
      pages: ["albums"],
    } as QuickSettingItem<QuickSettingsPageId>] : []),
  ],
},
```

> `pages: ["albums"]` 让该项只出现在 Albums 页打开的 settings drawer 中——与用户原话「在 albums 页面的 setting drawer 里」完全对齐。
> Android / Web 不显示——既无 watcher 实现，也无 desktop 文件夹概念。

### 14. i18n

在 `packages/i18n/src/locales/{en,zh}/settings.json` 加：

```json
{
  "localFolder": {
    "groupTitle":     "本地文件夹同步",
    "realtimeLabel":  "实时同步文件夹",
    "realtimeDesc":   "开启后，应用会在后台监听本地文件夹画册的源目录；外部新增或删除的图片/视频会自动同步到画册。",
    "realtimeOn":     "实时同步已开启",
    "realtimeOff":    "实时同步已关闭"
  }
}
```

英文版同步翻译；其他语言复制英文 + TODO。

### 15. Cargo.toml 调整

[src-tauri/kabegame-core/Cargo.toml](../../src-tauri/kabegame-core/Cargo.toml)：

```toml
# macOS target dep — FSEvents via core-foundation
[target.'cfg(target_os = "macos")'.dependencies]
core-foundation = "0.10"

# Linux 与 Windows 已有：
# libc = "0.2"      （顶层 dep，已存在）
# windows-sys = ... （顶层 dep，已存在；按编译错追加 features）
```

windows-sys features 至少需要：
```
"Win32_Storage_FileSystem",
"Win32_System_IO",
"Win32_System_Threading",
"Win32_Foundation",
```
在已有 `features = [...]` 列表里追加这些项（先 grep 现有，避免重复）。

**不**新增：`notify`、`inotify`、`inotify-sys`、`fsevent-stream`、`fsevents`。

---

## 验收清单

### 1. 类型检查

- `bun check -c kabegame` 通过。
- `cargo check -p kabegame-core --target x86_64-apple-darwin`（在 macOS dev 机直接 `cargo check -p kabegame-core` 即可）通过。
- 若 dev 机有 Linux / Windows 交叉编译环境则同样跑；否则**至少**目视核对：
  - `mod macos` / `mod windows` / `mod linux` / `mod noop` 之间互不交叉引用。
  - 平台特定 `use` 都在对应 `#[cfg(...)]` 模块内。

### 2. 设置开关行为

- 启动后默认 OFF：DevTools `useSettingsStore().values.realtimeFolderSync` 应为 `false`；后端 console 无 `[local_folder.watch]` 日志。
- 在 Albums 页打开 settings drawer → 看到「本地文件夹同步 / 实时同步文件夹」分组与开关。
- 切 ON → ElMessage.success 提示；后端 console 应看到 reconcile 日志（首次 add 多少个 album）+ **紧接一次全量 sync 日志**（`sync_all_local_folder_albums` 的 +X/-Y/~Z 汇总）。
- **关 watcher 期间改文件夹 → 开 watcher 立即补齐**：OFF 状态下往某 local_folder album 目录加 / 删一张图 → 切 ON → 无需任何文件系统新事件，画册在数秒内反映该增删（由 worker 启动时的全量 sync 完成）。
- 切 OFF → ElMessage.success 提示；后端日志无新 reconcile / event。
- 重启 app（设置仍为 ON）→ 启动期 spawn 自动重启 manager，同样先 reconcile 再全量 sync。

### 3. macOS 端到端

准备：local_folder album → `/tmp/lf-rt`，目录已有 1 张 jpg 已入库；实时同步 = ON。

- Finder 拖一张 jpg 进 `/tmp/lf-rt` → 1.5 ~ 4 秒内 Albums 页画册预览自动出现新图（无需手动刷新）。后端日志：`[local_folder] sync_album {id} added=1`。
- Finder 删一张 jpg → 同样在 debounce 后自动同步、画册中消失。
- mkdir `/tmp/lf-rt/sub`，往 `sub` 里塞 jpg → 由于非递归过滤，**不**触发该 album 的 sync（子目录文件不入画册，符合 album 一对一非递归语义）。
- 在 `/tmp/lf-rt` 同名替换文件（cp -f）→ 触发 sync；hash 变化 → reimport=1。

### 4. Windows 端到端

同上场景在 Windows 上验证。重点：
- 资源管理器创建 / 删除 / 改名文件触发 sync。
- 在子目录内操作**不**触发 sync（`bWatchSubtree = FALSE`）。
- 任务管理器查看 ReadDirectoryChangesW 的句柄数 = local_folder album 数。

### 5. Linux 端到端

同上场景。重点：
- 在新建子目录里操作不触发（未对子目录 add_watch，inotify 默认不递归）。
- `cat /proc/<pid>/fdinfo/<inotify_fd>` 应看到 N 条 watch（N = local_folder album 数）。

### 6. albums 变化 → reconcile

设置 ON 状态下：
- 新建一个 local_folder album（指向 `/tmp/lf-rt2`）→ 之后往 `/tmp/lf-rt2` 写文件能触发 sync。说明 reconcile 已 add 了新 watch。
- 删除一个 local_folder album → 之后往该 album 原 sync_folder 写文件**不**触发 sync。
- 重命名 album（`rename_album`，sync_folder 不变）→ watch 仍工作，新文件仍触发。

### 7. 错误路径

- sync_folder 路径不存在：reconcile 时 `platform.add` 返回 Err；manager 日志 warn；该 album 不进 desired 集合；后续不触发 event。手动改回真实路径 → 重启 toggle 或 album CRUD 触发 reconcile → 重新 add。
- 设置 ON 期间 disk eject（macOS 拔 USB） → FSEventStream 收到 errored 状态；当前实现**不**自动 remove，下次 reconcile（手动 album CRUD 或 toggle off/on）会 re-add 失败并写 folder_status=missing。**记 TODO**：「设备移除后未自动清理 stream」。

### 8. 非 macOS / Linux / Windows

- Android 上 settings 看不到该开关（registry 守卫）；即便有人篡改设置值 `set_enabled(true)` 走 noop manager，`platform.add` 返回 Err、reconcile 全失败、无后台开销。

### 9. 回归

- 设置 OFF（默认）下：Phase 6 的手动「立即同步」/ 下拉刷新行为完全不受影响。
- album CRUD 性能无可观察回退（reconcile 由 broadcast 订阅驱动，CRUD 路径本身零新增开销）。

---

## 不做的事（明确边界）

- **不**实现"设备移除后自动重连"——FSEventStream / Win32 handle 失效后，要求用户切 toggle 或动 album 重新激活。
- **不**做按文件名 kind 过滤（jpg / mp4 之类）——sync_album 内部已经按 `is_image_or_video_by_path` 过滤；watch 层只是触发器，多触发一次的成本极低（debounce + try_lock 保护）。
- **不**做 watch 路径**实际**就在子目录里的新建子文件夹自动加 watch（"递归监听"）——Phase 4 创建期递归展开已经给每个子目录单独建了 album，每个 album 自带一个 watch；运行期新建的子目录**不**自动转成新 album（这是产品决策，与"一对一非递归"一致）。
- **不**做事件 kind 分流（Modify / Created / Deleted 在 manager 层一视同仁）。
- **不**做跨进程 watcher 协调（同一目录被多个 album 监听 → 多个 stream / 多个 wd；总开销 ≪ 监听本身）。
- **不**实现「每张图片级」的精确同步——任何事件都触发整个 album 的 sync_album（已是 Phase 2 最小代价）。
- **不**实现"watcher 启停"的进度反馈——前端 toast 一次性 success / error 即可。
- **不**走 MCP / CLI 暴露开关。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `core-foundation` 0.10 API 与本计划骨架略有差异 | macos.rs 编译失败 | 实施时按 crate doc 微调签名；CFRunLoop 部分若繁琐，可改成 `unsafe extern` 直接 link `CFRunLoopRunInMode`（无需 high-level crate） |
| FSEvents 的事件路径可能是 **目录** 而非文件（默认行为） | parent 判断失效 → 漏触发 | 加 `kFSEventStreamCreateFlagFileEvents` flag（步骤 7 已加）即保证文件级 |
| Windows ReadDirectoryChangesW 的 OVERLAPPED 取消不当导致线程泄漏 | toggle off 后旧 watch 线程残留 | 实施时务必：`SetEvent(stop_event)` → `CancelIoEx(handle, &overlapped)` → `WaitForSingleObject(thread, INFINITE)` → close handles 顺序严格执行 |
| Linux inotify queue overflow（大量事件挤爆 4096 entry buffer） | 收到 `IN_Q_OVERFLOW` 后续事件丢失 | reader_loop 内**检测** mask 含 `IN_Q_OVERFLOW` 时，强制对所有当前 watched album bump 一次 sync（保守 fallback） |
| 多个 album 同 sync_folder | 每个 album 独立 watch，事件重复发到各自 manager | sync_album 内部有 try_lock；重复 trigger 自然吞掉，无 race |
| debounce timer 与 sync_album 在不同 album 间并发 | OK — sync_album 跨 id 并发安全（Phase 3） | 不需要全局串行 |
| manager 任务被 panic 中断（unsafe FFI bug） | watcher 永久失效直到下次重启 toggle | manager 顶层用 `tokio::task::JoinHandle`，但**不**在内部 spawn 处 wrap `AssertUnwindSafe + catch_unwind`——优先暴露 bug；用户感知 watcher 失效后手动 toggle 即可恢复 |
| 启动期同步（Phase 3）与 watcher debounce sync 同 album 撞车 | 第二个 try_lock 失败被跳过 → manager 收事件但 sync 没真跑 | sync 失败 / 跳过后，**event 仍在 inflight**——下一次事件到达会**再次**安排 debounce sync。最坏情况：用户改了文件正巧在启动期同步窗口内，等下一次外部 fs 事件才进库。可接受；用户可手动「立即同步」 |
| album typed 事件太频繁（大批 album CRUD） | 每条事件触发一次 reconcile（含 list_local_folder_albums） | reconcile 幂等且开销小（album 表通常 <千行）；若实测频繁可在 manager 内加 reconcile 自身 debounce（如合并 300ms 内的多次事件），第一版不做 |
| settings drawer 内开关切换时 set 命令同时启停 manager 与保存设置 | 出错时设置已写入但 manager 未启 | setter 先存 → 再 `set_enabled`：即便 watcher 启动失败，下次启动 app 会按设置值再次尝试；用户也可 toggle off/on 重试 |
| Web 构建 `feature = "web"` 下 `kabegame_core::local_folder::watch` 模块完全没有 platform impl（除 noop） | 编译错 | `set_enabled` 的实现整体放在 `#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]`；web 构建提供 stub `pub async fn set_enabled(_:bool){}` |
| 大目录（10k+ 文件）初次 add watch 时 inotify_add_watch 触发的内核 watch 上限 (`/proc/sys/fs/inotify/max_user_watches` 默认 8192) | add 返回 ENOSPC | 我们每个 album **一个** watch（不是每个文件），上限只在 album 数 > 8192 时撞——可忽略；若真撞，平台 add 返回的错误会被 log，用户可看到 |

---

## 关键 grep 自检

```bash
# 1. 没有引入 notify / inotify crate
rg "^notify\b|^inotify\b|^inotify-sys\b|^fsevent" src-tauri/*/Cargo.toml

# 2. 模块树齐全
ls src-tauri/kabegame-core/src/local_folder/watch/

# 3. 确认没有遗留 bump_reconcile（已改为订阅 EventBroadcaster）
rg "bump_reconcile" src-tauri   # 期望 0 命中
# 确认 manager 订阅了 album typed 事件
rg "subscribe_filtered_stream|AlbumAdded|AlbumChanged|AlbumDeleted" src-tauri/kabegame-core/src/local_folder/watch/mod.rs

# 4. 启动期 cfg 守卫
rg "set_enabled\(true\)" src-tauri/kabegame/src/lib.rs

# 5. provider DSL 路由
rg "byType" src-tauri/kabegame-core/src/providers/dsl/albums/

# 6. 前端开关只在 albums 页 + desktop 显示
rg "realtimeFolderSync" apps/kabegame/src packages/core/src

# 7. SettingKey 注册三件套（Rust enum / default / 前端 map）
rg -n "RealtimeFolderSync|realtimeFolderSync" src-tauri/kabegame-core/src/settings.rs packages/core/src/stores/settings.ts
```

---

## 关键参考定位

- [Phase 3 `sync_album` 顶层入口（带 try_lock）](./local-folder-album-sync-phase3.md#1-core-侧per-album-mutex--顶层入口) — watcher debounce 到期后调用对象。
- [Phase 2 `STABLE_FOR_MS = 3000`](./local-folder-album-sync-phase2.md) — 仍生效；事件触发的 sync 内部继续跳过未稳定文件，下次事件再补。
- [Phase 1 `Album.syncFolder` / `albums.sync_folder` 字段](./local-folder-album-sync-phase1.md) — manager reconcile 读取来源。
- [`settings.rs::SettingKey`](../../src-tauri/kabegame-core/src/settings.rs) — 新 key 插入点。
- [`useSettingKeyState`](../../packages/core/src/composables/useSettingKeyState.ts)（按文件名 grep） — 前端开关组件用的 composable。
- [`WallpaperRotationEnabledSetting.vue`](../../apps/kabegame/src/components/settings/items/WallpaperRotationEnabledSetting.vue) — 开关组件最相近的参考实现。
- [`quickSettingsRegistry.ts`](../../apps/kabegame/src/settings/quickSettingsRegistry.ts) — `pages: ["albums"]` 模式参考。
- [`albums_root_provider.json5`](../../src-tauri/kabegame-core/src/providers/dsl/albums/albums_root_provider.json5) — 新 `byType` 路由插入位置。
- [`startup.rs::start_event_loop`](../../src-tauri/kabegame/src/startup.rs#L322) — 后端事件副作用的既有范例（`SettingChange` 改调度器并发 / 语言切换刷托盘）；本计划 manager 复用同一条 `EventBroadcaster` 总线，但**自订阅**而非挂在此循环里。
- [`ipc/events.rs::DaemonEvent::Album*`](../../src-tauri/kabegame-core/src/ipc/events.rs#L272) — manager 订阅的 typed 事件定义。
- [`emitter.rs::emit_album_added/changed/deleted`](../../src-tauri/kabegame-core/src/emitter.rs#L367) + [`storage/albums.rs`](../../src-tauri/kabegame-core/src/storage/albums.rs) 的 5 处发射点 — reconcile 的触发来源（无需新增）。
- [cocs/provider-dsl/RULES.md](../../cocs/provider-dsl/RULES.md) — DSL resolve / properties 语义。
- [test/native-auto-import/src/main.rs](../../test/native-auto-import/src/main.rs) — macOS native watcher 参考实现（mdfind / NSMetadataQuery 部分**不**移植，仅借鉴 stable 过滤思路）。
