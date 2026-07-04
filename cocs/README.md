# cocs 文档索引

本目录用于沉淀 Kabegame 的关键流程、架构约束与迁移说明。  
当需要理解某个模块时，建议先从本索引定位文档，再按文档中的“涉及文件”阅读代码。

专题文档按主题放在子目录中；**索引条目一律链到具体 `.md` 文件**，便于一键打开。

## 阅读顺序建议

1. 先看本索引，定位目标主题。
2. 进入对应文档了解流程与边界。
3. 再打开文档中引用的代码文件做实现核对。

## Provider DSL（`provider-dsl/`）

- 状态：Phase 7c 后内置 Provider 已全量 DSL 化，`src-tauri/kabegame-core/src/providers/programmatic/`
  已删除；core 启动时只加载 `dsl_loader::DSL_FILES` 中的 root/gallery/shared/VD provider。

- [provider-dsl/RULES.md](provider-dsl/RULES.md)
  - 主题：声明式 Provider DSL（v0.7）的加载期与运行期语义合约 —— schema 之外的规则。涵盖路径折叠、ContribQuery 累积语义（fields/from/join/where/order 各自规则；offset 累加、limit 末次胜）、List 静态/动态项、Resolve 正则解析、`${...}` 模板语义（命名空间取值 + 方法标记）、`as + in_need` 共享机制、缓存契约（只缓存命中）、安全契约、保留标识符、主机协调模式抽象。
  - 适用场景：实现引擎 loader / 解析器；编写 *.provider.json5 文件；排查跨字段约束错误；设计第三方插件可贡献的 provider。
  - 配套：[../src-tauri/kabegame-core/src/providers/schema.json5](../src-tauri/kabegame-core/src/providers/schema.json5) 为语法 schema。

- [provider-dsl/VD_INTEGRATION.md](provider-dsl/VD_INTEGRATION.md)
  - 主题：VD 作为 Provider DSL 引擎**消费者**的落地方案。涵盖 i18n 路径分发（`i18n-<locale>` 静态层 + 每语言独立 router）、插件维度的 `get_plugin` SQL 函数桥（主机注册的 SQL 函数把 PluginManager 元数据接入 SQL 上下文）、`vd_plugins_router` 与 `plugins_provider` 双层结构、典型路径折叠示例。
  - 适用场景：新增 / 修改 VD 维度路径树；接入需要主机协调的非 SQL 数据；理解 i18n 切换、插件装卸的缓存行为。

## 画廊与查询（`gallery/`）

