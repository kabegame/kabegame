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
| `type` | `x-wpe/video` / `x-wpe/web` / `x-wpe/scene` 都已入库；场景壁纸由 `WallpaperStage` 的 scene 层实时渲染，渲染器还不支持的场景显示作者预览图（见 [WPE_SCENE.md](WPE_SCENE.md)） |
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
- 网页壁纸以入口的 `file://` 直接加载（预览与桌面都是 `WallpaperStage` web 层里的 `file:` iframe，见第五、六节），
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
`realfft` 与 `windows` 的音频 / WinRT feature），`kabegame-cli` 的依赖声明。三个桌面平台开启，Android / Web 不开。

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
| 桌面鼠标转发 | 有 | 无 | 无 |
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

「开始收集」菜单新增第四项 **壁纸**（桌面端；Web / Android 隐藏；macOS / Linux 入口仍在，但 `platform_supported` 为 false，
自动发现为空，只剩「添加文件夹」）。对话框 `WallpaperImportDialog`
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
   目录哈希与总字节数，`add_image` → `images-added` → 挂画册 → 挂 WPE 标签。
6. `add_image` 撞 `local_path` 唯一约束（另一个入口抢先写了同一个目录，例如复制进同步目录时文件夹同步先到）→
   回查路径按 `Existing` 处理。其它失败时删掉第 4 步搬过来的目录（与文件下载失败删新建文件一致）。

后处理包装在 `Imported` 时按父目录补挂文件夹画册（`link_into_folder_album`）并挂插件标签，`Existing` 时按
「去重时更新元数据」设置补挂标签并写任务日志（同一目录是 `taskLogWpeExisting`，内容相同的另一个目录是
`taskLogDedupByHash`）。

`move_dir_unique` / `copy_dir_unique`（`downloader/util.rs`）：先试 `rename`；改名不成（典型是跨文件系统）时先复制到
`<目标目录>/.kabegame-part-<uuid>`（`project.json` 最后复制，半成品不会被认成壁纸目录），再改名、删源。复制的文件
集合与目录哈希相同（不带符号链接与系统文件）。本地导入遇到 `.kabegame-part-*` 整棵跳过；它是隐藏目录，文件夹同步
不会为它建子画册。

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
- **网页**：桌面壁纸窗口与图库预览都以 `WallpaperStage` web 层里的 `file:` iframe 加载入口（第六节「网页壁纸 iframe」），
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

壁纸窗口与主窗口加载同一个 `index.html`，URL 为 `index.html?window=wallpaper`（`wallpaper/manager/window.rs`）。
`main.ts` 只做分发：按 `windowKind.ts` 的 `WINDOW_KIND` 动态导入 `bootstrap/app.ts`（主界面，原 `main.ts` 全部内容）
或 `bootstrap/wallpaper.ts`（只装 pinia、i18n、UnoCSS 与主题变量，不装 router / 组件库 / vant，不 `loadAll` 设置）。
Web 发布版与 Android 硬门控为主窗口。

- `views/WallpaperWindow.vue`：壁纸窗口根，负责 init 看门狗（`sessionStorage.wallpaperInitRetry` + reload）、挂载即监听并按 label 应答 `wallpaper-ping`、`setting-change`
  监听、启动时五个 getter 并行、`wallpaper_window_ready` 握手与 dev 调试面板，结果作为 props 交给渲染组件。
- `components/wallpaper/WallpaperStage.vue`：纯渲染组件（不 invoke / listen / 读 store；web 层 iframe 也只是把目标里的
  `webEntry` 赋给 `src`，页面里的垫片自己做 IPC，见「网页壁纸 iframe」「运行时垫片与宿主协议」），base / top 双层、
  prep → enter → commit 过渡（两帧 rAF、1400ms 兜底）、去重与严格串行、tile、base 图退避重试、视频 base / top 元素交换、
  音量 / 倍速 / 循环，以及下表的 WPE 作者属性；铺满父元素，额外支持 `paused` / `interactive`（供后续预览内嵌）。
  DOM 仍按原实现命令式操作（模板 ref 只在挂载时取一次），过渡组合类放在 scoped `<style>`。
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
| 偏移 / 缩放 | 作者 `alignmentx` / `alignmenty` / `alignmentz`（center / free 时作用于 stage） |
| 翻转 / 背景 / 颜色 | 作者 `alignmentfliph` / `schemecolor` / `wec_*` |
| 速率 / 音量 | Kabegame 全局设置（覆盖作者值） |

