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
- `packages/kabegame-element-plus/`、`packages/kabegame-element-plus-icons/` — vendored 的 element-plus 与图标，作为**自有组件库**的 fork 维护（见下文）
- `packages/` — 共享前端包（`core`、`i18n`、`image-type`）
- `src-tauri/kabegame-core/` — `kabegame-core`：共享 Rust 库（爬虫引擎、插件系统、存储）
- `src-tauri/kabegame/` — Tauri GUI 应用（桌面端 + Android）
- `src-tauri/kabegame-cli/` — 无界面 CLI
- `src-tauri-plugins/` — 自定义 Tauri 插件（picker、pathes、share、compress、wallpaper、task-notification）
- `src-crawler-plugins/` — 打包为 `.kgpg` 归档的 JS/TS 爬虫插件（V8 后端）
- `third-patches/` — 带编号的补丁序列，用于保持 `third/` 子模块干净且接近上游

### 关键架构规则
**路径逻辑归属于 `tauri-plugin-pathes`**——所有路径/目录计算都必须放在 `src-tauri-plugins/tauri-plugin-pathes/` 中。其他模块通过 `AppPaths` 调用；切勿在其他位置硬编码或重新计算路径。

**第三方补丁序列**——Kabegame 对 vendored `third/` 仓库的改动应放在对应的 `third-patches/<dir>/NNNN-*.patch` 文件中。对于由补丁管理器管理的仓库，`deno task patch <dir>` 会将子模块重置到干净的锁定基线，然后按文件名排序应用完整补丁序列；`deno task patch <dir> -r` 会执行重置，但不应用补丁。因为每次操作都从基线开始，所以可以修改、删除或重新编号补丁文件。`--check` 会在一次性 worktree 中预检按顺序排列的补丁序列。重置会丢弃子模块中未提交的工作，因此请先将本地 `third/` 开发内容提交到分支。`rusty_v8` 是唯一的手动例外（它是原地复用的大型构建树，补丁由 `scripts/build-v8.ts` 应用），详见 `.cursor/rules/third-patches-workflow.mdc`。`cef` 遵循标准流程——`automate-git.py` 只认可提交，但 `scripts/build-chromium.ts` 会自动将应用补丁后的 worktree 暂存到 `kabegame-build` 分支，因此 `third/cef` 的 gitlink 始终指向官方上游锁定点。

**脚本仓库路径**——`scripts/paths.ts` 是 `ROOT`、`THIRD_DIR`、目标架构及 `bin/{platform}/{arch}/{repo}-build` 这些内容的轻依赖唯一事实来源；`scripts/utils.ts` 重新导出这些符号以保持现有导入界面，构建插件不得自行重新计算。

**文件类型的唯一事实来源：**
- `kabegame_core::media::image_type::MEDIA_FORMATS` 是唯一的格式表，包含格式键、标准 MIME 值、扩展名、别名和支持标志。`images.type` 存储 `image/jpg` 和 `video/mov` 等格式键；仅在需要标准 MIME 的边界（HTTP Content-Type / Android MediaStore）使用 `mime_from_format`。
- 在 Rust 中使用 `kabegame_core::media::image_type::*`（例如 `is_image_by_path`、`supported_image_extensions`），不要硬编码扩展名或 MIME 值。前端使用 `get_supported_image_types` Tauri 命令；其 `mimeByExt` 的值仍为标准 MIME。
- `supported_video_extensions()` 始终返回内置视频列表。前端 `isVideoMediaType` 通过检查 `type.startsWith("video/")` 决定图库展示。

