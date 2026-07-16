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
  - 主题：VD 作为 Provider DSL 引擎**消费者**的落地方案。涵盖 i18n 路径分发（`i18n-<locale>` 静态层 + 每语言独立 router）、插件维度的 `get_plugin` SQL 函数桥（主机注册的 SQL 函数把 PluginManager 元数据和按 locale 解析的 `displayName` 接入 SQL 上下文）、`vd_plugins_router` 与 `plugins_provider` 双层结构、典型路径折叠示例。
  - 适用场景：新增 / 修改 VD 维度路径树；接入需要主机协调的非 SQL 数据；理解 i18n 切换、插件装卸的缓存行为。

- [provider-dsl/ALBUM_SUB_TREE.md](provider-dsl/ALBUM_SUB_TREE.md)
  - 主题：`albums://by_sub_tree` 的按名称递归画册树查询，以及 CLI `--album` 通过父路径直接子项解析目标画册 id 的契约。
  - 适用场景：导入图片时按 `/父画册/子画册` 定位画册；新增或排查 albums 子树 PathQL 路由。

## 画廊与查询（`gallery/`）

- [gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
  - 主题：Gallery/VD 共用的 Provider + ImageQuery 可组合查询系统（**当前 Rust 实现**；未来由 DSL 替代，参见 provider-dsl/）。
  - 适用场景：新增过滤、排序、数据源；理解 `JOIN/WHERE/ORDER` 组合方式；排查 provider 查询路径问题。

- [gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md](gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md)
  - 主题：画廊 SimplePage 分页与每页条数（100/500/1000）的前后端数据流、设置持久化、`browse_gallery_provider` 与 `invoke` 参数约定；**列表不带 `metadata`**、`get_image_metadata` 与前端 per-page 缓存；**`images-change`（images 表）与 `album-images-change`（album_images 表）** 事件拆分与前端/Plasma 订阅要点。
  - 适用场景：排查翻页/offset、每页条数切换不刷新、列表加载失败；区分 SimplePage 与 VD Greedy 的 `LEAF_SIZE` 行为；排查画册/任务/畅游视图刷新与事件过滤；排查详情区插件描述/metadata 未显示或缓存未失效。

## 下载与任务（`downloader-tasks/`）

- [downloader-tasks/DOWNLOADER_FLOW.md](downloader-tasks/DOWNLOADER_FLOW.md)
  - 主题：当前下载器全链路与模块边界。涵盖 `mod.rs` scheme registry / `queue.rs` worker / `content.rs` Android content downloader 的分工，`download_with_retry` 通过 `DownloadSink` 溢写（5 MiB 阈值）返回 `DownloadOutcome`（Bytes/Path）、Fatal/Retriable/Resumable 三级错误重试、crawler/surf 共享的 blob/data/MSE 分块上传通道、MSE 多流上传与桌面合流、DRM 拒绝、统一 `postprocess_downloaded_image`（`PostprocessSource` 枚举）、URL 与 hash 两级去重、桌面落盘、Android MediaStore copy 与 content URI 沿用、失败重试、任务计数经 `tasks-change` / `TaskChanged` diff 同步、`Task.cancel` 取消语义、启动临时文件清理以及 **`images-change` / `album-images-change`** 事件。
  - 适用场景：下载任务生命周期、Android `content://` 与 HTTP/HTTPS 下载差异、JS 爬虫或畅游窗口的 `blob:` / `data:` / MSE 媒体下载、MSE 多 SourceBuffer 合流、失败重试、状态流转问题；任务 success/deleted/failed/dedup 计数与前端同步；排查下载后列表/画册未刷新。

- [downloader-tasks/VIDEO_INGEST.md](downloader-tasks/VIDEO_INGEST.md)
  - 主题：视频摄入（下载/导入压缩）的平台门控机制。桌面 standard/CLI 使用 rsmpeg/FFmpeg；Android 走 Kotlin `AndroidVideoCompressProvider` 与系统媒体 API，不编译 FFmpeg。画廊播放始终可用（HTML `<video>`，无需 FFmpeg）。
  - 适用场景：新增视频处理调用点；排查桌面 FFmpeg 构建环境；排查 Android content URI 视频预览/维度读取；理解 `deno task build:ffmpeg` 与桌面构建的关系。

- [downloader-tasks/TASK_DRAWER_LOAD.md](downloader-tasks/TASK_DRAWER_LOAD.md)
  - 主题：任务抽屉分页加载、触底加载与相关数据流。
  - 适用场景：任务数量多时打开抽屉卡顿、loadTasksPage 与 get_tasks_page 行为。

## 爬虫（`crawler/`）

- [crawler/CRAWLER_JS_FLOW.md](crawler/CRAWLER_JS_FLOW.md)
  - 主题：Crawler JS 执行链路与相关模块关系，含提交时冻结 `Task/TaskParams`、内建 `local-import` 插件化及后端展示元数据、`get_plugins` 追加内建且前端管理列表过滤、web 本地导入入口移除、每任务独立 WebView 窗口、media_capture/media_download/bootstrap initialization scripts、Task 内 page stack/state/`TaskResult` completion、worker await completion、按 `crawler-<task_id>` label 路由命令。
  - 适用场景：调度、注入、抓取流程排查与扩展；排查 JS 任务并发、窗口创建/销毁、IPC 路由、Task 注册表状态、`ctx.downloadImage` 对 blob/data/MSE 的分流、多流上传、DRM 拒绝与桌面合流。

- [crawler/PIXIV_METADATA.md](crawler/PIXIV_METADATA.md)
  - 主题：Pixiv Rhai 插件 `metadata.body` 白名单入库与 DB 一次性迁移。
  - 适用场景：排查画册列表因 metadata 过大变慢、扩展 EJS 所需字段。

- [crawler/PIXIV_RANKING_RHAI.md](crawler/PIXIV_RANKING_RHAI.md)（历史，Rhai 已移除）
  - 主题：Pixiv 排行榜模式的 `config.json` 三维度、`ranking_date`、按接口 `next` 分页与 `warn`。
  - 适用场景：扩展/排查排行榜爬取、R18 与 `x-user-id`、理解列表分页语义。

- [crawler/PLUGIN_DATA.md](crawler/PLUGIN_DATA.md)
  - 主题：爬虫插件私有 JSON 缓存 `plugin_data`，含 Rhai 读写 API、`description.ejs` 只读 bridge、隔离和卸载清理语义。
  - 适用场景：插件需要缓存 tag taxonomy、emoji 元数据、token、TTL 状态，或在描述模板中读取爬虫预先计算的数据。

- [crawler/METADATA_MIGRATION.md](crawler/METADATA_MIGRATION.md)
  - 主题：插件图片 metadata 迁移流程——`kbMetadataMigration` 单一脚本契约（ES module，export migrate；裸 deno_core JsRuntime；schema 自检幂等、一步到位）+ packed 插件版本门控（`image_metadata.plugin_version`，每字节一段，应用维护、插件不可读写，写入自动盖章）、`image_metadata` 去重合并、`metadata_full` 查询路径与 `metadata-migrate` 事件作用域。
  - 适用场景：插件升级后历史图片详情结构变化；排查 metadata 迁移失败、缓存未刷新、去重合并、版本编码（a.b.c 每段 ≤255）问题。

- [crawler/V8_RUNTIME.md](crawler/V8_RUNTIME.md)
  - 主题：V8 爬虫运行时（桌面 + Android/aarch64，仅 iOS 不支持）的 Web 平台全局与 `Kabegame.*` 宿主桥。涵盖 `plugin-runtime` feature 门控（主 app 启用、CLI 排除 deno/rusty_v8）、标准 `fetch` 使用、任务请求头合并、相对 URL 解析差异、SDK 保留工具模块；**运行时架构**（设备端共享 baseline startup snapshot 缓存、fresh fallback、指纹/V8 版本/CRC 校验、`deno_crypto` cppgc restore 后初始化）；**网络宿主化**（`op_kabegame_fetch`/`op_kabegame_to` 走 `reqwest`，不引入 `deno_fetch`/`deno_net`/`deno_tls`，`Response`/`Headers` 在 `prelude.js` 自实现）；**Android 交叉编译**（官方无 Android 预编译，仓库自带 `bin/android/` 自建产物 + mode-plugin 注入 `RUSTY_V8_ARCHIVE`/`RUSTY_V8_SRC_BINDING_PATH`、`V8_FROM_SOURCE` 自建流程、NDK libc++、`RustPlugin.kt` ABI 收敛、无 WebView 后端）。
  - 适用场景：编写/迁移 V8 插件；排查 startup snapshot 生成/失效/fallback、`Kabegame.*`、`fetch`、`URL`、`crypto`、`DOMParser`；更新 JS 插件模板和类型声明；排查 V8 后端 Android 交叉编译（依赖门控 / 自建预编译产物 / NDK 链接）或网络/`Response`/`Headers` 行为。

- [../third-patches/deno/README.md](../third-patches/deno/README.md)
  - 主题：`deno_core` 的上游 vendor base 与 kabegame patch series。`third/deno` = `denoland/deno` monorepo submodule（pin `v2.9.0`，`libs/core` 与 crates.io deno_core 0.405.0 逐字节一致），经 `[patch.crates-io] deno_core = third/deno/libs/core` 单一来源消费；3 个 patch（扩展 JS 内嵌 / 共享 V8 platform 初始化 / Android Bionic errno）作用于 `libs/core`，`deno task patch deno` 应用。`serde_v8`/`deno_ops` 作为 monorepo path 依赖单份解析（无 path-vs-registry 重复）。
  - 适用场景：新 checkout 后准备构建 V8 后端（先 `deno task patch deno`）；升级 deno_core 版本 re-vendor；排查 deno_core patch 应用/漂移或 serde_v8/deno_ops 解析来源。

- [../third-patches/rusty_v8/README.md](../third-patches/rusty_v8/README.md)
  - 主题：Android 版 `librusty_v8` 自建产物的可复现构建。`third/rusty_v8` = `denoland/rusty_v8` submodule（pin `v149.4.0` = Cargo.lock 的 v8）是**就地复用的胖构建树**（nested submodules + 已编译 target/ 都在其中，增量复用、不重拉/重编，`ignore = dirty`）。`deno task build:v8`（`scripts/build-v8.sh`，仅 Linux）幂等应用补丁并构建：补丁是 `third-patches/rusty_v8/` 顶层 `*.patch`，均 `git -C third/rusty_v8 apply`（0002 路径带 `build/` 前缀，跨进嵌套 build 子模块），**由 build-v8.sh 应用而非 `deno task patch`**——patch-manager 现只对**纯净树** forward、对**脏树** reverse（幂等），本胖树常驻脏态故被跳过。产物 `bin/android/*.a + src_binding.rs` gitignore、不入库。**`v8` 不经 `[patch.crates-io]`**——git 仓缺发布版的 `gen/` binding，patch 会破坏桌面构建；app 构建仍用 crates.io v8 + 注入 archive/binding。`scripts/utils.sh` 为 build-*.sh 共用（strict mode / os 检查 / log·die）。
  - 适用场景：Linux 上复现/增量重建 Android v8 产物；升级 v8/deno_core 后重建；排查补丁应用（含跨嵌套子模块）、patch-manager 纯净度门控、from-source fixup、GN/NINJA、bindgen/LIBCLANG（clang19）或 mode-plugin 注入。

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

- [tauri/TAURI_CLI_FORK.md](tauri/TAURI_CLI_FORK.md)
  - 主题：fork 的 `cargo-tauri`（上游 tauri monorepo `third/tauri` + `third-patches/tauri` patch series，基线 2.11.2；先 `deno task patch tauri`）。顶层 `bins` 配置（patch 0009）驱动桌面 `tauri build` 的 cargo `--bin` 编译清单（不再 `--bins` 全量编译；未配置回退 get_binaries 打包清单），Windows 下辅助 bin 由 NSIS 原生装到安装根。`TAURI_ANDROID_PACKAGE` 将 Android Java 包（源码目录/生成 Kotlin/JNI）与 identifier（applicationId，按 mode：dev=`app.kabegame.dev` / prod=`app.kabegame`）解耦，auto-launch 改传全限定类名；`TAURI_NO_WEBKIT_DEPS` 跳过 Linux deb/rpm 的 webkit 依赖注入并对依赖去重。含 TauriCliPlugin 接线（PATH 前置 + dev/build 前增量构建）与升级 re-vendor 流程。整个 tauri 栈经 `[patch.crates-io]` 指向 `third/tauri/crates/*`（单一来源，另见 [../third-patches/tauri/README.md](../third-patches/tauri/README.md)）。
  - 适用场景：android dev/prod 真机并存隔离；排查 `Project directory ... does not exist`、auto-launch 拉起失败、`BuildConfig` 解析错误；升级 tauri-cli 版本；排查 deb 包 webkit 依赖或 Depends 重复。

- [../src-tauri/tauri-runtime-cef/README.md](../src-tauri/tauri-runtime-cef/README.md)
  - 主题：Windows/macOS/Linux 桌面 CEF runtime 后端的架构、平台门控与 CEF Views/windowed GPU 路径；自定义协议、page-load 生命周期与 `invoke` IPC 桥接；Windows manifest 与 runtime 安装；`kabegame` package 内的扁平 `kabegame-cef-helper` 子进程、macOS 构建期直链 framework 与裸 exe dev 运行、CefAppProtocol external pump、release 打包，以及 CEF 上游 pin/patch series 维护流程。
  - 适用场景：排查桌面 CEF 启动/渲染/IPC、升级 CEF/Chromium（官方 pin + patch series re-vendor）、调整 `tauri-runtime-cef` trait 适配；排查 Windows GPU 子进程、macOS 裸跑子进程起不来/窗口空白/黑屏、message pump，或三平台 CEF_PATH 解析与打包。

- [../third-patches/cef/README.md](../third-patches/cef/README.md)
  - 主题：CEF 官方上游 vendor base、Kabegame 编号 patch series、`deno task patch` 原子 apply/reverse 命令与 re-vendor 流程。
  - 适用场景：新 checkout 后准备自编 CEF；升级 CEF 7827 pin；修复 Chromium 上游变化导致的 patch context 漂移。

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
  - 主题：前端设置后端抽象。涵盖 `tauri` / `localStorage` / `query` / `readonly` 四类 descriptor、getter-only tauri key 的 `refresh(key)` 单键读取、事件驱动保存状态机、query adapter 注入和 pathRoute 接入边界。
  - 适用场景：新增设置 key；新增运行时状态类单键刷新；迁移 URL query 状态；排查设置保存态、web readonly 回弹、query 参数同步和 localStorage 迁移。

## 壁纸（`wallpaper/`）

- [wallpaper/NATIVE_WALLPAPER_COMPAT.md](wallpaper/NATIVE_WALLPAPER_COMPAT.md)
  - 主题：Linux / Windows 原生壁纸的图片格式兼容层。涵盖独立的 `wallpaper_compatible_path`、惰性 JPEG/PNG 转码与复用、样式重应用路径、best-effort 回退，以及删除图片时对兼容副本的安全清理。
  - 适用场景：排查 GNOME/Windows 设置 WebP、AVIF、HEIC、HEIF 后壁纸空白；扩展原生壁纸格式白名单；维护兼容副本生命周期。

## 构建打包（`build/`）

- [build/PLATFORM_SHARED_LIBS.md](build/PLATFORM_SHARED_LIBS.md)
   - 主题：三平台动态库与 CEF 运行时打包。涵盖 `OSPlugin.bundleLibs`、`kabegame-cef-helper` 的编译方式（build 经 `tauri build -- --bin` 随主编译产出；dev 与 Windows build 由 ComponentPlugin 预构建）、主程序/helper 的 Linux rpath 差异、macOS framework/files 注入、Windows NSIS 搬运，以及虚拟盘驱动/系统依赖策略。
  - 适用场景：新增/升级运行时动态库;排查最终用户报 `libx264.so.X: cannot open`、macOS `Library not loaded` 或画册盘驱动缺失;调整 build-ffmpeg / DLL 复制 / dmg fixup / NSIS hook 流程。

- [build/LINUX_BUILD_WORKFLOW.md](build/LINUX_BUILD_WORKFLOW.md)
  - 主题：**本机 Linux 发布构建工作流**——因本机 glibc 2.43 太新，出货用的 `.deb` 在 Ubuntu 22.04 VM（glibc 2.35）里做最终链接（不重编 CEF/Chromium/V8）。涵盖 VM/virtiofs 环境（源码挂到与 host 相同路径）、隔离 `CARGO_TARGET_DIR=target-22`、`.vm/` 环境与一键 `run-build3.sh`、`TARGET_DIR` 单一来源、glibc 地板验证；以及踩坑：**预编译 `.a` 的 `__isoc23_*`（2.38 新名符号、无版本标签、易漏判）必须重编 x264+FFmpeg**、`.pc` 烧死的 host 绝对路径、构建脚本写死 `target/release`、`package-plugin.ts` 误跑 host cli。
  - 适用场景：出货 Linux deb（标准流程）；判断某个预编译 `.a`（x264/FFmpeg/v8）能否跨 glibc 复用；排查 `version 'GLIBC_2.xx' not found`、`undefined symbol: __isoc23_*`、`.pc` prefix 失效、`CARGO_TARGET_DIR` 未被某脚本尊重；复现/维护 22.04 构建 VM。

## 应用更新（`updater/`）

- [updater/AUTO_UPDATE_FLOW.md](updater/AUTO_UPDATE_FLOW.md)
  - 主题：桌面端 GitHub Release 自动更新全链路。**状态机 + 调度 + 下载 + 安装归后端权威**（`UpdaterService` 单例，仿 `OrganizeService`），前端镜像（`get_updater_state` hydrate + 事件刷新）。涵盖 6-phase 状态机（unchecked/checking/checked/updateAvailable/downloading/restartable）、`checking`/`downloading` 独占不可重入、restartable 重检保留、tag-only 版本比较 + `v` 前缀归一化、asset 平台/模式匹配、三事件（`updater-state-change`/`update-download-progress`/`update-download-error`）、平台安装差异（macOS `open` dmg 后退出 / Windows 跑 setup.exe / Linux 仅跳转）。
  - 适用场景：新增/排查更新流程与状态机；排查「下载途中刷新丢状态」「下载中仍能触发检查」「restartable 误降级」；调整 asset 匹配 / 平台安装；排查 NEW/重启按钮、changelog 弹窗、检查更新转圈。

## 维护规则

- 新增流程文档后，必须在本索引补充条目（链到具体文件路径 + 主题 + 适用场景）。
- 发生流程级改动时，先更新对应文档，再更新本索引描述（若语义有变化）。
- **third-patches 追加式原则**：已入库的 `third-patches/<dir>/NNNN-*.patch` 一律不改不删，只在系列末尾追加新编号 patch（唯一例外是 re-vendor 整体重生成）。拉取到新增 patch 后用 `deno task patch <dir> --from <N>` 重同步（`.husky/post-merge` 钩子自动执行）。详见 [.cursor/rules/third-patches-append-only.mdc](../.cursor/rules/third-patches-append-only.mdc)。