- `x-wpe/web`：`compatiblePath` 与 `wpeVideo` 为空，`webEntry` 是入口的 `file://`，由 `build_wallpaper_target` 用
  `wallpaper::web_entry` 现算（`read_project` 校验入口在目录内且存在，放 blocking 线程；Android、读不了 `project.json`
  时为 `null`）。图库预览与**桌面壁纸窗口**拿同一份目标，都由 `WallpaperStage` 的独立 **web 层**建一个 iframe、直接赋
  `src = webEntry`（见下「网页壁纸 iframe」）；`webEntry` 为空时报「无法加载网页壁纸」，预览退回作者预览图、桌面保持原画面。
- `x-wpe/scene`：`sceneAssets` 是 WPE 安装目录的 `assets`，`previewPath` 是退回用的作者预览图（行的 `thumbnail_path`，缩略图为空或
  回落成目录本身时不填），其它类型两者都为空。`WallpaperStage` 的 **scene 层**挂 `WpeSceneView` 编译渲染；loading → live / fallback 的
  状态流转、超时与过渡见 [WPE_SCENE.md](WPE_SCENE.md)「接入 `WallpaperStage`」。

不生成任何按屏幕分辨率缩放的壁纸副本（WPE 也不做），不复刻 WPE 的解码后端选择。

### 网页壁纸 iframe

WPE 让每个网页壁纸跑在自己的浏览器进程里，页面以 `file://` 从壁纸目录直接加载，靠关掉同源策略读同目录文件。Kabegame 在
两个地方显示网页壁纸，**都是 `WallpaperStage` web 层里的 `file:` iframe**，组件与代码路径同一套：图库预览在主窗口（`main`），
桌面在壁纸窗口（`wallpaper`）。tauri 补丁 18 / 19 之前，子 frame 没有 IPC，预览 iframe 只能 `postMessage` 请主窗口代办、
桌面则把整个壁纸窗口导航到 `file://`；现在 frame 是 IPC 的基本单位，两种宿主合成一种（见 [ACL 文档](../tauri/TAURI_ACL_PERMISSION_SYSTEM.md)「子 frame IPC」）。

- **加载**：`WallpaperStage` 建 iframe、插入 DOM 后直接 `frame.src = target.webEntry`，没有命令往返、没有要维护的状态
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
- **前端时序**（`WallpaperStage`）：`createWebFrame(entry)`：没有入口直接抛「无法加载网页壁纸」（Web 版、Android
  都走这条，`ImageContent` 退回作者预览图）；否则建 iframe、插入 DOM、赋 `src`。`load` 时 `isInitialBlank`（仍可读且是
  `about:blank`）的初始空文档忽略；仍可读却不是初始文档（例如浏览器侧缺授权时改写出的 `about:blank#blocked`）记
  `wpe web entry blocked: <href>`；读 `location` 抛错（已是跨源 `file:` 页面）才算加载完成。8s 超时仍停在初始 `about:blank`
  记 `wpe web entry not navigated (CEF patch 05/07 missing?)`，否则记 `wpe web entry load timeout`。切换壁纸一律
  `teardownWeb`（先 `about:blank` 再移除，frame 销毁）后重建 iframe，不在原 iframe 上改 `src`：闸门把「原 iframe 的 `file:`
  文档发起的导航」算作这个文档发起，跨到另一张壁纸会被拒。
- **CSP**：`tauri.conf.json.handlebars` 的 `frame-src 'self' blob: data: about: file:`（生成的 `tauri.conf.json` 被 gitignore）。
- **IPC**：CEF 给每个子 frame 注入桥；CEF 补丁 07 在建子资源工厂时捕获文档 URL 与父文档 URL，运行时按 initiator 与完整文档 URL 合成 `Origin`。`file:` iframe 只匹配绑定 `main` / `wallpaper` 且 `frames: "sub"` 的 `wpe-web-capability`。回退通道来源不合法时用占位来源交给 ACL 拒绝。历史上按 `frame.url()` 读取会遇到首批请求竞态。
- **事件只投递到这个 iframe**：监听登记在调用方 frame 的表里，投递 eval 进这个 frame；iframe 销毁时 runtime 报
  `SubframeDestroyed`，Tauri 删掉它的全部监听，切换壁纸不会积累监听，也不再需要按导航调 `clear_js_listeners()`。
- **`localStorage`**：Chromium 按顶层站点分区存储，预览与桌面的顶层都是应用页，所以两处是**同一分区、互通**。以前桌面顶层是
  `file://`，那时桌面里存下的页面数据不会带过来。
