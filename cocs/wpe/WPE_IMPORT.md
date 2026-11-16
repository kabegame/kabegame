# Wallpaper Engine（WPE）壁纸导入

## 一、模型：一个壁纸是目录，不是文件

Wallpaper Engine 的每个壁纸是**一个目录**：

```
<壁纸目录>/
  project.json      # type / file / preview / title / tags / general.properties
  Wallpaper-1.mp4   # 入口（video 型的 file；web 型是 index.html 之类的入口页）
  preview.gif       # 作者提供的预览图（jpg / png / svg / gif）
  ...               # 其它资源（web 页面的 js / css / 图片等，scene 阶段会用到更多）
```

Kabegame 把整个目录作为一行 `images`：

| 列 | 值 |
|---|---|
| `local_path` | 壁纸目录的绝对路径（规范化、无 `\\?\`、无尾斜杠） |
| `type` | `x-wpe/video` / `x-wpe/web` / `x-wpe/scene` 都已入库；场景壁纸由 `WpeWallpaperContent` 挂的场景宿主实时渲染，渲染器还不支持的场景显示作者预览图（见 [WPE_SCENE.md](WPE_SCENE.md)） |
| `thumbnail_path` | `<目录>/<preview>`，直接引用 WPE 自带预览图，不生成缩略图 |
| `compatible_path` | 视频行**始终有值**：浏览器能播时就是入口视频本身（`<目录>/<file>` 绝对路径）；解不了的编码在 `compatibles_dir` 生成 H.264 MP4，生成失败也回落到入口视频。**网页行为空**（没有可播放媒体，页面以入口的 `file://` 加载，见第六节） |
| `hash` / `size` | **目录哈希**与目录内全部文件的总字节数（`wpe::dir_hash`，见第四节「目录哈希」）；v051 之前入库的行取的是入口文件，由回填作业 `wpe_dir_hash` 重算 |
| `width` / `height` | 视频行带探测尺寸，场景行是场景分辨率（`WpeProject::scene_resolution`，透视场景为空），网页行为空 |
| `post_url` | 有 workshop id 时是创意工坊页面地址 |
| `metadata` | `project.json` 原文（`plugin_id = wpe-import`），供详情展示 |

**WPE 行的身份由宿主定**：不论从哪个入口进来（收集入口、本地导入、文件夹同步、插件下载），`plugin_id` 恒为
`wpe-import`、metadata 恒为 `project.json` 原文。属性面板与垫片直接读 metadata 顶层字段，详情模板按
`image.pluginId` 选，换成下载插件自己的 metadata 会全部失效；所以下载时调用方传入的 `metadata_id` 被忽略，
去重命中时的 metadata 重绑定（`rebind_deduped_metadata`）也对 WPE 行直接跳过。

**原地入库不复制、不转码、不写用户目录**。`local_path` 的唯一约束保证同一个目录只入库一次；
取消订阅、壁纸更新只影响磁盘上那一个目录，Kabegame 不持有副本。只有**下载产物**（插件下到任务 VFS 里的
目录）会被移动到下载目录，或在去重命中时删除。从图库删除只删记录，`x-wpe/*` 行的 `local_path` 永远不进
源文件回收（`batch_delete_images` 按 type 分流）——移进下载目录的壁纸目录同样不随删记录删除。

`type` 以 `x-wpe/` 开头即表示「目录型壁纸」。凡把 `local_path` 当文件用的地方都必须按类型
分流，不能按扩展名猜：

- `/file/{*path}`（桌面应用 Web 服务器）对 `x-wpe/*` 行返回目录的**文件清单**，对目录内的文件返回文件内容
  （见第四节「经 Web 服务器传输」）；非 `wpe` 构建仍是 404；
- 视频播放（预览大图、应用背景、壁纸窗口）一律走 `compatible_path` → `/compatible/{*path}`；
- 网页壁纸以入口的 `file://` 直接加载（预览与桌面都是 `WpeWallpaperContent` 里的 `file:` iframe，见第五、六节），
  页面能读的文件边界是运行时按网页壁纸目录索引做的 `file:` 请求拦截；没有 HTTP 目录服务；
- 缩略图删除只删 `thumbnails_dir` 内、由 Kabegame 生成的文件（否则会删掉作者的 `preview.gif`）；
- 整理流程对 `x-wpe/*` 跳过缩略图重建、兼容副本、哈希去重与「无法识别媒体」清理；
- 虚拟盘第一阶段隐藏 `x-wpe/*` 行（`vd_image_entry_from_row` 过滤，计数口径同源）；
- 原生壁纸 / Plasma 插件模式拒绝 `x-wpe/*`，轮播只允许窗口模式；
- 图库「类型」过滤把 `x-wpe/*` 单独成一类（`media-type/x-wpe[/video|web|scene]`），不再并入图片；图片详情的「Wallpaper Engine · 类型」两段都是筛选链接；
- 拖出、复制、分享、删除源文件在 WPE 行上禁用；「在文件夹中显示」打开壁纸目录本身。

## 二、格式键

格式表的唯一事实来源仍是 `kabegame_core::media::image_type::MEDIA_FORMATS`：

```rust
MediaFormat { key: "x-wpe/video", mime: "application/x-wpe-project", extensions: &[], .. }
MediaFormat { key: "x-wpe/web",   .. } // 已入库（第二阶段 Phase 3）
MediaFormat { key: "x-wpe/scene", .. } // 占位
```

- `extensions` 为空：目录型条目不能按扩展名摄入，只能经 `project.json` 入库；
  `get_supported_image_types` 与 `mime_by_ext` 不包含它们。
- `mime` 只是占位，目录型条目永远不经 `mime_from_format` 出边界；媒体服务按入口文件扩展名定 MIME。
- 辅助函数：`is_wpe_type`、`wpe_kind`、`is_wpe_video_type`、`is_video_like_type`
  （后端唯一的「视频形态」判定；不要再用 `is_video_by_path` 判断目录）。

## 三、发现与识别

**WPE 由 cargo feature `wpe` 控制**：`kabegame-core` 的 `wpe`，`kabegame` 的 `wpe`（`standard` 依赖它，同时带上
`realfft`、`rustfft` 与 `windows` 的音频 / WinRT feature），`kabegame-cli` 的依赖声明。三个桌面平台开启，Android / Web 不开。

| 随 `wpe` 编译 | 所有构建都编译 |
| --- | --- |
| core：`wpe::{discover, scan, recognize, locale}`、`commands::wpe`、`crawler::wpe_import`、内建插件 `wpe-import` | core：`wpe::{project, properties, user_props}`、`image_type` 的 `x-wpe/*` 判断（`Storage` 与 Android 的壁纸目标要用） |
| app：`commands::{wpe, wpe_scene, wpe_web}`、`wpe_media`、`wallpaper::{wpe_web_dir_index, wpe_scene_host}` | app：`wallpaper::web_entry`（关闭时恒为 `None`）、`commands/wallpaper.rs` 的壁纸目标 |

「壁纸」对话框没有勾选自动来源时传 `sources: null`：通用 checkbox 校验不接受全 false，缺失又会合并默认的全选，显式 `null` 才表示只导入手选文件夹（`parse_sources`）。

CLI 开启 `wpe` 后能解析 `wpe-import`，但本地模式的 `plugin run` 只支持 V8 后端，这个内建任务要经运行中的主程序执行（`--via app`）。

关闭时 `wpe-import` 不在内建表里，`start_task` 与定时运行配置都解析不到它，Web RPC 不需要另外拦截；`x-wpe/*` 行在网格与
应用背景里只显示作者预览图。`apps/wpe-scene` 也只属于桌面 standard 模式，Android / Web 不构建、不同步 wasm、不跑它的 Vitest。

三个桌面平台的能力不同：

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 导入、图库预览、应用背景 | 有 | 有 | 有 |
| 桌面壁纸（窗口模式） | 有 | 有 | 没有窗口模式，设为壁纸直接报错 |
| 桌面壁纸的鼠标 | 有 | 有（第二版未实测） | 无 |
| 图库预览的鼠标：光标在画面外、应用外也跟随 | 有 | 有（未实测） | 无：iframe 直接收真实鼠标，只在 iframe 上 |
| 音频与媒体数据 | 有 | 无 | 无 |

`kabegame_core::wpe`：

- `discover.rs`：Windows 读 `HKCU\Software\Valve\Steam\SteamPath`，Linux 查 `~/.steam/steam`、`~/.steam/root`、
  `~/.local/share/Steam`，macOS 查 `~/Library/Application Support/Steam`，再解析
  `<Steam>/steamapps/libraryfolders.vdf`。只在含 app `431960` 的库里产出三类根：
  - 创意工坊：`<库>/steamapps/workshop/content/431960`
  - 官方默认：`<库>/steamapps/common/wallpaper_engine/projects/defaultprojects`
  - 我的项目：`<库>/steamapps/common/wallpaper_engine/projects/myprojects`
  VDF 用最小手写解析器（兼容新旧两种 `libraryfolders` 格式），不引新依赖。
- `recognize.rs`：把目录展开成壁纸目录集合。手选文件夹与自动发现的根走同一条规则：只看目录自身、`<dir>/*`、`<dir>/*/*`，
  含 `project.json` 就收下且不再深入，到第二层仍没有就停。不按目录名或结构猜类型，所以手选 Steam 库根、WPE 安装根识别不到
  （壁纸在第 3 层以下），这两类由自动发现覆盖；`431960`、`projects/`、`defaultprojects` / `myprojects` 都在两层内。
- `is_safe_relative_path`（`wpe/mod.rs`）：`file` / `preview` 的第一道门，规则不随平台变：`\\` 一律按分隔符看，盘符单独拒绝。Unix 的 `Path` 把 `C:\\x` 和 `..\\x` 都当成一个普通文件名，只靠 `Path` 判断会放行。
- `project.rs`：解析 `project.json`。`type` 归一为 `Video / Web / Scene / Application / Other`，
  `WpeKind::is_supported()`（video、web 与 scene）是「可导入」口径的唯一来源，已支持的类型都要求入口文件存在；
  场景例外：目录里有 `scene.pkg`（创意工坊发布形态）就算入口存在，这一步不读包。没有 `type` 但 `file` 是 `.json` 的
  （默认项目 audiophile、techno）按场景处理；
  `file` / `preview` 必须是目录内相对路径（拒绝绝对路径与 `..`）；`preview` 缺失或越界归为
  `None`；`workshopid` 缺失时用 `431960/<纯数字目录名>` 回退，便于拼创意工坊链接。
  跳过原因 `WpeSkip::{NoProject, Unsupported, MissingEntry, Invalid}` 计入任务日志与统计。
- `properties.rs`：把 `general.properties` 的作者默认值换算成 `WpeVideoProps`，
  不读 WPE 的 `config.json` / `wproperties`（用户改过的值不带入）。

## 四、收集入口与内建任务

入口是「开始收集 → 本地」对话框顶部的 **WPE 壁纸** 来源（桌面端；Web / Android 隐藏；macOS / Linux 入口仍在，但 `platform_supported` 为 false，
自动发现为空，只剩「添加文件夹」；从 Steam 拉取在「网络 → Steam」，见 [WPE_STEAM.md](WPE_STEAM.md)）。面板 `collect/WpeLocalPanel`
打开即调 `wpe_scan`，按三类来源显示「N 个壁纸 / M 个可导入 / 视频 v · 网页 w / K 个已导入」
（可导入 = 已支持类型且未入库；类型分布为 0 的项省略），默认勾选有待导入项的来源；
「添加文件夹」经 `wpe_recognize_dir` 识别后追加。确认后提交内建任务 `wpe-import`
（与 `local-import` / `webpage` 同形），复用任务列表、进度、取消、空跑与日志。

任务变量：

- `sources`：checkbox，`workshop` / `defaultprojects` / `myprojects`，默认全选；
- `extraDirs`：`list`，对话框识别出的目录；未选时省略（空数组会被变量校验拒绝）。

`crawler/wpe_import.rs` 的 `run_builtin_wpe_import` 逐目录读 `project.json`：受支持的类型调
`postprocess_downloaded_image(PostprocessSource::Path { path: 目录, relocate_to: None }, ..)`，由后处理的目录分支
入库（见下「入库：四个入口共用 `ingest_wpe_dir`」）；其它类型计入「跳过」并写日志。返回 `Ok(true)` 记新增、
`Ok(false)` 记已存在、`Err` 记跳过；任务的成功 / 去重 / 失败计数与失败记录由后处理统一处理，与下载任务同口径。
`local_path` 已存在时幂等，只补目标画册成员（视频另补缺失的 `compatible_path`），不补标签。

### 入库：四个入口共用 `ingest_wpe_dir`

`postprocess_downloaded_image` 的 `PostprocessSource::Path { path, relocate_to }` 里 `path` 是目录时，按 WPE 壁纸目录
处理（`postprocess_wpe_dir`，薄包装），实际入库只有一个函数 `crawler::wpe_import::ingest_wpe_dir(dir, WpeIngest)`：

| 入口 | 怎么进来 | `relocate_to` | `dedup_by_hash` |
|---|---|---|---|
| 收集入口「壁纸」（`wpe-import`） | 后处理目录分支 | `None`（原地） | 跟随「自动去重」 |
| 本地导入（`local-import`，含拖入） | 后处理目录分支 | `None`（原地；`copy_to_dir` 时先复制再对副本原地入库） | 跟随「自动去重」 |
| 插件下载（`downloadImage(目录, { relocate: true })`） | 下载 worker → 后处理目录分支 | `Some(下载目录)`，`delete_source = true` | 跟随「自动去重」 |
| 文件夹同步 | 直接调用（同步不经后处理） | `None` | 恒 `false`（磁盘上有几个目录就有几行） |

步骤：

1. `read_project` 成功且类型受支持，否则报错（不是壁纸目录、`application` 等），源不动。
2. 原地入库按 `local_path` 幂等：已有行 → 补画册成员（视频行补缺失的 `compatible_path`）→ `Existing`。
3. 算目录哈希（阻塞线程）。`dedup_by_hash` 且 `find_image_by_hash` 命中 → 补画册成员；`relocate_to` 为 `Some` 且
   `delete_source` 时删掉源目录（下载产物）→ `Existing`。原地入库命中时不删任何东西。
4. `relocate_to` 为 `Some`：`delete_source` 时 `move_dir_unique`，否则 `copy_dir_unique`，放到目标目录下以展示名
   （缺省取 `project.json` 标题）命名的目录，重名依次换 `名(1)`、`名(2)`；之后按新路径重读工程。
5. 按类型取宽高与 `compatible_path`（同原来的三份导入函数），metadata 写 `project.json` 原文，`hash` / `size` 写
   目录哈希与总字节数，尽力算色盘（见下「色盘来源」），`add_image` → `images-added` → 挂画册 → 挂 WPE 标签。
6. `add_image` 撞 `local_path` 唯一约束（另一个入口抢先写了同一个目录，例如复制进同步目录时文件夹同步先到）→
   回查路径按 `Existing` 处理。其它失败时删掉第 4 步搬过来的目录（与文件下载失败删新建文件一致）。

后处理包装在 `Imported` 时按父目录补挂文件夹画册（`link_into_folder_album`）并挂插件标签，`Existing` 时按
「去重时更新元数据」设置补挂标签并写任务日志（同一目录是 `taskLogWpeExisting`，内容相同的另一个目录是
`taskLogDedupByHash`）。

`move_dir_unique` / `copy_dir_unique`（`downloader/util.rs`）：先试 `rename`；改名不成（典型是跨文件系统）时先复制到
`<目标目录>/.kabegame-part-<uuid>`（`project.json` 最后复制，半成品不会被认成壁纸目录），再改名、删源。复制的文件
集合与目录哈希相同（不带符号链接与系统文件）。本地导入遇到 `.kabegame-part-*` 整棵跳过；它是隐藏目录，文件夹同步
不会为它建子画册。

### 色盘来源

WPE 行与普通图片一样在入库时算一份色盘（详情里的代表色、按颜色排序的依据，见
[COLOR_PALETTE.md](../gallery/COLOR_PALETTE.md)）。`insert_wpe_row` 在 `add_image` 之前调
`media::palette::compute_for_row(类型, 目录, 预览图, compatible_path, scheme_color_from_raw(&project.raw))`，
来源由 `source_for_row` 按类型决定——`local_path` 是目录，任何类型都不会把它当文件读：

