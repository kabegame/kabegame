# 走查：远程页面窗口暴露 Tauri 全局

2026-10-27。范围：爬虫窗口（`crawler-*`），**桌面 CEF 与 Android WebView 都要覆盖**。畅游窗口（`surf-*`）是同一个问题，见 §5。

实现只放在跨平台的共享层：`third-patches/tauri`（初始化脚本的组装、`scripts/*.js`、Rust → 页面的 eval 目标），以及 `webview_js/` 和建窗处的脚本组装。**不改 `tauri-runtime-kbcef`**：CEF 和 Android 拿到的是同一份脚本。

## 0. 结论

爬虫窗口把初始化脚本注入到被爬站点的主 frame。站点脚本和我们的脚本在同一个 frame、同一个源里运行，而 Tauri ACL 只按「窗口 label + 来源 URL」授权，分不清调用方是谁。`crawler.json` 又放开了任意 `http(s)://*.*`，所以**插件能调的命令，任何被爬站点都能调**。站点不需要任何漏洞，直接调 `window.__TAURI_INTERNALS__.invoke` 就可以。影响举例：

- `crawl_exit()` 让任务以「成功」提前结束，用户会以为已经爬完；`crawl_error(msg)` 让任务失败，错误文案由站点决定。
- 往图库提交任意媒体；改写插件私有数据（`plugin_data` 跨任务持久）；导航爬虫窗口；读写本任务的 VFS。

bootstrap 原本想删掉这个全局，但删除没有生效（见下方代码）。

已处理：2026-10-27 从 `crawler.json` 删掉了 `core:event:allow-listen` / `allow-emit` / `allow-emit-to`。此前站点能订阅全部 AppEvent（`images-added` 带本地路径），也能向主窗口伪造事件。

目标：站点脚本拿不到任何 IPC 能力。为此要做到三点：
1. 抹除所有暴露 IPC 或桥接能力的全局（§1）；
2. 替换 Rust → 页面的全局推送入口（§2）；
3. 留下的 IPC 链路在调用时不再查找任何可被 hook 的东西，避免泄露 invoke key 或返回值被伪造（§3）。

隐身不是目标（见 §6）。

### 现状锚点

**a. 全局定义为不可删除**（`third/tauri/crates/tauri/src/manager/webview.rs:168`）
```js
Object.defineProperty(window, 'isTauri', {
  value: true,                       // 现状：configurable / writable / enumerable 全为 false
});

if (!window.__TAURI_INTERNALS__) {   // 现状：全局不存在就新建（Android 二次执行会走到这里，见 §4.4）
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {                         // 现状：不可删、不可重定义
      plugins: {}
    }
  })
}
```

**b. bootstrap 的删除不生效**（`src-tauri/kabegame/src/webview_js/bootstrap.js:68`）
```js
  // 从 window 上摘掉 Tauri 内部对象，站点脚本无法据此判断处于爬虫环境。   // 现状：注释与事实不符
  // media_capture.js / media_download.js 在本脚本之前注入并已各自捕获引用，不受影响。
  try {
    delete window.__TAURI_INTERNALS__;   // 现状：非严格模式下返回 false，属性仍在；catch 永远不会触发
  } catch (_) {}
```

**c. 提前结束任务**（`src-tauri/kabegame/src/commands/crawler.rs:369`）
```rust
pub async fn crawl_exit<R: Runtime>(webview: WebviewWindow<R>) -> Result<(), String> {
    let (task_id, _) = run_of(&webview)?;          // 现状：只按 webview label 找任务，不区分调用方
    TaskScheduler::global()
        .complete_webview_task(&task_id, Ok(()))  // 现状：直接按成功结束
        .await;
    Ok(())
}
```

## 1. 需要抹除的全局

