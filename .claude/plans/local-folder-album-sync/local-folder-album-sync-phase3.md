# Phase 3 — 启动期同步 + IPC 命令

> 隶属：[local-folder-album-sync.md](./local-folder-album-sync.md)
> 前置：[Phase 2](./local-folder-album-sync-phase2.md) 完成（`kabegame_core::local_folder::sync_album` 可调用，已带 storage 辅助方法 `list_local_folder_albums` / `update_album_folder_status`）。
> 范围：把 sync 入口暴露给 Tauri / Web RPC；在 app `init()` 里 spawn 一次启动期同步；加上**单画册级**并发互斥；**不**修改任何前端文件。
> 完成后：通过 DevTools `invoke('sync_local_folder_album', { albumId })` 能触发同步并看到 `images-change` / `album-images-change` / `album-changed` 事件流；启动时自动跑一遍现有 local_folder album 的同步而不阻塞窗口创建。

---

## 已确认的设计点（沿用根计划 / 用户答复）

1. **平台范围**：所有面向外部的入口（IPC / 启动期）仅在 `cfg(target_os = "macos")` 下生效。
   - **不**整个 cfg 掉命令注册——这会导致前端在非 macOS invoke 时报 `not found`，前端难处理。
   - 改为：命令始终注册，但非 macOS 实现直接 `Err("local folder sync is macOS-only in this build")`；启动期 spawn 在非 macOS 下整段跳过。
   - 这与 [src-tauri/kabegame/src/lib.rs:327](../../src-tauri/kabegame/src/lib.rs#L327) 上 `surf_*` 命令的 `#[cfg(not(target_os = "android"))]` 模式不同——surf 是 Android 永远没有的；local_folder 是"暂时只在 macOS 开"，命令名保持平台一致更利于前端逐步打开。
2. **并发**：同 `album_id` **丢弃后到请求**——第二次调用立即返回 `SyncReport { skipped_in_flight: true, .. }`，**不**阻塞等待。不同 `album_id` 可并发。用一个 `OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>`，按 id 取独立 Mutex，再用 `try_lock()` 非阻塞获取；失败即丢弃。
3. **启动期失败不向上**：每个 album 出错只 log + 写 folder_status（已在 Phase 2 内部完成）；spawn 任务不影响 setup() 返回。
4. **Web RPC**：第一版**接入** `web/dispatch.rs`（与 `add_album` 等保持对称），同样在非 macOS 返回错误。前端 web 模式即便不用也不会破坏调度器初始化。
5. **不暴露给 MCP / CLI**：本 Phase 不在 [mcp_server](../../src-tauri/kabegame/src/mcp_server.rs) 或 kabegame-cli 中注册。

---

## 涉及文件清单

新增：
- 无新文件。

修改：
- [src-tauri/kabegame/src/commands_core/album.rs](../../src-tauri/kabegame/src/commands_core/album.rs) — 加 `sync_local_folder_album` / `sync_local_folder_albums` 业务函数
- [src-tauri/kabegame/src/commands/album.rs](../../src-tauri/kabegame/src/commands/album.rs) — Tauri `#[tauri::command]` 包装
- [src-tauri/kabegame/src/lib.rs](../../src-tauri/kabegame/src/lib.rs) — `generate_handler!` 注册 + `init()` 末尾 spawn 启动期同步
- [src-tauri/kabegame/src/web/dispatch.rs](../../src-tauri/kabegame/src/web/dispatch.rs) — 注册两个 method
- [src-tauri/kabegame-core/src/local_folder/sync.rs](../../src-tauri/kabegame-core/src/local_folder/sync.rs) — 加 per-album mutex 包装；导出 `sync_all_local_folder_albums(serial: bool)` 顶层入口
- [src-tauri/kabegame-core/src/local_folder/mod.rs](../../src-tauri/kabegame-core/src/local_folder/mod.rs) — re-export 新增的入口

不修改：
- 任何前端文件（Phase 4/5/6 处理）。
- IPC handler 之外的注册（不动 MCP，不动 CLI）。
- `Storage` 辅助方法（Phase 2 已建 `list_local_folder_albums` + `update_album_folder_status`，本 Phase 直接消费）。
- `Album` 结构或迁移（Phase 1 已定型）。

---

## 步骤

### 1. core 侧：per-album mutex + 顶层入口

**`src-tauri/kabegame-core/src/local_folder/sync.rs`** —— 在 Phase 2 已写好 `sync_album` 的基础上，在文件顶部加一组 mutex 管理：

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

/// 单 album 级互斥：保证同一个 album_id 不会被两次并发 sync。
/// 跨 album_id 互不阻塞——HashMap 拿到 Arc 后即释放 std Mutex。
fn album_locks() -> &'static StdMutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn lock_for(album_id: &str) -> Arc<AsyncMutex<()>> {
    let mut map = album_locks().lock().expect("album_locks poisoned");
    map.entry(album_id.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}
```

把原 `pub async fn sync_album(album_id: &str) -> ...` 重命名为 `async fn sync_album_inner(album_id: &str) -> ...`（保留原实现），新增对外入口（**try_lock 非阻塞**，已在跑就丢弃）：

```rust
pub async fn sync_album(album_id: &str) -> Result<SyncReport, String> {
    let lock = lock_for(album_id);
    // try_lock：若该 album 正在 sync，立刻丢弃后到请求，不排队等待。
    let _guard = match lock.try_lock() {
        Ok(g) => g,
        Err(_) => {
            log::debug!("[local_folder] sync_album {album_id} skipped: already in flight");
            return Ok(SyncReport {
                album_id: album_id.to_string(),
                skipped_in_flight: true,
                ..Default::default()
            });
        }
    };
    sync_album_inner(album_id).await
}
```

> **语义**：用户主动多次点击刷新、启动期 spawn 与画册创建后自动 sync 撞车——任何场景下"后到请求"都立刻返回带 `skippedInFlight: true` 的 SyncReport。前端可据此决定是否提示"正在同步中…"或静默忽略。
>
> **不要**把 mutex map 的清理也写在这里——`Arc` 计数到 0 也没人清空 HashMap，长期跑下 HashMap 会无限增长。Album 总数有限（< 数千量级，受用户创建上限影响），权衡之下不清理是简单且安全的选择；如需清理留 TODO。

**`sync_all_local_folder_albums`** 顶层批处理：

```rust
use crate::storage::Storage;

/// 启动期一次性同步所有 local_folder album。串行执行；任一 album 失败只 log，不阻断后续。
/// 返回每个 album 的 SyncReport（顺序与 list_local_folder_albums 一致）。
pub async fn sync_all_local_folder_albums() -> Vec<SyncReport> {
    let albums = match Storage::global().list_local_folder_albums() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[local_folder] list_local_folder_albums failed: {e}");
            return Vec::new();
        }
    };
    let mut reports = Vec::with_capacity(albums.len());
    for album in albums {
        match sync_album(&album.id).await {
            Ok(r) => reports.push(r),
            Err(e) => {
                log::warn!(
                    "[local_folder] sync_album {} failed: {e}",
                    album.id
                );
            }
        }
    }
    reports
}

