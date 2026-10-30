# v4.7.0 changelog

## 用户侧

### Added
- 新增应用日志：运行日志分级并按天保存到数据目录下的 `logs` 文件夹（保留 14 天），工具箱新增「查看日志」，可按级别、前端 / 后端、模块和关键字筛选，实时滚动，支持复制与打开日志目录。Web 版仅 super 模式可用。
- 新增「壁纸」收集入口：自动发现本机 Wallpaper Engine 壁纸（Steam 创意工坊订阅、官方默认、我的项目），也可手动添加任意壁纸目录或 Steam 库；第一阶段把 `video` 型壁纸原地引用入库，使用作者自带的 `preview.gif` / `preview.jpg` 作为图库预览，不复制、不转码用户目录。
- 「壁纸」导入支持 Wallpaper Engine 网页壁纸：原地引用壁纸目录；预览以主屏比例的「桌面画布」运行页面并可交互，也可在窗口模式设为桌面壁纸（暂不支持 WPE 属性、`file` / `directory` 类属性，应用背景显示作者预览图）。
- 桌面网页壁纸改为像 Wallpaper Engine 一样以 `file://` 直接加载壁纸目录：依赖读取同目录数据文件的壁纸（如歌单、字幕类）现在能完整运行；文件访问只对壁纸窗口开启，且只能读当前壁纸目录内的文件。Windows 上桌面的鼠标移动与左键点击会转发给网页壁纸（不拦截桌面本身的点击，桌面框选不受影响）。预览网页壁纸时，鼠标移到画布左右边缘中段即可唤出切换箭头。预览网页壁纸时右键菜单无法弹出（右键会被壁纸页面接收），菜单里的操作改为按原顺序排在底部工具条里。

### Optimized
- Windows 安装程序在最后阶段不再一个接一个地闪出大量黑色命令行窗口：搬运 CEF 运行时、DLL 与设置目录图标属性改用安装程序内置指令完成。
- 桌面端界面卡死后的自动恢复更快：页面无响应约 6 秒（原约 16 秒）即自动重新加载。

### Changed
- 壁纸轮播改为按一条视图路径依次切换：在画廊、画册、任务或畅游详情的过滤栏 ⋯ 菜单点「用当前视图轮播」，当前的过滤与排序就是轮播来源；设置页只显示当前轮播路径，原来的「选择画册 / 包含子画册 / 随机或顺序」三项去掉（随机即随机排序视图）。每次切换都从当前壁纸在视图里的下一张接着走，视图里的图片增删、排序变化不会让轮播跳张或重复；当前壁纸不在视图里时按保存的轮播位置继续，停止再开启、重启应用也接着上次；换视图会立刻切到新视图的第一张；原生壁纸模式只轮播图片，切换壁纸模式后从当前壁纸的下一张继续。旧设置升级时自动换算成对应路径。
- 图片详情的「基本信息」改为卡片式排版：名称作标题，源与收藏时间并在一行，类型、大小、尺寸做成可点筛选的芯片，宽高比画成与图片同比例的矩形框；URL 与本地路径各占一行，省略显示并带复制按钮，整体高度明显降低。
- Web 版（demo.kabegame.com）首屏打开明显变快：脚本、样式和插画改从 CDN 加载并自动压缩，不再挤占服务器那点带宽；吉祥物、空状态等插画在 Web 版换成按显示尺寸压缩的 WebP（合计 8.2 MB → 244 KB），桌面与 Android 仍用原图。
- 启动时主窗口立即出现：数据库升级等耗时初始化改在后台进行，期间窗口显示启动页与进度（升级需要先补算数据时显示进度条），完成后自动进入主界面；初始化失败会在启动页显示错误并可直接退出。其余数据补算在进入界面后于后台继续，可在「我正在忙这些」里看到进度，中途退出下次启动接着做。

### Fixed
- Windows 窗口壁纸改挂到桌面背景 WorkerW，移除点击桌面和最小化时反复修正图标层 Z-order 的逻辑。
- Android 平板 / 横屏宽屏布局的侧栏、主内容区与弹窗不再被状态栏、底部导航栏遮挡；平板上的弹窗与桌面一样限高、只在内容区滚动，底部按钮始终可见。
- Android 平板（宽度超过紧凑断点）打开图片预览后左右滑动不再停在原图，能正常切换上一张 / 下一张；滑动过后按一次返回即可关闭预览，不再先被背后的多选状态吃掉。
- Android 吉祥物亀ちゃん不再被底部导航栏挡住脚部，拖动范围也限制在系统栏之内。
- Android 预览图片视频滑动后不暂停播放的问题
- 修复下载时偶发「UNIQUE constraint failed: images.local_path」：同一帖子多张同名图片并发下载不再互相覆盖、丢图，会依次存成 `name.jpg`、`name(1).jpg`……；下载目录同时是文件夹画册时，新下载的图片也会立刻进入该画册，不再与文件夹同步抢着入库。

## 插件开发侧

