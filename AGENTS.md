# AGENTS.md

## 建议阅读：Cursor 规则

本仓库的 **Cursor** 约束位于 **`.cursor/rules/`**（`.mdc` 文件）中。它们是使用 Cursor 开展工作时的规范规则，会始终应用（或按路径范围应用）。

**进行实质性代码或配置修改之前：** 请阅读 `.cursor/rules/` 中适用于所编辑区域的 `.mdc` 文件（若范围不明确，则阅读全部文件）。如存在 `.claude/rules/`，也应将两者一并视为强制要求。

**约定发生变化时：** 同步更新 `.cursor/rules/` 和本 `AGENTS.md`，确保二者不存在冲突——在此处或导入文件中同步关键要求，并继续将 Cursor 规则作为编辑器强制行为的唯一事实来源。

这是代码库的索引。进行变更时，请记得同步更新这些文档。
@cocs/README.md

## 项目简介

Kabegame 是一款跨平台动漫壁纸爬取与管理工具，使用 **Tauri 2**（Rust 后端）和 **Vue 3** 构建。它支持 Windows、macOS、Linux、Android 和 web，**不支持 iOS**。爬虫插件使用 **JavaScript/TypeScript** 编写，运行于嵌入式 V8（deno_core）后端（或 WebView 后端）。

## 架构

### 单体仓库布局
- `apps/kabegame/` — Vue 3 前端（Vite、Pinia、UnoCSS、自有组件库）
- `packages/` — 共享前端包、自有组件库、插件开发子仓库与生成型包；详见 [packages/AGENTS.md](packages/AGENTS.md)
- `src-tauri/kabegame-core/` — `kabegame-core`：共享 Rust 库（爬虫引擎、插件系统、存储）
- `src-tauri/kabegame/` — Tauri GUI 应用（桌面端 + Android）
- `src-tauri/kabegame-cli/` — 无界面 CLI
- `src-tauri-plugins/` — 自定义 Tauri 插件（picker、pathes、share、compress、wallpaper、task-notification）
- `src-crawler-plugins/` — JS/TS 爬虫插件子仓库，一个单独的 pnpm workspace 根
- `third-patches/` — 带编号的补丁序列，用于保持 `third/` 子模块gitlink指向上游，但运行时附带仓库的补丁

### 关键架构规则
**进程模型**——Kabegame 运行时涉及以下进程：

| 进程 | 平台 | 职责 |
|---|---|---|
| `kabegame`（主应用） | 全平台 | **唯一的业务状态属主**：Storage、PathQL 查询引擎、任务调度（V8 插件在本进程内每任务独占线程运行）、事件广播、虚拟盘挂载（Dokan / FUSE 在进程内）。桌面端同时是 CEF browser 进程，并开 app IPC 服务端（Windows named pipe / Unix socket）与可选的应用 Web 服务器。启动时若检测到同数据目录已有实例，经 IPC 转发「显示窗口」/「导入 `.kgpg`」后立即退出 |
| `kabegame-cef-helper` | 桌面 standard | CEF 子进程，全部是主进程的直接子进程，由 `browser_subprocess_path` 派生、`--type=` 区分角色：`gpu-process`、`utility`（NetworkService / StorageService，按需再起 AudioService / VideoCaptureService 等）、`renderer`（每个 browser / 站点一个），**不持有任何业务状态**。CEF profile 目录 dev 为 `~/.cache/kabegame-cef-dev`、prod 为 `~/.cache/kabegame-cef`，所以 dev 与已安装版可同时运行、各带一套 helper。主界面、畅游窗口、WebView 爬虫任务窗口（`crawler-<task_id>`）都是主进程里的 CEF browser，页面跑在 helper renderer 中，经 Tauri IPC 回到主进程。位于 exe 旁（Linux release 为 `/usr/lib/kabegame/`）；Linux 禁用 zygote，每个 renderer 独立启动 helper |
| `kabegame-cli` | 桌面 | 独立进程。碰数据库或主程序运行时状态的操作优先经 app IPC 交给主程序；主程序未运行、协议不兼容或数据目录不同时才在本进程初始化，可用 `--via auto\|app\|local` 控制。`pathql query` 是只读例外：忽略 `--via`，总在本进程以不迁移的只读 Storage 执行 |
| 外部集成 | 桌面 | 通过 app IPC 或应用 Web 服务器（JSON-RPC / SSE / 媒体 / MCP）连接主程序，不直接碰数据库 |