- **触发点**：图库预览随预览打开 / 切图；桌面随 `WallpaperWindow.vue` 收到的当前壁纸目标（`setting-change` 的
  `currentWallpaperImageId` → `get_current_wallpaper_target`）。后端 `WindowWallpaperManager::set_wallpaper_path` 不再导航，只按
  `web_entry(path).is_some()` 开关 Windows 的桌面鼠标转发（`WallpaperWindow::set_mouse_forwarding`，见下）；设壁纸、轮播、
  启动恢复、切换到窗口模式、重新开启壁纸、改样式都会走到它。
- **过渡**：桌面与预览一样，图片 / 视频与网页壁纸之间走 web 层的淡入淡出；壁纸样式、倍速对页面不生效。
- **音量**：桌面与预览按设置里的壁纸音量出声，应用背景静音；由垫片接管页面的出声路径，见下「运行时垫片与宿主协议」的「音量」。

### ping 看门狗

`wallpaper/ping.rs` 的 `Pinger` 随 `WallpaperWindow` 持有，在 `mount()` 挂载、显示完成后启动；丢弃对象时
reset 通道关闭，任务退出。后端用 sleep 循环每 10s 探测，页面收到事件才应答、不自己计时：窗口被遮挡变成 hidden
时页面定时器会被 Chromium 节流，页面心跳容易误报。sleep 不补发错过的 tick，系统睡眠唤醒后最多多算一次未应答。

往返使用两个全局事件种类：默认种类 `wallpaper-ping { label, seq }` 经 `GlobalEmitter` 广播、主事件循环 `app.emit`
送到窗口；应用页 `WallpaperWindow.vue` 与网页壁纸 iframe 里的垫片都 `listen`，只应答 label 等于自己窗口的事件，再调用
`wallpaper_pong(seq)`。**网页壁纸显示期间应用页不应答**（`WallpaperStage.isShowingWeb()`，iframe 存在即算，含加载中），交给
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
  它的 Vue 页同样显示图片 / 视频；窗口壁纸模式只有 Windows / macOS）登记；`allow_file_documents`（04）只为 WPE，同样两个窗口都登记。
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
- **重拉触发**：`setting-change` 带 `language`（界面语言变了）；`image-changed` / `images-change` 里有**本张**图片
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
- **监听随 frame 清理**：监听按「webview → frame → 事件」登记，iframe 销毁时 runtime 报 `SubframeDestroyed`，Tauri 删掉该
  frame 的全部监听。同一 frame 内重新导航后旧条目还在、投递进新文档时找不到 id 等于空操作，直到 frame 销毁；`WallpaperStage`
  每次切换都销毁重建 iframe，不会积累。补丁 11 的 `clear_js_listeners()` 只剩看门狗整页重载时调用。
- **可见事件**：网页壁纸只能监听 `wpe-web.json` 作用域里的四个事件（`wallpaper-ping`、`setting-change`、`image-changed`、
  `images-change`，tauri 补丁 15），其它事件名（如 `images-added`）`listen` 被 ACL 拒绝；垫片新增监听要同步改 capability。
  命令层只开拉取状态与 ping 应答两个命令。
- **不做**（后续 Phase）：暂停冻结与 `setPaused`、`fps`；音频与媒体数据（Phase 8，数据回程沿用 `listen`）；Web 发布版 /
  Android / macOS / Linux 不渲染网页壁纸。
- **待真机确认**（Windows）：iframe 统一后的整条链路见 `versions/latest/regression.md`「frame 级 IPC（tauri 补丁 18–19）」。

#### 音量

网页壁纸的声音由垫片按**宿主音量**缩放：页面的生效音量 = 页面自己设的音量 × 宿主音量。宿主音量不走 IPC，经
`postMessage` 从父页面（`WallpaperStage`）拿：它本来就有 `volume` prop，桌面与预览是设置里的 `wallpaperVolume`，应用背景是 0，
不必新增命令。不用 CEF 的 `SetAudioMuted`（整个 browser 静音，会连主窗口的预览视频一起静掉）；Chromium 也没有逐 iframe 的
静音 / 音量接口。

- **消息**：类型与字段集中在 `components/wallpaper/wpeWebVolume.ts`；垫片是不经打包的纯脚本，按同样的字面量另写一份，
  `wpeWebVolume.test.ts` 读垫片原文、用这里的常量跑一遍，两边不一致就失败。

  | 方向 | 消息 | 时机 |
  | --- | --- | --- |
  | 垫片 → 父页面 | `{ type: "kabegame:wpe-volume-request" }` | 垫片启动时发一次 |
  | 父页面 → 垫片 | `{ type: "kabegame:wpe-volume", volume }`，`volume` 为 0…1 | 回复请求；`volume` / `paused` 变化时主动推 |

