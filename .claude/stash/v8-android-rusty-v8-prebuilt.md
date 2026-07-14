# Stash: V8 后端 Android 交叉编译 — rusty_v8 自建产物（路线 A 执行中）

> 2026-07-13 更新（Linux 机器上）。原 macOS 上写的恢复计划已执行大半；剩余：**用户手动编译 librusty_v8** + 产物入库 + 验证链。

> **2026-07-14 更新：自建已固化为可复现命令 `bun run build:v8`（`scripts/build-v8.sh`，仅 Linux）。**
> 下面「待办 1/2」的手动 clone+编译+入库已被取代。**`~/i/build-rusty-v8` 已就地搬入 `third/rusty_v8`**
> （denoland/rusty_v8 submodule，pin `v149.4.0`）：这是一棵复用的胖构建树——nested submodules + 已编译
> `target/`（那份 175MB .a）都在其中，故增量复用、不重拉/重编；`.gitmodules` 标 `ignore = dirty`。
> 5 处坑里 #4（build.rs jobserver）与 #2（嵌套 `build/` 的 NDK BUILD.gn）**固化为顶层补丁**：
> `third-patches/rusty_v8/0001-ninja-jobserver-fd.patch` 与 `0002-android-ndk-build-gn.patch`（后者路径带
> `build/` 前缀，`git -C third/rusty_v8 apply` 跨进嵌套 build 子模块），由 build-v8.sh 幂等应用。patch-manager
> 已改为**幂等门控**：forward 只对纯净树、reverse 只对脏树（scripts/patch-manager.ts），故对常驻脏态的本胖树
> 自动跳过。#1/#3/#5（simdutf checkout / sysroot / ndk symlink）是非 diff 动作，只在首次拉取
> nested 时做。产物落 `bin/android/`（**gitignore、不入库**，命令复现）。`v8` crate **不**经 `[patch.crates-io]`
> 指向子模块——git 仓缺发布版 `gen/` binding，patch 会逼所有平台自备 binding、破坏桌面构建；app 构建仍
> 用 crates.io v8 + 注入 archive/binding。共用 shell helper 抽到 `scripts/utils.sh`。见
> `third-patches/rusty_v8/README.md`。剩验证链（待办 3，仍需真机）。

## 已完成（本机 Linux，代码已改好、未提交）

- **产物注入已固化到构建系统**：`scripts/plugins/mode-plugin.ts` `prepareEnv` 在 android mode 下设
  `RUSTY_V8_ARCHIVE` / `RUSTY_V8_SRC_BINDING_PATH` 指向 **`bin/android/`**（缺文件时报错并打印自建命令）。
  - 产物放 `bin/android/`（git 跟踪，`.gitignore` 注释已更新），**不放 `bin/linux/`**：
    那里被 os-plugin `collectLinuxSharedLibs()` 构建期整目录清空重建，且 component-plugin
    会把 `bin/linux/` 全部文件递归写进 deb 的 `/usr/lib/kabegame/`。
  - `.a.gz` 直接给 `RUSTY_V8_ARCHIVE` 即可：v8 build.rs `copy_archive` 按 GZIP 魔数自动解压（已读源码核实）。
- **文档已更新**：`cocs/crawler/V8_RUNTIME.md`「Android 交叉编译」节改写为自建产物 + 注入方案
  （原「Release 确有预编译」的前置校验已删除——该说法被证伪）；`cocs/README.md` 索引措辞同步。
- **rusty_v8 源码树已就绪**：`/home/cm/build-rusty-v8`（tag v149.4.0，与 Cargo.lock 的 v8 149.4.0 / deno_core 0.405.0 一致），
  submodule 已全部 `--init --recursive` 拉完（首次构建失败就是因为浅 clone 没 submodule，`./v8/DEPS` 不存在）。
  NDK r26c 已被 build.rs 下载到 `third_party/android_ndk/`。

## 待办 1：手动编译 ✅ 已完成（2026-07-13，实际源码树在 `/home/cm/i/build-rusty-v8`，非原记的 `/home/cm/build-rusty-v8`）

```bash
cd /home/cm/i/build-rusty-v8
GN=/home/cm/i/cefbuild/chromium_git/chromium/src/buildtools/linux64/gn \
NINJA=/home/cm/i/cefbuild/chromium_git/chromium/src/third_party/ninja/ninja \
V8_FROM_SOURCE=1 cargo build --release --target aarch64-linux-android --features simdutf
```