| 类型 | 来源 |
|---|---|
| `x-wpe/video` | 从 `compatible_path`（入口视频或兼容副本）均匀抽 8 帧；解不了时退到预览图；没有 `compatible_path` 时直接用预览图 |
| `x-wpe/web`、`x-wpe/scene` | `project.json` 的 `general.properties.schemecolor.value`（`"r g b"`，0–1 浮点），得到「一个颜色 100%」的色盘；没有这个属性时用预览图（`preview.gif` 抽帧，`preview.jpg` 等取一帧）；连预览图也没有的没有色盘 |

- 取的是 `schemecolor` 的**作者值**，不跟用户在属性面板里改的值走（用户值在 metadata 顶层的 `userProperties`，
  `scheme_color_from_raw` 不读它）；用户之后改颜色、换封面都不会重算色盘。
- 没有色盘的壁纸在按颜色排序时排在最后，基本信息里不显示色带。
- 存量 WPE 行由回填作业 `image_palette` 按同一规则补算：它从 metadata 里的 `project.json` 原文取 `schemecolor`。
  `wpe::properties`（`scheme_color_from_raw`）不随 `wpe` feature 门控，各平台对同一行算出同一个色盘。

### 目录哈希

`wpe::dir_hash`（不受 `wpe` feature 门控）：`list_files` 迭代枚举目录下的普通文件，不跟随符号链接，相对路径统一用
`/` 分隔并按字节序排序，排除 `.DS_Store` / `Thumbs.db` / `desktop.ini`（访达、资源管理器会自己写）。`digest_dir` 以域前缀
`kabegame-wpe-dir-v1\0` 开头，逐个文件喂入「路径长度 u32 LE + 路径 + 文件长度 u64 LE + 该文件的 SHA-256」，输出小写 hex。
只对内容敏感：与创建顺序、时间戳、所在位置无关；域前缀保证不与散文件哈希相撞。服务端的文件清单、整目录复制与哈希
共用 `list_files`，三处看到的文件集合一致。

存量行的 `hash` / `size` 是入口文件的，由回填作业 `wpe_dir_hash`（v051 空迁移登记，见
[DB_MIGRATIONS_AND_BACKFILLS.md](../storage/DB_MIGRATIONS_AND_BACKFILLS.md)）在后台重算。**作业跑完之前存量行按目录哈希
查不到**，这段时间里下到本机已有的壁纸会多落一份。

### 本地导入与文件夹同步里的壁纸目录

- **本地导入**（`crawler/local_import.rs`，`wpe` feature + 非 Android）：进入子目录之前（`on_enter_dir`）、非递归或到达深度
  上限时的子目录（`on_subdir`）、以及任务的根目录，都先用 `is_importable_wpe_dir` 判断。是可入库的壁纸目录就整目录交给
  后处理、不再下钻；带无关 `project.json` 的目录照常递归。空跑照文件记一次 `taskLogDryRunSkipImport`。
- **文件夹同步**（`local_folder/sync.rs`、`fs_batch.rs`）：同步目录下的壁纸子目录按「文件」对待——挂到父目录的画册、
  不建子画册、目录内部变化忽略、整个目录消失即删行。细节与已知限制见
  [LOCAL_FOLDER_SYNC.md](../local-folder/LOCAL_FOLDER_SYNC.md)「WPE 壁纸子目录」。

### 经 Web 服务器传输

mac 上装不了 WPE，但可以把另一台机器（通常是 Windows）上的壁纸传过来：源机器开桌面应用 Web 服务器，
本机跑 `kabegame-server` 插件。

- **服务端**（`http_server.rs` 的 `handle_file_path`，`wpe` feature）：`/file/<WPE 行的目录>` 返回
  `{ "type": "x-wpe/scene", "files": [{ "path": "scene.pkg", "size": 123 }] }`（`list_files`，`Cache-Control: no-store`）；
  路径不是任何行、但某一级上级目录是 WPE 行时，请求路径规范化后（解开 `..` 与符号链接）仍在该目录内且是普通文件
  才返回文件内容，否则 404。无 `Range` 的整文件响应改为流式读盘（`Body::from_stream`，带 `Content-Length`），
  GB 级的 `scene.pkg` 不会整份进内存；图片、视频的响应头与内容不变。
- **客户端**：插件对 `x-wpe/*` 行先请求 `/file/<目录>` 取清单，再调 SDK 的 `downloadWpeWallpaper`：逐个文件
  `Kabegame.fetchToFile` 到任务 VFS 的 `tmp/wpe/<时间戳-随机>/`，最后
  `Kabegame.downloadImage(目录的 VFS 路径, { relocate: true })`。宿主把目录移到下载目录并入库，
  或在目录哈希命中已有行时删掉它。重跑同一批壁纸仍会先把整张传完再靠哈希判重，没有下载前预检。

### 标签

新增行挂 `WPE/<子目录>/<tag>` 标签（`wpe/tags.rs`，`validate_labels` 校验，非法 tag 逐条写警告）。作者声明的 `tags` 只是一部分：
「音频响应」「可自定义的」、年龄分级这些是 WPE 发布时打到 Steam 上的，`project.json` 里没有。

| 壁纸 | 标签来源 |
| --- | --- |
| 在 `<WPE 安装目录>/bin/workshopcache.json` 里（已订阅的工坊壁纸） | 作者的 `tags` + 缓存里的 Steam 标签，与 WPE 界面一致 |
| 其余（默认壁纸、我的项目、已退订的工坊目录） | 作者的 `tags` + 从 `project.json` 推导 |

有缓存就不推导：Steam 上的分级可以和本地 `contentrating` 不同（全库唯一的 `Questionable` 那张，`project.json` 写的是
`Everyone`），发布后才加的属性也不会让 `Customizable` 出现。缓存是 WPE 的内部文件，读不到或格式变了都走推导。

推导规则，已对照本机 141 张工坊壁纸的 Steam 标签：

| 标签 | 条件 | 对照 |
| --- | --- | --- |
| `Audio responsive` | `general.supportsaudioprocessing` 为 `true` | 65 / 65，无误判 |
| `Video Texture` | `general.supportsvideoflags & 1`；`supportsvideo` 不够，有 15 张为真但没有这个标签 | 35 / 35，无误判 |
| `Customizable` | `general.properties` 里有 `schemecolor` 以外的键 | 103 / 103，误判 1 张（发布后才加属性） |
| `User Shortcut` | 有 `type` 为 `usershortcut` 的属性 | 1 / 1 |
| `Everyone` / `Questionable` / `Mature` | `contentrating` | 与 Steam 不同 4 张 |

`Approved`（审核给的，`project.json` 的 `approved` 对不上）与 `HDR`、`3D`、`Puppet Warp`、`Media Integration`（要看场景内容，
Rust 不解析场景）推导不出来，只有缓存里才有。

分类（`Wallpaper`、`Preset`、`Asset`）、类型（`Scene`、`Video`、`Web`、`Application`）、来源（`Official`、`Workshop`、`Local`）
与分辨率标签不挂：前三种已由图片类型与导入来源表达，分辨率按需求不要。分辨率的判定照 WPE 自己的写法：含 ` x `，或以
` resolution`、`Standard Definition` 结尾。

子目录照 WPE 筛选面板的分组：

| 子目录 | 显示名（中文） | 标签 |
| --- | --- | --- |
| `genre` | 题材 | 作者声明的 `Anime`、`Game` 等；不认识的标签也归这里，作者只能从题材里选 |
| `rating` | 年龄分级 | `Everyone`、`Questionable`、`Mature` |
| `feature` | 特性 | `FEATURE_TAGS`：WPE 的工具标签，如 `Audio responsive`、`Customizable`、`Video Texture`、`Approved` |

**key 与名称**：标签 key 是 Steam 标签原文（`Audio responsive`），子目录 key 是上表的英文，都不随语言变，缓存与推导落到同一个标签，
写进库后不能再改写：归到另一个子目录就是另一个标签，旧标签留在原处。名称在建标签时取当前语言的 `wpe.tags.<key>` 与 `wpe.tagDirs.<目录>`
（`kabegame-i18n/locales/*.yml`，键同样是原文，不收录的标签名称用 key）；目录名经 `LabelSpec.dir_name` 传给 `ensure_label_path`。
不读 WPE 的 `ui_workshop_tags_*`：`Video Texture` 等标签 WPE 没有译文，没装 WPE 时也读不到，「限制级/成人级」带 `/` 不能作画册名。
名称遵循标签的通用规则「只在创建时使用」：切换语言或重新导入都不改已有标签的名称，要换语言的名称得删掉 `WPE` 标签目录后重新导入。

## 五、媒体与页面的访问路径（无 HTTP 目录服务）

- **视频**：统一走 `compatible_path`。Phase 6b 起桌面 CEF 直接以 `file://` 播放它（见第六节「图库媒体：`file://` 与按发起
  frame 分档的闸门」），Android 等仍经 `/compatible` 按库里的 `compatible_path` 授权、直出文件、无跳转。第一阶段曾有
  `/wpe/<id>/` 目录服务，CEF 的 `<video>` 跟随它的 307 后报 `MEDIA_ELEMENT_ERROR: Format error`（直接请求入口文件可正常
  播放，2026-10-25 真机 4K H.264 实测），所以视频从没用过它。
- **网页**：桌面壁纸窗口与图库预览都以 `WpeWallpaperContent` 里的 `file:` iframe 加载入口（第六节「网页壁纸 iframe」），
  页面相对资源自然落在壁纸目录里；文件边界是 `tauri-runtime-kbcef` 的 `file:` 闸门按网页壁纸目录索引裁决（文档只能访问它自己
  所在的壁纸目录与这张壁纸的用户选择，第六节「网页壁纸目录索引」），两个窗口同一份机制。MIME 由 Chromium 按扩展名判定；
  `file:` 不走 HTTP 缓存，壁纸目录里的文件原地变化（创意工坊更新、作者或用户手改）后重新加载即读到新内容。
- **`/wpe/<id>/<rel>` HTTP 目录服务已在第二阶段 Phase 6a 删除**（连同 `/wpe` 专属网页 MIME 表、HTML 产出点与 CSP
  `frame-src` 对 `http://127.0.0.1:*` 的放行）：Web 发布版不提供网页壁纸，应用 Web 服务器（MCP / 外部集成）也不需要把
  壁纸目录暴露出去，预览改走 `file:` 后它没有使用方。Android / Web 的媒体与插件文件 HTTP 路由照旧
  （Phase 6b 起桌面图库显示改走 `file://`，这三个媒体路由在桌面只剩下载 / 复制兜底等非显示用途；Windows 拖出自
  Phase 6d 起改走 CEF 补丁 03 的真实文件链路，不再用媒体 URL，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`）。
- 作者脚本常用 javascript-obfuscator 的 `selfDefending`：对函数 `toString()` 做正则比对，代码被格式化（换行 / 缩进）
  就故意进入死循环，页面 `load` 永不触发。任何改写作者 js 的逻辑（zcompat 替换）都不能改变被检测函数的原文；同一
  `file:` 源的页面可能共用一个渲染进程，一个卡死的页面会连带后续网页壁纸一起超时。

早期导入的行 `compatible_path` 可能为空；对同一来源重跑导入任务时，已入库行会补齐该字段并发
`compatiblePath` 字段补丁（dry-run 不写）。兼容文件删除护栏只删 `compatibles_dir` 内的文件，
指向用户目录的入口视频永远不会被删除或在整理时重建。

## 六、壁纸窗口

窗口模式下**每块在线屏一个壁纸窗口**（`wallpaper/manager/window.rs`）：label 取自固定的池 `wallpaper`、`wallpaper-1` …
`wallpaper-7`，各有各的就绪握手与 ping 看门狗（桌面鼠标由各窗口的 iframe 自己登记，见「鼠标」），后端给每个窗口一条布置
（显示哪个壁纸目标、出不出声）。
窗口集合如何随显示器模式与热插拔对齐见 [多显示器壁纸](../wallpaper/MULTI_SCREEN.md)「窗口模式：每屏一窗」；没有显示器枚举的
平台（Windows）仍只有 `wallpaper` 一个窗口、铺主屏。本文其余部分说「壁纸窗口」时，对池里每个窗口都成立。

壁纸窗口与主窗口加载同一个 `index.html`，URL 为 `index.html?window=wallpaper&slot=<label 在池里的序号>`（`slot` 页面不读，
只为让调试工具按 URL 分清窗口）。
`main.ts` 只做分发：按 `windowKind.ts` 的 `WINDOW_KIND` 动态导入 `bootstrap/app.ts`（主界面，原 `main.ts` 全部内容）
或 `bootstrap/wallpaper.ts`（只装 pinia、i18n、UnoCSS 与主题变量，不装 router 与主界面组件，不 `loadAll` 设置）。壁纸窗口也要导入
`styles/tokens.css`：桌面的 `ImageContent` 画加载进度、骨架与丢失图都用 `--kb-*` 与 `kb-*` 关键帧，缺了文字退回黑色、进度条与骨架
看不见（2026-11-16 修）；它只有 `:root` 变量与关键帧，不碰窗口背景。
Web 发布版与 Android 硬门控为主窗口。

- `views/WallpaperWindow.vue`：壁纸窗口根，负责 init 看门狗（`sessionStorage.wallpaperInitRetry` + reload）、挂载即监听并按 label 应答 `wallpaper-ping`、`setting-change`
  监听、启动时先取本窗口的布置（`get_wallpaper_window_assignment`，之后跟 `wallpaper-assignment`）再并行拉目标表 / 能力表 /
  音量 / 倍速 / 暂停 / 当前壁纸 / 语言、`wallpaper_window_ready` 握手与 dev 调试面板，结果作为 props 交给渲染组件；样式、过渡、
  当前壁纸取自布置的目标，布置不出声时音量传 0。语言（`get_language`，之后跟 `setting-change` 的 `language`）按主窗口的规则
  `resolveLanguage` 设给 i18n，桌面的加载进度与失败原因才跟应用语言（以前壁纸窗口一直是英语）。
- `components/wallpaper/Wallpaper.vue`（2026-11-15 取代 `WallpaperStage.vue`）：纯渲染组件（不 invoke / listen / 读 store），只管铺放与
  过渡：每个壁纸一层 `ImageContent`（壁纸变体），新层 `ready`（有东西可看）后按过渡进来、过渡结束（时长 + 600 ms 兜底）卸载旧层，
  加载中的层被新目标直接替换、过渡中的先定下来；样式换成 `fit`，tile 时图片画重复背景；媒体（图片 / 视频 / 网页 / 场景）、音量 /
  倍速 / 循环与下表的 WPE 作者属性都在 `ImageContent` 里（`wpeVideoStyle.ts`）。
- 后端组装目标的逻辑在 `commands/wallpaper.rs` 的 `build_wallpaper_target(info)`，`get_current_wallpaper_target`
  与 `get_wallpaper_target_for_image(imageId)`（图库预览 / 背景按 id 取）复用它，所以预览与桌面拿到同一份目标结构。
  WPE 视频的作者属性取自**图片 metadata**（导入时写入的 `project.json` 原文，`resolve_video_props_from_raw`），
  不重读磁盘——用户属性以后作为同一份元数据里的一段合并进来。

`get_current_wallpaper_target` 返回 `{ id, path, type, compatiblePath, wpeVideo, webEntry, sceneAssets, previewPath }`：

- 普通图片 / 视频：保持原行为（按扩展名或 type 播图 / 播视频）；
- `x-wpe/video`：播放 `compatible_path`（入口视频本身或兼容副本），为空时不播放；
  作者默认值经 `wpeVideo` 给前端，Kabegame 的样式 / 音量 / 倍速覆盖对应字段：

| 字段 | 来源 |
|---|---|
| 对齐 | Kabegame 壁纸样式：`fill`→cover、`fit`→contain、`stretch`→fill、`center`→none、`tile`→cover |
| 位置 `position` | 作者 `alignmentposition` × 0.01（cover / contain 时作用于溢出轴） |
| 偏移 / 缩放 | 作者 `alignmentx` / `alignmenty` / `alignmentz`（center 时整体位移；free 走不到，不做） |
| 翻转 / 背景 / 颜色 | 作者 `alignmentfliph` / `schemecolor` / `wec_*` |
| 速率 / 音量 | Kabegame 全局设置（覆盖作者值） |

作者属性落到画面上的规则在 `components/wallpaper/wpeVideoStyle.ts`（`wpeVideoPresentation`，壁纸显示重构步骤 4 从 Stage 搬出）：
`ImageContent` 用在自己的 `<video>` 上（翻转、位移、滤镜写在元素上，留边色写在根上），**桌面、图库预览、应用背景都生效**（2026-11-15
用户定；以前只有桌面）。桌面给后端算好的 `wpeVideo`（`wpeVideo` prop）；图库不给时 `ImageContent` 按图片 id 调
`get_wallpaper_target_for_image` 取（只在桌面端），取不到按普通视频放。

- `x-wpe/web`：`compatiblePath` 与 `wpeVideo` 为空，`webEntry` 是入口的 `file://`，由 `build_wallpaper_target` 用
  `wallpaper::web_entry` 现算（`read_project` 校验入口在目录内且存在，放 blocking 线程；Android、读不了 `project.json`
  时为 `null`）。图库预览与**桌面壁纸窗口**拿同一份目标，都由 `WpeWallpaperContent` 建一个 iframe、直接赋
  `src = webEntry`（见下「网页壁纸 iframe」）；`webEntry` 为空时报「无法加载网页壁纸」，预览退回作者预览图、桌面保持原画面。