形态差异：**Web 版**的 `kabegame` 以 `web` feature 构建为无 Tauri、无 CEF 的控制台服务器进程，浏览器即前端；**Android** 只有一个 app 进程（系统 WebView 的渲染进程由系统管理），不开 app IPC 服务端，也没有 CLI。

主进程内部，HTTP、Tauri、Web JSON-RPC 与 app IPC 只是协议入口，统一复用共享命令层，不建立平行业务后端；桌面端应用 Web 服务器复用 web JSON-RPC 注册表，并在同一端口提供 SSE、媒体文件与 MCP。相关类型、变量、事件、端点与文档统一使用 app / backend / IPC 语义。

**第三方补丁序列**——工作流与目录级约束见 [third-patches/AGENTS.md](third-patches/AGENTS.md)。

**组件库与 packages 子仓库**——维护边界和目录级约束见 [packages/AGENTS.md](packages/AGENTS.md)。

**文件类型的唯一事实来源：**
- `kabegame_core::media::image_type::MEDIA_FORMATS` 是唯一的格式表，包含格式键、标准 MIME 值、扩展名、别名和支持标志。`images.type` 存储 `image/jpg` 和 `video/mov` 等格式键；仅在需要标准 MIME 的边界（HTTP Content-Type / Android MediaStore）使用 `mime_from_format`。
- 在 Rust 中使用 `kabegame_core::media::image_type::*`（例如 `is_image_by_path`、`supported_image_extensions`），不要硬编码扩展名或 MIME 值。前端使用 `get_supported_image_types` Tauri 命令；其 `mimeByExt` 的值仍为标准 MIME。
- `supported_video_extensions()` 始终返回内置视频列表。前端 `isVideoMediaType` 通过检查 `type.startsWith("video/")` 决定图库展示。

**ImageGrid 视图写操作**——可能改变当前结果集的写操作必须经 `ctx.mutate` 携带可选 `view`（当前行路径），并立即应用后端返回的 `{ rows, seq }` 行快照；总数由计数路径的独立 live 状态维护，写后经 `dataChangeHub` 刷新。只改展示字段的操作走 `ctx.patch`，不得依赖事件回刷自身操作。带 `view` 的后端写命令必须在写库前取得 `GlobalEmitter::hold()`，行快照读完后才放行事件。被动 `images-change` / `album-images-change` 统一经 `dataChangeHub` / `liveQuery`。仅预览内的 `ImageLabelsPanel` 标签增删保留被动刷新例外，详见 `.cursor/rules/view-mutation.mdc`。

**画册数据按需查询**——前端不得持有全量画册列表或全量计数。树与选择器统一复用 app 侧 `AlbumTreeView` / `AlbumPicker`，按目录分页查询 `albums://`（过滤段 `parent/<id>` / `roots` / `album_kind/<kind>` / `search/<q>` 各折叠一条 where，多个类型用 `~any/.../~or/.../~end` 取 OR；末尾 `x<页大小>x/<页码>` 切页，默认按创建时间排序，分页节点不得重写过滤；搜索不另起平铺列表，树的每一层与 `~~/children` 都叠加 `search/<q>`——自身或子孙命中才保留，树形与展开态不变）；其它入口用 `services/albums.ts` 做单画册查询并订阅 `dataChangeHub`。计数：目录页一次三路 fetch——`<过滤段>/x<N>x/<页>` 取这一页的画册行；`…/~~/children[/<类型段>]` 与 `…/~~/images[/hide]` 在 `~~` 子查询边界之后按画册 `GROUP BY`，分别给出 `child_count`（同类型过滤下的直接子画册数，标签目录显示它）与 `image_count`（子树成员行数，标签叶子即直接图片数），没有行的画册计 0；口径与 `images://gallery/[hide/]album/<id>`、`album-tree/<id>` 的 entry 总数一致（e2e 逐项比对），`/hide` 对应 `hide/` 前缀；单画册入口仍用这两条 images:// 路径。`~~` 之后的逐行计数一律用 `group_by`，不要 `list_with_count`（每项再包一层 COUNT 会把整个结构重跑 N 次）；子树判断用 `ancestor_path` 前缀区间走索引（见 `cocs/provider-dsl/RULES.md` §2.1）。隐藏等全局过滤只能用路径表达，不得新增计数列、SQL 视图或专用计数命令。

