# Stash: V8 后端 Android 交叉编译 — rusty_v8 预编译缺失,待 Linux 机器自建

> 写于 2026-07-13(macOS 机器上)。用途:换到 Linux 电脑后恢复上下文,继续走「路线 A:一次性自建 librusty_v8 + 产物注入」。

## 背景:已完成的改造(工作区未提交)

V8/deno_core 爬虫后端已从「仅桌面」改为「桌面 + Android(仅 aarch64),仅 iOS 排除」:

- **无 V8 启动快照、无 residual 表**:扩展在 `JsRuntime::new` 时即时 `init(...)`(deno lazy JS 在非快照构建里 `IncludedInBinary`,`loadExtScript` 直接可解析)。`build.rs` 只剩 rerun-if-changed。
- **网络全部宿主化**:`fetch`=`op_kabegame_fetch`、`Kabegame.to`=`op_kabegame_to`,都走 reqwest;**不引入 deno_fetch/deno_net/deno_tls**,`Headers`/`Response` 在 `prelude.js` 自实现。
- 保留的 deno 扩展:`deno_webidl` / `deno_web` / `deno_crypto`(cppgc,isolate 建好后 `loadExtScript` 显式加载挂全局)。
- 依赖门控:deno_* 是 `plugin-runtime` feature 的 optional deps,`[target.'cfg(not(target_os = "ios"))']`;reqwest 桌面 native-tls / Android rustls-tls;Android 另有 vendored openssl。
- `RustPlugin.kt`(`src-tauri/kabegame/gen/android/buildSrc/.../RustPlugin.kt`)默认 ABI/arch/target 收敛到 `arm64-v8a` / `arm64` / `aarch64`。
- 文档已同步:`cocs/crawler/V8_RUNTIME.md`(新增「运行时架构与网络(宿主化)」「Android 交叉编译」两节)+ `cocs/README.md` 索引条目。


## 卡点:Android 构建失败的根因(已核实)

`bun dev -c kabegame --mode android` → `cargo build --target aarch64-linux-android` 在 v8 crate 的 build.rs 处 panic:

- 它去下载 `https://github.com/denoland/rusty_v8/releases/download/v149.4.0/librusty_v8_simdutf_release_aarch64-linux-android.a.gz` → **HTTP 404**。
- **rusty_v8 官方从 v0.102.0(2024 年中)起停发 Android 预编译**。扫过全部历史 Release:最后一个带 android 静态库的是 **v0.101.0**(还同时有 x86_64-linux-android);v129→v150.1.0 全部没有。
- 缺的不止 `.a`:crates.io 的 v8-149.4.0 包里 `gen/` 目录**也没有 android 版 `src_binding_*.rs`**(build 日志指向的 `gen/src_binding_simdutf_release_aarch64-linux-android.rs` 不存在)。所以要补齐 **两个产物**:静态库 + binding。
- 日志开头 deno 的 `error: unexpected argument '--allow-net'` 是噪音:v8 下载脚本先试 `deno eval --allow-net`(新版 deno 已移除该 flag),回退 python 才暴露 404。
- 没找到可靠的第三方 android 预编译发布。
- v8 149.4.0 build.rs 的 from-source android 分支完整保留:自动下载 **NDK r26c**、`target_os="android"` gn args、clone `android_platform`;但 NDK 工具链路径硬编码 `toolchains/llvm/prebuilt/linux-x86_64` → **from-source 只能在 x86_64 Linux 宿主做**(macOS 不行,这正是换 Linux 机器的原因)。

## 路线 A:Linux 上的下一步(按顺序)

1. **一次性自建**(x86_64 Linux;本机或 GitHub Actions ubuntu runner 均可):
   ```bash
   git clone --depth 1 --branch v149.4.0 https://github.com/denoland/rusty_v8
   cd rusty_v8
   rustup target add aarch64-linux-android
   V8_FROM_SOURCE=1 cargo build --release --target aarch64-linux-android --features simdutf -vv
   ```
   - `--features simdutf` 必须:deno_core 0.405 开了 simdutf feature(404 文件名里的 `simdutf` 后缀即证据)。产物内容要与 feature 集合一致。
   - build.rs 会自动下载 NDK r26c / gn / ninja / clang;需要较大磁盘(≥ 10–20 GB)与较长时间(CI 约 30–60 min)。
   - 产物两个:
     - `target/aarch64-linux-android/release/gn_out/obj/librusty_v8.a`
     - `target/aarch64-linux-android/release/gn_out/src_binding.rs`
2. **产物注入**(此后任何宿主的 android 交叉编译都不再需要 gn/V8 源码):
   ```bash
   export RUSTY_V8_ARCHIVE=/abs/path/librusty_v8.a          # 非 http(s) URL 时 build.rs 走本地拷贝(copy_archive)
   export RUSTY_V8_SRC_BINDING_PATH=/abs/path/src_binding.rs # build.rs 原样透传该 env(build.rs:873-875)
   bun dev -c kabegame --mode android   # 或 cargo build --target aarch64-linux-android ...
   ```
   - 注入点待定:可先手动 export 验证,跑通后再考虑固化(如 kabegame 的 build 系统在 android mode 下自动设置;产物放哪、是否进 LFS/Release 由用户定)。
3. **可持续版(可选)**:fork rusty_v8,把 android 加回 CI 发布矩阵发自己的 Release,然后设 `RUSTY_V8_MIRROR=<自己的 release 下载前缀>`;升级 deno_core 时 re-run CI 即可。
4. **验证链**(此前被用户暂停,未跑过):
   - 桌面 `cargo test -p kabegame-core plugin::v8`(验证无快照 + 自实现 Response/Headers 运行时)
   - `bun check -c kabegame --skip vue`
   - android target cargo build → APK 真机跑一个 JS 插件任务(fetch/crypto/DOMParser 冒烟)
5. **文档跟进**:`cocs/crawler/V8_RUNTIME.md` 第 30 行「前置校验:rusty_v8 对应版本的 Release 确有 aarch64-linux-android 预编译」**已被证伪**,跑通后改写为「自建产物 + RUSTY_V8_ARCHIVE / RUSTY_V8_SRC_BINDING_PATH 注入」的说明(连带 cocs/README.md 索引措辞)。

## 已否决的路线

- **B. 降级 deno_core 到 v8 ≤0.101 时代**:2024 年中的老 API/老 V8,扩展 init 模型不同,等于重做刚完成的运行时改造。否。
- **C. Android 放弃嵌入式 V8 / 走 WebView**:与用户明确指示冲突("不用 webview 跑")。否。

## 其他注意

- NDK 的 `libc++_shared.so` 需随 APK 打包(V8 静态库链 libc++);`minSdk` 与 NDK r26c 匹配(binding 名暗示 android24 clang)。
- rust-analyzer 的 proc-macro ABI mismatch 诊断(rustc 1.93 vs 1.97)是本机环境噪音,与本改造无关。