- `x-wpe/scene`：`sceneAssets` 是 WPE 安装目录的 `assets`，`previewPath` 是退回用的作者预览图（行的 `thumbnail_path`，缩略图为空或
  回落成目录本身时不填），其它类型两者都为空。`WpeWallpaperContent` 挂 `WpeSceneView` 编译渲染；loading → live / failed 的
  状态流转、超时与过渡见 [WPE_SCENE.md](WPE_SCENE.md)「显示」。

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

### 网页壁纸 iframe

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，靠关掉同源策略读同目录文件。Kabegame 在
两个地方显示网页壁纸，**都是 `WpeWallpaperContent` 里的 `file:` iframe**，组件与代码路径同一套：图库预览在主窗口（`main`），
桌面在壁纸窗口（label 池里的任一个，每块屏一个；同一张网页壁纸显示在几块屏上就是几个独立的页面实例）。tauri 补丁 18 / 19 之前，子 frame 没有 IPC，预览 iframe 只能 `postMessage` 请主窗口代办、
桌面则把整个壁纸窗口导航到 `file://`；现在 frame 是 IPC 的基本单位，两种宿主合成一种（见 [ACL 文档](../tauri/TAURI_ACL_PERMISSION_SYSTEM.md)「子 frame IPC」）。

- **加载**：`WpeWallpaperContent` 建 iframe、插入 DOM 后直接 `frame.src = target.webEntry`，没有命令往返、没有要维护的状态
  （入口由 `build_wallpaper_target` 现算，见上）。壁纸窗口本身始终停在应用页，不再导航。
- **能力登记**：主窗口（`startup.rs`）与壁纸窗口（`wallpaper/manager/window.rs`）建窗前都
  `tauri_runtime_kbcef::allow_file_documents(label)`（CEF 补丁 [`04`](../../third-patches/cef/README.md)：建窗 `extra_info` 带
  `kabegame.allow_file_access_from_file_urls`，只给这个 browser 的 `file:` 文档打开 `allow_file_access_from_file_urls`，页面
  才能 fetch 同目录文件；偏好对应用页的 http / tauri 源没有作用）与 `allow_app_local_resources(label)`（补丁 05，三个桌面平台
  都登记：应用页能给 iframe 赋 `file:` 的 `src`；同时供图库媒体走 `file://`，见下「图库媒体」）。
  `allow_universal_access_from_file_urls` 仍关闭，`file:` iframe 碰不到父页面 DOM。
- **应用页直接赋 `src`，靠 CEF 补丁 05**：应用页是 `http://localhost:1420` / `tauri` 源，Chromium 有两道互相独立的关
  拦住它嵌 `file:`——渲染进程 Blink 的 `SecurityOrigin::CanDisplay(file:)` 对非本地源返回 false（控制台
  `Not allowed to load local resource`，iframe 停在 `about:blank`）；浏览器进程 `RenderFrameHostImpl::BeginNavigation` 的
  `FilterURL` 对没有 `file` 请求权的进程把 URL 改写成 `about:blank#blocked`。补丁
  [`05`](../../third-patches/cef/README.md) 按建窗 `extra_info` 的 bool 键 `kabegame.allow_local_resources` 在两道关各开
  一道门：渲染侧 `CefRenderFrameObserver::DidCommitProvisionalLoad` 在**最外层主 frame 每次提交非 `file:` 文档**时调
  `blink_glue::GrantLoadLocalResources`；浏览器侧 `CefBrowserInfo::MaybeCreateFrame` 给最外层主 frame 的 RFH 所在进程
  `ChildProcessSecurityPolicy::GrantRequestScheme(file)`。弹窗提交的任何文档、DevTools、OOPIF、fenced frame 一律不授；同源别名的
  `about:blank` / `srcdoc` 子 frame 与弹窗的初始 `about:blank` 按 Blink 自身规则继承，不超出应用页自身的能力。补丁**只开门**：
  iframe 的 `file:` 导航与 `file:` 文档的请求由运行时闸门按网页壁纸目录索引裁决（见下）。
  > 历史：Phase 6a 曾由运行时从浏览器进程对命名子 frame 调 `CefFrame::LoadURL` 绕开 `CanDisplay`，真机上渲染进程被杀并被
  > `on_render_process_terminated` 的无条件 `reload()` 放大成整窗刷新循环。不要再从后端导航子 frame。
- **前端时序**（`WpeWallpaperContent`，2026-11-15 前在 Stage）：`startWeb`：没有入口报 `fail(["web:no-entry"])`、不建 iframe（Web 版、
  Android 不挂实时画面，只有缩略图）；否则建 iframe、插入 DOM、赋 `src`。`load` 时 `isInitialBlank`（仍可读且是 `about:blank`）的
  初始空文档忽略；仍可读却不是初始文档（例如浏览器侧缺授权时改写出的 `about:blank#blocked`）报 `fail(["web:blocked"])`；读 `location`
  抛错（已是跨源 `file:` 页面）才算加载完成（`live`）。8 s 超时仍停在初始 `about:blank` 报 `fail(["web:not-navigated"])`（多半没带 CEF
  补丁 05），导航了只是慢就照样 `live`。换壁纸一律 `teardownWeb`（先 `about:blank` 再移除，frame 销毁）后重建 iframe，不在原 iframe 上
  改 `src`：闸门把「原 iframe 的 `file:`
  文档发起的导航」算作这个文档发起，跨到另一张壁纸会被拒。
- **CSP**：`tauri.conf.json.handlebars` 的 `frame-src 'self' blob: data: about: file:`（生成的 `tauri.conf.json` 被 gitignore）。
- **IPC**：CEF 给每个子 frame 注入桥；CEF 补丁 07 在建子资源工厂时捕获文档 URL 与父文档 URL，运行时按 initiator 与完整文档 URL 合成 `Origin`。`file:` iframe 只匹配绑定 `main` 与壁纸窗口 label 池、且 `frames: "sub"` 的 `wpe-web-capability`。回退通道来源不合法时用占位来源交给 ACL 拒绝。历史上按 `frame.url()` 读取会遇到首批请求竞态。
- **事件只投递到这个 iframe**：监听登记在调用方 frame 的表里，投递 eval 进这个 frame；iframe 销毁时 runtime 报
  `SubframeDestroyed`，Tauri 删掉它的全部监听，切换壁纸不会积累监听，也不再需要按导航调 `clear_js_listeners()`。
- **`localStorage`**：Chromium 按顶层站点分区存储，预览与桌面的顶层都是应用页，所以两处是**同一分区、互通**。以前桌面顶层是
  `file://`，那时桌面里存下的页面数据不会带过来。
- **触发点**：图库预览随预览打开 / 切图；桌面随 `WallpaperWindow.vue` 收到的当前壁纸目标（`setting-change` 的
  `wallpaperTargets` 里默认壁纸目标的 `currentImageId` 变了 → `get_current_wallpaper_target`，见
  [../wallpaper/MULTI_SCREEN.md](../wallpaper/MULTI_SCREEN.md)）。后端 `WindowWallpaperManager::set_wallpaper` 不导航，也没有
  别的要做：桌面鼠标由 iframe 自己登记（见下「鼠标」）。
- **过渡**：桌面与预览一样，图片 / 视频与网页壁纸之间走 web 层的淡入淡出；壁纸样式、倍速对页面不生效。
- **音量**：桌面与预览按设置里的壁纸音量出声，应用背景静音；由垫片接管页面的出声路径，见下「运行时垫片与宿主协议」的「音量」。

### ping 看门狗

`wallpaper/ping.rs` 的 `Pinger` 随 `WallpaperWindow` 持有（每个壁纸窗口一个，序号各自独立，一个窗口失联只重载它自己），在 `mount()` 挂载、显示完成后启动；丢弃对象时
reset 通道关闭，任务退出。后端用 sleep 循环每 10s 探测，页面收到事件才应答、不自己计时：窗口被遮挡变成 hidden
时页面定时器会被 Chromium 节流，页面心跳容易误报。sleep 不补发错过的 tick，系统睡眠唤醒后最多多算一次未应答。

往返使用两个全局事件种类：默认种类 `wallpaper-ping { label, seq }` 经 `GlobalEmitter` 广播、主事件循环 `app.emit`
送到窗口；应用页 `WallpaperWindow.vue` 与网页壁纸 iframe 里的垫片都 `listen`，只应答 label 等于自己窗口的事件，再调用
`wallpaper_pong(seq)`。**网页壁纸显示期间应用页不应答**（`Wallpaper.delegatesPing()` 逐层转问 `ImageContent` → `WpeWallpaperContent`：网页 iframe 存在即算，含加载中；场景在宿主垫片发过音量请求之后），交给
iframe 里的垫片：页面卡死就不应答，照样触发整页重载。切换的短暂间隙最多漏一两次（阈值 3 次），不会误触发重载。预览在主窗口里，
垫片读到的 label 是 `main`，过滤掉。命令从调用方 webview 取 label，页面不能替其它窗口应答；`wallpaper-pong { label, seq }`
是 opt-in，默认不转发给窗口、SSE 或「订阅全部」的 IPC 客户端，只有显式订阅它的后端看门狗接收。

连续 3 次未应答就 `reload()` 整个壁纸窗口（应用页连同网页壁纸 iframe，约 30~40s）。若重载后仍未收到一次有效应答，
下次判死所需次数翻倍：3 → 6 → 12……，上限 60（约 10 分钟）；有效应答会清零连续未应答次数并把阈值恢复为 3。
看门狗重载后 `clear_js_listeners()`（主 frame 的 `wallpaper-ping` 等监听随重载作废，Tauri 不会自己清；iframe 的监听随 frame
销毁另行清掉），并在状态机内重置：`floor = seq`、清空等待与未应答次数，只接收序号大于 floor 的应答，避免旧文档的迟到应答
影响新文档。序号持续递增，重置保留当前退避阈值，直到收到有效应答。窗口不再导航，`Pinger::reset()` 目前没有调用方。

应用页挂载即应答，不等 init 完成。ping 检查事件投递、JS 主线程与回程 IPC 是否存活；原有 init 看门狗继续检查初始化
是否跑通。CEF hang monitor 主要依赖输入事件回执，壁纸窗口几乎没有输入，由 ping 主动发起恢复。JS 卡死后 reload
能否触发 Chromium commit timeout、进入现有 terminate + reload 链路仍需真机验证：重载后 60s 内既无 renderer
unresponsive 也无恢复应答时，应报告并另补重建窗口兜底，不能用加大次数掩盖。

代价是窗口模式期间默认流每 10s 多一条 `wallpaper-ping`，其它窗口、桌面应用 Web 服务器的 SSE 与「订阅全部」的 IPC
客户端也可见（只有 label 与 seq）；订阅方可忽略。`wallpaper-pong` 不进入这些默认流。

### 图库媒体：`file://` 与按发起 frame 分档的闸门

第二阶段 Phase 6b 起，桌面 CEF 的图库媒体（原图、缩略图、兼容副本，包括 WPE 视频行位于创意工坊目录里的 `compatible_path`）
不再经本地 HTTP：前端直接把 `file:///…` 交给 `<img>` / `<video>` / CSS `url()`，由 Chromium 的 `FileURLLoader` 读文件
（原生 Range、不经 TCP、不整块读进内存）。Android 与 Web 不变。

- **CEF 补丁 06**：05 只放过 `CanDisplay` 与导航；content 只给 `file:` 前驱文档塞 `file:` 子资源工厂
  （`RenderFrameHostImpl::CommitNavigation`），所以只有 05 时应用页的 `<img src="file:…">` 请求发得出去、却以
  `ERR_UNKNOWN_URL_SCHEME` 失败。补丁 [`06`](../../third-patches/cef/README.md) 覆写
  `ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories`（先调父类），按同一键
  `kabegame.allow_local_resources` 给非弹窗 browser 的最外层主 frame 加 `content::CreateFileURLLoaderFactory`。工厂照常经
  `WillCreateURLLoaderFactory` 包成 CEF 的代理工厂，每个请求仍到 `OnBeforeResourceLoad`。Phase 6c 给每个工厂实例创建只允许该文档 origin 读 `file:` 的私有 CORS 列表；运行时还调用 `CefAddCrossOriginWhitelistEntry(origin, "file", "", true)` 通过 CEF proxy 的跨源闸门，profile 的共享列表不变。
- **登记**：`allow_app_local_resources` 给主窗口（`startup.rs`，三个桌面平台）与壁纸窗口（`wallpaper/manager/window.rs`，
  它的 Vue 页同样显示图片 / 视频；窗口壁纸模式只有 Windows / macOS；每个壁纸窗口建窗前按自己的 label 登记）登记；`allow_file_documents`（04）只为 WPE，主窗口与每个壁纸窗口同样都登记。
- **运行时按发起方分档**（`tauri-runtime-kbcef` 的 `resource_request_handler` + `file_access::classify_file_requester`；登记了任一
  能力的 label 的 `file:` 请求才进入分档）。不免检的请求在 `OnBeforeResourceLoad` 里向应用注册的解析器要访问范围
  （`set_file_scope_resolver`，即网页壁纸目录索引），再经 `check_file_request` 判定（百分号解码成路径，必须是普通文件，拒绝
  符号链接 / 目录 / 不存在，canonicalize 后必须落在范围的根目录或放行项内，Windows 大小写不敏感）：

  | 发起方 | 判定 | 处理 |
  | --- | --- | --- |
  | 应用页主 frame 的子资源（图库媒体） | 非导航、主 frame，initiator 与 07 文档头都不是 `file:` | 登记 05 即免检 |
  | `file:` 文档自己的请求 | 07 文档头是 `file:` | 按该文档解析壁纸目录与用户选择 |
  | 壁纸页面嵌的新 iframe 导航 | 子 frame 导航、07 父文档头是 `file:` | 同上，按父文档解析 |
  | 应用页给 iframe 赋 `src` | 子 frame 导航、07 父文档头已知且不是 `file:` | 目标须落进库里**某个**网页壁纸目录：按目标路径解析，只取壁纸目录、不带用户选择 |
  | 主 frame 导航到 `file:`、其它 | — | 拒绝 |

  拒绝时日志记 `deny file: <url> (outside <root>; grants N; <原因>; requester …) webview '<label>'`（info 级）。不按 frame id
  建表：WPE iframe 从 `about:blank` 导航到 `file:` 时换进程、换 RenderFrameHost，frame identifier 随之变化，而 frame 自己的
  文档 URL 就说明了它属于哪张壁纸。解析器注册之前（启动早期）所有不免检的请求都被拒绝；那时只有应用页主 frame 的子资源，
  它免检。
- **主 frame 边界**：应用页主 frame 的 `file:` 子资源免检，`fetch(file:)` / XHR 可取得字节；生产 CSP `connect-src file:` 明确允许。
  应用页能把库里任一网页壁纸目录加载进子 frame（只有它的主 frame 有补丁 05 的本地资源授权，其它子 frame 的文档本来就加载
  不了 `file:`）；`file:` 文档只能访问自己的壁纸。插件详情 EJS iframe 为 opaque origin，内层 CSP 禁止读取 IPC 与本地文件
  （它也有 IPC 桥，但没有任何 capability 匹配它）。
- **前端**：桌面 `fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 都返回 `file://`；复制兜底直接 `fetch(file:)`。Windows 拖出曾写当前媒体元素 `file://` 的 `DownloadURL`，已由 Phase 6d 取代：三个桌面平台都只写 image id、走 CEF 补丁 03 的真实文件链路（Windows 为 `CF_HDROP`，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`），Web 版保留 `DownloadURL`。插件文件改由 Tauri `read_plugin_file` 命令返回原始字节，图片缓存为 `blob:` URL。Android / Web 的 HTTP 文件路由、桌面可选应用 Web 服务器的 `file_routes_media()` 保留；桌面启动时不再开启本地 HTTP 文件服务。

### 网页壁纸目录索引