| # | 全局 | 注入位置 | 现状属性 | 站点能拿它做什么 | 严重度 |
| --- | --- | --- | --- | --- | --- |
| G1 | `__TAURI_INTERNALS__` | `manager/webview.rs:174`，成员分别由 `core.js` / `ipc.js` / `ipc-protocol.js` / `pattern.js` / `path/init.js` 定义 | 不可删、不可写，成员也一样 | `invoke` 调任意已授权命令；`callbacks`（`core.js:64`，标注为「仅调试用」）+ `runCallback` 可以抢先 resolve 任意在途 invoke，伪造返回值 | 严重 |
| G2 | `__kb_media_submit__` | `bootstrap.js:33` | 普通赋值，可写可枚举 | 直接调用可提交任意 VFS 文件入库；替换它可以劫持 `media_download.js:175` 的每次提交（篡改路径、metadata、标签，或直接吞掉） | 高 |
| G3 | `__kb_native_download_finished__` | `bootstrap.js:47` | 普通赋值，可写 | 伪造调用会让插件的 `onNativeDownload` 收到假路径；替换它可以吞掉真实的下载终态。这也是 Rust 的推送入口，见 §2 | 高 |
| G4 | `__kb_media_download__` | `media_download.js:660` | 不可写但可调用 | 触发下载并提交入库 | 高 |
| G5 | `ipc` | CEF：垫片 `tauri-runtime-kbcef/src/ipc.rs:42`。Android：`addWebMessageListener("ipc")`（`ContentWebView.kt:33`），由 WebView 注入 | CEF 上 `configurable: true`；Android 上能否删除待真机确认 | 站点替换或直接调用它，就能拿到出站消息。Android 上每条消息的正文都带 invoke key（见 H6）；CEF 上只有降级后才带 | 严重 |
| G6 | `__kb_media__` | `media_capture.js:609` | 不可写 | 调 `evict` 丢弃已捕获的 MSE 分片，让下载失败或残缺 | 中 |
| G7 | `__TAURI_EVENT_PLUGIN_INTERNALS__` | `event/init.js:6` | 不可删 | 事件权限删掉后已经用不上，只剩探测作用 | 低 |
| G8 | `isTauri` | `manager/webview.rs:170` | 不可删 | 只能用于探测 | 低 |
| G9 | `__kb_i18n__` | `webview_i18n.js:28` | 不可写 | 只能读到文案 | 低 |
| G10 | `__kb_init_<key>__` | Android 守卫 `commands/surf_common.rs:115` | 不可删 | 只能用于探测 | 低 |

我们自己的脚本在调用时才去 `window` 上查 G2、G6、G9 以及 `__kabegame_toast`（`media_download.js:22/26/175/488…`）。抹除之后这些查找要改成初始化时捕获的私有引用。`__kabegame_toast` 在爬虫窗口里本来就不存在，站点可以自己定义一个，从而收到我们的 toast 文案。

## 2. Rust → 页面的推送入口

全局抹除后，eval 进主世界的代码就找不到目标了。这一项是两个平台都绕不开的前置条件。

| # | 推送 | 位置 | 爬虫窗口何时触发 |
| --- | --- | --- | --- |
| P1 | `window.__TAURI_INTERNALS__.runCallback(id, …)` | `ipc/format_callback.rs:103`（postMessage 通道的回包）、`ipc/channel.rs:319/451`（Channel）、`event/mod.rs:219/236`（事件） | **Android 上每次 invoke 的回包都走这里**。CEF 上只要不降级、不用 Channel、没有事件权限就不会触发 |
| P2 | `window.__kb_native_download_finished__?.(payload)` | `commands/crawler.rs:51` | 每次页面自发下载结束时（两个平台都有） |

控制方向：在 `third-patches/tauri` 里，把隔离模式 webview 的 eval 目标统一改成**一个受保护的分发入口**：
- 入口是一个不可写、不可配置的全局函数；
- 调用时校验每页随机 token；token 由 Rust 生成，在建窗时和 invoke key 一样烘焙进初始化脚本。

站点可以调用这个入口，但没有 token 会被拒绝，也包装不了它。P2 也可以改成拉取（插件注册 `onNativeDownload` 时挂一个长等待的 invoke），从而不再需要入口。两个平台都有 eval，所以这个方案不依赖运行时。

## 3. 需要控制的 hook 点

### 3.1 Tauri IPC 链路

两个平台走的是同一份 `ipc-protocol.js`，但分支不同：
- **CEF 走自定义协议**：用 `fetch`，把 key 放在请求头里；
- **Android 没有自定义协议**（`ipc-protocol.js:20`）：每次都用 `JSON.stringify` 把 key 写进正文，再经 `window.ipc.postMessage` 发出。

