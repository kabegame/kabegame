# v4.7.0 regression

## 关掉 Chromium 的系统媒体集成（3819637149 音乐一顿一顿）

2026-11-21 Windows dev。`3819637149`（Somewhere In Nowhere）的场景音乐放约 1 s、停约 1 s，WPE 里很顺。原因是自激：
1. 场景的 `<audio>` 被 Chromium 登记成 Kabegame 自己的系统媒体会话（SMTC，标题 "Kabegame"、时长 131 s 正是这首 mp3）。
2. `wpe_media` 把这个会话当成系统媒体交给场景。
3. 「Song Title」图层的脚本收到 `mediaPlaybackChanged` state 1 就 `soundLayer.pause()`，会话变成 state 2 后又 `play()`。
4. 按 `windowupdaterate` 1000 ms 一翻。

WPE 的 `webwallpaper64.exe` / `wallpaperui.exe` 都带 `--disable-features=…,HardwareMediaKeyHandling,…`，所以没有这个问题。Chromium 只在这个特性开着时建 `MediaKeysListenerManagerImpl`（`browser_main_loop.cc`），SMTC / macOS「正在播放」/ Linux MPRIS 和媒体键都挂在它下面。

改法：`tauri-runtime-kbcef` 照 WPE 关掉它（三个桌面平台，用户同意关掉整个应用的媒体集成），前端删掉失效的 `usePreviewMediaSession`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 改前定位 | Windows dev，3819637149 设为桌面壁纸 | CDP 每 100 ms 采样桌面宿主的 `host.sounds()` 与 `host.media()`，6 s | 找到断续的来源 | 2026-11-21 Claude：元素进度速率「1.0 × 约 10 次 → 0 × 约 10 次」交替；停的时候 `scriptPaused: true`；媒体消息每 1000 ms 在 playback 1 / 2 之间翻，场景投影的 `props.title` 是 "Kabegame"、`duration` 131；帧间隔 p99 8.5 ms，和渲染负载无关 |
| [x] | T2 检查 | Windows | `vue-tsc`（删了 `usePreviewMediaSession` 与它的单测、`ImagePreviewDialog` 的调用）；`rustfmt --check` `runtime.rs` | 全过 | 2026-11-21 Claude：`vue-tsc` 0 错误；rustfmt 通过；dev 开着时 `deno task check` 的 `cargo check` 被 `cef-dll-sys` 的 os error 5 挡住，另用独立 target 目录 `cargo check -p tauri-runtime-kbcef` 通过 |
| [ ] | T3 场景音乐连续 | Windows dev（重开 dev，CEF 启动参数改了） | 3819637149 设为桌面壁纸，再按 T1 采样 | 元素进度速率一直约 1.0，`scriptPaused` 一直 false；`host.media()` 里没有标题为 Kabegame 的会话 | 需要重开 dev |
| [ ] | T4 系统媒体控件 | Windows dev | 预览一个有声视频、一张带音乐的网页壁纸；按键盘的播放 / 暂停键 | Windows 音量浮窗里没有 Kabegame；媒体键不暂停 Kabegame 的视频或壁纸音乐，别的音乐播放器照常响应 | 需要重开 dev |
| [ ] | T5 别的播放器仍然生效 | Windows dev | 3819637149 在放时，用别的播放器（如 Spotify、浏览器）放歌，再暂停 | 壁纸的歌暂停、歌名换成那首歌；那边暂停后壁纸的歌恢复（作者脚本的本意） | 需要重开 dev |

## release 的 profile 一直没生效（非根包的 `[profile.*]` 被 cargo 忽略）

2026-11-21 Windows。排查构建缓存时发现 cargo 每次都打的第一行 warning 就是
`profiles for the non root package will be ignored`：`[profile.dev]` / `[profile.release]` 写在
`src-tauri/kabegame/Cargo.toml`，cargo 只认工作区根的 profile，而根 `Cargo.toml` 里那份是注释掉的
（`# on when release`）。所以 `panic = "abort"` / `codegen-units = 1` / `lto = "thin"` / `strip` /
`opt-level = 3` 全都没生效，release 用的是 cargo 默认值；只有 `codegen-units = 1` 另由
`ReleasePlugin` 经 RUSTFLAGS 在 `--release` 时生效。`[profile.dev]` 那份三项都等于 cargo 默认值，
删掉即可。搬迁时两处刻意不照搬：`panic = "abort"` 会废掉 `crawler/task_scheduler`（插件任务）、
`providers/sql_executor`（PathQL 执行）与 `kabegame/src/lib.rs` 的 `init_heavy_globals` 三处
`catch_unwind`——一个插件 panic 就能带走整个进程、启动失败也不再有错误提示；`lto` 与
`codegen-units` 放到 `deno task b --release`（发版，CI 用的就是它）时经 `CARGO_PROFILE_RELEASE_*`
打开，因为主应用的 `deno task b` 恒是 release 构建（`tauri build`），日常验证不该付几倍的链接时间。
`codegen-units` 从 RUSTFLAGS 换成 profile 环境变量是必须的：RUSTFLAGS 里的 `-C lto` 与 cargo 给
依赖传的 `-C embed-bitcode=no` 互斥，会直接编译失败。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | RP1 warning 消失 | Windows | `cargo metadata --no-deps` | 不再打 `profiles for the non root package will be ignored` | 2026-11-21 Claude |
| [x] | RP2 cargo 接受新 profile | Windows | 同上一条命令 | 五个字段都被解析，不报 unused manifest key / 字段类型错 | 2026-11-21 Claude：exit=0、stderr 空、`Cargo.lock` 未被改动（带 `--locked`）。`strip` 是否真的作用到产物归 RP4 / RP5 验，这里只证解析通过 |
| [x] | RP3 构建脚本类型检查 | Windows | `deno check scripts/run.ts` | 通过 | 2026-11-21 Claude |
| [ ] | RP4 日常 b 不开 lto | Windows | `deno task b -c kabegame`，看 cargo 环境 | 不出现 `CARGO_PROFILE_RELEASE_LTO`，链接时间与改动前相当 | 没做：一次完整 release 构建 |
| [ ] | RP5 发版 b --release 开 lto | Windows | `deno task b -c kabegame --release`，看 ReleasePlugin 的日志行 | 打印 `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1` 与 `CARGO_PROFILE_RELEASE_LTO=thin`，构建成功 | 没做：thin LTO + codegen-units=1 的全量 release 很慢；这一条是 `-C lto` 与 `-C embed-bitcode=no` 互斥的实证点，发版前必须先过 |
| [ ] | RP6 strip 的影响 | Linux / macOS | 发版产物跑一次 panic | 产物变小；backtrace 只有地址、没有符号名（接受） | 没做：本机是 Windows，MSVC 的符号本来在 PDB 里，strip 基本无感 |

## 构建缓存被命令之间反复掀翻（每次都全量重编 `kabegame-core` 与两个 exe）

2026-11-20 Windows。用户报「`kabegame-cef-helper` 每次都要慢慢编，即使相关代码没改；`kabegame` 也一样，一行没改再编也要重新编最后的 exe」。
证据就在仓库里：`target/flycheck0/stderr`（rust-analyzer 跑 `cargo check` 时带着 `CARGO_LOG=cargo::core::compiler::fingerprint=info`）直接写着
`dirty: EnvVarChanged { name: "CEF_PATH", old_value: Some(…), new_value: None }`、`KABEGAME_DATA` 从 `Some("prod")` 变 `None`、
`FFMPEG_INCLUDE_DIR` 同样，以及 `stale: changed …\tauri.conf.json`（它比 build script 的 `output` 新）。
cargo 把 build script 读到的环境变量**值**记进 fingerprint，值一变整个 crate 连同全部 bin 重编重链，传导链是：
`KABEGAME_DATA` → `kabegame` / `kabegame-core` 的 build script（`--cfg kabegame_data=…`）→ 两个 crate + `kabegame.exe` + `kabegame-cef-helper`；
`CEF_PATH` → `cef-dll-sys` → `cef` → `tauri-runtime-kbcef` → `kabegame-cef-helper`（这个 bin 只有 7 行，但 cargo 的 bin unit 依赖整包的依赖图）；
`FFMPEG_INCLUDE_DIR` → `rusty_ffmpeg` → `rsmpeg` → `kabegame-core`。
对着 `target/debug/build/kabegame*/output` 数了一晚上的翻转：21:11 dev → 22:59 prod → 23:11 dev → 23:18 prod → 23:23 dev，四次全量重编。
来源有三个：`deno task check` / `test` / `start` 的 `--data` 默认 prod 而 `dev` / `b` 默认 dev，却共用 `target/debug`；
VSCode 的 rust-analyzer 用同一个 `target/` 跑 `cargo check`，环境里没有 `deno task` 注入的那些变量（而且它自己那次 check 是失败的）；
`tauri.conf.json` / `capabilities/main.json` / `index.html` 每次 `beforeBuild` 无条件重写，内容一字不差也刷新 mtime。
**一处回归**（用户实测抓到）：打包 `.kgpg` 用的 `kabegame-cli` 是 `deno task b` 的产物、固定在 `target/`，
而 `src-crawler-plugins/package-plugin.ts` 默认按 `CARGO_TARGET_DIR` 找它（那是给 `target-22` 隔离构建
准备的），于是 dev 启动时的插件打包去 `target-dev/release/` 找、五个插件连续报「请在 kabegame 父仓库
构建 cli 工具」。修成在 `target-dir.ts` 注入 `target-dev` 的同时用 `KABEGAME_CLI`（打包脚本本来就支持
这个变量）把 cli 指回 `target/release`（没有就退 `target/debug`），不碰子仓库、也不破坏 `target-22`。
fork 的 `cargo-tauri` 则相反——它是构建环节，继续跟着隔离走。

改动：产物目录按命令隔离（`b` → `target/`，其余 → `target-dev/`，新增 `scripts/target-dir.ts`，显式 `CARGO_TARGET_DIR` 优先，`.mcp.json` 给 `kabegame-dev` MCP 配同一个目录）、
`--data` 默认值统一成「带 `--release` 为 prod，否则 dev」、三个生成文件改成内容有变才写（`writeFileIfChanged`）、rust-analyzer 配 `cargo.targetDir`（`.vscode/` 不入库）。
另有一处**本次没改**：`src-tauri/kabegame/Cargo.toml` 的 `[profile.dev]` / `[profile.release]` 被 cargo 忽略（非根包 profile 无效，`flycheck0/stderr` 第一行就是这个 warning），
根 `Cargo.toml` 又没有 `[profile.release]`，所以 `lto = "thin"` / `strip` / `panic = "abort"` / `opt-level = 3` 一直没生效，release 用的是 cargo 默认值；
`codegen-units = 1` 另由 `ReleasePlugin` 经 RUSTFLAGS 在 `--release` 时生效。搬到根里会让 release 构建变慢并触发一次全量重编，
且 `panic = "abort"` 会废掉 `task_scheduler` / `sql_executor` / `init_heavy_globals` 三处 `catch_unwind`，另开一次评估。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | B1 命令 → 产物目录 | Windows | `deno eval` 按 `dev` / `check` / `test` / `start` / `build` 分别求 `TARGET_DIR` | 前四个 `target-dev`，`build` 为 `target` | 2026-11-20 Claude：五次输出与预期一致 |
| [x] | B2 显式 env 优先 | Windows | 设 `CARGO_TARGET_DIR=mytarget` 再按 `dev` 求值 | `D:\Codes\kabegame\mytarget`，脚本不插手 | 2026-11-20 Claude |
| [x] | B3 构建脚本类型检查 | Windows | `deno check scripts/run.ts` | 通过 | 2026-11-20 Claude：含新增的 `target-dir.ts` 与改过的 data-plugin / component-plugin / utils |
| [x] | B4 `writeFileIfChanged` | Windows | 在不存在的多级路径上写三次（新建 / 同内容 / 改内容） | `true` / `false` / `true`，父目录自动建，内容正确 | 2026-11-20 Claude |
| [x] | B5 `.mcp.json` 仍合法 | Windows | `JSON.parse` 整个文件 | 合法，`kabegame-dev` 带 `env.CARGO_TARGET_DIR=target-dev` | 2026-11-20 Claude：注释键没留（`env` 的键会真的变成环境变量） |
| [ ] | B6 首次 dev 全量编译 | Windows | 停掉在跑的 dev 后 `deno task dev -c kabegame` | 在 `target-dev/` 下全量编一次后正常起来 | 没做：`target-dev/` 是空的，这一次要全量编（CEF / V8 / FFmpeg 都在里面）。想省掉就把现有 `target` 改名成 `target-dev`（同盘改名是瞬时的，当前 `target/debug` 里正是 dev 产物；`target/release` 只剩 11-03 的 `kabegame-cli`），改名前须先停掉 dev app，否则占用 |
| [ ] | B7 check → dev 不再重编 | Windows | 连着跑 `deno task check -c kabegame --skip vue` 与 `deno task dev -c kabegame`，各两遍 | 第二遍起 cargo 直接 `Finished`，`kabegame-core` / 两个 exe 都不重编 | 没做：要等 B6 把 `target-dev/` 填满。验证时可带 `CARGO_LOG=cargo::core::compiler::fingerprint=info` 看有没有 `EnvVarChanged` |
| [ ] | B8 MCP 跟到新目录 | Windows | 重启 Claude Code（让 `kabegame-dev` MCP 带上新 env），调它的 `status` / 重建场景宿主 | 场景宿主产物指向 `target-dev/debug/resources/wpe-scene` | 没做：要重启 MCP 进程才生效 |
| [x] | B9 `deno task b` 仍落 `target/` | Windows | 用户为解决 B11 跑了 `deno task b -c kabegame-cli` 与 `--release` 版 | 产物在 `target/debug/` 与 `target/release/` | 2026-11-21：02:25 的 debug（107 MB）与 02:41 的 release（85 MB）都在 `target/` 下，`kabegame-plugin` skill 的路径不变 |
| [x] | B11 插件打包用的 cli（回归） | Windows | 用 `target-dir.ts` 注入的 dev 环境跑 `deno task package --only konachan --out-dir <临时>` | 不再找 `target-dev/release/kabegame-cli.exe`，打包成功 | 2026-11-21 Claude：`KABEGAME_CLI=D:\Codes\kabegame\target\release\kabegame-cli.exe`、`konachan.kgpg (568.79 KB)`、exit=0。修复前用户实测报「找不到 cli … 请在 kabegame 父仓库构建 cli 工具！」（5 个插件连续失败） |
| [ ] | B10 三个生成文件跳过重写 | Windows | 连着跑两次 `deno task b -c kabegame --skip cargo` | 第二次日志打「内容未变，跳过」，`tauri.conf.json` 的 mtime 不动 | 没做：会跑完整前端构建并重打包插件 |

## 拖入落点提示显示成原始 key（`import.dropZone.*`）

2026-11-20 Windows dev。用户拖图进画廊时截图发现落点提示的标题是 `import.dropZone.galleryMedia`，副标题却是正常中文。`import.json` 里这八条写成了**带点的扁平 key**（`"dropZone.galleryMedia": …`），而 `createI18n` 没开 `flatJson`，`t("import.dropZone.galleryMedia")` 被当成路径去找 `import → dropZone → galleryMedia`，必然落空、回显 key 本身。同在 `common.json` 的另外 11 个带点 key 没事，因为调用处用了 vue-i18n 的转义写法（`t('common["reportIssue.envSection"]')`）。调用处本来就按嵌套写，所以改词条：五种语言的 `import.json` 把八个 `dropZone.*` 并成一个嵌套 `dropZone` 对象，key 顺序与原文件一致（`setPath` 从末尾并入）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | I1 八条文案解析 | Windows dev | vite 热更新后在主窗口用 `$t` 逐条求值 | 都出正常文案、参数插值正确 | 2026-11-20 Claude：`导入 3 个文件到画廊`、`导入 2 个文件到「测试画册」`、`设为「a.png」`、`安装 1 个源插件包`、以及 folders / mixed 四条都对 |
| [x] | I2 其它语言包没写坏 | Windows dev | 同上读 en 的同一条 | `Import 5 files to gallery` | 2026-11-20 Claude：五个文件同一个脚本改写，diff 只含这八行的挪位 |
| [x] | I3 类型检查 | Windows | `deno task check -c kabegame --skip cargo` | 0 error | 2026-11-20 Claude：vue-tsc 0 error |
| [ ] | I4 真机拖入 | Windows | 从资源管理器拖图到画廊 / 画册 / 插件页 | 标题是正常文案 | 需要人拖；截图里那次复现的就是修复前的样子 |

## 自编 CEF 156（Windows 首次）：构建脚本三处修复、补丁的 API 版本守卫、SDK 前提

2026-11-20 Windows。在新构建根（`CEFBUILD=D:\Codes\kabegame-cefbuild`，旧的 149 checkout 原地留作备份）上第一次为 CEF 156 跑 `deno task build:chromium`，连着踩两个脚本缺陷，都与网络无关：`bootstrap()` 的 `git clone --depth 1` 让 automate-git 切不到 `CHROMIUM_BUILD_COMPATIBILITY.txt` 钉的 `depot_tools_checkout`（156 是 `132599ebb`；149 那个 pin 恰好落在浅克隆靠自更新攒下的历史里，所以一直没发作）；`configureUpdate()` 只看 `chromium_git/chromium/src` 目录在不在，而 automate-git 在 `gclient sync` 之前就 `git init` 出了空 src，同步一中断，重跑就会走增量、传 `--no-chromium-update` 跳过同步直接去编译。另记两个外部缺陷：depot_tools 的 `gclient_utils.py` 逐行按 UTF-8 解码子进程输出，中文（GBK）的 git 报错会抛 `UnicodeDecodeError`，把 `gclient_scm.py` 那条 `retry=True` 一起带崩、真实错误也看不到；`.gclient` 里 src 是 `managed: False`，目录一存在 gclient 就只读 `HEAD` 不再管它的 checkout，中断留下的空仓库会让每次重试都死在 `rev-parse --verify HEAD`（exit 128）。所以直接驱动 `gclient sync` 时要在外层套重试循环并自愈空壳；经脚本走则由全量路径的 `--force-clean` 兜底。另有两个与脚本无关的前提：Chromium 156 的 `build/vs_toolchain.py:63` 写死 `SDK_VERSION = '10.0.28000.0'`（149 要的是 `10.0.26100.0`），没装就在 `gn gen` 阶段报 `Path "…\include\10.0.28000.0\um" does not exist`；补丁 03 给 `include/cef_drag_data.h` 加的 `GetCustomData` 漏了 `#if CEF_API_ADDED(CEF_EXPERIMENTAL)` 守卫，`libcef_dll_wrapper` 以 `CEF_API_VERSION=15600` 编时 `CefDragDataCToCpp` 成抽象类（`error C2259`）。chromium/src 的大包最终改从 `github.com/chromium/chromium` 镜像拉（同一个提交），googlesource 侧两种 TLS 栈都报记录校验失败并出现 `HTTP 429`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 类型检查 | Windows | `deno check scripts/build-chromium.ts` | 通过 | 2026-11-20 Claude |
| [x] | S2 depot_tools 钉住的提交 | Windows，新构建根 | 补齐浅克隆历史后重跑 | `git checkout --force 132599ebb…` 通过，进到 `gclient sync` | 2026-11-20 Claude：修复前 exit 128（`git cat-file -t` 证实对象不存在，克隆里只有 3 个提交） |
| [x] | S3 空 src 不被误判成增量 | Windows，同步中断过的构建根 | 不带 `--clean` 重跑 `deno task build:chromium` | 走全量 checkout，automate-git 经 `--force-clean` 自己删掉空 src 并重写 `.gclient` | 2026-11-20 Claude：改成看 `BUILD.gn` 后，手工铺好 src 的那次运行正确判成增量（日志「增量：复用 Chromium checkout」），没去重拉 |
| [x] | S4 checkout 与编译 | Windows，`CEFBUILD=D:\Codes\kabegame-cefbuild` | `gclient sync --nohooks --no-history` + `gclient runhooks` 跑通后 `deno task build:chromium` | 产出 `bin\windows\x86_64\cef-build`，`archive.json` 为 `156.0.30` | 2026-11-20 Claude：`cef_binary_156.0.30+windows64_minimal`，`libcef.dll` 282 MB，22 个顶层条目（minimal 发行版不含 `cef_sandbox.lib`，本构建走 no-sandbox 传统 exe 模式、不需要）。耗时：src 11 min、DEPS 13.5 min、runhooks 5 min、编译 + 链接 + make_distrib 6 h 28 min |
| [x] | S5 大包的拉取路径 | Windows，本机代理 | googlesource 的 depth-1 fetch 反复失败后改从 `github.com/chromium/chromium` 镜像拉 tag | 拿到与 googlesource 同一个提交 | 2026-11-20 Claude：两端 tag 同为 `2ad9b7f5a86846e0b264090723a6a78964bb84c4`，镜像 7.3 MB/s、4.5 min 到手。googlesource 侧 schannel 报 `SEC_E_DECRYPT_FAILURE`、OpenSSL 报 `bad record mac`（同一类错误，TLS 栈不是原因），并出现 `HTTP 429`；限速 2 MB/s 的普通 GET 跑满 5 min 不断，所以不是代理有时长上限 |
| [x] | S6 Windows SDK 前提 | Windows | 装 Windows 11 SDK `10.0.28000.x` 后重跑 | `gn gen` 通过 | 2026-11-20 用户在 VS Installer 里装好；装前只有 `10.0.26100.0`。`stdint.h` 随 MSVC 工具集发布、不在 UCRT 里，排查时别被它误导 |
| [x] | S7 补丁的 API 版本守卫 | Windows | 给 `include/cef_drag_data.h` 的 `GetCustomData` 补 `#if CEF_API_ADDED(CEF_EXPERIMENTAL)` 后编 `libcef_dll_wrapper`，再 `deno task check -c kabegame --skip vue` | wrapper 编过、check 0 error | 2026-11-20 Claude：修复前 `error C2259: CefDragDataCToCpp 无法实例化抽象类`；修复后 183/183 链接出 `libcef_dll_wrapper.lib`、cargo check 0 error。生成的 capi / ctocpp 本来就带这道守卫，所以只改头文件、不必重编 libcef；`deno task patch cef --check` 报 `cef: OK dry-run` |

## 场景脚本读到的用户属性全集（2974757317 悬浮窗）

2026-11-21 Windows dev。照 Wallpaper Engine（`kbprops-kinds` 实测）：工程属性里带 `value` 键的每一项都进脚本的属性全集，不看 `type`（`text`、`group`、不认识的类型、没写 `type` 的都算，`null` 也算），没有 `value` 的不进；`engine.userProperties` 就是全集，首次 `applyUserProperties` 的参数再去掉没写 `type` 的。之前后端 `scene_user_from_view`、宿主 `mergeProperties`、dev 探针三层都跳过 `group` / `text` / 空值，2974757317 的 22 段 `origin` 脚本只在收到 `text` 项 `xian` 时给 `speed` 赋值，读不到就把位置算成 NaN，悬浮窗、时间日期、胶囊按钮、底部音频条全部不见。后端改由 `scene_user_props` 补上其余项；网页壁纸（`resolve_web_user_props`）没对照过，不动。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 WPE 实测 | Windows，WPE 测试窗口 960×540 | 测试工程 `ignore/p6/f5/proj/kbprops-kinds`：14 类属性（带值 / 不带值的 `text`、`group`、`bool`，不认识的类型，没写 `type` 的，`null`），脚本在 `init` 与 `applyUserProperties` 里打出键与值 | 记下 WPE 的规则 | 2026-11-21 Claude：全集 24 项、参数 23 项（少了没写 `type` 的 `p_notype_val`）；没有 `value` 键的 4 项都不在；`p_null` 读到 `null` |
| [x] | T2 单测与检查 | Windows | wpe-scene vitest：`compile/p3a`（`mergeProperties` 新规则）、`dev/probeScripts`（全集照收、没写 `type` 的不进参数），以及 `render/p3a`、`compile/p3a-missing`、`render/p11b`、`script/shortcutApi`；`tsc`；Rust `commands::wpe_web` 新增 `scene_user_props_follow_wpe_value_rule` | 全过 | 2026-11-21 Claude：vitest 6 个文件 129 条通过；`tsc` 0 错误；Rust 见 T3 |
| [x] | T3 Rust 单测 | Windows | `driver.sh kabegame --lib scene_user`；`cargo fmt` | 通过 | 2026-11-21 Claude：2 条通过（原有的 `scene_user_values_match_property_items` 与新增的 `scene_user_props_follow_wpe_value_rule`）；rustfmt 已套用 |
| [x] | T4 语料 | Windows | 语料编译扫描（234 张），和改前比 | 没有新增或去掉的键 | 2026-11-21 Claude：改前改后都是 234 张干净，`corpus diff` 0 张变化 |
| [x] | T5 探针渲染 | Windows dev，屏外宿主 1920×1080，跑脚本 | `render_scene` 2974757317 回放 90 帧 | 中间出现悬浮窗、上方出现时间日期（没有媒体时显示缺省标题） | 2026-11-21 Claude：悬浮窗、时间、日期、署名都出来了，位置和 WPE 抓帧（`A:\p6f\float\wpe2974-frame262.png`）对得上；没有媒体，标题是缺省的「Wallpaper Music」。光标在正中时右侧会滑出胶囊按钮（#18 的 `cursorEnter` 置 `shared.mafeib`），光标挪到角上就收回，是作者的悬停交互；改前这些图层的 `origin` 都是 NaN |
| [ ] | T6 预览与桌面 | Windows dev 预览 | 重开 dev 后打开 2974757317 的预览，系统在放歌 | 和 WPE 一样：正中悬浮窗带封面、频谱与歌名，上方时间日期；点悬浮窗它滑到底部、再点回来 | 需要重开 dev（后端改了）；背景封面比 WPE 放大约一倍、偏下，另查 |

## 场景脚本多的壁纸帧率（3662790108）

2026-11-20 Windows dev。`3662790108`（Live Solar System）有 944 段脚本、九百多个对象，预览原先约 2 fps（WPE 正常）。CPU profile 定位到两处：`thisScene.getLayer('名字')` 每次 O(n²)（对象表逐个取名字、每个名字又线性找图层），改成按对象的索引加名字解析缓存；脚本把同样的值写回图层时原先也标脏、重算全部静态 uniform，改成值没变不标脏（变换写入照记，带 3×3 时同值的 `angles` 仍算变了）。运行时回调统计加累计耗时 `totalMs`。顺带修了 P6f 留下的 `state.objects.test.ts` 夹具（文本字段缺 `decor`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`src/render`、`src/script`、`src/animation`、`src/puppet`、`host.l3b` / `l6` / `script`（新增：名字缓存在 `sortLayer` / 改名 / 图层原地替换 / 待删 / 按 id 命中后的结果，同值写入不标脏与例外）；`tsc`；Prettier | 全过 | 2026-11-20 Claude：119 个文件 2522 条通过（含 pkg、scriptApi）；变异 12 处中 9 处检出，幸存 3 处是重复的失效条件（建层、换 bundle 时结构版本已变） |
| [x] | T2 profile | Windows dev，屏外宿主 1600×900，后处理超高，跑脚本 | 回放 40 帧（0.05 s），CDP 抓 CPU profile | 脚本每帧稳态耗时大降 | 2026-11-20 Claude：541–653 → 5 ms/帧；回放阶段 CPU 58 → 36 ms/帧（开场推镜头，全部图层在动） |
| [x] | T3 预览帧率 | Windows dev 预览 | 打开 3662790108 的预览，读宿主的脚本调用数 | 接近帧率上限 | 2026-11-20 Claude：29 fps（上限 30），脚本约 4 ms/帧 |
| [ ] | T4 手感 | Windows dev 预览与桌面 | 等开场过去，拖动旋转、双击天体切换焦点，把帧率设到 60 再看 | 流畅，和 WPE 观感接近 | 需要用户看；镜头一直在动时每帧仍要全量重算 uniform |


## 场景壁纸在 `scene.pkg` 里找资源不分大小写

2026-11-20 Windows dev。照 Wallpaper Engine（挂载时把条目名转成小写进哈希表、查找时把路径也转小写），场景在 `scene.pkg` 里找资源时不区分 ASCII 大小写，同名（含只差大小写）的条目取最后一条；之前按原样精确匹配，`3662790108`（Live Solar System，哈勃）的场景写 `materials/models/HUBBLE/…`、包里是 `…/hubble/…`，报 9 个缺材质、退回封面图。导入时读入口 json（Rust）与 kbp-tools 同一规则。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`compile/pkg.test.ts`（同键取最后一条、只差大小写同键、非 ASCII 不折叠）、`compile/fs.test.ts`；`tsc`；Prettier；Rust `wpe::project`（新增大小写与同键用例） | 全过 | 2026-11-20 Claude：2 个文件 14 条通过；`tsc` 0 错误；Rust 13 条通过 |
| [x] | T2 语料 | Windows | 语料编译扫描（234 张），和改前比 | `3662790108` 去掉 9 个 `material:missing:*`，没有新增键 | 2026-11-20 Claude：干净 232 → 234（另一张是 `resizeScreen` 的 3838286359），新增键 0；366 个包里没有只差大小写的条目 |
| [x] | T3 渲染 | Windows dev，屏外宿主 1600×900，后处理超高，跑脚本 | `3662790108` 回放 150 帧（0.1 s）读回，和 WPE 开窗约 15 s 的抓帧比 | 太阳、行星名、右侧面板位置对得上 | 2026-11-20 Claude：对得上；我们这边多一张白色网格、视角不同，脚本时钟与帧时间都和 WPE 不同，没逐帧走查；开场 5 s 内全黑是淡入（WPE 同）；作者脚本 `[P1] Data` 的 `shared.shared` 在 WPE 里同样抛错 |
| [ ] | T4 预览 | Windows dev 预览 | 打开 3662790108 的预览，等开场过去，拖动旋转、双击天体 | 不再退回封面；和 WPE 观感一致 | 需要用户看；网格与视角差异见 T3 |

## 场景壁纸脚本回调 `resizeScreen`

2026-11-19 Windows dev。脚本导出的 `resizeScreen(size)` 由运行时调用，不再报 `script:callback:resizeScreen`、退回预览图。脚本看到的屏幕分辨率（`engine.screenResolution`，布局 × DPR）由宿主的 `ScreenResolution` 跨渲染器维护：渲染器每次量画布都交给它，和之前不同时同步调 `resizeScreen`，参数是 `Vec2`，返回值丢弃，出错只禁用这个回调，首次创建不调。预览放大不算分辨率变化。顺带修正：首次加载时脚本 `init` 早于建渲染器，原先读到的是画布元素的缺省 300×150，现在是布局 × DPR。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：新增 `script/resizeScreen.test.ts`（全场景广播与顺序、`Vec2` 单精度且每个接收者各一个、返回值丢弃、出错只禁用这个回调；`ScreenResolution` 第一次量不通知、相同不通知、`seed` 只在没量过时记值），以及 `compile/scriptApi`、`script/api`、`host.l3b`、`host.l6`、`host.script`；`tsc`；Prettier | 全过 | 2026-11-19 Claude：6 个文件 220 条通过；`tsc` 0 错误；变异 7 处中 6 处检出，幸存的一处是重复判断，已删 |
| [x] | T2 语料 | Windows | 语料编译扫描（234 张，含 `myprojects/3838286359`） | `3838286359` 只剩的 `script:callback:resizeScreen` 去掉 | 2026-11-19 Claude：改前 232 张干净、该场景只报这一个键；改后表里只剩 `applyGeneralSettings`，语料无人导出 |
| [x] | T3 init 读到真实分辨率 | Windows dev，屏外宿主 1920×1080（DPR 1.5） | 打开 3838286359，读四个文本层的 `pointsize` | 按 2880×1620 算（标题 10.8），`resizeScreen` 不调 | 2026-11-19 Claude：10.8 / 9.36 / 6.84；改前是按 300×150 算的 1.125 |
| [x] | T4 改尺寸调 `resizeScreen` | 同上 | 把宿主 iframe 改成 1280×720，经显示缩放消息让渲染器量一次 | `resizeScreen` 调一次，字号按 1920×1080 重算，脚本没有报错 | 2026-11-19 Claude：调 1 次，7.2 / 6.24 / 4.56；屏外 iframe 被节流、没有帧，重排要等下一帧（P6b 已验） |
| [ ] | T5 桌面换分辨率 | Windows dev 窗口壁纸 | 把 3838286359 设为桌面，改系统缩放或分辨率 | 标题、歌手、时间的字号跟着变，字形清楚，不重新加载 | 需要用户看 |

## 场景壁纸切 effect 开关后文字停在初值（3840287381）

2026-11-19 Windows dev。文本层带属性控制显隐的 effect 时，切这个属性会按对象重编译那几个文本层。新排版按编译期的初值异步排好、换进状态，盖掉了已经按脚本写入重排的结果；之后脚本每帧写同一串，不再触发重排，文字停在初值（3840287381「余晖来信」切「文字模糊」后问候语、星期、日期回到 MORNING / DAY / `<Date>`）。现在换进状态后，比较状态里的文本字段和排版用的编译期字段，不同就标脏，下一帧按当前字段重排。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`host.l3b.test.ts` 新增用例（重放过的字段与编译期不同时补一次重排，相同不补），以及 `host.l6`、`host.script`、`src/text`；`tsc`；Prettier | 全过 | 2026-11-19 Claude：12 个文件 208 条通过；去掉补重排那一行，新用例失败 |
| [ ] | T2 真机 | Windows dev 预览 | 打开 3840287381 的预览，来回切几次「文字模糊」 | 问候语、星期、日期马上回到当前值（同 WPE），不停在 MORNING / DAY / `<Date>` | 需要用户看 |

## 场景壁纸预览放大更清楚（产品按画布分辨率画 第 3 步）

2026-11-19 Windows dev。图库预览放大场景壁纸时，画布与场景目标跟着放大（以前封顶在「布局 × DPR」，放大只是拉伸），放大后的文字、线条、像素画都按放大后的分辨率画。主窗口（预览、应用背景）的画布不超过 3840×2160 的等量像素，再放大只是拉伸；桌面壁纸窗口不设这个预算（`apps/kabegame` 的 `sceneDisplayScale` / `SCENE_CANVAS_PIXEL_BUDGET`，窗口种类看 `WINDOW_KIND`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | 应用页 vitest：`wpeSceneStyle.test.ts`、`WpeSceneView.test.ts`、`WallpaperPreviewCanvas.test.ts`、`WpeWallpaperContent.test.ts`；`vue-tsc` | 全过 | 2026-11-19 Claude：4 个文件 79 条通过；`vue-tsc` 0 错误；变异 4 处全部检出（`ignore/render-size-a/step3/`） |
| [x] | T2 放大跟着变清楚 | Windows dev 预览（DPR 1） | dino_run 预览从 100% 放大到 223%、1000% | 场景目标 = 画布像素，跟着放大；到预算停住；不重编译 | 2026-11-19 Claude：100% 976×549；223% 2172×1222；1000% 3839×2160（8 292 240 像素，预算 8 294 400）；`recompiled` 一直为空，截图里像素画边缘锐利 |
| [ ] | T3 放大手感 | Windows dev 预览 | 用 Ctrl+滚轮连续放大缩小、拖动 | 不卡、不闪；松手 300 ms 内画面变清楚 | 需要用户看 |

## 场景壁纸按画布分辨率画（产品按画布分辨率画 第 2 步：渲染器接线）

2026-11-19 Windows dev。图库预览、桌面壁纸窗口、应用背景里的场景壁纸不再先按场景分辨率画再缩放上屏，而是同 Wallpaper Engine 按画布像素画、壁纸样式做进正交投影（`alignEdges`，留白底色取 `schemecolor`），上屏 1:1；`center` 仍是一个场景单位对一个布局 CSS 像素，`tile` 保留旧画法。画布尺寸变了（窗口、侧栏、全屏、DPR、显示缩放）去抖 300 ms 后原地换（`GpuScene.resize`），期间旧画面拉伸显示，场景不重新加载；只改样式或留白色立即换。透视场景不再「画布一变就整场重新加载」。光标与文本 `anchor` 改走投影里的边距，和 dev 探针同一套。脚本的 `engine.screenResolution` 不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：新增 `render/productSize.test.ts`（建场景 target 与探针 `planSizedTarget` 逐项相等；状态机：去抖、拉伸、只换最后一次、只换样式立即且不建 RT、tile 切换、换场景作废、resize 失败兜底；fit / center 下产品与探针的光标反投影相同；正交相机对象换尺寸后用新裁切）及 `rebuild`、`parallax`、`particles`、`p5d-camera`、`p5d3-camera`、`p9a`、`p12b`、`anchor`、`cursor`、`renderSize`、`resize`、`host*`、`dev/probe*`；`tsc` | 全过 | 2026-11-19 Claude：19 个文件 645 条通过；`tsc` 0 错误；变异 9 处全部抓到 |
| [x] | T2 产品画面 = 探针画面 | Windows dev，屏外宿主 1920×1080 | eagleflag（2200×1080，铺满时左右裁切）：宿主当前画面 `host.renderFrame(1.5)` 与探针 `renderFrame({ canvas: [1920, 1080], style: "fill", time: 1.5 })` 比 | 逐字节相同 | 2026-11-19 Claude：相同（`c853519e…`）。探针这条路和 WPE 逐像素对过，产品因此同 WPE |
| [x] | T3 dino_run 预览变清楚 | Windows dev 预览 | 打开 dino_run 的预览，读场景目标与画布像素，截图 | 场景目标 = 画布像素（不再是 343×193），右上角计分字形清晰 | 2026-11-19 Claude：976×549 = 976×549，截图里计分边缘清楚 |
| [x] | T4 换尺寸不重载 | 同上 | 预览里打开左侧「图片信息」让画布变小 | 300 ms 后场景目标跟上画布，没有新的「开始渲染」，没有重编译 | 2026-11-19 Claude：976×549 → 696×392，日志只有最初一次「开始渲染」，`recompiled` 为空 |
| [ ] | T5 桌面壁纸 | Windows dev 窗口壁纸 | 把一张小场景（dino_run）和一张大场景（如 3815289650）设为桌面，分别试铺满、装下、居中 | 画面清楚；装下 / 居中的留白是主题配色，越出场景的内容在留白里可见（同 WPE）；帧率正常 | 需要用户看 |
| [ ] | T6 交互 | Windows dev 预览与桌面 | dino_run 的跟随光标、点击跳跃；fit / center 下光标位置 | 光标对得上画面 | 需要用户看 |
| [ ] | T7 平铺与应用背景 | Windows dev | 样式切到平铺；开着应用背景切页面、拖窗口 | 平铺照旧；应用背景不闪、不重新加载 | 需要用户看 |

## 场景壁纸原地换尺寸（产品按画布分辨率画 第 1 步）

2026-11-19 Windows dev。`GpuScene.resize(next, state)`：换场景目标尺寸时只重建按目标尺寸分配的资源（场景目标与交替目标、深度、快照、泛光链、反射两张 RT、体积光、puppet 裁切遮罩、sprite 计数目标），整层强制重建全部图层（绑定组、fullscreen 合成 RT 与 fbo、`g_Screen` 等静态 uniform），状态、粒子、脚本、关键帧、puppet、计时器都不动，同 Wallpaper Engine 改窗口尺寸。新资源先在旁边建好、一次同步换上，等待期间照旧画旧尺寸；旧资源当场释放，共享合成 RT 池里不再被借的旧尺寸条目一并释放。只换投影边距 / 清屏色时不重建 RT。dev 探针 `renderFrame` 加 `resizeFrom`（先按它建、再换到真正的尺寸）。这一步还没接进产品（渲染器、宿主不变），用户看得到的行为不变。计划见 `.claude/plans/wpe-import/3-scene/phase-render-size-product.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`render/resize.test.ts`（建 A 换 B = 建 B 的资源、pass、绑定、uniform 字节；旧资源释放；A → B → A 回到基线；连发串行；只换边距不建 RT；超上限报错）与 `l4`、`l7`、`bloom`、`reflection`、`p13b2-reflection`、`p13e-volumetrics`、`p5b-fullscreen`、`renderSize`、`rebuild`、`p6e-sheets`、`dev/probe.renderSize`；`tsc` | 全过 | 2026-11-19 Claude：12 个文件 293 条通过；`tsc` 0 错误；变异 10 处全部抓到 |
| [x] | T2 全库「建 A 换 B」=「建 B」 | Windows dev，屏外宿主（探针 `resizeFrom`，ultra 档） | 每张能渲染的场景 4 组：fill 1920×1080 → 1280×720、fill 800×450 → 2560×1440、fit 1920×1080 → 900×1600、center 1280×1024 → 2560×1080 | 读回逐字节相同 | 2026-11-19 Claude：285 张 1116 组全部相同（12 张透视场景不收 fit / center，跳过 24 组）；含 HDR 泛光、体积光、反射、puppet 裁切、fullscreen 合成层 |

## 场景壁纸图像层帧表收尾（P6e 第 5 步：全库核对与文档）

2026-11-18 Windows dev。P6e 四步之后的全库核对，产品代码不变，文档见 `cocs/wpe/WPE_SCENE.md`「图像层帧表（P6e）」。数据与脚本在 `ignore/p6/e5/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 全库扫描 | Node，`kbp corpus scan` / `diff` | HEAD 与第 4 步之后的扫描比 | 不变；没有帧表与锚点的键 | 2026-11-18 Claude：干净 223 → 223，逐场景相同；剩下 10 张都不归 P6e |
| [x] | T2 编译产物只在帧表场景上变 | Node，全语料编译摘要（`ignore/live/l0/bundlehash.test.ts` 的副本） | 「HEAD」与「HEAD 减 P6e 四个提交」各编一次（同一个翻译器 wasm），逐场景、逐字段比 | 只有帧表纹理与解锁场景变 | 2026-11-18 Claude：101 张不同。79 张只差帧表纹理新加的 `frames`，去掉后逐字节相同；22 张是不支持集合变了的（解锁的 21 张与 `3577990983`），差在纹理解码、视频时长、`frames` / `images` 与帧表图层的格尺寸。程序、材质、绑定全部相同 |
| [x] | T3 脚本 | Windows dev，屏外宿主，`scriptCorpus` 120 帧 | 和 L7 收尾的基线（`ignore/live/l7/corpus-after`）比 | P6e 只多 `getTextureAnimation` 的调用结果 | 2026-11-18 Claude：符合。原来报 `is not a function` 的段都跑完；唯一的新报错是 `3400241651` 里对非帧表图层调 `getTextureAnimation().getFrame()`（WPE 同样返回 `null`）。其余不同的场景归到同期别的提交 |
| [x] | T4 画面哈希 | Windows dev，屏外宿主，全库 3 档 | 和 L7 的基线（`ignore/live/l7/hash-after.json`）比；变了的逐张证明原因 | 没用到帧表的场景不变，或变化另有证据 | 2026-11-19 Claude：对上 216 张，变了 17 张，全部有证据：P6e 解锁的 10 张；WPE 的 `reflection` 设置被改开、用户改过属性值的 3 张（用 L7 的输入加反射关重渲，逐字节复现 L7）；预热封顶的 2 张（Node 按提交二分粒子，正好在 `bde7b148` 变）；P13g / P13h / P13j-2 解锁的 2 张（编译产物按提交二分）。粒子帧表的 79 张里能比的 72 张，70 张不变。12 张视频场景等首帧超时、没比（L7 同样）。第一次跑到一半宿主被别的会话重建，失败的按批重跑 |

## 场景壁纸多图像帧表（P6e 第 4 步）

2026-11-18 Windows dev。一张 `.tex` 里有多张图像的帧表不再报 `tex:animation:multi-image`：全部图像进 bundle、每张一张 GPU 纹理，选格时按这一格的 `imageId` 换绑那张图像（同 Wallpaper Engine，帧坐标按该图像归一化，`g_Texture<n>Resolution` 仍是头尺寸）；bind group 按「fbo 状态 + 各多图像槽的图像号」缓存，平面反射的副本同样按图像号缓存。单图像帧表与普通纹理不变。FreeImage 形态的多图像帧表报 `tex:animation:multi-image:freeimage`（语料没有）。多图像场景的显存按图像数涨（单张约 7680×7920 DXT）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`src/render`、`compile/sheet.test.ts`、`compile/tex.test.ts`、`compile/workerHandler*`、`compile/p6e*`；`tsc` | 全过 | 2026-11-18 Claude：66 个文件 1554 条通过；`tsc` 0 错误；变异 4 处全部抓到 |
| [x] | T2 和 WPE 逐像素比 | Windows dev，屏外宿主（dev 探针，`canvas` 1280×720，dt 取 WPE 日志） | `ignore/p6/e0/proj/p6e-tex`（含两张图像的 M1）回放到 f192–f207，和 `ignore/p6/e0/out/png/wpe-tex-f*.png` 比；脚本日志逐行比 | 0 差异 | 2026-11-18 Claude：八帧整帧 0 差异（含 M1 在 f199 换到图像 1、之后再换回），日志 208 行逐行相同 |
| [x] | T3 全库 | Node，`kbp corpus scan` / `diff` | 与第 3 步之后比 | 只去掉 `tex:animation:multi-image` | 2026-11-18 Claude：能渲染 221 → 223（3000562427、3486806915），3577990983 只剩 `puppet:draw-order`；没有新增键；全库已没有 P6e 的键 |
| [ ] | T4 多图像场景预览 | Windows dev 预览 | 打开 3000562427、3486806915 的预览看一会儿 | 帧表动画跨图像时不跳、不闪 | 需要用户看 |

## 场景壁纸文本的 anchor（P6e 第 3 步）

2026-11-18 Windows dev。文本对象的 `anchor`（`top`、`topright`、`right`、`bottomright`、`bottom`、`bottomleft`、`left`、`topleft`、`center`）不再报 `text:anchor:*`：绘制时在世界空间加一段平移，让文字跟着可见区域的边或中心走（同 Wallpaper Engine，平移表照 rea-p6b-layout 3.4，与自身和父链的缩放、旋转无关），光标命中同样带上。可见区域由每帧的 `E0..E3`（四边被裁掉的场景单位）给出：dev 探针按窗口画时就是投影用的那份；产品按显示铺放算 `alignEdges(样式对应的对齐方式, 场景宽高, 画布 CSS 宽高)`，铺满时同 WPE；装下 / 居中时 E 为负，贴边的文字被推到场景之外，产品只画场景目标，看不到（render-size 的已知差异）；拉伸、平铺与透视场景为 0。脚本运行中改 `anchor` 走单对象重编译、晚一小段才生效（WPE 当帧，语料没有这种写法）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`render/anchor.test.ts`（平移表、世界空间、产品 E、探针 E、光标命中）、`compile/texts.test.ts` 与 `render/` 下文本、光标、铺放、`host`、`dev/probe.renderSize`；`tsc` | 全过 | 2026-11-18 Claude：17 个文件 366 条通过；`tsc` 0 错误；变异 7 处抓到 6 处，没抓到的是等价变异（拉伸时 `alignEdges` 本来就是 0） |
| [x] | T2 和 WPE 逐像素比 | Windows dev，屏外宿主（dev 探针按 WPE 抓帧的窗口尺寸与对齐方式画） | `ignore/p6/e0/proj/p6e-anchor`（十种 anchor）在 1920×1080 铺满、900×1600 铺满 / 装下、2560×1080 装下、960×540 居中，`p6e-anchor2`（自身放大 2 倍、转 90°、父对象缩放 0.5）在 1920×1080 / 900×1600 铺满，和 `A:\p6e\anchor*` 的上屏帧比 | 文本 0 差异 | 2026-11-18 Claude：七组里文本全部 0 差异；剩下的差异只在计数层（脚本帧号不同），其中三组计数层在窗口外、整帧 0 差异 |
| [x] | T3 全库 | Node，`kbp corpus scan` / `diff` | 与第 2 步之后的结果比 | 只去掉 `text:anchor:*`，不新增键 | 2026-11-18 Claude：能渲染 214 → 221，本步解锁 5 张（dino_run、2981249186、3351163962、3560756264、3643916956；另 2 张是同期别的会话修的着色器）；没有新增键，没有掉出；5 张冒烟渲染无不支持项、无脚本错误 |
| [ ] | T4 预览与桌面 | Windows dev 预览 / 窗口壁纸 | 打开 dino_run、3643916956 的预览，换窗口比例与样式（铺满 / 装下）；设为桌面 | 铺满时右上角计分、左右两侧的歌名贴着可见区域的边；装下时贴边文字在场景外看不到（已知差异） | 需要用户看 |

## 场景壁纸图像层帧表的脚本控制（P6e 第 2 步：`ITextureAnimation`）

2026-11-18 Windows dev。图像层的 `getTextureAnimation()` 不再报 `script:api:layer.getTextureAnimation`：返回的对象默认跟着纹理的共享计时器走；`pause` / `stop` / `setFrame` / 写 `rate ≠ 1` 让这个图层脱离，之后每帧在对象更新里（脚本之前、不看可见性）按 `g_Frametime × rate` 推进自己的帧号，画这个图层时所有帧表都画这一格（越界画第 0 格、负数改走共享计时器），`join()` 并回。状态在 `SceneState.textureAnimations`，跨单对象重编译与整场重载接回，图层删除或槽 0 换成用户纹理时清掉。成员、键序、每个对象一个原型、只读字段的报错、`rate` 只收 number、`setFrame` 只认 int32（其余当 0）、和 `getVideoTexture()` 共用一格、作废后读写都是 `undefined`，均照 WPE 实测。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`script/textureAnimationApi.test.ts`（含按 `p6e-api` 的 WPE 日志 170 帧逐帧比 `getFrame` / `isPlaying` / `rate`、按 `p6e-rate` 比私有推进）、`render/p6e-sheets.test.ts`，以及 `src/host`、`src/dev`、`src/script`、`compile/scriptApi.test.ts`；`tsc` | 全过 | 2026-11-18 Claude：61 个文件 1012 条通过；`tsc` 0 错误；变异 12 处全部抓到 |
| [x] | T2 脚本日志与 WPE 逐行比 | Windows dev，屏外宿主（dev 探针，`canvas` 1280×720，dt 取 WPE 日志） | `ignore/p6/e0/proj/p6e-api` 回放到 f317，`[kbp] p6e` 日志与 `ignore/p6/e0/out/api2-log.txt` 逐行比 | 相同（下面两行除外） | 2026-11-18 Claude：378 行里 376 行相同。`top`：模块顶层的 `thisLayer` / `thisObject` WPE 是 `null`、我们不是（脚本运行时原有的差异，与帧表无关）；`desc`：`frameCount` / `rate` 的属性描述 WPE 是数据属性、我们是访问器（同 `IAnimationLayer`，为了作废后读到 `undefined`） |
| [x] | T3 脱离图层的画面 | 同上 | `p6e-api` 回放到 f306–f317，和 `ignore/p6/e0/out/png/wpe-api2-f*.png` 整帧比 | 0 差异 | 2026-11-18 Claude：六帧整帧 0 差异（停在第 2 格、越界画第 0 格、负帧号走共享、`stop`、正播与倒播的私有推进） |
| [x] | T4 全库 | Node，`kbp corpus scan` / `diff` | 与第 1 步之后的结果比 | 只去掉 `script:api:layer.getTextureAnimation`，不新增键 | 2026-11-18 Claude：能渲染 205 → 214，本步解锁 8 张（3286859278、3319542538、3326873240、3400241651、3516174947、3524852519、3570560686、3826860299；另 1 张 3455121165 是同期别的会话的聚光阴影）；没有新增键，没有掉出 |
| [ ] | T5 按钮类帧表场景 | Windows dev 预览 | 打开 3326873240 / 3400241651 / 3516174947（「夜莺Night」系列）、3570560686、3826860299 的预览，点几个开关按钮 | 按钮的帧随点击切换，和 WPE 一样 | 需要用户看 |

## 场景壁纸图像层帧表（P6e 第 1 步：编译与共享计时器）

2026-11-18 Windows dev。图像层上的帧表（sprite sheet）纹理不再报 `tex:animation` / `combo:SPRITESHEET`：bundle 带上完整帧表（每格帧时长、所在图像、`Rotation` / `Translation`），渲染器给每张帧表纹理一份共享计时器，同 Wallpaper Engine 只在本帧第一次有 draw 画到这张纹理时按 `g_Frametime` 推进（每帧最多一格、余量截掉、总是循环），没画到的帧不推进也不补时间，再把这一格写进 draw 的 `g_Texture<n>Rotation` / `Translation`。帧表图层的 `autosize` 与合成 RT 取 TEXS 头里的格尺寸；TEXS0003 直接上屏的 UV 取 (1, 1)，合成路径的基础 pass 照 WPE 实测仍按「图像 / 纹理」。脚本的 `getTextureAnimation`、多图像帧表、文本 `anchor` 是后面几步，仍照报。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Windows | wpe-scene vitest：`render/sheets.test.ts`、`render/p6e-sheets.test.ts`、`compile/p6e-sheets.test.ts`、`render/graph.test.ts` 与改了期望的 `compile/sheet`、`refract`、`p12b2-tc`、`p2a`、`p8`；`tsc` | 全过 | 2026-11-18 Claude：9 个文件 223 条通过；`tsc` 0 错误；变异 12 处抓到 11 处，没抓到的是等价变异（版本 < 3 的帧表本来没有 gif 宽高） |
| [x] | T2 推进节奏和 WPE 一致 | Windows dev，屏外宿主（dev 探针，`canvas` 1280×720，`particles.dts` 取 WPE 日志逐帧的 `engine.frametime`） | `ignore/p6/e0/proj/p6e-rate`（帧时长 0.1 / 0.02 / 0 的三张帧表）回放到 f228–f232，和 `ignore/p6/e0/out/png/wpe-rate-f*.png` 按区域逐像素比 | 帧表图层 0 差异 | 2026-11-18 Claude：三层五帧全部 0 差异（计数层不同是脚本调了第 2 步的 `getTextureAnimation`，预期） |
| [x] | T3 NPOT、TEXS0002、旋转帧、autosize | 同上 | `p6e-tex-single`（`p6e-tex` 去掉多图像那层）用 `p6e-tex` 的 WPE 日志回放到 f192–f200 比 | N1–N4、R1 0 差异 | 2026-11-18 Claude：五层五帧全部 0 差异，含「带 effect 的 NPOT 帧表只画出格的左上一块」（WPE 实测） |
| [x] | T4 共享计时器的隐藏规则 | 同上 | `p6e-shared` 全部图层与 WPE 比 | 一隐一显同格；两个都隐不推进不补 | 2026-11-18 Claude（第 2 步之后，脚本跑得起来了）：f213–f236 七帧整帧 0 差异，脚本日志 237 行逐行相同 |
| [x] | T5 全库 | Node，`kbp corpus scan` / `diff` | HEAD + 本步与基线比 | 只去掉 `tex:animation`、`combo:SPRITESHEET`，不新增键 | 2026-11-18 Claude：能渲染 199 → 205（2833017810、2916324703、3420277613、3662390671、3811424158、3818053626），两个键各去掉 20 张，没有新增，没有掉出；新解锁的 6 张冒烟渲染无不支持项、无脚本错误 |
| [x] | T6 新解锁的场景预览 | Windows dev 预览 | 打开上面 6 张的预览看一会儿 | 帧表在动，节奏和 WPE 一样；3818053626 开场约 10 s 是黑的开场动画 | 需要用户看 |

## 场景壁纸运行中的结构变化不重编（活的场景图 L7）

2026-11-17 Windows dev。脚本 `setParent` 进出组合层 / 挂到骨骼、`destroyLayer` 删组或删组里的对象，不再整场重编译，当帧生效（同 Wallpaper Engine）：每个组合层都预编 `groupUpload` 上屏 pass（没有子层的在全部对象之后编、程序排表尾）；登记表 `restructure` 比较重算前后的组 / 组的层数 / 子树 / 挂点 / 组内 effect 标记报出变化集合；宿主 `applyRestructure` 把运行中出现的组内不支持组合（子层读快照、fullscreen、透视、模型、形状，以及透视场景 / 被依赖 / 开雾的组）按「那个对象不画 + 看板娘提示一次」处理、消失时装回，其余交给渲染器在同一帧脚本之后 `flushRestructure`：按计划签名加组归属（`placement`）重建受影响图层、缺的管线同步建、合成 RT 按组的层数换池、挂点表更新，失败整场重载兜底。`reparentNeedsRecompile` / `destroyNeedsRecompile` 删掉，`fragmentBlocker` 不再挡组合层。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 单测与检查 | Windows | wpe-scene vitest（compile / script / dev / render / animation / text、`changes`、`fragmentCache`、全部 `host.*`）、`tsc`、prettier | 0 error；全过 | 2026-11-17 Claude：189 文件 3847 条通过（111 skipped）；我复跑 L7 相关 12 个文件 355 条；执行代理 11 条 + 我 5 条变异全部抓到（我另 1 条是等价变异） |
| [x] | T1 编译产物与状态不变 | Windows | 编译摘要（`KBP_IGNORE_GROUP_UPLOAD=1`）、L3 登记表 / L3b 子系统对照、L1 片段对照、L6 会话对照、全库画面哈希、`scriptCorpus` | 摘要 233 全同；对照全 0；哈希 216 × 3 档不变；`scriptCorpus` 只有有空组合层的场景 `stateDigest` 变（`constants` 多了 `groupUpload`） | 2026-11-17 Claude：摘要与 L0 原基线 233/233 相同；登记表 6448 个对象 / 子系统 233 张全 0；片段 6407 个、会话 2572 个 0 不同（blocked 只剩 `depended`）；`scriptCorpus` 95 张 `stateDigest` 变、逐张与「有空组合层」一致、脚本行为与控制台摘要不变；画面哈希对上的 213 张 × 3 档全部相同（基线里 3 张已不在库里） |
| [x] | T2 进组 / 成组 / 出组 / 删组当帧生效 | Windows dev 回放 | `ignore/live/l7/proj/live-regroup`（第 60 帧 A 进组 G、90 帧 C 挂进空组合层 H、120 帧 A 出组、180 帧删组 G，粒子 P 一直发射）按 f37 / 66 / 115 / 159 / 219 回放，与 WPE 抓帧比 | 没有整场重编译、`restructured` 逐步 1–4；五张整帧只差粒子行与标记行；脚本日志与 WPE 逐行相同；P 的粒子连续 | 2026-11-17 Claude：`recompile: []`、`restructured` 1 / 2 / 3 / 4；差异连通块只在 y 0–32（标记 M，WPE 抓到的是帧间）与 y 96–128（粒子行，发射时序），A / B / C / G / H 各块 0 差异；11 行日志逐行相同；P 存活 112 → 173 连续 |
| [x] | T3 删组当帧子层回顶层（原已知差异） | Windows dev 回放 | `ignore/p6/d3/proj/p6d3-struct` 第 5（f660）、6（f760）阶段与 `ignore/p6/d3/out/wpe-s5.png` / `wpe-s6.png` 比 | 两帧 0 差异（P6d3a 时第 6 阶段差左下角 G1） | 2026-11-17 Claude：两帧 `> 0` 像素数都是 0 |
| [x] | T4 预览里的实时表现 | Windows dev 预览 | 打开 `live-regroup` 的预览看完整段 | 只有一次「开始渲染」；画面按 WPE 的时序变化；看板娘不弹提示 | 2026-11-17 用户看完预览，也设成桌面看过；日志每次打开只有一次「开始渲染」，脚本 s1–s4 照序跑完，15405 没有不支持项上报。日志里的 `[kblive] …` WARN 是测试脚本自己的 `console.error` 标记（宿主把场景脚本的 `console.error` 记成 warn） |
| [x] | T5 组内不支持组合的提示 | Windows dev 预览 | 脚本把 fullscreen / 读快照 effect 的图层挂进组 | 那个图层不画、看板娘提示一次；出组后恢复 | 单测覆盖（`host.script.test.ts`）；未真机 |
| [ ] | T6 挂点换父 | Windows dev | `ignore/p6/d3/proj/p6d3-attach` | 挂到骨骼后矩阵当帧跟 puppet，无重编译 | 单测覆盖（`l7` 挂点表、`registry` 换挂点）；未真机 |

## 场景壁纸运行中单对象重编译（活的场景图 L6）

2026-11-17 Windows dev。要重编译才生效的对象级改动（脚本写文本层的 `font` 等非运行中字段、属性面板改 `size` / `colorBlendMode`、打开带不支持项或在冻结图层上的 effect）不再整场重新加载：宿主按路径分级（`objects/<i>/…` 对象级、`general/…` 场景级），对象级交给 `LiveObjects.recompile`（和 `createLayer` 同一条队列），编译会话按开会话时留的原文套这个对象累计的覆盖重编（`compileFragment` 带 `overrides`），片段到达后下一帧开头替换：登记表 / 状态 / 子系统按对象换（关键帧按 `id` 接回时钟，文本旧排版留到新排版回来），GPU `installObject` 替换同一对象、粒子定义没变时沿用旧粒子树。同一对象在编期间再写只记最新一份、到达后按最新再编一次（最后一次胜出）。`init` 里写的（语料 13608 / 15019 的 `font`）片段到齐接进还没换上的 bundle，不再整场编第二次。场景级（`general/hdr`）、带体积光的灯、整场重载进行中新场景还没换上时的写入照旧整场。**L6b**（同日补）：被依赖的图层（别的图层按名字绑它的独占合成 RT）也走这条路——替换时独占 RT 形状相同就沿用旧的那张、引用方不动，尺寸或采样变了才换新的，并对引用它的 draw 重建 bind group、按新尺寸写 `g_Texture<n>Resolution`（`rebindDrawInputs`，同用户纹理换图）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 单测与检查 | Windows | wpe-scene vitest（compile / script / dev / animation / render / text、`changes`、`fragmentCache`、全部 `host.*`）、`tsc`、prettier | 0 error；全过 | 2026-11-17 Claude：188 文件 3823 条通过（111 skipped）；我复跑 L6 相关 11 个文件 281 条；执行代理 6 条 + 我 5 条变异全部抓到 |
| [x] | T1 会话对照与全语料不变 | Windows | `ignore/live/l6/recompile.test.ts`（全语料前 20 个对象空覆盖重编 vs `fragmentOf`；13608 / 15019 的 `font` 覆盖 vs 带同样 `scriptOverrides` 整场编）；编译摘要、L3 登记表、L3b 子系统对照；`scriptCorpus` 236 张 | 0 不同；全同；`scriptCorpus` 236/236 不变（它没有会话，对象级写入仍记在 `recompile` 里） | 2026-11-17 Claude：2572 个对象 0 不同（26 个带 `fragmentBlocker` 的也比了）、`font` 23 个对象 0 不同、`sceneFlips` 只有 5 个 `volumetrics`；编译摘要 233 同哈希；登记表 / 子系统全 0；`scriptCorpus` 236 相同、0 不同 |
| [x] | T2 脚本换字体只编一个对象 | Windows dev 预览 | `ignore/live/l6/proj/live-font`（文本 T 第 60 帧 `thisLayer.font = 'systemfont_comicsans'`，粒子 P 一直发射） | 只有一次「开始渲染」；`recompiledObjects: 1`、`recompiled: []`；第 61 帧起读回 comicsans、画面是 Comic Sans；P 的粒子不重来 | 2026-11-17 Claude：一次「开始渲染」（390 ms）；`stats.recompiledObjects: 1`、`recompiled: []`；日志 `f=61/62/90/180 font systemfont_comicsans`；截图字形是 Comic Sans；P `alive 301 = highWater 301`，粒子条连续；帧时间 0.32 ms |
| [x] | T3 `init` 里写字体的真实场景 | Windows dev 预览 | 创意工坊 15019（`init` 里 5 处 `font`） | 只有一次「开始渲染」；`recompiledObjects: 5`、`recompiled: []`；时钟文字照常显示 | 2026-11-17 Claude：一次「开始渲染」（66 层，1760 ms）；`recompiledObjects: 5`、`recompiled: []`；6 个文本层在、时钟显示；13608 因 `script:api:layer.getTextureAnimation` 本就退回预览图，看不了 |
| [x] | T4 属性面板改对象级设置 | Windows dev 预览 | `ignore/live/l6b/proj/live-dep`（A1 带纹理、A2 纯色，`size` 都绑属性 `sz`；B1 / B2 用 kbref effect 引用它们的独占 RT），经宿主的 `wallpaperPropertyListener.applyUserProperties` 改两次 `sz` | 只重编那两个对象，不整场重载；画面按新 size 变；引用方正常；粒子不重来 | 2026-11-17 Claude：两轮共 `recompiledObjects: 4`、`recompiled: []`、一次「开始渲染」；A1 / A2 变成 120×300 再变 320×160，B1 / B2 正常显示、无 WebGPU 错误；粒子 206 → 301 连续；帧时间 0.32 ms |
| [x] | T7 被依赖图层的替换（L6b） | Windows | `render/l4.test.ts` 的三条用例 + 上面的 T4 | 形状相同沿用旧的独占 RT（引用方 bind group 不动）；尺寸或采样变了换新的、旧的销毁、引用方重绑并按新尺寸写 `g_Texture<n>Resolution` | 2026-11-17 Claude：三条用例通过，5 条变异全部抓到；`objectLive` 不再因 `dependedOn` 退回整场 |
| [ ] | T5 整场重载进行中的写入 | Windows dev 预览 | 改 `general/hdr`（整场重载）的同时脚本写对象级目标 | 新场景换上前的写入随重载生效；换上之后的交给单对象重编译 | 单测覆盖（「重载进行中照旧整场」）；未真机 |


## 场景壁纸运行中建层走片段（活的场景图 L1–L5）

2026-11-17 Windows dev。场景脚本 `createLayer` 不再整场重新加载：编译拆成常驻 Worker 里的会话（`openCompileSession` / `compileFragment`），bundle 有了登记表（`SceneRegistry`）、状态与各子系统（关键帧、puppet、文本、脚本、声音）有了按对象的增删入口，`GpuScene` 有了 `prepareObject` / `installObject` / `removeObject`（整场加载也走同一条路，全库画面哈希不变），宿主按规整配置查片段缓存：命中当场接进并装 GPU（`createLayer` 返回前完成、当帧画出，`init` 读到编好的 `size`），没命中建壳、会话异步编、下一帧开头装上并进缓存。`init` 里建的层不再让场景二次编译。运行中建的对象带不支持项时不画、其余照常，宿主经 `wpe_scene_report` 的 `unsupported` 上报，Rust 以 `wpe-scene-unsupported` 发到主窗口，看板娘提示一次（同图同键只一次；桌面壁纸窗口的也送主窗口）。删除生效后登记表、状态、子系统、GPU 一起摘；改组归属的删除仍整场重载（L7）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 单测与检查 | Windows | wpe-scene vitest（compile / render / script / dev / host*）、`tsc`；kabegame `vue-tsc`、`useSceneUnsupportedNotice.test.ts`；Rust `wpe_scene` | 0 error；全过 | 2026-11-17 Claude：wpe-scene 204 文件 4002 条；composable 5 条；Rust 16 条；`cargo check` 被运行中的 dev 占文件没跑成，dev 自动重编 Rust 成功 |
| [x] | T1 编译产物与状态不变 | Windows | 全库编译摘要、L3 登记表对照、L3b 子系统对照、全库画面哈希（216 张 × 3 档）、`scriptCorpus`（236 张） | 全同 / 0 差异；`scriptCorpus` 只少了 `recompile` 里的 `createLayer/*` | 2026-11-17 Claude：全部成立；`14294` 的两条 `createLayer/142`、`/143` 重编译记录消失，状态与控制台摘要不变 |
| [x] | T2 克隆当帧出现 | Windows dev 预览 | `ignore/live/l0/proj/live-clone`（第 90 帧克隆 K / B / T） | 三个克隆走同步路径、第 90 帧的对象表里就有；K2 当帧读静态值 0.5（同 WPE）；没有重编译 | 2026-11-17 Claude：`created.sync: 3`、`recompiled: []`，日志 `f=90 K2 n:0.5` 与 WPE 一致；帧时间 0.6 ms |
| [x] | T3 `init` 里建层不二次编译 | Windows dev 预览 | `ignore/p6/d3/proj/p6d3b-bars`（`init` 里建 7 根柱子） | 只有一次「开始渲染」、首帧 10 层；脚本日志与 WPE（`ignore/p6/d3/out/wpe-bars.log`）逐行相同 | 2026-11-17 Claude：一次编译、10 层；前 10 行逐行相同（宿主转发限流 10 条 / 分钟，其余由探针单测覆盖） |
| [x] | T4 运行中不支持项的提示 | Windows dev 预览 | `ignore/live/l5/proj/live-unsup`（第 60 帧建没有 effect 的形状对象，第 120 帧克隆 K） | 形状对象不画、脚本照常读到它；看板娘弹「预览里的场景壁纸运行中用到了暂不支持的特性：shape:effects…」一次；K2 当帧出现 | 2026-11-17 Claude：`created: { sync: 1, unsupported: 1 }`，后端 warn 一条，看板娘历史里有这条提示；画面两个绿块（K、K2），没有形状对象 |
| [x] | T5 桌面上的提示 | Windows dev 窗口壁纸 | 把 `live-unsup` 设为桌面壁纸 | 提示文案是「桌面的场景壁纸…」，弹在主窗口 | 2026-11-17 用户确认；日志里壁纸窗口上报 `wallpaper: 场景 15513 … 运行中用到不支持的特性：shape:effects`。提示按「图 + 键」去重、不分预览与桌面，测之前这张图不要先在预览里打开过 |
| [x] | T6 建删循环 | Windows dev，屏外宿主实时跑 | `ignore/p6/d0/proj/p6d-cycle`（每 4 帧建一次、隔 2 帧删掉同一配置的黄层 Y），约 80 秒采样 `host.stats()` / `host.state()` | 第二轮起新对象当帧出现；结构长度不随轮数增长；帧时间稳定 | 2026-11-17 Claude：`created` 只有第一次 `async`，之后 467 次全 `sync`；`recompiled` 0；状态里的图层一直 2–3 个；帧时间均值 0.6–0.7 ms、p95 约 1.2 ms。结构长度探针读不到，由 `recordDestroyed` 的同配置去重保证。屏外宿主在视口外会被 Chromium 节流、不出帧，要临时挪进视口（`opacity: 0`）才走 |
| [x] | T7 删除清理 | Windows dev，屏外宿主（dev 探针 `renderFrame`，dt 1/60，1280×720） | `ignore/p6/d3/proj/p6d3-struct`：900 帧 `[kbp6d3]` 日志与 `ignore/p6/d3/out/wpe-struct.log` 逐行比；f660 / f760 与 `wpe-s5.png` / `wpe-s6.png` 逐像素比 | 删除（含删组，L7 起）当帧重排、不整场重载；最终对象表与 WPE 一致 | 2026-11-17 Claude：日志 27/27 相同（含最后的对象表）；两帧 0 像素不同；`restructured` 4、`reloads` 与 `recompiled` 为空 |
| [x] | T8 和 WPE 逐帧 / 逐行（探针预跑） | Windows dev，屏外宿主（dev 探针 `renderFrame` 带 `prewarmFragments`） | `p6d-cycle` f126–f133 与 `ignore/p6/d0/out/wpe-cycle-f*.png` 逐像素比；`p6d-frame` 160 帧 `[kbp6d]` 日志与 `ignore/live/l0/wpe-p6d-frame.log` 逐行比 | 8 帧 0 差异；56 行逐行相同 | 2026-11-17 Claude：8 帧 0 差异（f126 与 f128 互相差 29800 像素，确认帧间在变）；56/56 相同。不预跑时 `p6d-cycle` 的 Y 不画（探针同步回放等不到片段，已知局限） |
| [x] | T9 待编对象的 `isObjectValid` | Windows dev，屏外宿主（dev 探针，不预跑） | `p6d-frame` 160 帧日志与 `wpe-p6d-frame.log` 逐行比 | 56 行逐行相同（修复前差 3 行：没命中缓存、还在待编的 Y 同帧 `destroyLayer` 之后 `isObjectValid` 为假，WPE 为真）；单测 `createLayerApi.test.ts`「engine.isObjectValid(待编对象)」 | 2026-11-17 Claude：真机 56/56 相同（预跑的那遍同样 56/56）；单测通过，去掉修复后该条失败 |

## CEF / Chromium 149 → 156（安全更新）

2026-11-16 macOS。`third/cef` 从 7827（Chromium 149.0.7827.201）逐个分支升到 8078（CEF 156.0.30，Chromium 156.0.8078.96）：7871 → 7922 → 7977 → 8037 → 8078，每一级把补丁序列重新生成并校验内层 Chromium 补丁，只在最后编译一次。补丁 01（扁平子进程路径）删除：Chromium 156 的 `ChildProcessHost::GetChildPath()` 已原样使用显式 `--browser-subprocess-path`，不再改写成 macOS helper `.app` 变体——release（bundled）的子进程起不起得来全靠这一点，T4 必须在打包版上验。03 的内层拖出补丁适配上游新增的 `DropData::drag_id`（保留），09 的内层 rAF 补丁适配 `BeginMainFrameReason` 与 `LocalFrameMetricsAggregator`，04 / 05 / 11 只有上下文冲突，其余只有上下文漂移；所有补丁的增删行与 149 版相同（03 / 09 的差异只在内层补丁的上下文行）。`third/cef-rs` 换到上游 `dev` 的 `cef-v156.6.0+156.0.30`（bindings 生成自同一 CEF 提交），01 / 02 在上游重写的 `sys/build.rs` 上重做。`build-chromium.ts` 默认分支 / archive 版本改为 8078 / 156.0.30；升版本后的第一次构建要带 `--clean`（automate-git 在浅 checkout 下会自己删旧 `src`、重写 `.gclient`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 补丁序列 | macOS | 每一级 `deno task patch cef --check`；内层补丁按 `CHROMIUM_BUILD_COMPATIBILITY.txt` 的 tag 从 gitiles 取文件、按 `patch.cfg` 顺序先打 CEF 自带补丁再打 kabegame 的（`git apply -p0 --ignore-whitespace`，不容忍 fuzz） | 每一级 CEF 序列与三个内层补丁都能打上 | 2026-11-16 Claude：150 / 151 / 152 / 154 / 156 全过；校验脚本先在 149 上跑一遍确认可信。150、152、156 各迁过一次 raf 内层补丁，156 迁了拖出内层补丁并删 01 |
| [x] | T1 接口核对 | macOS | 补丁覆盖或调用的 Chromium 接口在 149 与 156 的声明逐项比较；`Page::Animate()` 在 149–156 的六个 tag 上比较 | 无变化 | 2026-11-16 Claude：`PreHandleDrag*`、`OnPerformingDrop`、`RegisterNonNetworkSubresourceURLLoaderFactories`、`ShouldEmbeddedFramesTryToReuseExistingProcess`、`CreateFileURLLoaderFactory`、`GrantRequestScheme`、`GrantLoadLocalResources`、`TransformPointToCoordSpaceForView`、`ForwardMouseEvent`、`GetPendingCommitCrossDocumentNavigations` 等都没变；`Page::Animate()` 六个版本逐字相同 |
| [x] | T2 cef-rs 绑定 | macOS | 官方 CEF 156.0.30 macosarm64 作 `CEF_PATH`、独立 target 目录：`cargo check -p cef -p cef-dll-sys`；四个目标的 sys 绑定各自单独编译 | 通过；三个扩展结构体的尺寸断言成立 | 2026-11-16 Claude：check 通过；`_cef_drag_handler_t` 88、`_cef_drag_data_t` 264、`_cef_frame_t` 272 四个目标一致。Windows 文件单独编译时 `tagPOINT` 等 3 处失败来自本机 `c_long` 8 字节，上游未打补丁的文件同样失败 |
| [x] | T3 主应用检查 | macOS | 同上 `CEF_PATH` 与独立 target 目录，`deno task check -c kabegame` | 0 error | 2026-11-16 Claude：vue-tsc 与 cargo check 都过，`tauri-runtime-kbcef` 不用改代码 |
| [ ] | T4 自编 CEF 156 | macOS | `deno task build:chromium --clean` | automate-git 发现旧 checkout 是 149、自己删掉 `src` 并重写 `.gclient`，浅 checkout 156 后编译，产出 `bin/macos/arm64/cef-build`，`archive.json` 为 `156.0.30` | 不带 `--clean` 时 automate-git 自己会报「Current Chromium checkout with --no-chromium-history is incorrect」。2026-11-16 第一次尝试：我在脚本里预先删了 `src`，automate-git 因此没重写 `.gclient`、又去拉 149，且经本机代理的大包下载断了四次（`curl 56 … bad decrypt`）；预删已撤回 |
| [x] | T5 dev 启动与内核版本 | macOS dev、**Windows dev** | 自编 CEF 就位后 `deno task dev -c kabegame`；主窗口执行 `navigator.userAgent` | 正常启动、画面正常；UA 为 `Chrome/156` | 2026-11-20 Claude（Windows）：CDP 握手报 `Chrome/156.0.8078.96`，UA `Chrome/156.0.0.0`、`userAgentData` 品牌 Chromium 156，WebGPU 可用、Tauri IPC 在；画廊 9434 张图正常显示，应用背景的场景壁纸实时渲染（调试面板 MIN 118 AVG 120）。macOS 未做 |
| [ ] | T6 打包版子进程（原补丁 01） | macOS release `.app` | `deno task b -c kabegame` 后从 `.app` 启动 | renderer / GPU 进程都从 `Contents/MacOS/kabegame-cef-helper` 起来，不去找 `Helper (Renderer).app`；首屏正常、无 `ERR_ABORTED` 黑屏 | 删掉 01 后唯一靠上游行为兜底的地方 |
| [~] | T7 外部拖入（02） | 三平台 | 从 Finder / 资源管理器把图片拖进画廊与画册 | 拖动中有落点提示、松开后导入，CEF 不把文件打开成预览页 | |
| [~] | T8 拖出真实文件（03） | 三平台 | 从图库拖一张到 Finder / 资源管理器、Chrome 上传框、VS Code | 得到原图文件（不是缩略图或链接），库内文件不被移走 | 156 新增的 `drag_id` 保留在拖动数据里，确认 Chrome / Electron 仍收得到文件 |
| [x] | T9 网页壁纸与图库 `file:`（04–07） | macOS / **Windows dev** | 图库缩略图与原图、网页壁纸预览与桌面、壁纸读同目录文件、越界读 | 图片视频正常显示；壁纸正常加载；越界读被 `deny file:` 拒 | 2026-11-20 Claude（Windows）：画廊里 25 张 `file://` 图片**零加载失败**（补丁 06）；场景壁纸 15881 在壁纸窗口（3840×2160）与主窗口应用背景（1851×1191）各渲染成功，15 层 11 个程序。闸门工作正常：未授权路径被拒。**注意有一批预期内的 `deny file:` 噪声**——104 条（两个窗口各 52）全在加载那一瞬，拒的是 `shaders/flat.vert`、`models/util/solidlayer.json` 这类**项目目录里根本不存在**的路径，是「项目散文件 → `scene.pkg` → WPE `assets/`」查找顺序的第一步探测，随后从 pkg / assets 取到，不是回归 |
| [x] | T10 进程隔离与 rAF（08 / 09） | macOS dev、**Windows dev** | 预览与桌面同时开网页壁纸，看 renderer 进程数；场景宿主里数 rAF 回调次数 | 两个窗口的 iframe 各一个 renderer；每帧 rAF 一次 | 2026-11-20 Claude（Windows）：两个窗口各有一个场景宿主 iframe（同一张 15881）。**判别实验**：把主窗口宿主用同步死循环阻塞 2000 ms，壁纸窗口宿主的 rAF 照跑——10.0 s 内 1200 次、119.6 fps、最大间隔 25 ms、**零个 > 100 ms 的间隔**，证明两个 `file:` iframe 在各自的渲染进程里（补丁 08）。显示器 120 Hz、实测 119.6 fps = 每帧一次（补丁 09）。堆内存对比不可用：Chrome 量化了 `performance.memory`，分配 300 MB 读数不变 |
| [x] | T11 Ctrl+滚轮（10） | Windows | 在预览的网页壁纸上 Ctrl+滚轮 | 整个应用不缩放 | 2026-11-20 Claude：经裸 CDP 往**主窗口里的场景宿主 OOPIF** 派发 5 个 `Input.dispatchMouseEvent` mouseWheel + Ctrl，frame 收到 5 个可信、带 Ctrl、**未被取消**的事件，整窗 `devicePixelRatio` 稳在 1.5、尺寸不变。两次空测要避开：派发到**壁纸窗口**时 frame 收到 0 个（挂在 WorkerW 上，输入路由和截图一样不通）；派发到**主窗口主文档**时 5 个全被页面自己取消（应用页拦了 Ctrl+滚轮），都证明不了补丁 |
| [~] | T12 鼠标注入（11） | macOS / Windows | 预览与桌面的网页 / 场景壁纸跟鼠标、点击 | 照常跟随与点击，日志无「libcef 不带 frame 鼠标注入」 | 2026-11-20 Claude（Windows）：整个会话 **0 条「不带 frame 鼠标注入」/「frame 坐标换算失败」告警、0 条 ERROR**，说明补丁 11 在、没有走降级。真实跟随与点击要人动鼠标，软件测不了 |
| [ ] | T13 Windows / Linux 构建 | Windows、Ubuntu 22.04 | 各自 `deno task build:chromium --clean` 后 check 与 dev | 编译通过、能启动 | **Windows 已编通、`cargo check` 0 error**（2026-11-20，产出 `cef_binary_156.0.30+windows64_minimal`）；过程中要补的三件事见「自编 CEF 156（Windows 首次）」一节：Windows 11 SDK `10.0.28000.x`、补丁 03 的 API 版本守卫、构建脚本三处修复。Windows 的 dev 侧已按 T5 / T9 / T10 / T11 验过，T12 只验了「没有降级告警」，Linux 未做 |

## 视频缩略图改为首帧静图，悬浮播原视频

2026-11-16 macOS dev。桌面的视频缩略图从 2.5 秒 H.264 短片改成第一帧缩到最长边 512 的 JPEG（Android 保持 10fps GIF 与 `gif` 形态不变）（`compress::generate_video_thumbnail`，解码复用 `media::decode::decode_first_video_frame`）；WPE 视频壁纸的缩略图也改成入口视频（`compatible_path`）的首帧，解不出时退回作者 `preview.*`。网格只显示静图，悬浮时 `ImageContent` 的 `poster` 形态才在静图上挂原视频（comp → local），出第一帧前透明、停了就卸载。前端按缩略图本身决定放什么：是图（jpg / WPE 预览）走 `poster`，是 mp4 短片或就是原视频走原来的视频形态。预览的右键菜单新增「设为壁纸封面」（只在桌面，普通视频与 WPE 视频）：前端把 `<video>.currentTime` 交给 `set_video_cover`，后端按时间点解出那一刻显示的帧（`decode_video_frame_at`：seek 到之前的关键帧再逐帧解到越过它）换成缩略图。存量由 v053 登记的回填作业 `video_thumbnail_frame` 重做并删掉 `thumbnails_dir` 里的旧文件（作者的 `preview.*` 不删；Android 上空跑）；整理的「重新生成缩略图」也把旧形态当作需要重做（`is_current_video_thumbnail`：桌面 `.jpg`、Android `.gif`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 检查与单测 | macOS | `deno task check -c kabegame`；core `video_thumbnail_frame` / `thumbnail_refresh` / `media::decode` / `storage::migrations` / `wpe_import`；vitest `src/components/image` | 0 error；全过 | 2026-11-16 Claude：check 通过；core 新增 3 个回填用例（真实 x264 视频换首帧、旧文件删除、作者预览保留、二次运行不重做）与整理旧形态用例全过；`local_folder::replace_image_thumbnail_path_deletes_old_independent_thumbnail` 失败是既有问题（旧缩略图不在 `thumbnails_dir`）；`ImageContent.poster.test.ts` 6 个用例全过 |
| [x] | T1 存量回填 | macOS dev（127 个视频行） | 升级后启动 | 日志 `enqueued video_thumbnail_frame (v053, total 127)` → `done`；视频行缩略图全是 jpg；`thumbnails` 目录里不再有 mp4；WPE 目录里的 `preview.*` 还在 | 2026-11-16 Claude：8.5 s 跑完；119 mp4 + 1 webm + 7 WPE 视频全部换成 jpg，`thumbnails` 目录 3934 个文件全是 jpg，7 个 WPE 目录的 `preview.gif/jpg` 都在；无「解不出首帧」告警 |
| [x] | T2 普通视频悬浮 | macOS dev | 画廊视频筛选，悬浮一张视频再移开 | 平时只有 `<img>`；悬浮约 200 ms 后挂原视频播放、首帧静图在下面；移开后 `<video>` 卸载 | 2026-11-16 Claude：悬浮 1.5 s 播到 1.27 s，移开即卸载。主窗口在后台时 Chromium 以「后台纯视频省电」拒绝 play，前台正常 |
| [x] | T3 WPE 视频悬浮 | macOS dev | 画廊「Wallpaper Engine / Video」，悬浮一张 | 缩略图是首帧 jpg、角标「WPE · 视频」保留；悬浮播入口视频，移开卸载 | 2026-11-16 Claude：7 张均为首帧；悬浮播放 `…/莉莉艾露_身心皆奉.mp4`；有 1 张入口视频黑场淡入、首帧全黑（库内 127 张里 2 张近全黑） |
| [ ] | T4 回填期间两种形态并存 | macOS dev | 回填跑完前（或手动把某行 `thumbnail_path` 改回旧 mp4）打开画廊 | mp4 缩略图的格子照旧用短片悬浮播放，jpg 的走静图 + 原视频；补丁到达后格子换成静图，不闪丢失图 | 用例覆盖（`ImageContent.poster.test.ts`），真机未构造 |
| [ ] | T5 新入库 | macOS dev | 下载 / 本地导入一个视频、导入一张 WPE 视频壁纸 | 缩略图是 `thumbnails` 里的 jpg；WPE 视频解不出首帧时退回 `preview.*` | |
| [ ] | T6 整理重做缩略图 | macOS dev | 把某视频行 `thumbnail_path` 改成旧 mp4，整理勾「重新生成缩略图」 | 换成首帧 jpg，旧 mp4 删除 | |
| [ ] | T7 预览与桌面不受影响 | macOS dev | 打开视频预览、设视频为窗口壁纸 / 应用背景 | 照常播原视频；原视频丢失时显示丢失（不再退到缩略图短片） | |
| [x] | T9 视频设为封面 | macOS dev | 预览一个视频 / WPE 视频，拖到某一刻暂停，右键「设为壁纸封面」 | 菜单有这一项；缩略图换成那一刻的画面（`thumbnails` 里的新 jpg），网格格子跟着换，上一张封面文件删除；预览里的视频不重载、不出加载遮罩 | 2026-11-16 Claude：WPE 视频 9247 在 5 s、8 s 各设一次，封面即 5 s 处画面（512×297），旧文件删除；第一次发现补丁让 `ImageContent` 重置、加载遮罩一直盖着视频，`resetKey` 改成视频形态下非短片缩略图不参与后修好（用例「预览里设封面」）。普通视频 30 经命令在 2.5 s 设封面成功，`timeSecs: -1` 被拒 |
| [ ] | T10 设封面后的回填与整理 | macOS dev | 设过封面的视频跑整理「重新生成缩略图」 | 封面保留，不被换回首帧 | 封面与首帧同为 `thumbnails` 里的 jpg，按规则跳过；未实测 |
| [ ] | T8 Android 不变 | Android dev | 升级后看画廊视频；新下载一个视频 | 缩略图仍是 GIF 动图、角标是静态指示（不能点播）；回填作业空跑完、gif 不被替换；新视频照旧生成 GIF | 安卓分支恢复为原来的 GIF 代码；本机没有 Android 构建产物，未编译验证 |

## 颜色主题与 `--anime-*` 下线

2026-11-16 macOS dev。设置「外观」第一行「颜色主题」，五个内置主题（`apps/kabegame/src/theme/builtin/*.json`）。主题 JSON 只写 `--kb-*` 白名单里的变量，`applyColorTheme` 写到 `<html>` 行内样式；设置键 `colorTheme` 走 localStorage 后端，主窗口 bootstrap 先应用一次、`App.vue` 跟随。`tokens.css` 的 `:root` 即默认主题「动漫粉」。颜色分主色 `--kb-primary` 与点缀色 `--kb-secondary` 两条线，主题只写这两条线和四档文字；填充四阶、浅阶、渐变、页面底、悬停、分隔线、阴影都由它们 `color-mix`。主按钮与计数徽标改用主色 → 点缀色渐变，侧栏选中项是两个浅阶的渐变。第一版只有主色一条线，高级灰整片发灰（像色盲模式），第二版加了点缀色。`--anime-*` 全部下线：品牌色与状态色直接定义成 `--kb-*`，10 处引用（下拉刷新、亀ちゃん、可拖动分隔条、图片缺失、过滤树计数）迁到 `--kb-*`，硬编码的粉色投影改成 `color-mix`；插件描述 iframe 注入的五个 `--anime-*` 是插件约定，保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 检查与单测 | macOS | vue-tsc；`src/theme/colorTheme.test.ts` | 0 error；全过 | 2026-11-16 Claude：0 error；7 个用例全过（id 唯一与顺序、基色与五种语言的名字、只写 `--kb-*`、白名单 / 缺基色 / 缺 default 名字被拒、回落默认主题、写到 `<html>`） |
| [x] | T1 默认外观不变 | macOS dev | 升级后不选主题直接打开 | `data-kb-theme="anime-pink"`，粉色外观与原来一致 | 2026-11-16 Claude：`--kb-primary` 为 `#ff6b9d`，`--kb-hover` / `--kb-line` 为基于它的 `color-mix`；截图与原来一致 |
| [x] | T2 切换五个主题 | macOS dev | 设置 → 外观 → 颜色主题，依次点五个色样 | 立即整体换色（侧栏选中、主按钮、分段控件、说明文字、底色），选中的色样带外环、名字加粗 | 2026-11-16 Claude：五个依次截图确认；英文名原来在 60px 宽里被截断，改成按内容宽度后完整显示 |
| [x] | T2b 画廊两个色相 | macOS dev | 五个主题各看一次画廊 | 每个主题都能看出主色与点缀色两个色相：「开始收集」是主色 → 点缀色渐变、侧栏选中有浅渐变底、说明文字与图标是点缀色相、页面底从主色浅阶过渡到点缀色浅阶；高级灰不再整片发灰 | 2026-11-16 Claude：五个画廊截图确认（灰：石板蓝灰 → 香槟金；绿的点缀黄压深到 `#e3b341`，白字在渐变末端可读）；动漫粉与原来的观感一致，只多了粉 → 紫的渐变按钮 |
| [x] | T3 重启保留 | macOS dev | 选高级灰后整页刷新 | 刷新后仍是高级灰（启动页起就是） | 2026-11-16 Claude：刷新后 `data-kb-theme="premium-gray"`、`--kb-primary` 为 `#5b6472` |
| [ ] | T4 其它界面 | macOS dev | 选非粉色主题后逛画廊、画册、插件、任务抽屉、对话框、右键菜单、吉祥物忙碌徽标、预览 | 没有残留的粉色（插件详情模板里的强调色也跟主题） | 未逐页走查 |
| [ ] | T5 Android / Web | Android dev、Web dev | 同 T2、T3 | 同上；Android 下拉刷新的图标颜色跟主题 | 未测 |

## 收集入口收成「本地」「网络」两个

2026-11-16 macOS dev。「开始收集」只剩「本地」「网络」两项，具体来源在对话框顶部的分段里切换（参考原壁纸导入对话框的「本机 / 从 Steam」）：本地 = 文件夹（local-import）/ WPE 壁纸（本机目录探测）；网络 = 插件 / 网页 / Steam。原来的 `CrawlerDialog`、`WebpageCollectDialog`、`LocalImportDialog`、`WallpaperImportDialog` 拆成 `components/collect/` 下的面板（只画正文，经 `defineExpose` 交出 `submit` / `canSubmit` / `submitting` / `hint`，约定见 `panel.ts`），宿主 `CollectLocalDialog` / `CollectNetworkDialog` 画分段与底部按钮，全局唯一挂在 `App.vue`。`stores/collectDialogs.ts` 管开关、各平台可用来源（显隐规则只写在 `LOCAL_SOURCES` / `NETWORK_SOURCES`）、两组各自上次的来源（localStorage `kabegame-collect-local-source` / `kabegame-collect-network-source`）与「再次执行」的初始参数；`stores/crawlerDrawer.ts` 删除。面板每次打开重新挂载（宿主按 `openSeq` 换 key），本次打开内第一次切到才挂载、之后 `v-show` 留着。入口界面（两个对话框、选择收集方式层、紧凑档媒体选择器与它的导入处理）收进全局的 `collect/CollectEntryHost.vue`，页头的 `CollectAction` 与画廊空状态直接调 store（`enter` / `openChooser`），页面不再接 Collect 的 action——自动配置页页头的「开始收集」以前点了没反应，就是因为页面没接。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C0 检查与单测 | macOS | vue-tsc；`WebpageCollectPanel.test.ts` | 0 error；全过 | 2026-11-16 Claude：0 error；5 个用例全过（新增「成功后 emit done、地址非法时不 emit」） |
| [x] | C1 页头下拉 | macOS dev | 点画廊页头「开始收集」 | 只有「本地」「网络」两项 | 2026-11-16 Claude：菜单项为 Local / Network。点菜单项后打开对应对话框这一步没点成（用户当时在操作应用），由 C2、C3 经 store 覆盖 |
| [x] | C2 网络对话框 | macOS dev | 打开「网络」，依次切插件 / 网页 / Steam | 只显示当前来源的表单；插件底部有「保存为配置」+「开始收集」，标题有「运行配置」；网页「开始收集」；Steam 左下是登录 / 选择提示，主按钮「开始导入」，未登录时置灰 | 2026-11-16 Claude：截图确认三种都对。第一次截图 Steam 下仍显示插件表单（`CrawlerTaskForm` 多根节点，`v-show` 不生效），改为每个面板外包一层 div 后正常 |
| [x] | C3 本地对话框 | macOS dev | 打开「本地」，切到 WPE 壁纸 | 打开即扫描，列出来源与计数，左下「将导入 N 个壁纸」 | 2026-11-16 Claude：列出「官方默认壁纸」19 个 / 18 个可导入，左下提示 18 个 |
| [x] | C4 记住上次来源 | macOS dev | 切到某个来源后关掉再打开 | 停在上次的来源，localStorage 两个键随之更新；焦点落在选中的分段上 | 2026-11-16 Claude：网络停在 steam / webpage、本地停在 wpe 都对；`document.activeElement` 是选中的分段（原来落在第一个分段，焦点环像「选中」） |
| [x] | C5 再次执行回填 | macOS dev | `openLocal("folder", { paths, recursive: false })` | 停在文件夹来源、路径列表回填、「开始导入」可点 | 2026-11-16 Claude：经 store 调用，两条路径都在。任务抽屉里的「再次执行」没从界面点 |
| [ ] | C6 实际提交 | macOS dev | 四种来源各提交一次（文件夹、WPE 壁纸、插件、网页；Steam 要账号） | 任务创建成功、对话框关闭、提示与以前一样 | 未测 |
| [ ] | C7 插件来源的跳转与保存 | macOS dev | 插件来源点标题的「运行配置」、底部「保存为配置」 | 跳到自动配置页并关掉对话框；保存为配置照旧 | 未测 |
| [x] | C8 选择收集方式层 | macOS dev | 空图库点「开始收集」（`openChooser("empty_state")`），选「本地」 | 弹「选择收集方式」，两项本地 / 网络；选完选择层关闭、打开「本地」 | 2026-11-16 Claude：经 store 调用后点对话框里的按钮，选择层关、本地对话框开。空图库的按钮本身没点 |
| [x] | C11 自动配置页的「开始收集」 | macOS dev | 自动配置页页头点「开始收集」→「网络」 | 打开「网络」对话框（以前点了没反应） | 2026-11-16 Claude：真实点击下拉与菜单项，打开 Collect from the web，停在上次的来源 |
| [ ] | C9 Android | Android dev | 页头「开始收集」→ 本地 / 网络 | 本地直接打开系统选择器（图片 / 视频 / 文件夹）；网络是抽屉，分段只有插件 / 网页，底部按钮跟来源走 | 未测 |
| [ ] | C10 Web | Web dev | 「开始收集」 | 没有本地；网络只有插件、没有分段；空状态直接打开网络 | 未测 |

## WPE 壁纸帧率设置

2026-11-16 macOS dev。壁纸设置与预览设置新增「帧率」（整数或「跟随 WPE」，默认 30，范围 10 到显示器最高刷新率）。生效值由 `wpe_web_pull_state` 按调用方窗口取全局 `wpeFps` 或这张图的 `previewSettings.fps`、解析跟随（WPE `config.json` 只读一次）后放进 `general.fps`，垫片经 `applyGeneralProperties` 同时交给网页壁纸与场景宿主；场景宿主 `SceneRenderer.setMaxFps` 就地改节流、粒子遍数与 rope 的 fps，不重新加载。见 `cocs/wpe/WPE_SCENE.md`「帧率」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | F0 单测与检查 | macOS | `check-kabegame`；`test-kabegame kabegame-core --lib fps`；`apps/wpe-scene` 的 `src/particles`、`render/particles.test.ts`、`render/render.test.ts`、`host.test.ts` 与 typecheck；`apps/kabegame` 的 `wpeSettings.test.ts`、`useWpePreviewSettings.test.ts`、`components/wallpaper`、`components/image` | 0 error；全过 | 2026-11-16 Claude：vue-tsc 与 cargo 0 error；core 4 个用例；wpe-scene 707 + 35 个用例全过、typecheck 通过（全量只有 `wpefont/index.test.ts` 因本机 Node 缺 `--experimental-wasm-gc` 失败，与本次无关）；kabegame 26 个文件 286 个用例全过 |
| [x] | F1 刷新率上限 | macOS dev | 调 `get_display_max_refresh_rate` | 等于在线屏的最高刷新率 | 2026-11-16 Claude：本机（M5 内建 ProMotion 屏）返回 120 |
| [x] | F2 预览就地改帧率 | macOS dev | 预览一张粒子场景，预览帧率从 30 改到 10、20、21 | 实际帧率跟着变；`host.stats().recompiled` 不变（不重新加载）；跨 20 的遍数分界粒子不清空 | 2026-11-16 Claude：9180（带子系统的萤火虫粒子），按宿主 `clock()` 的运行时长数 2 s 内的渲染帧：默认 30.5 fps → 10 → 10.5（中位 100.1 ms）→ 20 → 20.5 → 21 → 21.5，全程 `recompiled` 为空，粒子存活数连续（9/12/200/2 → 10/12/200/2）。经 `set_wpe_preview_settings` 改（与面板同一命令），测完删回默认 |
| [x] | F3 桌面跟设置页 | macOS dev 窗口模式 | 改全局 `wpeFps` | 壁纸窗口里的场景跟着变、不重新加载；预览不受影响 | 2026-11-16 Claude：桌面 9180 在全局 12 时 12.5 fps（83.3 ms），改 24 后 24.5 fps（41.7 ms），`recompiled` 为空；同时预览按自己的 10 帧不变、网页壁纸预览没有收到新值。测完改回用户原来的 12 |
| [x] | F4 网页壁纸收到 fps | macOS dev | 预览网页壁纸 9000（corsair_collection），在 iframe 里换一个转发的 `wallpaperPropertyListener` 记录 `applyGeneralProperties`；改这张的预览帧率 | 补投带 `{ language, fps: 30 }`；改值后收到新 `fps` | 2026-11-16 Claude：先收到 `{ language: "en-us", fps: 30 }`，改成 15 后收到 `{ fps: 15 }`；改全局帧率时它不变 |
| [ ] | F5 跟随 WPE | Windows dev（有 WPE `config.json`） | 打开「跟随 WPE」 | 滑条置灰；场景按 WPE 的 `general.user.fps` 限帧；改 WPE 的帧率后不跟（只读一次），重启后跟上 | 只能在 Windows 上测 |
| [x] | F6 跟随不可用 | macOS dev | 看预览侧栏的帧率字段；把预览帧率存成 `"follow"` | 没有「跟随 WPE」开关；存着的 `follow` 显示 30、页面收到 30 | 2026-11-16 Claude：截图确认侧栏只有滑条（10–120，本机刷新率 120）；存 `"follow"` 后侧栏显示 30 并带「恢复默认」，网页收到 `fps: 30`；页面里调 `get_wpe_preview_settings` 被 ACL 拒绝（预期）。测完删回默认 |

## 网页壁纸：属性键序与 History API

2026-11-16 macOS dev。自带网页壁纸 CORSAIR Collection（Angular 6，`<base href=".">`）一直只显示预览图，控制台报 `replaceState` 的 `SecurityError` 和 `Cannot read properties of undefined (reading 'reset')`。两个原因：
- 垫片按 project.json 顺序推属性，`scene` 在 `effect` 前；壁纸处理 `scene` 时要先有 `effect` 建的 `currentEffect`，抛错后 rxjs 退订，再也不切场景。
- 没有 universal access 的 `file:` 文档改不了路径，Angular 先写地址（`…/circuit`）再激活组件，一抛错组件就建不出来；WPE 带 `--disable-web-security`，没有这个限制。

垫片改为属性按键名排序（模仿 jsoncpp，WPE 上的顺序没实测），并在页面脚本之前包装 `pushState` / `replaceState`：同源 `file:` 目标改路径被拒时保留本文档路径、带上目标的 query 与 hash 重写。见 `cocs/wpe/WPE_IMPORT.md`「运行时垫片与宿主协议」的「键序」「History API」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W1 CORSAIR 实时显示 | macOS dev | 预览 9000（corsair_collection） | `<router-outlet>` 后有场景组件、有 canvas，画面是动画而不是预览图 | 2026-11-16 Claude：改前 `<router-outlet>` 后为空、0 个 canvas；改后 `APP-CIRCUIT` 加 1 个 canvas，截图是 iCUE 电路动画；`location.pathname` 停在 `index.html`（预期） |
| [x] | W2 切场景 | macOS dev | 在页面里调 `applyUserProperties({ scene: city })`，再切回 `circuit` | 组件换成 `APP-CITY` 再换回 `APP-CIRCUIT`，不报错 | 2026-11-16 Claude：两次都对，`error` 事件 0 条。iframe 重新加载后组件照样建出来；控制台流 0 条，但流可能在重新加载时脱开，不算确证 |
| [x] | W3 场景宿主不受影响 | macOS dev | 应用重启后看壁纸窗口里的场景 9180 | 照常渲染，帧率按设置 | 2026-11-16 Claude：12.5 fps（全局 12），没有重新编译 |
| [ ] | W4 WPE 的键序 | Windows + WPE | 在 WPE 的网页壁纸开发者工具里看 `applyUserProperties` 收到的键序 | 按键名排序 | 没有 Windows 电脑，未测；排序是按 jsoncpp 的 `std::map` 推的 |
| [ ] | W5 其它网页壁纸 | macOS dev | 预览库里另外两张网页壁纸 | 属性与显示和改前一样 | 未测 |

## 从 Steam 导入（wpe-import P1 + P3）

2026-11-15 macOS dev。P1 与 P3 都在这一版。P3 把来源改成「从 Steam 导入」：登录后在「我的订阅」里挑创意工坊条目，任务下载进 WPE 目录的 `projects/myprojects/<条目 id>/` 并入库；WPE 本体只在设置里没有 WPE 时顺带下载，不再导入官方默认壁纸。下表 P0–P14 是 P1 当时的结果（P7 的「先到 80% 再导入官方默认壁纸」是 P1 的行为），S 开头的是 P3。

P1：内建插件 `wpe-import` 新增来源「从 Steam 拉取」：导入对话框里扫码或账号密码登录 Steam（Steam Guard 在表单里完成），任务只带账号名，用存在插件数据私有区的 refresh token 登录 CM，下载 Windows 版 WPE 到 `plugins-data/wpe-import/steamapps/common/wallpaper_engine`，按 manifest 增量更新；设置里已有别的 WPE 目录时不下载。插件数据新增宿主私有区 `__private`，对外出口一律剥掉、写入时保留。流程与实测见 `cocs/wpe/WPE_STEAM.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P0 单测与检查 | macOS | `check-kabegame`；`test-kabegame kabegame-core --lib steam` / `plugin_data` / `wpe_import` / `discover` | 0 error；全过 | 2026-11-15 Claude：vue-tsc 与 cargo 0 error；steam 18、plugin_data 4、wpe_import 14、discover 7 个用例全过 |
| [x] | P1 协议链路 | macOS，`ignore/steam-p0` | 扫码登录 → CM → PICS → depot 密钥 → manifest → chunk | refresh token `aud` 含 `client`；431961 的 manifest 6301 个文件；`assets/shaders/common.h` 的 chunk 与整文件 SHA-1 一致 | 2026-11-15 Claude：本机分到的三台国内 CDN 都要先申请 CDN 授权 token；`app_branch` 传 `"public"` 拿到的 request code 无效 |
| [x] | P2 私有区不外露 | macOS dev | 登录后调 `get_plugin_data { pluginId: "wpe-import" }` | 返回里没有 `__private` 与 token | 2026-11-15 Claude：Tauri 返回 `{}`；库里该行确有 `__private.steamSessions.<账号>`（refreshToken / steamId / expiresAt / savedAt）。web 调度与 Tauri 走同一个 core 函数，没单独调 |
| [x] | P3 扫码登录 | macOS dev 导入对话框 | 来源切到「从 Steam」→ 扫码 → 手机确认 | 二维码约 20 s 刷新一次；扫码后提示「已扫码」；确认后显示「已登录」、可提交 | 2026-11-15 用户扫码、Claude 经 CDP 看结果：登录成功，会话过期时间约 2027-06-13 |
| [x] | P3b 来源切换 | macOS dev 导入对话框 | 本机勾一个来源 → 切到从 Steam 复用登录 → 换个账号（开始扫码）→ 切回本机 | 切换不丢本机勾选与已登录账号；切走时进行中的扫码被取消；提交的任务参数只有 `sources: null` 与 `steamAccount` | 2026-11-15 Claude：CDP；勾选保留；「换个账号」清掉账号并出二维码，切回本机后面板卸载。提交参数按代码核对，未抓包 |
| [x] | P4 账号密码登录 | macOS dev | 账号密码登录；按 Steam 给的方式确认 | 表单按 `confirmations` 显示要做的事；确认后登录成功；密码框清空 | 2026-11-15 用户实测：开了手机令牌的账号，Steam 只给 `deviceConfirmation` + `deviceCode`，手机上点确认即登录成功。修了两处：`GetPasswordRSAPublicKey` 只接受 GET（POST 返回 405）；有手机确认时验证码输入框收进「改用令牌验证码」，补上 `emailConfirmation` 提示。邮箱验证码路径未测（要只开邮箱令牌的账号） |
| [x] | P5 复用登录 | macOS dev | 关掉再打开对话框（来源保持「从 Steam」） | 显示「以 <账号> 继续（有效至 …）」；点击后验证通过即可提交，不显示登录表单 | 2026-11-15 Claude：CDP 每 200 ms 记录 4 s，停在「以 … 继续」不自动登录；点击后连 CM 验证约 2.8 s。修了日期按 CEF 系统区域显示（`6/13/2027` → 按应用语言 `2027/6/13`） |
| [x] | P5b 换个账号后返回 | macOS dev | ① 「以 <账号> 继续」→ 换个账号 → 返回；② 已登录 → 换个账号 → 返回 | 登录表单右上角有「返回使用 <账号>」；① 回到「以 … 继续」；② 直接恢复已登录、不再验证；进行中的扫码被放弃 | 2026-11-15 Claude：CDP，两条都对，② 0.3 s 恢复、没有连 CM。用户实测发现原来换账号后回不去，补了这个入口 |
| [x] | P6 失效的登录 | macOS dev | 在 Steam 里取消设备授权后点「以 <账号> 继续」 | 提示登录已失效；会话被删；回到登录表单 | 2026-11-15 用户实测两次：Steam 先后返回 `AccessDenied` 与 `invalid credentials`，都按会话失效处理，token 被删、回到扫码登录、不显示「返回使用」 |
| [x] | P7 首次拉取 | macOS dev | 来源「从 Steam」登录后提交 | 任务日志依次为登录 / manifest / 需下载 / 已下载；进度先到 80% 再导入官方默认壁纸；场景壁纸能读到 `assets` | 2026-11-15 Claude：设置里本有 DepotDownloader 下的目录，为不动它，在应用管理目录放了只有 `assets/shaders/common.h` 的占位安装并把设置指过去。约 1 分钟：manifest 6301 条目 788 MB，下载 4571 个文件 364.7 MB，导入 18 个默认壁纸、跳过 `sheep`（类型 other）。与 DepotDownloader 的结果逐文件比对：除 `431966`（steamchina）覆盖的 78 个文件与它带的 `sc.flag` 外全部相同（我们按国际版跳过 steamchina depot）；占位 `common.h` 被替换；无 `.kbpart` 残留。`render_scene` 渲染 Eagle Flag 成功、`unsupported` 为空 |
| [x] | P8 再次拉取 | macOS dev | 再提交一次 | 日志「已是最新」，不下载 | 2026-11-15 Claude：日志「已是最新」，18 个默认壁纸「已存在」 |
| [x] | P9 中断续传 | macOS dev | 模拟首次拉取在写状态前中断：移走安装状态文件、删掉已下载的文件，再提交 | 已完整写好的文件不重下（没有状态记录的按 SHA-1 判断）；不留 `.kbpart` | 2026-11-15 Claude：删了 `wallpaperui.exe`（12 MB）与 `common.h`，只下载这 2 个（5.0 MB），其余 4570 个按 SHA-1 判为最新；状态文件重写（4572 个文件）；补下的文件 SHA-1 与对照一致。没有测「任务运行中取消」本身 |
| [x] | P10 已有 WPE | macOS dev（设置里是 DepotDownloader 下的目录） | 来源切到「从 Steam」 | P3 起：登录照常显示，登录框下一行小字「使用已有的 Wallpaper Engine：<路径>」；任务不下载本体，条目放进这个目录 | 2026-11-15 Claude：截图确认（P1 时是只显示说明、置灰提交，P3 按用户要求改掉）。Windows 上 Steam 装了 WPE 的情况未测 |
| [x] | P13 看板娘浮在对话框之上 | macOS dev | 打开壁纸导入对话框；点看板娘 | 看板娘在遮罩之上；点它不关对话框；之后打开的菜单在它之上；它自己的消息历史对话框不被它挡住 | 2026-11-15 Claude：CDP 读层级，看板娘 3003、对话框 3002；`ui.test.ts` 补了常驻浮层不关层、模态层登记 / 排除打开方 / 撤销两个用例，17 个全过。界面重构 P9 起的回归，用户发现 |
| [x] | P14 登录表单居中 | macOS dev | 从 Steam → 扫码 / 账号密码 | 二维码与提示上下居中；账号密码表单限宽居中，登录按钮在输入框下方居中 | 2026-11-15 Claude：截图确认 |
| [x] | S0 单测与检查 | macOS | `check-kabegame`；`test-kabegame kabegame-core --lib wpe` | 0 error；全过 | 2026-11-15 Claude：vue-tsc 与 cargo 0 error；108 个用例全过（新增 `workshop` 3 个、`wpe_import` 的选择解析 2 个，`picks_public_windows_depots_only` 补了 `workshopdepot`） |
| [x] | S1 订阅接口 | macOS，`ignore/steam-p0 subs <参数>` | 分页、排序、`excludedtags` / `requiredtags`、`totalonly`；`depot 431960 <hcontent>` | 能翻页；`total` 随筛选变；工坊条目 manifest 与 chunk 能解 | 2026-11-15 Claude：225 条；分级 165 / 5 / 55；只有 `lastupdated` 与 `subscriptiondate` 两种排序；「白鸢2」的 `project.json` chunk（VSZa/zstd）SHA-1 一致。结论记在 `cocs/wpe/WPE_STEAM.md`「创意工坊」 |
| [x] | S2 面板布局 | macOS dev 导入对话框 | 来源切到「从 Steam」 | 登录区始终显示；WPE 状态是登录框下一行小字；文案以导入壁纸为主 | 2026-11-15 Claude：截图（设置里有 `/Users/didi/wpe/wallpaper_engine` 时显示「使用已有的 Wallpaper Engine：…」） |
| [x] | S3 订阅列表 | macOS dev | 「以 <账号> 继续」→ 看列表；取消勾「成人」；换「最近订阅」；翻到第 2 页 | 每页 20 条，预览图、类型、大小、分级、本地状态；筛选后总数变、回到第 1 页；翻页正确 | 2026-11-15 Claude：CDP；全部 225（12 页），去掉成人 170；每页 1–2 s（复用连接，耗时是 Steam 接口本身）。排序下拉原来占满一行，改为右侧定宽 |
| [x] | S4 导入一个条目 | macOS dev | 勾一个条目 → 开始导入 | 下载进 `<WPE>/projects/myprojects/<id>/`；写 `kabegame_workshop.json`；入库；挂 Steam 标签 | 2026-11-15 Claude：「sonic-topography」（网页，2.1 MB），列出约 9 s（连 CM、PICS、密钥、CDN 列表）、下载加入库 1.6 s；入库 `x-wpe/web`；挂上「科幻」「广受好评」等，`Approved` 只有 Steam 标签才有 |
| [x] | S5 再导入同一条 | macOS dev | 列表看同一条；再勾它导入 | 列表标「已下载」；日志「已是最新」、入库「已存在」，不下载 | 2026-11-15 Claude：结果对，但这次任务用了 86 s：对话框浏览的连接和任务的连接同账号互相踢下线（steam-vent 的 login id 固定为 0），加上一次连 CM 等到系统超时。改为每账号一条共享连接、连 CM 20 s 超时 |
| [x] | S6 浏览与任务同时进行 | macOS dev | 对话框列表开着时导入 4 个条目 | 不出现 `InvalidHeader` / 心跳失败；4 个都入库 | 2026-11-15 用户在改完连接后自己选了 4 个条目（约 141 MB）导入，全部成功；Claude 查日志没有踢下线的报错 |
| [x] | S12 工坊发现接口 | macOS，`ignore/steam-p0 query <参数>` | 逐个试 `query_type`、`days`、`search_text`、标签筛选、深分页 | 记下每种排序的实际含义 | 2026-11-15 Claude：0 评分、1 最新发布、3 趋势、9 总订阅、11 好评数、12 相关度、21 最近更新，19 含义不明不用；约 328 万条，`page = 2000` 能取；预设约 14 万条、程序壁纸 1 条 |
| [x] | S13 工坊发现页签 | macOS dev | 登录后切到「工坊发现」 | 搜索框、分级与类型筛选、时间窗与排序；每行有订阅人数；与订阅共用已选 | 2026-11-15 Claude：截图；缺省「本周 · 最热门」共 313.5 万个（排除了预设与程序壁纸）。搜索经命令验证：「芙宁娜」+ 去掉成人 15151 条、相关度排在前面；界面里的搜索与「切到相关度」没点到（对话框被关了） |
| [ ] | S15 按 id 搜 | macOS dev | 工坊发现的搜索框里填 `3831518461`、工坊链接、几个 id 用逗号隔开、别的游戏的条目 id | 只列出这几条，不受排序与筛选影响；别的游戏的与不存在的不出现 | 2026-11-16 Claude：解析有单测（`item_ids_from_search_text`）；`ignore/steam-p0 details` 实测别的游戏的条目回 `result = 8`、不存在的回 `9`。界面里没测（dev 没在跑） |
| [x] | S16 翻页组件 | macOS | `ui.test.ts`（`Paginator` 两例）、`TaskDetail.test.ts`、`ImageGrid.previewFollowPage.test.ts`；`check-kabegame --skip cargo` | 翻页抽成 `components/ui/Paginator`，画廊等的 `GalleryBigPaginator` 只剩外框、调用方不变；「从 Steam 导入」的网格改用它 | 2026-11-16 Claude：59 + 2 个用例全过，vue-tsc 0 error。画廊翻页条截图对照见备注；对话框里的样子没看（当时开着别的对话框） |
| [ ] | S17 记住排序与筛选、勾选未下载、页数上限 | Windows dev | 订阅里换「最近订阅」、去掉「成人」；发现里换「总订阅」、时间窗、去掉「网页」；关掉对话框再打开。本页有「已下载」的条目时点「选中本页未下载」。发现不筛选时看翻页的总页数 | 两个页签各自恢复上次的排序与筛选（搜索字不恢复）；只勾上本页没下载的，已下载 / 有更新的不勾，再点一次取消它们；总页数显示 2500、「共 N 个」仍是三百多万 | 待用户确认 |
| [x] | S18 Steam 下载的条目认出工坊 id | Windows，`test-kabegame kabegame-core --lib wpe::project`；dev 库只读扫描 | `myprojects/<id>` 登记在 `kabegame_workshop.json` 里时取目录名当 id；不在状态里的数字目录、非数字目录、没有状态文件都不认 | 14 个全过；修之前 dev 库 336 条 Steam 下载里 223 条 `url` 为空、也没挂 Steam 标签（`project.json` 没写 `workshopid`） | 2026-11-20 Claude：dev 库这 223 条已用一次性脚本补上 `url` / `post_url`（这一版之前没发布过 Steam 导入，不做迁移）；它们的 Steam 标签没补 |
| [ ] | S19 新导入的条目带主页 | Windows dev | 从 Steam 导入一个 `project.json` 没写 `workshopid` 的条目，打开详情 | 来源地址是 `steamcommunity.com/sharedfiles/filedetails/?id=<id>`；挂上了 Steam 标签 | 待用户确认 |
| [ ] | S14 订阅与发现一起导入 | macOS dev | 订阅里勾「全部 N 个」，发现里再勾几条 → 导入 | 底栏「…另加选中的 M 个」；任务取并集、重复的只下一次 | 未测 |
| [ ] | S7 「全部 N 个」 | macOS dev | 只勾「全年龄」→ 勾「全部 N 个」→ 导入 | 逐条勾选被锁住；任务按分级重新列，只导入全年龄的 | 未测（全部下载要十几 GB，要挑个小账号或先 dry-run） |
| [ ] | S8 条目有更新 | 任意 | 等订阅的某条更新后再导入 | 列表标「有更新」；只下载变化的文件、删掉新版本里没有的；行的哈希 / metadata 不重算（已知限制） | 未测（要等作者更新） |
| [ ] | S9 dry-run 与取消 | macOS dev | 打开「空跑」导入几条；另一次导入大条目时中途取消 | dry-run 只记日志不下载；取消后已完成的条目保留，没写完的不入库、不留状态记录 | 未测 |
| [ ] | S10 没有 WPE 时 | macOS dev | 清空「Wallpaper Engine 目录」后导入一条 | 先下载本体（进度前 20%）、写进设置，条目进管理目录的 `projects/myprojects` | 未测（本体下载链路 P7 测过） |
| [ ] | S11 依赖工坊效果的场景 | macOS dev | 导入「晴空球场的银发应援少女」类场景并预览 | 已知缺口：`effects/workshop/<id>/…` 引用的是别的工坊条目，没有下载、渲染器也不解析，画面缺这些效果 | 2026-11-15 用户导入的 3836725625、3837598414 在日志里出现这类 `deny file: … NotFound`。要先查 WPE 怎么解析这类路径，再决定下载依赖条目放哪 |
| [ ] | P11 没买 WPE 的账号 | 任意 | 用没有 431960 的账号拉取 | 任务失败，日志说明需要先购买 | |
| [ ] | P12 插件脚本写 plugin_data | 任一 V8 插件 | 插件 `setPluginData({})` 覆盖 | 不影响自己 id 下的私有区（单测已覆盖存储层） | |

## 界面重构 P9：收尾（删除 element-plus 与 Vant）

2026-11-13 macOS dev。确认框门面 `messageBox` 改为自己实现（`MessageBoxHost`，Reka AlertDialog），`PickerSheet` 的 `van-picker` 换成自写滚轮 `WheelColumn`，删掉混用期垫片（层级改由 `components/ui/layer.ts` 自己的计数器给），删除 vendored element-plus / icons、Vant、`@vitejs/plugin-vue-jsx` 与全部接线。全仓不再有 `<el-*>`、`.el-*`、`@kabegame/element-plus` 导入与 `TODO:[REF_UI]`。

- 确认框结果约定照旧：确定 resolve `"confirm"`，取消 `"cancel"`，Esc / 返回键 `"close"`（没开 `distinguishCancelAndClose` 时报 `"cancel"`）；`alert` 怎么关都 resolve；`prompt` 的 `inputValidator` 不通过时提示在输入框下方、框不关。
- `kb-control` 出错时聚焦也保持红边框（原来聚焦的深色边框盖过了出错的红色，所有表单都有这个问题）。
- web 构建：JS 3.90 → 2.81 MB（gzip 1.24 → 0.91 MB），CSS 592 → 151 KB（gzip 113 → 27 KB）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；web 构建；grep `<el-` / `.el-` / `@kabegame/element-plus` / `vant` / `TODO:[REF_UI]` | 0 error；全过；构建成功；grep 只剩历史注释 | 2026-11-13 Claude：vue-tsc 0 error；vitest 91 个文件 956 个用例全过（新增确认框 4 例、滚轮 2 例、层级工具 2 例）；`vite build --mode web` 成功 |
| [x] | P1 启动与主页面 | macOS dev | 整页刷新；画廊、画册、插件、设置各看一遍 | 无报错、外观与 P8 一致 | 2026-11-13 Claude：CDP 截图；控制台无 error / warning（只有既有的 ejs `fs` 外部化提示） |
| [x] | P2 确认框 | macOS 画册页 | 弹一个带 HTML 正文的危险确认；Esc | 层级在页面之上（3001）、焦点在「删除」、加粗正文；Esc 报 `close`（`distinguishCancelAndClose`） | 2026-11-13 Claude：CDP 从页面里调门面 |
| [x] | P3 输入框 | macOS | `messageBox.prompt` 带初值与校验；清空回车；再填回车 | 打开时选中原文；清空后提示「名称不能为空」、红边框、框不关；填好后 resolve `{ value }` | 2026-11-13 Claude：CDP；发现并修了聚焦时红边框被盖住 |
| [x] | P4 对话框里的确认框 | macOS `/dev/ui`「对话框 ⊃ 各种浮层」→「确认框」；Esc | 确认框层级高于对话框；Esc 只关确认框、焦点回到对话框 | 2026-11-13 Claude：CDP；层级 3003 / 3004 |
| [x] | P5 滚轮（级联） | macOS `/dev/ui` 对话框里点「滚轮」 | 初值 12；十位滚到 3；个位按 ↓；确定 | 两列对齐 1 / 2；十位 3 时个位只剩 0–5；确定得 33、底部面板关闭 | 2026-11-13 Claude：CDP；截图看过（桌面宽度下两列各占一半） |
| [ ] | P7 Android 滚轮 | Android | 画廊翻页（级联）、每页条数、设置里的数字 / 时长 / 语言滚轮；快速甩动后立刻点确定 | 停在选项上；确定取到停住的值；返回键关闭 | 未测（需真机，惯性滚动只能在触屏上看） |
| [ ] | P8 Android 退出确认 | Android 主页返回键 | 返回键弹退出确认；再按返回键 | 第二次返回键关掉确认框、不退出 | 未测 |
| [ ] | P9 Web 版 | `deno task build:web` | 打开 demo、确认框 / 输入框 / super 模式提示 | 与桌面一致 | 未测（只跑了前端构建） |

## 界面重构 P8：自动任务、设置与其它

2026-11-13 macOS dev。运行配置页（卡片、定时编辑气泡、配置详情 / 编辑 / 推荐配置预览、漏跑提醒）、设置页与设置对话框（全部分区的条目与控件、插件默认配置、Web 服务器、MCP）、插件详情左栏菜单、检查更新与下载进度、应用日志、吉祥物历史对话框换成 `@/components/ui` 与 lucide 图标。至此业务界面里不再有 `<el-*>`、element-plus（含图标包）导入与 `.el-*` 选择器，只剩 P9 的收尾项（`el-config-provider`、全局样式、混用期垫片、陈列页的混用场景）：

- 新组件 `TimeField`（定时的时刻，固定 24 小时制）。
- `AutoConfigDialog`、`PluginDefaultConfigsPanel` 去掉 `el-form`，校验只走 `useForm()`（P5 留下的两条 `TODO:[REF_UI]` 已清）。
- 这些文件不再借 `useModal`：漏跑提醒、设置对话框、吉祥物历史改为普通开关，`TaskParamsDialog` 删掉 `zIndex`。
- `CodeBlock` 的复制按钮改为单独一列，长单行不再钻到按钮底下（设置 → 高级 → MCP 连接命令里发现）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 91 个文件 952 个用例全过（`WebServerSettingsPanel.test.ts` 改测 `Switch`，`HiddenCleanupControl.test.ts` 改 mock `messageBox`）；只改前端，未跑 cargo |
| [x] | P1 运行配置列表 | macOS 运行配置页 | 看「我的配置」与「插件推荐」两个 tab | 白底细线卡片，最近失败的是淡红边；结果是色调标签；已导入的推荐配置是描边按钮 | 2026-11-13 Claude：截图 `.claude/plans/ref-ui/shots/p8-before-autoconfigs.png` / `p8-after-autoconfigs.png` / `p8-after-presets.png` |
| [x] | P2 定时编辑气泡 | macOS 卡片上的「每天 09:05」 | 打开；在时刻的「时」上按 ↑；取消 | 气泡锚在按钮下方；分段切换、快捷时刻胶囊；时刻变 10:05、下方预览同步；取消后不保存 | 2026-11-13 Claude：CDP；截图 `p8-after-schedule-popover.png` |
| [x] | P3 配置详情 | macOS 点卡片 | 看详情、滚到底 | 分节外框与任务运行参数一致；定时有进度条与倒计时；最近任务列表 | 2026-11-13 Claude：CDP；截图 `p8-after-autoconfig-detail.png` |
| [x] | P4 编辑与校验 | macOS 详情 →「编辑配置」 | 在详情底部时点编辑；清空名称点保存；「返回详情」 | 编辑从顶部开始；名称标红「请输入配置名称」、不保存；返回后名称不变 | 2026-11-13 Claude：CDP；第一次实测编辑沿用了详情的滚动位置，已修 |
| [x] | P5 推荐配置预览 | macOS「插件推荐」点卡片 | 看预览；取消 | 标题「推荐配置详情」，底部取消 / 导入 | 2026-11-13 Claude：CDP；没点导入 |
| [x] | P6 设置外观 | macOS 设置页 | 外观、壁纸、高级三个分区 | 左导航选中是浅灰块、图标强调色；分区标题深色；壁纸显示方式下拉带说明 | 2026-11-13 Claude：截图 `p8-before-settings.png` / `p8-after-settings*.png`；没改任何设置 |
| [x] | P7 应用日志 | macOS 工具箱「查看日志」 | 打开 | 级别分段多选、来源分段、模块前缀与搜索框、自动滚动开关；列表正常滚动 | 2026-11-13 Claude：截图 `p8-after-applog.png`；筛选未逐项点 |
| [ ] | P8 设置逐项保存 | macOS 设置页各分区 | 每个分区改一次值再改回：开关、滑块（拖动中数值跟手、松手才保存）、下拉、数字、默认下载目录选择 / 恢复默认、WPE 目录 | 保存态正常、重开后保持 | 未测（会改用户设置） |
| [ ] | P9 插件默认配置 | 设置 → 插件 | 选插件、清空必填项保存；重置（确认框） | 字段标红不保存；重置后回到默认 | 未测 |
| [ ] | P10 Web 服务器 / MCP | 设置 → 高级 | 开关 Web 服务器与局域网；MCP 大类与读写分组三态勾选 | 运行中端口与局域网开关禁用；勾选单项整行可点、不会切两次 | 未测（会改服务状态） |
| [ ] | P11 定时真保存 | 运行配置卡片 | 在定时气泡里改时刻并保存；编辑对话框里开关定时并保存 | 卡片「下次」更新、详情的进度条重算 | 未测（会改用户配置） |
| [ ] | P12 漏跑提醒 | 关掉应用越过一个定时点再开 | 看提醒；Esc / × / 稍后再说 / 立即运行 | 点遮罩不关；Esc / × 等同稍后再说 | 未测 |
| [ ] | P13 检查更新与下载 | 有新版本时 | 打开更新对话框（更新日志、链接、下载）；下载中不可关、可取消；失败红色进度条；成功后重启确认 | 与改前一致；总大小未知时是流动的进度条 | 只看了没有更新时的对话框外观 |
| [ ] | P14 吉祥物历史 | 吉祥物右键「历史」 | 看列表、清空 | 标签色调、警告 / 错误淡底 | 未测 |
| [ ] | P15 设置对话框 | ⌘, | 打开、切分类、Esc | 高度不跳、底部圆角；关闭后侧栏设置按钮复位 | 未测（本机设置是路由页） |
| [ ] | P16 紧凑档 / Android | Android | 设置分类卡片、语言滚轮、轮播开关旁的电池优化提示；运行配置的定时气泡与编辑对话框；返回键 | 返回键逐层关闭 | 未测 |

## 界面重构 P7：插件

2026-11-13 macOS dev。插件页（已安装 / 商店源列表、搜索、骨架、空状态、源管理与新增 / 编辑源、导入源）、插件详情页（三栏的说明 / 配置项 / PathQL / 更新记录、右侧标签与前置条件、安装与卸载确认）、外部导入 `.kgpg` 的对话框、插件卡片与右键快捷预览换成 `@/components/ui` 与 lucide 图标，本期文件里不再有 `<el-*>`、element-plus（含图标包）导入与 `.el-*` 选择器：

- 插件文档里的看图（待定 10）：桌面换成新组件 `Lightbox`（方向键 / 两侧按钮翻页、到头停住，滚轮以光标为中心缩放，放大后拖动，双击切换 2 倍，底部比例点击复位）；紧凑端仍是 photoswipe，在对话框里打开时挂进对话框。
- 插件配置项不再套 `el-form`：校验只走 `useForm()`（P5 留下的 `TODO:[REF_UI]` 已清）。
- 安装 / 卸载确认换成 `AlertDialog`：处理中按钮转圈、Esc 不关，失败留在确认框里（`AlertDialog` 处理中屏蔽 Esc 是本期加的）。
- `Dialog` 新增 `height` 与 `fullscreen`（导入对话框的工作台尺寸与紧凑档全屏）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 91 个文件 952 个用例全过（`KbLabel.test.ts` 改为测 Android 点按气泡与空槽）；只改前端，未跑 cargo |
| [x] | P1 列表外观 | macOS 插件页 | 已安装与官方商店源两个 tab | 白底细线卡片、图标浅灰底；搜索框带放大镜 | 2026-11-13 Claude：截图 `.claude/plans/ref-ui/shots/p7-after-store.png`；本期没留改前截图 |
| [x] | P2 源管理 | macOS 顶栏「管理源」 | 看列表；点「新增源」 | 名称 / 地址 / 操作三列，地址截断、悬停看全文；新增源对话框叠在上面 | 2026-11-13 Claude：CDP |
| [x] | P3 源验证失败 | macOS 新增源 | 填名称与一个不可达的 index.json，确认；点「返回修改」；Esc 两次 | 旧确认框在新对话框之上且可点；返回后两层对话框都在、焦点在输入框；Esc 一次只关一层 | 2026-11-13 Claude：CDP；没有真正添加源 |
| [x] | P4 文档看图 | macOS Pixiv 详情 | 点说明里的图片；→ 两次；滚轮放大；点空白 | 灯箱打开 1 / 2，翻到 2 / 2 停住；以光标为中心放大到 157%；点空白关闭 | 2026-11-13 Claude：CDP；截图 `p7-after-doc-lightbox.png` |
| [x] | P5 配置项校验 | macOS Pixiv「配置项」 | 清空必填「爬取类型」，点「用此源新建任务」 | 字段标红并提示，不建任务 | 2026-11-13 Claude：CDP |
| [x] | P6 卸载确认 | macOS 详情顶栏「卸载」 | 看确认框；取消 | 危险色「卸载」按钮；取消后插件仍在 | 2026-11-13 Claude：CDP；没点确定 |
| [x] | P7 快捷预览 | macOS 插件页 | 右键 Pixiv 卡片 | 白底面板：图标、版本与域名、标签方块、走马灯 | 2026-11-13 Claude：CDP |
| [x] | P8 导入 `.kgpg` 对话框 | macOS | 从 App 根实例打开 `pixiv.kgpg` 的导入预览；在里面点文档图片；Esc | 工作台尺寸（约 1120 × 720）、底部 id / 版本标签与「重新安装」；灯箱叠在对话框上，Esc 只关灯箱 | 2026-11-13 Claude：CDP；没点安装 |
| [ ] | P9 安装 / 更新 | macOS 商店详情 | 安装一个未安装插件；断网再试 | 按钮转圈、完成后关闭并提示；失败时提示且确认框不关 | 未测（会真安装） |
| [ ] | P10 导入源 / 拖入 | macOS 顶栏「导入源」；拖一个 `.kgpg` 到插件页 | 选文件、导入 | 与改前一致 | 未测 |
| [ ] | P11 标签说明 | macOS / Android | 桌面悬停标签方块；Android 点按 | 桌面提示、Android 气泡 | 桌面未逐个看；Android 未测（单测覆盖分支） |
| [ ] | P12 紧凑档 / Android | Android | 插件页两列卡片与骨架；详情单列；文档看图（photoswipe）；外部导入 `.kgpg` 全屏对话框里看图；返回键 | photoswipe 在全屏对话框里可点、可捏合，返回键先关看图 | 未测 |
| [ ] | P13 不兼容版本 | 商店里 `minAppVersion` 高于当前版本的插件 | 打开详情 | 顶部淡红提示条、危险色版本标签，安装按钮禁用 | 未测（手头没有这样的插件） |

## 界面重构 P6：画册与畅游

2026-11-13 macOS dev。画册页（树、右栏画册信息、新建 / 移动对话框、面包屑、紧凑档两个侧边面板）与畅游页（地址栏、站点卡片、记录详情、帮助）换成 `@/components/ui` 与 lucide 图标，本期文件里不再有 `<el-*>`、element-plus（含图标包）导入与 `.el-*` 选择器：

- 画册树：类型图标改中性灰、只有收藏的星是强调色；标题右侧「+」菜单新建画册 / 标签 / 标签目录（原来是「⋯」）；同步模式图标换成 lucide（只同步本层 `FolderCheck`、递归 `FolderTree`、委托 `Link`），不再各带一个颜色。
- 畅游地址栏：新组件 `Autocomplete`。打字不自动高亮候选，回车打开输入的原文；方向键选中某条后回车才打开那条（EP 时代回车一律提交原文，键盘选不了候选）。
- 删除无调用方的 `contextMenu/AlbumContextMenu.vue`（画册右键菜单早已是 `actions/albumActions.ts`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | A0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 91 个文件 951 个用例全过（新增 `Autocomplete.test.ts` 4 例）；只改前端，未跑 cargo |
| [x] | A1 画册页外观 | macOS 画册页，开应用背景 | 打开右栏画册信息 | 树、面包屑（箭头分隔）、右栏统计卡片与按钮为新外观；创建日期前没有「·」 | 2026-11-13 Claude：截图 `.claude/plans/ref-ui/shots/p6-after-albums.png` |
| [x] | A2 新建菜单 | macOS 画册树 | 点标题右侧「+」 | 下拉三项（画册 / 标签 / 标签目录），图标为线性图标 | 2026-11-13 Claude：CDP |
| [x] | A3 新建画册 | macOS | 「+ → 新建标签」；输入非法 key；切到「本地文件夹」；切回「普通画册」，输入名称回车 | 打开时焦点在第一个输入框；非法 key 在框下标红；本地文件夹显示选择按钮、递归复选框与说明；回车创建、对话框关闭、树里出现新画册 | 2026-11-13 Claude：CDP，建了测试画册 |
| [x] | A4 移动画册 | macOS 树右键 →「移动到」 | 在选择器里选一个画册，确定 | 菜单关闭后焦点在对话框里；画册移到目标下 | 2026-11-13 Claude：CDP |
| [x] | A5 删除画册 | macOS 树右键 →「删除」 | 确认 | 确认框、删除后树里消失 | 2026-11-13 Claude：CDP，删掉了 A3 的测试画册 |
| [x] | A6 畅游地址栏 | macOS 畅游页 | 聚焦地址栏；打 `wall`；按 ↓；按 Esc | 空输入列出最近畅游；胶囊下缘变直角与面板连成一块；`wall` 列出插件与历史，不自动高亮；↓ 高亮第一条；Esc 收起、焦点仍在输入框 | 2026-11-13 Claude：CDP；截图 `p6-after-surf-suggest.png`。没实际按回车（会打开畅游窗口），回车语义由单测覆盖 |
| [x] | A7 记录详情 | macOS 站点卡片「详情」 | 看对话框；Esc | 名称、入口路径（下方完整地址）、最近访问、Cookie 只读多行框；删除在左下、复制在右下；Esc 关闭 | 2026-11-13 Claude：截图；修了「输入框失焦后候选面板仍开着」 |
| [ ] | A8 地址栏打开 | macOS 畅游页 | 输入地址回车；点一条历史候选；方向键选插件候选回车 | 回车打开输入的地址；历史候选按记录的入口路径打开；插件候选打开插件根地址 | 未测（会真打开畅游窗口） |
| [ ] | A9 画册信息操作 | macOS 右栏 | 「设为桌面轮播」/ 停止；重命名；新建子画册；文件夹画册「立即同步」；「⋯」菜单 | 与改前一致 | 未测 |
| [ ] | A10 树拖拽 | macOS 画册树 | 把一个画册拖到另一个画册上 | 落点虚线高亮，移动成功 | 未测（只换了外观，拖拽逻辑没动） |
| [ ] | A11 紧凑档 / Android | Android 或 Web 窄屏 | 顶栏打开画册树、画册信息；在里面选画册 / 新建；返回键；畅游左端插件按钮 | 左右侧边面板（Sheet）、选中后自动收起；返回键先关面板 | 未测（桌面没有紧凑档） |

## 界面重构 P5：收集与任务

2026-11-13 macOS dev。收集对话框、三个导入对话框、任务抽屉一簇与共用表单控件 `common/form/Kb*` 换成 `@/components/ui` 与 lucide 图标，本期文件里不再有 `<el-*>`、element-plus（含图标包）导入与 `.el-*` 选择器：

- 表单校验：`el-form` 的 rules 换成 `useForm()` + `Field` 的 `validator`（插件变量用纯函数 `varFieldError`）。字段的值改过一次后实时显示错误；没改过的空必填项只在点提交时标红，同时滚到第一个出错的字段。被 `when` 隐藏的字段不参与校验。插件详情（P7）、运行配置对话框与插件默认配置（P8）仍是 `el-form`，插件变量部分另走新校验。
- 共用表单控件：对外接口不变，插件参数、壁纸属性、设置页里用到它们的地方都跟着变。下拉九项以上可搜索；插件声明的 `""` 选项（如「全部」）照常可选；多值列表打字回车添加、退格删最后一项；日期改为日历气泡。
- 收集对话框：分三节（`SectionTitle`），输出目录换 `OutputDirSelect`，来源选择用可搜索的 Combobox（按插件名或 id），「运行配置」在标题行。
- 任务：抽屉换右侧 `Sheet`，卡片、计数、右键菜单、运行参数（`DescriptionList`）、日志、重试记录（`Popover`）换新。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 90 个文件 947 个用例全过（插件变量校验测试改测 `varFieldError`，`KbIntegerInput` 去掉 `useFormItem` 的用例）；只改前端，未跑 cargo |
| [x] | W1 收集对话框外观 | macOS 画廊「开始收集」 | 选 Pixiv，滚动看完整个对话框 | 三节分隔、控件统一 32px 高、下拉字号 13px、底部说明区灰底 | 2026-11-13 Claude：截图 |
| [x] | W2 必填校验 | macOS 收集对话框 | 清掉必填的「爬取类型」；点「开始收集」 | 清掉即标红「请输入爬取类型」；提交被拦、对话框不关、不建任务 | 2026-11-13 Claude：CDP |
| [x] | W3 多值列表 | macOS 收集对话框 konachan「标签」模式 | 在「标签组合」里打 `blue_eyes` 回车；再按退格 | 出现「添加「blue_eyes」」并加成虚线标签；退格删掉它 | 2026-11-13 Claude：CDP |
| [x] | W4 日期 | macOS 收集对话框 konachan「排行榜」模式 | 点「排行榜日期」，点 10 号 | 日历气泡，今天之后置灰；回填「2026年11月10日」，存 `2026-11-10` | 2026-11-13 Claude：CDP |
| [x] | W5 来源搜索 | macOS 收集对话框 | 展开来源；打 `danb`；收起后直接打 `xhs` | 展开列出全部来源（图标、标签）；`danb` 只剩 Danbooru；`xhs` 按 id 剩两个小红书 | 2026-11-13 Claude：CDP；修了「关着时打字丢第一次过滤词」 |
| [x] | W6 保存为配置 | macOS 收集对话框 | 点「保存为配置」；Esc | 小对话框叠在上面、名称预填插件名、焦点在输入框；Esc 只关它 | 2026-11-13 Claude：CDP；未实际保存 |
| [x] | W7 网页收集 | macOS「开始收集 ▾ → 网页」 | 空地址提交；填 `ftp://x`；滚到底再提交 | 「请输入网页地址」/ 协议错误提示；滚回地址框并聚焦；重新打开没有残留错误 | 2026-11-13 Claude（代理）：CDP；未真实提交 |
| [x] | W8 本地导入 / 壁纸导入 | macOS | 带路径打开本地导入、移除一项、选「新建画册」；打开壁纸导入 | 路径列表、新建画册的名称与父画册；壁纸来源卡片 | 2026-11-13 Claude（代理）：本机无 Wallpaper Engine，卡片状态用注入的假数据看 |
| [x] | W9 任务抽屉 | macOS 顶栏任务按钮 | 打开抽屉；右键一张卡片 →「详情」；「日志」；「保存为配置」 | 右侧 Sheet、折叠面板、完成 / 失败卡片；菜单 lucide 图标；参数弹窗（失败任务有错误区）；日志分级淡底 | 2026-11-13 Claude（代理）：截图；打开时焦点落在第一个折叠头上，显示焦点环 |
| [x] | W10 重试记录 | macOS 任务卡片 | 点重试徽标 | 弹出层列出重试链、高亮当前 | 2026-11-13 Claude（代理）：本地数据没有重试链，临时打补丁看的 |
| [x] | W11 畅游地址栏 | macOS 畅游页 | 看地址栏左端的插件选择 | 无边框、竖线分隔，同改前 | 2026-11-13 Claude：P6 前的过渡样式（`TODO:[REF_UI]`） |
| [ ] | W12 停止确认 | macOS 任务抽屉 | 运行中的任务点停止 | 就地气泡确认 | 未测（没有运行中的任务） |
| [ ] | W13 旧对话框里的新层 | macOS 运行配置（EP 对话框） | 编辑运行配置，展开插件参数的下拉 / 日期；必填为空时保存；打开关联任务的日志 | 新浮层挂进旧对话框、可点可选；保存被拦并标红插件参数 | 未测 |
| [ ] | W14 Android | Android | 收集抽屉、网页收集抽屉、任务抽屉、电池按钮、`MediaPicker`、返回键 | 新外观；返回键先关最上层 | 未测（无设备） |

## 界面重构 P4：图片预览与详情

2026-11-13 macOS dev。图片预览（桌面对话框）、Android 详情弹窗与两侧详情面板换成 `@/components/ui` 与 lucide 图标，本期文件里不再有 `<el-*>`、element-plus（含图标包）导入与 `.el-*` 选择器：

- 预览：`el-dialog` 换成 Reka 对话框（层级仍用 `previewModal` 的栈位，吉祥物浮在预览上、点吉祥物不关预览；预览里再弹的浮层向 EP 计数器取号在它之上）；打开时焦点落在对话框本身；只做淡入淡出（缩放会让打开瞬间量到的容器尺寸偏小、Panzoom 适配错位，且全屏要 `position: fixed` 相对视口）。翻页箭头、幻灯片、侧栏开关、全屏退出改成深色半透明圆钮，播放中的幻灯片按钮用强调色；工具条图标换 lucide。键盘：事件落在预览之上的浮层（右键菜单、选择框、取色气泡）里时不翻页；落在滑块、分段 / 单选、标签页上时方向键交给控件。
- 详情面板：折叠外壳 `CollapsibleDrawerPanel`、基本信息、原生元数据、插件描述（给插件模板注入的 `--anime-*` 五个变量名不变，取值改取 `--kb-*`）、标签（新建标签对话框换 `Dialog` + `Field`）、`CodeBlock`、壁纸属性面板与设置页的属性对话框。
- 其它：Android 详情弹窗 `ImageDetailDialog` 换 `Dialog`（`ImageGrid` 不再传 `z-index`）；插件快捷预览 `HoverRevealPanel` 的紧凑端 `el-drawer` 换底部 `Sheet`；显示器布局图中性化；共用表单门面 `KbColor` 从 P5 提前换成色块 + `Popover` + `ColorPickerPanel`（EP 取色器的气泡里有输入框，放进 Reka 模态对话框会被焦点陷阱抢走焦点），只在气泡关闭时提交。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 90 个文件 944 个用例全过（预览、标签面板、属性面板、基本信息、显示器布局图的测试改桩）；只改前端，未跑 cargo |
| [x] | V1 打开与关闭 | macOS 画廊 | 双击网格里一张图；Esc；再打开，点遮罩；再打开，点右上角 × | 白底大圆角对话框淡入、焦点在对话框上；三种方式都关闭，URL 的 `pvwimgid` 清掉，页面可点 | 2026-11-13 Claude：CDP |
| [x] | V2 翻页与右键 | macOS 预览 | 方向键右；鼠标移到右缘；右键；菜单里按方向键下；Esc | 切到下一张；深色圆钮箭头与幻灯片钮出现；菜单在预览之上（层级 3002）；菜单里方向键不翻页；Esc 只关菜单 | 2026-11-13 Claude：CDP |
| [x] | V3 吉祥物 | macOS 预览 | 点预览外面的吉祥物 | 预览不关 | 2026-11-13 Claude：CDP 派发指针事件 |
| [x] | V4 详情两栏 | macOS 预览 | 打开左右两个侧栏，展开原生元数据 | 细线外框面板、中性芯片与链接、标签目录淡色、元数据分组卡片 | 2026-11-13 Claude：截图 |
| [x] | V5 场景 / 网页壁纸属性 | macOS 预览 | 场景壁纸的属性面板，点颜色项；在十六进制框里聚焦；Esc | 取色气泡在预览之上、输入框能拿到焦点；Esc 只关气泡、不写值 | 2026-11-13 Claude：CDP；改值提交未测（避免改测试数据） |
| [x] | V6 新建标签 | macOS 预览 | 标签面板「新建标签」；Esc | 对话框叠在预览上、焦点在输入框；Esc 只关它 | 2026-11-13 Claude：CDP；实际创建未测 |
| [x] | V7 视频与全屏 | macOS 预览 | 打开视频，点工具条全屏 | 画面铺满视口，右上角有退出 × | 2026-11-13 Claude：CDP；× 在 dev 下被帧率浮标挡住（改前同样） |
| [x] | V8 设置页 | macOS 设置 → 壁纸 | 看显示器布局图；点「壁纸属性」 | 布局图中性底、选中屏强调色描边；属性对话框新外观 | 2026-11-13 Claude：截图；打开时焦点在 ×（属性异步加载，打开那一刻只有 × 可聚焦） |
| [ ] | V9 封面与暂停 | macOS 预览网页 / 场景壁纸 | 工具条「设为壁纸封面」「暂停」；面板「恢复默认封面」 | 截到的封面不带工具条与箭头；暂停生效 | 未测 |
| [ ] | V10 幻灯片 | macOS 预览 | 点箭头下的幻灯片钮 | 自动翻页，按钮强调色底并滚动；再点停止 | 未测 |
| [ ] | V11 Android | Android | 预览（PhotoSwipe，上划删除图标换了 lucide）、长按菜单「详情」打开详情弹窗、插件页长按快捷预览、返回键 | 新外观；返回键先关最上层 | 未测（无设备） |
| [ ] | V12 插件快捷预览 | macOS 插件页 | 「源」页右键一张卡片；插件选择器悬停 | 面板在卡片旁弹出 | 桌面逻辑只换了层级取号，未实测 |

## 界面重构 P3：画廊

2026-11-13 macOS dev。画廊整簇换成 `@/components/ui`（reka-ui + UnoCSS）与 lucide 图标，本期 47 个文件里不再有 `<el-*>` / `<van-popup>`、element-plus（含图标包）导入与 `.el-*` 选择器：

- 查询行：过滤 chip 下拉 `KbFilterDropdown` 从 vendored 包移出、用 Reka `Popover` 重写（紧凑档仍是居中对话框），props / 事件 / 插槽照旧；搜索、路径栏、收藏视图、色桶面板（取色器换成 Reka 颜色原语）、高级查询（对话框、条件行、或组）、排序控件。chip 的维度图标从图标包搬进 `components/icons/filterIcons.ts`，排序维度的通用图标换成 lucide。面板里的确认与编辑浮层是 Reka 层，点它们不关外层面板，原来给子层挂豁免类的做法删除。
- 网格与右键：`ImageItem` / `ImageContent` / `ImageGridCore`、自写右键菜单换成 Reka 下拉在点击处打开（调用方不变）、`actions/*` 图标；按上下文换图标的菜单项改用 `iconBy` 显式标记（lucide 图标本身是函数，原来按 `typeof === "function"` 判断会被当成解析器调用）。
- 画廊发起的对话框：加入画册与画册选择、移除确认、失败图片、整理、设置选择、壁纸目标选择、选项抽屉；`views/Gallery.vue` 的空状态与收集方式选择。
- 分页器、每页条数、Android 底部弹层（`van-popup` → 底部 `Sheet`；滚轮 `van-picker` 按待定 6 暂留，包在新 `PickerSheet` 里）、三个 `AndroidPicker*`、树（滚动条换 `ScrollArea`）。
- 新组件：`HelpTip`、`Popconfirm`、`ColorPickerPanel`、`PickerSheet`、`SegmentedControl`、`RangeSlider`；`PopoverContent` 加 `anchor`；`compat.ts` 加 `isInAnyLayer`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | R0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 90 个文件 943 个用例全过（新增 `ui/FilterDropdown.test.ts` 含对话框档；色桶面板、查询行测试改桩）；只改前端，未跑 cargo |
| [x] | R1 过滤 chip | macOS 画廊 | 点「插件」chip，选一个插件；点 chip 右上角清除；再点同一颗 chip 两次 | 面板贴 chip 左下弹出、过滤树文字墨色计数灰色；选中后面板关闭、chip 淡强调底 + 清除徽章，副标题计数变化；清除后复原；再次点 chip 是切换开 / 关，不会关了又开 | 2026-11-13 Claude：CDP 真实点击 + 截图 |
| [x] | R2 排序与颜色 | macOS 画廊 | 排序 chip →「颜色」展开色桶；点「＋」，十六进制输入 `#ff8800`，点「按这个颜色排序」；在取色区与「＋」上点击 | 色桶 6 列、「＋」空块；取色区 + 色相条 + 输入框；路径变为 `sort/by-any-color_0xff8800` 且下拉关闭；面板内点击不关下拉 | 2026-11-13 Claude：CDP 真实点击；用户色桶的删除确认未测（本机没有用户色桶） |
| [x] | R3 收藏视图 | macOS 画廊 | ⋯ →「收藏当前视图」命名保存；点该行的编辑；取消；点 × 并确认 | 新行出现在最前、当前视图行有强调色竖条；编辑浮层锚在行左侧、⋯ 面板不关；移除确认气泡出现时 ⋯ 面板不关，确认后该行消失 | 2026-11-13 Claude：用临时视图 `p3-test` 测完已删除，用户原有的视图未动 |
| [x] | R4 高级查询 | macOS 画廊 | 点「高级」；添加条件；在对话框里打开「种类」chip；按两次 Esc | 对话框标题旁有命中数 Tag；条件卡片中性细边、取非为虚线按钮；第一次 Esc 只关 chip 面板（焦点回 chip），第二次关对话框 | 2026-11-13 Claude：CDP |
| [x] | R5 右键菜单 | macOS 画廊 | 单选、多选右键；画册树行的子菜单；执行「复制图片」；Esc | 菜单在点击处弹出，多选项带「(2)」计数；子菜单展开；复制成功提示；Esc 关闭后页面可点 | 2026-11-13 Claude（并行代理）：CDP 实测并截图；删除、移除类菜单项未执行 |
| [x] | R6 对话框 | macOS 画廊 | 整理（含处理范围滑块）；加入画册（画册选择弹层、新建画册表单）；失败图片（空状态）；收集方式选择 | 新外观；Esc 关闭后状态同步 | 2026-11-13 Claude（并行代理）：CDP；失败图片有数据时的列表、筛选与进度，删除确认、设置选择、屏幕目标选择未在界面上点（后者有单测） |
| [x] | R7 分页器 | macOS 画廊 | 看分页条；第 1 页 | 中性毛玻璃条，「上一页」置灰，中间「1 / 44」 | 2026-11-13 Claude（并行代理）：截图；输入页码跳转未测 |
| [ ] | R8 分页跳转 | macOS 画廊 | 在页码框输入页码回车；输入非数字；Esc | 跳到对应页（超出范围收拢）；非数字复原；Esc 复原 | 未测 |
| [ ] | R9 自动任务页筛选 | macOS 自动任务 | 打开三颗筛选 chip 各选一次 | 与画廊 chip 同一外观与行为 | 只看了外观（chip 正常渲染），未操作 |
| [ ] | R10 紧凑档 / Android | Android | 画廊 chip（对话框档）、⋯ 收藏视图编辑（叠加对话框）、长按菜单（ActionSheet）、每页条数与三个滚轮选择、整理底部弹层、画册选择全屏面板、返回键 | 底部 / 居中弹层新外观；返回键先关最上层 | 未测（无设备）；chip 对话框档有单测 |
| [x] | R11 预览里的菜单 | macOS 预览 | 预览里右键、壁纸 iframe 转发的右键 | 菜单正常、图标正常 | 2026-11-13 Claude：P4 测了预览里的右键（见 P4 V2）；iframe 转发的右键未测 |

## 界面重构 P2：底座组件、反馈门面与混用期垫片

2026-11-13 macOS dev。界面上直接可见的只有提示消息；其余是给后续各期用的组件与垫片：
- **反馈门面**：`toast`（签名同 `ElMessage`，Reka Toast 自写）、`messageBox`（签名同 `ElMessageBox`，内部仍是 EP，P9 换）、`vLoading`。直接调 `ElMessage` 的 6 个文件换成 `toast`，`kameMessage as ElMessage` 别名改直呼（58 个文件），`ElMessageBox` 31 个文件、`v-loading` 10 个文件。
- **组件**：Dialog、AlertDialog、Sheet、ContextMenu、下拉 / 右键共用的菜单项、Field 与九种表单控件、Tag、Skeleton、Separator、ScrollArea、DescriptionList、Alert、Spinner；dev 陈列页 `/dev/ui`。
- **混用期垫片**（`components/ui/compat.ts` + `styles/kb-compat.css`）：新浮层打开时向 EP 的 z-index 计数器取号；打开期间暂停 EP 的焦点陷阱；触发器在 EP 对话框里时挂进去；旧浮层在新模态层下仍可点且不触发关闭；新对话框里弹 EP 确认框时暂停 Reka 的陷阱；菜单打开 EP 对话框时焦点送进对话框（修掉 P0 的焦点问题）。

真机交互在主窗口被别的窗口挡住时不可靠（CEF 冻结动画，EP 确认框要等离场动画结束才回结果、提示消息停在透明态）；下面的结论都是 `show_window` 带到前台后测的。合成的 `click()` 不移交焦点，焦点相关的项用 `focus()` 或 CDP 点击核对。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 90 个文件 942 个用例全过（新增 `components/ui/ui.test.ts` 11 例：对话框 Esc、Android 返回栈、层级取号、toast 签名 / 去重 / 上限、messageBox 转发与暂停陷阱、v-loading、垫片）；5 个测试改为 mock `@/components/ui/toast` / `messageBox` |
| [x] | W1 提示消息 | macOS `/dev/ui` | 依次点 success / error / warning / duration 0 / closeAll | 顶部居中白底卡片、彩色图标、可点 × 关；长文字换行；3 秒消失，duration 0 不消失；closeAll 全关 | 2026-11-13 Claude：截图核对；层级 3005（在 EP 计数器上取号） |
| [x] | W2 新对话框 ⊃ 旧下拉 | macOS `/dev/ui` 混用一节 | 打开「新对话框 ⊃ 旧组件」，点 el-select 选一项 | 下拉在对话框之上弹出、可选，对话框不关 | 2026-11-13 Claude：CDP 点击核对，选中 3840 × 2160 |
| [x] | W3 新对话框 ⊃ 旧确认框 | 同上 | 点「弹旧确认框」，点取消 | 确认框压在新对话框上、焦点在确认框；取消后焦点回到新对话框里的按钮、对话框不关、提示「取消」 | 2026-11-13 Claude：通过 |
| [x] | W4 旧对话框 ⊃ 新组件 | 同上 | 打开「旧对话框 ⊃ 新组件」：新选择框选一项；新下拉菜单开子菜单；新气泡 | 都挂进旧对话框、能越出对话框边界；选择后焦点回触发器；菜单开着时点对话框里别的按钮只关菜单 | 2026-11-13 Claude：通过（「只关菜单」是测出问题后修的：原先 `.el-overlay` 整体放开，按钮会同时触发） |
| [x] | W5 Esc 只关最上层 | 同上 | 旧对话框里开新对话框按 Esc；开新选择框按 Esc；再按 Esc | 前两次只关新层、旧对话框还在；第三次关旧对话框 | 2026-11-13 Claude：通过（修前新对话框与旧对话框一起关，见 `usePauseForeignTraps`） |
| [x] | W6 对话框 / 侧边面板 / 确认框 | macOS `/dev/ui` | 打开 Dialog、Sheet 右 / 底、AlertDialog，点「删除」 | 对话框打开时焦点在第一个输入框；底部面板带把手；确认框焦点默认在「取消」，删除时转圈、完成后关闭并提示 | 2026-11-13 Claude：截图核对 |
| [x] | W7 右键菜单 | macOS `/dev/ui` | 在虚线框里按坐标派发 contextmenu | 菜单在点击处打开，子菜单、危险项红色 | 2026-11-13 Claude：通过 |
| [x] | W8 P0 焦点问题 | macOS 画廊 | 顶栏「开始收集」下拉选「网络」，按 Esc | 焦点在收集对话框里，Esc 关闭 | 2026-11-13 Claude：通过；关闭后焦点落在 body（EP 还给的是已卸载的菜单项），没回到「开始收集」 |
| [ ] | W9 v-loading 实景 | macOS | 打开任务抽屉（空时首次加载）、设置页、MCP 设置、日志 | 区域内居中的中性色转圈、半透明白底 | 陈列页里核对过，实景未测 |
| [ ] | W10 吉祥物降级提示 | macOS | 开全屏预览（遮住吉祥物）时触发一条提示（如复制） | 改走顶部的提示消息、压在预览之上 | 未测 |
| [ ] | W11 Android | Android | 任意对话框 / 菜单打开时按返回键；底部弹层 | 返回键先关最上层；提示消息在状态栏下方 | 未测（单测覆盖了返回栈） |

## 界面重构 P1：外框与 element-plus 全局换皮

2026-11-13 macOS dev。三块：
- **全局换皮**：vendored element-plus 新增 `kb-reskin.scss`，在 `:root` 把 `--el-*` 指向 `--kb-*`（主色墨色，梯度用 `color-mix` 运行时算）；`anime-theme.css` 删掉全部 EP 外观覆盖（按钮渐变、悬停上浮、卡片阴影、标签渐变……），中性的 `--anime-*` 改指向 `--kb-*`，品牌色不变；字体改系统界面字体；Vant 主色跟 `--kb-primary`。所以**没迁的界面也全部换了外观**，验收重点是看有没有被删掉的全局覆盖拉坏的地方。
- **外框**：`App.vue` 自写布局与侧栏导航（`router-link` + Tooltip），页面底 / 侧栏浅灰，开应用背景时毛玻璃；侧栏底部设置、工具箱、后台任务入口与更新按钮。
- **组件**：新 `Tabs`（替换 `KbTab` 四处）、`Popover`、`Switch`、`Progress`、`Empty`；工具箱内容（`GlobalToolsList` + `ToolRow`）三处共用；后台任务卡片共用 `BusyTaskCard`；`ScrollButtons`、空状态、`SuperModeToggle`、拖入提示层、启动页、吉祥物气泡换新。

顺带修了 P0 的一个问题：触发器外面套 Tooltip 时，Reka 菜单 / 气泡卡片的锚点会登记到 Tooltip 上、浮层停在左上角不动（P0 的 `PageHeader` ⋯ 菜单在紧凑档受影响）。现在 `DropdownMenuContent` / `PopoverContent` 显式按触发器元素定位。

改前 / 改后截图在会话 scratchpad（`p1-before/`、`p1-after/`），未入库。CDP 点击工具在一次页面刷新后不再把鼠标事件送进页面（窗口级捕获监听收不到任何事件），之后的交互改用页面内合成完整的 pointer / mouse 事件序列验证。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 89 个文件 931 个用例全过（`KameToolboxBubble.test.ts` 改为点自定义条目后由 `done` 事件关闭，`HiddenCleanupControl.test.ts` 改 `mount` 以渲染 `ToolRow` 里的数量）；只改前端，未跑 cargo |
| [x] | V1 侧栏导航 | macOS | 看侧栏；点「画册」「运行配置」 | 浅灰侧栏、40px 图标按钮；当前页是白底小卡片、图标粉色；点击跳转、高亮跟随；插件有可更新时「源」右上角计数 | 2026-11-13 Claude：截图核对；跳转用合成指针事件验证（CDP 点击工具当时失效，见上） |
| [x] | V2 侧栏工具箱 | macOS，关吉祥物 | 点扳手；切「不显示画册图片」两次；Esc | 浮层在按钮右侧弹出；开关整行可点、状态正确；Esc 关闭、焦点回按钮 | 2026-11-13 Claude：通过；吉祥物设置已还原 |
| [x] | V3 吉祥物工具箱气泡 | macOS | 点吉祥物 | 白底气泡、行与侧栏工具箱一致；「设置」为细边框按钮 | 2026-11-13 Claude：截图核对（顺带修了 `Button` outline 边框被 `border-0` 吃掉）；点条目后关闭由单测覆盖 |
| [x] | V4 分段选项卡 | macOS 插件页 / 运行配置 | 看选项卡；切换 | 灰底轨道、选中是白块；计数灰色；「+」只是图标 | 2026-11-13 Claude：截图核对；切换、删除商店源、悬停「+」提示未测 |
| [x] | V5 EP 换皮 | macOS 运行配置、设置弹窗、开始收集对话框 | 依次打开 | 主按钮墨色、开关墨色、对话框 12px 圆角、柔和阴影与浅遮罩、输入框中性边框；没有渐变按钮与悬停上浮 | 2026-11-13 Claude：截图核对。设置左导航、分段控件、画册「设为桌面轮播」等仍是粉紫渐变，属于后续期 |
| [x] | V6 应用背景开 / 关 | macOS | 开着应用背景看各页；临时去掉 `has-app-background` 再看 | 开：侧栏毛玻璃、内容区半透；插件卡片半透白 + 模糊（原来的全局 `.el-card` 模糊已删，改在插件页 / 畅游页的卡片类上）。关：页面底 `#f6f6f7`、侧栏 `#efeff1` | 2026-11-13 Claude：截图核对 |
| [ ] | V7 后台任务 | macOS | 跑整理或清理隐藏图片 | 侧栏底部（关吉祥物时）出现进度环；点开是任务卡片：中性底、粉色细进度条、取消按钮；工具箱顶部同样显示 | 未测（当时没有后台任务） |
| [ ] | V8 启动页 | macOS | 重启应用（有迁移或回填时更明显） | 浅灰底、Logo、墨色进度条；失败态有深色「退出」按钮 | 未测 |
| [ ] | V9 更新按钮 | macOS | 有新版本时 | 侧栏出现粉色实心下载按钮，悬停提示；下载完成后变成重启图标 | 未测 |
| [ ] | V10 拖入提示 | macOS | 从 Finder 拖文件到画廊 | 粉色虚线框 + 白底提示卡片 | 未测 |
| [ ] | V11 紧凑档 / Android | Android | 底部导航、工具箱 tab、PageHeader ⋯ 菜单 | 底部导航白底细线、当前项墨色；工具箱从 tab 上方弹出，带「设置」「畅游」；⋯ 菜单贴着按钮弹出；返回键先关浮层 | 未测 |
| [ ] | V12 Web super 开关 | Web | 左下角 R / S 开关 | 白底胶囊、墨色开关，打开时带粉色细环 | 未测 |

## 界面重构第一步：画廊顶栏与查询行（reka-ui + 设计 token）

2026-11-13 macOS dev。新增 `reka-ui`（无头原语）与 `@lucide/vue`（图标），新组件在 `apps/kabegame/src/components/ui/`，设计 token 在 `styles/tokens.css`。共用的 `PageHeader`、顶栏功能按钮（刷新、失败图片、任务、收集）与注册表图标换成新组件，所以所有用 `PageHeader` 的页面一起变；插件详情顶栏右侧的按钮一并迁移。查询行的 chip（vendored `KbFilterDropdown`）只改 token map 与形状，组件逻辑不动；chip 弹层里的过滤树经新增的 `--kb-tree-row-*` 变量对齐，侧栏画册树缺省值不变。

已知问题：从「开始收集」菜单打开的对话框（element-plus）打开后，焦点会回到「开始收集」按钮、不在对话框里。原因是 Reka 菜单关闭动画期间，对话框遮罩盖上来触发菜单项的 `pointerleave`，Reka 把焦点移回菜单内容，关闭后再还给触发器。鼠标操作不受影响，Esc 照常关对话框；键盘 Tab 会从对话框外开始。暂不处理，等对话框也迁到 Reka 后自然消失。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | U0 单测与检查 | macOS | `check-kabegame --skip cargo`；前端 vitest 全量；Prettier | 0 error；全过 | 2026-11-13 Claude：vue-tsc 0 error；vitest 89 个文件 931 个用例全过（`GalleryQueryBar.test.ts` 给 `Button` / `Tooltip` 加了透传桩，清除按钮保留 `query-clear-filter` 类作钩子）；只改前端，未跑 cargo |
| [x] | U1 画廊顶栏外观 | macOS 画廊 | 打开画廊 | 毛玻璃顶栏、细边框；标题 17px 墨色；刷新 / 失败图片 / 任务为无底图标按钮；「开始收集」深色实心；有过滤时计数旁出现清除过滤图标 | 2026-11-13 Claude：CDP 截图核对 |
| [x] | U2 收集菜单 | macOS 画廊 | 点「开始收集」，点外部；再打开选「本地」 | 白底圆角菜单、四项带图标；点外部只关菜单；选「本地」打开本地导入对话框，关闭后 body 的 `pointer-events` / `overflow` 复原 | 2026-11-13 Claude：真实鼠标事件通过；焦点问题见上方已知问题 |
| [x] | U3 查询行 chip 与弹层 | macOS 画廊 | 看 chip 行；打开「插件」与已选的「种类」chip | chip 中性浅底 32px；已选 chip 淡粉底、墨色字、粉色图标；弹层白底，过滤树文字墨色、计数灰色，已选行淡粉底 | 2026-11-13 Claude：CDP 截图核对 |
| [x] | U4 其它页面顶栏 | macOS 画册 / 插件详情 / 任务详情 / 设置 | 依次打开 | 顶栏同一套外观；返回按钮、插件图标槽、「已安装」标签、复制 id、卸载（悬停转红）正常显示 | 2026-11-13 Claude：CDP 截图核对，未点卸载 |
| [ ] | U5 角标 | macOS | 有任务在跑、有失败图片时看顶栏 | 任务按钮右上角粉色计数，失败图片按钮红色计数，超过 99 显示 99+ | 未测（当时没有进行中任务与失败图片） |
| [ ] | U6 悬停提示 | macOS | 鼠标悬停刷新 / 失败图片 / 任务 / ⋯ / 返回 | 约 0.4 s 后在下方弹出深色小提示 | 未测（CDP 点击工具不产生悬停） |
| [ ] | U7 紧凑档 / Android | Android | 画廊顶栏、折叠菜单（⋯）、「开始收集」 | 顶栏贴满屏宽、无圆角；⋯ 菜单可开可选，返回键关闭菜单；「开始收集」打开选择器 | 未测 |
| [ ] | U8 插件版本不兼容提示 | macOS 插件详情 | 打开一个要求更高应用版本的未安装插件，悬停安装按钮 | 按钮置灰，悬停提示所需版本 | 未测 |
| [ ] | U9 Web 版 | Web | 打开画廊 | 收集菜单只有「网络」，其余同 U1 | 未测 |

## 场景壁纸快捷方式（P11d）

2026-11-15 Windows dev。场景的 `usershortcut` 属性：
- 面板（类型 + 路径 + 参数、「测试」按钮）；
- 图标纹理（后端照 WPE 取图，OpenCV 4.4.0 的三处移植进 Rust；宿主补透明边、夹取）；
- `engine.openUserShortcut`：宿主照 WPE 的门禁，应用页核对用户激活后用自己的图片 id 调启动命令，后端只启动用户配过的快捷方式。

依据与资料：
- WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md`「P11d 补测」与同目录 `rea-p11d.md`；
- 计划、约定与走查见 `phase-11d-shortcuts.md`；
- 生成工程 `ignore/p11/proj/p11-shortcut`、`p11-shortcut-v`（`ignore/p11/defs/p11d.py`），WPE 的图标纹理 `ignore/p11/d/wpe-icons/`，dev 应用里取到的图标 `ignore/p11/d/kb-icons-app/`；
- 语料 `ignore/p11/d/corpus-*.json`。

真实启动会在桌面上开资源管理器窗口，目标是空文件夹 `ignore/p11/d/launch-target`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | D0 单测与检查 | Windows | `kabegame-core` 的 `user_props`、`kabegame` 的 `wpe` 过滤；宿主 tsc 与相关 vitest；应用 vue-tsc 与相关 vitest；Prettier、rustfmt | 全过 | 2026-11-15 Claude（合并进主工作区后）：Rust 14 + 135 个通过（1 个是手动跑的取图标测试）；宿主 tsc 0 error，相关 130 个文件 2972 个用例里 2970 个通过，失败的两个见 D8；应用 6 个文件 50 个通过；vue-tsc 只有别的会话未入库的 `WpeSceneShadowsSetting.vue` 1 个错误。变异：OpenCV 2 处、前端 4 处全部检出。提交内容单独检出核对：vue-tsc 0 error；宿主 tsc 剩 1 个错误，4 个测试报 `scriptPropertyEntries is not a function`，来自之前的提交 `637530bd` 带进的 P3 会话未提交的调用，与本步无关 |
| [x] | D1 OpenCV 移植 | Node / Rust | `cv.rs` 的单测；另换种子和 OpenCV 比 680 个用例；圆形遮罩作用于 WPE 的 `webthumbnailfallback.png` | 逐字节相同 | 2026-11-15 Claude：30 个单测、680 个用例逐字节相同，遮罩结果和 WPE 纹理逐像素相同。参照用 4.5.5，与 4.4.0 在这三处没有行为差别 |
| [x] | D2 图标对 WPE | Windows dev | 工程 `p11-shortcut` 导入 dev 库，配 7 种目标，应用页调 `wpe_scene_shortcut_icon`，和 WPE 抓帧存下的纹理比 | 逐像素相同 | 2026-11-15 Claude：notepad.exe、`.lnk`、`.url`、文件夹、`calc`、维基百科（160×160）、`example.com` 的缺省图（300×300）全部逐像素相同。测试程序里 exe 取不到缩略图（`0x8004B200`）、差几级，dev 应用里没有这个问题 |
| [x] | D3 门禁对 WPE | Windows dev + WPE 测试窗口 1280×720 | 9 个用例（按钮脚本的 `case` 0–8）用同一串输入：WPE 用 `input_play`，Kabegame 用屏外宿主的探针（`inputTimeline`）；s1 在 WPE 用错的哈希、在 Kabegame 设成没配 | 脚本日志逐行相同 | 2026-11-15 Claude：9 个用例逐行相同（相对帧号、返回值、两种异常文本、`cursorMove` 没捕获后被禁用）。未捕获异常的位置 WPE 报 col 9、我们报 col 10，是 P3b 的通用报错格式，与本步无关 |
| [x] | D4 宿主拿到的形状 | Windows dev | 屏外宿主里调 `wpe_web_pull_state` | 配过的是 `{ value: 16 位哈希, isbound: true, commandtype, file }`，没配的只有 `isbound: false`；脚本里 `engine.userProperties` 是 `{}` | 2026-11-15 Claude：3660962877 的 `launcher1–3`（文件、网址、文件夹）与 `launcher4`（没配）都符合；`p11-shortcut` 的 `init` 日志里快捷方式属性是 `{}` |
| [x] | D5 真实启动 | Windows dev + WPE 测试窗口 | WPE：s1 设成 `directory:<本机哈希>:…\launch-target`，按下时调用；Kabegame：应用页调 `wpe_open_user_shortcut(15174, "s4")` | 打开 `launch-target`，返回 `true` | 2026-11-15 Claude：WPE 返回 `true`、没有 `User shortcut blocked.`、文件夹窗口打开；本机哈希含 UTF-16 结尾 NUL（读码推断得到证实）。Kabegame 返回 `true`（`ShellExecuteW` > 32），但同一文件夹的窗口还开着，系统复用了它，画面上没新窗口 |
| [x] | D6 反向用例 | Windows dev | 场景宿主调 `wpe_open_user_shortcut`；应用页对没配、`textinput`、`combo`、不存在的属性、只有工程缺省值、非场景图片、不存在的图片调启动命令 | 都不启动 | 2026-11-15 Claude：宿主被 ACL 拒绝（取图标命令放行）；没配与只有缺省值返回 `false`，其余报错 |
| [x] | D7 语料 | Node，233 个工程 | 合并前后各扫一次（`kbp corpus scan` / `diff`） | 只去掉 `script:api:engine.openUserShortcut` 与 `usertextures:usershortcut`，原来能渲染的不掉出 | 2026-11-15 Claude：能渲染 175 → 176（`3660962877`），去掉的两个键 6 张、5 张，没有新增键。`3660962877` 解包导入后脚本 252 段都没有报错，三个图标就绪 |
| [x] | D8 语料测试的两处失败 | Node | `compile/pipeline.test.ts` 的快速路径上限；`compile/p3a.test.ts` 的绑定表完整性 | 与本步无关 | 2026-11-15 Claude：`3253330537` 648 次请求、`3543014965` 读 104 MB，合并前的快照同样失败（后者 P11c 时已有）；绑定表完整性那条在机器同时编 Rust 时超时（600 s），单独重跑 13 个全过，整个文件用时约 9 分钟，离上限不远 |
| [x] | D9 预览里点击启动 | Windows dev | 预览 `3660962877`，打开「用户栏设置」的功能开关，给 #1–#3 配程序、网址、文件夹；看应用栏图标，点一个图标；再点面板上的「测试」 | 图标与目标一致；每次点击打开一次所配的目标 | 2026-11-15 用户手测通过；测完已从 dev 库移除（图片 15180） |
| [ ] | D10 非 Windows | macOS / Linux | 预览一张带快捷方式的场景 | 面板不显示快捷方式属性，图标槽是缺省纹理，`openUserShortcut` 返回 `false` | 本机不能测 |

## 场景壁纸 P6d1a：层级、转向与 effect / 材质访问

2026-11-15 Windows dev。场景脚本的 `getParent` / `getChildren` / `getTransformMatrix`、`rotateObjectSpace` / `lookAt` / `lookAtYaw`、`getEffect` / `getEffectCount` / effect `name` / `getMaterial` / `getMaterialCount` / `setMaterialProperty`、`getLayerByID`，删掉图层对象的 `id`；旋转存角度与 3×3 两份（`LayerState.rotation`）；用到 `getEffect` 时写死关闭的 effect 也编进 bundle；材质对象只登记读到的常量、加五个只读状态字段；`rad2deg` 材质常量脚本一侧按度。

说明见 `cocs/wpe/WPE_SCENE.md`「层级、转向与 effect / 材质访问（P6d1a）」；计划与实施记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6d1-hierarchy-effects.md`。验收文件在 `ignore/p6/d1/`（独立工作树 `wt/`、HEAD 快照 `head/`、变异清单 `mutations*.json`、语料 `corpus-*.json`、真机读图 `real/`），测试工程由 `ignore/p6/d0/make_p6d1.py`、`make_p6d1b.py` 生成在 `ignore/p6/d0/proj/p6d1-*`，WPE 读回在 `ignore/p6/d0/out/p6d1-xform.log`、`p6d1-round2.log`，抓帧在 `A:\p6d\p6d1-*\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | F1 类型与格式 | Windows | 宿主 `tsc --noEmit`；Prettier `--check` 本步改动的 TS 文件 | 0 error、格式通过 | 2026-11-15 Claude：工作树与合并后的主工作区 tsc 都是 0 error |
| [x] | F2 宿主 vitest（相关文件） | Node，vitest | 带 `KABEGAME_WPE_ROOT` 跑 `render/rotation`、`render/hierarchy`、`render/p12b`、`script/hierarchyApi`、`script/effectMaterialApi`、`script/api`、`script/runtime`、`compile/scriptApi`、`compile/p3c`、`host.script` | 全过 | 2026-11-15 Claude：工作树 361 条全过；合并进主工作区后 372 条全过（多出的是 P12b2-1 的用例）。`rotation.test.ts` 对 WPE 读回逐位比（−0 与 0 视同，WPE 日志印不出符号） |
| [x] | F3 变异检查 | Node，工作区模式 | `ignore/p6/d1/mutations.json` 12 处、`mutations2.json` 1 处（`kbp mutate --mode workspace`，工作树里） | 每处都有用例失败，原样还原 | 2026-11-15 Claude：12 处检出 11 处；没检出的「Vec2 写进 vec3」是等价变异（对象没有 z，vec3 写入本来就不收），改成带 z 并放开 vec3 后检出；整树哈希前后一致 |
| [x] | F4 语料编译 | Node，`kbp corpus scan` / `diff` | HEAD 快照（`868d1711`）与工作树各扫一次，两边用同一份翻译器 wasm | 只去掉本步实现的键，没有新增的键 | 2026-11-15 Claude：233 张，0 出错，干净 159 → 160（`3243449890`）；去掉 `layer.getParent` 11 张、`getTransformMatrix` 6、`getChildren` 4、`getEffect` 4、`effect.getMaterial` 2，没有新增。第一次比时工作树还是旧 wasm，多出 22 张 `shader:*:texture` 的差别，换成主工作区当天重建的 wasm 后消失（与本步无关） |
| [x] | F5 转向的读回 | Windows dev，屏外宿主（`render_scene`，`scripts: true`） | `p6d1-xform`、`p6d1-xform2`、`p6d1-cam` 导入 dev 库跑脚本，`[kbp6d]` 读回和 WPE 日志逐行比 | 逐位相同 | 2026-11-15 Claude：43 + 23 + 2 行逐位相同。第一次跑 `p6d1-xform2` 时 L3b、KN（视线与 up 平行）读回 `0 0 0`、WPE 是 NaN：NaN 角度走图层向量字段的写入被丢掉，改成经 `rotation` 写入目标（3×3 为 null）后相同，补了单测 |
| [x] | F6 effect / 材质的读回 | Windows dev，屏外宿主 | `p6d1-mat`（回放 8 帧）、`p6d1-mat2`、`p6d1-mat3`、`p6d1-mat4`、`p6d1-mat6`（回放 8 帧）跑脚本 | 数值逐位相同 | 2026-11-15 Claude：`setMaterialProperty` 的全部情形（S1–S7、E1–E8）、`rad2deg` 的四种来源（T1–T4）、`getEffect` / `getMaterial` 读回都相同。材质对象的键顺序当时不同（WPE `color, alpha`、我们 `alpha, color` 等），由 F10 补上 |
| [x] | F7 画面 | Windows dev，屏外宿主；WPE 抓帧 | `p6d1-mat` 八块的中心像素；`p6d1-xform`、`p6d1-xform2` 整帧和 WPE 上屏图（`save_texture` 取 Present 那一事件）看布局 | 颜色相同、布局相同 | 2026-11-15 Claude：E1–E8 与 WPE 一致（E2 191/255 即 0.749）；三种转向转出的条形、侧对镜头不可见的层、NaN 的层不画都一致 |
| [x] | F8 解锁场景 `3243449890` | Windows dev，屏外宿主 | `kbp content unpack` 解包后导入，`render_scene` 跑脚本回放 30 帧 | 能渲染，没有不支持项；脚本没有与本步相关的报错 | 2026-11-15 Claude：100 段脚本全部 `init`，画面完整；只有 `objects/48/visible` 的 `update` 报 `Cannot create property 'x' on boolean 'true'` 被禁用：作者把拖拽脚本挂在了 `visible` 上，`init` 把 `value`（布尔）存进 `weizhi`，严格模式下 WPE 也会抛，与本步无关 |
| [x] | F9 解锁场景的实时画面 | Windows，真机 | 实时看 `3243449890` | 时钟与音频条照常动，和 WPE 观感一致 | 2026-11-15 用户手测：和 WPE 差不多 |
| [x] | F10 材质对象键的顺序（补提交） | Node，vitest；Windows dev，屏外宿主；WPE | `script/materialKeyOrder.test.ts` 七组；`p6d1-mat2/3/4`、`p6d1-keys`（fire / pulse / lightshafts，9–12 个键，触发扩容）导入 dev 库跑脚本，`Object.keys` 的结果和 WPE 日志比 | 逐项相同 | 2026-11-15 Claude：WPE 侧 `p6d1-keys` 的三组和读码预测逐项相同（证实扩容路径）；单测与真机读回七组全部相同；变异 3 处（不排序、非空桶追加到尾、不倒序）全部检出 |

## 场景壁纸 P6d1b：材质状态字段运行中改管线

2026-11-15 Windows dev。脚本写材质对象的 `blending` / `alphawriting` / `depthtest` / `depthwrite` / `cullmode`：
- 取值按一张表规整（编译期共用），非法值复位成第一项；
- 写进 `SceneState.passStates`，重编译重放；
- 写过的图层强制重建，规划取「bundle 值 + 覆盖」，角色规则照旧，着色器不换；
- 新组合的管线后台建、晚几帧换上，dev 探针读回前结清；
- 用到 `getEffect` 时场景目标加载就挂深度附件。

说明见 `cocs/wpe/WPE_SCENE.md`「层级、转向与 effect / 材质访问（P6d1a）」的「材质状态字段的写入（P6d1b）」；计划与实施记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6d1-hierarchy-effects.md` 点 8，读码 `rea-p6d1-matstate.md`。
- 验收文件在 `ignore/p6/d1/`：变异清单 `mutations4.json`、`mutations5.json`，语料 `corpus-base2.json` / `corpus-wt2.json`，真机图与轨迹 `real/p6d1-mat7*`、`real/p6d1-a2c*`，像素脚本 `a2c_pixels.py`。
- 测试工程由 `ignore/p6/d0/make_p6d1b.py`（`p6d1-mat7`、`p6d1-mat8`）与 `make_p6d1c.py`（`p6d1-a2c`）生成；WPE 像素在 `ignore/p6/d0/out/p6d1-round2.log` 末段，抓帧在 `A:\p6d\p6d1-mat7\`、`p6d1-mat8\`、`p6d1-a2c\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | G1 类型与格式 | Windows | 宿主 `tsc --noEmit`；Prettier `--check` 本步改动的 TS 文件 | 0 error、格式通过 | 2026-11-15 Claude：合并进主工作区后 tsc 0 error、16 个文件格式通过。工作树基点 `637530bd` 本身缺 `scriptPropertyEntries` 的导出（别的提交只提交了引用方），工作树里那一条 tsc 错误与本步无关 |
| [x] | G2 宿主 vitest（相关文件） | Node，vitest | `render/p6d1b`、`compile/passState`、`script/effectMaterialApi`、`render/p3a`、`dev/probe.scripts`、`render/rebuild`、`render/p5d-depth`、`render/p8`、`compile/p5c`、`compile/p5d`、`script/api`、`script/runtime`、`host.script`、`script/materialKeyOrder`、`script/hierarchyApi` | 全过 | 2026-11-15 Claude：主工作区 15 个文件 609 条全过（6 条本来就跳过） |
| [x] | G3 变异检查 | Node，工作区模式 | `mutations4.json` 13 处（工作树）、`mutations5.json` 1 处（主工作区，探针结清） | 每处都有用例失败，原样还原 | 2026-11-15 Claude：14 处全部检出、全部还原（非法值不复位、不分大小写、编译期不查表、规划不取覆盖、sync 不重建、建好不换上、不建深度附件、default 留键、不标脏、getter 只读 bundle、setter 空、字符串不放行、重放键、探针不结清） |
| [x] | G4 语料编译 | Node，`kbp corpus scan` / `diff` | 基点 `637530bd` 快照与工作树各扫一次，同一份翻译器 wasm | 不变 | 2026-11-15 Claude：233 张，0 出错，干净 160 → 160，没有键的增减 |
| [x] | G5 取值规则的读回 | Windows dev，屏外宿主（`render_scene`，`scripts: true`） | `p6d1-mat8` 在 tint 的 pass 0 上依次写五个字段（36 次，含 `bogus`、`Additive`、`3`、`null`、`less`、`back` 等），读回和 WPE 实测比 | 逐项一致 | 2026-11-15 Claude：非法值复位成表的第一项、`null` 不写、区分大小写，全部一致 |
| [x] | G6 管线状态 | Windows dev，屏外宿主 + 逐 draw 轨迹；WPE 抓帧 | `p6d1-mat7` 在 blur 四个 pass 各写一项，轨迹里每次绘制的混合、写掩码、剔除、深度和 WPE 抓帧比 | 相同 | 2026-11-15 Claude：pass 0 additive 进了中间 pass；pass 1 剔除 Back；pass 2 测写深度（fbo 没有深度附件，不起作用，同 WPE）；pass 3 上屏 SrcAlpha / InvSrcAlpha、写掩码 7、深度关（借基础材质）、剔除 Back（用自己的），和 WPE event 110 逐项相同 |
| [x] | G7 A2C 与 additive 的画面 | Windows dev，屏外宿主（回放 70 帧，第 60 帧写入）；WPE 抓帧 | `p6d1-a2c` 八组的中心像素和 WPE 比 | 7 组相同；C3 是已知差异 | 2026-11-15 Claude：N、M1（normal → A2C 不锐化，黑）、C1、M2a / M2b（A2C → translucent 仍锐化）、M3（运行中 additive 没有 `ADDITIVE`）、M7（不写 alpha）相同；C3（加载时 additive）WPE (255, 255, 0)、我们 (255, 0, 0)：加载期没加 `ADDITIVE` 组合键，WPE 自带着色器只在雾效读它、语料工坊着色器没有，随雾效补 |

## 场景壁纸 P6d2：脚本改成同步工厂加载

2026-11-15 Windows dev。用户脚本不再各自作 blob 模块求值：
- 加载期每种源码按真模块检查一次（哨兵模块，不执行用户代码），用 acorn 原地改写成工厂、间接 `eval` 编一次；
- 每段脚本调一次工厂，同步得到自己的模块状态；
- 命名空间、动态 `import()`（一律 reject）、`import.meta`（空对象）照 WPE 实测；
- 报错文字与行列和以前逐字相同；
- dev 工具 `scriptCorpus` 改成确定的，用来在改动前后跑全库比对。

说明见 `cocs/wpe/WPE_SCENE.md`「场景脚本（P3b）」的「用户脚本的加载（P6d2，同步工厂）」；计划与实施记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6d2-script-factory.md`。
- 验收文件在 `ignore/p6/d2/`：
  - WPE 实测 `wpe-forms.log`，改前 / 改后的输出 `forms-before.log` / `forms-after.log`；
  - 语料基线 `base/`、`base2/` 与改后 `after/`，驱动 `corpus_run.mjs`、比较 `corpus_diff.mjs`；
  - `realmCheck` 的错误源码 `realmcheck-sources.json` 与前后结果 `realmcheck-before.json` / `realmcheck-after.json`；
  - 变异清单 `mutations.json`（结果 `mutate.txt`），加载用时 `loadtime.mjs` / `loadtime.json`，语料写法统计 `forms.mjs`。
- 测试工程由 `ignore/p6/d0/make_p6d2.py`（`p6d2-forms`）生成。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | H1 类型与格式 | Windows | 宿主 `tsc --noEmit`；Prettier `--check` 本步改动的 TS 文件 | 0 error、格式通过 | 2026-11-15 Claude：工作树与主工作区 tsc 都是 0 error；格式通过 |
| [x] | H2 宿主 vitest（相关文件） | Node，vitest | `src/script/`、`src/dev/`、`src/puppet/`、`host.script`、`host.test`、改过的 24 个测试文件、新增的 `moduleRewrite` / `moduleFactory` / `compile/scriptImports` | 全过 | 2026-11-15 Claude：主工作区 53 个文件 918 条全过。本机语料下 `compile/pipeline.test.ts`「请求次数有界」失败，主工作区不含本步的代码同样失败，与本步无关 |
| [x] | H3 变异检查 | Node，工作区模式 | `mutations.json` 13 处 | 每处都有用例失败，原样还原 | 2026-11-15 Claude：13 处全部检出、全部还原（命名空间不排序、多变量导出漏名、顶层 this 不换、行偏移错一行、动态导入 resolve、实例共用状态、星号歧义不去掉、default 名字不改、报错不减偏移、回调 this 不对、编译期又扫动态导入、顶层 await 不判 async、写入报错文字不同） |
| [x] | H4 模块写法与 WPE 逐行比 | Windows dev，屏外宿主（`render_scene`，`scripts: true`，6 帧）；WPE 测试窗口 | `p6d2-forms` 五段脚本的 `[kbp6d]` 输出与 WPE `log.txt` 逐行比 | 26 行相同 | 2026-11-15 Claude：改后 26 行与 WPE 逐行相同；改前有 3 行不同（`import.meta` 带 `url`、两次动态导入能 resolve） |
| [x] | H5 报错文字与行列 | Windows dev，屏外宿主（`host.realmCheck`，场景 `3146703458`） | 14 段错误源码（语法、链接、缺库、顶层 `return`、HTML 注释、`await` 作变量名、求值期报错、多变量 / 解构导出、再导出、`import.meta`、默认导出、顶层 `this` / `arguments`）改前改后各跑一次 | 逐字相同 | 2026-11-15 Claude：14 段的状态、导出名、报错文字与行列全部相同 |
| [x] | H6 全语料脚本诊断 | Windows dev，屏外宿主（`scriptCorpus`，120 帧、固定时钟与种子） | 改前连跑两遍、改后一遍，逐张比各段诊断、状态摘要、console 摘要 | 相同 | 2026-11-15 Claude：改前两遍 236 张逐张相同（工具确定）；改后能比的 236 张里 231 张相同，另 5 张只有编译期能力键不同（`object:castvolumetrics`，别的会话未提交的体积光改动），脚本诊断、状态与 console 都相同；10 张是基线之后才导入的，不比 |
| [x] | H7 加载用时 | Windows dev，屏外宿主 | 能渲染、脚本最多的 `3660962877`（252 段、27 种源码）：`realmCheck` 的 `elapsedMs`，与同一宿主里照旧方式逐段 `import(blob)` 交替各三次 | 不慢于旧方式 | 2026-11-15 Claude：新 176–189 ms，旧约 1 s |
| [x] | H8 预览与桌面 | Windows dev，预览与桌面壁纸窗口 | 打开几张带脚本、能渲染的场景（灯带、时钟、音频条类） | 画面与改前一致，动画在走，日志里没有「场景脚本改写失败」 | 需要用户在界面上看 |

## 场景壁纸 P6d3a：对象表与结构 API

2026-11-15 Windows dev。场景脚本改结构：
- `SceneState.order` 是 WPE 的对象表，决定绘制顺序与脚本下标，相机对象取表里最后一个可见的；
- `sortLayer` 先摘再插；
- `destroyLayer` 记待删、全部脚本之后一次生效，生效后对象作废、挂着的脚本收 `destroy`；
- `setParent` 照读码逐位复刻 adjust、组深度检查、成环拒绝；
- 结构跨重编译保留，改组归属或挂点的走重编译；
- `getInitialLayerConfig` 取加载原文，`registerAsset` 只能在模块顶层调。

建层（`createLayer`）是 P6d3b。说明见 `cocs/wpe/WPE_SCENE.md`「对象表与结构 API（P6d3a）」；计划与 WPE 实测见 `.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md`，adjust 的读码见同目录 `rea-p6d3-adjust.md`。
- 验收文件在 `ignore/p6/d3/`：
  - 测试工程生成 `make_step0.py`，WPE 日志夹具 `out/wpe-*.log`（`cut_log.py` 截取），我们的输出 `out/kb-*.log`（`logrun.mjs`），画面 `out/{wpe,kb}-s*.png`（`renderstage.mjs`、`cmp_png.py`）；
  - 语料 `corpus-after/`（与 `ignore/p6/d2/after/` 比，`unsupported_diff.py`）；
  - 变异清单 `mutations.json`（结果 `mutate.txt`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | I1 类型与格式 | Windows | 宿主 `tsc --noEmit`；`deno task check -c kabegame`；Prettier `--check` 本步改动的文件 | 0 error、格式通过 | 2026-11-15 Claude：工作树与主工作区 tsc 0 error；vue-tsc 通过，cargo 那半被跑着的 dev 占用 CEF 文件（os error 32）没跑完；格式通过 |
| [x] | I2 宿主 vitest（相关文件） | Node，vitest | `src/script`、`src/host*`、`src/dev/probe*`、`src/render`、`compile/p6d3`、`compile/scriptApi` | 全过 | 2026-11-15 Claude：主工作区 86 个文件 1894 条全过（24 条跳过） |
| [x] | I3 变异检查 | Node，工作区模式 | `mutations.json` 12 处 | 每处都有用例失败，原样还原 | 2026-11-15 Claude：12 处全部检出、全部还原（负数下标到表头、删除当场生效、计数不扣待删、作废后仍可读、对象参数看待删、adjust 不反算、组深度不查、重编译丢结构、组内按下标、配置原文不取 8 位、相机取第一个、换父插在表头） |
| [x] | I4 脚本输出与 WPE 逐行比 | Windows dev，屏外宿主（dev 探针 `renderFrame`，`scripts.consoleGrep`，dt 1/60）；WPE 测试窗口 | `p6d3-struct`（900 帧）、`p6d3-parent`（900 帧）、`p6d-tree`（150 帧）、`p6d3-attach`（500 帧）的 `[kbp6d3]` / `[kbp6d]` 输出与 WPE `log.txt` 逐行比 | struct 全同；parent 只差成环那一步；tree 只差 P6d1 起就有的三行；attach 只差挂点与骨骼姿势 | 2026-11-15 Claude：struct 27/27 相同；parent 前 40 行相同，第 41 行起是我们拒绝成环后继续跑（WPE 在这里整个进程崩溃）；tree 51 行中 48 行相同（图层 / effect 对象的自有键与原型，改前就不同）；attach 换父的结构与字段相同，挂点要等重编译、puppet 姿势在探针里不推进，矩阵不同 |
| [x] | I5 画面与 WPE 逐像素比 | Windows dev，屏外宿主，窗口 1280×720；WPE 抓帧 `A:\p6d3\struct\` | `p6d3-struct` 回放到 WPE 抓帧的帧号（162 / 318 / 654 / 779）读回 | 组内排序两阶段相同；相机两阶段除删组后的子层外相同 | 2026-11-15 Claude：第 1、2 阶段 0 像素不同；第 5、6 阶段只差左下角的 G1（删组后 WPE 当帧由顶层画，我们等重编译，已知差异） |
| [x] | I6 全语料脚本诊断与能力键 | Windows dev，屏外宿主（`scriptCorpus`，120 帧） | 与 P6d2 的 `after/` 逐张比 | 变化只来自去掉的缺口键 | 2026-11-15 Claude：能比的 236 张里 15 张不同，全是去掉 `registerAsset` / `sortLayer` / `getInitialLayerConfig` / `destroyLayer` 四个键带来的（原先求值失败或报 not a function 的脚本现在跑起来），没有新增的键与新报错；解锁 `2887099508`、`3570755196` |
| [ ] | I7 解锁的两张在预览与桌面 | Windows dev，预览与桌面壁纸窗口 | 打开 `2887099508`、`3570755196` | 正常渲染、不退回预览图，脚本没有报错（日志） | 2026-11-15 用户：`2887099508` 不通过，缺开场镜头滑动。原因是混淆脚本调 `getCameraTransforms` / `setCameraTransforms`（我们没有，编译期扫描认不出），已转交 P5 会话实现。点书时 `objects/18/visible` 的 `cursorClick` 报错，是 `playSingleAnimation`（同样混淆），已转交 P12。全部脚本解码后对照缺口表，只缺这一个；`3570755196` 待看 |
| [ ] | I8 删组与换进组的重编译 | Windows dev，预览 | 预览打开 `ignore/p6/d3/proj/p6d3-struct` 与 `p6d3-parent`（已导入，库里 15302 / 15301），看到第 4 阶段（约 8 s）之后 | 删组后剩下的红块在重编译后出现在左下；换进组的蓝块在重编译后被组裁掉；日志有「场景脚本删除了图层」「换父改了组或挂点」，没有报错 | 需要用户在界面上看 |

## 场景壁纸 P6d3b：运行时建层（`createLayer`）

2026-11-16 Windows dev。`thisScene.createLayer(...)`：

- 参数照 dll 整理成配置：缺省模型正交 / 透视各一个，对象过 `stringifyConfig`，路径按目录定键；
- 资源路径按当前脚本的 `__workshopId` 改写，编译期 assets 名单里有的不改；
- 当场建出待编对象，追加到对象表尾，配置里带的脚本在返回前跑完 `init`；
- 新建对象作编译输入：`init` 里建的放弃本次加载、带结构重编后再画首帧，运行中建的走重编译（晚一段，P6d4 改同步）。

顺带改了两处：图层 `name` 可写；effect 对象的键序是 `name`、`visible`。

说明见 `cocs/wpe/WPE_SCENE.md`「运行时建层（P6d3b）」；计划与 WPE 实测见 `.claude/plans/wpe-import/3-scene/phase6/phase-6d3-runtime-layers.md`「P6d3b」。
- 验收文件在 `ignore/p6/d3/`：
  - 测试工程生成 `make_step0b.py`（`proj/p6d3b-*`），另用 `ignore/p6/d0/proj/p6d-asset`、`p6d-order`；WPE 日志夹具 `out/wpe-{bars,clone,default,asset,order}.log`，我们的输出 `out/kb-*.log`（`logrun.mjs`），画面 `out/{wpe,kb}-bars.png`；
  - 语料 `corpus-b-all/`（与 `corpus-after/` 比，`unsupported_diff.py`）；编译产物哈希 `hash-{head,mine}.json`（`bundlehash.test.ts`）；
  - 变异清单 `mutations-b.json`（结果 `mutate-b.txt`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | J1 类型与格式 | Windows | 宿主 `tsc --noEmit`（独立工作树与主工作区）；Prettier 本步改动的文件 | 0 error、格式通过 | 2026-11-16 Claude：两边 tsc 0 error；格式通过 |
| [x] | J2 宿主 vitest（相关文件） | Node，vitest | `src/script`、`src/host*`、`src/dev`、`src/compile`、`src/render` | 全过 | 2026-11-16 Claude：工作树（HEAD + 本步）156 个文件 3340 条全过，主工作区（含别的会话未提交的改动）159 个文件全过 |
| [x] | J3 变异检查 | Node，工作区模式（独立工作树） | `mutations-b.json` 13 处 | 每处都有用例失败，原样还原 | 2026-11-16 Claude：13 处全部检出、全部还原（id 不写进配置、缺省模型被改写、图层名只读、待编图像层没骨骼方法、effect 键序、克隆脚本晚 init、不读 `__workshopId`、`init` 里建层不重编、运行中建层不重编、下标复用、编译不带新建对象、新建对象置被依赖、探针不补编）。原有一处「按 id 找父不认待编对象」未检出，查明是冗余代码（`createdIds` 已覆盖），删掉后不再列 |
| [x] | J4 脚本输出与 WPE 逐行比 | Windows dev，屏外宿主（dev 探针 `renderFrame`，`scripts.consoleGrep`，dt 1/60）；WPE 测试窗口 | `p6d3b-bars`（40 帧）、`p6d3b-clone`（130 帧）、`p6d3b-default`（10 帧）、`p6d-order` / `p6d-asset`（120 帧）的输出与 WPE `log.txt` 逐行比 | 除已知差异外相同 | 2026-11-16 Claude：clone 42/42、order 48/48 相同；bars 24 行差 2 行（图层对象自有键数 59 / 30，已编译图层同样如此、P6d1 起就有；`size` 编译前读不到自动尺寸，已知差异）；asset 36 行差 1 行（自有键数 21 / 24，同上）；default WPE 的 4 行相同，我们多 2 行（WPE 透视场景对数组配置取 `getInitialLayerConfig` 时整段 `init` 中止，不复刻） |
| [x] | J5 画面与 WPE 逐像素比 | Windows dev，屏外宿主，窗口 1280×720 | `p6d3b-bars` 跑 30 帧读回，和 WPE 抓帧比 | 相同 | 2026-11-16 Claude：0 / 921600 像素不同 |
| [x] | J6 全语料能力键与脚本诊断 | Windows dev，屏外宿主（`scriptCorpus`，120 帧） | 与 P6d3a 的 `corpus-after/` 逐张比 | 变化只来自去掉的 `createLayer` 缺口键 | 2026-11-16 Claude：14 张去掉 `script:api:thisScene.createLayer`，解锁 4 张音频条（`3304642534`、`3549863808`、`3570308528`、`3812487163`），没有新增的键。另有雾的键与 `14998` 的解锁，来自别的会话未提交的 P13f。状态摘要全部变化，因为摘要含 `general`（P13f 加了雾字段），编译产物另见 J7 |
| [x] | J7 编译产物不变 | Node，vitest（`bundlehash.test.ts`） | 本机全语料在 HEAD 与 HEAD + 本步两份源码上各编一次（同一个翻译器 wasm），比规范化后的 bundle 哈希（新字段 `assetPaths` 不计） | 除去掉缺口键的场景外逐张相同；那些场景只差 `unsupported` 及其连带项 | 2026-11-16 Claude：233 张中 219 张相同；另 14 张正是去掉 `createLayer` 缺口键的，差别只在 `unsupported`，以及因此才解码的纹理 `mips` 与视频时长（编译只在 `unsupported` 为空时解码纹理，改前这些场景一开始就判了退回） |
| [x] | J8 首次加载多编一次的用时 | Windows dev，屏外宿主 | 打开 `init` 里建层的音频条壁纸，按应用日志的时间戳量从开宿主到开始渲染 | 记下数值 | 2026-11-16 Claude：`3304642534`（`init` 里建 64 根条）开宿主到开始渲染 2.3 s；第二次加载 734 ms，其中编译 151 ms、等目标与设置 56 ms，多出约 0.2 s |
| [x] | J9 解锁的音频条在预览与桌面 | Windows dev，预览与桌面壁纸窗口 | 打开 `3304642534`、`3549863808`、`3570308528`、`3812487163`，放音乐 | 正常渲染、不退回预览图，条随音乐跳动，日志里没有脚本报错 | 2026-11-16 用户：通过 |
| [x] | J10 克隆与运行中建层 | Windows dev，预览 | 预览打开 `ignore/p6/d3/proj/p6d3b-clone`（已导入，库里 15318），等 1 s 以上 | 首帧就有 C1、C2 两个青色方块；约 1 s 时 C3 出现（运行中建层，比 WPE 晚一段） | 2026-11-16 用户：通过 |

## 场景渲染器的逐 draw 轨迹（dev 工具）

2026-11-13，只在 dev 构建：dev 探针 `renderFrame`、vite `/render`、MCP `render_scene` / `host_render` 收 `trace`，记下读回那一帧逐个 pass、逐个 draw 的管线、绑定、uniform、顶点，可选读回 pass 的目标，用来和 WPE 的 RenderDoc 抓帧逐 draw 对照。计划见 `.claude/plans/tools/scene-draw-trace.md`，用法见 `.claude/skills/kabegame-chromium/SKILL.md`「逐 draw 轨迹」，实施记录在 `ignore/tools/draw-trace/record.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 单测与检查 | Node + Deno | 宿主 tsc、vitest（`render/trace.test.ts`、`dev/drawTrace.test.ts`）；`deno test -A --no-check scripts/kabegame-dev/ apps/kabegame-dev-mcp/src/`；Prettier | 0 error；只有已知的 `pipeline.test.ts` 一条失败 | 2026-11-14 Claude：合进工作区后宿主 tsc 0 error；`render/trace.test.ts`、`dev/drawTrace.test.ts`、`render/text.test.ts`、`render/bloom.test.ts` 104 条全过（快照）；工作区 `deno test -A --no-check scripts/kabegame-dev/ apps/kabegame-dev-mcp/src/` 49 组 204 步全过 |
| [x] | T2 不要轨迹时逐字节不变 | Windows dev，屏外宿主 | 宿主重建前后各渲染同一帧（不带 `trace`），比 `meta.sha256` | 相同 | 2026-11-14 Claude：`e3clock-nofx`（图片 14504）同一帧，旧产物不带轨迹与新产物带轨迹的 PNG SHA-256 都是 `5c3077…`（见 T3） |
| [x] | T3 要了轨迹画面也不变 | 同 T2 | 同一帧带 `trace: { save, readback: [...] }` 渲染，比 `meta.sha256` 与 T2 | 相同（代理只转发；补 COPY_SRC 不改画面） | 2026-11-14 Claude：带 `trace: { readback: ["layer 179"] }` 渲染，画面 SHA-256 同不带轨迹（`5c3077…`）；8 个 pass、7 个 draw、`errors` 为空 |
| [ ] | T4 代理不被 WebGPU 拒 | 同 T2 | 带 `trace` 渲染一张有粒子 / 文本 / 视频 / 泛光的场景 | 不报品牌检查错误；`trace.json` 的 `errors` 没有校验错误 | 2026-11-14 Claude：只测了文本场景（`e3clock-nofx`：合成 RT、快照拷贝、画布 blit 都记下、没有校验错误）；粒子、视频、泛光场景未测 |
| [x] | T5 `e3clock-nofx` 黑字层上屏 draw 对 WPE 事件 59 | 同 T2 + `A:\p6b\e3clock-nofx\e3clock-nofx-frame240.rdc` | 回放到第 240 帧带 `trace`，找黑字层上屏的 draw，比 MVP（`uniforms`）、顶点与 UV（`vertices`） | 能逐项对上，或差异落到具体的值 | 2026-11-14 Claude：顶点（±407 × ±153）与 UV 和 WPE 逐位相同、混合相同；MVP 的 x 平移差 1 个 float32 ulp（0.8617067933 对 0.8617067337），y 按各自视口（我们 3840×2160 再 blit 裁 15 行，WPE 直接 3840×2130）；我们是 4 顶点三角形带（对角线右下–左上），WPE 是 6 索引列表（对角线左下–右上） |
| [x] | T6 黑字层合成 RT 对 WPE RT 7128 | 同 T5 | `trace.readback` 选黑字层的合成 pass，`pass-<下标>.png` 和 WPE 的 RT 逐像素比 | 能比；差异落到具体的 draw | 2026-11-14 Claude：pass 2（黑字层画字形）读回和 WPE RT 7128（事件 59）RGBA 逐像素 0 差异，差异因此只在上屏的 draw |
| [ ] | T7 护栏 | 同 T2 | 读回很多个 4K 浮点 pass（超过 64 MB）；旧宿主产物带 `trace` | 413 不取；409 `[host]` | |

## 场景壁纸 P5d：透视相机、相机对象、深度与剔除、透明排序

2026-11-13–14 Windows dev。P5d 分步骤 0 调研加 4 步：
- 步骤 0：20 个确定性工程实测核对读码（`gen_d.py`，抓帧 `A:\p5d\`）；
- 1 深度与剔除：场景目标挂 `depth32float`（GREATER、每帧清 0），pass 的深度 / 剔除缺键规则对所有对象一套，管线按目标有无深度各建一份；
- 2 透视相机：`PerspectiveFovRH`、基准相机与路径、三维抖动、按画布尺寸渲染（分辨率变了整场重新加载）、视图向量、粒子 sprite 面向相机，解锁 dna_fragment、techno、neon_sunset；
- 3 相机对象：选相机、正交 / 透视下的视图、透视覆盖、视差点与抖动跟相机，另加真实写法走查（`3462279189`、`3605722997`、`3453730450`）；
- 4 透明排序：透视场景里 `transparentsorting` 分两遍、按局部 `origin` · 视线由远到近稳定排序。

说明见 `cocs/wpe/WPE_SCENE.md`「透视相机、相机对象与深度（P5d）」（含「未实测与照报清单」）；每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`，实测结论见同目录 `p5-REPORT.md`「P5d 语义的实测核对」。

验收工具在 `ignore/p5/`：确定性工程由 `d0/gen_d.py`（以及 `d2/`–`d4/` 的 `gen_d*.py`）生成，放在 `proj/p5d-*`；各步的快照、补丁、变异清单、语料比较与整帧比对在 `d1/`–`d4/`；WPE 参照在 `A:\p5d\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | D0 单测与检查 | Windows | 每步：子代理在 HEAD 快照里跑 `apps/wpe-scene` 的 tsc、vitest、Prettier；Claude 在快照与合并后的树上复跑（带 `KABEGAME_WPE_ROOT`） | 0 error；除已知失败外全过 | 2026-11-13–14 Claude：步骤 1 合并树 vitest 2607 过；步骤 2 变基后 2858 过；步骤 3 `5889b490` + 步骤 3 上 2996 全过；步骤 4 主工作区 149 个文件 3456 条全过；各步 tsc 0 错误。已知失败 `3830255100: 219 次请求`，步骤 3 合并后工作区另有 `2251857160: 553 次请求`（P10a 去掉 `value:animation:pending` 后这张能编完、请求变多，与本节无关） |
| [x] | D1 读码 · 实测核对 | WPE 抓帧（1920×1080 窗口，宽高比另抓 1280×1024，透明排序 1600×900） | 20 个确定性工程加三张目标样本与模板相机场景 3462279189；补测 `p5d-tilt`、`p5d-camo-{pp,ppr,par,shake}`、7 个 `p5d-sort-*` | 读码结论逐条成立，或写明推翻处 | 2026-11-13–14：读码全部成立，推翻一处（透视开视差时 `g_ParallaxPosition` 是 NaN，不钳成 0）、更正一处（粒子 sprite 面向相机）、补两条（带 effect 的上屏 pass 剔除取 effect 材质、`clearenabled: false` 时深度也不清）；正交相机对象的「冲突」解开（模板场景的图层本来摆在 W/2…3W/2） |
| [x] | D2 深度与剔除 · 对 WPE | Windows dev 屏外宿主 + WPE 抓帧 | `p5d-depth-o`、`p5d-cull`、`p5c-depth` 按 WPE 日志回放，`kbp cmp frame --kbp-layers` 整帧比 | 逐像素一致 | 2026-11-13 Claude：三个都差 0。`p5d-noclear` 没比（WPE 不清屏的后备缓冲在回放里未定义），「不清深度、第二帧起不再画」由单测锁住 |
| [x] | D3 透视相机 · 对 WPE | 同 D2，窗口 1920×1080 | `p5d-persp`（含 1280×1024）、`-persp-b`、`-depth2`、`-path` w1 / w6、`-shakep-r`、`-tilt`、`-2d-nofs` 按日志回放整帧比 | 逐像素一致 | 2026-11-13 Claude：全部差 0。路径状态机按 `p5d-path` 日志逐帧推，能核对的 6 帧 `g_EyePosition` 差 ≤ 3.7e-6；`p5d-shakep` 没比（日志到第 150 帧、抓帧在 180），`p5d-shakep-r` 与单测已覆盖三维抖动 |
| [x] | D4 透视样本 · 对 WPE | 同 D2，`kbp content unpack --instrument` 解包加日志 | techno、dna_fragment（去粒子）、neon_sunset（去粒子）按日志回放整帧比 | 差别只在已知的采样与哈希噪声处 | 2026-11-13 Claude：techno 最大差 4；dna_fragment 去粒子最大差 8（1 个像素超过 2）；neon_sunset 去粒子超过 2 的像素 0.13%、超过 32 的 20 个，逐层拆开（12 个变体）太阳单层 0 差，残差只在带 neongrid（顶点着色器哈希）或 filmgrain 的图层，没有继续查 |
| [x] | D5 相机对象 · 对 WPE | 同 D2 | `p5d-camo-c` / `-o` / `-r` / `-pp` / `-ppr` / `-par` / `-shake`、`p5d-camp-2`、`-camo-0`、`-camp-1`；`p5d-camo-s`、`-s4k`（开 `scripts`）按日志回放整帧比 | 逐像素一致，或差别只在 FR / CLK | 2026-11-14 Claude：前七个与 `-camp-2` 差 0；`-camo-0` 只有 CLK 块差 34（回放用缺省光标）、排除后 0；`-camp-1` 只有 FR / CLK 不同（WPE 在透视场景对图像层做视锥剔除，只记不补）；`-camo-s`、`-camo-s4k`（场景 3840×2160、窗口 1920×1080）整帧不排除任何区域逐像素相同，脚本日志与 WPE 相同 |
| [x] | D6 相机对象真实写法走查 | WPE 抓帧 + 复制工程（`kbp content isolate`），窗口 1920×1080 / 1600×900 | `3462279189`（模板：原点脚本、`zoom` 绑属性、开视差）、`3605722997`（三个相机按属性切换）、`3453730450`（透视、`Date.now()` 缓入）各录一段，脚本照常跑，逐帧比 | 全部 draw 的 MVP、视差点、`g_Time` 与 WPE 相同；整帧差能解释 | 2026-11-14 Claude：`3462279189` 各组 MVP 逐位相同，整帧差只在锐利边缘（先按场景分辨率画再缩的采样差，放大采样时最大差 12）；`3605722997` 三个相机最大差 12–35、超过 32 的 1 像素；`3453730450` MVP 相同，开透明排序后整帧逐像素相同（录制时按 WPE 后处理开启档回放）。`3706286085` 做不了（相机挂在带骨骼动画的模型下，`mdl:skeleton` / `mdl:animation` 没实现），换成 `3453730450` |
| [x] | D7 透明排序 · 对 WPE | 同 D2，窗口 1600×900 | `p5d-sort-a` / `-off` / `-rot` / `-par` / `-eq` / `-fs` / `-ortho` 按日志回放整帧比（开 `scripts`，FR / CLK 不排除） | 除 CLK 块外逐像素一致；正交与关开关按 `objects` 顺序 | 2026-11-14 Claude：实现前需要排序的 5 组有大片差异；实现后 6 个透视工程只剩 CLK 块（颜色取自光标，日志没记光标），关开关那组本来也只有这一块；正交那组只有 CLK 加采样边缘差，和实现前相同 |
| [x] | D8 变异检查 | Node | `kbp mutate`（快照模式）逐处改坏实现，跑相关单测 | 每处都有用例失败，源码原样还原 | 2026-11-13–14 Claude：步骤 1 16 处、步骤 2 32 处、步骤 3 21 处、步骤 4 3 处（子代理另有 13 / 28 / 31 / 18 处）全部检出，还原后整树哈希一致；步骤 2「宿主不重新加载」、步骤 3「离开相机对象时提前返回」补用例后检出 |
| [x] | D9 语料变化 | Node，173 → 183 个工程 | 每步前后重扫 `unsupported`（`kbp corpus diff`，同一份翻译器 wasm） | 只去掉本步的键，原来能渲染的场景不掉出 | 2026-11-13–14 Claude：步骤 1 去掉 `cull:normal` 12、`depthwrite:enabled` 10、`depthtest:enabled` 6；步骤 2 去掉 `camera:perspective` 11 与透视的 `general:camerashake` 3，新增 `camera:perspective:text` 2、`:group` 1，能渲染 66 → 69（dna_fragment、techno、neon_sunset）；步骤 3 去掉 18 张的相机五个键，69 → 69（`5889b490` 上 78 → 78）；步骤 4 去掉 3 张的 `general:transparentsorting`，90 → 90 |
| [x] | D10 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 和之前的基线相同 | 2026-11-13–14 Claude：步骤 1（另加 retro、shimmering_particles，`targetBytes` 正好多一张深度）、步骤 2（变基前后各一次）、步骤 3（变基前后）都相同。步骤 3 的提交树（`5889b490` + 步骤 3）没重测、步骤 4 没跑成（共享宿主产物被别的会话反复重建；10 张基线都没开 `transparentsorting`，关闭时的调用序列有假设备单测锁住） |
| [x] | D11 预览 · 三张透视样本实时渲染 | Windows，图库预览 | 打开 techno、dna_fragment、neon_sunset | 实时渲染、不退回预览图 | 2026-11-13 Claude：三张都实时渲染，场景目标 3840×2160（主屏全分辨率）、铺满；没有逐一目视对比作者预览（见 D12） |
| [ ] | D12 预览 · 画面与作者预览一致 | Windows，图库预览 | 打开 dna_fragment、techno、neon_sunset，看相机视角、深度遮挡、粒子朝向 | 与 Wallpaper Engine 里的画面一致，不卡 | 待用户确认 |
| [ ] | D13 桌面壁纸窗口 | Windows，窗口模式 | 把三张透视场景设为桌面壁纸 | 和预览一致；铺满壁纸窗口 | 桌面壁纸窗口没看 |
| [ ] | D14 改画布尺寸只重载一次 | Windows，预览 / 桌面 | 打开透视场景后拖动主窗口改大小，或改系统分辨率 | 尺寸稳定约 300 ms 后只整场重新加载一次，没有反复重载、残留画布或多个 GPU 设备 | 只有 `host.test.ts` 的单测，没在真机上拖窗口；重载后粒子重新预热 |
| [ ] | D15 属性切换相机 | Windows，图库预览 | 打开 `3605722997` 一类按属性切换相机的场景（还缺别的能力，用 dev 强制渲染） ，在预览右栏切换相机属性 | 画面跟着换到对应相机，不整场重编译 | 复制工程已逐帧对过 WPE；实时预览里切属性没看 |
| [ ] | D16 透明排序在真实壁纸里 | Windows，图库预览 | 打开开着 `transparentsorting` 的场景（`3453730450` 一类，还缺别的能力，用 dev 强制渲染） | 远处的黑色层不再盖住近处的半透明层 | 复制工程已对过 WPE；原版场景没实时看 |

## 场景壁纸 P8：图像层与材质补全（合成 RT 的采样、形状、对齐、图层依赖、写入状态）

2026-11-13–14。图像层上五处对齐 WPE：合成 RT 按对象的 `clampuvs` / `nointerpolation` 采样；形状对象按第一个 effect 的四个点画四边形；图像层 `alignment` 的偏移只进图层画自己的矩阵；`dependencies` 让被依赖的图层（图像层与文本层，文本层 2026-11-19 步骤 6；有子层的组 2026-11-20 步骤 7）出独占的合成 RT、材质按名字 `_rt_imageLayerComposite_<id>_a` 引用；材质的 `alphawriting` 与 `alphatocoverage`（单采样下在着色器里丢弃 alpha ≤ 0.5 的片元）。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase8/p8-REPORT.md`，逐步的验收数据见 `phase-8-image-material.md`「实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Q0 单测与检查 | Windows | 每步在 HEAD 快照与合并后的工作区跑 `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error；除已知失败外全过 | 2026-11-14 Claude：步骤 5 的快照 127 个文件 3082 个用例全过（`pipeline.test.ts` 的请求上限步骤 4 已放宽，另断言同一路径同一区间不请求第二次） |
| [x] | Q1 语料 | Node，173 → 183 个工程 | 每步前后重扫 `unsupported`（`kbp regress --corpus`） | 只去掉本步的键，没有新增的键，原来能渲染的不掉出 | 2026-11-14 Claude：五步分别去掉 `object:clampuvs` / `object:nointerpolation`、`object:shape`、`object:alignment` / `script:api:layer.alignment`、`object:dependencies` / `texture:rendertarget:_rt_imageLayerComposite_*`、`material:alphawriting` / `blend:alphatocoverage`；解锁 `3668499717`、`3656079027`、`3811764016`、`3812887609`、`3819646765`、`3821678218`；用到 P8 的 57 张能渲染 10 张，P8 的键清零 |
| [x] | Q2 回放案例 | Node | 每步 `kbp regress` 两份源码 | 粒子回放案例逐字节相同 | 2026-11-14 Claude：每步都相同；步骤 3 的 `f1`、步骤 4 的 `f3`、步骤 5 的 `e4` 两边同样失败，是别的会话新加的案例或基线就有 |
| [x] | Q3 合成 RT 的采样 | Windows dev + WPE 抓帧 | `p8-clamp`、`p8-clamp2` 按日志回放，和 WPE 比 | 0 差异 | 2026-11-13 Claude：0 差异（改前 `p8-clamp` 差 106776 个像素）；`3832772446` 受影响的图层从重复变钳制，和 WPE 比差 > 32 的占 0.21%，在缩放轮廓上 |
| [x] | Q4 形状 | Windows dev + WPE 抓帧 | `p8-shape`、`p8-shape2` 比整帧；形状的四角对 RenderDoc `vs_out`；解锁的 5 张各抓一帧按日志回放比 | 整帧最大差 ≤ 6；四角 < 0.01 像素；光束没有缺失或错位 | 2026-11-13 Claude：`p8-shape` 最大差 6、`p8-shape2` 2；四角最大差 8.1e-5；5 张差 > 32 的占 0.02%–0.65%，在随机粒子与缩放轮廓上 |
| [x] | Q5 对齐 | Windows dev + WPE 抓帧 | `p8-align`、`p8-align2` 比整帧与四角；`p8-par` 的脚本 `layer.alignment` 在应用预览里实测 | 四角 < 0.01 像素；脚本读写与 WPE 日志逐字相同 | 2026-11-13 Claude：`p8-align` 最大差 1；`p8-align2` 只差 F1 一行（各向异性）；四角最大差 1.9e-4；预览里跑满 495 帧，脚本日志与 WPE 相同 |
| [x] | Q6 图层依赖 | Windows dev + WPE 抓帧 | `p8-dep`、`p8-dep2`、`p8-misc` 按日志回放比；`p8-dep` 的 B3（排在被依赖者前面）用探针 `profile: 1` 先编码上一帧 | 0 差异；B3 是上一帧的颜色 | 2026-11-14 Claude：`p8-dep2` 0 差异；`p8-dep` B3 = (246, 8, 127)，同 WPE 第 160 帧；`p8-misc` 的 A13（隐藏组合层）、A14（画面外）相同 |
| [x] | Q7 依赖的语料场景 | Windows dev | 9 张有依赖的场景编译后查绑定；强制渲染 `2251857160`、`3554161528`、`3276911872`（打开 4 个引用方的可见性属性，逐 draw 轨迹核对） | 引用 pass 都绑独占 RT、没有棋盘格；没有 WebGPU 校验错误 | 2026-11-14 Claude：45 个引用 pass 全部绑对；三张都没有校验错误；`3243449890` 另有工坊 effect 超过 16 个阶段间变量建不出管线，和 P8 无关 |
| [x] | Q8 写入状态 | Windows dev + WPE 抓帧 | `p8-a2c`、`p8-misc`、`p8-alpha` 按日志回放比；逐 draw 轨迹读每次绘制的写掩码与 A2C | A2C 渐变与 W2 0 差异；写掩码对上 p8-REPORT 的实测表 | 2026-11-14 Claude：`p8-a2c` 只有 CLK 差 1、`p8-misc` 0 差异；`p8-alpha` 除 X 组都是 0（X 组是测试工程的 fbo pass 乘了 MVP，见实施记录）；九种写掩码与 W1 / W2 全部对上 |
| [x] | Q9 A2C 的语料场景 | Windows dev | 强制渲染 `3611425904`、`3783690410` | A2C 管线建成、没有校验错误 | 2026-11-14 Claude：成立；`3783690410` 是 effect 末 pass 借基础材质的 A2C 上屏 |
| [ ] | Q10 解锁场景实时运行 | Windows dev | 把 6 张解锁场景分别在图库预览里打开、设为桌面壁纸 | 画面与作者预览一致、不卡、不退回预览图；形状光束随时间流动 | 只做过屏外宿主的回放比图，没在实时预览与桌面看 |
| [ ] | Q11 A2C 在其它显卡上 | 其它 Windows 机器（AMD / Intel） | 打开 `3611425904`，看 A2C 图层边缘 | 和 WPE 在同一台机器上一致 | 单采样 A2C 的覆盖由驱动决定，阈值是在本机 NVIDIA 上实测的 |
| [ ] | Q12 被依赖图层的 effect 开关 | Windows dev | 找一张被依赖图层带可开关 effect 的场景（语料暂无），运行中切换 | 引用方画面跟着变、没有闪烁或残留 | 语料 0 张；WPE 切换时销毁重建独占 RT（读码，没实测），我们跨重建保留 |
| [x] | Q13 被依赖的文本层 | Windows dev + WPE 抓帧 | `p8-deptext`（7 个文本 / 引用组合：可见、带 effect、写死隐藏、6 pt、每 40 帧换宽度、每 40 帧清空）按日志回放第 242、280–282、291 帧；`3837779440` 的复制工程（只留时钟 1049 与引用方 186、时钟固定「22:22」、关掉 186 的三个动作 effect）比三帧 | 整帧 0 差异；换宽度那帧排在前面的引用方读到全 0 | 2026-11-19 Claude：两组全部 0 差异；`3837779440` 的 `dependency:text` 去掉后干净；不关动作 effect 时手臂姿态和 WPE 不同（另记，与依赖无关） |
| [x] | Q14 被依赖的组 | Windows dev + WPE 抓帧 | `p8-depgroup`（7 种组合：可见、写死隐藏、属性隐藏、`copybackground: false` + effect、隐藏 + effect、组 → 纯色层 → 孙子且引用方排在组前面、隐藏组里的被依赖子层）回放两帧与 WPE 第 627–629 帧比；语料改前改后各扫一遍（加 myprojects 两张） | 整帧 0 差异；组隐藏时引用方只看到拷屏 / 清空与 effect 的结果、没有子层；语料只去掉 `3811403844` 的 `dependency:group` | 2026-11-20 Claude：`p8-depgroup` 三帧 0 差异；语料 234 → 235 张干净，没有新增键 |
| [ ] | Q15 3811403844 实时预览 | Windows dev 预览 | 打开 `3811403844` 的预览，鼠标在画面上来回移动；属性里切换「底色2」、斜线、粒子的开关 | 不退回预览图；斜线跟着光标走，斜线两侧是两张不同的原图；切换开关后遮罩跟着变 | 屏外宿主渲染 `unsupported` 为空、画面正常，没在实时预览里看 |
| [x] | Q16 走查 3811403844 与组里图像层的 MVP | Windows dev + WPE 抓帧 | 复制工程 `ignore/p8/s7/iso-dg`（「蒙版」组整棵子树 + 读它的底图 22、95，斜线跟光标的脚本保留），WPE 窗口里按同一条光标轨迹录三段（默认、「白/蓝」、再开「白/灰」）各 5 帧，Kabegame 按日志的帧时间与光标、跑脚本回放比；改前改后各比一次；P5b 的组工程（`p5b-grp-cb1` / `cb0` / `nofx` / `nofx0` / `par` / `nest`）与 `p8-depgroup` 回归 | 遮罩 RT 和 WPE 0 差异，斜线的 MVP 逐位相同；剩下的差异都能归到已知的着色器舍入；组工程不比以前差 | 2026-11-20 Claude：改前斜线边缘因组里 MVP 的平移差 1 ulp 翻转（最大差 254 / 12 / 4）；照 WPE 先并进组的逆再乘投影后三段最大差 2 / 1 / 4，全是 foliagesway 舍入（第三段经两个 pulse ×2 ×2）；组工程差 1 的像素略少、`nofx` / `nofx0` / `p8-depgroup` 仍 0 差异 |

## 场景壁纸 P5c：静态网格（mdl 模型对象）

2026-11-13 Windows dev。P5c 分 3 步加收尾：
- 步骤 0：自写 mdl 编码器生成确定性工程，实测核对读码；
- 1 编译：翻译器给顶点属性标 `unused`，mdl 解析器（v4–v23），模型图层 `layer.model`（按 `skin` 选材质、模型 pass 的深度 / 剔除照 WPE 缺省、网格排序），`object:model` 拆成细分键；
- 2 绘制：按 mdl 格式与属性语义建顶点布局、占位属性、索引缓冲、模型 pass 的背面剔除、视锥剔除，模型的 `g_Color4` 等固定 1，`g_NormalModelMatrix` 全局改成 WPE 的算法；
- 收尾：按语料统计走查「未实测清单」，写文档。

解锁 retro（WPE 自带）。别的模型场景都是透视场景（归 P5d）或还缺反射、音频频谱、相机对象等。说明见 `cocs/wpe/WPE_SCENE.md`「静态网格（P5c）」；每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase5/phase-5c-mesh.md`「实施记录」「P5c 收尾」，实测结论见同目录 `p5-REPORT.md`「P5c 语义的实测核对」。

验收工具在 `ignore/p5/`：
- mdl 编码器 `c0/mdl_enc.py`，确定性工程由 `c0/gen_c.py` 生成，放在 `proj/p5c-*`；
- 各步的快照、补丁、变异清单、语料比较与整帧比对在 `c1/`、`c2/`，收尾的语料统计在 `c3/`；
- WPE 参照在 `A:\p5c\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C0 单测与检查 | Windows | 每步：子代理在 HEAD 快照里跑 tsc、vitest、Prettier（步骤 1 另跑 `cargo test -p wpesl2wgsl`）；Claude 在快照与合并后的树上复跑（带 `KABEGAME_WPE_ROOT`） | 0 error；全过 | 2026-11-13 Claude：步骤 1 翻译器 `--lib` 82 全过，提交树 tsc 0、vitest 2200 过 / 1 败；步骤 2 合并树 tsc 0、vitest 2319 过 / 1 败。失败的都是 `pipeline.test.ts` 的 `3830255100: 219 次请求`，HEAD 上同样失败，与本节无关；Prettier 过 |
| [x] | C1 读码 · 实测核对 | WPE 抓帧（1920×1080 窗口，视锥剔除的补测 1600×900，retro 2520×1080） | 12 个确定性工程 `p5c-*` 加 retro；`rdc_dump_c.py` 导出每次绘制的输入布局、顶点 / 索引、深度与光栅状态、混合与常量 | 读码结论逐条成立，或写明推翻处 | 2026-11-13：读码结论全部成立，推翻一处：`skin` 为负数时取 0，不是最后一项。读码标了未知的几处测清了：着色器声明了网格没有的属性，只有读了才出问题；网格排序是 MSVC 的 `std::sort`，≤ 32 个时等于稳定；正交场景里视锥剔除生效；`g_NormalModelMatrix` 要照搬快速倒数平方根才逐位对上 |
| [x] | C2 翻译器 · 属性的 `unused` | Node + cargo | `cargo test -p wpesl2wgsl --lib`；改动前后各导出一次语料的 WGSL / GLSL（`WPESL2WGSL_DUMP_DIR`）逐字节比较 | 输出不变，只多反射字段 | 2026-11-13：82 全过；3740 个文件逐字节相同。手工变异 2 处（去掉指针链回溯、把 `Store` 也算读）都检出，指针链那处是补了用例后才检出的 |
| [x] | C3 确定性工程 · 和 WPE 比 | Windows dev 屏外宿主 + WPE 抓帧 | `p5c-layout`、`p5c-attr-ok`、`p5c-ver`、`p5c-color`、`p5c-skin`、`p5c-matrix`（及 `-par`、`-zoom`）、`p5c-order-ok`、`p5c-cull` 按 WPE 日志回放到抓到的那一帧，`kbp cmp frame --kbp-layers` 排除 FR / CLK 后整帧比 | 逐像素一致 | 2026-11-13：10 个全部 0 差异。`-ok` 两个是去掉了编译期会退回的对象（读了缺的属性、alphatocoverage）的版本，另抓了 WPE 帧 |
| [x] | C4 视锥剔除 | 同 C3，WPE 窗口 1600×900 | `p5c-frustum3` 十个包围盒（场景外、z 超出深度范围、跨边缘、外接球伸进来、扁盒够不到等）整帧比 | 剔掉的与画了的和 WPE 相同 | 2026-11-13：画了 F2、F3、F4、F6、F8、F9，剔掉 F1、F5、F7、F10，和 WPE 相同；只有画了的方块边缘有差（我们按 1920×1080 画再缩到 1600×900） |
| [x] | C5 retro | 同 C3，WPE 窗口 2520×1080 | `kbp content unpack --instrument` 解包加日志，WPE 抓帧，Kabegame 按日志的帧时间与逐帧光标回放到第 199 帧，整帧比 | 差 ≤ 2 | 2026-11-13：整帧最大差 1，1171 个像素差 1 |
| [x] | C6 变异检查 | Node | `kbp mutate` 逐处改坏实现，跑相关单测 | 每处都有用例失败，源码原样还原 | 2026-11-13：步骤 1 18 处、步骤 2 14 处全部检出，还原后整树哈希一致 |
| [x] | C7 语料变化 | Node | 每步前后重扫 `unsupported`（`kbp corpus diff`，两边用同一份翻译器 wasm） | 只有模型场景变化，原来能渲染的场景不掉出 | 2026-11-13：步骤 1 去掉 `object:model` 13 张、`object:reflected` 2、`object:skin` 1，换成过渡键 `model:pending` 13 与细分键（`depthwrite:enabled` 9 归 P5d，模型材质进编译后冒出的反射、音频频谱、遗留灯等）；步骤 2 去掉 `model:pending`，能渲染 47 → 48（合到 `ff4ad0e3` 上 48 → 49），新解锁 retro；没有场景掉出，不带模型的场景逐张相同 |
| [x] | C8 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 和之前的基线相同 | 2026-11-13：步骤 2 合并前后 30 组都相同。步骤 1 没做（渲染器没改，当时 dev 没在跑）。法线矩阵是全局改的，另查过语料里能渲染的场景没有打开 `LIGHTING` 的图像层，所以对现有画面中性 |
| [x] | C9 未实测清单走查 | Node 语料统计 | `ignore/p5/c3/walk_c.py` 统计各项在语料里出现几次 | 能渲染的场景不受影响，或写明差异 | 2026-11-13：视差、抖动下的视锥平面：正交的模型场景只有 retro（mdl 没有包围盒，不剔；视差、抖动都没开）和 3354366708（都关，还差 11 项），没有受影响的；组合层里的模型、`mdl:framebuffer` 等照报的键在语料里都是 0 个。记入文档的「已知差异与只记不补」 |
| [x] | C10 预览 · retro | Windows，图库预览 | 打开 WPE 自带的 retro 的预览 | 实时渲染、不退回预览图；背景和各图层和 WPE 一致 | 2026-11-13 用户确认没有问题。屏外宿主的渲染和 WPE 比过（C5） |
| [ ] | C11 桌面 · retro | Windows，窗口模式 | 把 retro 设为桌面壁纸 | 和预览一致 | 待用户确认 |

## 场景壁纸 P5b：图像模型标志（组合层、fullscreen、instanced、透视图层等）

2026-11-12 Windows dev。P5b 分 6 步加收尾：
- 步骤 0：确定性工程实测核对读码；
- 1 尺寸来源（`autosize` / 模型宽高 / `size` 的顺序）、UV 内缩（`nopadding`）、图像层 `perspective`；
- 2 组合层（无子层）与 `projectlayer`，3 `fullscreen`，4 带子层的组合层（组），5 `instanced`（纯色图层）；
- 收尾：按语料统计走查各步的「未实测清单」，写文档。

能渲染的场景解锁 `1923929928`；`1333579536` 需要 P5b 步骤 2 加同期 P4e 的粒子子系统，两者合起来才能渲染。别的用到这些标志的场景大多还缺文本、木偶动画、视频纹理等。说明见 `cocs/wpe/WPE_SCENE.md`「图像模型标志（P5b）」；每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase5/phase-5b-modelflags.md`「实施记录」「P5b 收尾」，实测结论见同目录 `p5-REPORT.md`「P5b 语义的实测核对」。

验收工具在 `ignore/p5/`：
- 确定性工程由 `b0/gen_b.py`（步骤 0）、`b5/gen_b5.py`（`p5b-inst2`）生成；
- 各步的快照、补丁、变异清单、语料比较与整帧比对在 `b1/`–`b5/`；
- WPE 参照在 `A:\p5b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | B0 单测与检查 | Windows | 每步：子代理在 HEAD 快照里跑 tsc、vitest、Prettier；Claude 合并后在工作区复跑（带 `KABEGAME_WPE_ROOT`），并用临时索引导出「HEAD + 本步骤」再跑 | 0 error；全过 | 2026-11-12 Claude：步骤 5 合并后的工作区 tsc 0、vitest 2020 过 / 1 败（`pipeline.test.ts` 的 `3830255100: 219 次请求`，HEAD 上同样失败，与本节无关）；「HEAD `8dcd01aa` + 步骤 5」tsc 0、vitest 1799 过 / 0 败；Prettier 过。各步的数字见子计划 |
| [x] | B1 读码 · 实测核对 | WPE 抓帧（1920×1080 窗口，`_rt_FullFrameBuffer` 另用 1344×756） | 21 个确定性工程 `p5b-*`；`rdc_dump_b.py` 导出每次绘制的 RT 尺寸、混合、写掩码、顶点、UV 与常量 | 读码结论逐条成立，或写明推翻处 | 2026-11-12：流程全部成立。推翻两处：无 effect 带子层的组用透传着色器画世界四边形，不是 composelayer 铺满全屏；`instanced` 的遮罩只在多 pass effect 时变糊。另更正纹理标志 `0x20` 是视频位，不是「未补边」 |
| [x] | B2 尺寸与内缩 · 确定性工程 | Windows dev 屏外宿主 + WPE 抓帧 | `p5b-autosize`、`p5b-nopad-v2` 用 `render_scene` 渲染，`kbp cmp frame` 排除 FR / CLK 后和 WPE 整帧比 | 逐像素一致或差 ≤ 2 | 2026-11-12：`p5b-autosize` 0 差异；`p5b-nopad-v2` 1845 个像素差 1 |
| [x] | B3 透视图层 | 同 B2 | `p5b-persp`、`-fov30`、`-par`、`-zoom` 与平滑纹理的 `p5b-persp-smooth` 整帧比；`1923929928` 解包加日志，按 WPE 日志的帧时间与逐帧光标回放到第 190 帧，缩到 1920×1080 比 | 平滑纹理差 ≤ 2；网格线一致 | 2026-11-12：棋盘纹理的四个变体差异全在被压扁的棋盘格上（采样混叠，正交对照层也有）；`p5b-persp-smooth` 2268 个像素差 1、最大 1。`1923929928` 透视网格的线位、汇聚方向、间距、颜色一致，其余是随机星空粒子与缩放 |
| [x] | B4 组合层（无子层） | 同 B2 | `p5b-cl`（旋转、`copybackground: false`、无 effect 两种、cbm 2）、`p5b-proj` 整帧比；真实样本 `1333579536`、`3825170583`、`3502090109` 按日志回放到抓到的那一帧比组合层区域 | 差 ≤ 2；组合层区域一致 | 2026-11-12：`p5b-cl` 32 个像素差 1，`p5b-proj` 0 差异。`1333579536` 整屏组合层一致；`3825170583` 经过组合层的人物、翅膀、背景一致，差异来自没画的 `shape` 对象与随机粒子；`3502090109` 另有 `cull:normal`、音频频谱两项不支持 |
| [x] | B5 fullscreen | 同 B2 | `p5b-fs`、`p5b-fsnofx`、`p5b-fsmvp` 整帧比；`dino_run` 并排看 | 差 ≤ 2 | 2026-11-12：第一次真机渲染整帧全黑，查明快照纹理缺 `COPY_SRC`、拷进合成 RT 的命令被丢掉，补上并让单测的假设备校验拷贝用途。之后 `p5b-fs` 最大差 1，另两个 0 差异；`dino_run` 背景、月亮、云、山、树林、草地与整屏后处理一致，差在脚本动态创建的游戏内容（不支持） |
| [x] | B6 组（带子层的组合层） | 同 B2 | `p5b-grp-cb1`、`cb0`、`nofx`、`nofx0`、`par`、`p5b-nest`、`p5b-grpptc` 整帧比；真实样本 `3340707146`、`3554161528` 按日志回放并排看 | 差 ≤ 2；子层位置一致 | 2026-11-12：前 6 个最大差 1，`p5b-grpptc`（本地 / 世界空间粒子 + 带 effect 的子层）最大差 2。`3340707146` 28 个子层的人物组位置和形状一致，差在文本、随机花瓣和摆动相位；`3554161528` 天空里组的星星粒子与构图一致 |
| [x] | B7 instanced | 同 B2 | `p5b-inst`、`p5b-inst2`（instanced + 两 pass 遮罩、对照组、`instance.textures` 换补边纹理）整帧比；`3810092560` 按日志回放到第 273 帧，缩到 1920×1080 比 | 0 差异；纯色背景一致 | 2026-11-12：两个工程都是 0 差异，J1 的遮罩按 32×32 变糊、和 WPE 一样。`p5b-inst2` 第一版的中间 pass 乘了 MVP，在 WPE 里缩成不到一个像素（effect 中间 pass 矩阵的已知差异，归 P7d），改成不乘 MVP 后重抓。`3810092560` 差异只在细线条边缘（缩放与 waterwaves 采样），白色背景露出处 0 差异 |
| [x] | B8 变异检查 | Node | 每步 `kbp mutate` 逐处改坏实现，跑相关单测 | 每处都有用例失败，源码原样还原 | 2026-11-12：步骤 1 8 处、2 9 处、3 8 处（含后补的快照 `COPY_SRC`）、4 8 处、5 8 处，全部检出 |
| [x] | B9 语料变化 | Node | 每步前后重扫 `unsupported`（`kbp corpus diff`） | 只在对应键上变化，原来能渲染的场景不掉出 | 2026-11-12：去掉 `model:nopadding` 40 张、`object:perspective` 5、`model:passthrough` 68、`model:projectlayer` 12、`model:fullscreen` 27、`model:instanced` 30、`object:instance` 30；新增 `model:passthrough:children:framebuffer` 1（`3465215190`）、`material:usertextures` 9（instance 带用户纹理）。步骤 1 解锁 `1923929928`，其余各步能渲染的数量不变，没有场景掉出 |
| [x] | B10 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 和之前的基线相同 | 2026-11-12：步骤 1–5 每步合并前后 30 组都相同 |
| [x] | B11 未实测清单走查 | Node 语料统计 | `ignore/p5/b5/walk_scan.py` 统计各步「未实测清单」的用法在语料里出现几次 | 能渲染的场景不受影响，或写明差异 | 2026-11-12：只有一项落在能渲染的场景上：`1923929928` 透视网格的三个 effect 各 1 个 pass，前两个是「非最后一个 effect」（WPE 的 MVP 也是 `ortho(±1)`），最后一个是上屏，没有差异。其余在语料里 0 个，或只出现在还有 20 项以上别的不支持项的场景里，记入文档的「已知差异与只记不补」 |
| [ ] | B12 预览 · `1923929928` | Windows，图库预览 | 打开创意工坊 `1923929928` 的预览 | 实时渲染、不退回预览图；透视网格向远处汇聚并滚动，和 WPE 一致 | 待用户确认。屏外宿主的渲染和 WPE 比过（B3） |
| [ ] | B13 预览 · `1333579536` | Windows，图库预览 | 打开创意工坊 `1333579536` 的预览 | 实时渲染；整屏组合层的效果和 WPE 一致 | 待用户确认。需要 P4e 的粒子子系统一起 |
| [ ] | B14 桌面 | Windows，窗口模式 | 把 B12、B13 的场景各设为桌面壁纸 | 和预览一致 | 待用户确认 |

## 场景壁纸 P6b 1e：动态文字

2026-11-13 Windows dev。文本对象的文字在运行中变，不整场重编译。1e 分三步：
- 1e-1 字符串写回与状态：12 个运行中字段（`TEXT_RUNTIME_FIELDS`）的文本目标、`text/fields.ts` 的两套取值规则、`SceneState.textFields` / `writeText` / `dirtyTexts`；
- 1e-2 重排与重建：`SceneTexts.relayouter()`、`GpuScene.syncTexts`、整层强制重建、独占合成 RT 与 fbo、图集扩容与重置连带、变体预备、`textStats`；`compileText` 的运行中字段绑属性改登记文本目标；`max(4, ·)` 更正；
- 1e-3 能力表去掉 `text:script`；dev 探针的 `scriptValues` 收文本字段的字符串、回放前结清重排；vite REST 同步放宽。

说明见 `cocs/wpe/WPE_SCENE.md`「文本对象」；计划与各步实施记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1e」。验收文件在 `ignore/p6/b1e/`，测试工程 `p6b-tiny`、`p6b-tiny2`、`p6b-tiny3`、`p6b-user` 在 `ignore/p6/b1e/proj/`，`p6b-script` 在 `ignore/p6/b0/proj/`，WPE 参照在 `A:\p6b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | E1 类型与格式 | Windows | 宿主 `tsc --noEmit`；vite 插件 `deno check`；Prettier `--check` 本步改动的 TS 文件 | 0 error、格式通过 | 2026-11-13 子代理（1e-3 快照）：宿主 tsc 0 error，`replay.ts` 等 4 个文件 `deno check` 通过，14 个 TS 文件 Prettier 通过。Claude 复跑：快照 tsc 0 error；合进工作区后的工作区快照（`ignore/p6/b1e/w3`）tsc 0 error |
| [x] | E2 宿主 vitest | Node，vitest | 带 `KABEGAME_WPE_ROOT` 跑全部；另把 `wpefont.wasm` 放进去跑文本测试 | 本节的用例全过；只有已知的语料请求次数那一条失败 | 2026-11-13 子代理（1e-3 快照，没有 wasm）：115 个文件 2785 条，2742 过、1 失败、42 跳过；基线 113 个文件 2767 条，2725 过、1 失败、41 跳过。放进 `wpefont.wasm` 后 2795 条，2794 过、1 失败。Claude 复跑（放进 wasm）：2795 条，2794 过、1 失败，相同。失败的是同一条 `pipeline.test.ts`，但 1e-3 多一项：`3413921910` 的快速路径从 4 次请求变成 335 次（去掉 `text:script` 后要编到更后面才遇到 `combo:REFLECTION` / `material:alphawriting`），基线只有 `3830255100` 一项 |
| [x] | E3 vite 插件测试 | Deno | `deno test -A --no-check scripts/kabegame-dev/` | 全过 | 2026-11-13 子代理（快照）：26 passed（119 steps），基线 117 steps。Claude 复跑相同 |
| [x] | E4 变异检查 | Node / Deno，快照 | 1e-1 16 处、1e-2 22 处；1e-3 宿主 15 处（`ignore/p6/b1e/mutate3.json`）、vite 插件 5 处（`mutate3x.py`），另 Claude 4 处（`mutate3-claude.json`） | 每处都有用例失败，按原字节还原 | 2026-11-13 子代理：1e-3 宿主 15 处（`kbp mutate` 快照模式，快照里临时放进 `wpefont.wasm`）、vite 插件 5 处全部检出，整树哈希前后一致。Claude 另测 4 处（`wroteTextValues` 恒为假、结清上限差一、结清先等字体再 `sync`、探针规整时跳过 `scriptWriteValue`），全部检出、还原一致 |
| [x] | E5 语料编译 | Node，`kbp corpus scan` / `diff` | HEAD 快照与 1e-3 快照各扫一次（固定同一份场景清单） | 只有 `text:script` 与 `text:script:maxwidth` 消失；解锁 9 张 | 2026-11-13 子代理：183 张，干净 66 → 75；1e-2 那份 173 张为 57 → 66。解锁 `2304304373`、`2391389126`、`2903412088`、`3813887347`、`3819179413`、`3824424509`、`3825103811`、`3826727460`、`3836725625`；`text:script` 去掉 88 张、`text:script:maxwidth` 6 张，没有新增的键 |
| [x] | E6 时钟走动 | Windows dev，图库预览 | 打开 `2391389126`、`2304304373` 的预览，看一两分钟 | 时钟按秒 / 分走，和系统时间一致；应用日志没有脚本错误、WebGPU 错误或 `text:engine` | 2026-11-13 Claude（宿主产物重建，工坊场景经 `kbp content unpack` 解包后导入）：两张都显示当前时间；`2304304373` 的 5 个时钟层跨整分时在同一次 `sync` 里从 21:44 换成 21:45；应用日志没有 WebGPU 错误与 `text:engine` |
| [x] | E7 探针按字符串渲染 · `p6b-script` | Windows dev，屏外宿主（REST `/hosts/:h/render`） | s1 由 `scriptValues: [{ object: "s1", field: "text", value: "F183" }]` 渲染，只比 s1 所在区域；对照 WPE 第 182 帧（`A:\p6b\p6b-script\`，`kbp rdc frame --present` 导出上屏图） | 逐像素相同；`meta.scriptValues[0].applied` 为真，`meta.textSyncs` ≥ 1 | 2026-11-13 Claude：s1 区域 `[700, 1220) × [180, 430)` 和 WPE 0 差异，`applied` 为真、`textSyncs` 1；不给文本值时同一区域 10628 个像素不同（对照组），结果里没有 `textSyncs`。另给「你好😀F7」：`textSyncs` 8（等了 7 轮回退字体），中文与彩色 emoji 都画出来了；给没挂字段脚本的 `pointsize` 回 422 并说明原因 |
| [x] | E8 探针按字符串渲染 · 真实时钟 | Windows dev | WPE 抓 `2391389126` 一帧、读出画的时间字符串，探针按它渲染，比文字区域 | 文字区域逐像素相同 | 2026-11-13 Claude：WPE 窗口 3840×2130（系统把客户区限到这么大，fill 的缩放仍是 1，`A:\p6b\e3-2391389126-4k\`），画的是「21:33」，探针按它渲染、画布同尺寸：文字区域 `[0, 700) × [0, 220)` 0 差异。人物图层有随时间变的 effect，和 WPE 的时刻不同，那一块不比。1600×900 窗口下文字区域差 805 个像素：WPE 按窗口分辨率直接画字形，我们先按场景分辨率画再缩，是已知的上屏差异 |
| [x] | E9 属性改文字 / 字号不重编译 | Windows dev，图库预览 | `2304304373` 在属性面板改 `textinput` 与 `pointsize` | 画面跟着变；`host.stats().recompiled` 不增加、`applied` 增加 | 2026-11-13 Claude：经 `set_wpe_web_user_properties`（属性面板同一条命令）把 `yourname` 改成「Kabegame 你好」、`textsize` 65 → 90：`applied` 加 1，`recompiled` 为空，第 6 层 11 个字形、90 号，截图画面正确 |
| [x] | E10 空 ↔ 非空、第一次出现 emoji | Windows dev，图库预览 | `p6b-user` 的 `msg` 依次改成「Hello world」→ 空 →「Ab😀」（字号 32 → 64）→「你好 Ab」 | 空排版不画、再变非空正常；第一次出现彩色字形不报 `render:variant-missing`；每次的画面和用新属性整场编译相同 | 2026-11-13 1e-2 复核（Claude）测过；1e-3 没改重排与渲染代码，没重测 |
| [x] | E11 合成 RT 换尺寸 | Windows dev，图库预览 | `2304304373` 带 `blurprecise` 的时钟换宽度时看 `host.texts()` | `compositeSize` 跟着变、effect 画面不错位；没有显存一直增长 | 2026-11-13 Claude：跨整分时合成 RT 宽度跟着文字变（直接上屏的 3 层 632 → 636，带 `blurprecise` 的 2 层 734 → 738），重建 5 层，`recompiled` 为空；fbo 换尺寸由单测覆盖。显存没长时间观察 |
| [x] | E12 缺字体补上 | Windows dev，图库预览 | 改成带中文的文字（第一次用到回退字体） | 一两帧内（不到 1 秒）补上中文，中间照画旧文字；没有报错 | 2026-11-13 Claude：`2304304373` 改成「Kabegame 你好」后等了 8 轮回退字体（`texts().stats.waiting`），2.5 秒内读回时已经补上；最长一次重排 16.3 ms（90 号中文第一次栅格化）。1e-2 复核：`p6b-user` 5 轮不到 0.7 秒 |
| [x] | E13 `max(4, ·)` 三个工程 | Windows dev，屏外宿主（`render_scene`，1920×1080） | `p6b-tiny`、`p6b-tiny2`、`p6b-tiny3` 渲染后 `kbp cmp frame --meta` 对 WPE 上屏整帧（`A:\p6b\p6b-tiny*\`） | 逐像素相同 | 2026-11-13 1e-2 复核（Claude）：三个最大差 0；1e-3 没改渲染代码，没重测 |
| [x] | E14 9 张解锁场景 | Windows dev，图库预览；WPE 抓帧 | 每张都在预览里跑；`2903412088`（带 effect）与 `3836725625`（带 effect、有父对象）和 WPE 抓帧逐区域比，其余几张看实时状态；`3824424509` 确认能渲染、时钟走 | 时钟走；比的区域逐像素相同或只差几级；`3824424509` 的日历停在初值（已知差异，步骤 2） | 2026-11-13 Claude：9 张都实时渲染，文字是当前时间，`recompiled` 为空。`2903412088`：取抓帧里 effect 的 `g_Time`（12.798…）、按属性缺省算 `origin`，字形内部和 WPE 相同，边缘最大差 19；背景随时间在动，没有文字的区域也处处差（最大 12），边缘差来自背景；宿主实时算出的 `origin` 和交给探针的相同。`3836725625`：背景是视频、文字的 effect 是模糊（与时间无关），像素不比。当时记成「三层文字的排版和 WPE 一致」，这是错的：用户真机上看出字被纵向拉长，复制工程只留文字后定位到父对象 `scale` 绑滑块不铺满（E17），修复后复制工程和 WPE 整帧 0 差异；WPE 画的 Date 是 11 个字形「13 NOV 2026」，我们宿主的脚本也算出这一串。`3824424509`：时钟带秒在走，日历脚本（`objects/8/visible`）把 `getLayer` 拿到的图层对象再传给 `getLayer`，我们返回 null，`update` 抛错后被禁用，日历的文字与颜色停在初值（步骤 2）。`3825103811` 的时钟层按属性缺省隐藏，同工程设置 |
| [x] | E15 每帧变的文字耗时 | Windows dev，图库预览 | `p6b-script` 的 s1（`'F' + n`，每帧变）实时跑，`host.texts()` 看重排与重建用时 | 每帧重排 + 重建在几毫秒以内，帧率不明显下降 | 2026-11-13 Claude：10 秒 600 帧（F728 → F1328），每帧重排平均 0.07 ms（最长 0.5 ms）、重建平均 0.23 ms（最长 0.8 ms），整帧 0.56–0.63 ms，没有等字体、没有重编译 |
| [ ] | E16 桌面 | Windows，窗口模式 | 把一张解锁的时钟场景设为桌面壁纸；暂停 / 恢复壁纸 | 桌面上时钟走；暂停时停、恢复后跟上 | 未测（不想改用户的桌面壁纸；1d 的 T11 同样没测） |
| [x] | E17 图层向量字段绑标量属性（复核时修的） | Windows dev，屏外宿主；WPE 抓帧 | `3836725625` 的复制工程只留三层文字（`ignore/p6/b1e/make_e3text.mjs`：静态字符串 `e3text-s`、脚本返回同一串 `e3text-r`，父对象 `scale` 仍绑滑块 `clocksize` 0.72），WPE 3840×2130 窗口抓帧（`A:\p6b\e3text-s\`、`A:\p6b\e3text-r\`），探针同尺寸渲染整帧比；单测 `compile/layerVector.test.ts` | 整帧逐像素相同；`origin` / `scale` / `color` / `parallaxDepth` 绑数字时铺满各分量、写不进时留 JSON 的 `value`，就地写 = 重编译 | 2026-11-13 Claude：修复前两版都差 15631 个像素（y 方向拉长 1 / 0.72 倍，父对象 `scale` 是 `[0.72]`）；修复后两版都是 0 差异。单测 7 条；工作区快照 vitest 2917 条过 2916 条（只有 `pipeline.test.ts` 那一条，失败明细和修复前相同） |

## 场景壁纸 P6b 1d：静态文本的编译与渲染

2026-11-12 Windows dev。文本对象作为图层进场景：编译期 `compile/texts.ts` 规整字段、定位主字体、编 WPE 自带的四个字体材质；宿主 `text/host.ts` 的 `SceneTexts` 在建 GPU 资源前排好全部文本层；渲染图新增 `text` 步骤（直接上屏「背景 → 字形 → 彩色字形」，合成路径先清成背景色或 clearalpha 再画字形，之后 effect 链照图像层），矩阵 `textMatrices`，字形图集是运行时纹理（`render/text.ts`）。能力表不再报 `object:text` 与各文本键，改报 `text:script`、`text:script:<键>`、`text:msdf:<键>`、`text:anchor:<值>`。文字随脚本或属性变化是 1e。dev 探针 `renderFrame` 也排文本（`dev/probeTexts.ts`）。验收文件在 `ignore/p6/b1d/`，WPE 真值在 `ignore/p6/b0/out/frames/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 类型与格式 | Windows | 宿主 `tsc --noEmit`；Prettier `--check` 本步涉及的 19 个文件 | 0 error、格式通过 | 2026-11-12 Claude：通过 |
| [x] | T2 文本单测 | Node，vitest | `apps/wpe-scene` 下带 `KABEGAME_WPE_ROOT` 跑 `src/render/text.test.ts src/compile/texts.test.ts src/text/` | 全过 | 2026-11-12 Claude：6 个文件 74 passed（真 wasm、真翻译器编 WPE 的 `font` / `flat` / `composelayer` 材质） |
| [x] | T3 整个宿主 vitest | Node，vitest | 工作区带 `KABEGAME_WPE_ROOT` 跑全部 | 本步的用例全过 | 2026-11-12 Claude：89 个文件 2191 passed、6 failed，都和本步无关：`compile/conditions.test.ts` 4 个（别的会话进行中的 P7d，不含本步的工作区同样失败）、`host.test.ts` 1 个（P4e 步骤 4 给 `host.audio()` 加的 `raw` 字段）、`compile/pipeline.test.ts` 的语料请求次数（1b 时就在） |
| [x] | T4 变异检查 | Node，快照 | 子代理 10 处（`ignore/p6/b1d/mutate.cjs`）；Claude 另 12 处：直接上屏字形与彩色字形对调、彩色图集引用、偏移 x / y 对调、RT 正交上下翻、LDR 也乘背景亮度、开背景不清屏、空 `text` 不算文本对象、uint16 上限、枚举回退、`{value}` 取值、`maxrows` 取整、背景四边形用图层尺寸 | 每处都有用例失败 | 2026-11-12 Claude：22 处全部检出；Claude 那 12 处里原先漏 2 处（uint16 上限、背景四边形尺寸），补了用例（`textIndexData` 边界、背景层文字框带小数）后检出 |
| [x] | T5 和 WPE 整帧比 | Windows dev，屏外宿主（`render_scene`，1920×1080） | 导入 `p6b-geom`、`p6b-align`、`p6b-wrap`、`p6b-fx`、`p6b-fallback`、`p6b-extra`，渲染后 `kbp cmp frame --meta` 对 WPE 上屏整帧 | 排除 FR / CLK 后逐像素相同 | 2026-11-12 Claude：五个最大差 0；`p6b-fx` 1 个像素差 1。不排除 FR / CLK 时差异只在右下角 9600 像素。覆盖直接上屏、合成（effect、清成背景色、clearalpha）、背景、CJK 回退、彩色 emoji |
| [x] | T6 宿主实际加载 | Windows dev，`host_open` 屏外宿主 | 宿主按产品路径（`reload` → `renderer.load(texts)`）加载 `p6b-fx`，`host.renderFrame(1.5)`；遮掉右下角（x ≥ 1600、y ≥ 960）后的哈希与 T5 的探针渲染图同样处理后的哈希比 | 相同 | 2026-11-12 Claude：相同；应用日志只有工程里没有的资源的 `deny file: … NotFound`（查找顺序，图像层同样），没有 WebGPU 错误或 `text:engine` |
| [x] | T7 语料编译 | Node，`kbp corpus scan` / `diff` | HEAD 快照与本步快照各扫一次 | 只在文本相关的键上变化，干净场景不掉 | 2026-11-12 子代理：173 张，干净 47 → 47，解锁 0；变化的 92 张都是文本场景，新增 `text:script` 87、`text:script:maxwidth` 6、`text:anchor:*` 5、`text:msdf:*` 3；文本层上的 effect 现在照编，带出 `uniform:g_AudioSpectrum16*` 4 张等（这些场景本来就不干净） |
| [x] | T8 语料排版 | Node，真 wasm | `ignore/p6/b1d/layoutscan/`：92 张文本场景编译后跑 `SceneTexts.prepare`（同宿主，系统字体读 `C:\Windows\Fonts`） | 全部排版成功 | 2026-11-12 Claude：92 张全部成功、没有告警，981 层、8476 个字形，中位 5 ms、最慢 189 ms；46 层排版为空；3 张主字体找不到、退回 arial（2 张工程里确实没有；`2887099508` 的 pkg 条目名像是 GBK 编码，WPE 能否找到没查） |
| [x] | T9 字体引擎缺失 | Node，vitest | `text/host.test.ts`：引擎给 null | 抛 `text:engine`，宿主退回预览图 | 2026-11-12 Claude：单测通过；真机没挪走 wasm 测 |
| [ ] | T10 改背景色属性 | Windows dev | `backgroundcolor` 绑属性的文本场景，在属性面板改颜色 | 就地生效、不重编译；HDR 且亮度不为 1 时重编译 | 未测：测试工程里没有绑属性的背景色 |
| [ ] | T11 预览与桌面 | Windows，图库预览 / 窗口模式 | 把一张只有静态文字的场景打开预览、设为桌面 | 实时渲染，和 T5 一致 | 未测：语料里没有只差静态文字的场景（只剩 `text:script` 的 3 张要 1e） |
| [x] | T12 1d2 系统字体按平台解析（Rust 单测） | Windows，`cargo test`（`CARGO_TARGET_DIR=target-check`） | `test-kabegame` 跑 `kabegame --lib wpe_scene`：三张表恰好 13 个名字、Unix 候选是绝对路径、取第一个存在的候选、彩色 emoji 不给替代、放行项与交给宿主的表一致、Windows 名字不分大小写、真实 `%WINDIR%\Fonts` 只出该目录下的文件 | 全过 | 2026-11-13 Claude：17 passed（`wpe_scene_host` 15 个、`commands::wpe_scene` 2 个）；`#[cfg(unix)]` 的符号链接用例在 Windows 上不编译、没跑 |
| [x] | T13 1d2 宿主按表读系统字体（单测） | Node，vitest | `text/host.test.ts`：有表时按表读（键是 `system:` 后面的名字原样）；表里没有的名字、空表返回 null，不读 `C:\Windows\Fonts` 或 `fontsDir`；没表时按 `fontsDir`、缺省 `C:\Windows\Fonts` | 全过 | 2026-11-13 Claude：`src/text src/render/text.test.ts src/compile/texts.test.ts` 6 个文件 77 passed；宿主 `tsc --noEmit` 0 error |
| [ ] | T14 1d2 macOS 系统字体 | macOS dev | `wpe_scene_target` 返回的 `systemFonts`；打开 `p6b-geom`、`p6b-fallback`（`systemfont_*`、CJK 与 emoji 回退）的预览 | 表里只有本机存在的文件、路径和 `MACOS_SYSTEM_FONTS` 的候选一致；文字画出来、没有 `deny file:`；emoji 走 Twemoji | 未测：`TODO:[WPE_SCENE]`，候选路径没在真机核对 |
| [ ] | T15 1d2 Linux 系统字体 | Linux dev（Debian / Ubuntu、Fedora、Arch 至少一种） | 同 T14，对照 `LINUX_SYSTEM_FONTS` | 同 T14；msttcorefonts 的小写符号链接被跳过、取首字母大写的文件 | 未测：`TODO:[WPE_SCENE]`，Linux 没有窗口壁纸模式，只能看预览 |
| [x] | T16 1d2 Windows 真机 | Windows dev（后端与宿主都重建过） | 导入 `p6b-fallback`，`invoke wpe_scene_target`；`host_open` 按产品路径加载后 `host.renderFrame(1.5)`，遮掉右下角的哈希与 1d 的渲染图比 | 表里是 `%WINDIR%\Fonts` 下本机有的字体；画面与 1d 相同 | 2026-11-13 Claude：返回 12 项（本机没装 `arialuni.ttf`，不在表里），应用日志「解析到 12 个，本机没有 ["arialuni.ttf"]」；遮罩哈希与整帧哈希都和 1d 相同；测完移除了测试行 |

## 场景壁纸 P6b 1c：文本的字体回退、排版与图集

2026-11-12 Windows。场景宿主新增 `apps/wpe-scene/src/text/`（纯 TS、不碰 GPU，还没有调用方，文本对象照旧退回预览图）：`fonts.ts`（按「字体 + 字号」的 face 列表与 WPE 回退链、逐码点分段）、`layout.ts`（照 `FUN_1401b0410` 排版：分行、断行、省略号、两端对齐、行内对齐、文字框、对齐偏移、图层与合成 RT 尺寸）、`atlas.ts`（逐行移植 `FUN_1401ae080` 的装箱器）、`mesh.ts`。`wpefont` 加导出 `wpefont_glyph_box`（WPE 取框的 `FT_LOAD_NO_BITMAP` 轮廓框，TS `WpefontFace.box`），`wpefont_glyph` 回到 6 个 int。基线 `src/text/fixtures/p6b.json` 由 `apps/wpe-scene/scripts/fixtures/make_text_fixture.py` 从 WPE 抓帧生成。计划见 `.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1c」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 构建 | Windows，LLVM clang 22.1.6 | `deno task build:wpefont`，产物拷到 `apps/wpe-scene/src/wpefont/` | 编译链接成功、导出多一个 `wpefont_glyph_box`、WASI 导入不变 | 2026-11-12 Claude：产物 1,850,248 字节，WASI 导入 13 个 |
| [x] | T2 位图不变 | Node 26 | `ignore/p6/b1c/work/harness.mjs`（1b harness 改成新接口）跑 `p6b-geom/align/fx/fallback/extra`，`ignore/p6/b1a/compare.py` 对 `ignore/p6/b1a/out/ft2.14.3/wasm-b.json` | 字段不同：无 | 2026-11-12 Claude：38 个对象、342 个字形，字段不同：无，整数步进不同 0；新框与位图框只在 Segoe UI Emoji 的 😀 上不同 |
| [x] | T3 排版与图集和 WPE 逐坐标、逐字节相同 | Node，vitest | `apps/wpe-scene` 下 `KABEGAME_WPE_ROOT=<WPE> node ../../node_modules/vitest/vitest.mjs run src/text src/wpefont` | 44 个对象的四边形（排版坐标与 UV）、排版原点、图层 size / 背景、合成 RT 尺寸全部相同；21 张图集（含 1 张彩色）像素 SHA-256 相同 | 2026-11-12 Claude：4 个文件 34 passed（text 20、wpefont 14）。opensticks「2」那 1 个像素也对上 |
| [x] | T4 基线确实在比 | Node，vitest | 逐条改坏后跑 T3：差一判定改成 `w + 1`、去掉下一行清零、BGRA 不交换、纵向居中不乘 0.5、关掉两端对齐 | 每条都有工程失败 | 2026-11-12 Claude：分别挂 `p6b-extra`、`p6b-extra`、`p6b-fallback`、六个工程全挂、`p6b-wrap`；改回后全过。右一列绕回清零、行末空格撑右沿、省略号量宽阈值这三处改坏后基线仍过（抓帧覆盖不到），前两处另由 `atlas.test.ts` / `layout.test.ts` 的读码用例钉住 |
| [x] | T5 不带 WPE 目录 | Node，vitest | 不设 `KABEGAME_WPE_ROOT` 跑 T3 的命令 | 只剩不读字体的用例 | 2026-11-12 Claude：10 passed、24 skipped |
| [x] | T6 基线可复现 | Windows，Python 3 标准库 | `make_text_fixture.py --out <临时>`，Prettier（`--config .prettierrc.json --ignore-path <空文件>`）后 `cmp` 仓库里的 `p6b.json` | 逐字节相同 | 2026-11-12 Claude：相同；PNG 解码另用 PIL 核对 21 张图集的哈希，全同 |
| [x] | T7 类型与格式 | Windows | 宿主 `tsc --noEmit`、Prettier `--check src/text src/wpefont`、`deno fmt --check scripts/build-wpefont.ts` | 本步的文件 0 error、格式通过 | 2026-11-12 Claude：本步 0 error；同轮另有 1 个错误在别的会话正改的 `src/render/events.test.ts`（`SceneLayer` 缺 `group` 等字段），与本步无关 |
| [x] | T8 整个宿主 vitest | Node，vitest | `apps/wpe-scene` 下带 `KABEGAME_WPE_ROOT` 跑全部 | 本步的用例全过 | 2026-11-12 Claude：77 个文件 1933 passed、1 failed——`compile/pipeline.test.ts` 的语料请求次数（`3830255100: 219 次请求`），1b 时就在，`compile/` 正被别的会话修改 |
| [x] | T9 耗时 | Node 26 | `ignore/p6/b1c/work/perf/` 的 vitest：字体就绪后同一对象反复排（热），新图集再排（冷，含栅格化） | 每帧都排也撑得住 | 2026-11-12 Claude：热 0.03 ms（9 字）– 0.13 ms（70 字、两行带省略号），冷 1–2.7 ms |
| [x] | T10 CEF 里跑 `text/` | Windows dev | 宿主里加载字体、排 `p6b-*`、比图集 | 和 Node 相同 | 2026-11-12 Claude（1d 时测）：宿主在 CEF 里排六个工程并渲染，整帧和 WPE 逐像素相同（见 1d 的 T5、T6） |

## 场景壁纸 P6b 1b：字体引擎 `wpefont` 进仓库

2026-11-12 Windows。FreeType 2.14.3（`third/freetype`）+ HarfBuzz 15.0.0（`third/harfbuzz`）+ C 胶水 `src-tauri/wpefont/wpefont.c` 编成 wasm32-wasip1 reactor，给场景宿主的文本对象用（文本对象本身还没实现，1c 起）。构建 `deno task build:wpefont`（`scripts/build-wpefont.ts`，工具链经 `scripts/download.ts` 的 `fetchPinned` 下载），`WpefontPlugin` 拷进 `apps/wpe-scene/src/wpefont/`，包装 `apps/wpe-scene/src/wpefont/index.ts`；宿主的 `file:` 范围逐个放行 13 个系统字体文件（`wpe_scene_host.rs` 的 `font_grants`）。契约见 `src-tauri/wpefont/README.md`，计划见 `.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「1b」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 构建 | Windows，LLVM clang 22.1.6 | 两个工具链压缩包先拷进 `bin/wasm/wpefont/toolchain/`，`deno task build:wpefont` | 摘要对就不下载；解压、编 23 个单元、链接；导出齐全 | 2026-11-12 Claude：58.6 s，产物 1,850,118 字节（1807 KiB），WASI 导入 13 个（同 1a）；第二次运行跳过解压 |
| [ ] | T2 干净缓存 | Windows | 清空 `bin/wasm/wpefont/toolchain/` 后 `deno task build:wpefont` | 下载 119 MB 的 sysroot 与 libclang_rt、校验、解压、编译成功 | 未测：网络下大文件不稳，本轮预置了压缩包；下载本身见 T3 |
| [x] | T3 `fetchPinned` | Windows，GitHub release | 临时目录里下 libclang_rt（756 KiB）：从空下载、再调一次、`.part` 只有前 300000 字节、`.part` 是坏数据、摘要写错 | 下载并校验；已缓存跳过；续传；摘要不符后从头重下；错误摘要报错、不留文件 | 2026-11-12 Claude：五项都符合，续传日志「已有 293 KiB，共 756 KiB」 |
| [x] | T4 找不到 clang | Windows | `WPEFONT_CLANG=D:/no/such/clang.exe deno run -A scripts/build-wpefont.ts` | 列出试过的候选与安装办法，退出码非 0，产物不动 | 2026-11-12 Claude：退出码 1 |
| [x] | T5 和 1a 发布包逐字段相同 | Node 26 | `ignore/p6/b1b/harness.mjs` 跑 `p6b-geom`、`p6b-align`、`p6b-fx`、`p6b-fallback`、`p6b-extra`，`ignore/p6/b1a/compare.py` 对 `ignore/p6/b1a/out/ft2.14.3/wasm-b.json` | 字段不同：无 | 2026-11-12 Claude：38 个对象、342 个字形，字段不同：无，整数步进不同 0；`glyph` 的像素框与位图框不一致 0 |
| [x] | T6 包装单测 | Node，vitest | `apps/wpe-scene` 下 `KABEGAME_WPE_ROOT=<WPE> node ../../node_modules/vitest/vitest.mjs run src/wpefont`；再不带 `KABEGAME_WPE_ROOT` 跑一次 | 全过；不带时只剩不读字体的用例 | 2026-11-12 Claude：14 passed；不带时 1 passed、13 skipped。同轮整个宿主 72 个文件 1892 passed、1 failed（`compile/pipeline.test.ts` 的语料请求次数 `3830255100: 219 次请求`，`compile/` 正被别的会话修改，不引用 wpefont） |
| [x] | T7 拷进宿主 | Windows | 直接调 `WpefontPlugin` 的拷贝两次；挪走产物再调一次 | 第一次「复制 …」、第二次没有输出；缺产物黄字告警；两处 wasm 都被 git 忽略 | 2026-11-12 Claude：符合；`git check-ignore` 命中 `/bin/wasm/` 与 `apps/wpe-scene/src/wpefont/*.wasm`。没有经 `deno task dev` / `check`（不带 `--skip vue`）整条走一遍 |
| [x] | T8 系统字体放行 | Windows，cargo test | `CARGO_TARGET_DIR=target-check` 下 `test-kabegame` driver：`kabegame wpe_scene_host` | 清单里存在的文件放行，清单外 / 同名目录 / 不存在的不放；宿主文档范围含字体；字体文件自身没有宿主范围；真实 `%WINDIR%\Fonts` 只放该目录下的文件 | 2026-11-12 Claude：11 passed（新增 3 个、改 2 个）。本机 13 个里只缺 `arialuni.ttf` |
| [x] | T9 类型与编译 | Windows | 宿主 `tsc --noEmit`、Prettier `--check`、`check-kabegame --skip vue`（`target-check`） | 0 error | 2026-11-12 Claude：tsc 0、Prettier 通过、cargo 0 error（`wpe_scene_host.rs` 无警告） |
| [x] | T10 CEF 里实例化 | Windows dev（Chrome/149.0.7827.201），屏外场景宿主 | wasm 临时拷进 dev 宿主目录，宿主里编译、带 WASI 桩实例化，排字并栅格化 NotoSans 32 / 200 号、`arial.ttf`、`msyh.ttc`，再读没放行的 `times.ttf`；同一段探针在 Node 里跑一遍 | 实例化成功（wasm 异常处理可用）、放行的系统字体读得到、哈希和 Node 相同；`times.ttf` 被拒 | 2026-11-12 Claude：四组排字与位图哈希逐项相同，全程 61 ms；`times.ttf` 报 `deny file: … OutsideRoot`。测完关宿主、删临时文件。宿主还没有调用方，没走 `loadWpefont()` 本身 |
| [ ] | T11 macOS / Linux 构建 | macOS（Homebrew llvm + lld）/ Linux | `deno task build:wpefont`，再跑 T5 | 产物与 Windows 逐字段相同 | 未测 |

## 多显示器壁纸 P4（macOS 原生逐屏）

2026-11-11。macOS 的原生模式改经 `NSWorkspace.setDesktopImageURL(_:for:options:)` 一块屏一块屏地设系统桌面图片（新增 `wallpaper/manager/native_mac.rs`；原来用 osascript 让 System Events 给每个桌面设图的路径删除）。原生后端按布置分派：`Placement::All` 对每块在线屏各设一次，`Placement::One` 只设那一块屏；屏按持久标识（display UUID）在主线程现查 `NSScreen`，设图本身在调用线程上做（实测一次要等系统 0.6 s 上下，不能放主线程）。显示方式是每次设图带给系统的选项，逐屏生效：填充 / 适应 / 拉伸 / 居中四种（没有平铺），留边黑色。能力表里 macOS 原生的「各屏复制」「逐屏独立」可用，「跨屏拼接」不可用，原因是新键 `settings.displayModeSpanNoSystem`（「系统没有跨屏铺放，该模式不可用」）。在线屏变化时 `on_screens_changed(previous)` 在原生模式下只给新接入的屏输出（纯函数 `outputs_for_new_screens`）。

用户可见的变化（macOS 原生模式）：
- 显示器模式可选「逐屏独立」：每块显示器各设当前壁纸、轮播路径与显示方式，轮播到点时每块屏各换一张；窗口模式与原生模式互切时「逐屏独立」不再回落成「各屏复制」。
- 显示方式不再只有「填充」，可选适应、拉伸、居中，改了立即生效；原来由系统决定铺法，现在每次设图都带上所选的显示方式。
- 接上一块显示器后，新屏自动换成它该显示的壁纸，已有的屏不闪。
- 「跨屏拼接」在 macOS 两种壁纸模式下都置灰，原生模式下的原因是「系统没有跨屏铺放，该模式不可用」。

不在这一期：Windows 的 `IDesktopWallpaper` 逐屏（STA 线程）、Windows / GNOME 的系统跨屏铺放、Linux 的逐屏；这三个平台原生模式的「逐屏独立」「跨屏拼接」仍置灰（后续版本）。

已知情况：
- 只改各显示器**当前桌面（Space）**的图片，其它桌面保持原样（系统接口的限制，本机没有验）。
- 设一块屏要等系统 0.6 s 上下，各屏复制时两块屏先后差一秒左右，不是同时变。
- 当前壁纸是视频的目标在原生模式下不输出：切到原生或在原生模式下重启后，那块屏留着上一张系统壁纸。`NSWorkspace` 对视频、目录来者不拒且不报错（桌面图片会被指到它画不出来的文件上），所以应用在交给系统之前先拦掉；原先 osascript 路径下是系统默默不理，结果相同。
- WebP 直接把原图交给系统，不生成原生壁纸兼容副本（这一层只管 Windows / Linux）；库里没有 AVIF / HEIC，没验。
- 上一节 W18 / K17 记的「逐屏独立下窗口 → 原生 → 窗口后显示器模式回落各屏复制」在 macOS 上不再发生（两种模式都支持逐屏独立）。
- 用 `screencapture` 截副屏核对画面时，系统在副屏上弹了一次屏幕录制授权提示（请求方是运行测试的终端宿主，不是 Kabegame）；之后没有再截屏，系统壁纸一律用 `desktopImageURL` / `desktopImageOptions` 读回核对。

真机记录（2026-11-11，macOS 26.6 桌面 dev，内建屏 1512×982@2x + DeskPad 虚拟屏 1440×900@2x 在主屏右侧）：系统壁纸的取证是另起进程读每块屏的 `NSWorkspace.desktopImageURL(for:)` 与 `desktopImageOptions(for:)`（机器上同时开着一个已安装版 Kabegame，它在主屏有壁纸窗口，不能靠肉眼）；调用次数看应用日志里 `native_mac` 的「原生壁纸已设置: 屏 <id> ← <路径>（<样式>）」。测试前逐屏存下系统桌面图片与应用状态，结束后原样设回并读回比对一致，测试产生的 `screen:*` 目标已删除。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | N0 单测与检查 | 桌面 | `check-kabegame` 全量，另跑 `--mode web --skip vue` 与 `-c kabegame-cli --skip vue`；`test-kabegame` 跑 kabegame crate；前端 vitest 跑壁纸相关 8 个文件 | 0 error；全过 | 新增单测：样式 → 选项（四种各不相同、不认识的样式按填充）、能不能显示（视频与目录不能）、文件不存在时不碰系统、屏幕变化后给哪些屏补输出（各屏复制 / 逐屏独立下只有新接入的屏、挪位置改分辨率换主屏不算、跨屏拼接与没有屏幕信息时不补）、窗口模式的样式带进 macOS 原生时平铺不带、真机上按 id 查回 `NSScreen` 与枚举一致。kabegame crate 162 passed |
| [x] | N1 能力表 | macOS，原生模式 | `get_wallpaper_capabilities` 看 `displayModes.native`；设置页「显示器模式」 | 各屏复制、逐屏独立可用；跨屏拼接不可用，原因五种语言都有；样式 `fill fit stretch center`，过渡只有「跟随系统」，`sharedStyle` 为 false；窗口模式的能力不变（跨屏拼接仍是「窗口模式暂不支持跨屏拼接」） | 设置页截图里「跨屏拼接」置灰、「逐屏独立」可选 |
| [x] | N2 各屏复制：两块屏同一张 | 同上，各屏复制 | `set_wallpaper_by_image_id` 设一张图 | 两块屏的 `desktopImageURL` 都是它；日志每块屏各一条 | |
| [x] | N3 各屏复制：四种显示方式 | 同上 | `set_wallpaper_style` 依次设适应、拉伸、居中、填充；再设平铺 | 两块屏的 `desktopImageOptions` 同步变：适应 = 缩放 3 + 不裁剪，拉伸 = 缩放 1，居中 = 缩放 2，填充 = 缩放 3 + 裁剪；留边色黑；平铺被拒「当前壁纸模式不支持该样式: tile」 | 另截了副屏四种样式的画面，铺法确实各不相同 |
| [x] | N4 逐屏独立：只改一块屏 | macOS，两块屏，原生模式 | 切「逐屏独立」；给副屏（带 `target`）设另一张图，样式改适应、再改居中；再不带 `target` 把默认屏（主屏）样式改拉伸 | 切过去时两块屏各设一次（从 `multiple` 复制的同一张）；之后只有被改的那块屏的 URL / 选项变，另一块不变；日志里每次只有一条 | |
| [x] | N5 设置页按选中的屏显示样式 | 同上 | 设置页布局图点副屏、再点主屏，看「壁纸显示方式」 | 点副屏显示「居中」，点主屏显示「拉伸」 | |
| [x] | N6 逐屏独立：轮播各换一张 | 同上，两块屏轮播路径不同 | 间隔 1 分钟，开轮播，等两次到点 | 每次到点两块屏各换一张、各走各的路径与位置、各用各的样式；日志每次两条（每屏一条） | 给副屏换路径时只有副屏立刻切到新路径第 1 张 |
| [x] | N7 逐屏独立下窗口 ↔ 原生互切 | 同上 | 原生 → 窗口；在窗口模式把副屏样式改平铺、主屏改适应；窗口 → 原生 → 窗口 | 显示器模式始终是逐屏独立；各目标的当前壁纸、轮播路径都在；原生名下的样式（拉伸 / 居中）与窗口名下的样式（适应 / 平铺）各自保留；切到原生时每块屏的系统壁纸是各自目标的当前图 | |
| [x] | N8 切到原生时当前壁纸是视频 / WPE | 同上 | 窗口模式下副屏设一个视频、主屏设一张场景壁纸，再切原生 | 视频那块屏：不交给系统，系统壁纸保持上一张（debug 日志「原生模式不能显示视频 / 目录型壁纸，保持系统壁纸不变」）；WPE 那块屏：按既有规则从画廊取一张兜底图设上（warn 日志），目标的当前壁纸仍是那张场景 | 切换成功，不留半切换状态 |
| [x] | N9 热插拔：逐屏独立 | macOS + DeskPad，原生模式 | 先背着应用把副屏的系统壁纸改成别的图；`quit app "DeskPad"`；再 `open -g -a DeskPad` | 退出：无报错、不调系统接口，副屏的目标保留；重开：副屏变回它自己目标的图与样式，日志里只有副屏一条，主屏没有被重设 | |
| [x] | N10 热插拔：各屏复制 | 同上，各屏复制 | 同 N9 | 重开后副屏得到 `multiple` 目标的那一张与样式，日志只有副屏一条 | |
| [x] | N11 重启后恢复 | macOS，原生模式 | 逐屏独立与各屏复制下各重启一次应用（dev 热重启） | 每块屏各设一次：逐屏独立是各自的图与样式，各屏复制是同一张；没有多余的重设；显示器模式保持 | |
| [x] | N12 关 / 开「打开壁纸」 | 同上，逐屏独立 | 关掉；背着应用改掉两块屏的系统壁纸；再打开 | 关：不动系统壁纸；开：每块屏各设一次自己目标的图与样式 | |
| [x] | N13 选屏弹窗 | macOS，两块屏，原生逐屏独立 | 图库里右键一张图「抱到桌面上」，弹窗里点副屏、确认 | 弹出「设为哪块显示器的壁纸」；只有副屏的系统壁纸变，主屏不变 | |
| [x] | N14 WebP | macOS，原生模式 | 设 / 轮播到 WebP 图 | `desktopImageURL` 就是那张 `.webp` 原图，`wallpaper_compatible_path` 仍为空 | 库里没有 AVIF / HEIC |
| [x] | N15 没有屏幕信息时的兜底 | macOS dev | 临时插桩强制走「屏列表为空」分支后设图（验完已删） | 对系统当前的每块屏各设一次，日志「系统当前的 2 块屏」 | |
| [x] | N16 日志 | macOS dev | 做完以上操作后看应用日志 | 没有 error；warn 只有既有项（轮播关着时启动的「壁纸轮播未启用」、场景退回预览图、WPE 兜底换图、更新检查超时） | |
| [ ] | N17 托盘「下一张」 | macOS，两块屏，原生逐屏独立 | 鼠标分别在两块屏上点托盘「下一张壁纸」 | 只切鼠标所在那块屏的系统壁纸 | 没有点托盘（要动真实鼠标）。选目标的代码没改；`rotate(Some(目标))` 在原生逐屏独立下只设那一块屏已由 N6 换路径那一步验到 |
| [ ] | N18 多个桌面（Space） | macOS，建了多个桌面 | 在桌面 1 设壁纸，切到桌面 2 看 | 只有当时所在的桌面换了图（已知限制） | 没有切 Space |
| [ ] | N19 真实外接屏、不同缩放与朝向 | macOS，外接显示器（含竖屏） | 逐屏独立下各设一张，四种显示方式都试 | 设到的屏与布局图一致；铺法正确 | 需要真实外接显示器；DeskPad 的 UUID 在本机重开后不变 |
| [ ] | N20 镜像显示、合盖 / 睡眠唤醒 | macOS 笔记本 + 外接屏 | 开镜像；合盖只用外接屏再打开；睡眠后唤醒 | 镜像时一组只算一块屏；屏回来后得到该有的图，已有的屏不重设（全部显示器都消失过再回来时每块各设一次） | 需要外接显示器 |
| [ ] | N21 三块及以上 | macOS，多块屏 | 各屏复制下换图 | 每块屏都换；逐块设，先后各差不到一秒 | 需要多块显示器 |
| [ ] | N22 Windows / Linux 行为不变 | Windows；Linux GNOME / Plasma | 原生模式设图、改样式、轮播、切模式、关开壁纸 | 与本期之前相同；「逐屏独立」「跨屏拼接」仍置灰；能编译 | 本机编译不了。共享代码里动过的地方：`native.rs` 的 `set_all` 加了 `cfg(not(macos))`、`set_wallpaper` 拆成 macOS / 其余两份（其余平台那份逐字未变）；`manager/mod.rs` 的 `on_screens_changed` 多了参数与原生分支、新增 `outputs_for_new_screens` / `output_current`；`screens.rs` 的 `replace_cache` 返回换下来的那份、`commit` 把它传给控制器 |
| [ ] | N23 Android 可编译 | Android | `deno task check -c kabegame --mode android --skip vue` | 通过 | 本机只跑了 macOS 桌面、`--mode web` 与 CLI |
| [ ] | N24 Windows 原生逐屏（待做） | Windows，多屏 | — | — | 计划 04 点 2（`IDesktopWallpaper` + STA 线程）与点 4（系统跨屏铺放）尚未实现 |

## 窗口模式每屏一窗（多显示器壁纸 P3 前半）

2026-11-11。窗口模式下每块在线屏一个壁纸窗口（`WindowWallpaperManager` 持有窗口表，`plan_windows` / `diff_windows` 按屏的持久标识对齐：同一块屏保留原窗口、屏矩形变了重铺、布置变了推事件、屏不在了销毁、缺的新建），label 取自固定的池 `wallpaper`、`wallpaper-1` … `wallpaper-7`（ACL 特赦、`main-capability` / `wpe-web-capability` 的窗口列表、场景宿主 capability、建窗前的 `file:` 能力都按整池登记）。后端给每个窗口一条布置 `{ targetId, audible }`（命令 `get_wallpaper_window_assignment` + 只发给该窗口的事件 `wallpaper-assignment`），壁纸页面据此读 `wallpaperTargets[targetId]`；就绪握手、ping 看门狗、桌面鼠标转发每个窗口各一份；在线屏变化时 `on_screens_changed` 对齐窗口集合。macOS 的窗口模式因此可以选「逐屏独立」，「跨屏拼接」在窗口模式下置灰并显示「窗口模式暂不支持跨屏拼接」。

用户可见的变化（macOS 窗口模式）：多屏机器上每块屏都有壁纸（原来只有主屏）；显示器模式可选「逐屏独立」，设置页点布局图里的一块屏后，下面的轮播路径、当前壁纸、显示方式、过渡就是那块屏的；各屏复制时同一个视频各屏各播一份、只有主屏出声；轮播到点时每块屏各换一张。Windows 没有显示器枚举，窗口模式仍是一个壁纸窗口铺主屏，「逐屏独立」仍置灰（后续版本）。原生模式不变。

不在这一期：Windows 的每屏一窗。图库 / 画册 / 查询栏「设为壁纸」「设为轮播」前的目标选择弹窗、托盘「下一张」按光标所在屏的真机验证见下一节（P3 后半）。

已知情况：
- 逐屏独立下窗口 → 原生 → 窗口一个来回后，显示器模式回落为各屏复制，要逐屏独立需重新选一次。各屏在窗口模式下存的样式 / 过渡不受影响（这一期实测时曾被原生模式的值覆盖，副屏的「适应 + 淡入淡出」变回「填充 + 无」；P3 后半改了沿用规则，见下一节 K17）。
- 设置写盘有约 5 s 去抖：dev 下应用被热重启强杀时，刚切的显示器模式会丢，重启后回到上一次落盘的值（真机测试时踩到过一次，不是本期引入）。
- 显示器睡眠期间窗口服务不推进窗口动画，这时列出的壁纸窗口矩形可能是动画中间值、已销毁的窗口也还在列表里；唤醒后恢复正常（W15 第一次核对时遇到）。
- 壁纸窗口的地址多了 `&slot=<序号>`，kabegame-dev 的 `wallpaper` 目标在多窗口时只会选中其中一个，要指定用 `url:slot=<n>`。

真机记录（2026-11-11，macOS 桌面 dev，内建屏 1512×982@2x + DeskPad 虚拟屏 1440×900@2x 在主屏右侧，窗口模式）：已勾选的 case 逐项验过；窗口矩形同时核对了页面里的 `screenX / screenY / innerWidth / innerHeight` 与窗口服务（`CGWindowListCopyWindowInfo`）里 dev 进程桌面层窗口的边界。测试期间工作区另有会话在改 Rust，dev 应用被反复热重启，被打断的步骤都在同一个进程里重做过；18:20 起机器处于锁屏状态，需要真实点击的 W13 没法验。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W0 单测与检查 | 桌面 | `check-kabegame` 全量，另跑 `--mode web --skip vue` 与 `-c kabegame-cli --skip vue`；`test-kabegame` 跑 kabegame crate；前端 vitest 全量 | 0 error；全过 | 新增单测：`plan_windows`（各屏复制只有主屏出声、逐屏独立各自出声、没有屏幕信息退化成一个不绑定屏的窗口、跨屏拼接不出窗口）、`diff_windows`（同屏保留、按 id 不按位置、拔 / 接、清空）、布置落在哪些窗口、label 池与两个 capability 文件一致、macOS 坐标翻转；前端 `WallpaperWindow` 按布置读目标、不出声时音量为 0、布置先于目标配置到达时不闪 |
| [x] | W1 各屏复制：每屏一窗 | macOS，两块屏，窗口模式 | 启动应用；看 kabegame-dev `targets` 与两个壁纸窗口的矩形 | 两个壁纸窗口（`…&slot=0`、`…&slot=1`），矩形分别等于两块屏（`list_wallpaper_screens`），显示同一张壁纸；日志各有一行「新建壁纸窗口 <label>: 显示器 …，目标 multiple，出声 …」 | 实测 `wallpaper` (0,0,1512,982)、`wallpaper-1` (1512,0,1440,900)；两个页面各按本屏刷新率跑（120 / 60 fps） |
| [x] | W2 各屏复制：只有主屏出声 | 同上，当前壁纸是带声音的视频 | 把壁纸音量调到非 0，看两个窗口里 `<video>` 的 `volume` / `muted` | 主屏窗口 `volume` = 壁纸音量、不静音；副屏窗口 `volume` 0、静音；调试面板副屏显示 `(muted)` | 实测 0.05 / 未静音 与 0 / 静音 |
| [x] | W3 切到逐屏独立 | 同上 | 设置页「显示器模式」点「逐屏独立」（或 `set_wallpaper_display_mode`） | 多出两个目标 `screen:<两块屏的 id>`，内容从 `multiple` 复制；两个窗口不重载，各自的布置变成自己那块屏的目标、都出声；画面不闪（当前壁纸相同） | 窗口页面的加载时刻前后不变 |
| [x] | W4 逐屏独立：只改一块屏 | 同上 | 设置页布局图点副屏，或命令带 `target: screen:<副屏>`：设另一张图、把显示方式改成「适应」、换轮播路径、把过渡改成「淡入淡出」 | 只有副屏窗口换图 / 换样式 / 换过渡，主屏窗口的图、样式、「last image / style ts」都不变；换路径立刻切到新路径第 1 张，改过渡（轮播开着）只把副屏切一张演示 | 四项改动经带 `target` 的命令验；设置页点副屏后核对了第三层显示的是它的路径、当前壁纸、样式、过渡（截图），没有逐个点设置页的控件 |
| [x] | W5 逐屏独立：轮播同拍各换一张 | 同上，两块屏轮播路径不同，轮播开启 | 把间隔改成 1 分钟，等到点 | 两块屏在同一时刻各换一张，各走各的路径（各自的位置各自前进） | 实测同一秒内两个目标的当前壁纸都变了 |
| [x] | W6 拔掉一块屏 | macOS + DeskPad，逐屏独立 | `osascript -e 'quit app "DeskPad"'` | 约 1 s 内副屏的壁纸窗口销毁，窗口数 = 在线屏数 = 1；主屏窗口不重载、画面不变；副屏的目标配置还在；日志「壁纸窗口 wallpaper-1 的显示器已不在线，销毁」 | 主屏窗口页面的加载时刻不变 |
| [x] | W7 接回那块屏 | 同上 | `open -a DeskPad` | 约 1 s 内重建副屏窗口，显示它原来的壁纸、样式、过渡；主屏窗口仍不重载 | 新窗口页面约 0.3 s 就绪 |
| [x] | W8 已断开屏的「忘记」 | 同上 | 拔掉副屏后看设置页布局图下方；点「忘记」；再接回 | 出现「已断开：<标识前 8 位> 忘记」；点后该行消失、目标从 `wallpaperTargets` 删除；接回后该屏的目标从默认屏重新复制一份。对在线屏调 `forget_wallpaper_target` 被拒「该显示器仍在使用，不能忘记」 | |
| [x] | W9 设为默认 | macOS，两块屏，逐屏独立 | 布局图点副屏 → 「设为默认」；再清除 | 「默认」角标换到副屏，按钮消失；不带 `target` 的命令（如 `get_current_wallpaper_image_id`）落到副屏，主窗口的应用背景随之换成副屏的壁纸；清除后回到主屏 | |
| [x] | W10 副屏上的网页壁纸 | 同上 | 把副屏的壁纸设为一张网页壁纸 | 副屏窗口里出现 `file:` iframe 并正常显示；iframe 里 `wpe_web_pull_state`、`wallpaper_pong` 可调，未授权的命令（如 `get_wallpaper_targets`）被 ACL 拒绝；应用日志没有针对它的 `deny file:`（NotFound 探测除外）或 ACL 拒绝 | iframe 里读到的窗口 label 是 `wallpaper-1` |
| [x] | W11 副屏上的场景壁纸 | 同上 | 把副屏的壁纸设为能渲染的场景（自带 beach） | 副屏窗口里出现场景宿主 iframe；日志「wallpaper-1: 场景壁纸 … 开始渲染」 | |
| [x] | W12 鼠标移动只送到光标所在屏 | 同上，两块屏都放网页壁纸 | 光标分别在副屏、主屏上移动（在各自的 iframe 里数 `mousemove`） | 光标在哪块屏，只有那块屏的窗口收到移动，坐标是相对该窗口的（副屏上 (2092,460) → (580,460)）；光标移到另一块屏时原来那块收到一次 `mouseleave` | 测试时显示器要醒着：锁屏且显示器睡眠时页面是 hidden，收不到注入的事件 |
| [ ] | W13 鼠标点击转发到副屏 | 同上 | 在副屏桌面空白处点左键、点桌面图标、点别的应用窗口 | 前两种页面收到按下 / 抬起，第三种不转发 | 空白处点击已在 P3 后半验过（K19）；点桌面图标、点别的应用窗口未验。判定逻辑与单窗口时相同，只是每个窗口各一份 |
| [x] | W14 ping 每个窗口各自应答 | macOS，两块屏 | 在两个窗口里各听 23 s `wallpaper-ping` | 两个 label 各有自己的序号在走（如 `wallpaper#23…`、`wallpaper-1#18…`）；日志没有「ping 未应答」 | 网页壁纸窗口由垫片应答 |
| [ ] | W15 一个窗口失联只重载它自己 | 同上 | 让其中一个壁纸页面卡死（如在它里面跑死循环） | 约 40 s 后只有这个窗口重载，另一个不受影响 | 没有验 |
| [x] | W16 关 / 开「打开壁纸」 | macOS，两块屏，逐屏独立 | 关掉再打开 | 关：两个壁纸窗口都销毁，窗口服务里 dev 进程没有桌面层窗口；开：按当前布局重建两个，各显示自己的目标 | |
| [x] | W17 各屏复制 ↔ 逐屏独立来回 | 同上 | 切到各屏复制，设一张图，再切回逐屏独立 | 窗口不重建；各屏复制时两屏同图、只有主屏出声；切回后各屏还是原来各自的壁纸 | |
| [x] | W18 逐屏独立下切到原生再切回 | 同上 | 「壁纸模式」切原生，再切回窗口 | 切原生：显示器模式回落「各屏复制」并写回设置，壁纸窗口全部销毁，系统桌面图片是 `multiple` 目标的当前壁纸；切回窗口：两个窗口重建，各屏复制 | 样式 / 过渡的沿用见下一节 K17 |
| [x] | W19 重启后各屏恢复 | 同上，逐屏独立，两屏不同壁纸 | 重启应用 | 两个窗口各显示自己那块屏的壁纸与样式 | dev 热重启验的 |
| [x] | W20 显示器模式选择器 | macOS，窗口模式 | 看设置页「显示器模式」；点三项 | 「逐屏独立」可选；「跨屏拼接」置灰，命令返回「窗口模式暂不支持跨屏拼接」；原生模式下另两项仍是「该显示器模式将在后续版本提供」 | |
| [x] | W21 日志与控制台 | macOS dev | 做完以上操作后看应用日志与三个窗口的控制台 | 没有新增 error；warn 只有场景壁纸退回预览图这类既有项；两个壁纸窗口的控制台在一轮切换中没有输出 | |
| [ ] | W22 改排布、分辨率、换主屏 | macOS，两块屏 | 系统设置里拖动副屏位置、改分辨率、把副屏设为主屏 | 各窗口重新铺满各自的屏，页面不重载；各屏复制下出声的窗口换到新主屏 | 需要改系统显示器设置 |
| [ ] | W23 真实外接屏、不同缩放 | macOS，外接 1x 显示器 | 接上后看两块屏的壁纸 | 各自清晰、铺满，没有按另一块屏的缩放渲染 | 需要真实外接显示器 |
| [ ] | W24 三块及以上 | macOS，多块屏 | 接三块屏，逐屏独立 | 三个窗口各在各的屏；超过 8 块时只有前 8 块有窗口并有一条告警 | 需要多块显示器 |
| [ ] | W25 合盖 / 睡眠唤醒 | macOS 笔记本 + 外接屏 | 合盖只用外接屏再打开；睡眠后唤醒 | 窗口随屏增减；唤醒后各窗口仍在各自的屏上 | 需要外接显示器 |
| [ ] | W26 关闭「显示器具有单独的空间」 | macOS，两块屏 | 系统设置里关掉该项并重新登录 | 两块屏仍各有壁纸 | 需要改系统设置 |
| [ ] | W27 Windows 行为不变 | Windows，多屏 | 窗口模式启动、设图、轮播、切模式、关开壁纸 | 仍是一个壁纸窗口铺主屏，与本期之前相同；「逐屏独立」「跨屏拼接」置灰；能编译 | 本期没有在 Windows 上编译过，共享代码里动过的 `cfg` 分支见 `cocs/wallpaper/MULTI_SCREEN.md`「加功能时看哪里」 |
| [ ] | W28 Linux / Android / Web 可编译 | Linux；Android；Web | `deno task check` | 通过 | 本机只跑了 macOS 桌面、`--mode web` 与 CLI |

## 目标选择弹窗、托盘「下一张」按光标所在屏、样式沿用规则（多显示器壁纸 P3 后半）

2026-11-11。有多个活跃壁纸目标时（逐屏独立且在线屏不止一块），设置页以外凡是要落到某个目标的操作先弹目标选择弹窗：命令式入口 `pickWallpaperTarget({ action })`（`composables/useWallpaperTargetPicker.ts`）+ 挂在 `App.vue` 的宿主 `WallpaperTargetPickerHost.vue`，弹窗里是与设置页共用的显示器布局图，预选默认屏；只有一个活跃目标时不弹、直接返回它。接入的入口：图库 / 预览「设为壁纸」（单选与多选）、画册「设为轮播」（详情栏按钮、画册树右键）、查询行「用当前视图轮播」。托盘「下一张」不弹窗，后端按菜单事件到达时光标所在的屏选目标（`target_for_cursor`）。另改了切壁纸模式时样式 / 过渡的沿用规则（`carry_to_mode`）：只在目标的新模式名下还没有值时才把旧模式的值带过去，已有值一律不动。

用户可见的变化：
- 多块显示器逐屏独立时，「设为壁纸」「设为轮播」「用当前视图轮播」先选显示器，成功提示带显示器名；各屏复制、单屏时与以前完全相同。
- 画册只在部分显示器上轮播时：详情栏徽标写明是哪几块，主按钮仍是「设为桌面轮播」（给另一块屏），下面多一个「停止桌面轮播」；树右键两项都有；查询行「用当前视图轮播」仍可点，下面一行写明哪块屏已在轮播。每块屏都在轮播它时与以前相同（只有「停止」/ 置灰）。「停止桌面轮播」关的是全局开关。
- 托盘「下一张」只切鼠标所在那块显示器。
- 窗口模式与原生模式的显示方式 / 过渡各记各的：窗口 → 原生 → 窗口后，窗口模式原来的值原样保留（原来会被原生模式的值覆盖）。
- 需要切换壁纸模式的确认框里点「取消」不再弹「壁纸设置失败: cancel」。

已知情况：
- 弹窗打开时在线屏只剩一块，操作直接落到剩下的那块屏，即使刚才选中的是断开的那块（计划如此）。
- 引导切壁纸模式后原目标不再活跃（新模式不支持逐屏独立）时改用新的默认目标：macOS 现在复现不了（原生模式还没有逐屏独立，原生下本来就只有一个目标），只有单测（K14）。
- 主窗口被别的窗口完全挡住时页面是 hidden、不出帧，这时打开的弹窗里布局图要等窗口重新可见才画出来（测量宽度靠 `ResizeObserver`）。用户看不到被挡住的窗口，不影响使用；自动化测试时要先把主窗口带到前台。
- kabegame-dev 的 `wallpaper` 目标在多窗口时仍只选中其中一个（没有改，继续用 `url:slot=<n>`）。

真机记录（2026-11-11，macOS 桌面 dev，内建屏 1512×982@2x 为主屏 + DeskPad 虚拟屏 1440×900@2x 在右侧，窗口模式；机器没有锁屏）：界面操作经 CDP 在主窗口里合成事件（右键菜单、点击、双击、回车都是合成的 DOM 事件），状态读 `get_wallpaper_targets`，提示读消息历史，两个壁纸窗口各自核对了布置与画面。托盘「下一张」没有用真实鼠标点托盘图标：光标用 `CGWarpMouseCursorPosition` 放到指定位置，菜单项「下一张壁纸」经辅助功能（System Events 对状态栏菜单项 `click`）触发，看应用日志里「光标所在屏 … 对应壁纸目标 …」与随后的「壁纸已更换（目标）」。测试期间同一台机器上另有人 / 会话在用主窗口（出现过不是本次操作产生的收藏提示与路由变化），被打断的步骤都重做过。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | K0 单测与检查 | 桌面 | `check-kabegame` 全量，另跑 `--mode web --skip vue` 与 `-c kabegame-cli --skip vue`；`test-kabegame` 跑 kabegame crate；前端 vitest 全量 | 0 error；全过 | 新增单测：`target_for_cursor`（光标在各屏、屏外空角、取不到光标、屏不在布局里、各屏复制 / 跨屏拼接、屏列表为空）、`carry_to_mode`（第一次进入才带、不支持不写、来回一圈窗口的值保留、逐屏目标同样保留）；前端 `pickWallpaperTarget`（单目标不弹、取消返回 null、后来的顶掉前一个）、宿主组件（预选默认屏、确认 / 双击、取消 / 关闭、打开期间屏减少到一块自动返回、选中的屏断开回默认屏、显示器模式变了自动返回）、引导切模式后目标的取舍、`rotatingTargetIds` |
| [x] | K1 各屏复制：各入口不弹 | macOS，两块屏，窗口模式，各屏复制 | 图库右键「设为壁纸」；画册详情栏「设为桌面轮播」；画册树右键「设为桌面轮播」；查询行 ⋯「用当前视图轮播壁纸」 | 都不弹窗，直接落到 `multiple` 目标；提示是不带屏名的原文案；详情栏按钮在轮播后变「停止桌面轮播」、查询行变「正在轮播此视图」置灰 | 与多屏改造前相同 |
| [x] | K2 逐屏独立：「设为壁纸」弹窗与取消 | 同上，逐屏独立 | 图库右键「设为壁纸」；看弹窗；点「取消」 | 弹出「设为哪块显示器的壁纸」，布局图两块屏，主屏带「主屏」「默认」角标并预选、焦点在它上面；取消后弹窗与遮罩消失，目标配置与壁纸都不变，没有提示 | |
| [x] | K3 选副屏 | 同上 | 再点「设为壁纸」→ 点副屏 → 「确认」 | 只有副屏目标的当前壁纸变，主屏与 `multiple` 不变；副屏的壁纸窗口换图、主屏窗口不变；提示「已设为「DeskPad Display」的壁纸」 | 两个壁纸窗口各读了 `get_current_wallpaper_target` 与画面 |
| [x] | K4 双击与回车 | 同上 | 弹窗里双击主屏块；再开一次，直接按回车 | 双击直接以那块屏返回；回车以预选的默认屏返回 | 合成的 `dblclick` / `keydown` |
| [x] | K5 多选「设为壁纸」 | 同上 | 选两张图 → 右键「设为壁纸」→ 取消；再来一次 → 选主屏 → 确认 | 取消：不建画册、什么都不变；确认：建「桌面画册 1」（2 张），主屏的轮播路径变成它，副屏不变，提示「已在「Built-in Retina Display」开启轮播：画册「桌面画册1」（2 张）」 | 测完删掉了该画册 |
| [x] | K6 画册「设为轮播」 | 同上，两个测试画册 | 详情栏主按钮 → 取消 → 再点 → 选副屏 → 确认；再从画册树右键「设为桌面轮播」→ 确认（预选主屏） | 标题「在哪块显示器上轮播」；取消不变；选副屏后只有副屏的轮播路径变成该画册，提示「已在「DeskPad Display」开启轮播：画册「…」」；右键那次落到主屏 | |
| [x] | K7 「用当前视图轮播」 | 同上，画廊某个视图 | 查询行 ⋯ → 「用当前视图轮播壁纸」→ 取消；再点 → 确认 | 取消不变、按钮恢复可点；确认后只有选中那块屏的轮播路径变成当前视图，提示「已在「…」用当前视图轮播壁纸」 | 弹窗出现时 ⋯ 面板被关掉（点在面板外），属预期 |
| [x] | K8 预选跟随默认屏 | 同上 | `set_wallpaper_default_screen` 把默认屏改成副屏，再开弹窗 | 「默认」角标在副屏，预选与焦点都是副屏 | |
| [x] | K9 多目标下的轮播来源标记 | 同上 | 画册 A 只在副屏轮播时看详情栏、树、右键菜单；再给主屏也设上；画廊视图只在副屏轮播时看查询行，再给主屏也设上 | 只在副屏：树有显示器图标，徽标「桌面轮播中 · DeskPad Display」，主按钮「设为桌面轮播」+ 下面「停止桌面轮播」，右键两项都有；查询行可点、小字「DeskPad Display 正在轮播此视图」。两块屏都在轮播：徽标列出两块屏，主按钮「停止桌面轮播」，右键只有停止；查询行「正在轮播此视图」置灰 | |
| [x] | K10 预览里「设为壁纸」 | 同上 | 打开一张图的预览 → 右键「设为壁纸」→ 取消 | 弹窗压在预览之上（层级 2030 对 2000），弹窗中心点命中的是弹窗；取消后预览还开着，什么都不变 | |
| [x] | K11 弹窗打开时拔掉副屏 | macOS + DeskPad，逐屏独立 | 弹窗打开并选中副屏时 `osascript -e 'quit app "DeskPad"'`；之后 `open -a DeskPad` 再试一次 | 约 2 s 内弹窗自己关闭，操作落到剩下的主屏（提示不带屏名），没有残留遮罩；接回后弹窗照常两块屏、预选默认屏，取消与确认都正常 | DeskPad 接回后屏的标识不变 |
| [x] | K12 逐屏独立下设视频 / WPE | 同上 | 视频「设为壁纸」→ 选主屏；场景壁纸「设为壁纸」→ 确认（副屏） | 各自落到选中的屏，提示带屏名，没有「壁纸目标不在当前显示器模式的活跃集合里」 | |
| [x] | K13 「需要窗口模式」引导 | macOS，原生模式（显示器模式回落各屏复制） | 视频「设为壁纸」→ 确认框点「取消」；再来一次点「继续」 | 不弹选屏（只有一个目标），弹「该媒体需要窗口模式…」；取消：模式不变、没有任何提示；继续：切到窗口模式，视频设到 `multiple`，提示「壁纸设置成功」，没有目标相关的报错 | 切到原生会把系统桌面图片设成 `multiple` 目标的当前壁纸 |
| [ ] | K14 引导切模式后原目标不再活跃 | 原生模式支持逐屏独立的平台 | 原生逐屏独立下给副屏设视频 → 确认切到一个不支持逐屏独立的模式 | 不报错，改落到新的默认目标，提示不带原来那块屏的名字 | macOS 现在复现不了；单测 `wallpaperMode.test.ts` 覆盖 |
| [x] | K15 托盘「下一张」按光标所在屏 | macOS，两块屏，逐屏独立，两屏轮播路径各有多张 | 默认屏为主屏、光标在副屏时触发托盘「下一张壁纸」；默认屏改成副屏、光标在主屏时再触发；各屏复制下光标在副屏时再触发 | 逐屏独立：只有光标所在那块屏的目标换一张（日志「光标所在屏: <该屏>，对应壁纸目标: screen:<该屏>」「壁纸已更换（screen:<该屏>）」），另一块屏的当前壁纸与位置不变，结果与默认屏是谁无关；各屏复制：目标是 `multiple` | 菜单项经辅助功能触发，没有用真实鼠标点托盘图标 |
| [ ] | K16 光标不在任何一块屏里 | 两块屏高低错开 | 光标在空角时触发「下一张」 | 落到默认目标 | 系统不让光标停在屏外，真机做不出来；单测覆盖 |
| [x] | K17 样式 / 过渡不被另一个模式覆盖 | macOS，两块屏，逐屏独立 | 给副屏设显示方式「适应」、过渡「淡入淡出」→ 切原生 → 切回窗口 → 再切回逐屏独立 | 副屏目标的 `style` 仍是 `{ native: fill, window: fit }`、`transition` 仍是 `{ native: none, window: fade }`；副屏壁纸窗口按「适应 / 淡入淡出」渲染；主屏与 `multiple` 的值不变 | 切回窗口是经 K13 的引导做的；副屏窗口调试面板 `mode: fit`、`transition: fade` |
| [ ] | K18 Windows 的样式沿用 | Windows | 窗口模式设「适应 / 滑动」→ 切原生 → 改原生的样式 → 切回窗口 | 窗口模式仍是「适应 / 滑动」；原生第一次进入时沿用「适应」，之后两边各记各的 | 未在 Windows 验 |
| [x] | K19 副屏桌面上的点击到达网页壁纸 | macOS，两块屏，逐屏独立，副屏是网页壁纸 | 光标移到副屏桌面空白处，真实点一次左键（在 iframe 里记事件） | 副屏窗口的 iframe 收到 `mousemove`、`mousedown`、`mouseup`、`click`，坐标相对该窗口（屏幕 (2200,450) → (688,450)），都是可信事件 | 补上一期的 W13（只验了空白处） |
| [x] | K20 日志与控制台 | macOS dev | 做完以上操作后看应用日志与主窗口控制台 | 没有新增 error；warn 只有场景壁纸退回预览图这类既有项 | 第一轮每开一次弹窗有一条 `ResizeObserver loop completed with undelivered notifications`（布局图量的是会被自己撑高的画布），改成量一个高度恒为 0 的元素后复测 3 次开关弹窗与设置页布局图，不再出现 |
| [ ] | K21 Windows 托盘 | Windows，多屏，逐屏独立可用后 | 从主任务栏托盘点「下一张」 | 切主屏（托盘图标默认只在主任务栏，光标一定在主屏） | 需要 Windows 的显示器枚举与逐屏独立 |
| [ ] | K22 Android / Web 不出现弹窗 | Android；Web | 「设为壁纸」「设为轮播」 | 没有屏幕信息，只有一个目标，不弹；Web 版「设为轮播」仍提示桌面版 | 未在这两端真机验；前端单测覆盖只有一个目标的分支 |

## 显示器枚举与设置页布局图（多显示器壁纸 P2）

2026-11-11。新增显示器枚举 `wallpaper/screens.rs`：`ScreenInfo`（平台持久标识、左上原点的平台桌面坐标、物理像素分辨率、缩放、主屏；主屏排第一，其余按 (y, x)）与进程内缓存，watcher 线程每 2 s 重新枚举一次、系统的显示器重排通知只负责唤醒它，快照稳定 300 ms 才提交；提交时换缓存、调 `WallpaperController::on_screens_changed()`（重算布局、补种目标）、发事件 `wallpaper-screens-change { screens }`。**平台实现只有 macOS**（`NSScreen` + display UUID，Cocoa 坐标按主屏高度翻转 Y），Windows / Linux / Android / Web 的屏幕列表仍为空。前端：在线屏 `useWallpaperScreens` 全应用一份并跟随事件；设置页壁纸分区分三层（全局 → 显示器布局图 → 选中目标的设置），新增显示器模式选择器 `WallpaperDisplayModeSetting` 与布局图 `WallpaperScreenLayout`；分段控件 `KbSegmentedControl` 支持单项不可选与悬停说明。说明见 `cocs/wallpaper/MULTI_SCREEN.md`。

这一期仍然只有 `multiple`（各屏复制）可用：选择器里「跨屏拼接」「逐屏独立」置灰，悬停显示「该显示器模式将在后续版本提供」。所以用户可见的变化只有设置页的布局图、置灰的选择器与各行的顺序；在线屏的增减不影响壁纸输出。逐屏独立才用得到的部分（默认屏角标、「设为默认」、已断开屏的「忘记」、点一块屏只选中它）已经写好、有单测，没有真机入口。

顺带修复：主窗口缩到最窄（800 px）时，设置页「当前轮播路径」「当前壁纸」两行的长路径把左边的标题挤成一个字宽；现在路径按面板宽度的比例封顶。

已知情况：屏的名字取 `NSScreen.localizedName`，语言跟应用自身的本地化走，dev 下是英文（`Built-in Retina Display`），不一定与「系统设置」里显示的相同。应用没有暗色主题，布局图的颜色全部取自 `--anime-*` 变量；另一种观感是开着「应用背景」时面板半透明。桌面主窗口最小宽度 800 px、不会进入紧凑档，紧凑档只在 Android / Web 出现，而这两端没有布局图与选择器。

真机记录（2026-11-11，macOS 桌面 dev，内建屏 3024×1964 Retina + DeskPad 虚拟屏 2880×1800，窗口模式）：已勾选的 case 逐项验过。DeskPad 退出再打开两轮，虚拟屏的 UUID 两次都没变（`6AB09FEA-0057-4678-849E-35DB7AC67923`），应用重启前后也相同。未勾选的 case 需要改系统的显示器设置、真实外接显示器或其它平台。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S0 单测与检查 | 桌面 | `check-kabegame` 全量（另跑 `--mode web --skip vue` 与 `-c kabegame-cli --skip vue`）；kabegame crate 按 `wallpaper` 过滤；前端 vitest 全量 | 0 error；全过 | 覆盖：排序、光标命中（含负坐标、右下边界、空角）、去抖（稳定才提交、中途又变重新计时、变回去不提交）、Y 翻转与主屏判定、`ScreenInfo` 的 JSON 形状；另有两条读真机的用例：屏列表（恰一块主屏在原点、UUID 形态、互不重叠）、光标换算与窗口服务报的位置一致。前端：`layoutScreens`（单屏、并排、负坐标、竖屏、不重叠、空输入）、屏与目标的对应、在线屏跟随事件（含读取在途时事件优先）、布局组件（三种显示器模式的高亮与选中、角标、块小时省略文字、已断开列表）、壁纸窗口收到屏幕事件不重新取壁纸 |
| [x] | S1 列屏 | macOS，两块屏 | kabegame-dev `invoke list_wallpaper_screens`，与 `system_profiler SPDisplaysDataType`、`CGDisplayBounds` / `CGDisplayCreateUUIDFromDisplayID` 对照 | 两项，主屏在前；`id` 是 UUID（36 位、大写、4 个连字符）且与 `CGDisplayCreateUUIDFromDisplayID` 相同；`x/y/width/height` 与 `CGDisplayBounds` 相同（点，主屏在原点）；`pixelWidth/Height` 是物理分辨率；`scale` 为 2；名字是 `NSScreen.localizedName` | 实测内建屏 `(0,0,1512,982)` 3024×1964，DeskPad `(1512,0,1440,900)` 2880×1800 |
| [x] | S2 布局图 | macOS，两块屏 | 打开设置 → 壁纸（⌘, 弹窗与 `/settings` 页各一次）；开、关「应用背景」各看一次 | 「显示器布局」下画出两块屏，相对位置、大小比例与系统「显示器」排布一致（副屏在主屏右边、上边对齐、略小）；每块显示序号、名字、分辨率，主屏带「主屏」角标；两块同色高亮；文字不溢出、块之间有缝；说明文字为「所有显示器显示同一张壁纸…」 | |
| [x] | S3 拔 / 接显示器 | macOS + DeskPad | 开着设置页，`osascript -e 'quit app "DeskPad"'`，再 `open -a DeskPad` | 约 1 s 内布局图变成一块，下面出现「只接了一块显示器，三种显示器模式效果相同」；重新打开后约 1 s 内恢复两块，位置不变；应用日志各有一行「在线显示器变为 N 块」 | 实测两轮：退出后 1.0 s / 1.0 s、打开后 0.6–1.5 s（上限 2 s 轮询 + 300 ms） |
| [x] | S4 屏的标识稳定（DeskPad） | macOS + DeskPad | 记下虚拟屏的 `id`；退出再打开 DeskPad；重启应用 | `id` 不变 | 两轮都不变。DeskPad 换版本或重装后是否仍不变没有验 |
| [ ] | S5 屏的标识稳定（真实显示器） | macOS，外接显示器 | 记下外接屏的 `id`；拔插、换一个接口、重启电脑各一次 | `id` 不变 | 需要真实外接显示器 |
| [x] | S6 屏幕变化不动壁纸与轮播计时 | macOS + DeskPad，窗口模式，轮播开启 | 把间隔改成 1 分钟（计时从此刻起算），约 25 s 后退出 DeskPad，约 39 s 后重新打开，看下一次自动切换的时刻；另看 `get_wallpaper_targets` 与壁纸后端的调用 | 自动切换仍在改间隔后约 60 s 发生（不是从屏幕变化起算）；屏幕变化前后 `wallpaperTargets` 不变，没有新的 `setting-change`；两次屏幕变化都没有引起壁纸后端 `set_wallpaper` | 实测切换在 60.9 s；debug ingest 里 `on_screens_changed` 之后直到定时切换之间没有 `window_set_wallpaper` |
| [x] | S7 显示器模式选择器 | macOS | 看设置页「显示器模式」；鼠标停在三个选项上；点两个置灰的选项 | 排在「壁纸模式」之后；「各屏复制」选中，「跨屏拼接」「逐屏独立」置灰（鼠标为禁止状）；停在置灰项上显示「该显示器模式将在后续版本提供」，停在「各屏复制」上显示「所有显示器显示同一张壁纸」；点置灰项没有反应、不报错，`get_wallpaper_display_mode` 仍是 `multiple` | 窗口模式下在界面上验；原生模式只核对了能力表（同样只开放 `multiple`，另两项带同一条原因），没有切过去看界面 |
| [x] | S8 设置页分层后各行照常 | macOS，窗口模式 | 行的顺序；改样式（填充 → 适应 → 填充）；改间隔（+ / −）；关开轮播；改过渡为「淡入淡出」；当前壁纸是场景 / 网页壁纸时点「壁纸属性」 | 顺序：打开壁纸、壁纸模式、显示器模式、启用壁纸轮播、轮播间隔、显示器布局、当前轮播路径、当前壁纸、壁纸显示方式、过渡效果、暂停壁纸、壁纸音量、视频播放速率、场景后处理、Wallpaper Engine 目录。样式写进 `multiple.style.window` 且控件不卡在禁用；间隔 60 → 70 → 60；轮播关开正常、打开时不立刻切；改过渡后立刻切一张演示，「当前壁纸」一行跟着换；属性弹窗能打开 | 第三层的写命令现在都带 `target: "multiple"` |
| [x] | S9 窄窗口 | macOS | 把主窗口缩到最窄（800 px）看设置页壁纸分区 | 没有横向滚动条；显示器模式三项放得下；布局图居中、文字不溢出；「当前轮播路径」「当前壁纸」的标题不被挤窄，路径以省略号截断；弹窗里路径仍完整显示 | 顺带修复的那一处 |
| [x] | S10 点布局图里的屏 | macOS，两块屏 | 点任一块屏 | 两块仍一起高亮；`localStorage` 的 `kabegame-settings-wallpaper-target` 记为 `multiple`；下面各行不变 | `multiple` 下只有一个目标 |
| [x] | S11 日志与控制台 | macOS dev | 做完以上操作后看主窗口控制台与应用日志 | 没有新增的 error；warn 只有场景壁纸退回预览图这类与本期无关的既有项 | |
| [ ] | S12 改排布、分辨率、主屏 | macOS，两块屏 | 系统设置里拖动副屏到主屏左边 / 上边；改副屏分辨率；把副屏设为主屏 | 布局图 2 s 左右跟上：副屏移到对应一侧（坐标为负也画得对）；分辨率数字更新；「主屏」角标与序号 1 换到新的主屏 | 需要改系统显示器设置；几何由 `layoutScreens`、`to_screen_infos` 的单测覆盖 |
| [ ] | S13 镜像显示 | macOS，两块屏 | 系统设置里把两块屏设为镜像 | 布局图只画一块并出现单屏说明；取消镜像后恢复两块 | 需要改系统显示器设置 |
| [ ] | S14 三块及以上、竖屏 | macOS，多块外接屏 | 接三块屏（其中一块竖放） | 每块都画出，竖屏是高块；很小的块只留序号，悬停能看到完整信息 | 需要多块显示器 |
| [ ] | S15 合盖 / 显示器睡眠 | macOS 笔记本 + 外接屏 | 合上盖子只用外接屏；再打开 | 布局图跟着变，主屏角标换到外接屏；打开后恢复；应用不卡死 | 需要外接显示器 |
| [ ] | S16 没有屏幕枚举的平台 | Windows；Linux | 打开设置 → 壁纸 | 没有「显示器布局」一块，其余各行顺序同 S8；显示器模式选择器照常显示（两项置灰）；`list_wallpaper_screens` 为空 | Windows / Linux 的枚举尚未实现 |
| [ ] | S17 Android | Android | 打开设置 → 壁纸 | 没有「显示器模式」与「显示器布局」，其余各行照常 | 能力表只列 `multiple` |
| [ ] | S18 Plasma 插件模式 | Linux Plasma，插件模式 | 切到插件模式看设置页 | 「显示器模式」一行消失；切回原生模式后重新出现 | 能力表在该壁纸模式下只列 `multiple` |

## 壁纸设置目标化（多显示器壁纸 P1）

2026-11-11。壁纸的轮播路径 / 位置、样式、过渡、当前壁纸从 7 个扁平设置键搬进一个键 `wallpaperTargets: { [目标 id]: 配置 }`（设置迁移 v005，全部并入 `multiple` 目标；样式与过渡按壁纸模式存），轮播开关与间隔仍是全局键；新增 `wallpaperDisplayMode` 与 `wallpaperDefaultScreen`。控制器新增 `DisplayMode` / `Placement` / `Layout`，manager 的 `set_wallpaper` 一次带齐文件、样式、过渡与布置，后端不再反读设置；能力改成「壁纸模式 → 三个显示器模式各自的可用性 / 样式 / 过渡」。轮播到点对每个活跃目标各切一张，`rotate(Option<目标>)` 可只切一个目标。命令加可选 `target`，新增 `get_wallpaper_targets` 等 7 个命令、删除 5 个扁平 getter；app IPC 协议升到 v5。前端经 `useWallpaperTarget` 系列读目标。说明见 `cocs/wallpaper/MULTI_SCREEN.md`、`cocs/wallpaper/ROTATION_PATHQL.md`、`cocs/cli/CLI_IPC.md`。

这一期只有 `multiple`（所有显示器同一张）可用：显示器枚举是空实现，`span` / `single`、每屏一窗、显示器布局图与目标选择弹窗都没做，界面上没有新控件。目标是不改变用户可见行为，下面的 case 主要核对「和升级前一样」。

有意的行为变化（对应 case 已标注）：原生模式设单张壁纸不再把过渡设置改成「跟随系统 / 无」；同一条轮播路径再设一次，界面不再卡在保存中；改间隔后从改的那一刻起算一个新间隔；当前壁纸那张图只是从当前视图消失（被隐藏、移出画册）时应用背景不再被清空；原生模式下没有当前壁纸时改样式不再直接改系统壁纸位置，下次设图时带上；Windows 原生模式一次轮播只设一次系统壁纸；经 app IPC 设样式 / 过渡与界面走同一实现（按能力校验并重新输出）。

已知取舍：样式 / 过渡按壁纸模式各记各的，只在目标第一次进入某个模式（该模式名下还没有值）时沿用旧模式的值，所以窗口 → 原生 → 窗口一圈之后，窗口模式原来的样式 / 过渡原样保留（P3 后半改定；这一期刚落地时是「旧模式的有效值新模式支持就带过去」，一圈之后不一定恢复）；全量的目标 map 每次写入都随 `setting-change` 广播，轮播每切一张发两次；Plasma 插件模式由 Plasma 侧的插件自己读设置，插件源码不在本仓库，它若直接读旧的扁平键需要同步修改（T30）。

真机记录（2026-11-11，macOS 桌面 dev，单屏）：已勾选的 case 在窗口模式下逐项验过，T5 另验了原生模式。以下 case 只验了一部分，未勾选：T8（只等了 1 个间隔）、T11（五种样式与视频已验，重启未验）、T16（macOS 一侧符合预期，Windows 未验）、T18（窗口模式已验，原生未验）、T20（删除与回落已验，下一次切换写入默认路径未验）、T22（隐藏、移出画册已验，过滤条件未验）、T24（只验了画廊）、T28（屏幕列表为空与拒绝切换已验，手改 `settings.json` 未验）。T9 托盘「下一张」无法自动化点击，T19 重启恢复需要手动重启，均未验（托盘菜单项后来可经辅助功能触发，按光标所在屏选目标见 P3 后半 K15；T9 的计时语义仍未验）；迁移只核对了 `settings.json` 的落盘内容（与 `settings.json.bak-v4` 对得上）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T0 单测与检查 | 桌面 | `check-kabegame` 全量（vue-tsc + cargo check，另跑 `--mode web`）；kabegame-core `--lib`（`settings`、`ipc`）；kabegame crate（`wallpaper::manager`、`wallpaper::rotator`）；前端 vitest（`wallpaperTargets`、`useWallpaperTarget`、`WallpaperWindow.target`、`localSettingsMigrations`、`wallpaperRotationPath` 及受影响的 `ImageGrid` / `AlbumTreeView` 用例） | 0 error；全过 | 覆盖：v005 搬键 / 旧键胜出 / 缺键默认 / 非法类型 / 幂等；目标读写与清理；`compute_layout` 与归一化；轮播线程（到点切所有活跃目标、只切指定目标、失败不连累、改间隔、reset、permit）；IPC 不带 `target` 的旧形状请求仍能解析 |
| [ ] | T1 升级迁移（窗口模式） | Windows / macOS 桌面，旧版本数据 | 旧版本里设为窗口模式、轮播开启并指向某个画册或视图、样式「适应」、过渡「滑动」，切过几张后退出；记下 `settings.json` 的轮播路径、位置、当前壁纸 id；启动新版本 | 桌面仍是退出前那张，样式与过渡不变，设置页显示同一条轮播路径；`settings.json` 的 `schemaVersion` 为 5、7 个旧键（`wallpaperRotationPath` / `Position`、`wallpaperStyle`、`wallpaperRotationTransition`、两个 `ByMode`、`currentWallpaperImageId`）消失，`wallpaperTargets.multiple` 里路径、位置、`currentImageId` 与旧值相同，`style.window` 为 `fit`、`transition.window` 为 `slide`，`wallpaperDisplayMode` 为 `multiple`；旁边有 `settings.json.bak-v4`；下一次轮播接着当前壁纸的下一张 | |
| [ ] | T2 升级迁移（原生模式） | 桌面，旧版本数据 | 旧版本在原生模式下设过样式（Windows 另设过渡「淡入淡出」），窗口模式下另有不同的样式；启动新版本 | 原生模式的样式 / 过渡不变；`style` / `transition` 里两个壁纸模式各有一项，当前模式的值取自旧的当前值，另一个模式取自旧的 `ByMode` | Windows 才有两种原生过渡 |
| [ ] | T3 降级后再升级 | 桌面 | 升级后退回旧版本，改轮播路径并设一张壁纸，再启动新版本 | 以旧版本最后的选择为准（旧键逐字段覆盖 `multiple`），旧键没写的字段保留 | v005 单测 `old_keys_win_over_existing_target` 覆盖规则 |
| [ ] | T4 全新安装 | 新数据目录 | 首次启动，看设置页壁纸分区；设一张壁纸 | `wallpaperTargets.multiple` 已建立、显示器模式为 `multiple`；样式默认「填充」，过渡 Windows 默认「淡入淡出」、其它平台为第一项；设壁纸正常 | |
| [x] | T5 设为壁纸（单选） | 桌面，窗口模式与原生模式各一次 | 图库右键「设为壁纸」 | 桌面换成这张（窗口模式按设置的过渡切换，原生模式不额外触发淡入）；设置页「当前壁纸」更新；开着应用背景时背景跟着换；轮播开着时不被关闭 | |
| [ ] | T6 设单张不改过渡设置（行为变化） | Windows，原生模式 | 过渡设为「淡入淡出」，再从图库设一张壁纸，回设置页 | 过渡仍是「淡入淡出」（`transition.native` 仍为 `fade`） | 需在 Windows 验；升级前这里会被改成「跟随系统」 |
| [x] | T7 设为壁纸（多选） | 桌面 | 图库多选几张 →「设为壁纸」 | 新建一个桌面画册，轮播路径变成该画册的默认视图并开启轮播，立即切到其中第 1 张；画册树上该画册带轮播标记 | |
| [ ] | T8 轮播到点 | 桌面，间隔 1 分钟 | 轮播指向一个按固定顺序排序的视图，等 3 个间隔 | 开启后不立刻切；每个间隔切一张，顺序与视图一致；窗口模式下过渡动画正常；`multiple.rotationPosition` 每次加 1、`currentImageId` 跟着变 | |
| [ ] | T9 手动下一张 | 桌面，轮播开启 | 距上次切换约半个间隔时点托盘「下一张」 | 立刻切一张；下一次自动切换从这次手动切换起算一个间隔 | 轮播关闭时点「下一张」也应切一张 |
| [ ] | T10 改间隔（行为变化） | 桌面，轮播开启，间隔 1 分钟 | 刚切完一张后把间隔改成 2 分钟 | 改的时候不切；从改的那一刻起 2 分钟后切一张 | 升级前要等更久才切 |
| [ ] | T11 改样式（窗口模式） | Windows / macOS，窗口模式 | 设置页依次选五种样式；当前壁纸换成视频再试一次；重启应用 | 桌面立即按新样式显示；下拉框不卡在禁用状态；重启后样式保持 | |
| [ ] | T12 改样式（原生模式，有当前壁纸） | Windows；Linux GNOME / Plasma | 设置页改样式 | 系统壁纸立即按新样式显示（Plasma 没有「拉伸」）；WebP / AVIF 当前壁纸仍走兼容副本 | 需在对应平台验 |
| [ ] | T13 改样式（原生模式，没有当前壁纸）（行为变化） | Windows，原生模式 | 把当前壁纸那张图从图库删除（当前壁纸被清空），再改样式；之后设一张壁纸 | 改样式时系统壁纸不变、设置已保存；之后设的那张按新样式显示 | 需在 Windows 验 |
| [x] | T14 改过渡 | 桌面，窗口模式 | 轮播开着时把过渡改成「滑动」；再改成「无」；关掉轮播后再改一次 | 改成「滑动」时立刻切一张并播放滑动；改成「无」不切；轮播关着时提示「未启用轮播：过渡效果将在启用轮播后生效」、值照样保存、不切 | |
| [ ] | T15 不支持的样式 / 过渡被拒 | 桌面 dev（kabegame-dev `invoke`） | macOS 原生模式下调 `set_wallpaper_style { style: "tile" }`；任一平台调 `set_wallpaper_rotation_transition { transition: "nope" }`；调 `set_wallpaper_style { style: "fill", target: "screen:nope" }` | 分别报「当前壁纸模式不支持该样式」「当前壁纸模式不支持该过渡」「壁纸目标不在当前显示器模式的活跃集合里」；`get_wallpaper_targets` 前后不变 | |
| [ ] | T16 原生 ↔ 窗口切换时样式 / 过渡沿用 | Windows；macOS | 窗口模式设样式「适应」、过渡「滑动」→ 切原生 → 看设置页 → 切回窗口 → 看设置页 | 窗口模式与原生模式各记各的，只有原生名下还没有值时才沿用窗口的值。Windows：原生下是原生模式上次的样式 / 过渡（第一次进入时沿用「适应」，过渡「滑动」原生不支持、不写，显示「跟随系统」）；切回窗口后仍是「适应 / 滑动」。macOS：原生下样式只有「填充」、过渡「跟随系统」；切回窗口后仍是「适应 / 滑动」。桌面壁纸不变 | 预期随 P3 后半的规则改过；macOS 在逐屏目标上验过（P3 后半 K17），Windows 需在 Windows 验 |
| [ ] | T17 切模式时的兜底与中止 | Windows / macOS | 窗口模式下当前壁纸是视频或 Wallpaper Engine 壁纸时切到原生；另在画廊没有任何图片的数据目录里重复一次 | 有图片：切换成功，桌面换成画廊里的一张图片；没有图片：提示无法切换，壁纸模式不变、壁纸窗口还在、轮播照旧 | 兜底换的图不写回「当前壁纸」，设置页仍显示原来那张（升级前也是如此） |
| [ ] | T18 关开壁纸 | 桌面，窗口模式与原生模式各一次，轮播开启 | 关掉「打开壁纸」，再打开 | 关：窗口模式壁纸窗口消失、轮播停；开：恢复关掉前那张与原样式，轮播继续且接着下一张 | |
| [ ] | T19 重启恢复 | 桌面 | 设好壁纸与轮播后重启应用 | 启动后桌面是退出前那张、样式一致；轮播从当前壁纸的下一张继续；当前壁纸的文件已被移走时该项被清空、不报错 | |
| [ ] | T20 删轮播画册 | 桌面 | 轮播来源是画册 A 时删除 A | 删除前出现「正在轮播」的确认；删除后设置页轮播路径显示「默认：全画廊随机」，画册树上不再有轮播标记，轮播保持开启；下一次切换写入新的默认随机路径并从其第 1 张开始 | |
| [ ] | T21 删当前壁纸图片 | 桌面，窗口模式 | 在图库里删除当前壁纸那张（「删除文件」与「移除记录」各一次）；多选里包含它时看确认框 | 确认框带「其中包含当前壁纸」提示；删除后设置页「当前壁纸」一行消失、应用背景消失；桌面保留画面上的那张；下一次轮播照常切换 | 清空隐藏画册、整理清掉当前壁纸时同理 |
| [ ] | T22 隐藏 / 移出当前壁纸图片（行为变化） | 桌面，开着应用背景 | 画廊（不显示隐藏）里把当前壁纸那张隐藏；画册详情里把当前壁纸那张「移出画册」；加一个把它过滤掉的条件 | 图片从视图里消失，但应用背景、设置页「当前壁纸」、桌面都不变 | 升级前应用背景会被清空 |
| [x] | T23 画册的轮播入口与标记 | 桌面 | 画册树右键「设为轮播」；看画册树、右键菜单、画册页头；再点「停止轮播」 | 立即切到该画册第 1 张并开启轮播；树上该画册带轮播标记，右键菜单变成「停止轮播」；停止后标记消失、轮播关闭 | |
| [ ] | T24 查询行「用当前视图轮播」 | 桌面，画廊 / 画册 / 任务详情各一次 | 调整过滤与排序后在 ⋯ 面板点「用当前视图轮播」；原生模式下视图里含视频时再点一次 | 立即切到该视图第 1 张并开启轮播，按钮变成「正在轮播此视图」；原生模式提示视频会被跳过 | |
| [x] | T25 收藏视图的轮播标记 | 桌面 | 把正在轮播的视图收藏一条，打开 ⋯ 面板 | 该行带 ↻；关掉轮播后 ↻ 消失 | |
| [x] | T26 同一路径再设一次（行为变化） | 桌面 | 画册 A 设为轮播后在设置里关掉轮播，再对 A 点「设为轮播」；查询行同理（轮播着视图 V，关掉轮播后在 V 再点「用当前视图轮播」） | 轮播重新开启，不切换壁纸（路径没变，位置保持），成功提示正常出现，按钮 / 设置项不停在加载或禁用状态 | 升级前会卡在保存中 |
| [x] | T27 应用背景跟随轮播 | 桌面，开着应用背景 | 轮播切换几次；设一张单张壁纸 | 应用背景每次跟着当前壁纸换 | |
| [ ] | T28 显示器模式入口未开放 | 桌面 dev（kabegame-dev `invoke`） | `list_wallpaper_screens`；`set_wallpaper_display_mode { mode: "single" }`；手工把 `settings.json` 的 `wallpaperDisplayMode` 改成 `single` 后启动；`get_wallpaper_capabilities` | 屏幕列表为空；切换被拒，错误为「该显示器模式将在后续版本提供」；启动后设置被写回 `multiple`、壁纸与轮播正常；能力表每个壁纸模式下 `multiple` 可用，`span` / `single` 带 `unavailable`（Plasma 插件模式只列 `multiple`）；设置页没有新增控件 | |
| [ ] | T29 Windows 原生路径 | Windows，原生模式 | 轮播几轮（过渡分别为「跟随系统」与「淡入淡出」）；设单张；改样式；轮到 WebP / AVIF 图片 | 每次切换系统壁纸只换一次（不连闪），淡入淡出生效；样式立即生效；WebP / AVIF 正常显示并复用兼容副本 | 需在 Windows 验 |
| [ ] | T30 Linux 原生与 Plasma 插件 | Linux GNOME、Plasma（原生与插件模式） | 设单张、改样式、轮播几轮；插件模式下改样式与过渡 | 原生：壁纸与样式正确，Plasma 没有「拉伸」；插件模式：插件侧跟着换图、样式与过渡生效 | 需在 Linux 验；插件若读旧的扁平键或旧事件字段需要同步修改 |
| [ ] | T31 Android 轮播 Worker | Android | 旧版本开着轮播升级到新版本；等 WorkManager 触发；改轮播来源后再等一次；回到应用 | 升级后仍按原路径、原样式在后台换图（只换图片）；改来源后队列重建、从新来源第 1 张开始；回到应用后位置与当前壁纸同步；设置页没有显示器相关的新控件 | 需在 Android 验 |
| [ ] | T32 Web 版应用背景 | Web（`--mode web`） | 旧版本设过背景图（localStorage 有 `kabegame-setting-currentWallpaperImageId`）后换新版本打开；再对另一张图「设为壁纸」；删除这张图 | 升级后背景仍在，旧键被删、新键 `kabegame-setting-wallpaperTargets` 的 `multiple.currentImageId` 是原来的 id；设为壁纸后背景更新；删除后背景消失；壁纸相关设置项仍提示桌面版可用；控制台没有壁纸命令的调用报错 | |
| [ ] | T33 dev 工具 `app_state` | 桌面 dev | 调 `app_state` | 返回里有 `displayMode` 与 `targets`（目标 id → 配置），没有 `transition` / `transitionByMode` / `styleByMode` | |

## 收藏视图（查询行 ⋯ 面板）、画廊不再恢复上次路径、去掉 chip 显隐开关

2026-11-10 macOS dev。查询行 ⋯ 面板新增「收藏的视图」：前端 Dexie 库 `kbg-saved-views` 按来源（画廊 / 画册 / 任务 / 畅游）分区，存不含根前缀 / hide / no-album / 分页尾的查询体；名字可空（为空即用路径），显示名不分大小写唯一；面板打开时读一次并冻结顺序，点一行只应用，收起时只给最后应用的那条记最后使用；编辑浮层可改名、用当前视图更新（预览差异后确定）；× 走与任务抽屉同款 popconfirm。组件库新增 `clickOutsideIgnore` 与 popconfirm `popperClass`，让 teleport 出去的子层不关面板。`gallery-path` 全平台改走 URL query，画廊重启后回到默认视图，本地迁移删除两个旧键；非画廊页的画廊过滤链接改为显式跳 `/gallery`。随后 ⋯ 菜单去掉 chip 显隐开关，删除 8 个 `galleryChip*` 设置并迁移清键，chip 始终显示。说明见 `cocs/gallery/SAVED_VIEWS.md`。

已知取舍：收藏存在 CEF / WebView profile 的 IndexedDB 里，清掉 profile 即丢失；差异预览按「维度 + 取值」摊平对比、不分位置；随机排序的收藏不显示轮播标记（种子不可比）。dev 下改了组件库里被两跳类型引用的 props 后，vite 的 SFC 类型缓存可能沿用旧 props（本次 `ElTooltip` 即如此，touch 中间的 `tooltip.ts` 后恢复），生产构建不受影响。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V0 单测与检查 | macOS | `check-kabegame --skip cargo`（桌面与 `--mode web`）；前端 vitest 全量；新增 `utils/savedViews.test.ts` | 0 error；全过 | 2026-11-10 Claude：两种模式 vue-tsc 0 error（只改前端与 vendored 组件库，未跑 cargo）；vitest 72 个文件 686 个用例全过，其中 savedViews 6 个 |
| [x] | V1 新增与命名 | macOS 画廊 | 换到未收藏的视图，⋯ → 「收藏当前视图」→ 输入名字回车；再换视图后留空回车 | 新行插到最前并标为当前，顶部变成「当前视图已收藏为「X」」；留空的行以等宽小字显示路径 | 2026-11-10 Claude：真机 CDP 通过 |
| [x] | V2 名字冲突与 Esc | macOS 画廊 | 新增时输入与已有名字仅大小写不同的名字；回车；按 Esc | 红字「已有名为「X」的视图」，回车不保存；Esc 只收起输入框，面板不关 | 2026-11-10 Claude：通过 |
| [x] | V3 应用与排序 | macOS 画廊 | 面板里先点 A 再点 B；收起面板再打开 | 每次点击切换视图，当前行竖条跟着移动，打开期间顺序不变；重开后 B 排第一 | 2026-11-10 Claude：通过 |
| [x] | V4 编辑浮层不关面板 | macOS 画廊 | 悬停一行点编辑；用真实鼠标点浮层内输入框、按钮；改名后点确定 | 浮层锚在行左侧；⋯ 面板始终不关；改名生效、顺序不变 | 2026-11-10 Claude：通过（首次因 dev 类型缓存未生效，见上方取舍） |
| [x] | V5 用当前视图更新 | macOS 画廊 | 当前视图已被别的收藏占用时打开编辑；换到新视图后编辑另一条 → 「用当前视图更新」→ 确定 | 前者红字指出占用的收藏、无更新按钮；后者预览新增条件粉底、按钮变「撤销更新」，确定后该行路径换新、名字保留并成为当前行 | 2026-11-10 Claude：通过 |
| [x] | V6 编辑浮层 Esc | macOS 画廊 | 编辑浮层输入框里按 Esc | 只关编辑浮层，⋯ 面板保持打开 | 2026-11-10 Claude：通过 |
| [x] | V7 移除确认 | macOS 画廊 | 点行尾 ×，先点确认框内的文字，再点「确认」 | 弹出与任务抽屉停止任务同款确认；点框内不关面板；确认后该行消失 | 2026-11-10 Claude：通过 |
| [x] | V8 来源与共用 | macOS 画册 / 任务 | 在「收藏」画册收藏一条，切到另一个画册打开 ⋯；打开任务详情的 ⋯ | 两个画册看到同一条（「所有画册共用 · 1」）；任务详情是独立的「所有任务共用 · 0」 | 2026-11-10 Claude：通过；畅游详情未单独打开，与任务同一实现 |
| [x] | V9 轮播来源标记 | macOS 画廊 | 轮播开启时，把轮播所用视图收藏一条 | 该行带 ↻，顶部动作显示「正在轮播此视图」 | 2026-11-10 Claude：通过（未改动轮播设置） |
| [x] | V10 画廊不再恢复上次路径 | macOS | 写入旧键 `kabegame-gallery-path` / `kabegame-setting-gallery-path` 后从 `/` 重新加载；会话内切到画册再从侧栏回画廊 | 两个旧键被删、画廊为默认视图；会话内切回仍是原视图 | 2026-11-10 Claude：通过 |
| [x] | V11 非画廊页的画廊过滤链接 | macOS 任务详情 | 在任务详情触发图片详情里的画廊过滤（插件） | 跳到 `/gallery?path=…plugin/…`，任务页自己的路径不被冲掉 | 2026-11-10 Claude：经 ImageGrid 的 `handleOpenGalleryFilter` 触发，未从详情面板 UI 点击 |
| [ ] | V12 紧凑档 / Android | Android | ⋯ 面板（对话框）里编辑与移除；返回键 | 编辑为叠加对话框；返回键先关编辑 / 确认，再关面板 | 未测 |
| [ ] | V13 web 版 | Web | 打开 ⋯ | 收藏区可用，无轮播动作 | 未测（`--mode web` 类型检查通过） |
| [x] | V14 去掉 chip 显隐开关 | macOS 画廊 / 画册 / 任务 | 打开 ⋯；把旧键 `kabegame-setting-galleryChip*` 设为 false 后重新加载 | ⋯ 菜单只有轮播与收藏视图，tooltip 为「视图：轮播与收藏」；所有 chip 显示在工具条上，旧键被删 | 2026-11-10 Claude：通过；设为 false 的时间、排序 chip 重新出现，更早版本残留的 `galleryChipCompact` / `galleryChipPageSize` 一并清掉；三页 ⋯ 菜单都没有开关；用户文档截图改为 `saved-views.png` |

## WPE 壁纸目录：本地导入识别、经 VFS 目录下载、目录哈希去重

2026-11-10 macOS dev。`postprocess_downloaded_image` 的 `Path` 来源认目录（WPE 壁纸目录），`wpe-import`、local-import、文件夹同步、下载四个入口共用 `ingest_wpe_dir`；WPE 行的 `hash` / `size` 改为目录哈希与目录总字节数，v051 空迁移登记回填作业 `wpe_dir_hash` 重算存量行；`downloadImage` 新增 `relocate`（只对任务 VFS 路径生效，目录即壁纸目录）；桌面 Web 服务器的 `/file` 对 WPE 目录返回清单、对目录内文件流式返回；SDK 新增 `downloadWpeWallpaper`，`kabegame-server` 插件（0.3.0）对 `x-wpe/*` 行改走它。说明见 `cocs/wpe/WPE_IMPORT.md` 第四节、`cocs/downloader-tasks/DOWNLOADER_FLOW.md` §6、`cocs/local-folder/LOCAL_FOLDER_SYNC.md`「WPE 壁纸子目录」。

已知取舍：回填作业跑完之前存量 WPE 行按目录哈希查不到，这段时间下到本机已有的壁纸会多落一份；重跑同一批壁纸仍会先把整张传完再靠哈希判重；存量同步目录里的壁纸子目录要等该目录下一次变化才被识别；旧版本已为壁纸目录建的子画册不迁移。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W0 单测与检查 | macOS | check-kabegame 全量（vue-tsc + cargo check）、`-c kabegame-cli`、`--mode web`（不开 `wpe` feature）；kabegame-core `--lib` 全量；kabegame 全量；kabegame-cli 全量；前端 vitest 全量；插件仓库 `tsc -p tsconfig.check.json` | 0 error；全过 | 2026-11-10 Claude：三种 check 0 error；core 499 过 / 1 失败（`replace_image_thumbnail_path_deletes_old_independent_thumbnail`，与本次无关：断言缩略图目录之外的文件会被删，实现只删 `thumbnails_dir` 内的）；kabegame 83、cli 27、vitest 71 + 48 个文件全过；插件 tsc 通过。`--mode android` 本机缺 `bin/android/arm64/rusty_v8-build/` 跑不了，用 `--mode web` 代替验证非 wpe 构建 |
| [x] | W1 目录哈希 | 单测 | `wpe::dir_hash` | 创建顺序不同哈希相同；改一个字节 / 改文件名 / 挪子目录哈希不同；路径与内容边界不混淆；加 `.DS_Store` / `Thumbs.db` / `Desktop.ini` 不变；符号链接跳过；与同内容单文件的文件哈希不相等 | 2026-11-10：7 个单测通过 |
| [x] | W2 后处理目录分支 | 单测 | `crawler::wpe_import::tests::ingest`：向 `postprocess_downloaded_image` 喂目录 | 原地导入得到一行 `x-wpe/web`、`size` 为目录总字节、metadata 是 `project.json`（调用方的 `metadata_id` 忽略）；再喂一次 `Ok(false)`；`relocate_to: Some` 时目录被移到目标目录、同名得到 `名(1)`；不删源时是复制；去重命中且 `delete_source` 时源目录被删、已有行的目录不动；原地去重命中不删任何东西；关去重时相同内容各入一行；非壁纸目录 / `application` 类型报错且源不动 | 2026-11-10：6 个单测通过；`move_dir_unique` / `copy_dir_unique` 另有 3 个单测 |
| [x] | W3 去重命中不改 WPE 行 | 单测 | `plain_download_hitting_wpe_row_keeps_its_identity`：WPE 行的 hash 等于某张 PNG 的文件哈希，开「自动去重」+「去重时更新元数据」后以另一个插件下载这张 PNG | 返回 `Ok(false)`；WPE 行的 `plugin_id` / `metadata_id` / `post_url` 不变 | 2026-11-10：通过 |
| [x] | W4 回填作业 | 单测 + dev 库 | `backfills::wpe_dir_hash` 单测；dev app 升级到 v051 | 入口哈希变为目录哈希、`size` 为目录总字节；目录缺失的行与普通图片原样；只有 `size` 变了的行带补丁；游标可续跑；没有 WPE 行时一批空跑完成 | 2026-11-10 Claude：3 个单测通过；dev 库（18 行 WPE）升级后 `backfill_jobs` 为 `processed 18 / total 18 / done 1 / attempts 0`，用独立的 Python 实现逐行重算，18 行的 `hash` 与 `size` 全部一致。**忙碌卡片没有肉眼确认**（作业在应用自动重启后瞬间跑完） |
| [x] | W5 本地导入：递归 | dev CLI → 主程序 | `plugin run local-import --var paths=<目录>`：目录下有网页壁纸、嵌套一层的场景壁纸、带无关 `project.json` 的普通目录（内有图片与子目录图片） | 两张壁纸各一行（`x-wpe/web`、`x-wpe/scene`，`plugin_id` 为 `wpe-import`，缩略图是目录里的 `preview.png`），壁纸目录里的预览图不单独成行；普通目录照常递归，两张图片各一行 | 2026-11-10 Claude：下载 4 张、去重 0 |
| [x] | W6 本地导入：非递归 / 根是壁纸目录 / 幂等 / 空跑 | dev CLI → 主程序 | `--var recursive=false`；`paths` 直接给壁纸目录；同一目录再跑一次；`--dry-run` | 非递归：壁纸一行 + 本层图片，子目录图片不导入；根目录本身作为一张壁纸；重跑日志「已在库中，仅补充画册成员」、去重 1；空跑日志「空跑：跳过导入」、不入库 | 2026-11-10 Claude：四项均符合 |
| [x] | W7 本地导入：`copy_to_dir` | 桌面 dev（kabegame-dev 调 `start_task`） | 与拖入文件夹画册相同的参数：`outputDir` + `userConfig { paths, recursive: true, copy_to_dir: true }`，源目录含一张图片和一个壁纸目录 | 壁纸目录整个复制到目标目录（同名目录，没有 `.kabegame-part-*` 残留），行的 `local_path` 是副本；图片照常复制；源目录不动 | 2026-11-10 Claude：符合。真实的拖拽手势没有测 |
| [x] | W8 `wpe-import` 任务 | dev CLI → 主程序 | `plugin run wpe-import --var sources= --var extraDirs=<含壁纸目录的文件夹>`，再跑一次 | 第一次新增 1、挂上 `WPE/genre/<tag>` 标签；第二次「已在库中」、摘要「新增 0，已存在 1」、任务去重数 1 | 2026-11-10 Claude：符合。「壁纸」对话框（自动发现三类来源）没有测，本机没有 Steam 版 WPE |
| [x] | W9 文件夹同步 | 单测 | `local_folder::tests` 新增 3 个用例 | 同步目录下的壁纸子目录在父画册多一行、没有子画册、目录里的文件不单独入库；目录 mtime 未变的快速路径也不补建子画册；已有子画册的目录保持原样（不写 WPE 行）；监听批次新增壁纸目录只加一行；目录内写文件不产生变化；删整个目录后行被删（全量与监听批次两条路径） | 2026-11-10：通过。桌面真机没有测 |
| [x] | W10 `relocate` | dev CLI → 主程序（最小 V8 插件） | 插件把 PNG 与三个壁纸目录写进 `tmp` 后 `downloadImage(path, { relocate: true })`；另测只读 `input` 挂载、目录不带 `relocate`、非壁纸目录、挂载根、http URL 带 `relocate` | 文件与三个目录都移到输出目录、`tmp` 里不留；同名壁纸得到 `名` 与 `名(1)`，不传 `name` 时目录名取 `project.json` 标题；壁纸行 `plugin_id` 为 `wpe-import`、metadata 是 `project.json`（插件传的 `metadata` 忽略）；`input` 报「输入挂载为只读」且源文件不动；目录不带 `relocate` 报 `Is a directory`；非壁纸目录报「目录内没有 project.json」且目录留在 `tmp`；挂载根被拒；http 照常下载 | 2026-11-10 Claude：下载 5 张、失败 4，逐项符合。`resolve_relocate_source` 另有 3 个单测（含目录内符号链接被拒） |
| [x] | W11 服务端 `/file` | 单测（真实 axum 路由 + 回环 TCP） | `http_server::tests::wpe_routes` | `/file/<WPE 目录>` 返回按路径排序的清单（不含 `.DS_Store`，`Cache-Control: no-store`）；目录内文件可取（含中文与空格文件名、大于一个流式分块的文件，带 `Content-Length`）；`Range` 仍返回 206；`..`、指向目录外的符号链接、未入库的目录、不存在的文件、子目录本身都是 404；普通图片行的响应头与内容不变，旁边没入库的文件 404 | 2026-11-10：2 个单测通过。大文件下进程内存没有实测（响应体是 256 KiB 分块的流） |
| [x] | W12 插件端到端（模拟服务端） | dev CLI → 主程序 + 回环模拟服务端 | 用实现了插件所需协议子集（`/rpc` 与 `/file` 清单 / 文件）的本地模拟服务端提供网页、场景、视频三张壁纸，`plugin run kabegame-server.kgpg --id <测试 id>` 过滤模式复制 | 日志逐文件打印进度；三类各入一行，`plugin_id` 为 `wpe-import`，`hash` 与源目录的目录哈希一致（含中文、空格文件名），标签 `WPE/genre/…` 与帖子地址带过来，视频行 `compatible_path` 指向新目录里的入口视频；任务结束后插件 `tmp/wpe` 为空 | 2026-11-10 Claude：符合。**不是对真实服务端跑的**：开启 dev app 的 Web 服务器被权限策略拒绝，服务端实现由 W11 覆盖 |
| [x] | W13 插件端到端：去重重跑 / 旧服务端 / 空跑 | 同上 | 开「自动去重」后重跑；模拟服务端对目录请求返回 404；`--dry-run` | 重跑：下载 0、去重 3，输出目录没有多出目录，`tmp/wpe` 为空，已有行的 `plugin_id` / `metadata_id` 不变；旧服务端：每张提示「服务器不支持传输 Wallpaper Engine 壁纸」并跳过；空跑：每张记一次「空跑：跳过下载」，不下载文件 | 2026-11-10 Claude：符合（验证后「自动去重」已恢复为关闭） |
| [x] | W14 下载来的壁纸能预览、删记录不删目录 | 桌面 dev（kabegame-dev） | 打开 W12 复制来的网页壁纸预览；对 W10 移进输出目录的壁纸执行「删除文件」（`batch_delete_images`） | 预览里页面正常运行（网页壁纸目录索引已包含新目录），属性面板可用；删除后记录没了、目录仍在 | 2026-11-10 Claude：预览显示页面内容，属性面板显示「这张壁纸没有可调属性」；删除后目录完好 |
| [ ] | W15 真实服务端 → 客户端 | 两台桌面（Windows 服务端 → macOS 客户端） | 服务端开 Web 服务器，库里 video / web / scene 各一张（含一张非 ASCII 文件名的壁纸）；客户端跑 kabegame-server 插件（先 `repack-crawler-plugins`），再重跑一次 | 三类各入一行并能预览，属性面板可用；两端同一张壁纸的 `hash` 一致；重跑全部计入去重、下载目录没有多出目录；拉 GB 级 `scene.pkg` 时服务端内存不随文件大小增长 | 2026-11-10 Claude：Windows 服务端（192.168.1.15:7490）→ macOS dev app，scene ×2 / web ×1 / video ×1（视频含 `初音.mp4`）各入一行，四行 `hash` / `size` 与服务端逐一一致，`plugin_id` 与 metadata 为 `wpe-import`、标签与帖子地址带过来；`tmp/wpe` 为空；开自动去重重跑 3 张：下载 0、去重 3，输出目录不多目录；网页预览与属性面板正常、视频正常播放。未测 GB 级文件下服务端内存，故不勾。注：dev app 若从带 `HTTPS_PROXY` 的终端启动、`NO_PROXY` 不含局域网段，插件访问局域网服务端会经代理得到 502 |
| [ ] | W16 升级后的回填卡片 | 桌面（有较多 WPE 壁纸的旧库） | 从 4.6.x 升级后进入界面 | 「我正在忙这些」出现「更新数据库 · 重新计算 Wallpaper Engine 壁纸的内容指纹」，跑完消失；期间图库正常可用 | 未测 |
| [ ] | W17 回填没跑完的窗口 | 同上 | 回填进行中，下载一张本机已有的壁纸 | 多落一份（已知取舍）；回填结束后再下同一张计入去重 | 未测 |
| [ ] | W18 拖入与文件夹画册真机 | 桌面 dev | 把壁纸文件夹拖进主窗口；拖进某个文件夹画册；在同步目录里新建 / 删除壁纸目录 | 都是一行 WPE 且能预览；拖进文件夹画册后目录出现在同步目录里、行挂在该画册、没有子画册；删目录后行消失 | 未测（W7 / W9 覆盖了同一条代码路径） |
| [ ] | W19 Windows 上的搬运 | Windows 桌面 | 下载目录与数据目录不在同一个盘时跑 W10 / W12 | 壁纸目录经复制落到下载目录（期间目标目录下有隐藏的 `.kabegame-part-*`，结束后消失），源被删除 | 未测 |
| [ ] | W20 Android / WebView 后端 | Android dev；桌面 WebView 插件 | Android 上对 VFS 文件用 `relocate`；WebView 插件 `downloadImage(vfsPath, { relocate: true })` | Android：文件进系统媒体库、临时文件被删，目录报不支持；WebView 与 V8 行为一致 | 未测（Android 本机无法编译；WebView 只改了命令参数与 bootstrap 透传） |

## 任务失败重试与重试记录

2026-11-10 macOS dev。任务级「失败重试」（与空跑同级，0–10 次）：运行期失败后由调度器立即按冻结快照重发新任务；任务记 `retry_count` / `retry_attempt` / `retry_root_id`（v050，历史任务回填为自身 id，索引 `idx_tasks_retry_root`）；任务行可点开「重试记录」弹出层，观察 `tasks://retry_root/<原始任务 id>`。说明见 `cocs/crawler/TASK_CONFIG.md` §8 与 `cocs/downloader-tasks/TASK_DRAWER_LOAD.md`「重试链观察方」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | R0 单测与检查 | macOS | check-kabegame（vue-tsc + cargo check）；kabegame-core `--lib` 过滤 `retry`、`run_config migrations commands::task task_scheduler storage::tasks scheduler albums`；`--test dsl_e2e`；前端 vitest 全量 | 0 error；全过 | 2026-11-10 Claude：cargo / vue-tsc 0 error；core 6 + 121 个、dsl_e2e 62 个、vitest 71 个文件 680 个用例全过 |
| [x] | R1 迁移与链索引 | 单测 | v050 在只有 id 的旧表上跑两次 | 列各一份；历史任务 `retry_root_id` 回填为自身 id；链查询走 `idx_tasks_retry_root` | 2026-11-10：`v050_task_retry` 两个单测通过 |
| [x] | R2 重试链路由 | dsl_e2e | `tasks://retry_root/root` | 只返回本链、按 attempt 倒序；空列的旧行读出自身 id | 2026-11-10：`tasks_retry_root_lists_one_chain_newest_attempt_first` 通过 |
| [x] | R3 运行期失败按次数重发 | 桌面 dev | 网页收集填必失败的地址（如 `http://127.0.0.1:1/`），失败重试设 2 | 出现 3 个任务，徽标「重试 0/2」「重试 1/2」「重试 2/2」；前两个日志有「已提交第 k/2 次重试」；第 3 个失败后不再重发 | 2026-11-10 Claude（kabegame-dev，macOS）：`start_task` 发起，约 17 s 内 3 个任务依次失败（502），三者 `retry_root_id` 都是原任务、`retry_count` 2、attempt 0/1/2；前两个任务日志各一条 `taskLogRetrySubmitted`（1/2、2/2）；链结束后再等 5 s 仍是 3 行；抽屉里徽标显示正确 |
| [x] | R4 重试记录弹出层 | 桌面 dev | 链跑完后从中间那个任务点开「重试记录」；行内点看图、看日志、运行参数 | 3 行从新到旧，当前任务高亮；三个动作都能用；弹出层开着时出现新的重试会自动多一行，状态与进度就地变化不闪 | 2026-11-10 Claude：从「重试 1/2」打开，3 行从新到旧、第 1 次高亮；另起重试 3 的链并在打开状态下按 250 ms 采样：9.5 s / 19.3 s / 30.4 s 依次多出第 2、3 次，「运行中」就地变成「失败」；行内运行参数弹窗叠在弹出层之上（z 2020 > 2010） |
| [x] | R5 删除后的占位 | 桌面 dev | 删除链中间的任务后再打开；再删原始任务 | 对应位置显示「任务已删除」；第 0 行是占位 | 2026-11-10 Claude：弹出层开着时删原始任务，约 1.5 s 内第 0 行变「原始 任务已删除」；另一条链删第 2 次，显示「第 2 次 任务已删除」，其余三行不变 |
| [ ] | R6 取消不重试 | 桌面 dev | 重试设 3，在第一次重试运行中途取消 | 链停止，不再生成新任务 | 未测（代码路径：取消落到 `Canceled`，worker 只在 `Failed` 时调用重发） |
| [x] | R7 再次执行与原始任务 | 桌面 dev | 在重试出来的任务上点「再次执行」；在运行参数里点「原始任务」 | 弹窗回填「失败重试 3」（不是减过的次数）；跳到第 0 次任务的详情页并关闭运行参数弹窗 | 2026-11-10 Claude：「重试 3/3」任务的运行参数显示「3 次 · 第 3/3 次重试」，点原始任务 id 后弹窗关闭、路由到 `/tasks/<原始 id>`；该任务详情页 header「再次执行」打开网页收集，失败重试开关开、次数 3 |
| [x] | R8 运行配置与定时 | 桌面 dev | 运行配置设重试 1 并触发定时；运行配置详情的任务列表里点行内重试图标 | 重试任务带 runConfigId、触发来源仍是定时（闹钟按钮在）；能打开重试记录；卡片「最近结果」是最后一次的结果；配置详情显示「失败重试：1 次」 | 2026-11-10 Claude：`add_run_config`（retryCount 1、每天）后 `run_missed_configs` 触发，2 个任务都是 `scheduled` + 该 runConfigId，第 1 次的链根是定时任务；`last_result` failed、`last_task` 指向第 1 次；配置详情显示「失败重试 1 次」，行内 `RefreshRight` 打开重试记录。**发现并修复**：弹出层原先在弹窗之后（z 低于配置详情），改为 `useModal` 占栈位取 z-index 后在其上；`retryCount: 11` 被后端拒绝 |
| [x] | R9 历史任务与表单 | 桌面 dev | 看迁移前的任务；收集弹窗开关关闭 / 打开填 10 / 输入超过 10 | 历史任务无重试入口、运行参数「失败重试：关闭」；提交 retryCount 0 / 10，超过 10 钳到 10 | 2026-11-10 Claude：迁移后历史任务 `retry_root_id` 等于自身 id、count/attempt 为 0；网页收集表单输入 15 失焦后为 10，关开关后数字框隐藏，再打开默认 3 |
| [ ] | R11 弹出层锚点滚出列表 | 桌面 dev | 抽屉里打开某任务的重试记录，期间有新任务插入使该任务被挤出列表可视区 | 弹出层仍跟随锚点 | 已知问题：弹出层跟着锚点被推到窗口底部、只露出标题，点空白处可关；未修 |
| [ ] | R10 Android 返回键 | Android dev | 打开重试记录弹出层后按返回键 | 关掉弹出层 | 可选 |

## 场景壁纸 P7e：varying 的布局

2026-11-14 Windows。WebGPU 缺省只保证 16 个阶段间变量，语料里 5 张场景的着色器超过（工坊 `auto_sway` 17–31 个、示波器 35 个），运行时建管线失败、整张退回预览图。翻译器照 WPE 做两件事：
- varying 数组按 WPE 的长度声明：`vec3` / `vec4` 数组只剩 `ceil(n/4)` 个元素，`n = 1` 时退化成普通向量；
- 超过 16 个 location 时把浮点 varying 装进 vec4，作者的 `main` 改名 `kb_main`，由生成的入口装箱 / 拆包。

不超过 16 个的程序输出逐字节不变。WPE 编不过、片元或顶点回退的写法不复刻（语料 0 处）：`n = 1` 退化后 `.xyz` 等多分量取法与把它交给构造函数、常量下标越界，我们整张退回；循环写过缩短后的长度、顶点 `main` 里的裸 `return;`，我们照常渲染。语料不解锁场景，但 3585875739 从此运行时能画。收尾时另修了 V7 发现的问题：上界是字面量 0 的 `smoothstep` 照 fxc 的化简算（V8）。说明见翻译器 README「绑定布局」「varying 超过 16 个时打包」与 `cocs/wpe/WPE_SCENE.md`，数据见 `.claude/plans/wpe-import/3-scene/phase7/phase-7e-varyings.md`「实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V1 WPE 的规则 | Windows，读码 + WPE 抓帧 | `FUN_1400f52e0` 读码；确定性工程 `p-va`、`p7e-va` 与示波器抓帧；`p7e-diag` 让 fxc 打出警告 | 数组长度公式与 `n = 1` 退化的语义查清 | 2026-11-14 Claude：签名与公式逐项相符；`n = 1` 时写只写 `.x`（X3206）、读成标量铺满，`.xyz` 是 X3018、构造函数是 X3014，都是片元回退 |
| [x] | V2 翻译器单测与基线 | Windows，cargo | `cargo test -p wpesl2wgsl`；在 HEAD 重录请求夹具并导出基线，改后重放比较 | 全过；只有示波器与 `auto_sway` 的输出变 | 2026-11-14：lib 94 个全过；921 个请求 `ok` 与夹具一致；4484 个文件相同 4460、变了 24（示波器 1 个请求、`auto_sway` 5 个请求，各 4 个文件），新通过 / 新失败 0 |
| [x] | V3 变异检查 | Windows，cargo | `ignore/p7e/mutate_rs.py`：打包不排序、拆包错位、先装箱再跑作者代码、阈值 15 / 17、`n = 1` 仍按数组、数组不缩短、片元声明全部 vec4 | 都被单测检出 | 2026-11-14：8 / 8，按原字节还原 |
| [x] | V4 语料与 Tint | Node 快照 + dev | 同一份产品源码配新旧 wasm 各扫一次语料；统计每个程序的 location；变了的 WGSL 在应用里过 Tint | 语料逐张不变；没有程序超过 16；Tint 0 错 | 2026-11-14：183 张逐张相同（干净 87）；改后最多 13 个 location；12 份 WGSL 0 error 0 warning |
| [x] | V5 确定性工程 | Windows dev，屏外宿主 + WPE 抓帧 | `p7e-va-ok`、`p7e-osc`、`p7e-vpack` 导入 dev 库，1920×1080 和 WPE 逐格比 | 我们能翻译、WPE 也编得过的格子一致 | 2026-11-14 Claude：`p7e-va-ok` 14 种差 0（含 `v4n32` 与 `n = 1` 的两种读法）；`p7e-osc` 36 格、全图最大差 0；`p7e-vpack` 无 `return` 那层 32 格一致，带 `return` 那层（WPE 编不过）和解析式差 ≤ 1。改前三张都建管线失败 |
| [x] | V6 语料场景强制渲染 | Windows dev，屏外宿主 | 3243449890、3486806915、3492627662、3516174947、3585875739 各渲染一帧，看应用日志 | 不再有「location 超限」 | 2026-11-14 Claude：四张渲染成功；3486806915 卡在加载前的自查 `render:texture-missing:1`（多图纹理动画 `鸟_00020.tex`，不支持项 `tex:animation:multi-image`），与本节无关 |
| [x] | V7 真实着色器对照 | Windows dev + WPE 抓帧 | 3492627662 的 `auto_sway` 图层、3585875739 的示波器图层各做复制工程（`kbp content isolate`），按 WPE 帧时间回放逐 pass 比 | varying 一致 | 2026-11-14 Claude：`auto_sway` 3 个图层 × 4 帧，基础 pass 0 差，`auto_sway` pass 最大差 1（按 WPE 的 31 个 varying 复算采样坐标，差的像素都在纹素过滤量化边界上，是 sin / cos 的 float32 误差）；示波器 WPE 的 `TEXCOORD0`–`10` 与我们的 location 0–10 一一对应，喂录到的频谱时改动区域交并比 0.978–0.997。**另发现的问题**：静音时示波器的 `smoothstep(线宽 0, 0.0, dist)`，fxc 化简出 `-0` 得 0、我们得 1，整张提亮约 39%，已在 V8 修好 |
| [x] | V8 上界是字面量 0 的 `smoothstep` | Windows，cargo + dev + WPE 抓帧 | 翻译器换成照 fxc 算的 `kb_smoothstep0`；确定性工程 `p7e-ss0`（下界 +0 / -0 / 整数 0 / 向量 / 非零 / 字面量对照）1600×900 和 WPE 逐像素比；示波器静态底图复制工程按 WPE 帧时间回放，逐 pass 比 | 一致；其余着色器输出不变 | 2026-11-14 Claude：六个图层最大差 0 / 0 / 0 / 0 / 1 / 1（差只在图层边缘，是已知的上屏缩放）；示波器 pass 与 shake pass 四帧 0 差，整帧平均差 78.1 → 0.88；语料基线只有 12 个片元着色器变（示波器、swing、vhs、流体 advection），Tint 0 错；变异 6 / 6 检出 |
| [ ] | V9 预览里看示波器 | Windows，窗口模式 | 图库预览打开 3585875739，放一段音乐 | 示波器随音乐跳动，和 WPE 打开同一张观感一致 | 可选，待用户确认 |

## 场景壁纸：单级 mip 纹理的各向异性过滤

2026-11-14 Windows。`samplerDescriptor` 原先只给多级 mip 的文件纹理开 8 倍各向异性，单级 mip 的（effect 遮罩、视频）只用双线性。WPE 对文件纹理一律 Anisotropic 8x，只有 NoInterpolation 时点采样（rea-p8-layer 3.2，视频见 p9-REPORT）。改成不看 mip 级数。问题由 P12a 走查发现（`ignore/p12/a/final/report.txt` B1）：3811769317 的 cloudmotion 用带噪声偏移的第二次采样读遮罩，导数被拉长，两种过滤差到 204 级。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | A1 单测 | Node | `render.test.ts`「采样器与所需特性」 | 单级 mip、非点采样得 linear mip + 各向异性 8；点采样仍是 1 | 2026-11-14：44 个通过 |
| [x] | A2 复制工程对照 | Windows dev + WPE 抓帧 | `ignore/p12/a/final/proj/3811769317-iso-pup` 按 WPE 日志回放 275–280 帧（2560×1046、超高档、跑脚本），和 P12a 走查时的 WPE 抓帧逐帧比 | cloudmotion 的大差消失 | 2026-11-14 Claude：改前每帧约 4900 个像素、最大 98–204；改后 10–417 个、最大 1–2（剩下的是走查已登记的 waterripple 末位与泛光链）。`cmp/3811769317-iso-b1.txt` |
| [x] | A3 画面哈希 | Windows dev，屏外宿主 | 10 张场景三档各渲染两次；变了的 3 张临时退回旧规则再记一份 | 只有用到单级纹理缩小 / 斜向采样的场景变，变化全部来自本改动 | 2026-11-14 Claude：30 组全部稳定、`unsupported` 不变；beach、deep_space、razer_vortex 的哈希变了，退回旧规则的 A 组与旧基线逐个相同，其余 7 张不变。`ignore/p7e/hash-b1*.json`。这 3 张没有再和 WPE 重比 |
| [ ] | A4 预览观感 | Windows，窗口模式 | 图库预览打开 3811769317 | cloudmotion 扭曲区域的边缘没有闪烁的硬边 | 可选，待用户确认 |

## 场景壁纸：材质遮罩的通道组合键（F1）

2026-11-15 Windows。`generic4` / `genericimage2/4` 的 PBR 遮罩槽注解带 `components`（METALLIC / ROUGHNESS / REFLECTION / EMISSIVE_MAP），WPE 按遮罩纹理头标志的 bit 20–23 逐项置这几个组合键（`FUN_14016c800`），翻译器原先只置顶层 `PBRMASKS`。翻译器 `BoundTexture` 加 `flags`，宿主给文件纹理传头标志。依据见 `.claude/plans/wpe-import/3-scene/PLAN.md` P7 节 F1 条；对方的取证在 `ignore/p12/b2/check1/F1-emissive.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | F1-1 单测 | Rust / Node | 翻译器 `component_combos_follow_texture_flags`；宿主 `particles.test.ts` 的缓存键用例 | 只置标志里对应的对象条目、非对象条目不计序号、没绑不推、请求值最后覆盖；低位不进缓存键 | 2026-11-15：翻译器 107 个、宿主相关 156 个全过 |
| [x] | F1-2 复制工程对照 WPE | Windows dev + WPE 抓帧，1920×1080，后处理超高 | `ignore/p12/b2/check1/proj/3706286085-iso-boost-nl` 回放 401–406 帧、原样副本 412–417 帧，和 WPE 逐帧比 | Sonic 的手套、鞋、扣子亮度和 WPE 一致 | 2026-11-15：> 32 的像素 nl 每帧 1.5–2.0 万 → 0.12–0.29 万，第 403 帧 45 个、最大 1；原样副本 0.7–1.1 万 → 0.15–0.21 万（`ignore/f1/cmp-*.txt`），剩下的归 P12b2 的 K2 |
| [x] | F1-3 语料 | Node，`kbp corpus scan` 两份快照（同一 wasm，只差传不传 `flags`） | 比 unsupported，统计置了子组合键的请求 | unsupported 不变 | 2026-11-15：干净 175 → 175、没有键增减；20 个请求、8 张场景用到，目前都被别的能力挡着 |

## 场景壁纸：阶段间变量的设备上限与 HLSL 类型名（P7 补漏）

2026-11-18 Windows。语料清扫转来的两处翻译器缺口：打包后仍超过 16 个 varying 的程序照样翻译、反射报 `interStageLocations`，宿主按适配器申请 `maxInterStageShaderVariables`、`createProgram` 比设备上限；宏头补 HLSL 类型名（`float2` 等）。依据见 `.claude/plans/wpe-import/3-scene/PLAN.md` P7 节「语料清扫转来的两处缺口」，数据在 `ignore/p7fix/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | IS1 单测与变异 | Rust / Node | 翻译器 `packing_above_sixteen_reports_locations`、`packing_failures_are_rewrite_errors`、`packing_overflow_is_a_rewrite_failure`、`hlsl_type_names_translate`；宿主 `render/interStage.test.ts`；去掉 `float2` 宏、去掉设备上限检查各做一次变异 | 全过，变异都被抓到 | 2026-11-18：翻译器 114 个、宿主相关 128 个全过 |
| [x] | IS2 语料 | Node，`kbp corpus scan` 两份快照（同一份源码，只差改前 / 改后的 wasm） | 比 unsupported | 只去掉两个键、不新增 | 2026-11-18：干净 214 → 216（3348595482、3612971233），没有新增键 |
| [x] | IS3 输出不变 | Rust，翻译请求夹具重放 | 1351 个夹具分别用改前 / 改后的翻译器导出，比两边都有的 WGSL | 逐字节相同 | 2026-11-18：2672 个 WGSL 全相同，只多出这两个着色器的 5 个程序 |
| [x] | IS4 两张场景能渲染 | Windows dev，屏外宿主（`render_scene`） | 渲染 3612971233（15024）、3348595482（15006） | `unsupported` 为空、画面正常 | 2026-11-18：本机适配器的 `maxInterStageShaderVariables` 是 28；两张都画出来了 |
| [ ] | IS5 预览与桌面 | Windows，图库预览、窗口模式 | 预览两张，放音乐看示波器 | 实时渲染、示波器随声音动 | 待真机 |
| [ ] | IS6 别的显卡 | AMD / Intel / macOS | 预览 3612971233 | 上限够时能渲染，不够时退回预览图并报 `render:program:*:inter-stage:18` | 本机测不了 |

## 场景壁纸：着色器里的 HLSL 流程控制属性（P7 补漏）

2026-11-20 Windows。myprojects 的 3784410673 只挡在工坊 effect `audio_yuan.frag` 循环前的 `[loop]`：翻译器在改写阶段把 `for` / `while` / `do` / `if` / `switch` 前的 fxc 语句属性（`[loop]`、`[unroll(n)]`、`[branch]` 等）换成空白。依据见 `.claude/plans/wpe-import/3-scene/PLAN.md` P7 节「HLSL 流程控制属性」，数据在 `ignore/loop/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | FA1 单测与变异 | Rust | 翻译器 `flow_attributes_are_stripped`、`hlsl_flow_attributes_translate`；去掉 `strip_flow_attributes` 的调用做一次变异 | 全过，变异被抓到 | 2026-11-20：翻译器 122 个全过；变异后 `hlsl_flow_attributes_translate` 失败 |
| [x] | FA2 语料 | Node，`kbp corpus scan` 两份快照（同一份源码，只差改前 / 改后的 wasm），语料 + myprojects | 比 unsupported | 只去掉 `audio_yuan` 的解析错误、不新增 | 2026-11-20：523 张，干净 521 → 522（3784410673），没有新增键 |
| [x] | FA3 输出不变 | Rust，翻译请求夹具重放 | 1659 个夹具分别用改前 / 改后的翻译器导出，逐文件比 | 两边都有的逐字节相同 | 2026-11-20：6588 个文件（3294 个 WGSL）全相同，只多出 `audio_yuan` 的 4 个 |
| [x] | FA4 场景能渲染 | Windows dev，屏外宿主（`render_scene`） | 渲染 3784410673（15990） | `unsupported` 为空、画面正常 | 2026-11-20：画出来了，右侧的音频圆环在没有声音时是一圈点 |
| [x] | FA5 预览与桌面 | Windows，图库预览、窗口模式 | 预览 3784410673，放音乐 | 实时渲染、圆环随声音起伏 | 2026-11-20 用户：正常 |

## 场景壁纸 P7d：流体 effect 的条件结构、没被读的 uniform、`g_LayerModelMatrix`

2026-11-13 Windows。四项改动：
- 翻译器反射标出没被读到的 uniform（`unused`），宿主照 WPE 的反射规则用它算材质常量槽位、取两阶段同键的合并类型、跳过能力检查；
- `g_LayerModelMatrix` 只在 effect pass 里支持（图层世界矩阵）；
- effect 的 `conditions` 按实例顶层 `combos` 在编译期求值，`functions` 放开；
- fbo `clear` 要 4 个分量。

语料去掉 `constant:*` 5 处、`uniform:g_FrameTime` 1 处、`uniform:g_LayerModelMatrix` 4 张、流体的四个 effect 键，不解锁场景：这几张都还缺文本、音频、视频等。说明见 `cocs/wpe/WPE_SCENE.md` 与翻译器 README「没被读的 uniform」，数据见 `.claude/plans/wpe-import/3-scene/phase7/phase-7d-fluid.md`「实施记录」与 `p7-REPORT.md`「P7d」两节。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | D1 WPE 的规则 | Windows，REA + WPE 抓帧 | 条件与 `functions` 读码；`p7d-fluid` 六个变体、`p7d-uni`（含开视差）抓帧读常量缓冲 | 规则查清 | 2026-11-12 Claude：条件只按实例顶层 `combos`、不并进 pass；槽位按键名排序、只给被使用的键；`g_LayerModelMatrix` 是世界矩阵、只在 effect pass 写、不带视差；`g_FrameTime` 没人写 |
| [x] | D2 翻译器 `unused` | Windows，cargo | `cargo test -p wpesl2wgsl`；重放夹具、对 P7c 基线比较 | 全过；WGSL 逐字节不变 | 2026-11-12：77 个单测；798 / 798；4020 个文件变了 0 |
| [x] | D3 宿主 `unused` 与语料 | Node，HEAD 快照 | 新旧 wasm 各扫一次语料，比较 | 只去掉 6 个误报键 | 2026-11-12：`constant:mixed-type` 3、`constant:slots` 2、`uniform:g_FrameTime` 1；能渲染的场景取值不变（只有 `frame_builder_by_gariam` 的一个键改按 `vec2` 写，所在场景不能渲染） |
| [x] | D4 `g_LayerModelMatrix` | Windows dev，屏外宿主 + WPE 抓帧 | 工坊 `rounded_mask` 挂在四个缩放、旋转各不相同的图层上（`ignore/p7d/gen_rmask.py`），1920×1080 和 WPE 逐像素比；测后 `projects_remove` | 一致 | 2026-11-12 Claude：最大差 0；单测和 `p7d-uni` 抓帧的矩阵逐值核对（含父链） |
| [x] | D5 流体结构 | Node，HEAD 快照 | 六个流体变体的计划与 WPE 抓帧逐项比（绘制数、目标尺寸格式、各槽来源、实例覆盖） | 逐项相同 | 2026-11-12：80 / 80 |
| [x] | D6 流体单步隔离 | Windows dev，探针 `__kabegameSceneProbe.fluid` | 把 WPE 某帧开始时的模拟 RT 灌进 fbo，跑一帧，逐个 RT 和 WPE 这一帧的输出比 | 只差半精度舍入 | 2026-11-12 Claude：旋度、染料、合成 RT 逐位相同；速度、压力、散度只有个别值差 1–4 ulp（第 122 帧经散度放大到 184 ulp 的单点）；我重跑第 121 帧数字一致 |
| [x] | D7 流体长程统计 | Windows dev，探针 + WPE 三次运行 | 按 WPE 帧时长跑 167 帧，读回第 154–167 帧的画布，和 WPE 比 | 落在 WPE 自身两次运行之间 | 2026-11-12 Claude：平均差 8.34 / 10.50 / 15.45（WPE 之间 8.79 / 11.97 / 14.55）；帧间变化量、火焰覆盖与 WPE 几乎相同 |
| [x] | D8 收尾 | Windows，cargo + dev | 换上新 wasm；HEAD 快照重录夹具并重放，对 P7c 基线比较；新增 WGSL 过 Tint | 全过；原有输出不变 | 2026-11-13：853 / 853；原有 4012 个文件变了 0，少的 8 个是流体 normal pass 与 combine 的旧请求（条件生效后不再发出或请求换了哈希，WGSL 相同）；新增 114 份 WGSL 0 error 0 warning；能渲染 47 张，P7d 相关键 0 处 |
| [ ] | D9 预览里看流体 | Windows，窗口模式 | 导入 `ignore/p7d/proj/p7d-fluid`，在图库预览里看一会儿，和 WPE 打开同一工程对照 | 火焰形状、亮度与流动速度和 WPE 观感一致 | 可选，待用户确认；本机语料里用流体的场景还不能渲染 |

## 场景壁纸 P7c：HLSL 隐式转换

2026-11-12 Windows。嵌入的 naga GLSL 前端加 HLSL 模式（翻译器打开），规则照 fxc 实测：截断、铺满、混算截到窄的、非布尔条件 `!= 0`、`float → int` 向零截断、浮点下标、`bool` 参与算术、用户函数重载唯一可行才选；改写阶段让片元 varying 按顶点的类型、全局 `const` 引用 uniform 时在 `main` 开头现算。只在 GLSL 本来会报错的地方生效。语料里不再有因着色器翻译退回的场景，能渲染 39 → 42。说明见 `src-tauri/wpesl2wgsl/README.md`「HLSL 隐式转换」与 `naga/KABEGAME.md`，数据见 `.claude/plans/wpe-import/3-scene/phase7/phase-7c-hlsl-implicit.md`「实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C1 fxc 与 WPE 语义 | Windows，本机 fxc + WPE 抓帧 | `ignore/p7/fxc/c1–c4.hlsl`；`p7-sem` 的 `kbconv1–4` | 和预测一致 | 2026-11-12 Claude：用户函数多个可行重载 fxc 报二义；向量 `?:` 逐分量；`static const` 引用 uniform 现算；四层 WPE 颜色与预测一致 |
| [x] | C2 逐字节基线与夹具 | Windows，cargo | 对 P7b 基线比较；重放 P7b 录的夹具 | 原来通过的不变；夹具全过 | 2026-11-12：3572 个文件变了 0、新失败 0；779 / 779；WPE 安装目录 161 / 167；几何 27 / 27 |
| [x] | C3 单测 | Windows，cargo | 翻译器 `--lib`、naga（`--features glsl-in,wgsl-in,wgsl-out,stderr`） | 全过 | 2026-11-12：71 个、136 个 |
| [x] | C4 Tint | Windows dev，主窗口 | 新基线 2010 份 WGSL 加产品前言逐份编译 | 0 error | 2026-11-12 Claude（kabegame-dev）：0 error 0 warning |
| [x] | C5 语料与解锁 | Node，173 个工程 | 同一份产品源码快照，P7 之前与 P7c 的 wasm 各扫一次 | 不再有 `shader:*` | 2026-11-12：能渲染 39 → 42（`3822495444`、`3831518461`、`3837598414`）；P4–P6 先做完的口径 56 → 62 |
| [x] | C6 Kabegame 里的规则层 | Windows dev，屏外宿主 | 导入 `p7-sem-k`（`gen_sem.py --kabegame`），`render_scene`，和 WPE 抓帧逐层比颜色；测后 `projects_remove` | 相同 | 2026-11-12 Claude：九个规则层 8 位颜色相同，`kbpack` 两边都满足 红 = 绿 = `frac(g_Time)`、蓝 = 0；导入的工程已移除 |
| [x] | C7 解锁的两张与 WPE 比 | Windows dev，屏外宿主 + WPE 抓帧 | 按场景分辨率开 WPE 窗口抓 1 帧，同一 `g_Time` 渲染，`kbp cmp frame` | 逐像素一致 | 2026-11-12 Claude：`3822495444` 最大差 2、> 0 的像素 0.117%；`3831518461` 最大差 2、0.116% |
| [ ] | C8 预览与桌面 | Windows，窗口模式 | 图库预览里打开 `3822495444`、`3831518461`，设为桌面壁纸，和 WPE 对照看一会儿 | 实时渲染，水面、光线、闪光与 WPE 观感一致 | 待用户确认 |

## 场景壁纸 P7b：照 WPE 的预处理、声明与打包数组

2026-11-11 Windows。翻译器照 WPE 自己的文本处理：`#if` 只解析一个表达式、多余的 `#endif` / `#else` / `#elif` 忽略、宏后者覆盖前者、声明名带分量只取名字、`main` 之前的 `float` 数组用打包形态（越界读到同一 cbuffer 的下一个成员）；几何展开避开 Tint 的指针别名；effect 的 `editable` 放开。P7b 单独不增加能渲染的场景（多数着色器露出类型类错误，等 P7c）。说明见 `src-tauri/wpesl2wgsl/README.md`，数据见 `.claude/plans/wpe-import/3-scene/phase7/phase-7b-rules.md`「实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | B1 WPE 语义实测 | Windows，WPE 抓帧 | 确定性工程 `p7-sem`（`ignore/p7/gen_sem.py`）：尾随分号、`v_Size.xy`、宏重定义、`main` 之前读打包数组 | 和读码一致 | 2026-11-11 Claude：四项都和读码一致；打包数组越界读到同一 cbuffer 的 `g_Time`，出缓冲为 0 |
| [x] | B2 逐字节基线 | Windows，cargo | 对 P7a 基线比较，ALLOW / ALLOW_REGRESS 列出预期变化 | 只有用到这些写法的着色器变化 | 2026-11-11：变了 4（两组绳子 + 折射）、新失败 8（`audioline`、`highly_customizable_audio_visualizer`，待 P7c；所在 4 张场景本就因音频退回）；不列 ALLOW_REGRESS 时测试失败 |
| [x] | B3 Tint | Windows dev，主窗口 | 新基线 1786 份 WGSL 加产品前言逐份编译 | 0 error | 2026-11-11 Claude（kabegame-dev）：0 error 0 warning，约 8 s |
| [x] | B4 夹具重录 | Windows，Node + cargo | 用 P7b 的 wasm 在 HEAD 产品源码快照上重扫并录夹具，原生重放 | 一致 | 2026-11-11：779 个请求，通过 689 / 失败 90，原生与 wasm 0 不一致 |
| [x] | B5 语料扫描 | Node，165 个工程 | 同一份产品源码，P7 之前与之后的 wasm 各扫一次 | 能渲染数不变，退回原因换成下一个错误 | 2026-11-11：38 → 38；`editable` 只少一个键 |
| [x] | B6 单测与检查 | Windows | `cargo test -p wpesl2wgsl --lib`、naga 单测、`apps/wpe-scene` 的 tsc / vitest | 全过 | 2026-11-11：68 个、128 个全过；tsc 0 error；vitest 1702 / 1703，`pipeline.test` 的请求次数上限（`3830255100` 219 次）在不带改动的 HEAD 上同样失败，与 P7b 无关 |
| [x] | B7 Kabegame 里的画面 | Windows dev | 重建 wasm 后在 Kabegame 渲染 `p7-sem` 的 `kbsemi` / `kbswz` / `kbredef` / `kbpack`，和 WPE 抓帧逐像素比；打开几张原本能渲染的场景 | 一致；原有画面不变 | 2026-11-12 Claude（P7c 收尾时一起做，见 C6）：四层与 WPE 一致。原有画面：原来能翻译的着色器 P7 前后输出逐字节相同，翻译器不改变它们；渲染器同期被别的会话改过，旧画面哈希比说明不了 P7，没另跑 |

## 场景壁纸 P7a：请求夹具、逐字节基线与嵌入 naga

2026-11-11 Windows。P7a 不改变能渲染的场景数（流体 effect 的着色器能翻译了，但用它的唯一一张场景还缺别的能力）。说明见 `src-tauri/wpesl2wgsl/README.md`「测试」与 `naga/KABEGAME.md`，数据见 `.claude/plans/wpe-import/3-scene/phase7/phase-7a-corpus-naga.md`「实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 请求夹具重放 | Windows，cargo | `kbp corpus scan --extra requests:ignore/p7/requests` 录夹具；`WPESL2WGSL_REQUESTS=… cargo test -p wpesl2wgsl --test corpus` 重放 | 重放的通过与否和夹具记录一致；WGSL 回读 0 失败 | 2026-11-11：777 个请求、215 个着色器；一致性 0 不一致，回读 0 失败；两次录制逐字节相同 |
| [x] | T2 逐字节基线 | Windows，cargo | 带 `WPESL2WGSL_BASELINE_DIR` 对改动前的导出比较 | 只有预期的键变化 | 2026-11-11：嵌入 naga 前后 3460 个文件全部相同；死代码补丁后只多出 `fluidsimulation_advection` 的 8 个文件 |
| [x] | T3 Tint 接受度 | Windows dev，主窗口 | 基线全部 WGSL 加产品前言逐份 `createShaderModule` + `getCompilationInfo` | 真实场景的请求 0 error | 2026-11-11 Claude（kabegame-dev）：1730 份、约 12 s；真实场景 0 error 0 warning。几何门槛的合成组合 `rope` / `ropetrail` + `REFRACT` 各 1 个 `invalid aliased pointer argument`（P7 之前就有、语料没用到，P7b 修） |
| [x] | T4 单测 | Windows，cargo | `cargo test -p wpesl2wgsl --lib`；`cargo test -p naga --lib --features glsl-in,wgsl-in,wgsl-out,stderr` | 全过 | 2026-11-11：56 个、128 个全过 |
| [x] | T5 wasm 构建 | Windows，cargo | `cargo build -p wpesl2wgsl --target wasm32-unknown-unknown --profile wpesl2wgsl` | 能编出；体积不涨 | 2026-11-11：1 606 373 → 1 600 789 字节 |
| [ ] | T6 场景画面不变 | Windows dev | 重建 wasm（`deno task build:wpesl2wgsl` 或带前端的 kabegame 命令）后打开几张原本能渲染的场景 | 画面与之前一致 | 待下次重建 wasm 时顺带确认；输出逐字节相同，预期不会变 |

## 场景壁纸 P5a：视差、抖动、缩放与前置几条

2026-11-10 – 11-12 Windows dev。P5a 分 5 步加收尾：
- 步骤 0：实测核对读码；
- 1 前置：材质 JSON 注释、translucent / additive 不写深度、`cropoffset` 与对象 `config` 中性、模型布尔键只认 `true`；
- 2 视差，3 抖动，4 缩放；
- 收尾前补回放逐帧光标（工具）；收尾时走查「未实测清单」、对齐视差点初值、补开场指针。

能渲染 23 → 36，解锁 13 张。说明见 `cocs/wpe/WPE_SCENE.md`「相机：视差、抖动与缩放（P5a）」；每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase5/phase-5a-parallax.md`「实施记录」「P5a 收尾」，实测结论见同目录 `p5-REPORT.md`。

验收工具在 `ignore/p5/`：
- 确定性工程由 `a0/gen_a.py`（步骤 0，之后各步重抓）、`cur/gen_cur.py`（逐帧光标）、`wk/gen_wk.py`（收尾走查）生成；
- 各步的快照、补丁、语料比较与整帧比对在 `s1/`–`s4/`、`cur/`、`ptr/`、`wk/`；
- WPE 参照：步骤 0、1 在 `A:\p5a\`，之后在 `A:\p5a2\`。

抓帧不移动用户的鼠标，指针从 CLK 层或逐帧光标日志读；只有开场指针的主窗口坐标核对，经用户同意由我们移动了光标。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | A0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（带 `KABEGAME_WPE_ROOT`）、Prettier；应用 `src/components/wallpaper` 的 vitest 与 vue-tsc；Rust `wpe_scene` 单测与 `cargo check` | 0 error；全过 | 2026-11-11（开场指针之后，Claude 复跑）：宿主 tsc 0，vitest 1708 过 / 1 败（`pipeline.test.ts` 的 `3830255100` 请求次数上限，HEAD 基线上同样失败，与本节无关）；应用 8 个文件 86 个用例过；Prettier 过；Rust `wpe_scene` 10 个单测过；子代理另报 vue-tsc 0、`cargo check` 0。各步的数字见子计划 |
| [x] | A1 读码公式 · 实测核对 | WPE 抓帧（1344×756 窗口，fps 20） | 16 个确定性工程 `p5a-*` 加 4 张真实样本；`rdc_dump.py` 导出常量，按 CLK 层记下的指针复算每个对象的偏移 | 视差、抖动、缩放与前置几条的读码结论逐条成立，或写明推翻处 | 2026-11-10：全部成立，图层偏移误差 0，只有 `3830255100` 一帧最大 0.12 像素（那一帧平滑还没收敛）；补上两处：`roughness` 临界要按 float32 算，视差点 P 不钳制、只有 uniform 钳制 |
| [x] | A2 前置 · 语料与 `3778549173` | Node 语料 + WPE 抓帧（2560×1440，fps 20）+ Windows dev 屏外宿主 | 步骤 1 前后重扫 `unsupported`；`3778549173` 的静态部分和 WPE 画完图像层时的渲染目标逐像素比，粒子按均匀帧时间回放比统计量 | 只少 `model:cropoffset`、`object:config` 与中性情况下的 `depthwrite:enabled`；新解锁 `3778549173`；静态部分一致 | 2026-11-10：能渲染 23 → 24；去掉 `model:cropoffset` 34 张、`object:config` 14、`depthwrite:enabled` 5（逐个材质核对都是中性情况），不新增键。静态部分没有像素比 WPE 暗，96.86% 完全相同，更亮的 2.65% 是粒子；灰烬 2306 对 2306–2316，尺寸、透明度、颜色范围逐位相同，雪花、光晕相近 |
| [x] | A3 视差 · 确定性工程 | Windows dev 屏外宿主（kabegame-dev 导入工程）+ WPE 抓帧（1920×1080 窗口） | `p5a-static`、`ptr1`、`ptr05`、`ptrm2`、`delay27`、`delay29`、`kinds`、`fx` 按 `kbp rdc track` 的时间线、用抓到的指针，`render_scene` 回放到同一帧，去掉 FR 帧号块后和 WPE 整帧逐像素比；测后 `projects_remove` | 逐像素相同（CLK 方块的颜色含 `g_ParallaxPosition`，一并比到） | 2026-11-10：7 组最大差 0。`delay29` 有 360 个像素不同（方块纵向差 1 像素），收尾查明是视差点初值多 (2, 2)，对齐后数值核对残差归零（见 A9）。工程已移除，没有残留 |
| [x] | A4 视差 · 真实样本 | WPE 抓帧（1344×756，步骤 0）+ Windows dev 屏外宿主 | `2381978484`、`3445915391`、`3818481122` 按回放渲染整幅场景，照 WPE 的居中裁切缩到同一尺寸，用相位相关估计平移 | 平移 (0, 0) | 2026-11-10：三张都是 (0, 0)，平均像素差 0.6–2.3（缩放重采样）；`2381978484` 的视差偏移在这个尺寸下约 67 像素，这个比较能检出视差错误 |
| [x] | A5 抖动 · 确定性工程 | 同 A3 | `p5a-shake1`、`shaker2`、`shaker01`、`shaker005`、`shakes3` 按时间线回放整帧比；视差加抖动的 `shakepar` 比方块位置与 CLK，跟随粒子另用 `particle_track` 按逐帧光标比 | 整帧 0 差异；`g_EyePosition`、`g_ParallaxPosition` 一致；跟随粒子用上一帧的抖动 | 2026-11-10：5 组整帧 0 差异（含 CLK 里的 `g_EyePosition`）；`shakepar` 的方块与 CLK 0 差异，第 119、120 帧新生的跟随粒子差 ≤ 1e-4。当时整帧里跟随粒子的差异来自开窗期间光标在动，由 A8 补齐 |
| [x] | A6 `3830255100` · 和 WPE 比 | WPE 抓帧（1920×1080）+ Windows dev 屏外宿主 | 按 WPE 各层的偏移反推视差点与抖动；按同一 `g_Time` 回放渲染，缩到 1920×1080 整帧比，再分区做相位相关 | 17 个对象给出同一个视差点；抖动和 `g_EyePosition` 一致；画面只有重采样差异 | 2026-11-10：17 个对象给出的视差点一致（离散 0.001 像素），抖动和 `g_EyePosition` 差 1e-4，反推出指针 (0.928, 0.967)；平均差 0.96，大于 32 的像素 0.038%（只在轮廓线），5 块区域的平移都在 0.08 像素以内 |
| [x] | A7 缩放 · 确定性工程 | 同 A3 | `p5a-zoom15`、`zoom08`、`zoompar`、`zoomx15`、`zoomx08` 按时间线回放整帧比；`zoomx*` 的跟随粒子用 `particle_track` 按逐帧光标比 | 整帧 0 差异；跟随粒子 ≤ 1e-4 | 2026-11-10：5 组全部 0 差异（FR 块的屏蔽框按缩放与抖动现算，1.5 倍时它在画面外）；两档各帧新生粒子差 ≤ 1e-4 |
| [x] | A8 回放逐帧光标（工具） | WPE 抓帧（用户在测试窗口上晃鼠标）+ Windows dev | `p5a-cur3` 用 `particle_track`（`cursors: "log"`）逐个比；`p5a-shakepar2`（`cursor=True` 生成）用 `render_scene`（`cursors: "log"`）整帧比；不给新字段时跑 `kbp regress --corpus` 与画面哈希 | 跟随粒子 ≤ 2.4e-4；FR 块外 0 差异；老的调用逐字节不变 | 2026-11-11：`p5a-cur3` 4 帧 491–495 个粒子最大差 2.4e-4；`p5a-shakepar2` 第 941 帧 FR 块外 0 差异，跟随粒子与透视粒子 1800 个白色像素全部相同，日志光标与抓到的 4 帧 `pointer` 核对差 0；`kbp regress --corpus` 为 `same: true`，画面哈希相同。测试工程 14298、14299 已移除 |
| [x] | A9 收尾走查 · WPE | WPE 抓帧（`A:\p5a2\p5a-wk-*`）+ Windows dev | `p5a-wk-prop` / `script` / `zoom3` / `noplx`（FR 带逐帧光标）核对「未实测清单」里要抓 WPE 的 7 项；视差点初值对齐后按日志逐帧光标核对 P，并用 `render_scene` 回放 `p5a-wk-prop` | 每项有结论 | 2026-11-11：7 项全部成立（属性绑单个数字时铺满两个分量、运行中改 `parallaxDepth` 就地生效、开关视差时 P 冻结再接着走、脚本写 amount / 深度同帧生效、没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5)、`/* */` 块注释、运行中改 `zoom` 画面晚一帧粒子晚两帧）。另查出视差点初值是 (W/2 + 2, H/2 + 2)，已对齐：第 176、177、345、346 帧 P 和 WPE 反推值差 ≤ 0.001（改之前 0.46、0.11）；`render_scene` 第 177 帧 FR 块外 0 差异。测试工程 14308 已移除 |
| [x] | A10 语料变化 | Node | 每一步前后重扫 `unsupported`（HEAD 导出对工作区或快照） | 只在对应键上变化，原来能渲染的场景不掉出，不新增键 | 2026-11-10：步骤 1 23 → 24；步骤 2 24 → 35（去掉 `general:cameraparallax` 41 张、`uniform:g_ParallaxPosition` 16、`script:api:layer.parallaxDepth` 1）；步骤 3 35 → 36（正交场景的 `general:camerashake` 7 张）；步骤 4 只少 `general:zoom` 6 张，仍是 36。每步都不新增键 |
| [x] | A11 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 和之前的基线相同 | 2026-11-10 – 11-11：步骤 2（对 P4d 步骤 2 的基线）、3、4、初值对齐、逐帧光标各自 30 组都相同。基线里没有开视差的场景，初值对齐这一次只能说明没改坏别的 |
| [x] | A12 预览里移动鼠标 | Windows，图库预览 | 打开深度 (0, 1) 的 9 张（X-Ray 模板 8 张与 `3000769374`）、`3445915391`、`3818481122`、`3830255100`，左右、上下移动鼠标 | 前 10 张只在纵向动，方向和光标相反；`3818481122` 图层不动、`depthparallax` 的效果跟着变；`3830255100` 几乎不跟鼠标，只有静止偏移和抖动 | 2026-11-11 用户：和预期一致 |
| [x] | A13 壁纸样式 | Windows，窗口模式 | `2381978484`（比 16:9 高）切 `fit`、`center`、`tile`，在画面上和留白处移动鼠标 | 光标在画面上的位置决定视差点；光标在留白处时图层停在最远处（钳到边），不乱跳 | 2026-11-11 用户：和预期一致 |
| [x] | A14 桌面壁纸跟随 | Windows，窗口模式 | 设为桌面（如 `3000769374`），在桌面上与别的窗口上移动鼠标 | 图层跟着鼠标动 | 2026-11-11 用户：和预期一致；光标停在别的窗口上移动时也跟随，和 WPE 相同（Windows 的鼠标转发是轮询光标） |
| [x] | A15 开场 · 预览 | Windows dev，图库预览 | 光标停着不动，打开一张视差场景的预览 | 一打开图层就按当前光标摆好，不先停在中间、等鼠标动一下才滑过去 | 2026-11-11 用户：原先停在中间（宿主只在收到 `pointermove` 时更新），补了开场指针后在预览里确认。数值核对：主窗口 `wpe_scene_cursor` 返回 (355.3333, 436)，和页面最后一次 `pointermove` 相同；「超市冰箱八奈见」预览里按初值算法算出 (0.500042, 0.499611)，真实 `pointermove` 为 (0.499999, 0.499092)，差 < 0.4 物理像素 |
| [ ] | A16 开场 · 桌面 | Windows，窗口模式 | 光标停在桌面某处不动，把一张视差场景设为桌面壁纸 | 同 A15 | 待用户确认。开场指针只在预览里看过 |
| [ ] | A17 重编译保留视差点 | Windows dev，图库预览 | 改一个会整场重编译的属性；换到另一张再换回来 | 改属性时画面不跳回中心；换回来时从初值重新开始 | 可跳过：上面这些场景没有明显会重编译的属性；渲染器单测 `parallax.test.ts`「重编译保留 P」覆盖 |
| [x] | A18 暂停与应用背景 | Windows，图库预览与应用背景 | 预览里右键「暂停」后移动鼠标，再恢复；把一张视差场景设成应用背景 | 暂停时图层不动，恢复后接着跟；应用背景不跟鼠标，只有静止偏移 | 2026-11-11 用户：和预期一致 |

## 场景壁纸 P4j：粒子 `layerimage` 发射器（进行中）

2026-11-21 Windows dev。P4j 让粒子按另一个图层的画面抽出生点（发射器 `layerimage`，粒子对象 `dependencies` 的 `emitterimage`），起因是 WPE `myprojects` 的 `3834803915`（战锤 40k 雨景的水花）。步骤 0 调研（读码与注入 WPE 随机数的实测），步骤 1 编译期（依赖的解析与绑定、模块表、能力表），发射在步骤 2、3。计划与读码见 `.claude/plans/wpe-import/3-scene/phase4/phase-4j-layerimage.md`、`rea-p4j-layerimage.md`，实测见同目录 `p4-particles-REPORT.md`「P4j 语义的实测核对」。数据在 `ignore/p4/j0/`、`ignore/p4/j1/`，WPE 抓帧在 `A:\p4j\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | J0 注入 WPE 的随机数 | Windows + WPE 抓帧（1280×720，fps 20） | `ignore/p4/j0/rng/seed.py` 换掉新开测试窗口的场景 MT19937 种子，抓 `p4j-rng-a` / `p4j-rng-b`；`kbp replay j0rng` 用同一种子的 `std::mt19937` 回放 | 读回的状态与种子一致；逐粒子对上 | 2026-11-21 Claude：302 颗、129 颗逐颗对上，位置差在近似倒数的包络内（差 / 限 0.735 / 0.613） |
| [x] | J1 `layerimage` 的语义（WPE 侧） | 同 J0 | 6 个确定性工程（`ignore/p4/defs/p4j0.py`）各注入一个种子，`ignore/p4/j0/model.py` 照读码预测候选表与抽取顺序 | 粒子全部落在预测的表项上，抽取顺序按种子成立 | 2026-11-21 Claude：表、列优先、阈值 127、坐标与 `s`、矩阵、隐藏图层、共享记录、启动延迟、抖动、颜色全部对上；更正一条（有预热时只丢 1 个发射帧） |
| [x] | J2 编译期 · 单测与变异 | Node | `compile/p4j1.test.ts`、`compile/p8.test.ts`、`compile/particles.test.ts` 等；`kbp mutate`（工作区模式，`ignore/p4/j1/mutate_j1.py`）；tsc；Prettier | 全过；变异全部检出、按原字节还原 | 2026-11-21 Claude：6 个文件 342 过；tsc 0 error；9 处变异（并集、取最后一条、`id 0`、大小写、照常生粒子、`flags` 缺省、子系统序号、过渡键、puppet）全部检出 |
| [x] | J3 编译期 · 语料 | Node `kbp corpus scan` | 缺省语料；WPE `myprojects` 全部场景，改动前后比 | 缺省语料不变；`3834803915` 只剩 `particle:layerimage:pending` | 2026-11-21 Claude：缺省 233 张 0 变化；myprojects 659 张里 `3834803915` 从两项变成过渡键（另一张 `3816948983` 的变化是别的会话的纹理格式 12） |
| [x] | J4 候选表 · 单测与变异 | Node | `particles/layerImage.test.ts`、`render/emitterImages.test.ts`、`compile/p4j2.test.ts`、`src/dev`（回放改异步）等 54 个文件；`kbp mutate`（`ignore/p4/j2/mutate_j2.py`） | 全过；变异全部检出 | 2026-11-21 Claude：1281 过；建表与夹具（`model.py` 对 `p4j-li-map` 的预测）36 项逐项相同；状态机的开场帧数照 WPE 实测（无预热丢 2 个发射帧、有预热丢 1 个、共享记录后调的早一帧）；7 处变异（不锁上一帧末、像素序、阈值、y 的 `s`、行尾填充、不拍快照、计时不取余）全部检出 |
| [x] | J5 候选表 · dev 实测 | Windows dev，图库预览（强制渲染） | 预览 `p4j-li-map`、`p4j-li-large`，`host.emitterImages({ includeEntries: true })` 读出表，和 `model.py` 的预测、WPE 抓帧的粒子颜色比 | 表项的位置与顺序逐项相同 | 2026-11-21 Claude：`li-map` 36 项全同；`li-large` 8381 项位置与顺序全同，边缘两档颜色是 127 / 64（模型的 numpy 舍入是 128，WPE 抓帧里的粒子也是 127）；探针按 WPE 时间线回放 201 帧（每帧等读回）正常 |
| [x] | J6 发射 · 注入 WPE 种子逐粒子比 | Node `kbp replay j3` | 步骤 0 的 6 组抓帧（`p4j-li-map` / `-jit` / `-flags0` / `-xform` / `-large` / `-move`，种子 1001–1006），回放用同一种子的 `std::mt19937`、全部系统共用一个随机源，候选表取 `ignore/p4/j0/snap/`；单测；`kbp mutate`（`ignore/p4/j3/mutate_j3.py`，检出方含回放）；语料 | 逐粒子对上；变异全部检出；`3834803915` 变干净 | 2026-11-21 Claude：6 个工程 8 个系统、7778 颗粒子全部对上，逐帧粒子数相同，位置 / 颜色 / 尺寸逐位相同（`li-move` 位置差 1.2e-4，脚本移动图层的 sin），共享记录的一帧差（`liw` 比 `li` 多一颗）也照出；相关 53 个文件 1162 过；6 处变异（拒绝抽样、抖动顺序、本地不乘 `M⁻¹`、颜色、速度用本帧 `L`、不写回上一次的 `L`）全部检出；缺省语料 233 张不变，`3834803915` 0 项 |

## 场景壁纸 P4i：粒子光照

2026-11-21 Windows dev。P4i 放行粒子材质的 `LIGHTING` / `DOUBLESIDEDLIGHTING`（步骤 0 调研、1 放行）。光照全在着色器里，引擎侧和图层共用，所以只改能力表。语料 0 张用到，起因是 WPE `myprojects` 的 `3823357259` 只差这一项。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4i）」，验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4i-particle-lighting.md`。确定性工程由 `ignore/p4/defs/p4i0.py`（`kbp gen`）生成，WPE 参照在 `A:\p4i\`；我们的图在 `ignore/p4/i0/ours/`、`ignore/p4/i1/ours/`，变异清单与扫描结果在 `ignore/p4/i1/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | I1 粒子光照 · 确定性工程 | Windows dev 屏外宿主 + WPE 抓帧（1920×1080，postprocessing ultra） | 11 个工程（环境光、换色环境光、点光、平行光 + 聚光、对象变换与世界空间、亮灯、HDR + 泛光、雾、rope、拖尾 + 法线图、阴影图集），`kbp cmp frame --meta` 整帧比 | 逐像素相同，或差异能落到具体原因 | 2026-11-21：3 组 0 差异；其余最大差 1（浮点舍入）；HDR + 泛光最大差 2（泛光渐变上 WPE 后备缓冲的 f16 量化）；rope 1 个边缘像素覆盖不同，落到 draw：像素中心离边 0.00085 px，WPE 顶点离 1/256 px 吸附边界 1 个 ulp，属顶点舍入 |
| [x] | I2 放行后画面不变 | 同 I1 | 能力表放行后不开强制渲染，再画 4 组、编译扫描全部 11 组 | `unsupported` 为空；画面和强制渲染时逐字节相同 | 2026-11-21：一致 |
| [x] | I3 单测与变异 | Node | `compile/p4i1.test.ts` 等 3 个文件；`kbp mutate`（工作区模式，`ignore/p4/i1/mutate_i1.py`） | 全部通过；变异全部检出、按原字节还原 | 2026-11-21：142 条通过；4 处全部检出，源码树哈希前后相同 |
| [x] | I4 语料扫描 | Node `kbp corpus scan` | 缺省语料；WPE `myprojects` 全部场景 | 缺省语料不变；`3823357259` 不支持项为 0 | 2026-11-21：缺省语料 233 张全部干净；myprojects 437 张，`3823357259` 从 1 项到 0 项（另有 6 张新下载的场景不干净，和本项无关） |
| [x] | I5 `3823357259` · dev 走查 | Windows dev 屏外宿主 + WPE 抓帧 | 解包成测试工程（`3823357259-kbp`），另做雷电不跟音频的复制工程（`3823357259-noaudio`，16 个雷电系统的 `audioprocessingmode` 改 0），两边同一份、按 WPE 日志的时间线回放第 248 帧 | 不报不支持项；雷电与光晕的颜色、亮度、分布和 WPE 一致 | 2026-11-21：一致（雷电随机发射，目视比，不逐像素）；原工程的雷电跟系统音频走，探针不给频谱时一颗都不发；顶部 / 底部文字由脚本写，探针没跑脚本。测后 `projects_remove` |
| [ ] | I6 `3823357259` · 真机 | Windows，图库预览（不开强制渲染） | 打开这张，放点音乐 | 正常渲染（不退回预览图）；雷电随音乐出现，雷电周围有淡淡的光晕 | 待用户勾：这张在 WPE 的 `myprojects` 里，要先在应用里导入 |

## 场景壁纸 P4g、P4h：粒子颜色 initializer 与 `boids`

2026-11-18 – 11-20 Windows dev。P4g 补颜色 initializer `hsvcolorrandom` / `colorlist`（步骤 0 调研、1 实现），P4h 补 operator `boids`（步骤 0 调研、1 实现）。两者语料都是 0 张，起因是 WPE `myprojects` 里只差这两项的 6 张场景。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4g）」「粒子（P4h）」，验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4g-color-modules.md`、`phase-4h-boids.md` 的「实施记录」。确定性工程由 `ignore/p4/defs/p4g0.py`、`p4h0.py`（`kbp gen`）生成，WPE 参照在 `A:\p4g\`、`A:\p4h\`；快照与变异清单在 `ignore/p4/g1/`、`h1/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | G1 `hsvcolorrandom` · 确定性工程 | Windows dev 屏外宿主（`particle_track` 按 WPE 时间线回放）+ WPE 抓帧 | `p4g-hsv`（13 组）、`p4g-hsv5`（带 `colorn` 的 5 组），`ignore/p4/g1/cmp_colors.py` 比颜色 | 档位确定的组逐粒子颜色相同；分档的组取值集合相同、比例相近；S / V 区间一致 | 2026-11-18：确定性组差 0；分档组集合相同、比例在采样误差内（档位随机数是 WPE 的 CRT `rand()`，不复刻）；套 `colorn` 后档位 0.637–0.951 与 WPE 相同 |
| [x] | G2 `colorlist` · 确定性工程 | 同 G1 | `p4g-list`（8 组）与 `p4g-hsv5` 的 `list-colorn` | 同 G1；缺 `colors` 键是白色、`[]` 是纯红、非字符串项丢掉 | 2026-11-18：一致 |
| [x] | G3 运行中改 `colorn` | WPE 抓帧（`p4g-live`）+ 单测 | WPE 里用 `apply_properties` 把绑定的颜色从紫改绿再抓帧 | 只有之后出生的粒子换色 | 2026-11-18 WPE：新出生的 9 颗是绿、老的 39 颗仍是紫；Kabegame 侧只有单测（回放工具不收运行中的属性写入） |
| [x] | G4 变异检查与现有回放 | Node（快照模式） | `kbp mutate`（`ignore/p4/g1/mutate_g1.py`）；`kbp regress` HEAD 快照 ↔ 实现快照（含语料） | 全部检出；现有案例逐字节相同、语料不变 | 2026-11-18：7 处全部检出；20 个案例逐字节相同，语料 233 张逐场景相同 |
| [x] | G5 「followed by mice」5 张 · 编译 | Node，`kbp corpus scan --project` | `3841315879`、`3841322784`、`3841330265`、`3841337134`、`3841390912` | 不支持项为 0 | 2026-11-18：HEAD 每张只剩 `particle:initializer:hsvcolorrandom`，实现后 0 项 |
| [ ] | G6 「followed by mice」· 真机 | Windows，图库预览（不开强制渲染） | 打开上面任意一张，动鼠标，在属性面板里改「颜色可调」 | 正常渲染（不退回预览图）；跟随鼠标的粒子有 5 档色相（以颜色属性为中心）；改颜色后新出生的粒子换色 | 待用户勾：这几张在 WPE 的 `myprojects` 里，要先在应用里导入 |
| [x] | H1 `boids` · 确定性工程 | Node 回放 | `kbp replay h1`：`p4h-a` fps 20 / 60、`p4h-b` fps 60 | 逐粒子在包络内 | 2026-11-20：18 组通过；`thr-eq`（正好等于阈值，看硬件 `rsqrtps`）跳过，`thr-out` / `speed2` 放宽到发射器归一化的近似误差 |
| [x] | H2 存活位缺陷与组级写回 | Node 回放 + 单测 | `h1` 的 `sep50` / `sep25` / `dead` / `order8` | 未出生槽、死槽被当成邻居（照抄 WPE）；一组算完即写 | 2026-11-20：通过；读码阶段不照抄缺陷的读法差 1400 像素、全快照写回差一倍多 |
| [x] | H3 变异检查与现有回放 | Node（快照模式） | `kbp mutate`（`ignore/p4/h1/mutate_h1.py`）；`kbp regress` | 全部检出；现有案例逐字节相同、语料不变 | 2026-11-20：10 处全部检出（「组内逐 lane 写」是等价变异，换成「全快照」）；20 个旧案例逐字节相同，语料 233 张逐场景相同 |
| [x] | H4 滴水 `3826719942` · 编译与走查 | Node `corpus scan` + Windows dev 屏外宿主 | 解包成测试工程导入，fps 20 回放 80 帧在 1200×800 画，和 WPE 抓帧比水流区域 | 不支持项为 0；水流形状、走向、粗细一致 | 2026-11-20：0 项；一致（随机发射，不逐粒子比）。测后 `projects_remove` |
| [ ] | H5 滴水 · 真机 | Windows，图库预览（不开强制渲染） | 打开 `3826719942`，看酒瓶口的水流 | 正常渲染；水流连续落到腿上、有水花与水珠，和 WPE 观感一致 | 待用户勾：这张在 WPE 的 `myprojects` 里，要先在应用里导入 |
| [ ] | H6 `boids` 的已知差异 | — | 世界坐标里长寿命的 boids 粒子；两颗粒子正好相距阈值 | 允许和 WPE 有小漂移；正好等于阈值时可能判得不同 | `rcpps` / `rsqrtps` 不复刻（用户 2026-11-20 定）：`world-s2` 11 s 漂 23 像素，滴水估计不超过 3 像素；`hw ≥ 200` 的分帧相位（帧计数器初值未知）没有实测，语料用不到，标了 `TODO:[WPE_SCENE]` |

## 场景壁纸 P4f：粒子的脚本接口与实例覆盖、多 renderer

2026-11-13 – 11-14 Windows dev。P4f 分 5 步加收尾：步骤 0 调研（读码与三轮确定性工程）；1 `instanceoverride` 挂 `{script}` 与 `rate` 的单独路径；2 HDR 下的 `brightness`；3 粒子层的 `IParticleSystem` 方法与 `instance` 对象；4 一个系统多个 renderer；收尾补测 `brightness` 运行中改值。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4f）」，每步的验收数据与没测到的项见 `.claude/plans/wpe-import/3-scene/phase4/phase-4f-script.md`「实施记录」「没测到的」「P4f 收尾」。验收工具：回放案例 `ignore/p4/cases/f1`–`f3`（`kbp replay`）、`kbp corners offline`，各步的快照、补丁、变异清单在 `ignore/p4/f0/`–`f4/`。确定性工程由 `ignore/p4/defs/p4f0.py`（`kbp gen`）生成，WPE 参照在 `A:\p4f\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | F1 字段脚本挂 `instanceoverride` · 确定性工程 | Node 回放 | `kbp replay f1`：`p4f-instance` fps 20 / 60 的 10 个系统（7 个系数与 `colorn` 按 `engine.runtime` 阶跃、每帧写同一个值） | 第 N 帧写的值第 N + 1 帧生效；在包络内 | 2026-11-13：位置 ≤ 3.1e-4，尺寸、颜色、alpha 差 0 |
| [x] | F2 `rate` 的单独路径 | Node 回放 | `kbp replay f1` 的 `rt-1`、`rt-2`（单写 `rate`，湍流 `timescale` 要等别的系数被写才跟上） | 在包络内 | 2026-11-13：`rt-1` 7.0e-4（改之前的实现差 18.8 像素）、`rt-2` 4.6e-4 |
| [x] | F3 HDR 下的 `brightness` · 确定性工程 | Node 回放 + Windows dev 预览（应用「场景后处理」超高） | `kbp replay f2`：`p4f-bright` 超高档与关闭档逐粒子比颜色与 alpha；预览截图与 WPE 超高档上屏画面比 | 两档差 0；画面一致 | 2026-11-13：两档颜色、alpha 差 0；六组粒子带逐点相同或差 1–2 个色阶 |
| [x] | F4 运行中改 `brightness`（收尾补测） | WPE 抓帧（超高档，`p4f-bright2`）+ Windows dev 预览 | WPE 里用 `apply_properties` 把绑定的属性改成 2 再改回 1，读轨迹颜色；Kabegame 预览里用属性面板的命令改同一个属性截图 | 只有改值之后出生的粒子变色，老粒子不变；`flags 8` 的系统不变 | 2026-11-14：WPE 改回 1 后最近出生的 4 颗是 1 倍、更老的 12 颗保持 2 倍，`flags 8` 始终不变；Kabegame 预览同样一刀切开。测后 `projects_remove`，主窗口原来的预览已换回 |
| [x] | F5 `play` / `pause` / `stop` / `isPlaying` / `emitParticles` · 确定性工程 | Node 回放 | `kbp replay f3`：`p4f-api` fps 20 / 60、`p4f-api2` fps 20，钩子按 WPE 日志的 `[kbpx]` 事件在脚本阶段调产品入口 | 逐粒子在包络内；`isPlaying` 和 WPE 日志逐条相同 | 2026-11-13：位置 ≤ 6.7e-4、其余差 0；`isPlaying` 724 条全部相同；脚本发射建的 eventspawn 实例对上 |
| [x] | F6 `instance` 对象 | Node 回放 + 单测 | `f3` 的 `a-inst`、`a-inst-cp`（写系数、写控制点后同帧读回、下一帧生效） | 在包络内；没设过的控制点读到 3.4028235e38、`colorn` 读到 (−1, −1, −1) | 2026-11-13：通过。控制点写进子系统与事件实例、`controlpointangleN` 只有单测 |
| [x] | F7 一个系统多个 renderer · 四角 | Deno WebGPU 离线 | `kbp corners offline p4c-trail-fps60 p4f-multi-fps20 p4f-multi-fps60`：同一系统的第 r + 1 次绘制对第 r 条 renderer | 全部吻合（≤ 0.01 像素）；速度为 0 的粒子在拖尾那次 WPE 是 NaN、我们不画 | 2026-11-14：65 个系统、不符 0 处；T8、T8r 两种顺序、`m-ss` 的第二个 sprite（`fixed`）、子系统上的两个 renderer 都差 0 |
| [x] | F8 一个系统多个 renderer · 整帧 | Windows dev 屏外宿主（`render_scene` 按 WPE 的帧时间回放） | `p4c-trail` 第 922 帧、`p4f-multi` fps 60 第 789 帧、fps 20 第 278 帧和 WPE 的 Present 比 | 整帧一致 | 2026-11-14：前两帧 0 差异；fps 20 那帧差 25 个像素，第 251–275 帧日志缺失、时间线平分，粒子位置偏 0.46 像素所致，和绘制无关 |
| [x] | F9 变异检查 | Node（快照模式） | `kbp mutate`：步骤 1–4 各一组（`ignore/p4/f1/`–`f4/` 的 `mutate_*.py`） | 全部检出，还原后树哈希相同 | 2026-11-13 – 11-14：步骤 1 8 处、2 7 处、3 10 处（`no-capacity` 是等价变异）、4 9 处，其余全部检出；只靠单测检出的几处在子计划里写明 |
| [x] | F10 现有回放不变 | Node | 每步 `kbp regress` HEAD 快照 ↔ 本步快照 | 现有案例逐字节相同 | 2026-11-13 – 11-14：每步都相同。步骤 4 时 `e4` 两边同样失败：案例要求必须报 `uniform:g_AudioSpectrum*`，P11a 实现之后不再报，案例改成只允许出现这几个 |
| [x] | F11 语料变化与覆盖 | Node，183 个工程 | 每步前后重扫 `unsupported` | 只去掉对应的键，没有新增的键，原来能渲染的场景不掉出 | 2026-11-13 – 11-14：带粒子的场景粒子用法全部覆盖 93 → 108（165 张口径）；去掉 `particle:binding:instance:*` 11 张、`particle:instance:brightness` 3、`script:api:particle.*` 39、`layer.emitParticles` 1、`particle:renderers` 1；能渲染不变 |
| [x] | F12 音频字段脚本 `3809965824` | Windows dev 预览（强制渲染），系统循环放测试音乐 | 看「鼠标音乐」（`count` / `rate` / `size` / `speed` 挂音频脚本）的数量与尺寸；停掉音乐 | 随节奏变化、和 WPE 同量级；静音后不再发射 | 2026-11-13：19–24 个、尺寸 18–36（WPE 14–24、16–29；用静态值时只有 7–9 个）；静音后两个带音频的系统都是 0 |
| [x] | F13 `p4f-api` · 预览 | Windows dev 预览（强制渲染） | 导入后看 8 s 里各系统的存活数 | 按 4 s 周期停止清空、暂停、补发、恢复，和脚本时间表一致 | 2026-11-13：`a-stop` 停止时清成 0、`play` 后从 1 涨到 14，`a-emit-stopped` 停止后补发 2 个，`a-tree` 连子系统一起清空再恢复，`a-emit-cap` 一直是容量 8 |
| [x] | F14 全量单测 | Node，vitest | HEAD 快照带 `KABEGAME_WPE_ROOT` 跑全部 | 全过（已知的语料请求次数用例除外） | 2026-11-14：HEAD `79800ab7` 快照 135 个文件（2 个跳过）3234 个用例，3192 通过、42 跳过、0 失败 |
| [ ] | F15 `emitParticles` · 真实场景 | Windows，图库预览 | 打开 `3286859278`（Ghost Rider Skull）与 `3570560686`，触发它们的脚本发射 | 闪电随脚本落下，带 eventspawn 光晕；按钮的补发正常 | 测不了：两处调用都在光标回调里（`input.cursor*`、`cursorClick`），这两个 API 还没实现。代码里标了 `TODO:[WPE_SCENE]` |
| [ ] | F16 多 renderer · `3465215190`（Rainy Day） | Windows dev 强制渲染 + WPE 抓帧 | 比 `Snow` 的雪花与拖尾 | 和 WPE 一致 | 只看了强制渲染的一帧（159 颗，出图正常）；这张另差人偶、挂接等 18 项、不能渲染，没和 WPE 比。代码里标了 `TODO:[WPE_SCENE]` |
| [ ] | F17 和 WPE 有意不同的三处 | — | 自然结束后脚本 `play()`；`stop()` 之后改实例系数；脚本 `emitParticles` 触发 eventspawn（父或子是世界空间） | 重新发射；不再自行发射；实例在父粒子处 | 用户定的（P4f 已定 5–7），只有单测；语料里没有场景用到这几种写法 |

## 场景壁纸 P4e：粒子子系统与音频

2026-11-11 – 11-13 Windows dev。P4e 分 5 步加收尾：步骤 0 调研；1 系统树、多次绘制与 `static` 子系统；2 事件实例池与 `eventfollow`（粒子层改成每帧现排）；3 `eventspawn` 与 `eventdeath`；4 `audioprocessing*`、宿主场景频谱与 Hub 的 WPE 原始频谱（2026-11-13 改为方案 B：网页壁纸仍用自定频谱）；收尾 A 走查按推断实现的几条，收尾 B 文档与覆盖数。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4e）」，每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4e-children.md`「实施记录」。验收工具：回放案例 `ignore/p4/cases/e1`–`e5`（`kbp replay`），各步的快照、补丁、变异清单在 `ignore/p4/e0/`–`e5/`。确定性工程由 `ignore/p4/defs/p4e0.py`（`kbp gen`）生成，WPE 参照在 `A:\p4e\`。这次没有像 P4d 的 D10 那样量 10 张干净场景的画面哈希：各步没有单独量，同期 P5b、P6b、P7 也在改渲染器，事后已没有干净的基线；粒子层改成 `particle-tree` 之后的绘制由回放逐字节相同与 E8–E10 的真机对照覆盖。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | E1 `static` 子系统 · 确定性工程 | Node 回放 | `kbp replay e1`：`p4e-static`、`p4e-static2` fps 60 与 `p4e-rate` fps 20 按 points 认法逐粒子比；另核对「我们有粒子而 WPE 没画」 | 全部系统在包络内，没有多画的 | 2026-11-12：位置最大 3.7e-4，尺寸、颜色、alpha 差 0；`s-hide` 的抓帧落在隐藏段，父子都清空；`p4e-rate` 证实对象 `rate` 也乘子系统的 `timescale`。fps 10 的日志缺帧，不进案例，两遍模式由 `p4e-rate` 的 fps 20 覆盖 |
| [x] | E2 `eventfollow` · 确定性工程 | Node 回放 | `kbp replay e2`：`p4e-follow` fps 60、`p4e-follow2` fps 60 与 fps 20 的 `probability 1` 系统逐粒子比 | 每个实例逐帧粒子数相同，在包络内 | 2026-11-12：全过，位置最大 4.9e-4，尺寸、颜色、alpha 差 0；`f-prob`（`probability 0.5`）跳过，随机流不同 |
| [x] | E3 `eventspawn` / `eventdeath` · 确定性工程 | Node 回放 | `kbp replay e3`：`p4e-event`、`p4e-event2` fps 60 逐粒子比 | 在包络内；多个 eventdeath 条目的上限失守与 WPE 相同；带 rope 的父系统预热里建 eventdeath | 2026-11-12：`p4e-event` 38 个系统位置最大 4.6e-5；`p4e-event2` 159 个系统，`ed-max2` 两个条目逐帧对上（这几帧 62、61 个实例），`ed-rope` 比 `ed-sprite` 多出预热里建的那个实例；最大差 `es-recycle-c` 0.0159，在包络 0.022 内 |
| [x] | E4 音频系数 · 确定性工程 | Node 回放 | `kbp replay e4`：`p4e-audio` fps 20 / 60 每帧喂 CLK 读到的 WPE 频谱，比每帧出生数；`p4e-audio-off`（不声明开关）比「频谱全 0」 | 出生数与 WPE 相同；不声明开关时带音频的发射器没有粒子 | 2026-11-12：8 个音频发射系统在两种 fps 下都存在能让窗口内每帧出生数和 WPE 相同的余数初值（阶跃与缺省参数的两个两边都 0）；`p4e-audio-off` 的 `a-vortex` 逐粒子在包络内、音频发射系统没有粒子 |
| [x] | E5 收尾 A · 运行中建实例的预热时间 | Node 回放 + WPE 抓帧（`p4e-close` fps 20） | `kbp replay e5`；变异「实例预热时 `T` 取 0」与对照「图层时间取 0」 | 本实现通过，`T` 取 0 超限 | 2026-11-13：位置最大 3e-5；`T` 取 0 超限 9514 倍；图层时间那条测试工程不读，检不出（预期），仍是推断。另扫语料：复用实例时孙辈带 `starttime` 0 处、`inherit*fromevent` 0 处，带 eventdeath 的对象可见性可变 3 张但 eventdeath 都挂在顶层系统、隐藏时粒子被清空，碰不到「不可见时照常建」 |
| [x] | E6 变异检查 | Node（快照模式） | `kbp mutate`：步骤 1–4 各一组（`ignore/p4/e1/`–`e4/` 的 `mutate_*.py`） | 全部检出，还原后树哈希相同 | 2026-11-12：步骤 1 11 处、2 14 处、3 12 处、4 11 处全部检出（只靠单测检出的几处在子计划里写明）；步骤 2 的「不可见不销毁顶层实例」补单测后检出 |
| [x] | E7 现有回放不变 | Node | 每步 `kbp regress` HEAD 快照 ↔ 本步快照 | 现有案例逐字节相同 | 2026-11-12：步骤 1–4 依次比 12、13、14、15 个旧案例，全部逐字节相同；唯一的例外是步骤 2 的 `e1` 差期望不支持项一行（`p4e-static2` 不再报 `particle:children:eventfollow`，改案例后通过） |
| [x] | E8 `3778592720` · 和 WPE 比 | Windows dev 屏外宿主 + WPE 抓帧（fps 20） | 回放到同一时刻比粒子统计量与整帧 | 数量、尺寸、alpha 的范围一致，整帧目视一致 | 2026-11-12：父系统 36–38 个（WPE 36–39），子系统各 4 个（WPE 3–4），尺寸与 alpha 范围一致，整帧目视一致 |
| [x] | E9 `3811798465` · 和 WPE 比 | 同 E8 | 同 E8，另看绘制结构 | 两个萤火虫父系统各自后面紧跟一串实例；实例数、每实例粒子数量级一致 | 2026-11-12：两边都是实例数约等于父粒子数减 1–2，每实例 5–10 个粒子，世界坐标范围相同；第 277 帧整帧与放大对照一致 |
| [x] | E10 `1514925620` · 和 WPE 比 | Windows dev + WPE 抓帧（测试副本，闪电的 `count` 调大） | `kbp content unpack --instrument` 解包、按 WPE 的帧时间日志回放第 250–254 帧；测后 `projects_remove` | 光晕实例的有无、位置、alpha 与 WPE 相同；雨系统粒子数相同 | 2026-11-12：光晕实例「有、有、有、无、有」与 WPE 相同，实例坐标 (0, 250)、alpha 0.26；两个雨系统逐帧粒子数相同。天空最亮的雨丝像素我们偏少，是场景按场景分辨率画再缩（P1 起的既有做法），与本阶段无关 |
| [x] | E11 原始频谱 · 和 WPE 比 | Windows dev，系统播放 `p4e-audio` 的 WAV | 读 `host.audio().raw`，与 WPE 抓帧的起音帧比 16 段形状 | 频段形状一致 | 2026-11-12：右 250 Hz 的 R16[0..3] 我们 0.017 / 0.031 / 0.272 / 0.062、WPE 0.02 / 0.03 / 0.28 / 0.06；绝对值 WPE 约是我们的 0.52 倍（推断是 WPE 的壁纸音量），归一化按组相对，不影响粒子与脚本 |
| [x] | E12 音频响应场景 `3809965824` | Windows dev 实时预览（删掉视频立绘的测试副本）+ WPE 抓帧，系统循环放测试音乐 | 比随节奏的发射量；停掉音乐；测后 `projects_remove` | 带音频的发射量与 WPE 同量级；静音后两边都不再发射 | 2026-11-12：`notes1_audio_responsive` 我们 7–8 个、WPE 6–8 个；`鼠标音乐` 差得多是实例覆盖挂脚本（P4f），与音频无关；停掉音乐后两边带音频的系统都不再发射 |
| [x] | E13 帧时间 | Windows dev 屏外宿主，强制渲染 600 帧 | `renderFrame` 连跑，记整帧与粒子模拟 / 写顶点耗时 | 每实例一次绘制不成为瓶颈 | 2026-11-12：`3811798465` 均值约 4 ms、粒子模拟 0.22 ms；`2974757317`（129 个实例 draw）粒子模拟 0.76 ms；烟花预设 `3560756264` 43 ms，其中 spritetrail 写顶点 28 ms（已记风险，该场景另有别的不支持项、还不会渲染） |
| [x] | E14 语料变化 | Node，165 个工程 | 每步前后重扫 `unsupported`；收尾在 HEAD `1e929b3b` 上重扫（`ignore/p4/e5/corpus.json`），对 P4e 开工时的基线算覆盖数 | 只在对应键上变化，原来能渲染的场景不掉出，没有新增的 `particle:*` 键 | 2026-11-13：165 张口径带粒子 108 张里完全覆盖 61 → 93（步骤 1–4 依次 72、82、87、93）；152 张口径 57 → 83。能渲染 38 → 45，P4e 解锁 `3778592720`、`3811798465`、`1514925620`，`1333579536` 与 P5b 一起；没有新增的 `particle:*` 键，没有场景不再能渲染 |
| [x] | E15 解锁的三张 · 预览与桌面 | Windows，窗口模式 | 图库预览打开、设为桌面壁纸 | `3778592720` 光斑大小与数量正常；`3811798465` 萤火虫周围的火星跟着走；`1514925620` 偶尔的闪电带一团光晕 | 2026-11-12 用户逐张看过，没有问题 |
| [x] | E16 网页壁纸的音频可视化 | Windows，带频谱条的网页壁纸，放音乐 | 看条形高度与动态 | 和步骤 4 之前相同（方案 B 保留自定频谱） | 2026-11-13 用户比较后选定方案 B；`data` 的算法与常数回到原版 |
| [ ] | E17 脚本音频缓冲改读归一化频谱 | — | — | 用到 `registerAudioBuffers` 的场景随音乐变化，和 WPE 的动态一致 | 能渲染的 45 张里没有脚本用到音频缓冲：语料里脚本用到的 44 张都还有别的不支持项（最少的 `3304642534` 差 2 项），暂时没有可看的场景；由单测（读到归一化值、引用不变、暂停冻结）覆盖 |

## 场景壁纸 P4d：绳、映射类与距离类模块、不可见的帧

2026-11-09 – 11-11 Windows dev。P4d 分 6 步加收尾：步骤 0 调研；1 `rope` 与翻译器的几何着色器展开；2 `ropetrail`；3 `mapsequence*`；4 `remap*`（4a 管线与非噪声取值、4b 噪声与写控制点）；5 距离类与 `vortex_v2`、不可见时更新控制点；收尾 A 走查「未实测清单」（顺带改了不可见时的系统时间），收尾 B 文档与覆盖数。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4d）」，每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4d-ropes.md`「实施记录」。验收工具：回放案例 `ignore/p4/cases/d1`、`d3`–`d6`（`kbp replay`；ropetrail 没有案例，是 `ignore/p4/d2/replay.test.ts`），各步的快照、补丁、变异清单与离线展开在 `ignore/p4/d0/`–`d7/`。确定性工程由 `ignore/p4/gen_d.py`（步骤 0）与 `ignore/p4/defs/`（`p4d5.py`、`p4d6.py`，`kbp gen`）生成，WPE 参照在 `A:\p4b\p4d-*`（步骤 0）与 `A:\p4d\`（之后）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | D1 `rope` · 段顶点与几何 | Node 回放 + Deno WebGPU 离线 + Windows dev 屏外宿主（kabegame-dev 导入工程） | `p4d-rope` 两种 fps 按 WPE 日志 dt 回放，`writeRopeSegments` 的输出和 `vs_in` 逐段比；我们翻译的着色器吃 WPE 的 `vs_in`，输出和 `gs_out` 逐顶点比；真机四角探针读回带子再比；测后 `projects_remove` | 段数逐帧相同；位置在包络内，`TL` / `TP` ≤ 1e-4；带子差不超过 0.01 像素；WPE 的 NaN 段我们整段不画 | 2026-11-10：16 个系统段数逐帧相同，位置 ≤ 4.3e-4（R11 7.3e-4），`TL` 差 0、`TP` ≤ 5.7e-5；离线 34 组 201 帧位置 ≤ 2.3e-4 像素、uv ≤ 9.5e-7、颜色 0；真机 fps 60 第 918 帧 17 个系统 ≤ 0.004 像素，R9 的 19 个 NaN 段一一对应。真机 R11 差 494 像素：对象由脚本移动，探针不跑脚本，由前两项覆盖 |
| [x] | D2 `ropetrail` · 历史与几何 | 同 D1 | `p4d-ropetrail` 两种 fps 回放，和 `vs_in`、`g_RenderVar0` 逐段逐帧比；离线展开、真机四角同 D1 | 每帧段数相同；位置在包络内；`RV0` 一致；带子差不超过 0.01 像素 | 2026-11-10：12 个系统每帧段数相同，位置 ≤ 4.4e-4，尺寸 / 颜色 / alpha / w 分量差 0，`RV0` ≤ 2.2e-6；离线 22 组位置 ≤ 2.3e-4 像素、uv ≤ 2.4e-7；真机 fps 60 第 926 帧 11 个系统 ≤ 4.6e-4 像素。T7 在 WPE 与我们这边都没有存活粒子（满容量时发射计时冻结，周期约 3.94 s）。rope 的回放与离线展开不回退 |
| [x] | D3 `mapsequence*` · 确定性工程 | Node 回放 | `kbp replay d3`：`p4d-map` fps 60 按槽序逐粒子比位置与尺寸；另跑「复位不清零」「新周期不清零」两个变体 | 逐帧粒子数相同、在包络内；变体超限 | 2026-11-10：20 个系统全部通过，between 9 组逐位为 0，around 差 / 限 0.42–0.69（`sphererandom` 的近似倒数）；`ma-hide` 清空后逐粒子对上；变体分别超限 9.5e4、5.25e5 倍。around 的残留字另用 `p4d-around-ic` 实测为「不乘 `count` 覆盖」 |
| [x] | D4 `remap*` · 确定性工程 | Node 回放 | `kbp replay d4`：`p4d-remap`、`p4d-remap2` 的 fps 60 / 10 按槽序逐粒子比位置、尺寸、颜色、alpha、旋转；噪声组按出生序注入 WPE 的 `R` | 全部在包络内；照报的项（两个 `timeofday`、op 输出 `maxlifetime`）和期望一致 | 2026-11-10（4a）：`p4d-remap` 19 个、`p4d-remap2` 58 个系统，差 / 限 ≤ 0.79。2026-11-11（4b）：26 个、63 个系统，4b 新比的噪声、写控制点、init 输入 16–18 ≤ 0.70；`ri-in-controlpoint` 尺寸 5、`ri-in-deltatocontrolpoint` 60，证明 init 读到的是被写成 0 的点 |
| [x] | D5 距离类与 `vortex_v2` · 确定性工程 | Node 回放 | `kbp replay d5`：`p4d-dist`、`p4d-dist2` 的 fps 60 / 10 逐粒子比；超包络的组另做单步核对 | 在包络内；单步核对通过；`rm-eq2` 停在 100/3 | 2026-11-11：逐帧比较通过的差 / 限都 ≤ 0.77；`md-hard`、`md-scale`（绝对差 0.04–0.09 像素）与 fps 10 的 `v2-ring-*` 只报告，单步核对位置 ≤ 0.70、`vortex_v2` 速度 ≤ 0.43；`rm-eq2` 两种 fps 都停在 x ≈ 33.33 |
| [x] | D6 不可见的帧 · 控制点与系统时间 | Node 回放 | `p4d-dist2` 的 `hide-r` 与收尾 A `p4d-close` 的 `st-hide` 周期隐藏对象；钩子在隐藏帧调 `suspend(inputs, frameDt)`；另跑「不更新控制点」「系统时间不累加」「先累加再复位」「可见性取本帧」「不可见期间照常发射」的变体 | 本实现通过，变体超限或粒子数对不上 | 2026-11-11：「不更新控制点」在 fps 10 的 `hide-r` 超限 1156 倍；`st-hide` 本实现差 ≤ 7.6e-6，「不累加」差 3.5、「先累加再复位」差 0.06–0.35 都超限；「可见性取本帧」四段都更差；「照常发射」四段的粒子数都对不上 |
| [x] | D7 收尾 A · 走查未实测清单 | Node 回放 + WPE 抓帧（`p4d-close`、`p4d-close-rope`，fps 60 / 10 各 10 帧；`restart_wpe` 后的 `p4d-around-ic`） | `kbp replay d6` 逐项判定 8 项；对不上的在快照里改、出补丁 | 每项有结论；改动后现有回放逐字节相同 | 2026-11-11：`Rf = min(fps, R)`、预热后历史塌缩、op 标量输入只用 x 分量、init 用 `floorf`、预热不累加系统时间都成立；around 干净重启后不乘；`around-period` 这次不清零（照报不变）；不可见时系统时间累加，和原实现不同，已改（4 个文件）。tsc 0 错，vitest 1703 个里 1702 个通过，失败的 `compile/pipeline.test.ts` 语料用例（`3830255100` 请求次数超限）撤掉补丁也失败，和本步无关。fps 10 的 `around-period` 有一个粒子早 11 帧发出，没查清，留在未实测清单 |
| [x] | D8 `2254685070` · 和 WPE 比画面 | Windows dev 屏外宿主 + WPE 抓帧（1920×1080 窗口，抓帧时用户在窗口里移动鼠标） | 离线展开绳；`render_scene` 按抓帧的 `g_Time` 渲染、挖掉绳后整帧比；按反推的光标时间线回放绳 | 没有不支持项；绳逐顶点在 0.01 像素以内；绳以外逐像素一致 | 2026-11-11：10 帧 137 段，位置最大差 1.72e-4 像素、uv 6e-8、颜色 0；宏、材质、管线状态和 WPE 一致；绳以外最大差 1 个色阶、> 2 的像素 0；回放段数逐帧相同（20 → 8），位置、`CP0` / `CP1`、`TL` 差 0，alpha ≤ 2.7e-4（`rcpps`）。WPE 是 20 fps，Kabegame 帧上限 60 时绳填充期的 uv 会不同（预期） |
| [x] | D9 语料变化 | Node，152 / 165 个工程 | 每步前后重扫 `unsupported`；收尾在 HEAD（`c22b66a2`）快照上重扫，按 P4b、P4c 的口径重算覆盖数（`ignore/p4/d7/coverage_p4d.py`） | 只在对应键上变化，原来能渲染的场景不掉出，没有新增的 `particle:*` 键 | 2026-11-11：152 张口径带粒子 95 张里完全覆盖 44 → 57（步骤 1–5、收尾 A 之后依次 53、53、57、57、57、57、57）；165 张口径（基线是 P4c 收尾的代码重扫）108 张里 46 → 61。P4d 解锁 `2254685070`，能渲染 22 → 38 里其余 15 张来自同期别的阶段。没有新增的 `particle:*` 键；165 张里的 `3585875739` 把 `vortex_v2` 换成 `vortex_v2:audioprocessingmode`（P4e） |
| [x] | D10 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 和前一步相同 | 2026-11-10 – 11-11：步骤 1（对 P4c 收尾）、2、5、收尾 A 各自 30 组都相同；步骤 3、4a、4b 没有单独量，步骤 2 之后与步骤 5 之前（`ignore/p4/d2/out/hash-after.json`、`ignore/p4/d5/out/hash-before.json`）的 30 个哈希逐个相同 |
| [ ] | D11 `2254685070` · 预览与桌面跟随鼠标 | Windows，窗口模式 | 图库预览里打开、设为桌面壁纸，移动鼠标 | 光标后面拖出一条绳状的轨迹，鼠标停下后轨迹收拢消失 | 待用户确认。Claude 只做了 D8 的抓帧对照，没在应用里移动鼠标看过 |

## 场景壁纸 P4c：控制点、指针、controlpointattract、世界空间、拖尾与 sprite 朝向

2026-11-08 – 11-09 Windows dev。P4c 分 6 步：步骤 0 调研；1 控制点底座；2 指针；3 `controlpointattract`；4 世界空间与帧顺序（一帧里粒子先于脚本步进）；5 `spritetrail` 与 `sprite` 的 `orientation` / `axis` / `flags`。一个系统多个 renderer 继续报不支持。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4c）」，每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4c-controlpoints.md`「实施记录」。验收工具在 `ignore/p4/c1/`–`c5/`，确定性工程由 `ignore/p4/gen_c.py` 生成，WPE 参照在 `A:\p4b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest、Prettier | 0 error；全过 | 2026-11-09（步骤 5 之后，Claude 自跑）：tsc 0 error，48 个文件 1284 个用例全过，格式通过 |
| [x] | C1 控制点 · 确定性工程 | Node 回放 | `p4c-cp`（fps 60）里不含指针的 11 个系统按 WPE 日志 dt 逐粒子比 | `offset`、实例覆盖、`flags 2` / `4` / `16`、控制点角度、`vortex` 中心与 WPE 一致，位置在近似倒数包络内 | 2026-11-08：全部在限内，差 / 限 0.21–0.48；size、color、alpha、rot 差 0 |
| [x] | C2 指针 · 确定性工程 | Node 回放 | `p4c-ptr` 在 1920×1080、1920×800、1440×1080 三种窗口各抓 10 帧（抓帧时在窗口里移动鼠标），跟随点按 Kabegame 的 `fill` 反算，只比窗口内出生的粒子 | 跟随点用本帧指针；窗口和场景比例不同时跟随点是光标下的场景点 | 2026-11-08：全部在限内，差 / 限 0.43–0.72；WPE 的跟随点和我们的逐帧差 ≤ 0.02。步骤 4 起加上世界空间的 `p-world`，差 / 限 0.62–0.67 |
| [x] | C3 `controlpointattract` · 确定性工程 | Node 回放 | `p4c-attract` 的 fps 60（一遍）与 fps 10（两遍）10 个系统逐粒子比；另做单步核对 | 每帧粒子数一致；位置在包络内 | 2026-11-08：粒子数逐帧相同，9 个系统在限内（差 / 限 0.12–0.97）。`a-default` 长程超限（1.15、28.7），单步核对残差 4.6e-3 / 3.8e-3 在 `rcpps` 量级内，用户接受、不改包络 |
| [x] | C4 世界空间与帧顺序 · 确定性工程 | Node 回放 | `p4c-world` 13 个系统，第 N 帧给模拟器第 N − 1 帧的对象变换；另跑「第 N 帧用第 N 帧」的变体 | 在限内；变体超限（钉住「粒子先于脚本」） | 2026-11-08：差 / 限 0–0.587，`w-grav1-l` 2.29e-2；变体在 `w-stay-w` 上差 2.54 像素、差 / 限 236 |
| [x] | C5 拖尾与朝向 · 四角 | Deno WebGPU 离线 + Windows dev 屏外宿主（kabegame-dev 导入工程） | `p4c-trail`、`p4c-sprite`、`p4c-rot` 读每个粒子的四角，和 WPE 的 `gs_out` 比；测后 `projects_remove` | 差不超过 0.01 像素；速度为 0 的拖尾、轴平行于视线的 `upright` 不画 | 2026-11-09：`p4c-trail` / `p4c-sprite` 32 个系统 × 3 帧，离线与真机最大差 1.14e-4；`p4c-rot` 17 个系统离线 1.90e-4、真机 6.87e-4；`T6`、`S7` 不画。导入的工程已移除，没有残留的行与任务 |
| [x] | C6 语料变化 | Node，152 个工程 | 每一步前后重扫 `unsupported`；收尾按 P4b 的口径重算覆盖数（`ignore/p4/c5/coverage_p4c.py`） | 只在对应键上变化，原来能渲染的场景不掉出 | 2026-11-09：能渲染 20 → 22；带粒子的 95 张里粒子用法全覆盖 22 → 44；收尾时没有新增的 `particle:*` 键 |
| [x] | C7 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，读回画面哈希 | 每一步都与前一步相同 | 2026-11-08 – 11-09：步骤 1–5 每步 30 组都相同（步骤 1 对 P4b 步骤 6 的记录） |
| [x] | C8 带脚本的场景照常播放 | Windows dev，主窗口在前台 | 帧顺序改成粒子先于脚本之后，预览带脚本的场景，看 rAF、`update` 次数与报错 | 画面在动；脚本照常调用，没有报错或被禁用的回调 | 2026-11-09 Claude（kabegame-dev）：`razer_bedroom` 的 6 个脚本 1.5 秒内 `update` 增加 540 次，没有报错、没有禁用的回调；预览 `3832772446`、应用背景 `1838478131` 1.5 秒内 rAF 216 次，粒子在动 |
| [x] | C9 `shimmering_particles` 默认样式 | Windows dev，屏外宿主 | 朝向改成现算后，看受影响的 3 个 `small_motes_copy1` 层画不画 | 默认样式下画面不变 | 2026-11-09：这张不在 10 张哈希基线里。屏外宿主读状态，库里当前属性下对象 2、3、4（3 个 `small_motes_copy1`）`visible` 都是 false，`encode` 整段跳过、模拟走不可见清空，朝向的改动碰不到默认样式的画面 |
| [ ] | C10 `shimmering_particles` 改 `style` 为 1 | Windows dev，图库预览 | 在属性面板把 `style` 改成 1 | 3 个 `small_motes_copy1` 层的粒子朝向镜头（正方形，不被压扁），与 WPE 观感一致 | 待用户确认。补测工程 `p4c-rot` 照抄了这三层的角度、z 偏移与缩放，四角与 WPE 吻合 |
| [x] | C11 `1838478131` · 预览与桌面跟随鼠标 | Windows，窗口模式 | 图库预览里打开、设为桌面壁纸，移动鼠标 | 粒子从光标下出生、跟着鼠标走 | 2026-11-08 用户：预览和桌面上看过，没有问题（记录没写当时的壁纸样式；场景是 3441×2465，16:9 桌面上 `fill` 正好裁切） |
| [ ] | C12 `1838478131` · 适应 / 居中 / 平铺 | Windows，窗口模式 | 壁纸样式切到适应、居中（可再试平铺），在画面上和留白处移动鼠标 | 画面上粒子仍在光标下；留白处跟随点线性外推到画面外；平铺时跟随所在的那一块 | 待用户确认。按铺放反算由 `render/layout.test.ts` 的单测覆盖 |
| [x] | C13 `3832772446` · 和 WPE 比画面 | Windows dev，屏外宿主 + WPE 抓帧（3840×2160 窗口，3 帧） | `render_scene` 看画面；静态部分按抓帧的 `g_Time` 逐像素比；粒子回放到抓帧时刻比统计量 | 没有不支持项；粒子以外逐像素一致；粒子数、尺寸、分布与 WPE 相近 | 2026-11-09 Claude：差值 > 32 的像素占 0.15%，全在 WPE 的 20 个粒子上；粒子数 20 / 19 / 20 对 20 / 19–20，尺寸 WPE 53–284、我们 54–292；alpha 均值的差在随机波动内。WPE 设置按字节还原、桌面壁纸已放回 |
| [ ] | C14 `3832772446` · 预览与桌面 | Windows，窗口模式 | 图库预览里打开、设为桌面壁纸，与 WPE 对照看一会儿 | 实时渲染；一簇闪光的粒子被场景里的一个固定点推开，数量、大小、分布与 WPE 观感一致 | 待用户确认。这张的排斥点是 `instanceoverride.controlpoint1` 写死的位置，不跟鼠标；Claude 只在主窗口预览里确认过它在播放（C8） |
| [ ] | C15 吸引、世界空间与拖尾 · 强制渲染（可选） | Windows dev，`localStorage["kabegame-dev-scene-force-render"] = "1"` | 预览 `3812887609`（只差 `object:shape`、`particle:children`）并在画面上移动鼠标；另挑一张带世界空间或 `spritetrail` 的场景 | 萤火虫躲开光标；世界空间粒子不跟着图层跑，拖尾按速度拉长 | 计划里列为可选，没做 |

## 场景壁纸 P4b：纹理格式、粒子帧表、档 2 模块、折射与 colorn

2026-11-08 Windows dev。P4b 分 7 步：步骤 0 调研；1 纹理格式（另有两次补充：翻译器按材质键拆分两阶段同名 uniform、材质常量取值对齐 WPE，后者见下一节）；2 粒子帧表；3 发射时序、`boxrandom` 与确定性档 2 模块；4 噪声类模块；5 `REFRACT` / `CUTOUT`；6 `instanceoverride.colorn`。

说明见 `cocs/wpe/WPE_SCENE.md`「粒子（P4b）」，每步的验收数据见 `.claude/plans/wpe-import/3-scene/phase4/phase-4b-tier2.md`「实施记录」。验收工具在 `ignore/p4/b1/`–`b6/`、`b2v/`–`b5v/`，WPE 参照在 `A:\p4b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | B0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error；全过 | 2026-11-08（步骤 6 之后）：tsc 0 error，44 个文件 1154 个用例全过，格式通过 |
| [x] | B1 纹理格式 · 确定性工程 | Windows dev，屏外宿主 | `p4b-tex1` 按 WPE 日志 dt 回放，静态格式区域与 WPE 抓帧逐像素比 | R8、RG88、DXT1、DXT3、alpha-priority 有无、NPOT 粒子与 WPE 一致 | 2026-11-08：R8、RG88、DXT3、alpha-priority、NPOT 粒子 0 个像素不同；DXT1 粒子 15 个、R8 图像层 45 个、RG88 图像层 2 个像素，都只差 1 个色阶 |
| [x] | B2 `foliagesway` 场景 | Windows dev | `3799426930`、`3812822229`、`3829603837`、`2418800402` 按场景分辨率和 WPE 逐像素比 | 植物摇摆速度与相位和 WPE 一致 | 2026-11-08：前三张 0.03%–0.07% 像素不同，几乎都只差 1（翻译器修正前 1.3%–35%）；`2418800402` 是全图 4×4 方块状的解码舍入，画面一致 |
| [x] | B3 粒子帧表 | Node 回放 + Windows dev 屏外宿主 | `p4b-tex` 的 15 个帧表系统按 WPE 日志 dt 回放：比 frame 列，再比整帧 | frame 与 WPE 只差 `rcpps` 的固定偏差；画面一致 | 2026-11-08：frame 相对差 2.44e-4–2.48e-4；`randomframe` 注入 WPE 的 `R` 后逐位相同；整帧最大差 2 个色阶，混帧关与随机帧 0 个像素不同 |
| [x] | B4 发射时序与档 2 模块 | Node 回放 | `p4b`（fps 60 / fps 10）、`p4b-emit` 按 WPE 日志 dt 回放 | 每帧粒子数一致；位置、尺寸、颜色、alpha 在近似倒数包络内 | 2026-11-08：全部系统在限内；`capvelocity` 截后速度 WPE 99.993、我们 100.000；`vortex` 位置差 / 限 ≤ 0.46；P4a 的 9 个 tag 也全部在限内 |
| [x] | B5 噪声类模块 | Node | 噪声对拍、短程强制回放、整段回放 | 噪声逐位相同；轨迹在限内 | 2026-11-08：Claude 独立参考实现 13033 组逐位相同；`turbulence` 4 帧强制回放 ≤ 3.1e-4；`turbulentvelocityrandom`、`positionoffsetrandom` 在包络内 |
| [x] | B6 折射与裁切 | Windows dev，屏外宿主 | `p4b-refract`、`p4b-refract2` 各 4 帧对 WPE 逐像素比；数快照次数 | 差异不超过 1 个色阶；每个折射对象前一次快照 | 2026-11-08：最大差 1；`CUTOUT`、法线图对照组 0 个像素不同。存活数为 0 时 WPE 不拷快照、我们照拷，画面不受影响 |
| [x] | B7 `colorn` · 确定性工程 | Node 回放 + Windows dev 屏外宿主 | `p4b-color`（`version 3`）、`p4b-color5`（`version 5`）、`p4b-color3b`、`p4b-color0`（不写 `version`）逐粒子比颜色；前两个再比整帧 | 逐粒子差不超过 2e-6；`version` < 5 时平移后再乘 `colorn` | 2026-11-08：最大差 3e-8；`c-change` 在 `version 5` 下为 (t, 1 − t, 0)，`version 3` 与缺键为 (0, 1 − t, 0)；整帧只有 `colorchange` 个别粒子差 1 个色阶 |
| [x] | B8 `colorn` · 运行中改颜色属性 | WPE 抓帧 + Windows dev | `p4b-colorp2`（寿命 16 s）经 `-control applyProperties` 改三次颜色，按改值帧回放比；屏外宿主改 `p_c` 看探针 `stats()` | 新粒子用新值；`colorrandom` 与没有颜色模块的存活粒子不变，`colorchange` 的存活粒子立即变；不重编译 | 2026-11-08：3 个系统各 120 个粒子逐槽一致，最大差 3e-8；真机 `applied` 1 → 2 → 3，`recompiled` 0。测试行已删 |
| [x] | B9 语料变化 | Node，152 个工程 | 每一步前后重扫 `unsupported` | 只在对应键上变化，原来能渲染的场景不掉出 | 2026-11-08：能渲染 14 → 20；带粒子的 95 张里粒子用法全覆盖 5 → 22；除各步的模块 `audioprocessing*` 字段外没有新增键 |
| [x] | B10 原有场景画面不变 | Windows dev，屏外宿主 | 10 张原本能渲染的场景 × 三档后处理，`renderFrame` 读回哈希 | 每一步都与前一步相同 | 2026-11-08：步骤 2–6 每步 30 组都相同；翻译器修正只改了 `2418800402`，见 B2 |
| [x] | B11 新解锁场景 · 屏外渲染 | Windows dev，屏外宿主 | 6 张新解锁的场景强制渲染、回放，与 WPE 抓帧比统计量 | 没有不支持项；粒子数、尺寸、位置、alpha 范围与 WPE 相近 | 2026-11-08：`1504316159`、`3820104696` 的雾与雨线和 WPE 一致，帧时间均值 3.74 / 4.01 ms；`2854083091` 构图一致；三张 `foliagesway` 见 B2 |
| [ ] | B12 新解锁场景 · 预览与桌面 | Windows，窗口模式 | 6 张新解锁的场景分别在图库预览里打开、设为桌面壁纸，与 WPE 对照看一会儿 | 实时渲染；植物摇摆、雾、雨、粒子帧动画与 WPE 观感一致，没有闪烁或方块 | 待用户确认 |
| [ ] | B13 改粒子颜色属性 · 预览 | Windows dev | 语料里带 `colorn` 绑定的场景都还有别的不支持项；可导入 `ignore/p4/proj/p4b-colorp2`，在预览属性面板改 `p_c`，测后删行 | 改色即时生效：之后出生的粒子换色，`p-change` 一行的存活粒子立即换色；不重新加载 | 待用户确认 |
## 场景壁纸材质常量取值对齐 WPE

2026-11-08。材质常量（`constantshadervalues`、注解缺省、`usershadervalues` 与 `{user}` 绑定、就地写、脚本写回）改成照 WPE 的 setter 取值（`apps/wpe-scene/src/compile/materialValues.ts`，依据 `.claude/plans/wpe-import/3-scene/vector-constant-REPORT.md` 第 2 节，第 6 节 `p4b-vec` 36 格实测与读码吻合）。翻译器只在材质键不同时拆开两阶段同名 uniform，同键合并、注解取片元的。按用户决定不复刻同阶段同键只上传后声明的、按声明行子串定类型两条。测试工程 `ignore/p4/proj/p4b-vec`（`ignore/p4/vec/gen_vec.py` 生成，读像素点与 WPE 值在 `kbv-meta.json`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V1 编译管线逐格对 WPE | vitest（`ignore/p4/vec/vec.test.ts` + `checkproj.py`） | 用产品编译管线编 `p4b-vec`，逐格和 `kbv-meta.json` 的 `wpe` 列比 | 除 `dup-*` / `sub-*`（不复刻）与两个脚本格外全部相等；没有不支持项 | 2026-11-08 32 格相等；`dup-val` 碰巧相等，`dup-def` / `sub-*` 的差别见报告第 6 节 |
| [x] | V2 脚本写回 | vitest（`materialValues.test.ts`） | 脚本给 float 常量返回数字、给 vec3 返回向量 | 经同一个 setter 写进去：float 0.6、向量逐分量 | 对应 `scr-num-*`。2026-11-08 Claude 在图库预览里实跑 `p4b-vec`（`update` 各 184 次）：`scr-num-v3` (0.6, 0.6, 0.6)、`scr-num-v4` (0.6 ×4)、`scr-vec2-v3` 保持初值 (0.1, 0.2, 0.3)，都与 WPE 一致 |
| [x] | V3 语料不掉 | vitest（`ignore/p4/step5/corpus.test.ts`，基准 `p4b1b-mine.json`） | 全语料重扫 | 没有新的 `constant:*` 不支持项；干净场景不减少 | 18 → 20（新增两张来自粒子步骤）；能渲染的场景里只有 foliagesway `g_Phase` 两格并成一格，值不变或改的是没被引用的顶点半边 |
| [x] | V4 实机逐像素 | Windows dev，场景渲染 | 预览 `p4b-vec`（导入 `ignore/p4/proj/p4b-vec`），按 `kbv-meta.json` 的读像素点取色，和 WPE 抓帧比 | 除 `dup-def`、`sub-val`、`sub-def` 外与 WPE 相差不超过 1.5/255 | 2026-11-08 Claude：屏外宿主 `renderFrame` 对 WPE 抓帧（`A:\p4b\p4b-vec-fps60`）31 / 36 格一致；不一致的是不复刻的 3 格和两个脚本格（`renderFrame` 不跑场景脚本，画的是初值，写回由 V2 单测核对） |
| [x] | V5 运行中改属性 | Windows dev，`p4b-vec` | 依次把 `p_slider` 改成 0.3、`p_color3` 改成 `"0.2"`、`p_bool` 改成 false | `u-slider-v3` 变 (0.3, 0.3, 0.3)；`u-color-v3` 变 (0.2, 0, 0)，不留旧分量；`u-bool-f` 保持 0.3 | 2026-11-08 Claude 图库预览实测：`p_slider` → (0.3, 0.3, 0.3)；`p_bool` → 保持 0.3；都是就地写、0 次重编译。`p_color3` 的 `"0.2"` 被应用的属性校验拒绝（颜色要三个分量），改用 `"0.2 0.3 0.4"` → (0.2, 0.3, 0.4)；短颜色串不残留旧分量只由单测核对。属性已还原 |

## 预览壁纸的右键菜单与工具条

2026-11-07 Windows dev。预览网页与场景壁纸时，「暂停」（排第一）、「设为壁纸封面」「清空脚本存储」（只场景）挪进右键菜单，工具条照常平铺菜单项；暂停与设为壁纸封面在画面出来之前置灰。这几条命令由预览弹窗自己处理，不交给网格，画廊的右键菜单里没有它们。预览的属性面板只留「恢复默认封面」（`customCover` 跟着 `thumbnailPath` 补丁重读）；设置页的属性弹窗只剩作者属性（见下一节）。「设为壁纸」的图标换成显示器（Web 版仍是图片）。截封面时预览容器里除壁纸画布外全部隐藏。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | M0 单测与检查 | Windows | 应用 vue-tsc；`actions`、`utils/wpeWallpaperCommands`、`useWpeWebProperties`、属性面板、预览弹窗事件的测试；应用全量 vitest；Prettier | 0 error；全过 | 2026-11-07：vue-tsc 0 error；改动相关 5 个文件全过；全量 636 个用例全过，`gallery` / `imageEvents` / `facetTreeSource` 三个套件在导入阶段失败（`__vue-jsx-ssr-register-helper`），HEAD 上同样失败，与本次无关；格式通过 |
| [x] | M1 场景预览的菜单 | Windows dev，能渲染的场景 | 打开预览，立刻右键、看工具条；等画面出来再看；点暂停再点继续 | 暂停排第一；画面出来前暂停与设为壁纸封面置灰，之后可用；暂停后文案变「继续播放」、图标换成播放，画面定住，再点接着动；切到下一张恢复播放 | 待用户确认 |
| [x] | M2 退回场景的预览 | Windows dev，退回预览图的场景 | 打开预览，右键 | 暂停与设为壁纸封面一直置灰，清空脚本存储可点 | 待用户确认 |
| [x] | M3 网页壁纸的预览 | Windows dev，网页壁纸 | 打开预览，右键、看工具条 | 有暂停和设为壁纸封面，没有清空脚本存储 | 待用户确认 |
| [x] | M4 从工具条与右键菜单设封面 | Windows dev，场景与网页各一张 | 工具条点设为壁纸封面；再从右键菜单点一次；最后恢复默认封面 | 封面里没有工具条、箭头、抽屉开关和菜单；属性面板随即出现「恢复默认封面」；网格缩略图换新 | 网页壁纸在设置之后会导致出现加载态覆盖，场景壁纸不会。需确认其他类型壁纸是不是在缩略图更新的时候也会，补测试。2026-11-08 查明：`ImageContent` 换 `thumbnailPath` 就重置加载态，壁纸组件按 id 取目标、同一目标只发一次 ready，加载态结束不了；骨架 `z-index` 3 盖在网页层（2）上，场景层也是 3 且排在后面画，所以只有网页看得见（场景同样没结束）。图片、视频的缩略图变了会重新加载并重新发 ready，不受影响。已改为壁纸形态只按图片 id 重置，单测 `ImageContent.wallpaper.test.ts` 覆盖网页与场景 |
| [ ] | M5 从菜单清空脚本存储 | Windows dev，带存储的场景 | 右键 → 清空脚本存储 → 确认 | 提示已清空，脚本重启 | 待更多壁纸被支持 |
| [x] | M6 画廊右键 | Windows dev | 画廊里右键场景、网页壁纸和普通图片 | 没有暂停、设为壁纸封面、清空脚本存储；「抱到桌面上」是显示器图标 | 待用户确认 |
| [x] | M7 设置页的属性弹窗 | Windows dev，桌面是场景壁纸 | 设置 → 壁纸 → 打开壁纸属性 | 只有作者属性：没有暂停、清空脚本存储和封面按钮 | 待用户确认 |
| [x] | M8 壁纸上右键 · 单测 | Windows | `wpeContextMenu`、垫片（`wpeWebVolume.test.ts`）、`WpeSceneView`、`WallpaperStage` web 层、预览弹窗的测试；vue-tsc | 0 error；全过 | 2026-11-08：wallpaper / common / ImageContent 15 个文件 110 个用例全过（垫片只转发可信事件、页面停止冒泡也照发；父页面只认自己 iframe 的可信消息，坐标按显示缩放换算；预览在那个位置弹出同一份菜单）；vue-tsc 0 error |
| [x] | M9 网页壁纸上右键 | Windows dev（垫片改动要重编 Rust 才生效） | 预览网页壁纸，在页面上右键；再在页面不同位置、全屏下各点一次 | 弹出与右键容器同一份菜单，位置就在指针处；菜单项可用，点菜单外关闭 | 待用户确认 |
| [x] | M10 场景壁纸上右键 | Windows dev，能渲染的场景 | 预览场景，在画面上右键；退回预览图的场景也点一次 | 两种都在指针处弹出菜单（退回时预览图在父页面里，走原来的右键） | 待用户确认 |

## 设置：暂停壁纸、打开壁纸

2026-11-08 Windows dev。「暂停壁纸」从属性弹窗移出，成为壁纸设置里单独的一项（仍是 `wallpaperPaused`），只在窗口模式显示，桌面上的视频（含 WPE 视频）、网页、场景共用，换壁纸后仍保持，图片不受影响；属性弹窗不再有暂停与清空脚本存储。「关闭壁纸」`wallpaperDisabled` 改为「打开壁纸」`wallpaperEnabled`（默认开），设置迁移 v004 取反并删掉旧键，命令改为 `get_wallpaper_enabled` / `set_wallpaper_enabled`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | E0 单测与检查 | Windows | vue-tsc 与 `cargo check`；`views`、`components/wallpaper`、`stores`、预览弹窗等前端测试；`kabegame-core --lib settings`；Prettier、rustfmt | 0 error；全过 | 2026-11-08：vue-tsc 0 error，cargo 0 error；前端 17 个文件 122 个用例全过（含视频受暂停影响、图片不受影响）；core 设置测试 21 个全过（v004 的 5 个：取反删旧键、非布尔按开启、没有旧键不写、旧键优先、幂等）；格式通过 |
| [x] | E1 暂停视频壁纸 | Windows，窗口模式，桌面是视频壁纸 | 设置里打开「暂停壁纸」，再关掉 | 视频停住、没声音；关掉后接着播放 | 待用户确认 |
| [x] | E2 暂停中换壁纸 | Windows，窗口模式，暂停中 | 依次切到视频、网页、场景、图片壁纸 | 视频停在首帧、网页与场景停住、图片照常显示；切换过渡正常完成 | 待用户确认 |
| [x] | E3 只在窗口模式显示 | Windows | 壁纸模式切到原生，再切回窗口 | 原生模式下没有「暂停壁纸」，窗口模式下出现 | 待用户确认 |
| [ ] | E4 打开壁纸 · 升级 | Windows，旧设置 `wallpaperDisabled: true` | 关掉应用，把 `settings.json` 改成旧键后启动 | 「打开壁纸」是关着的，桌面没有壁纸窗口；`settings.json` 里变成 `wallpaperEnabled: false`、旧键消失、`schemaVersion` 4，旁边有 `settings.json.bak-v3` | 待用户确认 |
| [ ] | E5 打开壁纸 · 开关 | Windows，窗口模式 | 关掉「打开壁纸」，再打开 | 关掉时壁纸窗口消失、其余壁纸设置置灰、壁纸操作被拒绝；打开后壁纸恢复，轮播开着的话继续轮播 | 待用户确认 |
| [ ] | E6 全新安装 | 新数据目录 | 首次启动看设置页 | 「打开壁纸」默认开 | 待用户确认 |
| [ ] | E7 暂停时不转发桌面鼠标 | Windows，窗口模式，桌面是网页或场景壁纸 | 先在桌面上移动、点击，确认壁纸有反应；打开「暂停壁纸」后再移动、点击；在桌面上按住左键时关掉「暂停壁纸」再松开；最后关掉暂停再试 | 暂停期间壁纸收不到移动与点击，打开暂停那一刻页面收到一次离开（悬停效果消失）；暂停中按住、恢复后松开不会被当成一次点击；关掉暂停后照常响应 | 2026-11-08 只改了 `input_forward.rs`（每轮读 `wallpaperPaused`），待重编后用户在桌面上实测 |

## Ctrl+滚轮缩放（CEF 补丁 10）

2026-11-08 Windows dev。主文档的 Ctrl+滚轮由 `App.vue` 取消，落在壁纸 iframe 上的事件只派发给子文档，没被取消就缩放整个应用，缩放按 host 存进 profile（dev 的 `Default/Preferences` 里 `per_host_zoom_levels.localhost` 为 125%，2026-11-07 23:51 写入）。补丁 10 让主窗口与壁纸窗口忽略这一路，主 frame 加载完时把存下的缩放复位。需要重新构建 CEF。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Z0 检查 | Windows | `deno task patch cef --check`；`check-kabegame --skip vue`；rustfmt / Prettier | 系列能应用；0 error | 2026-11-08：`OK dry-run`；cargo 0 error；改动的文件格式通过 |
| [x] | Z1 网页与场景壁纸 iframe | 新 CEF，Windows dev | 预览网页壁纸、场景壁纸，指针放在画面上 Ctrl+滚轮上下各滚几格 | 应用不缩放，画面不滚动 | 待用户确认 |
| [x] | Z2 主文档 | 新 CEF | 画廊、设置页上 Ctrl+滚轮 | 不缩放；画廊的 Ctrl+滚轮调列数照常 | 待用户确认 |
| [x] | Z3 复位存下的缩放 | 新 CEF，dev profile 里 `localhost` 为 125% | 重启 dev | 主窗口回到 100%，`per_host_zoom_levels` 里没有 `localhost` | 2026-11-08：新 CEF（00:26）跑过 dev 后，`Default/Preferences`（00:38）里 `localhost` 的记录已删，畅游的 `x.com` 还在；运行时复位与手动缩回 100% 都会删掉这条，从文件上分不出是哪一种 |
| [x] | Z4 畅游窗口 | 新 CEF | 畅游打开外部网站，Ctrl+滚轮 | 照常缩放（没有登记） | 待用户确认 |
| [x] | Z5 壁纸窗口 | 新 CEF，窗口模式，桌面是网页壁纸 | 桌面壁纸接收不到滚轮，只看重启后缩放是否 100% | 100% | 待用户确认 |

## 场景壁纸 P4a：层级、粒子、预览画布尺寸与脚本 API 检查

2026-11-07 Windows dev。P4a 落地图层层级、粒子底座与档 1（12 个模块加 `sprite`）、`instanceoverride` 就地生效与粒子生命周期；同批还有预览画布按显示尺寸渲染（`7c77e48a`）和脚本 API 检查（`c8ebf098`，用到未实现的脚本 API 时整张退回）。说明见 `cocs/wpe/WPE_SCENE.md`「层级（P4a）」「粒子（P4a）」。验收工具在 `ignore/p4/step1/`–`step5/`，WPE 参照在 `A:\p4a\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；应用的 vue-tsc 与 `components/wallpaper` 测试 | 0 error；全过 | 2026-11-07（`c8ebf098` 之后）：宿主 tsc 0 error，33 个文件 912 个用例全过；应用 vue-tsc 0 error，场景视图相关 87 个用例全过；格式通过 |
| [x] | P1 层级 · 确定性工程 | Node，`ignore/p4/step1/truth.test.ts` | `proj/p4a` 从磁盘编译，按渲染器的路径算 5 个图层的四角，对 RenderDoc 抓帧 | 四角差不超过 0.01 像素；可见顺序与 `visible` 遮蔽一致；alpha 不继承 | 2026-11-07：最大差 6.1e-5 像素（含三轴旋转、非均匀缩放、三层父链）；可见顺序 h3、h4、h1、h2、h7，h6 不画 |
| [ ] | P2 层级 · 应用里的画面 | Windows dev | 导入 `ignore/p4/proj/p4a`，预览，与 WPE 的同一工程对照；测后删行 | 子层随父层移动、旋转，不可见分组下的子层不画，画面与 WPE 一致 | 语料里还没有能渲染、又带父子层的真实场景；真机只做了粒子回放 |
| [x] | P3 语料变化 | Node，本机 149 个工程 | 每一步前后重扫 `unsupported` | 只在对应键上变化，原来能渲染的场景不掉出 | 2026-11-07：层级让 66 张只少了 `object:parent` / `object:empty`；粒子编译去掉 `object:particle`、风与重力键、`perspectiveoverridefov`；步骤 5 能渲染的 12 → 15，没有掉出；之后脚本 API 检查让 3304642534 重新退回，15 → 14，除 `script:api:*` 外没有别的变化 |
| [x] | P4 粒子 · 确定性工程 | Windows dev 真机 + Node 回放 | 按 WPE 日志的 dt 回放档 1 全部系统；读我们翻译的顶点着色器四角；整帧读回 | 位置差不超过 1e-3（坐标过 1000 时 2e-3）；四角差不超过 0.01 像素；整帧逐像素一致 | 2026-11-07：位置 ≤ 9.2e-4（`burst` 1.1e-3），尺寸、颜色、旋转差 0；四角一帧逐位相同、另一帧最大差 5.7e-5 像素，透视粒子 1.7e-4；整帧 6382 个有内容像素 6214 个逐字节相同，其余全在 P4b 的 `capvelocity` 两行。测试行已删 |
| [x] | P5 shimmering_particles 应用内渲染 | Windows dev，场景宿主（屏外），回放 20 s | `host.particles()` 读粒子数与分布，和 WPE 抓帧的统计比 | 没有不支持项；粒子数、位置、尺寸、alpha 范围与 WPE 相近 | 2026-11-07：`dust motes` 200 个，尺寸 43–996（WPE 200 个、40–999）；3 个 `small_motes` 被 `style` 隐藏，WPE 同样只画一个系统 |
| [x] | P6 3062029089 应用内渲染 | 同 P5 | 同 P5 | 同 P5 | 2026-11-07：雪 600 帧均值 333 个（WPE 344，容量 360），尺寸 1.02–14.97（WPE 1.02–14.88） |
| [x] | P7 两张粒子场景 · 桌面 | Windows，窗口模式 | 分别设为桌面壁纸，看一会儿，与 WPE 对照 | 粒子正常飘动，观感与 WPE 一致，没有闪烁或方块 | 待用户确认 |
| [x] | P8 改粒子属性不重新加载 | Windows dev，shimmering_particles | 依次改「计数」`count`、「发光」`glow`、「风格」`style`，看探针 `stats()` | 就地生效，不整场重编译 | 2026-11-07：`applied` 0 → 3，`recompiled` 0；测后属性还原为未修改 |
| [ ] | P9 隐藏 / 显示粒子图层 | Windows dev，shimmering_particles 预览 | 用「风格」切到显示 `small_motes` 的选项再切回；或用绑了 `visible` 的粒子层 | 隐藏时粒子立刻消失；重新显示后从头慢慢发射，不会一下子涌出一整屏 | WPE 行为已实测（`p4a-life`），模拟器有单测；应用里没有目视 |
| [x] | P10 暂停 | Windows，预览与桌面 | 预览属性面板点「暂停」；桌面在壁纸设置里暂停；各停几秒再恢复 | 暂停时粒子定住；恢复后接着动，不跳、不清空 | 待用户确认 |
| [x] | P11 切换壁纸与关闭预览 | Windows，预览与桌面 | 粒子场景与图片 / 视频 / 其它场景来回切；反复开关预览 | 没有残留粒子或画布；GPU 进程内存不持续上涨 | 待用户确认 |
| [x] | P12 预览无留边 | Windows dev，shimmering_particles 预览，壁纸样式「适应」 | 打开预览，量画布像素与显示尺寸，看边缘 | 画布像素等于显示尺寸 × DPR；没有 `schemecolor` 留边，画面不缩小 | 2026-11-07 主会话真机核对通过。修正前画布按布局尺寸 × DPR 渲染、超 8192 时宽高各自钳制，宽高比被破坏 |
| [x] | P13 预览缩放与属性面板 | Windows dev，预览场景 | 改主窗口大小；展开、收起右侧属性面板；切 `center` 样式对照桌面 | 每次变化 250 ms 内画布跟上显示尺寸，始终没有留边；`center` 的构图与桌面相同 | 属性面板展开时真机核对过：显示 675×126.6 CSS 像素，画布 1013×190，等于显示尺寸 × 1.5。改窗口大小、`center` 对照桌面没测 |
| [x] | P14 3304642534 显示预览图 | Windows dev | 打开它的预览 | 退回作者预览图，原因是 `script:api:*` | 2026-11-07：`script:api:thisScene.createLayer`、`script:api:thisScene.sortLayer`，整场只剩这两项 |
| [x] | P15 原有场景画面不变 | Windows dev | 10 张原本能渲染的场景 × 三档后处理，`renderFrame` 读回哈希，与 P4a 之前比 | 逐张相同 | 2026-11-07：每一步 30 组都相同，含正交深度改成 ±2000、帧时钟钳制 |
| [x] | P16 帧时间 | Windows dev，600 帧 | 探针记录帧时间与每个粒子层的开销 | 不明显变慢 | 2026-11-07：shimmering_particles、3062029089、3304642534 均值都是 3.2–3.4 ms，每个粒子层模拟加写顶点约 0.1 ms。P4a 不设 `maxcount` 上限 |

## WPE 导入标签：工具标签、年龄分级与子目录

2026-11-07 Windows dev，界面语言中文。导入时除作者的 `tags` 外，再挂 WPE 显示的其它标签：已订阅工坊壁纸取 `bin/workshopcache.json` 的 Steam 标签，其余从 `project.json` 推导；分类、类型、来源与分辨率不挂。标签照 WPE 筛选面板分到 `WPE/genre`、`WPE/rating`、`WPE/feature`。key 是 Steam 原文，名称按语言翻译。脚本 `ignore/wpe-tags-test/run.mjs`：用临时目录走真实导入任务，结束时删掉本次的行、任务和新建的标签与目录（标签加目录总数前后都是 5668）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | T1 工坊壁纸取 Steam 标签 | Windows dev，缓存里有 Mature / Puppet Warp 的壁纸 | 用它的 `project.json` 与工坊 id 导入 | 挂 `genre/Anime`、`rating/Mature`，`feature/` 下有 `Audio responsive`、`Customizable`、`Puppet Warp`、`Video Texture`；没有 `3840 x 2160`、`Wallpaper`、`Scene`、`Workshop` | 2026-11-07：符合，`Puppet Warp` 等 `project.json` 没有的标签也在 |
| [x] | T2 分级以 Steam 为准 | Windows dev，全库唯一 `Questionable` 那张 | 同 T1 | 挂 `WPE/rating/Questionable`，名称「家长指导级」 | 2026-11-07：符合，这张的 `contentrating` 是 `Everyone`，只读 `project.json` 会标错 |
| [x] | T3 不在缓存的壁纸走推导 | Windows dev，无工坊 id 的目录 | 导入带音频、`supportsvideoflags: 3`、作者属性、`contentrating: Mature` 的项目 | 挂 `genre/Retro`、`rating/Mature`，`feature/` 下有 `Audio responsive`、`Video Texture`、`Customizable` | 2026-11-07：符合 |
| [x] | T4 key 稳定、名称翻译 | Windows dev，中文 | 看新建标签与目录的路径和名称 | 路径是英文原文（`WPE/feature/Audio responsive`），名称是中文；目录显示题材、年龄分级、特性 | 2026-11-07：符合。五种语言的译名、同语言不重名、不含 `/` 由单测覆盖 |
| [x] | T5 目录名称只在新建时使用 | 单测 | 目录已存在时再传别的名称 | 已有目录不改名，只有最后一段用这个名称 | 2026-11-07：`dir_name_names_only_the_last_new_directory` 通过；插件 JSON 传不进 `dir_name`，失败重试表的旧 JSON 照常读取，也有单测 |
| [ ] | T6 全量重新导入 | Windows，删除全部壁纸 | 重新导入全部壁纸，在标签树看三个子目录，抽几张与 WPE 界面对照 | 标签与 WPE 一致（不含分辨率），默认壁纸有推导出的标签 | 待你重新导入时确认。旧的平铺标签（如 `WPE/Anime`）不会自动清理，会留成空标签 |
| [ ] | T7 没有工坊缓存 | 没装 WPE 或缓存读不到 | 手选文件夹导入 | 导入照常，走推导 | 解析失败与空表由单测覆盖，真机没测 |

## 场景壁纸样式与预览比例

2026-11-07 Windows dev。场景跟随壁纸样式（fill / fit / stretch / center / tile），fit / center 的留白是 `schemecolor`；预览不看样式，按场景自身比例完整显示。场景分辨率导入时写进 `images.width/height`；场景导入还没发版，不做迁移，开发库的存量行用 `ignore/p3c/style-test/fill-dims.mjs` 补过一次（152 行写入 142 行，其余是透视场景或读不到）。脚本在 `ignore/p3c/style-test/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 预览比例 | Windows dev，Eagle Flag 12885（2200×1080）、竖向场景 13306（2893×4092） | 打开预览，从第一时间起连续量画布 | 一打开就是场景比例，中途不变，不裁，没有黑底和阴影 | 2026-11-07：2.037、0.707，画布尺寸全程只有一个值 |
| [x] | S2 五种样式的几何 | Windows dev，12885，预览里把画布临时改成方形，向宿主发样式消息 | 逐个切换截图 | fill 等比盖满、fit 上下留白、stretch 拉满、center 1:1 裁宽、tile 居中重复；不重建宿主 | 2026-11-07：目视符合 |
| [x] | S3 留白取用户值 | Windows dev，12885（用户改过 `schemecolor`） | fit 下读留白像素 | 是用户值，不是工程值 | 2026-11-07：`(61,87,191)` = `0.239 0.341 0.749`，工程值是绿色 |
| [x] | S4 改色就地生效 | Windows dev，12885，fit | 经 `applyUserProperties` 改 `schemecolor` 为红色再还原 | 留白立即变，不重新编译 | 2026-11-07：`(61,87,191)` → `(255,0,0)`，`recompiled` 0 → 0。只进宿主内存 |
| [x] | S5 暂停时切样式 | Windows dev，12885，预览暂停 | fit → tile | 画面更新，时钟不动 | 2026-11-07：时钟停在 4.998 |
| [x] | S6 桌面五种样式 | Windows dev，桌面 13306（竖向），窗口模式 | `set_wallpaper_style` 逐个切换，截壁纸窗口，比较像素 | 五种画面不同，实例不变，fit 留白是 `schemecolor`，tile 按周期重复 | 2026-11-07：两两差异 43.8–74.5；fit 留白 `(248,153,112)` = `0.97255 0.6 0.43922`，右侧 100% 一致，左侧只有 dev 调试面板遮挡；tile 错开一个周期差 3.16、半周期差 68.24；已恢复 fill |
| [x] | S7 退回场景的预览 | Windows dev，13302 | 打开预览 | 画布按场景比例，预览图按 contain 显示，没有「设为封面」 | 2026-11-07：1359×1920（比例 0.708），`object-fit: contain`，按钮未出现 |
| [x] | S8 网页壁纸预览 | Windows dev，12100 | 打开预览 | 仍按主屏尺寸排版，没有黑底和阴影 | 2026-11-07：2560×1440，背景透明、无阴影 |
| [x] | S9 比例不是 16:9 的封面 | Windows dev，13306 | 设为封面，读文件尺寸，恢复默认 | 封面比例等于场景比例 | 2026-11-07：499×706，比例 0.707，已恢复默认。详情面板收起时按钮在窗口外，这次直接触发按钮；屏幕不跳变沿用 C12 的结论 |
| [x] | S10 应用背景 | Windows dev，背景是场景 13306 | 读应用背景的 `styleMode` | 固定 fill，不跟壁纸样式 | 2026-11-07：`styleMode` 为 fill |
| [ ] | S11 fit / center 下的光标效果 | 桌面，带光标效果的场景 | fit 下移动鼠标 | 效果落在鼠标所在位置 | 只有单元测试，真机未测 |
| [x] | S12 新导入写宽高 | Windows dev，测试工程 `kbprops-del` | 「添加壁纸目录」导入，读行 | 宽高是场景分辨率 | 2026-11-07：1920×1080，测完已删行与任务 |
| [x] | S13 从 `scene.pkg` 读分辨率 | Windows dev，本机语料 | `KABEGAME_WPE_ROOT` 指向 WPE 安装目录，跑 `scene_resolution` 测试 | 散文件与真实的包都能读到 | 2026-11-07：通过；开发库 152 行场景读到 142 行 |
| [ ] | S14 宽高带来的列表变化 | 桌面 | gallery 布局看场景格子，详情面板看尺寸，按宽高比筛选 | 格子是场景比例、1:1 预览图不变形；详情显示分辨率；场景进真实分桶，不再是未知 | 只读过代码，真机未测 |

## 壁纸封面截取

2026-11-05 Windows dev。网页与场景壁纸可在预览的属性面板把当前画面设为封面，封面写进 `thumbnails_dir`，换掉 `thumbnail_path`，作者的 `preview.*` 不动，可恢复。截主窗口整窗再裁出画布。C7–C10、C14、C17 是去掉 `clip` 之前测的，写入路径没变，没有重测。脚本与截图在 `ignore/p3c/cover-test/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C1 预览 · 场景 | Windows dev，Beach 12880 | 预览里点「设为封面」 | 网格缩略图立即换新图、不整页刷新；封面在 `thumbnails_dir`，等于画布的屏幕像素，没有看板娘和留白，与画面一致；看板娘恢复；`customCover` 为 true，出现「恢复默认封面」 | 2026-11-05：点击到行更新 243 ms，封面 1070×602（窗口 1200 CSS 宽、缩放 150%），约 145 KB，无看板娘和留白，看板娘属性已移除。上一轮在 clip 路径上确认过网格只打补丁、不整页刷新，写入路径没变 |
| [x] | C2 预览 · 网页 | Windows dev，12100 | 同 C1 | 跨源 iframe 的内容截到 | 2026-11-05：159 ms，1070×602 |
| [x] | C3 暂停取帧 | Windows dev，Deep Space 12881 预览 | 暂停 → 连设两次封面 → 恢复默认 → 取消暂停 | 封面就是停住的那一帧；恢复后接着动 | 2026-11-05：时钟停在 1.565，两张封面逐像素差 0.018；取消暂停后时钟走到 3.069 |
| [x] | C5 退回场景 | Windows dev，13110 | 预览，连续采样按钮 | 没有「设为封面」，暂停开关还在 | 2026-11-05：12 s 采样 116 次，按钮一次都没出现，控制卡片在。后端不再校验实时状态，只靠按钮 |
| [x] | C7 恢复默认封面 | Windows dev，12888 / 12889 / 12097 / 13114 | 点「恢复默认封面」 | 回到作者 `preview.*`，作者文件还在，自定义文件已删除，`customCover` false | 2026-11-05：四张都符合，`preview.*` 大小不变；13114 没有预览图，回到目录本身；退回目标跟着回到 `preview.gif` |
| [x] | C8 重复与清理 | Windows dev，12888 | 连续设两次；再快速双击一次 | 旧文件被删除，只多一个 | 2026-11-05：两次后 `thumbnails_dir` 数量不变（一增一删）；双击只截一次 |
| [x] | C9 删除记录 | Windows dev，副本 `cover-test/kbprops-del`，13116 | 设封面后 `batch_delete_images` | 封面文件被删除，副本目录里的 `preview.*` 还在 | 2026-11-05：行和封面文件都没了；`preview.jpg` md5 不变，目录内容不变。`kbprops-noaudio` 没有预览图，这里用它的副本加了 `preview.jpg` |
| [x] | C10 重新导入 | Windows dev，13114 | 设封面后再导入一次 `ignore/p3c/kbprops-test` | 封面保留 | 2026-11-05：`thumbnail_path` 不变，文件还在，行数 49 → 49，其它行不变；测后恢复 |
| [x] | C11 截取过程 · 宿主 | Windows dev，12880 | 截取前后比宿主状态 | `recompiled` 不变，`kbInstance` 不变，不重新加载 | 2026-11-05：`recompiled` 与 `kbInstance` 都不变 |
| [x] | C12 截取过程 · 屏幕 | Windows dev，12880 / 12100，屏幕采帧约 32 fps | 真实鼠标事件点击，检测每帧与前后 12 帧中位图的差 | 屏幕上不跳变 | 2026-11-05：场景最高分 1.05，网页 2.53，都没有过阈值 6。对照：`clip` 跳变约 120，空闲最高 7.1。预览闪的是 `clip` 的视口模拟，`scale: 1` 也一样，所以截整窗后在 Rust 里裁，封面分辨率降到画布的屏幕像素 |
| [~] | C13 DevTools 客户端常驻 | Windows dev | 首次截取前后比 rAF、宿主 `frameMs` | 没有变化 | 2026-11-05：主窗口缺截取前基线，之后 rAF 141.9 → 144.0，宿主 144 fps，`frameMs` 0.25 → 0.34；同一时刻壁纸窗口宿主 0.33，不像常驻客户端造成的；网格与预览行为没看到变化 |
| [x] | C14 合并回归 | Windows dev | 预览暂停恢复一次；清空 13114 存储一次；看画廊角标 | 均正常 | 2026-11-05：暂停恢复见 C3；清空后键从 2 回到 1，脚本重启，`recompiled` 记 `clear-storage`；「WPE · 场景」角标 36 / 36 |
| [x] | C15 窗口完全遮挡 | Windows dev，12100，主窗口被完全遮挡（`hidden`） | 打开过一次预览后再打开，点「设为封面」 | 报错，不截 | 2026-11-05：提示「wallpaper canvas is not visible」，封面不变，`thumbnails_dir` 无变化。修复前第二次打开能量到矩形，会存下一张残缺的封面 |
| [x] | C16 预览刚打开就点 | Windows dev，12881 第二次预览 | 按钮一出现就点 | 封面是实时画面 | 2026-11-05：按钮 385 ms 出现，点击到行更新 1012 ms，封面是实时画面。按钮只在 `sceneLive` 为真时显示；图层还要淡入 800 ms，第一次复测在这段时间截到黑底，所以截图前等画布里的 CSS 过渡结束 |
| [~] | C17 退回画面显示新封面 | Windows dev，12889 / 13114 | 设封面后取壁纸目标 | `previewPath` 跟着变 | 2026-11-05：字段跟随，恢复后也跟回来。没有实际触发能渲染的场景走退回 |
| [ ] | C18 关闭调试端口 | 打包版 | 没有远程调试端口时设为封面 | 截取照常工作 | dev 下做不了，要在打包版上手动确认 |
| [x] | C19 设置页 | Windows dev，桌面 12888（有自定义封面） | 设置 → 壁纸 → 打开壁纸属性 | 没有「设为封面」和「恢复默认封面」，暂停与清空脚本存储还在 | 2026-11-05：符合 |

## 场景壁纸 P3c：脚本环境、音频与运行时渲染图（进行中）

2026-11-05 Windows dev。脚本环境不再遮蔽浏览器全局，只把 `console` 和 `localStorage` 改写成 WPE 的形状；WPE `localStorage` 存进浏览器存储，按图片 id 与位置加前缀隔离。`engine.registerAudioBuffers` 接上 Phase 8 的 `WpeMediaHub`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与检查 | Windows | 宿主 tsc；`apps/wpe-scene` vitest（设 `KABEGAME_WPE_ROOT`）；Prettier；`check-kabegame --skip vue`；`test-kabegame kabegame wpe_` | 0 error；全过 | 2026-11-05 主会话复跑前三项：tsc 0 error，18 文件 247 passed，Prettier 通过。Rust 两项由子代理跑：cargo 0 error，37 passed，rustfmt 通过 |
| [x] | D1 脚本环境 | Windows dev，bedroom 宿主 | 探针 `host.realmCheck()` | `console` 两项；`localStorage` 是 WPE 形状、没有 `remove`；`fetch` 保留；宿主的键读不到；模块顶层调用抛错 | 2026-11-05 全部符合；语法错误带行列；测后只剩宿主自己的 frame |
| [x] | D2 语料对比 | Windows dev | 全部 41 张 `x-wpe/scene` 跑 `scriptCorpus`，与 3b 逐段比较 | 124 段 `registerAudioBuffers` 与 10 段 `localStorage` 报错消失；`unsupported` 不变 | 2026-11-05：求值失败 127 → 3，两类报错全部消失；原有 38 张 `unsupported` 逐张相同，能完整渲染的仍是 5 张。新出现 9 条报错都在旧场景：这些段以前卡在模块顶层，现在走到了缺失的 `getTransformMatrix` / `getEffect` / `input` / `createLayer`。开跑前扫过全部循环；没有残留 frame 和存储键 |
| [x] | D3 音频订阅链路 | Windows dev，dev 强制渲染，预览 13110 | 读探针 `host.audio()` 两次，间隔 3 s；对照 12889 | 13110 订阅成功、约 30 帧/秒；12889 不订阅 | 2026-11-05：帧数 91 → 181，分辨率 `[64]`；12889 未订阅。峰值 0，当时机器没有声音 |
| [x] | D4 音频随声音变化 | Windows dev，测试工程 13114（`ignore/p3c/kbprops-test`，`project.json` 声明 `supportsaudioprocessing: true`；`AUDIO` 层脚本把 `a.average[0]` 写进 `alpha`）与声明 false 的副本 13115 | 预览、应用背景、壁纸窗口同开 13114；放 `chimes.wav`，再放一次 14 s 的 40 Hz 低音；停止后看回落；副本放在桌面上听同一段声音 | 探针峰值大于 0、约 30 帧/秒；图层 alpha 跟随；停止后回落；多实例各订一份；关预览后采集停止；声明 false 时被拒且不报错 | 2026-11-05：<br>**订阅**：预览帧数 1810 → 2558（24.9 s，30.0 帧/秒），分辨率 `[16]`，无脚本错误。<br>**峰值**：`chimes.wav` 峰值 0.64，整段约 1.7 s 后降到 0.001 以下。`alpha` 全程 0：`average[0]` 对应 64 段的前 4 段（约 30–44 Hz），这段铃声没有这个频段的能量，所以另生成 40 Hz、-18 dBFS 的信号。<br>**图层跟随**：壁纸窗口 13114 上峰值 0.6455、`alpha` 0.616–0.624；声音结束后 `alpha` 约 0.5 s 降到 0.004，1.1 s 时为 0。同一时段预览宿主峰值 0.6445、帧数 5 s 内 +150；当时主窗口被遮挡，预览的 `alpha` 没有 rAF，未量到。<br>**多实例**：应用背景、壁纸窗口、预览依次订阅，日志 `subscriptions=1 → 2 → 3`，三份各 30.3 / 30.0 / 30.3 帧/秒，都没有错误。<br>**采集停止**：换回 bedroom、关预览后订阅数降到 0，日志 `网页壁纸音频采集已停止`（20:38:11、20:41:28 两次），下次订阅再启动。<br>**声明 false**：`subscribed: false`，`error: "this wallpaper does not process audio"`，帧数 0，分辨率仍为 `[16]`，4 段脚本无错误。作桌面壁纸期间 40 Hz 正在播放，141 个采样的 `alpha` 与峰值全是 0。<br>**工程改动**：原工程的 `models/util/solidlayer.json` 报 `model:solidlayer`，整张退回预览图。在工程里放同路径的本地文件、去掉 `solidlayer: true` 后才实时渲染，`unsupported` 为空（见计划步骤 0.6）。<br>**疑点**：铃声过后峰值停在 `3e-45`，20 s 后也没有变成 0（推断：`f32` 次正规数乘 0.75 舍入回原值）。靠 `=== 0` 判断空闲的页面不会进入空闲。<br>**恢复**：副本的行已删、计数键已删；目录 `ignore/p3c/kbprops-noaudio` 留着。真实放音共 3 次（铃声 2 次、低音 1 次） |
| [x] | D5 `localStorage` 持久与隔离 | Windows dev，测试工程 13114；`COUNT` 层脚本在 `init` 里读 `count`、加 1、写回，`update` 把 `(count % 10) / 10 + 0.05` 写进 `alpha` | 关预览再开 4 次；把 13114 设为桌面壁纸，三个宿主一起读；看宿主 `localStorage` 的全部键 | 计数接着涨、每次只加 1；预览与壁纸窗口读同一份；只多出带前缀的键；dev 开关不受影响 | 2026-11-05：<br>**接着涨**：计数 1 → 2 → 3 → 4 → 5，每次重开 `init` 各 1 次。主窗口当时被遮挡，`init` 在加载时跑、不依赖 rAF。<br>**同一份**：应用背景、壁纸窗口读到相同的值 4，再开预览后三处都读到 5；后来主窗口可见时三个宿主的 `alpha` 是 0.65 / 0.85 / 0.75，对应各自 `init` 写入的 6 / 8 / 7。<br>**键**：只多出 `kabegame:wpe-scene:ls:13114:s:count`；之前已有的 `kb-probe`、`kb-probe-0005`、`kb-0005-case12`、`wp_player_state` 都在。<br>**dev 开关**：`kabegame-dev-scene-force-render` 测前为 null，清空测试里置 1 后不受影响（见 D15），测后已删。<br>**恢复**：测试前缀下的键已全部删除 |
| [x] | D6 画廊 WPE 角标 | Windows dev，画廊按「壁纸导入」筛选 | 看网格卡片右上角 | 加载完成后「WPE · 场景」等角标常驻，不被图片盖住 | 2026-11-05：页面 24 个、视口内 12 个，`elementFromPoint` 命中角标、0 个被盖住；截图确认。原因是缩略图层的 `z-1` 与角标同层比较，`.image-wrapper` 改为始终 `isolation: isolate` |
| [x] | D7 预览画布无角标 | Windows dev，主窗口预览 | 预览 vortex | 画布右下角不再有「桌面预览」角标 | 2026-11-05：页面文本里已没有这个角标 |
| [x] | D8 预览底部条全屏按钮 | Windows dev，主窗口预览 | 预览 vortex，看底部控制条 | 全屏按钮贴在条的最右端，普通图片的缩放滑块布局不变 | 2026-11-05：按钮右边距等于条的内边距 10px；壁纸形态下末尾的分隔线已去掉；普通图片靠滑块 `flex: 1` 撑开，`ml-auto` 不起作用，未单独实测 |
| [x] | D9 暂停 · 预览 | Windows dev，主窗口预览；场景 12889 / 12888，网页 12096 / 12097 / 12100 | 点属性面板的「暂停」开关，看探针与 iframe 内的 rAF 计数，暂停前后截图；恢复；再暂停后按方向键切下一张 | 时钟、脚本、rAF、CSS 动画冻结；画面停在最后一帧、不消失；恢复后接着动；切图后恢复播放；桌面不受影响 | 2026-11-05：<br>**场景**：vortex `runtimeSeconds` 冻结在 3.027 s，画布两次截图（间隔 1.5 s）0 像素差；恢复后 2 s 走 2.011 s，画布变化 52.5%。bedroom `update` 冻结在 3673，恢复后继续（vortex 没有 `update`）。同一时段桌面宿主 3 s 走 3.014 s。<br>**网页**：12100 的 rAF 计数冻结在 235，恢复后 1.5 s +217。12097 的 rAF 冻结在 239，4 个 CSS 动画全部 `paused`、`currentTime` 停在 13917 ms，恢复后到 15417 ms。两张的 iframe 都是 `visible`、不透明度 1、2560×1440。12096（rive）调到了页面的 `setPaused`（`__wePaused` false → true → false），画布 0 像素差，恢复后变化 27.8%。<br>**切图**：12889、12096、12097、12100 都是切到下一张后开关回到关闭。<br>**没有清空按钮**：三张网页壁纸的面板都没有。<br>**局限**：12097 的时钟靠计时器走，暂停时仍变化（0.05% 像素，计划写明不管）。没有样本在放真实视频：往 12097 注入循环 `<video>` 后 `paused` 按 false → true → false 切换、页面原有的两个暂停元素恢复后仍暂停，但注入的视频 12 s 内 `readyState` 一直是 0（`networkState` 2），没有验证到播放时间冻结，原因未查。<br>**样本注意**：12096 自己包了 rAF 并限 30 fps，共用 `lastFrameTime`，外部挂的 rAF 回调一直轮不到，计数恒 0，不是暂停造成的 |
| [x] | D10 暂停 · 桌面（场景） | Windows dev，窗口模式，bedroom 12888；设置页面板与 `set_wallpaper_paused` | 暂停 38 s，轮询宿主实例与页面 `timeOrigin`；`location.reload()` 壁纸窗口；恢复。另在设置页「壁纸属性」对话框点开关 | 时钟冻结、画面还在；ping 看门狗不误判；重载后读到暂停且有首帧；恢复后接着走 | 2026-11-05：<br>**冻结**：`runtimeSeconds` 865.0699 不变，`update` 51894 不变，读回设置为 true。暂停中与 38 s 后的截图 0 像素差（跳过 dev 调试面板）。<br>**看门狗**：12 次采样（第 6–39 s）宿主实例不变、`timeOrigin` 不变，日志没有 `ping 未应答`。<br>**重载**：新实例 1.5 s 内起来，`runtimeSeconds` 0、`update` 0、6 段脚本，画面有首帧。首帧是 `scene.json` 的初始颜色：暂停时脚本不跑。<br>**恢复**：1.50 → 4.51 s，3 s 走 3.008 s。<br>**设置页**：对话框里有控制卡片和清空按钮；点开关后设置变 true、时钟 48.394 s 冻结，再点变 false、继续走。<br>**恢复**：设置已回 false，实测读回 |
| [x] | D11 暂停 · 桌面网页壁纸 | Windows dev，窗口模式，临时换成 12097 | `set_wallpaper_paused(true)` 36 s，看 iframe 样式、rAF 计数、CSS 动画；恢复 | iframe 保持可见、画面不消失、rAF 冻结；ping 不误判；恢复后接着动 | 2026-11-05：rAF 计数冻结在 215（9 次采样不变），4 个 CSS 动画全部 `paused`、`currentTime` 12806 ms 不变；iframe `visible`、不透明度 1、2560×1440，截图画面完整；`timeOrigin` 与 iframe target 不变，日志没有 `ping 未应答`。暂停 36 s 内只有时钟文字区域变化（0.08% 像素，计时器驱动）。恢复后 1.5 s rAF +217，动画回到 `running`、到 14306 ms。测后已换回 |
| [x] | D12 暂停时切壁纸 | Windows dev，窗口模式，`wallpaperPaused` 为 true | 依次切 12889（场景）、96（jpg）、746（无音轨 mp4）、12888（场景），最后设回 false | 场景有首帧；普通图片与视频不受暂停影响；切回场景仍暂停 | 2026-11-05：<br>**12889**：`runtimeSeconds` 0，2 s 后仍是 0，截图有完整首帧。<br>**96**：`img` 4096×2341、不透明度 1。<br>**746**：`video.paused` 为 false，`currentTime` 2.47 → 4.47，2 s 走 2 s。<br>**12888**：`runtimeSeconds` 0、`update` 0，设置仍是 true。<br>全程壁纸窗口页面没有重载；设回 false 后 1.51 → 3.52 s |
| [x] | D13 重启后保持暂停 | Windows dev，窗口模式，bedroom 12888 | 设 `wallpaperPaused` 为 true，等落盘后 `touch src-tauri/kabegame/src/commands/settings.rs` 让 `tauri dev` 重启 app | 启动即暂停、有首帧；设回 false 后接着走 | 2026-11-05：<br>重启后 `get_wallpaper_paused` 为 true，`runtimeSeconds` 0、`update` 0、6 段脚本，首帧与 D10 重载的首帧 0 像素差（跳过 dev 调试面板）；设回 false 后 1.51 → 3.52 s。<br>**第一次重启读到 false**：设完不到 1 s 就 `touch`。推断是 `tauri dev` 在设置防抖写盘（5 s）之前结束了进程：第二次等 7.5 s、确认 `settings.json` 已是 true 才重启，就读到了 true。这是全部设置共用的写盘方式，不是暂停设置特有的。<br>**恢复**：设置 false，`settings.json` 已落盘 |
| [x] | D14 暂停时改属性 | Windows dev，主窗口预览 vortex 12889 | 暂停后经属性面板的同一命令把 `ui_editor_properties_mode` 改成 `"1"`，再改回 `"0"`；前后截图 | 画面立即更新、时钟不动、不重编译 | 2026-11-05：`runtimeSeconds` 1.5716 全程不变；改值后 0.7 s 内画布 51.9% 像素变化，再过 1 s 0 像素差（只补画一帧）；`applied` 0 → 1 → 2，`recompiled` 为空。改回后与改动前最大差 1/255。5 个属性的值与 `modified` 与测前逐项相同，metadata id 20077 → 20081 |
| [x] | D15 清空存储 · 单宿主 | Windows dev，主窗口预览 13114；网页壁纸面板对照 | 放一个别的图片 id 前缀的键、本图 `g` 位置的键、dev 开关；点「清空脚本存储」，先取消再确定 | 取消不清空；确定后计数回到 1、`init` 重跑一次；音频订阅保留；别的键不受影响；网页壁纸没有按钮 | 2026-11-05：<br>**取消**：计数 5、`g` 键都在，`init` 不变，`recompiled` 为空；主窗口可见时重测同样不变，确认框已关。<br>**确定**：计数 5 → 1，`g` 键删掉，`init` 各 1 次，日志 `[kbt] init#1`，`stats().recompiled` 有 `clear-storage`，toast「已清空脚本存储」。<br>**音频**：不重新订阅，帧数 3381 → 3441（2 s）。<br>**别的键**：`…:99999:s:probe`、dev 开关、其余 4 个键都在，测后已手动删除探测键。<br>**网页壁纸**：见 D9。<br>**测试注意**：主窗口被遮挡时 Vue 过渡不结束，关掉的确认框留在 DOM 里，脚本要点最后一个框；页面恢复可见后自动消失 |
| [x] | D16 清空存储 · 多宿主 | Windows dev，13114 同时在应用背景、壁纸窗口、预览 | 点按钮 1 次，再用同一命令 `wpe_scene_clear_storage` 连续清 16 次（间隔约 1.7 s），读每个宿主的内存计数（由 `alpha` 反推）与存储值 | 全部宿主重启；观察事件晚到的一方是否删掉别人刚写的计数 | 2026-11-05：<br>**都重启**：每轮三个宿主的 `clear-storage` 各加 1、`init` 各 1 次、音频订阅都保留。<br>**最终值**：主窗口被遮挡时 8 轮存储值都是 3。主窗口可见时点按钮那一轮存储值 2、内存计数 1 / 2 / 1，之后 8 轮存储值都是 3、内存计数 1 / 2 / 3，壁纸窗口总是 1。<br>**竞态**：没有看到晚到的一方删掉别人写的值（那样存储值会回到 1）。存储值是 2 的那轮少一次加 1，更像跨进程读到了尚未同步的 `localStorage`；只看结果两种情况不能完全区分。<br>多实例时计数回不到 1：每个实例的 `init` 都会加一次，这是脚本自己的写入 |
| [x] | D17 泛光判定与加载 | Windows dev，超高档，预览 K3 四组工程（图片 id 13137–13140，测后已删） | 直接加载读 `postprocess` 与判读点；运行中翻 `p_bloom` | HDR / LDR 与 WPE 四组一致；`q3a` 翻开是 HDR 泛光，`q3b` 翻关保持 LDR，`q3d` 翻开是 LDR 泛光 | 2026-11-06：`q3a` hdr true、位 false，`hdrp` 76；`q3b` hdr false、位 true，`hdrp` 153；`q3c` hdr true、位 true，`hdrp` 80；`q3d` hdr false、位 false，`hdrp` 153。四张实时宿主哈希都等于整场读回。翻转 3 组都是 `applied` 0 → 1、`recompiled` 0，`q3a` 翻开 = `q3c`（`4a318fc1db44`），`q3b` 翻关 = `q3d`（`7d35f33da827`），`q3d` 翻开 = `q3b`（`dffb37890467`）。`host.state()` 不带 `postprocess`，判定取自 `renderFrame` 结果 |
| [x] | D18 泛光就地开关 | Windows dev，`q1-ldr`（开启档、超高档）、`q2-hdr`（超高档） | 经 `set_wpe_web_user_properties` 关 → 开 → 关 → 开，再连切 21 次 | `applied` 增加、`recompiled` 不变；关 = 没有泛光时整场加载，开 = 属性为 true 整场加载；HDR 关着时 `brightness` 仍生效 | 2026-11-06：三轮都是 `applied` 0 → 4、`recompiled` 0，写入返回后 1–11 ms 读到新位。`q1-ldr` 关 `7d35f33da827` = 属性 false 整场 = 档位关闭整场 = `ctl-nobloom` 开启档；开 `dffb37890467` = 属性 true 整场 = `ctl-ldr`。`q2-hdr` 关 `52eea48a32e0` = `q3a-jT-pF`，开 `4a318fc1db44` = `ctl-hdr`。关着时 `hdrp` 76，没有回到 153。连切 21 次 `applied` 21、`recompiled` 0，末态正确。控制台没有错误 |
| [x] | D19 关着时改泛光强度 | Windows dev，`b-str-ldr`（开启档、超高档）、`b-str-hdr`（超高档），工程在 `ignore/p3c/step3/accept/proj/` | 关泛光，强度改 0.5，再打开 | 关着时画面不变，打开是新强度，不重编译 | 2026-11-06：三轮关着改完哈希不变，打开后与同值整场加载相同（LDR `c91d420ececb`，HDR `77a3c3cc03a1`），`recompiled` 0 |
| [x] | D20 暂停时切泛光 | Windows dev，预览，`q1-ldr`（开启档）、`q2-hdr`（超高档） | 暂停后切 `p_bloom`，截预览画布 | 画面立即更新，时钟不动 | 2026-11-06：切换后 250 ms 截图。LDR `d20` 24 → 0 → 24，HDR `d80` 210.7 → 0 → 210.7、`hdrp` 80 → 76 → 80。开 / 再开整图差 0，开 / 关差 0.291（LDR）、26.248（HDR）。时钟停在 1.0667、1.1076 没有走，`recompiled` 0 |
| [x] | D21 泛光级数就地 | Windows dev，超高档，`q4-iter` | `p_iter` 8 → 3 → 8，再 8 → 1 → 5 → 8 | 没有重编译；每个 N 等于整场加载；回到 8 是开始的哈希 | 2026-11-06：N=1 `25c6bef52fc6`、N=3 `5a74b8ceb723`、N=5 `2a4e0c97aee3`、N=8 `77a3c3cc03a1`，5 次切换都等于同 N 整场加载，`q4-iter` 的 3、8 也等于字面量 `q4-n3`、`q4-n8`。`applied` 0 → 5，`recompiled` 0，写入后 2–11 ms 读到新值，两轮都回到开始的哈希。渲染目标估算各 N 相同（38705984 字节） |
| [x] | D22 脚本就地写级数与开关 | Windows dev，超高档，`q5-hdr`、`s-hdr-long`（写入帧拉长 10 倍） | 脚本写 `thisScene.bloomhdriterations`、`thisScene.bloom`，每个状态读哈希 | 读回新值、没有重编译；每个状态等于整场加载 | 2026-11-06：写 3 / 8、false / true 都当场读回新值。`s-hdr-long` N=3 `bdc77f3d1a19`、N=8 `2f37b51fdefe`、关 `5f37896bef44`，都等于图层相同的整场加载，关着 HDR 位保持。`stats` 与宿主 debug 日志都没有重编译，控制台没有错误 |
| [x] | D23 脚本打开没有链的场景 | Windows dev，超高档，`q5-ldr`、`s-ldr-long`、`s-nb`（`hdr: true`、`bloom: false`） | 脚本第一次写 `thisScene.bloom = true`，之后反复写 | 走一次整场重编译（`recompiled` +1），之后就地；写完当场读回 `true`；HDR 判定不变 | 2026-11-06。画面：开 `910b2f7a6678`、关 `3cdc028b36f4`，都等于整场加载，`s-nb` 打开后仍是 `rgba8unorm`，HDR 判定不变。`recompiled` 为 1 条 `script（general/bloom）`，宿主日志一次「重新加载」（72–83 ms），之后就地。`q5-ldr` 的 4 次写入都当场读回写入值，同 WPE（K5）。整场重编译本身与 WPE 不同，WPE 同帧、不编译，这是有意的差异 |
| [x] | D24 脚本写入同帧 | Windows dev，超高档，`s-sync-long`、`s-sync-iter-long`（`q5-sync*` 的翻转窗口放长到 30000 帧，判定逻辑不变） | 截预览画布 300 次，判读辉光、K0（同相）、K1（晚一帧） | 辉光始终与 K0 同相；K1 证明看得出一帧之差 | 2026-11-06：`s-sync-long` 排除第一次重编译后，与 K0 同相 300 / 300，与 K1 同相 158 / 300，K0 与 K1 不同的 142 个样本全部跟 K0。`s-sync-iter-long` 300 / 300、144 / 300、156 个全部跟 K0。没有用原工程：宿主绘制 60 Hz，400 帧只有约 6.7 s，放长后样本才够 |
| [x] | D25 `thisScene` 读场景位 | Windows dev，`ctl-nobloom`（超高档）、`ctl-hdr` 与 `q1-ldr`、`q5-ldr`（关闭档） | 读脚本日志；关闭档切位 | `ctl-nobloom` 读 `hdr=true`、实际 LDR；关闭档读到的是场景位，切位没有效果、不重编译 | 2026-11-06：`ctl-nobloom` 日志 `bloom=false iter=8 hdr=true`，结果 `hdr: false`、`rgba8unorm`，同 WPE。关闭档 `ctl-hdr` 读 `bloom=true hdr=true`；`q1-ldr` 切位 `applied` +1、哈希不变；`q5-ldr` 写 `true` 当场读回 `true`、没有重编译 |
| [x] | D26 逐 rAF 压力 | Windows dev，超高档，预览，`q2-hdr`、`q1-ldr` 切 `p_bloom`，`q4-iter` 切 `p_iter` | 宿主 frame 每次 rAF 调 `wallpaperPropertyListener.applyUserProperties` 交替 10 s，与不切换各 10 s 比 | 帧时间不变；没有重编译、没有 WebGPU 错误；切换期间不建管线 | 2026-11-06：每段约 1440 次写入、610 次 `submit`（宿主绘制 60 Hz，低于 rAF 的 145 Hz）。`q2-hdr` `frameMs` 均值 / p95：开 0.29 / 0.4，关 0.22 / 0.3，交替 0.24 / 0.4。`q1-ldr`：0.25 / 0.3、0.21 / 0.3、0.22 / 0.3。`q4-iter`：N=8 0.29 / 0.4，N=3 0.25 / 0.3，交替 0.32 / 0.5。三段交替 `createRenderPipeline*`、`createShaderModule`、`createBindGroup`、`createTexture`、`createBuffer` 都是 0。`copyTextureToTexture` 开 610、关 0、交替 249，说明关着确实不拷快照。`recompiled` 0，结束回到开始的哈希，没有错误、没有退回 |
| [x] | D27 真实场景不回归 | Windows dev，bedroom 12888、vortex 12889，开启档、超高档 | 预览；读窗口日志与控制台；看桌面宿主 | 正常出图，没有 WebGPU 错误，桌面不受影响 | 2026-11-06：四次整场读回都等于动手前基线（12888 `f6baf0b36aae` / `57ee0c850c78`，12889 `a8434454c9a3`）。12888 超高档 `rgba16float`、8 级、渲染目标约 161 MiB。控制台 0 条错误或告警，截图画面正确。桌面宿主全程是 12888，时钟在走，`applied` 0，只有切档位带来的 `settings` 重载 |
| [x] | D28 与 WPE 比绝对值 | Windows dev，WPE PID 36548、`ultra`、窗口客户区 1920×1080；Kabegame 场景目标 1920×1080 | 两边读 K8 判读点（5×5 平均）并比整帧 | 辉光与 `hdrp` 和 WPE 一致 | 2026-11-06：`ctl-nobloom`、`ctl-ldr` 整帧逐像素相同（最大差 0）。`ctl-hdr`、`q4-n8`、`q4-n3` 最大差 1，平均差 0.025、0.028、0.001，差大于 2 的像素 0 个。读数表见计划「步骤 3」 |
| [ ] | D29 工坊样本 2582765611 | Windows dev，超高档 | `bloom: {user: "highlight", value: false}`，切一次 | 就地切换 | 跳过：`unsupported` 不为空（`object:particle`、`object:text`、`object:sound` 等），退回预览图 |
| [x] | D30 壁纸窗口里切泛光 | Windows dev，窗口模式，超高档，`q1-ldr`、`q2-hdr` | 把测试工程设为桌面，切 `p_bloom` 往返两轮 | 同预览 | 2026-11-07：两个工程都是 `applied` +4、`recompiled` 0，`bloomEnabled` 14 ms 内读到新值，宿主 rAF 145。`q1-ldr` 开 `dffb37890467`、关 `7d35f33da827`，`q2-hdr`（`rgba16float`、8 级）开 `4a318fc1db44`、关 `52eea48a32e0`，都等于同值整场加载，往返稳定。没有 WebGPU 错误。放回 12888 |
| [x] | D31 `general.hdr` 绑属性 | Windows dev，超高档 | 3355291946 或自建工程改属性 | 整场重编译并生效（已定 12） | 2026-11-07：3355291946 不能实时渲染（`general:perspectiveoverridefov`、`object:font` 等，退回预览图）。改用自建 `d31-hdr`（`hdr: {user: p_hdr, value: false}`，只有字面量图层）。false → true → false 两次都是一次整场重编译，原因 `postprocess-hdr（general.hdr）`，用时 103、87 ms。true 是 `rgba16float`、8 级，`d10` 182.68，`d40` 95.6，`d80` 52.6；false 是 `rgba8unorm`，`d10` 52，`d40` 3。三个状态都和同值整场加载逐像素相同（`82ffb5fec8ad` / `a85cf7afb057` / `82ffb5fec8ad`）。没有 WebGPU 错误。WPE 一侧按已定 12 不比 |
| [x] | D32 `clearcolor` 绑属性 | Windows dev，预览 `q1-clear`、`q1-clear-num` | 经 `set_wpe_web_user_properties` 同时改清屏色与 `p_alpha`，各 12 次，逐帧读场景目标；6 个值比同值整场加载 | `applied` 增加、`recompiled` 不变；读数同 L10；变化帧 − mark 是 1；就地 = 整场加载 | 2026-11-07：两个工程都是 `applied` 0 → 12、`recompiled` 0，变化帧 − mark 12 / 12 是 1，与 K 同帧。读数和 L10 全部相同：`0.25 0.5 0.75` → 64, 127, 191，`0.1 0.2 0.3` → 25, 51, 76，数字 0.25 → 64, 64, 64，0.5 → 127, 127, 127。12 对就地 / 整场屏蔽 `FR` 块（脚本写帧号，探针整场加载不跑脚本）后逐像素相同。加载帧与 WPE 1920×1080 窗口整帧差 0 |
| [x] | D33 `clearenabled: false` 加载 | Windows dev，预览 `q2-false`、`q2-value`、`q2-user-pfalse` | 第 1 帧起逐帧读场景目标，按 `FR` 帧号判读；另与 WPE 1920×1080 窗口比 | 同 L11：同奇偶历史格都在、异奇偶 0 个、背景黑、`clearcolor` 不出现；`ACC` 成对上升 | 2026-11-07：`q2-false` 339 帧：同奇偶 28561、异奇偶 0、缺失 0、颜色不符 0、`bg` 全 0，与 L11 逐项相同；`q2-value`、`q2-user-pfalse` 119 帧：3481、0、0、0。`ACC` 25, 25, 48, 48, 68, 68, 86, 86, 103, 103, 118, 118，逐值等于 L11。和 WPE 同帧比：`q2-false` 139 帧判读点差 0、TRAIL 450 格差 0，14 帧整帧逐像素相同（最大差 0）；另两个各 39 帧相同。`load` 全程，两张目标逐帧交替，`recompiled` 0，没有 WebGPU 错误。不清屏目标 `bg` 处 alpha 读 0，对画面没有影响 |
| [x] | D34 `clearenabled` 运行中切换 | Windows dev，预览 `q2-user` | 一条命令同时改 `p_clearen` 与 `p_alpha`，6 轮 12 次，时刻随机，在 450 帧内做完 | 切到 false 当帧带 N−2 的块，切回 true 当帧只剩 1 块，`bg` 不变 | 2026-11-07：K 翻转帧 − mark 12 / 12 是 1。true → false 6 / 6 块偏移 {0, 2}（帧 16、50、82、117、152、180，奇偶都有），false → true 6 / 6 只剩 1 块（`load` 变成 `clear`）。true 的 90 帧全是 1 块。`bg` 224 帧全是 25, 51, 76。`applied` 12、`recompiled` 0，没有 WebGPU 错误 |
| [x] | D35 上屏的是这一帧画的那张 | Windows dev，预览 `q2-false`、`q2-user-pfalse`，画布 3840×2160 | `render()` 同一任务内把画布画进 2D 上下文读回 90 帧，和同帧的目标读回比 | 画布显示当前目标，不是另一张 | 2026-11-07：两个工程都是 90 / 90：本帧格在、上一帧格空、N−2 格在，`FR`、`ACC` 与目标读回相同。D33 等读的是离屏目标，这一条补上屏 |
| [x] | D36 不清屏 + LDR 泛光 | Windows dev，Kabegame 超高档；WPE PID 36548、`ultra`、窗口客户区 1920×1080 | `q2-bloom-ctl`、`q2-bloom-ldr` 两边按帧比判读点与整帧 | 辉光写回底图、成对累加，与 WPE 一致 | 2026-11-07：`q2-bloom-ldr` 139 帧判读点差 0，15 帧整帧逐像素相同。`d10` 52, 52, 104, 104, 156, 156，第 9 帧 255；`d40` 第 19 帧 233.2；`d80` 第 39 帧 255；`d160` 第 59 帧 31.6。`q2-bloom-ctl` 49 帧差 0，6 帧整帧相同。尺寸对齐，比的是绝对值，L20 的数字是 960×540 窗口，不能直接比 |
| [x] | D37 不清屏 + HDR | 同 D36，修后宿主 `index-B_EI8GdX.js` | `q2-bloom-hdr`；另测 `q2-hdr-nobloom`（HDR、不清屏、泛光位关） | 累加趋于收敛，与 WPE 一致 | 2026-11-07 修后通过。139 帧判读点差都不到 1，`ACC` 25, 25, 28, 28…，第 139 帧两边都是 `ACC` 28、`bg` 0、`d80` 71.4、`d320` 8、`d640` 1；`d160` WPE 26.6、我们 26.7。整帧第 1–10 帧最大差 1，平均差 0.04。**残余**：第 19、39、79、139 帧最大差 2、9、36、81，差大于 2 的 0、580、418、277 像素，平均差 0.049–0.064，都在 GLOW 外一条约 1 像素宽的圆环上（半径约 120 像素），是累加的分界线，推断是 FP16 舍入位置不同，其余只有 ±1 的等值线。`q2-hdr-nobloom` 88 帧差 1 以内，10 张整帧最大差 1。修前第 139 帧是 `ACC` 255、`bg` 47.6、`d640` 131.9，整帧平均差 134.5。依据见报告 L21 |
| [x] | D38 环境光绑属性 | Windows dev，预览 `q3-light`、`q3-light-num` | 改 `ambientcolor`、`skylightcolor` 属性，读 `AMB`、`AMBF`、`SKY` | 读数同 L12，不重编译，数字铺满 | 2026-11-07：`0.25 0.5 0.75` → 64, 127, 191，`0.1 0.2 0.3` → 25, 51, 76，`0 0 0` → 0，`0.4 0.6 0.8` → 102, 153, 204，数字 0.5 → 127，0.9 → 229，0.6 → 153，全部等于 L12，`AMB` = `AMBF`。`applied` 8、6，`recompiled` 0。7 对就地 / 整场逐像素相同，加载帧与 WPE 整帧差 0。`q3-light-num` 第一步写的值等于默认值，读数不变，所以脚本的「变化帧」那条是用例写法，K 翻转帧 − mark 仍是 1 |
| [x] | D39 `g_EyePosition` | Windows dev，预览 `q4-eye-zero`、`q4-eye-nz`、`q4-eye-user`、`q4-eye-1280` | 读 `EYE`、`EYELO`、`EYEHI`、`MARK`，改 `p_eye` 8 次 | 同 L13：`(W/2, H/2, 2000)`，图层不平移 | 2026-11-07：`EYE` 64, 64, 127，还原 959.7、540.1、1999.8；1280 工程 42, 42, 127，还原 639.5、360.4、1999.8，全等于 L13。`q4-eye-nz`、`q4-eye-user` 与 `q4-eye-zero` 逐像素相同，三个工程与 WPE 1920×1080 窗口整帧差 0，`q4-eye-1280` 与 WPE 1280×720 窗口整帧差 0。`p_eye` 改 8 次读数一种，`recompiled` 0 |
| [x] | D40 脚本读 general 字段 | Windows dev，预览 `q5-keys`、`q5-nokeys` | 比脚本 `init`、第 5 帧打的字段 | 类型与缺省值同 L14 | 2026-11-07：16 个字段的类型和值都相同，缺省值 3 / 0.5 / 1 / 0.5 / 0.1 / 0.5、`camerafade` true、`bloom` true 都对。差异只有已知的：读回不是 float32，`zoom`、`perspectiveoverridefov` 是 `undefined`，`thisScene` 成员 30 个（WPE 61 个）。`q5-nokeys` 缺键时 `bloom` 为 true，超高档两边都有泛光，整帧差 0 |
| [x] | D41 脚本写入与同帧 | Windows dev，预览 `q5-write`、`q5-sync-clear`、`q5-sync-amb` | 比写入日志与逐帧画面；60–460 帧每 2 帧翻一次，同 K5 | 当场读回，不重编译；与 `K0` 同相、与 `K1` 差一帧 | 2026-11-07：`q5-write` 36 行日志除 float32 外逐行相同（含 `Vec3`、数字、普通对象写入与读到拷贝），95 帧判读点差 0，f = 30、40、50 当帧变色。`clearcolor`、`ambientcolor`（顶点与片元）、`skylightcolor` 都是 400 帧：与 `K0` 不同 0、与 `K1` 不同 200、与 `on(f)` 不符 0，等于 L14。`recompiled` 0，`recompileWrites` 0。f = 71–80 `camerashake`、`cameraparallax` 开着，WPE 画面抖动，我们不动，是已定 14，留下的 12 张整帧里只有 f = 80 有差（4808 像素，都在色块边缘） |
| [x] | D42 `{script}` 挂 general | Windows dev，预览 `q5-scr-vec`、`q5-scr-bool`，修后宿主 | 比画面与日志 | `update` 返回值写回，`thisLayer === thisObject` | 2026-11-07 修后：`String(thisObject)`、`String(thisLayer)` 都是 `[object Object]`，同 WPE，修前抛 `TypeError`。`q5-scr-vec` 115 帧判读点差 0，10 张整帧差 0；日志 25 行、10 行里 21 行、9 行逐行相同（含 float32）。`thisLayer === thisObject` 为真。**还差一点**：`thisObject.constructor.name` 我们是 `Object`，WPE 是空串，日志里这 5 行就差在这里和成员数上（`ownCount` 26 对 48，字段还没做全） |
| [x] | D43 没有声明的脚本关清屏 | Windows dev，预览 `q5-clearen` | 脚本第 40、120 帧写 false，80、160 帧写 true；读创建记录、错误与每帧块 | 当场建第二张，没有 WebGPU 错误，之后链正常 | 2026-11-07：第 40 帧当场建 `scene target 2`（usage 23），拷贝提交 1 次，没有 WebGPU 错误，`recompiled` 0。这一段与 WPE 不同，是风险 12 的已定差异：f = 40 块偏移 {0, 1}（WPE {0, 2}），f = 40–78 的偶数帧带第 39 格、没有第 38 格，共 20 帧；判读点差 0。切回 true 当帧干净。第二段 f = 120 起偏移 {0, 2}，f = 119–122、159–161 整帧逐像素相同 |
| [x] | D44 逐 rAF 写 general | Windows dev，预览 `q1-clear`（`p_clear`）、`q3-light`（`p_amb`） | 宿主 frame 逐 rAF 调属性入口 10 s，前后各空闲 10 s | 没有重编译、没有 WebGPU 错误，帧时间不变 | 2026-11-07：每段 1441 次写入、约 610 次 `submit`，rAF p95 7 ms。`frameMs` 均值 / p95：`q1-clear` 空闲 0.28 / 0.4，写 0.26 / 0.4，写后 0.24 / 0.3；`q3-light` 0.27 / 0.4、0.27 / 0.4、0.27 / 0.4。`recompiled` 0，写入期间没有建管线、着色器、bind group、纹理。`q3-light` 的 `writeBuffer` 1220 → 3023，多的是灯光刷新 |
| [x] | D45 暂停时改清屏色 | Windows dev，预览 `q1-clear` | 点属性面板的暂停，改 `p_clear` 3 次 | 画面立即更新，时钟不动 | 2026-11-07：每改一次 `seq` 只加 1，`bg` 255, 0, 0 → 0, 127, 0 → 64, 127, 191，时钟停在 0.8731，`recompiled` 0，恢复后接着走，`wallpaperPaused` 没有变 |
| [ ] | D46 不清屏场景暂停时补画 | Windows dev，预览 `q2-false` | 暂停后改 `p_alpha` 3 次 | 4.1 留的疑点，WPE 这一侧没有测 | 2026-11-07：疑点成立。`FR` 不变（37），目标逐次交替，`ACC` 暂停时 219，三次补画后 219、223、223，也就是每次补画多画一层、画面换到另一条链。WPE 暂停时的行为没有测：暂停主实例会影响用户壁纸。用户决定不动，已知差异 |
| [x] | D47 `stats().rebuilds` | Windows dev，预览 13114 | 经宿主属性入口切 `p_effvis`，慢切 20 次，再逐 rAF 10 s，放回原值 | 计数增加，不重编译 | 2026-11-07：慢切 20 次均值 0.21 ms、最大 0.4 ms；逐 rAF 10 s 后共 260 次，均值 0.18 ms、最大 0.5 ms，`frameMs` 0.36 / 0.6。`recompiled` 0，放回后哈希相同（`bde815a092a3`）。没有写库，`metadataId` 20265 不变；`init` 给存储计数加的 1 已写回 30 |
| [x] | D48 第二张目标的显存 | Windows dev，1920×1080 工程 | 读 `targetBytes` 与加载日志 | 清屏可能关掉的场景多一张目标 | 2026-11-07：`q1-clear` 8294400，`q2-false`、`q2-user` 16588800，差值 8294400 = 1920×1080×4。`q5-clearen` 没有声明，加载时 8294400。HDR：`q2-bloom-hdr` 约 53 MiB，`d31-hdr` HDR 约 37 MiB，差 16 MiB |
| [x] | D49 整体不回归 | Windows dev，bedroom 12888、vortex 12889，开启档、超高档；桌面 12888，`disabled` | 预览、整场读回比基线；测试壁纸放回 12888 后读壁纸窗口 | 哈希等于动手前，没有 WebGPU 错误，桌面正常出图 | 2026-11-07：12888 `f6baf0b36aae` / `57ee0c850c78`，12889 `a8434454c9a3`，四次都等于基线，控制台没有错误。这四次是修 D37、D42 之前的宿主，修后的 18 个哈希由主会话核对。桌面（修后宿主）：放回 12888 后 `.wallpaper-scene-live` 是 `live`，没有预览图，时钟在走，`frameMs` 0.41 / 0.6，画布 3840×2160、均值 20.6，整场读回 `f6baf0b36aae` 等于基线，没有错误 |
| [x] | D50 HDR 运行中切 `clearenabled` | Windows dev，超高档；WPE 同 D36；`hdr-scr`、`hdr-scr-nb`（脚本第 40–79、120–159 帧不清屏）、`hdr-user`（属性） | 脚本工程两边按帧比；属性工程 6 轮 12 次，比每次切换 | 切到 false 当帧接 N−2、过一次 `lin`；切回 true 当帧干净；就地 | 2026-11-07：`hdr-scr` 189 帧、`hdr-scr-nb` 190 帧判读点差 1 以内，`ACC` 第 39 帧 25、第 40 帧 28、第 80 帧 25 两边相同。整帧：`hdr-scr-nb` 19 张最大差 1；`hdr-scr` 18 张里 16 张最大差 1，第 79、159 帧最大差 11（约 610 像素，同 D37 的圆环）。`hdr-user`：两边 12 次都是切到 false 偏移 {0, 2}、`ACC` 25 → 28，切回 true 1 块、`ACC` 28 → 25，`bg` 0。我们这边 `applied` 12、`recompiled` 0，mark 差全是 1 |
| [x] | D51 HDR 不清屏的 WebGPU 规则与显存 | Windows dev，超高档 | 真机跑 `q2-bloom-hdr`、`q2-hdr-nobloom`、`hdr-scr`、`hdr-scr-nb`、`hdr-user`，读 `uncapturederror`、`device.lost`、`targetBytes` | 第二张目标 + 快照中转没有校验错误 | 2026-11-07：5 个工程共 850 帧，校验错误 0，设备丢失 0。`targetBytes` 都是 55294784，日志约 53 MiB，与修前相同：这些场景本来就有泛光链，快照早就建好了。「没有泛光链时第一次用才建快照」**没有测到**：HDR 判定要 `general.bloom` 文件值为 true，这时非空场景一定有链，构造不出来 |
| [x] | D52 桌面不清屏 | Windows dev，窗口模式，`q2-false`（`disabled`）、`q2-bloom-hdr`（超高档）设为桌面 | 壁纸窗口宿主第 1 帧起逐帧读目标，另在 `render()` 同一任务读画布 90 帧，和 WPE 按帧比 | 两张目标逐帧交替，上屏的是当前这张，没有 WebGPU 错误 | 2026-11-07：两个工程 139 帧都逐帧交替，画布 3840×2160、90 / 90 帧显示当前目标，错误 0。`q2-false` 139 帧判读点差 0，TRAIL 差 0，14 张整帧最大差 0。`q2-bloom-hdr` 读数与 D37 预览相同，`ACC` 25, 25, 28, 28… |
| [x] | D53 桌面改属性 | Windows dev，窗口模式，`q1-clear`、`q3-light` 设为桌面 | 经 `set_wpe_web_user_properties` 改 4 次、3 次 | 就地生效 | 2026-11-07：`applied` +4、+3，`recompiled` 0，K 翻转帧 − mark 全是 1。`bg` 64, 127, 191 / 255, 0, 0 / 25, 51, 76 / 0, 0, 0；`AMB` = `AMBF`，64, 127, 191 / 255, 0, 0 / 25, 51, 76，`SKY` 191, 127, 64 / 0, 255, 0 / 102, 153, 204，同 D32、D38。没有错误 |
| [x] | D54 纯色图层 | Windows dev，宿主 `index-BPQzyznU.js`，预览（档位 `disabled`，都是 `bloom: false`）；WPE PID 36548，`-playInWindow`，客户区 1920×1080。工程 `ignore/p3c/step4/accept/solidp/`：`s-real`、`s-kb`（13114 的工程去掉 `COUNT`、`AUDIO`，4 层）不放本地模型，走 `assets`；`t-solid`、`t-plain` 带纹理，128×512、完整 mip，模型一个有 `solidlayer: true`，一个没有 | 看 `unsupported`，第 25 帧读场景目标，和 WPE 比整帧；`t-*` 用自写 effect `kbres` 把合成 RT 的分辨率画出来：后面挂直通 effect 时量光栅化尺寸，同时读 `g_Texture0Resolution` | `model:solidlayer` 不再报，画面与 WPE 一致；带纹理时合成 RT 按图层 `size`，对照工程按纹理尺寸 | 2026-11-07 通过。四个工程 `unsupported` 为空，没有 WebGPU 错误。**真实 solidlayer**：`s-real` 12 层（`size` + `scale`、`color`、`alpha`、`angles`、组合、重叠、`tint`、`blur`、2×2、301×3）与 `s-kb` 整帧最大差 0，差异像素 0。**带纹理**：`t-solid` 7 层整帧最大差 0。合成 RT 两边读数相同：`t-solid` 约 600×200、300×400、300×200（最后一个图层 `size` 300×200、`scale` 1.5，RT 不随 `scale`），`t-plain` 全部约 128×512；Kabegame 建纹理记录是精确的 600×200、300×400、300×200 与 128×512。读数量化约 ±2。**灵敏度**：同一引擎 `t-solid` 对 `t-plain`，`res2` 平均差 WPE 92.2、Kabegame 91.8，看得出。第一版只挂 `kbres` 时带 0 两个工程读数相同（它是最后一个 pass，量到的是屏幕四边形），换成后面挂直通才量到 RT。**对照工程整帧不一致**：`t-plain` 最大差 255，差大于 2 的 156979 像素，不是 solidlayer 的问题。其中 `noeff` 层（没有 effect）量到 WPE 普通图层 UV 内缩：棋盘竖边相对 `solidlayer` 线性位移，两端 ±0.60 像素、中间 0，拟合 e = 0.001183，0.15 / 128 = 0.001172，Kabegame 不内缩。其它层的差异没有单独量。**单层 mip 差异**：同一工程纹理只有 1 层 mip 时，`t-solid` 最大差 47，`noeff` 差大于 2 的 45651 像素；换完整 mip 后为 0。这条与 solidlayer 无关，原因没有验证 |
| [x] | D55 图层 UV 内缩 | Windows dev，宿主 `index-CE8NVmzY.js`，预览；WPE PID 36548，`ultra`，`-playInWindow`。工程 `ignore/p3c/step4/accept/uvp/` 与 `solidp/` | 比离屏场景目标和 WPE 窗口帧：`t-plain` 等基准工程，x、y 两个方向，NPOT、FreeImage、无纹理普通模型，passthrough 与 `colorBlendMode` 31 各有无 effect；真实场景只比两边都静止的像素 | 上屏的四边形内缩 `0.15 / 纹理尺寸`，中间步骤不缩，`solidlayer` 不缩，和 WPE 一致 | 2026-11-07：`t-plain` 最大差 255 → 1（214 像素），`t-solid`、`s-real`、`s-kb` 仍是 0。各路径实测的 e 都和规则相符，明显区别于错分母。真实场景平均差 bedroom 0.048、vortex 0.055、beach 0.285、deep_space 0.282；eagleflag 整张在动，没有比成；内缩前没有同口径结果。非整数 `size` 的四边形另有差异，已记入 3c 后续。 |
| [x] | D56 工坊 X-Ray 场景 | Windows dev；2077883354、2077888249、2418800402、2833452727、2961807954 | 逐张看实时渲染 | 正常渲染，不退回预览图 | 2026-11-07：用户确认 5 张都正常。已加进 `pipeline.test.ts` 的 `workshopUnlocked`。 |

步骤 3 的真机验收，2026-11-06。脚本、读回与结果在 `ignore/p3c/step3/accept/`。开测时主窗口被别的窗口完全遮住，裸 CDP 读到 `hidden`，rAF 为 0，所以全程用 `Emulation.setFocusEmulationEnabled` 让页面按可见处理，rAF 145 Hz，没有抢前台。测试行 13122–13148 与两个任务已删，「场景后处理」恢复成 `disabled`。

步骤 5 的真机验收，2026-11-07，宿主入口 `index-tuHOF3yg.js`。脚本、读回与结果在 `ignore/p3c/step4/accept/`。Kabegame 一侧在宿主第一行脚本之前注入插桩，第 1 帧起逐帧读离屏场景目标，每帧都读到，不靠时间对齐；D35 另读画布。WPE 用主实例 PID 36548、`ultra`、`fps=10`、`msaa=none`，`-playInWindow` 开 1920×1080 窗口，`PrintWindow` 抓帧。全程开着 `Emulation.setFocusEmulationEnabled`；收尾时裸 CDP 读到 `visible`、rAF 145 Hz，前台是别的窗口，有没有被遮住没有量。测试行 13209–13237 与两个任务已删，图片 9899、任务 639、画册 5660 与测前相同，「场景后处理」是 `disabled`。

步骤 5 复测，2026-11-07，宿主入口 `index-B_EI8GdX.js`，修的是 D37、D42。D46 用户决定不动。桌面用例临时换过壁纸，已放回 12888。测试中用户把壁纸过渡改成了 `none`（测前 `fade`），时间不确定，所以 D30、D52、D53 与放回 12888 在过渡稳定为 `none` 时整组重跑，表里是重跑的结果；两轮结果相同。测试行 13238–13257 与两个任务已删，计数同上。

## 类型过滤新增 Wallpaper Engine 分类（`x-wpe`）

2026-11-05 macOS。媒体分类从两类（`video/*` 视频、其余图片）改成三类互补：`video/*` 视频、`x-wpe/*` WPE、其余图片。`type_not_glob2` 模式串、列举不补 0 且按字母序；前端以 `GALLERY_MEDIA_KINDS` 枚举，图片详情的「Wallpaper Engine · 类型」两段可点击筛选。计划阶段另在内存库（6.5 万行）验证三类之和等于总数，图片沿 `idx_crawled_at`，视频与 WPE 走 `idx_images_type`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 core 测试 | macOS | `kabegame-core --test dsl_e2e`、`--lib storage` | 全过 | 2026-11-05：61 passed、127 passed。含三类互补对照 SQL、`x-wpe` 与 `video` 走 `idx_images_type`、图片沿 `idx_crawled_at`、WPE 子类列举、原生有效路径不含 WPE |
| [x] | S2 前端测试与类型 | macOS | `apps/kabegame` Vitest；`check-kabegame` | 全过、0 error | 2026-11-05：590 passed；vue-tsc 无错误。新增 `x-wpe` 的相关性、路径往返、过滤树顶层与子层文案用例 |
| [x] | D1 类型下拉 | macOS dev，库里 16 张场景、2 张网页 | 打开画廊「类型」下拉，与 `pathql_list` / `pathql_entry` 对照 | 有 Wallpaper Engine 一项，计数正确；图片计数不含 WPE | 2026-11-05 通过：hide 视图「仅图片 4082、仅视频 101、Wallpaper Engine 18」，合计等于页头 4201；全库 5182 + 120 + 18 = 5320 |
| [x] | D2 子类与 chip | macOS dev | 展开 Wallpaper Engine，选「网页」 | 子类显示视频 / 网页 / 场景；chip 文案、结果数与网格一致 | 2026-11-05 通过：子类为场景 16、网页 2，chip「Wallpaper Engine / 网页」，网格 2 项，刷新后恢复。库里没有 `x-wpe/video` 行，临时改一行测得「视频 (1)」，测完还原 |
| [x] | D3 高级查询 | macOS dev | 高级查询加一条「种类」选 Wallpaper Engine，应用后刷新页面 | 能选到；路径 `media-type/x-wpe/...` 刷新后恢复 | 2026-11-05 通过：候选差值为图片 −119、视频 −4100、WPE −4183，命中 18 张，路径 `~not/~not/media-type/x-wpe/~end/~end`，刷新后仍 18 项 |
| [x] | D4 详情芯片 | macOS dev | 打开网页、场景壁纸与临时 `x-wpe/video` 行的详情，点「Wallpaper Engine」与子类 | 前者筛出全部 WPE 行，后者只筛该子类；普通图片 / 视频的芯片显示与点击不变 | 2026-11-05 通过：网页点主类得 18 项；场景点子类得 16 项；`x-wpe/video` 显示「Wallpaper Engine · 视频」且有两个按钮（子类没有被清掉）。普通图片「图片 / JPG」、视频「视频 / MP4」的图标与大写不变，点击分别筛 `仅图片 / jpg`、`仅图片`、`仅视频` |
| [x] | D5 无数据分类 | macOS dev | 插件过滤选 konachan、PixAI，看类型下拉 | 范围里没有的分类不列出 | 2026-11-05 通过：konachan 只有「仅图片 529」，PixAI 只有图片与视频，清除后三项恢复。界面选不到「已选视频但范围里没有视频」，选视频后插件列表只剩有视频的插件；这一状态只能来自保存的路径，路由由 e2e 覆盖（计数 0、不报 not found），chip 显示未真机验证 |
| [ ] | D7 轮播 | Windows / Linux 原生壁纸模式 | 用含 WPE 行的视图轮播 | WPE 行不被计入，也不被切到 | 未真切壁纸：只核对了有效路径，`gallery/hide/sort/by-time` 为 4201，拼 `_kb_fc/media-type/image` 后为 4082，e2e 断言 rank 查不到 WPE 行；rotator 的 `allow_wpe` 保留给 Plasma |

## 启动时跑 `ANALYZE`，视频分类走索引

2026-11-05 macOS dev。主程序每次启动在 schema 迁移之后跑完整 `ANALYZE`；媒体分类改成绑定模式串的 `images.type GLOB ? AND images.type NOT GLOB ?`。计划阶段的对比实验用生产库（6.5 万图、166 万 `album_images`）在内存里跑，数字见 `cocs/provider-dsl/RULES.md` §2.2。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 三种 feature 组合编译 | macOS | `check-kabegame`（standard、`-c kabegame-cli`、`--mode web --skip vue`） | 全部 0 error | 2026-11-05 通过 |
| [x] | S2 core 测试 | macOS | `kabegame-core --lib storage`、`--test dsl_e2e` | 全过 | 2026-11-05：127 passed、61 passed。e2e 在 `ANALYZE` 之后检查实际 DSL 生成的计划，并断言 `x-wpe/video` 归图片、两类互补 |
| [x] | S3 前端测试 | macOS | `apps/kabegame` Vitest | 全过 | 2026-11-05：582 passed |
| [x] | D1 启动写入统计 | macOS dev | 启动后读日志与开发库 | 日志有 `ANALYZE finished`，`sqlite_stat1` / `sqlite_stat4` 有数据 | 2026-11-05 通过：38 行、679 行 |
| [x] | D2 视频分类性能 | macOS dev | `KABEGAME_SQL_DEBUG=1` 读 `media-type/video` 第 1 页实际耗时 | 明显下降，image、webp、jpg、宽高比不变慢 | 2026-11-05 通过：video 58ms → 1ms，其余 1～2ms。开发库 5.3K 图，毫秒级取整 |
| [x] | D3 分类结果 | macOS dev | 经 CDP 调 `pathql_fetch` / `pathql_list`，与 SQL 对照 | 列举计数、分页、画册 `image-only` / `video-only` 正确 | 2026-11-05 通过：image 5200、video 120 与旧写法一致；video 页全是 `video/*`；示例画册 3 个视频与 SQL 一致 |
| [x] | D4 CLI 不跑 | macOS dev | `--via local plugin run wpe-import --dry-run` 开 SQL 调试 | 打开 Storage 但没有 `ANALYZE` | 2026-11-05 通过：58 行 SQL 日志，0 行 `ANALYZE` |
| [x] | D5 启动耗时 | macOS dev | 读日志；另在生产库的磁盘副本上跑 | 记录实际开销 | 2026-11-05：开发库（150 MB）应用内 0.47～1.1s（都在重新编译之后），同连接第二次 96ms；`BEGIN IMMEDIATE` 0ms，不是等锁。生产库副本（870 MB）首次 4.4s、第二次 0.87s，首次多出来的是等待时间，CPU 约 1s。没有测过真正的冷开机，也没有测过不重新编译的连续重启 |
| [ ] | A1 启动页文案 | macOS dev | 大库启动时看启动页 | 显示「正在优化数据库」 | 未目视确认：开发库上这一阶段一闪而过。五种语言的词条与 `analyze` 分支已加，序列化有单测 |
| [ ] | A2 新库首次启动 | 全平台 | 空数据目录启动，下载一批图后重启 | 第一次没有统计也能正常用，重启后有统计 | 未测 |
| [ ] | A3 大库启动 | Windows / Linux / Android | 看日志里的 `ANALYZE finished` | 启动时间可接受 | 未测：Android 的存储与 CPU 都更慢，耗时可能明显高于 macOS |
| [ ] | A4 Web | Web 部署 | 启动服务 | 监听前跑完 `ANALYZE` | 未真跑，只有 `--mode web` 编译覆盖 |

## WPE 改用 `wpe` feature：三桌面开启，手选文件夹统一两层

2026-11-05 macOS dev。cargo feature `wpe`（桌面主程序与 `kabegame-cli` 开启，Android / Web 不开）取代运行时的 `platform_supported()`；手选文件夹只看自身与向下两层。测试壁纸是自造的网页壁纸（含 `project.json`、读同目录 `data.json`、越界读 `/etc/hosts` 的探针），另有用户本机拷来的 `wallpaper_engine/projects/defaultprojects`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 三种 feature 组合编译 | macOS | `check-kabegame`（standard）、`-c kabegame-cli`、`--mode web --skip vue` | 全部 0 error；Web 模式即 `wpe` 关闭路径 | 2026-11-05 通过。`--mode web` 起初因 `lib.rs` Web 入口缺 `axum` 导入编译不过（HEAD 上已有），已补 |
| [x] | S2 core 单测 | macOS | `kabegame-core --lib wpe`、`--lib plugin::builtin` | 全过 | 2026-11-05：39 passed、3 passed。这组用例以前只在 Windows 跑过，首次在 macOS 跑出 3 个失败：`is_safe_relative_path` 放行 `C:\\x`，`libraryfolders.vdf` 路径把 `\\\\` 转成 `//`，都已修 |
| [x] | S3 应用单测 | macOS | `kabegame --lib wpe`、`--lib web_entry` | 全过 | 2026-11-05：25 passed、3 passed |
| [x] | S4 前端单测 | macOS | `apps/kabegame` 与 `apps/wpe-scene` 的 Vitest | 全过 | 2026-11-05：582 passed；145 passed、26 skipped（需 `KABEGAME_WPE_ROOT`） |
| [x] | S5 WPE 目录设置的编译与单测 | macOS | `check-kabegame`（standard、`--mode web`）；`kabegame-core --lib wpe`、`--lib settings`；`kabegame --lib wpe`；`apps/docs` 构建 | 全过 | 2026-11-05：0 error；43、15、25 passed；文档站 35 页构建成功。用的是 Homebrew 工具链 |
| [x] | D1 手选文件夹两层规则 | macOS dev | 经 `wpe_recognize_dir` 探测：第一层、第二层、第三层、Steam 库结构的根、`431960` 根 | 一、二层与 `431960` 能识别；第三层与库根报「未识别」 | 2026-11-05 通过。返回值已无 `recognized` |
| [x] | D2 只选手选文件夹导入 | macOS dev | 对话框不勾自动来源，只添加文件夹，点开始导入 | 任务创建成功，只导入该文件夹 | 2026-11-05 用户操作先复现「壁纸导入任务创建失败」（`sources: 至少选择一项`）；改传 `sources: null` 后用户重试成功：`defaultprojects` 19 个目录入库 18 张（场景 16、网页 2），任务配置 `sources: null` |
| [x] | D3 CLI 经主程序 | macOS dev | `kabegame-cli --via app plugin run wpe-import --dry-run` 与真实运行 | 解析到内建插件；dry-run 不入库；真实运行入库 | 2026-11-05 通过。本地模式（`--via local`）报「只支持 v8 后端」，符合现状 |
| [x] | D4 网页壁纸图库预览 | macOS dev | `pvwimgid` 打开网页壁纸预览，进 iframe 读探针 | `file:` iframe 加载；同目录 `fetch` 成功；越界被拒且有 `deny file:`；属性送达 | 2026-11-05 通过。`applyUserProperties` 收到 `schemecolor`，`wpe_web_pull_state` 返回正常。这是 `file:` 子 frame 闸门与 IPC 首次在 macOS 上验证 |
| [x] | D5 越权与音频订阅 | macOS dev | iframe 内调 `get_images_count` 与 `wpe_web_media_subscribe` | 前者被 ACL 拒绝；后者报只有 Windows | 2026-11-05 通过 |
| [x] | D6 窗口模式桌面壁纸 | macOS dev | 窗口模式设网页壁纸，读壁纸窗口 iframe，再恢复原壁纸 | iframe 在壁纸窗口加载；恢复后 iframe 销毁 | 2026-11-05 通过，已恢复原壁纸 8215。没有目视确认桌面画面 |
| [x] | D7 设置页 | macOS dev | 打开壁纸分区 | 有「场景后处理」，没有「媒体集成」 | 2026-11-05 通过 |
| [x] | D8 WPE 目录自动查找 | macOS dev | 设置为空时启动，读设置与日志 | 从库里的壁纸往上找到安装目录并写入设置 | 2026-11-05 通过：WPE 目录是 DepotDownloader 下载的，不在 Steam 库里，自动写入 `/Users/didi/wpe/wallpaper_engine`，壁纸设置显示该路径 |
| [x] | D9 WPE 目录校验与覆盖 | macOS dev | 经 `set_wpe_engine_dir`：选无 `assets/shaders/common.h` 的目录、传空、传带尾斜杠的路径 | 无效目录被拒且保留原值；传空后立即重新查找；手动路径规范化 | 2026-11-05 通过。界面上的「选择」与错误提示没有点过，只测了命令与显示 |
| [x] | D10 macOS 场景壁纸 | macOS dev，主窗口预览 | 预览 beach、eagleflag、razer_bedroom、razer_vortex | 按 WPE 渲染，不退回预览图 | 2026-11-05 通过：四张都进入渲染，razer_bedroom 18 层 7 个程序、6 段脚本全部成功，截图画面正确，帧率约 120。走 Metal（Apple M5），WebGPU 支持 BC。没有与 WPE 逐像素对比。dev 裸跑时 Chromium 在 exe 旁找 ANGLE 库，起初因缺 `target/debug/libGLESv2.dylib` 退回软件合成、报 `webgpu:no-adapter`。`OSPlugin` 现在在 dev / start 前把 `libEGL.dylib`、`libGLESv2.dylib` 软链到 exe 旁：直接调用该方法建链后，结束 GPU 进程让它重新拉起，Metal 与 WebGPU 正常，且只加载这两个库。尚未经 `deno task dev` 完整走一遍 |
| [ ] | A1 macOS 打包版场景壁纸 | macOS release | 打包后预览场景 | GPU 可用，场景渲染 | 未测：打包版应走 framework 的 `Libraries/`，不需要符号链接 |
| [ ] | A2 macOS 视频壁纸 | macOS dev | 导入并预览 `x-wpe/video` | 正常播放 | 未测：本机样本没有视频壁纸 |
| [ ] | A3 Windows 编译与媒体回归 | Windows | `check-kabegame`；网页壁纸音频、媒体集成、鼠标转发 | `windows` feature 移到 `wpe` 后行为不变 | 未测：这部分代码在 macOS 上编译不到 |
| [ ] | A4 Linux | Linux dev | 导入、预览网页壁纸；设为壁纸 | 导入与预览正常；设为壁纸报「Linux 暂不支持」 | 未测 |
| [ ] | A5 Android | Android | `--mode android` 检查；打包后 APK 不含 `wpe-scene` | 编译通过；`x-wpe/*` 行只显示预览图 | 未测：本机缺 `bin/android/arm64/rusty_v8-build`，`scene_assets_of` 的关闭分支没有编译过 |
| [ ] | A6 Web | Web 部署 | `start_task` 提交 `wpe-import` | 解析不到插件 | 未真跑，只有 `--mode web` 编译覆盖 |

## 场景壁纸 P3b：SceneScript 运行时（进行中）

2026-11-04 Windows dev。脚本在宿主 iframe 里的同源 `about:blank` 子 frame（独立 realm）中同步运行：每帧计时器 → `update`（返回值当帧写回）→ 渲染。用户脚本以 blob 模块加载，WPE 自带的 `jsmodules` 经按场景生成的 import map 以 `file:` 加载，`baseclasses.js` 作经典脚本。`value:script` 静态规则已删除。语料解锁清单见 D5；文档（步骤 8）待补。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与检查 | Windows | 宿主 tsc；`apps/wpe-scene` vitest（设 `KABEGAME_WPE_ROOT`）；Prettier | 0 error；全过 | 2026-11-04 主会话：tsc 0 error，15 文件 193 passed，Prettier 通过 |
| [x] | D1 realm 与环境 | Windows dev，主窗口预览 | dev 探针 `host.realmCheck()`（vortex / bedroom / shimmering） | 脚本求值成功；import map 只含用到的模块；WPE 没有的全局被遮掉；语法错误带行列 | 2026-11-04：三张全部求值成功；bedroom 的 import map 只有 `WEColor` → WPE `wecolor.js`；22 个全局为 `undefined`，`__TAURI_INTERNALS__` / `window` / `document` / `top` / `location` 删不掉（预期）；`console.warn` 抛 `TypeError`；语法错误 `(line 3, col 11)`；模块缓存第二次不再读文件；测后无残留 frame |
| [x] | D2 razer_bedroom 实时渲染 | Windows dev，主窗口预览与应用背景 | 打开 bedroom 预览 | 不再退回预览图；灯带随时间变色 | 2026-11-04：日志 `场景脚本加载完成：6 段，成功 6 段` → `开始渲染：18 层、7 个程序`；update 约 60 次/秒、色相速度与脚本 speed 相符、无报错；rAF 144、submit 60 次/秒，frameMs 均值 0.19 ms、p95 0.4 ms |
| [x] | D3 bedroom 与 WPE 抓帧对照 | Windows dev + RenderDoc | `A:\bedroom` 三档 9 帧：读 6 个 `g_TintColor` 与 `g_Time`，注入预览宿主读回，与后备缓冲逐像素比较 | 脚本公式与 WPE 一致；画面只差舍入 | 2026-11-04：54 个颜色与 `hsv2rgb(Date.now()/2000*speed%1,1,1)` 在整数毫秒上逐位相等。关闭 / 开启档通道平均差 0.038/255、p99 2、差值 > 4 的像素 0.24%；超高档 0.055/255、p99 2、0.24%；灯带区域平均色各通道差 ≤ 0.26/255。残差集中在细线与高对比边缘（最大 51；超高档桌垫细线 112），三档相同、与脚本和泛光无关，原因未查。产物 `ignore/p3b/compare/` |
| [x] | D4 razer_vortex 切模式 | Windows dev，主窗口预览 | 属性面板切「模式」 | 三层颜色模式跟着变 | 2026-11-04 用户目视确认切换正常 |
| [x] | D5 语料解锁清单 | Windows dev | dev 探针 `scriptCorpus`（步骤 6） | 列出解锁场景与缺失 API 排行 | 2026-11-04：经应用页 PathQL 取到库里 38 张 `x-wpe/scene`，在应用背景宿主里逐张调 `scriptCorpus`。38 张约 42 s 跑完；单个回调最长 1.4 ms；没有卡住，也没有残留测试 frame。`unsupported` 与 Node 语料测试逐张相同。<br>**解锁**：`unsupported` 为空的有 5 张（beach / deep_space / eagleflag / razer_vortex / razer_bedroom），相对 3a 新解锁的只有 razer_bedroom；dino_run、3146703458、3549863808、3637191856 只少了 `value:script`，仍然退回。<br>**脚本运行**：23 张、638 段。其中 444 段无报错，127 段求值失败，67 段有回调报错（98 条，均禁用了该回调），123 段写回到不支持的目标（主要是 `text`）；另有 209 段导出 `cursor*` / `media*` 回调，本阶段不调用。<br>**缺失 API 排行**（壁纸 / 段）：`engine.registerAudioBuffers` 10 / 124（模块顶层，整段失败）、`localStorage` 5 / 10、`thisLayer.getParent` 3 / 29（另有 28 条连带）、`getTextureAnimation` 3 / 10、声音 `play` / `stop` / `isPlaying` 3 / 4、`thisObject.getAnimation` 2 / 4、`input` 2 / 2、`getVideoTexture` 2 / 2、`registerAsset` / `getMaterial` / `getChildren` 各 1。<br>**样本自身的错**：`scene.getLayer` 伪代码 2 段；拖拽脚本挂在 `visible` 上 2 段。<br>没有发现无法归因的报错，也没有发现实现偏差。有脚本但仍退回的 21 张都另有渲染阻塞（文本 19、着色器 18、声音 16、粒子 15 张），单做 API 一张也解锁不了。明细与后续阶段建议见 phase-3b 实施记录「步骤 6 语料」，数据在 `ignore/p3b/corpus/` |
| [x] | D6 bedroom 跨重编译 | Windows dev。先测壁纸窗口（窗口模式，桌面为 bedroom 12888）：当时主窗口被 VSCode 完全遮挡（`visibilityState: hidden`、rAF 0），预览不出帧，所以在壁纸窗口宿主上只读观测。主窗口恢复可见后，又在主窗口预览 bedroom 上补测一遍 | 宿主里挂只读采样器：每个 rAF 读 6 个 `color` 目标，按 `hsv2rgb(Date.now()/2000*speed%1,1,1)` 反推隐含时刻；同时在主窗口应用页经 IPC `set_wpe_scene_postprocess` 把「场景后处理」由 `disabled` 改为 `enabled`，10 s 后改回 | 宿主重新编译；脚本不重新加载、不重新 `init`；颜色不跳回 scene.json 初值，按墙钟连续；update 继续增长 | 2026-11-04：<br>**重编译**：宿主控制台先出 `后处理设置 disabled → enabled，重新判定`，482 ms 后出 `重新加载：后处理 enabled（泛光）…约 73 MiB`；改回时 475 ms 后出 `重新加载：后处理 disabled`。应用背景宿主同样各重载一次（525 / 487 ms）。<br>**应用日志**：这两次重载在应用日志里没有 `kabegame::wpe_scene_host` 记录，因为「重新加载」走 `report.debug`，只进宿主控制台；只看得到重编译时读 `white.tex` 的 `deny file:` INFO。`场景脚本加载完成` 与 `开始渲染` 也没有再出现。<br>**init**：bedroom 6 段只导出 `update`，`scripts().calls` 里没有 `init` 项，前后都是 0 次。改用以下判据：realm 是同一个对象，realm frame 始终 1 个；`calls.update` 没有归零，依次为 25904 → 26505、26566 → 27168；两段 10 s 各 +601 / +602，即 60.1 次/秒，重载期间不掉帧；6 段始终 `inited`，没有错误或禁用。<br>**颜色**：两段各约 1439 个采样（144 Hz）。6 个目标全部符合公式，隐含时刻滞后 0–16 ms（均值 5.3 ms），没有倒退，滞后 > 250 ms 或 < −5 ms 的异常采样 0 个。与 scene.json 初值相同的采样有 2–3 个，它们的滞后也在 16 ms 内，是公式本身经过了这个颜色，不是跳回初值。<br>**时钟**：`engine.runtime` 431.69 → 441.69 s、442.71 → 452.72 s，各 10.0 s，与墙钟一致。`stats()` 的 applied 为 0、recompiled 为空：设置触发的重载不计入 `recompiled`。<br>**预览补测**：主窗口预览 bedroom，同样操作一来一回。三个宿主（预览、应用背景、壁纸窗口）在 416–427 ms、414–420 ms 内各重载一次。预览宿主的 update 3367 → 3969、4030 → 4631（+602 / +601，每段 10 s），`engine.runtime` 56.10 → 66.10、67.13 → 77.14 s。颜色滞后 0–16 ms，没有倒退，异常采样 0 个，realm 是同一个；应用日志同样没有新的宿主记录。<br>**恢复**：设置最后为 `disabled`，已用 `get_wpe_scene_postprocess` 复核。第一次运行时采样器注入写错、没有启动，但设置同样改过一来一回；连同两次正式测量，共改了 6 次，每次都已改回。脚本与数据见 `ignore/p3b/step7/test1*.json` |
| [x] | D7 shimmering_particles 泛光强度 | Windows dev，主窗口预览，dev 强制渲染（粒子不画） | 预览 12892，读 `read("general/bloomstrength")`；经属性面板的同一命令 `set_wpe_web_user_properties` 把 `glow` 改为 3，再恢复默认（`glow: null`） | 首次 apply 后为 1.0（`glow` 默认 2 × 0.5）；改 3 后为 1.5；恢复后属性与改动前相同 | 2026-11-04：<br>**首次加载**：应用日志依次为 `强制渲染（dev），不支持项： object:instanceoverride; object:particle`、`场景脚本加载完成：1 段，成功 1 段`、`开始渲染：5 层、1 个程序 … 5760×1080`。首次 apply 后读到 1.0，`applyUserProperties` 调用 1 次。<br>**改 3**：207 ms 内读到 1.5；宿主控制台 `就地更新：glow`，`stats()` 的 applied 0 → 1、recompiled 为空，`applyUserProperties` 共 2 次。<br>**恢复默认**：读回 1.0，applied 为 2，`applyUserProperties` 共 3 次，没有报错。<br>**metadata id**：20067 → 20073 → 20074。恢复后 6 个属性的值与 `modified` 与改动前逐项相同；`glow` 为 2、未修改；`style` 仍是用户原先改过的 `"1"`。<br>**恢复**：强制渲染开关测前为 null，测后已删除（读回 null） |
| [x] | D8 暂停 | Windows dev，主窗口预览 bedroom 12888 | 现有 UI 里没有能让场景宿主暂停的路径：预览固定传 `video-playing`，应用背景隐藏时直接卸载，壁纸窗口不传 `paused`。因此由主窗口应用页给预览宿主 iframe 发 `WpeSceneView` 的同一条消息 `{ type: "kabegame:wpe-volume", volume: 0, paused: true }`，经垫片转成 `wallpaperPropertyListener.setPaused(true)`；5 s 后按设置里的音量 1 发 `paused: false`。宿主里每个 rAF 记 update 次数、`engine.runtime`、`engine.frametime` | 暂停期间 update 不增；恢复后接着增长；`runtimeSeconds` 不跳；帧 dt 不跳 | 2026-11-04：<br>**暂停期间**：持续 5000 ms，共 721 个 rAF 采样。update 一直是 216，`engine.runtime` 冻结在 3.5766 s。<br>**恢复后**：`engine.runtime` 从 3.5766 接着走（下一帧 3.5804），没有把暂停的 5 s 算进去。前后 2 s 的速率：update 59.5 → 60.0 次/秒，runtime 1.00 s/s。恢复后 1 s 内 `frametime` 最大 0.0219 s，暂停前最大 0.0211 s，dt 不跳。<br>**计时器**：本机能渲染、带计时器的场景没有（语料里用计时器的 3 段都在退回的场景里），因此只确认了驱动计时器的 dt 不跳。<br>**其它**：6 段 update 计数一致（547），没有错误。bedroom 用 `Date.now()`，恢复后的颜色按墙钟直接到当前色，不是从暂停处接着变；这与脚本本身的写法一致 |
| [x] | D9 出错日志 | Windows dev，主窗口预览，dev 强制渲染 | 依次预览语料里本来就报错的 13107（3637191856）、13110（3549863808）和 12903（3554161528），每张观察约 12 s，期间取 3 次 `scripts()` 快照。12903 是补选的：它的 `init` 本来就报 `localStorage` 未定义，`init` 在加载时就调用、不依赖出帧。补选前已确认整个语料只有 13108 有一处 `while`，12903 没有循环 | 应用日志出现带行列的 `warn`；同一错误不重复；`scripts()` 里该回调已禁用 | 2026-11-04：<br>**13110**：应用日志只有 1 条 `WARN … 场景脚本 objects/2/visible 求值失败：engine.registerAudioBuffers is not a function (line 67, col 24)`，接着是 `场景脚本加载完成：1 段，成功 0 段，失败 1 段`。该段状态为 `failed`，`errors` 里有同样的行列；求值失败时整段不用，没有单独被禁用的回调。<br>**12903**：应用日志只有 1 条 `WARN … 场景脚本 objects/24/origin init 出错：localStorage is not defined (line 46, col 25)`。该段 `disabled: ["init"]`、`calls.init` 为 1，其余 4 段没有错误，加载完成为 5 段，成功 5 段。<br>**不重复**：两张在约 12 s 内都没有出现第二条同样的 warn，3 次快照的计数也没有变化。<br>**13107**：update 报错没有触发。强制渲染下 GPU 场景仍建不出来，退回原因是 `render:no-program; render:texture-missing:0…4`，所以没有帧、`update` 不会被调用（`calls` 里没有 update）。拖拽段的 `init` 收到布尔值后正常执行，调用 1 次。<br>**相同点**：三张最后都退回预览图（`render:no-program` 等），脚本已经求值、`init` 已经执行，realm 一直保留到预览关闭（按设计：退回时保留 realm、停止帧）。<br>**未覆盖**：「`update` 报错 → 禁用」在真实宿主里没有可用样本。能渲染的三张没有报错，有 `update` 报错的语料场景都建不出 GPU 场景；这一项只有单测与步骤 6 的 `scriptCorpus` 覆盖。<br>**恢复**：强制渲染开关测前为 null，测后已删除；预览按 Esc 关闭，路由回到 `/gallery` |
| [x] | D10 razer_vortex 切模式不重编译 | Windows dev，主窗口预览 12889 | 经属性面板的同一命令 `set_wpe_web_user_properties` 把 `ui_editor_properties_mode` 依次改为 `"1"`、`"2"`、`"0"`，每次间隔约 1.7 s；读 3 个 `colormode` 目标、`stats()`、宿主控制台，以及同一时段的应用日志 | 三层 `colormode` 跟着变；没有任何重编译记录；属性恢复原值 | 2026-11-04：<br>**colormode**：初始 3 层都是 0，之后依次为 `[1,1,1]`、`[2,2,2]`、`[0,0,0]`。<br>**没有重编译**：每次改动后宿主控制台各只有一条 `就地更新：ui_editor_properties_mode`，没有 `重新编译` 或 `重新加载`。`stats()` 的 applied 0 → 1 → 2 → 3，recompiled 始终为空。3 段 `applyUserProperties` 各 4 次（首次全量 1 次 + 改动 3 次），没有错误。<br>**应用日志**：改模式的这段时间没有新增任何一行。注意宿主的「重新编译 / 重新加载」本来就只写 `debug`、不进应用日志，所以「没有重编译」以宿主控制台和 `recompiled` 为准。<br>**恢复**：metadata id 依次为 20064 → 20075 → 20076 → 20077。最后一次写的 `"0"` 等于默认值，`modified` 为 false；5 个属性的值与 `modified` 与改动前逐项相同（`schemecolor` 仍是用户原先改过的值），不需要再「全部重置」。预览按 Esc 关闭，路由回到 `/gallery`。<br>**与 WPE 同模式对照**：未测，需要用户在 WPE 界面里切同样的模式 |
| [x] | D11 壁纸窗口 | Windows dev，窗口模式（只读，没有改壁纸与壁纸模式） | 只读查壁纸窗口：`wallpaperMode` 与当前壁纸；读壁纸窗口宿主的 `scripts()`、`stats()`、realm 内的 `engine.runtime` | 壁纸窗口在显示场景时脚本在跑 | 2026-11-04 / 05：`wallpaperMode` 为 `window`，当前壁纸 12888（razer_bedroom），壁纸窗口里有一个 bedroom 宿主。<br>**11-04（实例 3eea9fc8）**：6 段都是 `inited`，只导出 `update`，没有错误或禁用；runtime 98.1 s 时 update 为 5884，431.7 s 时为 25904，即 60.1 次/秒；D6 中两次重编译前后也一直是这个速率。`stats()` 的 applied 0、recompiled 为空，frameMs 均值 0.23–0.37 ms、p95 0.4–0.5 ms。<br>**11-05 复核（实例 a18df065）**：这个实例是壁纸窗口 11-05 09:33 重新就绪后新建的，dev 进程没有重启，原因不是本次测试。5.1 s 内 update 8765 → 9072（60.1 次/秒），`engine.runtime` 146.06 → 151.17 s（1.000 s/s），宿主 rAF 144.5 次/秒，单次 update 最长 0.1 ms，frameMs 均值 0.22 ms、p95 0.4 ms，没有错误、禁用或重编译 |
| [x] | D12 脚本看到的数值取单精度（2026-11-14 补测） | Windows dev 屏外宿主（kabegame-dev，探针回放 14 帧、`scripts: true`）+ WPE 测试窗口（wpe-renderdoc MCP，1280×720，不抓帧） | `python -X utf8 -I ignore/p3b-f32/gen_f32.py` 生成 `p3b-f32`、`p3b-f32w`；WPE 里开窗读 `[f32]` 日志；`projects_import` 两个工程，`deno run -A ignore/p3b-f32/run_ours.ts after`，`python -X utf8 -I ignore/p3b-f32/cmp.py ignore/p3b-f32/out/ours-after.txt`；测后 `projects_remove`。单测 `script/api.test.ts`、`script/runtime.test.ts` 名字含「单精度」的 7 条，变异检查 `ignore/p3b-f32/mutate.py` | `init` / `update` 入参（vec3 / vec2 / float / 材质常量 / angles）、`thisLayer.<字段>`、从别的图层读、`size`、材质 `thisObject.<键>` 都是 f32；角度读写按 f32 乘法；返回值与 `thisLayer` 读写累加 12 帧逐帧和 WPE 逐位相同；状态仍存 double | 2026-11-14 Claude：改前 18 段全部不同（我们给 double，如 `100.1` 对 WPE 的 `100.0999984741211`，角度 `2.8747069607269506` 对 `2.874706983566284`），改后 18 段逐位相同（宿主产物 `index-C0bar_5e.js`）；背景的 `p5d-camo-s` 改后打 `origin 960 540 500.0000305175781`，同 WPE。变异 12 / 12 抓到。宿主 tsc 0 error、Prettier 通过；全量 vitest 3241 条过 3233 条，失败的 8 条在 `compile/animations.test.ts`、`compile/p4f1.test.ts`、`dev/scriptValues.test.ts`，是别的会话未提交的 P10b 改动（`compile/scripts.ts` 改按登记顺序收集、`compile/animations.ts`）引起的顺序差，这几个文件不导入本次改动的模块。测试行 14649、14650、14658 已移除并核对；WPE 设置没改 |

## 场景壁纸 P3a：属性绑定表与快速路径

2026-11-03 Windows dev，主窗口图库预览（宿主 iframe 里的 dev 探针 `__kabegameSceneProbe`，裸 CDP 脚本在 `ignore/p3a/`）。改动前基线：`git archive HEAD`（44f2dd97）的 `apps/wpe-scene` 解到 `ignore/p3a/base/`，以 development 模式构建进 `target/debug/resources/wpe-scene`，用旧探针渲染后再换回工作区构建；基线存 `ignore/p3a/baseline.txt`。「场景后处理」设置为跟随 WPE（WPE `config.json` 为 `disabled`，解析为关闭档），`g_Time` 固定 3.25 s。属性写入走属性面板的同一命令 `set_wpe_web_user_properties`（或面板本身），测完全部改回原值。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与检查 | Windows | `deno task test -c kabegame --skip cargo`；宿主 `typecheck` | 两个 Vitest 目录通过；0 error | 2026-11-03 主会话：`apps/kabegame` 582 passed、`apps/wpe-scene` 170 passed（含退回路径回归的 `src/host.test.ts`）；宿主 tsc 0 error |
| [x] | D1 不改属性时逐字节不变 | Windows dev，主窗口 | 改动前后两版探针 `renderFrame` 渲染 eagleflag / deep_space / beach / razer_vortex / razer_bedroom（强制）；另用 `host.renderFrame(t)` 渲染当前场景 | 离屏目标 SHA-256 逐一相同；`host.renderFrame` 与整场编译相同 | 2026-11-03：五张 × 五组（关闭档作者默认值 / 关闭档图库值 / 跟随档图库值 / 超高档默认值 / 超高档图库值）共 25 个哈希全部相同（关闭档默认值 eagleflag `d7f14a1d…`、deep_space `255d9b5d…`、beach `2db0fad1…`、vortex `6e17563b…`、bedroom `86cee305…`，超高档 bedroom 为 `rgba16float` 8 级泛光 `0782a85d…`）；shimmering_particles（强制）三组也相同。eagleflag 预览宿主 `host.renderFrame(3.25)` 为 `c076e544…`，与按图库值整场编译相同 |
| [x] | D2 就地写：eagleflag | Windows dev，主窗口预览 | `flagcolor1` 改 `0 1 1`；再一次写入同时改 `flagcolor2` / `schemecolor`；对比整场编译 | 画面跟着变；`stats().applied` 增加、`recompiled` 不变；`host.renderFrame` = 同值整场编译 | 2026-11-03：两次各收到一个增量（只含改动的键），`applied` 0 → 1 → 2，`recompiled` 始终为空；截图旗帜由紫变青、再变黄底暗红；`host.renderFrame` 与整场编译分别同为 `52a87890…`、`23cebd58…`。改回原值后回到基线 `c076e544…` |
| [x] | D3 就地写：razer_vortex | Windows dev，主窗口预览 | 改亮度 3；长度 2.5 与速度 −0.8 一次写入；「模式」改 Linear；全部恢复默认 | 画面跟着变、不重编译；「模式」不变色也不重编译；恢复默认后键从 metadata 消失 | 2026-11-03：`recompiled` 始终为空；哈希分别 `6326af98…`、`2d937529…`，都与整场编译相同；「模式」改后哈希仍是 `2d937529…`（`applied` 照样 +1：一批没有重编译目标的变化都记一次，含只改了未绑定键的批次）；暂停时亮度 1 与 5 的截图明显不同。恢复默认后面板 `modified` 为 false、只剩原先就改过的 `schemecolor`，哈希回到 `6e17563b…` |
| [x] | D4 暂停时就地写 | Windows dev，主窗口预览 | eagleflag 经 `wallpaperPropertyListener.setPaused(true)`（垫片投递暂停的同一入口；桌面预览没有暂停按钮）后改 `flagcolor1` 两轮 | 每次写入补画一帧、画面更新，`g_Time` 不动 | 2026-11-03：暂停期间 38 s 内只有写入那一次 `GPUQueue.submit`（每次写入恰好 1 次）；截图随写入改色；同一组属性值相隔约 40 s 的两次补画在场景区域逐像素相同（`g_Time` 冻结）。之后恢复播放 |
| [x] | D5 强制渲染样本 | Windows dev，主窗口预览，dev 强制渲染 | razer_bedroom 改 `light_speed`；shimmering_particles 切 `style`、改 `backgroundcolor` 与 `glow`（经宿主 listener 直接投递，不写库，避免应用背景的 bedroom 宿主跟着重编译） | 就地写、不重编译；条件可见随 `style` 切换；哈希 = 整场编译 | 2026-11-03：bedroom 绑定 17 条（9 条 `speedx`、8 条 `speedy`），`light_speed` −1.2 后 `g_Time` 3.25 / 7.5 两个时刻的哈希都与整场编译相同。shimmering 绑定 7 条；`style` 0 → 1 后 object 0 隐藏、1–4 显示（截图由黑变灰底），哈希 `ab18fc28…`，与**改动前**探针用 `style: "1"` 整场编译的结果也相同；`backgroundcolor` 改红、`glow` 5 均就地。全部改回后回到基线。渲染目标估算两版相同（关闭档 23.7 MiB、超高档 110.7 MiB）：`visibleBound` 的备选图层没有 effect，不多建合成 RT，纹理本来就全量上传 |
| [ ] | D6 重编译类属性 | Windows dev | 找有 effect `visible`、`general.bloom`、相机等用户绑定且能渲染的样本 | 改了重编译、`recompiled` 记原因 | 2026-11-03 无样本：库内能渲染的场景没有这类绑定；有的 7 张工坊场景（12894、12896–12900、12905、12906，effect 可见性、`general.bloom`、相机视差）强制渲染也建不出 GPU 场景（`render:no-program` / `render:texture-missing`）。`kbprops-test` 工程要导入图库才能测，未做。分类由单测 7 覆盖 |
| [x] | D7 面板拖动 | Windows dev，主窗口预览右栏 | 打开右栏属性面板，用 CDP `Input.dispatchMouseEvent`（合成输入，不动系统鼠标）拖 vortex 亮度滑杆：一次连续拖 4.3 s，一次中途停 3 次、每次 700 ms | 连续拖动只写一次库、宿主只收到一次增量；停顿 ≥ 300 ms 才写；不重编译 | 2026-11-03：连续拖动 `metadataId` 只变一次，宿主唯一的增量在松手后 284 ms 到达；带停顿的一次共写 4 次、宿主收到 4 个增量，各在停下后 262–291 ms，间隔 1312 / 1306 / 1174 ms；`recompiled` 为空。帧 CPU 用时（最近 600 帧）拖动前均值 0.13 / p95 0.2 ms，两次拖动后 0.14 / 0.2、0.13 / 0.2；宿主 rAF 143.9 次/秒、提交 60 次/秒。测完恢复默认、收起右栏 |
| [x] | D8 逐帧调用 | Windows dev，主窗口预览 | 宿主里以 rAF 频率连续 10 s 调 `applyUserProperties({ ui_editor_properties_brightness })`（0.5–4 来回） | rAF 与提交次数不变、不重编译 | 2026-11-03：1440 次调用，`applied` +1441（含调回），`recompiled` 为 0；rAF 144.0 / 提交 60.1 次/秒，不调用的 10 s 对照为 143.9 / 60.0；每次调用 CPU 均值 0.062、p95 0.1、最大 0.2 ms（CEF 计时精度 0.1 ms）；帧 CPU 0.13 / 0.2 → 0.14 / 0.2 ms。调回后哈希与整场编译相同 |
| [x] | D9 退回路径 | Windows dev，主窗口应用背景 | 应用背景的 razer_bedroom（不强制、退回预览图）改 `light_speed` 再恢复；另连写两次（间隔 2 ms） | 改一项重编译一次，仍退回且不循环；加载中到达的增量再编译一次 | 2026-11-03：每次改动宿主控制台只出现一次 `退回预览图： value:script`（写入后 36–41 ms），应用日志同样一行，之后 10–12 s 没有再编译；连写两次时第二个增量在第一次编译进行中到达（+22 ms，编译 +15 → +36.6 ms），第一次退回后按新全集又编译一次（+62 ms）后停止。`stats().recompiled` 不记退回状态下的这两类重编译，要看宿主控制台或应用日志。「关掉 effect 就能渲染」的样本本机没有，由 `src/host.test.ts` 覆盖 |
| [ ] | D10 壁纸窗口 | Windows dev，窗口模式 | 桌面场景改属性 | 同预览 | 未测：本次 CDP 只有主窗口一个 page，没有壁纸窗口 target |
| [x] | D11 属性不存在时保持 value、`alpha` / `brightness` 不收布尔、WPE 内置属性（2026-11-14 修复） | Windows dev 屏外宿主（kabegame-dev `render_scene`，脚本用例 `scripts: true`；`host_open` 一次）+ WPE 测试窗口（wpe-renderdoc，1920×1080，各抓 2 帧） | 生成 `ignore/p3a-missing/` 的 `p3am-builtin` / `p3am-bright` / `p3am-empty`（`kbp gen p3am …`）并在 WPE 抓帧；`projects_import` 五个工程（加上原来的 `p3am-missing` / `p3am-extra`），重建 dev 宿主产物后 `render_scene`，`judge_ours.py` / `judge_pos.py` 判读，和 `out/wpe-judge*.txt` 逐项比；语料前后各跑 `fields.test.ts`，`fields_diff.py` 比较；单测 `compile/p3a-missing.test.ts` 等，变异 `mutate.py` | 缺失属性的可见性、数值、脚本属性都保持 `value`；`alpha` / `brightness` 收布尔不写；14 个内置项在编译期、宿主、`init` 里的 `engine.userProperties` 与首次 apply 都有，工程同名的优先；语料 `unsupported` 不变，3351072238 背景视频显示 | 2026-11-14 Claude：`p3am-missing` 26 项、`p3am-extra` 10 项、`p3am-bright` 9 项与 WPE 逐项相同；`p3am-builtin` 17 项 16 项相同（改动前 10 项错），B5（`wcc_v` 条件 `""`）不同，`p3am-empty` W1 / W2 / W5 不同，都是空串 condition 与 `visible` 收字符串两处既有偏差（语料 0 处 / 1 处，未修，见 phase-3a「修复」）；`engine.userProperties` 在 `init` / apply / 第 1 帧的键与值和 WPE 相同（宿主产物 `index-DT87CM1t.js`，屏外真宿主的应用日志同样）。语料 192 张 `unsupported` 不变、能渲染 130 → 130，图层 `visible` 4 张 7 处 false → true（含 3351072238 objects/1）。宿主 tsc 0 error、Prettier 通过；全量 vitest 163 个文件 3866 条全过（改动前 162 / 3850 全过）；变异 9 / 9 抓到并按原字节还原。测试行 14866–14870 已移除并核对；WPE 设置没改 |
| [x] | D12 空串条件算没写、可见性只收布尔（2026-11-14 修复） | Windows dev 屏外宿主（kabegame-dev `render_scene`）+ WPE 测试窗口（wpe-renderdoc，1920×1080，抓 2 帧） | 生成 `ignore/p3a-missing/` 的 `p3am-num`（`kbp gen p3am p3am-num`），WPE 里抓帧、`kbp rdc consts` 取常量；`buildSceneHost.ts` 重建宿主后导入 `p3am-empty` / `p3am-builtin` / `p3am-num`，`render_scene` 带 `trace`，`judge_pos.py` 判读、与 WPE 的 `wpe-judge-*.txt` 逐项比；测后 `projects_remove`。单测 `compile/p3a-missing.test.ts` 第 4 组、`render/p3a.test.ts`「值换算同编译期」 | `condition: ""` 当成没写；图层与 effect 的 `visible` 不带条件绑数字、字符串属性时保持 `value`，就地写不改、不标脏 | 2026-11-14 Claude：WPE 实测 U1–U3（滑块 0 / 1 / 0.25）与 F1–F3（effect 绑字符串 / 数字）都写不进、留 `value`，U4 / F4 布尔对照照写。我们这边 `p3am-empty` 8 / 8、`p3am-builtin` 17 / 17、`p3am-num` 8 / 8 与 WPE 相同（之前 W1、W2、W5、B5 不同）。变异 4 / 4 抓到。语料 192 张 `unsupported` 不变、能渲染 130 → 130，编译期字段 0 处变化；3276911872 的 objects/158 差在运行时套属性（`"A3"` 不再被写成显示），这张场景目前退回预览图。`solid` 没实测（TODO）。测试行 14959–14961 已移除 |
| [x] | D13 脚本看到的属性键按字节序（2026-11-15 修复） | Windows dev 屏外宿主（kabegame-dev `render_scene` 带 `scripts`，`host_open` 一次）+ WPE 测试窗口（wpe-renderdoc，900×500，不抓帧） | `kbp gen p3am p3am-order --data ignore/p3a-missing`，WPE 里开窗读 `[p3amo]` 日志；`buildSceneHost.ts` 重建宿主后 `projects_import` 该工程，`render_scene` 带 `scripts: true` 看 console，再 `host_open` 读应用日志；测后 `projects_remove`。单测 `script/runtime.test.ts`、`script/api.test.ts` 名字含「字节序」的 2 条 | `init` 里的 `engine.userProperties`、首次 `applyUserProperties` 的参数、第 1 帧的 `engine.userProperties` 键按字节序（大写 < `_` < 小写），与声明顺序、`order`、内置项无关 | 2026-11-15 Claude：WPE 三处都是 `Zb,_u,a1,aB,a_b,ab,alignment,…,zz_last`；改前我们是内置项在前、工程属性在后；改后探针与屏外真宿主的 4 行都和 WPE 逐行相同（宿主产物 `index-LwxbD9_J.js`）。运行中增量的键序没测到（`-control applyProperties` 不带 `type`，脚本收到空对象），按推断同样排序。变异 2 / 2 抓到；相关 36 个文件 556 条单测全过 |

## 场景宿主 P3-0c：子 frame 不跨窗口复用进程与 rAF 去重

2026-11-03 Windows dev：CEF 08 关闭子 frame 跨 browser 复用同站点渲染进程；CEF 09 让每个 frame widget 只服务自身 local root 的文档。验收前须由用户重编 CEF，并完全退出、重启 dev。下表数值来自本次真机与静态检查。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 补丁 08 | Windows，CEF 补丁树 | 从 07 生成 08；检查 01–08；重应用后检查残留 | 08 只改 CEF 两处文件；序列可重放 | 2026-11-03：`08-no-embedded-frame-process-reuse.patch` 45 行，只改 `chrome_content_browser_client_cef.{h,cc}`；01–08 `--check` 通过，重应用后 `--gen --from 08` 无残留。开工前发现 `third/cef` 注释还是「patch 0005 / 0007」（10-31 编号改两位后未重应用），已重新应用 01–07 |
| [x] | S2 补丁 09 | Windows，Chromium 构建树 | 按上游加 `views_widget.patch` 的底稿生成内层补丁；检查叠加与 01–09 | 内层补丁可正向应用，CEF 原补丁可反向检查；序列无残留 | 2026-11-03：`kabegame_raf_local_root_only.patch` 156 行、无 CR；正向 `git apply -p0 --check` 通过，`views_widget.patch` 反向检查仍通过；09 含 `patch.cfg` 一条与新内层文件；01–09 `--check` 通过，重应用无残留；`--gen --from none` 并集 23 个文件，其中 3 个新建内层补丁 |
| [x] | B1 CEF 重编 | Windows dev | 用户退出 dev、重编 CEF、重启；核对 DLL 与内层补丁 | 构建成功，运行时加载新 DLL | 首次链接 `bootstrapc.exe` 时 `lld-link` 报 `LLVM ERROR: out of memory`（0xc000001d），与补丁无关：提交上限 73.8 GB、空闲已用约 46 GB，siso 为 Local:24；`NINJA_JOBS` 的 `NINJA_CORE_LIMIT` 不约束 siso，可手动设 `SISO_LIMITS=local=12`，用户决定不改脚本。退出 dev 释放内存后重跑成功：`page_animator.obj` 23:24 编出、`libcef.dll` 23:29；`target/debug/libcef.dll` 与导出目录哈希一致；09 首次构建已正向应用，重跑日志为 `already applied`，构建树内层补丁反向检查通过 |
| [x] | D1 进程分布 | Windows dev | CDP 页面级 tracing 读取宿主与应用页进程 | 两窗口的 `file:` 宿主分进程，主窗口两宿主同进程 | 重编前三个宿主同在 29500；重编后壁纸窗口宿主 61204、主窗口两个宿主 74360，主窗口应用页 25184、壁纸窗口应用页 32780 |
| [x] | D2 重载不回流 | Windows dev | 桌面换场景后重查宿主进程；壁纸窗口整窗重载后再查 | 壁纸宿主不回流到主窗口宿主进程 | 换场景后新宿主仍在壁纸窗口进程 61204，不在主窗口宿主进程 74360。2026-11-03 补测整窗重载：对壁纸窗口 `Page.reload`（与 init 看门狗的 `location.reload` 同类），1.9 s 后场景层 `live`，日志 `wallpaper: 场景壁纸 12889 开始渲染 … 用时 568 ms`；新宿主沿用重载前的壁纸宿主进程 61204（应用页仍在 32780），不在 74360，rAF 144.5 次/秒；之后 ping 由新宿主垫片应答，日志无未应答、无看门狗重载 |
| [x] | D3 rAF 去重 | Windows dev，144 Hz | 同测主窗口两个宿主、壁纸宿主和应用页 | 同进程多个 iframe 每帧各一次 rAF | 主窗口 vortex 预览与应用背景两个宿主各 144.5 次/秒，不同时间戳各 144.5 个/秒；壁纸宿主 144.5、应用页 144.5。修复前主窗口两个宿主各 288.5 / 289 次/秒，时间戳 144.5 个/秒 |
| [x] | D4 local 子 frame | Windows dev | 在预览宿主内临时建 `about:blank` 子 iframe 测 rAF，测完移除 | 同一 local root 的子 frame 不漏帧 | 子 frame 与宿主都是 145 次/秒 |
| [x] | D5 网页壁纸 | Windows dev，主窗口 | 预览 corsair_collection（12094），应用背景为 vortex 宿主 | 两个同进程 iframe 各每帧一次 | 两者同在进程 74360，各 144.5 次/秒；修复前此布局为 288 次/秒 |
| [x] | D6 隐藏与恢复 | Windows dev | 用户两次最小化主窗口并恢复 | 主窗口宿主随遮挡节流，桌面宿主保持满速；恢复后回到满速 | 最小化期间主窗口应用页及其宿主均降到 1 次/秒，`visibilityState` 仍为 `visible`（与基线遮挡节流相同）；桌面宿主始终 144–145，恢复后主窗口回到 144 |
| [x] | D7 场景回归与淡入 | Windows dev | 观察 vortex 宿主 rAF / GPU 提交；tracing 按 frame 对照首帧与 `live` | 实时渲染、淡入未被限流拖慢 | vortex 预览宿主 144 次 rAF/秒、`GPUQueue.submit` 60 次/秒；桌面与应用背景新宿主首次 rAF 在 930175 / 930176 ms，场景层出现 `live` 类在 930177 ms，之后无大于 40 ms 的间隔；预览路径同样。透明度为 0 的宿主现仅 1.5–2 次 rAF/秒，原因未查清 |
| [x] | D8 内存 | Windows dev | 读取两个 `file:` 宿主进程私有内存 | 记录拆分后的实际开销 | 壁纸宿主进程 30 MB（显示的 12888 退回预览图、不渲染），主窗口宿主进程 84 MB（12888 + 实时 vortex）；多一个进程约 30 MB |
| [x] | D9 畅游 | Windows dev | 打开 MDN `<iframe>` 页面，读各 frame 进程并直接截图 | 第三方 iframe 分进程且页面正常显示 | 单个畅游窗口中，主 frame 74120、`mdnplay.dev` 运行器 95976、嵌套 OpenStreetMap 47020、example.org 46188，`about:srcdoc` 也独立进程；直接截图地图正常。2026-11-03 补测两个畅游窗口（MDN `<iframe>` 页、其 `mdnplay.dev` 运行器页直接打开）：两窗口里的 example.org 子 frame 分在 106652 / 108528，裸 CDP 截图两页都正常，测完关闭并删除新建的两条记录。爬虫窗口未测（会建任务、写库）。Playwright 连接会重建该页 iframe，立即截图空白不属于补丁问题；已关闭会话并删除本次新建的畅游记录 |

## 场景宿主 P3-0b：渲染器迁移

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 前端与构建 | Windows | `deno task test -c kabegame --skip cargo`；宿主 `typecheck` / `vite build --mode development`；检查 Worker 产物 | 两个 Vitest 目录通过；Worker 单文件、无 chunk import | 2026-11-02 主会话沙箱外：`deno task test -c kabegame --skip cargo` 依次跑完两个目录：`apps/kabegame` 60 个文件 582 passed，`apps/wpe-scene` 8 个文件 147 passed（设了 `KABEGAME_WPE_ROOT`，语料测试照跑）；此前就有的 `KameToolboxBubble.test.ts` 加载失败（`@kabegame/i18n` mock 只给了 `useI18n`，导入链在模块加载时读 `i18n.global`）一并修好，改为只替换 `useI18n`；Worker 产物 32.55 kB、无 `import`；dev 构建带探针、production 构建没有；宿主 tsc、应用 vue-tsc 0 error |
| [x] | D1 画面 | Windows dev，主窗口 | P1 三张、vortex、bedroom 强制渲染，固定 `g_Time` 比较 P2a / P2b SHA-256 | 与迁移前一致 | 2026-11-02 CDP：宿主里的探针按 P2b 基准参数（`g_Time` 3.25 s，关闭档与超高档各五张：bedroom / vortex / eagleflag / deep_space / beach）渲染，10 个离屏目标的 SHA-256 与 `9a5d0e2f` 时的基准全部相同（含超高档 bedroom 的 `rgba16float` 目标） |
| [x] | D2 三处与生命周期 | Windows dev | 预览、应用背景、桌面各显示场景；改属性、换场景、退回、迟到首帧、暂停恢复 | 属性只重编译不重建设备；`g_Time` 暂停冻结；状态与过渡一致 | 2026-11-02 部分：图库预览经 `WpeSceneView` 建宿主 iframe，vortex 实时渲染（截图核对），bedroom / shimmering_particles 按不支持项退回；改一项属性只「重新加载」、不再报 `ready`，测完改回；暂停时宿主每秒 GPU 提交 60 → 0，恢复回 60。之后（桌面壁纸设为 vortex、窗口模式）：壁纸窗口、应用背景、预览三个宿主同时实时渲染，截图核对壁纸窗口与预览画面正常（壁纸窗口调试面板 `media: scene`），三者每秒 GPU 提交各约 61–62 次；连读 12 帧，每隔一两帧出一次完整画面（只读一帧可能碰上没渲染的帧，读到单色）。2026-11-03 补测：**换场景**（预览 vortex → eagleflag 12885 → bedroom 12888 → vortex）旧宿主 12–21 ms 内移除、新宿主 59–92 ms 出现，同一场景层始终最多 1 个宿主；能渲染的 452 / 517 ms 出 `live`，bedroom 117 ms 挂预览图（`value:script`）；应用背景宿主全程 `live` 不变。**迟到首帧**：对主窗口宿主进程 CPU 限速 40 倍切 eagleflag，10029 ms 先显示预览图（日志「10000 ms 内没有结果」），15.7 s 恢复限速后 15842 ms 切成实时画面（画布盖在预览图上）；测完恢复限速 |
| [x] | D3 ping | Windows dev，窗口模式 | 场景启动、宿主脚本死循环、宿主产物缺失 | 启动后由垫片应答；卡死约 30 s 重载；缺失时预览图且不循环重载 | 2026-11-02 部分：**缺失**通过——临时把 `target/debug/resources/wpe-scene` 改名后重载壁纸窗口，日志 `场景宿主不可用: scene host is not built`，显示作者预览图，45 s 内没有任何「ping 未应答」（应用页继续应答，没有重载循环）；目录改回、再重载后恢复渲染。2026-11-03 用 CDP logpoint（条件恒 false、不暂停）区分应答方：桌面 vortex 实时渲染时 seq 1003–1007 由宿主垫片调 `wallpaper_pong`，应用页收到 ping 但 `delegatesPing()` 为 true、不应答；壁纸窗口整窗重载后 1014–1017、轮播换成退回预览图的 razer_bedroom 12888 后 1177–1189（换图后 3 s 起）都由新宿主垫片应答，日志无未应答。**卡死**（用户在壁纸窗口宿主的 DevTools 里执行 `while(true){}`，桌面 bedroom 12888，宿主进程 128024，测试期间不连 CDP、只读日志）：约 04:08:25 卡住；04:08:31.7 CEF 报 `renderer unresponsive for webview 'wallpaper', terminating for reload`（桌面鼠标转发的输入得不到回执，5 + 1 s），128024 被结束，但它只是子 frame 的进程，`on_render_process_terminated` 不触发、iframe 不重载；之后垫片不在，04:08:44 / :54 / 09:04 三次未应答，04:09:04.7 `无响应，重新加载`；0.24 s 后壁纸窗口就绪，0.3 s 后新宿主报 `退回预览图： value:script`（宿主正常起来），落在新进程 129780（Chromium 预热的空进程，重载时另起 126024 补位，推断），应用页仍在 127688。卡住到恢复约 40 s；用户目视桌面全程正常播放作者预览 gif：退回状态下预览图在应用页（127688）里，宿主 iframe 透明，宿主卡住、被结束都看不出来。DevTools 当时开着（附着在 iframe 的 target 上）仍被判卡死：Chromium `WebContentsImpl::ShouldIgnoreUnresponsiveRenderer` 只看主 frame 的 agent host 与整页 target 是否附着，附着子 frame 不算。未测：实时渲染的场景卡住（画面会停在最后一帧，被结束后宿主那块的显示未知）；进程没被结束、一直卡着的情形（无输入时） |
| [x] | D4 日志与内存 | Windows dev | 观察开始渲染、退回、设备丢失日志；同时开预览、背景、桌面 | target 为 `kabegame::wpe_scene_host`；记录每个宿主进程内存 | 2026-11-02 部分：开始渲染 / 退回预览图都以 `kabegame::wpe_scene_host: main: …` 进了应用日志（壁纸窗口的记为 `wallpaper: …`）。内存：壁纸窗口、应用背景、预览三个宿主**共用一个 `file:` 渲染进程**（撤掉壁纸窗口的宿主后没有进程退出，恢复后也没有新进程，该进程私有内存 41–55 MB）；一个 4K vortex 宿主约占显存 120 MiB（RTX 4070 整卡 2256 → 2376 MiB，日志估算渲染目标 63 MiB）。3-0c 后宿主进程的分布与内存见 P3-0c D1 / D8。2026-11-03 补测设备丢失：CDP `Browser.crashGpuProcess` 一次（GPU 进程 64172 → 114460），日志 `WARN kabegame::wpe_scene_host: main: 场景壁纸 12889 设备丢失，重建渲染器： webgpu:device-lost:unknown:…`，预览宿主约 0.7 s 内重建并重新加载，没有退回预览图，画面恢复，主窗口、壁纸窗口应用页与宿主 rAF 都是 144.5 次/秒（应用背景与桌面当时为退回预览图的 bedroom，没有设备）。重建成功的记录只在宿主控制台（`report.debug` 不上报）；60 s 内第二次丢失退回预览图未测 |
| [x] | D5 宿主帧循环（发现） | Windows dev，主窗口 | 宿主里统计 2 s 的 rAF 回调与 `GPUQueue.submit` | 渲染不超过帧率上限 | 2026-11-02：`file:` 子 frame 的 rAF 每帧被回调多次（时间戳相同；当时主页面 144 次/秒，宿主 432 次/秒），渲染器的帧率闸门按时间戳跳过重复回调，GPU 提交稳定 60 次/秒，无重复渲染。之后查明倍数等于同一页面里同进程的 iframe 数（Chromium 每个 iframe widget 每帧各跑一次整页的 rAF 派发）：三个宿主同进程时，主窗口两个宿主各 288.5 次/秒，壁纸窗口唯一的宿主 144.5 次/秒。网页壁纸若按回调次数推进动画，在主窗口两个 iframe 同时播放时会快一倍，计划在 Blink 层去重 → P3-0c |

## 场景宿主 P3-0a：宿主与应用通路

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与检查 | Windows | `wpe_` Rust 单测、宿主 tsc / build、前端 vitest / vue-tsc、格式检查 | 0 error | 2026-11-02 主会话沙箱外重跑：`kabegame wpe_` 37 passed；`check-kabegame` 0 error；`wpeWebVolume.test.ts` 11 passed；宿主 tsc 0 error、`vite build` 通过；rustfmt / Prettier / `node --check` 通过 |
| [x] | D1 属性与拒绝 | Windows dev，主窗口 | 两个宿主 iframe 分别带 `kbScene` / `kbInstance`；改一项属性后恢复；另用网页壁纸 id、不存在的 id、缺 id 拉取 | 首包 `user[key].value` 与属性面板同形，更新只推变化键；非法 id 与缺 id 拒绝；网页壁纸传 id 仍按文档认图 | 2026-11-02 CDP（shimmering_particles 12892）：6 个属性逐键相同、`directories` 为空；`count` 1 → 1.1 两个实例都只收到 `count`，已改回 1；网页壁纸 id / 不存在的 id 报 `not a scene wallpaper in the library`，缺 id 报 `the scene host must pass imageId`，`wpe_scene_target` 同样拒绝网页壁纸；corsair_collection 带场景 id 拉取仍返回 12094 |
| [x] | D2 状态与日志 | Windows dev，主窗口 | 各实例报 `ready` / `fallback`，宿主报日志 | `wpe-scene-status` 仅到调用方窗口，应用页按实例认领；日志出现在应用日志 | 2026-11-02 CDP：实例 a、b 各收到一条 `ready`；日志 `INFO kabegame::wpe_scene_host: main: applyUserProperties count,glow,…`。最初的 target `wpe_scene_host` 不带 `kabegame` 前缀，被日志过滤器当依赖只放行 warn，已改为 `kabegame::wpe_scene_host` |
| [x] | D3 暂停与音量 | Windows dev，主窗口 | 给两个宿主分别推 `paused`；网页壁纸 iframe 推 `paused` | 只有被推的实例收到 `setPaused`；网页壁纸 `setPaused` 收到变化；页面起来时不收到多余的 `setPaused(false)` | 2026-11-02 CDP：实例 a 收到 `[true, false]`、b 没有；网页壁纸收到 `[true, false]`；三个 iframe 各发一次音量请求并得到回复 |
| [x] | D4 桌面鼠标 | Windows dev，窗口模式 | 桌面壁纸设为场景，检查鼠标转发 | 场景可接收指针 | 2026-11-03 窗口模式、桌面为场景：主进程有 `wpe-input-forward` 线程（vortex 与换成 bedroom 后都在，`GetThreadDescription` 只读查得）；壁纸宿主 `pointermove` logpoint 30 s 收到 333 次（`isTrusted`、`mouse`，来自用户日常移动，测试本身未移动或注入鼠标） |


## 场景宿主 P3-0 MVP：`apps/wpe-scene` 的 `file:` iframe

按 PLAN P3-0「形态更新」搭出场景宿主，渲染器没有迁移（`WpeSceneView` 照旧在应用页）。场景宿主当作一种特殊的网页壁纸。
- **宿主**：独立的纯 TS + Vite 项目 `apps/wpe-scene`，构建进 `resource_dir/wpe-scene`（dev 直接写 `target/debug/resources`，prod 进 `src-tauri/kabegame/resources` 打包），现在只有一块 WebGPU 画布逐帧清屏。
- **地址**：`get_wpe_scene_host_url` 返回 `index.html` 的 `file:///` 地址，应用页赋给 iframe（sandbox 同网页壁纸）。
- **`file:` 范围**：宿主目录 + WPE 安装目录的 `assets` / `config.json` + 库内全部场景目录（随图片事件维护）。
- **IPC**：网页壁纸的命令与事件经 `wpe-web-capability`（`file:///*`）照常可用；场景专用命令 `get_wpe_scene_postprocess` 由按确切地址运行时注册的 `wpe-scene-host-capability` 放行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测 | Windows | `test-kabegame kabegame wallpaper::wpe_`；`test-kabegame kabegame-core --lib wpe_web_rows_tests` | 宿主范围（含前缀相同的兄弟目录、场景目录本身不算宿主）、WPE 放行项、盘符大写、capability 只匹配宿主入口（含空格与 URLPattern 特殊字符）；场景目录只进放行表；场景行查询走 `idx_images_type` | 2026-11-02：kabegame 13 passed、core 3 passed |
| [x] | S2 检查 | Windows | `check-kabegame --skip vue`；宿主 `typecheck`（tsc）；单独 `vite build`；Prettier / rustfmt（新文件） | 0 error；宿主能单独构建 | 2026-11-02：cargo 0 error；宿主 tsc 0 error，`vite build` 通过、产物 JS 0.8 kB |
| [x] | D1 加载与渲染 | Windows dev，主窗口 | 应用页 `invoke("get_wpe_scene_host_url")`，建 iframe 赋地址 | 宿主加载，画布在画 | 2026-11-02 CDP：地址 `file:///D:/Codes/kabegame/target/debug/resources/wpe-scene/index.html`；`<script type="module" crossorigin>` 照常执行；纯 TS 宿主同一帧读回清屏色 `[28, 28, 40, 255]` |
| [x] | D2 读文件 | Windows dev | 宿主里 `fetch(file:)` | razer_vortex `scene.json`、`genericimage2.frag`、WPE `config.json`、工坊 `scene.pkg`（整读与 `Range`）、宿主文件能读；`win.ini`、数据目录文件、网页壁纸文件、视频壁纸目录、WPE 目录里 `assets` 之外的文件读不到 | 2026-11-02：全部符合；拒绝的是 `TypeError: Failed to fetch`，日志 `OutsideRoot; requester Document(…\wpe-scene\index.html)` |
| [x] | D3 IPC | Windows dev | 宿主里 invoke / listen；应用页改一次「场景后处理」再改回 | `get_wpe_scene_postprocess`、`wallpaper_pong` 成功，`setting-change` / `image-changed` / `images-change` / `wallpaper-ping` 能监听且收到 `setting-change`；网页壁纸以外的命令与事件被拒；网页壁纸 iframe 不受影响 | 2026-11-02：符合；`wpe_web_pull_state` 过 ACL 后报 `not inside a web wallpaper`（场景的状态拉取待渲染器迁移时设计）；`get_supported_image_types` / `images-added` 被拒；同窗口网页壁纸照常拉状态、调 `get_wpe_scene_postprocess` 被拒；设置已改回「跟随 WPE」 |
| [x] | D4 隔离 | Windows dev | 宿主读 `parent.document`；宿主忙等 3 s | 跨源被拒；父页面不卡 | 2026-11-02：`SecurityError`；独立 OOPIF，父页面计时器最大间隔 29 ms |
| [x] | D5 dev 迭代 | Windows dev | 改宿主后 `deno task --cwd apps/wpe-scene build`，重载 iframe | 新产物生效，不重编 Rust | 2026-11-02：新文件即可访问，Rust 没有重编 |
| [x] | D6 rAF | Windows dev，窗口可见 | 宿主与主页面同时测 2 s rAF | 宿主与主页面帧率相当 | 2026-11-02 复核：两边都是 144 fps、最大间隔 7 ms（首测时窗口被遮挡，两边都只有约 1 fps） |
| [x] | D7 壁纸窗口 | Windows dev，窗口模式 | 在壁纸窗口里建宿主 iframe，重复 D1–D4 | 同主窗口 | 2026-11-03 CDP（桌面 vortex 12889，壁纸宿主进程 61204）：日志 `wallpaper: 场景壁纸 12889 开始渲染`，宿主 rAF 144.5 次/秒；`parent.document` 报 `SecurityError`；`fetch(file:)` 读 razer_vortex `scene.json`（5395 B）、工坊 2932157836 `scene.pkg` 的 `Range: bytes=0-15`（16 B `PKGV0018`，200、无 `Content-Range`）、WPE `config.json` 成功，`win.ini` 为 `Failed to fetch`（日志 `OutsideRoot; requester Document(…\wpe-scene\index.html)) webview 'wallpaper'`）；`get_wpe_scene_postprocess` 返回 `follow`，`get_supported_image_types` 报 `not allowed by ACL`。宿主忙等不再做（主窗口 D4 已测） |
| [ ] | D8 安装包 | Windows release | 安装后在主窗口建宿主 iframe | 地址在安装目录 `resources/wpe-scene`，capability 匹配、能读文件 | 未测 |
| [x] | D9 宿主内嵌 frame | Windows dev | 宿主里建子 frame，分别导航到 `about:blank`、`srcdoc`、`blob:`、宿主目录里别的文件、场景目录里的文件，经子 frame 的桥 invoke / listen | 权限不超过宿主自己（网页壁纸的命令与事件 + 场景专用命令） | 2026-11-02：`about:blank` 同宿主；`srcdoc` / `blob:` 报 `Origin header is not a valid URL`；宿主目录别的文件与场景目录文件只匹配 `wpe-web-capability`，没有场景专用命令 |
| [x] | D10 同窗口 `file:` frame（已知限制） | Windows dev | 主窗口同时建宿主与网页壁纸 iframe，宿主经 `top.frames` 访问网页壁纸 | 与网页壁纸之间相同：可达（2026-11-02 定为接受） | 2026-11-02：同源同进程，宿主能读它的 DOM、以它的身份 `wpe_web_pull_state`、借它的 `fetch` 读它的目录 |

## 场景壁纸 P2b：泛光与 HDR

依据 WPE 2.8.42 的逆向与 RenderDoc 抓帧逐位核对（`.claude/plans/wpe-import/3-scene/p2-REPORT.md` A1–A4、J5，PLAN P2b）。
- **何时跑**：「场景后处理」不是关闭、`general.bloom` 生效值不是 false、场景有对象时，全部图层之后拷一次整帧快照跑泛光链，combine 写回场景目标；泛光关着时渲染路径与 P2a 完全相同。HDR = 超高档且 `bloom`、`hdr` 的生效值都为 true（属性对象也认）。
- **LDR**：`downsample_quarter_bloom`（1/4）→ `downsample_eighth_blur_v`（1/8）→ `blur_h_bloom`（`_rt_Bloom`）→ `combine_ldr`，RGBA8，参数原值写入。
- **HDR**：场景目标 / 快照 / 合成 RT 改 `rgba16float`，图层颜色乘 `brightness`；最多 8 级金字塔（名义纹素 `g_RenderVar0`、SrcAlpha / One 上采样、最粗两级 bicubic），参数按 float32 换算；收尾用 `combine_hdr` 的 `LINEAR` 变体，8 位画布上与 WPE 的 `saturate(lin(scene + bloom))` 逐值等价。
- 着色器全部用 WPE `assets/materials/util/` 原件翻译；场景 / 材质 / effect JSON 容忍尾逗号（工坊 3286859278 的 fluidsimulation）。
- dev 探针 `window.__kabegameSceneProbe`（`wpe-scene/dev/`）：`bloom` 做链路隔离验证、`renderFrame` 按固定时刻渲染读回；生产构建里整块被摇掉。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与语料 | Windows | `apps/kabegame` 下 `KABEGAME_WPE_ROOT=<WPE 安装目录> npx vitest run src/wpe-scene` | 档位 / 泛光 / HDR 判定（含属性对象）、参数缺键默认值、金字塔级数与名义纹素、RT 取整、参数换算（含 feather 0、iterations 小于可用级数）与抓帧常量逐位相等、LDR / HDR 步骤序列、bloom pass 自查；语料：bedroom 开启 / 超高档泛光着色器全部翻译通过、只剩 `value:script`，工坊 3286859278 超高档判为 HDR | 2026-11-01：8 个文件 147 passed（新增 `render/bloom.test.ts` 13 个、`compile/p2b.test.ts` 16 个；p2a 两个用例按新 HDR 规则改写）。语料里新订阅的工坊 3286859278 带尾逗号的 effect.json 曾让 `exhaustive` 编译抛错，已加宽松 JSON |
| [x] | S2 检查 | Windows | `check-kabegame`（vue-tsc + cargo check）；Prettier | 0 error | 2026-11-01：vue-tsc 0、cargo 0 error；未改 Rust |
| [x] | S3 探针不进 release | Windows | 生产模式 `vite build` 到临时目录，搜 `__kabegameSceneProbe` / 探针字符串 | 搜不到 | 2026-11-01：搜不到；泛光材质路径照常在 worker 包里 |
| [x] | D1 链路隔离：LDR | Windows dev | dev 探针 `bloom`：输入 RenderDoc 导出的快照（neon_sunset、shimmering_particles、bedroom 开启档），参数取抓帧常量 | `_rt_4FrameBuffer`、`_rt_Bloom`、最终输出与 WPE 逐像素一致；bedroom 泛光为 0 时输出等于输入 | 2026-11-01：neon 三张最大差 1/255（0.0072–0.0084% 的通道），shimmering 1/4 只有 1 个通道差 1、`_rt_Bloom` 与输出逐值相同；bedroom `_rt_Bloom` 全 0、输出与输入逐字节相同 |
| [x] | D2 链路隔离：HDR | Windows dev | 同上，bedroom / shimmering_particles（feather 0）/ 工坊 3286859278 超高档的 RGBA16F 快照 | L0（下采样后、上采样累加后）按浮点一致；最终输出把 WPE 的线性后备缓冲按 sRGB 编码成 8 位后一致 | 2026-11-01：三组 L0 下采样后逐值相同；上采样后 shimmering / 工坊逐值相同，bedroom 一个像素差 1 个 FP16 ulp（相对 9.7e-4）；最终输出最大差 1/255，占 0.43% / 0.54% / 0.88% 的通道（两边在不同空间存 FP16 的舍入），均值差 < 0.005/255 |
| [x] | D3 关闭档不回归 | Windows dev | dev 探针 `renderFrame`（`g_Time` 3.25 s、关闭档）渲染 bedroom（强制）/ vortex / eagleflag / deep_space / beach，与改动前 P2a 渲染器同条件的输出比 | 离屏目标逐字节相同 | 2026-11-01：五张 SHA-256 全部相同；超高档下 vortex 与 P1 三张（`bloom: false`）也相同；bedroom 开启档（threshold 1，泛光全 0）与关闭档相同 |
| [x] | D4 三档切换 | Windows dev | 预览 bedroom（12888），IPC 依次设关闭 / 开启 / 超高 / 跟随 WPE | 每次重新判定、重新加载；退回原因只剩 `value:script` | 2026-11-01：四次都只报 `value:script`，应用背景的 vortex 同时在 0.26–0.62 s 内重载；测完设回「跟随 WPE」 |
| [x] | D5 bedroom 超高档强制渲染 | Windows dev | `localStorage["kabegame-dev-scene-force-render"]="1"`，超高档预览 bedroom | 构图与 WPE 抓帧一致（灯色因脚本不同）；灯带、霓虹字有 HDR 光晕；关闭档无光晕 | 2026-11-01：日志「18 层、12 个程序，后处理 ultra（泛光 + HDR），目标 3840×2160 rgba16float、渲染目标约 161 MiB」；截图光晕位置与范围同 WPE 抓帧；测完删掉开关、设回「跟随 WPE」 |
| [x] | D6 性能 | Windows dev，NVIDIA Lovelace | `renderFrame` 的 `profile`：bedroom 4K 连续 120 帧，每帧编码 + 提交 + 等 GPU 完成；预览开着时主窗口 rAF | 超高档帧时间与显存可接受 | 2026-11-01：关闭 / 开启 / 超高平均 5.2 / 5.2 / 6.4 ms（p95 8.4 / 9.5 / 10.9 ms）；渲染目标约 70 / 73 / 161 MiB；主窗口 rAF 关闭 139 fps、超高 143 fps |
| [ ] | D7 桌面 | Windows dev，窗口模式 | 桌面壁纸设为场景，切档位 | 与预览同档、同时重载 | 未测：本次没有壁纸窗口（不是窗口模式），没有改用户的壁纸设置；与预览共用 `WpeSceneView` |
| [ ] | D8 能看到泛光的场景 | Windows | 解锁一张开着泛光、无需脚本的场景 | 光晕与 WPE 实拍一致 | 本机能渲染的场景都是 `bloom: false`；有泛光的 bedroom 要 P3，neon_sunset 要 P5、shimmering_particles 要 P4 |

## 场景壁纸 P2a：图层渲染图、effect 链、混合模式、后处理档位

依据对 WPE 2.8.42 的只读逆向（`.claude/plans/wpe-import/3-scene/p2-REPORT.md`）。
- **渲染图**（`wpe-scene/render/graph.ts`）：没有启用 effect、colorBlendMode ∈ {0, 31} 的图层照旧直接上屏；其余「基础 pass 关混合画满合成 RT（图像尺寸）→ effect 在合成 RT 与 fbo 间 ping-pong → 最后一个启用 effect 的最后一个绘制 pass 借基础材质的 blend 上屏」。colorBlendMode 31 改 additive，其它非 0 值由 passthrough 材质上屏（`scene.json` `version` > 2 用 genericimage4）。`_rt_FullFrameBuffer` 是 `copyTextureToTexture` 快照，每图层至多一次。
- **能力表**：只报真正改变画面的特性；着色器改核内置 uniform、引擎 COMBO 与 `_rt_*` 纹理；effect 逐项检查；只导出 `applyUserProperties` 的脚本按 `value` 静态处理。确定退回的场景不再编译完整个场景。
- **FreeImage `.tex`**：PNG / JPG mip 由主线程解码并跨重新编译缓存；纹理尺寸取头里的图像尺寸（UV 为 1）。
- **设置「场景后处理」**（壁纸分区，仅 Windows）：跟随 WPE（默认，读 WPE 的 `config.json`）/ 关闭 / 开启 / 超高。P2a 只画泛光、HDR 都关的情况，实际开着时报 `postprocess:bloom` / `postprocess:hdr` 并退回预览图。
- **内置 uniform 校正**：空槽 `g_Texture<n>Resolution` = (2,2,2,2)、新增 `g_Texture<n>Texel` / `g_Screen` / `g_Frametime` / `g_PointerState`、`g_Time` 5 天回绕、`g_Daytime` 精确到毫秒、`g_PointerPosition` 改为窗口归一化坐标（左上原点）、效果矩阵按 effect / 上屏 pass 分别取值。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测与语料 | Windows | `apps/kabegame` 下 `KABEGAME_WPE_ROOT=<WPE 安装目录> npx vitest run src/wpe-scene` | 合成 RT 计数与上屏 pass、swap 下标交换、copy、快照时机、能力表裁决、档位解析、脚本静态规则、FreeImage 区间与缓存、内置 uniform 表一致；语料里 eagleflag / deep_space / beach / razer_vortex 为空、razer_bedroom 只剩 `value:script`、其余非空，快速路径每张不超过 150 次请求 | 2026-11-01：6 个文件 109 passed（新增 `render/graph.test.ts` 18 个、`compile/p2a.test.ts` 21 个）；全前端 vitest 655 passed，4 个文件是既有失败（i18n mock、vue-jsx SSR 路径） |
| [x] | S2 检查 | Windows | `check-kabegame`（vue-tsc + cargo check）；`test-kabegame kabegame-core --lib settings`；Prettier；rustfmt | 0 error；新增 `wpe_scene_postprocess_rejects_unknown_values` 通过 | 2026-11-01：vue-tsc 0、cargo 0 error；core settings 15 passed |
| [x] | S3 能力表前后对比 | Windows | 语料表改动前后对比（`exhaustive`） | 新解锁 razer_vortex；bedroom 34 → 1 项；其余场景只少了噪音项，新增的都是真不支持（`tex:format:8/9`、`uniform:g_AudioSpectrum*`、`g_ParallaxPosition`、工坊着色器翻译失败、引用别的图层合成 RT） | 2026-11-01 |
| [x] | D1 vortex 预览 | Windows dev | 图库预览 razer_vortex（12889） | 实时渲染：中间 Razer 标志与漩涡底图，THS 层在中间、色带沿径向滚动 | 2026-11-01 Claude 经 CDP：画布带 `live`、没有预览图；隔 1 秒两帧变化 15.8%；日志「3 层、3 个程序，后处理 disabled，用时 310 ms」，无 Tint 告警 |
| [x] | D2 vortex 桌面 | Windows dev，窗口模式 | 设为桌面壁纸 | 同上，桌面在动 | 2026-11-01：壁纸窗口 3840×2160 画布 `live`、`media: scene`、rAF 141–144；页面内把画布画到 2D 画布取两帧，变化 22.7% |
| [x] | D3 P1 不回归 | Windows dev | 主窗口临时画布渲染 eagleflag / deep_space / beach | 与 P1 一致（仍走直接上屏） | 2026-11-01：三张都无告警、在动（变化 50.8% / 2.0% / 26.0%）。一度发现 deep_space 的 Background 缩成中间一小块（没写 size 时先取了 480×270 的遮罩纹理尺寸），已改回先取模型 width / height 并加单测 |
| [~] | D4 改属性不重解码 | Windows dev | 同一张场景改属性后重新编译 | 不重新解码底图 PNG | 2026-11-01：页面里用同一份 `TextureDecodeCache` 编译 vortex 两次（第二次改速度），解码仍是 7 次，第二次 149 ms（第一次 296 ms）。没有在属性面板里实改（会写图片 metadata）；「模式」要等 P3 脚本宿主才生效 |
| [x] | D5 三档切换 | Windows dev | 设置里「场景后处理」切到开启 / 超高 / 关闭 / 跟随 WPE | 正在显示的场景立即重新判定、重新加载；bedroom 开启 / 超高时多出 `postprocess:*`；vortex（`bloom: false`）各档都实时渲染 | 2026-11-01：IPC 依次切四档、设置弹窗点「开启」再点回「跟随 WPE」，每次桌面、预览、应用背景三个实例都在 0.25–0.7 s 内重载，跟随时解析为 WPE 的 `disabled`；bedroom 四档的退回原因分别为 `value:script` / `+postprocess:bloom` / `+bloom、hdr` / `value:script`。测完设置为「跟随 WPE」 |
| [x] | D6 bedroom 强制渲染 | Windows dev | dev 强制渲染 bedroom | 构图与 WPE 一致（灯光颜色因脚本取静态值而不同）；colorBlendMode 11 / 12 的灯光按混合模式叠到墙上 | 2026-11-01：主窗口临时画布 `force`，与作者 `preview.gif` 构图一致：灯带、左侧光晕、台灯粉光都在；霓虹字取脚本的静态值为红色（GIF 为绿色）；没有改 localStorage |
| [x] | D7 与 WPE 实拍对照 | Windows | 用户在 WPE（后处理 disabled）里录 vortex 桌面，与 Kabegame 同尺寸画面对照 | 构图、颜色一致 | 2026-11-01：两边时钟起点不同，按 `g_Time` 相位扫描找最接近的时刻（t≈4.9 s）再比，1920 全图平均差 1.76、95% 像素差 ≤ 6，中心图标外框同为 297×277；后又用 RenderDoc 抓 4 帧、按常量缓冲里的精确 `g_Time` 钉时钟逐像素比：3840×2160 平均差 0.27–0.29/255、99% 像素差 ≤ 3、差 >16 仅 0.04%（各向异性采样在 frac 接缝的行为差异，不可见）；详见 `.claude/plans/wpe-import/3-scene/p2-REPORT.md` J2/J3 节 |
| [ ] | M 非 Windows | macOS / Linux | 设置页 | 不显示「场景后处理」 | 未测 |

## 网页壁纸音量

网页壁纸接入壁纸音量设置，并按 iframe 单独控制：应用背景静音，桌面与预览跟随 `wallpaperVolume`。
- **协议**：垫片（`wpe_shim.js`）经 postMessage 向父页面（`WallpaperStage`）要音量（`kabegame:wpe-volume-request`），父页面回复当前 `volume` prop（`kabegame:wpe-volume`，`paused` 时为 0），变化时主动推。收到第一次回复前垫片按静音。宿主消息校验 `isTrusted` 与 `source === window.parent`。
- **接管**：`<audio>` / `<video>` 的原生音量 = 页面值 × 宿主音量（页面读到自己设的值）；Web Audio 连到实时 context `destination` 的连接改接到主增益节点。不能用 CEF 整窗口静音：会连预览视频一起静掉。
- **文案**：设置「视频壁纸音量」改为「壁纸音量」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 检查 | Windows | `vitest src/wpe-scene src/components/wallpaper`；`vue-tsc`；Prettier；`check-kabegame --skip vue` | 全过 | 2026-11-01：7 个文件 95 passed（新增 `wpeWebVolume.test.ts` 在 node:vm 里直接跑垫片原文、`WallpaperStage.webVolume.test.ts`），其余 0 error（Claude 独立复跑） |
| [x] | D1 桌面跟随音量 | Windows dev | 桌面为 12098（Unity，AudioContext），`wallpaperVolume` 1 → 0.5 → 0 → 1 | 主增益随设置变化；媒体元素原生值 = 页面值 × 设置值 | 2026-11-01 代理读数：1 / 0.5 / 0 / 1；`new Audio()` 设 0.8 时原生 0.8 / 0.4，页面始终读到 0.8 |
| [x] | D2 预览 | Windows dev | 预览 12097（`<audio>`、`<video>` 与 AudioContext） | 按设置音量出声；设置为 0 时原生静音、页面读值不变 | 2026-11-01 代理：audio 页面 0.125 → 原生 0.0625（设置 0.5）；设置 0 时原生 0 + muted |
| [x] | D3 应用背景静音 | Windows dev | 开启应用背景，当前壁纸为网页壁纸 | 宿主音量 0、主增益 0 | 2026-11-01 代理：始终 0；换壁纸重建 iframe 后桌面回 1、背景回 0 |
| [x] | D4 Web Audio 兼容 | Windows dev | 预览 iframe 里建临时 AudioContext，测 `connect` 返回值、`createMediaElementSource` / `new MediaElementAudioSourceNode`、错误语义 | 与原生一致；接进 context 的元素不重复乘音量 | 2026-11-01 代理：`connect` 返回 destination；元素原生值保持页面值；重复断开 InvalidAccessError、input 1 IndexSizeError |
| [ ] | D5 实际听感 | Windows dev | 播放带音乐的网页壁纸，开关应用背景、调壁纸音量 | 应用背景不出声，桌面音量跟随设置 | 未测：代理只读了数值，没有实听，也没有点页面自己的播放按钮（会改写它 localStorage 里的播放状态） |
| [ ] | D6 回复前静音 | Windows dev | 打开一张开场就放声音的网页壁纸 | 开头不先响一下 | 只有单测 |

## 场景壁纸 P1-5：接入 `WallpaperStage`

`WallpaperStage` 新增 scene 层，挂 `WpeSceneView`，行为照 web 层：独立一层、淡入淡出、切走即卸载、同一时间只有一个场景。`isWpeWallpaperContentType` 改为认网页与场景，图库预览与桌面壁纸窗口实时渲染场景。
- **加载**：编译期间保持加载态，桌面上保留上一张壁纸。能渲染就直接淡入实时画面；不能渲染（或 10 秒内没有结果）才显示作者预览图（壁纸目标新增 `previewPath`）。
- **重编译**：改属性触发的重编译期间画面保持旧场景。
- **其它**：当时壁纸样式对场景不生效，固定 cover（现已跟随样式，见「场景壁纸样式与预览比例」）。属性面板对场景也显示，隐藏 `file` / `directory`。应用背景不再按类型分支，网页与场景壁纸都实时渲染。画布像素按显示尺寸（含 CSS transform）× DPR，预览「桌面画布」不再按 4K 渲染。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 检查 | Windows | `vitest src/wpe-scene src/components/wallpaper`（设 `KABEGAME_WPE_ROOT`）；`vue-tsc`；Prettier；`check-kabegame --skip vue`；`rustfmt --check` | 全过 | 2026-11-01：5 个文件 82 passed（新增 `WallpaperStage.scene.test.ts` 13 个），其余 0 error（Claude 独立复跑） |
| [x] | D1 预览实时渲染 | Windows dev | 预览 eagleflag（12885）/ deep_space（12881）/ beach（12880） | 实时画面在动；「桌面画布」形态正常 | 2026-11-01 代理：隔 1 秒两帧，beach 变化 17.2%、deep_space 4.8%（动得慢） |
| [x] | D2 加载不跳 | Windows dev | 打开一张能渲染的场景 | 结果出来前只有加载态，不先闪预览图 | 2026-11-01 代理逐帧：beach 0–719 ms 只有加载态，首帧后直接淡入；会退回的 audiophile 119 ms 退回后才显示预览图 |
| [x] | D3 退回预览图 | Windows dev | 预览 12906（工坊）、12900（MGS4，gif 预览） | 显示预览图、gif 在动，无报错提示 | 2026-11-01 代理：两张都符合 |
| [x] | D4 来回切换 | Windows dev | 在场景、网页壁纸、WPE 视频、普通图片之间切换 | 同时最多一个场景、一个画布，切走后画布归零 | 2026-11-01 代理：每 50 ms 采样，符合。有一次 eagleflag 首帧用了 3.9 s（从 CORSAIR 网页壁纸切来），重跑 312 ms，未复现 |
| [x] | D5 属性即时生效 | Windows dev | 预览右栏改 eagleflag 的 Accent 2，再「全部重置」 | 画面立即变色，重编译期间画面不闪；重置后还原 | 2026-11-01 代理：蓝 / 绿两次都符合，已重置（metadata 行 id 由 19652 变为 19679，内容与导入时相同） |
| [x] | D6 桌面实时渲染 | Windows dev，窗口模式 | `set_wallpaper_by_image_id` 设 eagleflag | 桌面场景在动；壁纸窗口不被判为隐藏 | 2026-11-01 代理：壁纸窗口 `visibilityState` 为 `visible`，rAF 144 帧 / 秒，1 秒变化 32.8%；Kabegame 窗口压在 WPE 窗口之上。测完还原为 12880、轮播与样式不变 |
| [x] | D7 桌面图片 → 场景 | Windows dev | 从图片壁纸设为场景 | 编译期间保留原图，首帧后场景盖上 | 2026-11-01 代理：符合 |
| [ ] | D8 桌面场景 → 场景 | Windows dev | 从一个场景设为另一个场景 | 无空档 | **已知问题**：同一时间只允许一个场景，旧场景先卸载，eagleflag → 12906 露出约 215 ms、12906 → beach 约 387 ms 窗口背后的内容 |
| [ ] | D9 过渡 | Windows dev | 过渡设为 fade / slide / zoom 后在场景与其它类型间切换 | 过渡正常 | 未真机测（真机过渡为 none），只有单测 |
| [ ] | D10 超时退回 | Windows dev | 让编译 10 秒内没有结果 | 显示预览图并就绪，迟到的首帧仍切成实时画面 | 未真机测，只有单测 |
| [ ] | D11 设置页属性按钮 | Windows dev | 当前壁纸为场景时打开设置页「当前壁纸」 | 显示属性按钮，可改属性 | 未真机测 |
| [x] | D12 应用背景 | Windows dev | 开启应用背景，当前壁纸设为场景 beach | 背景实时渲染、不可交互 | 2026-11-01 代理：有 `live` 类、没有退回预览图；层与画布 `pointer-events: none`，窗口中心命中画廊元素；画布 1850×1191 ≈ 显示尺寸 × DPR 1.5（含 1.04 放大） |
| [x] | D13 预览画布尺寸 | Windows dev | 预览 beach（「桌面画布」），读 canvas 的 `width/height` 与显示尺寸；拖动改变窗口大小 | 画布像素约等于显示尺寸 × DPR，不再是 3840×2160；改窗口大小后 250 ms 内跟上 | 2026-11-01 代理：1071×602 = 显示 714×401.6 × 1.5；缩小 / 恢复窗口后分别 107.5 ms、140.6 ms 跟上 |
| [ ] | M 非 Windows | macOS / Linux | 预览一张场景 | 显示预览图（`sceneAssets` 为空 → `assets:missing` 退回） | 未测 |

## 场景壁纸 P1-4：WebGPU 渲染器

`apps/kabegame/src/wpe-scene/render/` 把 `SceneBundle` 画到画布：RGBA8 / BC3 纹理连同 mip 上传，std140 打包 uniform（内置 uniform 照 linux-wallpaperengine `CPass.cpp`，材质与用户值优先），混合照 LWE，场景分辨率离屏目标再 cover 铺到画布，`paused` / 页面隐藏时停帧并冻结 `g_Time`。
每个着色器模块开头加 `diagnostic(off, derivative_uniformity);`（HLSL 允许分支里隐式求导）。组件 `components/wallpaper/WpeSceneView.vue` 自读用户属性、在 Worker 里编译、按本张的 `metadataId` 补丁重编译，不能渲染时 emit `fallback(reasons)`。
`get_wpe_web_properties` / `set_wpe_web_user_properties` 放宽为也接受 `x-wpe/scene`（属性格式与网页壁纸相同）。尚未接进 `WallpaperStage`（P1-5），网格、预览与桌面仍显示预览图。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测 | Windows | `apps/kabegame` 下 `KABEGAME_WPE_ROOT=<WPE 安装目录> npx vitest run src/wpe-scene` | uniform 打包、矩阵 / 四边形 / cover、BC 行跨度与 mip 物理尺寸、混合映射、时钟等通过；原有编译管线与语料用例照过 | 2026-11-01：4 个文件 69 passed（Claude 独立复跑） |
| [x] | S2 类型与格式 | Windows | `vue-tsc --noEmit`；Prettier；`check-kabegame --skip vue` | 0 error | 2026-11-01：vue-tsc 0、cargo 0 error；新增 / 修改的 ts、vue、package.json 格式通过 |
| [x] | D1 三张 P1 样本 | Windows dev | 主窗口临时画布渲染 eagleflag / deep_space / beach，对照各自 `preview.jpg` | 构图、朝向、颜色与预览图一致；无 WebGPU 校验错误 | 2026-11-01：适配器 nvidia lovelace、有 `texture-compression-bc`。eagleflag、deep_space 一致；beach 比作者 `preview.jpg` 暗、少光晕，但与 WPE 桌面实拍一致（见 D6），预览图另有后期。Claude 另独立渲染 eagleflag 与 beach，无错误、无告警 |
| [x] | D2 动画 | Windows dev | 同上隔约 1 秒截两帧 | 旗帜摆动、流动 / 摇摆在动 | 2026-11-01：变化像素 eagleflag 33.5%、deep_space 16%、beach 19% |
| [x] | D3 用户属性覆盖 | Windows dev | 给 eagleflag 传 `userProperties: { flagcolor2: "0 0 1" }` | 星形变蓝 | 2026-11-01：通过（只走编译参数，未写数据库） |
| [x] | D4 组件行为 | Windows dev | 临时挂载 `WpeSceneView`：正常样本、`paused`、模拟页面隐藏、伪造 `metadataId` 补丁、换到 retro 再换回 | 首帧 emit `ready`；暂停时画面不变、恢复继续；补丁触发重编译且不重复 `ready`；retro emit `fallback`（`combo:dots`、`object:model`、`shader:retro:unsupported`），换回能再 `ready` | 2026-11-01：全部符合；`ready` 约 230–265 ms。修了响应式 target 交给 Worker 无法克隆的问题 |
| [x] | D5 全语料 Tint | Windows dev | 29 张样本 bundle 的 program，以及 wasm 翻译成功的 153 对着色器，逐个 `createShaderModule` + `getCompilationInfo` | 0 error | 2026-11-01：bundle 46 个 program / 92 个模块、语料 306 个模块，都是 0 error 0 warning。不加前言时只有 `depthparallax` 片元报 `textureSample must only be called from uniform control flow` |
| [x] | D6 beach 与 WPE 实机对照 | Windows | 在 Wallpaper Engine 里把 beach 设为桌面壁纸并截全屏（3840×2160），与 Kabegame 渲染（16:9 画布）缩放到同尺寸对照 | 构图、亮度与光晕一致 | 2026-11-01：用户截桌面、Claude 对照：棕榈 / 树干 / 山线 / 水面高光位置重合；平均亮度 122.5 对 123.9，上下四段亮度差都在 5 以内，平均像素差 10.1（含云层滚动与摇摆相位、桌面图标）。作者 `preview.jpg` 更亮、带光晕且偏移约 30 px，不能当基准 |
| [ ] | D7 设备丢失重建 | Windows dev | 触发 GPU 设备丢失 | 重建一次后继续渲染，一分钟内再丢则 `fallback` | 未测：真机无法主动触发 |
| [ ] | D8 指针 | Windows dev | `interactive` 时移动指针 | `g_PointerPosition` 跟随 | 未测：P1 样本不用指针，只有单测 |

## 场景壁纸 P1-3：前端编译管线

`apps/kabegame/src/wpe-scene/compile/` 把一张场景壁纸编译成渲染器的唯一输入 `SceneBundle`（图层、着色器程序、纹理、`unsupported` 能力键）：
- **资源查找**：`SceneFs` 依次查项目散文件 → `scene.pkg` → `sceneAssets`。散文件不探测大小：json / shader 直接整读，`.tex` 用首个 4 KiB 区间读兼做存在判断；
  查找结果与内容在一次编译内缓存，pkg 相邻小条目共用 64 KiB 窗口。
- **解析**：`.tex` 只解析容器头与 mip 表；视频纹理只记下 MP4 区间。着色器交给 `wpesl2wgsl`。
- **能力表**：`features.ts` 只放行 P1 实现的能力，其余一律记进 `unsupported`，非空就退回预览图。
- **Worker**：`compileSceneInWorker` 在 Worker 里编译；主线程代读 `file:`，并把编译好的 wasm Module 交给 Worker。

还没有使用方，渲染器是 P1-4。计划见 `.claude/plans/wpe-import/3-scene/PLAN.md` 点 P1-3，文档见 `cocs/wpe/WPE_SCENE.md`「编译管线」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测 | Windows | `npx vitest run src/wpe-scene`（`apps/kabegame`） | 路径越界拒绝、用户值 / 条件 / 脚本默认值、shader 用户属性缺失回退、能力表、LZ4、TEXB0001–0004、视频区间、来源优先级、查找缓存、Worker 往返后的「不存在」错误、Range 被忽略时取消流都通过 | 2026-11-01：40 passed（含 pkg 与翻译器既有用例） |
| [x] | S2 本机语料 | Windows | 同上，设 `KABEGAME_WPE_ROOT=<WPE 安装目录>` | 全部样本经 `FetchSceneReader`（Node 假 fetch，语义对齐 CEF）编译：P1 三张 `unsupported` 为空且纹理 mip 齐全，其余每张非空；没有单字节探测；单张读取 < 64 MiB、请求 ≤ 150 | 2026-11-01：29 张（默认 16 + 工坊 13）。最大读取 deep_space 7.6 MB；请求最多 3219908811 的 150 次（正好压线），P1 三张 34–59 次；视频纹理本体未读。工坊目录只读 |
| [x] | S3 类型与格式 | Windows | `vue-tsc --noEmit`、Prettier | 0 error、格式通过 | 2026-11-01：通过 |
| [x] | D1 `file:` 响应头 | Windows dev | 主窗口经 CDP 对 `file:` 整读、`Range`、`HEAD` | 记录是否带 `Content-Length` | 2026-11-01：三种都只有 `content-type` 与 `last-modified`，没有 `Content-Length`，所以不能靠响应头取文件大小。单次 Range 请求约 2.25 ms，文件不存在约 1.6 ms |
| [x] | D2 Worker 编译 | Windows dev | 主窗口经 CDP 动态导入 `client.ts`，对 eagleflag / deep_space / beach / 3656079027 / 3146703458 调 `compileSceneInWorker` | Worker 拿到 wasm Module、经主线程读 `file:`；P1 三张 `unsupported` 为空、DXT5 / RGBA 的 mip 以 `Uint8Array` 回传；工坊两张只读纹理头 | 2026-11-01 Claude：五张全部成功，每张 164–350 ms（去掉大小探测前 0.7–1.2 s）。复核时发现一个 bug：Worker 收到的读取错误被重建成普通 `Error`，任何一次未命中都会让编译失败。已改为回传错误类型名并在 Worker 端还原（`protocol.ts`），修后复测通过 |
| [ ] | M1 发布版 Worker | Windows release | 安装包里打开场景壁纸预览（P1-5 接入后） | module Worker 在应用页的自定义 scheme 下能起来 | 未测：P1-4 / P1-5 接入后才有入口 |

## 场景壁纸 P1-2：WPE 安装目录交给前端

场景壁纸要从 WPE 安装目录的 `assets/` 读内置着色器、effect 与工具材质。壁纸目标（`get_wallpaper_target_for_image` / 当前壁纸）新增 `sceneAssets`：
只对 `x-wpe/scene` 计算，值是各 Steam 库里 WPE 安装目录下存在的 `assets` 绝对路径（`kabegame_core::wpe::discover::scene_asset_dirs`，
`engine_dirs` 由 `locale.rs` 挪进 `discover.rs` 共用）；其它类型与非 Windows 为空数组。前端还没有使用方（P1-3 的资源解析层）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 检查 | Windows | `check-kabegame`；`test-kabegame kabegame-core --lib wpe` | 0 error，改动文件无新 warning；wpe 单测照过 | 2026-11-01：vue-tsc 0 / cargo 0 error；32 passed |
| [x] | D1 场景目标 | Windows dev | 主窗口 `get_wallpaper_target_for_image` 取一张场景壁纸 | `sceneAssets` 为 `["<库>\steamapps\common\wallpaper_engine\assets"]` | 2026-11-01 Claude 经 CDP：12906（超时空辉夜姬，工坊 pkg）与 12885（eagleflag，默认项目）都返回 `["D:\Applications\Steam\steamapps\common\wallpaper_engine\assets"]`；dev 重编后首次调用约 30 秒内可用 |
| [x] | D2 其它类型 | Windows dev | 同上取网页 / 视频 / 图片 | `sceneAssets` 为空数组，`webEntry` 等其它字段不变 | 2026-11-01：网页 12094（`webEntry` 照旧是 `file:///…`）、WPE 视频 12091（`wpeVideo` 照旧有值）、普通图片 5217 的 `sceneAssets` 都是 `[]` |
| [x] | D3 `ui_` 词条不受影响 | Windows dev | 预览一张网页壁纸的属性面板 | `ui_` 开头的属性名仍显示译文（`locale.rs` 改用 `discover::engine_dirs`） | 2026-11-01：`get_wpe_web_properties`（12096，3677233365）里 `schemecolor` 的标签是「主题配色」，即 `ui_browse_properties_scheme_color` 仍从 WPE 安装目录的 `locale` 词表译出 |
| [ ] | M 非 Windows | macOS / Linux | 取一张场景壁纸的目标 | `sceneAssets` 为空、日志没有「找不到 WPE 安装目录」告警 | 未测 |

## 场景壁纸 P1-1：scene 入库

`wpe-import` 开始导入场景壁纸（`x-wpe/scene`）：创意工坊发布形态的入口打包在 `scene.pkg` 里，目录里有包就算入口存在，`hash` / `size` 取包；
没有 `type` 但入口是 `.json` 的默认项目（audiophile、techno）按场景处理。渲染器（P1-5）接入前，场景行在网格、预览与应用背景里显示作者预览图，
设为桌面壁纸还不能渲染。扫描结果新增 `scene` 计数，导入对话框显示「场景 n」。计划见 `.claude/plans/wpe-import/3-scene/PLAN.md` 点 P1-1。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 core 单测 | Windows | `test-kabegame kabegame-core --lib wpe` | 只有 `scene.pkg` 的场景可入库且 `content_path` 取包；散文件入口优先；无 `type` + `.json` 入口为场景；只有包不能让其它类型通过；扫描计数含 scene | 2026-11-01：32 passed（新增 `scene_entry_may_be_packed`、`missing_type_with_json_entry_is_scene`，`counts_total_video_and_imported` 加了包形态的场景） |
| [x] | S2 前端检查 | Windows | `vue-tsc --noEmit`、Prettier | 0 error | 2026-11-01：通过 |
| [x] | D1 扫描计数 | Windows dev | 打开「壁纸」收集对话框（或 `wpe_scan`） | 创意工坊来源「场景 13」，默认项目来源「场景 16」（含无 `type` 的 audiophile / techno），待导入数相应增加 | 2026-11-01 Claude 经 CDP 调 `wpe_scan`：创意工坊 scene 13、pending 13（视频 / 网页都已入库），默认项目 scene 16、pending 16。导入期间用户还在订阅，工坊场景数从 10 增到 13 |
| [x] | D2 导入工坊场景 | Windows dev | 勾选创意工坊来源导入 | 13 张场景入库：`type = x-wpe/scene`，`local_path` 是壁纸目录，缩略图是作者 `preview.*`，`size` 等于 `scene.pkg` 大小，宽高为空 | 2026-11-01 Claude 经 `start_task` 导入两个来源（与对话框勾选相同）：任务 29 成功、约 8 秒（含 712 MB 的包）。只读查 dev 库：13 行工坊场景的 `size` 全部等于 `scene.pkg` 大小，`thumbnail_path` 是 `preview.gif` / `preview.jpg`，宽高与 `compatible_path` 为空。WPE 目录只读 |
| [x] | D3 导入默认项目 | Windows dev | 勾选默认项目来源导入 | 16 张场景入库（sheep 是 application，仍跳过） | 2026-11-01 同一任务：16 行，入口是散文件，`size` 取入口 json；audiophile、techno 已入库 |
| [x] | D4 幂等 | Windows dev | 再导入一次 | 全部计为已存在，不新增行 | 2026-11-01：再跑一次，任务成功数 0，`x-wpe/scene` 仍是 29 行 |
| [x] | D5 显示 | Windows dev | 网格、预览弹窗、应用背景里打开场景行 | 显示作者预览图，不报壁纸组件错误 | 2026-11-01 Claude 经 CDP：网格缩略图正常；双击 MGS4（12900）打开预览弹窗，显示 `preview.gif`、没有壁纸组件、无错误提示；测完关闭弹窗。应用背景未单独测 |

## 场景壁纸：`scene.pkg` 读取

创意工坊发布的场景把 `scene.json` 与资源打进 `scene.pkg`（本机 5 张工坊 scene 全是这种形态）。
`apps/kabegame/src/wpe-scene/compile/pkg.ts` 的 `ScenePkg` 移植自 linux-wallpaperengine 的目录表读取：只读 64 KiB 起的目录表，条目经带 `Range` 头的 `fetch(file:)` 按区间读，不整包加载（最大的包 336 MB）。
计划见 `.claude/plans/wpe-import/3-scene/PLAN.md`，文档见 `cocs/wpe/WPE_SCENE.md`。本轮只有读取模块，还没接入导入与渲染。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 单测 | Windows | `npx vitest run src/wpe-scene/compile/pkg.test.ts`（`apps/kabegame`） | 目录表与条目读取、按区间读、目录表加倍重读、同名取第一条、非 PKGV 头、目录表 / 条目截断、读取方忽略区间都按预期 | 2026-11-01：8 passed |
| [x] | S2 本机工坊语料 | Windows | 同上，设 `KABEGAME_WPE_ROOT=<WPE 安装目录>` | 每个工坊 `scene.pkg`：版本形如 `PKGV\d{4}`；最后一个条目结束在文件末尾；`scene.json` 能解析；首个 `.tex` 的魔数为 `TEXV0005` | 2026-11-01：5 passed（`PKGV0018` / `0021` / `0022` / `0024`，41–140 个条目，27–336 MB）。工坊目录只读 |
| [x] | S3 类型与格式 | Windows | `vue-tsc --noEmit`、Prettier | 0 error、格式通过 | 2026-11-01：两项通过 |
| [x] | D1 `Range` 读 `file:` | Windows dev | 主窗口经 CDP `fetch(file:///…/scene.pkg, { headers: { Range } })` | 只返回请求区间；条目偏移从目录表结束处算起 | 2026-11-01：`bytes=0-15` 返回 16 字节（约 5 ms），`bytes=6781-6800` 正是 `scene.json` 开头；状态都是 200、没有 `Content-Range` 头；跨过末尾截短，起点越界 `Failed to fetch`，后缀与开区间可用 |

## 场景壁纸 P1-0：着色器翻译器 `wpesl2wgsl` 与 wasm 构建链

WPE 着色器（WPESL）原文交给 `src-tauri/wpesl2wgsl`。它在内部完成预处理与改写，经 naga 翻成 WGSL，编成 wasm 给前端渲染器用，不链进应用。
- 构建：`deno task build:wpesl2wgsl`，产物 `bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm`。
- 进前端：kabegame 命令不带 `--skip vue` 时由 `Wpesl2wgslPlugin` 拷到 `apps/kabegame/src/wpe-scene/wpesl2wgsl/`，缺失只告警。
- 契约见 `src-tauri/wpesl2wgsl/README.md`，计划见 `.claude/plans/wpe-import/3-scene/PLAN.md`。
- 语料测试只读访问本机 WPE 安装目录（`KABEGAME_WPE_ROOT`）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 crate 单测 | Windows | `cargo test -p wpesl2wgsl --lib`（`CARGO_TARGET_DIR=target-check`） | 预处理、改写、naga 阶段、端到端、C ABI 全部通过 | 2026-11-01：24 passed；端到端用例的输出 WGSL 经 naga `wgsl-in` 回读通过 |
| [x] | S2 本机语料 | Windows | `KABEGAME_WPE_ROOT=<WPE 安装目录> cargo test -p wpesl2wgsl --test corpus -- --nocapture` | P1 门槛（`flag` TINT=1、`genericimage`、deep_space / beach 的 `flowimage` / `swayimage`）全过；输出 WGSL 回读 0 失败 | 2026-11-01：167 对通过 153 对（91.6%），回读 0 失败。剩余失败：`#require LightingV1` 6、阴影 GS 的 `gl_ViewportIndex` 3、HLSL 隐式截断 / varying 类型不一致 2、`BONECOUNT` 1、`sampler2DBackBuffer` 1、编辑器专用 1，均不在 P1–P6 样本内。本轮修正：uniform 标量数组在 WGSL 里步长不合法（audiophile / demon_core），改为补成 vec4 数组 |
| [x] | S3 wasm 构建 | Windows | `deno task build:wpesl2wgsl` | 产物写入 `bin/wasm/wpesl2wgsl/`，没有导入项 | 2026-11-01：1454 KiB；`WebAssembly.Module.imports` 为空，导出 `memory / wpesl_alloc / wpesl_free / wpesl_translate` |
| [ ] | S4 缺 wasm 目标 | Windows | 未装 `wasm32-unknown-unknown` 时运行 `deno task build:wpesl2wgsl` | 报错并给出 `rustup target add wasm32-unknown-unknown` | 未实测：本机本轮已装上该目标 |
| [x] | S5 拷进前端 | Windows | `deno task test -c kabegame --skip cargo` | 日志「[Wpesl2wgslPlugin] 复制 …」；前端副本与 `bin/wasm/` 都被 git 忽略；内容相同时不重写 | 2026-11-01：首次与重建后都打出复制日志；之后再跑 check 没有复制日志；`git check-ignore` 命中 `.gitignore` 两条新规则 |
| [x] | S6 缺产物告警 | Windows | 把产物挪开后运行 `check-kabegame --skip cargo` | 黄字告警「未找到 …先运行 deno task build:wpesl2wgsl」，vue-tsc 照常通过 | 2026-11-01：告警出现，vue-tsc 0 error；测完已放回产物 |
| [x] | S7 `--skip vue` 不复制 | Windows | `check-kabegame --skip vue` | 没有 Wpesl2wgslPlugin 输出；主程序 cargo check 照常 | 2026-11-01：无插件输出，cargo 0 error（新 crate 进 workspace 不影响 `kabegame`） |
| [x] | S8 前端胶水 | Windows | `npx vitest run src/wpe-scene`（`apps/kabegame`） | 补头文件重试、缺失清单、失败诊断带 GLSL 三项通过 | 2026-11-01：3 passed。同轮全量 vitest 另有 `KameToolboxBubble.test.ts` 的 i18n mock 失败，与本次无关（该文件未改动） |
| [ ] | D1 浏览器接受 WGSL | Windows dev | 在应用页用 wasm 翻译本机语料，逐份 `device.createShaderModule` + `getCompilationInfo()` | 没有 error 级消息 | 待真机：本轮 dev 未运行；P1 第一项真机用例 |
| [ ] | M 其它平台 | macOS / Linux | `rustup target add wasm32-unknown-unknown` 后 `deno task build:wpesl2wgsl`，再 `check-kabegame` | 构建与检查通过 | 未测 |

## 网页壁纸音频与媒体集成（Phase 8）

页面登记音频 / 媒体监听后，垫片调 `wpe_web_media_subscribe` 交出 Tauri Channel；订阅按调用方 frame 归属（tauri 补丁 18 增补公开 `tauri::ipc::CallerFrame`），`SubframeDestroyed` 即释放。后端 `wpe_media`：WASAPI 回环 + 自定频谱、SMTC 媒体会话、封面配色；设置「网页壁纸媒体集成」（`wpeMediaIntegration`，默认开）。只 Windows 有数据源。方案见 `.claude/plans/wpe-import/2-web/phase-8-audio-media.md`。订阅数看日志里「网页壁纸媒体订阅」/「释放网页壁纸媒体订阅」的 `subscriptions` 字段，采集与监视启停看「网页壁纸音频采集已启动 / 已停止」「网页壁纸媒体会话监视已启动 / 已停止」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 补丁 18 增补 | Windows | 撤下 19 → `deno task patch tauri --gen --from 17` 覆盖 18 → 套回 19 → `--check`；比对新旧 18 | 新 18 只多出 `CallerFrame`、`SubframeDestroyed` 文档与单测；19 不变；工作区与序列一致 | 2026-10-31：`--check` OK dry-run；新旧 18 差异只有这三处（+97 / −8）；之后 `--gen --from 19` 输出为空。生成前先把 `third/tauri` 里补丁 06 / 08 / 09 的三处四位编号注释对齐成两位（4d3b82bf 改名后工作区未重打补丁） |
| [x] | S2 tauri 单测 | Windows | `third/tauri` 内 `cargo test -p tauri --lib caller_` | `caller_frame_is_the_reported_frame` 等通过 | 2026-10-31：3 passed（含 18 已有的 `caller_origin_is_the_request_origin`、`caller_address_follows_frame_and_id`） |
| [x] | S3 应用单测 | Windows | `driver.sh kabegame --lib wpe` | 订阅表、频谱、配色、`supportsaudioprocessing` 判定通过 | 2026-10-31：24 passed（新增 `wpe_media` 16 项 + `audio_processing_needs_explicit_true`） |
| [x] | S4 check 与格式 | Windows | `check-kabegame`；改动文件 rustfmt / Prettier | 0 error，新文件无 warning | 2026-10-31（`CARGO_TARGET_DIR=target-check`）：vue-tsc 0 error、cargo 0 error，新文件无 warning（`wpe_web.rs` 的 `build_wpe_web_state` 未使用为既有）；`wpe_media/*` rustfmt 干净，`settingsDescriptors.ts` 等改动文件 Prettier 通过；补丁 18 的 tauri 改动按 `third/tauri/rustfmt.toml` 无差异 |
| [x] | S5 前端单测 | Windows | `apps/kabegame` 下 `npx vitest run` 跑 `usePreviewMediaSession.test.ts`、`ImageContent.videoRelease.test.ts` 与全量 | 两个新文件通过；全量无新增失败 | 2026-11-01：新文件 5 + 3 项通过（换源、切成图片、卸载三种情况旧 `<video>` 都去掉 src 并 `load()`）。全量 520 项通过；4 个文件加载失败与本次无关：`backfillName.ts` 遇到缺 `i18n` 导出的 `@kabegame/i18n` mock、vue-jsx 在 Windows 上的 SSR helper 路径，涉及文件本次未改 |
| [x] | B1 频谱 | Windows dev | 导入 `3747222633`「音域回响」设为桌面；播放器放音乐，再停止 | 频谱随音乐动、左右分开、低频在前；停止后约 1 秒回落、出现空闲波浪；`Audio` 约 30 次每秒 | 2026-10-31 Claude 实测：桌面 12877，iframe 里另登记一个音频监听计数：29.9–30.1 帧每秒（间隔中位 32 ms、最大 51 ms），每帧 128 个、无 NaN。scratchpad 生成的 0.3 振幅测试音：左 1 kHz → 左声道第 35 段 0.98、右声道全 0；左 100 Hz + 右 8 kHz → 左第 12 段、右第 56 段（1.12）；右 100 Hz → 左声道全 0。停止后 0.5 s 降到 0.01 以下、0.83 s 归零，静音时照常 30 帧每秒推 0。WebGL 画布截图：放音乐时方块隆起变亮，停止约 5 s 后是暗的方块波浪（页面按能量 < 0.05 持续 3 s 判空闲）。观感需用户确认 |
| [x] | B2 媒体信息 | Windows dev | 同一张：播放、切歌、暂停 | 歌名 / 歌手 / 封面 / 播放状态 / 进度正确，切歌更新，暂停后进度停住 | 2026-10-31 Claude 实测：自建 SMTC 测试会话（PowerShell WinRT MediaPlayer + DisplayUpdater，进程已结束）。歌名 / 歌手 / 专辑、512×512 PNG 封面与主色、播放状态、按秒外推的进度都对，页面卡片显示「测试曲甲 Phase8 / 测试歌手 A / 0:05/0:15」；切歌后标题、封面、颜色更新；暂停后进度停在 7.106 s 不再变。**未通过**：暂停那一刻先推一条 `position: 0`（开播时的旧读数），恢复那一刻先推 `position: 15`（把暂停时长也外推进去，夹到曲尾），测试播放器随后重推时间轴才更正；只在跳转时更新时间轴的播放器会一直错（推断）。另：每次切歌先推一次空封面，80–150 ms 后才是真封面。2026-11-01 已修复：播放状态切换时不重读时间轴，按旧状态外推出的位置作新基准（单测 `pause_and_resume_keep_the_position`），待复测。2026-11-01 Claude 实测（复测）：自建测试会话：PowerShell WinRT `MediaPlayer` 关掉 `CommandManager`，手动驱动 SMTC，30 s 测试音。每首只在第一次播放时 `UpdateTimelineProperties` 一次，暂停 / 恢复只改 `PlaybackStatus`；暂停中和恢复后读 GSMTC，时间轴一直是 `Position 0`、`LastUpdatedTime` 停在开播时刻，正是 bug 的触发条件。在桌面 12097 的 iframe 里登记监听记录。01:35:16 开播推 0，之后每秒 1.00…5.00；01:35:21.342 暂停，`playback 2` 与 `position 5.120` 同时到达（播放器实际 5.12），暂停 11.5 s 期间没有时间轴推送；01:35:32.839 恢复，推 `playback 1`，位置没变（差 < 0.05）所以不重推，1 s 后 6.120，此后每秒 +1 到 11.123。切歌：属性「测试曲乙」、新封面（主色变蓝）、时间轴 0.017 依次到达。之后又暂停 25 s 再恢复，从 5.06 接着走（6.06…9.06），再暂停推 9.618（实际 9.62）。另跑一轮时桌面 kaguya 在放歌：暂停推 5.08（实际 5.06），随后 Windows 把当前会话切回 kabegame 自己的壁纸会话，恢复播放不再落到测试会话。所以正式复测前先暂停了桌面音乐，测后已恢复。原备注的「切歌先推空封面」与播放器写法有关：手动 SMTC 一次 `Update` 写入封面，没有复现，本轮也没覆盖那种写法 |
| [x] | B3 媒体集成开关 | Windows dev | 设置页关「网页壁纸媒体集成」再打开 | 关：页面收到 `{ enabled: false }`、之后无媒体数据、监视停止；开：恢复并补快照 | 2026-10-31 Claude 实测：点设置页「网页壁纸媒体集成」的开关（后端读回 false / true）。关：页面收到 `{ enabled: false }`，22:40:26.758「媒体会话监视已停止」，之后播放中 6 s 没有任何媒体消息（音频照常）；开：收到 `{ enabled: true }` 后补发 properties / thumbnail / playback / timeline 快照，22:40:33.007「监视已启动」。设置已恢复为开 |
| [x] | B4 切走与重载 | Windows dev | 切到图片壁纸再切回；触发看门狗重载 | 切走后订阅随 frame 销毁释放、采集与监视停止；切回重新订阅；重载后每类只剩一条 | 2026-10-31 Claude 实测：切到图片 12823：22:41:46.127 释放 wallpaper frame（released=2、subscriptions=0），采集与监视都停；切回 12877：22:41:50.378 / .405 订阅 Media、Audio（subscriptions=2），采集与监视启动、回环 48 kHz 8 声道。看门狗：iframe 主线程忙等 50 s，22:45:37 / 47 / 57 三次 ping 未应答后重载，22:45:57.185 释放旧 frame（subscriptions=0），新 iframe 22:46:07 订阅 Media + Audio（subscriptions=2）。新 iframe 晚了 10 s，正好等旧文档忙等结束（推断：同站点 `file:` iframe 落进同一个被占住的渲染进程，真死循环时重载救不回来）。CDP `Debugger.pause` 模拟不了卡死：挂起期间 pong 照样发出 |
| [x] | B5 预览与桌面同时 | Windows dev | 桌面显示音频壁纸时在图库预览同一张；关预览 | 两处都动、只有一个采集线程；关预览后只剩桌面的订阅 | 2026-10-31 Claude 实测：主窗口深链接预览 12877：22:46:45.465 main frame 订阅 Media、Audio（subscriptions=4），日志只有 22:46:07.320 那一次「音频采集已启动」；两处 iframe 收到同样的数据（各约 30 帧每秒、峰值 0.826）。关预览：22:47:31.713 释放 main frame（released=2、subscriptions=2），采集不停 |
| [x] | B6 网页壁纸直接互切 | Windows dev | 网页壁纸之间直接切换 10 次（含从 12097 切走） | 每个新 iframe 都订阅成功，旧 frame 订阅都被释放，每类始终一条 | 2026-10-31 Claude 实测：12877→12097→12100→12097→12098→12877→12099→12100→12098→12097→12877，每次停 6 s（三次从 12097 切走）：10 个新文档都有 Tauri 桥与垫片；12100 / 12098 订阅 Audio、12877 订阅 Media + Audio、12097 / 12099 不订阅；旧 frame 每次都随切换释放，subscriptions 只在 0 / 1 / 2 之间，每类最多一条。12098→12877 时采集先停后启（相隔约 60 ms）。原注：依赖 10172b1b（渲染侧按 browser id 计数） |
| [x] | B7 页面自刷新 | Windows dev | 网页壁纸 iframe 里 `location.reload()` | 订阅不重复；控制台无 `Couldn't find callback` 刷屏 | 2026-10-31 Claude 实测：桌面 12877 iframe 里 `location.reload()`：CEF 给新文档换了 frame id（7-893D… 释放、7-E82A… 订阅），订阅 2 → 0 → 2 不重复；CDP 从刷新前一直收 console，只有页面自己的 THREE 警告，没有 `Couldn't find callback`。因为 frame id 变了，「同一 frame 再订阅替换旧条」这条路径没有走到 |
| [x] | B8 主窗口刷新 | Windows dev | 开着网页壁纸预览刷新主窗口 | 预览订阅被清，新文档重新订阅 | 2026-10-31 Claude 实测：开着 12877 预览对主窗口 `location.reload()`：22:50:13.761 释放旧预览 frame（subscriptions=2），新文档 22:50:16.365 重新订阅 Media + Audio（subscriptions=4） |
| [x] | B9 封面大消息 | Windows dev | 播放带大封面的歌曲，预览与桌面各看一次 | 两处 iframe 都经 `plugin:__TAURI_CHANNEL__\|fetch` 收到 `thumbnail`，顺序不乱 | 2026-10-31 Claude 实测：封面 800×800 噪点 PNG（缩到 512 后 data URL 103 万字符）：预览与桌面 iframe 的 Network 里都有 `plugin:__TAURI_CHANNEL__\|fetch`（1,032,413 字节，`Tauri-Response: ok`）。在 `__TAURI_INTERNALS__.callbacks` 上记原始到达顺序（不包装 invoke）：预览 12 properties → 14 playback → 15 timeline → 13 thumbnail（fetch 晚到），桌面 772 → 774 → 775 → 773，页面回调顺序都是 properties → thumbnail → playback → timeline。原注：子 frame 的 Channel 大消息此前未真机验证 |
| [x] | B10 不处理音频的壁纸 | Windows dev | `12099` Personal Slideshow（`supportsaudioprocessing: false`） | 音频订阅被拒、不起采集线程；媒体订阅照常 | 2026-10-31 Claude 实测：桌面 12099 的页面只在特定属性下才登记音频，iframe 里手动调垫片的 `wallpaperRegisterAudioListener`：订阅请求 `Tauri-Response: error`，`"this wallpaper does not process audio"`，没有音频回调、没有「采集已启动」；再手动登记媒体监听，22:52:34.780 订阅 Media（subscriptions=1）、监视启动，页面收到 status / properties / playback |
| [x] | B11 越权订阅 | Windows dev | 应用页主 frame 调 `wpe_web_media_subscribe`；畅游页调 | 主 frame 报 `only web wallpaper frames can subscribe`；畅游被 ACL 拒绝 | 2026-10-31 Claude 实测：主窗口与壁纸窗口应用页主 frame 调用都报 `only web wallpaper frames can subscribe`；畅游 example.com 的内容页与导航栏都报 `Command wpe_web_media_subscribe not allowed by ACL`。畅游会话已关闭 |
| [ ] | B12 切换输出设备 | Windows dev | 播放中切换系统默认输出设备 | 几秒内恢复频谱 | 2026-10-31 Claude 实测：未测。本机有 nircmd，但它只能按名称选设备；当前三个角色的默认设备都是「扬声器 (HECATE G1500 BAR)」，与 VB-Audio 虚拟声卡的「扬声器」同名，切回时可能选错，无法保证恢复，所以没有切换 |
| [ ] | B13 没有媒体会话 | Windows dev | 关掉所有播放器 | `playback` 为 0、属性与封面清空，页面不报错；不提供时间轴的播放器不推 `timeline` | 2026-10-31 Claude 实测：部分验证。机器上有一个不是我启动的 Chrome「Gallery」（已暂停）会话，做不到「没有任何会话」，`attach(None)` 没走到。等价验证：新起的测试会话还没设属性时成为当前会话，页面收到 `playback 0` 与全空属性；切到无封面会话时推了空封面与默认色；页面 error 事件为 0。从一开始就不给时间轴的测试会话播放 9 s 以上，只收到 properties 与 `playback 1`，没有 timeline |
| [x] | B14 其它样本 | Windows dev | Corsair-O-Tron `12100`、阿洛娜 `12098`；网易云 / Spotify 超大封面 | 可视化跟随音乐；大封面不卡页面 | 2026-10-31 Claude 实测：12100 Corsair-O-Tron：30.2 帧每秒，画布截图静音时无柱、放音乐时左右两组共 64 根柱随频谱起落；12098 阿洛娜：30.2 帧每秒，页面的 `__AronaAudioLevel` 静音 0、音乐中 2404–3985，画面反应细微，需用户确认。网易云 / Spotify 未装，用 3000×3000、5.2 MB JPEG 封面的测试会话模拟：后端缩成 620 KB data URL 经 fetch 取回，期间 12877 页面 1774 帧没有超过 40 ms 的帧间隔 |
| [ ] | B15 频谱调参 | Windows dev | 以样本观感调 `SpectrumTuning`，有条件时与 WPE 同曲对比 | 记录最终常数 | 2026-10-31 Claude 实测：未调参（按要求不改常数）。0.3 振幅正弦：1 kHz → 0.98、8 kHz → 1.12、100 Hz → 0.82。合成音乐（峰值 −7 dBFS）p50 0.20 / p90 0.56 / 最大 0.82；实曲 ray.flac（播放器音量 0.3）p10 0.39 / p50 0.52 / p90 0.65 / 最大 0.84，64 段均值 0.41–0.58 几乎平直，相邻帧平均变化 0.064，没有值超过 0.9。低频分辨率不够：纯 100 Hz 点亮第 7–18 段，低频相邻两段常取同一 FFT 下标、数值相同。建议：实曲动态偏窄，可考虑收窄 `range_db`（如 45）或加慢速自动增益；低频考虑 4096 点 FFT 或起点提到 40–50 Hz；`release` 0.75（约 0.5 s 落到 0.01）需用户与 WPE 同曲对比 |
| [x] | B16 预览时的系统媒体会话 | Windows dev | 预览有声视频并切到下一张有声视频；预览带音乐的网页壁纸；关闭预览 | kabegame 会话标题为当前图片的 `displayName`、缩略图为左上角应用图标；切图后标题更新；关闭后不再显示该图名称 | 2026-11-01 Claude 实测：测试时桌面壁纸 12097（kaguya）在放歌。① 深链接预览 10245「gyaru」（AAC 音轨，自动有声播放）：主窗口 `navigator.mediaSession.metadata` 的 title 为「gyaru」，artwork 为 `http://localhost:1420/src/assets/icon-small.png`；GSMTC 的 kabegame.exe 会话 Title「gyaru」、Playing、时间轴 10.04 s。读出的缩略图是 128×128 PNG，与 `icon-small.png` 逐像素差 ≤ 1。② 右箭头切到 10244「なんでもない1日」，再切到 10243「500フォロワー＆…」：metadata 在 100 ms 内更新，会话标题在点击后约 200 ms 换成新图名，封面不变。10243 视频加载慢，6 s 以上停在 0.00，这段时间会话先是 Paused，又一度退回壁纸窗口会话（Paused、Chromium 默认图标）；出声后回到新标题、Playing。③ 预览 12097（要点页面里的播放键才出声）：会话标题「[16:9] 超かぐや姫 All-in-One」、Playing、时间轴 301.6 s（ray.flac），封面是应用图标；iframe 里 `navigator.mediaSession.metadata` 为 null。④ 关闭视频预览：metadata 为 null，会话在 200 ms 内变成「画廊」（页面标题）、Paused、Chromium 默认图标；关闭网页壁纸预览：会话退回「localhost:1420/index.html?window=wallpaper」、Paused。两种情况都不再显示图名。⑤ kabegame 只有一个系统会话：桌面在放歌时打开有声视频预览，会话换成「gyaru」，看不到桌面壁纸单独的会话；预览不出声时，会话显示为壁纸窗口地址，没有元数据，用 Chromium 默认图标。**另见**：先预览视频、再预览无声的网页壁纸 12877，会话变成「音域回响」、Paused，时间轴停在上一个视频的 9.67 / 10.04，盖过正在放歌的桌面壁纸；12877 页面的媒体卡片因此显示的是它自己（「音域回响 0:09/0:10」）。桌面音乐暂停再播放后，会话回到壁纸窗口。测试期间桌面 kaguya 的音乐被暂停了三次，抓到的两次是页面自己的 `pauseSong`，由按钮 click 处理器调用（有 JS 栈），不是 Chromium 音频焦点，click 来源没查明；之后装上输入捕获观察 3.5 分钟、来回切视频预览，都没有复现 |
| [x] | B17 切走视频预览后释放播放器 | Windows dev | 桌面网页壁纸放歌时，预览有声视频，再切到无声网页壁纸 / 图片，或关闭预览 | 系统媒体会话不再停在旧视频（不出现「暂停、旧视频进度」）；当前会话回到桌面壁纸；B16 不受影响 | 起因：B16 实测时先预览视频再切到无声的 12877，会话变成「音域回响、暂停、9.67 / 10.04」，盖住桌面音乐。只从 DOM 移除的 `<video>` 要等 GC 才销毁播放器，现由 `ImageContent` 的函数 ref 在换源 / 卸载时调 `resetVideoElement`（与 `WallpaperStage` 共用 `utils/videoElement.ts`）。2026-11-01 Claude 实测：先确认主窗口跑的是新代码：预览里 `ImageContent` 实例的 setupState 里有 `setVideoEl`；CDP `Media` 域里，修复后创建的播放器一切走就出现 `kWebMediaPlayerDestroyed`。桌面 12097 在放歌、系统会话是壁纸窗口 Playing 时，并行跑 SMTC 轮询与 Media 记录。① 10245「gyaru」有声播放（会话「gyaru」Playing）后，用 ImageGrid 的 `openPreviewById` 在预览里换到 12877：02:31:12.163 切换，12.176 播放器销毁，12.188 会话回到壁纸窗口 Playing，全程没有出现「音域回响、暂停」；12877 页面的媒体卡片显示「localhost:1420/index.html?window=wallpaper 0:20/4:31」。另在原筛选（壁纸导入）下从 x-wpe/video 12093「精灵公主-星雨」（有音轨）点「上一张」切到无声网页壁纸 12094：02:28:12.064 切换，.110 销毁，.137 会话回到壁纸窗口 Playing。② 10243 有声播放后点「下一张」到静态图 10242：02:32:17.398 切换，.435 销毁，.589 会话回到壁纸窗口 Playing；metadata 虽然换成了该图名，会话没有采用。③ 关闭预览：10245 在 02:33:18.818 关闭，.833 销毁，19.033 回到壁纸窗口 Playing；12093 在 02:29:59.829 关闭，.853 销毁，.933 回到壁纸窗口 Playing。④ B16 回归：10245 → 10244 → 10243 依次切换，会话标题依次是三张的图名、Playing，三次读出的缩略图与 `icon-small.png` 逐像素差都 ≤ 1。视频之间切换时旧播放器先销毁，新视频出声前会话会短暂（约 200 ms）退回壁纸窗口（02:34:39.449 → .652、52.658 → .861）。⑤ 残留 `<video>`：DOM 里只剩当前预览的那一个（网页壁纸预览时是 `WallpaperStage` 的两个无 src 元素），另有随网格显示的悬停缩略视频；修复后创建的播放器（预览与网格缩略）离开时都有销毁事件。修复前（01:39–01:43，旧代码）创建的播放器到 02:36 仍有 6 个没有销毁事件，其中包括 B16 时预览 10243 的有声播放器（暂停中），要刷新主窗口才会清掉 |

## 窗口原生标题

主窗口与 Web 标签页按「[预览图片名] - [页面主体名] - 页面名 - Kabegame」显示，空段省略；畅游与爬虫窗口分别使用页面标题与对应上下文，切换语言后重算已打开窗口。真机项的取证方式：经 CDP 在主窗口调用 `invoke("plugin:window|title", { label })` 读各窗口原生标题，与 CDP 读到的 `document.title` 对照；另用 `osascript` 读 kabegame 进程的窗口名交叉核对一致。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 类型与编译检查 | macOS / standard | `bash .claude/skills/check-kabegame/driver.sh`（`deno task check -c kabegame`） | vue-tsc 与 cargo check 0 error | 2026-11-01：退出码 0；vue-tsc 0 error、cargo 0 error，36s。日志 `.kabegame/debug/check/check-20261101-001803.log` |
| [x] | S2 标题拼接单测 | macOS / standard | `bash .claude/skills/test-kabegame/driver.sh kabegame --lib window_title` | 页面标题裁剪、畅游空标题回退 host、爬虫空标题省略与空插件名回退 WebView 均通过 | 2026-11-01：`2 passed; 0 failed`，退出码 0，23s。日志 `.kabegame/debug/test/test-20261101-001914.log` |
| [x] | S3 runtime 单测 | macOS / standard | `bash .claude/skills/test-kabegame/driver.sh kabegame -p tauri-runtime-cef --lib --no-fail-fast -- --skip http_server::tests::media_routes_only_accept_wildcard_path_form` | 现有 runtime 单测通过 | 2026-11-01：runtime `37 passed; 0 failed`；应用 `59 passed; 0 failed; 1 filtered out`，退出码 0。首次未过滤时应用 HTTP 测试因 `bind test listener: PermissionDenied / Operation not permitted` 失败（退出码 101），尚未执行到 runtime；仅跳过该沙箱端口绑定项后重跑通过。日志 `.kabegame/debug/test/test-20261101-002001.log`、`test-20261101-002026.log` |
| [x] | S4 改动文件格式 | macOS | 对改动 Rust 文件逐个 `rustfmt --edition 2021 --config skip_children=true <file>`；改动前端文件用 Prettier | 格式检查通过，无无关大面积改动 | 2026-11-01：6 个 Rust 文件格式化成功，仅 lib.rs 模块声明按序移动；cef-rs 宏内部已手工按周围风格排版。Prettier 经 `node node_modules/prettier/bin/prettier.cjs --write …` 成功（npx 入口权限不足）；随后 `--check` 通过，`git diff --check` 通过 |
| [x] | D1 画廊预览 | macOS dev | 画廊不预览、打开预览、方向键切图、关闭预览 | 画廊 - Kabegame；预览为图片名 - 画廊 - Kabegame，切图与关闭立即更新 | 2026-11-01 经 CDP 实测（取证见本节说明）：不预览 `画廊 - Kabegame`；双击打开 8975 → `ee8977403a8c67b527367ce43c76b568.jpg - 画廊 - Kabegame`；→ 键三次依次为 `e355c0fc4d9313bcdbbd559438ca1f6a(1).png` / `e355c0fc4d9313bcdbbd559438ca1f6a.png` / `088e8c98234096773c1880177c4b7c63.jpg` 开头，← 键回退，Esc 后回 `画廊 - Kabegame`；深链接 `/gallery?pvwimgid=8741` 直接得 `The Witch's Shop Is Open! - 画廊 - Kabegame`。每一步 `main` 原生标题与 `document.title` 逐字相同 |
| [x] | D2 画册与隐藏画册 | macOS dev | 选中画册、打开预览、改画册名，再进入隐藏画册 | 画册名 - 画册 - Kabegame；预览为图片名 - 画册名 - 画册 - Kabegame；改名与隐藏画册名称同步 | 2026-11-01 实测：新建测试画册「KB标题测试」并加入 3 张已有图片，选中 → `KB标题测试 - 画册 - Kabegame`；画册内预览 → `ee8977403a8c67b527367ce43c76b568.jpg - KB标题测试 - 画册 - Kabegame`，→ 键切图同步，Esc 回到画册名；`rename_album` 改名为「KB标题测试改名」后 1.5s 内标题与面包屑同步；隐藏画册 `隐藏画册 - 画册 - Kabegame`、收藏 `收藏 - 画册 - Kabegame`。测试画册已删除（图片未删），画册选中记忆还原为收藏 |
| [x] | D3 其它页面 | macOS dev | 进入任务详情、畅游图片、插件详情、设置、源、运行配置；在任务详情与畅游图片打开预览 | 详情包含任务名 / 站点名 / 插件名；预览叠加图片名；其它页面仅页面名 - Kabegame | 2026-11-01 实测：任务详情（aibooru 任务）`AIBooru AI 图库 - 任务详情 - Kabegame`，预览叠加为 `e355c0fc4d9313bcdbbd559438ca1f6a(1).png - AIBooru AI 图库 - 任务详情 - Kabegame`；畅游图片 `wallhaven.cc - 畅游图片 - Kabegame`，预览叠加为 `Wallpaper Search: nature - wallhaven.cc / zxqkdy.jpg - wallhaven.cc - 畅游图片 - Kabegame`；插件详情 `AIBooru AI 图库 - 源详情 - Kabegame`；源 `源 - Kabegame`、运行配置 `运行配置 - Kabegame`、畅游 `畅游 - Kabegame`、`/settings` 路由 `设置 - Kabegame`。桌面侧栏的设置弹窗不是路由，未单独测（弹窗不改路由，标题保持当前页） |
| [x] | D4 语言切换 | macOS dev | 同时打开主窗口、畅游与爬虫窗口，zh → en → zh | 主窗口页面名即时更新；已打开外部窗口的畅游段与本地化插件名随语言变化；缺失插件名始终 WebView | 2026-11-01 实测：主窗口、畅游 `surf-example_com`、爬虫 `crawler-<id>` 同时打开，按设置页同一路径调用 `set_language`：en 下主窗口 `Gallery - Kabegame`（`document.title` 同步）、畅游 `Example Domain - Surf - Kabegame`、爬虫中间段 `X (Twitter) media (WebView)`；切回 zh 三处都恢复（`画廊` / `畅游` / `X（Twitter）媒体（WebView）`），之后爬虫页再改标题仍带当前语言插件名。原语言 zh 已保持。壁纸窗口在 en 下仍是 `Kabegame 壁纸`（壁纸窗口标题原本就不随语言刷新，不在本次范围）。缺失插件名回退 WebView 由单测覆盖，真机未构造 |
| [x] | D5 畅游页面标题 | macOS dev | 打开站点、整页导航、控制台执行 `document.title = "x"`，访问无 title 页面 | 页面标题 - 畅游 - Kabegame；SPA 改标题同步；空标题回退 host | 2026-11-01 实测（`surf_start_session` 打开 https://example.com/，按 webview label 定位内容页）：加载后 `Example Domain - 畅游 - Kabegame`（页面 100ms 内已加载完，没截到初始的 `example.com - 畅游 - Kabegame`）；`document.title = "x"` → `x - 畅游 - Kabegame`，再改 `SPA 标题 2` 同步；置空 → `example.com - 畅游 - Kabegame`。导航到没有 `<title>` 的页面：CEF 上报的不是空串，而是 Chromium 格式化后的 URL（去协议），https://httpbin.org/html → `httpbin.org/html - 畅游 - Kabegame`、https://www.google.com/robots.txt → `google.com/robots.txt - 畅游 - Kabegame`（页面 `document.title` 均为空串），因此回退 host 只在页面显式置空等 CEF 给出空串时才会出现；与 host 回退相比 URL 更具体，判定可接受。导航回 example.com 恢复 `Example Domain - 畅游 - Kabegame` |
| [x] | D6 弹窗与 DevTools | macOS dev | 畅游内打开 OAuth `window.open` 弹窗与 DevTools | 弹窗和 DevTools 的标题不覆盖 opener 原生标题 | 2026-11-01 实测：内容页（带用户手势）`window.open("https://example.org/", "p", "width=400,height=400")` 生成真实弹窗（`opener` 为 true，不是 Tauri 窗口），弹窗把自己标题改成 `POPUP 改标题` 后畅游窗口仍为 `Example Domain - 畅游 - Kabegame`，关闭弹窗后不变；`surf_open_devtools` 打开 DevTools（目标标题 `DevTools - example.com/`），畅游标题不变，此时内容页改标题仍正常同步。`osascript` 看到 DevTools 窗口原生标题为空，其余三个窗口与 IPC 读数一致 |
| [x] | D7 爬虫 WebView | macOS dev | WebView 插件任务点击「打开任务 WebView」 | 页面标题 - 插件显示名 - Kabegame；无插件显示名时中间段为 WebView | 2026-11-01 实测：x-webview 插件 dry-run 任务（artist / karokaro6665），`crawler-<task_id>` 建窗即 `X（Twitter）媒体（WebView） - Kabegame`，加载后 `Xユーザーのミント推し！ AI Artさん: 「https://t.co/PSIf3Mnscj」 / X - X（Twitter）媒体（WebView） - Kabegame`（与页面 `document.title` 一致）；`show_crawler_window` 显示后不变；页面改标题 `crawler 改标题 - X（Twitter）媒体（WebView） - Kabegame`。测试任务已取消并删除。无插件显示名回退 WebView 由单测覆盖 |
| [x] | D8 壁纸窗口 | macOS dev | 打开壁纸窗口并切换主窗口页面与预览 | 未注册文档标题回调的壁纸窗口原生标题不受影响 | 2026-11-01 实测：`wallpaper` 原生标题在主窗口切到画册、画廊预览（`ee8977403a8c67b527367ce43c76b568.jpg - 画廊 - Kabegame`）、关闭预览以及 D4 语言切换前后始终为 `Kabegame 壁纸` |
| [x] | D9 预览中图片改名 | macOS dev | 预览一张图时经 MCP `rename_image` 改显示名、改成空串、改回；再改另一张不在预览的图 | 标题随显示名即时变化，空名回退文件名，改别的图不影响 | 2026-11-01 实测（临时开启 Web 服务器，curl 调 MCP，测完关闭；两张图名称已改回）：预览 8741 `The Witch's Shop Is Open! - 画廊 - Kabegame` → 改名 `KB改名测试 - 画廊 - Kabegame` → 空名 `The Witch's Shop Is Open!.png - 画廊 - Kabegame` → 改回原样；改 8976 时标题不变。每步 `document.title` 与 `plugin:window\|title` 一致。应用界面暂无图片改名入口，MCP 是唯一写入方，经 `image-changed` 补丁替换预览对象 |
| [ ] | W1 Web 标签页 | Web dev / demo | 切换页面、预览图片、切换语言 | 标签页与主窗口使用相同标题格式，动态内容与语言同步 | 2026-11-01 未测：本机 dev 已占用 1420，不另起 Web dev。Web 与桌面主窗口共用同一套前端写 `document.title` 的代码（`useWindowTitleSync`），D1–D4 已验证 `document.title` 本身的取值 |

## 第三方补丁编号改为两位

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 补丁序列预检 | Windows | 运行 `deno task patch --all --check` | 除手动管理的 `rusty_v8` 外，所有补丁序列按两位编号顺序应用通过；真实 `third/` 工作树不变 | 2026-10-31：7/7 仓库通过，`rusty_v8` 按约定跳过 |
| [x] | `--from` 两位编号 | Windows | 运行补丁管理器的 `resolveGenBase` 对 `05` 和旧格式 `0005` 的解析 | `05` 定位第 5 个补丁；旧四位编号不再作为编号别名 | 2026-10-31：CEF 列出 7 个两位编号补丁，`05` 返回前 5 个，`0005` 被拒绝 |

## CEF runtime crate 更名

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Cargo 依赖与入口 | Windows | 检查 `tauri-runtime-kbcef` 的 Cargo 元数据并运行 Kabegame Rust 检查 | workspace、desktop target 依赖与 Rust 引用均解析到新 crate | 2026-10-31：`cargo metadata --offline --no-deps` 找到新 crate；`deno task check -c kabegame --skip vue` 通过，实际检查了 `tauri-runtime-kbcef` 与 `kabegame` |
| [ ] | 桌面运行 | Windows | 启动主应用，打开主界面、壁纸与畅游窗口 | CEF runtime 与 helper 正常加载 | 需启动应用真机验证 |

## CEF 补丁 07：文档 URL 随子资源工厂下发 + IPC 链路拉直

CEF 的 `frame.url()` 在导航完成前可能为空或过期，导致网页壁纸的首批 IPC 与 `file:` 请求归属错误。07 在建 URLLoaderFactory 时捕获文档与父文档 URL，运行时据此计算 IPC `Origin` 并裁决文件访问；worker 的 `file:` 工厂失败关闭。需重新编译 CEF；旧 CEF 下网页壁纸 iframe 导航被拒，8 秒后退回作者预览图，主窗口 IPC 仍可用。静态检查与真机项留待主会话执行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | P1 补丁序列 | Windows 沙箱外 | `deno task patch cef --gen --from 06 --out third-patches/cef/07-document-url-headers.patch`，再 `--check`、reset/apply 复现 | 07 可复现 | 2026-10-31：`--gen --from 06` 生成 07（3 个文件，+104 / −3）；生成前确认 `third/cef` 相对 01–06 无剩余改动；`deno task patch cef --check` OK dry-run。未做 reset/apply 复现（会 reset 子模块，`--check` 已在一次性 worktree 里链式预检） |
| [ ] | P2 重编 CEF | Windows MSYS2 | `CEFBUILD=/d/Codes/cefbuild deno task build:chromium`；记录 build.log 耗时与真实变更清单 | 仅 07 的三个 CEF 文件进入真实变更 | 2026-10-31：用户已重编并运行，新构建带 07（真机 D 项里文档头生效）；build.log 耗时与真实变更清单未核对 |
| [x] | S1 runtime 单测 | Windows | `driver.sh kabegame -p tauri-runtime-kbcef --lib` | 点 2/4/5 单测通过 | 2026-10-31（`CARGO_TARGET_DIR=target-check`，`--no-fail-fast`）：runtime 36 passed |
| [x] | S2 应用单测 | Windows | `driver.sh kabegame --lib wpe_web` | CallerOrigin 与 ACL 模式通过 | 2026-10-31：同一轮 `kabegame` lib 58 passed / 1 failed，失败的 `http_server::tests::media_routes_only_accept_wildcard_path_form` 是本机 `HTTP_PROXY` 让 reqwest 走了代理，设 `NO_PROXY=127.0.0.1,localhost` 后单独重跑通过，与本次无关；`kabegame-core --lib wpe` 30 passed |
| [x] | S3 check 与格式 | Windows / macOS | `check-kabegame`、改动文件 rustfmt/Prettier | 0 error | 2026-10-31：vue-tsc 0 error、cargo 0 error，改动的 runtime 文件无新 warning；Prettier 通过；rustfmt 差异数 `protocol.rs` 2（合并前 HEAD 5 / origin 3）、`ipc.rs` 0，其余改动文件 0。cef-rs 的 `wrap_*!` 宏内不经 rustfmt，已手工按周围风格排版（宏内不能写 `///` 文档注释） |
| [x] | D1 首批请求 | Windows 新 CEF | 网页壁纸互切、与普通图片互切各 ≥10 次，预览也切换；debug ingest 按 ts 对照首次 IPC | 首次 Origin 即完整入口、pull 成功、无 `[kb-wpe]` 警告 | 取代 W11 / Phase 7 用例 12 的方法。2026-10-31 Claude 经 CDP 实测（`Target.setAutoAttach` + `waitForDebuggerOnStart`，新 iframe 启动即暂停，先开 Runtime / Log / Network 再放行，按文档记录 console 与 `ipc://` 请求和响应体）：桌面网页壁纸互切 11 次、与 12823 互切 12 次；预览方向键在网页壁纸间切 10 次、与 12823 交替重开 12 次。凡垫片运行了的文档（桌面 14/17、预览 16/17，另有 5 秒间隔专项 30 余个），首个 `ipc://` 请求就是 `plugin:event\|listen` 且 `Tauri-Response: ok`，首次 `wpe_web_pull_state` 即成功、`imageId` 等于目标，console 无 `[kb-wpe]` 警告；`// DEBUG-0007` 插桩（已删）显示首个请求 `patched=true`、document 与 Origin 都是完整入口 URL。**修复前未通过**：网页壁纸之间直接切换时，新 iframe 偶发整份文档没有 Tauri 桥（`__TAURI_INTERNALS__` 未定义、`__kbWpeShim` 不存在、一条 IPC 都没有），桌面随后 3 次 ping 未应答、看门狗整页重载（19:24:50、19:32:08）。从 12097（kaguya）直接切走必现（5 秒、20 秒停留都复现），其后几次切换可能连续失败；中间隔一张图片则正常；预览 1/17（12098→12099）。原因：CEF 渲染侧按 WebView 建浏览器对象（`render_manager.cc` 的 `browsers_` 以 `web_view` 为键），同一 browser id 在一个进程里可同时有两个；运行时脚本表（`subprocess.rs` 的 `scripts_by_browser`）只按 id 增删，旧 WebView 卸载慢、晚于新的销毁时把条目删掉，之后该进程新建的 frame 都不注入（交叠顺序为推断，未直接观测）。日志无 `CEF patch 07 missing`。2026-10-31 修复后复测（W13，新 helper 20:42 编译、app 20:43 启动）：桌面从 12097 直接切到 12094 / 12096 / 12099 / 12100 / 12098 共 10 次（停 8s）、其余网页壁纸之间互切 10 次（停 5s）、12097 停 20s 后直切 2 次，34 个新文档都有 Tauri 桥与垫片；预览方向键在 12094–12100 的网页壁纸之间切 18 次同样全部正常；20:45–20:55 日志无 WARN / ERROR（无 ping 未应答、无看门狗重载） |
| [x] | D2 属性与语言 | Windows 新 CEF | 预览与桌面显示作者属性并切语言 | 两处属性与语言同步 | 取代 W1。2026-10-31 Claude 经 CDP 实测：桌面 12100（label `wallpaper`）、预览 12096（label `main`）各自 `wpe_web_pull_state` 拿到本张 `imageId` 与作者属性（12 个 / 2 个键）；包装页面 `wallpaperPropertyListener` 后 `set_language en`，两处都收到 `applyGeneralProperties({ language: "en-us" })`，改回 `zh` 都收到 `zh-chs`；语言已恢复 zh |
| [x] | D3 闸门首批请求 | Windows 新 CEF | 内联脚本立刻 fetch 同目录、另一壁纸、库外文件 | 仅同目录成功；拒绝日志 `requester Document` | 取代 W7。2026-10-31 Claude 实测：把 796697921 复制到 scratchpad，`index.html` 的 `<head>` 第一个内联脚本立即 fetch 同目录 `data.json`、3677233365 的 `project.json`、`C:/Windows/win.ini`，经 `wpe-import` 导入（12875）后预览并设为桌面。两处都是同目录 200，另两类 `Failed to fetch`；日志 `deny file: … (OutsideRoot; requester Document("…\\wpe-copy\\index.html")) webview 'wallpaper'` / `'main'` 各 2 条。测试记录已删除 |
| [x] | D4 冷启动 | Windows 新 CEF | 当前桌面为 D3 壁纸时重启 | 首次拉属性并读同目录及用户选择目录 | 取代 W8。2026-10-31 Claude 实测：桌面为 12875（目录属性选 scratchpad 的 dirA）时，加 `// DEBUG-0007` 插桩触发 dev 重编并重启（20:00:38 冷启动，目录索引 7 张）。首个 IPC 请求 `plugin:event\|listen` 即 `patched=true`、initiator `file://`、document 与 Origin 为完整入口；内联脚本同目录 200；dirA 的 3 个请求按 `requester Document` 放行，页面显示 dirA 的 a3 / a2；console 回放无 `[kb-wpe]` 警告。删除插桩时的第二次重启同样正常 |
| [x] | D5 文件 / 目录属性 | Windows 新 CEF | 选目录、换目录、跨壁纸读取 | 新目录立即可读，旧目录与另一壁纸不可读 | 取代 W10。2026-10-31 Claude 实测（scratchpad 副本目录 / 文件）：12099 `customdirectory` 选 dirA 后桌面文档读 dirA 200、dirB 被拒，12875 读 dirA 被拒；换 dirB 后同一文档 dirA 立即被拒、dirB 200，12875 读不到 dirB；新文档启动时注入的最早 fetch 就能读 dirB、读不到 dirA。12097 `custom_user_bg` 选 bgA 后预览文档能读、bgB 被拒，12099 读不到；换 bgB 后同一文档 bgA 立即被拒。属性已恢复原值 |
| [x] | D6 cef-ipc 回退 | Windows 新 CEF | iframe 强制主通道失败再 pull / `get_plugins` | pull 正确，越权命令被 ACL 拒绝 | 2026-10-31 Claude 经 CDP 实测：桌面 12100（label `wallpaper`）与预览 12096（label `main`）iframe 里临时覆盖 `window.fetch` 让 `ipc://` 失败，之后请求都走 `cef-ipc://localhost/`（204）；`wpe_web_pull_state` 拿到本张 `imageId`，`get_plugins` 报 `not allowed by ACL`，listen `images-added` 被作用域拒绝。测完切走重置文档 |
| [x] | D7 opaque 来源 | Windows 新 CEF | sandbox iframe 与 CSP sandbox 强制两条通道 | 主通道 500；回退占位来源并 reject | 取代旧项 5 的 400 预期。2026-10-31 Claude 经 CDP 实测：畅游 example.com 里 `sandbox="allow-scripts"` 的 srcdoc iframe（OOPIF，`self.origin` 为 `null`，有 Tauri 桥）：主通道 `ipc://` 回 500、invoke 2ms 内 reject（`Origin header is not a valid URL`）；强制回退后 `cef-ipc` 204，`get_webview_i18n` / `surf_report_url` 报 `not allowed by ACL`，2ms 内 reject、不挂起。CSP sandbox 顶层页（httpbin `response-headers?Content-Security-Policy=sandbox allow-scripts`）结果相同。会话已关闭 |
| [x] | D8 全窗口 IPC | Windows 新 CEF | 主窗口 raw body / Channel / listen；畅游下载；WebView 插件；壁纸握手与 ping | 均正常，无 unattributed scheme factory 日志 | macOS / Linux 子集见 M。2026-10-31 Windows 实测：主窗口普通命令、`Uint8Array` 参数（`application/octet-stream`）、listen / unlisten `images-added` 正常；`start_app_log_stream` Channel 收到 8 批，其中 7 批超过 8192 字节、经 `plugin:__TAURI_CHANNEL__\|fetch` 取数（9101–11403 字节）。畅游 example.com 页面 `surf_download_image` 入库成功（测试图已删），`read_plugin_file` 仍被 ACL 拒绝。x-webview dry-run 的爬虫页 `crawl_get_page_label` 成功、`get_plugins` 被拒。壁纸窗口应用页显示图片时逐次应答 pong（seq 266–268）、命令正常，看门狗重载与冷启动后都打出「壁纸窗口已就绪」。全程日志只有 D9 的 2 条 `unattributed ipc request reached the scheme factory` |
| [x] | D9 未归属 IPC | Windows 新 CEF | 下载链接与 iframe 导航到 `ipc:` | 不执行命令 | 2026-10-31 Claude 经 CDP 实测（畅游 example.com）：`iframe.src = "ipc://localhost/get_plugins"` 与 `<a download href="ipc://localhost/get_plugins">`（跨源，Chromium 按顶层导航处理）都只得到 405 文档、命令未执行；日志各一条 `unattributed ipc request reached the scheme factory`（19:46:29、19:46:30） |
| [ ] | D10 旧 CEF | Windows 旧构建（可选） | 加载网页壁纸 iframe | 被拒并退预览图，一次 07 missing warn | 需保留旧构建。2026-10-31 未测：本机只有带 07 的新 CEF 构建，跳过 |
| [x] | D11 worker `file:` | Windows 新 CEF | worker fetch 同目录和库外文件 | 都失败 | 2026-10-31 Claude 实测（D3 的测试壁纸，预览、桌面、冷启动各一次）：`new Worker("w.js")` 能启动（脚本加载成功），worker 里 fetch 同目录 `data.json` 与 `C:/Windows/win.ini` 都 `Failed to fetch`；blob worker 同样两者都失败。日志对应 `requester Deny`（worker 没有归属文档）。补丁前行为未测（本机已无旧构建） |
| [x] | D12 IPC handler 放行 | Windows 新 CEF | 主窗口与网页壁纸 iframe 调 invoke | 主通道不出现 `Failed to fetch`、不回落 postMessage | 2026-10-31：首轮重编后两条通道都 `Failed to fetch`：cef-rs 的 `on_before_resource_load` 默认返回 `ReturnValue::default()` 即 `RV_CANCEL`（不是 C++ 的 `RV_CONTINUE`），`IpcResourceRequestHandler` 没实现它，每个 IPC 请求都被取消。显式返回 `CONTINUE` 后主窗口 `get_language` → `ok "zh"`，D1–D9 期间无回落 |
| [x] | D13 带代理的终端里 CDP 登记 | Windows dev，终端设 `HTTP_PROXY` | 启动 dev 后 `driver.sh port` | 登记成功、skill 能发现端口 | 2026-10-31：修复前日志 `failed to publish CDP port … never became ready`（探测 `/json/version` 与登记都被代理带走）；`debug_ingest.rs` 的 ingest 与登记两个 reqwest 客户端加 `.no_proxy()` 后 19:03:59 登记成功 |
| [ ] | M 平台冒烟 | macOS / Linux | D8 子集与 B7 `file:///etc/hosts` iframe | IPC 正常；B7 拒绝日志 `requester Deny` | Android / Web 不链接 CEF |

## CEF 运行时：IPC 来源按发起方 origin 判定

**历史回归说明**：项 1 / 2 测的是主 frame 整窗导航；iframe 形态见 07 节 D1 / D6。项 5 的 400 预期由 D7 取代，原勾选记录保留。

2026-10-31：Phase 7 真机回归发现，桌面壁纸窗口导航进网页壁纸后，垫片最早的 listen / pull 常拿到 `Origin: null` 被拒（17 次导航 12 次）。调查（只读，Chromium 149.0.7827.201 源码 + CEF #4034）：CEF 的 `frame.url()` 是 UI 线程缓存，到 `DidFinishNavigation` 才刷新，IO 线程上主 frame 的请求每次换成浏览器当前的主 frame（`MaybeChangeMainFrame`）；Chromium 不保证提交回执先于新文档的子资源请求到达。旧的 `pin_file_frame_origin` 据此读到空串或旧地址就不改写；同一竞态下 `cef-ipc` 回退退到 webview 初始 URL（应用页），`file:` 页面会被判成本地来源、拿到 `main-capability`。修复：`ipc` / `cef-ipc` 请求改用 `GetResourceRequestHandler` 的 factory 级 `request_initiator`（浏览器提交导航时按文档算好）写内部头，协议层覆写 `Origin`；`cef-ipc` 不合法 `Origin` 即拒。改动都在主程序（浏览器进程），dev 自动重编即可，不用重编 helper。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 runtime 单测 | Windows 本地 | `driver.sh kabegame -p tauri-runtime-kbcef --lib`（`CARGO_TARGET_DIR=target-check`） | 全部通过 | 2026-10-31：77 passed（新增 `ipc_urls_are_recognized`、`initiator_maps_to_ipc_origin`、`initiator_header_overrides_origin`、`invalid_origin_is_rejected_without_fallback`、`file_document_origin_is_remote_file`） |
| [x] | S2 ACL 匹配 `file:///` | Windows 本地 | `driver.sh kabegame --lib wpe_web` | `file:///*` 匹配 `file:///` 与 `file://localhost/` | 2026-10-31：2 passed |
| [x] | S3 完整 check | Windows 本地 | `check-kabegame`（`CARGO_TARGET_DIR=target-check`） | 0 error | 2026-10-31：vue-tsc 0 error、cargo 0 error |
| [x] | 1 桌面导航后订阅 | Windows CEF dev | 经 `set_wallpaper_by_image_id` 在网页壁纸之间、普通图片与网页壁纸之间各切 10 次以上，回放每个新文档的 console | 每次都没有 `[kb-wpe] listen` / `pull` 警告；之后改属性、切语言桌面都跟随 | 2026-10-31 Claude 经 CDP 实测：15 次导航（12099 / 12100 / 12097 / 12096 / 12094 / 12098 网页壁纸互切 7 次、与普通图片 12823 互切 8 次，探针 `ini-nav.mjs`）每个新文档回放 console 与网络日志，`[kb-wpe]` 警告与 IPC 500 都是 0 条（对照：页面里手写一条 `[kb-wpe]` 警告和一次必失败的 `ipc://` POST，回放都能抓到）；之后在桌面 kaguya 把 `playback_rate` 写成 1.3，落库 1.25、桌面页面 250ms 内 `playbackRate` 跟到 1.25，恢复后回到 1 |
| [x] | 2 壁纸页权限 | 同上 | 桌面网页壁纸页里调 `wpe_web_pull_state` 与 `get_plugins`；再临时让 `fetch(ipc://…)` 失败迫使 Tauri 改走 `cef-ipc`，重复一次 | 两条通道都是 pull 成功、`get_plugins` 被 ACL 拒绝 | 2026-10-31 Claude 经 CDP 实测：桌面 kaguya 页面：主通道 `wpe_web_pull_state` 成功，`get_plugins` / `get_settings` 被 ACL 拒绝；临时让页面 `fetch(ipc://…)` 失败后，请求确实改走 `cef-ipc://`，结果相同（pull 成功、两条应用命令被拒）。测完切走再切回，重置该文档 |
| [x] | 3 应用页照旧 | 同上 | 主窗口操作若干命令；桌面从网页壁纸切回普通图片后看壁纸窗口应用页握手 | 本地命令正常；切回后壁纸窗口正常显示，没有 ACL 拒绝 | 2026-10-31 Claude 经 CDP 实测：壁纸切到 12823 后，壁纸窗口应用页 `get_current_wallpaper_image_id` 成功、`get_settings` 只报缺参数（已过 ACL；对照网页壁纸页在 ACL 就被拒），console 无 ACL / Origin 日志；主窗口命令全程正常；畅游导航栏页强制回退 `cef-ipc` 后同样成功（204） |
| [x] | 4 畅游 | 同上 | example.com、x.com 畅游页：地址上报、右键下载、一键下载；页面插 `no-referrer` 后再调 | 都正常；`read_plugin_file` 等应用命令仍被 ACL 拒绝 | 2026-10-31 Claude 经 CDP 实测：example.com：启动期 `surf_collect_attach` / `surf_report_url` / `get_webview_i18n` 各一次、都是 200，`read_plugin_file` 被 ACL 拒绝，插 `no-referrer` 后与 raw body（octet-stream）invoke 正常；x.com 开着 DevTools：右键配图只出一个菜单，点一次「下载图片」收起并提示「下载成功」。一键下载未单独测（与右键下载同一条页面 IPC 通道） |
| [x] | 5 opaque 来源被拒 | 同上 | 畅游页里建 `sandbox="allow-scripts"` 的 iframe 或用 CSP sandbox 页面发 `cef-ipc` | 回 400，不再借 frame URL 放行 | 行为变化，已与用户确认；2026-10-31 Claude 经 CDP 实测：畅游打开 `https://httpbin.org/response-headers?Content-Security-Policy=sandbox%20allow-scripts`（顶层主 frame 沙箱，`self.origin` 为 `null`，Tauri 脚本仍注入）：主通道 invoke 回 500「Origin header is not a valid URL」，强制回退后 `cef-ipc` 回 400、invoke 无回调；修复前会借 frame URL 按远程 httpbin 来源放行 |
## frame 级 IPC（tauri 补丁 18–19）+ 网页壁纸统一成 iframe

2026-10-31：frame 成为 IPC 的基本单位。18：子 frame 请求在 `IpcFrame::Sub` 旁带不透明的 `SubframeId`（CEF frame identifier，请求 extension），Tauri 的 JS 监听表按「webview → frame → 事件」存储，监听登记、事件投递、Channel 消息与 `cef-ipc` 回退响应都 eval 进发起调用的 frame（runtime 新增 `eval_script_in_subframe`），`Unknown` 与无 id 的 `Sub` 无法 listen；Channel 大数据队列条目绑定 frame，`plugin:__TAURI_CHANNEL__|fetch` 只交给该 frame；runtime 报 `SubframeDestroyed` 时清该 frame 的监听与未取数据；关闭拦截只看主 frame；新增 `tauri::ipc::CallerOrigin`。19：Tauri 把四段桥脚本另交给 runtime（`subframe_bridge_scripts`），CEF 渲染进程无条件先注入每个子 frame，ACL 是唯一闸门。CEF runtime：上报 `SubframeId`、`EvalInSubframe`、`FrameHandler::on_frame_destroyed`；回退通道放行所有给出了 frame 的请求，子 frame 拿不到来源时用占位来源交给 ACL 拒绝（不再退到应用页 URL）；`file:` 闸门不再按 label 存根目录，改由应用注册的解析器推出访问范围（`file:` 文档只能访问自己的壁纸目录与用户选择，应用页发起的 iframe 导航只能落进库里某个网页壁纸目录）。应用：网页壁纸一律是 `WallpaperStage` web 层里的 `file:` iframe（预览与桌面同一套，`src` 取目标的 `webEntry`），`wpe-web-capability` 绑定 `main` / `wallpaper`、`frames: "sub"`；垫片只剩直接 invoke / listen 一种传输（首批请求退避重试）；删除 `set_wpe_web_preview`、`get_wpe_web_state`、`wpeWebBridge.ts`、壁纸窗口整窗导航与 `web_wallpaper_dir`，`set_wallpaper_path` 只开关鼠标转发；新增网页壁纸目录索引（`wallpaper/wpe_web_dir_index.rs`，Storage 就绪后先订阅再走 `idx_images_type` 全量建表、随图片事件维护）。

**前置依赖已由 07 节落地**：请求归属改用建工厂时捕获的文档 URL，Windows 真机复测见 D1–D11。网页壁纸只在 Windows 提供，macOS 真机借**临时** capability 在畅游里验证 frame 级机制（验完已删除：`capabilities/zz-temp-b-*.json` 与 handlebars 里的两个 identifier；生成的 `tauri.conf.json` / `gen/schemas` 已复原）。计划里的 `surf-collect-state` 是 `emit_to(<导航栏>)`，到不了内容 webview 的 iframe，改用主窗口 `plugin:event|emit` 广播的测试事件 `kb-subframe-test`；Channel 取数用主窗口的日志流（`start_app_log_stream`）测，畅游页没有能产生大 Channel 消息的命令。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | U1 tauri 单测 | macOS，`third/tauri` | `cargo test -p tauri --lib`、`cargo test -p tauri-utils --lib` | 全部通过，含 frame 投递、退订、销毁清理、无 id / Unknown 不能 listen、Channel 与回退响应按 frame 回送、Channel 取数按 frame 归属、桥脚本即主 frame 桥 | 2026-10-31：tauri 111 passed（新增 `event::listener::test::js_listeners_are_scoped_per_frame`、`event::plugin::tests` 三项、`ipc::channel::tests` 三项、`ipc::protocol::tests` 四项、`manager::webview::tests::subframe_bridge_scripts_are_the_main_frame_bridge`，改 `manager::window::tests`）；tauri-utils 44 passed |
| [x] | U2 补丁序列 | macOS | 开工前 `--gen --from 17` 确认无剩余改动；`--gen` 生成 18 / 19；`deno task patch tauri --check` | 无剩余；OK dry-run | 2026-10-31：开工前「没有剩余改动」；18 15 个文件、19 2 个文件；`tauri: OK dry-run`；生成后再 `--gen --from 19` 无剩余 |
| [x] | U3 runtime + 应用单测 | macOS | `test-kabegame kabegame -p tauri-runtime-kbcef --lib --no-fail-fast` | 全部通过：`SubframeId` extension 与重建保留、跨源子 frame 回退请求放行且记 `Sub`、子 frame 缺来源用占位来源、闸门五种情况与发起方分类、子 frame 先注桥、目录索引祖先查找 / 按 id 删 / 目录不存在不登记 / 放行覆盖 / 键与闸门一致、`caller_document` 只认 `file:` | 2026-10-31：94 passed（kabegame 58 + runtime 36）。首跑发现两处：`Url::to_file_path` 不看 scheme（`tauri://localhost/` → `/`），已在 `wpe_web_pull_state` 先判 `file:`（新增 `caller_document`）；`about:srcdoc` 能装进 `http::Uri`，原占位来源预期改为按远程来源交 ACL。macOS 上 `-c kabegame` 的测试二进制在 `target/debug/deps`，按 `@executable_path/../Frameworks` 找不到 CEF（软链只在 `target/Frameworks`），本机在 gitignore 的 `target/` 里加了 `target/debug/Frameworks -> ../Frameworks` 才能跑；`DYLD_FRAMEWORK_PATH` 传不到测试进程 |
| [x] | U4 core `list_wpe_web_rows` | macOS | `test-kabegame kabegame-core --lib wpe_web_rows` | 只列 `x-wpe/web`；`EXPLAIN QUERY PLAN` 走 `idx_images_type`、不全表扫 | 2026-10-31：2 passed |
| [x] | U5 编译检查 | macOS standard | `check-kabegame`（vue-tsc + cargo check） | 0 error | 2026-10-31：vue-tsc 0、cargo 0。只在 Windows 编译的分支未覆盖，见 W12 |
| [x] | U6 改动文件格式 | macOS | 改过的 Rust 文件逐个 `rustfmt --check --config skip_children=true`；前端与 capability 用 Prettier `--check` | 本次改动不引入新的格式差异 | 2026-10-31：third/tauri 改动文件干净；主仓 HEAD 本就干净的文件全部干净，`ipc.rs` / `protocol.rs` / `commands/wallpaper.rs` 只剩 HEAD 既有差异；`wpe_shim.js` 经 Prettier 写回 |
| [x] | B1 子 frame 有桥、调不动命令 | macOS dev CEF，kabegame-chromium | 主窗口里插 srcdoc iframe，读 `contentWindow.__TAURI_INTERNALS__`，调 `get_wallpaper_volume` | iframe 有自己的桥（label `main`）；调用被 ACL 拒绝；主 frame 同命令放行 | 2026-10-31：`iframeBridgeIsOwn: true`、label `main`，iframe 报 `Command get_wallpaper_volume not allowed by ACL`，主 frame resolved |
| [x] | B2 Channel 取数按 frame 归属 | 同上 | 主 frame 用 Channel 开日志流并刷 480 条长日志；同时 srcdoc iframe 每轮并发猜 id 0–63 调 `plugin:__TAURI_CHANNEL__\|fetch`，共 40 轮 | iframe 一条都取不到；主 frame 正常收到全部批次 | 2026-10-31：主 frame 收到 3 批、全部超过 8192 字节直投阈值（最大 80,941 字节）即都走 fetch 队列；iframe 约 2,560 次猜测 `stolen: []` |
| [x] | B3 跨源 iframe 注入与 ACL | macOS dev，临时 capability（`surf-*`、`frames: "sub"`、`https://example.org/*`、allow-listen `kb-subframe-test` / `surf-collect-state`） | example.com 畅游页里嵌 `https://example.org/`，在 iframe 上下文 listen / invoke | iframe 有 `__TAURI_INTERNALS__` 与 `isTauri`；listen 测试事件成功；listen `images-added` 被作用域拒绝；`surf_report_url` 被拒（`surf-capability` 只认主 frame） | 2026-10-31：全部符合；iframe label `surf-example_com`，拒绝文案分别是 ``event `images-added` is not allowed to be listened by ACL`` 与 `Command surf_report_url not allowed by ACL` |
| [x] | B4 srcdoc iframe 有桥被拒 | 同上 | 同页 srcdoc iframe（继承 example.com 来源）listen 与 invoke | 有桥；全部被拒 | 2026-10-31：`plugin:event\|listen` 与 `surf_report_url` 都 `not allowed by ACL` |
| [x] | B5 事件只投递到对应 frame | 同上（主 frame 另借临时 capability 可听测试事件） | 主窗口广播 `kb-subframe-test` n=1；iframe 猜主 frame 的监听 id 去 unlisten；再广播 n=2 | 主 frame 与 iframe 各收一次，srcdoc 不收；猜 id 退订无效 | 2026-10-31：n=1 后主 frame `[1]`、iframe `[1]`、srcdoc `[]`；iframe 退订 id 44（主 frame 的）调用返回但无效果，n=2 后主 frame `[1,2]`、iframe `[1,2]`。debug ingest 插桩（已删）显示 listen 登记与两次投递都 eval 进 frame `B-D7B3…`、`found: true` |
| [x] | B6 iframe 移除后监听被清 | 同上 | 移除 example.org iframe 后广播 n=3，读 debug ingest | 收到该 frame 的 `subframe_destroyed`；之后没有 eval 进它；主 frame 照收 | 2026-10-31：`subframe_destroyed` `B-D7B3…`（url example.org）；另有一个 url 为空的 `9-D29C…`，是 CEF 跨源加载 iframe 时先建后毁的临时 frame（计划已预期，删除为空操作）；n=3 后无任何 `eval_in_subframe`，主 frame `[1,2,3]` |
| [x] | B7 macOS `file:` 闸门 | macOS dev | 主窗口应用页插 `file:///etc/hosts` iframe；读画廊 `file:` 图片 | iframe 导航被拒（非 Windows 不注册解析器）；画廊媒体照常免检 | 旧版实测日志原为 requester Target；07 终态预期 requester Deny，待 M 项复测。2026-10-31：日志 `deny file: file:///etc/hosts (outside <none>; grants 0; NoRoot; requester Deny) webview 'main'`；画廊 `img[src^=file:]` naturalWidth 512 |
| [x] | M1 主窗口各页 | macOS dev | 依次进入画廊、画册、源、设置、畅游、运行配置，调几个命令与 listen `images-added` | 正常渲染；主窗口特赦与事件不受影响；`get_current_wallpaper_target` 带 `webEntry` 字段 | 2026-10-31：各页路由正常、无错误提示，画廊截图 4185 张图正常加载；命令与 listen 都 ok，`webEntry=null`（macOS）；测试期间 dev 日志无 WARN / ERROR（GPU 进程的 libGLESv2 错误为既有） |
| [x] | M4 畅游两窗口地址栏不串 | macOS dev | example.com / example.org 两窗口各做 2 次导航与 1 次 pushState；分别点两边导航栏的一键下载 | 各自导航栏只随本窗口变化；转圈只出现在对应窗口 | 2026-10-31：地址序列分别为 `/` → `?n=1` → `?n=2` → `/spa-a` 与 `/` → `?m=1` → `?m=2`，无串入；点 org 只有 org 的 `aria-busy` true → false，点 com 反之 |
| [x] | M9 关闭行为 | macOS dev | `plugin:window\|close` 关主窗口后 show；关闭两个畅游会话；运行 WebView 插件后关爬虫窗口 | 主窗口只隐藏；畅游窗口销毁；爬虫窗口只隐藏 | 2026-10-31 macOS：主窗口 `is_visible` true → false、仍在 `get_all_windows`，show 后恢复；`surf_close_session` 后两个畅游窗口从列表消失。测试创建的 example.org 畅游记录已删除，example.com 记录为既有。爬虫窗口部分 2026-10-31 Windows 补测：x-webview dry-run 任务运行中 `show_crawler_window` 后 `is_visible` true，`plugin:window\|close` 后 false、窗口仍在列表、任务仍 running；取消任务后窗口销毁、状态 canceled；测试任务已删除 |
| [x] | W1 预览与桌面拉取属性、改语言（由 D2 取代） | Windows CEF dev（完全重启） | 预览与桌面各显示一张带作者属性的网页壁纸；切换界面语言 | 两处都拉到属性；改语言后两处都更新 | 见 D2（2026-10-31 通过） |
| [ ] | W2 桌面鼠标转发 | Windows | 桌面网页壁纸上移动、左键点击 | 页面收到移动与点击（iframe 接收指针事件） | 2026-10-31 未测：需要真实指针在桌面上移动与点击，自动化不便代做 |
| [x] | W3 来回切换不积累监听 | Windows | 图片 ↔ 网页壁纸来回切 10 次，插桩数 Tauri 侧该 webview 的 JS 监听 | 监听数不增长（iframe 销毁即清） | 2026-10-31 Claude 实测：临时 `// DEBUG-0007` debug ingest 插桩（已删）记录 runtime 的 `EvalInSubframe`（目标 frame 是否存在）与 `on_frame_destroyed`。桌面 12823 ↔ 网页壁纸（12099 / 12100 / 12096 / 12094 / 12098 各两轮）来回 10 次、每步 12s，最后停在 12099 观察 45s：共 11 次文件文档 frame 销毁上报；每次 ping 只 eval 进 1 个存活子 frame（最后 45s 的 3 次 ping 都只进当前 frame），全程 eval 到已销毁 frame 的次数为 0，说明旧 iframe 的监听随销毁清掉、没有积累；每个新文档都应答了 ping，日志无未应答、无重载 |
| [x] | W4 网页卡死重载 | Windows | 网页壁纸页面里写死循环 | 约 30s 后整页重载并恢复（应用页显示 web 层期间不应答 ping） | 2026-10-31 Claude 实测：桌面 12099 iframe 注入 90s 有界忙循环后立即断开 CDP：19:56:38 CEF 报 `renderer unresponsive for webview 'wallpaper', terminating for reload`，随后 19:56:39 / :49 / :59 三次未应答，19:56:59 看门狗整页重载，0.5s 后「壁纸窗口已就绪」，新 iframe 从 seq 320 起逐次应答，重载后无未应答 |
| [x] | W5 `localStorage` 互通 | Windows | 预览里写一个键，桌面读；反向再来一次 | 两处互通（同一顶层分区）；桌面此前在 `file://` 顶层存的数据不会带过来 | 2026-10-31 Claude 经 CDP 实测：预览与桌面同时显示 12099，两处 `self.origin` 都是 `file://`；预览写 `kbW5` 桌面读到，桌面写 `kbW5b` 预览读到；测试键已删除。「桌面此前在 `file://` 顶层存的数据不会带过来」未单独验证 |
| [x] | W6 网页壁纸 listen 越权 | Windows | 网页壁纸 iframe 里 listen `images-added` | 被 ACL 作用域拒绝 | 2026-10-31 Claude 实测：桌面与预览的网页壁纸 iframe（主通道）listen `images-added` 都报 ``event `images-added` is not allowed to be listened by ACL``；D6 的 `cef-ipc` 回退通道结果相同 |
| [x] | W7 闸门（由 D3 取代） | Windows | 壁纸页面 fetch 同目录文件、另一张网页壁纸目录下的文件、库外文件 | 同目录成功；另两类被拒，日志 `deny file:` | 见 D3（2026-10-31 通过） |
| [x] | W8 冷启动即网页壁纸（由 D4 取代） | Windows | 当前桌面是网页壁纸时重启应用 | 第一次加载就拉到属性、读到同目录与用户选的目录 | 见 D4（2026-10-31 通过） |
| [x] | W9 新导入 / 删除 | Windows | 不重启导入一张网页壁纸，预览并设为桌面；删除后再预览 | 导入后直接可用（索引随 `images-added` 更新）；删除后被拒 | 2026-10-31 Claude 实测（只用 scratchpad 副本）：796697921 复制到 scratchpad 并改标题，不重启经 `wpe-import` 导入为 12875，预览与桌面直接可用（`wpe_web_pull_state` 认出 12875、同目录可读）。`remove_image`（只删记录）前，主窗口应用页插入指向副本入口的 iframe 能加载；删除后同一导航被拒：`deny file: …/wpe-copy/index.html (outside <none>; grants 0; NoRoot; requester Target)`，副本目录仍在。注意：对话框只勾「添加文件夹」、Steam 来源全不选时，后端 checkbox 校验报 `sources: 至少选择一项`，任务提交失败（待修）；本次用 `defaultprojects: true`（该来源两张网页壁纸都已入库）加 `extraDirs` 绕过 |
| [x] | W10 文件 / 目录属性（由 D5 取代） | Windows | 选目录后页面读其中文件；换目录；另一张网页壁纸读这张的选择 | 能读；换目录后旧目录的请求**立即**被拒（不必重开预览或切走桌面）；另一张读不到 | 见 D5（2026-10-31 通过） |
| [x] | W11 首批请求（由 D1 取代） | Windows | iframe 形态见 07 节 D1；经 `set_wallpaper_by_image_id` 在网页壁纸之间反复切换，回放新文档 console | 首批 listen / pull 全部成功，闸门判定正确 | 见 D1（2026-10-31 未通过：网页壁纸之间直接切换时偶发新文档没有 Tauri 桥，垫片没运行）；修复后复测通过，见 D1 / W13 |
| [x] | W13 网页壁纸直接互切的桥注入 | Windows CEF dev（重启 dev，helper 只在启动时编译） | 从 12097 直接切到另一张网页壁纸 ×10、网页壁纸之间互切 ×10，预览里方向键在网页壁纸之间切；每个新文档查 `__TAURI_INTERNALS__` 与 `__kbWpeShim` | 每个新文档都有桥、垫片运行，无 ping 未应答、无看门狗重载 | 修 D1 / W11 的失败：`subprocess.rs` 的脚本表改成按 browser id 计数（`ScriptTable`），同一 browser 的最后一个渲染侧对象销毁才删脚本；单测 `scripts_survive_overlapping_browser_objects` 通过。2026-10-31 修复后复测（W13，新 helper 20:42 编译、app 20:43 启动）：桌面从 12097 直接切到 12094 / 12096 / 12099 / 12100 / 12098 共 10 次（停 8s）、其余网页壁纸之间互切 10 次（停 5s）、12097 停 20s 后直切 2 次，34 个新文档都有 Tauri 桥与垫片；预览方向键在 12094–12100 的网页壁纸之间切 18 次同样全部正常；20:45–20:55 日志无 WARN / ERROR（无 ping 未应答、无看门狗重载） |
| [ ] | W12 Windows / Linux 编译 | Windows、Linux | `check-kabegame` | 0 error | 未测：本机 macOS。只在 Windows 编译的新代码：`core_init.rs` 里 `init_wpe_web_dir_index()` 调用、`WallpaperWindow::set_mouse_forwarding` 的 Windows 分支、`manager/window.rs` 里 `allow_file_documents` 登记（既有） |
| [ ] | A1 Android 不变 | Android dev | 冒烟：主界面、畅游 | 行为不变（wry 不上报 frame，`subframe_bridge_scripts` 被忽略） | 未测 |

## `images.type` 规范化与索引（v049）

2026-10-31：新增同步迁移 v049，自包含规则修正历史残留并创建 `idx_images_type`；Rust 写入口始终返回非空小写「主类/子类」，查询直接读列。分类仍以 `video/*` 判定（`x-wpe/video` 归图片），保留 CASE / SUBSTR，使画廊排序分页继续沿 `idx_crawled_at` 读取。数据库不加触发器或 CHECK，遗留默认值不用于生产写入。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 写入口规范化与规则比对 | macOS 单测 | `test-kabegame kabegame-core --lib image_type` | 空值、旧类别、无斜杠、缺主类 / 子类及未知类型均得到合规格式键；格式表外 ASCII 用例与迁移 SQL 一致 | 5 通过 |
| [x] | 历史修正、幂等与索引 | macOS 单测 | `test-kabegame kabegame-core --lib migrations` | v049 修正残留、保留合规别名；重跑不改行；等值查询走 type 索引，分类分页走抓取时间索引 | 50 通过，含 v049 的 2 项 |
| [x] | 实际 DSL 与格式语义 | macOS e2e | `test-kabegame kabegame-core --test dsl_e2e` | 图片 / 视频 / 格式筛选、画册列举不变；生成 SQL 不走 type 索引排序；WPE video 仍归图片 | 60 通过，含新增 2 项；允许既有 id 次排序的 LAST TERM 临时排序；scratch 测试提供 SNAP_DB / PQ_PATH 后 1 通过 |
| [x] | 真实数据库副本升级 | macOS，dev / prod 数据库的 SQLite backup 副本 | 在副本执行 `run_pending`，比较升级前后 PathQL 分类与格式列举、全部 id/type，并检查索引 | dev v48 与 prod v46 均升级至 v49；修正 0 行；所有计数与格式相同，索引存在 | 临时 core 探针执行真实 `run_pending`：dev 5,302 行从 v48、prod 64,151 行从 v46 升至 v49，均修正 0 行，PathQL 分类 / 格式列表及每行 id/type 完全一致；另对旧 / 新 SQL 逐行比对分类结果和格式计数，一致。原库未改动；证据 `.kabegame/debug/type-index/` |
| [ ] | core 全量单测 | macOS | `test-kabegame kabegame-core` | 全部通过 | 413 通过、4 失败：`replace_image_thumbnail_path_deletes_old_independent_thumbnail`、`parses_new_library_folders_format`、`parses_old_library_folders_format`、`relative_paths_reject_traversal_and_absolute`；与本文件「应用日志」已记录的 4 个既有失败一致。cargo 默认在 lib 失败后停止，两个集成 target 已另行执行 |
| [x] | 编译检查 | macOS standard | `check-kabegame --skip vue` | Rust 检查通过 | 0 error；仅有仓库既有 warning |
| [ ] | 画廊过滤面板真机 | macOS dev CEF | 点击图片 / 视频与各格式筛选，查看结果数 | 面板计数与结果一致 | 当前没有运行中的应用，CDP 未发现 |
| [ ] | 下载与本地导入 | macOS dev CEF | 下载一张图并导入本地文件，再检查库中 type | 两条新记录都满足不变量，原有预览正常 | 当前没有运行中的应用，未执行 |
| [ ] | 真机分页 SQL | macOS dev CEF，`KABEGAME_SQL_DEBUG=1` | 打开媒体分类过滤并分页，检查实际 SQL 计划 | 走 `idx_crawled_at`，无 type 索引后的临时排序 | 当前没有运行中的应用；单测覆盖执行计划 |

## 事件监听权限 + 特赦 webview + ACL 的 frame 维度（tauri 补丁 14–17）

2026-10-31：四个 tauri 补丁让事件与 ACL 只看后端知道的调用方身份。14：JS 事件按接收方 webview 身份投递（webview label、所在窗口 label，同名时再加 WebviewWindow），`listen` 不再读取前端传的 `target`，`emit_to(App)` 不再送给 JS，`unlisten` 只在调用方 webview 的表里删除，窗口关闭拦截看本窗口任一 webview；15：`core:event:allow-listen` 支持 `{ "event": … }` 作用域（末尾 `*` 前缀匹配，deny 优先）；16：capability 新增 `frames`（`main` 默认 / `sub` / `any`），`InvokeRequest.frame` 取自请求 extension 的 `IpcFrame`（缺省按主 frame）；17：`Builder::acl_exempt_webview`，本地来源主 frame 免 ACL（显式 deny 与 listen 作用域都跳过，ACL 照常解析）。`tauri-runtime-kbcef` 给每个自定义协议请求插 `IpcFrame`（无 CEF frame 记 `Unknown`），`cef-ipc` 回退通道重建请求时带上。应用侧：特赦 `main` / `wallpaper`，删除 `permissions/main.toml`，`main-capability` 去掉 `"main"`；`surf-navbar` 的 `core:event:default` 换成只能听 `surf-url-changed` / `surf-collect-state` 的 allow-listen + allow-unlisten；`wpe-web` 的 allow-listen 限定 `wallpaper-ping` / `setting-change` / `image-changed` / `images-change`；导航栏前端去掉 `{ target }` 绕法；预览代办（`wpeWebBridge.ts`）只登记三事件白名单；`wpe_shim.js` 去掉 `target`。另把 `mock_context` 缺的 `bins: None` 并入补丁 09（字段由它引入，否则 `cargo test -p tauri` 编不过）。真机：2026-10-31 在 macOS dev（CEF）上验证 M1–M9，均通过；本仓 dev profile 下 tauri 关闭了 debug-assertions，拒绝信息只有 `Command … not allowed by ACL`，不带 URL / frame，frame 维度靠主 frame 对照组判定。Windows / Android / Linux 项待验证。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 补丁序列 | macOS 本地 | 依次 `--gen --from 13/14/15/16` 生成 14–17；`deno task patch tauri --check`；`--gen --from 17` | 预检通过；系列之外没有剩余改动 | 2026-10-31 macOS：`tauri: OK dry-run`；`--gen --from 17` 输出 0 行。14 涉及 7 个文件（event / manager / webview / lib.rs），15 3 个，16 11 个（含 tauri-runtime / tauri-utils / tauri-cli），17 5 个 |
| [x] | S2 tauri 上游单测 | macOS，`third/tauri` 工作区 | `cargo test -p tauri --lib`；`cargo test -p tauri-utils --lib` | 全部通过 | 2026-10-31 macOS：tauri 99 passed / 0 failed，tauri-utils 44 passed / 0 failed。新增用例：`event::listener` 跨 webview 退订、接收方身份；`manager::test::js_emit_to_uses_receiver_identity`（AnyLabel / Window / Webview / WebviewWindow / App / Any）；`manager::window::tests`（关闭拦截）；`event::plugin::tests`（作用域精确 / 前缀 / deny / 混合授权、子 frame 被拒、特赦三条件、特赦跳过作用域与显式 deny）；`ipc::authority` frames 3×3 表、按 frame 过滤与拒绝信息、deny 对所有 frame 生效、`is_exempt` 三条件；`ipc::protocol` frame 来自 extension；tauri-utils `capability_frames_de`、`resolve_carries_capability_frames` |
| [x] | S3 上游其它 crate 编译 | macOS，`third/tauri` 工作区 | `cargo check -p tauri-cli`；`cargo check -p tauri-utils --features build,schema`；`cargo check -p tauri-build -p tauri-codegen` | 0 error | 2026-10-31 macOS：均通过（`ToTokens` 与 schema 派生能编译） |
| [x] | S4 CEF runtime 单测 | 带环境注入的 test-kabegame | `driver.sh kabegame -p tauri-runtime-kbcef --lib`，再对编好的 `tauri_runtime_kbcef-*` 测试二进制加 `DYLD_FRAMEWORK_PATH=bin/macos/arm64/cef-build` 直接运行 | 主 frame / 子 frame / 无 frame 的 extension 分别为 Main / Sub / Unknown；`cef-ipc` 重建后保留 | 2026-10-31 macOS：driver 编译通过，但同一次 cargo test 先跑的 kabegame 测试二进制因找不到 CEF framework SIGABRT（既有问题）；直接运行 32 passed / 0 failed，含新增 `protocol::tests::request_frame_is_reported_to_tauri_acl`、`request_frame_still_pins_file_origin`、`ipc::tests::ipc_frame_survives_the_rebuilt_request` |
| [x] | S5 应用单测 | 同上 | 对 `kabegame-*` 测试二进制加 `DYLD_FRAMEWORK_PATH` 直接运行 | 全部通过 | 2026-10-31 macOS：52 passed / 0 failed（含 `wpe_web` 的 `file:///*` 匹配） |
| [x] | S6 编译、生成物与格式 | 带环境注入的 check-kabegame | `driver.sh`（vue-tsc + cargo check）；读 `gen/schemas`；改动文件 rustfmt / Prettier | 0 error；构建期 ACL 反映新配置 | 2026-10-31 macOS：vue-tsc 0 error、cargo 0 error。`capabilities.json` 中 surf-navbar / wpe-web 的 allow-listen 带作用域、main-capability 不再有 `main`；`acl-manifests.json` 的 app 权限只剩 crawler / surf / surf-navbar / wpe-web；`desktop-schema.json` 含 `frames`。`third/tauri` 三个 crate 整体 `rustfmt --check` 通过；应用侧新增行符合 rustfmt（`tauri-runtime-kbcef` 两个文件与 `wpe_web.rs` 的剩余差异在改动前就存在）；`surf-navbar.ts` / `wpeWebBridge.ts` Prettier 通过 |
| [ ] | S7 Android 静态检查 | macOS | `driver.sh --mode android --skip vue` | Android 仍编译（wry 不上报 frame，按主 frame 处理；主界面靠特赦） | 2026-10-31：报 `rusty_v8 Android 自建产物缺失: bin/android/arm64/rusty_v8-build/`，未进入编译；本机也没有 aarch64-linux-android 的 Rust 目标。改动的移动端路径只有 `InvokeMessage` 的 `Clone`，未实测 |
| [x] | M1 主窗口主要页面 | macOS dev（CEF），kabegame-chromium | 删除 main.toml 后依次打开画廊、画册、任务抽屉、插件、设置，做一次收藏 / 改名 / 启动任务 | 全部正常，日志与 console 无 `not allowed by ACL` | 2026-10-31 macOS：dev 构建晚于全部改动（二进制含 ``is not allowed to be listened by ACL``）。屏幕锁定、主窗口文档 hidden 不出帧，CDP 驱动时用截图泵帧推进 CSS 过渡。依次进入画廊、画册、源（`/plugins`）、设置、畅游、运行配置，打开任务抽屉，均正常渲染；画廊右键「收藏」图 8974 后菜单变「取消收藏」，再取消恢复原状；新建画册「ACL回归测试画册」→ 信息面板「重命名」→ 右键「删除」；经 crawler store `addTask` 启动 nekos-moe dry-run 任务，完成并经事件进抽屉（10 → 11，标「空跑」）。console 只有既有的 Vite `fs` 外部化警告；本次启动以来日志无 `not allowed by ACL` / WARN / ERROR。测试画册、任务已删除 |
| [x] | M2 主窗口 listen 不受限 | 同上 | 主窗口 console：`__TAURI_INTERNALS__.invoke('plugin:event\|listen', { event: 'images-added', handler: __TAURI_INTERNALS__.transformCallback(() => {}) })`，再换 `app-log`、`surf-url-changed` | 都返回监听 id | 2026-10-31 macOS：三个事件分别返回监听 id 42 / 43 / 44，随后 `plugin:event\|unlisten` 均成功 |
| [x] | M3 壁纸窗口 | macOS dev，窗口模式 | 设一张图片壁纸，CDP 连 wallpaper target；debug ingest 临时插桩记录 ping / pong（`// DEBUG-acl-exempt`，验完删除） | 应用页正常渲染，ping 逐个应答 | 2026-10-31 macOS：壁纸窗口（窗口模式）正常显示图片壁纸；画廊右键「抱到桌面上」设图 8974，壁纸窗口 `img.base` 换成 768 宽 PNG，再用 `setWallpaperOrBackground('8270')` 恢复原图（1500 宽）。`// DEBUG-acl-regression` 插桩记录 ping seq 166–180 共 15 个，每个都有 `pong_ok`（3–5ms），无 `pong_err`，日志无「未应答」；插桩已删除 |
| [x] | M4 畅游两窗口地址栏不串 | macOS dev | 同时开两个畅游窗口（不同站点）分别导航几次 | 各自导航栏地址只随本窗口变化；一键下载转圈只出现在对应窗口 | 2026-10-31 macOS：example.com / example.org 两窗口，各做 2 次整页导航、1 次 pushState、1 次回首页。导航栏地址记录分别只有 `https://example.com/` → `?n=1` → `/spa-a` → `?n=2` → `/` 与 example.org 的对应序列，没有串入，每次变化只出现一次；点 A 导航栏的一键下载，只有 A 的 `aria-busy` true → false（页面无媒体，立即结束），B 不变；点 B 时反之 |
| [x] | M5 导航栏只能听两个事件 | 同上 | 导航栏 webview console 里 listen `images-added`，再 listen `surf-url-changed` | 前者报 ``event `images-added` is not allowed to be listened by ACL``，后者成功 | 2026-10-31 macOS：`images-added` 报 ``event `images-added` is not allowed to be listened by ACL``，带 `target: { kind: 'Any' }` 也一样；`app-log`、`surf-url-changed-x` 同样被拒；`surf-url-changed` / `surf-collect-state` 返回 id 49 / 50，unlisten 成功；`plugin:event\|emit` 报 `not allowed by ACL` |
| [x] | M6 外部页面调主窗口命令 | 同上 | 畅游外部页面 console invoke `get_plugins` | `not allowed by ACL` | 2026-10-31 macOS：example.com 内容页 `get_plugins` 报 `Command get_plugins not allowed by ACL`，`surf_open_in_browser`、`surf_collect_toggle`、`plugin:event\|listen` 也被拒。报错里没有 URL：tauri 以 path 补丁引入、不是工作区成员，根 `Cargo.toml` 的 `[profile.dev.package."*"] debug-assertions = false` 让它走 release 文案，`resolve_access_message`（带 URL / frame）在 dev 构建里不存在，二进制里搜不到 `not allowed on window` |
| [x] | M7 畅游子 frame | 同上 | 外部页面里建同源 iframe；在主 frame 读 invoke key（它是 `ipc-protocol.js` 闭包里的常量，不在 `window` 上：临时包装可写的 `window.fetch`，从一次 invoke 的请求头 `Tauri-Invoke-Key` 取，取到后还原），先在主 frame 发一次作对照，再 CDP 切到 iframe 执行上下文直接 `fetch('ipc://localhost/surf_report_url', { method: 'POST', headers: { 'Tauri-Invoke-Key': key, 'Tauri-Callback': '1', 'Tauri-Error': '2', 'Content-Type': 'application/json' }, body: '{"url":"x"}' })` | 主 frame 放行；iframe 发同样请求被拒（拒绝文案不带 frame，以对照组判定） | 2026-10-31 macOS：主 frame 包装 `window.fetch` 取到 key 后已还原。主 frame 直接 fetch `surf_report_url` 返回 200、`Tauri-Response: ok`；同源 iframe（`https://example.com/?acl-iframe=1`）、srcdoc iframe 和跨源 OOPIF（`https://example.org/`）发同样请求，均返回 `Tauri-Response: error`、`"Command surf_report_url not allowed by ACL"`。同一 key、同一命令，只换发起 frame，结果就从放行变成拒绝，说明拒绝来自 frame 维度 |
| [x] | M8 主窗口子 frame 不特赦 | 同上 | 主窗口建 srcdoc iframe（同源），在其上下文用主 frame 的 invoke key 直接 fetch `ipc://localhost/get_plugins` | 主 frame 放行；iframe 被拒，说明特赦只认主 frame | 2026-10-31 macOS：主窗口主 frame 直接 fetch `get_plugins` 返回 ok；srcdoc iframe（origin `http://localhost:1420`）返回 `"Command get_plugins not allowed by ACL"`，`plugin:event\|listen` 同样被拒。另：主 frame 创建的 dedicated worker 请求被放行，子 frame 创建的被拒，说明 CEF 把 dedicated worker 请求归到创建它的 frame，不记为 `Unknown` |
| [x] | M9 关闭行为 | macOS dev | 点主窗口关闭；运行一个 WebView 插件后关闭爬虫窗口 | 主窗口只隐藏到托盘；爬虫窗口只隐藏 | 2026-10-31 macOS：主窗口调 `plugin:window\|close`（走 CloseRequested，与点关闭按钮同一处理；屏幕锁定，点不了原生按钮），`is_visible` 由 true 变 false，`get_all_windows` 里仍有 main、页面存活，show 后恢复；x-webview dry-run 任务的 `crawler-<id>` 窗口先 `show_crawler_window` 再 close，`is_visible` 变 false，窗口仍在，任务仍是 running；取消任务后窗口随之销毁，测试任务已删除 |
| [ ] | M10 预览代办白名单 | Windows dev | 图库预览网页壁纸；CDP 在预览 iframe 里 `parent.postMessage({ kbWpe: 1, type: 'listen', events: ['images-added', 'setting-change'] }, '*')`，再触发新增图片与改语言 | iframe 只收到 `setting-change` 转发 | 未测（2026-10-31）：网页壁纸只在 Windows 提供，macOS 不挂载预览 `file:` iframe，`wpeWebBridge` 没有宿主，需在 Windows dev 上测 |
| [ ] | W1 网页壁纸拉状态与事件 | Windows dev，窗口模式 | 设一张网页壁纸，看属性、ping 应答；切换界面语言 | 页面收到作者属性；ping 逐个应答；改语言后页面更新 | 未测（2026-10-31）：本机为 macOS，网页壁纸只在 Windows 提供 |
| [ ] | W2 网页壁纸只能听四个事件 | 同上 | wallpaper target console：listen `images-added` 与 `image-changed` | 前者被 ACL 拒绝，后者成功 | 未测（2026-10-31）：本机为 macOS，网页壁纸只在 Windows 提供 |
| [ ] | W3 网页壁纸里的 `file:` iframe | 同上 | 在网页壁纸里建 `file:` iframe（同目录），用主 frame 的 invoke key 在 iframe 上下文 fetch `ipc://localhost/wpe_web_pull_state` | 主 frame 放行；iframe 被拒 | 未测（2026-10-31）：本机为 macOS，网页壁纸只在 Windows 提供，判定方法同 M7 |
| [ ] | A1 Android | Android dev | 主界面主要页面、畅游与 WebView 爬虫各走一遍 | 主界面命令与事件正常（wry 不上报 frame，按主 frame 特赦）；畅游 / 爬虫行为不变 | 未测（2026-10-31）：本机缺 `bin/android/arm64/rusty_v8-build/`，编不出 Android 包（见 S7） |
| [ ] | L1 Linux / Windows 桌面冒烟 | Linux、Windows CEF dev | 同 M1、M4 | 正常 | 未测（2026-10-31）：本机为 macOS |

## 壁纸窗口 ping 看门狗

后端随 `WallpaperWindow` 启动 ping 看门狗，每 10s 经全局事件发 `wallpaper-ping`，应用页与 Windows 网页壁纸垫片按 label 过滤并调用 `wallpaper_pong`；pong 为 opt-in。连续 3 次未应答重载当前文档，重载后仍无应答则按 3 → 6 → 12……退避至 60，有效应答恢复阈值 3；导航 / 重载用 floor 作废旧应答。页面不计时，sleep 循环不补 tick，init 看门狗与 CEF 无响应恢复链路继续各司其职。以下用例待使用带环境注入的脚本和真机验证。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 事件协议单测 | 带环境注入的 test-kabegame | 运行 kabegame-core 的 `ipc::events` 用例 | 默认种类含 ping、不含 pong；两事件序列化、反序列化与名称正反映射一致 | 2026-10-30 macOS：`ipc::events` 5 个通过 |
| [x] | ping 状态机单测 | 带环境注入的 test-kabegame | 运行 kabegame 的 `wallpaper::ping` 用例 | 持续应答不重载；无应答第 40s 重载；停止应答、label 隔离、reset 迟到应答、3 → 6 → 12 退避 / 60 上限 / 应答恢复、睡眠不补 tick、句柄丢弃退出均通过 | 2026-10-30 macOS：9 个通过。`test-kabegame kabegame` 能编译，但测试二进制在 `target/debug/deps/` 下按 `@executable_path/../Frameworks` 找不到 CEF framework（SIGABRT，与本次无关），改为对已编好的二进制加 `DYLD_FRAMEWORK_PATH=bin/macos/arm64/cef-build` 直接运行 |
| [x] | 编译与格式 | 带环境注入的 check-kabegame | 运行 vue-tsc 与 cargo check；逐个检查改动 Rust 文件的 rustfmt 和前端 Prettier | 无新增错误，改动文件格式正确 | 2026-10-30 macOS：vue-tsc 0 error、cargo check 0 error，改动文件无新增 warning；rustfmt `--check` 与 Prettier `--check` 均通过。Windows 专属分支本机编不到 |
| [ ] | 正常不误报与序号往返 | macOS dev，窗口模式 | 用 kabegame-chromium 连 wallpaper target；以 `// DEBUG-wallpaper-ping` 临时 debug ingest 插桩记录 ping / pong，空闲 3 分钟后删除插桩 | 序号逐个对应，日志无「ping 未应答」 | |
| [ ] | 遮挡不误报 | macOS dev，窗口模式 | 用最大化 / 全屏窗口覆盖桌面 6 分钟以上，CDP 读取 `document.visibilityState`，观察日志 | 状态为 hidden 且无未应答；若连续未应答则停下报告，不调大阈值掩盖 | |
| [ ] | JS 卡死自动恢复 | macOS dev，窗口模式 | CDP 注入 `setTimeout(() => { const t = Date.now(); while (Date.now() - t < 300_000) {} }, 3000)` 后立刻断开 CDP，观察日志 | 先 3 条 warn，再 error / reload，随后 wallpaper 的 renderer unresponsive → terminated → 重载并恢复应答；reload 后 60s 内既无 unresponsive 也无恢复则报告、另补重建窗口兜底 | |
| [ ] | 事件不外溢 | macOS dev + CLI / SSE | CLI 订阅全部事件或接 SSE，保持窗口模式 | 能看到 wallpaper-ping，看不到 wallpaper-pong | |
| [ ] | 睡眠唤醒 | macOS dev，窗口模式 | 人工让 Mac 睡眠 1 分钟后唤醒，观察日志 | 最多一条未应答 warn，不 reload | |
| [ ] | 网页壁纸正常与遮挡应答 | Windows dev，窗口模式 | 确认垫片 selfLabel 非空，分别空闲 3 分钟、覆盖桌面 6 分钟以上 | 仅应答本窗口，正常 / hidden 均不误报 | 2026-10-31 部分通过：桌面 12099，垫片 label 为 `wallpaper`；空闲 185s 内 iframe 连续应答 18 次（seq 289–306），壁纸窗口应用页显示网页期间不应答，同时打开的预览 iframe（label `main`）不应答，日志无未应答。遮挡 6 分钟未测：需要人工用全屏窗口盖住桌面 |
| [x] | 网页壁纸 JS 卡死恢复 | Windows dev，窗口模式 | 网页壁纸注入有界忙循环后立刻断开 CDP，观察日志 | 连续未应答后自动重载并恢复应答；遵守上述 60s 证伪判据 | 2026-10-31 同 B 段 W4：注入 90s 忙循环，3 次未应答后整页重载并恢复应答，60s 判据内恢复 |
| [x] | 网页壁纸与图片切换 | Windows dev，窗口模式 | 网页壁纸与图片来回切换，观察日志 | 新文档重新监听，旧应答作废，没有多余 reload | 2026-10-31 Claude 实测（与 B 段 W3 同一轮）：12823 与 5 张网页壁纸来回切 10 次、每步 12s，每个新文档都重新 listen 并应答 ping，图片期间由应用页应答；全程日志无「ping 未应答」、无重载。注意：网页壁纸之间直接切换偶发新文档没有 Tauri 桥，会 3 次未应答后整页重载，见 07 节 D1 |
| [ ] | 网页壁纸睡眠唤醒 | Windows dev，窗口模式 | 睡眠 1 分钟后唤醒，观察日志 | 不补发错过的 tick，最多一条 warn，不 reload | |

## CEF 渲染进程卡死判定改为 5 秒

2026-10-30：`tauri-runtime-kbcef` 在 `on_before_command_line_processing` 里合并追加 `--enable-features=RendererHangWatcher:delay/5s`，把 Chromium 桌面默认的 15s hang monitor 延迟改为 5s（Android 默认值），判定仍是「延迟到期 → 主线程 ping 1s 无应答」；`disable_chrome_only_features` 泛化为 `merge_feature_switch`，vulkan 分支的 `enable-features=Vulkan` 也改为合并，避免两处各写一次互相覆盖。`on_render_process_unresponsive` / `on_render_process_terminated` 未改。静态验证：改动文件 rustfmt 无差异；dev 自动重编通过，二进制含该开关串。测法：CDP 给主窗口挂一个 Ctrl+Shift+H 的 keydown 监听（先 `sendBeacon` 到 debug ingest 记按键时刻，再进 60s 有界忙循环）后立即断开 CDP（DevTools 附着时 Chromium 不报无响应），人工按键，后台脚本盯日志与渲染进程。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 改动前基线 | macOS 桌面 CEF dev | 主窗口在最前，按热键进入忙循环 | 约 16s 后 `renderer unresponsive for webview 'main'`，紧接 `terminated … RESULT_CODE_HUNG`，页面重载 | 2026-10-30：约 10:38:15 卡住，10:38:31.684 报无响应、+25ms 终止，重载后标记与横幅消失、`/gallery` 正常 |
| [x] | 5s 判定并重载 | macOS 桌面 CEF dev | 同上 | 约 6s 报无响应并重载，页面恢复可用 | 2026-10-30：按键 15:12:36.815，无响应 15:12:42.815（正好 6.000s），+25ms 终止，15:12:42.842 新页面开始加载，画廊正常渲染 |
| [ ] | 正常重负载不误杀 | 桌面 CEF | 画廊每页 1000 条来回翻页、冷启动大库、慢机器上操作 | 日志无 `renderer unresponsive`，页面不被重载 | 未验证 |
| [ ] | Windows / Linux | Windows、Linux 桌面 CEF | 同「5s 判定并重载」 | 约 6s 自动重载 | 未验证：本机为 macOS |
| [ ] | vulkan 模式开关合并 | Linux，`KABEGAME_CEF_GPU_MODE=vulkan` | 启动后看 GPU 是否走 Vulkan，并按热键测卡死 | Vulkan 与 5s 判定同时生效 | 未验证 |
| [ ] | 爬虫窗口仍排除 | 桌面 CEF | 运行 WebView 爬虫任务时让其页面卡死 | 不 terminate / reload，由调度器心跳超时结束任务 | 未验证：回调代码未改 |

## 应用日志（tracing + 按天落盘 + 事件循环广播 + 查看日志）

2026-10-29：`kabegame_core::logging` 装配全进程唯一 tracing 订阅器（控制台 / `<data_dir>/logs/kabegame.<UTC 日期>.log` / `AppLogLayer` / debug ingest），约 380 处打印改为分级宏；`AppEventKind::Log` 为 opt-in，「订阅全部」改用 `default_kinds()`；出口为 Tauri `get_app_logs` + `set_app_log_stream`（`app-logs` 只发主窗口）、Web super `/logs` SSE + `get_app_logs` RPC、IPC `AppLogs`（CLI `log tail`）；前端经 `tauri-plugin-tracing` 写日志；debug ingest 改为 trace 日志 + 订阅层转发。静态验证：check-kabegame 的 cargo check（`kabegame` standard / web、`kabegame-cli`）0 error；vue-tsc 只有既有的 `vite.config.ts(74,20)` `isProd` 错误。单测：`kabegame-core` 新增 logging 8 个、事件 1 个全部通过；core 全量 392 通过、4 失败，均为既有失败（3 个 `wpe` Windows 路径用例在 macOS 上跑、1 个 `local_folder` 缩略图删除用例对应「只删 thumbnails_dir 内文件」规则），与本次无关。Android / Windows / Linux 专属文件的打印替换在 macOS 上编不到，只做了同参数宏替换。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 环形缓冲与过滤 | macOS 单测 | `test-kabegame kabegame-core --lib logging` | seq 递增、满容量淘汰最旧；since / limit 返回最新尾部；空 target 按 webview 级别；`KABEGAME_LOG` 叠加默认级别、非法级别报错 | 2026-10-29：8 个通过 |
| [x] | 日志层记录与防重入 | macOS 单测 | 同上 | message 与字段（task_id、count）正确入记录；层内再打的日志被丢弃；带 `log{w=main}` span 的空 target 事件记为 `webview:main`、插件的空名位置字段被丢弃 | 2026-10-29 通过 |
| [x] | Log 事件 opt-in | macOS 单测 | `ipc::events` | `default_kinds()` 不含 `Log`；`AppEvent::Log` 序列化为 `{"type":"log",seq,…}` 并能往返 | 2026-10-29 通过 |
| [x] | 启动日志落盘 | 桌面 dev | 启动 app，打开 `.kabegame/debug/data/logs/` | 有 `kabegame.<UTC 日期>.log`，含 `Settings initialized` 等启动行，无 ANSI 转义 | 2026-10-29 macOS dev：生成 `kabegame.2026-10-29.log`，0 处 ANSI；同进程多次重启追加写入 |
| [x] | 查看日志：历史与实时 | 桌面 dev | 工具箱 → 维护 →「查看日志」；随后跑一次整理或插件任务 | 弹窗先显示启动以来的历史；任务期间新日志实时追加并自动滚到底；手动上翻后自动滚动关闭 | 2026-10-29 CDP：入口在亀ちゃん工具箱维护分组；打开即显示启动以来 35 条；打开期间收到 3 条 `app-logs`。自动滚动未单独验证。2026-10-29 代理实测：连打 100 条与 2 秒内分散 50 条 `logger.info` 后列表都停在底部（scrollTop = max）且开关保持开启；把列表滚到顶后开关自动关闭，再来 30 条滚动位置仍为 0；重新打开开关立即跳到底。另：前端连续快速打日志时 seq 顺序与调用顺序不一致（180 条里 68 条错位），属异步 IPC 到达顺序 |
| [ ] | 查看日志：筛选 | 桌面 dev | 依次切换级别（勾 DEBUG）、来源（前端 / 后端）、模块前缀（如 `kabegame_core::crawler`）、关键字 | 列表与「显示 N / 共 M 条」随筛选变化；点一行在下方显示完整消息与字段 | 2026-10-29 CDP：关键字筛到 2 条，勾 DEBUG 后 3 条，点行显示详情。来源与模块前缀未单独点测。2026-10-29 代理实测：来源「前端」184 条全为 `webview:main`、「后端」15 条无 `webview`；前缀选 `kabegame::core_init` / `kabegame_core::ipc` 后可见行全部以该前缀开头；勾 DEBUG 199→216，TRACE 无新增（dev 阈值 debug，缓冲里没有 TRACE）。失败：点模块前缀下拉的 × 清除后 `targetPrefix` 变成 `undefined`，`filtered` 里 `.trim()` 抛 TypeError（日志里有 `[vue] component update: Cannot read properties of undefined (reading 'trim')`），此后切来源 / 级别列表与计数都冻结不变，直到组件重建。另：前缀 `kabegame` 也会命中 `kabegame_core::*`（`startsWith` 不按 `::` 分段）。已修复（待 dev 复测）：模块前缀清除后按空串处理；前缀改为按 `::` 分段匹配，CLI `--target` 同规则 |
| [ ] | 关闭即退订 | 桌面 dev | 关闭弹窗后持续产生日志，再打开 | 关闭期间后端停止推送；再打开时补拉关闭期间的历史，不重复 | 2026-10-29 CDP：关闭后打日志收到 0 条 `app-logs`；重开补到关闭期间那条，seq 无重复。实时推送已从全局事件 `app-logs` 改为 Channel（`start_app_log_stream` / `stop_app_log_stream { streamId }`），待 dev 复测 |
| [x] | 复制 / 清空 / 打开目录 | 桌面 dev | 点「复制」「清空」「打开日志目录」 | 剪贴板为筛选后的行；清空后不回填旧日志；Finder / 资源管理器打开 logs 目录 | 2026-10-29：`pbpaste` 为筛选后的行；清空后关闭重开仍为 0 条、新日志照常进来；`open_logs_dir` 成功打开 Finder |
| [ ] | 前端日志与未捕获异常 | 桌面 dev（devtools） | 执行 `logger.info("x")`；再 `setTimeout(() => { throw new Error("boom") })` | 查看器与日志文件出现 `webview:main` 的 INFO「x」与 ERROR「[window] boom…」 | 2026-10-29 CDP 通过。实测发现对象参数被插件转成 `[object Object]`、插件的调用位置总指向 `logger.ts`，已改为 `logger` 先序列化参数、后端丢弃该位置字段，复测对象显示为 JSON。2026-10-29 代理实测（未改状态，供复核）：查看器里 target 为 `webview:main`，但日志文件里前端日志 0 处 `webview:main`，行形如 `INFO log{w=main}: : agent-c7-marker =logger.ts:30:22)#    at eval …`，即 target 为空、空名位置字段也没丢弃——补 `webview:<label>` 与丢字段只在 `AppLogLayer` 做了，文件层仍是默认 fmt。已修复（待 dev 复测）：控制台与文件改用共用的 `logging/format.rs` 单行格式，前端日志记为 `webview:main`、不打印 span 与位置字段；单测 `formats_frontend_event_with_webview_target_and_no_span` 通过 |
| [ ] | 畅游窗口无日志权限 | 桌面 dev | 在畅游页面 devtools 里调 `plugin:tracing\|log` | 被 ACL 拒绝；畅游内容页、畅游导航栏、爬虫窗口都收不到实时日志 | 2026-10-29 代理实测：example.com 畅游内容页有 `__TAURI_INTERNALS__`，`plugin:tracing\|log`、`get_app_logs`、`set_app_log_stream`、`plugin:event\|listen` 均报 `not allowed by ACL`，主窗口查看器与日志文件里没有这条探针日志，内容页收到 0 条 `app-logs`。但同一窗口的 `surf-navbar`（自有页面，有 `core:event:default`）用全局 `listen("app-logs")` 收到了主窗口的日志批次：Tauri 的 `match_any_or_filter` 对 target=Any 的监听者直接放行，`emit_to("main")` 挡不住；`crawler-*` 同样有 `core:event:allow-listen` 且允许远程 URL，未实测。已修复（待 dev 复测）：实时日志改经查看器传入的 Channel 推回调用页，不再发全局事件 |
| [x] | debug ingest | 桌面 dev | 前端调用 `sendDebugEvent("probe", {a:1}, {sessionId:"log-probe"})`；查看 `backend_started` | `.kabegame/debug/debug-log-probe.ndjson` 有 source=frontend 的 `probe`，`ts` 为调用时刻；后端会话文件有 source=rust 的 `backend_started`；这两类事件不出现在查看器里 | 2026-10-29 通过。首次启动发现发送线程在 Tokio runtime 外构造 reqwest Client 而 panic（panic hook 已把它记进日志），已改为先 `runtime.enter()`，复测 `backend_started` 落盘。2026-10-29 代理实测：`sendDebugEvent("agent-probe", {x:1}, {sessionId:"agent-probe"})` 后 `debug-agent-probe.ndjson` 有一条 source=frontend、ts 与调用时刻一致的记录；`get_app_logs`（217 条）与当天日志文件里 `kb-debug` / `agent-probe` 均为 0 |
| [ ] | debug ingest（Android） | Android dev | 前端调用 `sendDebugEvent` | 事件经后端转发落盘，不再出现空事件 | |
| [x] | CLI log tail | 桌面 dev + dev CLI | `kabegame-cli log tail --level debug --history 50`，同时在 app 里操作；再退出 app | 先输出最近 50 条再持续跟随；退出 app 后提示连接断开；app 未运行时直接报错不回退本地 | 2026-10-29：历史、`--target` / `--level` 筛选、跟随（实时收到前端 `logger.info`）、`--via local` 报错均通过。实测修了两处：漏初始化 AppPaths 导致 panic；`--history` 改为按筛选后计数。退出 app / app 未运行两条未测。2026-10-29 代理实测：`log tail --level trace` 跟随中在主窗口 `exit_app`，CLI 收到 CEF 关闭的 DEBUG 行后打印「与主程序的连接已断开」并以退出码 1 结束；app 未运行时 `log tail`（默认 `--via auto`，含 `--no-follow`）直接报「日志只能从运行中的主程序读取：连接 Kabegame IPC 服务失败…Connection refused」，退出码 1，没有回退本地 |
| [x] | 防自激 | 桌面 dev + dev CLI | 查看器勾 DEBUG + TRACE，同时 `kabegame-cli log tail --level trace` 跟随；空闲 10 秒后再触发操作 | 空闲时查看器与 CLI 都不增长；操作后增量与操作相称 | 2026-10-29 代理实测：空闲约 13 秒查看器 +0 条、CLI +0 行；一条 `logger.info` 加两次设置修改 → 两侧各 +1（就是那条日志）；再起一个 CLI 连接 → 两侧各 +3 条 `kabegame_core::ipc` DEBUG；每次之后 5 秒空闲均为 0 |
| [x] | `KABEGAME_LOG` 调级 | 桌面 dev | `KABEGAME_LOG=kabegame_core::ipc=trace` 启动，用 CLI 发一个请求 | 控制台 / 文件出现 IPC 逐帧 trace 日志；不设时没有 | 2026-10-29 用 dev CLI 验证（同一订阅器）：设置后 stderr 出现 `kabegame_core::ipc::client::connection` 的 TRACE，不设为 0 条；非法值记一条 WARN 并退回默认 |
| [ ] | Web super 日志 | web dev | 非 super 与 `?super=1` 分别打开工具箱；`curl -N 'http://127.0.0.1:7490/logs?super=1'` | 非 super 无「查看日志」，`/logs` 返回 403、`get_app_logs` 返回 forbidden；super 下可查看并实时滚动 | 2026-10-29 借桌面端应用 Web 服务器（同一套路由）验证了后端：无 super 时 `/logs` 403、RPC forbidden；super 下 RPC 返回历史、SSE 实时收到日志。Web 前端工具箱入口未测 |
| [x] | 原有事件不受影响 | 桌面 dev | 下载、删图、画册增删、设置修改 | 画廊 / 任务 / 画册照常刷新（`default_kinds` 替换 `ALL` 未漏种类）；CLI `plugin run` 任务日志照常 | 2026-10-29：设置修改的 `setting-change` 照常到前端（2 次切换收到 2 条），画廊正常加载。下载 / 删图 / 画册未测。2026-10-29 代理实测（均未手动刷新）：本地导入 4 张 PNG，画廊页头 212 / 4189 在 1.6 秒内逐张涨到 216 / 4193，任务抽屉显示「本地导入 完成 ✓4」，3 条 `task-log` 实时到达且任务日志弹窗完整；新建画册 0.1~0.2 秒出现在树里、加 4 张后树计数与画册页头都变 4、改名 0.1 秒同步、删除 0.1~0.4 秒从树中消失；后端改 `networkRetryCount` 2→3→2，设置页输入框约 50 ms 同步；删除 4 张后 0.1 秒回落到 212 / 4189。dev CLI `plugin run manyacg --via app`（随机 2 个作品）两次均 completed，进度条正常绘制，任务日志经 `suspend` 打在进度条上方 |
| [ ] | 发布版级别 | 桌面 release 包 | 安装后启动，查看日志文件 | 只有 INFO 及以上；无 DEBUG 行 | |

## WPE 壁纸导入（第二阶段 Phase 7：用户属性面板）

2026-10-31：`x-wpe/web` 壁纸的作者属性可在预览详情栏和设置页编辑。用户值写入图片 metadata 的 `userProperties`，每次改写新建 metadata 行并广播 `metadataId` 补丁；桌面与预览页面重拉并按键差异更新。文件与目录属性由当前窗口的文件策略追加放行，换壁纸根目录时清空。真机项留给 Claude 在沙箱外执行，修改垫片或 runtime 后须完全重启 dev。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 core 属性单测 | Windows 本地 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib wpe::`（`CARGO_TARGET_DIR=target-check`） | 全部通过 | 2026-10-31 沙箱外（含验收补改的词表目录查找与有序截断列举）：26 passed / 0 failed |
| [x] | S2 metadata 事务单测 | Windows 本地 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib rewrite_image_metadata` | 全部通过 | 2026-10-31 沙箱外：3 passed / 0 failed（改指 + 搜索词拷贝 + 删旧行；共享行保留与回滚；`task_failed_images` 引用保留） |
| [x] | S3 前端类型检查 | Windows 本地 | `.claude/skills/check-kabegame/driver.sh` | 0 error | 2026-10-31 沙箱外完整 check：vue-tsc 0 error |
| [x] | S4 前端 Vitest | Windows 本地 | `deno task test -c kabegame --skip cargo` | `wpeProperties.test.ts` 全过 | 2026-10-31 沙箱外：`wpeProperties.test.ts` 7 passed（含验收时补的一元运算优先级、运行期出错不缓存两组）；全量 54 文件 / 545 用例通过，`KameToolboxBubble.test.ts` 因既有的 `@kabegame/i18n` mock 缺 `i18n` 导出加载失败（`backfillName.ts`，与本 Phase 无关） |
| [x] | S5 改动文件格式 | Windows 本地 | Prettier `--check` 限定本次前端文件；`rustfmt --check --config skip_children=true` 限定 Rust 文件 | 全部通过 | 本次前端与 Rust 文件均通过；全仓 `deno task format:check` 仍报 11 个未改文件的既有格式问题 |
| [x] | S6 runtime 与应用 Rust 检查 | Windows 本地 | `CARGO_TARGET_DIR=target-check` 完整 check；`driver.sh kabegame -p tauri-runtime-kbcef --lib`；`driver.sh kabegame --lib wpe_web` | 全部通过 | 2026-10-31 沙箱外：cargo 0 error；runtime 76 passed（`grant_without_root_works` 原先手工 `canonicalize` 构造 Grant、带 `\\?\` 前缀而失败，验收时改为与运行时同一个 `canonical_path` 并补「同目录兄弟文件被拒」断言）；`wpe_web` 2 passed |
| [x] | V1 面板视觉 | Windows CEF dev | 预览 Corsair-O-Tron / Personal Slideshow 与设置页「壁纸属性」弹窗截图 | 外观对齐左栏原生元数据面板：分组为圆角卡片（渐变标题栏、展开箭头、字段数、组内有改动时的小圆点），卡片内条目无边框、悬停淡底；开关 / 取色与标签同行，其余字段在标签下方；改过的项只显示小的「恢复默认」图标；下拉不溢出；设置页弹窗标题为壁纸名、限高 70vh 内部滚动 | 2026-10-31 通过。首版每行被四边粗框包住（项目无 preflight，`border-solid` 让未设宽度的三边按浏览器默认宽度画出），`KbSelect` 在 ≤4 个选项时自动用分段器、长选项在窄侧栏横向截断，每行文字版「恢复默认」占位重复。改为卡片布局；`KbSelect` 新增 `segmented` 开关，属性字段只在 ≤3 个选项且文案都不超过 8 字符时用分段器 |
| [x] | 1 预览属性入口 | Windows CEF dev（完全重启） | 预览 kaguya，并打开普通图片对比 | WPE 右栏有 3 颜色、3 滑块、1 文件；简体中文 `schemecolor` 为「主题配色」；普通图片仍显示插件详情 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：kaguya（12097）右栏为「壁纸属性」，3 颜色 / 3 滑块 / 1 文件，`schemecolor` 显示「主题配色」；普通图片 12823 右栏仍是「插件详情」 |
| [x] | 2 改颜色与 metadata | 同上 | 改 `text_color` 并查数据库 | 预览和桌面文字颜色都变；只新增 `userProperties.text_color`，图片换 metadata id，旧行被清理 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：取色弹层改 `text_color`，桌面与预览 iframe 文字色都变；先全部重置再改，metadata 全文对比只差 `userProperties: null → {"text_color":"0.2 0.8 0.4"}`，19359 → 19360，旧行及其搜索词已删 |
| [x] | 3 滑块精度与快速编辑 | 同上 | 拖 `playback_rate` 并编辑输入框 | 值落在 0.25 倍数，两位小数；快速拖动最终值落库且页面跟上，无报错 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：滑块部分通过：280ms 内来回拖 13 个位置只写一次（落 1.25），慢拖跨 10 个防抖窗口中间行全部清理，两处 `playbackRate` 跟上、无报错；输入框两位小数、输入 5 夹到 2.00。**不符合**：输入框键入 `1.3` 原样落库并推给页面，不是 0.25 的倍数（前端 `KbNumber.onInputText` 与后端 `normalize_value` 都不按步长取整），待定以哪份预期为准。**已修**（用户定：输入框也按步长取整）：`KbNumber` 新增 `stepStrictly`，WPE 带 `step` 的滑块提交前对齐；后端 `apply_changes` 写入前再对齐（`slider_writes_snap_to_step` 单测）。2026-10-31 复测：设置页「壁纸属性」弹窗里 kaguya 的 Playback Speed 真实键入 `1.3` 回车，键入时显示 1.3，回车后输入框与滑块都是 1.25，落库 1.25；后端直写 1.3 同样落 1.25，已重置 |
| [x] | 4 重置 | 同上 | 单键恢复默认、全部重置 | 对应键及空的 `userProperties` 段消失；页面恢复作者默认值 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：单键恢复 `playback_rate` 后键被删、两处速率回到 1；全部重置后 `userProperties` 整段消失，两处文字回到作者默认白色，旧行已删 |
| [x] | 5 Slideshow 分组与条件 | 同上 | 打开 Slideshow 七个组、切 `backgroundImageVisible`、选 combo | 组默认折叠，组前条目独立；条件显隐保留值；标题纯文本、HTML 说明安全排版，combo 生效 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：7 个组默认折叠，首组前 7 条独立条目；组标题按纯文本显示 `&`；108 个说明元素只剩 h3 / h4 / small / br / ul / li、无属性；开 `backgroundImageVisible` 出现 7 个条件行，Scale 设 100 后依赖 `scale > 100` 的 Panning 隐藏，关开后 Blur 9 / Scale 100 仍在；combo 在预览生效，桌面受下方「桌面导航后订阅」问题影响，重新导航订阅成功后桌面同样生效 |
| [x] | 6 语言变化 | 同上 | 有草稿时切换界面语言 | 面板重读译文，草稿仍在 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：输入框留草稿 1.4 后立即切语言，约 85ms 后标签重读为「主题配色」，草稿全程保持并最终落库；英文下面板标题为「Wallpaper Properties」 |
| [x] | 7 文件属性 | 同上 | kaguya 选壁纸目录外图片，再清空 | 预览和桌面背景都切换并恢复；选中路径无 `deny file:` | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：kaguya 选壁纸目录外 `bgA.jpg` 后两处都能读到（200、680×680），兄弟文件 `bgB.jpg` 与 `win.ini` 被拒；kaguya 页面只把它加进背景网格的「User」项（页面自身设计），预览里点「User」后背景变为 bgA；清空后键被删、两处「User」缩略图变 `none`（垫片补发了空路径）；Slideshow 的 `backgroundImage` 补足桌面证据：设置后两处 `body` 背景都变 bgA，清空后回到 `none` |
| [x] | 8 目录属性 | 同上 | Slideshow 选目录，再换目录；之后关掉预览重开、桌面切走再切回 | 两处显示新目录图片，旧目录的图停止出现（页面收到 `userDirectoryFilesRemoved`）；追加放行只增不减，换目录后、本次导航前旧目录仍可读，重开预览 / 桌面重新导航后旧目录的请求才有 `deny file:` | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：改为 dirA：两处收到 `userDirectoryFilesRemoved`（1193）与 `AddedOrChanged`（3），播放列表变 a1–a3，WeiXin 仍可读、dirB 被拒；换 dirB：两处收到 Removed / Added 各 3，重新导航前 dirA 仍可读；关掉预览重开后 dirA 与 WeiXin 被拒、dirB 可读；桌面切走再切回后 dirA 被拒、dirB 可读。桌面实时跟随受下方「桌面导航后订阅」问题影响 |
| [x] | 8b 文件白名单 | 同上 | 在预览 iframe 请求目录外文件、文件 grant 的兄弟文件、`C:/Windows/win.ini` 与三类允许文件 | 非授权请求被拒并记 deny；项目内、选中文件、选中目录内文件成功 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：新开预览 iframe 探测：项目内 `project.json`、选中文件 bgA、选中目录内 b1 成功；bgB（文件授权的兄弟）、旧目录 a1、WeiXin、`C:/Windows/win.ini`、编码穿越 `p7-dirB/%2E%2E/p7-files/bgB.jpg` 都被拒 |
| [x] | 9 设置页入口 | 同上 | 当前壁纸为网页壁纸时从设置页打开属性弹窗并修改，再切普通壁纸 | 修改同步到预览；普通壁纸不显示入口 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：当前壁纸 12099 时出现「壁纸属性」按钮，弹窗标题 Personal Slideshow；弹窗里改 `Show Image For` 落库且桌面实时收到 `applyUserProperties(imageDuration)`；外部改成 25 后弹窗重读显示 25，之后打开预览也是 25；壁纸换成 12823 后按钮消失，切回恢复 |
| [x] | 10 切图时提交 | 同上 | 预览修改后立即切下一张 | 草稿落原图，不串到下一张 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：取色器点「确定」后同步按 → 切到 12096：新颜色落在 12097（19366 → 19367），12096 仍是 17824、无 `userProperties`、无报错提示 |
| [x] | 11 弹层层级 | 同上 | 在预览弹窗里打开下拉与取色弹层 | 弹层不被预览遮住 | 2026-10-31 Claude 代理经 CDP 实测（文件 / 目录属性用 `set_wpe_web_user_properties` 直接写路径，未测系统选择对话框；`deny file:` 只在 dev 终端，放行 / 拒绝以页面 `fetch` 与 `<img>` 成败为准）：取色弹层 z-index 3059、下拉 3099，都高于预览遮罩 2000，`elementFromPoint` 命中弹层 |
| [x] | 12 桌面导航后订阅 | 同上 | 经 `set_wallpaper_by_image_id` 在网页壁纸之间切换、从普通图片切到网页壁纸，用 `Runtime.enable` / `Log.enable` 回放新文档 console | 垫片 listen 与 pull 每次都成功，桌面随后跟随属性与语言变化 | 2026-10-31 **未通过**：17 次导航进网页壁纸，12 次 `[kb-wpe] listen Origin header is not a valid URL`（`ipc://localhost/plugin%3Aevent%7Clisten` 回 500），其中 3 次 pull 也失败、桌面 Slideshow 只显示「Use the settings panel to select a directory…」；之后在页面里手动 listen 成功。原因：CEF 只在 UI 线程 `DidFinishNavigation` 里刷新 frame 的 URL 缓存，协议工厂在 IO 线程读它，新文档最早的请求到达时读到空串或旧地址，`pin_file_frame_origin` 不改写，`Origin` 仍是 `null`。同一竞态下 `cef-ipc` 回退通道会退到 webview 初始地址（应用页）判成本地来源，而 `main-capability` 覆盖 `wallpaper` 窗口，需一并修。**已修**：见上节「CEF 运行时：IPC 来源按发起方 origin 判定」。2026-10-31 复测通过（15 次导航零失败，见上节项 1） |

## CEF 运行时只往主世界注入初始化脚本

2026-10-30：x.com 畅游页右键图片会叠出两个「下载图片」菜单，点一次只收起一个。原因是 CEF 的 `DidCreateScriptContext` 不看 world_id，对主世界和每个隔离世界都回调 `OnContextCreated`，运行时 `subprocess.rs` 在回调里无差别执行全部初始化脚本。开着 DevTools 时页面里有「DevTools Performance Metrics」隔离世界，Tauri 核心脚本、i18n、toast、一键下载、地址上报、右键菜单都在里面又跑了一份；隔离世界与页面共享 DOM，两份 `contextmenu` 监听各画一个菜单，菜单项的 `stopPropagation` 让另一份收不到 click。修复：`on_context_created` 先比较回调上下文与 `frame.v8_context()`（frame 的主世界），不同就不注入。子 frame 的主世界照常注入（all-frames 脚本不受影响）。**renderer 跑在 `kabegame-cef-helper` 里，dev 的热重编只换主程序，验证前须完全重启 dev 让 helper 重编。**

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 类型检查 | Windows 本地 | `deno task check -c kabegame`（`CARGO_TARGET_DIR=target-check`） | 0 error | 2026-10-30：vue-tsc 0 error、cargo 0 error（99s），`subprocess.rs` 无 warning |
| [x] | S2 runtime 单测 | Windows 本地 | `driver.sh kabegame -p tauri-runtime-kbcef --lib`（`CARGO_TARGET_DIR=target-check`） | 全部通过 | 2026-10-30：74 passed / 0 failed |
| [x] | 0 修复前对照 | Windows CEF dev（旧 helper） | x.com 畅游页开着 DevTools，右键推文图片；按脚本内容统计各注入脚本的解析次数与执行上下文；example.com 畅游页用 CDP `Page.createIsolatedWorld` 新建隔离世界后检查全局 | 复现两层菜单；隔离世界里有注入 | 2026-10-30：页面 body 下有两个可见的「下载图片」菜单 div；菜单脚本、`surf_report_url`、`surf_collect_attach`、i18n、Tauri 核心脚本各两份，一份在主世界、一份在「DevTools Performance Metrics」隔离世界（主世界的 `DOMDebugger.getEventListeners` 只列出一份 `contextmenu` 监听，看不到隔离世界那份）。CDP 新建的隔离世界里 `__TAURI_INTERNALS__`、`__kb_i18n__`、`__kabegame_toast` 都存在 |
| [x] | 1 隔离世界不再注入 | Windows CEF dev（重启 dev 后） | example.com 畅游页用 CDP `Page.createIsolatedWorld` 新建隔离世界，检查同样三个全局 | 隔离世界里三者都是 `undefined`，主世界照旧存在 | 2026-10-31：主世界 `{tauri:object, i18n:object, toast:function}`，新建隔离世界三者全为 `undefined`；会话已关闭 |
| [x] | 2 x.com 右键菜单 | Windows CEF dev（重启 dev 后） | 开着 DevTools，右键 x.com 推文图片，点一次「下载图片」 | 只出现一个菜单，点一次即收起并开始下载；各注入脚本只在主世界解析一次 | 2026-10-31（探针 `cdp-xcom-mainworld.mjs`，DevTools 经导航栏 `surf_open_devtools` 打开）：页面有两个「DevTools Performance Metrics」隔离世界，右键菜单、地址上报、i18n、toast、Tauri 核心脚本全部只在主世界（上下文 1）解析；`Input.dispatchMouseEvent` 真实右键配图后 body 下只有 1 个可见菜单，点一次「下载图片」即收起，只弹一次「下载成功」（该图进了 dev 图库）；左键点空白处同样一次收起 |
| [x] | 3 主世界注入照旧 | Windows CEF dev（重启 dev 后） | 主窗口、壁纸窗口（`file://` 网页壁纸）、畅游页刷新后调用 invoke | 都正常；畅游启动期的三个命令各发一次 | 2026-10-31：主窗口 invoke 全程正常；x.com / example.com 畅游页的注入脚本各只在主世界解析一次（地址上报脚本 1 份）；桌面 Slideshow 壁纸页 `__kbWpeShim` 为 true、`wpe_web_pull_state` 正常（107 个用户属性键、`customdirectory` fetchall 1193 个文件、zh-chs），`get_plugins` 被 ACL 拒绝。**观察**：首次连壁纸页时它的渲染进程已崩溃（附着即收到 `Inspector.targetCrashed`，求值超时、截图 Internal error；同一页面在主窗口预览 iframe 里正常），用户终端里没有 `[CEF] renderer terminated` 日志，看门狗也没有自动重载恢复；换一张壁纸再切回后恢复。原因未查明，后续回归继续观察。2026-10-31 IPC 来源修复复测期间又一次：桌面 kaguya 页面渲染进程崩溃（附着即 `Inspector.targetCrashed`），此前十几分钟内同一页面多次求值正常，Windows 应用日志无 kabegame 崩溃记录；切到普通图片再切回后恢复。两次分别发生在 Slideshow 与 kaguya，与 IPC 改动无关（改动都在浏览器进程） |
| [x] | 4 子 frame 照常注入 | Windows CEF dev（重启 dev 后） | 图库预览 WPE 网页壁纸（`file:` iframe），看属性是否送达 | `wpe_shim.js`（all-frames）在 iframe 主世界照常运行，属性首推正常 | 2026-10-31（Phase 7 真机回归代理）：预览 iframe 里 `__kbWpeShim` 为 true，属性首推送达，之后改颜色、combo、目录等改动都跟上（见 Phase 7 项 2 / 5 / 8） |
| [ ] | 5 macOS / Linux | macOS / Linux CEF dev | 同 2、3 | 同上 | 同一份运行时代码，需对应平台 |

## tauri 补丁 13：Windows 原生 `tauri://` / `ipc://`

2026-10-30：Windows 桌面 CEF 改为直接承接原生自定义 scheme：正式版应用页为 `tauri://localhost/`，dev 与正式版 IPC 主通道均为 `ipc://localhost/<cmd>`。Android 继续走 `http(s)://<scheme>.localhost`。旧版在 x.com 等严格 CSP 页面会把 IPC 降级到 JSON 回退通道；历史版问题见 `versions/v4.6.0/regression.md`。Windows 正式版的界面本机偏好因 origin 改变会恢复默认，后端设置与图库数据应保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 补丁序列 | Windows 本地 | 生成 12 / 13，运行 `deno task patch tauri --check` | 12 只含 `ipc-protocol.js`；13 只含 `crates/tauri/`；`OK dry-run` | 2026-10-30 沙箱外复跑：`tauri: OK dry-run`；`--gen --from 12` 的输出与 `13-…patch` 逐字节一致（11 files, 34+/33-），`--gen --from 13` 为没有剩余改动。此前 codex 沙箱内： `.git/modules/third/tauri/objects` 只读，`--gen` 无法写入对象库，`--check` 报子模块未初始化；改由纯 `git diff` 生成补丁，并在临时上游基线顺序 `git apply --check` / `git apply` 01–13，全部通过 |
| [x] | S2 应用检查 | Windows 本地 | `CARGO_TARGET_DIR=D:/Codes/kabegame/target-check deno task check -c kabegame` | 0 error | 2026-10-30 沙箱外复跑：vue-tsc 0 error、cargo 0 error（62s），本次改动的文件没有 warning。codex 沙箱内两次卡在 `cef-dll-sys` 的 CMake/Ninja 阶段 |
| [x] | S3 runtime 单测 | Windows 本地 | 分别运行 `ipc::`、`protocol::` | 全部通过 | `ipc::` 8 passed、`protocol::` 5 passed，0 failed |
| [x] | S4 应用单测 | Windows 本地 | 运行 `--lib wpe_web` | 全部通过 | 2 passed，0 failed |
| [ ] | S5 Android 静态检查 | Windows 本地 | `deno task check -c kabegame --mode android --skip vue` | Android 绕行仍编译 | 构建系统报 `rusty_v8 Android 自建产物缺失: bin\android\arm64\rusty_v8-build/`，未进入编译 |
| [x] | B1 主窗口 | Windows CEF dev | 观察 invoke 请求 | `POST ipc://localhost/<cmd>` 200，本地命令可用 | 2026-10-30：`convertFileSrc(cmd, "ipc")` 返回 `ipc://localhost/<cmd>`；`get_supported_image_types`、`get_plugins` 都是 `POST ipc://localhost/…` 200、`Tauri-Response: ok`（应用页 `http://localhost:1420` 仍判为本地来源） |
| [x] | B2 壁纸窗口 | Windows CEF dev | `file:` 页 invoke `wpe_web_pull_state`、`get_plugins` | 前者成功，后者被 ACL 拒绝 | 2026-10-30：壁纸窗口在 `file://` 入口上；`wpe_web_pull_state` 经 `ipc://localhost` 返回 `imageId 12098` 与属性；`get_plugins` 报 `not allowed by ACL`（`Tauri-Response: error`），仍是远程 `file:` 来源 |
| [x] | B3 畅游 https | Windows CEF dev | 打开 `https://example.com/`，调用注入命令、尝试 `read_plugin_file`，再插入 `no-referrer` meta | 主通道 200，受限命令被 ACL 拒绝，`no-referrer` 下正常 | 2026-10-30：刷新后 `surf_collect_attach`、`surf_report_url`、`get_webview_i18n` 都是 `POST ipc://localhost/…` 200；`read_plugin_file` 报 `not allowed by ACL`；插 `no-referrer` meta 后 invoke 仍正常 |
| [x] | B4 严格 CSP 与 raw body | Windows CEF dev | 畅游 x.com 并下载视频 | 无 `connect-src` 违规和回落，`crawl_fs_fwrite` 是 raw body | 2026-10-30（`https://x.com/home`，已登录）：刷新后没有 `connect-src` 违规日志和「IPC custom protocol failed」回落警告，注入脚本三个命令都走 `ipc://localhost` 200；`read_plugin_file` 被 ACL 拒绝。未实际下载视频：改为以 `Uint8Array` 作 invoke 参数，请求为 `ipc://localhost/…`、`Content-Type: application/octet-stream`、200，即 raw body 走主通道（修复前 x.com 上主通道被 CSP 拦，只能回落 `cef-ipc` JSON） |
| [x] | B5 frame 隔离 | Windows CEF dev | 检查导航栏、图库预览 iframe、插件详情 iframe | opaque iframe 无 invoke key，不能调用 IPC | 2026-10-30：主窗口临时插入 `sandbox="allow-scripts"`、内层 `connect-src 'none'` 的 srcdoc iframe（测完移除）：`__TAURI_INTERNALS__` 为 `undefined`；`fetch(ipc://localhost/get_plugins)` 绕过 CSP 到达 handler，返回 500 `missing Tauri-Invoke-Key header`；`cef-ipc://` 返回 400 `only accepted from the main frame`。导航栏随畅游会话正常工作 |
| [x] | C1 预览 · 场景 | Windows dev，Beach 12880 | 预览里点「设为封面」 | 网格缩略图立即换新图、不整页刷新；封面在 `thumbnails_dir`，等于画布的屏幕像素，没有看板娘和留白，与画面一致；看板娘恢复；`customCover` 为 true，出现「恢复默认封面」 | 2026-11-05：点击到行更新 243 ms，封面 1070×602（窗口 1200 CSS 宽、缩放 150%），约 145 KB，无看板娘和留白，看板娘属性已移除。上一轮在 clip 路径上确认过网格只打补丁、不整页刷新，写入路径没变 |
| [x] | C2 预览 · 网页 | Windows dev，12100 | 同 C1 | 跨源 iframe 的内容截到 | 2026-11-05：159 ms，1070×602 |
| [x] | C3 暂停取帧 | Windows dev，Deep Space 12881 预览 | 暂停 → 连设两次封面 → 恢复默认 → 取消暂停 | 封面就是停住的那一帧；恢复后接着动 | 2026-11-05：时钟停在 1.565，两张封面逐像素差 0.018；取消暂停后时钟走到 3.069 |
| [x] | C5 退回场景 | Windows dev，13110 | 预览，连续采样按钮 | 没有「设为封面」，暂停开关还在 | 2026-11-05：12 s 采样 116 次，按钮一次都没出现，控制卡片在。后端不再校验实时状态，只靠按钮 |
| [ ] | D1 桌面其它平台 | macOS / Linux CEF | 冒烟主窗口、畅游、壁纸 | 原有功能正常 | |
| [ ] | D2 Android | Android 真机 | 主界面与畅游的 Channel 数据 | 正常 | |

## tauri 补丁 12：畅游 https 页面的 IPC `Origin`

2026-10-30：Windows 上 Tauri IPC 主通道原为 `http://ipc.localhost/<cmd>`，已由 13 改成 `ipc://localhost/<cmd>`。https 页面（畅游站点）按默认 referrer 策略 `strict-origin-when-cross-origin` 发旧地址属于降级，CEF 把 `Origin` 发成 `null`（页面声明 `no-referrer` 时 http 页面也一样），Tauri `ipc` handler 在 `parse_invoke_request` 回 500 `Origin header is not a valid URL`。500 让 fetch 正常 resolve，`ipc-protocol.js` 不回退 `postMessage`，畅游页注入脚本的 `surf_report_url`、`surf_collect_attach`、`get_webview_i18n` 与页面 invoke 全部失败。新增 `third-patches/tauri/12-tauri-ipc-origin-referrer-policy.patch`，给主通道 fetch 固定 `referrerPolicy: 'origin'`；`tauri-runtime-kbcef` 的 `cef-ipc` 回退 shim 同样设置。opaque 来源（`file:` 文档、沙箱 iframe）仍发 `null`，`file:` frame 由运行时 `pin_file_frame_origin` 改写，不受影响。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 补丁序列 | Windows 本地 | `deno task patch tauri --gen --from 11 --out third-patches/tauri/12-….patch`；`deno task patch tauri --check` | 只含 `ipc-protocol.js` 一处；预检通过 | 2026-10-30：1 file changed, 8 insertions, 1 deletion；`tauri: OK dry-run` |
| [x] | S2 脚本语法 | Windows 本地 | `node --check` 补丁后的 `ipc-protocol.js` 与从 `ipc.rs` 抽出的 `cef-ipc` shim | 通过 | 通过。`ipc-protocol.js` 经 `serialize-to-javascript` 的 `default_template`（`include_str!`）嵌入，cargo 会追踪它的改动；dev 增量编译后启动的 app 已带新脚本（请求的 `referrerPolicy` 为 `origin`） |
| [x] | S3 runtime 单测 | Windows 本地 | `driver.sh kabegame -p tauri-runtime-kbcef --lib -- ipc::`（`CARGO_TARGET_DIR=target-check`） | 全部通过 | 2026-10-30：`ipc::tests` 8 passed / 0 failed（driver 汇总 9 passed），0 编译 error |
| [x] | 0 修复前对照 | Windows CEF dev（补丁前） | 畅游 `https://example.com/`，invoke `get_webview_i18n`；再用本次 invoke key 手写 fetch，只改 `referrerPolicy` | 默认策略 500 | 2026-10-30：invoke 报 `Origin header is not a valid URL`，不回退；手写 fetch 默认 / `no-referrer` 为 500，`origin` / `unsafe-url` 为 200 并正常返回；CDP `Fetch` 域拦不到 CEF 处理的 `ipc.localhost` 请求 |
| [x] | 1 注入脚本启动期 IPC | Windows CEF dev | 畅游 `https://example.com/` 并刷新内容页 | `surf_collect_attach`、`surf_report_url`、`get_webview_i18n` 都 200 | 2026-10-30：三条 `POST http://ipc.localhost/<cmd>` 的 `referrerPolicy` 都是 `origin`，全部 200 |
| [x] | 2 页面 invoke 与 ACL | 同上 | 内容页 invoke `get_webview_i18n` 与 `read_plugin_file` | 前者返回，后者被 ACL 拒绝 | 2026-10-30：`get_webview_i18n` 返回文案表；`read_plugin_file` 报 `Command read_plugin_file not allowed by ACL`，说明请求已过 Origin 校验、由 ACL 裁决 |
| [x] | 3 页面声明 `no-referrer` | 同上 | 内容页与畅游导航栏页插入 `<meta name="referrer" content="no-referrer">` 后 invoke | invoke 正常 | 2026-10-30：https 内容页 invoke 正常。导航栏（`http://localhost:1420/surf-navbar.html`，http 到 http 本不降级）插 meta 后，不带显式策略的手写 fetch 变成 500 `Origin header is not a valid URL`，证明页面策略已生效，invoke 仍正常返回 |
| [x] | 4 `cef-ipc` 回退通道 | 同上 | 用本次 invoke key 直接 `window.ipc.postMessage` 调 `get_webview_i18n` 与 `get_plugins` | 前者返回，后者被 ACL 拒绝 | 2026-10-30：`POST cef-ipc://localhost/` 的 `referrerPolicy` 为 `origin`，204；`get_webview_i18n` 正常返回，`get_plugins` 报 `not allowed by ACL` |
| [x] | 5 `file:` 来源不变 | 同上 | 壁纸窗口（kaguya 的 `file://` 入口）invoke `wpe_web_pull_state` 与 `get_plugins` | 前者返回，后者被 ACL 拒绝 | 2026-10-30：`wpe_web_pull_state` 返回 `imageId 12097` 与作者属性；`get_plugins` 报 `not allowed by ACL`，仍是远程 `file:` 来源 |
| [x] | 6 主窗口 | 同上 | 主窗口 invoke | 200 | 2026-10-30：`get_supported_image_types` 为 200、ACAO `*`，主界面正常 |
| [ ] | 7 macOS / Linux 畅游 | macOS / Linux CEF dev | 畅游 https 站点，看注入脚本与 invoke | 正常 | 需对应平台。两平台的 IPC 走自定义 scheme `ipc://localhost`，补丁对它们只多一个显式策略 |
| [ ] | 8 Android | Android dev | 主界面与畅游的 Channel 数据（如下载进度） | 正常 | 需真机。Android 只有 `fetchChannelData` 走这条 fetch，补丁对它只多一个显式策略 |

## patch-manager `--gen`：从工作树生成系列之外的剩余改动

2026-10-29：`scripts/patch-manager.ts` 新增 `--gen [--from <x>] [--out <path>]`。在系统临时目录的 `GIT_INDEX_FILE` 上依次 `read-tree HEAD`、`apply --cached` 系列第一个到 `x`（含）、`write-tree` 得基线树 T1，再在同一 index 上 `add -A`、`write-tree` 得 T2，输出 `git diff --full-index --binary --no-renames T1 T2`（固定 `a/` `b/` 前缀、关掉外部 diff / textconv）。不 reset，子模块真实 index 与工作树不动（只往对象库写 blob / tree）。`--from` 接受完整文件名、去掉 `.patch` 的名字、2 位编号或路径，`none` 为纯净基线；不点名仓库时处理全部接管仓库（`rusty_v8` 需显式点名），此时 `--out` 必须是已存在的目录。验证时 `third/*` 均处于整套系列已应用状态，输出全写到会话 scratchpad。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 1 复现 06 | Windows 11，Git Bash，git 2.53 | `deno task patch cef --gen --from 05 --out <tmp>/gen-0006.patch`，与 `third-patches/cef/06-app-page-file-subresources.patch` 做 `cmp` | 逐字节一致 | `cmp` 无输出；stderr 摘要 2 files changed, 64 insertions；`--from 05-app-page-local-resources`、`--from 05-app-page-local-resources.patch`、`--from third-patches/cef/05-….patch` 三种写法也都与 06 一致 |
| [x] | 2 没有剩余改动 | 同上 | `deno task patch cef --gen`（默认 from = 06） | 提示没有剩余改动，不写文件，stdout 为空 | stderr「相对「纯净基线 + 01… … 06…」没有剩余改动,不输出 patch」，stdout 0 字节，退出码 0 |
| [x] | 3 以纯净基线为底 | 同上 | `deno task patch cef --gen --from none --out <tmp>/all.patch` | 包含 01–06 的全部改动 | 20 个文件，与 01–06 涉及文件的并集（20 个）完全相同，含 2 个 `new file mode`（`patch/patches/kabegame_*.patch`）；在另一个临时 index 上把它套到 HEAD，得到的树与依次套 01–06 的树相同（`fb0276d1…`） |
| [x] | 4 stdout 重定向 | Git Bash；PowerShell 7.6 | `deno task patch cef --gen --from 05 > <tmp>/stdout.patch` | 与 1 一致，stdout 不混入提示 | Git Bash 下与 1 和 06 均 `cmp` 一致，`Task …` 行与摘要都在 stderr；PowerShell 7.6 的 `>` 也逐字节一致（SHA256 相同） |
| [x] | 5 多仓库 | Git Bash | `deno task patch --gen`；`deno task patch --gen --out <tmp>/gen-dir/`；`deno task patch --all --gen --from none --out <tmp>/gen-dir-none` | 无 `--out` 报错；目录模式只为有改动的仓库写文件 | 无 `--out`：「--gen 处理多个仓库时请指定单个 [third-dir]…」，退出码 1。`gen-dir`：6 个仓库都没有剩余改动，未写文件，`6/6 repositories succeeded`，`rusty_v8` 提示批量跳过。`gen-dir-none`：写出 cef / cef-rs / deno / rsmpeg / rusty_ffmpeg / tauri 六份，文件数与各自系列涉及文件的并集相同，分别套到 HEAD 后的树与依次套系列的树相同；cef-rs 的 `x86_64_pc_windows_msvc.rs` 上游本身是 CRLF，按预期提示含 `\r` |
| [x] | 6 只读 | Git Bash | 上述全部运行后检查 | `third/cef` 的 `status --short` 不变、`diff --cached` 为空、HEAD 不变；主仓库 `scripts/` 只有 `patch-manager.ts` 改动 | cef 真实 index 的 SHA256 前后一致；7 个子模块 HEAD 不变、`diff --cached` 都为 0 字节；系统临时目录没有残留 `kabegame-patch-gen-*` |
| [x] | 7 检查与回归 | Windows | `deno check scripts/patch-manager.ts`；`deno lint scripts/patch-manager.ts`；`deno task patch cef --check` | 通过；`--check` 仍为 `OK dry-run` | check / lint 通过；`cef: OK dry-run` |
| [x] | 参数与错误路径 | Git Bash | `--gen -r`、`--gen --check`、`--from` 不带 `--gen`、`--from 9999`、`--out` 父目录不存在、单仓库 `--out` 指向目录、未初始化目录、`cef --all --gen` | 都报错并以非 0 退出 | 都按预期报错，退出码 1；`--from 9999` 列出系列 |
| [x] | `rusty_v8` 显式点名 | Git Bash | `deno task patch rusty_v8 --gen`；`--from none` | 能跑；跨嵌套子模块的 patch 在临时 index 上套不上时报错并指出是哪个 | 默认（到 02）报「rusty_v8/02-android-ndk-build-gn.patch 失败: build/config/android/BUILD.gn: does not exist in index」，退出码 1（02 改的是嵌套子模块 `build/`，外层 index 里只有 gitlink）；`--from none` 为没有剩余改动 |
| [x] | 新建 / 删除 / 忽略文件 | scratchpad 里的临时仓库 | 系列 01 新建被 `.gitignore` 命中的 `build/gen.txt`；工作树再改它、新增未跟踪 `sub/new.txt`、删除 `gone.txt`、新增被忽略的 `junk.log` | 收进新文件、删除与 `build/gen.txt` 的修改，不收 `junk.log`；临时仓库 index 不变 | 符合预期；`--from none` 时 `build/gen.txt` 不在 index 里，按 `.gitignore` 不被收进（设计如此） |

## WPE 壁纸导入（第二阶段 Phase 6b：图库媒体走 `file://` / CEF 补丁 06 / 插件详情 iframe 收紧）

2026-10-29：桌面 CEF 的图库媒体（原图、缩略图、兼容副本）改由前端直接给出 `file:///` URL、由 Chromium 读本地文件，不再经本地 HTTP。新增 CEF 补丁 06（`third-patches/cef/06-app-page-file-subresources.patch`，只改 `//cef`）：`ChromeContentBrowserClientCef::RegisterNonNetworkSubresourceURLLoaderFactories` 先调父类，再按 05 的同一键 `kabegame.allow_local_resources` 给非弹窗 browser 的最外层主 frame 加 `file:` 子资源工厂（工厂仍经 `WillCreateURLLoaderFactory` 包装，每个请求照样到 `OnBeforeResourceLoad`；CORS 模式的 `file:` 请求仍被拒）。`tauri-runtime-kbcef` 的 `resource_request_handler` 按发起 frame 分档：应用页主 frame 的子资源（非导航、主 frame，`request_initiator` 非空非 `null` 且与 `frame.url()` 都不是 `file:`）在登记了 05 时免检（新增 `file_access::app_page_open`），子 frame / 主 frame 的导航与 `file:` 文档的子资源仍过根目录闸门；`FileDocumentGuardHandler` 未改。`startup.rs` 主窗口的 05 改为三个桌面平台都登记（04 仍只 Windows），壁纸窗口新增登记 05。前端 `utils/fileUrl.ts` 新增 `pathToFileUrl` 与 `fileToHttpUrl` / `thumbnailToHttpUrl` / `compatibleToHttpUrl`，三个 `*ToUrl` 在桌面返回 `file://`（Android / Web 不变）；下载与复制兜底（`useImageOperations`）改走 `*ToHttpUrl`，Windows 拖出（`ImageContent`）按触发元素所属渲染槽当前源等级取 `/file` / `/compatible` / `/thumbnail`，不再用 `currentSrc`；CSP 模板 `img-src` / `media-src` 加 `file:`。插件详情 EJS iframe 去掉 `allow-same-origin`，srcdoc 最前面加内层 CSP（`connect-src 'none'; frame-src about:` 等，nonce 注入保留）；删除本地 HTTP 服务（含 web 版两套路由）的 `/proxy` 与 vite dev 代理项。Windows 真机已于 2026-10-30 按下表验证（前提：用户重编 CEF 带上 06（MSYS2：`CEFBUILD=D:/Codes/cefbuild deno task build:chromium`），再完全重启 `deno task dev`；运行时、`startup.rs` 与 CSP 模板都改了，gitignore 的 `tauri.conf.json` 要由模板重新生成），Linux / macOS 待测。观测改用会话内裸 CDP 探针（直连单个 target 的 WebSocket、不经 playwright，避免附着 OOPIF 后留下 `Debugger paused`；未入库）；开发进程 stderr 的 `deny file:` 日志由用户目视，表中以 CDP 看到的请求失败为准。主窗口被遮挡 / 最小化时 `visibilityState` 为 `hidden`，网格的 `loading="lazy"` 缩略图不发请求，探针需先开 CDP `Emulation.setFocusEmulationEnabled`（playwright 连接时默认开，所以 `driver.sh` 看到的是 `visible`）。测试壁纸：kaguya `3679122549`、Slideshow `796697921`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 1 画廊缩略图 | Windows 桌面 CEF dev（新 CEF） | 打开画廊，CDP `Network` 观察缩略图请求 | 请求是 `file:///…/thumbnails/<uuid>.jpg` 且成功；stderr 没有 `deny file:` | 2026-10-30 真机：重载画廊后首屏 22 条缩略图请求全是 `file:///D:/Codes/kabegame/.kabegame/debug/data/thumbnails/<uuid>.jpg` / `.mp4` 且 200（图片 14、视频预览 8），另 3 条 WPE 行的 `preview.gif`（创意工坊目录）200；之后连续翻 5 页，每页新增 24 条全部 200，网格 `<img>` 全部 `complete`、无非 `file:` 源；CDP 无请求被拒、无 CSP / `Not allowed` 日志（stderr 由用户目视）。视频预览偶见首个 `bytes=0-` 请求 `ERR_ABORTED`：是媒体加载器读够后取消，元素 `readyState=4`、无 error，不是闸门拒绝 |
| [x] | 2 预览原图 / 视频 | Windows 桌面 CEF dev | 预览原图（PhotoSwipe）；播放视频原图并拖动进度条；播放一条 WPE 视频行 | `file:///<下载目录>/…` 成功；视频可拖动（Range 由 `FileURLLoader` 原生处理）；WPE 视频行的 `compatible_path`（创意工坊目录内）正常播放 | 2026-10-30 真机（深链接打开预览）：12823 原图层 `file:///E:/Pictures/Kabegame/…(7).jpg` 200、`naturalWidth` 1290；视频 10249 `file:///E:/…movie(1).mp4` `readyState=4`，`currentTime` 跳到 60% 依次 `seeking` → `waiting` → `seeked` → `playing`，Range 请求 `bytes=9076736-`、`bytes=3145728-` 成功（首个 `bytes=0-` 被媒体加载器取消属正常）；WPE 视频行 12091 的 `…/2725770343/Wallpaper-1.mp4` 播放并跳到 71 s 正常，12092 中文文件名 `初音.mp4` 同样正常。另：原图缺失的 9864 的 `file://` 请求为 `ERR_FILE_NOT_FOUND`（不是闸门），预览回退显示缩略图 |
| [x] | 3 壁纸窗口 | Windows 桌面 CEF dev | 窗口模式分别设图片、视频壁纸；样式切到平铺 | 经 `file://` 显示；平铺模式 CSS 背景图正常 | 壁纸窗口新登记 05。2026-10-30 真机（裸 CDP，`set_wallpaper_by_image_id` 12098 → 12823 → 10249 → 12823，再 `set_wallpaper_style` `tile` → `fill`，最后回 12098）：壁纸窗口离开网页壁纸回到 `index.html?window=wallpaper`，`img.wallpaper-img.base` 为 `file:///E:/…(7).jpg`、`naturalWidth` 1290；视频 `video.wallpaper-img.base` 为 `file:///E:/…movie(1).mp4`、`readyState=4` 且在播放；平铺时 `<img>` 隐藏，`.wallpaper-tile.base` 为 `display: block`、铺满 2560×1440，`background-image` 是同一个 `file:` URL（`repeat`），同一 URL 在壁纸窗口里可解码为 1290×2796。测完恢复为 12098 / `fill`，窗口回到 `3756621387/index.html`；副作用是这几张图的 `lastSetWallpaperAt` 被刷新 |
| [x] | 4 WPE 预览仍受限 | Windows 桌面 CEF dev | 预览 kaguya，iframe 内 `fetch('../796697921/project.json')`、插 `<img src="file:///C:/Windows/…">`；复跑 05 小节用例 1–4 | 越界两项都被拒，stderr 各一条 `deny file: … OutsideRoot`；入口与同目录子资源照常 | 子 frame 导航 / `file:` 文档档。2026-10-30 真机（裸 CDP 直连 `file:` 预览 iframe target，跑了两遍）：iframe `src` 为 kaguya 入口、`origin` 为 `file://`；`./project.json` 200、`data.json` 200，同目录 `<img src="./preview.jpg">` 988×988；`../796697921/project.json`、`../796697921/preview.jpg`、`file:///C:/Windows/win.ini`、`<img src="file:///C:/Windows/Web/Wallpaper/Windows/img0.jpg">` 都是 `ERR_ABORTED`（stderr 由用户目视）；`parent.document` 与 `parent.__TAURI_INTERNALS__` 为 `SecurityError`，自身 `__TAURI_INTERNALS__` 为 `undefined`，伪造 `cef-ipc` 回 400；主窗口没有 `about:blank#blocked`、崩溃或主 frame 导航；12s 后页面完整（背景、封面、歌名、播放器、MV）。页面自己探测不存在的 `thumb/bgNNN.png` 被拒后回退到 `.jpg`（同 05 用例 11）。关闭预览后 iframe 已移除，并调用了 `set_wpe_web_preview(null)` |
| [x] | 5 应用页主 frame 放开 | Windows 桌面 CEF dev | 不打开预览，主窗口顶层（CDP）插 `<img src="file:///D:/Codes/kabegame/docs/images/icon.png">`；顶层 `fetch('file:///…')`；把该图画到 canvas 后 `toBlob` | `<img>` 显示；`fetch` 失败（CORS）；`toBlob` 抛 `SecurityError`（canvas 被污染） | 05 小节用例 5 的 `<img>` 预期由 `error` 变为显示。2026-10-30 真机（预览未打开）：顶层 `<img>` 加载成功（824×824）；同一 URL 的顶层 `fetch` 与 XHR 都是 `ERR_FAILED`（`CorsDisabledScheme`）；`drawImage` 后 `toDataURL`、`toBlob`、`getImageData` 都抛 `SecurityError`；`crossOrigin="anonymous"` 的 `<img>` 同样被 CORS 拒绝。插入的元素已全部移除 |
| [x] | 6 插件详情 iframe | Windows 桌面 CEF dev | 打开 pixiv / bilibili 图片详情；iframe 内 `fetch("https://example.com")`、读 `window.parent.document` 与 `window.parent.__TAURI_INTERNALS__`、插 `<iframe src="file:///…">`；点外链；打开 `kabegame-server` 插件对畅游 / 网页收集来源的快照 | 配图照常；`fetch` 被 CSP 拒；`parent` 两项 `SecurityError`；`file:` iframe 被拒（opaque 源过不了 `CanDisplay`，在 CSP 之前就拦下；http(s) frame 由 CSP `frame-src about:` 拒）；`__bridge.fetch` 仍工作（pixiv 模板的 blob 图显示）；外链能打开；嵌套 `sandbox=""` srcdoc 快照照常显示 | 另确认 `base-uri 'none'` 下 `__bridge` 的相对 href 解析正常。2026-10-30 真机（pixiv 10915、bilibili 8970；详情 iframe 是独立的 `about:srcdoc` OOPIF，裸 CDP 直连）：`origin` 为 `null`，内层 CSP 生效；`fetch("https://example.com")` 报 `connect-src 'none'`；`parent.document` 与 `parent.__TAURI_INTERNALS__` 为 `SecurityError`，自身 `__TAURI_INTERNALS__` 为 `undefined`；`__bridge.fetch("https://example.com/")` 约 1.2–1.7s 返回 `{base64, contentType}`，`getLocale()` 返回 `zh`；pixiv 作者头像经 `__bridge` 转为 blob 后显示（50px），标题 / 标签 / 统计 / 评论贴图都正常，bilibili 详情正常。插入 `<iframe src="file:///…">` 时控制台报 `Not allowed to load local resource`，没有 `securitypolicyviolation`、也没有 `file:` 请求，所以预期按实测改写；插入 https iframe 时报 `frame-src about:` 违规；嵌套 `sandbox=""` srcdoc iframe 正常加载。`document.baseURI` 继承父页 `http://localhost:1420/gallery?…`，`new URL("artworks/1", baseURI)` 能解析，`__bridge` 的相对 href 不受影响。**未测**：外链点击（会打开外部浏览器）；页面快照显示（库里没有带快照的畅游 / 网页收集图，也没有 `kabegame-server` 来源）。另：pixiv 评论区头像是模板直接写 `<img src="https://i.pximg.net/user-profile/…" referrerpolicy="no-referrer">`，没有经过 `__bridge`，因为没有 Referer 被 pximg 拒绝（14 张破图，没有 `img-src` 违规），属于插件模板的既有问题 |
| [ ] | 7 Windows 拖出 | Windows 桌面 CEF dev | 从网格 / 预览把图片、视频各拖一个到资源管理器；再拖一张原图缺失、已回退到缩略图的 | 都得到文件；`DownloadURL` 为 `http://127.0.0.1:<P>/…`，按当前显示的源取 `/file` / `/compatible` / `/thumbnail` | 由 Phase 6d 取代（`DownloadURL` 路线放弃）。**需人工**：CDP 无法模拟拖放到资源管理器（Windows 的 `CF_HDROP` 由系统拖放生成），所以未勾选。2026-10-30 真机做了部分验证：给元素派发带 `new DataTransfer()` 的合成 `dragstart`，读取页面写入的载荷——网格图片 / 视频是 `/thumbnail/…`（和显示源一致；6b 前取的 `currentSrc` 也是缩略图）；预览原图层是 `image/jpg:<名>:http://127.0.0.1:3883/file/E%3A%5C…`，预览缩略层是 `/thumbnail/…`；视频原片是 `/file/…mp4`；缩略图和原图同路径的 8970 归并为 `/file/…`；原图缺失、回退到缩略图的 9864 是 `/thumbnail/…`；WPE 行（网格与预览）为 `draggable=false`，`dragstart` 被取消。以上 URL 用 curl 下载都是 200，字节数与原文件一致。剩下需要人工确认的是：真的拖到资源管理器后能得到文件 |
| [x] | 8 复制与特殊目录 | Windows 桌面 CEF dev | 复制图片到剪贴板；本地文件夹同步画册与 WPE 创意工坊目录里的图各打开一张；下载一张图 | 复制正常（桌面走后端命令）；两类目录的图都显示；下载得到原文件 | 2026-10-30 真机：`invoke("copy_image_to_clipboard", { imageId: "9949" })`（同步画册 `test` 中的 `single-file-import\1 _27_.jpeg`）返回成功，系统剪贴板 `ContainsImage=True`、1968×2528，与原图一致；这条命令耗时约 10s，后端命令在 6b 中未改动，仅作观测记录。同步画册图片的预览原图层 `file:///E:/Pictures/Kabegame/single-file-import/1%20_27_.jpeg` 200；创意工坊目录方面，网格里的 `preview.gif` 200，WPE 视频行 12091 / 12092 的预览可正常播放（见用例 2）。下载：桌面端右键菜单没有下载项（只在 Web 版），不适用 |
| [x] | 9 `/proxy` 已删除 | Windows 桌面 CEF dev | `curl "http://127.0.0.1:<port>/proxy?url=https://example.com"` | 404（`not found`） | 2026-10-30 真机：`curl --noproxy '*' "http://127.0.0.1:3883/proxy?url=https://example.com"` 返回 404，响应体为 `not found`。另确认 `/file`、`/thumbnail`、`/compatible` 对库内路径仍返回 206（Range），库外路径 `/file/C%3A%5CWindows%5Cwin.ini` 返回 404 |
| [x] | 10 稳定性 | Windows 桌面 CEF dev | `probe-observe.mjs <port> 60` 期间翻页、开关预览 | 无 `[CRASH]`、无整窗 reload | 2026-10-30 真机（裸 CDP 观察主窗口的 `frameNavigated` / `loadEventFired` / `Inspector.targetCrashed`，以及浏览器级 `Target.targetCrashed`，没有用 playwright）：第一轮 60s，打开 kaguya 预览后关闭，翻页 7 次，双击网格项开关图片预览 7 轮；第二轮 40s，双击第 8 页底部的 5 个网页壁纸条目（kaguya / Slideshow / `3677233365` / `corsair_o_tron` / `corsair_collection`），每个开关 2 轮，每轮 iframe 都加载到对应入口。两轮都没有 `[CRASH]`、主 frame 导航、load 事件或 `wpe web entry` 超时日志；`target destroyed` 只是关闭预览时销毁的 iframe target。Slideshow 的 `index.html` 与脚本都不引用 `keyframes.html`，它是独立页面，不是嵌套子页 |
| [x] | 11（可选）首屏对比 | Windows 桌面 CEF dev | 同一页 500 张缩略图在 HTTP（旧构建）与 `file://` 下的首屏加载时间（CDP `Performance` 或肉眼） | 记录数值 | 2026-10-30 真机，只有 `file://` 的数值，没有 HTTP 旧构建对照。本机每页 1000 张，网格虚拟化，视口内约 24 项。重载后首屏 22 条缩略图的单请求耗时 p50 2.1ms、max 3.0ms，从首条请求到末条完成 25ms；从文档请求到最后一张缩略图完成 3.9s（包括应用启动与取数）。翻页（窗口可见时）：赋 `src` 后约 110ms 全部触发 load；冷盘页单请求 90–400ms，热缓存 3–6ms。`performance.getEntriesByType("resource")` 不包含 `file:` 条目，所以数值取自 CDP `Network` 时间戳。偶发一次：第 7 页第一次打开时，24 条请求里有 23 条在 8s 内没有响应；随后同页重测 8ms 就完成，此后没有再复现 |
| [ ] | Linux | Linux 桌面 CEF dev（新 CEF） | 复跑 1、2、5、6、8、9、10（无 WPE；Linux 没有窗口壁纸模式，不涉及 3；拖出走真实文件链路，不涉及 7） | 同 Windows | 待测 |
| [ ] | macOS | macOS 桌面 CEF dev（新 CEF） | 复跑 1–3、5、6、8、9、10（无 WPE；macOS 拖出走真实文件链路，不涉及 7） | 同 Windows | 待测 |
| [x] | 静态检查 | Windows（check-kabegame） | `deno task check -c kabegame`（`CARGO_TARGET_DIR=target-check`）；改动的前端文件 `prettier --check`；`grep -rn "/proxy\|handle_proxy_query\|ProxyQuery" apps src-tauri scripts cocs` | vue-tsc / cargo check 0 error；格式通过；grep 只剩历史说明 | 2026-10-29：vue-tsc 0 error、cargo check 0 error；改动文件无新 warning（`kabegame` lib 29 → 27：顺手清掉 `http_server.rs` 原有的未用参数 `uri` 与死结构 `PluginDocImageQuery`；`startup.rs` 剩下的 3 条未用 import 是既有的、不在改动行）；prettier 通过（`vite.config.ts` 删一项后数组折成一行、`ImageContent.vue` 一处既有换行被一并格式化）；grep 只剩文档里的删除说明与无关的 `commands/proxy.rs` / `EventLoopProxy` |
| [x] | 单测 | `test-kabegame` + 前端 vitest | `kabegame -p tauri-runtime-kbcef --lib -- file_access http_server wpe_web web_entry`（`CARGO_TARGET_DIR=target-check`）；`apps/kabegame` 下 `deno task test` | 全部通过；新增 `app_page_open_follows_registration`（未登记 / 只登记 04 不免检，登记 05 免检且与根目录设清无关，补登不清根目录）；`fileUrl.test.ts` 覆盖桌面 `file:///C:/…`、UNC、扩展长度前缀、百分号、中文、POSIX 反斜杠，Android / Web 仍走 HTTP，HTTP 断言迁到 `*ToHttpUrl` | 2026-10-29：Rust 20 passed / 0 failed（`tauri-runtime-kbcef` 的 `file_access` 12 条含新增 1 条；`kabegame` 的 `http_server` 3、`wpe_web` 2、`web_entry` 3）；`fileUrl.test.ts` 65 passed；全量 vitest 600 passed，另有 `KameToolboxBubble.test.ts` 整个文件加载失败（`@kabegame/i18n` 的 mock 缺 `i18n` 导出，链路是 `4d28f682` 引入的 `BusyBackfillCard` → `utils/backfillName.ts`，与本节无关） |

## CEF 补丁 05：应用页加载本地资源

2026-10-29：图库预览的网页壁纸 iframe 改回由前端赋 `src = 入口 file://`，应用页能加载 `file:` 子 frame 靠新增的 CEF 补丁 05（`third-patches/cef/05-app-page-local-resources.patch`，只改 `//cef`）：建窗 `extra_info` 的 bool 键 `kabegame.allow_local_resources`，渲染侧在最外层主 frame 每次提交非 `file:` 文档时 `SecurityOrigin::GrantLoadLocalResources`（放过 `CanDisplay`，`CanRequest` 不变），浏览器侧给该主 frame 所在进程 `GrantRequestScheme(file)`（放过导航的 `FilterURL`），弹窗里提交的文档 / DevTools / OOPIF / fenced frame 不授（弹窗的初始 `about:blank` 空文档按 Blink 自身规则从 opener 继承，见用例 10）；补丁只开门，加载哪些文件仍由运行时闸门按根目录裁决。`tauri-runtime-kbcef` 的 `file_access` 表值改为 `FilePolicy { file_documents, app_local_resources, root }`（登记任一能力即开闸门），新增公开 API `allow_app_local_resources`，建窗时按 `extra_info_keys(label)` 循环写键；删除运行时的子 frame 导航 API。`startup.rs` 主窗口同时登记 04 与 05；`set_wpe_web_preview` 改为返回 `Option<String>`（`Some(id)` 设根目录后返回入口、不导航，`None` 清根目录）；前端 `setWpeWebPreview` 返回入口，`createWebFrame` 拿到入口后赋 `src`，删除 iframe 名字与 3s 补发，8s 超时仍停在初始 `about:blank` 时记 `wpe web entry not navigated (CEF patch 05 missing?)`，否则 `wpe web entry load timeout`。`wpe_shim.js`、CSP `frame-src … file:` 与 `on_render_process_terminated` 的无条件 reload 未改。静态验证见本节末两行；补丁文件本身与 `deno task patch cef --check` 由补丁侧验证，不记在本节。**真机未验证**：需用户先重编 CEF（MSYS2：`CEFBUILD=D:/Codes/cefbuild deno task build:chromium`），再完全重启 `deno task dev`（运行时与 `startup.rs` 都改了）。观测用会话内临时探针 `probe-observe.mjs <port> <秒>`（导航 / frame / crash 事件）与 `probe-file-guard.mjs <port> <入口>`（`file` 子 frame 内越界与隔离；其「没有 file 子 frame 就 `goto`」回退分支不应再被走到），未入库。测试壁纸：kaguya `3679122549`、Slideshow `796697921`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 0（可选）重编前反向对照 | Windows 桌面 CEF dev，**旧 CEF** + 新代码 | 预览 kaguya | 8s 后报 `wpe web entry not navigated (CEF patch 05 missing?)`，控制台 `Not allowed to load local resource`；**无** `[CRASH]`、无整窗 reload | 用来确认前端不再触发渲染进程被杀 |
| [x] | 1 入口加载 | Windows 桌面 CEF dev（新 CEF） | 预览 kaguya，`probe-observe.mjs` 观察 | `framenavigated … file:///…/3679122549/index.html`；无 `about:blank#blocked`、无 `[CRASH]`、无 `framenavigated MAIN`；页面完整（背景、封面、歌词、播放器） | 2026-10-29 真机：iframe `src` 为 kaguya 入口，`contentWindow.location` 跨源 `SecurityError`（真 `file:` 文档）；无崩溃、无整窗导航；页面显示正常 |
| [x] | 2 同目录 fetch | Windows 桌面 CEF dev | 预览 iframe 里 `fetch("data.json")` / `fetch("project.json")` | 200；stderr 没有它们的 `deny file:` | 2026-10-29 真机：`project.json` 200 |
| [x] | 3 越界拒绝 | Windows 桌面 CEF dev | 预览 iframe 里 `fetch('../796697921/project.json')` 与 `fetch('file:///C:/Windows/win.ini')`（`probe-file-guard.mjs`） | 都失败；stderr 各一条 `[cef-runtime] deny file: … (outside <kaguya 目录>; OutsideRoot) webview 'main'` | 2026-10-29 真机：两者 `TypeError: Failed to fetch`，CDP 见 `ERR_ABORTED`（闸门取消） |
| [x] | 4 隔离 | Windows 桌面 CEF dev | 预览 iframe 里读 `window.parent.document`、`window.__TAURI_INTERNALS__`；伪造 `fetch("cef-ipc://localhost/", { method: "POST" })` | `SecurityError`；`undefined`；伪造请求不触发任何命令 | 2026-10-29 真机：`parent.document` / `parent.__TAURI_INTERNALS__` 均 `SecurityError`，自身 `__TAURI_INTERNALS__` 为 `undefined`，伪造 `cef-ipc` 回 400 |
| [x] | 5 应用页无新读权限 | Windows 桌面 CEF dev | 预览打开时，主窗口顶层（CDP）`fetch('file:///C:/Windows/win.ini')`；顶层插 `<img src="file:///…/3679122549/preview.jpg">` | `fetch` 失败；`<img>` 触发 `error`（非 `file:` 文档没有 file URLLoaderFactory，06 之前的预期） | 2026-10-29 真机：顶层 `fetch` 被 CORS 拦（`Failed to fetch`，`ERR_FAILED`）；`<img>` 触发 `error`（`ERR_UNKNOWN_URL_SCHEME`）。6b 后 `<img>` 可显示，见 6b 用例 5 |
| [x] | 6 关闭预览后清根 | Windows 桌面 CEF dev | 关闭预览后，主窗口顶层插入同一入口的 `file:` iframe | iframe 无内容；stderr `deny file: … (outside <none>; NoRoot) webview 'main'` | 2026-10-29 真机：同入口 iframe `ERR_ABORTED`，停在 `about:blank`、body 为空 |
| [x] | 7 切换 | Windows 桌面 CEF dev | 预览 kaguya ↔ Slideshow ↔ 图片来回切 | 每次新 iframe 加载新入口、旧目录的请求被拒；Slideshow 的 `keyframes.html` 子页正常；属性首推、语言切换重拉照常 | 2026-10-29 真机：网格打开 12098（阿洛娜 `3756621387`）新 iframe 加载新入口；预览内方向键 kaguya → `3677233365` → `corsair_collection` → 图片 → 回来，根目录随之换、旧目录被拒（见 6a 小节「预览切图换根」）；属性首推、换 listener 补投、语言切换重拉见「属性仍到达」。只剩 Slideshow（`796697921`，不在相邻条目里）的 `keyframes.html` 子页未专门打开。早先 playwright 探针断开后曾留下一个 iframe 停在「Debugger paused」，与补丁无关，后续探针已改为裸 CDP |
| [x] | 8 稳定性 | Windows 桌面 CEF dev | 60s 内反复开关预览 10 次（`probe-observe.mjs <port> 60`） | 无 `[CRASH]`；stderr 无 `renderer terminated for webview 'main'`；无整窗 reload | 05 前的绕行就是在这里出整窗刷新循环；2026-10-29 真机：CDP 点关闭按钮 / 网格项开关 10 轮（9 轮有效，1 轮因关闭动画时序脚本没点中），无 `[CRASH]`、无 load 事件、无超时报错；`framenavigated MAIN` 只是 SPA query 变化 |
| [x] | 9 壁纸窗口调用被拒 | Windows 桌面 CEF dev | 壁纸窗口（`wallpaper` label）invoke `set_wpe_web_preview` | 被拒：`set_wpe_web_preview is not available in the wallpaper window` | 2026-10-29 单测 `commands::wpe_web::tests::preview_root_rejects_wallpaper_window` 通过；真机：壁纸窗口停在 `index.html?window=wallpaper` 时经 CDP `invoke("set_wpe_web_preview", { imageId: "12097" })`，返回同一条错误 |
| [x] | 10 弹窗不带能力 | Windows 桌面 CEF dev | 主窗口 `window.open("about:blank", "_blank", "popup")`（需用户手势）开出的弹窗：a. 初始 `about:blank` 里顶层插 `file:` iframe；b. 弹窗导航到 `index.html` 后再插 | a. 初始空文档按 Blink 规则继承 opener 的 `CanDisplay`：根目录匹配时能加载、越界时被闸门 `ERR_ABORTED`；b. 提交真实文档后 `Not allowed to load local resource`，iframe 不出内容（补丁两侧都不授弹窗提交的文档；运行时弹窗路径也不写键） | 2026-10-29 真机（裸 CDP）：a. `origin=null`、`opener=true`，入口与当前根目录相同时 `response 200`、跨源 `SecurityError`；入口越界时 `loadingFailed ERR_ABORTED`、停在 `about:blank`。b. 导航到 `http://localhost:1420/index.html` 后插同一入口：`[log.error] Not allowed to load local resource`、`timeout`、body 0。预期按实测改写：初始空文档的继承是 `DocumentLoader::CalculateOrigin` 的既有行为，弹窗沿用主窗口 client、仍受闸门约束，WPE iframe 无 `allow-popups` 开不了弹窗 |
| [x] | 11 04 不回退 | Windows 桌面 CEF dev | 窗口模式设 kaguya 为壁纸；再切回图片壁纸，在壁纸窗口应用页（CDP）顶层插 `file:` iframe | 网页壁纸照常加载并能 fetch 同目录；壁纸窗口应用页的 `file:` iframe 被拦（`Not allowed to load local resource`，壁纸窗口未登记 05） | 2026-10-29 真机（裸 CDP，`set_wallpaper_by_image_id` 9079 → 12097 → 9079）：壁纸窗口整窗到 `3679122549/index.html`，`fetch("./project.json")` 200、`win.ini` 被拒（stderr `OutsideRoot`，页面探测不存在的 `bg*.png` 按 `NotFound` 拒绝属正常）；切回后壁纸窗口应用页插同入口 iframe → `[log.error] Not allowed to load local resource`、无内容。待观察：切到网页壁纸时偶见 `http://ipc.localhost/plugin:event\|listen` 回 500（一次 3 条、一次 1 条、一次 0 条），垫片未打印 `[kb-wpe] listen` 警告，属性与语言链路未见异常，疑为旧文档导航中断的请求 |
| [x] | 12 6a 旧项照旧 | Windows 桌面 CEF dev | 预览里写 `localStorage` 后切到桌面壁纸（同一张）读取，再反向；应用背景层遇到网页壁纸 | `localStorage` 两边都是 `file://` 源，但按顶层站点分区（预览 iframe 的顶层是 `localhost:1420`，桌面是 `file://` 自身），**互不可见**，各自跨重启稳定；背景仍只用缩略图 | 2026-10-29 真机：预览 iframe 写 `kb-0005-case12`，壁纸窗口读为 `null`；壁纸窗口写 `kb-0005-wp`，预览 iframe 读为 `null`（两边 `hasStorageAccess()` 都为 true、各自 keys 不同）——6a 第 7 条「互通」的预期按实测改为「分区、不互通」。kaguya 为壁纸时主窗口 `.app-background-media` 的 `<img src>` 是 `thumbnail/…/3679122549/preview.jpg` |
| [x] | 静态检查 | Windows（check-kabegame） | `deno task check -c kabegame`（`CARGO_TARGET_DIR=target-check`）；`grep -rn "navigate_frame\|WPE_PREVIEW_FRAME_NAME\|kb-wpe-preview\|WEB_NAV_KICK_MS\|webKickTimer" apps src-tauri cocs AGENTS.md .claude/plans/wpe-import versions/latest` | vue-tsc / cargo check 0 error；grep 只剩历史说明 | 2026-10-29：vue-tsc 0 error、cargo check 0 error，与改动相关的文件无新 warning；grep 只剩 phase-6a「实施记录」与本文件 6a 节的历史说明 |
| [x] | 单测 | `test-kabegame` | `kabegame -p tauri-runtime-kbcef --lib -- file_access wpe_web web_entry`（`CARGO_TARGET_DIR=target-check`） | 全部通过；新增 `extra_info_keys_follow_registration`（只登记 05 也开闸门、两键顺序固定为 04 → 05、再登记不清根目录） | 2026-10-29：16 passed / 0 failed（`tauri-runtime-kbcef` 的 `file_access` 11 条含新增 1 条；`kabegame` 的 `wpe_web` 2 条 + `web_entry` 3 条） |

## WPE 壁纸导入（第二阶段 Phase 6a：预览 iframe 改走 `file://`）

2026-10-28：图库预览的网页壁纸 iframe 改为加载入口 `file://`（入口与根目录都由 Rust 用 `wallpaper::web_entry` 现算，与桌面壁纸窗口共用）；主窗口建窗前 `tauri_runtime_kbcef::allow_file_documents("main")`，`WallpaperStage` 建一个 `name="kb-wpe-preview"`、不设 `src` 的 iframe，插入 DOM 后 `await set_wpe_web_preview(imageId)` 设根目录并由 `tauri_runtime_kbcef::navigate_frame` 从浏览器进程导航、`teardownWeb` 清空（`wpeWebBridge.ts` 的 `setWpeWebPreview` 串行执行），命令只在 `permissions/main.toml`、按 label 拒绝壁纸窗口；垫片预览判定改为 `!isTop && window.parent === window.top && location.protocol === "file:"`，宿主桥 `postMessage` 目标源改 `"*"`；CSP `frame-src` 加 `file:`、删 `http://127.0.0.1:*`（模板与生成的 `tauri.conf.json` 都已改）；删除 `/wpe` HTTP 目录服务（路由、MIME 表、`serve_wpe_html`、单测）与前端 `wpeEntryUrl`；`platform_supported()` 收窄到 Windows，`web_entry` 非 Windows 恒为 `Ok(None)`，两处 `allow_file_documents` 按 Windows 门控。`file_access.rs` 与 CEF / tauri 补丁未改；`tauri-runtime-kbcef` 只新增公开 API `navigate_frame`。静态验证：check-kabegame 的 vue-tsc 与 cargo check 均 0 error（`CARGO_TARGET_DIR=target-check`）；单测见下表末三行。**已证实被拦；随后的浏览器进程导航绕行已由 CEF 补丁 05 取代**：最初实现让应用页给 iframe 赋 `src = file:///…`，真机上 Blink 在渲染进程的 `SecurityOrigin::CanDisplay` 拦下这次渲染进程发起的导航（控制台 `Not allowed to load local resource`，iframe 停在 `about:blank`）；10-28 改为前端不设 `src`、由 Rust 从浏览器进程按名字导航子 frame（上文所述），真机上渲染进程被杀并被无条件 reload 放大成整窗刷新循环。2026-10-29 起改为补丁 05 + 命令返回入口、前端赋 `src`，`WallpaperTarget.webEntry` 仍删除，见上节「CEF 补丁 05：应用页加载本地资源」与 phase-6a「实施记录」。**真机未验证**：dev 由用户运行；本节各项在用户重编 CEF、完全重启 `deno task dev` 后与上节一起复测。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 预览加载 `file:` 入口 | Windows 桌面 CEF dev | 预览 kaguya（`3679122549`）；`targets` 看主窗口下的子 frame URL | 子 frame URL 是 `file:///…/3679122549/index.html`；页面完整（背景、封面、歌词、播放器），`fetch("data.json")` 成功，stderr 没有它的 `deny file:` | |
| [x] | 属性仍到达 | Windows 桌面 CEF dev | 预览里观察 `wallpaperPropertyListener`；Phase 5 的预览回归项在 `file:` 下重跑一遍 | 收到首推；换 listener 补投、语言切换重拉照常 | 2026-10-29 真机（裸 CDP，kaguya 预览）：页面自己的 listener 已有 `applyUserProperties` / `applyGeneralProperties`；替换成探针 listener 后立即补投一次（`applyUserProperties` 6 键、`applyGeneralProperties({ language: "zh-chs" })`，说明首推已发生）；主窗口 `set_language("en")` 后 iframe 只多收到 `applyGeneralProperties({ language: "en-us" })`，`set_language("zh")` 后再收 `zh-chs`，`applyUserProperties` 没有重投；无 `[kb-wpe]` 警告 |
| [x] | 越界拒绝 | Windows 桌面 CEF dev | CDP 在预览 iframe 里 `fetch('file:///C:/Windows/win.ini')` 与 `fetch('../796697921/project.json')` | 都失败，stderr 各有一条 `deny file: … webview 'main'` | 2026-10-29 真机：两者 `TypeError`、CDP `ERR_ABORTED`；dev stderr `deny file: file:///C:/Windows/win.ini (outside …\3679122549; OutsideRoot) webview 'main'` 与 `…/796697921/project.json (… OutsideRoot) webview 'main'` 各一条；同目录 `project.json` 200 |
| [x] | 关闭预览后清根 | Windows 桌面 CEF dev | 关闭预览后在主窗口应用页里（CDP 顶层）插同入口的 `file:` iframe；另试顶层 `fetch('file:///C:/Windows/win.ini')` | iframe 无内容，`deny file: … (outside <none>; NoRoot) webview 'main'`；顶层 `fetch` 失败 | 2026-10-29 真机：iframe `ERR_ABORTED`、body 0，stderr `deny file: …/3679122549/index.html (outside <none>; NoRoot) webview 'main'`。顶层 `fetch` 在渲染进程就被 CORS 拦（`Cross origin requests are only supported for protocol schemes…`、`ERR_FAILED`），到不了闸门、不会产生 `NoRoot` 行，所以操作改为用 iframe 验清根 |
| [x] | 预览切图换根 | Windows 桌面 CEF dev | 预览切图 web → 图片 → web、web → 另一张 web | 根目录随之换；旧壁纸目录的请求在新预览里被拒 | 2026-10-29 真机（合成 ArrowRight / ArrowLeft）：12097 kaguya → 12096（`3677233365/Untitled-1.html`）→ 12094（`steamapps/common/…/defaultprojects/corsair_collection/index.html`）→ 12093 图片（iframe 销毁）→ 12092 图片，再原路返回到 kaguya，每步 iframe `src` 随之换；在 12096 的 iframe 里 `fetch("../3679122549/project.json")` 被拒（stderr `OutsideRoot … outside …\3677233365 … webview 'main'`），自身 `project.json` 200 |
| [x] | 隔离 | Windows 桌面 CEF dev | 预览 iframe 里读 `window.__TAURI_INTERNALS__`、`window.parent.document`；伪造 `fetch("cef-ipc://localhost/", { method: "POST" })` | `__TAURI_INTERNALS__` 为 `undefined`；`window.parent.document` 抛 `SecurityError`；伪造请求不触发任何命令 | 2026-10-29 真机：`undefined`、`SecurityError`、伪造请求被回 400（`cef-ipc` 拒绝跨源子 frame）；垫片 `__kbWpeShim` 已注入 |
| [x] | `localStorage` 同源 | Windows 桌面 CEF dev | 预览里写一个键，切到桌面壁纸（同一张）读取 | 同源但按顶层站点分区，**读不到**（预期按实测改写） | 2026-10-29 真机（05 小节用例 12）：两个方向都读到 `null`；预览与桌面各自的 `localStorage` 跨重启稳定，只是不共享 |
| [ ] | Slideshow 预览 | Windows 桌面 CEF dev | 预览 Slideshow（`796697921`） | 能跑（无属性状态，与 Phase 3 相同）；`keyframes.html` 子页面照常加载 | |
| [x] | 应用背景不受影响 | Windows 桌面 CEF dev | 应用背景层（`App.vue`）遇到网页壁纸 | 仍只用缩略图 | |
| [x] | 壁纸窗口调用被拒 | `kabegame` 单测 | 壁纸窗口（`wallpaper` label）调 `set_wpe_web_preview`（单测或 CDP 在壁纸窗口 invoke） | 被拒 | 2026-10-28 单测 `commands::wpe_web::tests::preview_root_rejects_wallpaper_window` 通过（`check_preview_label`：`wallpaper` 拒绝、`main` 放行）；未经 CDP 在壁纸窗口真机 invoke |
| [x] | 平台门控 | Windows（本机无 macOS / Linux） | `deno task check -c kabegame`；`platform_supported` 与 `web_entry` 的非 Windows 分支单测 | Windows 通过；非 Windows 分支返回 `false` / `Ok(None)` | 2026-10-28：check-kabegame vue-tsc 0 error、cargo check 0 error；单测把平台作参数注入（`platform_supported_on(os)`、`web_entry_on_platform(supported, path)`），在 Windows 上也覆盖非 Windows 分支。改为浏览器进程导航后复跑 check-kabegame：vue-tsc 0 error、cargo check 0 error；`web_entry` 失去 `build_wallpaper_target` 这个调用方后在 Linux / Android 无调用方，按平台 `allow(dead_code)`（只能 Windows 上 check，未在非 Windows 编译） |
| [x] | 单测 `kabegame-core` | `test-kabegame` | `kabegame-core --lib wpe::` | 全部通过 | 2026-10-28：20 passed / 0 failed（含新增 `wpe::discover::tests::platform_supported_is_windows_only`） |
| [x] | 单测 `kabegame` | `test-kabegame` | `kabegame --lib -- web_entry wpe_web http_server` | 全部通过 | 2026-10-28：8 passed / 0 failed（新增 `wallpaper::tests::web_entry_*` 三条与 `preview_root_rejects_wallpaper_window`；删除了 `/wpe` 的两条 MIME 单测）。改为浏览器进程导航后复跑 `kabegame --lib -- web_entry wpe_web`：5 passed / 0 failed；2026-10-29 改为 05 + 命令返回入口后复跑同一组：5 passed / 0 failed（见上节「单测」） |


## WPE 壁纸导入（第二阶段 Phase 5：运行时垫片与宿主协议）

2026-10-28：all-frames 垫片 `webview_js/wpe_shim.js` 挂在壁纸窗口与主窗口上，只在桌面 `file://` 主 frame 与预览的 `/wpe/<id>/` 直接子 iframe 里启用；传输统一成 `pull` / `listen` 两个原语——桌面直接 `invoke("wpe_web_pull_state")` 与 `plugin:event|listen`，预览 iframe 经 `postMessage` 由宿主页（`wpeWebBridge.ts`）调 `get_wpe_web_state`、用 `useTauriProxy()` 代为 listen；`setting-change` 的 `language` 与本张图片的 `metadataId` 补丁触发重拉，`load` 后首次全量、之后用户属性按键差异、通用属性整份、换 listener 补投全量，乱序按垫片拉取编号丢弃。`tauri-runtime-kbcef` 把 `file:` frame 的 IPC `Origin` 改写成 frame URL，`cef-ipc` 来源回退改为「Origin → frame URL → 初始 URL」（`file:///…` 交给 Tauri 前改写成 `file://localhost/…`，`http::Uri` 不接受空 authority，单测已确认），删除 Phase 4「`file:` 文档不注入初始化脚本」；新增 `wpe-web-capability`（`wallpaper` 窗口 + `file:///*`，只开 `wpe_web_pull_state` 与事件 listen / unlisten）；tauri 补丁 11 新增 `clear_js_listeners()`，`WallpaperWindow::show_web` / `show_app` 导航成功后调用。静态验证：check-kabegame 的 vue-tsc 与 cargo check 均 0 error（`CARGO_TARGET_DIR=target-check`）；`deno task patch tauri --check` 预检 01–11 通过；单测见本节末行；垫片投递语义另在 node vm 里模拟过（临时脚本，未入库）。真机：实现时未验证（dev 由用户运行，Rust 改动后需重建），回归结果见下两段与各行备注。测试壁纸：kaguya `3679122549`（库内 id 12097）、Slideshow `796697921`（12099）。

2026-10-28 真机回归（Windows 11 dev，CDP）：**桌面垫片未注入，桌面侧垫片行无法验证**。运行中的 `target/debug/kabegame-cef-helper.exe`（CEF renderer）构建于 10-27 02:13，早于 `subprocess.rs` 改动（10-28 01:42），仍是 Phase 4「`file:` 文档不注入」；`kabegame.exe` 已于 10-28 02:03 重建（`libtauri_runtime_kbcef` rlib 02:02 已重编，helper 未重新链接）——tauri dev 的监听重建只重编 `kabegame` bin，不走 ComponentPlugin 的 helper 预构建。浏览器进程侧（Origin 改写、ACL、拉取命令、`clear_js_listeners`）与预览 iframe（主窗口不受该删除影响）照常验证。桌面行需重启 `deno task dev`（或单独 `cargo build -p kabegame --bin kabegame-cef-helper --features standard`）后复测。观测方式：CDP 直连 page，`Debugger.scriptParsed` 读 Tauri 投递脚本的 `ids`、垫片 logpoint 计数拉取 / 落地、新文档钩子包装 listener 方法；用主窗口 IPC 请求里的 invoke key 从 `file:` 页面发原始 IPC 请求。全程未改代码、未加 debug ingest。

2026-10-28 第二轮真机回归（Windows 11 dev，CDP）：重启 `deno task dev -c kabegame` 后 ComponentPlugin 重新预构建了 helper（`kabegame-cef-helper.exe` 02:59:49，晚于本次启动 02:59:27 与 `subprocess.rs` 改动），**桌面垫片已注入**，桌面行补测。重启前先把当前壁纸设为 kaguya，用于「开机即网页壁纸」。观测方式同上一轮：CDP 直连壁纸窗口 page，`Debugger.scriptParsed` 读投递脚本的 `ids`，垫片 logpoint 计数拉取与落地，新文档钩子在 `DOMContentLoaded` 捕获阶段包装 listener 方法。语言用真实 `set_language` 切换，`image-changed` 由主窗口 `plugin:event|emit` 发出，补丁里是真实 id 与当前的 metadataId。全程未改代码、未加 debug ingest。测完已恢复原壁纸 12745 与界面语言 zh；轮播设置没有动过。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 桌面页面有 Tauri 脚本 | Windows 桌面 CEF dev | 窗口模式设 kaguya，`eval --url 3679122549` 执行 `typeof __TAURI_INTERNALS__`、`window.__kbWpeShim` | `"object"`、`true` | 2026-10-28 第二轮（helper 已重建）：开机直接加载的 kaguya 文档和之后重新切入的文档都是 `"object"`、`true`，`wallpaperRegisterAudioListener` 是函数，`wallpaperPropertyListener` 是垫片访问器（get / set）。第一轮失败（`"undefined"`、`undefined`）是因为 helper 未重建 |
| [x] | 应用命令被 ACL 拒绝 | Windows 桌面 CEF dev | kaguya 页面里 `__TAURI_INTERNALS__.invoke("get_settings", { keys: ["language"] })`；再 `invoke("plugin:window\|is_visible")` | 均返回 `Command … not allowed by ACL`；同页 `wpe_web_pull_state` 成功（被判成远程 `file:` 来源，只有 `wpe-web-capability`）。dev 构建的依赖关了 `debug-assertions`，错误文本不含来源 | 部分验证：页面无 `invoke`（helper 未重建），改用 kaguya 页面带 invoke key 的原始 IPC 请求：`get_image_by_id`、`get_settings`、`get_current_wallpaper_target`、`plugin:window\|is_visible`、`get_wpe_web_state` 均返回 `Command … not allowed by ACL`，同一页面的 `wpe_web_pull_state` 成功，可见被判成远程 `file:` 来源、只有 `wpe-web-capability`。预期已按此修正（2026-10-28：原写的 `get_image_by_id` 不是已注册命令；原预期「错误里含来源」在 dev 构建不成立）。第二轮（helper 已重建）直接用页面里的 `invoke`：`get_settings` → `Command get_settings not allowed by ACL`，`plugin:window\|is_visible` → `Command plugin:window\|is_visible not allowed by ACL`，`wpe_web_pull_state` 成功（返回 12097 的状态）。`cef-ipc` 回退：在页面里让 `http://ipc.localhost/…` 的 fetch 失败，Tauri 打出 `IPC custom protocol failed … postMessage` 后改走 `window.ipc.postMessage`；随后 4 个调用都是 POST `cef-ipc://localhost/`（204，正文带 `customProtocolIpcBlocked: true`）。`get_settings`、`plugin:window\|is_visible`、`get_current_wallpaper_target` 仍被 ACL 拒绝，`wpe_web_pull_state` 成功，说明回退通道也按远程 `file:` 来源判定，没有退回应用页 |
| [x] | 绕过 invoke 直接请求 | Windows 桌面 CEF dev | kaguya 页面里 `fetch("http://ipc.localhost/get_image_by_id", { method: "POST", body: "{}" })`（带 / 不带 `Tauri-Invoke-Key`） | 不返回图片数据（无 invoke key 被丢弃；带 key 时被 ACL 拒绝） | 2026-10-28 真机：不带 key（裸请求，及带 Tauri 其它头）→ 500 `missing Tauri-Invoke-Key header`；带 key（取自主窗口 IPC 请求头）→ `"Command get_image_by_id not allowed by ACL"`，无图片数据 |
| [x] | 拉取状态 | Windows 桌面 CEF dev | kaguya 页面里 `invoke("wpe_web_pull_state")` | 返回 `{ imageId: "12097", user, general: { language } }`；`user` 只含 `audio_sensitivity` / `bg_mouse_sensitivity` / `playback_rate` / `schemecolor` / `text_color` / `visualizer_color`（各为 `{ type, value }`），无 `custom_user_bg`；`language` 与界面语言对应（`zh-chs` 等） | 2026-10-28 真机：页面无 `invoke`，改用同一 IPC 地址的原始请求（带 invoke key）：返回 `imageId: "12097"`，`user` 恰为上述 6 个键（各 `{ type, value }`，与 `project.json` 带 `value` 的 6 项一致），无 `custom_user_bg`，`general: { language: "zh-chs" }`（界面语言 `zh`）；切到 Slideshow 后同一请求返回 `imageId: "12099"`、107 个键（`project.json` 123 项中带 `value` 的 107 项） |
| [x] | 首次投递 | Windows 桌面 CEF dev | 用 debug ingest 在页面 listener 外包一层记录 `applyUserProperties` / `applyGeneralProperties`（或经 CDP 在 `load` 前换上记录用 listener），重新设一次 kaguya | `load` 之后各恰好一次，先 user 后 general；user 的键与 `project.json` 带 `value` 的条目一致；页面按属性正常绘制（文字 / 可视化颜色） | 2026-10-28 第二轮：CDP 新文档钩子在 `DOMContentLoaded` 捕获阶段包装页面 listener，共两次 12745 → kaguya。每次垫片只拉取 1 次；`loadEventStart` 237ms / 195ms，之后依次调用 `applyUserProperties`（240 / 197ms，6 个键，与 `project.json` 带 `value` 的 6 项一致）和 `applyGeneralProperties({ language: "zh-chs" })`（241 / 198ms），各一次，调用栈来自垫片的 `deliverFull`。约 2.9s 后页面自己又调用了一次 `applyUserProperties`，栈在 `script.js` 内：属性在页面初始化完成前到达时先存进 `pendingWeProps`，`loadSong` 完成后自行回放，不是垫片投递。绘制：根元素 inline style 被写成 `--text-color: #ffffff; --text-color-rgb: 255, 255, 255`，与 `text_color` `"1 1 1"` 一致，但与 CSS 默认值相同，区分度有限；歌单与标题文字、5 张图片、1 个 canvas 已渲染。壁纸窗口截不了图，没有肉眼看 |
| [x] | 切换界面语言 | Windows 桌面 CEF dev | kaguya 显示时在设置里切换语言 | 垫片重拉一次；`applyGeneralProperties({ language })` 收到新码；`applyUserProperties` 不再被调用 | 2026-10-28 第二轮：主窗口真实调用 `set_language("en")`。垫片收到 `setting-change`（`shouldPull` 为 true），拉取第 2 次，落地 `en-us`，`applyGeneralProperties({ language: "en-us" })` 调用一次，`applyUserProperties` 没有再调用。之前两条只改样式的 `setting-change` 不触发拉取。随后 `set_language("zh")` 恢复：第 3 次拉取落地 `zh-chs`，同样只回调 general |
| [x] | metadataId 补丁 | Windows 桌面 CEF dev | 主窗口 `emit("image-changed", { seq: 0, patch: { id: "12097", metadataId: <原值> } })`；再对别的 id 发一次 | 本张：垫片重拉，属性未变不回调；别的 id：不重拉 | 2026-10-28 第二轮（桌面）：主窗口 `plugin:event\|emit` 发 `{ id: "12097", metadataId: 17825 }`（库内当前值）→ 只投递给垫片的 image-changed 监听（`ids` `[48]`），`shouldPull` 为 true，拉取第 4 次并落地，两个回调都没有调用；再发 `{ id: "12745", metadataId: 18710 }` → 收到事件，`shouldPull` 为 false，没有拉取。第一轮在预览 iframe（12099）上的等价验证：`{ id: "12099", metadataId: 17827 }` → 垫片拉取第 3 次、两个回调都未再调用；`{ id: "12097", metadataId: 17825 }` → 收到事件、`shouldPull` 为 false、不拉取。真正的差异投递等 Phase 7 |
| [x] | 主窗口与应用页不能拉取 | Windows 桌面 CEF dev | 主窗口里 `invoke("wpe_web_pull_state")`；切回图片壁纸后在壁纸窗口应用页里调用 | 均被 ACL 拒绝（`main-capability` 不含该命令） | 2026-10-28 真机：主窗口与 kaguya → 12745 后的壁纸应用页均为 `Command wpe_web_pull_state not allowed by ACL` |
| [x] | 嵌套 iframe 无 Tauri 脚本 | Windows 桌面 CEF dev | kaguya 页面里 `document.body.appendChild(document.createElement("iframe"))` 后读它的 `contentWindow.__TAURI_INTERNALS__`、`__kbWpeShim` | 均为 `undefined` | 2026-10-28 第二轮：顶层为 `"object"` / `true`。`about:blank` 与 `srcdoc` 两种 iframe 里 `__TAURI_INTERNALS__`、`__kbWpeShim`、`ipc`、`wallpaperRegisterAudioListener` 都是 `undefined`，也没有 `wallpaperPropertyListener` 访问器。CDP `Debugger.scriptParsed` 显示，`srcdoc` 子 frame 只解析了垫片（all-frames，第一行即返回）和测试钩子，没有 Tauri 的主 frame 脚本 |
| [x] | 回到应用页照常 | Windows 桌面 CEF dev | kaguya → 普通图片 | 应用页正常渲染图片，`setting-change` 驱动的样式 / 音量照常生效（`main-capability` 生效） | 2026-10-28 真机：kaguya → 12745 回到 `index.html?window=wallpaper`，`ready invoked: yes`，`img.base` 的 `naturalWidth` 4096、`object-fit: cover`；以原值 `set_wallpaper_style("fill")` 后调试面板 `last style ts` 立即更新；应用页 `invoke("get_current_wallpaper_target")` 正常返回 12745。当前是图片，音量未覆盖 |
| [x] | 导航清监听 | Windows 桌面 CEF dev | 临时 debug ingest 在 `show_web` / `show_app` 前后记录本 label 的 JS 监听数；图片 → kaguya → 图片 → kaguya 循环两轮 | 监听数不增长；kaguya 页面里定义 `window.__internal_unstable_listeners_function_id__` 包装后收不到应用页留下的 `setting-change`；回到应用页后改设置仍生效 | 2026-10-28 真机（未改 Rust，改用 CDP `Debugger.scriptParsed` 读投递脚本的 `ids`，配合页面里的 `__internal_unstable_listeners_function_id__` 记录器；垫片未注入，网页侧监听改由页面带 key 的原始 `plugin:event\|listen` 登记）。每次以原值 `set_wallpaper_style("fill")` 触发 `setting-change`。图片 → kaguya → 图片 → kaguya 两轮：网页侧登记的 39 / 42 在切回应用页后都不再出现，应用页收到的 `ids` 只有自己新注册的 `[40]` / `[43]`；在应用页额外登记、卸载时不会退订的 41 / 44，切到 kaguya 后页面记录器为空，也没有投递脚本。kaguya → Slideshow 后，kaguya 侧登记的 45 同样被清掉。监听数始终为 1，回到应用页后改样式照常生效。第二轮（垫片已真正注入）复测：12745 → kaguya → 12745 → kaguya，每次到位后以原值 `set_wallpaper_style("fill")` 触发。`setting-change` 投递的 `ids` 依次是 `[42]` → `[43]` → `[46]` → `[47]`，每个文档只有一个监听；kaguya 文档的另外两个监听（image-changed / images-change）分别是 44 / 45 和 48 / 49。旧文档的 id 都不再出现，开机时那份 kaguya 文档的监听也在切到应用页后清掉了。kaguya → Slideshow 后只投递给 `[50]` |
| [x] | 网页 → 网页 | Windows 桌面 CEF dev | kaguya → Slideshow | Slideshow 页面里的垫片重新订阅、重新拉取，收到自己的 `imageId: "12099"` 与属性 | 2026-10-28 第二轮：壁纸窗口直接换到 `796697921/index.html`。新文档发出 3 次 `plugin:event\|listen` 和 1 次 `wpe_web_pull_state`，落地 `imageId: "12099"`、107 个键、`zh-chs`。`loadEventStart` 45ms 之后依次调用 `applyUserProperties`（107 个键）和 `applyGeneralProperties`，各一次。之后改样式产生的 `setting-change` 只投递给 `[50]`，kaguya 的监听已清掉；`../3679122549/data.json` 被拦截。第一轮只验证了原始拉取请求（垫片当时未注入） |
| [x] | 预览启用范围 | Windows 桌面 CEF dev | 打开 12099 预览；CDP 读 iframe 与主窗口应用页的 `window.__kbWpeShim` | iframe 内 `true`，主窗口应用页 `undefined` | 2026-10-28 真机：画廊有横屏筛选，12099 不在当前视图，改在其导入任务详情页 `/tasks/<id>?pvwimgid=12099` 打开。iframe `http://127.0.0.1:14164/wpe/12099/index%2Ehtml` 是独立的 OOPIF target，内部 `__kbWpeShim === true`，`wallpaperPropertyListener` 为访问器，`__TAURI_INTERNALS__` 为 `undefined`；主窗口 `__kbWpeShim` 为 `undefined`。站点隔离下 all-frames 脚本能进跨源 iframe，不需要回退方案。旧 helper 不影响这一行：本 Phase renderer 侧只删了 `file:` 跳过 |
| [x] | 预览代办 | Windows 桌面 CEF dev | 宿主页 debug ingest 记录 `wpeWebBridge` 收到的消息 | 一次 `listen`（三个事件名）与一次 `pull`；iframe `load` 后 `applyUserProperties` 被调用一次 | 2026-10-28 真机（未加 debug ingest，改用 CDP 在宿主页装 `message` 监听，与 `wpeWebBridge` 收到的是同一批事件）：恰好一次 `listen` `["setting-change","image-changed","images-change"]` 与一次 `pull` id 1，来源是该 iframe（`origin` `http://127.0.0.1:14164`）。iframe 在 `load` 之前收到 `state` id 1（12099，`zh-chs`，107 个键），垫片只记下不回调；`loadEventStart` 81.4ms 之后依次调用 `applyUserProperties`（82ms，107 个键）和 `applyGeneralProperties({ language: "zh-chs" })`（85ms），各一次，调用栈来自垫片的 `deliverFull` |
| [x] | 预览切语言 | Windows 桌面 CEF dev | 预览打开时切换界面语言 | 经 `useTauriProxy` 转发 `setting-change`，iframe 重拉并收到新的 general | 2026-10-28 真机：`set_language("en")` 后，主窗口 `setting-change` 投递的 `ids` 为 `[16, 59]`（59 是代理经 `kbEvent$` 新订阅的监听）。iframe 收到 `event setting-change { changes: { language: "en" } }`，随即拉取第 2 次，收到 `en-us`，`applyGeneralProperties({ language: "en-us" })` 调用一次，`applyUserProperties` 没有再调用 |
| [x] | 关闭预览 | Windows 桌面 CEF dev | 关闭预览后切换语言 | 宿主页不再转发（`dispose` 后退订），无报错 | 2026-10-28 真机：按 Esc 关闭后 iframe 从 DOM 移除，OOPIF target 分离；之后 `set_language("zh")`，主窗口 `setting-change` 的 `ids` 回到 `[16]`（代理监听已退订），宿主页没有再收到消息，两个窗口都没有 console 报错 |
| [x] | 换 listener | Windows 桌面 CEF dev | 首次投递后在页面控制台执行 `window.wallpaperPropertyListener = { applyUserProperties: console.log }` | 下一个微任务打印全量用户属性 | 2026-10-28 在预览 iframe（12099）验证：桌面垫片未注入，垫片代码相同。赋值后 `console.log` 打出全量用户属性对象（首键 `_controlsHelp`）；用记录器复测：赋值时同步调用 0 次，一个微任务后收到 107 个键的用户属性与 `{ language: "en-us" }`。测后已换回原 listener |
| [ ] | macOS | macOS 桌面 CEF | 窗口模式设网页壁纸 | 同 Windows：页面收到作者属性与语言，应用命令被拒 | 本机为 Windows，未验证 |
| [x] | 单测 | `kabegame-core` / `tauri-runtime-kbcef` / `kabegame` | `test-kabegame` 跑 `wpe::properties`、`protocol` / `ipc` / `subprocess` / `file_access`、`wpe_web` / `input_forward` | `file:` frame 的 `null` / 缺失 Origin 被改写、其它来源不动；缺 Origin 时取 frame URL 而非初始 URL；`file:///` 改写成 `http::Uri` 可承载的 `file://localhost/` 并经 `url::Url` 还原；`file:///*` 匹配入口（含百分号编码与 `localhost` 归一）、不匹配 HTTP 源；kaguya 片段只输出带 `value` 的键、保留 `type`；五种语言码 | 2026-10-28：core 6 个、`tauri-runtime-kbcef` 25 个、`kabegame` 3 个全部通过（按名过滤，`CARGO_TARGET_DIR=target-check`）；真机回归后复跑（同日，`test-kabegame`，`target-check`）：`kabegame-core --lib wpe::properties` 6 passed；`kabegame -p tauri-runtime-kbcef --lib -- protocol ipc subprocess file_access wpe_web input_forward` 29 passed，均 0 failed |

## 爬虫窗口 capability 收回事件权限

2026-10-27：`capabilities/crawler.json` 删除 `core:event:allow-listen` / `allow-emit` / `allow-emit-to`。capability 按「窗口 + 来源」授权，被爬站点与插件脚本在同一主 frame、同一来源，插件能调的站点都能调；此前站点可订阅 `app.emit` 广播的全部 AppEvent（`images-added` 含本地路径等），也可向主窗口伪造事件（如 `app-import-plugin` 弹出导入对话框）。`webview_js/` 与 `src-crawler-plugins/` 均未调用 `plugin:event|`。静态验证：JSON 合法；未跑 cargo check。真机：dev 未运行，未验证。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | WebView 插件照常运行 | 桌面 CEF dev | 跑一个 WebView 插件（或网页收集的 webview 后端），最多 3 条 | 心跳、翻页、下载、页面自发下载回调均正常，任务成功结束 | 未验证：dev 未运行 |
| [ ] | 站点不能订阅事件 | 桌面 CEF dev | 任务运行中经 CDP 在爬虫窗口执行 `__TAURI_INTERNALS__.invoke('plugin:event\|listen', { event: 'images-added', target: { kind: 'Any' }, handler: __TAURI_INTERNALS__.transformCallback(() => {}) })` | Promise 被 ACL 拒绝（`event.listen not allowed`） | 未验证 |
| [ ] | 站点不能伪造事件 | 桌面 CEF dev | 同上执行 `invoke('plugin:event\|emit', { event: 'app-import-plugin', payload: { kgpgPath: 'x' } })` | 被 ACL 拒绝，主窗口不弹导入对话框 | 未验证 |
| [ ] | Android WebView 爬虫 | Android dev | 跑一个 WebView 插件 | 同桌面，任务成功结束（安卓同样使用 `crawler-capability`） | 未验证 |

## 下载落盘先占坑（消除 `images.local_path` UNIQUE 冲突）

2026-10-29：下载目标文件名从 `exists()` 查询改为原子创建 + 原生占用标记（Unix `flock`、Windows 只共享读的 share mode）：`occupy_unique_path` / `occupy_unique_download_path[_with_name]` 返回 `OccupiedFile` 守卫，后处理持有到 `add_image` 结束；溢写文件在 Unix 同设备上「锁源 → 硬链接 → 删源名」零拷贝，Windows / 跨设备经句柄复制；本地导入复制进目标目录同样占坑；文件夹同步给新文件建行前探测标记、命中放弃，探测未命中再按路径查一次；下载器对新建文件入库后按直接父目录补挂文件夹画册。不改 SQL。静态验证：check-kabegame driver 的 cargo check（`kabegame` 与 `kabegame-cli`）0 error；vue-tsc 报 1 个既有错误（`apps/kabegame/vite.config.ts(74,20)` 的 `isProd` 未定义，来自 HEAD 合并提交，本次未改前端）。Windows 分支本机（macOS）无法编译，只核对了 `windows-sys` 0.52 常量类型。真机（macOS dev，CDP + dev CLI 经 IPC 交给 app）：用临时 V8 插件 `collide-test` 从本地 HTTP 服务一次入队 16 个 `…/set<n>/img.png`（同名、内容各异）制造碰撞，结果见各行备注；测试图片、画册与插件已清理。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 占坑换名与探测 | macOS 单测 | `test-kabegame` 跑 `downloader::util` | 已有 `a.jpg` 时依次得到 `a(1).jpg`、`a(2).jpg`；守卫存活时 `is_occupied_for_download` 为真、drop 后为假；无残留 `.kabegame-occupy-*` | 2026-10-29：`downloader::util` 12 个全部通过（新增 4 个，旧 4 个适配新签名） |
| [x] | 溢写文件零拷贝搬运 | macOS 单测（APFS） | `occupy_move_relocates_without_copy` | `move_from` 后源名消失、目标与源同一 inode、内容一致、`is_moved()` 为真 | 2026-10-29 通过 |
| [x] | 经句柄复制 | macOS 单测 | `occupy_copy_from_writes_through_handle` | `copy_from` 后目标内容一致、源文件保留、仍带占用标记 | 2026-10-29 通过 |
| [x] | 同名并发不撞 | macOS 单测 | 16 线程同时占坑 `same.jpg` 并各自写入 | 16 条互不相同的路径，内容各是自己线程写的 | 2026-10-29 通过 |
| [x] | 同步放弃占坑文件 | macOS 单测 | `local_folder::sync_skips_new_file_occupied_by_download` | 守卫存活时 diff 与全量同步都不建行；drop 后 diff 同步照常导入并挂画册 | 2026-10-29 通过 |
| [x] | 文件归属画册 | macOS 单测 | `local_folder::album_for_file_matches_direct_parent_only` | 直接父目录命中画册；子目录无子画册时不归父画册；`sync_mode = none` 不收 | 2026-10-29 通过；`local_folder` 共 43 个，42 过 1 败，失败的 `replace_image_thumbnail_path_deletes_old_independent_thumbnail` 是既有问题（WPE 改动后只删 `thumbnails_dir` 内缩略图，用例把旧缩略图放在临时目录），与本次无关 |
| [x] | 文档示例 | macOS doctest | `test-kabegame` 跑 `--doc occupy_unique_download_path` | `no_run` 示例能编译 | 2026-10-29 通过 |
| [x] | 多图同名不再撞库 | macOS 桌面 CEF dev | 临时插件一次入队 16 个同名 `img.png`（内容各异）经 dev CLI → IPC 在 app 下载 | 不再出现 `UNIQUE constraint failed: images.local_path`；下载目录得到 `name.jpg`、`name(1).jpg`…，各文件 hash 不同、对应各自 URL | 2026-10-29 真机：任务 completed、新下载 16 / 失败 0、日志无 UNIQUE；目录为 `img.png` … `img(15).png`，16 行 hash 互不相同且每行 hash 与磁盘文件 sha256 一致（无覆盖）；编号与 URL 序号错位（set3→`img(3)`、set0→`img(4)`）证明确为并发抢名；无残留 `.kabegame-occupy-*` |
| [x] | 下载目录即文件夹画册 | macOS 桌面 CEF dev | `add_local_folder_album` 指向空目录并 `set_album_sync_mode` 为 `shallow`，再把另外 16 个同名图下载到该目录；之后 `sync_local_folder_album` 手动全量同步 | 同步卡片不报错、不产生重复行；下载结束后图片已在该画册（下载器补挂）；再手动全量同步无变化 | 2026-10-29 真机：目录下 16 行全部 `plugin_id = collide-test-test`、无 `local-import` 重复行；画册成员 16 / 本次行 16、`folder_status.state = ok`；手动全量同步后成员与行数仍为 16 |
| [ ] | 拖入文件夹画册 | macOS 桌面 CEF | 向文件夹画册拖入几张图（含与已有文件同名的） | 复制进 `sync_folder` 并改名不冲突，立即入库并挂到该画册，无 UNIQUE 报错 | 未验证：未真机运行 |
| [ ] | 大文件仍零拷贝 | macOS 桌面 CEF | 下载超过 5 MiB 的视频（走溢写），对照 `.kabegame/debug` 与耗时 | 无复制耗时回退，目标与溢写文件同设备时为硬链接搬运 | 未验证：未真机运行 |
| [ ] | 畅游下载 | macOS 桌面 CEF | 畅游窗口一键下载 / 右键下载图片与视频 | 照常入库，下载目录无残留 `.kabegame-occupy-*` 或 `.part` | 未验证：走 relocate 分支，代码未改 |
| [ ] | Windows 读写与删除 | Windows 桌面 CEF | 下载图片与大视频；构造一次后处理失败（如去重兜底命中） | 缩略图 / 尺寸 / 兼容副本照常生成；失败分支能删掉新建文件（先 drop 守卫再删）；溢写文件经句柄复制后源 `.part` 被删 | 未验证：本机为 macOS，Windows 分支未编译 |
| [ ] | 不支持硬链接的盘 | Linux / macOS，FAT / exFAT 下载目录 | 下载目录设在 U 盘上下载几张同名图 | 退回 `create_new` + 上锁，照常换名入库，无残留临时文件 | 未验证 |

## Windows 安装程序不再弹命令行窗口

2026-10-29：`src-tauri/kabegame/nsis/installer-hooks.nsh` 的安装 / 卸载钩子不再 `ExecWait cmd.exe /C move|attrib`（每个 DLL、CEF 文件、locale pak 各起一次 cmd，安装末尾连续闪出几十个黑窗口），移动改为 `KABEGAME_MOVE_FILE` 宏（`Delete` 目标 + `Rename`，同卷 `MoveFile`，失败时 `DetailPrint` 报错），属性改为 `SetFileAttributes`。本机（macOS）无 `makensis`，未编译、未真机运行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 打包通过 | Windows 构建机 | `deno task b -c kabegame --release` 产出 NSIS 安装包 | `makensis` 无报错（宏内 `${If} ${Errors}` 可用） | 未验证 |
| [ ] | 全新安装无黑窗口 | Windows | 在干净目录运行安装包，点开「显示细节」 | 全程不闪 cmd 窗口；细节里每个文件一行 `Move …`，无 `Move failed`；`$INSTDIR` 下有 `libcef.dll`、`*.pak`、`locales\*.pak`，`resources\cef` 已删除 | 未验证 |
| [ ] | 覆盖安装 | Windows（已装旧版） | 不卸载直接运行新安装包 | 旧 DLL / pak 被覆盖，无 `Move failed`；应用能正常启动（CEF 加载正常） | 未验证 |
| [ ] | 目录图标 | Windows | 安装后在资源管理器里看安装目录 | 文件夹显示应用图标；`desktop.ini` 为隐藏 + 系统，目录带系统 + 只读属性 | 未验证 |
| [ ] | 卸载 | Windows | 从「应用和功能」卸载 | 不闪 cmd 窗口；安装目录被完整删除，无残留 `desktop.ini` | 未验证 |
| [ ] | 带空格的安装路径 | Windows | 安装到 `C:\Program Files\Kabe Game Test` | 同全新安装，各文件正常搬运 | 未验证 |

## 合并：WPE 与路径轮播 / 基本信息芯片

2026-10-27：feat/wpe-import 合入 main 时，rotator 改为 main 的路径轮播，WPE 规则落在 `collect_available` 的逐张检查（`RotationSource.allow_wpe`）；基本信息面板改为 main 的芯片排版，WPE 行显示「Wallpaper Engine · 类型」芯片；预览弹窗的桌面判定统一用 `USE_PSWP`。合并在临时 worktree 完成，未真机运行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 窗口模式轮播含 WPE | 桌面 CEF | 轮播路径包含 WPE 视频 / 网页行，窗口模式连续切换 | WPE 行正常被选中并显示 | 未验证 |
| [ ] | 原生模式跳过 WPE | 桌面 CEF | 同一路径切到原生模式连续切换 | 跳过 WPE 行，只设普通图片；位置照常前进 | 未验证 |
| [ ] | Plasma 插件跳过 WPE | Linux KDE | 插件模式轮播含 WPE 行的路径 | 跳过 WPE 行，图片与视频照常 | 未验证 |
| [ ] | 基本信息 WPE 芯片 | 桌面 CEF | 打开 WPE 行详情 | 类型位置显示「Wallpaper Engine · 视频 / 网页」芯片，不可点筛选；大小 / 尺寸芯片照常 | 未验证 |
| [ ] | 预览网页壁纸 | 桌面 CEF | 预览 WPE 网页行，左右切图 | 桌面画布正常，切图箭头与工具条行为同合并前 | 未验证 |
| [ ] | 换行符 | 任意 | 新克隆后 `git ls-files --eol` | 除补丁与 `.bat` 外均为 `i/lf w/lf` | 已在合并 worktree 验证索引侧 |

## 壁纸窗口 Vue 化

2026-10-26：壁纸窗口改为 `index.html?window=wallpaper` + `WallpaperWindow.vue` + `WallpaperStage.vue`，纯重构。静态验证：check-kabegame driver 的 vue-tsc 0 error；cargo check 因运行中的 dev app 占用 `target/debug` 的 CEF 文件（`cef-dll-sys` 复制阶段 `os error 32`），改用独立 `CARGO_TARGET_DIR` 跑同一 driver，0 error。真机为 Windows 11 桌面 CEF dev（窗口模式，轮播开启），经 CDP 读壁纸窗口 DOM 与 dev 调试面板验证——壁纸窗口挂到 WorkerW 后 `shot --url wallpaper` 等帧超时无法截图，但页面本身不降频（调试面板帧率 MIN 141 / AVG 144）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 入口分发 | Windows 桌面 CEF | `targets` 列出窗口，读壁纸窗口的脚本与 DOM | 壁纸窗口 URL 为 `index.html?window=wallpaper`、只加载 `main.ts`，页面无组件库元素；html / body 透明；默认截图仍是主窗口 | 实测 body / html 背景 `rgba(0,0,0,0)`、无 `.el-*` 元素；主窗口截图正常 |
| [x] | 图片显示 | Windows 桌面 CEF | 当前壁纸为普通图片时读 `img.base` | 原图加载完成、铺满 2560×1440，ready 握手 `ready invoked: yes` | `naturalWidth` 5512 |
| [x] | 五种样式 | Windows 桌面 CEF | 依次设样式 fit / tile / center / stretch / fill | 图片 `object-fit` 依次为 contain / （tile 显示平铺层、图片层隐藏）/ none / fill / cover，调试面板 `last style ts` 与 `mode` 立即更新 | 逐项读 DOM 符合 |
| [x] | 过渡 fade / slide / zoom | Windows 桌面 CEF | 轮播开启时切过渡（触发一次轮播） | top 层类名依次 `top <过渡> prep` → `top <过渡> enter` → 提交后回到 `top`，base 换成新图 | 三种都观察到完整序列；首次切 slide 未触发轮播，重试后正常。2026-10-26 页面内 MutationObserver 精确计时（12093 → 12091 视频切视频、fade）：prep 679ms → enter 689ms（两帧 rAF 10ms）→ 1494ms 提交（800ms 动画走完由 transitionend 触发），1400ms 兜底未介入；此前「两帧 rAF 约 2s」是 CDP 轮询类名的测量假象 |
| [x] | 调试面板帧率 | Windows 桌面 CEF dev | 读壁纸窗口 `.debug-panel` 第一行 | 显示 `fps: MIN n AVG n`，与主窗口 FrameMonitor 同一 store、300ms 采样；WorkerW 下播放 WPE 视频时接近显示器刷新率 | 2026-10-26 实测 MIN 141 / AVG 144（144Hz 屏） |
| [x] | 过渡 none | Windows 桌面 CEF | 过渡为 none 时换壁纸 | 直接替换 base，无 prep / enter | 窗口重建后初始为 none，直设 base |
| [x] | 视频与音量 / 倍速 | Windows 桌面 CEF | 设普通视频 426，再把音量改 0.5、倍速改 1.5 | base 视频播放（未静音、`currentTime` 前进），音量与倍速实时生效 | 读到 `volume 0.5`、`playbackRate 1.5`；测后已恢复 1 / 1 |
| [x] | WPE 视频作者属性 | Windows 桌面 CEF | 在 slide 过渡下从视频切到 WPE 视频 12091 | 播 `compatible_path`；视频→视频走 top 层 prep → enter 后 base / top 元素交换；`schemecolor` 成为留边背景色，`object-position` 50% 50% | 背景 `rgb(113, 69, 160)`；该壁纸无翻转 / 偏移 / 颜色属性，transform 与 filter 为空，翻转与滤镜未能用真实数据验证 |
| [x] | 关闭再开启窗口模式 | Windows 桌面 CEF | 切到原生模式再切回窗口模式 | 壁纸窗口销毁后重建，ready 握手完成并显示当前壁纸 | 重建后 `targets` 重新出现壁纸窗口，图片已加载；另经一次 dev 重启（应用冷启动直接建窗）同样握手并显示 |
| [x] | 看门狗计数 | Windows 桌面 CEF | 设 `sessionStorage.wallpaperInitRetry=2` 后 reload 壁纸窗口 | init 跑完后重新握手并清零计数 | 重载后计数为 null、图片已加载；真正的 init 卡死重载未能人为制造 |
| [x] | dev 调试面板 | Windows 桌面 CEF | 读 `.debug-panel` | label / ready / 三个时间戳 / mode / media / transition / rawPath 与原面板一致 |  |
| [x] | 主窗口不受影响 | Windows 桌面 CEF | 主窗口正常使用；派发 Ctrl+Shift+R | 画廊正常渲染（组件库样式在）；Ctrl+Shift+R 重载主窗口 | `performance.timeOrigin` 变化、重载后仍在 `/gallery` |
| [x] | 图库 WPE 视频预览不变 | Windows 桌面 CEF | `/gallery?pvwimgid=12091` 打开预览并拖进度到 60s | 普通视频预览：`<video>` 播 `compatible_path`，有 `VideoControls` 与进度条，seek 生效；不出现壁纸组件 | 进度显示 `01:00 / 01:58` |
| [ ] | 视觉核对 | Windows 桌面 CEF | 肉眼看桌面壁纸的过渡动画、tile、WPE 留边色 | 与重构前一致 | 壁纸窗口无法经 CDP 截图，需人工看桌面 |
| [ ] | macOS 窗口壁纸 | macOS 桌面 CEF | 同上各项 | 同上 | 本机为 Windows，未验证 |
| [ ] | release 构建 | Windows / macOS 打包 | 安装包里开启窗口壁纸 | `tauri://localhost/index.html?window=wallpaper` 能加载并分发到壁纸 bootstrap（asset 协议忽略 query） | 未打包验证 |

## WPE 壁纸导入（第二阶段 Phase 4：桌面 `file://` 宿主 + 鼠标转发）

2026-10-27：桌面壁纸窗口遇到 `x-wpe/web` 时由 Rust（`wpe_web_host`）把整个窗口导航到入口的 `file://`，切走时导航回记住的应用页；CEF 补丁 04 只对壁纸窗口开 `allow_file_access_from_file_urls`，运行时在 `OnBeforeResourceLoad` 按当前壁纸目录拦截 `file:` 请求，`file:` 文档不注入初始化脚本；Windows 轮询式鼠标移动 / 左键转发；删除 `DEBUG-WPE-FILE` / `DEBUG-WPE-INPUT` 临时代码（含 dev 全局 `allow-file-access-from-files` 开关）。静态验证：check-kabegame driver 的 vue-tsc 与 cargo check 均 0 error（dev 占用默认 target，改用独立 `CARGO_TARGET_DIR`）；单测见本节末行。真机：实现期间 dev 未在运行；其后 2026-10-27 在 dev 上补测，结果见各行备注。测试壁纸：kaguya `3679122549`（库内 id 12097）、Slideshow `796697921`（12099）。

2026-10-28：导航收回窗口 manager——删除 `wpe_web_host`（全局 `STATE`、`setting-change` 监听与 ready 握手里的同步），`WindowWallpaperManager::set_wallpaper_path` 按路径判定（`x-wpe/web` 目录 → `show_web` 导航到 `file://`，其它 → `show_app` 回应用页，均幂等），应用页 URL、当前入口、根目录与鼠标转发随 `WallpaperWindow` 对象走、`Drop` 清理；日志前缀由 `[wpe-web-host]` 改为 `[wallpaper-window]`。上表已勾选行是改动前的结果。静态验证：check-kabegame 的 vue-tsc 与 cargo check 均 0 error（dev 占用默认 target，改用 `CARGO_TARGET_DIR=target-check`）。下列相关行未在改动后真机复测。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 04 生效 | Windows 桌面 CEF dev | 确认 dev 已重建（全局开关已删），把 kaguya 设为壁纸 | kaguya 页面 `fetch('data.json')` 200，整页渲染（封面、歌词、播放器） | 2026-10-27 真机（Windows 11 dev，CDP）：临时全局开关已删，壁纸窗口 `fetch('data.json')` 200，歌单、封面、歌词、播放器完整渲染，音频播放中 |
| [x] | 导航到 `file://` | Windows 桌面 CEF dev | 窗口模式下 `invoke('set_wallpaper_by_image_id', { imageId: '12097' })`，`targets` 看壁纸窗口 | 壁纸窗口 URL 变为 `file:///D:/Applications/Steam/.../3679122549/index.html`；stdout 有 `[wpe-web-host] 壁纸窗口 → file:///…` | 2026-10-27 真机（Windows 11 dev，CDP）：壁纸窗口 URL 为 `file:///…/3679122549/index.html` |
| [x] | 目录拦截 | Windows 桌面 CEF dev | `eval --url 3679122549` 依次 `fetch('data.json')`、`fetch('file:///C:/Windows/win.ini')`、`fetch('../796697921/project.json')` | 第一个 200，后两个 `Failed to fetch`，stderr 记 `[cef-runtime] deny file: … OutsideRoot` | 2026-10-27 真机（Windows 11 dev，CDP）：`data.json` 与子目录 `cover/Remember.png` 200；`win.ini`、兄弟壁纸 `project.json`、目录 `./music/` 均 `Failed to fetch`。2026-10-28 补 stderr 证据（Phase 5 补测的 dev 日志）：越界请求各记一条 `[cef-runtime] deny file: … (outside <当前壁纸目录>; OutsideRoot) webview 'wallpaper'`，覆盖 `win.ini`、兄弟壁纸 `project.json`、从 Slideshow 读 kaguya 的 `data.json`；其余 `deny file:` 都是 kaguya 自己请求不存在的文件（`NotFound`） |
| [x] | 初始化脚本与 IPC 限权 | Windows 桌面 CEF dev | 壁纸页面里 `typeof __TAURI_INTERNALS__`，再 `__TAURI_INTERNALS__.invoke("get_settings", { keys: ["language"] })` | `"object"`；应用命令被 ACL 拒绝（远程 `file:` 来源只有 `wpe-web-capability`） | 2026-10-28 Phase 5 改变期望（删除 `file:` 文档跳过注入，改由 ACL 限权）。同日第二轮（重启 dev，helper 已重建）：开机加载的 kaguya 页面 `typeof __TAURI_INTERNALS__` 为 `"object"`；`invoke("get_settings", { keys: ["language"] })` → `Command get_settings not allowed by ACL`，同页 `wpe_web_pull_state` 成功（见 Phase 5「应用命令被 ACL 拒绝」行，含 `cef-ipc` 回退）。第一轮复测时仍为 `"undefined"`，原因是运行中的 `kabegame-cef-helper.exe` 未重建；当时用原始 IPC 请求（带 invoke key）验证了 ACL 一半：`get_image_by_id` 返回 `Command get_image_by_id not allowed by ACL`。原 2026-10-27 真机结果（Phase 4 行为）：`__TAURI_INTERNALS__` / `__TAURI__` / `window.ipc` 均为 `undefined` |
| [x] | 只作用于壁纸窗口 | Windows 桌面 CEF dev | 主窗口（应用页）里 `fetch('file:///C:/Windows/win.ini')` | 失败（主窗口未登记文件文档策略，偏好与拦截都不作用） | 2026-10-27 真机（Windows 11 dev，CDP）：主窗口 `fetch('file:///C:/Windows/win.ini')` → `Failed to fetch` |
| [~] | 切回应用页 | Windows 桌面 CEF dev | kaguya → 普通图片 → 普通视频 → kaguya | 切到图片 / 视频时壁纸窗口回到 `index.html?window=wallpaper` 并正常显示（ready 握手 yes）；再切回 kaguya 又导航到 `file://`；网页 → 网页（kaguya → Slideshow）直接换 `file://` 入口 | 2026-10-27 真机（Windows 11 dev，CDP）：kaguya → 图片 12823 回到 `index.html?window=wallpaper`，图片已加载（opacity 1）；再切回 kaguya 又导航到 `file://`。视频与网页→网页未测 |
| [ ] | 鼠标转发 | Windows 桌面 CEF dev | 在 kaguya 页面经 CDP 挂 `mousemove` / `mousedown` / `mouseup` 计数，用户在桌面空白处移动、点击，再点在别的应用窗口上 | 桌面移动 / 点击后计数增长且 down / up 成对；点在别的应用窗口上 `mousedown` 不增长（移动仍增长，与 WPE 一致）；Explorer 照常收到点击 | 未验证：需要 dev 运行并由用户在桌面上实际操作 |
| [x] | 桌面框选不被吞 | Windows 桌面 CEF dev | 网页壁纸生效时在桌面空白处拖拽框选图标、单击 / 双击图标 | 框选矩形正常出现并选中图标；图标交互不受影响；页面仍收到 down / up | 2026-10-27 用户实测：wemt 挂载后补 `AttachThreadInput(…, FALSE)` 拆输入队列（同 WE，见 `2-web/WPE_INPUT_RE.md`）后，框选与各种拖动均不再被吞 |
| [x] | 拖动页面图片不挂住 | Windows 桌面 CEF dev | 在桌面上按住 kaguya 页面里的图片拖动后松开，再继续移动 / 点击 | 不启动拖放（与 WE 一致），桌面上不会多出图片文件；之后页面仍响应鼠标，点击主窗口无系统提示音 | 用户真机确认：拖动不再启动拖放；修改前实测会启动 OLE 拖放挂住、图片被拖到桌面 |
| [ ] | 开机即网页壁纸 | Windows 桌面 CEF dev | 当前壁纸为 kaguya 时重启 dev；另测切原生模式再切回窗口模式、关闭壁纸再开启 | `init()` 建窗 → 应用页 ready → `mount()` 记下应用页 URL → `init_wallpaper_on_startup` / 切模式 / 重新开启经 `set_wallpaper_path` 导航到 `file://`，stdout 有 `[wallpaper-window] 壁纸窗口 → file:///…`，鼠标转发重新启动 | 部分验证：2026-10-28 真机（Windows 11 dev，CDP）当前壁纸为 Slideshow 时关闭壁纸再开启，窗口重建后直接停在 `796697921/index.html`、`fetch('project.json')` 200。同日第二轮覆盖重启：当前壁纸为 kaguya 时重启 `deno task dev -c kabegame`，stdout 依次出现 `壁纸窗口已就绪`、`[wallpaper-window] 壁纸窗口 → file:///D:/Applications/Steam/steamapps/workshop/content/431960/3679122549/index.html`；CDP targets 里壁纸窗口就是这个 `file://` 入口。该文档 `project.json` 与 `data.json` 200，`file:///C:/Windows/win.ini` 与兄弟目录被拦，垫片已注入并能拉取。切原生模式会改系统壁纸，未测；鼠标转发重启需人在桌面操作，未测 |
| [ ] | 离开窗口模式 | Windows 桌面 CEF dev | 网页壁纸时切到原生模式、或关闭壁纸 | `cleanup()` 丢弃 `WallpaperWindow`：`Drop` 清空根目录、`InputForwarder` 的 `Drop` 停止转发线程，窗口销毁无报错、无残留线程注入报错 | 部分验证：2026-10-28 真机关闭壁纸后 CDP targets 里壁纸窗口消失，重新开启后根目录按新窗口重设（本目录 200）；stdout 报错与转发线程退出需看 dev 终端，未核对；切原生模式未测 |
| [x] | 网页 ↔ 图片、网页 → 网页、改样式幂等 | Windows 桌面 CEF dev | 窗口模式下依次设图片 594 → kaguya → 594 → kaguya → Slideshow；在 kaguya 上以当前样式调 `set_wallpaper_style` | 切到图片回到 `index.html?window=wallpaper` 且 Vue 显示新目标；切到网页导航到其 `file://`；网页 → 网页直接换入口，根目录跟着换；改样式不重新加载页面 | 2026-10-28 真机（Windows 11 dev，CDP）：594 → kaguya 停在 `3679122549/index.html`，`data.json` 200、`../796697921/project.json` 与 `file:///C:/Windows/win.ini` 被拦、`__TAURI_INTERNALS__` 为 undefined；kaguya → 594 回到应用页且 `<img>` 为 594；kaguya → Slideshow 停在 `796697921/index.html`，本目录 200、`../3679122549/data.json` 被拦；`set_wallpaper_style("fill")` 前后页面上的标记变量保留（未重载） |
| [ ] | 网页 ↔ WPE 视频与轮播 | Windows 桌面 CEF dev | 网页壁纸 → WPE 视频 → 网页；开启轮播，轮播来源同时含网页行与图片行 | 切到 WPE 视频回到应用页并由 Vue 播放 `compatible_path`；轮播按顺序在 `file://` 与应用页之间切换 | 未验证：库里 WPE 视频行 id 未查；轮播会改用户设置，未开 |
| [ ] | 删除当前壁纸行时保持原页面 | Windows 桌面 CEF dev | 当前是 kaguya 时在图库删除这一行（`currentWallpaperImageId` 被清空） | 壁纸窗口保持 kaguya 页面不导航（与 Vue 对 `null` 目标保持现有画面、原生模式一致，WPE 目录不被删除）；之后设别的壁纸照常切换 | 未验证：2026-10-28 接受的行为变化，原实现会导航回应用页 |
| [ ] | 图库预览不变 | Windows 桌面 CEF dev | 打开 12099 预览 | 仍是 `/wpe/<id>/` 跨源 iframe 桌面画布，可交互 | 未验证：dev 未运行；本次未改预览代码 |
| [ ] | macOS | macOS 桌面 CEF | 窗口模式设网页壁纸 | 导航到 `file://` 并可读同目录文件；不转发鼠标 | 本机为 Windows，未验证 |
| [x] | 单测 | `tauri-runtime-kbcef` / `kabegame` | `test-kabegame` 跑 `file_access` / `input_forward` / `subprocess` | 目录内文件放行（含查询串）、百分号编码路径解码、`..` 与 `%2e%2e` 越界拒绝、兄弟壁纸目录与同前缀目录拒绝、目录本身与不存在拒绝、无根全拒、非 file URL 拒绝、符号链接拒绝（能建链接时）、登记表语义；桌面根窗口类名判定 | 2026-10-27：`tauri-runtime-kbcef` 13 个（`file_access` 10 + `subprocess` 3）与 `kabegame` 的 `input_forward` 1 个全部通过；Windows 无建符号链接权限时符号链接断言自动跳过 |

## WPE 壁纸导入（第二阶段 Phase 3：Web 导入 + 预览内嵌）

2026-10-26：`x-wpe/web` 入库（`compatible_path` 为空）、`/wpe` 专属网页 MIME 表与 HTML 产出点、CSP `frame-src` 放行 `http://127.0.0.1:*`、`WallpaperStage` 独立 web 层（跨源 sandbox iframe，不参与双层过渡，切走即销毁）、图库 `wallpaper` 形态与预览「桌面画布」、背景层退回预览图、`get_wallpaper_target_for_image`（作者属性改读图片 metadata），以及 `cef-ipc` 只收主 frame 的纵深防御。静态验证：check-kabegame driver 的 vue-tsc 与 cargo check 均 0 error；`kabegame-core --lib wpe` 中 scan / project 用例通过（`wpe::discover` 两个用例在未改动的 `discover.rs` 上失败，属既有问题）；`kabegame` 的 `wpe_web_mime` 与 `tauri-runtime-kbcef` 的 `ipc::tests` 4 个用例通过。真机为 Windows 11 dev（CEF 149，2560×1440 主屏），本机 Wallpaper Engine 创意工坊 7 个（视频 3、网页 4）+ `defaultprojects` 19 个（网页 2）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 壁纸文件原地更新 | Windows 桌面 CEF（图库预览） | 预览过一次 kaguya 后，修改其目录里的 js（或创意工坊更新），关闭预览再打开；DevTools 看 `/wpe` 响应头 | `/wpe` 的 js / css / json 等文本资源返回 `Cache-Control: no-cache`，重新打开加载新文件；图片、字体、音视频仍为 immutable；桌面壁纸走 `file://`，不经 `/wpe`，不受影响 | 2026-10-27 发现：3679122549 的 `script.js` 被格式化后触发混淆器 `selfDefending` 死循环，恢复成单行后仍加载旧缓存（一年 immutable）；`handle_wpe_file` 按 MIME 覆盖为 `no-cache`（`wpe_needs_revalidate`），待 dev 重建后真机验证 |
| [x] | 扫描计数 | Windows 桌面 CEF | 打开「开始收集 → 壁纸」对话框 | 每张来源卡片显示「N 个壁纸 / N 个可导入 / 视频 v · 网页 w / N 个已导入」，为 0 的类型省略；可导入 = 已支持类型（视频 / 网页）且未入库；全部已入库时底部提示「本机可导入的壁纸都已导入」 | 创意工坊「7 个壁纸 / 0 个可导入 / 视频 3 · 网页 4 / 7 个已导入」，`defaultprojects`「19 个壁纸 / 0 个可导入 / 网页 2 / 2 个已导入」；删掉一行后变为「1 个可导入」并自动勾选该来源 |
| [x] | 导入 web | Windows 桌面 CEF | 提交壁纸任务（创意工坊、`defaultprojects`） | 每个网页壁纸一行 `type=x-wpe/web`，`local_path` 为目录，缩略图为作者 `preview.*`，`compatible_path` 与宽高为空，`hash` / `size` 取入口 html，标签进 `WPE/<tag>`；scene / application / 其它计入跳过 | 新增 6 行（含 796697921 与 `defaultprojects` 的 corsair_collection / corsair_o_tron），796697921 挂到 `WPE/Abstract`；`defaultprojects` 其余 17 个按 scene / other 跳过 |
| [x] | dry-run | Windows 桌面 CEF | 勾选空跑提交 `defaultprojects` | 日志逐目录「dry-run 跳过」，`images` / `metadata` 行数不变 | 两条 `taskLogDryRunSkipImport`，`images` 8828 / `metadata` 4769 不变 |
| [x] | 幂等 | Windows 桌面 CEF | 再对创意工坊跑一次 | 不新增行，日志「已存在」 | 7 条 `taskLogWpeExisting`，汇总 imported 0 / existing 7 |
| [x] | `/wpe` MIME | HTTP | `curl -I` 入口与 `index.html` / `main.css` / `wallpaper.js` / `project.json` / `preview.jpg`，`--path-as-is` 请求 `../` 越界，`/file/<目录>` | `/wpe/<id>/` 307 到入口；html 为 `text/html; charset=utf-8` + `no-store`，其余为 `text/css` / `text/javascript` / `application/json` / `image/jpeg`；越界与 `/file/<目录>` 404；html 原样返回不注入脚本 | 全部符合 |
| [x] | 网格 | Windows 桌面 CEF | 画廊查看 | 显示作者 `preview.*`，角标「WPE · 网页」（视频行仍为「WPE · 视频」），网格不出现 iframe / video | 6 个网页行均显示 preview.gif / preview.jpg 与「WPE · 网页」；悬停经 CDP 合成指针未命中 `:hover`，悬停不升级由代码（WPE 行固定 thumbnail）保证 |
| [x] | 预览画布 | Windows 桌面 CEF | 打开 796697921 的预览 | 主屏比例画布，页面以「无属性」状态渲染 | Slideshow 显示「Use the settings panel to select a directory of images to display」；iframe 2560×1440，sandbox 正确 |
| [x] | 预览可交互 | Windows 桌面 CEF | 鼠标移到画布左上边缘 | 页面收到 `mousemove`，边缘控件出现 | 左上角播放列表 / 控制面板随移动显现 |
| [x] | 预览箭头唤出 | Windows 桌面 CEF | 预览网页壁纸（kaguya），鼠标从画布中间平移到左 / 右边缘中段，再移回画布中间 | 到达边缘中段时出现上一张 / 下一张箭头（同底部工具条的常驻热区）；从箭头区移回页面后箭头收起；边缘上下两段仍可与页面交互 | 2026-10-27 用户确认：新增 `preview-nav-hotzone`，箭头区 `mouseleave` 到 iframe 时收起 |
| [ ] | 预览工具条操作 | Windows 桌面 CEF | 预览网页壁纸（kaguya），鼠标移到底部唤出工具条，逐个悬停 / 点击全屏左侧的图标 | 右键菜单的可见项（收藏、详情、复制标签、打开、设为壁纸、加入画册、隐藏、移除…；WPE 不显示「欣赏更多」）按菜单顺序排成图标，悬停显示名称，菜单分隔线处有竖线；点击效果与右键菜单相同；收藏 / 隐藏图标随状态切换；图片预览的工具条不变 | 未验证：网页壁纸的右键落在跨源 iframe 里、到不了预览容器 |
| [x] | 预览无视频控件 | Windows 桌面 CEF | 同上 | 没有 `VideoControls`、不走 Panzoom；控制条只剩全屏 | 控制条按钮只有「全屏」 |
| [x] | 预览关闭 | Windows 桌面 CEF | Esc 关闭预览 | iframe 的 page target 消失 | `/json/list` 中 `/wpe/12099` 的 iframe target 消失，DOM 无 `.wallpaper-web-frame` |
| [x] | 设为壁纸 | Windows 桌面 CEF | 窗口模式设为壁纸 | 桌面壁纸窗口出现 web 层 iframe，`pointer-events: none`，媒体层清空，调试面板 `media: web`，ready 握手 yes | `eval --url wallpaper` 读到上述状态（WorkerW 下 CDP 截不到帧） |
| [x] | 切换壁纸 | Windows 桌面 CEF | 图片 → 网页 → 网页 → 图片 → 网页 | 网页切入：iframe load 后 web 层淡入、随后清空媒体层；网页 → 网页：先淡出销毁再加载；网页 → 图片：图片直设 base，web 层淡出后 iframe 先置 about:blank 再移除 | MutationObserver 时间线逐步吻合，iframe 移除在淡出后约 800ms，load 均在 40ms 内；首轮实测发现「先设 src 再插入」的 iframe 偶发停在初始 about:blank（重新赋 src 即恢复），已改为先插入再设 src 并加 3s 补发，修复后 5 次切换无复现 |
| [x] | 过渡 | Windows 桌面 CEF | fade / slide / zoom / none 下切入切出网页 | web 层按对应曲线整层淡入淡出，none 瞬时；媒体层不残留 | fade / slide / zoom 为 0.8s 的 opacity（+transform），none 无过渡；切入完成后 `img.base` src 清空 |
| [ ] | 非窗口模式 | Windows 桌面 CEF | 原生模式设为壁纸 | 提示切换窗口模式 | 未验证：切原生模式会改动本机系统壁纸；守卫按 `is_wpe_type` 前缀判断，本次未改 |
| [ ] | 轮播 | Windows 桌面 CEF | 轮播来源含网页行 | 窗口模式可选中；原生模式跳过 | 未专门验证：轮播开着，期间观察到切换到普通图片，未观察到选中网页行；`is_wallpaper_suitable` 本次未改 |
| [x] | 背景层 | Windows 桌面 CEF | 当前壁纸为网页行且开启应用背景 | 背景显示作者 preview 静态图，不出现 iframe | `.app-background-layer` 内为 `/thumbnail/…/796697921/preview.jpg`，无 iframe |
| [x] | 删除护栏 | Windows 桌面 CEF | `delete_image`（删记录并删源文件）删除 corsair_o_tron 行 | 记录消失，壁纸目录与 `preview.*` 完好 | 目录 13 个文件哈希删除前后一致；随后重新导入恢复（新 id 12100） |
| [ ] | 整理 | Windows 桌面 CEF | 整理覆盖网页行 | 行不被删除、缩略图不被覆盖 | 未验证：全库整理耗时长且会改写缩略图；护栏按 `is_wpe_row` / `is_wpe_type` 前缀判断，本次未改 |
| [x] | 隔离 | Windows 桌面 CEF | 进 iframe 查全局；父页面读 iframe DOM | `__TAURI_INTERNALS__` / `__TAURI__` / `ipc` 均 undefined；父页面访问被跨源拦截 | 均符合，iframe 源为 `http://127.0.0.1:<port>` |
| [x] | IPC 纵深防御 | Windows 桌面 CEF | iframe 内 POST `cef-ipc://localhost/`；主窗口同样 POST 并 invoke；壁纸窗口重载后握手；畅游窗口主 frame POST | 子 frame 400，主 frame 204，主窗口 invoke 与壁纸窗口 ready 握手正常，畅游主 frame 204 | 子 frame 返回 `400 CEF IPC postMessage is only accepted from the main frame`；其余均符合。另见：畅游页面经 `ipc://` 主通道的 invoke 报 `Origin header is not a valid URL`（Tauri `ipc` handler，与本次 `cef-ipc` 改动无关），待单独排查（2026-10-30 已由 tauri 补丁 12 修复，见本文件「tauri 补丁 12」） |
| [ ] | prod CSP | Windows 打包 | `deno task b` 后装包验证 | iframe 不被 `frame-src` 拦截 | 未验证：dev 不注入 CSP，未打包 |

## WPE 壁纸导入（第一阶段：Video）

2026-10-25：新增 Wallpaper Engine 壁纸目录导入（`x-wpe/video`）、`/wpe/<id>/` 目录服务、删除/整理/原生壁纸分流与壁纸窗口视频属性复现。静态验证：`cargo check -p kabegame --features standard` 与前端 `vue-tsc` / `vitest` 结果见本节末尾；真机使用本机 Wallpaper Engine 2.8.0.42（Steam 库 `D:/Applications/Steam`，创意工坊 2 个 + `defaultprojects` 19 个）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 自动发现 | Windows 桌面 CEF | 打开「开始收集 → 壁纸」对话框 | 每类来源一张卡片，带「N 个壁纸 / N 个可导入（视频且未入库）/ N 个已导入」标签；有可导入的来源默认勾选；底部显示将导入的数量，全都已入库时提示「本机的视频壁纸都已导入」；同一 Steam 库不会因注册表与 vdf 路径大小写不同而重复计数；`libraryfolders.vdf` 列出的其它盘 Steam 库（含 `431960` 的）也会被发现 | 2026-10-25 真机：创意工坊 2 个（1 视频已入库）、`defaultprojects` 19 个（0 视频），均只出现一次；修复前 `wpe_scan` / `wpe_recognize_dir` / `get_current_wallpaper_target` 未登记 ACL，对话框无结果。2026-10-26 修复 VDF 解析：顶层无花括号导致 vdf 从未解析成功（此前只靠 Steam 安装根兜底，其它盘的库发现不了）、旧格式 `LibraryFolders` 键大小写与统计字段误判为路径；`wpe::discover` 16 用例通过，本机 vdf 两个库（E 盘无 WPE，行为不变），多库真机未验证 |
| [ ] | 手动添加文件夹 | Windows 桌面 CEF | 依次选择创意工坊 `431960` 根、`wallpaper_engine` 安装目录、一个壁纸目录 | 均能识别并追加到自定义文件夹列表；普通目录提示未识别 |  |
| [ ] | 导入视频壁纸 | Windows 桌面 CEF | 提交壁纸任务，导入创意工坊 2725770343 | 生成一行 `type=x-wpe/video`，`local_path` 为壁纸目录，缩略图为 `preview.gif`，标签进入 `WPE/Retro`，创意工坊链接可打开 | 入口视频 276MB，不产生壁纸副本 |
| [ ] | 幂等 | Windows 桌面 CEF | 对同一来源再运行一次任务 | 不新增行；任务日志显示「已存在」并只补目标画册成员 |  |
| [ ] | 网格预览 | Windows 桌面 CEF | 在画廊查看导入的壁纸 | 网格显示作者 `preview.gif`（动图），右上角显示「WPE · 视频」；悬停不加载入口视频 |  |
| [ ] | 预览大图播放 | Windows 桌面 CEF | 双击打开预览并拖动进度 | 只走 `compatible_path`（`/compatible/…`，入口视频本身或兼容副本）播放，不经 `/wpe`，Range 拖动生效 |  |
| [ ] | 应用背景 | Windows 桌面 CEF | 把 WPE 壁纸设为当前壁纸并开启应用背景 | 主界面背景只走 `compatible_path` 播放同一入口视频 |  |
| [ ] | 窗口壁纸与轮播 | Windows 桌面 CEF | 窗口模式下设为壁纸；切换轮播来源到该壁纸所在画册 | 桌面只走 `compatible_path` 播放入口视频；轮播在窗口模式选中 WPE 行 |  |
| [ ] | 非窗口模式拒绝 | Windows 桌面 CEF | 原生模式设为壁纸；从窗口模式切到原生模式 | 前者提示切换窗口模式；后者改用画廊可用图片兜底且不把目录交给原生后端 |  |
| [ ] | 删除护栏 | Windows 桌面 CEF | 删除该记录（含勾选「删除源文件」） | 记录消失，WPE 目录与 `preview.gif` 完好；任务计数正确 |  |
| [ ] | `/wpe` 越界与 `/file` | Windows 桌面 CEF / HTTP | 请求 `/wpe/<id>/../project.json`、`/wpe/<id>/` 与 `/file/<壁纸目录>` | 越界 404；`/wpe/<id>/` 307 到入口；`/file/<目录>` 404 |  |
| [ ] | 整理 | Windows 桌面 CEF | 整理勾选重建缩略图、兼容副本与「移除无法识别媒体」，范围覆盖该行 | WPE 行不被删除、缩略图不被覆盖、兼容副本不按目录重建 |  |
| [ ] | 详情与操作 | Windows 桌面 CEF | 打开详情；右键查看菜单 | 类型显示「Wallpaper Engine · 视频」并有创意工坊链接；复制 / 分享 / 删除源文件不可用，「在文件夹中显示」打开壁纸目录 |  |
| [ ] | 空跑 | Windows 桌面 CEF | 勾选空跑运行壁纸任务 | 不写库，只统计并记录将导入的目录 |  |
| [ ] | 创意工坊取消订阅 | Windows 桌面 CEF | 移走壁纸目录后刷新图库 | 行仍在并标记缺失，不自动删除记录 |  |
| [ ] | 属性待校准 | Windows 桌面 CEF | 在 WPE 中对照 `fill`（contain）几何与 `wec_*` 滤镜 | 几何与亮度 / 对比度 / 饱和度 / 色相观感接近；差异记录到 WPE 文档 | 计划内的待真机验证项 |

## Windows 窗口壁纸 WorkerW 挂载

2026-10-25：根据 REA 的 WPE 调用链及已有运行时层级记录，替换 Windows 的 Progman 挂载路径；验证状态以下表为准。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | WorkerW 层级 | Windows 11 CEF | 开启窗口壁纸，枚举 Progman 子窗口 | 壁纸 HWND 的父窗口是无图标视图的整屏 WorkerW；图标可见且壁纸铺满屏幕 | 待新二进制真机验证 |
| [ ] | 无 Z-order 修正 | Windows 11 CEF | 点击桌面，最小化/隐藏/恢复主窗口，执行 Win+D | 图标始终位于壁纸上方；无 `fix_wallpaper_zorder` 调用 | 待真机验证 |
| [ ] | 生命周期 | Windows 11 CEF | 反复切换窗口壁纸模式 | 每次窗口创建后挂载，退出模式时解绑并销毁，重进不沿用旧 HWND | 待真机验证 |
| [ ] | 多屏/DPI | Windows 11 CEF | 在负坐标副屏与不同缩放显示器上挂载、变更分辨率 | 窗口位置和尺寸与目标监视器一致 | 待设备验证 |
| [ ] | Explorer 重建 | Windows 11 CEF | 受控重启 Explorer 后调用 `wemt_refresh` | 失效宿主被识别，重新发现并挂载 | 待受控验证；自动触发尚未接入 |

静态验证：`tauri-plugin-wemt` 默认特性及 `--no-default-features` 的 `cargo check` 通过；插件格式、前端变更文件 Prettier、`git diff --check` 通过。应用级 `cargo check` 因本机运行中的 CEF 占用其运行时文件，在 `cef-dll-sys` 复制阶段以 `os error 32` 中断；前端 `vue-tsc` 因本机 `node_modules/vitest/dist/chunks/global.d.DVsSRdQ5.d.ts` 文件内容异常（开头 32 字节均为零）而报 `TS1127`。这两项尚不能作为变更代码的通过证据。

## 壁纸轮播：一个 PathQL 路径 + 持久化位置

轮播只认 `wallpaperRotationPath`（不含分页尾）与 `wallpaperRotationPosition`。每次切换先 count 有效路径（原生模式尾部拼 `_kb_fc/media-type/image`），出错回落默认全画廊随机路径，再从当前壁纸 id 经 `~~/rank` 定出的下一张开始取（当前壁纸不在路径里才用持久化位置）；换路径时立即设新路径的第 1 张。入口是查询行 ⋯ 面板的「用当前视图轮播」（路径由 `ImageGrid` 注入），设置页只读展示。切换壁纸模式按当前壁纸 id 经 `~~/rank` 重定位。设置迁移框架对齐数据库迁移，v003 把旧三键换算成路径。Android Worker 改为消费 `rotation_queue.json`。

2026-10-27：macOS 桌面 CEF dev 真机（韩语界面），经 CDP 在主窗口调用命令并点击 ⋯ 面板；测完已恢复 dev 的轮播设置与窗口模式（中途切过原生模式，系统桌面壁纸被换成测试图）。测试画册已删除。「换路径立即切到第 1 张」一行在改为按当前 id 定起点、换路径立即切换后补测；测完恢复路径时立即切到了该视图第 1 张（8743，窗口模式），随后清空了当前壁纸 id，位置为 1。换路径经位置 `-1` + 唤醒轮播线程实现后连跑 4 轮（另有 3 轮带 debug ingest 插桩确认每次换路径只切一次）均与表中一致。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 旧设置迁移 | dev app | 用 v2 的 settings.json 启动 | 迁到 v3，生成 `settings.json.bak-v2`；画廊 + 随机 → `images://gallery/hide/sort/random-<seed>`，位置 0，启用状态等原样 | dev 原为画廊随机、未启用，迁移结果与备份一致。其余五种组合由 v003 单测覆盖 |
| [x] | 按视图逐张前进 | 桌面 dev（窗口模式） | `set_wallpaper_rotation_path("images://gallery/hide/sort/by-id")` 后开启轮播，连续手动切换 3 次 | 位置 0→1→2→3，壁纸依次为视图前 3 张 | 30、31、32，与 `_kb_x8x/1` 前三行一致（窗口模式含视频）。此行测于「换路径立即切换」之前，现在设路径时就已切到 30 |
| [x] | 停开轮播保持位置 | 桌面 dev | 关闭再开启轮播；再用同一路径设一次 | 位置与当前壁纸不变 | 均保持位置 3 |
| [x] | 非法路径被拒 | 桌面 dev | 设 `albums://roots`、`images://gallery/hide/nope-xyz` | 报「轮播路径无效」，设置不变 | 分别报 row missing `local_path` 与 path not found |
| [x] | 切换模式重定位 | 桌面 dev | 窗口模式轮到第一张图片（38）→ 切原生 → 切换一次 → 切回窗口 → 切换一次 | 原生下位置为 38 在图片路径里的序号，下一张是其后的图片；切回窗口后接着 by-id 的下一张 | 窗口位置 8 → 原生位置 1、下一张 45 → 窗口位置 15、下一张 46 |
| [x] | 用当前视图轮播（窗口模式） | 桌面 dev | 画廊加宽高比过滤 + 时间倒序，打开 ⋯ 面板点「用当前视图轮播」 | 写入该视图路径、位置 0、开启轮播；按钮变为「正在轮播此视图」并禁用；成功提示 | 路径 `images://gallery/hide/aspect/16x9-/_kb_fc/sort/by-time/_kb_desc`。测于「换路径立即切换」之前；现在点按钮会立即设该视图第 1 张、位置为 1，按钮 UI 未重测 |
| [x] | 原生模式视频提示与取图 | 桌面 dev（原生模式） | 未选「仅图片」时点「用当前视图轮播」，再手动切换一次 | 提示视频会被跳过；切到的是图片 | 提示出现；切到 8743（webp 2504×1408） |
| [x] | 画册轮播循环与删除 | 桌面 dev | 新建含 3 张图的画册，设为 `album/<id>/sort/by-album-order` 切换 4 次，再删除画册并切换一次 | 按画册顺序 3 张后回到第 1 张；删除后路径回到默认（null），下一次切换写入新的默认随机路径 | 279→280→281→279；删除后路径 null、位置 0；切换后写入 `random-2937306784365644` |
| [x] | 换路径立即切到第 1 张，之后按当前壁纸续接 | 桌面 dev（窗口模式） | 设 by-id 视图后切 2 次；换成倒序视图；同一路径再设一次后切 1 次；换成只看视频的视图后切 1 次；手动设一张不在视图里的图片后再切 1 次 | 每次换路径立即设新视图第 1 张；同一路径再设不切换；之后接当前壁纸的下一张；当前壁纸不在视图里时按位置继续 | 设路径即 30，切换 31、32；倒序立即 8927，再设仍 8927，切换 8926；视频视图立即 30，切换 31；手动设 38 后切到 32，位置 3 |
| [ ] | count 出错回落 | 桌面 dev | 让设置路径失效（如插件扩展路径的插件被卸载）后切换 | 自动换成默认随机路径并从第 1 张开始，启动结果 `fallback: true` | 设置入口会先校验、CLI 不暴露写设置，未找到真机触发手段 |
| [ ] | 设置页只读路径 | 桌面 dev | 打开设置 → 壁纸 | 三个旧控件消失，显示「当前轮播路径」与迁移说明 | 仅类型检查通过，未截图 |
| [ ] | 画册右键设为 / 停止轮播 | 桌面 dev | 画册树右键「设为轮播」，再看树上轮播标记与右键「停止轮播」 | 路径为该画册默认视图，树标记与菜单状态正确 | 未点 UI；同路径的命令层已验证 |
| [ ] | 原生兼容副本 | Windows / Linux 原生模式 | 轮到 WebP / AVIF 图片 | 仍生成并复用 `wallpaper_compatible_path`，桌面正常显示 | rotator 仍把原始 `local_path` 交给原生后端；本机 macOS 未测 |
| [ ] | Android 队列 | Android dev | 设路径并开启轮播，等 WorkManager 触发，再回到应用 | 生成 `rotation_queue.json`；后台按队列换图且只换图片；回到应用后位置与当前壁纸同步 | 本机缺 Android rusty_v8 产物，`--mode android` 交叉检查未能运行，Android 门控代码仅人工复核 |
| [x] | 单测与 DSL 端到端 | 单测 | `deno task test` | 迁移框架、v001–v003、路径工具、`_kb_fc/media-type/image` 接在各类视图尾部的 count / 取行 / rank 一致 | kabegame-core：dsl_e2e 58 项全过；lib 353/355，失败的 `webview_watchdog_suspends_while_host_hidden`、`batch_adds_and_deletes_file_rows` 是并行时共享临时库的建表竞争，单独重跑均通过。前端 Vitest 574 通过。kabegame crate 的测试二进制在 macOS 上找不到 CEF framework 无法启动，rotator 的 `wrapped_position` 单测未跑 |

## metadata 冻结描述模板（`plugin run --freeze-template`）

CLI `plugin run` 加 `--freeze-template` 后，任务冻结时读一次插件包内 `kbDescriptionTemplate`，`Task::insert_metadata` 写进每行 `metadata.template`。开关只在内存中经 `CrawlTaskRequest` 传递，不入任务记录。详情面板并行获取冻结模板与插件模板，前者非空即覆盖。去重覆盖改挂新行，data 与模板一起被替换，未冻结时清空；metadata 迁移原样拷贝模板，去重按模板分区。IPC 协议升到 v4。

2026-10-26：macOS 桌面 CEF dev 真机实测（`deno task b -c kabegame-cli --data dev` 新建 dev CLI，`deno task dev -c kabegame` 启动时执行 v047 迁移，`metadata` 表新增 `template` 列）。用 `miyoushe`（V8，模板经 `__bridge.getPluginData()` 读表情映射）以 `run-cli.sh` 跑「壁纸」搜索第 1 页；经 CDP 打开预览并读取 iframe DOM，截图在会话 scratchpad。测试 id 产生的图片与任务已清理。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 测试 id 冻结模板渲染 | dev app + dev CLI | 运行 `plugin run <kgpg> --id <id>-test --freeze-template` 后，打开一张测试 id 图片的详情 | 插件详情面板以 iframe 渲染模板，不再只显示原始键值 | `--id miyoushe-ft1` 入库 60 张、3 行 metadata，`template` 全部非空且与包内 `description.ejs` 逐字节一致；`pathql query images://id_<id>/metadata_full` 返回 `template`。测试 id 未安装，详情面板以 iframe 渲染帖子卡片，原始键值 0 项 |
| [x] | 未冻结回退 | dev app + dev CLI | 不加 `--freeze-template`，用新测试 id 跑一次并打开详情 | 未安装插件时显示原始 metadata 键值 | `--id miyoushe-nf1 --no-freeze-template`：metadata `template` 为 NULL，详情面板无 iframe，显示 25 项原始键值 |
| [x] | 冻结模板覆盖插件模板 | dev app + dev CLI | 对已安装插件改本地模板后打包，用已安装 id 加 `--freeze-template` 运行 | 新图片详情使用冻结的新模板；旧图片仍用已安装插件模板 | 已安装 `miyoushe`：先用已安装 id 不冻结跑出旧图，再把加了隐藏标记的模板打包，以路径模式 `--id miyoushe --freeze-template` 跑新图。新图 iframe 含标记，旧图不含。注意：同版本重新打包后，前端内存里的插件模板缓存（`pluginFiles` 按版本 URL 缓存）在 `refresh_plugins` 后仍是旧内容，需要重载页面 |
| [x] | 去重覆盖清空模板 | dev app + dev CLI | 开启「去重时更新元数据」，先带 `--freeze-template` 跑一次，再不带参数跑同一批 | 第二次去重命中后图片改挂新 metadata，详情退回插件模板或原始键值 | 开启「去重时更新元数据」与自动去重（dev 原为关闭，测完已恢复），同一测试 id 不冻结重跑同一批：60 张 URL 去重命中，图片改挂新 metadata（如 12422→12429），新行 `template` 为 NULL，旧冻结行被 GC；详情退回原始键值。命中的旧图若是其它来源，`plugin_id` 也会改为本次 id（符合「插件下载覆盖任意来源」设计）。自动去重关闭时重跑会重复入库，不会命中 |
| [x] | bridge 按测试 id 取数 | dev app | 打开使用 `__bridge.getPluginData()` 的插件模板的测试 id 图片 | 读到测试运行写入的插件数据，模板正常渲染 | iframe 内 `__bridge.getPluginData()` 返回 `miyoushe-ft1` 的数据（`miyoushe_emoticon_map` 3105 项），正文渲染出 13 个表情图片 |
| [ ] | IPC v4 门控 | dev CLI | 主程序运行时执行 `plugin run --freeze-template`，确认走 app IPC | 新 CLI 与新主程序协议一致并走 app；连旧主程序时打印协议过旧并回退本地 | 前半部分已验证：dev app 运行时 CLI 输出「经主程序执行（版本 4.6.1）」，没有协议过旧回退，任务进入 app 任务表。连旧主程序回退本地未测（缺少 v3 主程序） |
| [x] | 迁移保留模板与去重分区 | 单测 | `frozen_template_tests` | 写回新行拷贝模板；data 相同、模板不同的行不合并；改挂到无模板行后旧冻结行被 GC | `deno task test` kabegame-core 通过 |
| [x] | v047 迁移幂等 | 单测 | `v047_metadata_template::tests` | 执行两次只加一列，旧行 template 为 NULL | 通过 |

## 图片详情「基本信息」卡片式排版

`ImageBasicInfoPanel` 从「标签：值」两列改为卡片：名称标题（两行省略）→ 源头像 + 源名 + 收藏时间（年 / 月 / 日分别可点）+ 任务按钮 → 媒体芯片（类型种类 / 格式、文件大小、像素尺寸、宽高比矩形框）→ URL 与本地路径行。宽高比框高 22px、宽按比例夹在 12–56px，接近常见比例（1.5% 内）显示 `16:9` 等，否则显示小数；框放不下文字时写在框外。路径从左侧省略、保留文件名。预览侧栏里基本信息不再与原生元数据平分高度，按自然高度显示。

2026-10-26：macOS 桌面 CEF dev 真机，韩语界面，经 CDP 打开画廊预览截图验证；截图在会话 scratchpad。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 卡片排版 | 桌面 dev | 打开一张插件来源图片的预览与详情弹窗 | 名称、源、时间、芯片、链接行按新排版显示，无大片空白 | 预览侧栏：名称两行、PixAI 图标 + 源名 + 时间 + 任务按钮、芯片两行、URL 与路径各一行，面板约 280px 高。首版名称被 flex 压成 0 高、面板平分高度导致链接行被滚出，已修。详情弹窗未单独看 |
| [~] | 筛选入口不丢 | 桌面 dev | 依次点源、年 / 月 / 日、种类、格式、大小芯片、宽高比框 | 均跳到画廊对应筛选 | 宽高比框已验证：点 16:9 图片的框后预览关闭，画廊计数 3127 → 213。其余入口沿用原 `emitGalleryFilter`，未逐个点 |
| [x] | 宽高比框 | 桌面 dev | 分别打开横图（16:9）、方图、竖图（9:16）、超宽图 | 框与图片同比例；横图与方图文字在框内，竖图文字在框外 | 2504×1408 → `16:9` 框宽 39px 文字在框内；1408×1408 → `1:1` 22px；1232×1632 → `3:4` 17px、720×1280 → `9:16` 12px、1104×1824 → `3:5` 13px，文字在框外。超宽图库里没有，未测 |
| [ ] | 宽高比框不写比值 | 桌面 dev | 打开横图、方图、竖图的预览，看基本信息里的宽高比框，鼠标停在框上 | 框与图片同比例、里外都没有比值文字；悬停提示「按宽高比筛选 · 宽 × 高」（真实像素）；点了照常按宽高比筛选 | 2026-11-20：`ImageBasicInfoPanel.aspect.test.ts` 2 例过，真机待用户确认 |
| [~] | 链接行 | 桌面 dev | 点 URL、点本地路径、点复制按钮、右键本地路径 | 打开链接 / 打开文件 / 复制成功提示；长路径保留文件名，开头的 `/` 不跑到末尾 | 两个复制按钮均弹「클립보드에 복사됨」，`pbpaste` 拿到完整 URL 与路径；路径显示 `… Lumiera （oc）.webp`。点击打开未测（会拉起外部程序） |
| [ ] | 畅游与未知来源 | 桌面 dev | 打开畅游下载的图片与无来源图片 | 畅游显示站点 host 与罗盘图标，点击打开畅游记录；未知来源显示 unknown 且不可点 | |
| [ ] | 视频与缺失字段 | 桌面 dev | 打开视频、无尺寸或无 URL 的图片 | 视频芯片用摄像机图标；缺失字段对应芯片 / 行不显示 | |
| [ ] | 暗色主题与 Android | 桌面 dev / Android dev | 切暗色主题；Android 打开详情 | 芯片、矩形框、链接配色可读；窄屏下芯片自动换行 | |

## Android 平板宽屏预览滑动切图

`ImagePreviewDialog` 的模板在 Android 上一律渲染 PhotoSwipe（`v-if="IS_ANDROID"`），但滑动回流（`swipe` / `reach-boundary` → `requestSwitch`）、换图重置、关闭通知等脚本分支仍按 `uiStore.isCompact`（宽度 < 断点）判断。平板横屏宽度超过断点时 PhotoSwipe 照样显示，滑动事件却被直接丢掉，上层 `previewedId` 不动，窗口被拉回原图。改为与模板同源的常量 `USE_PSWP = IS_ANDROID`。

滑动修好后又暴露同类问题：`ImageGridCore` 预览切图的 watch 只在 `isCompact` 时「预览与选择解耦」，平板宽屏走桌面逻辑把当前图设为选中；而 Android 上有选中即打开多选模式的 `androidSelectionModal` 栈位，压在预览之上，于是滑过之后第一次返回只清掉了这个看不见的多选，预览关不掉。该文件其它 Android 多选判断已是 `isCompact || IS_ANDROID`，补齐剩下三处（切图同步选中、多选时点空白不清空、`exitAndroidSelectionMode`）。

2026-10-26：Android 16 平板 dev 包（横屏 1163×776、竖屏 776×1163 CSS 像素）真机实测，CDP 打开画廊预览，用 `adb shell input swipe` / `keyevent BACK` 真实手势与按键，`adb screencap` 截图在会话 scratchpad。返回键问题用 debug ingest 插桩 + 包装 `modalStack.acquire` 定位，已删除插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横屏左滑下一张 | Android 平板 dev | 打开第 1 张，向左滑两次 | 依次切到第 2、3 张，背景网格跟随定位 | 第 1 → 2 → 3，网格高亮跟到第 3 张 |
| [x] | 平板横屏右滑上一张 | Android 平板 dev | 在第 3 张向右滑 | 回到第 2 张 | 通过 |
| [ ] | 跨页切换 | Android 平板 dev | 在一页最后一张继续左滑 | 加载下一页并切到其首张 | 未测：dev 库只有 36 张，最小页大小 100，只有一页 |
| [x] | 上划删除 | Android 平板 dev | 宽屏下在第 2 张上划 | 图片按画廊语义加入隐藏，预览切到相邻图 | 第 2 张被隐藏（共 36 → 35），预览切到第 3 张；测完用 `remove_images_from_album` 从隐藏画册移出还原 |
| [x] | 滑动后返回键关闭 | Android 平板 dev | 打开预览、左滑两次、按一次返回 | 一次返回即关闭预览，网格不留选中 | 修复前：滑一次后返回栈多出多选栈位，第一次返回不关预览；修复后栈位始终只有预览一个，一次返回关闭，无残留选中 |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 打开预览左右滑、上划删除、返回 | 与修复前一致 | |
| [ ] | Web 窄屏预览 | Web | 窄窗口打开预览 | 走桌面 Dialog 分支，缩放 / 切图 / 关闭正常 | 此前 Web 窄屏渲染 Dialog 却走紧凑分支（关闭时不清理 Panzoom 等），现与模板一致 |

## Android 宽屏布局让开系统栏

targetSdk 36 强制 edge-to-edge，`MainActivity` 把系统栏 inset 注入成 `--sat` / `--sab` / `--sal` / `--sar`，由 CSS 各自留白。以前只有紧凑布局（底部 tab、主区顶部）用了它，平板宽屏的「侧栏 + 主区」两边都没垫：顶部头像和页头压在状态栏下，底部内容被导航栏盖住。现在非紧凑布局下侧栏垫上 / 下 / 左并按 `--sal` 加宽，主区垫上 / 下 / 右，背景仍铺到系统栏下面；ElDialog 的桌面样式不再排除 Android。曾试过在原生层给内容根节点加 padding、彻底去掉 safe-area CSS，但预览时图片四周会多出一圈浅色系统栏带，已放弃。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横竖屏无遮挡 | Android 平板 dev | 横屏、竖屏打开画廊、画册 | 侧栏头像与页头在状态栏下方；列表滚到底时最后一行在导航栏上方 | 横屏画廊滚到底最后一行完整、画册页三栏底部无遮挡；竖屏（776 宽，仍是宽屏布局）画廊同样正常。设置页未看 |
| [x] | 预览仍沉浸 | Android 平板 dev | 打开图片预览 | 预览铺满全屏（含系统栏下方），顶部控件不压状态栏 | 图片延伸到状态栏与导航栏下方 |
| [x] | 亀ちゃん不被导航栏挡住 | Android 平板 dev | 默认位置看亀ちゃん；把它往下拖到底、再往上拖 | 脚底在导航栏上方；拖动跟手、不跳位，拖到底被夹在导航栏上方 | 宿主 margin 等于安全区，`left` / `bottom` 改为相对安全区，拖动起点与夹取都扣掉 margin。竖屏实测：离视口底 54.6px（8 + 导航栏 47）；上拖 200px 位移正好 200px；再拖到底回到 54.6px |
| [ ] | 手机横屏刘海 / 侧边导航 | Android 手机 dev | 横屏（宽度 ≥ 768）且导航栏或刘海在侧边 | 侧栏加宽让开左侧，主区让开右侧 | |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 竖屏紧凑布局 | 与修改前一致 | 只改非紧凑布局 |
| [ ] | 桌面不回归 | 桌面 dev | 打开主窗口 | 侧栏宽 64px，无多余留白 | 桌面 inset 全为 0 |
| [x] | 平板弹窗与桌面一致 | Android 平板 dev（横屏 / 竖屏） | 打开「开始收集」等 ElDialog | 与桌面同样限高、header / footer 固定、仅 body 滚动，上下让开状态栏与导航栏；宽度按组件自身 width，不再是 90vw | `dialogs.css` 原先整套规则挂在 `html:not(.platform-android)` 上，平板走 ElDialog 分支却被排除，弹窗按内容撑高（1544px > 视口 1163px），底部「开始收集」落在导航栏下。去掉平台门控、限高与边距叠加 `--sat` / `--sab`，90vw 只在 `max-width: 767.98px` 下生效。「开始收集 → 网络」实测：横屏弹窗 71–690（视口 776），竖屏 90–1058（视口 1163），宽 600px，表单在 body 内滚动，底部按钮在导航栏上方；返回键可关闭 |
| [ ] | 手机弹窗 | Android 手机 dev | 打开仍用 ElDialog 的弹窗 | 宽 90vw，限高后内容在 body 内滚动 | 手机端过去不限高 |


## Web 版前端静态资源走 CDN

生产 web 构建（`isWeb && command === "build"`）的 Vite `base` 指向 `https://cdn.kabegame.com/web/`，`index.html` 仍由二进制内嵌返回；`deploy-web.sh` 先经服务器暂存目录把其余文件 `cp` 进 OSS 挂载点 `/mnt/oss/web/`，校验入口脚本 MIME 后再换二进制。插画移到 `src/assets/`，web 用按显示尺寸压缩的 WebP、本地模式用原图，未引用的那份由 `dropUnreferencedSrcAssets` 从产物删除。

2026-10-28：macOS 宿主用 `vite build` 分别出 web / 桌面前端到会话 scratchpad（未经 `deno task build:web`，二进制未重编、未部署）。web 产物按 `deploy-web.sh` 第 0 步同样的命令上传到线上 OSS（新文件名带哈希，只增，不影响线上页面）；浏览器验证用 puppeteer 在有界面 Chrome 里让 `demo.kabegame.com` 的文档请求返回新构建的 `index.html`，RPC 仍打线上后端（10-24 版本）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | web 产物走 CDN 前缀 | 宿主 `vite build --mode web` | 查看 `index.html` 与 chunk 内的资源 URL | 脚本、样式、modulepreload、`icon.png`、插画都以 `https://cdn.kabegame.com/web/` 开头 | 入口 `https://cdn.kabegame.com/web/assets/index-D89OIi2J.js` |
| [x] | 桌面产物不变 | 宿主 `vite build`（桌面模式） | 同上 | 资源 URL 仍以 `/` 开头 | `/assets/index-…js`、`/icon.png` |
| [x] | 插画只带一份 | 两种模式各构建一次 | 列出 `assets/` 里的 png / webp | web 只有 5 张 WebP，桌面只有 5 张 PNG，代码引用一致 | 加插件前两边各多出另一份（web 多 8 MB 原图） |
| [x] | OSS 上传与响应头 | 线上 OSS | 按 `deploy-web.sh` 第 0 步上传后 `curl` 入口脚本、CSS、WebP | JS 为 JavaScript MIME，CSS 为 `text/css`，带 `Access-Control-Allow-Origin: https://demo.kabegame.com`，支持 gzip | 47 个文件上传约 8 s；JS 为 `application/x-javascript`。直接 rsync 到挂载点会把 JS 标成 `application/octet-stream`，已改为暂存目录 + `cp` |
| [x] | 浏览器从 CDN 加载 | 有界面 Chrome，新 `index.html` | 打开 `/gallery`，再整页打开 `/surf` | 所有脚本 / 样式 / 插画来自 CDN，无失败请求、无控制台错误；吉祥物与冲浪 logo 正常解码 | CDN 35 个请求（JS 20、CSS 9、WebP 5、icon 1）全部 200，源站 `/assets/` 0 个；FCP 572 ms；站立图 344×792、冲浪 logo 540×540 |
| [ ] | 图库缩略图出图 | 有界面 Chrome，新 `index.html` | 打开 `/gallery` 等缩略图加载 | 首页缩略图正常显示 | load 后 6 s 内统计到 0 张已解码缩略图，期间没有请求空状态 / 失物图，判断是等待时间不足；之后两次复测都卡在本机客户端证书弹窗上，未完成 |
| [ ] | `deploy-web.sh` 全流程 | 宿主 + 服务器 | `deno task build:web` 后 `bash scripts/deploy-web.sh` | 先传 OSS、校验入口 MIME，再传插件、换二进制；线上页面资源全部来自 CDN | 未执行，需要重编二进制并重启线上服务 |
| [ ] | 部署后首屏 | 线上 demo | 清缓存打开首页，按慢速 4G 再测一次 | 首次绘制、首个 pageview 明显提前 | 部署前的同口径对照：不限速 FCP 6.9 s → 1.8 s，慢速 4G 18.2 s → 5.6 s |
| [x] | 本地模式插画：吉祥物站立图、冲浪 logo | 桌面 CEF dev | 经 CDP 读画廊页吉祥物与畅游页 logo 的 `currentSrc` / 尺寸并截图 | 加载 `src/assets` 下的原图 PNG，显示与改动前一致 | `/src/assets/kamechan/stand.png` 668×1540、`/src/assets/swim.png` 1254×1254，截图正常 |
| [ ] | 本地模式插画：挥手、空状态、空封面、失物图 | 桌面 / Android dev | 点吉祥物挥手；打开空画册与空图库；触发图片丢失 | 显示原图 PNG | 未在 app 里触发；构建产物里这几张也只引用 PNG |

## 数据库异步回填 + 启动页（`backfill_jobs` / `BackfillService` / Init app）

迁移拆成同步 schema 迁移与可恢复回填：回填登记进 `backfill_jobs`，按批提交并同事务写游标；带 `min_backfill_version` 的迁移前同步排干被依赖的回填（启动页显示进度），其余进入界面后由 `BackfillService` 在后台跑（忙碌卡片）。桌面启动拆成主线程建窗 → 线程内重型初始化 → 主线程收尾，主窗口先挂启动页，`ready` 后卸载再挂主界面。框架验证用的两个临时作业（重建 `metadata_search_terms`、补算 `images.compatible_path`）已在验证后删除，发布态注册表为空；下表「dev 实测」各行均在临时作业仍存在时于 macOS dev 完成，dev 库验证前清空了全部搜索词、`compatible_path` 列与 `compatibles/` 下 548 个文件（1.4 G）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 旧库升级：迁移 + 后台回填 | macOS dev（库 v47） | `deno task dev` 启动 | 主窗口出现，v048 / v049 执行并登记两个作业；进入画廊后忙碌卡片「更新数据库」依次显示两个作业（排队中的显示「排队中」）并推进；结束后卡片消失 | 重型初始化约 1 s 就 ready，启动页未来得及挂载（首个阶段事件即 ready）；卡片截图「更新数据库 / 补算兼容副本 23% 1,242 / 5,299」 |
| [x] | 回填终态数据 | dev 库 | 作业结束后查库 | 搜索词映射重建；`compatible_path` 无空行，需要的图片重新生成兼容副本，其余写哨兵；`compatibles/` 无孤儿文件 | 映射 550,644 / 词典 113,517（清空前 316,602 / 77,686，差异来自插件自定义 `searchTexts` 被默认展开规则重建，属预期取舍）；空行 0，哨兵 4,887，副本 412（jpg 295 / png 39 / webp 78）= 目录内 412 个文件（902 M）；无视频需要转码 |
| [x] | 补丁免刷新 | dev | 回填期间停留画廊 | 被补 `compatiblePath` 的行经 `images-change` / `image-changed` 就地更新 | debug ingest 统计前端收到 5,295 / 5,299 条 `compatiblePath` 补丁（差额是强杀重启期间主界面尚未挂监听的批次） |
| [x] | 中断续跑 | dev | 兼容副本作业进行中 `kill -9` 主进程，再启动 | 从游标续跑、不重做；无孤儿文件 | 强杀时 cursor 1952 / processed 1295、73 个副本 = 73 行引用；重启日志 `start image_compatible_path (processed 1295/…)`，终态 processed = total = 5299 |
| [x] | 阻塞回填（启动页进度条） | dev | 清空词表、把搜索词作业重置为未完成，`KABEGAME_BACKFILL_SYNC_THROUGH=48 deno task dev` | 启动页显示「正在更新数据：重建搜索词」与进度条 / 计数，完成后依次 services → ready，卸载启动页进入画廊 | 截图「3,600 / 3,959」；前端收到 2600→3959 的进度事件后 ready 并卸载 |
| [x] | 初始化失败 | dev | 临时注入作业失败（`DEBUG-backfill`，已删除）+ 阻塞开关启动 | 启动页显示「启动失败」与错误文本，「退出」按钮可退出；作业记 `attempts=1` 与 `last_error`、游标不前进，版本不变 | 截图正常；点退出后进程经 CEF 正常 shutdown 退出 |
| [x] | CLI 本地模式不跑后台回填 | dev CLI（主程序关闭） | 作业未完成时 `kabegame-cli --via local data import-image <已入库图片>` | 命令照常执行；未被依赖的作业保持 pending | 去重 1、作业仍 done=0；同命令加 `KABEGAME_BACKFILL_SYNC_THROUGH=48` 时在阻塞阶段排干（done=1，映射恢复 550,644）；`pathql query` 正常 |
| [x] | `--minimized` 自启动 | dev 二进制直跑 | 作业未完成时 `target/debug/kabegame --minimized` | 不建主窗口，初始化照常 ready，后台回填跑完 | 日志 `Startup ready` → `metadata_search_terms_rebuild done` |
| [x] | 无作业时的正常启动 | dev（删除临时作业、库复位 v48） | `deno task dev` | 直接进入画廊，无忙碌卡片，不新增 `backfill_jobs` 行 | 启动页未挂载（ready 早于页面加载）；库仍 v48、作业 0 行 |
| [ ] | 启动页在慢启动下可见 | 桌面 release / 慢盘 | 首次升级大库启动 | 重型初始化期间窗口显示「正在加载插件」「正在升级数据库（vNNN …）」等阶段 | 本机 dev 重型初始化太快，只在阻塞回填时看到启动页 |
| [ ] | 回填期间写操作 | dev | 后台回填进行中下载 / 删除 / 收藏 | 均正常；批间释放写锁，不报 busy | 未在长作业期间实测 |
| [ ] | 初始化失败的原生对话框 | `--minimized` | 让重型初始化失败 | 无主窗口时弹致命错误对话框 | 未实测；有主窗口时改为启动页显示错误 |
| [x] | 整理「补充兼容格式」不变 | 代码 | — | 行为不变 | 验证用的抽取已撤回，`organize.rs` / `images.rs` 与改动前一致 |
| [x] | 原生壁纸兼容副本 | 代码 | — | `wallpaper_compatible_path` 仍惰性生成，不做回填 | 未触碰相关代码 |
| [ ] | Android 启动 | Android dev 真机 | 冷启动 | 启动页一闪或直接进入主界面，无白屏卡死 | 本机没有 adb，也没有 `bin/android/arm64/` 自建产物，未实测、也未做 `--mode android` 交叉检查 |
| [ ] | Linux / Windows 启动 | 桌面 | 冷启动（含托盘、壁纸窗口、`init_post` 回主线程） | 主窗口先出现，托盘与壁纸照常 | 只在 macOS 实测 |
| [ ] | Web 版 | web 服务 | 启动服务端并打开页面 | 跳过启动页，后台回填照常 | 未实测 |

## Phase 6c：桌面零 HTTP / `fetch(file:)` / 插件文件命令

桌面标准版移除本地 HTTP 文件服务；应用页通过 CEF 私有 CORS 列表和跨源白名单读取 `file:`，插件文件由 Tauri 命令返回原始字节。下表真机项待重编 CEF 并完全重启 dev 后执行。

| 状态 | 编号与项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 前端类型 | Windows 本地 | `node ./node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/kabegame/tsconfig.json` | 0 error | 已通过 |
| [x] | S2 CEF 补丁序列 | Windows 本地 | `deno task patch cef --check`、正式应用 | 01–06 全部成功 | 2026-10-30：codex 沙箱内 Git 子进程 `EPERM`，它手工生成的 06 误以 vendor 基线为底、把 04 的 hunk 也带了进去，`--check` 在 06 报 `patch does not apply`；沙箱外用 `deno task patch cef --gen --from 05 --out …` 重新生成（`index` 基于 04 后的 blob，只含 06 自己的 hunk），`--check` 输出 `OK dry-run`，正式应用 `6 patches applied`，工作树反向 `apply --check` 与序列一致 |
| [x] | S3 桌面 Rust 检查 | Windows 本地 | `deno task check -c kabegame`（`CARGO_TARGET_DIR=target-check`） | 0 error | 2026-10-30 沙箱外复跑：vue-tsc 0 error、cargo check 0 error（1m35s）；27 条 warning 与 6b 时相同，`lib.rs:459` 两条只是原 462 行因删 `start_http_server` 三行而移位。Android mode 本机缺 `bin/android/arm64/rusty_v8-build/`，未进入编译 |
| [x] | S3a Web Rust 检查 | Windows 本地 | `deno task check -c kabegame --mode web` | 0 error | 首次 3m 50s，最终增量复查 6.61s；与本次改动相关的 warning 已清 |
| [x] | S4 core 单测 | Windows 本地 | `deno task test -c kabegame-core -- --lib package_file` | 9 passed / 0 failed | `driver.sh` 的 Git Bash 在本环境 `CreateFileMapping ... error 5`，改用其等价命令 |
| [x] | S4a CEF runtime 单测 | Windows 本地 | `driver.sh kabegame -p tauri-runtime-kbcef --lib -- file_access`（`CARGO_TARGET_DIR=target-check`） | 全部通过 | 2026-10-30 沙箱外：13 passed / 0 failed（含新增 `grant_app_fetch_file_dedups`） |
| [x] | S5 前端 Vitest | Windows 本地 | `cd apps/kabegame && npx vitest run src/utils/fileUrl.test.ts src/services/pluginFiles.test.ts` | 全部通过 | 2026-10-30：2 files / 7 passed。注意要在 `apps/kabegame` 下跑（它的 `vitest.config.ts` 提供 `@` 别名；在仓库根直接 `npx vitest` 会报 `Cannot find package '@/utils/fileUrl'`） |
| [x] | S6 本次前端格式 | Windows 本地 | Prettier `--check` 本次改动的 10 个前端文件 | 全部合规 | 通过；全仓 `deno task format:check` 另报 11 个本次未编辑文件 |
| [x] | 1 主窗口 `fetch(file:)` / XHR | Windows 重编 CEF 的 dev | 主窗口顶层读已知本地图片 | 200、`type=basic`、字节非空；XHR 同样；stderr 无 `deny file:` | 2026-10-30 CDP（主窗口 `http://localhost:1420/gallery`）：`fetch("file:///D:/Codes/kabegame/docs/images/icon.png")` 返回 `200`、`type "basic"`、`content-type image/png`、`blob().size 700205`；XHR（`arraybuffer`）返回 `200`、700205 字节、`image/png`；CDP 有 `response 200 file:///…/icon.png`。6b 复核：同一地址的顶层 `<img>` 加载为 824×824，画廊网格 29 张 `file:` 缩略图（`thumbnails/*.jpg` 与 WPE `preview.gif`）全部 `naturalWidth > 0`。stderr 有无 `deny file:` 需用户在 dev 终端确认（主 frame 免检，预期没有） |
| [x] | 2 复制兜底 | Windows 重编 CEF 的 dev | 对仅有缩略图的行复制图片 | `fetch(file:)` 读缩略图并成功写入剪贴板 | 2026-10-30：dev 库 9552 行里没有 `local_path` 为空的行，按「临时构造」复刻 `handleCopyImage` 的兜底分支：主窗口 `import("/src/utils/fileUrl.ts")`，用 app 自己的函数，`fileToUrl("")` 为空后回落 `thumbnailToUrl(...)`，得到 `file:///D:/Codes/kabegame/.kabegame/debug/data/thumbnails/aded0e02-….jpg`（库里的反斜杠路径也转成同一形态）；`fetch` 返回 `200`、`basic`、`image/jpeg`、56246 字节；`clipboard.write(image/jpeg)` 被 Chromium 拒（`Type image/jpeg not supported on write`），按 app 的逻辑转 PNG（236×512）后写入成功，PowerShell `Clipboard.GetImage()` 读回 236×512。常规行：`invoke("copy_image_to_clipboard", { imageId: "12824" })` 成功，读回 2480×3508，与库里的尺寸一致。未经右键菜单 UI 触发 |
| [x] | 3 WPE iframe 根目录 | Windows 重编 CEF 的 dev | iframe 读取同目录文件及 `C:/Windows/win.ini` | 同目录 200，越界被 `OutsideRoot` 拒绝 | 2026-10-30：`invoke("set_wpe_web_preview", { imageId: "12097" })` 返回入口 `file:///D:/Applications/Steam/steamapps/workshop/content/431960/3679122549/index.html`；在主窗口新建 `sandbox="allow-scripts allow-same-origin"` 的 iframe（先 append 再赋 src），iframe 内 `origin "file://"`：`fetch("./project.json")` 返回 `200`、`type "basic"`；入口页自己的 `style.css`、`script.js`、`data.json`、`background/bg001.png` 都是 200；`fetch("file:///C:/Windows/win.ini")` 和兄弟壁纸目录 `fetch("../796697921/project.json")` 都报 `TypeError: Failed to fetch`，CDP 为 `requestfailed … net::ERR_ABORTED`。`thumb/bg001.png` 在 iframe 里也是 ERR_ABORTED，但主 frame 顶层读它报 `ERR_FILE_NOT_FOUND`，说明壁纸本身缺这个文件，不是误拒。结束后 `set_wpe_web_preview(null)` 返回 `null`，iframe 已移除。`deny file: … OutsideRoot` 日志需用户在 dev 终端确认 |
| [x] | 4 插件文件 | Windows 重编 CEF 的 dev | 打开插件文档、banner、模板；试商店与预览来源、错误路径及版本切换 | blob 图片与文本正常；IPC raw 字节；失效时旧 blob URL revoke | 2026-10-30（bilibili 0.3.2，经 SPA 路由打开 `/plugins/bilibili`）：文档里 5 张插图和 banner 走马灯都是 `blob:http://localhost:1420/<uuid>`，`naturalWidth > 0`；文档首图与第一张 banner 共用同一个 blob URL（按坐标缓存命中）；「说明」「更新记录」文本正常；页面没有 `127.0.0.1` 或 `/plugin_file` 请求。IPC 为 `POST http://ipc.localhost/read_plugin_file`（Windows 下 `ipc://` 的 http 映射），响应 `200 application/octet-stream`，长度等于条目原始字节（README 9012、CHANGELOG 1929、`images.png` 1350823），不是 base64；`invoke` 返回 `ArrayBuffer`（JPEG 头 `ff d8 ff e0`，PNG 头 `89 50 4e 47`），模板 `templates/description.ejs` 20752 字节。商店来源 `/plugins/bilibili?mode=remote&source=official_github_release&version=0.3.2`：请求体带 `source: "official_github_release"`，插图和 banner 也是 blob 且显示正常。预览来源：对 dev 插件目录的 `bilibili.kgpg` 调 `preview_import_plugin` 得到 `fileOrigin.kind "preview"`，`pluginAssetUrl` 返回 blob（2404×1452），README 和模板文本可读。错误路径：白名单外的 `crawl.js`、`../../settings.json`、不存在的 `README.nope.md`、版本 `0.0.1`、错误的预览 token、预览版本不符，都返回 `Err: 插件文件不存在`（`package.json` 本来就在白名单内，可读）。失效：在详情页调用 store 在版本变化 / 删除时会调用的 `invalidatePluginFiles("bilibili")`，旧的 7 个 blob URL 再 `fetch` 都报 `Failed to fetch`（`ERR_FILE_NOT_FOUND`），banner 随即重新读取并得到新 blob；文档插图在 plugin 对象不变时保留旧地址（已解码，显示不受影响），重开详情页会重新读取。**未测**：真实的版本切换和插件删除（用 `invalidatePluginFiles` 模拟）；前端「加载失败」文案分支（没有带坏资源的插件可以触发） |
| [x] | 5 命令 ACL | Windows 重编 CEF 的 dev | 畅游窗口顶层调用 `read_plugin_file` | ACL 拒绝 | 2026-10-30：在主窗口用已有记录 `surf_start_session` 打开 `https://example.com/`（label `surf-example_com`），结束时 `surf_close_session`。该页经 `ipc://` 主通道（`http://ipc.localhost/<cmd>`）发出的所有 invoke 都返回 500 `Origin header is not a valid URL`，包括本应允许的 `get_webview_i18n` 和注入脚本自己的 `surf_collect_attach`、`surf_report_url`，在 ACL 之前就被 tauri 拒绝。这是上文「IPC 纵深防御」行已记录的既有问题，与 6c 无关（后由 tauri 补丁 12 修复）。因此改走 `cef-ipc` 回退通道（`window.ipc.postMessage`）观察：对照命令 `get_webview_i18n` 正常返回，`read_plugin_file` 和 `get_plugins` 报 `Command … not allowed by ACL`。壁纸窗口（label `wallpaper`，`file://` 来源）的结果一致：`read_plugin_file` 和 `get_plugins` 报 `not allowed by ACL`，`wpe_web_pull_state` 正常 |
| [x] | 6 插件 iframe 隔离 | Windows 重编 CEF 的 dev | 检查 opaque `srcdoc` 的 IPC 与 `fetch(ipc:)` | 无 `__TAURI_INTERNALS__`；内层 CSP 拒绝请求 | 2026-10-30（预览 bilibili 图 8970，`?pvwimgid=8970`；详情 iframe 是 `about:srcdoc` OOPIF，经 `/json/list` 直连）：`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`，内层 CSP 为 `connect-src 'none'`；`origin "null"`，`typeof __TAURI_INTERNALS__` 为 `"undefined"`（`__bridge` 存在）；`parent.document` 和 `parent.__TAURI_INTERNALS__` 都是 `SecurityError`；`fetch("http://ipc.localhost/read_plugin_file")` 和 `fetch("file:///…/icon.png")` 被 `connect-src 'none'` 拒绝（触发 `securitypolicyviolation`）；`ipc://localhost/…` 在 Windows 上是 `ERR_UNKNOWN_URL_SCHEME`；`cef-ipc://localhost/` 绕过 CSP 到达 handler，因来自子 frame 返回 400（Phase 3 的纵深防御，符合预期）。模板正文渲染正常 |
| [ ] | 7 Windows 拖出 | Windows 重编 CEF 的 dev | 网格图片、视频拖到资源管理器 | `DownloadURL` 为 `file:///…`，目标得到文件；stderr 无 `deny file:` | 由 Phase 6d 取代（`DownloadURL` 路线放弃）。需用户手动：CEF 窗口模式下，CDP 合成的鼠标事件起不了原生拖拽（`Input.setInterceptDrags` 没有收到 `dragIntercepted`），无法拖进资源管理器。已对网格元素派发带可写 `DataTransfer` 的合成 `dragstart`，读到处理器写入的数据：图片 `DownloadURL` 为 `image/jpg:73907cc9-….jpg:file:///D:/Codes/kabegame/.kabegame/debug/data/thumbnails/73907cc9-….jpg`，视频为 `video/webm:72a83e51-….mp4:file:///…/thumbnails/72a83e51-….mp4`（MIME 取原视频格式，文件是 mp4 缩略图），`text/uri-list` 和 `text/plain` 都是同一个 `file:///` 地址；网格里渲染的是缩略图槽，所以拖出的是缩略图文件。需用户真机拖图片和视频到资源管理器，并在 dev 终端看有无 `deny file:` |
| [ ] | 8 生产 CSP | Windows release 配置 | 以生产 CSP 读 `file:` 并显示 blob 插图 | `connect-src file:` 放行、图片正常 | 需用户手动：要用 release 配置启动应用，本轮约束不允许构建或重启。静态核对：`tauri.conf.json.handlebars` 的 `connect-src` 末尾有 `file:`，`img-src` 和 `media-src` 含 `blob: file:`，`connect-src` 不含 `127.0.0.1` |
| [x] | 9 应用 Web 服务器 / MCP | Windows 重编 CEF 的 dev | 开服务读 `/thumbnail`，再关服务查进程监听 | 开启时 200，关闭后无监听端口 | 2026-10-30：7491 是应用 Web 服务器（用户设置的端口；`/rpc` JSON-RPC 返回 200，`/mcp` 的 `initialize` 返回 200 SSE、`serverInfo rmcp`）。开启时 `curl --noproxy '*' http://127.0.0.1:7491/thumbnail/D%3A%5CCodes%5C…%5Caded0e02-….jpg` 返回 `200 image/jpeg`、56246 字节；越界的 `C:\Windows\win.ini` 返回 404，`/plugin_file/…` 返回 404（桌面 Web 服务器不含该路由）。在设置页「高级」点开关关闭后文案为「已停止」，`netstat -ano` 中 kabegame（pid 193920）只剩 `127.0.0.1:9606`（CDP）在监听，连 7491 被拒；再点开关恢复原来的开启状态，缩略图重新返回 200。注意本机 shell 设了 `HTTP_PROXY=127.0.0.1:7890`，curl 要加 `--noproxy '*'`，否则响应来自代理 |
| [x] | 10 稳定性 | Windows 重编 CEF 的 dev | 翻页、预览与插件详情持续 60 秒 | 无崩溃及整窗 reload | 2026-10-30：65 秒内循环执行 77 个动作（下一页两次，到第 2–3 页；经 `?pvwimgid=` 开关 4 张图的预览；进出 `/plugins/bilibili` 并等文档插图解码；翻回上一页），0 个失败。全程没有 `crash`，主窗口没有 `load`（主 frame 的 88 次导航都是 SPA 路由），没有 `pageerror` 和 `console.error`；`file:` 响应 532 次都是 200，另有 20 次 `ERR_ABORTED`，全部是第 1 页同一个视频缩略图 `0559ca75-….mp4`（离开页面时 `<video>` 中止请求）；`blob:` 请求无失败。壁纸窗口同期无 crash |
| [x] | 10b asset 协议 | Windows 重编 CEF 的 dev | 主窗口和畅游窗口请求 `http://asset.localhost/C:/Windows/win.ini` | 两处均网络失败 | 2026-10-30：主窗口、壁纸窗口（`file://`）和畅游窗口（`https://example.com/`）在顶层 `fetch("http://asset.localhost/C:/Windows/win.ini")`，加不加 `mode: "no-cors"` 都报 `TypeError: Failed to fetch`；主窗口和壁纸窗口的 CDP 为 `requestfailed … net::ERR_CONNECTION_REFUSED`（没有协议处理器拦截，请求直接落到本机 80 端口）。`asset://localhost/…` 报 `URL scheme "asset" is not supported` |
| [ ] | 11 Web 路由 | Web dev | 访问 `/plugin_file`、`/file`、`/compatible` | 路由与 Vite 代理正常 | 需用户手动：本机只有桌面版 `kabegame.exe` 在跑，没有 Web 版服务，本轮约束不允许启动。静态核对：`apps/kabegame/vite.config.ts` 的 `webDevApiProxyPaths` 已加 `/compatible`、去掉 `/proxy`，保留 `/file`、`/thumbnail`、`/plugin_file` |

## Phase 6d：Windows 拖出真实本地文件

2026-10-30：Windows 拖出不再写 `DownloadURL`（6c 的 `file://` 延迟渲染下载能跑完，但资源管理器松手后拿不到文件），改把 CEF 补丁 03 的真实文件链路扩到 Windows：Chromium 内层补丁把 aura 钩子门控放宽到 `IS_LINUX || IS_WIN`，delegate 背书文件时另清 `download_metadata`（两平台）与 `html`（Windows），Windows 不打 `chromium/x-renderer-taint`；运行时 `on_start_dragging` 去掉平台 cfg，应用在三个桌面平台的 standard 构建安装 resolver，`authorize_drag_image` 只放行普通文件（`x-wpe/*` 的目录行被拒）；前端桌面三平台只写 image id 并设 `effectAllowed = "copy"`，Web 版保留 `DownloadURL`。链路说明见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`。

**前置条件：必须先用带新 03 的源码重编 CEF（MSYS2 `CEFBUILD=D:/Codes/cefbuild deno task build:chromium`），再完全退出并重启 dev。** CEF 运行时随进程加载，Rust 热重编换不上新 libcef；仍用旧 CEF 时 Windows 没有 delegate 调用点，拖出退化成 Blink 为 `<img>` 自动填充的缩略图载荷，这表示前置条件未满足，不是本功能失效。CDP 无法模拟拖放到资源管理器等外部程序（系统拖放由 OLE 生成），下表真机项全部需人工。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 类型检查 | Windows 本地 | `deno task check -c kabegame`（`CARGO_TARGET_DIR=target-check`） | 0 error | 2026-10-30：vue-tsc 无输出，cargo check 0 error（47.75s）；本次改动的文件没有 warning |
| [x] | S2 授权单测 | Windows 本地 | `deno task test -c kabegame --skip vue -- --lib drag_export`（`CARGO_TARGET_DIR=target-check`） | 新增用例全部通过 | 2026-10-30：`directory_is_rejected` / `regular_file_is_allowed` / `missing_path_is_rejected` 3 passed / 0 failed。不带 `--skip vue` 时前端 Vitest 先跑，既有的 `KameToolboxBubble.test.ts`（`@kabegame/i18n` mock 缺 `i18n` 导出，与本次无关）失败会中止整条命令 |
| [x] | S3 静态 grep | Windows 本地 | `grep -rn 'any(target_os = "linux", target_os = "macos")'` 查 `kabegame/src/lib.rs` 与 `tauri-runtime-kbcef/src/webview.rs`；`grep -rn DownloadURL apps/kabegame/src` | 前者为空；后者只剩 `ImageContent.vue` 的 `IS_WEB` 分支与注释 | 通过 |
| [x] | S4 前端格式 | Windows 本地 | `prettier --check apps/kabegame/src/components/image/ImageContent.vue` | 合规 | 通过 |
| [x] | 1 资源管理器复制 | Windows 重编 CEF 的 dev | 从网格拖一张原图与缩略图肉眼可分的图到资源管理器目录 | 得到库内原文件（文件名 = `local_path` 的 basename），光标为「复制」；库内文件仍在原处 | 需人工 |
| [x] | 2 同卷不移动 | Windows 重编 CEF 的 dev | 拖到与图库同一盘符的目录；再按住 Shift 拖一次 | 仍是复制，不是移动；按住 Shift 也不能移动 | 验证前端 `effectAllowed = "copy"` |
| [x] | 3 同名冲突 | Windows 重编 CEF 的 dev | 再拖一次到同一目录 | 走资源管理器自己的「替换 / 跳过」对话框 | |
| [x] | 4 视频 | Windows 重编 CEF 的 dev | 拖一个视频行 | 得到原视频文件（不是 mp4 缩略图），扩展名与原片一致 | |
| [ ] | 5 sha256 | Windows 重编 CEF 的 dev | 对库内原图、落地文件、缩略图分别算 sha256（如 `certutil -hashfile <文件> SHA256`） | 落地 = 原图 ≠ 缩略图 | |
| [ ] | 6 Chromium 系接收方 | Windows 重编 CEF 的 dev | 拖到 Chrome / Edge 测试页的 `<input type="file">`，再拖到 VSCode 资源管理器面板 | 都收到本地文件，不是 URL 文本 | 证明没有 `chromium/x-renderer-taint`；新增风险点 |
| [x] | 7 富文本目标 | Windows 重编 CEF 的 dev | 拖到 Word 或 Outlook 新邮件 | 作为文件 / 附件插入，不是指向 `file:///…thumbnails` 的内嵌 HTML 图片 | 证明 `html`（`CF_HTML`）已清；新增风险点 |
| [x] | 8 拖回本应用 | Windows 重编 CEF 的 dev | 从网格拖到画廊 / 画册热区 | 全程静默（`beginInternalDrag` 认领），不触发导入浮层 | 摘掉污染标记后拖回会像系统文件拖入 |
| [ ] | 9 原图缺失回退 | Windows 重编 CEF 的 dev | 拖一张 `local_path` 已不存在、显示缩略图的行 | 不注入文件；资源管理器若接受 `CFSTR_FILECONTENTS` 则得到缩略图文件，否则无文件 | 记录实际结果 |
| [ ] | 10 WPE 行 | Windows 重编 CEF 的 dev | 网格 / 预览里的 `x-wpe/*` 行起拖；再在 `main` 调试会话里伪造该 id 的 `application/x-kabegame-image-id` 拖出 | `draggable=false`，不起拖；伪造拖出不注入文件（`is_file()` 拒目录） | 目录分支已由 `drag_export::tests::directory_is_rejected` 单测覆盖 |
| [ ] | 11 畅游伪造 id | Windows 重编 CEF 的 dev | 第三方内容页 `dragstart` 写 `application/x-kabegame-image-id` = 真实 id，拖到资源管理器 | 无文件（label 白名单） | |
| [ ] | 12 不存在的 id | Windows 重编 CEF 的 dev | `main` 调试会话把 mime 值换成不存在的 id 后拖到资源管理器 | 无文件、不崩溃、拖拽不卡 | |
| [ ] | 13 拖入回归 | Windows 重编 CEF 的 dev | 从资源管理器拖图进画廊 / 画册 / `KbPath` | Enter / Over / Drop / Leave 与导入照常，不导航到文件 | |
| [ ] | 14 IDataObject 格式 | Windows 重编 CEF 的 dev | 用最小 Win32 / .NET 接收器或 ClipSpy 类工具接收一次拖放，列出全部格式 | 有 `CF_HDROP`（路径为库内原文件）；无 `chromium/x-renderer-taint`、`CF_HTML`、`FileGroupDescriptorW`、`UniformResourceLocatorW` | 新增风险点 |
| [ ] | 15 Linux / macOS 文件管理器复制 | Linux（Wayland / X11）与 macOS 重编 CEF 的 dev | 复跑 v4.5.0「Linux / macOS 拖出真实本地文件」矩阵的「文件管理器复制」 | 得到库内原文件；同文件系统也是复制、不是移动 | 本次对 Linux / macOS 只多 `effectAllowed=copy`、`download_metadata.reset()`（Linux 无消费者）与 resolver `is_file()` |
| [ ] | 16 Linux / macOS 拖入回归 | Linux（Wayland / X11）与 macOS 重编 CEF 的 dev | 复跑 v4.5.0 同一矩阵的「拖入回归」 | Enter / Over / Drop / Leave 与导入照常 | |

## 场景壁纸光照（`#require LightingV1`）

`#require` 是预处理期现场生成源码：`LIGHTING=0` 时为空，开启时按 `LIGHTS_*` 生成库。灯数取 `general.lightconfig`。对比工程在 `ignore/lighting/`，调查见 `.claude/plans/wpe-import/3-scene/lighting-REPORT.md`。WPE 窗口 1920×1080，与离屏目标 1:1 比。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 翻译器单测 | Windows 本地 | `CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --lib` | 全部通过 | 33 通过 |
| [x] | 翻译器语料 | Windows 本地 | `KABEGAME_WPE_ROOT=<WPE 安装目录> cargo test -p wpesl2wgsl --test corpus -- --nocapture` | 158/167；不再有 `requires`；7 个着色器开 `LIGHTING` 带四种灯，翻译并回读通过 | `fur4` 基线只绑槽 0，缺 `TEX8FORMAT`；绑上后在门槛里通过 |
| [x] | 宿主单测 | Windows 本地 | 在 `apps/wpe-scene` 跑 vitest、tsc | 只有 `pipeline.test.ts` 的「意外解锁」失败 | 618 通过 1 失败；失败的 5 张不含 `#require`，HEAD 代码同样报 |
| [x] | 语料 `require:LightingV1` | Windows 本地 | 重扫全部场景 | 0 处（基线 78） | 新暴露 `combo:SPRITESHEET` 8 张 |
| [x] | 只有环境光 | 桌面 + WPE | `lt-amb`：有灯对象、没有 `lightconfig` | 灯对象不起作用，全图等于环境光 | 最大差 0 |
| [x] | 点光、隐藏灯、遗留灯 | 桌面 + WPE | `lt-point` | 只有两盏 `lpoint` 生效 | 最大差 1 |
| [x] | 聚光 | 桌面 + WPE | `lt-spot`：三个角非 0，配置 2 盏只有 1 盏 | 方向、锥角一致，空槽不发光 | 最大差 1 |
| [x] | 管光 | 桌面 + WPE | `lt-tube`：控制点走世界矩阵 | 一致 | 最大差 1 |
| [x] | 平行光 | 桌面 + WPE | `lt-dir`：三个角都非 0 | 一致 | 最大差 0 |
| [x] | 图层变换与材质 | 桌面 + WPE | `lt-mat`：旋转缩放、半透明、金属 / 粗糙 / 高光色 | 一致 | 最大差 1 |
| [x] | 灯数超配 | 桌面 + WPE | `lt-over`：2 盏配 1 盏 | 留文件靠前的那盏 | 最大差 1；WPE 实际按排序截断，只测了这一组 |
| [x] | 法线图 | 桌面 + WPE | `lt-nrm`（`solidlayer`） | 一致 | 最大差 1；普通图层另有 UV 内缩，最大差 10 |
| [x] | PBR 遮罩与自发光 | 桌面 + WPE | `lt-pbr`（`solidlayer`） | 一致 | 最大差 1 |
| [x] | HDR overbright | 桌面 + WPE | `lt-hdr`：灯强 9，`bloomhdrstrength=0`，`ultra` | 一致 | 最大差 1 |
| [x] | 旧着色器 | 桌面 + WPE | `lt-gi3`（`genericimage3`）、`lt-gi2`（`genericimage2`） | gi3 走 `>= 62` 的公式；gi2 报 `uniform:g_LightsPosition` | 最大差 1 / 0 |
| [x] | passthrough 走 `genericimage4` | 桌面 + WPE | `lt-cbm9`、`lt-cbm21`（`version 3`） | 一致 | 最大差 1 |
| [x] | 真实壁纸 | 桌面 + WPE | 3811798465 force 渲染（只差粒子） | 与 WPE 差异不超过 WPE 自身帧间差异 | 差大于 8 的像素 0.46%，自身 0.56%；只做数值比较 |
| [x] | 现有基线 | 桌面 | `ignore/p3c/step3` 的 `baseline.mjs`、`corpus.mjs`、`compare.mjs --base ../step4/base` | 帧哈希不变 | 18 项 sha256 相同；脚本诊断相同；语料差异只有阻塞项减少与 `combo:SPRITESHEET` |
| [ ] | 带 effect 的图层开光照 | 桌面 | 材质 `LIGHTING=1` 且图层有 effect | 报 `lighting:prelighting`，退回预览图 | 只有单测，没有和 WPE 比 |
| [ ] | 灯 `scale` 不为 1 | 桌面 + WPE | | 聚光方向按列 0 含缩放 | 没有实测 |
| [ ] | 属性绑灯字段 | 桌面 | 绑 `intensity` 后改属性 | 整场重编译，画面更新 | 只有单测 |

## 场景壁纸引擎宏

2026-11-07 Windows dev，宿主 `index-BGGGLREP.js`；WPE PID 36548，`ultra`。调查与改法见 `.claude/plans/wpe-import/3-scene/hdr-macro-REPORT.md`，脚本在 `ignore/hdr-macro/fix/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 翻译器单测与语料 | Windows 本地 | `KABEGAME_WPE_ROOT=<WPE 安装目录> cargo test -p wpesl2wgsl` | 全部通过，语料不下降 | 单测 35 通过，语料 158/167 |
| [x] | 宿主单测 | Windows 本地 | 在 `apps/wpe-scene` 跑 vitest、tsc、Prettier | 全部通过 | 668 通过 |
| [x] | 语料不支持项 | Windows 本地 | 重扫 `disabled`、`ultra` 两档 | 没有新的翻译失败 | 原有 117 张的键没有增减，`ultra` 没有多出失败 |
| [x] | 现有基线 | Windows dev，6 张 × 3 档 | 改前改后各录一次 | 只有 `eagleflag` 变 | 18 项里 15 项逐字节相同，12885 三档变 |
| [x] | `eagleflag` 法线 | 桌面 + WPE | 相位对齐后比画面 | 更接近 WPE | 均差 0.481、差 > 8 的像素 1.655%；改前 1.83、6.22%。最大差 88，来源没查 |
| [x] | HDR 过亮输入 | 桌面 + WPE | `hsl-hdr`：`brightness` 2，色相类混合模式 | 和 WPE 一致 | 最大差 1；改前 255 |
| [x] | LDR 不受 `HDR` 影响 | 桌面 + WPE | `hsl-ldr` | 和 WPE 一致 | 最大差 0 |
| [ ] | 未声明 `formatcombo` 的法线工程 | 桌面 + WPE | `nrm` | 和 WPE 一致 | 工程含 RG88 单元格，当时 `tex:format:8` 渲染不了；P4b 步骤 1 起 RG88 可渲染，待重测 |
| [ ] | 其它档位的 `HDR` | 桌面 + WPE | `disabled`、开启档、`displayhdr` | `HDR` 只在 `ultra` / `displayhdr` 且 JSON 都为 true 时定义 | 只有静态结论 |

## 壁纸属性面板控制区排版

2026-11-07 Windows dev，界面语言中文。`WpeWebPropertiesPanel.vue` 的控制卡片（暂停 / 设为封面 / 恢复默认封面 / 清空脚本存储 / dev 重载）从一排朴素的 `el-button` 改为统一的图标按钮：暂停行加状态图标徽标，各行之间用浅分隔线自动分组（`CONTROL_LIST` 的 `[&>:not(:first-child)]` 变体，隐藏行不留痕），操作按钮用粉紫 token 配色——设为封面为粉色主操作、恢复默认封面 / 清空脚本存储为紫色幽灵按钮、dev 为虚线弱化。只动排版与样式，`data-testid`、v-if 条件、点击行为与 `coverBusy` 守卫不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 组件单测 | 仓库 | `vitest run WpeWebPropertiesPanel.test.ts` | 全部通过 | 2026-11-07：23/23 通过，按钮改原生 `<button>` 后 `data-testid` / 点击 / 去重守卫不变 |
| [x] | 网页壁纸预览 | Windows dev，网页壁纸 12877 | 深链打开预览 | 暂停徽标行 + 粉色「设为封面」主按钮，分隔线分组 | 2026-11-07：符合，设为封面在无「恢复」时占满整行 |
| [x] | 场景壁纸预览 | Windows dev，场景 13662 | 打开预览（场景退回预览图） | 暂停徽标行 + 紫色幽灵「清空脚本存储」+ 虚线 dev 按钮，三段用分隔线分开 | 2026-11-07：符合；该场景在本机不实时渲染，封面按钮按 `coverReady` 未出现 |
| [ ] | 封面按钮并排 | 桌面 | 已设过自定义封面的网页 / 场景壁纸预览 | 设为封面（粉）与恢复默认封面（紫幽灵）等宽并排、窄栏时换行 | 未真机覆盖：手上没有带 `customCover` 的壁纸，避免改数据未触发 |
| [ ] | 设置页弹窗 | 桌面，窗口模式 | 壁纸设置「当前壁纸」打开属性弹窗 | 暂停行 + 清空脚本存储（场景），无封面按钮 | 未真机覆盖 |

## CLI 插件模板 Windows 输出路径

2026-11-08 Windows。`kabegame-cli plugin new` 内嵌模板的 `rspack.config.mjs` 输出路径从 `new URL("./dist", import.meta.url).pathname`（Windows 上为 `/D:/...`，rspack 编译"成功"但 `dist/` 不产出）改为 `fileURLToPath(...)`，与 `plugins/kabegame-plugin-wallspic` 等现有插件一致。模板经 `include_dir!` 编译期内嵌，重建 CLI 后生效。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 修正后的配置可产出 | Windows | theanimegallery 插件（同一配置写法）`deno task build` | `dist/main.js` 产出，打包成功 | 2026-11-08：打包 128.49 KB，CLI 真跑 80 张全部下载 |
| [ ] | plugin new 全链路 | Windows | 重建 CLI 后 `plugin new` 新插件并构建 | `dist/main.js` 直接产出 | 需重建 CLI 后验证 |

## 场景壁纸声音（P6a 步骤 1）

2026-11-11。声音对象按 Wallpaper Engine 的规则自动播放：编译期声音表（`compile/sounds.ts`）、排期器（`audio/scheduler.ts`，照读码与实测复刻状态机）、播放后端（`audio/player.ts`，媒体元素 + Web Audio，不整段解码）、宿主每帧在粒子之后推进。垫片把宿主音量放进只读的 `window.__kabegameHostVolume` 并派发 `kabegame-host-volume`（要重编 Rust 才生效）。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase6/p6-REPORT.md`，测试工程 `ignore/p6/proj/p6a-*`（`kbp gen p6a --data ignore/p6`），回环录音与分析脚本在 `ignore/p6/a0/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；应用的 `wpeWebVolume.test.ts` | 0 error；全过 | 2026-11-11：tsc 0 error，62 个文件 1652 个用例全过（新增排期器 32、宿主接线 8、播放器 8、声音表 12）；垫片 24 个用例全过（新增宿主音量只读属性与事件） |
| [x] | S1 语料 | Node，165 个工程 | 前后重扫 `unsupported` | 只在声音相关的键上变化；原来能渲染的不掉出 | 2026-11-11：能渲染 36 → 38（`1967162875`、`3827677885`）；变化的 77 张正好是带声音对象的；新增 `script:api:layer.play` 等（步骤 2 删）与 `sound:volume:script` 4 张 |
| [x] | S2 播放模式 · 对照 WPE | Windows dev（重编后），回环录音 | 导入 `p6a-loopmulti`、`p6a-random`、`p6a-single`、`p6a-silent`，图库预览里各放 30–40 s（测试工程的探针脚本调了声音层方法，要开 dev 强制渲染），用 `ignore/p6/a0/rec.py` 录、`ana_segs.py` 分析，和 p6-REPORT 的 WPE 结果比；测后删行 | `loop` 多文件段长是文件长、段间不留空；`random` 间隔 1.5–4 s、固定间隔 2.00 s；`single` 放一遍；音量属性从 0 调上去时从头放 | 2026-11-11 Claude：`loop` 多文件每段都是文件长或整数倍、段间 0–0.02 s（WPE 0–0.06 s）；`random` 固定 2.00 s，随机 13 个间隔 1.86–3.92 s、均值 2.70；`single` 只放一遍 2.00 s、之后 `isPlaying` 假；`zvol` 0 → 1 时 Z 从文件开头放、此前连 `AudioContext` 都没建；`startsilent` 的 T 不出声。脚本 `play` / `pause` / `stop` 是步骤 2。强制渲染开关已删，测试行已删 |
| [x] | S3 音量 · 对照 WPE | Windows dev，回环录音 | 导入 `p6a-vol2`，把「壁纸音量」依次设成 1、0.5、0.25，录音量各频率幅度 | A / B = 1（平方）；D / B = min(1, 9G) / G（钳制） | 2026-11-11 Claude：三档 A / B 都是 1.00，D / B 依次 1.00、2.00、4.00，C / B 2.0、E / B 9.0，改音量当场生效；单声道源输出 = 文件幅度 × G（WPE 另乘约 0.62，已知差异）。壁纸音量已改回 1 |
| [ ] | S4 应用背景、暂停与音量 0 | Windows dev | 带声音的场景设为应用背景；桌面上打开「暂停壁纸」再关；「壁纸音量」调到 0 再调回 | 应用背景不出声；暂停时停、恢复时接着放；音量 0 时不出声，dev 探针 `host.sounds()` 里没有 `AudioContext` | 2026-11-11 Claude：壁纸音量 0 → 元素暂停在 0.79 s、`isPlaying` 仍真（同 WPE），调回 1 从 0.79 s 续播；音量 0 时打开场景没有 `AudioContext`、没有元素，调回后从头放。应用背景与「暂停壁纸」没测（同一条路：宿主音量为 0 / `setPaused`），待用户确认 |
| [ ] | S5 释放 | Windows dev | 预览带声音的场景，关掉预览 | 声音立即停；场景宿主销毁后没有残留的元素与 Blob | 2026-11-11 Claude：预览之间切换时上一个场景的声音在切换那一刻断掉、新场景加载完才出声；测试工程都是散文件，没覆盖 pkg 的 Blob 撤销 |
| [ ] | S6 解锁场景 · 人耳 | Windows dev | `1967162875`、`3827677885` 的图库预览与桌面，和 Wallpaper Engine 对照听 | 开始时机、循环、音量和 WPE 相近；单声道文件可能比 WPE 响约 4 dB（已知差异） | 待用户确认 |
| [x] | S7 脚本控制声音（步骤 2） | Windows dev（宿主重建后），回环录音 | 导入 `p6a-single`、`p6a-play`（`supportsaudioprocessing` 要开 dev 强制渲染），图库预览里放，`[p6c]` 日志与录音段序列和 p6-REPORT 的 WPE 结果比；测后删行 | `play` 在放时从头、`pause` → `play` 续播、`stop` → `play` 从头、重复 `pause` 无害；`single` 放完后 `pause` 再 `play` 重放而 `isPlaying` 仍假 | 2026-11-11 Claude：日志逐条与 WPE 相同（`play 1 1`、`pause 1 0`、`play 0 1`、`stop 1 0`、`play 0 1`、`pause 0 0`；single 的 `pause 0 0`、`play 0 0`、`play 0 1`）；录音段序列成立。另见一次 40–60 ms 的整体输出中断（两个声音同时静音），像音频设备欠载，非排期问题。开关已删，测试行已删 |

## 场景壁纸视频纹理（P9a）

2026-11-13。头标志带 Video 的 `.tex`（mip 就是整段视频）编译期只给磁盘区间，主线程每段视频一个不挂 DOM 的静音 `<video>`，画到视频纹理时有新帧才 `copyExternalImageToTexture`；照 WPE 加载即播、缺省循环、30 个渲染帧没画到就暂停、宿主暂停时全部暂停、解码失败时图层透明。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase9/p9-REPORT.md`，测试工程 `ignore/p9/proj/p9a-*`（`ignore/p9/gen_v.py`），对照数据在 `ignore/p9/out/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；`scripts/kabegame-dev` 与 `apps/kabegame-dev-mcp` 的 `deno test` | 0 error；除已知失败外全过 | 2026-11-13：tsc 0 error；vitest 2371 个用例 2370 过，挂的是原有的语料请求次数上限（`3830255100`）；deno 测试 25 + 21 过，各挂 1 个假代理的网络测试，不含本次改动的 HEAD 上同样挂 |
| [x] | V1 语料 | Node，173 个工程 | 前后重扫 `unsupported` | 只去掉 `tex:video`，原来能渲染的不掉出 | 2026-11-13：能渲染 47 → 50（`3822149301`、`3824550659`、`3828359750`），41 张只去掉 `tex:video` |
| [x] | V2 播放与循环 | Windows dev | 导入 `p9a-plain`，在图库预览里打开，读 `host.videos()` | 视频在动、帧号随渲染帧走、2.517 s 处绕回 | 2026-11-13 Claude：帧号每秒 60、`currentTime` 按真实速度前进并在 2.517 s 绕回，画面里色块帧号与色卡都正常 |
| [x] | V3 隐藏的视频图层 | Windows dev | 导入 `p9a-vis`（10 s 显示、13 s 隐藏、15 s 再显示），预览里读 `host.videos()` | 不可见约 30 帧后暂停，再显示时从原处接着放、不追赶 | 2026-11-13 Claude：加载时不可见，播到 0.659 s 冻住；10 s 显示从 0.664 接着放；13 s 隐藏后空闲第 31 帧暂停（1.638）；15 s 从 1.641 接着放 |
| [x] | V4 暂停 | Windows dev | 预览工具条「暂停」再「继续播放」 | 暂停时帧号、视频时间、解码帧数都不动；继续后从原处放 | 2026-11-13 Claude：成立 |
| [x] | V5 解码失败 | Windows dev | 导入 `p9a-bad`（随机字节冒充 MP4） | 场景照常渲染、这个图层透明、日志一条 warn，不退回 | 2026-11-13 Claude：成立，只记一条「场景视频解码失败」 |
| [x] | V6 解锁场景 · 对照 WPE | Windows dev + WPE 抓帧 | 三张解锁场景各抓一帧 WPE，找出显示的视频帧，Kabegame 按同一帧回放（`renderFrame` 的 `videoTime`），比视频纹理与整帧 | 视频纹理只在颜色边缘有差、无整体偏色 | 2026-11-13 Claude：视频纹理平均差 `3822149301`（HEVC）0.19、最大 5；`3824550659` 1.15、99 分位 10；`3828359750` 1.66、99 分位 9（WPE 与 ffmpeg 之间也是这个量级，色度上采样不同）。整帧对照里的大差异来自粒子与随时间变化的水面效果 |
| [x] | V7 桌面、预览与应用背景同时播 | Windows dev | 把 `3822149301` 设为桌面壁纸，同时开它的预览，并设为应用背景；再打开「暂停壁纸」 | 三处都在动、不卡；暂停时停 | 2026-11-19 Claude（P9d 之后的 WebCodecs 播放器）：改用 13586（3429479356，4K60 H.264）测三处同开。预览和桌面都按真实速度播、每秒解 60 帧，6 分钟里 0 次卡住重置；应用背景本来就始终暂停，只解了 8 帧。RTX 4090 D 的解码器一路约 26%、两路约 47%。暂停按 100 ms 采样：设置「暂停壁纸」后，桌面约 75 ms 内停住，视频时间、解码帧、渲染帧都冻结，预览照常播；取消后桌面约 73 ms 内从原处接着放（不追赶），速率 1.000。预览设置面板的「暂停壁纸」只停预览，桌面不受影响。数据见 `phase-9c-multi.md` 步骤 2 的复测一节 |
| [ ] | V8 HEVC 不支持硬件解码的显卡 | 其它 Windows 机器 | 打开 `3822149301` | 视频图层透明、场景不退回、日志一条 warn | 本机（NVIDIA Ada）能解，待有条件时测 |

## 场景壁纸脚本控制视频（P9b）

2026-11-13。脚本 `thisLayer.getVideoTexture()` / `IVideoTexture` 照 WPE 实测实现：
- 时长取容器头（编译期读 MP4 `mvhd`）；
- 脚本暂停期间不换画面；
- `loop` 读出数字、float32；
- 结束回调在登记它的脚本里调。

另把视频元素挂进场景宿主页面最上层（2 px、1% 不透明）：看不见的视频暂停后恢复要等约 255 ms。WPE 真值见 `.claude/plans/wpe-import/3-scene/phase9/p9-REPORT.md`「P9b 步骤 0 的补测」，测试工程 `ignore/p9/p9b/proj/`（`gen_b.py`，Kabegame 版 `proj-kb/` 由 `kbvariant.py` 生成），对照记录在 `phase-9b-script.md`「步骤 3」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | W0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error；除已知失败外全过 | 2026-11-13：tsc 0 error；vitest 2769 个只挂原有的语料请求次数上限（`3830255100`） |
| [x] | W1 语料 | Node，173 个工程 | 步骤 2 前后各扫一次 | 只在 6 张里去掉 `script:api:layer.getVideoTexture`，没有新键 | 2026-11-13：同预期，干净的 57 张不变；编译请求数逐场景不变 |
| [x] | W2 接口类型与边界 | Windows dev | 导入 `p9b-api-kb`、`p9b-api2-kb`，预览里跑完读脚本日志 | 类型、成员顺序、暂停 / stop / 5 倍速 / 结束 / 结束后 `play()` 和 WPE 一致；暂停期间 seek 画面不变，`play()` 那一帧换 | 2026-11-13 Claude：逐项一致；已知差异：离当前位置不到一帧的 seek 我们照跳 |
| [x] | W3 时长 | Windows dev | `p9b-long-kb`（音轨长 33 ms）、`p9b-real-kb`（3361965869 的原片） | `duration` 2.55 / 10.005333，结束时读到的时间等于它 | 2026-11-13 Claude：成立；原片绕回比 WPE 早 22 ms（已知差异） |
| [x] | W4 多段切换不卡 | Windows dev | `p9b-switch-kb`，页面里量每次恢复播放到下一帧的时间 | 冻结时的画面接着放，恢复后几毫秒内出下一帧 | 2026-11-13 Claude：修前 9 次里 4 次约 270 ms；挂到最上层后 15 次都是 5–12 ms |
| [x] | W5 语料里的预设脚本 | Windows dev | `p9b-preset-kb`（3243449890 的「Video texture controls」原文） | 每帧 `play()`、到 `duration − frametime` 自己跳回 0、不报错 | 2026-11-13 Claude：和 WPE 同一条规则 |
| [x] | W6 语料 6 张 | Windows dev，强制渲染 | 3326873240、3470764447、3361965869、3276911872、3605722997（3243449890 建管线失败，与视频无关） | 时段切换选对段、改速度属性跟着变；没有和视频有关的报错 | 2026-11-13 Claude：成立；3276911872 的预设挂在非视频图层上，`null` 报错和 WPE 的 `log.txt` 相同 |
| [ ] | W7 桌面上的视频恢复 | Windows dev，窗口模式 | 把一张带视频、会隐藏视频图层的场景设为桌面壁纸，让图层隐藏 1 s 以上再显示 | 再显示时画面接着放，不停顿 | 只在预览里测过；用户当前的壁纸没有视频，没有替用户换 |
| [ ] | W8 清空脚本存储 | Windows dev | 预览一张用脚本改过视频 `loop` / `rate` 的场景，右键「清空脚本存储」 | 视频回到缺省循环、速率 1，脚本重新 `init` 后照常控制 | 只有单测 |

## 场景壁纸视频卡住的兜底（P9c）

2026-11-14。Chromium 的硬件解码（`D3D11VideoDecoder`）长时间放 4K60 视频后会静默停住：元素仍在放、无错误，`readyState` 停在 2，媒体日志的原因是 `DECODER_UNDERFLOW`。播放器在画到视频纹理时发现该在放的时间 2 s 没前进，就原地跳一下；仍卡就重新加载、回到原时间；三次重载后停手。每次记 warn，`host.videos()` 有 `stallSeeks` / `stallReloads`。复现与读码见 `.claude/plans/wpe-import/3-scene/phase9/phase-9c-multi.md`「步骤 0」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | X0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；变异检查 | 0 error；除已知失败外全过；7 个变异各有测试挂掉 | 2026-11-14：tsc 0 error；vitest 3593 个只挂别的会话改动中的语料读取上界（`3293687972`） |
| [x] | X1 卡住后自动恢复 | Windows dev | 预览 13586（3429479356，4K60 H.264）放到卡住，读应用日志与 `host.videos()` | 卡住约 2 s 后日志一条「场景视频卡住 2000 ms 没前进，原地跳一下」，`stallSeeks` 为 1，画面接着动、之后正常绕回 | 2026-11-14 Claude：放了约 7 分钟在 131.90 s 卡住，`DECODER_UNDERFLOW`；约 2 s 后原地跳，`readyState` 回到 4，按 60 fps 放到 141.4 s 并绕回 |
| [x] | X2 桌面上的长时间播放 | Windows dev，窗口模式 | 把 13586 设为桌面壁纸放 30 分钟以上，看应用日志 | 有「场景视频卡住」时画面随后恢复，没有「重新加载 3 次仍卡住」 | 2026-11-14 Claude：30 分钟里卡住 11 次（另有 76 次约 1 s 的短暂缺帧自己恢复），每次原地跳一下就恢复，没有用到重新加载；测试期间 WPE 占着同一块显卡 92% 的解码器，解码器整体多在 100%，卡得比单独预览时（7–14 分钟一次）勤得多 |

## 场景壁纸视频改用 WebCodecs（P9d）

2026-11-16。场景视频纹理、用户视频与 dev 探针都不再经过 `<video>`：宿主自己拆包（`video/demux/`：MP4 帧表、Matroska 顺扫 Cluster），交给 WebCodecs 的 `VideoDecoder` 硬解，按自己的媒体时钟挑帧拷进纹理（`video/codecPlayer.ts`）。旧播放器、挂进页面与 P9c 的卡住兜底随之删除（上一节 X1、X2 不再适用，换成解码器 2 s 没输出就重置、`stallResets`）。颜色照 WPE：场景视频矩阵恒为 BT.709，用户视频照标签、没标时高 > 576 用 709；色度纵向采样位置与 WPE 不同，记为已知差异。设计、实施与走查见 `.claude/plans/wpe-import/3-scene/phase9/phase-9d-webcodecs.md`，测试片与复制工程在 `ignore/p9/p9d/walk/`，WPE 抓帧在 `A:\p9d\walk\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Y0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`，只跑引用视频模块的文件与 `src/dev`）、Prettier；变异检查 | 0 error；全过；变异各有测试挂掉 | 2026-11-16：tsc 0 error；引用视频模块的 48 个文件 905 个用例、`src/dev` 194 个全过；步骤 1（13）、2a（14）、3（14）、2b（8）与颜色规则（5）共 54 个变异全部挂掉 |
| [x] | Y1 语料拆包 | Node | 60 段视频逐段 `indexVideo`，和 ffprobe 比帧数、关键帧、时长、首帧 | 全部拆得了、逐段一致 | 2026-11-15 Claude：59 段 MP4 与 1 段 Matroska（3816870245，7049 帧）全部一致，Matroska 逐包 pts / 大小 / 关键帧与 ffprobe 无差异 |
| [x] | Y2 桌面上的 4K60 实时播放 | Windows dev，窗口模式 | 桌面壁纸设 14295（3585875739，4K H.264），读 `host.videos()` 30 s | `decoder` 是 WebCodecs，每秒解 60 帧，循环处无缝，不丢帧 | 2026-11-14 Claude：媒体时间每秒走 1.000 s，在 12.758 s（`mvhd`）绕回，丢 0 帧，`stallResets` 0 |
| [x] | Y3 Matroska 实时播放 | Windows dev | 主窗口页面里直接驱动播放器放 3816870245 的视频 20 s | 每秒解 120 帧，时钟每秒 1 s，没有告警 | 2026-11-15 Claude：建索引 809 ms，每秒解 120 帧，20 s 丢 19 帧（多在开头），`stallResets` 0 |
| [x] | Y4 颜色对照 WPE | Windows dev + WPE 抓帧 | 复制工程只留视频图层，WPE 抓一帧，按同一帧回放，比视频纹理与整帧 | 只剩色度纵向位置的差；标 bt470bg 的场景视频不再整体偏色 | 2026-11-16 Claude：3823859141（1:1）整帧最大 45、平均 1.22，按两边各自的色度位置重建都只差 1–2；3400241651（标 bt470bg）改为 709 后合成 RT 最大 22；3816870245 缩到一半最大 17；3822149301（HEVC）、3812007032（4K 标 bt470bg）的 WPE 纹理按「709、2k − 0.5」重建最大差 1 |
| [x] | Y5 时间轴 | Windows dev | 播放器放 P9 的 60 fps 测试片 12 s，和 P9 实测的 WPE 时钟比 | 编辑列表、时长两边相同；时钟按墙钟、循环无缝 | 2026-11-16 Claude：时钟每秒 1.000 s，循环间隔即时长 2.517 s；显示落后 0.07–0.81 帧（WPE 0.09–1.39）；开场比 WPE 早约 2 帧、WPE 循环点停约 2.6 ms，都是 WPE 媒体引擎的延迟（已知差异） |
| [x] | Y6 确定性回放 | Windows dev | `render_scene` 14295 `videoTime` 1 与 13，各两次；再在主窗口最小化时跑一次 | 取到 ≤ 目标的最新一帧，两次逐字节相同；最小化时照常 | 2026-11-16 Claude：1 → `frameTime` 1.0，13 → 按时长取模 0.242、`frameTime` 0.2333；同一请求像素摘要相同；最小化时与可见时逐字节相同 |
| [x] | Y7 用户视频 | Windows dev | 导入 `ignore/p11/proj/p11-ut`，属性 `ut` 设 P11b 的彩条片（320×240、未标），`render_scene` 取 0.5 s | 用户视频 ready，颜色与按 BT.601 解出的源只差 1 | 2026-11-16 Claude：ready、矩阵按分辨率取 smpte170m，(254, 0, 0) 对 ffmpeg 的 (253, 0, 0)；以前屏外拿不到用户视频帧的问题也没了 |
| [ ] | Y8 预览里的用户视频实时播放 | Windows dev | 给一张有 `scenetexture` 属性的场景在属性面板选一段 MP4，看预览 | 视频在槽里循环播放，裁切与颜色正常 | 待用户 |
| [ ] | Y9 长时间播放 | Windows dev，窗口模式 | 把 13586（3429479356，4K60）设为桌面壁纸放 30 分钟以上，看应用日志 | 画面一直在动；即使有「场景视频解码器 2000 ms 没有输出」也随即恢复 | 用户要求先不长测 |
| [ ] | Y10 拆不了包的视频 | Windows dev | 场景或用户视频用一段分片 MP4 / WebM | 场景视频图层透明、用户视频用缺省纹理，日志一条「场景视频不能拆包」，场景不退回 | 只有单测 |
| [x] | Y11 高 level 视频的确定性回放 | Windows dev | 屏外宿主按画面哈希的参数（`time` 1.5、`disabled`、不给 `videoTime`）渲染 13566、13581、13603、13605、13606、13615、13624、14296、14297、14693、15010、15017 | 都出图、视频取到 0 s 那一帧，不再报 `ProbeVideoTimeout` | 2026-11-19 Claude：12 张都出图，单张 1.6–6.2 s，复跑摘要相同；原因是 level 6.0 等高 level 视频的解码器要攒满 16 帧重排缓冲才出帧、探针不跑帧循环时没人补喂，改为由 `VideoDecoder` 的 `dequeue` 事件补喂 |

## 按颜色排序与代表色

2026-11-11。每张图入库时算一份色盘（最多 5 个代表色 + 占比，`images.palette`），详情「基本信息」里画成色带；排序新增「颜色」维度。迁移 v052 加色盘列、色桶表 `color_buckets`（12 个基本色桶，黄 / 绿 / 青为 `e6c200` / `2e9e3f` / `1fb5b5`，不是纯色）与关系表 `image_color_distances`，给存量图 × 每个色桶铺一行 65536；回填作业 `image_palette` 在后台给 `palette IS NULL` 的图补算。排序有两个段：`sort/by-color_0x<rrggbb>`（色桶，预计算、沿索引读）与 `sort/by-any-color_0x<rrggbb>`（任意颜色，现算），前端按色桶列表（`color_buckets://`）选段并在列表变化时校正；用户可把颜色保存成色桶（`add_color_bucket`，最多 24 个）或删除（`delete_color_bucket`），提交后发 `color-buckets-change`。机制见 `cocs/gallery/COLOR_PALETTE.md`。

已有的数字（都不是正式构建）：dev 库 5475 张、未优化构建下，色桶排序一页 1–2 毫秒，现算排序 11–12 毫秒，随机排序 1–2 毫秒。真实大库 + 正式构建待测。Android 分支未经交叉编译验证。2026-11-12 在 macOS 桌面 dev（5475 张）上做了第一轮真机验证，先用 `reset-dev-palette` 脚本把跑过旧版 v052 的 dev 库重置、回填重算；已勾的行见备注，没勾的行未验或只验了一部分。

升级路径（用现有 dev 数据目录，升级前备份）：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | v052 与回填启动 | 桌面 dev，v051 的库 | 启动 | 启动页不报错；进入界面后忙碌卡片「更新数据库」出现「计算壁纸的代表色」并走完 | |
| [ ] | 回填期间可排序 | 桌面 dev | 回填进行中按「红」排序；回填完成后刷新 | 排序可用，没算到的图排在最后、总数不变；完成后顺序稳定 | 2026-11-12 Claude 经 CDP：只验了「最远的在前」：总数不变，没算到的约 1000 张排在**最前**（`_kb_desc` 把哨兵值 65536 一起翻转了），「最接近的在前」未验 |
| [ ] | 回填只刷新颜色排序的视图 | 桌面 dev，debug ingest | 回填期间分别停在按时间排序与按颜色排序的画廊，数 `pathql_fetch` 次数 | 按时间排序的不随每批刷新；按颜色排序的按 500ms 窗口刷新 | |
| [ ] | 回填补丁补色带 | 桌面 dev | 回填期间开着一张还没算到的图的预览 | 算到后基本信息里自己出现色带，不用重开 | |
| [ ] | 回填可续跑 | 桌面 dev | 回填中途退出再启动 | 从上次的位置继续，只处理还没有色盘的图 | |
| [ ] | 算不出的行不重试 | 桌面 dev | 库里有源文件与缩略图都已不在的行；回填跑完后重启 | 这些行没有色带、按颜色排序排在最后；重启后不再出现回填卡片 | |

代表色：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 色带显示 | 桌面 dev | 预览侧栏与详情弹窗的「基本信息」 | 类型 / 大小 / 尺寸那一行下方有色带，段数与占比和画面相符；悬停显示 `#rrggbb · 百分比` | 2026-11-12 Claude 经 CDP：预览侧栏 4551：5 段（51 / 24 / 11 / 5 / 4%），悬停文字带「按这个颜色排序」与色值、占比；详情弹窗未看 |
| [ ] | 点色段按该颜色排序 | 桌面 dev | 带着过滤（如某个插件 + 图片类型）打开一张图的预览，点色带的一段；再在画册页、任务详情、畅游图片页各试一次 | 预览关闭，当前页面换成按这个颜色排序：路径是 `…/sort/by-any-color_0x<hex>/…`、最接近的在前、在第 1 页，过滤条件都还在，总数不变；非画廊页留在本页、不跳画廊；后退回到点之前的排序 | 2026-11-12 Claude 经 CDP：画廊（仅图片 + 时间倒序）点第 2 段 → `hide/media-type/image/_kb_fc/sort/by-any-color_0xca8e5f`，预览关闭，总数 4038 不变，chip「颜色 · #ca8e5f」，后退回到时间倒序；画册 / 任务 / 畅游未验 |
| [ ] | 纯色与黑白 | 桌面 dev，浅色与深色主题各一次 | 看一张纯色图、一张白色为主、一张黑色为主的图 | 纯色图只有一段；白 / 黑段边界清楚，不融进面板背景 | |
| [ ] | 淡色插画分出色调 | 桌面 dev | 看一张淡粉 + 淡蓝为主的粉彩插画 | 色带不止一段：主色之外能看到淡粉、淡蓝或肤色的段（整张图很淡时合并半径变小）；彩色插画的色带与之前一样 | 白底线稿、暗色图会拆出几档相近的白 / 灰 / 暗色，属预期 |
| [ ] | 小块鲜艳色 | 桌面 dev | 看一张白底、角色身上有一小块鲜艳颜色（红蝴蝶结、青色发饰）的图 | 色带最后一段是那块鲜艳颜色，占比是它的真实面积（可以只有 1%） | 只补一个；与已选颜色太近的同色系不补 |
| [ ] | 没有色盘 | 桌面 dev | 看一张没有 `schemecolor` 也没有预览图的 WPE 壁纸 | 不显示色带、不留空位 | |
| [ ] | 新下载的图 | 桌面 dev | 下载一张图后立即打开预览 | 直接有色带（`images-added` 带着色盘） | |
| [ ] | 深链接 | 桌面 dev | 用带 `pvwimgid` 的链接直接打开预览 | 有色带 | |

排序（色桶）：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 色桶面板 | 桌面 dev | 画廊排序下拉点「颜色」 | 这一行不直接选中，在面板里展开 12 个基本色块与末尾的「＋」；选「红」后路径是 `…/sort/by-color_0xff0000/…`，第一页明显偏红，chip 提示为「颜色 · 红」 | 2026-11-12 Claude 经 CDP：展开不导航；12 个色块为新色值；选红后下拉关闭、总数不变、chip「颜色 · 红」。「第一页偏红」因下一行的方向问题当时没看成，修复后未再截图 |
| [x] | 从别的排序切到颜色 | 桌面 dev | 在「时间倒序」下从面板选「红」；再在「最远的在前」的颜色排序下换一个颜色 | 前者是「最接近的在前」（路径不带 `_kb_desc`）；后者保留「最远的在前」 | 2026-11-12 Claude 经 CDP：发现选色沿用了时间倒序、变成「离红色最远的在前」，已修（`onSortColorSelect`），修复后路径为 `hide/sort/by-color_0xff0000`；后者由单测覆盖 |
| [ ] | 黄 / 绿 / 青 | 桌面 dev | 依次选黄、绿、青 | 路径分别是 `by-color_0xe6c200`、`by-color_0x2e9e3f`、`by-color_0x1fb5b5`；前几十张是金黄、草木绿、蓝绿，纯白图不在前列 | |
| [ ] | 纯数字色值的色桶 | 桌面 dev | 依次选黑、棕、灰（`000000`、`804000`、`808080`） | 结果不为空、总数与其它排序一致，前列是对应颜色 | 属性带 `0x` 前缀防数字化，见 RULES §6.5 |
| [ ] | 方向、翻页与每页条数 | 桌面 dev | 切到「最远的在前」、翻页、改每页条数 | 总数与按时间排序时一致；没有色盘的图在「最接近的在前」时排最后 | 已知：「最远的在前」时没有色盘的图排在最前（见「回填期间可排序」备注） |
| [ ] | 叠加过滤 | 桌面 dev | 叠媒体类型、插件、搜索后按颜色排序 | 可用；总数等于同过滤下其它排序的总数 | |
| [ ] | 其它三个网格 | 桌面 dev | 画册页、任务详情、畅游图片页 | 排序下拉都有「颜色」，行为同画廊 | |
| [ ] | 预览定位 | 桌面 dev | 按颜色排序时打开预览、左右切图；用带 `pvwimgid` 的深链接 | 切图顺序与网格一致；深链接跳到正确的页 | |
| [ ] | 轮播 | 桌面 dev | 在按颜色排序的视图上「用当前视图轮播」 | 可设置；切换壁纸按距离顺序前进 | |
| [ ] | 耗时 | 桌面，正式构建，真实大库 | 记录色桶排序第 1 页与深页的耗时 | 与按时间排序同量级 | dev 5475 张未优化构建：一页 1–2 毫秒 |

排序（任意颜色，现算）：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 按这个颜色排序 | 桌面 dev | 点「＋」取一个不在色桶里的颜色，选「按这个颜色排序」 | 路径是 `…/sort/by-any-color_0x<hex>/…`；`color_buckets://` 行数不变；末尾色块显示成这个颜色并带选中描边，chip 提示为「颜色 · #<hex>」 | 2026-11-12 Claude 经 CDP：#3a7bd5：输入后提示换成现算说明、两个按钮可用，在输入框按回车不关下拉；排序后总数不变，末尾色块背景为该色、title「其它颜色 · #3a7bd5」，chip「颜色 · #3a7bd5」；选中描边未细看 |
| [ ] | 结果与组合 | 桌面 dev | 同上视图里切方向、翻页、开预览、叠过滤 | 结果合理、总数不变，各项可用 | |
| [ ] | 取到色桶的颜色 | 桌面 dev | 在取色面板里输入一个基本色桶的色值（如 `#ff0000`）并排序 | 路径是 `by-color_0x…`（前端选段，不走现算）；「保存为色桶」置灰并提示已是色桶 | 2026-11-12 Claude 经 CDP：取色面板初值为当前的 #ff0000 时「保存为色桶」置灰、提示「这个颜色已经是色桶了」；用它排序的路径未验 |
| [ ] | 收藏视图不建色桶 | 桌面 dev | 把现算排序的视图存成收藏视图；重启后应用它 | `color_buckets://` 行数仍不变；路径仍是 `by-any-color_0x…` | |
| [ ] | 耗时 | 桌面，正式构建，真实大库 | 记录现算排序第 1 页与深页的耗时，与随机排序、色桶排序对比 | 与随机排序同一类；明显更慢时先查参考色缓存是否生效 | dev 5475 张未优化构建：现算 11–12 毫秒，随机 1–2 毫秒 |

入库：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 下载时出现在应在的位置 | 桌面 dev | 开着按颜色排序的视图下载一张图 | 新图出现在按距离应在的位置，而不是缺席或排最后 | |
| [ ] | 本地导入各类型 | 桌面 dev | 本地导入一张图、一个 GIF、一个视频 | 各自有色带，按颜色能排到合理位置；GIF 与视频的色盘反映整段而不只是第一帧 | 视频抽帧只落在关键帧上，部分视频取不满 8 帧 |
| [ ] | WPE 壁纸 | 桌面 dev | 导入视频、带 `schemecolor` 的网页 / 场景、不带 `schemecolor` 的、连预览图都没有的各一张 | 视频类按画面颜色；带 `schemecolor` 的是该颜色一段 100%；不带的按预览图；都没有的无色带、排最后 | 取作者值，改属性面板里的颜色后色带不变 |
| [ ] | 文件夹同步 | 桌面 dev | 往同步目录放一张图 | 同步进来的图有色带 | |
| [ ] | 删图不留关系行 | 桌面 dev，直接查库 | 删除几张图后 `SELECT COUNT(*) FROM image_color_distances` | 等于 图片数 × 色桶数 | |
| [ ] | 整理：重新计算代表色 | 桌面 dev | 整理里只勾「重新计算代表色」（图库超过 4000 张时再选一段范围）跑一次；之后不改任何文件再跑一次；再删掉某张图的源文件与缩略图后跑一次 | 第一次忙碌卡片显示「已更新代表色 N」，开着的详情色带随补丁更新，按颜色排序的视图刷新、其它排序只打补丁；第二次计数为 0、`pathql_fetch` 不因它刷新；文件不在的那张色带保持原样（不被清空）；范围外的图不动；同时勾「清除失效图片」时被清掉的那张不计入 | 小批（10 张一批），比只补缩略图慢。2026-11-12 Claude 经 CDP：对话框有这个开关；经命令只开它、范围前 50 张，先把其中 3 张色盘改成纯黑：两次都改回原值，进度与完成提示均为「已更新 3 张图片的代表色」（没变的 47 张不计入）。文件缺失、与清除失效同开未验 |

保存与删除色桶：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 保存 | 桌面 dev | 取一个颜色点「保存为色桶」 | 按钮转圈、两个按钮禁用；完成后色块出现在基本色块之后，当前排序变成 `by-color_0x<hex>`；另一个页面的排序面板里也出现（事件刷新） | 日志有一条「保存色桶 #… 行距离，… ms」。2026-11-12 Claude 经 CDP：#3a7bd5 保存后色桶 13 个、关系表该色 5475 行（= 图片数），路径换成 `by-color_0x3a7bd5`；转圈与另一页面未验 |
| [x] | 现算 → 色桶不跳 | 桌面 dev | 先按某个颜色现算排序，再把它保存成色桶 | 路径从 `by-any-color` 换成 `by-color`，画面顺序不变、不跳页 | 2026-11-12 Claude 经 CDP：保存前后网格前 6 张 id 相同（2885、6498、8655、6391、4518、3042） |
| [ ] | 重复与上限 | 桌面 dev | 再取同一个颜色；存满 24 个后再取一个 | 「保存为色桶」置灰，提示分别为已是色桶、最多保存 24 个 | |
| [x] | 删除 | 桌面 dev | 鼠标移到用户色块上点角标并确认 | 确认框不会把排序下拉关掉；正按它排序的页面换成 `by-any-color_0x<hex>`，顺序不变；基本色块没有删除角标 | 2026-11-12 Claude 经 CDP：删除角标只有 1 个（用户色块）；确认后下拉仍开着、色块消失、色桶回到 12 个、关系表该色 0 行，路径换成 `by-any-color_0x3a7bd5`、前 6 张不变 |
| [ ] | 删除后应用旧收藏视图 | 桌面 dev | 色桶删除后应用一个存着 `by-color_0x<该色>` 的收藏视图 | 自动换成现算段，不是空结果 | 色桶列表读到之前可能短暂为空 |
| [ ] | 保存期间有下载 | 桌面 dev | 保存色桶的同时跑下载任务 | 任务不报错；保存完后新下载的图对新色桶有距离（按它排序能看到新图） | |
| [ ] | 轮播指着被删的色桶 | 桌面 dev | 轮播正按某个用户色桶排序时删掉它 | 下一次切换跳过、不报错、轮播不关；设置页能看出来源为空 | |

其它端：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 安卓排序对话框 | Android dev（`--mode android`） | 排序对话框里展开色块、选择、打开取色面板、删除确认 | 都在对话框主体里可用；删除角标常显；返回键按「确认框 → 对话框」顺序关闭 | Android 分支未经交叉编译验证 |
| [ ] | 安卓入库 | Android dev | 下载一张图片与一个视频（`content://` 路径） | 都有色盘 | 同上 |
| [ ] | Web 版 | Web dev | 按基本色桶与任意颜色排序；普通模式与 super 模式下分别保存 / 删除色桶 | 两种排序都可用；`add_color_bucket` / `delete_color_bucket` 只在 super 模式放行 | |
| [ ] | MCP | 桌面 dev，MCP 客户端 | 读 `color_buckets://`；按返回的 `hex` 读 `images://gallery/sort/by-color_0x<hex>/_kb_x100x/1`；关掉「色桶列表」能力后再读 | 每行有 `rgb` / `hex` / `key` / `position`；排序结果行里带 `palette`；能力关闭后 `color_buckets://` 被拒 | |

## 矩阵按 WPE 的 float32 顺序、图层四边形对角线

2026-11-14。`2903412088` 走查里 `e3clock-nofx2130` 只剩两处和 WPE 不同：MVP 平移差 1–3 个 ulp，图层四边形的对角线不同。这一步把矩阵运算换成 WPE 的写法：`multiply` 逐步 f32 舍入（glm 乘法）、MVP / VP 用仿射乘法 `mulAffine`、对齐偏移与字形平移只改平移列、本地矩阵按元素填、zoom 与视差按 WPE 的三步 f32；场景相机分开存投影与视图，每次 draw 在视图上做视差平移再相乘；图层四边形顶点顺序改成「左上、左下、右上、右下」，泛光链改画一个全屏大三角形。读码见 `.claude/plans/wpe-import/3-scene/rea-matrix-order.md`，计划与实施记录见 `phase-f32-matrix.md`。所有以前存下来的「我们自己的」画面哈希与粒子回放逐字节基线都会在末位变化，验收以 WPE 为准。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 走查工程 MVP | Windows dev，屏外宿主（`render_scene`） | `e3clock-nofx2130` 渲染，对 WPE 抓帧比 6 个 draw 的 MVP | 逐位相同 | 2026-11-14 Claude：逐 draw 轨迹读出两层 compose / passthrough 与画字形的 MVP 平移，全部逐位等于 WPE（179 (0.8629395961761475, 0.8874444961547852)、67 (0.8645793199539185, 0.8890844583511353)、字形 ty 0.2091503143310547） |
| [x] | 走查工程整帧 | 同上 | 同上渲染后 `kbp cmp frame` 对 WPE 上屏整帧，两层合成 RT 也比 | 整帧 0 差异；两层合成 RT 0 差异 | 2026-11-14 Claude：对 WPE 第 240、241 帧整帧 RGBA 0 差异（改前 29 个像素、最大差 3）；黑字层合成 RT 对 WPE 事件 59、青字层对事件 117 都是 0 差异（改前青字层 196 个像素） |
| [x] | 文本与对齐工程 | Windows dev，屏外宿主 | `p6b-geom` / `-align` / `-wrap` / `-fx` / `-fallback` / `-extra`、`p6b-tiny` / `-tiny2` / `-tiny3` 对 WPE 整帧 | 不比本文档里原来记的差（原来是 0 的仍为 0） | 2026-11-14 子代理重跑、Claude 复核（`ignore/f32-regress/RESULTS.md`）：9 个全部 0 差异；`p6b-fx` 原来 1 个像素差 1，现在 0 |
| [x] | 图像层模型标志工程 | 同上 | `p5b-autosize`、`p5b-nopad-v2`、`p5b-cl`、`p5b-proj`、`p5b-fs` / `-fsnofx` / `-fsmvp`、`p5b-inst` / `-inst2` 对 WPE 整帧 | 不比原来记的差（最大差 2 以内） | 2026-11-14 同上：`p5b-nopad-v2` 1845 → 0、`p5b-cl` 32 → 0；`p5b-fs` 最大差仍是 1；其余 0 差异 |
| [x] | 静态网格 | 同上 | `p5c-*` 10 个对 WPE 整帧 | 不比原来记的差（原来 0 差异的仍为 0） | 2026-11-14 同上：10 个全部 0 差异 |
| [x] | 视差、抖动、缩放 | 同上 | P5a 视差、抖动、缩放各挑两个工程对 WPE | 不比原来记的差；缩放档的线性项仍是 `f32(z)·f32(2/W)` | 2026-11-14 同上：`p5a-static`、`ptr1`、`shake1`、`shaker2`、`zoom15`、`zoompar` 按时间线回放整帧 0 差异。另从 `A:\p5a\zoom15` 事件 18 核对缩放后投影的平移项逐位等于三步 f32（`zoom.test.ts`） |
| [ ] | 相机对象与透视 | 同上 | P5d 的相机对象、透视各挑两个工程对 WPE | 不比原来记的差；末位可能仍和 WPE 有出入（透视覆盖与透视粒子的前面几步没改） | 已知差异，见计划风险 2 |
| [x] | 泛光 | 同上 | `ctl-ldr`、`ctl-hdr`、`q4-n8` 对 WPE | 不比原来记的差；泛光链每个 pass 画 3 个顶点，没有缝线或半像素偏移 | 2026-11-14 Claude：WPE `ultra`、1920×1080 窗口重抓（`A:\p3c\f32-bloom\`），抓帧里 WPE 的泛光 pass 也是 3 个顶点。我们 `render_scene` 按 `ultra` 渲染：`ctl-ldr` 对上屏帧 0 差异；HDR 三个（交换链是 FP16，改用 PrintWindow 截窗口，排除左上 600×128 的 RenderDoc 叠加层）最大差都是 1，平均差 `ctl-hdr` 0.0056、`q4-n8` 0.0023（D28 记的是 0.025、0.028），`q4-n3` 只有 60 个像素差 1 |
| [x] | 对齐与形状 | 同上 | P8 的对齐（`p8-align` / `p8-align2`）与形状工程对 WPE | 不比原来记的差 | 2026-11-14 同上：`p8-align` 最大差 1 → 0；`p8-align2` 仍只差 F1 一行（已知）；`p8-shape` 最大差 6、`p8-shape2` 最大差 2，同以前；`p8-clamp` / `-clamp2` / `-misc` / `-a2c` 0；`p8-alpha` 仍只差 X 组（已知）。`p8-dep2` 子代理用外推时刻比出 B10、B11 两块差 3，Claude 按抓帧的 `g_Time` 7.935568809509277 重渲后 0 差异 |
| [ ] | 粒子与编译期 | 同上 | 带粒子的确定性工程整帧对 WPE；`kbp regress --corpus` | 粒子位置、MVP 不比原来记的差；语料编译期结果没有变化 | 只改渲染，编译期不动 |
| [ ] | 真实场景观感 | Windows dev，图库预览与桌面 | 开几张带旋转、视差、文字的场景壁纸 | 画面无缝线、无半像素偏移、不闪烁 | |
| [ ] | macOS / Linux 三角形带 | macOS / Linux dev | 开一张图层边缘有双线性采样的场景壁纸，与 Windows 同帧对比 | 边缘像素一致；若有末位差别，确认是奇数三角形顶点轮换所致 | 代码里 `layerQuad` 带 `TODO:[WPE_SCENE]` |

## 场景壁纸脚本的相机基准（P5e）

2026-11-15。脚本 `thisScene.getCameraTransforms` / `setCameraTransforms` 读写相机基准（`SceneState.cameraBase`），正交场景没有相机对象时基准改过就进视图。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5e-camera-transforms.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 正交场景每帧 set | Windows dev，屏外宿主（`render_scene`，跑脚本） | `p5e-a` 按 WPE 日志回放第 163 帧 | 整帧与 WPE 逐像素相同 | 2026-11-15 Claude：0 差；`get` / `set` 的日志与 WPE 逐行相同 |
| [x] | 有相机对象 | 同上 | `p5e-cam` 第 163 帧 | 基准不影响画面，逐像素相同 | 2026-11-15 Claude：0 差 |
| [x] | 透视场景每帧 set | 同上 | `p5e-persp` 第 165 帧（屏蔽 FR / CLK） | 逐像素相同 | 2026-11-15 Claude：0 差 |
| [x] | 视差与抖动叠加 | 同上 | `p5e-par` 第 160 帧，逐 draw 对 WPE 常量 | `g_EyePosition`、缩放逐位相同 | 2026-11-15 Claude：逐位相同；视差点差 7e-5、120 个像素是方块边缘，来自日志缺第 151–159 帧（dt 平分） |
| [x] | 2887099508 开场镜头 | 同上，解包副本按日志与逐帧光标回放 | 第 263、319、419 帧对 WPE | 镜头位置一致，脚本不报错 | 2026-11-15 Claude：整体位移 0（相位相关），81 段脚本无错；余差来自樱花粒子与视频时刻 |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 2887099508，看开场 15 秒 | 镜头从书与人物附近边滑边拉远，回到全景；下方没有多出的半透明黑框 | |

## 场景壁纸组里读快照（P5f）

2026-11-17。组（带子层的组合层）里的子孙读 `_rt_FullFrameBuffer` 时，快照拷组的合成 RT 左上角，层首拷贝在直接父是组时跳过，不再报 `model:passthrough:children:framebuffer`。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5f-group-framebuffer.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 组比屏幕小 | Windows dev，屏外宿主（`render_scene`，1920×1080） | `p5f-a`：组里读快照的图层、effect、`REFRACT` 粒子、cbm 混合，对 WPE 上屏帧 | 逐像素相同（屏蔽 FR / CLK） | 2026-11-17 Claude：0 差 |
| [x] | `copybackground: false` | 同上 | `p5f-b` | 逐像素相同 | 2026-11-17 Claude：0 差 |
| [x] | 组与屏幕同尺寸 | 同上 | `p5f-c` | 逐像素相同 | 2026-11-17 Claude：0 差 |
| [x] | 组带旋转 | 同上 | `p5f-d` | 逐像素相同或只差边缘舍入 | 2026-11-17 Claude：1 个像素差 1 级 |
| [x] | 组比屏幕宽、分组节点下的孙子、嵌套组 | 同上 | `p5f-e` | 逐像素相同 | 2026-11-17 Claude：0 差 |
| [x] | 3465215190 不再退回 | 同上 | 渲染图片 14292 | `unsupported` 为空，路面雨滴的溅射粒子画出来 | 2026-11-17 Claude：`unsupported` []；3 秒回放后两个溅射系统各有 206 / 176 个父粒子 |
| [x] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3465215190（雨天站台）看半分钟 | 不退回预览图；台阶和路面上有雨滴溅起的折射水花，没有大块错位的色块 | 2026-11-17 用户：观感和 WPE 差不多 |

## 场景壁纸文本层的 perspective（P5g）

2026-11-18。文本对象的 JSON `perspective: true` 同图像层：画到场景目标的绘制换透视那一份视图投影，不再报 `object:perspective`。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5g-text-perspective.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 四种文本透视 | Windows dev，屏外宿主（`render_scene`，1920×1080） | `p5g-a`：直接上屏、带背景、带 effect、colorBlendMode 2 的透视文本，加正交文本与透视图像层对照，对 WPE 上屏帧 | 逐像素相同（屏蔽 FR / CLK） | 2026-11-18 Claude：0 差 |
| [x] | 加相机视差 | 同上 | `p5g-par` | 逐像素相同 | 2026-11-18 Claude：0 差 |
| [x] | 语料 | Node（`kbp corpus scan`） | 扫 `3841256486`、`3348595482` | 前者干净，后者只剩翻译器的 `float2` | 2026-11-18 Claude：符合；重叠的场景只有这 2 张去掉 `object:perspective`，没有新增的键 |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3841256486（myprojects） | 不退回预览图；透视文字的位置、形状和 Wallpaper Engine 里一样 | |

## 场景壁纸脚本 `layer.perspective` 与组合层的 perspective（P5h）

2026-11-19。脚本读写图像层（含组合层、组）与文本层的 `perspective`（只收布尔、当帧生效）；组合层 / 组带 `perspective: true` 不再报 `object:perspective`。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5h-perspective-runtime.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 脚本切换透视、组合层与组的透视 | Windows dev，屏外宿主（`render_scene`，1920×1080，跑脚本） | `p5h-a` 回放到第 199 帧（脚本按帧号奇偶写 SP 的 `perspective`），对 WPE 上屏帧 | 逐像素相同（屏蔽 FR / CLK） | 2026-11-19 Claude：0 差；197 / 201 帧（同为奇数）像素摘要相同 |
| [x] | 读写规则与键 | 同上 | 看 `p5h-a` 脚本日志：13 种值逐项写入后读回、各对象的键 | 和 WPE 一致：只收布尔；SP / CL / TX 有 `perspective`，PT / GN 没有 | 2026-11-19 Claude：一致 |
| [x] | 语料 | Node（`kbp corpus scan`，233 张） | 全库扫描，对 P5f 时的扫描 diff | `3808922316` 干净；没有场景新增不支持项 | 2026-11-19 Claude：符合；去掉 `script:api:layer.perspective` 1 张，新增的键 0 |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3808922316 | 不退回预览图；画面和 Wallpaper Engine 里一样（脚本建的影子层在写死不可见的分组下，看不见） | |

## 场景壁纸相机对象上的关键帧（P5i）

2026-11-19。相机对象的 `origin` 等变换与 `fov` / `zoom` 挂关键帧时按字段写进状态，不再报 `value:animation:camera`；关键帧的值晚一帧进视图（同 WPE）。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5i-camera-keyframes.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 相机平移 + 缩放关键帧 | Windows dev，屏外宿主（`render_scene`，1920×1080） | `p5i-cam` 按 WPE 日志与轨迹回放到第 206、207、208 帧，对 WPE 上屏帧 | 逐像素相同（屏蔽 FR / CLK） | 2026-11-19 Claude：三帧 0 差；我们 206 对 WPE 207 交叉比 95% 像素不同（比较灵敏） |
| [x] | 语料 | Node（`kbp corpus scan`） | 全库扫描；`3841310696`（myprojects）单独按目录扫 | `3554161528` 干净；`3841310696` 只剩 `puppet:draw-order` | 2026-11-19 Claude：符合 |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3554161528 | 不退回预览图；开场推镜的节奏和 Wallpaper Engine 里一样 | |

## 场景壁纸 mdl 段表结尾缺空标签不再报截断（P5c 补修）

2026-11-19。mdl 段表的结尾照 WPE（`FUN_14009c500` 越界返回空串、`FUN_140261770` 只定下一个标签的位置）：标签在文件末尾之前找不到 `\0` 当空标签结束段表，段末超出文件夹到文件末尾；别的读越界照旧报 `mdl:truncated`。读码更正见 `.claude/plans/wpe-import/3-scene/phase5/rea-p5-mesh.md` 1.1、1.7。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 3840815204 | Node（`kbp corpus scan --project`，myprojects） | 扫原工程 | 不再报 `mdl:truncated`，没有不支持项 | 2026-11-19 Claude：`[]`；它的 `layer_5_puppet.mdl` 最后一段 `MDLA0006` 顶到文件末尾（4800852 字节），没有结尾的空标签 |
| [x] | 语料不受影响 | Node（`kbp corpus scan`，233 张；mdl 单测带 `KABEGAME_WPE_ROOT`） | 全库扫描对 P5h 时的结果 diff；语料 mdl 逐个解析 | 没有新增的键；语料 mdl 都不截断 | 2026-11-19 Claude：新增 0，去掉的键都来自别的步骤；mdl 相关 188 个用例全过 |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3840815204 | 不退回预览图；人偶的动画和 Wallpaper Engine 里一样 | |

## 场景壁纸全屏组与组内组合层 compose 的视差（P5j）

2026-11-20。fullscreenlayer 带子层（全屏组）不再报 `model:fullscreen:children`：开头拷屏幕（不看 `copybackground`）、子孙用和顶层相同的场景相机、没有 effect 时上屏画基础材质；顺带更正组里的组合层的 compose 不带视差。计划、WPE 实测与实施记录见 `.claude/plans/wpe-import/3-scene/phase5/phase-5j-fullscreen-children.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 全屏组的拷贝与上屏 | Windows dev，屏外宿主（`render_scene`，1920×1080） | `p5j-b`（两个全屏组之间插顶层方块，第二个 `copybackground: false`）回放到第 164 帧，对 WPE 上屏帧 | 逐像素相同（屏蔽 FR / CLK） | 2026-11-20 Claude：0 差 |
| [x] | 相机效果（缩放、抖动、视差） | 同上 | `p5j-cam`：全屏组、嵌套组、顶层组合层、普通组里的嵌套组，回放到第 204、205 帧 | 逐像素相同 | 2026-11-20 Claude：两帧 0 差；交叉比 30% 像素不同 |
| [x] | 带变换的全屏组、嵌套组、带 effect 的全屏组 | 同上 | `p5j-a` 回放到第 209、210 帧 | 和 WPE 最大差 1（effect pass 的 `g_Color4` 残留值，P5b 起的已知差异） | 2026-11-20 Claude：2.6% 像素差 1，逐 draw 轨迹与 WPE 取像素核对来源 |
| [x] | 语料 | Node（`kbp corpus scan`） | 扫 myprojects/3814353826；全库扫描对上次结果 diff | 3814353826 干净；没有新增的键 | 2026-11-20 Claude：符合，全库 233 张全部干净；语料里没有「组里套组合层又开视差」的场景（嵌套 compose 的更正不改画面） |
| [ ] | 真实观感 | Windows dev，图库预览与桌面 | 打开 3814353826 | 不退回预览图；时钟的位置、文字和 Wallpaper Engine 里一样 | |

## 场景壁纸透视相机矩阵逐步 float32（P5d 补修）

2026-11-15。透视场景的相机路径插值、lookAt、透视投影（含 DirectXMath `XMScalarSinCos` 多项式）照汇编逐步 float32。计划与实施记录见 `phase-5d-camera-depth.md`「补修：透视相机矩阵逐步 float32」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | ricepod 逐 draw | Windows dev，屏外宿主（`renderFrames.ts`） | P13c 的复制工程 `ricepod-iso-sun` 按日志回放第 2223 帧，逐 draw 对 WPE 常量 | `g_ViewProjectionMatrix` / MVP / `g_EyePosition` 0 ULP | 2026-11-15 Claude：全部 0 ULP（改前最多 131 ULP）；sprite 遮挡方块的 `g_ViewUp` 剩 1 ULP，归 P13c |
| [x] | ricepod 整帧 | 同上 | 第 2221–2225 帧对 WPE 整帧 | 没有差 > 1 的像素 | 2026-11-15 Claude：2221 相同，其余 1–132 个像素差 1（改前每帧 529–6288 个、最大 48） |
| [x] | P5d 透视工程 | 同上 | `p5d-path` w1 / w6、`p5d-persp`、`p5d-persp-b`、`p5d-tilt` 对 WPE 整帧（屏蔽 FR / CLK） | 逐像素相同（同改前） | 2026-11-15 Claude：全部 0 差 |
| [ ] | 真实透视场景观感 | Windows dev，图库预览与桌面 | 开 ricepod、techno 等透视场景 | 画面与以前一致、相机运动平滑 | |

## 场景壁纸视差点 float32 与布尔字段绑非布尔属性（P5a 补修）

2026-11-14。视差点的平滑推进改成逐步 float32（汇编 `0x140189b67`–`0x140189cea` 的结合顺序）；`cameraparallax` 等布尔 general 字段（以及 `bloom` / `hdr`）写成 `{user, value}` 而属性值不是布尔时，取 JSON 的 `value`（WPE 实测：属性值只有布尔才改位）。计划与实施记录见 `phase-5a-parallax.md`「补修：视差点 float32 与布尔字段绑属性」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 视差平滑途中的帧 | Windows dev，屏外宿主（`renderFrames.ts`） | P10b `clk61-w0`（3840×2160，日志逐帧光标）第 76–78 帧对 WPE | 逐像素相同；逐 draw MVP 0 ulp | 2026-11-14 Claude：3 帧 0 差（改前第 76 帧 181 个像素 ±1）；`clk61-w2` 第 64–66 帧也 0 差 |
| [x] | 布尔字段绑滑块 / 复选框 / 下拉 | Windows dev，屏外宿主 | `p5a-pb-e1`…`e5`（`ignore/p5/pb/gen_pb.py`）渲染，看方块 B 的位置 | 与 WPE 相同：E1、E2 视差开（B 在 1710），E3、E4、E5 关（1460） | 2026-11-14 Claude：5 个全部与 WPE 抓帧 `A:\p5a\pb\` 一致 |
| [x] | 真实壁纸 3253330537 | Windows dev，屏外宿主 | 复制工程 `cameraparallax` 绑 `newproperty16`（滑块 −0.22），对 WPE 抓帧（ultra、日志逐帧光标） | 逐像素相同 | 2026-11-14 Claude：第 220、221 帧 0 差 |
| [ ] | 真实场景观感 | Windows dev，图库预览与桌面 | 开 3253330537 等开着视差的场景，来回移动鼠标 | 视差跟随平滑、和以前观感相同；3253330537 现在跟随鼠标 | |

## 场景壁纸音频频谱 uniform（P11a）

2026-11-14。六个 `g_AudioSpectrum*` 读场景频谱（P4e 的 `SceneSpectrum`），读它们的程序也让宿主订阅音频。WPE 的语义见
`.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md`「音频 uniform」，走查记录见同目录 `phase-11a-audio.md`「实施记录」，测试工程
`ignore/p11/proj/p11-bars`（`ignore/p11/defs/p11a.py`），复制工程与实验在 `ignore/p11/a/walk/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | A0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error、全过 | 2026-11-13：步骤 1 的快照上 tsc 0 error，vitest 2739 个用例全过 |
| [x] | A1 语料 | Node，183 个工程 | 前后重扫 `unsupported` | 只去掉六个音频键，原来能渲染的不掉出 | 2026-11-13：能渲染 66 → 69，去掉的只有 `uniform:g_AudioSpectrum*`（32 段 40 张、64 段 34 张、16 段 21 张）；Miku `3585875739` 还要 P7e 的变量打包才建得出管线 |
| [x] | A2 生成工程对照 WPE | Windows dev + WPE 抓帧 | `p11-bars` 自带连续测试音，WPE 20 fps、1920×1080 抓 4 帧，`render_scene` 按日志、轨迹与录制的频谱回放 | 整帧逐像素相同 | 2026-11-14 Claude：4 帧都 0 差异，每帧 128 个频谱值都非 0 |
| [x] | A3 真实壁纸走查 | Windows dev + WPE 抓帧 | Liberty、少女、Miku 的复制工程各抓 4 帧，按录制的频谱逐帧回放、逐 draw 对照 | 读音频的 pass 一致，差异逐处有解释 | 2026-11-14：音频条 pass 0 到个位数的 1 级差（舍入中点）；少女的 waterripple 差异定位到 fxc 重新结合 `g_Time * a * a`（源码改成 fxc 的结合后这些帧整帧 0 差）；Liberty 整帧的大差是 4K 场景缩到窗口的上屏；Miku 第 192 帧缺视频时刻没走完 |
| [x] | A4 真机冒烟 | Windows dev，放着音乐 | 预览 Liberty | 频谱条随音乐动 | 2026-11-14：订阅成功、频谱非 0、三张截图里条的高度不同 |
| [ ] | A5 没声明音频处理的场景 | Windows dev | 打开一张读音频 uniform 但 `project.json` 没有 `supportsaudioprocessing` 的场景 | 不订阅音频、频谱条为 0、场景照常渲染 | 本机语料没有这样的场景（68 张都声明了），待用户确认 |
| [ ] | A6 非 Windows | macOS / Linux | 预览 Liberty | 场景照常渲染、频谱条为 0、日志一条 debug（订阅被拒） | 本机不能测（`TODO:[WPE_SCENE]`） |

## 场景壁纸关键帧动画（P10a）

2026-11-14。`scene.json` 里的关键帧值（`{animation, value}`）每帧在粒子与相机之后、脚本之前按 float32 时钟求值、写进字段，照 WPE 的插值、`loop` / `mirror` / `single` / `wraploop`、联动与 `startpaused`。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase10/rea-p10-keyframes.md` 与 `p10-REPORT.md`，计划、实施记录与按 FINAL_CHECK 的走查见同目录 `phase-10a-curves.md`，测试工程 `ignore/p10/proj/p10-*`（`ignore/p10/defs/p10.py`），复制工程 `ignore/p10/walk/proj/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | K0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；`apps/kabegame-dev-mcp` 的 `deno test` | 0 error、全过 | 2026-11-14：提交后的树 tsc 0 error，vitest 3093 个全过；dev MCP 27 组全过 |
| [x] | K1 语料 | Node，183 个工程 | 前后重扫 `unsupported` | `scene.json` 的关键帧键从 40 张去掉，别的键不变 | 2026-11-14：40 张去掉过渡键、别的键逐张不变；`2251857160` 能整张渲染（干净 78 → 79） |
| [x] | K2 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080 | `p10-curves`、`p10-zoom` 各录 3 段、每段 3 帧，`renderFrames.ts` 按日志逐帧回放、`kbp cmp frames` 比 | 整帧逐像素相同；缩放和 WPE 一样晚一帧 | 2026-11-14：18 帧都 0 差异（含 FR、CLK） |
| [x] | K3 脚本相关工程 | 同上 | `p10-script`、`p10-edge` 各录 4 段 | 不受脚本控制的对象逐像素相同 | 2026-11-14：只有 P10b 对象（`getAnimation` / `animationEvent`）与挂字段脚本的 `ovr` / `hid`（探针不跑脚本）不同，其余对象 0 差异 |
| [x] | K4 真实壁纸复制工程 | Windows dev + WPE 抓帧，3840×2130 | 7 张复制工程（`kbp content isolate`）逐帧比、逐 draw 对常量 | 动画写进的值和 WPE 逐位相同，像素差逐处有解释 | 2026-11-14：`3577990983` 15 帧逐像素相同；其余动画值逐位相同，像素差都是「窗口与场景不同高」（WPE 按窗口分辨率画），另有组节点子层平移 1 ulp 的残留记给 f32 矩阵 |
| [ ] | K5 实时预览 | Windows dev，图库预览与桌面 | 打开 `2251857160`（冬季，等 10 s 看霜冻漫上来）与 `3818053626`（片头文字淡入） | 动画流畅、改属性时不从头开始；暂停时停 | 只在探针回放里比过，实时播放待用户看 |
| [ ] | K6 非 Windows | macOS / Linux | 预览 `2251857160` | 同 Windows | 本机不能测 |

## 场景壁纸关键帧动画的脚本控制与事件（P10b）

2026-11-14。脚本的 `getAnimation()` / `thisScene.getAnimation()` 拿到动画、经 `IAnimation` 控制播放；时钟越过的事件派发给脚本的 `animationEvent`；脚本与动画的登记顺序照 WPE。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase10/p10-REPORT.md`「P10b 补测」，计划、实施记录与走查见同目录 `phase-10b-script.md`，测试工程 `ignore/p10/proj/p10b-api`、`p10b-order`，复制工程 `ignore/p10/b4b/proj/`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | K7 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error、全过 | 2026-11-14：tsc 0 error；vitest 3591 个通过，另 1 个失败是工作区别的会话未提交的改动（`pipeline.test.ts` 的 `3293687972` 读取字节数），撤回本步改动照样失败 |
| [x] | K8 语料 | Node，183 个工程 | 前后重扫 `unsupported` | 只去掉 `script:api:object.getAnimation` / `thisScene.getAnimation`、`script:callback:animationEvent` | 2026-11-14：27 / 1 / 1 张，没有新增键，能渲染 92 → 92（这 27 张都还差光标、媒体回调或人偶） |
| [x] | K9 生成工程带脚本回放 | Windows dev + WPE 抓帧，1920×1080 | `p10-script`、`p10-edge`、`p10b-api` 共 23 段，`renderFrames.ts --scripts` 逐帧回放、`kbp cmp frames` 比，`[kf]` 日志对照 | 整帧逐像素相同，脚本日志相同 | 2026-11-14：69 帧全部相同（修了 `NaN` 写回与探针事件时刻两处之后）；不排除任何对象 |
| [x] | K10 真实壁纸复制工程 | Windows dev + WPE 抓帧，1920×1080 | `3336377291`、`3427691867` 的时钟（`init` 里 `play()`）各 4 段，逐帧比、逐 draw 对常量 | 动画值与开播时刻和 WPE 逐位相同，像素差逐处有解释 | 2026-11-14：MVP 与 alpha 8 段 0 ulp（动画中途那帧 alpha 都是 0.7435418367385864）；像素差只在文字上，顶点与图集相同，归「按窗口分辨率画」 |
| [x] | K11 用 `getAnimation` 的场景跑脚本 | Windows dev 屏外宿主，强制渲染 | 27 张场景用探针 `renderFrame`（`force`、`scripts`）各跑 260 帧，期间按 5×4 网格移动光标并逐点点击（`ignore/p10/b6/k11.py`），收脚本诊断后归类（`k11_classify.py`） | 脚本诊断里没有 `getAnimation` / `IAnimation` 相关的错误 | 2026-11-14（P6c 在工作区，未提交）：24 张跑完，光标回调都调到了，没有一条出在 `getAnimation` / `IAnimation` 本身。和动画沾边的几条：按名字找的图层场景里没有（WPE 同样是 null）；`animationlayers` 上的脚本对象缺 puppet 动画层的成员（P12）；`getTextureAnimation`（P6e）。其余是能力表登记过的缺口及其连锁报错。3 张（`3000562427`、`3486806915`、`3830665420`）建 GPU 资源时就失败，脚本没跑到。媒体回调没调到（P11） |
| [ ] | K12 清空脚本存储 | Windows dev，图库预览 | 在 `init` 里播放动画的场景上「清空脚本存储」 | 动画从头播一遍 | 只有单测；要动图库界面，待用户看 |
| [ ] | K13 非 Windows | macOS / Linux | 同 K12 | 同 Windows | 本机不能测 |
| [x] | K14 点击触发的事件链 | Windows dev 屏外宿主 + WPE 测试窗口（`input_play` / `input_start`，1920×1080，fps 20） | `2887099508` 的复制工程（`ignore/p10/b6/proj/2887099508-iso-p10b6-page`，翻页两层 + 逐帧日志对象）：点 `page首` → `900` 播完发 `houye` → `111` 播完发 `yeshu`；两边按同一串帧时间与光标回放，比 `[kbp10]` 日志（`cmp10.py`）与抓帧（`A:\p10b\s6\`） | 动画帧号、是否在播、两层可见逐帧相同；整帧像素差逐处有解释 | 2026-11-14（P6c 在工作区，未提交）：单击 600 帧、每 3 s 点一次 1220 帧，日志逐项相同（播完的 `single` 再 `play()` 从头播，事件每轮都发）。抓帧 40 帧：没画书页的 11 帧逐像素相同；画了书页的帧逐 draw `g_Point0–3` 与 MVP 0 ulp，像素差在书页边缘与泛光，归「按窗口分辨率画」。唯一的脚本诊断是 puppet 的 `playSingleAnimation` 没实现（P12） |

## 场景壁纸 P6b 步骤 2：`ITextLayer` 脚本 API

2026-11-14。文本层的脚本对象装上 WPE 文本描述符的 17 个字段（`script/api.ts` 的 `installText`），读写规则照 WPE 实测（`ignore/p6/b2/make_api.mjs` 的 `p6b-api`、`p6b-api-enum`）。
- 12 个运行中字段当帧重排；
- `backgroundcolor` 用属性绑定的同一目标（LDR 下就地）；
- `font`、`opaquebackground`、`backgroundbrightness`、`anchor` 整场重编译；
- `thisScene.getLayer` 认本场景的图层对象。

计划与实施记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6b-text.md`「步骤 2」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Y1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；变异检查 | 0 error，全过 | 2026-11-14 Claude：tsc 0 error，vitest 134 个文件、3203 个用例全过；6 个变异全被抓到（文本层不装访问器、`getLayer` 不认对象、`maxrows` 类型、读回不按 f32、`anchor` 查不到不取 none、字符串不交给重编译目标） |
| [x] | Y2 语料 | Node，183 个工程 | 同一份工作区快照、只换这一步的 3 个文件，各扫一次 `unsupported` 再比（`kbp corpus diff`） | 只去掉 `script:api:layer.<文本字段>`，没有新增的键 | 2026-11-14 Claude：干净 88 → 90，解锁 `2861028294`、`3429479356`，没有掉出；去掉 `text` 10 张、`horizontalalign` 6 张、`verticalalign` 4 张、`maxwidth` 1 张 |
| [x] | Y3 运行中字段与就地背景色 · 确定性工程 | Windows dev 屏外宿主 + WPE 抓帧（1920×1080） | `p6b-api-rt`（多行文字、字号、间距、`maxrows`、`padding`、两个对齐，其中一项经 `getLayer(图层对象)` 写，背景色 0.5）用探针 `scripts: true` 渲染，和 WPE 上屏整帧比 | 除每帧变的帧号文字 s1 与 FR / CLK 外 0 差异 | 2026-11-14 Claude：0 差异（`A:\p6b\p6b-api-rt2\`） |
| [x] | Y4 整场重编译的字段 | Windows dev，图库预览 | `p6b-api` 在预览里实时跑（脚本写 `font`、`opaquebackground`、`backgroundbrightness` 等） | 重编译之后 s3 的字体、背景、文字框和 WPE 一致；脚本没有报错 | 2026-11-14 Claude：重编译 3 次，s3 是「Api ok」、Cambria、灰底，文字框 310×168 和 WPE 抓帧的灰底框同尺寸；脚本 611 帧没有错误。预览画布缩放过，没有逐像素比 |
| [x] | Y5 日历（`getLayer(图层对象)`） | Windows dev 屏外宿主 + WPE 抓帧 | `3824424509` 用探针 `scripts: { clock }` 渲染，和 WPE 同一天的抓帧比日历区域 | 日历格子相同；脚本不再报 `objects/8/visible` 的错误 | 2026-11-14 Claude：日历格子区域 0 差异（2026 年 11 月、14 号标红）；差异只在时钟秒数（两边时刻不同） |
| [x] | Y6 解锁场景 | 同上 | `2861028294`、`3429479356` 各抓 WPE 一帧，探针按同一时刻渲染并排看 | 文字内容与位置一致 | 2026-11-14 Claude：`2861028294` 的日期、星期、时间与位置一致（差异是随机粒子）。`3429479356` 带 4K 视频纹理（约 700 MB），探针等第一帧超过 10 s 上限（三次都超时）。改做复制工程 `ignore/p6/b2/real/3429-text`（`kbp content isolate` 去掉视频层，留文字、logo、音频控制器）：时钟文字「12:01 PM」与位置和 WPE 一致，脚本没有报错；1920×1080 窗口下剩的差异在两个挂 `blurprecise` 的图层（时钟发光层 1493 个像素、logo 阴影 9059 个像素，最大差 58 / 50）。逐 draw 查下去，阴影层的合成 RT 与横向模糊和 WPE 都是 0 差异，WPE 最后一步按 1920×1080 的视口直接画、我们按场景 3840×2160 画再缩。改用 3840×2130 窗口（`A:\p6b\p6b2-3429-text-4k\`）比，整帧 0 差异，所以这些是 FINAL_CHECK 已登记的「先按场景分辨率画再缩」，不是模糊 effect 的问题 |
| [ ] | Y7 解锁场景实时运行 | Windows dev，预览与桌面 | `3429479356`、`2861028294`、`3824424509` 在图库预览里打开、设为桌面壁纸 | 时钟走、日历是当天、提示文字轮换，没有脚本错误 | 待测 |

## 场景壁纸 P6c 交互

2026-11-14。场景壁纸的光标交互：命中测试、六个光标回调、全局 `input`、图层 `solid`，宿主接左键，放开能力表（`render/cursor.ts`、`script/api.ts`、`script/runtime.ts`）。规则全部照 WPE 实测（`ignore/p6/c0`，`input_play` 逐帧喂光标与左键），文档见 `cocs/wpe/WPE_SCENE.md`「交互（P6c）」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | C1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error，全过 | 新增 `render/cursor.test.ts`、`script/cursorEvent.test.ts`、`compile/p6c.test.ts`，`script/api.test.ts` 加 `input` / `solid` |
| [x] | C2 对 WPE 日志逐行比 | Windows dev 屏外宿主 | `p6c-hit`、`p6c-par`、`p6c-shake`、`p6c-zoom`、`p6c-persp` 用 `inputTimeline` 回放，`ignore/p6/c0/cmp_logs.py` 比 `[kbp6c]` 行 | 回调序列与 `w` / `l` 逐字相同 | hit 98 / 98、par 13 / 13（`upd` 全部相同）；shake 回调序列 42 / 42 相同、数值差 ≤ 0.13（WPE 的 `g_Time` 未知）；zoom 49 条里 35 条逐字相同、其余 `l` 差 ≤ 4.6e-5（透视覆盖图层）；persp 序列相同、数值差 ≤ 1e-3（远平面 float32） |
| [x] | C3 语料 | Node，192 个工程 | 前后重扫 `unsupported` | 只去掉 `script:callback:cursor*`、`script:api:input.*`，没有新增键 | 干净场景 +17（含预期的 11 张），没有掉出 |
| [x] | C4 预览里点击 | Windows dev，图库预览 | 打开 `3637191856`、`3810092560` | 悬停、点击有响应，和 WPE 一致 | 待真机 |
| [x] | C5 桌面壁纸点击 | Windows，窗口模式壁纸 | 把上面两张设为桌面壁纸，点桌面 | 点在桌面或图标上有响应，点在别的窗口上没有 | 待真机 |
| [x] | C6 应用背景不交互 | Windows dev | 同一张场景设为应用背景 | 鼠标点击没有回调 | 待真机 |
| [ ] | C7 非 Windows | macOS / Linux | 同 C4 | 同 Windows | 本机不能测 |
| [x] | C8 挂脚本又绑属性的字段首次加载 | Windows dev | 把 `3637191856` 的属性「Show」打开，重新加载预览（关掉再打开、改场景后处理档位触发重编译各一次） | 时钟出现并保持显示，不回到工程 JSON 的隐藏值 | 2026-11-14 修复：挂脚本的字段 `init` 拿 JSON `value`，首帧之前由属性全集覆盖；屏外宿主回放时钟画面差异只剩字形边缘 |

## 场景壁纸反射设置与「反射关」（P13b1）

2026-11-14。设置「场景反射」（`wpeSceneReflection`，跟随 WPE 的 `reflection`）；反射关时 `_rt_Reflection` 每帧清成清屏色、`_rt_MipMappedFrameBuffer` 加载时清成 (0, 0, 0, 1)。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase13/rea-p13-passes.md` 第 1、4 节与 `p13-REPORT.md`「P13b1 的实测」，计划、实施记录与走查见同目录 `phase-13b1-reflection-off.md`，测试工程 `ignore/p13/proj/p13b1-*`（`ignore/p13/b1/gen_b1.py`），走查工程 `ignore/p13/proj/{arsenal,audiophile,fantasticcar}-kbp`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | R0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；`kabegame-core` 设置单测；`cargo check`、vue-tsc | 0 error、全过 | 2026-11-14：tsc 0 error；vitest 只有 `pipeline.test.ts` 的 `3293687972` 读取上限（工作区原有，与本节无关）；13 处变异全部检出 |
| [x] | R1 语料 | Node，197 个工程 | 前后重扫 `unsupported` | 只去掉 `_rt_Reflection`、`_rt_MipMappedFrameBuffer` 与对应的 `MipMapInfo` | 2026-11-14：干净 100 → 108（arsenal、audiophile、fantasticcar 与 5 个测试工程），没有新增键 |
| [x] | R2 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080 | 清屏色、只有图像层读、`clearenabled: false`、属性改清屏色、HDR、mip 帧缓冲各一个工程 | 整帧逐像素相同 | 2026-11-14：4 个工程 0 差异；`clearenabled: false` 只差 RenderDoc 叠在没画到区域的文字；HDR 那张反射图与泛光前的场景目标逐值相同，上屏只差泛光链 ≤ 4 级 |
| [x] | R3 真实壁纸走查 | Windows dev + WPE 抓帧，1920×1080，fps 20 | arsenal、audiophile、fantasticcar 各录 5 帧，`renderFrames.ts` 按日志逐帧回放、`kbp cmp frames` 比、逐 draw 对常量 | 读反射图的地面逐像素相同，差异逐处有解释 | 2026-11-14：地面相同；> 2 级的只有孤立的网格边像素（每帧 0–11 个），常量除相机矩阵差 1e-6 外逐值相同，归「网格边上的覆盖翻转」 |
| [ ] | R4 设置页切换 | Windows dev（新构建） | 设置页「场景反射」切三档，预览 Arsenal | 三档都能渲染（开启见 P13b2 的 RB4）；切换时场景重新加载 | 待重启 dev 后真机看（运行中的 dev 构建还没有新命令，宿主按跟随处理） |
| [ ] | R5 非 Windows | macOS / Linux | 预览 Arsenal | 同 Windows | 本机不能测 |

## 场景壁纸 sprite 对象（P13c）

2026-11-14。WPE 的 `sprite` 对象（ricepod 的太阳）：两网格的常量模型（光斑、遮挡方块），MVP = P · 去平移的视图；光斑大小 / 亮度 `k` 取上一帧遮挡方块通过深度测试的样本数，计数 pass 自己数、计算 pass 在 GPU 上算 k 写进光斑的 uniform；引擎恒定义 `REVERSEDEPTH`；拼错的 `depthtesting` / `depthwriting` 中性。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase13/p13-REPORT.md`「P13c 的实测」与同目录 `rea-p13-lights.md` 第 4 节，计划与实施记录见 `phase-13c-sprite.md`；测试工程 `ignore/p13/proj/p13c-*`（`ignore/p13/c/gen_c.py`）、走查工程 `ignore/p13/proj/ricepod-iso-sun`，WPE 抓帧在 `A:\p13c\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | RC0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、本节相关的 vitest、Prettier；变异检查 | 0 error、全过；变异全部检出 | 2026-11-14 Claude：tsc 0 error（别的会话的 `puppet/player.test.ts` 除外）；相关测试全过；11 处变异全部检出 |
| [x] | RC1 语料 | Node，238 个工程 | HEAD 与工作区各扫一遍 | 本节只去掉 `object:sprite`、`material:depthtesting` / `depthwriting`；加 `REVERSEDEPTH` 后能力表不变 | 2026-11-14 Claude：ricepod 变干净；其余增减是 P11c / P12 会话的改动；语料工程着色器没有用 `REVERSEDEPTH` 的 |
| [x] | RC2 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080 | 不挡 / 挡一半 / 全挡、相机平移 + sprite 写变换、正交五个工程，回放 3 帧后读回 | 整帧逐像素相同（屏蔽 FR / CLK） | 2026-11-14 Claude：五个都 0 差；挡一半 k = 0.737888 和抓帧逐位相同；平移工程与不挡的像素摘要相同 |
| [x] | RC3 ricepod 走查 | Windows dev + WPE 抓帧（后处理超高），1920×1080，fps 20 | 去掉粒子的复制工程，开窗 110 s 后（太阳被船体部分挡住）录 5 帧，`renderFrames.ts` 按日志回放 | 光斑位置、大小、渐隐与 WPE 相同 | 2026-11-14 Claude：每帧 > 0 的像素 529–6288（当时没解释）。2026-11-15 Claude：差异已解释（2026-11-15 复核，P5d 把透视相机改成逐步 float32 之后）：第 2223 帧各 draw 的常量与 WPE 0 ULP（遮挡方块的轴长改成 float32 的 0.2 之后）；光斑的 k 两边都是 1，光斑在整帧上不引入差异；第 2221 帧逐像素相同，其余 4 帧剩下的都是 1 级：船体主网格（e102）8 个、喷口（e118）1 个孤立像素，归「片元的零星舍入差」（P11a 已知差异），2222 帧泛光模糊 1 个纹素差 1（P2b 已知差异）经上采样成 3 个像素，2224 帧船体 1 个像素经泛光摊成 134 个。逐级比较见 `phase-13c-sprite.md`「走查复核」 |
| [ ] | RC4 预览 ricepod | Windows dev | 预览 Rice Pod，等相机转到太阳那段（约 80–115 s） | 太阳光斑出现，被船体挡住时渐暗、不闪 | 待真机看 |
| [ ] | RC5 非 Windows | macOS / Linux | 预览 Rice Pod | 同 Windows（计数不依赖遮挡查询） | 本机不能测 |

## 场景壁纸平面反射开（P13b2）

2026-11-14。反射开时在主 pass 之前画平面反射 pass：编译期定名单（`reflected` 不为 false、去掉读反射图的模型，绑属性时重编译），透视场景 `S·VP·S`、正交场景视图投影不变、eye / right / up 的 y 取反，深度共用、`clearenabled` 决定清不清；支持模型、直接上屏的图像层与文本层、普通粒子，别的种类报 `reflection:planar:<种类>`。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase13/p13-REPORT.md`「P13b2 的实测」，计划、实施记录与走查见同目录 `phase-13b2-reflection-on.md`；测试工程 `ignore/p13/proj/p13b2-*`（`ignore/p13/b2/gen_b2.py`），WPE 抓帧在 `A:\p13b2\`。dev 下验收用 `localStorage["kabegame-dev-scene-reflection"] = "enabled"` 强制反射开，测完删掉。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | RB0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；变异检查 | 0 error、全过；变异全部检出 | 2026-11-14 Claude：tsc 0 error；返工（五个相机字段收成主视图、粒子一帧只排一次）后在 HEAD + 本节改动的快照上跑本节相关的 11 个文件 249 个全过；16 处变异全部检出；返工前后真机渲染逐字节相同 |
| [x] | RB1 语料 | Node，201 个工程 | 跟随（WPE 反射关）与强制开各扫一遍，和 HEAD 比 | 跟随时 `unsupported` 不变；开时不新增 `reflection:planar:*` | 2026-11-14 Claude：跟随 0 变化；强制开时干净 139 不变，只有读 mip 帧缓冲的 2 张（3453730450、3706286085）新增 `reflection:screen`（P13g） |
| [x] | RB2 生成工程对照 WPE | Windows dev + WPE 抓帧（反射开），1920×1080 | 透视、`clearenabled: false`、正交 + 图像层、视锥剔除、透视粒子、正交粒子 + 文本六个工程，`render_scene` 按抓帧时刻渲染 | 上屏逐像素相同（屏蔽 FR / CLK） | 2026-11-14 Claude：六个都 0 差；`clearenabled: false` 只差 RenderDoc 叠加文字；透视工程的反射图只差帧号块；剔除工程画出了只在镜像视锥里的品红片 |
| [x] | RB3 真实壁纸走查 | Windows dev + WPE 抓帧（反射开、后处理超高），1920×1080，fps 20 | arsenal、audiophile、fantasticcar 各 5 帧，`renderFrames.ts` 按日志回放（audiophile 带频谱录制）、`kbp cmp frames` | 倒影与 WPE 相同，余差逐处有解释 | 2026-11-14 Claude：倒影相同；每帧 > 8 级的像素 ≤ 11 个、孤立单像素、不在反射区域；arsenal 的反射名单实际为空（只清屏） |
| [x] | RB7 对齐方式与反射 RT 的清屏色 | Windows dev + WPE 抓帧，1920×800 | `p13b2-scheme`（清屏色灰、`schemecolor` 蓝，地面读反射图）在 WPE 对齐方式 0 / 1 / 3、反射开 / 关各抓一帧；`renderFrames.ts --render-mode target --style fill / fit / center` 按同尺寸渲染 | 反射 RT 和主目标同色（0 是 `clearcolor`，1 / 3 是 `schemecolor`），整帧逐像素相同 | 2026-11-14 Claude：WPE 反射 RT 读值逐项符合；6 组都 0 差 |
| [x] | RB4 反射开关 | Windows dev（新构建） | 预览 Fantastic Car，在右栏「预览设置」里把「场景反射」在「开启」与「关闭」之间切换（预览不读设置页的全局值，预览设置缺省就是开启）；桌面要看就设成壁纸，在设置页切「开启」与「跟随」（本机 WPE 的 `reflection` 是 false，跟随即关）。和 WPE 对照前先确认 WPE 那边的反射状态：WPE 设置界面里改了还没点确定时，`config.json` 落后于 WPE 进程里的值 | 开启时地面有车的倒影、关闭时没有，切换时场景重新加载、不退回预览图 | 2026-11-18 用户：开启时倒影正常；关闭时看着和 WPE 不同（WPE 格线是白的），查明当时 WPE 进程里反射是开的（同时抓的测试窗口有反射 pass，格线白色是倒影里的穹顶）。Claude 用 P13b1 的 WPE 反射关录制（`A:\p13b1\fantasticcar-kbp-fps20-1920x1080`）按日志回放当前代码：5 帧最大差 1 级、每帧 ≤ 40 个像素。Arsenal 的反射名单是空的，开关看不出区别 |
| [ ] | RB5 绑属性的 `reflected` | Windows dev | 一个 `reflected` 绑用户属性的工程，属性面板切换 | 整场重编译后倒影出现 / 消失 | 单测覆盖重编译登记，待真机确认 |
| [ ] | RB6 非 Windows | macOS / Linux | 反射开时预览 Fantastic Car | 同 Windows | 本机不能测 |

## 场景壁纸用户纹理（P11b）

2026-11-14。材质 / effect 实例 / instanced `instance` 的 `usertextures` 的属性来源（`scenetexture`）：属性面板选图片、GIF 或 MP4，场景按 WPE 的规则在正中裁切后换上该槽纹理，就地生效、不重编译。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md`「属性纹理」「P11b 补测」与同目录 `rea-p11b.md`，计划、实施记录与走查见 `phase-11b-usertextures.md`；生成工程 `ignore/p11/defs/p11b.py`、`p11b2.py`，测试媒体在 `ignore/p11/texsrc/`，复制工程在 `ignore/p11/proj/*-iso-ut-*`，WPE 抓帧在 `A:\p11b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | U0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier；`kabegame-core` / `kabegame` 的 `user_props`、`wpe_web_dir_index` 单测；`apps/kabegame` 的属性面板单测；`scripts/kabegame-dev` 与 `apps/kabegame-dev-mcp` 的 `deno test` | 0 error；除已知失败外全过 | 2026-11-14：步骤 1–4 合并进工作区后的快照 tsc 0 error、vitest 3573 个全过；Rust 7 + 22 个、面板 9 个通过；步骤 5 的工具改动单测通过。HEAD 原有的 `pipeline.test.ts` 语料用例（`3293687972` 读取超上限）不含 P11b 时同样失败。变异检查：编译期 3 处（1 处等价变异）、GIF 解码器 8 处全部检出 |
| [x] | U1 语料 | Node，183 个工程 | 前后重扫 `unsupported` | `material:usertextures` / `effect:*:pass:usertextures` 只换成细分键、`material:keepaspect` 去掉，原来能渲染的不掉出 | 2026-11-14：能渲染 88 → 90（`3462279189`、`3783690410`）；去掉 `material:usertextures` 30 张、`effect:*:pass:usertextures` 21 张，新增 `usertextures:system` 19 张、`:usershortcut` 3 张、`:particle-sheet` 2 张；其余键逐张不变 |
| [x] | U2 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080 | `p11-ut-ar`、`p11b-npot`、`p11b-inst`、`p11b-rt`、`p11b-rt-init` 的属性设成 `ut-a.png`，WPE 抓帧，`render_scene` 按同一属性值回放 | 整帧逐像素相同（屏蔽 FR / CLK） | 2026-11-14 Claude：五个工程都 0 差，含非 2 的幂的槽 0、instanced 的合成 RT 与强制白、缺省是合成 RT 时「加载时就有值不生效」 |
| [x] | U3 运行中换图 | Windows dev + WPE 抓帧 | 屏外宿主打开 `p11b-rt` / `p11b-inst`，改属性（`metadataId` 补丁），`host.renderFrame(time, key)` 读回 | 宿主 `applied` +1、不重编译；画面和 WPE 运行中改值后的相同 | 2026-11-14 Claude：两条路（重绑 draw、槽 0 整层重建，合成 RT 32×32 → 300×200）前 1000 行区域哈希都和 WPE 相同 |
| [x] | U4 GIF | Windows dev + WPE 抓帧 | `ut-disp.gif`、`-b`、`-c`（disposal 0–3、局部调色板、交错、透明、`bgindex` 0）在 `p11b-npot` 上，WPE 导出槽纹理；`render_scene` 按 `gifDts` 推进 | 每帧合成逐像素相同；换帧时机同 WPE | 2026-11-14 Claude：12 张槽纹理逐像素相同；96 次换帧都能用 float32 推进模型复现；真 GPU 上第 0 帧整帧 0 差，0–6 帧的采样哈希和 WPE 的 7 种画面逐个相同 |
| [x] | U5 视频裁切 | Windows dev + WPE 抓帧 | `ut-vstripe.mp4`（8 条 40 像素竖条）在 `p11-ut` 上 | 裁切起点与 WPE 相同 | 2026-11-14 Claude：都从 x = 40 起、色带顺序与边界相同，交界 1–2 列是色度上采样；整体偏色是已知差异（标清、未标色彩信息的视频，Chromium 多做一次原色转换，已转 P9） |
| [x] | U6 真实壁纸走查 | Windows dev + WPE 抓帧，后处理超高 | 3462279189、3351163962、3253330537、2833017810、3783690410 的复制工程（属性设成已知图），WPE 按日志回放 | 差异逐处有解释 | 2026-11-14 Claude：前三张整帧 0 差；2833017810（HDR）最大差 1，是 WPE 半精度上屏换成 8 位的舍入；3783690410 的余差来自场景里的两段视频 |
| [x] | U7 面板、就地换图与放行 | Windows dev | 场景属性面板上选图、换图、清空；从库里删掉这张场景后再读选过的文件 | 场景就地换上（`recompiled` 不变）；值存成 `/` 分隔；没选的文件与删图后的文件被 `deny file:` | 2026-11-14 Claude：值存成 `D:/…/ut-b.jpg`、`applied` +1、没有重编译；选中的能读、没选的 `ut-d.png` 被拒，删图后同一个文件被拒 |
| [x] | U8 用户视频 | Windows dev | 在场景属性面板里选一段 MP4 | 视频在场景里播放 | 2026-11-14 用户手测：能工作 |
| [ ] | U9 预览里的 GIF 与暂停 | Windows dev | 在预览的场景属性面板里选一张 GIF，再点「暂停」与「继续播放」 | GIF 按自己的节奏动；暂停时停住，继续后接着放、不追赶 | 实时帧里的 GIF 推进只在单测与屏外 `gifDts` 回放上验过，待真机确认 |
| [ ] | U10 大图 | Windows dev | 选一张 6000×3000 的 JPEG，再换回小图 | 解码完成后换上（晚几帧）、不卡死；裁成 3000×3000 | 待真机确认 |
| [ ] | U11 非 Windows | macOS / Linux | 预览一张带 `scenetexture` 的场景并选图 | 同 Windows | 本机不能测 |

## 场景壁纸按属性切换的纹理变体（P11e）

2026-11-21 Windows dev。`TEXB0004` 的条件与变体：加载时按用户属性选、运行中改值下一帧换图（只重写纹理内容，不重编译）。计划、读码与实测见 `.claude/plans/wpe-import/3-scene/phase11/phase-11e-texture-variants.md`、`rea-p11e.md`，文档见 `cocs/wpe/WPE_SCENE.md`「纹理变体（P11e）」。数据在 `ignore/p11/e/`，WPE 抓帧在 `A:\p11e\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；vitest `compile/textureVariants.test.ts`、`compile/tex.test.ts`、`render/p11b.test.ts`（纹理变体两条）、`host.usertextures.test.ts`；Prettier | 0 error、全过 | 2026-11-21 Claude：tsc 0 error，4 个文件 96 个用例全过；变异 5 处（同组不去重、判定不看类型、整张替换不截断、选择不变也重写、不读每级变体块）全部检出 |
| [x] | V1 WPE 的选择与贴法 | Windows + WPE 抓帧，1280×720 | `kbp gen p11e`（底图三级 mip、8 条条件），五个工程各抓 1 帧，读回图像层 `g_Texture0` 的三级 mip，和参考实现 `ref_variants.py` 逐像素比 | 同组只认第一条、跨组按顺序覆盖、每级用自己的矩形、数字值判假、bool 形式只认 true | 2026-11-21 Claude：四个工程三级 mip 都是 0 差；标志位 1 的混合公式也 0 差（照报不做）；标志位 2 时 WPE 把 PNG 编码字节当像素上传（缺陷，不复刻） |
| [x] | V2 WPE 运行中换值 | 同 V1 | `apply_properties` 改 leg、flag，再改回没有命中的值 | 换图、改回底图 | 2026-11-21 Claude：两次都和参考实现 0 差 |
| [x] | V3 我们的渲染 | Windows dev，屏外宿主，1920×1080 | 生成工程 `p11e-var-l1`、`p11e-var-s` 用 `renderFrames.ts` 渲染，和 WPE 同尺寸抓帧整帧比（屏蔽 FR / CLK） | 逐像素相同 | 2026-11-21 Claude：两个工程各 2 帧 0 差 |
| [x] | V4 3817265356 复制工程 | Windows dev + WPE 抓帧，1920×1080、fps 20、ultra | `kbp content isolate --keep 91`，属性「腿」"1" / "2" / "3" 各一份，按日志回放逐帧比 | 差异都能解释 | 2026-11-21 Claude：最大差 1–2、每帧 ≤ 617 个像素有差；没有命中的 "2"（只有底图）同样量级，是缩小采样的差异，和变体无关 |
| [x] | V5 语料 | Node | `kbp regress --corpus --no-cases`（HEAD 快照对本步）；`kbp corpus scan --project …/myprojects/3817265356` | 工坊与默认工程不变；3817265356 变干净 | 2026-11-21 Claude：0 张变化；3817265356 从 `tex:parse:…纹理数据越界` 变成没有不支持项 |
| [x] | V6 预览里切换选项 | Windows dev，图库预览 | 预览 `3817265356`，在属性面板把「腿」在黑丝 / 白丝 / 无之间切换 | 画面当场换，不重新加载、不闪 | 需要用户看（重开预览以用上新的宿主产物） |
| [x] | V7 桌面壁纸 | Windows dev，窗口模式 | 把 `3817265356` 设为桌面壁纸，在设置页「当前壁纸」里切换「腿」 | 同 V6 | 需要用户看 |
| [ ] | V8 非 Windows | macOS / Linux | 同 V6 | 同 Windows | 本机不能测 |

## 场景壁纸的 BC7 纹理（`.tex` 格式 12）

2026-11-21 Windows dev。WPE 把格式 12 映射成 `BC7_UNORM`（`rea-p4b-render.md` 1.2），我们原样上传为 `bc7-rgba-unorm`。生成器 `ignore/p11/defs/p11f.py`，数据在 `ignore/p11/f/`，WPE 抓帧在 `A:\p11f\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | B1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；vitest `compile/tex.test.ts`、`compile/particles.test.ts`、`compile/sheet.test.ts` | 通过 | 2026-11-21 Claude：194 个用例通过 |
| [x] | B2 和 WPE 整帧比 | Windows dev 屏外宿主 + WPE 抓帧，1920×1080 | `kbp gen p11f`：`3816948983` 的 `water-0.tex`（1672×944、没压缩）normal / translucent 两份，`sprites-0.tex`（3968×4096、LZ4）左上角与右下角两份，图层 1:1；`renderFrames.ts` 与 `kbp cmp frame`（屏蔽 FR / CLK） | 逐像素相同 | 2026-11-21 Claude：四份最大差都是 0 |
| [x] | B3 语料 | Node | `kbp regress --corpus --no-cases`（HEAD 快照对工作区）；`kbp corpus scan --project …/myprojects/3816948983` | 缺省语料不变；3816948983 不再报 `tex:format:12` | 2026-11-21 Claude：233 / 233 逐场景相同；3816948983 静态扫描干净 |
| [ ] | B4 预览 3816948983 | Windows dev，图库预览 | 打开这张壁纸的预览 | 不再因 `tex:format:12` 退回预览图 | 运行中脚本建层还会报 `model:passthrough:children:model`（看板娘提示），水面效果偏亮、上边与左边拉丝，和 BC7 无关、另开一步 |
| [ ] | B5 非 Windows | macOS / Linux | 同 B4 | 设备有 `texture-compression-bc` 时同 Windows | 本机不能测 |

## 场景走查工具：真实壁纸的逐粒子对照与 R 注入（P11b2 走查后补）

2026-11-19 Windows dev。`kbp rdc track` 的 scene 认法、`kbp cmp random-encode` / `random`、`renderFrames.ts --random`、MCP `random` 的文件写法、探针查注入表的键。数据在 `ignore/p11/b2/`（`tracks/`、`out/tools-*`），复制工程 15616（叶子）、15615（樱花）用完已移除。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | R0 单测与检查 | Windows | `kbp-tools/tests/scene_track.py`；`deno test -A --no-check` 跑 `renderFrames.test.ts`、`particles.test.ts`；`deno check` 两个源文件；`apps/wpe-scene` 的 tsc、vitest `render/particles.test.ts`、`particles/noise.test.ts` | 全过 | 2026-11-19 Claude：自测 23 项、deno 9 组 53 步、vitest 90 个全过，tsc 0 error；变异 4 处（两个探针调用点、唯一分法、位置容差）全部检出 |
| [x] | R1 scene 认法取 WPE 粒子 | RenderDoc 1.47（无界面） | `kbp rdc track A:\p11b2\3812473896-iso-leaves-fps20-1920x1080 <标签> --data ignore/p11/b2` | 自动选 scene，4 帧两个系统按计划起名，顶点和手取的相同 | 2026-11-19 Claude：`叶子 2`、`叶子 2/0` 各 45 个，`unassigned` / `no_clock` 为空；第 226 帧事件 21、34 和走查时经 MCP 手取的 vs_in 逐项 0 差 |
| [x] | R2 真实壁纸逐粒子比 | Windows dev，屏外宿主 | `particle_track`（时间线带 R1 的轨迹）后 `kbp cmp track` | 位置、尺寸、颜色、旋转 0 差，alpha 只有已知的近似倒数差 | 2026-11-19 Claude：叶子两系统各 180 对、樱花 720 对，pos / size / color / rot 0，alpha 2.44e-3（`rcpps(9)`）；R1 的轨迹当时间线 `track` 收下 |
| [x] | R3 R 注入表 | Windows dev + Node | `kbp cmp random-encode 400` → `particle_track` 注入 → `kbp cmp random … --system 樱花` | 和走查时手工配对、合并的表相同 | 2026-11-19 Claude：184 个出生序号（106–289），400 项逐项相同；位置容差、R 冲突、粒子数不同各报错（自测） |
| [x] | R4 一段带注入的回放 | Windows dev | `renderFrames.ts --image 15615 --frames 225-228 --random 0=<表> --canvas 1920x1080 --postprocess ultra` 后 `kbp cmp frames` | 四帧对 WPE 最大差 2（同走查） | 2026-11-19 Claude：四帧最大 2、> 2 的像素 0 |
| [x] | R5 注入表的键写错 | Windows dev | 同 R4，`--random 39=<表>`（对象 id，不是下标） | 报错并列出粒子对象，不再静默退回种子随机数 | 2026-11-19 Claude：报「random 的键 39 不是粒子对象的 objects 下标…；场景里的粒子对象：0「樱花」」；改之前这样跑最大差 124 |
| [ ] | R6 MCP `random` 写文件路径 | 会话里的 kabegame-dev MCP | MCP 重连后 `particle_track { …, random: { "0": "<表.json>" } }` | 读成数组转给探针 | 单测覆盖；本会话的 MCP 进程是改之前起的（报 `Expected array`），要重连后再试 |

## 场景壁纸粒子精灵表槽的用户纹理（P11b2）

2026-11-18。粒子材质槽 0 的缺省是精灵表、又绑了 `scenetexture` 时，按属性的**当前值**定这个粒子系统是不是精灵表：有图（文件读得到）则每个粒子画整张，清空则回到精灵表一格一格播，改值时只重编这个对象、当场生效（WPE 只在加载时定一次、运行中选的图被切成格子，有意不同）。不再报 `usertextures:particle-sheet`。测试工程在 `ignore/p11/proj/`（`p11b-sheet*`，由 `ignore/p11/b2/make_sheet_init.py`、`make_sheet_live.py` 生成），WPE 抓帧在 `A:\p11b2\`，计划与实测见 `.claude/plans/wpe-import/3-scene/phase11/phase-11b2-particle-sheet.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；vitest `compile/sheet.test.ts`（含改值分到对象级重编译）、`p11b.test.ts`、`workerHandler.test.ts`、`exactConfigs.test.ts`、`fragment.test.ts`、`p4f4.test.ts`、`particles.test.ts`、`registry.test.ts`、`host.test.ts`；Prettier | 通过 | 2026-11-18 Claude：tsc 0 错误；`refract.test.ts` 有 1 条 `tex:animation:multi-image` 失败，HEAD（`f32defcf`）上同样失败，是 P6e 那边的 |
| [x] | S1 WPE 实测三种情形 | Windows + WPE 抓帧，1600×900 | `p11b-sheet-init`（属性缺省是 `ut-a.png`）、`p11b-sheet-missing`（缺省是不存在的路径）、`p11b-sheet-init` 运行中清空 | 加载时有图：薄格式、UV 0–1 整张；读不到：厚格式、绑缺省精灵表；清空后：整张精灵表 | 2026-11-18 Claude：三条都和读码一致（子计划「步骤 0」表）。前两条我们照做；第三条和运行中选图的格子画法我们改成当场切换（有意不同） |
| [x] | S2 语料 | Node，233 个工程 | `kbp regress --corpus --no-cases`，HEAD 快照对本步 | 只去掉 `usertextures:particle-sheet`，原来能渲染的不掉出 | 2026-11-18 Claude：只有 `3799462430`、`3812473896` 不同，各去掉这一个键，干净 223 → 225，没有新增键 |
| [x] | S3 加载时就有图 | Windows dev，屏外宿主 | `p11b-sheet` 导入后用 `set_wpe_web_user_properties` 设 `ut = ut-a.png`，`render_scene` 回放 60 帧、带 `trace` | 每个粒子画整张用户图，粒子管线没有厚格式的那一列 | 2026-11-18 Claude：6 个粒子都是完整的四色块（宽高比 83×100，同 WPE），粒子管线 stride 52（薄格式），槽 0 绑 166×200 的用户图 |
| [x] | S4 运行中选图、清空只重编这个对象 | Windows dev，屏外宿主 | `p11b-sheet-live` 属性为空时开宿主，先设 `ut-a.png`、再清空 | 每次 `recompiledObjects` +1，`recompiled` 为空（不整场重编译），用户纹理 `ready` → `empty` | 2026-11-18 Claude：0 → 1 → 2，`recompiled` []，日志没有出错；屏外宿主不跑帧循环、粒子是 0 个，画面要在预览里看（S6） |
| [x] | S5 两张真实壁纸 | Windows dev，屏外宿主 | 开 `3799462430`（库里 13615）、`3812473896`（13624）的宿主 | 进入渲染、不退回预览图 | 2026-11-18 Claude：日志「开始渲染」69 层 / 71 层。`render_scene` 对 13615 等视频纹理第一帧超时（110 MB 的视频，与本步无关） |
| [ ] | S6 预览里选图、换图、清空 | Windows dev，图库预览 | 预览 `3799462430` 或 `3812473896`，在属性面板「自定义粒子效果」选一张图，再换一张，再清空 | 选图后每片落叶当场变成整张图；换图时落叶不重新开始；清空后当场回到原来的落叶 | 待用户手测（要开预览） |
| [ ] | S7 非 Windows | macOS / Linux | 同 S6 | 同 Windows | 本机不能测 |
| [x] | S9 走查：3812473896「叶子 2」复制工程 | Windows dev + WPE 抓帧，1920×1080、fps 20、ultra | `kbp content isolate --keep 37`，随机项收成 min = max；「为空」「加载时就有图」各录 4 帧，按日志回放、逐像素比、逐粒子对 RenderDoc 顶点 | 差异都能解释 | 2026-11-18 Claude：最大差 5（为空）/ 7（有图），全部来自近似倒数 `rcpps(9)`（逐粒子比例 1.0002442，临时换成 `rcpps(9)` 后降到最大 2–3、有差像素降到原来的 3%），剩下的是着色器舍入 |
| [x] | S10 走查：3799462430「樱花」复制工程（randomframe） | 同 S9 | `--keep 39`；`randomframe` 的 `R` 两遍注入 | 差异都能解释 | 2026-11-18 Claude：找到并修了精灵表参考尺寸的取整 bug（WPE 159、我们 160），修后为空最大 2、有图最大 5–10（用户图色块硬边、强缩小下的着色器舍入，每帧 ≤ 41 个像素 > 2） |
| [x] | S8 清空不报错 | Windows dev，屏外宿主 + 单测 | 属性为空时开 `p11b-sheet-live`，选图后再清空，清空后连续强制渲染几帧（`host.renderFrame`）；单测 `render/p11b.test.ts`「粒子材质槽 0 换图（P11b2）」 | 不报 `Destroyed texture used in a submit`、不退回；粒子 draw 的 bind group 先换回缺省、用户纹理再释放 | 2026-11-18 用户在预览里选图后清空报这个错（粒子 draw 不重绑，对象级重编译换上之前旧粒子层还拿着被释放的纹理），修复后 Claude 复测：清空后 6 帧都成功、日志没有校验错误；撤掉修复时单测失败 |

## 场景壁纸系统媒体（P11c）

2026-11-14 至 11-15。场景脚本的五个 `media*Changed` 回调与封面纹理 `$mediaThumbnail` / `$mediaPreviousThumbnail`：
- 后端的媒体监视分出一份照 WPE 取值的场景投影；
- 场景宿主照 WPE 按 `windowupdaterate` 合并、每帧派发；
- 封面经 P11b 的来源表同帧换图；
- 网页壁纸的封面配色同时换成 WPE 的算法。

依据与资料：
- WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md`「媒体回调与封面」与同目录 `rea-p11-media.md`、`rea-p11-textures.md`；
- 计划、约定与走查见 `phase-11c-media.md`；
- SMTC 夹具 `ignore/p11/smtc/fixture.ps1`，步骤表 `ignore/p11/c/steps-c*.json`；
- 生成工程 `ignore/p11/proj/p11-media`，复制工程 `ignore/p11/c/proj/`，WPE 抓帧 `A:\p11\c-thumb`、`A:\p11\c-iso`。

媒体实测会在系统里发布测试媒体会话，测之前请先暂停自己的播放器。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | M0 单测与检查 | Windows | `kabegame` 的 `wpe_` 过滤（配色、两个投影、Hub、攒批）；`apps/wpe-scene` 的 tsc、vitest、Prettier；`scripts/kabegame-dev` 的 `deno test`、`deno check` | 全过 | 2026-11-14：Rust 92 个全过；宿主快照 vitest 3963 个，只有 `pipeline.test.ts` 的读取上限（`3543014965` 读 104 MB）失败，HEAD 快照同样失败；合并进工作区的快照 tsc 0 error、相关 646 个全过。变异检查：Rust 4 处、宿主 5 处全部检出 |
| [x] | M1 语料 | Node，219 个工程 | 前后重扫 `unsupported` | 只去掉 `script:callback:media*` 与 `usertextures:system`，原来能渲染的不掉出 | 2026-11-14：能渲染 147 → 157，没有新增键 |
| [x] | M2 回调序列对 WPE | Windows dev + WPE 测试窗口 + SMTC 夹具 | 夹具按步骤改属性、封面、播放状态、时间轴、类型，清空显示信息，退出；WPE 开 `p11-media`；Kabegame 屏外宿主记下收到的消息，按批用探针回放、取 `[p11m]` 行 | 回调与参数逐行相同 | 2026-11-14 Claude：四轮逐行相同，含超长清空（1025 / 1024 字节、专辑名 257 字节）、`contentType` 空串、会话切换与复位；首个会话的「属性、封面」WPE 晚一次刷新，是它的子进程等封面解码，记为已知差异 |
| [x] | M3 封面纹理 | 同上 | 封面 m1 → 改标题换 m2，抓 WPE 一帧；探针按同样两批消息回放 | `TH-CUR`（1:1，m2）、`TH-PREV`（1:4，m1）逐像素相同 | 2026-11-14 Claude：两块都 0 差，整帧只差 FR / CLK |
| [x] | M4 重设同一张封面 | 同上 | 只重设同一张；重设并改标题 | 只重设：不发；连同改标题：再发一次封面 | 2026-11-14 Claude：两边相同；改标题时系统先报一次没有封面、约 5 ms 后再报原图 |
| [x] | M5 会话退出 | 同上 | 夹具从暂停状态退出，系统切回另一个已暂停的会话 | 场景只收到属性、时间轴、封面，没有播放回调（同 WPE） | 2026-11-15 Claude：照 WPE 100 ms 攒批、丢旧会话事件之后相同；修之前多一条 `playback` |
| [x] | M6 真实壁纸走查 | Windows dev + WPE 抓帧 1920×1080 | 2932157836、3823859141、3487328036 的复制工程，夹具给已知标题与三色封面，播放中，稳定后抓帧 | 差异逐处有解释 | 2026-11-15 Claude：2932157836 除挂 `spin` 的圆形封面外整帧 0 差；3823859141 除唱片 `spin` 外只有文字阴影模糊边缘 ≤ 8；3487328036 的封面对象两边都没画出（缩放挂音频脚本），背景差来自 WPE 后处理档位 ultra |
| [x] | M7 真机预览 | Windows dev | 预览一张媒体场景（如 3823859141），用自己的播放器放歌、切歌、暂停；再关掉设置里的「媒体集成」 | 标题、封面、唱片颜色跟着变；关掉后封面回到缺省、脚本收到 `enabled: false` | 待用户手测 |
| [x] | M8 网页壁纸配色 | Windows dev | 打开一张用到媒体监听的网页壁纸，放一首有封面的歌，再放一段没有封面的 | 颜色按 WPE 的算法（`textColor` 是对比度够的次色 / 第三色）；没有封面时五色全黑 | 待用户手测；Phase 8 原来没有封面时是深灰底白字 |
| [ ] | M9 非 Windows | macOS / Linux | 预览一张媒体场景 | 订阅被拒，脚本收到 `enabled: false`，封面槽是缺省纹理 | 本机不能测 |

## 场景壁纸 puppet 骨骼动画（P12a）

2026-11-14。图像层的 puppet（模型 JSON 的 `puppet`）用 mdl 的网格 0 代替四边形上屏，动画层按 WPE 的时钟、采样、混合与淡入淡出每帧求骨骼姿势，蒙皮矩阵写进 `g_Bones`；带 effect 的 puppet 先在合成链里做完 effect，再用网格采样合成 RT 上屏。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase12/rea-p12-mdl.md`、`rea-p12-runtime.md` 与 `p12-REPORT.md`，计划、实施记录与按 FINAL_CHECK 的走查见同目录 `phase-12a-mesh-animation.md`；生成工程 `ignore/p12/defs/p12.py`，复制工程 `ignore/p12/a/final/proj/*-iso-pup`，走查报告 `ignore/p12/a/final/report.txt`，WPE 抓帧在 `A:\p12\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PP0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error；除已知失败外全过 | 2026-11-14：步骤 1–4 的提交快照 tsc 0 error；`mdl` / `puppet` / `src/puppet` / `p12a` / `p5a` / `p5c` 等相关单测全过；全量 vitest 只有 HEAD 原有的 `pipeline.test.ts` 语料用例（`3293687972` 读取超上限）失败，和本步无关。运行时的 `g_Bones` 单测按 dt 序列对 WPE 抓帧的值：`p12-fade` 逐位相同，`p12-modes` / `p12-mix` / `3203778110` 最大 2 / 5 / 3 ulp |
| [x] | PP1 语料 | Node，192 个工程 | 前后重扫 `unsupported` | 去掉的键只落在 puppet 场景上，新增的只有 `puppet:*` 细分键，别的场景逐张不变 | 2026-11-14：能渲染 100 → 110；去掉 `model:puppet` 36 张、`object:animationlayers` 32 张；新增 `puppet:alpha` 6、`puppet:layer-script` 5、`puppet:physics` 5、`puppet:clipping` 4、`puppet:morph` 2、`puppet:draw-order` 1、`puppet:texture-channels` 1 张 |
| [x] | PP2 真 WebGPU 上的管线与常量 | Windows dev 屏外宿主 + WPE 抓帧 | `p12-modes`、`p12-fx`、`p12-fx2`、`3203778110` 共 11 帧，探针逐 draw 轨迹对 WPE 的常量、顶点与合成 RT | 带 `SKINNING` 的管线建得出、不退回；`g_Bones`、顶点、UV、合成 RT 与 WPE 相同或差在 `rsqrtps` 量级 | 2026-11-14：61 次 puppet draw 按 MVP 配上 WPE，`g_Bones` 最大 3 ulp；索引、位置、骨骼下标、权重、UV 逐个相同；合成 RT 36 张里 34 张 0 差异，另 2 张各 1 个像素 1 级（waterwaves，已转 P7） |
| [x] | PP3 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080，fps 20，后处理超高 | `p12-modes`、`-fade`、`-mix`、`-fx`、`-fx2` 各录 8 帧，`renderFrames.ts` 按日志逐帧回放（逐帧光标）、`kbp cmp frames` 比 | 整帧逐像素相同 | 2026-11-14：40 帧全部 0 差异（含 FR、CLK），覆盖直接上屏（DXT、非 2 的幂、静态 puppet）与合成路径；错一帧比的阴性对照上万个像素差 |
| [x] | PP4 真实壁纸复制工程 | Windows dev + WPE 抓帧，fps 20，后处理超高 | `kbp content isolate` 只留 puppet 与父链、effect、绑定：`3354366708`、`3203778110`、`2896608544`（3840×2160 无边框窗口）、`3409595232`、`3828324728`、`3814576310`、`3811769317`，各 6 帧逐帧比、逐 draw 对常量 | 差异逐处有解释 | 2026-11-14：`3354366708`、`3203778110` 逐像素相同；`2896608544` 每帧 34–477 个像素 ≤ 2 级，输入除 `g_Bones` 外逐位相同，归顶点位置 1e-4 像素量级的舍入（部分证实来自 `rsqrtps`）；另三张解释到 draw 级；`3811769317` 的 cloudmotion 边缘差到 204 级，是单级 mip 纹理没开各向异性（不属于 P12a，已转 P7） |
| [x] | PP5 解锁场景整张 | Windows dev 屏外宿主 | 10 张解锁的场景开脚本各渲染一帧 | 能画、不支持项为空、没有退回、脚本 `init` 成功 | 2026-11-14：9 张走查时全部通过；`3351072238` 在 P3 修了属性缺省（`896e7f1c`）后核对，缺省属性下背景视频、人物与日期文字都在 WPE 的位置上 |
| [ ] | PP6 运行中改动画层属性 | Windows dev，图库预览 | 在 `2896608544` 的属性面板改动画层的速度与显隐类属性 | 当帧生效、不整场重编译、动画不从头开始 | 只有单测；生成工程 `p12-bind` 的 WPE 对照没做 |
| [ ] | PP7 实时预览与桌面 | Windows dev，图库预览与桌面 | 预览并设为桌面壁纸：`3203778110`、`2896608544`、`3354366708`；暂停再继续 | 骨骼动画流畅；暂停时停住、继续后接着播 | 只在探针回放里比过，实时播放待用户看 |
| [ ] | PP8 非 Windows | macOS / Linux | 预览 `3203778110` | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 的挂点、骨骼透明度、变形与裁切（P12b1）

2026-11-15。P12a 的 puppet 再接四样：
- 挂点：子对象挂在父 puppet 的骨骼上；
- 骨骼透明度（`SKINNING_ALPHA`）；
- 顶点变形（`MORPHING`，变形纹理 + 每帧权重）；
- 裁切遮罩：mdl v23 记录表照 WPE 的命令表拆段，全场一张半分辨率 R8 遮罩 RT。

父对象在本帧被脚本或关键帧动画移动时，挂点的 puppet 与局部空间粒子照 WPE 的世界矩阵缓存晚一帧（`render/worldStamps.ts`）。依据与记录：
- 计划、实施记录与走查：`.claude/plans/wpe-import/3-scene/phase12/phase-12b-attach-morph-clip.md`；
- 读码：`ignore/p12/b/rea/`；
- 走查报告：`ignore/p12/b/final/report.txt`、`ignore/p12/b/lag/report.txt`；
- WPE 抓帧：`A:\p12\b\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PB0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、相关 vitest（设 `KABEGAME_WPE_ROOT`）、Prettier | 0 error，相关测试全过 | 2026-11-15：tsc 0 error；`worldStamps`、`p12b`、`p12a`、`compile/p12b`、`rebuild` 与粒子、回放相关的 14 个文件全过（`probe.renderSize` / `probe.scripts` 的 `spriteSamples` 失败来自别的会话 P13c 未提交的改动）；6 处变异都被抓住 |
| [x] | PB1 语料 | Node，233 个工程 | `74701936^` 与 `74701936` 的快照各扫一遍、`kbp corpus diff` | 去掉的键只有 `object:attachment`、`puppet:alpha` / `morph` / `clipping`，只解锁预期的 6 张，别的场景逐张不变 | 2026-11-15：能渲染 156 → 162（提交时的 226 张口径 151 → 157），新解锁正好 6 张；去掉 `object:attachment` 13 张、`puppet:alpha` 9、`puppet:clipping` 5、`puppet:morph` 3，没有新增的键（四个细分键全语料 0 处）；19 张有变化，其余 214 张整行相同。报告 `ignore/p12/b/corpus2/report.txt` |
| [x] | PB2 生成工程对照 WPE | Windows dev + WPE 抓帧，1920×1080，fps 20，后处理超高 | `p12-am`（透明度与变形的三种叠法）、`p12-att`（挂点含粒子子对象）、`p12-clip`、`p12-clip2`（单条记录、共用遮罩、一条记录多组、遮罩之间夹普通组、合成路径、透明度 + 变形 + 裁切）各录 8 帧，`renderFrames.ts` 逐帧回放比 | 整帧逐像素相同 | 2026-11-15 走查：全部 0 差异。`p12-clip` 的三角形是顺时针，遮罩被缺省背面剔除整片剔掉，目标段全透明，WPE 一样 |
| [x] | PB3 真实壁纸复制工程 | Windows dev + WPE 抓帧，窗口与场景同尺寸 | `kbp content isolate`：`3463520581`、`3829467967`、`2964778792`、`3500648585`、`3491865410`、`3253330537`、`3426865175`，各 6 帧逐帧比、逐 draw 对常量 | 差异逐处有解释 | 2026-11-15 走查：全部 ≤ 2 级，归 waterwaves 的零星舍入与 `rsqrtps`；变形值、透明度、挂点矩阵逐位相同；`3491865410` 两个裁切目标段最终可见的 2256 个像素全部相同；`2964778792` 两帧各 1 个像素 1 级没能定位 |
| [x] | PB4 P12a 不变 | Windows dev + WPE 抓帧 | P12a 的 5 个生成工程与两张复制工程重渲 | 和 P12a 时逐像素相同（puppet 改在粒子之前推进） | 2026-11-15 走查：40 帧仍和旧 WPE 抓帧逐像素相同；两张复制工程和当时我们的帧逐像素相同 |
| [x] | PB5 父被移动时的挂点时机 | Windows dev + WPE 抓帧，1920×1080 | 生成工程 `p12-lag`（16 种组合：挂点 / 不挂点的 puppet、图像、局部 / 世界空间粒子，祖先被脚本、关键帧动画移动，纯分组祖先，子排在父前）与 `3491865410-iso-clipmove` 用同一份抓帧重渲 | `p12-lag` 每个对象的 MVP 与 WPE 逐位相同、整帧逐像素相同；`clipmove` 只剩 ≤ 2 级差 | 2026-11-15：修之前滞后对象差到约 148 像素（B1）。修之后：`p12-lag` 16 个对象 8 帧 MVP 与 WPE 差 0，整帧 8 帧逐像素相同；`clipmove` 每帧 477–1138 个像素、全部 ≤ 2 级，最差一帧归属到 waterwaves 与 `rsqrtps`；父不动的工程（`p12-am` / `p12-att` / `p12-clip2`、P12a 5 个、`3463520581` / `3253330537` / `3491865410-iso-clip`）和修之前逐字节相同 |
| [x] | PB6 解锁场景整张 | Windows dev 屏外宿主 | 6 张解锁的场景开脚本各渲染一帧 | 能画、不支持项为空、没有退回、脚本 `init` 成功 | 2026-11-15：全部通过（修了变形纹理格式、裁切纹理上传、遮罩 pass 的 `g_RenderVar0` 三个 bug 之后）。`3500648585` 的一条脚本告警是作者把拖拽脚本挂在 `visible` 上，不属于 P12 |
| [ ] | PB7 实时预览与桌面 | Windows dev，图库预览与桌面 | 预览并设为桌面壁纸：`3463520581`、`3491865410`、`3253330537`；暂停再继续 | 挂点跟着骨骼动、眼睛的裁切与表情变形正常；暂停时停住 | 只在探针回放里比过，实时播放待用户看 |
| [ ] | PB8 帧时间 | Windows dev | `3463520581`（挂点三层、200 多个子对象）实时播放，看帧时间 | 挂点子树每帧刷新两次，帧时间没有明显上升、没有周期性卡顿 | 没量 |
| [ ] | PB9 非 Windows | macOS / Linux | 预览 `3253330537` | 同 Windows（变形要 `float32-filterable`） | 本机不能测 |

## 场景壁纸模型对象的骨骼与纹理通道（P12b2）

2026-11-15。两项内容：
- 模型对象（P5c）带骨骼、动画、变形、挂点时，复用图像层 puppet 的运行时。模型模式的不同：隐藏时冻结、权重 0 的层跳过、变形按网格且混合钳 [0, 1]、剔除盒取动画包围盒。
- 图像层 puppet 的纹理通道：在合成 RT 里补画通道网格，`g_BlendMap` 由动画轨道驱动、帧首不复位。

WPE 的两处模型变形缺陷不照抄（语料不依赖）。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md`；
- 读码：`ignore/p12/b/rea/texchan-model.txt`；
- 实测与对照：`ignore/p12/b2/meas/`、`check1/`、`check2/`；
- 生成工程定义：`ignore/p12/b2/gen/defs/p12b2.py`；
- 抓帧：`A:\p12\b2\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PC0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、相关 vitest、Prettier | 0 error，相关测试全过 | 2026-11-15：tsc 0 error；`puppet/model.test.ts`、`puppet/texchan.test.ts`、`compile/p12b2*.test.ts` 按 WPE 抓帧常量逐位回放，相关文件全过（`probe.*` 的 `spriteSamples` 失败在 HEAD 上就有，`p5c` 的 `castshadow` 一例来自 P13d 未提交的改动）；变异 10 处全部被抓住 |
| [x] | PC1 语料 | Node | 编译 `3706286085`、`3811424158`、`3662790108` | 只去掉对应的键 | `3706286085` 只剩 P13 的雾与阴影、`object:parent`、`puppet:layer-script`；`3811424158` 只剩 `combo:SPRITESHEET`、`tex:animation`；不解锁场景 |
| [x] | PC2 模型骨骼对照 WPE | Windows dev + WPE 抓帧，1920×1080，fps 20，后处理超高 | 生成工程 `p12b2-mdl`、`mdl2`、`vis`、`att`、`cull`、`rest`、`deimos`、`morph` 按日志回放，逐帧逐像素、逐 draw 比 | 整帧逐像素相同；`morph` 只在两处有意不同的 draw 上不同 | 2026-11-15：前 7 个整帧逐像素相同（`vis` 30 帧，含重新可见的第一帧）；`morph` 只差 3 个 draw，数值是正确做法（偏移 [2, 8, 16]，WPE [2, 4, 8]；缩放与权重按真实网格） |
| [x] | PC3 真实壁纸复制工程 | Windows dev + WPE 抓帧 | `3706286085` 只留模型，雾与阴影关闭、脚本字段换固定值 | 骨骼矩阵逐位相同 | 2026-11-15：61 个带骨骼的 draw 矩阵逐位相同，`g_Bones` 在 K2 量级；画面差来自 `generic4` 的 emissive 遮罩（F1，不属 P12b2，已转 P7） |
| [x] | PC4 纹理通道对照 WPE | Windows dev + WPE 抓帧 | `p12b2-tc` 按日志回放，逐帧逐像素比，读回合成 RT；`3811424158` 的 `01_z` 复制工程 | 整帧逐像素相同或只剩着色器舍入 1 级；`01_z` 的通道 draw 存在、`g_BlendMap` 全 0、合成 RT 不变 | 2026-11-15（`check2`）：`p12b2-tc` 8 帧整帧逐像素相同；10 个 puppet 的 `g_BlendMap`（含加法层的累加值）、通道 draw 的 MVP 与 `g_Color4` 逐位相同；合成 RT 在基础 pass 后、通道 pass 后都 0 差。`01_z`：通道 draw 存在、`g_BlendMap` 全 0、合成 RT 前后不变，同 WPE；合成 RT 是整张精灵表大小而 WPE 是单帧，属精灵表还没支持的连带 |
| [x] | PC5 P12a / P12b1 不变 | Windows dev | P12a、P12b1 与 P12b2-1 的生成工程各重渲 2 帧 | 和之前我们的帧逐字节相同 | 2026-11-15：P12b2-1 之后（`check1`）与 P12b2-2 之后（`check2`：`p12b2-mdl` / `morph` / `att`、`p12-modes` / `fx` / `am` / `clip2`）都逐字节相同 |
| [x] | PC6 实时预览 | Windows dev，图库预览 | `3706286085`（强制渲染）看 Sonic 跑动 | 骨骼动画流畅，BoostModel 的加法层动画正常 | 2026-11-15 用户看过：「我看可以」。强制渲染下没有雾，动画层脚本用的是 JSON 初值，手套鞋的 emissive 见 F1 |
| [ ] | PC7 非 Windows | macOS / Linux | 同 PC6 | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 动画层的脚本 API（P12c）

2026-11-15。脚本能拿到 puppet（图像层与带骨骼的模型）的动画层并控制它：
- `getAnimationLayerCount` / `getAnimationLayer`、`IAnimationLayer` 的全部成员；
- 动画层字段（`rate` / `blend` / `visible`）上的脚本；
- `addEndedCallback`、MDLA 事件派发给 `animationEvent`；
- 首次加载时在 `init` 之前建好 puppet 运行时。

另外设备按适配器支持的最大值申请二维纹理上限（F2，WebGPU 缺省 8192，WPE 16384）。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12c-script.md`；
- 读码：`rea-p12-attach-physics.md` 第 4 节、`rea-p12c-script.md`；
- 语料与对照：`ignore/p12/c/corpus/`、`ignore/p12/c/check/`；
- 抓帧：`A:\p12\p12-script-fps20-1856x1044\`、`A:\p12c\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PD0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc 与相关 vitest | 0 error，相关测试全过 | 2026-11-15：tsc 0 error；`puppet`、`script`、`compile/p12c` 等 48 个文件全过；`puppet/p12script.test.ts` 按 WPE 日志回放 266 帧、642 行逐行相同，`g_Bones` 在 `rsqrtps` 容差内；变异两轮共 32 个，单测可覆盖的全部杀死（宿主两处由 PD4 真机验） |
| [x] | PD1 语料 | Node | `kbp corpus scan` 工作区快照对 HEAD | 只去掉 P12c 的键，没有场景变成退回 | 2026-11-15：`getAnimationLayer` 10 张、`puppet:layer-script` 8 张、`getAnimationLayerCount` 3 张全部消失；`clean_lost` 0；233 张口径解锁 `3346715292`、`3361965869`、`3492627662`、`3830665420`（后者靠 F2） |
| [x] | PD2 `p12-script` 对照 WPE | Windows dev + WPE 抓帧，1856×1044，fps 20 | dev 按 WPE 帧时间回放到第 201 帧、跑脚本，整帧比 | 最大差 ≤ 2 级 | 2026-11-15：最大差 1 级（边缘 0.23%，`rsqrtps`）；5 段脚本 0 出错，字段脚本收到事件，播完回调照常 |
| [x] | PD3 解锁场景对照 WPE | Windows dev + WPE 抓帧，1920×1080，fps 20，后处理超高 | 四张 `content unpack --instrument` 复制工程，回放到 WPE 抓到的那一帧，比 puppet 的 `g_Bones` 与整帧 | `g_Bones` 只差 `rsqrtps`（平移分量 ≈ 1e-5），脚本报错与 WPE 相同 | 2026-11-15：`3346715292` / `3492627662` / `3830665420` 全部对上，超出 P12a 容差的都在平移分量；`3346715292` 两边都是 6 段 `init` 因缺 NSL 抛错；`3361965869` 点击才播的两个 puppet 逐位相同，另两个 `rate` 跟系统声音，不能确定性对照；整帧差在光束、音频条、时钟文字、粒子 |
| [x] | PD4 宿主帧循环与 `init` 落点 | Windows dev，图库预览 | `p12-script` 实时预览看事件与回调计数；`3492627662` 开场看各层帧号（`host.puppets()`） | 事件、回调照常派发；`init` 的 `setFrame` 生效 | 2026-11-15：6 秒内事件 10 次、播完回调 19 次、0 出错；`3492627662` 开场 1.85 s 时同一 puppet 三层帧号 55.42 / 43.42 / 24.22，偏移来自 `init` |
| [x] | PD5 P12a / P12b 不变 | Windows dev | P12a / P12b1 / P12b2 的 8 个生成工程重渲 22 帧（P12c 之后、F2 之后各一次） | 和之前我们的帧逐字节相同 | 2026-11-15：两次都逐字节相同 |
| [ ] | PD6 点击播放 | Windows dev，图库预览 | `3361965869`（或别的 `cursorClick` 里 `getAnimationLayer("dianji").play()` 的场景）点人物下方的圆环 | 下一帧开始播放点击动画；对象 5「鼓点光环」点击时控制台有一条 `TypeError`（层名是 222，WPE 同样） | 需要人点 |
| [ ] | PD7 非 Windows | macOS / Linux | 同 PD4、PD6 | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 骨骼物理与骨骼脚本 API（P12d）

2026-11-15。两项内容：
- 图像层 puppet 的骨骼物理：骨骼 JSON `(r‖t) && (se‖re)` 才开，每帧在父链里逐根求解，图层世界矩阵由宿主交进来；
- 图像层上的 `getBoneCount` / `getBoneTransform` / `setBoneTransform` / `applyBonePhysicsImpulse` / `resetBonePhysicsSimulation`。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12d-physics.md`；
- 读码：`rea-p12-attach-physics.md` 第 2 节、`rea-p12d-bones.md`；
- 实测与对照：`ignore/p12/out/`（物理）、`ignore/p12/d/`（`p12-bones`、语料、对照）；
- 抓帧：`A:\p12\`、`A:\p12d\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PE0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc 与相关 vitest | 0 error，相关测试全过 | 2026-11-15：tsc 0 error，P12 相关 56 个文件全过；物理夹具对 WPE 在 python 模型量级以内（多数逐位）；`p12-bones` 脚本日志与 `g_Bones` 与 WPE 逐位相同；变异 P12d-1 21 个、P12d-2 8 个，除两个等价变异外全部杀死 |
| [x] | PE1 语料 | Node | `kbp corpus scan` 工作区快照对 HEAD | 只去掉 P12d 的键，没有场景变成退回 | 2026-11-15：233 张能渲染 182 → 185，解锁 `2345214324`、`3359451610`、`3426865175`；去掉的只有 `puppet:physics` 与 4 个骨骼方法的键 |
| [x] | PE2 物理整帧对照 WPE | Windows dev + WPE 抓帧 | `p12-phys2`、`2345214324`、`3426865175` 复制工程按 WPE 帧时间回放，比 `g_Bones` 与整帧 | `g_Bones` 在误差包络内，画面差 ≤ 2 级 | 2026-11-15：`p12-phys2` 第 200 帧最大 1 级；`2345214324` 第 220 帧只有 5 个像素差、最大 2 级；`3426865175` 第 192 帧带物理的「苍月草2」`g_Bones` 与 WPE 逐位相同，整帧差在随机粒子、泛光与文字上。`p12-phys` 的日志里有两次运行、时间线解析不了，由夹具逐帧覆盖 |
| [ ] | PE3 拖动骨骼 | Windows dev，图库预览 | `3359451610`：在角色上按下拖动再松手 | 被拖的部位跟手，松手后弹回 | 需要人拖 |
| [x] | PE4 P12a–c 不变 | Windows dev | P12 的 8 个生成工程重渲 22 帧 | 和之前逐字节相同 | 2026-11-15：22 帧逐字节相同 |
| [ ] | PE5 非 Windows | macOS / Linux | 同 PE3 | 同 Windows | 本机不能测 |

## 场景 dev 探针按指定尺寸渲染

2026-11-14。dev 探针 `renderFrame` 给了 `canvas` 时，正交场景按这个尺寸直接画，和 WPE 测试窗口同一种画法：样式照 WPE 的对齐方式做进正交投影的四个裁切边距，`fit` / `center` 整屏清成 `schemecolor`，读回场景目标本身。`renderMode: "scene"` 取旧的「场景分辨率 + 读回时铺进画布」。产品的预览、桌面、应用背景都不变（用户定）。计划与记录见 `.claude/plans/wpe-import/3-scene/phase-render-size.md`，读码 `rea-render-size.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | RS1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、vitest（设 `KABEGAME_WPE_ROOT`），kabegame-dev 与 MCP 的 deno 测试，Prettier | 0 error、全过 | 2026-11-14：tsc 0 error；vitest 168 个文件 3941 条全过；deno 55 个全过。新增 `render/renderSize.test.ts`（含 15 段 MVP 对 WPE 抓帧逐位相同、`GpuScene` 假设备的目标尺寸与清屏色）、`dev/probe.renderSize.test.ts` |
| [x] | RS2 生成工程和 WPE 逐像素比 | Windows dev 屏外宿主 + WPE 测试窗口，ultra、fps 20 | `ignore/prs` 的 `prs-grid` / `prs-small` / `prs-fx`，窗口 1920×1080、1280×720、1920×800、1440×1080 × 对齐方式 0–3（`apply_properties` 设 `alignment`），`python -X utf8 -I ignore/prs/cmp_target.py` | 遮掉帧号 / 时钟两层后逐像素相同 | 2026-11-14：18 段全部相同（`prs-fx` 两段的残差是帧号 / 时钟两层被泛光晕开，遮罩外扩 80 像素后为 0）。改动前的画法在 `prs-fx` 1280×720 下差 61684 个像素、最大 110 |
| [x] | RS3 旧路径字节不变 | Windows dev 屏外宿主 | `renderMode: "scene"`（3 段带画布）与不给画布（1 段）和改动前记的读回逐像素比（`ignore/prs/scene_mode_check.py`）；产品路径 `hash_baseline` 前后比 | 相同 | 2026-11-14：4 段逐像素相同、sha256 相同。产品路径 10 张里 beach、deep_space、razer_vortex 的哈希变了，来自同期别的会话改的纹理采样器（P12a 的 B1，`textures.ts` 12:37Z，晚于基线）：这 3 张都有「单级 mip + 8 倍各向异性」的绑定，eagleflag 没有、没变；产品路径不走本次新代码 |
| [x] | RS4 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate` | 8 处（铺满 / 装下的分支、居中的差、`orthoWpe` 的平移、`schemecolor` 规则、目标宽高、主目标清屏色、光标窗口），清单 `ignore/prs/mutations.py` | 全部检出，快照还原 | 2026-11-14：8 / 8 |
| [x] | RS5 dev 重启后的工具参数 | Windows dev | 重启 dev 与会话后，`render_scene` / `host_render` 带 `style`、`renderMode`，`renderFrames.ts --style` | 和经宿主求值调探针的结果相同；旧探针时 409 | 2026-11-14（dev 22:48 重启后）：`render_scene` 的 `style: "fit"`、`renderMode: "scene"` 与 `renderFrames.ts --style center` 三段，和步骤 1 经宿主求值得到的图文件 sha256 相同；错误组合在本地拒绝。409 没法现场造（要换回旧产物），只有单测 |
| [x] | RS6 重跑各节的「按窗口分辨率画」样本 | Windows dev + WPE 抓帧 | phase-render-size.md「0c」的清单 | 能逐像素相同的从已知差异里删掉 | 2026-11-14（步骤 2）：用当时的录制按窗口尺寸重跑 13 节。逐像素相同的：P10a `intro`（7680×2160）、`rings`、`post`，P5d 三个相机，P6b `3429-text`、`2391389126` 文字区域、`e3clock` 三份，P6c `clockv` 1080p，P10b 两张时钟 24 帧与 `2887099508` 书页 5 帧，P11a Liberty 4 帧，P12a `3203778110` 6 帧中 5 帧。其余剩 ±1–4 的都另有解释：求逆写法（`sun`、`tmpl2`，`invertF32` 复现 WPE）、着色器舍入（`gradt`、`frostp` 已定位到单次绘制）、`rsqrtps`、8 位反馈 RT、JPEG 色度上采样。P5a 真实样本、P7 流体画布、P9a 视频、P2 超宽场景没重跑（原因见计划）。`WPE_SCENE.md` 各节已知差异已按结果改写 |

## 场景壁纸：uniform 的逆矩阵照 WPE 用单精度

2026-11-15。内置 uniform 的逆矩阵（`g_*Inverse`）改用照 WPE `FUN_14005f730` 搬运的 `uniformInverse`（`render/inverseF32.ts`），粒子拖尾的眼位同步；奇异时仍是单位阵。计划与记录见 `.claude/plans/wpe-import/3-scene/phase-f32-inverse.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | FI1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、`uniformInverse.test.ts` 与读逆矩阵的测试 | 0 error、全过 | 2026-11-15：tsc 0 error；夹具 4 个 WPE 样本 `uniformInverse` 逐位相同、`invert` 都不同；`p8.test.ts`、`particles.test.ts` 单位阵逆的断言改成 WPE 的 −0 |
| [x] | FI2 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate` | 五处调用方各改回 `invert`、去掉奇异兜底 | 都被单测抓到 | 2026-11-15：6 / 6（`ignore/prs/inv/mutations.py`） |
| [x] | FI3 画面哈希 | Windows dev 屏外宿主 | `hash_baseline` 10 张 × 3 档，改动前后比 | 不读逆矩阵的场景不变 | 2026-11-15：30 组全部相同 |
| [x] | FI4 和 WPE 比 | Windows dev + 已有的 WPE 抓帧 | 重跑 `sun`、`whale`（P10a）、`tmpl2` 四组（P5d）、`3822495444`（P7c）、`3498150384`（P13a）的按窗口尺寸对照 | 读逆矩阵的常量和 WPE 逐位相同；反馈 RT 的差异缩小 | 2026-11-15：`sun` 光晕那次绘制 14 个常量全部相同，但像素差和改前一样（归着色器舍入）；`tmpl2`、`whale`、`3822495444` 不变；P13a 229、230 帧逐像素相同、其余帧最大差 4 → 1，只把求逆换回 double 就回到原来的数字 |
| [x] | FI5 实时预览 | Windows dev，图库预览 | 预览 `3498150384`（鼠标波纹），在画面上拖动 | 波纹正常，没有闪烁或发散 | 只做了屏外回放 |

## 壁纸 iframe 的原生鼠标注入（图库预览与桌面）

2026-11-15 第二版。网页壁纸与场景宿主的 iframe 自己向 `tauri-plugin-cursor` 登记（`attach_frame`），插件轮询全局光标，经 CEF 补丁 11 把原生鼠标事件直接注入那个 frame。
- 光标在 frame 外时，钳到「frame 中心到光标的连线」与边界的交点。
- 点击规则按窗口：预览要求光标下是本窗口，桌面要求光标下是桌面。
- 预览画布盖一层只拦截、不转发的覆盖层；iframe 不收真实鼠标；点过壁纸后，真实左键松开时把焦点还给父页面。
- Linux 退回 iframe 直接收真实鼠标。
- 删掉了第一版的 JS 转发（`kabegame:wpe-pointer`、垫片合成事件）、桌面的 `input_forward.rs` 与运行时的整窗注入。

计划与记录见 `.claude/plans/wpe-import/phase-preview-pointer.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PN1 单测与检查 | Windows（dev 停着） | `cargo test -p tauri-plugin-cursor`；`frame_mouse.rs` 用 rustc 单独编成测试跑；`src/components/wallpaper` 下相关 6 个 vitest 文件；`check-kabegame`；Prettier、`cargo fmt` | 0 error、全过 | 2026-11-15 Claude：插件 17 条、钳制 7 条、vitest 82 条全过；`check-kabegame` 0 error；运行时 crate 的测试要现编 CEF 包装库（环境不齐），钳制规则不依赖 CEF，所以单独编 |
| [x] | PN2 Rust 变异检查 | rustc + cargo，按原字节还原 | 钳制取逐轴最近点、不向内收；frame 外的按下也注入、没按下也发抬起、收尾不补；插件按下不要求在窗口内、两种规则对调、丢弃订阅不发收尾、登记时已按着算按下 | 全部检出 | 2026-11-15 Claude：9 / 9 |
| [x] | PN3 前端变异检查 | vitest，按原字节还原 | 垫片暂停时也登记、调用不排队；Stage 消息不带 `interactive`；场景视图 `interactive` 变了不推；焦点按着也还、松开后不等；画布没有覆盖层；注入时 iframe 也收真实鼠标 | 全部检出 | 2026-11-15 Claude：8 / 8 |
| [x] | PN4 新 CEF 构建 | Windows，MSYS2 + VS | 带补丁 11 跑 `deno task build:chromium`，再用新 CEF 启动 dev | 编过；`_cef_frame_t` 是 272 字节（运行时不报「libcef 不带 frame 鼠标注入」） | 2026-11-15 用户编好、重启 dev；日志没有「libcef 不带」，注入生效（见 PN6、PN7）。每个新登记的 frame 第一次采样都换算失败（frame 还没合成），之后正常；2026-11-15 改成连续失败 30 次才记 warn（见 PN13） |
| [ ] | PN5 旧 libcef | Windows dev，没有补丁 11 的 CEF | 打开预览里的网页 / 场景壁纸、桌面设网页壁纸 | 不崩，日志只有一条「libcef 不带 frame 鼠标注入」，壁纸收不到鼠标 | 没测到：dev 重启时已换上新 CEF |
| [ ] | PN6 桌面跟随与点击 | Windows，窗口模式 | 桌面设一张跟随鼠标的网页壁纸、一张 P6c 场景（光标回调）；在桌面上移动、点空白处与图标、点别的窗口；光标移到别的窗口上、别的显示器上 | 跟随与点击正常，`isTrusted` 为真；点别的窗口不进页面；光标在窗口外时效果停在画面边缘 | 2026-11-15 Claude：桌面场景宿主（14297）里临时挂计数 8 s，收到 218 个 `pointermove`、全部可信；点击没测（要在桌面上点） |
| [ ] | PN7 预览里画面外跟随 | Windows dev，图库预览 | 预览开了视差或有跟随鼠标粒子的场景，光标移到留白、详情栏、应用窗口外 | 景物继续跟随，停在画面边缘，移回画面没有跳变 | 2026-11-15 Claude：用户开着的预览（13617）里临时挂计数 8 s，收到 3 个可信 `pointermove`，`x` 都是 2559.5（宽 2560，钳在右边界内收半个像素处）；画面效果要用户看 |
| [ ] | PN8 预览里的点击、拖动、菜单与键盘 | Windows dev，图库预览 | P6c 测试工程上点击、按住拖出画面再松开；留白处点击；右键；鼠标移到两侧；点过壁纸后按 Esc、方向键 | 点击触发光标回调；拖动中途不断（按下到松开之间没有提前的抬起），拖出后松开照样收到抬起；留白处点击不进页面；右键弹预览菜单；两侧出现翻页箭头；Esc、方向键照常 | 待新 CEF，要打开预览，由用户勾 |
| [ ] | PN9 预览里的网页壁纸 | Windows dev，图库预览 | 预览跟随鼠标的网页壁纸，悬停按钮、点按钮、拖页面里的原生滑块 | 悬停样式显示，点击生效；滑块能不能拖记下来（移动不带按键标志，同 WPE） | 待新 CEF，要打开预览，由用户勾 |
| [ ] | PN10 暂停与应用背景 | Windows dev | 预览里暂停后移动、点击，再恢复；同一张设为应用背景 | 暂停期间不跟随、不点，恢复后照常；应用背景不收鼠标 | 待新 CEF |
| [ ] | PN11 macOS | macOS | 桌面与预览同 PN6–PN8 | 同 Windows | 本机不能测；插件的 `over_window` 是新写的（`TODO:[WPE_SCENE]`） |
| [ ] | PN12 Linux | Linux | 预览里网页 / 场景壁纸 | 和改动前一样：光标在壁纸上时跟随、点击生效，画面外不跟随 | 本机不能测（`TODO:[WPE_SCENE]`） |
| [x] | PN13 换算失败不误报 | Windows dev | dev 重启后打开 / 切换几张网页与场景壁纸的预览，桌面壁纸照常 | 日志里不再出现「frame 坐标…换算失败」的 warn，鼠标照常注入；单测与变异（成功不清零、第一次就 warn、每次都 warn）全部检出 | 2026-11-15 Claude：单测 1 条、变异 3 / 3；dev 重启后桌面与预览两个宿主都登记了，日志没有这条 warn，桌面宿主 6 s 收到 266 个可信 `pointermove` |
| [x] | PN14 macOS 预览的鼠标位置 | macOS dev，主窗口带原生标题栏，图库预览 | 预览一张跟随鼠标的网页 / 场景壁纸，光标放在画面里某个明显的点上（如按钮、图层边缘），上下移动 | 命中点与光标重合，不再偏下一个标题栏高度（32pt）；桌面壁纸窗口（无标题栏）不受影响 | 2026-11-16 Claude：`outerHeight - innerHeight` = 32 证实偏差来源；`cargo test -p tauri-plugin-cursor` 19 条全过（新增标题栏内缩换算）；2026-11-16 用户真机确认命中点与光标重合 |
| [x] | PN15 macOS 拖动窗口时的鼠标位置 | 同 PN14 | 预览开着时拖动主窗口标题栏、拖边缘缩放窗口，拖动中与松手后都把光标放到画面上看 | 落点始终跟着光标，不再停在拖动前的位置、等约 1 秒才跟上 | 2026-11-16 Claude：单窗口 `kCGWindowBounds` 查询实测约 114 µs / 次，每轮现查；2026-11-16 用户真机确认拖动、缩放中落点跟手 |

## macOS 系统音频回环（Core Audio 进程 tap）

2026-11-16。网页与场景壁纸的音频订阅在 macOS 上有了数据源：`wpe_media` 的音频回环拆成共用的推帧循环（`audio/mod.rs`）与平台后端，Windows 原 WASAPI 实现移到 `audio/wasapi.rs`（只搬移，逻辑不变），macOS 新增 `audio/process_tap.rs`（14.2+，全局立体声 tap 挂进只放 tap 的私有聚合设备）。订阅命令改按 `kind_available` 放行：audio 在 Windows / macOS，media 仍只在 Windows。`NSAudioCaptureUsageDescription` 写进 `src-tauri/kabegame/Info.plist`（打包合并）与 `macos/embedded-Info.plist`（dev）。

同一轮排查的「预览里场景没声音」不是代码问题：dev 数据目录里的壁纸音量被存成了 0（后端默认 1.0），场景排期器在音量为 0 时不开始播放；调到 0.5 后 9196 的背景音乐正常播放（AudioContext `running`，曲目时间前进）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | MA1 单测与检查 | macOS | `check-kabegame --skip vue`；`test-kabegame kabegame --lib wpe_media` | 0 error；全过 | 2026-11-16 Claude：cargo check 0 error、新文件无告警；39 条全过（新增 tap 布局 5 条：只收 32 位浮点、交错取末尾缓冲、非交错取末尾几个平面交错、满了整段丢且不扩容、声道数不符忽略；`spectrum` / `wpe_spectrum` 的用例在 macOS 上第一次跑） |
| [x] | MA2 场景频谱随声音变化 | macOS 26.6 dev，图库预览场景 9196（壁纸音量 0.5，场景自带背景音乐在放） | 看日志；探针 `host.audio()` 隔 300 ms 读 6 次 | 日志有「网页壁纸音频回环已打开 sample_rate=48000 channels=2」；`raw` 非零、`peak` 随音乐变化、帧数约 30 帧/秒 | 2026-11-16 Claude：回环已打开；`peak` 0.60–1.88 起伏，帧数每 300 ms +9；说明授权已放行（dev 由 VS Code 终端拉起，权限记在 VS Code 名下） |
| [x] | MA3 订阅离开即停 | 同 MA2 | 预览里从带音频的场景切到别的壁纸 | 日志「网页壁纸音频采集已停止」，聚合设备随之拆掉 | 2026-11-16 Claude：日志 01:26:54 释放订阅后紧接「已停止」，切到下一张带音频的场景又重新打开 |
| [ ] | MA4 网页壁纸的音频回调 | macOS dev | 预览一张声明 `supportsaudioprocessing` 的网页壁纸（频谱条类），放音乐 | 频谱条随音乐动，停止后逐帧回落到 0 | 待用户 |
| [ ] | MA5 首次授权与拒绝 | macOS release 包（新装、未授权） | 第一次预览带音频的壁纸；在系统设置里关掉 Kabegame 的「仅系统录音」后再看 | 弹「录制系统音频」授权，文案为 Info.plist 的说明；关掉后频谱保持 0、不报错 | 待打包后测；dev 下权限记在 VS Code 名下，测不出 |
| [ ] | MA6 换默认输出设备 | macOS dev | 放音乐时插拔耳机或在控制中心切换输出 | 约 1 秒内重开回环，频谱继续动；采样率变了也正常 | 待用户 |
| [ ] | MA7 macOS 14.2 以下 | macOS 13 / 14.1 | 预览带音频的壁纸 | 不崩，日志一条「打开音频回环失败…需要 macOS 14.2」，频谱保持 0 | 本机是 26.6，没法测 |
| [ ] | MA8 Windows 不回归 | Windows dev | `check-kabegame`；预览带音频的网页 / 场景壁纸 | 编过；频谱照常随音乐变化 | 本机没有 Windows 目标，`wasapi.rs` 的搬移没在 Windows 上编译过 |

## 预览翻页只认箭头

2026-11-15。图库预览两侧各 20% 的区域原来整条可点（箭头显示时点哪都切图），改成区域只管摆放与显隐、本身不拦鼠标，只有点箭头才切图；区域里别处的点击落到下面的图片（拖动）或壁纸上。幻灯片按钮不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | NA1 单测与检查 | Windows | `ImagePreviewDialog.events.test.ts`（新增「只有点箭头才切图」）、vue-tsc、Prettier；变异：把点击挪回区域上 | 全过；变异被抓住 | 2026-11-15 Claude：10 条全过，变异 1 / 1 |
| [x] | NA2 图片 | Windows dev，图库预览 | 鼠标移到右侧 1/5，点箭头；点箭头上下的空白处；在右侧拖动放大后的图片 | 点箭头切到下一张；点空白处不切；能拖动 | 待用户 |
| [x] | NA3 壁纸 | Windows dev，图库预览 | 预览网页 / 场景壁纸，在两侧 1/5 里点画面 | 不切图，点击传进壁纸；点箭头照常切图 | 待用户 |
| [x] | NA4 幻灯片 | Windows dev，图库预览 | 点箭头下面的幻灯片按钮，再点一次停 | 开始 / 停止播放，不额外切一张 | 待用户 |

## 预览里的网页 / 场景壁纸放大

2026-11-15。图库预览里的网页与场景壁纸和图片共用一个 Panzoom：工具条（−、+、滑块、全屏）、Ctrl+滚轮缩放、单独滚轮在放大后平移，抽屉 / 全屏 / 切图时复位；工具条不再平铺右键菜单项。覆盖层抽成 `WallpaperPointerOverlay`、放在变换层之外，由它决定平移：左键与中键拖动平移，Ctrl+左键不平移（留给壁纸），拖动中途松开 Ctrl 接着平移。场景上报的显示缩放按 `sceneDisplayScale` 封顶（跟着放大、到布局 × DPR 为止）。设封面不复位，截看得见的那一块（与可见区域求交）。计划见 `.claude/plans/wpe-import/phase-preview-zoom.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PZ1 单测与检查 | Windows | `usePanzoomPreview`、`WallpaperPointerOverlay`、`WallpaperPreviewCanvas`、`wpeSceneStyle`、`WpeSceneView`、`ImagePreviewDialog.events` 六个 vitest 文件；vue-tsc；Prettier | 全过、0 error | 2026-11-15 Claude：82 条全过；vue-tsc 0 error |
| [x] | PZ2 变异 | Windows | 公式去掉封顶、`startPan` 不看 `canPan`、覆盖层不看 Ctrl、移动时不重新判断 Ctrl、中键不阻止默认、截取不求交、滚轮跳过壁纸、换壁纸不复位、放大倍数变了不补量 | 都被单测抓到 | 2026-11-15 Claude：9 / 9，源文件按原字节还原 |
| [x] | PZ3 缩放 | Windows dev，图库预览 | 网页、场景壁纸各一张：Ctrl+滚轮、工具条 −、+、拖滑块；单独滚轮 | Ctrl+滚轮与工具条缩放，百分比跟着变；单独滚轮不缩放，放大后平移 | 待用户 |
| [x] | PZ4 平移 | Windows dev，图库预览 | 放大后左键拖、中键拖；按住 Ctrl 左键拖；Ctrl+左键拖到一半松开 Ctrl、再按下 | 左键、中键都平移；Ctrl+左键只和壁纸交互、画面不动；中途松开 Ctrl 从当时的位置接着平移，再按下停；中键按下没有自动滚动图标；拖得动时光标是手形 | 待用户 |
| [x] | PZ5 放大后的交互与清晰度 | Windows dev，图库预览 | 放大后在壁纸上移动、点击；场景放大 2 倍、5 倍 | 跟随与点击落在光标下的位置；场景画面随放大变清楚，放大到画布到 1 之后不再变；`app_log` 没有新告警 | 2026-11-15 用户操作、Claude 读数（场景 14289，布局 3840×2160，DPR 1.5）：100% / 205% / 305% / 1000% 时宿主画布 1179×663 / 2417×1360 / 3596×2023 / 5760×3240，都等于「布局 × DPR × `sceneDisplayScale`」，1000% 封顶在布局 × DPR（不封顶会是 11790 宽）。跟随与点击待用户 |
| [x] | PZ6 设封面 | Windows dev，图库预览 | 打开详情侧栏、放大并平移到一角，右键「设为壁纸封面」 | 封面是看得见的那一块，不带侧栏、不复位缩放；没放大时和以前一样是整张 | 待用户 |
| [x] | PZ12 封面不截进右键菜单 | Windows dev，图库预览 | 在画面中间右键，菜单盖在壁纸上时点「设为壁纸封面」，多试几次 | 封面里没有菜单（也没有淡出中的残影） | 菜单点完要淡出 100 ms，截图只等两帧；现在截图期间把全部弹出层（`[data-reka-popper-content-wrapper]`）藏起来。2026-11-15 Claude：主窗口样式表里已有这条规则；截图本身待用户 |
| [x] | PZ7 复位 | Windows dev，图库预览 | 放大后切到下一张壁纸 / 图片、开关侧栏、拖宽侧栏、全屏 | 都回到不放大 | 待用户 |
| [x] | PZ8 工具条与右键菜单 | Windows dev，图库预览 | 看网页 / 场景壁纸的工具条；右键菜单里暂停、设为壁纸封面、清空脚本存储（场景） | 工具条和图片一样（缩放组 + 全屏）；菜单项照常可用、置灰规则不变 | 待用户 |
| [x] | PZ9 网页壁纸清晰度 | Windows dev，图库预览 | 网页壁纸放大 3 倍以上 | 文字与图片按放大重新栅格化；页面自己的 canvas（WebGL）被拉伸变糊（已知） | 待用户，看完记进 WPE_IMPORT「预览放大」 |
| [ ] | PZ10 macOS | macOS | 同 PZ3–PZ6 | 同 Windows | 本机不能测 |
| [ ] | PZ11 Linux | Linux | 预览网页 / 场景壁纸 | 工具条缩放可用；壁纸上的滚轮与拖动进了 iframe（没有覆盖层，`TODO:[WPE_SCENE]`），留白处左键拖动平移 | 本机不能测 |

## 预览里的视频放大

2026-11-15。图库预览里的视频（普通视频与 `x-wpe/video` 视频壁纸）接上图片、网页 / 场景壁纸共用的 Panzoom：Ctrl+滚轮缩放、单独滚轮在放大后平移，抽屉 / 全屏 / 切图时复位，放大后关掉原生拖出。视频控制条在音量与全屏之间加缩放按钮（没放大时是放大镜、放大后显示百分比，悬停出竖向滑块，点按钮回到 100%）。放大后拖动松开时的点击在 Panzoom 层的捕获阶段拦掉（不暂停），原地单击照常；去掉双击全屏。视频就绪（`canplay`）不复位。计划见 `.claude/plans/wpe-import/phase-preview-video-zoom.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | VZ1 单测与检查 | Windows | `usePanzoomPreview`、`VideoControls`、`ImagePreviewDialog.events` 三个 vitest 文件；vue-tsc；Prettier | 全过、0 error | 2026-11-15 Claude：35 条全过；vue-tsc 0 error；Prettier 通过 |
| [x] | VZ2 变异 | Windows | 拦点击不看距离、不看按下时拖不拖得动、拦过之后不清按下点、换层时不摘点击监听；滚轮跳过视频、换视频不复位、视频就绪时复位、视频不关原生拖出；按钮不发 `zoom-reset`、`keepVisible` 不含缩放拖动、文档级 mouseup 不收缩放拖动、百分比不取整、恢复双击全屏 | 都被单测抓到 | 2026-11-15 Claude：13 / 13，源文件按原字节还原 |
| [x] | VZ3 缩放 | Windows dev，图库预览 | 普通视频、视频壁纸各一个：鼠标停在控制条的缩放按钮上（音量与全屏之间，没放大时是放大镜），拖弹出的竖向滑块；Ctrl+滚轮；放大后点同一个按钮（这时它显示百分比，如「337%」，没有放大镜）；单独滚轮 | 滑块与 Ctrl+滚轮缩放，按钮上的百分比跟着变，回到 100% 时变回放大镜；点按钮回到 100%；单独滚轮不缩放，放大后平移 | 2026-11-15 用户手测通过 |
| [x] | VZ4 拖动与点击 | Windows dev，图库预览 | 放大后左键拖动再松开；原地单击；双击；中键拖动 | 拖动平移、松开不暂停；单击切播放 / 暂停；双击不全屏（播放状态切两次回到原样）；中键拖动平移，没有自动滚动图标 | 2026-11-15 用户手测通过（中键没有自动滚动图标） |
| [x] | VZ5 复位 | Windows dev，图库预览 | 放大后拖进度条、等视频循环回到开头；切到下一个视频 / 图片、开关侧栏、全屏 | 拖进度条与循环时保持放大；切图、侧栏、全屏时回到不放大 | 2026-11-15 用户手测通过 |
| [x] | VZ6 清晰度 | Windows dev，图库预览 | 4K 视频放大 3 倍以上 | 看得清源像素，不糊成低分辨率 | 2026-11-15 用户手测通过 |
| [x] | VZ7 控制条显隐 | Windows dev，图库预览 | 拖缩放滑块时把光标拖出控制条；鼠标停在放大按钮或滑块面板上 | 拖动中与面板展开期间控制条不自动隐藏；离开后照常隐藏；音量面板照旧 | 2026-11-15 用户手测通过 |
| [ ] | VZ8 macOS / Linux | macOS、Linux | 同 VZ3–VZ5 | 同 Windows | 本机不能测 |

## 场景壁纸：单采样 A2C 的阈值（P13d 附带）

2026-11-15。`alphatocoverage` 的丢弃条件从 `!(a > 0.5)` 改成 `!(a >= 0.500244140625)`（`render/programs.ts` 的 `A2C_THRESHOLD`），主 pass 与之后的阴影投射者共用。WPE 的实测与推理见 `.claude/plans/wpe-import/3-scene/phase13/p13-REPORT.md`「单采样 A2C 的阈值」；测试工程 `ignore/p13/proj/p13d-a2cth*`（`ignore/p13/d/gen_d10.py`），抓帧 `A:\p13d\a2cth*\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | AT1 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、`p8.test.ts` | 0 error、全过 | 2026-11-15：tsc 0 error，`p8.test.ts` 96 个全过（A2C 入口的期望改成新阈值） |
| [x] | AT2 WPE 阈值 | WPE 抓帧，1920×1080 | 自写着色器输出 alpha = 0.5 + d，d 逐段细分到 2⁻²² | 找到画与不画的分界 | 2026-11-15：0.5 + 2⁻¹² 画，再小 2⁻²² 不画，段内整片一致；格子边界上的双线性过滤值是 0.5 ± 2⁻¹⁷ |
| [x] | AT3 P8 回归 | Windows dev + 已有的 WPE 抓帧 | `p8-a2c` 第 162 帧、`p8-misc` 第 155 帧按日志回放 | 和 WPE 逐像素相同（屏蔽 FR / CLK） | 2026-11-15：两个都 0 差异；测试行测完已移除 |
| [x] | AT4 镂空材质 | Windows dev + WPE 抓帧（`p13d-spec-ns`，chroma4 / foliage4 棋盘格 A2C） | 渲染抓帧那一刻，和 WPE 比 | 格子边上不再多画 | 2026-11-15：差异 54 → 11，剩下的都是 1 级孤立像素（在 P13d 进行中的工作区上测，`fur4` 的主 pass 要 P13d） |
| [ ] | AT5 非 Windows / 别的显卡 | macOS / Linux / AMD / Intel | 预览用 A2C 的场景 | 同 Windows | 阈值是本机 NVIDIA、D3D11 单采样的实测，别的驱动可能不同 |

## 场景壁纸阴影（P13d）

2026-11-15。设置「场景阴影」（`wpeSceneShadows`，跟随 WPE 的 `shadows`，缺键 medium）；灯光数组改成每帧按 WPE 的规则排序、写整块缓冲；点光与平行光的阴影图集与阴影 pass（投射变体照 `[PASS] shadow` 注解，COMBO / A2C / 纹理 / 常量从基础材质继承，逐视图 `firstInstance` 代替视口数组）；翻译器展开点光 / 平行光阴影、`kb_shadowCompare` 处理没有 BORDER 与 NaN 坐标、新增「缺纹理格式」回合（`fur4`）、去掉 `gl_ViewportIndex` 的赋值；`fur4` 主 pass 按 `INSTANCECOUNT` 画多层。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase13/rea-p13-shadows.md`、`rea-p13-passes.md` 第 2 节与 `p13-REPORT.md`「P13d 的实测：阴影」，计划与实施记录见 `phase-13d-shadows.md`；测试工程 `ignore/p13/proj/p13d-*`（`ignore/p13/d/gen_d0.py`、`gen_d8.py`、`gen_d9.py`），WPE 抓帧在 `A:\p13d\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | SH0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、P13d 相关的 vitest（直接导入改动模块的 106 个文件）；`wpesl2wgsl` 单测与语料；`kabegame-core` 设置单测 | 0 error、全过 | 2026-11-15：tsc 0 error；翻译器 108 个单测过、语料 165/167（剩 `puppettexturechannels`、`volumetricsfront`，与本节无关）、几何门槛 27/27；vitest 的失败里 16 条在 HEAD 上同样失败（P13c 留下的探针替身、`REVERSEDEPTH` 宏、拼错的深度键），已一并修好；`pipeline.test.ts` 两张工坊场景的请求 / 字节上限在 HEAD 上同样超 |
| [x] | SH1 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate` | 20 处（偏移、排序、打包、宏、计数、投射判定、COMBO / A2C / 注解 / 常量 / 纹理继承、引擎 uniform、宿主设置） | 都被单测抓到 | 2026-11-15：19 / 20，剩下的 `casts-ignore-quality` 是等价变异（档位 0 时阴影计数已是 0）；`ignore/p13/d/mut/mutations.py` |
| [x] | SH2 语料 | Node，233 个工程 | HEAD 与工作区各扫一遍 | 只去掉 `lightconfig:pointshadow` / `directionalshadow` | 2026-11-15：去掉这两个键 4 张（都还有别的键）；`3455121165` 另报 `shader:generic4:require:LightingV1/spot-shadow`（本来就报 `lightconfig:spotshadow`）；其余增减是别的会话的改动 |
| [x] | SH3 对照 WPE | Windows dev + WPE 抓帧，1920×1080 | 29 次抓帧（五档 × 点光正交 / 透视 / 平行光，多灯、投射者判定、剔除、改级联距离、相机微移、两盏平行光、投射灯超配、运行中隐藏、毛发层数、三种专用投射者），按抓帧时刻渲染，档位用 dev 覆盖 | 整帧只差零星 1 级 | 2026-11-15：每张最多 32 个孤立像素、都只差 1 级；`p13d-who` 的粒子方块是探针不步进粒子；`p13d-hide` 隐藏后原先整帧发黑（空槽 NaN），修后 2 个像素差 1；`p13d-spec` 的格子边差异来自 A2C 阈值（见「场景壁纸：单采样 A2C 的阈值（P13d 附带）」） |
| [ ] | SH4 设置页切换 | Windows dev（新构建） | 设置页「场景阴影」切六档，预览带阴影的场景 | 每次切换场景重新加载、影子随档位变化，关闭时没有影子 | 待真机看 |
| [ ] | SH5 非 Windows | macOS / Linux | 预览带阴影的场景 | 同 Windows | 本机不能测 |

## 场景壁纸体积光（P13e）

2026-11-15。可见、`castvolumetrics` 的点光 / 聚光插在主 pass 里灯的位置画体积光（`compile/volumetrics.ts`、`render/volumetrics.ts`）：拷场景深度（转 `r32float`，要 `float32-filterable`）、1/d 画灯体背面、正面沿视线步进累加进 LightBuffer，连续的灯共用一次清屏，下一个可见的非灯对象之前或列表末尾合成（low / medium 先横竖模糊）；档位跟随 WPE 的 `volumetrics`（缺键 medium），dev 覆盖 `localStorage["kabegame-dev-scene-volumetrics"]`；翻译器认 `sampler2DBackBuffer`。WPE 的语义见 `.claude/plans/wpe-import/3-scene/phase13/rea-p13-volumetrics.md`、`rea-p13-passes.md` 第 3 节，计划、实测与实施记录见 `phase-13e-volumetrics.md`；测试工程 `ignore/p13/proj/p13e-*`（`ignore/p13/e/gen_e0.py`），语料隔离工程 `ignore/p13/e/real/`，WPE 抓帧在 `A:p13e`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | VL0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、P13e 相关 vitest；`wpesl2wgsl` 单测与语料 | 0 error、全过 | 2026-11-15：tsc 0 error；`compile/p13e.test.ts` 22 例（网格、GLM 求逆、聚光矩阵与抓帧逐位相同，真翻译器编确定性工程）、`render/p13e-volumetrics.test.ts`、相关渲染测试共 9 个文件 203 例全过；翻译器 109 个单测、语料 165 → 166/167（剩 `puppettexturechannels`） |
| [x] | VL1 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate` | 20 处（网格、求逆、聚光矩阵、常量与缺省、谁画、照报规则、COMBO、档位、在内判定、宿主键表） | 都被单测抓到 | 2026-11-15：18 / 20；`glm-double` 是等价变异（输入本来就是 float32），`glm-det` 在抓帧里出现的 VP（零很多）上逐位不变；`ignore/p13/e/mut/mutations.py` |
| [x] | VL2 语料 | Node，233 个工程 | HEAD（`ffa592e5`）与工作区各扫一遍 | 只去掉 `object:castvolumetrics`，只差体积光的场景解锁 | 2026-11-15：能渲染 185 → 187（`3287715210`、`3837478759`），没有掉出；去掉 `object:castvolumetrics` 5 张，新增 `volumetrics:transparentsorting` 1 张（`3453730450`，本来就有 `object:parent` 等）；两张解锁的场景完整工程（带脚本、粒子、文字）渲染正常 |
| [x] | VL3 对照 WPE | Windows dev + WPE 抓帧，1920×1080 | low 档 9 个确定性工程；medium / high / ultra / disabled 各 5–6 个（`capture_sweep`，扫完自动改回）；按抓帧时刻渲染，档位用 dev 覆盖 | 按 `FINAL_CHECK.md`：逐 pass 对齐，每处差异落到 draw 和值 | 2026-11-15 走查：每张最多 66 个像素、都只差 1 级（`kinds`、`scale` 与 `3837478759` 隔离工程五档逐像素相同）。逐 pass 读回两边的 LightBuffer、模糊、合成前场景：体积光链除 2 个纹素外逐位相同，其余差异都在体积光之前的光照 draw；每一处按 DXBC 用 float64 复算，都落在硬件写 8 位的取整门槛上（`WPE_SCENE.md` 已知差异「片元的零星舍入差」）。`3287715210` 改用只留背景与灯的复制工程 `-iso2` 重抓：LightBuffer 只有 1 个纹素差 1 个半精度 ulp，合成前的差异是背景 JPEG 的色度上采样（已登记），最终 8 位最大差 3；追踪工具补上 `r32float` 读回 |
| [x] | VL4 设置项 | Windows dev（重启后的新构建） | 设置 → 壁纸里「场景体积光」（阴影下面，下拉）切档，桌面是 `3837478759` 一类场景；图库预览同一张，在右栏「预览设置」里切档；不能跟随 WPE 的环境看选项 | 桌面与预览各自整场重新加载、光晕随档位变化、互不影响；不能跟随时没有「跟随 Wallpaper Engine」、存着的跟随显示为中 | 2026-11-15 Claude：宿主一半已测——屏外宿主（`host_open`，`p13e-po`）从主页面推 `volumetrics: disabled`、同值、`ultra`：探针 `recompiled` 依次记 `[postprocess, volumetrics]`（插件回的后处理不是 follow）、不重载、`[volumetrics]`，`disabled` 与 `ultra` 两档画面哈希不同、同档连读两次相同；设置页与预览要新命令 `get_wpe_scene_volumetrics`，等重启 dev 后由用户勾 |
| [ ] | VL5 非 Windows | macOS / Linux | 预览 `3837478759` | 同 Windows（要 `float32-filterable`） | 本机不能测 |

## 场景壁纸雾（P13f1）

2026-11-15。`general.fog*` 的 14 个字段进 `GENERAL_FIELDS`（就地生效）；加载时开关定 `FOG_DIST` / `FOG_HEIGHT`（翻译器 `fogDefines`，最终 `FOG` 非 0 才生效），四个雾 uniform 每帧现算；开雾时图像层与文本层都走合成 RT + passthrough 上屏（WPE 渲染标志 `0x1800000`，上屏的 `FOG_COMPUTED` 图像层取基础材质的 `FOG`、文本层 1）；additive 加 `ADDITIVE = 1`。实测与记录见 `p13-REPORT.md`「P13f 的实测」与 `phase-13f-fog-lights.md`「P13f1 实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | FG0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、`compile/p13f-fog.test.ts` 与改过的 `p2a` / `p8` / `scriptApi` / `script/api`；`wpesl2wgsl` 单测 | 0 error、全过 | 2026-11-15：tsc 0 error；`p13f-fog.test.ts` 13 例（含真翻译器编 5 个确定性工程）；`fog_defines_follow_final_fog_combo` 通过；`scriptApi` 的 `3304642534` 两例失败来自别的会话的 `sortLayer`，与本节无关 |
| [x] | FG1 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate`（`ignore/p13/f/mut/mutations.py`） | 15 处：宏、参数打包、脏位、编译期给宏、文本层强制与 `FOG_COMPUTED`、图像层 `FOG_COMPUTED`、渲染图两处条件、`ADDITIVE`、粒子白名单、引擎 uniform 表、`staticBuiltins`、就地刷新 | 都被单测抓到 | 2026-11-16：15 / 15；就地刷新那处第一次漏检，补了 `render/rebuild.test.ts`「雾的数值字段」后检出 |
| [x] | FG2 语料 | Node，233 个工程 | 改动前后各扫一遍 | 只去掉 `general:fog*`，没有新增键 | 2026-11-15：能渲染 189 → 190（`3115845558`），没有掉出、没有新增键；`3706286085` 只剩 `object:parent`（P13f2） |
| [x] | FG3 对照 WPE | Windows dev + WPE 抓帧，1920×1080 | 7 个确定性工程：透视开雾（含运行中改终点）、两开关都关、正交、粒子（回放 10 帧）、各种图像层与文本、组合层与全屏层开 / 关 | 只有零星 1 级的舍入差 | 2026-11-15：最多 12 个像素、都只差 1 级，两个关雾的工程 0 差异；第一次比透视工程差 25 级，查出开雾强制图像层走 passthrough（F7）后修正 |
| [x] | FG4 真机预览 | Windows dev | 图库预览 `3115845558`（雾全关，只差雾字段） | 实时渲染、画面正常 | 2026-11-16 用户：正常 |
| [ ] | FG5 非 Windows | macOS / Linux | 同 FG4 | 同 Windows | 本机不能测 |

## 场景壁纸灯的运行时（P13f2）

2026-11-16。灯从编译期常量改成运行时状态：编译期只出灯对象（`bundle.lightObjects`，数值字段绑属性登记就地目标），属性、关键帧、字段脚本、脚本对象写 `SceneState.lights`；渲染器每帧按状态组灯记录（世界矩阵与可见性沿父链），遗留灯晚一帧；选灯的「带阴影」看用户阴影档 ∧ `castshadow`；体积光每帧按可见性分段、按状态写常量。实测与记录见 `p13-REPORT.md`「P13f 的实测」与 `phase-13f-fog-lights.md`「P13f2 实施记录」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | LR0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、`src/compile` + `src/render` + `src/script` 与宿主测试 | 0 error、全过 | 2026-11-16：tsc 我改的文件 0 error（别的会话的视频改动有错误）；3472 例里失败的都不归本节：`scriptApi` 的 `3304642534` 两例（HEAD 上就失败）、`pipeline` 的读取上限（HEAD 上已有 4 条，`3570755196` 来自别的会话 P6d3b，`3706286085` 读 128 MB 是它现在完整编译了），`p3a` 单独跑 13 例全过（并发时超时） |
| [x] | LR1 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate`（`ignore/p13/f/mut/mutations-f2.py`） | 13 处：灯记录与遗留灯的父链、可见性沿父链、排序键、遗留灯晚一帧与按帧时刻换代、状态写入、字段脚本 / 关键帧目标、灯的颜色缺省、`light:runtime:*`、选灯的阴影档、体积光位置与逐帧常量 | 都被单测抓到 | 2026-11-16：13 / 13；「隐藏的体积光灯照画」在 `GpuScene` 编码里、单测够不到，由 `p13f-vol` 隐藏父对象那张 WPE 对照兜底 |
| [x] | LR2 语料 | Node，233 个工程 | 改动前后各扫一遍 | 只去掉灯的 `object:parent` 与 `value:animation:light` | 2026-11-16：`3706286085` 变干净；`3455121165` 多了 `volumetrics:transparentsorting`（太阳灯可见性绑属性，运行时可见时会画体积光；这张本来就因聚光阴影不能渲染）；同期别的会话的 `createLayer` 解锁 4 张，不归本节 |
| [x] | LR3 对照 WPE | Windows dev + WPE 抓帧，1920×1080 | `p13f-light` 按 WPE 日志回放第 153 帧比灯光数组；`p13f-vol` 四种状态（基线、隐藏立方体、隐藏父对象、挪父对象）；`p13f-sort` 两种状态 | uniform 只差日志精度；整帧只有零星 1 级 | 2026-11-16：灯光数组最大差 2e-6（日志只记 6 位小数）；体积光四种状态 0 差异；排序两种状态各 2 个像素 1 级（修前差 82 级：没有阴影计数时选灯的阴影档当 0，见 L3） |
| [ ] | LR4 真机预览 | Windows dev | 图库预览 `3706286085`，按住左键看太阳与车灯变亮，在属性里改太阳方向 | 实时渲染，灯光随按键与属性变化 | 待用户看 |
| [ ] | LR5 非 Windows | macOS / Linux | 同 LR4 | 同 Windows | 本机不能测 |

## 场景壁纸屏幕空间反射开（P13g）

2026-11-17。「场景反射」开着（或跟随且 WPE 开着）时，`_rt_MipMappedFrameBuffer` 每帧在主 pass 之后、泛光之前从场景目标拷 0 级再逐级缩小，读它的对象读到上一帧，不再报 `reflection:screen`。缩小照 WPE 驱动的 `GenerateMips`：硬件双线性，缩放系数截到 2⁻²⁴、坐标向下截到 1/256（`render/reflection.ts` 的 `MIP_DOWNSAMPLE_WGSL`）。实测与走查见 `phase-13g-screen-reflection.md` 与 `p13-REPORT.md`「P13g 的实测」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | SR0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；`src/render/reflection.test.ts`、`src/compile/p13b1.test.ts` | 0 error、全过 | 2026-11-17：tsc 0 error，2 个文件 67 例全过（新增：反射开的建 / 拷 / 缩小、泛光之前、定点坐标与 BigInt 精确值逐个比） |
| [x] | SR1 变异检查 | Node，`kbp snapshot export WORKTREE` + `kbp mutate`（`ignore/p13/g/mut/mutations-g.py`） | 13 处：挪到泛光之后、不调、不拷、读错级、反射开照旧清屏、没有 `COPY_DST`、系数两轴对调 / 就近取、坐标就近取 / 溢出、编译期恒不更新、渲染器不看 `update`、照旧报键 | 都被单测抓到 | 2026-11-17：13 / 13（「系数就近取」第一轮漏掉，补了一组系数小数部分大于 ½ 的尺寸）。着色器里的坐标算式单测跑不到，由 SR3 的 GPU 对照兜底（就近取时第 4、5 级各差 11 / 8 个分量） |
| [x] | SR2 语料 | Node，233 个工程 | HEAD 快照与工作区各扫一遍；再把两份快照的缺省设置换成「开」，扫读 mip 帧缓冲的两张 | 跟随时逐张不变；反射开时只去掉 `reflection:screen` | 2026-11-17：跟随 197 → 197、0 张变化；反射开 `3706286085` 变干净，`3453730450` 还剩 P13h 的三个键 |
| [x] | SR3 对照 WPE（确定性工程） | Windows dev + WPE 抓帧（`capture_sweep` 临时开反射） | `ignore/p13/g/gen_g.py` 的 `p13g-mip`（1920×1080、1366×768）与 `p13g-hdr` 按日志回放，轨迹读回各级 mip，与抓帧导出的各级逐值比 | 拷贝在泛光之前、读者读到上一帧；各级逐值相同 | 2026-11-17：三种下各级与读者的十条 lod 横带逐值相同（只差读时钟的 CLK 块）；HDR 0 级 > 1 的值保留 |
| [x] | SR4 走查（FINAL_CHECK） | Windows dev + WPE 抓帧 | `3453730450` 复制工程（`ignore/p13/g/walk/make_iso_3453.py`）反射开 10 帧按日志回放；`3706286085` 复制工程同样 10 帧 | 整帧逐像素相同，差异逐处解释 | 2026-11-17：`3453730450` 10 帧逐像素相同，同一帧反射开 / 关差 109 个像素（最大 57 级）；`3706286085` 的读者（眼睛）被挡住，反射开 / 关逐像素相同，余下的差是已知的偶数帧相机滞后与城市骨骼 K2（第 261 帧只差 37 个像素 ≤ 1） |
| [ ] | SR5 真机预览 | Windows dev | 预览 `3453730450`（强制渲染），在右栏「预览设置」里把「场景反射」在「开启」与「关闭」之间切换（预览不读设置页的全局值），盯着探测卫星（属性「探测卫星」）的隔热毯 / 太阳能板与小行星 1 | 开启时这两个模型表面有很淡的模糊反射（1080p 下约百来个像素变化），关闭时没有；切换后整场重新加载 | 待用户看。效果很弱，肉眼不明显时以「切换后重新加载、不报错」为准，画面已由 SR4 逐像素验过。`3706286085` 的读者（眼睛）被挡住，开关逐像素相同，不用看 |
| [ ] | SR6 非 NVIDIA 显卡 | AMD / Intel | 同 SR3 | 和本机 WPE 的画面一致 | 缩小的滤波是照本机 NVIDIA 驱动反推的，别的驱动可能不同（那时 WPE 自己的画面也不同）；本机不能测 |

## 场景壁纸透视场景的余项（P13h）

2026-11-18。透视场景里的文本按对象 `depthtest` 换 `_depth` 材质（测深度、不写），带子层的组合层照正交时的画法，透明排序时体积光的灯进第二遍按局部 `origin` 排序；不再报 `camera:perspective:text`、`camera:perspective:group`、`volumetrics:transparentsorting`。实测与走查见 `phase-13h-perspective-rest.md` 与 `p13-REPORT.md`「P13h 的实测」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PH0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；`src/compile/p13h.test.ts`、`p5d2.test.ts`、`p5d4.test.ts`、`texts.test.ts`、`fragment.test.ts`、`src/script/structureRuntime.test.ts`、`src/render/sortOrder.test.ts`、`text.test.ts` | 0 error、全过 | 2026-11-18：tsc 0 error，8 个文件 178 例全过（新增：透视文本三种 `depthtest` 的材质、正交不换、带 effect 时 clearalpha 不换、透视组成组且不报） |
| [x] | PH1 语料 | Node，233 个工程 | HEAD 快照与工作区各扫一遍（`ignore/p13/h/corpus-{head,wt}.json`） | 只去掉三个键；`3453730450`、`3509243656` 变干净 | 2026-11-18：干净 197 → 199，text 4 张、transparentsorting 2 张、group 1 张，没有新增键 |
| [x] | PH2 对照 WPE（确定性工程） | Windows dev + WPE 抓帧（`A:\p13h\`） | `ignore/p13/h/gen_h.py` 的 `p13h-text`、`p13h-group`、`p13h-vol`、`p13h-vol-off` 与 WPE 整帧比 | 整帧 0 差 | 2026-11-18：四个都 0 差。RenderDoc 核过文本字形、背景、带 effect 的合成上屏都是 GREATER、不写；`p13h-vol` 的 MID 带着 L2 的光（局部键）。透明排序的灯顺序在 `encode` 里，没有单测，由这一条兜底 |
| [x] | PH3 走查（FINAL_CHECK） | Windows dev + WPE 抓帧 | `3453730450` 复制工程（`ignore/p13/h/walk/make_iso_3453.py`）10 帧、`3509243656` 复制工程（`make_iso_3509.py`）5 帧按日志回放 | 整帧逐像素相同，差异逐处解释 | 2026-11-18：`3453730450` 10 帧逐像素相同（文本、组、体积光都在画面里）；`3509243656` 是 HDR，WPE 后备缓冲 RGBA16F 按 sRGB 编码就近取整后每帧最大差 1（4 万像素，全在泛光光晕渐变上，f16 量化），文字处相同 |
| [ ] | PH4 真机预览 | Windows dev | 图库里预览 `3453730450`（《玉盘 /Moon》）与 `3509243656`（三体实时演算） | 不再停在封面、实时渲染；`3453730450` 的「The Moon」文字与时钟在画面中间，透视下文字被前面的物体挡住的部分不画 | 待用户看。两张都是脚本驱动，画面已由 PH3 的复制工程逐像素验过 |

## 场景壁纸聚光阴影（P13i）

2026-11-18。聚光灯（`lspot`）开 `castshadow` 且 `lightconfig.spotshadow` 留了名额时画阴影：按 `castshadow / usecookie` 选段写聚光数组，带阴影的占一个投影槽与图集一块，投影复用体积光的 `spotViewProjection`，阴影 pass 同平行光偏 0.0005；翻译器展开「聚光 · 阴影」段，平行光级联基址跟着加上聚光阴影数。聚光 cookie 照报（`lightconfig:spot*cookie`、`LightingV1/spot-cookie`）。实测与走查见 `phase-13i-spot-shadow.md` 与 `p13-REPORT.md`「P13i 的实测」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PI0 单测与检查 | Windows | 翻译器 `cargo test --lib`；`apps/wpe-scene` 的 tsc；`src/render/p13i-spot.test.ts`、`src/compile/lights.test.ts` 与 P13 其余 12 个测试文件 | 0 error、全过 | 2026-11-18：翻译器单测全过（工作区 114 例，含别的会话同时新增的）；tsc 0 error；14 个文件 165 例全过（新增：六组抓帧的聚光数组、投影、方块变换、阴影视图集合与图集尺寸逐位对 WPE；段选择、cookie 照报、级联基址） |
| [x] | PI1 语料 | Node，233 个工程 | 在「HEAD」与「HEAD + P13i」两份快照上各扫一遍（翻译器 wasm 分别编，不混入别的会话在改的翻译器源码） | 只去掉 `lightconfig:spotshadow` 与 `shader:generic4:require:LightingV1/spot-shadow` | 2026-11-18：干净 205 → 206（`3455121165`），没有新增键 |
| [x] | PI2 对照 WPE（确定性工程） | Windows dev + WPE 抓帧（`A:\p13i\`，`capture_sweep` 临时改阴影档、跑完改回 low） | `ignore/p13/i/gen_i.py` 的 spot / tilt / mix / ortho（low）与 spot / mix（high）整帧比 | 和 P13d 的点光、平行光同一水平 | 2026-11-18：每张 1–17 个孤立像素差 1（光照渐变里的取整，不在影子边缘） |
| [x] | PI3 走查（FINAL_CHECK） | Windows dev + WPE 抓帧 | `3455121165` 复制工程（`ignore/p13/i/walk/make_iso_3455.py`：组、太阳、三盏灯、地板、八颗行星，行星换成固定位置让影子落在地板上）5 帧按日志回放 | 整帧逐像素相同，差异逐处解释 | 2026-11-18：每帧 1 个像素差 1；同一帧阴影开 / 关差 3221 个像素（影子确实进了画面） |
| [ ] | PI4 真机预览 | Windows dev | 图库里预览 `3455121165`（Solar system 太阳系），右栏「预览设置」的「场景阴影」在 low 与关闭之间切换 | 不再停在封面、实时渲染；切换后整场重新加载，地板上的光斑里有行星的淡影子 | 待用户看。影子落在很暗的光斑上，肉眼不明显时以「能实时渲染、切换不报错」为准 |

## 场景壁纸预光照：普通图层（P13j-1）

2026-11-18。基础材质开 `LIGHTING` 或 `REFLECTION`、又走合成路径（effect、colorBlendMode 混合、被依赖、开雾）的图像层，基础 pass 换成同 key 重编的 `PRELIGHTING=1` 变体（`SceneLayer.prelit`），渲染器给这一步写 `g_AltModelMatrix`（图层世界矩阵，instanced 乘 size / 图像尺寸）、`g_AltNormalModelMatrix`（逐行快速归一化）、`g_AltViewProjectionMatrix`（图层上屏的视图投影），四边形与正交按合成 RT 尺寸。普通图层不再报 `lighting:prelighting`，puppet 照报（P13j-2）。实测见 `phase-13j-prelighting.md` 与 `p13-REPORT.md`「P13j 的实测」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PJ0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；`src/compile/p13j.test.ts`、`src/compile/lights.test.ts` 与 P13 其余测试文件 | 0 error、全过 | 2026-11-18：tsc 0 error；13 个文件全过，「HEAD + P13j-1」快照里同样全过（新增：变体的编法与触发条件、只开反射也触发、不走合成不编；Alt 矩阵按 `p13j-fx` 抓帧的值） |
| [x] | PJ1 语料 | Node，233 个工程 | 在「HEAD」与「HEAD + P13j-1」两份快照上各扫一遍 | 只有带光照又走合成的普通图层去掉 `lighting:prelighting`，没有新增键 | 2026-11-18：只有 `3662790108` 去掉这个键（还缺材质文件，仍不能渲染）；干净 223 不变 |
| [x] | PJ2 对照 WPE（确定性工程） | Windows dev + WPE 抓帧（`A:\p13j\`） | `ignore/p13/j/gen_j.py` 的 fx / tilt / cbm / fog / legacy 与 `gen_j_inst.py` 的 inst 整帧比 | 逐像素相同或只有零星取整差 | 2026-11-18：fx、cbm、legacy、inst 逐像素相同；tilt 3 个、fog 2 个孤立像素差 1 |
| [ ] | PJ3 非 Windows | macOS / Linux | 同 PJ2 的工程导入后预览 | 同 Windows | 本机不能测 |

## 场景壁纸预光照：puppet（P13j-2）

2026-11-18。开光照或反射又走合成路径的 puppet，预光照变体另带 puppet 组合键（没有 `SKINNING_ALPHA`，skinned 时加 `PRELIGHTINGDUALVERTEX`）、`nocull`，基础 pass 画整张网格进合成 RT（原始位置定光栅位置、蒙皮后的位置算光照，`a_PositionC1` 读位置那一项，画前不清 RT），不再报 `lighting:prelighting`；纹理通道 + 光照仍报 `puppet:texture-channels:prelighting`。实测见 `phase-13j-prelighting.md` 与 `p13-REPORT.md`「P13j-2：puppet」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PK0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc；`src/compile/p13j.test.ts`、`p8.test.ts`、`lights.test.ts`、`p12b2-tc.test.ts`、`p12a.test.ts`、`mdl.test.ts` 与 render 侧 puppet / 网格的测试 | 0 error、全过 | 2026-11-18：工作区与「HEAD + P13j-2」快照里 tsc 都是 0 error；快照里 10 个文件 355 例全过（新增 6 例：组合键、去 `SKINNING_ALPHA`、不编的条件、基础步骤画网格、`a_PositionC1` 的别名与顶点布局；`p8.test.ts` 补改 P13j-1 漏掉的一条旧期望） |
| [x] | PK1 语料 | Node，233 个工程 | 「HEAD」与「HEAD + P13j-2」两份快照各扫一遍（同一个翻译器 wasm） | 只去掉 `lighting:prelighting`，没有新增键 | 2026-11-18：干净 223 → 224（`2515018199`），没有新增键 |
| [x] | PK2 走查（FINAL_CHECK） | Windows dev + WPE 抓帧（`A:\p13j\2515iso-fps20-3840x2160`，帧率 20，设置没改） | `ignore/p13/j/walk/make_iso_2515.py` 的复制工程（五个部件 + 三盏遗留 point 灯）按日志回放，3840×2160 整帧比 | 整帧几乎逐像素相同、没有成块差异 | 2026-11-18：第 208 帧 524 个像素差 ≤ 2，第 210 帧 1096 个像素差 ≤ 3；变异「变体不带 puppet 组合键」时 22% 的像素不同，还原后画面哈希回到原值 |
| [x] | PK3 真机预览 | Windows dev | 图库里预览 `2515018199`（Knight Artorias） | 不再停在封面、实时渲染；盔甲上的高光随灯光的移动变化，披风与头盔边缘的水波效果正常 | 待用户看 |
| [ ] | PK4 非 Windows | macOS / Linux | 同 PK3 | 同 Windows | 本机不能测 |

## 场景壁纸聚光 cookie 与体积光的聚光阴影（P13k）

2026-11-21。聚光的 cookie（投影图样）在表面着色与体积光里都画出来：`usecookie` 的聚光加载时读 `cookie` 字段（缺省 `cookie/flashlight1`，文件不存在时绑棋盘格并报 `texture:missing:*`）。翻译器生成「阴影 + cookie」「cookie」两段（不乘锥角，采 `COOKIE_SAMPLER`），`LIGHTS_COOKIE` 由宿主定义，着色器的 cookie 槽缺省 `_alias_lightCookie`，渲染器每帧解析到排序后最后一盏 cookie 聚光的 cookie（钳边 + 三线性，WPE 是黑边框）；只开 cookie 的灯写投影、不进图集。体积光加 `COOKIE`（槽 2、NDC 立方体灯体、`eye + 0.1·F` 的在内判定），带阴影的聚光取自己聚光阴影条目的方块变换。`lightconfig:spot*cookie`、`LightingV1/spot-cookie`、`volumetrics:cookie`、`volumetrics:spot-shadow` 不再报，点光开 cookie 改报 `volumetrics:cookie:point`。读码与实测见 `phase-13k-spot-cookie.md` 与 `p13-REPORT.md`「P13k 的实测」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | CK0 单测与检查 | Windows | 翻译器 `cargo test --lib` 并重编 wasm；`apps/wpe-scene` 的 tsc；`src/compile/p13k.test.ts`、`lights.test.ts`、`p13e.test.ts`、`fragment.test.ts` 与 P13 其余测试文件 | 0 error、全过 | 2026-11-21：翻译器 124 例全过；工作区与「HEAD + P13k」快照（HEAD `a47b9aea`）里 tsc 都是 0 error，快照里 13 个文件 228 例全过 |
| [x] | CK1 语料 | Node，233 个工程 + myprojects `3839619935` | 「HEAD」与「HEAD + P13k」两份快照各扫一遍（各配自己的翻译器 wasm） | 233 张不变；`3839619935` 变干净，没有新增键 | 2026-11-21：233 张前后一致、全部干净；`3839619935` 去掉 `lightconfig:spotshadowcookie`、`volumetrics:cookie`、`volumetrics:spot-shadow`，变干净 |
| [x] | CK2 对照 WPE（体积光） | Windows dev + WPE 抓帧（`A:\p13k\`，阴影 low、体积光 low、后处理 ultra） | `ignore/p13/k/gen_k.py` 的 `p13k-vol*` 六个工程整帧比 | 逐像素相同或只有零星取整差 | 2026-11-20：五个逐像素相同（排除帧号角），`p13k-vol` 64 个像素差 1（含帧号块）；变异（不加 `COOKIE`、聚光不取阴影条目）各差 107 万 / 80 万个像素 |
| [x] | CK3 对照 WPE（表面着色） | 同上 | `p13k-surf`、`-surf-shadow`（low 与 disabled）、`-surf-two` 整帧比 | 同上；两盏 cookie 灯都采排在后面那盏的图样 | 2026-11-21：分别 1、1、1、3 个像素差 1；变异（cookie 段乘锥角、别名取前一盏）各差 37 万 / 79 万个像素。disabled 档由 `capture_sweep` 临时改、跑完改回 low |
| [x] | CK4 走查（FINAL_CHECK） | Windows dev + WPE 抓帧（`A:\p13k\3839iso-fps20-2278x1280`） | `ignore/p13/k/walk/make_iso_3839.py` 的复制工程（背景、猫、puppet、聚光）按日志与光标回放第 283 帧，2278×1280 整帧比 | 没有成块差异 | 2026-11-20 / 21：最大差 5（背景纹理解码的 8×8 块纹路，已知差异）；关掉体积光再比差到最大 67、121 万个像素；k-2 之后重渲染和 k-1 的图逐字节相同 |
| [ ] | CK5 真机预览 | Windows dev | 图库里预览 `3839619935`（myprojects） | 不再停在封面、实时渲染；聚光灯的光柱里能看到图样 | 待用户看 |
| [ ] | CK6 非 Windows | macOS / Linux | 同 CK3 的工程导入后预览 | 同 Windows | 本机不能测 |

## WPE 壁纸设置与预览设置

2026-11-15 Windows dev。暂停、音量、视频倍速、媒体集成、场景后处理 / 反射 / 阴影抽成一个字段组（`WpeSettingsFields.vue`）。桌面仍用全局设置键（设置页全部显示）；预览与应用背景改用每张壁纸 metadata 的 `previewSettings`（`get_wpe_preview_settings` / `set_wpe_preview_settings`，没设取 Kabegame 默认值）。预览的暂停仍是弹窗内存状态，应用背景强制暂停。场景三项改由父页面经 `kabegame:wpe-scene-settings` 下发，宿主不再读全局设置；媒体集成按订阅判定（壁纸窗口跟全局、主窗口跟这张的预览设置）。「跟随 WPE」只在 `get_wpe_follow_available` 为真时提供。计划见 `.claude/plans/wpe-import/phase-wallpaper-settings.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WS1 单测与检查 | Windows | `deno task check -c kabegame`（vue-tsc 与 cargo check）、`apps/wpe-scene` tsc；`kabegame-core` 的 `preview_settings` 与 `kabegame` 的 `wpe_media` 单测；相关 vitest；Prettier / rustfmt | 0 error、全过 | 2026-11-15 Claude：vue-tsc 0 error；改权限文件之前 cargo check 通过，之后那次被 dev 占着 CEF 的 dll（os error 32）卡在 `cef-dll-sys` 构建脚本；core 4 个、`wpe_media` 62 个（新增预览开关 1 例）；vitest 应用 10 个文件 103 例、宿主 4 个文件 124 例、dev 插件 `scene.test.ts` 全过 |
| [x] | WS2 预览设置读写 | Windows dev，测试工程 `bloom-off` | `set_wpe_preview_settings` 写音量 0.3、阴影 high、反射 enabled；写 `paused` | 只存 `{ volume: 0.3, shadows: "high" }`（反射等于默认值不存）、`metadataId` 变；`paused` 报「未知预览设置」；作者属性照常可读 | 2026-11-15 Claude：kabegame-dev MCP；测试行已用 `projects_remove` 移除 |
| [x] | WS3 场景设置下发 | Windows dev，屏外宿主（`host_open`） | 宿主加载后从主窗口推 `postprocess: disabled`；再推同一份 | 第一次整场重载、探针 `recompiled` 记 `{ reason: "settings", keys: ["postprocess"] }`；第二次不重载 | 2026-11-15 Claude：结果符合；首次加载没有出现「3 s 内没收到」的 warn（dev 插件替屏外宿主回了全局设置） |
| [ ] | WS4 设置页字段组 | Windows dev | 设置 → 壁纸：看暂停（窗口模式）、音量、倍速、媒体集成、后处理、反射、阴影；逐项改动 | 七项都在、外观同原来（后处理 / 反射分段器、阴影下拉、滑杆松手才保存）；改动后桌面壁纸跟着变，预览不变 | 要打开设置页，由用户勾 |
| [ ] | WS5 预览右栏 | Windows dev，图库预览 | 预览场景、网页、视频壁纸各一张；改音量 / 倍速 / 后处理等；点字段组的暂停，再用右键菜单暂停 | 场景六项、网页三项（暂停、音量、媒体集成）、视频只有倍速；改动当场生效、只影响预览；字段组的暂停和右键菜单联动；换图后暂停复位、预览设置按图各自保留 | 要打开预览，由用户勾 |
| [ ] | WS6 媒体集成分开 | Windows dev，放音乐 | 全局「媒体集成」关、某张网页壁纸的预览设置开，预览它并把它设为桌面 | 预览里有歌名封面，桌面没有；反过来亦然 | 单测覆盖了开关归属，真机未测 |
| [ ] | WS7 应用背景强制暂停 | Windows dev | 当前壁纸分别是视频、网页、场景时打开应用背景 | 都停在一帧画面上，不空白、不动；网页开场即冻结时是否空白要看（空白就补「首帧后才冻结」） | 未测 |
| [ ] | WS8 跟随 WPE | macOS / 清空 WPE 目录的 Windows | 设置页与预览右栏的后处理 / 反射 / 阴影 | 选项里没有「跟随 WPE」，存着的跟随显示为开启 / 开启 / 中 | 未测 |

## 壁纸显示重构步骤 1：WPE 显示组件与图库缩略图打底

2026-11-15 Windows dev。网页 iframe（创建 / 销毁、load 判定、音量协议、右键、鼠标）与场景宿主从 `WallpaperStage` 搬进 `WpeWallpaperContent`（事件 `live` / `fail(reasons)` / `error` / `contextmenu`，`delegatesPing`）；Stage 的 web / scene 层各挂一个。场景结果超时从 Stage 的 10 s 改成 `WpeWallpaperContent` 的 30 s，超时卸载宿主；网页 `fail` 时 Stage 保留上一张。图库（`ImageContent` 的 wallpaper 形态）不再经 Stage：缩略图打底，实时画面 `live` 且满 300 ms 才淡入揭开，`fail` 当原图失败（缩略图就是最终画面），预览设置由调用方经 `playback` 下传，`wallpaperLive` 取代 `sceneLive`。计划见 `.claude/plans/wpe-import/phase-wallpaper-refactor.md` 步骤 1。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WR1 单测与检查 | Windows | vue-tsc；壁纸目录、图片组件、预览弹窗、预览设置的 vitest；Prettier | 0 error、全过 | 2026-11-15 Claude：vue-tsc 0 error；23 个文件 271 例全过（新增 `WpeWallpaperContent.test.ts` 17 例、`WallpaperStage.web.test.ts` 3 例，`ImageContent.wallpaper.test.ts` 改写为 10 例） |
| [x] | WR2 预览场景 | Windows dev，图库预览 | 预览一张能渲染的场景、一张不能渲染的场景（如 13518）、一张大场景 | 一打开就是封面，实时画面出来后淡入盖上；不能渲染的停在封面、没有破图与空白；右键「暂停」「设为封面」在揭开之前置灰 | 要打开预览，由用户勾 |
| [x] | WR3 预览网页壁纸 | Windows dev，图库预览 | 预览网页壁纸，改音量、暂停、右键、在页面上点击 | 先封面后页面；音量、暂停、右键、鼠标注入和以前一样 | 要打开预览，由用户勾 |
| [x] | WR4 换封面 | Windows dev，图库预览 | 实时画面出来后「设为壁纸封面」，再「恢复默认封面」 | 实时画面不闪、不重新加载；关掉实时画面（暂停不算）后看到的是新封面 | 要打开预览，由用户勾 |
| [x] | WR5 应用背景 | Windows dev | 当前壁纸分别是网页、场景时打开应用背景 | 先显示封面，再换成停住的实时画面，不交互、不出声 | 未测 |
| [x] | WR6 桌面 | Windows dev，壁纸窗口模式 | 依次切到图片、网页、场景、视频，再切回；切到一张不能渲染的场景 | 和以前一样：场景出结果前保留上一张，能渲染淡入、不能渲染显示预览图；网页卡住的 ping 照样触发重载 | 本次测时壁纸是关的，没开 |

## 壁纸显示重构步骤 2–3：场景加载进度

2026-11-15 Windows dev。宿主只在首次加载时按阶段（compile / decode / gpu / frame）经 postMessage 报进度（`apps/wpe-scene/src/progress.ts`，100 ms 节流），`WpeSceneView` 认自己 iframe 的消息往上报，`WpeWallpaperContent` 出结果前转发并把 30 s 超时改成「30 s 内没有新进度」；`ImageContent` 的 wallpaper 形态在缩略图上叠进度条与阶段文字（`WpeLoadingOverlay.vue`、`useWpeLoadProgress`），网页壁纸是不定进度；「开始渲染」日志带各段用时。计划见 `.claude/plans/wpe-import/phase-wallpaper-refactor.md` 步骤 2、3。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WP1 单测与检查 | Windows | vue-tsc、`apps/wpe-scene` tsc；宿主 `progress.test.ts`、`compile/client.test.ts`、`host.test.ts`，应用 `wpeSceneProgress.test.ts`、`useWpeLoadProgress.test.ts`、`WpeLoadingOverlay.test.ts`、`WpeSceneView.test.ts`、`WpeWallpaperContent.test.ts`、`ImageContent.wallpaper.test.ts` 等；Prettier | 0 error、全过 | 2026-11-15 Claude：两边 tsc 0 error；宿主 3 个文件 40 例、应用 24 个文件 278 例全过 |
| [x] | WP2 宿主上报 | Windows dev，屏外宿主（`host_open`），主页面临时监听 postMessage | 加载 13513（3 层）与 13554（82 层、33 个 mip） | 阶段按 compile → decode → gpu → frame、只增不减，最后一条是 `frame 1/1`；「开始渲染」日志带分段用时 | 2026-11-15 Claude：13513 共 8 条、931 ms（编译 632 ms）；13554 共 25 条、5.9 s（编译 3.2 s、解码 0.4 s、准备 1.3 s、取设备 0.3 s、建 GPU 场景 0.25 s），编译、解码完就进入 `gpu 0/1`，准备期间条不停；临时监听与宿主已移除 |
| [x] | WP3 预览观感 | Windows dev，图库预览 | 预览小场景、大场景（如 13554）、不能渲染的场景、网页壁纸；也打开应用背景 | 加载中封面模糊、正中是阶段文字与进度条，大小不随场景分辨率变；场景一路往前走、不倒退、准备渲染那段不停；出来后走满淡出（模糊一起退），实时画面淡入；不能渲染的文字与进度条变红走满，随后封面变清晰、底部留一行红字原因（超时显示「加载超时」）；网页是来回流动的条与「加载中」 | 2026-11-15 用户看过：可以（应用背景里不能渲染时底部的红字也留着） |
| [ ] | WP4 卡住的场景 | Windows dev，图库预览 | 预览 13529（之前 10 s 超时的那张） | 停在启动阶段约 30 s 后收起进度、停在封面，日志「30000 ms 内没有新进度也没有结果，卸载宿主」 | 屏外宿主实测它一条进度都没发、没有任何日志，原因未查 |

## 壁纸显示重构步骤 4：ImageContent 的壁纸变体与 WPE 视频作者属性

2026-11-15 Windows dev。`ImageContent` 新增 `variant="wallpaper"`（给下一步的桌面 `Wallpaper.vue`）：不画骨架与丢失图、不能拖出，图片等原图才 ready、ready 每张一次，视频静音起播后按 `playback` 的音量与倍速；`fit` 多了 fill / none；`displaySource()`。WPE 视频的作者属性（翻转、位置、居中位移、颜色、留边色）规则搬到 `wpeVideoStyle.ts`，由 `ImageContent` 用在自己的 `<video>` 上，图库预览与应用背景也生效。计划见 `.claude/plans/wpe-import/phase-wallpaper-refactor.md` 步骤 4。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WV1 单测与检查 | Windows | vue-tsc；`wpeVideoStyle.test.ts`、`ImageContent.variant.test.ts` 与图片 / 壁纸 / 通用组件、组合式函数目录全部 vitest；Prettier | 0 error、全过 | 2026-11-15 Claude：48 个文件 488 例全过（新增 12 例） |
| [ ] | WV2 预览 WPE 视频 | Windows dev，图库预览 | 预览一张作者设了翻转或颜色、留边色的视频壁纸 | 画面按作者属性翻转 / 调色，留边是作者的颜色；和桌面上这张一致 | 要打开预览，由用户勾 |
| [ ] | WV3 应用背景 | Windows dev | 同一张视频壁纸设为当前壁纸并开应用背景 | 背景同样按作者属性显示、停在第一帧 | 未测 |
| [ ] | WV4 普通视频与图片 | Windows dev，图库 | 网格、预览里看普通视频与图片 | 和以前一样（壁纸变体只给桌面用） | 未测 |

## 壁纸显示重构步骤 5：桌面改用 Wallpaper（每个壁纸一层 ImageContent）

2026-11-15 Windows dev。`WallpaperStage` 删除，桌面壁纸窗口改用 `Wallpaper.vue`：每个壁纸一层 `ImageContent`（壁纸变体），新层 ready 后按过渡淡入 / 滑入 / 缩放、过渡结束卸载旧层（加载中的层被新目标替换、过渡中的先定下来，场景 → 场景两个宿主短暂并存）；样式换成 `fit`，tile 时图片画重复背景、视频按盖满；网页 / 场景就是 `ImageContent` 的 wallpaper 形态（缩略图打底、加载进度、失败红字）。计划见 `.claude/plans/wpe-import/phase-wallpaper-refactor.md` 步骤 5。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WD1 单测与检查 | Windows | vue-tsc；`Wallpaper.test.ts`、`targetKind.test.ts`、壁纸窗口两份测试与图片 / 壁纸 / 通用组件、组合式函数、视图目录全部 vitest；Prettier | 0 error、全过 | 2026-11-15 Claude：51 个文件 512 例全过（`Wallpaper.test.ts` 13 例） |
| [ ] | WD2 切换与过渡 | Windows dev，壁纸窗口模式 | 过渡分别设 无 / 淡入 / 滑入 / 缩放，依次切图片、视频、网页、场景、再切回 | 每次都按过渡交接（以前网页 / 场景整层淡入淡出、图片视频互切是硬切），旧壁纸过渡完才消失、没有黑屏；无过渡时直接换 | 要开桌面壁纸，由用户勾 |
| [ ] | WD3 桌面的场景加载 | Windows dev，壁纸窗口模式 | 切到一张大场景、一张不能渲染的场景 | 先过渡到模糊的封面与进度（阶段名、计数、百分比），实时画面出来后淡入；不能渲染的停在清晰的封面、底部红字原因 | 以前保留上一张直到出结果 |
| [ ] | WD4 样式 | Windows dev，壁纸窗口模式 | 图片、视频、场景各试 填充 / 适应 / 拉伸 / 居中 / 平铺 | 图片与视频铺法同以前；平铺的图片重复铺满、换图也有过渡（以前硬切）；视频平铺按盖满；场景由宿主铺放 | 未测 |
| [ ] | WD5 视频壁纸 | Windows dev，壁纸窗口模式 | WPE 视频壁纸（作者设了翻转 / 颜色）、普通视频；改音量、倍速、暂停 | 作者属性照旧；先静音起播再出声；音量、倍速、暂停跟设置 | 未测 |
| [ ] | WD6 多屏与看门狗 | Windows dev，两块屏 | 各屏复制、逐屏独立下切壁纸；网页壁纸卡死时 | 每块屏各自交接；副屏不出声；网页卡死照样触发重载（ping 逐层转问） | 未测 |
| [x] | WD7 视频之后切图片 | Windows dev，壁纸窗口模式，过渡 滑入 | 当前壁纸是视频时设一张图片 | 图片立即加载并滑入（以前图片带 `loading="lazy"`，当前层是播放中的视频时新层的图一直不开始加载，8 s 以上不换） | 2026-11-15 Claude：壁纸窗口里直接换目标实测，修前 8 s 未开始加载，修后 8 ms 加载完、过渡 800 ms 播完（当时还是旧的滑入）；单测断言壁纸变体为 eager |
| [ ] | WD8 滑入推走 | Windows dev，壁纸窗口模式，过渡 滑入 | 图片、视频、网页、场景之间互切 | 新壁纸从屏幕右侧整屏滑进来、同时把旧壁纸推出左边，1.5 s，不淡入；推完旧壁纸才卸载；淡入（800 ms）、缩放（900 ms）不变、不推旧层 | 用户定（以前右移 32 px 并淡入，看不出是滑动）；单测覆盖类名、时长变量与提交时机，dev 停了未真机看 |
| [ ] | WD9 加载与报错同预览 | Windows dev，壁纸窗口模式 | 切到一张大图（加载超过 300 ms）、一张原图已删的图、一张缩略图与原图都没有的图 | 大图先过渡到缩略图再盖上原图，没有缩略图时 300 ms 后过渡到骨架；丢失的过渡到丢失图（同预览），不再保留上一张；平铺时原图出来后重复背景换成原图 | 用户定；单测覆盖骨架 / 丢失 / 缩略图的 ready 与 `displayChange`，dev 停了未真机看 |
| [x] | WD10 单测与检查（WD7–WD9） | Windows | vue-tsc；图片、壁纸组件与壁纸窗口的 vitest；Prettier；9 处变异（丢失 / 骨架 / 缩略层不 ready、懒加载、出错丢层、不推旧层、只认透明度、滑入 800 ms、平铺不跟原图） | 0 error、全过；变异全被抓到 | 2026-11-15 Claude：23 个文件 231 例全过，9 处变异全抓到 |
| [x] | WD11 桌面加载覆盖层的颜色与语言 | Windows dev，壁纸窗口模式，语言简体中文 | 切到一张场景，看加载期间的覆盖层 | 中文阶段名、墨色文字、白色半透明底，进度条有浅色轨道与粉色填充并走满，计数一行在（以前壁纸窗口没导入 `tokens.css`：黑字、看不见进度条；且一直是英语） | 2026-11-16 Claude：壁纸窗口里临时切到 15310 读算出来的样式，文字 rgb(74,21,75)、底 rgba(255,255,255,0.6)、填充 2% → 100%，阶段「解析场景并编译着色器 → 创建 GPU 渲染管线 → 提交首帧」；窗口背景仍透明；单测覆盖启动语言与 `setting-change` 切换 |
| [x] | WD12 小场景的覆盖层居中 | Windows dev，图库预览 | 预览一张分辨率很小、放大显示的场景（如 dino_run，13518），看加载中正中那块与失败后底部的红字 | 都在画面正中（以前排版宽度比场景还宽时 grid 被撑开，红字整块偏右、被画布边缘裁掉） | 2026-11-16 Claude：实测场景排版 343×193、那块 480 宽，修前中心偏右 213 px，修后与画面中心重合、离底边 4%；单测断言绝对定位与 translate 对中 |

## 设置弹窗窄窗口导航置顶

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | SN1 窄窗口 | macOS dev，主窗口 800×768 | 打开设置，切到「外观」 | 分类导航在顶部一行（图标 + 名称），选中项压暗；面板占满宽度，「颜色主题」说明不再一词一行；不显示版本号 | 2026-11-16 Claude：CDP 读到导航 `flex-direction: row`，截图确认 |
| [ ] | SN2 宽窗口与来回拖 | macOS / Windows dev | 窗口从宽拖窄再拖回 | 820px 以上回到左侧导航与底部版本号；切分类、记住上次分类不受影响 | 未测 |
| [ ] | SN3 更窄时横向滚动 | 桌面 dev | 窗口缩到导航放不下（未进入紧凑布局前） | 导航横向滚动、无滚动条，标签不换行 | 未测 |

## 网页壁纸暂停补齐 WPE 的冻结（计时器与 AudioContext）

2026-11-16。应用背景里的 Unity 网页壁纸（阿洛娜指纹识别 2.0，3756621387）暂停后仍以每秒一帧在动：rAF 停了以后，Unity 靠一个约 1 秒的 `setInterval` 兜底出帧，而垫片只冻了 rAF、CSS 动画与媒体。照 WPE `___wpxPause` 的原文补上：`setInterval` 冻结期间到点跳过，冻结期间排的 `setTimeout` 压住、恢复时补跑，实时 `AudioContext` 暂停时 `suspend`，`setPaused(true)` 在冻结之前调用。暂停中打开（应用背景）的页面先跑起来：脚本组从页面 load 后的第一个 rAF 回调起再跑 3 秒才冻。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | WF1 单测与检查 | Windows | `wpeWebVolume.test.ts`；vue-tsc；Prettier | 全过、0 error | 2026-11-16 Claude：34 条全过；vue-tsc 0 error；改动部分 Prettier 干净（`>>>` 那行是原有的）；`cargo check` 因 dev 占用文件跑不了，垫片经 `include_str!` 编进去，dev 已用新垫片重编运行 |
| [x] | WF2 变异 | Windows | 在 scratchpad 副本上做 13 处：interval 不跳过；暂停前排的 timeout 也压 / timeout 从不压；补跑前不看又冻结；`clearInterval` 不删压住的；load 后两帧就冻脚本；预热 1 秒；预热从 load 起算；恢复不解除预热；冻结不 suspend；冻结期间新建的不 suspend；suspend 不看 state；`setPaused` 顺序还原 | 每处都有用例失败 | 2026-11-16 Claude：13 处全被抓到 |
| [x] | WF3 应用背景停住 | Windows dev，应用背景开、当前壁纸 3756621387 | 重启后让主窗口可见，数 8 秒内 WebGL `clear` 的调用次数；截图 | 0 次；停在正式画面上（不是加载画面或深灰空画布） | 2026-11-16 Claude：CDP 计数 0，截图里是阿洛娜的正式画面；探针已还原 |
| [x] | WF4 预览里暂停 / 恢复 | Windows dev，图库预览 | 预览 3756621387，右键「暂停」，看十几秒；再「暂停」恢复 | 暂停后完全不动（不再每秒一帧）；恢复后接着动、可交互 | 2026-11-16 用户手测通过 |
| [x] | WF5 桌面暂停 | Windows dev，壁纸窗口模式，桌面是一张网页壁纸 | 设置里开「暂停壁纸」超过 30 秒，再关掉 | 暂停期间桌面不动、不因 ping 重载；关掉后接着动 | 2026-11-16 用户手测通过 |
| [x] | WF6 别的网页壁纸 | Windows dev，图库预览 | 一张 CSS / canvas 动画的网页壁纸、一张带背景音乐或音频可视化的；暂停、恢复；暂停期间改一个属性 | 暂停停住、恢复续上；声音随暂停停下、恢复后照旧；暂停期间改的属性恢复后生效 | 2026-11-16 用户手测通过 |
| [ ] | WF7 macOS / Linux | macOS、Linux | 同 WF4、WF6 | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 动画层的建删（P12e）

2026-11-16。图层上的 `createAnimationLayer` / `playSingleAnimation` / `destroyAnimationLayer`（图像层 puppet 与带骨骼的模型），连带：
- MDLA 动画全编，没被引用又不支持的只留占位、不报；
- 动画层改按层 id 记（编译期 = JSON 下标，运行时建的是负数）；
- 回调循环照 WPE（本帧有层播完才进、调过回调复位下标、循环后删单次层）；
- 删层分「当场摘表」与「本帧脚本之后释放」两段；跨重编译按 id 接回。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12e-createlayer.md`；
- 读码与实测：`rea-p12e-createlayer.md`（末尾「实测」）；
- 工程与对照：`ignore/p12/e/`（生成器 `defs/p12e.py`、工程 `proj/p12-create`、WPE 日志 `logs/step0.log`、语料 `corpus/`、对照 `check/`）；
- 抓帧：`A:\p12e\step0\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PE0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc 与相关 vitest | 0 error，相关测试全过 | 2026-11-16：tsc 0 error；puppet / compile / script / dev / host 66 个文件 1138 例与 render 里读 puppet 的 3 个文件全过；计划列的变异全部杀死（一处等价写法换了改法后杀死） |
| [x] | PE1 语料 | Node | `kbp corpus scan --extra puppetBytes` 工作区快照对 HEAD | 不支持键逐张不变；体积与编译用时不异常 | 2026-11-16：233 张键逐张不变、干净 194 → 194；puppet 动画数据 36.4 → 49.7 MB（最大 `3706286085` 14.2 MB），全库编译 91.4 → 94.2 s |
| [x] | PE2 `p12-create` 日志逐行 | Node 夹具 + Windows dev 探针 | 按 WPE 帧时间回放 268 帧，比 `[kbp]` 日志 | 545 行与 WPE 逐行相同 | 2026-11-16：夹具（`puppet/p12create.test.ts`）与 dev 宿主里的探针都逐行相同 |
| [x] | PE3 `g_Bones` 对照 | Node 夹具 | 脚本帧 241、242 五个 puppet 的 `g_Bones` 对 WPE 抓帧 | 在 `rsqrtps` 容差内 | 2026-11-16：480 个数 470 个逐位相同，最大 5.96e-8（4 ulp） |
| [x] | PE4 P12a–d 生成工程不变 | Windows dev | 8 个生成工程按原时间线重渲 22 帧，和 P12d 留下的帧比 | 逐字节相同 | 2026-11-16：22 / 22 逐字节相同 |
| [x] | PE5 宿主接线 | Windows dev | 实时预览 `p12-create` 十几秒，看 `host.puppets()` | 各 puppet 最终层数同 WPE，`detached` 为 0，没有新告警 | 2026-11-16：main 29、destroy 1、cb1 1、cb2 2 层，同 WPE；`detached` 全 0 |
| [x] | PE6 2887099508 点书翻页 | Windows dev，图库预览 | 预览 2887099508，等开场镜头结束后点书 | 手翻一页书，脚本不报 `is not a function`；应用日志里没有这张的脚本出错 | 2026-11-16 用户在预览里点书确认翻页正常（探针模拟点击没点中：开场镜头推近） |
| [ ] | PE7 非 Windows | macOS、Linux | 同 PE5、PE6 | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 绘制顺序（P12f）

2026-11-19。网格 0 带 bit3 的 puppet 按动画的绘制顺序轨道改变绘制组的先后，连带：
- 键 = `trunc(f32(骨骼基数 + 组偏移) + cur)`，`cur` 每帧复位成骨骼基数后逐可见层写（覆盖 / 混合 / 加法，加法减骨骼基数并钳制）；
- 有写入且当前顺序不是非降序时稳定排序，顺序跨帧保留（并列保持上一次的顺序；没写入、层隐藏或删掉、运行中改属性都不重置）；
- 有裁切记录时按新顺序重建命令表，渲染器改为编码时按当前命令表现排，每个绘制模板一块私有索引缓冲。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12f-draworder.md`；
- 读码：`rea-p12f-draworder.md`；实测：`ignore/p12/f/meas/REPORT.md`（含补测 `p12f-rebuild`）；
- 工程与对照：`ignore/p12/f/`（生成器 `defs/p12f.py`、工程 `proj/`、WPE 日志 `logs/`、夹具生成 `fix/mkfix_f.py`、对照与变异脚本 `impl/`、结果 `out/`、回归帧 `reg/`）；
- 抓帧：`A:\p12f\order\`、`A:\p12f\rebuild\`、`A:\p12f\iso-sl\`、`A:\p12f\iso-eye\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PF0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、相关 vitest、Prettier | 0 error，相关测试全过 | 2026-11-19：tsc 0 error；`puppet/`、`compile/p12*`、`compile/puppet` / `mdl`、`render/` 全过；变异 24 个全部杀死（P12f-1 15 个、P12f-2 9 个）。带 `KABEGAME_WPE_ROOT` 的本机语料用例另有 4 条失败（`refract` 的 `tex:animation:multi-image`、`pipeline` 语料界限、`scriptApi` 的 3304642534 两条），去掉 P12f 的改动在 HEAD 上同样失败，与本节无关 |
| [x] | PF1 语料 | Node | `kbp corpus scan`，范围同 `ignore/p6/e0/corpus-now4.json`（myprojects 60 个目录用 `--project`） | 只去掉 `puppet:draw-order`，没有新键 | 2026-11-19：293 张，干净 286 → 288（`3577990983`、`3841310696`），`clean_lost` 0，`puppet:draw-order:base` 0 处 |
| [x] | PF2 生成工程逐帧顺序 | Node 夹具 + Windows dev | `p12f-order` 按 WPE 帧时间回放，第 240 / 242 / 248 / 252 帧比每个 puppet 的绘制组序列 | 与 WPE 抓帧逐个相同 | 2026-11-19：夹具（`puppet/p12f.test.ts`）与 dev 真渲染器的逐 draw 轨迹都 29 个 puppet-帧逐个相同，绘制数同 WPE；补测 `p12f-rebuild`：运行中改 `size` / `colorBlendMode` / 可见性，WPE 不重置顺序 |
| [x] | PF3 真实壁纸复制工程 | Windows dev | `3577990983` 的 `sl`、`3841310696` 的 `眼睛` 各 100 帧按 WPE 日志回放，整帧比；抽一帧比索引 | 整帧只有取整级差；索引逐个相同 | 2026-11-19：两张 100 帧最大差 2、没有 > 2 的像素；`sl` 第 220 帧 4 次绘制、`眼睛` 第 230 帧 6 次绘制的索引与 WPE 逐个相同（这段时间 `眼睛` 重排 17 次） |
| [x] | PF4 P12a–e 生成工程不变 | Windows dev | P12e 走查的 8 个生成工程按原时间线重渲 22 帧，和当时的帧比 | 逐字节相同 | 2026-11-19：22 / 22 逐字节相同（含裁切的 `p12-clip2`） |
| [ ] | PF5 预览里看两张壁纸 | Windows dev，图库预览 | 预览 `3577990983`、`3841310696` 各看半分钟 | 能实时渲染，不再停在预览图；人物部件的前后遮挡随动画变化正常，眼睛等裁切部位不闪、不漏 | 需要人看 |
| [ ] | PF6 非 Windows | macOS、Linux | 同 PF5 | 同 Windows | 本机不能测 |

## 场景壁纸 puppet 骨骼的局部读写（P12g）

2026-11-20。图像层 puppet 的 8 个骨骼脚本方法（`getBoneIndex`、`getBoneParentIndex`、`get/setLocalBoneTransform`、`Angles`、`Origin`）：
- 写局部矩阵后当场重算这根骨骼与子孙（完整 4×4 乘法、调用时刻的图层矩阵），当帧生效、下一次推进盖掉；
- MDLA 事件与播完回调挪到层循环之后、蒙皮之前派发（同 WPE）；`setBoneTransform` 的图层矩阵也改成调用时刻的。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase12/phase-12g-localbones.md`；
- 读码：`rea-p12g-localbones.md`；实测：`ignore/p12/g/meas/REPORT.md`；
- 工程与对照：`ignore/p12/g/`（生成器 `defs/p12g.py`、工程 `proj/`、WPE 日志 `logs/`、夹具生成 `fix/mkfix_g.py`、对照与变异脚本 `meas/`、`impl/`、结果 `out/`、回归帧 `reg/`）；
- 抓帧：`A:\p12g\local\`、`A:\p12g\args\`、`A:\p12g\wpe-3820240793-iso-pup-fps20-1280x720\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PG0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、相关 vitest、Prettier | 0 error，相关测试全过 | 2026-11-20：tsc 0 error；`puppet/`、`script/p12*`、`compile/puppet` / `p12*` / `scriptApi*`、`render/p12*` 30 个文件 573 过；变异 8 + 抽查 5 个全部检出 |
| [x] | PG1 语料 | Node | `kbp corpus scan`，范围同 P12f 加 `3820240793`，同一基点 `aeebf031` 有无 P12g 各扫一次 | 只去掉 `3820240793` 的 3 个键，没有新键 | 2026-11-20：294 张，干净 293 → 294（全部干净） |
| [x] | PG2 生成工程 | Node 夹具 + Windows dev | `p12g-local`（13 个 puppet）、`p12g-args` 按 WPE 帧时间回放，比日志读回值与抓帧 `g_Bones` | 与 WPE 逐字、逐位相同 | 2026-11-20：夹具（`puppet/p12g.test.ts`）读回值逐字、`g_Bones` 逐位相同（动画驱动的 le1–le4 有已知的四元数差）；dev 真渲染器跑脚本回放，第 129、528 帧 13 个 puppet 的 `g_Bones` 与挂点子图层的 MVP 全部逐位相同 |
| [x] | PG3 真实壁纸复制工程 | Windows dev | `3820240793` 只留对象 0，100 帧按 WPE 日志回放、跑脚本，整帧比；抽一帧比 `g_Bones` | 整帧只有取整级差；`g_Bones` 逐位相同 | 2026-11-20：第 271–370 帧最大差 2、没有 > 2 的像素；第 300 帧 `g_Bones` 逐位相同 |
| [x] | PG4 P12a–e 生成工程不变 | Windows dev | P12e 走查的 8 个生成工程按原时间线重渲，和 P12f 回归的帧比 | 逐字节相同 | 2026-11-20：22 / 22 逐字节相同（`ignore/p12/g/impl/reg_p12.py`，帧在 `ignore/p12/g/reg/`）；P12c / P12e 的脚本工程由夹具回放兜底 |
| [ ] | PG5 预览里看这张壁纸 | Windows dev，图库预览 | 预览 `3820240793` 看半分钟 | 能实时渲染，不再停在预览图；新娘随呼吸起伏、头轻微摆动，没有抖动或跳变 | 需要用户看 |
| [ ] | PG6 非 Windows | macOS、Linux | 同 PG5 | 同 Windows | 本机不能测 |

## 场景壁纸「强制渲染」设置

2026-11-17 Windows dev。WPE 设置字段组加开关「强制渲染」（只对场景，默认关）：桌面是全局键 `wpeSceneForceRender`（设置页「壁纸设置」），预览与应用背景是这张壁纸的预览设置 `forceRender`（预览右侧边栏）；打开一律先确认（`confirmWpeForceRender`）。值经场景设置消息交给宿主，变了整场重新加载，开着时有不支持项也照常渲染（原来只有 dev 的 `localStorage` 开关）。预览里场景显示不了时，底部红字原因下面有「我就要看」链接；名称右边的警告色「强制渲染」只看设置。计划见 `.claude/plans/wpe-import/phase-force-render.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | FR1 单测与检查 | Windows | `preview_settings` 单测与 cargo check；vue-tsc、宿主 tsc；`wpeSettings`、`wpeForceRender`、`WpeSettingsFields`、`WallpaperPointerOverlay`、`WpeLoadingOverlay`、`ImageContent.wallpaper`、`WpeSceneView`、`wpeSceneStyle`、壁纸窗口、预览弹窗与宿主 `host` / `sceneStyle` 的 vitest；Prettier | 0 error、全过；变异全被抓到 | 2026-11-17 Claude：core `preview_settings` 7 例过；应用 crate 的 cargo check 因 dev 占着 CEF 的 DLL（os error 32）没跑成，重启 dev 时会编到；vue-tsc、宿主 tsc 0 error；应用相关 32 个文件 351 例中只有 `wpeWebVolume.test.ts` 4 例既有失败（`History is not defined`，来自 `807bf80e` 的垫片改动，与本项无关），宿主 54 例全过；12 处变异全抓到 |
| [ ] | FR2 「我就要看」 | Windows dev（重启后的新构建），图库预览 | 预览一张显示不了的场景（如 dino_run，13518），点红字原因下面的「我就要看」，先点取消、再点打开 | 链接是文字不是按钮、悬停手形；取消什么都不变；打开后立刻回到加载初态（缩略图模糊、进度从 0 走），再渲染出来，名称右边出现警告色「强制渲染」，右侧预览设置里的开关是开的 | 要重启 dev（加了 Rust 命令与预览设置键） |
| [ ] | FR3 预览侧栏开关 | Windows dev，图库预览 | 在右侧预览设置里打开 / 关掉「强制渲染」 | 打开先弹同一个确认框，取消后开关仍是关；打开 / 关掉都立刻回到加载初态、进度从 0 重走；关掉不确认、加载完回到封面与红字原因，标题的标记消失 | |
| [ ] | FR4 设置页（桌面） | Windows dev，壁纸窗口模式 | 设置页「壁纸设置」打开「强制渲染」，桌面换成一张显示不了的场景 | 没开时桌面的红字原因下面是一行文字「可以打开壁纸设置 -> 强制渲染」（不是链接）；打开先确认，桌面上的场景照常渲染；关掉后回到封面与那行文字 | |
| [ ] | FR5 应用背景与不该出提示的地方 | Windows dev | 把一张显示不了的场景（如 dino_run）设为当前壁纸并开应用背景；预览里加载超时的场景；已开强制渲染仍画不出来的场景 | 应用背景直接强制渲染出来（不看这张的预览设置）；后两种都没有「我就要看」 | |
| [x] | FR7 开关是刷新键（单测） | Windows | `ImageContent.wallpaper` 的 vitest；vue-tsc；Prettier；变异（key 不带开关、切换时不回初态） | 场景切换开关时实时画面重挂、进度回到 `page` / 0、底部原因收起、缩略层不动且不再发 ready；网页壁纸不重挂；变异都被抓到 | 2026-11-17 Claude：`components/image/` 5 个文件 38 例过，vue-tsc 0 error，两处变异都抓到 |
| [x] | FR8 粒子预热封顶 | Windows dev | 单测：小 `starttime` 跑满、`starttime 100000` 封顶且 1 s 内、等于缩短 `starttime`、可复现；粒子目录 vitest、宿主 tsc；真机：屏外宿主对 15030（麻匪 Elisa）开强制渲染 | 粒子 27 个文件全过；15030 的「开始渲染」日志里建 GPU 场景不超过 1 s | 2026-11-17 Claude：599 例全过、tsc 0 error；15030 用时 42886 → 3681 ms（建 GPU 场景 39584 → 660 ms）；预览里重新打开那一张还要你看一眼 |
| [ ] | FR6 非 Windows | macOS、Linux | 同 FR2、FR3 | 同 Windows（Linux 没有覆盖层，链接直接可点） | 本机不能测 |

## 播放速度（预览控制条与壁纸设置「倍速」）
| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PS1 单测与检查 | Windows | 宿主 `sceneStyle` / `host` / 帧时钟 / 视频纹理 / 声音的 vitest 与 tsc；应用 `PreviewSpeedControl`、`ImageContent`、`WpeSceneView`、`wpeSceneStyle`（字面量与范围比对）、`wpeSettings`、预览弹窗的 vitest 与 vue-tsc；core `preview_settings`；Prettier；变异（不交倍速给实时画面、场景拿不到控制条的值、先乘后钳） | 全过；变异都被抓到 | 2026-11-17 Claude：宿主相关 13 个文件全过、tsc 0 error；应用相关 38 个文件只有 `wpeWebVolume.test.ts` 4 例既有失败（`History is not defined`，来自 `807bf80e`）；core 7 例过；3 处变异都抓到；屏外宿主不跑帧循环，没法在那里看实际速度 |
| [ ] | PS2 普通视频 | Windows dev，图库预览 | 预览一个视频，控制条上悬停倍速按钮选 2×、0.25×，再点按钮；换到下一个视频 | 按钮显示当前倍数；播放速度跟着变；点按钮回到 1×；换视频回到 1×；关掉预览再打开也是 1×（不保存） | |
| [ ] | PS3 视频壁纸 | Windows dev，图库预览 | 预览一张 `x-wpe/video`，右栏「倍速」设成 1.5，再在控制条里改成 3 | 控制条从 1.5 起步；改成 3 后右栏仍是 1.5（不写回）；换图回来又是 1.5 | |
| [ ] | PS4 场景壁纸 | Windows dev，图库预览 | 预览一张有动画 / 粒子 / 声音的场景（如带时钟或频谱的），控制条倍速选 4×、0.25× | 动画、粒子、关键帧、视频纹理、声音一起变快 / 变慢，不重新加载；网页壁纸的控制条没有倍速按钮 | |
| [ ] | PS5 和帧率正交 | Windows dev，图库预览 | 同一张场景，帧率设 10 与 60，各开 2× 看同一段动画的快慢 | 两种帧率下整体速度一样（10 fps 只是更卡），不会因为帧率低变慢 | |
| [ ] | PS6 设置页与桌面 | Windows dev，壁纸窗口模式 | 设置页「壁纸设置」的「倍速」拖到 4，桌面放场景与视频壁纸 | 滑条范围 0.25–4；桌面的场景与视频都按 4× 放；拖回 1 恢复 | |

## 场景壁纸文字的 MSDF（描边、模糊、投影，P6f）与 `backgroundcolor` 字段脚本

2026-11-19 Windows dev。文本对象打开 `msdf` / `outline` / `blur` / `dropshadow` 任一个时整层走多通道距离场：`wpefont` 编进 msdfgen v1.13（子模块 `third/msdfgen`）生成格子，字体键与字号无关、RGBA8 图集，四边形外扩 `pad`，`basefont_msdf` 按三位 COMBO，每次绘制现算 `g_RenderVar0..3`；装饰参数绑属性就地写。`backgroundcolor` 字段脚本有了写回目标（背景常量，当帧生效）。走查中查出 wpefont 的 FreeType 要开 `FT_CONFIG_OPTION_USE_HARFBUZZ`（只经 GSUB 到达的字形的 hinting），一并修了。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | M0 单测与检查 | Windows | wpe-scene vitest（`text`、`wpefont`、`render/text*`、`msdfVars`、`compile/texts`、`script`、`host.script` 等 48 个文件）、`tsc`；`deno task build:wpefont` | 全过 | 2026-11-19 Claude：48 文件 885 条；MSDF 格子与 WPE 图集逐字节（11 个字形的 SHA-1）、p6f-grow 94 个装箱位置、p6f-deco 11 组 `g_RenderVar`、四边形顶点逐位相同 |
| [x] | M1 图集逐字节 | Windows，Node 对照 | `ignore/p6/f0/msdf/cmp.mjs`：p6f-atlas / deco / fx / grow 的 WPE 图集（RenderDoc 导出）对 msdfgen v1.13 + WPE 外围流程 | 9 张图集、148 个格子逐字节相同 | 2026-11-19 Claude：开 / 不开 `USE_HARFBUZZ` 都相同 |
| [x] | M2 生成工程整帧 | Windows dev，屏外宿主（dev 探针，canvas 1920×1080） | `p6f-atlas`、`p6f-deco`、`p6f-fx`、`p6f-grow` 和 WPE 上屏帧比（排除 FR / CLK） | 0 差异 | 2026-11-19 Claude：4 张全 0；deco 覆盖描边 5.1 上限、模糊让位、投影 6 上限 / 负偏移 / 不透明度 > 1、缩小与放大 |
| [x] | M3 语料复制工程走查 | Windows dev，屏外宿主（脚本按录制的 `Date` 起点，canvas 1280×720） | `ignore/p6/f2/proj/<ID>-iso-msdf`：3833971732、3816870245、3829268059、3593919489 和 WPE 录制帧整帧比 | 逐像素相同 | 2026-11-19 Claude：4 张全 0。3816870245 开了相机视差，用 `input_start` 给 WPE 喂中心光标、回放 `cursors: "log"` 后为 0（第一次录制没控光标，整组文字偏几像素）；3833971732 冒号（HarfBuzz 替换出的 gid 20066）差 1 像素，开 `USE_HARFBUZZ` 后为 0 |
| [x] | M4 `backgroundcolor` 字段脚本 | Windows，WPE 抓帧 | `p6f-bg`（返回 `Vec3` / 字符串 / 数字轮换） | 当帧生效；数字铺满、字符串不写 | 2026-11-19 Claude：WPE 4 帧逐帧核对；我们的写回规则与之相同（`script/runtime.test.ts`） |
| [x] | M5 语料 | Windows | `kbp corpus scan`（含 myprojects）前后比 | 干净 286 → 290，只多这 4 张，别的不变 | 2026-11-19 Claude |
| [ ] | M6 真机预览与桌面 | Windows dev，图库预览与壁纸窗口 | 预览 3829268059（红色描边 + 投影 + 模糊的时钟）、3816870245（带模糊 effect 的日期时钟），再设为桌面 | 文字带描边与投影，时钟每分钟换字不闪、不整场重载；改「场景后处理」等设置后照常 | |
| [ ] | M7 装饰属性就地改 | Windows dev，图库预览 | 自建工程：文字开描边，`outlinethickness` / `dropshadowoffset` 绑滑块，在右栏拖动 | 拖动时当帧变化、不重新加载；开关（`outline`）绑属性时切换会重编这一个对象 | |

## 场景壁纸 P7f：片元读顶点的 varying 与 `gl_Position`

2026-11-20 Windows。工坊 effect「Silk」（`workshop/3649458761/effects/silk`）的片元着色器没声明就读 `v_TexCoord`，还读 `gl_Position` 当屏幕位置；WPE 两阶段共享一份 `VS_OUTPUT`（片元的 varying 列表整体换成顶点那份，末尾是 `gl_Position : SV_POSITION`），能编译，我们报 `Unknown variable: v_TexCoord`，整张退回预览图（myprojects `3823412318` 的四个对象都挂着它）。翻译器照做两件事：片元声明正文用到的顶点 varying（只补用到的）；片元的 `gl_Position` 换成 `vec4(gl_FragCoord.xyz, 1.0 / gl_FragCoord.w)`（写它照报）。原来能翻译的输出逐字节不变。说明见翻译器 README「改写」「HLSL 隐式转换 → 改写阶段」，记录见 `.claude/plans/wpe-import/3-scene/phase7/phase-7f-fragment-interface.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | S1 WPE 的规则 | Windows，读码 + WPE 抓帧 | rea-p7-shader §2.6 / §4；`capture_wallpaper` 抓 `3823412318`（1280×540，`A:\silk\wpe\`），看 Silk pass 的像素着色器 | WPE 编得过、画的是 Silk 本体 | 2026-11-20 Claude：event 73 是 Silk 本体（不是暗红回退），`dcl_input_ps linear v0.xy`（没声明的 `v_TexCoord`）、`dcl_input_ps_siv linear noperspective v1.xy, position`（`gl_Position`），`div r1.xy, v1.xyxx, g_Screen.xyxx` |
| [x] | S2 翻译器单测与基线 | Windows，cargo | `cargo test -p wpesl2wgsl --lib`；在 `f05e75e9` 重录全语料加 `3823412318` 的请求夹具（1369 个）并导出基线，改后重放比较 | 全过；只有 Silk 从失败变通过 | 2026-11-20：lib 120 个全过；6280 个文件相同 6280、变了 0、新失败 0，新通过只有 Silk `50bc303d` 的 4 个文件；`ok` 与夹具全部一致；WPE 安装目录 166/167、几何 27/27、WGSL 回读失败 0 不变 |
| [x] | S3 变异检查 | Windows，cargo | `ignore/silk/mutate/mutate.py`：片元不并入用到的 varying、不换 `gl_Position`、宏的 w 不取倒数、不输出宏 | 都被单测检出 | 2026-11-20：4 / 4，按原字节还原 |
| [x] | S4 语料 | Node，`kbp corpus scan` / `diff` | 全语料 233 张前后各扫一次；myprojects 210 张用同一份产品源码配新旧 wasm 各扫一次 | 只有 `3823412318` 变干净 | 2026-11-20 Claude：233 张前后都干净、0 变化；myprojects 干净 206 → 207，只多 `3823412318`，没有变坏的（出错的 1 张前后都是缺 `scene.json`） |
| [x] | S5 与 WPE 整帧对照 | Windows dev，屏外宿主 + WPE 抓帧 | `render_scene` 15851（canvas 1280×540、`g_Time` 13.51435、后处理 ultra，同 WPE 设置）对 WPE 上屏帧，挖掉顶部中间的文字（探针不跑脚本） | Silk 的色调一致 | 2026-11-20 Claude：差 ≤ 1 的 98.86%，p99 = 2，平均 0.40；更大的差是随机的雨滴粒子 |
| [ ] | S6 预览与桌面 | Windows dev，图库预览与壁纸窗口 | 图库预览打开 `3823412318`，看一会儿；再设为桌面 | 不再停在预览图；花的色调随时间缓慢流动，日期 / 时钟文字也带 Silk 的色调，和 WPE 打开同一张观感一致 | 待用户确认 |

## 界面里的「WPE」写全称

2026-11-20。用户看得到的文字里「WPE」一律改成「Wallpaper Engine」：内建插件 `wpe-import` 的名字（「壁纸导入」→「Wallpaper Engine 壁纸」，五种语言）、本地收集来源「WPE 壁纸」、网格角标「WPE · 视频 / 网页 / 场景」、壁纸设置的「跟随 WPE」（帧率、场景后处理、场景反射，阴影与体积光本来就是全称）及其说明、使用文档「Wallpaper Engine 壁纸」「画廊」两页。`WPESL → WGSL`（着色器语言名）、标签目录 `WPE/…`（标签的 key，改了要迁移）、日志与代码注释不改。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | N1 插件名 | Windows dev | 看插件页、任务列表、图片详情的来源名 | 显示「Wallpaper Engine 壁纸」（其它语言对应） | |
| [ ] | N2 收集来源与角标 | Windows dev | 打开「本地」收集对话框；画廊里看视频 / 网页 / 场景壁纸的角标 | 来源分段写「Wallpaper Engine 壁纸」且不挤；角标写「Wallpaper Engine · 视频」等，窄格子里不溢出 | |
| [ ] | N3 跟随 Wallpaper Engine | Windows dev | 设置页壁纸设置、预览右栏的帧率 / 后处理 / 反射下拉 | 选项写「跟随 Wallpaper Engine」，说明文字同步 | |

## 虚拟盘（画册盘）功能下线

2026-11-20。虚拟盘彻底物理删除：`kabegame-core/src/virtual_driver/`（12 文件 2683 行）、`vd_listener.rs`、`vd_ops.rs`、`providers/dsl/images/vd/`（55 个 DSL）与 `images_root_provider.json5` 里唯一的 `vd` 引用、SQL 函数 `vd_display_name`、`vd_en_US_month/day` globals、6 个 Tauri 命令、7 个 IPC 变体与 `IpcResponse` 的 `mounted` / `mount_point`、两个设置键、`core_init.rs` 的启动挂载块、`build.rs` 的 Dokan delay-load 与 macOS `-Wl,-weak-lfuse`、Cargo 的 `virtual-driver` / `vd-legacy` feature 及 `dokan` / `fuser` / `memmap2` / `widestring` / `winapi` / `lru` / `Win32_UI_Shell` 依赖、前端 `AlbumDriveSetting.vue` 与 10 处入口、五语言 i18n、构建脚本的 Dokan 复制与 `assertNoLinuxLibfuseLink`、CI 的 macFUSE、`bin/windows/dokan-installer.exe`。`IPC_PROTOCOL_VERSION` 维持 5（这些面本就被 feature 门控，CLI 不开该 feature，两个响应字段是 `Option` + `serde(default)`）。新增设置迁移 `v006_drop_album_drive`（`LATEST_VERSION` 5 → 6）清掉 `albumDriveEnabled` / `albumDriveMountPoint`；挂载本身在主进程内，旧进程退出即消失，不写卸载代码，用户自装的驱动不替其卸载。顺带收尾 v4.3.0 已下线的 light 模式残骸（`__LIGHT_MODE__` 本就 `=== isAndroid`，`!IS_LIGHT_MODE` 换成 `!IS_ANDROID`，行为零变化）。文档站的 `guide/virtual-drive` 保留 slug、正文换成下线说明页（站内链接全删、成为孤立页），`versions/vX.Y.Z/` 历史 changelog / regression / 4koma 快照与 `.claude/plans/` 旧计划原样保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | V1 pathql-rs | Windows, cargo | `cargo check -p pathql-rs` + `cargo test -p pathql-rs` | 删掉 VD DSL 与按真实路径断言的两个集成测试后全绿 | 2026-11-20：441 passed / 0 failed（lib 415） |
| [x] | V2 设置迁移 | Windows, `deno task test` | `deno task test -c kabegame-core settings::migrations` | v006 幂等、缺键不变、单键删除、非对象忽略全过；迁移链跑到 v6 | 2026-11-20：31 passed / 0 failed，含 v006 五个用例 |
| [x] | V3 前端类型 | Windows, vue-tsc | `apps/kabegame` 下跑 `vue-tsc --noEmit` | 删 VD 入口与 light 残骸后无死导入（`IS_LIGHT_MODE`、`HardDrive`） | 2026-11-20：exit=0 |
| [ ] | V4 全量 check | Windows, `deno task check` | 前端 vue-tsc + `cargo check -p kabegame --features standard` | 两边全绿 | 2026-11-20 被环境阻断，待重跑：本机开着 dev app（`target/debug/kabegame.exe` + 9 个 CEF helper），`cef-dll-sys` 的 build script 要把 CEF 运行时 `copy_directory` 进 `target/debug/`（先 `remove_file` 再 `copy`），DLL 被占用故报 `os error 5`。与本次改动无关：失败在依赖图最底层的第三方 crate build script，还没编到 kabegame 代码；同一棵树上 V1 / V2 / V3 均已全绿，阶段 2 完成时这条命令曾 exit=0。关掉 dev app 后重跑即可 |
| [x] | V5 i18n 五语言键 | Windows, 脚本比对 | 对 settings / help / albums / header / contextMenu / web 六个 json 做键集并集比较 | 删键后五语言不出现新的不一致 | 2026-11-20：settings / header / contextMenu / web 完全一致；help 的 `tipsContent`、albums 的 `localFolder.duplicatePathHint` 在 ja / ko 缺失，已用 `git show HEAD:` 核对为删除前就存在 |
| [x] | V6 文档站与死链 | Windows, astro | 临时 `--outDir` 跑 `npx astro build`；grep 指向说明页的站内链接 | 构建成功；除说明页自身外零引用 | 2026-11-20：35 page(s) built；指向该页的站内链接零命中 |
| [x] | V7 构建脚本 | Windows, deno | `deno check` os-plugin / release-plugin / mode-plugin | 删 Dokan 复制与 libfuse 校验后类型无错，无未用 import | 2026-11-20：三个文件 Check 通过；`scripts/` `.github/` `.gitignore` 的 dokan / macfuse / libfuse / fusermount 零命中 |
| [x] | V8 全仓残留 | Windows, grep | 按 `virtual_driver` / `albumDrive` / `dokan` / `macfuse` / 虚拟盘 / `LIGHT_MODE` 等模式扑全仓 | 只剩刻意保留项 | 2026-11-20：src-tauri 零残留；其余命中均为「符号链接 / 网络盘 / 虚拟盘上的文件只移出图库」通用安全语义（docs 3 + i18n 6 + DOWNLOADER_FLOW 1）与下线说明页自身 |
| [x] | R1 启动 | Windows dev | 跑 `deno task dev -c kabegame`，看启动页走到 Ready | 不 panic（DSL 校验失败会直接 panic，是最大风险点） | 2026-11-20 Claude 实测：dev app 正常跑到 Ready（pid 923204 + 9 个 CEF helper），`get_album_drive_enabled` 返回 `Command not found` 证明是新二进制；启动日志无 panic、无 DSL 校验错误 |
| [x] | R2 设置高级分区 | Windows dev | 设置 → 高级 | 画册盘开关与挂载点两行消失；超级模式 / Web 服务器 / MCP 三项仍在且可用；分区摘要为「Web 服务器 · MCP」 | 2026-11-20 Claude 实测并截图：画册盘开关与挂载点两行已消失，`/画册盘|挂载点|虚拟盘/.test(body)` 为 false；Web 服务器（运行中）与 MCP 能力仍在且可用 |
| [x] | R3 画册入口 | Windows dev | 画册页顶栏；右键任意画册 | 「打开虚拟盘」按钮与菜单项消失；其余 header feature 排布正常（`withVd` 删后不漏项）；「浏览」等动作图标正常（`FolderOpen` 是共享图标） | 2026-11-20 Claude 实测：顶栏按钮为画册信息 / 刷新 / 新建画册 / 任务 / 新建 / Kamechan，无「打开虚拟盘」；`createAlbumActions` 返回 13 项（browse、createSubAlbum、createLabelChild、syncNow、setSyncMode、openLocalFolder、convertToNormal、setWallpaperRotation、stopWallpaperRotation、rename、setLabelKey、moveTo、delete），无 openVirtualDrive，且共享图标的 browse / openLocalFolder 仍在；`HeaderFeatureId` 26 项里无 openVirtualDrive |
| [x] | R4 四个网格 | Windows dev | 画廊 / 画册 / 任务 / 畅游各翻页与看计数 | 查询、分页、计数照常（确认删 55 个 VD DSL 没波及 gallery 侧） | 2026-11-20 Claude 实测：`pathql_list images://` 只回 gallery、rank（vd 已消失）；`images://gallery` 23 个维度计数正常（all 11509、no-album 7255、hide 9489、album 成员 67514、task / surf 各 11509）；画廊页截图共 9489 张、1/10 页、缩略图正常加载；`images://gallery/task` 列举回 17916 行结构化数据 |
| [x] | R5 文件夹画册校验 | Windows dev | 新建同步画册，选一个目录 | 路径校验仍工作（`local_folder_forbidden_roots` 已连函数删除，原「路径为 None 则过滤」语义保留为 `filter(|dir| dir.path.is_some())`） | 2026-11-20 Claude 实测：`add_local_folder_album` 传不存在的 syncFolder 正常报「无法访问 sync_folder:(os error 3)」，未 panic、未建出画册 —— 删掉 `local_folder_forbidden_roots()` 与两处调用点后校验链路完好 |
| [x] | R6 升级迁移真机 | Windows dev | 拿一份带 `albumDriveEnabled` / `albumDriveMountPoint` 的旧 `settings.json` 启动 | 迁移到 `schemaVersion: 6`、两个键消失、生成 `settings.json.bak-v5`，其余设置不变 | 2026-11-20 Claude 实测：日志 23:28:52 出现 `kabegame_core::settings::migrations: v006: drop_album_drive`；`.kabegame/debug/data/settings.json` 的 schemaVersion = 6，两个键均不存在；同目录生成 `settings.json.bak-v5`（1790 → 1726 字节） |
| [~] | R7 挂载点不残留 | Windows | 旧版本开着画册盘挂载盘符，退出后装新版启动 | 资源管理器里不再出现该虚拟盘盘符 | 2026-11-20 Claude 部分验证：本机盘符为 A/C/D/E/F/G/I/J，无 K:（默认挂载点），当前无残留。完整的「旧版本挂载 → 升级 → 盘符消失」链路需要装旧版本的环境，本机未做 |
| [~] | R8 插件页「管理来源」 | Windows dev + Android dev | 宽屏标题栏与紧凑折叠菜单两处 | 桌面仍可见可用、Android 仍隐藏 —— 这是 `!IS_LIGHT_MODE` → `!IS_ANDROID` 唯一有行为的替换点 | 2026-11-20 Claude 实测桌面侧：插件页「管理源」「导入源」按钮均存在且 disabled=false；`env.ts` 导出里已无 `IS_LIGHT_MODE`（阶段 5 真机生效）。Android 侧需真机，未做 |

## 场景壁纸脚本自定义几何（P14，`IModelData`）

2026-11-21。场景脚本的 `thisScene.createModelData` / `destroyModelData` 与句柄的 `applyData` / `replaceData`。

实现：
- 主线程数据仓 `ModelDataStore` 存字节与版本，编译只看描述，`general.precache` 的材质预编成模板；
- 建层时能拼就在主线程同步拼片段、当帧画出，否则走 Worker；
- GPU 按 `(token, 形状)` 共用缓冲、每帧按版本重写。

和 WPE 有意不同：
- WPE 的缺陷 D1–D14 不复现；
- 读帧缓冲的模型画之前拷快照（E16）。WPE 不拷，3834692798 的正片叠底部件在 WPE 里是半透明黑。

依据与记录：
- 计划：`.claude/plans/wpe-import/3-scene/phase14/phase-14-model-data.md`；读码：同目录的 `rea-p14-script.md`、`rea-p14-exe.md`；
- 工程与对照：`ignore/p14/`（`0/` 生成器与 WPE 帧、`3b/` 变异与 `-pc` 变体、`4/` Karin 复制工程与对照）；
- 抓帧：`A:\p14\format\`、`A:\p14\apply\`、`A:\p14\fb1b\`、`A:\p14\fb2\`、`A:\p14\karin-fixed\`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | PM0 单测与检查 | Windows | `apps/wpe-scene` 的 tsc、相关 vitest、变异 | 0 error，相关测试全过，变异检出 | 2026-11-21：tsc 0 error；步骤 3b 提交树上 94 个文件 2088 过；每一步都做了变异（`ignore/p14/*/mutate.py`），3b 的 28 处杀掉 25 处，剩下 3 处在探针闭包里、由 PM2 的真机渲染覆盖；前几步活下来的是等价变异或已补测试 |
| [x] | PM1 语料 | Node | `kbp corpus scan` 全语料，步骤 2 与 3b 各扫一次 | 3834692798 干净，没有新键 | 2026-11-21：234 / 234 干净（`ignore/p14/3b/karin.json`），与步骤 2 无键变化 |
| [x] | PM2 生成工程画面 | Windows dev | `p14-format`、`p14-apply`（含加 `precache` 的变体）探针渲染，和 WPE 抓帧比 | 整帧 0 差异 | 2026-11-21：format 0 差异（Worker 路与同步路像素摘要相同）；apply 回放 140 帧对 WPE 第 140 帧 0 差异（含 `replaceData` 换四边形） |
| [x] | PM3 读帧缓冲的模型（E16） | Windows dev | `p14-fb1` / `p14-fb2` 探针渲染，逐 draw 轨迹 | 画模型之前拷一次快照、模型读到当前画面；和 WPE 只差三角形 | 2026-11-21：轨迹是「底图 → 快照 → 模型两个 drawIndexed」，绑的是快照；fb1 差两个三角形、fb2 差一个，WPE 那里是黑 / 旧快照 |
| [x] | PM4 脚本 API 日志 | Windows dev | `p14-api2` 探针跑 120 帧加一次点击，和 WPE 日志逐行比 | 只在有意不同处不同 | 2026-11-21：只差 S15d / S15d2（D1）、S13d（微任务时机）与输入时机，见 `ignore/p14/4/api/README.md` |
| [x] | PM5 Karin 固定帧 | Windows dev + WPE | 复制工程 `FIXED_FRAME=120`（声音换静音），两边比 `KARIN_SCENE_SAMPLE` 与整帧（按 WPE 那一帧的 `g_Time`） | `modelHash` 相同；整帧只差 E16 | 2026-11-21：`modelHash 3b2a47a2`、321 个 drawable 两边相同；1920×1080 只差 128 个像素，全在 `clip_119`（WPE 读到全 0 快照） |
| [x] | PM6 Karin 性能 | Windows dev + WPE | 复制工程 `PROFILE_SECONDS=10`，WPE 测试窗口与 Kabegame 图库预览各跑一次 | 每帧脚本耗时不比 WPE 差 | 2026-11-21：`update` 平均 / p95 / 最大，Kabegame 12.3 / 13 / 211 ms，WPE 18.0 / 30 / 243 ms；加载 7.2 s（首帧 3.1 s 建 358 个层，全部同步、当帧装上） |
| [ ] | PM7 预览里看 3834692798 本体 | Windows dev，图库预览 | 预览这张壁纸看一分钟（会放语音与音乐） | 能实时渲染，不再停在预览图；人物的呼吸、眨眼、口型与动作流畅，没有缺部件、闪烁或错位；字幕与语音对得上 | 需要用户看 |
| [ ] | PM8 非 Windows | macOS、Linux | 同 PM7 | 同 Windows | 本机不能测 |

## 场景壁纸 P6a2：声音的 `mintime` / `maxtime` 绑属性、挂脚本

2026-11-21 Windows。myprojects `3798696286`（Hades Asylum Depths）把 `random` 咆哮声的 `mintime` / `maxtime` 绑在两个滑块上，以前报 `sound:binding:mintime; sound:binding:maxtime`、整张退回预览图。WPE 写字段走类型化 setter，没有改值回调的字段照样写入（rea-p10-keyframes 第 4 条），`random` 模式在每次开始播放时读这两个字段算等待（rea-p6a 2.1）。所以改成就地目标，排期器开始播放时现读：运行中改了，正在等的这次不变，下一次排期用新值。属性、字段脚本、关键帧三种写法都支持。`playbackmode` / `startsilent` / `spatialization` 维持照报。记录见 `.claude/plans/wpe-import/3-scene/phase6/phase-6a2-sound-delay.md`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | D1 单测与检查 | Windows | 宿主 tsc；声音、绑定、字段脚本、状态写入、能力表、关键帧相关的 18 个 vitest 文件；Prettier | 全过 | 2026-11-21：486 个用例全过（工作树与合并后的主树各一次） |
| [x] | D2 变异检查 | Windows | `ignore/p6/a4/mutate.py`：random 分支读编译期常量、签名仍含两键、`SceneSounds` 不传 `timingOf`、能力表仍报、`targetOf` 不认两键、编译期不登记目标、状态写错字段、脚本读回固定读 `volume`、宿主不给 `timingOf` | 都被检出 | 2026-11-21：8 / 9；「宿主不给 `timingOf`」单测抓不到，由 D4 的真机录音兜住 |
| [x] | D3 WPE 的行为 | Windows，WPE 测试窗口 | `p6a-delay`：D 绑属性 `dmin` / `dmax`（1 → 3，运行中 `apply_properties`），S 挂字段脚本（8 s 起返回 3），看 WPE 探针的频谱与回环录音 | 两路间隔都从 1.5 s 变成 3.5 s，跨过改值时刻的那一段仍是 1.5 s | 2026-11-21 Claude：S 开始 … 7.66、9.26、12.81，间隔 1.60 → 3.55；D 开始 … 13.91、15.31、18.91，间隔 1.40 → 3.60 |
| [x] | D4 Kabegame 真机 | Windows dev，屏外宿主（临时挪进视口、推宿主音量） | 同一个工程导入 dev，运行 8.35 s 改属性、脚本 8.0 s 切换，回环录音 | 同 D3 | 2026-11-21 Claude：两路同步，开始 … 5.92、7.42、10.92、14.46，间隔 1.50 → 3.50，与 WPE 同 |
| [x] | D5 语料 | Node，`kbp corpus scan` / `diff` | HEAD 快照与主树各扫默认语料与 myprojects | 只有 `3798696286` 变干净 | 2026-11-21 Claude：默认语料 233 张 0 变化；myprojects 437 张干净 431 → 432，只多 `3798696286` |
| [x] | D6 预览与桌面看 3798696286 | Windows dev，图库预览 | 预览 Hades Asylum Depths，开着声音等一两分钟；把「Roar Minimum / Maximum Delay Time」拖到最小（10 / 30 秒）再等 | 能实时渲染；咆哮声隔一阵随机响一次，改小间隔后从下一次起明显变密 | 2026-11-21 用户：改小间隔后确实变密 |
| [ ] | D7 非 Windows | macOS、Linux | 同 D6 | 同 Windows | 本机不能测 |