`wallpaper/wpe_web_dir_index.rs` 的 `WpeWebDirIndex`：库内每张网页壁纸的**规范化目录键 → 图片 id + 壁纸目录 + 用户选择算出的
放行**，外加图片 id → 目录键。只在内存里、不落库，是 `file:` 闸门与 `wpe_web_pull_state` 的唯一数据源（取代原来按 webview
存的「根目录 + 追加放行」与 `set_wpe_web_preview`）。

- **键**：与闸门同一套规范化，`tauri_runtime_kbcef::file_path_key`（canonicalize、去 Windows `\\?\` 前缀、Windows 不分大小写、去尾
  分隔符），两边不各写一份。查找沿路径的祖先向上，第一个在表里的目录就是所属壁纸（文档在壁纸子目录里也能找到）。目录已不
  存在时不登记。
- **建表时机**：三个桌面平台在 `core_init::init_heavy_globals` 里 `Storage::init_global()` 之后、进入 `Services` 阶段之前调用
  `init_wpe_web_dir_index()`。两个宿主都晚于它：主窗口虽在 `init_pre` 建好，但前端要等启动页 Ready 才会打开预览；壁纸窗口在
  `init_post` 才建。所以表一定先于任何网页壁纸 iframe 就绪，冷启动时桌面就是网页壁纸也能第一次就加载成功。
- **先订阅再扫描**：先同步订阅 `images-added` / `images-deleted` / `image-changed` / `images-change` 四种广播，再全量扫描
  （`Storage::list_wpe_web_rows`：`type = ?1` 等值查询、走 v049 的 `idx_images_type`，类型键取自 `WpeKind::Web.media_type()`；
  metadata 按行读），扫描期间到达的事件留在通道里随后处理。扫完向 runtime 注册解析器，再在后台跟随事件。
- **事件维护**：`images-added` 只看 `x-wpe/web` 行；`images-deleted` 按 id 删；字段补丁只处理表里已有、且带 `metadataId`（改了用户
  属性）或 `localPath` 的行。新增与补丁都按 id 重读行与 metadata 后 upsert（行没了或不再是 `x-wpe/web` 就删），按库里的当前状态
  落地，与各订阅之间的到达顺序无关；某个订阅落后丢事件（`Lagged`）时整张重建。逐事件路径只改内存、按 id 读库、不发事件，
  不打 trace 以上的日志。
- **放行的两条写入路**：事件跟随在收到 `metadataId` 补丁时按新 metadata 重算（改了目录属性，旧目录**立即**不可读，不必等
  页面重拉）；`wpe_web_pull_state` 在把状态交给页面之前用同一份 metadata 覆盖（页面拿到新路径时闸门一定已经认它）。两条路写的
  都是「这张壁纸当前 metadata 算出的放行」，先后到达结果相同；覆盖，不是追加。
- **失败时全拒**：建表失败只记 error 并保持空表，闸门全拒、拉取报错，网页壁纸加载不出来，但不放宽。

### 运行时垫片与宿主协议

P3-0a 起场景宿主复用这份垫片。地址带 `kbScene` 时，拉取 `wpe_web_pull_state` 会传 `imageId`；后端只在调用文档是场景宿主入口、id 是库内场景壁纸时按 id 返回状态，`directories` 为空且不写用户文件 grants。普通网页壁纸仍按文档目录认图，传入的 `imageId` 被忽略。父页面的 `kabegame:wpe-volume` 消息另带 `paused`（旧消息缺字段按 `false`），垫片只在状态变化时调 `wallpaperPropertyListener.setPaused`（页面起来时按未暂停，不会收到多余的 `setPaused(false)`）；首次全量属性交付之前就已暂停的，交付后补调一次 `setPaused(true)`。网页壁纸也适用。

WPE 网页壁纸要靠宿主提供的一组全局接口完成初始化，最关键的是 `window.wallpaperPropertyListener.applyUserProperties`：
宿主把作者默认值推给它之后，多数壁纸才开始画。Kabegame 用一份 JS 垫片 `webview_js/wpe_shim.js` 定义这组接口并投递属性，
**不照搬 WPE 的「宿主拼 JS、加载完成前排队」**（`API.md` §4.8），改成垫片驱动：垫片向宿主**拉取**完整状态、**订阅**
应用事件后重拉；宿主只回答「当前完整状态」和「转发事件」，不推状态、不排队、不记页面收到过什么。例外是音频 / 媒体数据
（Channel 推，见「音频与媒体集成」）与宿主音量（父页面经 `postMessage` 回复与推送，见下「音量」）；右键也经 `postMessage` 交给父页面（见下「右键」）。

- **注入与启用**：同一份垫片以 `initialization_script_for_all_frames` 挂在壁纸窗口（`wallpaper/manager/window.rs`）与
  主窗口（`startup.rs`）上，按地址自判：只在「父窗口就是 top 的 `file:` 子 frame」（网页壁纸 iframe，预览与桌面同一份）且
  有 `__TAURI_INTERNALS__`（CEF 注入的子 frame 桥）时启用，其它文档第一行就返回、不定义任何全局。壁纸自己更深的嵌套 iframe 不启用。启用后先装音量接管（见下「音量」），再定义 `wallpaperMediaIntegration` 常量、六个 `wallpaperRegister*Listener`（收下回调、Phase 8 前
  不回调）、空的 `wallpaperRequestRandomFileForProperty` 与 `wallpaperGetUtilities`，并标记 `window.__kbWpeShim === true`。
- **状态**（只在 Rust 侧计算，`commands/wpe_web.rs` 的 `build_wpe_web_state`）：`{ imageId, user, general: { language } }`。
  `user` 取自图片 metadata（导入时存的 `project.json` 原文）里 `general.properties` 中带 `value` 的条目，形如
  `{ key: { type, value } }`（`kabegame_core::wpe::properties::resolve_web_user_props`；分组、说明行、无默认值的 `file`
  属性不推）；`language` 是界面语言换成的 WPE 语言码（`wpe_language_code`：`zh-chs` / `zh-cht` / `ja-jp` / `ko-kr`，其余
  `en-us`）。`fps` 留给 Phase 6（推 0 会让按 `1000 / fps` 算间隔的页面停住）。Rust 不带版本号。
- **一种传输**：iframe 自己就是调用方，直接 `invoke` / `listen`，预览与桌面逐字节同一份：
  - `pull()` = `invoke("wpe_web_pull_state", { imageId? })`：普通网页壁纸不传 id；场景宿主从地址的 `kbScene` 传 id。命令按 `tauri::ipc::CallerOrigin`（ACL 判定所用的
    调用方来源；运行时由 initiator 与 07 文档 URL 合成完整来源，页面伪造不了）。它把来源还原成文档路径（只认 `file:`），
    在网页壁纸目录索引里找到所在的那张，按 id 组装状态，返回前用同一份 metadata 覆盖这张壁纸的放行；页面拿不到别的图片的
    metadata。宿主入口文档按传入 id 读取库内场景壁纸；其它不在网页壁纸里的文档、非 `file:` 来源都报错。
  - `listen(names, onEvent)` = 逐个 `plugin:event|listen`（`core:event:allow-listen`），事件只投递到本 frame；失败记录日志，等待下一次相关事件。
- **ping 应答**：垫片监听 `wallpaper-ping`，从 `__TAURI_INTERNALS__.metadata.currentWebview.label` 取自身 label、过滤后调用
  `wallpaper_pong(seq)`；不等 load 或属性拉取成功。只有壁纸窗口里的 iframe 应答（预览的 label 是 `main`）。`wallpaper_pong`
  只替调用方窗口发应答，不读取数据。
- **重拉触发**：`setting-change` 带 `language`（界面语言变了）或 `wpeFps`（桌面帧率变了）；`image-changed` / `images-change` 里有**本张**图片
  （`state.imageId`）的 `metadataId` 补丁——图片 metadata 按 id 不可变，属性一改就换 `metadataId`（Phase 7 的设置面板保存时
  写新 metadata 行）；首个状态到达前任何 `metadataId` 补丁都重拉。垫片**先订阅再拉取**，订阅生效后的变化都会触发重拉。
- **投递语义**（我们自己的规则）：
  - 首次投递在 `window` 的 `load` 之后，用户属性与通用属性各推一份完整的（先 `applyUserProperties` 再
    `applyGeneralProperties`，WPE 的实际顺序未确认）；`load` 之前到达的状态只记下来。
  - 之后每次重拉都拿到完整状态：用户属性只推**值变化的键**（WPE 的 `applyUserProperties` 本来就是「只含变化的键」，页面
    没有整份替换的接口；作者删掉的键不推，页面没有撤销接口）；通用属性有变化就推一整份。
  - 首次投递之后页面换了 `wallpaperPropertyListener` 对象，下一个微任务把当前完整状态补投给它：垫片在 `window` 上装这个
    属性的访问器，页面写 `window.x = …` 或顶层 `var x = …` 都走到 setter。
  - 乱序：垫片给每次拉取编号，某次结果落地后丢弃编号更早、返回更晚的结果（同 pathql 的 pending 窗口）。
  - 页面回调抛错只记 `console.error("[kb-wpe] …")`，不影响后续投递。
  - **键序**（2026-11-16）：交给页面的属性对象（`applyUserProperties` 的全量与增量、`applyGeneralProperties`）顶层键按名字排序。
    WPE 用 jsoncpp 拼回调参数，对象键按 `std::map` 排序【推，没在 WPE 上实测】；有壁纸依赖它：corsair_collection 的
    `applyUserPropertiesHandler` 按 `Object.keys` 逐个发设置，处理 `scene` 时先调 `effectProvider.currentEffect.reset()`，
    `currentEffect` 要等 `effect` 到了才有，按 project.json 顺序（`scene` 在前）会抛错，订阅被 rxjs 退订后再也不切场景、页面空白。
- **History API**（2026-11-16）：WPE 带 `--disable-web-security`，文档有 universal access，`pushState` / `replaceState` 能把地址改到
  别的路径；Chromium 对没有它的 `file:` 文档只许改 query 与 hash，改路径抛 `SecurityError`。用 HTML5 路由的单页壁纸先写地址再激活
  组件（Angular 6 的 `location.go` 在 `ActivateRoutes.activate` 之前），一抛错组件就建不出来。垫片在页面脚本之前包装这两个方法，
  只接住「同源 `file:` 目标改路径」这一种错误，改成保留本文档路径、带上目标的 query 与 hash 再写一次；和 WPE 的差别只是
  `location.pathname` 停在本文档。不给 `file:` 文档开 universal access：那会连带放开同源与 CORS。
- **监听随 frame 清理**：监听按「webview → frame → 事件」登记，iframe 销毁时 runtime 报 `SubframeDestroyed`，Tauri 删掉该
  frame 的全部监听。同一 frame 内重新导航后旧条目还在、投递进新文档时找不到 id 等于空操作，直到 frame 销毁；`WpeWallpaperContent`
  每次切换都销毁重建 iframe，不会积累。补丁 11 的 `clear_js_listeners()` 只剩看门狗整页重载时调用。
- **可见事件**：网页壁纸只能监听 `wpe-web.json` 作用域里的四个事件（`wallpaper-ping`、`setting-change`、`image-changed`、
  `images-change`，tauri 补丁 15），其它事件名（如 `images-added`）`listen` 被 ACL 拒绝；垫片新增监听要同步改 capability。
  命令层只开拉取状态与 ping 应答两个命令。
- **不做**（后续 Phase）：暂停冻结与 `setPaused`、`fps`；音频与媒体数据（Phase 8，数据回程沿用 `listen`）；Web 发布版 /
  Android / macOS / Linux 不渲染网页壁纸。
- **待真机确认**（Windows）：iframe 统一后的整条链路见 `versions/latest/regression.md`「frame 级 IPC（tauri 补丁 18–19）」。

#### 音量

网页壁纸的声音由垫片按**宿主音量**缩放：页面的生效音量 = 页面自己设的音量 × 宿主音量。宿主音量不走 IPC，经
`postMessage` 从父页面（`WpeWallpaperContent`）拿：它本来就有 `volume` prop，桌面与预览是设置里的 `wallpaperVolume`，应用背景是 0，
不必新增命令。不用 CEF 的 `SetAudioMuted`（整个 browser 静音，会连主窗口的预览视频一起静掉）；Chromium 也没有逐 iframe 的
静音 / 音量接口。

- **消息**：类型与字段集中在 `components/wallpaper/wpeWebVolume.ts`；垫片是不经打包的纯脚本，按同样的字面量另写一份，
  `wpeWebVolume.test.ts` 读垫片原文、用这里的常量跑一遍，两边不一致就失败。

  | 方向 | 消息 | 时机 |
  | --- | --- | --- |
  | 垫片 → 父页面 | `{ type: "kabegame:wpe-volume-request" }` | 垫片启动时发一次 |
  | 父页面 → 垫片 | `{ type: "kabegame:wpe-volume", volume }`，`volume` 为 0…1 | 回复请求；`volume` / `paused` 变化时主动推 |

- **父页面怎么答**：`WpeWallpaperContent` 挂载时（先于 iframe）在 `window` 上监听 `message`，只理会
  `event.source === 当前 web iframe 的 contentWindow` 的请求，回 `webHostVolume(volume, paused)`：`paused`（web 层被隐藏、
  脚本仍在跑）时为 0，否则是 `volume` prop 钳到 0…1。主窗口里应用背景与预览各有一个 `WpeWallpaperContent`，各答各的 iframe；换壁纸重建
  iframe 后旧 iframe 不再是当前的，新页面的请求照常回复。`volume` / `paused` 变化时把同一条消息推给当前 iframe（还停在初始
  `about:blank` 时也照发，那份文档没有垫片、收下即丢，页面起来后垫片会自己再要）。`targetOrigin` 为 `*`：对方是跨源 `file:`，
  消息里只有一个数。数据来源：桌面 `WallpaperWindow.vue` 的 `state.volume`（全局「壁纸设置」，`get_wallpaper_volume` +
  `setting-change`）、预览 `WpeWallpaperContent` 读这张壁纸「预览设置」的 `volume`（见下「壁纸设置与预览设置」）；应用背景由
  `ImageContent` 的 `video-muted` 传到 `WpeWallpaperContent` 的 `muted`，`volume` 为 0。
- **垫片怎么收**：在 `window` 上捕获阶段、最先登记的 `message` 监听，只认 `isTrusted`（页面伪造不了）、`source` 是启动时记下的
  `window.parent`、带上面类型标记且 `volume` 是数字的消息；`source` / `data` 用启动时取的 `MessageEvent.prototype` 原生
  getter 读，页面改原型也影响不了判断。认下的消息 `stopImmediatePropagation`，页面的 `message` 监听看不到。
- **默认静音**：收到第一条回复之前宿主音量按 0，页面一开始就放的声音不会先响一下；回复到达后才放开。
- **HTMLMediaElement**（`<audio>` / `<video>`，含不在 DOM 里的 `new Audio()`）：垫片替换 `HTMLMediaElement.prototype` 的
  `volume` / `muted` 访问器与 `play`。元素第一次被碰到（读写 `volume` / `muted`、调 `play()`，或 DOM 里的元素在 `window` 捕获
  阶段的 `loadstart` / `play`，覆盖不经 `play()` 的 `autoplay`）时，把当时的原生值记成页面值（含 HTML 的 `muted` 属性）；之后原生
  `volume = 页面值 × 宿主音量`、`muted = 页面值 || 宿主音量为 0`。页面读到的始终是自己设的值，写入照原生校验（非有限数
  `TypeError`、越界 `IndexSizeError`）。宿主音量变化时重新应用到所有记过的元素（弱引用）。页面改了值、原生值却没变（宿主音量为
  0）时补发一个 `volumechange`；反过来宿主音量变化引起的原生 `volumechange` 页面也会收到，读到的值不变。
- **Web Audio**：替换 `AudioNode.prototype.connect` / `disconnect`。连到实时 context（`AudioContext`，有 `webkitAudioContext`
  也算）`destination` 的连接改接到该 context 的**主增益节点**（第一次需要时用原生 `createGain` 建、原生 `connect` 接到
  destination），宿主音量只改主增益的 `gain`，不 `suspend`，页面的音频时钟照常走。`connect` 仍返回页面传入的 destination；
  `disconnect(destination…)` 换成主增益；input 下标非 0、跨 context、没连过就断开等情况照原生报错。`AudioWorkletNode` 等所有
  节点都继承 `AudioNode.prototype.connect`，一并覆盖；`OfflineAudioContext` 渲染到缓冲区、不出声，不接管。
- **媒体元素接进 Web Audio**：`AudioContext.prototype.createMediaElementSource` 与 `new MediaElementAudioSourceNode(...)`（全局
  构造函数换成转调原生的包装，`instanceof` / `constructor` 不变）把元素标为已接入：元素上不再乘宿主音量，由主增益乘一次
  （Chromium 的元素音量会作用到 source 节点，两处都乘会变成平方）。
- **覆盖不到**（对配合的页面尽力而为，不是安全边界）：
  - 壁纸页面里再嵌套的 iframe 发出的声音：垫片只在顶层的直接子 `file:` frame 启用；
  - 页面经嵌套 frame（例如同源 `about:blank`）拿到原始原型（`HTMLMediaElement.prototype` 的原生访问器、`AudioNode.prototype.connect`）
    就能绕过接管；
  - 在 shadow DOM 里、或不在 DOM 里又没调 `play()`、只靠 `autoplay` 出声的元素，在页面碰到它之前不受控（媒体事件不冒泡出
    shadow root，DOM 外的元素收不到捕获事件）；
  - 场景壁纸目前没有声音，不涉及。

#### 右键

iframe 里的右键到不了父页面（DOM 事件不跨 frame），所以垫片把它转给父页面。场景宿主也加载这份垫片，网页与场景同一条路。

2026-11-15 起 Windows / macOS 上 iframe 不收真实鼠标（见下「鼠标」），预览里的右键落在覆盖层（`WallpaperPointerOverlay`）上、
冒泡到预览容器的 `@contextmenu` 弹菜单，这条路不再触发。Linux 退回 iframe 直接收真实鼠标，仍走这条路。

- **消息**：`{ type: "kabegame:wpe-contextmenu", x, y }`，垫片 → 父页面，`x` / `y` 是 iframe 视口里的 CSS 像素。字面量集中在
  `components/wallpaper/wpeContextMenu.ts`，`wpeWebVolume.test.ts` 读垫片原文核对。
- **垫片**：在 `window` 捕获阶段、页面脚本之前登记 `contextmenu` 监听，只转发 `isTrusted` 的事件；页面取消右键或停止冒泡也照发
  （菜单是应用的功能，总能用）。原生菜单 CEF 已全局关掉（`DisabledContextMenuHandler`），不必 `preventDefault`。
- **父页面**：网页由 `WpeWallpaperContent`、场景由 `WpeSceneView` 收，只认 `isTrusted` 且 `source` 是自己当前 iframe 的消息，
  按 iframe 的显示矩形换算到本页面视口（预览画布带 CSS `scale`：坐标 × 显示矩形 ÷ 布局尺寸 + 左上角），经
  `WpeWallpaperContent` → `ImageContent` 的 `wallpaperContextmenu` 交给预览弹窗，在那个位置弹出与右键容器同一份菜单。应用背景
  不接收指针、桌面不注入右键，都不会触发。
- **覆盖不到**：页面里再嵌的 iframe 没有垫片；页面脚本自己也能发这条消息，最多就是弹出菜单，不能代用户点菜单项。

### 鼠标（原生注入 iframe）

2026-11-15 第二版起，网页壁纸与场景宿主的 iframe 收到的鼠标是 Rust 直接注入进这个 frame 的原生事件，页面里没有任何合成。图库预览
（主窗口）与桌面壁纸窗口走同一条路。计划见 `.claude/plans/wpe-import/phase-preview-pointer.md`。

- **登记**：iframe 里的垫片看父页面的音量消息（`kabegame:wpe-volume`，`WpeWallpaperContent` / `WpeSceneView` 发）：
  - `interactive && !paused` 时调 `plugin:cursor|attach_frame`，否则调 `detach_frame`。调用排队，不会乱序落地。
  - 预览与桌面传 `interactive`；应用背景不传，所以不登记。
  - 两个命令只给子 frame（`tauri::ipc::CallerFrame::Sub`），权限在 `wpe-web-capability`（场景宿主也匹配）。
- **轮询**：`tauri-plugin-cursor` 给每个登记的 frame 挂一个订阅，按它所在窗口每 16 ms 读一次全局光标与左键（窗口客户区的 CSS
  像素，光标在窗口外也照给）。
  - 移动：位置变了就发。
  - 按下：左键按下沿按窗口的点击规则发。登记时左键已按着不算。
  - 抬起：只在按下发过时发。
- **点击规则**：

  | 窗口 | 规则 | 判定 |
  |---|---|---|
  | 壁纸窗口池（`WALLPAPER_LABELS`） | `OverDesktop` | 光标在窗口内，且光标下是桌面。Windows：`WindowFromPoint` 的根窗口是 `Progman` / `WorkerW`；macOS：`windowNumberAtPoint` 命中窗口层级不高于桌面图标层 |
  | 其它窗口（主窗口的预览） | `OverWindow` | 光标下的顶层窗口就是本窗口，应用外的点击不算 |

  预览里浮在壁纸上的应用界面（工具条、箭头）不挡注入：点在上面时也会同时传进页面，这是有意允许的重叠。
- **注入**：应用在 setup 时给插件设注入器（`lib.rs`），转给 `tauri_runtime_kbcef::frame_mouse`。运行时在 CEF UI 线程上：
  1. 按 label 找 browser、按标识找 frame。
  2. 比 `_cef_frame_t` 的 `base.size`。旧 libcef 没有补丁 11，结构体短，读新字段会越界，所以只记一次 warn、不注入。
  3. 用 CEF 补丁 11 的 `ConvertPointFromView` 换到 frame 坐标。换算用合成器命中测试的变换，已含父页面的 CSS 变换、缩放与滚动，
     以后的放大平移也照算。
  4. 钳进 frame，经 `SendMouseMoveEventToFrame` / `SendMouseClickEventToFrame` 交给 frame 自己 widget 的 `ForwardMouseEvent`。

  这条路绕过根视图的命中测试、原生捕获、焦点窗口与光标管理：父页面盖在 iframe 上的覆盖层挡不住，不抢真实鼠标的捕获，页面收到
  `isTrusted` 的事件，`:hover` 与原生控件照常。
- **钳制**（`frame_mouse.rs` 的 `clamp_to_frame`）：点在 frame 外时取「frame 中心到该点的连线」与边界的交点，右、下边界向内收
  半个像素。视差与跟随鼠标的粒子因此停在边缘，不再外推。按下点（钳制前）不在 frame 里时这次按下作废，抬起也不发。
- **收尾**：解除登记、frame 销毁（`SubframeDestroyed`）、主文档开始加载新文档、窗口销毁时，插件发 `Release`；运行时补未配对的
  抬起与一次离开，再清掉这个 frame 的状态。
- **移动不带按键标志**（同 WPE 的 `modifiers=0`）：Blink 只对带左键的移动做拖动处理，带上会让拖动页面图片启动原生拖放。Windows 上
  那是阻塞 UI 线程的模态循环，而真实的抬起本线程收不到，拖放就挂住。所以按住拖动时，页面收到的 `mousemove` 的 `buttons` 为 0。
- **预览**：
  - iframe 一律 `pointer-events: none`，真实鼠标进不了 frame。
  - 壁纸之上盖一层只拦截、不转发的透明覆盖层（`WallpaperPointerOverlay`，在放大的变换层之外，见下「预览放大」）。鼠标在壁纸上
    移动时预览容器照常收到 `mousemove`（翻页箭头），右键冒泡到预览容器弹菜单，滚轮与左键 / 中键拖动交给放大。只为「iframe 吞掉
    mousemove」设的翻页热区已删。
- **焦点**：注入的按下会把键盘焦点切进 iframe；键盘还不支持，焦点留在里面时预览的 Esc、方向键失灵。但不能一按下就还：iframe
  失焦时页面会当成松开（场景宿主把 `blur` 当左键抬起），拖动就断了。预览画布用 `framePointer.ts` 的 `keepFocusOutOfFrames`：父页面的
  真实左键按着时不动，松开后等 100 ms（注入的抬起先到），`document.activeElement` 是画布里的 iframe 就 `blur()` 它。桌面壁纸窗口
  不在前台，不管焦点；Linux 退回时也不管。
- **暂停**：「暂停壁纸」经音量消息的 `paused` 到垫片，垫片解除登记（补抬起与离开），恢复时再登记。
- **多屏**：每个壁纸窗口里的 frame 各自登记、各有订阅，全部共用插件的一条轮询线程。光标在另一块屏时，各窗口的 frame 都钳在自己
  靠近光标的那条边上。
- **局限**：
  - 页面里的光标形状与 tooltip 显示不出来（注入不经光标管理）。
  - 网页壁纸里再嵌的跨源 iframe 收不到事件（只注入登记的 frame）。
  - 同进程的子 frame 不支持（换算失败）。我们的 `file:` iframe 与应用页跨站，都是独立进程。frame 刚登记、还没合成时第一次
    采样也会换算失败，之后就好，所以连续失败 30 次（`MAPPING_WARN_AFTER`）才记一次 warn。
  - 不做键盘、滚轮、右键。
- **Linux**：拿不到全局光标，`attach_frame` 返回 `false`。前端（`framePointer.ts` 的 `NATIVE_FRAME_POINTER`）退回原来的做法：
  可交互的 iframe 直接收真实鼠标，预览不盖覆盖层，光标在 iframe 外不跟随。Linux 也没有窗口壁纸模式。

### 预览放大

2026-11-15 起，图库预览里的网页与场景壁纸、视频（普通视频与视频壁纸，`x-wpe/video` 在预览里按普通视频播放）都和图片一样能放大。
预览放大没有单独的文档，普通视频也写在这里。计划见 `.claude/plans/wpe-import/phase-preview-zoom.md`（壁纸）与
`phase-preview-video-zoom.md`（视频）。

- **和图片共用一个 Panzoom**：`ImagePreviewDialog` 只有一个 `usePanzoomPreview`。壁纸分支包住 `WallpaperPreviewCanvas` 的那层 div、
  视频分支包住 `ImageContent` 的那层 div 也挂 `panzoomWrapperRef`（三支互斥，换元素即重建实例）。所以下面这些和图片完全一样：
  - 工具条：−、+、滑块、百分比、全屏；
  - Ctrl+滚轮缩放，单独滚轮在放大后平移、不缩放；
  - 抽屉开关、拖宽、全屏、容器尺寸变化时复位。

  壁纸换壁纸时画布元素没换、实例还在，换图的 watch 同样复位。工具条以前平铺右键菜单的可见项（那时 iframe 上右键用不了），
  现在和图片一样；暂停、设封面、清空脚本存储都在右键菜单里。
- **覆盖层在变换层之外，由它决定平移**（`WallpaperPointerOverlay.vue`）：覆盖层和 Panzoom 层是兄弟、盖在上面、不跟着放大，Panzoom
  自己的指针绑定碰不到它（它在按下那一刻就定了要不要平移，也不分按键）。平移的起止经 composable 的 `startPan` / `endPan`
  （Panzoom 的 `handleDown` / `handleUp`），中间的移动由 Panzoom 挂在 `document` 上的监听处理：
  - 左键：每次移动看事件的 `ctrlKey`，没按 Ctrl 就平移，按着就不平移（留给壁纸交互），所以拖动中途松开 / 按下 Ctrl 会接着 / 停下
    平移。只看指针事件的修饰键、不听键盘：拖动中焦点可能在 iframe 里（`keepFocusOutOfFrames` 等左键松开才还）。平移的同一次拖动
    也照常注入进了壁纸（接受）。
  - 中键：平移，不看 Ctrl；一律阻止默认（中键自动滚动）。
  - 右键：冒泡到预览容器弹菜单。
  - 光标：拖得动时 `grab`，平移中 `grabbing`。
- **注入照常**：`ConvertPointFromView` 用合成器命中测试的变换，已含放大与平移，点击与跟随对得上位置。
- **场景画布的分辨率**：显示缩放（`displayScaleOf`）含了放大，照原样上报的话放大 10 倍画布就是 10 倍，但场景目标没有那么高的
  分辨率。`WallpaperPreviewCanvas` 把放大倍数 `provide` 给画布里的场景（`WALLPAPER_PREVIEW_ZOOM`），`WpeSceneView` 上报
  `sceneDisplayScale(实测, zoom)`，放大时最多到 1（布局 × DPR），见 [WPE_SCENE.md](WPE_SCENE.md)「预览画布尺寸」。网页壁纸不处理：
  iframe 内容由 Chromium 按变换栅格化，页面自己的 canvas（WebGL 等）按页面定的分辨率被浏览器拉伸。
- **设封面**：不复位，截看得见的那一块（见下「封面」）。
- **视频**（普通视频与视频壁纸）：
  - `<video>` 收真实鼠标，不盖覆盖层，Panzoom 自己平移（左、中、右键都会开始平移，Panzoom 不分按键，同图片）；放大后关掉原生拖出
    （`native-drag="!panzoomCanPan"`，同图片）。
  - **拖过之后的点击不算数**：视频上单击是播放 / 暂停（`VideoControls` 听 `<video>` 的 click），放大后拖动、松开时浏览器照样派发
    click。`usePanzoomPreview` 在 Panzoom 层上挂捕获阶段的 `pointerdown` / `click`：按下时拖得动才记位置，松开处离按下点超过 4 px
    （`CLICK_AFTER_PAN_SLOP`）就在捕获阶段拦掉；没放大时、原地单击照常。图片上的点击没有动作，壁纸的鼠标落在变换层外的覆盖层上，
    都不受影响。
  - **双击不再全屏**（2026-11-15 去掉）：双击就是两次单击，全屏只走控制条的按钮。
  - **控制条的缩放按钮**：在音量与全屏之间，没放大时是放大镜、放大后显示百分比；悬停弹出竖向滑块（100–1000，同图片），点按钮回到
    100%。`VideoControls` 只显示和发事件（`zoom` 进，`zoom-drag-start` / `zoom-input` / `zoom-commit` / `zoom-reset` 出），弹窗复用
    图片缩放滑块的处理；音量与缩放两个悬停面板共用 `useHoverPanel`；拖缩放滑块或面板展开时控制条不自动隐藏。
  - **就绪时不复位**：视频的 `ready` 挂在 `canplay` 上，拖进度条、循环回到开头都会再触发，所以 `handlePreviewReady` 对视频跳过；
    视频换视频由换图的 watch 复位。
  - **清晰度**：`<video>` 是合成器里的视频层，CSS 缩放直接拿解码后的帧缩放，源分辨率以内都是真实像素，不用另外处理。
- **拖动范围含留白**：被放大的是铺满预览区的那层，内容按 `contain` 居中，放大后能把上下或左右的留白拖进视野；图片、壁纸、视频一致。
- **预期行为**（用户 2026-11-15 定为不算问题、不修）：
  - 放大后壁纸延伸到侧栏下面（被裁掉、看不见）。真实光标在侧栏上时注入的点仍落在 frame 里：移动照常，在侧栏上点击也会注入进
    壁纸视野外的位置（「点击不加闸门、允许重叠」的延伸）。
  - 光标出了窗口时注入点钳到 frame 的边界，放大后这条边界可能在视野之外，视差、跟随鼠标的粒子停在视野外那条边上。
- **已知副作用**：
  - 放大后设的封面，宽高比跟可见区域走，不一定是壁纸的比例。
  - Linux 没有覆盖层：壁纸上的滚轮、拖动进了 iframe，只有留白处（Panzoom 自己的左键平移）与工具条能缩放 / 平移。

### WPE 显示组件（`WpeWallpaperContent`）

`components/wallpaper/WpeWallpaperContent.vue` 只管一张网页 / 场景壁纸的实时画面跑没跑起来，不管过渡、打底与退回画面，
也不读设置：音量、暂停、可交互、场景样式与场景设置都由参数给。都经 `ImageContent` 的 wallpaper 形态挂上来：桌面（`Wallpaper`）给后端算好的
`target`，图库只给图片 id（`get_wallpaper_target_for_image`，同一个 `build_wallpaper_target`）。

- **网页**：在自己的容器里命令式创建 **`file:` iframe**（插入后直接赋 `src = webEntry`，见上「网页壁纸 iframe」），与应用前端
  不同源，拿不到父页面 DOM；IPC 来自 CEF 注入的子 frame 桥，权限只有 `wpe-web-capability`。
  `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（不给 top-navigation / popups / modals /
  downloads）、`allow="autoplay; fullscreen"`、`referrerpolicy="no-referrer"`。换目标、卸载时 **销毁** iframe（先 `about:blank`
  再移除），frame 销毁后它的监听随 `SubframeDestroyed` 清掉。`volume` / `paused` / `interactive` 经音量消息交给垫片（见上「音量」
  「鼠标」），暂停由垫片冻结页面、iframe 保持可见；iframe 的 `pointer-events` 一律 `none`（Linux 退回时可交互才收）。