**桌面端和 Android 端的视频导入都使用 rsmpeg/FFmpeg（仅排除 iOS）：**
- 桌面端构建（Windows/macOS/Linux 上的标准版/CLI）会链接 rsmpeg/FFmpeg，用于预览图压缩和视频尺寸读取（使用 `deno task build:ffmpeg` 产生的本机静态库）。
- **Android 也会链接 rsmpeg/FFmpeg**——aarch64 静态库由 `deno task build:ffmpeg --target android` 交叉编译（使用环境中的 NDK；输出位于已被 git 忽略的 `bin/android/arm64/FFmpeg-build/`，可通过命令重现，不会提交）。`rsmpeg`/`rusty_ffmpeg` 使用 `cfg(not(target_os = "ios"))` 条件门控。
- 预览格式因平台而异：**桌面端** = H.264 MP4（网格使用 `<video>`，悬停时自动播放）；**Android** = 10fps 动画 **GIF**（`run_ffmpeg_gif`：`fps,scale,palettegen,paletteuse`），因为 Android 网格不存在悬停交互，静态 `<video>` 帧没有作用——前端会将它显示在 `<img>` 中（`ImageContent.vue` 的 `mode==='gif'`）。Android FFmpeg 构建会启用 GIF 编码器/封装器以及 palettegen/paletteuse/fps 过滤器。
- Android 通过 `ContentIoProvider.open_fd(uri)`（PickerPlugin 中的 `openFileDescriptor().detachFd()`）读取 `content://` 视频，然后由 FFmpeg 打开 `/proc/self/fd/N`。绝不能将 `content://` URI 当作普通路径，也不能先将其落盘。视频**尺寸**仍来自 `ContentIoProvider.get_video_dimensions`（`MediaMetadataRetriever`），而非 FFmpeg。
- `mode-plugin.ts` 会注入 Android FFmpeg 环境（`FFMPEG_PKG_CONFIG_PATH`、`FFMPEG_LINK_MODE=static`、包含 NDK sysroot+target 的 `BINDGEN_EXTRA_CLANG_ARGS`、`PKG_CONFIG_ALLOW_CROSS=1`、NDK 交叉链接器/CC）。支持 `deno task check -c kabegame --mode android`（实际运行 `cargo check --target aarch64-linux-android`）。参见 `cocs/downloader-tasks/VIDEO_INGEST.md`。

**Android 模态层**——所有覆盖层（对话框、抽屉、ActionSheet、预览）都必须调用 `@kabegame/core/composables/useModalBack` 中的 `useModalBack(visibleRef)`，以便 Android 返回键按堆栈顺序关闭各层。该 composable 在桌面端为空操作；无论平台如何，都应在所有相关位置使用它。

### 组件库——fork 自 element-plus
本仓**不再依赖 npm 的 `element-plus` / `@element-plus/icons-vue`**，两者已 vendor 成自有组件库并 fork 维护（不跟上游）。**不要从 `"element-plus"` 导入任何东西**：

```ts
import { ElButton, ElMessageBox } from "@kabegame/element-plus";
import { ArrowLeft } from "@kabegame/element-plus-icons";
```

类名前缀目前仍是 `el-`（namespace 开关未翻），但**不要按「第三方库覆盖」的思路加 hack CSS**——给组件加主题一律下沉到 `packages/kabegame-element-plus/src/theme-chalk/src/common/var.scss` 的 token map（方向恒为 `--kb-el-* ← --anime-*`），而不是在业务侧写 `.el-xxx { ... }`。新写的通用组件可以直接进 vendored 包（`KbTab` 已取代删掉的 `ElTabs`）。

接线有三处必须同步：vite alias、根与 `apps/kabegame` 的 tsconfig `paths`（app 的是**整体覆盖**不合并）、web 的 `manualChunks`。改任何前端组件或样式前先读 `cocs/ui/COMPONENT_LIBRARY.md`。

### 样式
新样式应使用 **UnoCSS 工具类**（在 `uno.config.pub.ts` 和 `apps/kabegame/uno.config.ts` 中配置，使用 `presetWind3`——兼容 Tailwind 语法）。仅为复杂动画或第三方覆盖编写 `<style>` 块。将重复的类组合提取为 `uno.config.*.ts` 中的快捷方式。

