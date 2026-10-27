# 壁纸轮播：一个 PathQL 路径 + 持久化位置

## 模型

轮播来源只有两个设置：

| 键 | 含义 |
| --- | --- |
| `wallpaperRotationPath` | 完整 PathQL 路径（`images://…`，不含分页尾）；`null` 表示还没设置，rotator 首次使用时写入默认路径 |
| `wallpaperRotationPosition` | 下一张在路径里的 0 起序号 |

随机 / 顺序、画册 / 子画册不再是设置，而是路径的一部分：`sort/random-<seed>`、`album/<id>`、`album-tree/<id>`、任意过滤与排序都行。默认路径是 `images://gallery/hide/sort/random-<seed>`（全画廊、排除隐藏、随机）。

不变式由设置层保证：`Settings::set_wallpaper_rotation_path` 只在值真正变化时把位置清零。所以

- 路径变化 → 从第 1 张开始；
- 停止 / 开始轮播、重启应用 → 路径没变，接着上次的下一张。

路径约定（纯字符串）在 `kabegame_core::wallpaper_rotation`，选图与线程在 `src-tauri/kabegame/src/wallpaper/rotator.rs`。

## 每次切换

1. **有效路径**：壁纸模式为原生（非 `window` / `plasma-plugin`，含 Android）时，在设置路径尾部拼 `/_kb_fc/media-type/image`。全局 `_kb_fc` 在任何段都先于当前 provider 解析，条件 AND 进去，前面的排序保留。count 本身只数图片，每一页都是图片，不需要逐张跳过视频。
2. **count**：`count_at(有效路径)`。出错（路径坏了、画册已删……）就把设置路径换成新的默认随机路径（位置随之清零）再 count 一次。`count == 0` 本轮跳过，不关闭轮播。
3. **取行**：位置 ≥ count 时回到 0（走到末尾统一回到第 1 张，随机路径也不换种子），取 `rows_path(有效路径, 1, 位置 + 1)`。画廊路径转成 `images://filter/…/_kb_x1x/<页>/~~/rank/~~p/lookup/gallery`，与前端 `toLookupRowsPath` 同构，避免深页慢。取行出错与 count 出错同样处理。
4. **文件已不存在**：顺延到下一位置，最多扫满一轮（count 张）。
5. **写回**：先写 `位置 = 本张位置 + 1`（即使设壁纸失败，下一轮也不会卡在同一张），再把**原始 `local_path`** 交给 `manager.set_wallpaper`，然后写 `currentWallpaperImageId` 与 `lastSetWallpaperAt`。

壁纸兼容副本不在 rotator 里处理：原生后端在 `native.rs` 内经 `wallpaper_compat::ensure_native_wallpaper_path` 按需生成 / 复用 `wallpaper_compatible_path`（见 [NATIVE_WALLPAPER_COMPAT.md](NATIVE_WALLPAPER_COMPAT.md)）。rotator 不读这个字段，也不绕过 manager。

定时器分支与手动切换（托盘「下一张」、`rotate()`）共用 `advance_and_apply()`。

## 切换壁纸模式

模式切换会给有效路径加上或去掉图片过滤，同一个位置指向的图就变了。`set_wallpaper_mode` 落库后调用 `relocate_position_for_mode`：取 `<新有效路径>/~~/rank/~~/id_<currentWallpaperImageId>` 的 `row_index`（1 起序号，与前端 `locateImageRowIndex` 同一形态），直接写成位置（0 起的下一张 = 1 起的当前序号）。当前 id 为空、或不在新有效路径里（例如当前是视频、切到原生）就保留原位置。设置路径没变，这不算「路径变化」。

## 入口