- **场景**：挂一个 `WpeSceneView`（见 [WPE_SCENE.md](WPE_SCENE.md)「显示」）。
- **事件**：
  - `live`：网页 `load`（导航了但 8 s 没 load 也算，页面已在画，只记 warn）；场景出首帧，退回后又能渲染时再发。
  - `fail(reasons)`：显示不了，调用方当「原图加载失败」。网页：`web:no-entry`（`webEntry` 为空，不建 iframe）、
    `web:not-navigated`（8 s 后仍停在初始 `about:blank`，多半没带 CEF 补丁 05）、`web:blocked`（导航被改写成同源文档）；场景：宿主
    的 `fallback(reasons)`（不支持、编译失败、渲染器建不起来、设备反复丢失，都和编译 / 渲染有关；运行时脚本出错宿主只禁用那个
    回调、不走这里）、`host:unavailable`，以及 **30 s**（`SCENE_RESULT_TIMEOUT_MS`）既没首帧也没退回时的 `render:timeout`。
    编译类退回宿主留着（属性变化可能让它重新可渲染），只有超时卸载宿主，不让它一直占着 GPU 设备与 Worker。
  - `error(message)`：目标取不到（行已删、IPC 失败），致命。
  - `contextmenu(point)`：壁纸里点了右键，坐标已换算到本页面视口。