### 平台特定说明
- **Windows/macOS/Linux**：使用虚拟磁盘（Dokan / macFUSE / FUSE）挂载图库
- **Windows/macOS/Linux 标准版**：使用 CEF runtime 后端。三个平台都会在构建时链接 CEF，并通过 exe 旁边的扁平 `kabegame-cef-helper` 启动子进程（macOS 开发模式运行裸可执行文件；release 包通过 `macOS.frameworks` 嵌入 framework，通过 `macOS.files` 嵌入 helper）。
- **Android 身份分离**：identifier（applicationId）按模式区分——dev 为 `app.kabegame.dev`，prod 为 `app.kabegame`（可并排安装）——而 Java package/源码树保持固定为 `app.kabegame`（`namespace`）。该能力由 fork 版 `cargo-tauri` 实现（上游 Tauri monorepo 位于 `third/tauri`，由 `third-patches/tauri` 修补——请先运行 `deno task patch tauri`；遵循 `TAURI_ANDROID_PACKAGE`；从 `crates/tauri-cli` 构建，并由 `TauriCliPlugin` 注入 PATH）。绝不要从 identifier 重新推导 Kotlin package 名。参见 `cocs/tauri/TAURI_CLI_FORK.md`。
- **iOS**：不支持——不要添加 iOS 适配

### 爬虫插件开发
插件是 JS/TS 脚本（V8 后端，自包含 ES 模块 `export async function crawl`），打包为 `.kgpg` ZIP 归档。参见 `docs/PLUGIN_FORMAT.md` 和 `cocs/crawler/V8_RUNTIME.md`。使用以下命令构建：
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
deno task b -c kabegame --target x86_64    # 仅限 macOS：为 Intel 交叉编译（也适用于 check/start）。
                                       # 产物输出到 target/<triple>/；FFmpeg/CEF 依赖按架构从
                                       # bin/macos/x86_64/{FFmpeg-build,cef-build} 中解析。
                                       # 请先准备依赖：deno task build:ffmpeg --target x86_64 和
                                       # deno task build:chromium --target x86_64。
                                       # 参见 cocs/build/MACOS_CROSS_BUILD.md。
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

`kabegame-cli` 启用了 `kabegame-core` 的 `plugin-runtime` 和 `ipc-server` feature，因此会链接 deno_core/rusty_v8，并获得真正有效（非空操作）的 `GlobalEmitter`。这为 `kabegame-cli plugin run <id>` 提供支持；该命令会在进程内执行**已安装的 V8 插件**（不使用守护进程），并在固定的进度条上方渲染任务日志。可使用它在不启动 GUI 的情况下测试爬虫插件——请搭配 `repack-crawler-plugins` skill 和 `--data dev` 使用，否则 release CLI 会解析到系统数据目录。参见 `apps/docs/src/content/docs/reference/cli.md`。

在 macOS 上，两个二进制文件都是位于 `target/<profile>` 中的扁平 Cargo 产物；CEF framework 通过 cef-dll-sys 创建的 `target/Frameworks` 符号链接进行解析。参见 `src-tauri/tauri-runtime-cef/README.md`。

### 类型检查
**用 `check-kabegame` skill**（`.claude/skills/check-kabegame/`），不要手敲这些命令。
它包装 `deno task check`，落盘日志并从几百行 warning 里摘出真正的 error：

```bash
.claude/skills/check-kabegame/driver.sh              # vue-tsc + cargo check
.claude/skills/check-kabegame/driver.sh --skip cargo # 只查前端类型（秒级）
.claude/skills/check-kabegame/driver.sh --skip vue   # 只查 Rust
```

Android（`--mode android --skip vue`）使用 fork 版的 `cargo tauri android check`（NDK
工具链来自 cargo-mobile2，与构建保持一致），需要环境中的 NDK + `deno task build:ffmpeg
--target android` + `bin/android/arm64/rusty_v8-build/` V8 产物；详细信息与注意事项见该 skill 的 `SKILL.md`。

### 后端测试
**用 `test-kabegame` skill**（`.claude/skills/test-kabegame/`）跑后端 cargo test，
不要手敲裸 `cargo test`（缺 FFmpeg/CEF 环境变量会编译失败）。前端没有测试。