/// 批量同步指定 album 集合；同样串行。
pub async fn sync_albums_by_ids(ids: &[String]) -> Vec<Result<SyncReport, String>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(sync_album(id).await);
    }
    out
}
```

**`local_folder/mod.rs`** 末尾 re-export：

```rust
pub use sync::{sync_album, sync_albums_by_ids, sync_all_local_folder_albums, SyncReport};
```

#### 1.1 `SyncReport` 追加序列化派生与 `skipped_in_flight` 字段

Phase 2 已经把 `SyncReport` 定义为 `#[derive(Debug, Default)]`。本 Phase **追加** `Serialize, Deserialize, Clone` 与 `skipped_in_flight` 字段：

```rust
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub album_id: String,
    pub status: Option<FolderStatus>,
    pub added: usize,
    pub deleted: usize,
    pub reimported: usize,
    pub skipped_unstable: usize,
    /// 若 true：本次调用因已有同 album sync 在飞而被丢弃；其余计数字段均为 0。
    /// 前端可据此区分"已同步完成（0 变更）"vs"被并发丢弃"。
    pub skipped_in_flight: bool,
}
```

序列化为 `skippedInFlight: boolean`。

并核对 Phase 2 的 `FolderStatus` 已经 `Serialize`（步骤 1 已经派生）。

### 2. `commands_core/album.rs` — 业务层

在文件末尾追加：