- **父页面怎么答**：`WallpaperStage` 挂载时（先于任何 iframe）在 `window` 上监听 `message`，只理会
  `event.source === 当前 web iframe 的 contentWindow` 的请求，回 `webHostVolume(volume, paused)`：`paused`（web 层被隐藏、
  脚本仍在跑）时为 0，否则是 `volume` prop 钳到 0…1。主窗口里应用背景与预览各有一个 Stage，各答各的 iframe；换壁纸重建
  iframe 后旧 iframe 不再是当前的，新页面的请求照常回复。`volume` / `paused` 变化时把同一条消息推给当前 iframe（还停在初始
  `about:blank` 时也照发，那份文档没有垫片、收下即丢，页面起来后垫片会自己再要）。`targetOrigin` 为 `*`：对方是跨源 `file:`，
  消息里只有一个数。数据来源：桌面 `WallpaperWindow.vue` 的 `state.volume`（`get_wallpaper_volume` + `setting-change`）、预览
  `WpeWallpaperContent` 的 `wallpaperVolume`；应用背景由 `ImageContent` 的 `video-muted` 传到 `WpeWallpaperContent` 的 `muted`，
  `volume` 为 0。
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

iframe 里的右键到不了父页面（DOM 事件不跨 frame），预览的上下文菜单靠垫片转发。工具条是父页面里一条常驻热区唤出的，右键菜单
不能照做：热区要盖住整块页面，页面就收不到指针了。场景宿主也加载这份垫片，网页与场景同一条路。

- **消息**：`{ type: "kabegame:wpe-contextmenu", x, y }`，垫片 → 父页面，`x` / `y` 是 iframe 视口里的 CSS 像素。字面量集中在
  `components/wallpaper/wpeContextMenu.ts`，`wpeWebVolume.test.ts` 读垫片原文核对。
- **垫片**：在 `window` 捕获阶段、页面脚本之前登记 `contextmenu` 监听，只转发 `isTrusted` 的事件；页面取消右键或停止冒泡也照发
  （菜单是应用的功能，和工具条一样总能用）。原生菜单 CEF 已全局关掉（`DisabledContextMenuHandler`），不必 `preventDefault`。
- **父页面**：网页层由 `WallpaperStage`、场景层由 `WpeSceneView` 收，只认 `isTrusted` 且 `source` 是自己当前 iframe 的消息，
  按 iframe 的显示矩形换算到本页面视口（预览画布带 CSS `scale`：坐标 × 显示矩形 ÷ 布局尺寸 + 左上角），经
  `WpeWallpaperContent` → `ImageContent` 的 `wallpaperContextmenu` 交给预览弹窗，在那个位置弹出与右键容器同一份菜单。应用背景
  不接收指针、桌面窗口不转发右键，都不会触发。
- **覆盖不到**：页面里再嵌的 iframe 没有垫片；页面脚本自己也能发这条消息，最多就是弹出菜单，不能代用户点菜单项。

### 桌面鼠标转发（Windows）

`wallpaper/input_forward.rs`：照 WPE 的做法不装鼠标钩子，由后台线程每 16ms 轮询 `GetCursorPos` 与
`GetAsyncKeyState(VK_LBUTTON)`，只在「窗口模式 + 当前是网页壁纸」运行：`set_wallpaper_path` 按 `web_entry` 调
`WallpaperWindow::set_mouse_forwarding(true / false)` 启停（幂等），窗口对象丢弃时由 `InputForwarder` 的 `Drop` 停止。注入落到
窗口里的 web 层 iframe，所以壁纸窗口给 `WallpaperStage` 传 `interactive`，iframe 接收指针事件。

- 光标在壁纸窗口客户区内：`ScreenToClient` 得物理坐标，除以 `GetDpiForWindow / 96` 得视图坐标，坐标变化就经
  `tauri_runtime_kbcef::inject_mouse` 注入 `Move`（不带按键标志，与 WE 一致：带左键会让页面图片拖动启动 OLE 拖放并挂住 UI 线程）；离开客户区时注入一次 `Leave`。
- 左键按下沿：光标在客户区内，且 `WindowFromPoint` 命中窗口的根窗口（`GetAncestor(GA_ROOT)`）类名是 `Progman` /
  `WorkerW`（桌面图标层或壁纸层本身，即点在桌面空白处或图标上）才注入 `LeftDown`；抬起沿只要按下被转发过就注入
  `LeftUp`，停止转发时也会补发，保证成对。点在别的应用窗口上不转发。
- 设置「暂停壁纸」（`wallpaperPaused`）打开时不转发：线程照跑，每轮读设置，暂停期间什么都不注入；进入暂停时补一次
  `Leave` 与未配对的 `LeftUp`，页面不会停在悬停 / 按住状态。按键状态照常跟踪，恢复时左键还按着不会被当成新的按下。
