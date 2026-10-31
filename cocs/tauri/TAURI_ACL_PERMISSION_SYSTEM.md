# Tauri ACL 与权限系统（kabegame）

本文记录 `src-tauri/kabegame` 的 Tauri v2 ACL（capability + permission）机制、常见坑位，以及一次“所有命令都找不到”的故障复盘。

## 适用场景

- 需要给某个窗口（如 `surf`）新增 IPC 权限，或新增一个 `#[tauri::command]`。
- 出现 `invoke` 命令被拒绝、提示命令不可用/找不到，或 `listen` 报 ``event `x` is not allowed to be listened by ACL``。
- `emit_to` 定向事件送错 / 收不到，子 frame（iframe）调用 IPC 被拒、收不到事件或 Channel 消息。
- 调整 `capabilities/*.json`、`permissions/*.toml`、`tauri.conf.json` 时做变更评估。

## 涉及文件

- `src-tauri/kabegame/tauri.conf.json`
- `src-tauri/kabegame/tauri.conf.json.handlebars`
- `src-tauri/kabegame/capabilities/main.json`
- `src-tauri/kabegame/capabilities/main.json.handlebars`
- `src-tauri/kabegame/capabilities/crawler.json`、`surf.json`、`surf-navbar.json`、`wpe-web.json`、`android.json`
- `src-tauri/kabegame/permissions/*.toml`（只剩 `crawler` / `surf` / `surf-navbar` / `wpe-web`）
- `src-tauri/kabegame/build.rs`
- `src-tauri/kabegame/src/lib.rs`（`configure_app`：`acl_exempt_webview` 与 `generate_handler!`）
- `src-tauri/tauri-runtime-kbcef/src/protocol.rs`（`attach_request_frame`：`IpcFrame` + 子 frame 的 `SubframeId`）、
  `ipc.rs`（`cef-ipc` 回退通道带上 frame）、`runtime.rs`（`EvalInSubframe`）、`webview.rs`（`on_frame_destroyed`）、
  `subprocess.rs`（子 frame 注入桥脚本）
- `third-patches/tauri/14`–`19`（见 [third-patches/tauri/README.md](../../third-patches/tauri/README.md)）

参考（工作区 Tauri 源码，`deno task patch tauri` 套上补丁后）：

- `third/tauri/crates/tauri/src/webview/mod.rs`（`on_message`）
- `third/tauri/crates/tauri/src/ipc/authority.rs`（`resolve_access`、`is_exempt`）
- `third/tauri/crates/tauri/src/event/{listener.rs,plugin.rs}`（按 frame 的投递与 `listen`）
- `third/tauri/crates/tauri/src/ipc/{channel.rs,protocol.rs}`（Channel 与回退响应按 frame 回送）
- `third/tauri/crates/tauri/src/manager/webview.rs`（`subframe_bridge_scripts`、`SubframeDestroyed` 清理）
- `third/tauri/crates/tauri-build/src/acl.rs`
- `third/tauri/crates/tauri-utils/src/acl/{capability.rs,resolved.rs,build.rs}`

## 本工程当前 ACL 结构

### 1) capability 入口

`tauri.conf.json` / `tauri.conf.json.handlebars` 中 `app.security.capabilities` 指定启用的 capability 集合。

当前桌面端核心是：

- `main-capability`
- `crawler-capability`

### 2) capability 定义

- `capabilities/main.json`（由 `main.json.handlebars` 生成）：主窗口与壁纸窗口（`main` / `wallpaper`）。两者的本地应用页
  **免 ACL**（见下文「特赦 webview」），所以这里不再列应用命令，只保留 `core:default` 等核心权限与插件权限——
  特赦不影响 ACL 解析，插件命令的作用域（如 opener 的 URL 范围）仍靠这些授权传下去。
- `capabilities/crawler.json`：爬虫窗口权限（`crawler`）+ remote URL 访问范围，没有任何事件权限。
- `capabilities/surf.json`：畅游内容页（远程站点），只有 `surf` 命令组，没有事件权限。
- `capabilities/surf-navbar.json`：畅游导航栏（本地页面），`surf` + `surf-navbar` 两组命令，`listen` 只能听
  `surf-url-changed` / `surf-collect-state`，外加 `allow-unlisten`。