- **ping**：`delegatesPing()` 在网页 iframe 存在（含加载中），或场景宿主的垫片发过音量请求后为真，壁纸窗口据此把 ping 交给垫片
  应答。

### 桌面（`Wallpaper`）

2026-11-15 壁纸显示重构步骤 5 起，桌面不再有单独的 web 层与 scene 层：`Wallpaper` 每个壁纸一层 `ImageContent`（壁纸变体），网页与场景就是
它的 wallpaper 形态（下一节），和图库同一套显示。
- **层的进出**：新层 `ready` 之前不可见；`ready` 是「有东西可看了」（同预览的显示，见下「壁纸变体」：图片的缩略图或原图、视频首帧、
  网页 / 场景的缩略图或实时画面、加载超过 300 ms 的骨架、丢失图，先到的那个）后按过渡进来，过渡结束（`transitionend`，时长 + 600 ms
  兜底）后卸载旧层；第一张或过渡为 none 时直接换上。还在加载的那层被新目标直接替换，过渡中的先定下来；场景 → 场景时新旧两个宿主在
  过渡期间短暂并存（用户定）。新层显示不了时同预览换上丢失图（用户定，2026-11-15；以前丢掉新层、保留当前层），`error` 只进调试快照。
- **过渡**（时长在 `Wallpaper.vue` 的 `TRANSITION_MS`，经 `--wallpaper-transition-ms` 交给样式）：淡入 800 ms；缩放 900 ms（从 1.06 倍
  缩回并淡入）；滑入 1.5 s，新层从右侧整屏滑进来、同时把旧层推出左边（`is-leaving`），不淡入（用户定，2026-11-15；以前是右移 32 px
  并淡入 800 ms，4K 屏上只有 1% 多的位移，看上去就是淡入）。
- **图片立即加载**：壁纸变体的 `<img>` 是 `eager`。懒加载的图在新层还透明、当前层是播放中的视频时一直不开始（实测 8 s 以上），新层等
  不到 `ready`，看上去就是没换。
- **样式**：fill / fit / stretch / center → `fit` 的 cover / contain / fill / none；tile 时图片用 `displaySource()` 画重复背景（等比放进、
  居中重复），视频按 cover，网页忽略样式，场景把样式交给宿主（`playback.style`，留白是 `schemecolor`，见 [WPE_SCENE.md](WPE_SCENE.md)
  「样式」「留白颜色」）。
- **参数**：`volume` / `playbackRate` / 场景设置 / 样式合成 `playback` 交给每层，`paused` 反过来给 `videoPlaying`，`interactive` 原样，
  WPE 视频的作者属性经 `wpeVideo`、后端目标经 `wallpaperTarget` 下传（网页 / 场景不用再按 id 取一次）。
- **调试快照**（`debugState()`）：`media` 是当前层的类型（`targetKind`），`sceneFallback` 是当前层显示不了的原因，`lastError` 含新层失败；
  `delegatesPing()` 逐层转问。
- 和以前的不同：网页 / 场景加载期间桌面显示新壁纸的缩略图与进度（以前保留上一张直到出结果；网页壁纸的目标没有 `previewPath`，仍是等实时
  画面出来才换）；平铺的图片也有过渡（以前硬切）；不同类型之间的切换都按过渡交接（以前网页 / 场景整层淡入淡出、图片视频互切硬切）。

### 图库接入

- `ImageContent` 的 `wallpaper` 形态：**网页与场景** WPE 行（`isWpeWallpaperContentType`）在 `prefer="original"` 时显示，同图片
  「原图出来前缩略图能看」（2026-11-15 用户定）：
  - **缩略层打底**：作者 `preview.*` 或自定义封面（行的 `thumbnailPath`，缺 preview 时回落的目录本身不算），一打开就能看，加载完
    发 `ready`；
  - **实时画面当原图**：`WpeWallpaperContent` 叠在上面，`live` 且挂上满 300 ms（`WALLPAPER_MIN_LOADING_MS`，实时画面出得快时不闪
    一下缩略图）才淡入揭开；揭开 / 收回经 `wallpaperLive(boolean)` 告诉上层；
  - **失败按原图失败处理**：`fail` 时实时画面收起、缩略层是最终画面；之后又 `live` 照样揭开。缩略层也坏了才进丢失态；`error`
    （目标取不到）与 `localExists === false` 直接丢失；
  - `ready` 每张只发一次（缩略层加载完与揭开先到的那个）；重置只按图片 id，换封面只换缩略层（实时画面同一张只报一次 `live`，
    跟着重置就再也等不到揭开）；
  - **播放参数由调用方给**：`playback`（`WallpaperPlayback { volume, sceneSettings }`，预览与应用背景用 `useWpePreviewPlayback`
    取这张壁纸的「预览设置」），暂停看 `videoPlaying`，`videoMuted` 时音量 0，场景样式按 `fit`（contain → fit、cover → fill）；
  - Android / Web 没有 `wpe` feature，不挂实时画面，只有缩略层。

  - **加载进度**（步骤 3，`WpeLoadingOverlay.vue` + `useWpeLoadProgress`）：从挂上就盖在缩略层上，缩略图整体模糊（`backdrop-filter`），
    正中是阶段文字（技术名词，用户定：「初始化场景宿主 / 解析场景并编译着色器（WPESL → WGSL） / 解码纹理 mipmap / 初始化 WebGPU 设备、
    场景脚本与字体排版 / 创建 GPU 渲染管线 / 提交首帧」，五种语言）、细进度条与一行「当前阶段的 done / total · 总百分比（两位小数）」
    （计数只在编译、解码、建管线这几个有计数的阶段），预览、应用背景都显示（用户定：只看到
    清晰的缩略图、没有文字，就是没加载出来）；场景按宿主上报的进度画（规则见 [WPE_SCENE.md](WPE_SCENE.md)「加载进度」），网页壁纸
    只有不定进度条与「加载中」。实时画面出来时走满、停 200 ms 再淡出（模糊一起淡掉）；换一张从头再来。Android / Web 没有。
    **显示不了**（`fail(reasons)`，用户定）：文字与进度条变红、走满，标题「喵呜，这张壁纸渲染失败了呢」（用户定；超时是「加载超时」），下面一行是原因（宿主报的键，
    `; ` 连接，最多两行；超时不列）；停 200 ms 后模糊与中间那块淡出，红字原因换到缩略图底部（`placement="bottom"`，不模糊、没有进度条）
    留着，直到实时画面出来（改属性后又能渲染）或换图。
    **屏幕上的大小固定**：预览画布按壁纸分辨率排版再整体缩放（3840×2160 缩到约 0.25 倍），覆盖层按 200 ms 量自己的显示缩放
    （`displayScaleOf`，含 Panzoom），中间那块反向缩放、宽度取 320 px 与显示宽度 70% 的较小值（底部那块 480 px 与 90%），模糊半径
    除以缩放；不这样做文字只剩一两个像素。那一块按覆盖层绝对定位、`translate(-50%)` 对中，不用 grid 居中：小场景放大显示时（如
    dino_run，排版宽 343 px）它的排版宽度比场景还宽，grid 的列被撑开、从左边排起，中心会偏右（2026-11-16 修）。覆盖层必须是单根
    组件、由调用方定位（`absolute inset-0`），调用方的定位类才落得到。

  `x-wpe/video` 不走这里，仍是 `<video>` 链。
- `ImageContent` 的 **壁纸变体**（`variant="wallpaper"`，步骤 4，给桌面的 `Wallpaper.vue` 用）：加载与报错的显示同预览（用户定，
  2026-11-15；以前不画骨架与丢失图、图片等原图才 ready）：加载超过 300 ms 显示骨架、图片先出缩略图再盖原图、丢失画丢失图（照常报
  `error`）；不能拖出，图片 `eager`；`fit` 多了 `fill`（拉伸）与 `none`（居中）；`ready` 每张一次、意思是「有东西可看了」（画面、骨架、
  丢失图先到的那个），默认变体的 `ready` 不变（骨架、丢失不发）；视频静音起播、成功后按 `playback.volume` 出声，倍速取
  `playback.playbackRate`（钳到 0.25…3）；wallpaper 形态的场景铺放取 `playback.style`（桌面的壁纸样式，含 tile）。`displaySource()`
  交出当前画面（已出来的原图层、否则缩略层，或视频）的地址与固有尺寸，给平铺用，画面换了（缩略层、原图层、视频出来）发
  `displayChange`，平铺据此从缩略图换成原图。图库（`variant` 缺省）的行为不变。
- 网格（`ImageItem`）对所有 WPE 行固定用缩略形态，不悬停加载原图形态；角标「WPE · 视频」/「WPE · 网页」。
- 预览弹窗对非视频 WPE 行渲染 `components/wallpaper/WallpaperPreviewCanvas.vue`：给一块固定尺寸的画布，整体
  `scale` 进可用区域并居中，没有背景，和单独的图片一样显示。尺寸取图片行的 `width` / `height`（场景入库时写的分辨率）；
  网页壁纸没有固有尺寸，透视场景读不到，这时按主显示器逻辑分辨率（`primaryMonitor()`
  的 `size / scaleFactor`，失败回退 `window.screen`，模块级缓存），页面按这个尺寸排版。可交互，和图片一样能放大（Panzoom 包住画布，
  见「预览放大」），不挂 `VideoControls`，控制条和图片一样。
- 应用背景层不按类型分支：与预览同走 `ImageContent` 原图形态（`prefer="original"`），网页与场景壁纸都实时渲染、不交互。
  **背景静音**：`video-muted` 让交给 `WpeWallpaperContent` 的 `volume` 为 0，网页壁纸页面的声音由垫片按 0 缩放（见上「音量」），
  开着应用背景时只有桌面出声。

### IPC 纵深防御

tauri 补丁 19 起，CEF 下**每个子 frame 都有 Tauri 的 IPC 桥**（包括预览 / 桌面的网页壁纸 iframe、插件详情 EJS iframe、
畅游页里的第三方 iframe），invoke key 不再是闸门，ACL 是唯一闸门：

- 子 frame 的请求记为 `IpcFrame::Sub` 并带 `SubframeId`，只匹配 `frames` 为 `sub` / `any` 的 capability；本应用只有
  `wpe-web-capability` 写了 `frames: "sub"`（`file:///*` 来源）。特赦只认本地来源的主 frame。
- `cef-ipc` 回退通道不再按「主 frame 或同源子 frame」挡请求，放行所有 CEF 给出了 frame 的请求、交给 ACL；来源只取协议层写好的 `Origin`；不合法时所有 frame 都用占位来源 `kabegame-unattributed://ipc/`（不匹配任何 capability，
  在 ACL 被拒，错误回调送回调用方 frame），**不再**退到 webview 初始 URL（应用页）把子 frame 判成本地来源。
- 唯一绕过 ACL 的命令 `plugin:__TAURI_CHANNEL__|fetch`：Channel 大数据队列按 webview 顺序编号、可以被猜到，条目绑定发起方
  frame，别的 frame 拿同一个 id 只得到 `data not found`。
- 送回页面的数据（监听登记、事件、Channel 消息、回退响应）都 eval 进发起调用的那个 frame。

**待真机校准**：`fill`（WPE）→ `contain` 的几何、`wec_*` 的 −1…1 与 CSS filter 量纲。

### 用户属性（第二阶段 Phase 7）

`x-wpe/web` 的用户改动存于该图片 metadata 顶层的 `userProperties` 对象，只保存与作者默认值不同的键。写命令 `set_wpe_web_user_properties` 在 `Storage::rewrite_image_metadata` 的单个事务中读取旧数据、插入新 metadata 行、只改指这张图片并清理无引用旧行；搜索词映射、插件信息和模板沿用旧行。提交后广播 `metadataId` 字段补丁。`get_wpe_web_properties` 返回有序、已本地化的属性视图；桌面与预览的状态拉取按「作者默认值 + 用户值」组装。

带作者 `step` 的滑块，拖动与输入框键入的值都对齐到 `min + k×step`（缺 `min` 从 0 起算）：前端 `KbNumber` 的 `stepStrictly` 提交前对齐，后端 `apply_changes` 写入前再对齐一次，外部写入也得到同样的值；作者默认值不对齐，没有用户值时页面拿到原值。

预览右栏和设置页「当前壁纸」对网页与场景壁纸都可打开属性面板（场景与网页同一格式，后端 `has_user_properties`；面板对场景隐藏 `file` / `directory`，场景渲染器不读它们；场景特有的 `scenetexture` 只在场景上显示，网页壁纸上没有这一类，见下）。面板本地草稿立即改变显示条件，300ms 防抖后串行提交；同张图片的 `metadataId` 补丁和界面语言变化触发重读。条件由受限解释器处理字面量、运算、三元、数组、`<key>.value` 及五个字符串 / 数组方法；不认识的条件默认显示，不执行任意脚本。属性说明和标签经 HTML 白名单净化。

`file` 与 `directory` 仅使用用户所选路径；无作者默认值时清空路径会删除该用户键，垫片向页面补发空路径以撤销旧值。core 生成文件 / 目录放行项（`user_file_grants`），网页壁纸目录索引按这张壁纸当前的 metadata **覆盖**它的放行（`metadataId` 补丁到达时、`wpe_web_pull_state` 返回前各写一次，见上「网页壁纸目录索引」）：改了目录属性，旧目录立即不可读；另一张网页壁纸读不到这张的用户选择。预览与桌面共用这套闸门。目录属性递归列举浏览器安全的媒体文件，最多 10000 个；垫片对 `fetchall` 发送文件增删回调，对 `ondemand` 随机返回一个文件。

场景的 `scenetexture`（用户纹理，P11b；渲染一侧见 [WPE_SCENE.md](WPE_SCENE.md)「用户纹理（P11b）」）：`WpePropKind::SceneTexture`，面板用和 `file` 相同的文件选择与清空按钮。`project.json` 里没有 `filter`，过滤固定为 WPE 那一条（`jpg jpeg jfif png gif mp4`，`SCENE_TEXTURE_EXTENSIONS`），所以没有「WPE 收、浏览器解不了」的格式。校验同 `file`（绝对路径、是文件、不是符号链接，空串表示清空）；存之前照 WPE 整理路径（`wpe_slash_path`：`\` 换成 `/`、非开头的连续 `/` 合并，UNC 的开头 `//` 保留，不拷贝、不改大小写）。`user_file_grants` 同样收它：网页壁纸目录索引的场景条目除目录外再存这些文件，`scene_grants` 一起返回给场景宿主的访问范围，覆盖时机同上两处（`wpe_web_pull_state` 的场景分支返回前也写）。宿主是一份文档，放行对全部场景宿主实例生效；文件都是用户自己选的。`usershortcut` 不进放行：它不读文件，图标与启动都在后端。

场景的 `usershortcut`（快捷方式，P11d；图标、门禁与启动见 [WPE_SCENE.md](WPE_SCENE.md)「快捷方式（P11d）」）：
- **面板**：`WpePropKind::UserShortcut`，只在场景、只在 Windows 上显示（`WpeShortcutField.vue`）。
  - 先选类型：文件、文件夹、网址、命令；再填路径，文件与文件夹可以浏览选取；文件类型另有参数输入框。
  - 「测试」按钮先 `saveNow()` 存下，再调启动命令 `wpe_open_user_shortcut`。主窗口里的点击本身就是用户激活。
