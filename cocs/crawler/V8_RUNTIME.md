# V8 爬虫运行时

V8 后端在桌面 + Android（仅 `aarch64`）均启用，仅 iOS 不支持。运行时用 `deno_core`，无 V8 启动快照、无 residual 烧录表；网络全部走宿主 `reqwest`，故不引入 `deno_fetch` / `deno_net` / `deno_tls`（详见「运行时架构与网络」「Android 交叉编译」两节）。

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
- **无 V8 启动快照**：扩展在 `init(...)` 阶段即时注册（deno 扩展的 lazy JS 在非快照构建里以 `IncludedInBinary` 内联，`loadExtScript` 直接解析），故也无 residual 烧录表与 `build.rs` 快照生成步骤。启动多花几百 ms，非瓶颈。

## Android 交叉编译

- 依赖门控：`deno_*`、`sys_traits`、`tokio-util` 是 `plugin-runtime` feature 的 optional dependencies，并继续用 `cfg(not(target_os = "ios"))` 覆盖桌面 + Android。主 app 显式启用 `plugin-runtime`；自包含 CLI 关闭 core default features，因此不会编译 deno/rusty_v8。`reqwest` 桌面用 `native-tls`、Android 用 `rustls-tls`（既有约定）。`plugin/v8.rs`、metadata migration 与 `task_scheduler.rs` 的 V8 调度分支都受该 feature 门控。
- **仅编译 `aarch64`**：`rusty_v8`（v8 crate 149.x）只对 `aarch64-linux-android` 提供预编译静态库（GitHub Release），且 V8 静态库体积大；`RustPlugin.kt` 默认 ABI/arch/target 收敛到 `arm64-v8a` / `arm64` / `aarch64`。其它 ABI 需显式传 `-PabiList/-ParchList/-PtargetList` 并自备 `V8_FROM_SOURCE`（depot_tools/gn/ninja 针对 NDK 从源码编译，成本高，不建议）。
- 前置校验（打包前必须确认）：`rusty_v8` 对应版本的 Release 确有 `aarch64-linux-android` 预编译；NDK 的 `libc++_shared.so` 随 APK 打包（V8 静态库需链接 libc++）；`minSdk` 与预编译要求兼容。缺预编译则整条路需回到 `V8_FROM_SOURCE` 重估。
- 平台差异：Android **无 WebView 爬虫后端**（那条路径依赖桌面 CEF，仍 `cfg(not(target_os = "android"))`）；Android 侧 JS 插件只走 V8 后端。