**桌面端和 Android 端的视频导入都使用 rsmpeg/FFmpeg（仅排除 iOS）：**
- 桌面端构建（Windows/macOS/Linux 上的标准版/CLI）会链接 rsmpeg/FFmpeg，用于预览图压缩和视频尺寸读取（使用 `deno task build:ffmpeg` 产生的本机静态库）。
- **Android 也会链接 rsmpeg/FFmpeg**——aarch64 静态库由 `deno task build:ffmpeg --target android` 交叉编译（使用环境中的 NDK；输出位于已被 git 忽略的 `bin/android/arm64/FFmpeg-build/`，可通过命令重现，不会提交）。`rsmpeg`/`rusty_ffmpeg` 使用 `cfg(not(target_os = "ios"))` 条件门控。
- 预览格式因平台而异：**桌面端** = H.264 MP4（网格使用 `<video>`，悬停时自动播放）；**Android** = 10fps 动画 **GIF**（`run_ffmpeg_gif`：`fps,scale,palettegen,paletteuse`），因为 Android 网格不存在悬停交互，静态 `<video>` 帧没有作用——前端会将它显示在 `<img>` 中（`ImageContent.vue` 的 `mode==='gif'`）。Android FFmpeg 构建会启用 GIF 编码器/封装器以及 palettegen/paletteuse/fps 过滤器。
- Android 通过 `ContentIoProvider.open_fd(uri)`（PickerPlugin 中的 `openFileDescriptor().detachFd()`）读取 `content://` 视频，然后由 FFmpeg 打开 `/proc/self/fd/N`。绝不能将 `content://` URI 当作普通路径，也不能先将其落盘。视频**尺寸**仍来自 `ContentIoProvider.get_video_dimensions`（`MediaMetadataRetriever`），而非 FFmpeg。
- `mode-plugin.ts` 会注入 Android FFmpeg 环境（`FFMPEG_PKG_CONFIG_PATH`、`FFMPEG_LINK_MODE=static`、包含 NDK sysroot+target 的 `BINDGEN_EXTRA_CLANG_ARGS`、`PKG_CONFIG_ALLOW_CROSS=1`、NDK 交叉链接器/CC）。支持 `deno task check -c kabegame --mode android`（实际运行 `cargo check --target aarch64-linux-android`）。参见 `cocs/downloader-tasks/VIDEO_INGEST.md`。

**Android 模态层**——所有覆盖层（对话框、抽屉、ActionSheet、预览）都必须调用 `@/composables/useModalBack` 中的 `useModalBack(visibleRef)`，以便 Android 返回键按堆栈顺序关闭各层。该 composable 在桌面端为空操作；无论平台如何，都应在所有相关位置使用它。

### 样式
新样式应使用 **UnoCSS 工具类**（在 `uno.config.pub.ts` 和 `apps/kabegame/uno.config.ts` 中配置，使用 `presetWind3`——兼容 Tailwind 语法）。仅为复杂动画或第三方覆盖编写 `<style>` 块。将重复的类组合提取为 `uno.config.*.ts` 中的快捷方式。

### 平台特定说明
- **Windows/macOS/Linux**：使用虚拟磁盘（Dokan / macFUSE / FUSE）挂载图库
- **Windows/macOS/Linux 标准版**：使用 CEF runtime 后端。三个平台都会在构建时链接 CEF，并通过 exe 旁边的扁平 `kabegame-cef-helper` 启动子进程（macOS 开发模式运行裸可执行文件；release 包通过 `macOS.frameworks` 嵌入 framework，通过 `macOS.files` 嵌入 helper）。
- **Android 身份分离**：identifier（applicationId）按模式区分——dev 为 `app.kabegame.dev`，prod 为 `app.kabegame`（可并排安装）——而 Java package/源码树保持固定为 `app.kabegame`（`namespace`）。该能力由 fork 版 `cargo-tauri` 实现（上游 Tauri monorepo 位于 `third/tauri`，由 `third-patches/tauri` 修补——请先运行 `deno task patch tauri`；遵循 `TAURI_ANDROID_PACKAGE`；从 `crates/tauri-cli` 构建，并由 `TauriCliPlugin` 注入 PATH）。绝不要从 identifier 重新推导 Kotlin package 名。参见 `cocs/tauri/TAURI_CLI_FORK.md`。

