# 区域级文件拖入（`<DragFileZone>` 热区）

外部文件拖进桌面窗口后，**由落点所在的页面区域**决定接不接、提示什么、松手做什么；
从应用自身网格拖出的媒体则由会话标记识别并全程静默。本文说明这套两层结构、坐标命中的
契约，以及几个不写下来就会被重新踩的坑。

平台范围：**仅桌面**（Windows / macOS / Linux，CEF runtime 后端）。
`IS_ANDROID || IS_WEB` 在 `useFileDrop.init()` 里直接 return，Android 走的是 picker 插件，不是拖放。

## 两层结构

```
CEF content 层（Rust）
  TauriCefDragHandler                      src-tauri/tauri-runtime-kbcef/src/webview.rs
  └─ WindowEvent::DragDrop(Enter/Over/Drop/Leave)
       │  Enter 的 position 恒为 (0,0)（见下）；Over/Drop 带真实 client 坐标 × scale factor
       ▼
窗口级监听（路由层，全局唯一）
  useFileDrop.ts                           apps/kabegame/src/composables/useFileDrop.ts
  ├─ enter : 快照内部拖拽标记；外部拖拽才 get_file_drop_kinds(全量) → 存会话、setFocus
  ├─ over  : position → CSS 坐标 → hitTestDragZone → zone.plan(items) → 浮层 show/hide
  ├─ drop  : 重新命中 → plan → await zone.onDrop(plan)
  └─ leave : hide + 清会话
       │
       ▼
区域级热区（语义层，每个区域自己定义）
  <DragFileZone :plan="plan" :on-drop="onDrop">
                                          apps/kabegame/src/components/common/DragFileZone.vue
                                          apps/kabegame/src/utils/dragFileZones.ts（注册表 + 命中）
  ├─ plan(items) → DragFilePlan | null     ← null 就是「本区域拒绝这批文件」
  └─ onDrop(plan) → 执行导入               ← 松手即执行，无确认弹窗
```

浮层是全局单例，挂在 `App.vue`：`components/FileDropOverlay.vue`，
`show({ rect, label, hint })` / `hide()`，按热区的 `DOMRect` 做 `position: fixed` 定位。

### 为什么用组件做注册表

`<DragFileZone>` **只是个注册表条目**：`onMounted` 把根元素和响应式 props 登记进模块级 Map，
`onBeforeUnmount` 注销。它不绑 `dragover`/`drop`，因为原生 drag 事件根本到不了 DOM —— CEF 在
content 层（`ChromeWebContentsViewDelegateCef::OnPerformingDrop`，见 `third-patches/cef/02`）
就把 drop 拦掉并 veto 了，渲染进程收不到任何拖放事件。坐标命中是唯一可用的路由手段。

注册表存的是**响应式 props 本身**，命中时读到的 `disabled` / `plan` 永远是最新值；页面不需要再写
`computed` 传 options。`tag` 默认 `div`，需要根元素是别的标签时传 `tag`。组件根元素就是热区，
`class` / 透传 attrs / `v-pull-to-refresh` 之类的指令都会落到这个根元素上。

### 为什么 `enter` 不做命中

`TauriCefDragHandler::on_drag_enter` 发的 `DragDropEvent::Enter` **position 恒为 `(0,0)`**。
这是刻意的：CEF 的 `CanDragEnter` 回调本身不带落点坐标，要拿真实位置就得把 Enter 推迟到
第一个 `PreHandleDragUpdate`，那样 Enter 与 wry 的语义就对不上了。所以选择「Enter 立即发、
坐标留空」。

后果是 `enter` 阶段拿 `(0,0)` 去 hit-test 会命中左上角那个热区，浮层闪在错的地方。
因此 `enter` 只做两件事：**全量类型探测**（一次 `get_file_drop_kinds`，结果缓存到会话）
和 **`setFocus()` 一次**。浮层推迟到第一个 `over`。Chromium 在拖入后必然至少发一次
drag update，实测延迟在毫秒级，观感上没有区别。

（`setFocus` 只在 enter 调一次是有意的：改造前每个 `over` 都 await 一次，
拖动时每帧一发，是个 IPC 洪水点。）

## 坐标契约

Tauri 的 `DragDropEvent` 沿用 wry 语义，`position` 是**物理像素**：

```
Rust 侧   physical = client_pt(DIP) × display_get_primary().device_scale_factor()
前端      css      = physical / window.devicePixelRatio
```

主显示器上两者相消，命中准确。**多显示器且缩放比不同时会偏** —— Rust 侧取的是主显示器的
scale factor，而 webview 所在窗口可能在副屏。`useFileDrop.resolveZone` 为此留了一层兜底：
按 CSS 坐标全 miss 时，再用原始物理值重试一次命中。