- `capabilities/wpe-web.json`：WPE 网页壁纸页面，即 `WallpaperStage` web 层里的 `file:` iframe（`wpe-web-capability`，
  `windows: ["main", "wallpaper"]`——图库预览在主窗口、桌面在壁纸窗口，同一份；`frames: "sub"`——只给 iframe，两个窗口的
  主 frame 都是应用页、靠特赦；`local: false`、`remote.urls: ["file:///*"]`）。`listen` 只能听 `wallpaper-ping` /
  `setting-change` / `image-changed` / `images-change`，外加 `allow-unlisten` 与 `permissions/wpe-web.toml` 的
  `wpe_web_pull_state` / `wallpaper_pong`；只在桌面分支的 `tauri.conf.json.handlebars` 里启用。网页壁纸里再嵌的 `file:`
  iframe 同样匹配（同一作者的内容，信任级别相同）。

### 3) build 入口

`src-tauri/kabegame/build.rs` 当前使用 `tauri_build::build()`。

这意味着 ACL 的行为由 Tauri 默认机制驱动：读取 capability 文件、处理 permission 文件，并生成运行时授权数据。

## 核心机制（必须理解）

在 Tauri 运行时，是否对“应用命令”（非 `plugin:xxx|yyy`）进行 ACL 检查，关键在 `has_app_acl_manifest`。

来自 `tauri/src/webview/mod.rs`（工作区 Tauri 源码）：

```rust
// we only check ACL on plugin commands or if the app defined its ACL manifest
if (plugin_command.is_some() || has_app_acl_manifest) && invoke.acl.is_none() {
  // reject
}
```

结论：

- 只要应用侧出现 `app ACL manifest`，应用命令就会进入 ACL 校验路径。
- 若 capability/permission 未完整覆盖已有命令，原本可用的命令会被整体拒绝。

补丁后的拒绝条件多了两项（`third/tauri/crates/tauri/src/webview/mod.rs` 的 `on_message`）：

```rust
let acl = runtime_authority.resolve_access(&request.cmd, window, webview, &acl_origin, request.frame);
let acl_exempt = runtime_authority.is_exempt(webview, &acl_origin, request.frame);
// …
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
  && request.cmd != FETCH_CHANNEL_DATA_COMMAND
  && invoke.acl.is_none()
  && !acl_exempt
{ /* reject */ }
```

`resolve_access` 在「来源 + window / webview label」之外还要求 capability 的 `frames` 匹配请求的 frame；
`acl_exempt` 见「特赦 webview」。

## 故障复盘：为什么会“所有命令都找不到”

### 现象

- 画廊数据加载失败。
- 多个 `invoke` 命令统一报“找不到/不可用”。

### 触发链路

1. 新增了 app 级 `permissions/*.toml`（仅为单个命令放行）。
2. 新增了只覆盖某个窗口的 capability（如 `surf-capability`）。
3. Tauri 构建后识别到 app ACL，`has_app_acl_manifest` 从 false 变为 true。
4. 应用命令整体进入 ACL 校验，但没有为 `main` 窗口全面授予权限。
5. 结果就是大量命令被拒绝，看起来像“全部命令失效”。

### 已采用修复策略

- 删除此次临时新增的 app 级手写 permission / surf capability。
- 恢复到原本 capability 结构（`main` + `crawler`）。
- 让 `has_app_acl_manifest` 回到原先行为预期，避免影响全局命令路径。

## 新增一个 `#[tauri::command]` 时（最常见情形）

本工程处于 ACL 强校验（存在 app 级 manifest），但**主窗口与壁纸窗口的本地应用页免 ACL**
（`lib.rs` 的 `.acl_exempt_webview("main").acl_exempt_webview("wallpaper")`）。所以只给主界面 / 壁纸窗口应用页用的
命令，**只需在 `lib.rs` 的 `generate_handler!` 注册**，不用登记任何权限文件（原 `permissions/main.toml` 已删除）。

要给其它页面调用的命令，按调用方补对应的 `permissions/*.toml`：