### 爬虫插件开发
插件是 JS/TS 脚本（V8 后端，自包含 ES 模块 `export async function crawl`），打包为 `.kgpg` ZIP 归档。参见 `docs/PLUGIN_FORMAT.md` 和 `cocs/crawler/V8_RUNTIME.md`。新写或修改插件**用 `kabegame-plugin` skill**（`.claude/skills/kabegame-plugin/`）：先用探针逐环实测「页面 → 结构 → 媒体」链路，再写代码，V8 插件打包到 dev 插件目录后由 release CLI `plugin run <kgpg> --id <测试id>` 直接验证，WebView 插件在 dev app 内经 CDP 验证。使用以下命令构建：
```bash
deno task --cwd src-crawler-plugins package         # 打包所有插件
deno task --cwd src-crawler-plugins generate-index  # 重新生成插件商店索引
```

## 命令

所有顶层命令都通过 `scripts/run.ts`（基于 Tapable 的构建系统）执行，并使用 `deno task` 运行（Deno 2.9.0；克隆仓库后，请先运行 `deno install && deno task prepare`）。

### 开发
```bash
deno task dev -c kabegame                  # 启动开发服务器（Vite + Tauri，端口 1420）
deno task dev -c kabegame --mode local     # 开发模式，所有插件均在本地打包
deno task dev -c kabegame --mode android   # Android 开发模式
deno task dev -c kabegame --data prod      # 使用系统数据目录开发（而非仓库内的 .kabegame/debug/）
deno task dev:frontend            # 仅启动前端（不含 Tauri，端口 1420）
```

桌面三平台的 `deno task dev -c kabegame` 统一走 `tauri dev`；`kabegame-cef-helper` bin 在 dev 下由 ComponentPlugin `beforeBuild` 在主程序编译前先行构建（`tauri dev` 走 `cargo run`，无法同调用多编一个 bin）；build 下由 tauri.conf.json 顶层 `bins`（fork patch 0009，见 cocs/tauri/TAURI_CLI_FORK.md）驱动 `tauri build` 随主编译一并产出——cargo 收到逐个 `--bin` 而非 `--bins` 全量（cef-example 不进 release），Windows 的 helper 由 NSIS 原生装到安装根（不再 stage 进 resources/bin）。CEF framework 为构建期直链（`third/cef-rs` fork），经 `target/Frameworks` 符号链接（cef-dll-sys 自动创建，指向 `CEF_PATH`）由 dyld 解析；helper 是 exe 旁的扁平 `kabegame-cef-helper`，三平台一致。

### 构建
```bash
deno task b                            # 构建全部组件（kabegame + kabegame-cli）
deno task b -c kabegame                    # 仅构建主应用
deno task b -c kabegame --skip cargo       # 仅构建 Vue
deno task b -c kabegame --skip vue         # 仅构建 Cargo
deno task b --release                  # 将产物复制到 release/
deno task b -c kabegame --mode android     # 构建 Android APK/AAB（除非传入 --target/-t，
                                       # 否则 mode-plugin 会注入 --target aarch64；gen/android RustPlugin.kt 仅有 arm64 flavor）
deno task build:web                    # Web 发布版（demo.kabegame.com）：宿主机负责构建全部 JS（Vite 的 dist-kabegame-web
                                       # + 插件 .kgpg），docker（linux/amd64）通过 --skip vue 仅构建 Rust。
                                       # 前端输出目录按模式区分，必须保持独立：web →
                                       # dist-kabegame-web/（由 src/web_assets.rs 中的 include_dir! 嵌入），
                                       # desktop/android → dist-kabegame/。共用目录会导致桌面构建在宿主机与
                                       # 容器步骤之间悄然覆盖 Web 包。
                                       # 切勿在 x86_64 模拟容器中执行 JS 构建：Rosetta-for-Linux
                                       # 会在不报错的情况下把所有 V8 double 截断为整数部分（0.96→0），
                                       # 从而悄然破坏 sass/rollup 输出。参见脚本头部和 compose 文件。
```

