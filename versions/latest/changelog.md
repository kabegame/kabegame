# v4.7.0 changelog

## 用户侧

### Added
- 新增应用日志：运行日志分级并按天保存到数据目录下的 `logs` 文件夹（保留 14 天），工具箱新增「查看日志」，可按级别、前端 / 后端、模块和关键字筛选，实时滚动，支持复制与打开日志目录。Web 版仅 super 模式可用。
- 网页壁纸可在预览详情栏与设置页调整作者提供的属性，桌面壁纸实时生效；支持文件与目录属性。
- 新增「壁纸」收集入口：自动发现本机 Wallpaper Engine 壁纸（Steam 创意工坊订阅、官方默认、我的项目），也可手动添加任意壁纸目录或 Steam 库；第一阶段把 `video` 型壁纸原地引用入库，使用作者自带的 `preview.gif` / `preview.jpg` 作为图库预览，不复制、不转码用户目录。
- 「壁纸」导入支持 Wallpaper Engine 网页壁纸：原地引用壁纸目录；预览以主屏比例的「桌面画布」运行页面并可交互，也可在窗口模式设为桌面壁纸（应用背景显示作者预览图）。
- 桌面网页壁纸改为像 Wallpaper Engine 一样以 `file://` 直接加载壁纸目录：依赖读取同目录数据文件的壁纸（如歌单、字幕类）现在能完整运行；文件访问只对壁纸窗口开启，且只能读当前壁纸目录内的文件。Windows 上桌面的鼠标移动与左键点击会转发给网页壁纸（不拦截桌面本身的点击，桌面框选不受影响）。预览网页壁纸时，鼠标移到画布左右边缘中段即可唤出切换箭头。预览网页壁纸时右键菜单无法弹出（右键会被壁纸页面接收），菜单里的操作改为按原顺序排在底部工具条里。
- 网页壁纸可读取作者默认属性与界面语言：桌面壁纸与图库预览里的 Wallpaper Engine 网页壁纸会在加载完成后收到 `project.json` 里作者设定的属性值，以及当前界面语言（切换语言后页面随之更新）；依赖这些属性才开始绘制的壁纸现在能正常显示。暂不支持在应用里修改属性、帧率上限、暂停与音频可视化。

### Optimized
- 窗口模式桌面壁纸（含 Windows 网页壁纸）卡死或与后台失联时，会在约 30~40 秒内自动重新加载，不再一直停在旧画面或白屏；壁纸被其它窗口遮住时不会误判。
- 桌面版（Windows / macOS / Linux）图库、预览与窗口壁纸里的图片、缩略图和视频改由内置浏览器直接读取本地文件，不再经过应用内的本地 HTTP 服务；桌面本地 HTTP 文件服务不再监听端口，复制兜底改用 `file://`。插件文档和配图由应用内命令读取并缓存。插件详情页（插件模板）改在更严格的隔离环境里运行：模板不能再直接发网络请求或访问主界面，模板里写的远程图片照常显示。
- Windows 桌面版从图库把图片或视频拖到资源管理器、Word、聊天软件等程序时，得到的是库内原文件（不再是缩略图或需要下载的地址）；三个桌面平台的拖出都只复制，不会把库内文件移走。
- Windows 安装程序在最后阶段不再一个接一个地闪出大量黑色命令行窗口：搬运 CEF 运行时、DLL 与设置目录图标属性改用安装程序内置指令完成。
- 桌面端界面卡死后的自动恢复更快：页面无响应约 6 秒（原约 16 秒）即自动重新加载。

### Fixed
- 修复网页壁纸刚打开时偶尔要等几秒才应用属性、读不到为它选择的文件夹的问题。

