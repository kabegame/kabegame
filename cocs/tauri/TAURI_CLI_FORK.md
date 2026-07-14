# tauri-cli fork（third/tauri + third-patches/tauri）

kabegame 使用自有 fork 的 `cargo-tauri`，替代全局安装版。源码是**上游 tauri monorepo**
（[tauri-apps/tauri](https://github.com/tauri-apps/tauri)，submodule 挂载于 `third/tauri`，
pin tag `tauri-v2.11.2`）的 `crates/tauri-cli` 子 crate，fork 差异以 patch 形式存放于
`third-patches/tauri/`（`0001`–`0005` 为 tauri-cli，`0006` 为 tauri-runtime），构建前先
`bun run patch tauri` 应用。基线 **tauri-cli 2.11.2**。

> 不再有独立的 `kabegame/tauri-cli` fork 仓或 vendored `third/tauri-runtime` 拷贝：
> 两个子 crate 的改动都在同一条 series 里，submodule 保持上游纯净。见
> [third-patches/tauri/README.md](../../third-patches/tauri/README.md)。整个 tauri 栈经
> root `Cargo.toml` 的 `[patch.crates-io]` 指向 `third/tauri/crates/*`，是单一来源。

## 为什么 fork

Android 上有两个本应独立、却被上游 CLI 捆死在 `tauri.conf.json > identifier` 上的身份：

| | Java/Kotlin 包（namespace） | 安卓 id（applicationId） |
|---|---|---|
| 本质 | 编译期类命名空间 | 安装期应用身份 |
| 决定 | 源码目录 `java/<pkg>`、生成 Kotlin 的 package、JNI 绑定、`BuildConfig`/`R` 所在包 | 设备上装成谁（不同 id 并存）、数据目录、`am start -n` 第一段 |

kabegame 需要 identifier 按 mode 变（dev=`app.kabegame.dev` / prod=`app.kabegame`，真机
dev/prod 并存隔离），而 Java 包/源码树固定 `app.kabegame`。stock CLI 做不到：它按
identifier 派生源码目录（不存在则 `exit(1)`）、生成包名，且 auto-launch 传相对形式
`.MainActivity`（被 `am` 按 applicationId 展开 → 类不存在）。

## fork 相对上游的 patch（tauri-cli 共 5 个，third-patches/tauri/0001–0005）

1. **`TAURI_ANDROID_PACKAGE` 解耦**（`src/mobile/{mod,android/{mod,dev,run}}.rs`）
   - `get_config`：包/目录改按 `android_package`（env 覆盖，未设或空回退 identifier =
     stock 行为）——源码目录存在性检查、`WRY_ANDROID_PACKAGE`（含 Kotlin 关键字转义）、
     `TAURI_ANDROID_PACKAGE_UNESCAPED`、`WRY_ANDROID_KOTLIN_FILES_OUT_DIR`。
   - dev/run 的 auto-launch 改传全限定类名 `{android_package}.MainActivity`，最终
     `am start -n {identifier}/{android_package}.MainActivity`——第一段仍是按 mode 的
     identifier，第二段是 namespace 派生的真实类（与 AGP `applicationIdSuffix` 同原理）。
   - `ensure_init`（`src/mobile/mod.rs`）:「项目过期」检查用来判断 java 源码目录是否存在的
     路径也改按 `android::android_package(app)` 推导。否则 identifier 按 mode 变
     （`app.kabegame.dev`）时，该检查会误判「你修改了 identifier」并要求删 `gen/android` 重
     `tauri android init`（真机报 “project directory is outdated because you have modified your identifier”）。
2. **`TAURI_NO_WEBKIT_DEPS` 跳过 webkit 打包依赖**（`src/interface/rust.rs`）
   - 设 `1`/`true` 时不注入 deb `libwebkit2gtk-4.1-0` / rpm `libwebkit2gtk-4.1.so.0`
     （kabegame 是 CEF runtime）；并对 `Depends`/`Requires` 保序去重（config 显式项与
     CLI 注入项此前会重复）。替代了原 os-plugin 对 .deb 的 ar/tar 后处理剥除。
3. **`tauri icon` 的 macOS `.icns` 默认留白（dock 缩入）**（`src/icon.rs`）
   - macOS dock / Finder 图标设计规范要求内容四周留白，而 stock `tauri icon` 的 `icns()`
     直接整帧填充画布。fork 新增 `resize_exact_inset()` + 常量 `MACOS_ICON_CONTENT_SCALE`
     （`84.375`）：把源图缩放到内容框（占画布 84.375%）居中放在透明方形画布上，单边缩入
     ≈ **7.81%**（与 `src-tauri/kabegame/icons/check-icon.py` 实测目标值一致）。
   - **仅** `.icns` 生效；`.ico` / Linux png / Android mipmap 仍整帧填充（各有自身规范）。
     源图应为紧贴边缘、无自带留白的方形图标（kabegame 的 `icons/icon.png`、`icons/dev/icon.png`
     内容占比均 100%）。
   - 用法：`third/tauri-cli/target/release/cargo-tauri icon <方形源.png> -o <输出目录>`。
     dev 图标由 `icons/dev/icon.png` 生成（`icon.icns/ico/32/64/128/128@2x`，`icon.png` 保留
     为 1254px 母版）；`tauri.conf.json.handlebars` 按 `isDev` 选 `icons/dev/` 或 `icons/`；
     安卓 dev 启动器图标另复制生成的 mipmap 到 `gen/android/app/src/debug/res/mipmap-*`
     （debug 变体覆盖 `src/main/res`，与 `app.kabegame.dev` / “Kabegame Dev” 标签配套）。
4. **`tauri android check` 子命令**（`src/mobile/android/{mod,check}.rs`）
   - 新增 `Commands::Check(check::Options)` + `src/mobile/android/check.rs`：对 Android target
     跑 `cargo check`，**不产 APK/AAB、不跑 `beforeBuildCommand`/前端**。本质是 `build.rs` 裁到
     `first_target.check(...)`（cargo-mobile2 已内置 `Target::check` / `CargoMode::Check`）为止。
   - 复用 cargo-mobile2 的 NDK `Env`：linker 与 `TARGET_CC`/`TARGET_CXX`/`TARGET_AR`
     （`env.ndk.compiler_path/ar_path`）、`ANDROID_NATIVE_API_LEVEL`（来自 `min_sdk`）全部由
     cargo-mobile2 推导——与 `tauri android build` **完全同源**，因此 kabegame 不再在
     `mode-plugin.ts` 手写 target linker/CC/CXX/AR。
   - 动机：让 `bun check -c kabegame --mode android` 有一条快速类型/借用检查通道，且交叉工具链
     与真实 build 零漂移。FFmpeg / rusty_v8 / bindgen / `PKG_CONFIG_ALLOW_CROSS` 等 kabegame
     特有 env 仍由 `mode-plugin.ts` 注入,随 cargo-mobile2 的 `Env` 作为进程环境透传。

5. **真机 dev 保留 localhost devUrl（adb reverse 全回环，HMR 全双工）**（`src/mobile/android/dev.rs`）
   - stock 的 `run_dev` 只要检测到**物理设备**（serial 不以 `emulator` 开头）就无条件调
     `use_network_address_for_dev_url`,把 localhost devUrl 改写成**局域网 IP**。fork 直接
     删掉这条触发（无 env 门控,恒定行为）:localhost devUrl 原样保留;显式 `--host` 与
     `0.0.0.0` devUrl 仍强制局域网 IP（这两条是使用者显式要求）。
   - 于是后续 gradle `BuildTask` 调的 `android-studio-script` 走 **stock 原有** localhost
     分支（`adb_forward_port`,含设备探测/等待/去重/重试）,自动
     `adb reverse tcp:1420 tcp:1420`。页面 HTTP 与 Vite HMR WebSocket **全部**经 USB 回环
     直达开发机:全双工,不经设备侧代理（Clash 等会破坏对 LAN IP 的 WS Upgrade 半开握手,
     症状为 HTTP 能通但热更新 WS 不通）,且不依赖局域网 IP（换网络无需重渲染 conf）。
   - 配套（主仓库,非 fork）:`component-plugin.ts` 的 `devServerHost` helper 恒返回
     `localhost`（devUrl/CSP）、`KABEGAME_DEV_SERVER_HOST=127.0.0.1`（debug ingest 同走回环）;
     `vite.config.pub.ts` Android 不再覆盖 `origin`/`hmr`（location 派生默认即 localhost:1420）。
   - 注意:Windows 上 stock `DevHost::default()` 为「强制公网地址」（`options.host.0.is_some()`
     恒真）,此 patch 在 Windows 开发机上不生效——kabegame 桌面开发机为 Linux,如需 Windows
     跑 android dev 再议。模拟器行为与 stock 一致（本就走 localhost 分支）。

## 构建系统接线

- `scripts/plugins/tauri-cli-plugin.ts`（`TauriCliPlugin`，注册于 build-system `commonUse`）：
  - `prepareEnv`：`third/tauri/target/release` 前置 `PATH`（`cargo tauri` 命中 fork；产物落
    monorepo workspace 的 `target/`，非子 crate 目录）；设 `TAURI_NO_WEBKIT_DEPS=1`。
  - `beforeBuild`：dev/build 的主组件流程、**以及 android check**（`needsTauriCli` 覆盖
    `isCheck && isAndroid && isMain`）先 `cargo build --release --manifest-path
    third/tauri/crates/tauri-cli/Cargo.toml`（增量，已最新近似 no-op；桌面 check/test/cli/web
    不触发）。**前置**须已 `bun run patch tauri` 应用 series。
- `scripts/build-system.ts` `check()`：android 分支走 `cargo tauri android check --features <...>`
  （`bin: "cargo"`, cwd=appDir），并先 `beforeBuild.call()`（渲染 tauri.conf.json + 确保 fork 已构建；
  os-plugin/mode-plugin 的 beforeBuild 对 check 均 no-op）。桌面/CLI 仍走裸 `cargo check -p`。
- `scripts/plugins/mode-plugin.ts`：android mode `prepareEnv` 设
  `TAURI_ANDROID_PACKAGE=app.kabegame`（固定）；注入 FFmpeg/rusty_v8/bindgen/`PKG_CONFIG_ALLOW_CROSS`
  等交叉 env，但**不**手写 target linker/CC/CXX/AR（由 `tauri android {build,check}` 经 cargo-mobile2 提供）。
- `gen/android/app/build.gradle.kts`：`namespace = "app.kabegame"`（固定字面量）；
  `applicationId = tauriIdentifier`（JsonSlurper 读渲染后的 tauri.conf.json，按 mode）。
- 手写 Kotlin（`MainActivity.kt`/`KgpgDocImage.kt`）固定 `package app.kabegame`，正常
  git 跟踪；`src/debug/res/values/strings.xml` 覆盖 debug 安装的应用名为 “Kabegame Dev”。
- root `Cargo.toml`：`exclude` 含 `third/tauri`（monorepo 有自己的 `[workspace]`，其
  `crates/tauri-cli` 是独立二进制工程、`crates/tauri-runtime` 等经 `[patch.crates-io]` 引入，
  均非 kabegame workspace 成员）。
- `src-tauri/kabegame/build.rs`：**JNI 符号包覆盖**（不在 fork 内，在 app 侧）。tao/wry 把
  原生入口导出为 `Java_<domain>_<app_name>_Rust_*`，`<domain>`/`<app_name>` 由 `tauri-build`
  （运行时 crate，非 CLI）拆 `config.identifier`（去尾段→PREFIX、尾段→APP_NAME）派生的两个
  `rustc-env` 决定。identifier 按 mode（dev `app.kabegame.dev`）会得到
  `Java_app_kabegame_dev_Rust_*`，但 Kotlin `Rust` 类在固定 `namespace`（`app.kabegame`）里，
  JVM 解析不到 → `UnsatisfiedLinkError: app.kabegame.Rust.create()`。故在 `try_build` **之后**
  按 `TAURI_ANDROID_PACKAGE` 重新 emit `TAURI_ANDROID_PACKAGE_NAME_APP_NAME`/`_PREFIX`
  （escaping 与 tauri-build 一致：APP_NAME 仅替换 `-`，PREFIX 每词把 `_`/`-` 转 `_1`）；
  cargo 对重复 `rustc-env` 键取**最后一次**，故覆盖 tauri-build 的 identifier 派生值，符号稳定为
  `Java_app_kabegame_Rust_*`（与 applicationId 的 mode 后缀无关）。

## 升级（re-vendor）流程

1. `bun run patch tauri -r` 还原 submodule 到上游纯净树。
2. 把 `third/tauri` submodule bump 到新的上游 tag（选 `tauri`/`tauri-runtime` 版本与 app
   解析一致的），提交新的 submodule 指针。
3. 逐个 `git apply --check third-patches/tauri/NNNN-*.patch` 核对漂移并修复，逐一核对 patch 点：
   - `mobile/android/mod.rs` 的 `get_config`（identifier→包/目录派生处）
   - `mobile/mod.rs` 的 `ensure_init`（Android「项目过期」检查的 java_folder 派生，应用 `android_package`）
   - `mobile/android/{dev,run}.rs` 的 `"{...}.MainActivity"`（上游已是全限定形式，改喂 `android_package`）
   - `interface/rust.rs` 的 `depends_deb.push("libwebkit2gtk-...")`
   - `icon.rs` 的 `icns()`（`resize_exact_inset` + `MACOS_ICON_CONTENT_SCALE`；
     若需重生成图标，patch 后重建 fork 再跑 `cargo-tauri icon`）
   - `mobile/android/mod.rs` 的 `Commands::Check` 分发 + `mobile/android/check.rs`
     （核对 `crate::build::Options`/`get_app`/`get_config`/`AppInterface::new` 签名与
     cargo-mobile2 `Target::check` 是否漂移；漂移则对照当版 `build.rs` 重裁 `check.rs`）
   - `mobile/android/dev.rs` `run_dev` 开头的网络改写条件（删物理设备触发；确认
     `android_studio_script.rs` 的 localhost `adb_forward_port` 分支仍在）
   - `tauri-runtime` 的 `Cargo.toml`（`webkit` feature + `webkit2gtk` optional）与
     `webview.rs`（三处 `#[cfg(all(feature = "webkit", any(linux...)))]` 门控）
4. 重新生成编号 patch 文件并更新 `third-patches/tauri/README.md`；如新 tag 的 `tauri-utils`
   版本与 crates.io 最新不一致，`cargo update -p tauri-utils --precise <monorepo 版本>` 重钉。
5. 主仓库更新 submodule 指针；跑一次
   `bun dev -c kabegame --mode android`、`bun check -c kabegame --mode android --skip vue`
   与 Linux `bun b` 验证。

## 已知边界

- `tauri android init`（重建 gen/android）未适配 `TAURI_ANDROID_PACKAGE`——仓库的
  gen/android 是手工维护 + git 跟踪的，不应 re-init。
- stock CLI（未设 env 时）行为与上游 2.9.4 一致：`TAURI_ANDROID_PACKAGE`/webkit patch 仅在
  设置 env 的 kabegame 构建流程生效；`android check` 是纯新增子命令，不改动既有命令；`tauri icon`
  的 icns inset 仅影响 `.icns` 输出。桌面三平台构建不受影响。