### Added
- `kabegame-cli plugin run` 新增 `--freeze-template`：把本次运行插件的 `description.ejs` 冻结进每行 metadata（新列 `metadata.template`），详情面板优先用它渲染。`--id` 测试 id 没有安装，过去它下载的图片只能看原始键值，现在也能直接在应用里调试模板。插件模板与冻结模板并行获取，冻结模板非空时覆盖插件模板。

## 开发侧

### Added
- 日志框架改用 `tracing`：`kabegame_core::logging` 装配全进程唯一订阅器（控制台 / 按天滚动文件 / `AppLogLayer` 环形缓冲与广播 / debug ingest 四层各带过滤器），约 380 处 `println!` / `eprintln!` 按语义改为分级宏；`KABEGAME_LOG` 用 `Targets` 语法临时调级（取代 `KABEGAME_IPC_DEBUG`）。事件循环新增 opt-in 的 `log` 事件，经 Tauri `get_app_logs` / `start_app_log_stream` / `stop_app_log_stream`（经 Channel 推送）、Web super 的 `/logs` SSE、IPC `AppLogs` 推给订阅方；CLI 新增 `kabegame-cli log tail`。引入 `tauri-plugin-tracing`，前端用 `@/utils/logger` 写日志，未捕获异常自动记录。详见 `cocs/debug/APP_LOGGING.md`。

