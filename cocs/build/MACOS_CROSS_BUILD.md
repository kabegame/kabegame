# macOS 跨架构构建（Apple Silicon ↔ Intel）

## 目的

在**一台** Mac 上为另一架构出包：Apple Silicon 机器编 Intel（`x86_64-apple-darwin`）版，
或反之。入口统一为 `--target x86_64|arm64`，贯穿主应用与全部二进制依赖
（FFmpeg/x264、CEF/Chromium）。

**该选项仅 macOS 可用**：Linux/Windows 恒为 x64，传了会直接报错。
Android 的 ABI 走另一条路（`-- --target aarch64` 透传给 tauri CLI），与本机制无关。

## 单一来源

架构解析集中在 [scripts/utils.ts](../../scripts/utils.ts)，模块加载期就定死，
供所有插件与子进程消费：

| 导出 | 含义 |
|---|---|
| `TARGET_ARCH` | `x86_64` \| `arm64` \| `undefined`（未传 `--target`） |
| `TARGET_TRIPLE` | `x86_64-apple-darwin` \| `aarch64-apple-darwin` \| `undefined` |
| `HOST_ARCH` / `IS_CROSS_COMPILE` | 宿主架构 / 目标是否 ≠ 宿主 |
| `ARTIFACT_DIR` | 本次构建的产物目录 = `TARGET_DIR[/<triple>]` |
| `FFMPEG_INSTALL_DIR` | 按架构解析的 FFmpeg 安装前缀 |
| `CEF_DIR_SUFFIX` | CEF runtime 目录后缀（`""` \| `"-x64"`） |

解析只看 argv 中第一个裸 `--` **之前**的 `--target`；`--` 之后的参数是原样透传给
tauri/cargo 的，不消费也不重复注入。解析结果回写 `KB_TARGET_ARCH` /
`KB_ARTIFACT_DIR` 环境变量，供 `src-crawler-plugins/package-plugin.ts` 等独立子进程继承。

门控（哪些命令/模式允许跨编）在 [scripts/plugins/target-plugin.ts](../../scripts/plugins/target-plugin.ts)：
`build` / `check` / `start` 可用，`dev` 与 android/web 模式拒绝。

## 目录隔离约定

**按架构决定，不随宿主变化** —— 同一条命令在任何 Mac 上落点一致。
`arm64` 沿用既有的无后缀目录（历史产物继续有效，不必重编）；`x86_64` 全部独立：

| | arm64（及不传 `--target`） | x86_64 |
|---|---|---|
| cargo/tauri 产物 | `target/[aarch64-apple-darwin/]` | `target/x86_64-apple-darwin/` |
| FFmpeg | `third/FFmpeg-build/install` | `third/FFmpeg-build/darwin/x86_64/install` |
| x264 | `third/x264-build/install` | `third/x264-build/darwin/x86_64/install` |
| CEF runtime | `<root>/cef-{dev,prod}` | `<root>/cef-{dev,prod}-x64` |
| CEF GN 输出 | `out/Release_GN_arm64` | `out/Release_GN_x64` |
| dmg 资产名 | `..._aarch64.dmg` | `..._x64.dmg` |

> **注意**：`--target` 一旦显式传入，cargo/tauri 就会多套一层 triple 目录 ——
> 即使 `--target arm64` 在 Apple Silicon 上是原生构建也是如此。所有"找产物/搬产物"
> 的路径必须用 `ARTIFACT_DIR` 而非 `TARGET_DIR`，否则会静默打包上一次 native
> 构建的残留，产出架构混合的 `.app`（最危险的失败模式：不报错，装上才崩）。

CEF 的 Chromium checkout（`CEFBUILD`）两架构**共用**，只是 `out/` 子目录不同；
想彻底分开可用 `CEFBUILD` 环境变量各指一处，代价是多一份数十 G 的源码树。

## 出 Intel 包的完整顺序

以 Apple Silicon 上编 x86_64 为例。前三步各自独立、可分别重跑：

```bash
# 0. 前置：x86_64 的 x264 汇编必须有 nasm（缺失时 x264 configure 硬失败，不会降级）
brew install nasm

# 1. FFmpeg + x264（~10 分钟）
deno task build:ffmpeg --target x86_64

# 2. CEF/Chromium（数小时～十几小时，唯一的大头）
scripts/build-chromium.sh prod --target x86_64

# 3. CLI 与主应用
deno task b -c kabegame-cli --release --target x86_64
deno task b -c kabegame --release --target x86_64
```

产出 `release/Kabegame-standard_<version>_x64.dmg`。

## 踩坑

### 1. 官方 CEF 预编译包不可用，必须自编

`third-patches/cef/0001-flat-subprocess-path.patch` 改的是 Chromium 的
`ChildProcessHost::GetChildPath`：显式 `--browser-subprocess-path` 时跳过 macOS
的 helper-app 变体改写。而 [tauri-runtime-cef](../../src-tauri/tauri-runtime-cef/src/runtime.rs)
无条件把 `browser_subprocess_path` 指向扁平的 `kabegame-cef-helper`。

用没打这个 patch 的 stock CEF（含官方 `macosx64` 发行版），子进程路径会被改写成
`kabegame-cef-helper.app/Contents/MacOS/... (GPU)` —— 该路径不存在 → 所有子进程
spawn 失败 → 白屏 + Network service crashed 循环。官方包还额外缺 H.264/AAC。

