# AGENTS.md

本文件适用于 `scripts/**`，并集中记录仓库顶层命令的详细用法。

## 命令详细指南

所有顶层命令都通过 `scripts/run.ts`（基于 Tapable 的构建系统）执行，并使用 `deno task` 运行（Deno 2.9.0；克隆仓库后，请先运行 `deno install && deno task prepare`）。

### 开发
```bash
deno task dev -c kabegame                  # 启动开发服务器（Vite + Tauri，端口 1420）
deno task dev -c kabegame --mode local     # 开发模式，所有插件均在本地打包
deno task dev -c kabegame --mode android   # Android 开发模式
deno task dev -c kabegame --data prod      # 使用系统数据目录开发（而非仓库内的 .kabegame/debug/）
deno task dev:frontend            # 仅启动前端（不含 Tauri，端口 1420）
```

桌面三平台的 `deno task dev -c kabegame` 统一走 `tauri dev`；`kabegame-cef-helper` bin 在 dev 下由 ComponentPlugin `beforeBuild` 在主程序编译前先行构建（`tauri dev` 走 `cargo run`，无法同调用多编一个 bin）；build 下由 tauri.conf.json 顶层 `bins`（fork patch 09，见 cocs/tauri/TAURI_CLI_FORK.md）驱动 `tauri build` 随主编译一并产出——cargo 收到逐个 `--bin` 而非 `--bins` 全量（cef-example 不进 release），Windows 的 helper 由 NSIS 原生装到安装根（不再 stage 进 resources/bin）。CEF framework 为构建期直链（`third/cef-rs` fork），经 `target/Frameworks` 符号链接（cef-dll-sys 自动创建，指向 `CEF_PATH`）由 dyld 解析；helper 是 exe 旁的扁平 `kabegame-cef-helper`，三平台一致。

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
                                       # 生产 web 构建的 Vite base 指向 https://cdn.kabegame.com/web/；
                                       # bash scripts/deploy-web.sh 先把 dist-kabegame-web/（除 index.html）
                                       # 传到 OSS 挂载目录、校验入口脚本 MIME，再换二进制。
                                       # 见 cocs/web/CDN_MEDIA.md。
```

对于仅含 Cargo 的 `kabegame-cli` 组件，`deno task b` 默认执行 **debug** 构建；传入 `--release` 才会执行 release 构建。主应用的桌面端/Android 构建始终通过 `tauri build`，无论是否传入 `--release` 都是 release 构建。

`kabegame-cli` 启用了 `kabegame-core` 的 `plugin-runtime`、`ipc-client` 和 `ipc-server` feature。`plugin run <id|path.kgpg>` 优先在同数据目录的主程序中执行（因此 app 模式支持 WebView）；回退本地模式时才在 CLI 进程初始化任务与事件运行时、执行 V8 插件。两种模式都支持已安装 id 与临时 `.kgpg` 路径，并在固定进度条上方渲染任务日志。CLI 没有运行时 `--data` 参数，数据目录只由构建时的 `kabegame_data` cfg 决定：插件开发请用 `deno task b -c kabegame-cli`（不带 `--release` 默认即 `--data dev`）构建并搭配 `kabegame-plugin` skill；需要强制隔离运行时加 `--via local`。参见 `apps/docs/src/content/docs/reference/cli.md` 与 `cocs/cli/CLI_IPC.md`。

在 macOS 上，两个二进制文件都是位于 `target/<profile>` 中的扁平 Cargo 产物；CEF framework 通过 cef-dll-sys 创建的 `target/Frameworks` 符号链接进行解析。参见 `src-tauri/tauri-runtime-kbcef/README.md`。

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

#### 四格漫画合成

`python3 scripts/compose-comic.py TL TR BL BR --output-size 3072x2048 --out comic.png`
按左上、右上、左下、右下顺序把四张图放入 `4koma/template.psd`。
依赖 Pillow 与 psd-tools；`--show-regions` 可查看画格坐标。
模板用顶层 `01`–`04` 图层的边界定义画格，底层背景先按画格挖洞，
再叠加最高画格图层上方的可见装饰（包括 `编号1`–`编号4`），最后统一缩放。
编号等前景装饰应放在全部画格图层上方；合成后的装饰不能再次按画格挖洞。

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
deno task patch cef --gen --from 05 --out third-patches/cef/06-xxx.patch
                                 # 把 third/cef 工作树里「系列到 05 之外」的剩余改动导出成新补丁；
                                 # 不 reset、只读工作树（临时 GIT_INDEX_FILE）；省略 --out 写 stdout，
                                 # 省略 --from 取系列最后一个，--from none 以纯净基线为底
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
                                 # 参见 src-tauri/tauri-runtime-kbcef/README.md。请用同卷 mv 移动现有 checkout
                                 # （即时重命名，无需复制 60GB）。
deno task build:ffmpeg --target android  # 通过环境中的 NDK（NDK_HOME 等）交叉编译 aarch64 FFmpeg
                                 # 输出到已被 git 忽略的 bin/android/arm64/FFmpeg-build/（可通过
                                 # 命令重现，不提交）。执行 Android Cargo 构建/检查前必须先运行此命令。
```

### 验证流程
**不要运行 `cargo build` / `tauri build` / `deno task b` 来验证改动**——应调用 **`check-kabegame` skill**（`.claude/skills/check-kabegame/driver.sh`，可使用 `--skip vue` / `--skip cargo` 缩小范围）。对于小型改动，编辑器 lint 诊断同样有效。仅在用户明确要求时才进行构建。注意：应用实例运行时，`check` 会以 `os error 32` 失败（`cef-dll-sys` 的构建脚本会将 CEF runtime 复制到 `target/`）——请先终止 `kabegame.exe`。规则见 `.cursor/rules/verify-by-lint.mdc`。

**调试是例外——应实际运行目标。** Lint 无法证明运行时行为。诊断缺陷时：先测量对象的实际状态，再解释症状；跟踪真实调用链，并在每一环验证实际值（尤其是 Rust↔CEF、前端↔Tauri、主进程↔子进程）；优先采用零成本实验（现有二进制文件 + 环境变量 / Chromium `--disable-features=<Name>` / 现有 `[DEBUG-*]` 日志），而不是编辑代码；SQLite / PathQL 查询可设 `KABEGAME_SQL_DEBUG=1`，在 stderr 查看绑定参数已展开的实际 SQL 与每条耗时；在运行实验之前先写下证伪标准；逐字引用源码，不要在引文内嵌自己的注释。结论的成本越高（修补 vendored 库、重建 Chromium、大规模重构），所需的经验证据就应越充分。规则见 `.cursor/rules/debug-empirically.mdc`。