命中规则是**按 z 序**：先 `document.elementsFromPoint(x, y)` 取落点最上层的元素，再沿 `parentElement`
往上找最近的已注册热区；找不到就判为不支持。这样 teleport 到 `body` 的收集弹窗会自然挡住底下画廊的
热区（此前用 `rect` 包含 + DOM 深度判定，弹窗开着时拖到弹窗上会导入画廊）。`pointer-events: none`
的浮层本来就不参与命中；`v-loading` 遮罩挂在热区内部，父链仍然能找到该热区。
`rect` 宽高为 0 的（被 `v-if`/`display:none` 卸掉）会被跳过。

## 接受矩阵

| 页面 | 热区元素 | 图片/视频 | 文件夹 | `.kgpg` |
|---|---|---|---|---|
| `Gallery.vue` | `.gallery-grid-pane` | `local-import` 导入画廊（无 `outputAlbumId`） | `local-import` 递归展开后扁平导入画廊 | ✗ |
| `Albums.vue`（普通画册 / 标签叶子） | 根 `.albums-page` | `local-import` 导入选中画册（标签叶子即给导入的图片打上该标签） | `local-import` 递归展开后扁平导入选中画册 | ✗ |
| `Albums.vue`（标签目录） | — | ✗ | ✗ | ✗ |
| `Albums.vue`（local_folder） | 根 `.albums-page` | 复制进 `sync_folder` 后导入选中画册 | 递归展开、扁平复制进 `sync_folder` 后导入选中画册 | ✗ |
| `Albums.vue`（收藏 / 隐藏 / 无选中） | — | ✗ | ✗ | ✗ |
| `PluginBrowser.vue` | 根 `.plugin-browser-container` | ✗ | ✗ | 安装插件 |
| `KbPath.vue`（插件路径变量） | 根 `.var-path` | 单个文件（扩展名须匹配 `options`）写回变量 | 单个文件夹写回变量（`file` 类型拒绝） | ✗ |
| `TaskDetail.vue` / `SurfImages.vue` | **不挂热区** | ✗ | ✗ | ✗ |

「拒绝」不是特判分支，而是同一个机制的取值：`plan()` 返回 `null`，或者干脆不挂组件。
未命中任何热区时 `drop` 提示 `import.dropUnsupportedHere`。

几个位置选择的理由：

- **画廊挂 `.gallery-grid-pane` 而不是整页**：正好包住网格、排除同级 pane，
  虚线框贴着网格画，视觉上就是「拖到网格里」。
- **`KbPath` 只收 1 项**：路径变量是单值，多项一律判为不支持；`file_or_folder` / `path`
  收到拖入项后会把分段控件的 `pickMode` 切到对应模式。

### 拒绝逻辑写进 `plan()`（`disabled` 也可以）

注册表持有响应式 props，所以 `disabled` 读过时值的问题已经消失，两种写法都能拿到最新状态：
按页面状态整体关闭写 `:disabled`，需要区分「接什么」时写在 `plan()` 开头并返回 `null`。
`Albums.vue` 在收藏、隐藏、标签目录或无选中画册时就是 `plan()` 返回 `null`；`local_folder` 不拒绝拖入。

## 导入行为复用的既有 API

本机制**没有新增任何 Rust 命令**：

| 行为 | 调用 |
|---|---|
| 画廊拖入 | `addTask("local-import", undefined, { paths, recursive: true })` |
| 普通画册拖入 | `addTask("local-import", undefined, { paths, recursive: true }, album.id)` |
| 文件夹画册拖入 | `addTask("local-import", album.syncFolder, { paths, recursive: true, copy_to_dir: true }, album.id)` |
| 插件包 | `invoke("import_plugin_from_zip", { zipPath })` |

`apps/kabegame/src/utils/dragFileImport.ts` 的 `buildDropPlan` / `importDroppedFiles` 是三个目标
形态的共用入口。文件与文件夹总是合并成一个任务，`recursive: true` 让文件夹递归展开，但
local-import 的结果保持扁平，不再为拖入目录创建同步画册或子画册。

文件夹画册额外把任务级 `outputDir` 设为 `sync_folder`，并传 `copy_to_dir: true`。local-import
先把源文件扁平复制进同步目录，再立即入库并挂到目标画册；后续监听或全量同步按路径命中已有行，
不会重复导入。已位于 `sync_folder` 直接下级的拖入项会跳过，避免生成 `a (1).png`。

## 应用内部拖拽静默