| 调用方 | 权限文件 | capability |
| --- | --- | --- |
| 畅游内容页（远程站点，注入脚本） | `surf.toml` | `surf-capability` |
| 畅游导航栏（本地页面） | `surf-navbar.toml`（另有 `surf` 组） | `surf-navbar-capability` |
| WebView 爬虫页面 | `crawler.toml` | `crawler-capability` |
| WPE 网页壁纸（预览 / 桌面的 `file:` iframe） | `wpe-web.toml` | `wpe-web-capability`（`frames: "sub"`） |

漏登记在编译期毫无征兆，只在运行时报 `Command <name> not allowed by ACL`。改完 `.toml` 需要重新编译
（`build.rs` 重新生成授权数据），dev 下重启 `tauri dev` 即可。

这些页面要监听新事件时，同样在对应 capability 的 `core:event:allow-listen` 作用域里加上事件名（见「listen 作用域」）。
插件命令（`plugin:xxx|yyy`）仍要在 `main-capability` 里授予插件权限：特赦让请求不被拒，但插件命令的作用域来自授权，
没授权的插件命令拿到的是空作用域。

## 变更建议（后续新增权限时）

### 推荐做法

1. 先评估是否必须引入新的 app 级 ACL 条目。
2. 若必须引入，必须按“窗口 + 命令全集”设计，不要只放行单个新命令。
3. 先在 capability 中明确 `windows` / `webviews` / `remote.urls` 的边界，再补权限项。

### 不推荐做法

- 仅为单个新命令快速加一条 app 级 permission，就立刻挂到全局 capability。
- 未评估 `main` 窗口现有命令集合就切换到严格 ACL。

## 事件投递按接收方身份（tauri 补丁 14）

JS `listen` 时前端传的 `target`（默认 `{ kind: "Any" }`）后端不再读取也不保存。`emit_to` 的目标只和**接收方 webview 的身份**比较：
webview 自己的 label 作为 `Webview{label}`、所在窗口的 label 作为 `Window{label}`，webview 与窗口同名时再加
`WebviewWindow{label}`，目标认其中任一个就投递。

| `emit_to` 目标 | 送到哪些 webview 的 JS 监听 |
| --- | --- |
| `"L"` / `AnyLabel{L}` | label 为 L 的 webview，以及 label 为 L 的窗口里的所有 webview |
| `Window{w}` | 窗口 w 里的所有 webview |
| `Webview{v}` | 只有 v |
| `WebviewWindow{x}` | label 和所在窗口 label 都是 x 的那个 webview |
| `App` | 不送给 JS（只有 Rust 侧 `App::listen`） |
| `emit` / `Any` | 广播，不变 |

所以 `emit_to("surf-a-navbar", "surf-url-changed", …)` 只到 a 的导航栏，前端不用再传 `target`；`emit_to("main", …)` 也不会被
其它窗口的监听者收到。窗口事件（`tauri://resize` 等）送给本窗口里的全部 webview；窗口关闭拦截（`tauri://close-requested`）
看本窗口任一 webview 是否监听了它。`unlisten` 只在调用方 webview 自己的监听表里删除，猜到别人的监听 id 也退订不掉。
Rust 侧 `listen` / `listen_any` 的语义不变。

## listen 作用域（tauri 补丁 15）

`core:event:allow-listen` 可以带事件名作用域，`event` 写完整事件名，末尾 `*` 表示前缀匹配：

```json
{
  "identifier": "core:event:allow-listen",
  "allow": [{ "event": "surf-*" }],
  "deny": [{ "event": "surf-internal" }]
}
```

规则与其它命令作用域相同：先看 deny；同一请求能用上的授权里只要有一条带 allow 作用域，事件名就必须命中其中一条；
全部授权都不带作用域时不限制（`core:default` 里的 `core:event:default` 就是这种，主窗口历来如此）。被拒时 `listen` 报
``event `<name>` is not allowed to be listened by ACL``。核心插件的权限没有 scope schema，capability 里 `allow` 的条目按任意
JSON 校验，tauri-build 不报错——**拼错键名不会有构建期提示**，写完在真机上验一次。

## frames 维度（tauri 补丁 16）