现状：`third/tauri/crates/tauri/scripts/ipc-protocol.js:31`（CEF 分支）
```js
      const headers = new Headers((options && options.headers) || {})   // 现状：调用时取全局 Headers
      headers.set('Content-Type', contentType)                          // 现状：调用时取 Headers.prototype.set
      headers.set('Tauri-Callback', callback)
      headers.set('Tauri-Error', error)
      headers.set('Tauri-Invoke-Key', __TAURI_INVOKE_KEY__)              // 现状：key 经过可被 hook 的 set

      fetch(window.__TAURI_INTERNALS__.convertFileSrc(cmd, 'ipc'), {     // 现状：调用时取全局 fetch 与全局 internals
```

现状：`third/tauri/crates/tauri/scripts/ipc-protocol.js:72`（Android 主路径；CEF 降级后也走这里）
```js
      const { data } = processIpcMessage({     // 现状：内部用全局 JSON.stringify 序列化
        cmd,
        callback,
        error,
        options: { ...options, customProtocolIpcBlocked: customProtocolIpcFailed },
        payload,
        __TAURI_INVOKE_KEY__                   // 现状：key 写在正文里
      })
      window.ipc.postMessage(data)             // 现状：调用时取 window.ipc
```

invoke key 是整个应用共用的一把（`WebviewManager.invoke_key`，`manager/webview.rs:90`）。只要泄露一次，在本次应用运行期间，站点在任意远程窗口里都能直接发 IPC：桌面上是 `fetch('ipc://localhost/<cmd>')`，Android 上是 `ipc.postMessage`。这样抹除全局也就失去意义。所以下表里任何一个能拿到 key 的点，都等同于 G1。

| # | hook 点 | 位置 | 平台 | 后果 | 严重度 |
| --- | --- | --- | --- | --- | --- |
| H1 | 全局 `fetch` | `ipc-protocol.js:37` | CEF | 看到命令名、参数和 key；可以伪造返回值 | 严重 |
| H2 | `Headers` 构造函数、`Headers.prototype.set` | `ipc-protocol.js:31-35` | CEF | 就算 `fetch` 已经捕获，`set` 依然能拿到 key | 严重 |
| H3 | `Response.prototype.headers`（getter）、`Headers.prototype.get`、`Response.prototype.json/text/arrayBuffer` | `ipc-protocol.js:43-52` | CEF | 读取或篡改所有命令的返回值；让其中一个抛错就能触发 CEF 降级（`:59-67`，任意一次失败都会让本页永久降级） | 高 |
| H4 | `Promise.prototype.then`、全局 `Promise` | `ipc-protocol.js:42/55`，`core.js:83` | 两者 | 截获 Response 对象和 resolve / reject | 高 |
| H5 | `Map.prototype.set/get/delete` | `core.js:26/36/40`（回调表） | 两者 | `set` 会把我们的 resolve 包装函数交给站点，站点可以抢先用假数据调用 | 高 |
| H6 | 全局 `JSON.stringify` | `process-ipc-message-fn.js:18` | Android 每次调用；CEF 降级后 | 看到参数，以及正文里的 key | 严重 |
| H7 | `window.ipc` 与 `ipc.postMessage` | `ipc-protocol.js:84` | Android 每次调用；CEF 降级后 | 见 G5 | 严重 |
| H8 | `ArrayBuffer.isView`、`Array.isArray`、`Array.from`、`Object.fromEntries`、`Map.prototype.entries` | `process-ipc-message-fn.js:9-29` | 两者 | 看到参数，包括 raw 写入的字节 | 中 |
| H9 | `encodeURIComponent` | `core.js:15` | CEF | 看到命令名 | 中 |
| H10 | `window.crypto` getter、`Crypto.prototype.getRandomValues` | `core.js:7` | 两者 | 控制回调 id，配合 G1 / P1 伪造回包 | 低 |

### 3.2 我们注入的脚本