对于仅含 Cargo 的 `kabegame-cli` 组件，`deno task b` 默认执行 **debug** 构建；传入 `--release` 才会执行 release 构建。主应用的桌面端/Android 构建始终通过 `tauri build`，无论是否传入 `--release` 都是 release 构建。

`kabegame-cli` 启用了 `kabegame-core` 的 `plugin-runtime`、`ipc-client` 和 `ipc-server` feature。`plugin run <id|path.kgpg>` 优先在同数据目录的主程序中执行（因此 app 模式支持 WebView）；回退本地模式时才在 CLI 进程初始化任务与事件运行时、执行 V8 插件。两种模式都支持已安装 id 与临时 `.kgpg` 路径，并在固定进度条上方渲染任务日志。CLI 没有运行时 `--data` 参数，数据目录只由构建时的 `kabegame_data` cfg 决定：插件开发请用 `deno task b -c kabegame-cli`（不带 `--release` 默认即 `--data dev`）构建并搭配 `kabegame-plugin` skill；需要强制隔离运行时加 `--via local`。参见 `apps/docs/src/content/docs/reference/cli.md` 与 `cocs/cli/CLI_IPC.md`。

在 macOS 上，两个二进制文件都是位于 `target/<profile>` 中的扁平 Cargo 产物；CEF framework 通过 cef-dll-sys 创建的 `target/Frameworks` 符号链接进行解析。参见 `src-tauri/tauri-runtime-cef/README.md`。

### 类型检查
**用 `check-kabegame` skill**（`.claude/skills/check-kabegame/`），不要手敲这些命令。
它包装 `deno task check`，落盘日志并从几百行 warning 里摘出真正的 error：
（vue-tsc 经 node 运行——`deno task` 下 vue-tsc 会退化为原版 tsc、静默漏掉所有 `.vue` 错误，详见该 skill 的 `SKILL.md`。）

```bash
.claude/skills/check-kabegame/driver.sh              # vue-tsc + cargo check
.claude/skills/check-kabegame/driver.sh --skip cargo # 只查前端类型（秒级）
.claude/skills/check-kabegame/driver.sh --skip vue   # 只查 Rust
```

Android（`--mode android --skip vue`）使用 fork 版的 `cargo tauri android check`（NDK
工具链来自 cargo-mobile2，与构建保持一致），需要环境中的 NDK + `deno task build:ffmpeg
--target android` + `bin/android/arm64/rusty_v8-build/` V8 产物；详细信息与注意事项见该 skill 的 `SKILL.md`。

### 测试
统一入口是 **`deno task test -c <组件>`**，同时覆盖后端 cargo test 与前端 vitest，
用 `--skip vue` / `--skip cargo` 各自关掉一侧（与 `deno task check` 同约定）。

**后端**：**用 `test-kabegame` skill**（`.claude/skills/test-kabegame/`），
不要手敲裸 `cargo test`（缺 FFmpeg/CEF 环境变量会编译失败）。

```bash
.claude/skills/test-kabegame/driver.sh kabegame-core --lib kgpg   # 按名过滤 core 单测
.claude/skills/test-kabegame/driver.sh kabegame-cli               # cli 全部测试
```

driver 封装了 `deno task test -c <crate> --skip vue`（crate：kabegame | kabegame-cli |
kabegame-core），剩余参数自动补 `--` 传给 cargo test；全量套件有约 20 个既有失败，
验证改动请按名过滤。它固定只跑 Rust——把前端混进来会污染它按 `N passed` 累加的汇总。

**前端**（vitest）：

```bash
deno task test -c kabegame --skip cargo             # 跑应用查询模型与 Vue 组件的 Vitest 测试
deno task --cwd apps/kabegame test:watch            # watch 模式，改哪跑哪
```

前端只有 `apps/kabegame` 一个应用包（原 `@kabegame/core` 已并入它的 `src/`），
`kabegame-core` 现在只是 Rust crate `src-tauri/kabegame-core`，没有前端那一半。