- 不拦截、不吞掉任何输入：Explorer 照常收到点击（桌面图标选中状态会变，与 WPE 一致）。
- 注入走 `CefBrowserHost::SendMouse*Event`，直接进 Chromium 输入管线，不依赖窗口焦点与 Z 序；只投递不等回执。
- 不做：键盘、滚轮、右键、设置开关；macOS / Linux 不转发。

### web 层（`WallpaperStage`）

- 对 `type === "x-wpe/web"` 的目标，在 base / top 双层之上命令式创建一个 **`file:` iframe**（插入后直接赋
  `src = webEntry`，见上「网页壁纸 iframe」），与应用前端不同源，拿不到父页面 DOM；IPC 来自 CEF 注入的子 frame 桥，权限只有
  `wpe-web-capability`。`webEntry` 为空（Android 等）时不建 iframe、报「无法加载网页壁纸」。
  `sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms"`（不给 top-navigation / popups / modals /
  downloads）、`allow="autoplay; fullscreen"`、`referrerpolicy="no-referrer"`。
- **不参与 base / top 双层过渡**：一次只存在一个 iframe。切入时等页面 `load`（8s 无 load 记 `wpe web entry load timeout`，
  仍停在初始 `about:blank` 时记 `wpe web entry not navigated (CEF patch 05/07 missing?)`，都不销毁）后整层淡入（none 直接显示；fade / slide / zoom 用与媒体层相同的曲线）盖住媒体层，淡入完成再清空媒体层；
  切走时新媒体先按「首帧直设」放到 base，web 层淡出后 **销毁** iframe（先 `about:blank` 再移除），让渲染进程回收；
  web → web 先淡出销毁旧页面再加载新页面。target 置 null、组件卸载时立即销毁；frame 销毁后它的监听随 `SubframeDestroyed` 清掉。
- `paused` 对 web 层只做 `visibility: hidden`（省合成，不冻结脚本；冻结留给后续垫片），页面音量随之按 0；`interactive` 决定 iframe 的
  `pointer-events`（预览与桌面壁纸窗口都传，桌面靠它接收注入的鼠标；应用背景不传）；`volume` 经 `postMessage` 交给垫片（见上
  「音量」）；`styleMode` / `playbackRate` 对页面无意义，WPE 视频的 stage 样式也不作用于它。
- `ready` 在 iframe `load` 时发；调试快照 `media` 为 `"web"`；对外暴露 `isShowingWeb()`（壁纸窗口据此把 ping 交给垫片）。

### scene 层（`WallpaperStage`）

`x-wpe/scene` 走 web 层之上的独立 scene 层（z-index 3），一次只挂一个 `WpeSceneView`，切走即卸载。结果出来前不显示、不发 `ready`
（桌面保留上一张壁纸），能渲染就直接淡入实时画面，不能渲染或 10s 超时才显示 `previewPath` 预览图；壁纸样式由宿主铺放（留白是 `schemecolor`，见 [WPE_SCENE.md](WPE_SCENE.md)「样式」「留白颜色」），
`paused` / `interactive` 透传，ping 仍由应用页应答。细节见 [WPE_SCENE.md](WPE_SCENE.md)「接入 `WallpaperStage`」。

### 图库接入

- `ImageContent` 新增 `wallpaper` 形态：**网页与场景** WPE 行（`isWpeWallpaperContentType`）在
  `prefer="original"` 时交给 `components/wallpaper/WpeWallpaperContent.vue`（按 id 调 `get_wallpaper_target_for_image`，
  样式 / 过渡 / 音量 / 倍速跟随壁纸设置，渲染 `WallpaperStage`），缩略形态仍是作者 `preview.*`；该形态不构建缩略 / 原图链，
  丢失态只看 `localExists === false` 或目标取不到（页面加载超时、场景退回都不算丢失）。场景在出结果（首帧，或退回后预览图加载完）前
  不发 `ready`，加载态一直保持。`x-wpe/video` 不走这里，仍是 `<video>` 链。
  Android 上目标的 `webEntry` 为空：`WallpaperStage` 报非致命错误，`ImageContent` 只结束加载态，原图形态的画布留空
  （网格本来就用作者预览图）。
- 网格（`ImageItem`）对所有 WPE 行固定用缩略形态，不悬停加载原图形态；角标「WPE · 视频」/「WPE · 网页」。
- 预览弹窗对非视频 WPE 行渲染 `components/wallpaper/WallpaperPreviewCanvas.vue`：给一块固定尺寸的画布，整体
  `scale` 进可用区域并居中，没有背景，和单独的图片一样显示。尺寸取图片行的 `width` / `height`（场景入库时写的分辨率）；
  网页壁纸没有固有尺寸，透视场景读不到，这时按主显示器逻辑分辨率（`primaryMonitor()`
  的 `size / scaleFactor`，失败回退 `window.screen`，模块级缓存），页面按这个尺寸排版。可交互，不走 Panzoom（页面要收指针）、
  不挂 `VideoControls`，控制条只保留全屏。