`ImageContent.vue` 的原生 `dragstart` 会调用 `beginInternalDrag()`；`dragExport.ts` 保持模块级标记，
并在捕获阶段的一次性 `dragend` 上清除。`useFileDrop.ts` 在 Tauri `enter` 到达时把该标记快照到
`sessionInternal`：内部会话不做类型探测、不抢焦点、不显示浮层，也不调用热区的 `plan()` /
`onDrop()`，落在非热区同样不会提示 `import.dropUnsupportedHere`。

必须在 `enter` 快照，不能只在 `drop` 读取实时值：浏览器的 `dragend` 可能先于 Tauri `drop`
到达，实时标记届时已经清除。拖出窗口后再拖回来会产生新的 `enter`，而未结束的拖拽标记仍在，
所以仍能被静默识别。

## 浮层样式的两个坑

`FileDropOverlay.vue`（非 scoped 全局样式）：

- **虚线框是独立一层 `.drop-frame`（`position: absolute; inset: 6px`）**，不是浮层自身的
  `border`。这样边框自然内缩一圈，也不受 `box-sizing` 影响 —— 浮层的 `width/height` 直接
  取自热区 rect，若边框画在自己身上且是 content-box，会比热区大出 4px。
  框内的淡色蒙层也铺在这一层上，框外 6px 保持完全通透。
- **`.drop-icon` 不能用 `background-clip: text` 做渐变色**。图标是 `<el-icon>` 里的 SVG，
  文字裁剪对它无效，结果是渲染成继承来的黑色。改造前的旧样式就有这个 bug（一直没人发现，
  因为它藏在渐变文字旁边）。直接给 `color: var(--anime-primary)`，SVG 的 `currentColor` 会跟着走。

浮层是 `pointer-events: none`，不吃鼠标事件也不可点击关闭 —— 松手即导入，没有可关的东西。

## 排障

| 症状 | 检查 |
|---|---|
| 拖进去完全没反应，连提示都没有 | 该页面挂热区了吗（`grep -rn "DragFileZone" apps/kabegame/src/`）；`IS_WEB`/`IS_ANDROID` 是否为真 |
| 外部文件松手只提示「此处不支持拖入这些文件」 | 命中失败或 `plan()` 返回了 `null`。在 `plan()` 里打点看 `items` 的分类标志 |
| 从应用网格拖出时出现导入浮层或“不支持”提示 | 检查 `ImageContent.onDragStart` 是否调用 `beginInternalDrag()`，以及 `enter` 是否快照到 `sessionInternal` |
| 虚线框位置偏移 / 落在错的区域 | 多显示器缩放不一致，见上面的坐标契约；确认 `window.devicePixelRatio` 与 Rust 侧取的主显示器 scale factor 是否一致 |
| 虚线框比区域大一圈 | 有人把 `border` 挪回 `.file-drop-overlay` 自身了，且 `box-sizing` 不是 border-box |
| 图标是黑色的 | `.drop-icon` 被改回 `background-clip: text` 了 |
| 拖入文件夹却创建了同步画册 | 页面仍保留旧的“拖目录建同步画册”分支；所有媒体/文件夹应统一走 `importDroppedFiles` |
| 弹窗开着时拖到弹窗上却导入了画廊 | 命中没有走 z 序（`elementsFromPoint` + 父链），或弹窗内容被 `pointer-events: none` 掉了 |

## 涉及文件

- `apps/kabegame/src/components/common/DragFileZone.vue` —— 注册热区的组件（挂载登记 / 卸载注销）
- `apps/kabegame/src/utils/dragFileZones.ts` —— 类型 + 模块级注册表 + `hitTestDragZone`（z 序命中）
- `apps/kabegame/src/composables/useFileDrop.ts` —— 窗口级监听 / 路由层
- `apps/kabegame/src/utils/dragFileImport.ts` —— 共用拖入计划 / local-import 参数
- `apps/kabegame/src/components/FileDropOverlay.vue` —— 浮层
- `apps/kabegame/src/views/{Gallery,Albums,PluginBrowser}.vue` —— 三个页面级热区
- `apps/kabegame/src/components/common/form/KbPath.vue` —— 插件路径变量热区（单文件 / 单文件夹）
- `apps/kabegame/src/utils/dragExport.ts`、`components/image/ImageContent.vue` —— 内部拖拽标记
- `src-tauri/kabegame/src/commands/misc.rs` —— `get_file_drop_kinds`
- `src-tauri/tauri-runtime-kbcef/src/webview.rs` —— `TauriCefDragHandler`
- `third-patches/cef/02-drag-drop-client-events.patch` —— CEF 侧的 over/leave/drop 回调