测试文件就近放（`src/**/*.test.ts`）。各包自己的 `vitest.config.ts` **从
`vite.config.pub.ts` 取 `define` / `resolve` / `css`**——平台常量（`__WEB__` 等）由
ModePlugin 注入的环境变量算出，测试环境必须与应用一致，不要在测试配置里另写一套。
新增前端包要接测试时：在 `Component.feTestDir` 登记目录、给 package.json 补 `test`
脚本、拷一份 `vitest.config.ts`，并补一个两行 re-export 的 `uno.config.ts`（UnoCSS
按 cwd 查找它，缺了会刷 config-not-found 并退回默认配置）。

### 数据目录模式（`--data`）
- `dev`（`deno task dev` 与不带 `--release` 的 `deno task b` 的默认值）：使用仓库内的 `.kabegame/debug/data`、`.kabegame/debug/cache` 和 `.kabegame/debug/tmp` 目录——与已安装应用隔离
- `prod`（带 `--release` 的 `deno task b`，以及 `start` / `check` / `test` 的默认值）：使用系统用户数据目录（Windows 上为 `%LOCALAPPDATA%\Kabegame`，Linux/macOS 上为 `~/.local/share/Kabegame`）
- 开发时使用 `--data prod` 可针对实际安装数据进行测试；release 构建中使用 `--data dev` 可实现 CI/测试隔离
- 由 `src-tauri/{kabegame-core,kabegame}/build.rs` 注入的 `kabegame_data` Rust cfg 控制

### 其他
```bash
deno task format                 # Prettier 格式化前端源码（apps/ 与 packages/ 的代码文件）
                                 # 规则见 .cursor/rules/code-formatting.mdc；packages 范围与排除项
                                 # 见 packages/AGENTS.md
deno task format:check           # 同上但只检查不写入（prettier --check），退出码非 0 即有文件不合规
deno task pathql:generate        # 生成 PathQL 客户端 packages/kabegame-pathql-client/index.ts
                                 # 生成方式与入库边界见 packages/AGENTS.md
deno task patch deno             # 将 third/deno 重置到干净基线，然后应用完整补丁序列
deno task patch deno -r          # 将 third/deno 重置到干净基线
deno task patch --all --check    # 试运行所有由补丁管理器管理的 third-patches/* 序列
deno task build:ffmpeg           # 从源码构建 x264（third/x264）+ FFmpeg libav* 库（本机）
                                 # x264 已内置（无需系统 libx264）；Linux 构建使用
                                 # 执行标准/CLI Cargo 构建前必须先运行此命令。
                                 # 输出：bin/{platform}/{arch}/{FFmpeg,x264}-build/（已被 git 忽略）。
                                 # Linux 上仅允许 Ubuntu 22.04（glibc 最低版本 2.35，
                                 # 参见 cocs/build/LINUX_BUILD_WORKFLOW.md）；可用 KB_ALLOW_HOST_BUILD=1 绕过。
CEFBUILD=~/kabegame-cefbuild deno task build:chromium  # 从 third/cef 构建 CEF/Chromium（耗时数小时）。
                                 # 输出：bin/{platform}/{arch}/cef-build/，mode-plugin 在
                                 # dev/check/test/build 中均会将 CEF_PATH 解析到此处。仅有一个
                                 # 构建配置（官方构建 + PGO）
                                 # workspace（约 60GB，已被 git 忽略）必须位于所有 node_modules 之外：
                                 # Chromium 的树内 TS 构建会向上遍历 node_modules，且不识别仓库
                                 # 边界，因此放在本仓库下的 workspace 会将裸导入解析到
                                 # <repo>/node_modules，并导致 //ui/webui/resources/tools/eslint:build_ts 失败。
                                 # 预检保护会拒绝默认 CHROMIUM_DIR（third/chromium/）；
                                 # 参见 src-tauri/tauri-runtime-cef/README.md。请用同卷 mv 移动现有 checkout
                                 # （即时重命名，无需复制 60GB）。
deno task build:ffmpeg --target android  # 通过环境中的 NDK（NDK_HOME 等）交叉编译 aarch64 FFmpeg
                                 # 输出到已被 git 忽略的 bin/android/arm64/FFmpeg-build/（可通过
                                 # 命令重现，不提交）。执行 Android Cargo 构建/检查前必须先运行此命令。
```

