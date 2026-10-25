# Wallpaper Engine（WPE）壁纸导入

## 一、模型：一个壁纸是目录，不是文件

Wallpaper Engine 的每个壁纸是**一个目录**：

```
<壁纸目录>/
  project.json      # type / file / preview / title / tags / general.properties
  Wallpaper-1.mp4   # 入口（video 型的 file）
  preview.gif       # 作者提供的预览图（jpg / png / svg / gif）
  ...               # 其它资源（web / scene 阶段会用到）
```

Kabegame 把整个目录作为一行 `images`：

| 列 | 值 |
|---|---|
| `local_path` | 壁纸目录的绝对路径（规范化、无 `\\?\`、无尾斜杠） |
| `type` | `x-wpe/video`（第一阶段）；`x-wpe/web` / `x-wpe/scene` 只是占位 |
| `thumbnail_path` | `<目录>/<preview>`，直接引用 WPE 自带预览图，不生成缩略图 |
| `compatible_path` | **始终有值**：浏览器能播时就是入口视频本身（`<目录>/<file>` 绝对路径）；解不了的编码在 `compatibles_dir` 生成 H.264 MP4，生成失败也回落到入口视频 |
| `hash` / `size` / `width` / `height` | 入口文件的哈希、大小、探测尺寸 |
| `post_url` | 有 workshop id 时是创意工坊页面地址 |
| `metadata` | `project.json` 原文（`plugin_id = wpe-import`），供详情展示 |

**不复制、不转码、不写用户目录**。`local_path` 的唯一约束天然保证同一壁纸只入库一次；
取消订阅、壁纸更新只影响磁盘上那一个目录，Kabegame 不持有副本。从图库删除只删记录，
`x-wpe/*` 行的 `local_path` 永远不进源文件回收（`batch_delete_images` 按 type 分流）。

`type` 以 `x-wpe/` 开头即表示「目录型壁纸」。凡把 `local_path` 当文件用的地方都必须按类型
分流，不能按扩展名猜：

- `/file/{*path}` 对 `x-wpe/*` 行返回 404；
- 视频播放（预览大图、应用背景、壁纸窗口）一律走 `compatible_path` → `/compatible/{*path}`，不走 `/wpe`；
- 媒体服务给目录内文件提供 `/wpe/<imageId>/<rel>`（见下），留给 Web / Scene 阶段的相对资源；
- 缩略图删除只删 `thumbnails_dir` 内、由 Kabegame 生成的文件（否则会删掉作者的 `preview.gif`）；
- 整理流程对 `x-wpe/*` 跳过缩略图重建、兼容副本、哈希去重与「无法识别媒体」清理；
- 虚拟盘第一阶段隐藏 `x-wpe/*` 行（`vd_image_entry_from_row` 过滤，计数口径同源）；
- 原生壁纸 / Plasma 插件模式拒绝 `x-wpe/*`，轮播只允许窗口模式；
- 拖出、复制、分享、删除源文件在 WPE 行上禁用；「在文件夹中显示」打开壁纸目录本身。

## 二、格式键

格式表的唯一事实来源仍是 `kabegame_core::media::image_type::MEDIA_FORMATS`：

```rust
MediaFormat { key: "x-wpe/video", mime: "application/x-wpe-project", extensions: &[], .. }
MediaFormat { key: "x-wpe/web",   .. } // 占位
MediaFormat { key: "x-wpe/scene", .. } // 占位
```

- `extensions` 为空：目录型条目不能按扩展名摄入，只能经 `project.json` 入库；
  `get_supported_image_types` 与 `mime_by_ext` 不包含它们。
- `mime` 只是占位，目录型条目永远不经 `mime_from_format` 出边界；媒体服务按入口文件扩展名定 MIME。
- 辅助函数：`is_wpe_type`、`wpe_kind`、`is_wpe_video_type`、`is_video_like_type`
  （后端唯一的「视频形态」判定；不要再用 `is_video_by_path` 判断目录）。

## 三、发现与识别

`kabegame_core::wpe`：

- `discover.rs`：Windows 读 `HKCU\Software\Valve\Steam\SteamPath`，再解析
  `<Steam>/steamapps/libraryfolders.vdf`；Linux 依次尝试 `~/.steam/steam`、
  `~/.steam/root`、`~/.local/share/Steam`。只在含 app `431960` 的库里产出三类根：
  - 创意工坊：`<库>/steamapps/workshop/content/431960`
  - 官方默认：`<库>/steamapps/common/wallpaper_engine/projects/defaultprojects`
  - 我的项目：`<库>/steamapps/common/wallpaper_engine/projects/myprojects`
  macOS / Android / Web 不适用，返回空。VDF 用最小手写解析器（兼容新旧两种 `libraryfolders`
  格式），不引新依赖。
- `recognize.rs`：把用户随手选的文件夹展开成壁纸目录集合。支持单个壁纸目录、`431960`
  创意工坊根、`projects/`、`defaultprojects` / `myprojects`、WPE 安装目录、Steam 库根与
  `steamapps/`；其它目录向下最多两层找 `project.json`。
- `project.rs`：解析 `project.json`。`type` 归一为 `Video / Web / Scene / Application / Other`；
  `file` / `preview` 必须是目录内相对路径（拒绝绝对路径与 `..`）；`preview` 缺失或越界归为
  `None`；`workshopid` 缺失时用 `431960/<纯数字目录名>` 回退，便于拼创意工坊链接。
  跳过原因 `WpeSkip::{NoProject, Unsupported, MissingEntry, Invalid}` 计入任务日志与统计。
- `properties.rs`：把 `general.properties` 的作者默认值换算成 `WpeVideoProps`，
  不读 WPE 的 `config.json` / `wproperties`（用户改过的值不带入）。

## 四、收集入口与内建任务

「开始收集」菜单新增第四项 **壁纸**（桌面端；Web / Android 隐藏）。对话框 `WallpaperImportDialog`
打开即调 `wpe_scan`，按三类来源显示「共 N 个，可导入 M 个（视频），已导入 K 个」，默认全选；
「添加文件夹」经 `wpe_recognize_dir` 识别后追加。确认后提交内建任务 `wpe-import`
（与 `local-import` / `webpage` 同形），复用任务列表、进度、取消、空跑与日志。

任务变量：

- `sources`：checkbox，`workshop` / `defaultprojects` / `myprojects`，默认全选；
- `extraDirs`：`list`，对话框识别出的目录；未选时省略（空数组会被变量校验拒绝）。

`crawler/wpe_import.rs` 逐目录读 `project.json`：只导入 `Video`，其它类型计入「跳过」并写日志；
`local_path` 已存在时幂等，只补目标画册成员；`tags` 挂到 `WPE/<tag>` 标签画册
（`validate_labels` 校验，非法 tag 逐条写警告）。

## 五、目录服务 `/wpe/<imageId>/<rel>`

只挂在本地媒体路由（`file_routes` / `file_routes_media`），Web 发布版不挂：

- 授权只认 `type` 为 `x-wpe/*` 且 `local_path` 是目录的行，否则 404；
- `/wpe/<id>/` 读 `project.json` 的 `file`，302 到 `/wpe/<id>/<file>`（前端不需要知道入口名）；
- `/wpe/<id>/<rel>`：`local_path.join(rel)` canonicalize 后必须仍位于该壁纸目录内、且是普通文件；
  MIME 按扩展名，复用 `serve_file_with_mime`（Range / 缓存头与现有媒体一致）。

**Video 阶段不用它播放**：CEF 的 `<video>` 跟随 `/wpe/<id>/` 的 307 后报 `MEDIA_ELEMENT_ERROR: Format error`
（直接请求入口文件可正常播放，2026-10-25 真机 4K H.264 实测），所以视频统一走 `compatible_path`，
`/compatible` 按库里的 `compatible_path` 授权、直出文件、无跳转。Web / Scene 阶段复用本服务，
相对 js/css/资源自然落在同一前缀下（入口页需另行验证跳转在 iframe / 文档加载下的表现）。

早期导入的行 `compatible_path` 可能为空；对同一来源重跑导入任务时，已入库行会补齐该字段并发
`compatiblePath` 字段补丁（dry-run 不写）。兼容文件删除护栏只删 `compatibles_dir` 内的文件，
指向用户目录的入口视频永远不会被删除或在整理时重建。

## 六、壁纸窗口

壁纸窗口与主窗口加载同一个 `index.html`，URL 为 `index.html?window=wallpaper`（`wallpaper/manager/window.rs`）。
`main.ts` 只做分发：按 `windowKind.ts` 的 `WINDOW_KIND` 动态导入 `bootstrap/app.ts`（主界面，原 `main.ts` 全部内容）
或 `bootstrap/wallpaper.ts`（只装 pinia、i18n、UnoCSS 与主题变量，不装 router / 组件库 / vant，不 `loadAll` 设置）。
Web 发布版与 Android 硬门控为主窗口。

- `views/WallpaperWindow.vue`：壁纸窗口根，负责看门狗（`sessionStorage.wallpaperInitRetry` + reload）、`setting-change`
  监听、启动时五个 getter 并行、`wallpaper_window_ready` 握手与 dev 调试面板，结果作为 props 交给渲染组件。
- `components/wallpaper/WallpaperStage.vue`：纯渲染组件（不 invoke / listen / 读 store），base / top 双层、
  prep → enter → commit 过渡（两帧 rAF、1400ms 兜底）、去重与严格串行、tile、base 图退避重试、视频 base / top 元素交换、
  音量 / 倍速 / 循环，以及下表的 WPE 作者属性；铺满父元素，额外支持 `paused` / `interactive`（供后续预览内嵌）。
  DOM 仍按原实现命令式操作（模板 ref 只在挂载时取一次），过渡组合类放在 scoped `<style>`。
- 后端组装目标的逻辑在 `commands/wallpaper.rs` 的 `build_wallpaper_target(info)`，`get_current_wallpaper_target` 复用它。

`get_current_wallpaper_target` 返回 `{ id, path, type, compatiblePath, wpeVideo }`：

- 普通图片 / 视频：保持原行为（按扩展名或 type 播图 / 播视频）；
- `x-wpe/video`：播放 `compatible_path`（入口视频本身或兼容副本），为空时不播放；
  作者默认值经 `wpeVideo` 给前端，Kabegame 的样式 / 音量 / 倍速覆盖对应字段：

| 字段 | 来源 |
|---|---|
| 对齐 | Kabegame 壁纸样式：`fill`→cover、`fit`→contain、`stretch`→fill、`center`→none、`tile`→cover |
| 位置 `position` | 作者 `alignmentposition` × 0.01（cover / contain 时作用于溢出轴） |
| 偏移 / 缩放 | 作者 `alignmentx` / `alignmenty` / `alignmentz`（center / free 时作用于 stage） |
| 翻转 / 背景 / 颜色 | 作者 `alignmentfliph` / `schemecolor` / `wec_*` |
| 速率 / 音量 | Kabegame 全局设置（覆盖作者值） |

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

**待真机校准**：`fill`（WPE）→ `contain` 的几何、`wec_*` 的 −1…1 与 CSS filter 量纲。

## 七、已知边界

- 第一阶段只导入 `video`；`web` / `scene` / `application` 只占位并计入跳过。
- `wcc_v` 图像滤镜预设（WPE 浏览属性）未实现，忽略。
- 创意工坊取消订阅后目录消失：行仍在，`local_exists` 为 false，图库标记缺失。
- 虚拟盘、原生壁纸、Plasma 插件模式均看不到 WPE 行（第一阶段）。
- Web 发布版不提供壁纸入口，也不挂 `/wpe` 路由。

## 八、涉及文件

- `src-tauri/kabegame-core/src/wpe/`（discover / recognize / project / properties / scan）
- `src-tauri/kabegame-core/src/crawler/wpe_import.rs`、`plugin/builtin.rs`、`task_scheduler/mod.rs`
- `src-tauri/kabegame-core/src/media/image_type.rs`、`storage/images.rs`、`storage/organize.rs`
- `src-tauri/kabegame/src/http_server.rs`、`commands/wallpaper.rs`、`wallpaper/rotator.rs`
- `apps/kabegame/src/components/WallpaperImportDialog.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、`components/wallpaper/{WallpaperStage.vue,types.ts}`