| # | hook 点 | 位置 | 后果 | 严重度 |
| --- | --- | --- | --- | --- |
| K1 | 调用时查 `window.__kb_*` | `media_download.js:22/26/175/488/555/591/605/612/628/639/641` | 见 G2 / G6 / G9；抹除后必须改成私有引用 | 高 |
| K2 | `Object.prototype.hasOwnProperty.call` | Android 守卫 `surf_common.rs:114` | 第二次执行时页面可以 hook 它，让守卫失效（见 §4.4） | 高 |
| K3 | `Promise.prototype.then`、`Set.prototype.add/delete` | `bootstrap.js:57-67`（`trackDownload`） | 看到在途的下载 Promise，可以干扰 `waitPendingDownloads` | 低 |
| K4 | 全局 `fetch`、`btoa`、`String.fromCharCode` | `media_download.js:17-19/656` | 站点只能看到自己页面的媒体，不影响能力 | 低 |

### 3.3 通用要求

- **捕获时机**：所有原生函数和方法都要在 document-start（页面脚本之前）捕获，用 uncurryThis 的方式固定下来（`const call = Function.prototype.call; const uncurry = Function.prototype.bind.bind(call)`）。`Function.prototype.call/apply/bind` 本身也会被 hook，所以只能在初始化时用一次。
- **严格模式**：所有初始化代码都用 `"use strict"`。非严格函数被站点的 hook 调用时，hook 可以沿 `fn.caller` 拿到我们的函数，再读它的 `.arguments`。目前 `bootstrap.js`、`core.js`、`ipc-protocol.js` 都不是严格模式。
- **CEF 分支**：headers 用对象字面量直接传给已捕获的 `fetch`，不经过 `Headers` 实例；失败时直接报错，不降级到 postMessage。
- **Android 分支**：在 document-start 捕获 `ipc` 对象和它的 `postMessage`，再删掉 `window.ipc`；序列化只用已捕获的 `JSON.stringify`。
- **已完成标记的检查**：只用语法级操作（`'<marker>' in window`、`typeof`），不调用任何函数。

## 4. 抹除方式与约束

### 4.1 实施层

隔离模式的开关做成 webview 属性：由 Rust 建窗时设置，经 `third-patches/tauri` 的 `WebviewAttributes` 传入。`manager/webview.rs` 在组装 `all_initialization_scripts` 时按这个开关切换脚本。所以 CEF 和 wry（Android）拿到的是同一份脚本，运行时层不用改：
- CEF 垫片定义的 `window.ipc` 是可配置的，由共享脚本捕获后删除；
- `subprocess.rs` 的逐个 `context.eval` 保持不变。

### 4.2 两种做法

- **大闭包**：在 Tauri 组装层把隔离 webview 的全部脚本拼成一个，并把 Tauri 脚本改成引用闭包内的局部变量。代价是：
  - 任何一处语法错误都会连 IPC 一起挂掉；
  - 各脚本顶层的 `const` / `function` 会重名，需要再套一层作用域，脚本自带的 `"use strict"` 也会因此失效。
- **初始化时捕获，最后统一删除**（倾向这个）：
  1. 全局在定义时设为 `configurable: true`；
  2. 每个脚本在初始化时 `const internals = window.__TAURI_INTERNALS__`，之后只用这个局部引用；
  3. 我们脚本之间用一个同样可配置的私有登记对象互传引用；
  4. 最后一个脚本统一 `delete`，并定义一个不可删的「已完成」标记。

  所有脚本开头都检查这个标记，有就直接返回（见 §4.4）。

两种做法都需要把下面这些「调用时才查全局」的地方改成初始化时捕获（`third-patches/tauri`）：

| 位置 | 调用时查找的东西 |
| --- | --- |
| `scripts/core.js:72/94/102` | `window.__TAURI_INTERNALS__.ipc` |
| `scripts/ipc.js:147` | `window.__TAURI_INTERNALS__.postMessage` |
| `scripts/ipc-protocol.js:37/57/84` | `convertFileSrc`、`runCallback`、`window.ipc` |
| `window/scripts/drag.js:104/123` | `invoke` |
| `webview/scripts/zoom-hotkey.js`、`toggle-devtools.js`（debug）、`print.js`（macOS） | `invoke` |
| `manager/webview.rs:170/175`、`event/init.js:6`、`path/init.js:5` | 定义时不可配置，需要改成可配置，或在隔离模式下不注入 |

### 4.3 只对远程页面窗口生效

主窗口的 `@tauri-apps/api` 依赖 `window.__TAURI_INTERNALS__`，必须保留。隔离模式先用于 `crawler-*`，`surf-*` 随后。