```bash
.claude/skills/test-kabegame/driver.sh kabegame-core --lib kgpg   # 按名过滤 core 单测
.claude/skills/test-kabegame/driver.sh kabegame-cli               # cli 全部测试
```

driver 封装了 `deno task test -c <crate>`（crate：kabegame | kabegame-cli |
kabegame-core），剩余参数自动补 `--` 传给 cargo test；全量套件有约 20 个既有失败，
验证改动请按名过滤。

### 数据目录模式（`--data`）
- `dev`（`deno task dev` 的默认值）：使用仓库内的 `.kabegame/debug/data`、`.kabegame/debug/cache` 和 `.kabegame/debug/tmp` 目录——与已安装应用隔离
- `prod`（其他所有命令的默认值）：使用系统用户数据目录（Windows 上为 `%LOCALAPPDATA%\Kabegame`，Linux/macOS 上为 `~/.local/share/Kabegame`）
- 开发时使用 `--data prod` 可针对实际安装数据进行测试；release 构建中使用 `--data dev` 可实现 CI/测试隔离
- 由 `src-tauri/{kabegame-core,kabegame}/build.rs` 注入的 `kabegame_data` Rust cfg 控制

### 其他
```bash
deno task set-version            # 在整个 workspace 中更新版本号
deno task pathql:generate        # 生成 PathQL 客户端 packages/kabegame-pathql-client/index.ts
                                 # (deno TS 脚本 scripts/generate-pathql-client.ts:默认先增量
                                 # 构建 debug kabegame-cli 再 pathql generate,--skip-build 用现有
                                 # 二进制)。包是 workspace 成员:外壳 package.json 入库、可被
                                 # 安装(@kabegame/pathql-client),index.ts 为生成物不入库;
                                 # 新 checkout / 修改 DSL 后需先生成,否则前端 vue-tsc / vite
                                 # 构建会因缺文件明确报错
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

Deno CLI 一律使用官方二进制, `third-patches/deno/` 只补应用通过 Cargo 消费的 `libs/core`，与 CLI 行为无关。

### 验证流程
**不要运行 `cargo build` / `tauri build` / `deno task b` 来验证改动**——应调用 **`check-kabegame` skill**（`.claude/skills/check-kabegame/driver.sh`，可使用 `--skip vue` / `--skip cargo` 缩小范围）。对于小型改动，编辑器 lint 诊断同样有效。仅在用户明确要求时才进行构建。注意：应用实例运行时，`check` 会以 `os error 32` 失败（`cef-dll-sys` 的构建脚本会将 CEF runtime 复制到 `target/`）——请先终止 `kabegame.exe`。规则见 `.cursor/rules/verify-by-lint.mdc`。

**调试是例外——应实际运行目标。** Lint 无法证明运行时行为。诊断缺陷时：先测量对象的实际状态，再解释症状；跟踪真实调用链，并在每一环验证实际值（尤其是 Rust↔CEF、前端↔Tauri、主进程↔子进程）；优先采用零成本实验（现有二进制文件 + 环境变量 / Chromium `--disable-features=<Name>` / 现有 `[DEBUG-*]` 日志），而不是编辑代码；在运行实验之前先写下证伪标准；逐字引用源码，不要在引文内嵌自己的注释。结论的成本越高（修补 vendored 库、重建 Chromium、大规模重构），所需的经验证据就应越充分。规则见 `.cursor/rules/debug-empirically.mdc`。

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
在进行更改后要把回归补充到 @versions/vX.X.X/regression.md，格式参考 [v4.4.1回归](./versions/v4.4.1/regression.md). 
检查用 `kabegame-chromium` 技能，如果是指出开发web版本才使用 `agent-browser` 技能。

## 语言规范
所有与用户的交流均使用简体中文。
任务计划、进度说明、问题分析、调试结论和最终回答均使用中文。
工具调用前后的说明使用中文。
代码标识符、终端命令、文件路径、API 名称和原始错误信息保持原语言。
代码注释默认使用中文，除非当前项目已有明确的英文注释规范。
不要因为代码库、日志或文档是英文而切换成英文回答。