### Changed
- Windows 桌面版升级后，部分只存在本机界面里的偏好会恢复默认：画廊每页数量与布局、面板宽度、链接打开方式（会重新询问）、吉祥物开关与位置、上次浏览的画廊路径、视频音量等；应用设置与图库数据不受影响。
- 壁纸轮播改为按一条视图路径依次切换：在画廊、画册、任务或畅游详情的过滤栏 ⋯ 菜单点「用当前视图轮播」，当前的过滤与排序就是轮播来源；设置页只显示当前轮播路径，原来的「选择画册 / 包含子画册 / 随机或顺序」三项去掉（随机即随机排序视图）。每次切换都从当前壁纸在视图里的下一张接着走，视图里的图片增删、排序变化不会让轮播跳张或重复；当前壁纸不在视图里时按保存的轮播位置继续，停止再开启、重启应用也接着上次；换视图会立刻切到新视图的第一张；原生壁纸模式只轮播图片，切换壁纸模式后从当前壁纸的下一张继续。旧设置升级时自动换算成对应路径。
- 图片详情的「基本信息」改为卡片式排版：名称作标题，源与收藏时间并在一行，类型、大小、尺寸做成可点筛选的芯片，宽高比画成与图片同比例的矩形框；URL 与本地路径各占一行，省略显示并带复制按钮，整体高度明显降低。
- Web 版（demo.kabegame.com）首屏打开明显变快：脚本、样式和插画改从 CDN 加载并自动压缩，不再挤占服务器那点带宽；吉祥物、空状态等插画在 Web 版换成按显示尺寸压缩的 WebP（合计 8.2 MB → 244 KB），桌面与 Android 仍用原图。
- Windows 桌面网页壁纸与图库预览改为同一套实现（壁纸窗口里嵌入网页壁纸，不再整窗跳转）：图片 / 视频与网页壁纸之间也有切换过渡；预览与桌面的页面存储互通（桌面上此前保存的页面数据不会带过来）；改了文件夹属性后，旧文件夹立即不再可读；网页壁纸只能读取自己的壁纸目录和为它选择的文件。
- 启动时主窗口立即出现：数据库升级等耗时初始化改在后台进行，期间窗口显示启动页与进度（升级需要先补算数据时显示进度条），完成后自动进入主界面；初始化失败会在启动页显示错误并可直接退出。其余数据补算在进入界面后于后台继续，可在「我正在忙这些」里看到进度，中途退出下次启动接着做。

### Fixed
- Windows 桌面版畅游在 x.com 等限制严格的网站上，下载视频等大块数据不再降级到慢速通道。
- Windows 窗口壁纸改挂到桌面背景 WorkerW，移除点击桌面和最小化时反复修正图标层 Z-order 的逻辑。
- Android 平板 / 横屏宽屏布局的侧栏、主内容区与弹窗不再被状态栏、底部导航栏遮挡；平板上的弹窗与桌面一样限高、只在内容区滚动，底部按钮始终可见。
- Android 平板（宽度超过紧凑断点）打开图片预览后左右滑动不再停在原图，能正常切换上一张 / 下一张；滑动过后按一次返回即可关闭预览，不再先被背后的多选状态吃掉。
- Android 吉祥物亀ちゃん不再被底部导航栏挡住脚部，拖动范围也限制在系统栏之内。
- Android 预览图片视频滑动后不暂停播放的问题
- WebView 爬虫打开的网站不再能订阅应用事件（此前可读到图库新增图片的本地路径等信息），也不能向主界面伪造事件。
- 修复下载时偶发「UNIQUE constraint failed: images.local_path」：同一帖子多张同名图片并发下载不再互相覆盖、丢图，会依次存成 `name.jpg`、`name(1).jpg`……；下载目录同时是文件夹画册时，新下载的图片也会立刻进入该画册，不再与文件夹同步抢着入库。
- Windows 桌面版畅游打开 https 网站时，地址同步、一键下载、右键下载图片和页面内提示等功能全部失效的问题。
- 畅游时（尤其开着开发者工具）右键图片不再叠出两个「下载图片」菜单、要点两次才关闭；页面加载时的地址上报等也不再重复发送。
- 桌面网页壁纸切换后有时不再跟随属性与界面语言变化、偶尔只显示「请选择目录」之类的空白提示的问题；同时堵住了网页壁纸在切换瞬间可能取得应用主界面权限的漏洞。
- 网页壁纸带步长的滑块属性，在输入框直接键入的数值也会对齐到步长（例如步长 0.25 时键入 1.3 得到 1.25），与拖动滑块一致。
- 安全加固：畅游导航栏、桌面网页壁纸等页面只能监听为它们开放的应用事件，发给某个窗口的事件不会再被其它窗口收到；页面里嵌入的子页面（iframe）不再沿用所在页面的应用权限。

## 插件开发侧