### Changed
- debug ingest 改为 trace 日志：Rust 用 `kabegame_core::kb_debug!`（core 也能插桩），Tauri 前端 `sendDebugEvent` 经插件打 `kb-debug` trace 日志，由 debug 构建的 `DebugIngestLayer` 批量 NDJSON 转发；删除 `spawn_debug_event` / `send_debug_event`。Android 前端 debug 事件不再需要 query 参数绕过 WebView 拦截。
- `tokio` 随 `tauri-plugin-tracing` 的最低要求升到 1.54.1。
- 壁纸轮播只认 `wallpaperRotationPath` + `wallpaperRotationPosition` 两个设置，命令 / IPC 改为 `set_wallpaper_rotation_path` / `get_wallpaper_rotation_path`（`SettingsGet/SetWallpaperRotationPath`），删除画册 id、子画册、模式三组命令与画册 `bigger_order` 路由；Android Worker 不再读数据库，改为消费 Rust 预取的 `rotation_queue.json`。详见 `cocs/wallpaper/ROTATION_PATHQL.md`。
- 轮播线程不再因 `rotate()` 紧跟 `reset()` 留下的 notify permit 多切一张；`wallpaperRotationPosition` 改为 i64，`-1` 表示刚换路径、下一次从第 1 张开始（`SettingValue` 新增 `I64`）。
- 设置迁移框架与数据库迁移对齐：模块文档写明新增步骤与约束，迁移失败不写回、照常启动，迁移写回前备份 `settings.json.bak-v<旧版本>`，每个迁移带单测；新增 v003 把旧轮播三键换算成路径。
- metadata 表新增可空列 `template`（v047 迁移）；`images://id_<id>/metadata_full` 与 `get_image_metadata_full` 返回该字段。metadata 迁移把冻结模板原样带到新行，整轮去重按模板分区；开启「去重时更新元数据」时，后一次运行改挂到新行，data 与模板一起被覆盖，未冻结时清空。
- app IPC 协议升到 v4（`PluginRunParams.freezeTemplate`），新 CLI 连接旧主程序时自动回退本地执行。
- 生产 web 构建（`isWeb && command === "build"`）的 Vite `base` 指向 `https://cdn.kabegame.com/web/`，`index.html` 仍由二进制内嵌返回。`scripts/deploy-web.sh` 新增第 0 步：先经服务器暂存目录把 `dist-kabegame-web/`（除 `index.html`）`cp` 进 OSS 挂载目录 `/mnt/oss/web/`，校验入口脚本 MIME 后才停服换二进制，OSS 上只增不删。详见 `cocs/web/CDN_MEDIA.md`。
- `public/` 下的吉祥物、空状态、失物、冲浪插画移到 `apps/kabegame/src/assets/`，经 `src/assets/illustrations.ts` 按 `IS_WEB` 取 WebP 或原图；`vite.config.ts` 新增 `dropUnreferencedSrcAssets` 插件，删掉产物中未被引用的那一份。吉祥物启动时只预取挥手图。
- 新增目录型媒体格式 `x-wpe/video` / `x-wpe/web` / `x-wpe/scene`（`extensions` 为空，不可按扩展名摄入）与 `is_wpe_type` / `wpe_kind` / `is_video_like_type`；`images.local_path` 在目录型行上是 WPE 壁纸目录，所有把它当文件用的调用点按 type 分流：`/file` 返回 404、新增 `/wpe/<imageId>/<rel>` 目录服务（307 到 `project.json` 入口、越界拒绝，供网页壁纸的相对资源）、整理跳过缩略图 / 兼容副本 / 哈希去重 / 无法识别清理、虚拟盘隐藏、原生壁纸与 Plasma 拒绝、WPE 行删除不进源文件回收。
- 新增 `kabegame-core::wpe`（Steam 库发现、任意目录识别、`project.json` 解析、作者视频属性换算）与内建任务 `wpe-import`；缩略图删除改为只删 `thumbnails_dir` 内由 Kabegame 生成的文件，避免删掉 WPE 的 `preview.*`。
- 修复 `libraryfolders.vdf` 解析：顶层键值序列没有花括号，原解析器直接返回空，其它盘的 Steam 库从未被发现；旧格式 `LibraryFolders` 键改为不区分大小写，并只把数字键当库条目。
- 壁纸窗口改用 `get_current_wallpaper_target`（`{ id, path, type, compatiblePath, wpeVideo }`），`x-wpe/video` 只走 `compatible_path`（入口视频本身或兼容副本）播放，并在舞台层复现作者的对齐位置 / 翻转 / 背景色 / 颜色调整（Kabegame 样式、音量、倍速覆盖作者值）；轮播与可用性判定从路径扩展名改为按行 `type`。
- WPE 第二阶段 Phase 3：`x-wpe/web` 入库（`compatible_path` / 宽高为空）；`/wpe` 新增专属网页 MIME 表 `WPE_WEB_MIME`（不进 `MEDIA_FORMATS`）与 HTML 产出点 `serve_wpe_html`；CSP `frame-src` 放行 `http://127.0.0.1:*`；`WallpaperStage` 新增独立 web 层（跨源 sandbox iframe，不参与双层过渡，切走即销毁）；`ImageContent` 新增 `wallpaper` 形态（`WpeWallpaperContent`）与预览 `WallpaperDesktopCanvas`；新增命令 `get_wallpaper_target_for_image`，`build_wallpaper_target` 的 WPE 作者属性改读图片 metadata；`tauri-runtime-cef` 的 `cef-ipc` 只接受主 frame（或与初始 URL 同源的子 frame）的 postMessage，其余 400。`/wpe` 非 HTML 文件的缓存头从一年 `immutable` 改为 `no-cache`，壁纸文件原地更新后不再读到旧 js / css。
- 壁纸窗口 Vue 化：与主窗口共用 `index.html`（`?window=wallpaper`），`main.ts` 按窗口动态导入 `bootstrap/app.ts` / `bootstrap/wallpaper.ts`（后者不装路由、组件库与 vant）；渲染拆为纯组件 `WallpaperStage.vue`（双层过渡、tile、WPE 视频属性，预留 `paused` / `interactive`）与负责 IPC / 看门狗 / ready 握手的 `WallpaperWindow.vue`，删除 `wallpaper.html` / `wallpaper.ts` 及其 rollup 入口；后端抽出 `build_wallpaper_target`。行为不变。dev 调试面板增加帧率（MIN / AVG，复用主窗口 `frameMonitor` store）。
- 路径轮播合入 WPE：目录型 WPE 壁纸只在窗口模式参与轮播。原生模式有效路径的 `media-type/image` 是「非视频」过滤、不排除 `x-wpe/*`，所以由 rotator 在逐张可用性检查里跳过（Plasma 插件模式同样跳过），不改 count 与位置口径。
- 下载目标文件名改为原子占坑：`compute_unique_download_path[_with_name]` 改名为 `occupy_unique_download_path[_with_name]`（新增 `move_from` 参数，返回 `OccupiedFile` 守卫），删除只算路径的 `unique_path`；新增 `occupy_unique_path` / `is_occupied_for_download` 与 `local_folder::album_for_file`。占用标记为 Unix `flock` / Windows share mode，Windows 上写入必须经守卫句柄、删除前先 drop。详见 `cocs/downloader-tasks/DOWNLOADER_FLOW.md`「目标文件占坑与占用标记」。
- 仓库新增 `.gitattributes`（`* text=auto eol=lf`，`.bat` / `.cmd` 为 CRLF，`*.patch` / `*.diff` 不转换）与 `.editorconfig`，换行符统一为 LF，并把已有 CRLF 文件归一化。
- 数据库迁移拆成同步 schema 迁移与可恢复的回填作业：新增 `backfill_jobs` 表（v048）、`storage/migrations/backfill.rs` 注册表（按批 `BEGIN IMMEDIATE` 提交并同事务写回 rowid 游标，崩溃续跑）、`Migration.min_backfill_version`（执行前同步排干被依赖的回填）、`BackfillService` 后台按序运行（忙碌快照 `backfills` + `backfill-finished`）与调试开关 `KABEGAME_BACKFILL_SYNC_THROUGH`；`Storage::new()` 改为返回 `Result`。桌面 / Android 启动拆成 `init_pre`（主线程建窗）→ 线程内 `init_heavy_globals` → 主线程 `init_post`，进度经 core `startup_state` watch、`startup-progress` 事件与新命令 `get_startup_state` 交给前端启动页（Init app 先挂载、`ready` 后卸载再挂主界面）；IPC `status` 增加 `backfillPending`。详见 `cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`。
