# 壁纸轮播：每个目标一个 PathQL 路径 + 持久化位置

## 模型

轮播的状态挂在**壁纸目标**上。目标是壁纸设置的单位，全部目标存在设置键 `wallpaperTargets: { [目标 id]: 配置 }` 里；目标 id、活跃目标与默认目标的规则见 [MULTI_SCREEN.md](MULTI_SCREEN.md)。各屏复制下只有 `multiple` 一个活跃目标（所有显示器同一张）；逐屏独立下每块在线屏一个（目前只有 macOS 的窗口模式可选）。

每个目标的轮播来源是配置里的两个字段，当前壁纸是第三个：

| 字段 | 含义 |
| --- | --- |
| `rotationPath` | 完整 PathQL 路径（`images://…`，不含分页尾）；`null` 表示还没设置，rotator 首次使用时写入默认路径 |
| `rotationPosition` | 下一张在路径里的 0 起序号；当前壁纸不在路径里时才用它定起点。`-1`（`WALLPAPER_ROTATION_FROM_START`）表示刚换了路径：下一次从第 1 张开始、不按当前壁纸定位 |
| `currentImageId` | 该目标当前壁纸的图片 id |

轮播开关 `wallpaperRotationEnabled` 与间隔 `wallpaperRotationIntervalMinutes` 仍是全局设置：一开全开，所有目标同一个节拍。

随机 / 顺序、画册 / 子画册不是设置，而是路径的一部分：`sort/random-<seed>`、`album/<id>`、`album-tree/<id>`、任意过滤与排序都行。默认路径是 `images://gallery/hide/sort/random-<seed>`（全画廊、排除隐藏、随机）。

`WallpaperTargetConfig::set_rotation_path` 只在值真正变化时把位置置为 `-1`；停止 / 开始轮播、重启应用不经过它，位置保持。

起点的优先级是「当前壁纸的下一张」高于持久化位置：查询视图会随图片增删、改字段（收藏、标签、时间……）而变，同一个序号可能已经指向别的图，所以每次切换先用 `~~/rank` 查该目标的 `currentImageId` 在有效路径里的序号。因此

- 停开轮播、重启应用、视图里有增删 → 接着当前壁纸的下一张；
- 换了路径 → 位置为 `-1`，下一次切换从第 1 张开始。`set_wallpaper_rotation_path(path, target?)` 命令（app IPC 变体复用它）在路径真正变化后随即调 `rotator.rotate(Some(目标))`，不论轮播是否开启都立刻把这个目标切一次，其它目标不动：线程运行中由线程切（带过渡并重置计时器），否则在命令里直接切。之后的切换以这张为当前壁纸续接。同一路径再设一次不算变化，不切换。
- 其它换路径（rotator 在路径为空时写入默认、出错回落默认，删除轮播中的画册把路径置空）同样得到 `-1`，不立即切换，下一次切换从第 1 张开始。`-1` 是持久化的，中途重启、切换壁纸模式（`relocate_position_for_mode` 遇 `-1` 不动）都不会丢。

路径约定（纯字符串）在 `kabegame_core::wallpaper_rotation`，选图与线程在 `src-tauri/kabegame/src/wallpaper/rotator.rs`。

## 轮播线程

一个开关、一个间隔、一个 ticker。线程启动后不立刻切，第一次自动切换在一个间隔之后。

- **定时器到期**：对当前所有活跃目标各切一张，按活跃目标的顺序（默认目标在前）逐个进行。活跃目标每轮现取（`WallpaperController::layout()`），显示器模式变化后下一轮即生效。一个目标失败只记日志，不影响其它目标，下一轮照常再试。
- **手动切换**：`WallpaperRotator::rotate(target: Option<&str>)`，`Some` 只切这个目标，`None` 切所有活跃目标。线程运行中时登记请求并唤醒线程，同一轮里的多个请求合并（「全部」吸收指定目标）；请求里已不在活跃集合的目标被丢弃。线程没在运行时在调用处直接切，全部试过后把第一个错误交给调用方，轮播开着的话随后拉起线程。调用方有三处：换某个目标的轮播路径、改过渡后的演示、托盘「下一张」（`rotate(Some(target_at_cursor()))`：逐屏独立下是光标所在屏的目标，取不到用默认目标；其它显示器模式是唯一目标）。
- **计时**：每次切换之后计时器从现在起算，所以手动切一个目标也会让所有目标的下一次自动切换顺延。`reset()` 只重置计时、不切换。改间隔后从那一刻起算一个新间隔，不会立刻切。
- **区分唤醒原因**：线程区分「定时器到期」与「被 notify 唤醒」。`rotate()` 紧跟 `reset()` 时两个请求在同一轮一起处理，第二次 notify 留下的 permit 会让下一轮在没有请求时醒来，这种情况直接跳过，不能当成定时器到期再切一次。
- **启动条件**：`ensure_running` 逐个活跃目标解析轮播来源（没有路径的写入默认路径、坏路径回落），至少一个目标的路径下有图片才启动。线程由 `stop()` 结束（关轮播、关壁纸，以及切壁纸模式 / 显示器模式时的先停后启）；线程还在而全局开关已关时，到点与手动请求都不切换。