- `--features simdutf` 必须（deno_core 0.405 开了 v8 的 simdutf feature）。
- **GN/NINJA 必须外部指定**：`ninja_gn_binaries.py` 从 CIPD 下 gn/ninja 在国内不通；复用 cefbuild 里
  chromium 树自带的 gn(v2384)/ninja(1.12.1) 即可（真 ELF，非 depot_tools 的包装脚本）。

### 编译期踩到的 5 处坑（都是 rusty_v8 build.rs 假设 vs 其 pin 的新版 chromium `build/` 树版本错位；**改在工作区，fresh checkout / `git submodule update` 会丢，fork 时须固化为 patch**）：

1. **simdutf 子模块工作区空**：`third_party/simdutf` 只剩 `.git` gitlink，文件被删。
   `cd third_party/simdutf && git checkout -f HEAD`（本地对象齐全，无需联网）。
2. **`android_ndk_version` 未定义**（`build/config/android/BUILD.gn:37`）：新版 config.gni 已移除该变量。
   改字面量 → `"ANDROID_NDK_VERSION_ROLL=r26c_1"`。
3. **缺 host sysroot**：`python3 build/linux/sysroot_scripts/install-sysroot.py --arch=amd64`。
4. **jobserver fd 冲突**：`build.rs` `ninja()` 里 `cmd.env_remove("CARGO_MAKEFLAGS"); cmd.env_remove("MAKEFLAGS");`
   （cargo 的 jobserver fd 穿不进 ninja→rustc）。
5. **NDK 路径新旧布局错位**：gn 期望 `third_party/android_toolchain/ndk`，build.rs 下到 `third_party/android_ndk`。
   `mkdir -p third_party/android_toolchain && ln -sfn ../android_ndk third_party/android_toolchain/ndk`。

## 待办 2：产物入库 ✅ 已完成（2026-07-13）

```bash
mkdir -p /home/cm/i/kabegame/bin/android
gzip -c /home/cm/i/build-rusty-v8/target/aarch64-linux-android/release/gn_out/obj/librusty_v8.a \
  > /home/cm/i/kabegame/bin/android/librusty_v8_simdutf_release_aarch64-linux-android.a.gz
```

**binding（更新）**：build.rs 在 `V8_FROM_SOURCE` 下**总会跑 bindgen**（`build_binding()` 无 env 可跳过），
故需 **clang 19+ 的 libclang**——`build-v8.sh` 自动探测 llvm-19 设 `LIBCLANG_PATH`（本机 `/usr/lib/llvm-19/lib`）。
另有一处坑：bindgen 继承 cargo TARGET 以 `--target=aarch64-linux-android` 解析，build.rs 只在 target_os 为
linux/macos 时补 sysroot、android 不补，于是 clang 拿宿主 glibc 头解析 aarch64 目标——宿主 x86_64 头里的
`#ifdef __x86_64__` 在 aarch64 下不成立，`bits/wordsize.h` 误判 `__WORDSIZE=32` → 拉 `gnu/stubs-32.h`……一路
错位（先前用「补宿主 multiarch include」只能糊一层、下一个 glibc arch 分支又炸）。正解：给 NDK 的 Bionic
aarch64 sysroot——脚本设 `BINDGEN_EXTRA_CLANG_ARGS=--sysroot=third/rusty_v8/third_party/android_ndk/.../sysroot`
（`get_bindgen_args.py` 只吐 `-D` defines、不吐 `--target/--sysroot`）。binding 是 FFI 声明、**对 64 位目标架构
无关**（已 diff 验证 aarch64 与 x86_64 的 simdutf-release binding 逐字节相同），故 Bionic 头解析产物通用；缺失才
回退 v8 crate `gen/` 预置的 aarch64 版：

```bash
cp /home/cm/.cargo/registry/src/index.crates.io-*/v8-149.4.0/gen/src_binding_simdutf_release_aarch64-unknown-linux-gnu.rs \
  /home/cm/i/kabegame/bin/android/src_binding_simdutf_release_aarch64-linux-android.rs
```

## `deno_core` 的 kabegame patch（大部分已固化）