- [gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
  - 主题：Gallery/VD 共用的 Provider + ImageQuery 可组合查询系统（**当前 Rust 实现**；未来由 DSL 替代，参见 provider-dsl/）。
  - 适用场景：新增过滤、排序、数据源；理解 `JOIN/WHERE/ORDER` 组合方式；排查 provider 查询路径问题。

- [gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md](gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md)
  - 主题：画廊 SimplePage 分页与每页条数（100/500/1000）的前后端数据流、设置持久化、`browse_gallery_provider` 与 `invoke` 参数约定；**列表不带 `metadata`**、`get_image_metadata` 与前端 per-page 缓存；**`images-change`（images 表）与 `album-images-change`（album_images 表）** 事件拆分与前端/Plasma 订阅要点。
  - 适用场景：排查翻页/offset、每页条数切换不刷新、列表加载失败；区分 SimplePage 与 VD Greedy 的 `LEAF_SIZE` 行为；排查画册/任务/畅游视图刷新与事件过滤；排查详情区插件描述/metadata 未显示或缓存未失效。

## 下载与任务（`downloader-tasks/`）

- [downloader-tasks/DOWNLOADER_FLOW.md](downloader-tasks/DOWNLOADER_FLOW.md)
  - 主题：当前下载器全链路与模块边界。涵盖 `mod.rs` scheme registry / `queue.rs` worker / `content.rs` Android content downloader 的分工，`download_with_retry` 通过 `DownloadSink` 溢写（5 MiB 阈值）返回 `DownloadOutcome`（Bytes/Path）、Fatal/Retriable/Resumable 三级错误重试、crawler/surf 共享的 blob/data/MSE 分块上传通道、MSE 多流上传与桌面合流、DRM 拒绝、统一 `postprocess_downloaded_image`（`PostprocessSource` 枚举）、URL 与 hash 两级去重、桌面落盘、Android MediaStore copy 与 content URI 沿用、失败重试、`task-image-counts`、启动临时文件清理以及 **`images-change` / `album-images-change`** 事件。
  - 适用场景：下载任务生命周期、Android `content://` 与 HTTP/HTTPS 下载差异、JS 爬虫或畅游窗口的 `blob:` / `data:` / MSE 媒体下载、MSE 多 SourceBuffer 合流、失败重试、状态流转问题；任务 success/deleted/failed/dedup 计数与前端同步；排查下载后列表/画册未刷新。

- [downloader-tasks/VIDEO_INGEST.md](downloader-tasks/VIDEO_INGEST.md)
  - 主题：视频摄入（下载/导入压缩）的平台门控机制。桌面 standard/light/CLI 使用 rsmpeg/FFmpeg；Android 走 Kotlin `AndroidVideoCompressProvider` 与系统媒体 API，不编译 FFmpeg。画廊播放始终可用（HTML `<video>`，无需 FFmpeg）。
  - 适用场景：新增视频处理调用点；排查桌面 FFmpeg 构建环境；排查 Android content URI 视频预览/维度读取；理解 `bun run build:ffmpeg` 与桌面构建的关系。

- [downloader-tasks/TASK_DRAWER_LOAD.md](downloader-tasks/TASK_DRAWER_LOAD.md)
  - 主题：任务抽屉分页加载、触底加载与相关数据流。
  - 适用场景：任务数量多时打开抽屉卡顿、loadTasksPage 与 get_tasks_page 行为。

## 爬虫（`crawler/`）

- [crawler/CRAWLER_JS_FLOW.md](crawler/CRAWLER_JS_FLOW.md)
  - 主题：Crawler JS 执行链路与相关模块关系，含每任务独立 WebView 窗口、media_capture/media_download/bootstrap initialization scripts、session 注册表、worker await completion、按 `crawler-<task_id>` label 路由命令。
  - 适用场景：调度、注入、抓取流程排查与扩展；排查 JS 任务并发、窗口创建/销毁、IPC 路由问题；排查 `ctx.downloadImage` 对 blob/data/MSE 的分流、多流上传、DRM 拒绝与桌面合流。

- [crawler/PIXIV_METADATA.md](crawler/PIXIV_METADATA.md)
  - 主题：Pixiv Rhai 插件 `metadata.body` 白名单入库与 DB 一次性迁移。
  - 适用场景：排查画册列表因 metadata 过大变慢、扩展 EJS 所需字段。

- [crawler/PIXIV_RANKING_RHAI.md](crawler/PIXIV_RANKING_RHAI.md)
  - 主题：Pixiv 排行榜模式的 `config.json` 三维度、`ranking_date`、Rhai 按接口 `next` 分页与 `warn`。
  - 适用场景：扩展/排查排行榜爬取、R18 与 `x-user-id`、理解列表分页语义。

- [crawler/PLUGIN_DATA.md](crawler/PLUGIN_DATA.md)
  - 主题：爬虫插件私有 JSON 缓存 `plugin_data`，含 Rhai 读写 API、`description.ejs` 只读 bridge、隔离和卸载清理语义。
  - 适用场景：插件需要缓存 tag taxonomy、emoji 元数据、token、TTL 状态，或在描述模板中读取爬虫预先计算的数据。

- [crawler/METADATA_MIGRATION.md](crawler/METADATA_MIGRATION.md)
  - 主题：插件图片 metadata 版本化迁移流程，含 `metadata_migrations/v{N}.rhai` 脚本契约、`download_image` / `create_image_metadata` 版本写入、`image_metadata` 复合去重、`metadata_full` 查询路径与 `metadata-migrate` 事件作用域。
  - 适用场景：插件升级后历史图片详情结构变化；排查 metadata 迁移失败、缓存未刷新、去重合并或版本断档问题。

## 插件（`plugins/`）

- [plugins/PLUGIN_STORE_CACHE.md](plugins/PLUGIN_STORE_CACHE.md)
  - 主题：插件商店缓存机制与更新策略。
  - 适用场景：插件列表更新延迟、缓存失效与命中行为分析。

- [plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md](plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md)
  - 主题：插件详情 **EJS 全链路**（`metadata` 写入 → `get_plugin_template` 加载 → `ejs.render` → iframe `srcdoc` 注入 `__bridge` → `postMessage` + `proxy_fetch`）。
  - 适用场景：编写/调试 `description.ejs`、理解模板从 ZIP 到展示的流程、排查详情区空白或跨域请求失败。

## Tauri（`tauri/`）

- [tauri/TAURI_ACL_PERMISSION_SYSTEM.md](tauri/TAURI_ACL_PERMISSION_SYSTEM.md)
  - 主题：Tauri v2 ACL（capability/permission）在 kabegame 的运行机制与故障复盘。
  - 适用场景：新增窗口 IPC 权限、调整 capability/permission、排查“命令不可用/全部被拒绝”问题。

- [../src-tauri/tauri-runtime-cef/README.md](../src-tauri/tauri-runtime-cef/README.md)
  - 主题：Linux 桌面 CEF runtime 后端的架构、平台门控与唯一的 CEF Views/windowed GPU 路径；自定义协议、page-load 生命周期与 `invoke` IPC 桥接（`ipc://` 主路径 + `cef-ipc://` postMessage 后备）。
  - 适用场景：排查 Linux CEF 启动/渲染/IPC、升级 CEF/Chromium、调整 `tauri-runtime-cef` trait 适配、确认非 Linux 平台不触达 CEF。

## 调试（`debug/`）

- [debug/DEBUG_INGEST.md](debug/DEBUG_INGEST.md)
  - 主题：开发期 runtime debug ingest 方法。Vite dev server 提供 `POST /__kabegame_debug/ingest`，前端与 Rust 后端按 `session_id` 发送调试事件，middleware tee 到 `.kabegame/debug/debug-<session_id>.ndjson`。
  - 适用场景：仿 Cursor Debug Mode 的插桩式排查；需要把前端和 Rust 后端运行时状态汇总到同一个 NDJSON 会话文件；用 curl 验证 debug endpoint 或读取 session 日志。

## 国际化（`i18n/`）

- [i18n/I18N_MIGRATION.md](i18n/I18N_MIGRATION.md)
  - 主题：i18n 迁移约束、命名空间规范与落地状态。
  - 适用场景：新增国际化 key、迁移旧文案、核对多语言覆盖。

## 设置（`settings/`）

- [settings/SETTINGS_BACKENDS.md](settings/SETTINGS_BACKENDS.md)
  - 主题：前端设置后端抽象。涵盖 `tauri` / `localStorage` / `query` / `readonly` 四类 descriptor、事件驱动保存状态机、query adapter 注入和 pathRoute 接入边界。
  - 适用场景：新增设置 key；迁移 URL query 状态；排查设置保存态、web readonly 回弹、query 参数同步和 localStorage 迁移。

## 构建打包（`build/`）

- [build/PLATFORM_SHARED_LIBS.md](build/PLATFORM_SHARED_LIBS.md)
  - 主题：三平台动态库随包打包。`bin/{windows,linux,macos}/` 子目录约定、`OSPlugin.bundleLibs` 与 `verifyFFmpegBuildArtifacts` / `fixupMacOSAppBundle` / `fixupMacOSDmg`、Linux rpath `$ORIGIN/../lib/kabegame`、macOS install_name 改写为 `@executable_path/{相对路径}/Frameworks/...`、Tauri handlebars 动态注入 `linux.deb.files` 与 `macOS.frameworks`、Linux 不捆 libfuse 但仍 apt 依赖 `fuse3`(fusermount3)。
  - 适用场景：新增/升级运行时动态库;排查最终用户报 `libx264.so.X: cannot open` 或 macOS `Library not loaded`;调整 build-ffmpeg / DLL 复制 / dmg fixup 流程。

## 应用更新（`updater/`）

- [updater/AUTO_UPDATE_FLOW.md](updater/AUTO_UPDATE_FLOW.md)
  - 主题：桌面端 GitHub Release 自动更新全链路。**状态机 + 调度 + 下载 + 安装归后端权威**（`UpdaterService` 单例，仿 `OrganizeService`），前端镜像（`get_updater_state` hydrate + 事件刷新）。涵盖 6-phase 状态机（unchecked/checking/checked/updateAvailable/downloading/restartable）、`checking`/`downloading` 独占不可重入、restartable 重检保留、tag-only 版本比较 + `v` 前缀归一化、asset 平台/模式匹配、三事件（`updater-state-change`/`update-download-progress`/`update-download-error`）、平台安装差异（macOS `open` dmg 后退出 / Windows 跑 setup.exe / Linux 仅跳转）。
  - 适用场景：新增/排查更新流程与状态机；排查「下载途中刷新丢状态」「下载中仍能触发检查」「restartable 误降级」；调整 asset 匹配 / 平台安装；排查 NEW/重启按钮、changelog 弹窗、检查更新转圈。

## 维护规则

- 新增流程文档后，必须在本索引补充条目（链到具体文件路径 + 主题 + 适用场景）。
- 发生流程级改动时，先更新对应文档，再更新本索引描述（若语义有变化）。