```rust
// ─── local folder sync (macOS-only at the product level) ─────────────────────

#[cfg(target_os = "macos")]
pub async fn sync_local_folder_album(album_id: String) -> Result<Value, String> {
    let report = kabegame_core::local_folder::sync_album(&album_id).await?;
    serde_json::to_value(report).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn sync_local_folder_album(_album_id: String) -> Result<Value, String> {
    Err("local folder sync is macOS-only in this build".into())
}

#[cfg(target_os = "macos")]
pub async fn sync_local_folder_albums(album_ids: Vec<String>) -> Result<Value, String> {
    let results = kabegame_core::local_folder::sync_albums_by_ids(&album_ids).await;
    // 把 Vec<Result<SyncReport, String>> 转为 Vec<{ albumId, ok: SyncReport | null, err: string | null }>
    let payload: Vec<Value> = album_ids
        .iter()
        .zip(results.into_iter())
        .map(|(id, r)| match r {
            Ok(rep) => serde_json::json!({
                "albumId": id,
                "ok": rep,
                "err": null,
            }),
            Err(e) => serde_json::json!({
                "albumId": id,
                "ok": null,
                "err": e,
            }),
        })
        .collect();
    Ok(Value::Array(payload))
}

#[cfg(not(target_os = "macos"))]
pub async fn sync_local_folder_albums(_album_ids: Vec<String>) -> Result<Value, String> {
    Err("local folder sync is macOS-only in this build".into())
}
```

**设计取舍**（批量返回结构）：批量 sync 不能因一个 album 报错就全失败，所以每条独立 `ok|err`。前端可一次拿到所有结果，按需 toast。

### 3. `commands/album.rs` — Tauri 命令包装

文件顶部 `use` 区追加（如果尚无）：

```rust
use serde_json::Value;
```

文件末尾追加：

```rust
#[tauri::command]
pub async fn sync_local_folder_album(album_id: String) -> Result<Value, String> {
    crate::commands_core::album::sync_local_folder_album(album_id).await
}

#[tauri::command]
pub async fn sync_local_folder_albums(album_ids: Vec<String>) -> Result<Value, String> {
    crate::commands_core::album::sync_local_folder_albums(album_ids).await
}
```

### 4. `lib.rs` — 注册 handler