### 2. PATH 上的 Android NDK toolchain 会劫持 `clang` 和 `ld`

开发机若装了 NDK，其 `toolchains/llvm/prebuilt/*/bin` 常排在 Xcode 之前，
同时遮蔽 `clang` 与 `ld`：

```
ld64.lld: error: library not found for -lSystem      # 用了 NDK 的 clang
ld: library 'System' not found                        # 用了 Xcode clang 但 ld 仍来自 NDK
```

因此 `build-ffmpeg.sh` 的 macOS 分支一律用 **`cc`**（`/usr/bin/cc`）：它是
xcode-select 的 shim，自动注入 macOS SDK 与正确的 ld，`-arch` 即可跨架构，
无需 `-isysroot`/`-B`。NDK 不提供 `cc`，所以这条路是安全的。
**不要**改成裸 `clang` 或 `xcrun --find clang` 的绝对路径。

FFmpeg 侧另需 `--host-cc="cc"`（不带 `-arch`）：构建期辅助工具必须是宿主架构才能跑。

### 3. `--target arm64` 也会换产物目录

它不是"什么都不做"。在 Apple Silicon 上它仍是原生编译（不加 `--enable-cross-compile`、
FFmpeg/CEF 沿用无后缀目录），但 cargo 产物落 `target/aarch64-apple-darwin/`，
等于一次全量重编。想复用既有增量就**别传** `--target`。

### 4. .kgpg 打包用宿主 CLI

`package-plugin.ts` 优先取 `target/release/kabegame-cli`（宿主原生），
找不到才回退 `KB_ARTIFACT_DIR/release/`（跨编产物，需 Rosetta 才能跑）。
`.kgpg` 是纯数据产物、与架构无关，用宿主 CLI 更快。

### 5. 跨编专属 env：`PKG_CONFIG_ALLOW_CROSS` 与 bindgen `-target`

`rusty_ffmpeg` 的 build.rs 用 `pkg-config` crate 静态探测，它**默认拒绝交叉编译**
（host≠target）直接 panic：`pkg-config has not been configured to support
cross-compilation`。自编的 x64 `.pc` 用绝对路径、无需 sysroot 改写，所以
mode-plugin 在 `IS_CROSS_COMPILE` 时注入 `PKG_CONFIG_ALLOW_CROSS=1` 放行（与 android 同理）。

同理 bindgen 解析 FFmpeg 头文件时，跨编必须在 `BINDGEN_EXTRA_CLANG_ARGS` 追加
`-target <arch>-apple-darwin`，否则按宿主 arch 解析，与实际链接的另一架构静态库对不上。

这两处都**只有实跑 cargo 才会暴露** —— lint 与路径推导测试都测不到。

### 6. CEF 自编：`--x64-build` 不足，还需 `CEF_ENABLE_*` + PGO profile

`build-chromium.sh` 跨编时两个 automate-git 与 gn_args 之间的脱节（均已在脚本内修复）：

- **架构未传导**：automate 的 `--x64-build` 只决定它期望读的 out 目录名，真正生成
  GN 配置的 `gn_args.py:GetAllPlatformConfigs` 只看**宿主** machine，arm64 上就只
  生成 `Release_GN_arm64`。报错 `Path does not exist: out/Release_GN_x64/args.gn`。
  修复：注入 `CEF_ENABLE_AMD64=1`（arm64 目标则 `CEF_ENABLE_ARM64=1`）+
  `GN_OUT_CONFIGS=Release_GN_<arch>` 收敛生成。
- **缺目标架构的 PGO profile**：prod 是 `is_official_build=true` 默认开 PGO，gn gen
  要读 `chrome/build/pgo_profiles/` 下与 `<target>.pgo.txt` 同名的 `.profdata`。但
  `.gclient` 常年 `checkout_pgo_profiles=False`，增量跨编到新架构时该 profile 从没下过，
  报 `requested profile ... doesn't exist`。`ensure_pgo_profile()` 在 prod 增量构建前
  按目标架构（mac / mac-arm）幂等补下（`update_pgo_profiles.py --target ... update
  --gs-url-base=chromium-optimization-profiles/pgo_profiles`）；全量 `--clean` 时
  src 尚不存在，仍交给既有的 `--with-pgo-profiles`。

## 涉及文件

- [scripts/utils.ts](../../scripts/utils.ts) —— 架构解析与全部路径常量的单一来源
- [scripts/plugins/target-plugin.ts](../../scripts/plugins/target-plugin.ts) —— 命令/模式门控与落点日志
- [scripts/build-system.ts](../../scripts/build-system.ts) —— `targetArgs()` 注入 cargo/tauri
- [scripts/plugins/mode-plugin.ts](../../scripts/plugins/mode-plugin.ts) —— FFmpeg pkgconfig、CEF_PATH、bindgen `-target`
- [scripts/plugins/os-plugin.ts](../../scripts/plugins/os-plugin.ts) / [release-plugin.ts](../../scripts/plugins/release-plugin.ts) —— helper 校验、bundle 目录、资产命名
- [scripts/build-ffmpeg.sh](../../scripts/build-ffmpeg.sh) / [scripts/build-chromium.sh](../../scripts/build-chromium.sh)