### Changed
- 图片详情的插件模板（`description.ejs`）iframe 不再与应用同源（去掉 `allow-same-origin`），并在文档最前带内层 CSP（`connect-src 'none'`、`frame-src about:` 等）：模板里直接 `fetch` / XHR / WebSocket、`<link>` 外链样式、远程字体、嵌套 http(s) 或 `file:` iframe 都会被拒，网络请求一律经 `__bridge.fetch`；`<img>`、CSS 背景等元素级远程图片与嵌套 `srcdoc` iframe 不受影响；`window.parent`、`localStorage` 不可访问（跨次缓存用 `__bridge.getCache` / `setCache`）。

### Added
- `kabegame-cli plugin run` 新增 `--freeze-template`：把本次运行插件的 `description.ejs` 冻结进每行 metadata（新列 `metadata.template`），详情面板优先用它渲染。`--id` 测试 id 没有安装，过去它下载的图片只能看原始键值，现在也能直接在应用里调试模板。插件模板与冻结模板并行获取，冻结模板非空时覆盖插件模板。

## 开发侧

### Added
- 日志框架改用 `tracing`：`kabegame_core::logging` 装配全进程唯一订阅器（控制台 / 按天滚动文件 / `AppLogLayer` 环形缓冲与广播 / debug ingest 四层各带过滤器），约 380 处 `println!` / `eprintln!` 按语义改为分级宏；`KABEGAME_LOG` 用 `Targets` 语法临时调级（取代 `KABEGAME_IPC_DEBUG`）。事件循环新增 opt-in 的 `log` 事件，经 Tauri `get_app_logs` / `start_app_log_stream` / `stop_app_log_stream`（经 Channel 推送）、Web super 的 `/logs` SSE、IPC `AppLogs` 推给订阅方；CLI 新增 `kabegame-cli log tail`。引入 `tauri-plugin-tracing`，前端用 `@/utils/logger` 写日志，未捕获异常自动记录。详见 `cocs/debug/APP_LOGGING.md`。
- WPE 网页壁纸用户属性：值存图片 metadata 的 `userProperties`，经新增的 `Storage::rewrite_image_metadata` 事务改写并发 `metadataId` 补丁驱动垫片与面板重拉；CEF 运行时文件策略新增 `grant_file_documents`，按窗口与当前根目录追加放行用户选的文件 / 目录（换根清空）；显示条件解释器 `utils/wpeProperties.ts`、WPE 内置词表只读读取安装目录。

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
- WPE 第二阶段 Phase 3：`x-wpe/web` 入库（`compatible_path` / 宽高为空）；`/wpe` 新增专属网页 MIME 表 `WPE_WEB_MIME`（不进 `MEDIA_FORMATS`）与 HTML 产出点 `serve_wpe_html`；CSP `frame-src` 放行 `http://127.0.0.1:*`；`WallpaperStage` 新增独立 web 层（跨源 sandbox iframe，不参与双层过渡，切走即销毁）；`ImageContent` 新增 `wallpaper` 形态（`WpeWallpaperContent`）与预览 `WallpaperDesktopCanvas`；新增命令 `get_wallpaper_target_for_image`，`build_wallpaper_target` 的 WPE 作者属性改读图片 metadata；`tauri-runtime-cef` 的 `cef-ipc` 只接受主 frame（或与初始 URL 同源的子 frame）的 postMessage，其余 400。`/wpe` 的文本类资源（js / css / json 等）缓存头从一年 `immutable` 改为 `no-cache`，壁纸文件原地更新后不再读到旧代码；图片、字体、音视频仍为 `immutable`。
- WPE 第二阶段 Phase 5：all-frames 垫片 `webview_js/wpe_shim.js` 以 `pull` / `listen` 两个原语向宿主拉取 `{ imageId, user, general: { language } }`（桌面 `wpe_web_pull_state`，预览 iframe 经 `postMessage` 由宿主页调 `get_wpe_web_state` 并用新的 `useTauriProxy` 代为 listen），语言变化与本张 `metadataId` 补丁触发重拉；`tauri-runtime-cef` 把 `file:` frame 的 IPC `Origin` 改写成 frame URL、`cef-ipc` 来源回退改为「Origin → frame URL → 初始 URL」（修复 `file:` 文档的回退通道被当成本地来源、拿到 `main-capability` 全部命令的缺口），并删除 Phase 4 的「`file:` 文档不注入初始化脚本」；新增 `wpe-web-capability`（壁纸窗口 + `file:///*`，只开 `wpe_web_pull_state` 与事件 listen / unlisten）；tauri 补丁 0011 新增 `clear_js_listeners()`，壁纸窗口每次导航成功后清掉旧文档的 JS 事件监听。
- WPE 第二阶段 Phase 6a：图库预览的网页壁纸 iframe 改为加载入口 `file://`（入口由 Rust 用与桌面壁纸窗口共用的 `wallpaper::web_entry` 现算），主窗口建窗前 `allow_file_documents("main")`、预览挂载 / 卸载经新命令 `set_wpe_web_preview`（只在 `permissions/main.toml`，拒绝壁纸窗口）设 / 清 `file:` 根目录并返回入口；应用页给 iframe 赋 `file:` 的 `src` 原本会被渲染进程 `CanDisplay` 与浏览器进程 `FilterURL` 拦下，为此新增 CEF 补丁 0005（建窗 `extra_info` 的 `kabegame.allow_local_resources`：渲染侧 `GrantLoadLocalResources`、浏览器侧 `GrantRequestScheme(file)`，弹窗提交的文档不授），主窗口登记后前端直接给 iframe 赋入口 `file://`；`tauri-runtime-cef` 新增 `allow_app_local_resources`，补丁只开门，加载仍走与桌面同一套运行时目录拦截，`localStorage` 与桌面同源；垫片预览判定改为「父窗口即 top 的 `file:` 子 frame」，宿主桥 `postMessage` 目标源改 `"*"`；CSP `frame-src` 加 `file:`、删 `http://127.0.0.1:*`；删除 `/wpe/<id>/<rel>` HTTP 目录服务及其 MIME 表、`serve_wpe_html` 与前端 `wpeEntryUrl`。WPE 收窄为只提供 Windows 桌面：`platform_supported()` 只对 Windows 为 true，`web_entry` 与两处文件文档登记按 Windows 门控（Windows 上用户可见行为不变；macOS / Linux 不再自动发现、不渲染网页壁纸）。
- 壁纸窗口 Vue 化：与主窗口共用 `index.html`（`?window=wallpaper`），`main.ts` 按窗口动态导入 `bootstrap/app.ts` / `bootstrap/wallpaper.ts`（后者不装路由、组件库与 vant）；渲染拆为纯组件 `WallpaperStage.vue`（双层过渡、tile、WPE 视频属性，预留 `paused` / `interactive`）与负责 IPC / 看门狗 / ready 握手的 `WallpaperWindow.vue`，删除 `wallpaper.html` / `wallpaper.ts` 及其 rollup 入口；后端抽出 `build_wallpaper_target`。行为不变。dev 调试面板增加帧率（MIN / AVG，复用主窗口 `frameMonitor` store）。
- 路径轮播合入 WPE：目录型 WPE 壁纸只在窗口模式参与轮播。原生模式有效路径的 `media-type/image` 是「非视频」过滤、不排除 `x-wpe/*`，所以由 rotator 在逐张可用性检查里跳过（Plasma 插件模式同样跳过），不改 count 与位置口径。
- 下载目标文件名改为原子占坑：`compute_unique_download_path[_with_name]` 改名为 `occupy_unique_download_path[_with_name]`（新增 `move_from` 参数，返回 `OccupiedFile` 守卫），删除只算路径的 `unique_path`；新增 `occupy_unique_path` / `is_occupied_for_download` 与 `local_folder::album_for_file`。占用标记为 Unix `flock` / Windows share mode，Windows 上写入必须经守卫句柄、删除前先 drop。详见 `cocs/downloader-tasks/DOWNLOADER_FLOW.md`「目标文件占坑与占用标记」。
- 仓库新增 `.gitattributes`（`* text=auto eol=lf`，`.bat` / `.cmd` 为 CRLF，`*.patch` / `*.diff` 不转换）与 `.editorconfig`，换行符统一为 LF，并把已有 CRLF 文件归一化。
- WPE 第二阶段 Phase 6b：新增 CEF 补丁 0006（`ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories`，先调父类，沿用 0005 的 `kabegame.allow_local_resources` 键）给非弹窗 browser 的最外层主 frame 补 `file:` 子资源工厂，应用页的 `<img>` / `<video>` 才能加载 `file:`（需重编 CEF）；`tauri-runtime-cef` 的 `resource_request_handler` 按发起 frame 分档：应用页主 frame 的子资源在登记了 0005 时免检（新增 `file_access::app_page_open`），子 frame / 主 frame 的导航与 `file:` 文档的子资源仍按根目录；主窗口的 0005 改为三个桌面平台都登记（0004 仍只 Windows），壁纸窗口新增登记 0005。前端 `utils/fileUrl.ts` 新增 `pathToFileUrl` 与 `fileToHttpUrl` / `thumbnailToHttpUrl` / `compatibleToHttpUrl`，`fileToUrl` / `thumbnailToUrl` / `compatibleToUrl` 在桌面返回 `file://`（Android / Web 不变）；下载与复制兜底、Windows 拖出 `DownloadURL`（按渲染槽当前源等级取端点，不再用 `currentSrc`）改走 `*ToHttpUrl`；CSP `img-src` / `media-src` 加 `file:`。插件详情 EJS iframe 改 opaque origin + 内层 CSP。删除本地 HTTP 服务（含 web 版）的 `/proxy` 开放代理与 vite dev 代理项，顺带删掉 `http_server.rs` 里未使用的 `PluginDocImageQuery`。详见 `cocs/wpe/WPE_IMPORT.md`「图库媒体：`file://` 与按发起 frame 分档的闸门」。
- 数据库迁移拆成同步 schema 迁移与可恢复的回填作业：新增 `backfill_jobs` 表（v048）、`storage/migrations/backfill.rs` 注册表（按批 `BEGIN IMMEDIATE` 提交并同事务写回 rowid 游标，崩溃续跑）、`Migration.min_backfill_version`（执行前同步排干被依赖的回填）、`BackfillService` 后台按序运行（忙碌快照 `backfills` + `backfill-finished`）与调试开关 `KABEGAME_BACKFILL_SYNC_THROUGH`；`Storage::new()` 改为返回 `Result`。桌面 / Android 启动拆成 `init_pre`（主线程建窗）→ 线程内 `init_heavy_globals` → 主线程 `init_post`，进度经 core `startup_state` watch、`startup-progress` 事件与新命令 `get_startup_state` 交给前端启动页（Init app 先挂载、`ready` 后卸载再挂主界面）；IPC `status` 增加 `backfillPending`。详见 `cocs/storage/DB_MIGRATIONS_AND_BACKFILLS.md`。
- `deno task patch` 新增 `--gen [--from <x>] [--out <path>]`：在 `GIT_INDEX_FILE` 指向的临时 index 里以「纯净基线 + 系列套用到 x」为底树、`add -A` 工作树为目标树，两树 `git diff --full-index` 即系列之外的剩余改动，导出为新补丁；不 reset、不碰子模块真实 index 与工作树。`third-patches/AGENTS.md` 的新补丁工法改为推荐它。
- 新增 tauri 补丁 0014–0017（拉取后须重新应用 tauri 补丁序列）：JS 事件按接收方 webview 身份投递并忽略前端 `listen` 传的 `target`、`unlisten` 只作用于调用方 webview；`core:event:allow-listen` 支持事件名作用域；capability 新增 `frames`（默认只认主 frame，frame 由 CEF runtime 经请求 extension 上报）；新增 `Builder::acl_exempt_webview`，主窗口与壁纸窗口的本地应用页免 ACL，删除约 200 条的 `permissions/main.toml`，新增只给主界面用的命令只需注册进 `generate_handler!`。补丁 0009 顺带补上 `mock_context` 缺的 `bins` 字段，`cargo test -p tauri` 可以编译。
- 新增 tauri 补丁 0018–0019（拉取后须重新应用 tauri 补丁序列）：frame 成为 IPC 的基本单位——CEF 下每个子 frame 无条件注入 Tauri 桥（ACL 是唯一闸门），子 frame 请求带 `SubframeId`，监听登记 / 事件 / Channel 消息 / 回退响应都送回调用方 frame，Channel 取数按 frame 归属，`SubframeDestroyed` 清该 frame 的监听，关闭拦截只看主 frame，新增 `tauri::ipc::CallerOrigin`。应用侧网页壁纸统一为 `WallpaperStage` 的 `file:` iframe：`wpe-web-capability` 绑定 `main` 与 `wallpaper` 且 `frames: "sub"`，删除 `set_wpe_web_preview` / `get_wpe_web_state` / `wpeWebBridge.ts` 与壁纸窗口整窗导航；`file:` 闸门改由网页壁纸目录索引（`wallpaper/wpe_web_dir_index.rs`，`list_wpe_web_rows` 走 `idx_images_type`）经 `set_file_scope_resolver` 推出访问范围，删除按 webview 存的根目录与追加放行。
- 新增 tauri 补丁 0013：Windows 改用原生 `tauri://localhost` / `ipc://localhost`；CEF runtime 删除 `http://<scheme>.localhost` 映射并统一三平台 scheme。拉取后须重新应用 tauri 补丁序列。
- CEF 补丁 0006 改用每工厂私有 CORS 列表，运行时登记应用 origin 到 `file:` 的跨源白名单；删除桌面 `start_http_server` 并关闭 Tauri asset 协议。
- Phase 6d：CEF 补丁 0003 扩到 Windows（需重编 CEF）——Chromium 内层补丁的 aura `StartDragging` 钩子放宽到 `IS_LINUX || IS_WIN`，delegate 背书文件时另清 `html` / `download_metadata`，Windows 不打 `chromium/x-renderer-taint`；`tauri-runtime-cef` 的 `on_start_dragging` 去掉 Linux / macOS cfg，应用在三个桌面平台安装拖出 resolver，`authorize_drag_image` 收紧为 `is_file()`（`x-wpe/*` 目录行不得拖出）；前端桌面拖出只写 image id 并设 `effectAllowed = "copy"`，Web 版保留 `DownloadURL`。