ACL 的判定维度在「来源（`local` / `remote.urls`）+ window / webview label」之外加上**发起请求的 frame**。capability 新增字段
`frames`：`"main"`（默认，只认最外层主 frame）、`"sub"`（只认 iframe）、`"any"`（都认，也包括 runtime 给不出 frame 的请求）。
现有 capability 一行不改就只认主 frame；补丁 19 起 CEF 下每个子 frame 都有 IPC 桥（见「子 frame IPC」），`frames` 是子 frame
能做什么的唯一闸门。显式 deny 不看 frame。

frame 由 runtime 从浏览器进程取得、放进 `http::Request` 的 extension（`tauri::webview::IpcFrame`），页面能伪造请求头，
但伪造不了 extension：

- 桌面 CEF：`tauri-runtime-kbcef` 的 `protocol::attach_request_frame` 给每个自定义协议请求插入 `IpcFrame`（主 frame → `Main`，
  子 frame → `Sub`，CEF 没给出 frame 时 → `Unknown`，只有 `frames: "any"` 能匹配）；`cef-ipc` 回退通道重新构造请求时把它带上。
  CEF 只对 service worker 与 `CefURLRequest` 给不出 frame；dedicated worker 的请求记在创建它的 frame 上，子 frame 借 worker 绕不过去。
  子 frame 另带路由用的 `SubframeId`（见「子 frame IPC」）；回退通道放行所有 CEF 给出了 frame 的请求，交给 ACL 判定。
- Android（wry）：不上报，请求里没有这个 extension 时 Tauri 按主 frame 处理（wry 的 IPC 只收主框架消息）。

平台限制：同源子 frame 可以直接用父页面的 `__TAURI_INTERNALS__`，这样发出的请求在浏览器看来就是父 frame 发的，记为主 frame。
本方案不处理这种情况。

**拒绝信息看不出 frame。** 带调用方 URL、frame 与「allowed on」列表的详细文案（`resolve_access_message`）只在 tauri 以
debug-assertions 编译时存在；本仓根 `Cargo.toml` 的 `[profile.dev.package."*"] debug-assertions = false` 对 tauri 同样生效
（它经 path 补丁引入、不是工作区成员），所以 dev 与 release 都只报 `Command xxx not allowed by ACL`。不要只给 tauri 打开：
`ResolvedCommand` 的部分字段只在 tauri-utils 开 debug-assertions 时存在，要开就得整套 tauri crate 一起开。判断是不是 frame
维度拒的，用对照组：同一个 invoke key、同一个命令，在主 frame 发出放行、换到 iframe 发出被拒，就是 frame 不匹配。

## 特赦 webview（tauri 补丁 17）

`Builder::acl_exempt_webview(label)` 登记的 webview（label 精确匹配，不支持 glob），**只要请求同时满足「本地来源」与「主 frame」**：

- invoke 不因 ACL 被拒，显式 deny 也一样；
- `listen` 不受事件名作用域限制。

ACL 仍照常解析：已授权命令的作用域照常传给命令，未授权的命令拿到空作用域。本应用特赦 `main` 与 `wallpaper`，两个窗口的主
frame 始终是应用页（网页壁纸是子 frame 里的 iframe，窗口不再导航）；任何子 frame 都不特赦。

| 请求方 | frame | invoke 应用命令 | listen `images-added` | listen `setting-change` |
| --- | --- | --- | --- | --- |
| 主窗口 / 壁纸窗口应用页 | 主 | 放行（特赦） | 放行 | 放行 |
| 预览网页壁纸 `file:` iframe（主窗口） | 子 | 只有 `wpe_web_pull_state` / `wallpaper_pong`（`wpe-web-capability`） | 拒绝 | 放行 |
| 桌面网页壁纸 `file:` iframe（壁纸窗口） | 子 | 同上 | 拒绝 | 放行 |
| 网页壁纸里再嵌的 `file:` iframe | 子 | 同上（同一份 capability） | 拒绝 | 放行 |
| 插件详情 EJS iframe（`about:srcdoc`，opaque） | 子 | 拒绝（有桥，没有 capability 匹配） | 拒绝 | 拒绝 |
| 主窗口里同源 iframe | 子 | 拒绝（特赦只认主 frame） | 拒绝 | 拒绝 |
| 畅游导航栏 | 主 | `surf` / `surf-navbar` 两组 | 拒绝 | 拒绝（只能听两个 surf 事件） |
| 畅游外部页面 | 主 | 只有 `surf` 组 | 拒绝（没有事件权限） | 拒绝 |
| 畅游外部页面里的任何 iframe（含第三方广告） | 子 | 拒绝（有桥，`surf-capability` 只认主 frame） | 拒绝 | 拒绝 |
| CEF 给不出 frame 的请求 | Unknown | 拒绝，除非 capability 写了 `frames: "any"` | 同左 | 同左 |