- 应用背景层不按类型分支：与预览同走 `ImageContent` 原图形态（`prefer="original"`），网页与场景壁纸都实时渲染、不交互。
  **背景静音**：`video-muted` 经 `WpeWallpaperContent` 的 `muted` 让 `WallpaperStage` 的 `volume` 为 0，网页壁纸页面的声音由垫片
  按 0 缩放（见上「音量」），开着应用背景时只有桌面出声。

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

预览右栏和设置页「当前壁纸」对网页与场景壁纸都可打开属性面板（场景与网页同一格式，后端 `has_user_properties`；面板对场景隐藏 `file` / `directory`，渲染器不读用户选的文件，放行也只对网页壁纸目录生效）。面板本地草稿立即改变显示条件，300ms 防抖后串行提交；同张图片的 `metadataId` 补丁和界面语言变化触发重读。条件由受限解释器处理字面量、运算、三元、数组、`<key>.value` 及五个字符串 / 数组方法；不认识的条件默认显示，不执行任意脚本。属性说明和标签经 HTML 白名单净化。

`file` 与 `directory` 仅使用用户所选路径；无作者默认值时清空路径会删除该用户键，垫片向页面补发空路径以撤销旧值。core 生成文件 / 目录放行项（`user_file_grants`），网页壁纸目录索引按这张壁纸当前的 metadata **覆盖**它的放行（`metadataId` 补丁到达时、`wpe_web_pull_state` 返回前各写一次，见上「网页壁纸目录索引」）：改了目录属性，旧目录立即不可读；另一张网页壁纸读不到这张的用户选择。预览与桌面共用这套闸门。目录属性递归列举浏览器安全的媒体文件，最多 10000 个；垫片对 `fetchall` 发送文件增删回调，对 `ondemand` 随机返回一个文件。

### 封面

WPE 行的 `thumbnail_path` 默认是作者目录里的 `preview.*`，场景的退回画面（`previewPath`）也取它。预览的右键菜单与底部工具条有「设为壁纸封面」：`capture_wallpaper_cover(imageId, region)` 截主窗口，按 `region`（画布占窗口内容区的比例）裁出画布，缩到最长边不超过 1920，写进 `thumbnails_dir`，再经 `replace_image_thumbnail_path` 换行并发 `thumbnailPath` 补丁。暂停时截到的就是停住的那一帧。「恢复默认封面」在预览详情栏的属性面板里（`restorableCover`）；设置页的属性弹窗没有封面按钮。

- **预览专属的菜单项**（`actions/imageActions.ts`）：「暂停」（排第一）、「设为壁纸封面」「清空脚本存储」（只场景）只在 `ImageActionContext.wallpaperPreview` 存在时显示，它由 `ImagePreviewDialog` 在桌面预览网页与场景壁纸时给出（`live` / `paused` / `coverBusy`）；画廊的右键菜单不带它，所以没有这几项。工具条照常平铺菜单的可见项。这几条命令由弹窗的 `handleWallpaperCommand` 处理，不发 `contextCommand`，网格不需要知道画面出没出来。
- **截整窗再裁，不用 CDP 的 `clip`**：`clip` 靠临时改视口实现，这次改动画在屏幕正在显示的表面上，整个窗口跳变约 150 ms，`scale: 1` 也一样；宿主和页面收不到尺寸事件，只看 `stats()` 发现不了。代价是封面分辨率等于画布的屏幕像素（窗口 1200 CSS 宽、缩放 150% 时约 1071 宽）。对 iframe target 截图也不行，Chromium 只认顶层（`Command can only be executed on top-level targets`）。
- **画面确定实时渲染之前，暂停与设为壁纸封面置灰**：场景看 `WallpaperStage` 的 `sceneLive`（出了首帧才为真，退回预览图时为假），网页壁纸看 `ready`，即弹窗的 `previewRendering`，经 `wallpaperPreview.live` 交给菜单项。`ready` 在退回时也发，不能用来判断。后端不记实时状态，也不校验。恢复不受影响：退回预览图的场景也能恢复；属性面板的 `customCover` 跟着 `thumbnailPath` 补丁重读，从菜单设的封面也会让恢复按钮出现。`ImageContent` 的壁纸形态只按图片 id 重置加载态：换封面改的 `thumbnailPath` 不能让它重新等 ready（壁纸组件同一目标只发一次，骨架会一直盖在网页层上）。
- **截图前的等待**（`WallpaperPreviewCanvas.withCaptureRegion`）：盖在画布上的 UI 会截进去，先在 `<html>` 加 `data-kb-cover-capture` 隐藏看板娘与预览容器里除壁纸画布外的全部元素（工具条、箭头、抽屉开关：从工具条或右键菜单点时它们正显示着；右键菜单是 `v-if`，命令发出时已经移除），`finally` 里恢复；壁纸层出画面后还要淡入，这时截到的是黑底，所以再等画布里的 `CSSTransition` 结束（只等过渡：页面里可能有循环动画）。窗口被完全遮挡时 `visibilityState` 不是 `visible`，矩形即使量得出来，截到的也是残缺的画面，所以报错不截。
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