> 更新：`third/deno_core`（kabegame/deno_core 旧 fork）已删除。deno_core 现由 `third/deno`
> （denoland/deno monorepo submodule，pin `v2.9.0` = deno_core 0.405.0）的 `libs/core` 经
> `[patch.crates-io]` 提供。下列 **1/3/4 三处 deno_core 改动已固化为 `third-patches/deno/` 的 patch
> series**（`bun run patch deno` 应用，re-vendor 不再丢）。第 2 处 `__clear_cache` 不在 deno_core、而在
> `src-tauri/kabegame/build.rs`（已在主仓，非 submodule），仍按下述保留。见 `third-patches/deno/README.md`。

1. **Bionic errno**（`uv_compat/tty.rs`）：加 `#[cfg(target_os="android")]` 分支用 `__errno()`
   （glibc 是 `__errno_location`），否则 android 触发 `compile_error!`。
2. **`__clear_cache`（链接期，非 deno_core）**：`src-tauri/kabegame/build.rs` android 分支把 NDK
   `libclang_rt.builtins-<arch>-android.a` 以 `cargo:rustc-link-arg` 追加到链接行**末尾**（排在
   `librusty_v8.a` 之后），补上 V8 ARM64 JIT 的 icache flush 符号；cdylib 允许未定义符号，故编译过
   但 dlopen 报 `UnsatisfiedLinkError: __clear_cache`。
3. **扩展 JS 内嵌**（`extensions.rs`：`__extension_include_js_files_detect!` 与
   `include_lazy_loaded_js_files!` 由 `mode=loaded` 改 `mode=included`）：deno_core 默认把每个
   `esm`/`js`/`lazy_loaded` 源记为 `LoadedFromFsDuringSnapshot(<绝对构建路径>)`，靠构建期 V8 snapshot
   兜底。kabegame 不生成构建期快照，首次 fresh runtime 与设备端 baseline 快照生成都会在目标设备执行；
   若仍用 loaded 模式，`extension_set` 会**从磁盘按绝对路径读**每个源——桌面因 build==run 机器而侥幸可用，交叉编译到 android 后路径是 Linux 宿主的
   cargo registry 路径、设备上不存在 → `read_to_string` ENOENT → panic
   `Failed to initialize a JsRuntime: No such file or directory (os error 2)`。
   因 `[patch.crates-io] deno_core` 让 `deno_web`/`deno_crypto`/`deno_webidl` 的 `extension!` 也走本
   crate 的宏，改为 `included` 会用 `include_str!` 在各自编译期把源**嵌进二进制**，运行期零磁盘依赖
   （桌面 release 也因此不再依赖构建树）。等价于 deno_core 重构前
   `#[cfg(not(feature="include_js_files_for_snapshotting"))]` 的默认；内嵌源同时服务 fresh 与设备端 snapshot creator。
4. **snapshot/non-snapshot 淡化初始化模式**（`runtime/setup.rs`）：`init_v8` 允许普通 runtime 与
   `JsRuntimeForSnapshot` 在同一进程共享一次 V8 platform 初始化，并让全局 flags 与 `snapshot` 参数解耦。
   设备后台生成若先赢得 Once，也不会把 `--predictable --random-seed=42` 固定到整个 app；重新 vendor 时必须保留。

## 待办 3：验证链

- `bun dev -c kabegame --mode android`（或 `bun b -c kabegame --mode android`）——应不再出现
  rusty_v8 404 下载失败；v8 build.rs 日志应出现 `Copying .../bin/android/....a`（现为裸 `.a`，非 gzip）；
  真机启动 JS 插件不再 panic `os error 2`（扩展源已内嵌）。
- 桌面 `cargo test -p kabegame-core plugin::v8`（fresh + snapshot restore、crypto/DOM/fetch/Response/Headers 冒烟）。
- 真机确认首次日志出现 `[v8-snapshot] generated ...`，随后任务出现 restore 日志；杀进程重启再跑验证磁盘加载。缓存位于 app cache 的 `plugins/snapshots/`，可安全清除并自动重建。
- APK 真机跑一个 JS 插件任务（fetch/crypto/DOMParser 冒烟）。
- 通过后可删除本 stash 文件。

## 长期可选

- fork rusty_v8 把 android 加回 CI 发布矩阵，设 `RUSTY_V8_MIRROR` 指向自己的 Release；升级 deno_core 时 re-run CI。

## 其他注意（沿用原计划）

- NDK 的 `libc++_shared.so` 需随 APK 打包（V8 静态库链 libc++）；`minSdk` 与 NDK r26c / android24 clang 匹配。
- 升级 deno_core/v8 版本后需重新自建产物（mode-plugin 报错信息里有完整命令）。