## 子 frame IPC（tauri 补丁 18–19）

frame 是 IPC 的基本单位：子 frame 有自己的 Tauri 桥，Tauri 送回页面的东西都送到发起调用的那个 frame。

- **注入**：Tauri 把自己的四段桥脚本（`isTauri` / internals、invoke 脚本、metadata、`init.js`）另交给 runtime
  （`WebviewAttributes::subframe_bridge_scripts`，补丁 19）；CEF runtime 在渲染进程里**无条件**先把它们（连同 `cef-ipc`
  回退 shim）注入每个子 frame，再跑原有的初始化脚本。注入范围不从 capability 推断：规则只有一条，每个子 frame 都有桥，
  能调什么只看 ACL。插件初始化脚本与 isolation pattern 不进子 frame。wry 不上报 frame，必须忽略这份脚本（Android 不变：
  子 frame 没有桥）。代价是 invoke key 对所有子 frame 可见，包括畅游页里的第三方 iframe——补丁 16 之后 key 只能拿到该 frame
  自己的 capability，不再是闸门。
- **路由**：子 frame 的请求在 `IpcFrame::Sub` 旁再带一个不透明的 `SubframeId`（CEF 的 frame identifier，放在请求 extension 里，
  页面伪造不了）；主 frame 不带，按 webview 寻址（CEF 的主 frame id 跨源导航会变，`clear_js_listeners` 等语义也按 webview 定义）。
  Tauri 用 `FrameAddress { Main, Sub(SubframeId) }` 表示投递目标，存在 `InvokeMessage` 上显式传递（不让 `Webview` 隐式携带，
  免得命令存下的 `Webview` 之后 eval 进一个已销毁的 frame）。`IpcFrame::Unknown` 与没有 id 的 `Sub` 没法回送：`listen` 报
  ``event `<name>` cannot be listened: the calling frame cannot receive events``，Channel 参数报错，回退响应丢弃。
- **四类回送数据**都 eval 到调用方 frame（主 frame 仍是原来的 `webview.eval`，子 frame 经 runtime 的
  `eval_script_in_subframe`，frame 已销毁时静默丢弃）：

  | 来源 | 主 frame 发起 | 子 frame 发起 |
  | --- | --- | --- |
  | `listen` 登记 / 事件投递 | `webview.eval`（不变） | `eval_script_in_subframe(id)` |
  | Channel 消息（命令参数里的 Channel） | `webview.eval`（不变） | `eval_script_in_subframe(id)` |
  | `cef-ipc` 回退通道的响应 | `webview.eval`（不变） | `eval_script_in_subframe(id)` |
  | `ipc://` 主通道响应 | HTTP 响应（不变） | HTTP 响应（不变） |

  JS 监听表按「webview → frame → 事件」三级存储：接收方判定不变（补丁 14 的 webview 身份），投递按 frame 展开，主 frame 与
  子 frame 同时监听同一事件时各收一次；`unlisten` 只在调用方 frame 的表里删，猜到别人的 id 也退订不掉。命令里自己反序列化的
  `JavaScriptChannelId::channel_on(webview)` 仍指主 frame。
- **Channel 取数**：`plugin:__TAURI_CHANNEL__|fetch` 是唯一绕过 ACL 的命令，大数据队列的 id 按 webview 顺序递增、可以被猜到；
  队列条目记下它要送达的 frame，只有发起方 frame 与条目一致时才取出，否则按 `data not found` 处理。