### Fixed
- CEF 运行时 `on_context_created` 只往 frame 的主世界注入初始化脚本（比较 `frame.v8_context()`），DevTools / CDP 建的隔离世界不再重复执行 Tauri 与畅游脚本。
- 新增 tauri 补丁 0012：`ipc-protocol.js` 的自定义协议 IPC fetch 固定 `referrerPolicy: 'origin'`（Windows 上 https 页面请求 `http://ipc.localhost` 时 CEF 把 `Origin` 发成 `null`，Tauri 回 500 且不回退 postMessage）；`tauri-runtime-cef` 的 `cef-ipc` 回退 shim 同样设置。
- CEF 运行时 IPC 链路拉直：`ipc` / `cef-ipc` 由 `IpcResourceRequestHandler::GetResourceHandler` 直接交出 Tauri 协议 handler；`ipc_origin` 按 initiator 与 CEF 0007 的完整文档 URL 算一次 `Origin`，认不出写 `null`。删除 `IpcInitiatorHandler`、`Sec-Kabegame-Initiator-Origin` 与 `pin_file_frame_origin`；回退通道不合法来源统一用占位来源交给 ACL 拒绝。`IpcResourceRequestHandler` 显式让 `on_before_resource_load` 返回 `CONTINUE`：cef-rs 的默认实现是 `RV_CANCEL`，不实现会取消全部 IPC 请求。
- CEF 渲染进程的初始化脚本表按 browser id 计数：CEF 渲染侧按 WebView 建浏览器对象，同一 browser 可同时有几个；原来按 id 增删，网页壁纸之间直接切换时旧 WebView 晚销毁会删掉脚本，新 iframe 没有 Tauri 桥、垫片不运行（桌面 30 秒后被看门狗重载，预览一直缺属性）。
- dev 下 CDP 端口登记与 debug ingest 的 reqwest 客户端不再走 `HTTP_PROXY`：终端设了代理时，登记曾报 `never became ready`，skill 找不到 app。
- 新增 CEF 补丁 0007（需重编 CEF）：建子资源 / 导航工厂时捕获文档与父文档 URL，对非 http(s) 请求写入两个私有归属头；`file:` 闸门按文档头分档，移除 worker 的 `file:` 工厂和垫片首批请求退避重试。

### Internal
- v049 一次性规范化 `images.type` 并新增 `idx_images_type`；Rust 写入口保证非空小写格式键，媒体分类与格式查询去掉逐行 LOWER / COALESCE，保留画廊排序分页的索引计划；补充迁移、规则比对及 DSL 执行计划回归。