在 [src-tauri/kabegame/src/lib.rs:276](../../src-tauri/kabegame/src/lib.rs#L276) 的 `tauri::generate_handler!` 的 `// --- Albums ---` 段末尾追加（紧跟 `get_favorite_album_id` 后）：

```rust
sync_local_folder_album,
sync_local_folder_albums,
```

不需要任何 `#[cfg(target_os = "macos")]` —— 命令本身在所有平台都注册，函数实现里 cfg 分支已经覆盖。

### 5. `lib.rs` — 启动期 spawn

在 `init()`（[lib.rs:72](../../src-tauri/kabegame/src/lib.rs#L72)）的末尾、`init_kgpg_plugin();`（[lib.rs:166](../../src-tauri/kabegame/src/lib.rs#L166)）之前，追加：

```rust
// 启动期：异步同步所有 local_folder album。
// macOS-only；不阻塞 setup() 返回，每个 album 内部错误自吞。
#[cfg(all(target_os = "macos", not(feature = "web")))]
tauri::async_runtime::spawn(async {
    let reports = kabegame_core::local_folder::sync_all_local_folder_albums().await;
    if !reports.is_empty() {
        let added: usize = reports.iter().map(|r| r.added).sum();
        let deleted: usize = reports.iter().map(|r| r.deleted).sum();
        let reimported: usize = reports.iter().map(|r| r.reimported).sum();
        println!(
            "[local_folder] startup sync done: {} albums, +{added}/-{deleted}/~{reimported}",
            reports.len()
        );
    }
});
```

并在 `web` 入口（[lib.rs:191](../../src-tauri/kabegame/src/lib.rs#L191) 附近 `run()` 的 web 分支）追加同等 spawn：

```rust
#[cfg(target_os = "macos")]
tauri::async_runtime::spawn(async {
    let _ = kabegame_core::local_folder::sync_all_local_folder_albums().await;
});
```

> **取舍**：log macro 上面用 `println!` 与现有 `lib.rs` 内的 log 风格保持一致（项目里 `init()` 大量 `println!`）。如果用户后续切到 `log` crate 再统一改。

### 6. `web/dispatch.rs` — Web RPC 注册

在 [web/dispatch.rs](../../src-tauri/kabegame/src/web/dispatch.rs) 的 `init_registry()` 内、albums 段（`add_album` / `delete_album` 附近）追加两条：

```rust
#[derive(Deserialize)]
struct SyncLocalFolderAlbumArgs {
    album_id: String,
}

map.insert(
    "sync_local_folder_album",
    MethodEntry {
        requires_super: true, // 写类操作（启动同步会改 DB），需要 super 权限
        handler: Arc::new(|p| {
            Box::pin(async move {
                let args: SyncLocalFolderAlbumArgs = serde_json::from_value(p)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::commands_core::album::sync_local_folder_album(args.album_id)
                    .await
                    .map_err(RpcError::internal)
            })
        }),
    },
);

#[derive(Deserialize)]
struct SyncLocalFolderAlbumsArgs {
    album_ids: Vec<String>,
}

map.insert(
    "sync_local_folder_albums",
    MethodEntry {
        requires_super: true,
        handler: Arc::new(|p| {
            Box::pin(async move {
                let args: SyncLocalFolderAlbumsArgs = serde_json::from_value(p)
                    .map_err(|e| RpcError::invalid_params(e.to_string()))?;
                crate::commands_core::album::sync_local_folder_albums(args.album_ids)
                    .await
                    .map_err(RpcError::internal)
            })
        }),
    },
);
```

> `requires_super` 与 `add_images_to_album` / `delete_album` 对齐（看 [web/dispatch.rs](../../src-tauri/kabegame/src/web/dispatch.rs) 内现有写类操作的标记）。本计划假设是 `true`；实施时按周围最近的同类条目对齐即可。

### 7. ACL / Capability（Tauri v2 ACL）

参考 [cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md](../../cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md)。

Tauri 自动生成的 capability 通常允许同 plugin 内所有 `#[tauri::command]`；album 类命令一般在主 capability 集中，**预期无需手工改 capability/permission JSON**。

**核对项**：实施时 grep `src-tauri/kabegame/capabilities/*.json` 看是否对 `add_album` / `delete_album` 有显式 allowlist；若有，把两个新命令追加进同一 list。如果 capability 文件使用通配符（如 `"kabegame:*"`），无需改动。

---

## 验收清单

1. **类型检查**：
   - `bun check -c kabegame` 通过。
   - `cargo check -p kabegame-core`、`cargo check -p kabegame` 通过（在 macOS 上即可）。
   - 在 Linux/Android 目标上无法本机 check 时，靠 cfg 注释审查覆盖：手工核对 `commands_core::album::sync_local_folder_album` 的非 macOS 分支不引用 `kabegame_core::local_folder::*`，编译应能通过。
2. **手工冒烟（macOS）**：
   - dev 库里手工 INSERT 一个 `type='local_folder', sync_folder='/tmp/test'` 的 album，路径里放一张 jpg；
   - `bun dev -c kabegame`，启动 console 看到 `[local_folder] startup sync done: 1 albums, +1/-0/~0`；
   - DevTools 监听 `album-images-change`、`images-change`、`album-changed` 事件应收到一组对应该 album 的 add 事件；
   - 控制台 `invoke('sync_local_folder_album', { albumId: '<id>' })` 返回 `SyncReport`（camelCase），二次调用 `added: 0`、`status.state: "ok"`。
3. **错误路径**：
   - sync_folder 改成不存在路径 → 再次 invoke：返回 `SyncReport.status.state = "missing"`，DB 中 `folder_status` 列写入了 JSON。
   - album_id 不存在 → invoke 返回 `Err("album xxx not found")`（来自 Phase 2 的 `sync_album_inner`）。
   - 普通 album（kind=normal）传入 → 返回 `Err("album xxx is not a local_folder album")`。
4. **并发**：
   - 同一 album_id 连续 invoke 两次（中间不等待）→ **第一次**返回 `skippedInFlight: false`，正常 SyncReport；**第二次**几乎立刻返回 `skippedInFlight: true`，其余计数为 0。可在 `sync_album_inner` 入口加临时 `eprintln!("enter {}", album_id)` + `eprintln!("leave {}", album_id)` 验证只看到一对 enter/leave（验证后回滚）。
   - 不同 album_id 并发 invoke → 都能进入，无相互等待。
   - **批量入口** `sync_local_folder_albums(["A","A","B"])`：返回三条；第一条 A 是真同步，第二条 A 因 `try_lock` 失败被丢弃（注意：批量内部是串行 `for id in ids { sync_album(id).await }`，因此第一条 A 跑完后第二条 A 进入时锁已释放——**第二条 A 不会被丢弃**。如果用户要"批量去重"需在 commands_core 层 dedup ids；本 Phase 不做去重，保留语义"逐个调用"）。
5. **非 macOS 行为**：
   - 在 Linux/Android 上 invoke 任一新命令 → 返回 `Err("local folder sync is macOS-only in this build")`，不 panic、不挂起。
   - 启动期不出现任何 local_folder 相关日志（spawn 段被 cfg 掉）。
6. **回归**：
   - 现有非 local_folder album 的所有命令、行为不变。
   - `bun dev` 启动时间无显著回退（startup spawn 是后台任务，不进 setup 关键路径）。

---

## 不做的事（明确边界）

- **不**写前端代码（`stores/albums.ts`、`Albums.vue`、`AlbumDetail.vue` 全部留给 Phase 4/5/6）。
- **不**给前端加 invoke 包装或类型导出——Phase 4 才需要前端能调它。
- **不**实现实时监听（FSEvents / NSMetadataQuery）——留 Phase 7。
- **不**对 local_folder album 加只读守卫（add_images_to_album 等仍可对其操作）——留 Phase 5。
- **不**做 ACL / capability 文件改动，除非核对发现确有 allowlist 需要追加。
- **不**接入 MCP 工具或 CLI 命令。

---

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Phase 2 的 `sync_album` 当前签名签字 `pub async fn`，被 Phase 3 改名为 `sync_album_inner` | 若 Phase 2 的单测/外部调用引用了 `sync_album` 直接路径，会断 | Phase 3 保留 `pub async fn sync_album` 作为包装入口；Phase 2 的单测无需修改 |
| per-album mutex map 长期不清理 | 内存随历史 album 数累加 | album 总数远小于内存压力阈值；记 TODO 不实现 |
| 启动 spawn 在 setup() 调用前/后的时序差 | sync 可能在 Storage 未完全初始化时跑 | 启动 spawn 位置选在 [`init()`](../../src-tauri/kabegame/src/lib.rs#L72) 内、`init_globals()`（行 83）之后，确保 `Storage::global()` 已就绪 |
| Web RPC 注册位置选错段 | dispatch 编译错或参数解析失败 | 与 `add_album` 紧邻插入，保持参数 args 结构体命名/驼峰一致 |
| capability 文件需要追加但未发现 | invoke 返回 `Not allowed by the configured permissions` | 在 macOS 上启动后立刻 invoke 一次新命令，若失败立刻去查 [capabilities/](../../src-tauri/kabegame/capabilities/) |
| 启动期 sync 与用户手工触发的 sync 同时跑同一 album | 后到请求被丢弃，用户感知"刷新无效" | 前端在收到 `skippedInFlight: true` 时给 toast `"同步进行中…"`（Phase 6 接入）；本 Phase 后端语义已对，纯文档约定 |
| 启动期 spawn 内部循环遇到一个慢 album → 后续 album 同步被推迟 | 单画册问题拖慢全量 | 启动期串行是有意为之（避免 IO 同时打到磁盘），保留；用户手工 invoke 不受影响 |
| `SyncReport` 派生 Serialize 后影响 Phase 2 单测 | 单测可能依赖 Default 派生 | 派生表追加 `Serialize, Deserialize, Clone` 不影响 Default；Phase 2 单测无需改 |

---

## 关键 grep 自检

完成后跑：

```bash
# 命令完整登记：lib.rs handler 与 web/dispatch 各两处
rg -n "sync_local_folder_album" src-tauri/kabegame/src

# core 入口三件套都被 re-export
rg -n "sync_album|sync_albums_by_ids|sync_all_local_folder_albums" \
   src-tauri/kabegame-core/src/local_folder

# 非 macOS 分支必须能在 cfg(not(target_os = "macos")) 上编译通过
# 手工目视：commands_core/album.rs 的非 macOS 分支 0 引用 kabegame_core::local_folder::
rg -n "kabegame_core::local_folder" src-tauri/kabegame/src/commands_core/album.rs
```

---

## 关键参考定位

- [`init()`](../../src-tauri/kabegame/src/lib.rs#L72) — 启动期 spawn 插入点（`init_kgpg_plugin();` 之前）。
- [`generate_handler!` 块](../../src-tauri/kabegame/src/lib.rs#L276) — handler 注册位置（`// --- Albums ---` 段末尾）。
- [`web/dispatch.rs init_registry`](../../src-tauri/kabegame/src/web/dispatch.rs#L67) — Web RPC 注册位置。
- [`commands_core/album.rs`](../../src-tauri/kabegame/src/commands_core/album.rs) — 业务层（Web RPC 与 Tauri 命令共享）。
- [`commands/album.rs`](../../src-tauri/kabegame/src/commands/album.rs) — Tauri 命令薄包装。
- [`emit_album_changed`](../../src-tauri/kabegame-core/src/emitter.rs#L367) — Phase 2 `persist_status` 调用对象，签名是 `(album_id, changes: serde_json::Value)`，Phase 2 实施时注意第二个参数（写 `serde_json::json!({"folderStatus": status.to_json()})`）。本 Phase 不动，但记下，用于排查事件流。