线程主体对外只依赖一个小接口（开关、间隔、活跃目标、切一个目标），单测用假的活跃目标列表驱动它，覆盖了上面每一条。

## 每次切换

以下是一个目标的一次切换。

1. **有效路径**：壁纸模式为原生（非 `window` / `plasma-plugin`，含 Android）时，在目标的轮播路径尾部拼 `/_kb_fc/media-type/image`。全局 `_kb_fc` 在任何段都先于当前 provider 解析，条件 AND 进去，前面的排序保留。count 本身只数图片（`media-type/image` 不含视频，也不含 WPE），每一页都是图片，不需要逐张跳过视频。Plasma 插件模式的有效路径不带媒体过滤，WPE 行仍靠 rotator 的 `allow_wpe` 逐张跳过。
2. **count**：`count_at(有效路径)`。出错（路径坏了、画册已删……）就把该目标的路径换成新的默认随机路径（位置随之置为 `-1`）再 count 一次。`count == 0` 本轮跳过，不关闭轮播。
3. **定起点**：位置为 `-1` 时从 0 开始；否则取 `<有效路径>/~~/rank/~~/id_<该目标的 currentImageId>` 的 `row_index`（当前壁纸的 1 起序号 = 下一张的 0 起位置），找到就写回位置并以它为起点；当前 id 为空、或不在有效路径里（已被过滤掉、删掉、换了视图），才用持久化位置。
4. **取行**：位置 ≥ count 时回到 0（走到末尾统一回到第 1 张，随机路径也不换种子），取 `rows_path(有效路径, 1, 位置 + 1)`。画廊路径转成 `images://filter/…/_kb_x1x/<页>/~~/rank/~~p/lookup/gallery`，与前端 `toLookupRowsPath` 同构，避免深页慢。取行出错与 count 出错同样处理。
5. **文件已不存在**：顺延到下一位置，最多扫满一轮（count 张）。
6. **写回**：先写 `位置 = 本张位置 + 1`（即使设壁纸失败，下一轮也不会卡在同一张），再把**原始 `local_path`** 连同该目标的有效样式、有效过渡与布置交给 `manager.set_wallpaper`，然后写该目标的 `currentImageId` 与图片的 `lastSetWallpaperAt`。位置与当前壁纸各写一次目标，各发一次 `setting-change`（载荷是整个目标 map）。

壁纸兼容副本不在 rotator 里处理：原生后端在 `native.rs` 内经 `wallpaper_compat::ensure_native_wallpaper_path` 按需生成 / 复用 `wallpaper_compatible_path`（见 [NATIVE_WALLPAPER_COMPAT.md](NATIVE_WALLPAPER_COMPAT.md)）。rotator 不读这个字段，也不绕过 manager。

定时器分支与手动切换共用 `advance_and_apply(target_id)`；目标必须在活跃集合里。

## 切换壁纸模式

模式切换会给有效路径加上或去掉图片过滤，同一个位置指向的图就变了。下一次切换的「定起点」本身会按当前壁纸重定位；`set_wallpaper_mode` 落库后仍调用 `relocate_position_for_mode`，对设置里有轮播路径的每个目标（不只是活跃的）用同一个 rank 查询（与前端 `locateImageRowIndex` 同一形态）提前写回位置，让设置值与新模式一致。当前 id 为空、不在新有效路径里（例如当前是视频、切到原生），或位置为 `-1`，就保留原位置。路径没变，这不算「路径变化」。切壁纸模式的完整顺序见 [MULTI_SCREEN.md](MULTI_SCREEN.md)。

## 入口

设置页以外的入口先经目标选择弹窗 `pickWallpaperTarget({ action: "setRotation" })` 选目标（只有一个活跃目标时不弹、直接是它；取消就什么都不做），再调 `setWallpaperRotationPath(path, target)`（`set_wallpaper_rotation_path` 带 `target`），最后按需打开全局的轮播开关；弹窗见 [MULTI_SCREEN.md](MULTI_SCREEN.md)：

- 画廊 / 画册详情 / 任务详情 / 畅游详情的查询行 ⋯ 面板顶部：「用当前视图轮播」。路径来自所在 `ImageGrid` 注入的 `gridViewKey`（`paged.viewBody`，不含分页尾），查询行自己不认识 route store。原生模式下过滤对象不是「仅图片」时，提示视频会被跳过。按钮下方是收藏视图（见 [../gallery/SAVED_VIEWS.md](../gallery/SAVED_VIEWS.md)）。
- 画册详情栏按钮与画册树右键「设为轮播」、多选「设为壁纸」建的桌面画册：写该画册默认视图路径 `images://gallery/hide/album/<id>/sort/by-album-order`。多选时先选目标再建画册，取消不建。
- 设置页只读展示选中目标的当前路径（`useWallpaperTarget(id)`）。