- **值**：格式是 `<类型>:<路径>`，类型 `file` / `directory` / `web` / `cmd`，空串表示清空。
  - 拆参数照 WPE（`parse_user_shortcut`）：`file` 在第一个 `|` 处拆成「路径 | 参数」，`cmd` 在第一个空格处拆成「程序 参数」；拆完路径为空不收。
  - `web` 不以 `http://`、`https://`、`www.`、`steam://` 开头时，存之前补 `https://`（区分大小写，照 WPE 面板的 JS）。
  - WPE 的值中间还有一段 6 位本机哈希，用来拒绝别的机器上配的值。我们的值只来自本机面板，不复刻这一段。
- **交给场景宿主的**：`wpe_web_pull_state` 的场景分支不给原值，给 `{ value: 原值 SHA-256 的前 16 位十六进制, isbound, commandtype?, file? }`（`scene_user_from_view`）。完整路径不离开后端；非 Windows 时 `isbound` 一律为假。
- **网页壁纸**不读这类属性，面板也不显示。

### 壁纸设置与预览设置

暂停、音量、视频倍速、媒体集成、帧率、场景后处理 / 反射 / 阴影 / 体积光这一组通用设置分两份，用同一个字段组组件
（`components/wallpaper/WpeSettingsFields.vue` + `WpeSettingControl.vue`，纯视图，改动经 `update` 报给调用方；字段表、默认值、
按类型选字段与「跟随 WPE」的规则在 `utils/wpeSettings.ts`）：

- **壁纸设置**（桌面）：全局设置键（`wallpaperPaused`、`wallpaperVolume`、`wallpaperVideoPlaybackRate`、`wpeMediaIntegration`、`wpeFps`、
  `wpeScenePostprocess`、`wpeSceneReflection`、`wpeSceneShadows`、`wpeSceneVolumetrics`），所有壁纸共用、只给壁纸窗口。设置页
  `components/settings/items/WpeWallpaperSettings.vue` 显示全部字段（当前壁纸用不上的照样显示，只是不起作用），每个字段接
  `useSettingKeyState`；暂停只在窗口模式显示，媒体集成只在 Windows。
- **预览设置**（预览与应用背景）：每张 `x-wpe/*` 壁纸一份，存在 metadata 顶层的 `previewSettings`（与 `userProperties` 并列，
  只存与 Kabegame 默认值不同的键），读写 `get_wpe_preview_settings` / `set_wpe_preview_settings`（`kabegame_core::wpe::preview_settings`
  解析、钳制与改写，经 `rewrite_image_metadata` 后发 `metadataId` 补丁），没设的项取 Kabegame 自己的默认值（暂停否、音量 1、倍速 1、
  媒体集成开、帧率 30、后处理 `enabled`、反射开、阴影 `medium`、体积光 `medium`；帧率以外与 WPE 出厂值一致），**不回落到全局**。前端 `useWpePreviewSettings`
  让同一张的全部使用方（预览右栏、画面里的 `WpeWallpaperContent`、预览弹窗给视频壁纸设倍速）共用一份状态，面板改动当场生效，
  草稿 300 ms 去抖后写，别处写入（`metadataId` 补丁）时重读。预览右栏的「预览设置」面板（`WpePreviewSettingsPanel.vue`）按类型
  显示：网页是暂停、音量、媒体集成、帧率；场景再加后处理 / 反射 / 阴影 / 体积光；`x-wpe/video` 在预览里按普通视频播放，只有倍速（暂停与音量
  归视频控制条，音量是全部视频共用的 `kabegame-video-volume`）。
- **预览的暂停不存**：它是 `ImagePreviewDialog` 的内存状态 `wallpaperPaused`（换图复位），和右键菜单的「暂停」是同一个；
  字段组的暂停开关把改动交回弹窗。
- **应用背景**强制暂停（`video-playing` 恒为 false：视频停在第一帧、网页由垫片冻结、场景停在加载时画的第一帧），音量 0，
  其余取这张壁纸的预览设置。
- **作者的用户属性**（上节）只有一份，桌面与预览共用，不分作用域。
- **「跟随 WPE」**：只在能读到 WPE `config.json` 时提供（`get_wpe_follow_available`：只有 Windows，且 WPE 安装目录里有
  `config.json`；`useWpeFollowAvailable` 全应用一份，`wpeEngineDir` 变了重读）。不能跟随时选项里没有这一档，存着的 `follow`
  显示为 Kabegame 默认值，交给场景宿主前也换成默认值（`wpeSceneSettingsOf`）。媒体集成只有开 / 关两档。
- **场景四项怎么到宿主**：父页面经 postMessage 下发（`kabegame:wpe-scene-settings`，见 [WPE_SCENE.md](WPE_SCENE.md)「场景后处理档位」），
  壁纸窗口传全局值，预览传预览设置；宿主不再自己读全局设置。
- **帧率**（整数或 `"follow"`，默认 30）：范围 10 到显示器最高刷新率（`get_display_max_refresh_rate`，同 WPE 滑块的
  `runtime.frequencymax`），「跟随 WPE」是滑块上方的开关。它不走上面的 postMessage：生效值由 `wpe_web_pull_state` 按调用方窗口
  取全局或预览设置、解析跟随（WPE `config.json` 只读一次）后放进 `general.fps`，垫片经 `applyGeneralProperties` 同时交给网页壁纸与
  场景宿主，场景就地改限帧（见 [WPE_SCENE.md](WPE_SCENE.md)「帧率」）。

### 封面

WPE 行的 `thumbnail_path` 默认是作者目录里的 `preview.*`，场景的退回画面（`previewPath`）也取它。预览的右键菜单有「设为壁纸封面」：`capture_wallpaper_cover(imageId, region)` 截主窗口，按 `region`（看得见的那一块画布占窗口内容区的比例）裁出来，缩到最长边不超过 1920，写进 `thumbnails_dir`，再经 `replace_image_thumbnail_path` 换行并发 `thumbnailPath` 补丁。暂停时截到的就是停住的那一帧。「恢复默认封面」在预览详情栏的属性面板里（`restorableCover`）；设置页的属性弹窗没有封面按钮。

- **预览专属的菜单项**（`actions/imageActions.ts`）：「暂停」（排第一）、「设为壁纸封面」「清空脚本存储」（只场景）只在 `ImageActionContext.wallpaperPreview` 存在时显示，它由 `ImagePreviewDialog` 在桌面预览网页与场景壁纸时给出（`live` / `paused` / `coverBusy`）；画廊的右键菜单不带它，所以没有这几项。工具条和图片一样（缩放与全屏），不平铺菜单项。这几条命令由弹窗的 `handleWallpaperCommand` 处理，不发 `contextCommand`，网格不需要知道画面出没出来。
- **截整窗再裁，不用 CDP 的 `clip`**：`clip` 靠临时改视口实现，这次改动画在屏幕正在显示的表面上，整个窗口跳变约 150 ms，`scale: 1` 也一样；宿主和页面收不到尺寸事件，只看 `stats()` 发现不了。代价是封面分辨率等于画布的屏幕像素（窗口 1200 CSS 宽、缩放 150% 时约 1071 宽）。对 iframe target 截图也不行，Chromium 只认顶层（`Command can only be executed on top-level targets`）。
- **画面确定实时渲染之前，暂停与设为壁纸封面置灰**：看 `ImageContent` 的 `wallpaperLive`（实时画面揭开才为真，退回缩略图时为假），即弹窗的 `previewRendering`，经 `wallpaperPreview.live` 交给菜单项。`ready` 在缩略层加载完就发，不能用来判断。后端不记实时状态，也不校验。恢复不受影响：退回缩略图的场景也能恢复；属性面板的 `customCover` 跟着 `thumbnailPath` 补丁重读，从菜单设的封面也会让恢复按钮出现。`ImageContent` 的壁纸形态只按图片 id 重置：换封面改的 `thumbnailPath` 只换缩略层，实时画面不收回（同一张只报一次 `live`）。
- **截图前的等待**（`WallpaperPreviewCanvas.withCaptureRegion`）：盖在画布上的 UI 会截进去，先在 `<html>` 加 `data-kb-cover-capture` 隐藏看板娘、预览容器里除壁纸画布外的全部元素（工具条、箭头、抽屉开关：从右键菜单点时它们可能正显示着）与全部弹出层（`[data-reka-popper-content-wrapper]`：右键菜单、提示、气泡，传送到 body 下；右键菜单点完还要淡出 100 ms，Reka 等退场动画放完才移除，截图只等两帧，所以直接藏、不靠等），`finally` 里恢复；壁纸层出画面后还要淡入，这时截到的是黑底，所以再等画布里的 `CSSTransition` 结束（只等过渡：页面里可能有循环动画）。
- **放大时截看得见的那一块**（2026-11-15）：不复位缩放，用户可以借放大定制封面。区域取画布矩形与壁纸可见区域（`.preview-wallpaper-wrapper`，Panzoom 的父元素）的交集：放大后画布超出可见区域，侧栏不在预览容器里、截图时不隐藏，后端也只按整张截图钳制，不求交就会把侧栏截进去。宽高比跟可见区域走；场景画布此时分辨率更高（`sceneDisplayScale`），封面更清楚。
- **遮挡**：窗口被完全遮挡时 `visibilityState` 不是 `visible`，矩形即使量得出来，截到的也是残缺的画面，所以报错不截。
- **文件归属**：删除只碰 `thumbnails_dir` 里的文件，作者的 `preview.*` 不动。换封面、删图时旧封面随之清掉；「恢复默认封面」读 `project.json` 的预览图，没有时回到 `local_path`（同 `add_image` 的兜底）。`get_wpe_web_properties` 的 `customCover` 表示封面在 `thumbnails_dir` 里。重新导入跳过已有行，封面保留。

### 音频与媒体集成（第二阶段 Phase 8）

WPE 的音频与媒体数据是「页面登记、宿主推送」：页面调 `wallpaperRegisterAudioListener` / `wallpaperRegisterMedia*Listener`
之后才开始收数据。垫片在页面第一次登记某类监听时调 `wpe_web_media_subscribe({ kind: "audio" | "media", channel })`，
交出一个 Tauri Channel（手写 `{ message, index }` 序号协议，乱序先存、按序投递），之后每类监听都从这条 Channel 回调；
媒体每类缓存最后一条，晚登记的回调补一次。预览（主窗口）与桌面（壁纸窗口）的 iframe 走同一条路，命令同
`wpe_web_pull_state` 按 `CallerOrigin` 经网页壁纸目录索引认出是哪张；`audio` 只对 `general.supportsaudioprocessing: true`
的壁纸放行（照 WPE），被拒时页面永远收不到音频回调，与 WPE 一致。不用全局事件：每秒 30 帧的频谱不进事件系统，
tauri 补丁 18 起作为命令参数的 Channel 只投递到调用方 frame。

**订阅归属调用方 frame**（`wpe_media/mod.rs` 的 `WpeMediaHub`，键是 `(webview label, SubframeId, 类型)`，`SubframeId` 来自
补丁 18 公开的命令参数 `tauri::ipc::CallerFrame`）：
- `WebviewEvent::SubframeDestroyed` → `release_frame`（`lib.rs` 的全局 `on_webview_event`）。主窗口刷新、看门狗整页重载、
  关预览、网页壁纸之间切换都会销毁旧 iframe，不需要在导航入口或宿主页另外释放；旧 frame 的销毁事件晚到只删旧 id，
  碰不到新 iframe 的订阅。
- 同一 frame 再订阅同一类替换旧条（页面自己刷新、frame 不换）。窗口销毁（`WindowEvent::Destroyed`）删整个 label。
- 发送失败只作兜底：Channel 发往已销毁子 frame 时运行时静默丢弃（`EvalInSubframe` 找不到 frame），`send` 照样成功，
  大于 8 KB 的消息（封面）还会存进 Channel 数据队列等页面来取。所以 frame 级释放必须靠销毁事件。
- 没有退订命令：WPE 没有取消登记的接口。

有 `audio` 订阅才开采集线程，有打开了「媒体集成」的 `media` 订阅才开媒体会话监视（仅 Windows 有开关）。开关按订阅算
（`MediaGate`，由 `wpe_web_media_subscribe` 按调用方窗口定）：壁纸窗口的订阅跟全局设置 `wpeMediaIntegration`（默认开），
主窗口的订阅（预览与应用背景）跟这张壁纸预览设置的 `mediaIntegration`（默认开），见下「壁纸设置与预览设置」。网页与场景壁纸
都受它管。最后一个订阅离开即停（`info!` 记启停，增删订阅 `debug!` 记 label / frame / 类型 / 订阅数）。停止线程
（丢弃句柄会 join）一律在订阅表的锁外，采集线程自己触发的停止不 join 自己。

- **音频**（`wpe_media/audio/` + `spectrum.rs`）：采集线程与推帧循环在 `audio/mod.rs`，两个平台只提供「默认输出设备 id +
  打开回环流 + 读样本」（`Devices` / `LoopbackStream`，按 cfg 选后端）。每 10ms 读包、每 33ms 出一帧 128 个浮点（左 0–63、右
  64–127，低频在前）。推送定时器与采集包解耦：静音包或这段时间没有包都按静音补零，页面收到逐帧衰减到 0 的数据，「空闲」判断才生效；
  打不开设备也照样推静音帧。默认设备每秒比对 id、读取失败立即重开。
  - **Windows**（`audio/wasapi.rs`）：WASAPI 共享模式回环读默认输出设备（`eRender` / `eConsole`）的混音（系统静音时回环不送包），
    `AUDCLNT_E_DEVICE_INVALIDATED` 表现为读取失败。只处理 32 位浮点与 16 位整数混音格式。
  - **macOS**（`audio/process_tap.rs`，2026-11-16）：Core Audio 进程 tap（14.2+），`CATapDescription` 的「全局立体声、不排除
    任何进程」挂进只放 tap 的私有聚合设备（不放输出设备做时钟：带麦克风的耳机会连麦克风一起开），IOProc 在实时线程里把输入
    缓冲（tap 的流在缓冲列表末尾，交错 / 非交错都收，只收 32 位浮点）拷进预留容量的共享缓冲（`try_lock`、满了整段丢、不分配），
    采集线程每轮换出来喂频谱。静音时 tap 送全 0 样本。最低系统版本是 11，`AudioHardwareCreateProcessTap` /
    `AudioHardwareDestroyProcessTap` 用 `dlsym` 取、`CATapDescription` 按类名找，14.2 以下打开报错、推静音帧。
    第一次启动时系统弹「录制系统音频」授权，用途说明 `NSAudioCaptureUsageDescription` 写在 `src-tauri/kabegame/Info.plist`（release
    打包合并）与 `macos/embedded-Info.plist`（dev 裸可执行文件），两处同步；拒绝时 tap 只送静音。权限记在负责进程名下，dev 从
    VS Code 终端拉起时记在 VS Code 名下。全局 tap 跟随系统混音、不绑设备，换默认输出设备仍重开一次（采样率可能变）。
  频谱算法自定（WPE 未公开）：Hann 窗 → 2048 点实数 FFT（`realfft`）→ 64 个对数频段（30 Hz – 16 kHz，不超过奈奎斯特的
  95%）取段内峰值 → dB + 高频补偿（相对 1 kHz 每倍频程 +3 dB）→ `(dB − (−70)) / 60` 映射、上限 1.2 → 上升即时、下降每帧
  保留 0.75。常数集中在 `SpectrumTuning`，真机按样本调。
  同一批样本另喂给 WPE 采集线程的原始频谱（`wpe_spectrum.rs`，P4e 步骤 4，照 `.claude/plans/wpe-import/3-scene/phase4/rea-p4e-audio.md`
  3.2 逐行复刻：每攒够约 29 ms 的样本做一次 1920 / 2089 点复数 FFT（`rustfft`），不加窗、样本写成 `127·s + 127`，乘频率倾斜后按四次方根
  归入 64 段取最大，得到线性原值；静音标志的包、读取失败立即清零，缺包 1 s 后清零），随同一条消息的 `raw` 字段推出，只给场景宿主用
  （它再照 WPE 做每帧的自适应归一化，见 [WPE_SCENE.md](WPE_SCENE.md)）。网页壁纸仍用上面的自定频谱：WPE 给网页壁纸的其实是这份原值
  （rea 3.4），2026-11-13 用户比较两者后选择保留自定算法的观感。
