# V8 爬虫运行时

V8 后端在桌面 + Android（仅 `aarch64`）均启用，仅 iOS 不支持。运行时用 `deno_core`，采用设备端动态生成的共享 baseline 启动快照缓存（无构建期快照、无 residual 烧录表）；网络全部走宿主 `reqwest`，故不引入 `deno_fetch` / `deno_net` / `deno_tls`（详见「运行时架构与网络」「Android 交叉编译」两节）。

V8 插件导出 `crawl(common, custom)`。宿主能力统一通过全局 `Kabegame.*` 暴露，不再暴露 `__kabegame_*`，也不再提供 `@kabegame/plugin-sdk/host` 模块。

## 全局能力

- Web 平台：`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`atob` / `btoa`、timer、`crypto`、`fetch` / `Request` / `Response` / `Headers`、`DOMParser`。
- 宿主桥：`Kabegame.to`、`back`、`currentUrl`、`currentHtml`、`currentDocument`、`currentHeaders`、`pluginData`、`setPluginData`、`setHeader`、`delHeader`、`warn`、`addProgress`、`downloadImage`、`createImageMetadata`。

## 迁移点

- 删除 V8 专属 `fetchJson`；JSON 请求使用 `await (await fetch(url)).json()`。
- `fetch` 会合并当前任务经 `Kabegame.setHeader()` 设置的请求头。
- `fetch` 不按当前页自动解析相对 URL；需要 `new URL(relative, await Kabegame.currentUrl())`。
- SDK 仅保留纯工具模块（`regex` / `md5` / `url` / `misc` / `types`），不再导出 `host` / `dom`。

## 运行时架构与网络（宿主化）

- **网络全部走宿主 `reqwest`**，V8 侧不做任何 socket/TLS。`fetch` 是 `op_kabegame_fetch`（代理感知、跟随重定向 ≤10），`Kabegame.to`/页面抓取是 `op_kabegame_to`（手动重定向 + 重试），两者都在 `ops.rs` 用 `reqwest` 实现。因此 **不引入 `deno_fetch` / `deno_net` / `deno_tls`**，也就没有 hyper/其自带 TLS 的编译与体积负担。
- 因为不再从 `deno_fetch` 取 `Headers` / `Response`，这两个类在 `prelude.js` 里**自实现**（`Headers` 为大小写不敏感多值 map；`Response` 由宿主返回的 `Uint8Array` 承载 body，支持 `text()`/`json()`/`arrayBuffer()`/`bytes()`，无流式 body / `clone`）。`Request` 仍是归一化 fetch 入参用的最小实现。改这三个类只需改 `prelude.js`。
- 保留的 deno 扩展只有 `deno_webidl` / `deno_web`（URL/编码/timer/base64/DOMException）/ `deno_crypto`（`crypto.subtle`）。`deno_crypto` 的 `00_crypto.js` 是 lazy JS 且创建 cppgc 对象，在 `JsPluginRuntime::new` 里 isolate 建好后用 `loadExtScript` 显式加载并挂全局。
- **设备端共享 baseline 快照缓存**：Android 交叉编译不能在 x86_64 宿主生成可供 arm64 V8 加载的快照，因此运行时在设备自身后台生成并缓存到 `cache_dir/plugins/snapshots/runtime@<fingerprint>.bin`。任一 V8 插件加载/安装会触发生成；首任务缺缓存时仍走 fresh 初始化，不额外阻塞，后续任务和进程重启后优先从磁盘快照恢复。快照只烘焙 `deno_webidl` / `deno_web` / `deno_crypto` / `kabegame_v8` 的扩展 ESM，插件模块仍按任务加载。
- 快照文件有独立 magic、内容指纹、V8 精确版本、payload 长度和 CRC32；验证失败会删除并重建，restore 失败则本进程禁用快照并回退 fresh。`KABEGAME_DISABLE_V8_SNAPSHOT=1` 可强制关闭。修改 vendored `deno_core` 快照布局、deno 扩展版本/顺序或 `kabegame_v8` ESM 时，必须同步递增 `snapshot.rs` 的 `SNAPSHOT_FINGERPRINT`。
- `deno_crypto` 的 `Crypto` / `SubtleCrypto` / `CryptoKey` 是 cppgc 对象，不能进入 V8 startup snapshot；`00_crypto.js` 始终在 fresh/restore isolate 建成后执行并挂载 globals。扩展 JS 继续以 `IncludedInBinary` 内嵌，既保证首次 fresh 初始化，也保证设备端快照生成不依赖构建机路径；仍无 residual 表或 `build.rs` 快照步骤。

## Android 交叉编译

- 依赖门控：`deno_*`、`sys_traits`、`tokio-util` 是 `plugin-runtime` feature 的 optional dependencies，并继续用 `cfg(not(target_os = "ios"))` 覆盖桌面 + Android。主 app 显式启用 `plugin-runtime`；自包含 CLI 关闭 core default features，因此不会编译 deno/rusty_v8。`reqwest` 桌面用 `native-tls`、Android 用 `rustls-tls`（既有约定）。`plugin/v8.rs`、metadata migration 与 `task_scheduler.rs` 的 V8 调度分支都受该 feature 门控。
- **`deno_core` 来源（桌面 + Android 通用）**：`[patch.crates-io] deno_core` 指向 `third/deno/libs/core`——上游 `denoland/deno` monorepo submodule，pin `v2.9.0`（其 `libs/core` 与 crates.io `deno_core` 0.405.0 逐字节一致，无版本漂移；deno_core 只在 CLI release 时 bump，升级即换到 `libs/core` 版本匹配的 tag）。kabegame 对 deno_core 的 3 处改动（扩展 JS 内嵌 `mode=included`、共享 V8 platform 初始化、Android Bionic `__errno`）以 patch series 存于 `third-patches/deno/`，**任何 cargo 构建前须先 `deno task patch deno`**。`serde_v8`/`deno_ops` 作为 monorepo path 依赖单份解析（kabegame 图里只有 deno_core 引用它们，故无 path-vs-registry 重复）。详见 [../../third-patches/deno/README.md](../../third-patches/deno/README.md)。
- **仅编译 `aarch64`**：V8 静态库体积大，只支持一个 ABI；`RustPlugin.kt` 默认 ABI/arch/target 收敛到 `arm64-v8a` / `arm64` / `aarch64`。其它 ABI 需显式传 `-PabiList/-ParchList/-PtargetList` 并自备对应产物。
- **自建产物（官方无 Android 预编译）**：`rusty_v8` 自 v0.102.0（2024 年中）起不再发布 Android 预编译静态库，且 crates.io 的 v8 包内也没有 Android 版 `src_binding_*.rs`——两个产物都缺。因此需一次性自建，放在 **`bin/android/`**（**gitignore、不入库，由 `deno task build:v8` 复现**）：
  - `librusty_v8_simdutf_release_aarch64-linux-android.a`（直接放 `.a`；`bin/android` 已 gitignore 不入库，无需 gzip 压缩，`copy_archive` 原样拷贝）
  - `src_binding_simdutf_release_aarch64-linux-android.rs`
  - 注入：`scripts/plugins/mode-plugin.ts` 的 `prepareEnv` 在 android mode 下设 `RUSTY_V8_ARCHIVE` / `RUSTY_V8_SRC_BINDING_PATH` 指向上述文件（缺失时报错，提示跑 `deno task build:v8`）。**不要**放 `bin/linux/`——那是 os-plugin 构建期清空生成、且整目录进 deb 的。
  - **复现（仅 Linux）：`deno task build:v8`**（`scripts/build-v8.sh`）。构建树 = `third/rusty_v8` 子模块本身（denoland/rusty_v8，pin `v149.4.0` = Cargo.lock 的 v8）——一棵**就地复用的胖树**：nested submodules（v8/build/third_party/*）与已编译的 `target/` 都在其中，故增量复用、不重新拉取、不从零重编。脚本幂等应用 kabegame 补丁（`third-patches/rusty_v8/` 顶层 `*.patch`，均 `git -C third/rusty_v8 apply`：`0001` → `build.rs` ninja jobserver 修复；`0002` → `build/config/android/BUILD.gn` 的 NDK 字面量，路径带 `build/` 前缀故 git apply 跨进嵌套 build 子模块；**由 build-v8.sh 应用，不走 `deno task patch`**——patch-manager 只对纯净树 forward、对脏树 reverse，本胖树常驻脏态被跳过），首次拉取嵌套子模块时另做 3 处非 diff fixup（simdutf checkout / host sysroot / android_toolchain ndk symlink），再 `V8_FROM_SOURCE=1 cargo build --release --target aarch64-linux-android --features simdutf`（feature 必须与 deno_core 对 v8 的一致），最后把静态库 `.a` 拷到 `bin/android/`（裸 `.a`，不 gzip）+ 复制 bindgen 生成的 `src_binding.rs`。build.rs 在 V8_FROM_SOURCE 下总会跑 bindgen，故需 **clang 19+ 的 libclang**——脚本自动探测 llvm-19 设 `LIBCLANG_PATH`。bindgen 继承 cargo TARGET 以 `--target=aarch64-linux-android` 解析，而 build.rs 只在 target_os 为 linux/macos 时补 sysroot、android 分支不补，于是 clang 拿宿主 glibc 头解析 aarch64 目标——宿主 x86_64 头的 `#ifdef __x86_64__` 在 aarch64 下不成立（`bits/wordsize.h` 误判 `__WORDSIZE=32` → 拉 `gnu/stubs-32.h`……一路错位）。脚本据此设 `BINDGEN_EXTRA_CLANG_ARGS=--sysroot=third/rusty_v8/third_party/android_ndk/.../sysroot`（NDK Bionic aarch64 sysroot，与 --target 相符）。binding 对 64 位目标架构无关（aarch64 与 x86_64 逐字节一致），故 Bionic 头解析出的产物通用，缺失才回退 v8 crate registry 预置版。（NDK 由 build.rs 首次构建时下载；复用树里已就绪，全新 re-vendor 首跑若尚无 sysroot 则再跑一次。）首次从源码构建需 ≥15 GB 磁盘、可联网；GN/NINJA 复用 cefbuild 的 chromium 树二进制（可用同名 env 覆盖）。注意：`v8` crate **不**经 `[patch.crates-io]` 指向该子模块——git 仓缺 `gen/` 预生成 binding（只在发布版里），patch 会逼所有平台（含桌面）自备 binding；子模块仅作 build-v8.sh 的可复现源。详见 [../../third-patches/rusty_v8/README.md](../../third-patches/rusty_v8/README.md)。
- 前置校验（打包前必须确认）：`bin/android/` 产物版本与 Cargo.lock 的 v8 版本一致；NDK 的 `libc++_shared.so` 随 APK 打包（V8 静态库需链接 libc++）；`minSdk` 与产物兼容（NDK r26c / android24 clang）。
- 平台差异：Android **无 WebView 爬虫后端**（那条路径依赖桌面 CEF，仍 `cfg(not(target_os = "android"))`）；Android 侧 JS 插件只走 V8 后端。