轮播来源的标记（收藏视图行的 ↻、画册树的显示器图标、画册详情栏徽标）在轮播开着时按「任一活跃目标的路径命中」判断，路径取自 `useActiveWallpaperRotationPaths()`；画册 id 由 `rotationAlbumIdsFromPaths` / `album_id_of` 解析路径根得出。「还能不能再设」看是不是**每个**活跃目标都命中（`useWallpaperRotationSources()` + `rotatingTargetIds`）：只有部分目标命中时，画册的「设为轮播」与查询行的「用当前视图轮播」仍可点（给另一块屏），另给「停止桌面轮播」入口；全部命中时才只剩「停止」/ 置灰成「正在轮播此视图」。只有一个目标时两者重合。

删除画册时，后端把所有目标（含不活跃的）里以该画册为根的轮播路径置空；前端只在删除前提示，路径的变化等 `setting-change`。

`set_wallpaper_rotation_path` 先校验：count 成功、非空、第 1 页能解析成图片行，否则拒绝（非图片 scheme 进不来）。`set_wallpaper_rotation_enabled(true)` 直接拉起轮播线程，失败回滚为关闭。`start_wallpaper_rotation` 返回的路径与回落标记只报默认目标的。

## Android 队列

Android 只有 `multiple` 一个目标、只有原生模式，队列读写的就是它。WorkManager Worker 在冷进程里跑，没有 Rust / PathQL。Rust 按同一套规则（先按当前壁纸定起点）循环预取最多 100 张文件仍在的图（按 100 张一页分块取行），写 `<数据目录>/rotation_queue.json`：

```json
{ "path": "<目标的轮播路径>", "count": 123, "position": 7,
  "items": [{ "id": "42", "localPath": "content://…", "position": 7 }] }
```

触发点：`ensure_running`、`reset`（改间隔、改路径时）、`rotate()` 之后。

Worker 读 settings.json：顶层的 `wallpaperRotationEnabled`，以及 `wallpaperTargets.multiple` 的 `rotationPath` 与 `style.native`（缺省 `fill`）。它只做三件事：队列的 `path` 与 `rotationPath` 不等就不动作（`rotationPath` 为 `null` 时按空串比）；弹出首个文件仍在的 item 设壁纸；把剩余 items、`position = item.position + 1` 与 `currentImageId` 写回队列文件。Worker **不写 settings.json**，避免和运行中的应用互相覆盖。Rust 下次刷新队列时，若文件里的 `path` 等于目标当前的轮播路径、且带 `currentImageId`（Worker 真的切过），先把其中的 `position` / `currentImageId` 同步回 `multiple` 目标，再重新预取（新文件不再带 `currentImageId`，只同步一次）。没有 `currentImageId` 时文件里的 `position` 只是上次写下的起点，同步它会覆盖刚换路径时的 `-1`。旧版的 `rotation_state.json` 在首次刷新时删除。

## 设置迁移

轮播设置经过两次迁移：v003 把更早的三个键换算成一条路径，v005 再把路径、位置连同样式、过渡、当前壁纸并入 `wallpaperTargets.multiple`（规则见 [MULTI_SCREEN.md](MULTI_SCREEN.md) 的「设置迁移 v005」）。从 v2 的设置直接升级时两步连着跑。

v003：旧的三个键由 `settings/migrations/v003_wallpaper_rotation_path.rs` 迁过来（迁移框架见 `settings/migrations/mod.rs` 模块文档，与 `storage/migrations` 同构：按版本顺序、失败不写回、写回前备份 `settings.json.bak-v<旧版本>`）：

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
- `src-tauri/kabegame-core/src/settings/wallpaper_targets.rs`：目标配置里的路径、位置、当前壁纸及其规范化
- `src-tauri/kabegame-core/src/settings/migrations/`：v003 与 v005 迁移
- `src-tauri/kabegame/src/wallpaper/rotator.rs`：选图、写回、模式重定位、Android 队列、轮播线程
- `src-tauri/kabegame/src/wallpaper/manager/mod.rs`：活跃目标（`layout`）、`resolve_target`、`target_at_cursor`
- `src-tauri/kabegame/src/commands/wallpaper.rs`：`set_wallpaper_rotation_path`、`set_wallpaper_rotation_enabled`、`set_wallpaper_mode`
- `src-tauri/kabegame/src/tray.rs`：托盘「下一张」
- `src-tauri/tauri-plugin-wallpaper/android/.../WallpaperRotationWorker.kt`：消费队列
- `apps/kabegame/src/utils/wallpaperRotationPath.ts`、`composables/useWallpaperTarget.ts`、`components/imageGrid/gridViewPath.ts`、`components/gallery/GalleryQueryBar.vue`
- 测试：`kabegame-core/tests/dsl_e2e.rs` 的 `wallpaper_rotation_image_only_tail_keeps_view_order`；`rotator.rs` 内的轮播线程单测