- **媒体**（`wpe_media/media.rs` + `projection.rs` + `colors.rs`）：专用线程持有 SMTC 管理器与当前会话
  （`CurrentSessionChanged`、`SessionsChanged` 都只是重取当前会话），WinRT 事件只发信号，读取与比较在线程里做。
  信号照 WPE `winrtutil64.exe` 的主循环处理：收到第一个后把 100 ms 内到的攒成一批，会话上的事件带挂接代数、旧会话的丢掉，
  批里有会话切换就只重新挂接（P11c，会话退出时那条瞬时的播放状态不再发出）。每次读到的数据交给两个投影（P11c），
  订阅按调用方文档归属其一：
  - **网页投影**（网页壁纸目录里的文档）：变化才推。
    - `Properties`：标题、艺人、副标题、专辑、专辑艺人、逗号拼接的流派、`music` / `video` / `image`，缺省 `music`。
    - `Thumbnail`：封面字节变了才解码，长边缩到 512 的 PNG data URL，格式 `rgb(r, g, b)` 的五个颜色。
    - `Playback`：Playing 1、Paused 2、其余 0。
    - `Timeline`：秒；播放中每秒按 `LastUpdatedTime` 外推；播放状态切换时不重读时间轴，按旧状态外推的位置作新基准，
      因为很多播放器的读数停在上次跳转；播放器不给时间轴就不推。
    - 没有会话时推 `Playback 0` 与空属性、空封面。
  - **场景投影**（场景宿主的入口文档）：照 `winrtutil` 取值，整秒时间轴、不外推，原尺寸封面（`sceneThumbnail`），超长字段清空，
    每类和上次发出的值比，见 [WPE_SCENE.md](WPE_SCENE.md)「媒体（P11c）」。
  - **五个颜色**两个投影共用（P11c 起照 WPE，`colors.rs`）：在原尺寸、Spotify 预处理之后的像素上算 360 格色相直方图的三色。
    `textColor` 取对比度 ≥ 2.5 的次色 / 第三色、否则同 `highContrastColor`；`highContrastColor` 按主色对黑的对比度取黑或白。
    **没有封面时五色全黑**：Phase 8 原来是深灰底白字，P11c 照 WPE 改了。
  - 新订阅先收 `Status { enabled }`，监视在运行时再补发快照：网页投影补全部；场景投影照 WPE 只补非空的几类。
  - 关「媒体集成」：只对开关归属匹配的订阅推 `{ enabled: false }`（场景订阅另收复位，`set_enabled_where`）；全局设置只管
    壁纸窗口的订阅（`set_media_enabled`），某张壁纸的预览设置只管主窗口里这张的订阅（`set_preview_enabled`，由
    `set_wpe_preview_settings` 写完调）。重新打开时监视若已在运行（别的订阅开着）就照新订阅补发快照。没有打开的 media 订阅
    时停监视、清快照。

Kabegame 自己的会话不过滤。主窗口预览期间，`usePreviewMediaSession` 在应用页主 frame 把 `navigator.mediaSession` 设成
当前预览项（标题为图片 `displayName`，封面为左上角应用图标）；预览网页壁纸时声音来自 iframe，但垫片不访问 mediaSession，
Chromium 会退回主 frame 的这份。所以预览里放声音时，其它网页壁纸收到的是 Kabegame 自己的会话（图片名 + 应用图标）。

数据源按平台：`audio` 在 Windows 与 macOS，`media` 只在 Windows（`wpe_media::kind_available`，订阅命令据此放行）。`realfft`、`rustfft`
在 Windows 与 macOS 两个依赖段各登记一次，`windows` 的音频 / WinRT feature 只在 Windows 段，都由 `wpe` feature 开启。没有数据源的
订阅命令直接返回错误，垫片忽略，页面收不到对应回调（场景脚本收到 `enabled: false`）。

## 七、已知边界

- **Android / Web 没有 WPE**（`wpe` feature 不开）：不发现、不导入、不渲染，`x-wpe/*` 行只显示作者预览图。
- **macOS / Linux 的限制**：Steam 上装不了 WPE，`libraryfolders.vdf` 通常不含 431960，自动发现大概率为空，主要靠手选文件夹，或用「从 Steam 拉取」把 WPE 下载到 `plugins-data/wpe-import/`（`discover_roots` 把它当作一个 Steam 库，见 [WPE_STEAM.md](WPE_STEAM.md)）。
  场景壁纸依赖 WPE 安装目录的 `assets`，找不到时退回预览图（`assets:missing`）。Linux 的 CEF 未启用 WebGPU 时同样退回（`webgpu:unavailable`）。
  Linux 没有窗口壁纸模式，设为壁纸直接报错；图库预览里壁纸只在 iframe 上收鼠标（拿不到全局光标）。
- **WPE 安装目录**：只有一个，存在设置 `wpeEngineDir`（`wpe::discover::engine_dir`），三个桌面平台通用，场景的 `assets`、`config.json` 与 `ui_` 词条都读它。
  设置为空时先看 Steam 库，再把库里的场景 / 网页壁纸逐张从上一级往上找，判据是 `assets/shaders/common.h`（壁纸自身不算，作者的项目可以自带 `assets`；不能只看 `assets` 目录名，这个目录会放行给场景宿主），找到就写入设置。
  设置里的目录失效时不另找，清空才重新查找；找不到时 `scene_assets_of` 打 warn，场景退回预览图。用户在壁纸设置里覆盖（`set_wpe_engine_dir` 校验同一判据、刷新宿主范围，传空时立即重新查找）。
  用户怎么拿到这些资源见用户文档 `apps/docs/src/content/docs/guide/wallpaper-engine.md`。
- 导入 `video`、`web` 与 `scene`；`application` 只占位并计入跳过。场景壁纸目前只有少数能实时渲染（P1：eagleflag、deep_space、beach），其余在预览、应用背景与桌面显示作者预览图。
- 网页壁纸接收作者默认值与逐壁纸用户值（`applyUserProperties`）及界面语言与帧率（`applyGeneralProperties({ language, fps })`，
  帧率见上「壁纸设置与预览设置」；只是告诉页面，Kabegame 不限网页自己的刷新，WPE 改帧率时会重启网页壁纸的 CEF 进程）；
  `setPaused` 尚未实现。目录内容不监视，下次状态拉取时更新。音频与媒体数据见上「音频与媒体集成」：频谱算法与
  WPE 不同、观感靠调参；封面颜色格式官方未写，暂用 `rgb()`（取值算法 P11c 起同 WPE）；回环会采到 Kabegame 自己的声音（与 WPE 一致）。
- 网页壁纸只能监听四个事件（`wpe-web.json` 的 `allow-listen` 作用域），应用命令只开 `wpe_web_pull_state`、
  `wallpaper_pong` 与 `wpe_web_media_subscribe`。
- 网页壁纸页面里跨源 `http(s)` 请求仍受 CORS 约束（WPE 是全局 `--disable-web-security`，Kabegame 不放开）；
  壁纸样式 / 倍速对网页壁纸不生效；桌面与预览都只注入鼠标移动与左键，无键盘 / 滚轮 / 右键（预览里右键弹应用的菜单），见「鼠标」。
- 图库预览与桌面的网页壁纸 iframe 顶层都是应用页，Chromium 按顶层站点分区存储，两处 `localStorage` / `indexedDB` 是**同一分区、
  互通**，跨重启稳定。iframe 统一之前桌面顶层是 `file://`，那时桌面里存下的页面数据不会带过来。
- 网页壁纸的音量（桌面与预览跟随壁纸音量、应用背景静音）靠垫片接管 `HTMLMediaElement` 与 Web Audio，尽力而为：壁纸里再嵌套的
  iframe 发出的声音、页面经嵌套 frame 拿原始原型绕过接管、shadow DOM 里或 DOM 外只靠 `autoplay` 的元素都管不到（见「音量」）。
- 未带 CEF 补丁 07 的构建会拒绝网页壁纸 iframe 导航并退回作者预览图；`file:` 文档的 worker 不能读取 `file:`。
- 图库媒体走 `file://`（Phase 6b）的真机验证只在 Windows 做；Linux / macOS 待测。Phase 6c 的 `fetch(file:)`、XHR 改动仍待重编 CEF 后真机验证；Windows `DownloadURL` 拖出路线已放弃，由 Phase 6d 的真实文件链路取代（同样待重编 CEF 后真机验证）。
- `wcc_v` 图像滤镜预设（WPE 浏览属性）未实现，忽略。
- 创意工坊取消订阅后目录消失：行仍在，`local_exists` 为 false，图库标记缺失。（文件夹同步目录里的壁纸子目录例外：
  整个目录消失时同步会删行。）
- 目录哈希按文件名的字节比较，不做 Unicode 规范化：会改写文件名规范化形式的文件系统（如 HFS+）上，
  含非 ASCII 文件名的壁纸可能算出与源机器不同的哈希，表现为去重不命中、多落一份。
- 回填作业 `wpe_dir_hash` 跑完之前，存量 WPE 行按目录哈希查不到，下到本机已有的壁纸会多落一份。
- 插件下载的壁纸目录里不允许有符号链接（`relocate` 的源整棵检查），跨文件系统搬运时系统文件（`.DS_Store` 等）不随目录走。
- 虚拟盘、原生壁纸、Plasma 插件模式均看不到 WPE 行（第一阶段）。
- Web 发布版不提供壁纸入口；Android / Web 的 HTTP 文件服务与桌面应用 Web 服务器都没有壁纸目录路由（`/wpe` 已在 Phase 6a 删除）。

## 八、涉及文件

- `src-tauri/kabegame-core/src/wpe/`（discover / recognize / project / properties / user_props / locale / scan / dir_hash）
- `src-tauri/kabegame-core/src/crawler/wpe_import.rs`（`ingest_wpe_dir`、`is_importable_wpe_dir`、`wpe-import` 任务）、
  `crawler/downloader/mod.rs`（后处理目录分支 `postprocess_wpe_dir`、`rebind_deduped_metadata` 跳过 WPE 行）、
  `crawler/downloader/util.rs`（`move_dir_unique` / `copy_dir_unique`）、`crawler/downloader/task_vfs.rs`（`resolve_relocate_source`）、
  `crawler/local_import.rs`、`local_folder/{sync.rs,fs_batch.rs}`、`plugin/builtin.rs`、`task_scheduler/mod.rs`
- 目录哈希回填：`storage/migrations/v051_wpe_dir_hash.rs`、`storage/migrations/backfills/wpe_dir_hash.rs`
- 经 Web 服务器传输：`packages/kabegame-plugin-sdk/src/wpe.ts`（`downloadWpeWallpaper`）、
  `src-crawler-plugins/plugins/kabegame-plugin-kabegame-server/`
- `src-tauri/kabegame-core/src/media/image_type.rs`、`storage/images.rs`、`storage/organize.rs`
- `src-tauri/kabegame/src/http_server.rs`（`/file` 对 WPE 行返回文件清单、对目录内文件流式返回）、`commands/wallpaper.rs`（`WallpaperTarget.webEntry`）、
  `wallpaper/mod.rs`（`web_entry`，`wpe` feature 门控）、`wallpaper/rotator.rs`、`capabilities/wpe-web.json`、
  `tauri.conf.json.handlebars`（CSP `frame-src … file:`）
- 网页壁纸 iframe：`src-tauri/kabegame/src/startup.rs` 与 `wallpaper/manager/window.rs`（`allow_file_documents` +
  `allow_app_local_resources`）、`apps/kabegame/src/components/wallpaper/WpeWallpaperContent.vue`（`startWeb` 赋 `src` /
  `teardownWeb` / `isInitialBlank` / `delegatesPing`）、`Wallpaper.vue`（桌面的层与过渡）、`views/WallpaperWindow.vue`（`acceptTarget`、ping 让给垫片）
- 网页壁纸目录索引：`src-tauri/kabegame/src/wallpaper/wpe_web_dir_index.rs`、`core_init.rs`（建表时机）、
  `kabegame-core/src/storage/images.rs`（`list_wpe_web_rows`）
- `src-tauri/tauri-runtime-kbcef/src/{protocol.rs,ipc.rs}`（`IpcFrame` / `SubframeId`、`IpcResourceRequestHandler`、`ipc_origin`、07 文档头与回退通道占位来源）、`file_access.rs` / `webview.rs` / `subprocess.rs` / `runtime.rs`（两项能力 + 按发起方分档的闸门、
  `classify_file_requester` / `set_file_scope_resolver` / `file_path_key`、`extra_info_keys` 写建窗键、子 frame 桥注入、
  `EvalInSubframe`、`on_frame_destroyed`、鼠标注入）、`third-patches/cef/04-per-browser-file-access.patch`、
  `third-patches/cef/05-app-page-local-resources.patch`、`third-patches/cef/06-app-page-file-subresources.patch`、`third-patches/cef/07-document-url-headers.patch`、
  `third-patches/tauri/18-tauri-frame-scoped-ipc.patch`、`third-patches/tauri/19-tauri-subframe-ipc-injection.patch`
- 图库媒体 `file://`（Phase 6b）：`apps/kabegame/src/utils/fileUrl.ts`（`pathToFileUrl`、`fetch(file:)`）、
  `composables/useImageOperations.ts`（下载 / 复制兜底）、`components/image/ImageContent.vue`（拖出：桌面写 image id、Web 写 `DownloadURL`，见 Phase 6d）、
  `components/common/ImagePluginDescriptionPanel.vue`（opaque origin + `DESCRIPTION_CSP`）、`src-tauri/kabegame/src/http_server.rs`
  （删除 `/proxy`）
- 运行时垫片与宿主协议：`src-tauri/kabegame/src/webview_js/wpe_shim.js`、`commands/wpe_web.rs`（`WpeWebState`、
  `wpe_web_pull_state` / `caller_document`、`remote.urls` 匹配单测）、`capabilities/wpe-web.json`、`permissions/wpe-web.toml`、
  `kabegame-core/src/wpe/properties.rs`（`resolve_web_user_props` / `wpe_language_code`）、
  音频与媒体：`src-tauri/kabegame/src/wpe_media/{mod.rs,spectrum.rs,audio.rs,media.rs,colors.rs}`、`commands/wpe_web.rs`
  （`wpe_web_media_subscribe`）、`lib.rs`（`on_webview_event` / `WindowEvent::Destroyed` 释放）、`commands/settings.rs`
  （`wpeMediaIntegration`）、
  `third-patches/tauri/11-tauri-webview-clear-js-listeners.patch`（看门狗重载时清主 frame 监听）、
  音量：`wpe_shim.js` 的 `installVolume`、`apps/kabegame/src/components/wallpaper/wpeWebVolume.ts`（消息协议）与
  `WpeWallpaperContent.vue` 的 `onWindowMessage` / `postWebVolume`，单测 `wpeWebVolume.test.ts`（node:vm 里跑垫片原文）与
  `WpeWallpaperContent.test.ts`
- 桌面网页壁纸：`src-tauri/kabegame/src/wallpaper/manager/window.rs`（`WALLPAPER_LABELS`）、`wallpaper/window.rs`
  （`WallpaperWindow`：挂载、看门狗）
- 鼠标：
  - 插件 `src-tauri/tauri-plugin-cursor/`（轮询中心、平台探针、`frames.rs` 的登记与点击规则）；
  - `src-tauri/kabegame/src/lib.rs`（注入器与壁纸窗口的点击规则）；
  - `src-tauri/tauri-runtime-kbcef/src/frame_mouse.rs`（钳制与配对）与 `webview.rs` 的 `frame_mouse`；
  - `third-patches/cef/11-frame-mouse-injection.patch`、`third-patches/cef-rs/09-frame-mouse-injection-bindings.patch`；
  - `wpe_shim.js` 的 `setPointerAttached`；
  - `apps/kabegame/src/components/wallpaper/framePointer.ts`、`WallpaperPointerOverlay.vue`（覆盖层）。
- 预览放大：`apps/kabegame/src/composables/usePanzoomPreview.ts`（`startPan` / `endPan`、拖过之后的点击）、`components/wallpaper/WallpaperPointerOverlay.vue`
  （平移规则）、`WallpaperPreviewCanvas.vue`（`zoom` 的 provide、截取区域求交）、`wpeSceneStyle.ts` 的 `sceneDisplayScale`、
  `common/ImagePreviewDialog.vue`（壁纸、视频分支的 Panzoom 层）、`common/VideoControls.vue`（视频的缩放按钮）。
- `apps/kabegame/src/components/collect/WpeLocalPanel.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`、`App.vue`（背景层）、`utils/mediaMime.ts`
- 壁纸窗口 ping 看门狗：`src-tauri/kabegame/src/wallpaper/ping.rs`、`wallpaper/window.rs`（生命周期与重载清理）、
  `commands/window.rs`（`wallpaper_pong`）、`src-tauri/kabegame-core/src/{ipc/events.rs,emitter.rs}`（ping / pong 事件）
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、
  `components/wallpaper/{Wallpaper.vue,targetKind.ts,types.ts,WpeWallpaperContent.vue,WallpaperPreviewCanvas.vue,WpeSceneView.vue,wpeSceneStyle.ts}`