有 `audio` 订阅才开采集线程，有 `media` 订阅且设置「媒体集成」（`wpeMediaIntegration`，默认开，仅 Windows 有开关）打开
才开媒体会话监视；最后一个订阅离开即停（`info!` 记启停，增删订阅 `debug!` 记 label / frame / 类型 / 订阅数）。停止线程
（丢弃句柄会 join）一律在订阅表的锁外，采集线程自己触发的停止不 join 自己。

- **音频**（`wpe_media/audio.rs` + `spectrum.rs`）：WASAPI 共享模式回环读默认输出设备（`eRender` / `eConsole`）的混音，
  每 10ms 读包、每 33ms 出一帧 128 个浮点（左 0–63、右 64–127，低频在前）。推送定时器与采集包解耦：静音标志的包或这段时间
  没有包（系统静音时回环不送包）都按静音补零，页面收到逐帧衰减到 0 的数据，「空闲」判断才生效；打不开设备也照样推静音帧。
  默认设备每秒比对 id、`AUDCLNT_E_DEVICE_INVALIDATED` 立即重开。只处理 32 位浮点与 16 位整数混音格式。
  频谱算法自定（WPE 未公开）：Hann 窗 → 2048 点实数 FFT（`realfft`）→ 64 个对数频段（30 Hz – 16 kHz，不超过奈奎斯特的
  95%）取段内峰值 → dB + 高频补偿（相对 1 kHz 每倍频程 +3 dB）→ `(dB − (−70)) / 60` 映射、上限 1.2 → 上升即时、下降每帧
  保留 0.75。常数集中在 `SpectrumTuning`，真机按样本调。
- **媒体**（`wpe_media/media.rs` + `colors.rs`）：专用线程持有 SMTC 管理器与当前会话，WinRT 事件只发信号，读取与比较在
  线程里做，变化才推：`Properties`（标题、艺人、副标题、专辑、专辑艺人、逗号拼接的流派、`music` / `video` / `image`）、
  `Thumbnail`（封面字节哈希变了才解码，长边缩到 512 的 PNG data URL；五个颜色由 64×64 缩图的量化直方图取三个主色，文字色取
  对比度 ≥ 4.5 的次色 / 第三色否则黑白，高对比色取黑白里对比更高的，格式 `rgb(r, g, b)`）、`Playback`（Playing 1、Paused 2、
  其余 0）、`Timeline`（秒；播放中每秒按 `LastUpdatedTime` 外推；播放状态切换时不重读时间轴，按旧状态外推的位置作新基准，
  因为很多播放器的读数停在上次跳转；播放器不给时间轴就不推）。没有会话时推 `Playback 0` 与空属性、
  空封面。新订阅先收 `Status { enabled }`，监视在运行时再补发快照；关「媒体集成」推 `{ enabled: false }` 并停监视、清快照。

Kabegame 自己的会话不过滤。主窗口预览期间，`usePreviewMediaSession` 在应用页主 frame 把 `navigator.mediaSession` 设成
当前预览项（标题为图片 `displayName`，封面为左上角应用图标）；预览网页壁纸时声音来自 iframe，但垫片不访问 mediaSession，
Chromium 会退回主 frame 的这份。所以预览里放声音时，其它网页壁纸收到的是 Kabegame 自己的会话（图片名 + 应用图标）。

只有 Windows 有数据源（`realfft` 与 `windows` 的音频 / WinRT feature 只在 Windows 依赖段，并由 `wpe` feature 开启），macOS / Linux 的订阅命令直接返回错误，垫片忽略，页面收不到音频与媒体回调。

## 七、已知边界