- 画廊 / 画册详情 / 任务详情 / 畅游详情的查询行 ⋯ 面板顶部：「用当前视图轮播」。路径来自所在 `ImageGrid` 注入的 `gridViewPathKey`（`paged.viewBody`，不含分页尾），查询行自己不认识 route store。原生模式下过滤对象不是「仅图片」时，提示视频会被跳过。按钮下方预留了「保存的过滤」区域。
- 画册右键「设为轮播」、多选「设为壁纸」建的桌面画册：写该画册默认视图路径 `images://gallery/hide/album/<id>/sort/by-album-order`。「当前轮播画册」由 `rotationAlbumIdFromPath` / `album_id_of` 解析路径根得出；删除这个画册时路径回到默认。
- 设置页只读展示当前路径。

`set_wallpaper_rotation_path` 先校验：count 成功、非空、第 1 页能解析成图片行，否则拒绝（非图片 scheme 进不来）。`set_wallpaper_rotation_enabled(true)` 直接拉起轮播线程，失败回滚为关闭。

## Android 队列

WorkManager Worker 在冷进程里跑，没有 Rust / PathQL。Rust 按同一套规则从当前位置循环预取最多 100 张文件仍在的图（按 100 张一页分块取行），写 `<数据目录>/rotation_queue.json`：

```json
{ "path": "<设置路径>", "count": 123, "position": 7,
  "items": [{ "id": "42", "localPath": "content://…", "position": 7 }] }
```

触发点：`ensure_running`、`reset`（改间隔、改路径时）、`rotate()` 之后。

Worker 只做三件事：`path` 与 settings.json 的 `wallpaperRotationPath` 不等就不动作；弹出首个文件仍在的 item 设壁纸；把剩余 items、`position = item.position + 1` 与 `currentImageId` 写回队列文件。Worker **不写 settings.json**，避免和运行中的应用互相覆盖。Rust 下次刷新队列时，若文件里的 `path` 等于当前设置路径，先把其中的 `position` / `currentImageId` 同步回设置，再重新预取（新文件不再带 `currentImageId`，只同步一次）。旧版的 `rotation_state.json` 在首次刷新时删除。

## 设置迁移

旧的三个键由 `settings/migrations/v003_wallpaper_rotation_path.rs` 迁过来（迁移框架见 `settings/migrations/mod.rs` 模块文档，与 `storage/migrations` 同构：按版本顺序、失败不写回、写回前备份 `settings.json.bak-v<旧版本>`）：

| 旧设置 | 新路径 |
| --- | --- |
| 画册 + 含子画册 + 随机 | `images://gallery/hide/album-tree/<id>/sort/random-<seed>` |
| 画册 + 含子画册 + 顺序 | `images://gallery/hide/album-tree/<id>` |
| 画册 + 不含子画册 + 随机 | `images://gallery/hide/album/<id>/sort/random-<seed>` |
| 画册 + 不含子画册 + 顺序 | `images://gallery/hide/album/<id>/sort/by-album-order` |
| 画廊 + 随机 | `images://gallery/hide/sort/random-<seed>` |
| 画廊 + 顺序 | `images://gallery/hide/all` |

位置从 0 开始；启用状态、间隔、样式、过渡与当前壁纸原样保留。

## 涉及文件

- `src-tauri/kabegame-core/src/wallpaper_rotation.rs`：默认路径、有效路径、取行 / 定位路径、画册解析
- `src-tauri/kabegame-core/src/settings/mod.rs`、`settings/migrations/`：两个设置键与 v003 迁移
- `src-tauri/kabegame/src/wallpaper/rotator.rs`：选图、写回、模式重定位、Android 队列、轮播线程
- `src-tauri/kabegame/src/commands/wallpaper.rs`：`set_wallpaper_rotation_path`、`set_wallpaper_rotation_enabled`、`set_wallpaper_mode`
- `src-tauri/tauri-plugin-wallpaper/android/.../WallpaperRotationWorker.kt`：消费队列
- `apps/kabegame/src/utils/wallpaperRotationPath.ts`、`components/imageGrid/gridViewPath.ts`、`components/gallery/GalleryQueryBar.vue`
- 测试：`kabegame-core/tests/dsl_e2e.rs` 的 `wallpaper_rotation_image_only_tail_keeps_view_order`