### 验证流程
**不要运行 `cargo build` / `tauri build` / `deno task b` 来验证改动**——应调用 **`check-kabegame` skill**（`.claude/skills/check-kabegame/driver.sh`，可使用 `--skip vue` / `--skip cargo` 缩小范围）。对于小型改动，编辑器 lint 诊断同样有效。仅在用户明确要求时才进行构建。注意：应用实例运行时，`check` 会以 `os error 32` 失败（`cef-dll-sys` 的构建脚本会将 CEF runtime 复制到 `target/`）——请先终止 `kabegame.exe`。规则见 `.cursor/rules/verify-by-lint.mdc`。

**调试是例外——应实际运行目标。** Lint 无法证明运行时行为。诊断缺陷时：先测量对象的实际状态，再解释症状；跟踪真实调用链，并在每一环验证实际值（尤其是 Rust↔CEF、前端↔Tauri、主进程↔子进程）；优先采用零成本实验（现有二进制文件 + 环境变量 / Chromium `--disable-features=<Name>` / 现有 `[DEBUG-*]` 日志），而不是编辑代码；SQLite / PathQL 查询可设 `KABEGAME_SQL_DEBUG=1`，在 stderr 查看绑定参数已展开的实际 SQL 与每条耗时；在运行实验之前先写下证伪标准；逐字引用源码，不要在引文内嵌自己的注释。结论的成本越高（修补 vendored 库、重建 Chromium、大规模重构），所需的经验证据就应越充分。规则见 `.cursor/rules/debug-empirically.mdc`。

### 计划与变更说明格式
编写计划或描述代码变更时，按明确的**点**来组织内容。每个点下面按**新增 / 修改 / 删除**分组，每项可选择附带缩进说明。将现状与变更分开：
- **总体设计思路**必须放在**最前面**，位于现状锚点之前。应使用散文，而非检查清单——用几段话说明方案的整体形态：新机制是什么、组件边界如何移动、变更后数据向哪个方向流动，以及支撑整个设计的关键决策与其理由。读者必须能在读完该节后直接停下，并正确解释这个设计。不要以现状或点 1 开头。
- **现状**部分展示从实际代码中截取的代码块（不能只写 `file:line`），并通过注释说明**代码当前的样子**（而不是将要发生的变更）。
- **实施方案**中的各点应包含目标代码块，并用注释准确标出新增、修改或删除的内容。

````md
### 总体设计思路
把 `Foo` 的进度从「writer 自己算」改成「writer 上报、reader 汇总」:writer 只在 `Foo`
里累加已写字节,不再持有 UI 相关状态;汇总与展示全部下沉到 reader 侧。
关键决策:进度字段放在 `Foo` 而非新建并行结构,因为 `Foo` 已经是该数据的唯一属主,
新建结构会带来两份状态需要同步。

### 现状锚点
**a. `Foo`**(`foo.rs:64`)
```rust
struct Foo {
    bar: u32,   // 现状:只有 bar,没有进度字段
}
```

### 点 1 — 给 `Foo` 加字段(`foo.rs`)
- **修改**
  - `Foo` 增加 `received: u64`。
    > 说明:供 writer 上报进度。
```rust
struct Foo {
    bar: u32,
    received: u64,   // 新增
}
```
````
对主仓库在进行更改后要把回归补充到 [回归文档](versions/latest/regression.md)，格式参考 [4.5.1版本回归](./versions/v4.5.1/regression.md). 以及一行 [changlog](versions/latest/changelog.md)

对插件的更改要写到 [插件changelog](./src-crawler-plugins/CHANGELOG.md)，插件仓库版本号 4.5.1.x 表示在主应用发版 4.5.1 和 4.5.2 之间的迭代版本。如果主应用发版到 4.5.2 就会跟着更新到 4.5.2，然后如果继续更新就是 4.5.2.1。src-crawler-plugins/package.json 里的 version 是其最新版本。

在需要的时候用 `.claude/skills/kabegame-chromium` 技能连接正在运行的程序。

## 语言规范
所有与用户的交流均使用简体中文。
任务计划、进度说明、问题分析、调试结论和最终回答均使用中文。
工具调用前后的说明使用中文。
代码标识符、终端命令、文件路径、API 名称和原始错误信息保持原语言。
代码注释默认使用中文，除非当前项目已有明确的英文注释规范。
不要因为代码库、日志或文档是英文而切换成英文回答。