- **Android / Web 没有 WPE**（`wpe` feature 不开）：不发现、不导入、不渲染，`x-wpe/*` 行只显示作者预览图。
- **macOS / Linux 的限制**：Steam 上装不了 WPE，`libraryfolders.vdf` 通常不含 431960，自动发现大概率为空，主要靠手选文件夹。
  场景壁纸依赖 WPE 安装目录的 `assets`，找不到时退回预览图（`assets:missing`）。Linux 的 CEF 未启用 WebGPU 时同样退回（`webgpu:unavailable`）。
  macOS 窗口壁纸没有鼠标转发，网页壁纸在桌面上不可交互。Linux 没有窗口壁纸模式，设为壁纸直接报错。
- **WPE 安装目录**：只有一个，存在设置 `wpeEngineDir`（`wpe::discover::engine_dir`），三个桌面平台通用，场景的 `assets`、`config.json` 与 `ui_` 词条都读它。
  设置为空时先看 Steam 库，再把库里的场景 / 网页壁纸逐张从上一级往上找，判据是 `assets/shaders/common.h`（壁纸自身不算，作者的项目可以自带 `assets`；不能只看 `assets` 目录名，这个目录会放行给场景宿主），找到就写入设置。
  设置里的目录失效时不另找，清空才重新查找；找不到时 `scene_assets_of` 打 warn，场景退回预览图。用户在壁纸设置里覆盖（`set_wpe_engine_dir` 校验同一判据、刷新宿主范围，传空时立即重新查找）。
  用户怎么拿到这些资源见用户文档 `apps/docs/src/content/docs/guide/wallpaper-engine.md`。
- 导入 `video`、`web` 与 `scene`；`application` 只占位并计入跳过。场景壁纸目前只有少数能实时渲染（P1：eagleflag、deep_space、beach），其余在预览、应用背景与桌面显示作者预览图。
- 网页壁纸接收作者默认值与逐壁纸用户值（`applyUserProperties`）及界面语言（`applyGeneralProperties({ language })`）；
  `fps`、`setPaused` 尚未实现。目录内容不监视，下次状态拉取时更新。音频与媒体数据见上「音频与媒体集成」：频谱算法与
  WPE 不同、观感靠调参；封面颜色格式官方未写，暂用 `rgb()`；回环会采到 Kabegame 自己的声音（与 WPE 一致）。
- 网页壁纸只能监听四个事件（`wpe-web.json` 的 `allow-listen` 作用域），应用命令只开 `wpe_web_pull_state`、
  `wallpaper_pong` 与 `wpe_web_media_subscribe`。
- 网页壁纸页面里跨源 `http(s)` 请求仍受 CORS 约束（WPE 是全局 `--disable-web-security`，Kabegame 不放开）；
  壁纸样式 / 倍速对网页壁纸不生效；桌面只转发鼠标移动与左键（Windows），无键盘 / 滚轮 / 右键。
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
  `allow_app_local_resources`）、`apps/kabegame/src/components/wallpaper/WallpaperStage.vue`（`createWebFrame` 赋 `src` /
  `teardownWeb` / `isInitialBlank` / `isShowingWeb`）、`views/WallpaperWindow.vue`（`acceptTarget`、ping 让给垫片）
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
  `WallpaperStage.vue` 的 `onWindowMessage` / `postWebVolume`，单测 `wpeWebVolume.test.ts`（node:vm 里跑垫片原文）与
  `WallpaperStage.webVolume.test.ts`
- 桌面网页壁纸：`src-tauri/kabegame/src/wallpaper/manager/window.rs`（`set_wallpaper_path` 开关鼠标转发、`WALLPAPER_LABEL`）、
  `wallpaper/window.rs`（`WallpaperWindow`：`set_mouse_forwarding`、看门狗）、`wallpaper/input_forward.rs`
- `apps/kabegame/src/components/WallpaperImportDialog.vue`、`image/ImageContent.vue`、
  `image/ImageItem.vue`、`common/ImagePreviewDialog.vue`、`App.vue`（背景层）、`utils/mediaMime.ts`
- 壁纸窗口 ping 看门狗：`src-tauri/kabegame/src/wallpaper/ping.rs`、`wallpaper/window.rs`（生命周期与重载清理）、
  `commands/window.rs`（`wallpaper_pong`）、`src-tauri/kabegame-core/src/{ipc/events.rs,emitter.rs}`（ping / pong 事件）
- 壁纸窗口：`src-tauri/kabegame/src/wallpaper/manager/window.rs`、`apps/kabegame/src/main.ts`、`windowKind.ts`、
  `bootstrap/{app,wallpaper}.ts`、`views/WallpaperWindow.vue`、
  `components/wallpaper/{WallpaperStage.vue,targetKind.ts,types.ts,WpeWallpaperContent.vue,WallpaperPreviewCanvas.vue,WpeSceneView.vue,wpeSceneStyle.ts}`