### 4.4 Android 特有约束

1. **回包**：每次 invoke 的回包都是 eval 全局 `runCallback`（P1），所以必须先有 §2 的受保护入口，才能删除全局。
2. **二次执行会把全局重建回来**：wry 生成的 `RustWebViewClient.onPageStarted` 会用 `evaluateJavascript` 把全部初始化脚本再跑一遍（见 `cocs/surf/ANDROID_SURF.md:62`）。这时页面脚本已经运行，原生方法可能已经被 hook。
   - 全局删除后，`manager/webview.rs:174` 的 `if (!window.__TAURI_INTERNALS__)` 会重新建出一个全局，后面的 Tauri 脚本再用被 hook 的原生方法把 IPC 装回去，而 key 仍然在模板里。
   - 我们自己的 `android_init_script` 守卫用的是 `Object.prototype.hasOwnProperty.call`（K2），第二次执行时可以被页面绕过。Tauri 自己的脚本则完全没有守卫。
   - 处理方式二选一：所有隔离脚本开头都用语法级检查「已完成」标记后直接返回；或者给 wry 打补丁，对隔离 webview 去掉二次执行（`RustWebViewClient.kt` 每次构建都会重新生成，只能改模板来源）。
3. **document-start 注入不可用**：如果设备的 WebView 不支持 document-start 注入，第一次执行就是 `onPageStarted` 那次，捕获到的可能已经是被 hook 的原生方法。隔离模式在这种设备上应该拒绝运行（fail closed），不能降级运行。需要真机确认 wry 在不支持时的行为。
4. **iframe**：wry 在 Android 上用 `addDocumentStartJavaScript(…, setOf("*"))` 把脚本注入所有 frame。Tauri 自己的脚本不经过 `android_init_script` 的顶层守卫，所以 iframe 里也会有完整的 `__TAURI_INTERNALS__`（需要真机确认）。
   - 站点只要建一个同源 iframe，在 iframe 里 hook `JSON.stringify` 再调一次 invoke，就能拿到 key（H6）。
   - `ipc` 监听只接收主框架的消息（`ContentWebView.kt:34`），但 key 拿到后可以在主框架里配合 G5 使用。
   - 所以隔离模式下，Tauri 脚本也必须只在主框架运行。
5. **`window.ipc` 能否删除**：WebMessageListener 注入的对象能否 `delete`，需要真机确认。如果删不掉，就要在 document-start 定义一个不可配置的同名属性把它遮住。

## 5. 畅游窗口（同类问题）

注入机制相同（`commands/surf_common.rs`），而且站点由用户自由浏览，暴露面更大。可调用的命令见 `permissions/surf.toml`，包括导入媒体、导航和 VFS 写入。

- 需要抹除的全局：G1、G4、G5、G6、G7、G8、G9、G10，加上 `surf_bootstrap.js` 的 `__kb_media_submit__`（`:6`）、`__kb_native_download_finished__`（`:61`）、`__kabegame_surf_triggerDownload`（`:126`），`surf_toast.js:6` 的 `__kabegame_toast`，以及 `surf_url_report.js:6` 的标记 `__kb_url_report__`。
- Rust 推送入口：`surf_common.rs:148`（`__kabegame_toast`）、`surf_android.rs:412`（`__kb_media_download__`）、`surf_collect.js` 的 Channel（P1）。

## 6. 不在本次范围

- **探测**：抹除全局之后，站点仍然能通过以下方式探测到爬虫环境：
  - drag.js 在 document 上监听 `mousedown`：给带 `data-tauri-drag-region` 的元素派发合成事件，会发现 `defaultPrevented` 变为 `true`；
  - 被改写的原生方法（`URL.createObjectURL`、`MediaSource.prototype.addSourceBuffer` 等）`toString()` 不再是 `[native code]`；
  - WebView / CEF 浏览器指纹。

  这些只暴露「在爬虫里」，不提供任何能力。
- **插件 `crawl.js` 与页面 DOM 的交互**：插件本来就要读写站点的 DOM。插件把配置值（例如 token）传给页面原生 API 时，站点可以看到。
- **`crawl_*` 命令自身的参数校验**（例如 input 挂载要不要对页面可读）：抹除全局之后，只有插件能调这些命令，另行评估。