- **生命周期**：runtime 在子 frame 销毁时上报 `WebviewEvent::SubframeDestroyed`（CEF 的 `FrameHandler::OnFrameDestroyed`），
  Tauri 删掉该 frame 的全部监听与未取走的 Channel 数据。同一 frame 内重新导航后旧条目还在、投递进新文档时找不到 id 等于空操作，
  直到 frame 销毁；主 frame 的清理仍靠补丁 11 的 `clear_js_listeners`（清整个 webview 的全部 frame）。CEF 跨源加载子 frame
  时先建、后销毁的临时 frame 也会报一次，删除是空操作。
- **关闭拦截只看主 frame**：`tauri://close-requested` 的监听只有在主 frame 才算数，子 frame 是客人，不能阻止窗口关闭。
- **调用方来源**：命令可以收 `tauri::ipc::CallerOrigin(Url)`，即 ACL 判定所用的来源（请求的 `Origin`）。普通页面只有
  scheme + host + port；`file:` frame 的完整文档 URL 由 CEF 07 建工厂时捕获，再由 runtime 写入 `Origin`，`wpe_web_pull_state` 靠它认出调用的
  是哪张网页壁纸（`Url::to_file_path` 不看 scheme，用之前先确认是 `file:`）。
- **来源回退**：`cef-ipc` 的 `Origin` 不合法时，所有 frame 都用 `kabegame-unattributed://ipc/` 交给 ACL 拒绝；不读取 frame URL 或应用页初始 URL。

已知限制：同源子 frame 仍可以直接用父页面的 `__TAURI_INTERNALS__`，请求会记为主 frame（见「frames 维度」）。

## 远程 `file:` 来源（WPE 网页壁纸）

`file:` 文档的 `Origin` 请求头是 `null`。CEF runtime 的 `cef-ipc` 回退通道过去拿不到合法 Origin 时会退到 webview
初始 URL（应用页），请求被 Tauri 判成 `Origin::Local`，于是本地 capability（`main-capability`）的全部命令都能调。
现在 CEF 补丁 07 在建工厂时捕获所属文档 URL 与父文档 URL；运行时以浏览器给出的 `request_initiator` 判来源，仅在它是 `file:` 时用完整文档 URL 细化身份（`protocol::ipc_origin`）。无法归属写 `null` 并拒绝，不能用 `frame.url()`：它要到导航完成才刷新。网页壁纸 iframe 以 `Origin::Remote { url: file:///… }` 匹配 `remote.urls` 和 `frames: "sub"`，只得 `wpe-web-capability`。新命令加进 `permissions/wpe-web.toml`，监听加进 `wpe-web.json` 的 `allow-listen`。本地特赦不覆盖它。

## 快速排查清单

单个命令报 `not allowed by ACL` 时：

1. 调用方是主窗口 / 壁纸窗口应用页吗？是的话应当被特赦。报错文案不带 URL / frame（见上文），用 CDP 在调用方上下文看
   `location.href` 与 `window === top`：不是主 frame（iframe 里调的）或页面已导航到外部内容，就不特赦。
2. 其它页面：看命令有没有进对应 `permissions/*.toml` 的 `commands.allow`（见「新增一个 `#[tauri::command]` 时」）。
3. 同一命令在主 frame 放行、在 iframe 被拒：capability 默认只认主 frame，需要时显式写 `frames`。
4. iframe 里 `listen` 报 ``cannot be listened: the calling frame cannot receive events``：runtime 没给出这个 frame 的
   `SubframeId`（或请求根本没有 frame，如 service worker），Tauri 无处回送。

`listen` 报 ``is not allowed to be listened by ACL``：把事件名加进该窗口 capability 的 `core:event:allow-listen` 作用域。
定向事件收不到：确认 `emit_to` 的目标是接收方 webview 或其窗口的 label（见「事件投递按接收方身份」）。

出现“命令都不可用”时，优先检查：

1. `tauri.conf` 的 `app.security.capabilities` 是否新增/变更。
2. `capabilities/*.json` 是否限制了 `windows` / `webviews`。
3. 是否引入了新的 app 级 `permissions/*.toml`。
4. 结合 Tauri 源码中的 `has_app_acl_manifest` 路径判断是否进入了 ACL 强校验。
